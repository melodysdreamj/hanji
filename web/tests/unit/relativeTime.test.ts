// @vitest-environment jsdom
//
// Shared en/ko relative-time helper (PageBacklinks, SearchDialog, RowMenu all
// render from this single dictionary instead of three English-only copies).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  menuTimestampLabel,
  relativeEditedLabel,
  relativeTimeLabels,
} from "@/lib/relativeTime";

// Local noon: keeps "today"/"yesterday" bucket math stable in any timezone.
const BASE_NOW = new Date(2026, 6, 10, 12, 0, 0);

function minutesAgo(minutes: number) {
  return new Date(BASE_NOW.getTime() - minutes * 60 * 1000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("relativeEditedLabel (en)", () => {
  it("formats the relative buckets", () => {
    expect(relativeEditedLabel(minutesAgo(0))).toBe("Edited just now");
    expect(relativeEditedLabel(minutesAgo(5))).toBe("Edited 5m ago");
    expect(relativeEditedLabel(minutesAgo(3 * 60))).toBe("Edited 3h ago");
    expect(relativeEditedLabel(minutesAgo(2 * 24 * 60))).toBe("Edited 2d ago");
  });

  it("returns empty for missing/unparseable stamps so callers chain fallbacks", () => {
    expect(relativeEditedLabel(undefined)).toBe("");
    expect(relativeEditedLabel("not a date")).toBe("");
    expect(relativeEditedLabel(undefined) || relativeTimeLabels().noEditsYet).toBe("No edits yet");
  });

  it("includes the year in the far-past fallback only when asked (RowMenu convention)", () => {
    const old = new Date(2024, 2, 5, 12, 0, 0).toISOString();
    expect(relativeEditedLabel(old)).toBe("Edited Mar 5");
    expect(relativeEditedLabel(old, { year: true })).toBe("Edited Mar 5, 2024");
  });
});

describe("menuTimestampLabel (en)", () => {
  it("formats today/yesterday/date buckets", () => {
    expect(menuTimestampLabel(undefined)).toBe("Just now");
    expect(menuTimestampLabel(minutesAgo(30))).toMatch(/^Today at /);
    expect(menuTimestampLabel(minutesAgo(24 * 60))).toMatch(/^Yesterday at /);
    expect(menuTimestampLabel(new Date(2026, 2, 1, 9, 30).toISOString())).toMatch(/^Mar 1 at /);
    expect(menuTimestampLabel(new Date(2024, 2, 1, 9, 30).toISOString())).toMatch(
      /^Mar 1, 2024 at /
    );
  });
});

describe("Korean locale", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { language: "ko-KR" });
  });

  it("renders Notion-style Korean relative labels", () => {
    expect(relativeEditedLabel(minutesAgo(0))).toBe("방금 편집됨");
    expect(relativeEditedLabel(minutesAgo(5))).toBe("5분 전 편집됨");
    expect(relativeEditedLabel(minutesAgo(3 * 60))).toBe("3시간 전 편집됨");
    expect(relativeEditedLabel(minutesAgo(2 * 24 * 60))).toBe("2일 전 편집됨");
    expect(relativeTimeLabels().noEdits).toBe("편집 기록 없음");
  });

  it("renders Korean menu timestamps with ko-KR time formatting", () => {
    expect(menuTimestampLabel(undefined)).toBe("방금");
    expect(menuTimestampLabel(minutesAgo(30))).toMatch(/^오늘 /);
    expect(menuTimestampLabel(minutesAgo(24 * 60))).toMatch(/^어제 /);
  });
});
