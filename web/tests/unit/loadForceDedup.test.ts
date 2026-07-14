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
    getDatabaseRowsRemote: vi.fn(async () => ({
      hasMore: false,
      offset: 0,
      rows: [],
      totalCount: 0,
    })),
    getDatabaseSnapshotRemote: vi.fn(async () => ({
      databaseId: "db",
      properties: [],
      templates: [],
      views: [],
    })),
    getPageBlocksRemote: vi.fn(async () => ({ blocks: [] })),
    getPageCommentsRemote: vi.fn(async () => ({ comments: [] })),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
  };
});

import {
  getDatabaseRowsRemote,
  getDatabaseSnapshotRemote,
  getPageBlocksRemote,
  getPageCommentsRemote,
} from "@/lib/edgebase";
import { databaseRowsQueryKey, useStore } from "@/lib/store";
import { makePage, makeProp, resetStore, seedPages, seedUser } from "./components/storeTestUtils";

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

describe("database warm-cache reconciliation", () => {
  it("revalidates metadata and resumes an orphaned cached-row refresh", async () => {
    const database = makePage({ id: "db", kind: "database", title: "Database" });
    const row = makePage({
      id: "row",
      parentId: database.id,
      parentType: "database",
      title: "Cached row",
    });
    const title = makeProp(database.id, { id: "title", type: "title", name: "Name" });
    seedPages([database, row]);
    useStore.setState((state) => ({
      databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [database.id]: [row.id] },
      databaseRowPagesByDb: {
        ...state.databaseRowPagesByDb,
        [database.id]: {
          queryKey: databaseRowsQueryKey(),
          loadedCount: 1,
          totalCount: 1,
          hasMore: false,
          loading: true,
          loadingMore: false,
        },
      },
      loadedDbs: new Set(state.loadedDbs).add(database.id),
      propsByDb: { ...state.propsByDb, [database.id]: [title] },
      templatesByDb: { ...state.templatesByDb, [database.id]: [] },
      viewsByDb: { ...state.viewsByDb, [database.id]: [] },
    }));
    vi.mocked(getDatabaseSnapshotRemote).mockResolvedValue({
      databaseId: database.id,
      properties: [title],
      templates: [],
      views: [],
    });
    vi.mocked(getDatabaseRowsRemote).mockResolvedValue({
      hasMore: false,
      offset: 0,
      rows: [row],
      totalCount: 1,
    });

    await useStore.getState().loadDatabase(database.id);

    expect(getDatabaseSnapshotRemote).toHaveBeenCalledWith(database.id, { viewIds: [] });
    expect(getDatabaseRowsRemote).toHaveBeenCalledTimes(1);
    expect(useStore.getState().databaseRowPagesByDb[database.id]?.loading).toBe(false);
  });
});
