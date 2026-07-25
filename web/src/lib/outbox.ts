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
import {
  clearLegacyOutboxStorage,
  LEGACY_OUTBOX_EARLY_META_KEYS,
  legacyIndexedDbMigrationCanContinue,
  legacyOutboxDatabaseName,
  migrateLegacyIndexedDbProvenance,
} from "./legacyNamespace";
import { recordCacheClear } from "./recordCache";
import type { Block, DbProperty, DbTemplate, DbView, Page } from "./types";

export interface DatabaseCreateEffect {
  databaseId: string;
  kind: "database_create";
  originHref: string;
  page: Page;
  properties: DbProperty[];
  rows: Page[];
  templates: DbTemplate[];
  views: DbView[];
}

/**
 * Persisted terminal-drop reconciliation for optimistic database metadata.
 * The database id is sufficient: replay uses the canonical metadata-only
 * loader, whose existing per-database in-flight key coalesces concurrent
 * drops without pulling row data into this freshness lane.
 */
export interface DatabaseMetadataReconciliationEffect {
  databaseId: string;
  kind: "database_metadata_reconcile";
}

export interface DatabaseRowsReconciliationEffect {
  databaseId: string;
  kind: "database_rows_reconcile";
  mutationId: string;
  rowId: string;
  targetParentId: string;
}

export interface DatabaseDependencyCommitEffect {
  addRelatedRowIds: string[];
  databaseId: string;
  direction: "predecessors" | "successors";
  kind: "database_dependency_commit";
  mutationId: string;
  propertyId: string;
  removeRelatedRowIds: string[];
  rowId: string;
}

/**
 * Complete response authority for one database task-feature command. The
 * generated relation ids and dependency settings are persisted with the
 * durable call so replay can validate the server response without a second
 * metadata read.
 */
export interface DatabaseTaskFeatureCommitEffect {
  avoidWeekends?: boolean;
  databaseId: string;
  dateMode?: "range" | "separate";
  datePropertyId?: string;
  endDatePropertyId?: string;
  feature: "dependencies" | "subitems";
  kind: "database_task_feature_commit";
  nestedPropertyId?: string;
  primaryPropertyId: string;
  secondaryPropertyId: string;
  showToggleOnTitle?: boolean;
  shiftMode?: "overlap" | "maintain_spacing" | "none";
  startDatePropertyId?: string;
}

/**
 * Complete request identity for disabling one active task-feature binding.
 * The revision and property pair travel with the durable operation so every
 * retry can be validated against the same backend receipt.
 */
export interface DatabaseTaskFeatureTurnOffEffect {
  databaseId: string;
  expectedBindingRevision: number;
  expectedDatabaseFeaturesRevision: number;
  feature: "dependencies" | "subitems";
  kind: "database_task_feature_turn_off";
  operationId: string;
  primaryPropertyId: string;
  propertyDisposition: "keep" | "remove";
  secondaryPropertyId: string;
}

export interface RowFileRemovalEffect {
  cacheKey?: string;
  databaseId: string;
  kind: "row_file_remove";
  nextValue: unknown;
  previousValue: unknown;
  propertyId: string;
  removedIndex: number;
  removedItem: unknown;
  rowId: string;
}

/**
 * Small advisory effect retained with a durable structural mutation.
 * Canonical blocks remain the only durable state; these ids only tell the
 * exact affected page rooms to reload after commit/replay confirmation.
 */
export interface BlockStructureInvalidation {
  blockIds?: string[];
  /**
   * Opaque, bounded markers for restoring an undo/redo entry when an initially
   * queued structure write later drops. One marker is retained per affected
   * page; block content and user-authored payloads are deliberately excluded.
   */
  dropReconciliation?: {
    direction: "undo" | "redo";
    histories: Array<{
      at: number;
      linkId?: string;
      operationOccurredAt: string;
      pageId: string;
    }>;
  };
  pageIds: string[];
}

/**
 * Bounded authority identities retained for a terminal remote-call drop.
 * The mutation payload remains the source of optimistic intent; these ids
 * only select the existing canonical loaders after the outbox entry is acked.
 */
export interface RemoteCallTerminalReconciliation {
  commentPageIds?: string[];
  databaseMetadataIds?: string[];
  databaseRowIds?: string[];
  pageIds?: string[];
}

export type RemoteCallEffect =
  | DatabaseCreateEffect
  | DatabaseDependencyCommitEffect
  | DatabaseMetadataReconciliationEffect
  | DatabaseRowsReconciliationEffect
  | DatabaseTaskFeatureCommitEffect
  | DatabaseTaskFeatureTurnOffEffect
  | RowFileRemovalEffect;

export interface PageRecencyOutboxOp {
  blockId: string;
  blockUpdatedAt: string;
  /** Fixed first-generation deadline in epoch milliseconds. */
  dueAt: number;
  kind: "page_recency";
  mutationId: string;
  pageId: string;
}

export type MutationOutboxOp =
  | {
      /** Server stamp when the patch generation began — replay's 409 conflict guard. */
      expectedUpdatedAt?: string;
      /** Mutation that this generation was based on while its response was still in flight. */
      expectedMutationId?: string;
      hintPageId?: string;
      id: string;
      kind: "block_update";
      /** Stable id for this coalesced generation; lets the server dedupe a lost response. */
      mutationId?: string;
      patch: Partial<Block>;
    }
  | { block: Block; kind: "block_create"; touchPage?: boolean }
  | { hintPageId?: string; ids: string[]; kind: "block_delete" }
  | {
      /** Server stamp read before this durable generation was admitted. */
      expectedUpdatedAt?: string;
      /** Same-actor predecessor receipt accepted as the alternate causal base. */
      expectedMutationId?: string;
      id: string;
      kind: "page_update";
      /** Stable receipt for exact lost-response replay. */
      mutationId?: string;
      patch: Partial<Page>;
      target: "database_row" | "page";
    }
  | PageRecencyOutboxOp
  // Generic one-shot mutation captured as (whitelisted fn name, args). Used for
  // every optimistic-before-network flow that is not a debounced queue:
  // page/row/property/view/template/comment creates+deletes, trash/restore,
  // moves, and the undo/redo block batch paths. Replay resolves `fn` against
  // the store's DURABLE_REMOTE_CALLS registry.
  | {
      args: unknown[];
      blockStructureInvalidation?: BlockStructureInvalidation;
      effect?: RemoteCallEffect;
      fn: string;
      kind: "remote_call";
      terminalReconciliation?: RemoteCallTerminalReconciliation;
    };

/**
 * A terminal response ends mutation delivery, but it does not prove that the
 * optimistic browser/cache state is settled. Replace the mutation in-place
 * with this reconciliation-only marker before disabling retries. A later tab
 * can then finish canonical reconciliation without ever resending the
 * mutation whose terminal outcome is already known.
 */
export interface TerminalReconciliationOutboxOp {
  disposition: "drop" | "silent_drop";
  kind: "terminal_reconciliation";
  operation: MutationOutboxOp;
  status?: number;
}

export type OutboxOp = MutationOutboxOp | TerminalReconciliationOutboxOp;

export type OutboxEntry = DurableOutboxEntry<OutboxOp>;

// Escape hatch: localStorage.setItem("hanji.outbox.disabled", "1") turns
// the durable layer off without a build (docs/local-first-roadmap.md §6.10).
const DISABLE_KEY = "hanji.outbox.disabled";
// At-rest sealing kill switch (shared with the record cache).
const ENCRYPTION_DISABLE_KEY = "hanji.encryption.disabled";
// Anonymous cross-tab invalidation only. The durable outbox remains the
// authority; this marker carries no user id, entry key, or mutation payload.
const OUTBOX_CHANGE_SIGNAL_KEY = "hanji.outbox.changed";
const OUTBOX_CHANGE_COLLECTION_MS = 25;

let current: { promise: Promise<DurableOutbox<OutboxOp> | null>; userId: string } | null = null;
// FIFO chain so mirror writes/acks hit IndexedDB in call order (an ack issued
// after a newer set must not delete the newer mirror).
let chain: Promise<void> = Promise.resolve();
let warnedOnce = false;

type OutboxPendingListener = (userId: string, pendingHint: number) => void;
type OutboxChangeListener = () => void;
const pendingHintKeys = new Map<string, Map<string, number>>();
const pendingListeners = new Set<OutboxPendingListener>();
const outboxChangeListeners = new Set<OutboxChangeListener>();
let pendingHintVersion = 0;
let outboxChangeSignalVersion = 0;
let outboxChangeSignalTimer: ReturnType<typeof setTimeout> | undefined;
let outboxChangeStorageListenerInstalled = false;

function emitPendingHint(userId: string) {
  const pendingHint = pendingHintKeys.get(userId)?.size ?? 0;
  for (const listener of pendingListeners) listener(userId, pendingHint);
}

function markPendingHint(
  userId: string,
  entryKey: string,
  pending: boolean,
  expectedVersion?: number
) {
  if (!userId) return undefined;
  const keys = pendingHintKeys.get(userId) ?? new Map<string, number>();
  if (pending) {
    pendingHintVersion += 1;
    keys.set(entryKey, pendingHintVersion);
  } else if (expectedVersion === undefined || keys.get(entryKey) === expectedVersion) {
    keys.delete(entryKey);
  }
  if (keys.size) pendingHintKeys.set(userId, keys);
  else pendingHintKeys.delete(userId);
  emitPendingHint(userId);
  return pending ? pendingHintVersion : undefined;
}

/**
 * Immediate in-tab signal for the sync badge. IndexedDB remains authoritative;
 * this hint closes the gap where a set and its later ack can both finish
 * between the badge's polling intervals and the user never sees that a server
 * confirmation is still outstanding.
 */
export function subscribeOutboxPending(listener: OutboxPendingListener) {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

function ensureOutboxChangeStorageListener() {
  if (outboxChangeStorageListenerInstalled || typeof window === "undefined") return;
  outboxChangeStorageListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== OUTBOX_CHANGE_SIGNAL_KEY) return;
    for (const listener of outboxChangeListeners) listener();
  });
}

/**
 * Cross-tab durable-state invalidation for read-only observers such as the
 * sync badge. Same-tab callers already receive the exact pending-hint signal;
 * another tab receives this only after the durable mutation settles and then
 * reads its own current user's authoritative outbox.
 */
export function subscribeOutboxChanges(listener: OutboxChangeListener) {
  ensureOutboxChangeStorageListener();
  outboxChangeListeners.add(listener);
  return () => outboxChangeListeners.delete(listener);
}

function scheduleOutboxChangeSignal() {
  if (typeof window === "undefined" || outboxChangeSignalTimer) return;
  outboxChangeSignalTimer = setTimeout(() => {
    outboxChangeSignalTimer = undefined;
    outboxChangeSignalVersion += 1;
    try {
      const nonce = typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `${Date.now()}:${Math.random()}`;
      window.localStorage.setItem(
        OUTBOX_CHANGE_SIGNAL_KEY,
        `${nonce}:${outboxChangeSignalVersion}`,
      );
    } catch {
      // Same-tab hints and the visible-tab reconciliation boundary remain
      // available when localStorage is blocked or full.
    }
  }, OUTBOX_CHANGE_COLLECTION_MS);
}

export function outboxPendingHintCount(userId: string) {
  return pendingHintKeys.get(userId)?.size ?? 0;
}

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
 * Ordinary mutations use the bare `hanji-outbox:<userId>` name, distinct from
 * the SDK's liveness locks. Namespace migration and final privacy cleanup also
 * take `::sweep`, after the bare lock, when they must serialize re-key claims.
 */
function withOutboxLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const locks = resolveLocks();
  if (!locks) return fn();
  return locks.request(`hanji-outbox:${userId}`, { mode: "exclusive" }, fn) as Promise<T>;
}

function withOutboxSweepLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const locks = resolveLocks();
  if (!locks) return fn();
  return locks.request(`hanji-outbox:${userId}::sweep`, { mode: "exclusive" }, fn) as Promise<T>;
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

function getOutbox(
  userId: string,
  migrationLockAlreadyHeld = false
): Promise<DurableOutbox<OutboxOp> | null> {
  if (!userId || flagSet(DISABLE_KEY)) return Promise.resolve(null);
  if (current?.userId === userId) return current.promise;
  const promise = (async () => {
    try {
      // Passphrase mode: wait for unlock; a skipped session gets NO durable
      // layer (null) so locked data is neither read nor written.
      const gate = await awaitLocalBox(userId);
      if (gate === null) return null;
      const name = `hanji-outbox:${userId}`;
      const legacyName = legacyOutboxDatabaseName(userId);
      if (gate === "device") {
        await migrateLegacyIndexedDbProvenance(
          { legacyName: `${legacyName}::keys`, canonicalName: `${name}::keys` },
          [
            {
              legacyName,
              canonicalName: name,
              consumeStores: ["entries"],
              earlyMetaKeys: LEGACY_OUTBOX_EARLY_META_KEYS,
              respectLegacyOutboxLiveness: true,
            },
          ],
          undefined,
          { exclusiveLockAlreadyHeld: migrationLockAlreadyHeld, exclusiveLockName: name }
        ).catch((error) => {
          if (!legacyIndexedDbMigrationCanContinue(error)) throw error;
          warn(error);
        });
      }
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

function enqueue(
  task: (outbox: DurableOutbox<OutboxOp>) => Promise<void>,
  userId: string
): Promise<boolean> {
  const run = chain.then(async () => {
      const outbox = await getOutbox(userId);
      if (!outbox) return true;
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
      return true;
    });
  const observed = run.catch((error) => {
    warn(error);
    return false;
  });
  chain = observed.then(() => undefined);
  return observed;
}

/** Durably mirror (upsert) one queued mutation, ordered with earlier writes. */
export function outboxSet(
  userId: string,
  entryKey: string,
  op: OutboxOp
): Promise<void> {
  markPendingHint(userId, entryKey, true);
  return enqueue(
    (outbox) => withOutboxLock(userId, () => outbox.set(entryKey, op)),
    userId
  ).then((persisted) => {
    if (persisted) scheduleOutboxChangeSignal();
  });
}

/** Remove a mirrored mutation once it is acked or terminally dropped. */
export function outboxAck(userId: string, entryKey: string): Promise<void> {
  const expectedVersion = pendingHintKeys.get(userId)?.get(entryKey);
  return enqueue(
    (outbox) => withOutboxLock(userId, () => outbox.ack(entryKey)),
    userId
  ).then((acknowledged) => {
    if (!acknowledged) return;
    markPendingHint(userId, entryKey, false, expectedVersion);
    scheduleOutboxChangeSignal();
  });
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
  if (!userId) return;
  pendingHintKeys.delete(userId);
  emitPendingHint(userId);
  try {
    await chain;
    const outbox = await getOutbox(userId);
    await withOutboxLock(userId, async () => {
      await withOutboxSweepLock(userId, async () => {
        if (outbox) await outbox.clear();
        await clearLegacyOutboxStorage(userId);
      });
    });
    // The eager zero hint above can race its own pre-clear reconciliation.
    // Emit once more only after durable storage is empty so this tab cannot
    // retain the old entry count now that there is no recurring poll.
    emitPendingHint(userId);
    scheduleOutboxChangeSignal();
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
  // Resolve namespace migration before taking the non-reentrant lock. The
  // snapshot remains inside the lock, so writes racing this open are still
  // serialized below.
  const before = await getOutbox(userId);
  await withOutboxLock(userId, async () => {
    let stragglers: OutboxEntry[] = [];
    try {
      stragglers = before ? await before.allEntries() : [];
    } catch (error) {
      warn(error);
    }
    await rekey();
    try {
      const after = await getOutbox(userId, true);
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
  pendingHintKeys.clear();
  pendingHintVersion = 0;
  if (outboxChangeSignalTimer) clearTimeout(outboxChangeSignalTimer);
  outboxChangeSignalTimer = undefined;
  outboxChangeSignalVersion = 0;
  outboxChangeListeners.clear();
}

/** Await all queued mirror writes — test hook for deterministic assertions. */
export async function outboxIdleForTests() {
  await chain;
}
