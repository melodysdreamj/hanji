// Unit tests for the mtime-keyed MCP policy file cache in src/edgebase.mjs.
// api() consults the policy several times per request; the file must be
// re-read only when its mtime changes. Cache hits are observable behavior:
// rewriting the file while pinning the original mtime must return the OLD
// parsed data, and bumping the mtime must pick up the new content.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHanjiProductEnvName } from "../src/legacy-product-compat.mjs";

let importCounter = 0;
async function freshEdgeBase() {
  importCounter += 1;
  return import(`../src/edgebase.mjs?policy-cache=${importCounter}`);
}

describe("MCP policy file cache", () => {
  let savedEnv;
  let dir;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (isHanjiProductEnvName(key) || key.startsWith("EDGEBASE_")) delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), "mcp-policy-cache-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("serves cached policy data until the file mtime changes", async () => {
    const path = join(dir, "policy.json");
    const pinned = new Date(Date.now() - 60_000);
    writeFileSync(path, JSON.stringify({ readOnly: true }));
    utimesSync(path, pinned, pinned);
    process.env.HANJI_MCP_POLICY_FILE = path;

    const { eb } = await freshEdgeBase();
    assert.equal(eb.mcpAccessPolicy().readOnly, true, "initial read parses the file");

    // Rewrite the file but pin the original mtime: a cache hit must keep
    // returning the previously parsed data (no re-read happened).
    writeFileSync(path, JSON.stringify({ readOnly: false }));
    utimesSync(path, pinned, pinned);
    assert.equal(eb.mcpAccessPolicy().readOnly, true, "same mtime → cached parse is reused");

    // Bump the mtime: the change must be picked up.
    const bumped = new Date(Date.now() - 30_000);
    utimesSync(path, bumped, bumped);
    assert.equal(eb.mcpAccessPolicy().readOnly, false, "new mtime → file is re-read");
  });

  it("still fails clearly for an invalid policy file", async () => {
    const path = join(dir, "policy.json");
    writeFileSync(path, "[]");
    process.env.HANJI_MCP_POLICY_FILE = path;

    const { eb } = await freshEdgeBase();
    assert.throws(() => eb.mcpAccessPolicy(), /policy file must contain a JSON object/);
    // A failed read must not poison the cache: fixing the file recovers.
    writeFileSync(path, JSON.stringify({ readOnly: true }));
    assert.equal(eb.mcpAccessPolicy().readOnly, true);
  });
});
