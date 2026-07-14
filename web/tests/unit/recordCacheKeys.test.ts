import { describe, expect, it } from "vitest";

import {
  databaseRowCacheKeys,
  databaseRowCacheKeysFromSuffix,
  hashRecordCacheKey,
  recordCacheMeta,
  recordCacheTables,
} from "@/lib/recordCacheKeys";

describe("record cache key schema", () => {
  it("keeps entity tables and query membership metadata in distinct namespaces", () => {
    expect(recordCacheTables.blocks("page-1")).toBe("blocks:page-1");
    expect(recordCacheTables.databaseProperties("db-1")).toBe("props:db-1");
    expect(recordCacheMeta.blocksStamp("page-1")).toBe("blocksStamp:page-1");
    expect(recordCacheMeta.databaseRowQueryRegistry("db-1")).toBe("rowsKeys:db-1");
  });

  it("derives every row-query cache key from one stable suffix", () => {
    const keys = databaseRowCacheKeys("db-1", "filter=status:open&sort=due");

    expect(keys.suffix).toBe(hashRecordCacheKey("filter=status:open&sort=due"));
    expect(keys).toEqual(databaseRowCacheKeysFromSuffix("db-1", keys.suffix));
    expect(keys.dataTable).toBe(`rowsdata:db-1:${keys.suffix}`);
    expect(keys.relatedPagesTable).toBe(`rowsrelated:db-1:${keys.suffix}`);
    expect(keys.meta).toBe(`rows:db-1:${keys.suffix}`);
  });
});
