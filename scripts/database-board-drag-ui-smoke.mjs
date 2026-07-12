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
  console.error(`\nFAIL database board drag UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database board drag UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedBoardDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertBoardDragUi(browser, baseUrl, seed);
    console.log('PASS database board card drag reorders cards and moves cards across status groups with product API persistence without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertBoardDragUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded board view', () => openBoard(page, baseUrl, seed));
    await step('drag second todo card before the first todo card', () =>
      dragCardToCard(page, baseUrl, seed, 'second', 'first', 'before', {
        todo: ['second', 'first'],
        doing: ['third'],
        order: ['second', 'first', 'third'],
        statuses: { first: 'todo', second: 'todo', third: 'doing' },
      }));
    await step('drag first todo card after the doing card', () =>
      dragCardToCard(page, baseUrl, seed, 'first', 'third', 'after', {
        todo: ['second'],
        doing: ['third', 'first'],
        order: ['second', 'third', 'first'],
        statuses: { first: 'doing', second: 'todo', third: 'doing' },
      }));
    await step('reload persisted board drag state', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await expectSelectedBoardTab(page, seed);
      await expectColumnCards(page, seed, 'Todo', ['second']);
      await expectColumnCards(page, seed, 'Doing', ['third', 'first']);
      await waitForBoardState(baseUrl, seed, {
        order: ['second', 'third', 'first'],
        statuses: { first: 'doing', second: 'todo', third: 'doing' },
      }, 'reloaded board drag state');
    });
    assertNoBrowserErrors(errors, 'database board drag UI flow');
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

async function openBoard(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?v=${seed.boardViewId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await step('wait for board tab selection', () => expectSelectedBoardTab(page, seed));
  await step('wait for Todo board cards', () => expectColumnCards(page, seed, 'Todo', ['first', 'second']));
  await step('wait for Doing board cards', () => expectColumnCards(page, seed, 'Doing', ['third']));
  await step('wait for initial board API state', () => waitForBoardState(baseUrl, seed, {
    order: ['first', 'second', 'third'],
    statuses: { first: 'todo', second: 'todo', third: 'doing' },
  }, 'initial board drag state'));
}

async function expectSelectedBoardTab(page, seed) {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-view-tab="${id}"]`)?.getAttribute('aria-selected') === 'true',
    seed.boardViewId,
    { timeout: options.timeoutMs },
  );
  await page.getByRole('tab', { name: 'Board', selected: true, exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function dragCardToCard(page, baseUrl, seed, sourceKey, targetKey, placement, expected) {
  const source = card(page, seed.rowTitles[sourceKey]);
  const target = card(page, seed.rowTitles[targetKey]);
  await source.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await target.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const box = await target.boundingBox({ timeout: options.timeoutMs });
  assert(box, `target card ${targetKey} must have a bounding box`);

  await source.hover({ timeout: options.timeoutMs });
  await source.dragTo(target, {
    targetPosition: {
      x: Math.min(24, Math.max(4, Math.round(box.width * 0.2))),
      y: placement === 'before' ? 4 : Math.max(4, Math.round(box.height - 4)),
    },
    timeout: options.timeoutMs,
  });

  await expectColumnCards(page, seed, 'Todo', expected.todo);
  await expectColumnCards(page, seed, 'Doing', expected.doing);
  await waitForBoardState(baseUrl, seed, expected, `${placement} board card drag state`);
}

function card(page, title) {
  return page.getByRole('tabpanel').getByRole('button', { name: `Open ${title}` }).first();
}

async function expectColumnCards(page, seed, groupName, expectedKeys) {
  const expectedTitles = expectedKeys.map((key) => seed.rowTitles[key]);
  try {
    await page.waitForFunction(
      ({ label, titles }) => {
        const groupButton = Array.from(document.querySelectorAll('button'))
          .find((button) => button.getAttribute('aria-label') === `${label} group options`);
        if (!groupButton) return false;
        let column = groupButton.parentElement;
        while (column && !column.querySelector('[class*="boardCards"]')) {
          column = column.parentElement;
        }
        if (!column) return false;
        const known = new Set(titles);
        const current = Array.from(column.querySelectorAll('[role="button"][aria-label^="Open "]'))
          .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
          .map((element) => (element.getAttribute('aria-label') ?? '').replace(/^Open /, ''))
          .filter((title) => known.has(title));
        return JSON.stringify(current) === JSON.stringify(titles);
      },
      { label: groupName, titles: expectedTitles },
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      buttons: Array.from(document.querySelectorAll('button'))
        .map((button) => button.getAttribute('aria-label') || button.textContent?.trim() || '')
        .filter(Boolean)
        .slice(0, 80),
      cards: Array.from(document.querySelectorAll('[role="button"][aria-label^="Open "]'))
        .map((element) => element.getAttribute('aria-label') ?? '')
        .slice(0, 80),
      body: document.body.innerText.slice(0, 1200),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`expected ${groupName} cards ${JSON.stringify(expectedTitles)}; ${message}; snapshot=${JSON.stringify(snapshot)}`);
  }
}

async function waitForBoardState(baseUrl, seed, expected, label) {
  const expectedIds = expected.order.map((key) => seed.rowIds[key]);
  const knownIds = new Set(Object.values(seed.rowIds));
  const expectedStatuses = new Map(
    Object.entries(expected.statuses).map(([key, status]) => [seed.rowIds[key], status]),
  );
  const startedAt = Date.now();
  let lastOrder = [];
  let lastStatuses = {};

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'databaseRows',
      databaseId: seed.databaseId,
    });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const knownRows = rows.filter((row) => knownIds.has(row.id));
    lastOrder = knownRows.map((row) => row.id);
    lastStatuses = Object.fromEntries(
      knownRows.map((row) => [row.id, row.properties?.[seed.statusPropId] ?? null]),
    );
    const orderMatches = JSON.stringify(lastOrder) === JSON.stringify(expectedIds);
    const statusMatches = knownRows.every((row) => row.properties?.[seed.statusPropId] === expectedStatuses.get(row.id));
    if (orderMatches && statusMatches) return rows;
    await delay(250);
  }

  throw new Error(
    `${label} was not persisted; expectedOrder=${JSON.stringify(expectedIds)} lastOrder=${JSON.stringify(lastOrder)} lastStatuses=${JSON.stringify(lastStatuses)}`,
  );
}

async function seedBoardDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database board drag UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const titlePropId = randomUUID();
  const statusPropId = randomUUID();
  const boardViewId = randomUUID();
  const rowIds = {
    first: randomUUID(),
    second: randomUUID(),
    third: randomUUID(),
  };
  const rowTitles = {
    first: `Board drag first ${suffix}`,
    second: `Board drag second ${suffix}`,
    third: `Board drag third ${suffix}`,
  };

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Board drag smoke ${suffix}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: titlePropId, name: 'Name', type: 'title', position: 1 },
      {
        id: statusPropId,
        name: 'Status',
        type: 'status',
        position: 2,
        options: [
          { id: 'todo', name: 'Todo', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
    ],
  });
  assert(created?.page?.id === databaseId, 'database board drag UI smoke database must be created');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: boardViewId,
        databaseId,
        name: 'Board',
        type: 'board',
        position: 2,
        config: { groupBy: statusPropId, visibleProperties: [titlePropId, statusPropId], cardSize: 'medium' },
      },
    ],
  });

  for (const key of ['first', 'second', 'third']) {
    const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
      action: 'create',
      id: rowIds[key],
      databaseId,
      title: rowTitles[key],
      properties: {
        [statusPropId]: key === 'third' ? 'doing' : 'todo',
      },
    });
    assert(createdRow?.row?.id === rowIds[key], `database board drag UI smoke row ${key} must be created`);
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    statusPropId,
    boardViewId,
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
    'Playwright is required for database board drag UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/database-board-drag-ui-smoke.mjs [options]

Checks board card drag behavior with DOM and product API persistence assertions
only. The smoke reorders cards inside a Status group and moves a card across
Status groups.

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
