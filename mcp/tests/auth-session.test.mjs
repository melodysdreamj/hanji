// Unit tests for the EdgeBase client's session lifecycle in src/edgebase.mjs:
// proactive refresh before the access token's exp, reactive refresh on 401
// with a single retry, rotated-refresh-token persistence, single-flight
// sign-in/refresh/bootstrap under concurrency, and the static-token 401
// message. Each test imports a FRESH module instance (unique query string) so
// module-level token state cannot leak between tests, and mocks global fetch.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isHanjiProductEnvName } from "../src/legacy-product-compat.mjs";

const BASE = "http://edgebase.test";

let importCounter = 0;
async function freshEdgeBase() {
  importCounter += 1;
  return import(`../src/edgebase.mjs?fresh=${importCounter}`);
}

let jwtCounter = 0;
function jwt(expiresInSeconds) {
  jwtCounter += 1;
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-1",
      jti: `token-${jwtCounter}`, // keep every minted token distinct
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function fakeResponse(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

/**
 * Install a fetch mock that routes by pathname and records calls.
 * @param {(call: {path: string, body: any, headers: Record<string,string>}) => {status: number, json: any}} handler
 */
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init = {}) => {
      const call = {
        path: new URL(url).pathname,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
        body: init.body ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const { status, json } = handler(call);
      return fakeResponse(status, json);
    }
  );
  return calls;
}

const PAGE = { id: "p1", workspaceId: "ws-1", kind: "page", title: "Doc" };

describe("EdgeBase session lifecycle", () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (isHanjiProductEnvName(key) || key.startsWith("EDGEBASE_")) delete process.env[key];
    }
    process.env.HANJI_EDGEBASE_URL = BASE;
    process.env.HANJI_MCP_HTTP_RETRIES = "0";
    console.error = () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realError;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("single-flights concurrent first calls into exactly one anonymous sign-in", async () => {
    const { eb } = await freshEdgeBase();
    const token = jwt(900);
    const calls = installFetch((call) => {
      if (call.path === "/api/auth/signin/anonymous") {
        return { status: 200, json: { accessToken: token, refreshToken: "refresh-1" } };
      }
      if (call.path === "/api/functions/page-query") return { status: 200, json: { page: PAGE } };
      return { status: 500, json: { error: `no route ${call.path}` } };
    });

    const [a, b] = await Promise.all([eb.getOne("pages", "p1"), eb.getOne("pages", "p1")]);
    assert.equal(a.id, "p1");
    assert.equal(b.id, "p1");
    const signIns = calls.filter((call) => call.path === "/api/auth/signin/anonymous");
    assert.equal(signIns.length, 1, "two concurrent first calls share one sign-in");
    const queries = calls.filter((call) => call.path === "/api/functions/page-query");
    assert.equal(queries.length, 2);
    for (const query of queries) {
      assert.equal(query.headers.Authorization, `Bearer ${token}`, "both requests carry the signed-in identity");
    }
  });

  it("proactively refreshes before expiry and persists the rotated refresh token", async () => {
    const { eb } = await freshEdgeBase();
    const shortLived = jwt(10); // inside the 30s refresh leeway on the next call
    const secondToken = jwt(900);
    const thirdToken = jwt(900);
    const refreshBodies = [];
    let reject401Once = false;
    const calls = installFetch((call) => {
      if (call.path === "/api/auth/signin/anonymous") {
        return { status: 200, json: { accessToken: shortLived, refreshToken: "refresh-1" } };
      }
      if (call.path === "/api/auth/refresh") {
        refreshBodies.push(call.body?.refreshToken);
        return refreshBodies.length === 1
          ? { status: 200, json: { accessToken: secondToken, refreshToken: "refresh-2" } }
          : { status: 200, json: { accessToken: thirdToken, refreshToken: "refresh-3" } };
      }
      if (call.path === "/api/functions/page-query") {
        if (reject401Once) {
          reject401Once = false;
          return { status: 401, json: { error: "expired" } };
        }
        return { status: 200, json: { page: PAGE } };
      }
      return { status: 500, json: { error: `no route ${call.path}` } };
    });

    await eb.getOne("pages", "p1"); // sign-in, uses the short-lived token
    await eb.getOne("pages", "p1"); // expiry-driven refresh
    await eb.getOne("pages", "p1"); // fresh token: no extra refresh

    assert.equal(calls.filter((call) => call.path === "/api/auth/signin/anonymous").length, 1);
    assert.deepEqual(refreshBodies, ["refresh-1"], "refresh sends the stored refresh token in the body");
    const queries = calls.filter((call) => call.path === "/api/functions/page-query");
    assert.equal(queries[0].headers.Authorization, `Bearer ${shortLived}`);
    assert.equal(queries[1].headers.Authorization, `Bearer ${secondToken}`);
    assert.equal(queries[2].headers.Authorization, `Bearer ${secondToken}`);

    // A later refresh (forced via 401) must use the ROTATED token refresh-2.
    reject401Once = true;
    await eb.getOne("pages", "p1");
    assert.deepEqual(refreshBodies, ["refresh-1", "refresh-2"], "rotation persisted: the second refresh sends refresh-2");
  });

  it("reactively refreshes on 401 and retries the original request exactly once", async () => {
    const { eb } = await freshEdgeBase();
    const first = jwt(900);
    const second = jwt(900);
    const calls = installFetch((call) => {
      if (call.path === "/api/auth/signin/anonymous") {
        return { status: 200, json: { accessToken: first, refreshToken: "refresh-1" } };
      }
      if (call.path === "/api/auth/refresh") {
        return { status: 200, json: { accessToken: second, refreshToken: "refresh-2" } };
      }
      if (call.path === "/api/functions/page-query") {
        return call.headers.Authorization === `Bearer ${second}`
          ? { status: 200, json: { page: PAGE } }
          : { status: 401, json: { error: "expired" } };
      }
      return { status: 500, json: { error: `no route ${call.path}` } };
    });

    const page = await eb.getOne("pages", "p1");
    assert.equal(page.id, "p1", "the original request succeeds after the 401-driven refresh");
    assert.equal(calls.filter((call) => call.path === "/api/auth/refresh").length, 1);
    const queries = calls.filter((call) => call.path === "/api/functions/page-query");
    assert.equal(queries.length, 2, "retried exactly once");
    assert.equal(queries[0].headers.Authorization, `Bearer ${first}`);
    assert.equal(queries[1].headers.Authorization, `Bearer ${second}`);
  });

  it("single-flights concurrent expiry-driven refreshes", async () => {
    const { eb } = await freshEdgeBase();
    const shortLived = jwt(10);
    const nextToken = jwt(900);
    const calls = installFetch((call) => {
      if (call.path === "/api/auth/signin/anonymous") {
        return { status: 200, json: { accessToken: shortLived, refreshToken: "refresh-1" } };
      }
      if (call.path === "/api/auth/refresh") {
        return { status: 200, json: { accessToken: nextToken, refreshToken: "refresh-2" } };
      }
      if (call.path === "/api/functions/page-query") return { status: 200, json: { page: PAGE } };
      return { status: 500, json: { error: `no route ${call.path}` } };
    });

    await eb.getOne("pages", "p1"); // prime the short-lived session
    await Promise.all([eb.getOne("pages", "p1"), eb.getOne("pages", "p1")]);
    assert.equal(
      calls.filter((call) => call.path === "/api/auth/refresh").length,
      1,
      "two concurrent stale calls share one refresh",
    );
  });

  it("falls back to a fresh anonymous sign-in (new identity) when refresh fails", async () => {
    const { eb } = await freshEdgeBase();
    const shortLived = jwt(10);
    const replacement = jwt(900);
    let signIns = 0;
    const calls = installFetch((call) => {
      if (call.path === "/api/auth/signin/anonymous") {
        signIns += 1;
        return signIns === 1
          ? { status: 200, json: { accessToken: shortLived, refreshToken: "refresh-1" } }
          : { status: 200, json: { accessToken: replacement, refreshToken: "refresh-2" } };
      }
      if (call.path === "/api/auth/refresh") {
        return { status: 401, json: { error: "refresh-token-reused" } };
      }
      if (call.path === "/api/functions/page-query") return { status: 200, json: { page: PAGE } };
      return { status: 500, json: { error: `no route ${call.path}` } };
    });

    await eb.getOne("pages", "p1");
    const page = await eb.getOne("pages", "p1"); // stale → refresh fails → fresh sign-in
    assert.equal(page.id, "p1");
    assert.equal(signIns, 2, "a failed refresh falls back to a new anonymous identity");
    const queries = calls.filter((call) => call.path === "/api/functions/page-query");
    assert.equal(queries.at(-1).headers.Authorization, `Bearer ${replacement}`);
  });

  it("fails 401s in static-token mode with fresh-token guidance and no retry", async () => {
    process.env.HANJI_MCP_ACCESS_TOKEN = "static-token";
    const { eb } = await freshEdgeBase();
    const calls = installFetch((call) => {
      if (call.path === "/api/functions/page-query") return { status: 401, json: { error: "expired" } };
      return { status: 500, json: { error: `no route ${call.path}` } };
    });

    await assert.rejects(
      () => eb.getOne("pages", "p1"),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /token has likely expired/i);
        assert.match(message, /HANJI_MCP_ACCESS_TOKEN/);
        assert.doesNotMatch(message, /HTTP 401\)\.$/, "not the raw sanitized HTTP failure");
        return true;
      },
    );
    assert.equal(calls.filter((call) => call.path === "/api/auth/refresh").length, 0);
    assert.equal(calls.filter((call) => call.path === "/api/auth/signin/anonymous").length, 0);
    assert.equal(calls.filter((call) => call.path === "/api/functions/page-query").length, 1, "no blind retry");
  });

  it("single-flights concurrent workspace bootstraps", async () => {
    const { eb } = await freshEdgeBase();
    const token = jwt(900);
    const calls = installFetch((call) => {
      if (call.path === "/api/auth/signin/anonymous") {
        return { status: 200, json: { accessToken: token, refreshToken: "refresh-1" } };
      }
      if (call.path === "/api/functions/workspace-bootstrap") {
        return { status: 200, json: { workspace: { id: "ws-1", name: "Workspace" } } };
      }
      return { status: 500, json: { error: `no route ${call.path}` } };
    });

    const [a, b] = await Promise.all([eb.workspace(), eb.workspace()]);
    assert.equal(a.id, "ws-1");
    assert.equal(b.id, "ws-1");
    assert.equal(
      calls.filter((call) => call.path === "/api/functions/workspace-bootstrap").length,
      1,
      "two concurrent first calls share one bootstrap",
    );
  });
});
