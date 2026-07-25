import {
  type AdminDbAccessor,
  ensurePageWorkspaceIndex,
} from './workspace-db';
import {
  recordWorkspaceAudit,
} from './org-audit';
import {
  bestEffort,
  getExisting,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
  nowIso,
} from './table-utils';

export interface NotionImportJobApplyJob {
  id: string;
  workspaceId: string;
  status: string;
}

interface NotionImportJobApplyTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportJobApplyDb extends TransactDb {
  table<T>(name: string): NotionImportJobApplyTable<T>;
}

interface NotionImportApplyFailureMutation<Job> {
  message: string;
  failedJob: Job;
  operation: TransactOperation;
}

interface NotionImportApplyCleanupCollector {
  collect(operation: TransactOperation): Promise<void>;
  flush(): Promise<void>;
}

export interface NotionImportJobApplyRuntime<
  Job extends NotionImportJobApplyJob,
  Item,
  Db extends NotionImportJobApplyDb,
  Storage,
  ApplyResult,
> {
  requireString(value: unknown, name: string): string;
  assertWritableJob(db: Db, job: Job, actorId: string): Promise<void>;
  acquireNotionApplyLease(
    db: Db,
    job: Job,
    actorId: string,
  ): Promise<{ id: string; leaseId: string }>;
  applyJobCore(
    db: Db,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    storage: Storage | undefined,
    request: Request | undefined,
    env: Record<string, unknown> | undefined,
    lease: { id: string; leaseId: string },
    createdUploadIds: string[],
  ): Promise<ApplyResult>;
  clearNotionImportApplySnapshotCache(jobId: string): void;
  isRetryableNotionTemplateCleanupError(error: unknown): boolean;
  recoverNotionApplyFailureCleanupAuthority(
    db: Db,
    job: Job,
    lease: { id: string; leaseId: string },
    actorId: string,
  ): Promise<boolean>;
  createNotionApplyFailureCleanupMutationCollector(
    db: Db,
    job: Job,
    lease: { id: string; leaseId: string },
    actorId: string,
  ): NotionImportApplyCleanupCollector;
  scrubMappedImportProductCredentials(
    db: Db,
    jobId: string,
    collectMutation: (operation: TransactOperation) => Promise<void>,
  ): Promise<void>;
  listActiveNotionImportItems(db: Db, job: Job): Promise<Item[]>;
  scrubAppliedImportCredentialMetadata(
    db: Db,
    items: Item[],
    collectMutation: (operation: TransactOperation) => Promise<void>,
  ): Promise<void>;
  applyJobFailureMutation(
    job: Job,
    error: unknown,
  ): NotionImportApplyFailureMutation<Job>;
  trashIncompleteImportPages(
    db: Db,
    job: Job,
    mappings: undefined,
    options: { includeCheckpointOwners: false },
  ): Promise<number>;
  releaseNotionApplyLease(
    db: Db,
    lease: { id: string; leaseId: string },
  ): Promise<void>;
}

export function createNotionImportJobApplyHandlers<
  Job extends NotionImportJobApplyJob,
  Item,
  Db extends NotionImportJobApplyDb,
  Storage,
  ApplyResult,
>(runtime: NotionImportJobApplyRuntime<Job, Item, Db, Storage, ApplyResult>) {
  const {
    requireString,
    assertWritableJob,
    acquireNotionApplyLease,
    applyJobCore,
    clearNotionImportApplySnapshotCache,
    isRetryableNotionTemplateCleanupError,
    recoverNotionApplyFailureCleanupAuthority,
    createNotionApplyFailureCleanupMutationCollector,
    scrubMappedImportProductCredentials,
    listActiveNotionImportItems,
    scrubAppliedImportCredentialMetadata,
    applyJobFailureMutation,
    trashIncompleteImportPages,
    releaseNotionApplyLease,
  } = runtime;
  type NotionImportJob = Job;
  type DbRef = Db;
  type FunctionStorageProxy = Storage;

  async function applyJob(
    db: DbRef,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    storage?: FunctionStorageProxy,
    request?: Request,
    env?: Record<string, unknown>,
  ) {
    // Authorize BEFORE arming the failure marker: failure cleanup does no role
    // check, so an unauthorized caller's 403 must not flip a ready job to
    // `failed` (that would let any authenticated stranger who learns a job id
    // sabotage another workspace's import).
    const jobId = requireString(body.jobId, 'jobId');
    const jobs = db.table<NotionImportJob>('notion_import_jobs');
    const job = await getExisting(jobs, jobId);
    if (!job) throw new Error('Notion import job was not found.');
    await assertWritableJob(db, job, actorId);
    const lease = await acquireNotionApplyLease(db, job, actorId);
    const createdUploadIds: string[] = [];
    try {
      return await applyJobCore(db, admin, body, actorId, storage, request, env, lease, createdUploadIds);
    } catch (error) {
      clearNotionImportApplySnapshotCache(job.id);
      const recoveryCanRetryInPlace = isRetryableNotionTemplateCleanupError(error)
        && createdUploadIds.length === 0;
      if (!recoveryCanRetryInPlace) {
        // A transient renewal failure is not proof that this worker lost its
        // lease. Retry only within a short declared bound, then require a fresh
        // exact, unexpired, non-stale apply-lock row before any job or product
        // cleanup write. Cancellation and a newer owner retain their own
        // terminal/retry lanes; this uncertain worker never publishes a marker
        // on their behalf.
        const cleanupAuthorized = await recoverNotionApplyFailureCleanupAuthority(
          db,
          job,
          lease,
          actorId,
        );
        const cleanupJob = cleanupAuthorized
          ? await getExisting(jobs, job.id).catch(() => null)
          : null;
        if (!cleanupAuthorized || cleanupJob?.status !== 'ready') {
          console.warn(
            `[notion-import] deferred unproved apply cleanup to an authorized follow-up for ${job.id}`,
          );
          throw error;
        }
        // No failed apply may leave temporary Notion/AWS bearer URLs in staging
        // or product owners. Keep that security boundary synchronous, but never
        // scan every file owner or retire every copied object in this request.
        // Every bounded mutation chunk obtains a new exact lock observation and
        // atomically fences that observation, the ready job snapshot, its lease
        // heartbeat, and the mutations. A response-lost chunk is therefore safe
        // to replay and a takeover between proof and commit produces no writes.
        let failedJob: NotionImportJob;
        let failureMessage: string;
        try {
          const cleanupMutations = createNotionApplyFailureCleanupMutationCollector(
            db,
            cleanupJob,
            lease,
            actorId,
          );
          await scrubMappedImportProductCredentials(
            db,
            job.id,
            cleanupMutations.collect,
          );
          const stagedItems = await listActiveNotionImportItems(db, cleanupJob);
          await scrubAppliedImportCredentialMetadata(
            db,
            stagedItems,
            cleanupMutations.collect,
          );
          // Publish the indexed durable continuation in the same bounded stream
          // as the final scrub mutations, rather than opening an unfenced job
          // write after cleanup authority was last observed.
          const failure = applyJobFailureMutation(cleanupJob, error);
          await cleanupMutations.collect(failure.operation);
          await cleanupMutations.flush();
          failedJob = failure.failedJob;
          failureMessage = failure.message;
        } catch {
          console.warn(
            `[notion-import] deferred interrupted apply cleanup to an authorized follow-up for ${job.id}`,
          );
          throw error;
        }
        await recordWorkspaceAudit(db, {
          workspaceId: failedJob.workspaceId,
          actorId,
          action: 'notion_import.apply_failed',
          targetType: 'notion_import_job',
          targetId: failedJob.id,
          metadata: { message: failureMessage },
        }).catch(() => {});
        if (failedJob) {
          await bestEffort(
            'notion-import trash incomplete product pages',
            trashIncompleteImportPages(db, failedJob, undefined, {
              includeCheckpointOwners: false,
            }),
          );
        }
      }
      throw error;
    } finally {
      await bestEffort('notion-import release apply lease', releaseNotionApplyLease(db, lease));
    }
  }

  return { applyJob };
}

type NotionImportJobRepairStatus =
  | 'queued'
  | 'discovering'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NotionImportJobRepairJob {
  id: string;
  workspaceId: string;
  status: NotionImportJobRepairStatus;
  apiVersion: string;
  itemSnapshotRevision?: string | null;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
}

export interface NotionImportJobRepairItem {
  notionId: string;
  notionObject: string;
  metadata?: Record<string, unknown>;
}

export interface NotionImportJobRepairMapping {
  jobId: string;
  notionId: string;
  relationKind: string;
  localId: string;
  localType: string;
}

export interface NotionImportJobRepairPage {
  id: string;
  workspaceId: string;
}

interface NotionImportJobRepairTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportJobRepairDb extends TransactDb {
  table<T>(name: string): NotionImportJobRepairTable<T>;
}

interface FileCopyRetryProgressEvent {
  key: 'file_copy_retry';
  status: 'completed';
  legacyStep: string;
  percent: number;
  at: string;
  counts: Record<string, unknown>;
}

export interface NotionImportJobRepairRuntime<
  Job extends NotionImportJobRepairJob,
  Item extends NotionImportJobRepairItem,
  Mapping extends NotionImportJobRepairMapping,
  Page extends NotionImportJobRepairPage,
  ImportedBlockMapping,
  Db extends NotionImportJobRepairDb,
  FileCopyContext extends object,
  ConversionReport,
  FinalizedConversionReport,
  CleanJob,
> {
  notionApiVersion: string;
  notionImportItemSafetyLimit: number;
  assertNotionFileCopyNotDisabled(body?: Record<string, unknown>): void;
  requireString(value: unknown, name: string): string;
  assertWritableJob(db: Db, job: Job, actorId: string): Promise<void>;
  loadMappings(db: Db, jobId: string): Promise<Map<string, Mapping>>;
  emptyConversionReport(): ConversionReport;
  notionTokenForJob(
    db: Db,
    body: Record<string, unknown>,
    job: Job,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ): Promise<{ token: string }>;
  notionApiBase(env: Record<string, unknown> | undefined): string | undefined;
  retryImportedPageFileCopies(context: FileCopyContext, page: Page): Promise<number>;
  finalizeConversionReport(report: ConversionReport): FinalizedConversionReport;
  withImportProgress(
    previousProgress: Record<string, unknown> | undefined,
    event: FileCopyRetryProgressEvent,
  ): Record<string, unknown>;
  cleanJob(job: Job): CleanJob;
  optionalString(value: unknown): string | undefined;
  acquireNotionApplyLease(
    db: Db,
    job: Job,
    actorId: string,
  ): Promise<{ id: string; leaseId: string }>;
  parsePositiveInt(value: unknown, fallback: number, max: number): number;
  parseBoolean(value: unknown, fallback: boolean): boolean;
  listActiveNotionImportItems(db: Db, job: Job): Promise<Item[]>;
  assertSafeNotionImportSourceReferences(db: Db, value: unknown): Promise<void>;
  itemHasImportablePageBody(item: Item): boolean;
  importedBlocksComplete(page: Page): boolean;
  importedBlockBoundaryRepairComplete(page: Page): boolean;
  replaceImportedBlocksForPage(
    db: Db,
    page: Page,
    item: Item,
    actorId: string,
    mappingsByNotionId: Map<string, Mapping>,
    conversionReport: ConversionReport,
    fileCopyContext: FileCopyContext,
    importedBlockMappingsByNotionId: Map<string, ImportedBlockMapping>,
    itemsByNotionId?: Map<string, Item>,
  ): Promise<{ insertedBlocks: unknown[] }>;
  addImportedLinkedDatabaseRowContextFilters(
    context: FileCopyContext,
    pages: Array<{ page: Page; notionId: string }>,
    conversionReport?: ConversionReport,
  ): Promise<{ updatedViews: number }>;
  releaseNotionApplyLease(
    db: Db,
    lease: { id: string; leaseId: string },
  ): Promise<void>;
  assertWorkspaceRole(
    db: Db,
    workspaceId: string,
    actorId: string,
    minimum: 'edit',
  ): Promise<void>;
  listAll<T>(query: TableQuery<T>, maxItems?: number): Promise<T[]>;
  unwrapImportRoot(
    db: Db,
    admin: AdminDbAccessor,
    job: Job,
    mappingsByNotionId: Map<string, Mapping>,
    applyLease: undefined,
    expectedJobStatus: 'completed',
  ): Promise<{ unwrapped: number; moved: number }>;
  trashIncompleteImportPages(
    db: Db,
    job: Job,
    mappings: Mapping[],
  ): Promise<number>;
}

export function createNotionImportJobRepairHandlers<
  Job extends NotionImportJobRepairJob,
  Item extends NotionImportJobRepairItem,
  Mapping extends NotionImportJobRepairMapping,
  Page extends NotionImportJobRepairPage,
  ImportedBlockMapping,
  Db extends NotionImportJobRepairDb,
  Storage,
  FileCopyContext extends object,
  ConversionReport,
  FinalizedConversionReport,
  CleanJob,
>(runtime: NotionImportJobRepairRuntime<
  Job,
  Item,
  Mapping,
  Page,
  ImportedBlockMapping,
  Db,
  FileCopyContext,
  ConversionReport,
  FinalizedConversionReport,
  CleanJob
>) {
  const {
    notionApiVersion: NOTION_API_VERSION,
    notionImportItemSafetyLimit: NOTION_IMPORT_ITEM_SAFETY_LIMIT,
    assertNotionFileCopyNotDisabled,
    requireString,
    assertWritableJob,
    loadMappings,
    emptyConversionReport,
    notionTokenForJob,
    notionApiBase,
    retryImportedPageFileCopies,
    finalizeConversionReport,
    withImportProgress,
    cleanJob,
    optionalString,
    acquireNotionApplyLease,
    parsePositiveInt,
    parseBoolean,
    listActiveNotionImportItems,
    assertSafeNotionImportSourceReferences,
    itemHasImportablePageBody,
    importedBlocksComplete,
    importedBlockBoundaryRepairComplete,
    replaceImportedBlocksForPage,
    addImportedLinkedDatabaseRowContextFilters,
    releaseNotionApplyLease,
    assertWorkspaceRole,
    listAll,
    unwrapImportRoot,
    trashIncompleteImportPages,
  } = runtime;
  type NotionImportJob = Job;
  type NotionImportMapping = Mapping;
  type DbRef = Db;
  type FunctionStorageProxy = Storage;
  type NotionFileCopyContext = FileCopyContext;

  async function retryFileCopies(
    db: DbRef,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    storage?: FunctionStorageProxy,
    request?: Request,
    env?: Record<string, unknown>,
  ) {
    assertNotionFileCopyNotDisabled(body);
    const jobId = requireString(body.jobId, 'jobId');
    const jobs = db.table<NotionImportJob>('notion_import_jobs');
    const job = await getExisting(jobs, jobId);
    if (!job) throw new Error('Notion import job was not found.');
    await assertWritableJob(db, job, actorId);
    if (job.status !== 'completed') {
      throw new Error('Notion import job must be completed before retrying file copies.');
    }

    const mappings = await loadMappings(db, job.id);
    const localPageIds = new Set(
      Array.from(mappings.values())
        .filter((mapping) => mapping.localType === 'page')
        .map((mapping) => mapping.localId),
    );
    const report = emptyConversionReport();
    const stats = {
      fileCopies: 0,
      fileCopySkipped: 0,
    };
    const tokenSource = await notionTokenForJob(db, body, job, actorId, env).catch(() => undefined);
    const context = {
      db,
      admin,
      job,
      actorId,
      storage,
      request,
      conversionReport: report,
      requireStoredFileCopies: true,
      notionToken: tokenSource?.token,
      apiVersion: job.apiVersion || NOTION_API_VERSION,
      apiBase: notionApiBase(env),
      stats,
    } as unknown as NotionFileCopyContext;

    let scanned = 0;
    for (const pageId of localPageIds) {
      const page = await getExisting(db.table<Page>('pages'), pageId);
      if (!page || page.workspaceId !== job.workspaceId) continue;
      scanned += await retryImportedPageFileCopies(context, page);
    }

    const finishedAt = nowIso();
    const fileRetry = {
      generatedAt: finishedAt,
      scanned,
      copied: stats.fileCopies,
      skipped: stats.fileCopySkipped,
      conversion: finalizeConversionReport(report),
    };
    const updated = await jobs.update(job.id, {
      progress: {
        ...withImportProgress(job.progress, {
          key: 'file_copy_retry',
          status: 'completed',
          legacyStep: 'file_copy_retry_complete',
          percent: 100,
          at: finishedAt,
          counts: {
            scanned,
            copied: stats.fileCopies,
            skipped: stats.fileCopySkipped,
          },
        }),
        step: 'file_copy_retry_complete',
        fileRetry,
      },
      report: {
        ...(job.report ?? {}),
        fileRetry,
      },
    } as unknown as Partial<NotionImportJob>);

    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.retry_file_copies',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: fileRetry,
      occurredAt: finishedAt,
    });

    return {
      job: cleanJob(updated),
      fileRetry,
    };
  }

  async function repairImportedPageBlocks(
    db: DbRef,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    storage?: FunctionStorageProxy,
    request?: Request,
    env?: Record<string, unknown>,
  ) {
    assertNotionFileCopyNotDisabled(body);
    const jobId = requireString(body.jobId, 'jobId');
    const jobs = db.table<NotionImportJob>('notion_import_jobs');
    const job = await getExisting(jobs, jobId);
    if (!job) throw new Error('Notion import job was not found.');
    await assertWritableJob(db, job, actorId);
    const itemSnapshotRevision = optionalString(job.itemSnapshotRevision);
    if (!itemSnapshotRevision) {
      throw Object.assign(new Error('Notion import repair requires an immutable item snapshot revision.'), { code: 409 });
    }
    const repairLease = await acquireNotionApplyLease(db, job, actorId);
    try {

    const localPageId = optionalString(body.localPageId) ?? optionalString(body.pageId);
    const notionPageId = optionalString(body.notionPageId);
    const startAfterNotionPageId = optionalString(body.startAfterNotionPageId) ?? optionalString(body.afterNotionPageId);
    const startAfterLocalPageId = optionalString(body.startAfterLocalPageId) ?? optionalString(body.afterLocalPageId);
    const useStartCursor = !localPageId && !notionPageId && (!!startAfterNotionPageId || !!startAfterLocalPageId);
    const maxPages = parsePositiveInt(body.maxPages, localPageId || notionPageId ? 1 : 25, 250);
    const force = parseBoolean(body.force, !!(localPageId || notionPageId));
    const items = await listActiveNotionImportItems(db, job);
    if (items.length === 0) {
      // A discovery that legitimately found nothing (nothing shared with the
      // integration, or the Notion search was rate-limited into an empty result)
      // is a user-actionable state, not a server fault — surface a clean 422.
      throw new Error(
        'Notion import found no items. Share pages with the integration, or wait a ' +
          'few minutes if the Notion API rate-limited discovery, then run discovery again.',
      );
    }
    await assertSafeNotionImportSourceReferences(
      db,
      items.map((item) => item.metadata),
    );

    const mappingsByNotionId = await loadMappings(db, job.id);
    const itemsByNotionId = new Map(items.map((item) => [item.notionId, item]));
    const conversionReport = emptyConversionReport();
    const repaired = {
      pages: 0,
      blocks: 0,
      fileCopies: 0,
      fileCopySkipped: 0,
      linkedDatabaseContextFilters: 0,
      skippedAlreadyRepaired: 0,
      scannedPages: 0,
    };
    const tokenSource = await notionTokenForJob(db, body, job, actorId, env).catch(() => undefined);
    const fileCopyContext = {
      db,
      admin,
      job,
      actorId,
      storage,
      request,
      conversionReport,
      requireStoredFileCopies: true,
      notionToken: tokenSource?.token,
      apiVersion: job.apiVersion || NOTION_API_VERSION,
      apiBase: notionApiBase(env),
      stats: repaired,
      itemSnapshotRevision,
      applyLease: repairLease,
    } as unknown as NotionFileCopyContext;
    const importedBlockMappingsByNotionId = new Map<string, ImportedBlockMapping>();
    const importedPageBlockContexts: Array<{ page: Page; notionId: string }> = [];
    let startCursorSeen = !useStartCursor;
    let hasMore = false;
    let lastRepairedNotionPageId: string | undefined;
    let lastRepairedLocalPageId: string | undefined;

    for (const item of items) {
      if (item.notionObject !== 'page') continue;
      if (notionPageId && item.notionId !== notionPageId) continue;
      if (!itemHasImportablePageBody(item)) continue;
      const mapping = mappingsByNotionId.get(item.notionId);
      if (!mapping || mapping.localType !== 'page') continue;
      if (localPageId && mapping.localId !== localPageId) continue;
      if (!startCursorSeen) {
        if (
          (startAfterNotionPageId && item.notionId === startAfterNotionPageId) ||
          (startAfterLocalPageId && mapping.localId === startAfterLocalPageId)
        ) {
          startCursorSeen = true;
        }
        continue;
      }
      const page = await getExisting(db.table<Page>('pages'), mapping.localId);
      if (!page) continue;
      importedPageBlockContexts.push({ page, notionId: item.notionId });
      repaired.scannedPages += 1;
      const alreadyCurrent = importedBlocksComplete(page) && importedBlockBoundaryRepairComplete(page);
      if (alreadyCurrent) {
        if (!force) {
          repaired.skippedAlreadyRepaired += 1;
          continue;
        }
        // `force` is also used as a resumable verification pass. Rebuilding a
        // graph already stamped with the current boundary version would duplicate
        // every stored file before the replacement can be swapped atomically.
        // Count the page/cursor as handled while leaving its proven graph intact.
        if (repaired.pages >= maxPages) {
          hasMore = true;
          break;
        }
        repaired.pages += 1;
        repaired.skippedAlreadyRepaired += 1;
        lastRepairedNotionPageId = item.notionId;
        lastRepairedLocalPageId = mapping.localId;
        continue;
      }
      if (repaired.pages >= maxPages) {
        hasMore = true;
        break;
      }

      const replaced = await replaceImportedBlocksForPage(
        db,
        page,
        item,
        actorId,
        mappingsByNotionId,
        conversionReport,
        fileCopyContext,
        importedBlockMappingsByNotionId,
        itemsByNotionId,
      );
      repaired.pages += 1;
      repaired.blocks += replaced.insertedBlocks.length;
      lastRepairedNotionPageId = item.notionId;
      lastRepairedLocalPageId = mapping.localId;
    }

    const linkedDatabaseContextFilterRemap = await addImportedLinkedDatabaseRowContextFilters(
      { ...fileCopyContext, itemSnapshotRevision, applyLease: repairLease },
      importedPageBlockContexts,
      conversionReport,
    );
    repaired.linkedDatabaseContextFilters = linkedDatabaseContextFilterRemap.updatedViews;

    return {
      job: cleanJob(job),
      repaired,
      partial: hasMore,
      lastRepaired: lastRepairedNotionPageId || lastRepairedLocalPageId
        ? {
            notionPageId: lastRepairedNotionPageId,
            localPageId: lastRepairedLocalPageId,
          }
        : null,
      nextCursor: hasMore && (lastRepairedNotionPageId || lastRepairedLocalPageId)
        ? {
            startAfterNotionPageId: lastRepairedNotionPageId,
            startAfterLocalPageId: lastRepairedLocalPageId,
          }
        : null,
      report: conversionReport,
    };
    } finally {
      await bestEffort('notion-import release repair apply lease', releaseNotionApplyLease(db, repairLease));
    }
  }

  // Recovery for imports created before per-page index writes (or interrupted
  // mid-apply): re-derives the central page_workspace_index from this workspace's
  // import mappings so orphaned imported pages become openable by /p/:id again.
  // Idempotent — ensurePageWorkspaceIndex no-ops when the row already matches.
  async function repairImportPageIndexes(
    db: DbRef,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
  ) {
    const workspaceId = requireString(body.workspaceId, 'workspaceId');
    await assertWorkspaceRole(db, workspaceId, actorId, 'edit');
    const mappings = await listAll(
      db.table<NotionImportMapping>('notion_import_mappings').where('workspaceId', '==', workspaceId),
      NOTION_IMPORT_ITEM_SAFETY_LIMIT,
    );
    const jobs = await listAll(
      db.table<NotionImportJob>('notion_import_jobs').where('workspaceId', '==', workspaceId),
      500,
    );
    const mappingsByJob = new Map<string, NotionImportMapping[]>();
    for (const mapping of mappings) {
      const group = mappingsByJob.get(mapping.jobId) ?? [];
      group.push(mapping);
      mappingsByJob.set(mapping.jobId, group);
    }
    let unwrapped = 0;
    let moved = 0;
    let trashed = 0;
    for (const job of jobs) {
      const jobMappings = mappingsByJob.get(job.id) ?? [];
      if (!jobMappings.some((mapping) => mapping.relationKind === 'import_root')) continue;
      if (job.status === 'completed') {
        const byNotionId = new Map(jobMappings.map((mapping) => [mapping.notionId, mapping]));
        const result = await unwrapImportRoot(db, admin, job, byNotionId, undefined, 'completed');
        unwrapped += result.unwrapped;
        moved += result.moved;
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        trashed += await trashIncompleteImportPages(db, job, jobMappings);
      }
    }
    const seen = new Set<string>();
    let repaired = 0;
    for (const mapping of mappings) {
      if (
        mapping.relationKind !== 'import_root' &&
        (mapping.localType === 'page' || mapping.localType === 'database') &&
        typeof mapping.localId === 'string' &&
        mapping.localId.length > 0 &&
        !seen.has(mapping.localId)
      ) {
        seen.add(mapping.localId);
        await ensurePageWorkspaceIndex(admin, mapping.localId, workspaceId);
        repaired += 1;
      }
    }
    return { repaired, unwrapped, moved, trashed };
  }

  return {
    retryFileCopies,
    repairImportedPageBlocks,
    repairImportPageIndexes,
  };
}
