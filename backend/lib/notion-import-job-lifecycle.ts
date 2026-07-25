import {
  nowIso,
  type TableQuery,
  getExisting,
  bestEffort,
  newId,
  type TransactDb,
  type TransactOperation,
  projectFields,
} from './table-utils';
import {
  type NotionImportItem,
  type NotionImportJob,
} from './notion-import-contracts';
import {
  type AdminDbAccessor,
  MAX_RAW_TRANSACT_OPS,
} from './workspace-db';
import {
  recordWorkspaceAudit,
} from './org-audit';

export type NotionImportProgressStepKey = 'connect' | 'discover' | 'review' | 'apply' | 'file_copy_retry' | 'cancel';
export type NotionImportProgressStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface NotionImportProgressEvent {
  key: NotionImportProgressStepKey;
  status: NotionImportProgressStatus;
  legacyStep: string;
  at?: string;
  percent?: number;
  message?: string;
  counts?: Record<string, unknown>;
}

export const importProgressOrder: NotionImportProgressStepKey[] = ['connect', 'discover', 'review', 'apply', 'file_copy_retry', 'cancel'];

export const importProgressLabels: Record<NotionImportProgressStepKey, string> = {
  connect: 'Waiting for Notion connection',
  discover: 'Discovering workspace graph',
  review: 'Reviewing import plan',
  apply: 'Applying to local workspace',
  file_copy_retry: 'Retrying file copies',
  cancel: 'Cancelled',
};

export function progressObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
}

export function progressSteps(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
}

export function progressPercent(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;
}

export function progressCounts(counts: Record<string, unknown> | undefined) {
  if (!counts) return undefined;
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = value;
  }
  return Object.keys(next).length ? next : undefined;
}

export function defaultProgressPercent(
  previous: Record<string, unknown>,
  event: NotionImportProgressEvent,
) {
  if (event.percent !== undefined) return progressPercent(event.percent);
  if (event.status === 'failed' || event.status === 'cancelled') return progressPercent(previous.percent) ?? 100;
  if (event.key === 'connect') return event.status === 'completed' ? 10 : 5;
  if (event.key === 'discover') return event.status === 'completed' ? 50 : 25;
  if (event.key === 'review') return event.status === 'completed' ? 60 : 55;
  if (event.key === 'apply') return event.status === 'completed' ? 100 : 75;
  if (event.key === 'file_copy_retry') return event.status === 'completed' ? 100 : 90;
  return progressPercent(previous.percent) ?? 0;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function withImportProgress(
  previousProgress: Record<string, unknown> | undefined,
  event: NotionImportProgressEvent,
) {
  const previous = progressObject(previousProgress);
  const at = event.at ?? nowIso();
  const existingSteps = progressSteps(previous.steps);
  const byKey = new Map<string, Record<string, unknown>>();
  for (const step of existingSteps) {
    const key = typeof step.key === 'string' ? step.key : undefined;
    if (key) byKey.set(key, step);
  }
  const existing = byKey.get(event.key) ?? {};
  const counts = progressCounts(event.counts);
  const isTerminal = event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled';
  byKey.set(event.key, {
    ...existing,
    key: event.key,
    label: importProgressLabels[event.key],
    status: event.status,
    startedAt: event.status === 'running' ? optionalString(existing.startedAt) ?? at : optionalString(existing.startedAt) ?? at,
    // A resumed step is live again. Do not retain an older terminal timestamp:
    // the run panel otherwise renders a still-running discovery as finished.
    finishedAt: isTerminal ? at : undefined,
    ...(event.message ? { message: event.message } : {}),
    ...(counts ? { counts } : {}),
  });

  const steps = Array.from(byKey.values()).sort((a, b) => {
    const aIndex = importProgressOrder.indexOf(a.key as NotionImportProgressStepKey);
    const bIndex = importProgressOrder.indexOf(b.key as NotionImportProgressStepKey);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });
  const percent = defaultProgressPercent(previous, event);
  return {
    ...previous,
    step: event.legacyStep,
    currentStep: event.key,
    currentLabel: importProgressLabels[event.key],
    currentStatus: event.status,
    percent,
    lastUpdatedAt: at,
    steps,
  };
}

export function cleanJob(job: NotionImportJob) {
  const {
    activeItemGeneration: _activeItemGeneration,
    itemSnapshotRevision: _itemSnapshotRevision,
    ...publicJob
  } = job;
  return {
    ...publicJob,
    options: job.options ?? {},
    counts: job.counts ?? {},
    progress: job.progress ?? {},
    report: job.report ?? {},
  };
}

export function cleanItem(item: NotionImportItem) {
  const { itemGeneration: _itemGeneration, ...publicItem } = item;
  return {
    ...publicItem,
    metadata: item.metadata ?? {},
  };
}

export function baseReport(extra: Record<string, unknown> = {}) {
  return {
    warnings: [
      'This implementation performs Notion API graph discovery and a first-pass converter for local pages, databases, views, row pages, relation IDs, rollup/formula config metadata, file copies, templates, resumable search discovery, and ID mappings. High-fidelity linked view rendering, advanced formula translation, and real-workspace validation still need deeper work.',
    ],
    unsupported: [],
    missingPermissions: [],
    ...extra,
  };
}

export interface NotionImportJobListingJob {
  id: string;
  workspaceId: string;
  status: string;
  progress?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotionImportJobListingItem {
  id: string;
}

interface NotionImportJobListingTable<T> {
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportJobListingDb {
  table<T>(name: string): NotionImportJobListingTable<T>;
}

export interface NotionImportJobListingRuntime<
  Job extends NotionImportJobListingJob,
  Db extends NotionImportJobListingDb,
  Role extends string,
  CleanJob,
> {
  envString(env: Record<string, unknown> | undefined, key: string): string | undefined;
  listAll<T>(query: TableQuery<T>, maxItems?: number): Promise<T[]>;
  bestEffort(context: string, work: Promise<unknown>): Promise<boolean>;
  requireString(value: unknown, name: string): string;
  parsePositiveInt(value: unknown, fallback: number, max: number): number;
  assertWorkspaceRole(db: Db, workspaceId: string, actorId: string, minimum: 'view'): Promise<void>;
  workspaceRole(db: Db, workspaceId: string, actorId: string): Promise<Role | undefined>;
  roleRanks: Record<Role, number> & { edit: number };
  cleanJob(job: Job): CleanJob;
  notionImportItemSafetyLimit: number;
}

// Housekeeping for the persisted job engine: there is no user-facing recent-jobs
// list anymore, so finished/stale job records (and their discovered items) are
// pruned opportunistically when a workspace lists its jobs. Live jobs (queued /
// discovering / apply-in-progress) are NEVER pruned. Retention is by age with a
// per-workspace keep cap; deletes are batched per call to bound request cost.
const NOTION_IMPORT_JOB_RETENTION_DAYS_ENV = 'HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS';
const NOTION_IMPORT_JOB_RETENTION_MS_DEFAULT = 14 * 24 * 60 * 60 * 1000;
const NOTION_IMPORT_JOB_RETENTION_DAYS_MAX = 365;
const NOTION_IMPORT_JOB_KEEP_MAX = 25;
const NOTION_IMPORT_JOB_PRUNE_BATCH_MAX = 12;

export function createNotionImportJobListingHandlers<
  Job extends NotionImportJobListingJob,
  Item extends NotionImportJobListingItem,
  Db extends NotionImportJobListingDb,
  Role extends string,
  CleanJob,
>(runtime: NotionImportJobListingRuntime<Job, Db, Role, CleanJob>) {
  const {
    envString,
    listAll,
    bestEffort,
    requireString,
    parsePositiveInt,
    assertWorkspaceRole,
    workspaceRole,
    roleRanks,
    cleanJob,
    notionImportItemSafetyLimit: NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  } = runtime;
  type NotionImportJob = Job;
  type NotionImportItem = Item;
  type DbRef = Db;

  // Mirrors the frontend's isLiveNotionJob: a job that is queued, discovering, or
  // mid-apply must never be pruned.
  function isLiveImportJob(job: NotionImportJob) {
    if (job.status === 'queued' || job.status === 'discovering') return true;
    return (job.progress as { currentStatus?: unknown } | undefined)?.currentStatus === 'running';
  }

  function importJobRetentionMs(env: Record<string, unknown> | undefined) {
    const raw = envString(env, NOTION_IMPORT_JOB_RETENTION_DAYS_ENV);
    if (!raw || !/^[1-9][0-9]*$/.test(raw)) return NOTION_IMPORT_JOB_RETENTION_MS_DEFAULT;
    const days = Number(raw);
    if (!Number.isSafeInteger(days) || days > NOTION_IMPORT_JOB_RETENTION_DAYS_MAX) {
      return NOTION_IMPORT_JOB_RETENTION_MS_DEFAULT;
    }
    if (days > 0) return days * 24 * 60 * 60 * 1000;
    return NOTION_IMPORT_JOB_RETENTION_MS_DEFAULT;
  }

  function importJobTimestampMs(job: NotionImportJob) {
    const stamp = job.updatedAt ?? job.createdAt;
    if (!stamp) return undefined;
    const ms = new Date(stamp).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }

  // Opportunistic housekeeping: delete finished/stale, non-live job records (and
  // their discovered items) that are older than the retention window OR beyond the
  // per-workspace keep cap. Returns the set of pruned job ids so the caller omits
  // them from the response. Best-effort — a delete failure never breaks listing.
  async function pruneStaleImportJobs(
    db: DbRef,
    jobs: NotionImportJob[],
    env: Record<string, unknown> | undefined,
  ): Promise<Set<string>> {
    const pruned = new Set<string>();
    const retentionMs = importJobRetentionMs(env);
    const nowMs = Date.now();
    const nonLive = jobs
      .filter((job) => !isLiveImportJob(job))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

    const candidates: NotionImportJob[] = [];
    nonLive.forEach((job, index) => {
      const stampMs = importJobTimestampMs(job);
      const tooOld = stampMs !== undefined && nowMs - stampMs > retentionMs;
      const beyondCap = index >= NOTION_IMPORT_JOB_KEEP_MAX;
      if (tooOld || beyondCap) candidates.push(job);
    });
    if (!candidates.length) return pruned;

    // Delete the oldest candidates first, capped per call to bound request cost;
    // repeated listings converge on a clean table.
    const toPrune = candidates
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .slice(0, NOTION_IMPORT_JOB_PRUNE_BATCH_MAX);
    const jobTable = db.table<NotionImportJob>('notion_import_jobs');
    const itemTable = db.table<NotionImportItem>('notion_import_items');
    for (const job of toPrune) {
      const items = await listAll(itemTable.where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
      await Promise.all(items.map((item) => bestEffort('notion-import prune item.delete', itemTable.delete(item.id))));
      const deleted = await bestEffort('notion-import prune job.delete', jobTable.delete(job.id));
      if (deleted) pruned.add(job.id);
    }
    return pruned;
  }

  async function listJobs(
    db: DbRef,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ) {
    const workspaceId = requireString(body.workspaceId, 'workspaceId');
    await assertWorkspaceRole(db, workspaceId, actorId, 'view');
    const limit = parsePositiveInt(body.limit, 20, 100);
    const jobs = await listAll(db.table<NotionImportJob>('notion_import_jobs').where('workspaceId', '==', workspaceId), 500);
    // Pruning hard-deletes job/item rows, so a view-only member may list but
    // must not trigger destructive housekeeping; editors' listings still
    // converge on a clean table.
    const role = await workspaceRole(db, workspaceId, actorId);
    const canPrune = !!role && roleRanks[role] >= roleRanks.edit;
    const pruned = canPrune ? await pruneStaleImportJobs(db, jobs, env) : new Set<string>();
    return {
      jobs: jobs
        .filter((job) => !pruned.has(job.id))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        .slice(0, limit)
        .map(cleanJob),
    };
  }

  return {
    isLiveImportJob,
    importJobRetentionMs,
    pruneStaleImportJobs,
    listJobs,
  };
}

export interface NotionImportJobReaderJob {
  id: string;
}

interface NotionImportJobReaderTable<T> {
  getOne(id: string): Promise<T | null>;
}

export interface NotionImportJobReaderDb {
  table<T>(name: string): NotionImportJobReaderTable<T>;
}

export interface NotionImportJobReaderRuntime<
  Job extends NotionImportJobReaderJob,
  Item,
  Lock,
  Db extends NotionImportJobReaderDb,
  CleanJob,
  CleanItem,
  ActiveOperation,
> {
  requireString(value: unknown, name: string): string;
  assertReadableJob(db: Db, job: Job, actorId: string): Promise<void>;
  parseBoolean(value: unknown, fallback: boolean): boolean;
  listActiveNotionImportItems(db: Db, job: Job): Promise<Item[]>;
  cleanJob(job: Job): CleanJob;
  cleanItem(item: Item): CleanItem;
  activeNotionImportOperation(lock: Lock | null | undefined): ActiveOperation;
}

export function createNotionImportJobReaderHandlers<
  Job extends NotionImportJobReaderJob,
  Item,
  Lock,
  Db extends NotionImportJobReaderDb,
  CleanJob,
  CleanItem,
  ActiveOperation,
>(runtime: NotionImportJobReaderRuntime<
  Job,
  Item,
  Lock,
  Db,
  CleanJob,
  CleanItem,
  ActiveOperation
>) {
  const {
    requireString,
    assertReadableJob,
    parseBoolean,
    listActiveNotionImportItems,
    cleanJob,
    cleanItem,
    activeNotionImportOperation,
  } = runtime;
  type NotionImportJob = Job;
  type NotionImportApplyLock = Lock;
  type DbRef = Db;

  async function getJob(db: DbRef, body: Record<string, unknown>, actorId: string) {
    const jobId = requireString(body.jobId, 'jobId');
    const job = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), jobId);
    if (!job) throw new Error('Notion import job was not found.');
    await assertReadableJob(db, job, actorId);
    const compact = parseBoolean(body.compact, false);
    const items = compact ? undefined : await listActiveNotionImportItems(db, job);
    const lock = await getExisting(
      db.table<NotionImportApplyLock>('notion_import_apply_locks'),
      job.id,
    );
    return {
      job: cleanJob(job),
      ...(items ? { items: items.map(cleanItem) } : {}),
      activeOperation: activeNotionImportOperation(lock),
    };
  }

  return { getJob };
}

export interface NotionImportJobCreateJob {
  id: string;
  workspaceId: string;
  status: string;
  phase: string;
  actorId?: string;
  options?: Record<string, unknown>;
  counts?: Record<string, number>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string | null;
  finishedAt?: string | null;
}

export interface NotionImportJobCreateItem {
  notionObject: string;
}

interface NotionImportJobCreateTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportJobCreateDb extends TransactDb {
  table<T>(name: string): NotionImportJobCreateTable<T>;
}

interface NotionImportJobCreateTokenSource {
  token: string;
  tokenStored: false;
  connectionId?: string;
  credentialSource: 'request' | 'connection';
  tokenFingerprint?: string | null;
  connection?: { workspaceId?: string };
}

interface NotionImportJobCreateProgressEvent {
  key: 'connect' | 'discover';
  status: 'pending' | 'running' | 'completed' | 'failed';
  legacyStep: string;
  percent?: number;
  counts?: Record<string, unknown>;
  at?: string;
  message?: string;
}

export interface NotionImportJobCreateRuntime<
  Job extends NotionImportJobCreateJob,
  Item extends NotionImportJobCreateItem,
  SnapshotItem extends { metadata?: Record<string, unknown> },
  TokenSource extends NotionImportJobCreateTokenSource,
  Db extends NotionImportJobCreateDb,
  ConnectionKind,
  Locale,
  CleanJob,
  CleanItem,
  DiscoverResult,
> {
  notionApiVersion: string;
  notionSearchPagesDefault: number;
  notionPaginationSafetyPageLimit: number;
  notionEnrichmentBatchSize: number;
  notionEnrichmentBatchSizeMax: number;
  notionChildrenPagesDefault: number;
  notionRowPagesDefault: number;
  notionViewPagesDefault: number;
  notionTemplatePagesDefault: number;
  notionDiscoveryConcurrencyDefault: number;
  notionDiscoveryConcurrencyMax: number;
  notionImportSnapshotItemsPerRequestMax: number;
  requireString(value: unknown, name: string): string;
  optionalString(value: unknown): string | undefined;
  assertWritableImportTarget(
    db: Db,
    workspaceId: string,
    parentPageId: string | undefined,
    actorId: string,
  ): Promise<void>;
  parseConnectionKind(value: unknown): ConnectionKind;
  parseStringArray(value: unknown): string[];
  parseSnapshotItems(value: unknown): SnapshotItem[];
  parseMcpFetchItems(value: unknown): SnapshotItem[];
  expandSnapshotItems(items: SnapshotItem[], maxItems: number): SnapshotItem[];
  assertBoundedRequestDiscoveredItems(items: SnapshotItem[], label: string): void;
  assertSafeNotionImportSourceReferences(db: Db, value: unknown): Promise<void>;
  notionTokenForJob(
    db: Db,
    body: Record<string, unknown>,
    job: Job | {
      connectionId?: string;
      options?: { connectionId?: string };
    },
    actorId: string,
    env: Record<string, unknown> | undefined,
  ): Promise<TokenSource>;
  parseBoolean(value: unknown, fallback: boolean): boolean;
  parseServerRunRequestId(value: unknown): string;
  parsePositiveInt(value: unknown, fallback: number, max: number): number;
  parseOptionalBoolean(value: unknown): boolean | undefined;
  parsePersistentGeneratedLocale(value: unknown): Locale;
  assertNotionFileCopyNotDisabled(body?: Record<string, unknown>): void;
  serverOwnedNotionImportJobId(
    workspaceId: string,
    actorId: string,
    requestId: string,
  ): Promise<string>;
  enqueueNotionImportRun(
    db: ReturnType<AdminDbAccessor['db']>,
    input: { jobId: string; workspaceId: string; actorId: string; dueAt: string },
  ): Promise<unknown>;
  cleanJob(job: Job): CleanJob;
  withImportProgress(
    previousProgress: Record<string, unknown> | undefined,
    event: NotionImportJobCreateProgressEvent,
  ): Record<string, unknown>;
  baseReport(extra?: Record<string, unknown>): Record<string, unknown>;
  isApplyLeaseConflict(error: unknown): boolean;
  replaceDiscoveredItems(db: Db, job: Job, items: SnapshotItem[]): Promise<Item[]>;
  updateNotionJobIfStatus(
    db: Db,
    jobId: string,
    expectedStatus: 'discovering',
    data: Partial<NotionImportJobCreateJob>,
    options?: {
      expectedItemGeneration?: string | null;
      extraExpectations?: TransactOperation[];
    },
  ): Promise<Job | null>;
  cleanItem(item: Item): CleanItem;
  discoverJob(
    db: Db,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
    preloadedTokenSource: TokenSource,
    supplementalSnapshotItems: SnapshotItem[],
  ): Promise<DiscoverResult>;
}

export function createNotionImportJobCreateHandlers<
  Job extends NotionImportJobCreateJob,
  Item extends NotionImportJobCreateItem,
  SnapshotItem extends { metadata?: Record<string, unknown> },
  TokenSource extends NotionImportJobCreateTokenSource,
  Db extends NotionImportJobCreateDb,
  ConnectionKind,
  Locale,
  CleanJob,
  CleanItem,
  DiscoverResult,
>(runtime: NotionImportJobCreateRuntime<
  Job,
  Item,
  SnapshotItem,
  TokenSource,
  Db,
  ConnectionKind,
  Locale,
  CleanJob,
  CleanItem,
  DiscoverResult
>) {
  const {
    notionApiVersion: NOTION_API_VERSION,
    notionSearchPagesDefault: NOTION_SEARCH_PAGES_DEFAULT,
    notionPaginationSafetyPageLimit: NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    notionEnrichmentBatchSize: NOTION_ENRICHMENT_BATCH_SIZE,
    notionEnrichmentBatchSizeMax: NOTION_ENRICHMENT_BATCH_SIZE_MAX,
    notionChildrenPagesDefault: NOTION_CHILDREN_PAGES_DEFAULT,
    notionRowPagesDefault: NOTION_ROW_PAGES_DEFAULT,
    notionViewPagesDefault: NOTION_VIEW_PAGES_DEFAULT,
    notionTemplatePagesDefault: NOTION_TEMPLATE_PAGES_DEFAULT,
    notionDiscoveryConcurrencyDefault: NOTION_DISCOVERY_CONCURRENCY_DEFAULT,
    notionDiscoveryConcurrencyMax: NOTION_DISCOVERY_CONCURRENCY_MAX,
    notionImportSnapshotItemsPerRequestMax: NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
    requireString,
    optionalString,
    assertWritableImportTarget,
    parseConnectionKind,
    parseStringArray,
    parseSnapshotItems,
    parseMcpFetchItems,
    expandSnapshotItems,
    assertBoundedRequestDiscoveredItems,
    assertSafeNotionImportSourceReferences,
    notionTokenForJob,
    parseBoolean,
    parseServerRunRequestId,
    parsePositiveInt,
    parseOptionalBoolean,
    parsePersistentGeneratedLocale,
    assertNotionFileCopyNotDisabled,
    serverOwnedNotionImportJobId,
    enqueueNotionImportRun,
    cleanJob,
    withImportProgress,
    baseReport,
    isApplyLeaseConflict,
    replaceDiscoveredItems,
    updateNotionJobIfStatus,
    cleanItem,
    discoverJob,
  } = runtime;
  type NotionImportJob = Job;
  type DbRef = Db;

  async function createJobRecord(
    db: DbRef,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
    retryOfJobId?: string,
  ) {
    const workspaceId = requireString(body.workspaceId, 'workspaceId');
    const parentPageId = optionalString(body.parentPageId);
    await assertWritableImportTarget(db, workspaceId, parentPageId, actorId);

    const connectionKind = parseConnectionKind(body.connectionKind);
    const connectionId = optionalString(body.connectionId);
    const rootNotionPageIds = parseStringArray(body.rootNotionPageIds);
    const rootNotionDataSourceIds = parseStringArray(body.rootNotionDataSourceIds);
    const providedSnapshotItems = parseSnapshotItems(body.snapshotItems);
    const mcpFetchSnapshotItems = parseMcpFetchItems(body.mcpFetches);
    const snapshotItems = expandSnapshotItems(
      [...providedSnapshotItems, ...mcpFetchSnapshotItems],
      NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
    );
    assertBoundedRequestDiscoveredItems(snapshotItems, 'snapshotItems');
    await assertSafeNotionImportSourceReferences(
      db,
      snapshotItems.map((item) => item.metadata),
    );
    const token = optionalString(body.notionToken);
    const tokenSource = token || connectionId
      ? await notionTokenForJob(db, body, { connectionId, options: { connectionId } }, actorId, env)
      : undefined;
    if (tokenSource?.connection?.workspaceId && tokenSource.connection.workspaceId !== workspaceId) {
      throw new Error('Notion import connection belongs to another workspace.');
    }
    const serverOwned = parseBoolean(body.serverOwned, false);
    if (serverOwned && tokenSource?.credentialSource !== 'connection') {
      throw new Error('serverOwned Notion import must be backed by a stored connection.');
    }
    if (serverOwned && snapshotItems.length > 0) {
      throw new Error('serverOwned Notion import must be created without snapshotItems or mcpFetches.');
    }
    const serverRunRequestId = serverOwned
      ? parseServerRunRequestId(body.serverRunRequestId)
      : undefined;
    const now = nowIso();
    const maxDiscoveryPages = parsePositiveInt(
      body.maxDiscoveryPages,
      NOTION_SEARCH_PAGES_DEFAULT,
      NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    );
    const maxEnrichedItems = parsePositiveInt(
      body.maxEnrichedItems,
      NOTION_ENRICHMENT_BATCH_SIZE,
      NOTION_ENRICHMENT_BATCH_SIZE_MAX,
    );
    const maxChildrenPages = parsePositiveInt(
      body.maxChildrenPages,
      NOTION_CHILDREN_PAGES_DEFAULT,
      NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    );
    const maxDataSourceQueryPages = parsePositiveInt(
      body.maxDataSourceQueryPages,
      NOTION_ROW_PAGES_DEFAULT,
      NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    );
    const maxViewPages = parsePositiveInt(
      body.maxViewPages,
      NOTION_VIEW_PAGES_DEFAULT,
      NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    );
    const maxTemplatePages = parsePositiveInt(
      body.maxTemplatePages,
      NOTION_TEMPLATE_PAGES_DEFAULT,
      NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    );
    const discoveryConcurrency = parsePositiveInt(
      body.discoveryConcurrency,
      NOTION_DISCOVERY_CONCURRENCY_DEFAULT,
      NOTION_DISCOVERY_CONCURRENCY_MAX,
    );
    const includeMarkdownFallback = parseBoolean(body.includeMarkdownFallback, true);
    const importPagesFullWidth = parseOptionalBoolean(body.importPagesFullWidth);
    const locale = parsePersistentGeneratedLocale(body.locale);
    assertNotionFileCopyNotDisabled(body);
    const deferDiscovery = serverOwned || parseBoolean(body.deferDiscovery, false);
    const shouldRunDiscovery = !!tokenSource && !deferDiscovery && providedSnapshotItems.length === 0;
    const readySnapshotItems = shouldRunDiscovery ? [] : snapshotItems;
    const discoverySupplementalSnapshotItems = shouldRunDiscovery ? snapshotItems : [];
    const shouldStageSnapshot = readySnapshotItems.length > 0;

    const jobId = serverOwned
      ? await serverOwnedNotionImportJobId(workspaceId, actorId, serverRunRequestId!)
      : newId();
    if (serverOwned) {
      // Queue first, then publish the workspace job. That asymmetric ordering is
      // the cross-database durability invariant: a response loss may leave an
      // orphan queue marker, but never a runnable job without its continuation.
      await enqueueNotionImportRun(admin.db('app'), {
        jobId,
        workspaceId,
        actorId,
        dueAt: now,
      });
      const existing = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), jobId);
      const existingRequestId = optionalString(
        (existing?.options as { serverRunRequestId?: unknown } | undefined)?.serverRunRequestId,
      );
      if (existing) {
        if (
          existing.workspaceId !== workspaceId
          || existing.actorId !== actorId
          || existingRequestId !== serverRunRequestId
        ) {
          throw new Error('Notion import server run identity does not match the existing job.');
        }
        return { job: cleanJob(existing), items: [] };
      }
    }

    let job: NotionImportJob;
    try {
      job = await db.table<NotionImportJob>('notion_import_jobs').insert({
      id: jobId,
      workspaceId,
      source: 'notion_api',
      connectionKind,
      connectionId: tokenSource?.connectionId,
      // Snapshot rows are persisted one at a time. Keep the durable job behind
      // the ready gate until every row has landed so a failed staging pass can
      // never expose a partial import graph to plan/apply.
      status: shouldRunDiscovery || shouldStageSnapshot ? 'discovering' : 'queued',
      phase: shouldRunDiscovery
        ? 'api_search'
        : shouldStageSnapshot
          ? 'snapshot_staging'
          : deferDiscovery && tokenSource
            ? 'discovery_deferred'
            : 'awaiting_connection',
      actorId,
      parentPageId,
      rootNotionPageIds,
      rootNotionDataSourceIds,
      apiVersion: NOTION_API_VERSION,
      options: {
        importMode: 'workspace_graph',
        preserveLinkedDatabases: true,
        preserveViewUi: true,
        preserveFiles: true,
        maxDiscoveryPages,
        maxEnrichedItems,
        maxChildrenPages,
        maxDataSourceQueryPages,
        maxViewPages,
        maxTemplatePages,
        discoveryConcurrency,
        includeMarkdownFallback,
        locale,
        runnerMode: serverOwned ? 'server' : 'browser',
        ...(serverRunRequestId ? { serverRunRequestId } : {}),
        ...(importPagesFullWidth !== undefined ? { importPagesFullWidth } : {}),
        rootNotionDataSourceIds,
        deferDiscovery,
        connectionId: tokenSource?.connectionId,
        credentialSource: tokenSource?.credentialSource,
        tokenFingerprint: tokenSource?.tokenFingerprint,
        tokenStored: false,
        snapshotItems: providedSnapshotItems.length,
        mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
        discoverySupplementalSnapshotItems: discoverySupplementalSnapshotItems.length,
      },
      counts: {},
      progress: {
        ...withImportProgress(undefined, shouldRunDiscovery
          ? {
              key: 'discover',
              status: 'running',
              legacyStep: 'discovering_accessible_workspace_graph',
              percent: 25,
            }
          : shouldStageSnapshot
            ? {
                key: 'discover',
                status: 'running',
                legacyStep: 'staging_snapshot_items',
                percent: 35,
                counts: { discovered: 0, totalKnown: readySnapshotItems.length },
              }
            : {
                key: deferDiscovery && tokenSource ? 'discover' : 'connect',
                status: 'pending',
                legacyStep: deferDiscovery && tokenSource ? 'waiting_for_discovery' : 'waiting_for_notion_connection',
                percent: deferDiscovery && tokenSource ? 15 : 5,
              }),
        discovered: 0,
        totalKnown: readySnapshotItems.length,
      },
      report: baseReport({
        rootNotionPageIds,
        rootNotionDataSourceIds,
        tokenStored: false,
        connectionId: tokenSource?.connectionId,
        credentialSource: tokenSource?.credentialSource,
        snapshotProvided: snapshotItems.length > 0,
        snapshotItems: providedSnapshotItems.length,
        mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
        discoverySupplementalSnapshotItems: discoverySupplementalSnapshotItems.length,
        deferDiscovery,
        ...(importPagesFullWidth !== undefined ? { importPagesFullWidth } : {}),
        locale,
        runnerMode: serverOwned ? 'server' : 'browser',
        ...(serverRunRequestId ? { serverRunRequestId } : {}),
      }),
      retryOfJobId,
      startedAt: shouldRunDiscovery || shouldStageSnapshot ? now : undefined,
    } as unknown as Partial<NotionImportJob>);
    } catch (error) {
      if (!serverOwned || !isApplyLeaseConflict(error)) throw error;
      // A replay after a committed insert whose HTTP response was lost must
      // return the original job, never create a second import graph.
      const raced = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), jobId);
      const racedRequestId = optionalString(
        (raced?.options as { serverRunRequestId?: unknown } | undefined)?.serverRunRequestId,
      );
      if (
        !raced
        || raced.workspaceId !== workspaceId
        || raced.actorId !== actorId
        || racedRequestId !== serverRunRequestId
      ) throw error;
      return { job: cleanJob(raced), items: [] };
    }

    await recordWorkspaceAudit(db, {
      workspaceId,
      actorId,
      action: 'notion_import.create',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: {
        connectionKind,
        connectionId: tokenSource?.connectionId,
        credentialSource: tokenSource?.credentialSource,
        hasToken: !!token,
        retryOfJobId,
        rootNotionPageIds,
        rootNotionDataSourceIds,
        snapshotItems: snapshotItems.length,
        mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
        discoverySupplementalSnapshotItems: discoverySupplementalSnapshotItems.length,
        deferDiscovery,
        runnerMode: serverOwned ? 'server' : 'browser',
        ...(importPagesFullWidth !== undefined ? { importPagesFullWidth } : {}),
        locale,
      },
      occurredAt: now,
    });

    if (shouldStageSnapshot) {
      try {
        const inserted = await replaceDiscoveredItems(db, job, readySnapshotItems);
        const counts = inserted.reduce<Record<string, number>>((acc, item) => {
          acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
          return acc;
        }, {});
        const finishedAt = nowIso();
        const updated = await updateNotionJobIfStatus(db, job.id, 'discovering', {
          status: 'ready',
          phase: 'snapshot_ready',
          counts,
          progress: {
            ...withImportProgress(job.progress, {
              key: 'discover',
              status: 'completed',
              legacyStep: 'ready_for_graph_planning',
              percent: 50,
              counts: { discovered: inserted.length, totalKnown: inserted.length },
              at: finishedAt,
            }),
            discovered: inserted.length,
            totalKnown: inserted.length,
          },
          report: baseReport({
            rootNotionPageIds,
            rootNotionDataSourceIds,
            tokenStored: false,
            snapshotProvided: true,
            snapshotItems: providedSnapshotItems.length,
            mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
            discoveredByObject: counts,
            locale,
          }),
          finishedAt,
        });
        if (!updated) {
          throw new Error('Notion import job state changed before snapshot staging completed.');
        }
        return {
          job: cleanJob(updated),
          items: inserted.map(cleanItem),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = nowIso();
        // Best effort is deliberate: if the failure also prevents the status
        // write, the job remains `discovering`, which still keeps plan/apply
        // closed. Never promote a partially staged graph to `ready`.
        await bestEffort(
          'notion-import snapshot staging failure status',
          updateNotionJobIfStatus(db, job.id, 'discovering', {
            status: 'failed',
            phase: 'snapshot_staging_failed',
            error: message,
            progress: {
              ...withImportProgress(job.progress, {
                key: 'discover',
                status: 'failed',
                legacyStep: 'snapshot_staging_failed',
                message,
                at: failedAt,
              }),
              discovered: 0,
              totalKnown: readySnapshotItems.length,
            },
            report: {
              ...(job.report ?? baseReport()),
              lastError: message,
            },
            finishedAt: failedAt,
          }),
        );
        throw error;
      }
    }

    if (!tokenSource || deferDiscovery) return { job: cleanJob(job), items: [] };
    return discoverJob(
      db,
      {
        jobId: job.id,
        notionToken: tokenSource.credentialSource === 'request' ? tokenSource.token : undefined,
        connectionId: tokenSource.credentialSource === 'connection' ? tokenSource.connectionId : undefined,
        maxDiscoveryPages,
        maxEnrichedItems,
        maxChildrenPages,
        maxDataSourceQueryPages,
        maxViewPages,
        maxTemplatePages,
        discoveryConcurrency,
        includeMarkdownFallback,
      },
      actorId,
      env,
      tokenSource,
      discoverySupplementalSnapshotItems,
    );
  }

  return { createJobRecord };
}

type NotionImportJobLifecycleStatus =
  | 'queued'
  | 'discovering'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NotionImportJobLifecycleJob {
  id: string;
  workspaceId: string;
  status: NotionImportJobLifecycleStatus;
  phase: string;
  parentPageId?: string | null;
  rootNotionPageIds?: string[];
  rootNotionDataSourceIds?: string[];
  connectionKind?: unknown;
  connectionId?: string | null;
  options?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  finishedAt?: string | null;
  fileCleanupStatus?: 'pending' | 'complete' | null;
  fileCleanupRequestedAt?: string | null;
  fileCleanupCompletedAt?: string | null;
}

export interface NotionImportJobLifecycleItem {
  id: string;
}

interface NotionImportJobLifecycleTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportJobLifecycleDb extends TransactDb {
  table<T>(name: string): NotionImportJobLifecycleTable<T>;
}

interface CancelProgressEvent {
  key: 'cancel';
  status: 'cancelled';
  legacyStep: string;
  at: string;
}

export interface NotionImportJobLifecycleRuntime<
  Job extends NotionImportJobLifecycleJob,
  Item extends NotionImportJobLifecycleItem,
  Db extends NotionImportJobLifecycleDb,
  CleanJob extends { id: string },
  RetryResult,
> {
  requireString(value: unknown, name: string): string;
  assertWritableJob(db: Db, job: Job, actorId: string): Promise<void>;
  clearNotionImportApplySnapshotCache(jobId: string): void;
  isLiveImportJob(job: Job): boolean;
  cleanJob(job: Job): CleanJob;
  updateNotionJobIfStatus(
    db: Db,
    jobId: string,
    expectedStatus: Job['status'],
    data: Partial<NotionImportJobLifecycleJob>,
  ): Promise<Job | null>;
  withImportProgress(
    previousProgress: Record<string, unknown> | undefined,
    event: CancelProgressEvent,
  ): Record<string, unknown>;
  scrubMappedImportProductCredentials(db: Db, jobId: string): Promise<void>;
  listActiveNotionImportItems(db: Db, job: Job): Promise<Item[]>;
  scrubAppliedImportCredentialMetadata(db: Db, items: Item[]): Promise<void>;
  trashIncompleteImportPages(
    db: Db,
    job: Job,
    mappings: undefined,
    options: { includeCheckpointOwners: false },
  ): Promise<number>;
  createJobRecord(
    db: Db,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
    retryOfJobId?: string,
  ): Promise<RetryResult>;
  parseStringArray(value: unknown): string[];
  optionalString(value: unknown): string | undefined;
  parseOptionalBoolean(value: unknown): boolean | undefined;
  listAll<T>(query: TableQuery<T>, maxItems?: number): Promise<T[]>;
  notionImportItemSafetyLimit: number;
}

export function createNotionImportJobLifecycleHandlers<
  Job extends NotionImportJobLifecycleJob,
  Item extends NotionImportJobLifecycleItem,
  Db extends NotionImportJobLifecycleDb,
  CleanJob extends { id: string },
  RetryResult,
>(runtime: NotionImportJobLifecycleRuntime<Job, Item, Db, CleanJob, RetryResult>) {
  const {
    requireString,
    assertWritableJob,
    clearNotionImportApplySnapshotCache,
    isLiveImportJob,
    cleanJob,
    updateNotionJobIfStatus,
    withImportProgress,
    scrubMappedImportProductCredentials,
    listActiveNotionImportItems,
    scrubAppliedImportCredentialMetadata,
    trashIncompleteImportPages,
    createJobRecord,
    parseStringArray,
    optionalString,
    parseOptionalBoolean,
    listAll,
    notionImportItemSafetyLimit: NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  } = runtime;
  type NotionImportJob = Job;
  type NotionImportItem = Item;
  type DbRef = Db;

  async function deleteNotionImportJobItems(db: DbRef, jobId: string) {
    const itemTable = db.table<NotionImportItem>('notion_import_items');
    const byJob = itemTable.where('jobId', '==', jobId);
    // Cancellation only needs row identities. Import metadata can contain whole
    // block trees and data-source snapshots, so materializing full rows here
    // makes cleanup proportional to the graph's serialized byte size.
    const projected = projectFields(byJob, ['id']);
    const items = await listAll(
      projected,
      NOTION_IMPORT_ITEM_SAFETY_LIMIT,
    );
    // A transact delete is a no-op when another cancelled discovery request has
    // already removed the row. Chunking also collapses thousands of per-record
    // internal HTTP/SQLite round trips into a bounded number of DB operations.
    for (let index = 0; index < items.length; index += MAX_RAW_TRANSACT_OPS) {
      await db.transact(
        items.slice(index, index + MAX_RAW_TRANSACT_OPS).map((item): TransactOperation => ({
          table: 'notion_import_items',
          op: 'delete',
          id: item.id,
        })),
      );
    }
    return items.length;
  }

  async function cancelJob(db: DbRef, body: Record<string, unknown>, actorId: string) {
    const jobId = requireString(body.jobId, 'jobId');
    const jobs = db.table<NotionImportJob>('notion_import_jobs');
    const job = await getExisting(jobs, jobId);
    if (!job) throw new Error('Notion import job was not found.');
    await assertWritableJob(db, job, actorId);
    clearNotionImportApplySnapshotCache(job.id);
    if (!isLiveImportJob(job)) {
      return { job: cleanJob(job) };
    }
    const now = nowIso();
    const updated = await updateNotionJobIfStatus(db, job.id, job.status, {
      status: 'cancelled',
      phase: 'cancelled',
      cancelledAt: now,
      cancelledBy: actorId,
      finishedAt: now,
      fileCleanupStatus: 'pending',
      fileCleanupRequestedAt: now,
      fileCleanupCompletedAt: null,
      progress: {
        ...withImportProgress(job.progress, {
          key: 'cancel',
          status: 'cancelled',
          legacyStep: 'cancelled',
          at: now,
        }),
      },
    });
    if (!updated) {
      const current = await getExisting(jobs, job.id);
      if (!current) throw new Error('Notion import job was not found.');
      return { job: cleanJob(current) };
    }
    // A worker restart can strand a discovery lease after its request has
    // vanished. Cancellation is the user's explicit terminal fence, so remove
    // that job-scoped lease immediately instead of making a restart/retry wait
    // for its TTL. An old request cannot publish after the status CAS above.
    await bestEffort(
      'notion-import cancel stale lease',
      db.transact([
        { table: 'notion_import_apply_locks', op: 'delete', id: job.id },
      ]),
    );
    let cleanup: { removedItems: number; trashedPages: number; pending: boolean };
    try {
      // Cancellation may win after product rows were partially applied. Remove
      // temporary Notion/AWS URLs before returning, while file object/quota
      // retirement continues from the durable terminal queue.
      await scrubMappedImportProductCredentials(db, job.id);
      const stagedItems = await listActiveNotionImportItems(db, updated);
      await scrubAppliedImportCredentialMetadata(db, stagedItems);
      const removedItems = await deleteNotionImportJobItems(db, job.id);
      const trashedPages = await trashIncompleteImportPages(db, updated, undefined, {
        includeCheckpointOwners: false,
      });
      // The terminal CAS above is the durable continuation marker. Do not read
      // the checkpoint backlog merely to derive response metadata: maintenance
      // owns both the bounded drain and the eventual pending -> complete CAS.
      cleanup = { removedItems, trashedPages, pending: true };
    } catch (error) {
      cleanup = { removedItems: 0, trashedPages: 0, pending: true };
      console.warn(
        `[notion-import] cancelled job cleanup remains pending for ${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const cleaned = await jobs.update(job.id, {
      report: {
        ...(updated.report ?? {}),
        cancelCleanup: cleanup,
      },
    } as unknown as Partial<NotionImportJob>).catch(() => updated);
    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.cancel',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: cleanup,
      occurredAt: now,
    });
    return { job: cleanJob(cleaned) };
  }

  async function retryJob(
    db: DbRef,
    admin: AdminDbAccessor,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ) {
    const retryOfJobId = requireString(body.jobId, 'jobId');
    const previous = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), retryOfJobId);
    if (!previous) throw new Error('Notion import job was not found.');
    await assertWritableJob(db, previous, actorId);
    return createJobRecord(
      db,
      admin,
      {
        ...body,
        workspaceId: previous.workspaceId,
        parentPageId: previous.parentPageId,
        rootNotionPageIds: previous.rootNotionPageIds,
        rootNotionDataSourceIds: previous.rootNotionDataSourceIds ??
          parseStringArray((previous.options as { rootNotionDataSourceIds?: unknown } | undefined)?.rootNotionDataSourceIds),
        connectionKind: previous.connectionKind,
        connectionId: optionalString(body.connectionId) ?? previous.connectionId ?? optionalString((previous.options as { connectionId?: unknown } | undefined)?.connectionId),
        maxDiscoveryPages: (previous.options as { maxDiscoveryPages?: unknown } | undefined)?.maxDiscoveryPages,
        maxEnrichedItems: (previous.options as { maxEnrichedItems?: unknown } | undefined)?.maxEnrichedItems,
        maxChildrenPages: (previous.options as { maxChildrenPages?: unknown } | undefined)?.maxChildrenPages,
        maxDataSourceQueryPages: (previous.options as { maxDataSourceQueryPages?: unknown } | undefined)?.maxDataSourceQueryPages,
        maxViewPages: (previous.options as { maxViewPages?: unknown } | undefined)?.maxViewPages,
        maxTemplatePages: (previous.options as { maxTemplatePages?: unknown } | undefined)?.maxTemplatePages,
        discoveryConcurrency: (previous.options as { discoveryConcurrency?: unknown } | undefined)?.discoveryConcurrency,
        includeMarkdownFallback: (previous.options as { includeMarkdownFallback?: unknown } | undefined)?.includeMarkdownFallback,
        importPagesFullWidth: parseOptionalBoolean(body.importPagesFullWidth) ??
          parseOptionalBoolean((previous.options as { importPagesFullWidth?: unknown } | undefined)?.importPagesFullWidth),
        // A retry remains part of the same import and must keep the language of
        // its already-reviewed generated names. Legacy jobs may adopt an
        // explicit retry locale once; current jobs always win over the request.
        locale: (previous.options as { locale?: unknown } | undefined)?.locale ?? body.locale,
        serverOwned: body.serverOwned,
        serverRunRequestId: body.serverRunRequestId,
      },
      actorId,
      env,
      retryOfJobId,
    );
  }

  return {
    deleteNotionImportJobItems,
    cancelJob,
    retryJob,
  };
}
