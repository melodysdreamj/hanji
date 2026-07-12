import { afterEach, describe, expect, it } from "vitest";
import { i18next } from "@/i18n";

import {
  DEFAULT_DATABASE_TITLE,
  databaseTitleFromText,
  inlineDatabasePlaceholderTitle,
  inlineDatabaseTitleDisplay,
  meaningfulInlineDatabaseTitle,
} from "@/components/editor/databaseTitles";
import { untitledPageDisplayTitle } from "@/lib/pageTitle";

afterEach(async () => {
  await i18next.changeLanguage("en");
});

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

  it("preserves explicit titles even when they match display placeholders", () => {
    expect(meaningfulInlineDatabaseTitle("New database")).toBe("New database");
    expect(meaningfulInlineDatabaseTitle("Untitled database")).toBe("Untitled database");
    expect(meaningfulInlineDatabaseTitle(inlineDatabasePlaceholderTitle())).toBe("New database");
  });

  it("uses the active locale catalog rather than a hard-coded locale pair", async () => {
    await i18next.changeLanguage("ko");
    expect(inlineDatabasePlaceholderTitle()).toBe("새 데이터베이스");
    expect(meaningfulInlineDatabaseTitle(inlineDatabasePlaceholderTitle())).toBe("새 데이터베이스");
    expect(meaningfulInlineDatabaseTitle("프로젝트 데이터베이스")).toBe("프로젝트 데이터베이스");
  });
});

describe("inlineDatabaseTitleDisplay", () => {
  it("shows the placeholder (empty value) when the title is cleared", () => {
    const empty = inlineDatabaseTitleDisplay({ ownTitle: "" });
    expect(empty.isPlaceholder).toBe(true);
    expect(empty.text).toBe("New database");

    const whitespace = inlineDatabaseTitleDisplay({ ownTitle: "   " });
    expect(whitespace.isPlaceholder).toBe(true);

    const undefinedTitle = inlineDatabaseTitleDisplay({ ownTitle: undefined });
    expect(undefinedTitle.isPlaceholder).toBe(true);
  });

  it("must receive the raw title, never a display fallback (the cleared-title bug)", () => {
    // Feeding pageDisplayTitle()'s "Untitled" fallback in as the title was the
    // regression: a cleared title snapped back to a solid "Untitled" value.
    expect(inlineDatabaseTitleDisplay({ ownTitle: "" }).isPlaceholder).toBe(true);
    expect(
      inlineDatabaseTitleDisplay({ ownTitle: untitledPageDisplayTitle() }).isPlaceholder
    ).toBe(false);
  });

  it("keeps a user-typed title, including one matching a display fallback", () => {
    const typed = inlineDatabaseTitleDisplay({ ownTitle: "Project tracker" });
    expect(typed.isPlaceholder).toBe(false);
    expect(typed.text).toBe("Project tracker");

    const looksLikeFallback = inlineDatabaseTitleDisplay({ ownTitle: "Untitled" });
    expect(looksLikeFallback.isPlaceholder).toBe(false);
    expect(looksLikeFallback.text).toBe("Untitled");
  });

  it("prefers imported and resolved-linked titles over the raw own title", () => {
    expect(
      inlineDatabaseTitleDisplay({ ownTitle: "", importedSurfaceTitle: "Imported grid" })
    ).toEqual({ text: "Imported grid", isPlaceholder: false });

    expect(
      inlineDatabaseTitleDisplay({
        ownTitle: "Local name",
        resolvedLinkedTitle: "Linked source",
        preferResolvedLinked: true,
      })
    ).toEqual({ text: "Linked source", isPlaceholder: false });
  });
});
