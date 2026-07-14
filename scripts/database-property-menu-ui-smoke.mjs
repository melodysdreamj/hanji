#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permanentlyDeletePage, captureBrowserSession, installBrowserSession } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database property menu UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database property menu UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertPropertyMenuUi(browser, baseUrl, seed);
    console.log('PASS database table property menu wraps and hides columns with product API persistence without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertPropertyMenuUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded database', () => openDatabase(page, baseUrl, seed));
    await step('wrap Status text from property menu', () => wrapProperty(page, baseUrl, seed, 'status'));
    await step('hide Notes from property menu', () => hideProperty(page, baseUrl, seed, 'notes'));
    await step('reload persisted property menu settings', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await page.getByRole('tab', { name: 'Table' }).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await expectVisiblePropertyOrder(page, seed, ['title', 'status']);
      await expectWrappedColumn(page, seed.propertyNames.status, true);
      await waitForViewConfig(baseUrl, seed, {
        visibleKeys: ['title', 'status'],
        wrappedKeys: ['status'],
        label: 'reloaded property menu settings',
      });
    });
    assertNoBrowserErrors(errors, 'database property menu UI flow');
  } catch (error) {
    const screenshotDir = join(root, '.edgebase', 'ui-discovery', 'database-property-menu');
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: join(screenshotDir, 'reload-failure.png'),
      fullPage: true,
    }).catch(() => {});
    throw error;
  } finally {
    await closeSeededContext(context, seed);
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
  await expectVisiblePropertyOrder(page, seed, ['title', 'status', 'notes']);
  await expectWrappedColumn(page, seed.propertyNames.status, false);
  await waitForViewConfig(baseUrl, seed, {
    visibleKeys: ['title', 'status', 'notes'],
    wrappedKeys: [],
    label: 'initial property menu settings',
  });
  const path = new URL(page.url()).pathname;
  assert(path === `/database/${seed.databaseId}`, `direct database route changed to ${path}`);
}

async function wrapProperty(page, baseUrl, seed, propertyKey) {
  const name = seed.propertyNames[propertyKey];
  await openPropertyMenu(page, name);
  const dialog = page.getByRole('dialog', { name: `${name} property options` });
  await dialog.getByRole('button', { name: /Wrap text|Unwrap text/ }).click({ timeout: options.timeoutMs });
  await expectWrappedColumn(page, name, true);
  await waitForViewConfig(baseUrl, seed, {
    visibleKeys: ['title', 'status', 'notes'],
    wrappedKeys: [propertyKey],
    label: `${name} wrapped setting`,
  });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function hideProperty(page, baseUrl, seed, propertyKey) {
  const name = seed.propertyNames[propertyKey];
  await openPropertyMenu(page, name);
  const dialog = page.getByRole('dialog', { name: `${name} property options` });
  await dialog.getByRole('button', { name: 'Hide' }).click({ timeout: options.timeoutMs });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await expectVisiblePropertyOrder(page, seed, ['title', 'status']);
  await waitForViewConfig(baseUrl, seed, {
    visibleKeys: ['title', 'status'],
    wrappedKeys: ['status'],
    label: `${name} hidden setting`,
  });
}

async function openPropertyMenu(page, propertyName) {
  await page.getByRole('button', { name: `${propertyName} property options` }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('dialog', { name: `${propertyName} property options` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function expectVisiblePropertyOrder(page, seed, expectedKeys) {
  const expectedLabels = expectedKeys.map((key) => seed.propertyNames[key]);
  const knownLabels = Object.values(seed.propertyNames);
  try {
    await page.waitForFunction(
      ({ expected, known }) => {
        const knownSet = new Set(known);
        const labels = Array.from(document.querySelectorAll('button[aria-label$=" property options"]'))
          .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
          .map((element) => element.getAttribute('aria-label')?.replace(/ property options$/, '') ?? '')
          .filter((label) => knownSet.has(label));
        return JSON.stringify(labels) === JSON.stringify(expected);
      },
      { expected: expectedLabels, known: knownLabels },
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const actualLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button[aria-label$=" property options"]'))
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .map((element) => element.getAttribute('aria-label')?.replace(/ property options$/, '') ?? ''),
    );
    throw new Error(
      `visible property order did not settle; expected=${JSON.stringify(expectedLabels)} actual=${JSON.stringify(actualLabels)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function expectWrappedColumn(page, propertyName, wrapped) {
  await page.waitForFunction(
    ([name, expected]) => {
      const labels = Array.from(document.querySelectorAll('button[aria-label$=" property options"]'))
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .map((element) => element.getAttribute('aria-label')?.replace(/ property options$/, '') ?? '');
      const index = labels.indexOf(name);
      if (index < 0) return false;
      const cell = document.querySelector(`[data-table-cell][data-row-index="0"][data-col-index="${index}"]`);
      if (!(cell instanceof HTMLElement)) return false;
      return (cell.getAttribute('data-wrap') === 'true') === expected;
    },
    [propertyName, wrapped],
    { timeout: options.timeoutMs },
  );
}

async function waitForViewConfig(baseUrl, seed, expectation) {
  const visibleIds = expectation.visibleKeys.map((key) => seed.propertyIds[key]);
  const wrappedIds = expectation.wrappedKeys.map((key) => seed.propertyIds[key]);
  const knownIds = new Set(Object.values(seed.propertyIds));
  const startedAt = Date.now();
  let lastVisible = [];
  let lastWrapped = [];

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'database',
      databaseId: seed.databaseId,
    });
    const views = Array.isArray(result?.views) ? result.views : [];
    const view = views.find((item) => item.id === seed.tableViewId);
    lastVisible = Array.isArray(view?.config?.visibleProperties)
      ? view.config.visibleProperties.filter((id) => knownIds.has(id))
      : [];
    lastWrapped = Array.isArray(view?.config?.wrappedColumns)
      ? view.config.wrappedColumns.filter((id) => knownIds.has(id))
      : [];
    if (
      JSON.stringify(lastVisible) === JSON.stringify(visibleIds) &&
      JSON.stringify(lastWrapped) === JSON.stringify(wrappedIds)
    ) {
      return view;
    }
    await delay(250);
  }

  throw new Error(
    `${expectation.label} was not persisted; expected visible=${JSON.stringify(visibleIds)} wrapped=${JSON.stringify(wrappedIds)} last visible=${JSON.stringify(lastVisible)} wrapped=${JSON.stringify(lastWrapped)}`,
  );
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database property menu UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const rowId = randomUUID();
  const propertyIds = {
    title: randomUUID(),
    status: randomUUID(),
    notes: randomUUID(),
  };
  const propertyNames = {
    title: 'Name',
    status: 'Status',
    notes: 'Notes',
  };
  const visibleProperties = [propertyIds.title, propertyIds.status, propertyIds.notes];

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Property menu smoke ${suffix}`,
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
    ],
  });
  assert(created?.page?.id === databaseId, 'database property menu UI smoke database must be created');

  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database property menu UI smoke must receive a table view');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    // Routing hint for the workspace-DO split (view ids are not pages).
    databaseId,
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
    title: `Menu row ${suffix}`,
    properties: {
      [propertyIds.status]: 'todo',
      [propertyIds.notes]: `Menu note ${suffix}`,
    },
  });
  assert(createdRow?.row?.id === rowId, 'database property menu UI smoke row must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    databaseId,
    tableViewId,
    rowId,
    propertyIds,
    propertyNames,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { call: callFunction }).catch(() => {});
}

async function seedSession(context, seed) {
  // Shared harness install: the first context bootstraps from the API-issued
  // refresh token; later contexts transplant the rotated HttpOnly cookie
  // captured by closeSeededContext (EdgeBase rotation reuse detection forbids
  // replaying the original token across contexts).
  await installBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
    workspaceId: seed.workspaceId,
  });
}

async function closeSeededContext(context, seed) {
  // Capture the FINAL rotated HttpOnly cookie before the context dies — any
  // in-flow reload/goto rotates the credential again, and replaying an older
  // cookie in the next context would trip reuse detection (family revocation).
  await captureBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
  }).catch(() => {});
  await context.close().catch(() => {});
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
    userId: body?.user?.id ?? '',
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
    'Playwright is required for database property menu UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/database-property-menu-ui-smoke.mjs [options]

Checks table property menu view settings with DOM and product API persistence
assertions only.

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
