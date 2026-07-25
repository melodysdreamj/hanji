import { NOTION_REQUEST_MAX_ATTEMPTS, notionRequest, safeNotionRequest, type NotionRequestRetryInfo } from "./notion-api-client";
import {
  notionEnrichmentShouldStop,
  notionDiscoveryItemNeedsEnrichment,
  notionEnrichmentWaveSize,
  pushImportActivity,
  type DiscoveryProgressSnapshot,
  type NotionImportActivityEntry,
} from "./notion-import-discovery-progress";
import { normalizedNotionId, type DiscoveredNotionItem } from "./notion-import-request-limits";
import { newId } from "./table-utils";
import type {
  DiscoveryWarningBag,
  NotionImportItem,
} from "./notion-import-contracts";

interface LinkedNotionTargetReference {
  id: string;
  notionObject: 'page' | 'database' | 'data_source' | 'block';
  source?: 'block_payload' | 'rich_text_mention';
}

interface NotionDiscoveryPageSnapshot {
  childBlocks: Record<string, unknown>[];
  childPages: Array<{ id: string; title: string }>;
  childPageIds: string[];
  childDatabaseIds: string[];
}

interface NotionDiscoveryDataSourceSnapshot {
  [key: string]: unknown;
  dataSource: Record<string, unknown> | undefined;
  relationTargetReferences: Array<{
    id: string;
    notionObject: 'data_source' | 'database';
  }>;
  rowReferences: Array<{
    id: string | undefined;
    object: unknown;
    title: string;
    parentId: string | undefined;
    notionQueryOrder: number;
    createdTime: string | undefined;
    lastEditedTime: string | undefined;
    properties: unknown;
    icon: unknown;
    cover: unknown;
  }>;
  views: Record<string, unknown>[];
}

interface NotionDiscoveryDatabaseSnapshot {
  database: Record<string, unknown> | undefined;
  error: string | undefined;
  fetchStatus: 'retrieved' | 'retryable_error' | 'unavailable';
}

export interface NotionImportDiscoveryRuntime {
  NOTION_PREFLIGHT_SAMPLE_LIMIT: number;
  NOTION_DISCOVERY_PASS_SAFETY_LIMIT: number;
  optionalString(value: unknown): string | undefined;
  mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    callback: (item: T, index: number) => Promise<void>,
  ): Promise<void>;
  notionTitle(record: Record<string, unknown>): string;
  notionParentId(record: Record<string, unknown>): string | undefined;
  compactNotionMetadata(record: Record<string, unknown>): Record<string, unknown>;
  notionWorkspaceInfo(
    me: Record<string, unknown>,
  ): { id: string | undefined; name: string | undefined };
  putDiscoveredItem(
    items: Map<string, DiscoveredNotionItem>,
    item: DiscoveredNotionItem,
  ): void;
  hasDiscoveredNotionId(
    items: Map<string, DiscoveredNotionItem>,
    notionId: string,
  ): boolean;
  notionObjectId(record: Record<string, unknown>): string | undefined;
  itemMetadata(
    item: NotionImportItem | DiscoveredNotionItem,
  ): Record<string, unknown>;
  notionPropertiesFromSnapshot(
    snapshot: Record<string, unknown> | undefined,
  ): Record<string, unknown>;
  asRecord(value: unknown): Record<string, unknown> | undefined;
  notionPageIdsFromViewFilters(
    view: Record<string, unknown>,
    sourceProperties: Record<string, unknown>,
  ): string[];
  rawTemplatesFromSnapshot(
    snapshot: Record<string, unknown> | undefined,
  ): Record<string, unknown>[];
  flattenNotionBlocks(
    blocks: Record<string, unknown>[],
  ): Record<string, unknown>[];
  rawTemplateBlocks(template: Record<string, unknown>): Record<string, unknown>[];
  linkedNotionTargetReferencesFromBlock(
    block: Record<string, unknown>,
  ): LinkedNotionTargetReference[];
  collectPageSnapshot(
    token: string,
    item: DiscoveredNotionItem,
    apiVersion: string,
    maxChildrenPages: number,
    bag: DiscoveryWarningBag,
    apiBase?: string,
    onRetry?: (info: NotionRequestRetryInfo) => void,
    includeMarkdownFallback?: boolean,
  ): Promise<NotionDiscoveryPageSnapshot>;
  collectDatabaseSnapshot(
    token: string,
    databaseId: string,
    apiVersion: string,
    bag: DiscoveryWarningBag,
    apiBase?: string,
    onRetry?: (info: NotionRequestRetryInfo) => void,
  ): Promise<NotionDiscoveryDatabaseSnapshot>;
  collectDataSourceSnapshot(
    token: string,
    item: DiscoveredNotionItem,
    apiVersion: string,
    maxRowsPages: number,
    maxViewPages: number,
    maxTemplatePages: number,
    maxChildrenPages: number,
    bag: DiscoveryWarningBag,
    apiBase?: string,
    onRetry?: (info: NotionRequestRetryInfo) => void,
  ): Promise<{
    snapshot: NotionDiscoveryDataSourceSnapshot;
    reusableRowPagesById: Map<string, Record<string, unknown>>;
  }>;
  uniqueStrings(values: Array<string | undefined>): string[];
}

const NOTION_DISCOVERY_ENRICHMENT_TYPES = ['page', 'data_source', 'database'] as const;

/**
 * Builds one deterministic, bounded work window without letting a large page
 * tail monopolize every incremental call. The rotation seed advances with the
 * durable completed-item count, so even concurrency=1 plus a one-item deadline
 * gives each resource type a turn across resumed calls.
 */
export function fairNotionDiscoveryEnrichmentCandidates<
  T extends { notionObject: string },
>(
  pendingItems: readonly T[],
  maxItems: number,
  enrichmentBudget?: number,
  rotationSeed = 0,
): T[] {
  const maxLimit = Number.isFinite(maxItems)
    ? Math.max(0, Math.floor(maxItems))
    : pendingItems.length;
  const budgetLimit = enrichmentBudget !== undefined && Number.isFinite(enrichmentBudget)
    ? Math.max(0, Math.floor(enrichmentBudget))
    : pendingItems.length;
  const limit = Math.min(pendingItems.length, maxLimit, budgetLimit);
  if (limit === 0) return [];

  const queues = new Map<string, T[]>(
    NOTION_DISCOVERY_ENRICHMENT_TYPES.map((type) => [
      type,
      pendingItems.filter((item) => item.notionObject === type),
    ]),
  );
  const offsets = new Map<string, number>();
  const start = ((Math.floor(rotationSeed) % NOTION_DISCOVERY_ENRICHMENT_TYPES.length)
    + NOTION_DISCOVERY_ENRICHMENT_TYPES.length)
    % NOTION_DISCOVERY_ENRICHMENT_TYPES.length;
  const typeOrder = [
    ...NOTION_DISCOVERY_ENRICHMENT_TYPES.slice(start),
    ...NOTION_DISCOVERY_ENRICHMENT_TYPES.slice(0, start),
  ];
  const selected: T[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const type of typeOrder) {
      const queue = queues.get(type) ?? [];
      const offset = offsets.get(type) ?? 0;
      if (offset >= queue.length) continue;
      selected.push(queue[offset]);
      offsets.set(type, offset + 1);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

export async function discoverNotionGraphWithRuntime(
  token: string,
  options: {
    apiVersion: string;
    maxPages: number;
    maxEnrichedItems: number;
    maxChildrenPages: number;
    maxDataSourceQueryPages: number;
    maxViewPages: number;
    maxTemplatePages: number;
    includeMarkdownFallback: boolean;
    discoveryConcurrency: number;
    rootNotionPageIds: string[];
    rootNotionDataSourceIds: string[];
    startCursor?: string;
    // Incremental discovery: persisted items merged into the in-memory graph so
    // a resumed call skips already-enriched work, and a per-call cap on how many
    // items may be enriched before returning (leaving the rest pending).
    seedItems?: DiscoveredNotionItem[];
    // IDs represented by metadata-free projected seed rows whose durable item
    // already owns a complete snapshot. They remain in the graph for dedupe,
    // counts, roots, and relationship closure without being re-enriched.
    completedSeedNotionIds?: Set<string>;
    enrichmentBudget?: number;
    perCallDeadlineMs?: number;
    // Once the workspace /search has been fully paged through, resumed
    // incremental calls set this so they skip re-scanning the entire search
    // from page 0 every chunk (which is O(graph) redundant work that balloons
    // chunk time and re-triggers 503s). Referenced items still surface through
    // enrichment via seedItems, so search only needs to run to exhaustion once.
    skipSearch?: boolean;
    // Connection metadata, or job metadata observed under the same token, can
    // carry this display-only identity across incremental calls. Source reads
    // still authorize independently through Notion on every request.
    notionWorkspace?: { id?: string; name?: string };
    apiBase?: string;
    // Fired synchronously at search completion and after each item is enriched
    // so the caller can throttle-persist a live progress snapshot.
    onProgress?: (snapshot: DiscoveryProgressSnapshot) => void;
  },
  runtime: () => NotionImportDiscoveryRuntime,
) {
  const {
    NOTION_DISCOVERY_PASS_SAFETY_LIMIT,
    optionalString,
    mapWithConcurrency,
    notionTitle,
    notionParentId,
    compactNotionMetadata,
    notionWorkspaceInfo,
    putDiscoveredItem,
    hasDiscoveredNotionId,
    notionObjectId,
    itemMetadata,
    notionPropertiesFromSnapshot,
    asRecord,
    notionPageIdsFromViewFilters,
    rawTemplatesFromSnapshot,
    flattenNotionBlocks,
    rawTemplateBlocks,
    linkedNotionTargetReferencesFromBlock,
    collectPageSnapshot,
    collectDatabaseSnapshot,
    collectDataSourceSnapshot,
  } = runtime();

  // Live-activity ring surfaced through onProgress so the UI can show which
  // Notion items are being read right now (installer-style feed).
  const recentActivity: NotionImportActivityEntry[] = [];
  const bag: DiscoveryWarningBag = {
    warnings: [],
    missingPermissions: [],
    unsupported: [],
  };
  const retryWarningsSeen = new Set<string>();
  const onRetry = (retry: NotionRequestRetryInfo) => {
    const retryLabel = retry.status ? `HTTP ${retry.status}` : 'network error';
    const key = `${retry.method}:${retry.path}:${retryLabel}:${retry.nextAttempt}`;
    if (retryWarningsSeen.has(key)) return;
    retryWarningsSeen.add(key);
    if (bag.warnings.length >= 200) return;
    bag.warnings.push({
      code: 'notion_api_retry',
      notionObject: 'api_request',
      message:
        `Notion API ${retry.method} ${retry.path} returned ${retryLabel}; ` +
        `retrying attempt ${retry.nextAttempt}/${NOTION_REQUEST_MAX_ATTEMPTS}.`,
    });
  };
  const notionWorkspace = options.notionWorkspace ?? notionWorkspaceInfo(
    await notionRequest(token, '/users/me', options.apiVersion, { apiBase: options.apiBase, onRetry }),
  );
  const results: Record<string, unknown>[] = [];
  const searchStartCursor = options.startCursor;
  let cursor: string | undefined = searchStartCursor;
  let hasMore = false;
  let searchPagesFetched = 0;
  const rootScopedDiscovery =
    (options.rootNotionPageIds.length > 0 || options.rootNotionDataSourceIds.length > 0) &&
    !searchStartCursor;

  for (let page = 0; !options.skipSearch && !rootScopedDiscovery && page < options.maxPages; page += 1) {
    let response: Record<string, unknown>;
    try {
      response = await notionRequest(token, '/search', options.apiVersion, {
        method: 'POST',
        body: {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        apiBase: options.apiBase,
        onRetry,
      });
    } catch (error) {
      bag.missingPermissions.push({
        code: 'search_unavailable',
        notionObject: 'workspace',
        message: error instanceof Error ? error.message : String(error),
      });
      hasMore = false;
      cursor = undefined;
      break;
    }
    searchPagesFetched += 1;
    const pageResults = Array.isArray(response.results) ? response.results : [];
    results.push(...pageResults.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object'));
    hasMore = response.has_more === true;
    cursor = typeof response.next_cursor === 'string' ? response.next_cursor : undefined;
    if (!hasMore || !cursor) break;
  }

  const counts: Record<string, number> = {};
  const itemsById = new Map<string, DiscoveredNotionItem>();
  const completedSeedNotionIds = new Set(
    Array.from(options.completedSeedNotionIds ?? []).map(normalizedNotionId).filter(Boolean),
  );
  const needsEnrichment = (item: DiscoveredNotionItem) =>
    !completedSeedNotionIds.has(normalizedNotionId(item.notionId))
    && notionDiscoveryItemNeedsEnrichment(item);

  // Incremental resume: merge persisted items (status 'discovered'/'referenced',
  // with any snapshots already captured on earlier calls) into the in-memory
  // graph before this call's search results are folded on top. putDiscoveredItem
  // preserves snapshot phases and does not downgrade 'discovered' to 'referenced'.
  for (const seed of options.seedItems ?? []) {
    putDiscoveredItem(itemsById, seed);
  }

  // An item is "enriched" iff its snapshot metadata is present. These mirror the
  // exact metadata keys set by enrichPageItem (metadata.pageSnapshot) and
  // enrichDataSourceItem (metadata.dataSourceSnapshot); collectDatabaseReferences
  // stores the retrieved database under metadata.database.
  const hasPageSnapshot = (it: DiscoveredNotionItem) =>
    !!it.metadata && it.metadata.pageSnapshot != null;
  const hasDataSourceSnapshot = (it: DiscoveredNotionItem) =>
    !!it.metadata && it.metadata.dataSourceSnapshot != null;
  const hasDatabaseSnapshot = (it: DiscoveredNotionItem) =>
    it.notionObject === 'database' && !needsEnrichment(it);

  for (const record of results) {
    const notionObject = typeof record.object === 'string' ? record.object : 'unknown';
    counts[notionObject] = (counts[notionObject] ?? 0) + 1;
    const notionId = typeof record.id === 'string' ? record.id : newId();
    putDiscoveredItem(itemsById, {
      notionId,
      notionObject,
      parentNotionId: notionParentId(record),
      title: notionTitle(record),
      status: 'discovered',
      phase: 'search',
      metadata: {
        discoveredFrom: 'search',
        searchObject: record,
        ...compactNotionMetadata(record),
      },
    });
  }

  for (const rootPageId of options.rootNotionPageIds) {
    if (hasDiscoveredNotionId(itemsById, rootPageId)) continue;
    const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(rootPageId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    if (page.ok) {
      const pageNotionId = notionObjectId(page.data) ?? rootPageId;
      putDiscoveredItem(itemsById, {
        notionId: pageNotionId,
        notionObject: typeof page.data.object === 'string' ? page.data.object : 'page',
        parentNotionId: notionParentId(page.data),
        title: notionTitle(page.data),
        status: 'discovered',
        phase: 'root_page',
        metadata: {
          discoveredFrom: 'rootNotionPageIds',
          page: page.data,
          ...compactNotionMetadata(page.data),
        },
      });
      counts.root_page = (counts.root_page ?? 0) + 1;
    } else {
      bag.missingPermissions.push({
        code: 'root_page_unavailable',
        notionId: rootPageId,
        notionObject: 'page',
        message: page.error,
      });
    }
  }

  for (const rootDataSourceId of options.rootNotionDataSourceIds) {
    if (hasDiscoveredNotionId(itemsById, rootDataSourceId)) continue;
    const dataSource = await safeNotionRequest(
      token,
      `/data_sources/${encodeURIComponent(rootDataSourceId)}`,
      options.apiVersion,
      {
        apiBase: options.apiBase,
        onRetry,
      },
    );
    if (dataSource.ok) {
      const dataSourceNotionId = notionObjectId(dataSource.data) ?? rootDataSourceId;
      putDiscoveredItem(itemsById, {
        notionId: dataSourceNotionId,
        notionObject: typeof dataSource.data.object === 'string' ? dataSource.data.object : 'data_source',
        parentNotionId: notionParentId(dataSource.data),
        title: notionTitle(dataSource.data),
        status: 'discovered',
        phase: 'root_data_source',
        metadata: {
          discoveredFrom: 'rootNotionDataSourceIds',
          dataSource: dataSource.data,
          ...compactNotionMetadata(dataSource.data),
        },
      });
      counts.root_data_source = (counts.root_data_source ?? 0) + 1;
    } else {
      bag.missingPermissions.push({
        code: 'root_data_source_unavailable',
        notionId: rootDataSourceId,
        notionObject: 'data_source',
        message: dataSource.error,
      });
    }
  }

  const databaseIds = new Set<string>();
  const retrievedDatabaseIds = new Set<string>();
  // Select pending work rather than slicing the whole graph. Round-robin the
  // three enrichable resource types inside the actual per-call budget: pages
  // can continuously discover more pages, so processing every page before a
  // data source/database would otherwise starve those types on a large graph.
  const graphItemsBeforeEnrichment = Array.from(itemsById.values());
  const pendingItems = graphItemsBeforeEnrichment.filter(needsEnrichment);
  const completedEnrichmentCount = graphItemsBeforeEnrichment.filter((item) => (
    NOTION_DISCOVERY_ENRICHMENT_TYPES.includes(
      item.notionObject as (typeof NOTION_DISCOVERY_ENRICHMENT_TYPES)[number],
    ) && !needsEnrichment(item)
  )).length;
  const enrichable = fairNotionDiscoveryEnrichmentCandidates(
    pendingItems,
    options.maxEnrichedItems,
    options.enrichmentBudget,
    completedEnrichmentCount,
  );
  const enrichedPageIds = new Set<string>();
  // Per-call enrichment cap. Non-incremental callers leave it Infinity so the
  // graph converges in one pass exactly as before. Incremental callers pass a
  // small budget; enrichPageItem/enrichDataSourceItem each consume one unit and
  // early-return once it is spent, leaving the rest pending for a later call.
  let enrichBudget = options.enrichmentBudget ?? Number.POSITIVE_INFINITY;
  // Wall-clock bound (see NOTION_DISCOVER_CALL_DEADLINE_MS). Only trips after at
  // least one item is enriched so a single slow item can't make the client loop
  // spin without progress. Non-incremental callers leave the deadline Infinity
  // so convergence in one pass is unchanged.
  const enrichDeadlineMs = options.perCallDeadlineMs ?? Number.POSITIVE_INFINITY;
  const enrichStartedAt = Date.now();
  let enrichedThisCall = 0;
  const shouldStopEnrichment = () =>
    notionEnrichmentShouldStop({
      enrichBudget,
      enrichedThisCall,
      elapsedMs: Date.now() - enrichStartedAt,
      deadlineMs: enrichDeadlineMs,
    });
  const canEnrich = () => !shouldStopEnrichment();
  const putLinkedTargetReferences = (
    sourcePageId: string,
    blocks: Record<string, unknown>[],
  ) => {
    for (const block of blocks) {
      for (const target of linkedNotionTargetReferencesFromBlock(block)) {
        if (target.notionObject === 'database') {
          databaseIds.add(target.id);
        }
        if (target.notionObject === 'block') continue;
        putDiscoveredItem(itemsById, {
          notionId: target.id,
          notionObject: target.notionObject,
          parentNotionId: sourcePageId,
          status: 'referenced',
          phase: target.source === 'rich_text_mention' ? 'rich_text_mention_reference' : 'linked_block_reference',
          metadata: {
            discoveredFrom: target.source === 'rich_text_mention' ? 'rich_text_mention' : 'linked_block',
            sourcePageId,
            sourceBlockId: notionObjectId(block),
          },
        });
      }
    }
  };
  const enrichPageItem = async (item: DiscoveredNotionItem) => {
    if (enrichedPageIds.has(item.notionId)) return;
    if (!canEnrich()) return;
    enrichedPageIds.add(item.notionId);
    enrichBudget -= 1;
    enrichedThisCall += 1;
    let enrichedItem = item;
    let pageData = asRecord(item.metadata?.page);
    if (!pageData) {
      const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(item.notionId)}`, options.apiVersion, {
        apiBase: options.apiBase,
        onRetry,
      });
      if (page.ok) {
        pageData = page.data;
      } else {
        bag.missingPermissions.push({
          code: 'referenced_page_unavailable',
          notionId: item.notionId,
          notionObject: 'page',
          message: page.error,
        });
      }
    }
    if (pageData) {
      const pageParent = asRecord(pageData.parent);
      const pageParentId = notionParentId(pageData);
      const pageDataSourceId = pageParent?.type === 'data_source_id'
        ? optionalString(pageParent.data_source_id)
        : undefined;
      const pageProperties = asRecord(pageData.properties);
      enrichedItem = {
        ...item,
        parentNotionId: pageParentId ?? item.parentNotionId,
        title: item.title || notionTitle(pageData),
        status: 'discovered',
        metadata: {
          ...item.metadata,
          discoveredFrom: item.metadata?.discoveredFrom ?? 'page_reference',
          page: pageData,
          ...(pageDataSourceId ? { dataSourceId: pageDataSourceId } : {}),
          ...(pageProperties ? { properties: pageProperties } : {}),
          ...compactNotionMetadata(pageData),
        },
      };
    }
    const pageSnapshot = await collectPageSnapshot(
      token,
      enrichedItem,
      options.apiVersion,
      options.maxChildrenPages,
      bag,
      options.apiBase,
      onRetry,
      options.includeMarkdownFallback,
    );
    putDiscoveredItem(itemsById, {
      ...enrichedItem,
      phase: 'page_snapshot',
      metadata: {
        ...enrichedItem.metadata,
        pageSnapshot,
      },
    });

    const childPages = Array.isArray(pageSnapshot.childPages)
      ? pageSnapshot.childPages as Array<{ id?: unknown; title?: unknown }>
      : [];
    const childPageEntries: Array<{ id?: unknown; title?: unknown }> = childPages.length
      ? childPages
      : pageSnapshot.childPageIds.map((id: string) => ({ id }));
    for (const childPage of childPageEntries) {
      const childPageId = optionalString(childPage.id);
      if (!childPageId) continue;
      putDiscoveredItem(itemsById, {
        notionId: childPageId,
        notionObject: 'page',
        parentNotionId: enrichedItem.notionId,
        title: optionalString(childPage.title),
        status: 'referenced',
        phase: 'page_child_reference',
        metadata: { discoveredFrom: 'page_children', sourcePageId: enrichedItem.notionId },
      });
    }
    for (const childDatabaseId of pageSnapshot.childDatabaseIds) {
      databaseIds.add(childDatabaseId);
    }
    putLinkedTargetReferences(item.notionId, flattenNotionBlocks(pageSnapshot.childBlocks));
    pushImportActivity(recentActivity, {
      kind: 'read_page',
      title: enrichedItem.title || item.title,
    });
    reportProgress('enrich');
  };
  const enrichedDataSourceIds = new Set<string>();
  const enrichDataSourceItem = async (item: DiscoveredNotionItem) => {
    if (enrichedDataSourceIds.has(item.notionId)) return;
    if (!canEnrich()) return;
    enrichedDataSourceIds.add(item.notionId);
    enrichBudget -= 1;
    enrichedThisCall += 1;
    const dataSourceResult = await collectDataSourceSnapshot(
      token,
      item,
      options.apiVersion,
      options.maxDataSourceQueryPages,
      options.maxViewPages,
      options.maxTemplatePages,
      options.maxChildrenPages,
      bag,
      options.apiBase,
      onRetry,
    );
    const dataSourceSnapshot = dataSourceResult.snapshot;
    putDiscoveredItem(itemsById, {
      ...item,
      phase: 'data_source_snapshot',
      metadata: {
        ...item.metadata,
        dataSourceSnapshot,
      },
    });

    const parent = dataSourceSnapshot.dataSource?.parent;
    if (parent && typeof parent === 'object') {
      const databaseId = (parent as Record<string, unknown>).database_id;
      if (typeof databaseId === 'string') databaseIds.add(databaseId);
    }
    for (let rowIndex = 0; rowIndex < dataSourceSnapshot.rowReferences.length; rowIndex += 1) {
      const row = dataSourceSnapshot.rowReferences[rowIndex];
      if (!row.id) continue;
      const reusableRowPage = dataSourceResult.reusableRowPagesById.get(row.id);
      putDiscoveredItem(itemsById, {
        notionId: row.id,
        notionObject: String(row.object || 'page'),
        parentNotionId: item.notionId,
        title: row.title,
        status: 'referenced',
        phase: 'data_source_row_reference',
        metadata: {
          discoveredFrom: 'data_source_query',
          dataSourceId: item.notionId,
          notionQueryOrder: typeof row.notionQueryOrder === 'number' ? row.notionQueryOrder : rowIndex,
          ...(row.createdTime ? { createdTime: row.createdTime } : {}),
          ...(row.lastEditedTime ? { lastEditedTime: row.lastEditedTime } : {}),
          ...(reusableRowPage ? { page: reusableRowPage } : {}),
          properties: row.properties,
          icon: row.icon,
          cover: row.cover,
        },
      });
    }
    for (const target of dataSourceSnapshot.relationTargetReferences) {
      if (target.notionObject === 'database') databaseIds.add(target.id);
      putDiscoveredItem(itemsById, {
        notionId: target.id,
        notionObject: target.notionObject,
        parentNotionId: item.notionId,
        status: 'referenced',
        phase: 'relation_target_reference',
        metadata: {
          discoveredFrom: 'data_source_schema',
          dataSourceId: item.notionId,
        },
      });
    }
    const sourceProperties = notionPropertiesFromSnapshot(dataSourceSnapshot as Record<string, unknown>);
    for (let viewOrder = 0; viewOrder < dataSourceSnapshot.views.length; viewOrder += 1) {
      const view = dataSourceSnapshot.views[viewOrder];
      const viewId = notionObjectId(view);
      if (!viewId) continue;
      putDiscoveredItem(itemsById, {
        notionId: viewId,
        notionObject: 'view',
        parentNotionId: item.notionId,
        title: typeof view.name === 'string' ? view.name : notionTitle(view),
        status: 'discovered',
        phase: 'view_snapshot',
        metadata: {
          discoveredFrom: 'views',
          dataSourceId: item.notionId,
          viewOrder,
          view,
        },
      });
      for (const pageId of notionPageIdsFromViewFilters(view, sourceProperties)) {
        putDiscoveredItem(itemsById, {
          notionId: pageId,
          notionObject: 'page',
          status: 'referenced',
          phase: 'view_filter_row_reference',
          metadata: {
            discoveredFrom: 'view_filter',
            sourceDataSourceId: item.notionId,
            sourceViewId: viewId,
          },
        });
      }
    }
    for (const template of rawTemplatesFromSnapshot(dataSourceSnapshot as Record<string, unknown>)) {
      const templateId = notionObjectId(template) ?? item.notionId;
      putLinkedTargetReferences(templateId, flattenNotionBlocks(rawTemplateBlocks(template)));
    }
    pushImportActivity(recentActivity, {
      kind: 'read_data_source',
      title: item.title,
    });
    reportProgress('enrich');
  };
  const enrichDatabaseReference = async (databaseId: string) => {
    if (retrievedDatabaseIds.has(databaseId) || !canEnrich()) return;
    retrievedDatabaseIds.add(databaseId);
    enrichBudget -= 1;
    enrichedThisCall += 1;
    const result = await collectDatabaseSnapshot(
      token,
      databaseId,
      options.apiVersion,
      bag,
      options.apiBase,
      onRetry,
    );
    const database = result.database;
    putDiscoveredItem(itemsById, {
      notionId: databaseId,
      notionObject: 'database',
      title: database ? notionTitle(database) : undefined,
      status: database ? 'discovered' : 'referenced',
      phase: database ? 'database_snapshot' : 'database_reference',
      metadata: {
        discoveredFrom: database ? 'database_retrieve' : 'reference',
        databaseFetchStatus: result.fetchStatus,
        database,
        dataSources: Array.isArray(database?.data_sources) ? database.data_sources : undefined,
      },
      error: database ? null : result.error ?? 'Database details unavailable.',
    });
    if (Array.isArray(database?.data_sources)) {
      for (const dataSource of database.data_sources) {
        if (!dataSource || typeof dataSource !== 'object') continue;
        const dataSourceId = notionObjectId(dataSource as Record<string, unknown>);
        if (!dataSourceId) continue;
        putDiscoveredItem(itemsById, {
          notionId: dataSourceId,
          notionObject: 'data_source',
          parentNotionId: databaseId,
          title: notionTitle(dataSource as Record<string, unknown>),
          status: 'referenced',
          phase: 'database_data_source_reference',
          metadata: {
            discoveredFrom: 'database_data_sources',
            databaseId,
            dataSource,
          },
        });
      }
    }
    reportProgress('enrich');
  };
  const collectDatabaseReferences = async () => {
    const pendingDatabaseIds = Array.from(databaseIds)
      .filter((databaseId) => !retrievedDatabaseIds.has(databaseId))
      .slice(0, options.maxEnrichedItems);
    let offset = 0;
    while (offset < pendingDatabaseIds.length && canEnrich()) {
      // Start at most one concurrency-sized wave. Re-check the item budget and
      // wall-clock deadline between waves so a large linked-database tail can
      // never turn one incremental request into a multi-minute DO request.
      const waveSize = notionEnrichmentWaveSize({
        remaining: pendingDatabaseIds.length - offset,
        enrichBudget,
        concurrency: options.discoveryConcurrency,
      });
      if (waveSize <= 0) break;
      const wave = pendingDatabaseIds.slice(offset, offset + waveSize);
      offset += wave.length;
      await mapWithConcurrency(wave, options.discoveryConcurrency, async (databaseId) => {
        await enrichDatabaseReference(databaseId);
      });
    }
  };
  const enrichPendingDataSources = async () => {
    const dataSourceItems = Array.from(itemsById.values())
      .filter((item) => item.notionObject === 'data_source' && !enrichedDataSourceIds.has(item.notionId))
      .slice(0, options.maxEnrichedItems);
    await mapWithConcurrency(dataSourceItems, options.discoveryConcurrency, async (item) => {
      await enrichDataSourceItem(item);
    });
  };
  const enrichPendingRowPages = async () => {
    const rowPageItems = Array.from(itemsById.values())
      .filter((item) => {
        if (item.notionObject !== 'page' || enrichedPageIds.has(item.notionId)) return false;
        const metadata = itemMetadata(item);
        return item.phase === 'data_source_row_reference' || typeof metadata.dataSourceId === 'string';
      })
      .slice(0, options.maxEnrichedItems);
    await mapWithConcurrency(rowPageItems, options.discoveryConcurrency, async (item) => {
      await enrichPageItem(item);
    });
  };
  const enrichPendingReferencedPages = async () => {
    const pageItems = Array.from(itemsById.values())
      .filter((item) => {
        if (item.notionObject !== 'page' || enrichedPageIds.has(item.notionId)) return false;
        if (item.phase === 'data_source_row_reference') return false;
        const metadata = itemMetadata(item);
        return (
          item.status === 'referenced' ||
          item.phase === 'page_child_reference' ||
          item.phase === 'linked_block_reference' ||
          item.phase === 'rich_text_mention_reference' ||
          item.phase === 'relation_target_reference' ||
          typeof metadata.sourcePageId === 'string'
        );
      })
      .slice(0, options.maxEnrichedItems);
    await mapWithConcurrency(pageItems, options.discoveryConcurrency, async (item) => {
      await enrichPageItem(item);
    });
  };
  const discoveryStateKey = () =>
    [
      itemsById.size,
      enrichedPageIds.size,
      enrichedDataSourceIds.size,
      retrievedDatabaseIds.size,
    ].join(':');

  // All enrich* state is declared above; safe to close over now. Fires the
  // caller's throttled progress writer as each item is enriched.
  const enrichableTotal = enrichable.length;
  const reportProgress = (phase: DiscoveryProgressSnapshot['phase']) => {
    const byType: Record<string, number> = {};
    for (const item of itemsById.values()) {
      byType[item.notionObject] = (byType[item.notionObject] ?? 0) + 1;
    }
    const pendingEnrichment = Array.from(itemsById.values()).filter(
      needsEnrichment,
    ).length;
    options.onProgress?.({
      phase,
      discovered: itemsById.size,
      pendingEnrichment,
      enrichedPages: enrichedPageIds.size,
      enrichedDataSources: enrichedDataSourceIds.size,
      enrichableTotal,
      searchPagesFetched,
      byType,
      recent: recentActivity.slice(),
    });
  };
  // Incremental resume: pre-mark items whose snapshot was already captured on an
  // earlier call so this call's budget is spent only on still-pending work and
  // completed items are never re-fetched.
  for (const item of itemsById.values()) {
    if (item.notionObject === 'page' && (hasPageSnapshot(item) || !needsEnrichment(item))) {
      enrichedPageIds.add(item.notionId);
    } else if (item.notionObject === 'data_source' && (hasDataSourceSnapshot(item) || !needsEnrichment(item))) {
      enrichedDataSourceIds.add(item.notionId);
    } else if (item.notionObject === 'database' && hasDatabaseSnapshot(item)) {
      retrievedDatabaseIds.add(item.notionId);
    }
  }

  // Resumed chunks skip search entirely, so do not append another identical
  // "search complete" line every few seconds. Pre-mark persisted snapshots
  // before the first progress write so the processed count never jumps
  // backwards at the start of a chunk.
  if (!options.skipSearch) {
    pushImportActivity(recentActivity, {
      kind: 'search_complete',
      count: itemsById.size,
    });
  }
  reportProgress('search');

  await mapWithConcurrency(enrichable, options.discoveryConcurrency, async (item) => {
    if (item.notionObject === 'page') {
      await enrichPageItem(item);
    } else if (item.notionObject === 'data_source') {
      await enrichDataSourceItem(item);
    } else if (item.notionObject === 'database') {
      databaseIds.add(item.notionId);
      await enrichDatabaseReference(item.notionId);
    }
  });

  let discoveryPasses = 0;
  for (let pass = 0; pass < NOTION_DISCOVERY_PASS_SAFETY_LIMIT; pass += 1) {
    // Incremental mode: stop looping passes once the per-call enrichment budget
    // is spent. Un-enriched items simply stay pending for the next discover
    // call. Non-incremental callers keep an infinite budget so this never trips
    // and the loop still runs to convergence.
    if (shouldStopEnrichment()) break;
    discoveryPasses = pass + 1;
    const before = discoveryStateKey();
    await collectDatabaseReferences();
    await enrichPendingDataSources();
    await enrichPendingRowPages();
    await enrichPendingReferencedPages();
    const after = discoveryStateKey();
    if (after === before) break;
  }
  if (discoveryPasses >= NOTION_DISCOVERY_PASS_SAFETY_LIMIT) {
    bag.warnings.push({
      code: 'discovery_pass_safety_limit_reached',
      notionObject: 'workspace_graph',
      message:
        'Notion import reached the internal discovery pass safety limit before the graph stopped changing. ' +
        'The import may still be incomplete; rerun discovery or narrow the root if needed.',
    });
  }

  const items = Array.from(itemsById.values());
  const graphCounts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
    return acc;
  }, {});
  // Items still awaiting their snapshot: pages/data_sources without a captured
  // snapshot and databases not yet retrieved. In incremental mode a positive
  // count means the client should loop another discover call. In one-shot mode
  // the graph has converged so this is normally 0.
  const pendingEnrichment = items.filter(needsEnrichment).length;
  if (!hasMore && pendingEnrichment === 0) {
    pushImportActivity(recentActivity, {
      kind: 'discovery_complete',
      count: items.length,
    });
  }

  return {
    items,
    counts,
    graphCounts,
    recentActivity,
    warnings: bag.warnings,
    missingPermissions: bag.missingPermissions,
    unsupported: bag.unsupported,
    hasMore,
    pendingEnrichment,
    nextCursor: cursor,
    searchStartCursor,
    searchPagesFetched,
    discoveryPasses,
    notionWorkspace,
  };
}

export async function preflightNotionImportGraphWithRuntime(
  token: string,
  options: {
    apiVersion: string;
    rootNotionPageIds: string[];
    rootNotionDataSourceIds: string[];
    apiBase?: string;
  },
  runtime: () => NotionImportDiscoveryRuntime,
) {
  const {
    NOTION_PREFLIGHT_SAMPLE_LIMIT,
    notionTitle,
    notionParentId,
    notionWorkspaceInfo,
    notionObjectId,
    linkedNotionTargetReferencesFromBlock,
    uniqueStrings,
  } = runtime();

  const bag: DiscoveryWarningBag = {
    warnings: [],
    missingPermissions: [],
    unsupported: [],
  };
  const retryWarningsSeen = new Set<string>();
  const onRetry = (retry: NotionRequestRetryInfo) => {
    const retryLabel = retry.status ? `HTTP ${retry.status}` : 'network error';
    const key = `${retry.method}:${retry.path}:${retryLabel}:${retry.nextAttempt}`;
    if (retryWarningsSeen.has(key)) return;
    retryWarningsSeen.add(key);
    bag.warnings.push({
      code: 'notion_api_retry',
      notionObject: 'api_request',
      message:
        `Notion API ${retry.method} ${retry.path} returned ${retryLabel}; ` +
        `retrying attempt ${retry.nextAttempt}/${NOTION_REQUEST_MAX_ATTEMPTS}.`,
    });
  };
  const me = await notionRequest(token, '/users/me', options.apiVersion, { apiBase: options.apiBase, onRetry });
  const notionWorkspace = notionWorkspaceInfo(me);
  const roots: Record<string, unknown>[] = [];
  const directChildPages = new Set<string>();
  const directDatabaseIds = new Set<string>();
  const directDataSourceIds = new Set<string>();
  const rootNotionDataSourceIdSet = new Set(
    options.rootNotionDataSourceIds.map((id) => normalizedNotionId(id)).filter(Boolean),
  );
  for (const dataSourceId of options.rootNotionDataSourceIds) {
    directDataSourceIds.add(dataSourceId);
  }

  for (const rootPageId of options.rootNotionPageIds) {
    const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(rootPageId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    const rootReport: Record<string, unknown> = {
      notionId: rootPageId,
      notionObject: 'page',
      readable: page.ok,
    };
    if (!page.ok) {
      bag.missingPermissions.push({
        code: 'root_page_unavailable',
        notionId: rootPageId,
        notionObject: 'page',
        message: page.error,
      });
      roots.push({ ...rootReport, error: page.error });
      continue;
    }

    const pageId = notionObjectId(page.data) ?? rootPageId;
    const children = await safeNotionRequest(
      token,
      `/blocks/${encodeURIComponent(pageId)}/children`,
      options.apiVersion,
      {
        query: { page_size: 100 },
        apiBase: options.apiBase,
        onRetry,
      },
    );
    let childBlocks: Record<string, unknown>[] = [];
    if (children.ok) {
      childBlocks = Array.isArray(children.data.results)
        ? children.data.results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        : [];
    } else {
      bag.missingPermissions.push({
        code: 'page_children_unavailable',
        notionId: pageId,
        notionObject: 'page',
        message: children.error,
      });
    }

    const childPageIds = uniqueStrings(
      childBlocks
        .filter((block) => block.type === 'child_page')
        .map((block) => notionObjectId(block)),
    );
    const childDatabaseIds = uniqueStrings(
      childBlocks
        .filter((block) => block.type === 'child_database')
        .map((block) => notionObjectId(block)),
    );
    const linkedTargets = childBlocks.flatMap((block) => linkedNotionTargetReferencesFromBlock(block));
    for (const id of childPageIds) directChildPages.add(id);
    for (const id of childDatabaseIds) directDatabaseIds.add(id);
    for (const target of linkedTargets) {
      if (target.notionObject === 'page') directChildPages.add(target.id);
      if (target.notionObject === 'database') directDatabaseIds.add(target.id);
      if (target.notionObject === 'data_source') directDataSourceIds.add(target.id);
    }

    roots.push({
      ...rootReport,
      notionId: pageId,
      title: notionTitle(page.data),
      parentNotionId: notionParentId(page.data),
      childBlockSampleCount: childBlocks.length,
      childrenHasMore: children.ok ? children.data.has_more === true : undefined,
      directChildPages: childPageIds.slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT),
      directChildDatabases: childDatabaseIds.slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT),
      directLinkedTargets: linkedTargets.slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT),
    });
  }

  const sampledPages: Record<string, unknown>[] = [];
  for (const pageId of Array.from(directChildPages).slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT)) {
    const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(pageId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    sampledPages.push({
      notionId: pageId,
      readable: page.ok,
      title: page.ok ? notionTitle(page.data) : undefined,
      parentNotionId: page.ok ? notionParentId(page.data) : undefined,
      error: page.ok ? undefined : page.error,
    });
    if (!page.ok) {
      bag.missingPermissions.push({
        code: 'direct_child_page_unavailable',
        notionId: pageId,
        notionObject: 'page',
        message: page.error,
      });
    }
  }

  const sampledDatabases: Record<string, unknown>[] = [];
  for (const databaseId of Array.from(directDatabaseIds).slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT)) {
    const database = await safeNotionRequest(token, `/databases/${encodeURIComponent(databaseId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    const dataSources = database.ok && Array.isArray(database.data.data_sources)
      ? database.data.data_sources.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      : [];
    for (const dataSource of dataSources) {
      const dataSourceId = notionObjectId(dataSource);
      if (dataSourceId) directDataSourceIds.add(dataSourceId);
    }
    sampledDatabases.push({
      notionId: databaseId,
      readable: database.ok,
      title: database.ok ? notionTitle(database.data) : undefined,
      dataSourceIds: dataSources.map((item) => notionObjectId(item)).filter(Boolean),
      error: database.ok ? undefined : database.error,
    });
    if (!database.ok) {
      bag.missingPermissions.push({
        code: 'direct_database_unavailable',
        notionId: databaseId,
        notionObject: 'database',
        message: database.error,
      });
    }
  }

  const sampledDataSources: Record<string, unknown>[] = [];
  for (const dataSourceId of Array.from(directDataSourceIds).slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT)) {
    const isRootDataSource = rootNotionDataSourceIdSet.has(normalizedNotionId(dataSourceId));
    const dataSource = await safeNotionRequest(token, `/data_sources/${encodeURIComponent(dataSourceId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    let queryable = false;
    let rowSampleCount = 0;
    let rowsHasMore = false;
    let queryError: string | undefined;
    if (dataSource.ok) {
      const rows = await safeNotionRequest(
        token,
        `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
        options.apiVersion,
        {
          method: 'POST',
          body: { page_size: 10 },
          apiBase: options.apiBase,
          onRetry,
        },
      );
      queryable = rows.ok;
      rowSampleCount = rows.ok && Array.isArray(rows.data.results) ? rows.data.results.length : 0;
      rowsHasMore = rows.ok ? rows.data.has_more === true : false;
      queryError = rows.ok ? undefined : rows.error;
      if (!rows.ok) {
        bag.missingPermissions.push({
          code: 'direct_data_source_rows_unavailable',
          notionId: dataSourceId,
          notionObject: 'data_source',
          message: rows.error,
        });
      }
    }
    sampledDataSources.push({
      notionId: dataSourceId,
      root: isRootDataSource,
      readable: dataSource.ok,
      title: dataSource.ok ? notionTitle(dataSource.data) : undefined,
      queryable,
      rowSampleCount,
      rowsHasMore,
      error: dataSource.ok ? queryError : dataSource.error,
    });
    if (!dataSource.ok) {
      bag.missingPermissions.push({
        code: 'direct_data_source_unavailable',
        notionId: dataSourceId,
        notionObject: 'data_source',
        message: dataSource.error,
      });
    }
  }
  const sampledRootDataSources = sampledDataSources.filter((dataSource) =>
    dataSource.root === true,
  );

  return {
    notionWorkspace,
    apiVersion: options.apiVersion,
    rootNotionPageIds: options.rootNotionPageIds,
    rootNotionDataSourceIds: options.rootNotionDataSourceIds,
    roots,
    sampledPages,
    sampledDatabases,
    sampledDataSources,
    summary: {
      roots: roots.length,
      readableRoots: roots.filter((root) => root.readable === true).length,
      rootDataSources: options.rootNotionDataSourceIds.length,
      sampledRootDataSources: sampledRootDataSources.length,
      readableRootDataSources: sampledRootDataSources.filter((dataSource) => dataSource.readable === true).length,
      queryableRootDataSources: sampledRootDataSources.filter((dataSource) => dataSource.queryable === true).length,
      sampledPages: sampledPages.length,
      readableSampledPages: sampledPages.filter((page) => page.readable === true).length,
      sampledDatabases: sampledDatabases.length,
      readableSampledDatabases: sampledDatabases.filter((database) => database.readable === true).length,
      sampledDataSources: sampledDataSources.length,
      readableSampledDataSources: sampledDataSources.filter((dataSource) => dataSource.readable === true).length,
      queryableSampledDataSources: sampledDataSources.filter((dataSource) => dataSource.queryable === true).length,
      warnings: bag.warnings.length,
      missingPermissions: bag.missingPermissions.length,
    },
    warnings: bag.warnings,
    missingPermissions: bag.missingPermissions,
    unsupported: bag.unsupported,
  };
}
