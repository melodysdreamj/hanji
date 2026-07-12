// Change-feed reader/pruner over the per-workspace `change_log`
// (docs/local-first-roadmap.md §7). Writing happens inside the boundedDb
// facade (workspace-db.ts); this module answers "what changed since <at>?"
// with honest completeness semantics: a feed pruned past `since` (age or
// size) reports complete:false and the client falls back to a full sync.

import type { DbRef } from './app-types';
import {
  CHANGE_LOG_PRUNE_SENTINEL,
  CHANGE_LOG_TABLE,
  type ChangeLogEntry,
} from './workspace-db';
import { listAll, nowIso } from './table-utils';

export const CHANGE_LOG_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
export const CHANGE_LOG_MAX_ENTRIES = 5000;
/** Above this many distinct scopes the skip-hints are omitted (client just refreshes). */
const SCOPE_HINT_CAP = 500;
const PRUNE_CHUNK = 50;

export interface ChangeFeed {
  /** False when `since` is missing or predates retained history. */
  complete: boolean;
  latestAt: string;
  entryCountSince: number;
  /** Any page_permissions mutation since — visibility may have shifted. */
  permissionsTouched: boolean;
  deletedPageIds: string[];
  /** Databases whose rows/schema changed since; undefined = unknown (capped). */
  changedDatabaseIds?: string[];
  /** Pages whose blocks changed since; undefined = unknown (capped). */
  changedBlockPageIds?: string[];
}

/**
 * The commit-order key for a change_log entry.
 *
 * Ordering the feed correctly requires a value that reflects the order rows
 * became durable, NOT the order a worker *intended* to write them. The worker's
 * `at` is stamped before `db.transact` is dispatched, but the commit itself can
 * lag arbitrarily behind that stamp — the op may sit in the workspace DO's
 * input queue while other work runs. That gap is what let a large staged
 * cascade (page-tree delete) commit "into the past" behind a client cursor that
 * a faster, later-stamped commit had already advanced, permanently dropping
 * tombstones.
 *
 * `createdAt` is assigned by the DatabaseDO with a single `now` captured at the
 * start of the serialized `transactionSync` that commits the row (see
 * workspace-db.ts ChangeLogEntry.createdAt for the SDK evidence). A Durable
 * Object is single-threaded and `transactionSync` is fully synchronous, so
 * commits are totally ordered and each `now` is captured only after every prior
 * commit is durable. Therefore `createdAt` is non-decreasing in commit order
 * and is completely independent of queue-wait time and cascade size — the
 * property `at` lacked. We prefer it and fall back to `at` only when it is
 * absent (test fakes / rows written before the auto-field existed).
 */
export function commitOrderKey(entry: ChangeLogEntry): string {
  return entry.createdAt ?? entry.at;
}

function sortByCommitOrder(a: ChangeLogEntry, b: ChangeLogEntry) {
  const ka = commitOrderKey(a);
  const kb = commitOrderKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export async function readChangeFeed(
  db: DbRef,
  workspaceId: string,
  since?: string,
): Promise<ChangeFeed> {
  const table = db.table<ChangeLogEntry>(CHANGE_LOG_TABLE);
  const all = (await listAll(table.where('workspaceId', '==', workspaceId))).sort(sortByCommitOrder);
  const sentinel = all.find((entry) => entry.tbl === CHANGE_LOG_PRUNE_SENTINEL);
  const entries = all.filter((entry) => entry.tbl !== CHANGE_LOG_PRUNE_SENTINEL);
  // latestAt (and thus the persisted cursor) is a commit-order key, not a raw
  // `at`. The prune sentinel stores its boundary in `at` on purpose (its own
  // createdAt is when the prune ran, not the boundary), so it is read via `.at`.
  const newest = entries.at(-1);
  const latestAt = (newest ? commitOrderKey(newest) : undefined) ?? sentinel?.at ?? nowIso();
  const empty: ChangeFeed = {
    complete: false,
    latestAt,
    entryCountSince: 0,
    permissionsTouched: false,
    deletedPageIds: [],
  };
  if (!since) return empty;
  if (sentinel?.at && since < sentinel.at) return empty;

  const recent = entries.filter((entry) => commitOrderKey(entry) > since);
  const deletedPageIds = [
    ...new Set(
      recent
        .filter((entry) => entry.tbl === 'pages' && entry.deleted)
        .map((entry) => entry.recordId),
    ),
  ];
  const dbScopes = new Set<string>();
  const blockPageScopes = new Set<string>();
  for (const entry of recent) {
    if (entry.tbl === 'pages' && entry.scope) dbScopes.add(entry.scope);
    if (
      (entry.tbl === 'db_properties' || entry.tbl === 'db_views' || entry.tbl === 'db_templates') &&
      entry.scope
    ) {
      dbScopes.add(entry.scope);
    }
    if (entry.tbl === 'blocks' && entry.scope) blockPageScopes.add(entry.scope);
  }
  return {
    complete: true,
    latestAt,
    entryCountSince: recent.length,
    permissionsTouched: recent.some((entry) => entry.tbl === 'page_permissions'),
    deletedPageIds,
    changedDatabaseIds: dbScopes.size <= SCOPE_HINT_CAP ? [...dbScopes] : undefined,
    changedBlockPageIds: blockPageScopes.size <= SCOPE_HINT_CAP ? [...blockPageScopes] : undefined,
  };
}

/**
 * Safety window the persisted change cursor is backed off by.
 *
 * WHY A WINDOW IS STILL NEEDED, AND WHY IT IS NOW SAFE-BY-CONSTRUCTION.
 *
 * The feed orders and gates on commitOrderKey (the DO-assigned `createdAt`),
 * which is stamped inside the workspace DO's serialized transactionSync and is
 * therefore non-decreasing in true commit order (see commitOrderKey above).
 * That structurally removes the original hole: a cascade can no longer be
 * ordered "into the past" behind a faster commit that landed first, no matter
 * how long its stamp→commit lag is or how large it is. The cursor advancing
 * past a not-yet-committed-but-earlier-ordered tombstone cannot happen, because
 * an entry's order key is only assigned once it is actually committing, after
 * every earlier commit is already durable.
 *
 * The ONE residual imprecision is timestamp *resolution*: `createdAt` is an ISO
 * millisecond string, so two DISTINCT commits that land in the same wall-clock
 * millisecond receive equal order keys. If a client synced between them it would
 * store the first commit's key as its cursor and the strict `> since` gate would
 * skip the second. That tie window is bounded by the clock resolution (1ms) and
 * is completely independent of cascade size or queue-wait — unlike the old
 * unbounded stamp→commit lag. Holding the cursor a fixed distance behind the
 * newest key re-scans any such tie on the next sync.
 *
 * WHY NOT AN ABSOLUTE, TIE-FREE SEQUENCE (no window at all). SQLite gives every
 * row a strictly-monotonic `rowid`, and the DO's single-threaded execution would
 * make it a perfect commit-order sequence — but EdgeBase does not surface it:
 * `SELECT *` omits rowid, the query engine can only sort/filter named schema
 * columns, and the schema DSL has no auto-increment/serial column type
 * (`number` → REAL). Nor can the app allocate its own sequence atomically: the
 * `transact` op set has no read-modify-write/counter primitive whose result a
 * later op in the same batch could stamp onto the log rows. So the strongest
 * commit-order value the SDK actually exposes is the ms-resolution `createdAt`,
 * and this window is what closes the residual ms-tie it leaves. 2000ms is orders
 * of magnitude larger than the 1ms tie it must cover. Re-delivering the window
 * is harmless: delta application is idempotent/set-based.
 */
export const CHANGE_CURSOR_SAFETY_WINDOW_MS = 2000;

/**
 * Persist the change cursor `CHANGE_CURSOR_SAFETY_WINDOW_MS` *behind* the newest
 * entry's timestamp (see above). Returns `latestAt` unchanged when it is not a
 * valid timestamp (guards NaN / the empty-log sentinel case).
 */
export function conservativeChangeCursor(latestAt: string): string {
  const parsed = Date.parse(latestAt);
  if (Number.isNaN(parsed)) return latestAt;
  return new Date(parsed - CHANGE_CURSOR_SAFETY_WINDOW_MS).toISOString();
}

/**
 * Age- and size-bound the log, recording the prune boundary in a sentinel row
 * so completeness checks stay truthful. Safe to call opportunistically.
 */
export async function pruneChangeLog(db: DbRef, workspaceId: string): Promise<void> {
  const table = db.table<ChangeLogEntry>(CHANGE_LOG_TABLE);
  const all = (await listAll(table.where('workspaceId', '==', workspaceId))).sort(sortByCommitOrder);
  const sentinel = all.find((entry) => entry.tbl === CHANGE_LOG_PRUNE_SENTINEL);
  const entries = all.filter((entry) => entry.tbl !== CHANGE_LOG_PRUNE_SENTINEL);
  const cutoffAt = new Date(Date.now() - CHANGE_LOG_HORIZON_MS).toISOString();
  const victims = new Map<string, ChangeLogEntry>();
  for (const entry of entries) {
    if (commitOrderKey(entry) < cutoffAt) victims.set(entry.id, entry);
  }
  const overflow = entries.length - victims.size - CHANGE_LOG_MAX_ENTRIES;
  if (overflow > 0) {
    for (const entry of entries) {
      if (victims.size >= entries.length - CHANGE_LOG_MAX_ENTRIES) break;
      victims.set(entry.id, entry);
    }
  }
  if (!victims.size) return;
  // The boundary is a commit-order key (matching the feed's cursor/gate), so a
  // client whose cursor predates the pruned range correctly reads incomplete.
  const ordered = [...victims.values()].sort(sortByCommitOrder);
  const newestVictim = ordered.at(-1);
  const boundary = (newestVictim ? commitOrderKey(newestVictim) : undefined) ?? cutoffAt;
  for (let i = 0; i < ordered.length; i += PRUNE_CHUNK) {
    await db.transact(
      ordered
        .slice(i, i + PRUNE_CHUNK)
        .map((entry) => ({ table: CHANGE_LOG_TABLE, op: 'delete' as const, id: entry.id })),
    );
  }
  if (sentinel) {
    if (boundary > sentinel.at) await table.update(sentinel.id, { at: boundary } as Partial<ChangeLogEntry>);
  } else {
    await table.insert({
      id: crypto.randomUUID(),
      workspaceId,
      tbl: CHANGE_LOG_PRUNE_SENTINEL,
      recordId: CHANGE_LOG_PRUNE_SENTINEL,
      scope: null,
      deleted: false,
      at: boundary,
    } as Partial<ChangeLogEntry>);
  }
}
