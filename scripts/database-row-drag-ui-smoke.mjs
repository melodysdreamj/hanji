#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database row drag UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database row drag UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertRowDragUi(browser, baseUrl, seed);
    console.log('PASS database table row drag reorders rows before/after targets and persists order through the product API without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertRowDragUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded database', () => openDatabase(page, baseUrl, seed));
    await step('drag middle row before the first row', () =>
      dragRowTo(page, baseUrl, seed, 'middle', 'first', 'before', ['middle', 'first', 'last']));
    await step('drag moved row after the last row', () =>
      dragRowTo(page, baseUrl, seed, 'middle', 'last', 'after', ['first', 'last', 'middle']));
    await step('reload persisted row order', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await page.getByRole('tab', { name: 'Table' }).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await expectDomRowTitles(page, seed, ['first', 'last', 'middle']);
      await waitForRowOrder(baseUrl, seed, ['first', 'last', 'middle'], 'reloaded drag row order');
    });
    assertNoBrowserErrors(errors, 'database row drag UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

async function openDatabase(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: 'Table' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectDomRowTitles(page, seed, ['first', 'middle', 'last']);
  await waitForRowOrder(baseUrl, seed, ['first', 'middle', 'last'], 'initial drag row order');
  const path = new URL(page.url()).pathname;
  assert(path === `/database/${seed.databaseId}`, `direct database route changed to ${path}`);
}

async function dragRowTo(page, baseUrl, seed, sourceKey, targetKey, placement, expectedKeys) {
  const sourceTitle = seed.rowTitles[sourceKey];
  const targetTitle = seed.rowTitles[targetKey];
  const sourceIndex = await rowIndexForTitle(page, sourceTitle);
  const targetIndex = await rowIndexForTitle(page, targetTitle);
  const sourceCell = cell(page, sourceIndex, 0);
  const sourceHandle = sourceCell.locator('[title="Drag row"][draggable="true"]').first();
  const targetRow = tableRow(page, targetIndex);
  const targetBox = await targetRow.boundingBox({ timeout: options.timeoutMs });
  assert(targetBox, `target row ${targetTitle} must have a bounding box`);
  const targetPosition = {
    x: Math.min(16, Math.max(2, Math.round(targetBox.width * 0.08))),
    y: placement === 'before' ? 2 : Math.max(2, Math.round(targetBox.height - 2)),
  };

  await sourceCell.hover({ timeout: options.timeoutMs });
  await sourceHandle.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await sourceHandle.dragTo(targetRow, {
    targetPosition,
    timeout: options.timeoutMs,
  });

  await expectDomRowTitles(page, seed, expectedKeys);
  await waitForRowOrder(baseUrl, seed, expectedKeys, `${placement} drag row order`);
}

function cell(page, rowIndex, colIndex) {
  return page.locator(`[data-table-cell][data-row-index="${rowIndex}"][data-col-index="${colIndex}"]`);
}

function tableRow(page, rowIndex) {
  return cell(page, rowIndex, 0).locator('xpath=..').first();
}

async function rowIndexForTitle(page, title) {
  const handle = await page.waitForFunction(
    (expected) => {
      const cells = Array.from(document.querySelectorAll('[data-table-cell][data-col-index="0"]'))
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null);
      const index = cells.findIndex((element) => {
        const input = element.querySelector('input[type="text"]');
        if (input instanceof HTMLInputElement && input.value === expected) return true;
        return element.textContent?.includes(expected) === true;
      });
      return index >= 0 ? { index } : null;
    },
    title,
    { timeout: options.timeoutMs },
  );
  const value = await handle.jsonValue();
  assert(value && Number.isInteger(value.index), `row with title ${title} must be visible`);
  return value.index;
}

async function expectDomRowTitles(page, seed, expectedKeys) {
  const expectedTitles = expectedKeys.map((key) => seed.rowTitles[key]);
  await page.waitForFunction(
    (expected) => {
      const current = Array.from(document.querySelectorAll('[data-table-cell][data-col-index="0"]'))
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .map((element) => {
          const input = element.querySelector('input[type="text"]');
          if (input instanceof HTMLInputElement) return input.value;
          return element.textContent?.trim() ?? '';
        })
        .slice(0, expected.length);
      return JSON.stringify(current) === JSON.stringify(expected);
    },
    expectedTitles,
    { timeout: options.timeoutMs },
  );
}

async function waitForRowOrder(baseUrl, seed, expectedKeys, label) {
  const expectedIds = expectedKeys.map((key) => seed.rowIds[key]);
  const knownIds = new Set(Object.values(seed.rowIds));
  const startedAt = Date.now();
  let lastOrder = [];

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'databaseRows',
      databaseId: seed.databaseId,
    });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    lastOrder = rows.map((row) => row.id).filter((id) => knownIds.has(id));
    if (JSON.stringify(lastOrder) === JSON.stringify(expectedIds)) return rows;
    await delay(250);
  }

  throw new Error(`${label} was not persisted; expected=${JSON.stringify(expectedIds)} last=${JSON.stringify(lastOrder)}`);
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database row drag UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const rowIds = {
    first: randomUUID(),
    middle: randomUUID(),
    last: randomUUID(),
  };
  const rowTitles = {
    first: `First drag row ${suffix}`,
    middle: `Middle drag row ${suffix}`,
    last: `Last drag row ${suffix}`,
  };

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Row drag smoke ${suffix}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: randomUUID(), name: 'Name', type: 'title', position: 1 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database row drag UI smoke database must be created');

  for (const key of ['first', 'middle', 'last']) {
    const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
      action: 'create',
      id: rowIds[key],
      databaseId,
      title: rowTitles[key],
    });
    assert(createdRow?.row?.id === rowIds[key], `database row drag UI smoke row ${key} must be created`);
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    rowIds,
    rowTitles,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { call: callFunction }).catch(() => {});
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
  // Smokes own their sign-in state: keep the dev runtime's master
  // auto-login (HANJI_MASTER_DEV_AUTOLOGIN) from racing this script.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('hanji:disable-master-autologin', '1');
    } catch {
      // Storage unavailable: the smoke controls auth through its own flow.
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return { context, page, errors };
}

function assertNoBrowserErrors(errors, label) {
  if (errors.length) {
    throw new Error(`Browser errors while checking ${label}:\n- ${errors.join('\n- ')}`);
  }
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
}

async function signIn(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  assert(typeof body?.accessToken === 'string' && body.accessToken, 'anonymous sign-in must return an access token');
  assert(typeof body?.refreshToken === 'string' && body.refreshToken, 'anonymous sign-in must return a refresh token');
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
  };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await fetch(resolveUrl(baseUrl, `/api/functions/${name}`), {
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
    // Continue with local workspace fallbacks below.
  }

  const candidates = [
    process.env.PLAYWRIGHT_MODULE_DIR,
    join(root, 'node_modules', 'playwright'),
    join(root, 'web', 'node_modules', 'playwright'),
    join(root, 'backend', 'node_modules', 'playwright'),
    ...edgeBasePlaywrightCandidates(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const packageJson = join(candidate, 'package.json');
    if (!existsSync(packageJson)) continue;
    const require = createRequire(packageJson);
    return require('playwright');
  }

  throw new Error(
    'Playwright is required for database row drag UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
  );
}

function edgeBasePlaywrightCandidates() {
  const edgebaseRoot = process.env.EDGEBASE_ROOT ?? new URL('../../edgebase', import.meta.url).pathname;
  const direct = join(edgebaseRoot, 'node_modules', 'playwright');
  const pnpmRoot = join(edgebaseRoot, 'node_modules', '.pnpm');
  const candidates = [direct];

  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      if (!entry.startsWith('playwright@')) continue;
      candidates.push(join(pnpmRoot, entry, 'node_modules', 'playwright'));
    }
  }

  return candidates;
}

function resolveChromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return undefined;
}

function parseArgs(args) {
  const parsed = {
    headed: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--headed') {
      parsed.headed = true;
      continue;
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a number >= 1000');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/database-row-drag-ui-smoke.mjs [options]

Checks drag-handle database row reordering with DOM and product API persistence
assertions only. The smoke drags the middle row before the first row and then
after the last row.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser while running.
`);
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
