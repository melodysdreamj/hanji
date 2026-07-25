import { defineFunction } from '@edge-base/shared';
import {
  applyAutomationVariableDefinitions,
  assertAutomationResultBound,
  automationRequestHash,
  databaseAutomationDefinitionDocument,
  databaseButtonActionDocument,
  evaluateAutomationDynamicText,
  evaluateAutomationPropertyValue,
  MAX_AUTOMATION_TARGET_ROWS,
  pageButtonActionDocument,
  type AutomationAction,
  type AutomationBlockTemplate,
  type EditPagesAutomationAction,
  type AutomationValueContext,
} from '../lib/automation-actions';
import {
  automationDeliveryRecord,
  isAutomationDeliveryAction,
  type AutomationDeliveryRecord,
} from '../lib/automation-delivery-planning';
import type {
  AutomationExecutionReceipt,
  Block,
  DatabaseAutomationDefinition,
  DbRef,
  DbProperty,
  DbView,
  FunctionContext,
  Page,
  TableRef,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';
import { assertOrganizationDlpContent } from '../lib/enterprise-controls';
import { nextDatabaseAutomationScheduleRun } from '../lib/database-automation-schedule';
import {
  databasePropertyIndexRecord,
  type DbPropertyIndex,
} from '../lib/database-index';
import { errorStatus } from '../lib/error-status';
import { pageAccessRole, pageAccessRoleRanks } from '../lib/page-access';
import {
  getExisting,
  listAllTruncated,
  narrowWhere,
  newId,
  nowIso,
  requireStringRaw as requireString,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';
import {
  boundedDbFromWorkspaceHint,
  ensurePageWorkspaceIndex,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import {
  MAX_DATABASE_AUTOMATIONS_PER_DATABASE,
  processDatabaseAutomationEventPass,
} from '../lib/database-automation-evaluator';
import { processDatabaseAutomationSchedulePass } from '../lib/database-automation-scheduler';
import { processDatabaseAutomationDeliveryPass } from '../lib/database-automation-delivery';

function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request) return {};
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function executionId(value: unknown) {
  const id = requireString(value, 'executionId');
  if (id.length > 160) throw Object.assign(new Error('executionId must be at most 160 characters.'), { status: 400 });
  return id;
}

function optionalConfirmationToken(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw Object.assign(new Error('confirmationToken must be a SHA-256 token.'), { status: 400 });
  }
  return value;
}

function automationDefinitionId(value: unknown) {
  const id = requireString(value, 'automationId');
  if (id.length > 160) {
    throw Object.assign(new Error('automationId must be at most 160 characters.'), { status: 400 });
  }
  return id;
}

function optionalExpectedRevision(value: unknown) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw Object.assign(new Error('expectedRevision must be a positive integer.'), { status: 400 });
  }
  return value as number;
}

function requiredAutomationEnabled(value: unknown) {
  if (typeof value !== 'boolean') {
    throw Object.assign(new Error('enabled must be a boolean.'), { status: 400 });
  }
  return value;
}

function replayDatabaseButtonResult(
  receipt: AutomationExecutionReceipt,
  expected: {
    databaseId: string;
    propertyId: string;
    requestedBy: string;
    rowId: string;
  },
) {
  if (
    receipt.databaseId !== expected.databaseId
    || receipt.sourceType !== 'database_button'
    || receipt.sourceId !== expected.propertyId
    || receipt.triggerPageId !== expected.rowId
    || receipt.requestedBy !== expected.requestedBy
  ) {
    throw Object.assign(new Error('executionId is already bound to another button request.'), { status: 409 });
  }
  if (receipt.status !== 'succeeded' || !receipt.result || typeof receipt.result !== 'object') {
    throw Object.assign(new Error('Button execution receipt is not replayable.'), { status: 409 });
  }
  const result = receipt.result as {
    clientOutcomes?: ButtonClientOutcome[];
    createdPages?: Page[];
    row?: Page;
    updatedPages?: Page[];
  };
  if (
    !result.row
    || !Array.isArray(result.createdPages)
    || !Array.isArray(result.updatedPages)
    || !Array.isArray(result.clientOutcomes)
  ) {
    throw Object.assign(new Error('Button execution receipt is missing its row result.'), { status: 409 });
  }
  return {
    executionId: receipt.id,
    replayed: true,
    row: result.row,
    createdPages: result.createdPages,
    updatedPages: result.updatedPages,
    clientOutcomes: result.clientOutcomes,
  };
}

interface ButtonClientOutcome {
  actionId: string;
  type: 'focus_block' | 'open_page' | 'open_form' | 'open_url';
  blockId?: string;
  pageId?: string;
  databaseId?: string;
  viewId?: string;
  url?: string;
}

interface ButtonConfirmation {
  actionId: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

interface PageButtonReceiptResult {
  insertedBlocks: Block[];
  createdPages: Page[];
  updatedPages: Page[];
  clientOutcomes: ButtonClientOutcome[];
}

interface PageButtonEditSelection {
  action: EditPagesAutomationAction;
  filterProperty: DbProperty;
  rows: Page[];
}

interface PageButtonUpdatedPage {
  databaseId: string;
  original: Page;
  page: Page;
  changedPropertyIds: Set<string>;
}

const PAGE_BUTTON_TRANSACTION_LIMIT = 450;
const DATABASE_BUTTON_TRANSACTION_LIMIT = 450;
const PAGE_BUTTON_STRING_EQUALITY_TYPES = new Set([
  'email',
  'phone',
  'rich_text',
  'select',
  'status',
  'title',
  'url',
]);

function replayPageButtonResult(
  receipt: AutomationExecutionReceipt,
  expected: { blockId: string; pageId: string; requestedBy: string },
) {
  if (
    receipt.databaseId != null
    || receipt.sourceType !== 'page_button'
    || receipt.sourceId !== expected.blockId
    || receipt.triggerPageId !== expected.pageId
    || receipt.requestedBy !== expected.requestedBy
  ) {
    throw Object.assign(new Error('executionId is already bound to another button request.'), { status: 409 });
  }
  if (receipt.status !== 'succeeded' || !receipt.result || typeof receipt.result !== 'object') {
    throw Object.assign(new Error('Button execution receipt is not replayable.'), { status: 409 });
  }
  const result = receipt.result as unknown as Partial<PageButtonReceiptResult>;
  if (
    !Array.isArray(result.insertedBlocks)
    || !Array.isArray(result.createdPages)
    || !Array.isArray(result.updatedPages)
    || !Array.isArray(result.clientOutcomes)
  ) {
    throw Object.assign(new Error('Button execution receipt is missing its page result.'), { status: 409 });
  }
  return {
    executionId: receipt.id,
    replayed: true,
    insertedBlocks: result.insertedBlocks,
    createdPages: result.createdPages,
    updatedPages: result.updatedPages,
    clientOutcomes: result.clientOutcomes,
  };
}

function positionBetween(after?: number, before?: number) {
  if (after == null && before == null) return 1;
  if (after == null) return before! / 2;
  if (before == null) return after + 1;
  return (after + before) / 2;
}

function requiredOrderedQuery<T>(query: TableQuery<T>, label: string) {
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error(`${label} requires bounded ordered queries.`), { status: 500 });
  }
  return query as TableQuery<T> & {
    where(field: string, op: string, value: unknown): TableQuery<T>;
    orderBy(field: string, direction: 'asc' | 'desc'): TableQuery<T>;
  };
}

async function nextSiblingPosition(
  blocks: TableRef<Block>,
  source: Block,
) {
  let query = requiredOrderedQuery(
    blocks.where('pageId', '==', source.pageId),
    'Page button sibling lookup',
  ).where('parentId', '==', source.parentId ?? null);
  query = requiredOrderedQuery(query, 'Page button sibling lookup')
    .where('position', '>', source.position);
  query = requiredOrderedQuery(query, 'Page button sibling lookup')
    .orderBy('position', 'asc');
  const result = await query.page(1).limit(1).getList();
  const candidate = result.items?.[0];
  if (
    candidate
    && (candidate.pageId !== source.pageId
      || (candidate.parentId ?? null) !== (source.parentId ?? null)
      || candidate.position <= source.position)
  ) {
    throw Object.assign(new Error('Page button sibling query returned an invalid row.'), { status: 500 });
  }
  return candidate?.position;
}

async function lastActiveDatabaseRowPosition(
  pages: TableRef<Page>,
  databaseId: string,
) {
  let query = requiredOrderedQuery(
    pages.where('parentId', '==', databaseId),
    'Page button database row lookup',
  ).where('parentType', '==', 'database');
  query = requiredOrderedQuery(query, 'Page button database row lookup')
    .where('inTrash', '!=', true);
  query = requiredOrderedQuery(query, 'Page button database row lookup')
    .orderBy('position', 'desc');
  const result = await query.page(1).limit(1).getList();
  const candidate = result.items?.[0];
  if (
    candidate
    && (candidate.parentId !== databaseId
      || candidate.parentType !== 'database'
      || candidate.inTrash === true)
  ) {
    throw Object.assign(new Error('Page button database row query returned an invalid row.'), { status: 500 });
  }
  return candidate?.position;
}

function pageButtonEditFilter(
  action: EditPagesAutomationAction,
  propertiesByDatabase: ReadonlyMap<string, readonly DbProperty[]>,
) {
  const filter = action.target.filter;
  const propertyId = typeof filter.propertyId === 'string' ? filter.propertyId : '';
  if (!propertyId || filter.operator !== 'equals' || !Object.prototype.hasOwnProperty.call(filter, 'value')) {
    throw Object.assign(
      new Error('Page button edit-pages currently requires one indexed property equals filter.'),
      { status: 409 },
    );
  }
  const property = (propertiesByDatabase.get(action.target.databaseId) ?? [])
    .find((candidate) => candidate.id === propertyId);
  if (!property) {
    throw Object.assign(new Error(`Page button edit-pages filter property was not found: ${propertyId}.`), {
      status: 404,
    });
  }
  if (!PAGE_BUTTON_STRING_EQUALITY_TYPES.has(property.type)) {
    throw Object.assign(
      new Error(`Page button edit-pages filter is not supported for ${property.type} properties.`),
      { status: 409 },
    );
  }
  const selectorPage: Page = {
    id: 'page-button-filter-value',
    workspaceId: 'page-button-filter-workspace',
    parentId: property.databaseId,
    parentType: 'database',
    kind: 'page',
    title: property.type === 'title' ? String(filter.value ?? '') : '',
    properties: property.type === 'title' ? {} : { [property.id]: filter.value },
    position: 0,
  };
  const expected = databasePropertyIndexRecord(selectorPage, property, 'page-button-filter-index')
    .stringValue;
  if (expected === undefined) {
    throw Object.assign(new Error('Page button edit-pages cannot select an empty indexed value.'), {
      status: 409,
    });
  }
  return { expected, property };
}

async function selectPageButtonEditRows(
  db: DbRef,
  pages: TableRef<Page>,
  workspaceId: string,
  action: EditPagesAutomationAction,
  propertiesByDatabase: ReadonlyMap<string, readonly DbProperty[]>,
): Promise<PageButtonEditSelection> {
  const { expected, property } = pageButtonEditFilter(action, propertiesByDatabase);
  let indexQuery = requiredOrderedQuery(
    db.table<DbPropertyIndex>('db_property_indexes')
      .where('databaseId', '==', action.target.databaseId),
    'Page button edit-pages selector',
  ).where('propertyId', '==', property.id);
  indexQuery = requiredOrderedQuery(indexQuery, 'Page button edit-pages selector')
    .where('stringValue', '==', expected);
  indexQuery = requiredOrderedQuery(indexQuery, 'Page button edit-pages selector')
    .orderBy('rowId', 'asc');
  const selectedIndexes = (await indexQuery.limit(action.target.limit + 1).getList()).items ?? [];
  if (selectedIndexes.some((index) => (
    index.workspaceId !== workspaceId
    || index.databaseId !== action.target.databaseId
    || index.propertyId !== property.id
    || index.propertyType !== property.type
    || index.stringValue !== expected
  ))) {
    throw Object.assign(new Error('Page button edit-pages index query returned invalid data.'), { status: 500 });
  }
  const indexes = selectedIndexes.slice(0, action.target.limit);
  const rowIds = indexes.map((index) => index.rowId);
  if (new Set(rowIds).size !== rowIds.length) {
    throw Object.assign(new Error('Page button edit-pages index query returned duplicate rows.'), { status: 500 });
  }
  if (rowIds.length === 0) return { action, filterProperty: property, rows: [] };

  const rowResult = await pages.where('id', 'in', rowIds).limit(rowIds.length + 1).getList();
  const loadedRows = rowResult.items ?? [];
  if (loadedRows.length !== rowIds.length) {
    throw Object.assign(new Error('Page button edit-pages index is stale.'), { status: 409 });
  }
  const rowsById = new Map(loadedRows.map((row) => [row.id, row]));
  const rows = rowIds.map((rowId, index) => {
    const row = rowsById.get(rowId);
    const propertyIndex = indexes[index]!;
    const currentStringValue = row
      ? databasePropertyIndexRecord(row, property, 'page-button-current-filter-value').stringValue
      : undefined;
    if (
      !row
      || row.workspaceId !== workspaceId
      || row.parentType !== 'database'
      || row.parentId !== action.target.databaseId
      || row.kind === 'database'
      || propertyIndex.workspaceId !== workspaceId
      || propertyIndex.propertyType !== property.type
      || currentStringValue !== expected
    ) {
      throw Object.assign(new Error('Page button edit-pages index is stale.'), { status: 409 });
    }
    if (row.inTrash) throw Object.assign(new Error('A page button target row is in trash.'), { status: 400 });
    if (row.isLocked) throw Object.assign(new Error('A page button target row is locked.'), { status: 423 });
    return row;
  });
  return { action, filterProperty: property, rows };
}

async function loadPageButtonEditIndexes(
  db: DbRef,
  updates: readonly PageButtonUpdatedPage[],
  propertiesById: ReadonlyMap<string, DbProperty>,
) {
  const groups = new Map<string, { databaseId: string; propertyId: string; rowIds: string[] }>();
  let combinationCount = 0;
  for (const update of updates) {
    for (const propertyId of update.changedPropertyIds) {
      combinationCount += 1;
      if (combinationCount > MAX_AUTOMATION_TARGET_ROWS) {
        throw Object.assign(
          new Error(`Page button execution supports at most ${MAX_AUTOMATION_TARGET_ROWS} edited row-property pairs.`),
          { status: 413 },
        );
      }
      const key = `${update.databaseId}\u0000${propertyId}`;
      const group = groups.get(key) ?? { databaseId: update.databaseId, propertyId, rowIds: [] };
      group.rowIds.push(update.page.id);
      groups.set(key, group);
    }
  }
  // Keep one query per (database, property) key: merging independent
  // propertyId/rowId `in` sets would create a cross product and over-read
  // unrelated billed index rows. Queries within that safe key run together.
  const loaded = await Promise.all(Array.from(groups.values()).map(async (group) => {
    let query = narrowWhere(
      db.table<DbPropertyIndex>('db_property_indexes')
        .where('databaseId', '==', group.databaseId),
      'propertyId',
      group.propertyId,
    );
    query = requiredOrderedQuery(query, 'Page button edited-property indexes')
      .where('rowId', 'in', group.rowIds);
    const result = await query.limit(group.rowIds.length + 1).getList();
    const indexes = result.items ?? [];
    if (indexes.length > group.rowIds.length || indexes.some((index) => (
      index.databaseId !== group.databaseId
      || index.propertyId !== group.propertyId
      || !group.rowIds.includes(index.rowId)
    ))) {
      throw Object.assign(new Error('Page button edited-property index query returned invalid data.'), {
        status: 500,
      });
    }
    if (!propertiesById.has(group.propertyId)) {
      throw Object.assign(new Error('Page button edited-property schema was not found.'), { status: 409 });
    }
    return indexes;
  }));
  return new Map(loaded.flat().map((index) => [`${index.rowId}\u0000${index.propertyId}`, index]));
}

function blockPlainText(template: AutomationBlockTemplate) {
  const rich = Array.isArray(template.content?.rich) ? template.content.rich : [];
  const richText = rich.map((span) => (
    span && typeof span === 'object' && typeof (span as { text?: unknown }).text === 'string'
      ? (span as { text: string }).text
      : ''
  )).join('');
  const fallback = template.content?.expression
    ?? template.content?.url
    ?? template.content?.fileName
    ?? '';
  return richText || (typeof fallback === 'string' ? fallback : '');
}

function transactionConflict(error: unknown) {
  return error instanceof Error && error.message.includes('Transaction expectation failed');
}

function automationDeliveryOperations(
  deliveries: readonly AutomationDeliveryRecord[],
): TransactOperation[] {
  return deliveries.flatMap((delivery): TransactOperation[] => [
    { table: 'database_automation_deliveries', op: 'expect', id: delivery.id, exists: false },
    {
      table: 'database_automation_deliveries',
      op: 'insert',
      data: delivery as unknown as Record<string, unknown>,
    },
  ]);
}

function buttonConfirmationChallenge(
  executionIdValue: string,
  actions: readonly AutomationAction[],
  expectedConfirmationToken: string,
  confirmationToken?: string,
) {
  const confirmations: ButtonConfirmation[] = actions.flatMap((action) => (
    action.type === 'show_confirmation'
      ? [{
          actionId: action.id,
          title: action.title,
          message: action.message,
          confirmLabel: action.confirmLabel,
          cancelLabel: action.cancelLabel,
        }]
      : []
  ));
  if (confirmations.length === 0) {
    if (confirmationToken !== undefined) {
      throw Object.assign(new Error('confirmationToken does not match a confirmation action.'), { status: 409 });
    }
    return null;
  }
  if (confirmationToken === undefined) {
    return {
      executionId: executionIdValue,
      replayed: false,
      confirmationRequired: true as const,
      confirmationToken: expectedConfirmationToken,
      confirmations,
    };
  }
  if (confirmationToken !== expectedConfirmationToken) {
    throw Object.assign(new Error('Button confirmation is stale.'), { status: 409 });
  }
  return null;
}

async function buttonClientOutcomePlan(
  db: DbRef,
  workspaceId: string,
  actor: { id: string; email?: string },
  actions: readonly AutomationAction[],
) {
  const pageIds = Array.from(new Set(actions.flatMap((action) => (
    action.type === 'open_page' ? [action.pageId] : []
  ))));
  const formDatabaseIds = Array.from(new Set(actions.flatMap((action) => (
    action.type === 'open_form' ? [action.databaseId] : []
  ))));
  const viewIds = Array.from(new Set(actions.flatMap((action) => (
    action.type === 'open_form' ? [action.viewId] : []
  ))));
  const targetPageIds = Array.from(new Set([...pageIds, ...formDatabaseIds]));
  const [pageScan, viewScan] = await Promise.all([
    targetPageIds.length === 0
      ? Promise.resolve({ items: [] as Page[], complete: true })
      : listAllTruncated(db.table<Page>('pages').where('id', 'in', targetPageIds), {
          label: 'Button client-outcome target pages',
          maxItems: targetPageIds.length,
          pageSize: targetPageIds.length,
        }),
    viewIds.length === 0
      ? Promise.resolve({ items: [] as DbView[], complete: true })
      : listAllTruncated(db.table<DbView>('db_views').where('id', 'in', viewIds), {
          label: 'Button client-outcome form views',
          maxItems: viewIds.length,
          pageSize: viewIds.length,
        }),
  ]);
  if (
    !pageScan.complete
    || pageScan.items.length !== targetPageIds.length
    || new Set(pageScan.items.map((page) => page.id)).size !== pageScan.items.length
    || pageScan.items.some((page) => (
      !targetPageIds.includes(page.id) || page.workspaceId !== workspaceId || page.inTrash
    ))
  ) {
    throw Object.assign(new Error('A button navigation target page was not found.'), { status: 404 });
  }
  if (
    !viewScan.complete
    || viewScan.items.length !== viewIds.length
    || new Set(viewScan.items.map((view) => view.id)).size !== viewScan.items.length
    || viewScan.items.some((view) => !viewIds.includes(view.id))
  ) {
    throw Object.assign(new Error('A button navigation target form was not found.'), { status: 404 });
  }
  const pagesById = new Map(pageScan.items.map((page) => [page.id, page]));
  const viewsById = new Map(viewScan.items.map((view) => [view.id, view]));
  for (const action of actions) {
    if (action.type !== 'open_form') continue;
    const database = pagesById.get(action.databaseId);
    const view = viewsById.get(action.viewId);
    if (
      !database
      || database.kind !== 'database'
      || !view
      || view.databaseId !== database.id
      || view.type !== 'form'
    ) {
      throw Object.assign(new Error('A button navigation target form was not found.'), { status: 404 });
    }
  }
  const roles = await Promise.all(pageScan.items.map((page) => (
    pageAccessRole(db, page, actor.id, undefined, actor.email ?? null, { requireWorkspace: true })
  )));
  if (roles.some((role) => !role || pageAccessRoleRanks[role] < pageAccessRoleRanks.view)) {
    throw Object.assign(new Error('Button navigation target access required.'), { status: 403 });
  }

  const outcomes = actions.flatMap((action): ButtonClientOutcome[] => {
    if (action.type === 'open_page') {
      return [{ actionId: action.id, type: 'open_page', pageId: action.pageId }];
    }
    if (action.type === 'open_form') {
      return [{
        actionId: action.id,
        type: 'open_form',
        databaseId: action.databaseId,
        viewId: action.viewId,
      }];
    }
    if (action.type === 'open_url') {
      return [{ actionId: action.id, type: 'open_url', url: action.url }];
    }
    return [];
  });
  const outcomeByActionId = new Map(outcomes.map((outcome) => [outcome.actionId, outcome]));
  const expectations: TransactOperation[] = [
    ...pageScan.items.map((page): TransactOperation => ({
      table: 'pages',
      op: 'expect',
      id: page.id,
      where: [
        ['workspaceId', '==', workspaceId],
        ['inTrash', '==', false],
        ['updatedAt', '==', page.updatedAt ?? null],
      ],
      exists: true,
    })),
    ...viewScan.items.map((view): TransactOperation => ({
      table: 'db_views',
      op: 'expect',
      id: view.id,
      where: [
        ['databaseId', '==', view.databaseId],
        ['type', '==', 'form'],
        ['updatedAt', '==', view.updatedAt ?? null],
      ],
      exists: true,
    })),
  ];
  return { expectations, outcomeByActionId, outcomes };
}

async function ensureCreatedPageRoutes(
  admin: AdminDbAccessor,
  workspaceId: string,
  createdPages: readonly Page[],
) {
  const pageIds = Array.from(new Set(createdPages.map((page) => page.id)));
  if (pageIds.length === 0) return;
  const central = admin.db('app');
  const table = central.table<{ id: string; workspaceId: string }>('page_workspace_index');
  const loaded = await table.where('id', 'in', pageIds).limit(pageIds.length).getList();
  const existingById = new Map((loaded.items ?? []).map((row) => [row.id, row]));
  const operations: TransactOperation[] = pageIds.flatMap((pageId): TransactOperation[] => {
    const existing = existingById.get(pageId);
    if (existing?.workspaceId === workspaceId) return [];
    if (existing) {
      return [
        {
          table: 'page_workspace_index',
          op: 'expect',
          id: pageId,
          where: [['workspaceId', '==', existing.workspaceId]],
          exists: true,
        },
        {
          table: 'page_workspace_index',
          op: 'update',
          id: pageId,
          data: { workspaceId },
        },
      ];
    }
    return [
      { table: 'page_workspace_index', op: 'expect', id: pageId, exists: false },
      {
        table: 'page_workspace_index',
        op: 'insert',
        data: { id: pageId, workspaceId },
      },
    ];
  });
  if (operations.length === 0) return;
  try {
    await central.transact(operations);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    // A concurrent trigger/index writer won the batch race. Reconcile only
    // that exceptional lane with the established idempotent point helper.
    await Promise.all(pageIds.map((pageId) => (
      ensurePageWorkspaceIndex(admin, pageId, workspaceId)
    )));
  }
}

interface ButtonPageMutationPlan {
  createdPageOutcomeByActionId: Map<string, ButtonClientOutcome>;
  createdPages: Page[];
  databaseExpectations: TransactOperation[];
  pageInsertOperations: TransactOperation[];
  pageUpdateOperations: TransactOperation[];
  propertyExpectations: TransactOperation[];
  triggerChangedPropertyIds: string[];
  triggerPage: Page;
  updatedPages: Page[];
}

async function prepareButtonPageMutations(
  db: DbRef,
  pages: TableRef<Page>,
  properties: TableRef<DbProperty>,
  actor: { id: string; email?: string },
  input: {
    actions: readonly AutomationAction[];
    allowTriggerPageEdits: boolean;
    executedAt: string;
    knownSourceDatabase?: Page;
    knownSourceProperties?: readonly DbProperty[];
    mutationId: string;
    sourceDatabaseId: string | null;
    triggerPage: Page;
    workspaceId: string;
  },
): Promise<ButtonPageMutationPlan> {
  const {
    actions,
    allowTriggerPageEdits,
    executedAt,
    knownSourceDatabase,
    knownSourceProperties,
    mutationId,
    sourceDatabaseId,
    triggerPage,
    workspaceId,
  } = input;
  const addPageDatabaseIds = Array.from(new Set(actions.flatMap((action) => (
    action.type === 'add_page' ? [action.databaseId] : []
  ))));
  const targetDatabaseIds = Array.from(new Set(actions.flatMap((action) => {
    if (action.type === 'add_page') return [action.databaseId];
    if (action.type === 'edit_pages') return [action.target.databaseId];
    return [];
  })));
  const propertyDatabaseIds = Array.from(new Set([
    ...targetDatabaseIds,
    ...(sourceDatabaseId ? [sourceDatabaseId] : []),
  ]));
  const knownProperties = knownSourceProperties && sourceDatabaseId
    ? knownSourceProperties.filter((property) => property.databaseId === sourceDatabaseId)
    : [];
  const propertyQueryDatabaseIds = propertyDatabaseIds.filter((databaseId) => (
    databaseId !== sourceDatabaseId || knownProperties.length === 0
  ));
  const remainingPropertyCapacity = 100 - knownProperties.length;
  if (propertyQueryDatabaseIds.length > 0 && remainingPropertyCapacity <= 0) {
    throw Object.assign(new Error('Button execution supports at most 100 source and target properties.'), {
      status: 409,
    });
  }
  const knownTargetDatabase = knownSourceDatabase && sourceDatabaseId === knownSourceDatabase.id
    ? knownSourceDatabase
    : undefined;
  const targetDatabaseQueryIds = targetDatabaseIds.filter((databaseId) => (
    databaseId !== knownTargetDatabase?.id
  ));
  const [targetDatabaseScan, targetPropertyScan] = await Promise.all([
    targetDatabaseQueryIds.length === 0
      ? Promise.resolve({ items: [] as Page[], complete: true })
      : listAllTruncated(pages.where('id', 'in', targetDatabaseQueryIds), {
          label: 'Button target databases',
          maxItems: targetDatabaseQueryIds.length,
          pageSize: targetDatabaseQueryIds.length,
        }),
    propertyQueryDatabaseIds.length === 0
      ? Promise.resolve({ items: [] as DbProperty[], complete: true })
      : listAllTruncated(properties.where('databaseId', 'in', propertyQueryDatabaseIds), {
          label: 'Button source and target properties',
          maxItems: remainingPropertyCapacity,
          pageSize: remainingPropertyCapacity,
        }),
  ]);
  if (!targetDatabaseScan.complete || targetDatabaseScan.items.length !== targetDatabaseQueryIds.length) {
    throw Object.assign(new Error('A button target database was not found.'), { status: 404 });
  }
  const allProperties = [...knownProperties, ...targetPropertyScan.items];
  if (!targetPropertyScan.complete || allProperties.length > 100) {
    throw Object.assign(new Error('Button execution supports at most 100 source and target properties.'), {
      status: 409,
    });
  }
  if (allProperties.some((property) => !propertyDatabaseIds.includes(property.databaseId))) {
    throw Object.assign(new Error('Button property query returned invalid data.'), { status: 500 });
  }
  const targetDatabases = new Map(targetDatabaseScan.items.map((database) => [database.id, database]));
  if (knownTargetDatabase && targetDatabaseIds.includes(knownTargetDatabase.id)) {
    targetDatabases.set(knownTargetDatabase.id, knownTargetDatabase);
  }
  const propertiesByDatabase = new Map<string, DbProperty[]>();
  for (const property of allProperties) {
    const current = propertiesByDatabase.get(property.databaseId) ?? [];
    current.push(property);
    propertiesByDatabase.set(property.databaseId, current);
  }
  const titleProperties = new Map<string, DbProperty>();
  for (const databaseId of targetDatabaseIds) {
    const database = targetDatabases.get(databaseId);
    if (!database || database.workspaceId !== workspaceId || database.kind !== 'database') {
      throw Object.assign(new Error('A button target database was not found.'), { status: 404 });
    }
    if (database.inTrash) throw Object.assign(new Error('A button target database is in trash.'), { status: 400 });
    if (database.isLocked) throw Object.assign(new Error('A button target database is locked.'), { status: 423 });
    if (addPageDatabaseIds.includes(databaseId)) {
      const titleProperty = (propertiesByDatabase.get(databaseId) ?? [])
        .filter((property) => property.type === 'title')
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))[0];
      if (!titleProperty) {
        throw Object.assign(new Error('A button target database has no title property.'), { status: 409 });
      }
      titleProperties.set(databaseId, titleProperty);
    }
  }
  const targetRoles = await Promise.all(targetDatabaseIds.map(async (databaseId) => (
    pageAccessRole(db, targetDatabases.get(databaseId)!, actor.id, undefined, actor.email ?? null, {
      requireWorkspace: true,
    })
  )));
  if (targetRoles.some((role) => !role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit)) {
    throw Object.assign(new Error('Page access required.'), { status: 403 });
  }

  const tailPositions = new Map(await Promise.all(addPageDatabaseIds.map(async (databaseId) => (
    [databaseId, await lastActiveDatabaseRowPosition(pages, databaseId)] as const
  ))));
  const editSelectionPromises = new Map<string, Promise<PageButtonEditSelection>>();
  const editSelections = new Map<string, PageButtonEditSelection>();
  await Promise.all(actions.flatMap((action) => {
    if (action.type !== 'edit_pages') return [];
    const key = JSON.stringify(action.target);
    let selection = editSelectionPromises.get(key);
    if (!selection) {
      selection = selectPageButtonEditRows(db, pages, workspaceId, action, propertiesByDatabase);
      editSelectionPromises.set(key, selection);
    }
    return [selection.then((resolved) => {
      editSelections.set(action.id, { ...resolved, action });
    })];
  }));

  const sourceProperties = sourceDatabaseId
    ? propertiesByDatabase.get(sourceDatabaseId) ?? []
    : [];
  const sourcePropertiesById = new Map(sourceProperties.map((property) => [property.id, property]));
  const valueContext: AutomationValueContext = {
    databaseProperties: sourceProperties,
    executionTime: executedAt,
    triggerPage: {
      title: triggerPage.title ?? '',
      properties: structuredClone(triggerPage.properties ?? {}),
    },
    variables: new Map(),
  };
  let triggerTitle = triggerPage.title ?? '';
  let triggerProperties = structuredClone(triggerPage.properties ?? {});
  const triggerChangedPropertyIds = new Set<string>();
  const createdPages: Page[] = [];
  const createdPageIndexProperties = new Map<string, DbProperty[]>();
  const createdPageOutcomeByActionId = new Map<string, ButtonClientOutcome>();
  const updatedPageStates = new Map<string, PageButtonUpdatedPage>();

  const updateTriggerContext = () => {
    valueContext.triggerPage = { title: triggerTitle, properties: triggerProperties };
  };
  const applyEvaluatedChange = (
    property: DbProperty,
    value: unknown,
    target: { title: string; properties: Record<string, unknown> },
  ) => {
    if (property.type === 'title') target.title = String(value ?? '');
    else target.properties[property.id] = value;
  };

  for (const action of actions) {
    if (action.type === 'define_variables') {
      applyAutomationVariableDefinitions(action, valueContext);
      continue;
    }
    if (action.type === 'edit_property') {
      if (!allowTriggerPageEdits) {
        throw Object.assign(new Error('Button trigger-page property edits are not available on this surface.'), {
          status: 409,
        });
      }
      const property = sourcePropertiesById.get(action.propertyId);
      if (!property) {
        throw Object.assign(new Error(`Button action target property was not found: ${action.propertyId}.`), {
          status: 404,
        });
      }
      const target = { title: triggerTitle, properties: triggerProperties };
      applyEvaluatedChange(property, evaluateAutomationPropertyValue(property, action.value, valueContext), target);
      triggerTitle = target.title;
      triggerProperties = target.properties;
      triggerChangedPropertyIds.add(property.id);
      updateTriggerContext();
      continue;
    }
    if (action.type === 'add_page') {
      const targetProperties = propertiesByDatabase.get(action.databaseId) ?? [];
      const targetPropertiesById = new Map(targetProperties.map((property) => [property.id, property]));
      const titleProperty = titleProperties.get(action.databaseId)!;
      let title = evaluateAutomationDynamicText(action.title, valueContext);
      const initialProperties: Record<string, unknown> = {};
      const indexedProperties = new Map([[titleProperty.id, titleProperty]]);
      for (const change of action.properties ?? []) {
        const property = targetPropertiesById.get(change.propertyId);
        if (!property) {
          throw Object.assign(new Error(`Button added-page property was not found: ${change.propertyId}.`), {
            status: 404,
          });
        }
        const value = evaluateAutomationPropertyValue(property, change.value, valueContext);
        if (property.type === 'title') title = String(value ?? '');
        else initialProperties[property.id] = value;
        indexedProperties.set(property.id, property);
      }
      const position = positionBetween(tailPositions.get(action.databaseId), undefined);
      tailPositions.set(action.databaseId, position);
      const created: Page = {
        id: newId(),
        workspaceId,
        parentId: action.databaseId,
        parentType: 'database',
        kind: 'page',
        title,
        properties: initialProperties,
        inTrash: false,
        position,
        createdBy: actor.id,
        lastEditedBy: actor.id,
        lastMutationId: mutationId,
        createdAt: executedAt,
        updatedAt: executedAt,
      };
      createdPages.push(created);
      createdPageIndexProperties.set(created.id, Array.from(indexedProperties.values()));
      if (action.openCreatedPage) {
        createdPageOutcomeByActionId.set(action.id, {
          actionId: action.id,
          type: 'open_page',
          pageId: created.id,
        });
      }
      continue;
    }
    if (action.type !== 'edit_pages') continue;
    const selection = editSelections.get(action.id);
    if (!selection) {
      throw Object.assign(new Error('Button edit-pages selection was not prepared.'), { status: 500 });
    }
    const targetProperties = propertiesByDatabase.get(action.target.databaseId) ?? [];
    const targetPropertiesById = new Map(targetProperties.map((property) => [property.id, property]));
    const evaluatedChanges = action.changes.map((change) => {
      const property = targetPropertiesById.get(change.propertyId);
      if (!property) {
        throw Object.assign(new Error(`Button edited-page property was not found: ${change.propertyId}.`), {
          status: 404,
        });
      }
      return {
        property,
        value: evaluateAutomationPropertyValue(property, change.value, valueContext),
      };
    });
    for (const selectedRow of selection.rows) {
      if (allowTriggerPageEdits && selectedRow.id === triggerPage.id) {
        if (selectedRow.parentId !== sourceDatabaseId) {
          throw Object.assign(new Error('Button edit-pages selected its trigger from a conflicting database.'), {
            status: 500,
          });
        }
        const target = { title: triggerTitle, properties: triggerProperties };
        for (const change of evaluatedChanges) {
          applyEvaluatedChange(change.property, change.value, target);
          triggerChangedPropertyIds.add(change.property.id);
        }
        triggerTitle = target.title;
        triggerProperties = target.properties;
        updateTriggerContext();
        continue;
      }
      let state = updatedPageStates.get(selectedRow.id);
      if (!state) {
        if (updatedPageStates.size >= MAX_AUTOMATION_TARGET_ROWS) {
          throw Object.assign(
            new Error(`Button execution supports at most ${MAX_AUTOMATION_TARGET_ROWS} edited pages.`),
            { status: 413 },
          );
        }
        state = {
          databaseId: action.target.databaseId,
          original: selectedRow,
          page: { ...selectedRow, properties: { ...selectedRow.properties } },
          changedPropertyIds: new Set(),
        };
        updatedPageStates.set(selectedRow.id, state);
      } else if (state.databaseId !== action.target.databaseId) {
        throw Object.assign(new Error('Button edit-pages selected a row from conflicting databases.'), {
          status: 500,
        });
      }
      const target = {
        title: state.page.title ?? '',
        properties: { ...state.page.properties },
      };
      for (const change of evaluatedChanges) {
        applyEvaluatedChange(change.property, change.value, target);
        state.changedPropertyIds.add(change.property.id);
      }
      state.page = {
        ...state.page,
        title: target.title,
        properties: target.properties,
        lastEditedBy: actor.id,
        lastMutationId: mutationId,
        updatedAt: executedAt,
      };
    }
  }

  const triggerChangedIds = Array.from(triggerChangedPropertyIds).sort();
  const finalTriggerPage = triggerChangedIds.length > 0
    ? {
        ...triggerPage,
        title: triggerTitle,
        properties: triggerProperties,
        lastEditedBy: actor.id,
        lastMutationId: mutationId,
        updatedAt: executedAt,
      }
    : triggerPage;
  const updatedPageUpdates = Array.from(updatedPageStates.values());
  const updatedPages = updatedPageUpdates.map((update) => update.page);
  const allTargetProperties = new Map(allProperties.map((property) => [property.id, property]));
  const existingEditIndexes = await loadPageButtonEditIndexes(db, updatedPageUpdates, allTargetProperties);

  const databaseExpectations: TransactOperation[] = targetDatabaseIds.map((databaseId) => {
    const database = targetDatabases.get(databaseId)!;
    return {
      table: 'pages',
      op: 'expect',
      id: databaseId,
      where: [
        ['kind', '==', 'database'],
        ['updatedAt', '==', database.updatedAt ?? null],
      ],
      exists: true,
    };
  });
  const expectedProperties = new Map<string, DbProperty>();
  for (const indexed of createdPageIndexProperties.values()) {
    for (const property of indexed) expectedProperties.set(property.id, property);
  }
  for (const selection of editSelections.values()) {
    expectedProperties.set(selection.filterProperty.id, selection.filterProperty);
  }
  for (const update of updatedPageUpdates) {
    for (const propertyId of update.changedPropertyIds) {
      const property = allTargetProperties.get(propertyId);
      if (property) expectedProperties.set(property.id, property);
    }
  }
  const propertyExpectations: TransactOperation[] = Array.from(expectedProperties.values()).map((property) => ({
    table: 'db_properties',
    op: 'expect',
    id: property.id,
    where: [
      ['databaseId', '==', property.databaseId],
      ['type', '==', property.type],
      ['updatedAt', '==', property.updatedAt ?? null],
    ],
    exists: true,
  }));
  const pageInsertOperations: TransactOperation[] = createdPages.flatMap((created): TransactOperation[] => {
    const indexOperations = (createdPageIndexProperties.get(created.id) ?? []).flatMap((property) => {
      const indexId = newId();
      const index = databasePropertyIndexRecord(created, property, indexId);
      return [
        { table: 'db_property_indexes', op: 'expect', id: indexId, exists: false },
        {
          table: 'db_property_indexes',
          op: 'insert',
          data: JSON.parse(JSON.stringify(index)) as Record<string, unknown>,
        },
      ] satisfies TransactOperation[];
    });
    return [
      { table: 'pages', op: 'expect', id: created.id, exists: false },
      { table: 'pages', op: 'insert', data: created as unknown as Record<string, unknown> },
      ...indexOperations,
      {
        table: 'database_automation_events',
        op: 'insert',
        data: {
          id: newId(),
          workspaceId,
          databaseId: created.parentId,
          rowId: created.id,
          triggerKind: 'row_added',
          origin: 'button',
          mutationId,
          changedPropertyIds: [],
          occurredAt: created.updatedAt,
          state: 'pending',
        },
      },
    ];
  });
  const pageUpdateOperations: TransactOperation[] = updatedPageUpdates.flatMap((update) => {
    const indexOperations = Array.from(update.changedPropertyIds).map((propertyId): TransactOperation => {
      const property = allTargetProperties.get(propertyId)!;
      const key = `${update.page.id}\u0000${propertyId}`;
      const existing = existingEditIndexes.get(key);
      const index = databasePropertyIndexRecord(update.page, property, existing?.id ?? newId());
      if (existing) {
        return {
          table: 'db_property_indexes',
          op: 'update',
          id: existing.id,
          data: JSON.parse(JSON.stringify(index)) as Record<string, unknown>,
        };
      }
      return {
        table: 'db_property_indexes',
        op: 'insert',
        data: JSON.parse(JSON.stringify(index)) as Record<string, unknown>,
      };
    });
    const changedPropertyIds = Array.from(update.changedPropertyIds).sort();
    return [
      {
        table: 'pages',
        op: 'expect',
        id: update.original.id,
        where: [
          ['workspaceId', '==', workspaceId],
          ['parentType', '==', 'database'],
          ['parentId', '==', update.databaseId],
          ['updatedAt', '==', update.original.updatedAt ?? null],
        ],
        exists: true,
      },
      {
        table: 'pages',
        op: 'update',
        id: update.page.id,
        data: {
          title: update.page.title ?? '',
          properties: update.page.properties ?? {},
          lastEditedBy: update.page.lastEditedBy,
          lastMutationId: update.page.lastMutationId,
          updatedAt: update.page.updatedAt,
        },
      },
      ...indexOperations,
      {
        table: 'database_automation_events',
        op: 'insert',
        data: {
          id: newId(),
          workspaceId,
          databaseId: update.databaseId,
          rowId: update.page.id,
          triggerKind: 'properties_edited',
          origin: 'button',
          mutationId,
          changedPropertyIds,
          occurredAt: update.page.updatedAt,
          state: 'pending',
        },
      },
    ];
  });

  return {
    createdPageOutcomeByActionId,
    createdPages,
    databaseExpectations,
    pageInsertOperations,
    pageUpdateOperations,
    propertyExpectations,
    triggerChangedPropertyIds: triggerChangedIds,
    triggerPage: finalTriggerPage,
    updatedPages,
  };
}

async function executePageButton(
  admin: AdminDbAccessor,
  db: DbRef,
  actor: { id: string; email?: string },
  input: {
    blockId: string;
    confirmationToken?: string;
    executionId: string;
    pageId: string;
    workspaceId: string;
  },
) {
  const { blockId, confirmationToken, executionId: id, pageId, workspaceId } = input;
  const receipts = db.table<AutomationExecutionReceipt>('automation_execution_receipts');
  const expectedReceipt = { blockId, pageId, requestedBy: actor.id };
  const existingReceipt = await getExisting(receipts, id);
  if (existingReceipt) {
    const replay = replayPageButtonResult(existingReceipt, expectedReceipt);
    await ensureCreatedPageRoutes(admin, workspaceId, replay.createdPages);
    return replay;
  }

  const pages = db.table<Page>('pages');
  const blocks = db.table<Block>('blocks');
  const properties = db.table<DbProperty>('db_properties');
  const [page, sourceBlock] = await Promise.all([
    getExisting(pages, pageId),
    getExisting(blocks, blockId),
  ]);
  if (!page || page.workspaceId !== workspaceId || page.kind === 'database') {
    throw Object.assign(new Error('Page was not found.'), { status: 404 });
  }
  if (page.inTrash) throw Object.assign(new Error('Page is in trash.'), { status: 400 });
  if (page.isLocked) throw Object.assign(new Error('Page is locked.'), { status: 423 });
  if (!sourceBlock || sourceBlock.pageId !== pageId || sourceBlock.type !== 'button') {
    throw Object.assign(new Error('Page button block was not found.'), { status: 404 });
  }
  const role = await pageAccessRole(db, page, actor.id, undefined, actor.email ?? null, {
    requireWorkspace: true,
  });
  if (!role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit) {
    throw Object.assign(new Error('Page access required.'), { status: 403 });
  }
  const document = pageButtonActionDocument(sourceBlock);
  if (!document) throw Object.assign(new Error('Page button has no configured actions.'), { status: 400 });
  const unsupportedAction = document.actions.find((action) => (
    action.type !== 'insert_blocks'
    && action.type !== 'define_variables'
    && action.type !== 'add_page'
    && action.type !== 'edit_pages'
    && !isAutomationDeliveryAction(action)
    && action.type !== 'show_confirmation'
    && action.type !== 'open_page'
    && action.type !== 'open_form'
    && action.type !== 'open_url'
  ));
  if (unsupportedAction) {
    throw Object.assign(
      new Error(`Page button action is not executable yet: ${unsupportedAction.type}.`),
      { status: 409 },
    );
  }
  const requestHash = await automationRequestHash({ blockId, document, pageId });
  const expectedConfirmationToken = await automationRequestHash({ executionId: id, requestHash });
  const challenge = buttonConfirmationChallenge(
    id,
    document.actions,
    expectedConfirmationToken,
    confirmationToken,
  );
  if (challenge) {
    assertAutomationResultBound(challenge);
    return challenge;
  }

  const sourceDatabaseId = page.parentType === 'database' ? page.parentId ?? null : null;
  const hasInsertBlockAction = document.actions.some((action) => action.type === 'insert_blocks');
  const executedAt = nowIso();
  const mutationId = `automation:${id}`;
  const [pageMutationPlan, nextPosition, clientOutcomePlan, deliveries] = await Promise.all([
    prepareButtonPageMutations(db, pages, properties, actor, {
      actions: document.actions,
      allowTriggerPageEdits: false,
      executedAt,
      mutationId,
      sourceDatabaseId,
      triggerPage: page,
      workspaceId,
    }),
    hasInsertBlockAction ? nextSiblingPosition(blocks, sourceBlock) : Promise.resolve(undefined),
    buttonClientOutcomePlan(db, workspaceId, actor, document.actions),
    Promise.all(document.actions.filter(isAutomationDeliveryAction).map((action) => (
      automationDeliveryRecord({
        action,
        workspaceId,
        ownerPageId: pageId,
        sourceType: 'page_button',
        sourceId: blockId,
        executionId: id,
        scheduledFor: executedAt,
      })
    ))),
  ]);
  const insertedBlocks: Block[] = [];
  const clientOutcomes: ButtonClientOutcome[] = [];
  let previousTopLevelPosition = sourceBlock.position;

  const prepareBlock = (
    template: AutomationBlockTemplate,
    parentId: string | null,
    position: number,
  ): Block => {
    const prepared: Block = {
      id: newId(),
      pageId,
      parentId,
      type: template.type,
      content: structuredClone(template.content ?? { rich: [] }),
      plainText: blockPlainText(template),
      position,
      createdBy: actor.id,
      lastEditedBy: actor.id,
      lastMutationId: mutationId,
      createdAt: executedAt,
      updatedAt: executedAt,
    };
    insertedBlocks.push(prepared);
    let childPosition: number | undefined;
    for (const child of template.children ?? []) {
      const nextChildPosition = positionBetween(childPosition, undefined);
      prepareBlock(child, prepared.id, nextChildPosition);
      childPosition = nextChildPosition;
    }
    return prepared;
  };

  for (const action of document.actions) {
    if (isAutomationDeliveryAction(action)) continue;
    if (action.type === 'show_confirmation') continue;
    if (action.type === 'open_page' || action.type === 'open_form' || action.type === 'open_url') {
      const outcome = clientOutcomePlan.outcomeByActionId.get(action.id);
      if (!outcome) {
        throw Object.assign(new Error('Button navigation outcome was not prepared.'), { status: 500 });
      }
      clientOutcomes.push(outcome);
      continue;
    }
    if (action.type === 'define_variables' || action.type === 'edit_pages') continue;
    if (action.type === 'insert_blocks') {
      let firstBlock: Block | undefined;
      for (const template of action.blocks) {
        const position = positionBetween(previousTopLevelPosition, nextPosition);
        const prepared = prepareBlock(template, sourceBlock.parentId ?? null, position);
        firstBlock ??= prepared;
        previousTopLevelPosition = position;
      }
      if (firstBlock) {
        clientOutcomes.push({ actionId: action.id, type: 'focus_block', blockId: firstBlock.id });
      }
      continue;
    }
    if (action.type === 'add_page') {
      const outcome = pageMutationPlan.createdPageOutcomeByActionId.get(action.id);
      if (outcome) clientOutcomes.push(outcome);
      continue;
    }
  }

  const receiptResult: PageButtonReceiptResult = {
    insertedBlocks,
    createdPages: pageMutationPlan.createdPages,
    updatedPages: pageMutationPlan.updatedPages,
    clientOutcomes,
  };
  assertAutomationResultBound(receiptResult);
  await assertOrganizationDlpContent(db, {
    workspaceId,
    insertedBlocks: insertedBlocks.map((block) => ({ content: block.content, plainText: block.plainText })),
    createdPages: pageMutationPlan.createdPages.map((created) => ({
      title: created.title,
      properties: created.properties,
    })),
    updatedPages: pageMutationPlan.updatedPages.map((updated) => ({
      title: updated.title,
      properties: updated.properties,
    })),
    deliveries: deliveries.map((delivery) => ({
      channel: delivery.channel,
      payload: delivery.payload,
    })),
    clientOutcomes,
  });
  const receipt: AutomationExecutionReceipt = {
    id,
    workspaceId,
    sourceType: 'page_button',
    sourceId: blockId,
    triggerPageId: pageId,
    requestedBy: actor.id,
    requestHash,
    status: 'succeeded',
    result: receiptResult as unknown as Record<string, unknown>,
  };
  const {
    databaseExpectations,
    pageInsertOperations,
    pageUpdateOperations,
    propertyExpectations,
  } = pageMutationPlan;
  const operations: TransactOperation[] = [
    { table: 'automation_execution_receipts', op: 'expect', id, exists: false },
    {
      table: 'pages',
      op: 'expect',
      id: pageId,
      where: [
        ['workspaceId', '==', workspaceId],
        ['updatedAt', '==', page.updatedAt ?? null],
      ],
      exists: true,
    },
    {
      table: 'blocks',
      op: 'expect',
      id: blockId,
      where: [
        ['pageId', '==', pageId],
        ['type', '==', 'button'],
        ['updatedAt', '==', sourceBlock.updatedAt ?? null],
      ],
      exists: true,
    },
    ...databaseExpectations,
    ...propertyExpectations,
    ...clientOutcomePlan.expectations,
    ...insertedBlocks.map((block): TransactOperation => ({
      table: 'blocks',
      op: 'insert',
      data: block as unknown as Record<string, unknown>,
    })),
    ...pageInsertOperations,
    ...pageUpdateOperations,
    { table: 'automation_execution_receipts', op: 'insert', data: receipt as unknown as Record<string, unknown> },
    ...automationDeliveryOperations(deliveries),
  ];
  if (operations.length > PAGE_BUTTON_TRANSACTION_LIMIT) {
    throw Object.assign(new Error('Page button execution exceeds the bounded transaction size.'), { status: 413 });
  }
  try {
    await db.transact(operations);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    const afterConflict = await getExisting(receipts, id);
    if (afterConflict) {
      const replay = replayPageButtonResult(afterConflict, expectedReceipt);
      await ensureCreatedPageRoutes(admin, workspaceId, replay.createdPages);
      return replay;
    }
    throw Object.assign(new Error('Button target changed while the action was executing.'), { status: 409 });
  }
  await ensureCreatedPageRoutes(admin, workspaceId, pageMutationPlan.createdPages);
  return { executionId: id, replayed: false, ...receiptResult };
}

async function saveDatabaseAutomation(
  db: DbRef,
  actor: { id: string; email?: string },
  input: {
    automationId: string;
    databaseId: string;
    definition: unknown;
    expectedRevision?: number;
    workspaceId: string;
  },
) {
  const {
    automationId,
    databaseId,
    definition: rawDefinition,
    expectedRevision,
    workspaceId,
  } = input;
  const pages = db.table<Page>('pages');
  const properties = db.table<DbProperty>('db_properties');
  const definitions = db.table<DatabaseAutomationDefinition>('database_automations');
  const [database, current, propertyScan, definitionScan] = await Promise.all([
    getExisting(pages, databaseId),
    getExisting(definitions, automationId),
    listAllTruncated(properties.where('databaseId', '==', databaseId), {
      label: 'Database automation properties',
      maxItems: 100,
      pageSize: 100,
    }),
    listAllTruncated(definitions.where('databaseId', '==', databaseId), {
      label: 'Database automation definitions',
      maxItems: MAX_DATABASE_AUTOMATIONS_PER_DATABASE,
      pageSize: MAX_DATABASE_AUTOMATIONS_PER_DATABASE,
    }),
  ]);
  if (!database || database.kind !== 'database' || database.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Database was not found.'), { status: 404 });
  }
  if (database.inTrash) throw Object.assign(new Error('Database is in trash.'), { status: 400 });
  if (database.isLocked) throw Object.assign(new Error('Database is locked.'), { status: 423 });
  if (!propertyScan.complete || propertyScan.items.length > 100) {
    throw Object.assign(
      new Error('Database automation definitions support at most 100 properties.'),
      { status: 409 },
    );
  }
  if (!definitionScan.complete || definitionScan.items.length > MAX_DATABASE_AUTOMATIONS_PER_DATABASE) {
    throw Object.assign(
      new Error(`A database supports at most ${MAX_DATABASE_AUTOMATIONS_PER_DATABASE} automation definitions.`),
      { status: 409 },
    );
  }
  const databaseProperties = propertyScan.items;
  if (databaseProperties.some((property) => property.databaseId !== databaseId)) {
    throw Object.assign(new Error('Database automation property query returned invalid data.'), { status: 500 });
  }
  const definition = databaseAutomationDefinitionDocument(rawDefinition, databaseProperties);
  const viewId = definition.scope.type === 'view' ? definition.scope.viewId : undefined;
  const [role, view] = await Promise.all([
    pageAccessRole(db, database, actor.id, undefined, actor.email ?? null, {
      requireWorkspace: true,
    }),
    viewId
      ? getExisting(db.table<DbView>('db_views'), viewId)
      : Promise.resolve(undefined),
  ]);
  if (!role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit) {
    throw Object.assign(new Error('Page access required.'), { status: 403 });
  }
  if (viewId && (!view || view.databaseId !== databaseId)) {
    throw Object.assign(new Error('Database automation view was not found.'), { status: 404 });
  }

  if (current) {
    if (current.workspaceId !== workspaceId || current.databaseId !== databaseId) {
      throw Object.assign(new Error('Database automation was not found.'), { status: 404 });
    }
    if (expectedRevision === undefined) {
      throw Object.assign(new Error('expectedRevision is required to update an automation.'), { status: 409 });
    }
    if (current.revision !== expectedRevision) {
      throw Object.assign(new Error('Automation definition changed before it could be saved.'), { status: 409 });
    }
  } else {
    if (expectedRevision !== undefined) {
      throw Object.assign(new Error('Automation does not exist at the expected revision.'), { status: 409 });
    }
    if (definitionScan.items.length >= MAX_DATABASE_AUTOMATIONS_PER_DATABASE) {
      throw Object.assign(
        new Error(`A database supports at most ${MAX_DATABASE_AUTOMATIONS_PER_DATABASE} automation definitions.`),
        { status: 409 },
      );
    }
  }

  const savedAt = nowIso();
  const triggerType: DatabaseAutomationDefinition['triggerType'] = definition.trigger.type;
  const status: DatabaseAutomationDefinition['status'] = !definition.enabled
    ? 'disabled'
    : current?.status === 'paused'
      ? 'paused'
      : 'active';
  const nextRunAt = definition.trigger.type === 'schedule'
    ? status === 'active'
      ? nextDatabaseAutomationScheduleRun(definition.trigger, savedAt)
      : status === 'paused'
        ? current?.nextRunAt ?? null
        : null
    : null;
  if (triggerType === 'schedule' && status === 'active' && !nextRunAt) {
    throw Object.assign(new Error('Enabled automation schedule has no future occurrence.'), { status: 400 });
  }
  const automation: DatabaseAutomationDefinition = {
    id: automationId,
    workspaceId,
    databaseId,
    name: definition.name,
    enabled: definition.enabled,
    scopeType: definition.scope.type,
    viewId: viewId ?? null,
    triggerType,
    trigger: definition.trigger as unknown as Record<string, unknown>,
    actionDocument: definition.actionDocument as unknown as Record<string, unknown>,
    nextRunAt,
    status,
    revision: current ? current.revision + 1 : 1,
    createdBy: current?.createdBy ?? actor.id,
    updatedBy: actor.id,
    pausedAt: status === 'paused' ? current?.pausedAt ?? null : null,
    pausedReason: status === 'paused' ? current?.pausedReason ?? null : null,
    createdAt: current?.createdAt ?? savedAt,
    updatedAt: savedAt,
  };
  const databaseExpectation: TransactOperation = {
    table: 'pages',
    op: 'expect',
    id: databaseId,
    where: [
      ['workspaceId', '==', workspaceId],
      ['kind', '==', 'database'],
      ['updatedAt', '==', database.updatedAt ?? null],
    ],
    exists: true,
  };
  const viewExpectation: TransactOperation[] = viewId && view
    ? [{
        table: 'db_views',
        op: 'expect',
        id: viewId,
        where: [
          ['databaseId', '==', databaseId],
          ['updatedAt', '==', view.updatedAt ?? null],
        ],
        exists: true,
      }]
    : [];
  const definitionOperations: TransactOperation[] = current
    ? [
        {
          table: 'database_automations',
          op: 'expect',
          id: automationId,
          where: [
            ['workspaceId', '==', workspaceId],
            ['databaseId', '==', databaseId],
            ['revision', '==', expectedRevision!],
            ['triggerType', '==', current.triggerType],
            ['nextRunAt', '==', current.nextRunAt ?? null],
            ['enabled', '==', current.enabled],
            ['status', '==', current.status],
            ['updatedAt', '==', current.updatedAt ?? null],
            ['pausedAt', '==', current.pausedAt ?? null],
            ['pausedReason', '==', current.pausedReason ?? null],
          ],
          exists: true,
        },
        {
          table: 'database_automations',
          op: 'update',
          id: automationId,
          data: automation as unknown as Record<string, unknown>,
        },
      ]
    : [
        { table: 'database_automations', op: 'expect', id: automationId, exists: false },
        {
          table: 'database_automations',
          op: 'insert',
          data: automation as unknown as Record<string, unknown>,
        },
      ];
  try {
    await db.transact([
      databaseExpectation,
      ...viewExpectation,
      ...definitionOperations,
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    throw Object.assign(new Error('Automation definition changed before it could be saved.'), { status: 409 });
  }
  return automation;
}

async function listDatabaseAutomations(
  db: DbRef,
  actor: { id: string; email?: string },
  input: { databaseId: string; workspaceId: string },
) {
  const { databaseId, workspaceId } = input;
  const pages = db.table<Page>('pages');
  const definitions = db.table<DatabaseAutomationDefinition>('database_automations');
  const database = await getExisting(pages, databaseId);
  if (!database || database.kind !== 'database' || database.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Database was not found.'), { status: 404 });
  }
  if (database.inTrash) throw Object.assign(new Error('Database is in trash.'), { status: 400 });
  const role = await pageAccessRole(db, database, actor.id, undefined, actor.email ?? null, {
    requireWorkspace: true,
  });
  if (!role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit) {
    throw Object.assign(new Error('Page access required.'), { status: 403 });
  }
  const result = await requiredOrderedQuery(
    definitions.where('databaseId', '==', databaseId),
    'Database automation management lookup',
  )
    .orderBy('id', 'asc')
    .page(1)
    .limit(MAX_DATABASE_AUTOMATIONS_PER_DATABASE + 1)
    .getList();
  const automations = result.items ?? [];
  if (
    automations.length > MAX_DATABASE_AUTOMATIONS_PER_DATABASE
    || automations.some((automation) => (
      automation.workspaceId !== workspaceId || automation.databaseId !== databaseId
    ))
  ) {
    throw Object.assign(new Error('Database automation management lookup exceeded its bound.'), { status: 409 });
  }
  return { automations, complete: true };
}

async function setDatabaseAutomationEnabled(
  db: DbRef,
  actor: { id: string; email?: string },
  input: {
    automationId: string;
    databaseId: string;
    enabled: boolean;
    expectedRevision: number;
    workspaceId: string;
  },
) {
  const { automationId, databaseId, enabled, expectedRevision, workspaceId } = input;
  const pages = db.table<Page>('pages');
  const definitions = db.table<DatabaseAutomationDefinition>('database_automations');
  const [database, current] = await Promise.all([
    getExisting(pages, databaseId),
    getExisting(definitions, automationId),
  ]);
  if (!database || database.kind !== 'database' || database.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Database was not found.'), { status: 404 });
  }
  if (database.inTrash) throw Object.assign(new Error('Database is in trash.'), { status: 400 });
  if (database.isLocked) throw Object.assign(new Error('Database is locked.'), { status: 423 });
  if (!current || current.workspaceId !== workspaceId || current.databaseId !== databaseId) {
    throw Object.assign(new Error('Database automation was not found.'), { status: 404 });
  }
  const role = await pageAccessRole(db, database, actor.id, undefined, actor.email ?? null, {
    requireWorkspace: true,
  });
  if (!role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit) {
    throw Object.assign(new Error('Page access required.'), { status: 403 });
  }
  if (current.revision !== expectedRevision) {
    throw Object.assign(new Error('Automation definition changed before its state could be updated.'), { status: 409 });
  }
  if (enabled && current.status === 'paused') {
    throw Object.assign(new Error('A runtime-paused automation must be resumed explicitly.'), { status: 409 });
  }
  if (current.enabled === enabled && (
    (enabled && current.status === 'active') || (!enabled && current.status === 'disabled')
  )) return current;

  const updatedAt = nowIso();
  const nextRunAt = enabled && current.triggerType === 'schedule'
    ? nextDatabaseAutomationScheduleRun(
        current.trigger as unknown as Parameters<typeof nextDatabaseAutomationScheduleRun>[0],
        updatedAt,
      )
    : null;
  if (enabled && current.triggerType === 'schedule' && !nextRunAt) {
    throw Object.assign(new Error('Automation schedule has no future occurrence.'), { status: 409 });
  }
  const automation: DatabaseAutomationDefinition = {
    ...current,
    enabled,
    status: enabled ? 'active' : 'disabled',
    revision: current.revision + 1,
    updatedBy: actor.id,
    pausedAt: null,
    pausedReason: null,
    nextRunAt,
    updatedAt,
  };
  try {
    await db.transact([
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
      {
        table: 'database_automations',
        op: 'expect',
        id: automationId,
        where: [
          ['workspaceId', '==', workspaceId],
          ['databaseId', '==', databaseId],
          ['revision', '==', expectedRevision],
          ['enabled', '==', current.enabled],
          ['status', '==', current.status],
          ['nextRunAt', '==', current.nextRunAt ?? null],
          ['updatedAt', '==', current.updatedAt ?? null],
        ],
        exists: true,
      },
      {
        table: 'database_automations',
        op: 'update',
        id: automationId,
        data: automation as unknown as Record<string, unknown>,
      },
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    throw Object.assign(new Error('Automation definition changed before its state could be updated.'), { status: 409 });
  }
  return automation;
}

async function deleteDatabaseAutomation(
  db: DbRef,
  actor: { id: string; email?: string },
  input: {
    automationId: string;
    databaseId: string;
    expectedRevision: number;
    workspaceId: string;
  },
) {
  const { automationId, databaseId, expectedRevision, workspaceId } = input;
  const pages = db.table<Page>('pages');
  const definitions = db.table<DatabaseAutomationDefinition>('database_automations');
  const [database, current] = await Promise.all([
    getExisting(pages, databaseId),
    getExisting(definitions, automationId),
  ]);
  if (!database || database.kind !== 'database' || database.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Database was not found.'), { status: 404 });
  }
  if (database.inTrash) throw Object.assign(new Error('Database is in trash.'), { status: 400 });
  if (database.isLocked) throw Object.assign(new Error('Database is locked.'), { status: 423 });
  if (!current || current.workspaceId !== workspaceId || current.databaseId !== databaseId) {
    throw Object.assign(new Error('Database automation was not found.'), { status: 404 });
  }
  const role = await pageAccessRole(db, database, actor.id, undefined, actor.email ?? null, {
    requireWorkspace: true,
  });
  if (!role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit) {
    throw Object.assign(new Error('Page access required.'), { status: 403 });
  }
  if (current.revision !== expectedRevision) {
    throw Object.assign(new Error('Automation definition changed before it could be deleted.'), { status: 409 });
  }
  try {
    await db.transact([
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
      {
        table: 'database_automations',
        op: 'expect',
        id: automationId,
        where: [
          ['workspaceId', '==', workspaceId],
          ['databaseId', '==', databaseId],
          ['revision', '==', expectedRevision],
          ['updatedAt', '==', current.updatedAt ?? null],
        ],
        exists: true,
      },
      { table: 'database_automations', op: 'delete', id: automationId },
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    throw Object.assign(new Error('Automation definition changed before it could be deleted.'), { status: 409 });
  }
  return { automationId, deleted: true };
}

async function resumeDatabaseAutomation(
  db: DbRef,
  actor: { id: string; email?: string },
  input: {
    automationId: string;
    databaseId: string;
    expectedRevision: number;
    workspaceId: string;
  },
) {
  const { automationId, databaseId, expectedRevision, workspaceId } = input;
  const pages = db.table<Page>('pages');
  const definitions = db.table<DatabaseAutomationDefinition>('database_automations');
  const [database, current] = await Promise.all([
    getExisting(pages, databaseId),
    getExisting(definitions, automationId),
  ]);
  if (!database || database.kind !== 'database' || database.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Database was not found.'), { status: 404 });
  }
  if (database.inTrash) throw Object.assign(new Error('Database is in trash.'), { status: 400 });
  if (database.isLocked) throw Object.assign(new Error('Database is locked.'), { status: 423 });
  if (!current || current.workspaceId !== workspaceId || current.databaseId !== databaseId) {
    throw Object.assign(new Error('Database automation was not found.'), { status: 404 });
  }
  const role = await pageAccessRole(db, database, actor.id, undefined, actor.email ?? null, {
    requireWorkspace: true,
  });
  if (!role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit) {
    throw Object.assign(new Error('Page access required.'), { status: 403 });
  }
  if (current.revision !== expectedRevision) {
    throw Object.assign(new Error('Automation definition changed before it could be resumed.'), { status: 409 });
  }
  if (!current.enabled || current.status !== 'paused') {
    throw Object.assign(new Error('Only an enabled paused automation can be resumed.'), { status: 409 });
  }

  const resumedAt = nowIso();
  const nextRunAt = current.triggerType === 'schedule'
    ? nextDatabaseAutomationScheduleRun(
        current.trigger as unknown as Parameters<typeof nextDatabaseAutomationScheduleRun>[0],
        resumedAt,
      )
    : null;
  if (current.triggerType === 'schedule' && !nextRunAt) {
    throw Object.assign(new Error('Automation schedule has no future occurrence.'), { status: 409 });
  }
  const automation: DatabaseAutomationDefinition = {
    ...current,
    status: 'active',
    revision: current.revision + 1,
    updatedBy: actor.id,
    pausedAt: null,
    pausedReason: null,
    nextRunAt,
    updatedAt: resumedAt,
  };
  try {
    await db.transact([
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
      {
        table: 'database_automations',
        op: 'expect',
        id: automationId,
        where: [
          ['workspaceId', '==', workspaceId],
          ['databaseId', '==', databaseId],
          ['enabled', '==', true],
          ['status', '==', 'paused'],
          ['revision', '==', expectedRevision],
          ['triggerType', '==', current.triggerType],
          ['nextRunAt', '==', current.nextRunAt ?? null],
          ['pausedAt', '==', current.pausedAt ?? null],
          ['pausedReason', '==', current.pausedReason ?? null],
        ],
        exists: true,
      },
      {
        table: 'database_automations',
        op: 'update',
        id: automationId,
        data: automation as unknown as Record<string, unknown>,
      },
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    throw Object.assign(new Error('Automation definition changed before it could be resumed.'), { status: 409 });
  }
  return automation;
}

async function assertAutomationMaintenanceAccess(
  db: DbRef,
  actorId: string,
  workspaceId: string,
) {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace) throw Object.assign(new Error('Workspace was not found.'), { status: 404 });
  if (workspace.ownerId === actorId) return;
  let query = db.table<WorkspaceMember>('workspace_members')
    .where('workspaceId', '==', workspaceId);
  if (typeof query.where === 'function') query = query.where('userId', '==', actorId);
  const members = await query.limit(2).getList();
  const member = (members.items ?? []).find((item) => (
    item.workspaceId === workspaceId && item.userId === actorId
  ));
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    throw Object.assign(new Error('Workspace admin access required.'), { status: 403 });
  }
}

export const POST = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 128 * 1024,
  handler: async (context) => {
    const { auth, admin, email, env, request } = context as FunctionContext;
    if (!auth?.id) return jsonError(401, 'Authentication required.');
    const body = await requestJson(request);
    const action = typeof body.action === 'string' ? body.action : '';

    try {
      if (action === 'listDatabaseAutomations') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const databaseId = requireString(body.databaseId, 'databaseId');
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        return await listDatabaseAutomations(db, auth, { databaseId, workspaceId });
      }
      if (action === 'executePageButton') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const pageId = requireString(body.pageId, 'pageId');
        const blockId = requireString(body.blockId, 'blockId');
        const id = executionId(body.executionId);
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        return await executePageButton(admin, db, auth, {
          blockId,
          confirmationToken: optionalConfirmationToken(body.confirmationToken),
          executionId: id,
          pageId,
          workspaceId,
        });
      }
      if (action === 'saveDatabaseAutomation') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const databaseId = requireString(body.databaseId, 'databaseId');
        const id = automationDefinitionId(body.automationId);
        const expectedRevision = optionalExpectedRevision(body.expectedRevision);
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        const automation = await saveDatabaseAutomation(db, auth, {
          automationId: id,
          databaseId,
          definition: body.definition,
          expectedRevision,
          workspaceId,
        });
        return { automation };
      }
      if (action === 'resumeDatabaseAutomation') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const databaseId = requireString(body.databaseId, 'databaseId');
        const id = automationDefinitionId(body.automationId);
        const expectedRevision = optionalExpectedRevision(body.expectedRevision);
        if (expectedRevision === undefined) {
          throw Object.assign(new Error('expectedRevision is required to resume an automation.'), { status: 409 });
        }
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        const automation = await resumeDatabaseAutomation(db, auth, {
          automationId: id,
          databaseId,
          expectedRevision,
          workspaceId,
        });
        return { automation };
      }
      if (action === 'setDatabaseAutomationEnabled') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const databaseId = requireString(body.databaseId, 'databaseId');
        const id = automationDefinitionId(body.automationId);
        const expectedRevision = optionalExpectedRevision(body.expectedRevision);
        if (expectedRevision === undefined) {
          throw Object.assign(new Error('expectedRevision is required to update automation state.'), { status: 409 });
        }
        const enabled = requiredAutomationEnabled(body.enabled);
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        const automation = await setDatabaseAutomationEnabled(db, auth, {
          automationId: id,
          databaseId,
          enabled,
          expectedRevision,
          workspaceId,
        });
        return { automation };
      }
      if (action === 'deleteDatabaseAutomation') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const databaseId = requireString(body.databaseId, 'databaseId');
        const id = automationDefinitionId(body.automationId);
        const expectedRevision = optionalExpectedRevision(body.expectedRevision);
        if (expectedRevision === undefined) {
          throw Object.assign(new Error('expectedRevision is required to delete an automation.'), { status: 409 });
        }
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        return await deleteDatabaseAutomation(db, auth, {
          automationId: id,
          databaseId,
          expectedRevision,
          workspaceId,
        });
      }
      if (action === 'processDatabaseAutomationEvents') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        await assertAutomationMaintenanceAccess(db, auth.id, workspaceId);
        return await processDatabaseAutomationEventPass(db, workspaceId);
      }
      if (action === 'processDatabaseAutomationSchedules') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        await assertAutomationMaintenanceAccess(db, auth.id, workspaceId);
        return await processDatabaseAutomationSchedulePass(db, workspaceId);
      }
      if (action === 'processDatabaseAutomationDeliveries') {
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const db = boundedDbFromWorkspaceHint(admin, workspaceId);
        await assertAutomationMaintenanceAccess(db, auth.id, workspaceId);
        return await processDatabaseAutomationDeliveryPass(db, workspaceId, { email, env });
      }
      if (action !== 'executeDatabaseButton') {
        return jsonError(400, 'Unknown automation mutation action.');
      }
      const workspaceId = requireString(body.workspaceId, 'workspaceId');
      const databaseId = requireString(body.databaseId, 'databaseId');
      const rowId = requireString(body.rowId, 'rowId');
      const propertyId = requireString(body.propertyId, 'propertyId');
      const id = executionId(body.executionId);
      const confirmationToken = optionalConfirmationToken(body.confirmationToken);
      const db = boundedDbFromWorkspaceHint(admin, workspaceId);
      const receipts = db.table<AutomationExecutionReceipt>('automation_execution_receipts');
      const expectedReceipt = { databaseId, propertyId, requestedBy: auth.id, rowId };
      const existingReceipt = await getExisting(receipts, id);
      if (existingReceipt) {
        const replay = replayDatabaseButtonResult(existingReceipt, expectedReceipt);
        await ensureCreatedPageRoutes(admin, workspaceId, replay.createdPages);
        return replay;
      }

      const pages = db.table<Page>('pages');
      const properties = db.table<DbProperty>('db_properties');
      const [database, row, sourceProperty, propertyScan] = await Promise.all([
        getExisting(pages, databaseId),
        getExisting(pages, rowId),
        getExisting(properties, propertyId),
        listAllTruncated(properties.where('databaseId', '==', databaseId), {
          label: 'Database button properties',
          maxItems: 100,
          pageSize: 100,
        }),
      ]);
      if (!database || database.kind !== 'database' || database.workspaceId !== workspaceId) {
        throw Object.assign(new Error('Database was not found.'), { status: 404 });
      }
      if (database.inTrash) throw Object.assign(new Error('Database is in trash.'), { status: 400 });
      if (database.isLocked) throw Object.assign(new Error('Database is locked.'), { status: 423 });
      if (
        !row
        || row.workspaceId !== workspaceId
        || row.parentType !== 'database'
        || row.parentId !== databaseId
        || row.kind === 'database'
      ) {
        throw Object.assign(new Error('Database row was not found.'), { status: 404 });
      }
      if (row.inTrash) throw Object.assign(new Error('Database row is in trash.'), { status: 400 });
      if (row.isLocked) throw Object.assign(new Error('Database row is locked.'), { status: 423 });
      if (!sourceProperty || sourceProperty.databaseId !== databaseId || sourceProperty.type !== 'button') {
        throw Object.assign(new Error('Database button property was not found.'), { status: 404 });
      }
      if (!propertyScan.complete || propertyScan.items.length > 100) {
        throw Object.assign(new Error('Database button execution supports at most 100 properties.'), { status: 409 });
      }
      const databaseProperties = propertyScan.items;
      const role = await pageAccessRole(db, row, auth.id, undefined, auth.email ?? null, { requireWorkspace: true });
      if (!role || pageAccessRoleRanks[role] < pageAccessRoleRanks.edit) {
        throw Object.assign(new Error('Page access required.'), { status: 403 });
      }
      const document = databaseButtonActionDocument(sourceProperty, databaseProperties);
      if (!document) throw Object.assign(new Error('Database button has no configured actions.'), { status: 400 });
      const unsupportedAction = document.actions.find((item) => (
        item.type !== 'define_variables'
        && item.type !== 'edit_property'
        && item.type !== 'add_page'
        && item.type !== 'edit_pages'
        && !isAutomationDeliveryAction(item)
        && item.type !== 'show_confirmation'
        && item.type !== 'open_page'
        && item.type !== 'open_form'
        && item.type !== 'open_url'
      ));
      if (unsupportedAction) {
        throw Object.assign(
          new Error(`Database button action is not executable yet: ${unsupportedAction.type}.`),
          { status: 409 },
        );
      }
      const requestHash = await automationRequestHash({
        databaseId,
        document,
        propertyId,
        rowId,
      });
      const expectedConfirmationToken = await automationRequestHash({ executionId: id, requestHash });
      const challenge = buttonConfirmationChallenge(
        id,
        document.actions,
        expectedConfirmationToken,
        confirmationToken,
      );
      if (challenge) {
        assertAutomationResultBound(challenge);
        return challenge;
      }
      const executedAt = nowIso();
      const mutationId = `automation:${id}`;
      const [clientOutcomePlan, pageMutationPlan, deliveries] = await Promise.all([
        buttonClientOutcomePlan(db, workspaceId, auth, document.actions),
        prepareButtonPageMutations(db, pages, properties, auth, {
          actions: document.actions,
          allowTriggerPageEdits: true,
          executedAt,
          knownSourceDatabase: database,
          knownSourceProperties: databaseProperties,
          mutationId,
          sourceDatabaseId: databaseId,
          triggerPage: row,
          workspaceId,
        }),
        Promise.all(document.actions.filter(isAutomationDeliveryAction).map((action) => (
          automationDeliveryRecord({
            action,
            workspaceId,
            ownerPageId: databaseId,
            sourceType: 'database_button',
            sourceId: propertyId,
            executionId: id,
            databaseId,
            scheduledFor: executedAt,
          })
        ))),
      ]);
      const clientOutcomes = document.actions.flatMap((item) => {
        const createdOutcome = pageMutationPlan.createdPageOutcomeByActionId.get(item.id);
        if (createdOutcome) return [createdOutcome];
        const outcome = clientOutcomePlan.outcomeByActionId.get(item.id);
        return outcome ? [outcome] : [];
      });
      const changedPropertyIds = pageMutationPlan.triggerChangedPropertyIds;
      const hasRowChanges = changedPropertyIds.length > 0;
      const rowIndexScan = hasRowChanges
        ? await listAllTruncated(
            narrowWhere(
              db.table<DbPropertyIndex>('db_property_indexes').where('databaseId', '==', databaseId),
              'rowId',
              rowId,
            ),
            {
              label: 'Database button row indexes',
              maxItems: 100,
              pageSize: 100,
            },
          )
        : { items: [] as DbPropertyIndex[], complete: true };
      if (!rowIndexScan.complete || rowIndexScan.items.length > 100) {
        throw Object.assign(new Error('Database button row index set exceeds the 100-property bound.'), { status: 409 });
      }
      const rowIndexes = rowIndexScan.items;
      const updatedRow = pageMutationPlan.triggerPage;
      const receiptResult = {
        row: updatedRow,
        createdPages: pageMutationPlan.createdPages,
        updatedPages: pageMutationPlan.updatedPages,
        clientOutcomes,
      };
      assertAutomationResultBound(receiptResult);
      await assertOrganizationDlpContent(db, {
        workspaceId,
        ...(hasRowChanges ? {
          title: updatedRow.title,
          properties: updatedRow.properties,
        } : {}),
        createdPages: pageMutationPlan.createdPages.map((created) => ({
          title: created.title,
          properties: created.properties,
        })),
        updatedPages: pageMutationPlan.updatedPages.map((updated) => ({
          title: updated.title,
          properties: updated.properties,
        })),
        deliveries: deliveries.map((delivery) => ({
          channel: delivery.channel,
          payload: delivery.payload,
        })),
        clientOutcomes,
      });
      const receipt: AutomationExecutionReceipt = {
        id,
        workspaceId,
        databaseId,
        sourceType: 'database_button',
        sourceId: propertyId,
        triggerPageId: rowId,
        requestedBy: auth.id,
        requestHash,
        status: 'succeeded',
        result: receiptResult,
      };
      const targetPropertyIds = new Set(changedPropertyIds);
      const targetPropertyExpectations: TransactOperation[] = databaseProperties
        .filter((property) => targetPropertyIds.has(property.id) && property.id !== sourceProperty.id)
        .map((property) => ({
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
      const existingIndexes = new Map(
        rowIndexes
          .filter((index) => index.databaseId === databaseId)
          .map((index) => [index.propertyId, index]),
      );
      const indexOperations: TransactOperation[] = hasRowChanges
        ? databaseProperties.flatMap((property): TransactOperation[] => {
            const existing = existingIndexes.get(property.id);
            const indexId = existing?.id ?? newId();
            const data = JSON.parse(JSON.stringify(
              databasePropertyIndexRecord(updatedRow, property, indexId),
            )) as Record<string, unknown>;
            if (existing) {
              return [
                {
                  table: 'db_property_indexes',
                  op: 'expect',
                  id: existing.id,
                  where: [['updatedAt', '==', existing.updatedAt ?? null]],
                  exists: true,
                },
                { table: 'db_property_indexes', op: 'update', id: existing.id, data },
              ];
            }
          return [
            { table: 'db_property_indexes', op: 'expect', id: indexId, exists: false },
            { table: 'db_property_indexes', op: 'insert', data },
          ];
          })
        : [];
      const operations: TransactOperation[] = [
        { table: 'automation_execution_receipts', op: 'expect', id, exists: false },
        {
          table: 'pages',
          op: 'expect',
          id: database.id,
          where: [['updatedAt', '==', database.updatedAt ?? null]],
          exists: true,
        },
        ...targetPropertyExpectations,
        ...pageMutationPlan.databaseExpectations.filter((operation) => (
          !('id' in operation) || operation.id !== database.id
        )),
        ...pageMutationPlan.propertyExpectations.filter((operation) => (
          !('id' in operation) || typeof operation.id !== 'string' || !targetPropertyIds.has(operation.id)
        )),
        ...clientOutcomePlan.expectations,
        {
          table: 'db_properties',
          op: 'expect',
          id: sourceProperty.id,
          where: [
            ['databaseId', '==', databaseId],
            ['type', '==', 'button'],
            ['updatedAt', '==', sourceProperty.updatedAt ?? null],
          ],
          exists: true,
        },
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
        ...(hasRowChanges ? [
          {
            table: 'pages',
            op: 'update',
            id: row.id,
            data: {
              lastEditedBy: auth.id,
              lastMutationId: mutationId,
              properties: updatedRow.properties,
              title: updatedRow.title,
              updatedAt: executedAt,
            },
          },
          {
            table: 'database_automation_events',
            op: 'insert',
            data: {
              id: newId(),
              workspaceId,
              databaseId,
              rowId: row.id,
              triggerKind: 'properties_edited',
              origin: 'button',
              mutationId,
              changedPropertyIds,
              occurredAt: executedAt,
              state: 'pending',
            },
          },
        ] satisfies TransactOperation[] : []),
        ...pageMutationPlan.pageInsertOperations,
        ...pageMutationPlan.pageUpdateOperations,
        {
          table: 'automation_execution_receipts',
          op: 'insert',
          data: receipt as unknown as Record<string, unknown>,
        },
        ...automationDeliveryOperations(deliveries),
        ...indexOperations,
      ];

      if (operations.length > DATABASE_BUTTON_TRANSACTION_LIMIT) {
        throw Object.assign(new Error('Database button execution exceeds the bounded transaction size.'), {
          status: 413,
        });
      }

      try {
        await db.transact(operations);
      } catch (error) {
        if (!transactionConflict(error)) throw error;
        const afterConflict = await getExisting(receipts, id);
        if (afterConflict) {
          const replay = replayDatabaseButtonResult(afterConflict, expectedReceipt);
          await ensureCreatedPageRoutes(admin, workspaceId, replay.createdPages);
          return replay;
        }
        throw Object.assign(new Error('Button target changed while the action was executing.'), { status: 409 });
      }
      await ensureCreatedPageRoutes(admin, workspaceId, pageMutationPlan.createdPages);
      return {
        executionId: id,
        replayed: false,
        ...receiptResult,
      };
    } catch (error) {
      const { status, message } = errorStatus(error);
      return jsonError(status, message);
    }
  },
});
