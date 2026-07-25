import {
  databaseAutomationScheduleActionDocument,
  MAX_AUTOMATION_ACTIONS,
} from './automation-actions';
import {
  automationDeliveryRecord,
  isAutomationDeliveryAction,
} from './automation-delivery-planning';
import {
  nextDatabaseAutomationScheduleRun,
  type DatabaseAutomationDailyScheduleTrigger,
} from './database-automation-schedule';
import type { DatabaseAutomationDefinition, DbRef, Page } from './app-types';
import {
  getExisting,
  newId,
  nowIso,
  type TableQuery,
  type TransactOperation,
} from './table-utils';

export const MAX_DATABASE_AUTOMATION_SCHEDULES_PER_PASS = 8;

const SCHEDULE_WORKER_ID = 'database-automation-schedules';
const SCHEDULE_LEASE_MS = 30_000;
const MAX_SCHEDULE_TRANSACTION_OPS = 360;

interface DatabaseAutomationScheduleWorker {
  id: string;
  workspaceId: string;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  cursorNextRunAt?: string | null;
  cursorAutomationId?: string | null;
}

export interface DatabaseAutomationSchedulePassResult {
  processedSchedules: number;
  deliveries: number;
  hasMore: boolean;
  busy?: boolean;
}

function scheduleError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function transactionConflict(error: unknown) {
  return error instanceof Error && error.message.includes('Transaction expectation failed');
}

function timestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw scheduleError(409, `${label} has an invalid timestamp.`);
  return parsed;
}

function requiredComposableQuery<T>(query: TableQuery<T>, label: string) {
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw scheduleError(500, `${label} requires bounded filtered keyset queries.`);
  }
  return query as TableQuery<T> & {
    where(field: string, op: string, value: unknown): TableQuery<T>;
    orderBy(field: string, direction: 'asc' | 'desc'): TableQuery<T>;
  };
}

function scheduleOrder(
  left: DatabaseAutomationDefinition,
  right: DatabaseAutomationDefinition,
) {
  return String(left.nextRunAt).localeCompare(String(right.nextRunAt))
    || left.id.localeCompare(right.id);
}

async function claimScheduleWorker(db: DbRef, workspaceId: string) {
  const workers = db.table<DatabaseAutomationScheduleWorker>('database_automation_schedule_workers');
  const current = await getExisting(workers, SCHEDULE_WORKER_ID);
  const claimedAt = Date.now();
  if (current?.leaseUntil && timestamp(current.leaseUntil, 'Automation schedule worker lease') > claimedAt) {
    return null;
  }
  const leaseToken = newId();
  const leaseUntil = new Date(claimedAt + SCHEDULE_LEASE_MS).toISOString();
  const operations: TransactOperation[] = current
    ? [
        {
          table: 'database_automation_schedule_workers',
          op: 'expect',
          id: SCHEDULE_WORKER_ID,
          where: [
            ['workspaceId', '==', workspaceId],
            ['leaseToken', '==', current.leaseToken ?? null],
            ['leaseUntil', '==', current.leaseUntil ?? null],
          ],
          exists: true,
        },
        {
          table: 'database_automation_schedule_workers',
          op: 'update',
          id: SCHEDULE_WORKER_ID,
          data: { leaseToken, leaseUntil },
        },
      ]
    : [
        { table: 'database_automation_schedule_workers', op: 'expect', id: SCHEDULE_WORKER_ID, exists: false },
        {
          table: 'database_automation_schedule_workers',
          op: 'insert',
          data: {
            id: SCHEDULE_WORKER_ID,
            workspaceId,
            leaseToken,
            leaseUntil,
            cursorNextRunAt: null,
            cursorAutomationId: null,
          },
        },
      ];
  try {
    await db.transact(operations);
    return { leaseToken };
  } catch (error) {
    if (transactionConflict(error)) return null;
    throw error;
  }
}

async function releaseScheduleWorker(db: DbRef, leaseToken: string) {
  try {
    await db.transact([
      {
        table: 'database_automation_schedule_workers',
        op: 'expect',
        id: SCHEDULE_WORKER_ID,
        where: [['leaseToken', '==', leaseToken]],
        exists: true,
      },
      {
        table: 'database_automation_schedule_workers',
        op: 'update',
        id: SCHEDULE_WORKER_ID,
        data: { leaseToken: null, leaseUntil: null },
      },
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
  }
}

async function dueSchedules(db: DbRef, workspaceId: string, dueAt: string) {
  let query = requiredComposableQuery(
    db.table<DatabaseAutomationDefinition>('database_automations')
      .where('triggerType', '==', 'schedule'),
    'Database automation due-schedule lookup',
  ).where('status', '==', 'active');
  query = requiredComposableQuery(query, 'Database automation due-schedule lookup')
    .where('nextRunAt', '<=', dueAt);
  query = requiredComposableQuery(query, 'Database automation due-schedule lookup')
    .orderBy('nextRunAt', 'asc');
  query = requiredComposableQuery(query, 'Database automation due-schedule lookup')
    .orderBy('id', 'asc');
  const page = await query.limit(MAX_DATABASE_AUTOMATION_SCHEDULES_PER_PASS + 1).getList();
  const items = page.items ?? [];
  if (items.some((definition) => (
    definition.workspaceId !== workspaceId
    || definition.triggerType !== 'schedule'
    || definition.status !== 'active'
    || definition.enabled !== true
    || typeof definition.nextRunAt !== 'string'
    || definition.nextRunAt > dueAt
  ))) {
    throw scheduleError(409, 'Database automation due-schedule query returned invalid data.');
  }
  items.sort(scheduleOrder);
  return {
    definitions: items.slice(0, MAX_DATABASE_AUTOMATION_SCHEDULES_PER_PASS),
    hasMore: Boolean(page.hasMore) || items.length > MAX_DATABASE_AUTOMATION_SCHEDULES_PER_PASS,
  };
}

function deliveryActions(definition: DatabaseAutomationDefinition) {
  try {
    const document = databaseAutomationScheduleActionDocument(definition.actionDocument);
    if (document.actions.length > MAX_AUTOMATION_ACTIONS) throw new Error('too many actions');
    const actions = document.actions.filter(isAutomationDeliveryAction);
    if (actions.length !== document.actions.length) throw new Error('unsupported local action');
    return actions;
  } catch {
    throw scheduleError(409, `Automation schedule ${definition.id} has invalid actions.`);
  }
}

export async function processDatabaseAutomationSchedulePass(
  db: DbRef,
  workspaceId: string,
): Promise<DatabaseAutomationSchedulePassResult> {
  const claim = await claimScheduleWorker(db, workspaceId);
  if (!claim) return { processedSchedules: 0, deliveries: 0, hasMore: true, busy: true };
  let released = false;
  try {
    const processedAt = nowIso();
    const due = await dueSchedules(db, workspaceId, processedAt);
    if (due.definitions.length === 0) {
      await releaseScheduleWorker(db, claim.leaseToken);
      released = true;
      return { processedSchedules: 0, deliveries: 0, hasMore: false };
    }

    const databaseIds = Array.from(new Set(due.definitions.map((definition) => definition.databaseId)));
    const databasePage = await db.table<Page>('pages')
      .where('id', 'in', databaseIds)
      .limit(databaseIds.length + 1)
      .getList();
    const databases = new Map((databasePage.items ?? []).map((database) => [database.id, database]));
    if (databasePage.hasMore || databases.size !== databaseIds.length || databaseIds.some((databaseId) => {
      const database = databases.get(databaseId);
      return !database
        || database.workspaceId !== workspaceId
        || database.kind !== 'database'
        || Boolean(database.inTrash)
        || Boolean(database.isLocked);
    })) throw scheduleError(409, 'Automation schedule database authority changed.');

    const plans = await Promise.all(due.definitions.map(async (definition) => {
      const scheduledFor = definition.nextRunAt!;
      const trigger = definition.trigger as unknown as DatabaseAutomationDailyScheduleTrigger;
      if (trigger.type !== 'schedule' || trigger.frequency !== 'daily') {
        throw scheduleError(409, `Automation schedule ${definition.id} has an invalid trigger.`);
      }
      const nextRunAt = nextDatabaseAutomationScheduleRun(trigger, scheduledFor);
      const deliveries = await Promise.all(deliveryActions(definition).map((action) => (
        automationDeliveryRecord({
          action,
          workspaceId,
          ownerPageId: definition.databaseId,
          sourceType: 'database_automation',
          sourceId: definition.id,
          databaseId: definition.databaseId,
          automationId: definition.id,
          automationRevision: definition.revision,
          scheduledFor,
        })
      )));
      return { definition, scheduledFor, nextRunAt, deliveries };
    }));

    const last = due.definitions.at(-1)!;
    const operations: TransactOperation[] = [
      {
        table: 'database_automation_schedule_workers',
        op: 'expect',
        id: SCHEDULE_WORKER_ID,
        where: [['leaseToken', '==', claim.leaseToken]],
        exists: true,
      },
      ...databaseIds.map((databaseId): TransactOperation => {
        const database = databases.get(databaseId)!;
        return {
          table: 'pages',
          op: 'expect',
          id: databaseId,
          where: [
            ['workspaceId', '==', workspaceId],
            ['kind', '==', 'database'],
            ['inTrash', '==', database.inTrash ?? false],
            ['isLocked', '==', database.isLocked ?? false],
            ['updatedAt', '==', database.updatedAt ?? null],
          ],
          exists: true,
        };
      }),
      ...plans.flatMap(({ definition, nextRunAt, deliveries }): TransactOperation[] => [
        {
          table: 'database_automations',
          op: 'expect',
          id: definition.id,
          where: [
            ['workspaceId', '==', workspaceId],
            ['databaseId', '==', definition.databaseId],
            ['triggerType', '==', 'schedule'],
            ['enabled', '==', true],
            ['status', '==', 'active'],
            ['revision', '==', definition.revision],
            ['nextRunAt', '==', definition.nextRunAt!],
          ],
          exists: true,
        },
        {
          table: 'database_automations',
          op: 'update',
          id: definition.id,
          data: { nextRunAt, updatedAt: processedAt },
        },
        ...deliveries.flatMap((delivery): TransactOperation[] => [
          { table: 'database_automation_deliveries', op: 'expect', id: delivery.id, exists: false },
          {
            table: 'database_automation_deliveries',
            op: 'insert',
            data: delivery as unknown as Record<string, unknown>,
          },
        ]),
      ]),
      {
        table: 'database_automation_schedule_workers',
        op: 'update',
        id: SCHEDULE_WORKER_ID,
        data: {
          leaseToken: null,
          leaseUntil: null,
          cursorNextRunAt: last.nextRunAt,
          cursorAutomationId: last.id,
        },
      },
    ];
    if (operations.length > MAX_SCHEDULE_TRANSACTION_OPS) {
      throw scheduleError(413, 'Database automation schedule pass exceeds its transaction bound.');
    }
    try {
      await db.transact(operations);
    } catch (error) {
      if (!transactionConflict(error)) throw error;
      throw scheduleError(409, 'Automation schedule changed while it was being processed.');
    }
    released = true;
    const deliveries = plans.reduce((count, plan) => count + plan.deliveries.length, 0);
    const catchupRemains = plans.some((plan) => plan.nextRunAt !== null && plan.nextRunAt <= processedAt);
    return {
      processedSchedules: plans.length,
      deliveries,
      hasMore: due.hasMore || catchupRemains,
    };
  } finally {
    if (!released) await releaseScheduleWorker(db, claim.leaseToken);
  }
}
