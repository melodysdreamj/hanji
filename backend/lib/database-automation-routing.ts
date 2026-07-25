import type { DatabaseAutomationDefinition, DbRef } from './app-types';
import { getExisting, type TableQuery, type TransactOperation } from './table-utils';
import { boundedDb, type AdminDbAccessor } from './workspace-db';

export const DATABASE_AUTOMATION_WAKE_QUEUE_TABLE = 'database_automation_workspace_wakes';
export const DATABASE_AUTOMATION_WAKE_SWEEP_STATE_TABLE =
  'database_automation_wake_sweep_state';
export const MAX_DUE_DATABASE_AUTOMATION_WORKSPACES = 8;
export const MAX_AUDIT_DATABASE_AUTOMATION_WORKSPACES = 2;
export const MAX_DATABASE_AUTOMATION_WORKSPACE_WAKES =
  MAX_DUE_DATABASE_AUTOMATION_WORKSPACES + MAX_AUDIT_DATABASE_AUTOMATION_WORKSPACES;

const SWEEP_STATE_ID = 'workspace-audit';
const WAKE_CLAIM_MS = 2 * 60 * 1000;
const QUEUE_CAS_ATTEMPTS = 8;

export interface DatabaseAutomationWorkspaceWake {
  id: string;
  workspaceId: string;
  dueAt: string;
  availableAt: string;
  claimUntil?: string | null;
  generation: string;
}

interface DatabaseAutomationWakeSweepState {
  id: string;
  cursorWorkspaceId?: string | null;
}

interface DatabaseAutomationDeliveryDeadline {
  id: string;
  workspaceId: string;
  state: string;
  nextAttemptAt: string;
}

export interface DatabaseAutomationWorkspaceSelection {
  workspaceId: string;
  db: DbRef;
  queueGeneration: string;
  source: 'due' | 'audit' | 'due+audit';
}

export interface DatabaseAutomationWakeSelection {
  workspaces: DatabaseAutomationWorkspaceSelection[];
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

function transactionExpectationConflict(error: unknown) {
  return error instanceof Error && error.message.includes('Transaction expectation failed');
}

function queueTable(db: DbRef) {
  return db.table<DatabaseAutomationWorkspaceWake>(DATABASE_AUTOMATION_WAKE_QUEUE_TABLE);
}

function requiredComposableQuery<T>(query: TableQuery<T>, label: string) {
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw new Error(`${label} requires bounded filtered keyset queries.`);
  }
  return query as TableQuery<T> & {
    where(field: string, op: string, value: unknown): TableQuery<T>;
    orderBy(field: string, direction: 'asc' | 'desc'): TableQuery<T>;
  };
}

function ordered<T>(query: TableQuery<T>, field: string) {
  if (typeof query.orderBy !== 'function') {
    throw new Error(`Database automation wake routing requires orderBy(${field}).`);
  }
  return query.orderBy(field, 'asc');
}

async function first<T>(query: TableQuery<T>): Promise<T | null> {
  const result = await query.limit(1).getList();
  return result.items?.[0] ?? null;
}

/**
 * Collapse every schedule mutation in one workspace to one scalar deadline.
 * Definitions and deliveries remain authoritative in the workspace block.
 */
export async function enqueueDatabaseAutomationWorkspaceWake(
  admin: AdminDbAccessor,
  workspaceId: string,
  dueAt = new Date().toISOString(),
): Promise<DatabaseAutomationWorkspaceWake> {
  const requestedAt = parsedTimestamp(dueAt);
  if (!workspaceId || requestedAt === undefined) {
    throw new Error('Database automation wake requires a workspace and valid deadline.');
  }
  const central = admin.db('app');
  const table = queueTable(central);
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
        if (await getExisting(table, workspaceId)) continue;
        throw error;
      }
    }

    const now = Date.now();
    const existingDueAt = parsedTimestamp(existing.dueAt) ?? requestedAt;
    const existingAvailableAt = parsedTimestamp(existing.availableAt) ?? existingDueAt;
    const claimUntil = parsedTimestamp(existing.claimUntil);
    const activeClaim = claimUntil !== undefined && claimUntil > now;
    const hasConcurrentHint = activeClaim
      && claimUntil !== undefined
      && existingDueAt !== claimUntil;
    if (hasConcurrentHint && existingDueAt <= requestedAt) return existing;
    if (!activeClaim && existingDueAt <= requestedAt && existingAvailableAt <= requestedAt) {
      return existing;
    }

    // A claim temporarily replaces dueAt with claimUntil. The first mutation
    // during that claim must change generation even when its real deadline is
    // later, otherwise an older audit that read empty could delete the new
    // schedule. Once dueAt differs from claimUntil it is a superseding hint,
    // and later compatible mutations collapse to the earliest such deadline.
    const nextDueAt = activeClaim && !hasConcurrentHint
      ? requestedAt
      : Math.min(existingDueAt, requestedAt);
    const nextAvailableAt = activeClaim && claimUntil !== undefined
      ? claimUntil
      : Math.min(existingAvailableAt, requestedAt);
    try {
      await central.transact([
        {
          table: DATABASE_AUTOMATION_WAKE_QUEUE_TABLE,
          op: 'expect',
          id: workspaceId,
          where: [['generation', '==', existing.generation]],
          exists: true,
        },
        {
          table: DATABASE_AUTOMATION_WAKE_QUEUE_TABLE,
          op: 'update',
          id: workspaceId,
          data: {
            dueAt: isoAt(nextDueAt),
            availableAt: isoAt(nextAvailableAt),
            claimUntil: activeClaim ? existing.claimUntil ?? null : null,
            generation,
          },
        },
      ] satisfies TransactOperation[]);
      const updated = await getExisting(table, workspaceId);
      if (updated?.generation === generation) return updated;
    } catch (error) {
      if (transactionExpectationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error(`Could not enqueue database automation wake for workspace ${workspaceId}.`);
}

async function readDueQueue(central: DbRef, now: number) {
  let query = requiredComposableQuery(
    queueTable(central).where('availableAt', '<=', isoAt(now)),
    'Database automation due-workspace lookup',
  ).orderBy('availableAt', 'asc');
  query = requiredComposableQuery(
    query,
    'Database automation due-workspace lookup',
  ).orderBy('workspaceId', 'asc');
  const result = await query.limit(MAX_DUE_DATABASE_AUTOMATION_WORKSPACES).getList();
  return result.items ?? [];
}

async function readAuditWorkspaceIds(central: DbRef) {
  const stateTable = central.table<DatabaseAutomationWakeSweepState>(
    DATABASE_AUTOMATION_WAKE_SWEEP_STATE_TABLE,
  );
  const state = await getExisting(stateTable, SWEEP_STATE_ID);
  const cursor = state?.cursorWorkspaceId ?? '';
  const workspaces = central.table<{ id: string }>('workspaces');
  const after = (await ordered(
    workspaces.where('id', '>', cursor),
    'id',
  ).limit(MAX_AUDIT_DATABASE_AUTOMATION_WORKSPACES).getList()).items ?? [];
  const selected = [...after];
  if (selected.length < MAX_AUDIT_DATABASE_AUTOMATION_WORKSPACES && cursor) {
    const before = (await ordered(
      workspaces.where('id', '<=', cursor),
      'id',
    ).limit(MAX_AUDIT_DATABASE_AUTOMATION_WORKSPACES - selected.length).getList()).items ?? [];
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

async function claimWake(
  central: DbRef,
  row: DatabaseAutomationWorkspaceWake,
  now: number,
): Promise<string | null> {
  const existingClaimUntil = parsedTimestamp(row.claimUntil);
  if (existingClaimUntil !== undefined && existingClaimUntil > now) return null;
  const generation = crypto.randomUUID();
  const claimUntil = isoAt(now + WAKE_CLAIM_MS);
  try {
    await central.transact([
      {
        table: DATABASE_AUTOMATION_WAKE_QUEUE_TABLE,
        op: 'expect',
        id: row.id,
        where: [['generation', '==', row.generation]],
        exists: true,
      },
      {
        table: DATABASE_AUTOMATION_WAKE_QUEUE_TABLE,
        op: 'update',
        id: row.id,
        data: {
          dueAt: claimUntil,
          availableAt: claimUntil,
          claimUntil,
          generation,
        },
      },
    ] satisfies TransactOperation[]);
    return generation;
  } catch (error) {
    if (transactionExpectationConflict(error)) return null;
    throw error;
  }
}

/** Select and claim a fixed due window plus a separately reserved audit lane. */
export async function selectDatabaseAutomationWorkspaces(
  admin: AdminDbAccessor,
  now = Date.now(),
): Promise<DatabaseAutomationWakeSelection> {
  const central = admin.db('app');
  const [dueRows, auditWorkspaceIds] = await Promise.all([
    readDueQueue(central, now),
    readAuditWorkspaceIds(central),
  ]);
  const candidates = new Map<string, {
    row?: DatabaseAutomationWorkspaceWake;
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

  const claimed: Array<DatabaseAutomationWorkspaceSelection | null> = await Promise.all(
    Array.from(candidates, async ([workspaceId, candidate]): Promise<
      DatabaseAutomationWorkspaceSelection | null
    > => {
      let row = candidate.row ?? await getExisting(queueTable(central), workspaceId);
      const claimUntil = parsedTimestamp(row?.claimUntil);
      if (claimUntil !== undefined && claimUntil > now) return null;
      if (!row) {
        row = await enqueueDatabaseAutomationWorkspaceWake(admin, workspaceId, isoAt(now));
      }
      const queueGeneration = await claimWake(central, row, now);
      if (!queueGeneration) return null;
      return {
        workspaceId,
        db: boundedDb(admin, workspaceId),
        queueGeneration,
        source: candidate.due && candidate.audit
          ? 'due+audit'
          : candidate.due ? 'due' : 'audit',
      };
    }),
  );

  return {
    workspaces: claimed.filter(
      (entry): entry is DatabaseAutomationWorkspaceSelection => entry !== null,
    ),
    dueCandidates: dueRows.length,
    auditCandidates: auditWorkspaceIds.length,
    wakeBound: MAX_DATABASE_AUTOMATION_WORKSPACE_WAKES,
  };
}

/** Read only the indexed first due row from each workspace-local lane. */
export async function nextWorkspaceDatabaseAutomationDueAt(
  db: DbRef,
  workspaceId: string,
): Promise<string | null> {
  let scheduleQuery = requiredComposableQuery(
    db.table<DatabaseAutomationDefinition>('database_automations')
      .where('triggerType', '==', 'schedule'),
    'Database automation next-schedule lookup',
  ).where('status', '==', 'active');
  scheduleQuery = requiredComposableQuery(
    scheduleQuery,
    'Database automation next-schedule lookup',
  ).where('nextRunAt', '!=', null);
  scheduleQuery = requiredComposableQuery(
    scheduleQuery,
    'Database automation next-schedule lookup',
  ).orderBy('nextRunAt', 'asc');
  scheduleQuery = requiredComposableQuery(
    scheduleQuery,
    'Database automation next-schedule lookup',
  ).orderBy('id', 'asc');

  let deliveryQuery = requiredComposableQuery(
    db.table<DatabaseAutomationDeliveryDeadline>('database_automation_deliveries')
      .where('state', 'in', ['pending', 'retrying']),
    'Database automation next-delivery lookup',
  ).orderBy('nextAttemptAt', 'asc');
  deliveryQuery = requiredComposableQuery(
    deliveryQuery,
    'Database automation next-delivery lookup',
  ).orderBy('id', 'asc');

  const [schedule, delivery] = await Promise.all([
    first(scheduleQuery),
    first(deliveryQuery),
  ]);
  if (schedule && (
    schedule.workspaceId !== workspaceId
    || schedule.triggerType !== 'schedule'
    || schedule.status !== 'active'
    || parsedTimestamp(schedule.nextRunAt) === undefined
  )) throw new Error('Database automation next-schedule query returned invalid data.');
  if (delivery && (
    delivery.workspaceId !== workspaceId
    || (delivery.state !== 'pending' && delivery.state !== 'retrying')
    || parsedTimestamp(delivery.nextAttemptAt) === undefined
  )) throw new Error('Database automation next-delivery query returned invalid data.');
  const deadlines = [schedule?.nextRunAt, delivery?.nextAttemptAt]
    .map(parsedTimestamp)
    .filter((value): value is number => value !== undefined);
  return deadlines.length > 0 ? isoAt(Math.min(...deadlines)) : null;
}

/** Settle only the generation selected by this run; a newer hint wins. */
export async function settleDatabaseAutomationWorkspaceWake(
  admin: AdminDbAccessor,
  workspaceId: string,
  queueGeneration: string,
  nextDueAt: string | null,
  _now = Date.now(),
): Promise<'updated' | 'deleted' | 'superseded'> {
  let normalizedDueAt: string | null = null;
  if (nextDueAt !== null) {
    const due = parsedTimestamp(nextDueAt);
    if (due === undefined) {
      throw new Error('Database automation wake settlement requires a valid deadline.');
    }
    normalizedDueAt = isoAt(due);
  }
  const central = admin.db('app');
  try {
    await central.transact([
      {
        table: DATABASE_AUTOMATION_WAKE_QUEUE_TABLE,
        op: 'expect',
        id: workspaceId,
        where: [['generation', '==', queueGeneration]],
        exists: true,
      },
      normalizedDueAt === null
        ? {
            table: DATABASE_AUTOMATION_WAKE_QUEUE_TABLE,
            op: 'delete',
            id: workspaceId,
          }
        : {
            table: DATABASE_AUTOMATION_WAKE_QUEUE_TABLE,
            op: 'update',
            id: workspaceId,
            data: {
              dueAt: normalizedDueAt,
              availableAt: normalizedDueAt,
              claimUntil: null,
            },
          },
    ] satisfies TransactOperation[]);
    return normalizedDueAt === null ? 'deleted' : 'updated';
  } catch (error) {
    if (transactionExpectationConflict(error)) return 'superseded';
    throw error;
  }
}
