import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import {
  MAX_RAW_TRANSACT_OPS,
  boundedDbFromPageHint,
  boundedDbFromWorkspaceHint,
  ensurePageWorkspaceIndex,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import { upsertDatabaseIndexesForRows } from '../lib/database-index';
import { assertNoActiveLegalHoldForPermanentDelete } from '../lib/enterprise-controls';
import { recordWorkspaceAudit } from '../lib/org-audit';
import {
  canManagePageAccess as sharedCanManagePageAccess,
  pageAccessRole as sharedPageAccessRole,
} from '../lib/page-access';
import { deleteStoredUploadsBeforeMetadata } from '../lib/permanent-file-delete';
import { deleteNotificationsForDeletedContent } from '../lib/permanent-notification-delete';
import { collectNotionImportArtifactsForDeletedContent } from '../lib/permanent-import-delete';
import {
  collectPermanentRoutingIndexPlan,
  deletePermanentRoutingIndexes,
} from '../lib/permanent-routing-index-delete';
import {
  assertFileTargetsNotDeleting,
  markFileDeletionPending,
  withFileWorkspaceLease,
  type FileWorkspaceLeaseGuard,
} from '../lib/file-operation-lock';
import {
  assertNoUnownedStoredFileReferences,
  schemaFilePropertyReferences,
  storedFileReferencesChanged,
  updateWithFileReferenceLifecycle,
} from '../lib/file-reference-lifecycle';

import {
  bestEffort,
  listAll,
  requireString,
  getExisting,
  nowIso,
  newId,
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
  FunctionContext,
  FunctionStorageProxy,
  Page,
  PagePermission,
  ShareLink,
  TableRef,
  Workspace,
} from '../lib/app-types';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

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

const readonlyPropertyTypes = new Set([
  'title',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'rollup',
  'formula',
  'unique_id',
]);

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
      if (page.parentId === id) visit(page.id);
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
) {
  const targetDbId = relationTargetDatabaseId(prop);
  const targetDb = await getExisting(pages, targetDbId);
  if (!targetDb || targetDb.kind !== 'database' || targetDb.inTrash) {
    throw new Error(`Relation target database was not found for property ${prop.name ?? prop.id}.`);
  }
  if (targetDb.workspaceId !== owner.workspaceId) {
    throw new Error(`Relation target database is outside the row workspace: ${prop.name ?? prop.id}.`);
  }

  for (const id of uniqueIds(value)) {
    const target = await getExisting(pages, id);
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

async function normalizeRowProperties(
  pages: TableRef<Page>,
  owner: Page,
  props: DbProperty[],
  input: Record<string, unknown>,
  options: { existing?: Record<string, unknown>; rejectReadonly: boolean },
) {
  const propsById = new Map(props.map((prop) => [prop.id, prop]));
  const out: Record<string, unknown> = {};

  for (const [propId, rawValue] of Object.entries(input)) {
    // Imported row metadata is stored beside real property ids and preserved by
    // the merge below, but it is not part of the editable database schema.
    if (propId.startsWith('__')) continue;
    const prop = propsById.get(propId);
    if (!prop) throw new Error(`Unknown database property: ${propId}.`);

    const previous = options.existing?.[propId];
    const changed = !jsonSame(rawValue, previous);
    if (readonlyPropertyTypes.has(prop.type)) {
      if (options.rejectReadonly && changed) {
        throw new Error(`Cannot change read-only database property: ${prop.name ?? prop.id}.`);
      }
      if (previous !== undefined) out[propId] = previous;
      continue;
    }

    if (prop.type === 'relation') {
      if (changed) await assertRelationValue(pages, owner, prop, rawValue);
      const nextIds = uniqueIds(rawValue);
      out[propId] = nextIds.length ? nextIds : null;
      continue;
    }

    out[propId] = cloneJson(rawValue);
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
  const sourceDatabaseId = requireString(sourceRow.parentId, 'sourceRow.parentId');
  const propsByDb = new Map<string, DbProperty[]>([[sourceDatabaseId, sourceProps]]);
  const affectedRows: Page[] = [];

  for (const prop of sourceProps) {
    if (prop.type !== 'relation') continue;
    if (changedPropertyIds && !changedPropertyIds.has(prop.id)) continue;
    const previousIds = uniqueIds(previousProperties[prop.id]);
    const nextIds = uniqueIds(nextProperties[prop.id]);
    if (!relationIdsChanged(previousIds, nextIds)) continue;

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
    const targetIds = Array.from(new Set([...previousIds, ...nextIds]));

    for (const targetId of targetIds) {
      const target = await getExisting(pages, targetId);
      if (!target || target.workspaceId !== sourceRow.workspaceId) continue;
      const currentIds = uniqueIds(target.properties?.[reciprocal.id]);
      let reciprocalIds = currentIds;

      if (nextSet.has(targetId) && !reciprocalIds.includes(sourceRow.id)) {
        reciprocalIds = [...reciprocalIds, sourceRow.id];
      }
      if (!nextSet.has(targetId) && previousSet.has(targetId)) {
        reciprocalIds = reciprocalIds.filter((id) => id !== sourceRow.id);
      }
      if (jsonSame(currentIds, reciprocalIds)) continue;

      const properties = {
        ...(target.properties ?? {}),
        [reciprocal.id]: reciprocalIds.length ? reciprocalIds : null,
      };
      affectedRows.push(
        await pages.update(target.id, {
          properties,
          updatedAt: nowIso(),
          lastEditedBy: actorId,
        }),
      );
    }
  }

  return affectedRows;
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

  // Property deletion uses this same workspace lease. Re-read both the target
  // database and its schema only after owning the lease, so a row can never
  // commit values that were validated against a property which has since been
  // tombstoned. The target fence also prevents a row from being created while
  // its database/page hierarchy is being permanently deleted.
  await lease.assertOwned();
  await assertFileTargetsNotDeleting(db, workspaceId, [requestedDatabase.id, targetDatabaseId]);

  const [props, rows, templates] = await Promise.all([
    listAll(propertiesTable.where('databaseId', '==', targetDatabaseId)),
    listAll(pages.where('parentId', '==', targetDatabaseId)),
    listAll(templatesTable.where('databaseId', '==', targetDatabaseId)),
  ]);

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
  const activeRows = rows.filter((row) => row.parentType === 'database' && !row.inTrash);
  for (const prop of props) {
    if (prop.type !== 'unique_id') continue;
    let max = 0;
    for (const row of activeRows) {
      const value = Number(row.properties?.[prop.id]);
      if (Number.isFinite(value) && value > max) max = value;
    }
    nextProperties[prop.id] = max + 1;
  }

  const lastPosition = activeRows.reduce<number | undefined>(
    (max, row) => (max == null || row.position > max ? row.position : max),
    undefined,
  );
  const position =
    typeof body.position === 'number' && Number.isFinite(body.position)
      ? body.position
      : positionBetween(lastPosition, undefined);
  const now = nowIso();
  const row: Page = {
    id: typeof body.id === 'string' && body.id.trim() ? body.id : newId(),
    workspaceId: database.workspaceId,
    parentId: targetDatabaseId,
    parentType: 'database',
    kind: 'page',
    title: typeof body.title === 'string' ? body.title : template?.title ?? '',
    icon: typeof body.icon === 'string' ? body.icon : template?.icon,
    iconType: iconTypeForValue(typeof body.icon === 'string' ? body.icon : template?.icon),
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
  await assertNoUnownedStoredFileReferences(db, {
    icon: row.icon,
    properties: row.properties,
    schemaFileProperties: schemaFilePropertyReferences(row.properties, filePropertyIds),
    templateBlocks: template?.blocks,
  }, { requestUrl });

  const responseParentId = mutationTarget.sourceResolved ? requestedDatabase.id : targetDatabaseId;
  const insertedBlocks: Block[] = [];
  let insertedRow: Page | null = null;
  try {
    insertedRow = await pages.insert(row);
    await ensurePageWorkspaceIndex(admin, insertedRow.id, insertedRow.workspaceId);
    const templateBlocks = Array.isArray(template?.blocks) ? template.blocks : [];
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
  return withFileWorkspaceLease(
    db,
    workspaceId,
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
      { existing: row.properties ?? {}, rejectReadonly: true },
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
  const updated = storedFileReferencesChanged(currentFileReferences, nextFileReferences)
    ? await updateWithFileReferenceLifecycle(db, {
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
      })
    : await pages.update(id, rowUpdateData);
  const affectedRows =
    changedPropertyIds && row.parentId
      ? await syncReciprocalRelations({
          pages,
          propertiesTable,
          sourceRow: updated,
          sourceProps: await listAll(propertiesTable.where('databaseId', '==', row.parentId)),
          previousProperties: row.properties ?? {},
          nextProperties: updated.properties ?? {},
          changedPropertyIds,
          actorId,
        })
      : [];
  const finalRow = affectedRows.find((page) => page.id === updated.id) ?? updated;
  await bestEffort('database-row-mutation upsertDatabaseIndexesForRows', upsertDatabaseIndexesForRows(db, uniqueById([finalRow, ...affectedRows])));
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
  const initialDatabase = await getExisting(pages, initialRow.parentId);
  if (!initialDatabase) throw new Error('Database was not found.');
  if (initialDatabase.kind !== 'database') throw new Error('Parent page is not a database.');
  await assertCanEditPage(db, initialRow, actorId, actorEmail);

  return withFileWorkspaceLease(
    db,
    initialRow.workspaceId,
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

  const rows = (await listAll(pages.where('parentId', '==', database.id)))
    .filter((item) => item.parentType === 'database' && !item.inTrash && item.id !== row.id)
    .sort((a, b) => a.position - b.position);
  const targetIndex = rows.findIndex((item) => item.id === target.id);
  if (targetIndex < 0) throw new Error('Target database row was not found.');

  const insertionIndex = targetIndex + (side === 'after' ? 1 : 0);
  const previous = rows[insertionIndex - 1];
  const next = rows[insertionIndex];
  const position = positionBetween(previous?.position, next?.position);
  const updated = await pages.update(row.id, {
    position,
    updatedAt: nowIso(),
    lastEditedBy: actorId,
  });
  await bestEffort('database-row-mutation upsertDatabaseIndexesForRows', upsertDatabaseIndexesForRows(db, [updated]));

  return { row: updated, target, side, position };
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

async function trashDatabaseRow(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const id = requireString(body.id, 'id');
  const { pages, row } = await getDatabaseRowContext(db, id, actorId, { allowTrashed: true, actorEmail });
  const workspacePages = await listAll(pages.where('workspaceId', '==', row.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  const ts = nowIso();
  const updated: Page[] = [];

  for (const pageId of collectSubtree(pagesById, id)) {
    const page = pagesById[pageId];
    if (!page || (page.inTrash && pageId !== id)) continue;
    updated.push(
      await pages.update(pageId, {
        inTrash: true,
        trashedAt: ts,
        updatedAt: ts,
        lastEditedBy: actorId,
      }),
    );
  }

  return { row: updated.find((page) => page.id === id) ?? row, pages: updated };
}

async function restoreDatabaseRow(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const id = requireString(body.id, 'id');
  const initial = await getExisting(db.table<Page>('pages'), id);
  if (!initial) throw new Error('Database row was not found.');
  return withFileWorkspaceLease(db, initial.workspaceId, actorId, 'database-row-restore', async (lease) => {
    await lease.assertOwned();
    const { pages, row } = await getDatabaseRowContext(db, id, actorId, { allowTrashed: true, actorEmail });
    if (row.deletionPendingAt) {
      throw Object.assign(
        new Error('Permanent database-row deletion is in progress; retry the deletion instead of restoring.'),
        { status: 409 },
      );
    }
    const workspacePages = await listAll(pages.where('workspaceId', '==', row.workspaceId));
    const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
    const restoreIds = collectSubtree(pagesById, id);
    if (restoreIds.some((pageId) => pagesById[pageId]?.deletionPendingAt)) {
      throw Object.assign(
        new Error('Permanent database-row deletion is in progress; retry the deletion instead of restoring.'),
        { status: 409 },
      );
    }
    const restoreStamp = row.trashedAt;
    const ts = nowIso();
    const updated: Page[] = [];

    for (const pageId of restoreIds) {
      const page = pagesById[pageId];
      if (!page?.inTrash) continue;
      if (pageId !== id && restoreStamp && page.trashedAt !== restoreStamp) continue;
      updated.push(
        await pages.update(pageId, {
          inTrash: false,
          trashedAt: null,
          deletionPendingAt: null,
          updatedAt: ts,
          lastEditedBy: actorId,
        }),
      );
    }

    return { row: updated.find((page) => page.id === id) ?? row, pages: updated };
  });
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
  const workspacePages = await listAll(pages.where('workspaceId', '==', row.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  const ids = collectSubtree(pagesById, id);
  await assertNoActiveLegalHoldForPermanentDelete(db, row.workspaceId, ids);
  await markFileDeletionPending(db, row.workspaceId, ids);
  const databaseIds = ids.filter((pageId) => pagesById[pageId]?.kind === 'database');

  const blocksTable = db.table<Block>('blocks');
  const commentsTable = db.table<Comment>('comments');
  const operationsTable = db.table<CollaborationOperation>('collaboration_operations');
  const collaborationDocumentsTable = db.table<CollaborationDocument>('collaboration_documents');
  const permissionsTable = db.table<PagePermission>('page_permissions');
  const shareLinksTable = db.table<ShareLink>('share_links');
  const propertiesTable = db.table<DbProperty>('db_properties');
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
    properties,
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
    listByIds(propertiesTable, 'databaseId', databaseIds),
    listByIds(viewsTable, 'databaseId', databaseIds),
    listByIds(templatesTable, 'databaseId', databaseIds),
    listByIds(uploadsTable, 'pageId', ids),
    listByIds(uploadsTable, 'databaseId', databaseIds),
  ]);
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
  const pageDeleteIds = [...ids].reverse();
  const cleanupOps: TransactOperation[] = [
    ...blocks.map((item): TransactOperation => ({ table: 'blocks', op: 'delete', id: item.id })),
    ...comments.map((item): TransactOperation => ({ table: 'comments', op: 'delete', id: item.id })),
    ...operations.map((item): TransactOperation => ({ table: 'collaboration_operations', op: 'delete', id: item.id })),
    ...collaborationDocuments.map((item): TransactOperation => ({ table: 'collaboration_documents', op: 'delete', id: item.id })),
    ...permissions.map((item): TransactOperation => ({ table: 'page_permissions', op: 'delete', id: item.id })),
    ...shareLinks.map((item): TransactOperation => ({ table: 'share_links', op: 'delete', id: item.id })),
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
  for (let i = 0; i < pageDeleteOps.length; i += MAX_RAW_TRANSACT_OPS) {
    await lease.renew();
    await db.transact(pageDeleteOps.slice(i, i + MAX_RAW_TRANSACT_OPS));
  }

  const cleanup = {
    blocks: blocks.length,
    comments: comments.length,
    collaborationOperations: operations.length,
    collaborationDocuments: collaborationDocuments.length,
    permissions: permissions.length,
    shareLinks: shareLinks.length,
    databaseProperties: properties.length,
    databaseViews: views.length,
    databaseTemplates: templates.length,
    notionImportItems: importArtifacts.itemIds.length,
    notionImportMappings: importArtifacts.mappingIds.length,
    fileUploads: uploads.length,
    notifications: deletedNotifications,
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
    switch (action) {
      case 'create':
        return await createDatabaseRow(db, admin, body, auth.id, actorEmail, request?.url);
      case 'update':
        return await updateDatabaseRow(db, body, auth.id, actorEmail);
      case 'move':
        return await moveDatabaseRow(db, body, auth.id, actorEmail);
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
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
});
