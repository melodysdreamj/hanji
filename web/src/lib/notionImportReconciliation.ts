import type { NotionImportJob } from "./types";

const TERMINAL_STATUSES = new Set<NotionImportJob["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

const NONTERMINAL_STATUS_ORDER: Partial<Record<NotionImportJob["status"], number>> = {
  queued: 0,
  discovering: 1,
  ready: 2,
};

export function isNotionImportTerminal(job: Pick<NotionImportJob, "status">) {
  return TERMINAL_STATUSES.has(job.status);
}

export function isNotionImportProblemTerminal(job: Pick<NotionImportJob, "status">) {
  return job.status === "failed" || job.status === "cancelled";
}

/**
 * Explicit durable status always owns lifecycle classification. In particular,
 * a terminal job cannot be revived by a stale `progress.currentStatus` value.
 * A ready job with an active apply cursor remains resumable/live until the
 * server publishes a terminal status.
 */
export function isNotionImportLive(
  job: Pick<NotionImportJob, "status" | "progress">,
) {
  if (isNotionImportTerminal(job)) return false;
  if (job.status === "queued" || job.status === "discovering") return true;
  return job.status === "ready" && job.progress?.currentStatus === "running";
}

export function notionImportRevisionMs(
  job: Pick<
    NotionImportJob,
    "createdAt" | "updatedAt" | "finishedAt" | "cancelledAt"
  >,
) {
  let newest = Number.NEGATIVE_INFINITY;
  for (const value of [
    job.createdAt,
    job.updatedAt,
    job.finishedAt,
    job.cancelledAt,
  ]) {
    if (typeof value !== "string" || !value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) newest = Math.max(newest, parsed);
  }
  return newest;
}

/**
 * Reconcile two durable snapshots of one job.
 *
 * Once any terminal status has been observed, no later snapshot can change
 * that job's outcome, regardless of its status or timestamp. Before the
 * terminal fence, terminal snapshots outrank active snapshots and durable
 * revision/order resolves competing nonterminal progress payloads.
 */
export function reconcileNotionImportJob(
  current: NotionImportJob | null | undefined,
  incoming: NotionImportJob,
) {
  if (!current || current.id !== incoming.id) return incoming;
  const currentTerminal = isNotionImportTerminal(current);
  const incomingTerminal = isNotionImportTerminal(incoming);
  if (currentTerminal) return current;
  if (incomingTerminal && !currentTerminal) return incoming;

  const currentRevision = notionImportRevisionMs(current);
  const incomingRevision = notionImportRevisionMs(incoming);
  if (incomingRevision < currentRevision) return current;
  if (
    incomingRevision === currentRevision &&
    (NONTERMINAL_STATUS_ORDER[incoming.status] ?? 0) <
      (NONTERMINAL_STATUS_ORDER[current.status] ?? 0)
  ) {
    return current;
  }
  return incoming;
}

/**
 * A fresh mount may reopen only the newest job: a genuinely live job, or the
 * latest failed/cancelled job that needs an honest terminal explanation. Old
 * ready/completed jobs deliberately leave the wizard on a fresh Connect step.
 */
export function selectNotionImportJobForRemount(
  jobs: readonly NotionImportJob[],
) {
  const newest = jobs
    .map((job, index) => ({ job, index, revision: notionImportRevisionMs(job) }))
    .sort((left, right) =>
      right.revision - left.revision || left.index - right.index,
    )[0]?.job;
  if (!newest) return null;
  return isNotionImportLive(newest) || isNotionImportProblemTerminal(newest)
    ? newest
    : null;
}
