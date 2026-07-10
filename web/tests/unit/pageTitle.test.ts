import { describe, expect, it } from "vitest";
import {
  databaseDisplayTitle,
  linkedDatabaseResolvedTitle,
  pageDisplayTitle,
} from "@/lib/pageTitle";

describe("pageDisplayTitle", () => {
  it("returns the trimmed title", () => {
    expect(pageDisplayTitle({ title: "  Hello  " })).toBe("Hello");
  });

  it("falls back to Untitled for empty or whitespace titles", () => {
    expect(pageDisplayTitle({ title: "" })).toBe("Untitled");
    expect(pageDisplayTitle({ title: "   " })).toBe("Untitled");
  });

  it("falls back to Untitled for null/undefined pages", () => {
    expect(pageDisplayTitle(undefined)).toBe("Untitled");
    expect(pageDisplayTitle(null)).toBe("Untitled");
  });

  it("keeps unicode titles intact", () => {
    expect(pageDisplayTitle({ title: "회의록 📝" })).toBe("회의록 📝");
  });
});

describe("linkedDatabaseResolvedTitle", () => {
  it("returns the trimmed resolved title property", () => {
    expect(
      linkedDatabaseResolvedTitle({
        properties: { notionLinkedDatabaseResolvedTitle: " Tasks " },
      })
    ).toBe("Tasks");
  });

  it("returns undefined for missing, blank, or non-string values", () => {
    expect(linkedDatabaseResolvedTitle({ properties: {} })).toBeUndefined();
    expect(
      linkedDatabaseResolvedTitle({
        properties: { notionLinkedDatabaseResolvedTitle: "  " },
      })
    ).toBeUndefined();
    expect(
      linkedDatabaseResolvedTitle({
        properties: { notionLinkedDatabaseResolvedTitle: 42 },
      })
    ).toBeUndefined();
    expect(linkedDatabaseResolvedTitle(undefined)).toBeUndefined();
    expect(linkedDatabaseResolvedTitle(null)).toBeUndefined();
  });
});

describe("databaseDisplayTitle", () => {
  it("prefers the linked-database resolved title", () => {
    expect(
      databaseDisplayTitle({
        title: "Local title",
        properties: { notionLinkedDatabaseResolvedTitle: "Resolved" },
      })
    ).toBe("Resolved");
  });

  it("falls back to the page title, then Untitled", () => {
    expect(databaseDisplayTitle({ title: "Local", properties: {} })).toBe("Local");
    expect(databaseDisplayTitle({ title: "", properties: {} })).toBe("Untitled");
    expect(databaseDisplayTitle(undefined)).toBe("Untitled");
  });
});
