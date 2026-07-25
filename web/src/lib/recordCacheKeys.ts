/**
 * Canonical record-cache key schema.
 *
 * Entity tables and query membership metadata deliberately have separate
 * builders. Callers must not assemble cache keys themselves: a mutation can
 * then update the canonical entity value without pretending that it knows
 * whether a filtered query should gain or lose membership.
 */

/** Short stable hash for cache table suffixes (query keys can be long). */
export function hashRecordCacheKey(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export const recordCacheTables = {
  blocks: (pageId: string) => `blocks:${pageId}`,
  comments: (pageId: string) => `comments:${pageId}`,
  databaseProperties: (databaseId: string) => `props:${databaseId}`,
  databaseTemplates: (databaseId: string) => `templates:${databaseId}`,
  databaseViews: (databaseId: string) => `views:${databaseId}`,
  databaseRows: (databaseId: string, suffix: string) =>
    `rowsdata:${databaseId}:${suffix}`,
  databaseRelatedPages: (databaseId: string, suffix: string) =>
    `rowsrelated:${databaseId}:${suffix}`,
} as const;

export const recordCacheMeta = {
  blocksStamp: (pageId: string) => `blocksStamp:${pageId}`,
  bootstrap: (bootstrapKey: string) => `bootstrap:${bootstrapKey}`,
  commentsCachedAt: (pageId: string) => `commentsCachedAt:${pageId}`,
  databaseMetadataStamp: (databaseId: string) => `dbMetaStamp:${databaseId}`,
  databaseRowQuery: (databaseId: string, suffix: string) =>
    `rows:${databaseId}:${suffix}`,
  databaseRowQueryRegistry: (databaseId: string) => `rowsKeys:${databaseId}`,
} as const;

export interface DatabaseRowCacheKeys {
  dataTable: string;
  meta: string;
  relatedPagesTable: string;
  suffix: string;
}

export function databaseRowCacheKeysFromSuffix(
  databaseId: string,
  suffix: string
): DatabaseRowCacheKeys {
  return {
    dataTable: recordCacheTables.databaseRows(databaseId, suffix),
    meta: recordCacheMeta.databaseRowQuery(databaseId, suffix),
    relatedPagesTable: recordCacheTables.databaseRelatedPages(databaseId, suffix),
    suffix,
  };
}

export function databaseRowCacheKeys(
  databaseId: string,
  queryKey: string
): DatabaseRowCacheKeys {
  return databaseRowCacheKeysFromSuffix(databaseId, hashRecordCacheKey(queryKey));
}
