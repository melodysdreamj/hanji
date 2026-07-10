// Unit tests for the MCP-local formula/rollup evaluators in src/index.mjs.
// These must mirror the shared formula-core/rollup-core contract so a row's
// computed value matches what the backend returns: invalid calendar dates are
// rejected (not silently rolled forward), and count_* rollups are numbers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formulaDate, evaluateRollupValue, formulaReplace, formulaTest } from "../src/index.mjs";

describe("formulaDate", () => {
  it("parses a valid ISO date", () => {
    const date = formulaDate("2024-02-29");
    assert.ok(date instanceof Date);
    assert.equal(date.getUTCFullYear(), 2024);
    assert.equal(date.getUTCMonth(), 1);
    assert.equal(date.getUTCDate(), 29);
  });

  it("rejects a calendar-overflow date instead of rolling it forward", () => {
    // 2024-02-30 would roll to 2024-03-01 via Date.UTC; the shared core treats
    // it as invalid and returns empty, so formulaDate must return null.
    assert.equal(formulaDate("2024-02-30"), null);
    assert.equal(formulaDate("2023-02-29"), null); // 2023 is not a leap year
    assert.equal(formulaDate("2024-13-01"), null); // month overflow
    assert.equal(formulaDate("2024-04-31"), null); // April has 30 days
  });

  it("returns null for empty input", () => {
    assert.equal(formulaDate(""), null);
    assert.equal(formulaDate(null), null);
  });
});

describe("evaluateRollupValue count functions", () => {
  const relationProp = { id: "rel", type: "relation", databaseId: "dbA", config: { relationDatabaseId: "dbB" } };
  const prop = (fn) => ({
    id: "roll",
    type: "rollup",
    databaseId: "dbA",
    config: { rollupRelationPropertyId: "rel", rollupFunction: fn },
  });
  const row = { id: "row-1", properties: { rel: ["p1", "p2", "p3"] } };
  const pagesById = {
    p1: { id: "p1", title: "One" },
    p2: { id: "p2", title: "Two" },
    p3: { id: "p3", title: "Three" },
  };
  const props = [relationProp];
  const propsByDb = { dbA: [relationProp], dbB: [] };

  it("returns count_all as a number, not a string", () => {
    const value = evaluateRollupValue(row, prop("count_all"), pagesById, props, propsByDb);
    assert.equal(typeof value, "number");
    assert.equal(value, 3);
  });

  it("returns count_values/count_unique/count_empty as numbers", () => {
    for (const fn of ["count_values", "count_unique", "count_empty"]) {
      const value = evaluateRollupValue(row, prop(fn), pagesById, props, propsByDb);
      assert.equal(typeof value, "number", `${fn} must be a number`);
    }
  });
});

describe("formula regex caps (ReDoS mitigation)", () => {
  // Workspace-authored patterns run per row per query. Oversized patterns or
  // subjects must fall back to LITERAL string handling instead of compiling a
  // RegExp, so a hostile pattern cannot pin the event loop.
  it("keeps regex semantics for ordinary patterns", () => {
    assert.equal(formulaReplace("a1b2", "\\d", "#", true), "a#b#");
    assert.equal(formulaTest("abc", "b+"), true);
    assert.equal(formulaTest("abc", "z+"), false);
  });

  it("treats over-long patterns as literal text", () => {
    const pattern = ".".repeat(257); // as a regex this would match ANY 257 chars
    const subject = "x".repeat(300);
    assert.equal(formulaReplace(subject, pattern, "!"), subject, "no literal dots → nothing replaced");
    assert.equal(formulaTest(subject, pattern), false, "no literal dots → no match");
    // A literal occurrence still matches under the fallback.
    assert.equal(formulaTest(pattern, pattern), true);
  });

  it("treats over-long subjects as literal text", () => {
    const subject = "a".repeat(10_001);
    assert.equal(formulaTest(subject, "a+$"), false, "regex would match; literal 'a+$' does not");
    assert.equal(formulaReplace(subject, "a+", "!"), subject, "regex would collapse the run; literal leaves it");
    // At the cap the regex path still applies.
    assert.equal(formulaTest("a".repeat(10_000), "a+$"), true);
  });

  it("still falls back to literal handling for invalid patterns", () => {
    assert.equal(formulaTest("a[b", "a["), true);
    assert.equal(formulaReplace("a[b", "a[", "x"), "xb");
  });
});
