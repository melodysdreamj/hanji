// @vitest-environment jsdom
//
// Local-first Phase 3 v1 (docs/local-first-roadmap.md §4): offline pins exempt
// pages from record-cache eviction, the block-table LRU stays bounded, and
// quick-find can search cached block content without the server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

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
  resetRecordCacheForTests,
  setOfflinePin,
  stampBlocksCached,
} from "@/lib/recordCache";
import { searchCachedBlockHits } from "@/lib/localSearch";
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
