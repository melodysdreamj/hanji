const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface NotionImportTerminalSweepUpload {
  expiredAt?: string | null;
  deletedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

function firstFiniteTimestamp(values: Array<string | null | undefined>) {
  for (const value of values) {
    const parsed = Date.parse(value ?? '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * A terminal Notion checkpoint can race a still-running large object put.
 * Re-arm idempotent deletes for as long as the tombstone exists. There is no
 * hard upper bound on a storage put, so clearing the marker after any fixed
 * horizon can strand bytes that arrive later. The due-index keeps selection
 * bounded, while age-based backoff lowers old tombstones to one attempt every
 * 30 days (the first sweep is scheduled by the terminal transition at +1h).
 */
export function nextNotionImportTerminalSweep(
  upload: NotionImportTerminalSweepUpload,
  nowMs = Date.now(),
) {
  const terminalAt = firstFiniteTimestamp([
    upload.expiredAt,
    upload.deletedAt,
    upload.updatedAt,
    upload.createdAt,
  ]);
  const ageMs = terminalAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - terminalAt);
  const retryAfterMs = ageMs < 7 * DAY_MS
    ? DAY_MS
    : ageMs < 30 * DAY_MS
      ? 7 * DAY_MS
      : 30 * DAY_MS;
  return {
    notionImportTerminalSweepAfter: new Date(nowMs + retryAfterMs).toISOString(),
    notionImportTerminalSweepCompletedAt: null,
  };
}
