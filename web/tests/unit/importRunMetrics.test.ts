import { describe, expect, it } from "vitest";

import { estimateImportRunMetrics } from "@/lib/importRunMetrics";

describe("estimateImportRunMetrics", () => {
  it("withholds a misleading ETA during the one-item warmup", () => {
    expect(estimateImportRunMetrics({
      doneCount: 1,
      totalCount: 36,
      elapsedSeconds: 28,
    })).toBeUndefined();
  });

  it("uses the stable running average after enough completed samples", () => {
    expect(estimateImportRunMetrics({
      doneCount: 12,
      totalCount: 36,
      elapsedSeconds: 40,
    })).toEqual({ rate: 0.3, remainingSeconds: 80 });
  });

  it("excludes first-page setup time when completion timestamps are available", () => {
    const start = Date.parse("2026-07-13T01:54:32.000Z");
    const now = start + 53_000;
    expect(estimateImportRunMetrics({
      doneCount: 11,
      totalCount: 36,
      elapsedSeconds: 53,
      nowMs: now,
      completionTimesMs: [30, 33, 34, 35, 36, 38, 40, 43, 45, 49, 51]
        .map((seconds) => start + seconds * 1000),
    })).toEqual({
      rate: 10 / 23,
      remainingSeconds: 57.5,
    });
  });

  it("continues withholding ETA until the post-setup sample window is credible", () => {
    const start = Date.parse("2026-07-13T01:54:32.000Z");
    expect(estimateImportRunMetrics({
      doneCount: 6,
      totalCount: 36,
      elapsedSeconds: 36,
      nowMs: start + 36_000,
      completionTimesMs: [30, 31, 32, 34, 35, 36].map((seconds) => start + seconds * 1000),
    })).toBeUndefined();
  });

  it("keeps speed but omits remaining time once all work is accounted for", () => {
    expect(estimateImportRunMetrics({
      doneCount: 36,
      totalCount: 36,
      elapsedSeconds: 90,
    })).toEqual({ rate: 0.4 });
  });
});
