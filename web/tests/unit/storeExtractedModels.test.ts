import { describe, expect, it } from "vitest";
import {
  persistableDatabaseRowProperties,
  persistablePagePatch,
  stripComputedFromPages,
} from "../../src/lib/storeEntityPolicy";
import {
  remapViewConfigPropertyIds,
  viewConfigWithoutProperty,
} from "../../src/lib/databaseViewConfigModel";
import type { Page, ViewConfig } from "../../src/lib/types";

describe("extracted store entity policy", () => {
  it("removes imported internal row fields and server-owned timestamps", () => {
    expect(
      persistableDatabaseRowProperties({ title: "kept", __notionSnapshot: { id: "raw" } })
    ).toEqual({ title: "kept" });

    const row = {
      id: "row-1",
      parentType: "database",
      properties: { title: "kept", __computed: "drop" },
    } as Page;
    expect(
      persistablePagePatch(
        {
          properties: row.properties,
          createdAt: "server-owned",
          updatedAt: "server-owned",
          __computed: { total: 1 },
        },
        row
      )
    ).toEqual({ properties: { title: "kept" } });
  });

  it("strips computed page projections without cloning unchanged pages", () => {
    const clean = { id: "clean" } as Page;
    const computed = { id: "computed", __computed: { total: 1 } } as Page;
    const pages = { clean, computed };
    const result = stripComputedFromPages(pages);
    expect(result.clean).toBe(clean);
    expect(result.computed).not.toBe(computed);
    expect(result.computed.__computed).toBeUndefined();
  });
});

describe("extracted database view config model", () => {
  const config: ViewConfig = {
    visibleProperties: ["title", "status"],
    propertyOrder: ["title", "status"],
    propertyWidths: { title: 240, status: 120 },
    filters: [{ propertyId: "status", operator: "equals", value: "Done" }],
    filterGroup: {
      conjunction: "and",
      filters: [{ propertyId: "status", operator: "equals", value: "Done" }],
      groups: [],
    },
    sorts: [{ propertyId: "status", direction: "asc" }],
    groupBy: "status",
  };

  it("removes a deleted property from every owned view-config surface", () => {
    const next = viewConfigWithoutProperty(config, "status");
    expect(next.visibleProperties).toEqual(["title"]);
    expect(next.propertyOrder).toEqual(["title"]);
    expect(next.propertyWidths).toEqual({ title: 240 });
    expect(next.filters).toEqual([]);
    expect(next.filterGroup).toBeUndefined();
    expect(next.sorts).toEqual([]);
    expect(next.groupBy).toBeUndefined();
  });

  it("remaps schema ids without mutating the cached source config", () => {
    const next = remapViewConfigPropertyIds(config, new Map([["status", "state"]]));
    expect(next.visibleProperties).toEqual(["title", "state"]);
    expect(next.propertyWidths).toEqual({ title: 240, state: 120 });
    expect(next.filters?.[0]?.propertyId).toBe("state");
    expect(next.filterGroup?.filters[0]?.propertyId).toBe("state");
    expect(next.sorts?.[0]?.propertyId).toBe("state");
    expect(next.groupBy).toBe("state");
    expect(config.groupBy).toBe("status");
  });
});
