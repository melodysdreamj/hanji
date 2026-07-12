import { afterEach, describe, expect, it, vi } from "vitest";
import { i18next } from "@/i18n";
import {
  addDays,
  addMonths,
  dateKey,
  extractEnd,
  extractTime,
  formatDate,
  formatDateForProperty,
  formatDateInput,
  formatNotionTimestamp,
  formatTime12,
  makeDate,
  monthCells,
  monthLabel,
  parseDate,
  parseDateDraft,
  parseTimeDraft,
  startOfMonth,
} from "@/components/database/dateUtils";

describe("dateKey", () => {
  it("formats Date objects as local YYYY-MM-DD", () => {
    expect(dateKey(new Date(2026, 6, 4))).toBe("2026-07-04");
    expect(dateKey(new Date(2026, 0, 1))).toBe("2026-01-01");
  });

  it("keeps zone-less day/datetime strings verbatim", () => {
    // A bare day, or a datetime with no zone marker, is a wall-clock value and
    // is never shifted off its literal calendar day.
    expect(dateKey("2026-07-04")).toBe("2026-07-04");
    expect(dateKey("2026-07-04T23:59:59")).toBe("2026-07-04");
  });

  it("resolves a zoned instant to the viewer's local calendar day", () => {
    // A value carrying an explicit zone (Z / offset) is an absolute instant whose
    // day depends on the viewer's timezone — it must match the local day the cell
    // displays (and the shared filter/sort engine), not the UTC day. Derived from
    // local Date methods so the assertion is independent of the runner's timezone.
    const iso = "2026-07-04T23:59:59Z";
    const d = new Date(iso);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    expect(dateKey(iso)).toBe(expected);
  });

  it("uses the start of {start, end} payloads", () => {
    expect(dateKey({ start: "2026-07-04", end: "2026-07-10" })).toBe("2026-07-04");
    expect(dateKey({ end: "2026-07-10" })).toBe("");
  });

  it("returns empty string for empty or invalid input", () => {
    expect(dateKey("")).toBe("");
    expect(dateKey(null)).toBe("");
    expect(dateKey(undefined)).toBe("");
    expect(dateKey("garbage")).toBe("");
  });
});

describe("makeDate", () => {
  it("builds valid dates", () => {
    const date = makeDate(2026, 7, 4);
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(6);
    expect(date?.getDate()).toBe(4);
  });

  it("rejects rolled-over dates", () => {
    expect(makeDate(2026, 2, 30)).toBeNull();
    expect(makeDate(2026, 13, 1)).toBeNull();
    expect(makeDate(2028, 2, 29)).not.toBeNull(); // leap year
    expect(makeDate(2027, 2, 29)).toBeNull();
  });
});

describe("parseDate", () => {
  it("parses ISO date strings to local dates", () => {
    const date = parseDate("2026-07-04");
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getDate()).toBe(4);
  });

  it("returns null for invalid input", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("nope")).toBeNull();
  });
});

describe("parseDateDraft", () => {
  it("parses ISO drafts", () => {
    expect(dateKey(parseDateDraft("2026-07-04"))).toBe("2026-07-04");
  });

  it("parses numeric M/D/Y drafts", () => {
    expect(dateKey(parseDateDraft("7/4/2026"))).toBe("2026-07-04");
    expect(dateKey(parseDateDraft("7.4.2026"))).toBe("2026-07-04");
  });

  it("applies fallbackYear to year-less slash drafts", () => {
    expect(dateKey(parseDateDraft("7/4", 2026))).toBe("2026-07-04");
    expect(dateKey(parseDateDraft("12.25", 2027))).toBe("2027-12-25");
  });

  it("expands two-digit slash years into the 2000s", () => {
    expect(dateKey(parseDateDraft("1/2/99"))).toBe("2099-01-02");
  });

  it("falls back to Date parsing for natural formats", () => {
    expect(dateKey(parseDateDraft("Jul 4, 2026"))).toBe("2026-07-04");
  });

  it("returns null for blank and invalid drafts", () => {
    expect(parseDateDraft("")).toBeNull();
    expect(parseDateDraft("   ")).toBeNull();
    expect(parseDateDraft("13/45")).toBeNull();
    expect(parseDateDraft("not a date")).toBeNull();
  });
});

describe("formatDateInput", () => {
  it("formats en-US medium dates and empty for null", () => {
    expect(formatDateInput(new Date(2026, 6, 4))).toBe("Jul 4, 2026");
    expect(formatDateInput(null)).toBe("");
  });
});

describe("month math", () => {
  it("startOfMonth returns the first day", () => {
    expect(dateKey(startOfMonth(new Date(2026, 6, 20)))).toBe("2026-07-01");
  });

  it("addDays crosses month boundaries", () => {
    expect(dateKey(addDays(new Date(2026, 6, 31), 1))).toBe("2026-08-01");
    expect(dateKey(addDays(new Date(2026, 6, 1), -1))).toBe("2026-06-30");
  });

  it("addMonths clamps to the last day of shorter months", () => {
    expect(dateKey(addMonths(new Date(2026, 0, 31), 1))).toBe("2026-02-28");
    expect(dateKey(addMonths(new Date(2026, 0, 15), 12))).toBe("2027-01-15");
  });

  it("monthCells returns a 42-day grid starting on Sunday", () => {
    const cells = monthCells(new Date(2026, 6, 15));
    expect(cells).toHaveLength(42);
    expect(cells[0].getDay()).toBe(0);
    // July 1 2026 is a Wednesday, so the grid starts June 28.
    expect(dateKey(cells[0])).toBe("2026-06-28");
    expect(cells.some((cell) => dateKey(cell) === "2026-07-31")).toBe(true);
  });

  it("monthLabel formats month + year", () => {
    expect(monthLabel(new Date(2026, 6, 4))).toBe("July 2026");
  });
});

describe("extractTime / formatTime12 / parseTimeDraft", () => {
  it("extracts HH:MM from datetime strings", () => {
    expect(extractTime("2026-07-04T09:30")).toBe("09:30");
    expect(extractTime("2026-07-04 21:05:00")).toBe("21:05");
    expect(extractTime("2026-07-04")).toBe("");
    expect(extractTime({ start: "2026-07-04T08:15" })).toBe("08:15");
  });

  it("formats 24h times as 12h with AM/PM", () => {
    expect(formatTime12("00:05")).toBe("12:05 AM");
    expect(formatTime12("09:30")).toBe("9:30 AM");
    expect(formatTime12("12:00")).toBe("12:00 PM");
    expect(formatTime12("23:45")).toBe("11:45 PM");
    expect(formatTime12("junk")).toBe("junk");
  });

  it("parses time drafts in 12h and 24h forms", () => {
    expect(parseTimeDraft("9")).toBe("09:00");
    expect(parseTimeDraft("9:30")).toBe("09:30");
    expect(parseTimeDraft("9pm")).toBe("21:00");
    expect(parseTimeDraft("12am")).toBe("00:00");
    expect(parseTimeDraft("12 PM")).toBe("12:00");
    expect(parseTimeDraft("23:59")).toBe("23:59");
  });

  it("rejects invalid time drafts", () => {
    expect(parseTimeDraft("")).toBeNull();
    expect(parseTimeDraft("25")).toBeNull();
    expect(parseTimeDraft("13pm")).toBeNull();
    expect(parseTimeDraft("9:75")).toBeNull();
    expect(parseTimeDraft("abc")).toBeNull();
  });
});

describe("extractEnd", () => {
  it("reads end from payloads and slash ranges", () => {
    expect(extractEnd({ start: "2026-07-04", end: "2026-07-10" })).toBe("2026-07-10");
    expect(extractEnd("2026-07-04/2026-07-10")).toBe("2026-07-10");
    expect(extractEnd("2026-07-04")).toBe("");
    expect(extractEnd({ start: "2026-07-04" })).toBe("");
    expect(extractEnd(null)).toBe("");
  });
});

describe("formatDate", () => {
  it("formats a single date (year shown for non-current years)", () => {
    expect(formatDate("2001-06-01")).toBe("Jun 1, 2001");
  });

  it("omits the year for current-year dates by default", () => {
    const year = new Date().getFullYear();
    expect(formatDate(`${year}-03-05`)).toBe("Mar 5");
  });

  it("formats ranges with an arrow", () => {
    expect(formatDate("2001-06-01/2001-06-05")).toBe("Jun 1, 2001 → Jun 5, 2001");
    expect(formatDate({ start: "2001-06-01", end: "2001-06-05" })).toBe(
      "Jun 1, 2001 → Jun 5, 2001"
    );
  });

  it("collapses same-day ranges with times to start → endTime", () => {
    expect(
      formatDate({ start: "2001-06-01T09:00", end: "2001-06-01T17:30" })
    ).toBe("Jun 1, 2001 9:00 AM → 5:30 PM");
  });

  it("appends times to single datetimes", () => {
    expect(formatDate("2001-06-01T14:00")).toBe("Jun 1, 2001 2:00 PM");
  });

  it("returns empty string for empty input", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate("")).toBe("");
  });
});

describe("formatDateForProperty", () => {
  afterEach(async () => {
    await i18next.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  it("uses Korean long format with year for Notion-imported date properties under a ko locale", async () => {
    vi.stubGlobal("navigator", { language: "ko-KR" });
    await i18next.changeLanguage("ko");
    expect(
      formatDateForProperty("2001-06-01", { config: { notionType: "date" } })
    ).toBe("2001년 6월 1일");
    expect(
      formatDateForProperty("2001-06-01", { config: { notion: { type: "date" } } })
    ).toBe("2001년 6월 1일");
  });

  it("uses the active locale's long format for Notion-imported date properties otherwise", () => {
    expect(
      formatDateForProperty("2001-06-01", { config: { notionType: "date" } })
    ).toBe("Jun 1, 2001");
  });

  it("uses the default format otherwise", () => {
    expect(formatDateForProperty("2001-06-01", { config: {} })).toBe("Jun 1, 2001");
  });
});

describe("formatNotionTimestamp", () => {
  afterEach(async () => {
    await i18next.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  it("formats timestamps in English with AM/PM by default", () => {
    // Build from a local date so the assertion is timezone-stable.
    const local = new Date(2026, 6, 4, 9, 5);
    expect(formatNotionTimestamp(local.toISOString())).toBe("July 4, 2026 9:05 AM");
    const evening = new Date(2026, 6, 4, 21, 5);
    expect(formatNotionTimestamp(evening.toISOString())).toBe("July 4, 2026 9:05 PM");
  });

  it("formats timestamps in Korean with 오전/오후 under a ko locale", async () => {
    vi.stubGlobal("navigator", { language: "ko-KR" });
    await i18next.changeLanguage("ko");
    const local = new Date(2026, 6, 4, 9, 5);
    expect(formatNotionTimestamp(local.toISOString())).toBe("2026년 7월 4일 오전 9:05");
    const evening = new Date(2026, 6, 4, 21, 5);
    expect(formatNotionTimestamp(evening.toISOString())).toBe("2026년 7월 4일 오후 9:05");
  });

  it("returns empty for empty and echoes unparseable input", () => {
    expect(formatNotionTimestamp("")).toBe("");
    expect(formatNotionTimestamp(null)).toBe("");
    expect(formatNotionTimestamp("garbage")).toBe("garbage");
  });
});
