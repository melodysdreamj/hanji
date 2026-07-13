import type { NotionImportJob } from "./types";

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Continue only when the server has persisted a real continuation boundary.
 *
 * A freshly deferred job is also `queued`, but has neither a cursor nor a
 * completed search pass. Sending `continueFromCursor:true` for that job makes
 * the backend correctly reject the request because there is no durable state
 * to continue from. Once a chunk commits, it persists either `nextCursor` or
 * `searchComplete` (the latter allows enrichment-only continuation from the
 * job's durable item generation).
 */
export function notionDiscoveryShouldContinue(job: Pick<NotionImportJob, "progress" | "report">) {
  const progress = job.progress ?? {};
  const report = job.report ?? {};
  return progress.searchComplete === true ||
    nonEmptyString(progress.nextCursor) ||
    nonEmptyString(report.nextCursor);
}

export const NOTION_DISCOVERY_STALL_LIMIT = 3;

export type NotionDiscoveryStallState = {
  marker: string;
  unchangedChunks: number;
};

function finiteProgressNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

/**
 * Tracks durable forward progress across successful discovery chunks while
 * ignoring timestamps and activity-ring churn. A chunk only counts as progress
 * when the job settles, the graph grows, the pending snapshot count drops, or
 * the continuation boundary changes.
 */
export function advanceNotionDiscoveryStallState(
  previous: NotionDiscoveryStallState | undefined,
  job: Pick<NotionImportJob, "status" | "progress">,
): NotionDiscoveryStallState {
  const progress = job.progress ?? {};
  const marker = [
    job.status,
    finiteProgressNumber(progress.totalKnown),
    finiteProgressNumber(progress.pendingEnrichment),
    progress.searchComplete === true ? "search-complete" : "search-open",
    nonEmptyString(progress.nextCursor) ? String(progress.nextCursor) : "no-cursor",
    progress.hasMore === true ? "more" : "settled",
  ].join("|");
  return {
    marker,
    unchangedChunks: previous?.marker === marker ? previous.unchangedChunks + 1 : 0,
  };
}
