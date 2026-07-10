"use client";

// Local record cache (local-first Phase 1 — docs/local-first-roadmap.md §4).
//
// Server-fetched record sets (bootstrap payloads, per-page blocks, database
// props/views/templates, first-page row queries) are mirrored into a per-user
// IndexedDB store via the EdgeBase `RecordCache` primitive. On the next boot
// the store hydrates from this cache instantly (stale-while-revalidate) and,
// when the network is down, keeps serving it — with still-queued outbox
// mutations overlaid so offline reads reflect offline writes.
//
// Fail-open like the outbox: without IndexedDB or with the kill switch set,
// every call no-ops and reads return undefined/empty.

import {
  RecordCache,
  createIndexedDbRecordCacheAdapter,
  createSecretBox,
  encryptRecordCacheAdapter,
  type RecordCacheRecord,
} from "@edge-base/web";

import { awaitLocalBox, localBoxIfSettled, onLocalEncryptionModeChange } from "./localLock";

// Bump when the shape of any cached value changes; the SDK layer then wipes
// the store on first use instead of hydrating stale shapes.
// v2: row caches keyed per (db, query-key hash) instead of one per db.
const SCHEMA_VERSION = 2;
const DISABLE_KEY = "notionlike.recordcache.disabled";
// At-rest sealing kill switch (shared with the outbox).
const ENCRYPTION_DISABLE_KEY = "notionlike.encryption.disabled";

let current: { promise: Promise<RecordCache | null>; userId: string } | null = null;
let chain: Promise<void> = Promise.resolve();
let warnedOnce = false;

// Another tab flipped the encryption mode: our cached cache instance is bound to
// the now-stale key. Drop it so the next access rebuilds under the current
// mode's box.
onLocalEncryptionModeChange(() => {
  current = null;
});

function warn(error: unknown) {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn("Record cache unavailable; falling back to network-only reads.", error);
}

function flagSet(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function getCache(userId: string): Promise<RecordCache | null> {
  if (!userId || flagSet(DISABLE_KEY)) return Promise.resolve(null);
  if (current?.userId === userId) return current.promise;
  const promise = (async () => {
    try {
      // Passphrase mode: wait for unlock; a skipped session gets NO cache.
      const gate = await awaitLocalBox(userId);
      if (gate === null) return null;
      const name = `notionlike-records:${userId}`;
      const raw = createIndexedDbRecordCacheAdapter(name);
      if (!raw) return null;
      // Cached content is sealed at rest (crypto-box threat model); table
      // names and record ids stay plaintext. Pre-encryption values keep
      // reading through unchanged.
      const box =
        gate === "device"
          ? flagSet(ENCRYPTION_DISABLE_KEY)
            ? null
            : await createSecretBox(name)
          : gate;
      const adapter = box ? encryptRecordCacheAdapter(raw, box) : raw;
      return new RecordCache({ adapter, name, schemaVersion: SCHEMA_VERSION });
    } catch (error) {
      warn(error);
      return null;
    }
  })();
  current = { promise, userId };
  return promise;
}

function isQuotaError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "QuotaExceededError"
  );
}

function enqueue(task: (cache: RecordCache) => Promise<void>, userId: string) {
  chain = chain
    .then(async () => {
      const cache = await getCache(userId);
      if (!cache) return;
      try {
        await task(cache);
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        // Storage full: evict the oldest half of the cached block pages and
        // retry once; if the retry still fails the write is skipped (the
        // cache is an optimization, never the source of truth).
        await evictOldestBlockTables(cache, Math.ceil(MAX_CACHED_BLOCK_PAGES / 2));
        await task(cache);
      }
    })
    .catch(warn);
}

// ── offline scope: pins + LRU eviction (local-first Phase 3) ────────────────
// Every visited page/database auto-caches (Phase 1 write-through); the LRU
// caps below keep that bounded. Pages pinned "available offline" are exempt
// from eviction.

const BLOCKS_LRU_KEY = "blocksLru";
const DB_LRU_KEY = "dbLru";
const PINS_KEY = "offlinePins";
export const MAX_CACHED_BLOCK_PAGES = 200;
export const MAX_CACHED_DBS = 100;

type LruMap = Record<string, number>;

function oldestBeyond(lru: LruMap, keep: Set<string>, max: number): string[] {
  const candidates = Object.entries(lru)
    .filter(([id]) => !keep.has(id))
    .sort((a, b) => a[1] - b[1]);
  const overflow = Object.keys(lru).length - max;
  return overflow > 0 ? candidates.slice(0, overflow).map(([id]) => id) : [];
}

async function evictOldestBlockTables(cache: RecordCache, count: number) {
  const lru = ((await cache.getMeta<LruMap>(BLOCKS_LRU_KEY)) ?? {}) as LruMap;
  const pins = ((await cache.getMeta<Record<string, true>>(PINS_KEY)) ?? {}) as Record<string, true>;
  const victims = Object.entries(lru)
    .filter(([id]) => !pins[id])
    .sort((a, b) => a[1] - b[1])
    .slice(0, count)
    .map(([id]) => id);
  for (const pageId of victims) {
    await cache.replaceTable(`blocks:${pageId}`, []);
    delete lru[pageId];
  }
  await cache.setMeta(BLOCKS_LRU_KEY, lru);
}

/** Stamp a page's block cache as recently used; evict LRU overflow (unpinned). */
export function stampBlocksCached(userId: string, pageId: string) {
  enqueue(async (cache) => {
    const lru = ((await cache.getMeta<LruMap>(BLOCKS_LRU_KEY)) ?? {}) as LruMap;
    lru[pageId] = Date.now();
    const pins = ((await cache.getMeta<Record<string, true>>(PINS_KEY)) ?? {}) as Record<string, true>;
    for (const victim of oldestBeyond(lru, new Set(Object.keys(pins)), MAX_CACHED_BLOCK_PAGES)) {
      await cache.replaceTable(`blocks:${victim}`, []);
      delete lru[victim];
    }
    await cache.setMeta(BLOCKS_LRU_KEY, lru);
  }, userId);
}

/** Stamp a database's cached tables as recently used; evict LRU overflow. */
export function stampDatabaseCached(userId: string, dbId: string) {
  enqueue(async (cache) => {
    const lru = ((await cache.getMeta<LruMap>(DB_LRU_KEY)) ?? {}) as LruMap;
    lru[dbId] = Date.now();
    // Offline-pinned databases are exempt from LRU eviction, mirroring
    // stampBlocksCached: a pinned database page is itself in the pin set, so
    // pass those ids as the keep-set instead of an empty one (which evicted
    // pinned databases once the cache overflowed).
    const pins = ((await cache.getMeta<Record<string, true>>(PINS_KEY)) ?? {}) as Record<string, true>;
    for (const victim of oldestBeyond(lru, new Set(Object.keys(pins)), MAX_CACHED_DBS)) {
      await dropDatabaseRowCaches(cache, victim);
      for (const table of ["props", "views", "templates"]) {
        await cache.replaceTable(`${table}:${victim}`, []);
      }
      delete lru[victim];
    }
    await cache.setMeta(DB_LRU_KEY, lru);
  }, userId);
}

// ── per-view row query caches (local-first Phase 3 v2) ──────────────────────
// Row first-pages are cached per (db, query-key hash) so offline view
// switching works beyond the last-used view; a small per-db LRU keeps it
// bounded.

export const MAX_CACHED_ROW_QUERIES_PER_DB = 3;

type RowsKeyEntry = { at: number; h: string };

/** Short stable hash for cache table suffixes (query keys can be long). */
export function hashCacheKey(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

async function dropDatabaseRowCaches(cache: RecordCache, dbId: string) {
  const keysKey = `rowsKeys:${dbId}`;
  const list = ((await cache.getMeta<RowsKeyEntry[]>(keysKey)) ?? []) as RowsKeyEntry[];
  for (const entry of list) {
    await cache.replaceTable(`rowsdata:${dbId}:${entry.h}`, []);
    await cache.replaceTable(`rowsrelated:${dbId}:${entry.h}`, []);
    await cache.removeMeta(`rows:${dbId}:${entry.h}`);
  }
  await cache.removeMeta(keysKey);
}

/** Track a cached row query for a db; evict the oldest beyond the cap. */
export function registerRowsCacheKey(userId: string, dbId: string, suffix: string) {
  enqueue(async (cache) => {
    const keysKey = `rowsKeys:${dbId}`;
    const list = (((await cache.getMeta<RowsKeyEntry[]>(keysKey)) ?? []) as RowsKeyEntry[]).filter(
      (entry) => entry.h !== suffix
    );
    list.push({ at: Date.now(), h: suffix });
    list.sort((a, b) => a.at - b.at);
    while (list.length > MAX_CACHED_ROW_QUERIES_PER_DB) {
      const victim = list.shift();
      if (!victim) break;
      await cache.replaceTable(`rowsdata:${dbId}:${victim.h}`, []);
      await cache.replaceTable(`rowsrelated:${dbId}:${victim.h}`, []);
      await cache.removeMeta(`rows:${dbId}:${victim.h}`);
    }
    await cache.setMeta(keysKey, list);
  }, userId);
}

/** Cached block-page ids, most recently used first (bounded by the LRU cap). */
export async function listCachedBlockPageIds(userId: string): Promise<string[]> {
  const lru = (await cacheGetMeta<LruMap>(userId, BLOCKS_LRU_KEY)) ?? {};
  return Object.entries(lru)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

export async function getOfflinePins(userId: string): Promise<Record<string, true>> {
  return (await cacheGetMeta<Record<string, true>>(userId, PINS_KEY)) ?? {};
}

export async function setOfflinePin(userId: string, pageId: string, pinned: boolean) {
  const cache = await getCache(userId);
  if (!cache) return;
  try {
    await chain;
    const pins = ((await cache.getMeta<Record<string, true>>(PINS_KEY)) ?? {}) as Record<string, true>;
    if (pinned) pins[pageId] = true;
    else delete pins[pageId];
    await cache.setMeta(PINS_KEY, pins);
  } catch (error) {
    warn(error);
  }
}

/** Fire-and-forget write-through of a whole record table. */
export function cacheReplaceTable(userId: string, table: string, records: RecordCacheRecord[]) {
  enqueue((cache) => cache.replaceTable(table, records), userId);
}

/** Fire-and-forget meta write (bootstrap payloads, per-table stamps). */
export function cacheSetMeta(userId: string, key: string, value: unknown) {
  enqueue((cache) => cache.setMeta(key, value), userId);
}

export async function cacheListTable<V = unknown>(
  userId: string,
  table: string
): Promise<RecordCacheRecord<V>[]> {
  // Undecided lock gate: reads report "no cache" instead of blocking, so the
  // network paths keep the app fully usable behind the unlock dialog.
  if (localBoxIfSettled(userId) === "pending") return [];
  const cache = await getCache(userId);
  if (!cache) return [];
  try {
    await chain;
    return await cache.listTable<V>(table);
  } catch (error) {
    warn(error);
    return [];
  }
}

export async function cacheGetMeta<V = unknown>(
  userId: string,
  key: string
): Promise<V | undefined> {
  if (localBoxIfSettled(userId) === "pending") return undefined;
  const cache = await getCache(userId);
  if (!cache) return undefined;
  try {
    await chain;
    return await cache.getMeta<V>(key);
  } catch (error) {
    warn(error);
    return undefined;
  }
}

/** Wipe the current user's record cache (logout / reset-local-data). */
export async function recordCacheClear(userId: string) {
  const cache = await getCache(userId);
  if (!cache) return;
  try {
    await chain;
    await cache.clear();
  } catch (error) {
    warn(error);
  }
}

/** Test hook: drop the cached instance so a fresh adapter is created. */
export function resetRecordCacheForTests() {
  current = null;
  chain = Promise.resolve();
  warnedOnce = false;
}

/** Await all queued cache writes — test hook for deterministic assertions. */
export async function recordCacheIdleForTests() {
  await chain;
}
