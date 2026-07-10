import { describe, expect, it } from "vitest";
import type {
  DbProperty,
  DbView,
  FilterGroup,
  Page,
  PropertyConfig,
  PropertyType,
  ViewConfig,
} from "@/lib/types";
import {
  DEFAULT_TABLE_INITIAL_LOAD_LIMIT,
  DEFAULT_TIMELINE_LOAD_LIMIT,
  applyView,
  cellValue,
  currentPageFilterValue,
  isCurrentPageFilterValue,
  matchesFilterGroup,
  orderViewProperties,
  tableInitialLoadLimit,
  timelineLoadLimit,
  viewFilterSeedValues,
  visibleViewProperties,
} from "@/components/database/query";

let seq = 0;
function makeProp(
  name: string,
  type: PropertyType,
  config?: PropertyConfig
): DbProperty {
  return {
    id: `prop_${name}_${++seq}`,
    databaseId: "db",
    name,
    type,
    config,
    position: seq,
  } as DbProperty;
}

function makeRow(id: string, patch: Partial<Page> = {}): Page {
  return {
    id,
    workspaceId: "ws",
    parentType: "page",
    kind: "database_row",
    title: `Row ${id}`,
    iconType: "emoji",
    position: 0,
    ...patch,
  } as Page;
}

function makeView(config: ViewConfig = {}): DbView {
  return {
    id: `view_${++seq}`,
    databaseId: "db",
    name: "View",
    type: "table",
    config,
    position: 0,
  } as DbView;
}

describe("load limits", () => {
  it("accepts known limits and falls back to defaults", () => {
    expect(tableInitialLoadLimit(makeView({ initialLoadLimit: 25 }))).toBe(25);
    expect(tableInitialLoadLimit(makeView({ initialLoadLimit: 33 }))).toBe(
      DEFAULT_TABLE_INITIAL_LOAD_LIMIT
    );
    expect(tableInitialLoadLimit(undefined)).toBe(DEFAULT_TABLE_INITIAL_LOAD_LIMIT);
    expect(timelineLoadLimit(makeView({ timelineLoadLimit: 100 }))).toBe(100);
    expect(timelineLoadLimit(makeView())).toBe(DEFAULT_TIMELINE_LOAD_LIMIT);
  });
});

describe("currentPageFilterValue", () => {
  it("round-trips through isCurrentPageFilterValue", () => {
    expect(isCurrentPageFilterValue(currentPageFilterValue())).toBe(true);
    expect(isCurrentPageFilterValue({ kind: "other" })).toBe(false);
    expect(isCurrentPageFilterValue(null)).toBe(false);
    expect(isCurrentPageFilterValue([currentPageFilterValue()])).toBe(false);
  });
});

describe("cellValue", () => {
  it("reads built-in fields for meta property types", () => {
    const row = makeRow("r", {
      title: "T",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
      createdBy: "u1",
      lastEditedBy: "u2",
    });
    expect(cellValue(row, makeProp("t", "title"))).toBe("T");
    expect(cellValue(row, makeProp("c", "created_time"))).toBe("2026-01-01");
    expect(cellValue(row, makeProp("u", "last_edited_time"))).toBe("2026-01-02");
    expect(cellValue(row, makeProp("cb", "created_by"))).toBe("u1");
    expect(cellValue(row, makeProp("lb", "last_edited_by"))).toBe("u2");
  });

  it("reads properties by id and prefers backend computed values", () => {
    const num = makeProp("n", "number");
    const formula = makeProp("f", "formula");
    const row = makeRow("r", {
      properties: { [num.id]: 5, [formula.id]: "stale" },
      __computed: { [formula.id]: { value: 99, formatted: "99" } },
    });
    expect(cellValue(row, num)).toBe(5);
    expect(cellValue(row, formula)).toBe(99);
  });
});

describe("orderViewProperties / visibleViewProperties", () => {
  it("orders by view config with unlisted properties appended", () => {
    const a = makeProp("A", "rich_text");
    const b = makeProp("B", "rich_text");
    const c = makeProp("C", "rich_text");
    const view = makeView({ propertyOrder: [c.id, a.id] });
    expect(orderViewProperties([a, b, c], view).map((p) => p.name)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("puts the title property first when no order is configured", () => {
    const text = makeProp("Text", "rich_text");
    const title = makeProp("Title", "title");
    expect(orderViewProperties([text, title], makeView()).map((p) => p.name)).toEqual([
      "Title",
      "Text",
    ]);
  });

  it("filters hidden properties but always keeps the title", () => {
    const title = makeProp("Title", "title");
    const shown = makeProp("Shown", "rich_text");
    const hidden = makeProp("Hidden", "rich_text");
    const view = makeView({ hiddenProperties: [hidden.id, title.id] });
    expect(
      visibleViewProperties([title, shown, hidden], view).map((p) => p.name)
    ).toEqual(["Title", "Shown"]);
  });

  it("respects an explicit visible list", () => {
    const title = makeProp("Title", "title");
    const a = makeProp("A", "rich_text");
    const b = makeProp("B", "rich_text");
    const view = makeView({ visibleProperties: [b.id] });
    expect(visibleViewProperties([title, a, b], view).map((p) => p.name)).toEqual([
      "Title",
      "B",
    ]);
  });
});

describe("applyView filters", () => {
  const title = makeProp("Title", "title");
  const num = makeProp("Score", "number");
  const status = makeProp("Status", "select", {
    options: [
      { id: "todo", name: "To do", color: "gray" },
      { id: "done", name: "Done", color: "green" },
    ],
  });
  const check = makeProp("Done?", "checkbox");
  const date = makeProp("Due", "date");
  const props = [title, num, status, check, date];

  const rows = [
    makeRow("r1", {
      title: "Alpha",
      properties: {
        [num.id]: 10,
        [status.id]: "todo",
        [check.id]: true,
        [date.id]: "2026-01-01",
      },
    }),
    makeRow("r2", {
      title: "Beta",
      properties: {
        [num.id]: 20,
        [status.id]: "done",
        [check.id]: false,
        [date.id]: "2026-06-15",
      },
    }),
    makeRow("r3", {
      title: "감마",
      properties: { [num.id]: 30 },
    }),
  ];

  const ids = (out: Page[]) => out.map((row) => row.id);

  it("returns all rows for an empty view", () => {
    expect(applyView(rows, props, makeView())).toHaveLength(3);
  });

  it("filters text with contains / equals / is_empty", () => {
    expect(
      ids(
        applyView(rows, props, makeView({ filters: [{ propertyId: title.id, operator: "contains", value: "alp" }] }))
      )
    ).toEqual(["r1"]);
    expect(
      ids(
        applyView(rows, props, makeView({ filters: [{ propertyId: title.id, operator: "equals", value: "beta" }] }))
      )
    ).toEqual(["r2"]);
  });

  it("filters numbers with comparisons and emptiness", () => {
    const gt = makeView({ filters: [{ propertyId: num.id, operator: "greater_than", value: 15 }] });
    expect(ids(applyView(rows, props, gt))).toEqual(["r2", "r3"]);
    const lt = makeView({ filters: [{ propertyId: num.id, operator: "less_than", value: "15" }] });
    expect(ids(applyView(rows, props, lt))).toEqual(["r1"]);
  });

  it("filters selects by option id or name", () => {
    const byId = makeView({ filters: [{ propertyId: status.id, operator: "equals", value: "done" }] });
    expect(ids(applyView(rows, props, byId))).toEqual(["r2"]);
    const byName = makeView({ filters: [{ propertyId: status.id, operator: "equals", value: "To do" }] });
    expect(ids(applyView(rows, props, byName))).toEqual(["r1"]);
    const empty = makeView({ filters: [{ propertyId: status.id, operator: "is_empty" }] });
    expect(ids(applyView(rows, props, empty))).toEqual(["r3"]);
  });

  it("filters checkboxes", () => {
    const view = makeView({ filters: [{ propertyId: check.id, operator: "equals", value: true }] });
    expect(ids(applyView(rows, props, view))).toEqual(["r1"]);
    const unchecked = makeView({ filters: [{ propertyId: check.id, operator: "equals", value: false }] });
    expect(ids(applyView(rows, props, unchecked))).toEqual(["r2", "r3"]);
  });

  it("filters dates with on_or_after / on_or_before", () => {
    const after = makeView({ filters: [{ propertyId: date.id, operator: "on_or_after", value: "2026-02-01" }] });
    expect(ids(applyView(rows, props, after))).toEqual(["r2"]);
    const before = makeView({ filters: [{ propertyId: date.id, operator: "on_or_before", value: "2026-02-01" }] });
    expect(ids(applyView(rows, props, before))).toEqual(["r1"]);
  });

  it("combines flat filters with AND by default and OR when configured", () => {
    const both = [
      { propertyId: num.id, operator: "greater_than" as const, value: 15 },
      { propertyId: status.id, operator: "equals" as const, value: "done" },
    ];
    expect(ids(applyView(rows, props, makeView({ filters: both })))).toEqual(["r2"]);
    // r1 matches neither branch (score 10, status "todo"); r3 matches score > 15.
    expect(
      ids(applyView(rows, props, makeView({ filters: both, filterConjunction: "or" })))
    ).toEqual(["r2", "r3"]);
  });

  it("ignores filters whose property no longer exists", () => {
    const view = makeView({ filters: [{ propertyId: "ghost", operator: "equals", value: "x" }] });
    expect(applyView(rows, props, view)).toHaveLength(3);
  });

  it("applies a nested filterGroup over the flat filters", () => {
    const group: FilterGroup = {
      conjunction: "or",
      filters: [{ propertyId: title.id, operator: "equals", value: "Alpha" }],
      groups: [
        {
          conjunction: "and",
          filters: [
            { propertyId: num.id, operator: "greater_than", value: 15 },
            { propertyId: status.id, operator: "equals", value: "done" },
          ],
        },
      ],
    };
    const view = makeView({
      filterGroup: group,
      // The flat filter would exclude everything; it must be ignored.
      filters: [{ propertyId: title.id, operator: "equals", value: "nothing" }],
    });
    expect(ids(applyView(rows, props, view))).toEqual(["r1", "r2"]);
  });

  it("searches across properties (including Korean titles)", () => {
    expect(ids(applyView(rows, props, makeView(), {}, { search: "감마" }))).toEqual(["r3"]);
    expect(ids(applyView(rows, props, makeView({ search: "alpha" })))).toEqual(["r1"]);
    expect(ids(applyView(rows, props, makeView(), {}, { search: "to do" }))).toEqual(["r1"]);
  });

  it("resolves current-page filter values for relations", () => {
    const rel = makeProp("Rel", "relation");
    const relRows = [
      makeRow("a", { properties: { [rel.id]: ["current"] } }),
      makeRow("b", { properties: { [rel.id]: ["other"] } }),
    ];
    const view = makeView({
      filters: [{ propertyId: rel.id, operator: "contains", value: [currentPageFilterValue()] }],
    });
    expect(
      ids(applyView(relRows, [rel], view, {}, { currentPageId: "current" }))
    ).toEqual(["a"]);
  });

  it("filters rollup relation targets through the first-hop relation", () => {
    const contractRel = makeProp("계약DB", "relation");
    const partnerRelId = "contract_partner_relation";
    const partnerRollup = makeProp("계약 - 거래처", "rollup", {
      rollupRelationPropertyId: contractRel.id,
      rollupTargetPropertyId: partnerRelId,
      rollupFunction: "show_original",
    });
    const paymentRows = [
      makeRow("payment1", {
        properties: {
          [contractRel.id]: ["contract1"],
          [partnerRollup.id]: "stale imported rollup text",
        },
      }),
      makeRow("payment2", {
        properties: {
          [contractRel.id]: ["contract2"],
          [partnerRollup.id]: "stale imported rollup text",
        },
      }),
    ];
    const pagesById = {
      contract1: makeRow("contract1", { properties: { [partnerRelId]: ["partner_current"] } }),
      contract2: makeRow("contract2", { properties: { [partnerRelId]: ["partner_other"] } }),
    };
    const view = makeView({
      filterGroup: {
        conjunction: "and",
        filters: [
          {
            propertyId: partnerRollup.id,
            operator: "contains",
            value: [currentPageFilterValue()],
          },
        ],
        groups: [],
      },
      notionQuickFilters: { imported: true },
    });

    expect(
      ids(
        applyView(paymentRows, [contractRel, partnerRollup], view, pagesById, {
          currentPageId: "partner_current",
        })
      )
    ).toEqual(["payment1"]);
  });

  it("treats blank relation value filters as incomplete rather than is-empty", () => {
    const rel = makeProp("Rel", "relation");
    const relRows = [
      makeRow("linked", { properties: { [rel.id]: ["target"] } }),
      makeRow("empty", { properties: { [rel.id]: [] } }),
    ];
    expect(
      ids(applyView(relRows, [rel], makeView({ filters: [{ propertyId: rel.id, operator: "equals", value: "" }] })))
    ).toEqual(["linked", "empty"]);
    expect(
      ids(
        applyView(relRows, [rel], makeView({ filters: [{ propertyId: rel.id, operator: "does_not_contain", value: "" }] }))
      )
    ).toEqual(["linked", "empty"]);
    expect(
      ids(applyView(relRows, [rel], makeView({ filters: [{ propertyId: rel.id, operator: "is_empty" }] })))
    ).toEqual(["empty"]);
  });
});

describe("applyView sorts", () => {
  const title = makeProp("Title", "title");
  const num = makeProp("Score", "number");
  const status = makeProp("Status", "select", {
    options: [
      { id: "low", name: "Low", color: "gray" },
      { id: "high", name: "High", color: "red" },
    ],
  });
  const date = makeProp("Due", "date");
  const props = [title, num, status, date];

  const rows = [
    makeRow("r1", { title: "b", properties: { [num.id]: 2, [status.id]: "high", [date.id]: "2026-02-01" } }),
    makeRow("r2", { title: "a", properties: { [num.id]: 10, [status.id]: "low" } }),
    makeRow("r3", { title: "c", properties: { [num.id]: 1, [status.id]: "low", [date.id]: "2026-01-01" } }),
  ];
  const ids = (out: Page[]) => out.map((row) => row.id);

  it("sorts numbers numerically (not lexicographically)", () => {
    const view = makeView({ sorts: [{ propertyId: num.id, direction: "asc" }] });
    expect(ids(applyView(rows, props, view))).toEqual(["r3", "r1", "r2"]);
    const desc = makeView({ sorts: [{ propertyId: num.id, direction: "desc" }] });
    expect(ids(applyView(rows, props, desc))).toEqual(["r2", "r1", "r3"]);
  });

  it("sorts text case-insensitively", () => {
    const view = makeView({ sorts: [{ propertyId: title.id, direction: "asc" }] });
    expect(ids(applyView(rows, props, view))).toEqual(["r2", "r1", "r3"]);
  });

  it("sorts selects by option order", () => {
    const view = makeView({ sorts: [{ propertyId: status.id, direction: "asc" }] });
    expect(ids(applyView(rows, props, view))[0]).toBe("r2"); // "low" is first option... r2/r3 tie
    expect(ids(applyView(rows, props, view))[2]).toBe("r1");
  });

  it("sorts empty dates last in ascending order", () => {
    const view = makeView({ sorts: [{ propertyId: date.id, direction: "asc" }] });
    expect(ids(applyView(rows, props, view))).toEqual(["r3", "r1", "r2"]);
  });

  it("applies multiple sorts with the first sort winning", () => {
    const twoRows = [
      makeRow("x1", { title: "same", properties: { [num.id]: 2 } }),
      makeRow("x2", { title: "same", properties: { [num.id]: 1 } }),
    ];
    const view = makeView({
      sorts: [
        { propertyId: title.id, direction: "asc" },
        { propertyId: num.id, direction: "asc" },
      ],
    });
    expect(ids(applyView(twoRows, props, view))).toEqual(["x2", "x1"]);
  });

  it("keeps equal-key rows in their incoming order (stable decorate-sort)", () => {
    const tied = [
      makeRow("t1", { title: "same", properties: { [num.id]: 7 } }),
      makeRow("t2", { title: "same", properties: { [num.id]: 7 } }),
      makeRow("t3", { title: "same", properties: { [num.id]: 7 } }),
    ];
    const asc = makeView({ sorts: [{ propertyId: num.id, direction: "asc" }] });
    expect(ids(applyView(tied, props, asc))).toEqual(["t1", "t2", "t3"]);
    const desc = makeView({ sorts: [{ propertyId: num.id, direction: "desc" }] });
    expect(ids(applyView(tied, props, desc))).toEqual(["t1", "t2", "t3"]);
  });
});

describe("matchesFilterGroup", () => {
  const num = makeProp("N", "number");
  const byId = new Map([[num.id, num]]);
  const ctx = { props: [num], pagesById: {} };
  const row = makeRow("r", { properties: { [num.id]: 5 } });

  it("matches everything for empty groups", () => {
    expect(matchesFilterGroup(row, { conjunction: "and", filters: [] }, ctx, byId)).toBe(true);
    expect(matchesFilterGroup(row, { conjunction: "or", filters: [] }, ctx, byId)).toBe(true);
  });

  it("skips leaves with unknown properties", () => {
    expect(
      matchesFilterGroup(
        row,
        { conjunction: "and", filters: [{ propertyId: "ghost", operator: "equals", value: 1 }] },
        ctx,
        byId
      )
    ).toBe(true);
  });

  it("combines nested groups with the parent conjunction", () => {
    const group: FilterGroup = {
      conjunction: "or",
      filters: [{ propertyId: num.id, operator: "equals", value: 999 }],
      groups: [
        { conjunction: "and", filters: [{ propertyId: num.id, operator: "less_than", value: 10 }] },
      ],
    };
    expect(matchesFilterGroup(row, group, ctx, byId)).toBe(true);
    const failing: FilterGroup = { ...group, conjunction: "and" };
    expect(matchesFilterGroup(row, failing, ctx, byId)).toBe(false);
  });
});

describe("viewFilterSeedValues", () => {
  const title = makeProp("Title", "title");
  const num = makeProp("Score", "number");
  const select = makeProp("Status", "select", {
    options: [{ id: "todo", name: "To do", color: "gray" }],
  });
  const multi = makeProp("Tags", "multi_select", {
    options: [
      { id: "t1", name: "One", color: "red" },
      { id: "t2", name: "Two", color: "blue" },
    ],
  });
  const props = [title, num, select, multi];

  it("seeds values from AND-combined equals filters", () => {
    const view = makeView({
      filters: [
        { propertyId: title.id, operator: "equals", value: "New row" },
        { propertyId: num.id, operator: "equals", value: "42" },
        { propertyId: select.id, operator: "equals", value: "To do" },
      ],
    });
    const seeds = viewFilterSeedValues(props, view);
    expect(seeds.title).toBe("New row");
    expect(seeds.properties[num.id]).toBe(42);
    expect(seeds.properties[select.id]).toBe("todo");
  });

  it("does not seed from OR-combined filters", () => {
    const view = makeView({
      filterConjunction: "or",
      filters: [{ propertyId: num.id, operator: "equals", value: 1 }],
    });
    expect(viewFilterSeedValues(props, view)).toEqual({ properties: {} });
  });

  it("skips non-seedable operators", () => {
    const view = makeView({
      filters: [
        { propertyId: num.id, operator: "greater_than", value: 3 },
        { propertyId: title.id, operator: "is_not_empty" },
      ],
    });
    expect(viewFilterSeedValues(props, view)).toEqual({ properties: {} });
  });

  it("merges multi_select seeds and drops conflicting scalar seeds", () => {
    const view = makeView({
      filters: [
        { propertyId: multi.id, operator: "equals", value: "One" },
        { propertyId: multi.id, operator: "equals", value: "t2" },
        { propertyId: num.id, operator: "equals", value: 1 },
        { propertyId: num.id, operator: "equals", value: 2 },
      ],
    });
    const seeds = viewFilterSeedValues(props, view);
    expect(seeds.properties[multi.id]).toEqual(["t1", "t2"]);
    expect(seeds.properties[num.id]).toBeUndefined();
  });

  it("omits requested property ids", () => {
    const view = makeView({
      filters: [{ propertyId: num.id, operator: "equals", value: 5 }],
    });
    expect(viewFilterSeedValues(props, view, [num.id])).toEqual({ properties: {} });
  });

  it("collects seeds from nested AND groups", () => {
    const view = makeView({
      filterGroup: {
        conjunction: "and",
        filters: [{ propertyId: num.id, operator: "equals", value: 7 }],
        groups: [
          {
            conjunction: "and",
            filters: [{ propertyId: select.id, operator: "equals", value: "todo" }],
          },
        ],
      },
    });
    const seeds = viewFilterSeedValues(props, view);
    expect(seeds.properties[num.id]).toBe(7);
    expect(seeds.properties[select.id]).toBe("todo");
  });

  it("resolves current-page filter values with the provided page id", () => {
    const rel = makeProp("Rel", "relation");
    const view = makeView({
      filters: [{ propertyId: rel.id, operator: "contains", value: [currentPageFilterValue()] }],
    });
    const seeds = viewFilterSeedValues([rel], view, [], { currentPageId: "cur" });
    expect(seeds.properties[rel.id]).toEqual(["cur"]);
  });
});
