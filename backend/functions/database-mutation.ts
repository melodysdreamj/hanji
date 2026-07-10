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

function viewConfigWithoutProperty(config: unknown, propertyId: string) {
  const next: Record<string, unknown> = isRecord(config) ? { ...config } : {};
  if (Array.isArray(next.visibleProperties)) {
    next.visibleProperties = next.visibleProperties.filter((id) => id !== propertyId);
  }
  if (Array.isArray(next.propertyOrder)) {
    next.propertyOrder = next.propertyOrder.filter((id) => id !== propertyId);
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
  const target = await getExistingRow(pages, targetDbId);
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

async function validateRecord(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  database: Page,
  record: DatabaseRecord,
) {
  if (table !== 'db_properties') return;
  await validatePropertyRecord(
    pages,
    db.table<DbProperty>('db_properties'),
    database,
    record as DbProperty,
  );
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

function optionFromInput(value: unknown, index: number) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const option = value as Record<string, unknown>;
    const name = typeof option.name === 'string' && option.name.trim() ? option.name.trim() : `Option ${index + 1}`;
    return {
      id: typeof option.id === 'string' && option.id.trim() ? option.id.trim() : newId(),
      name,
      color:
        typeof option.color === 'string' && option.color.trim()
          ? option.color.trim()
          : optionColors[index % optionColors.length],
    };
  }
  const name = typeof value === 'string' && value.trim() ? value.trim() : `Option ${index + 1}`;
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

function propertyConfigFromInput(type: string, input: Record<string, unknown>, databaseId: string) {
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
        options: rawOptions.map(optionFromInput),
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

function starterDatabaseProperties(databaseId: string): DbProperty[] {
  return [
    { id: newId(), databaseId, name: 'Name', type: 'title', position: 1 },
    {
      id: newId(),
      databaseId,
      name: 'Status',
      type: 'status',
      position: 2,
      config: {
        options: [
          starterOption('Not started', 'gray'),
          starterOption('In progress', 'blue'),
          starterOption('Done', 'green'),
        ],
      },
    },
    {
      id: newId(),
      databaseId,
      name: 'Tags',
      type: 'multi_select',
      position: 3,
      config: {
        options: [starterOption('Idea', 'purple'), starterOption('Urgent', 'red')],
      },
    },
  ];
}

function databaseViewLabel(type: StarterViewType) {
  if (type === 'table') return 'Table';
  if (type === 'board') return 'Board';
  if (type === 'list') return 'List';
  if (type === 'timeline') return 'Timeline';
  if (type === 'calendar') return 'Calendar';
  return 'Gallery';
}

function customDatabaseProperties(databaseId: string, rawProperties: unknown) {
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
      config: propertyConfigFromInput(type, input, databaseId),
      position: finiteNumber(input.position) ?? index + 1,
    });
  }

  if (titleCount === 0) {
    properties.unshift({ id: newId(), databaseId, name: names.has('name') ? 'Title' : 'Name', type: 'title', position: 1 });
    for (let index = 1; index < properties.length; index += 1) {
      if (!Number.isFinite(properties[index].position) || properties[index].position <= index) {
        properties[index].position = index + 1;
      }
    }
  }

  return properties;
}

function starterDatabaseSchema(databaseId: string, viewType: StarterViewType, rawProperties?: unknown) {
  const properties = customDatabaseProperties(databaseId, rawProperties) ?? starterDatabaseProperties(databaseId);
  const config: Record<string, unknown> = {
    propertyOrder: properties.map((prop) => prop.id),
    visibleProperties: properties.map((prop) => prop.id),
  };

  if (viewType === 'board') {
    const groupProp = properties.find((prop) => prop.type === 'status' || prop.type === 'select');
    if (groupProp) config.groupBy = groupProp.id;
  }

  if (viewType === 'calendar' || viewType === 'timeline') {
    const dateProp: DbProperty = {
      id: newId(),
      databaseId,
      name: 'Date',
      type: 'date',
      position: properties.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1,
    };
    properties.push(dateProp);
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
    name: databaseViewLabel(viewType),
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
  const { properties, view } = starterDatabaseSchema(id, viewType, body.properties);
  const created = {
    pageId: '',
    propertyIds: [] as string[],
    viewIds: [] as string[],
    rowIds: [] as string[],
  };

  try {
    const insertedPage = await pages.insert(page);
    created.pageId = insertedPage.id;
    // Databases and their starter rows are page rows; write their routing
    // index synchronously so immediate follow-up mutations resolve.
    await ensurePageWorkspaceIndex(admin, insertedPage.id, insertedPage.workspaceId);

    const propertiesTable = db.table<DbProperty>('db_properties');
    const insertedProperties: DbProperty[] = [];
    for (const property of properties) {
      await validatePropertyRecord(pages, propertiesTable, insertedPage, property, properties);
      const inserted = await propertiesTable.insert(property);
      insertedProperties.push(inserted);
      created.propertyIds.push(inserted.id);
    }

    const insertedView = await db.table<DbView>('db_views').insert(view);
    created.viewIds.push(insertedView.id);

    const rowCount = body.seedRows === false ? 0 : 3;
    const insertedRows: Page[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      const row = await pages.insert(starterDatabaseRow(insertedPage, index + 1, actorId));
      insertedRows.push(row);
      created.rowIds.push(row.id);
      await ensurePageWorkspaceIndex(admin, row.id, row.workspaceId);
    }
    await bestEffort('database-mutation upsertDatabaseIndexesForRows(db, insertedRows)', upsertDatabaseIndexesForRows(db, insertedRows));

    return {
      page: insertedPage,
      properties: insertedProperties,
      views: [insertedView],
      templates: [],
      rows: insertedRows,
    };
  } catch (error) {
    await Promise.all(created.rowIds.map((rowId) => bestEffort('database-mutation pages.delete(rowId)', pages.delete(rowId))));
    await Promise.all(created.viewIds.map((viewId) => bestEffort('database-mutation db.table(db_views).delete(viewId)', db.table<DbView>('db_views').delete(viewId))));
    await Promise.all(
      created.propertyIds.map((propertyId) =>
bestEffort('database-mutation db.table(db_properties).delete(pro', db.table<DbProperty>('db_properties').delete(propertyId)),
      ),
    );
    if (created.pageId) await bestEffort('database-mutation pages.delete(created.pageId)', pages.delete(created.pageId));
    throw error;
  }
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
  const inserted = await getTable<T>(db, table).insert(cleaned as Partial<T>);
  await refreshInsertedPropertyIndexes(db, pages, table, [inserted as DatabaseRecord]);
  return inserted;
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
  await transactUnitsChunked(db, prepared.map((record): TransactOperation[] => [{
    table,
    op: 'insert',
    data: record as unknown as Record<string, unknown>,
  }]));
  await refreshInsertedPropertyIndexes(db, pages, table, prepared);
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
  await validateRecord(db, pages, table, database, { ...existing, ...cleaned } as DatabaseRecord);
  const updated = await tableRef.update(id, cleaned);
  if (table === 'db_properties') {
    await bestEffort('database-mutation refreshDatabasePropertyIndexes(db, pages, (updat', refreshDatabasePropertyIndexes(db, pages, (updated as unknown as DbProperty).databaseId));
  }
  return updated;
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
    prepared.push({ existing, patch, record: { ...existing, ...patch } as DatabaseRecord });
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

  await transactUnitsChunked(db, prepared.map(({ existing, patch }): TransactOperation[] => [{
    table,
    op: 'update',
    id: existing.id,
    data: patch as Record<string, unknown>,
  }]));
  await refreshInsertedPropertyIndexes(db, pages, table, prepared.map(({ record }) => record));
  return prepared.map(({ record }) => record);
}

// Packs op units into transact batches under MAX_RAW_TRANSACT_OPS raw ops
// (the boundedDb facade appends one change_log insert per op on change-logged
// tables — workspace-db.ts). A unit's ops (an expect and the update it guards)
// always share a chunk.
async function transactUnitsChunked(db: DbRef, units: TransactOperation[][]) {
  let chunk: TransactOperation[] = [];
  for (const unit of units) {
    if (chunk.length > 0 && chunk.length + unit.length > MAX_RAW_TRANSACT_OPS) {
      await db.transact(chunk);
      chunk = [];
    }
    chunk.push(...unit);
  }
  if (chunk.length > 0) await db.transact(chunk);
}

async function deleteRecordsAtomically(
  db: DbRef,
  pages: TableRef<Page>,
  table: DatabaseTable,
  ids: string[],
  actorId: string,
  expectedDatabaseId?: string | null,
  actorEmail?: string | null,
) {
  if (ids.length === 0) return [];
  if (table === 'db_properties') {
    if (ids.length > 1) {
      throw new Error('deleteMany cannot combine multiple property schema deletions; send them as individual deletes.');
    }
    const result = await deleteRecord(db, pages, table, ids[0], actorId, expectedDatabaseId, actorEmail);
    return [result.deletedId];
  }

  const tableRef = getTable<DatabaseRecord>(db, table);
  const seen = new Set<string>();
  const existingIds: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Database record ${id} appears more than once in deleteMany.`);
    seen.add(id);
    const existing = await getExisting(tableRef, id);
    if (!existing) continue;
    assertExpectedDatabase(existing, expectedDatabaseId);
    await assertDatabaseWritable(db, pages, existing.databaseId, actorId, actorEmail);
    existingIds.push(id);
  }
  if (existingIds.length > 0) {
    await transactUnitsChunked(db, existingIds.map((id): TransactOperation[] => [{ table, op: 'delete', id }]));
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
) {
  const tableRef = getTable<T>(db, table);
  const existing = await getExisting(tableRef, id);
  if (!existing) return { deletedId: id };
  assertExpectedDatabase(existing, expectedDatabaseId);
  await assertDatabaseWritable(db, pages, existing.databaseId, actorId, actorEmail);
  if (table === 'db_properties') {
    const property = existing as unknown as DbProperty;
    if (property.type === 'title') throw new Error('The title property cannot be deleted.');

    const [views, templates, props, propertyIndexes] = await Promise.all([
      listAll(db.table<DbView>('db_views').where('databaseId', '==', property.databaseId)),
      listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', property.databaseId)),
      listAll(db.table<DbProperty>('db_properties').limit(1000)),
      listAll(db.table<{ id: string }>('db_property_indexes').where('propertyId', '==', property.id)),
    ]);
    const viewUpdates = views
      .map((view) => {
        const config = viewConfigWithoutProperty(view.config, property.id);
        return jsonChanged(view.config, config) ? { id: view.id, config } : null;
      })
      .filter((item): item is { id: string; config: Record<string, unknown> } => !!item);
    const templateUpdates = templates
      .filter((template) => isRecord(template.properties) && property.id in template.properties)
      .map((template) => {
        const properties = { ...(template.properties ?? {}) };
        delete properties[property.id];
        return { id: template.id, properties };
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
        return changed ? { id: item.id, config } : null;
      })
      .filter((item): item is { id: string; config: Record<string, unknown> } => !!item);

    // Row property payloads are rewritten read-modify-write; each row update
    // is paired with an expect on the updatedAt it was computed from, so a
    // concurrent row edit aborts the batch instead of being silently
    // overwritten. Conflicts re-read the rows and retry a bounded number of
    // times. The property row is deleted LAST so a partial chunked failure
    // leaves the delete visibly incomplete and retryable.
    const MAX_PROPERTY_DELETE_ATTEMPTS = 3;
    let rowUpdateCount = 0;
    for (let attempt = 1; ; attempt += 1) {
      const rows = await listAll(pages.where('parentId', '==', property.databaseId));
      const rowUpdates = rows
        .filter((row) => row.parentType === 'database' && isRecord(row.properties) && property.id in row.properties)
        .map((row) => {
          const properties = { ...(row.properties ?? {}) };
          delete properties[property.id];
          return { id: row.id, updatedAt: row.updatedAt, properties };
        });
      rowUpdateCount = rowUpdates.length;
      // Units keep an expect and its guarded update in the same transact chunk.
      const units: TransactOperation[][] = [
        ...rowUpdates.map((row): TransactOperation[] => [
          // Fixture rows without updatedAt fall back to an unguarded update.
          ...(typeof row.updatedAt === 'string'
            ? [{
                table: 'pages',
                op: 'expect',
                where: [['id', '==', row.id], ['updatedAt', '==', row.updatedAt]],
                exists: true,
              } satisfies TransactOperation]
            : []),
          { table: 'pages', op: 'update', id: row.id, data: { properties: row.properties } },
        ]),
        ...viewUpdates.map((view): TransactOperation[] => [
          { table: 'db_views', op: 'update', id: view.id, data: { config: view.config } },
        ]),
        ...templateUpdates.map((template): TransactOperation[] => [
          { table: 'db_templates', op: 'update', id: template.id, data: { properties: template.properties } },
        ]),
        ...propertyUpdates.map((item): TransactOperation[] => [
          { table: 'db_properties', op: 'update', id: item.id, data: { config: item.config } },
        ]),
        ...propertyIndexes.map((index): TransactOperation[] => [
          { table: 'db_property_indexes', op: 'delete', id: index.id },
        ]),
        [{ table: 'db_properties', op: 'delete', id }],
      ];
      try {
        await transactUnitsChunked(db, units);
        break;
      } catch (error) {
        const conflict = error instanceof Error && error.message.includes('Transaction expectation failed');
        if (!conflict) throw error;
        if (attempt >= MAX_PROPERTY_DELETE_ATTEMPTS) {
          throw Object.assign(
            new Error('Database rows changed while the property was being deleted. Retry the delete.'),
            { status: 409 },
          );
        }
      }
    }
    return {
      deletedId: id,
      cleanup: {
        rows: rowUpdateCount,
        views: viewUpdates.length,
        templates: templateUpdates.length,
        properties: propertyUpdates.length,
      },
    };
  }
  // Views/templates are the primary record here. Propagate a delete failure
  // rather than returning a false success response.
  await tableRef.delete(id);
  return { deletedId: id };
}

export const POST = defineFunction(async (context) => {
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
        return await createDatabase(db, admin, pages, body, auth.id, actorEmail);
      case 'insert': {
        const table = parseTable(body.table);
        const record =
          body.record && typeof body.record === 'object'
            ? (body.record as Record<string, unknown>)
            : {};
        return { record: await insertRecord(db, pages, table, record, auth.id, actorEmail) };
      }
      case 'insertMany': {
        const table = parseTable(body.table);
        const rawRecords = Array.isArray(body.records) ? body.records : [];
        const records = rawRecords.map((record, index) => recordInput(record, `records[${index}]`));
        return { records: await insertRecordsAtomically(db, pages, table, records, auth.id, actorEmail) };
      }
      case 'update': {
        const table = parseTable(body.table);
        const id = requireString(body.id, 'id');
        const patch =
          body.patch && typeof body.patch === 'object'
            ? (body.patch as Record<string, unknown>)
            : {};
        return { record: await updateRecord(db, pages, table, id, patch, auth.id, optionalString(body.databaseId), actorEmail) };
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
        return await deleteRecord(db, pages, table, requireString(body.id, 'id'), auth.id, optionalString(body.databaseId), actorEmail);
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
});
