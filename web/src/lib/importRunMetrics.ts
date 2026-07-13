export type ImportRunMetrics = {
  rate: number;
  remainingSeconds?: number;
};

const MIN_COMPLETED_SAMPLES = 5;
const MIN_ELAPSED_SECONDS = 10;
const MIN_SAMPLE_WINDOW_SECONDS = 15;

/**
 * Avoid presenting an ETA from the first one or two imported objects. Notion
 * objects vary sharply in cost, and the first page also includes setup work;
 * extrapolating that sample made the UI jump from minutes to seconds while a
 * perfectly healthy import was running.
 */
export function estimateImportRunMetrics(input: {
  doneCount?: number;
  totalCount?: number;
  elapsedSeconds: number;
  nowMs?: number;
  completionTimesMs?: number[];
}): ImportRunMetrics | undefined {
  const { doneCount, totalCount, elapsedSeconds, completionTimesMs } = input;
  if (
    typeof doneCount !== "number" ||
    !Number.isFinite(doneCount) ||
    doneCount < MIN_COMPLETED_SAMPLES ||
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds < MIN_ELAPSED_SECONDS
  ) {
    return undefined;
  }

  let rate: number;
  if (completionTimesMs?.length) {
    const samples = completionTimesMs.filter(Number.isFinite).sort((a, b) => a - b);
    if (samples.length < MIN_COMPLETED_SAMPLES) return undefined;
    // The first completion marks the end of connection/setup and the start of
    // observable item throughput. Include time since the newest completion so
    // a currently-slow item naturally lowers the estimate instead of leaving a
    // stale optimistic rate on screen.
    const windowSeconds = ((input.nowMs ?? Date.now()) - samples[0]) / 1000;
    if (!Number.isFinite(windowSeconds) || windowSeconds < MIN_SAMPLE_WINDOW_SECONDS) {
      return undefined;
    }
    rate = (samples.length - 1) / windowSeconds;
  } else {
    rate = doneCount / elapsedSeconds;
  }
  if (!Number.isFinite(rate) || rate <= 0) return undefined;

  const remaining =
    typeof totalCount === "number" && Number.isFinite(totalCount) && totalCount > doneCount
      ? (totalCount - doneCount) / rate
      : undefined;
  return { rate, ...(remaining !== undefined ? { remainingSeconds: remaining } : {}) };
}
