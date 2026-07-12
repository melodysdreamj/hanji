#!/usr/bin/env node
// Local-first smoke (docs/local-first-roadmap.md):
//  A. Phase 0 — an edit typed while OFFLINE survives closing the tab before any
//     flush and replays to the server from a fresh tab (real Chrome IndexedDB
//     + Web Locks claim).
//  B. Phase 2 — going offline in-session shows the sync badge, and coming back
//     online flushes the queued edit WITHOUT a reload; the badge drains.
//  C. Phase 1/2 — with the API unreachable (offline boot: assets served, /api
//     aborted), a previously visited page renders from the record cache, takes
//     an edit into the outbox, and replays once the API returns.
//
// Browser console errors are deliberately not asserted — the offline phases
// necessarily produce failed-fetch noise.

import { randomUUID } from 'node:crypto';

import {
  permanentlyDeletePage,
  DEFAULT_BASE_URL,
  assert,
  assertRuntimeReachable,
  callFunction,
  captureBrowserSession,
  installBrowserSession,
  loadPlaywright,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  signIn,
} from './lib/harness.mjs';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL durable outbox smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Durable outbox smoke target: ${appUrl}`);

  await assertRuntimeReachable(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  const seeds = [];
  try {
    const seedA = await seedPage(apiUrl);
    seeds.push(seedA);
    await assertOfflineEditSurvivesTabClose(browser, appUrl, apiUrl, seedA);
    console.log('PASS A: offline edit survived tab close and replayed from a fresh tab.');

    const seedB = await seedPage(apiUrl);
    seeds.push(seedB);
    await assertReconnectFlushesWithoutReload(browser, appUrl, apiUrl, seedB);
    console.log('PASS B: reconnect flushed the queued edit in place and the sync badge drained.');

    const seedC = await seedPage(apiUrl);
    seeds.push(seedC);
    await assertOfflineBootServesCacheAndReplays(browser, appUrl, apiUrl, seedC);
    console.log('PASS C: offline boot rendered from the record cache and the edit replayed once online.');

    const seedD = await seedPage(apiUrl);
    seeds.push(seedD);
    await assertServiceWorkerOfflineReload(browser, appUrl, apiUrl, seedD);
    console.log('PASS D: fully offline reload served by the service worker + record cache, then replayed.');

    const seedE = await seedPage(apiUrl);
    seeds.push(seedE);
    await assertPassphraseCustodyGate(browser, appUrl, seedE);
    console.log('PASS E: passphrase custody — unlock gates offline data; wrong pass refused; skip stays network-only.');

    console.log('\nPASS durable outbox + record cache local-first flows.');
  } finally {
    await browser.close().catch(() => {});
    for (const seed of seeds) await cleanupSeed(apiUrl, seed);
  }
}

// ── phase A: crash-safe outbox ──────────────────────────────────────────────

async function assertOfflineEditSurvivesTabClose(browser, appUrl, apiUrl, seed) {
  const context = await newSeededContext(browser, seed);
  const first = await context.newPage();
  await openSeededPage(first, appUrl, seed);
  await context.setOffline(true);
  await typeIntoSeedBlock(first, seed, ` ${seed.marks.crash}`);

  const mirrored = await pollUntil(
    () => countOutboxEntries(first, seed.outboxDbName),
    (count) => count > 0,
    'durable outbox entry for the offline edit'
  );
  console.log(`  offline edit mirrored durably (${mirrored} entries)`);

  await first.close();
  await context.setOffline(false);

  const second = await context.newPage();
  await openSeededPage(second, appUrl, seed);
  await pollServerBlockText(apiUrl, seed, (text) => text.includes(seed.marks.crash));
  await pollUntil(
    () => countOutboxEntries(second, seed.outboxDbName),
    (count) => count === 0,
    'outbox to drain after successful replay'
  );
  await context.close();
}

// ── phase B: reconnect flush + sync badge ───────────────────────────────────

async function assertReconnectFlushesWithoutReload(browser, appUrl, apiUrl, seed) {
  const context = await newSeededContext(browser, seed);
  const page = await context.newPage();
  await openSeededPage(page, appUrl, seed);

  await context.setOffline(true);
  await typeIntoSeedBlock(page, seed, ` ${seed.marks.reconnect}`);

  const badge = page.getByTestId('sync-status-badge');
  await badge.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const badgeText = (await badge.textContent()) ?? '';
  assert(badgeText.includes('Offline'), `sync badge must show offline state (got "${badgeText}")`);

  await context.setOffline(false);
  // No reload: the 'online' handler + retry timers must push the edit out.
  await pollServerBlockText(apiUrl, seed, (text) => text.includes(seed.marks.reconnect));
  await pollUntil(
    () => countOutboxEntries(page, seed.outboxDbName),
    (count) => count === 0,
    'outbox to drain after reconnect'
  );
  await badge.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await context.close();
}

// ── phase C: offline boot from the record cache ─────────────────────────────

async function assertOfflineBootServesCacheAndReplays(browser, appUrl, apiUrl, seed) {
  const context = await newSeededContext(browser, seed);

  // Warm the record cache (bootstrap payload + page blocks write-through).
  const warm = await context.newPage();
  await openSeededPage(warm, appUrl, seed);
  await pollUntil(
    () => countCachedBlocks(warm, seed.recordsDbName, `blocks:${seed.pageId}`),
    (count) => count > 0,
    'record cache to contain the visited page blocks'
  );
  await warm.close();

  // Offline boot: assets still served, every API call aborted.
  await context.route('**/api/**', (route) => route.abort());
  const offline = await context.newPage();
  await offline.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const cachedBlock = offline
    .locator(`[data-block-id="${seed.blockId}"]`)
    .getByRole('textbox');
  await cachedBlock.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const cachedText = (await cachedBlock.textContent()) ?? '';
  assert(
    cachedText.includes(seed.seedText),
    `offline boot must render cached block text (got "${cachedText}")`
  );

  await typeIntoSeedBlock(offline, seed, ` ${seed.marks.offlineBoot}`);
  await pollUntil(
    () => countOutboxEntries(offline, seed.outboxDbName),
    (count) => count > 0,
    'outbox entry for the offline-boot edit'
  );
  await offline.close();

  await context.unroute('**/api/**');
  const online = await context.newPage();
  await openSeededPage(online, appUrl, seed);
  await pollServerBlockText(apiUrl, seed, (text) => text.includes(seed.marks.offlineBoot));
  await context.close();
}

// ── phase D: service-worker offline reload (network fully off) ─────────────

async function assertServiceWorkerOfflineReload(browser, appUrl, apiUrl, seed) {
  const context = await newSeededContext(browser, seed);

  // First visit registers the worker, which precaches the shell + entry
  // assets from sw-precache.json — no warm reload needed for offline
  // readiness (the record cache fills from this same visit).
  const warm = await context.newPage();
  await openSeededPage(warm, appUrl, seed);
  await pollUntil(
    () =>
      warm.evaluate(async () => {
        const registration = await navigator.serviceWorker?.getRegistration();
        if (!registration?.active) return false;
        const marker = await caches.match('/__hanji_precache__');
        if (!marker) return false;
        const manifest = await marker.json();
        if (manifest.complete !== true || typeof manifest.version !== 'string') return false;
        const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
        const required = [
          '/theme-init.js',
          assets.find((path) => /\/PageView-[^/]+\.js$/.test(path)),
          assets.find((path) => /\/Editor-[^/]+\.js$/.test(path)),
        ].filter(Boolean);
        if (required.length !== 3) return false;
        return (await Promise.all(required.map((path) => caches.match(path)))).every(Boolean);
      }),
    (ready) => ready === true,
    'service worker to activate and precache the shell'
  );
  const cdp = await context.newCDPSession(warm);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
  await warm.close();

  // Network fully off: navigation + assets must come from the worker cache,
  // records from the record cache.
  await context.setOffline(true);
  const offline = await context.newPage();
  await offline.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const cachedThemeInitializer = await offline.evaluate(async () => {
    const response = await fetch('/theme-init.js');
    return {
      ok: response.ok,
      text: await response.text(),
    };
  });
  assert(
    cachedThemeInitializer.ok &&
      cachedThemeInitializer.text.includes('hanji:theme'),
    'fully offline reload must serve the CSP-safe theme initializer from the precache'
  );
  const cachedBlock = offline
    .locator(`[data-block-id="${seed.blockId}"]`)
    .getByRole('textbox');
  await cachedBlock.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const cachedText = (await cachedBlock.textContent()) ?? '';
  assert(
    cachedText.includes(seed.seedText),
    `offline reload must render cached block text (got "${cachedText}")`
  );
  await typeIntoSeedBlock(offline, seed, ` ${seed.marks.swReload}`);
  await pollUntil(
    () => countOutboxEntries(offline, seed.outboxDbName),
    (count) => count > 0,
    'outbox entry for the offline-reload edit'
  );
  await offline.close();

  await context.setOffline(false);
  const online = await context.newPage();
  await openSeededPage(online, appUrl, seed);
  await pollServerBlockText(apiUrl, seed, (text) => text.includes(seed.marks.swReload));
  await context.close();
}

// ── phase E: passphrase key custody ─────────────────────────────────────────

async function assertPassphraseCustodyGate(browser, appUrl, seed) {
  const PASS = 'smoke-pass-1234';
  const lockStorage = {
    'hanji.encryption.mode': 'passphrase',
    'hanji.lastUserId': seed.userId,
  };

  // Session 1 (online): unlock creates the wrapped key; caches fill sealed.
  const context = await newSeededContext(browser, seed, lockStorage);
  const first = await context.newPage();
  await first.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const gate = first.getByTestId('local-lock-gate');
  await gate.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await first.getByTestId('local-lock-passphrase').fill(PASS);
  await first.getByTestId('local-lock-unlock').click();
  await gate.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  // No re-navigation: a fresh document would re-lock the gate. The online
  // boot proceeded behind the dialog; unlock resumes hydration/claims.
  await first.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await first
    .locator(`[data-block-id="${seed.blockId}"]`)
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
  await pollUntil(
    () => countCachedBlocks(first, seed.recordsDbName, `blocks:${seed.pageId}`),
    (count) => count > 0,
    'sealed record cache to fill after unlock'
  );
  await first.close();

  // Session 2 (API dead): wrong pass refused; right pass opens the sealed
  // caches and the offline boot renders through the unlock→retry flow.
  await context.route('**/api/**', (route) => route.abort());
  const second = await context.newPage();
  await second.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const gate2 = second.getByTestId('local-lock-gate');
  await gate2.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await second.getByTestId('local-lock-passphrase').fill('totally-wrong');
  await second.getByTestId('local-lock-unlock').click();
  await second
    .getByTestId('local-lock-error')
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
  await second.getByTestId('local-lock-passphrase').fill(PASS);
  await second.getByTestId('local-lock-unlock').click();
  await gate2.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await second
    .locator(`[data-block-id="${seed.blockId}"]`)
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
  await second.close();

  // Session 3 (API dead, SKIP): custody holds — no unlock, no local data.
  const third = await context.newPage();
  await third.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const gate3 = third.getByTestId('local-lock-gate');
  await gate3.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await third.getByTestId('local-lock-skip').click();
  await gate3.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await pollUntil(
    async () =>
      (await third.locator(`[data-block-id="${seed.blockId}"]`).count()) === 0,
    (still) => still === true,
    'skipped locked session to stay without local content'
  );
  await third.close();
  await context.unroute('**/api/**');
  await context.close();
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function newSeededContext(browser, seed, extraLocalStorage = {}) {
  const context = await browser.newContext();
  // First context bootstraps from the API-issued refresh token; later contexts
  // transplant the rotated HttpOnly cookie (rotation reuse detection forbids
  // replaying the original token across contexts).
  await installBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
    workspaceId: seed.workspaceId,
    localStorage: extraLocalStorage,
  });
  // Capture the FINAL rotated cookie whenever the context dies so the next
  // context continues the same session chain. Offline-only contexts capture
  // nothing and keep the previous hand-off (see captureBrowserSession).
  const originalClose = context.close.bind(context);
  context.close = async (...args) => {
    await captureBrowserSession(context, seed, {
      appOrigin: normalizeBaseUrl(options.url),
      authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
    }).catch(() => {});
    return originalClose(...args);
  };
  return context;
}

async function typeIntoSeedBlock(page, seed, text) {
  const textbox = page
    .locator(`[data-block-id="${seed.blockId}"]`)
    .getByRole('textbox');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 20 });
}

async function pollServerBlockText(apiUrl, seed, accept) {
  await pollUntil(
    async () => {
      const result = await callFunction(apiUrl, seed.accessToken, 'page-query', {
        action: 'blocks',
        pageId: seed.pageId,
      });
      const block = result?.blocks?.find((candidate) => candidate.id === seed.blockId);
      return block?.plainText ?? '';
    },
    accept,
    'server block text to converge'
  );
}

function countOutboxEntries(page, dbName) {
  return page.evaluate(async (name) => {
    const databases = await indexedDB.databases();
    if (!databases.some((db) => db.name === name)) return 0;
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        try {
          const getAll = db.transaction('entries', 'readonly').objectStore('entries').getAll();
          getAll.onsuccess = () => {
            db.close();
            resolve(getAll.result.length);
          };
          getAll.onerror = () => {
            db.close();
            reject(getAll.error);
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  }, dbName);
}

function countCachedBlocks(page, dbName, table) {
  return page.evaluate(async ({ name, tableName }) => {
    const databases = await indexedDB.databases();
    if (!databases.some((db) => db.name === name)) return 0;
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        try {
          const getAll = db
            .transaction('records', 'readonly')
            .objectStore('records')
            .index('byTable')
            .getAll(tableName);
          getAll.onsuccess = () => {
            db.close();
            resolve(getAll.result.length);
          };
          getAll.onerror = () => {
            db.close();
            reject(getAll.error);
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  }, { name: dbName, tableName: table });
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function openSeededPage(page, appUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page
    .locator(`[data-block-id="${seed.blockId}"]`)
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function seedPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for the durable outbox smoke');

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const pageId = randomUUID();
  const blockId = randomUUID();
  const seedText = `Seed text ${suffix}`;
  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Durable outbox smoke ${suffix}`,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'durable outbox smoke page must be created');
  const createdBlock = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: seedText }] },
    plainText: seedText,
    position: 1,
  });
  assert(createdBlock?.block?.id === blockId, 'durable outbox smoke block must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    pageId,
    blockId,
    seedText,
    marks: {
      crash: `offline-${suffix}`,
      reconnect: `reconnect-${suffix}`,
      offlineBoot: `offlineboot-${suffix}`,
      swReload: `swreload-${suffix}`,
    },
    outboxDbName: `hanji-outbox:${session.userId}`,
    recordsDbName: `hanji-records:${session.userId}`,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, 10_000).catch(() => {});
}

function parseArgs(args) {
  const parsed = {
    apiUrl: process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
    headed: false,
    timeoutMs: 20_000,
    url: DEFAULT_BASE_URL,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--headed') parsed.headed = true;
    else if (arg === '--url') parsed.url = args[++i] ?? parsed.url;
    else if (arg === '--api-url') parsed.apiUrl = args[++i] ?? parsed.apiUrl;
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number(args[++i] ?? parsed.timeoutMs) || parsed.timeoutMs;
  }
  return parsed;
}
