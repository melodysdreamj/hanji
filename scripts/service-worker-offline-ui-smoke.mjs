#!/usr/bin/env node
// Focused service-worker regression guard. A single fresh online navigation
// must register/activate the small boot graph and trigger the non-blocking
// complete-graph warm. After that atomic marker appears, a browser HTTP-cache
// clear plus total network loss must still boot the product from CacheStorage.

import {
  DEFAULT_BASE_URL,
  assert,
  loadPlaywright,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
} from './lib/harness.mjs';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL service-worker offline UI smoke: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const response = await fetch(resolveUrl(appUrl, '/'));
  assert(response.ok, `app shell must be reachable before the smoke (${response.status})`);

  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const context = await browser.newContext();
    const online = await context.newPage();
    let documentNavigations = 0;
    online.on('request', (request) => {
      if (request.isNavigationRequest() && request.resourceType() === 'document') {
        documentNavigations += 1;
      }
    });
    await online.goto(resolveUrl(appUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });

    const manifest = await online.evaluate(async () => {
      const result = await fetch('/sw-precache.json', { cache: 'no-cache' });
      return await result.json();
    });
    assert(Array.isArray(manifest.bootAssets), 'precache manifest must expose bootAssets');
    assert(Array.isArray(manifest.assets), 'precache manifest must expose the complete assets graph');
    assert(
      manifest.bootAssets.length < manifest.assets.length,
      'install graph must remain smaller than the complete offline graph',
    );

    const ready = await pollUntil(
      () => online.evaluate(async () => {
        const registration = await navigator.serviceWorker?.getRegistration();
        if (!registration?.active) {
          return {
            state: 'waiting-for-active',
            installing: registration?.installing?.state ?? null,
            waiting: registration?.waiting?.state ?? null,
          };
        }
        const marker = await caches.match('/__hanji_precache__');
        if (!marker) {
          const bootMarker = await caches.match('/__hanji_boot__');
          return {
            state: 'waiting-for-full-marker',
            cacheNames: await caches.keys(),
            bootMarker: bootMarker ? await bootMarker.json() : null,
          };
        }
        const value = await marker.json();
        if (value.complete !== true || !Array.isArray(value.assets)) {
          return { state: 'incomplete-full-marker', marker: value };
        }
        const cached = await Promise.all(
          value.assets.map((path) => caches.match(path === '/' ? '/__hanji_shell__' : path)),
        );
        const cachedCount = cached.filter(Boolean).length;
        return {
          state: cachedCount === value.assets.length ? 'ready' : 'waiting-for-assets',
          version: value.version,
          assetCount: value.assets.length,
          cachedCount,
        };
      }),
      (value) => value?.state === 'ready' && value.assetCount === manifest.assets.length,
      'the active worker to background-warm and atomically publish the complete graph',
    );
    assert(documentNavigations === 1, 'background warm must not require a second navigation');

    const cdp = await context.newCDPSession(online);
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
    await online.close();
    await context.setOffline(true);

    const offline = await context.newPage();
    await offline.goto(resolveUrl(appUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await offline.locator('#root > *').first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    const cachedTheme = await offline.evaluate(async () => {
      const result = await fetch('/theme-init.js');
      return { ok: result.ok, text: await result.text() };
    });
    assert(
      cachedTheme.ok && cachedTheme.text.includes('hanji:theme'),
      'offline boot must serve the CSP-safe theme initializer from CacheStorage',
    );
    const offlineMarker = await offline.evaluate(async () => {
      const marker = await caches.match('/__hanji_precache__');
      return marker ? await marker.json() : null;
    });
    assert(
      offlineMarker?.complete === true && offlineMarker.version === ready.version,
      'offline reload must use the same complete atomic release marker',
    );
    await context.close();

    console.log(
      `PASS service-worker first visit: install ${manifest.bootAssets.length} assets; ` +
        `background warm ${manifest.assets.length - manifest.bootAssets.length}; ` +
        `offline reload ${ready.assetCount} cached assets.`,
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

async function pollUntil(read, accept, label) {
  const deadline = Date.now() + options.timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

function parseArgs(args) {
  const parsed = {
    headed: false,
    timeoutMs: 60_000,
    url: process.env.HANJI_EDGEBASE_URL ?? DEFAULT_BASE_URL,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--headed') parsed.headed = true;
    else if (arg === '--url') parsed.url = args[++index] ?? parsed.url;
    else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(args[++index] ?? parsed.timeoutMs) || parsed.timeoutMs;
    }
  }
  return parsed;
}
