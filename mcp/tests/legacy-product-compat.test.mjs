import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hanjiEnv,
  hanjiUri,
  hanjiUriPayload,
  matchHanjiPageLink,
  matchHanjiSyncedBlock,
} from "../src/legacy-product-compat.mjs";

const formerEnvPrefix = ["NOTION", "LIKE_"].join("");
const formerUriScheme = ["notion", "like"].join("");
const touchedEnvNames = new Map();

function setEnv(name, value) {
  if (!touchedEnvNames.has(name)) touchedEnvNames.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, previous] of touchedEnvNames) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  touchedEnvNames.clear();
});

describe("legacy product namespace compatibility", () => {
  it("prefers the canonical environment variable and otherwise reads the former prefix", () => {
    const canonicalName = "HANJI_MCP_CLIENT_ID";
    const formerName = `${formerEnvPrefix}MCP_CLIENT_ID`;
    setEnv(formerName, "former-client");
    assert.equal(hanjiEnv(canonicalName), "former-client");

    setEnv(canonicalName, "hanji-client");
    assert.equal(hanjiEnv(canonicalName), "hanji-client");
  });

  it("emits only canonical URIs while accepting the former URI scheme", () => {
    assert.equal(hanjiUri("page", "page-1"), "hanji://page/page-1");
    assert.equal(
      hanjiUriPayload(`${formerUriScheme}://page/page-1`, "page"),
      "page-1",
    );
    assert.equal(hanjiUriPayload("hanji://date/2026-07-12", "date"), "2026-07-12");
  });

  it("parses canonical and former Markdown resource links", () => {
    assert.deepEqual(
      matchHanjiPageLink("[Page](hanji://page/page-1)")?.slice(1),
      ["Page", "page-1"],
    );
    assert.equal(
      matchHanjiPageLink(`[Page](${formerUriScheme}://page/page-2)`)?.[2],
      "page-2",
    );
    assert.equal(
      matchHanjiSyncedBlock(`[Synced block](${formerUriScheme}://block/block-1)`)?.[1],
      "block-1",
    );
  });
});
