import { bestEffort, nowIso } from './table-utils';

interface ListResult<T> {
  items?: T[];
  hasMore?: boolean;
}

interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  getList(): Promise<ListResult<T>>;
}

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
}

export interface DatabaseIndexPage {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string | null;
  title?: string;
  properties?: Record<string, unknown>;
  createdBy?: string;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DatabaseIndexProperty {
  id: string;
  databaseId: string;
  name?: string;
  type: string;
  config?: Record<string, unknown>;
  updatedAt?: string;
}

export interface DbPropertyIndex {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  propertyId: string;
  propertyType: string;
  valueKind: string;
  stringValue?: string;
  numberValue?: number;
  dateValue?: string;
  booleanValue?: boolean;
  searchText?: string;
  rowUpdatedAt?: string;
  propertyUpdatedAt?: string;
  updatedAt?: string;
}

type DbPropertyIndexWrite = Omit<DbPropertyIndex, 'id'> & { id?: string };

const MAX_INDEX_TEXT_LENGTH = 2048;

async function listAll<T>(query: TableQuery<T>, maxPages = 200): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await query.page(page).limit(1000).getList();
    const items = res.items ?? [];
    out.push(...items);
    if (!res.hasMore || items.length === 0) break;
  }
  return out;
}

function truncateText(value: string) {
  return value.length > MAX_INDEX_TEXT_LENGTH ? value.slice(0, MAX_INDEX_TEXT_LENGTH) : value;
}

function stripUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function databasePropertyIndexKey(rowId: string, propertyId: string) {
  return `${rowId}:${propertyId}`;
}

export function databasePropertyIndexMap(indexes: DbPropertyIndex[]) {
  return new Map(indexes.map((index) => [databasePropertyIndexKey(index.rowId, index.propertyId), index]));
}

function optionName(prop: DatabaseIndexProperty, id: string) {
  const options = Array.isArray(prop.config?.options) ? prop.config.options : [];
  for (const option of options) {
    const record = recordObject(option);
    if (!record) continue;
    if (record.id === id || record.name === id) {
      return typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
    }
  }
  return id;
}

function optionIds(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value == null || value === '' ? [] : [String(value)];
}

function rawValueForProperty(row: DatabaseIndexPage, prop: DatabaseIndexProperty): unknown {
  if (prop.type === 'title') return row.title;
  if (prop.type === 'created_time') return row.createdAt;
  if (prop.type === 'last_edited_time') return row.updatedAt;
  if (prop.type === 'created_by') return row.createdBy;
  if (prop.type === 'last_edited_by') return row.lastEditedBy;
  return row.properties?.[prop.id];
}

function textForUnknown(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textForUnknown).filter(Boolean).join(' ');
  const record = recordObject(value);
  if (!record) return '';
  const direct =
    record.name ??
    record.label ??
    record.title ??
    record.plain_text ??
    record.plainText ??
    record.text ??
    record.url ??
    record.id ??
    record.userId;
  if (typeof direct === 'string' || typeof direct === 'number' || typeof direct === 'boolean') {
    return String(direct);
  }
  if (typeof record.start === 'string') return record.start;
  try {
    return JSON.stringify(record);
  } catch {
    return '';
  }
}

function dateText(value: unknown) {
  const raw = recordObject(value)?.start ?? value;
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return raw.trim().slice(0, 10);
}

function normalizeIndexValue(row: DatabaseIndexPage, prop: DatabaseIndexProperty) {
  const raw = rawValueForProperty(row, prop);
  let valueKind = 'text';
  let stringValue: string | undefined;
  let numberValue: number | undefined;
  let dateValue: string | undefined;
  let booleanValue: boolean | undefined;
  let searchText = '';

  if (prop.type === 'number' || prop.type === 'unique_id') {
    // Empty cells stay unindexed; Number(null)/Number('') would coerce to 0.
    const hasValue = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
    const number = hasValue ? Number(raw) : Number.NaN;
    valueKind = 'number';
    if (Number.isFinite(number)) {
      numberValue = number;
      stringValue = String(number);
      searchText = stringValue;
    }
  } else if (prop.type === 'checkbox') {
    booleanValue = raw === true || raw === 'true';
    valueKind = 'boolean';
    stringValue = booleanValue ? 'true' : 'false';
    searchText = booleanValue ? 'checked true yes' : 'unchecked false no';
  } else if (prop.type === 'date' || prop.type === 'created_time' || prop.type === 'last_edited_time') {
    dateValue = dateText(raw);
    valueKind = 'date';
    stringValue = dateValue || undefined;
    searchText = dateValue;
  } else if (prop.type === 'select' || prop.type === 'status') {
    const id = optionIds(raw)[0] ?? '';
    stringValue = id ? optionName(prop, id) : undefined;
    valueKind = 'option';
    searchText = stringValue ?? '';
  } else if (prop.type === 'multi_select') {
    const names = optionIds(raw).map((id) => optionName(prop, id));
    stringValue = names.join(' ') || undefined;
    valueKind = 'options';
    searchText = stringValue ?? '';
  } else if (prop.type === 'person' || prop.type === 'created_by' || prop.type === 'last_edited_by') {
    stringValue = textForUnknown(raw) || undefined;
    valueKind = 'person';
    searchText = stringValue ?? '';
  } else if (prop.type === 'relation') {
    stringValue = optionIds(raw).join(' ') || undefined;
    valueKind = 'relation';
    searchText = stringValue ?? '';
  } else {
    stringValue = textForUnknown(raw) || undefined;
    searchText = stringValue ?? '';
  }

  return {
    valueKind,
    stringValue: stringValue ? truncateText(stringValue) : undefined,
    numberValue,
    dateValue,
    booleanValue,
    searchText: searchText ? truncateText(searchText.toLowerCase()) : undefined,
  };
}

export function indexedSortValue(index: DbPropertyIndex | undefined, propertyType: string): number | string | undefined {
  if (!index) return undefined;
  if (propertyType === 'number' || propertyType === 'unique_id') {
    return Number.isFinite(index.numberValue) ? index.numberValue : undefined;
  }
  if (propertyType === 'checkbox') return index.booleanValue ? 1 : 0;
  if (propertyType === 'date' || propertyType === 'created_time' || propertyType === 'last_edited_time') {
    return index.dateValue || undefined;
  }
  if (
    propertyType === 'title' ||
    propertyType === 'rich_text' ||
    propertyType === 'url' ||
    propertyType === 'email' ||
    propertyType === 'phone'
  ) {
    return index.stringValue?.toLowerCase();
  }
  return undefined;
}

export function indexedDisplayText(index: DbPropertyIndex | undefined, propertyType: string): string | undefined {
  if (!index) return undefined;
  if (propertyType === 'checkbox') return index.searchText;
  if (
    propertyType === 'title' ||
    propertyType === 'rich_text' ||
    propertyType === 'number' ||
    propertyType === 'unique_id' ||
    propertyType === 'select' ||
    propertyType === 'multi_select' ||
    propertyType === 'status' ||
    propertyType === 'date' ||
    propertyType === 'url' ||
    propertyType === 'email' ||
    propertyType === 'phone' ||
    propertyType === 'person' ||
    propertyType === 'created_time' ||
    propertyType === 'last_edited_time' ||
    propertyType === 'created_by' ||
    propertyType === 'last_edited_by'
  ) {
    return index.searchText ?? index.stringValue ?? '';
  }
  return undefined;
}

function indexRecordForProperty(row: DatabaseIndexPage, prop: DatabaseIndexProperty): DbPropertyIndexWrite {
  return {
    workspaceId: row.workspaceId,
    databaseId: prop.databaseId,
    rowId: row.id,
    propertyId: prop.id,
    propertyType: prop.type,
    ...normalizeIndexValue(row, prop),
    rowUpdatedAt: row.updatedAt,
    propertyUpdatedAt: prop.updatedAt,
    updatedAt: nowIso(),
  };
}

async function findExistingIndex(
  table: TableRef<DbPropertyIndex>,
  record: Pick<DbPropertyIndex, 'databaseId' | 'rowId' | 'propertyId'>,
) {
  const existingForRow = await listAll(table.where('rowId', '==', record.rowId));
  return existingForRow.find((index) =>
    index.databaseId === record.databaseId &&
    index.propertyId === record.propertyId
  );
}

async function upsertIndex(
  table: TableRef<DbPropertyIndex>,
  record: DbPropertyIndexWrite,
  existing?: DbPropertyIndex,
) {
  const current = existing ?? await findExistingIndex(table, record);
  if (current) return await table.update(current.id, stripUndefined({ ...record, id: current.id }));
  const { id: _id, ...insertable } = record;
  return await table.insert(stripUndefined(insertable));
}

export async function deleteDatabaseRowIndexes(db: DbRef, rowId: string) {
  const table = db.table<DbPropertyIndex>('db_property_indexes');
  const existing = await listAll(table.where('rowId', '==', rowId));
  await Promise.all(existing.map((index) => bestEffort('database-index table.delete', table.delete(index.id))));
}

export async function deleteDatabasePropertyIndexes(db: DbRef, propertyId: string) {
  const table = db.table<DbPropertyIndex>('db_property_indexes');
  const existing = await listAll(table.where('propertyId', '==', propertyId));
  await Promise.all(existing.map((index) => bestEffort('database-index table.delete', table.delete(index.id))));
}

export async function upsertDatabaseRowIndexes(
  db: DbRef,
  row: DatabaseIndexPage,
  props: DatabaseIndexProperty[],
) {
  if (row.parentType !== 'database' || !row.parentId) return [];
  const table = db.table<DbPropertyIndex>('db_property_indexes');
  const databaseProps = props.filter((prop) => prop.databaseId === row.parentId);
  const validPropertyIds = new Set(databaseProps.map((prop) => prop.id));
  const existing = await listAll(table.where('rowId', '==', row.id));
  const existingByPropertyId = new Map(existing.map((index) => [index.propertyId, index]));
  await Promise.all(
    existing
      .filter((index) => index.databaseId === row.parentId && !validPropertyIds.has(index.propertyId))
      .map((index) => bestEffort('database-index table.delete', table.delete(index.id))),
  );
  return await Promise.all(
    databaseProps.map((prop) =>
      upsertIndex(table, indexRecordForProperty(row, prop), existingByPropertyId.get(prop.id))
    ),
  );
}

export async function upsertDatabaseIndexesForRows(db: DbRef, rows: DatabaseIndexPage[]) {
  const databaseIds = Array.from(new Set(rows.map((row) => row.parentId).filter((id): id is string => !!id)));
  if (databaseIds.length === 0) return [];
  const propertiesByDb = new Map<string, DatabaseIndexProperty[]>();
  await Promise.all(databaseIds.map(async (databaseId) => {
    const props = await listAll(db.table<DatabaseIndexProperty>('db_properties').where('databaseId', '==', databaseId));
    propertiesByDb.set(databaseId, props);
  }));
  const updated: DbPropertyIndex[] = [];
  for (const row of rows) {
    const props = row.parentId ? propertiesByDb.get(row.parentId) ?? [] : [];
    updated.push(...(await upsertDatabaseRowIndexes(db, row, props)));
  }
  return updated;
}

export async function ensureDatabasePropertyIndexes(
  db: DbRef,
  database: { id: string; workspaceId: string },
  rows: DatabaseIndexPage[],
  props: DatabaseIndexProperty[],
) {
  const table = db.table<DbPropertyIndex>('db_property_indexes');
  const databaseRows = rows.filter((row) => row.parentType === 'database' && row.parentId === database.id);
  const indexes = await listAll(table.where('databaseId', '==', database.id));
  const indexByKey = databasePropertyIndexMap(indexes);
  const rowIds = new Set(databaseRows.map((row) => row.id));
  const propIds = new Set(props.map((prop) => prop.id));
  let changed = false;

  for (const row of databaseRows) {
    for (const prop of props) {
      const index = indexByKey.get(databasePropertyIndexKey(row.id, prop.id));
      const stale =
        !index ||
        index.workspaceId !== database.workspaceId ||
        index.propertyType !== prop.type ||
        index.rowUpdatedAt !== row.updatedAt ||
        index.propertyUpdatedAt !== prop.updatedAt;
      if (!stale) continue;
      const record = await upsertIndex(table, indexRecordForProperty(row, prop), index);
      indexByKey.set(databasePropertyIndexKey(row.id, prop.id), record);
      changed = true;
    }
  }

  await Promise.all(
    indexes
      .filter((index) => !rowIds.has(index.rowId) || !propIds.has(index.propertyId))
      .map(async (index) => {
        changed = true;
        await bestEffort('database-index table.delete', table.delete(index.id));
        indexByKey.delete(databasePropertyIndexKey(index.rowId, index.propertyId));
      }),
  );

  return changed ? await listAll(table.where('databaseId', '==', database.id)) : indexes;
}
