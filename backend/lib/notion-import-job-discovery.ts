import {
  notionApiBase,
} from './notion-import-credentials';
import {
  recordWorkspaceAudit,
} from './org-audit';
import {
  bestEffort,
  getExisting,
  newId,
  nowIso,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from './table-utils';

type NotionImportJobDiscoveryStatus =
  | 'queued'
  | 'discovering'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NotionImportJobDiscoveryJob {
  id: string;
  workspaceId: string;
  status: NotionImportJobDiscoveryStatus;
  phase: string;
  connectionId?: string | null;
  connectionKind?: unknown;
  rootNotionPageIds?: string[];
  rootNotionDataSourceIds?: string[];
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  apiVersion: string;
  options?: Record<string, unknown>;
  counts?: Record<string, number>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  activeItemGeneration?: string | null;
  itemSnapshotRevision?: string | null;
}

export interface NotionImportJobDiscoveryItem {
  id: string;
  workspaceId: string;
  jobId: string;
  itemGeneration?: string | null;
  notionId: string;
  notionObject: string;
  parentNotionId?: string | null;
  title?: string;
  status: string;
  phase: string;
  enrichmentComplete?: boolean;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface NotionImportJobDiscoverySnapshotItem {
  notionId: string;
  notionObject: string;
  parentNotionId?: string | null;
  title?: string;
  status?: string;
  phase?: string;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

interface NotionImportJobDiscoveryTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportJobDiscoveryDb extends TransactDb {
  table<T>(name: string): NotionImportJobDiscoveryTable<T>;
}

interface NotionImportJobDiscoveryTokenSource {
  token: string;
  tokenStored: false;
  credentialSource: 'request' | 'connection';
  connectionId?: string;
  tokenFingerprint?: string | null;
  connection?: {
    workspaceId?: string;
    connectionKind?: unknown;
    notionWorkspaceId?: string | null;
    notionWorkspaceName?: string | null;
  };
}

interface NotionImportDiscoveryLease {
  expectOwnedOperation(): TransactOperation;
  assertOwned(): Promise<void>;
  stop(): Promise<void>;
}

interface NotionImportDiscoveryProgressSnapshot {
  phase: 'search' | 'enrich';
  discovered: number;
  pendingEnrichment: number;
  enrichedPages: number;
  enrichedDataSources: number;
  enrichableTotal: number;
  searchPagesFetched: number;
  byType: Record<string, number>;
  recent: unknown[];
}

interface NotionImportDiscoveryProgressEvent {
  key: 'discover';
  status: 'running' | 'completed' | 'failed';
  legacyStep: string;
  percent?: number;
  counts?: Record<string, unknown>;
  at?: string;
  message?: string;
}

interface NotionImportDiscoveryGraphResult<
  SnapshotItem extends NotionImportJobDiscoverySnapshotItem,
> {
  items: SnapshotItem[];
  hasMore: boolean;
  pendingEnrichment: number;
  notionWorkspace: { id?: string; name?: string };
  searchPagesFetched: number;
  nextCursor?: string;
  searchStartCursor?: string;
  discoveryPasses: number;
  recentActivity: unknown[];
  counts: Record<string, number>;
  graphCounts: Record<string, number>;
  warnings: unknown[];
  missingPermissions: unknown[];
  unsupported: unknown[];
}

export interface NotionImportJobDiscoveryRuntime<
  Job extends NotionImportJobDiscoveryJob,
  Item extends NotionImportJobDiscoveryItem,
  SnapshotItem extends NotionImportJobDiscoverySnapshotItem,
  TokenSource extends NotionImportJobDiscoveryTokenSource,
  Db extends NotionImportJobDiscoveryDb,
  CleanJob,
  CleanItem,
  Preflight,
  CurrentResult,
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
  notionEnrichBudgetDefault: number;
  notionDiscoverCallDeadlineMs: number;
  notionDiscoveryProgressIntervalMs: number;
  requireString(value: unknown, name: string): string;
  optionalString(value: unknown): string | undefined;
  parseStringArray(value: unknown): string[];
  parseBoolean(value: unknown, fallback: boolean): boolean;
  parsePositiveInt(value: unknown, fallback: number, max: number): number;
  asRecord(value: unknown): Record<string, unknown> | undefined;
  assertWritableImportTarget(
    db: Db,
    workspaceId: string,
    parentPageId: string | undefined,
    actorId: string,
  ): Promise<void>;
  assertWritableJob(db: Db, job: Job, actorId: string): Promise<void>;
  notionTokenForJob(
    db: Db,
    body: Record<string, unknown>,
    job: Job | { connectionId?: string; options?: { connectionId?: string } },
    actorId: string,
    env: Record<string, unknown> | undefined,
  ): Promise<TokenSource>;
  preflightNotionImportGraph(
    token: string,
    options: {
      apiVersion: string;
      rootNotionPageIds: string[];
      rootNotionDataSourceIds: string[];
      apiBase?: string;
    },
  ): Promise<Preflight & { summary: unknown }>;
  acquireNotionApplyLease(
    db: Db,
    job: Job,
    actorId: string,
    purpose: 'discover',
  ): Promise<{ id: string; leaseId: string }>;
  startNotionDiscoveryLeaseHeartbeat(
    db: Db,
    lease: { id: string; leaseId: string },
  ): NotionImportDiscoveryLease;
  releaseNotionApplyLease(
    db: Db,
    lease: { id: string; leaseId: string },
  ): Promise<void>;
  currentNotionDiscoveryResult(
    db: Db,
    job: Job,
    compact?: boolean,
  ): Promise<CurrentResult>;
  importItemGeneration(job: Job): string | null;
  notionImportItemEnrichmentComplete(
    item: Pick<Item, 'notionId' | 'notionObject' | 'phase' | 'metadata' | 'enrichmentComplete'>,
  ): boolean;
  listActiveNotionImportItems(db: Db, job: Job): Promise<Item[]>;
  listActiveNotionImportDiscoverySeeds(db: Db, job: Job): Promise<Item[]>;
  hydrateNotionImportDiscoverySeeds(
    db: Db,
    job: Job,
    seeds: Item[],
    limit: number,
  ): Promise<Map<string, Item>>;
  backfillNotionImportDiscoveryEnrichmentState(
    db: Db,
    job: Job,
    rows: Array<Pick<Item, 'id' | 'enrichmentComplete'>>,
    options: {
      expectedJobStatus: 'discovering';
      extraExpectations?: TransactOperation[];
      assertOwned?: () => Promise<void>;
    },
  ): Promise<void>;
  withImportProgress(
    previousProgress: Record<string, unknown> | undefined,
    event: NotionImportDiscoveryProgressEvent,
  ): Record<string, unknown>;
  updateNotionJobIfStatus(
    db: Db,
    jobId: string,
    expectedStatus: NotionImportJobDiscoveryStatus,
    data: Partial<NotionImportJobDiscoveryJob>,
    options?: {
      expectedItemGeneration?: string | null;
      extraExpectations?: TransactOperation[];
    },
  ): Promise<Job | null>;
  discoveryProgressPercent(
    snapshot: Pick<
      NotionImportDiscoveryProgressSnapshot,
      'phase' | 'enrichedPages' | 'enrichedDataSources' | 'enrichableTotal'
    >,
  ): number;
  cachedNotionWorkspaceForDiscovery(
    job: Job,
    tokenSource: TokenSource,
  ): { id?: string; name?: string } | undefined;
  discoverNotionGraph(
    token: string,
    options: {
      apiVersion: string;
      maxPages: number;
      maxEnrichedItems: number;
      maxChildrenPages: number;
      maxDataSourceQueryPages: number;
      maxViewPages: number;
      maxTemplatePages: number;
      discoveryConcurrency: number;
      includeMarkdownFallback: boolean;
      rootNotionPageIds: string[];
      rootNotionDataSourceIds: string[];
      startCursor?: string;
      seedItems?: SnapshotItem[];
      completedSeedNotionIds?: Set<string>;
      enrichmentBudget?: number;
      perCallDeadlineMs?: number;
      skipSearch: boolean;
      notionWorkspace?: { id?: string; name?: string };
      apiBase?: string;
      onProgress: (snapshot: NotionImportDiscoveryProgressSnapshot) => void;
    },
  ): Promise<NotionImportDiscoveryGraphResult<SnapshotItem>>;
  missingRequestedRootIds(requestedIds: string[], items: SnapshotItem[]): string[];
  expandSnapshotItems(items: SnapshotItem[]): SnapshotItem[];
  mergeDiscoveredItems(
    db: Db,
    job: Job,
    items: SnapshotItem[],
    options: {
      existingItems: Item[];
      projectedExistingItems: boolean;
      hydratedExistingNotionIds: Set<string>;
      includeItems: boolean;
      expectedJobStatus: 'discovering';
      extraExpectations?: TransactOperation[];
      assertOwned?: () => Promise<void>;
    },
  ): Promise<{
    items?: Item[];
    totalKnown: number;
    counts: Record<string, number>;
  }>;
  replaceDiscoveredItemsWithGeneration(
    db: Db,
    job: Job,
    items: SnapshotItem[],
    options: {
      extraActivationExpectations?: TransactOperation[];
      assertOwned?: () => Promise<void>;
    },
  ): Promise<{ items: Item[]; activeItemGeneration: string }>;
  countImportItemsByObject(items: Iterable<Item>): Record<string, number>;
  deleteNotionImportJobItems(db: Db, jobId: string): Promise<number>;
  cleanJob(job: Job): CleanJob;
  cleanItem(item: Item): CleanItem;
  baseReport(extra?: Record<string, unknown>): Record<string, unknown>;
  mergeImportReportEntries(previous: unknown, current: unknown, limit?: number): unknown[];
  NotionDiscoveryLeaseLostError: new (cause?: unknown) => Error;
}

export function createNotionImportJobDiscoveryHandlers<
  Job extends NotionImportJobDiscoveryJob,
  Item extends NotionImportJobDiscoveryItem,
  SnapshotItem extends NotionImportJobDiscoverySnapshotItem,
  TokenSource extends NotionImportJobDiscoveryTokenSource,
  Db extends NotionImportJobDiscoveryDb,
  CleanJob,
  CleanItem,
  Preflight,
  CurrentResult,
>(runtime: NotionImportJobDiscoveryRuntime<
  Job,
  Item,
  SnapshotItem,
  TokenSource,
  Db,
  CleanJob,
  CleanItem,
  Preflight,
  CurrentResult
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
    notionEnrichBudgetDefault: NOTION_ENRICH_BUDGET_DEFAULT,
    notionDiscoverCallDeadlineMs: NOTION_DISCOVER_CALL_DEADLINE_MS,
    notionDiscoveryProgressIntervalMs: NOTION_DISCOVERY_PROGRESS_INTERVAL_MS,
    requireString,
    optionalString,
    parseStringArray,
    parseBoolean,
    parsePositiveInt,
    asRecord,
    assertWritableImportTarget,
    assertWritableJob,
    notionTokenForJob,
    preflightNotionImportGraph,
    acquireNotionApplyLease,
    startNotionDiscoveryLeaseHeartbeat,
    releaseNotionApplyLease,
    currentNotionDiscoveryResult,
    importItemGeneration,
    notionImportItemEnrichmentComplete,
    listActiveNotionImportItems,
    listActiveNotionImportDiscoverySeeds,
    hydrateNotionImportDiscoverySeeds,
    backfillNotionImportDiscoveryEnrichmentState,
    withImportProgress,
    updateNotionJobIfStatus,
    discoveryProgressPercent,
    cachedNotionWorkspaceForDiscovery,
    discoverNotionGraph,
    missingRequestedRootIds,
    expandSnapshotItems,
    mergeDiscoveredItems,
    replaceDiscoveredItemsWithGeneration,
    countImportItemsByObject,
    deleteNotionImportJobItems,
    cleanJob,
    cleanItem,
    baseReport,
    mergeImportReportEntries,
    NotionDiscoveryLeaseLostError,
  } = runtime;
  type NotionImportJob = Job;
  type NotionImportItem = Item;
  type DiscoveredNotionItem = SnapshotItem;
  type NotionTokenSource = TokenSource;
  type DbRef = Db;
  type DiscoveryProgressSnapshot = NotionImportDiscoveryProgressSnapshot;

async function preflightJob(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const parentPageId = optionalString(body.parentPageId);
  await assertWritableImportTarget(db, workspaceId, parentPageId, actorId);

  const connectionId = optionalString(body.connectionId);
  const tokenSource = await notionTokenForJob(db, body, { connectionId, options: { connectionId } }, actorId, env);
  if (tokenSource.connection?.workspaceId && tokenSource.connection.workspaceId !== workspaceId) {
    throw new Error('Notion import connection belongs to another workspace.');
  }
  const rootNotionPageIds = parseStringArray(body.rootNotionPageIds);
  const rootNotionDataSourceIds = parseStringArray(body.rootNotionDataSourceIds);
  if (!rootNotionPageIds.length && !rootNotionDataSourceIds.length) {
    throw new Error('rootNotionPageIds or rootNotionDataSourceIds is required for Notion import preflight.');
  }

  const preflight = await preflightNotionImportGraph(tokenSource.token, {
    apiVersion: optionalString(body.apiVersion) ?? NOTION_API_VERSION,
    rootNotionPageIds,
    rootNotionDataSourceIds,
    apiBase: notionApiBase(env),
  });
  await recordWorkspaceAudit(db, {
    workspaceId,
    actorId,
    action: 'notion_import.preflight',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: {
      rootNotionPageIds,
      rootNotionDataSourceIds,
      connectionId: tokenSource.connectionId,
      credentialSource: tokenSource.credentialSource,
      summary: preflight.summary,
    },
    occurredAt: nowIso(),
  });
  return { preflight };
}

async function discoverJob(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
  preloadedTokenSource?: NotionTokenSource,
  supplementalSnapshotItems: DiscoveredNotionItem[] = [],
) {
  const jobId = requireString(body.jobId, 'jobId');
  const job = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  if (job.status === 'cancelled') throw new Error('Notion import job is cancelled.');
  const lease = await acquireNotionApplyLease(db, job, actorId, 'discover');
  const discoveryLease = startNotionDiscoveryLeaseHeartbeat(db, lease);
  try {
    return await discoverJobUnderLease(
      db,
      body,
      actorId,
      env,
      preloadedTokenSource,
      supplementalSnapshotItems,
      discoveryLease,
    );
  } finally {
    await discoveryLease.stop();
    await releaseNotionApplyLease(db, lease).catch((error) => {
      console.error('[notion-import] failed to release discovery lease:', error);
    });
  }
}

async function discoverJobUnderLease(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
  preloadedTokenSource?: NotionTokenSource,
  supplementalSnapshotItems: DiscoveredNotionItem[] = [],
  discoveryLease?: {
    assertOwned(): Promise<void>;
    expectOwnedOperation(): TransactOperation;
  },
) {
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  if (job.status === 'cancelled') throw new Error('Notion import job is cancelled.');
  const activeApplyCursor = asRecord(asRecord(job.progress)?.applyCursor)
    ?? asRecord(asRecord(job.report)?.applyCursor);
  if (activeApplyCursor || asRecord(job.progress)?.currentStep === 'apply') {
    throw Object.assign(
      new Error('Cannot rediscover a Notion import graph after apply has started.'),
      { code: 409 },
    );
  }
  const tokenSource = preloadedTokenSource ?? await notionTokenForJob(db, body, job, actorId, env);
  const continueFromCursor = parseBoolean(body.continueFromCursor, false);
  // Opt-in incremental discovery: each call does a bounded amount of enrichment
  // work, persists progress, and reports whether more remains so a client can
  // loop short discover calls until the graph is complete. Off by default so the
  // existing one-shot full-convergence behavior is unchanged.
  const incremental = parseBoolean(body.incremental, false);
  // Incremental callers only need the durable job boundary to decide whether
  // another chunk is required. Returning every accumulated item (including
  // block trees, rows, views, and templates) makes each response grow with the
  // graph and can monopolize a small self-hosted runtime during JSON encoding.
  // Keep full items as the backwards-compatible default for explicit API
  // callers, while allowing the product runner to request the compact form.
  const compact = parseBoolean(body.compact, false);
  const discoveryWriteFence = (expectedItemGeneration: string | null) => ({
    expectedItemGeneration,
    ...(discoveryLease
      ? { extraExpectations: [discoveryLease.expectOwnedOperation()] }
      : {}),
  });
  const apiBase = notionApiBase(env);
  const previousNextCursor = optionalString((job.progress as Record<string, unknown> | undefined)?.nextCursor)
    ?? optionalString((job.report as Record<string, unknown> | undefined)?.nextCursor);
  // Once search has been fully paged through, resumed incremental chunks skip
  // re-scanning it from page 0 (otherwise every chunk re-fetches all search
  // pages — O(graph) redundant work that grows chunk time back into 503s and
  // stalls forward progress). Referenced items still surface via enrichment.
  const searchAlreadyComplete = parseBoolean(
    (job.progress as Record<string, unknown> | undefined)?.searchComplete,
    false,
  );
  const skipSearch = incremental && continueFromCursor && searchAlreadyComplete;
  const maxDiscoveryPages = parsePositiveInt(
    body.maxDiscoveryPages,
    Number((job.options as { maxDiscoveryPages?: unknown } | undefined)?.maxDiscoveryPages) || NOTION_SEARCH_PAGES_DEFAULT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const jobOptions = job.options as
    | {
        maxEnrichedItems?: unknown;
        maxChildrenPages?: unknown;
        maxDataSourceQueryPages?: unknown;
        maxViewPages?: unknown;
        maxTemplatePages?: unknown;
        discoveryConcurrency?: unknown;
        includeMarkdownFallback?: unknown;
        rootNotionDataSourceIds?: unknown;
      }
    | undefined;
  const rootNotionDataSourceIds = Array.isArray(job.rootNotionDataSourceIds) && job.rootNotionDataSourceIds.length
    ? job.rootNotionDataSourceIds
    : parseStringArray(jobOptions?.rootNotionDataSourceIds);
  const maxEnrichedItems = parsePositiveInt(
    body.maxEnrichedItems,
    Number(jobOptions?.maxEnrichedItems) || NOTION_ENRICHMENT_BATCH_SIZE,
    NOTION_ENRICHMENT_BATCH_SIZE_MAX,
  );
  const maxChildrenPages = parsePositiveInt(
    body.maxChildrenPages,
    Number(jobOptions?.maxChildrenPages) || NOTION_CHILDREN_PAGES_DEFAULT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxDataSourceQueryPages = parsePositiveInt(
    body.maxDataSourceQueryPages,
    Number(jobOptions?.maxDataSourceQueryPages) || NOTION_ROW_PAGES_DEFAULT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxViewPages = parsePositiveInt(
    body.maxViewPages,
    Number(jobOptions?.maxViewPages) || NOTION_VIEW_PAGES_DEFAULT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxTemplatePages = parsePositiveInt(
    body.maxTemplatePages,
    Number(jobOptions?.maxTemplatePages) || NOTION_TEMPLATE_PAGES_DEFAULT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const discoveryConcurrency = parsePositiveInt(
    body.discoveryConcurrency,
    Number(jobOptions?.discoveryConcurrency) || NOTION_DISCOVERY_CONCURRENCY_DEFAULT,
    NOTION_DISCOVERY_CONCURRENCY_MAX,
  );
  const includeMarkdownFallback = parseBoolean(
    body.includeMarkdownFallback,
    typeof jobOptions?.includeMarkdownFallback === 'boolean' ? jobOptions.includeMarkdownFallback : true,
  );
  // Per-call enrichment budget for incremental mode (small so a single discover
  // call stays fast). Non-incremental leaves this undefined -> infinite budget,
  // preserving one-shot convergence exactly.
  const enrichmentBudget = incremental
    ? parsePositiveInt(body.maxEnrichedItems, NOTION_ENRICH_BUDGET_DEFAULT, NOTION_ENRICHMENT_BATCH_SIZE_MAX)
    : undefined;
  // Compact incremental resume needs every durable graph identity for roots,
  // dedupe, counts, and relationship closure, but not every completed block
  // tree / row / view / template JSON. Project the scalar graph summary and
  // hydrate only the pending items this request can actually enrich. This keeps
  // late chunks O(enrichment budget) in heavy metadata rather than O(graph).
  let activeItemsBeforeDiscovery: NotionImportItem[] | undefined;
  let projectedExistingItems = false;
  const hydratedExistingNotionIds = new Set<string>();
  const completedSeedNotionIds = new Set<string>();
  const enrichmentStateBackfills: Array<Pick<
    NotionImportItem,
    'id' | 'enrichmentComplete'
  >> = [];
  if (incremental && compact) {
    const projectedSeeds = await listActiveNotionImportDiscoverySeeds(db, job);
    const hydratedSeeds = await hydrateNotionImportDiscoverySeeds(
      db,
      job,
      projectedSeeds,
      enrichmentBudget ?? maxEnrichedItems,
    );
    projectedExistingItems = true;
    for (const notionId of hydratedSeeds.keys()) hydratedExistingNotionIds.add(notionId);
    activeItemsBeforeDiscovery = projectedSeeds.map((seed) => (
      hydratedSeeds.get(seed.notionId) ?? seed
    ));
    for (const seed of projectedSeeds) {
      if (notionImportItemEnrichmentComplete(seed)) completedSeedNotionIds.add(seed.notionId);
    }
    // A legacy row can only reveal terminal database-reference state after its
    // targeted metadata hydration. Re-evaluate those few rows before discovery.
    for (const hydrated of hydratedSeeds.values()) {
      const enrichmentComplete = notionImportItemEnrichmentComplete(hydrated);
      if (typeof hydrated.enrichmentComplete !== 'boolean') {
        // Persist the resolved scalar under the discovery fence below. Without
        // this one-time backfill, the same first legacy terminal references are
        // hydrated on every bounded chunk and can starve later pending work.
        hydrated.enrichmentComplete = enrichmentComplete;
        enrichmentStateBackfills.push({
          id: hydrated.id,
          enrichmentComplete,
        });
      }
      if (enrichmentComplete) {
        completedSeedNotionIds.add(hydrated.notionId);
      } else {
        completedSeedNotionIds.delete(hydrated.notionId);
      }
    }
  } else if (incremental) {
    // Full-item API callers retain the backwards-compatible response/read path.
    activeItemsBeforeDiscovery = await listActiveNotionImportItems(db, job);
  }
  const seedItems: DiscoveredNotionItem[] = activeItemsBeforeDiscovery
    ? activeItemsBeforeDiscovery.map((item) => ({
        notionId: item.notionId,
        notionObject: item.notionObject,
        parentNotionId: item.parentNotionId,
        title: item.title,
        status: item.status,
        phase: item.phase,
        metadata: item.metadata,
        error: item.error,
      } as DiscoveredNotionItem))
    : [];
  // discoverNotionGraph keeps untouched seeds by reference and replaces the
  // object only when a graph edge enriches/touches it. This gives the durable
  // merge a bounded candidate set without serializing every accumulated
  // metadata tree merely to discover which records might have changed.
  const seedItemReferences = new Map(seedItems.map((item) => [item.notionId, item]));
  // In incremental mode, continuing without a search cursor is valid (search may
  // already be exhausted and we are only enriching seeded pending items); only
  // reject when there is nothing to continue from at all. Non-incremental keeps
  // seedItems empty, so this is identical to the original guard.
  if (continueFromCursor && !previousNextCursor && seedItems.length === 0) {
    throw new Error('No Notion search cursor is available to continue discovery.');
  }
  const startedAt = nowIso();
  const discoveryProgress = withImportProgress(job.progress, {
    key: 'discover',
    status: 'running',
    legacyStep: 'discovering_accessible_workspace_graph',
    percent: 25,
    message: continueFromCursor ? 'Continuing from the saved Notion search cursor.' : undefined,
    at: startedAt,
  });
  const startedJob = await updateNotionJobIfStatus(db, job.id, job.status, {
    status: 'discovering',
    phase: 'api_search',
    connectionId: tokenSource.connectionId ?? job.connectionId,
    connectionKind: tokenSource.connection?.connectionKind ?? job.connectionKind,
    error: null,
    startedAt,
    finishedAt: null,
    progress: {
      ...discoveryProgress,
      continuedFromCursor: continueFromCursor,
      searchStartCursor: continueFromCursor ? previousNextCursor : undefined,
    },
    options: {
      ...(job.options ?? {}),
      maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      maxTemplatePages,
      discoveryConcurrency,
      includeMarkdownFallback,
      connectionId: tokenSource.connectionId,
      credentialSource: tokenSource.credentialSource,
      tokenFingerprint: tokenSource.tokenFingerprint,
      tokenStored: false,
    },
  }, discoveryWriteFence(importItemGeneration(job)));
  if (!startedJob) {
    const current = await getExisting(jobs, job.id);
    if (current?.status === 'cancelled') return await currentNotionDiscoveryResult(db, current, compact);
    throw new Error('Notion import job state changed before discovery started.');
  }
  // Incremental merge keeps the existing generation. A one-shot replacement
  // atomically activates a new generation and returns that authoritative
  // pointer so terminal writes can follow it without another job read.
  let terminalItemGeneration = importItemGeneration(startedJob);
  // Persist a live progress snapshot at most ~once/sec while discovery runs, so
  // the polled step-3 panel shows the discovered count climbing and the bar
  // moving (25→~48%) instead of freezing at the initial 25%. Best-effort +
  // single-in-flight: a dropped write disables further advisory snapshots for
  // this request. The authoritative
  // ready/failed write must always land last, so finalizeDiscoveryProgress
  // stops new ticks and awaits the in-flight one before that final update —
  // otherwise a straggling throttled write could overwrite terminal progress
  // with a stale "running" snapshot.
  let lastProgressWriteMs = 0;
  let progressWriteInFlight: Promise<boolean> | null = null;
  let progressFinalized = false;
  const onDiscoveryProgress = (snapshot: DiscoveryProgressSnapshot) => {
    if (progressFinalized || progressWriteInFlight) return;
    const nowMs = Date.now();
    if (nowMs - lastProgressWriteMs < NOTION_DISCOVERY_PROGRESS_INTERVAL_MS) return;
    lastProgressWriteMs = nowMs;
    const percent = discoveryProgressPercent(snapshot);
    const write = updateNotionJobIfStatus(db, job.id, 'discovering', {
      progress: {
        ...withImportProgress(job.progress, {
          key: 'discover',
          status: 'running',
          legacyStep: 'discovering_accessible_workspace_graph',
          percent,
          counts: { discovered: snapshot.discovered, totalKnown: snapshot.discovered },
        }),
        discovered: snapshot.discovered,
        totalKnown: snapshot.discovered,
        byType: snapshot.byType,
        pendingEnrichment: snapshot.pendingEnrichment,
        recent: snapshot.recent,
      },
    }, discoveryWriteFence(importItemGeneration(startedJob))).then((updated) => {
      if (!updated) progressFinalized = true;
      return updated;
    });
    progressWriteInFlight = bestEffort(
      'notion-import discovery progress',
      write,
    ).then((succeeded) => {
      if (!succeeded) progressFinalized = true;
      return succeeded;
    });
    void progressWriteInFlight.finally(() => {
      progressWriteInFlight = null;
    });
  };
  const finalizeDiscoveryProgress = async () => {
    progressFinalized = true;
    const inFlight = progressWriteInFlight;
    if (inFlight) await inFlight.catch(() => {});
  };

  try {
    await backfillNotionImportDiscoveryEnrichmentState(
      db,
      startedJob,
      enrichmentStateBackfills,
      {
        expectedJobStatus: 'discovering',
        ...(discoveryLease
          ? {
              extraExpectations: [discoveryLease.expectOwnedOperation()],
              assertOwned: () => discoveryLease.assertOwned(),
            }
          : {}),
      },
    );
    const discovery = await discoverNotionGraph(tokenSource.token, {
      apiVersion: job.apiVersion || NOTION_API_VERSION,
      maxPages: maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      maxTemplatePages,
      discoveryConcurrency,
      includeMarkdownFallback,
      rootNotionPageIds: job.rootNotionPageIds ?? [],
      rootNotionDataSourceIds,
      startCursor: continueFromCursor ? previousNextCursor : undefined,
      seedItems: incremental ? seedItems : undefined,
      completedSeedNotionIds: incremental && compact ? completedSeedNotionIds : undefined,
      enrichmentBudget,
      perCallDeadlineMs: incremental ? NOTION_DISCOVER_CALL_DEADLINE_MS : undefined,
      skipSearch,
      notionWorkspace: cachedNotionWorkspaceForDiscovery(job, tokenSource),
      apiBase,
      onProgress: onDiscoveryProgress,
    });
    const missingRootPageIds = missingRequestedRootIds(job.rootNotionPageIds ?? [], discovery.items);
    if (missingRootPageIds.length) {
      throw new Error(
        `Notion import could not read requested root page(s): ${missingRootPageIds.join(', ')}. ` +
        'Share those page(s) and their linked databases with the configured Notion integration before importing.',
      );
    }
    const missingRootDataSourceIds = missingRequestedRootIds(rootNotionDataSourceIds, discovery.items);
    if (missingRootDataSourceIds.length) {
      throw new Error(
        `Notion import could not read requested root data source(s): ${missingRootDataSourceIds.join(', ')}. ` +
        'Share those data source(s) with the configured Notion integration before importing.',
      );
    }
    const currentDiscoveryItems = supplementalSnapshotItems.length
      ? expandSnapshotItems([...discovery.items, ...supplementalSnapshotItems])
      : discovery.items;
    // An expired request must never merge its in-memory graph after a newer
    // caller has reclaimed the durable discovery lock.
    await discoveryLease?.assertOwned();
    const beforeMerge = await getExisting(jobs, job.id);
    if (beforeMerge?.status === 'cancelled') {
      await deleteNotionImportJobItems(db, job.id);
      return {
        job: cleanJob(beforeMerge),
        ...(compact ? {} : { items: [] }),
      };
    }
    let discoveredItems: NotionImportItem[] | undefined;
    let totalKnown: number;
    let totalGraphCounts: Record<string, number>;
    if (incremental || continueFromCursor) {
      const existingItems = activeItemsBeforeDiscovery
        ?? await listActiveNotionImportItems(db, startedJob);
      // With no supplemental snapshot expansion, untouched seed objects retain
      // their reference through discoverNotionGraph. Persist only candidates
      // that were replaced/created in this chunk; mergeDiscoveredItems performs
      // the final value comparison so even a touched no-op produces no write.
      const mergeCandidates = incremental && supplementalSnapshotItems.length === 0
        ? discovery.items.filter((item) => seedItemReferences.get(item.notionId) !== item)
        : currentDiscoveryItems;
      const merged = await mergeDiscoveredItems(db, startedJob, mergeCandidates, {
        existingItems,
        projectedExistingItems,
        hydratedExistingNotionIds,
        includeItems: !compact,
        expectedJobStatus: 'discovering',
        ...(discoveryLease
          ? {
              extraExpectations: [discoveryLease.expectOwnedOperation()],
              assertOwned: () => discoveryLease.assertOwned(),
            }
          : {}),
      });
      discoveredItems = merged.items;
      totalKnown = merged.totalKnown;
      totalGraphCounts = merged.counts;
    } else {
      const replacement = await replaceDiscoveredItemsWithGeneration(
        db,
        startedJob,
        currentDiscoveryItems,
        {
          ...(discoveryLease
            ? {
                extraActivationExpectations: [discoveryLease.expectOwnedOperation()],
                assertOwned: () => discoveryLease.assertOwned(),
              }
            : {}),
        },
      );
      const replaced = replacement.items;
      terminalItemGeneration = replacement.activeItemGeneration;
      discoveredItems = compact ? undefined : replaced;
      totalKnown = replaced.length;
      totalGraphCounts = countImportItemsByObject(replaced);
    }
    const finishedAt = nowIso();
    // Composite completion signal for incremental mode: the job stays
    // 'discovering' (and hasMore stays true) while either search has more pages
    // or items remain pending enrichment; it becomes 'ready' only once both are
    // done. Non-incremental keeps the original search-only hasMore and 'ready'.
    const incrementalHasMore = discovery.hasMore || discovery.pendingEnrichment > 0;
    const compositeHasMore = incremental ? incrementalHasMore : discovery.hasMore;
    const discoveryWorkRemaining = incremental && incrementalHasMore;
    // Search is exhausted once a pass finishes with no more search pages (or we
    // already skipped it). Persist it so later resume chunks skip the re-scan.
    const searchComplete = skipSearch || searchAlreadyComplete || discovery.hasMore === false;
    await finalizeDiscoveryProgress();
    // Fence the terminal status write separately because a large durable merge
    // can itself take long enough for ownership to change after the first check.
    await discoveryLease?.assertOwned();
    const updated = await updateNotionJobIfStatus(db, job.id, 'discovering', {
      status: 'ready',
      // Incremental discovery keeps the job 'discovering' while work remains; the
      // spread overrides the base 'ready' above only when there is more to do.
      ...(discoveryWorkRemaining ? { status: 'discovering' } : {}),
      phase: discoveryWorkRemaining ? 'discovery_enrichment' : 'discovery_complete',
      // Every successful graph publication gets a new immutable revision.
      // Resumable apply may retain that exact graph in a bounded process cache;
      // a later discovery chunk or snapshot append necessarily invalidates it.
      itemSnapshotRevision: newId(),
      notionWorkspaceId: discovery.notionWorkspace.id,
      notionWorkspaceName: discovery.notionWorkspace.name,
      counts: totalGraphCounts,
      progress: {
        ...withImportProgress(discoveryProgress, {
          key: 'discover',
          status: discoveryWorkRemaining ? 'running' : 'completed',
          legacyStep: discoveryWorkRemaining
            ? 'discovering_accessible_workspace_graph'
            : 'ready_for_graph_planning',
          percent: discoveryWorkRemaining ? 48 : 50,
          at: finishedAt,
          counts: {
            discovered: currentDiscoveryItems.length,
            totalKnown,
            searchPagesFetched: discovery.searchPagesFetched,
          },
        }),
        discovered: currentDiscoveryItems.length,
        totalKnown,
        byType: totalGraphCounts,
        recent: discovery.recentActivity,
        hasMore: compositeHasMore,
        ...(incremental ? { pendingEnrichment: discovery.pendingEnrichment } : {}),
        searchComplete,
        nextCursor: discovery.nextCursor,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: discovery.searchStartCursor,
        searchPagesFetched: discovery.searchPagesFetched,
        discoveryPasses: discovery.discoveryPasses,
        searchCounts: discovery.counts,
      },
      report: baseReport({
        rootNotionPageIds: job.rootNotionPageIds ?? [],
        rootNotionDataSourceIds,
        tokenStored: false,
        connectionId: tokenSource.connectionId,
        credentialSource: tokenSource.credentialSource,
        apiVersion: job.apiVersion || NOTION_API_VERSION,
        hasMoreFromSearch: discovery.hasMore,
        nextCursor: discovery.nextCursor,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: discovery.searchStartCursor,
        searchPagesFetched: discovery.searchPagesFetched,
        discoveryPasses: discovery.discoveryPasses,
        discoveryConcurrency,
        includeMarkdownFallback,
        supplementalSnapshotItems: supplementalSnapshotItems.length,
        totalKnownItems: totalKnown,
        discoveredByObject: totalGraphCounts,
        currentDiscoveryByObject: discovery.graphCounts,
        searchDiscoveredByObject: discovery.counts,
        warnings: mergeImportReportEntries(job.report?.warnings, discovery.warnings),
        missingPermissions: mergeImportReportEntries(
          job.report?.missingPermissions,
          discovery.missingPermissions,
        ),
        unsupported: mergeImportReportEntries(job.report?.unsupported, discovery.unsupported),
      }),
      error: null,
      finishedAt: discoveryWorkRemaining ? null : finishedAt,
    }, discoveryWriteFence(terminalItemGeneration));
    if (!updated) {
      const current = await getExisting(jobs, job.id);
      if (current?.status === 'cancelled') {
        await deleteNotionImportJobItems(db, job.id);
        return {
          job: cleanJob(current),
          ...(compact ? {} : { items: [] }),
        };
      }
      throw new Error('Notion import job state changed before discovery completed.');
    }

    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.discover',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: {
        itemCount: totalKnown,
        pageItemCount: currentDiscoveryItems.length,
        counts: totalGraphCounts,
        currentDiscoveryCounts: discovery.graphCounts,
        searchCounts: discovery.counts,
        hasMore: discovery.hasMore,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: discovery.searchStartCursor,
        searchPagesFetched: discovery.searchPagesFetched,
        discoveryPasses: discovery.discoveryPasses,
        discoveryConcurrency,
        includeMarkdownFallback,
        supplementalSnapshotItems: supplementalSnapshotItems.length,
        warnings: discovery.warnings.length,
        missingPermissions: discovery.missingPermissions.length,
      },
      occurredAt: finishedAt,
    });

    return {
      job: cleanJob(updated),
      ...(compact ? {} : { items: (discoveredItems ?? []).map(cleanItem) }),
    };
  } catch (error) {
    await finalizeDiscoveryProgress();
    const current = await getExisting(jobs, job.id);
    if (error instanceof NotionDiscoveryLeaseLostError) {
      if (current) return await currentNotionDiscoveryResult(db, current, compact);
      throw error;
    }
    if (current && current.status !== 'discovering') {
      if (current.status === 'cancelled') {
        await deleteNotionImportJobItems(db, job.id);
        return {
          job: cleanJob(current),
          ...(compact ? {} : { items: [] }),
        };
      }
      return await currentNotionDiscoveryResult(db, current, compact);
    }
    // A heartbeat may have learned that another request owns the lock while
    // the Notion transport was independently failing. Re-check before this
    // stale request is allowed to mark the shared job failed.
    try {
      await discoveryLease?.assertOwned();
    } catch (leaseError) {
      if (leaseError instanceof NotionDiscoveryLeaseLostError && current) {
        return await currentNotionDiscoveryResult(db, current, compact);
      }
      throw leaseError;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    const failed = await updateNotionJobIfStatus(db, job.id, 'discovering', {
      status: 'failed',
      phase: 'discovery_failed',
      error: message,
      progress: {
        ...withImportProgress(discoveryProgress, {
          key: 'discover',
          status: 'failed',
          legacyStep: 'discovery_failed',
          message,
          at: failedAt,
        }),
      },
      report: {
        ...(job.report ?? baseReport()),
        lastError: message,
      },
      finishedAt: failedAt,
    }, discoveryWriteFence(terminalItemGeneration));
    if (!failed) {
      const latest = await getExisting(jobs, job.id);
      if (latest) return await currentNotionDiscoveryResult(db, latest, compact);
      throw error;
    }
    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.discover_failed',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: {
        error: message,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: continueFromCursor ? previousNextCursor : undefined,
        connectionId: tokenSource.connectionId,
        credentialSource: tokenSource.credentialSource,
        maxDiscoveryPages,
        maxEnrichedItems,
        maxChildrenPages,
        maxDataSourceQueryPages,
        maxViewPages,
        discoveryConcurrency,
        includeMarkdownFallback,
      },
      occurredAt: failedAt,
    });
    throw new Error(failed.error ?? message);
  }
}

  return {
    preflightJob,
    discoverJob,
    discoverJobUnderLease,
  };
}

type NotionImportJobReviewStatus =
  | 'queued'
  | 'discovering'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NotionImportJobReviewJob {
  id: string;
  workspaceId: string;
  status: NotionImportJobReviewStatus;
  phase: string;
  rootNotionPageIds?: string[];
  rootNotionDataSourceIds?: string[];
  options?: Record<string, unknown>;
  counts?: Record<string, number>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string | null;
  finishedAt?: string | null;
  activeItemGeneration?: string | null;
  itemSnapshotRevision?: string | null;
}

interface NotionImportJobReviewTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportJobReviewDb extends TransactDb {
  table<T>(name: string): NotionImportJobReviewTable<T>;
}

interface NotionImportDiscoveryLease {
  expectOwnedOperation(): TransactOperation;
  assertOwned(): Promise<void>;
  stop(): Promise<void>;
}

interface NotionImportReviewProgressEvent {
  key: 'discover' | 'review';
  status: 'running' | 'completed';
  legacyStep: string;
  percent: number;
  counts?: Record<string, unknown>;
  at?: string;
}

interface MergeDiscoveredItemsResult {
  totalKnown: number;
  counts: Record<string, number>;
  inserted: number;
  updated: number;
}

interface NotionImportReviewPlan {
  generatedAt: string;
  estimatedWrites: Record<string, number>;
  conversion: { summary: Record<string, unknown> };
}

export interface NotionImportJobReviewRuntime<
  Job extends NotionImportJobReviewJob,
  Item,
  SnapshotItem,
  Db extends NotionImportJobReviewDb,
  CleanJob,
  EmptyConversionReport,
  FinalizedConversionReport,
  Plan extends NotionImportReviewPlan,
> {
  requireString(value: unknown, name: string): string;
  assertWritableJob(db: Db, job: Job, actorId: string): Promise<void>;
  expandSnapshotItems(items: SnapshotItem[], maxItems: number): SnapshotItem[];
  parseSnapshotItems(value: unknown): SnapshotItem[];
  snapshotItemsPerRequestMax: number;
  assertBoundedRequestDiscoveredItems(items: SnapshotItem[], label: string): void;
  parseBoolean(value: unknown, fallback: boolean): boolean;
  optionalString(value: unknown): string | undefined;
  asRecord(value: unknown): Record<string, unknown> | undefined;
  assertBoundedSnapshotJsonValue(
    value: unknown,
    state: { bytes: number; nodes: number },
    label: string,
  ): void;
  acquireNotionApplyLease(
    db: Db,
    job: Job,
    actorId: string,
    purpose: 'discover',
  ): Promise<{ id: string; leaseId: string }>;
  startNotionDiscoveryLeaseHeartbeat(
    db: Db,
    lease: { id: string; leaseId: string },
  ): NotionImportDiscoveryLease;
  importItemGeneration(job: Job): string | null;
  listActiveNotionImportItems(db: Db, job: Job): Promise<Item[]>;
  mergeDiscoveredItems(
    db: Db,
    job: Job,
    items: SnapshotItem[],
    options: {
      existingItems: Item[];
      expectedJobStatus: Job['status'];
      extraExpectations: TransactOperation[];
      assertOwned: () => Promise<void>;
    },
  ): Promise<MergeDiscoveredItemsResult>;
  countImportItemsByObject(items: Iterable<Item>): Record<string, number>;
  withImportProgress(
    previousProgress: Record<string, unknown> | undefined,
    event: NotionImportReviewProgressEvent,
  ): Record<string, unknown>;
  baseReport(extra?: Record<string, unknown>): Record<string, unknown>;
  parseStringArray(value: unknown): string[];
  updateNotionJobIfStatus(
    db: Db,
    jobId: string,
    expectedStatus: Job['status'],
    data: Partial<NotionImportJobReviewJob>,
    options: {
      expectedItemGeneration?: string | null;
      extraExpectations?: TransactOperation[];
    },
  ): Promise<Job | null>;
  cleanJob(job: Job): CleanJob;
  NotionDiscoveryLeaseLostError: new (cause?: unknown) => Error;
  releaseNotionApplyLease(
    db: Db,
    lease: { id: string; leaseId: string },
  ): Promise<void>;
  isApplyLeaseConflict(error: unknown): boolean;
  emptyConversionReport(): EmptyConversionReport;
  finalizeConversionReport(report: EmptyConversionReport): FinalizedConversionReport;
  buildImportPlan(job: Job, items: Item[]): Plan;
}

export function createNotionImportJobReviewHandlers<
  Job extends NotionImportJobReviewJob,
  Item,
  SnapshotItem,
  Db extends NotionImportJobReviewDb,
  CleanJob,
  EmptyConversionReport,
  FinalizedConversionReport,
  Plan extends NotionImportReviewPlan,
>(runtime: NotionImportJobReviewRuntime<
  Job,
  Item,
  SnapshotItem,
  Db,
  CleanJob,
  EmptyConversionReport,
  FinalizedConversionReport,
  Plan
>) {
  const {
    requireString,
    assertWritableJob,
    expandSnapshotItems,
    parseSnapshotItems,
    snapshotItemsPerRequestMax: NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
    assertBoundedRequestDiscoveredItems,
    parseBoolean,
    optionalString,
    asRecord,
    assertBoundedSnapshotJsonValue,
    acquireNotionApplyLease,
    startNotionDiscoveryLeaseHeartbeat,
    importItemGeneration,
    listActiveNotionImportItems,
    mergeDiscoveredItems,
    countImportItemsByObject,
    withImportProgress,
    baseReport,
    parseStringArray,
    updateNotionJobIfStatus,
    cleanJob,
    NotionDiscoveryLeaseLostError,
    releaseNotionApplyLease,
    isApplyLeaseConflict,
    emptyConversionReport,
    finalizeConversionReport,
    buildImportPlan,
  } = runtime;
  type NotionImportJob = Job;
  type DbRef = Db;

  async function appendSnapshotItemsJob(
    db: DbRef,
    body: Record<string, unknown>,
    actorId: string,
  ) {
    const jobId = requireString(body.jobId, 'jobId');
    const jobs = db.table<NotionImportJob>('notion_import_jobs');
    const initialJob = await getExisting(jobs, jobId);
    if (!initialJob) throw new Error('Notion import job was not found.');
    await assertWritableJob(db, initialJob, actorId);
    if (initialJob.status === 'completed' || initialJob.status === 'cancelled') {
      throw new Error(`Cannot append discovery items to a ${initialJob.status} Notion import job.`);
    }

    const snapshotItems = expandSnapshotItems(
      parseSnapshotItems(body.snapshotItems),
      NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
    );
    assertBoundedRequestDiscoveredItems(snapshotItems, 'snapshotItems');
    const markReady = parseBoolean(body.markReady, false);
    const importedBatchId = optionalString(body.batchId);
    const clientDiscoveryState = asRecord(body.clientDiscoveryState);
    if (clientDiscoveryState) {
      assertBoundedSnapshotJsonValue(
        clientDiscoveryState,
        { bytes: 0, nodes: 0 },
        'clientDiscoveryState',
      );
    }
    // Snapshot/MCP append and live API discovery mutate the same graph. Use the
    // same discover lease so they serialize instead of reviving a cancelled job
    // or overwriting another request's active generation.
    const lease = await acquireNotionApplyLease(db, initialJob, actorId, 'discover');
    const discoveryLease = startNotionDiscoveryLeaseHeartbeat(db, lease);
    try {
      const job = await getExisting(jobs, jobId);
      if (!job) throw new Error('Notion import job was not found.');
      if (job.status === 'completed' || job.status === 'cancelled') {
        throw new Error(`Cannot append discovery items to a ${job.status} Notion import job.`);
      }
      const applyCursor = asRecord(asRecord(job.progress)?.applyCursor)
        ?? asRecord(asRecord(job.report)?.applyCursor);
      if (applyCursor || asRecord(job.progress)?.currentStep === 'apply') {
        throw Object.assign(
          new Error('Cannot append discovery items after Notion import apply has started.'),
          { code: 409 },
        );
      }
      const writeFence = {
        expectedItemGeneration: importItemGeneration(job),
        extraExpectations: [discoveryLease.expectOwnedOperation()],
      };
      const beforeItems = await listActiveNotionImportItems(db, job);
      const merged = snapshotItems.length
        ? await mergeDiscoveredItems(db, job, snapshotItems, {
            existingItems: beforeItems,
            expectedJobStatus: job.status,
            extraExpectations: writeFence.extraExpectations,
            assertOwned: () => discoveryLease.assertOwned(),
          })
        : {
            totalKnown: beforeItems.length,
            counts: countImportItemsByObject(beforeItems),
            inserted: 0,
            updated: 0,
          };
      const counts = merged.counts;
      const finishedAt = markReady ? nowIso() : undefined;
      const appendCounts = {
        appended: snapshotItems.length,
        totalKnown: merged.totalKnown,
        ...(importedBatchId ? { batchId: importedBatchId } : {}),
      };
      const progress = {
        ...withImportProgress(job.progress, {
          key: 'discover',
          status: markReady ? 'completed' : 'running',
          legacyStep: markReady ? 'ready_for_graph_planning' : 'chunked_discovery',
          percent: markReady ? 50 : 35,
          counts: appendCounts,
          at: finishedAt,
        }),
        discovered: merged.totalKnown,
        totalKnown: merged.totalKnown,
        chunkedDiscovery: true,
        lastBatchSize: snapshotItems.length,
        ...(importedBatchId ? { lastBatchId: importedBatchId } : {}),
        ...(clientDiscoveryState ? { clientDiscoveryState } : {}),
      };
      const patch: Partial<NotionImportJobReviewJob> = {
        status: markReady ? 'ready' : 'discovering',
        phase: markReady ? 'discovery_complete' : 'chunked_discovery',
        counts,
        progress,
        report: baseReport({
          ...(job.report ?? {}),
          rootNotionPageIds: job.rootNotionPageIds ?? [],
          rootNotionDataSourceIds: job.rootNotionDataSourceIds ??
            parseStringArray((job.options as { rootNotionDataSourceIds?: unknown } | undefined)?.rootNotionDataSourceIds),
          tokenStored: false,
          chunkedDiscovery: true,
          appendedSnapshotItems: ((job.report as { appendedSnapshotItems?: number } | undefined)?.appendedSnapshotItems ?? 0) +
            snapshotItems.length,
          discoveredByObject: counts,
          totalKnownItems: merged.totalKnown,
          ...(clientDiscoveryState ? { clientDiscoveryState } : {}),
        }),
        error: null,
        finishedAt: finishedAt ?? null,
        itemSnapshotRevision: newId(),
      };
      await discoveryLease.assertOwned();
      const updated = await updateNotionJobIfStatus(
        db,
        job.id,
        job.status,
        patch,
        writeFence,
      );
      if (!updated) {
        throw Object.assign(
          new Error('Notion import job changed before discovery items were appended.'),
          { code: 409 },
        );
      }

      await recordWorkspaceAudit(db, {
        workspaceId: job.workspaceId,
        actorId,
        action: markReady ? 'notion_import.discovery_finalize' : 'notion_import.discovery_append',
        targetType: 'notion_import_job',
        targetId: job.id,
        metadata: {
          ...(importedBatchId ? { batchId: importedBatchId } : {}),
          appended: snapshotItems.length,
          totalKnown: merged.totalKnown,
          counts,
          markReady,
        },
        occurredAt: nowIso(),
      });

      return {
        job: cleanJob(updated),
        appended: snapshotItems.length,
        totalKnown: merged.totalKnown,
        counts,
      };
    } catch (error) {
      if (error instanceof NotionDiscoveryLeaseLostError) {
        throw Object.assign(
          new Error('Notion import job is already being discovered.'),
          { code: 409 },
        );
      }
      throw error;
    } finally {
      await discoveryLease.stop();
      await releaseNotionApplyLease(db, lease).catch((error) => {
        if (!isApplyLeaseConflict(error)) {
          console.error('[notion-import] failed to release snapshot append lease:', error);
        }
      });
    }
  }

  async function planJob(db: DbRef, body: Record<string, unknown>, actorId: string) {
    const jobId = requireString(body.jobId, 'jobId');
    const jobs = db.table<NotionImportJob>('notion_import_jobs');
    const job = await getExisting(jobs, jobId);
    if (!job) throw new Error('Notion import job was not found.');
    await assertWritableJob(db, job, actorId);
    if (job.status !== 'ready') {
      const existingPlan = job.report && typeof job.report === 'object'
        ? (job.report as Record<string, unknown>).plan
        : undefined;
      return {
        job: cleanJob(job),
        plan: existingPlan ?? {
          status: 'blocked',
          generatedAt: nowIso(),
          counts: job.counts ?? {},
          estimatedWrites: {},
          conversion: finalizeConversionReport(emptyConversionReport()),
          canApply: false,
        },
      };
    }

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
    const plan = buildImportPlan(job, items);
    const updated = await jobs.update(job.id, {
      progress: {
        ...withImportProgress(job.progress, {
          key: 'review',
          status: 'completed',
          legacyStep: 'ready_for_import_review',
          percent: 60,
          counts: plan.estimatedWrites,
        }),
        plan: plan.estimatedWrites,
      },
      report: {
        ...(job.report ?? {}),
        plan,
      },
    } as unknown as Partial<NotionImportJob>);
    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.plan',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: {
        estimatedWrites: plan.estimatedWrites,
        conversionSummary: plan.conversion.summary,
      },
      occurredAt: plan.generatedAt,
    });
    return {
      job: cleanJob(updated),
      plan,
    };
  }

  return {
    appendSnapshotItemsJob,
    planJob,
  };
}
