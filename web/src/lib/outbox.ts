"use client";

// Durable mutation outbox (local-first Phase 0 — docs/local-first-roadmap.md).
//
// The in-memory pending/retry queues in store.ts stay the source of truth for
// live behavior; this module mirrors them into a per-user IndexedDB store via
// the EdgeBase `DurableOutbox` primitive so queued-but-unsent mutations survive
// tab close, crash, and reload. On boot, entries left behind by dead tabs are
// claimed (Web Locks liveness) and replayed through the store's flush paths.
//
// Every call here is fail-open: without IndexedDB (jsdom, SSR, storage-denied
// browsers) or with the kill switch set, mirroring silently no-ops and the app
// behaves exactly as before this layer existed.

import {
  DurableOutbox,
  createIndexedDbOutboxAdapter,
  createSecretBox,
  encryptOutboxAdapter,
  type DurableOutboxAdapter,
  type DurableOutboxEntry,
} from "@edge-base/web";

import { awaitLocalBox, localBoxIfSettled, onLocalEncryptionModeChange } from "./localLock";
import { recordCacheClear } from "./recordCache";
import type { Block, Page } from "./types";

export type OutboxOp =
  | {
      /** Server stamp when the patch was first queued — replay's 409 conflict guard. */
      expectedUpdatedAt?: string;
      hintPageId?: string;
      id: string;
      kind: "block_update";
      patch: Partial<Block>;
    }
  | { block: Block; kind: "block_create" }
  | { hintPageId?: string; ids: string[]; kind: "block_delete" }
  | { id: string; kind: "page_update"; patch: Partial<Page>; target: "database_row" | "page" }
  // Generic one-shot mutation captured as (whitelisted fn name, args). Used for
  // every optimistic-before-network flow that is not a debounced queue:
  // page/row/property/view/template/comment creates+deletes, trash/restore,
  // moves, and the undo/redo block batch paths. Replay resolves `fn` against
  // the store's DURABLE_REMOTE_CALLS registry.
  | { args: unknown[]; fn: string; kind: "remote_call" };

export type OutboxEntry = DurableOutboxEntry<OutboxOp>;

// Escape hatch: localStorage.setItem("notionlike.outbox.disabled", "1") turns
// the durable layer off without a build (docs/local-first-roadmap.md §6.10).
const DISABLE_KEY = "notionlike.outbox.disabled";
// At-rest sealing kill switch (shared with the record cache).
const ENCRYPTION_DISABLE_KEY = "notionlike.encryption.disabled";

let current: { promise: Promise<DurableOutbox<OutboxOp> | null>; userId: string } | null = null;
// FIFO chain so mirror writes/acks hit IndexedDB in call order (an ack issued
// after a newer set must not delete the newer mirror).
let chain: Promise<void> = Promise.resolve();
let warnedOnce = false;

// Structural subset of `navigator.locks` (mirrors the shape the @edge-base/web
// DurableOutbox already feature-detects) so this stays testable and degrades
// where the API is missing.
interface OutboxLockManager {
  request(
    name: string,
    options: { ifAvailable?: boolean; mode?: "exclusive" | "shared" },
    callback: () => Promise<unknown>
  ): Promise<unknown>;
}

function resolveLocks(): OutboxLockManager | null {
  try {
    const candidate = (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks;
    return candidate && typeof (candidate as OutboxLockManager).request === "function"
      ? (candidate as OutboxLockManager)
      : null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` inside the per-user cross-tab outbox critical section. Every durable
 * mutation (set/ack/clear) AND the mode-switch re-key (outboxRekey) share this
 * one named exclusive lock, so a write issued in the instant another tab is
 * re-sealing entries under a new key can no longer interleave with it (which
 * would strand the write under the now-stale key). Without the Web Locks API
 * (SSR, jsdom, older browsers) it runs `fn` inline — the pre-existing in-tab
 * FIFO `chain` ordering still applies, exactly as before this lock existed.
 *
 * The lock name is the bare `notionlike-outbox:<userId>`, distinct from the
 * SDK's own `::tab::` / `::sweep` liveness locks, so the two never contend.
 */
function withOutboxLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const locks = resolveLocks();
  if (!locks) return fn();
  return locks.request(`notionlike-outbox:${userId}`, { mode: "exclusive" }, fn) as Promise<T>;
}

// Another tab flipped the encryption mode: our cached outbox is bound to the
// now-stale key. Drop it so the next access rebuilds under the current mode's
// box (localLock has already resolved any pending gate so this doesn't wedge).
onLocalEncryptionModeChange(() => {
  current = null;
});

function warn(error: unknown) {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn("Durable outbox unavailable; falling back to in-memory queues only.", error);
}

function flagSet(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function getOutbox(userId: string): Promise<DurableOutbox<OutboxOp> | null> {
  if (!userId || flagSet(DISABLE_KEY)) return Promise.resolve(null);
  if (current?.userId === userId) return current.promise;
  const promise = (async () => {
    try {
      // Passphrase mode: wait for unlock; a skipped session gets NO durable
      // layer (null) so locked data is neither read nor written.
      const gate = await awaitLocalBox(userId);
      if (gate === null) return null;
      const name = `notionlike-outbox:${userId}`;
      const raw = createIndexedDbOutboxAdapter<unknown>(name);
      if (!raw) return null;
      // Values are sealed at rest (see crypto-box threat model); keys/ids stay
      // plaintext for indexing. Pre-encryption entries read through unchanged.
      const box =
        gate === "device"
          ? flagSet(ENCRYPTION_DISABLE_KEY)
            ? null
            : await createSecretBox(name)
          : gate;
      const adapter = box
        ? encryptOutboxAdapter<OutboxOp>(raw, box)
        : (raw as DurableOutboxAdapter<OutboxOp>);
      const outbox = new DurableOutbox<OutboxOp>({ adapter, name });
      outbox.holdTab();
      return outbox;
    } catch (error) {
      warn(error);
      return null;
    }
  })();
  current = { promise, userId };
  return promise;
}

function isQuotaError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "QuotaExceededError"
  );
}

function enqueue(task: (outbox: DurableOutbox<OutboxOp>) => Promise<void>, userId: string) {
  chain = chain
    .then(async () => {
      const outbox = await getOutbox(userId);
      if (!outbox) return;
      try {
        await task(outbox);
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        // Storage full: unlike the record cache, outbox entries are queued
        // WRITES — dropping them silently loses crash-durability. Free space
        // by clearing the (disposable) record cache and retry once.
        await recordCacheClear(userId).catch(() => {});
        await task(outbox);
      }
    })
    .catch(warn);
}

/** Durably mirror (upsert) one queued mutation. Fire-and-forget, ordered. */
export function outboxSet(userId: string, entryKey: string, op: OutboxOp) {
  enqueue((outbox) => withOutboxLock(userId, () => outbox.set(entryKey, op)), userId);
}

/** Remove a mirrored mutation once it is acked or terminally dropped. */
export function outboxAck(userId: string, entryKey: string) {
  enqueue((outbox) => withOutboxLock(userId, () => outbox.ack(entryKey)), userId);
}

/**
 * Claim entries abandoned by dead tabs (crash/close before flush), reassigned
 * durably to this tab, ordered by original enqueue seq.
 */
export async function outboxClaimAbandoned(userId: string): Promise<OutboxEntry[]> {
  // Undecided lock gate: claim nothing now; the unlock handler replays later.
  if (localBoxIfSettled(userId) === "pending") return [];
  const outbox = await getOutbox(userId);
  if (!outbox) return [];
  try {
    await chain;
    return await outbox.claimAbandoned();
  } catch (error) {
    warn(error);
    return [];
  }
}

/**
 * Read-only view of every queued mutation (any tab), in enqueue order — used
 * to overlay still-unsent edits onto cached records so offline reads reflect
 * offline writes. Never claims or mutates entries.
 */
export async function outboxAllEntries(userId: string): Promise<OutboxEntry[]> {
  // Undecided lock gate: report empty instead of blocking (see recordCache).
  if (localBoxIfSettled(userId) === "pending") return [];
  const outbox = await getOutbox(userId);
  if (!outbox) return [];
  try {
    await chain;
    return await outbox.allEntries();
  } catch (error) {
    warn(error);
    return [];
  }
}

/** Wipe the current user's outbox (logout / reset-local-data escape hatch). */
export async function outboxClear(userId: string) {
  const outbox = await getOutbox(userId);
  if (!outbox) return;
  try {
    await chain;
    await withOutboxLock(userId, () => outbox.clear());
  } catch (error) {
    warn(error);
  }
}

/**
 * Atomically re-seal the durable outbox under a new key/mode. The whole
 * critical section — snapshot under the old box, the caller's `rekey` (which
 * flips the mode/gate and drops the cached adapter), then the re-seal under the
 * freshly-rebuilt adapter — runs under the SAME cross-tab lock as every mirror
 * write. That closes the residual race: a set/ack from any tab either lands
 * (and is captured in the snapshot) before the re-key, or waits until after it
 * completes and writes under the new key. `rekey` must NOT call the lock-taking
 * outboxSet/outboxAck/outboxClear (it would deadlock on the held lock); it does
 * mode/gate/cache work only. Falls back to an inline run without Web Locks.
 */
export async function outboxRekey(userId: string, rekey: () => Promise<void>): Promise<void> {
  // Let in-tab pending mirror writes settle before entering the critical
  // section so the snapshot below reflects them.
  await chain;
  await withOutboxLock(userId, async () => {
    let stragglers: OutboxEntry[] = [];
    try {
      const before = await getOutbox(userId);
      stragglers = before ? await before.allEntries() : [];
    } catch (error) {
      warn(error);
    }
    await rekey();
    try {
      const after = await getOutbox(userId);
      if (after) {
        await after.clear();
        for (const entry of stragglers) await after.set(entry.entryKey, entry.value);
      }
    } catch (error) {
      warn(error);
    }
  });
}

/** Test hook: drop the cached outbox so a fresh adapter/tab is created. */
export function resetOutboxForTests() {
  current = null;
  chain = Promise.resolve();
  warnedOnce = false;
}

/** Await all queued mirror writes — test hook for deterministic assertions. */
export async function outboxIdleForTests() {
  await chain;
}
