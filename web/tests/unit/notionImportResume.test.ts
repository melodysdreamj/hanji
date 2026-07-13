import { describe, expect, it } from "vitest";

import { notionDiscoveryShouldContinue } from "@/lib/notionImportResume";

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
