#!/usr/bin/env node
// Table render performance harness.
//
// Seeds a large database through product APIs, then measures in a real
// browser: initial table render, incremental Load-more paging to the full row
// count, DOM row count, and cell interaction latency at full size. Emits a
// JSON evidence block so virtualization decisions are made on numbers, not
// guesses.
//
//   node scripts/table-render-perf.mjs [--rows 1000] [--url http://127.0.0.1:8787]

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL table render perf: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const baseUrl = options.url.replace(/\/$/, '');
  console.log(`Table render perf target: ${baseUrl} (rows: ${options.rows})`);
  await assertRuntimeReachable(baseUrl);

  const seed = await seedLargeDatabase(baseUrl, options.rows);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(resolveChromeExecutable() ? { executablePath: resolveChromeExecutable() } : {}),
  });

  try {
    const metrics = await measure(browser, baseUrl, seed);
    console.log('\nEVIDENCE ' + JSON.stringify(metrics, null, 2));
    const verdict = [];
    if (metrics.initialRenderMs > 3000) verdict.push('initial render exceeds 3s');
    if (metrics.avgLoadMoreMs > 1500) verdict.push('load-more page exceeds 1.5s average');
    if (metrics.fullDomCellEditMs > 1000) verdict.push('cell edit at full DOM exceeds 1s');
    if (verdict.length) {
      console.log(`\nRESULT: SLOW — ${verdict.join('; ')} — virtualization warranted.`);
    } else {
      console.log('\nRESULT: OK — no threshold exceeded; virtualization not warranted at this size.');
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function measure(browser, baseUrl, seed) {
  const context = await browser.newContext();
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
  }, {
    refreshTokenKey: browserAuthStorageKeys(baseUrl).refreshTokenKey,
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // Let the functions rate limiter recover from the seeding burst so the
  // measurement reflects render cost, not 429 retries.
  console.log('Cooling down 20s after seeding burst...');
  await new Promise((r) => setTimeout(r, 20_000));

  const t0 = Date.now();
  await page.goto(`${baseUrl}/database/${seed.databaseId}`, {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  try {
    await page.locator('[data-table-cell][data-row-index="0"][data-col-index="0"]').waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? '');
    throw new Error(
      `table cell never rendered. Console errors:\n- ${consoleErrors.slice(0, 8).join('\n- ') || '(none)'}\nPage text: ${bodyText}`,
    );
  }
  const initialRenderMs = Date.now() - t0;
  const initialDomRows = await countDomRows(page);

  // Page through Load more until all rows are in the DOM.
  const loadMoreTimes = [];
  const loadMore = page.getByRole('button', { name: /Load more/ });
  for (let i = 0; i < 100; i += 1) {
    if (!(await loadMore.isVisible().catch(() => false))) break;
    const before = await countDomRows(page);
    const start = Date.now();
    await loadMore.click({ timeout: options.timeoutMs });
    await page.waitForFunction(
      (prev) => document.querySelectorAll('[data-table-cell][data-col-index="0"]').length > prev,
      before,
      { timeout: options.timeoutMs },
    );
    loadMoreTimes.push(Date.now() - start);
  }
  const fullDomRows = await countDomRows(page);
  const avgLoadMoreMs = loadMoreTimes.length
    ? Math.round(loadMoreTimes.reduce((a, b) => a + b, 0) / loadMoreTimes.length)
    : 0;
  const maxLoadMoreMs = loadMoreTimes.length ? Math.max(...loadMoreTimes) : 0;

  // Interaction latency at full DOM: edit the last row's title cell.
  const lastRow = fullDomRows - 1;
  const target = page.locator(`[data-table-cell][data-row-index="${lastRow}"][data-col-index="0"]`);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const input = target.locator('input[type="text"]').first();
  await input.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const editStart = Date.now();
  await input.fill('Perf edited row', { timeout: options.timeoutMs });
  await page.waitForFunction(
    (row) => {
      const el = document.querySelector(`[data-table-cell][data-row-index="${row}"][data-col-index="0"] input`);
      return el && el.value === 'Perf edited row';
    },
    lastRow,
    { timeout: options.timeoutMs },
  );
  const fullDomCellEditMs = Date.now() - editStart;

  // Scroll cost proxy: jump to top and back to bottom, timed.
  const scrollStart = Date.now();
  await page.evaluate(() => {
    const scroller = document.scrollingElement;
    scroller?.scrollTo(0, 0);
  });
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const fullScrollRoundtripMs = Date.now() - scrollStart;

  await context.close();
  return {
    rowsSeeded: options.rows,
    initialRenderMs,
    initialDomRows,
    loadMoreClicks: loadMoreTimes.length,
    avgLoadMoreMs,
    maxLoadMoreMs,
    fullDomRows,
    fullDomCellEditMs,
    fullScrollRoundtripMs,
  };
}

async function countDomRows(page) {
  return page.evaluate(
    () => document.querySelectorAll('[data-table-cell][data-col-index="0"]').length,
  );
}

async function seedLargeDatabase(baseUrl, rows) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');

  const databaseId = crypto.randomUUID();
  const statusPropId = crypto.randomUUID();
  const notesPropId = crypto.randomUUID();
  const scorePropId = crypto.randomUUID();
  const donePropId = crypto.randomUUID();
  const duePropId = crypto.randomUUID();

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Table perf ${Date.now()}`,
    viewType: 'table',
    properties: [
      { id: crypto.randomUUID(), name: 'Name', type: 'title', position: 1 },
      { id: notesPropId, name: 'Notes', type: 'rich_text', position: 2 },
      {
        id: statusPropId,
        name: 'Status',
        type: 'select',
        position: 3,
        options: [
          { id: 'todo', name: 'Todo', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      { id: scorePropId, name: 'Score', type: 'number', position: 4, numberFormat: 'number' },
      { id: donePropId, name: 'Done', type: 'checkbox', position: 5 },
      { id: duePropId, name: 'Due', type: 'date', position: 6 },
    ],
  });
  assert(created?.page?.id === databaseId, 'perf database must be created');

  const statuses = ['todo', 'doing', 'done'];
  const existing = Array.isArray(created?.rows) ? created.rows.length : 0;
  const toCreate = Math.max(0, rows - existing);
  const CONCURRENCY = 8;
  let createdCount = 0;
  const queue = Array.from({ length: toCreate }, (_, i) => i);
  async function createRow(i) {
    // The functions route is rate-limited; back off and retry on 429.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
          action: 'create',
          databaseId,
          title: `Perf row ${String(i + 1).padStart(4, '0')}`,
          properties: {
            [notesPropId]: `Row ${i} notes with some medium-length content to render`,
            [statusPropId]: statuses[i % 3],
            [scorePropId]: i * 3 + 0.5,
            [donePropId]: i % 2 === 0,
            [duePropId]: `2026-0${(i % 9) + 1}-1${i % 9}`,
          },
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('429') || attempt === 7) throw error;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  async function worker() {
    for (;;) {
      const i = queue.shift();
      if (i === undefined) return;
      await createRow(i);
      createdCount += 1;
      if (createdCount % 200 === 0) console.log(`  seeded ${createdCount}/${toCreate} rows`);
    }
  }
  const seedStart = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Seeded ${toCreate} rows in ${Date.now() - seedStart}ms`);

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { call: callFunction });
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, `/api/health returned HTTP ${response.status}`);
}

async function signIn(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/signin/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await fetch(`${baseUrl}/api/functions/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got: ${text.slice(0, 200)}`);
  }
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // fall through to workspace candidates
  }
  const edgebaseRoot = process.env.EDGEBASE_ROOT ?? new URL('../../edgebase', import.meta.url).pathname;
  const candidates = [
    process.env.PLAYWRIGHT_MODULE_DIR,
    join(root, 'node_modules', 'playwright'),
    join(root, 'web', 'node_modules', 'playwright'),
    join(root, 'backend', 'node_modules', 'playwright'),
    join(edgebaseRoot, 'node_modules', 'playwright'),
  ].filter(Boolean);
  const pnpmRoot = join(edgebaseRoot, 'node_modules', '.pnpm');
  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      if (entry.startsWith('playwright@')) {
        candidates.push(join(pnpmRoot, entry, 'node_modules', 'playwright'));
      }
    }
  }
  for (const candidate of candidates) {
    const packageJson = join(candidate, 'package.json');
    if (!existsSync(packageJson)) continue;
    const require = createRequire(packageJson);
    return require('playwright');
  }
  throw new Error('Playwright is required. Install it or set PLAYWRIGHT_MODULE_DIR.');
}

function resolveChromeExecutable() {
  return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? undefined;
}

function parseArgs(args) {
  const parsed = { rows: 1000, url: DEFAULT_BASE_URL, timeoutMs: 30_000, headed: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--rows') { parsed.rows = Number(args[++i]); continue; }
    if (arg === '--url') { parsed.url = args[++i]; continue; }
    if (arg === '--timeout-ms') { parsed.timeoutMs = Number(args[++i]); continue; }
    if (arg === '--headed') { parsed.headed = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  assert(Number.isFinite(parsed.rows) && parsed.rows >= 100, '--rows must be >= 100');
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
