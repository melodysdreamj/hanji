import {
  getExisting,
  listAll,
  narrowWhere,
  newId,
  nowIso,
  type TableQuery,
  type TransactDb,
} from './table-utils';

const FILE_OPERATION_LEASE_TTL_MS = 30 * 60 * 1000;
const FILE_OPERATION_RECOVERY_RETRY_MS = 5 * 60 * 1000;
const FILE_OPERATION_LEASE_ATTEMPTS = 8;
const FILE_OPERATION_LEASE_RETRY_BASE_MS = 25;

interface FileWorkspaceLock {
  id: string;
  workspaceId: string;
  leaseId: string;
  actorId: string;
  operation: string;
  recoveryData?: unknown;
  expiresAt: string;
}

export interface FileWorkspaceLease {
  id: string;
  leaseId: string;
}

export interface FileWorkspaceLeaseGuard {
  lease: FileWorkspaceLease;
  assertOwned(): Promise<void>;
  renew(): Promise<void>;
  setRecoveryData(data: unknown): Promise<void>;
  preserveForRecovery(): void;
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  update(id: string, data: Partial<T>): Promise<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FileDeletionFence {
  id: string;
  workspaceId?: string;
  parentId?: string | null;
  parentType?: string;
  deletionPendingAt?: string | null;
}

function collectDeletionSubtree(pages: FileDeletionFence[], rootId: string) {
  const ids = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const page of pages) {
      if (page.parentId === id) pending.push(page.id);
    }
  }
  return ids;
}

function sameIds(actual: Set<string>, expected: Set<string>) {
  return actual.size === expected.size && Array.from(expected).every((id) => actual.has(id));
}

function conflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status
    : undefined;
  return code === 409 || /expectation failed|already exists|conflict/i.test(message);
}

export function fileOperationConflict(message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code: 409 });
}

function waitForLeaseAttempt(attempt: number) {
  const delay = Math.min(200, FILE_OPERATION_LEASE_RETRY_BASE_MS * (attempt + 1));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function assertFileWorkspaceNotDeleting(db: DbRef, workspaceId: string) {
  const workspace = await getExisting(db.table<FileDeletionFence>('workspaces'), workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  if (workspace.deletionPendingAt) {
    throw fileOperationConflict('Workspace deletion is already in progress.');
  }
  return workspace;
}

export async function assertFileTargetsNotDeleting(
  db: DbRef,
  workspaceId: string,
  targetIds: Array<string | null | undefined>,
) {
  await assertFileWorkspaceNotDeleting(db, workspaceId);
  for (const id of new Set(targetIds.filter((value): value is string => !!value))) {
    const visited = new Set<string>();
    let currentId: string | null | undefined = id;
    while (currentId) {
      if (visited.has(currentId) || visited.size >= 256) {
        throw new Error('File target ancestry is invalid.');
      }
      visited.add(currentId);
      const page: FileDeletionFence | null = await getExisting(
        db.table<FileDeletionFence>('pages'),
        currentId,
      );
      if (!page || (page.workspaceId && page.workspaceId !== workspaceId)) {
        throw new Error('File target was not found.');
      }
      if (page.deletionPendingAt) {
        throw fileOperationConflict('Target deletion is already in progress.');
      }
      if (page.parentType === 'workspace' || !page.parentId) break;
      currentId = page.parentId;
    }
  }
}

export async function markFileDeletionPending(
  db: DbRef,
  workspaceId: string,
  pageIds: string[] = [],
) {
  const deletionPendingAt = nowIso();
  if (pageIds.length === 0) {
    await db.table<FileDeletionFence>('workspaces').update(workspaceId, { deletionPendingAt });
    return deletionPendingAt;
  }

  const expectedIds = new Set(pageIds);
  const rootId = pageIds[0]!;
  const pages = db.table<FileDeletionFence>('pages');
  const readAndAssertSnapshot = async () => {
    const workspacePages = (
      await listAll(
        narrowWhere(pages, 'workspaceId', workspaceId),
        { label: 'Permanent-delete page topology' },
      )
    ).filter((page) => !page.workspaceId || page.workspaceId === workspaceId);
    const currentIds = collectDeletionSubtree(workspacePages, rootId);
    if (!sameIds(currentIds, expectedIds)) {
      throw fileOperationConflict(
        'Page hierarchy changed while permanent deletion was starting. Retry the deletion.',
      );
    }
    return new Map(workspacePages.map((page) => [page.id, page]));
  };

  // The caller computed pageIds from a subtree snapshot. Revalidate before
  // fencing so a page that already moved out is never deleted by stale ID, and
  // a page that already moved in is never orphaned when the old root vanishes.
  const beforeById = await readAndAssertSnapshot();
  const previousFences = new Map<string, string | null | undefined>();
  const stampedIds: string[] = [];
  try {
    for (const pageId of expectedIds) {
      const page = beforeById.get(pageId) ?? await getExisting(pages, pageId);
      if (!page || (page.workspaceId && page.workspaceId !== workspaceId)) {
        throw fileOperationConflict(
          'Page hierarchy changed while permanent deletion was starting. Retry the deletion.',
        );
      }
      previousFences.set(pageId, page.deletionPendingAt);
      await pages.update(pageId, { deletionPendingAt });
      stampedIds.push(pageId);
    }

    // A move can pass its own pre-check just before the root fence and commit
    // while the descendants are being stamped. The final topology comparison
    // closes that window; ordinary writes are now held by the root fence.
    await readAndAssertSnapshot();
  } catch (error) {
    // Do not strand pages behind a partial fence when the stale snapshot is
    // rejected. Restore only stamps still owned by this attempt.
    for (const pageId of stampedIds.reverse()) {
      const current = await getExisting(pages, pageId).catch(() => null);
      if (current?.deletionPendingAt !== deletionPendingAt) continue;
      await pages.update(pageId, {
        deletionPendingAt: previousFences.get(pageId) ?? null,
      }).catch((rollbackError) => {
        console.error('[file-operation] failed to rollback page deletion fence:', rollbackError);
      });
    }
    throw error;
  }
  return deletionPendingAt;
}

export async function acquireFileWorkspaceLease(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  operation: string,
  options: {
    recoverMarkedLease?: boolean | ((recoveryData: unknown) => boolean);
  } = {},
) {
  const locks = db.table<FileWorkspaceLock>('file_workspace_locks');
  const leaseId = newId();
  for (let attempt = 0; attempt < FILE_OPERATION_LEASE_ATTEMPTS; attempt += 1) {
    const existing = await getExisting(locks, workspaceId);
    if (existing && Date.parse(existing.expiresAt) > Date.now()) {
      if (attempt === FILE_OPERATION_LEASE_ATTEMPTS - 1) {
        throw fileOperationConflict('Another file operation is already in progress for this workspace.');
      }
      await waitForLeaseAttempt(attempt);
      continue;
    }
    const mayRecoverMarker = existing?.recoveryData != null && (
      options.recoverMarkedLease === true
      || (
        typeof options.recoverMarkedLease === 'function'
        && options.recoverMarkedLease(existing.recoveryData)
      )
    );
    if (existing?.recoveryData != null && !mayRecoverMarker) {
      throw fileOperationConflict('A crashed file operation is waiting for recovery in this workspace.');
    }
    const now = nowIso();
    const data = {
      workspaceId,
      leaseId,
      actorId,
      operation,
      recoveryData: existing?.recoveryData ?? null,
      expiresAt: new Date(Date.now() + FILE_OPERATION_LEASE_TTL_MS).toISOString(),
      updatedAt: now,
    };
    try {
      if (existing) {
        await db.transact([
          {
            table: 'file_workspace_locks',
            op: 'expect',
            id: existing.id,
            where: [['leaseId', '==', existing.leaseId]],
            exists: true,
          },
          { table: 'file_workspace_locks', op: 'update', id: existing.id, data },
        ]);
      } else {
        await db.transact([
          { table: 'file_workspace_locks', op: 'expect', id: workspaceId, exists: false },
          {
            table: 'file_workspace_locks',
            op: 'insert',
            data: { id: workspaceId, ...data, createdAt: now },
          },
        ]);
      }
      return { id: workspaceId, leaseId };
    } catch (error) {
      if (!conflict(error) || attempt === FILE_OPERATION_LEASE_ATTEMPTS - 1) throw error;
      await waitForLeaseAttempt(attempt);
    }
  }
  throw fileOperationConflict('Another file operation is already in progress for this workspace.');
}

export async function releaseFileWorkspaceLease(
  db: DbRef,
  lease: FileWorkspaceLease,
) {
  await db.transact([
    {
      table: 'file_workspace_locks',
      op: 'expect',
      id: lease.id,
      where: [['leaseId', '==', lease.leaseId]],
      exists: true,
    },
    { table: 'file_workspace_locks', op: 'delete', id: lease.id },
  ]);
}

export async function assertFileWorkspaceLease(db: DbRef, lease: FileWorkspaceLease) {
  const current = await getExisting(db.table<FileWorkspaceLock>('file_workspace_locks'), lease.id);
  if (
    !current
    || current.leaseId !== lease.leaseId
    || !Number.isFinite(Date.parse(current.expiresAt))
    || Date.parse(current.expiresAt) <= Date.now()
  ) {
    throw fileOperationConflict('File operation lease ownership was lost.');
  }
}

export async function renewFileWorkspaceLease(db: DbRef, lease: FileWorkspaceLease) {
  await assertFileWorkspaceLease(db, lease);
  await db.transact([
    {
      table: 'file_workspace_locks',
      op: 'expect',
      id: lease.id,
      where: [['leaseId', '==', lease.leaseId]],
      exists: true,
    },
    {
      table: 'file_workspace_locks',
      op: 'update',
      id: lease.id,
      data: { expiresAt: new Date(Date.now() + FILE_OPERATION_LEASE_TTL_MS).toISOString(), updatedAt: nowIso() },
    },
  ]);
}

export async function setFileWorkspaceLeaseRecoveryData(
  db: DbRef,
  lease: FileWorkspaceLease,
  recoveryData: unknown,
) {
  await assertFileWorkspaceLease(db, lease);
  await db.transact([
    {
      table: 'file_workspace_locks',
      op: 'expect',
      id: lease.id,
      where: [['leaseId', '==', lease.leaseId]],
      exists: true,
    },
    {
      table: 'file_workspace_locks',
      op: 'update',
      id: lease.id,
      data: { recoveryData, updatedAt: nowIso() },
    },
  ]);
}

export async function deferFileWorkspaceLeaseRecovery(
  db: DbRef,
  lease: FileWorkspaceLease,
  options: { operation?: string; retryMs?: number } = {},
) {
  await db.transact([
    {
      table: 'file_workspace_locks',
      op: 'expect',
      id: lease.id,
      where: [['leaseId', '==', lease.leaseId]],
      exists: true,
    },
    {
      table: 'file_workspace_locks',
      op: 'update',
      id: lease.id,
      data: {
        operation: options.operation ?? 'duplicate-page-recovery',
        expiresAt: new Date(
          Date.now() + (options.retryMs ?? FILE_OPERATION_RECOVERY_RETRY_MS),
        ).toISOString(),
        updatedAt: nowIso(),
      },
    },
  ]);
}

export async function withFileWorkspaceLease<T>(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  operation: string,
  run: (guard: FileWorkspaceLeaseGuard) => Promise<T>,
  options: {
    recoverMarkedLease?: boolean | ((recoveryData: unknown) => boolean);
    recoveryOperation?: string;
    recoveryRetryMs?: number;
  } = {},
) {
  const lease = await acquireFileWorkspaceLease(
    db,
    workspaceId,
    actorId,
    operation,
    { recoverMarkedLease: options.recoverMarkedLease },
  );
  let preserveForRecovery = false;
  const guard: FileWorkspaceLeaseGuard = {
    lease,
    assertOwned: () => assertFileWorkspaceLease(db, lease),
    renew: () => renewFileWorkspaceLease(db, lease),
    setRecoveryData: (data) => setFileWorkspaceLeaseRecoveryData(db, lease, data),
    preserveForRecovery: () => {
      preserveForRecovery = true;
    },
  };
  try {
    return await run(guard);
  } finally {
    if (preserveForRecovery) {
      await deferFileWorkspaceLeaseRecovery(db, lease, {
        operation: options.recoveryOperation,
        retryMs: options.recoveryRetryMs,
      }).catch((error) => {
        console.error(`[file-operation] failed to defer ${operation} recovery:`, error);
      });
    } else {
      await releaseFileWorkspaceLease(db, lease).catch((error) => {
        console.error(`[file-operation] failed to release ${operation} lease:`, error);
      });
    }
  }
}
