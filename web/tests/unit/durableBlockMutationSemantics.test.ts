// @vitest-environment jsdom
//
// Block copy/move/history actions must treat a durable queued outcome as a
// usable local-first success, while a terminal drop reconciles and must not be
// returned to UI callers as a successful copy/move/version restore.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remoteBlocks = vi.hoisted(() => new Map<string, unknown[]>());

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in block durable test.");
    }),
    createBlockRemote: vi.fn(async () => undefined),
    createBlocksRemote: vi.fn(async () => []),
    deleteBlockRemote: vi.fn(async () => undefined),
    deleteBlocksRemote: vi.fn(async () => undefined),
    getPageBlocksRemote: vi.fn(async (pageId: string) => ({
      blocks: remoteBlocks.get(pageId) ?? [],
    })),
    getPageCommentsRemote: vi.fn(async () => ({ comments: [] })),
    recordCollaborationOperationRemote: vi.fn(async () => undefined),
    updateBlockRemote: vi.fn(async () => undefined),
    updateBlocksRemote: vi.fn(async () => []),
    updateCommentsRemote: vi.fn(async () => []),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
  };
});

import {
  createBlocksRemote,
  getPageCommentsRemote,
  updateBlockRemote,
  updateCommentsRemote,
} from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { Block, Comment } from "@/lib/types";
import {
  makePage,
  resetStore,
  seedPages,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";

const NOW = new Date(0).toISOString();

function terminal(status = 400) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function offline() {
  return new Error("network down");
}

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
    createdBy: TEST_USER,
    ...overrides,
  };
}

function seedFixture() {
  const source = makePage({ id: "source", title: "Source" });
  const target = makePage({ id: "target", title: "Target" });
  const sourceBlocks = [
    block("root", source.id, { position: 1 }),
    block("child", source.id, { parentId: "root", position: 2 }),
  ];
  const targetBlocks = [block("target-block", target.id, { position: 1 })];
  seedPages([source, target]);
  useStore.setState((state) => ({
    workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
    pageRolesById: {
      ...state.pageRolesById,
      [source.id]: "edit",
      [target.id]: "edit",
    },
    blocksByPage: { source: sourceBlocks, target: targetBlocks },
    loadedBlockPages: new Set([source.id, target.id]),
  }));
  remoteBlocks.set(source.id, sourceBlocks);
  remoteBlocks.set(target.id, targetBlocks);
  return { source, sourceBlocks, target, targetBlocks };
}

function ids(pageId: string) {
  return (useStore.getState().blocksByPage[pageId] ?? []).map((item) => item.id).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStore();
  seedUser();
  remoteBlocks.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("copyBlockToPage", () => {
  it("returns undefined and removes the phantom/history entry on dropped", async () => {
    seedFixture();
    const historyBefore = useStore.getState().blockHistoryByPage.target;
    vi.mocked(createBlocksRemote).mockRejectedValueOnce(terminal(403));

    await expect(useStore.getState().copyBlockToPage("root", "target")).resolves.toBeUndefined();

    expect(ids("target")).toEqual(["target-block"]);
    expect(useStore.getState().blockHistoryByPage.target).toBe(historyBefore);
  });

  it("returns and keeps the optimistic copy for queued and ok", async () => {
    seedFixture();
    vi.mocked(createBlocksRemote).mockRejectedValueOnce(offline());
    const queued = await useStore.getState().copyBlockToPage("root", "target");
    expect(queued?.id).toBeTruthy();
    expect(ids("target")).toHaveLength(3);

    resetStore();
    seedUser();
    remoteBlocks.clear();
    seedFixture();
    const ok = await useStore.getState().copyBlockToPage("root", "target");
    expect(ok?.id).toBeTruthy();
    expect(ids("target")).toHaveLength(3);
  });
});

describe("moveBlockToPage", () => {
  it("rejects and restores blocks plus linked history on primary dropped", async () => {
    seedFixture();
    vi.mocked(updateBlockRemote).mockRejectedValueOnce(terminal(400));

    await expect(useStore.getState().moveBlockToPage("root", "target")).rejects.toMatchObject({
      status: 400,
    });

    expect(ids("source")).toEqual(["child", "root"]);
    expect(ids("target")).toEqual(["target-block"]);
    expect(useStore.getState().blockHistoryByPage.source).toBeUndefined();
    expect(useStore.getState().blockHistoryByPage.target).toBeUndefined();
  });

  it("keeps the optimistic move for queued and ok", async () => {
    seedFixture();
    vi.mocked(updateBlockRemote).mockRejectedValueOnce(offline());
    await expect(useStore.getState().moveBlockToPage("root", "target")).resolves.toBeUndefined();
    expect(ids("source")).toEqual([]);
    expect(ids("target")).toEqual(["child", "root", "target-block"]);

    resetStore();
    seedUser();
    remoteBlocks.clear();
    seedFixture();
    await useStore.getState().moveBlockToPage("root", "target");
    expect(ids("source")).toEqual([]);
  });

  it("reconciles comments and rejects an unqualified success on secondary dropped", async () => {
    seedFixture();
    const comment: Comment = {
      id: "comment",
      pageId: "source",
      blockId: "root",
      parentId: null,
      authorId: TEST_USER,
      body: { rich: [{ text: "hello" }] },
      resolved: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    useStore.setState({
      commentsByPage: { source: [comment], target: [] },
      loadedCommentPages: new Set(["source", "target"]),
    });
    vi.mocked(getPageCommentsRemote).mockImplementation(async (pageId) => ({
      comments: pageId === "source" ? [comment] : [],
    }));
    vi.mocked(updateCommentsRemote).mockRejectedValueOnce(terminal(400));

    await expect(useStore.getState().moveBlockToPage("root", "target")).rejects.toMatchObject({
      status: 400,
    });

    expect(ids("source")).toEqual([]);
    expect(useStore.getState().commentsByPage.source).toEqual([comment]);
    expect(useStore.getState().commentsByPage.target).toEqual([]);
  });
});

describe("block history durable outcomes", () => {
  async function seedMovedHistory() {
    seedFixture();
    await useStore.getState().moveBlockToPage("root", "target");
    const movedSource = useStore.getState().blocksByPage.source;
    const movedTarget = useStore.getState().blocksByPage.target;
    remoteBlocks.set("source", movedSource);
    remoteBlocks.set("target", movedTarget);
  }

  it("undo returns false and restores authoritative moved state/history on dropped", async () => {
    await seedMovedHistory();
    const historyBefore = useStore.getState().blockHistoryByPage;
    vi.mocked(updateBlockRemote).mockRejectedValueOnce(terminal(409));

    await expect(useStore.getState().undoBlockChange("target")).resolves.toBe(false);

    expect(ids("source")).toEqual([]);
    expect(ids("target")).toEqual(["child", "root", "target-block"]);
    expect(useStore.getState().blockHistoryByPage.target).toEqual(historyBefore.target);
  });

  it("undo returns true and applies locally for queued and ok", async () => {
    await seedMovedHistory();
    vi.mocked(updateBlockRemote).mockRejectedValueOnce(offline());
    await expect(useStore.getState().undoBlockChange("target")).resolves.toBe(true);
    expect(ids("source")).toEqual(["child", "root"]);

    resetStore();
    seedUser();
    remoteBlocks.clear();
    await seedMovedHistory();
    await expect(useStore.getState().undoBlockChange("target")).resolves.toBe(true);
    expect(ids("source")).toEqual(["child", "root"]);
  });

  it("redo returns false and restores the pre-redo state/history on dropped", async () => {
    await seedMovedHistory();
    await useStore.getState().undoBlockChange("target");
    remoteBlocks.set("source", useStore.getState().blocksByPage.source);
    remoteBlocks.set("target", useStore.getState().blocksByPage.target);
    const historyBefore = useStore.getState().blockHistoryByPage;
    vi.mocked(updateBlockRemote).mockRejectedValueOnce(terminal(400));

    await expect(useStore.getState().redoBlockChange("source")).resolves.toBe(false);

    expect(ids("source")).toEqual(["child", "root"]);
    expect(ids("target")).toEqual(["target-block"]);
    expect(useStore.getState().blockHistoryByPage.source).toEqual(historyBefore.source);
  });
});

describe("persistBlockCreateBatch", () => {
  it("reconciles already-inserted batch blocks on dropped and retains them when queued", async () => {
    const page = makePage({ id: "page", title: "Page" });
    seedPages([page]);
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
      blocksByPage: { page: [] },
      loadedBlockPages: new Set([page.id]),
    });
    remoteBlocks.set(page.id, []);
    const parent = useStore.getState().addBlockLocal({
      pageId: page.id,
      position: 1,
      persist: false,
    });
    const child = useStore.getState().addBlockLocal({
      pageId: page.id,
      parentId: parent.id,
      position: 2,
      persist: false,
    });
    vi.mocked(createBlocksRemote).mockRejectedValueOnce(terminal(413));

    await useStore.getState().persistBlockCreateBatch([parent, child]);
    expect(useStore.getState().blocksByPage.page).toEqual([]);

    resetStore();
    seedUser();
    remoteBlocks.clear();
    seedPages([page]);
    useStore.setState({ blocksByPage: { page: [parent, child] }, loadedBlockPages: new Set([page.id]) });
    remoteBlocks.set(page.id, []);
    vi.mocked(createBlocksRemote).mockRejectedValueOnce(offline());
    await useStore.getState().persistBlockCreateBatch([parent, child]);
    expect(useStore.getState().blocksByPage.page).toHaveLength(2);
  });
});
