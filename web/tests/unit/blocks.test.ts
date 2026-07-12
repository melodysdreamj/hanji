import { describe, expect, it } from "vitest";
import {
  BLOCK_DEFS,
  MD_SHORTCUTS,
  TEXT_BLOCKS,
  blockDefLabel,
  blockDefPlaceholder,
  getDef,
  matchBlocks,
} from "@/components/editor/blocks";
import { i18next } from "@/i18n";

describe("BLOCK_DEFS", () => {
  it("has unique keys (id or type)", () => {
    const keys = BLOCK_DEFS.map((def) => def.id ?? def.type);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps every user-visible placeholder in both language catalogs", () => {
    for (const def of BLOCK_DEFS.filter((item) => item.placeholder)) {
      const key = `blocks:defs.${def.id ?? def.type}.placeholder`;
      expect(i18next.exists(key, { lng: "en" }), key).toBe(true);
      expect(i18next.exists(key, { lng: "ko" }), key).toBe(true);
    }
  });
});

describe("getDef", () => {
  it("returns the first definition for a type", () => {
    expect(getDef("paragraph").label).toBe("Text");
    expect(getDef("heading_1").label).toBe("Heading 1");
    expect(getDef("child_database").label).toBe("Database - Full page");
  });

  it("falls back to paragraph for unknown types", () => {
    expect(getDef("nonexistent" as never).type).toBe("paragraph");
  });

  it("resolves labels and placeholders in the active language", async () => {
    const previousLanguage = i18next.language;
    try {
      await i18next.changeLanguage("ko");
      expect(blockDefLabel(getDef("paragraph"))).toBe("텍스트");
      expect(blockDefPlaceholder(getDef("paragraph"))).toBe("명령어를 사용하려면 '/'를 입력하세요");
      expect(blockDefLabel(getDef("heading_2"))).toBe("제목2");
      expect(blockDefPlaceholder(getDef("heading_2"))).toBe("제목2");
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });
});

describe("matchBlocks", () => {
  it("returns the full slash menu (minus hidden entries) for an empty query", () => {
    const results = matchBlocks("");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((def) => def.hiddenWhenEmpty)).toBe(false);
    // Curated order puts Text first, then Page.
    expect(results[0].label).toBe("Text");
    expect(results[1].label).toBe("Page");
  });

  it("ranks exact label matches first", () => {
    expect(matchBlocks("code")[0].label).toBe("Code");
    expect(matchBlocks("Quote")[0].label).toBe("Quote");
  });

  it("ranks label prefixes above keyword matches", () => {
    const results = matchBlocks("head");
    expect(results[0].label.startsWith("Head")).toBe(true);
  });

  it("matches by keyword", () => {
    expect(matchBlocks("kanban").some((def) => def.label.includes("Board"))).toBe(true);
    expect(matchBlocks("h1")[0].type).toBe("heading_1");
  });

  it("supports multi-token queries", () => {
    const results = matchBlocks("toggle heading");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((def) => `${def.label} ${def.description} ${def.keywords.join(" ")}`.toLowerCase().includes("toggle"))).toBe(true);
  });

  it("returns [] when nothing matches", () => {
    expect(matchBlocks("zzzz-no-such-block")).toEqual([]);
  });

  it("includes hidden color actions for color queries", () => {
    const results = matchBlocks("red background");
    expect(results.some((def) => def.colorToken === "red_background")).toBe(true);
  });

  it("is whitespace/case insensitive", () => {
    expect(matchBlocks("  CODE  ")[0].label).toBe("Code");
  });
});

describe("MD_SHORTCUTS", () => {
  const byTrigger = new Map(MD_SHORTCUTS.map((item) => [item.trigger, item]));

  it("maps heading and list triggers", () => {
    expect(byTrigger.get("#")?.type).toBe("heading_1");
    expect(byTrigger.get("####")?.type).toBe("heading_4");
    expect(byTrigger.get("-")?.type).toBe("bulleted_list_item");
    expect(byTrigger.get("1.")?.type).toBe("numbered_list_item");
  });

  it("maps to_do triggers with checked state", () => {
    expect(byTrigger.get("[]")).toMatchObject({ type: "to_do", content: { checked: false } });
    expect(byTrigger.get("[x]")).toMatchObject({ type: "to_do", content: { checked: true } });
  });

  it("has unique triggers", () => {
    expect(byTrigger.size).toBe(MD_SHORTCUTS.length);
  });
});

describe("TEXT_BLOCKS", () => {
  it("contains text-bearing types and excludes structural ones", () => {
    expect(TEXT_BLOCKS.has("paragraph")).toBe(true);
    expect(TEXT_BLOCKS.has("code")).toBe(true);
    expect(TEXT_BLOCKS.has("divider")).toBe(false);
    expect(TEXT_BLOCKS.has("column_list")).toBe(false);
    expect(TEXT_BLOCKS.has("image")).toBe(false);
  });
});
