// @vitest-environment jsdom
//
// Cross-page block move as ONE logical undo unit (linked twin history
// entries), offline-safe ordering (local apply before the comments fetch),
// and per-page undo/redo serialization.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in cross-page move test.");
    }),
    getPageCommentsRemote: vi.fn(async () => ({ comments: [] })),
    createBlockRemote: vi.fn(async () => undefined),
    createBlocksRemote: vi.fn(async () => []),
    deleteBlockRemote: vi.fn(async () => undefined),
    deleteBlocksRemote: vi.fn(async () => undefined),
    updateBlockRemote: vi.fn(async () => undefined),
    updateBlocksRemote: vi.fn(async () => []),
    updateCommentsRemote: vi.fn(async () => []),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    recordCollaborationOperationRemote: vi.fn(async () => undefined),
  };
});

import {
  createBlockRemote,
  createBlocksRemote,
  deleteBlockRemote,
  deleteBlocksRemote,
  getPageCommentsRemote,
  updateBlockRemote,
  updateBlocksRemote,
  updateCommentsRemote,
} from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser } from "./components/storeTestUtils";
import type { Block } from "@/lib/types";

const NOW = new Date(0).toISOString();

function block(id: string, pageId: string, overrides: Partial<Block> = {}): Block {
  return {
    id,
    pageId,
    parentId: null,
    type: "paragraph",
    content: { rich: [{ text: id }] },
    plainText: id,
    position: 1,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "user-test",
    ...overrides,
  } as Block;
}

function blockIds(pageId: string) {
  return (useStore.getState().blocksByPage[pageId] ?? []).map((item) => item.id).sort();
}

function seedMoveFixture() {
  seedPages([
    makePage({ id: "pa", title: "Source" }),
    makePage({ id: "pb", title: "Target" }),
  ]);
  useStore.setState({
    blocksByPage: {
      pa: [block("b1", "pa", { position: 1 }), block("b2", "pa", { parentId: "b1", position: 2 })],
      pb: [block("b3", "pb", { position: 1 })],
    },
    loadedBlockPages: new Set(["pa", "pb"]),
  });
}

async function movedFixtureBlocks() {
  await useStore.getState().moveBlockToPage("b1", "pb");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStore();
  seedUser();
  seedMoveFixture();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("cross-page block move", () => {
  it("moves the block subtree and pushes linked twin history entries on both pages", async () => {
    await movedFixtureBlocks();

    expect(blockIds("pa")).toEqual([]);
    expect(blockIds("pb")).toEqual(["b1", "b2", "b3"]);
    const moved = useStore.getState().blocksByPage.pb.find((item) => item.id === "b1");
    expect(moved?.pageId).toBe("pb");
    expect(moved?.parentId).toBeNull();
    expect(vi.mocked(updateBlocksRemote)).toHaveBeenCalledTimes(1);

    const history = useStore.getState().blockHistoryByPage;
    const sourceEntry = history.pa?.past.at(-1);
    const targetEntry = history.pb?.past.at(-1);
    expect(sourceEntry?.link?.id).toBeTruthy();
    expect(sourceEntry?.link?.id).toBe(targetEntry?.link?.id);
    expect(sourceEntry?.link?.pageId).toBe("pb");
    expect(targetEntry?.link?.pageId).toBe("pa");
    expect(sourceEntry?.operations?.[0]?.action).toBe("move");
  });

  it("undo from the TARGET page restores both pages without any remote delete or create", async () => {
    await movedFixtureBlocks();
    vi.mocked(updateBlocksRemote).mockClear();

    await expect(useStore.getState().undoBlockChange("pb")).resolves.toBe(true);

    expect(blockIds("pa")).toEqual(["b1", "b2"]);
    expect(blockIds("pb")).toEqual(["b3"]);
    const restored = useStore.getState().blocksByPage.pa.find((item) => item.id === "b1");
    expect(restored?.pageId).toBe("pa");
    expect(useStore.getState().blocksByPage.pa.find((item) => item.id === "b2")?.parentId).toBe(
      "b1"
    );

    // The whole point of the linked entry: a structural update, never a
    // delete (which lost the block from BOTH pages) or a duplicate create.
    expect(vi.mocked(deleteBlockRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBlocksRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(createBlockRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(createBlocksRemote)).not.toHaveBeenCalled();
    const [updates] = vi.mocked(updateBlocksRemote).mock.calls.at(-1) ?? [];
    expect(
      (updates as Array<{ id: string; patch: { pageId?: string } }>).every(
        (item) => item.patch.pageId === "pa"
      )
    ).toBe(true);

    // The twin on the source stack is consumed (no double-undo left behind),
    // and both pages can redo.
    const history = useStore.getState().blockHistoryByPage;
    expect(history.pa?.past.some((entry) => entry.link)).toBe(false);
    expect(history.pb?.past.some((entry) => entry.link)).toBe(false);
    expect(history.pa?.future.at(-1)?.link?.id).toBeTruthy();
    expect(history.pb?.future.at(-1)?.link?.id).toBe(history.pa?.future.at(-1)?.link?.id);
  });

  it("undo from the SOURCE page behaves identically (no duplicate create)", async () => {
    await movedFixtureBlocks();

    await expect(useStore.getState().undoBlockChange("pa")).resolves.toBe(true);

    expect(blockIds("pa")).toEqual(["b1", "b2"]);
    expect(blockIds("pb")).toEqual(["b3"]);
    expect(vi.mocked(createBlockRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(createBlocksRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteBlockRemote)).not.toHaveBeenCalled();
    const history = useStore.getState().blockHistoryByPage;
    expect(history.pb?.past.some((entry) => entry.link)).toBe(false);
  });

  it("redo re-applies the move from either page and re-links the twins", async () => {
    await movedFixtureBlocks();
    await useStore.getState().undoBlockChange("pb");
    vi.mocked(updateBlocksRemote).mockClear();

    await expect(useStore.getState().redoBlockChange("pa")).resolves.toBe(true);

    expect(blockIds("pa")).toEqual([]);
    expect(blockIds("pb")).toEqual(["b1", "b2", "b3"]);
    const [updates] = vi.mocked(updateBlocksRemote).mock.calls.at(-1) ?? [];
    expect(
      (updates as Array<{ id: string; patch: { pageId?: string } }>).every(
        (item) => item.patch.pageId === "pb"
      )
    ).toBe(true);
    const history = useStore.getState().blockHistoryByPage;
    expect(history.pa?.past.at(-1)?.link?.id).toBeTruthy();
    expect(history.pb?.past.at(-1)?.link?.id).toBe(history.pa?.past.at(-1)?.link?.id);
    expect(history.pa?.future.some((entry) => entry.link)).toBe(false);
    expect(history.pb?.future.some((entry) => entry.link)).toBe(false);

    // And the redone move can be undone again from the other page.
    await expect(useStore.getState().undoBlockChange("pa")).resolves.toBe(true);
    expect(blockIds("pa")).toEqual(["b1", "b2"]);
    expect(blockIds("pb")).toEqual(["b3"]);
  });

  it("applies the move locally even when the comments fetch fails (offline), with a toast", async () => {
    vi.mocked(getPageCommentsRemote).mockRejectedValue(new Error("offline"));

    await movedFixtureBlocks();

    expect(blockIds("pa")).toEqual([]);
    expect(blockIds("pb")).toEqual(["b1", "b2", "b3"]);
    expect(vi.mocked(updateBlocksRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateCommentsRemote)).not.toHaveBeenCalled();
    expect(
      useStore.getState().toasts.some((toast) => toast.message.includes("comments"))
    ).toBe(true);

    // No stray history entry: undo still restores both pages atomically.
    await expect(useStore.getState().undoBlockChange("pb")).resolves.toBe(true);
    expect(blockIds("pa")).toEqual(["b1", "b2"]);
    expect(blockIds("pb")).toEqual(["b3"]);
  });

  it("migrates moved-block comments after a successful fetch", async () => {
    const comment = {
      id: "c1",
      pageId: "pa",
      blockId: "b1",
      parentId: null,
      authorId: "user-test",
      body: { rich: [{ text: "hi" }] },
      resolved: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    vi.mocked(getPageCommentsRemote).mockResolvedValue({ comments: [comment] });
    useStore.setState((s) => ({
      commentsByPage: { ...s.commentsByPage, pa: [comment] },
      loadedCommentPages: new Set(s.loadedCommentPages).add("pa"),
    }));

    await movedFixtureBlocks();

    expect(useStore.getState().commentsByPage.pa ?? []).toHaveLength(0);
    expect(vi.mocked(updateCommentsRemote)).toHaveBeenCalledTimes(1);
    const [patches] = vi.mocked(updateCommentsRemote).mock.calls[0];
    expect(patches).toEqual([{ id: "c1", patch: { pageId: "pb" } }]);
  });
});

describe("single-page undo (unchanged behavior)", () => {
  it("still restores a snapshot entry via the plain per-page path", async () => {
    useStore.getState().captureBlockHistory("pa");
    useStore.setState((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        pa: s.blocksByPage.pa.map((item) =>
          item.id === "b1"
            ? { ...item, content: { rich: [{ text: "edited" }] }, plainText: "edited" }
            : item
        ),
      },
    }));

    await expect(useStore.getState().undoBlockChange("pa")).resolves.toBe(true);

    expect(useStore.getState().blocksByPage.pa.find((item) => item.id === "b1")?.plainText).toBe(
      "b1"
    );
    expect(vi.mocked(updateBlockRemote)).toHaveBeenCalled();
    expect(blockIds("pb")).toEqual(["b3"]);
  });
});

describe("re-entrant undo serialization", () => {
  it("queues a second Cmd+Z fired during the first undo's persist (two undos, not one)", async () => {
    // Two history entries: v0 -> v1 -> v2 (current).
    useStore.getState().captureBlockHistory("pa"); // snapshot of v0
    useStore.setState((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        pa: s.blocksByPage.pa.map((item) =>
          item.id === "b1" ? { ...item, plainText: "v1", content: { rich: [{ text: "v1" }] } } : item
        ),
      },
    }));
    useStore.getState().captureBlockHistory("pa"); // snapshot of v1
    useStore.setState((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        pa: s.blocksByPage.pa.map((item) =>
          item.id === "b1" ? { ...item, plainText: "v2", content: { rich: [{ text: "v2" }] } } : item
        ),
      },
    }));

    const gates: Array<() => void> = [];
    vi.mocked(updateBlockRemote).mockImplementation(
      () => new Promise((resolve) => gates.push(() => resolve(undefined)))
    );

    const first = useStore.getState().undoBlockChange("pa");
    const second = useStore.getState().undoBlockChange("pa");

    // First undo is parked on its persist; release it, then the queued one.
    const flushMicrotasks = async () => {
      for (let i = 0; i < 25; i += 1) await Promise.resolve();
    };
    await flushMicrotasks();
    expect(gates.length).toBeGreaterThan(0);
    while (gates.length) gates.shift()?.();
    await flushMicrotasks();
    expect(gates.length).toBeGreaterThan(0);
    while (gates.length) gates.shift()?.();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    // Both keystrokes took effect: v2 -> v1 -> v0.
    expect(useStore.getState().blocksByPage.pa.find((item) => item.id === "b1")?.plainText).toBe(
      "b1"
    );
    const history = useStore.getState().blockHistoryByPage.pa;
    expect(history?.past).toHaveLength(0);
    expect(history?.future).toHaveLength(2);
  });
});
