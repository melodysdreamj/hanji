import {
  getExisting,
  isTransactionConflictError,
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
const FILE_OPERATION_LEASE_EXTENDED_ATTEMPTS = 64;
const FILE_OPERATION_LEASE_RETRY_BASE_MS = 25;
const FILE_OPERATION_LEASE_MAX_RETRY_MS = 200;
const FILE_OPERATION_LEASE_MAX_CONTENTION_WAIT_MS = 10_000;
const FILE_OPERATION_SCOPE_ADMISSION_RETRY_BASE_MS = 5;
const FILE_OPERATION_SCOPE_ADMISSION_MAX_RETRY_MS = 50;
const FILE_OPERATION_MAX_COMPATIBLE_SCOPES = 64;
const FILE_OPERATION_MAX_SCOPE_KEY_LENGTH = 240;
const FILE_OPERATION_SCOPE_REGISTRY_ACTOR = 'system:file-operation-scope-registry';
const FILE_OPERATION_SCOPE_REGISTRY_OPERATION = 'compatible-scope-registry';

interface CompatibleFileWorkspaceLease {
  leaseId: string;
  actorId: string;
  operation: string;
  expiresAt: string;
}

interface FileWorkspaceLock {
  id: string;
  workspaceId: string;
  leaseId: string;
  actorId: string;
  operation: string;
  recoveryData?: unknown;
  expiresAt: string;
  revisionId?: string;
  compatibleScopes?: Record<string, CompatibleFileWorkspaceLease>;
}

export interface FileWorkspaceLease {
  id: string;
  leaseId: string;
  scopeKey?: string;
  registryRevisionId?: string;
  registryExpiresAt?: string;
  registrySoleOwner?: boolean;
}

export interface FileWorkspaceLeaseGuard {
  lease: FileWorkspaceLease;
  assertOwned(): Promise<void>;
  renew(): Promise<void>;
  setRecoveryData(data: unknown): Promise<void>;
  preserveForRecovery(): void;
}

export class ExclusiveFileWorkspaceLeaseRequired extends Error {}

export function requireExclusiveFileWorkspaceLease(
  guard: FileWorkspaceLeaseGuard,
  required: boolean,
) {
  if (required && guard.lease.scopeKey) throw new ExclusiveFileWorkspaceLeaseRequired();
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
  subitemParentId?: string;
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
      if (page.parentId === id || page.subitemParentId === id) pending.push(page.id);
    }
  }
  return ids;
}

function sameIds(actual: Set<string>, expected: Set<string>) {
  return actual.size === expected.size && Array.from(expected).every((id) => actual.has(id));
}

export function fileOperationConflict(message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code: 409 });
}

function stableLeaseRetryJitter(seed: string, attempt: number, range: number) {
  let hash = 2_166_136_261 ^ attempt;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % Math.max(1, range);
}

function compatibleScopeKey(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > FILE_OPERATION_MAX_SCOPE_KEY_LENGTH) {
    throw new Error('File operation scope is invalid.');
  }
  return normalized;
}

export function databaseFileWorkspaceLeaseScope(databaseId: string) {
  const normalized = databaseId.trim();
  if (!normalized) throw new Error('Database id is required for a file operation scope.');
  return compatibleScopeKey(`database:${normalized}`)!;
}

function parsedCompatibleScopes(lock: FileWorkspaceLock | null) {
  const value = lock?.compatibleScopes;
  if (value === undefined || value === null) return new Map<string, CompatibleFileWorkspaceLease>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fileOperationConflict('File operation scope registry is malformed.');
  }
  const entries = Object.entries(value);
  if (entries.length > FILE_OPERATION_MAX_COMPATIBLE_SCOPES) {
    throw Object.assign(new Error('Too many compatible file operations are active.'), { code: 429 });
  }
  const scopes = new Map<string, CompatibleFileWorkspaceLease>();
  for (const [scopeKey, candidate] of entries) {
    let normalizedScopeKey: string | undefined;
    try {
      normalizedScopeKey = compatibleScopeKey(scopeKey);
    } catch {
      throw fileOperationConflict('File operation scope registry is malformed.');
    }
    if (
      normalizedScopeKey !== scopeKey
      || !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
    ) {
      throw fileOperationConflict('File operation scope registry is malformed.');
    }
    const entry = candidate as Partial<CompatibleFileWorkspaceLease>;
    if (
      typeof entry.leaseId !== 'string'
      || !entry.leaseId
      || typeof entry.actorId !== 'string'
      || !entry.actorId
      || typeof entry.operation !== 'string'
      || !entry.operation
      || typeof entry.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(entry.expiresAt))
    ) {
      throw fileOperationConflict('File operation scope registry is malformed.');
    }
    scopes.set(scopeKey, entry as CompatibleFileWorkspaceLease);
  }
  return scopes;
}

function activeCompatibleScopes(lock: FileWorkspaceLock | null, now: number) {
  return new Map(
    Array.from(parsedCompatibleScopes(lock))
      .filter(([, entry]) => Date.parse(entry.expiresAt) > now),
  );
}

function fileWorkspaceLockCasWhere(lock: FileWorkspaceLock) {
  const where: Array<[string, '==', unknown]> = [
    ['leaseId', '==', lock.leaseId],
    ['expiresAt', '==', lock.expiresAt],
  ];
  if (lock.revisionId !== undefined) where.push(['revisionId', '==', lock.revisionId]);
  else where.push(['revisionId', '==', null]);
  return where;
}

function compatibleScopeRegistryData(
  workspaceId: string,
  scopes: ReadonlyMap<string, CompatibleFileWorkspaceLease>,
) {
  const revisionId = newId();
  const expiresAt = Array.from(scopes.values())
    .map((entry) => entry.expiresAt)
    .sort()
    .at(-1);
  if (!expiresAt) throw new Error('Compatible file operation registry cannot be empty.');
  return {
    workspaceId,
    leaseId: revisionId,
    actorId: FILE_OPERATION_SCOPE_REGISTRY_ACTOR,
    operation: FILE_OPERATION_SCOPE_REGISTRY_OPERATION,
    recoveryData: null,
    expiresAt,
    revisionId,
    compatibleScopes: Object.fromEntries(scopes),
    updatedAt: nowIso(),
  };
}

function activeExclusiveWorkspaceLease(lock: FileWorkspaceLock | null, now: number) {
  return !!lock
    && lock.operation !== FILE_OPERATION_SCOPE_REGISTRY_OPERATION
    && Date.parse(lock.expiresAt) > now;
}

function waitForLeaseAttempt(
  attempt: number,
  leaseId: string,
  remainingMs = Number.POSITIVE_INFINITY,
  jittered = false,
  retryBaseMs = FILE_OPERATION_LEASE_RETRY_BASE_MS,
  maxRetryMs = FILE_OPERATION_LEASE_MAX_RETRY_MS,
) {
  const base = Math.min(
    maxRetryMs,
    retryBaseMs * (attempt + 1),
  );
  const jitter = jittered
    ? stableLeaseRetryJitter(leaseId, attempt, Math.ceil(base / 2))
    : 0;
  const delay = Math.max(1, Math.min(base + jitter, remainingMs));
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
    contentionWaitMs?: number;
    scopeKey?: string;
  } = {},
) {
  const locks = db.table<FileWorkspaceLock>('file_workspace_locks');
  const leaseId = newId();
  const scopeKey = compatibleScopeKey(options.scopeKey);
  if (scopeKey && options.recoverMarkedLease !== undefined) {
    throw new Error('Compatible file operation scopes cannot recover workspace operations.');
  }
  const extendedContentionWaitMs = options.contentionWaitMs === undefined
    ? null
    : Math.min(
        FILE_OPERATION_LEASE_MAX_CONTENTION_WAIT_MS,
        Math.max(0, Math.floor(options.contentionWaitMs)),
      );
  const startedAt = Date.now();
  const contentionAttempts = extendedContentionWaitMs === null
    ? FILE_OPERATION_LEASE_ATTEMPTS
    : FILE_OPERATION_LEASE_EXTENDED_ATTEMPTS;
  let contentionAttempt = 0;
  let compatibleAdmissionAttempt = 0;
  const retryContention = async () => {
    const attempt = contentionAttempt;
    contentionAttempt += 1;
    if (attempt === contentionAttempts - 1) return false;
    if (extendedContentionWaitMs === null) {
      await waitForLeaseAttempt(attempt, leaseId);
      return true;
    }
    const remainingMs = extendedContentionWaitMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return false;
    await waitForLeaseAttempt(attempt, leaseId, remainingMs, true);
    return Date.now() - startedAt < extendedContentionWaitMs;
  };
  const retryCompatibleAdmission = async () => {
    const attempt = compatibleAdmissionAttempt;
    compatibleAdmissionAttempt += 1;
    if (attempt === FILE_OPERATION_LEASE_EXTENDED_ATTEMPTS - 1) return false;
    await waitForLeaseAttempt(
      attempt,
      leaseId,
      Number.POSITIVE_INFINITY,
      true,
      FILE_OPERATION_SCOPE_ADMISSION_RETRY_BASE_MS,
      FILE_OPERATION_SCOPE_ADMISSION_MAX_RETRY_MS,
    );
    return true;
  };

  while (true) {
    const existing = await getExisting(locks, workspaceId);
    const nowMs = Date.now();
    const compatibleScopes = activeCompatibleScopes(existing, nowMs);
    const exclusiveActive = activeExclusiveWorkspaceLease(existing, nowMs);
    const sameScopeActive = scopeKey ? compatibleScopes.has(scopeKey) : false;
    if (exclusiveActive || sameScopeActive || (!scopeKey && compatibleScopes.size > 0)) {
      if (!(await retryContention())) {
        throw fileOperationConflict('Another file operation is already in progress for this workspace.');
      }
      continue;
    }

    if (scopeKey) {
      if (existing?.recoveryData != null) {
        throw fileOperationConflict('A crashed file operation is waiting for recovery in this workspace.');
      }
      if (compatibleScopes.size >= FILE_OPERATION_MAX_COMPATIBLE_SCOPES) {
        throw Object.assign(new Error('Too many compatible file operations are active.'), { code: 429 });
      }
      compatibleScopes.set(scopeKey, {
        leaseId,
        actorId,
        operation,
        expiresAt: new Date(nowMs + FILE_OPERATION_LEASE_TTL_MS).toISOString(),
      });
      const data = compatibleScopeRegistryData(workspaceId, compatibleScopes);
      try {
        if (existing) {
          await db.transact([
            {
              table: 'file_workspace_locks',
              op: 'expect',
              id: existing.id,
              where: fileWorkspaceLockCasWhere(existing),
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
              data: { id: workspaceId, ...data, createdAt: nowIso() },
            },
          ]);
        }
        return {
          id: workspaceId,
          leaseId,
          scopeKey,
          registryRevisionId: data.revisionId,
          registryExpiresAt: data.expiresAt,
          registrySoleOwner: compatibleScopes.size === 1,
        };
      } catch (error) {
        if (!isTransactionConflictError(error)) throw error;
        if (!(await retryCompatibleAdmission())) {
          throw fileOperationConflict('Another file operation is already in progress for this workspace.');
        }
        continue;
      }
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
      expiresAt: new Date(nowMs + FILE_OPERATION_LEASE_TTL_MS).toISOString(),
      revisionId: newId(),
      compatibleScopes: {},
      updatedAt: now,
    };
    try {
      if (existing) {
        await db.transact([
          {
            table: 'file_workspace_locks',
            op: 'expect',
            id: existing.id,
            where: fileWorkspaceLockCasWhere(existing),
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
      if (!isTransactionConflictError(error)) throw error;
      if (!(await retryContention())) {
        // Never leak an adapter-specific expectation message at the terminal
        // boundary. The durable conflict is the workspace lease, not its SQL
        // implementation detail.
        throw fileOperationConflict('Another file operation is already in progress for this workspace.');
      }
    }
  }
}

export async function releaseFileWorkspaceLease(
  db: DbRef,
  lease: FileWorkspaceLease,
) {
  if (lease.scopeKey) {
    if (
      lease.registrySoleOwner
      && lease.registryRevisionId
      && lease.registryExpiresAt
    ) {
      try {
        await db.transact([
          {
            table: 'file_workspace_locks',
            op: 'expect',
            id: lease.id,
            where: [
              ['leaseId', '==', lease.registryRevisionId],
              ['expiresAt', '==', lease.registryExpiresAt],
              ['revisionId', '==', lease.registryRevisionId],
            ],
            exists: true,
          },
          { table: 'file_workspace_locks', op: 'delete', id: lease.id },
        ]);
        return;
      } catch (error) {
        if (!isTransactionConflictError(error)) throw error;
      }
    }
    for (let attempt = 0; attempt < FILE_OPERATION_LEASE_EXTENDED_ATTEMPTS; attempt += 1) {
      const current = await getExisting(
        db.table<FileWorkspaceLock>('file_workspace_locks'),
        lease.id,
      );
      const scopes = activeCompatibleScopes(current, Date.now());
      if (!current || scopes.get(lease.scopeKey)?.leaseId !== lease.leaseId) {
        throw new Error('Transaction expectation failed: expected a matching file operation scope.');
      }
      scopes.delete(lease.scopeKey);
      try {
        await db.transact([
          {
            table: 'file_workspace_locks',
            op: 'expect',
            id: current.id,
            where: fileWorkspaceLockCasWhere(current),
            exists: true,
          },
          scopes.size === 0
            ? { table: 'file_workspace_locks', op: 'delete', id: current.id }
            : {
                table: 'file_workspace_locks',
                op: 'update',
                id: current.id,
                data: compatibleScopeRegistryData(current.workspaceId, scopes),
              },
        ]);
        return;
      } catch (error) {
        if (
          !isTransactionConflictError(error)
          || attempt === FILE_OPERATION_LEASE_EXTENDED_ATTEMPTS - 1
        ) {
          throw error;
        }
        await waitForLeaseAttempt(attempt, lease.leaseId, Number.POSITIVE_INFINITY, true);
      }
    }
    return;
  }
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
  if (lease.scopeKey) {
    const entry = activeCompatibleScopes(current, Date.now()).get(lease.scopeKey);
    if (entry?.leaseId !== lease.leaseId) {
      throw fileOperationConflict('File operation lease ownership was lost.');
    }
    return;
  }
  if (
    !current
    || current.operation === FILE_OPERATION_SCOPE_REGISTRY_OPERATION
    || current.leaseId !== lease.leaseId
    || !Number.isFinite(Date.parse(current.expiresAt))
    || Date.parse(current.expiresAt) <= Date.now()
  ) {
    throw fileOperationConflict('File operation lease ownership was lost.');
  }
}

export async function renewFileWorkspaceLease(db: DbRef, lease: FileWorkspaceLease) {
  if (lease.scopeKey) {
    for (let attempt = 0; attempt < FILE_OPERATION_LEASE_EXTENDED_ATTEMPTS; attempt += 1) {
      const current = await getExisting(
        db.table<FileWorkspaceLock>('file_workspace_locks'),
        lease.id,
      );
      const scopes = activeCompatibleScopes(current, Date.now());
      const entry = scopes.get(lease.scopeKey);
      if (!current || entry?.leaseId !== lease.leaseId) {
        throw fileOperationConflict('File operation lease ownership was lost.');
      }
      scopes.set(lease.scopeKey, {
        ...entry,
        expiresAt: new Date(Date.now() + FILE_OPERATION_LEASE_TTL_MS).toISOString(),
      });
      try {
        await db.transact([
          {
            table: 'file_workspace_locks',
            op: 'expect',
            id: current.id,
            where: fileWorkspaceLockCasWhere(current),
            exists: true,
          },
          {
            table: 'file_workspace_locks',
            op: 'update',
            id: current.id,
            data: compatibleScopeRegistryData(current.workspaceId, scopes),
          },
        ]);
        return;
      } catch (error) {
        if (
          !isTransactionConflictError(error)
          || attempt === FILE_OPERATION_LEASE_EXTENDED_ATTEMPTS - 1
        ) {
          throw error;
        }
        await waitForLeaseAttempt(attempt, lease.leaseId, Number.POSITIVE_INFINITY, true);
      }
    }
    return;
  }
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
  if (lease.scopeKey) {
    throw new Error('Compatible file operation scopes cannot carry recovery data.');
  }
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
  if (lease.scopeKey) {
    throw new Error('Compatible file operation scopes cannot be deferred for recovery.');
  }
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
    contentionWaitMs?: number;
    recoveryOperation?: string;
    recoveryRetryMs?: number;
    scopeKey?: string;
  } = {},
) {
  const lease = await acquireFileWorkspaceLease(
    db,
    workspaceId,
    actorId,
    operation,
    {
      recoverMarkedLease: options.recoverMarkedLease,
      contentionWaitMs: options.contentionWaitMs,
      scopeKey: options.scopeKey,
    },
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

export async function withDatabaseFileWorkspaceLease<T>(
  db: DbRef,
  workspaceId: string,
  databaseId: string,
  actorId: string,
  operation: string,
  run: (guard: FileWorkspaceLeaseGuard) => Promise<T>,
  options: { contentionWaitMs?: number } = {},
) {
  try {
    return await withFileWorkspaceLease(
      db,
      workspaceId,
      actorId,
      operation,
      run,
      {
        contentionWaitMs: options.contentionWaitMs,
        scopeKey: databaseFileWorkspaceLeaseScope(databaseId),
      },
    );
  } catch (error) {
    if (!(error instanceof ExclusiveFileWorkspaceLeaseRequired)) throw error;
    return withFileWorkspaceLease(
      db,
      workspaceId,
      actorId,
      operation,
      run,
      { contentionWaitMs: options.contentionWaitMs },
    );
  }
}
