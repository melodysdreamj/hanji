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
