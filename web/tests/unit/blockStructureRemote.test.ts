// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in remote structure test.");
    }),
  };
});

import { useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser } from "./components/storeTestUtils";
import type { Block, CollaborationBlockStructureOperation } from "@/lib/types";

const PAGE = "page-structure";

function makeBlock(overrides: Partial<Block> & { id: string }): Block {
  return {
    id: overrides.id,
    pageId: PAGE,
    parentId: null,
    type: "paragraph",
    content: { rich: [{ text: overrides.plainText ?? "" }] },
    plainText: "",
    position: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Block;
}

function seedBlocks(blocks: Block[]) {
  useStore.setState((s) => ({
    blocksByPage: { ...s.blocksByPage, [PAGE]: blocks },
  }));
}

function pageBlocks(): Block[] {
  return useStore.getState().blocksByPage[PAGE] ?? [];
}

const structureOp = (
  overrides: Partial<CollaborationBlockStructureOperation>
): CollaborationBlockStructureOperation => ({
  engine: "block_structure",
  schemaVersion: 1,
  action: "move",
  blockIds: [],
  before: [],
  after: [],
  ...overrides,
});

beforeEach(() => {
  resetStore();
  seedUser();
  seedPages([makePage({ id: PAGE, title: "Structure page" })]);
});

describe("applyRemoteBlockStructure", () => {
  it("applies a remote move structurally while preserving newer local content", () => {
    seedBlocks([
      makeBlock({ id: "b1", position: 1 }),
      makeBlock({ id: "b2", position: 2, plainText: "local text", content: { rich: [{ text: "local text" }] } }),
    ]);

    useStore.getState().applyRemoteBlockStructure(
      PAGE,
      structureOp({
        action: "indent",
        blockIds: ["b2"],
        after: [
          {
            id: "b2",
            pageId: PAGE,
            parentId: "b1",
            position: 1,
            // Snapshot carries stale text — a structural apply must not clobber
            // the local content with it.
            plainText: "stale snapshot text",
            content: { rich: [{ text: "stale snapshot text" }] },
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        ],
      })
    );

    const b2 = pageBlocks().find((block) => block.id === "b2");
    expect(b2?.parentId).toBe("b1");
    expect(b2?.plainText).toBe("local text");
  });

  it("ignores a stale remote snapshot that is older than the local block", () => {
    seedBlocks([
      makeBlock({ id: "b1", position: 1 }),
      makeBlock({ id: "b2", position: 2, updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]);

    useStore.getState().applyRemoteBlockStructure(
      PAGE,
      structureOp({
        action: "move",
        blockIds: ["b2"],
        after: [
          { id: "b2", pageId: PAGE, parentId: "b1", position: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
        ],
      })
    );

    expect(pageBlocks().find((block) => block.id === "b2")?.parentId).toBeNull();
  });

  it("creates and deletes blocks from remote structure operations", () => {
    seedBlocks([makeBlock({ id: "b1", position: 1 })]);

    useStore.getState().applyRemoteBlockStructure(
      PAGE,
      structureOp({
        action: "create",
        blockIds: ["b2"],
        after: [
          {
            id: "b2",
            pageId: PAGE,
            parentId: null,
            position: 2,
            type: "to_do",
            plainText: "new remote block",
            content: { rich: [{ text: "new remote block" }], checked: false },
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        ],
      })
    );
    const created = pageBlocks().find((block) => block.id === "b2");
    expect(created?.type).toBe("to_do");
    expect(created?.plainText).toBe("new remote block");

    useStore.getState().applyRemoteBlockStructure(
      PAGE,
      structureOp({
        action: "delete",
        blockIds: ["b2"],
        before: [
          { id: "b2", pageId: PAGE, parentId: null, position: 2, updatedAt: "2026-01-01T00:02:00.000Z" },
        ],
      })
    );
    expect(pageBlocks().some((block) => block.id === "b2")).toBe(false);
  });

  it("does not resurrect an unknown block from a structural (move) snapshot", () => {
    seedBlocks([makeBlock({ id: "b1", position: 1 })]);

    useStore.getState().applyRemoteBlockStructure(
      PAGE,
      structureOp({
        action: "move",
        blockIds: ["ghost"],
        after: [{ id: "ghost", pageId: PAGE, parentId: null, position: 9 }],
      })
    );

    expect(pageBlocks().some((block) => block.id === "ghost")).toBe(false);
  });

  it("is a no-op for unloaded pages, locked pages, and foreign-page snapshots", () => {
    // Unloaded page: nothing materializes.
    useStore.getState().applyRemoteBlockStructure(
      "never-loaded",
      structureOp({
        action: "create",
        after: [{ id: "bx", pageId: "never-loaded", parentId: null, position: 1 }],
      })
    );
    expect(useStore.getState().blocksByPage["never-loaded"]).toBeUndefined();

    // Snapshot pointing at a different page is ignored.
    seedBlocks([makeBlock({ id: "b1", position: 1 })]);
    useStore.getState().applyRemoteBlockStructure(
      PAGE,
      structureOp({
        action: "create",
        after: [{ id: "intruder", pageId: "other-page", parentId: null, position: 1 }],
      })
    );
    expect(pageBlocks().some((block) => block.id === "intruder")).toBe(false);

    // Locked page: untouched.
    useStore.setState((s) => ({
      pagesById: { ...s.pagesById, [PAGE]: { ...s.pagesById[PAGE], isLocked: true } },
    }));
    useStore.getState().applyRemoteBlockStructure(
      PAGE,
      structureOp({
        action: "delete",
        before: [{ id: "b1", pageId: PAGE, parentId: null, position: 1 }],
      })
    );
    expect(pageBlocks().some((block) => block.id === "b1")).toBe(true);
  });
});
