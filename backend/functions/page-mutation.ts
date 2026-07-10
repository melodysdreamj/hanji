import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import {
  MAX_RAW_TRANSACT_OPS,
  boundedDbFromPageHint,
  boundedDbFromWorkspaceHint,
  ensurePageWorkspaceIndex,
} from '../lib/workspace-db';
import { assertNoActiveLegalHoldForPermanentDelete } from '../lib/enterprise-controls';
import { recordWorkspaceAudit } from '../lib/org-audit';
import {
  canManagePageAccess as sharedCanManagePageAccess,
  pageAccessRole as sharedPageAccessRole,
  workspaceAccessRole as sharedWorkspaceAccessRole,
} from '../lib/page-access';

import {
  bestEffort,
  listAll,
  requireStringRaw as requireString,
  getExisting,
  nowIso,
  type TransactOperation,
} from '../lib/table-utils';
import { v } from '../lib/validate';
import type { ShareRole } from '../lib/page-access';
import type {
  Block,
  CollaborationDocument,
  CollaborationOperation,
  Comment,
  DbProperty,
  DbRef,
  DbTemplate,
  DbView,
  FileUpload,
  FunctionContext,
  FunctionStorageProxy,
  Page,
  PageKind,
  PagePermission,
  PageParentType,
  ShareLink,
  TableRef,
  Workspace,
} from '../lib/app-types';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

const FILE_BUCKET = 'files';

type PagePatch = Partial<Page>;

const parentTypes = new Set<PageParentType>(['workspace', 'page', 'database']);
const pageKinds = new Set<PageKind>(['page', 'database']);
const patchKeys = new Set<keyof Page>([
  'parentId',
  'parentType',
  'kind',
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
  'inTrash',
  'trashedAt',
  'position',
  'lastEditedBy',
  'updatedAt',
]);

// Patch fields that require manage-level rights (not plain edit): web sharing
// and page-verification metadata. Enforced in updatePage against
// canManagePageAccess so an edit-only actor cannot set them.
const managedPatchKeys: Array<keyof Page> = [
  'isPublic',
  'verifiedAt',
  'verifiedBy',
  'verificationExpiresAt',
];

const lockedPatchKeys = new Set<keyof Page>([
  'isLocked',
  'isFavorite',
  'isPublic',
  'backlinksDisplay',
  'pageCommentsDisplay',
  'verifiedAt',
  'verifiedBy',
  'verificationExpiresAt',
  'parentId',
  'parentType',
  'position',
  'inTrash',
  'trashedAt',
  'updatedAt',
  'lastEditedBy',
]);
const pageParentTypeSchema = v.oneOf(['workspace', 'page', 'database']);
const pageKindSchema = v.oneOf(['page', 'database']);

// Patch fields tolerate null (clients clear values with null); non-null values
// must match the column type so cleanPatch can no longer store junk.
const pagePatchSchema = v.object({
  parentId: v.nullish(v.id()),
  parentType: v.optional(pageParentTypeSchema),
  kind: v.optional(pageKindSchema),
  title: v.nullish(v.shortText()),
  icon: v.nullish(v.shortText()),
  iconType: v.nullish(v.oneOf(['none', 'emoji', 'image'])),
  cover: v.nullish(v.shortText()),
  coverPosition: v.nullish(v.number()),
  font: v.nullish(v.oneOf(['default', 'serif', 'mono'])),
  smallText: v.nullish(v.boolean()),
  fullWidth: v.nullish(v.boolean()),
  isLocked: v.nullish(v.boolean()),
  isPublic: v.nullish(v.boolean()),
  backlinksDisplay: v.nullish(v.oneOf(['default', 'expanded', 'off'])),
  pageCommentsDisplay: v.nullish(v.oneOf(['default', 'expanded', 'off'])),
  verifiedAt: v.nullish(v.shortText()),
  verifiedBy: v.nullish(v.id()),
  verificationExpiresAt: v.nullish(v.shortText()),
  properties: v.nullish(v.jsonRecord()),
  isFavorite: v.nullish(v.boolean()),
  inTrash: v.nullish(v.boolean()),
  trashedAt: v.nullish(v.shortText()),
  position: v.nullish(v.number()),
});

const createBodySchema = v.object({
  id: v.id(),
  workspaceId: v.id(),
  parentId: v.nullish(v.id()),
  parentType: pageParentTypeSchema,
  kind: v.optional(pageKindSchema),
  title: v.nullish(v.shortText()),
  icon: v.nullish(v.shortText()),
  iconType: v.nullish(v.oneOf(['none', 'emoji', 'image'])),
  cover: v.nullish(v.shortText()),
  coverPosition: v.nullish(v.number()),
  font: v.nullish(v.oneOf(['default', 'serif', 'mono'])),
  smallText: v.nullish(v.boolean()),
  fullWidth: v.nullish(v.boolean()),
  properties: v.nullish(v.jsonRecord()),
  position: v.number(),
});

const updateBodySchema = v.object({
  id: v.id(),
  expectedUpdatedAt: v.nullish(v.shortText()),
  patch: v.optional(pagePatchSchema),
});

const pageIdBodySchema = v.object({
  id: v.id(),
});

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

function storageUrl(request: Request | undefined, bucket: string, key: string) {
  if (!request) return undefined;
  const origin = new URL(request.url).origin;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${origin}/api/storage/${encodeURIComponent(bucket)}/${encodedKey}`;
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

async function deleteStoredFile(
  storage: FunctionStorageProxy | undefined,
  request: Request | undefined,
  bucket: string,
  key: string,
) {
  const proxy = storageBucket(storage, bucket);
  if (proxy) {
    await proxy.delete(key);
    return;
  }

  const url = storageUrl(request, bucket, key);
  if (!url || !request) return;
  const headers = new Headers();
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  const response = await fetch(url, { method: 'DELETE', headers });
  if (response.ok || response.status === 404) return;
  throw new Error('Stored file delete failed.');
}

function cleanPatch(patch: Record<string, unknown>): PagePatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!patchKeys.has(key as keyof Page)) continue;
    if (key === 'parentType' && !parentTypes.has(value as PageParentType)) continue;
    if (key === 'kind' && !pageKinds.has(value as PageKind)) continue;
    if (value !== undefined) out[key] = value;
  }
  delete out.createdAt;
  delete out.id;
  delete out.workspaceId;
  delete out.createdBy;
  delete out.updatedAt;
  delete out.lastEditedBy;
  return out as PagePatch;
}

function lockedPageAllowsPatch(patch: PagePatch) {
  return Object.keys(patch).every((key) => lockedPatchKeys.has(key as keyof Page));
}

function optionalParentId(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('parentId must be a string or null.');
  return value;
}

function optionalExpectedUpdatedAt(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('expectedUpdatedAt must be a non-empty string when provided.');
  }
  return value.trim();
}

function parseParentType(value: unknown): PageParentType {
  if (!parentTypes.has(value as PageParentType)) {
    throw new Error('parentType must be workspace, page, or database.');
  }
  return value as PageParentType;
}

function parseKind(value: unknown): PageKind {
  if (value === undefined) return 'page';
  if (!pageKinds.has(value as PageKind)) {
    throw new Error('kind must be page or database.');
  }
  return value as PageKind;
}

function parsePosition(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('position must be a finite number.');
  }
  return value;
}

// Bounded fan-out: a 1,000-page subtree must not turn into 1,000 concurrent
// queries (that wedged the local runtime during permanent delete of a large
// imported database).
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

// Role resolution is canonical in lib/page-access; these wrappers only pin
// this function's "missing workspace is an error" contract.
async function workspaceRole(db: DbRef, workspaceId: string, actorId: string): Promise<ShareRole | undefined> {
  return sharedWorkspaceAccessRole(db, workspaceId, actorId, { requireWorkspace: true });
}

async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
}

async function assertWorkspaceEdit(db: DbRef, workspaceId: string, actorId: string) {
  const role = await workspaceRole(db, workspaceId, actorId);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Workspace access required.');
}

async function assertCanEditPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Page access required.');
}

async function writableParent(
  db: DbRef,
  workspaceId: string,
  parentId: string | null,
  parentType: PageParentType,
  childKind: PageKind,
  actorId: string,
  actorEmail?: string | null,
) {
  if (!parentId || parentType === 'workspace') {
    await assertWorkspaceEdit(db, workspaceId, actorId);
    return null;
  }

  const parent = await getExisting(db.table<Page>('pages'), parentId);
  if (!parent) throw new Error('Parent page was not found.');
  if (parent.workspaceId !== workspaceId) throw new Error('Parent page is outside the workspace.');
  if (parent.inTrash) throw new Error('Parent page is in trash.');
  if (parent.isLocked) throw new Error('Parent page is locked.');
  if (parentType === 'database') {
    if (parent.kind !== 'database') throw new Error('Parent page is not a database.');
    if (childKind !== 'page') throw new Error('Only regular pages can be placed in a database.');
  }
  if (parentType === 'page' && parent.kind !== 'page') {
    throw new Error('Parent page is not a page.');
  }
  await assertCanEditPage(db, parent, actorId, actorEmail);
  return parent;
}

async function createPage(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pages = db.table<Page>('pages');
  const now = nowIso();
  const parentId = optionalParentId(body.parentId);
  const parentType = parseParentType(body.parentType);
  const kind = parseKind(body.kind);
  const workspaceId = requireString(body.workspaceId, 'workspaceId');

  await writableParent(db, workspaceId, parentId, parentType, kind, actorId, actorEmail);

  const page: Page = {
    id: requireString(body.id, 'id'),
    workspaceId,
    parentId,
    parentType,
    kind,
    title: typeof body.title === 'string' ? body.title : '',
    icon: typeof body.icon === 'string' ? body.icon : undefined,
    iconType: typeof body.iconType === 'string' ? (body.iconType as Page['iconType']) : 'none',
    cover: typeof body.cover === 'string' ? body.cover : undefined,
    coverPosition: typeof body.coverPosition === 'number' ? body.coverPosition : undefined,
    font: typeof body.font === 'string' ? (body.font as Page['font']) : 'default',
    smallText: body.smallText === true,
    fullWidth: body.fullWidth === true,
    isLocked: false,
    isPublic: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties:
      body.properties && typeof body.properties === 'object'
        ? (body.properties as Record<string, unknown>)
        : undefined,
    isFavorite: false,
    inTrash: false,
    position: parsePosition(body.position),
    createdBy: actorId,
    lastEditedBy: actorId,
    createdAt: now,
    updatedAt: now,
  };

  return pages.insert(page);
}

async function updatePage(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pages = db.table<Page>('pages');
  const id = requireString(body.id, 'id');
  const current = await getExisting(pages, id);
  if (!current) throw new Error('Page was not found.');
  if (current.inTrash) throw new Error('Page is in trash.');
  // Optional optimistic-concurrency guard: when the client sends the
  // updatedAt it loaded, reject stale whole-object property replacements.
  // Absent, behavior stays last-write-wins for backwards compatibility.
  const expectedUpdatedAt = optionalExpectedUpdatedAt(body.expectedUpdatedAt);
  if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
    throw new Error('Page changed since it was loaded.');
  }
  await assertCanEditPage(db, current, actorId, actorEmail);

  const patch = cleanPatch(
    body.patch && typeof body.patch === 'object' ? (body.patch as Record<string, unknown>) : {},
  );

  // Sharing and verification are manage-level, not plain edit: an edit-but-not
  // manage actor must not toggle public sharing or forge verifiedBy/verifiedAt
  // through the generic page patch. Web sharing and verification have their own
  // manage-gated code paths (share-mutation setWebSharing); when these fields
  // appear here we require manage rights explicitly.
  if (managedPatchKeys.some((key) => key in patch)) {
    const workspace = await getExisting(db.table<Workspace>('workspaces'), current.workspaceId);
    if (!workspace) throw new Error('Workspace was not found.');
    if (!(await sharedCanManagePageAccess(db, current, workspace, actorId, actorEmail))) {
      throw new Error('Page access required.');
    }
  }

  if (current.isLocked && !lockedPageAllowsPatch(patch)) {
    throw new Error('Page is locked.');
  }

  if (
    ('parentId' in patch || 'parentType' in patch) &&
    (patch.parentId !== current.parentId || patch.parentType !== current.parentType)
  ) {
    const targetParent = await writableParent(
      db,
      current.workspaceId,
      patch.parentId === undefined ? current.parentId ?? null : patch.parentId ?? null,
      patch.parentType ?? current.parentType,
      patch.kind ?? current.kind,
      actorId,
      actorEmail,
    );
    if (targetParent) {
      const pagesById = Object.fromEntries(
        (await listAll(pages.where('workspaceId', '==', current.workspaceId))).map((page) => [page.id, page]),
      );
      if (collectSubtree(pagesById, id).includes(targetParent.id)) {
        throw new Error('Cannot move a page inside itself or one of its descendants.');
      }
    }
  }

  const nextPatch = {
    ...patch,
    updatedAt: nowIso(),
    lastEditedBy: actorId,
  };
  return pages.update(id, nextPatch);
}

async function trashPage(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pages = db.table<Page>('pages');
  const id = requireString(body.id, 'id');
  const root = await getExisting(pages, id);
  if (!root) throw new Error('Page was not found.');
  await assertCanEditPage(db, root, actorId, actorEmail);
  const workspacePages = await listAll(pages.where('workspaceId', '==', root.workspaceId));
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

  return { pages: updated };
}

async function restorePage(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pages = db.table<Page>('pages');
  const id = requireString(body.id, 'id');
  const root = await getExisting(pages, id);
  if (!root) throw new Error('Page was not found.');
  await assertCanEditPage(db, root, actorId, actorEmail);
  if (root.parentId) {
    const parent = await getExisting(pages, root.parentId);
    if (parent && !parent.inTrash) {
      await writableParent(db, root.workspaceId, root.parentId, root.parentType, root.kind, actorId, actorEmail);
    }
  } else {
    await assertWorkspaceEdit(db, root.workspaceId, actorId);
  }
  const workspacePages = await listAll(pages.where('workspaceId', '==', root.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  const restoreStamp = root.trashedAt;
  const ts = nowIso();
  const updated: Page[] = [];

  for (const pageId of collectSubtree(pagesById, id)) {
    const page = pagesById[pageId];
    if (!page?.inTrash) continue;
    if (pageId !== id && restoreStamp && page.trashedAt !== restoreStamp) continue;
    updated.push(
      await pages.update(pageId, {
        inTrash: false,
        trashedAt: null,
        updatedAt: ts,
        lastEditedBy: actorId,
      }),
    );
  }

  return { pages: updated };
}

async function deletePage(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const pages = db.table<Page>('pages');
  const id = requireString(body.id, 'id');
  const root = await getExisting(pages, id);
  if (!root) throw new Error('Page was not found.');
  await assertCanEditPage(db, root, actorId, actorEmail);
  const workspacePages = await listAll(pages.where('workspaceId', '==', root.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  const ids = collectSubtree(pagesById, id);
  await assertNoActiveLegalHoldForPermanentDelete(db, root.workspaceId, ids);
  const databaseIds = ids.filter((pageId) => pagesById[pageId]?.kind === 'database');

  const blocksTable = db.table<Block>('blocks');
  const commentsTable = db.table<Comment>('comments');
  const permissionsTable = db.table<PagePermission>('page_permissions');
  const shareLinksTable = db.table<ShareLink>('share_links');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const viewsTable = db.table<DbView>('db_views');
  const templatesTable = db.table<DbTemplate>('db_templates');
  const uploadsTable = db.table<FileUpload>('file_uploads');

  const operationsTable = db.table<CollaborationOperation>('collaboration_operations');
  const collaborationDocumentsTable = db.table<CollaborationDocument>('collaboration_documents');

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

  // Stored file deletions are storage-side (not table rows); bound the fan-out.
  const undeletedUploads = uploads.filter((item) => item.status !== 'deleted');
  for (let i = 0; i < undeletedUploads.length; i += 10) {
    await Promise.all(
      undeletedUploads.slice(i, i + 10).map((item) =>
        bestEffort('page-mutation deleteStoredFile', deleteStoredFile(storage, request, item.bucket || FILE_BUCKET, item.key)),
      ),
    );
  }

  // All row cleanup goes through chunked transact batches: one request per
  // ~500 rows instead of thousands of concurrent deletes (which wedged the
  // runtime on large imported databases), atomic per chunk, pages deleted
  // last so a partial failure leaves the subtree discoverable and retryable.
  const indexRows = await listByIds(
    db.table<{ id: string; rowId: string }>('db_property_indexes'),
    'rowId',
    ids,
  );
  const deletedAt = nowIso();
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
    ...uploads.map((item): TransactOperation => ({
      table: 'file_uploads',
      op: 'update',
      id: item.id,
      data: { status: 'deleted', deletedAt, deletedBy: actorId },
    })),
    ...ids.map((pageId): TransactOperation => ({ table: 'pages', op: 'delete', id: pageId })),
  ];
  // Raw chunks stay under MAX_RAW_TRANSACT_OPS because the boundedDb facade
  // appends one change_log insert per op on change-logged tables; a 500-op
  // raw chunk would double past the server's 500-op transact cap.
  for (let i = 0; i < cleanupOps.length; i += MAX_RAW_TRANSACT_OPS) {
    await db.transact(cleanupOps.slice(i, i + MAX_RAW_TRANSACT_OPS));
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
    fileUploads: uploads.length,
  };
  await recordWorkspaceAudit(db, {
    workspaceId: root.workspaceId,
    actorId,
    action: 'page.delete',
    targetType: root.kind === 'database' ? 'database' : 'page',
    targetId: root.id,
    metadata: {
      pageId: root.id,
      title: root.title,
      kind: root.kind,
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

  try {
    if (!['create', 'update', 'move', 'trash', 'restore', 'delete', 'duplicate'].includes(action)) {
      return jsonError(400, 'Unknown page mutation action.');
    }
    const db = body.workspaceId
      ? boundedDbFromWorkspaceHint(admin, body.workspaceId)
      : await boundedDbFromPageHint(admin, body.id, body.pageId, body.parentId);
    const actorEmail = auth.email ?? null;
    switch (action) {
      case 'create': {
        const created = await createPage(db, createBodySchema.parse(body), auth.id, actorEmail);
        await ensurePageWorkspaceIndex(admin, created.id, created.workspaceId);
        return { page: created };
      }
      case 'update':
      case 'move':
        return { page: await updatePage(db, updateBodySchema.parse(body), auth.id, actorEmail) };
      case 'trash':
        return await trashPage(db, pageIdBodySchema.parse(body), auth.id, actorEmail);
      case 'restore':
        return await restorePage(db, pageIdBodySchema.parse(body), auth.id, actorEmail);
      case 'delete':
        return await deletePage(db, pageIdBodySchema.parse(body), auth.id, actorEmail, storage, request);
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['access required'] },
      { status: 423, needles: ['locked'] },
      { status: 409, needles: ['changed since'] },
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
});
