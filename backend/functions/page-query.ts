import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import {
  HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER,
  hasHanjiImportedRowContextFilterMarker,
  isHanjiCurrentPageFilterValue,
  normalizeLegacyHanjiUri,
} from '../lib/hanji-compat';
import {
  decodeSearchSourceCursor,
  encodeSearchSourceCursor,
} from '../lib/search-source-cursor';
import {
  boundedDbFromPageHint,
  boundedDbFromWorkspaceHint,
} from '../lib/workspace-db';
import {
  assertNotDeactivatedWorkspaceAccess,
  organizationMemberForNotDeactivatedWorkspace,
} from '../lib/org-access';
import {
  databasePropertyIndexKey,
  databasePropertyIndexMap,
  ensureDatabasePropertyIndexes,
  indexedDisplayText,
  indexedSortValue,
  type DbPropertyIndex,
} from '../lib/database-index';
import {
  actorPagePermissions,
  normalizeAccessEmail,
  pageAccessDecisions,
  pageHasDirectAccess as sharedPageHasDirectAccess,
  workspaceHasMembershipForActor,
} from '../lib/page-access';
import {
  evaluateFormulaExpression,
  formulaPropertyReferences,
  formatFormulaValue as formatFormulaCoreValue,
  type FormulaValue,
} from '../../shared/database/formula-core';
import { formulaPropertyValue } from '../lib/formula-property-value';
import {
  evaluateRollup as evaluateRollupCore,
  type RollupContext,
  type RollupPage,
  type RollupProperty,
} from '../../shared/database/rollup-core';
import {
  compareKeys as coreCompareKeys,
  filterMatches as coreFilterMatches,
  sortKey as coreSortKey,
  type QueryAdapters,
  type QueryFilter,
  type QueryPage,
  type QueryProperty,
} from '../../shared/database/query-core';
import { foldNfcText, naturalOrderTokens } from '../../shared/database/natural-order.mjs';
import { blockReferenceKind } from '../../shared/page-references.mjs';

import {
  DEFAULT_LIST_ALL_MAX_ITEMS,
  getExisting,
  isTransactionConflictError,
  listAll,
  narrowWhere,
  newId,
  nowIso,
  requireString,
  type TableQuery,
  type TransactOperation,
  type TransactDb,
} from '../lib/table-utils';
import type {
  Block,
  Comment,
  DbProperty,
  DbTemplate,
  DbView,
  FunctionContext as AppFunctionContext,
  OrganizationGroupMember,
  OrganizationMember,
  OrganizationPolicyVersion,
  Page,
  PagePermission,
  SearchGroupAuthority,
  SearchGroupMembership,
  SearchGroupMembershipSnapshot,
  SearchRelatedRelation,
  TableRef as AppTableRef,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';

// page-query lists entire tables without a `.where()` filter, so its table
// refs must also expose the TableQuery paging surface EdgeBase provides at
// runtime (`page`/`limit`/`getList`). Type-only extension of the canonical
// app-types shapes; no runtime difference.
type TableRef<T> = AppTableRef<T> & TableQuery<T>;

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface DatabaseDependencyEdge {
  id: string;
  workspaceId: string;
  databaseId: string;
  dataKey?: string;
  predecessorRowId: string;
  successorRowId: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

type FunctionContext = Omit<AppFunctionContext, 'admin'> & {
  admin: { db(namespace: string, instanceId?: string): DbRef };
};
const NOTION_CREATED_TIME_KEY = '__notionCreatedTime';
const NOTION_LAST_EDITED_TIME_KEY = '__notionLastEditedTime';
const TARGETED_IMPORT_ORDER_QUERY_LIMIT = 100;
const QUERY_FANOUT_LIMIT = 12;
const SEARCH_SOURCE_WINDOW_SIZE = 100;
const SEARCH_PAGE_ID_CHUNK_SIZE = 100;
const SEARCH_AUTHORITY_ANCESTOR_MAX_DEPTH = 256;
const SEARCH_REQUIRED_ANCESTOR_MAX_IDS = 1_000;
const SEARCH_REQUIRED_ANCESTOR_MAX_ID_LENGTH = 512;
const SEARCH_METADATA_MAX_VALUES = 512;
const SEARCH_METADATA_MAX_DEPTH = 8;
const SEARCH_METADATA_MAX_TEXT_LENGTH = 64 * 1024;
const SEARCH_GROUP_SYNC_WINDOW_SIZE = 100;
const SEARCH_GROUP_SYNC_WRITE_RETRIES = 4;
const SEARCH_SOURCE_CURSOR_MAX_BYTES = 8 * 1024;
const DATABASE_QUERY_CONTEXT_CHUNK_SIZE = 100;
const DATABASE_QUERY_CONTEXT_CHUNK_CONCURRENCY = 4;
const DATABASE_QUERY_CONTEXT_MAX_TRACE_DEPTH = 16;
const SHARED_PAGE_TREE_QUERY_CHUNK_SIZE = 100;
const DATABASE_DEPENDENCY_EDGE_PAGE_SIZE = 50;
const DATABASE_DEPENDENCY_GRAPH_PAGE_SIZE = 200;
const DATABASE_DEPENDENCY_GRAPH_VISIBLE_ROW_LIMIT = 100;

interface NotionImportItem {
  id: string;
  workspaceId: string;
  jobId: string;
  itemGeneration?: string | null;
  notionId: string;
  notionObject: string;
  title?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

interface NotionImportJobGeneration {
  id: string;
  activeItemGeneration?: string | null;
}

interface NotionImportMapping {
  id: string;
  workspaceId: string;
  jobId: string;
  notionId: string;
  notionType?: string;
  localId: string;
  localType: string;
  relationKind?: string;
  metadata?: Record<string, unknown>;
}

type ComputedValue = FormulaValue;
type ComputedMap = Record<string, Record<string, { value: ComputedValue; formatted: string }>>;

function jsonError(status: number, message: string, headers?: HeadersInit) {
  return Response.json({ code: status, message }, { status, headers });
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

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

function chunksOf<T>(items: T[], size: number) {
  return Array.from(
    { length: Math.ceil(items.length / size) },
    (_, index) => items.slice(index * size, (index + 1) * size),
  );
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return fallback;
}

function parseLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function parseRequiredSearchAncestorIds(value: unknown) {
  if (value === undefined) return [] as string[];
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > SEARCH_REQUIRED_ANCESTOR_MAX_IDS
  ) {
    throw Object.assign(
      new Error(`requiredAncestorIds must contain 1-${SEARCH_REQUIRED_ANCESTOR_MAX_IDS} page ids.`),
      { status: 400 },
    );
  }
  const ids = value.map((candidate) => (
    typeof candidate === 'string' ? candidate.trim() : ''
  ));
  if (ids.some((id) => !id || id.length > SEARCH_REQUIRED_ANCESTOR_MAX_ID_LENGTH)) {
    throw Object.assign(
      new Error(
        `requiredAncestorIds entries must be non-empty strings up to ${SEARCH_REQUIRED_ANCESTOR_MAX_ID_LENGTH} characters.`,
      ),
      { status: 400 },
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('requiredAncestorIds must not contain duplicates.'), { status: 400 });
  }
  return ids.sort();
}

function parseSearchQuery(value: unknown) {
  if (typeof value !== 'string') {
    throw Object.assign(new Error('query is required.'), { status: 400 });
  }
  return foldNfcText(value.trim());
}

function parseOptionalLimit(value: unknown, max: number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function parseOffset(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

type DatabaseRowsRequestedSort = {
  propertyId: string;
  direction: 'asc' | 'desc';
};

const DATABASE_ROWS_CREATED_TIME_SORT_ID = '__hanji_database_rows_created_time';
const DATABASE_ROWS_LAST_EDITED_TIME_SORT_ID = '__hanji_database_rows_last_edited_time';

function parseDatabaseRowsRequestedSorts(value: unknown): DatabaseRowsRequestedSort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw Object.assign(new Error('databaseRowsSorts must contain 1 to 100 sort terms.'), { status: 400 });
  }
  return value.map((item) => {
    if (!isPlainRecord(item)) {
      throw Object.assign(new Error('databaseRowsSorts contains a malformed term.'), { status: 400 });
    }
    const propertyId = typeof item.propertyId === 'string' ? item.propertyId.trim() : '';
    if (!propertyId || propertyId.length > 256 || (item.direction !== 'asc' && item.direction !== 'desc')) {
      throw Object.assign(new Error('databaseRowsSorts contains a malformed term.'), { status: 400 });
    }
    return { propertyId, direction: item.direction };
  });
}

function parseDatabaseRowsCursorScope(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 32 * 1024) {
    throw Object.assign(new Error('databaseRowsCursorScope is malformed.'), { status: 400 });
  }
  return value;
}

function parseDatabaseRowsTargetId(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) {
    throw Object.assign(new Error('rowId is malformed.'), { status: 400 });
  }
  return value.trim();
}

function parseDatabaseRowsSubitemParentId(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length > 256) {
    throw Object.assign(new Error('subitemParentId is malformed.'), { status: 400 });
  }
  return value.trim();
}

const MAX_TIME_ZONE_LENGTH = 128;

function parseOptionalTimeZone(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('timeZone must be a valid IANA time zone.'), { status: 400 });
  }
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > MAX_TIME_ZONE_LENGTH) {
    throw Object.assign(new Error('timeZone must be a valid IANA time zone.'), { status: 400 });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw Object.assign(new Error('timeZone must be a valid IANA time zone.'), { status: 400 });
  }
  return timeZone;
}

function canonicalSearchRevisionValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalSearchRevisionValue);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareSearchRevisionKey(left, right))
      .map(([key, item]) => [key, canonicalSearchRevisionValue(item)]),
  );
}

function compareSearchRevisionKey(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function searchSnapshotRevision(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonicalSearchRevisionValue(value))),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function indexedSearchVariants(query: string) {
  return Array.from(new Set([
    query.normalize('NFC'),
    query.normalize('NFD'),
  ]));
}

async function indexedRelatedSearchPage<T>(
  table: TableRef<T>,
  query: string,
  queryVariants: string[],
  relation: SearchRelatedRelation,
  order: Array<{ field: string; direction: 'asc' }>,
  after: SearchSourceAfter | undefined,
  limit: number,
) {
  if (typeof table.searchRelated !== 'function') {
    throw Object.assign(
      new Error('Indexed search requires the EdgeBase related-search surface.'),
      { status: 500 },
    );
  }
  return table.searchRelated({
    query,
    ...(queryVariants.length > 0 ? { queryVariants } : {}),
    order,
    ...(after === undefined ? {} : { after }),
    limit,
    includeTotal: false,
    relation,
  });
}

type SearchSourceOrder = Array<{ field: string; direction: 'asc' }>;

function searchAfterForRow(row: Record<string, unknown>, order: SearchSourceOrder): SearchSourceAfter {
  return {
    values: order.map(({ field }) => {
      const value = row[field];
      if (typeof value !== 'string' || !value || value.length > 1_024) {
        throw Object.assign(
          new Error(`Indexed search returned an invalid '${field}' cursor value.`),
          { status: 500 },
        );
      }
      return value;
    }),
  };
}

function compareSearchAfter(left: SearchSourceAfter, right: SearchSourceAfter) {
  if (left.values.length !== right.values.length) return left.values.length - right.values.length;
  for (let index = 0; index < left.values.length; index += 1) {
    const order = compareSearchRevisionKey(left.values[index]!, right.values[index]!);
    if (order !== 0) return order;
  }
  return 0;
}

function stripIndexedSearchMetadata<T extends { id: string }>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'rank' && !key.endsWith('_highlighted')),
  ) as T;
}

type SearchSourceAfter = { values: string[] };

type SearchWindowCursor = {
  revision?: string;
  after?: SearchSourceAfter;
  skipPageId?: string;
  offset: number;
};

type SearchSourceCursor = {
  v: 1;
  fingerprint: string;
  window: SearchWindowCursor;
};

type IndexedSearchWindow<T> = {
  rows: T[];
  hasMore: boolean;
  boundary?: SearchSourceAfter;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sourceCursorError(message: string) {
  return Object.assign(new Error(`Search source cursor ${message}`), { status: 400 });
}

function boundedCursorString(value: unknown, label: string, maxLength = 1_024) {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw sourceCursorError(`${label} is malformed.`);
  }
  return value;
}

function parseSearchSourceAfter(value: unknown, orderWidth: number, label: string) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== 'values')) {
    throw sourceCursorError(`${label} is malformed.`);
  }
  const values = value.values;
  if (!Array.isArray(values) || values.length !== orderWidth) {
    throw sourceCursorError(`${label} width is malformed.`);
  }
  return { values: values.map((item) => boundedCursorString(item, `${label} value`)) };
}

function parseSearchSourceCursor(
  value: unknown,
  fingerprint: string,
  orderWidth: number,
  allowSkipPageId: boolean,
): SearchSourceCursor | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isPlainRecord(value)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > SEARCH_SOURCE_CURSOR_MAX_BYTES
  ) {
    throw sourceCursorError('is malformed.');
  }
  const allowed = new Set(['v', 'fingerprint', 'window']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw sourceCursorError('contains an unknown field.');
  }
  if (value.v !== 1 || value.fingerprint !== fingerprint) {
    throw sourceCursorError('does not match this search request.');
  }
  if (!isPlainRecord(value.window)) {
    throw sourceCursorError('result position is missing its verification window.');
  }
  if (Object.keys(value.window).some(
    (key) => key !== 'revision' && key !== 'after' && key !== 'skipPageId' && key !== 'offset',
  )) {
    throw sourceCursorError('window state is malformed.');
  }
  if (
    !Number.isSafeInteger(value.window.offset)
    || Number(value.window.offset) < 0
    || Number(value.window.offset) > SEARCH_SOURCE_WINDOW_SIZE
  ) {
    throw sourceCursorError('window offset is malformed.');
  }
  const offset = Number(value.window.offset);
  let revision: string | undefined;
  if (value.window.revision !== undefined) {
    revision = boundedCursorString(value.window.revision, 'window revision', 64);
    if (!/^[a-f0-9]{64}$/u.test(revision)) {
      throw sourceCursorError('window revision is malformed.');
    }
  }
  if (offset > 0 && !revision) {
    throw sourceCursorError('partially consumed window is missing its revision.');
  }
  const window: SearchWindowCursor = {
    offset,
    ...(revision ? { revision } : {}),
    ...(value.window.after === undefined
      ? {}
      : { after: parseSearchSourceAfter(value.window.after, orderWidth, 'window after') }),
    ...(value.window.skipPageId === undefined
      ? {}
      : {
          skipPageId: boundedCursorString(
            value.window.skipPageId,
            'window skip page id',
            256,
          ),
        }),
  };
  if (!allowSkipPageId && window.skipPageId) {
    throw sourceCursorError('window state contains unexpected page-deduplication state.');
  }
  return { v: 1, fingerprint, window };
}

async function searchRequestFingerprint(value: unknown) {
  return await searchSnapshotRevision(value);
}

async function pageSearchRequestFingerprint(
  actorId: string,
  normalizedEmail: string,
  query: string,
  workspaceId: string,
  includeTrash: boolean,
  requiredAncestorIds: string[],
) {
  return searchRequestFingerprint({
    v: 2,
    kind: 'pages',
    actorId,
    actorEmail: normalizedEmail,
    query,
    workspaceId,
    includeTrash,
    requiredAncestorIds,
  });
}

async function blockSearchRequestFingerprint(
  actorId: string,
  normalizedEmail: string,
  query: string,
  workspaceId: string,
  dedupePages: boolean,
  excludeMetadataMatches: boolean,
  includePages: boolean,
  requiredAncestorIds: string[],
) {
  return searchRequestFingerprint({
    v: 2,
    kind: 'blocks',
    actorId,
    actorEmail: normalizedEmail,
    query,
    workspaceId,
    dedupePages,
    excludeMetadataMatches,
    includePages,
    requiredAncestorIds,
  });
}

async function backlinksRequestFingerprint(
  actorId: string,
  normalizedEmail: string,
  targetPageId: string,
  workspaceId: string,
) {
  return searchRequestFingerprint({
    v: 1,
    kind: 'backlinks',
    actorId,
    actorEmail: normalizedEmail,
    targetPageId,
    workspaceId,
  });
}

async function collectIndexedSearchWindow<T extends { id: string }>(
  table: TableRef<T>,
  query: string,
  relation: SearchRelatedRelation,
  order: Array<{ field: string; direction: 'asc' }>,
  after: SearchSourceAfter | undefined,
  label: string,
): Promise<IndexedSearchWindow<T>> {
  const variants = indexedSearchVariants(query);
  const response = await indexedRelatedSearchPage(
    table,
    variants[0]!,
    variants.slice(1),
    relation,
    order,
    after,
    SEARCH_SOURCE_WINDOW_SIZE,
  );
  const rows = (response.items ?? []).map(stripIndexedSearchMetadata);
  let prior = after;
  for (const row of rows) {
    const next = searchAfterForRow(row, order);
    if (prior && compareSearchAfter(next, prior) <= 0) {
      throw Object.assign(new Error(`${label} returned a non-advancing keyset cursor.`), { status: 500 });
    }
    prior = next;
  }
  if (rows.length === 0 && response.hasMore) {
    throw Object.assign(new Error(`${label} returned an empty page with continuation.`), { status: 500 });
  }
  return {
    rows,
    hasMore: response.hasMore === true,
    ...(rows.length > 0 ? { boundary: searchAfterForRow(rows.at(-1)!, order) } : {}),
  };
}

function databaseRowsSearchRevisionInput(
  rows: Page[],
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
  computed: ComputedMap,
) {
  const propertySources = Array.from(propsByDb.entries())
    .sort(([left], [right]) => compareSearchRevisionKey(left, right))
    .map(([databaseId, properties]) => ({
      databaseId,
      properties: [...properties].sort((left, right) => (
        (left.position ?? 0) - (right.position ?? 0)
        || compareSearchRevisionKey(left.id, right.id)
      )),
    }));
  const dependencyPages = Array.from(pagesById.values())
    .sort((left, right) => compareSearchRevisionKey(left.id, right.id))
    .map((page) => ({
      id: page.id,
      workspaceId: page.workspaceId,
      parentId: page.parentId,
      parentType: page.parentType,
      kind: page.kind,
      title: page.title ?? '',
      position: page.position ?? 0,
      inTrash: page.inTrash === true,
      createdAt: page.createdAt ?? null,
      updatedAt: page.updatedAt ?? page.createdAt ?? null,
      properties: page.properties ?? {},
    }));
  return {
    rows: rows.map((row) => ({
      id: row.id,
      title: row.title ?? '',
      position: row.position ?? 0,
      updatedAt: row.updatedAt ?? row.createdAt ?? null,
      properties: row.properties ?? {},
    })),
    propertySources,
    dependencyPages,
    computed,
  };
}

type ViewFilterTerm = {
  propertyId?: unknown;
  operator?: unknown;
  value?: unknown;
};

type FilterGroupTerm = {
  conjunction?: unknown;
  filters?: unknown;
  groups?: unknown;
};

type ViewSortTerm = {
  propertyId?: unknown;
  direction?: unknown;
};

type DatabaseRowsQueryContext = {
  props: DbProperty[];
  propsByDb: Map<string, DbProperty[]>;
  pagesById: Map<string, Page>;
  propertyIndexByKey?: Map<string, DbPropertyIndex>;
  currentPageId?: string;
  timeZone?: string;
};

function importedIsoTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function projectPageImportTimestamps(page: Page): Page {
  const properties = page.properties ?? {};
  const createdAt = importedIsoTimestamp(properties[NOTION_CREATED_TIME_KEY]);
  const updatedAt = importedIsoTimestamp(properties[NOTION_LAST_EDITED_TIME_KEY]);
  if (!createdAt && !updatedAt) return page;
  return {
    ...page,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function projectBlockImportTimestamps(block: Block): Block {
  const content = block.content ?? {};
  const createdAt = importedIsoTimestamp(content.notionCreatedAt);
  const updatedAt = importedIsoTimestamp(content.notionUpdatedAt);
  if (!createdAt && !updatedAt) return block;
  return {
    ...block,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function byPageOrder(a: Page, b: Page) {
  return (a.parentId ?? '').localeCompare(b.parentId ?? '') || (a.position ?? 0) - (b.position ?? 0);
}

function recordValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numericMetadataValue(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function importedItemSortOrder(item: NotionImportItem, fallbackIndex: number) {
  const metadata = recordValue(item.metadata);
  const explicitOrder = numericMetadataValue(metadata, 'notionQueryOrder');
  if (explicitOrder !== undefined) return explicitOrder;
  const createdAt = importedIsoTimestamp(item.createdAt);
  if (!createdAt) return Number.MAX_SAFE_INTEGER + fallbackIndex;
  return new Date(createdAt).getTime() + fallbackIndex / 1000000;
}

async function importedDatabaseRowOrdering(
  db: DbRef,
  workspaceId: string,
  rows: Page[],
) {
  const rowIds = new Set(rows.map((row) => row.id));
  if (rowIds.size === 0) {
    return {
      orderByRowId: new Map<string, number>(),
      canonicalRowIdByNotionId: new Map<string, string>(),
    };
  }

  const rowIdsByJob = new Map<string, string[]>();
  for (const row of rows) {
    const properties = recordValue(row.properties);
    const jobId = typeof row.notionImportJobId === 'string' && row.notionImportJobId
      ? row.notionImportJobId
      : typeof properties?.notionImportJobId === 'string' && properties.notionImportJobId
        ? properties.notionImportJobId
        : undefined;
    if (!jobId) continue;
    const ids = rowIdsByJob.get(jobId) ?? [];
    ids.push(row.id);
    rowIdsByJob.set(jobId, ids);
  }
  const mappingReads = Array.from(rowIdsByJob, ([jobId, ids]) => (
    chunksOf(ids, TARGETED_IMPORT_ORDER_QUERY_LIMIT).map((chunk) => ({ jobId, chunk }))
  )).flat();
  const rawMappings = (await mapLimit(
    mappingReads,
    DATABASE_QUERY_CONTEXT_CHUNK_CONCURRENCY,
    async ({ jobId, chunk }) => {
      let query: TableQuery<NotionImportMapping> = db
        .table<NotionImportMapping>('notion_import_mappings')
        .where('jobId', '==', jobId);
      if (typeof query.where !== 'function') {
        throw Object.assign(new Error('Imported row ordering requires bounded mixed-key filters.'), { status: 500 });
      }
      query = query.where('localType', '==', 'page');
      if (typeof query.where === 'function') query = query.where('relationKind', '==', 'database_row');
      if (typeof query.where === 'function') query = query.where('localId', 'in', chunk);
      return await listAll(query, {
        maxItems: chunk.length,
        pageSize: chunk.length,
        label: 'Candidate Notion import row mappings',
      });
    },
  )).flat();
  const mappings = rawMappings
    .filter((mapping) =>
      mapping.workspaceId === workspaceId &&
      mapping.localType === 'page' &&
      mapping.relationKind === 'database_row' &&
      rowIds.has(mapping.localId) &&
      mapping.jobId &&
      mapping.notionId
    );
  if (mappings.length === 0) {
    return {
      orderByRowId: new Map<string, number>(),
      canonicalRowIdByNotionId: new Map<string, string>(),
    };
  }

  const mappingsByJob = new Map<string, NotionImportMapping[]>();
  for (const mapping of mappings) {
    const items = mappingsByJob.get(mapping.jobId) ?? [];
    items.push(mapping);
    mappingsByJob.set(mapping.jobId, items);
  }

  const orderByRowId = new Map<string, number>();
  const canonicalRowIdByNotionId = new Map<string, string>();
  for (const [jobId, jobMappings] of mappingsByJob) {
    const importJob = await getExisting(
      db.table<NotionImportJobGeneration>('notion_import_jobs'),
      jobId,
    );
    if (!importJob) continue;
    const activeItemGeneration = importJob.activeItemGeneration ?? null;
    const neededNotionIds = new Set(jobMappings.map((mapping) => mapping.notionId));
    const activeItemsQuery = () => {
      const byJob = db.table<NotionImportItem>('notion_import_items').where('jobId', '==', jobId);
      return activeItemGeneration !== null && typeof byJob.where === 'function'
        ? byJob.where('itemGeneration', '==', activeItemGeneration)
        : byJob;
    };
    const rawImportItems = (await mapLimit(
      chunksOf(Array.from(neededNotionIds), TARGETED_IMPORT_ORDER_QUERY_LIMIT),
      DATABASE_QUERY_CONTEXT_CHUNK_CONCURRENCY,
      async (chunk) => {
        let query = activeItemsQuery();
        if (typeof query.where !== 'function') {
          throw Object.assign(new Error('Imported row ordering requires bounded mixed-key filters.'), { status: 500 });
        }
        query = query.where('notionObject', '==', 'page');
        if (typeof query.where === 'function') query = query.where('notionId', 'in', chunk);
        return await listAll(query, {
          maxItems: chunk.length,
          pageSize: chunk.length,
          label: 'Candidate Notion import row-order items',
        });
      },
    )).flat();
    const importItems = rawImportItems
      .filter((item) => (
        item.jobId === jobId
        && (item.itemGeneration ?? null) === activeItemGeneration
        && item.notionObject === 'page'
        && neededNotionIds.has(item.notionId)
      ));
    const itemsByNotionId = new Map<string, { item: NotionImportItem; order: number }>();
    importItems
      .slice()
      .sort((a, b) => {
        const aCreated = importedIsoTimestamp(a.createdAt) ?? '';
        const bCreated = importedIsoTimestamp(b.createdAt) ?? '';
        return aCreated.localeCompare(bCreated) || a.notionId.localeCompare(b.notionId);
      })
      .forEach((item, index) => {
        const metadata = recordValue(item.metadata);
        const discoveredFrom = typeof metadata?.discoveredFrom === 'string' ? metadata.discoveredFrom : '';
        if (discoveredFrom !== 'snapshot_data_source_query' && discoveredFrom !== 'data_source_query') return;
        itemsByNotionId.set(item.notionId, { item, order: importedItemSortOrder(item, index) });
      });

    for (const mapping of jobMappings) {
      const imported = itemsByNotionId.get(mapping.notionId);
      if (!imported) continue;
      orderByRowId.set(mapping.localId, imported.order);
      const currentCanonical = canonicalRowIdByNotionId.get(mapping.notionId);
      if (!currentCanonical) {
        canonicalRowIdByNotionId.set(mapping.notionId, mapping.localId);
        continue;
      }
      const currentOrder = orderByRowId.get(currentCanonical) ?? Number.MAX_SAFE_INTEGER;
      const nextOrder = imported.order;
      if (nextOrder < currentOrder) canonicalRowIdByNotionId.set(mapping.notionId, mapping.localId);
    }
  }

  return { orderByRowId, canonicalRowIdByNotionId };
}

async function accessibleWorkspaceIds(db: DbRef, actorId: string, workspaceId?: string) {
  const ownedQuery = db.table<Workspace>('workspaces').where('ownerId', '==', actorId);
  const membershipQuery = db.table<WorkspaceMember>('workspace_members').where('userId', '==', actorId);
  const [owned, memberships] = await Promise.all([
    listAll(workspaceId ? narrowWhere(ownedQuery, 'id', workspaceId) : ownedQuery),
    listAll(workspaceId ? narrowWhere(membershipQuery, 'workspaceId', workspaceId) : membershipQuery),
  ]);

  const candidates = Array.from(
    new Set([
      ...owned.map((workspace) => workspace.id),
      ...memberships.map((membership) => membership.workspaceId),
    ].filter((candidate) => !workspaceId || candidate === workspaceId)),
  );
  const checked = await mapLimit(
    candidates,
    QUERY_FANOUT_LIMIT,
    async (workspaceId) => {
      try {
        await assertNotDeactivatedWorkspaceAccess(db, workspaceId, actorId);
        return workspaceId;
      } catch {
        // Deactivated organization members should disappear from workspace-level reads/searches.
        return undefined;
      }
    },
  );
  return checked.filter((workspaceId): workspaceId is string => !!workspaceId);
}

function sharedPageMaterializationLimitError() {
  return Object.assign(
    new Error(
      `Shared page subtree materialization limit exceeded (${DEFAULT_LIST_ALL_MAX_ITEMS} rows).`,
    ),
    { status: 413 },
  );
}

async function sharedPageSubtrees(
  pagesTable: TableRef<Page>,
  workspaceId: string,
  rootPageIds: string[],
) {
  const rootIds = Array.from(new Set(rootPageIds));
  if (rootIds.length > DEFAULT_LIST_ALL_MAX_ITEMS) {
    throw sharedPageMaterializationLimitError();
  }

  const pagesById = new Map<string, Page>();
  const loadedChildCountByParent = new Map<string, number>();
  const rememberPage = (page: Page) => {
    if (pagesById.has(page.id)) return false;
    pagesById.set(page.id, page);
    if (page.parentId) {
      loadedChildCountByParent.set(
        page.parentId,
        (loadedChildCountByParent.get(page.parentId) ?? 0) + 1,
      );
    }
    return true;
  };
  for (let offset = 0; offset < rootIds.length; offset += SHARED_PAGE_TREE_QUERY_CHUNK_SIZE) {
    const chunk = rootIds.slice(offset, offset + SHARED_PAGE_TREE_QUERY_CHUNK_SIZE);
    const chunkIds = new Set(chunk);
    const roots = await listAll(
      narrowWhere(pagesTable.where('id', 'in', chunk), 'workspaceId', workspaceId),
      {
        maxItems: chunk.length,
        pageSize: chunk.length,
        label: 'Shared page roots',
      },
    );
    for (const page of roots) {
      if (page.workspaceId !== workspaceId || !chunkIds.has(page.id)) continue;
      rememberPage(page);
    }
  }

  let frontier = Array.from(pagesById.keys());
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (let offset = 0; offset < frontier.length; offset += SHARED_PAGE_TREE_QUERY_CHUNK_SIZE) {
      const chunk = frontier.slice(offset, offset + SHARED_PAGE_TREE_QUERY_CHUNK_SIZE);
      const parentIds = new Set(chunk);
      const knownChildren = chunk.reduce(
        (count, parentId) => count + (loadedChildCountByParent.get(parentId) ?? 0),
        0,
      );
      const remaining = DEFAULT_LIST_ALL_MAX_ITEMS - pagesById.size;
      // One extra row proves overflow. Already-loaded direct roots that are
      // also descendants are expected duplicates and receive their exact
      // budget so overlapping grants do not lower the unique-page ceiling.
      const queryMaxItems = Math.min(
        DEFAULT_LIST_ALL_MAX_ITEMS,
        Math.max(1, remaining + knownChildren + 1),
      );
      const children = await listAll(
        narrowWhere(pagesTable.where('parentId', 'in', chunk), 'workspaceId', workspaceId),
        {
          maxItems: queryMaxItems,
          pageSize: Math.min(1_000, queryMaxItems),
          label: 'Shared page subtree',
        },
      );
      for (const page of children) {
        if (
          page.workspaceId !== workspaceId
          || !page.parentId
          || !parentIds.has(page.parentId)
        ) {
          continue;
        }
        if (pagesById.has(page.id)) continue;
        if (pagesById.size >= DEFAULT_LIST_ALL_MAX_ITEMS) {
          throw sharedPageMaterializationLimitError();
        }
        if (rememberPage(page)) nextFrontier.push(page.id);
      }
    }
    frontier = nextFrontier;
  }

  return Array.from(pagesById.values());
}

async function userPagePermissions(
  db: DbRef,
  actorId: string,
  actorEmail?: string | null,
  workspaceId?: string,
) {
  const readable = (await actorPagePermissions(db, actorId, workspaceId, actorEmail))
    .filter((permission) => !workspaceId || permission.workspaceId === workspaceId);
  const permittedWorkspaceIds = new Set<string>();
  const checked = await mapLimit(
    Array.from(new Set(readable.map((permission) => permission.workspaceId))),
    QUERY_FANOUT_LIMIT,
    async (permissionWorkspaceId) => {
      try {
        await assertNotDeactivatedWorkspaceAccess(db, permissionWorkspaceId, actorId);
        return permissionWorkspaceId;
      } catch {
        // A deactivated org member should not regain access through direct page permissions.
        return undefined;
      }
    },
  );
  for (const permissionWorkspaceId of checked) {
    if (permissionWorkspaceId) permittedWorkspaceIds.add(permissionWorkspaceId);
  }
  return readable.filter((permission): permission is PagePermission => (
    permittedWorkspaceIds.has(permission.workspaceId)
  ));
}

async function canSeePage(
  db: DbRef,
  page: Page,
  actorId: string,
  workspaceIds?: Set<string>,
  actorEmail?: string | null,
) {
  if (!workspaceIds) {
    const workspace = await getExisting(db.table<Workspace>('workspaces'), page.workspaceId);
    const isOwner = workspace?.ownerId === actorId;
    const hasMembership = isOwner
      ? false
      : await workspaceHasMembershipForActor(db, page.workspaceId, actorId);
    // Reuse the exact workspace row for the fresh organization gate. This
    // avoids both a same-key reread and every unrelated workspace candidate.
    await organizationMemberForNotDeactivatedWorkspace(
      db,
      page.workspaceId,
      actorId,
      workspace,
    );
    if (isOwner || hasMembership) return true;
    return sharedPageHasDirectAccess(db, page, actorId, actorEmail);
  }

  // Request-wide list/search callers already share one freshly deactivated
  // workspace set. Direct-share fallback remains target-scoped and fresh.
  if (workspaceIds.has(page.workspaceId)) return true;
  await assertNotDeactivatedWorkspaceAccess(db, page.workspaceId, actorId);
  return sharedPageHasDirectAccess(db, page, actorId, actorEmail);
}

async function pagesForActor(
  db: DbRef,
  actorId: string,
  options: { includeTrash?: boolean; workspaceId?: string; actorEmail?: string | null } = {},
) {
  const workspaceIds = new Set(await accessibleWorkspaceIds(db, actorId, options.workspaceId));
  const permissions = await userPagePermissions(
    db,
    actorId,
    options.actorEmail,
    options.workspaceId,
  );
  const targetWorkspaceIds = options.workspaceId
    ? new Set([options.workspaceId])
    : new Set([
        ...workspaceIds,
        ...permissions.map((permission) => permission.workspaceId),
      ]);
  const pagesById = new Map<string, Page>();
  const pagesTable = db.table<Page>('pages');
  const permissionPageIdsByWorkspace = new Map<string, string[]>();
  for (const permission of permissions) {
    const pageIds = permissionPageIdsByWorkspace.get(permission.workspaceId) ?? [];
    pageIds.push(permission.pageId);
    permissionPageIdsByWorkspace.set(permission.workspaceId, pageIds);
  }
  const workspacePageGroups = await mapLimit(
    Array.from(targetWorkspaceIds),
    QUERY_FANOUT_LIMIT,
    async (workspaceId) => ({
      workspaceId,
      pages: workspaceIds.has(workspaceId)
        ? await listAll(pagesTable.where('workspaceId', '==', workspaceId))
        : await sharedPageSubtrees(
            pagesTable,
            workspaceId,
            permissionPageIdsByWorkspace.get(workspaceId) ?? [],
          ),
    }),
  );
  for (const { workspaceId, pages: workspacePages } of workspacePageGroups) {
    for (const page of workspacePages) {
      if (page.workspaceId === workspaceId) pagesById.set(page.id, page);
    }
  }

  if (options.workspaceId && !workspaceIds.has(options.workspaceId) && pagesById.size === 0) {
    throw new Error('Workspace access required.');
  }

  return Array.from(pagesById.values())
    .filter((page) => (
      page.notionImportStaging !== true
      && (options.includeTrash || !page.inTrash)
    ))
    .map(projectPageImportTimestamps)
    .sort(byPageOrder);
}

async function getPageForActor(
  db: DbRef,
  pageId: string,
  actorId: string,
  options: { allowTrash?: boolean; actorEmail?: string | null } = {},
): Promise<Page> {
  // Server-side getOne THROWS on a missing row (plain transport Error, no 404
  // code) — getExisting is the tolerant convention (table-utils).
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (!page) throw new Error('Page was not found.');
  if (page.notionImportStaging === true) throw new Error('Page was not found.');
  if (!(await canSeePage(db, page, actorId, undefined, options.actorEmail))) throw new Error('Page access required.');
  if (!options.allowTrash && page.inTrash) throw new Error('Page is in trash.');
  return projectPageImportTimestamps(page);
}

function bySortPos(a: { position: number }, b: { position: number }) {
  return a.position - b.position;
}

function normalizeNotionScopeId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .replace(/^collection:\/\//i, '')
    .replace(/^data_source:\/\//i, '')
    .replace(/-/g, '')
    .trim()
    .toLowerCase();
  return clean || undefined;
}

function pageNotionDatabaseId(page: Page) {
  const value = page.properties?.notionDatabaseId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isNotionLinkedDatabaseSourceUnavailable(page: Page) {
  return page.properties?.notionLinkedDatabaseSourceUnavailable === true;
}

function pageNotionDataSourceId(page: Page) {
  const value = page.properties?.notionDataSourceId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mappingMetadataDataSourceId(mapping: NotionImportMapping) {
  const value = mapping.metadata?.dataSourceId;
  return normalizeNotionScopeId(value);
}

async function importedDatabaseContainerNotionId(db: DbRef, page: Page) {
  const stored = pageNotionDatabaseId(page);
  if (stored) return stored;
  if (page.kind !== 'database') return undefined;

  const pageDataSourceId = normalizeNotionScopeId(pageNotionDataSourceId(page));
  const mappings = await listAll(
    db.table<NotionImportMapping>('notion_import_mappings').where('localId', '==', page.id),
  );
  const candidates = mappings
    .filter((mapping) => {
      if (mapping.localType !== 'database') return false;
      if (mapping.relationKind !== 'database_container' && mapping.relationKind !== 'database_container_inferred_from_view_context') {
        return false;
      }
      if (pageDataSourceId && mappingMetadataDataSourceId(mapping) && mappingMetadataDataSourceId(mapping) !== pageDataSourceId) {
        return false;
      }
      return typeof mapping.notionId === 'string' && mapping.notionId.trim().length > 0;
    })
    .sort((a, b) => {
      const aRank = a.relationKind === 'database_container' ? 0 : 1;
      const bRank = b.relationKind === 'database_container' ? 0 : 1;
      return aRank - bRank || a.notionId.localeCompare(b.notionId);
    });
  return candidates[0]?.notionId;
}

function relationTargetLocalDatabaseId(prop: DbProperty) {
  const value = prop.config?.relationDatabaseId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function relationTargetNotionId(prop: DbProperty) {
  const value = prop.config?.relationTargetNotionId ?? prop.config?.unresolvedRelationTargetNotionId;
  return normalizeNotionScopeId(value);
}

function relationTargetsDatabase(prop: DbProperty, database: Page) {
  if (prop.type !== 'relation') return false;
  const localTargetId = relationTargetLocalDatabaseId(prop);
  if (localTargetId && localTargetId === database.id) return true;
  const targetNotionId = relationTargetNotionId(prop);
  const databaseNotionId = normalizeNotionScopeId(pageNotionDataSourceId(database) ?? pageNotionDatabaseId(database));
  return !!targetNotionId && !!databaseNotionId && targetNotionId === databaseNotionId;
}

function relationTargetsSameDatabase(a: DbProperty, b: DbProperty) {
  if (a.type !== 'relation' || b.type !== 'relation') return false;
  const aLocal = relationTargetLocalDatabaseId(a);
  const bLocal = relationTargetLocalDatabaseId(b);
  if (aLocal && bLocal && aLocal === bLocal) return true;
  const aNotion = relationTargetNotionId(a);
  const bNotion = relationTargetNotionId(b);
  return !!aNotion && !!bNotion && aNotion === bNotion;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function remapImportedRelationFilterValueForRead(
  value: unknown,
  localPageIds: Set<string>,
  localPageIdByNotionId: Map<string, string>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = remapImportedRelationFilterValueForRead(item, localPageIds, localPageIdByNotionId);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (typeof value !== 'string' || !value.trim()) return { value, changed: false };
  if (localPageIds.has(value)) return { value, changed: false };
  const localId = localPageIdByNotionId.get(normalizeNotionScopeId(value) ?? '');
  if (!localId) return { value, changed: false };
  return { value: localId, changed: localId !== value };
}

function importedFilterValueHasReadableNotionMapping(
  value: unknown,
  localPageIdByNotionId: Map<string, string>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => importedFilterValueHasReadableNotionMapping(item, localPageIdByNotionId));
  }
  const normalized = normalizeNotionScopeId(value);
  return !!normalized && localPageIdByNotionId.has(normalized);
}

function collectImportedRelationFilterValueStrings(value: unknown, out: Set<string>) {
  if (currentPageFilterValueForRead(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) collectImportedRelationFilterValueStrings(item, out);
    return;
  }
  if (typeof value === 'string' && value.trim()) out.add(value.trim());
}

function collectImportedRelationFilterTermValueStrings(
  term: unknown,
  relationPropsById: Map<string, DbProperty>,
  out: Set<string>,
) {
  const record = recordObject(term);
  if (!record) return;

  if (typeof record.conjunction === 'string') {
    for (const filter of Array.isArray(record.filters) ? record.filters : []) {
      collectImportedRelationFilterTermValueStrings(filter, relationPropsById, out);
    }
    for (const group of Array.isArray(record.groups) ? record.groups : []) {
      collectImportedRelationFilterTermValueStrings(group, relationPropsById, out);
    }
    return;
  }

  const propertyId = typeof record.propertyId === 'string' ? record.propertyId : '';
  if (!relationPropsById.has(propertyId) || !Object.prototype.hasOwnProperty.call(record, 'value')) {
    return;
  }
  collectImportedRelationFilterValueStrings(record.value, out);
}

function collectImportedViewRelationFilterValueStrings(
  views: DbView[],
  relationPropsById: Map<string, DbProperty>,
) {
  const values = new Set<string>();
  for (const view of views) {
    const config = recordObject(view.config);
    if (!config) continue;
    collectImportedRelationFilterTermValueStrings(config.filterGroup, relationPropsById, values);
    for (const filter of Array.isArray(config.filters) ? config.filters : []) {
      collectImportedRelationFilterTermValueStrings(filter, relationPropsById, values);
    }
    for (const filter of Array.isArray(config.quickFilters) ? config.quickFilters : []) {
      collectImportedRelationFilterTermValueStrings(filter, relationPropsById, values);
    }
  }
  return values;
}

function dedupeImportMappings(mappings: NotionImportMapping[]) {
  const byId = new Map<string, NotionImportMapping>();
  for (const mapping of mappings) byId.set(mapping.id, mapping);
  return Array.from(byId.values());
}

function relationFilterMappingLookup(mappings: NotionImportMapping[]) {
  const localPageIds = new Set<string>();
  const localPageIdByNotionId = new Map<string, string>();
  for (const mapping of mappings) {
    if (mapping.localType !== 'page' || !mapping.localId || !mapping.notionId) continue;
    localPageIds.add(mapping.localId);
    const normalized = normalizeNotionScopeId(mapping.notionId);
    if (normalized) localPageIdByNotionId.set(normalized, mapping.localId);
  }
  return { localPageIds, localPageIdByNotionId };
}

function relationFilterValuesResolvedByMappings(values: Set<string>, mappings: NotionImportMapping[]) {
  const { localPageIds, localPageIdByNotionId } = relationFilterMappingLookup(mappings);
  for (const value of values) {
    const normalized = normalizeNotionScopeId(value);
    if (!localPageIds.has(value) && !(normalized && localPageIdByNotionId.has(normalized))) {
      return false;
    }
  }
  return true;
}

async function importMappingsForRelationFilterValues(
  db: DbRef,
  workspaceId: string,
  values: Set<string>,
) {
  const mappingsTable = db.table<NotionImportMapping>('notion_import_mappings');
  if (values.size === 0) return [];
  if (values.size > TARGETED_IMPORT_ORDER_QUERY_LIMIT) {
    return await listAll(mappingsTable.where('workspaceId', '==', workspaceId));
  }

  const targeted = dedupeImportMappings(
    (await mapLimit(
      Array.from(values),
      QUERY_FANOUT_LIMIT,
      async (value) => {
        const normalized = normalizeNotionScopeId(value);
        const [exactNotionMatches, normalizedNotionMatches, localMatches] = await Promise.all([
          listAll(mappingsTable.where('notionId', '==', value)),
          normalized && normalized !== value
            ? listAll(mappingsTable.where('notionId', '==', normalized))
            : Promise.resolve([]),
          listAll(mappingsTable.where('localId', '==', value)),
        ]);
        return [...exactNotionMatches, ...normalizedNotionMatches, ...localMatches];
      },
    )).flat()
      .filter((mapping) => mapping.workspaceId === workspaceId),
  );

  if (relationFilterValuesResolvedByMappings(values, targeted)) return targeted;
  return await listAll(mappingsTable.where('workspaceId', '==', workspaceId));
}

function remapImportedRelationFilterTermForRead(
  term: unknown,
  relationPropsById: Map<string, DbProperty>,
  localPageIds: Set<string>,
  localPageIdByNotionId: Map<string, string>,
): { term: unknown; changed: boolean } {
  const record = recordObject(term);
  if (!record) return { term, changed: false };

  if (typeof record.conjunction === 'string') {
    let changed = false;
    const next: Record<string, unknown> = { ...record };
    if (Array.isArray(record.filters)) {
      const results = record.filters.map((filter) =>
        remapImportedRelationFilterTermForRead(filter, relationPropsById, localPageIds, localPageIdByNotionId)
      );
      if (results.some((result) => result.changed)) {
        next.filters = results.map((result) => result.term);
        changed = true;
      }
    }
    if (Array.isArray(record.groups)) {
      const results = record.groups.map((group) =>
        remapImportedRelationFilterTermForRead(group, relationPropsById, localPageIds, localPageIdByNotionId)
      );
      if (results.some((result) => result.changed)) {
        next.groups = results.map((result) => result.term);
        changed = true;
      }
    }
    return { term: changed ? next : term, changed };
  }

  const propertyId = typeof record.propertyId === 'string' ? record.propertyId : '';
  const prop = relationPropsById.get(propertyId);
  if (!prop || !Object.prototype.hasOwnProperty.call(record, 'value')) {
    return { term, changed: false };
  }
  if (prop.type === 'rollup' && !importedFilterValueHasReadableNotionMapping(record.value, localPageIdByNotionId)) {
    return { term, changed: false };
  }
  const result = remapImportedRelationFilterValueForRead(
    record.value,
    localPageIds,
    localPageIdByNotionId,
  );
  return {
    term: result.changed ? { ...record, value: result.value } : term,
    changed: result.changed,
  };
}

function remapImportedViewRelationFilterConfigForRead(
  config: unknown,
  relationPropsById: Map<string, DbProperty>,
  localPageIds: Set<string>,
  localPageIdByNotionId: Map<string, string>,
) {
  const record = recordObject(config);
  if (!record) return config;
  let changed = false;
  const next: Record<string, unknown> = { ...record };

  if (relationPropsById.size > 0 && record.filterGroup !== undefined) {
    const result = remapImportedRelationFilterTermForRead(
      record.filterGroup,
      relationPropsById,
      localPageIds,
      localPageIdByNotionId,
    );
    if (result.changed) {
      next.filterGroup = result.term;
      changed = true;
    }
  }

  if (relationPropsById.size > 0 && Array.isArray(record.filters)) {
    const results = record.filters.map((filter) =>
      remapImportedRelationFilterTermForRead(filter, relationPropsById, localPageIds, localPageIdByNotionId)
    );
    if (results.some((result) => result.changed)) {
      next.filters = results.map((result) => result.term);
      changed = true;
    }
  }

  if (relationPropsById.size > 0 && Array.isArray(record.quickFilters)) {
    const results = record.quickFilters.map((filter) =>
      remapImportedRelationFilterTermForRead(filter, relationPropsById, localPageIds, localPageIdByNotionId)
    );
    if (results.some((result) => result.changed)) {
      next.quickFilters = results.map((result) => result.term);
      changed = true;
    }
  }

  if (
    next.filterGroup !== undefined ||
    Array.isArray(next.filters) ||
    Array.isArray(next.quickFilters)
  ) {
    const mergedFilterGroup = existingViewFilterGroupForContext(next);
    if (mergedFilterGroup) {
      next.filterGroup = mergedFilterGroup;
      delete next.filters;
      delete next.filterConjunction;
      delete next.quickFilters;
      changed = true;
    }
  }

  return changed ? next : config;
}

async function remapImportedViewRelationFiltersForRead(
  db: DbRef,
  workspaceId: string,
  properties: DbProperty[],
  views: DbView[],
) {
  const relationPropsById = new Map(
    properties
      .filter((property) => property.type === 'relation' || property.type === 'rollup')
      .map((property) => [property.id, property]),
  );
  if (views.length === 0) return views;

  const filterValues = collectImportedViewRelationFilterValueStrings(
    views,
    relationPropsById,
  );
  const mappings = filterValues.size > 0
    ? await importMappingsForRelationFilterValues(db, workspaceId, filterValues)
    : [];
  const { localPageIds, localPageIdByNotionId } = relationFilterMappingLookup(mappings);

  return views.map((view) => {
    const config = remapImportedViewRelationFilterConfigForRead(
      view.config,
      relationPropsById,
      localPageIds,
      localPageIdByNotionId,
    );
    return config === view.config ? view : { ...view, config: config as Record<string, unknown> };
  });
}

function currentPageFilterValueForRead(value: unknown) {
  return isHanjiCurrentPageFilterValue(value);
}

function dateQueryKey(value: unknown) {
  if (value == null || value === '') return '';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const start = (value as { start?: unknown }).start;
    if (typeof start === 'string') return start.slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return raw.slice(0, 10);
}

function optionValueIds(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function optionName(prop: DbProperty, id: string) {
  return selectOptionName(prop, id) || id;
}

const VIEW_NAME_FILTER_EXCLUDED_LABELS = new Set([
  'all',
  'allitems',
  'allpages',
  'allprojects',
  'alltasks',
  'default',
  'defaultview',
  'table',
  '전체',
  '전체보기',
  '전체테이블',
]);

function normalizedViewFilterLabel(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value
      .trim()
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s()[\]{}.,:;'"`~!@#$%^&*+=|\\/?<>_\-·•]+/g, '')
    : '';
}

function optionViewNameAliases(name: string) {
  const aliases = new Set<string>();
  const full = normalizedViewFilterLabel(name);
  if (full) aliases.add(full);

  const parenthetical = name.trim().match(/^(.+?)\s*[\(（]\s*(.+?)\s*[\)）]\s*$/);
  if (parenthetical) {
    const outer = parenthetical[1].trim();
    const inner = parenthetical[2].trim();
    const outerLabel = normalizedViewFilterLabel(outer);
    const innerLabel = normalizedViewFilterLabel(inner);
    if (outerLabel && innerLabel) {
      aliases.add(`${innerLabel}${outerLabel}`);
      aliases.add(`${outerLabel}${innerLabel}`);
      const outerWithoutTaxPrefix = normalizedViewFilterLabel(
        outer
          .replace(/^세금\s*/u, '')
          .replace(/^tax\s+/iu, ''),
      );
      if (outerWithoutTaxPrefix) aliases.add(`${innerLabel}${outerWithoutTaxPrefix}`);
    }
  }

  return aliases;
}

function inferredViewNameSelectFilter(viewName: string, properties: DbProperty[]) {
  const viewLabel = normalizedViewFilterLabel(viewName);
  if (!viewLabel || VIEW_NAME_FILTER_EXCLUDED_LABELS.has(viewLabel)) return undefined;

  const matches: Array<{ property: DbProperty; optionId: string; optionName: string; exact: boolean }> = [];
  for (const property of properties) {
    if (!['select', 'status', 'multi_select'].includes(property.type)) continue;
    const options = Array.isArray(property.config?.options) ? property.config.options : [];
    for (const option of options) {
      const record = recordObject(option);
      const optionId = typeof record?.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
      const optionName = typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
      if (!optionId || !optionName) continue;
      const exact = normalizedViewFilterLabel(optionName) === viewLabel;
      if (exact || optionViewNameAliases(optionName).has(viewLabel)) {
        matches.push({ property, optionId, optionName, exact });
      }
    }
  }

  const exactMatches = matches.filter((match) => match.exact);
  const candidates = exactMatches.length ? exactMatches : matches;
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  return {
    filterGroup: {
      conjunction: 'and',
      filters: [
        {
          propertyId: candidate.property.id,
          operator: 'equals',
          value: candidate.optionId,
        },
      ],
      groups: [],
    },
    metadata: {
      inferredFrom: 'view_name_select_option',
      propertyId: candidate.property.id,
      propertyName: candidate.property.name,
      optionName: candidate.optionName,
    },
  };
}

function addInferredImportedViewNameFiltersForRead(properties: DbProperty[], views: DbView[]) {
  return views.map((view) => {
    const config = recordObject(view.config) ?? {};
    if (existingViewFilterGroupForContext(config)) return view;
    const inferredFilter = inferredViewNameSelectFilter(view.name, properties);
    if (!inferredFilter) return view;
    return {
      ...view,
      config: {
        ...config,
        filterGroup: inferredFilter.filterGroup,
        inferredFilter: inferredFilter.metadata,
      },
    };
  });
}

function databaseCellValue(row: Page, prop: DbProperty, ctx: DatabaseRowsQueryContext): unknown {
  if (prop.type === 'title') return row.title;
  if (prop.type === 'created_time') return row.createdAt;
  if (prop.type === 'last_edited_time') return row.updatedAt;
  if (prop.type === 'created_by') return row.createdBy;
  if (prop.type === 'last_edited_by') return row.lastEditedBy;
  if (prop.type === 'formula') {
    const value = computedWithImportedFallback(row, prop, evaluateFormula(row, prop, ctx.props, ctx.pagesById));
    return value;
  }
  if (prop.type === 'rollup') {
    const value = computedWithImportedFallback(row, prop, evaluateRollup(row, prop, ctx.propsByDb, ctx.pagesById));
    return value;
  }
  return row.properties?.[prop.id];
}

function queryValueText(value: unknown, prop?: DbProperty) {
  if (value == null) return '';
  if (prop?.type === 'files') {
    const files = Array.isArray(value) ? value : [value];
    return files
      .map((file) => {
        if (typeof file === 'string') return file;
        if (!file || typeof file !== 'object') return '';
        const item = file as { name?: unknown; fileName?: unknown; url?: unknown };
        return [item.name, item.fileName, item.url].map((part) => String(part ?? '')).join(' ');
      })
      .join(' ');
  }
  if (prop?.type === 'person' || prop?.type === 'created_by' || prop?.type === 'last_edited_by') {
    return personIds(value).join(' ');
  }
  if (Array.isArray(value)) return value.join(' ');
  return String(value);
}

function isDateQueryProperty(prop: DbProperty) {
  return prop.type === 'date' || prop.type === 'created_time' || prop.type === 'last_edited_time';
}

function databaseDisplayText(
  row: Page,
  prop: DbProperty,
  ctx: DatabaseRowsQueryContext,
): string {
  const indexed = indexedDisplayText(
    ctx.propertyIndexByKey?.get(databasePropertyIndexKey(row.id, prop.id)),
    prop.type,
  );
  if (indexed !== undefined) return indexed;

  const value = databaseCellValue(row, prop, ctx);
  if (prop.type === 'select' || prop.type === 'multi_select' || prop.type === 'status') {
    return optionValueIds(value).map((id) => optionName(prop, id)).join(' ');
  }
  if (prop.type === 'checkbox') return value ? 'checked true yes' : 'unchecked false no';
  if (prop.type === 'unique_id') {
    if (value == null || value === '') return '';
    const prefix = typeof prop.config?.idPrefix === 'string' ? prop.config.idPrefix.trim() : '';
    return prefix ? `${prefix}-${value}` : String(value);
  }
  if (isDateQueryProperty(prop)) return dateQueryKey(value);
  if (prop.type === 'relation') {
    return optionValueIds(value)
      .map((id) => ctx.pagesById.get(id)?.title ?? '')
      .filter(Boolean)
      .join(' ');
  }
  if (prop.type === 'formula' || prop.type === 'rollup') {
    return formatFormulaValue(value as FormulaValue);
  }
  return queryValueText(value, prop);
}

function isFilterGroupTerm(term: unknown): term is FilterGroupTerm {
  return !!recordObject(term) && typeof recordObject(term)?.conjunction === 'string';
}

// Backend adapters over the shared filter/sort engine
// (shared/database/query-core.ts): injects backend value-reading (inline
// formula/rollup eval), display text (with the indexed fast-path), and
// person/rollup id resolution. The operator predicates and sort keys live in
// the shared core so server-paged reads and the web app agree.
function queryCoreAdapters(ctx: DatabaseRowsQueryContext): QueryAdapters {
  return {
    cellValue: (row, prop) => databaseCellValue(row as unknown as Page, prop as unknown as DbProperty, ctx),
    displayText: (row, prop) => databaseDisplayText(row as unknown as Page, prop as unknown as DbProperty, ctx),
    asText: (value, prop) => queryValueText(value, prop as unknown as DbProperty | undefined),
    personIds: (value) => personIds(value),
    rollupTargetIds: (row, prop) => rollupRelationTargetIds(row as unknown as Page, prop as unknown as DbProperty, ctx),
    currentPageId: ctx.currentPageId,
    timeZone: ctx.timeZone,
  };
}

function databaseFilterMatches(
  row: Page,
  prop: DbProperty,
  filter: ViewFilterTerm,
  ctx: DatabaseRowsQueryContext,
) {
  return coreFilterMatches(
    row as unknown as QueryPage,
    prop as unknown as QueryProperty,
    filter as unknown as QueryFilter,
    queryCoreAdapters(ctx),
  );
}

function filterTermMatchesForDatabase(
  row: Page,
  term: unknown,
  ctx: DatabaseRowsQueryContext,
  propsById: Map<string, DbProperty>,
): boolean {
  const record = recordObject(term);
  if (!record) return true;
  if (isFilterGroupTerm(record)) {
    return databaseFilterGroupMatches(row, record, ctx, propsById);
  }
  const propertyId = typeof record.propertyId === 'string' ? record.propertyId : '';
  const prop = propsById.get(propertyId);
  return prop ? databaseFilterMatches(row, prop, record, ctx) : true;
}

function databaseFilterGroupMatches(
  row: Page,
  group: FilterGroupTerm,
  ctx: DatabaseRowsQueryContext,
  propsById: Map<string, DbProperty>,
) {
  const terms: boolean[] = [];
  for (const filter of Array.isArray(group.filters) ? group.filters : []) {
    const record = recordObject(filter);
    const propertyId = typeof record?.propertyId === 'string' ? record.propertyId : '';
    const prop = propsById.get(propertyId);
    if (prop && record) terms.push(databaseFilterMatches(row, prop, record, ctx));
  }
  for (const child of Array.isArray(group.groups) ? group.groups : []) {
    terms.push(filterTermMatchesForDatabase(row, child, ctx, propsById));
  }
  if (terms.length === 0) return true;
  return group.conjunction === 'or' ? terms.some(Boolean) : terms.every(Boolean);
}

function collectFilterPropertyIds(term: unknown, out: Set<string>) {
  const record = recordObject(term);
  if (!record) return;
  if (isFilterGroupTerm(record)) {
    for (const filter of Array.isArray(record.filters) ? record.filters : []) {
      collectFilterPropertyIds(filter, out);
    }
    for (const group of Array.isArray(record.groups) ? record.groups : []) {
      collectFilterPropertyIds(group, out);
    }
    return;
  }

  if (typeof record.propertyId === 'string') out.add(record.propertyId);
}

function collectViewFilterPropertyIds(view: DbView | undefined, out: Set<string>) {
  if (!view) return;
  collectFilterPropertyIds(existingViewFilterGroupForContext(recordObject(view.config) ?? {}), out);
}

function collectViewQueryPropertyIds(view: DbView | undefined, out: Set<string>) {
  collectViewFilterPropertyIds(view, out);
  const sorts = view?.config?.sorts;
  for (const sort of Array.isArray(sorts) ? sorts : []) {
    const propertyId = recordObject(sort)?.propertyId;
    if (typeof propertyId === 'string') out.add(propertyId);
  }
}

function propertyNeedsDependencyContext(prop: DbProperty | undefined) {
  return prop?.type === 'relation' || prop?.type === 'rollup';
}

function viewNeedsRelationFilterRemap(view: DbView | undefined, propsById: Map<string, DbProperty>) {
  const propertyIds = new Set<string>();
  collectViewFilterPropertyIds(view, propertyIds);
  for (const propertyId of propertyIds) {
    const type = propsById.get(propertyId)?.type;
    if (type === 'relation' || type === 'rollup') return true;
  }
  return false;
}

function viewQueryDependencyProperties(view: DbView | undefined, props: DbProperty[], searchInput?: string) {
  const search = (searchInput ?? (typeof view?.config?.search === 'string' ? view.config.search : '')).trim();
  if (search) return props.filter((property) => propertyNeedsDependencyContext(property));
  const propsById = new Map(props.map((prop) => [prop.id, prop]));
  const propertyIds = new Set<string>();
  collectViewQueryPropertyIds(view, propertyIds);
  return Array.from(propertyIds)
    .map((propertyId) => propsById.get(propertyId))
    .filter((property): property is DbProperty => propertyNeedsDependencyContext(property));
}

function viewQueryNeedsContext(view: DbView | undefined, searchInput?: string) {
  const search = (searchInput ?? (typeof view?.config?.search === 'string' ? view.config.search : '')).trim();
  if (search) return true;
  const propertyIds = new Set<string>();
  collectViewQueryPropertyIds(view, propertyIds);
  return propertyIds.size > 0;
}

function databaseViewHasSorts(view: DbView | undefined) {
  return Array.isArray(view?.config?.sorts) && view.config.sorts.some((sort) => {
    const record = recordObject(sort);
    return typeof record?.propertyId === 'string' && record.propertyId.length > 0;
  });
}

function databaseSortKey(row: Page, prop: DbProperty, ctx: DatabaseRowsQueryContext): number | string {
  const indexed = indexedSortValue(
    ctx.propertyIndexByKey?.get(databasePropertyIndexKey(row.id, prop.id)),
    prop.type,
  );
  if (indexed !== undefined) return indexed;
  return coreSortKey(row as unknown as QueryPage, prop as unknown as QueryProperty, queryCoreAdapters(ctx));
}

function compareDatabaseSortKeys(a: number | string, b: number | string) {
  return coreCompareKeys(a, b);
}

function applyDatabaseViewQuery(
  rows: Page[],
  props: DbProperty[],
  view: DbView | undefined,
  ctx: DatabaseRowsQueryContext,
  searchInput?: string,
) {
  const propsById = new Map(props.map((prop) => [prop.id, prop]));
  let out = rows.slice();
  const search = foldNfcText(
    (searchInput ?? (typeof view?.config?.search === 'string' ? view.config.search : '')).trim(),
  );
  if (search) {
    out = out.filter((row) =>
      props.some((prop) => foldNfcText(databaseDisplayText(row, prop, ctx)).includes(search))
    );
  }

  if (view) {
    const filterGroup = existingViewFilterGroupForContext(recordObject(view.config) ?? {});
    if (filterGroup) {
      out = out.filter((row) => filterTermMatchesForDatabase(row, filterGroup, ctx, propsById));
    }
  }

  const sorts = Array.isArray(view?.config?.sorts) ? view?.config?.sorts : [];
  for (const sort of [...sorts].reverse()) {
    const record = recordObject(sort) as ViewSortTerm | undefined;
    const propertyId = typeof record?.propertyId === 'string' ? record.propertyId : '';
    const prop = propsById.get(propertyId);
    if (!prop) continue;
    out.sort((a, b) => {
      const compared = compareDatabaseSortKeys(databaseSortKey(a, prop, ctx), databaseSortKey(b, prop, ctx));
      return record?.direction === 'desc' ? -compared : compared;
    });
  }

  return out;
}

function notionParentDatabaseId(view: DbView) {
  const notion = recordObject(view.config?.notion);
  if (!notion) return undefined;
  const parent = recordObject(notion.parent);
  if (parent) {
    const id = parent.database_id ?? parent.databaseId ?? parent.id;
    if (typeof id === 'string') return id;
  }
  const fallback =
    notion.parent_database_id ??
    notion.parentDatabaseId ??
    notion.database_id ??
    notion.databaseId;
  return typeof fallback === 'string' ? fallback : undefined;
}

function uniqueStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)),
  );
}

function mergeViewsById(views: DbView[], additionalViews: DbView[]) {
  const byId = new Map<string, DbView>();
  for (const view of views) byId.set(view.id, view);
  for (const view of additionalViews) byId.set(view.id, view);
  return Array.from(byId.values()).sort(bySortPos);
}

function filterViewsByNotionDatabaseContainer(
  views: DbView[],
  notionDatabaseId: string | undefined,
  options: { includeViewIds?: string[] } = {},
) {
  const target = normalizeNotionScopeId(notionDatabaseId);
  const includeViewIds = new Set(options.includeViewIds ?? []);
  if (!target) return views;
  const scoped = views.filter((view) => normalizeNotionScopeId(notionParentDatabaseId(view)) === target);
  const requested = includeViewIds.size > 0
    ? views.filter((view) => includeViewIds.has(view.id))
    : [];
  return scoped.length > 0 ? mergeViewsById(scoped, requested) : views;
}

async function resolveImportedLinkedDatabaseSource(
  db: DbRef,
  requestedDatabase: Page,
  actorId: string,
  actorEmail?: string | null,
) {
  if (!isNotionLinkedDatabaseSourceUnavailable(requestedDatabase)) return null;
  const targetNotionDatabaseId = normalizeNotionScopeId(pageNotionDatabaseId(requestedDatabase));
  if (!targetNotionDatabaseId) return null;

  const views = await listAll(db.table<DbView>('db_views'));
  const scopedViews = views
    .filter((view) => normalizeNotionScopeId(notionParentDatabaseId(view)) === targetNotionDatabaseId)
    .sort(bySortPos);
  const sourceDatabaseIds = Array.from(
    new Set(scopedViews.map((view) => view.databaseId).filter((id) => id !== requestedDatabase.id)),
  );

  for (const sourceDatabaseId of sourceDatabaseIds) {
    try {
      const sourceDatabase = await getPageForActor(db, sourceDatabaseId, actorId, { actorEmail });
      if (sourceDatabase.kind !== 'database') continue;
      const viewsForSource = scopedViews.filter((view) => view.databaseId === sourceDatabase.id);
      if (viewsForSource.length === 0) continue;
      return {
        requestedDatabase,
        sourceDatabase,
        targetNotionDatabaseId,
        views: viewsForSource,
      };
    } catch {
      // The source can belong to a private area the actor cannot access.
    }
  }

  return null;
}

function relationContainsFilter(propertyId: string, value: unknown): ViewFilterTerm {
  return {
    propertyId,
    operator: 'contains',
    value,
  };
}

function relationFilterGroup(filters: ViewFilterTerm[]): FilterGroupTerm | undefined {
  if (filters.length === 0) return undefined;
  return {
    conjunction: filters.length > 1 ? 'or' : 'and',
    filters,
    groups: [],
  };
}

function uniqueIds(values: unknown[]) {
  return Array.from(new Set(values.flatMap((value) => ids(value)))).filter(Boolean);
}

function knownFilterTerm(term: unknown) {
  const record = recordObject(term);
  if (!record) return undefined;
  if (isFilterGroupTerm(record)) return record;
  return typeof record.propertyId === 'string' && typeof record.operator === 'string'
    ? record
    : undefined;
}

function filterGroupFromTerms(terms: unknown[]) {
  const filters: Record<string, unknown>[] = [];
  const groups: Record<string, unknown>[] = [];
  for (const term of terms) {
    const known = knownFilterTerm(term);
    if (!known) continue;
    if (isFilterGroupTerm(known)) groups.push(known);
    else filters.push(known);
  }
  if (filters.length === 0 && groups.length === 0) return undefined;
  return {
    conjunction: 'and',
    filters,
    groups,
  };
}

function existingViewFilterGroupForContext(config: Record<string, unknown>) {
  const groups: Record<string, unknown>[] = [];
  const filterGroup = knownFilterTerm(config.filterGroup);
  const hasStoredFilterGroup = !!filterGroup;
  if (filterGroup) {
    groups.push(isFilterGroupTerm(filterGroup)
      ? filterGroup
      : { conjunction: 'and', filters: [filterGroup], groups: [] });
  }

  const filters = !hasStoredFilterGroup && Array.isArray(config.filters)
    ? config.filters
        .map((filter) => knownFilterTerm(filter))
        .filter((filter): filter is Record<string, unknown> => !!filter && !isFilterGroupTerm(filter))
    : [];
  if (filters.length) {
    groups.push({
      conjunction: config.filterConjunction === 'or' ? 'or' : 'and',
      filters,
      groups: [],
    });
  }

  if (Array.isArray(config.quickFilters)) {
    const quickGroup = filterGroupFromTerms(config.quickFilters);
    if (quickGroup) groups.push(quickGroup);
  }

  if (groups.length === 0) return undefined;
  if (groups.length === 1) return groups[0];
  return {
    conjunction: 'and',
    filters: [],
    groups,
  };
}

function addContextFilterToViewConfig(config: unknown, contextFilter: FilterGroupTerm) {
  const record = recordObject(config) ?? {};
  if (hasHanjiImportedRowContextFilterMarker(record)) return config;
  const existing = existingViewFilterGroupForContext(record);
  const filterGroup = existing
    ? {
        conjunction: 'and',
        filters: [],
        groups: [contextFilter, existing],
      }
    : contextFilter;

  return {
    ...record,
    filterGroup,
    filters: undefined,
    filterConjunction: undefined,
    [HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER]: true,
  };
}

async function importedLinkedDatabaseRowContextFilterForRead(
  db: DbRef,
  requestedDatabase: Page,
  sourceDatabase: Page,
  sourceProperties: DbProperty[],
) {
  if (requestedDatabase.parentType !== 'page' || !requestedDatabase.parentId) return undefined;
  if (sourceDatabase.workspaceId !== requestedDatabase.workspaceId) return undefined;

  const pagesTable = db.table<Page>('pages');
  // getExisting, not raw getOne: an imported linked database whose parent row
  // was deleted must fall back to "no context filter", not 404 the whole
  // database read (server-side getOne throws on missing rows).
  const parentRow = await getExisting(pagesTable, requestedDatabase.parentId);
  if (!parentRow || parentRow.inTrash || parentRow.parentType !== 'database' || !parentRow.parentId) {
    return undefined;
  }

  const parentDatabase = await getExisting(pagesTable, parentRow.parentId);
  if (
    !parentDatabase ||
    parentDatabase.inTrash ||
    parentDatabase.kind !== 'database' ||
    parentDatabase.workspaceId !== requestedDatabase.workspaceId
  ) {
    return undefined;
  }

  const directFilters = sourceProperties
    .filter((prop) => relationTargetsDatabase(prop, parentDatabase))
    .map((prop) => relationContainsFilter(prop.id, parentRow.id));
  const directGroup = relationFilterGroup(directFilters);
  if (directGroup) return directGroup;

  const parentProperties = await listAll(
    db.table<DbProperty>('db_properties').where('databaseId', '==', parentDatabase.id),
  );
  const parentRelationProps = parentProperties.filter((prop) => prop.type === 'relation');
  const indirectFilters = sourceProperties
    .filter((sourceProp) => sourceProp.type === 'relation')
    .map((sourceProp) => {
      const matchingParentProps = parentRelationProps.filter((parentProp) =>
        relationTargetsSameDatabase(sourceProp, parentProp)
      );
      const targets = uniqueIds(matchingParentProps.map((prop) => parentRow.properties?.[prop.id]));
      return targets.length ? relationContainsFilter(sourceProp.id, targets) : undefined;
    })
    .filter((filter): filter is ViewFilterTerm => !!filter);

  return relationFilterGroup(indirectFilters);
}

async function addImportedLinkedDatabaseContextFiltersForRead(
  db: DbRef,
  linkedSource: NonNullable<Awaited<ReturnType<typeof resolveImportedLinkedDatabaseSource>>>,
  sourceProperties: DbProperty[],
  views: DbView[],
) {
  if (views.length === 0) return views;
  const contextFilter = await importedLinkedDatabaseRowContextFilterForRead(
    db,
    linkedSource.requestedDatabase,
    linkedSource.sourceDatabase,
    sourceProperties,
  );
  if (!contextFilter) return views;
  return views.map((view) => ({
    ...view,
    config: addContextFilterToViewConfig(view.config, contextFilter) as Record<string, unknown>,
  }));
}

function byCreated(a: { createdAt?: string }, b: { createdAt?: string }) {
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

function richTextText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((span) => {
      if (!span || typeof span !== 'object') return '';
      const text = (span as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function compactNumber(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function formatNumberValue(value: unknown, format = 'number') {
  if (value == null) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (format === 'number') return compactNumber(n);
  // Function workers must not inherit a host-machine locale: API/MCP callers
  // without an explicit product locale use the stable English wire default.
  if (format === 'comma') return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(n);
  if (format === 'percent') {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(n / 100);
  }
  if (format === 'won') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'KRW',
      maximumFractionDigits: 0,
    }).format(n);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: format === 'euro' ? 'EUR' : 'USD',
    maximumFractionDigits: 2,
  }).format(n);
}

function numberFormatForProperty(prop: DbProperty) {
  const normalize = (format: unknown) => {
    if (format === 'number_with_commas') return 'comma';
    return (
      format === 'number' ||
      format === 'comma' ||
      format === 'percent' ||
      format === 'dollar' ||
      format === 'won' ||
      format === 'euro'
    )
      ? format
      : undefined;
  };
  const config = prop.config ?? {};
  const direct = typeof config.numberFormat === 'string' ? config.numberFormat : undefined;
  const notion = config.notion && typeof config.notion === 'object'
    ? config.notion as { number?: { format?: unknown } }
    : undefined;
  const imported = typeof notion?.number?.format === 'string' ? notion.number.format : undefined;
  return normalize(direct) ?? normalize(imported) ?? 'number';
}

function ids(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)];
}

function personIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => personIds(item)).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value !== 'object') return [];
  const id = (value as { id?: unknown; userId?: unknown }).id ?? (value as { userId?: unknown }).userId;
  return typeof id === 'string' && id.trim() ? [id.trim()] : [];
}

function titleOf(page?: Page) {
  return page?.title || 'Untitled';
}

function formatFormulaValue(value: FormulaValue) {
  return formatFormulaCoreValue(value);
}

function computedValuePresent(value: FormulaValue) {
  return value !== null && value !== '';
}

function importedComputedValue(row: Page, prop: DbProperty): ComputedValue | undefined {
  if (prop.type !== 'formula' && prop.type !== 'rollup') return undefined;
  const value = row.properties?.[prop.id];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function computedWithImportedFallback(row: Page, prop: DbProperty, value: FormulaValue): ComputedValue {
  if (computedValuePresent(value)) return value;
  const imported = importedComputedValue(row, prop);
  return imported === undefined ? value : imported;
}

function selectOptionName(prop: DbProperty, value: unknown) {
  const options = Array.isArray(prop.config?.options) ? prop.config.options : [];
  const match = options.find((option) => {
    if (!option || typeof option !== 'object') return false;
    const item = option as { id?: unknown; name?: unknown };
    return item.id === value || item.name === value;
  }) as { name?: unknown } | undefined;
  return typeof match?.name === 'string' ? match.name : String(value ?? '');
}

function rawPropertyValue(row: Page, prop: DbProperty): unknown {
  if (prop.type === 'title') return row.title;
  if (prop.type === 'created_time') return row.createdAt;
  if (prop.type === 'last_edited_time') return row.updatedAt;
  if (prop.type === 'created_by') return row.createdBy;
  if (prop.type === 'last_edited_by') return row.lastEditedBy;
  return row.properties?.[prop.id];
}

function evaluateFormula(
  row: Page,
  prop: DbProperty,
  props: DbProperty[],
  pagesById: ReadonlyMap<string, Page>,
): FormulaValue {
  const rawFormula = prop.config?.formula;
  const expression = typeof rawFormula === 'string' ? rawFormula.trim() : '';
  if (!expression) return '';
  return evaluateFormulaExpression(expression, (name) => {
    const target = props.find((item) => item.name === name || item.id === name);
    if (!target || target.id === prop.id) return '';
    return formulaPropertyValue(row, target, pagesById);
  });
}

function propsForRelationTarget(relationProp: DbProperty, propsByDb: Map<string, DbProperty[]>) {
  const dbId =
    typeof relationProp.config?.relationDatabaseId === 'string'
      ? relationProp.config.relationDatabaseId
      : relationProp.databaseId;
  return propsByDb.get(dbId) ?? [];
}

function followRelation(page: Page, relationProp: DbProperty, pagesById: Map<string, Page>) {
  return ids(rawPropertyValue(page, relationProp))
    .map((id) => pagesById.get(id))
    .filter((related): related is Page => !!related && !related.inTrash);
}

function resolveRollupHops(
  startPages: Page[],
  targetProp: DbProperty | undefined,
  prop: DbProperty,
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
) {
  let pages = startPages;
  let current = targetProp;
  const seenDbs = new Set<string>();

  for (let hop = 0; hop < 3; hop += 1) {
    if (!current) break;
    if (current.type !== 'relation' && current.type !== 'rollup') break;

    const ownerProps = propsByDb.get(current.databaseId) ?? [];
    let hopRelation: DbProperty | undefined;
    if (current.type === 'relation') {
      hopRelation = current;
    } else {
      const viaId = hop === 0 && typeof prop.config?.rollupVia === 'string' ? prop.config.rollupVia : undefined;
      hopRelation =
        (viaId ? ownerProps.find((item) => item.id === viaId) : undefined) ??
        ownerProps.find((item) => item.id === current?.config?.rollupRelationPropertyId);
    }
    if (!hopRelation || hopRelation.type !== 'relation') break;

    const hopDbId =
      typeof hopRelation.config?.relationDatabaseId === 'string'
        ? hopRelation.config.relationDatabaseId
        : hopRelation.databaseId;
    if (seenDbs.has(hopDbId)) break;
    seenDbs.add(hopDbId);

    pages = pages.flatMap((page) => followRelation(page, hopRelation as DbProperty, pagesById));
    const hopProps = propsForRelationTarget(hopRelation, propsByDb);
    current =
      current.type === 'rollup'
        ? hopProps.find((item) => item.id === current?.config?.rollupTargetPropertyId)
        : undefined;
  }

  return { pages, targetProp: current };
}

function displayPropertyValue(
  row: Page,
  prop: DbProperty,
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
  depth = 0,
): string {
  if (depth > 3) return '';
  const value = rawPropertyValue(row, prop);
  if (prop.type === 'title') return titleOf(row);
  if (prop.type === 'formula') {
    const props = propsByDb.get(prop.databaseId) ?? [];
    return formatFormulaValue(computedWithImportedFallback(row, prop, evaluateFormula(row, prop, props, pagesById)));
  }
  if (prop.type === 'rollup') {
    return formatFormulaValue(computedWithImportedFallback(row, prop, evaluateRollup(row, prop, propsByDb, pagesById, depth + 1)));
  }
  if (value == null || value === '') return '';
  if (prop.type === 'select' || prop.type === 'status') return selectOptionName(prop, value);
  if (prop.type === 'multi_select') return ids(value).map((id) => selectOptionName(prop, id)).join(', ');
  if (prop.type === 'checkbox') return value ? 'Checked' : 'Unchecked';
  if (prop.type === 'number') return formatNumberValue(value, numberFormatForProperty(prop));
  if (prop.type === 'unique_id') {
    const prefix = typeof prop.config?.idPrefix === 'string' ? prop.config.idPrefix.trim() : '';
    return prefix ? `${prefix}-${value}` : String(value);
  }
  if (prop.type === 'date' || prop.type === 'created_time' || prop.type === 'last_edited_time') {
    return String(value).slice(0, 10);
  }
  if (prop.type === 'relation') {
    return ids(value).map((id) => titleOf(pagesById.get(id))).join(', ');
  }
  if (prop.type === 'person' || prop.type === 'created_by' || prop.type === 'last_edited_by') {
    return personIds(value).map((id) => (id ? 'You' : '')).filter(Boolean).join(', ');
  }
  if (prop.type === 'files') {
    const files = Array.isArray(value) ? value : [value];
    return files
      .map((file) => {
        if (typeof file === 'string') return file;
        if (!file || typeof file !== 'object') return '';
        const item = file as { name?: unknown; fileName?: unknown; url?: unknown };
        return String(item.name ?? item.fileName ?? item.url ?? '');
      })
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

function evaluateRollup(
  row: Page,
  prop: DbProperty,
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
  depth = 0,
): ComputedValue {
  if (depth > 3) return '';
  const sourceProps = propsByDb.get(prop.databaseId) ?? [];
  const relationProp = sourceProps.find((item) => item.id === prop.config?.rollupRelationPropertyId);
  if (!relationProp || relationProp.type !== 'relation') return '';

  const targetProps = propsForRelationTarget(relationProp, propsByDb);
  // Thin backend adapter over the shared rollup engine
  // (shared/database/rollup-core.ts): injects backend value-reading/leaf-display
  // (persons render as "You" server-side) and page/prop lookups. The reducers,
  // relation-hop resolution, and UTC date normalization live in the shared core.
  const ctx: RollupContext = {
    pagesById: (id) => pagesById.get(id) as RollupPage | undefined,
    propsByDb: (dbId) => (propsByDb.get(dbId) ?? []) as unknown as RollupProperty[],
    rawValue: (page, coreProp) =>
      rawPropertyValue(page as unknown as Page, coreProp as unknown as DbProperty),
    displayValue: (page, coreProp) =>
      displayPropertyValue(page as unknown as Page, coreProp as unknown as DbProperty, propsByDb, pagesById, depth + 1),
  };
  return evaluateRollupCore(
    row as unknown as RollupPage,
    prop as unknown as RollupProperty,
    sourceProps as unknown as RollupProperty[],
    targetProps as unknown as RollupProperty[],
    ctx,
  );
}

function rollupRelationTargetIds(
  row: Page,
  prop: DbProperty,
  ctx: DatabaseRowsQueryContext,
) {
  const sourceProps = ctx.propsByDb.get(prop.databaseId) ?? [];
  const relationProp = sourceProps.find((item) => item.id === prop.config?.rollupRelationPropertyId);
  if (!relationProp || relationProp.type !== 'relation') return [];

  const relatedPages = followRelation(row, relationProp, ctx.pagesById);
  const targetProps = propsForRelationTarget(relationProp, ctx.propsByDb);
  const firstHopTarget = targetProps.find((item) => item.id === prop.config?.rollupTargetPropertyId);

  if (!firstHopTarget) return relatedPages.map((page) => page.id);
  if (firstHopTarget.type === 'relation' || firstHopTarget.type === 'rollup') {
    const { pages, targetProp } = resolveRollupHops(
      relatedPages,
      firstHopTarget,
      prop,
      ctx.propsByDb,
      ctx.pagesById,
    );
    if (!targetProp) return pages.map((page) => page.id);
    if (targetProp.type === 'relation') {
      return pages.flatMap((page) => ids(rawPropertyValue(page, targetProp)));
    }
  }
  if (firstHopTarget.type === 'relation') {
    return relatedPages.flatMap((page) => ids(rawPropertyValue(page, firstHopTarget)));
  }
  return [];
}

function computedPropertyValues(
  rows: Page[],
  props: DbProperty[],
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
) {
  const computedProps = props.filter((prop) => prop.type === 'formula' || prop.type === 'rollup');
  if (computedProps.length === 0) return undefined;
  const computed: ComputedMap = {};
  for (const row of rows) {
    for (const prop of computedProps) {
      const evaluated =
        prop.type === 'rollup'
          ? evaluateRollup(row, prop, propsByDb, pagesById)
          : evaluateFormula(row, prop, props, pagesById);
      const value = computedWithImportedFallback(row, prop, evaluated);
      computed[row.id] = computed[row.id] ?? {};
      computed[row.id][prop.id] = { value, formatted: formatFormulaValue(value) };
    }
  }
  return computed;
}

type SearchWorkspaceAuthority = {
  hasWorkspaceAccess: boolean;
  actorId: string;
  normalizedEmail: string;
  organizationId?: string;
  activeOrganizationMemberId?: string;
  policyVersion: number;
  authorityRevision: string;
};

async function searchPagesByIds(
  db: DbRef,
  pageIds: Iterable<string>,
  workspaceId: string,
) {
  const ids = Array.from(new Set(pageIds));
  const pages: Page[] = [];
  const table = db.table<Page>('pages');
  for (let offset = 0; offset < ids.length; offset += SEARCH_PAGE_ID_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + SEARCH_PAGE_ID_CHUNK_SIZE);
    const chunkIds = new Set(chunk);
    const rows = await listAll(
      narrowWhere(table.where('id', 'in', chunk), 'workspaceId', workspaceId),
      {
        maxItems: chunk.length,
        pageSize: chunk.length,
        label: 'Search candidate pages',
      },
    );
    for (const page of rows) {
      if (page.workspaceId === workspaceId && chunkIds.has(page.id)) {
        pages.push(stripIndexedSearchMetadata(page));
      }
    }
  }
  return pages;
}

async function currentSearchPolicyVersion(db: DbRef, organizationId?: string) {
  if (!organizationId) return 0;
  const rows = await listAll(
    db.table<OrganizationPolicyVersion>('organization_policy_versions')
      .where('organizationId', '==', organizationId),
    { maxItems: 2, pageSize: 2, label: 'Organization search policy version' },
  );
  if (rows.length > 1) {
    throw Object.assign(new Error('Organization policy version is not unique.'), { status: 500 });
  }
  const version = rows[0]?.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw Object.assign(new Error('Organization policy version is malformed.'), { status: 500 });
  }
  return version;
}

async function currentSearchOrganizationMember(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
) {
  if (!workspace.organizationId) return null;
  let query: TableQuery<OrganizationMember> = db
    .table<OrganizationMember>('organization_members')
    .where('organizationId', '==', workspace.organizationId);
  if (typeof query.where !== 'function') {
    throw Object.assign(
      new Error('Organization search authority requires chained database filters.'),
      { status: 500 },
    );
  }
  query = query.where('userId', '==', actorId);
  const rows = await listAll(query, {
    maxItems: 2,
    pageSize: 2,
    label: 'Organization search membership',
  });
  if (rows.length > 1) {
    throw Object.assign(new Error('Organization membership is not unique.'), { status: 500 });
  }
  const member = rows[0] ?? null;
  if (member && (member.status ?? 'active') !== 'active') {
    throw Object.assign(new Error('Organization active access required.'), { status: 403 });
  }
  return member;
}

async function searchWorkspaceAuthority(
  db: DbRef,
  actorId: string,
  workspaceId: string,
  actorEmail?: string | null,
): Promise<SearchWorkspaceAuthority> {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace) {
    throw Object.assign(new Error('Workspace access required.'), { status: 403 });
  }
  const policyVersionBefore = await currentSearchPolicyVersion(
    db,
    workspace.organizationId ?? undefined,
  );
  const organizationMember = await currentSearchOrganizationMember(db, workspace, actorId);
  const membershipRows = await listAll(
    narrowWhere(
      db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
      'userId',
      actorId,
    ),
    { maxItems: 2, pageSize: 2, label: 'Search workspace membership' },
  );
  if (membershipRows.length > 1) {
    throw Object.assign(new Error('Workspace membership is not unique.'), { status: 500 });
  }
  const workspaceMember = membershipRows[0] ?? null;
  const hasWorkspaceAccess = workspace.ownerId === actorId || workspaceMember !== null;
  const policyVersion = await currentSearchPolicyVersion(
    db,
    workspace.organizationId ?? undefined,
  );
  if (policyVersion !== policyVersionBefore) {
    throw Object.assign(
      new Error('Organization search authority changed while it was being read. Retry the search.'),
      { status: 409 },
    );
  }
  const authorityRevision = await searchSnapshotRevision({
    v: 1,
    workspace: {
      id: workspace.id,
      ownerId: workspace.ownerId ?? null,
      organizationId: workspace.organizationId ?? null,
      updatedAt: workspace.updatedAt ?? null,
    },
    workspaceMember: workspaceMember ? {
      id: workspaceMember.id,
      role: workspaceMember.role,
      updatedAt: workspaceMember.updatedAt ?? null,
    } : null,
    organizationMember: organizationMember ? {
      id: organizationMember.id,
      status: organizationMember.status ?? 'active',
      updatedAt: (organizationMember as { updatedAt?: string }).updatedAt ?? null,
    } : null,
    policyVersion,
  });
  return {
    hasWorkspaceAccess,
    actorId,
    normalizedEmail: normalizeAccessEmail(actorEmail),
    policyVersion,
    authorityRevision,
    ...(workspace.organizationId ? { organizationId: workspace.organizationId } : {}),
    ...(organizationMember ? { activeOrganizationMemberId: organizationMember.id } : {}),
  };
}

async function assertSearchAuthorityUnchanged(
  db: DbRef,
  actorId: string,
  workspaceId: string,
  expected: SearchWorkspaceAuthority,
  actorEmail?: string | null,
) {
  const current = await searchWorkspaceAuthority(db, actorId, workspaceId, actorEmail);
  if (current.authorityRevision !== expected.authorityRevision) {
    throw Object.assign(
      new Error('Search authority changed while results were being read. Retry the search.'),
      { status: 409 },
    );
  }
}

async function searchVisibleWindowRevision(
  fingerprint: string,
  authority: SearchWorkspaceAuthority,
  kind: 'pages' | 'blocks',
  rows: unknown[],
  windowStart: { after?: SearchSourceAfter; skipPageId?: string } = {},
) {
  return searchSnapshotRevision({
    v: 1,
    fingerprint,
    authority: authority.authorityRevision,
    kind,
    rows,
    windowStart: {
      after: windowStart.after ?? null,
      skipPageId: windowStart.skipPageId ?? null,
    },
  });
}

function eligibleSearchPages(
  pages: Page[],
  workspaceId: string,
  options: { includeTrash?: boolean } = {},
) {
  return pages.filter((page) => (
    page.workspaceId === workspaceId
    && page.notionImportStaging !== true
    && (options.includeTrash || !page.inTrash)
  ));
}

function searchRelatedRelation(
  localField: string,
  workspaceId: string,
  authority: SearchWorkspaceAuthority,
  options: {
    includeTrash?: boolean;
    requiredAncestorIds?: string[];
  } = {},
): SearchRelatedRelation {
  const whereAll: SearchRelatedRelation['whereAll'] = [
    ['workspaceId', '==', workspaceId],
    ['notionImportStaging', 'is-not-true'],
  ];
  if (!options.includeTrash) whereAll.push(['inTrash', 'is-not-true']);
  const requiredAncestorIds = options.requiredAncestorIds ?? [];
  if (authority.hasWorkspaceAccess && requiredAncestorIds.length === 0) {
    return { localField, table: 'pages', whereAll };
  }
  const ancestry: NonNullable<SearchRelatedRelation['ancestry']> = {
    parentField: 'parentId',
    parentTypeField: 'parentType',
    stopParentType: 'workspace',
    maxDepth: SEARCH_AUTHORITY_ANCESTOR_MAX_DEPTH,
    whereAll: [['workspaceId', '==', workspaceId]],
    ...(requiredAncestorIds.length ? { requiredAncestorIds } : {}),
  };
  if (authority.hasWorkspaceAccess) {
    return { localField, table: 'pages', whereAll, ancestry };
  }
  const principalAny: NonNullable<
    NonNullable<SearchRelatedRelation['ancestry']>['grantSource']
  >['principalAny'] = [
    {
      whereAll: [
        ['principalType', 'in', ['user', 'integration']],
        ['principalId', '==', authority.actorId],
      ],
    },
  ];
  if (authority.normalizedEmail) {
    principalAny.push({
      whereAll: [
        ['principalType', '==', 'email'],
        ['principalId', '==', authority.normalizedEmail],
      ],
    });
  }
  if (
    authority.organizationId
    && authority.activeOrganizationMemberId
  ) {
    principalAny.push({
      whereAll: [['principalType', '==', 'group']],
      groupMembership: {
        table: 'search_group_memberships',
        grantPrincipalField: 'principalId',
        membershipGroupField: 'groupId',
        whereAll: [
          ['workspaceId', '==', workspaceId],
          ['organizationId', '==', authority.organizationId],
          ['userId', '==', authority.actorId],
          ['organizationMemberId', '==', authority.activeOrganizationMemberId],
          ['policyVersion', '==', authority.policyVersion],
        ],
      },
    });
  }
  ancestry.grantSource = {
    table: 'page_permissions',
    ancestorField: 'pageId',
    whereAll: [
      ['workspaceId', '==', workspaceId],
      ['role', 'in', ['view', 'comment', 'edit', 'full_access']],
    ],
    principalAny,
  };
  return { localField, table: 'pages', whereAll, ancestry };
}

function requiredSearchWhere<T>(
  query: TableQuery<T>,
  field: string,
  op: string,
  value: unknown,
) {
  if (typeof query.where !== 'function') {
    throw Object.assign(new Error('Search authority requires chained database filters.'), { status: 500 });
  }
  return query.where(field, op, value);
}

async function boundedSearchGroupMemberships(
  db: DbRef,
  authority: SearchWorkspaceAuthority,
  after?: string,
) {
  if (!authority.organizationId || !authority.activeOrganizationMemberId) {
    return { rows: [] as OrganizationGroupMember[], hasMore: false, after: undefined };
  }
  let query: TableQuery<OrganizationGroupMember> = db
    .table<OrganizationGroupMember>('organization_group_members')
    .where('organizationId', '==', authority.organizationId);
  query = requiredSearchWhere(
    query,
    'organizationMemberId',
    '==',
    authority.activeOrganizationMemberId,
  );
  query = requiredSearchWhere(query, 'userId', '==', authority.actorId);
  if (typeof query.orderBy !== 'function' || typeof query.after !== 'function' || typeof query.includeTotal !== 'function') {
    throw Object.assign(new Error('Search group projection requires bounded id-keyset queries.'), { status: 500 });
  }
  const ordered = query.orderBy('id', 'asc');
  if (typeof ordered.includeTotal !== 'function' || typeof ordered.after !== 'function') {
    throw Object.assign(new Error('Search group projection requires bounded id-keyset queries.'), { status: 500 });
  }
  query = ordered.includeTotal(false);
  if (after) {
    if (typeof query.after !== 'function') {
      throw Object.assign(new Error('Search group projection requires bounded id-keyset queries.'), { status: 500 });
    }
    query = query.after(after);
  }
  const response = await query.limit(SEARCH_GROUP_SYNC_WINDOW_SIZE + 1).getList();
  const rawRows = response.items ?? [];
  const rows = rawRows.slice(0, SEARCH_GROUP_SYNC_WINDOW_SIZE);
  let priorId = after;
  for (const row of rows) {
    if (!row.id || (priorId !== undefined && row.id.localeCompare(priorId) <= 0)) {
      throw Object.assign(new Error('Search group projection returned a non-advancing cursor.'), { status: 500 });
    }
    if (
      row.organizationId !== authority.organizationId
      || row.organizationMemberId !== authority.activeOrganizationMemberId
      || row.userId !== authority.actorId
      || typeof row.groupId !== 'string'
      || !row.groupId
    ) {
      throw Object.assign(new Error('Search group projection returned an invalid membership.'), { status: 500 });
    }
    priorId = row.id;
  }
  return {
    rows,
    hasMore: rawRows.length > SEARCH_GROUP_SYNC_WINDOW_SIZE || response.hasMore === true,
    after: rows.at(-1)?.id,
  };
}

async function projectionRowsByIds<T extends { id: string }>(
  db: DbRef,
  tableName: string,
  ids: string[],
) {
  if (ids.length === 0) return new Map<string, T>();
  const rows = await listAll(
    db.table<T>(tableName).where('id', 'in', ids),
    { maxItems: ids.length, pageSize: ids.length, label: `Search ${tableName} projection rows` },
  );
  const allowed = new Set(ids);
  if (rows.some((row) => !allowed.has(row.id))) {
    throw Object.assign(new Error(`Search ${tableName} projection returned a foreign row.`), { status: 500 });
  }
  return new Map(rows.map((row) => [row.id, row]));
}

async function searchMembershipProjectionId(
  workspaceId: string,
  userId: string,
  groupId: string,
) {
  return `search-membership-${await searchSnapshotRevision({ workspaceId, userId, groupId })}`;
}

async function searchMembershipSnapshotId(workspaceId: string, userId: string) {
  return `search-membership-snapshot-${await searchSnapshotRevision({ workspaceId, userId })}`;
}

function assertProjectionIdentity(
  row: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
) {
  for (const [field, value] of Object.entries(expected)) {
    if (row[field] !== value) {
      throw Object.assign(new Error(`${label} projection identity is inconsistent.`), { status: 409 });
    }
  }
}

async function writeSearchGroupProjectionPage(
  db: DbRef,
  workspaceId: string,
  authority: SearchWorkspaceAuthority,
  rows: OrganizationGroupMember[],
  complete: boolean,
  expectedAfter?: string,
  nextAfter?: string,
) {
  if (!authority.organizationId || !authority.activeOrganizationMemberId) return false;
  const membershipRows = await Promise.all(rows.map(async (row) => ({
    id: await searchMembershipProjectionId(workspaceId, authority.actorId, row.groupId),
    source: row,
  })));
  const authorityIds = Array.from(new Set(rows.map((row) => row.groupId)));
  const membershipIds = membershipRows.map((row) => row.id);
  const snapshotId = await searchMembershipSnapshotId(workspaceId, authority.actorId);

  for (let attempt = 0; attempt < SEARCH_GROUP_SYNC_WRITE_RETRIES; attempt += 1) {
    const [existingAuthorities, existingMemberships, existingSnapshot] = await Promise.all([
      projectionRowsByIds<SearchGroupAuthority>(db, 'search_group_authorities', authorityIds),
      projectionRowsByIds<SearchGroupMembership>(db, 'search_group_memberships', membershipIds),
      getExisting(db.table<SearchGroupMembershipSnapshot>('search_group_membership_snapshots'), snapshotId),
    ]);
    if (existingSnapshot) {
      assertProjectionIdentity(
        existingSnapshot as unknown as Record<string, unknown>,
        { workspaceId, organizationId: authority.organizationId, userId: authority.actorId },
        'Search group membership snapshot',
      );
      if (existingSnapshot.policyVersion > authority.policyVersion) {
        throw Object.assign(
          new Error('Search group membership snapshot is ahead of current authority.'),
          { status: 409 },
        );
      }
      const sameGeneration = (
        existingSnapshot.policyVersion === authority.policyVersion
        && existingSnapshot.organizationMemberId === authority.activeOrganizationMemberId
      );
      if (sameGeneration) {
        const existingComplete = existingSnapshot.syncComplete === true
          || (
            existingSnapshot.syncComplete === undefined
            && !!existingSnapshot.completedAt
            && !existingSnapshot.syncAfter
          );
        if (existingComplete) return false;
        if ((existingSnapshot.syncAfter ?? undefined) !== expectedAfter) return false;
      }
    }
    const operations: TransactOperation[] = [];
    for (const groupId of authorityIds) {
      const existing = existingAuthorities.get(groupId);
      if (existing) {
        assertProjectionIdentity(existing as unknown as Record<string, unknown>, {
          workspaceId,
          organizationId: authority.organizationId,
        }, 'Search group authority');
        continue;
      }
      operations.push(
        { table: 'search_group_authorities', op: 'expect', id: groupId, exists: false },
        {
          table: 'search_group_authorities',
          op: 'insert',
          data: { id: groupId, workspaceId, organizationId: authority.organizationId },
        },
      );
    }
    for (const projected of membershipRows) {
      const stableIdentity = {
        workspaceId,
        organizationId: authority.organizationId,
        userId: authority.actorId,
        groupId: projected.source.groupId,
      };
      const data = {
        ...stableIdentity,
        organizationMemberId: authority.activeOrganizationMemberId,
        sourceMembershipId: projected.source.id,
        policyVersion: authority.policyVersion,
      };
      const existing = existingMemberships.get(projected.id);
      if (!existing) {
        operations.push(
          { table: 'search_group_memberships', op: 'expect', id: projected.id, exists: false },
          { table: 'search_group_memberships', op: 'insert', data: { id: projected.id, ...data } },
        );
        continue;
      }
      assertProjectionIdentity(
        existing as unknown as Record<string, unknown>,
        stableIdentity,
        'Search group membership',
      );
      if (existing.policyVersion > authority.policyVersion) {
        throw Object.assign(
          new Error('Search group membership projection is ahead of current authority.'),
          { status: 409 },
        );
      }
      if (existing.policyVersion === authority.policyVersion) {
        if (
          existing.organizationMemberId === authority.activeOrganizationMemberId
          && existing.sourceMembershipId !== projected.source.id
        ) {
          throw Object.assign(
            new Error('Search group membership source changed within one policy version.'),
            { status: 409 },
          );
        }
        if (existing.organizationMemberId === authority.activeOrganizationMemberId) continue;
      }
      operations.push(
        {
          table: 'search_group_memberships',
          op: 'expect',
          id: projected.id,
          where: [
            ['policyVersion', '==', existing.policyVersion],
            ['organizationMemberId', '==', existing.organizationMemberId],
          ],
          exists: true,
        },
        { table: 'search_group_memberships', op: 'update', id: projected.id, data },
      );
    }
    const stableIdentity = {
      workspaceId,
      organizationId: authority.organizationId,
      userId: authority.actorId,
    };
    const snapshotData = {
      ...stableIdentity,
      organizationMemberId: authority.activeOrganizationMemberId,
      policyVersion: authority.policyVersion,
      syncAfter: nextAfter ?? null,
      syncComplete: complete,
      completedAt: complete ? nowIso() : null,
    };
    if (!existingSnapshot) {
      operations.push(
        { table: 'search_group_membership_snapshots', op: 'expect', id: snapshotId, exists: false },
        { table: 'search_group_membership_snapshots', op: 'insert', data: { id: snapshotId, ...snapshotData } },
      );
    } else {
      operations.push(
        {
          table: 'search_group_membership_snapshots',
          op: 'expect',
          id: snapshotId,
          where: [
            ['policyVersion', '==', existingSnapshot.policyVersion],
            ['organizationMemberId', '==', existingSnapshot.organizationMemberId],
            ['syncAfter', '==', existingSnapshot.syncAfter ?? null],
            ['syncComplete', '==', existingSnapshot.syncComplete ?? null],
          ],
          exists: true,
        },
        { table: 'search_group_membership_snapshots', op: 'update', id: snapshotId, data: snapshotData },
      );
    }
    if (operations.length === 0) return true;
    try {
      await db.transact(operations);
      return true;
    } catch (error) {
      if (!isTransactionConflictError(error) || attempt + 1 >= SEARCH_GROUP_SYNC_WRITE_RETRIES) {
        throw error;
      }
    }
  }
  return false;
}

async function ensureSearchGroupProjection(
  db: DbRef,
  workspaceId: string,
  authority: SearchWorkspaceAuthority,
): Promise<void> {
  if (authority.hasWorkspaceAccess) return;
  if (!authority.organizationId || !authority.activeOrganizationMemberId) return;
  const snapshotId = await searchMembershipSnapshotId(workspaceId, authority.actorId);
  let snapshot = await getExisting(
    db.table<SearchGroupMembershipSnapshot>('search_group_membership_snapshots'),
    snapshotId,
  );
  if (snapshot) {
    assertProjectionIdentity(snapshot as unknown as Record<string, unknown>, {
      workspaceId,
      organizationId: authority.organizationId,
      userId: authority.actorId,
    }, 'Search group membership snapshot');
    if (snapshot.policyVersion > authority.policyVersion) {
      throw Object.assign(
        new Error('Search group membership snapshot is ahead of current authority.'),
        { status: 409 },
      );
    }
    if (
      snapshot.policyVersion === authority.policyVersion
      && snapshot.organizationMemberId === authority.activeOrganizationMemberId
      && (
        snapshot.syncComplete === true
        || (
          snapshot.syncComplete === undefined
          && !!snapshot.completedAt
          && !snapshot.syncAfter
        )
      )
    ) {
      return;
    }
  }
  let resumeAfter = (
    snapshot?.policyVersion === authority.policyVersion
    && snapshot.organizationMemberId === authority.activeOrganizationMemberId
  )
    ? snapshot.syncAfter ?? undefined
    : undefined;
  while (true) {
    const page = await boundedSearchGroupMemberships(db, authority, resumeAfter);
    if (!page.hasMore) {
      const verifiedVersion = await currentSearchPolicyVersion(db, authority.organizationId);
      if (verifiedVersion !== authority.policyVersion) {
        throw Object.assign(
          new Error('Organization search policy changed during group projection. Restart the search.'),
          { status: 409 },
        );
      }
    }
    const applied = await writeSearchGroupProjectionPage(
      db,
      workspaceId,
      authority,
      page.rows,
      !page.hasMore,
      resumeAfter,
      page.hasMore ? page.after : undefined,
    );
    if (applied) {
      if (!page.hasMore) return;
      if (!page.after) {
        throw Object.assign(new Error('Search group projection did not advance.'), { status: 500 });
      }
      resumeAfter = page.after;
      continue;
    }

    // A same-actor concurrent search may have committed this page first.
    // Join its durable progress instead of replaying the chunk or making the
    // caller submit another search request to finish the bounded drain.
    snapshot = await getExisting(
      db.table<SearchGroupMembershipSnapshot>('search_group_membership_snapshots'),
      snapshotId,
    );
    if (!snapshot) {
      throw Object.assign(new Error('Search group projection made no durable progress.'), { status: 409 });
    }
    assertProjectionIdentity(snapshot as unknown as Record<string, unknown>, {
      workspaceId,
      organizationId: authority.organizationId,
      userId: authority.actorId,
    }, 'Search group membership snapshot');
    if (snapshot.policyVersion > authority.policyVersion) {
      throw Object.assign(
        new Error('Search group membership snapshot is ahead of current authority.'),
        { status: 409 },
      );
    }
    const sameGeneration = (
      snapshot.policyVersion === authority.policyVersion
      && snapshot.organizationMemberId === authority.activeOrganizationMemberId
    );
    if (!sameGeneration) {
      throw Object.assign(new Error('Search authority changed during group projection.'), { status: 409 });
    }
    if (
      snapshot.syncComplete === true
      || (
        snapshot.syncComplete === undefined
        && !!snapshot.completedAt
        && !snapshot.syncAfter
      )
    ) {
      return;
    }
    const concurrentAfter = snapshot.syncAfter ?? undefined;
    if (!concurrentAfter || concurrentAfter === resumeAfter) {
      throw Object.assign(new Error('Search group projection made no durable progress.'), { status: 409 });
    }
    resumeAfter = concurrentAfter;
  }
}

function searchOccurrenceCount(text: string, query: string) {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - query.length) {
    const match = text.indexOf(query, offset);
    if (match < 0) break;
    count += 1;
    offset = match + Math.max(1, query.length);
  }
  return count;
}

function searchRecency(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareSearchRelevance(
  left: { text: string; updatedAt?: string; position?: number; pageId?: string; id: string },
  right: { text: string; updatedAt?: string; position?: number; pageId?: string; id: string },
  query: string,
) {
  const leftExact = left.text === query ? 0 : 1;
  const rightExact = right.text === query ? 0 : 1;
  if (leftExact !== rightExact) return leftExact - rightExact;
  const leftPrefix = left.text.startsWith(query) ? 0 : 1;
  const rightPrefix = right.text.startsWith(query) ? 0 : 1;
  if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
  const occurrenceOrder = searchOccurrenceCount(right.text, query) - searchOccurrenceCount(left.text, query);
  if (occurrenceOrder !== 0) return occurrenceOrder;
  const firstOrder = left.text.indexOf(query) - right.text.indexOf(query);
  if (firstOrder !== 0) return firstOrder;
  const recencyOrder = searchRecency(right.updatedAt) - searchRecency(left.updatedAt);
  if (recencyOrder !== 0) return recencyOrder;
  const positionOrder = (left.position ?? 0) - (right.position ?? 0);
  if (positionOrder !== 0) return positionOrder;
  const pageOrder = compareSearchRevisionKey(left.pageId ?? '', right.pageId ?? '');
  return pageOrder || compareSearchRevisionKey(left.id, right.id);
}

function searchContinuationCursor<T extends { id: string }>(
  window: IndexedSearchWindow<T>,
  fingerprint: string,
  options: {
    acceptedCount: number;
    nextOffset: number;
    revision: string;
    startAfter?: SearchSourceAfter;
    startSkipPageId?: string;
    nextSkipPageId?: string;
  },
): SearchSourceCursor | undefined {
  if (options.nextOffset < options.acceptedCount) {
    return {
      v: 1,
      fingerprint,
      window: {
        revision: options.revision,
        offset: options.nextOffset,
        ...(options.startAfter ? { after: options.startAfter } : {}),
        ...(options.startSkipPageId ? { skipPageId: options.startSkipPageId } : {}),
      },
    };
  }
  if (!window.hasMore) return undefined;
  if (!window.boundary) {
    throw Object.assign(new Error('Indexed search continuation boundary is missing.'), { status: 500 });
  }
  return {
    v: 1,
    fingerprint,
    window: {
      offset: 0,
      after: window.boundary,
      ...(options.nextSkipPageId ? { skipPageId: options.nextSkipPageId } : {}),
    },
  };
}

function blockSearchText(block: Block): string {
  const content = block.content as { rich?: unknown; caption?: unknown; expression?: unknown; fileName?: unknown } | undefined;
  const plainText = block.plainText?.trim() ?? '';
  const richText = richTextText(content?.rich).trim();
  return [
    plainText,
    richText && foldNfcText(richText) !== foldNfcText(plainText) ? richText : '',
    richTextText(content?.caption),
    typeof content?.expression === 'string' ? content.expression : '',
    typeof content?.fileName === 'string' ? content.fileName : '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function pageMetadataSearchTexts(page: Page): string[] {
  const texts = [String(page.title ?? '').trim()];
  const seenTexts = new Set(texts);
  const seenObjects = new Set<object>();
  let totalLength = texts[0]!.length;
  let values = 0;

  const visit = (value: unknown, depth: number) => {
    if (
      depth > SEARCH_METADATA_MAX_DEPTH
      || values >= SEARCH_METADATA_MAX_VALUES
      || totalLength >= SEARCH_METADATA_MAX_TEXT_LENGTH
      || value == null
    ) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      if (!text || seenTexts.has(text)) return;
      const remaining = SEARCH_METADATA_MAX_TEXT_LENGTH - totalLength;
      const bounded = text.slice(0, remaining);
      if (!bounded) return;
      seenTexts.add(bounded);
      texts.push(bounded);
      totalLength += bounded.length;
      values += 1;
      return;
    }
    if (typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      visit(item, depth + 1);
    }
  };
  visit(page.properties, 0);
  return texts;
}

function foldedPageMetadataSearchTexts(page: Page) {
  return pageMetadataSearchTexts(page).map(foldNfcText);
}

type EvaluatedPageSearchRow = {
  page: Page;
  text: string;
  sourceIndex: number;
};

async function loadPageSearchWindow(
  db: DbRef,
  workspaceId: string,
  authority: SearchWorkspaceAuthority,
  query: string,
  includeTrash: boolean,
  requiredAncestorIds: string[],
  order: SearchSourceOrder,
  after?: SearchSourceAfter,
) {
  return collectIndexedSearchWindow(
    db.table<Page>('pages'),
    query,
    searchRelatedRelation('id', workspaceId, authority, {
      includeTrash,
      requiredAncestorIds,
    }),
    order,
    after,
    'Indexed page search',
  );
}

function evaluatePageSearchWindow(
  window: IndexedSearchWindow<Page>,
  workspaceId: string,
  query: string,
  includeTrash: boolean,
) {
  const accepted: EvaluatedPageSearchRow[] = [];
  for (let index = 0; index < window.rows.length; index += 1) {
    const page = projectPageImportTimestamps(window.rows[index]!);
    if (eligibleSearchPages([page], workspaceId, { includeTrash }).length === 0) continue;
    const texts = foldedPageMetadataSearchTexts(page);
    if (!texts.some((text) => text.includes(query))) continue;
    const text = texts.join(' ');
    accepted.push({ page, text, sourceIndex: index });
  }
  return { accepted };
}

type LoadedBlockSearchWindow = {
  window: IndexedSearchWindow<Block>;
  pagesById: Map<string, Page>;
};

type EvaluatedBlockSearchRow = {
  block: Block;
  page: Page;
  text: string;
  foldedText: string;
  sourceIndex: number;
};

type EvaluatedBacklinkRow = {
  block: Block;
  page: Page;
  kind: 'mention' | 'link';
};

async function loadBlockSearchWindow(
  db: DbRef,
  workspaceId: string,
  authority: SearchWorkspaceAuthority,
  query: string,
  requiredAncestorIds: string[],
  order: SearchSourceOrder,
  after?: SearchSourceAfter,
): Promise<LoadedBlockSearchWindow> {
  const window = await collectIndexedSearchWindow(
    db.table<Block>('blocks'),
    query,
    searchRelatedRelation('pageId', workspaceId, authority, { requiredAncestorIds }),
    order,
    after,
    'Indexed block search',
  );
  const candidatePages = (await searchPagesByIds(
    db,
    window.rows.map((block) => block.pageId),
    workspaceId,
  )).map(projectPageImportTimestamps);
  const acceptedPages = eligibleSearchPages(candidatePages, workspaceId);
  return {
    window,
    pagesById: new Map(acceptedPages.map((page) => [page.id, page])),
  };
}

function evaluateBlockSearchWindow(
  loaded: LoadedBlockSearchWindow,
  query: string,
  options: {
    dedupePages: boolean;
    excludeMetadataMatches: boolean;
    skipPageId?: string;
  },
) {
  const accepted: EvaluatedBlockSearchRow[] = [];
  let skipPageId = options.dedupePages ? options.skipPageId : undefined;
  for (let index = 0; index < loaded.window.rows.length; index += 1) {
    const block = projectBlockImportTimestamps(loaded.window.rows[index]!);
    if (options.dedupePages && skipPageId && block.pageId !== skipPageId) skipPageId = undefined;
    const page = loaded.pagesById.get(block.pageId);
    if (!page) continue;
    const text = blockSearchText(block);
    const foldedText = foldNfcText(text);
    if (!foldedText.includes(query)) continue;
    if (
      options.excludeMetadataMatches
      && foldedPageMetadataSearchTexts(page).some((text) => text.includes(query))
    ) continue;
    if (options.dedupePages && skipPageId === block.pageId) continue;
    accepted.push({ block, page, text, foldedText, sourceIndex: index });
    if (options.dedupePages) skipPageId = block.pageId;
  }
  return { accepted, skipPageId };
}

function evaluateBacklinksWindow(
  loaded: LoadedBlockSearchWindow,
  targetPageId: string,
) {
  const accepted: EvaluatedBacklinkRow[] = [];
  for (const rawBlock of loaded.window.rows) {
    const block = projectBlockImportTimestamps(rawBlock);
    if (block.pageId === targetPageId) continue;
    const page = loaded.pagesById.get(block.pageId);
    if (!page) continue;
    const kind = blockReferenceKind(block, targetPageId, normalizeLegacyHanjiUri);
    if (!kind) continue;
    accepted.push({ block, page, kind });
  }
  return { accepted };
}

function blockVisibleRevisionRows(
  accepted: EvaluatedBlockSearchRow[],
  includePages: boolean,
  excludeMetadataMatches: boolean,
) {
  return accepted.map(({ block, page }) => ({
    block,
    ...(includePages
      ? { page }
      : excludeMetadataMatches
        ? { pageDecision: { id: page.id, metadata: foldedPageMetadataSearchTexts(page) } }
        : {}),
  }));
}

async function pageBlocks(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  await getPageForActor(db, pageId, actorId, { actorEmail });
  const blocks = await listAll(db.table<Block>('blocks').where('pageId', '==', pageId));
  return { pageId, blocks: blocks.map(projectBlockImportTimestamps).sort(bySortPos) };
}

async function assertDependencyDateShiftReadable(
  db: DbRef,
  databaseId: string,
  featureOwner: Page,
) {
  const dependencyBinding = recordObject(recordObject(featureOwner.databaseFeatures)?.dependencies);
  if (dependencyBinding?.enabled !== true) return;
  const activeDateShift = await db
    .table<{ id: string; databaseId: string }>('database_dependency_date_shift_jobs')
    .where('databaseId', '==', databaseId)
    .limit(1)
    .getList();
  if ((activeDateShift.items ?? []).length > 0) {
    throw Object.assign(
      new Error('Dependency date shifting is in progress; retry this read.'),
      { status: 409 },
    );
  }
}

async function assertWorkspaceDependencyDateShiftsReadable(db: DbRef, workspaceId: string) {
  const activeDateShift = await db
    .table<{ id: string; workspaceId: string }>('database_dependency_date_shift_jobs')
    .where('workspaceId', '==', workspaceId)
    .limit(1)
    .getList();
  if ((activeDateShift.items ?? []).length > 0) {
    throw Object.assign(
      new Error('Dependency date shifting is in progress; retry this read.'),
      { status: 409 },
    );
  }
}

async function pageProjectionById(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  const page = await getPageForActor(db, pageId, actorId, { allowTrash: true, actorEmail });
  if (page.parentType === 'database' && page.parentId) {
    const database = await getExisting(db.table<Page>('pages'), page.parentId);
    if (database?.kind === 'database') {
      await assertDependencyDateShiftReadable(db, database.id, database);
    }
  }
  return { page };
}

async function searchBlocks(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  env?: Record<string, unknown>,
) {
  const query = parseSearchQuery(body.query);
  const limit = parseLimit(body.limit, 20, 100);
  const includePaginationMeta = parseBoolean(body.includePaginationMeta);
  const dedupePages = parseBoolean(body.dedupePages);
  const excludeMetadataMatches = parseBoolean(body.excludeMetadataMatches);
  const includePages = parseBoolean(body.includePages);
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const requiredAncestorIds = parseRequiredSearchAncestorIds(body.requiredAncestorIds);
  const authority = await searchWorkspaceAuthority(db, actorId, workspaceId, actorEmail);
  const fingerprint = await blockSearchRequestFingerprint(
    actorId,
    authority.normalizedEmail,
    query,
    workspaceId,
    dedupePages,
    excludeMetadataMatches,
    includePages,
    requiredAncestorIds,
  );
  const rawCursor = body.sourceCursor === undefined
    ? undefined
    : await decodeSearchSourceCursor(body.sourceCursor, env);
  const order: SearchSourceOrder = dedupePages
    ? [
        { field: 'pageId', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]
    : [{ field: 'id', direction: 'asc' }];
  const unverifiedCursor = parseSearchSourceCursor(
    rawCursor,
    fingerprint,
    order.length,
    dedupePages,
  );
  await ensureSearchGroupProjection(db, workspaceId, authority);
  const cursor = unverifiedCursor;
  const loaded = await loadBlockSearchWindow(
    db,
    workspaceId,
    authority,
    query,
    requiredAncestorIds,
    order,
    cursor?.window.after,
  );
  const fullEvaluation = evaluateBlockSearchWindow(loaded, query, {
    dedupePages,
    excludeMetadataMatches,
    ...(cursor?.window.skipPageId ? { skipPageId: cursor.window.skipPageId } : {}),
  });
  const windowRevision = await searchVisibleWindowRevision(
    fingerprint,
    authority,
    'blocks',
    blockVisibleRevisionRows(fullEvaluation.accepted, includePages, excludeMetadataMatches),
    {
      ...(cursor?.window.after ? { after: cursor.window.after } : {}),
      ...(cursor?.window.skipPageId ? { skipPageId: cursor.window.skipPageId } : {}),
    },
  );
  if (cursor?.window.revision && cursor.window.revision !== windowRevision) {
    throw Object.assign(
      new Error('Search source changed while the cursor was in use. Restart the search.'),
      { status: 409 },
    );
  }
  const ranked = [...fullEvaluation.accepted].sort((left, right) => compareSearchRelevance(
      {
        id: left.block.id,
        pageId: left.block.pageId,
        text: left.foldedText,
        updatedAt: left.block.updatedAt ?? left.block.createdAt,
        position: left.block.position,
      },
      {
        id: right.block.id,
        pageId: right.block.pageId,
        text: right.foldedText,
        updatedAt: right.block.updatedAt ?? right.block.createdAt,
        position: right.block.position,
      },
      query,
    ));
  const offset = cursor?.window.offset ?? 0;
  if (offset > ranked.length) {
    throw Object.assign(
      new Error('Search source changed while the cursor was in use. Restart the search.'),
      { status: 409 },
    );
  }
  const matches = ranked.slice(offset, offset + limit);
  const nextOffset = offset + matches.length;
  const nextState = searchContinuationCursor(
    loaded.window,
    fingerprint,
    {
      acceptedCount: ranked.length,
      nextOffset,
      revision: windowRevision,
      ...(cursor?.window.after ? { startAfter: cursor.window.after } : {}),
      ...(cursor?.window.skipPageId ? { startSkipPageId: cursor.window.skipPageId } : {}),
      ...(dedupePages && fullEvaluation.skipPageId
        ? { nextSkipPageId: fullEvaluation.skipPageId }
        : {}),
    },
  );
  const nextCursor = nextState ? await encodeSearchSourceCursor(nextState, env) : undefined;
  const projectedBlocks = matches.map((item) => item.block);
  const selectedPages = includePages
    ? Array.from(new Map(matches.map((item) => [item.page.id, item.page])).values())
    : [];
  await assertSearchAuthorityUnchanged(db, actorId, workspaceId, authority, actorEmail);
  return {
    query,
    blocks: projectedBlocks,
    ...(includePages ? { pages: selectedPages } : {}),
    hasMore: nextCursor !== undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(includePaginationMeta
      ? {
          limit,
          revision: windowRevision,
        }
      : {}),
  };
}

function requireIndexedTargetPageId(value: unknown) {
  const pageId = requireString(value, 'targetPageId');
  if (pageId.length > 256 || !/^[A-Za-z0-9_-]{3,256}$/u.test(pageId)) {
    throw Object.assign(
      new Error('targetPageId must be a 3-256 character indexed page id.'),
      { status: 400 },
    );
  }
  return pageId;
}

async function backlinks(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  env?: Record<string, unknown>,
) {
  const targetPageId = requireIndexedTargetPageId(body.targetPageId);
  const limit = parseLimit(body.limit, 50, 100);
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const authority = await searchWorkspaceAuthority(db, actorId, workspaceId, actorEmail);
  const fingerprint = await backlinksRequestFingerprint(
    actorId,
    authority.normalizedEmail,
    targetPageId,
    workspaceId,
  );
  const rawCursor = body.sourceCursor === undefined
    ? undefined
    : await decodeSearchSourceCursor(body.sourceCursor, env);
  const order: SearchSourceOrder = [{ field: 'id', direction: 'asc' }];
  const cursor = parseSearchSourceCursor(rawCursor, fingerprint, order.length, false);

  const targetPage = await getPageForActor(db, targetPageId, actorId, { actorEmail });
  if (targetPage.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Page was not found.'), { status: 404 });
  }
  await ensureSearchGroupProjection(db, workspaceId, authority);
  const loaded = await loadBlockSearchWindow(
    db,
    workspaceId,
    authority,
    targetPageId,
    [],
    order,
    cursor?.window.after,
  );
  const evaluation = evaluateBacklinksWindow(loaded, targetPageId);
  const revision = await searchVisibleWindowRevision(
    fingerprint,
    authority,
    'blocks',
    evaluation.accepted.map(({ block, page, kind }) => ({ block, page, kind })),
    { ...(cursor?.window.after ? { after: cursor.window.after } : {}) },
  );
  if (cursor?.window.revision && cursor.window.revision !== revision) {
    throw Object.assign(
      new Error('Backlinks source changed while the cursor was in use. Restart the read.'),
      { status: 409 },
    );
  }

  const offset = cursor?.window.offset ?? 0;
  if (offset > evaluation.accepted.length) {
    throw Object.assign(
      new Error('Backlinks source changed while the cursor was in use. Restart the read.'),
      { status: 409 },
    );
  }
  const matches = evaluation.accepted.slice(offset, offset + limit);
  const nextState = searchContinuationCursor(
    loaded.window,
    fingerprint,
    {
      acceptedCount: evaluation.accepted.length,
      nextOffset: offset + matches.length,
      revision,
      ...(cursor?.window.after ? { startAfter: cursor.window.after } : {}),
    },
  );
  const nextCursor = nextState ? await encodeSearchSourceCursor(nextState, env) : undefined;
  const pages = Array.from(new Map(matches.map((item) => [item.page.id, item.page])).values());
  await assertSearchAuthorityUnchanged(db, actorId, workspaceId, authority, actorEmail);
  return {
    targetPageId,
    blocks: matches.map((item) => item.block),
    pages,
    hasMore: nextCursor !== undefined,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function pageComments(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  await getPageForActor(db, pageId, actorId, { actorEmail });
  const comments = await listAll(db.table<Comment>('comments').where('pageId', '==', pageId));
  return { pageId, comments: comments.sort(byCreated) };
}

async function pageCommentById(db: DbRef, commentId: string, actorId: string, actorEmail?: string | null) {
  // getExisting: server-side getOne throws on missing rows (see table-utils).
  const comment = await getExisting(db.table<Comment>('comments'), commentId);
  if (!comment) throw new Error('Comment was not found.');
  await getPageForActor(db, comment.pageId, actorId, { actorEmail });
  return { comment };
}

async function databaseSnapshot(
  db: DbRef,
  databaseId: string,
  actorId: string,
  actorEmail?: string | null,
  options: { includeViewIds?: string[] } = {},
) {
  const page = await getPageForActor(db, databaseId, actorId, { actorEmail });
  if (page.kind !== 'database') throw new Error('Page is not a database.');

  const linkedSource = await resolveImportedLinkedDatabaseSource(db, page, actorId, actorEmail);
  if (linkedSource) {
    const sourceDatabaseId = linkedSource.sourceDatabase.id;
    const [properties, templates] = await Promise.all([
      listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', sourceDatabaseId)),
      listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', sourceDatabaseId)),
    ]);
    const sortedProperties = properties.sort(bySortPos);
    const sortedViews = linkedSource.views.sort(bySortPos);
    const remappedViews = await remapImportedViewRelationFiltersForRead(
      db,
      page.workspaceId,
      sortedProperties,
      sortedViews,
    );
    const inferredViews = addInferredImportedViewNameFiltersForRead(sortedProperties, remappedViews);
    const views = await addImportedLinkedDatabaseContextFiltersForRead(
      db,
      linkedSource,
      sortedProperties,
      inferredViews,
    );

    return {
      databaseId,
      resolvedDatabaseId: sourceDatabaseId,
      resolvedFromNotionDatabaseId: linkedSource.targetNotionDatabaseId,
      resolvedDatabaseTitle: linkedSource.sourceDatabase.title,
      properties: sortedProperties
        .map((property) => ({ ...property, databaseId })),
      views: views
        .map((view) => ({ ...view, databaseId })),
      templates: templates
        .sort(bySortPos)
        .map((template) => ({ ...template, databaseId })),
    };
  }

  const [properties, views, templates] = await Promise.all([
    listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId)),
    listAll(db.table<DbView>('db_views').where('databaseId', '==', databaseId)),
    listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', databaseId)),
  ]);
  const sortedProperties = properties.sort(bySortPos);
  const sortedViews = filterViewsByNotionDatabaseContainer(
    views.sort(bySortPos),
    await importedDatabaseContainerNotionId(db, page),
    { includeViewIds: options.includeViewIds },
  );
  const remappedViews = await remapImportedViewRelationFiltersForRead(db, page.workspaceId, sortedProperties, sortedViews);

  return {
    databaseId,
    properties: sortedProperties,
    views: addInferredImportedViewNameFiltersForRead(sortedProperties, remappedViews),
    templates: templates.sort(bySortPos),
  };
}

type DatabaseSnapshotRead = Awaited<ReturnType<typeof databaseSnapshot>>;

function relatedDatabaseIdsFromSnapshot(snapshot: DatabaseSnapshotRead) {
  return Array.from(new Set(
    snapshot.properties.flatMap((property) => {
      const databaseId = relationTargetLocalDatabaseId(property);
      return databaseId ? [databaseId] : [];
    }),
  ));
}

/**
 * Resolve the metadata graph that relation/rollup cells will need without
 * pulling any database rows. Doing this inside the first metadata request
 * avoids a slow-client waterfall where each returned schema discovers and
 * starts the next HTTP request several seconds later.
 */
async function relatedDatabaseSnapshotsForRoots(
  context: FunctionContext,
  roots: DatabaseSnapshotRead[],
  options: {
    limit?: number;
    skipDatabaseIds?: ReadonlySet<string>;
  } = {},
) {
  const { auth, admin } = context;
  if (!auth?.id) {
    throw Object.assign(new Error('Authentication required.'), { status: 401 });
  }
  const limit = Math.max(0, Math.floor(options.limit ?? PAGE_EMBEDDED_DATABASE_PREFETCH_MAX));
  const seen = new Set(options.skipDatabaseIds ?? []);
  for (const root of roots) {
    seen.add(root.databaseId);
    if (root.resolvedDatabaseId) seen.add(root.resolvedDatabaseId);
  }
  let frontier = roots
    .flatMap(relatedDatabaseIdsFromSnapshot)
    .filter((databaseId) => {
      if (seen.has(databaseId)) return false;
      seen.add(databaseId);
      return true;
    });
  const snapshots: DatabaseSnapshotRead[] = [];
  let truncated = false;

  while (frontier.length > 0) {
    const remaining = limit - snapshots.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const selected = frontier.slice(0, remaining);
    if (selected.length < frontier.length) truncated = true;
    const loaded = await mapLimit(selected, PAGE_READ_BATCH_CONCURRENCY, async (databaseId) => {
      try {
        const db = await boundedDbFromPageHint(admin, undefined, undefined, databaseId);
        return await databaseSnapshot(db, databaseId, auth.id, auth.email ?? null);
      } catch {
        // A readable database may point at an inaccessible one. Do not leak
        // its schema or fail the useful root snapshot; an explicit read will
        // still surface its own 403/404.
        return null;
      }
    });
    const accepted = loaded.filter((snapshot): snapshot is DatabaseSnapshotRead => snapshot !== null);
    snapshots.push(...accepted);
    const next: string[] = [];
    for (const snapshot of accepted) {
      if (snapshot.resolvedDatabaseId) seen.add(snapshot.resolvedDatabaseId);
      for (const databaseId of relatedDatabaseIdsFromSnapshot(snapshot)) {
        if (seen.has(databaseId)) continue;
        seen.add(databaseId);
        next.push(databaseId);
      }
    }
    frontier = next;
  }

  return { snapshots, truncated };
}

async function pagesProjection(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const includeTrash = parseBoolean(body.includeTrash);
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim()
    ? body.workspaceId.trim()
    : undefined;
  const parentId = typeof body.parentId === 'string' && body.parentId.trim()
    ? body.parentId.trim()
    : undefined;
  const parentType = typeof body.parentType === 'string' && body.parentType.trim()
    ? body.parentType.trim()
    : undefined;

  let pages = await pagesForActor(db, actorId, { includeTrash, workspaceId, actorEmail });
  if (parentId) pages = pages.filter((page) => page.parentId === parentId);
  if (parentType) pages = pages.filter((page) => page.parentType === parentType);

  return { pages };
}

async function searchPages(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  env?: Record<string, unknown>,
) {
  const query = parseSearchQuery(body.query);
  const limit = parseLimit(body.limit, 20, 100);
  const includePaginationMeta = parseBoolean(body.includePaginationMeta);
  const includeTrash = parseBoolean(body.includeTrash);
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const requiredAncestorIds = parseRequiredSearchAncestorIds(body.requiredAncestorIds);
  const authority = await searchWorkspaceAuthority(db, actorId, workspaceId, actorEmail);
  const fingerprint = await pageSearchRequestFingerprint(
    actorId,
    authority.normalizedEmail,
    query,
    workspaceId,
    includeTrash,
    requiredAncestorIds,
  );
  const rawCursor = body.sourceCursor === undefined
    ? undefined
    : await decodeSearchSourceCursor(body.sourceCursor, env);
  const order: SearchSourceOrder = [{ field: 'id', direction: 'asc' }];
  const unverifiedCursor = parseSearchSourceCursor(rawCursor, fingerprint, order.length, false);
  await ensureSearchGroupProjection(db, workspaceId, authority);
  const cursor = unverifiedCursor;
  const window = await loadPageSearchWindow(
    db,
    workspaceId,
    authority,
    query,
    includeTrash,
    requiredAncestorIds,
    order,
    cursor?.window.after,
  );
  const fullEvaluation = evaluatePageSearchWindow(window, workspaceId, query, includeTrash);
  const windowRevision = await searchVisibleWindowRevision(
    fingerprint,
    authority,
    'pages',
    fullEvaluation.accepted.map(({ page }) => page),
    { ...(cursor?.window.after ? { after: cursor.window.after } : {}) },
  );
  if (cursor?.window.revision && cursor.window.revision !== windowRevision) {
    throw Object.assign(
      new Error('Search source changed while the cursor was in use. Restart the search.'),
      { status: 409 },
    );
  }
  const ranked = [...fullEvaluation.accepted].sort((left, right) => compareSearchRelevance(
      {
        id: left.page.id,
        text: left.text,
        updatedAt: left.page.updatedAt ?? left.page.createdAt,
        position: left.page.position,
      },
      {
        id: right.page.id,
        text: right.text,
        updatedAt: right.page.updatedAt ?? right.page.createdAt,
        position: right.page.position,
      },
      query,
    ));
  const offset = cursor?.window.offset ?? 0;
  if (offset > ranked.length) {
    throw Object.assign(
      new Error('Search source changed while the cursor was in use. Restart the search.'),
      { status: 409 },
    );
  }
  const matches = ranked.slice(offset, offset + limit);
  const nextOffset = offset + matches.length;
  const nextState = searchContinuationCursor(
    window,
    fingerprint,
    {
      acceptedCount: ranked.length,
      nextOffset,
      revision: windowRevision,
      ...(cursor?.window.after ? { startAfter: cursor.window.after } : {}),
    },
  );
  const nextCursor = nextState ? await encodeSearchSourceCursor(nextState, env) : undefined;
  await assertSearchAuthorityUnchanged(db, actorId, workspaceId, authority, actorEmail);
  return {
    query,
    pages: matches.map(({ page }) => page),
    hasMore: nextCursor !== undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(includePaginationMeta
      ? {
          limit,
          revision: windowRevision,
        }
      : {}),
  };
}

async function relatedPagesForRows(
  db: DbRef,
  rows: Page[],
  properties: DbProperty[],
  actorId: string,
  actorEmail?: string | null,
) {
  const relationProps = properties.filter((prop) => prop.type === 'relation');
  if (rows.length === 0 || relationProps.length === 0) return { pages: [], targetIds: [] };

  const targetIds = new Set<string>();
  for (const row of rows) {
    for (const prop of relationProps) {
      for (const id of ids(row.properties?.[prop.id])) {
        if (id && id !== row.id) targetIds.add(id);
      }
    }
  }
  if (targetIds.size === 0) return { pages: [], targetIds: [] };

  const workspaceIds = new Set(await accessibleWorkspaceIds(db, actorId));
  const targetIdList = Array.from(targetIds);
  const pages = (
    await mapLimit(
      targetIdList,
      QUERY_FANOUT_LIMIT,
      async (pageId) => {
        const page = await db.table<Page>('pages').getOne(pageId).catch(() => null);
        if (!page || page.inTrash) return null;
        try {
          if (await canSeePage(db, page, actorId, workspaceIds, actorEmail)) {
            return projectPageImportTimestamps(page);
          }
        } catch {
          // Relation chips should fail quietly when a target is no longer visible.
        }
        return null;
      },
    )
  ).filter((page): page is Page => !!page);
  return { pages: pages.sort(byPageOrder), targetIds: targetIdList };
}

type ComputedContextRequirements = {
  missingDatabaseIds: Set<string>;
  relationPropsByDatabaseId: Map<string, DbProperty[]>;
  depthExceeded: boolean;
};

function collectComputedContextRequirements(
  relevantProperties: DbProperty[],
  propsByDb: Map<string, DbProperty[]>,
): ComputedContextRequirements {
  const missingDatabaseIds = new Set<string>();
  const relationPropsByDatabaseId = new Map<string, Map<string, DbProperty>>();
  let depthExceeded = false;

  const schema = (databaseId: string) => {
    const properties = propsByDb.get(databaseId);
    if (properties === undefined) missingDatabaseIds.add(databaseId);
    return properties;
  };
  const addRelation = (property: DbProperty) => {
    if (property.type !== 'relation') return;
    const byId = relationPropsByDatabaseId.get(property.databaseId) ?? new Map<string, DbProperty>();
    byId.set(property.id, property);
    relationPropsByDatabaseId.set(property.databaseId, byId);
  };

  const traceRollup = (property: DbProperty, depth: number, trail: Set<string>) => {
    if (depth >= DATABASE_QUERY_CONTEXT_MAX_TRACE_DEPTH) {
      depthExceeded = true;
      return;
    }
    const propertyKey = `${property.databaseId}\u0000${property.id}`;
    if (trail.has(propertyKey)) return;
    trail.add(propertyKey);

    const ownerProperties = schema(property.databaseId);
    const sourceRelationId = typeof property.config?.rollupRelationPropertyId === 'string'
      ? property.config.rollupRelationPropertyId
      : undefined;
    const sourceRelation = sourceRelationId
      ? ownerProperties?.find((candidate) => candidate.id === sourceRelationId)
      : undefined;
    if (!sourceRelation || sourceRelation.type !== 'relation') {
      trail.delete(propertyKey);
      return;
    }
    addRelation(sourceRelation);

    const targetDatabaseId = relationTargetLocalDatabaseId(sourceRelation) ?? sourceRelation.databaseId;
    const targetProperties = schema(targetDatabaseId);
    const targetPropertyId = typeof property.config?.rollupTargetPropertyId === 'string'
      ? property.config.rollupTargetPropertyId
      : undefined;
    let current = targetPropertyId
      ? targetProperties?.find((candidate) => candidate.id === targetPropertyId)
      : undefined;

    for (let hop = 0; hop < 3 && current; hop += 1) {
      if (current.type === 'relation') {
        addRelation(current);
        current = undefined;
        break;
      }
      if (current.type !== 'rollup') break;

      const currentOwnerProperties = schema(current.databaseId);
      const configuredViaId = hop === 0 && typeof property.config?.rollupVia === 'string'
        ? property.config.rollupVia
        : undefined;
      const currentRelationId = typeof current.config?.rollupRelationPropertyId === 'string'
        ? current.config.rollupRelationPropertyId
        : undefined;
      const hopRelation = (
        configuredViaId
          ? currentOwnerProperties?.find((candidate) => candidate.id === configuredViaId)
          : undefined
      ) ?? (
        currentRelationId
          ? currentOwnerProperties?.find((candidate) => candidate.id === currentRelationId)
          : undefined
      );
      if (!hopRelation || hopRelation.type !== 'relation') break;
      addRelation(hopRelation);

      const hopDatabaseId = relationTargetLocalDatabaseId(hopRelation) ?? hopRelation.databaseId;
      const hopProperties = schema(hopDatabaseId);
      const nextTargetId = typeof current.config?.rollupTargetPropertyId === 'string'
        ? current.config.rollupTargetPropertyId
        : undefined;
      current = nextTargetId
        ? hopProperties?.find((candidate) => candidate.id === nextTargetId)
        : undefined;
    }

    if (current?.type === 'relation') addRelation(current);
    if (current?.type === 'rollup') traceRollup(current, depth + 1, trail);
    trail.delete(propertyKey);
  };

  for (const property of relevantProperties) {
    if (property.type === 'relation') addRelation(property);
    if (property.type === 'rollup') traceRollup(property, 0, new Set<string>());
    if (property.type === 'formula' && typeof property.config?.formula === 'string') {
      const ownerProperties = schema(property.databaseId);
      for (const reference of formulaPropertyReferences(property.config.formula)) {
        const target = ownerProperties?.find((candidate) => (
          candidate.id === reference || candidate.name === reference
        ));
        if (target?.type === 'relation') addRelation(target);
      }
    }
  }

  return {
    missingDatabaseIds,
    relationPropsByDatabaseId: new Map(
      Array.from(relationPropsByDatabaseId, ([databaseId, properties]) => [
        databaseId,
        Array.from(properties.values()),
      ]),
    ),
    depthExceeded,
  };
}

function computedContextLimitError(label: string) {
  return Object.assign(
    new Error(`${label} exceeds ${DEFAULT_LIST_ALL_MAX_ITEMS} records.`),
    { status: 413 },
  );
}

async function loadComputedContextRequirements(
  db: DbRef,
  relevantProperties: DbProperty[],
  propsByDb: Map<string, DbProperty[]>,
) {
  let materializedPropertyCount = new Set(
    Array.from(propsByDb.values()).flat().map((property) => `${property.databaseId}\u0000${property.id}`),
  ).size;
  for (let round = 0; round < DATABASE_QUERY_CONTEXT_MAX_TRACE_DEPTH; round += 1) {
    const requirements = collectComputedContextRequirements(relevantProperties, propsByDb);
    if (requirements.depthExceeded) {
      throw computedContextLimitError('Database computed property dependency depth');
    }
    const missingDatabaseIds = Array.from(requirements.missingDatabaseIds)
      .filter((databaseId) => propsByDb.get(databaseId) === undefined);
    if (missingDatabaseIds.length === 0) return requirements;

    for (let index = 0; index < missingDatabaseIds.length; index += DATABASE_QUERY_CONTEXT_CHUNK_SIZE) {
      const databaseIds = missingDatabaseIds.slice(index, index + DATABASE_QUERY_CONTEXT_CHUNK_SIZE);
      const remaining = DEFAULT_LIST_ALL_MAX_ITEMS - materializedPropertyCount;
      const properties = await listAll(
        db.table<DbProperty>('db_properties').where('databaseId', 'in', databaseIds),
        {
          maxItems: Math.max(1, remaining),
          pageSize: Math.max(1, Math.min(1_000, remaining || 1)),
          label: 'Database computed property context',
        },
      );
      materializedPropertyCount += properties.length;
      if (materializedPropertyCount > DEFAULT_LIST_ALL_MAX_ITEMS) {
        throw computedContextLimitError('Database computed property context');
      }
      const propertiesByDatabaseId = new Map<string, DbProperty[]>();
      for (const property of properties) {
        const items = propertiesByDatabaseId.get(property.databaseId) ?? [];
        items.push(property);
        propertiesByDatabaseId.set(property.databaseId, items);
      }
      for (const databaseId of databaseIds) {
        propsByDb.set(databaseId, (propertiesByDatabaseId.get(databaseId) ?? []).sort(bySortPos));
      }
    }
  }
  throw computedContextLimitError('Database computed property dependency depth');
}

async function loadComputedDependencyPages(
  db: DbRef,
  roots: Array<{ page: Page; databaseId: string }>,
  relationPropsByDatabaseId: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
  settledPageIds: Set<string>,
  dependencyPageIds: Set<string>,
  actorId: string,
  actorEmail?: string | null,
) {
  const processed = new Set<string>();
  let frontier = roots;

  while (frontier.length > 0) {
    const ownersByPageId = new Map<string, Set<string>>();
    for (const { page, databaseId } of frontier) {
      const pairKey = `${databaseId}\u0000${page.id}`;
      if (processed.has(pairKey) || page.inTrash) continue;
      processed.add(pairKey);
      for (const relation of relationPropsByDatabaseId.get(databaseId) ?? []) {
        const targetDatabaseId = relationTargetLocalDatabaseId(relation) ?? relation.databaseId;
        for (const pageId of ids(rawPropertyValue(page, relation))) {
          dependencyPageIds.add(pageId);
          if (dependencyPageIds.size > DEFAULT_LIST_ALL_MAX_ITEMS) {
            throw computedContextLimitError('Database computed page context');
          }
          const owners = ownersByPageId.get(pageId) ?? new Set<string>();
          owners.add(targetDatabaseId);
          ownersByPageId.set(pageId, owners);
        }
      }
    }
    if (ownersByPageId.size === 0) return;

    const unreadPageIds = Array.from(ownersByPageId.keys()).filter((pageId) => (
      !pagesById.has(pageId) && !settledPageIds.has(pageId)
    ));
    if (unreadPageIds.length > 0) {
      const chunks = Array.from(
        { length: Math.ceil(unreadPageIds.length / DATABASE_QUERY_CONTEXT_CHUNK_SIZE) },
        (_, index) => unreadPageIds.slice(
          index * DATABASE_QUERY_CONTEXT_CHUNK_SIZE,
          (index + 1) * DATABASE_QUERY_CONTEXT_CHUNK_SIZE,
        ),
      );
      const workspaceIdsPromise = accessibleWorkspaceIds(db, actorId).then((ids) => new Set(ids));
      const loadedChunks = await mapLimit(
        chunks,
        DATABASE_QUERY_CONTEXT_CHUNK_CONCURRENCY,
        async (chunk) => {
          const [loaded, workspaceIds] = await Promise.all([
            listAll(
              db.table<Page>('pages').where('id', 'in', chunk),
              {
                maxItems: chunk.length,
                pageSize: chunk.length,
                label: 'Database computed page context',
              },
            ),
            workspaceIdsPromise,
          ]);
          const visible = await mapLimit(loaded, QUERY_FANOUT_LIMIT, async (page) => {
            if (page.inTrash) return null;
            if (workspaceIds.has(page.workspaceId)) return projectPageImportTimestamps(page);
            try {
              return await canSeePage(db, page, actorId, workspaceIds, actorEmail)
                ? projectPageImportTimestamps(page)
                : null;
            } catch (error) {
              if (
                error instanceof Error
                && error.message.includes('Organization active access required.')
              ) {
                return null;
              }
              throw error;
            }
          });
          return {
            chunk,
            pages: visible.filter((page): page is Page => page !== null),
          };
        },
      );
      for (const loaded of loadedChunks) {
        for (const pageId of loaded.chunk) settledPageIds.add(pageId);
        for (const page of loaded.pages) pagesById.set(page.id, page);
      }
    }

    const next: Array<{ page: Page; databaseId: string }> = [];
    for (const [pageId, databaseIds] of ownersByPageId) {
      const page = pagesById.get(pageId);
      if (!page || page.inTrash) continue;
      for (const databaseId of databaseIds) next.push({ page, databaseId });
    }
    frontier = next;
  }
}

const DATABASE_ROWS_DEFAULT_LIMIT = 100;

type DatabaseRowsBoundary = {
  position: number;
  id: string;
};

type DatabaseRowsSnapshotBoundary = {
  sortKey: string;
  id: string;
};

type DatabaseRowsSourceCursorState = {
  v: 1;
  kind: 'databaseRows';
  fingerprint: string;
  phase: 'source';
  after: DatabaseRowsBoundary;
  snapshotId?: string;
};

type DatabaseRowsSnapshotCursorState = {
  v: 1;
  kind: 'databaseRows';
  fingerprint: string;
  phase: 'snapshot';
  snapshotId: string;
  after: { id: string };
};

type DatabaseRowsCursorState = DatabaseRowsSourceCursorState | DatabaseRowsSnapshotCursorState;

function databaseRowsCursorError(message: string) {
  return Object.assign(new Error(`Database row cursor ${message}`), { status: 400 });
}

function parseDatabaseRowsCursorState(
  value: unknown,
  fingerprint: string,
): DatabaseRowsCursorState | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value) || Object.keys(value).some((key) => (
    key !== 'v'
    && key !== 'kind'
    && key !== 'fingerprint'
    && key !== 'phase'
    && key !== 'after'
    && key !== 'snapshotId'
  ))) {
    throw databaseRowsCursorError('is malformed.');
  }
  if (value.v !== 1 || value.kind !== 'databaseRows' || value.fingerprint !== fingerprint) {
    throw databaseRowsCursorError('does not match this database query.');
  }
  const snapshotId = value.snapshotId === undefined
    ? undefined
    : boundedCursorString(value.snapshotId, 'snapshot id', 256);
  if (!isPlainRecord(value.after) || typeof value.after.id !== 'string' || !value.after.id) {
    throw databaseRowsCursorError('boundary is malformed.');
  }
  const id = boundedCursorString(value.after.id, 'boundary id', 256);
  if (value.phase === 'source') {
    if (
      Object.keys(value.after).some((key) => key !== 'position' && key !== 'id')
      || typeof value.after.position !== 'number'
      || !Number.isFinite(value.after.position)
    ) {
      throw databaseRowsCursorError('boundary is malformed.');
    }
    return {
      v: 1,
      kind: 'databaseRows',
      fingerprint,
      phase: 'source',
      after: { position: value.after.position, id },
      ...(snapshotId ? { snapshotId } : {}),
    };
  }
  if (
    value.phase !== 'snapshot'
    || !snapshotId
    || Object.keys(value.after).some((key) => key !== 'id')
  ) {
    throw databaseRowsCursorError('boundary is malformed.');
  }
  return {
    v: 1,
    kind: 'databaseRows',
    fingerprint,
    phase: 'snapshot',
    snapshotId,
    after: { id },
  };
}

function compareDatabaseRowBoundary(left: Page, right: DatabaseRowsBoundary | Page) {
  return (
    (left.position ?? 0) - (right.position ?? 0)
    || left.id.localeCompare(right.id)
  );
}

function databaseRowsPreserveRestrictedHierarchy(
  selectedView: DbView | undefined,
  subitemParentId: string | undefined,
) {
  if (subitemParentId === undefined) return false;
  if (!selectedView) return true;
  if (
    selectedView.type !== 'table'
    && selectedView.type !== 'list'
    && selectedView.type !== 'timeline'
  ) {
    return false;
  }
  const subtasks = recordObject(selectedView.config?.subtasks);
  return (
    (subtasks?.displayMode ?? 'show') === 'show'
    && (subtasks?.filterScope ?? 'parents_and_subitems') === 'parents_and_subitems'
  );
}

function databaseStructuralPlaceholder(row: Page): Page {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    parentType: 'database',
    kind: 'page',
    title: '',
    iconType: 'none',
    position: row.position,
    inTrash: false,
    subitemParentId: row.subitemParentId ?? '',
    // This value is internal presentation authority only. The wire projection
    // below intentionally omits the canonical count.
    subitemChildCount: 1,
    __structuralPlaceholder: true,
  };
}

function projectDatabaseRowForWire(row: Page) {
  if (row.__structuralPlaceholder !== true) return row;
  return {
    id: row.id,
    subitemParentId: row.subitemParentId ?? '',
    __structuralPlaceholder: true as const,
  };
}

function boundedDatabaseRowsBaseQuery(
  db: DbRef,
  rowDatabaseId: string,
  includeTrash: boolean,
  subitemParentId?: string,
) {
  let query: TableQuery<Page> = db.table<Page>('pages').where('parentId', '==', rowDatabaseId);
  if (
    typeof query.where !== 'function'
    || typeof query.orderBy !== 'function'
    || typeof query.includeTotal !== 'function'
  ) {
    throw Object.assign(new Error('Database rows require bounded ordered queries.'), { status: 500 });
  }
  query = query.where('parentType', '==', 'database');
  if (subitemParentId !== undefined) {
    if (typeof query.where !== 'function') {
      throw Object.assign(new Error('Database rows require bounded ordered queries.'), { status: 500 });
    }
    query = query.where('subitemParentId', '==', subitemParentId);
  }
  if (!includeTrash) {
    if (typeof query.where !== 'function') {
      throw Object.assign(new Error('Database rows require bounded ordered queries.'), { status: 500 });
    }
    query = query.where('inTrash', '==', false);
  }
  if (typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Database rows require bounded ordered queries.'), { status: 500 });
  }
  query = query.orderBy('position', 'asc');
  if (typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Database rows require bounded ordered queries.'), { status: 500 });
  }
  query = query.orderBy('id', 'asc');
  if (typeof query.includeTotal !== 'function') {
    throw Object.assign(new Error('Database rows require bounded ordered queries.'), { status: 500 });
  }
  return query.includeTotal(false);
}

async function boundedDatabaseRowsWindow(
  db: DbRef,
  rowDatabaseId: string,
  includeTrash: boolean,
  limit: number,
  after?: DatabaseRowsBoundary,
  subitemParentId?: string,
) {
  const read = async (additional: Array<[string, string, unknown]>) => {
    let query = boundedDatabaseRowsBaseQuery(
      db,
      rowDatabaseId,
      includeTrash,
      subitemParentId,
    );
    for (const [field, op, value] of additional) {
      if (typeof query.where !== 'function') {
        throw Object.assign(new Error('Database rows require bounded ordered queries.'), { status: 500 });
      }
      query = query.where(field, op, value);
    }
    return (await query.limit(limit + 1).getList()).items ?? [];
  };

  const candidates = after
    ? (await Promise.all([
        read([['position', '>', after.position]]),
        read([['position', '==', after.position], ['id', '>', after.id]]),
      ])).flat()
    : await read([]);
  const byId = new Map<string, Page>();
  for (const row of candidates) {
    if (
      row.parentId !== rowDatabaseId
      || row.parentType !== 'database'
      || (subitemParentId !== undefined && (row.subitemParentId ?? '') !== subitemParentId)
      || (!includeTrash && row.inTrash)
      || (after && compareDatabaseRowBoundary(row, after) <= 0)
    ) continue;
    byId.set(row.id, row);
  }
  const rows = Array.from(byId.values()).sort((left, right) => compareDatabaseRowBoundary(left, right));
  const accepted = rows.slice(0, limit);
  return {
    rows: accepted,
    hasMore: rows.length > limit,
    boundary: accepted.length > 0
      ? { position: accepted.at(-1)!.position ?? 0, id: accepted.at(-1)!.id }
      : undefined,
  };
}

interface DatabaseQuerySnapshot {
  id: string;
  workspaceId: string;
  databaseId: string;
  actorId: string;
  fingerprint: string;
  expiresAt: string;
}

interface DatabaseQuerySnapshotRow {
  id: string;
  snapshotId: string;
  rowId: string;
  sortKey: string;
}

const DATABASE_QUERY_SNAPSHOT_TTL_MS = 30 * 60 * 1_000;
// DO SQLite permits 100 bound variables per statement. Leave headroom for
// the list endpoint's own limit/offset parameters around each `id in (...)`.
const DATABASE_QUERY_SNAPSHOT_IN_CHUNK_SIZE = 90;
const DATABASE_QUERY_SNAPSHOT_IN_CONCURRENCY = 4;
const DATABASE_QUERY_SNAPSHOT_CLEANUP_HEADER_WINDOW = 20;
const DATABASE_QUERY_SNAPSHOT_CLEANUP_ROW_WINDOW = 500;

function sortableToken(token: number, descending: boolean) {
  const normalized = Math.min(0xffffffff, Math.max(0, Math.floor(token))) >>> 0;
  const directed = descending ? (0xffffffff - normalized) >>> 0 : normalized;
  return directed.toString(16).padStart(8, '0');
}

function sortableNumberTokens(value: number) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  const bytes = new Uint8Array(buffer);
  if ((bytes[0]! & 0x80) !== 0) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = 0xff - bytes[index]!;
  } else {
    bytes[0] = bytes[0]! ^ 0x80;
  }
  return [view.getUint32(0, false), view.getUint32(4, false)];
}

function sortableDatabaseComponent(value: number | string, descending: boolean) {
  const tokens = typeof value === 'number'
    ? sortableNumberTokens(value)
    : [...naturalOrderTokens(value).map((token) => token + 1), 0];
  return tokens.map((token) => sortableToken(token, descending)).join('');
}

function databaseSnapshotSortKey(
  row: Page,
  view: DbView | undefined,
  properties: DbProperty[],
  context: DatabaseRowsQueryContext | undefined,
  importedOrder: number | undefined,
) {
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const components: string[] = [];
  for (const sort of Array.isArray(view?.config?.sorts) ? view.config.sorts : []) {
    const record = recordObject(sort);
    const property = typeof record?.propertyId === 'string'
      ? propertiesById.get(record.propertyId)
      : undefined;
    if (!property || !context) continue;
    components.push(sortableDatabaseComponent(
      databaseSortKey(row, property, context),
      record?.direction === 'desc',
    ));
  }
  components.push(sortableDatabaseComponent(importedOrder ?? Number.MAX_SAFE_INTEGER, false));
  components.push(sortableDatabaseComponent(row.position ?? 0, false));
  components.push(sortableDatabaseComponent(row.id, false));
  return components.join('');
}

async function deleteDatabaseQuerySnapshot(db: DbRef, snapshotId: string) {
  while (true) {
    let rowsQuery: TableQuery<DatabaseQuerySnapshotRow> = db
      .table<DatabaseQuerySnapshotRow>('database_query_snapshot_rows')
      .where('snapshotId', '==', snapshotId);
    if (typeof rowsQuery.orderBy !== 'function') {
      throw Object.assign(new Error('Database snapshot cleanup requires bounded ordered queries.'), { status: 500 });
    }
    rowsQuery = rowsQuery.orderBy('id', 'asc');
    if (typeof rowsQuery.includeTotal === 'function') rowsQuery = rowsQuery.includeTotal(false);
    const rows = (await rowsQuery.limit(DATABASE_QUERY_SNAPSHOT_CLEANUP_ROW_WINDOW).getList()).items ?? [];
    if (rows.length === 0) break;
    await db.transact(rows.map((row) => ({
      table: 'database_query_snapshot_rows',
      op: 'delete' as const,
      id: row.id,
    })));
  }
  await db.transact([{ table: 'database_query_snapshots', op: 'delete', id: snapshotId }]);
}

async function cleanupExpiredDatabaseQuerySnapshots(
  db: DbRef,
  workspaceId: string,
) {
  const expiredBefore = nowIso();
  while (true) {
    let query: TableQuery<DatabaseQuerySnapshot> = db
      .table<DatabaseQuerySnapshot>('database_query_snapshots')
      .where('workspaceId', '==', workspaceId);
    if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Database snapshot cleanup requires bounded ordered queries.'), { status: 500 });
    }
    query = query.where('expiresAt', '<=', expiredBefore);
    if (typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Database snapshot cleanup requires bounded ordered queries.'), { status: 500 });
    }
    query = query.orderBy('expiresAt', 'asc');
    if (typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Database snapshot cleanup requires bounded ordered queries.'), { status: 500 });
    }
    query = query.orderBy('id', 'asc');
    if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
    const expired = (await query.limit(DATABASE_QUERY_SNAPSHOT_CLEANUP_HEADER_WINDOW).getList()).items ?? [];
    if (expired.length === 0) return;

    for (const snapshot of expired) await deleteDatabaseQuerySnapshot(db, snapshot.id);
  }
}

async function createDatabaseQuerySnapshot(
  db: DbRef,
  database: Page,
  actorId: string,
  fingerprint: string,
) {
  await cleanupExpiredDatabaseQuerySnapshots(db, database.workspaceId);
  const snapshot = await db.table<DatabaseQuerySnapshot>('database_query_snapshots').insert({
    id: `db-query-${newId()}`,
    workspaceId: database.workspaceId,
    databaseId: database.id,
    actorId,
    fingerprint,
    expiresAt: new Date(Date.now() + DATABASE_QUERY_SNAPSHOT_TTL_MS).toISOString(),
  });
  return snapshot;
}

async function requireDatabaseQuerySnapshot(
  db: DbRef,
  snapshotId: string,
  database: Page,
  actorId: string,
  fingerprint: string,
) {
  const snapshot = await getExisting(
    db.table<DatabaseQuerySnapshot>('database_query_snapshots'),
    snapshotId,
  );
  if (
    !snapshot
    || snapshot.databaseId !== database.id
    || snapshot.workspaceId !== database.workspaceId
    || snapshot.actorId !== actorId
    || snapshot.fingerprint !== fingerprint
    || Date.parse(snapshot.expiresAt) <= Date.now()
  ) {
    throw databaseRowsCursorError('snapshot is missing, expired, or mismatched.');
  }
  return snapshot;
}

async function writeDatabaseQuerySnapshotRows(
  db: DbRef,
  snapshotId: string,
  rows: Page[],
  sortKeyForRow: (row: Page) => string,
) {
  if (rows.length === 0) return;
  const records = rows.map((row) => ({
    id: `${snapshotId}-${row.id}`,
    snapshotId,
    rowId: row.id,
    sortKey: sortKeyForRow(row),
  }));
  const loadExisting = async (label: string) => (await mapLimit(
    chunksOf(records.map((record) => record.id), DATABASE_QUERY_SNAPSHOT_IN_CHUNK_SIZE),
    DATABASE_QUERY_SNAPSHOT_IN_CONCURRENCY,
    async (ids) => await listAll(
      db.table<DatabaseQuerySnapshotRow>('database_query_snapshot_rows').where('id', 'in', ids),
      { maxItems: ids.length, pageSize: ids.length, label },
    ),
  )).flat();
  const existing = await loadExisting('Database query snapshot replay rows');
  const existingIds = new Set(existing.map((record) => record.id));
  const operations: TransactOperation[] = records
    .filter((record) => !existingIds.has(record.id))
    .map((record) => ({ table: 'database_query_snapshot_rows', op: 'insert', data: record }));
  if (operations.length === 0) return;
  try {
    await db.transact(operations);
  } catch (error) {
    if (!isTransactionConflictError(error)) throw error;
    const settled = await loadExisting('Database query snapshot concurrent replay rows');
    if (settled.length !== records.length) throw error;
  }
}

async function databaseQuerySnapshotWindow(
  db: DbRef,
  snapshotId: string,
  limit: number,
  after?: DatabaseRowsSnapshotBoundary,
) {
  const read = async (additional: Array<[string, string, unknown]>) => {
    let query: TableQuery<DatabaseQuerySnapshotRow> = db
      .table<DatabaseQuerySnapshotRow>('database_query_snapshot_rows')
      .where('snapshotId', '==', snapshotId);
    if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Database query snapshots require bounded ordered queries.'), { status: 500 });
    }
    for (const [field, op, value] of additional) {
      if (typeof query.where !== 'function') {
        throw Object.assign(new Error('Database query snapshots require bounded ordered queries.'), { status: 500 });
      }
      query = query.where(field, op, value);
    }
    if (typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Database query snapshots require bounded ordered queries.'), { status: 500 });
    }
    query = query.orderBy('sortKey', 'asc');
    if (typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Database query snapshots require bounded ordered queries.'), { status: 500 });
    }
    query = query.orderBy('id', 'asc');
    if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
    return (await query.limit(limit + 1).getList()).items ?? [];
  };
  const candidates = after
    ? (await Promise.all([
        read([['sortKey', '>', after.sortKey]]),
        read([['sortKey', '==', after.sortKey], ['id', '>', after.id]]),
      ])).flat()
    : await read([]);
  const entries = Array.from(new Map(candidates.map((entry) => [entry.id, entry])).values())
    .filter((entry) => (
      entry.snapshotId === snapshotId
      && (!after || entry.sortKey > after.sortKey || (entry.sortKey === after.sortKey && entry.id > after.id))
    ))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.id.localeCompare(right.id));
  const accepted = entries.slice(0, limit);
  if (accepted.length === 0) {
    return {
      rows: [] as Page[],
      hasMore: false,
      boundary: undefined,
    };
  }
  const sourceRows = (await mapLimit(
    chunksOf(accepted.map((entry) => entry.rowId), DATABASE_QUERY_SNAPSHOT_IN_CHUNK_SIZE),
    DATABASE_QUERY_SNAPSHOT_IN_CONCURRENCY,
    async (ids) => await listAll(
      db.table<Page>('pages').where('id', 'in', ids),
      {
        maxItems: ids.length,
        pageSize: ids.length,
        label: 'Database query snapshot page rows',
      },
    ),
  )).flat();
  const pagesById = new Map(sourceRows.map((row) => [row.id, row]));
  return {
    rows: accepted.map((entry) => pagesById.get(entry.rowId)).filter((row): row is Page => !!row),
    hasMore: entries.length > limit,
    boundary: accepted.length > 0
      ? { sortKey: accepted.at(-1)!.sortKey, id: accepted.at(-1)!.id }
      : undefined,
  };
}

async function databaseRows(
  db: DbRef,
  databaseId: string,
  actorId: string,
  options: {
    includeComputed?: boolean;
    includeRelationTargets?: boolean;
    includeTrash?: boolean;
    actorEmail?: string | null;
    limit?: number;
    offset?: number;
    cursor?: string;
    viewId?: string;
    search?: string;
    currentPageId?: string;
    includeSearchRevision?: boolean;
    timeZone?: string;
    sorts?: DatabaseRowsRequestedSort[];
    cursorScope?: string;
    rowId?: string;
    subitemParentId?: string;
    env?: Record<string, unknown>;
  } = {},
) {
  const database = await getPageForActor(db, databaseId, actorId, { actorEmail: options.actorEmail });
  if (database.kind !== 'database') throw new Error('Page is not a database.');
  const linkedSource = await resolveImportedLinkedDatabaseSource(db, database, actorId, options.actorEmail);
  const rowDatabaseId = linkedSource?.sourceDatabase.id ?? databaseId;
  const featureOwner = linkedSource?.sourceDatabase ?? database;
  await assertDependencyDateShiftReadable(db, rowDatabaseId, featureOwner);
  const pageLimit = options.limit ?? DATABASE_ROWS_DEFAULT_LIMIT;
  if (options.subitemParentId !== undefined) {
    const features = recordObject(featureOwner.databaseFeatures);
    const binding = recordObject(features?.subitems);
    if (
      binding?.enabled !== true
      || typeof binding.parentPropertyId !== 'string'
      || !binding.parentPropertyId.trim()
      || typeof binding.childrenPropertyId !== 'string'
      || !binding.childrenPropertyId.trim()
    ) {
      throw Object.assign(new Error('Sub-item hierarchy is not enabled for this database.'), { status: 409 });
    }
    if (options.includeTrash) {
      throw Object.assign(new Error('Sub-item hierarchy reads cannot include trash.'), { status: 400 });
    }
    if ((options.offset ?? 0) > 0) {
      throw Object.assign(new Error('Sub-item hierarchy reads require cursor pagination.'), { status: 400 });
    }
    const lifecycleQuery = db
      .table<{ id: string; databaseId: string }>('database_hierarchy_lifecycle_jobs')
      .where('databaseId', '==', rowDatabaseId);
    const activeLifecycle = (await lifecycleQuery.limit(1).getList()).items?.[0];
    if (activeLifecycle) {
      throw Object.assign(
        new Error('Sub-item hierarchy lifecycle is in progress; retry this read.'),
        { status: 409 },
      );
    }
  }
  if (options.rowId && (
    options.cursor
    || options.viewId
    || options.search
    || options.sorts
    || (options.offset ?? 0) > 0
  )) {
    throw Object.assign(new Error('A targeted database row read cannot be combined with query pagination.'), { status: 400 });
  }

  let propertiesForQuery: DbProperty[] | undefined;
  let propsByDbForQuery: Map<string, DbProperty[]> | undefined;
  let pagesByIdForQuery: Map<string, Page> | undefined;
  let propertyIndexesForQuery: DbPropertyIndex[] | undefined;
  const settledDependencyPageIds = new Set<string>();
  const dependencyPageIds = new Set<string>();

  async function loadCurrentProperties() {
    if (propertiesForQuery) return propertiesForQuery;
    propertiesForQuery = (await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', rowDatabaseId)))
      .sort(bySortPos);
    if (options.sorts?.some((sort) => sort.propertyId === DATABASE_ROWS_CREATED_TIME_SORT_ID)) {
      propertiesForQuery.push({
        id: DATABASE_ROWS_CREATED_TIME_SORT_ID,
        databaseId: rowDatabaseId,
        name: 'Created time',
        type: 'created_time',
        position: Number.MAX_SAFE_INTEGER - 1,
      });
    }
    if (options.sorts?.some((sort) => sort.propertyId === DATABASE_ROWS_LAST_EDITED_TIME_SORT_ID)) {
      propertiesForQuery.push({
        id: DATABASE_ROWS_LAST_EDITED_TIME_SORT_ID,
        databaseId: rowDatabaseId,
        name: 'Last edited time',
        type: 'last_edited_time',
        position: Number.MAX_SAFE_INTEGER,
      });
    }
    return propertiesForQuery;
  }

  let selectedView: DbView | undefined;
  if (options.viewId) {
    const properties = await loadCurrentProperties();
    const propsById = new Map(properties.map((prop) => [prop.id, prop]));
    const rawViews = linkedSource
      ? await addImportedLinkedDatabaseContextFiltersForRead(
          db,
          linkedSource,
          properties,
          addInferredImportedViewNameFiltersForRead(properties, linkedSource.views),
        )
      : addInferredImportedViewNameFiltersForRead(
          properties,
          await listAll(db.table<DbView>('db_views').where('databaseId', '==', rowDatabaseId)),
        );
    selectedView = rawViews.sort(bySortPos).find((item) => item.id === options.viewId);
    if (viewNeedsRelationFilterRemap(selectedView, propsById)) {
      selectedView = (await remapImportedViewRelationFiltersForRead(
        db,
        database.workspaceId,
        properties,
        [selectedView as DbView],
      ))[0];
      selectedView = addInferredImportedViewNameFiltersForRead(
        properties,
        selectedView ? [selectedView] : [],
      )[0];
    }
  }
  if (options.sorts) {
    if (options.viewId) {
      throw Object.assign(new Error('databaseRowsSorts cannot be combined with viewId.'), { status: 400 });
    }
    const propertyIds = new Set((await loadCurrentProperties()).map((property) => property.id));
    if (options.sorts.some((sort) => !propertyIds.has(sort.propertyId))) {
      throw Object.assign(new Error('databaseRowsSorts references an unknown property.'), { status: 400 });
    }
    selectedView = {
      id: '__hanji_database_rows_requested_sort',
      databaseId: rowDatabaseId,
      name: 'Requested sort',
      type: 'table',
      position: 0,
      config: { sorts: options.sorts },
    };
  }

  const hasCustomSort = databaseViewHasSorts(selectedView);
  const snapshotSource = linkedSource?.sourceDatabase ?? database;
  const snapshotSourceProperties = recordValue(snapshotSource.properties);
  const importedOrderJobId = typeof snapshotSource.notionImportJobId === 'string' && snapshotSource.notionImportJobId
    ? snapshotSource.notionImportJobId
    : typeof snapshotSourceProperties?.notionImportJobId === 'string'
      ? snapshotSourceProperties.notionImportJobId
      : undefined;
  const requiresOrderedSnapshot = !options.rowId && (hasCustomSort || importedOrderJobId !== undefined);
  const boundedSourceEligible = (options.offset ?? 0) === 0;
  const fingerprintProperties = viewQueryNeedsContext(selectedView, options.search)
    ? await loadCurrentProperties()
    : [];
  const cursorFingerprint = boundedSourceEligible
    ? await searchRequestFingerprint({
        v: 1,
        kind: 'databaseRows',
        actorId,
        databaseId,
        rowDatabaseId,
        includeTrash: options.includeTrash === true,
        includeComputed: options.includeComputed === true,
        includeRelationTargets: options.includeRelationTargets === true,
        viewId: options.viewId ?? null,
        search: (options.search ?? '').trim(),
        currentPageId: options.currentPageId ?? null,
        timeZone: options.timeZone ?? null,
        importedOrderJobId: importedOrderJobId ?? null,
        cursorScope: options.cursorScope ?? null,
        rowId: options.rowId ?? null,
        subitemParentId: options.subitemParentId ?? null,
        view: selectedView ?? null,
        properties: fingerprintProperties,
      })
    : undefined;
  if (options.cursor && !boundedSourceEligible) {
    throw databaseRowsCursorError('cannot continue an unbounded query plan.');
  }
  const cursorState = options.cursor
    ? parseDatabaseRowsCursorState(
        await decodeSearchSourceCursor(options.cursor, options.env),
        cursorFingerprint!,
      )
    : undefined;
  if (cursorState?.phase === 'snapshot' && !requiresOrderedSnapshot) {
    throw databaseRowsCursorError('contains an unexpected sorted snapshot.');
  }
  if (cursorState?.phase === 'source' && requiresOrderedSnapshot && !cursorState.snapshotId) {
    throw databaseRowsCursorError('is missing its sorted snapshot.');
  }
  if (cursorState?.phase === 'source' && !requiresOrderedSnapshot && cursorState.snapshotId) {
    throw databaseRowsCursorError('contains an unexpected sorted snapshot.');
  }

  let snapshotId: string | undefined;
  if (requiresOrderedSnapshot && cursorState?.snapshotId) {
    snapshotId = (await requireDatabaseQuerySnapshot(
      db,
      cursorState.snapshotId,
      database,
      actorId,
      cursorFingerprint!,
    )).id;
  } else if (requiresOrderedSnapshot && boundedSourceEligible) {
    snapshotId = (await createDatabaseQuerySnapshot(
      db,
      database,
      actorId,
      cursorFingerprint!,
    )).id;
  }

  const targetedRow = options.rowId
    ? await getExisting(db.table<Page>('pages'), options.rowId)
    : null;
  const sourceWindow = options.rowId
    ? {
        rows: targetedRow
          && targetedRow.parentId === rowDatabaseId
          && targetedRow.parentType === 'database'
          && (
            options.subitemParentId === undefined
            || (targetedRow.subitemParentId ?? '') === options.subitemParentId
          )
          && (options.includeTrash || !targetedRow.inTrash)
          ? [targetedRow]
          : [],
        hasMore: false,
        boundary: undefined,
      }
    : boundedSourceEligible && cursorState?.phase !== 'snapshot'
      ? await boundedDatabaseRowsWindow(
          db,
          rowDatabaseId,
          options.includeTrash === true,
          requiresOrderedSnapshot ? DATABASE_ROWS_DEFAULT_LIMIT : pageLimit,
          cursorState?.phase === 'source' ? cursorState.after : undefined,
          options.subitemParentId,
        )
      : undefined;
  let snapshotBoundary: DatabaseRowsSnapshotBoundary | undefined;
  if (cursorState?.phase === 'snapshot') {
    const boundaryEntry = await getExisting(
      db.table<DatabaseQuerySnapshotRow>('database_query_snapshot_rows'),
      cursorState.after.id,
    );
    if (!boundaryEntry || boundaryEntry.snapshotId !== snapshotId) {
      throw databaseRowsCursorError('snapshot boundary is missing or mismatched.');
    }
    snapshotBoundary = { sortKey: boundaryEntry.sortKey, id: boundaryEntry.id };
  }
  let snapshotWindow = cursorState?.phase === 'snapshot'
    ? await databaseQuerySnapshotWindow(db, snapshotId!, pageLimit, snapshotBoundary)
    : undefined;
  const readingSnapshot = snapshotWindow !== undefined;
  const sourceRows = (snapshotWindow?.rows
    ?? sourceWindow?.rows
    ?? await listAll(db.table<Page>('pages').where('parentId', '==', rowDatabaseId)))
    .filter((row) => (
      row.parentType === 'database'
      && (options.includeTrash || !row.inTrash)
      && (
        options.subitemParentId === undefined
        || (row.subitemParentId ?? '') === options.subitemParentId
      )
    ))
    .map(projectPageImportTimestamps);
  const accessDecisions = await pageAccessDecisions(
    db,
    sourceRows,
    actorId,
    undefined,
    options.actorEmail,
    { knownPages: [featureOwner] },
  );
  const preserveRestrictedHierarchy = databaseRowsPreserveRestrictedHierarchy(
    selectedView,
    options.subitemParentId,
  );
  const rawRows = sourceRows
    .flatMap((row) => {
      if (accessDecisions.get(row.id)?.role) return [row];
      if (
        preserveRestrictedHierarchy
        && Number.isSafeInteger(row.subitemChildCount)
        && (row.subitemChildCount ?? 0) > 0
      ) {
        return [databaseStructuralPlaceholder(row)];
      }
      return [];
    })
    .map((row) => ({
      ...row,
      ...(linkedSource ? { parentId: databaseId, parentType: 'database' as const } : {}),
    }));
  let rows: Page[];
  let importedOrderByRowId = new Map<string, number>();
  if (readingSnapshot) {
    rows = rawRows;
  } else {
    const importedOrder = await importedDatabaseRowOrdering(db, database.workspaceId, rawRows);
    importedOrderByRowId = importedOrder.orderByRowId;
    // Materialized once: iterating the map values per row is O(rows²).
    const canonicalRowIds = new Set(importedOrder.canonicalRowIdByNotionId.values());
    rows = rawRows
      .filter((row) => canonicalRowIds.has(row.id) || !importedOrder.orderByRowId.has(row.id))
      .sort((a, b) => {
        const aImported = importedOrder.orderByRowId.get(a.id);
        const bImported = importedOrder.orderByRowId.get(b.id);
        return (
          (aImported ?? Number.MAX_SAFE_INTEGER) - (bImported ?? Number.MAX_SAFE_INTEGER)
          || compareDatabaseRowBoundary(a, b)
        );
      });
  }
  const unfilteredRows = rows;

  async function loadPropertyIndexMap(properties: DbProperty[]) {
    if (!propertyIndexesForQuery) {
      const rowsForIndex = linkedSource
        ? unfilteredRows.map((row) => ({ ...row, parentId: rowDatabaseId, parentType: 'database' as const }))
        : unfilteredRows;
      propertyIndexesForQuery = await ensureDatabasePropertyIndexes(
        db,
        { id: rowDatabaseId, workspaceId: database.workspaceId },
        rowsForIndex,
        properties,
      ).catch(() => []);
    }
    return databasePropertyIndexMap(propertyIndexesForQuery);
  }

  async function loadQueryContext(
    relevantProperties: DbProperty[],
    dependencyRows: Page[],
    contextOptions: { includePropertyIndex?: boolean } = {},
  ) {
    const properties = await loadCurrentProperties();
    if (!propsByDbForQuery) {
      propsByDbForQuery = new Map<string, DbProperty[]>();
      propsByDbForQuery.set(rowDatabaseId, properties);
      propsByDbForQuery.set(databaseId, properties);
    }
    if (!pagesByIdForQuery) {
      pagesByIdForQuery = new Map<string, Page>();
      for (const row of unfilteredRows) pagesByIdForQuery.set(row.id, row);
    }

    const requirements = await loadComputedContextRequirements(
      db,
      relevantProperties,
      propsByDbForQuery,
    );
    const requiredRelations = new Set(
      Array.from(requirements.relationPropsByDatabaseId.values()).flat(),
    );
    const currentRelations = properties.filter((property) => requiredRelations.has(property));
    for (const alias of new Set([rowDatabaseId, databaseId])) {
      const existing = requirements.relationPropsByDatabaseId.get(alias) ?? [];
      requirements.relationPropsByDatabaseId.set(
        alias,
        Array.from(new Map([...existing, ...currentRelations].map((property) => [property.id, property])).values()),
      );
    }
    if (requirements.relationPropsByDatabaseId.size > 0 && dependencyRows.length > 0) {
      await loadComputedDependencyPages(
        db,
        dependencyRows.map((page) => ({ page, databaseId: rowDatabaseId })),
        requirements.relationPropsByDatabaseId,
        pagesByIdForQuery,
        settledDependencyPageIds,
        dependencyPageIds,
        actorId,
        options.actorEmail,
      );
    }

    return {
      properties,
      propsByDb: propsByDbForQuery,
      pagesById: pagesByIdForQuery,
      ...(contextOptions.includePropertyIndex
        ? { propertyIndexByKey: await loadPropertyIndexMap(properties) }
        : {}),
    };
  }

  let evaluatedQueryContext: DatabaseRowsQueryContext | undefined;
  let evaluatedProperties: DbProperty[] | undefined;
  if (!readingSnapshot && viewQueryNeedsContext(selectedView, options.search)) {
    const properties = await loadCurrentProperties();
    const queryContext = await loadQueryContext(
      viewQueryDependencyProperties(selectedView, properties, options.search),
      rows,
      { includePropertyIndex: sourceWindow === undefined },
    );
    evaluatedProperties = properties;
    evaluatedQueryContext = {
      props: properties,
      propsByDb: queryContext.propsByDb,
      pagesById: queryContext.pagesById,
      propertyIndexByKey: queryContext.propertyIndexByKey,
      currentPageId: options.currentPageId,
      timeZone: options.timeZone,
    };
    const queryRows = rows.filter((row) => row.__structuralPlaceholder !== true);
    const acceptedRowIds = new Set(applyDatabaseViewQuery(
      queryRows,
      properties,
      selectedView,
      evaluatedQueryContext,
      options.search,
    ).map((row) => row.id));
    rows = rows.filter((row) => (
      row.__structuralPlaceholder === true || acceptedRowIds.has(row.id)
    ));
  }

  const buildingOrderedSnapshot = requiresOrderedSnapshot && sourceWindow?.hasMore === true;
  if (requiresOrderedSnapshot && sourceWindow) {
    if (
      !snapshotId
      || (hasCustomSort && (!selectedView || !evaluatedProperties || !evaluatedQueryContext))
    ) {
      throw Object.assign(new Error('Database ordered snapshot context is incomplete.'), { status: 500 });
    }
    await writeDatabaseQuerySnapshotRows(
      db,
      snapshotId,
      rows,
      (row) => databaseSnapshotSortKey(
        row,
        selectedView,
        evaluatedProperties ?? [],
        evaluatedQueryContext,
        importedOrderByRowId.get(row.id),
      ),
    );
    if (buildingOrderedSnapshot) {
      rows = [];
    } else {
      snapshotWindow = await databaseQuerySnapshotWindow(db, snapshotId, pageLimit);
      rows = snapshotWindow.rows
        .filter((row) => row.parentType === 'database' && (options.includeTrash || !row.inTrash))
        .map((row) => ({
          ...projectPageImportTimestamps(row),
          ...(linkedSource ? { parentId: databaseId, parentType: 'database' as const } : {}),
        }));
    }
  }

  const boundedRowsPlan = sourceWindow !== undefined || snapshotWindow !== undefined;
  const totalCount = boundedRowsPlan ? undefined : rows.length;
  let revision = options.includeSearchRevision
    ? await searchSnapshotRevision(rows.map((row) => ({
        id: row.id,
        title: row.title ?? '',
        position: row.position ?? 0,
        updatedAt: row.updatedAt ?? row.createdAt ?? null,
        properties: row.properties ?? {},
      })))
    : null;
  const offset = boundedRowsPlan ? 0 : Math.min(options.offset ?? 0, totalCount!);
  const shouldPage = boundedRowsPlan || options.limit !== undefined || offset > 0;
  const pagedRows = boundedRowsPlan
    ? rows.slice(0, pageLimit)
    : shouldPage
      ? rows.slice(offset, options.limit === undefined ? undefined : offset + options.limit)
      : rows;
  const contentRows = pagedRows.filter((row) => row.__structuralPlaceholder !== true);
  const relationTargets = options.includeRelationTargets
    ? await relatedPagesForRows(db, contentRows, await loadCurrentProperties(), actorId, options.actorEmail)
    : { pages: [], targetIds: [] };
  const nextOffset = !boundedRowsPlan && shouldPage && offset + pagedRows.length < totalCount!
    ? offset + pagedRows.length
    : undefined;
  let nextCursorState: DatabaseRowsCursorState | undefined;
  if (buildingOrderedSnapshot) {
    if (!sourceWindow?.boundary || !snapshotId) {
      throw Object.assign(new Error('Database sorted snapshot cursor did not advance.'), { status: 500 });
    }
    nextCursorState = {
      v: 1,
      kind: 'databaseRows',
      fingerprint: cursorFingerprint!,
      phase: 'source',
      snapshotId,
      after: sourceWindow.boundary,
    };
  } else if (snapshotWindow?.hasMore) {
    if (!snapshotWindow.boundary || !snapshotId) {
      throw Object.assign(new Error('Database sorted snapshot cursor did not advance.'), { status: 500 });
    }
    nextCursorState = {
      v: 1,
      kind: 'databaseRows',
      fingerprint: cursorFingerprint!,
      phase: 'snapshot',
      snapshotId,
      after: { id: snapshotWindow.boundary.id },
    };
  } else if (sourceWindow?.hasMore) {
    if (!sourceWindow.boundary) {
      throw Object.assign(new Error('Database row cursor did not advance.'), { status: 500 });
    }
    nextCursorState = {
      v: 1,
      kind: 'databaseRows',
      fingerprint: cursorFingerprint!,
      phase: 'source',
      after: sourceWindow.boundary,
    };
  }
  const nextCursor = nextCursorState
    ? await encodeSearchSourceCursor(nextCursorState, options.env)
    : undefined;
  if (requiresOrderedSnapshot && snapshotWindow && !nextCursor && snapshotId) {
    await deleteDatabaseQuerySnapshot(db, snapshotId);
  }
  const baseResult = {
    databaseId,
    rows: pagedRows.map(projectDatabaseRowForWire),
    ...(options.includeRelationTargets
      ? {
          relatedPages: relationTargets.pages,
          relationTargetIds: relationTargets.targetIds,
        }
      : {}),
    ...(boundedRowsPlan ? {} : { offset }),
    limit: pageLimit,
    ...(totalCount === undefined ? {} : { totalCount }),
    hasMore: boundedRowsPlan ? nextCursor !== undefined : nextOffset !== undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(options.includeSearchRevision ? { revision } : {}),
  };
  if (!options.includeComputed) return baseResult;
  const computedRows = (options.includeSearchRevision ? rows : pagedRows)
    .filter((row) => row.__structuralPlaceholder !== true);
  const currentProperties = await loadCurrentProperties();
  const { properties, propsByDb, pagesById } = await loadQueryContext(
    currentProperties.filter((property) => property.type === 'formula' || property.type === 'rollup'),
    computedRows,
  );
  for (const row of contentRows) pagesById.set(row.id, row);
  const allComputed = computedPropertyValues(computedRows, properties, propsByDb, pagesById) ?? {};
  const computed = Object.fromEntries(
    contentRows
      .filter((row) => allComputed[row.id] !== undefined)
      .map((row) => [row.id, allComputed[row.id]]),
  );
  if (options.includeSearchRevision) {
    revision = await searchSnapshotRevision(
      databaseRowsSearchRevisionInput(rows, propsByDb, pagesById, allComputed),
    );
  }

  return {
    ...baseResult,
    ...(options.includeSearchRevision ? { revision } : {}),
    computed,
  };
}

type DatabaseDependencyDirection = 'predecessors' | 'successors';

function databaseDependencyDirection(value: unknown): DatabaseDependencyDirection {
  if (value === 'predecessors' || value === 'successors') return value;
  throw Object.assign(
    new Error('Dependency direction must be predecessors or successors.'),
    { status: 400 },
  );
}

function databaseDependencyCursor(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) {
    throw Object.assign(new Error('Dependency cursor is malformed.'), { status: 400 });
  }
  return value.trim();
}

function databaseDependencyPropertyId(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) {
    throw Object.assign(new Error('Dependency property id is malformed.'), { status: 400 });
  }
  return value.trim();
}

function expectedDatabaseDependencyRevision(value: unknown, cursor?: string) {
  if (!cursor && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw Object.assign(
      new Error('Dependency continuation requires an expected dependency revision.'),
      { status: 400 },
    );
  }
  return Number(value);
}

function databaseDependencyVisibleRowIds(value: unknown) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > DATABASE_DEPENDENCY_GRAPH_VISIBLE_ROW_LIMIT
  ) {
    throw Object.assign(
      new Error('Dependency graph visible row IDs must contain 1 to 100 rows.'),
      { status: 400 },
    );
  }
  const ids = value.map((candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.trim().length > 256) {
      throw Object.assign(new Error('Dependency graph visible row IDs are malformed.'), { status: 400 });
    }
    return candidate.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('Dependency graph visible row IDs contain duplicates.'), { status: 400 });
  }
  return ids.sort((left, right) => left.localeCompare(right));
}

type DatabaseDependencyGraphCursor = {
  v: 1;
  kind: 'databaseDependencyGraph';
  fingerprint: string;
  after: {
    predecessorRowId: string;
    successorRowId: string;
  };
};

function dependencyGraphCursorError(message: string) {
  return Object.assign(new Error(`Dependency graph cursor ${message}`), { status: 400 });
}

async function parseDatabaseDependencyGraphCursor(
  value: unknown,
  fingerprint: string,
  visibleRowIds: ReadonlySet<string>,
  env?: Record<string, unknown>,
): Promise<DatabaseDependencyGraphCursor | undefined> {
  if (value === undefined || value === null) return undefined;
  let decoded: unknown;
  try {
    decoded = await decodeSearchSourceCursor(value, env);
  } catch (error) {
    const record = error && typeof error === 'object'
      ? error as { code?: unknown; status?: unknown }
      : undefined;
    if (Number(record?.status ?? record?.code) === 400) {
      throw dependencyGraphCursorError('is malformed.');
    }
    throw error;
  }
  if (!isPlainRecord(decoded)) throw dependencyGraphCursorError('is malformed.');
  const allowed = new Set(['v', 'kind', 'fingerprint', 'after']);
  if (
    Object.keys(decoded).some((key) => !allowed.has(key))
    || decoded.v !== 1
    || decoded.kind !== 'databaseDependencyGraph'
    || decoded.fingerprint !== fingerprint
    || !isPlainRecord(decoded.after)
    || Object.keys(decoded.after).some(
      (key) => key !== 'predecessorRowId' && key !== 'successorRowId',
    )
  ) {
    throw dependencyGraphCursorError('does not match this visible graph.');
  }
  const predecessorRowId = decoded.after.predecessorRowId;
  const successorRowId = decoded.after.successorRowId;
  if (
    typeof predecessorRowId !== 'string'
    || typeof successorRowId !== 'string'
    || !visibleRowIds.has(predecessorRowId)
    || !visibleRowIds.has(successorRowId)
  ) {
    throw dependencyGraphCursorError('boundary is malformed.');
  }
  return {
    v: 1,
    kind: 'databaseDependencyGraph',
    fingerprint,
    after: { predecessorRowId, successorRowId },
  };
}

function databaseDependencyBinding(database: Page, propertyId?: string) {
  const features = recordObject(database.databaseFeatures);
  const active = recordObject(features?.dependencies);
  const preserved = recordObject(features?.preservedTaskFeatures)?.dependencies;
  const preservedBindings = Array.isArray(preserved)
    ? preserved.map((value) => recordObject(value)).filter((value): value is Record<string, unknown> => !!value)
    : [];
  const binding = propertyId
    ? [active, ...preservedBindings].find((candidate) => {
        const predecessorPropertyId = typeof candidate?.predecessorPropertyId === 'string'
          ? candidate.predecessorPropertyId.trim()
          : '';
        const successorPropertyId = typeof candidate?.successorPropertyId === 'string'
          ? candidate.successorPropertyId.trim()
          : '';
        return propertyId === predecessorPropertyId || propertyId === successorPropertyId;
      })
    : active;
  const predecessorPropertyId = typeof binding?.predecessorPropertyId === 'string'
    ? binding.predecessorPropertyId.trim()
    : '';
  const successorPropertyId = typeof binding?.successorPropertyId === 'string'
    ? binding.successorPropertyId.trim()
    : '';
  const revision = Number(binding?.revision);
  const dataKey = typeof binding?.dataKey === 'string' ? binding.dataKey.trim() : '';
  const isActive = binding === active;
  if (
    (!propertyId && binding?.enabled !== true)
    || (propertyId && binding?.enabled !== (isActive ? true : false))
    || !predecessorPropertyId
    || !successorPropertyId
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) {
    throw Object.assign(
      new Error(propertyId
        ? 'The requested dependency property is not bound to this database.'
        : 'Dependencies are not enabled for this database.'),
      { status: 409 },
    );
  }
  return { predecessorPropertyId, successorPropertyId, revision, dataKey };
}

async function databaseDependencyEdges(
  db: DbRef,
  databaseId: string,
  rowId: string,
  actorId: string,
  options: {
    actorEmail?: string | null;
    cursor?: string;
    direction: DatabaseDependencyDirection;
    expectedRevision?: number;
    limit: number;
    propertyId?: string;
  },
) {
  const requestedDatabase = await getPageForActor(
    db,
    databaseId,
    actorId,
    { actorEmail: options.actorEmail },
  );
  if (requestedDatabase.kind !== 'database') throw new Error('Page is not a database.');
  const linkedSource = await resolveImportedLinkedDatabaseSource(
    db,
    requestedDatabase,
    actorId,
    options.actorEmail,
  );
  const featureOwner = linkedSource?.sourceDatabase ?? requestedDatabase;
  const rowDatabaseId = featureOwner.id;
  const binding = databaseDependencyBinding(featureOwner, options.propertyId);
  const selectedPropertyId = options.direction === 'predecessors'
    ? binding.predecessorPropertyId
    : binding.successorPropertyId;
  if (options.propertyId && options.propertyId !== selectedPropertyId) {
    throw Object.assign(
      new Error('The requested dependency property has the opposite direction.'),
      { status: 409 },
    );
  }
  if (
    options.expectedRevision !== undefined
    && options.expectedRevision !== binding.revision
  ) {
    throw Object.assign(
      new Error('Dependencies changed while the cursor was in use. Restart the read.'),
      { status: 409 },
    );
  }

  const row = await getPageForActor(db, rowId, actorId, { actorEmail: options.actorEmail });
  if (
    row.parentType !== 'database'
    || row.parentId !== rowDatabaseId
    || row.workspaceId !== featureOwner.workspaceId
  ) {
    throw new Error('Database row was not found.');
  }

  let query: TableQuery<DatabaseDependencyEdge> = db
    .table<DatabaseDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', rowDatabaseId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(
      new Error('Dependency relation reads require bounded edge keysets.'),
      { status: 500 },
    );
  }
  const rowField = options.direction === 'predecessors'
    ? 'successorRowId'
    : 'predecessorRowId';
  if (binding.dataKey) query = query.where!('dataKey', '==', binding.dataKey);
  query = query.where!(rowField, '==', row.id);
  if (options.cursor) query = query.where!('id', '>', options.cursor);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);

  const candidates = (
    await query.limit(options.limit + 1).getList()
  ).items ?? [];
  const edges = candidates
    .filter((edge) => (
      edge.databaseId === rowDatabaseId
      && (!binding.dataKey || edge.dataKey === binding.dataKey)
      && edge[rowField] === row.id
      && (!options.cursor || edge.id > options.cursor)
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  const page = edges.slice(0, options.limit);

  // The graph can change between the first binding read and the edge keyset.
  // This ordered same-key reread is a freshness fence, not mergeable fanout.
  const refreshedOwner = await getExisting(db.table<Page>('pages'), featureOwner.id);
  let refreshedBinding: ReturnType<typeof databaseDependencyBinding> | undefined;
  try {
    refreshedBinding = refreshedOwner
      ? databaseDependencyBinding(refreshedOwner, options.propertyId)
      : undefined;
  } catch {
    refreshedBinding = undefined;
  }
  if (
    refreshedBinding?.revision !== binding.revision
    || refreshedBinding.predecessorPropertyId !== binding.predecessorPropertyId
    || refreshedBinding.successorPropertyId !== binding.successorPropertyId
    || refreshedBinding.dataKey !== binding.dataKey
  ) {
    throw Object.assign(
      new Error('Dependencies changed while the cursor was in use. Restart the read.'),
      { status: 409 },
    );
  }

  const hasMore = edges.length > options.limit;
  const nextCursor = hasMore ? page.at(-1)?.id : undefined;
  return {
    databaseId,
    rowId: row.id,
    direction: options.direction,
    propertyId: selectedPropertyId,
    dependencyRevision: binding.revision,
    relatedRowIds: page.map((edge) => (
      options.direction === 'predecessors'
        ? edge.predecessorRowId
        : edge.successorRowId
    )),
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function compareDependencyGraphEdge(
  left: DatabaseDependencyEdge,
  right: DatabaseDependencyEdge,
) {
  return left.successorRowId.localeCompare(right.successorRowId)
    || left.predecessorRowId.localeCompare(right.predecessorRowId)
    || left.id.localeCompare(right.id);
}

function dependencyGraphEdgeAfter(
  edge: DatabaseDependencyEdge,
  after: DatabaseDependencyGraphCursor['after'] | undefined,
) {
  if (!after) return true;
  return edge.successorRowId > after.successorRowId
    || (
      edge.successorRowId === after.successorRowId
      && edge.predecessorRowId > after.predecessorRowId
    );
}

async function databaseDependencyGraph(
  db: DbRef,
  databaseId: string,
  visibleRowIds: string[],
  actorId: string,
  options: {
    actorEmail?: string | null;
    cursor?: unknown;
    env?: Record<string, unknown>;
    expectedRevision?: number;
    limit: number;
  },
) {
  const requestedDatabase = await getPageForActor(
    db,
    databaseId,
    actorId,
    { actorEmail: options.actorEmail },
  );
  if (requestedDatabase.kind !== 'database') throw new Error('Page is not a database.');
  const linkedSource = await resolveImportedLinkedDatabaseSource(
    db,
    requestedDatabase,
    actorId,
    options.actorEmail,
  );
  const featureOwner = linkedSource?.sourceDatabase ?? requestedDatabase;
  const rowDatabaseId = featureOwner.id;
  const binding = databaseDependencyBinding(featureOwner);
  if (
    options.expectedRevision !== undefined
    && options.expectedRevision !== binding.revision
  ) {
    throw Object.assign(
      new Error('Dependencies changed while the cursor was in use. Restart the read.'),
      { status: 409 },
    );
  }

  const visibleRows = await listAll(
    db.table<Page>('pages').where('id', 'in', visibleRowIds),
    {
      maxItems: visibleRowIds.length,
      pageSize: visibleRowIds.length,
      label: 'Dependency graph visible rows',
    },
  );
  if (
    visibleRows.length !== visibleRowIds.length
    || visibleRows.some((row) => (
      row.notionImportStaging === true
      || row.inTrash === true
      || row.workspaceId !== featureOwner.workspaceId
      || row.parentType !== 'database'
      || row.parentId !== rowDatabaseId
    ))
  ) {
    throw new Error('Database row was not found.');
  }

  const fingerprint = await searchRequestFingerprint({
    v: 1,
    kind: 'databaseDependencyGraph',
    actorId,
    databaseId,
    rowDatabaseId,
    dependencyRevision: binding.revision,
    dependencyDataKey: binding.dataKey,
    visibleRowIds,
  });
  const visibleRowIdSet = new Set(visibleRowIds);
  const cursor = await parseDatabaseDependencyGraphCursor(
    options.cursor,
    fingerprint,
    visibleRowIdSet,
    options.env,
  );

  let query: TableQuery<DatabaseDependencyEdge> = db
    .table<DatabaseDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', rowDatabaseId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(
      new Error('Dependency graph reads require bounded edge keysets.'),
      { status: 500 },
    );
  }
  if (binding.dataKey) query = query.where!('dataKey', '==', binding.dataKey);
  query = query
    .where!('successorRowId', 'in', visibleRowIds)
    .where!('predecessorRowId', 'in', visibleRowIds);
  if (cursor) query = query.where!('successorRowId', '>=', cursor.after.successorRowId);
  query = query
    .orderBy!('successorRowId', 'asc')
    .orderBy!('predecessorRowId', 'asc')
    .orderBy!('id', 'asc');
  if (typeof query.select === 'function') {
    query = query.select('id', 'databaseId', 'dataKey', 'predecessorRowId', 'successorRowId');
  }
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);

  // A continuation may reread the already-returned predecessor prefix for its
  // boundary successor. At most visibleRowIds.length - 1 valid pairs live in
  // that band, so limit + visible count always yields one honest next probe.
  const candidateLimit = options.limit + visibleRowIds.length;
  const candidates = (
    await query.limit(candidateLimit).getList()
  ).items ?? [];
  const edges = candidates
    .filter((edge) => (
      edge.databaseId === rowDatabaseId
      && (!binding.dataKey || edge.dataKey === binding.dataKey)
      && edge.predecessorRowId !== edge.successorRowId
      && visibleRowIdSet.has(edge.predecessorRowId)
      && visibleRowIdSet.has(edge.successorRowId)
      && dependencyGraphEdgeAfter(edge, cursor?.after)
    ))
    .sort(compareDependencyGraphEdge);
  const page = edges.slice(0, options.limit);

  const refreshedOwner = await getExisting(db.table<Page>('pages'), featureOwner.id);
  let refreshedRevision: number | undefined;
  try {
    refreshedRevision = refreshedOwner
      ? databaseDependencyBinding(refreshedOwner).revision
      : undefined;
  } catch {
    refreshedRevision = undefined;
  }
  if (refreshedRevision !== binding.revision) {
    throw Object.assign(
      new Error('Dependencies changed while the cursor was in use. Restart the read.'),
      { status: 409 },
    );
  }

  const hasMore = edges.length > options.limit;
  const boundary = hasMore ? page.at(-1) : undefined;
  const nextCursor = boundary
    ? await encodeSearchSourceCursor({
        v: 1,
        kind: 'databaseDependencyGraph',
        fingerprint,
        after: {
          predecessorRowId: boundary.predecessorRowId,
          successorRowId: boundary.successorRowId,
        },
      } satisfies DatabaseDependencyGraphCursor, options.env)
    : undefined;
  return {
    databaseId,
    dependencyRevision: binding.revision,
    edges: page.map((edge) => ({
      predecessorRowId: edge.predecessorRowId,
      successorRowId: edge.successorRowId,
    })),
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    visibleRowIds,
  };
}

const PAGE_READ_BATCH_ACTIONS = new Set([
  'page',
  'blocks',
  'backlinks',
  'comments',
  'database',
  'databaseDependencyEdges',
]);
const PAGE_READ_BATCH_MAX_ITEMS = 100;
const PAGE_READ_BATCH_MAX_BYTES = 256 * 1024;
const PAGE_READ_BATCH_CONCURRENCY = 4;
const PAGE_EMBEDDED_DATABASE_PREFETCH_MAX = 100;

function embeddedDatabaseReadHints(blocks: Block[]) {
  const hints = new Map<string, Set<string>>();
  for (const block of blocks) {
    if (block.type !== 'inline_database' && block.type !== 'child_database') continue;
    let content: Record<string, unknown> | undefined;
    if (typeof block.content === 'string') {
      try {
        content = recordObject(JSON.parse(block.content));
      } catch {
        content = undefined;
      }
    } else {
      content = recordObject(block.content);
    }
    const databaseId = typeof content?.childPageId === 'string' ? content.childPageId.trim() : '';
    if (!databaseId) continue;
    const viewIds = hints.get(databaseId) ?? new Set<string>();
    const configuredViewIds = [
      typeof content?.databaseViewId === 'string' ? content.databaseViewId : '',
      ...(Array.isArray(content?.databaseViewIds) ? content.databaseViewIds : []),
    ];
    for (const candidate of configuredViewIds) {
      if (typeof candidate !== 'string') continue;
      const viewId = candidate.trim();
      if (viewId) viewIds.add(viewId);
    }
    hints.set(databaseId, viewIds);
  }
  return hints;
}

async function embeddedDatabaseSnapshotsForBlocks(
  context: FunctionContext,
  blocks: Block[],
  skipDatabaseIds: ReadonlySet<string> = new Set(),
) {
  const { auth, admin } = context;
  if (!auth?.id) {
    throw Object.assign(new Error('Authentication required.'), { status: 401 });
  }
  const hints = Array.from(embeddedDatabaseReadHints(blocks))
    .filter(([databaseId]) => !skipDatabaseIds.has(databaseId));
  const selected = hints.slice(0, PAGE_EMBEDDED_DATABASE_PREFETCH_MAX);
  const snapshots = await mapLimit(selected, PAGE_READ_BATCH_CONCURRENCY, async ([databaseId, viewIds]) => {
    try {
      const db = await boundedDbFromPageHint(admin, undefined, undefined, databaseId);
      return await databaseSnapshot(db, databaseId, auth.id, auth.email ?? null, {
        includeViewIds: Array.from(viewIds),
      });
    } catch {
      // The block itself may be readable while a linked database is not. Keep
      // the page response useful and let an explicit database read surface its
      // own 403/404 instead of leaking metadata or failing the whole page.
      return null;
    }
  });
  const accepted = snapshots.filter((snapshot): snapshot is DatabaseSnapshotRead => snapshot !== null);
  const related = await relatedDatabaseSnapshotsForRoots(context, accepted, {
    limit: Math.max(0, PAGE_EMBEDDED_DATABASE_PREFETCH_MAX - accepted.length),
    skipDatabaseIds,
  });
  return {
    embeddedDatabases: [...accepted, ...related.snapshots],
    ...(hints.length > selected.length || related.truncated
      ? { embeddedDatabasesTruncated: true }
      : {}),
  };
}

function pageQueryError(error: unknown) {
  return errorStatus(error, [
    { status: 403, needles: ['access required'] },
    { status: 404, needles: ['not found', 'not a database', 'trash'] },
  ]);
}

async function executePageQuery(
  context: FunctionContext,
  body: Record<string, unknown>,
  options: { skipEmbeddedDatabaseIds?: ReadonlySet<string> } = {},
) {
  const { auth, admin } = context;
  if (!auth?.id) {
    throw Object.assign(new Error('Authentication required.'), { status: 401 });
  }
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'allBlocks') {
    throw Object.assign(new Error('Unknown page query action.'), { status: 400 });
  }
  const pageWorkspaceId = (
    action === 'pages'
    || action === 'searchPages'
    || action === 'searchBlocks'
    || action === 'backlinks'
  )
    ? requireString(body.workspaceId, 'workspaceId')
    : undefined;
  const actorEmail = auth.email ?? null;
  const timeZone = action === 'databaseRows' ? parseOptionalTimeZone(body.timeZone) : undefined;

  // Routing is deliberately resolved per logical read. A batch can mix pages
  // from different workspaces, and reusing the first item's bounded DB would
  // be a cross-workspace data leak.
  const workspaceHint = pageWorkspaceId ?? body.workspaceId;
  const db = workspaceHint
    ? boundedDbFromWorkspaceHint(admin, workspaceHint)
    : await boundedDbFromPageHint(admin, body.pageId, body.id, body.databaseId);
  switch (action) {
    case 'page':
      return await pageProjectionById(db, requireString(body.pageId, 'pageId'), auth.id, actorEmail);
    case 'pages':
      await assertWorkspaceDependencyDateShiftsReadable(db, pageWorkspaceId!);
      return await pagesProjection(
        db,
        { ...body, workspaceId: pageWorkspaceId },
        auth.id,
        actorEmail,
      );
    case 'searchPages':
      await assertWorkspaceDependencyDateShiftsReadable(db, pageWorkspaceId!);
      return await searchPages(
        db,
        { ...body, workspaceId: pageWorkspaceId },
        auth.id,
        actorEmail,
        context.env,
      );
    case 'blocks': {
      const result = await pageBlocks(db, requireString(body.pageId, 'pageId'), auth.id, actorEmail);
      if (!parseBoolean(body.includeEmbeddedDatabases)) return result;
      return {
        ...result,
        ...(await embeddedDatabaseSnapshotsForBlocks(
          context,
          result.blocks,
          options.skipEmbeddedDatabaseIds,
        )),
      };
    }
    case 'searchBlocks': {
      await assertWorkspaceDependencyDateShiftsReadable(db, pageWorkspaceId!);
      return await searchBlocks(
        db,
        { ...body, workspaceId: pageWorkspaceId },
        auth.id,
        actorEmail,
        context.env,
      );
    }
    case 'backlinks': {
      await assertWorkspaceDependencyDateShiftsReadable(db, pageWorkspaceId!);
      return await backlinks(
        db,
        { ...body, workspaceId: pageWorkspaceId },
        auth.id,
        actorEmail,
        context.env,
      );
    }
    case 'comments':
      return await pageComments(db, requireString(body.pageId, 'pageId'), auth.id, actorEmail);
    case 'comment':
      return await pageCommentById(db, requireString(body.commentId, 'commentId'), auth.id, actorEmail);
    case 'database': {
      const snapshot = await databaseSnapshot(
        db,
        requireString(body.databaseId, 'databaseId'),
        auth.id,
        actorEmail,
        {
          includeViewIds: uniqueStringArray(body.viewIds),
        },
      );
      if (!parseBoolean(body.includeRelatedDatabases)) return snapshot;
      const related = await relatedDatabaseSnapshotsForRoots(context, [snapshot], {
        skipDatabaseIds: options.skipEmbeddedDatabaseIds,
      });
      return {
        ...snapshot,
        relatedDatabases: related.snapshots,
        ...(related.truncated ? { relatedDatabasesTruncated: true } : {}),
      };
    }
    case 'databaseRows':
      return await databaseRows(
        db,
        requireString(body.databaseId, 'databaseId'),
        auth.id,
        {
          includeTrash: parseBoolean(body.includeTrash),
          includeComputed: parseBoolean(body.includeComputed),
          includeRelationTargets: parseBoolean(body.includeRelationTargets),
          actorEmail,
          limit: parseOptionalLimit(body.limit, 500),
          offset: parseOffset(body.offset),
          cursor: typeof body.cursor === 'string' && body.cursor.trim() ? body.cursor.trim() : undefined,
          viewId: typeof body.viewId === 'string' && body.viewId.trim() ? body.viewId.trim() : undefined,
          search: typeof body.search === 'string' ? body.search : undefined,
          currentPageId: typeof body.currentPageId === 'string' && body.currentPageId.trim()
            ? body.currentPageId.trim()
            : undefined,
          includeSearchRevision: parseBoolean(body.includeSearchRevision),
          timeZone,
          sorts: parseDatabaseRowsRequestedSorts(body.databaseRowsSorts),
          cursorScope: parseDatabaseRowsCursorScope(body.databaseRowsCursorScope),
          rowId: parseDatabaseRowsTargetId(body.rowId),
          subitemParentId: parseDatabaseRowsSubitemParentId(body.subitemParentId),
          env: context.env,
        },
      );
    case 'databaseDependencyEdges': {
      const cursor = databaseDependencyCursor(body.cursor);
      return await databaseDependencyEdges(
        db,
        requireString(body.databaseId, 'databaseId'),
        requireString(body.rowId, 'rowId'),
        auth.id,
        {
          actorEmail,
          cursor,
          direction: databaseDependencyDirection(body.direction),
          expectedRevision: expectedDatabaseDependencyRevision(
            body.expectedDependencyRevision,
            cursor,
          ),
          limit: parseLimit(body.limit, DATABASE_DEPENDENCY_EDGE_PAGE_SIZE, DATABASE_DEPENDENCY_EDGE_PAGE_SIZE),
          propertyId: databaseDependencyPropertyId(body.propertyId),
        },
      );
    }
    case 'databaseDependencyGraph': {
      const hasCursor = typeof body.cursor === 'string' && body.cursor.length > 0;
      return await databaseDependencyGraph(
        db,
        requireString(body.databaseId, 'databaseId'),
        databaseDependencyVisibleRowIds(body.visibleRowIds),
        auth.id,
        {
          actorEmail,
          cursor: body.cursor,
          env: context.env,
          expectedRevision: expectedDatabaseDependencyRevision(
            body.expectedDependencyRevision,
            hasCursor ? body.cursor as string : undefined,
          ),
          limit: parseLimit(
            body.limit,
            DATABASE_DEPENDENCY_GRAPH_PAGE_SIZE,
            DATABASE_DEPENDENCY_GRAPH_PAGE_SIZE,
          ),
        },
      );
    }
    default:
      throw Object.assign(new Error('Unknown page query action.'), { status: 400 });
  }
}

export const POST = defineFunction(async (context) => {
  const functionContext = context as FunctionContext;
  const { auth, request } = functionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'batch') {
    const requests = Array.isArray(body.requests) ? body.requests : null;
    if (!requests || requests.length === 0) {
      return jsonError(400, 'Page read batch must contain at least one request.');
    }
    if (requests.length > PAGE_READ_BATCH_MAX_ITEMS) {
      return jsonError(413, `Page read batch may contain at most ${PAGE_READ_BATCH_MAX_ITEMS} requests.`);
    }
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > PAGE_READ_BATCH_MAX_BYTES) {
      return jsonError(413, 'Page read batch payload is too large.');
    }
    const ids = new Set<string>();
    for (const candidate of requests) {
      const item = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id || id.length > 128 || ids.has(id)) {
        return jsonError(400, 'Page read batch request ids must be unique non-empty strings.');
      }
      ids.add(id);
    }
    const explicitDatabaseIds = new Set(
      requests.flatMap((candidate) => {
        const item = candidate as Record<string, unknown>;
        return item.action === 'database' && typeof item.databaseId === 'string' && item.databaseId.trim()
          ? [item.databaseId.trim()]
          : [];
      }),
    );
    const results = await mapLimit(requests, PAGE_READ_BATCH_CONCURRENCY, async (candidate) => {
      const item = candidate as Record<string, unknown>;
      const id = item.id as string;
      const itemAction = typeof item.action === 'string' ? item.action : '';
      if (!PAGE_READ_BATCH_ACTIONS.has(itemAction)) {
        return {
          id,
          ok: false as const,
          error: { message: 'This page query action cannot be batched.', status: 400 },
        };
      }
      try {
        // `id` belongs to the batch envelope. Never pass it into the legacy
        // page-query router, where `body.id` is also an entity routing hint.
        const { id: _batchRequestId, ...queryBody } = item;
        const data = await executePageQuery(functionContext, queryBody, {
          skipEmbeddedDatabaseIds: explicitDatabaseIds,
        });
        return { id, ok: true as const, data };
      } catch (error) {
        const { status, message } = pageQueryError(error);
        return { id, ok: false as const, error: { message, status } };
      }
    });
    return { results };
  }

  try {
    return await executePageQuery(functionContext, body);
  } catch (error) {
    const { status, message } = pageQueryError(error);
    const retryAfter = (
      error
      && typeof error === 'object'
      && typeof (error as { retryAfter?: unknown }).retryAfter === 'string'
    )
      ? (error as { retryAfter: string }).retryAfter
      : undefined;
    const responseMessage = status === 503 && retryAfter && error instanceof Error
      ? error.message
      : message;
    return jsonError(
      status,
      responseMessage,
      retryAfter ? { 'Retry-After': retryAfter } : undefined,
    );
  }
});
