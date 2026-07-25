import { recordWorkspaceAudit } from './org-audit';
import {
  NOTION_IMPORT_RUN_ORPHAN_RECHECK_MS,
  NOTION_IMPORT_RUN_ORPHAN_RETENTION_MS,
  type NotionImportRunChunkOutcome,
  type NotionImportRunQueueLease,
} from './notion-import-run-queue';
import { getExisting, nowIso, type TableQuery, type TransactDb } from './table-utils';
import { boundedDbFromWorkspaceHint, type AdminDbAccessor } from './workspace-db';

type NotionImportServerRunnerStatus =
  | 'queued'
  | 'discovering'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'cancelled';

type NotionImportProgressStepKey = 'connect' | 'discover' | 'review' | 'apply' | 'file_copy_retry' | 'cancel';

export interface NotionImportServerRunnerJob {
  id: string;
  workspaceId: string;
  status: NotionImportServerRunnerStatus;
  phase: string;
  actorId?: string;
  connectionId?: string | null;
  options?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string | null;
  finishedAt?: string | null;
}

interface NotionImportServerRunnerTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportServerRunnerDb extends TransactDb {
  table<T>(name: string): NotionImportServerRunnerTable<T>;
}

interface NotionImportServerRunnerStorage {
  bucket?(bucket: string): NotionImportServerRunnerStorage;
}

interface NotionImportRunnerResult<
  ResultJob extends NotionImportServerRunnerJob,
> {
  job: ResultJob;
}

interface NotionImportServerRunnerProgressEvent {
  key: 'discover' | 'apply';
  status: 'failed';
  legacyStep: string;
  message: string;
  at: string;
}

export interface NotionImportServerRunnerRuntime<
  Job extends NotionImportServerRunnerJob,
  ResultJob extends Job,
  Db extends NotionImportServerRunnerDb,
  Storage extends NotionImportServerRunnerStorage,
  DiscoverResult extends NotionImportRunnerResult<ResultJob>,
  PlanResult extends NotionImportRunnerResult<ResultJob>,
  ApplyResult extends NotionImportRunnerResult<ResultJob>,
> {
  optionalString(value: unknown): string | undefined;
  asRecord(value: unknown): Record<string, unknown> | undefined;
  updateNotionJobIfStatus(
    db: Db,
    jobId: string,
    expectedStatus: NotionImportServerRunnerStatus,
    data: Partial<NotionImportServerRunnerJob>,
  ): Promise<Job | null>;
  withImportProgress(
    previousProgress: Record<string, unknown> | undefined,
    event: NotionImportServerRunnerProgressEvent,
  ): Record<string, unknown>;
  notionTokenForJob(
    db: Db,
    body: Record<string, unknown>,
    job: Job,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ): Promise<unknown>;
  discoverJob(
    db: Db,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ): Promise<DiscoverResult>;
  planJob(
    db: Db,
    body: Record<string, unknown>,
    actorId: string,
  ): Promise<PlanResult>;
  applyJob(
    db: Db,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    storage?: Storage,
    request?: Request,
    env?: Record<string, unknown>,
  ): Promise<ApplyResult>;
}

export function createNotionImportServerRunner<
  Job extends NotionImportServerRunnerJob,
  ResultJob extends Job,
  Db extends NotionImportServerRunnerDb,
  Storage extends NotionImportServerRunnerStorage,
  DiscoverResult extends NotionImportRunnerResult<ResultJob>,
  PlanResult extends NotionImportRunnerResult<ResultJob>,
  ApplyResult extends NotionImportRunnerResult<ResultJob>,
>(runtime: NotionImportServerRunnerRuntime<
  Job,
  ResultJob,
  Db,
  Storage,
  DiscoverResult,
  PlanResult,
  ApplyResult
>) {
  const {
    optionalString,
    asRecord,
    updateNotionJobIfStatus,
    withImportProgress,
    notionTokenForJob,
    discoverJob,
    planJob,
    applyJob,
  } = runtime;
  type NotionImportJob = Job;
  type DbRef = Db;
  type FunctionStorageProxy = Storage;

const SERVER_NOTION_APPLY_PREPARE_BATCH_SIZE = 25;
const SERVER_NOTION_APPLY_DATA_SOURCE_BATCH_SIZE = 5;
const SERVER_NOTION_APPLY_DATABASE_BATCH_SIZE = 25;
const SERVER_NOTION_APPLY_FILE_BATCH_SIZE = 10;
const SERVER_NOTION_APPLY_PAGE_BATCH_SIZE = 20;
const SERVER_NOTION_APPLY_REMAP_BATCH_SIZE = 20;

function isServerOwnedNotionImportJob(job: NotionImportJob) {
  return optionalString((job.options as { runnerMode?: unknown } | undefined)?.runnerMode) === 'server';
}

function serverOwnedNotionErrorCode(error: unknown) {
  const record = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown; notionImportRecoveryPending?: unknown }
    : undefined;
  const status = Number(record?.status ?? record?.code);
  const message = error instanceof Error ? error.message : '';
  if (/connection.+not active|connection was not found|stored connection/i.test(message)) {
    return 'connection_inactive';
  }
  if (/access required|outside the workspace|belongs to another workspace/i.test(message)) {
    return 'authority_revoked';
  }
  if (/found no items/i.test(message)) return 'no_importable_items';
  if (status === 409 || /already being (?:applied|discovered)|lease|expectation failed/i.test(message)) {
    return 'lease_conflict';
  }
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'upstream_unavailable';
  if (record?.notionImportRecoveryPending === true) return 'file_recovery_pending';
  return 'chunk_failed';
}

function serverOwnedNotionErrorIsRetryable(error: unknown) {
  const code = serverOwnedNotionErrorCode(error);
  return code === 'lease_conflict'
    || code === 'rate_limited'
    || code === 'upstream_unavailable'
    || code === 'file_recovery_pending';
}

function serverOwnedNotionRetryAt(job: NotionImportJob, fallbackMs: number) {
  const cursor = asRecord(asRecord(job.progress)?.applyCursor)
    ?? asRecord(asRecord(job.report)?.applyCursor);
  const retryAfterAt = optionalString(cursor?.retryAfterAt);
  const parsed = retryAfterAt ? Date.parse(retryAfterAt) : Number.NaN;
  return Number.isFinite(parsed) && parsed > fallbackMs ? parsed : fallbackMs;
}

function serverOwnedNotionSafeFailure(errorCode: string) {
  if (errorCode === 'connection_inactive') {
    return 'The saved Notion connection is no longer active.';
  }
  if (errorCode === 'authority_revoked') {
    return 'Permission to continue this Notion import is no longer available.';
  }
  if (errorCode === 'no_importable_items') {
    return 'Notion import found no items. Share pages with the saved connection and retry.';
  }
  return 'The background Notion import could not continue.';
}

async function failServerOwnedNotionImport(
  db: DbRef,
  job: NotionImportJob,
  errorCode: string,
) {
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
  const failedAt = nowIso();
  const message = serverOwnedNotionSafeFailure(errorCode);
  const currentStep = optionalString(asRecord(job.progress)?.currentStep);
  const key: NotionImportProgressStepKey = currentStep === 'apply' ? 'apply' : 'discover';
  const failed = await updateNotionJobIfStatus(db, job.id, job.status, {
    status: 'failed',
    phase: 'server_runner_failed',
    error: message,
    progress: {
      ...withImportProgress(job.progress, {
        key,
        status: 'failed',
        legacyStep: 'server_runner_failed',
        message,
        at: failedAt,
      }),
    },
    report: {
      ...(job.report ?? {}),
      lastError: message,
      serverRunnerErrorCode: errorCode,
    },
    finishedAt: failedAt,
  });
  if (!failed) return await getExisting(db.table<NotionImportJob>('notion_import_jobs'), job.id) ?? job;
  await recordWorkspaceAudit(db, {
    workspaceId: job.workspaceId,
    actorId: job.actorId ?? 'system:notion-import-worker',
    action: 'notion_import.server_runner_failed',
    targetType: 'notion_import_job',
    targetId: job.id,
    metadata: { errorCode },
    occurredAt: failedAt,
  }).catch(() => {});
  return failed;
}

async function runServerOwnedNotionImportChunk(input: {
  admin: AdminDbAccessor;
  lease: NotionImportRunQueueLease;
  storage?: FunctionStorageProxy;
  env?: Record<string, unknown>;
}): Promise<NotionImportRunChunkOutcome> {
  const { admin, lease, storage, env } = input;
  const db = boundedDbFromWorkspaceHint(admin, lease.workspaceId) as DbRef;
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, lease.jobId);
  if (!job) {
    const createdAtMs = Date.parse(lease.createdAt ?? '');
    const oldEnoughToRetire = Number.isFinite(createdAtMs)
      && Date.now() - createdAtMs >= NOTION_IMPORT_RUN_ORPHAN_RETENTION_MS;
    return oldEnoughToRetire
      ? { action: 'terminal', errorCode: 'orphan_queue_record' }
      : {
          action: 'continue',
          notBeforeMs: Date.now() + NOTION_IMPORT_RUN_ORPHAN_RECHECK_MS,
          errorCode: 'job_not_visible',
          missingJob: true,
        };
  }
  if (
    job.workspaceId !== lease.workspaceId
    || job.actorId !== lease.actorId
    || !isServerOwnedNotionImportJob(job)
  ) {
    return { action: 'terminal', errorCode: 'queue_job_identity_mismatch' };
  }
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return { action: 'terminal' };
  }
  const connectionId = optionalString(job.connectionId)
    ?? optionalString((job.options as { connectionId?: unknown } | undefined)?.connectionId);
  if (!connectionId) {
    await failServerOwnedNotionImport(db, job, 'connection_inactive');
    return { action: 'terminal', errorCode: 'connection_inactive' };
  }

  try {
    if (job.status === 'queued' || job.status === 'discovering') {
      const result = await discoverJob(db, {
        jobId: job.id,
        connectionId,
        continueFromCursor: job.status === 'discovering',
        incremental: true,
        compact: true,
      }, lease.actorId, env);
      if (
        result.job.status === 'completed'
        || result.job.status === 'failed'
        || result.job.status === 'cancelled'
      ) return { action: 'terminal' };
      return { action: 'continue' };
    }

    // Plan does not call Notion, but it is still its own authority boundary:
    // freshly decrypt/validate the saved connection before materializing the
    // graph so revocation never skips a chunk merely because it is read-only.
    const report = asRecord(job.report);
    if (!asRecord(report?.plan)) {
      await notionTokenForJob(db, { connectionId }, job, lease.actorId, env);
      const planned = await planJob(db, { jobId: job.id }, lease.actorId);
      if (planned.job.status === 'failed' || planned.job.status === 'cancelled') {
        return { action: 'terminal' };
      }
      return { action: 'continue' };
    }

    const result = await applyJob(db, admin, {
      jobId: job.id,
      connectionId,
      compact: true,
      applyPrepareBatchSize: SERVER_NOTION_APPLY_PREPARE_BATCH_SIZE,
      applyDataSourceBatchSize: SERVER_NOTION_APPLY_DATA_SOURCE_BATCH_SIZE,
      applyDatabaseBatchSize: SERVER_NOTION_APPLY_DATABASE_BATCH_SIZE,
      applyFileBatchSize: SERVER_NOTION_APPLY_FILE_BATCH_SIZE,
      applyPageBatchSize: SERVER_NOTION_APPLY_PAGE_BATCH_SIZE,
      applyRemapBatchSize: SERVER_NOTION_APPLY_REMAP_BATCH_SIZE,
    }, lease.actorId, storage, undefined, env);
    if (
      result.job.status === 'completed'
      || result.job.status === 'failed'
      || result.job.status === 'cancelled'
    ) return { action: 'terminal' };
    return {
      action: 'continue',
      notBeforeMs: serverOwnedNotionRetryAt(result.job, Date.now()),
    };
  } catch (error) {
    const latest = await getExisting(jobs, job.id);
    if (!latest) throw error;
    if (latest.status === 'completed' || latest.status === 'failed' || latest.status === 'cancelled') {
      return { action: 'terminal', errorCode: serverOwnedNotionErrorCode(error) };
    }
    const errorCode = serverOwnedNotionErrorCode(error);
    if (serverOwnedNotionErrorIsRetryable(error)) {
      return {
        action: 'continue',
        notBeforeMs: serverOwnedNotionRetryAt(latest, Date.now() + 2_000),
        errorCode,
      };
    }
    await failServerOwnedNotionImport(db, latest, errorCode);
    return { action: 'terminal', errorCode };
  }
}
  return {
    runServerOwnedNotionImportChunk,
  };
}
