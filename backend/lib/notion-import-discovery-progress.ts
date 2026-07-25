import type { DiscoveredNotionItem } from './notion-import-request-limits';
import { nowIso } from './table-utils';

export type DiscoveryProgressSnapshot = {
  phase: 'search' | 'enrich';
  discovered: number;
  pendingEnrichment: number;
  enrichedPages: number;
  enrichedDataSources: number;
  enrichableTotal: number;
  searchPagesFetched: number;
  byType: Record<string, number>;
  recent: NotionImportActivityEntry[];
};

// One structured live-activity event. The client localizes `kind`; titles are
// truncated so the ring stays small inside the persisted job progress JSON.
export type NotionImportActivityEntry = {
  at: string;
  kind: string;
  title?: string;
  count?: number;
  total?: number;
};

const NOTION_IMPORT_ACTIVITY_RING_LIMIT = 24;
const NOTION_IMPORT_ACTIVITY_TITLE_LIMIT = 80;

export function pushImportActivity(
  ring: NotionImportActivityEntry[],
  entry: { kind: string; title?: string; count?: number; total?: number },
) {
  ring.push({
    at: nowIso(),
    kind: entry.kind,
    ...(entry.title ? { title: entry.title.slice(0, NOTION_IMPORT_ACTIVITY_TITLE_LIMIT) } : {}),
    ...(entry.count !== undefined ? { count: entry.count } : {}),
    ...(entry.total !== undefined ? { total: entry.total } : {}),
  });
  if (ring.length > NOTION_IMPORT_ACTIVITY_RING_LIMIT) {
    ring.splice(0, ring.length - NOTION_IMPORT_ACTIVITY_RING_LIMIT);
  }
}

export function importActivityRingOf(progress: Record<string, unknown> | undefined): NotionImportActivityEntry[] {
  const raw = progress && typeof progress === 'object' ? (progress as { recent?: unknown }).recent : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is NotionImportActivityEntry =>
      !!item && typeof item === 'object' && typeof (item as { kind?: unknown }).kind === 'string',
  );
}

// Live discovery occupies the 25→48% band of the overall bar (apply owns
// 50→100). Search sits at 27; enrichment rises monotonically toward 48 with the
// fraction of enrichable items processed. Pure so it can be unit-guarded.
export function discoveryProgressPercent(
  snapshot: Pick<DiscoveryProgressSnapshot, 'phase' | 'enrichedPages' | 'enrichedDataSources' | 'enrichableTotal'>,
): number {
  if (snapshot.phase === 'search') return 27;
  const fraction = snapshot.enrichableTotal > 0
    ? Math.min(1, (snapshot.enrichedPages + snapshot.enrichedDataSources) / snapshot.enrichableTotal)
    : 0;
  return Math.min(48, 30 + Math.round(fraction * 18));
}

// Whether an incremental discover call should stop starting new item
// enrichment. Bounding a call by item count alone is not enough: one item can
// fan out to dozens of throttled (350ms) Notion subrequests, so a 25-item
// budget could still hold the Durable Object request open for minutes and
// overload it (503). This adds a wall-clock bound — but the deadline may only
// trip after at least one item has been enriched this call, so a single slow
// item can never make the client loop spin forever with zero progress.
// Extracted as a pure function so the exact stop rule stays regression-guarded
// (the overload it prevents only reproduces at real-workspace scale).
export function notionEnrichmentShouldStop(params: {
  enrichBudget: number;
  enrichedThisCall: number;
  elapsedMs: number;
  deadlineMs: number;
}): boolean {
  if (params.enrichBudget <= 0) return true;
  if (params.enrichedThisCall > 0 && params.elapsedMs > params.deadlineMs) return true;
  return false;
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Whether a discovered graph item still needs a source snapshot.
 *
 * Database reads can legitimately finish without a snapshot when Notion does
 * not expose the linked database to the integration. That terminal attempt is
 * persisted explicitly so a later incremental chunk does not retry the same
 * inaccessible reference forever.
 */
export function notionDiscoveryItemNeedsEnrichment(item: DiscoveredNotionItem): boolean {
  if (item.notionObject === 'page') {
    return !item.metadata || item.metadata.pageSnapshot == null;
  }
  if (item.notionObject === 'data_source') {
    return !item.metadata || item.metadata.dataSourceSnapshot == null;
  }
  if (item.notionObject === 'database') {
    const metadata = item.metadata ?? {};
    const fetchStatus = metadata.databaseFetchStatus;
    return asRecord(metadata.database) == null && fetchStatus !== 'retrieved' && fetchStatus !== 'unavailable';
  }
  return false;
}

export function notionDiscoveryEnrichmentCandidates(
  items: DiscoveredNotionItem[],
  maxItems: number,
): DiscoveredNotionItem[] {
  const limit = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : items.length;
  return items.filter(notionDiscoveryItemNeedsEnrichment).slice(0, limit);
}

export function notionEnrichmentWaveSize(params: {
  remaining: number;
  enrichBudget: number;
  concurrency: number;
}): number {
  const remaining = Math.max(0, Math.floor(params.remaining));
  const concurrency = Math.max(1, Math.floor(params.concurrency));
  const budget = Number.isFinite(params.enrichBudget)
    ? Math.max(0, Math.floor(params.enrichBudget))
    : remaining;
  return Math.min(remaining, concurrency, budget);
}
