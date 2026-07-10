// @vitest-environment jsdom
//
// Forced reloads must reach the network even when a plain load for the same
// page is already in flight: the in-flight response may predate the change
// that triggered the force (conflict recovery, comments reconciliation).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in load dedup test.");
    }),
    getPageBlocksRemote: vi.fn(async () => ({ blocks: [] })),
    getPageCommentsRemote: vi.fn(async () => ({ comments: [] })),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
  };
});

import { getPageBlocksRemote, getPageCommentsRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser } from "./components/storeTestUtils";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  seedUser();
  seedPages([makePage({ id: "p1", title: "Page" })]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadBlocks force dedup", () => {
  it("still dedups two plain loads into one network fetch", async () => {
    await Promise.all([
      useStore.getState().loadBlocks("p1"),
      useStore.getState().loadBlocks("p1"),
    ]);
    expect(vi.mocked(getPageBlocksRemote)).toHaveBeenCalledTimes(1);
  });

  it("runs a forced load even while a plain load is in flight", async () => {
    const gates: Array<() => void> = [];
    vi.mocked(getPageBlocksRemote).mockImplementation(
      () =>
        new Promise((resolve) => {
          gates.push(() => resolve({ blocks: [] }));
        })
    );

    const plain = useStore.getState().loadBlocks("p1");
    const forced = useStore.getState().loadBlocks("p1", { force: true });

    // Both fetches must have been issued (the force is NOT satisfied by the
    // possibly-stale in-flight plain load).
    await vi.waitFor(() => {
      expect(vi.mocked(getPageBlocksRemote).mock.calls.length).toBe(2);
    });
    while (gates.length) gates.shift()?.();
    await Promise.all([plain, forced]);
  });

  it("dedups two concurrent forced loads into one fetch", async () => {
    vi.mocked(getPageBlocksRemote).mockResolvedValue({ blocks: [] });
    useStore.setState((s) => ({ loadedBlockPages: new Set(s.loadedBlockPages).add("p1") }));
    await Promise.all([
      useStore.getState().loadBlocks("p1", { force: true }),
      useStore.getState().loadBlocks("p1", { force: true }),
    ]);
    expect(vi.mocked(getPageBlocksRemote)).toHaveBeenCalledTimes(1);
  });
});

describe("loadComments force dedup", () => {
  it("runs a forced refresh even while a plain load is in flight", async () => {
    const gates: Array<() => void> = [];
    vi.mocked(getPageCommentsRemote).mockImplementation(
      () =>
        new Promise((resolve) => {
          gates.push(() => resolve({ comments: [] }));
        })
    );

    const plain = useStore.getState().loadComments("p1");
    const forced = useStore.getState().loadComments("p1", { force: true });

    await vi.waitFor(() => {
      expect(vi.mocked(getPageCommentsRemote).mock.calls.length).toBe(2);
    });
    while (gates.length) gates.shift()?.();
    await Promise.all([plain, forced]);
  });
});
