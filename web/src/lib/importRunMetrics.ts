export type ImportRunMetrics = {
  rate: number;
};

const MIN_COMPLETED_SAMPLES = 5;
const MIN_ELAPSED_SECONDS = 10;

/**
 * Report the running average from the same durable total shown as processed.
 * The activity feed is deliberately bounded and sparse, so its retained entry
 * count cannot be used as a throughput numerator. Avoid presenting speed from
 * the first few objects because Notion object costs vary sharply.
 */
export function estimateImportRunMetrics(input: {
  doneCount?: number;
  elapsedSeconds: number;
}): ImportRunMetrics | undefined {
  const { doneCount, elapsedSeconds } = input;
  if (
    typeof doneCount !== "number" ||
    !Number.isFinite(doneCount) ||
    doneCount < MIN_COMPLETED_SAMPLES ||
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds < MIN_ELAPSED_SECONDS
  ) {
    return undefined;
  }

  const rate = doneCount / elapsedSeconds;
  if (!Number.isFinite(rate) || rate <= 0) return undefined;

  return { rate };
}
