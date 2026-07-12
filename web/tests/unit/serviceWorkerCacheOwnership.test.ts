import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function runRejectedShellInstall(shellResponse: Response) {
  const listeners = new Map<string, (event: { waitUntil: (value: Promise<unknown>) => void }) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const active = new Map<string, Response>([
    ["/__hanji_shell__", new Response("old shell", { headers: { "content-type": "text/html" } })],
    [
      "/__hanji_precache__",
      new Response(JSON.stringify({ version: "old", assets: ["/"], complete: true })),
    ],
  ]);
  stores.set("hanji-sw-v2", active);
  const cacheFor = (name: string) => {
    let entries = stores.get(name);
    if (!entries) {
      entries = new Map();
      stores.set(name, entries);
    }
    return {
      delete: async (input: string | Request) =>
        entries!.delete(typeof input === "string" ? input : new URL(input.url).pathname),
      keys: async () => [...entries!.keys()].map((path) => new Request(`https://hanji.example${path}`)),
      match: async (input: string | Request) =>
        entries!.get(typeof input === "string" ? input : new URL(input.url).pathname)?.clone(),
      put: async (input: string | Request, response: Response) => {
        entries!.set(
          typeof input === "string" ? input : new URL(input.url).pathname,
          response.clone(),
        );
      },
    };
  };
  const caches = {
    delete: vi.fn(async (name: string) => stores.delete(name)),
    keys: vi.fn(async () => [...stores.keys()]),
    open: vi.fn(async (name: string) => cacheFor(name)),
  };
  const fetchMock = vi.fn(async (input: string) => {
    if (input === "/sw-precache.json") {
      return new Response(JSON.stringify({ version: "new", assets: ["/"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return shellResponse;
  });
  const self = {
    addEventListener: (type: string, listener: (event: { waitUntil: (value: Promise<unknown>) => void }) => void) => {
      listeners.set(type, listener);
    },
    clients: { claim: vi.fn(async () => undefined) },
    location: { origin: "https://hanji.example" },
    skipWaiting: vi.fn(),
  };
  runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
    Request,
    Response,
    URL,
    caches,
    fetch: fetchMock,
    self,
  });
  const install = listeners.get("install");
  if (!install) throw new Error("install listener was not registered");
  let installation!: Promise<unknown>;
  install({ waitUntil: (value) => { installation = value; } });
  return { installation, active, stores };
}

describe("service-worker cache ownership", () => {
  it("keeps the active shell intact when a versioned precache refresh is incomplete", async () => {
    const listeners = new Map<string, (event: { waitUntil: (value: Promise<unknown>) => void }) => void>();
    const stores = new Map<string, Map<string, Response>>();
    const active = new Map<string, Response>([
      ["/__hanji_shell__", new Response("old shell", { headers: { "content-type": "text/html" } })],
      [
        "/__hanji_precache__",
        new Response(JSON.stringify({ version: "old", assets: ["/"], complete: true })),
      ],
    ]);
    stores.set("hanji-sw-v2", active);
    const cacheFor = (name: string) => {
      let entries = stores.get(name);
      if (!entries) {
        entries = new Map();
        stores.set(name, entries);
      }
      return {
        delete: async (input: string | Request) =>
          entries!.delete(typeof input === "string" ? input : new URL(input.url).pathname),
        keys: async () => [...entries!.keys()].map((path) => new Request(`https://hanji.example${path}`)),
        match: async (input: string | Request) =>
          entries!.get(typeof input === "string" ? input : new URL(input.url).pathname)?.clone(),
        put: async (input: string | Request, response: Response) => {
          entries!.set(
            typeof input === "string" ? input : new URL(input.url).pathname,
            response.clone()
          );
        },
      };
    };
    const caches = {
      delete: vi.fn(async (name: string) => stores.delete(name)),
      keys: vi.fn(async () => [...stores.keys()]),
      open: vi.fn(async (name: string) => cacheFor(name)),
    };
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/sw-precache.json") {
        return new Response(
          JSON.stringify({ version: "new", assets: ["/", "/assets/app.js", "/assets/fail.js"] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (input === "/assets/fail.js") return new Response("fail", { status: 503 });
      return new Response(input === "/" ? "new shell" : "new asset", {
        status: 200,
        headers: input === "/" ? { "content-type": "text/html" } : undefined,
      });
    });
    const self = {
      addEventListener: (type: string, listener: (event: { waitUntil: (value: Promise<unknown>) => void }) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      Request,
      Response,
      URL,
      caches,
      fetch: fetchMock,
      self,
    });
    const install = listeners.get("install");
    if (!install) throw new Error("install listener was not registered");
    let installation!: Promise<unknown>;
    install({ waitUntil: (value) => { installation = value; } });

    await expect(installation).rejects.toThrow(/Offline asset failed/);
    await expect(active.get("/__hanji_shell__")?.text()).resolves.toBe("old shell");
    await expect(active.get("/__hanji_precache__")?.json()).resolves.toMatchObject({
      version: "old",
      complete: true,
    });
    expect(stores.has("hanji-sw-stage-new")).toBe(false);
  });

  it("rolls back mutable assets, shell, and marker when the active-cache commit fails", async () => {
    const listeners = new Map<string, (event: { waitUntil: (value: Promise<unknown>) => void }) => void>();
    const stores = new Map<string, Map<string, Response>>();
    const oldMarker = { version: "old", assets: ["/", "/theme-init.js"], complete: true };
    const active = new Map<string, Response>([
      ["/theme-init.js", new Response("old theme", { headers: { "content-type": "application/javascript" } })],
      ["/__hanji_shell__", new Response("old shell", { headers: { "content-type": "text/html" } })],
      ["/__hanji_precache__", new Response(JSON.stringify(oldMarker), { headers: { "content-type": "application/json" } })],
    ]);
    stores.set("hanji-sw-v2", active);
    const pathOf = (input: string | Request) =>
      typeof input === "string" ? input : new URL(input.url).pathname;
    let rejectShellCommitOnce = true;
    const cacheFor = (name: string) => {
      let entries = stores.get(name);
      if (!entries) {
        entries = new Map();
        stores.set(name, entries);
      }
      return {
        delete: async (input: string | Request) => entries!.delete(pathOf(input)),
        keys: async () => [...entries!.keys()].map((path) => new Request(`https://hanji.example${path}`)),
        match: async (input: string | Request) => entries!.get(pathOf(input))?.clone(),
        put: async (input: string | Request, response: Response) => {
          const path = pathOf(input);
          if (name === "hanji-sw-v2" && path === "/__hanji_shell__" && rejectShellCommitOnce) {
            rejectShellCommitOnce = false;
            throw new Error("synthetic active-cache quota failure");
          }
          entries!.set(path, response.clone());
        },
      };
    };
    const caches = {
      delete: vi.fn(async (name: string) => stores.delete(name)),
      keys: vi.fn(async () => [...stores.keys()]),
      open: vi.fn(async (name: string) => cacheFor(name)),
    };
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/sw-precache.json") {
        return new Response(JSON.stringify({
          version: "new",
          assets: ["/", "/theme-init.js", "/assets/app-Abc123Xy.js"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input === "/") {
        return new Response("new shell", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(input.includes("theme") ? "new theme" : "new asset", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    });
    const self = {
      addEventListener: (type: string, listener: (event: { waitUntil: (value: Promise<unknown>) => void }) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      Request,
      Response,
      URL,
      caches,
      fetch: fetchMock,
      self,
    });
    const install = listeners.get("install");
    if (!install) throw new Error("install listener was not registered");
    let installation!: Promise<unknown>;
    install({ waitUntil: (value) => { installation = value; } });

    await expect(installation).rejects.toThrow("synthetic active-cache quota failure");
    await expect(active.get("/theme-init.js")?.text()).resolves.toBe("old theme");
    await expect(active.get("/__hanji_shell__")?.text()).resolves.toBe("old shell");
    await expect(active.get("/__hanji_precache__")?.json()).resolves.toEqual(oldMarker);
    expect(active.has("/assets/app-Abc123Xy.js")).toBe(false);
    expect(stores.has("hanji-sw-stage-new")).toBe(false);
    expect(stores.has("hanji-sw-rollback-new")).toBe(false);
  });

  it("rejects a non-HTML 200 response instead of promoting it to the offline shell", async () => {
    const { installation, active, stores } = await runRejectedShellInstall(
      new Response(JSON.stringify({ error: "temporary outage" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(installation).rejects.toThrow("Offline asset failed: /");
    await expect(active.get("/__hanji_shell__")?.text()).resolves.toBe("old shell");
    expect(stores.has("hanji-sw-stage-new")).toBe(false);
  });

  it("rejects a cross-origin final response instead of caching redirected shell content", async () => {
    const redirected = new Response("external shell", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(redirected, "url", { value: "https://evil.example/" });
    const { installation, active, stores } = await runRejectedShellInstall(redirected);

    await expect(installation).rejects.toThrow("Offline asset failed: /");
    await expect(active.get("/__hanji_shell__")?.text()).resolves.toBe("old shell");
    expect(stores.has("hanji-sw-stage-new")).toBe(false);
  });

  it("deletes stale app-shell caches without touching offline attachments", async () => {
    const listeners = new Map<string, (event: { waitUntil: (value: Promise<unknown>) => void }) => void>();
    const deleted: string[] = [];
    const shellCache = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      match: vi.fn(async () => undefined),
    };
    const self = {
      addEventListener: (type: string, listener: (event: { waitUntil: (value: Promise<unknown>) => void }) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    const caches = {
      delete: vi.fn(async (key: string) => {
        deleted.push(key);
        return true;
      }),
      keys: vi.fn(async () => [
        ["notion", "like-sw-v1"].join(""),
        "hanji-sw-v0",
        "hanji-sw-v1",
        "hanji-sw-v2",
        "hanji-offline-files-v1",
        "third-party-runtime-cache",
      ]),
      open: vi.fn(async () => shellCache),
    };

    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      Request,
      Response,
      URL,
      caches,
      fetch: vi.fn(),
      self,
    });
    const activate = listeners.get("activate");
    if (!activate) throw new Error("activate listener was not registered");
    let activation!: Promise<unknown>;
    activate({ waitUntil: (value) => { activation = value; } });
    await activation;

    expect(deleted).toEqual([
      ["notion", "like-sw-v1"].join(""),
      "hanji-sw-v0",
      "hanji-sw-v1",
    ]);
    expect(deleted).not.toContain("hanji-offline-files-v1");
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
  });

  it("hands off only same-origin immutable legacy assets before deleting the old cache", async () => {
    type WorkerEvent = {
      request?: { method: string; mode: string; url: string };
      respondWith?: (value: Promise<Response>) => void;
      waitUntil: (value: Promise<unknown>) => void;
    };
    const listeners = new Map<string, (event: WorkerEvent) => void>();
    const oldCacheName = ["notion", "like-sw-v1"].join("");
    const safePath = "/assets/Editor-BwbIofh5.js";
    const existingPath = "/assets/Existing-Current9.js";
    const badMimePath = "/assets/Editor-BadHash9.js";
    const redirectedPath = "/assets/Editor-Redirect9.js";
    const mutableMetadataPaths = [
      "/assets/site-precache.json",
      "/assets/site-configuration.json",
      "/assets/site-version2026.json",
    ];
    const withUrl = (response: Response, url: string) => {
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const stores = new Map<string, Map<string, Response>>([
      [
        "hanji-sw-v2",
        new Map([
          [
            existingPath,
            new Response("current chunk", {
              headers: { "content-type": "application/javascript" },
            }),
          ],
        ]),
      ],
      [
        oldCacheName,
        new Map([
          [
            safePath,
            withUrl(
              new Response("old lazy chunk", {
                headers: { "content-type": "application/javascript" },
              }),
              `https://hanji.example${safePath}`
            ),
          ],
          [
            badMimePath,
            withUrl(
              new Response("<html>not javascript</html>", {
                headers: { "content-type": "text/html" },
              }),
              `https://hanji.example${badMimePath}`
            ),
          ],
          [
            existingPath,
            withUrl(
              new Response("old conflicting chunk", {
                headers: { "content-type": "application/javascript" },
              }),
              `https://hanji.example${existingPath}`
            ),
          ],
          [
            redirectedPath,
            withUrl(
              new Response("redirected javascript", {
                headers: { "content-type": "application/javascript" },
              }),
              `https://evil.example${redirectedPath}`
            ),
          ],
          ...mutableMetadataPaths.map(
            (path) =>
              [
                path,
                withUrl(
                  new Response("{}", {
                    headers: { "content-type": "application/json" },
                  }),
                  `https://hanji.example${path}`
                ),
              ] as [string, Response]
          ),
          ["/__old_shell__", new Response("old shell")],
        ]),
      ],
      ["hanji-offline-files-v1", new Map([["/private", new Response("private")]])],
    ]);
    const pathOf = (input: string | Request) =>
      typeof input === "string" ? input : new URL(input.url).pathname;
    const cacheFor = (name: string) => {
      let entries = stores.get(name);
      if (!entries) {
        entries = new Map();
        stores.set(name, entries);
      }
      return {
        delete: async (input: string | Request) => entries!.delete(pathOf(input)),
        keys: async () =>
          [...entries!.keys()].map((path) => new Request(`https://hanji.example${path}`)),
        match: async (input: string | Request) => entries!.get(pathOf(input)),
        put: async (input: string | Request, response: Response) => {
          entries!.set(pathOf(input), response.clone());
        },
      };
    };
    const caches = {
      delete: vi.fn(async (name: string) => stores.delete(name)),
      keys: vi.fn(async () => [...stores.keys()]),
      open: vi.fn(async (name: string) => cacheFor(name)),
    };
    const self = {
      addEventListener: (type: string, listener: (event: WorkerEvent) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      Request,
      Response,
      URL,
      caches,
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      self,
    });
    const activate = listeners.get("activate");
    if (!activate) throw new Error("activate listener was not registered");
    let activation!: Promise<unknown>;
    activate({ waitUntil: (value) => { activation = value; } });
    await activation;

    expect(stores.has(oldCacheName)).toBe(false);
    expect(stores.has("hanji-offline-files-v1")).toBe(true);
    expect(stores.get("hanji-sw-v2")?.has(safePath)).toBe(true);
    await expect(stores.get("hanji-sw-v2")?.get(existingPath)?.text()).resolves.toBe(
      "current chunk"
    );
    expect(stores.get("hanji-sw-v2")?.has(badMimePath)).toBe(false);
    expect(stores.get("hanji-sw-v2")?.has(redirectedPath)).toBe(false);
    for (const path of mutableMetadataPaths) {
      expect(stores.get("hanji-sw-v2")?.has(path)).toBe(false);
    }
    expect(stores.get("hanji-sw-v2")?.has("/__old_shell__")).toBe(false);

    const fetchListener = listeners.get("fetch");
    if (!fetchListener) throw new Error("fetch listener was not registered");
    let response!: Promise<Response>;
    fetchListener({
      request: {
        method: "GET",
        mode: "cors",
        url: `https://hanji.example${safePath}`,
      },
      respondWith: (value) => { response = value; },
      waitUntil: () => {},
    });
    await expect((await response).text()).resolves.toBe("old lazy chunk");
  });

  it("retains and serves a validated legacy asset when handoff storage fails", async () => {
    type WorkerEvent = {
      request?: { method: string; mode: string; url: string };
      respondWith?: (value: Promise<Response>) => void;
      waitUntil: (value: Promise<unknown>) => void;
    };
    const listeners = new Map<string, (event: WorkerEvent) => void>();
    const oldCacheName = ["notion", "like-sw-v1"].join("");
    const assetPath = "/assets/Editor-GraceHash9.js";
    const oldResponse = new Response("grace chunk", {
      headers: { "content-type": "application/javascript" },
    });
    Object.defineProperty(oldResponse, "url", { value: `https://hanji.example${assetPath}` });
    const oldCache = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => [new Request(`https://hanji.example${assetPath}`)]),
      match: vi.fn(async () => oldResponse),
      put: vi.fn(async () => undefined),
    };
    const currentCache = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new DOMException("quota", "QuotaExceededError");
      }),
    };
    const caches = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => [oldCacheName, "hanji-sw-v2"]),
      open: vi.fn(async (name: string) => (name === oldCacheName ? oldCache : currentCache)),
    };
    const self = {
      addEventListener: (type: string, listener: (event: WorkerEvent) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      DOMException,
      Request,
      Response,
      URL,
      caches,
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      self,
    });
    const activate = listeners.get("activate");
    if (!activate) throw new Error("activate listener was not registered");
    let activation!: Promise<unknown>;
    activate({ waitUntil: (value) => { activation = value; } });
    await activation;
    expect(caches.delete).not.toHaveBeenCalledWith(oldCacheName);

    const fetchListener = listeners.get("fetch");
    if (!fetchListener) throw new Error("fetch listener was not registered");
    let response!: Promise<Response>;
    fetchListener({
      request: {
        method: "GET",
        mode: "cors",
        url: `https://hanji.example${assetPath}`,
      },
      respondWith: (value) => { response = value; },
      waitUntil: () => {},
    });
    await expect((await response).text()).resolves.toBe("grace chunk");
  });

  it("never intercepts API/download navigations or caches non-HTML as the shell", async () => {
    type FetchEvent = {
      request: { method: string; mode: string; url: string };
      respondWith: ReturnType<typeof vi.fn>;
      waitUntil: ReturnType<typeof vi.fn>;
    };
    const listeners = new Map<string, (event: FetchEvent) => void>();
    const shellCache = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    const self = {
      addEventListener: (type: string, listener: (event: FetchEvent) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    const caches = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      open: vi.fn(async () => shellCache),
    };
    const fetchMock = vi.fn();
    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      Request,
      Response,
      URL,
      caches,
      fetch: fetchMock,
      self,
    });
    const fetchListener = listeners.get("fetch");
    if (!fetchListener) throw new Error("fetch listener was not registered");

    for (const path of ["/api/storage/files/private.pdf", "/admin", "/private-export.pdf"]) {
      const event: FetchEvent = {
        request: { method: "GET", mode: "navigate", url: `https://hanji.example${path}` },
        respondWith: vi.fn(),
        waitUntil: vi.fn(),
      };
      fetchListener(event);
      expect(event.respondWith, path).not.toHaveBeenCalled();
    }

    fetchMock.mockImplementation(async (input: { url?: string } | string) => {
      const url = typeof input === "string" ? input : input.url ?? "";
      if (url.endsWith("/sw-precache.json")) throw new TypeError("offline");
      return new Response(JSON.stringify({ private: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const appEvent: FetchEvent = {
      request: { method: "GET", mode: "navigate", url: "https://hanji.example/p/page-1" },
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    fetchListener(appEvent);
    const responsePromise = appEvent.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await expect(responsePromise).resolves.toBeInstanceOf(Response);
    expect(shellCache.put).not.toHaveBeenCalled();

    const accountEvent: FetchEvent = {
      request: { method: "GET", mode: "navigate", url: "https://hanji.example/account" },
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    fetchListener(accountEvent);
    expect(accountEvent.respondWith).toHaveBeenCalledTimes(1);
    await accountEvent.respondWith.mock.calls[0]?.[0];

    const redirectedAsset = new Response("external script", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
    Object.defineProperty(redirectedAsset, "url", {
      value: "https://evil.example/app.js",
    });
    fetchMock.mockResolvedValueOnce(redirectedAsset);
    const assetEvent: FetchEvent = {
      request: {
        method: "GET",
        mode: "cors",
        url: "https://hanji.example/assets/app-hash.js",
      },
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    fetchListener(assetEvent);
    const assetResponse = assetEvent.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await expect(assetResponse).resolves.toMatchObject({ type: "error" });
    expect(shellCache.put).not.toHaveBeenCalled();

    const htmlFallback = new Response("<html>SPA fallback</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(htmlFallback, "url", {
      value: "https://hanji.example/assets/missing-hash.js",
    });
    fetchMock.mockResolvedValueOnce(htmlFallback);
    const missingAssetEvent: FetchEvent = {
      request: {
        method: "GET",
        mode: "cors",
        url: "https://hanji.example/assets/missing-hash.js",
      },
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    fetchListener(missingAssetEvent);
    const missingAssetResponse = missingAssetEvent.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await expect(missingAssetResponse).resolves.toMatchObject({ type: "error" });
    expect(shellCache.put).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async (input: { url?: string } | string) => {
      const url = typeof input === "string" ? input : input.url ?? "";
      if (url.endsWith("/sw-precache.json")) throw new TypeError("offline");
      return new Response("new online shell", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const newShellEvent: FetchEvent = {
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://hanji.example/p/page-new-release",
      },
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    fetchListener(newShellEvent);
    await newShellEvent.respondWith.mock.calls[0]?.[0];
    await newShellEvent.waitUntil.mock.calls[0]?.[0];
    expect(shellCache.put).not.toHaveBeenCalled();
  });

  it("preserves a valid cached asset when its background refresh is an HTML SPA fallback", async () => {
    type FetchEvent = {
      request: { method: string; mode: string; url: string };
      respondWith: ReturnType<typeof vi.fn>;
      waitUntil: ReturnType<typeof vi.fn>;
    };
    const listeners = new Map<string, (event: FetchEvent) => void>();
    const cachedScript = new Response("console.log('cached');", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
    const shellCache = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      match: vi.fn(async (input: { url?: string } | string) => {
        const url = typeof input === "string" ? input : input.url ?? "";
        return url.endsWith("/assets/app-hash.js") ? cachedScript.clone() : undefined;
      }),
      put: vi.fn(async () => undefined),
    };
    const self = {
      addEventListener: (type: string, listener: (event: FetchEvent) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    const caches = {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      open: vi.fn(async () => shellCache),
    };
    const htmlFallback = new Response("<html>SPA fallback</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(htmlFallback, "url", {
      value: "https://hanji.example/assets/app-hash.js",
    });
    const fetchMock = vi.fn(async () => htmlFallback.clone());

    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      Request,
      Response,
      URL,
      caches,
      fetch: fetchMock,
      self,
    });
    const fetchListener = listeners.get("fetch");
    if (!fetchListener) throw new Error("fetch listener was not registered");
    const event: FetchEvent = {
      request: {
        method: "GET",
        mode: "cors",
        url: "https://hanji.example/assets/app-hash.js",
      },
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    fetchListener(event);

    const response = await event.respondWith.mock.calls[0]?.[0] as Response;
    await expect(response.text()).resolves.toBe("console.log('cached');");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(shellCache.put).not.toHaveBeenCalled();
  });

  it("keeps the previous shell and marker when navigation-triggered precaching fails", async () => {
    type FetchEvent = {
      request: { method: string; mode: string; url: string };
      respondWith: ReturnType<typeof vi.fn>;
      waitUntil: ReturnType<typeof vi.fn>;
    };
    const listeners = new Map<string, (event: FetchEvent) => void>();
    const active = new Map<string, Response>([
      ["/__hanji_shell__", new Response("old shell", { headers: { "content-type": "text/html" } })],
      [
        "/__hanji_precache__",
        new Response(JSON.stringify({ version: "old", assets: ["/"], complete: true }), {
          headers: { "content-type": "application/json" },
        }),
      ],
    ]);
    const stores = new Map<string, Map<string, Response>>([["hanji-sw-v2", active]]);
    const cacheFor = (name: string) => {
      let entries = stores.get(name);
      if (!entries) {
        entries = new Map();
        stores.set(name, entries);
      }
      return {
        delete: async (input: string | Request) =>
          entries!.delete(typeof input === "string" ? input : new URL(input.url).pathname),
        keys: async () => [...entries!.keys()].map((path) => new Request(`https://hanji.example${path}`)),
        match: async (input: string | Request) =>
          entries!.get(typeof input === "string" ? input : new URL(input.url).pathname)?.clone(),
        put: async (input: string | Request, response: Response) => {
          entries!.set(
            typeof input === "string" ? input : new URL(input.url).pathname,
            response.clone(),
          );
        },
      };
    };
    const caches = {
      delete: vi.fn(async (name: string) => stores.delete(name)),
      keys: vi.fn(async () => [...stores.keys()]),
      open: vi.fn(async (name: string) => cacheFor(name)),
    };
    const fetchMock = vi.fn(async (input: { url?: string } | string) => {
      const url = typeof input === "string" ? input : input.url ?? "";
      if (url.endsWith("/sw-precache.json")) {
        return new Response(
          JSON.stringify({ version: "new", assets: ["/", "/assets/app.js"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/assets/app.js")) {
        return new Response("<html>fallback</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("new online shell", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const self = {
      addEventListener: (type: string, listener: (event: FetchEvent) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: "https://hanji.example" },
      skipWaiting: vi.fn(),
    };
    runInNewContext(readFileSync(resolve(webRoot, "public/sw.js"), "utf8"), {
      Request,
      Response,
      URL,
      caches,
      fetch: fetchMock,
      self,
    });
    const fetchListener = listeners.get("fetch");
    if (!fetchListener) throw new Error("fetch listener was not registered");
    const event: FetchEvent = {
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://hanji.example/p/page-new-release",
      },
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    fetchListener(event);

    const response = await event.respondWith.mock.calls[0]?.[0] as Response;
    await expect(response.text()).resolves.toBe("new online shell");
    await event.waitUntil.mock.calls[0]?.[0];
    await expect(active.get("/__hanji_shell__")?.text()).resolves.toBe("old shell");
    await expect(active.get("/__hanji_precache__")?.json()).resolves.toMatchObject({
      version: "old",
      complete: true,
    });
    expect(stores.has("hanji-sw-stage-new")).toBe(false);
  });
});
