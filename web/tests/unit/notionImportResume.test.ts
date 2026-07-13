import { describe, expect, it } from "vitest";

import {
  advanceNotionDiscoveryStallState,
  NOTION_DISCOVERY_STALL_LIMIT,
  notionDiscoveryShouldContinue,
} from "@/lib/notionImportResume";

describe("notionDiscoveryShouldContinue", () => {
  it("starts a fresh search for a newly deferred queued job", () => {
    expect(notionDiscoveryShouldContinue({
      progress: {
        currentStep: "discover",
        currentStatus: "pending",
        percent: 15,
      },
      report: { deferDiscovery: true },
    })).toBe(false);
  });

  it("continues from a persisted search cursor", () => {
    expect(notionDiscoveryShouldContinue({
      progress: { nextCursor: "cursor-2", searchComplete: false },
      report: {},
    })).toBe(true);
    expect(notionDiscoveryShouldContinue({
      progress: {},
      report: { nextCursor: "legacy-cursor" },
    })).toBe(true);
  });

  it("continues enrichment-only work after search completion without a cursor", () => {
    expect(notionDiscoveryShouldContinue({
      progress: { searchComplete: true, pendingEnrichment: 12 },
      report: {},
    })).toBe(true);
  });

  it("does not mistake transient display counts for a durable continuation boundary", () => {
    expect(notionDiscoveryShouldContinue({
      progress: { discovered: 25, totalKnown: 25, pendingEnrichment: 25 },
      report: {},
    })).toBe(false);
  });
});

describe("advanceNotionDiscoveryStallState", () => {
  const stalledJob = {
    status: "discovering" as const,
    progress: {
      totalKnown: 985,
      pendingEnrichment: 73,
      searchComplete: true,
      hasMore: true,
      recent: [{ at: "2026-07-13T09:20:00.000Z", kind: "search_complete" }],
    },
  };

  it("counts repeated successful chunks without durable progress", () => {
    let state = advanceNotionDiscoveryStallState(undefined, stalledJob);
    for (let index = 0; index < NOTION_DISCOVERY_STALL_LIMIT; index += 1) {
      state = advanceNotionDiscoveryStallState(state, {
        ...stalledJob,
        progress: {
          ...stalledJob.progress,
          recent: [{ at: `2026-07-13T09:20:0${index + 1}.000Z`, kind: "search_complete" }],
        },
      });
    }
    expect(state.unchangedChunks).toBe(NOTION_DISCOVERY_STALL_LIMIT);
  });

  it("resets when the pending count drops", () => {
    const previous = advanceNotionDiscoveryStallState(undefined, stalledJob);
    const repeated = advanceNotionDiscoveryStallState(previous, stalledJob);
    const progressed = advanceNotionDiscoveryStallState(repeated, {
      ...stalledJob,
      progress: { ...stalledJob.progress, pendingEnrichment: 48 },
    });
    expect(repeated.unchangedChunks).toBe(1);
    expect(progressed.unchangedChunks).toBe(0);
  });
});
