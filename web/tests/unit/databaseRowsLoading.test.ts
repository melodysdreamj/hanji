// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    getDatabaseRowsRemote: vi.fn(async () => ({
      databaseId: "db",
      rows: [],
      offset: 0,
      totalCount: 0,
      hasMore: false,
    })),
  };
});

import { getDatabaseRowsRemote } from "@/lib/edgebase";
import { databaseRowsQueryKey, useStore } from "@/lib/store";
import { makePage, makeRow, resetStore, seedPages } from "./components/storeTestUtils";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("database row loading", () => {
  it("does not reset-fetch the same row query after the first page is already loaded", async () => {
    const db = makePage({ id: "db", kind: "database", title: "Tasks" });
    const row = makeRow(db.id, { id: "row-1", title: "Loaded row" });
    const query = { viewId: "view-1", limit: 50 };
    const queryKey = databaseRowsQueryKey(query);
    seedPages([db, row]);
    useStore.setState({
      databaseRowIdsByDb: { [db.id]: [row.id] },
      databaseRowPagesByDb: {
        [db.id]: {
          queryKey,
          loadedCount: 1,
          totalCount: 1,
          hasMore: false,
          loading: false,
          loadingMore: false,
        },
      },
    });

    await useStore.getState().loadDatabaseRows(db.id, { ...query, reset: true });

    expect(vi.mocked(getDatabaseRowsRemote)).not.toHaveBeenCalled();
    expect(useStore.getState().databaseRowIdsByDb[db.id]).toEqual([row.id]);
  });

  it("does not start a second reset-fetch while the same row query is loading", async () => {
    const db = makePage({ id: "db", kind: "database", title: "Tasks" });
    const query = { viewId: "view-1", limit: 50 };
    const queryKey = databaseRowsQueryKey(query);
    seedPages([db]);
    useStore.setState({
      databaseRowPagesByDb: {
        [db.id]: {
          queryKey,
          loadedCount: 0,
          hasMore: false,
          loading: true,
          loadingMore: false,
        },
      },
    });

    await useStore.getState().loadDatabaseRows(db.id, { ...query, reset: true });

    expect(vi.mocked(getDatabaseRowsRemote)).not.toHaveBeenCalled();
  });

  it("still retries the same row query after a previous load error", async () => {
    const db = makePage({ id: "db", kind: "database", title: "Tasks" });
    const row = makeRow(db.id, { id: "row-1", title: "Recovered row" });
    const query = { viewId: "view-1", limit: 50 };
    const queryKey = databaseRowsQueryKey(query);
    seedPages([db]);
    useStore.setState({
      databaseRowPagesByDb: {
        [db.id]: {
          queryKey,
          loadedCount: 0,
          hasMore: false,
          loading: false,
          loadingMore: false,
          error: "Failed once",
        },
      },
    });
    vi.mocked(getDatabaseRowsRemote).mockResolvedValueOnce({
      databaseId: db.id,
      rows: [row],
      offset: 0,
      totalCount: 1,
      hasMore: false,
    });

    await useStore.getState().loadDatabaseRows(db.id, { ...query, reset: true });

    expect(vi.mocked(getDatabaseRowsRemote)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().databaseRowIdsByDb[db.id]).toEqual([row.id]);
    expect(useStore.getState().databaseRowPagesByDb[db.id]?.error).toBeUndefined();
  });
});
