import { defineFunction } from '@edge-base/shared';
import { contentDbsForAllWorkspaces, workspaceDb, type AdminDbAccessor } from '../lib/workspace-db';
import { releaseOrganizationStorage } from '../lib/storage-quota';
import { withFileWorkspaceLease } from '../lib/file-operation-lock';
import { assertPreservableStoredUpload } from '../lib/permanent-file-delete';
import {
  FILE_REFERENCE_DELETE_GRACE_MS,
  fileUploadReferenceOwners,
  fileUploadStillReferenced,
  workspaceFileReferenceSnapshot,
} from '../lib/file-reference-lifecycle';
import { recoverStaleDuplicatePageOperations } from '../lib/duplicate-page-recovery';
import { recoverStaleDatabasePropertyDeleteOperations } from './database-mutation';
import { flushOrganizationAuditOutbox } from '../lib/organization-audit-outbox';

import { getExisting, nowIso, type TableQuery, type TransactDb } from '../lib/table-utils';
const FILE_BUCKET = 'files';
const SYSTEM_ACTOR_ID = 'system:file-maintenance';
const DEFAULT_CLEANUP_LIMIT = 200;
const PREPARING_RECOVERY_TTL_MS = 30 * 60 * 1000;
// Signed PUT grants are normally 30 minutes. Legacy/corrupt pending rows may
// lack expiresAt; one extra five-minute margin avoids racing the longest grant
// while ensuring such rows do not wedge deletion and quota forever.
const LEGACY_PENDING_RECOVERY_TTL_MS = 35 * 60 * 1000;
const UNATTACHED_UPLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;

type FileUploadStatus = 'preparing' | 'pending' | 'uploaded' | 'deleting' | 'deleted' | 'expired';

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket?: string;
  key: string;
  name: string;
  contentType?: string;
  etag?: string;
  pageId?: string | null;
  blockId?: string | null;
  databaseId?: string | null;
  propertyId?: string | null;
  templateId?: string | null;
  url?: string;
  completedAt?: string | null;
  size?: number;
  status: FileUploadStatus;
  expiresAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionPreviousStatus?: 'preparing' | 'pending' | 'uploaded' | null;
  createdAt?: string;
  updatedAt?: string;
}

interface FileMaintenanceRun {
  workspaceId: string;
  kind: string;
  actorId: string;
  status: 'success' | 'partial_failure' | 'failed';
  scheduledAt?: string;
  startedAt: string;
  finishedAt: string;
  scanned: number;
  expired: number;
  deletedObjects: number;
  failedObjects: number;
  failures?: Array<{ id: string; key: string; message: string }>;
  details?: {
    uploadIds?: string[];
    deletedReferences?: number;
    orphanedUploads?: number;
    duplicatePageRecoveryFailures?: number;
    databasePropertyDeleteRecoveries?: number;
    databasePropertyDeleteRecoveryFailures?: number;
  };
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  head?(key: string): Promise<{
    key?: string;
    size?: number;
    contentType?: string;
    etag?: string;
  } | null>;
  delete(key: string): Promise<void>;
}

interface FunctionContext {
  admin: AdminDbAccessor;
  storage?: FunctionStorageProxy;
  data?: unknown;
}

interface Workspace {
  id: string;
  organizationId?: string | null;
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

function isExpired(upload: FileUpload, at: number) {
  const expiresAt = typeof upload.expiresAt === 'string' ? Date.parse(upload.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt)) return expiresAt <= at;
  if (upload.status !== 'preparing' && upload.status !== 'pending') return false;
  const startedAt = Date.parse(upload.updatedAt ?? upload.createdAt ?? '');
  const recoveryTtl = upload.status === 'pending'
    ? LEGACY_PENDING_RECOVERY_TTL_MS
    : PREPARING_RECOVERY_TTL_MS;
  return Number.isFinite(startedAt) && startedAt + recoveryTtl <= at;
}

function isOldUnattachedCandidate(upload: FileUpload, at: number) {
  if (upload.status !== 'uploaded') return false;
  const verifiedCompletion = typeof upload.completedAt === 'string'
    && Number.isFinite(Date.parse(upload.completedAt));
  const grantExpiry = typeof upload.expiresAt === 'string'
    ? Date.parse(upload.expiresAt)
    : Number.NaN;
  if (!verifiedCompletion && Number.isFinite(grantExpiry) && grantExpiry > at) return false;
  const completedAt = Date.parse(upload.completedAt ?? upload.updatedAt ?? upload.createdAt ?? '');
  return Number.isFinite(completedAt) && completedAt + UNATTACHED_UPLOAD_MIN_AGE_MS <= at;
}

function deletionDeadline(upload: FileUpload, at = Date.now()) {
  const grace = at + FILE_REFERENCE_DELETE_GRACE_MS;
  const grantExpiry = typeof upload.expiresAt === 'string'
    ? Date.parse(upload.expiresAt)
    : Number.NaN;
  return new Date(Number.isFinite(grantExpiry) ? Math.max(grace, grantExpiry) : grace).toISOString();
}

function cleanupPriority(upload: FileUpload) {
  if (upload.status === 'deleting') return 0;
  if (upload.status === 'pending' || upload.status === 'preparing') return 1;
  return 2;
}

function cleanupTimestamp(upload: FileUpload) {
  return String(
    upload.expiresAt
    ?? upload.completedAt
    ?? upload.updatedAt
    ?? upload.createdAt
    ?? '',
  );
}

function scheduledAtFromData(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const value = record.scheduledAt ?? record.scheduledTime ?? record.cronTime;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

async function listAll<T>(query: TableQuery<T>, maxItems: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200 && out.length < maxItems; page += 1) {
    const res = await query.page(page).limit(Math.min(1000, maxItems)).getList();
    const items = res.items ?? [];
    out.push(...items);
    if (!res.hasMore || items.length === 0) break;
  }
  return out.slice(0, maxItems);
}

function orderOldestFirst<T>(query: TableQuery<T>, field: string) {
  const ordered = query as TableQuery<T> & {
    orderBy?: (name: string, direction: 'asc' | 'desc') => TableQuery<T>;
  };
  return typeof ordered.orderBy === 'function' ? ordered.orderBy(field, 'asc') : query;
}

function whereIfSupported<T>(
  query: TableQuery<T>,
  field: string,
  op: string,
  value: unknown,
) {
  return typeof query.where === 'function' ? query.where(field, op, value) : query;
}

async function deleteStoredFile(storage: FunctionStorageProxy | undefined, upload: FileUpload) {
  const proxy = storageBucket(storage, upload.bucket || FILE_BUCKET);
  if (!proxy) throw new Error('Stored file deletion requires storage access.');
  await proxy.delete(upload.key);
  return true;
}

function workspaceStats(map: Map<string, WorkspaceMaintenanceStats>, workspaceId: string) {
  let stats = map.get(workspaceId);
  if (!stats) {
    stats = {
      scanned: 0,
      expired: 0,
      deletedReferences: 0,
      orphanedUploads: 0,
      duplicatePageRecoveryFailures: 0,
      databasePropertyDeleteRecoveries: 0,
      databasePropertyDeleteRecoveryFailures: 0,
      deletedObjects: 0,
      failures: [],
      uploadIds: [],
    };
    map.set(workspaceId, stats);
  }
  return stats;
}

interface WorkspaceMaintenanceStats {
  scanned: number;
  expired: number;
  deletedReferences: number;
  orphanedUploads: number;
  duplicatePageRecoveryFailures: number;
  databasePropertyDeleteRecoveries: number;
  databasePropertyDeleteRecoveryFailures: number;
  deletedObjects: number;
  failures: Array<{ id: string; key: string; message: string }>;
  uploadIds: string[];
}

async function recordMaintenanceRuns(
  db: DbRef,
  statsByWorkspace: Map<string, WorkspaceMaintenanceStats>,
  startedAt: string,
  finishedAt: string,
  scheduledAt?: string,
) {
  const runs = db.table<FileMaintenanceRun>('file_maintenance_runs');
  const recorded: FileMaintenanceRun[] = [];

  for (const [workspaceId, stats] of statsByWorkspace) {
    if (
      stats.expired === 0
      && stats.deletedReferences === 0
      && stats.orphanedUploads === 0
      && stats.databasePropertyDeleteRecoveries === 0
      && stats.failures.length === 0
    ) continue;
    try {
      recorded.push(
        await runs.insert({
          workspaceId,
          kind: 'expired-upload-cleanup',
          actorId: SYSTEM_ACTOR_ID,
          status: stats.failures.length ? 'partial_failure' : 'success',
          scheduledAt,
          startedAt,
          finishedAt,
          scanned: stats.scanned,
          expired: stats.expired,
          deletedObjects: stats.deletedObjects,
          failedObjects: stats.failures.length,
          failures: stats.failures.length ? stats.failures : undefined,
          details: {
            uploadIds: stats.uploadIds,
            deletedReferences: stats.deletedReferences,
            orphanedUploads: stats.orphanedUploads,
            duplicatePageRecoveryFailures: stats.duplicatePageRecoveryFailures,
            databasePropertyDeleteRecoveries: stats.databasePropertyDeleteRecoveries,
            databasePropertyDeleteRecoveryFailures: stats.databasePropertyDeleteRecoveryFailures,
          },
        }),
      );
    } catch (err) {
      console.warn(
        `[file-maintenance] failed to record maintenance run for workspace ${workspaceId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  return recorded;
}

export default defineFunction({
  trigger: { type: 'schedule', cron: '*/30 * * * *' },
  handler: async (context) => {
    const { admin, data, storage } = context as FunctionContext;
    const startedAt = nowIso();
    const scheduledAt = scheduledAtFromData(data);
    const db = admin.db('app');
    const now = Date.now();
    // Post-split file_uploads lives per workspace; sweep every content block.
    const contentDbs = await contentDbsForAllWorkspaces(admin);
    const organizationAuditOutboxRecovery: Array<{
      workspaceId: string;
      delivered: string[];
      failures: Array<{ id: string; message: string }>;
    }> = [];
    for (const entry of contentDbs) {
      if (!entry.workspaceId) continue;
      try {
        organizationAuditOutboxRecovery.push({
          workspaceId: entry.workspaceId,
          ...(await flushOrganizationAuditOutbox(entry.db, db, entry.workspaceId)),
        });
      } catch (error) {
        organizationAuditOutboxRecovery.push({
          workspaceId: entry.workspaceId,
          delivered: [],
          failures: [{
            id: entry.workspaceId,
            message: error instanceof Error ? error.message : String(error),
          }],
        });
      }
    }
    const databasePropertyDeleteRecovery = await recoverStaleDatabasePropertyDeleteOperations({
      contentDbs,
      now,
    });
    // A page duplicate spans content rows and the central routing index, plus
    // object/quota state when files are present. Recover its durable marker
    // before generic upload expiry can consume any staged row.
    const duplicatePageRecovery = await recoverStaleDuplicatePageOperations({
      admin,
      contentDbs,
      storage,
      now,
    });
    const uploadsTables = new Map(
      contentDbs.map(({ workspaceId, db: contentDb }) => [
        workspaceId ?? '',
        contentDb.table<FileUpload>('file_uploads'),
      ]),
    );
    const cleanupCandidates: FileUpload[] = [];
    const unattachedCutoff = new Date(now - UNATTACHED_UPLOAD_MIN_AGE_MS).toISOString();
    for (const { db: contentDb } of contentDbs) {
      const uploadedBase = contentDb.table<FileUpload>('file_uploads').where('status', '==', 'uploaded');
      const oldCompletedUploads = await listAll(
        orderOldestFirst(
          whereIfSupported(uploadedBase, 'completedAt', '<=', unattachedCutoff),
          'completedAt',
        ),
        DEFAULT_CLEANUP_LIMIT,
      );
      const legacyUploadedBase = contentDb.table<FileUpload>('file_uploads').where('status', '==', 'uploaded');
      const oldLegacyUploads = await listAll(
        orderOldestFirst(
          whereIfSupported(
            whereIfSupported(legacyUploadedBase, 'completedAt', '==', null),
            'updatedAt',
            '<=',
            unattachedCutoff,
          ),
          'updatedAt',
        ),
        DEFAULT_CLEANUP_LIMIT,
      );
      const legacyCreatedUploadedBase = contentDb.table<FileUpload>('file_uploads')
        .where('status', '==', 'uploaded');
      const oldLegacyCreatedUploads = await listAll(
        orderOldestFirst(
          whereIfSupported(
            whereIfSupported(
              whereIfSupported(legacyCreatedUploadedBase, 'completedAt', '==', null),
              'updatedAt',
              '==',
              null,
            ),
            'createdAt',
            '<=',
            unattachedCutoff,
          ),
          'createdAt',
        ),
        DEFAULT_CLEANUP_LIMIT,
      );
      const pendingUploads = await listAll(
          orderOldestFirst(
            contentDb.table<FileUpload>('file_uploads').where('status', '==', 'pending'),
            'expiresAt',
          ),
          DEFAULT_CLEANUP_LIMIT,
        );
      const preparingUploads = await listAll(
          orderOldestFirst(
            contentDb.table<FileUpload>('file_uploads').where('status', '==', 'preparing'),
            'updatedAt',
          ),
          DEFAULT_CLEANUP_LIMIT,
        );
      const deletingUploads = await listAll(
          orderOldestFirst(
            contentDb.table<FileUpload>('file_uploads').where('status', '==', 'deleting'),
            'expiresAt',
          ),
          DEFAULT_CLEANUP_LIMIT,
        );
      const workspaceCandidates = Array.from(
        new Map(
          [
            ...deletingUploads,
            ...pendingUploads,
            ...preparingUploads,
            ...oldCompletedUploads,
            ...oldLegacyUploads,
            ...oldLegacyCreatedUploads,
          ].map((upload) => [upload.id, upload]),
        ).values(),
      )
        .filter((upload) => isExpired(upload, now) || isOldUnattachedCandidate(upload, now))
        .sort((a, b) => cleanupPriority(a) - cleanupPriority(b)
          || cleanupTimestamp(a).localeCompare(cleanupTimestamp(b)))
        .slice(0, DEFAULT_CLEANUP_LIMIT);
      cleanupCandidates.push(
        ...workspaceCandidates,
      );
    }
    const uploadsTableFor = (upload: FileUpload) =>
      uploadsTables.get(upload.workspaceId ?? '') ?? uploadsTables.values().next().value;
    const eligibleByPriority = [
      new Map<string, FileUpload[]>(),
      new Map<string, FileUpload[]>(),
      new Map<string, FileUpload[]>(),
    ];
    for (const upload of cleanupCandidates) {
      const map = eligibleByPriority[cleanupPriority(upload)]!;
      const list = map.get(upload.workspaceId) ?? [];
      list.push(upload);
      map.set(upload.workspaceId, list);
    }
    // Priority first (explicit detach, then grant expiry, then orphan sweep),
    // with deterministic workspace round-robin inside each class. An orphan
    // backlog can neither starve explicit deletion nor monopolize the global
    // 200-item cleanup budget.
    const expired: FileUpload[] = [];
    for (const candidatesByWorkspace of eligibleByPriority) {
      const workspaceIds = Array.from(candidatesByWorkspace.keys()).sort();
      for (let offset = 0; expired.length < DEFAULT_CLEANUP_LIMIT; offset += 1) {
        let added = false;
        for (const workspaceId of workspaceIds) {
          const upload = candidatesByWorkspace.get(workspaceId)?.[offset];
          if (!upload) continue;
          expired.push(upload);
          added = true;
          if (expired.length >= DEFAULT_CLEANUP_LIMIT) break;
        }
        if (!added) break;
      }
      if (expired.length >= DEFAULT_CLEANUP_LIMIT) break;
    }

    let deletedObjects = 0;
    const failures: Array<{ id: string; key: string; message: string }> = [];
    const updated: FileUpload[] = [];
    const statsByWorkspace = new Map<string, WorkspaceMaintenanceStats>();

    for (const recovery of organizationAuditOutboxRecovery) {
      for (const auditFailure of recovery.failures) {
        const failure = {
          id: `organization-audit-outbox:${auditFailure.id}`,
          key: '',
          message: auditFailure.message,
        };
        failures.push(failure);
        workspaceStats(statsByWorkspace, recovery.workspaceId).failures.push(failure);
      }
    }

    for (const workspaceId of databasePropertyDeleteRecovery.recovered) {
      workspaceStats(statsByWorkspace, workspaceId).databasePropertyDeleteRecoveries += 1;
    }
    for (const recoveryFailure of databasePropertyDeleteRecovery.failures) {
      const failure = {
        id: `database-property-delete-recovery:${recoveryFailure.propertyId}`,
        key: '',
        message: recoveryFailure.message,
      };
      failures.push(failure);
      const stats = workspaceStats(statsByWorkspace, recoveryFailure.workspaceId);
      stats.failures.push(failure);
      stats.databasePropertyDeleteRecoveryFailures += 1;
    }

    // Recovery failures can be the only work in a sweep. Surface them through
    // the common failure/result/run channel so scheduled execution is not a
    // silent `ok:true` while a durable marker remains blocked for retry.
    for (const recoveryFailure of duplicatePageRecovery.failures) {
      const failure = {
        id: `duplicate-page-recovery:${recoveryFailure.workspaceId}`,
        key: '',
        message: recoveryFailure.message,
      };
      failures.push(failure);
      const stats = workspaceStats(statsByWorkspace, recoveryFailure.workspaceId);
      stats.failures.push(failure);
      stats.duplicatePageRecoveryFailures += 1;
    }

    for (const upload of cleanupCandidates) {
      workspaceStats(statsByWorkspace, upload.workspaceId).scanned += 1;
    }

    const expiredByWorkspace = new Map<string, FileUpload[]>();
    for (const upload of expired) {
      const list = expiredByWorkspace.get(upload.workspaceId) ?? [];
      list.push(upload);
      expiredByWorkspace.set(upload.workspaceId, list);
    }

    for (const [workspaceId, candidates] of expiredByWorkspace) {
      const contentDb = contentDbs.find((entry) => entry.workspaceId === workspaceId)?.db;
      if (!contentDb) continue;
      try {
        await withFileWorkspaceLease(
          contentDb,
          workspaceId,
          SYSTEM_ACTOR_ID,
          'scheduled-file-maintenance',
          async (lease) => {
            // The association columns are not authoritative for legacy
            // duplicates. Scan every live owner once while the workspace file
            // lease prevents detach/reattach from racing this cleanup.
            const referenceSnapshot = await workspaceFileReferenceSnapshot(contentDb, workspaceId, db);
            for (const candidate of candidates) {
              const stats = workspaceStats(statsByWorkspace, workspaceId);
              try {
                await lease.renew();
                const upload = await getExisting(contentDb.table<FileUpload>('file_uploads'), candidate.id);
                if (
                  !upload
                  || (
                    upload.status !== 'pending'
                    && upload.status !== 'preparing'
                    && upload.status !== 'deleting'
                    && upload.status !== 'uploaded'
                  )
                  || (!isExpired(upload, Date.now()) && !isOldUnattachedCandidate(upload, Date.now()))
                ) {
                  continue;
                }
                if (upload.status === 'uploaded') {
                  if (await fileUploadStillReferenced(contentDb, upload, referenceSnapshot)) continue;
                  const timestamp = nowIso();
                  await contentDb.transact([
                    {
                      table: 'file_uploads',
                      op: 'expect',
                      id: upload.id,
                      where: [['status', '==', 'uploaded']],
                      exists: true,
                    },
                    {
                      table: 'file_uploads',
                      op: 'update',
                      id: upload.id,
                      data: {
                        status: 'deleting',
                        deletionPreviousStatus: 'uploaded',
                        expiresAt: deletionDeadline(upload),
                        deletedBy: SYSTEM_ACTOR_ID,
                        updatedAt: timestamp,
                      },
                    },
                  ]);
                  stats.orphanedUploads += 1;
                  stats.uploadIds.push(upload.id);
                  continue;
                }
                if (
                  upload.status === 'deleting'
                  && await fileUploadStillReferenced(contentDb, upload, referenceSnapshot)
                ) {
                  const previous = upload.deletionPreviousStatus;
                  if (previous && previous !== 'uploaded') {
                    throw new Error(
                      'Stored file is still referenced but its upload never completed; cleanup was deferred.',
                    );
                  }
                  await assertPreservableStoredUpload(storage, upload);
                  const owners = fileUploadReferenceOwners(upload, referenceSnapshot);
                  const owner = owners.find((candidate) => candidate.kind === 'block')
                    ?? owners.find((candidate) => candidate.kind === 'page')
                    ?? owners.find((candidate) => candidate.kind === 'template')
                    ?? owners[0];
                  if (!owner) continue;
                  // Normal reattachment restores this atomically with the
                  // owner update. This is a legacy/corruption safety net.
                  await workspaceDb(admin, workspaceId).table<FileUpload>('file_uploads').update(upload.id, {
                    status: 'uploaded',
                    expiresAt: null,
                    deletedAt: null,
                    deletedBy: null,
                    deletionPreviousStatus: null,
                    pageId: owner.pageId ?? null,
                    blockId: owner.blockId ?? null,
                    databaseId: owner.databaseId ?? null,
                    propertyId: null,
                    templateId: owner.templateId ?? null,
                    updatedAt: nowIso(),
                  });
                  continue;
                }
                const deleted = await deleteStoredFile(storage, upload);
                if (deleted) {
                  deletedObjects += 1;
                  stats.deletedObjects += 1;
                }
                const workspace = await getExisting(db.table<Workspace>('workspaces'), upload.workspaceId);
                if (workspace?.organizationId) {
                  await releaseOrganizationStorage(admin, {
                    id: upload.id,
                    organizationId: workspace.organizationId,
                    workspaceId: upload.workspaceId,
                    bytes:
                      typeof upload.size === 'number' && Number.isFinite(upload.size)
                        ? Math.max(0, Math.floor(upload.size))
                        : 0,
                  });
                }
                await lease.renew();
                const deletedAt = nowIso();
                const finalStatus: FileUploadStatus = upload.status === 'deleting' ? 'deleted' : 'expired';
                const expiredUpload = await uploadsTableFor(upload)!.update(upload.id, {
                  status: finalStatus,
                  expiredAt: finalStatus === 'expired' ? deletedAt : upload.expiredAt ?? null,
                  deletedAt,
                  deletedBy: SYSTEM_ACTOR_ID,
                  deletionPreviousStatus: null,
                });
                if (finalStatus === 'expired') stats.expired += 1;
                else stats.deletedReferences += 1;
                stats.uploadIds.push(upload.id);
                updated.push(expiredUpload);
              } catch (err) {
                const failure = {
                  id: candidate.id,
                  key: candidate.key,
                  message: err instanceof Error ? err.message : 'Stored file cleanup failed.',
                };
                failures.push(failure);
                stats.failures.push(failure);
                // Keep the durable pending/preparing/deleting row until every
                // object + quota transition succeeds, so the next sweep retries.
              }
            }
          },
        );
      } catch (err) {
        for (const candidate of candidates) {
          const stats = workspaceStats(statsByWorkspace, workspaceId);
          const failure = {
            id: candidate.id,
            key: candidate.key,
            message: err instanceof Error ? err.message : 'Workspace file lease failed.',
          };
          failures.push(failure);
          stats.failures.push(failure);
        }
      }
    }

    const finishedAt = nowIso();
    const maintenanceRuns = await recordMaintenanceRuns(
      db,
      statsByWorkspace,
      startedAt,
      finishedAt,
      scheduledAt,
    );

    const result = {
      ok: failures.length === 0,
      action: 'cleanupExpiredUploads',
      duplicatePageRecovery,
      databasePropertyDeleteRecovery,
      organizationAuditOutboxRecovery,
      scheduled: data ?? null,
      scanned: cleanupCandidates.length,
      expired: updated.filter((upload) => upload.status === 'expired').length,
      deletedReferences: updated.filter((upload) => upload.status === 'deleted').length,
      orphanedUploads: Array.from(statsByWorkspace.values()).reduce(
        (total, stats) => total + stats.orphanedUploads,
        0,
      ),
      duplicatePageRecoveryFailures: duplicatePageRecovery.failures.length,
      databasePropertyDeleteRecoveryFailures: databasePropertyDeleteRecovery.failures.length,
      organizationAuditOutboxFailures: organizationAuditOutboxRecovery.reduce(
        (count, recovery) => count + recovery.failures.length,
        0,
      ),
      deletedObjects,
      failures,
      maintenanceRuns: maintenanceRuns.length,
    };

    if (
      updated.length
      || result.orphanedUploads
      || databasePropertyDeleteRecovery.recovered.length
      || failures.length
    ) {
      console.log(`[file-maintenance] ${JSON.stringify(result)}`);
    }

    return result;
  },
});
