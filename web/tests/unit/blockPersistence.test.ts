// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in block persistence test.");
    }),
    createBlockRemote: vi.fn(async () => undefined),
    deleteBlocksRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updateBlockRemote: vi.fn(async () => undefined),
  };
});

import { createBlockRemote, deleteBlocksRemote, updateBlockRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser } from "./components/storeTestUtils";
import type { Block } from "@/lib/types";

// Matches PERSIST_RETRY_MS in store.ts (2000ms); advance past it to fire a retry.
const PAST_RETRY_MS = 2500;
const ACCESS_TOAST = "edit access";

function transient(message: string) {
  return new Error(message);
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function seedBlock(pageId: string, id: string): Block {
  const now = new Date(0).toISOString();
  const block = {
    id,
    pageId,
    parentId: null,
    type: "paragraph",
    content: { rich: [] },
    plainText: "",
    position: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: "user-test",
  } as unknown as Block;
  useStore.setState((s) => ({
    blocksByPage: { ...s.blocksByPage, [pageId]: [block] },
  }));
  return block;
}

function hasToast(needle: string) {
  return useStore.getState().toasts.some((toast) => toast.message.includes(needle));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStore();
  seedUser();
  seedPages([makePage({ id: "p1", title: "Page" })]);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("block create persistence", () => {
  it("retries a transient create failure instead of silently losing the block", async () => {
    vi.mocked(createBlockRemote)
      .mockRejectedValueOnce(transient("network down"))
      .mockResolvedValue(undefined);

    await useStore.getState().createBlock({ pageId: "p1", position: 1 });
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS);

    expect(vi.mocked(createBlockRemote)).toHaveBeenCalledTimes(2);
    // The optimistic block survives locally and no data-loss toast is shown.
    expect(useStore.getState().blocksByPage["p1"]?.length).toBe(1);
    expect(hasToast(ACCESS_TOAST)).toBe(false);
  });

  it("stops retrying and notifies on a terminal create failure", async () => {
    vi.mocked(createBlockRemote).mockRejectedValue(httpError(403));

    await useStore.getState().createBlock({ pageId: "p1", position: 1 });
    // Check the toast before its 2600ms auto-dismiss; then advance well past the
    // retry window to prove a terminal failure schedules no retry.
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.mocked(createBlockRemote)).toHaveBeenCalledTimes(1);
    expect(hasToast(ACCESS_TOAST)).toBe(true);
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS * 2);
    expect(vi.mocked(createBlockRemote)).toHaveBeenCalledTimes(1);
  });
});

describe("block delete persistence", () => {
  it("retries a transient delete failure", async () => {
    const block = seedBlock("p1", "b1");
    vi.mocked(deleteBlocksRemote)
      .mockRejectedValueOnce(transient("network down"))
      .mockResolvedValue(undefined);

    await useStore.getState().deleteBlock(block.id);
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS);

    expect(vi.mocked(deleteBlocksRemote)).toHaveBeenCalledTimes(2);
    expect(useStore.getState().blocksByPage["p1"]?.length ?? 0).toBe(0);
  });

  it("stops retrying and notifies on a terminal (403) delete failure", async () => {
    const block = seedBlock("p1", "b1");
    vi.mocked(deleteBlocksRemote).mockRejectedValue(httpError(403));

    await useStore.getState().deleteBlock(block.id);
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.mocked(deleteBlocksRemote)).toHaveBeenCalledTimes(1);
    expect(hasToast(ACCESS_TOAST)).toBe(true);
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS * 2);
    expect(vi.mocked(deleteBlocksRemote)).toHaveBeenCalledTimes(1);
  });

  it("treats a 404 delete as already-gone without retrying or notifying", async () => {
    const block = seedBlock("p1", "b1");
    vi.mocked(deleteBlocksRemote).mockRejectedValue(httpError(404));

    await useStore.getState().deleteBlock(block.id);
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS * 2);

    expect(vi.mocked(deleteBlocksRemote)).toHaveBeenCalledTimes(1);
    expect(hasToast(ACCESS_TOAST)).toBe(false);
    expect(useStore.getState().toasts.length).toBe(0);
  });
});

describe("block update persistence", () => {
  it("serializes immediate updates for one block so backend CAS writes cannot race", async () => {
    const block = seedBlock("p1", "b1");
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(updateBlockRemote)
      .mockImplementationOnce(async () => firstPending)
      .mockResolvedValue(undefined as never);

    useStore.getState().updateBlock(block.id, { plainText: "first" }, { history: false });
    useStore.getState().updateBlock(
      block.id,
      { content: { rich: [{ text: "second" }] }, plainText: "second" },
      { history: false },
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(vi.mocked(updateBlockRemote)).toHaveBeenCalledTimes(1);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(1);

    expect(vi.mocked(updateBlockRemote)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateBlockRemote).mock.calls[1]?.[1]).toMatchObject({
      content: { rich: [{ text: "second" }] },
      plainText: "second",
    });
  });
});

describe("nested block create ordering", () => {
  // Template application creates a parent and its children in the same tick.
  // The backend 404s a child whose parent has not landed yet, and a 404 create
  // is dropped terminally — so the child must wait for the parent's create.
  it("holds a child's create until the parent's create has landed", async () => {
    const sent: string[] = [];
    const gates = new Map<string, () => void>();
    vi.mocked(createBlockRemote).mockImplementation(async (block: Block) => {
      sent.push(block.id);
      await new Promise<void>((resolve) => gates.set(block.id, resolve));
    });

    const parent = useStore.getState().addBlockLocal({ pageId: "p1", type: "toggle", position: 1 });
    const child = useStore.getState().addBlockLocal({
      pageId: "p1",
      parentId: parent.id,
      position: 1,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual([parent.id]);

    gates.get(parent.id)!();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual([parent.id, child.id]);
    gates.get(child.id)!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it("retries the child after a transient parent failure instead of dropping it", async () => {
    const sent: string[] = [];
    let attempts = 0;
    // The first call is the parent's create (the child is held behind it).
    vi.mocked(createBlockRemote).mockImplementation(async (block: Block) => {
      sent.push(block.id);
      attempts += 1;
      if (attempts === 1) throw transient("network down");
    });

    const parent = useStore.getState().addBlockLocal({ pageId: "p1", type: "toggle", position: 1 });
    const child = useStore.getState().addBlockLocal({
      pageId: "p1",
      parentId: parent.id,
      position: 1,
    });

    // First pass: the parent's create fails transiently; the child must not
    // have been sent ahead of it.
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual([parent.id]);

    // Retry window: parent lands, then the child follows — nothing dropped.
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS);
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS);
    expect(sent.filter((id) => id === child.id)).toHaveLength(1);
    expect(sent.indexOf(child.id)).toBeGreaterThan(sent.lastIndexOf(parent.id));
    expect(useStore.getState().toasts.length).toBe(0);
    expect(useStore.getState().blocksByPage["p1"]?.length).toBe(2);
  });
});
