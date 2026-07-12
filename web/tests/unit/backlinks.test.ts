import { describe, expect, it, vi } from "vitest";
import type { Block, Page } from "@/lib/types";

// backlinks.ts imports the EdgeBase client module at top level (for
// listAllBlocks); stub it so the pure helpers can be tested in node.
vi.mock("@/lib/edgebase", () => ({
  getAllBlocksRemote: vi.fn(async () => ({ blocks: [] })),
}));

const {
  blockReferenceKind,
  blockReferencePreview,
  mergedBlocks,
  pagePath,
  pageReferenceHits,
} = await import("@/lib/backlinks");

function makePage(id: string, patch: Partial<Page> = {}): Page {
  return {
    id,
    workspaceId: "ws",
    parentType: "workspace",
    kind: "page",
    title: `Page ${id}`,
    iconType: "emoji",
    position: 0,
    ...patch,
  } as Page;
}

function makeBlock(id: string, pageId: string, patch: Partial<Block> = {}): Block {
  return {
    id,
    pageId,
    type: "paragraph",
    position: 0,
    ...patch,
  } as Block;
}

describe("pagePath", () => {
  it("joins ancestor titles from root to parent", () => {
    const root = makePage("root", { title: "Root" });
    const mid = makePage("mid", { title: "Mid", parentId: "root" });
    const leaf = makePage("leaf", { title: "Leaf", parentId: "mid" });
    const byId = { root, mid, leaf };
    expect(pagePath(leaf, byId)).toBe("Root / Mid");
  });

  it("returns empty string for top-level pages", () => {
    const page = makePage("solo");
    expect(pagePath(page, { solo: page })).toBe("");
  });

  it("terminates on parent cycles, visiting each ancestor once", () => {
    const a = makePage("a", { parentId: "b" });
    const b = makePage("b", { parentId: "a" });
    expect(pagePath(a, { a, b })).toBe("Page a / Page b");
  });
});

describe("blockReferenceKind", () => {
  it("detects page mentions in rich text", () => {
    const block = makeBlock("b1", "p1", {
      content: { rich: [{ text: "@Target", mention: "page", pageId: "t1" }] },
    });
    expect(blockReferenceKind(block, "t1")).toBe("mention");
    expect(blockReferenceKind(block, "other")).toBeNull();
  });

  it("detects /p/ links in rich text", () => {
    const block = makeBlock("b1", "p1", {
      content: { rich: [{ text: "link", link: "/p/t1" }] },
    });
    expect(blockReferenceKind(block, "t1")).toBe("link");
  });

  it("prefers mention over link for the same target", () => {
    const block = makeBlock("b1", "p1", {
      content: {
        rich: [
          { text: "@Target", mention: "page", pageId: "t1" },
          { text: "also", link: "/p/t1" },
        ],
      },
    });
    expect(blockReferenceKind(block, "t1")).toBe("mention");
  });

  it("detects link_to_page child page ids", () => {
    const block = makeBlock("b1", "p1", {
      type: "link_to_page",
      content: { childPageId: "t1" },
    });
    expect(blockReferenceKind(block, "t1")).toBe("link");
  });

  it("detects mentions inside captions", () => {
    const block = makeBlock("b1", "p1", {
      type: "image",
      content: { caption: [{ text: "@T", mention: "page", pageId: "t1" }] },
    });
    expect(blockReferenceKind(block, "t1")).toBe("mention");
  });
});

describe("blockReferencePreview", () => {
  it("uses rich text when present", () => {
    const block = makeBlock("b1", "p1", {
      content: { rich: [{ text: " some text " }] },
    });
    expect(blockReferencePreview(block, "mention")).toBe("some text");
  });

  it("falls back to plainText, then to kind labels", () => {
    expect(
      blockReferencePreview(makeBlock("b1", "p1", { plainText: "plain" }), "link")
    ).toBe("plain");
    expect(blockReferencePreview(makeBlock("b2", "p1"), "mention")).toBe(
      "Mentioned this page"
    );
    expect(blockReferencePreview(makeBlock("b3", "p1"), "link")).toBe(
      "Linked to this page"
    );
    expect(
      blockReferencePreview(makeBlock("b4", "p1", { type: "link_to_page" }), "link")
    ).toBe("Linked page block");
  });
});

describe("mergedBlocks", () => {
  it("prefers local blocks for loaded pages and fetched blocks otherwise", () => {
    const fetchedA = makeBlock("f1", "a");
    const fetchedB = makeBlock("f2", "b");
    const localA = makeBlock("l1", "a");
    const out = mergedBlocks([fetchedA, fetchedB], { a: [localA], c: [makeBlock("l2", "c")] }, new Set(["a"]));
    expect(out.map((b) => b.id).sort()).toEqual(["f2", "l1"]);
  });
});

describe("pageReferenceHits", () => {
  const target = makePage("t1", { title: "Target" });
  const source = makePage("s1", { title: "Source", updatedAt: "2026-01-02" });

  it("collects hits pointing at a target page", () => {
    const block = makeBlock("b1", "s1", {
      content: { rich: [{ text: "@Target", mention: "page", pageId: "t1" }] },
    });
    const hits = pageReferenceHits([block], { t1: target, s1: source }, { targetPageId: "t1" });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("mention");
    expect(hits[0].page.id).toBe("s1");
    expect(hits[0].targetPage.id).toBe("t1");
    expect(hits[0].preview).toBe("@Target");
  });

  it("skips self references by default but includes them when asked", () => {
    const selfBlock = makeBlock("b1", "t1", {
      content: { rich: [{ text: "@me", mention: "page", pageId: "t1" }] },
    });
    expect(pageReferenceHits([selfBlock], { t1: target })).toHaveLength(0);
    expect(
      pageReferenceHits([selfBlock], { t1: target }, { includeSelfReferences: true })
    ).toHaveLength(1);
  });

  it("skips trashed source and target pages", () => {
    const trashedSource = makePage("s2", { inTrash: true });
    const block = makeBlock("b1", "s2", {
      content: { rich: [{ text: "x", mention: "page", pageId: "t1" }] },
    });
    expect(pageReferenceHits([block], { t1: target, s2: trashedSource })).toHaveLength(0);

    const trashedTarget = makePage("t2", { inTrash: true });
    const block2 = makeBlock("b2", "s1", {
      content: { rich: [{ text: "x", mention: "page", pageId: "t2" }] },
    });
    expect(pageReferenceHits([block2], { t2: trashedTarget, s1: source })).toHaveLength(0);
  });

  it("ignores blocks whose page is unknown", () => {
    const block = makeBlock("b1", "ghost", {
      content: { rich: [{ text: "x", mention: "page", pageId: "t1" }] },
    });
    expect(pageReferenceHits([block], { t1: target })).toHaveLength(0);
  });

  it("sorts by page recency first", () => {
    const older = makePage("old", { title: "Older", updatedAt: "2026-01-01" });
    const newer = makePage("new", { title: "Newer", updatedAt: "2026-02-01" });
    const blockOld = makeBlock("b1", "old", {
      content: { rich: [{ text: "x", mention: "page", pageId: "t1" }] },
    });
    const blockNew = makeBlock("b2", "new", {
      content: { rich: [{ text: "y", mention: "page", pageId: "t1" }] },
    });
    const hits = pageReferenceHits([blockOld, blockNew], {
      t1: target,
      old: older,
      new: newer,
    });
    expect(hits.map((h) => h.page.id)).toEqual(["new", "old"]);
  });
});
