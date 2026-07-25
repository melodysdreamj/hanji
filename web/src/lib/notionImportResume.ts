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

export function isNotionDiscoveryConflict(error: unknown) {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; status?: unknown; message?: unknown }
    : null;
  const status = Number(record?.status ?? record?.code);
  if (status === 409) return true;
  const message = error instanceof Error ? error.message : String(record?.message ?? error ?? "");
  return /HTTP 409\b/i.test(message);
}

export function notionImportOperationIsActive(result: { activeOperation?: unknown } | null | undefined) {
  return result?.activeOperation === "discover" || result?.activeOperation === "apply";
}

const NOTION_APPLY_RETRY_WAIT_SLICE_MS = 30_000;
const NOTION_APPLY_PHASE_SLACK_CHUNKS = 32;

function notionApplyCursor(job: Pick<NotionImportJob, "progress"> | null | undefined) {
  const value = job?.progress?.applyCursor;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = nonNegativeInteger(value);
  return parsed > 0 ? parsed : fallback;
}

function remainingBatches(total: unknown, current: unknown, batch: unknown, fallbackBatch: number) {
  const remaining = Math.max(0, nonNegativeInteger(total) - nonNegativeInteger(current));
  return Math.ceil(remaining / positiveInteger(batch, fallbackBatch));
}

/**
 * Gives the browser runner enough finite requests for the currently persisted
 * phase, then a small transition reserve. Every partial response recomputes
 * this bound from its newest cursor, so a later phase can extend the run
 * without a fixed whole-import ceiling (notably for more than 2,000 file
 * checkpoints).
 */
export function notionApplyRequestBudget(
  job: Pick<NotionImportJob, "progress"> | null | undefined,
  completedRequests = 0,
) {
  const cursor = notionApplyCursor(job);
  const phase = typeof cursor.phase === "string" ? cursor.phase : "";
  let remainingRequests = 1;
  if (phase === "apply_prepare") {
    remainingRequests = remainingBatches(cursor.totalItems, cursor.itemIndex, cursor.itemBatchSize, 5);
  } else if (phase === "apply_file_copies") {
    remainingRequests = remainingBatches(cursor.totalFiles, cursor.fileIndex, cursor.fileBatchSize, 10) + 1;
  } else if (phase === "apply_data_sources" || phase === "apply_global_remap") {
    remainingRequests = remainingBatches(
      cursor.totalDataSources,
      cursor.dataSourceIndex,
      cursor.dataSourceBatchSize,
      5,
    ) + 1;
  } else if (phase === "apply_database_containers") {
    const directRemaining = remainingBatches(
      cursor.totalDatabases,
      cursor.databaseIndex,
      cursor.databaseBatchSize,
      25,
    );
    const placeholderPass = cursor.databasePass === "placeholder"
      ? 0
      : remainingBatches(cursor.totalDatabases, 0, cursor.databaseBatchSize, 25);
    remainingRequests = directRemaining + placeholderPass + 1;
  } else if (phase === "apply_pages") {
    remainingRequests = remainingBatches(cursor.totalPages, cursor.pageIndex, cursor.pageBatchSize, 20) + 1;
  } else if (phase === "apply_remap") {
    remainingRequests = remainingBatches(cursor.totalPages, cursor.remapIndex, cursor.remapBatchSize, 20) + 1;
  } else if (phase === "apply_scrub") {
    remainingRequests = remainingBatches(cursor.totalItems, cursor.itemIndex, cursor.itemBatchSize, 20) + 1;
  } else if (phase === "apply_finalize_indexes") {
    remainingRequests = remainingBatches(
      cursor.totalMappings,
      cursor.mappingIndex,
      cursor.mappingBatchSize,
      25,
    ) + 1;
  }
  return Math.max(
    NOTION_APPLY_PHASE_SLACK_CHUNKS,
    nonNegativeInteger(completedRequests) + remainingRequests + NOTION_APPLY_PHASE_SLACK_CHUNKS,
  );
}

export const NOTION_APPLY_STALL_LIMIT = 3;
// The backend's exponential file-recovery schedule reaches its 30-second cap
// after six failures. Twelve durable failures therefore span more than the
// three-minute recovery TTL; keep the browser-owned automatic loop finite and
// leave the cursor ready for an explicit user retry after that point.
export const NOTION_APPLY_FILE_RECOVERY_RETRY_LIMIT = 12;

export function notionApplyFileRecoveryRetryLimitReached(
  job: Pick<NotionImportJob, "progress">,
) {
  const cursor = notionApplyCursor(job);
  return cursor.phase === "apply_file_copies" &&
    nonNegativeInteger(cursor.retryCount) >= NOTION_APPLY_FILE_RECOVERY_RETRY_LIMIT;
}

export type NotionApplyStallState = {
  marker: string;
  unchangedChunks: number;
};

/** Ignore display timestamps, but retain retryCount and durable write totals. */
export function advanceNotionApplyStallState(
  previous: NotionApplyStallState | undefined,
  job: Pick<NotionImportJob, "status" | "phase" | "progress">,
): NotionApplyStallState {
  const cursor = notionApplyCursor(job);
  const partialApplied = job.progress?.partialApplied;
  const appliedMarker = partialApplied && typeof partialApplied === "object"
    ? Object.entries(partialApplied as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}:${String(value)}`)
      .join(",")
    : "";
  const marker = [
    job.status,
    job.phase,
    cursor.phase,
    cursor.itemIndex,
    cursor.fileIndex,
    cursor.dataSourceIndex,
    cursor.databasePass,
    cursor.databaseIndex,
    cursor.pageIndex,
    cursor.remapIndex,
    cursor.mappingIndex,
    cursor.retryCount,
    appliedMarker,
  ].map((value) => String(value ?? "")).join("|");
  return {
    marker,
    unchangedChunks: previous?.marker === marker ? previous.unchangedChunks + 1 : 0,
  };
}

function notionApplyRetryAfterMs(
  job: Pick<NotionImportJob, "progress">,
  nowMs: number,
) {
  const rawRetryAfterAt = notionApplyCursor(job).retryAfterAt;
  if (typeof rawRetryAfterAt !== "string" || !rawRetryAfterAt.trim()) return 0;
  const retryAfterMs = Date.parse(rawRetryAfterAt);
  return Number.isFinite(retryAfterMs) && retryAfterMs > nowMs ? retryAfterMs : 0;
}

function waitForNotionApplyRetrySlice(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Honors a durable apply checkpoint's server-owned recovery deadline.
 *
 * A file checkpoint can return a successful partial response while asking the
 * browser runner not to re-enter apply until a future `retryAfterAt`. Waiting
 * in short timer slices keeps every individual timer bounded and lets cancel,
 * workspace changes, or component unmount stop the runner immediately without
 * issuing another product-write request. Missing, invalid, and elapsed
 * deadlines preserve the existing immediate partial-response cadence.
 */
export async function waitForNotionApplyRetryAfter(
  job: Pick<NotionImportJob, "progress">,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const retryAfterMs = notionApplyRetryAfterMs(job, now());
  if (!retryAfterMs) return !signal.aborted;
  while (!signal.aborted) {
    const remainingMs = retryAfterMs - now();
    if (remainingMs <= 0) return true;
    const completed = await waitForNotionApplyRetrySlice(
      Math.min(remainingMs, NOTION_APPLY_RETRY_WAIT_SLICE_MS),
      signal,
    );
    if (!completed) return false;
  }
  return false;
}

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
