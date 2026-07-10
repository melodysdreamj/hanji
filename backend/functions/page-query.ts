import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import {
  accessibleWorkspaceIdsForActor,
  boundedDb,
  boundedDbFromPageHint,
  boundedDbFromWorkspaceHint,
} from '../lib/workspace-db';
import { assertNotDeactivatedWorkspaceAccess } from '../lib/org-access';
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
  pageHasDirectAccess as sharedPageHasDirectAccess,
} from '../lib/page-access';
import {
  evaluateFormulaExpression,
  formatFormulaValue as formatFormulaCoreValue,
  type FormulaValue,
} from '../../shared/database/formula-core';
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

import {
  getExisting,
  listAll,
  listAllTruncated,
  requireString,
  type TableQuery,
  type TransactDb,
} from '../lib/table-utils';
import type {
  Block,
  Comment,
  DbProperty,
  DbTemplate,
  DbView,
  FunctionContext as AppFunctionContext,
  Page,
  PagePermission,
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

type FunctionContext = Omit<AppFunctionContext, 'admin'> & {
  admin: { db(namespace: string, instanceId?: string): DbRef };
};
const NOTION_CREATED_TIME_KEY = '__notionCreatedTime';
const NOTION_LAST_EDITED_TIME_KEY = '__notionLastEditedTime';
const TARGETED_IMPORT_ORDER_QUERY_LIMIT = 100;
const QUERY_FANOUT_LIMIT = 12;
const BLOCK_MATERIALIZATION_LIMIT = 20_000;
const CROSS_WORKSPACE_BLOCK_LIMIT = 25_000;

interface NotionImportItem {
  id: string;
  workspaceId: string;
  jobId: string;
  notionId: string;
  notionObject: string;
  title?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
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

function parseOptionalLimit(value: unknown, max: number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function parseOffset(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
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

  const rawMappings = rowIds.size <= TARGETED_IMPORT_ORDER_QUERY_LIMIT
    ? (await Promise.all(
        Array.from(rowIds, (localId) =>
          listAll(db.table<NotionImportMapping>('notion_import_mappings').where('localId', '==', localId))
        ),
      )).flat()
    : await listAll(
        db.table<NotionImportMapping>('notion_import_mappings').where('workspaceId', '==', workspaceId),
      );
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
    const neededNotionIds = new Set(jobMappings.map((mapping) => mapping.notionId));
    const rawImportItems = neededNotionIds.size <= TARGETED_IMPORT_ORDER_QUERY_LIMIT
      ? (await Promise.all(
          Array.from(neededNotionIds, (notionId) =>
            listAll(db.table<NotionImportItem>('notion_import_items').where('notionId', '==', notionId))
          ),
        )).flat()
      : await listAll(
          db.table<NotionImportItem>('notion_import_items').where('jobId', '==', jobId),
        );
    const importItems = rawImportItems
      .filter((item) => item.notionObject === 'page' && neededNotionIds.has(item.notionId));
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

async function accessibleWorkspaceIds(db: DbRef, actorId: string) {
  const [owned, memberships] = await Promise.all([
    listAll(db.table<Workspace>('workspaces').where('ownerId', '==', actorId)),
    listAll(db.table<WorkspaceMember>('workspace_members').where('userId', '==', actorId)),
  ]);

  const candidates = Array.from(
    new Set([
      ...owned.map((workspace) => workspace.id),
      ...memberships.map((membership) => membership.workspaceId),
    ]),
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

function collectSubtreeIds(pages: Page[], rootId: string) {
  const childrenByParent = new Map<string, Page[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const children = childrenByParent.get(page.parentId) ?? [];
    children.push(page);
    childrenByParent.set(page.parentId, children);
  }

  const out = new Set<string>();
  const visit = (pageId: string) => {
    if (out.has(pageId)) return;
    out.add(pageId);
    for (const child of childrenByParent.get(pageId) ?? []) visit(child.id);
  };
  visit(rootId);
  return out;
}

async function userPagePermissions(db: DbRef, actorId: string, actorEmail?: string | null) {
  const readable = await actorPagePermissions(db, actorId, undefined, actorEmail);
  const checked = await mapLimit(
    readable,
    QUERY_FANOUT_LIMIT,
    async (permission) => {
      try {
        await assertNotDeactivatedWorkspaceAccess(db, permission.workspaceId, actorId);
        return permission;
      } catch {
        // A deactivated org member should not regain access through direct page permissions.
        return undefined;
      }
    },
  );
  return checked.filter((permission): permission is PagePermission => !!permission);
}

async function canSeePage(
  db: DbRef,
  page: Page,
  actorId: string,
  workspaceIds?: Set<string>,
  actorEmail?: string | null,
) {
  await assertNotDeactivatedWorkspaceAccess(db, page.workspaceId, actorId);
  const accessibleWorkspaces = workspaceIds ?? new Set(await accessibleWorkspaceIds(db, actorId));
  if (accessibleWorkspaces.has(page.workspaceId)) return true;
  return sharedPageHasDirectAccess(db, page, actorId, actorEmail);
}

async function pagesForActor(
  db: DbRef,
  actorId: string,
  options: { includeTrash?: boolean; workspaceId?: string; actorEmail?: string | null } = {},
) {
  const workspaceIds = new Set(await accessibleWorkspaceIds(db, actorId));
  const permissions = await userPagePermissions(db, actorId, options.actorEmail);
  const targetWorkspaceIds = options.workspaceId
    ? new Set([options.workspaceId])
    : new Set([
        ...workspaceIds,
        ...permissions.map((permission) => permission.workspaceId),
      ]);
  const pagesById = new Map<string, Page>();
  const pagesTable = db.table<Page>('pages');
  const workspacePageGroups = await mapLimit(
    Array.from(targetWorkspaceIds),
    QUERY_FANOUT_LIMIT,
    async (workspaceId) => ({
      workspaceId,
      pages: await listAll(pagesTable.where('workspaceId', '==', workspaceId)),
    }),
  );
  for (const { workspaceId, pages: workspacePages } of workspacePageGroups) {
    if (workspaceIds.has(workspaceId)) {
      for (const page of workspacePages) pagesById.set(page.id, page);
      continue;
    }

    for (const permission of permissions.filter((item) => item.workspaceId === workspaceId)) {
      const visiblePageIds = collectSubtreeIds(workspacePages, permission.pageId);
      for (const page of workspacePages) {
        if (visiblePageIds.has(page.id)) pagesById.set(page.id, page);
      }
    }
  }

  if (options.workspaceId && !workspaceIds.has(options.workspaceId) && pagesById.size === 0) {
    throw new Error('Workspace access required.');
  }

  return Array.from(pagesById.values())
    .filter((page) => options.includeTrash || !page.inTrash)
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
  const record = recordObject(value);
  return record?.kind === 'notionlike.current_page';
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
    const value = computedWithImportedFallback(row, prop, evaluateFormula(row, prop, ctx.props));
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

function propertyNeedsFullQueryContext(prop: DbProperty | undefined) {
  return prop?.type === 'relation' || prop?.type === 'formula' || prop?.type === 'rollup';
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

function viewQueryNeedsFullContext(view: DbView | undefined, props: DbProperty[], searchInput?: string) {
  const search = (searchInput ?? (typeof view?.config?.search === 'string' ? view.config.search : '')).trim();
  if (search) return true;
  const propsById = new Map(props.map((prop) => [prop.id, prop]));
  const propertyIds = new Set<string>();
  collectViewQueryPropertyIds(view, propertyIds);
  for (const propertyId of propertyIds) {
    if (propertyNeedsFullQueryContext(propsById.get(propertyId))) return true;
  }
  return false;
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
  const search = (searchInput ?? (typeof view?.config?.search === 'string' ? view.config.search : '')).trim().toLowerCase();
  if (search) {
    out = out.filter((row) =>
      props.some((prop) => databaseDisplayText(row, prop, ctx).toLowerCase().includes(search))
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

const IMPORTED_ROW_CONTEXT_FILTER_MARKER = 'notionlikeImportedRowContextFilter';

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
  if (record[IMPORTED_ROW_CONTEXT_FILTER_MARKER] === true) return config;
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
    [IMPORTED_ROW_CONTEXT_FILTER_MARKER]: true,
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
  if (format === 'comma') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(n);
  if (format === 'percent') {
    return new Intl.NumberFormat(undefined, {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(n / 100);
  }
  if (format === 'won') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'KRW',
      maximumFractionDigits: 0,
    }).format(n);
  }
  return new Intl.NumberFormat(undefined, {
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

function propertyValue(row: Page, prop: DbProperty): FormulaValue {
  if (prop.type === 'title') return row.title ?? '';
  const value = row.properties?.[prop.id];
  if (value == null) return '';
  if (prop.type === 'number') return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (prop.type === 'checkbox') return value === true;
  if (prop.type === 'select' || prop.type === 'status') return selectOptionName(prop, value);
  if (prop.type === 'multi_select') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => selectOptionName(prop, item)).filter(Boolean).join(', ');
  }
  if (prop.type === 'date') {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const start = (value as { start?: unknown }).start;
      const end = (value as { end?: unknown }).end;
      if (typeof start === 'string' && typeof end === 'string' && end) return `${start}/${end}`;
      return typeof start === 'string' ? start : '';
    }
  }
  if (prop.type === 'formula' || prop.type === 'rollup') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function evaluateFormula(row: Page, prop: DbProperty, props: DbProperty[]): FormulaValue {
  const rawFormula = prop.config?.formula;
  const expression = typeof rawFormula === 'string' ? rawFormula.trim() : '';
  if (!expression) return '';
  return evaluateFormulaExpression(expression, (name) => {
    const target = props.find((item) => item.name === name || item.id === name);
    if (!target || target.id === prop.id) return '';
    return propertyValue(row, target);
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
    return formatFormulaValue(computedWithImportedFallback(row, prop, evaluateFormula(row, prop, props)));
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
          : evaluateFormula(row, prop, props);
      const value = computedWithImportedFallback(row, prop, evaluated);
      computed[row.id] = computed[row.id] ?? {};
      computed[row.id][prop.id] = { value, formatted: formatFormulaValue(value) };
    }
  }
  return computed;
}

function blockSearchText(block: Block): string {
  const content = block.content as { rich?: unknown; caption?: unknown; expression?: unknown; fileName?: unknown } | undefined;
  return [
    block.plainText,
    richTextText(content?.rich),
    richTextText(content?.caption),
    typeof content?.expression === 'string' ? content.expression : '',
    typeof content?.fileName === 'string' ? content.fileName : '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function pageBlocks(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  await getPageForActor(db, pageId, actorId, { actorEmail });
  const blocks = await listAll(db.table<Block>('blocks').where('pageId', '==', pageId));
  return { pageId, blocks: blocks.map(projectBlockImportTimestamps).sort(bySortPos) };
}

async function pageProjectionById(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  const page = await getPageForActor(db, pageId, actorId, { allowTrash: true, actorEmail });
  return { page };
}

async function allBlocks(db: DbRef, actorId: string, actorEmail?: string | null) {
  const pages = await pagesForActor(db, actorId, { actorEmail });
  const pageIds = new Set(pages.map((page) => page.id));
  // Backlinks/search degrade to a truncated result on >limit workspaces
  // instead of hard-failing the whole feature with a 413; the flag lets the
  // client label the result as partial.
  const { items, complete } = await listAllTruncated(db.table<Block>('blocks'), {
    maxItems: BLOCK_MATERIALIZATION_LIMIT,
    label: 'Workspace blocks',
  });
  const blocks = items.filter((block) => pageIds.has(block.pageId));
  return {
    blocks: blocks.map(projectBlockImportTimestamps).sort((a, b) => a.pageId.localeCompare(b.pageId) || bySortPos(a, b)),
    ...(complete ? {} : { truncated: true }),
  };
}

async function searchBlocks(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const query = requireString(body.query, 'query').toLowerCase();
  const limit = parseLimit(body.limit, 20, 100);
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim()
    ? body.workspaceId.trim()
    : undefined;
  const pages = await pagesForActor(db, actorId, { workspaceId, actorEmail });
  const pageIds = new Set(pages.map((page) => page.id));
  // Same degrade-to-partial contract as allBlocks.
  const { items, complete } = await listAllTruncated(db.table<Block>('blocks'), {
    maxItems: BLOCK_MATERIALIZATION_LIMIT,
    label: 'Workspace block search',
  });
  const blocks = items.filter((block) => pageIds.has(block.pageId));
  const matches = blocks
    .map((block) => ({ block, text: blockSearchText(block) }))
    .filter((item) => item.text.toLowerCase().includes(query))
    .sort((a, b) => {
      const aText = a.text.toLowerCase();
      const bText = b.text.toLowerCase();
      const aStarts = aText.startsWith(query) ? 0 : 1;
      const bStarts = bText.startsWith(query) ? 0 : 1;
      return aStarts - bStarts || bySortPos(a.block, b.block);
    })
    .slice(0, limit)
    .map((item) => projectBlockImportTimestamps(item.block));
  return { query, blocks: matches, ...(complete ? {} : { truncated: true }) };
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

async function searchPages(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const query = requireString(body.query, 'query').toLowerCase();
  const limit = parseLimit(body.limit, 20, 100);
  const includeTrash = parseBoolean(body.includeTrash);
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim()
    ? body.workspaceId.trim()
    : undefined;
  const pages = await pagesForActor(db, actorId, { includeTrash, workspaceId, actorEmail });
  const matches = pages
    .filter((page) => String(page.title ?? '').toLowerCase().includes(query))
    .sort((a, b) => {
      const aTitle = String(a.title ?? '').toLowerCase();
      const bTitle = String(b.title ?? '').toLowerCase();
      const aStarts = aTitle.startsWith(query) ? 0 : 1;
      const bStarts = bTitle.startsWith(query) ? 0 : 1;
      return aStarts - bStarts || aTitle.localeCompare(bTitle) || byPageOrder(a, b);
    })
    .slice(0, limit);
  return { query, pages: matches };
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
    viewId?: string;
    search?: string;
    currentPageId?: string;
  } = {},
) {
  const database = await getPageForActor(db, databaseId, actorId, { actorEmail: options.actorEmail });
  if (database.kind !== 'database') throw new Error('Page is not a database.');
  const linkedSource = await resolveImportedLinkedDatabaseSource(db, database, actorId, options.actorEmail);
  const rowDatabaseId = linkedSource?.sourceDatabase.id ?? databaseId;
  const rawRows = (await listAll(db.table<Page>('pages').where('parentId', '==', rowDatabaseId)))
    .filter((row) => row.parentType === 'database' && (options.includeTrash || !row.inTrash))
    .map((row) => ({
      ...projectPageImportTimestamps(row),
      ...(linkedSource ? { parentId: databaseId, parentType: 'database' as const } : {}),
    }));
  const importedOrder = await importedDatabaseRowOrdering(db, database.workspaceId, rawRows);
  // Materialized once: iterating the map values per row is O(rows²).
  const canonicalRowIds = new Set(importedOrder.canonicalRowIdByNotionId.values());
  let rows = rawRows
    .filter((row) => canonicalRowIds.has(row.id) || !importedOrder.orderByRowId.has(row.id))
    .sort((a, b) => {
      const aImported = importedOrder.orderByRowId.get(a.id);
      const bImported = importedOrder.orderByRowId.get(b.id);
      if (aImported !== undefined || bImported !== undefined) {
        return (
          (aImported ?? Number.MAX_SAFE_INTEGER) - (bImported ?? Number.MAX_SAFE_INTEGER) ||
          (a.position ?? 0) - (b.position ?? 0) ||
          String(a.title ?? '').localeCompare(String(b.title ?? ''))
        );
      }
      return (a.position ?? 0) - (b.position ?? 0) || String(a.title ?? '').localeCompare(String(b.title ?? ''));
    });

  let propertiesForQuery: DbProperty[] | undefined;
  let propsByDbForQuery: Map<string, DbProperty[]> | undefined;
  let pagesByIdForQuery: Map<string, Page> | undefined;
  let propertyIndexesForQuery: DbPropertyIndex[] | undefined;

  async function loadCurrentProperties() {
    if (propertiesForQuery) return propertiesForQuery;
    propertiesForQuery = (await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', rowDatabaseId)))
      .sort(bySortPos);
    return propertiesForQuery;
  }

  async function loadPropertyIndexMap(properties: DbProperty[]) {
    if (!propertyIndexesForQuery) {
      const rowsForIndex = linkedSource
        ? rows.map((row) => ({ ...row, parentId: rowDatabaseId, parentType: 'database' as const }))
        : rows;
      propertyIndexesForQuery = await ensureDatabasePropertyIndexes(
        db,
        { id: rowDatabaseId, workspaceId: database.workspaceId },
        rowsForIndex,
        properties,
      ).catch(() => []);
    }
    return databasePropertyIndexMap(propertyIndexesForQuery);
  }

  async function rowsOnlyQueryContext(properties: DbProperty[]) {
    const propsByDb = new Map<string, DbProperty[]>();
    propsByDb.set(rowDatabaseId, properties);
    propsByDb.set(databaseId, properties);
    const pagesById = new Map<string, Page>();
    for (const row of rows) pagesById.set(row.id, row);
    return { properties, propsByDb, pagesById, propertyIndexByKey: await loadPropertyIndexMap(properties) };
  }

  async function loadFullQueryContext() {
    if (propertiesForQuery && propsByDbForQuery && pagesByIdForQuery) {
      return {
        properties: propertiesForQuery,
        propsByDb: propsByDbForQuery,
        pagesById: pagesByIdForQuery,
      };
    }
    const properties = await loadCurrentProperties();
    const [accessiblePages, allProperties] = await Promise.all([
      pagesForActor(db, actorId, { actorEmail: options.actorEmail }),
      listAll(db.table<DbProperty>('db_properties')),
    ]);
    const propsByDb = new Map<string, DbProperty[]>();
    for (const prop of allProperties) {
      const items = propsByDb.get(prop.databaseId) ?? [];
      items.push(prop);
      propsByDb.set(prop.databaseId, items);
    }
    for (const items of propsByDb.values()) items.sort(bySortPos);
    propsByDb.set(rowDatabaseId, properties);
    propsByDb.set(databaseId, properties);

    const pagesById = new Map<string, Page>();
    for (const page of accessiblePages) pagesById.set(page.id, page);
    for (const row of rows) pagesById.set(row.id, row);

    propsByDbForQuery = propsByDb;
    pagesByIdForQuery = pagesById;
    return { properties, propsByDb, pagesById };
  }

  async function loadQueryContext(requireFullContext: boolean) {
    const properties = await loadCurrentProperties();
    if (!requireFullContext) return await rowsOnlyQueryContext(properties);
    const fullContext = await loadFullQueryContext();
    return {
      ...fullContext,
      propertyIndexByKey: await loadPropertyIndexMap(properties),
    };
  }

  if (options.viewId || (options.search ?? '').trim()) {
    const properties = await loadCurrentProperties();
    const propsById = new Map(properties.map((prop) => [prop.id, prop]));
    let view: DbView | undefined;
    if (options.viewId) {
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
      view = rawViews.sort(bySortPos).find((item) => item.id === options.viewId);
      if (viewNeedsRelationFilterRemap(view, propsById)) {
        view = (await remapImportedViewRelationFiltersForRead(
          db,
          database.workspaceId,
          properties,
          [view as DbView],
        ))[0];
        view = addInferredImportedViewNameFiltersForRead(properties, view ? [view] : [])[0];
      }
    }
    const queryContext = await loadQueryContext(
      viewQueryNeedsFullContext(view, properties, options.search),
    );
    rows = applyDatabaseViewQuery(
      rows,
      properties,
      view,
      {
        props: properties,
        propsByDb: queryContext.propsByDb,
        pagesById: queryContext.pagesById,
        propertyIndexByKey: queryContext.propertyIndexByKey,
        currentPageId: options.currentPageId,
      },
      options.search,
    );
  }

  const totalCount = rows.length;
  const offset = Math.min(options.offset ?? 0, totalCount);
  const shouldPage = options.limit !== undefined || offset > 0;
  const pagedRows = shouldPage
    ? rows.slice(offset, options.limit === undefined ? undefined : offset + options.limit)
    : rows;
  const relationTargets = options.includeRelationTargets
    ? await relatedPagesForRows(db, pagedRows, await loadCurrentProperties(), actorId, options.actorEmail)
    : { pages: [], targetIds: [] };
  const nextOffset =
    shouldPage && offset + pagedRows.length < totalCount ? offset + pagedRows.length : undefined;
  const baseResult = {
    databaseId,
    rows: pagedRows,
    ...(options.includeRelationTargets
      ? {
          relatedPages: relationTargets.pages,
          relationTargetIds: relationTargets.targetIds,
        }
      : {}),
    offset,
    limit: options.limit,
    totalCount,
    hasMore: nextOffset !== undefined,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
  if (!options.includeComputed) return baseResult;
  const { properties, propsByDb, pagesById } = await loadQueryContext(true);
  for (const row of pagedRows) pagesById.set(row.id, row);

  return {
    ...baseResult,
    computed: computedPropertyValues(pagedRows, properties, propsByDb, pagesById) ?? {},
  };
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const crossWorkspaceAction =
    action === 'pages' || action === 'searchPages' || action === 'searchBlocks' || action === 'allBlocks';
  const actorEmail = auth.email ?? null;

  try {
    // Routing must resolve inside the try: an unknown pageId hint throws
    // "Page was not found." and must map to 404, not escape as a 500
    // (same class as the comment-mutation routing fix).
    const db = body.workspaceId
      ? boundedDbFromWorkspaceHint(admin, body.workspaceId)
      : crossWorkspaceAction
        ? admin.db('app') // unused by the fan-out branches below
        : await boundedDbFromPageHint(admin, body.pageId, body.id, body.databaseId);
    switch (action) {
      case 'page':
        return await pageProjectionById(db, requireString(body.pageId, 'pageId'), auth.id, actorEmail);
      case 'pages': {
        if (typeof body.workspaceId === 'string') {
          return await pagesProjection(db, body, auth.id, actorEmail);
        }
        // Cross-workspace accessible listing: fan out per accessible workspace
        // (docs/workspace-do-migration.md).
        const merged: { pages: unknown[] } = { pages: [] };
        for (const wsId of await accessibleWorkspaceIdsForActor(admin, auth.id, actorEmail)) {
          const res = await pagesProjection(boundedDb(admin, wsId), body, auth.id, actorEmail);
          merged.pages.push(...(((res as { pages?: unknown[] })?.pages) ?? []));
        }
        return merged;
      }
      case 'searchPages': {
        if (typeof body.workspaceId === 'string') {
          return await searchPages(db, body, auth.id, actorEmail);
        }
        const merged: { pages: unknown[] } = { pages: [] };
        for (const wsId of await accessibleWorkspaceIdsForActor(admin, auth.id, actorEmail)) {
          const res = await searchPages(boundedDb(admin, wsId), body, auth.id, actorEmail);
          merged.pages.push(...(((res as { pages?: unknown[] })?.pages) ?? []));
        }
        return merged;
      }
      case 'blocks':
        return await pageBlocks(db, requireString(body.pageId, 'pageId'), auth.id, actorEmail);
      case 'allBlocks': {
        if (typeof body.workspaceId === 'string') return await allBlocks(db, auth.id, actorEmail);
        const merged: { blocks: unknown[]; truncated?: boolean } = { blocks: [] };
        for (const wsId of await accessibleWorkspaceIdsForActor(admin, auth.id, actorEmail)) {
          const res = await allBlocks(boundedDb(admin, wsId), auth.id, actorEmail);
          merged.blocks.push(...(res.blocks ?? []));
          if (res.truncated) merged.truncated = true;
          // Degrade to a flagged partial result at the cross-workspace budget
          // too — a hard 413 would brick the whole feature.
          if (merged.blocks.length > CROSS_WORKSPACE_BLOCK_LIMIT) {
            merged.blocks = merged.blocks.slice(0, CROSS_WORKSPACE_BLOCK_LIMIT);
            merged.truncated = true;
            break;
          }
        }
        return merged;
      }
      case 'searchBlocks': {
        if (typeof body.workspaceId === 'string') {
          return await searchBlocks(db, body, auth.id, actorEmail);
        }
        const merged: { blocks: unknown[]; truncated?: boolean } = { blocks: [] };
        const limit = parseLimit(body.limit, 20, 100);
        for (const wsId of await accessibleWorkspaceIdsForActor(admin, auth.id, actorEmail)) {
          const res = await searchBlocks(boundedDb(admin, wsId), body, auth.id, actorEmail);
          merged.blocks.push(...(res.blocks ?? []));
          if (res.truncated) merged.truncated = true;
          if (merged.blocks.length >= limit) break;
        }
        merged.blocks = merged.blocks.slice(0, limit);
        return merged;
      }
      case 'comments':
        return await pageComments(db, requireString(body.pageId, 'pageId'), auth.id, actorEmail);
      case 'comment':
        return await pageCommentById(db, requireString(body.commentId, 'commentId'), auth.id, actorEmail);
      case 'database':
        return await databaseSnapshot(
          db,
          requireString(body.databaseId, 'databaseId'),
          auth.id,
          actorEmail,
          {
            includeViewIds: uniqueStringArray(body.viewIds),
          },
        );
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
            viewId: typeof body.viewId === 'string' && body.viewId.trim() ? body.viewId.trim() : undefined,
            search: typeof body.search === 'string' ? body.search : undefined,
            currentPageId: typeof body.currentPageId === 'string' && body.currentPageId.trim()
              ? body.currentPageId.trim()
              : undefined,
          },
        );
      default:
        return jsonError(400, 'Unknown page query action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['access required'] },
      { status: 404, needles: ['not found', 'not a database', 'trash'] },
    ]);
    return jsonError(status, message);
  }
});
