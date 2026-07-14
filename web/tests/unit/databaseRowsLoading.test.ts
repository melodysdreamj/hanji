// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    updateDatabaseRowRemote: vi.fn(async (id, patch) => ({ id, ...patch })),
  };
});

import { getDatabaseRowsRemote, updateDatabaseRowRemote } from "@/lib/edgebase";
import { databaseRowsQueryKey, flushAllPending, useStore } from "@/lib/store";
import { makePage, makeRow, resetStore, seedPages, seedUser } from "./components/storeTestUtils";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

afterEach(async () => {
  await flushAllPending();
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

  it("retries an orphaned loading marker when no matching request is in flight", async () => {
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

    expect(vi.mocked(getDatabaseRowsRemote)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().databaseRowPagesByDb[db.id]).toMatchObject({
      queryKey,
      loadedCount: 0,
      totalCount: 0,
      hasMore: false,
      loading: false,
      loadingMore: false,
    });
  });

  it("deduplicates a genuinely in-flight reset-fetch for the same row query", async () => {
    const db = makePage({ id: "db", kind: "database", title: "Tasks" });
    const query = { viewId: "view-1", limit: 50 };
    let resolveRequest!: (result: Awaited<ReturnType<typeof getDatabaseRowsRemote>>) => void;
    vi.mocked(getDatabaseRowsRemote).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );
    seedPages([db]);

    const first = useStore.getState().loadDatabaseRows(db.id, { ...query, reset: true });
    await vi.waitFor(() => expect(getDatabaseRowsRemote).toHaveBeenCalledTimes(1));
    const duplicate = useStore.getState().loadDatabaseRows(db.id, { ...query, reset: true });

    expect(getDatabaseRowsRemote).toHaveBeenCalledTimes(1);
    resolveRequest({
      databaseId: db.id,
      rows: [],
      offset: 0,
      totalCount: 0,
      hasMore: false,
    });
    await Promise.all([first, duplicate]);
    expect(getDatabaseRowsRemote).toHaveBeenCalledTimes(1);
  });

  it("runs one trailing forced fetch when another mutation refresh joins an in-flight query", async () => {
    const db = makePage({ id: "db", kind: "database", title: "Tasks" });
    const stale = makeRow(db.id, { id: "row-1", title: "Before" });
    const fresh = makeRow(db.id, { id: "row-1", title: "After" });
    const requests: Array<{
      resolve: (result: Awaited<ReturnType<typeof getDatabaseRowsRemote>>) => void;
    }> = [];
    vi.mocked(getDatabaseRowsRemote).mockImplementation(
      () => new Promise((resolve) => requests.push({ resolve }))
    );
    seedPages([db]);

    const first = useStore.getState().loadDatabaseRows(db.id, { force: true, reset: true });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const joined = useStore.getState().loadDatabaseRows(db.id, { force: true, reset: true });
    requests[0].resolve({
      databaseId: db.id,
      rows: [stale],
      offset: 0,
      totalCount: 1,
      hasMore: false,
    });

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1].resolve({
      databaseId: db.id,
      rows: [fresh],
      offset: 0,
      totalCount: 1,
      hasMore: false,
    });
    await Promise.all([first, joined]);

    expect(getDatabaseRowsRemote).toHaveBeenCalledTimes(2);
    expect(useStore.getState().pagesById[fresh.id]?.title).toBe("After");
  });

  it("keeps an optimistic row property over a stale forced snapshot until the server confirms it", async () => {
    const db = makePage({ id: "db", kind: "database", title: "Tasks" });
    const row = makeRow(db.id, {
      id: "row-1",
      title: "Row",
      properties: { relation: ["old-target"] },
    });
    let resolveUpdate!: (value: Awaited<ReturnType<typeof updateDatabaseRowRemote>>) => void;
    vi.mocked(updateDatabaseRowRemote).mockImplementationOnce(
      () => new Promise((resolve) => { resolveUpdate = resolve; })
    );
    vi.mocked(getDatabaseRowsRemote).mockResolvedValueOnce({
      databaseId: db.id,
      rows: [row],
      offset: 0,
      totalCount: 1,
      hasMore: false,
    });
    seedUser();
    seedPages([db, row]);

    useStore.getState().updatePage(row.id, {
      properties: { relation: ["new-target"] },
    }, { debounce: false });
    await vi.waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1));
    await useStore.getState().loadDatabaseRows(db.id, { force: true, reset: true });

    expect(useStore.getState().pagesById[row.id]?.properties?.relation).toEqual(["new-target"]);
    resolveUpdate({ ...row, properties: { relation: ["new-target"] } });
  });

  it("retries a joined view query when a competing base query discarded its result", async () => {
    const db = makePage({ id: "db", kind: "database", title: "Tasks" });
    const activeRow = makeRow(db.id, { id: "active-row", title: "Active view row" });
    const baseRow = makeRow(db.id, { id: "base-row", title: "Base row" });
    const activeQuery = { viewId: "view-1", currentPageId: "page-1", limit: 50 };
    const requests: Array<{
      options: Parameters<typeof getDatabaseRowsRemote>[1];
      resolve: (result: Awaited<ReturnType<typeof getDatabaseRowsRemote>>) => void;
    }> = [];
    vi.mocked(getDatabaseRowsRemote).mockImplementation(
      (_dbId, options) => new Promise((resolve) => requests.push({ options, resolve }))
    );
    seedPages([db]);

    const firstActive = useStore.getState().loadDatabaseRows(db.id, {
      ...activeQuery,
      reset: true,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const base = useStore.getState().loadDatabaseRows(db.id, { limit: 50, reset: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1].resolve({
      databaseId: db.id,
      rows: [baseRow],
      offset: 0,
      totalCount: 1,
      hasMore: false,
    });
    await base;

    const joinedActive = useStore.getState().loadDatabaseRows(db.id, {
      ...activeQuery,
      reset: true,
    });
    expect(getDatabaseRowsRemote).toHaveBeenCalledTimes(2);
    requests[0].resolve({
      databaseId: db.id,
      rows: [activeRow],
      offset: 0,
      totalCount: 1,
      hasMore: false,
    });

    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].options).toMatchObject({
      viewId: activeQuery.viewId,
      currentPageId: activeQuery.currentPageId,
    });
    requests[2].resolve({
      databaseId: db.id,
      rows: [activeRow],
      offset: 0,
      totalCount: 1,
      hasMore: false,
    });
    await Promise.all([firstActive, joinedActive]);

    expect(useStore.getState().databaseRowPagesByDb[db.id]?.queryKey).toBe(
      databaseRowsQueryKey(activeQuery)
    );
    expect(useStore.getState().databaseRowIdsByDb[db.id]).toEqual([activeRow.id]);
    expect(getDatabaseRowsRemote).toHaveBeenCalledTimes(3);
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
