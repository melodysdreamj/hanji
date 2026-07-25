import type { WorkspaceBootstrapResult } from "./edgebase";
import type { Block, Page } from "./types";
import {
  cacheRemoveRecords,
  cacheReconcileRelatedRecordsIfSourcePresent,
  cacheReplaceRecordsIfPresent,
  cacheSetMeta,
  cacheUpdateMeta,
  cacheUpsertRecord,
} from "./recordCache";
import {
  databaseRowCacheKeys,
  recordCacheMeta,
  recordCacheTables,
} from "./recordCacheKeys";

export interface PersistedPageCacheInput {
  activeQueryKeys?: Iterable<string>;
  bootstrapKey?: string;
  page: Page;
  userId: string;
}

export interface PersistedPageCacheEntry {
  activeQueryKeys?: Iterable<string>;
  page: Page;
  /** Resolve once inside the first queued cache task so newer optimistic state wins. */
  resolvePage?: () => Page;
}

export interface PersistedPagesCacheInput {
  bootstrapKey?: string;
  pages: Iterable<PersistedPageCacheEntry>;
  userId: string;
}

export interface PersistedRelatedPagesCacheInput {
  databaseId: string;
  pages: Iterable<Page>;
  queryKeys: Iterable<string>;
  sourceId: string;
  userId: string;
}

// Reciprocal relation fanout is not fixed by the response contract (existing
// backend coverage exceeds 100 rows). Bound both each cache rewrite and the
// number of queued table surfaces, then drain later chunks immediately.
export const PERSISTED_PAGE_CACHE_COMMIT_CHUNK_SIZE = 64;

async function commitPersistedPageChunk(
  chunk: PersistedPageCacheEntry[],
  bootstrapKey: string | undefined,
  userId: string
): Promise<void> {
  const latestById = new Map<string, PersistedPageCacheEntry>();
  for (const entry of chunk) latestById.set(entry.page.id, entry);

  const entriesByTable = new Map<string, PersistedPageCacheEntry[]>();
  for (const entry of latestById.values()) {
    const { page } = entry;
    if (page.parentType !== "database" || !page.parentId) continue;
    for (const queryKey of new Set(entry.activeQueryKeys ?? [])) {
      const table = databaseRowCacheKeys(page.parentId, queryKey).dataTable;
      const entries = entriesByTable.get(table) ?? [];
      entries.push(entry);
      entriesByTable.set(table, entries);
    }
  }

  // All surfaces in this chunk must commit the same projected generation.
  // Resolve lazily inside the first FIFO task so an optimistic edit made while
  // an older cache tail is held overlays the latest authoritative response.
  let resolvedById: Map<string, Page> | undefined;
  const resolvePages = () => {
    if (resolvedById) return resolvedById;
    resolvedById = new Map(
      Array.from(latestById, ([id, entry]) => [id, entry.resolvePage?.() ?? entry.page])
    );
    return resolvedById;
  };

  const writes: Promise<void>[] = [];
  if (bootstrapKey) {
    writes.push(
      cacheUpdateMeta<WorkspaceBootstrapResult>(
        userId,
        recordCacheMeta.bootstrap(bootstrapKey),
        (current) => {
          if (!current?.pages?.some((candidate) => latestById.has(candidate.id))) {
            return undefined;
          }
          const replacements = resolvePages();
          return {
            ...current,
            pages: current.pages.map((candidate) => replacements.get(candidate.id) ?? candidate),
          };
        },
        { propagateFailure: true }
      )
    );
  }

  for (const [table, entries] of entriesByTable) {
    writes.push(
      cacheReplaceRecordsIfPresent(
        userId,
        table,
        () => {
          const replacements = resolvePages();
          return entries.map((entry) => {
            const page = replacements.get(entry.page.id) ?? entry.page;
            return { id: page.id, value: page };
          });
        },
        { propagateFailure: true }
      )
    );
  }

  // The record-cache FIFO serializes these already-grouped surface tasks. Wait
  // for every safe task even if one fails, then propagate the first failure so
  // publication and outbox acknowledgement cannot overtake the cache tail.
  const results = await Promise.allSettled(writes);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/**
 * Commit an authoritative response in bounded surface-grouped chunks. There is
 * no timer between chunks: overflow keeps draining in the same acknowledged
 * mutation, and a cache failure is reported only after all chunks are tried.
 */
export async function commitPersistedPagesToCache({
  bootstrapKey,
  pages,
  userId,
}: PersistedPagesCacheInput): Promise<void> {
  let chunk: PersistedPageCacheEntry[] = [];
  let firstFailure: { error: unknown } | undefined;

  const drain = async () => {
    if (chunk.length === 0) return;
    const current = chunk;
    chunk = [];
    try {
      await commitPersistedPageChunk(current, bootstrapKey, userId);
    } catch (error) {
      firstFailure ??= { error };
    }
  };

  for (const entry of pages) {
    chunk.push(entry);
    if (chunk.length === PERSISTED_PAGE_CACHE_COMMIT_CHUNK_SIZE) await drain();
  }
  await drain();
  if (firstFailure) throw firstFailure.error;
}

/**
 * Project selected relation targets into every warm query that already owns
 * the acknowledged source row. Compatible targets are deduplicated and
 * committed once per query surface; all surfaces are attempted before the
 * first failure propagates to the acknowledgement boundary.
 */
export async function commitPersistedRelatedPagesToCache({
  databaseId,
  pages,
  queryKeys,
  sourceId,
  userId,
}: PersistedRelatedPagesCacheInput): Promise<void> {
  const pagesById = new Map<string, Page>();
  for (const page of pages) pagesById.set(page.id, page);
  if (pagesById.size === 0) return;

  const records = () =>
    Array.from(pagesById.values(), (page) => ({ id: page.id, value: page }));
  const writes = Array.from(new Set(queryKeys), (queryKey) => {
    const keys = databaseRowCacheKeys(databaseId, queryKey);
    return cacheReconcileRelatedRecordsIfSourcePresent({
      dataTable: keys.dataTable,
      records,
      relatedTable: keys.relatedPagesTable,
      sourceId,
      userId,
    });
  });
  const results = await Promise.allSettled(writes);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/**
 * Commit an authoritative page/row to every warm cache that already owns it.
 * Query membership is intentionally not inferred here: filtered query caches
 * only replace an existing row and never gain a row merely because it changed.
 */
export async function commitPersistedPageToCache({
  activeQueryKeys = [],
  bootstrapKey,
  page,
  userId,
}: PersistedPageCacheInput): Promise<void> {
  await commitPersistedPagesToCache({
    bootstrapKey,
    pages: [{ activeQueryKeys, page }],
    userId,
  });
}

export async function commitPersistedBlockToCache(
  userId: string,
  block: Block
): Promise<void> {
  await cacheUpsertRecord(userId, recordCacheTables.blocks(block.pageId), {
    id: block.id,
    value: block,
  });
  // A block response is authoritative for the block, but not necessarily for
  // its parent page stamp. Force the next online refresh without discarding
  // the locally committed block.
  await cacheSetMeta(userId, recordCacheMeta.blocksStamp(block.pageId), "");
}

export async function commitPersistedBlockDeletionToCache(
  userId: string,
  pageId: string,
  blockIds: string[]
): Promise<void> {
  await cacheRemoveRecords(userId, recordCacheTables.blocks(pageId), blockIds);
  await cacheSetMeta(userId, recordCacheMeta.blocksStamp(pageId), "");
}
