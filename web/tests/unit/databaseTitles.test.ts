import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_TITLE,
  INLINE_DATABASE_PLACEHOLDER_TITLE,
  databaseTitleFromText,
  meaningfulInlineDatabaseTitle,
} from "@/components/editor/databaseTitles";

describe("database title defaults", () => {
  it("keeps command-created databases title-empty by default", () => {
    expect(DEFAULT_DATABASE_TITLE).toBe("");
    expect(databaseTitleFromText("")).toBe("");
    expect(databaseTitleFromText("   ")).toBe("");
    expect(databaseTitleFromText("/table")).toBe("");
    expect(databaseTitleFromText("database")).toBe("");
  });

  it("preserves an explicitly typed title, including New database", () => {
    expect(databaseTitleFromText("Project tracker")).toBe("Project tracker");
    expect(databaseTitleFromText("New database")).toBe("New database");
  });

  it("treats generated inline database labels as placeholders", () => {
    expect(meaningfulInlineDatabaseTitle("New database")).toBeUndefined();
    expect(meaningfulInlineDatabaseTitle("Untitled database")).toBeUndefined();
    expect(meaningfulInlineDatabaseTitle(INLINE_DATABASE_PLACEHOLDER_TITLE)).toBeUndefined();
  });
});
