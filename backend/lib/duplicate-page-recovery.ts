import {
  acquireFileWorkspaceLease,
  deferFileWorkspaceLeaseRecovery,
  releaseFileWorkspaceLease,
} from './file-operation-lock';
import { releaseOrganizationStorage } from './storage-quota';
import { getExisting, listAll, type TransactOperation } from './table-utils';
import type {
  Block,
  DbRef,
  DbProperty,
  DbTemplate,
  DbView,
  FileUpload,
  FunctionStorageProxy,
  Page,
  Workspace,
} from './app-types';
import type { AdminDbAccessor } from './workspace-db';

const FILE_BUCKET = 'files';
const DUPLICATE_PAGE_RECOVERY_KIND = 'duplicate-page-v1';
const MAX_RECOVERY_UPLOADS = 100;
const MAX_RECOVERY_TRANSACT_OPS = 200;

export interface DuplicatePageRecoveryData {
  kind: typeof DUPLICATE_PAGE_RECOVERY_KIND;
  status: 'staging' | 'committed';
  rootPageId: string;
  uploadIds: string[];
  stagingTrashAt: string;
}

interface FileWorkspaceLock {
  id: string;
  workspaceId: string;
  leaseId: string;
  operation: string;
  recoveryData?: unknown;
  expiresAt: string;
}

interface RecoveryStorageProxy extends FunctionStorageProxy {
  bucket?(bucket: string): RecoveryStorageProxy;
}

function storageBucket(storage: RecoveryStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

function parseRecoveryData(value: unknown): DuplicatePageRecoveryData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Duplicate-page recovery marker is malformed.');
  }
  const record = value as Record<string, unknown>;
  const uploadIds = Array.isArray(record.uploadIds)
    ? record.uploadIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (
    record.kind !== DUPLICATE_PAGE_RECOVERY_KIND
    || (record.status !== 'staging' && record.status !== 'committed')
    || typeof record.rootPageId !== 'string'
    || !record.rootPageId
    || typeof record.stagingTrashAt !== 'string'
    || !record.stagingTrashAt
    || uploadIds.length !== (Array.isArray(record.uploadIds) ? record.uploadIds.length : -1)
    || uploadIds.length > MAX_RECOVERY_UPLOADS
    || new Set(uploadIds).size !== uploadIds.length
  ) {
    throw new Error('Duplicate-page recovery marker is malformed.');
  }
  return {
    kind: DUPLICATE_PAGE_RECOVERY_KIND,
    status: record.status,
    rootPageId: record.rootPageId,
    uploadIds,
    stagingTrashAt: record.stagingTrashAt,
  };
}

export function duplicatePageRecoveryData(input: {
  status: DuplicatePageRecoveryData['status'];
  rootPageId: string;
  uploadIds: string[];
  stagingTrashAt: string;
}): DuplicatePageRecoveryData {
  return parseRecoveryData({ kind: DUPLICATE_PAGE_RECOVERY_KIND, ...input });
}

function collectSubtree(pages: Page[], rootPageId: string) {
  const children = new Map<string, Page[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = children.get(page.parentId) ?? [];
    list.push(page);
    children.set(page.parentId, list);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
    for (const child of children.get(id) ?? []) visit(child.id);
  };
  visit(rootPageId);
  return ids;
}

async function deleteCentralPageIndexes(admin: AdminDbAccessor, pageIds: string[]) {
  const indexes = admin.db('app').table<{ id: string; workspaceId: string }>('page_workspace_index');
  for (const pageId of pageIds) {
    const index = await getExisting(indexes, pageId);
    if (index) await indexes.delete(pageId);
  }
}

async function deleteStagedContentRows(
  db: DbRef,
  pageIds: string[],
  databaseIds: string[],
) {
  const operations: TransactOperation[] = [];
  for (const pageId of pageIds) {
    const blocks = await listAll(
      db.table<Block>('blocks').where('pageId', '==', pageId),
      { label: `Duplicate-page recovery blocks for ${pageId}` },
    );
    operations.push(...blocks.map((block) => ({ table: 'blocks' as const, op: 'delete' as const, id: block.id })));
  }
  for (const databaseId of databaseIds) {
    const [properties, views, templates] = await Promise.all([
      listAll(
        db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId),
        { label: `Duplicate-page recovery properties for ${databaseId}` },
      ),
      listAll(
        db.table<DbView>('db_views').where('databaseId', '==', databaseId),
        { label: `Duplicate-page recovery views for ${databaseId}` },
      ),
      listAll(
        db.table<DbTemplate>('db_templates').where('databaseId', '==', databaseId),
        { label: `Duplicate-page recovery templates for ${databaseId}` },
      ),
    ]);
    operations.push(
      ...templates.map((template) => ({ table: 'db_templates' as const, op: 'delete' as const, id: template.id })),
      ...views.map((view) => ({ table: 'db_views' as const, op: 'delete' as const, id: view.id })),
      ...properties.map((property) => ({ table: 'db_properties' as const, op: 'delete' as const, id: property.id })),
    );
  }
  // Keep the staged root in place until every dependent-row chunk succeeds.
  // A partial cleanup is therefore still discoverable and safe to retry.
  for (let index = 0; index < operations.length; index += MAX_RECOVERY_TRANSACT_OPS) {
    await db.transact(operations.slice(index, index + MAX_RECOVERY_TRANSACT_OPS));
  }
}

async function rollbackUploads(input: {
  admin: AdminDbAccessor;
  db: DbRef;
  workspace: Workspace;
  uploadIds: string[];
  storage?: RecoveryStorageProxy;
}) {
  const uploads = input.db.table<FileUpload>('file_uploads');
  for (const uploadId of input.uploadIds) {
    const upload = await getExisting(uploads, uploadId);
    if (!upload) continue;
    if (upload.workspaceId !== input.workspace.id) {
      throw new Error('Duplicate-page recovery upload is outside its workspace.');
    }
    const duplicatePrefix = `workspaces/${input.workspace.id}/duplicate-page/`;
    if (!upload.key.startsWith(duplicatePrefix)) {
      throw new Error('Duplicate-page recovery upload has an unexpected storage key.');
    }
    const proxy = storageBucket(input.storage, upload.bucket || FILE_BUCKET);
    if (!proxy) throw new Error('Duplicate-page recovery requires trusted storage access.');
    await proxy.delete(upload.key);
    if (input.workspace.organizationId) {
      await releaseOrganizationStorage(input.admin, {
        id: upload.id,
        organizationId: input.workspace.organizationId,
        workspaceId: input.workspace.id,
        bytes:
          typeof upload.size === 'number' && Number.isFinite(upload.size)
            ? Math.max(0, Math.floor(upload.size))
            : 0,
      });
    }
    await uploads.delete(upload.id);
  }
}

async function rollbackStagingOperation(input: {
  admin: AdminDbAccessor;
  db: DbRef;
  workspace: Workspace;
  marker: DuplicatePageRecoveryData;
  storage?: RecoveryStorageProxy;
}) {
  const pages = input.db.table<Page>('pages');
  const workspacePages = await listAll(
    pages.where('workspaceId', '==', input.workspace.id),
    { label: 'Duplicate-page recovery pages' },
  );
  const root = workspacePages.find((page) => page.id === input.marker.rootPageId);
  if (root && (!root.inTrash || root.trashedAt !== input.marker.stagingTrashAt)) {
    throw new Error('Duplicate-page recovery root no longer matches its staging marker.');
  }
  const pageIds = collectSubtree(workspacePages, input.marker.rootPageId)
    .filter((pageId) => workspacePages.some((page) => page.id === pageId));
  const databaseIds = pageIds.filter((pageId) =>
    workspacePages.find((page) => page.id === pageId)?.kind === 'database');
  for (const pageId of pageIds) {
    const page = workspacePages.find((candidate) => candidate.id === pageId)!;
    if (!page.inTrash || page.trashedAt !== input.marker.stagingTrashAt) {
      throw new Error('Duplicate-page recovery subtree no longer matches its staging marker.');
    }
  }
  // The in-process rollback may have removed every staged content row before
  // an object/quota cleanup failed. The durable marker still owns its exact
  // upload ids, so a missing root is a valid retry state. rollbackUploads
  // validates both workspace and the dedicated duplicate-page key namespace
  // before deleting anything; arbitrary uploads cannot be consumed here.
  await rollbackUploads({
    admin: input.admin,
    db: input.db,
    workspace: input.workspace,
    uploadIds: input.marker.uploadIds,
    storage: input.storage,
  });
  // Remove central routing first. If this fails, every content row remains
  // discoverable beneath the root for the next recovery attempt.
  await deleteCentralPageIndexes(input.admin, pageIds);
  // EdgeBase declares these rows as page-cascaded, but recovery must also be
  // correct for partially linked runtimes and retry-test fakes. Delete them
  // explicitly before the page root so no crash can strand hidden content.
  await deleteStagedContentRows(input.db, pageIds, databaseIds);
  for (const pageId of pageIds.reverse()) {
    const page = await getExisting(pages, pageId);
    if (page) await pages.delete(pageId);
  }
}

async function finishCommittedOperation(
  db: DbRef,
  workspaceId: string,
  marker: DuplicatePageRecoveryData,
) {
  const pages = db.table<Page>('pages');
  const workspacePages = await listAll(
    pages.where('workspaceId', '==', workspaceId),
    { label: 'Committed duplicate-page recovery pages' },
  );
  const root = workspacePages.find((page) => page.id === marker.rootPageId);
  if (!root) return false;
  // If the root carries a different trash event, a user deliberately trashed
  // the copy after it became visible. Preserve that newer intent, including
  // any descendants that still carry the staging stamp.
  if (root.inTrash && root.trashedAt !== marker.stagingTrashAt) return true;
  const pageIds = collectSubtree(workspacePages, marker.rootPageId);
  // Descendants first, root last: the duplicate does not enter the normal
  // workspace tree until every staged descendant has been made live.
  for (const pageId of pageIds.slice(1).reverse()) {
    const page = await getExisting(pages, pageId);
    if (page?.inTrash && page.trashedAt === marker.stagingTrashAt) {
      await pages.update(pageId, { inTrash: false, trashedAt: null });
    }
  }
  const currentRoot = await getExisting(pages, marker.rootPageId);
  if (currentRoot?.inTrash && currentRoot.trashedAt === marker.stagingTrashAt) {
    await pages.update(marker.rootPageId, { inTrash: false, trashedAt: null });
  }
  return true;
}

export async function recoverStaleDuplicatePageOperations(input: {
  admin: AdminDbAccessor;
  contentDbs: Array<{ workspaceId: string | null; db: DbRef }>;
  storage?: RecoveryStorageProxy;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const recovered: string[] = [];
  const failures: Array<{ workspaceId: string; message: string }> = [];
  for (const entry of input.contentDbs) {
    const workspaceId = entry.workspaceId;
    if (!workspaceId) continue;
    const lock = await getExisting(
      entry.db.table<FileWorkspaceLock>('file_workspace_locks'),
      workspaceId,
    );
    if (
      !lock?.recoveryData
      || (lock.recoveryData as { kind?: unknown }).kind !== DUPLICATE_PAGE_RECOVERY_KIND
      || Date.parse(lock.expiresAt) > now
    ) continue;

    let lease: Awaited<ReturnType<typeof acquireFileWorkspaceLease>> | undefined;
    try {
      lease = await acquireFileWorkspaceLease(
        entry.db,
        workspaceId,
        'system:duplicate-page-recovery',
        'duplicate-page-recovery',
        { recoverMarkedLease: true },
      );
      const currentLock = await getExisting(
        entry.db.table<FileWorkspaceLock>('file_workspace_locks'),
        workspaceId,
      );
      const marker = parseRecoveryData(currentLock?.recoveryData);
      const workspace = await getExisting(
        input.admin.db('app').table<Workspace>('workspaces'),
        workspaceId,
      );
      if (!workspace) throw new Error('Duplicate-page recovery workspace was not found.');

      const committed = marker.status === 'committed'
        && await finishCommittedOperation(entry.db, workspaceId, marker);
      if (!committed) {
        await rollbackStagingOperation({
          admin: input.admin,
          db: entry.db,
          workspace,
          marker,
          storage: input.storage,
        });
      }
      await releaseFileWorkspaceLease(entry.db, lease);
      recovered.push(workspaceId);
    } catch (error) {
      if (lease) {
        await deferFileWorkspaceLeaseRecovery(entry.db, lease).catch((deferError) => {
          console.error('[duplicate-page-recovery] failed to preserve recovery lease:', deferError);
        });
      }
      failures.push({
        workspaceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { recovered, failures };
}
