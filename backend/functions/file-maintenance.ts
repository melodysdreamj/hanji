import { defineFunction } from '@edge-base/shared';
import type { AdminDbAccessor } from '../lib/workspace-db';
import {
  nextWorkspaceFileMaintenanceDueAt,
  selectFileMaintenanceWorkspaces,
  settleWorkspaceFileMaintenance,
} from '../lib/file-maintenance-routing';
import { releaseOrganizationStorage } from '../lib/storage-quota';
import { withFileWorkspaceLease } from '../lib/file-operation-lock';
import { assertPreservableStoredUpload } from '../lib/permanent-file-delete';
import {
  FILE_REFERENCE_DELETE_GRACE_MS,
  fileUploadReferenceOwners,
  targetedFileUploadReferenceOwners,
  workspaceFileReferenceSnapshot,
} from '../lib/file-reference-lifecycle';
import { recoverStaleDuplicatePageOperations } from '../lib/duplicate-page-recovery';
import { nextNotionImportTerminalSweep } from '../lib/notion-import-terminal-sweep';
import { recoverStaleDatabasePropertyDeleteOperations } from './database-mutation';
import { flushOrganizationAuditOutbox } from '../lib/organization-audit-outbox';

import {
  getExisting,
  nowIso,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from '../lib/table-utils';
const FILE_BUCKET = 'files';
const SYSTEM_ACTOR_ID = 'system:file-maintenance';
// Self-hosted content DBs serialize their owner scan and object/quota
// transitions. A 200-row sweep blocked the observed Synology runtime for over
// a minute, so each invocation deliberately advances only a small durable
// slice. The appliance dispatcher runs this function every five minutes.
const DEFAULT_CLEANUP_LIMIT = 10;
const PREPARING_RECOVERY_TTL_MS = 30 * 60 * 1000;
// Signed PUT grants are normally 30 minutes. Legacy/corrupt pending rows may
// lack expiresAt; one extra five-minute margin avoids racing the longest grant
// while ensuring such rows do not wedge deletion and quota forever.
const LEGACY_PENDING_RECOVERY_TTL_MS = 35 * 60 * 1000;
const UNATTACHED_UPLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_REFERENCE_RECHECK_MS = 24 * 60 * 60 * 1000;
const NOTION_TERMINAL_OBJECT_RESWEEP_DELAY_MS = 60 * 60 * 1000;
// Ambiguous legacy associations retain the workspace-wide fail-closed scan,
// but that heavyweight compatibility lane may consume only one candidate in a
// maintenance invocation. Exact import provenance always uses targeted owner
// reads below and never builds a workspace snapshot.
const LEGACY_TERMINAL_SNAPSHOT_LIMIT = 1;
const NOTION_TERMINAL_JOB_STATUSES = ['failed', 'cancelled'] as const;
const NOTION_TERMINAL_LIVE_UPLOAD_STATUSES = [
  'deleting',
  'pending',
  'preparing',
  'uploaded',
] as const;
type NotionTerminalLiveUploadStatus = (typeof NOTION_TERMINAL_LIVE_UPLOAD_STATUSES)[number];

type FileUploadStatus = 'preparing' | 'pending' | 'uploaded' | 'deleting' | 'deleted' | 'expired';

function isNotionTerminalLiveUploadStatus(
  status: FileUploadStatus,
): status is NotionTerminalLiveUploadStatus {
  return (NOTION_TERMINAL_LIVE_UPLOAD_STATUSES as readonly FileUploadStatus[]).includes(status);
}

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
  orphanReferenceCheckedAt?: string | null;
  size?: number;
  status: FileUploadStatus;
  expiresAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionPreviousStatus?: 'preparing' | 'pending' | 'uploaded' | null;
  notionImportJobId?: string | null;
  notionImportSnapshotRevision?: string | null;
  notionImportSlotKey?: string | null;
  notionImportTerminalSweepAfter?: string | null;
  notionImportTerminalSweepCompletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface NotionImportJobCheckpointState {
  id: string;
  workspaceId?: string;
  status?: string;
  itemSnapshotRevision?: string | null;
  fileCleanupStatus?: 'pending' | 'complete' | null;
  fileCleanupRequestedAt?: string | null;
  fileCleanupCompletedAt?: string | null;
  report?: Record<string, unknown>;
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

function isLegacyTerminalSnapshotEligible(upload: FileUpload, at: number) {
  if (isOldUnattachedCandidate(upload, at)) return true;
  if (upload.status !== 'deleting' || upload.deletionPreviousStatus !== 'uploaded') return false;
  const completedAt = Date.parse(upload.completedAt ?? upload.updatedAt ?? upload.createdAt ?? '');
  return Number.isFinite(completedAt) && completedAt + UNATTACHED_UPLOAD_MIN_AGE_MS <= at;
}

function isTerminalNotionObjectResweepCandidate(upload: FileUpload, at: number) {
  if (upload.status !== 'expired' && upload.status !== 'deleted') return false;
  if (!upload.notionImportJobId || !upload.notionImportSnapshotRevision) return false;
  if (!upload.key.includes('/notion-import/')) return false;
  const sweepAfter = Date.parse(upload.notionImportTerminalSweepAfter ?? '');
  return Number.isFinite(sweepAfter) && sweepAfter <= at;
}

async function isActiveNotionImportCheckpoint(
  db: DbRef,
  upload: FileUpload,
  cache: Map<string, Promise<NotionImportJobCheckpointState | null>>,
) {
  if (!upload.notionImportJobId) return false;
  let job = cache.get(upload.notionImportJobId);
  if (!job) {
    job = getExisting(
      db.table<NotionImportJobCheckpointState>('notion_import_jobs'),
      upload.notionImportJobId,
    );
    cache.set(upload.notionImportJobId, job);
  }
  const current = await job;
  // A pending cleanup marker owns every live checkpoint for that job. Only
  // rows explicitly admitted through the bounded failed/cancelled terminal
  // inventory may bypass this guard; otherwise generic orphan/expiry queries
  // could process an unselected, malformed, or query-failed terminal row.
  if (current?.fileCleanupStatus === 'pending') return true;
  return !!upload.notionImportSnapshotRevision
    && current?.status === 'ready'
    && current.itemSnapshotRevision === upload.notionImportSnapshotRevision;
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
    upload.notionImportTerminalSweepAfter
    ?? upload.expiresAt
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

function terminalJobExpectation(job: NotionImportJobCheckpointState) {
  return {
    table: 'notion_import_jobs',
    op: 'expect' as const,
    id: job.id,
    where: [
      ['status', '==', job.status ?? null],
      ['fileCleanupStatus', '==', 'pending'],
      ['itemSnapshotRevision', '==', job.itemSnapshotRevision ?? null],
      ['fileCleanupRequestedAt', '==', job.fileCleanupRequestedAt ?? null],
    ] as Array<[string, '==', unknown]>,
    exists: true,
  };
}

function terminalJobCompletionOperations(
  job: NotionImportJobCheckpointState,
  completedAt: string,
): TransactOperation[] {
  const completionFence = {
    table: 'notion_import_jobs',
    id: job.id,
    field: 'fileCleanupStatus',
  };
  return [
    terminalJobExpectation(job),
    {
      table: 'notion_import_jobs',
      op: 'update',
      id: job.id,
      data: {
        fileCleanupStatus: 'complete',
        fileCleanupCompletedAt: completedAt,
        report: {
          ...(job.report ?? {}),
          fileCleanupPending: null,
          fileCleanupCompletedAt: completedAt,
        },
      },
    },
    ...NOTION_TERMINAL_LIVE_UPLOAD_STATUSES.map((status): TransactOperation => ({
      table: 'file_uploads',
      op: 'expect',
      where: [
        ['notionImportJobId', '==', job.id],
        ['status', '==', status],
      ],
      exists: false,
      fencedBy: completionFence,
    })),
  ];
}

function terminalCleanupJobKey(workspaceId: string | undefined, jobId: string) {
  return `${workspaceId ?? ''}\n${jobId}`;
}

function roundRobinTerminalUploads(
  uploadsByJob: Array<{ job: NotionImportJobCheckpointState; uploads: FileUpload[] }>,
) {
  const out: Array<{ job: NotionImportJobCheckpointState; upload: FileUpload }> = [];
  for (let offset = 0; ; offset += 1) {
    let added = false;
    for (const entry of uploadsByJob) {
      const upload = entry.uploads[offset];
      if (!upload) continue;
      out.push({ job: entry.job, upload });
      added = true;
    }
    if (!added) return out;
  }
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
  trigger: { type: 'schedule', cron: '*/5 * * * *' },
  handler: async (context) => {
    const { admin, data, storage } = context as FunctionContext;
    const startedAt = nowIso();
    const scheduledAt = scheduledAtFromData(data);
    const db = admin.db('app');
    const now = Date.now();
    // Content remains workspace-local. Select one fixed due window plus a
    // separately reserved rotating audit window instead of waking every DO.
    const routeSelection = await selectFileMaintenanceWorkspaces(admin, now);
    const contentDbs = routeSelection.workspaces.map(({ workspaceId, db: contentDb }) => ({
      workspaceId,
      db: contentDb,
    }));
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
    const terminalCleanupUploadIds = new Set<string>();
    const terminalCleanupJobByUploadId = new Map<string, NotionImportJobCheckpointState>();
    const terminalCleanupRoundRobinOrder = new Map<string, number>();
    const terminalCleanupJobs = new Map<string, {
      db: DbRef;
      job: NotionImportJobCheckpointState;
    }>();
    const terminalCleanupCandidateQueryFailedJobs = new Set<string>();
    const terminalCleanupEligibleJobs = new Set<string>();
    const terminalCleanupSelectedJobs = new Set<string>();
    const terminalCleanupLegacyBudgetDeferredJobs = new Set<string>();
    const terminalCleanupLegacyServicedJobs = new Set<string>();
    const terminalQueueSaturatedWorkspaces = new Set<string>();
    const terminalCollectionFailures: Array<{
      workspaceId: string;
      id: string;
      key: string;
      message: string;
    }> = [];
    const unattachedCutoff = new Date(now - UNATTACHED_UPLOAD_MIN_AGE_MS).toISOString();
    const orphanReferenceRecheckCutoff = new Date(
      now - ORPHAN_REFERENCE_RECHECK_MS,
    ).toISOString();
    for (const { workspaceId, db: contentDb } of contentDbs) {
      let pendingTerminalJobs: NotionImportJobCheckpointState[] = [];
      try {
        pendingTerminalJobs = (await listAll(
          orderOldestFirst(
            whereIfSupported(
              contentDb.table<NotionImportJobCheckpointState>('notion_import_jobs')
                .where('fileCleanupStatus', '==', 'pending'),
              'status',
              'in',
              [...NOTION_TERMINAL_JOB_STATUSES],
            ),
            'fileCleanupRequestedAt',
          ),
          DEFAULT_CLEANUP_LIMIT,
        ))
          .filter((job) => NOTION_TERMINAL_JOB_STATUSES.includes(
            job.status as (typeof NOTION_TERMINAL_JOB_STATUSES)[number],
          ))
          .slice(0, DEFAULT_CLEANUP_LIMIT);
      } catch (error) {
        terminalCollectionFailures.push({
          workspaceId: workspaceId ?? '',
          id: `notion-import-file-cleanup-queue:${workspaceId ?? 'unknown'}`,
          key: '',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (pendingTerminalJobs.length >= DEFAULT_CLEANUP_LIMIT && workspaceId) {
        terminalQueueSaturatedWorkspaces.add(workspaceId);
      }
      const terminalUploadsByJob: Array<{
        job: NotionImportJobCheckpointState;
        uploads: FileUpload[];
      }> = [];
      for (const job of pendingTerminalJobs) {
        const jobKey = terminalCleanupJobKey(workspaceId ?? undefined, job.id);
        terminalCleanupJobs.set(jobKey, { db: contentDb, job });
        try {
          const uploads = (await listAll(
            whereIfSupported(
              contentDb.table<FileUpload>('file_uploads')
                .where('notionImportJobId', '==', job.id),
              'status',
              'in',
              [...NOTION_TERMINAL_LIVE_UPLOAD_STATUSES],
            ),
            DEFAULT_CLEANUP_LIMIT,
          )).filter((upload) => isNotionTerminalLiveUploadStatus(upload.status));
          terminalUploadsByJob.push({ job, uploads });
        } catch (error) {
          terminalCleanupCandidateQueryFailedJobs.add(jobKey);
          terminalCollectionFailures.push({
            workspaceId: workspaceId ?? '',
            id: `notion-import-file-cleanup-candidates:${job.id}`,
            key: '',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const terminalQueueUploads = roundRobinTerminalUploads(terminalUploadsByJob)
        .map(({ job, upload }, index) => {
          terminalCleanupUploadIds.add(upload.id);
          terminalCleanupJobByUploadId.set(upload.id, job);
          terminalCleanupRoundRobinOrder.set(upload.id, index);
          return upload;
        });
      const uploadedBase = whereIfSupported(
        contentDb.table<FileUpload>('file_uploads').where('status', '==', 'uploaded'),
        'orphanReferenceCheckedAt',
        '==',
        null,
      );
      const oldCompletedUploads = await listAll(
        orderOldestFirst(
          whereIfSupported(uploadedBase, 'completedAt', '<=', unattachedCutoff),
          'completedAt',
        ),
        DEFAULT_CLEANUP_LIMIT,
      );
      const legacyUploadedBase = whereIfSupported(
        contentDb.table<FileUpload>('file_uploads').where('status', '==', 'uploaded'),
        'orphanReferenceCheckedAt',
        '==',
        null,
      );
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
      const legacyCreatedUploadedBase = whereIfSupported(
        contentDb.table<FileUpload>('file_uploads').where('status', '==', 'uploaded'),
        'orphanReferenceCheckedAt',
        '==',
        null,
      );
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
      const dueReferenceRechecks = await listAll(
        orderOldestFirst(
          whereIfSupported(
            contentDb.table<FileUpload>('file_uploads').where('status', '==', 'uploaded'),
            'orphanReferenceCheckedAt',
            '<=',
            orphanReferenceRecheckCutoff,
          ),
          'orphanReferenceCheckedAt',
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
      const dueNotionTerminalCheckpoints = await listAll(
        orderOldestFirst(
          contentDb.table<FileUpload>('file_uploads').where(
            'notionImportTerminalSweepAfter',
            '<=',
            new Date(now).toISOString(),
          ),
          'notionImportTerminalSweepAfter',
        ),
        DEFAULT_CLEANUP_LIMIT,
      );
      const workspaceCandidatesBeforeActiveImportFilter = Array.from(
        new Map(
          [
            ...deletingUploads,
            ...pendingUploads,
            ...preparingUploads,
            ...oldCompletedUploads,
            ...oldLegacyUploads,
            ...oldLegacyCreatedUploads,
            ...dueReferenceRechecks,
            ...dueNotionTerminalCheckpoints,
            ...terminalQueueUploads,
          ].map((upload) => [upload.id, upload]),
        ).values(),
      )
        .filter((upload) => (
          (
            terminalCleanupUploadIds.has(upload.id)
            && (upload.status === 'uploaded' || isExpired(upload, now))
          )
          || isExpired(upload, now)
          || isOldUnattachedCandidate(upload, now)
          || isTerminalNotionObjectResweepCandidate(upload, now)
        ))
        .sort((a, b) => {
          const aTerminal = terminalCleanupUploadIds.has(a.id);
          const bTerminal = terminalCleanupUploadIds.has(b.id);
          if (aTerminal && bTerminal) {
            return (terminalCleanupRoundRobinOrder.get(a.id) ?? 0)
              - (terminalCleanupRoundRobinOrder.get(b.id) ?? 0);
          }
          return (
            (aTerminal ? cleanupPriority(a) : cleanupPriority(a) + 3)
            - (bTerminal ? cleanupPriority(b) : cleanupPriority(b) + 3)
          ) || cleanupTimestamp(a).localeCompare(cleanupTimestamp(b));
        });
      const activeImportJobs = new Map<string, Promise<NotionImportJobCheckpointState | null>>();
      const workspaceCandidates: FileUpload[] = [];
      for (const upload of workspaceCandidatesBeforeActiveImportFilter) {
        const terminalResweep = isTerminalNotionObjectResweepCandidate(upload, now);
        if (
          !terminalResweep
          && !terminalCleanupUploadIds.has(upload.id)
          && await isActiveNotionImportCheckpoint(contentDb, upload, activeImportJobs)
        ) {
          continue;
        }
        workspaceCandidates.push(upload);
        const terminalJob = terminalCleanupJobByUploadId.get(upload.id);
        if (terminalJob) {
          terminalCleanupEligibleJobs.add(
            terminalCleanupJobKey(upload.workspaceId, terminalJob.id),
          );
        }
        if (workspaceCandidates.length >= DEFAULT_CLEANUP_LIMIT) break;
      }
      cleanupCandidates.push(
        ...workspaceCandidates,
      );
    }
    const uploadsTableFor = (upload: FileUpload) =>
      uploadsTables.get(upload.workspaceId ?? '') ?? uploadsTables.values().next().value;
    const eligibleByPriority = Array.from(
      { length: 6 },
      () => new Map<string, FileUpload[]>(),
    );
    for (const upload of cleanupCandidates) {
      const priority = terminalCleanupUploadIds.has(upload.id)
        ? 0
        : cleanupPriority(upload) + 3;
      const map = eligibleByPriority[priority]!;
      const list = map.get(upload.workspaceId) ?? [];
      list.push(upload);
      map.set(upload.workspaceId, list);
    }
    // Priority first (explicit detach, then grant expiry, then orphan sweep),
    // with deterministic workspace round-robin inside each class. An orphan
    // backlog can neither starve explicit deletion nor monopolize the global
    // bounded cleanup budget.
    const expired: FileUpload[] = [];
    for (const candidatesByWorkspace of eligibleByPriority) {
      const oldestTerminalCursor = (workspaceId: string) => {
        let cursor = Number.POSITIVE_INFINITY;
        for (const upload of candidatesByWorkspace.get(workspaceId) ?? []) {
          const job = terminalCleanupJobByUploadId.get(upload.id);
          if (!job) continue;
          const parsed = Date.parse(job.fileCleanupRequestedAt ?? '');
          cursor = Math.min(cursor, Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY);
        }
        return cursor;
      };
      const workspaceIds = Array.from(candidatesByWorkspace.keys()).sort((left, right) => {
        const leftCursor = oldestTerminalCursor(left);
        const rightCursor = oldestTerminalCursor(right);
        return leftCursor === rightCursor
          ? left.localeCompare(right)
          : leftCursor - rightCursor;
      });
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
    for (const upload of expired) {
      const job = terminalCleanupJobByUploadId.get(upload.id);
      if (job) {
        terminalCleanupSelectedJobs.add(terminalCleanupJobKey(upload.workspaceId, job.id));
      }
    }

    let deletedObjects = 0;
    const failures: Array<{ id: string; key: string; message: string }> = [];
    const updated: FileUpload[] = [];
    const statsByWorkspace = new Map<string, WorkspaceMaintenanceStats>();
    let legacyTerminalSnapshots = 0;

    for (const { workspaceId, ...failure } of terminalCollectionFailures) {
      failures.push(failure);
      workspaceStats(statsByWorkspace, workspaceId).failures.push(failure);
    }

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
            // The bounded facade normally snapshots each update to enforce
            // user-facing deletion fences and append change-log rows. This
            // system worker already owns the workspace file lease and carries
            // exact job/upload CAS expectations, so use the underlying
            // workspace DB for terminal metadata mutations; otherwise the
            // facade reintroduces one get-by-id per checkpoint.
            const terminalDb = routeSelection.workspaces.find(
              (route) => route.workspaceId === workspaceId,
            )?.rawDb;
            if (!terminalDb) throw new Error('Workspace maintenance route was not claimed.');
            const terminalLeaseExpectation = {
              table: 'file_workspace_locks',
              op: 'expect' as const,
              id: lease.lease.id,
              where: [['leaseId', '==', lease.lease.leaseId]] as Array<[string, '==', unknown]>,
              exists: true,
            };
            let referenceSnapshot:
              | Awaited<ReturnType<typeof workspaceFileReferenceSnapshot>>
              | undefined;
            const ownerCache = new Map<string, {
              owners: ReturnType<typeof fileUploadReferenceOwners>;
              deferred: boolean;
            }>();
            let quotaWorkspace: Promise<Workspace | null> | undefined;
            const releaseUploadQuota = async (upload: FileUpload) => {
              const workspace = await (quotaWorkspace ??= getExisting(
                db.table<Workspace>('workspaces'),
                workspaceId,
              ));
              if (!workspace?.organizationId) return;
              await releaseOrganizationStorage(admin, {
                id: upload.id,
                organizationId: workspace.organizationId,
                workspaceId: upload.workspaceId,
                bytes:
                  typeof upload.size === 'number' && Number.isFinite(upload.size)
                    ? Math.max(0, Math.floor(upload.size))
                    : 0,
              });
            };
            const referenceOwners = async (upload: FileUpload) => {
              const cached = ownerCache.get(upload.id);
              if (cached) return cached;
              const terminal = terminalCleanupUploadIds.has(upload.id);
              if (terminal) {
                const targeted = await targetedFileUploadReferenceOwners(contentDb, upload);
                if (targeted.association === 'exact') {
                  const result = { owners: targeted.owners, deferred: false };
                  ownerCache.set(upload.id, result);
                  return result;
                }
                // Legacy associations can share one storage key across owners,
                // so deleting them from targeted evidence would be unsafe. Keep
                // that compatibility scan both old-enough and globally bounded.
                if (!isLegacyTerminalSnapshotEligible(upload, Date.now())) {
                  const result = {
                    owners: [] as ReturnType<typeof fileUploadReferenceOwners>,
                    deferred: true,
                  };
                  ownerCache.set(upload.id, result);
                  return result;
                }
                const terminalJob = terminalCleanupJobByUploadId.get(upload.id);
                const jobKey = terminalJob
                  ? terminalCleanupJobKey(upload.workspaceId, terminalJob.id)
                  : undefined;
                if (legacyTerminalSnapshots >= LEGACY_TERMINAL_SNAPSHOT_LIMIT) {
                  if (jobKey) terminalCleanupLegacyBudgetDeferredJobs.add(jobKey);
                  const result = {
                    owners: [] as ReturnType<typeof fileUploadReferenceOwners>,
                    deferred: true,
                  };
                  ownerCache.set(upload.id, result);
                  return result;
                }
                legacyTerminalSnapshots += 1;
                if (jobKey) terminalCleanupLegacyServicedJobs.add(jobKey);
              }
              referenceSnapshot ??= await workspaceFileReferenceSnapshot(contentDb, workspaceId, db);
              const result = {
                owners: fileUploadReferenceOwners(upload, referenceSnapshot),
                deferred: false,
              };
              ownerCache.set(upload.id, result);
              return result;
            };
            const activeImportJobs = new Map<string, Promise<NotionImportJobCheckpointState | null>>();
            for (const candidate of candidates) {
              const stats = workspaceStats(statsByWorkspace, workspaceId);
              try {
                await lease.renew();
                const terminalJob = terminalCleanupJobByUploadId.get(candidate.id);
                // The per-job mixed-status query is the fresh bounded terminal
                // inventory. Do not turn it back into a checkpoint-by-checkpoint
                // N+1; every terminal mutation below carries an exact job/upload
                // CAS while the workspace lease serializes owner changes.
                const upload = terminalJob
                  ? candidate
                  : await getExisting(contentDb.table<FileUpload>('file_uploads'), candidate.id);
                if (
                  !upload
                  || (
                    upload.status !== 'pending'
                    && upload.status !== 'preparing'
                    && upload.status !== 'deleting'
                    && upload.status !== 'uploaded'
                    && upload.status !== 'expired'
                    && upload.status !== 'deleted'
                  )
                  || (
                    !(
                      terminalCleanupUploadIds.has(upload.id)
                      && (upload.status === 'uploaded' || isExpired(upload, Date.now()))
                    )
                    && !isExpired(upload, Date.now())
                    && !isOldUnattachedCandidate(upload, Date.now())
                    && !isTerminalNotionObjectResweepCandidate(upload, Date.now())
                  )
                ) {
                  continue;
                }
                if (
                  upload.status !== 'expired'
                  && upload.status !== 'deleted'
                  && !terminalJob
                  && await isActiveNotionImportCheckpoint(contentDb, upload, activeImportJobs)
                ) {
                  continue;
                }
                if (upload.status === 'expired' || upload.status === 'deleted') {
                  const deleted = await deleteStoredFile(storage, upload);
                  if (deleted) {
                    deletedObjects += 1;
                    stats.deletedObjects += 1;
                  }
                  await releaseUploadQuota(upload);
                  await uploadsTableFor(upload)!.update(
                    upload.id,
                    nextNotionImportTerminalSweep(upload),
                  );
                  stats.uploadIds.push(upload.id);
                  continue;
                }
                if (upload.status === 'uploaded') {
                  const reference = await referenceOwners(upload);
                  if (reference.deferred) continue;
                  if (reference.owners.length > 0) {
                    if (terminalJob) {
                      // A terminal import can leave a completed checkpoint on
                      // product data that a user already owns. Preserve the
                      // object and owner, but graduate the upload out of the
                      // import-cleanup queue so old jobs cannot be rescanned
                      // forever or starve later terminal jobs.
                      await assertPreservableStoredUpload(storage, upload);
                      const timestamp = nowIso();
                      await terminalDb.transact([
                        terminalJobExpectation(terminalJob),
                        terminalLeaseExpectation,
                        {
                          table: 'file_uploads',
                          op: 'expect',
                          id: upload.id,
                          where: [
                            ['status', '==', 'uploaded'],
                            ['notionImportJobId', '==', upload.notionImportJobId ?? null],
                            ['notionImportSnapshotRevision', '==', upload.notionImportSnapshotRevision ?? null],
                            ['notionImportSlotKey', '==', upload.notionImportSlotKey ?? null],
                            ['key', '==', upload.key],
                            ['pageId', '==', upload.pageId ?? null],
                            ['blockId', '==', upload.blockId ?? null],
                            ['databaseId', '==', upload.databaseId ?? null],
                            ['propertyId', '==', upload.propertyId ?? null],
                            ['templateId', '==', upload.templateId ?? null],
                            ['completedAt', '==', upload.completedAt ?? null],
                            ['etag', '==', upload.etag ?? null],
                            ['contentType', '==', upload.contentType ?? null],
                            ['size', '==', upload.size ?? null],
                            ['updatedAt', '==', upload.updatedAt ?? null],
                          ],
                          exists: true,
                        },
                        {
                          table: 'file_uploads',
                          op: 'update',
                          id: upload.id,
                          data: {
                            notionImportJobId: null,
                            notionImportSnapshotRevision: null,
                            notionImportSlotKey: null,
                            notionImportTerminalSweepAfter: null,
                            notionImportTerminalSweepCompletedAt: timestamp,
                            orphanReferenceCheckedAt: timestamp,
                            updatedAt: timestamp,
                          },
                        },
                      ]);
                      stats.uploadIds.push(upload.id);
                    } else {
                      // Once an old upload is authoritatively proven attached,
                      // remove it from the orphan window. Reference lifecycle
                      // writes own every later detach/restore transition.
                      const timestamp = nowIso();
                      await terminalDb.transact([
                        terminalLeaseExpectation,
                        {
                          table: 'file_uploads',
                          op: 'expect',
                          id: upload.id,
                          where: [
                            ['status', '==', 'uploaded'],
                            ['updatedAt', '==', upload.updatedAt ?? null],
                            ['orphanReferenceCheckedAt', '==', upload.orphanReferenceCheckedAt ?? null],
                          ],
                          exists: true,
                        },
                        {
                          table: 'file_uploads',
                          op: 'update',
                          id: upload.id,
                          data: { orphanReferenceCheckedAt: timestamp },
                        },
                      ]);
                    }
                    continue;
                  }
                  const timestamp = nowIso();
                  await (terminalJob ? terminalDb : contentDb).transact([
                    ...(terminalJob ? [
                      terminalJobExpectation(terminalJob),
                      terminalLeaseExpectation,
                    ] : []),
                    {
                      table: 'file_uploads',
                      op: 'expect',
                      id: upload.id,
                      where: [
                        ['status', '==', 'uploaded'],
                        ['notionImportJobId', '==', upload.notionImportJobId ?? null],
                        ['notionImportSnapshotRevision', '==', upload.notionImportSnapshotRevision ?? null],
                        ['notionImportSlotKey', '==', upload.notionImportSlotKey ?? null],
                        ['updatedAt', '==', upload.updatedAt ?? null],
                      ],
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
                const deletingReference = upload.status === 'deleting'
                  ? await referenceOwners(upload)
                  : undefined;
                if (deletingReference?.deferred) continue;
                if (upload.status === 'deleting' && deletingReference!.owners.length > 0) {
                  const previous = upload.deletionPreviousStatus;
                  if (previous && previous !== 'uploaded') {
                    throw new Error(
                      'Stored file is still referenced but its upload never completed; cleanup was deferred.',
                    );
                  }
                  await assertPreservableStoredUpload(storage, upload);
                  const owners = deletingReference!.owners;
                  const owner = owners.find((candidate) => candidate.kind === 'block')
                    ?? owners.find((candidate) => candidate.kind === 'page')
                    ?? owners.find((candidate) => candidate.kind === 'template')
                    ?? owners[0];
                  if (!owner) continue;
                  // Normal reattachment restores this atomically with the
                  // owner update. This is a legacy/corruption safety net.
                  const timestamp = nowIso();
                  await (terminalJob ? terminalDb : contentDb).transact([
                    ...(terminalJob ? [
                      terminalJobExpectation(terminalJob),
                      terminalLeaseExpectation,
                    ] : []),
                    {
                      table: 'file_uploads',
                      op: 'expect',
                      id: upload.id,
                      where: [
                        ['status', '==', 'deleting'],
                        ['deletionPreviousStatus', '==', upload.deletionPreviousStatus ?? null],
                        ['notionImportJobId', '==', upload.notionImportJobId ?? null],
                        ['notionImportSnapshotRevision', '==', upload.notionImportSnapshotRevision ?? null],
                        ['notionImportSlotKey', '==', upload.notionImportSlotKey ?? null],
                        ['updatedAt', '==', upload.updatedAt ?? null],
                      ],
                      exists: true,
                    },
                    {
                      table: 'file_uploads',
                      op: 'update',
                      id: upload.id,
                      data: {
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
                        ...(terminalJob ? {
                          notionImportJobId: null,
                          notionImportSnapshotRevision: null,
                          notionImportSlotKey: null,
                          notionImportTerminalSweepAfter: null,
                          notionImportTerminalSweepCompletedAt: timestamp,
                        } : {}),
                        orphanReferenceCheckedAt: timestamp,
                        updatedAt: timestamp,
                      },
                    },
                  ]);
                  continue;
                }
                let retiringUpload = upload;
                if (
                  terminalJob
                  && (
                    upload.status === 'pending'
                    || upload.status === 'preparing'
                    || upload.status === 'deleting'
                  )
                ) {
                  const claimedAt = nowIso();
                  const previousStatus = upload.status === 'deleting'
                    ? upload.deletionPreviousStatus ?? null
                    : upload.status;
                  await terminalDb.transact([
                    terminalJobExpectation(terminalJob),
                    terminalLeaseExpectation,
                    {
                      table: 'file_uploads',
                      op: 'expect',
                      id: upload.id,
                      where: [
                        ['status', '==', upload.status],
                        ['expiresAt', '==', upload.expiresAt ?? null],
                        ['notionImportJobId', '==', upload.notionImportJobId ?? null],
                        ['notionImportSnapshotRevision', '==', upload.notionImportSnapshotRevision ?? null],
                        ['notionImportSlotKey', '==', upload.notionImportSlotKey ?? null],
                        ['updatedAt', '==', upload.updatedAt ?? null],
                      ],
                      exists: true,
                    },
                    {
                      table: 'file_uploads',
                      op: 'update',
                      id: upload.id,
                      data: {
                        status: 'deleting',
                        deletionPreviousStatus: previousStatus,
                        expiresAt: claimedAt,
                        deletedBy: SYSTEM_ACTOR_ID,
                        updatedAt: claimedAt,
                      },
                    },
                  ]);
                  retiringUpload = {
                    ...upload,
                    status: 'deleting',
                    deletionPreviousStatus: previousStatus,
                    expiresAt: claimedAt,
                    deletedBy: SYSTEM_ACTOR_ID,
                    updatedAt: claimedAt,
                  };
                }
                const deleted = await deleteStoredFile(storage, retiringUpload);
                if (deleted) {
                  deletedObjects += 1;
                  stats.deletedObjects += 1;
                }
                await releaseUploadQuota(retiringUpload);
                await lease.renew();
                const deletedAt = nowIso();
                const finalStatus: FileUploadStatus = upload.status === 'deleting' ? 'deleted' : 'expired';
                const terminalNotionCheckpoint = !!retiringUpload.notionImportJobId
                  && !!retiringUpload.notionImportSnapshotRevision
                  && retiringUpload.key.includes('/notion-import/');
                const finalPatch: Partial<FileUpload> = {
                  status: finalStatus,
                  expiredAt: finalStatus === 'expired' ? deletedAt : retiringUpload.expiredAt ?? null,
                  deletedAt,
                  deletedBy: SYSTEM_ACTOR_ID,
                  deletionPreviousStatus: null,
                  ...(terminalNotionCheckpoint ? {
                    notionImportTerminalSweepAfter: new Date(
                      Date.now() + NOTION_TERMINAL_OBJECT_RESWEEP_DELAY_MS,
                    ).toISOString(),
                    notionImportTerminalSweepCompletedAt: null,
                  } : {}),
                };
                let expiredUpload: FileUpload;
                if (terminalJob) {
                  await terminalDb.transact([
                    terminalJobExpectation(terminalJob),
                    terminalLeaseExpectation,
                    {
                      table: 'file_uploads',
                      op: 'expect',
                      id: retiringUpload.id,
                      where: [
                        ['status', '==', 'deleting'],
                        ['expiresAt', '==', retiringUpload.expiresAt ?? null],
                        ['deletionPreviousStatus', '==', retiringUpload.deletionPreviousStatus ?? null],
                        ['notionImportJobId', '==', retiringUpload.notionImportJobId ?? null],
                        ['notionImportSnapshotRevision', '==', retiringUpload.notionImportSnapshotRevision ?? null],
                        ['notionImportSlotKey', '==', retiringUpload.notionImportSlotKey ?? null],
                        ['key', '==', retiringUpload.key],
                        ['updatedAt', '==', retiringUpload.updatedAt ?? null],
                      ],
                      exists: true,
                    },
                    {
                      table: 'file_uploads',
                      op: 'update',
                      id: retiringUpload.id,
                      data: finalPatch,
                    },
                  ]);
                  // The exact CAS above is authoritative. Re-reading the row
                  // here would recreate a checkpoint-by-checkpoint N+1 merely
                  // to compute aggregate counters for the response.
                  expiredUpload = { ...retiringUpload, ...finalPatch };
                } else {
                  expiredUpload = await uploadsTableFor(retiringUpload)!.update(
                    retiringUpload.id,
                    finalPatch,
                  );
                }
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

    // A terminal job stays in the indexed queue until every live checkpoint
    // has either reached a terminal row or been promoted to ordinary
    // referenced product data above. This final CAS is restart-safe: a failed
    // candidate remains queryable and no later job can be starved by an old
    // completed queue entry.
    for (const [jobKey, { db: contentDb, job }] of terminalCleanupJobs) {
      const completedAt = nowIso();
      try {
        if (terminalCleanupCandidateQueryFailedJobs.has(jobKey)) {
          // A failed inventory is not evidence that the job is empty. Rotate
          // it behind independent work while leaving every checkpoint intact.
          await contentDb.transact([
            terminalJobExpectation(job),
            {
              table: 'notion_import_jobs',
              op: 'update',
              id: job.id,
              data: { fileCleanupRequestedAt: completedAt },
            },
          ]);
          continue;
        }
        const live = await whereIfSupported(
            contentDb.table<FileUpload>('file_uploads')
              .where('notionImportJobId', '==', job.id),
            'status',
            'in',
            [...NOTION_TERMINAL_LIVE_UPLOAD_STATUSES],
          )
          .limit(1)
          .getList();
        const hasLiveCheckpoint = (live.items ?? []).some((upload) => (
          isNotionTerminalLiveUploadStatus(upload.status)
        ));
        if (hasLiveCheckpoint) {
          const eligibleButNotSelected = terminalCleanupEligibleJobs.has(jobKey)
            && !terminalCleanupSelectedJobs.has(jobKey);
          const legacyBudgetDeferredWithoutService =
            terminalCleanupLegacyBudgetDeferredJobs.has(jobKey)
            && !terminalCleanupLegacyServicedJobs.has(jobKey);
          if (eligibleButNotSelected || legacyBudgetDeferredWithoutService) {
            // Preserve the older durable cursor when this job lost only the
            // global item/snapshot budget. The next invocation then orders its
            // workspace ahead of jobs that actually consumed this slice.
            continue;
          }
          // Rotate incomplete jobs behind newer terminal work. The original
          // request timestamp remains in report.fileCleanupPending; this indexed
          // queue cursor prevents one active grant, corrupt object, or transient
          // storage failure from monopolizing the first ten job slots forever.
          await contentDb.transact([
            terminalJobExpectation(job),
            {
              table: 'notion_import_jobs',
              op: 'update',
              id: job.id,
              data: { fileCleanupRequestedAt: completedAt },
            },
          ]);
          continue;
        }
        await contentDb.transact(terminalJobCompletionOperations(job, completedAt));
      } catch (error) {
        let cursorFailure: unknown;
        try {
          await contentDb.transact([
            terminalJobExpectation(job),
            {
              table: 'notion_import_jobs',
              op: 'update',
              id: job.id,
              data: { fileCleanupRequestedAt: completedAt },
            },
          ]);
        } catch (requeueError) {
          cursorFailure = requeueError;
        }
        const primaryMessage = error instanceof Error ? error.message : String(error);
        const failure = {
          id: `notion-import-file-cleanup:${job.id}`,
          key: '',
          message: cursorFailure
            ? `${primaryMessage}; queue rotation also failed: ${
              cursorFailure instanceof Error ? cursorFailure.message : String(cursorFailure)
            }`
            : primaryMessage,
        };
        failures.push(failure);
        const workspaceId = job.workspaceId ?? '';
        workspaceStats(statsByWorkspace, workspaceId).failures.push(failure);
      }
    }

    const routeSettlement: Array<{
      workspaceId: string;
      status: 'updated' | 'deleted' | 'superseded' | 'failed';
    }> = [];
    await Promise.all(routeSelection.workspaces.map(async (route) => {
      try {
        let nextDueAt = await nextWorkspaceFileMaintenanceDueAt(
          route.db,
          route.workspaceId,
          now,
        );
        if (
          terminalQueueSaturatedWorkspaces.has(route.workspaceId)
          || (statsByWorkspace.get(route.workspaceId)?.failures.length ?? 0) > 0
        ) {
          nextDueAt = new Date(now).toISOString();
        }
        routeSettlement.push({
          workspaceId: route.workspaceId,
          status: await settleWorkspaceFileMaintenance(
            admin,
            route.workspaceId,
            route.queueGeneration,
            nextDueAt,
            now,
          ),
        });
      } catch (error) {
        const failure = {
          id: `file-maintenance-routing:${route.workspaceId}`,
          key: '',
          message: error instanceof Error ? error.message : String(error),
        };
        failures.push(failure);
        workspaceStats(statsByWorkspace, route.workspaceId).failures.push(failure);
        routeSettlement.push({ workspaceId: route.workspaceId, status: 'failed' });
      }
    }));

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
      workspaceRouting: {
        selected: contentDbs.length,
        dueCandidates: routeSelection.dueCandidates,
        auditCandidates: routeSelection.auditCandidates,
        wakeBound: routeSelection.wakeBound,
        settlement: routeSettlement,
      },
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
