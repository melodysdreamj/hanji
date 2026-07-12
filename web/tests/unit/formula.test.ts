import { describe, expect, it } from "vitest";
import type { DbProperty, Page, PropertyConfig, PropertyType } from "@/lib/types";
import {
  evaluateFormula,
  formatFormulaValue,
  formulaWarnings,
} from "@/components/database/formula";

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

function makeRow(patch: Partial<Page> = {}): Page {
  return {
    id: "row1",
    workspaceId: "ws",
    parentType: "page",
    kind: "database_row",
    title: "Row title",
    iconType: "emoji",
    position: 0,
    ...patch,
  } as Page;
}

function evalExpr(
  formula: string,
  props: DbProperty[] = [],
  row: Page = makeRow(),
  pagesById: Record<string, Page> = {}
) {
  const formulaProp = makeProp("Formula", "formula", { formula });
  return evaluateFormula({ row, prop: formulaProp, props: [...props, formulaProp], pagesById });
}

describe("evaluateFormula", () => {
  it("returns empty string when no expression is configured", () => {
    const prop = makeProp("F", "formula", {});
    expect(evaluateFormula({ row: makeRow(), prop, props: [prop], pagesById: {} })).toBe("");
    const blank = makeProp("F", "formula", { formula: "   " });
    expect(evaluateFormula({ row: makeRow(), prop: blank, props: [blank], pagesById: {} })).toBe("");
  });

  it("evaluates arithmetic and function calls", () => {
    expect(evalExpr("1 + 2 * 3")).toBe(7);
    expect(evalExpr("add(2, 3)")).toBe(5);
    expect(evalExpr('concat("a", "b")')).toBe("ab");
    expect(evalExpr('upper("abc")')).toBe("ABC");
    expect(evalExpr("if(true, 1, 2)")).toBe(1);
  });

  it("resolves prop() references by property name", () => {
    const num = makeProp("Score", "number");
    const row = makeRow({ properties: { [num.id]: 21 } });
    expect(evalExpr('prop("Score") * 2', [num], row)).toBe(42);
  });

  it("resolves title/checkbox/date property values", () => {
    const title = makeProp("Name", "title");
    const check = makeProp("Done", "checkbox");
    const date = makeProp("When", "date");
    const row = makeRow({
      title: "제목",
      properties: { [check.id]: true, [date.id]: { start: "2026-07-01", end: "2026-07-04" } },
    });
    expect(evalExpr('prop("Name")', [title], row)).toBe("제목");
    expect(evalExpr('prop("Done")', [check], row)).toBe(true);
    expect(evalExpr('prop("When")', [date], row)).toBe("2026-07-01/2026-07-04");
  });

  it("resolves select properties to their option display names", () => {
    const select = makeProp("Status", "select", {
      options: [{ id: "opt1", name: "Active", color: "green" }],
    });
    const row = makeRow({ properties: { [select.id]: "opt1" } });
    expect(evalExpr('prop("Status")', [select], row)).toBe("Active");
  });

  it("returns empty string for unknown and self references", () => {
    expect(evalExpr('prop("Nope")')).toBe("");
    const prop = makeProp("Self", "formula", { formula: 'prop("Self")' });
    expect(evaluateFormula({ row: makeRow(), prop, props: [prop], pagesById: {} })).toBe("");
  });

  it("treats missing values as empty", () => {
    const num = makeProp("N", "number");
    expect(evalExpr('empty(prop("N"))', [num], makeRow({ properties: {} }))).toBe(true);
  });
});

describe("formulaWarnings", () => {
  const props = [makeProp("Score", "number"), makeProp("Name", "title")];

  it("returns [] for empty expressions and valid formulas", () => {
    expect(formulaWarnings(undefined, props)).toEqual([]);
    expect(formulaWarnings("", props)).toEqual([]);
    expect(formulaWarnings('prop("Score") + 1', props)).toEqual([]);
    expect(formulaWarnings("if(true, 1, 2)", props)).toEqual([]);
  });

  it("flags unsupported functions", () => {
    expect(formulaWarnings("bogus(1)", props)).toContain(
      'Unsupported formula function "bogus"'
    );
  });

  it("flags unknown property references", () => {
    expect(formulaWarnings('prop("Missing")', props)).toContain(
      'Unknown property "Missing"'
    );
    // Case-insensitive name matching.
    expect(formulaWarnings('prop("score")', props)).toEqual([]);
  });

  it("flags unsupported bare identifiers but allows literals", () => {
    expect(formulaWarnings("mystery + 1", props)).toContain(
      'Unsupported formula identifier "mystery"'
    );
    expect(formulaWarnings("true", props)).toEqual([]);
    // and/or are functions, not infix keywords.
    expect(formulaWarnings("and(true, false)", props)).toEqual([]);
    expect(formulaWarnings("true and false", props)).toContain(
      'Unsupported formula identifier "and"'
    );
  });

  it("allows let-bound variables", () => {
    expect(formulaWarnings('let("x", 1, x + 1)', props)).toEqual([]);
  });

  it("flags unbalanced parentheses", () => {
    expect(formulaWarnings("(1 + 2", props)).toContain("Unbalanced parentheses");
    expect(formulaWarnings("1 + 2)", props)).toContain("Unbalanced parentheses");
  });

  it("deduplicates repeated warnings", () => {
    const warnings = formulaWarnings("bogus(1) + bogus(2)", props);
    expect(warnings.filter((w) => w.includes("bogus"))).toHaveLength(1);
  });
});

describe("formatFormulaValue", () => {
  it("formats each formula value type", () => {
    expect(formatFormulaValue("text")).toBe("text");
    expect(formatFormulaValue(42)).toBe("42");
    expect(formatFormulaValue(true)).toBe("true");
    expect(formatFormulaValue(false)).toBe("false");
    expect(formatFormulaValue(null)).toBe("");
  });
});
