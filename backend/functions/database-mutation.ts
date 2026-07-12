import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { MAX_RAW_TRANSACT_OPS, boundedDbFromPageHint, boundedDbFromWorkspaceHint, ensurePageWorkspaceIndex, type AdminDbAccessor } from '../lib/workspace-db';
import {
  ensureDatabasePropertyIndexes,
  upsertDatabaseIndexesForRows,
} from '../lib/database-index';
import {
  pageAccessRole as sharedPageAccessRole,
  workspaceAccessRole as sharedWorkspaceAccessRole,
} from '../lib/page-access';

import {
  bestEffort,
  isNotFoundError,
  listAll,
  requireStringRaw as requireString,
  nowIso,
  newId,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from '../lib/table-utils';
import type { ShareRole } from '../lib/page-access';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';
import {
  assertFileTargetsNotDeleting,
  withFileWorkspaceLease,
} from '../lib/file-operation-lock';
import {
  assertNoUnownedStoredFileReferences,
  fileReferenceTransitionOperations,
  hasPotentialStoredFileReference,
  schemaFilePropertyReferences,
  storedFileReferencesChanged,
  updateWithFileReferenceLifecycle,
} from '../lib/file-reference-lifecycle';

type DatabaseTable = 'db_properties' | 'db_views' | 'db_templates';
type PageParentType = 'workspace' | 'page' | 'database';
type StarterViewType = 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'timeline';

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType;
  kind?: 'page' | 'database';
  title?: string;
  icon?: string;
  iconType?: 'none' | 'emoji' | 'image';
  font?: 'default' | 'serif' | 'mono';
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: 'default' | 'expanded' | 'off';
  pageCommentsDisplay?: 'default' | 'expanded' | 'off';
  properties?: Record<string, unknown>;
  isFavorite?: boolean;
  inTrash?: boolean;
  position?: number;
  createdBy?: string;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface DbProperty {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  position: number;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface DbView {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

interface DbTemplate {
  id: string;
  databaseId: string;
  name: string;
  icon?: string;
  title?: string;
  properties?: Record<string, unknown>;
  blocks?: unknown[];
  isDefault?: boolean;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

type DatabaseRecord = DbProperty | DbView | DbTemplate;
type DatabasePatch = Partial<DbProperty & DbView & DbTemplate>;

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  admin: {
    db(namespace: string): DbRef;
  };
}

const tableNames = new Set<DatabaseTable>(['db_properties', 'db_views', 'db_templates']);
const optionPropertyTypes = new Set(['select', 'multi_select', 'status']);
const propertyTypes = new Set([
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'checkbox',
  'url',
  'email',
  'phone',
  'files',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'relation',
  'rollup',
  'formula',
  'unique_id',
]);
const rollupFunctions = new Set([
  'show_original',
  'count_all',
  'count_values',
  'count_unique',
  'count_empty',
  'percent_empty',
  'percent_not_empty',
  'checked',
  'unchecked',
  'percent_checked',
  'percent_unchecked',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest_date',
  'latest_date',
  'date_range',
]);
const formulaFunctions = new Set([
  'prop',
  'if',
  'ifs',
  'let',
  'lets',
  'concat',
  'repeat',
  'format',
  'toNumber',
  'add',
  'subtract',
  'multiply',
  'divide',
  'mod',
  'pow',
  'min',
  'max',
  'sum',
  'mean',
  'median',
  'sqrt',
  'cbrt',
  'exp',
  'ln',
  'log10',
  'log2',
  'sign',
  'pi',
  'e',
  'lower',
  'upper',
  'trim',
  'startsWith',
  'endsWith',
  'substring',
  'replace',
  'replaceAll',
  'test',
  'now',
  'today',
  'dateAdd',
  'dateSubtract',
  'dateBetween',
  'dateRange',
  'parseDate',
  'dateStart',
  'dateEnd',
  'timestamp',
  'fromTimestamp',
  'formatDate',
  'year',
  'month',
  'day',
  'date',
  'week',
  'hour',
  'minute',
  'round',
  'floor',
  'ceil',
  'abs',
  'empty',
  'contains',
  'length',
  'not',
  'and',
  'or',
]);
const formulaLiterals = new Set(['true', 'false', 'null']);
const starterViewTypes = new Set<StarterViewType>([
  'table',
  'board',
  'list',
  'gallery',
  'calendar',
  'timeline',
]);
const optionColors = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const validOptionColors = new Set(['default', ...optionColors]);
const tableDatabaseField: Record<DatabaseTable, keyof DatabaseRecord> = {
  db_properties: 'databaseId',
  db_views: 'databaseId',
  db_templates: 'databaseId',
};

const patchKeys: Record<DatabaseTable, Set<string>> = {
  db_properties: new Set(['name', 'description', 'type', 'config', 'position']),
  db_views: new Set(['name', 'type', 'config', 'position']),
  db_templates: new Set(['name', 'icon', 'title', 'properties', 'blocks', 'isDefault', 'position']),
};

function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request) return {};
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseTable(value: unknown): DatabaseTable {
  if (!tableNames.has(value as DatabaseTable)) {
    throw new Error('table must be db_properties, db_views, or db_templates.');
  }
  return value as DatabaseTable;
}

function cleanRecord<T extends DatabaseRecord>(record: Record<string, unknown>): Partial<T> {
  const next = { ...record };
  delete next.createdAt;
  delete next.updatedAt;
  return next as Partial<T>;
}

function cleanPatch(table: DatabaseTable, patch: Record<string, unknown>): DatabasePatch {
  const allowed = patchKeys[table];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.has(key) && value !== undefined) out[key] = value;
  }
  return out as DatabasePatch;
}

function templateFileReferences(
  template: Pick<DbTemplate, 'icon' | 'properties' | 'blocks'>,
  filePropertyIds: Iterable<string> = [],
) {
  return {
    icon: template.icon,
    properties: template.properties,
    schemaFileProperties: schemaFilePropertyReferences(template.properties, filePropertyIds),
    blocks: template.blocks,
  };
}

async function filePropertyIdsForDatabase(db: DbRef, databaseId: string) {
  const properties = await listAll(
    db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId),
  );
  return properties.filter((property) => property.type === 'files').map((property) => property.id);
}

async function filePropertyIdsForDatabases(db: DbRef, databaseIds: Iterable<string>) {
  const entries = await Promise.all(
    Array.from(new Set(databaseIds)).map(async (databaseId) => [
      databaseId,
      await filePropertyIdsForDatabase(db, databaseId),
    ] as const),
  );
  return new Map(entries);
}

function templateFileAssociation(
  template: Pick<DbTemplate, 'id' | 'databaseId'>,
  filePropertyIds: Iterable<string> = [],
) {
  const fileProperties = new Set(filePropertyIds);
  return {
    field: 'templateId' as const,
    id: template.id,
    // Pre-templateId rows were scoped only to their database. Include those
    // as a legacy fallback, but never absorb another template's explicit row.
    legacy: {
      field: 'databaseId' as const,
      id: template.databaseId,
      filter: (upload: {
        templateId?: string | null;
        pageId?: string | null;
        blockId?: string | null;
        propertyId?: string | null;
      }) => !upload.templateId
        && !upload.pageId
        && !upload.blockId
        && (!upload.propertyId || fileProperties.has(upload.propertyId)),
    },
  };
}

function databaseIdFromRecord(table: DatabaseTable, record: Record<string, unknown>) {
  return requireString(record[tableDatabaseField[table] as string], 'databaseId');
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function recordInput(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExpectedDatabase(existing: DatabaseRecord, expectedDatabaseId?: string | null) {
  if (expectedDatabaseId && existing.databaseId !== expectedDatabaseId) {
    throw new Error('Database record does not belong to the expected database.');
  }
}

function parseCreateParentType(value: unknown, parentId: string | null): PageParentType {
  if (value === undefined || value === null || value === '') return parentId ? 'page' : 'workspace';
  if (value !== 'workspace' && value !== 'page') {
    throw new Error('Databases can only be placed in workspace or page parents.');
  }
  return value;
}

function parseStarterViewType(value: unknown): StarterViewType {
  if (value === undefined || value === null || value === '') return 'table';
  if (!starterViewTypes.has(value as StarterViewType)) {
    throw new Error('Unsupported starter database view type.');
  }
  return value as StarterViewType;
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positionBetween(after?: number, before?: number) {
  if (typeof after !== 'number' && typeof before !== 'number') return 1;
  if (typeof after !== 'number') return (before ?? 1) - 1;
  if (typeof before !== 'number') return after + 1;
  return (after + before) / 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function omitRecordKey(record: unknown, key: string) {
  if (!isRecord(record) || !(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return Object.keys(next).length ? next : undefined;
}

function filterGroupHasTerms(group: Record<string, unknown>): boolean {
  return (
    (Array.isArray(group.filters) && group.filters.length > 0) ||
    (Array.isArray(group.groups) && group.groups.some((item) => isRecord(item) && filterGroupHasTerms(item)))
  );
}

function filterGroupWithoutProperty(group: unknown, propertyId: string): Record<string, unknown> | undefined {
  if (!isRecord(group)) return undefined;
  const next: Record<string, unknown> = {
    ...group,
    filters: Array.isArray(group.filters)
      ? group.filters.filter((filter) => !isRecord(filter) || filter.propertyId !== propertyId)
      : [],
  };
  if (Array.isArray(group.groups)) {
    next.groups = group.groups
      .map((item) => filterGroupWithoutProperty(item, propertyId))
      .filter((item): item is Record<string, unknown> => !!item && filterGroupHasTerms(item));
  }
  return filterGroupHasTerms(next) ? next : undefined;
}

function quickFilterWithoutProperty(
  filter: unknown,
  propertyId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(filter)) return undefined;
  if ('propertyId' in filter) return filter.propertyId === propertyId ? undefined : filter;
  return filterGroupWithoutProperty(filter, propertyId);
}

function viewConfigWithoutProperty(config: unknown, propertyId: string) {
  const next: Record<string, unknown> = isRecord(config) ? { ...config } : {};
  if (Array.isArray(next.visibleProperties)) {
    next.visibleProperties = next.visibleProperties.filter((id) => id !== propertyId);
  }
  if (Array.isArray(next.hiddenProperties)) {
    next.hiddenProperties = next.hiddenProperties.filter((id) => id !== propertyId);
  }
  if (Array.isArray(next.propertyOrder)) {
    next.propertyOrder = next.propertyOrder.filter((id) => id !== propertyId);
  }
  if (Array.isArray(next.rowPagePropertyOrder)) {
    next.rowPagePropertyOrder = next.rowPagePropertyOrder.filter((id) => id !== propertyId);
  }
  const propertyWidths = omitRecordKey(next.propertyWidths, propertyId);
  if (propertyWidths === undefined) delete next.propertyWidths;
  else next.propertyWidths = propertyWidths;
  const tableCalculations = omitRecordKey(next.tableCalculations, propertyId);
  if (tableCalculations === undefined) delete next.tableCalculations;
  else next.tableCalculations = tableCalculations;
  if (Array.isArray(next.filters)) {
    next.filters = next.filters.filter((filter) => !isRecord(filter) || filter.propertyId !== propertyId);
  }
  if (next.filterGroup) {
    const filterGroup = filterGroupWithoutProperty(next.filterGroup, propertyId);
    if (filterGroup) next.filterGroup = filterGroup;
    else delete next.filterGroup;
  }
  if (Array.isArray(next.quickFilters)) {
    next.quickFilters = next.quickFilters
      .map((filter) => quickFilterWithoutProperty(filter, propertyId))
      .filter((filter): filter is Record<string, unknown> => !!filter);
  }
  if (Array.isArray(next.sorts)) {
    next.sorts = next.sorts.filter((sort) => !isRecord(sort) || sort.propertyId !== propertyId);
  }
  if (Array.isArray(next.wrappedColumns)) {
    next.wrappedColumns = next.wrappedColumns.filter((id) => id !== propertyId);
  }
  for (const key of [
    'groupBy',
    'calendarBy',
    'timelineBy',
    'timelineEndBy',
    'dependencyProperty',
    'coverProperty',
    'subGroupBy',
    'chartGroupBy',
    'chartAggregateBy',
    'templateLinkedRelationPropertyId',
  ]) {
    if (next[key] === propertyId) delete next[key];
  }
  return next;
}

function jsonChanged(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

async function getExisting<T>(
  tableRef: TableRef<T>,
  id: string,
): Promise<T | null> {
  try {
    return await tableRef.getOne(id);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function getExistingRow<T>(tableRef: TableRef<T>, id: string): Promise<T | null> {
  try {
    return await tableRef.getOne(id);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

// Role resolution is canonical in lib/page-access; these wrappers only pin
// this function's "missing workspace is an error" contract.
async function workspaceRole(db: DbRef, workspaceId: string, actorId: string): Promise<ShareRole | undefined> {
  return sharedWorkspaceAccessRole(db, workspaceId, actorId, { requireWorkspace: true });
}

async function assertWorkspaceEdit(db: DbRef, workspaceId: string, actorId: string) {
  const role = await workspaceRole(db, workspaceId, actorId);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Workspace access required.');
}

async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
}

async function assertCanEditPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Page access required.');
}

async function assertDatabaseWritable(
  db: DbRef,
  pages: TableRef<Page>,
  databaseId: string,
  actorId: string,
  actorEmail?: string | null,
) {
  const page = await getExistingRow(pages, databaseId);
  if (!page) throw new Error('Database was not found.');
  if (page.kind !== 'database') throw new Error('Page is not a database.');
  if (page.inTrash) throw new Error('Database is in trash.');
  await assertCanEditPage(db, page, actorId, actorEmail);
  if (page.isLocked) throw new Error('Database is locked.');
  return page;
}

async function propertiesForDatabase(
  properties: TableRef<DbProperty>,
  databaseId: string,
): Promise<DbProperty[]> {
  return listAll(properties.where('databaseId', '==', databaseId));
}

function relationTargetDatabaseId(prop: DbProperty) {
  return typeof prop.config?.relationDatabaseId === 'string' && prop.config.relationDatabaseId.trim()
    ? prop.config.relationDatabaseId.trim()
    : prop.databaseId;
}

function configString(config: Record<string, unknown> | undefined, key: string) {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function skipFormulaString(expression: string, index: number) {
  const quote = expression[index];
  let i = index + 1;
  while (i < expression.length) {
    if (expression[i] === '\\') {
      i += 2;
      continue;
    }
    if (expression[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error('Formula string literal is not closed.');
}

function readFormulaString(expression: string, index: number) {
  const quote = expression[index];
  let i = index + 1;
  let value = '';
  while (i < expression.length) {
    if (expression[i] === '\\') {
      if (i + 1 < expression.length) value += expression[i + 1];
      i += 2;
      continue;
    }
    if (expression[i] === quote) return { value, end: i + 1 };
    value += expression[i];
    i += 1;
  }
  throw new Error('Formula string literal is not closed.');
}

function formulaCallArgs(expression: string, openIndex: number) {
  const args: string[] = [];
  let start = openIndex + 1;
  let depth = 0;
  let i = openIndex + 1;

  while (i < expression.length) {
    const ch = expression[i];
    if (ch === '"' || ch === "'") {
      i = skipFormulaString(expression, i);
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) {
        args.push(expression.slice(start, i).trim());
        return { args, end: i + 1 };
      }
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(expression.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }

  throw new Error('Formula parentheses are not balanced.');
}

function formulaVariableName(arg: string) {
  const value = arg.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
  if (value[0] === '"' || value[0] === "'") {
    try {
      const parsed = readFormulaString(value, 0);
      return parsed.end === value.length && /^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.value) ? parsed.value : '';
    } catch {
      return '';
    }
  }
  return '';
}

function formulaVariables(expression: string) {
  const variables = new Set<string>();
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (ch === '"' || ch === "'") {
      i = skipFormulaString(expression, i);
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    while (i < expression.length && /[A-Za-z0-9_]/.test(expression[i])) i += 1;
    const name = expression.slice(start, i);
    let next = i;
    while (next < expression.length && /\s/.test(expression[next])) next += 1;
    if ((name === 'let' || name === 'lets') && expression[next] === '(') {
      const call = formulaCallArgs(expression, next);
      if (name === 'let') {
        const variable = formulaVariableName(call.args[0] ?? '');
        if (variable) variables.add(variable);
      } else {
        for (let argIndex = 0; argIndex + 2 < call.args.length; argIndex += 2) {
          const variable = formulaVariableName(call.args[argIndex] ?? '');
          if (variable) variables.add(variable);
        }
      }
      i = call.end;
    }
  }
  return variables;
}

function formulaPropRefs(expression: string) {
  const refs: string[] = [];
  const variables = formulaVariables(expression);
  let depth = 0;
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipFormulaString(expression, i);
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) throw new Error('Formula parentheses are not balanced.');
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < expression.length && /[A-Za-z0-9_]/.test(expression[i])) i += 1;
      const name = expression.slice(start, i);
      let next = i;
      while (next < expression.length && /\s/.test(expression[next])) next += 1;
      if (expression[next] === '(') {
        if (!formulaFunctions.has(name)) throw new Error(`Unsupported formula function: ${name}.`);
        if (name === 'prop') {
          let arg = next + 1;
          while (arg < expression.length && /\s/.test(expression[arg])) arg += 1;
          if (expression[arg] !== '"' && expression[arg] !== "'") {
            throw new Error('Formula prop() requires a quoted property name or id.');
          }
          refs.push(readFormulaString(expression, arg).value);
        }
      } else if (!formulaLiterals.has(name) && !variables.has(name)) {
        throw new Error(`Unsupported formula identifier: ${name}.`);
      }
      continue;
    }
    i += 1;
  }

  if (depth !== 0) throw new Error('Formula parentheses are not balanced.');
  return refs;
}

function assertFormulaConfig(prop: DbProperty, sourceProps: DbProperty[]) {
  const formula = prop.config?.formula;
  if (formula == null) return;
  if (typeof formula !== 'string') {
    throw new Error(`Formula config must be a string for property ${prop.name || prop.id}.`);
  }
  const expression = formula.trim();
  if (!expression) return;
  if (expression.length > 4000) {
    throw new Error(`Formula config is too long for property ${prop.name || prop.id}.`);
  }

  for (const ref of formulaPropRefs(expression)) {
    const target = sourceProps.find((item) => item.name === ref || item.id === ref);
    if (!target) throw new Error(`Formula references unknown property "${ref}" for ${prop.name || prop.id}.`);
    if (target.id === prop.id) throw new Error(`Formula cannot reference itself: ${prop.name || prop.id}.`);
    if (target.type === 'formula' || target.type === 'rollup') {
      throw new Error(`Formula cannot reference ${target.type} property "${target.name || target.id}".`);
    }
  }
}

async function assertRelationConfig(
  pages: TableRef<Page>,
  database: Page,
  prop: DbProperty,
) {
  const targetDbId = relationTargetDatabaseId(prop);
  // A createDatabase transaction validates its complete schema before the new
  // database page exists. Self-relations can use the in-memory candidate;
  // external relation targets still require a durable page lookup.
  const target = targetDbId === database.id
    ? database
    : await getExistingRow(pages, targetDbId);
  if (!target || target.kind !== 'database' || target.inTrash) {
    throw new Error(`Relation target database was not found for property ${prop.name || prop.id}.`);
  }
  if (target.workspaceId !== database.workspaceId) {
    throw new Error(`Relation target database is outside the property workspace: ${prop.name || prop.id}.`);
  }
}

async function assertRollupConfig(
  pages: TableRef<Page>,
  properties: TableRef<DbProperty>,
  database: Page,
  prop: DbProperty,
  sourceProps: DbProperty[],
  propsByDb: Map<string, DbProperty[]>,
) {
  const config = prop.config ?? {};
  const fn = typeof config.rollupFunction === 'string' ? config.rollupFunction : 'show_original';
  if (!rollupFunctions.has(fn)) {
    throw new Error(`Invalid rollup function for property ${prop.name || prop.id}.`);
  }

  const relationPropId = configString(config, 'rollupRelationPropertyId');
  if (!relationPropId) return;
  const relationProp = sourceProps.find((item) => item.id === relationPropId);
  if (!relationProp || relationProp.type !== 'relation') {
    throw new Error(`Rollup relation property must be a relation on ${prop.name || prop.id}.`);
  }
  await assertRelationConfig(pages, database, relationProp);

  const targetDbId = relationTargetDatabaseId(relationProp);
  let targetProps = propsByDb.get(targetDbId);
  if (!targetProps) {
    targetProps = await propertiesForDatabase(properties, targetDbId);
    propsByDb.set(targetDbId, targetProps);
  }

  const targetPropId = configString(config, 'rollupTargetPropertyId');
  if (targetPropId && !targetProps.some((item) => item.id === targetPropId)) {
    throw new Error(`Rollup target property was not found for property ${prop.name || prop.id}.`);
  }

  const viaId = configString(config, 'rollupVia');
  if (!viaId) return;
  const targetProp = targetPropId ? targetProps.find((item) => item.id === targetPropId) : undefined;
  if (targetProp && targetProp.type !== 'relation' && targetProp.type !== 'rollup') {
    throw new Error(`rollupVia can only be used when the rollup target is a relation or rollup property.`);
  }
  const via = targetProps.find((item) => item.id === viaId);
  if (!via || via.type !== 'relation') {
    throw new Error(`rollupVia must point to a relation property for ${prop.name || prop.id}.`);
  }
  await assertRelationConfig(pages, { ...database, id: targetDbId }, via);
}

async function validatePropertyRecord(
  pages: TableRef<Page>,
  properties: TableRef<DbProperty>,
  database: Page,
  prop: DbProperty,
  sourcePropsOverride?: DbProperty[],
) {
  if (!propertyTypes.has(prop.type)) {
    throw new Error(`Unsupported database property type: ${prop.type}.`);
  }
  if (prop.databaseId !== database.id) {
    throw new Error('Property databaseId does not match the target database.');
  }
  const sourceProps = sourcePropsOverride ?? (await propertiesForDatabase(properties, database.id));
  const propsByDb = new Map<string, DbProperty[]>([[database.id, sourceProps]]);

  propertyOptionIds(prop);

  if (prop.type === 'relation') {
    await assertRelationConfig(pages, database, prop);
  }
  if (prop.type === 'rollup') {
    await assertRollupConfig(pages, properties, database, prop, sourceProps, propsByDb);
  }
  if (prop.type === 'formula') {
    assertFormulaConfig(prop, sourceProps);
  }
}

function propertyOptionIds(prop: DbProperty) {
  if (!optionPropertyTypes.has(prop.type)) return new Set<string>();
  const options = prop.config?.options;
  if (options === undefined) return new Set<string>();
  if (!Array.isArray(options)) {
    throw new Error(`Property options must be an array for ${prop.name || prop.id}.`);
  }
  const ids = new Set<string>();
  for (const option of options) {
    if (!isRecord(option) || typeof option.id !== 'string' || !option.id.trim()) {
      throw new Error(`Every property option must have an id for ${prop.name || prop.id}.`);
    }
    if (option.id !== option.id.trim()) {
      throw new Error(`Property option ids cannot contain surrounding whitespace for ${prop.name || prop.id}.`);
    }
    if (typeof option.name !== 'string' || !option.name.trim()) {
      throw new Error(`Every property option must have a name for ${prop.name || prop.id}.`);
    }
    if (typeof option.color !== 'string' || !validOptionColors.has(option.color)) {
      throw new Error(`Every property option must have a supported color for ${prop.name || prop.id}.`);
    }
    const id = option.id;
    if (ids.has(id)) {
      throw new Error(`Property option ids must be unique for ${prop.name || prop.id}.`);
    }
    ids.add(id);
  }
  return ids;
}

function assertNoPropertyOptionRemoval(current: DbProperty, next: DbProperty) {
  if (current.type !== next.type || !optionPropertyTypes.has(current.type)) return;
  const currentIds = propertyOptionIds(current);
  const nextIds = propertyOptionIds(next);
  for (const id of currentIds) {
    if (nextIds.has(id)) continue;
    throw Object.assign(
      new Error('Database property options cannot be deleted until server-owned value cleanup is available.'),
      { status: 409 },
    );
  }
}

function collectFilterPropertyReferences(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectFilterPropertyReferences(item, out);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.propertyId === 'string' && value.propertyId.trim()) {
    out.add(value.propertyId.trim());
  }
  collectFilterPropertyReferences(value.filters, out);
  collectFilterPropertyReferences(value.groups, out);
}

function viewPropertyReferences(config: unknown) {
  const out = new Set<string>();
  if (!isRecord(config)) return out;
  for (const key of [
    'visibleProperties',
    'hiddenProperties',
    'propertyOrder',
    'rowPagePropertyOrder',
    'wrappedColumns',
  ]) {
    const values = config[key];
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === 'string' && value.trim()) out.add(value.trim());
    }
  }
  for (const key of ['propertyWidths', 'tableCalculations']) {
    const values = config[key];
    if (isRecord(values)) for (const propertyId of Object.keys(values)) out.add(propertyId);
  }
  for (const key of [
    'groupBy',
    'calendarBy',
    'timelineBy',
    'timelineEndBy',
    'dependencyProperty',
    'coverProperty',
    'subGroupBy',
    'chartGroupBy',
    'chartAggregateBy',
    'templateLinkedRelationPropertyId',
  ]) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) out.add(value.trim());
  }
  collectFilterPropertyReferences(config.filters, out);
  collectFilterPropertyReferences(config.filterGroup, out);
  collectFilterPropertyReferences(config.quickFilters, out);
  collectFilterPropertyReferences(config.sorts, out);
  return out;
}

async function validateSchemaDependentRecord(
  db: DbRef,
  table: DatabaseTable,
  record: DatabaseRecord,
) {
  if (table === 'db_properties') return;
  const schema = await propertiesForDatabase(
    db.table<DbProperty>('db_properties'),
    record.databaseId,
  );
  const propertyIds = new Set(schema.map((property) => property.id));
  if (table === 'db_views') {
    for (const propertyId of viewPropertyReferences((record as DbView).config)) {
      if (!propertyIds.has(propertyId)) {
        throw Object.assign(
          new Error(`View references a database property that no longer exists: ${propertyId}.`),
          { status: 409 },
        );
      }
    }
    return;
  }
  const properties = (record as DbTemplate).properties;
  if (!isRecord(properties)) return;
  for (const propertyId of Object.keys(properties)) {
    if (propertyId.startsWith('__')) continue;
    if (!propertyIds.has(propertyId)) {
      throw Object.assign(
        new Error(`Template references a database property that no longer exists: ${propertyId}.`),
        { status: 409 },
      );
    }
  }
}

async function validateRecord(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  database: Page,
  record: DatabaseRecord,
) {
  if (table === 'db_properties') {
    await validatePropertyRecord(
      pages,
      db.table<DbProperty>('db_properties'),
      database,
      record as DbProperty,
    );
    return;
  }
  await validateSchemaDependentRecord(db, table, record);
}

function starterOption(name: string, color: string) {
  return { id: newId(), name, color };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function inputString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function inputBoolean(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === 'boolean' ? value : undefined;
}

function optionFromInput(value: unknown, index: number, labels: StarterDatabaseLabels) {
  const fallbackName = `${labels.option} ${index + 1}`;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const option = value as Record<string, unknown>;
    const name = typeof option.name === 'string' && option.name.trim() ? option.name.trim() : fallbackName;
    return {
      id: typeof option.id === 'string' && option.id.trim() ? option.id.trim() : newId(),
      name,
      color:
        typeof option.color === 'string' && option.color.trim()
          ? option.color.trim()
          : optionColors[index % optionColors.length],
    };
  }
  const name = typeof value === 'string' && value.trim() ? value.trim() : fallbackName;
  return { id: newId(), name, color: optionColors[index % optionColors.length] };
}

function withDisplayConfig(config: Record<string, unknown> | undefined, input: Record<string, unknown>) {
  const hideWhenEmpty = inputBoolean(input, 'hideWhenEmpty');
  const hideInPagePanel = inputBoolean(input, 'hideInPagePanel');
  if (hideWhenEmpty === undefined && hideInPagePanel === undefined) return config;
  return {
    ...(config ?? {}),
    ...(hideWhenEmpty !== undefined ? { hideWhenEmpty } : {}),
    ...(hideInPagePanel !== undefined ? { hideInPagePanel } : {}),
  };
}

function propertyConfigFromInput(
  type: string,
  input: Record<string, unknown>,
  databaseId: string,
  labels: StarterDatabaseLabels,
) {
  const rawConfig = objectValue(input.config);
  if (type === 'select' || type === 'multi_select' || type === 'status') {
    const rawOptions = Array.isArray(input.options)
      ? input.options
      : Array.isArray(rawConfig.options)
        ? rawConfig.options
        : [];
    return withDisplayConfig(
      {
        ...rawConfig,
        options: rawOptions.map((option, index) => optionFromInput(option, index, labels)),
      },
      input,
    );
  }
  if (type === 'number') {
    return withDisplayConfig(
      {
        ...rawConfig,
        numberFormat: inputString(input, 'numberFormat') ?? rawConfig.numberFormat ?? 'number',
      },
      input,
    );
  }
  if (type === 'relation') {
    return withDisplayConfig(
      {
        ...rawConfig,
        relationDatabaseId: inputString(input, 'relationDatabaseId') ?? rawConfig.relationDatabaseId ?? databaseId,
      },
      input,
    );
  }
  if (type === 'formula') {
    return withDisplayConfig(
      {
        ...rawConfig,
        formula: inputString(input, 'formula') ?? rawConfig.formula ?? '',
      },
      input,
    );
  }
  if (type === 'rollup') {
    return withDisplayConfig(
      {
        ...rawConfig,
        rollupRelationPropertyId:
          inputString(input, 'rollupRelationPropertyId') ?? rawConfig.rollupRelationPropertyId,
        rollupTargetPropertyId: inputString(input, 'rollupTargetPropertyId') ?? rawConfig.rollupTargetPropertyId,
        rollupFunction: inputString(input, 'rollupFunction') ?? rawConfig.rollupFunction ?? 'show_original',
      },
      input,
    );
  }
  if (type === 'unique_id') {
    return withDisplayConfig(
      {
        ...rawConfig,
        idPrefix: inputString(input, 'idPrefix') ?? rawConfig.idPrefix ?? '',
      },
      input,
    );
  }
  return withDisplayConfig(Object.keys(rawConfig).length ? rawConfig : undefined, input);
}

type StarterDatabaseLabels = {
  title: string;
  alternateTitle: string;
  status: string;
  tags: string;
  notStarted: string;
  inProgress: string;
  done: string;
  idea: string;
  urgent: string;
  date: string;
  option: string;
  views: Record<StarterViewType, string>;
};

const EN_STARTER_DATABASE_LABELS: StarterDatabaseLabels = {
  title: 'Name',
  alternateTitle: 'Title',
  status: 'Status',
  tags: 'Tags',
  notStarted: 'Not started',
  inProgress: 'In progress',
  done: 'Done',
  idea: 'Idea',
  urgent: 'Urgent',
  date: 'Date',
  option: 'Option',
  views: {
    table: 'Table',
    board: 'Board',
    list: 'List',
    gallery: 'Gallery',
    calendar: 'Calendar',
    timeline: 'Timeline',
  },
};

const KO_STARTER_DATABASE_LABELS: StarterDatabaseLabels = {
  title: '이름',
  alternateTitle: '제목',
  status: '상태',
  tags: '태그',
  notStarted: '시작 전',
  inProgress: '진행 중',
  done: '완료',
  idea: '아이디어',
  urgent: '긴급',
  date: '날짜',
  option: '옵션',
  views: {
    table: '표',
    board: '보드',
    list: '리스트',
    gallery: '갤러리',
    calendar: '캘린더',
    timeline: '타임라인',
  },
};

function starterDatabaseLabels(locale: unknown): StarterDatabaseLabels {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('ko')
    ? KO_STARTER_DATABASE_LABELS
    : EN_STARTER_DATABASE_LABELS;
}

function starterDatabaseProperties(databaseId: string, labels: StarterDatabaseLabels): DbProperty[] {
  return [
    { id: newId(), databaseId, name: labels.title, type: 'title', position: 1 },
    {
      id: newId(),
      databaseId,
      name: labels.status,
      type: 'status',
      position: 2,
      config: {
        options: [
          starterOption(labels.notStarted, 'gray'),
          starterOption(labels.inProgress, 'blue'),
          starterOption(labels.done, 'green'),
        ],
      },
    },
    {
      id: newId(),
      databaseId,
      name: labels.tags,
      type: 'multi_select',
      position: 3,
      config: {
        options: [starterOption(labels.idea, 'purple'), starterOption(labels.urgent, 'red')],
      },
    },
  ];
}

function databaseViewLabel(type: StarterViewType, labels: StarterDatabaseLabels) {
  return labels.views[type];
}

function unusedLocalizedName(
  names: Iterable<string>,
  preferred: string,
  alternate: string = preferred,
) {
  const used = new Set(Array.from(names, (name) => name.toLowerCase()));
  if (!used.has(preferred.toLowerCase())) return preferred;
  if (!used.has(alternate.toLowerCase())) return alternate;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${alternate} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function customDatabaseProperties(
  databaseId: string,
  rawProperties: unknown,
  labels: StarterDatabaseLabels,
) {
  if (rawProperties === undefined) return undefined;
  if (!Array.isArray(rawProperties)) throw new Error('properties must be an array.');
  if (rawProperties.length > 100) throw new Error('A database can be created with at most 100 properties.');

  const properties: DbProperty[] = [];
  const names = new Set<string>();
  let titleCount = 0;

  for (let index = 0; index < rawProperties.length; index += 1) {
    const input = objectValue(rawProperties[index]);
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '';
    if (!name) throw new Error(`Property ${index + 1} needs a name.`);
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) throw new Error(`Duplicate database property name: ${name}.`);
    names.add(nameKey);

    const type = typeof input.type === 'string' && input.type.trim() ? input.type.trim() : 'rich_text';
    if (!propertyTypes.has(type)) throw new Error(`Unsupported database property type: ${type}.`);
    if (type === 'title') titleCount += 1;
    if (titleCount > 1) throw new Error('A database can only have one title property.');

    properties.push({
      id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newId(),
      databaseId,
      name,
      type,
      description: inputString(input, 'description'),
      config: propertyConfigFromInput(type, input, databaseId, labels),
      position: finiteNumber(input.position) ?? index + 1,
    });
  }

  if (titleCount === 0) {
    const generatedName = unusedLocalizedName(names, labels.title, labels.alternateTitle);
    properties.unshift({
      id: newId(),
      databaseId,
      name: generatedName,
      type: 'title',
      position: 1,
    });
    for (let index = 1; index < properties.length; index += 1) {
      if (!Number.isFinite(properties[index].position) || properties[index].position <= index) {
        properties[index].position = index + 1;
      }
    }
  }

  return properties;
}

function starterDatabaseSchema(
  databaseId: string,
  viewType: StarterViewType,
  rawProperties?: unknown,
  locale?: unknown,
) {
  const labels = starterDatabaseLabels(locale);
  const properties =
    customDatabaseProperties(databaseId, rawProperties, labels) ??
    starterDatabaseProperties(databaseId, labels);
  const config: Record<string, unknown> = {
    propertyOrder: properties.map((prop) => prop.id),
    visibleProperties: properties.map((prop) => prop.id),
  };

  if (viewType === 'board') {
    const groupProp = properties.find((prop) => prop.type === 'status' || prop.type === 'select');
    if (groupProp) config.groupBy = groupProp.id;
  }

  if (viewType === 'calendar' || viewType === 'timeline') {
    let dateProp = properties.find((property) => property.type === 'date');
    if (!dateProp) {
      dateProp = {
        id: newId(),
        databaseId,
        name: unusedLocalizedName(properties.map((property) => property.name), labels.date),
        type: 'date',
        position: properties.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1,
      };
      properties.push(dateProp);
    }
    config.propertyOrder = properties.map((prop) => prop.id);
    config.visibleProperties = properties.map((prop) => prop.id);
    if (viewType === 'calendar') config.calendarBy = dateProp.id;
    if (viewType === 'timeline') {
      config.timelineBy = dateProp.id;
      config.timelineZoom = 'month';
    }
  }

  if (viewType === 'gallery') config.cardSize = 'medium';

  const view: DbView = {
    id: newId(),
    databaseId,
    name: databaseViewLabel(viewType, labels),
    type: viewType,
    position: 1,
    config,
  };

  return { properties, view };
}

async function resolveDatabaseParent(
  db: DbRef,
  pages: TableRef<Page>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const parentId = optionalString(body.parentId);
  const parentType = parseCreateParentType(body.parentType, parentId);
  let workspaceId = optionalString(body.workspaceId);

  if (parentType === 'page') {
    if (!parentId) throw new Error('parentId is required for page database parents.');
    const parent = await getExistingRow(pages, parentId);
    if (!parent) throw new Error('Parent page was not found.');
    if (parent.kind !== 'page') throw new Error('Parent page is not a page.');
    if (parent.inTrash) throw new Error('Parent page is in trash.');
    if (parent.isLocked) throw new Error('Parent page is locked.');
    if (workspaceId && workspaceId !== parent.workspaceId) throw new Error('Parent page is outside the workspace.');
    workspaceId = parent.workspaceId;
    await assertCanEditPage(db, parent, actorId, actorEmail);
  } else {
    if (parentId) throw new Error('Workspace-level databases cannot have a parent page id.');
    if (!workspaceId) throw new Error('workspaceId is required.');
    await assertWorkspaceEdit(db, workspaceId, actorId);
  }

  return { workspaceId, parentId, parentType };
}

async function databasePosition(
  pages: TableRef<Page>,
  workspaceId: string,
  parentId: string | null,
  parentType: PageParentType,
  body: Record<string, unknown>,
) {
  const explicit = finiteNumber(body.position);
  if (explicit !== undefined) return explicit;

  const afterPosition = finiteNumber(body.afterPosition);
  if (afterPosition !== undefined) return positionBetween(afterPosition, undefined);

  const workspacePages = await listAll(pages.where('workspaceId', '==', workspaceId));
  const siblings = workspacePages
    .filter(
      (page) =>
        !page.inTrash &&
        page.id !== body.id &&
        (page.parentId ?? null) === parentId &&
        (page.parentType ?? 'workspace') === parentType,
    )
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return positionBetween(siblings.at(-1)?.position, undefined);
}

function starterDatabaseRow(database: Page, position: number, actorId: string): Page {
  const now = nowIso();
  return {
    id: newId(),
    workspaceId: database.workspaceId,
    parentId: database.id,
    parentType: 'database',
    kind: 'page',
    title: '',
    icon: '',
    iconType: 'none',
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties: {},
    isFavorite: false,
    isPublic: false,
    inTrash: false,
    position,
    createdBy: actorId,
    lastEditedBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
}

async function refreshDatabasePropertyIndexes(db: DbRef, pages: TableRef<Page>, databaseId: string) {
  const database = await getExisting(pages, databaseId);
  if (!database || database.kind !== 'database') return;
  const [rows, props] = await Promise.all([
    listAll(pages.where('parentId', '==', databaseId)),
    listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId)),
  ]);
  await ensureDatabasePropertyIndexes(
    db,
    { id: database.id, workspaceId: database.workspaceId },
    rows,
    props,
  );
}

async function createDatabase(
  db: DbRef,
  admin: AdminDbAccessor,
  pages: TableRef<Page>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  requestUrl?: string,
) {
  const id = optionalString(body.id) ?? newId();
  const viewType = parseStarterViewType(body.viewType);
  const { workspaceId, parentId, parentType } = await resolveDatabaseParent(db, pages, body, actorId, actorEmail);
  const now = nowIso();
  const page: Page = {
    id,
    workspaceId,
    parentId,
    parentType,
    kind: 'database',
    title: typeof body.title === 'string' ? body.title.trim() : '',
    icon: typeof body.icon === 'string' ? body.icon : '',
    iconType: typeof body.iconType === 'string' ? (body.iconType as Page['iconType']) : 'none',
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    isFavorite: false,
    isPublic: false,
    inTrash: false,
    position: await databasePosition(pages, workspaceId, parentId, parentType, body),
    createdBy: actorId,
    lastEditedBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
  const { properties, view } = starterDatabaseSchema(id, viewType, body.properties, body.locale);
  await assertNoUnownedStoredFileReferences(db, { icon: page.icon }, { requestUrl });
  const recordStamp = nowIso();
  const stampedProperties = properties.map((property) => ({
    ...property,
    createdAt: recordStamp,
    updatedAt: recordStamp,
  }));
  const stampedView = { ...view, createdAt: recordStamp, updatedAt: recordStamp };
  const rowCount = body.seedRows === false ? 0 : 3;
  const insertedRows = Array.from(
    { length: rowCount },
    (_, index) => starterDatabaseRow(page, index + 1, actorId),
  );
  const propertiesTable = db.table<DbProperty>('db_properties');
  for (const property of stampedProperties) {
    await validatePropertyRecord(pages, propertiesTable, page, property, stampedProperties);
  }

  const operations: TransactOperation[] = [
    { table: 'pages', op: 'insert', data: page as unknown as Record<string, unknown> },
    ...stampedProperties.map((property): TransactOperation => ({
      table: 'db_properties',
      op: 'insert',
      data: property as unknown as Record<string, unknown>,
    })),
    {
      table: 'db_views',
      op: 'insert',
      data: stampedView as unknown as Record<string, unknown>,
    },
    ...insertedRows.map((row): TransactOperation => ({
      table: 'pages',
      op: 'insert',
      data: row as unknown as Record<string, unknown>,
    })),
  ];
  if (operations.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(new Error('Database starter content is too large for an atomic creation.'), { status: 413 });
  }
  // Page, schema, view, and starter rows become visible together. A worker
  // interruption can no longer strand a page-only or schema-less database.
  await db.transact(operations);

  // Central routing lives outside the content DO. Repair is idempotent and
  // bounded; keep the fully committed database usable through workspace hints
  // even if the secondary index is temporarily unavailable.
  for (const createdPage of [page, ...insertedRows]) {
    await bestEffort(
      'database-mutation ensurePageWorkspaceIndex after atomic createDatabase',
      ensurePageWorkspaceIndex(admin, createdPage.id, createdPage.workspaceId),
    );
  }
  await bestEffort(
    'database-mutation upsertDatabaseIndexesForRows after atomic createDatabase',
    upsertDatabaseIndexesForRows(db, insertedRows),
  );

  return {
    page,
    properties: stampedProperties,
    views: [stampedView],
    templates: [],
    rows: insertedRows,
  };
}

function getTable<T extends DatabaseRecord>(db: DbRef, table: DatabaseTable) {
  return db.table<T>(table);
}

async function prepareInsertRecords(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  records: Record<string, unknown>[],
  actorId: string,
  actorEmail?: string | null,
): Promise<DatabaseRecord[]> {
  const databases = new Map<string, Page>();
  const prepared: DatabaseRecord[] = [];
  const ids = new Set<string>();
  for (const record of records) {
    const databaseId = databaseIdFromRecord(table, record);
    let database = databases.get(databaseId);
    if (!database) {
      database = await assertDatabaseWritable(db, pages, databaseId, actorId, actorEmail);
      databases.set(databaseId, database);
    }
    const cleaned = cleanRecord<DatabaseRecord>(record) as DatabaseRecord;
    const rawId = (cleaned as { id?: unknown }).id;
    const id = rawId === undefined ? newId() : requireString(rawId, 'id');
    (cleaned as DatabaseRecord & { id: string }).id = id;
    if (ids.has(id)) throw new Error(`Database record ${id} appears more than once in insertMany.`);
    ids.add(id);
    if (await getExisting(getTable<DatabaseRecord>(db, table), id)) {
      throw Object.assign(new Error(`Database record ${id} already exists.`), { status: 409 });
    }
    prepared.push(cleaned);
  }

  if (table === 'db_properties') {
    const properties = db.table<DbProperty>('db_properties');
    for (const [databaseId, database] of databases) {
      const candidates = prepared.filter((record) => record.databaseId === databaseId) as DbProperty[];
      const prospective = [...await propertiesForDatabase(properties, databaseId), ...candidates];
      for (const candidate of candidates) {
        await validatePropertyRecord(pages, properties, database, candidate, prospective);
      }
    }
  } else {
    for (const record of prepared) {
      await validateRecord(db, pages, table, databases.get(record.databaseId)!, record);
    }
  }
  return prepared;
}

async function refreshInsertedPropertyIndexes(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  records: DatabaseRecord[],
) {
  if (table !== 'db_properties') return;
  for (const databaseId of new Set(records.map((record) => record.databaseId))) {
    await bestEffort(
      'database-mutation refreshDatabasePropertyIndexes after atomic insertMany',
      refreshDatabasePropertyIndexes(db, pages, databaseId),
    );
  }
}

async function insertRecord<T extends DatabaseRecord>(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  record: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const [cleaned] = await prepareInsertRecords(db, pages, table, [record], actorId, actorEmail);
  if (table === 'db_properties') {
    const property = cleaned as DbProperty;
    const database = await assertDatabaseWritable(
      db,
      pages,
      property.databaseId,
      actorId,
      actorEmail,
    );
    const marker = await matchingDatabasePropertyDeleteMarker(
      db,
      database.workspaceId,
      property.id,
      property.databaseId,
    );
    if (marker) {
      // The marker does not contain an authoritative inverse for every row,
      // view, template, and file reference. Recreating only the schema would
      // present a false-success undo and permanently lose unloaded row values
      // (or strand a partial restore after a client crash). Keep the id fenced
      // until cleanup finishes; a future resumable server-side inverse journal
      // can reintroduce property undo safely.
      throw Object.assign(
        new Error('This property is still finishing deletion and cannot be recreated.'),
        { status: 409 },
      );
    }
    return withFileWorkspaceLease(
      db,
      database.workspaceId,
      actorId,
      'database-property-insert',
      async (lease) => {
        await lease.assertOwned();
        const racedMarker = await matchingDatabasePropertyDeleteMarker(
          db,
          database.workspaceId,
          property.id,
          property.databaseId,
        );
        if (racedMarker) {
          throw Object.assign(
            new Error('This property is still finishing deletion and cannot be recreated.'),
            { status: 409 },
          );
        }
        const properties = db.table<DbProperty>('db_properties');
        const prospective = [
          ...await propertiesForDatabase(properties, property.databaseId),
          property,
        ];
        await validatePropertyRecord(pages, properties, database, property, prospective);
        const inserted = await getTable<T>(db, table).insert(cleaned as Partial<T>);
        await refreshInsertedPropertyIndexes(db, pages, table, [inserted as DatabaseRecord]);
        return inserted;
      },
    );
  }
  if (table === 'db_templates') {
    const template = cleaned as DbTemplate;
    const filePropertyIds = await filePropertyIdsForDatabase(db, template.databaseId);
    const references = templateFileReferences(template, filePropertyIds);
    if (hasPotentialStoredFileReference(references)) {
      const database = await assertDatabaseWritable(
        db,
        pages,
        template.databaseId,
        actorId,
        actorEmail,
      );
      return withFileWorkspaceLease(
        db,
        database.workspaceId,
        actorId,
        'database-template-file-insert',
        async (lease) => {
          await lease.assertOwned();
          await validateRecord(db, pages, table, database, cleaned);
          await assertFileTargetsNotDeleting(db, database.workspaceId, [database.id]);
          const transitions = await fileReferenceTransitionOperations(db, {
            table: 'db_templates',
            current: { id: template.id },
            data: template as unknown as Record<string, unknown>,
            currentReferences: {},
            nextReferences: references,
            association: templateFileAssociation(template, filePropertyIds),
            actorId,
          });
          const operations: TransactOperation[] = [
            { table: 'db_templates', op: 'expect', id: template.id, exists: false },
            ...transitions,
            { table: 'db_templates', op: 'insert', data: template as unknown as Record<string, unknown> },
          ];
          if (operations.length > MAX_RAW_TRANSACT_OPS) {
            throw Object.assign(new Error('Template contains too many stored files.'), { status: 413 });
          }
          await db.transact(operations);
          return template as unknown as T;
        },
      );
    }
  }
  const database = await assertDatabaseWritable(
    db,
    pages,
    cleaned.databaseId,
    actorId,
    actorEmail,
  );
  return withFileWorkspaceLease(
    db,
    database.workspaceId,
    actorId,
    'database-schema-dependent-insert',
    async (lease) => {
      await lease.assertOwned();
      await validateRecord(db, pages, table, database, cleaned);
      const inserted = await getTable<T>(db, table).insert(cleaned as Partial<T>);
      await refreshInsertedPropertyIndexes(db, pages, table, [inserted as DatabaseRecord]);
      return inserted;
    },
  );
}

async function insertRecordsAtomically(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  records: Record<string, unknown>[],
  actorId: string,
  actorEmail?: string | null,
) {
  if (records.length === 0) return [];
  const prepared = await prepareInsertRecords(db, pages, table, records, actorId, actorEmail);
  if (prepared.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Atomic database batch is too large; submit fewer records.'),
      { status: 413 },
    );
  }
  if (table === 'db_properties') {
    // A property-delete recovery marker owns its schema id until cleanup is
    // finished. Bulk insert previously bypassed insertRecord's marker check and
    // could resurrect the id while maintenance was still removing row/template
    // values. Reject the whole batch before its first write, then hold the same
    // workspace lease as deletion through the actual insert transaction so a
    // concurrent create/delete sequence cannot race the marker preflight.
    const workspaceByDatabase = new Map<string, string>();
    for (const property of prepared as DbProperty[]) {
      let workspaceId = workspaceByDatabase.get(property.databaseId);
      if (!workspaceId) {
        const database = await assertDatabaseWritable(
          db,
          pages,
          property.databaseId,
          actorId,
          actorEmail,
        );
        workspaceId = database.workspaceId;
        workspaceByDatabase.set(property.databaseId, workspaceId);
      }
      const marker = await matchingDatabasePropertyDeleteMarker(
        db,
        workspaceId,
        property.id,
        property.databaseId,
      );
      if (marker) {
        throw Object.assign(
          new Error('A property with pending deletion cleanup cannot be recreated.'),
          { status: 409 },
        );
      }
    }
    const workspaceIds = new Set(workspaceByDatabase.values());
    if (workspaceIds.size !== 1) {
      throw new Error('Property batch must belong to one workspace.');
    }
    const workspaceId = Array.from(workspaceIds)[0]!;
    await withFileWorkspaceLease(
      db,
      workspaceId,
      actorId,
      'database-property-insert-many',
      async (lease) => {
        await lease.assertOwned();
        const properties = db.table<DbProperty>('db_properties');
        for (const [databaseId] of workspaceByDatabase) {
          const database = await assertDatabaseWritable(db, pages, databaseId, actorId, actorEmail);
          const candidates = (prepared as DbProperty[]).filter((item) => item.databaseId === databaseId);
          const prospective = [...await propertiesForDatabase(properties, databaseId), ...candidates];
          for (const candidate of candidates) {
            await validatePropertyRecord(pages, properties, database, candidate, prospective);
          }
        }
        for (const property of prepared as DbProperty[]) {
          const marker = await matchingDatabasePropertyDeleteMarker(
            db,
            workspaceId,
            property.id,
            property.databaseId,
          );
          if (marker) {
            throw Object.assign(
              new Error('A property with pending deletion cleanup cannot be recreated.'),
              { status: 409 },
            );
          }
        }
        await transactUnitsAtomically(db, prepared.map((record): TransactOperation[] => [{
          table,
          op: 'insert',
          data: record as unknown as Record<string, unknown>,
        }]));
        await refreshInsertedPropertyIndexes(db, pages, table, prepared);
      },
    );
    return prepared;
  }
  const templateFilePropertyIds = table === 'db_templates'
    ? await filePropertyIdsForDatabases(
        db,
        prepared.map((record) => record.databaseId),
      )
    : new Map<string, string[]>();
  if (
    table === 'db_templates'
    && prepared.some((record) => hasPotentialStoredFileReference(templateFileReferences(
      record as DbTemplate,
      templateFilePropertyIds.get(record.databaseId) ?? [],
    )))
  ) {
    const templates = prepared as DbTemplate[];
    const databases = await Promise.all(
      Array.from(new Set(templates.map((template) => template.databaseId))).map((databaseId) =>
        assertDatabaseWritable(db, pages, databaseId, actorId, actorEmail),
      ),
    );
    const workspaceIds = new Set(databases.map((database) => database.workspaceId));
    if (workspaceIds.size !== 1) throw new Error('Template batch must belong to one workspace.');
    await withFileWorkspaceLease(
      db,
      databases[0]!.workspaceId,
      actorId,
      'database-template-file-insert-many',
        async (lease) => {
        await lease.assertOwned();
        const operations: TransactOperation[] = [];
        for (const template of templates) {
          await validateSchemaDependentRecord(db, table, template);
          await assertFileTargetsNotDeleting(db, databases[0]!.workspaceId, [template.databaseId]);
          const transitions = await fileReferenceTransitionOperations(db, {
            table: 'db_templates',
            current: { id: template.id },
            data: template as unknown as Record<string, unknown>,
            currentReferences: {},
            nextReferences: templateFileReferences(
              template,
              templateFilePropertyIds.get(template.databaseId) ?? [],
            ),
            association: templateFileAssociation(
              template,
              templateFilePropertyIds.get(template.databaseId) ?? [],
            ),
            actorId,
          });
          operations.push(
            { table: 'db_templates', op: 'expect', id: template.id, exists: false },
            ...transitions,
            { table: 'db_templates', op: 'insert', data: template as unknown as Record<string, unknown> },
          );
        }
        if (operations.length > MAX_RAW_TRANSACT_OPS) {
          throw Object.assign(new Error('Template batch contains too many stored files.'), { status: 413 });
        }
        await lease.renew();
        await db.transact(operations);
      },
    );
    return prepared;
  }
  const databases = await Promise.all(
    Array.from(new Set(prepared.map((record) => record.databaseId))).map((databaseId) =>
      assertDatabaseWritable(db, pages, databaseId, actorId, actorEmail)),
  );
  const workspaceIds = new Set(databases.map((database) => database.workspaceId));
  if (workspaceIds.size !== 1) throw new Error('Database record batch must belong to one workspace.');
  await withFileWorkspaceLease(
    db,
    databases[0]!.workspaceId,
    actorId,
    'database-schema-dependent-insert-many',
    async (lease) => {
      await lease.assertOwned();
      for (const record of prepared) await validateSchemaDependentRecord(db, table, record);
      await transactUnitsAtomically(db, prepared.map((record): TransactOperation[] => [{
        table,
        op: 'insert',
        data: record as unknown as Record<string, unknown>,
      }]));
    },
  );
  return prepared;
}

async function updateRecord<T extends DatabaseRecord>(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  id: string,
  patch: Record<string, unknown>,
  actorId: string,
  expectedDatabaseId?: string | null,
  actorEmail?: string | null,
) {
  const tableRef = getTable<T>(db, table);
  const existing = await getExisting(tableRef, id);
  if (!existing) throw new Error('Database record was not found.');
  assertExpectedDatabase(existing, expectedDatabaseId);
  const database = await assertDatabaseWritable(db, pages, existing.databaseId, actorId, actorEmail);
  const cleaned = cleanPatch(table, patch) as Partial<T>;
  return withFileWorkspaceLease(
    db,
    database.workspaceId,
    actorId,
    'database-schema-dependent-update',
    async (lease) => {
      await lease.assertOwned();
      const fresh = await getExisting(tableRef, id);
      if (!fresh) throw new Error('Database record was not found.');
      assertExpectedDatabase(fresh, expectedDatabaseId);
      if (
        table === 'db_properties'
        && 'type' in cleaned
        && (fresh as unknown as DbProperty).type !== (cleaned as unknown as DbProperty).type
        && (
          (fresh as unknown as DbProperty).type === 'files'
          || (cleaned as unknown as DbProperty).type === 'files'
        )
      ) {
        throw Object.assign(
          new Error('Files properties cannot change type; delete and recreate the property instead.'),
          { status: 409 },
        );
      }
      const next = { ...fresh, ...cleaned } as DatabaseRecord;
      if (table === 'db_properties') {
        assertNoPropertyOptionRemoval(
          fresh as unknown as DbProperty,
          next as DbProperty,
        );
      }
      await validateRecord(db, pages, table, database, next);
      if (table === 'db_templates') {
        const currentTemplate = fresh as unknown as DbTemplate;
        const nextTemplate = next as DbTemplate;
        const filePropertyIds = await filePropertyIdsForDatabase(db, currentTemplate.databaseId);
        if (storedFileReferencesChanged(
          templateFileReferences(currentTemplate, filePropertyIds),
          templateFileReferences(nextTemplate, filePropertyIds),
        )) {
          await assertFileTargetsNotDeleting(db, database.workspaceId, [database.id]);
          return updateWithFileReferenceLifecycle(db, {
            table: 'db_templates',
            current: currentTemplate,
            data: cleaned as unknown as Partial<DbTemplate> & Record<string, unknown>,
            currentReferences: templateFileReferences(currentTemplate, filePropertyIds),
            nextReferences: templateFileReferences(nextTemplate, filePropertyIds),
            association: templateFileAssociation(currentTemplate, filePropertyIds),
            actorId,
          }) as Promise<T>;
        }
      }
      await db.transact([
        {
          table,
          op: 'expect',
          id,
          where: [['updatedAt', '==', fresh.updatedAt ?? null]],
          exists: true,
        },
        { table, op: 'update', id, data: cleaned as Record<string, unknown> },
      ]);
      const updated = await getExisting(tableRef, id);
      if (!updated) throw new Error('Database record was not found after update.');
      if (table === 'db_properties') {
        await bestEffort(
          'database-mutation refreshDatabasePropertyIndexes after schema update',
          refreshDatabasePropertyIndexes(db, pages, (updated as unknown as DbProperty).databaseId),
        );
      }
      return updated;
    },
  );
}

async function updateRecordsAtomically(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  updates: Array<{ id: string; patch: Record<string, unknown>; databaseId?: string | null }>,
  actorId: string,
  actorEmail?: string | null,
) {
  if (updates.length === 0) return [];
  const tableRef = getTable<DatabaseRecord>(db, table);
  const databases = new Map<string, Page>();
  const prepared: Array<{ existing: DatabaseRecord; patch: DatabasePatch; record: DatabaseRecord }> = [];
  const ids = new Set<string>();
  for (const update of updates) {
    if (ids.has(update.id)) throw new Error(`Database record ${update.id} appears more than once in updateMany.`);
    ids.add(update.id);
    const existing = await getExisting(tableRef, update.id);
    if (!existing) throw new Error('Database record was not found.');
    assertExpectedDatabase(existing, update.databaseId);
    let database = databases.get(existing.databaseId);
    if (!database) {
      database = await assertDatabaseWritable(db, pages, existing.databaseId, actorId, actorEmail);
      databases.set(existing.databaseId, database);
    }
    const patch = cleanPatch(table, update.patch);
    if (
      table === 'db_properties'
      && 'type' in patch
      && (existing as DbProperty).type !== (patch as DbProperty).type
      && ((existing as DbProperty).type === 'files' || (patch as DbProperty).type === 'files')
    ) {
      throw Object.assign(
        new Error('Files properties cannot change type; delete and recreate the property instead.'),
        { status: 409 },
      );
    }
    prepared.push({ existing, patch, record: { ...existing, ...patch } as DatabaseRecord });
  }
  if (prepared.length * 2 > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Atomic database batch is too large; submit fewer records.'),
      { status: 413 },
    );
  }

  if (table === 'db_properties') {
    const properties = db.table<DbProperty>('db_properties');
    for (const [databaseId, database] of databases) {
      const current = await propertiesForDatabase(properties, databaseId);
      const updatesById = new Map(
        prepared
          .filter(({ existing }) => existing.databaseId === databaseId)
          .map(({ record }) => [record.id, record as DbProperty]),
      );
      const prospective = current.map((property) => updatesById.get(property.id) ?? property);
      for (const property of updatesById.values()) {
        await validatePropertyRecord(pages, properties, database, property, prospective);
      }
    }
  } else {
    for (const { record } of prepared) {
      await validateRecord(db, pages, table, databases.get(record.databaseId)!, record);
    }
  }

  const templateFilePropertyIds = table === 'db_templates'
    ? await filePropertyIdsForDatabases(db, databases.keys())
    : new Map<string, string[]>();

  if (
    table === 'db_templates'
    && prepared.some(({ existing, record }) => storedFileReferencesChanged(
      templateFileReferences(
        existing as DbTemplate,
        templateFilePropertyIds.get(existing.databaseId) ?? [],
      ),
      templateFileReferences(
        record as DbTemplate,
        templateFilePropertyIds.get(record.databaseId) ?? [],
      ),
    ))
  ) {
    const workspaceIds = new Set(
      Array.from(databases.values()).map((database) => database.workspaceId),
    );
    if (workspaceIds.size !== 1) throw new Error('Template batch must belong to one workspace.');
    const committed = await withFileWorkspaceLease(
      db,
      Array.from(workspaceIds)[0]!,
      actorId,
      'database-template-file-update-many',
      async (lease) => {
        await lease.assertOwned();
        const operations: TransactOperation[] = [];
        const records: DatabaseRecord[] = [];
        for (const item of prepared) {
          const fresh = await getExisting(tableRef, item.existing.id);
          if (!fresh) throw new Error('Database record was not found.');
          if (fresh.updatedAt !== item.existing.updatedAt) {
            throw Object.assign(new Error('Database template changed since it was loaded.'), { status: 409 });
          }
          await assertFileTargetsNotDeleting(db, Array.from(workspaceIds)[0]!, [fresh.databaseId]);
          const next = { ...fresh, ...item.patch } as DbTemplate;
          await validateSchemaDependentRecord(db, table, next);
          const transitions = await fileReferenceTransitionOperations(db, {
            table: 'db_templates',
            current: fresh as DbTemplate,
            data: item.patch as Record<string, unknown>,
            currentReferences: templateFileReferences(
              fresh as DbTemplate,
              templateFilePropertyIds.get(fresh.databaseId) ?? [],
            ),
            nextReferences: templateFileReferences(
              next,
              templateFilePropertyIds.get(next.databaseId) ?? [],
            ),
            association: templateFileAssociation(
              fresh as DbTemplate,
              templateFilePropertyIds.get(fresh.databaseId) ?? [],
            ),
            actorId,
          });
          operations.push(
            {
              table: 'db_templates', op: 'expect', id: fresh.id,
              where: [['updatedAt', '==', fresh.updatedAt ?? null]], exists: true,
            },
            ...transitions,
            { table: 'db_templates', op: 'update', id: fresh.id, data: item.patch as Record<string, unknown> },
          );
          records.push(next);
        }
        if (operations.length > MAX_RAW_TRANSACT_OPS) {
          throw Object.assign(new Error('Template batch contains too many stored files.'), { status: 413 });
        }
        await lease.renew();
        await db.transact(operations);
        return records;
      },
    );
    return committed;
  }

  const workspaceIds = new Set(
    Array.from(databases.values()).map((database) => database.workspaceId),
  );
  if (workspaceIds.size !== 1) throw new Error('Database update batch must belong to one workspace.');
  const committed = await withFileWorkspaceLease(
    db,
    Array.from(workspaceIds)[0]!,
    actorId,
    'database-schema-dependent-update-many',
    async (lease) => {
      await lease.assertOwned();
      const freshPrepared: Array<{
        current: DatabaseRecord;
        patch: DatabasePatch;
        next: DatabaseRecord;
      }> = [];
      for (const item of prepared) {
        const current = await getExisting(tableRef, item.existing.id);
        if (!current) throw new Error('Database record was not found.');
        const next = { ...current, ...item.patch } as DatabaseRecord;
        if (table === 'db_properties') {
          assertNoPropertyOptionRemoval(
            current as DbProperty,
            next as DbProperty,
          );
        }
        freshPrepared.push({ current, patch: item.patch, next });
      }
      if (table === 'db_properties') {
        const properties = db.table<DbProperty>('db_properties');
        for (const [databaseId, database] of databases) {
          const current = await propertiesForDatabase(properties, databaseId);
          const updatesById = new Map(
            freshPrepared
              .filter((item) => item.current.databaseId === databaseId)
              .map((item) => [item.next.id, item.next as DbProperty]),
          );
          const prospective = current.map((property) => updatesById.get(property.id) ?? property);
          for (const property of updatesById.values()) {
            await validatePropertyRecord(pages, properties, database, property, prospective);
          }
        }
      } else {
        for (const item of freshPrepared) {
          await validateSchemaDependentRecord(db, table, item.next);
        }
      }
      await transactUnitsAtomically(db, freshPrepared.map(({ current, patch }): TransactOperation[] => [
        {
          table,
          op: 'expect',
          id: current.id,
          where: [['updatedAt', '==', current.updatedAt ?? null]],
          exists: true,
        },
        { table, op: 'update', id: current.id, data: patch as Record<string, unknown> },
      ]));
      const records = freshPrepared.map(({ next }) => next);
      await refreshInsertedPropertyIndexes(db, pages, table, records);
      return records;
    },
  );
  return committed;
}

function assertAtomicMutationUnit(unit: TransactOperation[]) {
  if (unit.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('One database record contains too many stored files for an atomic mutation.'),
      { status: 413 },
    );
  }
}

async function transactUnitsAtomically(
  db: DbRef,
  units: TransactOperation[][],
) {
  for (const unit of units) assertAtomicMutationUnit(unit);
  const operations = units.flat();
  if (operations.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Atomic database batch is too large; submit fewer records.'),
      { status: 413 },
    );
  }
  if (operations.length > 0) await db.transact(operations);
}

// Packs durable, independently retryable cleanup units into transact batches
// under MAX_RAW_TRANSACT_OPS raw ops.
// (the boundedDb facade appends one change_log insert per op on change-logged
// tables — workspace-db.ts). A unit's ops (an expect and the update it guards)
// always share a chunk.
async function transactUnitsChunked(
  db: DbRef,
  units: TransactOperation[][],
  beforeChunk?: () => Promise<void>,
) {
  // Validate every unit before the first commit. Otherwise a late oversized
  // file transition could return 413 after earlier chunks had already landed.
  for (const unit of units) assertAtomicMutationUnit(unit);
  let chunk: TransactOperation[] = [];
  for (const unit of units) {
    if (chunk.length > 0 && chunk.length + unit.length > MAX_RAW_TRANSACT_OPS) {
      if (beforeChunk) await beforeChunk();
      await db.transact(chunk);
      chunk = [];
    }
    chunk.push(...unit);
  }
  if (chunk.length > 0) {
    if (beforeChunk) await beforeChunk();
    await db.transact(chunk);
  }
}

const DATABASE_PROPERTY_DELETE_RECOVERY_KIND = 'database-property-delete-v1';
const MAX_PROPERTY_DELETE_ATTEMPTS = 3;

export interface DatabasePropertyDeleteRecoveryData {
  kind: typeof DATABASE_PROPERTY_DELETE_RECOVERY_KIND;
  property: DbProperty;
  actorId: string;
  startedAt: string;
}

interface FileWorkspaceLockRecord {
  id: string;
  workspaceId: string;
  leaseId: string;
  recoveryData?: unknown;
  expiresAt: string;
}

function parseDatabasePropertyDeleteRecoveryData(
  value: unknown,
): DatabasePropertyDeleteRecoveryData {
  if (!isRecord(value) || value.kind !== DATABASE_PROPERTY_DELETE_RECOVERY_KIND) {
    throw new Error('Database-property deletion recovery marker is malformed.');
  }
  const property = isRecord(value.property) ? value.property : null;
  if (
    !property
    || typeof property.id !== 'string'
    || !property.id
    || typeof property.databaseId !== 'string'
    || !property.databaseId
    || typeof property.name !== 'string'
    || typeof property.type !== 'string'
    || property.type === 'title'
    || typeof property.position !== 'number'
    || !Number.isFinite(property.position)
    || typeof value.actorId !== 'string'
    || !value.actorId
    || typeof value.startedAt !== 'string'
    || !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new Error('Database-property deletion recovery marker is malformed.');
  }
  return {
    kind: DATABASE_PROPERTY_DELETE_RECOVERY_KIND,
    property: {
      id: property.id,
      databaseId: property.databaseId,
      name: property.name,
      type: property.type,
      position: property.position,
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
      ...(isRecord(property.config) ? { config: property.config } : {}),
      ...(typeof property.createdAt === 'string' ? { createdAt: property.createdAt } : {}),
      ...(typeof property.updatedAt === 'string' ? { updatedAt: property.updatedAt } : {}),
    },
    actorId: value.actorId,
    startedAt: value.startedAt,
  };
}

function isDatabasePropertyDeleteRecoveryData(
  value: unknown,
): value is DatabasePropertyDeleteRecoveryData {
  return isRecord(value) && value.kind === DATABASE_PROPERTY_DELETE_RECOVERY_KIND;
}

export function databasePropertyDeleteRecoveryData(input: {
  property: DbProperty;
  actorId: string;
  startedAt?: string;
}): DatabasePropertyDeleteRecoveryData {
  return parseDatabasePropertyDeleteRecoveryData({
    kind: DATABASE_PROPERTY_DELETE_RECOVERY_KIND,
    property: input.property,
    actorId: input.actorId,
    startedAt: input.startedAt ?? nowIso(),
  });
}

type DatabasePropertyDeleteCleanup = {
  rows: number;
  views: number;
  templates: number;
  properties: number;
};

type DatabasePropertyDeletePlan = {
  units: TransactOperation[][];
  cleanup: DatabasePropertyDeleteCleanup;
};

async function buildDatabasePropertyDeletePlan(
  db: DbRef,
  pages: TableRef<Page>,
  property: DbProperty,
  actorId: string,
): Promise<DatabasePropertyDeletePlan> {
  const [views, templates, props, propertyIndexes, rows] = await Promise.all([
    listAll(db.table<DbView>('db_views').where('databaseId', '==', property.databaseId)),
    listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', property.databaseId)),
    listAll(db.table<DbProperty>('db_properties').limit(1000)),
    listAll(db.table<{ id: string }>('db_property_indexes').where('propertyId', '==', property.id)),
    listAll(pages.where('parentId', '==', property.databaseId)),
  ]);
  const viewUpdates = views
    .map((view) => {
      const config = viewConfigWithoutProperty(view.config, property.id);
      return jsonChanged(view.config, config) ? { current: view, config } : null;
    })
    .filter((item): item is { current: DbView; config: Record<string, unknown> } => !!item);
  const templateUpdates = templates
    .filter((template) => isRecord(template.properties) && property.id in template.properties)
    .map((template) => {
      const properties = { ...(template.properties ?? {}) };
      delete properties[property.id];
      return { current: template, properties };
    });
  const propertyUpdates = props
    .filter((item) => item.id !== property.id)
    .map((item) => {
      const config = { ...(item.config ?? {}) };
      let changed = false;
      if (config.rollupRelationPropertyId === property.id) {
        delete config.rollupRelationPropertyId;
        delete config.rollupTargetPropertyId;
        changed = true;
      }
      if (config.rollupTargetPropertyId === property.id) {
        delete config.rollupTargetPropertyId;
        changed = true;
      }
      return changed ? { current: item, config } : null;
    })
    .filter((item): item is { current: DbProperty; config: Record<string, unknown> } => !!item);
  const rowUpdates = rows
    .filter((row) => row.parentType === 'database' && isRecord(row.properties) && property.id in row.properties)
    .map((row) => {
      const properties = { ...(row.properties ?? {}) };
      delete properties[property.id];
      return { current: row, properties };
    });
  const deletedFilePropertyIds = property.type === 'files' ? [property.id] : [];
  const rowUnits: TransactOperation[][] = [];
  for (const row of rowUpdates) {
    const transitions = await fileReferenceTransitionOperations(db, {
      table: 'pages',
      current: row.current,
      data: { properties: row.properties },
      currentReferences: {
        properties: row.current.properties,
        schemaFileProperties: schemaFilePropertyReferences(
          row.current.properties,
          deletedFilePropertyIds,
        ),
      },
      nextReferences: {
        properties: row.properties,
        schemaFileProperties: schemaFilePropertyReferences(
          row.properties,
          deletedFilePropertyIds,
        ),
      },
      association: {
        field: 'pageId',
        id: row.current.id,
        filter: (upload) => !upload.blockId,
      },
      actorId,
    });
    rowUnits.push([
      {
        table: 'pages',
        op: 'expect',
        id: row.current.id,
        where: [['updatedAt', '==', row.current.updatedAt ?? null]],
        exists: true,
      },
      ...transitions,
      { table: 'pages', op: 'update', id: row.current.id, data: { properties: row.properties } },
    ]);
  }
  const templateUnits: TransactOperation[][] = [];
  for (const template of templateUpdates) {
    const next = { ...template.current, properties: template.properties };
    const transitions = await fileReferenceTransitionOperations(db, {
      table: 'db_templates',
      current: template.current,
      data: { properties: template.properties },
      currentReferences: templateFileReferences(template.current, deletedFilePropertyIds),
      nextReferences: templateFileReferences(next, deletedFilePropertyIds),
      association: templateFileAssociation(template.current, deletedFilePropertyIds),
      actorId,
    });
    templateUnits.push([
      {
        table: 'db_templates',
        op: 'expect',
        id: template.current.id,
        where: [['updatedAt', '==', template.current.updatedAt ?? null]],
        exists: true,
      },
      ...transitions,
      {
        table: 'db_templates',
        op: 'update',
        id: template.current.id,
        data: { properties: template.properties },
      },
    ]);
  }
  const units: TransactOperation[][] = [
    ...rowUnits,
    ...viewUpdates.map(({ current, config }): TransactOperation[] => [
      {
        table: 'db_views', op: 'expect', id: current.id,
        where: [['updatedAt', '==', current.updatedAt ?? null]], exists: true,
      },
      { table: 'db_views', op: 'update', id: current.id, data: { config } },
    ]),
    ...templateUnits,
    ...propertyUpdates.map(({ current, config }): TransactOperation[] => [
      {
        table: 'db_properties', op: 'expect', id: current.id,
        where: [['updatedAt', '==', current.updatedAt ?? null]], exists: true,
      },
      { table: 'db_properties', op: 'update', id: current.id, data: { config } },
    ]),
    ...propertyIndexes.map((index): TransactOperation[] => [
      { table: 'db_property_indexes', op: 'delete', id: index.id },
    ]),
  ];
  for (const unit of units) assertAtomicMutationUnit(unit);
  return {
    units,
    cleanup: {
      rows: rowUpdates.length,
      views: viewUpdates.length,
      templates: templateUpdates.length,
      properties: propertyUpdates.length,
    },
  };
}

function transactionExpectationConflict(error: unknown) {
  return error instanceof Error && error.message.includes('Transaction expectation failed');
}

async function finishDatabasePropertyDelete(
  db: DbRef,
  pages: TableRef<Page>,
  marker: DatabasePropertyDeleteRecoveryData,
  renew: () => Promise<void>,
  initialPlan?: DatabasePropertyDeletePlan,
) {
  let lastCleanup: DatabasePropertyDeleteCleanup = {
    rows: 0, views: 0, templates: 0, properties: 0,
  };
  for (let attempt = 1; attempt <= MAX_PROPERTY_DELETE_ATTEMPTS; attempt += 1) {
    const plan = attempt === 1 && initialPlan
      ? initialPlan
      : await buildDatabasePropertyDeletePlan(db, pages, marker.property, marker.actorId);
    lastCleanup = plan.cleanup;
    try {
      await transactUnitsChunked(db, plan.units, renew);
      return lastCleanup;
    } catch (error) {
      if (!transactionExpectationConflict(error)) throw error;
      if (attempt === MAX_PROPERTY_DELETE_ATTEMPTS) {
        throw Object.assign(
          new Error('Database rows changed while the property was being deleted. Retry the delete.'),
          { status: 409 },
        );
      }
    }
  }
  return lastCleanup;
}

async function matchingDatabasePropertyDeleteMarker(
  db: DbRef,
  workspaceId: string,
  propertyId: string,
  databaseId: string,
) {
  const lock = await getExisting(
    db.table<FileWorkspaceLockRecord>('file_workspace_locks'),
    workspaceId,
  );
  if (!lock?.recoveryData || !isDatabasePropertyDeleteRecoveryData(lock.recoveryData)) return null;
  const marker = parseDatabasePropertyDeleteRecoveryData(lock.recoveryData);
  return marker.property.id === propertyId && marker.property.databaseId === databaseId
    ? marker
    : null;
}

async function resumeDatabasePropertyDelete(
  db: DbRef,
  pages: TableRef<Page>,
  workspaceId: string,
  marker: DatabasePropertyDeleteRecoveryData,
) {
  return withFileWorkspaceLease(
    db,
    workspaceId,
    marker.actorId,
    'database-property-delete-recovery',
    async (lease) => {
      let preserve = true;
      try {
        const resurrected = await getExisting(
          db.table<DbProperty>('db_properties'),
          marker.property.id,
        );
        if (resurrected) {
          throw Object.assign(
            new Error('Deleted database property id was recreated before cleanup completed.'),
            { status: 409 },
          );
        }
        const cleanup = await finishDatabasePropertyDelete(
          db,
          pages,
          marker,
          lease.renew,
        );
        await lease.setRecoveryData(null);
        preserve = false;
        return cleanup;
      } finally {
        if (preserve) lease.preserveForRecovery();
      }
    },
    {
      recoverMarkedLease: (value) => {
        if (!isDatabasePropertyDeleteRecoveryData(value)) return false;
        const candidate = parseDatabasePropertyDeleteRecoveryData(value);
        return candidate.property.id === marker.property.id
          && candidate.property.databaseId === marker.property.databaseId;
      },
      recoveryOperation: 'database-property-delete-recovery',
      recoveryRetryMs: 0,
    },
  );
}

export async function recoverStaleDatabasePropertyDeleteOperations(input: {
  contentDbs: Array<{ workspaceId: string | null; db: DbRef }>;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const recovered: string[] = [];
  const failures: Array<{ workspaceId: string; propertyId: string; message: string }> = [];
  for (const entry of input.contentDbs) {
    const workspaceId = entry.workspaceId;
    if (!workspaceId) continue;
    const lock = await getExisting(
      entry.db.table<FileWorkspaceLockRecord>('file_workspace_locks'),
      workspaceId,
    );
    if (
      !lock?.recoveryData
      || !isDatabasePropertyDeleteRecoveryData(lock.recoveryData)
      || Date.parse(lock.expiresAt) > now
    ) continue;
    let propertyId = 'unknown';
    try {
      const marker = parseDatabasePropertyDeleteRecoveryData(lock.recoveryData);
      propertyId = marker.property.id;
      await resumeDatabasePropertyDelete(
        entry.db,
        entry.db.table<Page>('pages'),
        workspaceId,
        marker,
      );
      recovered.push(workspaceId);
    } catch (error) {
      failures.push({
        workspaceId,
        propertyId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { recovered, failures };
}

async function deleteRecordsAtomically(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  ids: string[],
  actorId: string,
  expectedDatabaseId?: string | null,
  actorEmail?: string | null,
  workspaceIdHint?: string | null,
) {
  if (ids.length === 0) return [];
  if (table === 'db_properties') {
    if (ids.length > 1) {
      throw new Error('deleteMany cannot combine multiple property schema deletions; send them as individual deletes.');
    }
    const result = await deleteRecord(
      db,
      pages,
      table,
      ids[0],
      actorId,
      expectedDatabaseId,
      actorEmail,
      workspaceIdHint,
    );
    return [result.deletedId];
  }

  const tableRef = getTable<DatabaseRecord>(db, table);
  const seen = new Set<string>();
  const existingIds: string[] = [];
  const existingRecords: DatabaseRecord[] = [];
  const writableDatabases = new Map<string, Page>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Database record ${id} appears more than once in deleteMany.`);
    seen.add(id);
    const existing = await getExisting(tableRef, id);
    if (!existing) continue;
    assertExpectedDatabase(existing, expectedDatabaseId);
    const database = await assertDatabaseWritable(db, pages, existing.databaseId, actorId, actorEmail);
    writableDatabases.set(database.id, database);
    existingIds.push(id);
    existingRecords.push(existing);
  }
  if (table === 'db_templates' && existingRecords.length > 0) {
    const workspaceIds = new Set(
      Array.from(writableDatabases.values()).map((database) => database.workspaceId),
    );
    const templateFilePropertyIds = await filePropertyIdsForDatabases(
      db,
      existingRecords.map((record) => record.databaseId),
    );
    if (workspaceIds.size !== 1) throw new Error('Template batch must belong to one workspace.');
    await withFileWorkspaceLease(
      db,
      Array.from(workspaceIds)[0]!,
      actorId,
      'database-template-file-delete-many',
      async (lease) => {
        await lease.assertOwned();
        const operations: TransactOperation[] = [];
        for (const existing of existingRecords as DbTemplate[]) {
          const fresh = await getExisting(tableRef, existing.id) as DbTemplate | null;
          if (!fresh) continue;
          await assertFileTargetsNotDeleting(db, Array.from(workspaceIds)[0]!, [fresh.databaseId]);
          const transitions = await fileReferenceTransitionOperations(db, {
            table: 'db_templates',
            current: fresh,
            data: {},
            currentReferences: templateFileReferences(
              fresh,
              templateFilePropertyIds.get(fresh.databaseId) ?? [],
            ),
            nextReferences: {},
            association: templateFileAssociation(
              fresh,
              templateFilePropertyIds.get(fresh.databaseId) ?? [],
            ),
            actorId,
          });
          operations.push(
            {
              table: 'db_templates', op: 'expect', id: fresh.id,
              where: [['updatedAt', '==', fresh.updatedAt ?? null]], exists: true,
            },
            ...transitions,
            { table: 'db_templates', op: 'delete', id: fresh.id },
          );
        }
        if (operations.length > MAX_RAW_TRANSACT_OPS) {
          throw Object.assign(new Error('Template batch contains too many stored files.'), { status: 413 });
        }
        if (operations.length > 0) await db.transact(operations);
      },
    );
    return ids;
  }
  if (existingIds.length > 0) {
    await transactUnitsAtomically(db, existingIds.map((id): TransactOperation[] => [{ table, op: 'delete', id }]));
  }
  return ids;
}

async function deleteRecord<T extends DatabaseRecord>(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  id: string,
  actorId: string,
  expectedDatabaseId?: string | null,
  actorEmail?: string | null,
  workspaceIdHint?: string | null,
) {
  const tableRef = getTable<T>(db, table);
  const existing = await getExisting(tableRef, id);
  if (table === 'db_properties') {
    if (!existing) {
      const markerLock = workspaceIdHint
        ? await getExisting(
            db.table<FileWorkspaceLockRecord>('file_workspace_locks'),
            workspaceIdHint,
          )
        : null;
      const candidate = markerLock?.recoveryData
        && isDatabasePropertyDeleteRecoveryData(markerLock.recoveryData)
        ? parseDatabasePropertyDeleteRecoveryData(markerLock.recoveryData)
        : null;
      const marker = candidate
        && candidate.property.id === id
        && (!expectedDatabaseId || candidate.property.databaseId === expectedDatabaseId)
        ? candidate
        : null;
      const databaseId = expectedDatabaseId ?? marker?.property.databaseId;
      if (!databaseId) return { deletedId: id };
      const writableDatabase = await assertDatabaseWritable(
        db,
        pages,
        databaseId,
        actorId,
        actorEmail,
      );
      const recoveryMarker = marker ?? await matchingDatabasePropertyDeleteMarker(
        db, writableDatabase.workspaceId, id, databaseId,
      );
      if (!recoveryMarker) return { deletedId: id };
      const cleanup = await resumeDatabasePropertyDelete(
        db,
        pages,
        writableDatabase.workspaceId,
        recoveryMarker,
      );
      return { deletedId: id, cleanup };
    }
    assertExpectedDatabase(existing, expectedDatabaseId);
    const property = existing as unknown as DbProperty;
    if (property.type === 'title') throw new Error('The title property cannot be deleted.');
    const writableDatabase = await assertDatabaseWritable(
      db,
      pages,
      property.databaseId,
      actorId,
      actorEmail,
    );

    return withFileWorkspaceLease(
      db,
      writableDatabase.workspaceId,
      actorId,
      'database-property-file-delete',
      async (lease) => {
        await lease.assertOwned();
        await assertFileTargetsNotDeleting(db, writableDatabase.workspaceId, [property.databaseId]);
        const fresh = await getExisting(
          db.table<DbProperty>('db_properties'),
          property.id,
        );
        if (!fresh) {
          throw Object.assign(new Error('Database property changed while deletion was starting.'), { status: 409 });
        }
        if (fresh.type === 'title') throw new Error('The title property cannot be deleted.');
        const marker = databasePropertyDeleteRecoveryData({ property: fresh, actorId });
        // Build and preflight the complete cleanup before the schema tombstone.
        // A late oversized row/template therefore returns 413 with zero writes.
        const initialPlan = await buildDatabasePropertyDeletePlan(db, pages, fresh, actorId);
        let markerDurable = false;
        try {
          await db.transact([
            {
              table: 'file_workspace_locks',
              op: 'expect',
              id: lease.lease.id,
              where: [['leaseId', '==', lease.lease.leaseId]],
              exists: true,
            },
            {
              table: 'file_workspace_locks',
              op: 'update',
              id: lease.lease.id,
              data: { recoveryData: marker, updatedAt: nowIso() },
            },
            {
              table: 'db_properties',
              op: 'expect',
              id: fresh.id,
              where: [['updatedAt', '==', fresh.updatedAt ?? null]],
              exists: true,
            },
            { table: 'db_properties', op: 'delete', id: fresh.id },
          ]);
          markerDurable = true;
          let cleanup: DatabasePropertyDeleteCleanup;
          try {
            cleanup = await finishDatabasePropertyDelete(
              db,
              pages,
              marker,
              lease.renew,
              initialPlan,
            );
          } catch (error) {
            // The schema tombstone is already durable and the marker makes
            // every remaining unit retryable. Report accepted/pending instead
            // of a terminal 409/5xx that would make the optimistic client
            // resurrect a property which is already authoritatively hidden.
            console.error('[database-property-delete] cleanup deferred:', error);
            return { deletedId: id, cleanupPending: true };
          }
          await lease.setRecoveryData(null);
          markerDurable = false;
          return { deletedId: id, cleanup };
        } finally {
          if (markerDurable) lease.preserveForRecovery();
        }
      },
      {
        recoveryOperation: 'database-property-delete-recovery',
        recoveryRetryMs: 0,
      },
    );
  }
  if (!existing) return { deletedId: id };
  assertExpectedDatabase(existing, expectedDatabaseId);
  await assertDatabaseWritable(db, pages, existing.databaseId, actorId, actorEmail);
  if (table === 'db_templates') {
    const template = existing as unknown as DbTemplate;
    const database = await assertDatabaseWritable(db, pages, template.databaseId, actorId, actorEmail);
    const filePropertyIds = await filePropertyIdsForDatabase(db, template.databaseId);
    await withFileWorkspaceLease(
      db,
      database.workspaceId,
      actorId,
      'database-template-file-delete',
      async (lease) => {
        await lease.assertOwned();
        const fresh = await getExisting(tableRef, id) as unknown as DbTemplate | null;
        if (!fresh) return;
        await assertFileTargetsNotDeleting(db, database.workspaceId, [database.id]);
        const transitions = await fileReferenceTransitionOperations(db, {
          table: 'db_templates',
          current: fresh,
          data: {},
          currentReferences: templateFileReferences(fresh, filePropertyIds),
          nextReferences: {},
          association: templateFileAssociation(fresh, filePropertyIds),
          actorId,
        });
        const operations: TransactOperation[] = [
          {
            table: 'db_templates', op: 'expect', id: fresh.id,
            where: [['updatedAt', '==', fresh.updatedAt ?? null]], exists: true,
          },
          ...transitions,
          { table: 'db_templates', op: 'delete', id: fresh.id },
        ];
        if (operations.length > MAX_RAW_TRANSACT_OPS) {
          throw Object.assign(new Error('Template contains too many stored files.'), { status: 413 });
        }
        await db.transact(operations);
      },
    );
    return { deletedId: id };
  }
  // Views/templates are the primary record here. Propagate a delete failure
  // rather than returning a false success response.
  await tableRef.delete(id);
  return { deletedId: id };
}

// ---- Two-way ("Show on …") relation reciprocals ------------------------------
//
// A relation property is two-way when its config carries `relatedPropertyId`
// (the id of the paired relation on the target database). The backend owns the
// reciprocal lifecycle so every client — the web app, MCP, and direct product
// API callers — gets Notion-style two-way relations from one code path:
//   • ensureReciprocalRelationProperty runs after a relation property is
//     inserted/updated with `relatedPropertyId` set; it creates the paired
//     property on the target database when it does not already exist. It is
//     idempotent — a caller that supplied both sides itself (the web app, or a
//     dual insertMany) finds the pair present and no-ops.
//   • deleteReciprocalRelationProperty runs after a two-way relation property is
//     deleted (unless the caller passed skipReciprocal); it deletes the paired
//     property too, matching Notion where removing either side removes both.
// Both call the per-record insert/delete helpers directly (never the
// dispatcher), so the reciprocal's own mutation never re-triggers this
// reconciliation. Reciprocal management is a best-effort post-step: the primary
// mutation is already committed, so a rare reciprocal failure degrades to a
// one-way relation (recoverable) instead of a false failure on the primary.
function relationReciprocalId(property: DbProperty): string {
  const value = property.config?.relatedPropertyId;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function ensureReciprocalRelationProperty(
  db: DbRef,
  pages: TableRef<Page>,
  property: DbProperty,
  actorId: string,
  actorEmail: string | null | undefined,
  reciprocalName?: string | null,
) {
  if (property.type !== 'relation') return;
  const reciprocalId = relationReciprocalId(property);
  if (!reciprocalId) return;
  const properties = db.table<DbProperty>('db_properties');
  if (await getExisting(properties, reciprocalId)) return; // already paired (idempotent)

  const targetDbId = relationTargetDatabaseId(property);
  const targetDb = await getExistingRow(pages, targetDbId);
  if (!targetDb || targetDb.kind !== 'database' || targetDb.inTrash) return; // target gone → stay one-way

  const sourceDb = await getExistingRow(pages, property.databaseId);
  const requestedName = typeof reciprocalName === 'string' ? reciprocalName.trim() : '';
  const sourceTitle =
    sourceDb && typeof sourceDb.title === 'string' && sourceDb.title.trim() ? sourceDb.title.trim() : '';
  const name = requestedName || sourceTitle || 'Related';
  const targetProps = await propertiesForDatabase(properties, targetDbId);
  const maxPosition = targetProps.reduce((max, item) => Math.max(max, item.position ?? 0), 0);

  const reciprocal: Record<string, unknown> = {
    id: reciprocalId,
    databaseId: targetDbId,
    name,
    type: 'relation',
    config: { relationDatabaseId: property.databaseId, relatedPropertyId: property.id },
    position: maxPosition + 1,
  };
  await insertRecord(db, pages, 'db_properties', reciprocal, actorId, actorEmail);

  // Mirror the web app's addProperty view handling: append the reciprocal to any
  // target view that pins an explicit property order / visible list, so the new
  // column shows up in configured/imported views instead of staying hidden.
  const viewsTable = db.table<DbView>('db_views');
  const views = await listAll(viewsTable.where('databaseId', '==', targetDbId));
  for (const view of views) {
    const config = view.config;
    if (!config) continue;
    const order = config.propertyOrder;
    const visible = config.visibleProperties;
    const nextConfig: Record<string, unknown> = { ...config };
    let changed = false;
    if (Array.isArray(order) && !order.includes(reciprocalId)) {
      nextConfig.propertyOrder = [...order, reciprocalId];
      changed = true;
    }
    if (Array.isArray(visible) && !visible.includes(reciprocalId)) {
      nextConfig.visibleProperties = [...visible, reciprocalId];
      changed = true;
    }
    if (changed) await viewsTable.update(view.id, { config: nextConfig });
  }
}

async function deleteReciprocalRelationProperty(
  db: DbRef,
  pages: TableRef<Page>,
  property: DbProperty,
  actorId: string,
  actorEmail: string | null | undefined,
) {
  if (property.type !== 'relation') return;
  const reciprocalId = relationReciprocalId(property);
  if (!reciprocalId) return;
  const properties = db.table<DbProperty>('db_properties');
  const reciprocal = await getExisting(properties, reciprocalId);
  // Only delete the paired property when it is a relation that actually points
  // back at this one, so a stale/dangling relatedPropertyId can never delete an
  // unrelated property.
  if (
    !reciprocal
    || reciprocal.type !== 'relation'
    || relationTargetDatabaseId(reciprocal) !== property.databaseId
  ) return;
  await deleteRecord(db, pages, 'db_properties', reciprocal.id, actorId, reciprocal.databaseId, actorEmail);
}

export const POST = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const actorEmail = auth.email ?? null;

  try {
    // Inside the try so routing misses map to 404 via the catch below.
    const db = body.workspaceId
      ? boundedDbFromWorkspaceHint(admin, body.workspaceId)
      : await boundedDbFromPageHint(
          admin,
          body.databaseId,
          body.id,
          (body.record as { databaseId?: unknown } | undefined)?.databaseId,
          (body.patch as { databaseId?: unknown } | undefined)?.databaseId,
          (Array.isArray(body.records) ? (body.records[0] as { databaseId?: unknown } | undefined) : undefined)
            ?.databaseId,
        );
    const pages = db.table<Page>('pages');
    switch (action) {
      case 'createDatabase':
        return await createDatabase(db, admin, pages, body, auth.id, actorEmail, request?.url);
      case 'insert': {
        const table = parseTable(body.table);
        const record =
          body.record && typeof body.record === 'object'
            ? (body.record as Record<string, unknown>)
            : {};
        const inserted = await insertRecord(db, pages, table, record, auth.id, actorEmail);
        if (table === 'db_properties') {
          await bestEffort(
            'database-mutation ensureReciprocalRelationProperty after insert',
            ensureReciprocalRelationProperty(
              db, pages, inserted as unknown as DbProperty, auth.id, actorEmail, optionalString(body.reciprocalName),
            ),
          );
        }
        return { record: inserted };
      }
      case 'insertMany': {
        const table = parseTable(body.table);
        const rawRecords = Array.isArray(body.records) ? body.records : [];
        const records = rawRecords.map((record, index) => recordInput(record, `records[${index}]`));
        const insertedMany = await insertRecordsAtomically(db, pages, table, records, auth.id, actorEmail);
        if (table === 'db_properties') {
          for (const inserted of insertedMany) {
            await bestEffort(
              'database-mutation ensureReciprocalRelationProperty after insertMany',
              ensureReciprocalRelationProperty(
                db, pages, inserted as unknown as DbProperty, auth.id, actorEmail, optionalString(body.reciprocalName),
              ),
            );
          }
        }
        return { records: insertedMany };
      }
      case 'update': {
        const table = parseTable(body.table);
        const id = requireString(body.id, 'id');
        const patch =
          body.patch && typeof body.patch === 'object'
            ? (body.patch as Record<string, unknown>)
            : {};
        // Capture the old pair link so clearing relatedPropertyId (a two-way →
        // one-way toggle via update, e.g. from MCP/API) deletes the reciprocal.
        const beforeUpdate =
          table === 'db_properties'
            ? await getExisting(db.table<DbProperty>('db_properties'), id)
            : null;
        const previousReciprocalId = beforeUpdate ? relationReciprocalId(beforeUpdate) : '';
        const updated = await updateRecord(db, pages, table, id, patch, auth.id, optionalString(body.databaseId), actorEmail);
        if (table === 'db_properties') {
          const updatedProp = updated as unknown as DbProperty;
          const nextReciprocalId = relationReciprocalId(updatedProp);
          if (nextReciprocalId) {
            await bestEffort(
              'database-mutation ensureReciprocalRelationProperty after update',
              ensureReciprocalRelationProperty(
                db, pages, updatedProp, auth.id, actorEmail, optionalString(body.reciprocalName),
              ),
            );
          } else if (previousReciprocalId) {
            await bestEffort(
              'database-mutation deleteReciprocalRelationProperty after two-way toggle-off',
              deleteReciprocalRelationProperty(
                db,
                pages,
                { ...updatedProp, config: { ...updatedProp.config, relatedPropertyId: previousReciprocalId } },
                auth.id,
                actorEmail,
              ),
            );
          }
        }
        return { record: updated };
      }
      case 'updateMany': {
        const table = parseTable(body.table);
        const rawUpdates = Array.isArray(body.updates) ? body.updates : [];
        const updates = rawUpdates.map((item, index) => {
          const update = recordInput(item, `updates[${index}]`);
          return {
            id: requireString(update.id, `updates[${index}].id`),
            patch: update.patch === undefined ? {} : recordInput(update.patch, `updates[${index}].patch`),
            databaseId: optionalString(update.databaseId) ?? optionalString(body.databaseId),
          };
        });
        return { records: await updateRecordsAtomically(db, pages, table, updates, auth.id, actorEmail) };
      }
      case 'delete': {
        const table = parseTable(body.table);
        const id = requireString(body.id, 'id');
        // Capture a two-way relation property before deletion so we can cascade
        // to its paired property. skipReciprocal (used when the app deletes the
        // reciprocal itself during a two-way→one-way toggle) suppresses it.
        const skipReciprocal = body.skipReciprocal === true;
        const deletingProperty =
          table === 'db_properties' && !skipReciprocal
            ? await getExisting(db.table<DbProperty>('db_properties'), id)
            : null;
        const result = await deleteRecord(
          db,
          pages,
          table,
          id,
          auth.id,
          optionalString(body.databaseId),
          actorEmail,
          optionalString(body.workspaceId),
        );
        if (deletingProperty && relationReciprocalId(deletingProperty)) {
          await bestEffort(
            'database-mutation deleteReciprocalRelationProperty after delete',
            deleteReciprocalRelationProperty(db, pages, deletingProperty, auth.id, actorEmail),
          );
        }
        return result;
      }
      case 'deleteMany': {
        const table = parseTable(body.table);
        const rawIds = Array.isArray(body.ids) ? body.ids : [];
        const ids = rawIds.map((id, index) => requireString(id, `ids[${index}]`));
        return {
          deletedIds: await deleteRecordsAtomically(
            db,
            pages,
            table,
            ids,
            auth.id,
            optionalString(body.databaseId),
            actorEmail,
            optionalString(body.workspaceId),
          ),
        };
      }
      default:
        return jsonError(400, 'Unknown database mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error);
    return jsonError(status, message);
  }
  },
});
