// @vitest-environment jsdom
//
// Local-first Phase 1 (docs/local-first-roadmap.md §4): server-fetched records
// write through to the per-user record cache, cold boots hydrate from it
// (stale-while-revalidate), and when the network is down the cached render
// stands — with still-queued outbox mutations overlaid so offline reads
// reflect offline writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("bootstrapWorkspace not primed");
    }),
    // Identity unknown by default (offline cold-boot shape); the shared-browser
    // guard test overrides this per-case.
    currentUserId: vi.fn(() => ""),
    getPageBlocksRemote: vi.fn(async () => ({ blocks: [] })),
    getDatabaseRowsRemote: vi.fn(async () => ({ rows: [] })),
    createBlockRemote: vi.fn(async () => undefined),
    createBlocksRemote: vi.fn(async () => []),
    deleteBlocksRemote: vi.fn(async () => undefined),
    updateBlockRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
  };
});

import {
  bootstrapWorkspace,
  currentUserId,
  getDatabaseRowsRemote,
  getPageBlocksRemote,
} from "@/lib/edgebase";
import { outboxIdleForTests, resetOutboxForTests, type OutboxOp } from "@/lib/outbox";
import {
  cacheListTable,
  hashCacheKey,
  recordCacheIdleForTests,
  resetRecordCacheForTests,
} from "@/lib/recordCache";
import { databaseRowsQueryKey, resetBootstrapForTests, useStore } from "@/lib/store";
import { rememberPermanentDeleteIds } from "@/lib/permanentDeleteTombstones";
import {
  createIndexedDbOutboxAdapter,
  createIndexedDbRecordCacheAdapter,
} from "@edge-base/web";
import {
  makePage,
  makeProp,
  makeRow,
  resetStore,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";
import type { Block, DbView, Page } from "@/lib/types";

const OUTBOX_DB = `hanji-outbox:${TEST_USER}`;

type BootstrapResult = Awaited<ReturnType<typeof bootstrapWorkspace>>;

function bootstrapResult(pages: Page[]): BootstrapResult {
  return {
    userId: TEST_USER,
    workspace: { id: "ws-1", name: "WS", createdAt: "", updatedAt: "" },
    members: [],
    pages,
  } as unknown as BootstrapResult;
}

function makeBlock(pageId: string, id: string, plainText: string): Block {
  const now = new Date(0).toISOString();
  return {
    id,
    pageId,
    parentId: null,
    type: "paragraph",
    content: { rich: [{ text: plainText }] },
    plainText,
    position: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: TEST_USER,
  } as unknown as Block;
}

function seedOutboxEntry(entryKey: string, value: OutboxOp) {
  const adapter = createIndexedDbOutboxAdapter<OutboxOp>(OUTBOX_DB);
  if (!adapter) throw new Error("fake-indexeddb adapter unavailable");
  return adapter.put({ entryKey, tabId: "dead-tab", updatedAt: 0, value });
}

async function settled() {
  await outboxIdleForTests();
  await recordCacheIdleForTests();
  await outboxIdleForTests();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPageBlocksRemote).mockResolvedValue({ blocks: [] } as never);
  vi.mocked(getDatabaseRowsRemote).mockResolvedValue({ rows: [] } as never);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  globalThis.indexedDB = new IDBFactory();
  resetOutboxForTests();
  resetRecordCacheForTests();
  resetBootstrapForTests();
  resetStore();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("bootstrap hydration", () => {
  it("never rehydrates a permanently deleted page from a stale bootstrap blob", async () => {
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([makePage({ id: "deleted-page", title: "Must stay deleted" })])
    );
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    resetStore();
    resetBootstrapForTests();
    resetOutboxForTests();
    rememberPermanentDeleteIds(TEST_USER, ["deleted-page"]);
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    vi.mocked(bootstrapWorkspace).mockRejectedValue(new Error("network down"));

    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    expect(useStore.getState().ready).toBe(true);
    expect(useStore.getState().pagesById["deleted-page"]).toBeUndefined();
  });

  it("writes through on success, then serves an offline boot from the cache with outbox overlay", async () => {
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([makePage({ id: "p1", title: "Server title" })])
    );
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();
    expect(useStore.getState().pagesById["p1"]?.title).toBe("Server title");

    // Simulate the next cold boot with the network down and a queued title
    // edit left in the outbox by the previous session.
    await seedOutboxEntry("page:p1", {
      id: "p1",
      kind: "page_update",
      patch: { title: "Offline title" },
      target: "page",
    });
    resetStore();
    resetBootstrapForTests();
    resetOutboxForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    vi.mocked(bootstrapWorkspace).mockRejectedValue(new Error("network down"));

    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    const state = useStore.getState();
    expect(state.ready).toBe(true);
    expect(state.workspace?.id).toBe("ws-1");
    // Cached page rendered with the still-queued offline edit overlaid.
    expect(state.pagesById["p1"]?.title).toBe("Offline title");
  });

  it("joins the current page's cached blocks before exposing a warm boot", async () => {
    const page = makePage({ id: "p1", title: "Cached page" });
    const block = makeBlock("p1", "b1", "cached body");
    vi.mocked(bootstrapWorkspace).mockResolvedValue(bootstrapResult([page]));
    vi.mocked(getPageBlocksRemote).mockResolvedValue({ blocks: [block] } as never);
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1", pageId: "p1" });
    await useStore.getState().loadBlocks("p1");
    await settled();

    resetStore();
    resetBootstrapForTests();
    resetOutboxForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    vi.mocked(bootstrapWorkspace).mockRejectedValue(new Error("network down"));
    vi.mocked(getPageBlocksRemote).mockRejectedValue(new Error("network down"));

    await useStore.getState().bootstrap({ workspaceId: "ws-1", pageId: "p1" });

    const state = useStore.getState();
    expect(state.ready).toBe(true);
    expect(state.loadedBlockPages.has("p1")).toBe(true);
    expect(state.blocksByPage.p1?.[0]?.plainText).toBe("cached body");
  });

  it("reconciles a cached boot with the fresh server result", async () => {
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([makePage({ id: "p1", title: "Old" })])
    );
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    resetStore();
    resetBootstrapForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([makePage({ id: "p1", title: "Fresh from server" })])
    );

    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    expect(useStore.getState().pagesById["p1"]?.title).toBe("Fresh from server");
    expect(useStore.getState().ready).toBe(true);
  });

  it("un-renders the hydrated cache and surfaces a definitive server denial", async () => {
    // Prime the cache with a successful boot, then boot again with the server
    // refusing access (revoked share / different actor): the cached render
    // must NOT stand — the denial reaches the caller and the refuted blob is
    // dropped so the next boot fails fast instead of re-rendering it.
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([makePage({ id: "p1", title: "Private page" })])
    );
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    resetStore();
    resetBootstrapForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    vi.mocked(bootstrapWorkspace).mockRejectedValue(
      Object.assign(new Error("You do not have access to this page."), { status: 403 })
    );

    await expect(useStore.getState().bootstrap({ workspaceId: "ws-1" })).rejects.toThrow(
      "do not have access"
    );
    await settled();
    const state = useStore.getState();
    expect(state.ready).toBe(false);
    expect(state.pagesById["p1"]).toBeUndefined();
    expect(state.userId).toBeFalsy();

    // Blob dropped: an offline retry has nothing to hydrate and rejects
    // instead of resurrecting the denied workspace.
    resetBootstrapForTests();
    vi.mocked(bootstrapWorkspace).mockRejectedValue(new Error("network down"));
    await expect(useStore.getState().bootstrap({ workspaceId: "ws-1" })).rejects.toThrow(
      "network down"
    );
    expect(useStore.getState().pagesById["p1"]).toBeUndefined();
  });

  it("does not serve another account's cache when a different user is signed in", async () => {
    // Cache belongs to TEST_USER; the live session belongs to someone else
    // (previous account's session expired without sign-out cleanup, new
    // account signed in). Hydration must skip entirely — even when the
    // network then fails, the other account's workspace must not render.
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([makePage({ id: "p1", title: "Someone else's page" })])
    );
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    resetStore();
    resetBootstrapForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    vi.mocked(currentUserId).mockReturnValue("another-account");
    vi.mocked(bootstrapWorkspace).mockRejectedValue(new Error("network down"));
    try {
      await expect(useStore.getState().bootstrap({ workspaceId: "ws-1" })).rejects.toThrow(
        "network down"
      );
      expect(useStore.getState().ready).toBe(false);
      expect(useStore.getState().pagesById["p1"]).toBeUndefined();
    } finally {
      vi.mocked(currentUserId).mockReturnValue("");
    }
  });
});

describe("block hydration", () => {
  it("serves cached blocks offline with queued edits overlaid", async () => {
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1" }) } });
    const block = makeBlock("p1", "b1", "cached text");
    vi.mocked(getPageBlocksRemote).mockResolvedValue({ blocks: [block] } as never);
    await useStore.getState().loadBlocks("p1");
    await settled();
    // Write-through happened.
    expect(
      (await cacheListTable<Block>(TEST_USER, "blocks:p1")).map((r) => r.id)
    ).toEqual(["b1"]);

    // Fresh session, offline, with a queued block edit + create in the outbox.
    await seedOutboxEntry("block:b1", {
      hintPageId: "p1",
      id: "b1",
      kind: "block_update",
      patch: { plainText: "edited offline" },
    });
    await seedOutboxEntry("create:b2", {
      block: makeBlock("p1", "b2", "created offline"),
      kind: "block_create",
    });
    resetStore();
    resetOutboxForTests();
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1" }) } });
    vi.mocked(getPageBlocksRemote).mockRejectedValue(new Error("network down"));

    await useStore.getState().loadBlocks("p1");
    await settled();

    const blocks = useStore.getState().blocksByPage["p1"] ?? [];
    expect(blocks.map((b) => b.plainText).sort()).toEqual(["created offline", "edited offline"]);
    expect(useStore.getState().loadedBlockPages.has("p1")).toBe(true);
  });

  it("rehydrates a queued composite create batch after failure and reload", async () => {
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1" }) } });
    const cached = makeBlock("p1", "existing", "existing text");
    vi.mocked(getPageBlocksRemote).mockResolvedValue({ blocks: [cached] } as never);
    await useStore.getState().loadBlocks("p1");
    await settled();

    const parent = makeBlock("p1", "batch-parent", "parent text");
    const child = { ...makeBlock("p1", "batch-child", "child text"), parentId: parent.id };
    await seedOutboxEntry("call:batch", {
      kind: "remote_call",
      fn: "createBlocksRemote",
      args: [[parent, child]],
    });

    resetStore();
    resetOutboxForTests();
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1" }) } });
    vi.mocked(getPageBlocksRemote).mockRejectedValue(new Error("network down"));

    await useStore.getState().loadBlocks("p1");
    await settled();

    expect((useStore.getState().blocksByPage.p1 ?? []).map((block) => block.id)).toEqual([
      "existing",
      "batch-parent",
      "batch-child",
    ]);
  });
});

describe("delta-sync-lite (blocks stamp)", () => {
  it("skips the block refetch when the cached stamp matches page.updatedAt", async () => {
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1", updatedAt: "T1" }) } });
    vi.mocked(getPageBlocksRemote).mockResolvedValue({
      blocks: [makeBlock("p1", "b1", "cached text")],
    } as never);
    await useStore.getState().loadBlocks("p1");
    await settled();
    expect(vi.mocked(getPageBlocksRemote)).toHaveBeenCalledTimes(1);

    // Fresh session, same page.updatedAt: cache is provably current → no fetch.
    resetStore();
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1", updatedAt: "T1" }) } });
    vi.mocked(getPageBlocksRemote).mockClear();

    await useStore.getState().loadBlocks("p1");
    await settled();

    expect(vi.mocked(getPageBlocksRemote)).not.toHaveBeenCalled();
    expect(useStore.getState().blocksByPage["p1"]?.[0]?.plainText).toBe("cached text");
    expect(useStore.getState().loadedBlockPages.has("p1")).toBe(true);
  });

  it("refetches when page.updatedAt moved past the cached stamp", async () => {
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1", updatedAt: "T1" }) } });
    vi.mocked(getPageBlocksRemote).mockResolvedValue({
      blocks: [makeBlock("p1", "b1", "old text")],
    } as never);
    await useStore.getState().loadBlocks("p1");
    await settled();

    resetStore();
    seedUser();
    useStore.setState({ pagesById: { p1: makePage({ id: "p1", updatedAt: "T2" }) } });
    vi.mocked(getPageBlocksRemote).mockClear();
    vi.mocked(getPageBlocksRemote).mockResolvedValue({
      blocks: [makeBlock("p1", "b1", "fresh text")],
    } as never);

    await useStore.getState().loadBlocks("p1");
    await settled();

    expect(vi.mocked(getPageBlocksRemote)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().blocksByPage["p1"]?.[0]?.plainText).toBe("fresh text");
  });
});

describe("per-view row caches", () => {
  it("hydrates each cached view query offline", async () => {
    seedUser();
    const rowA = makeRow("db1", { id: "rA", title: "Default row" });
    const rowB = makeRow("db1", { id: "rB", title: "View row" });
    vi.mocked(getDatabaseRowsRemote)
      .mockResolvedValueOnce({ rows: [rowA], hasMore: false, totalCount: 1, offset: 0 } as never)
      .mockResolvedValueOnce({ rows: [rowB], hasMore: false, totalCount: 1, offset: 0 } as never);
    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });
    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0, viewId: "v1" });
    await settled();

    resetStore();
    resetOutboxForTests();
    seedUser();
    vi.mocked(getDatabaseRowsRemote).mockRejectedValue(new Error("network down"));

    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0, viewId: "v1" });
    expect(useStore.getState().databaseRowIdsByDb["db1"]).toEqual(["rB"]);

    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });
    expect(useStore.getState().databaseRowIdsByDb["db1"]).toEqual(["rA"]);
    expect(useStore.getState().toasts).toHaveLength(0);
  });
});

describe("bootstrap pages delta (§7)", () => {
  it("echoes the watermark, applies the delta over the blob, and prunes deletions", async () => {
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([
        makePage({ id: "p1", title: "Old", updatedAt: "T1" }),
        makePage({ id: "p2", title: "Gone", updatedAt: "T1" }),
      ])
    );
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    resetStore();
    resetBootstrapForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    const sinceSeen: Array<string | undefined> = [];
    vi.mocked(bootstrapWorkspace).mockImplementation(async (input) => {
      sinceSeen.push(input?.pagesSince);
      return {
        userId: TEST_USER,
        workspace: { id: "ws-1", name: "WS" },
        members: [],
        pagesDelta: true,
        pagesSyncedAt: "T2",
        changedPages: [makePage({ id: "p1", title: "Fresh", updatedAt: "T2" })],
        visiblePageIds: ["p1"],
      } as unknown as BootstrapResult;
    });

    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    expect(sinceSeen).toEqual(["T1"]);
    expect(useStore.getState().pagesById["p1"]?.title).toBe("Fresh");
    // p2 vanished from visiblePageIds → deleted/revoked remotely → pruned.
    expect(useStore.getState().pagesById["p2"]).toBeUndefined();

    // The blob advanced: the NEXT boot echoes T2 and can serve offline.
    resetStore();
    resetBootstrapForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    const nextSince: Array<string | undefined> = [];
    vi.mocked(bootstrapWorkspace).mockImplementation(async (input) => {
      nextSince.push(input?.pagesSince);
      throw new Error("network down");
    });
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();
    expect(nextSince).toEqual(["T2"]);
    expect(useStore.getState().pagesById["p1"]?.title).toBe("Fresh");
    expect(useStore.getState().pagesById["p2"]).toBeUndefined();
  });

  it("falls back to a full fetch when the delta references an uncached page", async () => {
    vi.mocked(bootstrapWorkspace).mockResolvedValue(
      bootstrapResult([makePage({ id: "p1", title: "Cached", updatedAt: "T1" })])
    );
    seedUser();
    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    resetStore();
    resetBootstrapForTests();
    window.localStorage.setItem("hanji.lastUserId", TEST_USER);
    vi.mocked(bootstrapWorkspace).mockClear();
    vi.mocked(bootstrapWorkspace)
      .mockResolvedValueOnce({
        userId: TEST_USER,
        workspace: { id: "ws-1", name: "WS" },
        members: [],
        pagesDelta: true,
        pagesSyncedAt: "T2",
        changedPages: [],
        // pNew became visible (e.g. newly shared) but was never cached.
        visiblePageIds: ["p1", "pNew"],
      } as unknown as BootstrapResult)
      .mockResolvedValueOnce(
        bootstrapResult([
          makePage({ id: "p1", title: "Cached", updatedAt: "T1" }),
          makePage({ id: "pNew", title: "Newly visible", updatedAt: "T0" }),
        ])
      );

    await useStore.getState().bootstrap({ workspaceId: "ws-1" });
    await settled();

    expect(vi.mocked(bootstrapWorkspace)).toHaveBeenCalledTimes(2);
    expect(useStore.getState().pagesById["pNew"]?.title).toBe("Newly visible");
  });
});

describe("offline any-view local engine (Phase 3 v2)", () => {
  function seedDbSchema() {
    const prop = makeProp("db1", { id: "note", type: "text" });
    const view = {
      id: "v1",
      databaseId: "db1",
      name: "Keepers",
      type: "table",
      position: 0,
      config: { filters: [{ propertyId: "note", operator: "contains", value: "keep" }] },
    } as unknown as DbView;
    useStore.setState({
      propsByDb: { db1: [prop] },
      viewsByDb: { db1: [view] },
    });
  }

  it("computes an uncached view offline from a complete cached base set", async () => {
    seedUser();
    seedDbSchema();
    const rowA = makeRow("db1", { id: "rA", title: "A", properties: { note: "keep me" } });
    const rowB = makeRow("db1", { id: "rB", title: "B", properties: { note: "drop" } });
    vi.mocked(getDatabaseRowsRemote).mockResolvedValue({
      rows: [rowA, rowB],
      hasMore: false,
      totalCount: 2,
      offset: 0,
    } as never);
    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });
    await settled();

    resetStore();
    resetOutboxForTests();
    seedUser();
    seedDbSchema();
    vi.mocked(getDatabaseRowsRemote).mockRejectedValue(new Error("network down"));

    await useStore
      .getState()
      .loadDatabaseRows("db1", { reset: true, offset: 0, viewId: "v1" });

    const state = useStore.getState();
    expect(state.databaseRowIdsByDb["db1"]).toEqual(["rA"]);
    expect(state.databaseRowPagesByDb["db1"]?.error).toBeUndefined();
    expect(state.toasts).toHaveLength(0);
  });

  it("refuses the local engine when the cached base set is partial", async () => {
    seedUser();
    seedDbSchema();
    const rowA = makeRow("db1", { id: "rA", title: "A", properties: { note: "keep me" } });
    vi.mocked(getDatabaseRowsRemote).mockResolvedValue({
      rows: [rowA],
      hasMore: true, // first page of a bigger set — filtering it would lie
      totalCount: 120,
      offset: 0,
    } as never);
    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });
    await settled();

    resetStore();
    resetOutboxForTests();
    seedUser();
    seedDbSchema();
    vi.mocked(getDatabaseRowsRemote).mockRejectedValue(new Error("network down"));

    await useStore
      .getState()
      .loadDatabaseRows("db1", { reset: true, offset: 0, viewId: "v1" });

    // Never-show-partial: an error state beats a silently truncated view.
    expect(useStore.getState().databaseRowIdsByDb["db1"] ?? []).toEqual([]);
    expect(useStore.getState().databaseRowPagesByDb["db1"]?.error).toBeTruthy();
  });
});

describe("never-show-partial rows cache", () => {
  it("refuses to hydrate a rows cache that lost a listed row", async () => {
    seedUser();
    const rowA = makeRow("db1", { id: "rA", title: "A" });
    const rowB = makeRow("db1", { id: "rB", title: "B" });
    vi.mocked(getDatabaseRowsRemote).mockResolvedValue({
      rows: [rowA, rowB],
      hasMore: false,
      totalCount: 2,
      offset: 0,
    } as never);
    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });
    await settled();

    // Corrupt the cache: drop one listed row record directly.
    const suffix = hashCacheKey(databaseRowsQueryKey({}));
    const raw = createIndexedDbRecordCacheAdapter(`hanji-records:${TEST_USER}`);
    if (!raw) throw new Error("fake-indexeddb adapter unavailable");
    await raw.removeRecords(`rowsdata:db1:${suffix}`, ["rA"]);

    resetStore();
    resetOutboxForTests();
    seedUser();
    vi.mocked(getDatabaseRowsRemote).mockRejectedValue(new Error("network down"));

    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });

    // Partial cache must not render a subset; the offline error state wins.
    expect(useStore.getState().databaseRowIdsByDb["db1"] ?? []).toEqual([]);
    expect(useStore.getState().databaseRowPagesByDb["db1"]?.error).toBeTruthy();
  });
});

describe("database rows hydration", () => {
  it("serves the cached first page offline without an error toast", async () => {
    seedUser();
    const row = makeRow("db1", { id: "r1", title: "Cached row" });
    vi.mocked(getDatabaseRowsRemote).mockResolvedValue({
      rows: [row],
      hasMore: false,
      totalCount: 1,
      offset: 0,
    } as never);
    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });
    await settled();

    resetStore();
    resetOutboxForTests();
    seedUser();
    vi.mocked(getDatabaseRowsRemote).mockRejectedValue(new Error("network down"));

    await useStore.getState().loadDatabaseRows("db1", { reset: true, offset: 0 });
    await settled();

    const state = useStore.getState();
    expect(state.databaseRowIdsByDb["db1"]).toEqual(["r1"]);
    expect(state.pagesById["r1"]?.title).toBe("Cached row");
    expect(state.databaseRowPagesByDb["db1"]?.error).toBeUndefined();
    expect(state.toasts).toHaveLength(0);
  });
});
