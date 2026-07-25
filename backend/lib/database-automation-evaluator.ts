import {
  applyTriggerPagePropertyActions,
  assertAutomationResultBound,
  automationRequestHash,
  type DatabaseButtonActionDocument,
} from './automation-actions';
import type {
  AutomationExecutionReceipt,
  DatabaseAutomationDefinition,
  DbProperty,
  DbRef,
  DbView,
  Page,
} from './app-types';
import { databasePropertyIndexRecord, type DbPropertyIndex } from './database-index';
import { assertOrganizationDlpContent } from './enterprise-controls';
import {
  getExisting,
  newId,
  nowIso,
  type TableQuery,
  type TransactOperation,
} from './table-utils';
import {
  effectiveFilterGroup,
  matchesFilterGroup,
  type QueryAdapters,
  type QueryPage,
  type QueryProperty,
  type QueryViewConfig,
} from '../../shared/database/query-core';

export const MAX_DATABASE_AUTOMATION_EVENTS_PER_PASS = 32;
export const MAX_DATABASE_AUTOMATIONS_PER_DATABASE = 20;

const DATABASE_AUTOMATION_WINDOW_MS = 3_000;
const DATABASE_AUTOMATION_LEASE_MS = 30_000;
const MAX_DATABASE_AUTOMATION_PROPERTIES = 100;
const MAX_DATABASE_AUTOMATION_TRANSACTION_OPS = 450;
const WORKER_ID = 'database-automation-events';

interface DatabaseAutomationEvent {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  triggerKind: 'row_added' | 'properties_edited';
  origin: 'user' | 'button' | 'automation';
  mutationId: string;
  changedPropertyIds: string[];
  occurredAt: string;
  state: 'pending' | 'processed';
}

interface DatabaseAutomationWorker {
  id: string;
  workspaceId: string;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  cursorOccurredAt?: string | null;
  cursorEventId?: string | null;
}

export interface DatabaseAutomationEventPassResult {
  processedEvents: number;
  executions: number;
  pausedAutomations?: number;
  hasMore: boolean;
  busy?: boolean;
}

function evaluatorError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function transactionConflict(error: unknown) {
  return error instanceof Error && error.message.includes('Transaction expectation failed');
}

function requiredComposableQuery<T>(query: TableQuery<T>, label: string) {
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw evaluatorError(500, `${label} requires bounded filtered keyset queries.`);
  }
  return query as TableQuery<T> & {
    where(field: string, op: string, value: unknown): TableQuery<T>;
    orderBy(field: string, direction: 'asc' | 'desc'): TableQuery<T>;
  };
}

function timestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw evaluatorError(409, `${label} has an invalid timestamp.`);
  return parsed;
}

function eventOrder(left: DatabaseAutomationEvent, right: DatabaseAutomationEvent) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function validPendingEvent(
  event: DatabaseAutomationEvent,
  workspaceId: string,
) {
  return event.workspaceId === workspaceId
    && event.state === 'pending'
    && typeof event.databaseId === 'string'
    && typeof event.rowId === 'string'
    && typeof event.occurredAt === 'string';
}

async function claimWorker(db: DbRef, workspaceId: string) {
  const workers = db.table<DatabaseAutomationWorker>('database_automation_event_workers');
  const current = await getExisting(workers, WORKER_ID);
  const claimedAt = Date.now();
  if (current?.leaseUntil && timestamp(current.leaseUntil, 'Automation worker lease') > claimedAt) {
    return null;
  }
  const leaseToken = newId();
  const leaseUntil = new Date(claimedAt + DATABASE_AUTOMATION_LEASE_MS).toISOString();
  const operations: TransactOperation[] = current
    ? [
        {
          table: 'database_automation_event_workers',
          op: 'expect',
          id: WORKER_ID,
          where: [
            ['workspaceId', '==', workspaceId],
            ['leaseToken', '==', current.leaseToken ?? null],
            ['leaseUntil', '==', current.leaseUntil ?? null],
          ],
          exists: true,
        },
        {
          table: 'database_automation_event_workers',
          op: 'update',
          id: WORKER_ID,
          data: { leaseToken, leaseUntil },
        },
      ]
    : [
        { table: 'database_automation_event_workers', op: 'expect', id: WORKER_ID, exists: false },
        {
          table: 'database_automation_event_workers',
          op: 'insert',
          data: {
            id: WORKER_ID,
            workspaceId,
            leaseToken,
            leaseUntil,
            cursorOccurredAt: null,
            cursorEventId: null,
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

async function releaseWorker(db: DbRef, leaseToken: string) {
  try {
    await db.transact([
      {
        table: 'database_automation_event_workers',
        op: 'expect',
        id: WORKER_ID,
        where: [['leaseToken', '==', leaseToken]],
        exists: true,
      },
      {
        table: 'database_automation_event_workers',
        op: 'update',
        id: WORKER_ID,
        data: { leaseToken: null, leaseUntil: null },
      },
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
  }
}

async function dueEvents(
  db: DbRef,
  workspaceId: string,
  now: number,
) {
  const cutoff = new Date(now - DATABASE_AUTOMATION_WINDOW_MS).toISOString();
  let query = requiredComposableQuery(
    db.table<DatabaseAutomationEvent>('database_automation_events')
      .where('state', '==', 'pending'),
    'Database automation due-event lookup',
  ).where('occurredAt', '<=', cutoff);
  query = requiredComposableQuery(query, 'Database automation due-event lookup')
    .orderBy('occurredAt', 'asc');
  query = requiredComposableQuery(query, 'Database automation due-event lookup')
    .orderBy('id', 'asc');
  const page = await query.limit(MAX_DATABASE_AUTOMATION_EVENTS_PER_PASS + 1).getList();
  const items = page.items ?? [];
  if (items.some((event) => !validPendingEvent(event, workspaceId))) {
    throw evaluatorError(409, 'Database automation due-event query returned invalid data.');
  }
  items.sort(eventOrder);
  return {
    events: items.slice(0, MAX_DATABASE_AUTOMATION_EVENTS_PER_PASS),
    hasMore: Boolean(page.hasMore) || items.length > MAX_DATABASE_AUTOMATION_EVENTS_PER_PASS,
  };
}

async function activeDefinitions(db: DbRef, databaseId: string) {
  let query = requiredComposableQuery(
    db.table<DatabaseAutomationDefinition>('database_automations')
      .where('databaseId', '==', databaseId),
    'Database automation definition lookup',
  ).where('triggerType', '==', 'events');
  query = requiredComposableQuery(query, 'Database automation definition lookup')
    .where('enabled', '==', true);
  query = requiredComposableQuery(query, 'Database automation definition lookup')
    .where('status', '==', 'active');
  query = requiredComposableQuery(query, 'Database automation definition lookup')
    .orderBy('id', 'asc');
  const page = await query.limit(MAX_DATABASE_AUTOMATIONS_PER_DATABASE + 1).getList();
  const definitions = page.items ?? [];
  if (definitions.some((definition) => (
    definition.databaseId !== databaseId
    || definition.triggerType !== 'events'
    || definition.enabled !== true
    || definition.status !== 'active'
  ))) {
    throw evaluatorError(409, 'Database automation definition query returned invalid data.');
  }
  definitions.sort((left, right) => left.id.localeCompare(right.id));
  if (page.hasMore || definitions.length > MAX_DATABASE_AUTOMATIONS_PER_DATABASE) {
    throw evaluatorError(
      409,
      `A database supports at most ${MAX_DATABASE_AUTOMATIONS_PER_DATABASE} automation definitions.`,
    );
  }
  return definitions;
}

async function pendingWindow(
  db: DbRef,
  workspaceId: string,
  anchor: DatabaseAutomationEvent,
) {
  const start = timestamp(anchor.occurredAt, 'Automation event');
  const end = new Date(start + DATABASE_AUTOMATION_WINDOW_MS).toISOString();
  let query = requiredComposableQuery(
    db.table<DatabaseAutomationEvent>('database_automation_events')
      .where('databaseId', '==', anchor.databaseId),
    'Database automation row-window lookup',
  ).where('rowId', '==', anchor.rowId);
  query = requiredComposableQuery(query, 'Database automation row-window lookup')
    .where('state', '==', 'pending');
  query = requiredComposableQuery(query, 'Database automation row-window lookup')
    .where('occurredAt', '>=', anchor.occurredAt);
  query = requiredComposableQuery(query, 'Database automation row-window lookup')
    .where('occurredAt', '<=', end);
  query = requiredComposableQuery(query, 'Database automation row-window lookup')
    .orderBy('occurredAt', 'asc');
  query = requiredComposableQuery(query, 'Database automation row-window lookup')
    .orderBy('id', 'asc');
  const page = await query.limit(MAX_DATABASE_AUTOMATION_EVENTS_PER_PASS + 1).getList();
  const events = page.items ?? [];
  if (events.some((event) => (
    !validPendingEvent(event, workspaceId)
    || event.databaseId !== anchor.databaseId
    || event.rowId !== anchor.rowId
    || timestamp(event.occurredAt, 'Automation event') < start
    || timestamp(event.occurredAt, 'Automation event') > start + DATABASE_AUTOMATION_WINDOW_MS
  ))) {
    throw evaluatorError(409, 'Database automation row-window query returned invalid data.');
  }
  events.sort(eventOrder);
  if (!events.some((event) => event.id === anchor.id)) {
    throw evaluatorError(409, 'Automation event window lost its anchor event.');
  }
  return {
    events: events.slice(0, MAX_DATABASE_AUTOMATION_EVENTS_PER_PASS),
    hasMore: Boolean(page.hasMore) || events.length > MAX_DATABASE_AUTOMATION_EVENTS_PER_PASS,
  };
}

function eventMatchesCondition(
  event: DatabaseAutomationEvent,
  condition: { type?: unknown; propertyId?: unknown },
) {
  if (event.origin !== 'user' && event.origin !== 'button') return false;
  if (condition.type === 'row_added') return event.triggerKind === 'row_added';
  return condition.type === 'property_edited'
    && typeof condition.propertyId === 'string'
    && event.triggerKind === 'properties_edited'
    && event.changedPropertyIds.includes(condition.propertyId);
}

function runtimeFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : 'Automation action failed.';
  return (message.replace(/\s+/g, ' ').trim() || 'Automation action failed.').slice(0, 1_000);
}

function definitionMatchesWindow(
  definition: DatabaseAutomationDefinition,
  events: DatabaseAutomationEvent[],
) {
  const trigger = definition.trigger as {
    type?: unknown;
    mode?: unknown;
    conditions?: unknown;
  };
  if (
    trigger.type !== 'events'
    || (trigger.mode !== 'any' && trigger.mode !== 'all')
    || !Array.isArray(trigger.conditions)
    || trigger.conditions.length === 0
  ) {
    throw evaluatorError(409, `Automation definition ${definition.id} has an invalid event trigger.`);
  }
  const matches = trigger.conditions.map((condition) => {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
    return events.some((event) => eventMatchesCondition(
      event,
      condition as { type?: unknown; propertyId?: unknown },
    ));
  });
  return trigger.mode === 'all' ? matches.every(Boolean) : matches.some(Boolean);
}

function rawCellValue(row: QueryPage, property: QueryProperty) {
  const page = row as Page;
  if (property.type === 'title') return page.title ?? '';
  if (property.type === 'created_time') return page.createdAt ?? '';
  if (property.type === 'last_edited_time') return page.updatedAt ?? '';
  if (property.type === 'created_by') return page.createdBy ?? '';
  if (property.type === 'last_edited_by') return page.lastEditedBy ?? '';
  return page.properties?.[property.id];
}

function rawText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(rawText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return rawText(record.name ?? record.label ?? record.text ?? record.id ?? '');
  }
  return String(value);
}

function rawIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === 'string') return item ? [item] : [];
    if (!item || typeof item !== 'object') return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === 'string' && id ? [id] : [];
  });
}

function viewMatchesRow(
  row: Page,
  view: DbView,
  properties: DbProperty[],
) {
  const byId = new Map(properties.map((property) => [property.id, property]));
  const group = effectiveFilterGroup(
    view.config as QueryViewConfig | undefined,
    byId as unknown as Map<string, QueryProperty>,
  );
  if (!group) return true;
  const adapters: QueryAdapters = {
    cellValue: rawCellValue,
    displayText: (page, property) => rawText(rawCellValue(page, property)),
    asText: rawText,
    personIds: rawIds,
    rollupTargetIds: (page, property) => rawIds(rawCellValue(page, property)),
  };
  return matchesFilterGroup(
    row as unknown as QueryPage,
    group,
    adapters,
    byId as unknown as Map<string, QueryProperty>,
  );
}

function settleEventOperations(events: DatabaseAutomationEvent[]): TransactOperation[] {
  return events.flatMap((event): TransactOperation[] => [
    {
      table: 'database_automation_events',
      op: 'expect',
      id: event.id,
      where: [
        ['workspaceId', '==', event.workspaceId],
        ['databaseId', '==', event.databaseId],
        ['rowId', '==', event.rowId],
        ['state', '==', 'pending'],
      ],
      exists: true,
    },
    {
      table: 'database_automation_events',
      op: 'update',
      id: event.id,
      data: { state: 'processed' },
    },
  ]);
}

function releaseWorkerOperation(
  event: DatabaseAutomationEvent,
): TransactOperation {
  return {
    table: 'database_automation_event_workers',
    op: 'update',
    id: WORKER_ID,
    data: {
      leaseToken: null,
      leaseUntil: null,
      cursorOccurredAt: event.occurredAt,
      cursorEventId: event.id,
    },
  };
}

async function settleWithoutDefinitions(
  db: DbRef,
  leaseToken: string,
  events: DatabaseAutomationEvent[],
  hasMore: boolean,
): Promise<DatabaseAutomationEventPassResult> {
  const last = events.at(-1)!;
  const operations: TransactOperation[] = [
    {
      table: 'database_automation_event_workers',
      op: 'expect',
      id: WORKER_ID,
      where: [['leaseToken', '==', leaseToken]],
      exists: true,
    },
    ...settleEventOperations(events),
    releaseWorkerOperation(last),
  ];
  await db.transact(operations);
  return { processedEvents: events.length, executions: 0, hasMore };
}

export async function processDatabaseAutomationEventPass(
  db: DbRef,
  workspaceId: string,
): Promise<DatabaseAutomationEventPassResult> {
  const claim = await claimWorker(db, workspaceId);
  if (!claim) return { processedEvents: 0, executions: 0, hasMore: true, busy: true };
  let released = false;
  try {
    const due = await dueEvents(db, workspaceId, Date.now());
    if (due.events.length === 0) {
      await releaseWorker(db, claim.leaseToken);
      released = true;
      return { processedEvents: 0, executions: 0, hasMore: false };
    }

    const databaseId = due.events[0].databaseId;
    const sameDatabaseDue = due.events.filter((event) => event.databaseId === databaseId);
    const definitions = await activeDefinitions(db, databaseId);
    const hasOtherDatabaseDue = sameDatabaseDue.length !== due.events.length;
    if (definitions.length === 0) {
      const result = await settleWithoutDefinitions(
        db,
        claim.leaseToken,
        sameDatabaseDue,
        due.hasMore || hasOtherDatabaseDue,
      );
      released = true;
      return result;
    }

    const anchor = sameDatabaseDue[0];
    const window = await pendingWindow(db, workspaceId, anchor);
    const selectedIds = new Set(window.events.map((event) => event.id));
    const hasUnselectedDue = due.events.some((event) => !selectedIds.has(event.id));
    const continuationRequired = due.hasMore
      || hasOtherDatabaseDue
      || hasUnselectedDue
      || window.hasMore;
    if (!window.events.some((event) => event.origin === 'user' || event.origin === 'button')) {
      const result = await settleWithoutDefinitions(
        db,
        claim.leaseToken,
        window.events,
        continuationRequired,
      );
      released = true;
      return result;
    }
    const viewIds = Array.from(new Set(definitions.flatMap((definition) => (
      definition.scopeType === 'view' && typeof definition.viewId === 'string'
        ? [definition.viewId]
        : []
    ))));
    const pages = db.table<Page>('pages');
    const propertiesTable = db.table<DbProperty>('db_properties');
    const viewsTable = db.table<DbView>('db_views');
    const [pageRows, propertyPage, viewPage] = await Promise.all([
      pages.where('id', 'in', [databaseId, anchor.rowId]).limit(2).getList(),
      propertiesTable.where('databaseId', '==', databaseId)
        .limit(MAX_DATABASE_AUTOMATION_PROPERTIES + 1).getList(),
      viewIds.length > 0
        ? viewsTable.where('id', 'in', viewIds).limit(viewIds.length + 1).getList()
        : Promise.resolve({ items: [] as DbView[], hasMore: false }),
    ]);
    const database = (pageRows.items ?? []).find((page) => page.id === databaseId);
    const row = (pageRows.items ?? []).find((page) => page.id === anchor.rowId);
    if (!database || database.workspaceId !== workspaceId || database.kind !== 'database') {
      throw evaluatorError(409, 'Automation event database was not found.');
    }
    if (
      !row
      || row.workspaceId !== workspaceId
      || row.parentId !== databaseId
      || row.parentType !== 'database'
      || row.kind === 'database'
    ) {
      throw evaluatorError(409, 'Automation event row was not found.');
    }
    const properties = (propertyPage.items ?? [])
      .filter((property) => property.databaseId === databaseId);
    if (
      propertyPage.hasMore
      || properties.length > MAX_DATABASE_AUTOMATION_PROPERTIES
      || properties.length !== (propertyPage.items ?? []).length
    ) {
      throw evaluatorError(
        409,
        `Database automation evaluation supports at most ${MAX_DATABASE_AUTOMATION_PROPERTIES} properties.`,
      );
    }
    const views = new Map((viewPage.items ?? [])
      .filter((view) => view.databaseId === databaseId)
      .map((view) => [view.id, view]));
    if (viewPage.hasMore || views.size !== viewIds.length) {
      throw evaluatorError(409, 'An automation definition view was not found.');
    }

    const matched = definitions.filter((definition) => {
      if (!definitionMatchesWindow(definition, window.events)) return false;
      if (definition.scopeType === 'database') return true;
      if (definition.scopeType !== 'view' || typeof definition.viewId !== 'string') {
        throw evaluatorError(409, `Automation definition ${definition.id} has an invalid view scope.`);
      }
      const view = views.get(definition.viewId);
      if (!view) throw evaluatorError(409, `Automation definition ${definition.id} view was not found.`);
      return viewMatchesRow(row, view, properties);
    });
    const eventIds = window.events.map((event) => event.id).sort();
    const receiptPlans = await Promise.all(matched.map(async (definition) => {
      const id = await automationRequestHash({
        databaseId,
        definitionId: definition.id,
        definitionRevision: definition.revision,
        eventIds,
        rowId: row.id,
      });
      return { definition, id };
    }));
    const receiptTable = db.table<AutomationExecutionReceipt>('automation_execution_receipts');
    const receiptPage = receiptPlans.length > 0
      ? await receiptTable.where('id', 'in', receiptPlans.map((plan) => plan.id))
        .limit(receiptPlans.length + 1).getList()
      : { items: [] as AutomationExecutionReceipt[], hasMore: false };
    if (receiptPage.hasMore || (receiptPage.items ?? []).length > receiptPlans.length) {
      throw evaluatorError(409, 'Automation receipt lookup exceeded its bound.');
    }
    const existingReceiptIds = new Set((receiptPage.items ?? []).map((receipt) => receipt.id));
    const candidatePlans = receiptPlans.filter((plan) => !existingReceiptIds.has(plan.id));
    const executedAt = nowIso();
    let updatedRow: Page = structuredClone(row);
    const changedPropertyIds = new Set<string>();
    let successfulPlans: typeof candidatePlans = [];
    const failedPlans: Array<(typeof candidatePlans)[number] & { reason: string }> = [];
    for (const plan of candidatePlans) {
      try {
        const applied = applyTriggerPagePropertyActions(
          plan.definition.actionDocument as unknown as DatabaseButtonActionDocument,
          properties,
          updatedRow,
          executedAt,
        );
        updatedRow = {
          ...updatedRow,
          title: applied.title,
          properties: applied.properties,
        };
        for (const propertyId of applied.changedPropertyIds) changedPropertyIds.add(propertyId);
        successfulPlans.push(plan);
      } catch (error) {
        failedPlans.push({ ...plan, reason: runtimeFailureReason(error) });
      }
    }
    if (successfulPlans.length > 0) {
      updatedRow = {
        ...updatedRow,
        lastMutationId: `automation:${successfulPlans.at(-1)!.id}`,
        updatedAt: executedAt,
      };
      try {
        await assertOrganizationDlpContent(db, {
          title: updatedRow.title,
          properties: updatedRow.properties,
        });
      } catch (error) {
        const reason = runtimeFailureReason(error);
        failedPlans.push(...successfulPlans.map((plan) => ({ ...plan, reason })));
        successfulPlans = [];
        updatedRow = structuredClone(row);
        changedPropertyIds.clear();
      }
    }
    const changedIds = Array.from(changedPropertyIds).sort();

    const indexTable = db.table<DbPropertyIndex>('db_property_indexes');
    const indexPage = changedIds.length > 0
      ? await requiredComposableQuery(
          indexTable.where('rowId', '==', row.id),
          'Database automation property-index lookup',
        ).where('propertyId', 'in', changedIds)
        .limit(changedIds.length + 1).getList()
      : { items: [] as DbPropertyIndex[], hasMore: false };
    if (indexPage.hasMore || (indexPage.items ?? []).length > changedIds.length) {
      throw evaluatorError(409, 'Automation property-index lookup exceeded its bound.');
    }
    const existingIndexes = new Map((indexPage.items ?? []).map((index) => [index.propertyId, index]));
    const propertiesById = new Map(properties.map((property) => [property.id, property]));
    const indexOperations = changedIds.flatMap((propertyId): TransactOperation[] => {
      const property = propertiesById.get(propertyId);
      if (!property) throw evaluatorError(409, `Automation action property was not found: ${propertyId}.`);
      const existing = existingIndexes.get(propertyId);
      const id = existing?.id ?? newId();
      const data = JSON.parse(JSON.stringify(
        databasePropertyIndexRecord(updatedRow, property, id),
      )) as Record<string, unknown>;
      return existing
        ? [
            {
              table: 'db_property_indexes',
              op: 'expect',
              id,
              where: [
                ['rowId', '==', row.id],
                ['propertyId', '==', propertyId],
                ['updatedAt', '==', existing.updatedAt ?? null],
              ],
              exists: true,
            },
            { table: 'db_property_indexes', op: 'update', id, data },
          ]
        : [
            { table: 'db_property_indexes', op: 'expect', id, exists: false },
            { table: 'db_property_indexes', op: 'insert', data },
          ];
    });
    const receipts: AutomationExecutionReceipt[] = successfulPlans.map(({ definition, id }) => {
      const result = {
        changedPropertyIds: changedIds,
        definitionRevision: definition.revision,
        eventIds,
        rowId: row.id,
        updatedAt: updatedRow.updatedAt,
      };
      assertAutomationResultBound(result);
      return {
        id,
        workspaceId,
        databaseId,
        sourceType: 'database_automation',
        sourceId: definition.id,
        triggerPageId: row.id,
        requestedBy: 'system:database-automation',
        requestHash: id,
        status: 'succeeded',
        result,
      };
    });
    const definitionExpectations: TransactOperation[] = definitions.map((definition) => ({
      table: 'database_automations',
      op: 'expect',
      id: definition.id,
      where: [
        ['databaseId', '==', databaseId],
        ['enabled', '==', true],
        ['status', '==', 'active'],
        ['revision', '==', definition.revision],
      ],
      exists: true,
    }));
    const pauseOperations: TransactOperation[] = failedPlans.map(({ definition, reason }) => ({
      table: 'database_automations',
      op: 'update',
      id: definition.id,
      data: {
        status: 'paused',
        pausedAt: executedAt,
        pausedReason: reason,
        updatedAt: executedAt,
      },
    }));
    const viewExpectations: TransactOperation[] = Array.from(views.values()).map((view) => ({
      table: 'db_views',
      op: 'expect',
      id: view.id,
      where: [
        ['databaseId', '==', databaseId],
        ['updatedAt', '==', view.updatedAt ?? null],
      ],
      exists: true,
    }));
    const propertyExpectations: TransactOperation[] = properties.map((property) => ({
      table: 'db_properties',
      op: 'expect',
      id: property.id,
      where: [
        ['databaseId', '==', databaseId],
        ['type', '==', property.type],
        ['updatedAt', '==', property.updatedAt ?? null],
      ],
      exists: true,
    }));
    const lastEvent = window.events.at(-1)!;
    const operations: TransactOperation[] = [
      {
        table: 'database_automation_event_workers',
        op: 'expect',
        id: WORKER_ID,
        where: [['leaseToken', '==', claim.leaseToken]],
        exists: true,
      },
      {
        table: 'pages',
        op: 'expect',
        id: databaseId,
        where: [
          ['workspaceId', '==', workspaceId],
          ['kind', '==', 'database'],
          ['updatedAt', '==', database.updatedAt ?? null],
        ],
        exists: true,
      },
      ...definitionExpectations,
      ...pauseOperations,
      ...viewExpectations,
      ...propertyExpectations,
      {
        table: 'pages',
        op: 'expect',
        id: row.id,
        where: [
          ['parentId', '==', databaseId],
          ['parentType', '==', 'database'],
          ['updatedAt', '==', row.updatedAt ?? null],
        ],
        exists: true,
      },
      ...(successfulPlans.length > 0
        ? [{
            table: 'pages',
            op: 'update' as const,
            id: row.id,
            data: {
              title: updatedRow.title,
              properties: updatedRow.properties,
              lastMutationId: updatedRow.lastMutationId,
              updatedAt: updatedRow.updatedAt,
            },
          }]
        : []),
      ...indexOperations,
      ...receipts.flatMap((receipt): TransactOperation[] => [
        { table: 'automation_execution_receipts', op: 'expect', id: receipt.id, exists: false },
        {
          table: 'automation_execution_receipts',
          op: 'insert',
          data: receipt as unknown as Record<string, unknown>,
        },
      ]),
      ...settleEventOperations(window.events),
      releaseWorkerOperation(lastEvent),
    ];
    if (operations.length > MAX_DATABASE_AUTOMATION_TRANSACTION_OPS) {
      throw evaluatorError(413, 'Database automation evaluation exceeds the bounded transaction size.');
    }
    try {
      await db.transact(operations);
    } catch (error) {
      if (!transactionConflict(error)) throw error;
      throw evaluatorError(409, 'Automation event state changed while it was being evaluated.');
    }
    released = true;
    return {
      processedEvents: window.events.length,
      executions: receipts.length,
      pausedAutomations: failedPlans.length,
      hasMore: continuationRequired,
    };
  } finally {
    if (!released) await releaseWorker(db, claim.leaseToken);
  }
}
