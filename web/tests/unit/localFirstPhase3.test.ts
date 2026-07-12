// @vitest-environment jsdom
//
// Local-first Phase 3 v1 (docs/local-first-roadmap.md §4): offline pins exempt
// pages from record-cache eviction, the block-table LRU stays bounded, and
// quick-find can search cached block content without the server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbRecordCacheAdapter } from "@edge-base/web";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in phase 3 test.");
    }),
  };
});

import {
  MAX_CACHED_BLOCK_PAGES,
  cacheListTable,
  cacheReplaceTable,
  getOfflinePins,
  listCachedBlockPageIds,
  recordCacheIdleForTests,
  recordCacheClear,
  resetRecordCacheForTests,
  setOfflinePin,
  stampBlocksCached,
} from "@/lib/recordCache";
import { searchCachedBlockHits } from "@/lib/localSearch";
import { legacyRecordCacheDatabaseName } from "@/lib/legacyNamespace";
import { resetOutboxForTests } from "@/lib/outbox";
import { resetStore, seedUser, TEST_USER } from "./components/storeTestUtils";
import type { Block } from "@/lib/types";

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

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.indexedDB = new IDBFactory();
  resetOutboxForTests();
  resetRecordCacheForTests();
  resetStore();
  seedUser();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("offline pins and LRU eviction", () => {
  it("keeps the canonical cache available when migration locking fails", async () => {
    const legacy = createIndexedDbRecordCacheAdapter(
      legacyRecordCacheDatabaseName(TEST_USER)
    );
    if (!legacy) throw new Error("fake-indexeddb adapter unavailable");
    await legacy.putRecords("blocks:legacy", [
      { id: "legacy", value: makeBlock("legacy", "legacy", "preserved source") },
    ]);
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: vi.fn(async () => {
          throw new Error("lock manager unavailable");
        }),
      },
    });
    try {
      cacheReplaceTable(TEST_USER, "blocks:canonical", [
        { id: "canonical", value: makeBlock("canonical", "canonical", "still works") },
      ]);
      await recordCacheIdleForTests();
      await expect(cacheListTable(TEST_USER, "blocks:canonical")).resolves.toHaveLength(1);
      await expect(legacy.listTable("blocks:legacy")).resolves.toHaveLength(1);
    } finally {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
  });

  it("invalidates queued stale writes before a privacy clear", async () => {
    cacheReplaceTable(TEST_USER, "blocks:deleted", [
      { id: "b-deleted", value: makeBlock("deleted", "b-deleted", "private") },
    ]);
    const legacy = createIndexedDbRecordCacheAdapter(
      legacyRecordCacheDatabaseName(TEST_USER)
    );
    if (!legacy) throw new Error("fake-indexeddb adapter unavailable");
    await legacy.setMeta("private", { value: "must not resurrect" });

    await expect(recordCacheClear(TEST_USER)).resolves.toBe(true);
    await recordCacheIdleForTests();

    expect(await cacheListTable(TEST_USER, "blocks:deleted")).toHaveLength(0);
    await expect(legacy.getMeta("private")).resolves.toBeUndefined();
    resetRecordCacheForTests();
    expect(await getOfflinePins(TEST_USER)).toEqual({});
  });

  it("evicts the oldest unpinned block tables beyond the cap and keeps pinned ones", async () => {
    // Oldest two entries: one pinned, one not.
    cacheReplaceTable(TEST_USER, "blocks:pinned", [
      { id: "b-pinned", value: makeBlock("pinned", "b-pinned", "pinned text") },
    ]);
    cacheReplaceTable(TEST_USER, "blocks:victim", [
      { id: "b-victim", value: makeBlock("victim", "b-victim", "victim text") },
    ]);
    stampBlocksCached(TEST_USER, "pinned");
    stampBlocksCached(TEST_USER, "victim");
    await recordCacheIdleForTests();
    await setOfflinePin(TEST_USER, "pinned", true);

    for (let i = 0; i < MAX_CACHED_BLOCK_PAGES - 1; i += 1) {
      stampBlocksCached(TEST_USER, `page-${i}`);
    }
    await recordCacheIdleForTests();

    const cached = await listCachedBlockPageIds(TEST_USER);
    expect(cached).toContain("pinned");
    expect(cached).not.toContain("victim");
    expect(cached.length).toBeLessThanOrEqual(MAX_CACHED_BLOCK_PAGES + 1);
    // The evicted table is emptied; the pinned one still has its block.
    expect(await cacheListTable(TEST_USER, "blocks:victim")).toHaveLength(0);
    expect(await cacheListTable(TEST_USER, "blocks:pinned")).toHaveLength(1);
  });

  it("round-trips offline pins", async () => {
    await setOfflinePin(TEST_USER, "p1", true);
    expect(await getOfflinePins(TEST_USER)).toEqual({ p1: true });
    await setOfflinePin(TEST_USER, "p1", false);
    expect(await getOfflinePins(TEST_USER)).toEqual({});
  });
});

describe("local quick-find over cached blocks", () => {
  it("matches in-memory blocks first, then cached tables", async () => {
    const { useStore } = await import("@/lib/store");
    useStore.setState({
      blocksByPage: {
        "mem-page": [makeBlock("mem-page", "b-mem", "alpha in memory")],
      },
    });
    cacheReplaceTable(TEST_USER, "blocks:cached-page", [
      { id: "b-cached", value: makeBlock("cached-page", "b-cached", "alpha in cache") },
    ]);
    stampBlocksCached(TEST_USER, "cached-page");
    await recordCacheIdleForTests();

    const hits = await searchCachedBlockHits(TEST_USER, "alpha", 8);

    expect(hits.map((hit) => hit.block.id)).toEqual(["b-mem", "b-cached"]);
    expect(await searchCachedBlockHits(TEST_USER, "no-such-text", 8)).toHaveLength(0);
  });
});
