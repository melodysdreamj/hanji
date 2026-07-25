import type { DbRef } from './app-types';
import { getExisting, nowIso, type TableQuery } from './table-utils';
import { boundedDb, workspaceDb, type AdminDbAccessor } from './workspace-db';

export const FILE_MAINTENANCE_QUEUE_TABLE = 'file_maintenance_queue';
export const FILE_MAINTENANCE_SWEEP_STATE_TABLE = 'file_maintenance_sweep_state';
export const MAX_DUE_MAINTENANCE_WORKSPACES = 12;
export const MAX_AUDIT_MAINTENANCE_WORKSPACES = 4;
export const MAX_MAINTENANCE_WORKSPACE_WAKES =
  MAX_DUE_MAINTENANCE_WORKSPACES + MAX_AUDIT_MAINTENANCE_WORKSPACES;

const SWEEP_STATE_ID = 'workspace-audit';
const MAINTENANCE_RETRY_MS = 5 * 60 * 1000;
const PREPARING_RECOVERY_TTL_MS = 30 * 60 * 1000;
const LEGACY_PENDING_RECOVERY_TTL_MS = 35 * 60 * 1000;
const UNATTACHED_UPLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_REFERENCE_RECHECK_MS = 24 * 60 * 60 * 1000;
const QUEUE_CAS_ATTEMPTS = 8;

export interface FileMaintenanceQueueRow {
  id: string;
  workspaceId: string;
  dueAt: string;
  availableAt: string;
  claimUntil?: string | null;
  generation: string;
}

interface FileMaintenanceSweepState {
  id: string;
  cursorWorkspaceId?: string | null;
}

interface MaintenanceUpload {
  id: string;
  workspaceId: string;
  status?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  orphanReferenceCheckedAt?: string | null;
  notionImportJobId?: string | null;
  notionImportSnapshotRevision?: string | null;
  notionImportTerminalSweepAfter?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface MaintenanceLock {
  id: string;
  recoveryData?: unknown;
  expiresAt?: string;
}

interface MaintenanceSelection {
  workspaceId: string;
  db: DbRef;
  rawDb: DbRef;
  queueGeneration: string;
  source: 'due' | 'audit' | 'due+audit';
}

export interface FileMaintenanceRouteSelection {
  workspaces: MaintenanceSelection[];
  dueCandidates: number;
  auditCandidates: number;
  wakeBound: number;
}

function isoAt(timestamp: number) {
  return new Date(timestamp).toISOString();
}

function parsedTimestamp(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function earliestIso(values: Array<number | undefined>) {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length > 0 ? isoAt(Math.min(...finite)) : null;
}

function transactionExpectationConflict(error: unknown) {
  return error instanceof Error && error.message.includes('Transaction expectation failed');
}

function ordered<T>(query: TableQuery<T>, field: string) {
  return typeof query.orderBy === 'function' ? query.orderBy(field, 'asc') : query;
}

function requiredWhere<T>(
  query: TableQuery<T>,
  field: string,
  op: string,
  value: unknown,
) {
  if (typeof query.where !== 'function') {
    throw new Error(`File-maintenance routing requires chained where() for ${field}.`);
  }
  return query.where(field, op, value);
}

async function first<T>(query: TableQuery<T>): Promise<T | null> {
  const result = await query.limit(1).getList();
  return result.items?.[0] ?? null;
}

function queueTable(db: DbRef) {
  return db.table<FileMaintenanceQueueRow>(FILE_MAINTENANCE_QUEUE_TABLE);
}

/**
 * Collapse every relevant mutation in one workspace to one scalar routing
 * hint. The workspace DO remains authoritative; this row carries no content.
 */
export async function enqueueWorkspaceFileMaintenance(
  admin: AdminDbAccessor,
  workspaceId: string,
  dueAt = nowIso(),
): Promise<FileMaintenanceQueueRow> {
  const central = admin.db('app');
  const table = queueTable(central);
  const requestedAt = parsedTimestamp(dueAt) ?? Date.now();
  for (let attempt = 0; attempt < QUEUE_CAS_ATTEMPTS; attempt += 1) {
    const existing = await getExisting(table, workspaceId);
    const generation = crypto.randomUUID();
    if (!existing) {
      try {
        return await table.insert({
          id: workspaceId,
          workspaceId,
          dueAt: isoAt(requestedAt),
          availableAt: isoAt(requestedAt),
          claimUntil: null,
          generation,
        });
      } catch (error) {
        const raced = await getExisting(table, workspaceId);
        if (raced) continue;
        throw error;
      }
    }
    const existingAt = parsedTimestamp(existing.dueAt) ?? requestedAt;
    const nextDueAt = isoAt(Math.min(existingAt, requestedAt));
    const claimUntil = parsedTimestamp(existing.claimUntil);
    const activeClaim = claimUntil !== undefined && claimUntil > Date.now();
    const existingAvailableAt = parsedTimestamp(existing.availableAt) ?? existingAt;
    // One already-due marker is sufficient until a worker claims it. During a
    // claim, the worker replaces dueAt with claimUntil; the first concurrent
    // mutation lowers it again and changes generation, while later mutations
    // collapse without another central write.
    if (
      existingAt <= requestedAt
      && (
        (!activeClaim && existingAvailableAt <= requestedAt)
        || (activeClaim && claimUntil !== undefined && existingAt < claimUntil)
      )
    ) {
      return existing;
    }
    const nextAvailableAt = activeClaim
      ? isoAt(Math.max(existingAvailableAt, claimUntil))
      : isoAt(Math.min(existingAvailableAt, requestedAt));
    try {
      const result = await central.transact([
        {
          table: FILE_MAINTENANCE_QUEUE_TABLE,
          op: 'expect',
          id: workspaceId,
          where: [['generation', '==', existing.generation]],
          exists: true,
        },
        {
          table: FILE_MAINTENANCE_QUEUE_TABLE,
          op: 'update',
          id: workspaceId,
          data: {
            dueAt: nextDueAt,
            availableAt: nextAvailableAt,
            generation,
          },
        },
      ]);
      return result.results[1]?.updated as FileMaintenanceQueueRow;
    } catch (error) {
      if (transactionExpectationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error(`Could not enqueue file maintenance for workspace ${workspaceId}.`);
}

async function readDueQueue(central: DbRef, now: number) {
  const query = ordered(
    queueTable(central).where('availableAt', '<=', isoAt(now)),
    'availableAt',
  );
  const result = await query.limit(MAX_DUE_MAINTENANCE_WORKSPACES).getList();
  return result.items ?? [];
}

async function readAuditWorkspaceIds(central: DbRef) {
  const stateTable = central.table<FileMaintenanceSweepState>(
    FILE_MAINTENANCE_SWEEP_STATE_TABLE,
  );
  const state = await getExisting(stateTable, SWEEP_STATE_ID);
  const cursor = state?.cursorWorkspaceId ?? '';
  const workspaces = central.table<{ id: string }>('workspaces');
  const afterQuery = ordered(workspaces.where('id', '>', cursor), 'id');
  const after = (await afterQuery.limit(MAX_AUDIT_MAINTENANCE_WORKSPACES).getList()).items ?? [];
  const selected = [...after];
  if (selected.length < MAX_AUDIT_MAINTENANCE_WORKSPACES && cursor) {
    const beforeQuery = ordered(workspaces.where('id', '<=', cursor), 'id');
    const before = (
      await beforeQuery.limit(MAX_AUDIT_MAINTENANCE_WORKSPACES - selected.length).getList()
    ).items ?? [];
    const seen = new Set(selected.map((workspace) => workspace.id));
    selected.push(...before.filter((workspace) => !seen.has(workspace.id)));
  }
  const lastWorkspaceId = selected.at(-1)?.id;
  if (lastWorkspaceId) {
    if (state) {
      await stateTable.update(SWEEP_STATE_ID, { cursorWorkspaceId: lastWorkspaceId });
    } else {
      try {
        await stateTable.insert({ id: SWEEP_STATE_ID, cursorWorkspaceId: lastWorkspaceId });
      } catch {
        const raced = await getExisting(stateTable, SWEEP_STATE_ID);
        if (raced) await stateTable.update(SWEEP_STATE_ID, { cursorWorkspaceId: lastWorkspaceId });
      }
    }
  }
  return selected.map((workspace) => workspace.id);
}

async function claimQueueRow(
  central: DbRef,
  row: FileMaintenanceQueueRow,
  now: number,
): Promise<string | null> {
  const existingClaimUntil = parsedTimestamp(row.claimUntil);
  if (existingClaimUntil !== undefined && existingClaimUntil > now) return null;
  const claimGeneration = crypto.randomUUID();
  const claimUntil = isoAt(now + MAINTENANCE_RETRY_MS);
  try {
    await central.transact([
      {
        table: FILE_MAINTENANCE_QUEUE_TABLE,
        op: 'expect',
        id: row.id,
        where: [['generation', '==', row.generation]],
        exists: true,
      },
      {
        table: FILE_MAINTENANCE_QUEUE_TABLE,
        op: 'update',
        id: row.id,
        data: {
          dueAt: claimUntil,
          availableAt: claimUntil,
          claimUntil,
          generation: claimGeneration,
        },
      },
    ]);
    return claimGeneration;
  } catch (error) {
    if (transactionExpectationConflict(error)) return null;
    throw error;
  }
}

/** Select and claim a fixed due window plus a separately reserved audit lane. */
export async function selectFileMaintenanceWorkspaces(
  admin: AdminDbAccessor,
  now = Date.now(),
): Promise<FileMaintenanceRouteSelection> {
  const central = admin.db('app');
  const [dueRows, auditWorkspaceIds] = await Promise.all([
    readDueQueue(central, now),
    readAuditWorkspaceIds(central),
  ]);
  const candidates = new Map<string, {
    row?: FileMaintenanceQueueRow;
    due: boolean;
    audit: boolean;
  }>();
  for (const row of dueRows) {
    candidates.set(row.workspaceId, { row, due: true, audit: false });
  }
  for (const workspaceId of auditWorkspaceIds) {
    const existing = candidates.get(workspaceId);
    candidates.set(workspaceId, existing
      ? { ...existing, audit: true }
      : { due: false, audit: true });
  }

  const claimed = await Promise.all(Array.from(candidates, async ([workspaceId, candidate]) => {
    let row = candidate.row;
    if (!row) {
      const existing = await getExisting(queueTable(central), workspaceId);
      const claimUntil = parsedTimestamp(existing?.claimUntil);
      if (claimUntil !== undefined && claimUntil > now) return null;
      row = await enqueueWorkspaceFileMaintenance(admin, workspaceId, isoAt(now));
    }
    const queueGeneration = await claimQueueRow(central, row, now);
    if (!queueGeneration) return null;
    const rawDb = workspaceDb(admin, workspaceId);
    return {
      workspaceId,
      db: boundedDb(admin, workspaceId, { contentDb: rawDb }),
      rawDb,
      queueGeneration,
      source: candidate.due && candidate.audit
        ? 'due+audit' as const
        : candidate.due ? 'due' as const : 'audit' as const,
    };
  }));
  return {
    workspaces: claimed.filter((entry): entry is MaintenanceSelection => entry !== null),
    dueCandidates: dueRows.length,
    auditCandidates: auditWorkspaceIds.length,
    wakeBound: MAX_MAINTENANCE_WORKSPACE_WAKES,
  };
}

function dueFromStamp(row: MaintenanceUpload | null, field: 'createdAt' | 'updatedAt', ttl: number) {
  const stamp = row ? parsedTimestamp(row[field]) : undefined;
  return stamp === undefined ? undefined : stamp + ttl;
}

function knownRecoveryDue(lock: MaintenanceLock | null) {
  if (!lock?.recoveryData || typeof lock.recoveryData !== 'object') return undefined;
  const kind = (lock.recoveryData as { kind?: unknown }).kind;
  if (kind !== 'duplicate-page-v1' && kind !== 'database-property-delete-v1') return undefined;
  return parsedTimestamp(lock.expiresAt);
}

/**
 * Re-read only indexed first rows from the workspace authority and derive its
 * next scalar deadline. No content or payload is copied into the central row.
 */
export async function nextWorkspaceFileMaintenanceDueAt(
  db: DbRef,
  workspaceId: string,
  now = Date.now(),
): Promise<string | null> {
  const uploads = db.table<MaintenanceUpload>('file_uploads');
  const uploadLane = (
    status: string | string[],
    filters: Array<[string, string, unknown]>,
    orderField: string,
  ) => {
    let query: TableQuery<MaintenanceUpload> = uploads.where(
      'status',
      Array.isArray(status) ? 'in' : '==',
      status,
    );
    for (const [field, op, value] of filters) {
      query = requiredWhere(query, field, op, value);
    }
    return first(ordered(query, orderField));
  };

  const [
    auditOutbox,
    lock,
    pendingExpiry,
    pendingUpdated,
    pendingCreated,
    preparingExpiry,
    preparingUpdated,
    preparingCreated,
    deletingExpiry,
    uploadedCompleted,
    uploadedUpdated,
    uploadedCreated,
    uploadedReferenceRecheck,
    terminalSweep,
  ] = await Promise.all([
    first(db.table<{ id: string }>('organization_audit_outbox')
      .where('workspaceId', '==', workspaceId)),
    getExisting(db.table<MaintenanceLock>('file_workspace_locks'), workspaceId),
    uploadLane('pending', [['expiresAt', '!=', null]], 'expiresAt'),
    uploadLane('pending', [['expiresAt', '==', null], ['updatedAt', '!=', null]], 'updatedAt'),
    uploadLane(
      'pending',
      [['expiresAt', '==', null], ['updatedAt', '==', null], ['createdAt', '!=', null]],
      'createdAt',
    ),
    uploadLane('preparing', [['expiresAt', '!=', null]], 'expiresAt'),
    uploadLane('preparing', [['expiresAt', '==', null], ['updatedAt', '!=', null]], 'updatedAt'),
    uploadLane(
      'preparing',
      [['expiresAt', '==', null], ['updatedAt', '==', null], ['createdAt', '!=', null]],
      'createdAt',
    ),
    uploadLane('deleting', [['expiresAt', '!=', null]], 'expiresAt'),
    uploadLane(
      'uploaded',
      [['orphanReferenceCheckedAt', '==', null], ['completedAt', '!=', null]],
      'completedAt',
    ),
    uploadLane(
      'uploaded',
      [
        ['orphanReferenceCheckedAt', '==', null],
        ['completedAt', '==', null],
        ['updatedAt', '!=', null],
      ],
      'updatedAt',
    ),
    uploadLane(
      'uploaded',
      [
        ['orphanReferenceCheckedAt', '==', null],
        ['completedAt', '==', null],
        ['updatedAt', '==', null],
        ['createdAt', '!=', null],
      ],
      'createdAt',
    ),
    uploadLane(
      'uploaded',
      [['orphanReferenceCheckedAt', '!=', null]],
      'orphanReferenceCheckedAt',
    ),
    first(ordered(
      requiredWhere(
        uploads,
        'notionImportTerminalSweepAfter',
        '!=',
        null,
      ),
      'notionImportTerminalSweepAfter',
    )),
  ]);

  return earliestIso([
    auditOutbox ? now : undefined,
    knownRecoveryDue(lock),
    parsedTimestamp(pendingExpiry?.expiresAt),
    dueFromStamp(pendingUpdated, 'updatedAt', LEGACY_PENDING_RECOVERY_TTL_MS),
    dueFromStamp(pendingCreated, 'createdAt', LEGACY_PENDING_RECOVERY_TTL_MS),
    parsedTimestamp(preparingExpiry?.expiresAt),
    dueFromStamp(preparingUpdated, 'updatedAt', PREPARING_RECOVERY_TTL_MS),
    dueFromStamp(preparingCreated, 'createdAt', PREPARING_RECOVERY_TTL_MS),
    parsedTimestamp(deletingExpiry?.expiresAt),
    parsedTimestamp(uploadedCompleted?.completedAt) === undefined
      ? undefined
      : parsedTimestamp(uploadedCompleted?.completedAt)! + UNATTACHED_UPLOAD_MIN_AGE_MS,
    dueFromStamp(uploadedUpdated, 'updatedAt', UNATTACHED_UPLOAD_MIN_AGE_MS),
    dueFromStamp(uploadedCreated, 'createdAt', UNATTACHED_UPLOAD_MIN_AGE_MS),
    uploadedReferenceRecheck
      ? (parsedTimestamp(uploadedReferenceRecheck.orphanReferenceCheckedAt) ?? now)
        + ORPHAN_REFERENCE_RECHECK_MS
      : undefined,
    parsedTimestamp(terminalSweep?.notionImportTerminalSweepAfter),
  ]);
}

/** Settle only the generation this worker claimed; a newer mutation wins. */
export async function settleWorkspaceFileMaintenance(
  admin: AdminDbAccessor,
  workspaceId: string,
  queueGeneration: string,
  nextDueAt: string | null,
  now = Date.now(),
): Promise<'updated' | 'deleted' | 'superseded'> {
  const central = admin.db('app');
  const due = parsedTimestamp(nextDueAt);
  const normalizedDue = due === undefined
    ? null
    : isoAt(due <= now ? now + MAINTENANCE_RETRY_MS : due);
  try {
    await central.transact([
      {
        table: FILE_MAINTENANCE_QUEUE_TABLE,
        op: 'expect',
        id: workspaceId,
        where: [['generation', '==', queueGeneration]],
        exists: true,
      },
      normalizedDue
        ? {
            table: FILE_MAINTENANCE_QUEUE_TABLE,
            op: 'update',
            id: workspaceId,
            data: {
              dueAt: normalizedDue,
              availableAt: normalizedDue,
              claimUntil: null,
            },
          }
        : {
            table: FILE_MAINTENANCE_QUEUE_TABLE,
            op: 'delete',
            id: workspaceId,
          },
    ]);
    return normalizedDue ? 'updated' : 'deleted';
  } catch (error) {
    if (transactionExpectationConflict(error)) return 'superseded';
    throw error;
  }
}
