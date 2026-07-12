import type { AdminDbAccessor } from './workspace-db';
import type { DbRef } from './app-types';
import { listAll, type TransactOperation } from './table-utils';

const CENTRAL_TRANSACT_LIMIT = 500;
const MAX_CENTRAL_WORKSPACE_INDEX_ROWS = 100_000;

interface PageWorkspaceIndex {
  id: string;
  workspaceId: string;
}

interface PagePermissionIndex extends PageWorkspaceIndex {
  pageId: string;
}

interface ShareLinkIndex extends PageWorkspaceIndex {
  pageId: string;
}

export interface PermanentRoutingIndexPlan {
  db: DbRef;
  pageWorkspaceIndexes: PageWorkspaceIndex[];
  permissionIndexes: PagePermissionIndex[];
  shareLinkIndexes: ShareLinkIndex[];
}

/**
 * Resolve central routing rows before irreversible storage/content cleanup.
 * Permission/share indexes are discovery-only, but leaving them behind leaks
 * stale routes and makes ID-only calls repeatedly hit a deleted workspace.
 */
export async function collectPermanentRoutingIndexPlan(
  admin: AdminDbAccessor,
  workspaceId: string,
  pageIds: Iterable<string>,
): Promise<PermanentRoutingIndexPlan> {
  const db = admin.db('app') as DbRef;
  const pageIdSet = new Set(pageIds);
  const listOptions = (label: string) => ({
    label,
    maxItems: MAX_CENTRAL_WORKSPACE_INDEX_ROWS,
    allowLargeMaterialization: true,
  });
  const [pageWorkspaceIndexes, permissionIndexes, shareLinkIndexes] = await Promise.all([
    listAll(
      db.table<PageWorkspaceIndex>('page_workspace_index').where('workspaceId', '==', workspaceId),
      listOptions(`Page routing indexes for permanent delete in ${workspaceId}`),
    ).then((rows) => rows.filter((row) => pageIdSet.has(row.id))),
    listAll(
      db.table<PagePermissionIndex>('page_permission_index').where('workspaceId', '==', workspaceId),
      listOptions(`Permission routing indexes for permanent delete in ${workspaceId}`),
    ).then((rows) => rows.filter((row) => pageIdSet.has(row.pageId))),
    listAll(
      db.table<ShareLinkIndex>('share_link_index').where('workspaceId', '==', workspaceId),
      listOptions(`Share routing indexes for permanent delete in ${workspaceId}`),
    ).then((rows) => rows.filter((row) => pageIdSet.has(row.pageId))),
  ]);
  return { db, pageWorkspaceIndexes, permissionIndexes, shareLinkIndexes };
}

export async function deletePermanentRoutingIndexes(
  plan: PermanentRoutingIndexPlan,
  beforeChunk?: () => Promise<void>,
) {
  const operations: TransactOperation[] = [
    ...plan.permissionIndexes.map((row): TransactOperation => ({
      table: 'page_permission_index', op: 'delete', id: row.id,
    })),
    ...plan.shareLinkIndexes.map((row): TransactOperation => ({
      table: 'share_link_index', op: 'delete', id: row.id,
    })),
    ...plan.pageWorkspaceIndexes.map((row): TransactOperation => ({
      table: 'page_workspace_index', op: 'delete', id: row.id,
    })),
  ];
  for (let offset = 0; offset < operations.length; offset += CENTRAL_TRANSACT_LIMIT) {
    if (beforeChunk) await beforeChunk();
    await plan.db.transact(operations.slice(offset, offset + CENTRAL_TRANSACT_LIMIT));
  }
  return {
    pageWorkspaceIndexes: plan.pageWorkspaceIndexes.length,
    permissionIndexes: plan.permissionIndexes.length,
    shareLinkIndexes: plan.shareLinkIndexes.length,
  };
}
