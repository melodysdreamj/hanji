export const PAGE_TEXT_UPDATE_COLLECTION_MS = 90;
export const PAGE_TEXT_UPDATE_DRAIN_CHUNK_SIZE = 8;
export const PAGE_TEXT_UPDATE_MAX_PENDING_BLOCKS = 200;

type PageTextUpdateBatchable = {
  blockId: string;
  operation?: unknown;
};

type PageTextUpdateBatcherOptions<T extends PageTextUpdateBatchable> = {
  afterSend?: (change: T) => Promise<void> | void;
  isConnected: () => boolean;
  send: (change: T) => Promise<void>;
};

type PendingPageTextUpdate<T> = {
  change: T;
  readyAt: number;
};

/**
 * Coalesce one page's advisory text snapshots without delaying the structure
 * lane that carries committed canonical invalidations.
 *
 * The collection window starts at the first update and is never extended by
 * later keystrokes. Updates for one block collapse to the latest full
 * snapshot; once two snapshots merge, the incremental operation is removed
 * because its before-state may not have reached the peer. Pending block keys
 * are bounded, and a ready queue drains sequentially in bounded chunks with
 * no additional collection delay between chunks. A failed text signal is
 * isolated and never retried: the durable block snapshot remains canonical.
 * Any failed or capacity-evicted predecessor switches this page generation to
 * operation-free full snapshots for the rest of the batcher's lifetime. That
 * conservative O(1) state cannot forget a block unsafely or grow with distinct
 * failures, while access/auth/disconnect failures cannot create a hot loop.
 */
export function createPageTextUpdateBatcher<T extends PageTextUpdateBatchable>({
  afterSend,
  isConnected,
  send,
}: PageTextUpdateBatcherOptions<T>) {
  let pending = new Map<string, PendingPageTextUpdate<T>>();
  const uncertainBlocks = new Set<string>();
  let pageGenerationRequiresFullSnapshots = false;
  let collectionTimer: number | undefined;
  let collectionDueAt: number | undefined;
  let active: Promise<void> | undefined;
  let flushRequestedWhileActive = false;
  let accepting = true;

  function clearCollectionTimer() {
    if (collectionTimer === undefined) return;
    window.clearTimeout(collectionTimer);
    collectionTimer = undefined;
    collectionDueAt = undefined;
  }

  function withoutOperation(change: T): T {
    if (change.operation === undefined) return change;
    return {
      ...change,
      operation: undefined,
    };
  }

  function requireFullSnapshotsForPageGeneration() {
    pageGenerationRequiresFullSnapshots = true;
  }

  function scheduleCollection() {
    if (!accepting || pending.size === 0) return;
    const dueAt = Math.min(...Array.from(pending.values(), (entry) => entry.readyAt));
    if (
      collectionTimer !== undefined &&
      collectionDueAt !== undefined &&
      collectionDueAt <= dueAt
    ) {
      return;
    }
    clearCollectionTimer();
    collectionDueAt = dueAt;
    collectionTimer = window.setTimeout(() => {
      collectionTimer = undefined;
      collectionDueAt = undefined;
      void flush();
    }, Math.max(0, dueAt - Date.now()));
  }

  function takeNextReady(now: number) {
    for (const [blockId, entry] of pending) {
      if (entry.readyAt > now) continue;
      pending.delete(blockId);
      uncertainBlocks.add(blockId);
      return pageGenerationRequiresFullSnapshots
        ? {
            ...entry,
            change: withoutOperation(entry.change),
          }
        : entry;
    }
    return undefined;
  }

  function prependUnsent(entry: PendingPageTextUpdate<T>) {
    const next = new Map<string, PendingPageTextUpdate<T>>();
    uncertainBlocks.delete(entry.change.blockId);
    if (!pending.has(entry.change.blockId)) next.set(entry.change.blockId, entry);
    for (const entry of pending) next.set(...entry);
    while (next.size > PAGE_TEXT_UPDATE_MAX_PENDING_BLOCKS) {
      const oldestBlockId = next.keys().next().value;
      if (typeof oldestBlockId !== "string") break;
      next.delete(oldestBlockId);
      requireFullSnapshotsForPageGeneration();
    }
    pending = next;
  }

  function enqueue(change: T) {
    if (!accepting) return;
    const blockId = change.blockId.trim();
    if (!blockId) return;
    const previous = pending.get(blockId);
    if (previous) {
      pending.set(blockId, {
        change: {
          ...change,
          blockId,
          operation: undefined,
        },
        readyAt: previous.readyAt,
      });
      return;
    }

    if (pending.size >= PAGE_TEXT_UPDATE_MAX_PENDING_BLOCKS && isConnected()) {
      clearCollectionTimer();
      void flush();
    }
    if (pending.size >= PAGE_TEXT_UPDATE_MAX_PENDING_BLOCKS) {
      // Signals are advisory; under pathological disconnected fanout retain
      // the newest bounded snapshots and let durable canonical state own any
      // evicted older key.
      const oldestBlockId = pending.keys().next().value;
      if (typeof oldestBlockId === "string") {
        pending.delete(oldestBlockId);
        requireFullSnapshotsForPageGeneration();
      }
    }
    pending.set(blockId, {
      change: {
        ...change,
        blockId,
        ...(uncertainBlocks.has(blockId) || pageGenerationRequiresFullSnapshots
          ? { operation: undefined }
          : {}),
      },
      readyAt: Date.now() + PAGE_TEXT_UPDATE_COLLECTION_MS,
    });
    scheduleCollection();
  }

  function flush(): Promise<void> {
    if (active) {
      flushRequestedWhileActive = true;
      return active;
    }
    if (!accepting || !isConnected() || pending.size === 0) return Promise.resolve();
    const firstEntry = takeNextReady(Date.now());
    if (!firstEntry) {
      scheduleCollection();
      return Promise.resolve();
    }
    clearCollectionTimer();

    let stoppedForDisconnect = false;
    const generation = (async () => {
      let entry: PendingPageTextUpdate<T> | undefined = firstEntry;
      let sentInChunk = 0;
      while (accepting && entry) {
        const blockId = entry.change.blockId;
        if (!isConnected()) {
          stoppedForDisconnect = true;
          prependUnsent(entry);
          return;
        }
        try {
          await send(entry.change);
          try {
            await afterSend?.(entry.change);
          } catch {
            // The advisory text signal already reached the room. Its optional
            // CRDT companion has an independent failure lane and must not make
            // a later text operation pretend that this predecessor was lost.
          }
        } catch {
          // Text signals are advisory snapshots. Failure isolation is safer
          // than retrying an access/auth/rate-limit denial on this lane. Any
          // later accepted update in this page generation must remain a
          // full snapshot. A single boolean preserves that rule for unbounded
          // distinct block failures without retaining their IDs.
          requireFullSnapshotsForPageGeneration();
        } finally {
          uncertainBlocks.delete(blockId);
        }
        sentInChunk += 1;
        if (sentInChunk === PAGE_TEXT_UPDATE_DRAIN_CHUNK_SIZE) {
          sentInChunk = 0;
          await Promise.resolve();
        }
        if (!accepting) return;
        if (!isConnected()) {
          stoppedForDisconnect = true;
          return;
        }
        entry = takeNextReady(Date.now());
      }
    })();

    const settled = generation.finally(() => {
      if (active !== settled) return;
      active = undefined;
      const shouldHandoffRequestedFlush = flushRequestedWhileActive;
      flushRequestedWhileActive = false;
      if (!accepting || pending.size === 0) return;
      if (shouldHandoffRequestedFlush) {
        return flush();
      }
      if (stoppedForDisconnect) return;
      scheduleCollection();
    });
    active = settled;
    return settled;
  }

  function dispose(): Promise<void> {
    accepting = false;
    flushRequestedWhileActive = false;
    clearCollectionTimer();
    pending.clear();
    return active ?? Promise.resolve();
  }

  return {
    dispose,
    enqueue,
    flush,
    // Test/diagnostic cardinality for the retained full-snapshot safety mode.
    fullSnapshotSafetyStateCount: () => Number(pageGenerationRequiresFullSnapshots),
    pendingCount: () => pending.size,
    // Test/diagnostic cardinality for selected entries awaiting settlement.
    uncertainBlockCount: () => uncertainBlocks.size,
  };
}
