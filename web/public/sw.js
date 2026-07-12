// Hanji offline service worker (local-first roadmap §10 follow-up #1).
//
// Strategy — deliberately conservative so it can NEVER serve a stale app to an
// online client (the repo's bundle-freshness checks stay authoritative):
// - /api/** is never intercepted: data, auth, uploads always hit the network.
// - Navigations are network-first; the last successful app shell is kept as
//   the offline fallback (SPA: every route serves the same shell).
// - Same-origin GET assets are cache-first with a background refresh. Built
//   assets are content-hashed, so cache-first is safe; non-hashed statics
//   converge on the next online load.
//
// The build-generated precache includes the app shell, entry graph, and boot
// locale chunks. A first successful online visit is therefore reloadable
// offline as soon as the worker finishes installation.

const CACHE_PREFIX = "hanji-sw-";
// Compatibility only: validate and hand off pre-Hanji immutable assets. If
// canonical storage fails, retain them as a fallback; otherwise delete the old
// cache.
const LEGACY_CACHE_PREFIX = "notionlike-sw-";
const CACHE = `${CACHE_PREFIX}v2`;
const SHELL_KEY = "/__hanji_shell__";
const PRECACHE_MANIFEST_KEY = "/__hanji_precache__";
// Upper bound on runtime-cached hashed assets. Content-hashed files are
// immutable, so previous releases' lazy chunks are harmless (and necessary for
// offline-pinned pages after a deploy) — we keep them and only evict the oldest
// once the cache grows past this cap.
const MAX_RUNTIME_ASSETS = 500;

self.addEventListener("install", (event) => {
  // Do not activate an incompletely installed worker: an offline-ready marker
  // is written only after every generated dependency is present.
  event.waitUntil(ensurePrecache().then(() => self.skipWaiting()));
});

let precacheInFlight;

function ensurePrecache() {
  if (!precacheInFlight) {
    precacheInFlight = precache().finally(() => {
      precacheInFlight = undefined;
    });
  }
  return precacheInFlight;
}

async function precache() {
  const response = await fetch("/sw-precache.json", { cache: "no-cache" });
  if (
    !response.ok
    || !sameOriginResponsePath(response, "/sw-precache.json")
    || !contentType(response).includes("application/json")
  ) {
    throw new Error("Offline manifest is unavailable.");
  }
  const manifest = await response.json();
  const assets = Array.isArray(manifest.assets)
    ? manifest.assets.filter(
        (url) =>
          typeof url === "string" &&
          url.startsWith("/") &&
          !url.startsWith("//") &&
          !url.startsWith("/api/")
      )
    : [];
  if (!manifest.version || assets.length === 0) {
    throw new Error("Offline manifest is invalid.");
  }
  const cache = await caches.open(CACHE);
  const installed = await cache.match(PRECACHE_MANIFEST_KEY);
  if (installed) {
    try {
      const current = await installed.json();
      if (current.complete === true && current.version === manifest.version) return;
    } catch {
      // Replace an unreadable/incomplete marker below.
    }
  }

  // Build the new release in an isolated cache. The active shell is replaced
  // only after every fetch succeeds and every dependency has copied over, so
  // a transient failure cannot pair a new shell with a partial module graph.
  const stagingName = `${CACHE_PREFIX}stage-${manifest.version}`;
  const rollbackName = `${CACHE_PREFIX}rollback-${manifest.version}`;
  await caches.delete(stagingName);
  await caches.delete(rollbackName);
  const staging = await caches.open(stagingName);
  try {
    for (let offset = 0; offset < assets.length; offset += 16) {
      await Promise.all(
        assets.slice(offset, offset + 16).map(async (url) => {
          const res = await fetch(url, { cache: "no-cache" });
          if (!res.ok || !isExpectedPrecacheResponse(url, res)) {
            throw new Error(`Offline asset failed: ${url}`);
          }
          await staging.put(url, res);
        })
      );
    }
    const shell = await staging.match("/");
    if (!shell) throw new Error("Offline staging shell disappeared.");

    // Content-hashed assets are immutable. Add missing entries first; a
    // partial failure here cannot affect the old shell graph because the old
    // shell never references the new filenames. Existing hashes are never
    // overwritten.
    const newlyAddedImmutable = [];
    try {
      for (const url of assets) {
        if (url === "/" || !isImmutableBuildAssetPath(url)) continue;
        if (await cache.match(url)) continue;
        const staged = await staging.match(url);
        if (!staged) throw new Error(`Offline staging asset disappeared: ${url}`);
        await cache.put(url, staged);
        newlyAddedImmutable.push(url);
      }
    } catch (error) {
      for (const url of newlyAddedImmutable) await cache.delete(url).catch(() => undefined);
      throw error;
    }

    // Mutable root dependencies, the shell alias, and the completion marker
    // form one release graph. CacheStorage has no transaction primitive, so
    // snapshot only this small mutable set into an isolated rollback cache.
    // If any active put fails (for example quota exhaustion), delete the
    // partial commit and restore the old dependencies before restoring the old
    // shell/marker. A failed rollback leaves no shell marker rather than a
    // cross-release graph.
    const mutableAssetKeys = assets.filter(
      (url) => url !== "/" && !isImmutableBuildAssetPath(url)
    );
    const mutableCommitKeys = [...mutableAssetKeys, SHELL_KEY, PRECACHE_MANIFEST_KEY];
    const rollback = await caches.open(rollbackName);
    for (const key of mutableCommitKeys) {
      const previous = await cache.match(key);
      if (previous) await rollback.put(key, previous);
    }

    try {
      for (const url of mutableAssetKeys) {
        const staged = await staging.match(url);
        if (!staged) throw new Error(`Offline staging asset disappeared: ${url}`);
        await cache.put(url, staged);
      }
      await cache.put(SHELL_KEY, shell);
      await cache.put(
        PRECACHE_MANIFEST_KEY,
        new Response(JSON.stringify({ ...manifest, complete: true }), {
          headers: { "content-type": "application/json" },
        })
      );
    } catch (commitError) {
      for (const key of mutableCommitKeys) await cache.delete(key).catch(() => undefined);
      try {
        // Restore dependencies first, then publish the old shell and marker.
        for (const key of mutableAssetKeys) {
          const previous = await rollback.match(key);
          if (previous) await cache.put(key, previous);
        }
        const previousShell = await rollback.match(SHELL_KEY);
        if (previousShell) await cache.put(SHELL_KEY, previousShell);
        const previousMarker = await rollback.match(PRECACHE_MANIFEST_KEY);
        if (previousMarker) await cache.put(PRECACHE_MANIFEST_KEY, previousMarker);
      } catch (rollbackError) {
        await cache.delete(SHELL_KEY).catch(() => undefined);
        await cache.delete(PRECACHE_MANIFEST_KEY).catch(() => undefined);
        for (const url of newlyAddedImmutable) await cache.delete(url).catch(() => undefined);
        throw new AggregateError(
          [commitError, rollbackError],
          "Offline release commit and rollback both failed."
        );
      }
      for (const url of newlyAddedImmutable) await cache.delete(url).catch(() => undefined);
      throw commitError;
    }

    // Growth trimming is not part of the release switch. A failed eviction is
    // safe to retry later and must not roll back an already coherent graph.
    await trimRuntimeAssets(cache, new Set(assets)).catch(() => undefined);
  } finally {
    await caches.delete(stagingName);
    await caches.delete(rollbackName);
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const key of await caches.keys()) {
        // CacheStorage is shared with product-data caches such as offline
        // attachments. This worker owns only its app-shell namespace, so an
        // activate must never purge caches created by another subsystem.
        if (key.startsWith(LEGACY_CACHE_PREFIX)) {
          await handoffLegacyCache(key, cache);
        } else if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
      }
      // Do NOT purge hashed /assets/* by the new release's keep-set. Hashed
      // filenames are content-addressed (immutable), so a previous release's
      // runtime-cached lazy chunks are harmless to keep — and an offline-pinned
      // page opened after a deploy still needs the exact chunk it loaded with.
      // The old keep-set purge deleted those chunks on activate and broke such
      // pages offline. We only evict to bound growth: keep every current-release
      // asset, then drop the OLDEST stale assets beyond MAX_RUNTIME_ASSETS
      // (cache.keys() preserves insertion order, so stale-oldest-first).
      const manifestResponse = await cache.match(PRECACHE_MANIFEST_KEY);
      let keep = new Set();
      if (manifestResponse) {
        try {
          const manifest = await manifestResponse.json();
          keep = new Set(Array.isArray(manifest.assets) ? manifest.assets : []);
        } catch {
          // Unreadable manifest: keep everything (evict nothing this cycle).
        }
      }
      await trimRuntimeAssets(cache, keep);
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // Never turn API/download/admin/unknown navigations into an app shell or
    // cache their JSON/file/private response under the shared shell key.
    if (!isAppNavigationPath(url.pathname)) return;
    event.respondWith(navigationNetworkFirst(request));
    // sw.js itself may be byte-identical between application builds. Refresh
    // the versioned manifest on online navigations so new hashed chunks still
    // become offline-ready without relying on a worker reinstall.
    event.waitUntil(ensurePrecache().catch(() => undefined));
    return;
  }
  // Cache-first is restricted to content-hashed build output (plus the
  // favicon). Everything else — /api/**, /index.html freshness probes,
  // /sw.js updates — passes straight through to the network so an online
  // client can never observe a stale response through this worker.
  if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico") {
    event.respondWith(assetCacheFirst(request));
    return;
  }
  // Root-level shell dependencies (for example /theme-init.js) are emitted
  // into sw-precache.json by the build. They are not content-hashed, so keep
  // online requests network-first while falling back to the install cache
  // offline. Membership in the generated manifest is the allowlist: /api/**,
  // /index.html freshness probes, /sw.js, and arbitrary paths still go
  // straight to the network.
  if (!url.pathname.startsWith("/api/")) {
    event.respondWith(precachedShellAssetNetworkFirst(request));
  }
});

function isAppNavigationPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/account" ||
    pathname === "/settings" ||
    pathname === "/trash" ||
    /^\/(?:p|database|workspace|share)\/[^/]+/.test(pathname)
  );
}

async function trimRuntimeAssets(cache, keep) {
  const assetRequests = (await cache.keys()).filter((request) =>
    new URL(request.url).pathname.startsWith("/assets/")
  );
  const overflow = assetRequests.length - MAX_RUNTIME_ASSETS;
  if (overflow <= 0) return;
  const evictable = assetRequests.filter(
    (request) => !keep.has(new URL(request.url).pathname)
  );
  for (const request of evictable.slice(0, overflow)) await cache.delete(request);
}

const HASH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const HEX_HASH_TOKEN_PATTERN = /^[A-Fa-f0-9]+$/;

function isLikelyContentHashToken(token) {
  if (!HASH_TOKEN_PATTERN.test(token)) return false;

  const hasLetter = /[A-Za-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  if (HEX_HASH_TOKEN_PATTERN.test(token)) return hasLetter && hasDigit;

  return /[A-Z]/.test(token) && /[a-z]/.test(token) && hasDigit;
}

function hasLikelyContentHash(assetName) {
  const extensionIndex = assetName.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === assetName.length - 1) return false;
  const stem = assetName.slice(0, extensionIndex);

  // False negatives only lose an optimization. False positives could import
  // mutable metadata from the legacy namespace as an immutable build asset.
  for (let index = stem.length - 1; index >= 0; index -= 1) {
    if (stem[index] !== "-" && stem[index] !== "_" && stem[index] !== ".") continue;
    const token = stem.slice(index + 1);
    if (token.length >= 8 && isLikelyContentHashToken(token)) return true;
  }
  return false;
}

function isImmutableBuildAssetPath(pathname) {
  if (!pathname.startsWith("/assets/")) return false;
  const assetName = pathname.split("/").pop() || "";
  return hasLikelyContentHash(assetName);
}

function isSafeLegacyAsset(request, response) {
  if (!request || request.method !== "GET" || !response?.ok) return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  return (
    url.origin === self.location.origin &&
    isImmutableBuildAssetPath(url.pathname) &&
    isExpectedPrecacheResponse(url.pathname, response)
  );
}

async function handoffLegacyCache(cacheName, target) {
  const legacy = await caches.open(cacheName);
  let copiedEverySafeAsset = true;
  for (const request of await legacy.keys()) {
    const response = await legacy.match(request);
    if (!response || !isSafeLegacyAsset(request, response)) continue;
    try {
      // The active Hanji cache was populated through the current worker's
      // response validation. Never let an older namespace overwrite it.
      if (!(await target.match(request))) await target.put(request, response.clone());
    } catch {
      copiedEverySafeAsset = false;
      break;
    }
  }
  // Delete only after every eligible immutable asset was handed off. If quota
  // or storage fails, keep the old cache as a validated rolling-upgrade source.
  if (copiedEverySafeAsset) await caches.delete(cacheName);
}

async function legacyAssetFallback(request, target) {
  const pathname = new URL(request.url).pathname;
  if (!isImmutableBuildAssetPath(pathname)) return undefined;
  for (const cacheName of await caches.keys()) {
    if (!cacheName.startsWith(LEGACY_CACHE_PREFIX)) continue;
    const legacy = await caches.open(cacheName);
    const response = await legacy.match(request);
    if (!response || !isSafeLegacyAsset(request, response)) continue;
    try {
      await target.put(request, response.clone());
    } catch {
      // Returning the verified old response still keeps the open tab alive;
      // the retained cache can be retried on the next activation/request.
    }
    return response;
  }
  return undefined;
}

async function navigationNetworkFirst(request) {
  try {
    // Return the live navigation immediately, but never promote it directly to
    // the offline shell. ensurePrecache() stages the matching shell and complete
    // dependency graph, then swaps the active marker atomically. This prevents
    // a failed deploy fetch from pairing a new HTML shell with old chunks.
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(CACHE);
    const shell = await cache.match(SHELL_KEY);
    if (shell) return shell;
    throw error;
  }
}

async function assetCacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const requestedPath = new URL(request.url).pathname;
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        if (!isExpectedPrecacheResponse(requestedPath, response)) return Response.error();
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const legacy = await legacyAssetFallback(request, cache);
  if (legacy) return legacy;
  const fresh = await refresh;
  if (fresh) return fresh;
  return Response.error();
}

async function precachedShellAssetNetworkFirst(request) {
  const cache = await caches.open(CACHE);
  const manifestResponse = await cache.match(PRECACHE_MANIFEST_KEY);
  let precached = false;
  if (manifestResponse) {
    try {
      const manifest = await manifestResponse.json();
      const pathname = new URL(request.url).pathname;
      precached =
        pathname !== "/" &&
        Array.isArray(manifest.assets) &&
        manifest.assets.includes(pathname);
    } catch {
      // An unreadable manifest is not permission to serve an arbitrary cache
      // entry. Fall through to a plain network request.
    }
  }
  if (!precached) return fetch(request);

  try {
    const response = await fetch(request);
    if (response.ok) {
      if (!isExpectedPrecacheResponse(new URL(request.url).pathname, response)) {
        return Response.error();
      }
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

function sameOriginResponsePath(response, expectedPath) {
  // A real fetch response has a final URL. Empty URLs exist only on synthetic
  // Response objects (including unit-test doubles), where the caller's fixed
  // same-origin request remains the only authority available.
  if (!response.url) return true;
  try {
    const finalUrl = new URL(response.url);
    return finalUrl.origin === self.location.origin && finalUrl.pathname === expectedPath;
  } catch {
    return false;
  }
}

function contentType(response) {
  return (response.headers.get("content-type") || "").toLowerCase();
}

function isExpectedPrecacheResponse(pathname, response) {
  if (!sameOriginResponsePath(response, pathname)) return false;
  const type = contentType(response);
  if (pathname === "/") return type.includes("text/html");
  if (/\.(?:m?js)$/i.test(pathname)) {
    return type.includes("javascript") || type.includes("ecmascript");
  }
  if (/\.css$/i.test(pathname)) return type.includes("text/css");
  if (/\.wasm$/i.test(pathname)) return type.includes("application/wasm");
  if (/\.(?:woff2?|ttf|otf)$/i.test(pathname)) {
    return type.startsWith("font/")
      || type.includes("application/font")
      || type.includes("application/octet-stream");
  }
  if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i.test(pathname)) {
    return type.startsWith("image/");
  }
  // Unknown generated assets must at least not be an SPA/error HTML fallback.
  return Boolean(type) && !type.includes("text/html");
}
