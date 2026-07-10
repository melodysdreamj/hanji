"use client";

// Local quick-find over cached content (local-first Phase 3 —
// docs/local-first-roadmap.md). Page titles are already searched in-memory by
// SearchDialog; this covers block *content* when the server search is
// unreachable: first the in-memory blocks of this session, then the record
// cache's recently-used block tables.

import { cacheListTable, listCachedBlockPageIds } from "./recordCache";
import { useStore } from "./store";
import type { Block } from "./types";

export interface LocalBlockHit {
  block: Block;
  pageId: string;
}

// Cap the IndexedDB scan: most-recent pages first, mirroring the LRU cap.
const MAX_SCANNED_CACHED_PAGES = 50;

function blockMatches(block: Block, q: string): boolean {
  const text = block.plainText ?? "";
  return !!text && text.toLowerCase().includes(q);
}

export async function searchCachedBlockHits(
  userId: string,
  query: string,
  limit: number
): Promise<LocalBlockHit[]> {
  const q = query.trim().toLowerCase();
  if (!q || !userId) return [];
  const hits: LocalBlockHit[] = [];
  const scannedPages = new Set<string>();

  const blocksByPage = useStore.getState().blocksByPage;
  for (const [pageId, blocks] of Object.entries(blocksByPage)) {
    scannedPages.add(pageId);
    for (const block of blocks) {
      if (blockMatches(block, q)) {
        hits.push({ block, pageId });
        if (hits.length >= limit) return hits;
      }
    }
  }

  const cachedPageIds = (await listCachedBlockPageIds(userId)).filter(
    (pageId) => !scannedPages.has(pageId)
  );
  for (const pageId of cachedPageIds.slice(0, MAX_SCANNED_CACHED_PAGES)) {
    const records = await cacheListTable<Block>(userId, `blocks:${pageId}`);
    for (const record of records) {
      if (blockMatches(record.value, q)) {
        hits.push({ block: record.value, pageId });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}
