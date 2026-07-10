// Routing seam for the workspace-per-DO split (docs/workspace-do-migration.md).
//
// The split is now mandatory: central control-plane tables live in `app`, and
// workspace content tables live in the per-workspace dynamic block.
import type { DbRef } from './app-types';
import { getExisting, isNotFoundError, listAll, nowIso } from './table-utils';

// Content tables that live in the per-workspace dynamic block. Any new table
// must be classified here and in the migration/placement guard tests when it
// is introduced.
export const WORKSPACE_CONTENT_TABLES = [
  'pages',
  'blocks',
  'comments',
  'db_properties',
  'db_property_indexes',
  'db_views',
  'db_templates',
  'page_permissions',
  'share_links',
  'collaboration_operations',
  'collaboration_documents',
  'file_uploads',
  'notion_import_connections',
  'notion_import_jobs',
  'notion_import_items',
  'notion_import_mappings',
  'change_log',
] as const;

export type WorkspaceContentTable = (typeof WORKSPACE_CONTENT_TABLES)[number];

export const WORKSPACE_BLOCK_NAMESPACE = 'workspace';

export interface AdminDbAccessor {
  db(namespace: string, instanceId?: string): DbRef;
}

/**
 * The database handle for one workspace's content tables.
 */
export function workspaceDb(admin: AdminDbAccessor, workspaceId: string): DbRef {
  return admin.db(WORKSPACE_BLOCK_NAMESPACE, workspaceId);
}

/**
 * Resolve which workspace a page belongs to. Entry points that receive only a
 * pageId (/p/:id routes, share-mutation bodies, MCP tools) must go through
 * this seam. It reads the central `page_workspace_index` maintained by content
 * mutations.
 */
export async function resolvePageWorkspaceId(
  centralDb: DbRef,
  pageId: string,
): Promise<string | null> {
  // The index is trigger-maintained (waitUntil), so a read can race a page
  // that was created milliseconds ago — e.g. create page then immediately
  // create its first block. Hot creation paths also write the index row
  // synchronously (ensurePageWorkspaceIndex); this retry covers the rest.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const index = await getExisting(
      centralDb.table<{ id: string; workspaceId: string }>('page_workspace_index'),
      pageId,
    );
    if (index?.workspaceId) return index.workspaceId;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

/**
 * Synchronous index write for page-creation paths, so immediate follow-up
 * requests (create page → create block) resolve deterministically instead of
 * relying on the async trigger. Idempotent; the trigger remains the safety
 * net for surfaces that skip it.
 */
export async function ensurePageWorkspaceIndex(
  admin: AdminDbAccessor,
  pageId: string,
  workspaceId: string,
): Promise<void> {
  const table = admin
    .db('app')
    .table<{ id: string; workspaceId: string }>('page_workspace_index');
  const existing = await getExisting(table, pageId);
  if (existing?.workspaceId === workspaceId) return;
  if (existing) {
    try {
      await table.update(pageId, { workspaceId });
      return;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  const upsert = (table as typeof table & {
    upsert?: (data: { id: string; workspaceId: string }) => Promise<unknown>;
  }).upsert;
  if (upsert) {
    try {
      await upsert.call(table, { id: pageId, workspaceId });
      return;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  try {
    await table.insert({ id: pageId, workspaceId });
  } catch {
    const afterRace = await getExisting(table, pageId);
    if (afterRace?.workspaceId === workspaceId) return;
    if (afterRace) {
      await table.update(pageId, { workspaceId });
      return;
    }
    throw new Error(`Could not create page workspace index for page ${pageId}.`);
  }
}

/**
 * Dispatcher entry helper: resolves the owning workspace for a pageId-shaped
 * entry (page, block page, database, database row — rows are pages) and returns
 * the routed facade. Returns null when the page is unknown so callers keep
 * their existing not-found handling.
 */
export async function boundedDbForPage(
  admin: AdminDbAccessor,
  pageId: string,
): Promise<DbRef | null> {
  const workspaceId = await resolvePageWorkspaceId(admin.db('app'), pageId);
  if (!workspaceId) return null;
  return boundedDb(admin, workspaceId);
}

/**
 * Dispatcher entry helpers. Resolve the owning workspace from the strongest
 * hint available. Row-id-only entries (block id, comment id, permission id, ...)
 * cannot be
 * routed without a hint, so split mode fails them with an explicit message —
 * the flip checklist adds the missing fields to web/MCP callers, and these
 * errors make any stragglers loudly discoverable in split-mode smokes.
 */
export async function boundedDbFromPageHint(
  admin: AdminDbAccessor,
  ...pageIdHints: unknown[]
): Promise<DbRef> {
  const pageId = pageIdHints.find(
    (hint): hint is string => typeof hint === 'string' && hint.length > 0,
  );
  if (!pageId) {
    throw new Error(
      'pageId is required. This action needs a pageId for workspace routing.',
    );
  }
  const db = await boundedDbForPage(admin, pageId);
  if (!db) throw new Error('Page was not found.');
  return db;
}

/**
 * Unauthenticated /share/<token> entry. Resolves through the central
 * `share_link_index` (token -> workspaceId) maintained by setWebSharing. The
 * authoritative enabled/isPublic checks still run against workspace-block rows
 * afterwards, so a stale index row fails closed.
 */
export async function boundedDbFromShareToken(
  admin: AdminDbAccessor,
  tokenHint: unknown,
): Promise<DbRef> {
  const token = typeof tokenHint === 'string' && tokenHint ? tokenHint : null;
  if (!token) throw new Error('Shared page was not found.');
  const central = admin.db('app');
  const rows = await listAll(
    central
      .table<{ id: string; token: string; workspaceId: string }>('share_link_index')
      .where('token', '==', token),
  );
  const workspaceId = rows[0]?.workspaceId;
  if (!workspaceId) throw new Error('Shared page was not found.');
  return boundedDb(admin, workspaceId);
}

/**
 * permissionId-only mutation entries (updatePermission/removePermission).
 * Resolves through the central page_permission_index — no client API change
 * required.
 */
export async function boundedDbFromPermissionHint(
  admin: AdminDbAccessor,
  permissionIdHint: unknown,
): Promise<DbRef> {
  const permissionId =
    typeof permissionIdHint === 'string' && permissionIdHint ? permissionIdHint : null;
  if (!permissionId) throw new Error('Page permission was not found.');
  // Same trigger race as resolvePageWorkspaceId: a grant created milliseconds
  // ago may not have its index row yet. Hot paths write it synchronously
  // (ensurePagePermissionIndex); this retry covers the rest.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const index = await getExisting(
      admin.db('app').table<{ id: string; workspaceId: string }>('page_permission_index'),
      permissionId,
    );
    if (index?.workspaceId) return boundedDb(admin, index.workspaceId);
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Page permission was not found.');
}

/**
 * Synchronous index writes for share-mutation paths, mirroring the trigger
 * maintainers (on-page-permission-index / on-share-link-index), so immediate
 * follow-up requests (invite → updatePermission, setWebSharing → publicPage)
 * resolve deterministically. Idempotent; triggers remain the safety net.
 */
export async function ensurePagePermissionIndex(
  admin: AdminDbAccessor,
  permission: {
    id: string;
    workspaceId: string;
    pageId: string;
    principalType: string;
    principalId?: string | null;
    label?: string | null;
  },
): Promise<void> {
  const table = admin.db('app').table<{
    id: string;
    workspaceId: string;
    pageId: string;
    principalType: string;
    principalId?: string;
  }>('page_permission_index');
  const raw = permission.principalId ?? permission.label ?? '';
  const data = {
    workspaceId: permission.workspaceId,
    pageId: permission.pageId,
    principalType: permission.principalType,
    principalId: permission.principalType === 'email' ? raw.trim().toLowerCase() : raw,
  };
  const existing = await getExisting(table, permission.id);
  try {
    if (existing) {
      await table.update(permission.id, data);
    } else {
      await table.insert({ id: permission.id, ...data });
    }
  } catch {
    // Race with the trigger — the row exists either way.
  }
}

export async function ensureShareLinkIndex(
  admin: AdminDbAccessor,
  link: {
    id: string;
    token: string;
    workspaceId: string;
    pageId: string;
    enabled?: boolean;
  },
): Promise<void> {
  const table = admin.db('app').table<{
    id: string;
    token: string;
    workspaceId: string;
    pageId: string;
    enabled?: boolean;
  }>('share_link_index');
  const data = {
    token: link.token,
    workspaceId: link.workspaceId,
    pageId: link.pageId,
    enabled: link.enabled === true,
  };
  const existing = await getExisting(table, link.id);
  try {
    if (existing) {
      await table.update(link.id, data);
    } else {
      await table.insert({ id: link.id, ...data });
    }
  } catch {
    // Race with the trigger — the row exists either way.
  }
}

/**
 * Bootstrap fallback discovery: workspaces that hold direct page grants for
 * this principal. Reads the central index; callers must still validate
 * candidates against the authoritative workspace-block rows.
 */
export async function discoverPermissionWorkspaceIds(
  admin: AdminDbAccessor,
  actorId: string,
  normalizedEmail: string | null,
): Promise<string[]> {
  const central = admin.db('app');
  const table = central.table<{
    id: string;
    workspaceId: string;
    principalType: string;
    principalId?: string;
  }>('page_permission_index');
  const out = new Set<string>();
  const byUser = await listAll(table.where('principalId', '==', actorId));
  for (const row of byUser) {
    if (row.principalType === 'user' || row.principalType === 'integration') {
      out.add(row.workspaceId);
    }
  }
  if (normalizedEmail) {
    const byEmail = await listAll(table.where('principalId', '==', normalizedEmail));
    for (const row of byEmail) {
      if (row.principalType === 'email') out.add(row.workspaceId);
    }
  }
  return Array.from(out);
}

export function boundedDbFromWorkspaceHint(
  admin: AdminDbAccessor,
  ...workspaceIdHints: unknown[]
): DbRef {
  const workspaceId = workspaceIdHints.find(
    (hint): hint is string => typeof hint === 'string' && hint.length > 0,
  );
  if (!workspaceId) {
    throw new Error(
      'workspaceId is required. This action needs a workspaceId for workspace routing.',
    );
  }
  return boundedDb(admin, workspaceId);
}

/**
 * Admin/maintenance sweeps that legitimately span workspaces (file cleanup
 * cron, instance-admin reporting). Yields a facade per workspace so content
 * tables resolve. Fan-out cost is acceptable at admin frequency (design doc).
 */
export async function contentDbsForAllWorkspaces(
  admin: AdminDbAccessor,
): Promise<Array<{ workspaceId: string | null; db: DbRef }>> {
  const central = admin.db('app');
  const workspaces = await listAll(
    central.table<{ id: string }>('workspaces').where('id', '!=', ''),
  );
  return workspaces.map((workspace) => ({
    workspaceId: workspace.id,
    db: boundedDb(admin, workspace.id),
  }));
}

/**
 * Every workspace the actor can plausibly read: owned + memberships +
 * direct-grant discoveries. Used to fan out cross-workspace reads (Quick
 * Find search, accessible-page listings) after the split. Central reads
 * only; per-workspace authorization still runs inside each facade call.
 */
export async function accessibleWorkspaceIdsForActor(
  admin: AdminDbAccessor,
  actorId: string,
  normalizedEmail: string | null,
): Promise<string[]> {
  const central = admin.db('app');
  const out = new Set<string>();
  const owned = await listAll(
    central.table<{ id: string; ownerId?: string }>('workspaces').where('ownerId', '==', actorId),
  );
  for (const workspace of owned) out.add(workspace.id);
  const memberships = await listAll(
    central
      .table<{ id: string; workspaceId: string }>('workspace_members')
      .where('userId', '==', actorId),
  );
  for (const membership of memberships) out.add(membership.workspaceId);
  for (const workspaceId of await discoverPermissionWorkspaceIds(admin, actorId, normalizedEmail)) {
    out.add(workspaceId);
  }
  return Array.from(out);
}

/**
 * Execute an ordered op list that intentionally spans the boundary as
 * consecutive same-side transact segments: [central guards] -> [workspace
 * content] -> [central audit]. Cross-block atomicity is impossible (doc: audit
 * outbox is the eventual shape), so segment ordering preserves fail-closed
 * properties: guards run before any write, and a failed trailing segment
 * surfaces loudly while the primary write stands.
 */
export async function transactBySideSegments(
  admin: AdminDbAccessor,
  workspaceId: string,
  operations: Array<{ table: string; [key: string]: unknown }>,
): Promise<void> {
  const content = boundedDb(admin, workspaceId);
  const central = admin.db('app');
  let segment: typeof operations = [];
  let segmentSide: 'central' | 'content' | null = null;
  let committedSegments = 0;
  const flush = async () => {
    if (!segment.length) return;
    const target = segmentSide === 'content' ? content : central;
    try {
      await target.transact(segment as never);
    } catch (error) {
      // When a later segment fails after an earlier one committed — e.g. the
      // content write landed but the trailing central audit insert did not —
      // the caller sees an error while part of the mutation is durable. Make
      // that partial commit loudly detectable so dropped audit rows can be
      // found and backfilled (the audit outbox remains the eventual shape).
      if (committedSegments > 0) {
        console.error(
          '[cross-block-partial-commit]',
          JSON.stringify({
            workspaceId,
            failedSide: segmentSide,
            failedTables: Array.from(new Set(segment.map((op) => op.table))),
            committedSegments,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      throw error;
    }
    committedSegments += 1;
    segment = [];
  };
  for (const op of operations) {
    const side = isWorkspaceContentTable(op.table) ? 'content' : 'central';
    if (segmentSide !== side) {
      await flush();
      segmentSide = side;
    }
    segment.push(op);
  }
  await flush();
}

const CONTENT_TABLE_SET: ReadonlySet<string> = new Set(WORKSPACE_CONTENT_TABLES);

export function isWorkspaceContentTable(name: string): boolean {
  return CONTENT_TABLE_SET.has(name);
}

// ── change log (local-first delta sync — docs/local-first-roadmap.md §7) ────
// Every mutation to the tables below, applied through the boundedDb facade
// (the single choke point every product function uses), appends a
// per-workspace change entry. DELETES append atomically in the same transact,
// because a deletion has no other trace — the entry is its tombstone.
// Inserts/updates append best-effort: a missed entry self-heals through the
// updatedAt watermark (bootstrap pagesSince) and the feed-completeness
// fallback. `change_log` itself is never wrapped.

export const CHANGE_LOG_TABLE = 'change_log';
/** Sentinel row updated on prune; feed reads older than this are incomplete. */
export const CHANGE_LOG_PRUNE_SENTINEL = '__pruned';

const CHANGE_LOGGED_TABLES = new Set<string>([
  'pages',
  'blocks',
  'db_properties',
  'db_views',
  'db_templates',
  'page_permissions',
]);

/** Server-side transact ceiling (edgebase database-do.ts MAX_TRANSACT_OPS). */
const SERVER_MAX_TRANSACT_OPS = 500;

/**
 * Chunk size for caller-side transact batches routed through boundedDb. Every
 * raw op on a change-logged table gains exactly one appended change_log insert,
 * so a batch of n raw ops can reach 2n server ops; 240 keeps 2n under the
 * 500-op server cap with headroom. Cascades must chunk children first and put
 * the root/page row in the LAST chunk so a partial failure stays retryable.
 */
export const MAX_RAW_TRANSACT_OPS = 240;

export interface ChangeLogEntry {
  id: string;
  workspaceId: string;
  tbl: string;
  recordId: string;
  scope?: string | null;
  deleted?: boolean;
  /**
   * Worker wall-clock stamp captured just before the commit is dispatched. A
   * best-effort approximation of commit time and the `required` schema column,
   * but it can be assigned well before the row is durable (the commit may wait
   * in the workspace DO's input queue). Ordering is NOT keyed off this field —
   * see `createdAt` and change-log.ts commitOrderKey.
   */
  at: string;
  /**
   * DO-assigned commit-time stamp. The DatabaseDO overwrites `createdAt` with a
   * single `now` captured at the START of the serialized `transactionSync` that
   * commits the row (edgebase server database-do.ts: the `/transact` and
   * `/tables/:name` handlers set `record.createdAt = now` inside
   * `ctx.storage.transactionSync`). Because a Durable Object is single-threaded
   * and `transactionSync` is synchronous, commits are totally ordered and each
   * one's `now` is captured only after every prior commit is durable — so
   * `createdAt` reflects true commit order (non-decreasing), independent of how
   * long the op waited in the queue or how large the cascade is. Absent only on
   * test fakes / pre-auto-field rows, where commitOrderKey falls back to `at`.
   */
  createdAt?: string;
}

/**
 * Container scope for an entry, derivable from the mutation payload alone:
 * rows → their database id, blocks → their page id, schema entities → their
 * database id. `undefined` means the payload alone cannot tell (the caller
 * may look the record up); `null` means "no scope" (e.g. a non-row page).
 */
function changeScopeFromData(
  table: string,
  data: Record<string, unknown> | undefined,
): string | null | undefined {
  const d = data ?? {};
  switch (table) {
    case 'pages':
      if (typeof d.parentType === 'string') {
        return d.parentType === 'database' && typeof d.parentId === 'string' && d.parentId
          ? d.parentId
          : null;
      }
      return undefined;
    case 'blocks':
      return typeof d.pageId === 'string' && d.pageId ? d.pageId : undefined;
    case 'db_properties':
    case 'db_views':
    case 'db_templates':
      return typeof d.databaseId === 'string' && d.databaseId ? d.databaseId : undefined;
    case 'page_permissions':
      return typeof d.pageId === 'string' && d.pageId ? d.pageId : undefined;
    default:
      return null;
  }
}

function changeLogRow(
  workspaceId: string,
  table: string,
  recordId: string,
  scope: string | null,
  deleted: boolean,
  // `at` is a coarse worker-side stamp only; the feed orders on the DO-assigned
  // `createdAt` instead (change-log.ts commitOrderKey), so this need only be a
  // reasonable approximation. Stamp it as late as possible anyway (a single
  // timestamp captured immediately before the commit) so the fallback path
  // used by test fakes stays close to commit order.
  at: string = nowIso(),
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    tbl: table,
    recordId,
    scope,
    deleted,
    at,
  };
}

/**
 * Side-aware DbRef facade: `table(name)` routes content tables to the
 * workspace handle and everything else to the central handle, so function
 * bodies and libs (page-access & co) keep a single `db` parameter across the
 * split. `transact` requires every op to target ONE side — a mixed batch
 * would silently lose its atomicity at the boundary, so it throws instead
 * (the staged cascades already group ops per side).
 *
 * Content mutations additionally feed the per-workspace change log (above).
 */
export function boundedDb(admin: AdminDbAccessor, workspaceId: string): DbRef {
  const central = admin.db('app');
  const content = admin.db(WORKSPACE_BLOCK_NAMESPACE, workspaceId);

  const appendEntry = async (
    table: string,
    recordId: string,
    scope: string | null,
    deleted: boolean,
  ) => {
    try {
      await content
        .table<Record<string, unknown>>(CHANGE_LOG_TABLE)
        .insert(changeLogRow(workspaceId, table, recordId, scope, deleted));
    } catch (error) {
      console.error('[change-log] append failed:', error);
    }
  };

  const resolveScope = async (
    table: string,
    id: string,
    data: Record<string, unknown> | undefined,
  ): Promise<string | null> => {
    const fromData = changeScopeFromData(table, data);
    if (fromData !== undefined) return fromData;
    try {
      const existing = await getExisting(
        content.table<Record<string, unknown>>(table),
        id,
      );
      if (!existing) return null;
      return changeScopeFromData(table, existing) ?? null;
    } catch {
      return null;
    }
  };

  // Proxy (not spread!): the runtime TableRef keeps query methods like
  // `where`/`getList` on its prototype, which object spread would drop.
  const wrapTable = <T,>(name: string, ref: TableRefLike<T>): TableRefLike<T> => {
    const insert = async (data: Partial<T>) => {
      const row = await ref.insert(data);
      const recordId = String(
        (row as { id?: unknown })?.id ?? (data as { id?: unknown })?.id ?? '',
      );
      if (recordId) {
        await appendEntry(
          name,
          recordId,
          changeScopeFromData(name, row as Record<string, unknown>) ?? null,
          false,
        );
      }
      return row;
    };
    const update = async (id: string, data: Partial<T>) => {
      const scope = await resolveScope(name, id, data as Record<string, unknown>);
      const row = await ref.update(id, data);
      await appendEntry(name, id, scope, false);
      return row;
    };
    const remove = async (id: string) => {
      const scope = await resolveScope(name, id, undefined);
      await content.transact([
        { table: name, op: 'delete', id },
        {
          table: CHANGE_LOG_TABLE,
          op: 'insert',
          data: changeLogRow(workspaceId, name, id, scope, true),
        },
      ]);
    };
    return new Proxy(ref as object, {
      get(target, prop) {
        if (prop === 'insert') return insert;
        if (prop === 'update') return update;
        if (prop === 'delete') return remove;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as TableRefLike<T>;
  };

  return {
    table<T>(name: string) {
      const ref = (isWorkspaceContentTable(name) ? content : central).table<T>(name);
      return CHANGE_LOGGED_TABLES.has(name)
        ? (wrapTable(name, ref as TableRefLike<T>) as typeof ref)
        : ref;
    },
    async transact(operations) {
      const sides = new Set(
        operations.map((op) => (isWorkspaceContentTable(op.table) ? 'content' : 'central')),
      );
      if (sides.size > 1) {
        throw new Error(
          'boundedDb.transact received ops for both central and workspace tables; '
          + 'split the batch per side (docs/workspace-do-migration.md).',
        );
      }
      const target = sides.has('content') ? content : central;
      if (target !== content) return target.transact(operations);
      // Log ops are APPENDED so callers' positional result indexing survives.
      // Resolve every entry's metadata first (the scope lookups below issue
      // reads), THEN stamp them all with one `committedAt`. This only populates
      // the coarse `at` column (schema-required, and the fallback ordering key).
      // The AUTHORITATIVE feed ordering key is the DO-assigned `createdAt`,
      // stamped inside the workspace DO's serialized transactionSync at the
      // actual commit point — so ordering no longer depends on this worker-side
      // stamp at all, and a slow/large cascade can never be ordered "into the
      // past" behind a faster commit that landed first (change-log.ts
      // commitOrderKey / conservativeChangeCursor).
      // Scope reads run concurrently (Promise.all) — a large cascade must not
      // pay one awaited round-trip per op before it can commit.
      const pending = (
        await Promise.all(
          operations.map(
            async (op): Promise<{ table: string; recordId: string; scope: string | null; deleted: boolean } | null> => {
              if (!CHANGE_LOGGED_TABLES.has(op.table)) return null;
              if (op.op === 'insert') {
                const recordId = String((op.data as { id?: unknown })?.id ?? '');
                if (!recordId) return null;
                return {
                  table: op.table,
                  recordId,
                  scope: changeScopeFromData(op.table, op.data) ?? null,
                  deleted: false,
                };
              }
              if (op.op === 'update' || op.op === 'delete') {
                const scope = await resolveScope(
                  op.table,
                  op.id,
                  op.op === 'update' ? op.data : undefined,
                );
                return { table: op.table, recordId: op.id, scope, deleted: op.op === 'delete' };
              }
              return null;
            },
          ),
        )
      ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const augmented = [...operations];
      const committedAt = nowIso();
      for (const entry of pending) {
        augmented.push({
          table: CHANGE_LOG_TABLE,
          op: 'insert',
          data: changeLogRow(workspaceId, entry.table, entry.recordId, entry.scope, entry.deleted, committedAt),
        });
      }
      // Fail fast with an actionable message instead of the runtime's opaque
      // "Transact limit exceeded" 400. Not auto-split: callers such as
      // upsertCrdtDocument rely on a batch (expect + write) staying one
      // atomic transact.
      if (augmented.length > SERVER_MAX_TRANSACT_OPS) {
        throw new Error(
          `boundedDb.transact batch of ${operations.length} ops becomes ${augmented.length} after `
          + `change-log augmentation, exceeding the ${SERVER_MAX_TRANSACT_OPS}-op server transact cap; `
          + `chunk raw ops at MAX_RAW_TRANSACT_OPS (${MAX_RAW_TRANSACT_OPS}).`,
        );
      }
      return content.transact(augmented);
    },
  };
}

// Minimal structural view of TableRef so the wrapper stays decoupled from the
// full app-types surface (extra runtime methods pass through the spread).
interface TableRefLike<T> {
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  getOne(id: string): Promise<T | null>;
}
