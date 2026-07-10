// Notionlike offline service worker (local-first roadmap §10 follow-up #1).
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
// Offline coverage is "second visit": assets fetched before this worker
// controls the page aren't cached, so the first controlled reload populates
// the cache — matching the record cache's recently-visited semantics.

const CACHE = "notionlike-sw-v1";
const SHELL_KEY = "/__notionlike_shell__";
const PRECACHE_MANIFEST_KEY = "/__notionlike_precache__";
// Upper bound on runtime-cached hashed assets. Content-hashed files are
// immutable, so previous releases' lazy chunks are harmless (and necessary for
// offline-pinned pages after a deploy) — we keep them and only evict the oldest
// once the cache grows past this cap.
const MAX_RUNTIME_ASSETS = 500;

self.addEventListener("install", (event) => {
  // Precache the shell + entry assets listed by the build (sw-precache.json)
  // so the FIRST visit is offline-reloadable. Best-effort: a failed precache
  // never blocks installation — runtime caching still covers second visits.
  event.waitUntil(precache().catch(() => undefined));
  self.skipWaiting();
});

async function precache() {
  const response = await fetch("/sw-precache.json", { cache: "no-cache" });
  if (!response.ok) return;
  const manifest = await response.json();
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const cache = await caches.open(CACHE);
  await cache.put(PRECACHE_MANIFEST_KEY, new Response(JSON.stringify(manifest)));
  await Promise.all(
    assets.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) return;
        if (url === "/") await cache.put(SHELL_KEY, res);
        else await cache.put(url, res);
      } catch {
        // Per-asset best-effort.
      }
    })
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      // Do NOT purge hashed /assets/* by the new release's keep-set. Hashed
      // filenames are content-addressed (immutable), so a previous release's
      // runtime-cached lazy chunks are harmless to keep — and an offline-pinned
      // page opened after a deploy still needs the exact chunk it loaded with.
      // The old keep-set purge deleted those chunks on activate and broke such
      // pages offline. We only evict to bound growth: keep every current-release
      // asset, then drop the OLDEST stale assets beyond MAX_RUNTIME_ASSETS
      // (cache.keys() preserves insertion order, so stale-oldest-first).
      const cache = await caches.open(CACHE);
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
      const assetRequests = (await cache.keys()).filter((request) =>
        new URL(request.url).pathname.startsWith("/assets/")
      );
      const overflow = assetRequests.length - MAX_RUNTIME_ASSETS;
      if (overflow > 0) {
        const evictable = assetRequests.filter(
          (request) => !keep.has(new URL(request.url).pathname)
        );
        for (const request of evictable.slice(0, overflow)) await cache.delete(request);
      }
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
    event.respondWith(navigationNetworkFirst(request));
    return;
  }
  // Cache-first is restricted to content-hashed build output (plus the
  // favicon). Everything else — /api/**, /index.html freshness probes,
  // /sw.js updates — passes straight through to the network so an online
  // client can never observe a stale response through this worker.
  if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico") {
    event.respondWith(assetCacheFirst(request));
  }
});

async function navigationNetworkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(SHELL_KEY, response.clone());
    return response;
  } catch (error) {
    const shell = await cache.match(SHELL_KEY);
    if (shell) return shell;
    throw error;
  }
}

async function assetCacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const fresh = await refresh;
  if (fresh) return fresh;
  return Response.error();
}
