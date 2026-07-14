import type { WorkspaceBootstrapResult } from "./edgebase";
import type { Block, Page } from "./types";
import {
  cacheRemoveRecords,
  cacheReplaceRecordIfPresent,
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
  const writes: Promise<void>[] = [];

  if (bootstrapKey) {
    writes.push(
      cacheUpdateMeta<WorkspaceBootstrapResult>(
        userId,
        recordCacheMeta.bootstrap(bootstrapKey),
        (current) => {
          if (!current?.pages?.some((candidate) => candidate.id === page.id)) {
            return undefined;
          }
          return {
            ...current,
            pages: current.pages.map((candidate) =>
              candidate.id === page.id ? page : candidate
            ),
          };
        }
      )
    );
  }

  if (page.parentType === "database" && page.parentId) {
    for (const queryKey of new Set(activeQueryKeys)) {
      writes.push(
        cacheReplaceRecordIfPresent(
          userId,
          databaseRowCacheKeys(page.parentId, queryKey).dataTable,
          { id: page.id, value: page }
        )
      );
    }
  }

  await Promise.all(writes);
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
