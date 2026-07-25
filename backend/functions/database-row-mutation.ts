import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import {
  MAX_RAW_TRANSACT_OPS,
  boundedDbFromPageHint,
  boundedDbFromWorkspaceHint,
  ensurePageWorkspaceIndex,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import {
  databasePropertyIndexRecord,
  deleteDatabaseRowIndexes,
  upsertDatabaseIndexesForRows,
  upsertDatabaseRowIndexes,
} from '../lib/database-index';
import {
  assertNoActiveLegalHoldForPermanentDelete,
  assertOrganizationDlpContent,
} from '../lib/enterprise-controls';
import { recordWorkspaceAudit } from '../lib/org-audit';
import {
  assertMinimumWorkspaceAccessRole as sharedAssertMinimumWorkspaceAccessRole,
  canManagePageAccess as sharedCanManagePageAccess,
  pageAccessRole as sharedPageAccessRole,
} from '../lib/page-access';
import { deleteStoredUploadsBeforeMetadata } from '../lib/permanent-file-delete';
import { deleteNotificationsForDeletedContent } from '../lib/permanent-notification-delete';
import { collectNotionImportArtifactsForDeletedContent } from '../lib/permanent-import-delete';
import { releaseOrganizationStorage } from '../lib/storage-quota';
import {
  collectPermanentRoutingIndexPlan,
  deletePermanentRoutingIndexes,
} from '../lib/permanent-routing-index-delete';
import {
  assertFileTargetsNotDeleting,
  markFileDeletionPending,
  requireExclusiveFileWorkspaceLease,
  withDatabaseFileWorkspaceLease,
  withFileWorkspaceLease,
  type FileWorkspaceLeaseGuard,
} from '../lib/file-operation-lock';
import {
  assertNoUnownedStoredFileReferences,
  fileReferenceTransitionOperations,
  schemaFilePropertyReferences,
  storedFileReferencesChanged,
} from '../lib/file-reference-lifecycle';

import {
  bestEffort,
  listAll,
  requireString,
  getExisting,
  isTransactionConflictError,
  nowIso,
  newId,
  projectFields,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';
import type { ShareRole } from '../lib/page-access';
import type {
  Block,
  CollaborationDocument,
  CollaborationOperation,
  Comment,
  DbProperty,
  DbRef,
  DbTemplate as DbTemplateBase,
  DbView,
  FileUpload,
  FormLink,
  FunctionContext,
  FunctionStorageProxy,
  Page,
  PagePermission,
  ShareLink,
  TableRef,
  Workspace,
} from '../lib/app-types';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';
import {
  isReadOnlyDatabasePropertyType,
  normalizeDatabasePropertyWriteValue,
} from '../lib/database-property-types';
import {
  isExactPageMutationReplay,
  optionalPageMutationId,
  optionalPageMutationUpdatedAt,
  pageMutationBaseMatches,
} from '../lib/page-mutation-receipt';

interface TemplateBlock {
  type: string;
  content?: {
    rich?: Array<{ text?: string }>;
    expression?: string;
    url?: string;
    fileName?: string;
    [key: string]: unknown;
  };
  plainText?: string;
  children?: TemplateBlock[];
}

// Canonical DbTemplate stores template blocks as unknown[]; this file walks the
// block tree when instantiating a template, so narrow the shape locally.
interface DbTemplate extends DbTemplateBase {
  blocks?: TemplateBlock[];
}

type PagePatch = Partial<Page>;

const rowPatchKeys = new Set<keyof Page>([
  'title',
  'icon',
  'iconType',
  'cover',
  'notionIcon',
  'notionCover',
  'coverPosition',
  'font',
  'smallText',
  'fullWidth',
  'isLocked',
  'isPublic',
  'backlinksDisplay',
  'pageCommentsDisplay',
  'verifiedAt',
  'verifiedBy',
  'verificationExpiresAt',
  'properties',
  'isFavorite',
  'position',
  'lastEditedBy',
  'updatedAt',
]);

const lockedRowPatchKeys = new Set<keyof Page>([
  'isLocked',
  'isFavorite',
  'backlinksDisplay',
  'pageCommentsDisplay',
  'verifiedAt',
  'verifiedBy',
  'verificationExpiresAt',
  'updatedAt',
  'lastEditedBy',
]);

const lockedDatabasePatchKeys = new Set<keyof Page>([
  'isFavorite',
  'updatedAt',
  'lastEditedBy',
]);

const MAX_COLLECTED_DATABASE_ROW_MUTATION_OPERATIONS = 220;
const MAX_DIRECT_RELATION_TARGETS = 100;

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

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanRowPatch(patch: Record<string, unknown>): PagePatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!rowPatchKeys.has(key as keyof Page)) continue;
    if (value !== undefined) out[key] = cloneJson(value);
  }
  delete out.id;
  delete out.workspaceId;
  delete out.parentId;
  delete out.parentType;
  delete out.kind;
  delete out.createdAt;
  delete out.createdBy;
  delete out.updatedAt;
  delete out.lastEditedBy;
  delete out.inTrash;
  delete out.trashedAt;
  return out as PagePatch;
}

function patchAllowedBy(keys: Set<keyof Page>, patch: PagePatch) {
  return Object.keys(patch).every((key) => keys.has(key as keyof Page));
}

function collectSubtree(pagesById: Record<string, Page>, rootId: string) {
  const out: string[] = [];
  const visit = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    for (const page of Object.values(pagesById)) {
      if (page.parentId === id || page.subitemParentId === id) visit(page.id);
    }
  };
  visit(rootId);
  return out;
}

function positionBetween(a?: number, b?: number): number {
  if (a == null && b == null) return 1;
  if (a == null) return b! / 2;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

function iconTypeForValue(icon?: string): Page['iconType'] {
  if (!icon) return 'none';
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(icon.trim()) ? 'image' : 'emoji';
}

function spansToPlainText(spans?: Array<{ text?: string }>) {
  return (spans ?? []).map((span) => span.text ?? '').join('');
}

function templateBlockPlainText(block: TemplateBlock) {
  return (
    spansToPlainText(block.content?.rich) ||
    block.content?.expression ||
    block.content?.url ||
    block.content?.fileName ||
    block.plainText ||
    ''
  );
}

// Bounded fan-out: large row subtrees must not turn into thousands of
// concurrent queries (see page-mutation listByIds).
async function listByIds<T>(tableRef: TableRef<T>, field: string, ids: string[]): Promise<T[]> {
  const CONCURRENT = 20;
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += CONCURRENT) {
    const chunk = ids.slice(i, i + CONCURRENT);
    out.push(...(await Promise.all(chunk.map((id) => listAll(tableRef.where(field, '==', id))))));
  }
  return out.flat();
}

function uniqueById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function bySortPos(a: { position?: number }, b: { position?: number }) {
  return (a.position ?? 0) - (b.position ?? 0);
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

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pageNotionDatabaseId(page: Page) {
  const value = page.properties?.notionDatabaseId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isNotionLinkedDatabaseSourceUnavailable(page: Page) {
  return page.properties?.notionLinkedDatabaseSourceUnavailable === true;
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

async function resolveImportedLinkedDatabaseMutationTarget(
  db: DbRef,
  requestedDatabase: Page,
  actorId: string,
  actorEmail?: string | null,
) {
  if (!isNotionLinkedDatabaseSourceUnavailable(requestedDatabase)) {
    return { requestedDatabase, database: requestedDatabase, sourceResolved: false };
  }

  const targetNotionDatabaseId = normalizeNotionScopeId(pageNotionDatabaseId(requestedDatabase));
  if (!targetNotionDatabaseId) {
    return { requestedDatabase, database: requestedDatabase, sourceResolved: false };
  }

  const pages = db.table<Page>('pages');
  // The runtime table ref doubles as a query builder (page/limit/getList);
  // canonical TableRef only types the CRUD surface, so widen for listAll.
  const scopedViews = (await listAll(db.table<DbView>('db_views') as unknown as TableQuery<DbView>))
    .filter((view) => normalizeNotionScopeId(notionParentDatabaseId(view)) === targetNotionDatabaseId)
    .sort(bySortPos);
  const sourceDatabaseIds = Array.from(
    new Set(scopedViews.map((view) => view.databaseId).filter((id) => id !== requestedDatabase.id)),
  );

  for (const sourceDatabaseId of sourceDatabaseIds) {
    const sourceDatabase = await getExisting(pages, sourceDatabaseId);
    if (!sourceDatabase || sourceDatabase.kind !== 'database' || sourceDatabase.inTrash) continue;
    await assertCanEditPage(db, sourceDatabase, actorId, actorEmail);
    return { requestedDatabase, database: sourceDatabase, sourceResolved: true };
  }

  return { requestedDatabase, database: requestedDatabase, sourceResolved: false };
}

function jsonSame(a: unknown, b: unknown) {
  if (a == null && b == null) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function ids(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)].filter(Boolean);
}

function uniqueIds(value: unknown) {
  return Array.from(new Set(ids(value)));
}

function relationTargetDatabaseId(prop: DbProperty) {
  return typeof prop.config?.relationDatabaseId === 'string' && prop.config.relationDatabaseId.trim()
    ? prop.config.relationDatabaseId.trim()
    : prop.databaseId;
}

function relationIdsChanged(previous: unknown, next: unknown) {
  return !jsonSame(uniqueIds(previous), uniqueIds(next));
}

function reciprocalRelationProperty(
  prop: DbProperty,
  targetProps: DbProperty[],
  sourceDatabaseId: string,
) {
  // A two-way relation records the paired property id explicitly, which
  // disambiguates the case where two DBs have several relations between them.
  // Prefer that link; only fall back to the "any relation pointing back"
  // heuristic for legacy/imported pairs that predate explicit pairing.
  const linkedId =
    typeof prop.config?.relatedPropertyId === 'string' && prop.config.relatedPropertyId.trim()
      ? prop.config.relatedPropertyId.trim()
      : '';
  if (linkedId) {
    const linked = targetProps.find(
      (candidate) =>
        candidate.id === linkedId &&
        candidate.type === 'relation' &&
        relationTargetDatabaseId(candidate) === sourceDatabaseId,
    );
    if (linked) return linked;
  }
  return targetProps.find(
    (candidate) =>
      candidate.type === 'relation' &&
      candidate.id !== prop.id &&
      relationTargetDatabaseId(candidate) === sourceDatabaseId,
  );
}

// Role resolution is canonical in lib/page-access; this wrapper only pins
// this function's "missing workspace is an error" contract.
async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
}

async function assertCanEditPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Page access required.');
}

async function assertRelationValue(
  pages: TableRef<Page>,
  owner: Page,
  prop: DbProperty,
  value: unknown,
  cache: {
    databases: Map<string, Page | null>;
    rows: Map<string, Page | null>;
  },
) {
  const targetDbId = relationTargetDatabaseId(prop);
  const targetDb = cache.databases.has(targetDbId)
    ? cache.databases.get(targetDbId) ?? null
    : await getExisting(pages, targetDbId);
  cache.databases.set(targetDbId, targetDb);
  if (!targetDb || targetDb.kind !== 'database' || targetDb.inTrash) {
    throw new Error(`Relation target database was not found for property ${prop.name ?? prop.id}.`);
  }
  if (targetDb.workspaceId !== owner.workspaceId) {
    throw new Error(`Relation target database is outside the row workspace: ${prop.name ?? prop.id}.`);
  }

  for (const id of uniqueIds(value)) {
    const target = cache.rows.has(id)
      ? cache.rows.get(id) ?? null
      : await getExisting(pages, id);
    cache.rows.set(id, target);
    if (
      !target ||
      target.workspaceId !== owner.workspaceId ||
      target.parentType !== 'database' ||
      target.parentId !== targetDbId ||
      target.inTrash
    ) {
      throw new Error(`Invalid relation target for property ${prop.name ?? prop.id}: ${id}.`);
    }
  }
}

const IMPORTED_DATABASE_ROW_METADATA_PROPERTY_IDS = new Set([
  'notionImportJobId',
  'notionPageId',
  'notionDataSourceId',
]);

function isImportedDatabaseRowMetadataPropertyId(propId: string) {
  return propId.startsWith('__') || IMPORTED_DATABASE_ROW_METADATA_PROPERTY_IDS.has(propId);
}

async function normalizeRowProperties(
  pages: TableRef<Page>,
  owner: Page,
  props: DbProperty[],
  input: Record<string, unknown>,
  options: {
    existing?: Record<string, unknown>;
    rejectReadonly: boolean;
    relationRows?: Map<string, Page | null>;
  },
) {
  const propsById = new Map(props.map((prop) => [prop.id, prop]));
  const out: Record<string, unknown> = {};
  const relationValidationCache = {
    databases: new Map<string, Page | null>(),
    rows: options.relationRows ?? new Map<string, Page | null>(),
  };
  let changedRelationTargetCount = 0;

  for (const [propId, rawValue] of Object.entries(input)) {
    // Imported row metadata is stored beside real property ids and preserved by
    // the merge below, but it is not part of the editable database schema.
    if (isImportedDatabaseRowMetadataPropertyId(propId)) continue;
    const prop = propsById.get(propId);
    if (!prop) throw new Error(`Unknown database property: ${propId}.`);

    const previous = options.existing?.[propId];
    const changed = !jsonSame(rawValue, previous);
    if (isReadOnlyDatabasePropertyType(prop.type)) {
      if (options.rejectReadonly && changed) {
        throw new Error(`Cannot change read-only database property: ${prop.name ?? prop.id}.`);
      }
      if (previous !== undefined) out[propId] = previous;
      continue;
    }

    if (prop.type === 'relation') {
      const featureRole = String(recordObject(prop.config)?.databaseFeatureRole ?? '');
      if (
        changed
        && (featureRole === 'dependency_predecessor' || featureRole === 'dependency_successor')
      ) {
        throw Object.assign(
          new Error('Feature-owned dependency relations must use the dependency mutation action.'),
          { status: 409 },
        );
      }
      const nextIds = uniqueIds(rawValue);
      if (changed) {
        changedRelationTargetCount += nextIds.length;
        if (changedRelationTargetCount > MAX_DIRECT_RELATION_TARGETS) {
          throw Object.assign(
            new Error(`Database row mutation has too many relation targets (max ${MAX_DIRECT_RELATION_TARGETS}).`),
            { status: 413 },
          );
        }
        await assertRelationValue(pages, owner, prop, nextIds, relationValidationCache);
      }
      out[propId] = nextIds.length ? nextIds : null;
      continue;
    }

    out[propId] = cloneJson(normalizeDatabasePropertyWriteValue(prop.type, rawValue));
  }

  return out;
}

async function syncReciprocalRelations({
  pages,
  propertiesTable,
  sourceRow,
  sourceProps,
  previousProperties,
  nextProperties,
  changedPropertyIds,
  actorId,
}: {
  pages: TableRef<Page>;
  propertiesTable: TableRef<DbProperty>;
  sourceRow: Page;
  sourceProps: DbProperty[];
  previousProperties: Record<string, unknown>;
  nextProperties: Record<string, unknown>;
  changedPropertyIds?: Set<string>;
  actorId: string;
}) {
  const relationPropertyIds = changedPropertyIds ?? new Set(
    sourceProps.filter((property) => property.type === 'relation').map((property) => property.id),
  );
  const plans = await planReciprocalRelationUpdates({
    pages,
    propertiesTable,
    currentSourceRow: sourceRow,
    nextSourceRow: sourceRow,
    sourceProps,
    previousProperties,
    nextProperties,
    changedPropertyIds: relationPropertyIds,
    actorId,
    validatedRelationRows: new Map(),
  });
  const affectedRows: Page[] = [];
  for (const plan of plans) {
    affectedRows.push(await pages.update(plan.current.id, plan.data));
  }

  return affectedRows;
}

interface ReciprocalRelationUpdatePlan {
  current: Page;
  next: Page;
  data: Pick<Page, 'properties' | 'updatedAt' | 'lastEditedBy'>;
}

async function planReciprocalRelationUpdates({
  pages,
  propertiesTable,
  currentSourceRow,
  nextSourceRow,
  sourceProps,
  previousProperties,
  nextProperties,
  changedPropertyIds,
  actorId,
  validatedRelationRows,
}: {
  pages: TableRef<Page>;
  propertiesTable: TableRef<DbProperty>;
  currentSourceRow: Page;
  nextSourceRow: Page;
  sourceProps: DbProperty[];
  previousProperties: Record<string, unknown>;
  nextProperties: Record<string, unknown>;
  changedPropertyIds: Set<string>;
  actorId: string;
  validatedRelationRows: Map<string, Page | null>;
}) {
  const sourceDatabaseId = requireString(currentSourceRow.parentId, 'sourceRow.parentId');
  const propsByDb = new Map<string, DbProperty[]>([[sourceDatabaseId, sourceProps]]);
  const touchedTargetIds = new Set<string>();
  const plannedById = new Map<string, ReciprocalRelationUpdatePlan>();

  for (const prop of sourceProps) {
    if (prop.type !== 'relation' || !changedPropertyIds.has(prop.id)) continue;
    const previousIds = uniqueIds(previousProperties[prop.id]);
    const nextIds = uniqueIds(nextProperties[prop.id]);
    if (!relationIdsChanged(previousIds, nextIds)) continue;

    const targetIds = Array.from(new Set([...previousIds, ...nextIds]));
    for (const targetId of targetIds) {
      touchedTargetIds.add(targetId);
      if (touchedTargetIds.size > MAX_DIRECT_RELATION_TARGETS) {
        throw Object.assign(
          new Error(`Database row mutation has too many relation targets (max ${MAX_DIRECT_RELATION_TARGETS}).`),
          { status: 413 },
        );
      }
    }

    const targetDbId = relationTargetDatabaseId(prop);
    let targetProps = propsByDb.get(targetDbId);
    if (!targetProps) {
      targetProps = await listAll(propertiesTable.where('databaseId', '==', targetDbId));
      propsByDb.set(targetDbId, targetProps);
    }
    const reciprocal = reciprocalRelationProperty(prop, targetProps, sourceDatabaseId);
    if (!reciprocal) continue;

    const previousSet = new Set(previousIds);
    const nextSet = new Set(nextIds);
    for (const targetId of targetIds) {
      const existingPlan = plannedById.get(targetId);
      const current = existingPlan?.current ?? (
        targetId === currentSourceRow.id
          ? currentSourceRow
          : validatedRelationRows.has(targetId)
            ? validatedRelationRows.get(targetId) ?? null
            : await getExisting(pages, targetId)
      );
      if (!current || current.workspaceId !== currentSourceRow.workspaceId) continue;
      const next = existingPlan?.next ?? (
        targetId === currentSourceRow.id ? nextSourceRow : current
      );
      const currentIds = uniqueIds(next.properties?.[reciprocal.id]);
      let reciprocalIds = currentIds;

      if (nextSet.has(targetId) && !reciprocalIds.includes(currentSourceRow.id)) {
        reciprocalIds = [...reciprocalIds, currentSourceRow.id];
      }
      if (!nextSet.has(targetId) && previousSet.has(targetId)) {
        reciprocalIds = reciprocalIds.filter((id) => id !== currentSourceRow.id);
      }
      if (jsonSame(currentIds, reciprocalIds)) continue;

      const data = {
        properties: {
          ...(next.properties ?? {}),
          [reciprocal.id]: reciprocalIds.length ? reciprocalIds : null,
        },
        updatedAt: nowIso(),
        lastEditedBy: actorId,
      };
      plannedById.set(targetId, {
        current,
        next: { ...next, ...data },
        data,
      });
    }
  }

  return Array.from(plannedById.values());
}

function directRowMutationExpectation(row: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: row.id,
    where: [
      ['updatedAt', '==', row.updatedAt ?? null],
      ['lastEditedBy', '==', row.lastEditedBy ?? null],
      ['lastMutationId', '==', row.lastMutationId ?? null],
    ],
    exists: true,
  };
}

async function insertTemplateBlocks(
  blocks: TableRef<Block>,
  pageId: string,
  actorId: string,
  templateBlocks: TemplateBlock[],
) {
  const inserted: Block[] = [];

  const insertOne = async (templateBlock: TemplateBlock, parentId: string | null, position: number) => {
    const now = nowIso();
    const block: Block = {
      id: newId(),
      pageId,
      parentId,
      type: requireString(templateBlock.type, 'block.type'),
      content: cloneJson(templateBlock.content ?? { rich: [] }),
      plainText: templateBlockPlainText(templateBlock),
      position,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    const persisted = await blocks.insert(block);
    inserted.push(persisted);

    let childPosition: number | undefined;
    for (const child of templateBlock.children ?? []) {
      const nextPosition = positionBetween(childPosition, undefined);
      await insertOne(child, persisted.id, nextPosition);
      childPosition = nextPosition;
    }
  };

  let position: number | undefined;
  for (const templateBlock of templateBlocks) {
    const nextPosition = positionBetween(position, undefined);
    await insertOne(templateBlock, null, nextPosition);
    position = nextPosition;
  }

  return inserted;
}

function collectTemplateBlocks(
  pageId: string,
  actorId: string,
  templateBlocks: TemplateBlock[],
  maximumBlocks: number,
) {
  const collected: Block[] = [];

  const collectOne = (templateBlock: TemplateBlock, parentId: string | null, position: number) => {
    if (collected.length >= maximumBlocks) {
      throw Object.assign(
        new Error('Database row create produced too many collected writes.'),
        { status: 413 },
      );
    }
    const now = nowIso();
    const block: Block = {
      id: newId(),
      pageId,
      parentId,
      type: requireString(templateBlock.type, 'block.type'),
      content: cloneJson(templateBlock.content ?? { rich: [] }),
      plainText: templateBlockPlainText(templateBlock),
      position,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    collected.push(block);

    let childPosition: number | undefined;
    for (const child of templateBlock.children ?? []) {
      const nextPosition = positionBetween(childPosition, undefined);
      collectOne(child, block.id, nextPosition);
      childPosition = nextPosition;
    }
  };

  let position: number | undefined;
  for (const templateBlock of templateBlocks) {
    const nextPosition = positionBetween(position, undefined);
    collectOne(templateBlock, null, nextPosition);
    position = nextPosition;
  }

  return collected;
}

const DATABASE_ROW_TAIL_FIELDS = [
  'id',
  'parentId',
  'parentType',
  'inTrash',
  'position',
] as const;

const DATABASE_ROW_SEQUENCE_FIELDS = [
  ...DATABASE_ROW_TAIL_FIELDS,
  'properties',
] as const;

// Workers request contexts cannot safely execute another request's database
// callback through a module-level collector. Keep each create request-owned,
// but give ordinary short row bursts a bounded jittered lease wait.
const DATABASE_ROW_CREATE_LEASE_CONTENTION_WAIT_MS = 5_000;

interface OrderedWhereQuery<T> extends TableQuery<T> {
  where(field: string, op: string, value: unknown): OrderedWhereQuery<T>;
  orderBy(field: string, direction: 'asc' | 'desc'): OrderedWhereQuery<T>;
}

function supportsOrderedWhere<T>(query: TableQuery<T>): query is OrderedWhereQuery<T> {
  return typeof query.where === 'function' && typeof query.orderBy === 'function';
}

function isActiveDatabaseRow(candidate: Page, databaseId: string) {
  return candidate.parentId === databaseId
    && candidate.parentType === 'database'
    && candidate.inTrash !== true;
}

function maxActiveDatabaseRowPosition(rows: Page[], databaseId: string) {
  return rows.reduce<number | undefined>((max, candidate) => {
    if (!isActiveDatabaseRow(candidate, databaseId)) return max;
    return max == null || candidate.position > max ? candidate.position : max;
  }, undefined);
}

async function lastActiveDatabaseRowPosition(
  pages: TableRef<Page>,
  databaseId: string,
) {
  const parentQuery = pages.where('parentId', '==', databaseId);
  if (supportsOrderedWhere(parentQuery)) {
    const exactQuery = projectFields(
      parentQuery
        .where('parentType', '==', 'database')
        .where('inTrash', '==', false)
        .orderBy('position', 'desc'),
      DATABASE_ROW_TAIL_FIELDS,
    );
    const result = await exactQuery.page(1).limit(1).getList();
    const candidate = result.items?.[0];
    if (!candidate) return undefined;
    if (isActiveDatabaseRow(candidate, databaseId) && Number.isFinite(candidate.position)) {
      return candidate.position;
    }
    // A query adapter that advertises the optimized operators but returns a
    // row outside their predicate is not trusted as an ordering authority.
    // Re-read the bounded parent snapshot and apply the canonical filter.
  }

  const rows = await listAll(
    projectFields(parentQuery, DATABASE_ROW_TAIL_FIELDS),
    { label: 'Database row append-position fallback' },
  );
  return maxActiveDatabaseRowPosition(rows, databaseId);
}

type DatabaseRowMoveSide = 'before' | 'after';

interface DatabaseRowMoveNeighbors {
  previousPosition?: number;
  nextPosition?: number;
}

function databaseRowMoveNeighborsFromSnapshot(
  rows: Page[],
  databaseId: string,
  movingRowId: string,
  targetRowId: string,
  side: DatabaseRowMoveSide,
): DatabaseRowMoveNeighbors {
  const ordered = rows
    .filter((candidate) => (
      isActiveDatabaseRow(candidate, databaseId)
      && candidate.id !== movingRowId
    ))
    .sort((left, right) => left.position - right.position);
  const targetIndex = ordered.findIndex((candidate) => candidate.id === targetRowId);
  if (targetIndex < 0) throw new Error('Target database row was not found.');

  const insertionIndex = targetIndex + (side === 'after' ? 1 : 0);
  return {
    previousPosition: ordered[insertionIndex - 1]?.position,
    nextPosition: ordered[insertionIndex]?.position,
  };
}

function trustedDatabaseRowMoveWindow(
  candidates: Page[],
  databaseId: string,
  movingRowId: string,
  targetRowId: string,
  side: DatabaseRowMoveSide,
  hasMore: boolean | undefined,
): DatabaseRowMoveNeighbors | undefined {
  if (candidates.length > 3 || (hasMore === true && candidates.length < 3)) return undefined;

  const seenIds = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (
      seenIds.has(candidate.id)
      || !isActiveDatabaseRow(candidate, databaseId)
      || !Number.isFinite(candidate.position)
    ) {
      return undefined;
    }
    seenIds.add(candidate.id);
    if (index === 0) continue;
    const prior = candidates[index - 1]!;
    const outOfOrder = side === 'before'
      ? candidate.position > prior.position
      : candidate.position < prior.position;
    if (outOfOrder) return undefined;
  }

  const target = candidates.find((candidate) => candidate.id === targetRowId);
  if (!target) return undefined;

  for (const candidate of candidates) {
    if (candidate.id === movingRowId) continue;
    const crossedFreshTarget = side === 'before'
      ? candidate.position > target.position
      : candidate.position < target.position;
    if (crossedFreshTarget) return undefined;
    if (candidate.id !== targetRowId && candidate.position === target.position) {
      // The prior implementation used the adapter's stable full-snapshot
      // order for equal positions. Preserve that behavior rather than
      // defining a new tie-breaker from a truncated position window.
      return undefined;
    }
  }

  const neighbor = candidates.find((candidate) => (
    candidate.id !== movingRowId
    && candidate.id !== targetRowId
    && (side === 'before'
      ? candidate.position < target.position
      : candidate.position > target.position)
  ));
  return side === 'before'
    ? { previousPosition: neighbor?.position, nextPosition: target.position }
    : { previousPosition: target.position, nextPosition: neighbor?.position };
}

async function databaseRowMoveNeighbors(
  pages: TableRef<Page>,
  databaseId: string,
  movingRowId: string,
  target: Page,
  side: DatabaseRowMoveSide,
): Promise<DatabaseRowMoveNeighbors> {
  const parentQuery = pages.where('parentId', '==', databaseId);
  const exactSnapshot = async () => databaseRowMoveNeighborsFromSnapshot(
    await listAll(
      projectFields(parentQuery, DATABASE_ROW_TAIL_FIELDS),
      { label: 'Database row move-position fallback' },
    ),
    databaseId,
    movingRowId,
    target.id,
    side,
  );

  if (!Number.isFinite(target.position) || !supportsOrderedWhere(parentQuery)) {
    return exactSnapshot();
  }

  // One target-inclusive window coalesces target-presence and neighbor work.
  // Three rows leave room for the target, the one excluded moving row, and
  // the surviving neighbor without loading the remaining database rows.
  const direction = side === 'before' ? 'desc' : 'asc';
  const rangeOperator = side === 'before' ? '<=' : '>=';
  const windowQuery = projectFields(
    parentQuery
      .where('parentType', '==', 'database')
      .where('inTrash', '==', false)
      .where('position', rangeOperator, target.position)
      .orderBy('position', direction),
    DATABASE_ROW_TAIL_FIELDS,
  );
  const result = await windowQuery.page(1).limit(3).getList();
  const trusted = trustedDatabaseRowMoveWindow(
    result.items ?? [],
    databaseId,
    movingRowId,
    target.id,
    side,
    result.hasMore,
  );
  return trusted ?? exactSnapshot();
}

async function createDatabaseRowUnderWorkspaceLease(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  lease: FileWorkspaceLeaseGuard,
  actorEmail?: string | null,
  requestUrl?: string,
) {
  const pages = db.table<Page>('pages');
  const blocks = db.table<Block>('blocks');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const templatesTable = db.table<DbTemplate>('db_templates');

  const databaseId = requireString(body.databaseId, 'databaseId');
  const requestedDatabase = await getExisting(pages, databaseId);
  if (!requestedDatabase) throw new Error('Database was not found.');
  if (requestedDatabase.kind !== 'database') throw new Error('Page is not a database.');
  await assertCanEditPage(db, requestedDatabase, actorId, actorEmail);
  if (requestedDatabase.inTrash) throw new Error('Database is in trash.');
  if (requestedDatabase.isLocked) throw new Error('Database is locked.');

  const mutationTarget = await resolveImportedLinkedDatabaseMutationTarget(
    db,
    requestedDatabase,
    actorId,
    actorEmail,
  );
  const database = mutationTarget.database;
  const targetDatabaseId = database.id;
  if (database.workspaceId !== workspaceId) {
    throw Object.assign(
      new Error('Database changed workspaces while the row was being created.'),
      { status: 409 },
    );
  }
  if (database.inTrash) throw new Error('Database is in trash.');
  if (database.isLocked) throw new Error('Database is locked.');
  const responseParentId = mutationTarget.sourceResolved ? requestedDatabase.id : targetDatabaseId;

  // Property deletion uses this same workspace lease. Re-read both the target
  // database and its schema only after owning the lease, so a row can never
  // commit values that were validated against a property which has since been
  // tombstoned. The target fence also prevents a row from being created while
  // its database/page hierarchy is being permanently deleted.
  await lease.assertOwned();
  await assertFileTargetsNotDeleting(db, workspaceId, [requestedDatabase.id, targetDatabaseId]);

  const hierarchyCreateRequested = Object.prototype.hasOwnProperty.call(body, 'parentRowId');
  const hierarchyParentId = hierarchyCreateRequested
    ? requestedSubitemParentId(body)
    : '';
  const hierarchyMutationId = hierarchyCreateRequested
    ? requireString(body.mutationId, 'mutationId')
    : '';
  const hierarchyBinding = hierarchyCreateRequested
    ? subitemFeatureBinding(database)
    : null;
  let hierarchyParent: Page | null = null;
  if (hierarchyCreateRequested) {
    const activeLifecycle = await db
      .table<DatabaseHierarchyLifecycleJob>('database_hierarchy_lifecycle_jobs')
      .where('databaseId', '==', database.id)
      .limit(1)
      .getList();
    if ((activeLifecycle.items ?? []).length > 0) {
      throw Object.assign(
        new Error('A database hierarchy lifecycle operation is in progress.'),
        { status: 409 },
      );
    }
    if (hierarchyParentId) {
      hierarchyParent = await getExisting(pages, hierarchyParentId);
      if (
        !hierarchyParent
        || hierarchyParent.workspaceId !== database.workspaceId
        || hierarchyParent.parentType !== 'database'
        || hierarchyParent.parentId !== database.id
        || hierarchyParent.kind === 'database'
        || hierarchyParent.inTrash
      ) {
        throw Object.assign(
          new Error('Sub-item parent must be a live row in the same database.'),
          { status: 409 },
        );
      }
      await assertCanEditPage(db, hierarchyParent, actorId, actorEmail);
    }
  }

  // Client creates are durable-outbox operations and therefore at-least-once:
  // a slow successful response can be retried after reload. A stable client row
  // id makes that retry safe. A matching row is the acknowledgement of the
  // original create; an id already owned by any other record remains a conflict.
  const requestedRowId = typeof body.id === 'string' ? body.id.trim() : '';
  if (requestedRowId) {
    const existingRow = await getExisting(pages, requestedRowId);
    if (existingRow) {
      if (
        existingRow.workspaceId !== database.workspaceId ||
        existingRow.parentType !== 'database' ||
        existingRow.parentId !== targetDatabaseId ||
        existingRow.kind !== 'page' ||
        existingRow.inTrash
      ) {
        throw Object.assign(new Error('Database row id is already in use.'), { status: 409 });
      }
      if (hierarchyCreateRequested && (
        (existingRow.subitemParentId ?? '') !== hierarchyParentId
        || existingRow.lastMutationId !== hierarchyMutationId
        || existingRow.createdBy !== actorId
      )) {
        throw Object.assign(
          new Error('Database row id was already used for another hierarchy create.'),
          { status: 409 },
        );
      }
      await ensurePageWorkspaceIndex(admin, existingRow.id, existingRow.workspaceId);
      const existingBlocks = await listAll(blocks.where('pageId', '==', existingRow.id));
      return {
        row: { ...existingRow, parentId: responseParentId, parentType: 'database' },
        blocks: existingBlocks.sort((a, b) => a.position - b.position),
        affectedRows: [],
      };
    }
  }

  const propsPromise = listAll(propertiesTable.where('databaseId', '==', targetDatabaseId));
  const templatesOutcomePromise = listAll(
    templatesTable.where('databaseId', '==', targetDatabaseId),
  ).then(
    (templates) => ({ ok: true as const, templates }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const props = await propsPromise;
  const uniqueIdProperties = props.filter((prop) => prop.type === 'unique_id');
  const explicitPosition =
    typeof body.position === 'number' && Number.isFinite(body.position)
      ? body.position
      : undefined;
  const siblingPlanPromise: Promise<{ databaseRows: Page[]; lastPosition?: number }> =
    uniqueIdProperties.length > 0
      ? (async () => {
          const rows = await listAll(
            projectFields(
              pages.where('parentId', '==', targetDatabaseId),
              DATABASE_ROW_SEQUENCE_FIELDS,
            ),
            { label: 'Database row unique-ID allocation' },
          );
          const databaseRows = databaseRowsFromParentSnapshot(rows, targetDatabaseId);
          return {
            databaseRows,
            lastPosition: maxActiveDatabaseRowPosition(databaseRows, targetDatabaseId),
          };
        })()
      : explicitPosition === undefined
        ? lastActiveDatabaseRowPosition(pages, targetDatabaseId).then((lastPosition) => ({
            databaseRows: [],
            lastPosition,
          }))
        : Promise.resolve({ databaseRows: [] });
  // Once schema shape is known, overlap the compatible row-tail/snapshot lane
  // with the already-started template read. Unique-ID databases still issue
  // only their one authoritative snapshot rather than a redundant tail read.
  const [templatesOutcome, siblingPlan] = await Promise.all([
    templatesOutcomePromise,
    siblingPlanPromise,
  ]);
  if (!templatesOutcome.ok) throw templatesOutcome.error;
  const templates = templatesOutcome.templates;

  const templateId = typeof body.templateId === 'string' ? body.templateId : undefined;
  const useEmptyTemplate = body.empty === true || templateId === '';
  const template = useEmptyTemplate
    ? undefined
    : templateId
      ? templates.find((item) => item.id === templateId)
      : templates.find((item) => item.isDefault);
  if (templateId && !useEmptyTemplate && !template) throw new Error('Database template was not found.');

  const templateProperties = await normalizeRowProperties(
    pages,
    database,
    props,
    template?.properties && typeof template.properties === 'object' ? template.properties : {},
    { rejectReadonly: false },
  );
  const inputProperties = await normalizeRowProperties(
    pages,
    database,
    props,
    body.properties && typeof body.properties === 'object'
      ? (body.properties as Record<string, unknown>)
      : {},
    { rejectReadonly: true },
  );
  const nextProperties: Record<string, unknown> = {
    ...templateProperties,
    ...inputProperties,
  };
  for (const prop of uniqueIdProperties) {
    let max = 0;
    for (const row of siblingPlan.databaseRows) {
      const value = Number(row.properties?.[prop.id]);
      if (Number.isFinite(value) && value > max) max = value;
    }
    nextProperties[prop.id] = max + 1;
  }

  const position = explicitPosition ?? positionBetween(siblingPlan.lastPosition, undefined);
  const now = nowIso();
  const row: Page = {
    id: requestedRowId || newId(),
    workspaceId: database.workspaceId,
    parentId: targetDatabaseId,
    parentType: 'database',
    ...(hierarchyCreateRequested ? {
      subitemParentId: hierarchyParentId,
      lastMutationId: hierarchyMutationId,
    } : {}),
    subitemChildCount: 0,
    kind: 'page',
    title: typeof body.title === 'string' ? body.title : template?.title ?? '',
    icon: typeof body.icon === 'string' ? body.icon : template?.icon,
    iconType: iconTypeForValue(typeof body.icon === 'string' ? body.icon : template?.icon),
    cover: typeof body.cover === 'string' ? body.cover : undefined,
    notionIcon: body.notionIcon && typeof body.notionIcon === 'object'
      ? cloneJson(body.notionIcon as Record<string, unknown>)
      : null,
    notionCover: body.notionCover && typeof body.notionCover === 'object'
      ? cloneJson(body.notionCover as Record<string, unknown>)
      : null,
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    isPublic: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties: nextProperties,
    isFavorite: false,
    inTrash: false,
    position,
    createdBy: actorId,
    lastEditedBy: actorId,
    createdAt: now,
    updatedAt: now,
  };

  const filePropertyIds = props
    .filter((property) => property.type === 'files')
    .map((property) => property.id);
  const createFileReferences = {
    icon: row.icon,
    cover: row.cover,
    properties: row.properties,
    schemaFileProperties: schemaFilePropertyReferences(row.properties, filePropertyIds),
    templateBlocks: template?.blocks,
  };
  const hasCrossDatabaseRelationEffects = props.some((property) => (
    property.type === 'relation' && uniqueIds(nextProperties[property.id]).length > 0
  ));
  const hasStoredFileEffects = storedFileReferencesChanged({}, createFileReferences);
  requireExclusiveFileWorkspaceLease(
    lease,
    hasCrossDatabaseRelationEffects || hasStoredFileEffects,
  );
  await assertNoUnownedStoredFileReferences(db, createFileReferences, { requestUrl });
  const templateBlocks = Array.isArray(template?.blocks) ? template.blocks : [];

  if (hierarchyCreateRequested) {
    if (hasCrossDatabaseRelationEffects || hasStoredFileEffects || templateBlocks.length > 0) {
      throw Object.assign(
        new Error('Atomic sub-item create requires an empty template without relation or stored-file effects.'),
        { status: 409 },
      );
    }
    if (!hierarchyBinding) {
      throw Object.assign(new Error('Sub-item hierarchy is not enabled for this database.'), { status: 409 });
    }
    const currentFeatures = cloneJson(recordObject(database.databaseFeatures) ?? {});
    const nextDatabaseFeaturesRevision = Number(database.databaseFeaturesRevision ?? 0) + 1;
    await db.transact([
      hierarchyDatabaseExpectation(database),
      ...(hierarchyParent ? [hierarchyRowExpectation(hierarchyParent)] : []),
      { table: 'pages', op: 'expect', id: row.id, exists: false },
      { table: 'pages', op: 'insert', data: row as unknown as Record<string, unknown> },
      ...(hierarchyParent ? [{
        table: 'pages' as const,
        op: 'update' as const,
        id: hierarchyParent.id,
        data: { subitemChildCount: changedSubitemChildCount(hierarchyParent, 1) },
      }] : []),
      {
        table: 'pages',
        op: 'update',
        id: database.id,
        data: {
          databaseFeatures: {
            ...currentFeatures,
            subitems: { ...hierarchyBinding, revision: hierarchyBinding.revision + 1 },
          },
          databaseFeaturesRevision: nextDatabaseFeaturesRevision,
          lastEditedBy: actorId,
          updatedAt: now,
        },
      },
    ]);
    await ensurePageWorkspaceIndex(admin, row.id, row.workspaceId);
    await bestEffort(
      'database-row-mutation upsertDatabaseIndexesForRows hierarchy create',
      upsertDatabaseIndexesForRows(db, [row]),
    );
    return {
      row: { ...row, parentId: responseParentId, parentType: 'database' },
      blocks: [] as Block[],
      affectedRows: [] as Page[],
      databaseFeaturesRevision: nextDatabaseFeaturesRevision,
    };
  }

  if (!hasCrossDatabaseRelationEffects && !hasStoredFileEffects) {
    const eventId = newId();
    const eventMutationId = optionalPageMutationId(body.mutationId, 'mutationId') ?? row.id;
    const indexOperations: TransactOperation[] = props.flatMap((property): TransactOperation[] => {
      const indexId = newId();
      const data = JSON.parse(JSON.stringify(
        databasePropertyIndexRecord(row, property, indexId),
      )) as Record<string, unknown>;
      return [
        { table: 'db_property_indexes', op: 'expect', id: indexId, exists: false },
        { table: 'db_property_indexes', op: 'insert', data },
      ];
    });
    const collectedBlocks = collectTemplateBlocks(
      row.id,
      actorId,
      templateBlocks,
      MAX_COLLECTED_DATABASE_ROW_MUTATION_OPERATIONS - 3 - indexOperations.length,
    );
    const blockOperations: TransactOperation[] = collectedBlocks.map((block) => ({
      table: 'blocks',
      op: 'insert',
      data: block as unknown as Record<string, unknown>,
    }));
    const operations: TransactOperation[] = [
      { table: 'pages', op: 'expect', id: row.id, exists: false },
      { table: 'pages', op: 'insert', data: row as unknown as Record<string, unknown> },
      ...indexOperations,
      ...blockOperations,
      {
        table: 'database_automation_events',
        op: 'insert',
        data: {
          id: eventId,
          workspaceId,
          databaseId: targetDatabaseId,
          rowId: row.id,
          triggerKind: 'row_added',
          origin: 'user',
          mutationId: eventMutationId,
          changedPropertyIds: [],
          occurredAt: now,
          state: 'pending',
        },
      },
    ];
    if (operations.length > MAX_COLLECTED_DATABASE_ROW_MUTATION_OPERATIONS) {
      throw Object.assign(
        new Error('Database row create produced too many collected writes.'),
        { status: 413 },
      );
    }
    let committedRow: Page;
    let committedBlocks: Block[];
    try {
      const transaction = await db.transact(operations);
      committedRow = (transaction.results[1]?.inserted as Page | undefined) ?? row;
      const firstBlockResultIndex = 2 + indexOperations.length;
      committedBlocks = collectedBlocks.map((block, index) => (
        (transaction.results[firstBlockResultIndex + index]?.inserted as Block | undefined) ?? block
      ));
    } catch (error) {
      if (isTransactionConflictError(error)) {
        throw Object.assign(new Error('Database row changed since it was loaded.'), { status: 409 });
      }
      throw error;
    }
    await ensurePageWorkspaceIndex(admin, committedRow.id, committedRow.workspaceId);
    return {
      row: { ...committedRow, parentId: responseParentId, parentType: 'database' },
      blocks: committedBlocks,
      affectedRows: [] as Page[],
    };
  }

  const insertedBlocks: Block[] = [];
  let insertedRow: Page | null = null;
  try {
    insertedRow = await pages.insert(row);
    await ensurePageWorkspaceIndex(admin, insertedRow.id, insertedRow.workspaceId);
    if (templateBlocks.length > 0) {
      insertedBlocks.push(...(await insertTemplateBlocks(blocks, insertedRow.id, actorId, templateBlocks)));
    }
    const affectedRows = await syncReciprocalRelations({
      pages,
      propertiesTable,
      sourceRow: insertedRow,
      sourceProps: props,
      previousProperties: {},
      nextProperties: insertedRow.properties ?? nextProperties,
      actorId,
    });
    insertedRow = affectedRows.find((page) => page.id === insertedRow?.id) ?? insertedRow;
    await bestEffort('database-row-mutation upsertDatabaseIndexesForRows', upsertDatabaseIndexesForRows(db, uniqueById([insertedRow, ...affectedRows])));
    return {
      row: { ...insertedRow, parentId: responseParentId, parentType: 'database' },
      blocks: insertedBlocks,
      affectedRows,
    };
  } catch (error) {
    await Promise.all(insertedBlocks.map((block) => bestEffort('database-row-mutation blocks.delete', blocks.delete(block.id))));
    if (insertedRow) await bestEffort('database-row-mutation pages.delete', pages.delete(insertedRow.id));
    throw error;
  }
}

async function createDatabaseRow(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  requestUrl?: string,
) {
  const pages = db.table<Page>('pages');
  const databaseId = requireString(body.databaseId, 'databaseId');
  const requestedDatabase = await getExisting(pages, databaseId);
  if (!requestedDatabase) throw new Error('Database was not found.');
  if (requestedDatabase.kind !== 'database') throw new Error('Page is not a database.');
  await assertCanEditPage(db, requestedDatabase, actorId, actorEmail);
  if (requestedDatabase.inTrash) throw new Error('Database is in trash.');
  if (requestedDatabase.isLocked) throw new Error('Database is locked.');

  const initialTarget = await resolveImportedLinkedDatabaseMutationTarget(
    db,
    requestedDatabase,
    actorId,
    actorEmail,
  );
  const workspaceId = initialTarget.database.workspaceId;
  return withDatabaseFileWorkspaceLease(
    db,
    workspaceId,
    initialTarget.database.id,
    actorId,
    'database-row-schema-create',
    (lease) => createDatabaseRowUnderWorkspaceLease(
      db,
      admin,
      body,
      actorId,
      workspaceId,
      lease,
      actorEmail,
      requestUrl,
    ),
    { contentionWaitMs: DATABASE_ROW_CREATE_LEASE_CONTENTION_WAIT_MS },
  );
}

async function updateDatabaseRowUnderWorkspaceLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  lease: FileWorkspaceLeaseGuard,
  actorEmail?: string | null,
) {
  const pages = db.table<Page>('pages');
  const propertiesTable = db.table<DbProperty>('db_properties');

  const id = requireString(body.id, 'id');
  const row = await getExisting(pages, id);
  if (!row) throw new Error('Database row was not found.');
  if (row.parentType !== 'database' || !row.parentId) {
    throw new Error('Page is not a database row.');
  }
  if (row.inTrash) throw new Error('Database row is in trash.');

  const database = await getExisting(pages, row.parentId);
  if (!database) throw new Error('Database was not found.');
  if (database.kind !== 'database') throw new Error('Parent page is not a database.');
  if (database.inTrash) throw new Error('Database is in trash.');
  if (row.workspaceId !== workspaceId || database.workspaceId !== workspaceId) {
    throw Object.assign(
      new Error('Database row changed workspaces while it was being updated.'),
      { status: 409 },
    );
  }
  await assertCanEditPage(db, row, actorId, actorEmail);
  await assertNoActiveDependencyDateShift(db, database);

  const expectedUpdatedAt = optionalPageMutationUpdatedAt(body.expectedUpdatedAt);
  const expectedMutationId = optionalPageMutationId(body.expectedMutationId, 'expectedMutationId');
  const mutationId = optionalPageMutationId(body.mutationId, 'mutationId');
  if (isExactPageMutationReplay(row, mutationId, actorId)) {
    return { row, affectedRows: [] };
  }
  if (
    (expectedUpdatedAt || expectedMutationId)
    && !pageMutationBaseMatches(row, expectedUpdatedAt, expectedMutationId, actorId)
  ) {
    throw new Error('Database row changed since it was loaded.');
  }

  // See createDatabaseRowUnderWorkspaceLease: the schema and row are both
  // fetched under the same lease used by property tombstoning/cleanup.
  await lease.assertOwned();
  await assertFileTargetsNotDeleting(db, workspaceId, [row.id, database.id]);

  const patch = cleanRowPatch(
    body.patch && typeof body.patch === 'object' ? (body.patch as Record<string, unknown>) : {},
  );

  if (database.isLocked && !patchAllowedBy(lockedDatabasePatchKeys, patch)) {
    throw new Error('Database is locked.');
  }
  if (row.isLocked && !patchAllowedBy(lockedRowPatchKeys, patch)) {
    throw new Error('Database row is locked.');
  }

  let changedPropertyIds: Set<string> | undefined;
  // File ownership is determined from the complete next row, not only from
  // fields present in this patch. Icon/cover-only edits must therefore still
  // recognize raw legacy values stored in files-typed database properties.
  const rowDatabaseProperties = await listAll(
    propertiesTable.where('databaseId', '==', row.parentId),
  );
  const validatedRelationRows = new Map<string, Page | null>();
  if ('properties' in patch) {
    if (patch.properties !== undefined && patch.properties !== null && typeof patch.properties !== 'object') {
      throw new Error('properties must be an object.');
    }
    const normalizedProperties = await normalizeRowProperties(
      pages,
      row,
      rowDatabaseProperties,
      patch.properties && typeof patch.properties === 'object'
        ? (patch.properties as Record<string, unknown>)
        : {},
      {
        existing: row.properties ?? {},
        rejectReadonly: true,
        relationRows: validatedRelationRows,
      },
    );
    changedPropertyIds = new Set(Object.keys(normalizedProperties));
    patch.properties = {
      ...(row.properties ?? {}),
      ...normalizedProperties,
    };
  }

  const filePropertyIds = rowDatabaseProperties
    .filter((property) => property.type === 'files')
    .map((property) => property.id);

  const rowUpdateData = {
    ...patch,
    updatedAt: nowIso(),
    lastEditedBy: actorId,
    ...(mutationId && body.dryRun !== true ? { lastMutationId: mutationId } : {}),
  };
  const currentFileReferences = {
    icon: row.icon,
    cover: row.cover,
    properties: row.properties,
    schemaFileProperties: schemaFilePropertyReferences(row.properties, filePropertyIds),
  };
  const nextFileReferences = {
    icon: 'icon' in patch ? patch.icon : row.icon,
    cover: 'cover' in patch ? patch.cover : row.cover,
    properties: 'properties' in patch ? patch.properties : row.properties,
    schemaFileProperties: schemaFilePropertyReferences(
      'properties' in patch ? patch.properties : row.properties,
      filePropertyIds,
    ),
  };
  const hasCrossDatabaseRelationEffects = !!changedPropertyIds && rowDatabaseProperties.some(
    (property) => property.type === 'relation' && changedPropertyIds?.has(property.id),
  );
  const hasStoredFileReferenceChanges = storedFileReferencesChanged(
    currentFileReferences,
    nextFileReferences,
  );
  requireExclusiveFileWorkspaceLease(
    lease,
    hasCrossDatabaseRelationEffects
      || hasStoredFileReferenceChanges,
  );
  if (body.dryRun === true) {
    if (hasStoredFileReferenceChanges) {
      // Reuse the real lifecycle validator/planner so preview and commit reject
      // the same missing, foreign, incomplete, or ambiguous stored-file
      // references. The returned transaction operations are deliberately not
      // executed.
      await fileReferenceTransitionOperations(db, {
        table: 'pages',
        current: row,
        data: rowUpdateData,
        currentReferences: currentFileReferences,
        nextReferences: nextFileReferences,
        association: {
          field: 'pageId',
          id: row.id,
          filter: (upload) => !upload.blockId,
        },
        actorId,
      });
    }
    return { row: { ...row, ...rowUpdateData } as Page, affectedRows: [], dryRun: true };
  }
  let updated: Page;
  let collectedAffectedRows: Page[] | undefined;
  if (
    changedPropertyIds
    && changedPropertyIds.size > 0
    && !hasStoredFileReferenceChanges
  ) {
    const eventId = newId();
    const eventMutationId = mutationId ?? eventId;
    const relationPlans = hasCrossDatabaseRelationEffects
      ? await planReciprocalRelationUpdates({
          pages,
          propertiesTable,
          currentSourceRow: row,
          nextSourceRow: { ...row, ...rowUpdateData } as Page,
          sourceProps: rowDatabaseProperties,
          previousProperties: row.properties ?? {},
          nextProperties: rowUpdateData.properties ?? row.properties ?? {},
          changedPropertyIds,
          actorId,
          validatedRelationRows,
        })
      : [];
    const sourceRelationPlan = relationPlans.find((plan) => plan.current.id === id);
    const sourceUpdateData = sourceRelationPlan
      ? { ...rowUpdateData, ...sourceRelationPlan.data }
      : rowUpdateData;
    const externalRelationPlans = relationPlans.filter((plan) => plan.current.id !== id);
    const operations: TransactOperation[] = [
      directRowMutationExpectation(row),
      { table: 'pages', op: 'update', id, data: sourceUpdateData },
      ...externalRelationPlans.flatMap((plan): TransactOperation[] => [
        directRowMutationExpectation(plan.current),
        { table: 'pages', op: 'update', id: plan.current.id, data: plan.data },
      ]),
      {
        table: 'database_automation_events',
        op: 'insert',
        data: {
          id: eventId,
          workspaceId,
          databaseId: database.id,
          rowId: id,
          triggerKind: 'properties_edited',
          origin: 'user',
          mutationId: eventMutationId,
          changedPropertyIds: Array.from(changedPropertyIds).sort(),
          occurredAt: sourceUpdateData.updatedAt,
          state: 'pending',
        },
      },
    ];
    if (operations.length > MAX_COLLECTED_DATABASE_ROW_MUTATION_OPERATIONS) {
      throw Object.assign(
        new Error('Database row update produced too many collected writes.'),
        { status: 413 },
      );
    }
    try {
      const transaction = await db.transact(operations);
      updated = (transaction.results[1]?.updated as Page | undefined)
        ?? ({ ...row, ...sourceUpdateData } as Page);
      const committedExternalRows = new Map<string, Page>();
      externalRelationPlans.forEach((plan, index) => {
        committedExternalRows.set(
          plan.current.id,
          (transaction.results[3 + index * 2]?.updated as Page | undefined) ?? plan.next,
        );
      });
      collectedAffectedRows = relationPlans.map((plan) => (
        plan.current.id === id
          ? updated
          : committedExternalRows.get(plan.current.id) ?? plan.next
      ));
    } catch (error) {
      if (isTransactionConflictError(error)) {
        throw Object.assign(new Error('Database row changed since it was loaded.'), { status: 409 });
      }
      throw error;
    }
  } else if (hasStoredFileReferenceChanges) {
    const [fileTransitions, relationPlans] = await Promise.all([
      fileReferenceTransitionOperations(db, {
        table: 'pages',
        current: row,
        data: rowUpdateData,
        currentReferences: currentFileReferences,
        nextReferences: nextFileReferences,
        association: {
          field: 'pageId',
          id: row.id,
          filter: (upload) => !upload.blockId,
        },
        actorId,
      }),
      hasCrossDatabaseRelationEffects
        ? planReciprocalRelationUpdates({
            pages,
            propertiesTable,
            currentSourceRow: row,
            nextSourceRow: { ...row, ...rowUpdateData } as Page,
            sourceProps: rowDatabaseProperties,
            previousProperties: row.properties ?? {},
            nextProperties: rowUpdateData.properties ?? row.properties ?? {},
            changedPropertyIds: changedPropertyIds ?? new Set<string>(),
            actorId,
            validatedRelationRows,
          })
        : Promise.resolve([]),
    ]);
    const sourceRelationPlan = relationPlans.find((plan) => plan.current.id === id);
    const sourceUpdateData = sourceRelationPlan
      ? { ...rowUpdateData, ...sourceRelationPlan.data }
      : rowUpdateData;
    const externalRelationPlans = relationPlans.filter((plan) => plan.current.id !== id);
    const eventId = changedPropertyIds?.size ? newId() : undefined;
    const operations: TransactOperation[] = [
      directRowMutationExpectation(row),
      ...fileTransitions,
      { table: 'pages', op: 'update', id, data: sourceUpdateData },
      ...externalRelationPlans.flatMap((plan): TransactOperation[] => [
        directRowMutationExpectation(plan.current),
        { table: 'pages', op: 'update', id: plan.current.id, data: plan.data },
      ]),
      ...(eventId ? [{
        table: 'database_automation_events' as const,
        op: 'insert' as const,
        data: {
          id: eventId,
          workspaceId,
          databaseId: database.id,
          rowId: id,
          triggerKind: 'properties_edited',
          origin: 'user',
          mutationId: mutationId ?? eventId,
          changedPropertyIds: Array.from(changedPropertyIds ?? []).sort(),
          occurredAt: sourceUpdateData.updatedAt,
          state: 'pending',
        },
      }] : []),
    ];
    if (operations.length > MAX_RAW_TRANSACT_OPS) {
      throw Object.assign(
        new Error('Database row update produced too many collected file or relation writes.'),
        { status: 413 },
      );
    }
    try {
      const transaction = await db.transact(operations);
      const sourceResultIndex = 1 + fileTransitions.length;
      updated = (transaction.results[sourceResultIndex]?.updated as Page | undefined)
        ?? ({ ...row, ...sourceUpdateData } as Page);
      const committedExternalRows = new Map<string, Page>();
      externalRelationPlans.forEach((plan, index) => {
        committedExternalRows.set(
          plan.current.id,
          (transaction.results[sourceResultIndex + 2 + index * 2]?.updated as Page | undefined)
            ?? plan.next,
        );
      });
      collectedAffectedRows = relationPlans.map((plan) => (
        plan.current.id === id
          ? updated
          : committedExternalRows.get(plan.current.id) ?? plan.next
      ));
    } catch (error) {
      if (isTransactionConflictError(error)) {
        throw Object.assign(new Error('Database row changed since it was loaded.'), { status: 409 });
      }
      throw error;
    }
  } else {
    updated = await pages.update(id, rowUpdateData);
  }
  const affectedRows = collectedAffectedRows ?? (
    changedPropertyIds && row.parentId
      ? await syncReciprocalRelations({
          pages,
          propertiesTable,
          sourceRow: updated,
          sourceProps: rowDatabaseProperties,
          previousProperties: row.properties ?? {},
          nextProperties: updated.properties ?? {},
          changedPropertyIds,
          actorId,
        })
      : []
  );
  const finalRow = affectedRows.find((page) => page.id === updated.id) ?? updated;
  await bestEffort(
    'database-row-mutation upsertDatabaseIndexesForRows',
    affectedRows.length > 0
      ? upsertDatabaseIndexesForRows(db, uniqueById([finalRow, ...affectedRows]))
      : upsertDatabaseRowIndexes(db, finalRow, rowDatabaseProperties),
  );
  return { row: finalRow, affectedRows };
}

async function updateDatabaseRow(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const pages = db.table<Page>('pages');
  const id = requireString(body.id, 'id');
  const initialRow = await getExisting(pages, id);
  if (!initialRow) throw new Error('Database row was not found.');
  if (initialRow.parentType !== 'database' || !initialRow.parentId) {
    throw new Error('Page is not a database row.');
  }
  if (body.dryRun === true) {
    const mutationDuringDryRun = () => {
      throw new Error('Database-row dry run attempted to mutate its file-workspace lease.');
    };
    const previewLease: FileWorkspaceLeaseGuard = {
      lease: { id: `dry-run:${initialRow.workspaceId}`, leaseId: 'dry-run' },
      assertOwned: async () => {},
      renew: async () => mutationDuringDryRun(),
      setRecoveryData: async () => mutationDuringDryRun(),
      preserveForRecovery: mutationDuringDryRun,
    };
    return updateDatabaseRowUnderWorkspaceLease(
      db,
      body,
      actorId,
      initialRow.workspaceId,
      previewLease,
      actorEmail,
    );
  }
  return withDatabaseFileWorkspaceLease(
    db,
    initialRow.workspaceId,
    initialRow.parentId,
    actorId,
    'database-row-schema-update',
    (lease) => updateDatabaseRowUnderWorkspaceLease(
      db,
      body,
      actorId,
      initialRow.workspaceId,
      lease,
      actorEmail,
    ),
  );
}

async function moveDatabaseRow(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const id = requireString(body.id ?? body.rowId, 'rowId');
  const targetId = requireString(body.targetId, 'targetId');
  if (id === targetId) throw new Error('Cannot move a row relative to itself.');

  const side = typeof body.side === 'string' ? body.side.trim().toLowerCase() : 'after';
  if (side !== 'before' && side !== 'after') throw new Error('side must be before or after.');

  const { pages, row, database } = await getDatabaseRowContext(db, id, actorId, { actorEmail });
  const target = await getExisting(pages, targetId);
  if (!target || target.parentType !== 'database' || target.inTrash) {
    throw new Error('Target database row was not found.');
  }
  if (target.parentId !== row.parentId) {
    throw new Error('Rows must belong to the same database.');
  }

  const neighbors = await databaseRowMoveNeighbors(
    pages,
    database.id,
    row.id,
    target,
    side,
  );
  const position = positionBetween(neighbors.previousPosition, neighbors.nextPosition);
  if (body.dryRun === true) {
    return {
      row: {
        ...row,
        position,
        updatedAt: nowIso(),
        lastEditedBy: actorId,
      },
      target,
      side,
      position,
      dryRun: true,
    };
  }
  const updated = await pages.update(row.id, {
    position,
    updatedAt: nowIso(),
    lastEditedBy: actorId,
  });
  await bestEffort('database-row-mutation upsertDatabaseIndexesForRows', upsertDatabaseIndexesForRows(db, [updated]));

  return { row: updated, target, side, position };
}

interface DatabaseHierarchyMove {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  targetParentId: string;
  sourceParentId: string;
  cursorAncestorId: string;
  tortoiseAncestorId: string;
  hareAncestorId: string;
  featureRevision: number;
  requestedBy: string;
  updatedAt: string;
}

interface DatabaseHierarchyMoveReceipt {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  mutationId: string;
  targetParentId: string;
  resultRevision: number;
  requestedBy: string;
  completedAt: string;
  createdAt?: string;
  updatedAt?: string;
}

interface SubitemFeatureBinding extends Record<string, unknown> {
  enabled: true;
  parentPropertyId: string;
  childrenPropertyId: string;
  revision: number;
}

interface DependencyFeatureBindingBase extends Record<string, unknown> {
  enabled: true;
  predecessorPropertyId: string;
  successorPropertyId: string;
  shiftMode: 'overlap' | 'maintain_spacing' | 'none';
  avoidWeekends: boolean;
  dataKey?: string;
  revision: number;
}

type DependencyFeatureBinding = DependencyFeatureBindingBase & (
  | {
      dateMode: 'range';
      datePropertyId: string;
    }
  | {
      dateMode: 'separate';
      startDatePropertyId: string;
      endDatePropertyId: string;
    }
);

const HIERARCHY_ANCESTOR_STEPS_PER_REQUEST = 31;

function subitemFeatureBinding(database: Page): SubitemFeatureBinding {
  const features = recordObject(database.databaseFeatures);
  const binding = recordObject(features?.subitems);
  const parentPropertyId = typeof binding?.parentPropertyId === 'string'
    ? binding.parentPropertyId.trim()
    : '';
  const childrenPropertyId = typeof binding?.childrenPropertyId === 'string'
    ? binding.childrenPropertyId.trim()
    : '';
  const revision = Number(binding?.revision);
  if (
    binding?.enabled !== true
    || !parentPropertyId
    || !childrenPropertyId
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) {
    throw Object.assign(
      new Error('Sub-item hierarchy is not enabled for this database.'),
      { status: 409 },
    );
  }
  return {
    ...binding,
    enabled: true,
    parentPropertyId,
    childrenPropertyId,
    revision,
  };
}

function dependencyFeatureBinding(database: Page): DependencyFeatureBinding {
  const binding = recordObject(recordObject(database.databaseFeatures)?.dependencies);
  const predecessorPropertyId = typeof binding?.predecessorPropertyId === 'string'
    ? binding.predecessorPropertyId.trim()
    : '';
  const successorPropertyId = typeof binding?.successorPropertyId === 'string'
    ? binding.successorPropertyId.trim()
    : '';
  const dateMode = binding?.dateMode === undefined || binding?.dateMode === 'range'
    ? 'range'
    : binding.dateMode === 'separate'
      ? 'separate'
      : null;
  const shiftMode = binding?.shiftMode;
  const revision = Number(binding?.revision);
  if (
    binding?.enabled !== true
    || !predecessorPropertyId
    || !successorPropertyId
    || !dateMode
    || !['overlap', 'maintain_spacing', 'none'].includes(String(shiftMode))
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) {
    throw Object.assign(new Error('Dependencies are not enabled for this database.'), { status: 409 });
  }
  const common: DependencyFeatureBindingBase = {
    ...binding,
    enabled: true,
    predecessorPropertyId,
    successorPropertyId,
    shiftMode: shiftMode as DependencyFeatureBinding['shiftMode'],
    avoidWeekends: binding.avoidWeekends === true,
    ...(typeof binding.dataKey === 'string' && binding.dataKey.trim()
      ? { dataKey: binding.dataKey.trim() }
      : {}),
    revision,
  };
  if (dateMode === 'range') {
    const datePropertyId = typeof binding.datePropertyId === 'string'
      ? binding.datePropertyId.trim()
      : '';
    if (!datePropertyId) {
      throw Object.assign(new Error('Dependencies are not enabled for this database.'), { status: 409 });
    }
    return { ...common, dateMode, datePropertyId };
  }
  const startDatePropertyId = typeof binding.startDatePropertyId === 'string'
    ? binding.startDatePropertyId.trim()
    : '';
  const endDatePropertyId = typeof binding.endDatePropertyId === 'string'
    ? binding.endDatePropertyId.trim()
    : '';
  if (!startDatePropertyId || !endDatePropertyId || startDatePropertyId === endDatePropertyId) {
    throw Object.assign(new Error('Dependencies are not enabled for this database.'), { status: 409 });
  }
  return { ...common, dateMode, startDatePropertyId, endDatePropertyId };
}

function requestedSubitemParentId(body: Record<string, unknown>) {
  if (!Object.prototype.hasOwnProperty.call(body, 'parentRowId')) {
    throw new Error('parentRowId is required.');
  }
  if (body.parentRowId == null || body.parentRowId === '') return '';
  return requireString(body.parentRowId, 'parentRowId');
}

function hierarchyCycleError() {
  return Object.assign(
    new Error('Sub-item hierarchy cycle is not allowed.'),
    { status: 409 },
  );
}

function exactSubitemChildCount(page: Page) {
  const count = Number(page.subitemChildCount ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw Object.assign(new Error('Sub-item child count is invalid.'), { status: 409 });
  }
  return count;
}

function changedSubitemChildCount(page: Page, delta: -1 | 1) {
  const count = exactSubitemChildCount(page);
  const next = count + delta;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw Object.assign(new Error('Sub-item child count is inconsistent.'), { status: 409 });
  }
  return next;
}

function hierarchyRowExpectation(row: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: row.id,
    where: [
      ['workspaceId', '==', row.workspaceId],
      ['parentId', '==', row.parentId ?? null],
      ['parentType', '==', row.parentType],
      ['inTrash', '==', row.inTrash ?? null],
      ['subitemParentId', '==', row.subitemParentId ?? ''],
      ['subitemChildCount', '==', exactSubitemChildCount(row)],
      ['lastMutationId', '==', row.lastMutationId ?? null],
      ['updatedAt', '==', row.updatedAt ?? null],
    ],
    exists: true,
  };
}

function hierarchyDatabaseExpectation(database: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: database.id,
    where: [
      ['workspaceId', '==', database.workspaceId],
      ['databaseFeaturesRevision', '==', Number(database.databaseFeaturesRevision ?? 0)],
      ['inTrash', '==', database.inTrash ?? null],
      ['isLocked', '==', database.isLocked ?? null],
    ],
    exists: true,
  };
}

function hierarchyJobExpectation(job: DatabaseHierarchyMove): TransactOperation {
  return {
    table: 'database_hierarchy_moves',
    op: 'expect',
    id: job.id,
    where: [
      ['databaseId', '==', job.databaseId],
      ['rowId', '==', job.rowId],
      ['targetParentId', '==', job.targetParentId],
      ['featureRevision', '==', job.featureRevision],
      ['requestedBy', '==', job.requestedBy],
      ['updatedAt', '==', job.updatedAt],
    ],
    exists: true,
  };
}

function hierarchyJobData(job: DatabaseHierarchyMove) {
  return {
    workspaceId: job.workspaceId,
    databaseId: job.databaseId,
    rowId: job.rowId,
    targetParentId: job.targetParentId,
    sourceParentId: job.sourceParentId,
    cursorAncestorId: job.cursorAncestorId,
    tortoiseAncestorId: job.tortoiseAncestorId,
    hareAncestorId: job.hareAncestorId,
    featureRevision: job.featureRevision,
    requestedBy: job.requestedBy,
    updatedAt: job.updatedAt,
  };
}

function hierarchyMoveReplayResult(
  receipt: DatabaseHierarchyMoveReceipt,
  row: Page,
  database: Page,
  mutationId: string,
  targetParentId: string,
  actorId: string,
) {
  const currentRevision = Number(database.databaseFeaturesRevision ?? 0);
  if (
    receipt.id !== mutationId
    || receipt.mutationId !== mutationId
    || receipt.workspaceId !== row.workspaceId
    || receipt.databaseId !== database.id
    || receipt.rowId !== row.id
    || receipt.targetParentId !== targetParentId
    || receipt.requestedBy !== actorId
    || !Number.isSafeInteger(receipt.resultRevision)
    || receipt.resultRevision < 1
    || receipt.resultRevision > currentRevision
  ) {
    throw Object.assign(
      new Error('Hierarchy mutation id was already used for another request.'),
      { status: 409 },
    );
  }
  return {
    status: 'completed',
    replayed: true,
    completedMutationId: receipt.mutationId,
    completedTargetParentId: receipt.targetParentId,
    row,
    database,
    databaseFeaturesRevision: receipt.resultRevision,
  };
}

async function reparentDatabaseSubitemUnderLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  actorEmail?: string | null,
) {
  const rowId = requireString(body.rowId ?? body.id, 'rowId');
  const targetParentId = requestedSubitemParentId(body);
  const mutationId = requireString(body.mutationId, 'mutationId');
  const { pages, row, database } = await getDatabaseRowContext(
    db,
    rowId,
    actorId,
    { actorEmail },
  );
  if (row.workspaceId !== workspaceId || database.workspaceId !== workspaceId) {
    throw Object.assign(
      new Error('Database row changed workspaces while its hierarchy was being updated.'),
      { status: 409 },
    );
  }
  await assertCanEditPage(db, database, actorId, actorEmail);
  const binding = subitemFeatureBinding(database);
  const completedReceipt = await getExisting(
    db.table<DatabaseHierarchyMoveReceipt>('database_hierarchy_move_receipts'),
    mutationId,
  );
  if (completedReceipt) {
    return hierarchyMoveReplayResult(
      completedReceipt,
      row,
      database,
      mutationId,
      targetParentId,
      actorId,
    );
  }
  await assertNoActiveDependencyDateShift(db, database);
  const featureRevision = Number(database.databaseFeaturesRevision ?? 0);
  const sourceParentId = row.subitemParentId ?? '';
  const activeLifecycle = await db
    .table<DatabaseHierarchyLifecycleJob>('database_hierarchy_lifecycle_jobs')
    .where('databaseId', '==', database.id)
    .limit(1)
    .getList();
  if ((activeLifecycle.items ?? []).length > 0) {
    throw Object.assign(
      new Error('A database hierarchy lifecycle operation is in progress.'),
      { status: 409 },
    );
  }

  if (targetParentId === row.id) throw hierarchyCycleError();

  const hierarchyParentIds = Array.from(new Set(
    [sourceParentId, targetParentId].filter((id): id is string => Boolean(id)),
  ));
  const hierarchyParents = hierarchyParentIds.length > 0
    ? await pages.where('id', 'in', hierarchyParentIds).limit(hierarchyParentIds.length).getList()
    : { items: [] as Page[] };
  const hierarchyParentsById = new Map(
    (hierarchyParents.items ?? []).map((parent) => [parent.id, parent]),
  );
  const validHierarchyParent = (parent: Page | undefined) => Boolean(
    parent
    && parent.workspaceId === row.workspaceId
    && parent.parentType === 'database'
    && parent.parentId === database.id
    && parent.kind !== 'database'
    && !parent.inTrash,
  );
  const sourceParent = sourceParentId ? hierarchyParentsById.get(sourceParentId) : undefined;
  const targetParent = targetParentId ? hierarchyParentsById.get(targetParentId) : undefined;
  if (sourceParentId && !validHierarchyParent(sourceParent)) {
    throw Object.assign(
      new Error('Current sub-item parent must be a live row in the same database.'),
      { status: 409 },
    );
  }
  if (targetParentId && !validHierarchyParent(targetParent)) {
    throw Object.assign(
      new Error('Sub-item parent must be a live row in the same database.'),
      { status: 409 },
    );
  }
  if (targetParent) await assertCanEditPage(db, targetParent, actorId, actorEmail);

  const jobs = db.table<DatabaseHierarchyMove>('database_hierarchy_moves');
  const existingJob = await getExisting(jobs, mutationId);
  if (existingJob && (
    existingJob.workspaceId !== row.workspaceId
    || existingJob.databaseId !== database.id
    || existingJob.rowId !== row.id
    || existingJob.targetParentId !== targetParentId
    || existingJob.requestedBy !== actorId
  )) {
    throw Object.assign(
      new Error('Hierarchy mutation id is already in use.'),
      { status: 409 },
    );
  }

  const restart = !existingJob
    || existingJob.featureRevision !== featureRevision
    || existingJob.sourceParentId !== sourceParentId;
  let cursorAncestorId = restart ? targetParentId : existingJob.cursorAncestorId;
  let tortoiseAncestorId = restart ? targetParentId : existingJob.tortoiseAncestorId;
  let hareAncestorId = restart ? targetParentId : existingJob.hareAncestorId;

  // Floyd's tortoise/hare state detects a malformed pre-existing cycle with
  // constant durable memory. The per-request cache collapses the overlapping
  // cursor/tortoise/hare point reads: 31 steps inspect at most 62 distinct
  // ancestors before yielding, while no hierarchy depth is rejected.
  const pageCache = new Map<string, Page>();
  pageCache.set(row.id, row);
  pageCache.set(database.id, database);
  if (targetParent) pageCache.set(targetParent.id, targetParent);
  if (sourceParent) pageCache.set(sourceParent.id, sourceParent);
  const nextAncestor = async (ancestorId: string) => {
    if (!ancestorId) return '';
    if (ancestorId === row.id) throw hierarchyCycleError();
    let ancestor = pageCache.get(ancestorId) ?? null;
    if (!ancestor) {
      ancestor = await getExisting(pages, ancestorId);
      if (ancestor) pageCache.set(ancestor.id, ancestor);
    }
    if (
      !ancestor
      || ancestor.workspaceId !== row.workspaceId
      || ancestor.parentType !== 'database'
      || ancestor.parentId !== database.id
      || ancestor.kind === 'database'
      || ancestor.inTrash
    ) {
      throw Object.assign(
        new Error('Sub-item ancestor must be a live row in the same database.'),
        { status: 409 },
      );
    }
    const parentId = ancestor.subitemParentId ?? '';
    if (parentId === row.id) throw hierarchyCycleError();
    return parentId;
  };

  let complete = !cursorAncestorId;
  for (
    let step = 0;
    step < HIERARCHY_ANCESTOR_STEPS_PER_REQUEST && !complete;
    step += 1
  ) {
    cursorAncestorId = await nextAncestor(cursorAncestorId);
    if (!cursorAncestorId) {
      complete = true;
      break;
    }
    tortoiseAncestorId = await nextAncestor(tortoiseAncestorId);
    hareAncestorId = await nextAncestor(hareAncestorId);
    if (hareAncestorId) hareAncestorId = await nextAncestor(hareAncestorId);
    if (
      tortoiseAncestorId
      && hareAncestorId
      && tortoiseAncestorId === hareAncestorId
    ) {
      throw hierarchyCycleError();
    }
  }

  if (!complete) {
    const updatedAt = nowIso();
    const nextJob: DatabaseHierarchyMove = {
      id: mutationId,
      workspaceId: row.workspaceId,
      databaseId: database.id,
      rowId: row.id,
      targetParentId,
      sourceParentId,
      cursorAncestorId,
      tortoiseAncestorId,
      hareAncestorId,
      featureRevision,
      requestedBy: actorId,
      updatedAt,
    };
    const operations: TransactOperation[] = [
      hierarchyDatabaseExpectation(database),
      hierarchyRowExpectation(row),
    ];
    if (existingJob) {
      operations.push(
        hierarchyJobExpectation(existingJob),
        {
          table: 'database_hierarchy_moves',
          op: 'update',
          id: existingJob.id,
          data: hierarchyJobData(nextJob),
        },
      );
    } else {
      operations.push(
        { table: 'database_hierarchy_moves', op: 'expect', id: mutationId, exists: false },
        {
          table: 'database_hierarchy_moves',
          op: 'insert',
          data: { id: nextJob.id, ...hierarchyJobData(nextJob) },
        },
      );
    }
    await db.transact(operations);
    return {
      status: 'pending',
      replayed: false,
      jobId: mutationId,
      databaseFeaturesRevision: featureRevision,
    };
  }

  const updatedAt = nowIso();
  const nextFeatureRevision = featureRevision + 1;
  const currentFeatures = cloneJson(recordObject(database.databaseFeatures) ?? {});
  const nextFeatures = {
    ...currentFeatures,
    subitems: {
      ...binding,
      revision: binding.revision + 1,
    },
  };
  const receipt: DatabaseHierarchyMoveReceipt = {
    id: mutationId,
    workspaceId: row.workspaceId,
    databaseId: database.id,
    rowId: row.id,
    mutationId,
    targetParentId,
    resultRevision: nextFeatureRevision,
    requestedBy: actorId,
    completedAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
  };
  const operations: TransactOperation[] = [
    hierarchyDatabaseExpectation(database),
    hierarchyRowExpectation(row),
    {
      table: 'database_hierarchy_move_receipts',
      op: 'expect',
      id: receipt.id,
      exists: false,
    },
  ];
  if (existingJob) operations.push(hierarchyJobExpectation(existingJob));
  if (sourceParentId !== targetParentId) {
    if (sourceParent) {
      operations.push(
        hierarchyRowExpectation(sourceParent),
        {
          table: 'pages',
          op: 'update',
          id: sourceParent.id,
          data: { subitemChildCount: changedSubitemChildCount(sourceParent, -1) },
        },
      );
    }
    if (targetParent) {
      operations.push(
        hierarchyRowExpectation(targetParent),
        {
          table: 'pages',
          op: 'update',
          id: targetParent.id,
          data: { subitemChildCount: changedSubitemChildCount(targetParent, 1) },
        },
      );
    }
  }
  operations.push(
    {
      table: 'pages',
      op: 'update',
      id: row.id,
      data: {
        subitemParentId: targetParentId,
        lastMutationId: mutationId,
        lastEditedBy: actorId,
        updatedAt,
      },
    },
    {
      table: 'pages',
      op: 'update',
      id: database.id,
      data: {
        databaseFeatures: nextFeatures,
        databaseFeaturesRevision: nextFeatureRevision,
        lastEditedBy: actorId,
        updatedAt,
      },
    },
    {
      table: 'database_hierarchy_move_receipts',
      op: 'insert',
      data: receipt as unknown as Record<string, unknown>,
    },
  );
  if (existingJob) {
    operations.push({ table: 'database_hierarchy_moves', op: 'delete', id: existingJob.id });
  }
  await db.transact(operations);

  return {
    status: 'completed',
    replayed: false,
    completedMutationId: mutationId,
    completedTargetParentId: targetParentId,
    row: {
      ...row,
      subitemParentId: targetParentId,
      lastMutationId: mutationId,
      lastEditedBy: actorId,
      updatedAt,
    },
    database: {
      ...database,
      databaseFeatures: nextFeatures,
      databaseFeaturesRevision: nextFeatureRevision,
      lastEditedBy: actorId,
      updatedAt,
    },
    databaseFeaturesRevision: nextFeatureRevision,
  };
}

async function reparentDatabaseSubitem(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const rowId = requireString(body.rowId ?? body.id, 'rowId');
  const initial = await getExisting(db.table<Page>('pages'), rowId);
  if (!initial) throw new Error('Database row was not found.');
  if (initial.parentType !== 'database' || !initial.parentId) {
    throw new Error('Page is not a database row.');
  }
  const mutationId = requireString(body.mutationId, 'mutationId');
  const targetParentId = requestedSubitemParentId(body);
  const completedReceipt = await getExisting(
    db.table<DatabaseHierarchyMoveReceipt>('database_hierarchy_move_receipts'),
    mutationId,
  );
  if (completedReceipt) {
    const { row, database } = await getDatabaseRowContext(
      db,
      rowId,
      actorId,
      { actorEmail },
    );
    await assertCanEditPage(db, database, actorId, actorEmail);
    subitemFeatureBinding(database);
    return hierarchyMoveReplayResult(
      completedReceipt,
      row,
      database,
      mutationId,
      targetParentId,
      actorId,
    );
  }
  return withDatabaseFileWorkspaceLease(
    db,
    initial.workspaceId,
    initial.parentId,
    actorId,
    'database-subitem-reparent',
    () => reparentDatabaseSubitemUnderLease(
      db,
      body,
      actorId,
      initial.workspaceId,
      actorEmail,
    ),
  );
}

const DEPENDENCY_MUTATION_EDGE_LIMIT = 16;
const DEPENDENCY_VALIDATION_EDGE_WINDOW = 8;
const DEPENDENCY_VALIDATION_CLEANUP_WINDOW = 128;

function dependencyMutationIds(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const ids = Array.from(new Set(value.map((item) => requireString(item, field))));
  if (ids.length > DEPENDENCY_MUTATION_EDGE_LIMIT) {
    throw Object.assign(
      new Error(`${field} supports at most ${DEPENDENCY_MUTATION_EDGE_LIMIT} edge deltas per request.`),
      { status: 413 },
    );
  }
  return ids.sort();
}

async function dependencyMutationRequestHash(
  rowId: string,
  additions: string[],
  removals: string[],
) {
  return hierarchyLifecycleStableId(
    'database-dependency-mutation-request',
    rowId,
    JSON.stringify(additions),
    JSON.stringify(removals),
  );
}

function dependencyValidationJobExpectation(
  job: DatabaseDependencyValidationJob,
): TransactOperation {
  return {
    table: 'database_dependency_validation_jobs',
    op: 'expect',
    id: job.id,
    where: [
      ['databaseId', '==', job.databaseId],
      ['rowId', '==', job.rowId],
      ['mutationId', '==', job.mutationId],
      ['requestHash', '==', job.requestHash],
      ['featureRevision', '==', job.featureRevision],
      ...(job.dataKey ? [['dataKey', '==', job.dataKey] as [string, '==', unknown]] : []),
      ['requestedBy', '==', job.requestedBy],
      ['validationComplete', '==', job.validationComplete],
    ],
    exists: true,
  };
}

function dependencyValidationItemExpectation(
  item: DatabaseDependencyValidationItem,
): TransactOperation {
  return {
    table: 'database_dependency_validation_items',
    op: 'expect',
    id: item.id,
    where: [
      ['jobId', '==', item.jobId],
      ['databaseId', '==', item.databaseId],
      ['featureRevision', '==', item.featureRevision],
      ['additionIndex', '==', item.additionIndex],
      ['rowId', '==', item.rowId],
      ['edgeCursorId', '==', item.edgeCursorId],
      ['proposedScanned', '==', item.proposedScanned],
      ['expanded', '==', item.expanded],
    ],
    exists: true,
  };
}

async function dependencyEdgeForPair(
  db: DbRef,
  databaseId: string,
  predecessorRowId: string,
  successorRowId: string,
  dataKey?: string,
) {
  let query: TableQuery<DatabaseDependencyEdge> = db
    .table<DatabaseDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', databaseId);
  if (typeof query.where !== 'function') {
    throw Object.assign(new Error('Dependency mutation requires bounded edge lookup.'), { status: 500 });
  }
  if (dataKey) query = query.where!('dataKey', '==', dataKey);
  query = query
    .where!('predecessorRowId', '==', predecessorRowId)
    .where!('successorRowId', '==', successorRowId);
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function dependencyValidationItemForRow(
  db: DbRef,
  job: DatabaseDependencyValidationJob,
  additionIndex: number,
  rowId: string,
) {
  let query: TableQuery<DatabaseDependencyValidationItem> = db
    .table<DatabaseDependencyValidationItem>('database_dependency_validation_items')
    .where('jobId', '==', job.id);
  if (typeof query.where !== 'function') {
    throw Object.assign(new Error('Dependency validation requires bounded visited lookup.'), { status: 500 });
  }
  query = query
    .where!('featureRevision', '==', job.featureRevision)
    .where!('additionIndex', '==', additionIndex)
    .where!('rowId', '==', rowId);
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function firstDependencyValidationItem(db: DbRef, job: DatabaseDependencyValidationJob) {
  let query: TableQuery<DatabaseDependencyValidationItem> = db
    .table<DatabaseDependencyValidationItem>('database_dependency_validation_items')
    .where('jobId', '==', job.id);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Dependency validation requires bounded frontier queries.'), { status: 500 });
  }
  query = query
    .where!('featureRevision', '==', job.featureRevision)
    .where!('expanded', '==', false)
    .orderBy!('additionIndex', 'asc')
    .orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function dependencyValidationEdgeWindow(
  db: DbRef,
  job: DatabaseDependencyValidationJob,
  item: DatabaseDependencyValidationItem,
) {
  let query: TableQuery<DatabaseDependencyEdge> = db
    .table<DatabaseDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', job.databaseId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Dependency validation requires bounded edge keysets.'), { status: 500 });
  }
  if (job.dataKey) query = query.where!('dataKey', '==', job.dataKey);
  query = query.where!('predecessorRowId', '==', item.rowId);
  if (item.edgeCursorId) query = query.where!('id', '>', item.edgeCursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const candidates = (await query.limit(DEPENDENCY_VALIDATION_EDGE_WINDOW + 1).getList()).items ?? [];
  const rows = candidates
    .filter((edge) => (
      edge.databaseId === job.databaseId
      && (!job.dataKey || edge.dataKey === job.dataKey)
      && edge.predecessorRowId === item.rowId
      && (!item.edgeCursorId || edge.id > item.edgeCursorId)
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    rows: rows.slice(0, DEPENDENCY_VALIDATION_EDGE_WINDOW),
    hasMore: rows.length > DEPENDENCY_VALIDATION_EDGE_WINDOW,
  };
}

async function markDependencyValidationRejected(
  db: DbRef,
  job: DatabaseDependencyValidationJob,
  message: string,
) {
  await db.transact([
    dependencyValidationJobExpectation(job),
    {
      table: 'database_dependency_validation_jobs',
      op: 'update',
      id: job.id,
      data: { validationComplete: true, failureMessage: message, updatedAt: nowIso() },
    },
  ]);
}

async function rejectDependencyValidationJob(
  db: DbRef,
  job: DatabaseDependencyValidationJob,
) {
  const message = job.failureMessage || 'Dependency mutation was rejected.';
  const receipt: DatabaseDependencyMutationReceipt = {
    id: await hierarchyLifecycleStableId(
      'database-dependency-mutation-receipt',
      job.workspaceId,
      job.databaseId,
      job.rowId,
      job.mutationId,
    ),
    workspaceId: job.workspaceId,
    databaseId: job.databaseId,
    rowId: job.rowId,
    mutationId: job.mutationId,
    requestHash: job.requestHash,
    resultRevision: job.featureRevision,
    requestedBy: job.requestedBy,
    status: 'rejected',
    failureMessage: message,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await db.transact([
    dependencyValidationJobExpectation(job),
    { table: 'database_dependency_mutation_receipts', op: 'expect', id: receipt.id, exists: false },
    {
      table: 'database_dependency_mutation_receipts',
      op: 'insert',
      data: receipt as unknown as Record<string, unknown>,
    },
    { table: 'database_dependency_validation_jobs', op: 'delete', id: job.id },
  ]);
  throw Object.assign(new Error(message), { status: 409 });
}

async function advanceDependencyValidation(
  db: DbRef,
  job: DatabaseDependencyValidationJob,
) {
  const item = await firstDependencyValidationItem(db, job);
  if (!item) return false;
  const predecessorRowId = job.additions[item.additionIndex];
  if (!predecessorRowId) {
    throw Object.assign(new Error('Dependency validation frontier changed.'), { status: 409 });
  }
  if (item.rowId === predecessorRowId) {
    await markDependencyValidationRejected(db, job, 'Dependency cycle is not allowed.');
    return true;
  }
  const window = await dependencyValidationEdgeWindow(db, job, item);
  const removedPredecessors = new Set(job.removals);
  const successorIds = window.rows
    .filter((edge) => !(edge.successorRowId === job.rowId && removedPredecessors.has(edge.predecessorRowId)))
    .map((edge) => edge.successorRowId);
  if (!item.proposedScanned) {
    for (const index of job.validationAdditionIndexes) {
      const proposedPredecessor = job.additions[index];
      if (proposedPredecessor === item.rowId && index !== item.additionIndex) {
        successorIds.push(job.rowId);
      }
    }
  }
  const uniqueSuccessors = Array.from(new Set(successorIds));
  if (uniqueSuccessors.includes(predecessorRowId)) {
    await markDependencyValidationRejected(db, job, 'Dependency cycle is not allowed.');
    return true;
  }
  const newItems: DatabaseDependencyValidationItem[] = [];
  for (const successorId of uniqueSuccessors) {
    if (await dependencyValidationItemForRow(db, job, item.additionIndex, successorId)) continue;
    newItems.push({
      id: await hierarchyLifecycleStableId(
        'database-dependency-validation-item',
        job.id,
        String(job.featureRevision),
        String(item.additionIndex),
        successorId,
      ),
      workspaceId: job.workspaceId,
      jobId: job.id,
      databaseId: job.databaseId,
      featureRevision: job.featureRevision,
      additionIndex: item.additionIndex,
      rowId: successorId,
      edgeCursorId: '',
      proposedScanned: false,
      expanded: false,
    });
  }
  const last = window.rows.at(-1);
  await db.transact([
    dependencyValidationJobExpectation(job),
    dependencyValidationItemExpectation(item),
    ...window.rows.map(hierarchyDeleteDependencyEdgeExpectation),
    ...newItems.flatMap((candidate): TransactOperation[] => [
      { table: 'database_dependency_validation_items', op: 'expect', id: candidate.id, exists: false },
      {
        table: 'database_dependency_validation_items',
        op: 'insert',
        data: candidate as unknown as Record<string, unknown>,
      },
    ]),
    {
      table: 'database_dependency_validation_items',
      op: 'update',
      id: item.id,
      data: window.hasMore && last
        ? { edgeCursorId: last.id, proposedScanned: true }
        : { edgeCursorId: last?.id ?? '', proposedScanned: true, expanded: true },
    },
  ]);
  return true;
}

async function dependencyValidationAdditionIndexes(
  db: DbRef,
  databaseId: string,
  rowId: string,
  additions: string[],
  dataKey?: string,
) {
  const indexes: number[] = [];
  for (const [index, predecessorRowId] of additions.entries()) {
    if (!(await dependencyEdgeForPair(db, databaseId, predecessorRowId, rowId, dataKey))) indexes.push(index);
  }
  return indexes;
}

async function dependencyValidationStartItems(
  job: DatabaseDependencyValidationJob,
) {
  return Promise.all(job.validationAdditionIndexes.map(async (additionIndex) => ({
    id: await hierarchyLifecycleStableId(
      'database-dependency-validation-item',
      job.id,
      String(job.featureRevision),
      String(additionIndex),
      job.rowId,
    ),
    workspaceId: job.workspaceId,
    jobId: job.id,
    databaseId: job.databaseId,
    featureRevision: job.featureRevision,
    additionIndex,
    rowId: job.rowId,
    edgeCursorId: '',
    proposedScanned: false,
    expanded: false,
  } satisfies DatabaseDependencyValidationItem)));
}

async function cleanupDependencyValidationItems(
  db: DbRef,
  job: DatabaseDependencyValidationJob,
) {
  let query: TableQuery<DatabaseDependencyValidationItem> = db
    .table<DatabaseDependencyValidationItem>('database_dependency_validation_items')
    .where('jobId', '==', job.id);
  if (typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Dependency validation cleanup requires a bounded item keyset.'), { status: 500 });
  }
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const items = (await query.limit(DEPENDENCY_VALIDATION_CLEANUP_WINDOW).getList()).items ?? [];
  if (items.length === 0) return false;
  await db.transact([
    dependencyValidationJobExpectation(job),
    ...items.flatMap((item): TransactOperation[] => [
      dependencyValidationItemExpectation(item),
      { table: 'database_dependency_validation_items', op: 'delete', id: item.id },
    ]),
  ]);
  return true;
}

async function completeDependencyMutation(
  db: DbRef,
  database: Page,
  row: Page,
  binding: DependencyFeatureBinding,
  job: DatabaseDependencyValidationJob,
) {
  if (
    Number(database.databaseFeaturesRevision ?? 0) !== job.featureRevision
    || job.dataKey !== binding.dataKey
  ) {
    throw Object.assign(new Error('Dependency feature revision changed during validation.'), { status: 409 });
  }
  const receipt: DatabaseDependencyMutationReceipt = {
    id: await hierarchyLifecycleStableId(
      'database-dependency-mutation-receipt',
      job.workspaceId,
      job.databaseId,
      job.rowId,
      job.mutationId,
    ),
    workspaceId: job.workspaceId,
    databaseId: job.databaseId,
    rowId: job.rowId,
    mutationId: job.mutationId,
    requestHash: job.requestHash,
    resultRevision: job.featureRevision + 1,
    requestedBy: job.requestedBy,
    status: 'completed',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const operations: TransactOperation[] = [
    dependencyValidationJobExpectation(job),
    hierarchyDatabaseExpectation(database),
    {
      table: 'pages',
      op: 'expect',
      id: row.id,
      where: [
        ['workspaceId', '==', row.workspaceId],
        ['parentId', '==', database.id],
        ['parentType', '==', 'database'],
        ['inTrash', '==', false],
      ],
      exists: true,
    },
    { table: 'database_dependency_mutation_receipts', op: 'expect', id: receipt.id, exists: false },
  ];
  for (const predecessorRowId of job.removals) {
    const edge = await dependencyEdgeForPair(
      db, job.databaseId, predecessorRowId, job.rowId, binding.dataKey,
    );
    if (edge) operations.push(hierarchyDeleteDependencyEdgeExpectation(edge), {
      table: 'database_dependency_edges', op: 'delete', id: edge.id,
    });
  }
  const added: DatabaseDependencyEdge[] = [];
  for (const predecessorRowId of job.additions) {
    const existing = await dependencyEdgeForPair(
      db, job.databaseId, predecessorRowId, job.rowId, binding.dataKey,
    );
    if (existing) continue;
    const edge: DatabaseDependencyEdge = {
      id: await hierarchyLifecycleStableId(
        'database-dependency-edge',
        job.workspaceId,
        job.databaseId,
        binding.dataKey ?? '',
        predecessorRowId,
        job.rowId,
      ),
      workspaceId: job.workspaceId,
      databaseId: job.databaseId,
      ...(binding.dataKey ? { dataKey: binding.dataKey } : {}),
      predecessorRowId,
      successorRowId: job.rowId,
      createdBy: job.requestedBy,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    operations.push(
      { table: 'database_dependency_edges', op: 'expect', id: edge.id, exists: false },
      { table: 'database_dependency_edges', op: 'insert', data: edge as unknown as Record<string, unknown> },
    );
    added.push(edge);
  }
  const features = cloneJson(recordObject(database.databaseFeatures) ?? {});
  operations.push(
    {
      table: 'pages',
      op: 'update',
      id: database.id,
      data: {
        databaseFeatures: {
          ...features,
          dependencies: { ...binding, revision: binding.revision + 1 },
        },
        databaseFeaturesRevision: job.featureRevision + 1,
        updatedAt: nowIso(),
        lastEditedBy: job.requestedBy,
      },
    },
    {
      table: 'database_dependency_mutation_receipts',
      op: 'insert',
      data: receipt as unknown as Record<string, unknown>,
    },
    { table: 'database_dependency_validation_jobs', op: 'delete', id: job.id },
  );
  await db.transact(operations);
  return {
    status: 'completed',
    replayed: false,
    completedMutationId: job.mutationId,
    completedRowId: job.rowId,
    completedAddPredecessorIds: job.additions,
    completedRemovePredecessorIds: job.removals,
    databaseFeaturesRevision: receipt.resultRevision,
    added,
    removedPredecessorIds: job.removals,
  };
}

async function updateDatabaseDependenciesUnderLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  actorEmail?: string | null,
) {
  const rowId = requireString(body.rowId ?? body.id, 'rowId');
  const mutationId = requireString(body.mutationId, 'mutationId');
  const additions = dependencyMutationIds(body.addPredecessorIds ?? [], 'addPredecessorIds');
  const removals = dependencyMutationIds(body.removePredecessorIds ?? [], 'removePredecessorIds');
  if (additions.length === 0 && removals.length === 0) {
    throw new Error('At least one dependency edge delta is required.');
  }
  if (additions.some((id) => removals.includes(id))) {
    throw new Error('The same predecessor cannot be added and removed together.');
  }
  const { row, database } = await getDatabaseRowContext(db, rowId, actorId, { actorEmail });
  if (row.workspaceId !== workspaceId || database.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Dependency mutation changed workspaces.'), { status: 409 });
  }
  await assertCanEditPage(db, database, actorId, actorEmail);
  const binding = dependencyFeatureBinding(database);
  await assertNoActiveDependencyDateShift(db, database);
  const requestHash = await dependencyMutationRequestHash(row.id, additions, removals);
  const receiptId = await hierarchyLifecycleStableId(
    'database-dependency-mutation-receipt',
    row.workspaceId,
    database.id,
    row.id,
    mutationId,
  );
  const receipt = await getExisting(
    db.table<DatabaseDependencyMutationReceipt>('database_dependency_mutation_receipts'),
    receiptId,
  );
  if (receipt) {
    if (receipt.requestHash !== requestHash || receipt.requestedBy !== actorId) {
      throw Object.assign(new Error('Dependency mutation id was reused for another request.'), { status: 409 });
    }
    if (receipt.status === 'rejected') {
      throw Object.assign(new Error(receipt.failureMessage ?? 'Dependency mutation was rejected.'), { status: 409 });
    }
    return {
      status: 'completed',
      replayed: true,
      completedMutationId: mutationId,
      completedRowId: row.id,
      completedAddPredecessorIds: additions,
      completedRemovePredecessorIds: removals,
      databaseFeaturesRevision: receipt.resultRevision,
      added: [] as DatabaseDependencyEdge[],
      removedPredecessorIds: removals,
    };
  }
  const activeHierarchy = await db
    .table<DatabaseHierarchyLifecycleJob>('database_hierarchy_lifecycle_jobs')
    .where('databaseId', '==', database.id)
    .limit(1)
    .getList();
  if ((activeHierarchy.items ?? []).length > 0) {
    throw Object.assign(new Error('A database hierarchy lifecycle operation is in progress.'), { status: 409 });
  }
  const endpointIds = Array.from(new Set([...additions, ...removals]));
  const endpoints = await Promise.all(endpointIds.map((id) => getExisting(db.table<Page>('pages'), id)));
  for (let index = 0; index < endpointIds.length; index += 1) {
    const endpoint = endpoints[index];
    if (
      !endpoint
      || endpoint.workspaceId !== row.workspaceId
      || endpoint.parentType !== 'database'
      || endpoint.parentId !== database.id
      || endpoint.inTrash === true
    ) throw Object.assign(new Error(`Invalid dependency predecessor: ${endpointIds[index]}.`), { status: 409 });
  }
  const jobId = await hierarchyLifecycleStableId(
    'database-dependency-validation-job',
    row.workspaceId,
    database.id,
    row.id,
    mutationId,
  );
  const jobs = db.table<DatabaseDependencyValidationJob>('database_dependency_validation_jobs');
  const currentRevision = Number(database.databaseFeaturesRevision ?? 0);
  let job = await getExisting(jobs, jobId);
  if (!job) {
    const validationAdditionIndexes = await dependencyValidationAdditionIndexes(
      db,
      database.id,
      row.id,
      additions,
      binding.dataKey,
    );
    job = {
      id: jobId,
      workspaceId: row.workspaceId,
      databaseId: database.id,
      rowId: row.id,
      mutationId,
      requestHash,
      featureRevision: currentRevision,
      ...(binding.dataKey ? { dataKey: binding.dataKey } : {}),
      requestedBy: actorId,
      additions,
      removals,
      validationAdditionIndexes,
      validationComplete: validationAdditionIndexes.length === 0,
      failureMessage: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const items = await dependencyValidationStartItems(job);
    await db.transact([
      hierarchyDatabaseExpectation(database),
      { table: 'database_dependency_validation_jobs', op: 'expect', id: job.id, exists: false },
      {
        table: 'database_dependency_validation_jobs',
        op: 'insert',
        data: job as unknown as Record<string, unknown>,
      },
      ...items.map((item): TransactOperation => ({
        table: 'database_dependency_validation_items',
        op: 'insert',
        data: item as unknown as Record<string, unknown>,
      })),
    ]);
    if (items.length > 0) {
      return { status: 'pending', replayed: false, jobId: job.id };
    }
  } else if (
    job.requestHash !== requestHash
    || job.requestedBy !== actorId
    || job.databaseId !== database.id
    || job.rowId !== row.id
  ) {
    throw Object.assign(new Error('Dependency validation state changed; retry the mutation.'), { status: 409 });
  }
  if (job.featureRevision !== currentRevision || job.dataKey !== binding.dataKey) {
    const validationAdditionIndexes = await dependencyValidationAdditionIndexes(
      db,
      database.id,
      row.id,
      additions,
      binding.dataKey,
    );
    const restartedJob: DatabaseDependencyValidationJob = {
      ...job,
      featureRevision: currentRevision,
      ...(binding.dataKey ? { dataKey: binding.dataKey } : {}),
      additions,
      removals,
      validationAdditionIndexes,
      validationComplete: validationAdditionIndexes.length === 0,
      failureMessage: '',
      updatedAt: nowIso(),
    };
    const items = await dependencyValidationStartItems(restartedJob);
    await db.transact([
      dependencyValidationJobExpectation(job),
      hierarchyDatabaseExpectation(database),
      {
        table: 'database_dependency_validation_jobs',
        op: 'update',
        id: job.id,
        data: {
          featureRevision: restartedJob.featureRevision,
          ...(restartedJob.dataKey ? { dataKey: restartedJob.dataKey } : {}),
          additions: restartedJob.additions,
          removals: restartedJob.removals,
          validationAdditionIndexes: restartedJob.validationAdditionIndexes,
          validationComplete: restartedJob.validationComplete,
          failureMessage: '',
          updatedAt: restartedJob.updatedAt,
        },
      },
      ...items.flatMap((item): TransactOperation[] => [
        { table: 'database_dependency_validation_items', op: 'expect', id: item.id, exists: false },
        {
          table: 'database_dependency_validation_items',
          op: 'insert',
          data: item as unknown as Record<string, unknown>,
        },
      ]),
    ]);
    job = restartedJob;
    if (items.length > 0) return { status: 'pending', replayed: false, jobId: job.id };
  }
  if (!job.validationComplete && await advanceDependencyValidation(db, job)) {
    return { status: 'pending', replayed: false, jobId: job.id };
  }
  if (!job.validationComplete) {
    await db.transact([
      dependencyValidationJobExpectation(job),
      {
        table: 'database_dependency_validation_jobs',
        op: 'update',
        id: job.id,
        data: { validationComplete: true, updatedAt: nowIso() },
      },
    ]);
    return { status: 'pending', replayed: false, jobId: job.id };
  }
  if (await cleanupDependencyValidationItems(db, job)) {
    return { status: 'pending', replayed: false, jobId: job.id };
  }
  if (job.failureMessage) return rejectDependencyValidationJob(db, job);
  return completeDependencyMutation(db, database, row, binding, job);
}

async function updateDatabaseDependencies(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const rowId = requireString(body.rowId ?? body.id, 'rowId');
  const initial = await getExisting(db.table<Page>('pages'), rowId);
  if (!initial || initial.parentType !== 'database' || !initial.parentId) {
    throw new Error('Database row was not found.');
  }
  return withDatabaseFileWorkspaceLease(
    db,
    initial.workspaceId,
    initial.parentId,
    actorId,
    'database-dependency-update',
    (lease) => lease.assertOwned().then(() => updateDatabaseDependenciesUnderLease(
      db,
      body,
      actorId,
      initial.workspaceId,
      actorEmail,
    )),
  );
}

interface DatabaseDependencyDateShiftJob {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  mutationId: string;
  requestHash: string;
  featureRevision: number;
  dataKey?: string;
  requestedBy: string;
  dateMode: 'range' | 'separate';
  datePropertyId: string;
  startDatePropertyId: string;
  endDatePropertyId: string;
  shiftMode: DependencyFeatureBinding['shiftMode'];
  avoidWeekends: boolean;
  deltaDays: number;
  scanComplete: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface DatabaseDependencyDateShiftItem {
  id: string;
  workspaceId: string;
  jobId: string;
  databaseId: string;
  rowId: string;
  depth: number;
  sourceUpdatedAt: string;
  previousValue: string;
  previousEndValue: string;
  nextValue: string;
  nextEndValue: string;
  edgeCursorId: string;
  expanded: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface DatabaseDependencyDateShiftReceipt {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  mutationId: string;
  requestHash: string;
  requestedBy: string;
  status: 'completed';
  createdAt?: string;
  updatedAt?: string;
}

async function assertNoActiveDependencyDateShift(
  db: DbRef,
  databases: Page | readonly Page[],
) {
  const candidates = Array.isArray(databases) ? databases : [databases];
  const ids = Array.from(new Set(candidates
    .filter((database) => (
      recordObject(recordObject(database.databaseFeatures)?.dependencies)?.enabled === true
    ))
    .map((database) => database.id)));
  if (ids.length === 0) return;
  const table = db.table<DatabaseDependencyDateShiftJob>('database_dependency_date_shift_jobs');
  const query = ids.length === 1
    ? table.where('databaseId', '==', ids[0]!)
    : table.where('databaseId', 'in', ids);
  const active = await query
    .limit(ids.length)
    .getList();
  if ((active.items ?? []).length > 0) {
    throw Object.assign(new Error('A dependency date shift is in progress.'), { status: 409 });
  }
}

interface DependencyDateRange {
  startDay: number;
  endDay: number;
  startSuffix: string;
  endSuffix: string;
  hasEnd: boolean;
}

const DEPENDENCY_DATE_DAY_MS = 24 * 60 * 60 * 1000;
const DEPENDENCY_DATE_EDGE_WINDOW = 8;
const DEPENDENCY_DATE_APPLY_WINDOW = 8;

function dependencyDateError(message: string, status: 400 | 409) {
  return Object.assign(new Error(message), { status });
}

function dependencyDateBoundary(value: string, label: string, status: 400 | 409) {
  const match = /^(\d{4})-(\d{2})-(\d{2})((?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?)$/.exec(value);
  if (!match) throw dependencyDateError(`${label} must be an ISO date or date-time.`, status);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) throw dependencyDateError(`${label} must be a valid ISO date or date-time.`, status);
  return { day: Math.floor(time / DEPENDENCY_DATE_DAY_MS), suffix: match[4] ?? '' };
}

function dependencyDateRange(
  value: unknown,
  label: string,
  status: 400 | 409 = 409,
): DependencyDateRange {
  if (typeof value !== 'string' || !value.trim()) {
    throw dependencyDateError(`${label} must be a non-empty date value.`, status);
  }
  const parts = value.trim().split('/');
  if (parts.length > 2 || !parts[0]) {
    throw dependencyDateError(`${label} must be a valid date range.`, status);
  }
  const start = dependencyDateBoundary(parts[0], `${label}.start`, status);
  const hasEnd = typeof parts[1] === 'string' && parts[1].length > 0;
  const end = hasEnd ? dependencyDateBoundary(parts[1]!, `${label}.end`, status) : start;
  if (end.day < start.day) {
    throw dependencyDateError(`${label}.end must not precede its start.`, status);
  }
  return {
    startDay: start.day,
    endDay: end.day,
    startSuffix: start.suffix,
    endSuffix: end.suffix,
    hasEnd,
  };
}

function dependencyDateKey(day: number, suffix: string) {
  return `${new Date(day * DEPENDENCY_DATE_DAY_MS).toISOString().slice(0, 10)}${suffix}`;
}

function dependencyDateRangeValue(range: DependencyDateRange) {
  const start = dependencyDateKey(range.startDay, range.startSuffix);
  if (!range.hasEnd) return start;
  return `${start}/${dependencyDateKey(range.endDay, range.endSuffix)}`;
}

function dependencyDateFallsOnWeekend(day: number) {
  const weekday = new Date(day * DEPENDENCY_DATE_DAY_MS).getUTCDay();
  return weekday === 0 || weekday === 6;
}

interface DependencyDateOwner {
  dateMode: 'range' | 'separate';
  datePropertyId?: string;
  startDatePropertyId?: string;
  endDatePropertyId?: string;
}

interface DependencyDateValues {
  startValue: unknown;
  endValue: unknown;
}

interface NormalizedDependencyDateValues {
  startValue: string;
  endValue: string;
}

function dependencyDateValuesFromProperties(
  owner: DependencyDateOwner,
  properties: Record<string, unknown> | undefined,
): DependencyDateValues {
  if (owner.dateMode === 'range') {
    return { startValue: properties?.[owner.datePropertyId ?? ''], endValue: '' };
  }
  return {
    startValue: properties?.[owner.startDatePropertyId ?? ''],
    endValue: properties?.[owner.endDatePropertyId ?? ''],
  };
}

function dependencyDateValuesFromItem(
  item: DatabaseDependencyDateShiftItem,
  next: boolean,
): NormalizedDependencyDateValues {
  return next
    ? { startValue: item.nextValue, endValue: item.nextEndValue }
    : { startValue: item.previousValue, endValue: item.previousEndValue };
}

function normalizedDependencyDateValues(
  owner: DependencyDateOwner,
  values: DependencyDateValues,
  label: string,
  status: 400 | 409 = 409,
) {
  if (owner.dateMode === 'range') {
    const range = dependencyDateRange(values.startValue, label, status);
    return {
      range,
      values: { startValue: values.startValue as string, endValue: '' },
    };
  }
  if (typeof values.startValue !== 'string' || !values.startValue.trim()) {
    throw dependencyDateError(`${label}.start must be a non-empty date value.`, status);
  }
  if (typeof values.endValue !== 'string' || !values.endValue.trim()) {
    throw dependencyDateError(`${label}.end must be a non-empty date value.`, status);
  }
  const start = dependencyDateBoundary(values.startValue.trim(), `${label}.start`, status);
  const end = dependencyDateBoundary(values.endValue.trim(), `${label}.end`, status);
  if (end.day < start.day) {
    throw dependencyDateError(`${label}.end must not precede its start.`, status);
  }
  return {
    range: {
      startDay: start.day,
      endDay: end.day,
      startSuffix: start.suffix,
      endSuffix: end.suffix,
      hasEnd: true,
    },
    values: {
      startValue: values.startValue.trim(),
      endValue: values.endValue.trim(),
    },
  };
}

function dependencyDateValuesEqual(
  left: DependencyDateValues,
  right: DependencyDateValues,
) {
  return left.startValue === right.startValue && left.endValue === right.endValue;
}

function dependencyDatePropertiesPatch(
  owner: DependencyDateOwner,
  values: NormalizedDependencyDateValues,
) {
  return owner.dateMode === 'range'
    ? { [owner.datePropertyId ?? '']: values.startValue }
    : {
        [owner.startDatePropertyId ?? '']: values.startValue,
        [owner.endDatePropertyId ?? '']: values.endValue,
      };
}

function shiftedDependencyDateValues(
  owner: DependencyDateOwner,
  values: DependencyDateValues,
  days: number,
  avoidWeekends: boolean,
  label: string,
) {
  const source = normalizedDependencyDateValues(owner, values, label).range;
  const shifted: DependencyDateRange = {
    ...source,
    startDay: source.startDay + days,
    endDay: source.endDay + days,
  };
  if (avoidWeekends) {
    const direction = days < 0 ? -1 : 1;
    while (
      dependencyDateFallsOnWeekend(shifted.startDay)
      || dependencyDateFallsOnWeekend(shifted.endDay)
    ) {
      shifted.startDay += direction;
      shifted.endDay += direction;
    }
  }
  if (owner.dateMode === 'range') {
    return { startValue: dependencyDateRangeValue(shifted), endValue: '' };
  }
  return {
    startValue: dependencyDateKey(shifted.startDay, shifted.startSuffix),
    endValue: dependencyDateKey(shifted.endDay, shifted.endSuffix),
  };
}

function dependencySuccessorDateValues(
  job: DatabaseDependencyDateShiftJob,
  predecessorValues: DependencyDateValues,
  successorValues: DependencyDateValues,
) {
  if (
    typeof successorValues.startValue !== 'string'
    || !successorValues.startValue.trim()
    || (job.dateMode === 'separate' && (
      typeof successorValues.endValue !== 'string' || !successorValues.endValue.trim()
    ))
  ) return null;
  if (job.shiftMode === 'none') return null;
  if (job.shiftMode === 'maintain_spacing') {
    if (job.deltaDays === 0) return null;
    return shiftedDependencyDateValues(
      job,
      successorValues,
      job.deltaDays,
      job.avoidWeekends,
      'dependency successor date',
    );
  }
  const predecessor = normalizedDependencyDateValues(
    job,
    predecessorValues,
    'dependency predecessor date',
  ).range;
  const successor = normalizedDependencyDateValues(
    job,
    successorValues,
    'dependency successor date',
  ).range;
  if (successor.startDay > predecessor.endDay) return null;
  return shiftedDependencyDateValues(
    job,
    successorValues,
    predecessor.endDay - successor.startDay + 1,
    job.avoidWeekends,
    'dependency successor date',
  );
}

function dependencyDateShiftJobExpectation(job: DatabaseDependencyDateShiftJob): TransactOperation {
  return {
    table: 'database_dependency_date_shift_jobs',
    op: 'expect',
    id: job.id,
    where: [
      ['databaseId', '==', job.databaseId],
      ['rowId', '==', job.rowId],
      ['mutationId', '==', job.mutationId],
      ['requestHash', '==', job.requestHash],
      ['featureRevision', '==', job.featureRevision],
      ...(job.dataKey ? [['dataKey', '==', job.dataKey] as [string, '==', unknown]] : []),
      ['requestedBy', '==', job.requestedBy],
      ['dateMode', '==', job.dateMode],
      ['datePropertyId', '==', job.datePropertyId],
      ['startDatePropertyId', '==', job.startDatePropertyId],
      ['endDatePropertyId', '==', job.endDatePropertyId],
      ['shiftMode', '==', job.shiftMode],
      ['avoidWeekends', '==', job.avoidWeekends],
      ['deltaDays', '==', job.deltaDays],
      ['scanComplete', '==', job.scanComplete],
    ],
    exists: true,
  };
}

function dependencyDateShiftItemExpectation(item: DatabaseDependencyDateShiftItem): TransactOperation {
  return {
    table: 'database_dependency_date_shift_items',
    op: 'expect',
    id: item.id,
    where: [
      ['jobId', '==', item.jobId],
      ['rowId', '==', item.rowId],
      ['depth', '==', item.depth],
      ['sourceUpdatedAt', '==', item.sourceUpdatedAt],
      ['previousValue', '==', item.previousValue],
      ['previousEndValue', '==', item.previousEndValue],
      ['nextValue', '==', item.nextValue],
      ['nextEndValue', '==', item.nextEndValue],
      ['edgeCursorId', '==', item.edgeCursorId],
      ['expanded', '==', item.expanded],
    ],
    exists: true,
  };
}

function dependencyDateShiftPageExpectation(page: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: page.id,
    where: [
      ['workspaceId', '==', page.workspaceId],
      ['parentId', '==', page.parentId ?? null],
      ['parentType', '==', page.parentType],
      ['inTrash', '==', page.inTrash ?? null],
      ['updatedAt', '==', page.updatedAt ?? null],
    ],
    exists: true,
  };
}

async function dependencyDateShiftItemId(jobId: string, rowId: string) {
  return hierarchyLifecycleStableId('database-dependency-date-shift-item', jobId, rowId);
}

async function firstDependencyDateShiftItem(
  db: DbRef,
  jobId: string,
  expanded?: boolean,
) {
  let query: TableQuery<DatabaseDependencyDateShiftItem> = db
    .table<DatabaseDependencyDateShiftItem>('database_dependency_date_shift_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Dependency date shifting requires bounded item keysets.'), { status: 500 });
  }
  if (expanded !== undefined) query = query.where!('expanded', '==', expanded);
  query = query.orderBy!('depth', 'asc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function dependencyDateShiftEdges(
  db: DbRef,
  job: DatabaseDependencyDateShiftJob,
  item: DatabaseDependencyDateShiftItem,
) {
  let query: TableQuery<DatabaseDependencyEdge> = db.table<DatabaseDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', job.databaseId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Dependency date shifting requires bounded edge keysets.'), { status: 500 });
  }
  if (job.dataKey) query = query.where!('dataKey', '==', job.dataKey);
  query = query.where!('predecessorRowId', '==', item.rowId);
  if (item.edgeCursorId) query = query.where!('id', '>', item.edgeCursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const rows = (await query.limit(DEPENDENCY_DATE_EDGE_WINDOW + 1).getList()).items ?? [];
  return { rows: rows.slice(0, DEPENDENCY_DATE_EDGE_WINDOW), hasMore: rows.length > DEPENDENCY_DATE_EDGE_WINDOW };
}

async function advanceDependencyDateShiftScan(
  db: DbRef,
  database: Page,
  job: DatabaseDependencyDateShiftJob,
  actorEmail?: string | null,
) {
  const item = await firstDependencyDateShiftItem(db, job.id, false);
  if (!item) {
    await db.transact([
      hierarchyDatabaseExpectation(database),
      dependencyDateShiftJobExpectation(job),
      {
        table: 'database_dependency_date_shift_jobs',
        op: 'update',
        id: job.id,
        data: { scanComplete: true, updatedAt: nowIso() },
      },
    ]);
    return;
  }
  const source = await getExisting(db.table<Page>('pages'), item.rowId);
  const sourceValues = source
    ? dependencyDateValuesFromProperties(job, source.properties)
    : null;
  if (
    !source
    || source.workspaceId !== job.workspaceId
    || source.parentType !== 'database'
    || source.parentId !== job.databaseId
    || source.inTrash === true
    || (source.updatedAt ?? '') !== item.sourceUpdatedAt
    || !sourceValues
    || !dependencyDateValuesEqual(sourceValues, dependencyDateValuesFromItem(item, false))
  ) throw Object.assign(new Error('Dependency date source changed during propagation.'), { status: 409 });
  const window = await dependencyDateShiftEdges(db, job, item);
  const operations: TransactOperation[] = [
    hierarchyDatabaseExpectation(database),
    dependencyDateShiftJobExpectation(job),
    dependencyDateShiftItemExpectation(item),
    dependencyDateShiftPageExpectation(source),
  ];
  const seenSuccessorIds = new Set<string>();
  for (const edge of window.rows) {
    if (
      edge.databaseId !== job.databaseId
      || edge.predecessorRowId !== item.rowId
      || edge.successorRowId === job.rowId
    ) throw Object.assign(new Error('Dependency cycle is not allowed.'), { status: 409 });
    if (seenSuccessorIds.has(edge.successorRowId)) continue;
    seenSuccessorIds.add(edge.successorRowId);
    const successor = await getExisting(db.table<Page>('pages'), edge.successorRowId);
    if (
      !successor
      || successor.workspaceId !== job.workspaceId
      || successor.parentType !== 'database'
      || successor.parentId !== job.databaseId
      || successor.inTrash === true
    ) throw Object.assign(new Error('Dependency successor changed during date propagation.'), { status: 409 });
    await assertCanEditPage(db, successor, job.requestedBy, actorEmail);
    const successorValues = dependencyDateValuesFromProperties(job, successor.properties);
    const nextValues = dependencySuccessorDateValues(
      job,
      dependencyDateValuesFromItem(item, true),
      successorValues,
    );
    if (!nextValues) continue;
    const normalizedSuccessor = normalizedDependencyDateValues(
      job,
      successorValues,
      'dependency successor date',
    ).values;
    if (dependencyDateValuesEqual(nextValues, normalizedSuccessor)) continue;
    const successorItemId = await dependencyDateShiftItemId(job.id, successor.id);
    const existing = await getExisting(
      db.table<DatabaseDependencyDateShiftItem>('database_dependency_date_shift_items'),
      successorItemId,
    );
    operations.push(dependencyDateShiftPageExpectation(successor));
    if (existing) {
      if (
        existing.jobId !== job.id
        || !dependencyDateValuesEqual(
          dependencyDateValuesFromItem(existing, false),
          normalizedSuccessor,
        )
        || existing.sourceUpdatedAt !== (successor.updatedAt ?? '')
      ) throw Object.assign(new Error('Dependency date plan changed during propagation.'), { status: 409 });
      const proposed = normalizedDependencyDateValues(
        job,
        nextValues,
        'dependency proposed date',
      ).range;
      const current = normalizedDependencyDateValues(
        job,
        dependencyDateValuesFromItem(existing, true),
        'dependency planned date',
      ).range;
      if (
        proposed.startDay > current.startDay
        || (proposed.startDay === current.startDay && proposed.endDay > current.endDay)
      ) {
        operations.push(
          dependencyDateShiftItemExpectation(existing),
          {
            table: 'database_dependency_date_shift_items',
            op: 'update',
            id: existing.id,
            data: {
              nextValue: nextValues.startValue,
              nextEndValue: nextValues.endValue,
              depth: Math.min(existing.depth, item.depth + 1),
              edgeCursorId: '',
              expanded: false,
              updatedAt: nowIso(),
            },
          },
        );
      }
      continue;
    }
    const stamp = nowIso();
    const nextItem: DatabaseDependencyDateShiftItem = {
      id: successorItemId,
      workspaceId: job.workspaceId,
      jobId: job.id,
      databaseId: job.databaseId,
      rowId: successor.id,
      depth: item.depth + 1,
      sourceUpdatedAt: successor.updatedAt ?? '',
      previousValue: normalizedSuccessor.startValue,
      previousEndValue: normalizedSuccessor.endValue,
      nextValue: nextValues.startValue,
      nextEndValue: nextValues.endValue,
      edgeCursorId: '',
      expanded: false,
      createdAt: stamp,
      updatedAt: stamp,
    };
    operations.push(
      { table: 'database_dependency_date_shift_items', op: 'expect', id: nextItem.id, exists: false },
      {
        table: 'database_dependency_date_shift_items',
        op: 'insert',
        data: nextItem as unknown as Record<string, unknown>,
      },
    );
  }
  const last = window.rows.at(-1);
  operations.push({
    table: 'database_dependency_date_shift_items',
    op: 'update',
    id: item.id,
    data: window.hasMore && last
      ? { edgeCursorId: last.id, updatedAt: nowIso() }
      : { edgeCursorId: last?.id ?? '', expanded: true, updatedAt: nowIso() },
  });
  await db.transact(operations);
}

async function applyDependencyDateShiftItems(
  db: DbRef,
  database: Page,
  job: DatabaseDependencyDateShiftJob,
) {
  let query: TableQuery<DatabaseDependencyDateShiftItem> = db
    .table<DatabaseDependencyDateShiftItem>('database_dependency_date_shift_items')
    .where('jobId', '==', job.id);
  if (typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Dependency date apply requires bounded item keysets.'), { status: 500 });
  }
  query = query.orderBy!('depth', 'asc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const items = (await query.limit(DEPENDENCY_DATE_APPLY_WINDOW).getList()).items ?? [];
  if (items.length === 0) return false;
  const pages = await Promise.all(items.map((item) => getExisting(db.table<Page>('pages'), item.rowId)));
  const stamp = nowIso();
  const updatedRows: Page[] = [];
  const operations: TransactOperation[] = [
    hierarchyDatabaseExpectation(database),
    dependencyDateShiftJobExpectation(job),
  ];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const page = pages[index];
    const pageValues = page
      ? dependencyDateValuesFromProperties(job, page.properties)
      : null;
    if (
      !page
      || page.workspaceId !== job.workspaceId
      || page.parentType !== 'database'
      || page.parentId !== job.databaseId
      || page.inTrash === true
      || (page.updatedAt ?? '') !== item.sourceUpdatedAt
      || !pageValues
      || !dependencyDateValuesEqual(pageValues, dependencyDateValuesFromItem(item, false))
    ) throw Object.assign(new Error('Dependency date source changed before apply.'), { status: 409 });
    const nextProperties = dependencyDatePropertiesPatch(
      job,
      dependencyDateValuesFromItem(item, true),
    );
    const updated: Page = {
      ...page,
      properties: { ...(page.properties ?? {}), ...nextProperties },
      lastEditedBy: job.requestedBy,
      lastMutationId: page.id === job.rowId
        ? job.mutationId
        : `dependency-date-shift:${job.id}`,
      updatedAt: stamp,
    };
    updatedRows.push(updated);
    operations.push(
      dependencyDateShiftItemExpectation(item),
      dependencyDateShiftPageExpectation(page),
      {
        table: 'pages',
        op: 'update',
        id: page.id,
        data: {
          properties: updated.properties,
          lastEditedBy: updated.lastEditedBy,
          lastMutationId: updated.lastMutationId,
          updatedAt: updated.updatedAt,
        },
      },
      { table: 'database_dependency_date_shift_items', op: 'delete', id: item.id },
    );
  }
  await db.transact(operations);
  await bestEffort(
    'database-row-mutation index dependency date shifts',
    upsertDatabaseIndexesForRows(db, updatedRows),
  );
  return true;
}

async function completeDependencyDateShift(
  db: DbRef,
  database: Page,
  job: DatabaseDependencyDateShiftJob,
) {
  const stamp = nowIso();
  const receipt: DatabaseDependencyDateShiftReceipt = {
    id: await hierarchyLifecycleStableId(
      'database-dependency-date-shift-receipt',
      job.workspaceId,
      job.databaseId,
      job.rowId,
      job.mutationId,
    ),
    workspaceId: job.workspaceId,
    databaseId: job.databaseId,
    rowId: job.rowId,
    mutationId: job.mutationId,
    requestHash: job.requestHash,
    requestedBy: job.requestedBy,
    status: 'completed',
    createdAt: stamp,
    updatedAt: stamp,
  };
  await db.transact([
    hierarchyDatabaseExpectation(database),
    dependencyDateShiftJobExpectation(job),
    { table: 'database_dependency_date_shift_receipts', op: 'expect', id: receipt.id, exists: false },
    {
      table: 'database_dependency_date_shift_receipts',
      op: 'insert',
      data: receipt as unknown as Record<string, unknown>,
    },
    { table: 'database_dependency_date_shift_jobs', op: 'delete', id: job.id },
  ]);
  return { status: 'completed', replayed: false };
}

function dependencyDateJobPropertyFields(binding: DependencyFeatureBinding) {
  return binding.dateMode === 'range'
    ? {
        dateMode: binding.dateMode,
        datePropertyId: binding.datePropertyId,
        startDatePropertyId: '',
        endDatePropertyId: '',
      }
    : {
        dateMode: binding.dateMode,
        datePropertyId: '',
        startDatePropertyId: binding.startDatePropertyId,
        endDatePropertyId: binding.endDatePropertyId,
      };
}

function dependencyDateJobMatchesBinding(
  job: DatabaseDependencyDateShiftJob,
  binding: DependencyFeatureBinding,
) {
  const expected = dependencyDateJobPropertyFields(binding);
  return job.dateMode === expected.dateMode
    && job.datePropertyId === expected.datePropertyId
    && job.startDatePropertyId === expected.startDatePropertyId
    && job.endDatePropertyId === expected.endDatePropertyId;
}

async function assertDependencyDateProperties(
  db: DbRef,
  databaseId: string,
  binding: DependencyFeatureBinding,
) {
  const table = db.table<DbProperty>('db_properties');
  const properties = binding.dateMode === 'range'
    ? [await getExisting(table, binding.datePropertyId)]
    : await Promise.all([
        getExisting(table, binding.startDatePropertyId),
        getExisting(table, binding.endDatePropertyId),
      ]);
  if (properties.some((property) => (
    !property || property.databaseId !== databaseId || property.type !== 'date'
  ))) {
    throw Object.assign(new Error('Dependency date properties changed.'), { status: 409 });
  }
}

function requestedDependencyDateValues(
  body: Record<string, unknown>,
  binding: DependencyFeatureBinding,
) {
  return binding.dateMode === 'range'
    ? {
        startValue: requireString(body.nextDateValue, 'nextDateValue'),
        endValue: '',
      }
    : {
        startValue: requireString(body.nextStartDateValue, 'nextStartDateValue'),
        endValue: requireString(body.nextEndDateValue, 'nextEndDateValue'),
      };
}

async function updateDatabaseDependencyDateUnderLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  actorEmail?: string | null,
) {
  const rowId = requireString(body.rowId ?? body.id, 'rowId');
  const mutationId = requireString(body.mutationId, 'mutationId');
  const { row, database } = await getDatabaseRowContext(db, rowId, actorId, { actorEmail });
  if (row.workspaceId !== workspaceId || database.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Dependency date mutation changed workspaces.'), { status: 409 });
  }
  await assertCanEditPage(db, database, actorId, actorEmail);
  const binding = dependencyFeatureBinding(database);
  await assertDependencyDateProperties(db, database.id, binding);
  const previous = normalizedDependencyDateValues(
    binding,
    dependencyDateValuesFromProperties(binding, row.properties),
    'current dependency date',
  );
  const next = normalizedDependencyDateValues(
    binding,
    requestedDependencyDateValues(body, binding),
    'next dependency date',
    400,
  );
  const requestHash = await hierarchyLifecycleStableId(
    'database-dependency-date-shift-request',
    row.id,
    binding.dateMode,
    next.values.startValue,
    next.values.endValue,
  );
  const receiptId = await hierarchyLifecycleStableId(
    'database-dependency-date-shift-receipt',
    row.workspaceId,
    database.id,
    row.id,
    mutationId,
  );
  const receipt = await getExisting(
    db.table<DatabaseDependencyDateShiftReceipt>('database_dependency_date_shift_receipts'),
    receiptId,
  );
  if (receipt) {
    if (receipt.requestHash !== requestHash || receipt.requestedBy !== actorId) {
      throw Object.assign(new Error('Dependency date mutation id was reused for another request.'), { status: 409 });
    }
    return { status: 'completed', replayed: true };
  }
  const jobId = await hierarchyLifecycleStableId(
    'database-dependency-date-shift-job',
    row.workspaceId,
    database.id,
    row.id,
    mutationId,
  );
  const active = (await db.table<DatabaseDependencyDateShiftJob>('database_dependency_date_shift_jobs')
    .where('databaseId', '==', database.id)
    .limit(2)
    .getList()).items ?? [];
  if (active.some((candidate) => candidate.id !== jobId)) {
    throw Object.assign(new Error('Another dependency date shift is in progress.'), { status: 409 });
  }
  let job = await getExisting(
    db.table<DatabaseDependencyDateShiftJob>('database_dependency_date_shift_jobs'),
    jobId,
  );
  if (!job) {
    const stamp = nowIso();
    job = {
      id: jobId,
      workspaceId: row.workspaceId,
      databaseId: database.id,
      rowId: row.id,
      mutationId,
      requestHash,
      featureRevision: Number(database.databaseFeaturesRevision ?? 0),
      ...(binding.dataKey ? { dataKey: binding.dataKey } : {}),
      requestedBy: actorId,
      ...dependencyDateJobPropertyFields(binding),
      shiftMode: binding.shiftMode,
      avoidWeekends: binding.avoidWeekends,
      deltaDays: next.range.startDay - previous.range.startDay,
      scanComplete: binding.shiftMode === 'none',
      createdAt: stamp,
      updatedAt: stamp,
    };
    const rootItem: DatabaseDependencyDateShiftItem = {
      id: await dependencyDateShiftItemId(job.id, row.id),
      workspaceId: row.workspaceId,
      jobId: job.id,
      databaseId: database.id,
      rowId: row.id,
      depth: 0,
      sourceUpdatedAt: row.updatedAt ?? '',
      previousValue: previous.values.startValue,
      previousEndValue: previous.values.endValue,
      nextValue: next.values.startValue,
      nextEndValue: next.values.endValue,
      edgeCursorId: '',
      expanded: binding.shiftMode === 'none',
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.transact([
      hierarchyDatabaseExpectation(database),
      dependencyDateShiftPageExpectation(row),
      { table: 'database_dependency_date_shift_jobs', op: 'expect', id: job.id, exists: false },
      {
        table: 'database_dependency_date_shift_jobs',
        op: 'insert',
        data: job as unknown as Record<string, unknown>,
      },
      { table: 'database_dependency_date_shift_items', op: 'expect', id: rootItem.id, exists: false },
      {
        table: 'database_dependency_date_shift_items',
        op: 'insert',
        data: rootItem as unknown as Record<string, unknown>,
      },
    ]);
    return { status: 'pending', replayed: false, jobId: job.id };
  }
  if (
    job.requestHash !== requestHash
    || job.requestedBy !== actorId
    || job.databaseId !== database.id
    || job.rowId !== row.id
    || job.featureRevision !== Number(database.databaseFeaturesRevision ?? 0)
    || !dependencyDateJobMatchesBinding(job, binding)
    || job.shiftMode !== binding.shiftMode
    || job.avoidWeekends !== binding.avoidWeekends
  ) throw Object.assign(new Error('Dependency date-shift state changed; retry from current state.'), { status: 409 });
  if (!job.scanComplete) {
    await advanceDependencyDateShiftScan(db, database, job, actorEmail);
    return { status: 'pending', replayed: false, jobId: job.id };
  }
  if (await applyDependencyDateShiftItems(db, database, job)) {
    return { status: 'pending', replayed: false, jobId: job.id };
  }
  return completeDependencyDateShift(db, database, job);
}

async function updateDatabaseDependencyDate(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const rowId = requireString(body.rowId ?? body.id, 'rowId');
  const initial = await getExisting(db.table<Page>('pages'), rowId);
  if (!initial || initial.parentType !== 'database' || !initial.parentId) {
    throw new Error('Database row was not found.');
  }
  return withDatabaseFileWorkspaceLease(
    db,
    initial.workspaceId,
    initial.parentId,
    actorId,
    'database-dependency-date-shift',
    (lease) => lease.assertOwned().then(() => updateDatabaseDependencyDateUnderLease(
      db,
      body,
      actorId,
      initial.workspaceId,
      actorEmail,
    )),
  );
}

interface PropertyOption {
  id: string;
  name: string;
}

// Notion keeps a database page's property values available when the page is
// moved out to an ordinary page and later moved back. Hanji stores that
// detached schema/value snapshot under a reserved, non-schema key. Product
// database projections only enumerate db_properties, so the snapshot stays
// invisible while the page is outside a data source (or until it is restored).
const DETACHED_DATABASE_ROW_SNAPSHOT_KEY = '__hanjiDetachedDatabaseRow';

interface DetachedDatabaseRowSnapshot {
  sourceDatabaseId: string;
  properties: Record<string, unknown>;
  detachedAt?: string;
}

function detachedDatabaseRowSnapshot(page: Page): DetachedDatabaseRowSnapshot | undefined {
  const raw = recordObject(page.properties?.[DETACHED_DATABASE_ROW_SNAPSHOT_KEY]);
  const sourceDatabaseId = typeof raw?.sourceDatabaseId === 'string'
    ? raw.sourceDatabaseId.trim()
    : '';
  const properties = recordObject(raw?.properties);
  if (!sourceDatabaseId || !properties) return undefined;
  return {
    sourceDatabaseId,
    properties: cloneJson(properties),
    detachedAt: typeof raw?.detachedAt === 'string' ? raw.detachedAt : undefined,
  };
}

function rowPropertiesForSnapshot(properties: Record<string, unknown> | undefined) {
  const snapshot = cloneJson(properties ?? {});
  delete snapshot[DETACHED_DATABASE_ROW_SNAPSHOT_KEY];
  return snapshot;
}

function normalizedPropertyName(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function propertyOptions(prop: DbProperty): PropertyOption[] {
  if (!Array.isArray(prop.config?.options)) return [];
  return prop.config.options.flatMap((value) => {
    const option = recordObject(value);
    const id = typeof option?.id === 'string' ? option.id.trim() : '';
    const name = typeof option?.name === 'string' ? option.name.trim() : '';
    return id && name ? [{ id, name }] : [];
  });
}

function optionValueToken(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const option = recordObject(value);
  if (typeof option?.id === 'string' && option.id.trim()) return option.id.trim();
  if (typeof option?.name === 'string' && option.name.trim()) return option.name.trim();
  return '';
}

function isExplicitEmptyOptionValue(value: unknown) {
  if (value === null) return true;
  if (typeof value === 'string') return !value.trim();

  const option = recordObject(value);
  if (!option) return false;
  const keys = Object.keys(option);
  return keys.length > 0
    && keys.every((key) => key === 'id' || key === 'name')
    && keys.every((key) => typeof option[key] === 'string' && !option[key].trim());
}

function databaseRowsFromParentSnapshot(rows: Page[], databaseId: string) {
  return rows.filter(
    (candidate) => candidate.parentType === 'database' && candidate.parentId === databaseId,
  );
}

function remapOptionValue(
  sourceProp: DbProperty,
  targetProp: DbProperty,
  value: unknown,
) {
  const multiple = sourceProp.type === 'multi_select';
  const rawValues = multiple ? (Array.isArray(value) ? value : value == null ? [] : [value]) : [value];
  if (!multiple && (value == null || value === '')) return null;

  const sourceOptions = propertyOptions(sourceProp);
  const targetOptions = propertyOptions(targetProp);
  const targetByName = new Map<string, PropertyOption[]>();
  for (const option of targetOptions) {
    const key = normalizedPropertyName(option.name);
    targetByName.set(key, [...(targetByName.get(key) ?? []), option]);
  }

  const valuesToMap = multiple
    ? rawValues.filter((rawValue) => !isExplicitEmptyOptionValue(rawValue))
    : rawValues;
  const mapped = valuesToMap.map((rawValue) => {
    const token = optionValueToken(rawValue);
    if (!token) {
      throw Object.assign(
        new Error(`Property ${sourceProp.name || sourceProp.id} contains an invalid option value.`),
        { status: 409 },
      );
    }
    const sourceOption = sourceOptions.find(
      (option) => option.id === token || normalizedPropertyName(option.name) === normalizedPropertyName(token),
    );
    const optionName = sourceOption?.name ?? token;
    const candidates = targetByName.get(normalizedPropertyName(optionName)) ?? [];
    if (candidates.length !== 1) {
      throw Object.assign(
        new Error(
          candidates.length === 0
            ? `Target property ${targetProp.name || targetProp.id} has no option named ${optionName}.`
            : `Target property ${targetProp.name || targetProp.id} has ambiguous options named ${optionName}.`,
        ),
        { status: 409 },
      );
    }
    return candidates[0]!.id;
  });
  return multiple ? Array.from(new Set(mapped)) : mapped[0] ?? null;
}

function propertySchemasCompatible(source: DbProperty, target: DbProperty) {
  if (source.type !== target.type) return false;
  if (source.type !== 'relation') return true;
  return relationTargetDatabaseId(source) === relationTargetDatabaseId(target);
}

function crossDatabasePropertyMap(sourceProps: DbProperty[], targetProps: DbProperty[]) {
  const propertyMap = new Map<string, DbProperty>();

  const sourceTitles = sourceProps.filter((prop) => prop.type === 'title');
  const targetTitles = targetProps.filter((prop) => prop.type === 'title');
  if (sourceTitles.length !== 1 || targetTitles.length !== 1) {
    throw Object.assign(
      new Error('Both source and target databases must have exactly one title property.'),
      { status: 409 },
    );
  }
  propertyMap.set(sourceTitles[0]!.id, targetTitles[0]!);

  for (const sourceProp of sourceProps) {
    if (isReadOnlyDatabasePropertyType(sourceProp.type)) continue;
    const name = normalizedPropertyName(sourceProp.name);
    if (!name) continue;
    const candidates = targetProps.filter(
      (targetProp) =>
        !isReadOnlyDatabasePropertyType(targetProp.type) &&
        normalizedPropertyName(targetProp.name) === name &&
        propertySchemasCompatible(sourceProp, targetProp),
    );
    if (candidates.length > 1) {
      throw Object.assign(
        new Error(`Target database has ambiguous matching properties named ${sourceProp.name}.`),
        { status: 409 },
      );
    }
    if (candidates[0]) propertyMap.set(sourceProp.id, candidates[0]);
  }
  return propertyMap;
}

const MOVED_RELATION_READ_CHUNK_SIZE = 100;

async function loadMovedRelationContext(
  pages: TableRef<Page>,
  targetProps: DbProperty[],
  properties: Record<string, unknown>,
  knownPages: Page[],
) {
  const contextById = new Map(knownPages.map((page) => [page.id, page]));
  const requestedIds = new Set<string>();
  for (const prop of targetProps) {
    if (prop.type !== 'relation' || !Object.prototype.hasOwnProperty.call(properties, prop.id)) continue;
    requestedIds.add(relationTargetDatabaseId(prop));
    for (const relatedId of uniqueIds(properties[prop.id])) requestedIds.add(relatedId);
  }

  const unreadIds = Array.from(requestedIds).filter((id) => !contextById.has(id));
  for (let index = 0; index < unreadIds.length; index += MOVED_RELATION_READ_CHUNK_SIZE) {
    const chunk = unreadIds.slice(index, index + MOVED_RELATION_READ_CHUNK_SIZE);
    const loaded = await listAll(
      pages.where('id', 'in', chunk),
      {
        maxItems: chunk.length,
        pageSize: chunk.length,
        label: 'Database-move relation context',
      },
    );
    for (const page of loaded) contextById.set(page.id, page);
  }
  return contextById;
}

function validateMovedRelationValues(
  row: Page,
  targetDatabase: Page,
  targetProps: DbProperty[],
  properties: Record<string, unknown>,
  relationContext: Map<string, Page>,
) {
  for (const prop of targetProps) {
    if (prop.type !== 'relation' || !Object.prototype.hasOwnProperty.call(properties, prop.id)) continue;
    const relationDatabaseId = relationTargetDatabaseId(prop);
    const relationDatabase = relationContext.get(relationDatabaseId);
    if (
      !relationDatabase ||
      relationDatabase.kind !== 'database' ||
      relationDatabase.inTrash ||
      relationDatabase.workspaceId !== row.workspaceId
    ) {
      throw new Error(`Relation target database was not found for property ${prop.name || prop.id}.`);
    }
    for (const relatedId of uniqueIds(properties[prop.id])) {
      if (relatedId === row.id) {
        if (relationDatabaseId === targetDatabase.id) continue;
        throw new Error(`Invalid relation target for property ${prop.name || prop.id}: ${relatedId}.`);
      }
      const related = relationContext.get(relatedId);
      if (
        !related ||
        related.workspaceId !== row.workspaceId ||
        related.parentType !== 'database' ||
        related.parentId !== relationDatabaseId ||
        related.deletionPendingAt
      ) {
        throw new Error(`Invalid relation target for property ${prop.name || prop.id}: ${relatedId}.`);
      }
    }
  }
}

interface PendingRelationRowUpdate {
  current: Page;
  properties: Record<string, unknown>;
}

function updatePendingRelationValue(
  pending: Map<string, PendingRelationRowUpdate>,
  current: Page,
  propertyId: string,
  update: (ids: string[]) => string[],
) {
  const existing = pending.get(current.id) ?? {
    current,
    properties: cloneJson(current.properties ?? {}),
  };
  const nextIds = Array.from(new Set(update(uniqueIds(existing.properties[propertyId]))));
  existing.properties[propertyId] = nextIds.length ? nextIds : null;
  pending.set(current.id, existing);
}

async function planRelationDetachment(
  db: DbRef,
  row: Page,
  sourceDatabase: Page,
) {
  const pages = db.table<Page>('pages');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const relationProps = await listAll(propertiesTable.where('type', '==', 'relation'));
  const rowsByDatabase = new Map<string, Page[]>();
  const pending = new Map<string, PendingRelationRowUpdate>();

  const rowsForDatabase = async (databaseId: string) => {
    let rows = rowsByDatabase.get(databaseId);
    if (!rows) {
      rows = databaseRowsFromParentSnapshot(
        await listAll(pages.where('parentId', '==', databaseId)),
        databaseId,
      );
      rowsByDatabase.set(databaseId, rows);
    }
    return rows;
  };

  // Any one-way or reciprocal relation whose schema targets the old data
  // source becomes invalid after the move. Remove those incoming references,
  // not only explicitly paired reciprocal properties.
  for (const prop of relationProps) {
    if (relationTargetDatabaseId(prop) !== sourceDatabase.id) continue;
    for (const candidate of await rowsForDatabase(prop.databaseId)) {
      if (candidate.id === row.id || !uniqueIds(candidate.properties?.[prop.id]).includes(row.id)) continue;
      updatePendingRelationValue(
        pending,
        candidate,
        prop.id,
        (currentIds) => currentIds.filter((id) => id !== row.id),
      );
    }
  }

  return pending;
}

function planPermanentRelationDetachment(
  workspacePages: Page[],
  relationProperties: DbProperty[],
  deletedIds: string[],
  workspaceId: string,
) {
  const deletedIdSet = new Set(deletedIds);
  const deletedRowIdsByDatabase = new Map<string, Set<string>>();
  const survivingRowsByDatabase = new Map<string, Page[]>();

  for (const candidate of workspacePages) {
    if (
      candidate.workspaceId !== workspaceId
      || candidate.parentType !== 'database'
      || !candidate.parentId
    ) {
      continue;
    }
    if (deletedIdSet.has(candidate.id)) {
      const idsForDatabase = deletedRowIdsByDatabase.get(candidate.parentId) ?? new Set<string>();
      idsForDatabase.add(candidate.id);
      deletedRowIdsByDatabase.set(candidate.parentId, idsForDatabase);
      continue;
    }
    // A separately fenced row is not a survivor of this deletion. Its own
    // retry owns its metadata and relation cleanup.
    if (candidate.deletionPendingAt) continue;
    survivingRowsByDatabase.set(
      candidate.parentId,
      [...(survivingRowsByDatabase.get(candidate.parentId) ?? []), candidate],
    );
  }

  const pending = new Map<string, PendingRelationRowUpdate>();
  for (const property of relationProperties) {
    if (property.type !== 'relation') continue;
    const deletedTargetIds = deletedRowIdsByDatabase.get(
      relationTargetDatabaseId(property),
    );
    if (!deletedTargetIds || deletedTargetIds.size === 0) continue;

    for (const survivor of survivingRowsByDatabase.get(property.databaseId) ?? []) {
      const currentIds = uniqueIds(survivor.properties?.[property.id]);
      if (!currentIds.some((id) => deletedTargetIds.has(id))) continue;
      updatePendingRelationValue(
        pending,
        survivor,
        property.id,
        (idsForProperty) => idsForProperty.filter((id) => !deletedTargetIds.has(id)),
      );
    }
  }
  return pending;
}

async function planRelationUpdatesForDatabaseMove(
  db: DbRef,
  row: Page,
  sourceDatabase: Page | null,
  targetDatabase: Page,
  targetProps: DbProperty[],
  targetProperties: Record<string, unknown>,
  relationContext: Map<string, Page>,
) {
  const propertiesTable = db.table<DbProperty>('db_properties');
  const propsByDatabase = new Map<string, DbProperty[]>([
    [targetDatabase.id, targetProps],
  ]);
  const pending = sourceDatabase
    ? await planRelationDetachment(db, row, sourceDatabase)
    : new Map<string, PendingRelationRowUpdate>();

  // Rebuild paired reciprocal values for compatible relation properties that
  // survived the schema remap into the target data source.
  for (const prop of targetProps) {
    if (prop.type !== 'relation') continue;
    const relatedIds = uniqueIds(targetProperties[prop.id]);
    if (relatedIds.length === 0) continue;
    const relatedDatabaseId = relationTargetDatabaseId(prop);
    let relatedProps = propsByDatabase.get(relatedDatabaseId);
    if (!relatedProps) {
      relatedProps = await listAll(propertiesTable.where('databaseId', '==', relatedDatabaseId));
      propsByDatabase.set(relatedDatabaseId, relatedProps);
    }
    const reciprocal = reciprocalRelationProperty(prop, relatedProps, targetDatabase.id);
    if (!reciprocal) continue;
    for (const relatedId of relatedIds) {
      if (relatedId === row.id) {
        const currentIds = uniqueIds(targetProperties[reciprocal.id]);
        targetProperties[reciprocal.id] = Array.from(new Set([...currentIds, row.id]));
        continue;
      }
      const related = relationContext.get(relatedId);
      if (!related) throw new Error(`Relation target row was not found: ${relatedId}.`);
      updatePendingRelationValue(
        pending,
        related,
        reciprocal.id,
        (currentIds) => [...currentIds, row.id],
      );
    }
  }
  return pending;
}

async function moveDatabaseRowToDatabaseUnderWorkspaceLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  lease: FileWorkspaceLeaseGuard,
  actorEmail?: string | null,
) {
  const pages = db.table<Page>('pages');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const uploadsTable = db.table<FileUpload>('file_uploads');
  const id = requireString(body.id ?? body.rowId, 'rowId');
  const targetDatabaseId = requireString(
    body.targetDatabaseId ?? body.dataSourceId,
    'targetDatabaseId',
  );
  const row = await getExisting(pages, id);
  if (!row) throw new Error('Database row was not found.');
  if (row.parentType !== 'database' || !row.parentId) throw new Error('Page is not a database row.');
  if (row.inTrash) throw new Error('Database row is in trash.');
  if (row.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Database row changed workspaces while it was being moved.'), { status: 409 });
  }

  const sourceDatabase = await getExisting(pages, row.parentId);
  const targetDatabase = await getExisting(pages, targetDatabaseId);
  if (!sourceDatabase || sourceDatabase.kind !== 'database') throw new Error('Source database was not found.');
  if (!targetDatabase || targetDatabase.kind !== 'database') throw new Error('Target database was not found.');
  if (sourceDatabase.inTrash) throw new Error('Source database is in trash.');
  if (targetDatabase.inTrash) throw new Error('Target database is in trash.');
  if (sourceDatabase.isLocked) throw new Error('Source database is locked.');
  if (targetDatabase.isLocked) throw new Error('Target database is locked.');
  if (targetDatabase.workspaceId !== workspaceId) {
    throw new Error('Target database is outside the row workspace.');
  }
  await assertCanEditPage(db, row, actorId, actorEmail);
  await assertCanEditPage(db, targetDatabase, actorId, actorEmail);
  await lease.assertOwned();
  await assertNoActiveDependencyDateShift(db, [sourceDatabase, targetDatabase]);
  await assertFileTargetsNotDeleting(
    db,
    workspaceId,
    [row.id, sourceDatabase.id, targetDatabase.id],
  );

  if (sourceDatabase.id === targetDatabase.id) {
    return {
      row,
      sourceDatabaseId: sourceDatabase.id,
      targetDatabaseId: targetDatabase.id,
      propertyMap: {},
      droppedPropertyIds: [],
      affectedRows: [],
    };
  }

  const [sourceProps, targetProps, targetRows, uploads] = await Promise.all([
    listAll(propertiesTable.where('databaseId', '==', sourceDatabase.id)),
    listAll(propertiesTable.where('databaseId', '==', targetDatabase.id)),
    listAll(pages.where('parentId', '==', targetDatabase.id)),
    listAll(uploadsTable.where('pageId', '==', row.id)),
  ]);
  const mapping = crossDatabasePropertyMap(sourceProps, targetProps);
  const targetProperties: Record<string, unknown> = {};
  for (const sourceProp of sourceProps) {
    if (!Object.prototype.hasOwnProperty.call(row.properties ?? {}, sourceProp.id)) continue;
    const targetProp = mapping.get(sourceProp.id);
    if (!targetProp || isReadOnlyDatabasePropertyType(sourceProp.type)) continue;
    const value = row.properties?.[sourceProp.id];
    targetProperties[targetProp.id] =
      sourceProp.type === 'select' || sourceProp.type === 'status' || sourceProp.type === 'multi_select'
        ? remapOptionValue(sourceProp, targetProp, value)
        : cloneJson(value);
  }

  const databaseTargetRows = databaseRowsFromParentSnapshot(targetRows, targetDatabase.id);
  const activeTargetRows = databaseTargetRows.filter((candidate) => !candidate.inTrash);
  for (const prop of targetProps) {
    if (prop.type !== 'unique_id') continue;
    let max = 0;
    for (const candidate of databaseTargetRows) {
      const value = Number(candidate.properties?.[prop.id]);
      if (Number.isFinite(value) && value > max) max = value;
    }
    targetProperties[prop.id] = max + 1;
  }
  const relationContext = await loadMovedRelationContext(
    pages,
    targetProps,
    targetProperties,
    [row, sourceDatabase, targetDatabase],
  );
  validateMovedRelationValues(
    row,
    targetDatabase,
    targetProps,
    targetProperties,
    relationContext,
  );
  const pendingRelations = await planRelationUpdatesForDatabaseMove(
    db,
    row,
    sourceDatabase,
    targetDatabase,
    targetProps,
    targetProperties,
    relationContext,
  );

  const lastPosition = activeTargetRows.reduce<number | undefined>(
    (max, candidate) => max == null || candidate.position > max ? candidate.position : max,
    undefined,
  );
  const position =
    typeof body.position === 'number' && Number.isFinite(body.position)
      ? body.position
      : positionBetween(lastPosition, undefined);
  const timestamp = nowIso();
  const rowUpdate: Partial<Page> & Record<string, unknown> = {
    parentId: targetDatabase.id,
    parentType: 'database',
    properties: targetProperties,
    position,
    updatedAt: timestamp,
    lastEditedBy: actorId,
  };
  const sourceFilePropertyIds = sourceProps
    .filter((property) => property.type === 'files')
    .map((property) => property.id);
  const targetFilePropertyIds = targetProps
    .filter((property) => property.type === 'files')
    .map((property) => property.id);
  const fileTransitions = await fileReferenceTransitionOperations(db, {
    table: 'pages',
    current: row,
    data: rowUpdate,
    currentReferences: {
      icon: row.icon,
      cover: row.cover,
      properties: row.properties,
      schemaFileProperties: schemaFilePropertyReferences(row.properties, sourceFilePropertyIds),
    },
    nextReferences: {
      icon: row.icon,
      cover: row.cover,
      properties: targetProperties,
      schemaFileProperties: schemaFilePropertyReferences(targetProperties, targetFilePropertyIds),
    },
    association: {
      field: 'pageId',
      id: row.id,
      filter: (upload) => !upload.blockId,
    },
    actorId,
  });

  const operations: TransactOperation[] = [
    {
      table: 'pages',
      op: 'expect',
      id: row.id,
      where: [
        ['parentId', '==', sourceDatabase.id],
        ['parentType', '==', 'database'],
        ['updatedAt', '==', row.updatedAt ?? null],
      ],
      exists: true,
    },
  ];
  const affectedRows: Page[] = [];
  for (const pending of pendingRelations.values()) {
    const next = {
      ...pending.current,
      properties: pending.properties,
      updatedAt: timestamp,
      lastEditedBy: actorId,
    };
    operations.push(
      {
        table: 'pages',
        op: 'expect',
        id: pending.current.id,
        where: [['updatedAt', '==', pending.current.updatedAt ?? null]],
        exists: true,
      },
      {
        table: 'pages',
        op: 'update',
        id: pending.current.id,
        data: {
          properties: pending.properties,
          updatedAt: timestamp,
          lastEditedBy: actorId,
        },
      },
    );
    affectedRows.push(next);
  }
  operations.push(...fileTransitions);

  // Block attachments move with the row body as well. Their reference value
  // is unchanged (so they are excluded from the property lifecycle planner),
  // but their database association must follow the row or future download and
  // cleanup authorization will see a mismatched owner graph.
  for (const upload of uploads) {
    const mappedProperty = upload.propertyId ? mapping.get(upload.propertyId) : undefined;
    const propertyId = mappedProperty?.type === 'files' ? mappedProperty.id : null;
    if (upload.databaseId === targetDatabase.id && (upload.propertyId ?? null) === propertyId) continue;
    operations.push(
      {
        table: 'file_uploads',
        op: 'expect',
        id: upload.id,
        where: [
          ['databaseId', '==', upload.databaseId ?? null],
          ['propertyId', '==', upload.propertyId ?? null],
        ],
        exists: true,
      },
      {
        table: 'file_uploads',
        op: 'update',
        id: upload.id,
        data: { databaseId: targetDatabase.id, propertyId, updatedAt: timestamp },
      },
    );
  }
  operations.push({ table: 'pages', op: 'update', id: row.id, data: rowUpdate });
  if (operations.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Too many related rows or files changed in one database move.'),
      { status: 413 },
    );
  }
  const mappedIds = new Set(mapping.keys());
  const droppedPropertyIds = Object.keys(row.properties ?? {}).filter(
    (propertyId) => !propertyId.startsWith('__') && !mappedIds.has(propertyId),
  );
  if (body.dryRun === true) {
    return {
      row: { ...row, ...rowUpdate } as Page,
      sourceDatabaseId: sourceDatabase.id,
      targetDatabaseId: targetDatabase.id,
      propertyMap: Object.fromEntries(
        Array.from(mapping, ([sourcePropertyId, targetProperty]) => [sourcePropertyId, targetProperty.id]),
      ),
      droppedPropertyIds,
      affectedRows,
      dryRun: true,
    };
  }
  await db.transact(operations);

  const updated = { ...row, ...rowUpdate } as Page;
  await bestEffort(
    'database-row-mutation rebuild indexes after database move',
    (async () => {
      await deleteDatabaseRowIndexes(db, row.id);
      await upsertDatabaseIndexesForRows(db, [updated, ...affectedRows]);
    })(),
  );
  return {
    row: updated,
    sourceDatabaseId: sourceDatabase.id,
    targetDatabaseId: targetDatabase.id,
    propertyMap: Object.fromEntries(
      Array.from(mapping, ([sourcePropertyId, targetProperty]) => [sourcePropertyId, targetProperty.id]),
    ),
    droppedPropertyIds,
    affectedRows,
  };
}

async function moveDatabaseRowToDatabase(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const pages = db.table<Page>('pages');
  const id = requireString(body.id ?? body.rowId, 'rowId');
  const initialRow = await getExisting(pages, id);
  if (!initialRow) throw new Error('Database row was not found.');
  if (initialRow.parentType !== 'database' || !initialRow.parentId) {
    throw new Error('Page is not a database row.');
  }
  await assertCanEditPage(db, initialRow, actorId, actorEmail);
  return withFileWorkspaceLease(
    db,
    initialRow.workspaceId,
    actorId,
    'database-row-cross-database-move',
    (lease) => moveDatabaseRowToDatabaseUnderWorkspaceLease(
      db,
      body,
      actorId,
      initialRow.workspaceId,
      lease,
      actorEmail,
    ),
  );
}

function pageMetadataProperties(properties: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(properties ?? {})
      .filter(([propertyId]) => (
        propertyId.startsWith('__') && propertyId !== DETACHED_DATABASE_ROW_SNAPSHOT_KEY
      ))
      .map(([propertyId, value]) => [propertyId, cloneJson(value)]),
  );
}

function valueReferencesUpload(
  value: unknown,
  upload: FileUpload,
  seen = new Set<object>(),
): boolean {
  if (typeof value === 'string') {
    const candidate = value.trim();
    return candidate === upload.id || candidate === upload.key || (!!upload.url && candidate === upload.url);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const found = value.some((item) => valueReferencesUpload(item, upload, seen));
    seen.delete(value);
    return found;
  }
  const record = value as Record<string, unknown>;
  if (
    record.uploadId === upload.id
    || record.fileUploadId === upload.id
    || record.id === upload.id
    || record.key === upload.key
    || (!!upload.url && record.url === upload.url)
  ) {
    seen.delete(value);
    return true;
  }
  const found = Object.values(record).some((item) => valueReferencesUpload(item, upload, seen));
  seen.delete(value);
  return found;
}

function appendPendingRelationOperations(
  operations: TransactOperation[],
  pendingRelations: Map<string, PendingRelationRowUpdate>,
  timestamp: string,
  actorId: string,
) {
  const affectedRows: Page[] = [];
  for (const pending of pendingRelations.values()) {
    const next = {
      ...pending.current,
      properties: pending.properties,
      updatedAt: timestamp,
      lastEditedBy: actorId,
    };
    operations.push(
      {
        table: 'pages',
        op: 'expect',
        id: pending.current.id,
        where: [['updatedAt', '==', pending.current.updatedAt ?? null]],
        exists: true,
      },
      {
        table: 'pages',
        op: 'update',
        id: pending.current.id,
        data: {
          properties: pending.properties,
          updatedAt: timestamp,
          lastEditedBy: actorId,
        },
      },
    );
    affectedRows.push(next);
  }
  return affectedRows;
}

function assertPageMoveOperationLimit(operations: TransactOperation[]) {
  if (operations.length <= MAX_RAW_TRANSACT_OPS) return;
  throw Object.assign(
    new Error('Too many related rows or files changed in one page move.'),
    { status: 413 },
  );
}

const MAX_PAGE_ANCESTRY_NODES = 256;

async function assertTargetOutsidePageSubtree(
  pages: TableRef<Page>,
  page: Page,
  target: Page,
) {
  const visited = new Set<string>();
  let current: Page | null = target;
  while (current) {
    if (current.id === page.id) {
      throw new Error('Cannot move a page inside itself or one of its descendants.');
    }
    if (visited.has(current.id) || visited.size >= MAX_PAGE_ANCESTRY_NODES) {
      throw new Error('File target ancestry is invalid.');
    }
    visited.add(current.id);
    if (current.workspaceId !== page.workspaceId) {
      throw new Error('File target was not found.');
    }
    if (current.parentType === 'workspace' || !current.parentId) return;
    current = await getExisting(pages, current.parentId);
    if (!current) throw new Error('File target was not found.');
  }
}

async function restoredDatabaseRowProperties(
  db: DbRef,
  page: Page,
  targetDatabase: Page,
  targetProps: DbProperty[],
  targetRows: Page[],
) {
  const pages = db.table<Page>('pages');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const snapshot = detachedDatabaseRowSnapshot(page);
  const sourceValues = snapshot?.properties ?? {};
  let sourceDatabase: Page | null = null;
  let sourceProps: DbProperty[] = [];
  let mapping = new Map<string, DbProperty>();

  if (snapshot) {
    const candidate = await getExisting(pages, snapshot.sourceDatabaseId);
    if (
      candidate
      && candidate.kind === 'database'
      && candidate.workspaceId === page.workspaceId
    ) {
      sourceDatabase = candidate;
      sourceProps = await listAll(propertiesTable.where('databaseId', '==', candidate.id));
      if (candidate.id === targetDatabase.id) {
        const targetById = new Map(targetProps.map((property) => [property.id, property]));
        for (const sourceProp of sourceProps) {
          const targetProp = targetById.get(sourceProp.id);
          if (targetProp && propertySchemasCompatible(sourceProp, targetProp)) {
            mapping.set(sourceProp.id, targetProp);
          }
        }
      } else {
        mapping = crossDatabasePropertyMap(sourceProps, targetProps);
      }
    } else {
      // If the original data source was permanently removed, exact surviving
      // property ids are still safe to restore into the target schema.
      for (const targetProp of targetProps) {
        if (Object.prototype.hasOwnProperty.call(sourceValues, targetProp.id)) {
          mapping.set(targetProp.id, targetProp);
        }
      }
      sourceProps = targetProps.filter((property) => mapping.has(property.id));
    }
  }

  const targetProperties: Record<string, unknown> = {
    ...pageMetadataProperties(snapshot?.properties ?? page.properties),
  };
  for (const sourceProp of sourceProps) {
    if (!Object.prototype.hasOwnProperty.call(sourceValues, sourceProp.id)) continue;
    const targetProp = mapping.get(sourceProp.id);
    if (!targetProp || isReadOnlyDatabasePropertyType(sourceProp.type)) continue;
    const value = sourceValues[sourceProp.id];
    targetProperties[targetProp.id] =
      sourceProp.type === 'select' || sourceProp.type === 'status' || sourceProp.type === 'multi_select'
        ? remapOptionValue(sourceProp, targetProp, value)
        : cloneJson(value);
  }

  const databaseTargetRows = databaseRowsFromParentSnapshot(targetRows, targetDatabase.id);
  const activeTargetRows = databaseTargetRows.filter(
    (candidate) => !candidate.inTrash && candidate.id !== page.id,
  );
  for (const prop of targetProps) {
    if (prop.type !== 'unique_id') continue;
    let max = 0;
    for (const candidate of databaseTargetRows) {
      const value = Number(candidate.properties?.[prop.id]);
      if (Number.isFinite(value) && value > max) max = value;
    }
    targetProperties[prop.id] = max + 1;
  }

  const relationContext = await loadMovedRelationContext(
    pages,
    targetProps,
    targetProperties,
    [page, targetDatabase, ...(sourceDatabase ? [sourceDatabase] : [])],
  );
  validateMovedRelationValues(
    page,
    targetDatabase,
    targetProps,
    targetProperties,
    relationContext,
  );
  return {
    snapshot,
    sourceDatabase,
    sourceValues,
    targetProperties,
    mapping,
    activeTargetRows,
    relationContext,
  };
}

async function movePageIntoDatabaseUnderWorkspaceLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  lease: FileWorkspaceLeaseGuard,
  actorEmail?: string | null,
) {
  const pages = db.table<Page>('pages');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const uploadsTable = db.table<FileUpload>('file_uploads');
  const id = requireString(body.id ?? body.pageId, 'pageId');
  const targetDatabaseId = requireString(
    body.targetDatabaseId ?? body.dataSourceId,
    'targetDatabaseId',
  );
  const page = await getExisting(pages, id);
  if (!page) throw new Error('Page was not found.');
  if (page.kind === 'database') throw new Error('Only regular pages can be moved.');
  if (page.parentType === 'database') throw new Error('Page is already a database row.');
  if (page.inTrash) throw new Error('Page is in trash.');
  if (page.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Page changed workspaces while it was being moved.'), { status: 409 });
  }
  const targetDatabase = await getExisting(pages, targetDatabaseId);
  if (!targetDatabase || targetDatabase.kind !== 'database') throw new Error('Target database was not found.');
  if (targetDatabase.inTrash) throw new Error('Target database is in trash.');
  if (targetDatabase.isLocked) throw new Error('Target database is locked.');
  if (targetDatabase.workspaceId !== workspaceId) {
    throw new Error('Target database is outside the page workspace.');
  }
  await assertCanEditPage(db, page, actorId, actorEmail);
  await assertCanEditPage(db, targetDatabase, actorId, actorEmail);
  await lease.assertOwned();
  await assertNoActiveDependencyDateShift(db, targetDatabase);
  await assertTargetOutsidePageSubtree(pages, page, targetDatabase);
  await assertFileTargetsNotDeleting(db, workspaceId, [page.id, targetDatabase.id]);

  const [targetProps, targetRows, uploads] = await Promise.all([
    listAll(propertiesTable.where('databaseId', '==', targetDatabase.id)),
    listAll(pages.where('parentId', '==', targetDatabase.id)),
    listAll(uploadsTable.where('pageId', '==', page.id)),
  ]);
  const restored = await restoredDatabaseRowProperties(
    db,
    page,
    targetDatabase,
    targetProps,
    targetRows,
  );
  const pendingRelations = await planRelationUpdatesForDatabaseMove(
    db,
    page,
    restored.sourceDatabase,
    targetDatabase,
    targetProps,
    restored.targetProperties,
    restored.relationContext,
  );
  const lastPosition = restored.activeTargetRows.reduce<number | undefined>(
    (max, candidate) => max == null || candidate.position > max ? candidate.position : max,
    undefined,
  );
  const position = typeof body.position === 'number' && Number.isFinite(body.position)
    ? body.position
    : positionBetween(lastPosition, undefined);
  const timestamp = nowIso();
  const pageUpdate: Partial<Page> & Record<string, unknown> = {
    parentId: targetDatabase.id,
    parentType: 'database',
    properties: restored.targetProperties,
    position,
    updatedAt: timestamp,
    lastEditedBy: actorId,
  };
  const targetFilePropertyIds = targetProps
    .filter((property) => property.type === 'files')
    .map((property) => property.id);
  const fileTransitions = await fileReferenceTransitionOperations(db, {
    table: 'pages',
    current: page,
    data: pageUpdate,
    currentReferences: {
      icon: page.icon,
      cover: page.cover,
      properties: page.properties,
      pagePropertyValues: schemaFilePropertyReferences(
        page.properties,
        Object.keys(page.properties ?? {}),
      ),
    },
    nextReferences: {
      icon: page.icon,
      cover: page.cover,
      properties: restored.targetProperties,
      schemaFileProperties: schemaFilePropertyReferences(
        restored.targetProperties,
        targetFilePropertyIds,
      ),
    },
    association: {
      field: 'pageId',
      id: page.id,
      filter: (upload) => !upload.blockId,
    },
    actorId,
  });

  const operations: TransactOperation[] = [
    {
      table: 'pages',
      op: 'expect',
      id: page.id,
      where: [
        ['parentId', '==', page.parentId ?? null],
        ['parentType', '==', page.parentType ?? 'workspace'],
        ['updatedAt', '==', page.updatedAt ?? null],
      ],
      exists: true,
    },
    {
      table: 'pages',
      op: 'expect',
      id: targetDatabase.id,
      where: [['updatedAt', '==', targetDatabase.updatedAt ?? null]],
      exists: true,
    },
  ];
  const affectedRows = appendPendingRelationOperations(
    operations,
    pendingRelations,
    timestamp,
    actorId,
  );
  operations.push(...fileTransitions);

  for (const upload of uploads) {
    let propertyId: string | null = null;
    if (!upload.blockId) {
      const sourcePropertyId = Object.keys(restored.sourceValues).find((candidateId) => (
        valueReferencesUpload(restored.sourceValues[candidateId], upload)
      ));
      const mappedProperty = sourcePropertyId
        ? restored.mapping.get(sourcePropertyId)
        : undefined;
      if (mappedProperty?.type === 'files') propertyId = mappedProperty.id;
    }
    if (upload.databaseId === targetDatabase.id && (upload.propertyId ?? null) === propertyId) continue;
    operations.push(
      {
        table: 'file_uploads',
        op: 'expect',
        id: upload.id,
        where: [
          ['databaseId', '==', upload.databaseId ?? null],
          ['propertyId', '==', upload.propertyId ?? null],
        ],
        exists: true,
      },
      {
        table: 'file_uploads',
        op: 'update',
        id: upload.id,
        data: { databaseId: targetDatabase.id, propertyId, updatedAt: timestamp },
      },
    );
  }
  operations.push({ table: 'pages', op: 'update', id: page.id, data: pageUpdate });
  assertPageMoveOperationLimit(operations);
  const mappedIds = new Set(restored.mapping.keys());
  const droppedPropertyIds = Object.keys(restored.sourceValues).filter(
    (propertyId) => !propertyId.startsWith('__') && !mappedIds.has(propertyId),
  );
  if (body.dryRun === true) {
    return {
      row: { ...page, ...pageUpdate } as Page,
      targetDatabaseId: targetDatabase.id,
      sourceDatabaseId: restored.snapshot?.sourceDatabaseId ?? null,
      propertyMap: Object.fromEntries(
        Array.from(restored.mapping, ([sourcePropertyId, targetProperty]) => [sourcePropertyId, targetProperty.id]),
      ),
      droppedPropertyIds,
      affectedRows,
      dryRun: true,
    };
  }
  await db.transact(operations);

  const updated = { ...page, ...pageUpdate } as Page;
  await bestEffort(
    'database-row-mutation rebuild indexes after page-to-database move',
    (async () => {
      await deleteDatabaseRowIndexes(db, page.id);
      await upsertDatabaseIndexesForRows(db, [updated, ...affectedRows]);
    })(),
  );
  return {
    row: updated,
    targetDatabaseId: targetDatabase.id,
    sourceDatabaseId: restored.snapshot?.sourceDatabaseId ?? null,
    propertyMap: Object.fromEntries(
      Array.from(restored.mapping, ([sourcePropertyId, targetProperty]) => [sourcePropertyId, targetProperty.id]),
    ),
    droppedPropertyIds,
    affectedRows,
  };
}

async function movePageIntoDatabase(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const id = requireString(body.id ?? body.pageId, 'pageId');
  const initial = await getExisting(db.table<Page>('pages'), id);
  if (!initial) throw new Error('Page was not found.');
  if (initial.kind === 'database') throw new Error('Only regular pages can be moved.');
  if (initial.parentType === 'database') throw new Error('Page is already a database row.');
  await assertCanEditPage(db, initial, actorId, actorEmail);
  return withFileWorkspaceLease(
    db,
    initial.workspaceId,
    actorId,
    'page-to-database-move',
    (lease) => movePageIntoDatabaseUnderWorkspaceLease(
      db,
      body,
      actorId,
      initial.workspaceId,
      lease,
      actorEmail,
    ),
  );
}

async function moveDatabaseRowToPageUnderWorkspaceLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  workspaceId: string,
  lease: FileWorkspaceLeaseGuard,
  actorEmail?: string | null,
) {
  const pages = db.table<Page>('pages');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const uploadsTable = db.table<FileUpload>('file_uploads');
  const id = requireString(body.id ?? body.rowId, 'rowId');
  const actionParentType = body.action === 'moveToWorkspace'
    ? 'workspace'
    : body.action === 'moveToPage'
      ? 'page'
      : undefined;
  const explicitParentType = body.targetParentType ?? body.parentType;
  if (
    explicitParentType !== undefined
    && explicitParentType !== 'page'
    && explicitParentType !== 'workspace'
  ) {
    throw new Error('targetParentType must be page or workspace.');
  }
  if (actionParentType && explicitParentType && actionParentType !== explicitParentType) {
    throw Object.assign(
      new Error('targetParentType contradicts the requested action.'),
      { status: 400 },
    );
  }
  const requestedParentType = actionParentType ?? explicitParentType;
  const moveToWorkspace = requestedParentType === 'workspace';
  const targetPageId = moveToWorkspace
    ? null
    : requireString(body.targetPageId ?? body.pageId, 'targetPageId');
  const row = await getExisting(pages, id);
  if (!row) throw new Error('Database row was not found.');
  if (row.kind === 'database' || row.parentType !== 'database' || !row.parentId) {
    throw new Error('Page is not a database row.');
  }
  if (row.inTrash) throw new Error('Database row is in trash.');
  if (row.workspaceId !== workspaceId) {
    throw Object.assign(new Error('Database row changed workspaces while it was being moved.'), { status: 409 });
  }
  const sourceDatabase = await getExisting(pages, row.parentId);
  const targetPage = targetPageId ? await getExisting(pages, targetPageId) : null;
  if (!sourceDatabase || sourceDatabase.kind !== 'database') throw new Error('Source database was not found.');
  if (sourceDatabase.inTrash) throw new Error('Source database is in trash.');
  if (sourceDatabase.isLocked) throw new Error('Source database is locked.');
  if (moveToWorkspace) {
    await sharedAssertMinimumWorkspaceAccessRole(
      db,
      workspaceId,
      actorId,
      'edit',
      { requireWorkspace: true },
    );
  } else {
    if (!targetPage || targetPage.kind === 'database') throw new Error('Target parent page was not found.');
    if (targetPage.inTrash) throw new Error('Target parent page is in trash.');
    if (targetPage.isLocked) throw new Error('Target parent page is locked.');
    if (targetPage.workspaceId !== workspaceId) {
      throw new Error('Target parent page is outside the row workspace.');
    }
    await assertCanEditPage(db, targetPage, actorId, actorEmail);
  }
  await assertCanEditPage(db, row, actorId, actorEmail);
  await lease.assertOwned();
  await assertNoActiveDependencyDateShift(db, sourceDatabase);
  if (targetPage) await assertTargetOutsidePageSubtree(pages, row, targetPage);
  await assertFileTargetsNotDeleting(
    db,
    workspaceId,
    [row.id, sourceDatabase.id, ...(targetPage ? [targetPage.id] : [])],
  );

  const [sourceProps, targetChildren, uploads] = await Promise.all([
    listAll(propertiesTable.where('databaseId', '==', sourceDatabase.id)),
    moveToWorkspace
      ? listAll(pages.where('workspaceId', '==', workspaceId))
      : listAll(pages.where('parentId', '==', targetPageId)),
    listAll(uploadsTable.where('pageId', '==', row.id)),
  ]);
  const activeChildren = targetChildren.filter(
    (candidate) => (
      moveToWorkspace
        ? (!candidate.parentId || candidate.parentType === 'workspace')
        : candidate.parentType === 'page' && candidate.parentId === targetPageId
    ) && !candidate.inTrash && candidate.id !== row.id,
  );
  const lastPosition = activeChildren.reduce<number | undefined>(
    (max, candidate) => max == null || candidate.position > max ? candidate.position : max,
    undefined,
  );
  const position = typeof body.position === 'number' && Number.isFinite(body.position)
    ? body.position
    : positionBetween(lastPosition, undefined);
  const timestamp = nowIso();
  const detachedProperties: Record<string, unknown> = {
    ...pageMetadataProperties(row.properties),
    [DETACHED_DATABASE_ROW_SNAPSHOT_KEY]: {
      sourceDatabaseId: sourceDatabase.id,
      properties: rowPropertiesForSnapshot(row.properties),
      detachedAt: timestamp,
    },
  };
  const pageUpdate: Partial<Page> & Record<string, unknown> = {
    parentId: targetPageId,
    parentType: moveToWorkspace ? 'workspace' : 'page',
    properties: detachedProperties,
    position,
    updatedAt: timestamp,
    lastEditedBy: actorId,
  };
  const sourceFilePropertyIds = sourceProps
    .filter((property) => property.type === 'files')
    .map((property) => property.id);
  const fileTransitions = await fileReferenceTransitionOperations(db, {
    table: 'pages',
    current: row,
    data: pageUpdate,
    currentReferences: {
      icon: row.icon,
      cover: row.cover,
      properties: row.properties,
      schemaFileProperties: schemaFilePropertyReferences(row.properties, sourceFilePropertyIds),
    },
    nextReferences: {
      icon: row.icon,
      cover: row.cover,
      properties: detachedProperties,
      pagePropertyValues: schemaFilePropertyReferences(
        detachedProperties,
        Object.keys(detachedProperties),
      ),
    },
    association: {
      field: 'pageId',
      id: row.id,
      filter: (upload) => !upload.blockId,
    },
    actorId,
  });
  const pendingRelations = await planRelationDetachment(db, row, sourceDatabase);
  const operations: TransactOperation[] = [
    {
      table: 'pages',
      op: 'expect',
      id: row.id,
      where: [
        ['parentId', '==', sourceDatabase.id],
        ['parentType', '==', 'database'],
        ['updatedAt', '==', row.updatedAt ?? null],
      ],
      exists: true,
    },
  ];
  if (targetPage) {
    operations.push({
      table: 'pages',
      op: 'expect',
      id: targetPage.id,
      where: [['updatedAt', '==', targetPage.updatedAt ?? null]],
      exists: true,
    });
  }
  const affectedRows = appendPendingRelationOperations(
    operations,
    pendingRelations,
    timestamp,
    actorId,
  );
  operations.push(...fileTransitions);
  for (const upload of uploads) {
    if (upload.databaseId == null && upload.propertyId == null) continue;
    operations.push(
      {
        table: 'file_uploads',
        op: 'expect',
        id: upload.id,
        where: [
          ['databaseId', '==', upload.databaseId ?? null],
          ['propertyId', '==', upload.propertyId ?? null],
        ],
        exists: true,
      },
      {
        table: 'file_uploads',
        op: 'update',
        id: upload.id,
        data: { databaseId: null, propertyId: null, updatedAt: timestamp },
      },
    );
  }
  operations.push({ table: 'pages', op: 'update', id: row.id, data: pageUpdate });
  assertPageMoveOperationLimit(operations);
  if (body.dryRun === true) {
    return {
      page: { ...row, ...pageUpdate } as Page,
      sourceDatabaseId: sourceDatabase.id,
      targetPageId,
      targetParentType: moveToWorkspace ? 'workspace' : 'page',
      preservedPropertyIds: Object.keys(rowPropertiesForSnapshot(row.properties))
        .filter((propertyId) => !propertyId.startsWith('__')),
      affectedRows,
      dryRun: true,
    };
  }
  await db.transact(operations);

  const updated = { ...row, ...pageUpdate } as Page;
  await bestEffort(
    'database-row-mutation delete indexes after database-to-page move',
    deleteDatabaseRowIndexes(db, row.id),
  );
  return {
    page: updated,
    sourceDatabaseId: sourceDatabase.id,
    targetPageId,
    targetParentType: moveToWorkspace ? 'workspace' : 'page',
    preservedPropertyIds: Object.keys(rowPropertiesForSnapshot(row.properties))
      .filter((propertyId) => !propertyId.startsWith('__')),
    affectedRows,
  };
}

async function moveDatabaseRowToPage(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const id = requireString(body.id ?? body.rowId, 'rowId');
  const initial = await getExisting(db.table<Page>('pages'), id);
  if (!initial) throw new Error('Database row was not found.');
  if (initial.kind === 'database' || initial.parentType !== 'database' || !initial.parentId) {
    throw new Error('Page is not a database row.');
  }
  await assertCanEditPage(db, initial, actorId, actorEmail);
  return withFileWorkspaceLease(
    db,
    initial.workspaceId,
    actorId,
    'database-row-to-page-move',
    (lease) => moveDatabaseRowToPageUnderWorkspaceLease(
      db,
      body,
      actorId,
      initial.workspaceId,
      lease,
      actorEmail,
    ),
  );
}

async function getDatabaseRowContext(
  db: DbRef,
  rowId: string,
  actorId: string,
  options: { allowTrashed?: boolean; actorEmail?: string | null } = {},
) {
  const pages = db.table<Page>('pages');
  const row = await getExisting(pages, rowId);
  if (!row) throw new Error('Database row was not found.');
  if (row.parentType !== 'database' || !row.parentId) {
    throw new Error('Page is not a database row.');
  }
  if (row.inTrash && !options.allowTrashed) throw new Error('Database row is in trash.');

  const database = await getExisting(pages, row.parentId);
  if (!database) throw new Error('Database was not found.');
  if (database.kind !== 'database') throw new Error('Parent page is not a database.');
  if (database.inTrash) throw new Error('Database is in trash.');
  if (database.isLocked) throw new Error('Database is locked.');
  await assertCanEditPage(db, row, actorId, options.actorEmail);

  return { pages, row, database };
}

type HierarchyLifecycleOperation = 'trash' | 'restore' | 'delete';

interface DatabaseHierarchyLifecycleJob {
  id: string;
  workspaceId: string;
  databaseId: string;
  rootRowId: string;
  operation: HierarchyLifecycleOperation;
  trashStamp: string;
  featureRevision: number;
  requestedBy: string;
  mutationId?: string;
  phase?: string;
  targetRootId?: string;
  sourceParentId?: string;
  relationPropertyCursorId?: string;
  relationRowPosition?: number;
  relationRowId?: string;
  relationValueOffset?: number;
  relationsPrepared?: boolean;
}

interface DatabaseHierarchyLifecycleItem {
  id: string;
  workspaceId: string;
  databaseId: string;
  jobId: string;
  rowId: string;
  depth: number;
  scanned: boolean;
  scanLane: 'subitems' | 'pages';
  scanPosition: number;
  scanRowId: string;
  targetRowId?: string;
  prepared?: boolean;
  applied?: boolean;
  published?: boolean;
  blockScanId?: string;
  blocksPrepared?: boolean;
  blocksApplied?: boolean;
  dependencyLane?: 'outgoing' | 'incoming';
  dependencyCursorId?: string;
  dependenciesApplied?: boolean;
  fileCursorId?: string;
  filesApplied?: boolean;
}

interface HierarchyRelationUpdate {
  id: string;
  workspaceId: string;
  databaseId: string;
  jobId: string;
  rowId: string;
  sourceUpdatedAt: string;
  properties: Record<string, unknown>;
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

interface DatabaseDependencyValidationJob {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  mutationId: string;
  requestHash: string;
  featureRevision: number;
  dataKey?: string;
  requestedBy: string;
  additions: string[];
  removals: string[];
  validationAdditionIndexes: number[];
  validationComplete: boolean;
  failureMessage?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface DatabaseDependencyValidationItem {
  id: string;
  workspaceId: string;
  jobId: string;
  databaseId: string;
  featureRevision: number;
  additionIndex: number;
  rowId: string;
  edgeCursorId: string;
  proposedScanned: boolean;
  expanded: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface DatabaseDependencyMutationReceipt {
  id: string;
  workspaceId: string;
  databaseId: string;
  rowId: string;
  mutationId: string;
  requestHash: string;
  resultRevision: number;
  requestedBy: string;
  status: 'completed' | 'rejected';
  failureMessage?: string;
  createdAt?: string;
  updatedAt?: string;
}

const HIERARCHY_LIFECYCLE_CHILD_WINDOW = 32;
const HIERARCHY_LIFECYCLE_PARENT_STEPS = 32;
// The boundedDb facade performs page-fence/scope reads around every page
// update. Sixteen product rows keep that wrapper amplification plus the
// explicit source window below the per-request 128-row lifecycle ceiling.
const HIERARCHY_LIFECYCLE_APPLY_WINDOW = 16;
const HIERARCHY_LIFECYCLE_BLOCK_WINDOW = 8;
const HIERARCHY_LIFECYCLE_DEPENDENCY_WINDOW = 8;
const HIERARCHY_LIFECYCLE_RELATION_WINDOW = 8;
const HIERARCHY_LIFECYCLE_RELATION_VALUE_WINDOW = 16;
const HIERARCHY_LIFECYCLE_RELATION_VALUE_BUDGET = 112;

function compareHierarchyLifecycleBoundary(
  page: Page,
  boundary: { position: number; id: string } | Page,
) {
  return (page.position ?? 0) - (boundary.position ?? 0) || page.id.localeCompare(boundary.id);
}

async function hierarchyLifecycleStableId(kind: string, ...parts: string[]) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode([kind, ...parts].join('\u0000')),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hierarchyLifecycleJobExpectation(
  job: DatabaseHierarchyLifecycleJob,
): TransactOperation {
  const where: Array<[string, '==', unknown]> = [
    ['databaseId', '==', job.databaseId],
    ['rootRowId', '==', job.rootRowId],
    ['operation', '==', job.operation],
    ['featureRevision', '==', job.featureRevision],
    ['requestedBy', '==', job.requestedBy],
  ];
  if (job.relationPropertyCursorId !== undefined) {
    where.push(['relationPropertyCursorId', '==', job.relationPropertyCursorId]);
  }
  if (job.relationRowPosition !== undefined) where.push(['relationRowPosition', '==', job.relationRowPosition]);
  if (job.relationRowId !== undefined) where.push(['relationRowId', '==', job.relationRowId]);
  if (job.relationValueOffset !== undefined) where.push(['relationValueOffset', '==', job.relationValueOffset]);
  if (job.relationsPrepared !== undefined) where.push(['relationsPrepared', '==', job.relationsPrepared]);
  if (job.sourceParentId !== undefined) where.push(['sourceParentId', '==', job.sourceParentId]);
  return {
    table: 'database_hierarchy_lifecycle_jobs',
    op: 'expect',
    id: job.id,
    where,
    exists: true,
  };
}

function hierarchyLifecycleItemExpectation(
  item: DatabaseHierarchyLifecycleItem,
): TransactOperation {
  const where: Array<[string, '==', unknown]> = [
    ['jobId', '==', item.jobId],
    ['rowId', '==', item.rowId],
    ['scanned', '==', item.scanned],
    ['scanLane', '==', item.scanLane],
    ['scanPosition', '==', item.scanPosition],
    ['scanRowId', '==', item.scanRowId],
  ];
  if (item.prepared !== undefined) where.push(['prepared', '==', item.prepared]);
  if (item.applied !== undefined) where.push(['applied', '==', item.applied]);
  if (item.blockScanId !== undefined) where.push(['blockScanId', '==', item.blockScanId]);
  if (item.blocksPrepared !== undefined) where.push(['blocksPrepared', '==', item.blocksPrepared]);
  if (item.blocksApplied !== undefined) where.push(['blocksApplied', '==', item.blocksApplied]);
  if (item.dependencyLane !== undefined) where.push(['dependencyLane', '==', item.dependencyLane]);
  if (item.dependencyCursorId !== undefined) where.push(['dependencyCursorId', '==', item.dependencyCursorId]);
  if (item.dependenciesApplied !== undefined) where.push(['dependenciesApplied', '==', item.dependenciesApplied]);
  if (item.fileCursorId !== undefined) where.push(['fileCursorId', '==', item.fileCursorId]);
  if (item.filesApplied !== undefined) where.push(['filesApplied', '==', item.filesApplied]);
  return {
    table: 'database_hierarchy_lifecycle_items',
    op: 'expect',
    id: item.id,
    where,
    exists: true,
  };
}

function hierarchyLifecycleItemData(item: DatabaseHierarchyLifecycleItem) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    databaseId: item.databaseId,
    jobId: item.jobId,
    rowId: item.rowId,
    depth: item.depth,
    scanned: item.scanned,
    scanLane: item.scanLane,
    scanPosition: item.scanPosition,
    scanRowId: item.scanRowId,
    ...(item.targetRowId ? { targetRowId: item.targetRowId } : {}),
    ...(item.prepared !== undefined ? { prepared: item.prepared } : {}),
    ...(item.applied !== undefined ? { applied: item.applied } : {}),
    ...(item.published !== undefined ? { published: item.published } : {}),
    ...(item.blockScanId !== undefined ? { blockScanId: item.blockScanId } : {}),
    ...(item.blocksPrepared !== undefined ? { blocksPrepared: item.blocksPrepared } : {}),
    ...(item.blocksApplied !== undefined ? { blocksApplied: item.blocksApplied } : {}),
    ...(item.dependencyLane !== undefined ? { dependencyLane: item.dependencyLane } : {}),
    ...(item.dependencyCursorId !== undefined ? { dependencyCursorId: item.dependencyCursorId } : {}),
    ...(item.dependenciesApplied !== undefined ? { dependenciesApplied: item.dependenciesApplied } : {}),
    ...(item.fileCursorId !== undefined ? { fileCursorId: item.fileCursorId } : {}),
    ...(item.filesApplied !== undefined ? { filesApplied: item.filesApplied } : {}),
  };
}

async function firstUnscannedHierarchyLifecycleItem(
  db: DbRef,
  jobId: string,
) {
  let query: TableQuery<DatabaseHierarchyLifecycleItem> = db
    .table<DatabaseHierarchyLifecycleItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy lifecycle requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!('scanned', '==', false);
  query = query.orderBy!('depth', 'asc');
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function hierarchyLifecycleApplyItems(
  db: DbRef,
  jobId: string,
) {
  let query: TableQuery<DatabaseHierarchyLifecycleItem> = db
    .table<DatabaseHierarchyLifecycleItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy lifecycle requires bounded ordered queries.'), { status: 500 });
  }
  query = query.orderBy!('depth', 'desc');
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const result = await query.limit(HIERARCHY_LIFECYCLE_APPLY_WINDOW + 1).getList();
  return result.items ?? [];
}

async function hierarchyLifecycleChildWindow(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
  item: DatabaseHierarchyLifecycleItem,
) {
  const expectedTrash = job.operation !== 'trash';
  const read = async (additional: Array<[string, string, unknown]>) => {
    let query: TableQuery<Page> = item.scanLane === 'subitems'
      ? db.table<Page>('pages').where('parentId', '==', job.databaseId)
      : db.table<Page>('pages').where('parentId', '==', item.rowId);
    if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Hierarchy lifecycle requires bounded ordered queries.'), { status: 500 });
    }
    query = query.where!('parentType', '==', item.scanLane === 'subitems' ? 'database' : 'page');
    if (item.scanLane === 'subitems') {
      query = query.where!('subitemParentId', '==', item.rowId);
    }
    query = query.where!('inTrash', '==', expectedTrash);
    if (expectedTrash && job.trashStamp) {
      query = query.where!('trashedAt', '==', job.trashStamp);
    }
    query = query.orderBy!('position', 'asc');
    query = query.orderBy!('id', 'asc');
    for (const [field, operator, value] of additional) {
      query = query.where!(field, operator, value);
    }
    if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
    return (await query.limit(HIERARCHY_LIFECYCLE_CHILD_WINDOW + 1).getList()).items ?? [];
  };

  const after = item.scanRowId
    ? { position: item.scanPosition, id: item.scanRowId }
    : undefined;
  const candidates = after
    ? (await Promise.all([
        read([['position', '>', after.position]]),
        read([['position', '==', after.position], ['id', '>', after.id]]),
      ])).flat()
    : await read([]);
  const byId = new Map<string, Page>();
  for (const child of candidates) {
    const exactParent = item.scanLane === 'subitems'
      ? child.parentId === job.databaseId
        && child.parentType === 'database'
        && (child.subitemParentId ?? '') === item.rowId
      : child.parentId === item.rowId && child.parentType === 'page';
    if (
      !exactParent
      || child.workspaceId !== job.workspaceId
      || child.inTrash !== expectedTrash
      || (after && compareHierarchyLifecycleBoundary(child, after) <= 0)
    ) continue;
    byId.set(child.id, child);
  }
  const rows = Array.from(byId.values())
    .sort((left, right) => compareHierarchyLifecycleBoundary(left, right));
  const accepted = rows.slice(0, HIERARCHY_LIFECYCLE_CHILD_WINDOW);
  return {
    rows: accepted,
    hasMore: rows.length > HIERARCHY_LIFECYCLE_CHILD_WINDOW,
    boundary: accepted.at(-1)
      ? { position: accepted.at(-1)!.position ?? 0, id: accepted.at(-1)!.id }
      : undefined,
  };
}

async function createHierarchyLifecycleJob(
  db: DbRef,
  database: Page,
  row: Page,
  operation: HierarchyLifecycleOperation,
  mutationId: string,
  actorId: string,
) {
  const id = await hierarchyLifecycleStableId(
    'hierarchy-lifecycle-job',
    row.workspaceId,
    database.id,
    row.id,
    operation,
    mutationId,
  );
  const job: DatabaseHierarchyLifecycleJob = {
    id,
    workspaceId: row.workspaceId,
    databaseId: database.id,
    rootRowId: row.id,
    operation,
    trashStamp: operation === 'trash' ? nowIso() : row.trashedAt ?? '',
    featureRevision: Number(database.databaseFeaturesRevision ?? 0),
    requestedBy: actorId,
    mutationId,
    phase: 'discovering',
    sourceParentId: row.subitemParentId ?? '',
    ...(operation === 'delete'
      ? {
          relationPropertyCursorId: '',
          relationRowPosition: 0,
          relationRowId: '',
          relationValueOffset: 0,
          relationsPrepared: false,
        }
      : {}),
  };
  const item: DatabaseHierarchyLifecycleItem = {
    id: await hierarchyLifecycleStableId('hierarchy-lifecycle-item', id, row.id),
    workspaceId: row.workspaceId,
    databaseId: database.id,
    jobId: id,
    rowId: row.id,
    depth: 0,
    scanned: false,
    scanLane: 'subitems',
    scanPosition: 0,
    scanRowId: '',
    ...(operation === 'delete'
      ? {
          prepared: false,
          blockScanId: '',
          blocksPrepared: false,
          blocksApplied: false,
          dependencyLane: 'outgoing',
          dependencyCursorId: '',
          dependenciesApplied: false,
          fileCursorId: '',
          filesApplied: false,
        }
      : {}),
  };
  await db.transact([
    hierarchyDatabaseExpectation(database),
    { table: 'database_hierarchy_lifecycle_jobs', op: 'expect', id, exists: false },
    {
      table: 'database_hierarchy_lifecycle_jobs',
      op: 'insert',
      data: job as unknown as Record<string, unknown>,
    },
    {
      table: 'database_hierarchy_lifecycle_items',
      op: 'insert',
      data: hierarchyLifecycleItemData(item),
    },
  ]);
  return job;
}

function databaseSubitemsEnabled(database: Page) {
  return recordObject(recordObject(database.databaseFeatures)?.subitems)?.enabled === true;
}

async function runLegacyDatabaseRowLifecycle(
  pages: TableRef<Page>,
  row: Page,
  operation: HierarchyLifecycleOperation,
  actorId: string,
) {
  if (operation === 'restore' && row.deletionPendingAt) {
    throw Object.assign(
      new Error('Permanent database-row deletion is in progress; retry the deletion instead of restoring.'),
      { status: 409 },
    );
  }
  const workspacePages = await listAll(pages.where('workspaceId', '==', row.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  const ids = collectSubtree(pagesById, row.id);
  if (operation === 'restore' && ids.some((pageId) => pagesById[pageId]?.deletionPendingAt)) {
    throw Object.assign(
      new Error('Permanent database-row deletion is in progress; retry the deletion instead of restoring.'),
      { status: 409 },
    );
  }
  const stamp = operation === 'trash' ? nowIso() : row.trashedAt;
  const updatedAt = nowIso();
  const updated: Page[] = [];
  for (const pageId of ids) {
    const page = pagesById[pageId];
    if (!page) continue;
    if (operation === 'trash') {
      if (page.inTrash && pageId !== row.id) continue;
      updated.push(await pages.update(pageId, {
        inTrash: true,
        trashedAt: stamp,
        updatedAt,
        lastEditedBy: actorId,
      }));
      continue;
    }
    if (!page.inTrash || (pageId !== row.id && stamp && page.trashedAt !== stamp)) continue;
    updated.push(await pages.update(pageId, {
      inTrash: false,
      trashedAt: null,
      deletionPendingAt: null,
      updatedAt,
      lastEditedBy: actorId,
    }));
  }
  return {
    status: 'completed',
    replayed: false,
    row: updated.find((page) => page.id === row.id) ?? row,
    pages: updated,
  };
}

async function advanceDatabaseHierarchyDiscovery(
  db: DbRef,
  database: Page,
  job: DatabaseHierarchyLifecycleJob,
) {
  for (let step = 0; step < HIERARCHY_LIFECYCLE_PARENT_STEPS; step += 1) {
    const item = await firstUnscannedHierarchyLifecycleItem(db, job.id);
    if (!item) return false;
    const childWindow = await hierarchyLifecycleChildWindow(db, job, item);
    const childItems = await Promise.all(childWindow.rows.map(async (child) => ({
      id: await hierarchyLifecycleStableId('hierarchy-lifecycle-item', job.id, child.id),
      workspaceId: job.workspaceId,
      databaseId: job.databaseId,
      jobId: job.id,
      rowId: child.id,
      depth: item.depth + 1,
      scanned: false,
      scanLane: 'subitems' as const,
      scanPosition: 0,
      scanRowId: '',
      ...(job.operation === 'delete'
        ? {
            prepared: false,
            blockScanId: '',
            blocksPrepared: false,
            blocksApplied: false,
            dependencyLane: 'outgoing' as const,
            dependencyCursorId: '',
            dependenciesApplied: false,
            fileCursorId: '',
            filesApplied: false,
          }
        : {}),
    })));
    const operations: TransactOperation[] = [
      hierarchyDatabaseExpectation(database),
      hierarchyLifecycleJobExpectation(job),
      hierarchyLifecycleItemExpectation(item),
      ...childItems.map((child): TransactOperation => ({
        table: 'database_hierarchy_lifecycle_items',
        op: 'insert',
        data: hierarchyLifecycleItemData(child),
      })),
    ];
    if (childWindow.hasMore && childWindow.boundary) {
      operations.push({
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: {
          scanPosition: childWindow.boundary.position,
          scanRowId: childWindow.boundary.id,
        },
      });
      await db.transact(operations);
      return true;
    }
    operations.push({
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: item.scanLane === 'subitems'
        ? { scanLane: 'pages', scanPosition: 0, scanRowId: '' }
        : { scanned: true },
    });
    await db.transact(operations);
  }
  return Boolean(await firstUnscannedHierarchyLifecycleItem(db, job.id));
}

async function runDatabaseHierarchyLifecycle(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  operation: HierarchyLifecycleOperation,
  actorEmail?: string | null,
) {
  const rowId = requireString(body.id ?? body.rowId, 'rowId');
  const mutationId = typeof body.mutationId === 'string' && body.mutationId.trim()
    ? body.mutationId.trim()
    : `${operation}:${rowId}`;
  const { pages, row, database } = await getDatabaseRowContext(
    db,
    rowId,
    actorId,
    { allowTrashed: true, actorEmail },
  );
  await assertNoActiveDependencyDateShift(db, database);
  if (!databaseSubitemsEnabled(database)) {
    return runLegacyDatabaseRowLifecycle(pages, row, operation, actorId);
  }
  const binding = subitemFeatureBinding(database);
  const desiredTrash = operation === 'trash';
  const jobs = db.table<DatabaseHierarchyLifecycleJob>('database_hierarchy_lifecycle_jobs');
  const jobId = await hierarchyLifecycleStableId(
    'hierarchy-lifecycle-job',
    row.workspaceId,
    database.id,
    row.id,
    operation,
    mutationId,
  );
  let job = await getExisting(jobs, jobId);
  if (!job && row.inTrash === desiredTrash) {
    return { status: 'completed', replayed: true, row, pages: [] as Page[] };
  }
  if (operation === 'restore' && row.deletionPendingAt) {
    throw Object.assign(
      new Error('Permanent database-row deletion is in progress; retry the deletion instead of restoring.'),
      { status: 409 },
    );
  }
  if (!job) {
    job = await createHierarchyLifecycleJob(
      db,
      database,
      row,
      operation,
      mutationId,
      actorId,
    );
  } else if (
    job.workspaceId !== row.workspaceId
    || job.databaseId !== database.id
    || job.rootRowId !== row.id
    || job.operation !== operation
    || job.requestedBy !== actorId
    || job.featureRevision !== Number(database.databaseFeaturesRevision ?? 0)
  ) {
    throw Object.assign(new Error('Hierarchy lifecycle state changed; retry from current state.'), { status: 409 });
  }

  if (await advanceDatabaseHierarchyDiscovery(db, database, job)) {
    return { status: 'pending', replayed: false, jobId: job.id, row, pages: [] as Page[] };
  }

  const candidates = await hierarchyLifecycleApplyItems(db, job.id);
  const applyItems = candidates.slice(0, HIERARCHY_LIFECYCLE_APPLY_WINDOW);
  const finishing = candidates.length <= HIERARCHY_LIFECYCLE_APPLY_WINDOW;
  if (applyItems.length === 0) {
    throw Object.assign(new Error('Hierarchy lifecycle state is incomplete.'), { status: 409 });
  }
  const rowIds = applyItems.map((item) => item.rowId);
  const loadedResult = await db.table<Page>('pages').where('id', 'in', rowIds).limit(rowIds.length).getList();
  const loadedById = new Map((loadedResult.items ?? []).map((page) => [page.id, page]));
  const externalParentId = job.sourceParentId ?? row.subitemParentId ?? '';
  const externalParent = finishing && externalParentId
    ? await getExisting(pages, externalParentId)
    : null;
  if (externalParentId && finishing && (
    !externalParent
    || externalParent.workspaceId !== job.workspaceId
    || externalParent.parentId !== job.databaseId
    || externalParent.parentType !== 'database'
    || externalParent.kind === 'database'
  )) {
    throw Object.assign(
      new Error('External sub-item parent changed during lifecycle publication.'),
      { status: 409 },
    );
  }
  const externalParentChildCount = externalParent
    ? changedSubitemChildCount(externalParent, operation === 'trash' ? -1 : 1)
    : null;
  const stamp = nowIso();
  const updatedPages: Page[] = [];
  const operations: TransactOperation[] = [
    hierarchyDatabaseExpectation(database),
    hierarchyLifecycleJobExpectation(job),
  ];
  for (const item of applyItems) {
    const current = loadedById.get(item.rowId);
    if (!current || (item.rowId === row.id && current.parentType !== 'database')) {
      throw Object.assign(new Error('Hierarchy lifecycle row changed during traversal.'), { status: 409 });
    }
    if (current.inTrash !== !desiredTrash) {
      throw Object.assign(new Error('Hierarchy lifecycle row state changed during traversal.'), { status: 409 });
    }
    if (operation === 'restore' && job.trashStamp && current.trashedAt !== job.trashStamp) {
      throw Object.assign(new Error('Hierarchy lifecycle trash stamp changed during traversal.'), { status: 409 });
    }
    const patch: PagePatch = operation === 'trash'
      ? {
          inTrash: true,
          trashedAt: job.trashStamp,
          updatedAt: stamp,
          lastEditedBy: actorId,
        }
      : {
          inTrash: false,
          trashedAt: null,
          deletionPendingAt: null,
          updatedAt: stamp,
          lastEditedBy: actorId,
        };
    operations.push(
      {
        table: 'pages',
        op: 'expect',
        id: current.id,
        where: [
          ['workspaceId', '==', current.workspaceId],
          ['inTrash', '==', current.inTrash ?? null],
          ['trashedAt', '==', current.trashedAt ?? null],
          ['updatedAt', '==', current.updatedAt ?? null],
        ],
        exists: true,
      },
      { table: 'pages', op: 'update', id: current.id, data: patch as Record<string, unknown> },
      { table: 'database_hierarchy_lifecycle_items', op: 'delete', id: item.id },
    );
    updatedPages.push({ ...current, ...patch });
  }
  if (finishing) {
    const currentFeatures = cloneJson(recordObject(database.databaseFeatures) ?? {});
    if (externalParent && externalParentChildCount !== null) {
      operations.push(
        hierarchyRowExpectation(externalParent),
        {
          table: 'pages',
          op: 'update',
          id: externalParent.id,
          data: { subitemChildCount: externalParentChildCount },
        },
      );
    }
    operations.push(
      {
        table: 'pages',
        op: 'update',
        id: database.id,
        data: {
          databaseFeatures: {
            ...currentFeatures,
            subitems: { ...binding, revision: binding.revision + 1 },
          },
          databaseFeaturesRevision: job.featureRevision + 1,
          lastEditedBy: actorId,
          updatedAt: stamp,
        },
      },
      { table: 'database_hierarchy_lifecycle_jobs', op: 'delete', id: job.id },
    );
  }
  await db.transact(operations);
  if (externalParent && externalParentChildCount !== null) {
    updatedPages.push({
      ...externalParent,
      subitemChildCount: externalParentChildCount,
    });
  }
  const updatedRoot = updatedPages.find((page) => page.id === row.id) ?? row;
  return {
    status: finishing ? 'completed' : 'pending',
    replayed: false,
    ...(finishing ? {} : { jobId: job.id }),
    row: updatedRoot,
    pages: updatedPages,
  };
}

async function trashDatabaseRow(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const id = requireString(body.id, 'id');
  const initial = await getExisting(db.table<Page>('pages'), id);
  if (!initial) throw new Error('Database row was not found.');
  if (initial.parentType !== 'database' || !initial.parentId) {
    throw new Error('Page is not a database row.');
  }
  return withDatabaseFileWorkspaceLease(
    db,
    initial.workspaceId,
    initial.parentId,
    actorId,
    'database-row-hierarchy-trash',
    async (lease) => {
      await lease.assertOwned();
      return runDatabaseHierarchyLifecycle(db, body, actorId, 'trash', actorEmail);
    },
  );
}

async function restoreDatabaseRow(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const id = requireString(body.id, 'id');
  const initial = await getExisting(db.table<Page>('pages'), id);
  if (!initial) throw new Error('Database row was not found.');
  if (initial.parentType !== 'database' || !initial.parentId) {
    throw new Error('Page is not a database row.');
  }
  return withDatabaseFileWorkspaceLease(db, initial.workspaceId, initial.parentId, actorId, 'database-row-restore', async (lease) => {
    await lease.assertOwned();
    return runDatabaseHierarchyLifecycle(db, body, actorId, 'restore', actorEmail);
  });
}

async function hierarchyDeletePreparationItems(db: DbRef, jobId: string) {
  let query: TableQuery<DatabaseHierarchyLifecycleItem> = db
    .table<DatabaseHierarchyLifecycleItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy deletion requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!('prepared', '==', false).orderBy!('depth', 'desc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(HIERARCHY_LIFECYCLE_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function hierarchyDeleteBlockStateItems(
  db: DbRef,
  jobId: string,
  field: 'blocksPrepared' | 'blocksApplied',
) {
  let query: TableQuery<DatabaseHierarchyLifecycleItem> = db
    .table<DatabaseHierarchyLifecycleItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy block deletion requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!(field, '==', false).orderBy!('depth', 'desc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(HIERARCHY_LIFECYCLE_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function hierarchyDeleteBlockWindow(db: DbRef, item: DatabaseHierarchyLifecycleItem) {
  let query: TableQuery<Block> = db.table<Block>('blocks').where('pageId', '==', item.rowId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy block deletion requires bounded ordered queries.'), { status: 500 });
  }
  if (item.blockScanId) query = query.where!('id', '>', item.blockScanId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const candidates = (await query.limit(HIERARCHY_LIFECYCLE_BLOCK_WINDOW + 1).getList()).items ?? [];
  const rows = candidates
    .filter((block) => block.pageId === item.rowId && (!item.blockScanId || block.id > item.blockScanId))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    rows: rows.slice(0, HIERARCHY_LIFECYCLE_BLOCK_WINDOW),
    hasMore: rows.length > HIERARCHY_LIFECYCLE_BLOCK_WINDOW,
  };
}

function hierarchyDeletePageExpectation(
  job: DatabaseHierarchyLifecycleJob,
  page: Page,
): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: page.id,
    where: [
      ['workspaceId', '==', job.workspaceId],
      ['inTrash', '==', true],
      ['trashedAt', '==', page.trashedAt ?? null],
      ['updatedAt', '==', page.updatedAt ?? null],
    ],
    exists: true,
  };
}

function hierarchyDeleteBlockExpectation(block: Block): TransactOperation {
  return {
    table: 'blocks',
    op: 'expect',
    id: block.id,
    where: [
      ['pageId', '==', block.pageId],
      ['parentId', '==', block.parentId ?? null],
      ['updatedAt', '==', block.updatedAt ?? null],
    ],
    exists: true,
  };
}

async function hierarchyLifecycleItemForRow(db: DbRef, jobId: string, rowId: string) {
  let query: TableQuery<DatabaseHierarchyLifecycleItem> = db
    .table<DatabaseHierarchyLifecycleItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function') {
    throw Object.assign(new Error('Hierarchy lifecycle requires bounded item lookup.'), { status: 500 });
  }
  query = query.where!('rowId', '==', rowId);
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function hierarchyDeleteBatchHasRows(
  db: DbRef,
  table: string,
  field: string,
  ids: string[],
) {
  const query = db.table<{ id: string }>(table).where(field, 'in', ids);
  return (await query.limit(1).getList()).items?.length === 1;
}

async function prepareDatabaseHierarchyDelete(
  db: DbRef,
  database: Page,
  job: DatabaseHierarchyLifecycleJob,
) {
  const candidates = await hierarchyDeletePreparationItems(db, job.id);
  const items = candidates.slice(0, HIERARCHY_LIFECYCLE_APPLY_WINDOW);
  if (items.length === 0) return false;
  const ids = items.map((item) => item.rowId);
  const loaded = await db.table<Page>('pages').where('id', 'in', ids).limit(ids.length).getList();
  const pagesById = new Map((loaded.items ?? []).map((page) => [page.id, page]));
  if (pagesById.size !== ids.length) {
    throw Object.assign(new Error('Hierarchy changed during permanent deletion.'), { status: 409 });
  }
  const custodians = Array.from(new Set(Array.from(pagesById.values()).flatMap((page) => (
    [page.createdBy, page.lastEditedBy].filter((userId): userId is string => Boolean(userId))
  ))));
  await assertNoActiveLegalHoldForPermanentDelete(db, job.workspaceId, ids, custodians);

  for (const page of pagesById.values()) {
    const canonicalParentItem = page.parentType === 'page' && page.parentId
      ? await hierarchyLifecycleItemForRow(db, job.id, page.parentId)
      : null;
    const isDatabaseRow = page.parentType === 'database' && page.parentId === job.databaseId;
    const isCanonicalChild = page.parentType === 'page'
      && Boolean(page.parentId)
      && Boolean(canonicalParentItem)
      && !page.subitemParentId;
    if (
      page.kind !== 'page'
      || (!isDatabaseRow && !isCanonicalChild)
      || page.inTrash !== true
      || (job.trashStamp && page.trashedAt !== job.trashStamp)
    ) {
      throw Object.assign(
        new Error('Bounded hierarchy deletion requires plain, same-stamp database rows.'),
        { status: 409 },
      );
    }
  }

  const sideRows = await Promise.all([
    hierarchyDeleteBatchHasRows(db, 'comments', 'pageId', ids),
    hierarchyDeleteBatchHasRows(db, 'collaboration_operations', 'pageId', ids),
    hierarchyDeleteBatchHasRows(db, 'collaboration_documents', 'pageId', ids),
    hierarchyDeleteBatchHasRows(db, 'page_permissions', 'pageId', ids),
    hierarchyDeleteBatchHasRows(db, 'share_links', 'pageId', ids),
    hierarchyDeleteBatchHasRows(db, 'db_property_indexes', 'rowId', ids),
    hierarchyDeleteBatchHasRows(db, 'notifications', 'workspaceId', [job.workspaceId]),
    hierarchyDeleteBatchHasRows(db, 'notion_import_items', 'workspaceId', [job.workspaceId]),
    hierarchyDeleteBatchHasRows(db, 'notion_import_mappings', 'workspaceId', [job.workspaceId]),
  ]);
  if (sideRows.some(Boolean)) {
    throw Object.assign(
      new Error('Bounded hierarchy deletion requires related-content cleanup continuation.'),
      { status: 409 },
    );
  }

  await db.transact([
    hierarchyDatabaseExpectation(database),
    hierarchyLifecycleJobExpectation(job),
    ...items.flatMap((item): TransactOperation[] => [
      hierarchyLifecycleItemExpectation(item),
      { table: 'database_hierarchy_lifecycle_items', op: 'update', id: item.id, data: { prepared: true } },
    ]),
  ]);
  return candidates.length > HIERARCHY_LIFECYCLE_APPLY_WINDOW
    || (await hierarchyDeletePreparationItems(db, job.id)).length > 0;
}

function hierarchyRelationUpdateExpectation(update: HierarchyRelationUpdate): TransactOperation {
  return {
    table: 'database_hierarchy_relation_updates',
    op: 'expect',
    id: update.id,
    where: [
      ['jobId', '==', update.jobId],
      ['rowId', '==', update.rowId],
      ['sourceUpdatedAt', '==', update.sourceUpdatedAt],
    ],
    exists: true,
  };
}

async function nextHierarchyDeleteRelationProperty(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
) {
  if (job.relationRowId) {
    if (!job.relationPropertyCursorId) {
      throw Object.assign(new Error('Hierarchy relation cleanup cursor changed.'), { status: 409 });
    }
    const active = await getExisting(
      db.table<DbProperty>('db_properties'),
      job.relationPropertyCursorId,
    );
    if (!active) {
      throw Object.assign(new Error('Hierarchy relation cleanup schema changed.'), { status: 409 });
    }
    return active;
  }
  let query: TableQuery<DbProperty> = db.table<DbProperty>('db_properties').where('type', '==', 'relation');
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy relation cleanup requires bounded schema keysets.'), { status: 500 });
  }
  if (job.relationPropertyCursorId) query = query.where!('id', '>', job.relationPropertyCursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function hierarchyDeleteRelationRowWindow(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
  property: DbProperty,
) {
  if ((job.relationValueOffset ?? 0) > 0) {
    const active = await getExisting(db.table<Page>('pages'), job.relationRowId ?? '');
    if (
      !active
      || active.parentId !== property.databaseId
      || active.parentType !== 'database'
      || (active.position ?? 0) !== (job.relationRowPosition ?? 0)
    ) {
      throw Object.assign(new Error('Hierarchy relation cleanup row changed.'), { status: 409 });
    }
    return { rows: [active], hasMore: true };
  }
  const read = async (additional: Array<[string, string, unknown]>) => {
    let query: TableQuery<Page> = db.table<Page>('pages').where('parentId', '==', property.databaseId);
    if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Hierarchy relation cleanup requires bounded row keysets.'), { status: 500 });
    }
    query = query.where!('parentType', '==', 'database').orderBy!('position', 'asc').orderBy!('id', 'asc');
    for (const [field, operator, value] of additional) query = query.where!(field, operator, value);
    if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
    return (await query.limit(HIERARCHY_LIFECYCLE_RELATION_WINDOW + 1).getList()).items ?? [];
  };
  const after = job.relationRowId
    ? { position: job.relationRowPosition ?? 0, id: job.relationRowId }
    : null;
  const candidates = after
    ? (await Promise.all([
        read([['position', '>', after.position]]),
        read([['position', '==', after.position], ['id', '>', after.id]]),
      ])).flat()
    : await read([]);
  const rows = Array.from(new Map(candidates
    .filter((page) => (
      page.parentId === property.databaseId
      && page.parentType === 'database'
      && (!after || compareHierarchyLifecycleBoundary(page, after) > 0)
    ))
    .map((page) => [page.id, page])).values())
    .sort((left, right) => compareHierarchyLifecycleBoundary(left, right));
  return {
    rows: rows.slice(0, HIERARCHY_LIFECYCLE_RELATION_WINDOW),
    hasMore: rows.length > HIERARCHY_LIFECYCLE_RELATION_WINDOW,
  };
}

async function prepareDatabaseHierarchyDeleteRelations(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
) {
  if (job.relationsPrepared === true) return false;
  if (!job.relationRowId) {
    let schemaProbe: TableQuery<DbProperty> = db.table<DbProperty>('db_properties').where('type', '==', 'relation');
    if (typeof schemaProbe.includeTotal === 'function') schemaProbe = schemaProbe.includeTotal(false);
    const schemaResult = await schemaProbe.limit(3).getList();
    if (
      schemaResult.hasMore !== true
      && (schemaResult.items ?? []).every((property) => (
        Boolean(recordObject(property.config)?.databaseFeatureRole)
      ))
    ) {
      await db.transact([
        hierarchyLifecycleJobExpectation(job),
        {
          table: 'database_hierarchy_lifecycle_jobs',
          op: 'update',
          id: job.id,
          data: { relationsPrepared: true },
        },
      ]);
      return false;
    }
  }
  const property = await nextHierarchyDeleteRelationProperty(db, job);
  if (!property) {
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      {
        table: 'database_hierarchy_lifecycle_jobs',
        op: 'update',
        id: job.id,
        data: { relationsPrepared: true },
      },
    ]);
    return false;
  }
  const featureRole = String(recordObject(property.config)?.databaseFeatureRole ?? '');
  if (
    job.relationRowId
    && (
      property.id !== job.relationPropertyCursorId
      || property.type !== 'relation'
      || featureRole
      || relationTargetDatabaseId(property) !== job.databaseId
    )
  ) {
    throw Object.assign(new Error('Hierarchy relation cleanup schema changed.'), { status: 409 });
  }
  if (featureRole || relationTargetDatabaseId(property) !== job.databaseId) {
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      {
        table: 'database_hierarchy_lifecycle_jobs',
        op: 'update',
        id: job.id,
        data: {
          relationPropertyCursorId: property.id,
          relationRowPosition: 0,
          relationRowId: '',
          relationValueOffset: 0,
        },
      },
    ]);
    return true;
  }

  const window = await hierarchyDeleteRelationRowWindow(db, job, property);
  const plans = new Map<string, { update: HierarchyRelationUpdate; existing: boolean; page: Page }>();
  const planFor = async (page: Page) => {
    const cached = plans.get(page.id);
    if (cached) return cached.update;
    const id = await hierarchyLifecycleStableId('hierarchy-relation-update', job.id, page.id);
    const existing = await getExisting(
      db.table<HierarchyRelationUpdate>('database_hierarchy_relation_updates'),
      id,
    );
    if (existing && existing.sourceUpdatedAt !== (page.updatedAt ?? '')) {
      throw Object.assign(new Error('Hierarchy relation cleanup plan changed.'), { status: 409 });
    }
    const update = existing ?? {
      id,
      workspaceId: job.workspaceId,
      databaseId: job.databaseId,
      jobId: job.id,
      rowId: page.id,
      sourceUpdatedAt: page.updatedAt ?? '',
      properties: cloneJson(page.properties ?? {}),
    };
    plans.set(page.id, { update, existing: Boolean(existing), page });
    return update;
  };
  let inspectedRelationIds = 0;
  let lastProcessed: Page | undefined;
  let partialValueOffset = 0;
  let stoppedBeforeRow = false;
  for (const page of window.rows) {
    if (await hierarchyLifecycleItemForRow(db, job.id, page.id)) {
      lastProcessed = page;
      continue;
    }
    const currentIds = uniqueIds(page.properties?.[property.id]);
    if (currentIds.length === 0) {
      lastProcessed = page;
      continue;
    }
    const valueOffset = job.relationValueOffset ?? 0;
    const valueLane = valueOffset > 0 || currentIds.length > HIERARCHY_LIFECYCLE_RELATION_VALUE_WINDOW;
    if (valueLane) {
      if (valueOffset === 0 && inspectedRelationIds > 0) {
        stoppedBeforeRow = true;
        break;
      }
      if (valueOffset > currentIds.length || (valueOffset > 0 && page.id !== job.relationRowId)) {
        throw Object.assign(new Error('Hierarchy relation cleanup value changed.'), { status: 409 });
      }
      const update = await planFor(page);
      const retainedIds = valueOffset > 0 ? uniqueIds(update.properties[property.id]) : [];
      const valueEnd = Math.min(
        valueOffset + HIERARCHY_LIFECYCLE_RELATION_VALUE_WINDOW,
        currentIds.length,
      );
      for (const relationId of currentIds.slice(valueOffset, valueEnd)) {
        if (!(await hierarchyLifecycleItemForRow(db, job.id, relationId))) retainedIds.push(relationId);
      }
      update.properties[property.id] = retainedIds.length ? retainedIds : null;
      lastProcessed = page;
      if (valueEnd < currentIds.length) partialValueOffset = valueEnd;
      break;
    }
    if (
      inspectedRelationIds + currentIds.length
      > HIERARCHY_LIFECYCLE_RELATION_VALUE_BUDGET
    ) {
      stoppedBeforeRow = true;
      break;
    }
    inspectedRelationIds += currentIds.length;
    const retainedIds: string[] = [];
    for (const relationId of currentIds) {
      if (!(await hierarchyLifecycleItemForRow(db, job.id, relationId))) retainedIds.push(relationId);
    }
    if (retainedIds.length !== currentIds.length) {
      const update = await planFor(page);
      update.properties[property.id] = retainedIds.length ? retainedIds : null;
    }
    lastProcessed = page;
  }

  const operations: TransactOperation[] = [hierarchyLifecycleJobExpectation(job)];
  for (const plan of plans.values()) {
    operations.push({
      table: 'pages',
      op: 'expect',
      id: plan.page.id,
      where: [['updatedAt', '==', plan.page.updatedAt ?? null]],
      exists: true,
    });
    if (plan.existing) {
      operations.push(
        hierarchyRelationUpdateExpectation(plan.update),
        {
          table: 'database_hierarchy_relation_updates',
          op: 'update',
          id: plan.update.id,
          data: { properties: plan.update.properties },
        },
      );
    } else {
      operations.push(
        { table: 'database_hierarchy_relation_updates', op: 'expect', id: plan.update.id, exists: false },
        {
          table: 'database_hierarchy_relation_updates',
          op: 'insert',
          data: plan.update as unknown as Record<string, unknown>,
        },
      );
    }
  }
  operations.push({
    table: 'database_hierarchy_lifecycle_jobs',
    op: 'update',
    id: job.id,
    data: partialValueOffset > 0 && lastProcessed
      ? {
          relationPropertyCursorId: property.id,
          relationRowPosition: lastProcessed.position ?? 0,
          relationRowId: lastProcessed.id,
          relationValueOffset: partialValueOffset,
        }
      : ((job.relationValueOffset ?? 0) > 0 || stoppedBeforeRow || window.hasMore) && lastProcessed
        ? {
            relationPropertyCursorId: property.id,
            relationRowPosition: lastProcessed.position ?? 0,
            relationRowId: lastProcessed.id,
            relationValueOffset: 0,
          }
        : {
            relationPropertyCursorId: property.id,
            relationRowPosition: 0,
            relationRowId: '',
            relationValueOffset: 0,
          },
  });
  await db.transact(operations);
  return true;
}

async function applyDatabaseHierarchyRelationUpdates(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
) {
  let query: TableQuery<HierarchyRelationUpdate> = db
    .table<HierarchyRelationUpdate>('database_hierarchy_relation_updates')
    .where('jobId', '==', job.id);
  if (typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy relation cleanup requires bounded update keysets.'), { status: 500 });
  }
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const plans = (await query.limit(HIERARCHY_LIFECYCLE_RELATION_WINDOW).getList()).items ?? [];
  if (plans.length === 0) return false;
  const result = await db.table<Page>('pages')
    .where('id', 'in', plans.map((plan) => plan.rowId))
    .limit(plans.length)
    .getList();
  const pages = new Map((result.items ?? []).map((page) => [page.id, page]));
  if (pages.size !== plans.length) {
    throw Object.assign(new Error('Hierarchy relation cleanup target changed.'), { status: 409 });
  }
  const stamp = nowIso();
  const operations: TransactOperation[] = [hierarchyLifecycleJobExpectation(job)];
  const updatedRows: Page[] = [];
  for (const plan of plans) {
    const page = pages.get(plan.rowId)!;
    if ((page.updatedAt ?? '') !== plan.sourceUpdatedAt) {
      throw Object.assign(new Error('Hierarchy relation cleanup target changed.'), { status: 409 });
    }
    operations.push(
      hierarchyRelationUpdateExpectation(plan),
      {
        table: 'pages',
        op: 'expect',
        id: page.id,
        where: [['updatedAt', '==', page.updatedAt ?? null]],
        exists: true,
      },
    );
    if (!jsonSame(page.properties ?? {}, plan.properties)) {
      operations.push({
        table: 'pages',
        op: 'update',
        id: page.id,
        data: { properties: plan.properties, updatedAt: stamp, lastEditedBy: job.requestedBy },
      });
      updatedRows.push({ ...page, properties: plan.properties, updatedAt: stamp, lastEditedBy: job.requestedBy });
    }
    operations.push({ table: 'database_hierarchy_relation_updates', op: 'delete', id: plan.id });
  }
  await db.transact(operations);
  if (updatedRows.length > 0) {
    await bestEffort(
      'database-row-mutation rebuild relation indexes after hierarchy delete',
      upsertDatabaseIndexesForRows(db, updatedRows),
    );
  }
  return true;
}

async function prepareDatabaseHierarchyDeleteBlocks(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
) {
  const candidates = await hierarchyDeleteBlockStateItems(db, job.id, 'blocksPrepared');
  const items = candidates.slice(0, HIERARCHY_LIFECYCLE_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => item.prepared !== true || item.blockScanId === undefined)) {
    throw Object.assign(new Error('Hierarchy block deletion started before row preflight.'), { status: 409 });
  }
  const ids = items.map((item) => item.rowId);
  const firstBlock = (await db.table<Block>('blocks').where('pageId', 'in', ids).limit(1).getList()).items?.[0];
  if (!firstBlock) {
    const [loaded, fileUpload] = await Promise.all([
      db.table<Page>('pages').where('id', 'in', ids).limit(ids.length).getList(),
      db.table<FileUpload>('file_uploads').where('pageId', 'in', ids).limit(1).getList()
        .then((result) => result.items?.[0]),
    ]);
    const pages = new Map((loaded.items ?? []).map((page) => [page.id, page]));
    if (pages.size !== ids.length) {
      throw Object.assign(new Error('Hierarchy changed during block deletion preflight.'), { status: 409 });
    }
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => {
        const page = pages.get(item.rowId)!;
        if (job.trashStamp && page.trashedAt !== job.trashStamp) {
          throw Object.assign(new Error('Hierarchy trash stamp changed during block preflight.'), { status: 409 });
        }
        return [
          hierarchyLifecycleItemExpectation(item),
          hierarchyDeletePageExpectation(job, page),
          {
            table: 'database_hierarchy_lifecycle_items',
            op: 'update',
            id: item.id,
            data: {
              blockScanId: '',
              blocksPrepared: true,
              ...(!fileUpload ? { filesApplied: true } : {}),
            },
          },
        ];
      }),
    ]);
    return candidates.length > HIERARCHY_LIFECYCLE_APPLY_WINDOW;
  }
  const item = items.find((candidate) => candidate.rowId === firstBlock.pageId);
  if (!item) throw Object.assign(new Error('Hierarchy block preflight ownership changed.'), { status: 409 });
  const page = await getExisting(db.table<Page>('pages'), item.rowId);
  if (!page || page.inTrash !== true || (job.trashStamp && page.trashedAt !== job.trashStamp)) {
    throw Object.assign(new Error('Hierarchy page changed during block deletion preflight.'), { status: 409 });
  }
  const window = await hierarchyDeleteBlockWindow(db, item);
  for (const block of window.rows) {
    if (block.parentId) {
      const parent = await getExisting(db.table<Block>('blocks'), block.parentId);
      if (!parent || parent.pageId !== item.rowId) {
        throw Object.assign(new Error('Hierarchy block parent changed during deletion preflight.'), { status: 409 });
      }
    }
  }
  const last = window.rows.at(-1);
  await db.transact([
    hierarchyLifecycleJobExpectation(job),
    hierarchyLifecycleItemExpectation(item),
    hierarchyDeletePageExpectation(job, page),
    ...window.rows.map(hierarchyDeleteBlockExpectation),
    {
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: window.hasMore && last
        ? { blockScanId: last.id }
        : { blockScanId: '', blocksPrepared: true },
    },
  ]);
  return window.hasMore || candidates.length > 1;
}

async function hierarchyDeleteFileStateItems(db: DbRef, jobId: string) {
  let query: TableQuery<DatabaseHierarchyLifecycleItem> = db
    .table<DatabaseHierarchyLifecycleItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy file cleanup requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!('filesApplied', '==', false).orderBy!('depth', 'desc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(HIERARCHY_LIFECYCLE_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function nextHierarchyDeleteFileUpload(
  db: DbRef,
  item: DatabaseHierarchyLifecycleItem,
) {
  let query: TableQuery<FileUpload> = db.table<FileUpload>('file_uploads')
    .where('pageId', '==', item.rowId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy file cleanup requires bounded upload keysets.'), { status: 500 });
  }
  if (item.fileCursorId) query = query.where!('id', '>', item.fileCursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

function hierarchyDeleteStorageBucket(
  storage: FunctionStorageProxy | undefined,
  bucket: string,
) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

async function applyDatabaseHierarchyFileDelete(
  db: DbRef,
  admin: AdminDbAccessor,
  job: DatabaseHierarchyLifecycleJob,
  workspace: Workspace,
  actorId: string,
  storage: FunctionStorageProxy | undefined,
  lease: FileWorkspaceLeaseGuard,
) {
  const candidates = await hierarchyDeleteFileStateItems(db, job.id);
  const items = candidates.slice(0, HIERARCHY_LIFECYCLE_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => item.blocksPrepared !== true || item.prepared !== true)) {
    throw Object.assign(new Error('Hierarchy file cleanup started before complete preflight.'), { status: 409 });
  }
  const nextUploads = await Promise.all(items.map((item) => nextHierarchyDeleteFileUpload(db, item)));
  const activeIndex = nextUploads.findIndex(Boolean);
  if (activeIndex === -1) {
    const pages = await db.table<Page>('pages')
      .where('id', 'in', items.map((item) => item.rowId))
      .limit(items.length)
      .getList();
    const pagesById = new Map((pages.items ?? []).map((page) => [page.id, page]));
    if (pagesById.size !== items.length) {
      throw Object.assign(new Error('Hierarchy file cleanup pages changed.'), { status: 409 });
    }
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => [
        hierarchyLifecycleItemExpectation(item),
        hierarchyDeletePageExpectation(job, pagesById.get(item.rowId)!),
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: { filesApplied: true },
        },
      ]),
    ]);
    return candidates.length > HIERARCHY_LIFECYCLE_APPLY_WINDOW;
  }
  const item = items[activeIndex]!;
  const upload = nextUploads[activeIndex]!;
  if (upload.pageId !== item.rowId) {
    throw Object.assign(new Error('Hierarchy file cleanup ownership changed.'), { status: 409 });
  }
  const page = await getExisting(db.table<Page>('pages'), item.rowId);
  if (!page) throw Object.assign(new Error('Hierarchy file cleanup page changed.'), { status: 409 });
  const block = upload.blockId ? await getExisting(db.table<Block>('blocks'), upload.blockId) : null;
  if (upload.blockId && (!block || block.pageId !== item.rowId)) {
    throw Object.assign(new Error('Hierarchy file cleanup block changed.'), { status: 409 });
  }
  const uploadExpectation = (status: string): TransactOperation => ({
    table: 'file_uploads',
    op: 'expect',
    id: upload.id,
    where: [
      ['workspaceId', '==', job.workspaceId],
      ['pageId', '==', item.rowId],
      ['blockId', '==', upload.blockId ?? null],
      ['key', '==', upload.key],
      ['status', '==', status],
      ...(status === 'deleting'
        ? [['deletionPreviousStatus', '==', 'uploaded'] as [string, '==', unknown]]
        : []),
    ],
    exists: true,
  });
  if (upload.status === 'deleted') {
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      hierarchyLifecycleItemExpectation(item),
      hierarchyDeletePageExpectation(job, page),
      uploadExpectation('deleted'),
      {
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: { fileCursorId: upload.id },
      },
    ]);
    return true;
  }
  if (upload.status === 'uploaded') {
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      hierarchyLifecycleItemExpectation(item),
      hierarchyDeletePageExpectation(job, page),
      ...(block ? [hierarchyDeleteBlockExpectation(block)] : []),
      uploadExpectation('uploaded'),
      {
        table: 'file_uploads',
        op: 'update',
        id: upload.id,
        data: {
          status: 'deleting',
          deletionPreviousStatus: 'uploaded',
          updatedAt: nowIso(),
        },
      },
    ]);
    return true;
  }
  if (upload.status !== 'deleting' || upload.deletionPreviousStatus !== 'uploaded') {
    throw Object.assign(
      new Error('Hierarchy file cleanup is waiting for an active upload operation.'),
      { status: 409 },
    );
  }
  const key = typeof upload.key === 'string' && upload.key ? upload.key : '';
  const proxy = hierarchyDeleteStorageBucket(storage, upload.bucket || 'files');
  if (!key || !proxy?.delete) throw new Error('Stored file deletion requires trusted storage access.');
  await lease.renew();
  await proxy.delete(key);
  if (workspace.organizationId) {
    await releaseOrganizationStorage(admin, {
      id: upload.id,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      bytes: typeof upload.size === 'number' && Number.isFinite(upload.size)
        ? Math.max(0, Math.floor(upload.size))
        : 0,
    });
  }
  await lease.renew();
  await db.transact([
    hierarchyLifecycleJobExpectation(job),
    hierarchyLifecycleItemExpectation(item),
    hierarchyDeletePageExpectation(job, page),
    ...(block ? [hierarchyDeleteBlockExpectation(block)] : []),
    uploadExpectation('deleting'),
    {
      table: 'file_uploads',
      op: 'update',
      id: upload.id,
      data: {
        status: 'deleted',
        deletedAt: nowIso(),
        deletedBy: actorId,
        updatedAt: nowIso(),
      },
    },
    {
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: { fileCursorId: upload.id },
    },
  ]);
  return true;
}

async function applyDatabaseHierarchyBlockDelete(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
) {
  const candidates = await hierarchyDeleteBlockStateItems(db, job.id, 'blocksApplied');
  const items = candidates.slice(0, HIERARCHY_LIFECYCLE_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => item.blocksPrepared !== true || item.blockScanId === undefined)) {
    throw Object.assign(new Error('Hierarchy block deletion preflight is incomplete.'), { status: 409 });
  }
  const ids = items.map((item) => item.rowId);
  const firstBlock = (await db.table<Block>('blocks').where('pageId', 'in', ids).limit(1).getList()).items?.[0];
  if (!firstBlock) {
    const loaded = await db.table<Page>('pages').where('id', 'in', ids).limit(ids.length).getList();
    const pages = new Map((loaded.items ?? []).map((page) => [page.id, page]));
    if (pages.size !== ids.length) {
      throw Object.assign(new Error('Hierarchy changed during block deletion.'), { status: 409 });
    }
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => [
        hierarchyLifecycleItemExpectation(item),
        hierarchyDeletePageExpectation(job, pages.get(item.rowId)!),
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: { blockScanId: '', blocksApplied: true },
        },
      ]),
    ]);
    return candidates.length > HIERARCHY_LIFECYCLE_APPLY_WINDOW;
  }
  const item = items.find((candidate) => candidate.rowId === firstBlock.pageId);
  if (!item) throw Object.assign(new Error('Hierarchy block deletion ownership changed.'), { status: 409 });
  const page = await getExisting(db.table<Page>('pages'), item.rowId);
  if (!page || page.inTrash !== true || (job.trashStamp && page.trashedAt !== job.trashStamp)) {
    throw Object.assign(new Error('Hierarchy page changed during block deletion.'), { status: 409 });
  }
  const window = await hierarchyDeleteBlockWindow(db, item);
  const last = window.rows.at(-1);
  await db.transact([
    hierarchyLifecycleJobExpectation(job),
    hierarchyLifecycleItemExpectation(item),
    hierarchyDeletePageExpectation(job, page),
    ...window.rows.flatMap((block): TransactOperation[] => [
      hierarchyDeleteBlockExpectation(block),
      { table: 'blocks', op: 'delete', id: block.id },
    ]),
    {
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: window.hasMore && last
        ? { blockScanId: last.id }
        : { blockScanId: last?.id ?? '', blocksApplied: true },
    },
  ]);
  return window.hasMore || candidates.length > 1;
}

async function hierarchyDeleteDependencyStateItems(db: DbRef, jobId: string) {
  let query: TableQuery<DatabaseHierarchyLifecycleItem> = db
    .table<DatabaseHierarchyLifecycleItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy dependency cleanup requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!('dependenciesApplied', '==', false).orderBy!('depth', 'desc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(HIERARCHY_LIFECYCLE_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function hierarchyDeleteDependencyEdgeWindow(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
  item: DatabaseHierarchyLifecycleItem,
) {
  const lane = item.dependencyLane;
  if (lane !== 'outgoing' && lane !== 'incoming') {
    throw Object.assign(new Error('Hierarchy dependency cleanup lane is incomplete.'), { status: 409 });
  }
  const field = lane === 'outgoing' ? 'predecessorRowId' : 'successorRowId';
  let query: TableQuery<DatabaseDependencyEdge> = db
    .table<DatabaseDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', job.databaseId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy dependency cleanup requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!(field, '==', item.rowId);
  if (item.dependencyCursorId) query = query.where!('id', '>', item.dependencyCursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const candidates = (await query.limit(HIERARCHY_LIFECYCLE_DEPENDENCY_WINDOW + 1).getList()).items ?? [];
  const rows = candidates
    .filter((edge) => (
      edge.databaseId === job.databaseId
      && edge[field] === item.rowId
      && (!item.dependencyCursorId || edge.id > item.dependencyCursorId)
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    rows: rows.slice(0, HIERARCHY_LIFECYCLE_DEPENDENCY_WINDOW),
    hasMore: rows.length > HIERARCHY_LIFECYCLE_DEPENDENCY_WINDOW,
  };
}

function hierarchyDeleteDependencyEdgeExpectation(edge: DatabaseDependencyEdge): TransactOperation {
  return {
    table: 'database_dependency_edges',
    op: 'expect',
    id: edge.id,
    where: [
      ['databaseId', '==', edge.databaseId],
      ['predecessorRowId', '==', edge.predecessorRowId],
      ['successorRowId', '==', edge.successorRowId],
      ['updatedAt', '==', edge.updatedAt ?? null],
    ],
    exists: true,
  };
}

async function firstHierarchyDependencyEdgeForRows(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
  lane: 'outgoing' | 'incoming',
  rowIds: string[],
) {
  const field = lane === 'outgoing' ? 'predecessorRowId' : 'successorRowId';
  let query: TableQuery<DatabaseDependencyEdge> = db
    .table<DatabaseDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', job.databaseId);
  if (typeof query.where !== 'function') {
    throw Object.assign(new Error('Hierarchy dependency cleanup requires bounded edge lookup.'), { status: 500 });
  }
  query = query.where!(field, 'in', rowIds);
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function applyDatabaseHierarchyDependencyDelete(
  db: DbRef,
  job: DatabaseHierarchyLifecycleJob,
) {
  const candidates = await hierarchyDeleteDependencyStateItems(db, job.id);
  const items = candidates.slice(0, HIERARCHY_LIFECYCLE_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => (
    item.blocksApplied !== true
    || item.dependencyCursorId === undefined
    || (item.dependencyLane !== 'outgoing' && item.dependencyLane !== 'incoming')
  ))) {
    throw Object.assign(new Error('Hierarchy dependency cleanup started before block deletion.'), { status: 409 });
  }
  const outgoingItems = items.filter((item) => item.dependencyLane === 'outgoing');
  const activeLane: 'outgoing' | 'incoming' = outgoingItems.length > 0 ? 'outgoing' : 'incoming';
  const laneItems = activeLane === 'outgoing' ? outgoingItems : items;
  const edge = await firstHierarchyDependencyEdgeForRows(
    db,
    job,
    activeLane,
    laneItems.map((item) => item.rowId),
  );
  if (!edge) {
    const incomingEdge = activeLane === 'outgoing'
      ? await firstHierarchyDependencyEdgeForRows(
          db,
          job,
          'incoming',
          items.map((item) => item.rowId),
        )
      : null;
    const finishWithoutIncoming = activeLane === 'outgoing'
      && outgoingItems.length === items.length
      && !incomingEdge;
    const ids = laneItems.map((item) => item.rowId);
    const loaded = await db.table<Page>('pages').where('id', 'in', ids).limit(ids.length).getList();
    const pages = new Map((loaded.items ?? []).map((page) => [page.id, page]));
    if (pages.size !== ids.length) {
      throw Object.assign(new Error('Hierarchy changed during dependency cleanup.'), { status: 409 });
    }
    await db.transact([
      hierarchyLifecycleJobExpectation(job),
      ...laneItems.flatMap((item): TransactOperation[] => [
        hierarchyLifecycleItemExpectation(item),
        hierarchyDeletePageExpectation(job, pages.get(item.rowId)!),
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: finishWithoutIncoming
            ? { dependenciesApplied: true }
            : activeLane === 'outgoing'
            ? { dependencyLane: 'incoming', dependencyCursorId: '' }
            : { dependenciesApplied: true },
        },
      ]),
    ]);
    return (activeLane === 'outgoing' && !finishWithoutIncoming)
      || candidates.length > HIERARCHY_LIFECYCLE_APPLY_WINDOW;
  }
  const ownerId = activeLane === 'outgoing' ? edge.predecessorRowId : edge.successorRowId;
  const item = laneItems.find((candidate) => candidate.rowId === ownerId);
  if (!item) throw Object.assign(new Error('Hierarchy dependency cleanup ownership changed.'), { status: 409 });
  const page = await getExisting(db.table<Page>('pages'), item.rowId);
  if (!page || page.inTrash !== true || (job.trashStamp && page.trashedAt !== job.trashStamp)) {
    throw Object.assign(new Error('Hierarchy page changed during dependency cleanup.'), { status: 409 });
  }
  const window = await hierarchyDeleteDependencyEdgeWindow(db, job, item);
  const last = window.rows.at(-1);
  await db.transact([
    hierarchyLifecycleJobExpectation(job),
    hierarchyLifecycleItemExpectation(item),
    hierarchyDeletePageExpectation(job, page),
    ...window.rows.flatMap((candidate): TransactOperation[] => [
      hierarchyDeleteDependencyEdgeExpectation(candidate),
      { table: 'database_dependency_edges', op: 'delete', id: candidate.id },
    ]),
    {
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: window.hasMore && last
        ? { dependencyCursorId: last.id }
        : activeLane === 'outgoing'
          ? { dependencyLane: 'incoming', dependencyCursorId: '' }
          : { dependencyCursorId: last?.id ?? '', dependenciesApplied: true },
    },
  ]);
  return true;
}

async function applyDatabaseHierarchyDelete(
  db: DbRef,
  admin: AdminDbAccessor,
  database: Page,
  row: Page,
  job: DatabaseHierarchyLifecycleJob,
  actorId: string,
  lease: FileWorkspaceLeaseGuard,
) {
  const candidates = await hierarchyLifecycleApplyItems(db, job.id);
  const items = candidates.slice(0, HIERARCHY_LIFECYCLE_APPLY_WINDOW);
  if (items.length === 0) {
    throw Object.assign(new Error('Hierarchy deletion state is incomplete.'), { status: 409 });
  }
  if (items.some((item) => item.prepared !== true)) {
    throw Object.assign(new Error('Hierarchy deletion preflight is incomplete.'), { status: 409 });
  }
  if (items.some((item) => item.blocksApplied !== true)) {
    throw Object.assign(new Error('Hierarchy block deletion is incomplete.'), { status: 409 });
  }
  if (items.some((item) => item.dependenciesApplied !== true)) {
    throw Object.assign(new Error('Hierarchy dependency cleanup is incomplete.'), { status: 409 });
  }
  if (items.some((item) => item.filesApplied !== true)) {
    throw Object.assign(new Error('Hierarchy file cleanup is incomplete.'), { status: 409 });
  }
  const ids = items.map((item) => item.rowId);
  const loaded = await db.table<Page>('pages').where('id', 'in', ids).limit(ids.length).getList();
  const pagesById = new Map((loaded.items ?? []).map((page) => [page.id, page]));
  if (pagesById.size !== ids.length) {
    throw Object.assign(new Error('Hierarchy changed during permanent deletion.'), { status: 409 });
  }
  const finishing = candidates.length <= HIERARCHY_LIFECYCLE_APPLY_WINDOW;
  if (!finishing && ids.includes(row.id)) {
    throw Object.assign(new Error('Hierarchy deletion root ordering changed.'), { status: 409 });
  }
  const routingPlan = await collectPermanentRoutingIndexPlan(admin, row.workspaceId, ids);
  await deletePermanentRoutingIndexes(routingPlan, lease.renew);
  const operations: TransactOperation[] = [
    hierarchyDatabaseExpectation(database),
    hierarchyLifecycleJobExpectation(job),
  ];
  for (const item of items) {
    const current = pagesById.get(item.rowId)!;
    const canonicalParentItem = current.parentType === 'page' && current.parentId
      ? await hierarchyLifecycleItemForRow(db, job.id, current.parentId)
      : null;
    const validContainer = (
      current.parentType === 'database' && current.parentId === job.databaseId
    ) || (
      current.parentType === 'page'
      && Boolean(current.parentId)
      && Boolean(canonicalParentItem)
      && !current.subitemParentId
    );
    if (
      current.inTrash !== true
      || (job.trashStamp && current.trashedAt !== job.trashStamp)
      || !validContainer
    ) throw Object.assign(new Error('Hierarchy deletion row changed after preflight.'), { status: 409 });
    operations.push(
      {
        table: 'pages',
        op: 'expect',
        id: current.id,
        where: [
          ['workspaceId', '==', current.workspaceId],
          ['inTrash', '==', true],
          ['trashedAt', '==', current.trashedAt ?? null],
          ['updatedAt', '==', current.updatedAt ?? null],
        ],
        exists: true,
      },
      { table: 'pages', op: 'delete', id: current.id },
      { table: 'database_hierarchy_lifecycle_items', op: 'delete', id: item.id },
    );
  }
  if (finishing) {
    const binding = subitemFeatureBinding(database);
    const features = cloneJson(recordObject(database.databaseFeatures) ?? {});
    const stamp = nowIso();
    operations.push(
      {
        table: 'pages',
        op: 'update',
        id: database.id,
        data: {
          databaseFeatures: { ...features, subitems: { ...binding, revision: binding.revision + 1 } },
          databaseFeaturesRevision: job.featureRevision + 1,
          updatedAt: stamp,
          lastEditedBy: actorId,
        },
      },
      { table: 'database_hierarchy_lifecycle_jobs', op: 'delete', id: job.id },
    );
  }
  await lease.renew();
  await db.transact(operations);
  for (const id of ids) await deleteDatabaseRowIndexes(db, id);
  if (finishing) {
    await recordWorkspaceAudit(db, {
      workspaceId: row.workspaceId,
      actorId,
      action: 'database_row.delete',
      targetType: 'database_row',
      targetId: row.id,
      metadata: { rowId: row.id, databaseId: database.id, deletedPageCount: ids.length },
    });
  }
  return {
    status: finishing ? 'completed' : 'pending',
    replayed: false,
    ...(finishing ? {} : { jobId: job.id }),
    deleted: finishing,
    id: row.id,
  };
}

async function deleteDatabaseHierarchyWithContinuation(
  db: DbRef,
  admin: AdminDbAccessor,
  workspace: Workspace,
  database: Page,
  row: Page,
  mutationId: string,
  actorId: string,
  storage: FunctionStorageProxy | undefined,
  lease: FileWorkspaceLeaseGuard,
) {
  const jobId = await hierarchyLifecycleStableId(
    'hierarchy-lifecycle-job',
    row.workspaceId,
    database.id,
    row.id,
    'delete',
    mutationId,
  );
  const jobs = db.table<DatabaseHierarchyLifecycleJob>('database_hierarchy_lifecycle_jobs');
  let job = await getExisting(jobs, jobId);
  if (!job) job = await createHierarchyLifecycleJob(db, database, row, 'delete', mutationId, actorId);
  if (
    job.operation !== 'delete'
    || job.workspaceId !== row.workspaceId
    || job.databaseId !== database.id
    || job.rootRowId !== row.id
    || job.requestedBy !== actorId
    || job.featureRevision !== Number(database.databaseFeaturesRevision ?? 0)
  ) throw Object.assign(new Error('Hierarchy deletion state changed; retry from current state.'), { status: 409 });

  if (await advanceDatabaseHierarchyDiscovery(db, database, job)) {
    return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
  }
  if ((await hierarchyDeletePreparationItems(db, job.id)).length > 0) {
    const pending = await prepareDatabaseHierarchyDelete(db, database, job);
    if (pending) {
      return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
    }
  }
  if (job.relationsPrepared !== true) {
    const pending = await prepareDatabaseHierarchyDeleteRelations(db, job);
    if (pending) {
      return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
    }
    job = { ...job, relationsPrepared: true };
  }
  if ((await hierarchyDeleteBlockStateItems(db, job.id, 'blocksPrepared')).length > 0) {
    const pending = await prepareDatabaseHierarchyDeleteBlocks(db, job);
    if (pending) {
      return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
    }
  }
  if ((await hierarchyDeleteFileStateItems(db, job.id)).length > 0) {
    const pending = await applyDatabaseHierarchyFileDelete(
      db,
      admin,
      job,
      workspace,
      actorId,
      storage,
      lease,
    );
    if (pending) {
      return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
    }
  }
  if ((await hierarchyDeleteBlockStateItems(db, job.id, 'blocksApplied')).length > 0) {
    const pending = await applyDatabaseHierarchyBlockDelete(db, job);
    if (pending) {
      return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
    }
  }
  if ((await hierarchyDeleteDependencyStateItems(db, job.id)).length > 0) {
    const pending = await applyDatabaseHierarchyDependencyDelete(db, job);
    if (pending) {
      return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
    }
  }
  if (await applyDatabaseHierarchyRelationUpdates(db, job)) {
    return { status: 'pending', replayed: false, jobId: job.id, deleted: false, id: row.id };
  }
  return applyDatabaseHierarchyDelete(db, admin, database, row, job, actorId, lease);
}

async function deleteDatabaseRow(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const id = requireString(body.id, 'id');
  const row = await getExisting(db.table<Page>('pages'), id);
  if (!row) throw new Error('Database row was not found.');
  return withFileWorkspaceLease(db, row.workspaceId, actorId, 'permanent-database-row-delete', (lease) =>
    deleteDatabaseRowUnderLease(db, admin, body, actorId, actorEmail, storage, request, lease));
}

async function deleteDatabaseRowUnderLease(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail: string | null | undefined,
  storage: FunctionStorageProxy | undefined,
  request: Request | undefined,
  lease: FileWorkspaceLeaseGuard,
) {
  await lease.assertOwned();
  const id = requireString(body.id, 'id');
  const { pages, row, database } = await getDatabaseRowContext(db, id, actorId, { allowTrashed: true, actorEmail });
  await assertNoActiveDependencyDateShift(db, database);
  const workspace = await getExisting(db.table<Workspace>('workspaces'), row.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  if (!(await sharedCanManagePageAccess(db, row, workspace, actorId, actorEmail))) {
    throw new Error('Permanent delete access required.');
  }
  if (!row.inTrash) {
    throw Object.assign(
      new Error('Database row must be moved to trash before permanent deletion.'),
      { status: 409 },
    );
  }
  if (databaseSubitemsEnabled(database)) {
    const mutationId = typeof body.mutationId === 'string' && body.mutationId.trim()
      ? body.mutationId.trim()
      : `delete:${row.id}`;
    return deleteDatabaseHierarchyWithContinuation(
      db,
      admin,
      workspace,
      database,
      row,
      mutationId,
      actorId,
      storage,
      lease,
    );
  }
  const workspacePages = await listAll(pages.where('workspaceId', '==', row.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  const ids = collectSubtree(pagesById, id);
  const custodianUserIds = Array.from(new Set(ids.flatMap((pageId) => {
    const page = pagesById[pageId];
    return [page?.createdBy, page?.lastEditedBy].filter((userId): userId is string => Boolean(userId));
  })));
  await assertNoActiveLegalHoldForPermanentDelete(db, row.workspaceId, ids, custodianUserIds);
  const databaseIds = ids.filter((pageId) => pagesById[pageId]?.kind === 'database');
  const databaseIdSet = new Set(databaseIds);
  const propertiesTable = db.table<DbProperty>('db_properties');
  const allProperties = await listAll(propertiesTable, {
    label: 'Permanent database-row deletion schema',
  });
  const pendingRelations = planPermanentRelationDetachment(
    workspacePages,
    allProperties,
    ids,
    row.workspaceId,
  );
  // Two raw operations fence and update each surviving row. Always reserve
  // one slot for the row-root delete so an ordinary single-row cleanup can be
  // one atomic relation/delete transaction. Larger subtrees may use a separate
  // relation transaction, but the relation plan itself remains all-or-nothing.
  if (pendingRelations.size * 2 + 1 > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Too many surviving database rows reference this permanent deletion.'),
      { status: 413 },
    );
  }
  await markFileDeletionPending(db, row.workspaceId, ids);

  const blocksTable = db.table<Block>('blocks');
  const commentsTable = db.table<Comment>('comments');
  const operationsTable = db.table<CollaborationOperation>('collaboration_operations');
  const collaborationDocumentsTable = db.table<CollaborationDocument>('collaboration_documents');
  const permissionsTable = db.table<PagePermission>('page_permissions');
  const shareLinksTable = db.table<ShareLink>('share_links');
  const formLinksTable = db.table<FormLink>('form_links');
  const viewsTable = db.table<DbView>('db_views');
  const templatesTable = db.table<DbTemplate>('db_templates');
  const uploadsTable = db.table<FileUpload>('file_uploads');

  const [
    blocks,
    comments,
    operations,
    collaborationDocuments,
    permissions,
    shareLinks,
    formLinks,
    views,
    templates,
    uploadsByPage,
    uploadsByDatabase,
  ] = await Promise.all([
    listByIds(blocksTable, 'pageId', ids),
    listByIds(commentsTable, 'pageId', ids),
    listByIds(operationsTable, 'pageId', ids),
    listByIds(collaborationDocumentsTable, 'pageId', ids),
    listByIds(permissionsTable, 'pageId', ids),
    listByIds(shareLinksTable, 'pageId', ids),
    listByIds(formLinksTable, 'databaseId', databaseIds),
    listByIds(viewsTable, 'databaseId', databaseIds),
    listByIds(templatesTable, 'databaseId', databaseIds),
    listByIds(uploadsTable, 'pageId', ids),
    listByIds(uploadsTable, 'databaseId', databaseIds),
  ]);
  const properties = allProperties.filter((property) => databaseIdSet.has(property.databaseId));
  const uploads = uniqueById([...uploadsByPage, ...uploadsByDatabase]);
  const indexRows = await listByIds(
    db.table<{ id: string; rowId: string }>('db_property_indexes'),
    'rowId',
    ids,
  );
  const importArtifacts = await collectNotionImportArtifactsForDeletedContent(
    db,
    row.workspaceId,
    [
      ...ids,
      ...blocks.map((item) => item.id),
      ...comments.map((item) => item.id),
      ...operations.map((item) => item.id),
      ...collaborationDocuments.map((item) => item.id),
      ...permissions.map((item) => item.id),
      ...shareLinks.map((item) => item.id),
      ...formLinks.map((item) => item.id),
      ...properties.map((item) => item.id),
      ...views.map((item) => item.id),
      ...templates.map((item) => item.id),
      ...indexRows.map((item) => item.id),
      ...uploads.map((item) => item.id),
    ],
  );
  const routingIndexPlan = await collectPermanentRoutingIndexPlan(
    admin,
    row.workspaceId,
    ids,
  );

  // Resolve every bounded/fail-closed cleanup set before irreversible storage
  // or central notification writes, preserving a fully retryable fenced row.
  const { preservedUploadIds } = await deleteStoredUploadsBeforeMetadata({
    admin,
    workspace,
    uploads,
    storage,
    request,
    leaseGuard: lease,
    excludePageIds: ids,
    referenceSnapshotOptions: {
      preloadedPages: workspacePages,
      preloadedFileProperties: allProperties,
    },
  });
  const preservedUploads = new Set(preservedUploadIds);
  const deletedNotifications = await deleteNotificationsForDeletedContent(db, {
    workspaceId: row.workspaceId,
    pageIds: ids,
    blockIds: blocks.map((block) => block.id),
    commentIds: comments.map((comment) => comment.id),
  });

  // Row cleanup in chunked transact batches (see page-mutation deletePage):
  // bounded request count, atomic per chunk, pages deleted last. The subtree
  // snapshot is ancestor-first, so delete it in reverse order: descendants
  // commit before parents and the row root remains retryable until the final
  // page-delete chunk succeeds.
  const deletedAt = nowIso();
  const relationOps: TransactOperation[] = [];
  const affectedRelationRows = appendPendingRelationOperations(
    relationOps,
    pendingRelations,
    deletedAt,
    actorId,
  );
  const pageDeleteIds = [...ids].reverse();
  const cleanupOps: TransactOperation[] = [
    ...blocks.map((item): TransactOperation => ({ table: 'blocks', op: 'delete', id: item.id })),
    ...comments.map((item): TransactOperation => ({ table: 'comments', op: 'delete', id: item.id })),
    ...operations.map((item): TransactOperation => ({ table: 'collaboration_operations', op: 'delete', id: item.id })),
    ...collaborationDocuments.map((item): TransactOperation => ({ table: 'collaboration_documents', op: 'delete', id: item.id })),
    ...permissions.map((item): TransactOperation => ({ table: 'page_permissions', op: 'delete', id: item.id })),
    ...shareLinks.map((item): TransactOperation => ({ table: 'share_links', op: 'delete', id: item.id })),
    ...formLinks.map((item): TransactOperation => ({ table: 'form_links', op: 'delete', id: item.id })),
    ...properties.map((item): TransactOperation => ({ table: 'db_properties', op: 'delete', id: item.id })),
    ...views.map((item): TransactOperation => ({ table: 'db_views', op: 'delete', id: item.id })),
    ...templates.map((item): TransactOperation => ({ table: 'db_templates', op: 'delete', id: item.id })),
    ...indexRows.map((item): TransactOperation => ({ table: 'db_property_indexes', op: 'delete', id: item.id })),
    ...importArtifacts.itemIds.map((itemId): TransactOperation => ({ table: 'notion_import_items', op: 'delete', id: itemId })),
    ...importArtifacts.mappingIds.map((mappingId): TransactOperation => ({ table: 'notion_import_mappings', op: 'delete', id: mappingId })),
    ...uploads.filter((item) => !preservedUploads.has(item.id)).map((item): TransactOperation => ({
      table: 'file_uploads',
      op: 'update',
      id: item.id,
      data: { status: 'deleted', deletedAt, deletedBy: actorId },
    })),
  ];
  // Raw chunks stay under MAX_RAW_TRANSACT_OPS because the boundedDb facade
  // appends one change_log insert per op on change-logged tables; a 500-op
  // raw chunk would double past the server's 500-op transact cap.
  for (let i = 0; i < cleanupOps.length; i += MAX_RAW_TRANSACT_OPS) {
    await lease.renew();
    await db.transact(cleanupOps.slice(i, i + MAX_RAW_TRANSACT_OPS));
  }
  // Central ID routes are removed before page rows so stale public/share
  // resolution cannot reach erased content. Product callers include the
  // workspaceId retry anchor, which remains valid even after these routes are
  // gone and lets a later page-delete chunk finish idempotently.
  const routingIndexes = await deletePermanentRoutingIndexes(routingIndexPlan, lease.renew);
  const pageDeleteOps = pageDeleteIds.map((pageId): TransactOperation => ({
    table: 'pages', op: 'delete', id: pageId,
  }));
  if (relationOps.length + pageDeleteOps.length <= MAX_RAW_TRANSACT_OPS) {
    await lease.renew();
    await db.transact([...relationOps, ...pageDeleteOps]);
    if (affectedRelationRows.length > 0) {
      await bestEffort(
        'database-row-mutation rebuild relation indexes after permanent delete',
        upsertDatabaseIndexesForRows(db, affectedRelationRows),
      );
    }
  } else {
    // The root remains fenced and retryable. Commit relation detachment before
    // any descendant page chunk so a later partial page-delete failure cannot
    // erase the only snapshot that named a deleted descendant relation target.
    if (relationOps.length > 0) {
      await lease.renew();
      await db.transact(relationOps);
      await bestEffort(
        'database-row-mutation rebuild relation indexes after permanent delete',
        upsertDatabaseIndexesForRows(db, affectedRelationRows),
      );
    }
    for (let i = 0; i < pageDeleteOps.length; i += MAX_RAW_TRANSACT_OPS) {
      await lease.renew();
      await db.transact(pageDeleteOps.slice(i, i + MAX_RAW_TRANSACT_OPS));
    }
  }

  const cleanup = {
    blocks: blocks.length,
    comments: comments.length,
    collaborationOperations: operations.length,
    collaborationDocuments: collaborationDocuments.length,
    permissions: permissions.length,
    shareLinks: shareLinks.length,
    formLinks: formLinks.length,
    databaseProperties: properties.length,
    databaseViews: views.length,
    databaseTemplates: templates.length,
    notionImportItems: importArtifacts.itemIds.length,
    notionImportMappings: importArtifacts.mappingIds.length,
    fileUploads: uploads.length,
    notifications: deletedNotifications,
    relationRows: affectedRelationRows.length,
    ...routingIndexes,
  };
  await recordWorkspaceAudit(db, {
    workspaceId: row.workspaceId,
    actorId,
    action: 'database_row.delete',
    targetType: 'database_row',
    targetId: row.id,
    metadata: {
      rowId: row.id,
      databaseId: database.id,
      title: row.title,
      deletedPageCount: ids.length,
      cleanup,
    },
  });

  return {
    deletedIds: ids,
    cleanup,
  };
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request, storage } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const actorEmail = auth.email ?? null;

  try {
    // Inside the try so routing misses map to 404 via the catch below.
    const db = body.workspaceId
      ? boundedDbFromWorkspaceHint(admin, body.workspaceId)
      : await boundedDbFromPageHint(admin, body.databaseId, body.id, body.rowId);
    if (action === 'create' || action === 'update') {
      await assertOrganizationDlpContent(db, body);
    }
    switch (action) {
      case 'create':
        return await createDatabaseRow(db, admin, body, auth.id, actorEmail, request?.url);
      case 'update':
        return await updateDatabaseRow(db, body, auth.id, actorEmail);
      case 'move':
        return await moveDatabaseRow(db, body, auth.id, actorEmail);
      case 'reparentSubitem':
        return await reparentDatabaseSubitem(db, body, auth.id, actorEmail);
      case 'updateDependencies':
        return await updateDatabaseDependencies(db, body, auth.id, actorEmail);
      case 'updateDependencyDate':
        return await updateDatabaseDependencyDate(db, body, auth.id, actorEmail);
      case 'moveToDatabase':
        return await moveDatabaseRowToDatabase(db, body, auth.id, actorEmail);
      case 'movePageToDatabase':
        return await movePageIntoDatabase(db, body, auth.id, actorEmail);
      case 'moveToPage':
      case 'moveToWorkspace':
        return await moveDatabaseRowToPage(db, body, auth.id, actorEmail);
      case 'trash':
        return await trashDatabaseRow(db, body, auth.id, actorEmail);
      case 'restore':
        return await restoreDatabaseRow(db, body, auth.id, actorEmail);
      case 'delete':
        return await deleteDatabaseRow(db, admin, body, auth.id, actorEmail, storage, request);
      default:
        return jsonError(400, 'Unknown database row mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 423, needles: ['locked'] },
      { status: 403, needles: ['access required', 'outside the row workspace'] },
      { status: 409, needles: ['changed since'] },
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
});
