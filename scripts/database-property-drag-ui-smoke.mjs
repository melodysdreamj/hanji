#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database property drag UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database property drag UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertPropertyDragUi(browser, baseUrl, seed);
    console.log('PASS database table property drag reorders visible columns and persists view propertyOrder through the product API without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertPropertyDragUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded database', () => openDatabase(page, baseUrl, seed));
    await step('drag Due before Status', () =>
      dragPropertyTo(page, baseUrl, seed, 'due', 'status', ['title', 'due', 'status', 'notes']));
    await step('drag Notes before Due', () =>
      dragPropertyTo(page, baseUrl, seed, 'notes', 'due', ['title', 'notes', 'due', 'status']));
    await step('reload persisted property order', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await page.getByRole('tab', { name: 'Table' }).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await expectPropertyOrder(page, seed, ['title', 'notes', 'due', 'status']);
      await expectRowCellOrder(page, seed, ['title', 'notes', 'due', 'status']);
      await waitForPropertyOrder(baseUrl, seed, ['title', 'notes', 'due', 'status'], 'reloaded property order');
    });
    assertNoBrowserErrors(errors, 'database property drag UI flow');
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
  await expectPropertyOrder(page, seed, ['title', 'status', 'notes', 'due']);
  await expectRowCellOrder(page, seed, ['title', 'status', 'notes', 'due']);
  await waitForPropertyOrder(baseUrl, seed, ['title', 'status', 'notes', 'due'], 'initial property order');
  const path = new URL(page.url()).pathname;
  assert(path === `/database/${seed.databaseId}`, `direct database route changed to ${path}`);
}

async function dragPropertyTo(page, baseUrl, seed, sourceKey, targetKey, expectedKeys) {
  const source = propertyHeader(page, seed.propertyNames[sourceKey]);
  const target = propertyHeader(page, seed.propertyNames[targetKey]);
  await source.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await target.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const targetBox = await target.boundingBox({ timeout: options.timeoutMs });
  assert(targetBox, `target property ${targetKey} must have a bounding box`);

  await source.dragTo(target, {
    targetPosition: {
      x: Math.max(2, Math.round(targetBox.width / 2)),
      y: Math.max(2, Math.round(targetBox.height / 2)),
    },
    timeout: options.timeoutMs,
  });

  await expectPropertyOrder(page, seed, expectedKeys);
  await expectRowCellOrder(page, seed, expectedKeys);
  await waitForPropertyOrder(baseUrl, seed, expectedKeys, `${sourceKey} before ${targetKey} property order`);
}

function propertyHeader(page, propertyName) {
  return page.getByRole('button', { name: `${propertyName} property options` }).locator('xpath=..').first();
}

async function expectPropertyOrder(page, seed, expectedKeys) {
  const expectedLabels = expectedKeys.map((key) => seed.propertyNames[key]);
  await page.waitForFunction(
    (expected) => {
      const expectedSet = new Set(expected);
      const labels = Array.from(document.querySelectorAll('button[aria-label$=" property options"]'))
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .map((element) => element.getAttribute('aria-label')?.replace(/ property options$/, '') ?? '')
        .filter((label) => expectedSet.has(label));
      return JSON.stringify(labels) === JSON.stringify(expected);
    },
    expectedLabels,
    { timeout: options.timeoutMs },
  );
}

async function expectRowCellOrder(page, seed, expectedKeys) {
  const expectedText = expectedKeys.map((key) => seed.cellText[key]);
  await page.waitForFunction(
    (expected) => {
      const cells = Array.from(document.querySelectorAll('[data-table-cell][data-row-index="0"]'))
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .slice(0, expected.length)
        .map((element) => {
          const input = element.querySelector('input[type="text"]');
          if (input instanceof HTMLInputElement) return input.value;
          return element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        });
      return cells.length === expected.length && expected.every((text, index) => cells[index].includes(text));
    },
    expectedText,
    { timeout: options.timeoutMs },
  );
}

async function waitForPropertyOrder(baseUrl, seed, expectedKeys, label) {
  const expectedIds = expectedKeys.map((key) => seed.propertyIds[key]);
  const knownIds = new Set(Object.values(seed.propertyIds));
  const startedAt = Date.now();
  let lastOrder = [];

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'database',
      databaseId: seed.databaseId,
    });
    const views = Array.isArray(result?.views) ? result.views : [];
    const view = views.find((item) => item.id === seed.tableViewId);
    lastOrder = Array.isArray(view?.config?.propertyOrder)
      ? view.config.propertyOrder.filter((id) => knownIds.has(id))
      : [];
    if (JSON.stringify(lastOrder) === JSON.stringify(expectedIds)) return view;
    await delay(250);
  }

  throw new Error(`${label} was not persisted; expected=${JSON.stringify(expectedIds)} last=${JSON.stringify(lastOrder)}`);
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database property drag UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const rowId = randomUUID();
  const propertyIds = {
    title: randomUUID(),
    status: randomUUID(),
    notes: randomUUID(),
    due: randomUUID(),
  };
  const propertyNames = {
    title: 'Name',
    status: 'Status',
    notes: 'Notes',
    due: 'Due',
  };
  const cellText = {
    title: `Column drag row ${suffix}`,
    status: 'Todo',
    notes: `Column note ${suffix}`,
    due: 'Jun 24',
  };
  const visibleProperties = [propertyIds.title, propertyIds.status, propertyIds.notes, propertyIds.due];

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Property drag smoke ${suffix}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: propertyIds.title, name: propertyNames.title, type: 'title', position: 1 },
      {
        id: propertyIds.status,
        name: propertyNames.status,
        type: 'select',
        position: 2,
        options: [
          { id: 'todo', name: 'Todo', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      { id: propertyIds.notes, name: propertyNames.notes, type: 'rich_text', position: 3 },
      { id: propertyIds.due, name: propertyNames.due, type: 'date', position: 4 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database property drag UI smoke database must be created');

  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database property drag UI smoke must receive a table view');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    patch: {
      name: 'Table',
      position: 1,
      config: { propertyOrder: visibleProperties, visibleProperties },
    },
  });

  const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: cellText.title,
    properties: {
      [propertyIds.status]: 'todo',
      [propertyIds.notes]: cellText.notes,
      [propertyIds.due]: '2026-06-24',
    },
  });
  assert(createdRow?.row?.id === rowId, 'database property drag UI smoke row must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    tableViewId,
    rowId,
    propertyIds,
    propertyNames,
    cellText,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.databaseId,
  }).catch(() => {});
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
  }, {
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
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
    'Playwright is required for database property drag UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/database-property-drag-ui-smoke.mjs [options]

Checks database table property header drag reordering with DOM and product API
persistence assertions only.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
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
