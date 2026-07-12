import { describe, expect, it } from "vitest";
import type {
  DbProperty,
  Page,
  PropertyConfig,
  PropertyType,
  RollupFunction,
} from "@/lib/types";
import {
  displayPropertyValue,
  evaluateRollup,
  secondHopDatabaseId,
  valueAsIds,
} from "@/components/database/rollup";

let seq = 0;
function makeProp(
  name: string,
  type: PropertyType,
  config?: PropertyConfig,
  databaseId = "db"
): DbProperty {
  return {
    id: `prop_${name}_${++seq}`,
    databaseId,
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

describe("valueAsIds", () => {
  it("stringifies arrays, wraps scalars, drops empties", () => {
    expect(valueAsIds(["a", 2])).toEqual(["a", "2"]);
    expect(valueAsIds("x")).toEqual(["x"]);
    expect(valueAsIds(7)).toEqual(["7"]);
    expect(valueAsIds("")).toEqual([]);
    expect(valueAsIds(null)).toEqual([]);
    expect(valueAsIds(undefined)).toEqual([]);
    expect(valueAsIds([])).toEqual([]);
  });
});

describe("displayPropertyValue", () => {
  it("shows titles (with Untitled fallback)", () => {
    const prop = makeProp("Name", "title");
    expect(displayPropertyValue(makeRow("r", { title: "Hello" }), prop, {})).toBe("Hello");
    expect(displayPropertyValue(makeRow("r", { title: " " }), prop, {})).toBe("Untitled");
  });

  it("maps select/status/multi_select option ids to names", () => {
    const options = [
      { id: "o1", name: "One", color: "red" },
      { id: "o2", name: "Two", color: "blue" },
    ];
    const select = makeProp("S", "select", { options });
    const multi = makeProp("M", "multi_select", { options });
    const row = makeRow("r", {
      properties: { [select.id]: "o1", [multi.id]: ["o1", "o2", "ghost"] },
    });
    expect(displayPropertyValue(row, select, {})).toBe("One");
    expect(displayPropertyValue(row, multi, {})).toBe("One, Two, ghost");
  });

  it("shows checkboxes as Checked/Unchecked", () => {
    const prop = makeProp("C", "checkbox");
    expect(
      displayPropertyValue(makeRow("r", { properties: { [prop.id]: true } }), prop, {})
    ).toBe("Checked");
    expect(displayPropertyValue(makeRow("r"), prop, {})).toBe("Unchecked");
  });

  it("formats numbers per the property format", () => {
    const prop = makeProp("N", "number", { numberFormat: "number" });
    expect(
      displayPropertyValue(makeRow("r", { properties: { [prop.id]: 12.5 } }), prop, {})
    ).toBe("12.5");
  });

  it("formats dates", () => {
    const prop = makeProp("D", "date");
    expect(
      displayPropertyValue(
        makeRow("r", { properties: { [prop.id]: "2001-06-01" } }),
        prop,
        {}
      )
    ).toBe("Jun 1, 2001");
  });

  it("resolves relation ids to page titles", () => {
    const prop = makeProp("R", "relation");
    const other = makeRow("other", { title: "Other page" });
    expect(
      displayPropertyValue(
        makeRow("r", { properties: { [prop.id]: ["other"] } }),
        prop,
        { other }
      )
    ).toBe("Other page");
  });

  it("shows file names for files properties", () => {
    const prop = makeProp("F", "files");
    const row = makeRow("r", {
      properties: { [prop.id]: [{ name: "doc.pdf", url: "https://a.io/doc.pdf" }] },
    });
    expect(displayPropertyValue(row, prop, {})).toBe("doc.pdf");
  });

  it("falls back to string/join for plain values", () => {
    const prop = makeProp("T", "rich_text");
    expect(
      displayPropertyValue(makeRow("r", { properties: { [prop.id]: "text" } }), prop, {})
    ).toBe("text");
    expect(displayPropertyValue(makeRow("r"), prop, {})).toBe("");
  });
});

describe("evaluateRollup", () => {
  const targetNumber = makeProp("Score", "number", undefined, "target-db");
  const targetCheck = makeProp("Done", "checkbox", undefined, "target-db");
  const targetDate = makeProp("When", "date", undefined, "target-db");
  const relation = makeProp("Rel", "relation", { relationDatabaseId: "target-db" });

  const related = [
    makeRow("t1", {
      title: "First",
      properties: { [targetNumber.id]: 10, [targetCheck.id]: true, [targetDate.id]: "2026-01-05" },
    }),
    makeRow("t2", {
      title: "Second",
      properties: { [targetNumber.id]: 20, [targetCheck.id]: false, [targetDate.id]: "2026-03-01" },
    }),
    makeRow("t3", {
      title: "Third",
      properties: { [targetCheck.id]: true },
    }),
  ];
  const pagesById = Object.fromEntries(related.map((page) => [page.id, page]));
  const row = makeRow("src", { properties: { [relation.id]: ["t1", "t2", "t3"] } });

  function run(fn: RollupFunction, targetPropertyId?: string) {
    const prop = makeProp("Rollup", "rollup", {
      rollupRelationPropertyId: relation.id,
      rollupTargetPropertyId: targetPropertyId,
      rollupFunction: fn,
    });
    return evaluateRollup({
      row,
      prop,
      sourceProps: [relation, prop],
      targetProps: [targetNumber, targetCheck, targetDate],
      pagesById,
    });
  }

  it("returns empty string when the relation property is missing", () => {
    const prop = makeProp("Rollup", "rollup", {
      rollupRelationPropertyId: "ghost",
      rollupFunction: "count_all",
    });
    expect(
      evaluateRollup({ row, prop, sourceProps: [], targetProps: [], pagesById })
    ).toBe("");
  });

  it("counts related pages", () => {
    expect(run("count_all")).toBe("3");
  });

  it("skips trashed pages", () => {
    const trashed = { ...related[0], inTrash: true };
    const prop = makeProp("Rollup", "rollup", {
      rollupRelationPropertyId: relation.id,
      rollupFunction: "count_all",
    });
    expect(
      evaluateRollup({
        row,
        prop,
        sourceProps: [relation],
        targetProps: [],
        pagesById: { ...pagesById, t1: trashed },
      })
    ).toBe("2");
  });

  it("counts values / empties / percents", () => {
    expect(run("count_values", targetNumber.id)).toBe("2");
    expect(run("count_empty", targetNumber.id)).toBe("1");
    expect(run("count_unique", targetNumber.id)).toBe("2");
    expect(run("percent_not_empty", targetNumber.id)).toBe("66.67%");
    expect(run("percent_empty", targetNumber.id)).toBe("33.33%");
  });

  it("computes checkbox rollups", () => {
    expect(run("checked", targetCheck.id)).toBe("2");
    expect(run("unchecked", targetCheck.id)).toBe("1");
    expect(run("percent_checked", targetCheck.id)).toBe("66.67%");
    expect(run("percent_unchecked", targetCheck.id)).toBe("33.33%");
  });

  it("computes numeric aggregates", () => {
    expect(run("sum", targetNumber.id)).toBe("30");
    expect(run("average", targetNumber.id)).toBe("15");
    expect(run("median", targetNumber.id)).toBe("15");
    expect(run("min", targetNumber.id)).toBe("10");
    expect(run("max", targetNumber.id)).toBe("20");
    expect(run("range", targetNumber.id)).toBe("10");
  });

  it("returns empty for numeric aggregates with no numbers", () => {
    expect(run("sum", targetDate.id)).toBe("");
  });

  it("computes date aggregates", () => {
    expect(run("earliest_date", targetDate.id)).toBe("2026-01-05");
    expect(run("latest_date", targetDate.id)).toBe("2026-03-01");
    expect(run("date_range", targetDate.id)).toBe("2026-01-05 → 2026-03-01");
  });

  it("show_original lists target values (or titles without a target)", () => {
    expect(run("show_original", targetNumber.id)).toBe("10, 20");
    expect(run("show_original")).toBe("First, Second, Third");
  });

  it("resolves a second hop when the target is itself a relation", () => {
    // src --Rel--> mid rows --MidRel--> leaf rows, rollup shows leaf titles.
    const midRel = makeProp("MidRel", "relation", { relationDatabaseId: "leaf-db" }, "target-db");
    const leaf = makeRow("leaf1", { title: "Leaf title" });
    const mid = makeRow("mid1", { properties: { [midRel.id]: ["leaf1"] } });
    const srcRow = makeRow("src2", { properties: { [relation.id]: ["mid1"] } });
    const prop = makeProp("Rollup", "rollup", {
      rollupRelationPropertyId: relation.id,
      rollupTargetPropertyId: midRel.id,
      rollupFunction: "show_original",
    });
    const result = evaluateRollup({
      row: srcRow,
      prop,
      sourceProps: [relation],
      targetProps: [midRel],
      pagesById: { mid1: mid, leaf1: leaf },
      propsByDb: { "target-db": [midRel], "leaf-db": [] },
    });
    expect(result).toBe("Leaf title");
  });
});

describe("secondHopDatabaseId", () => {
  it("returns the relation target database when the rollup target is a relation", () => {
    const midRel = makeProp("MidRel", "relation", { relationDatabaseId: "leaf-db" }, "target-db");
    const prop = makeProp("Rollup", "rollup", {
      rollupRelationPropertyId: "rel",
      rollupTargetPropertyId: midRel.id,
    });
    expect(secondHopDatabaseId(prop, [midRel], undefined)).toBe("leaf-db");
  });

  it("returns undefined when there is no second hop", () => {
    const target = makeProp("Score", "number", undefined, "target-db");
    const prop = makeProp("Rollup", "rollup", {
      rollupRelationPropertyId: "rel",
      rollupTargetPropertyId: target.id,
    });
    expect(secondHopDatabaseId(prop, [target], undefined)).toBeUndefined();
    expect(secondHopDatabaseId(prop, [], undefined)).toBeUndefined();
  });

  it("follows nested rollup targets through their relation", () => {
    const innerRel = makeProp("InnerRel", "relation", { relationDatabaseId: "leaf-db" }, "target-db");
    const nestedRollup = makeProp(
      "Nested",
      "rollup",
      { rollupRelationPropertyId: innerRel.id, rollupTargetPropertyId: "x" },
      "target-db"
    );
    const prop = makeProp("Rollup", "rollup", {
      rollupRelationPropertyId: "rel",
      rollupTargetPropertyId: nestedRollup.id,
    });
    expect(
      secondHopDatabaseId(prop, [nestedRollup], { "target-db": [innerRel, nestedRollup] })
    ).toBe("leaf-db");
  });
});
