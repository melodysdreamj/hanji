import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MCP orchestration imports the formula runtime instead of owning its parser", async () => {
  const index = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(index, /class FormulaParser\b/);
  assert.doesNotMatch(index, /function tokenizeFormula\b/);
  assert.match(index, /from "\.\/formula-runtime\.mjs"/);
});

test("MCP orchestration delegates database query evaluation and Notion tool parsing", async () => {
  const index = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(index, /function evaluateRollupValue\b/);
  assert.doesNotMatch(index, /function applyDatabaseView\b/);
  assert.doesNotMatch(index, /function parseDataSourceSqlQuery\b/);
  assert.doesNotMatch(index, /function parseNotionViewConfigDsl\b/);
  assert.doesNotMatch(index, /function parseNotionCreateTableSchema\b/);
  assert.match(index, /from "\.\/database-query-runtime\.mjs"/);
  assert.match(index, /from "\.\/notion-tool-dsl\.mjs"/);
});

test("MCP entrypoint stays inside its current orchestration size budget", async () => {
  const index = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(index, /^server\.registerTool\(/m);
  assert.match(index, /from "\.\/tool-registry-foundation\.mjs"/);
  assert.match(index, /from "\.\/tool-registry-database\.mjs"/);
  assert.match(index, /from "\.\/tool-registry-notion\.mjs"/);
  assert.ok(index.split(/\r?\n/).length <= 4_250);

  const foundation = await readFile(
    new URL("../src/tool-registry-foundation.mjs", import.meta.url),
    "utf8"
  );
  const database = await readFile(
    new URL("../src/tool-registry-database.mjs", import.meta.url),
    "utf8"
  );
  const notion = await readFile(
    new URL("../src/tool-registry-notion.mjs", import.meta.url),
    "utf8"
  );
  assert.ok(foundation.split(/\r?\n/).length <= 1_750);
  assert.ok(database.split(/\r?\n/).length <= 1_300);
  assert.ok(notion.split(/\r?\n/).length <= 1_200);
});
