#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_API_URL = process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL;
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database imported view config UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Database imported view config UI smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Database imported view config UI smoke API: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  const seed = await seedDatabase(apiUrl);
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);

  try {
    await assertImportedViewConfig(browser, appUrl, apiUrl, seed);
    console.log('PASS imported hidden properties and normalized filters render through database UI without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertImportedViewConfig(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open imported-view database route', () => openDatabaseRoute(page, appUrl, seed));
    await step('scope imported database page views to its Notion container', () => expectScopedImportedViewTabs(page, apiUrl, seed));
    await step('read initial imported view config through product API', () => waitForViewConfig(apiUrl, seed, {
      hiddenKeys: ['notes'],
      quickFilterKeys: [],
      filterKeys: ['status'],
      label: 'initial imported view config',
    }));
    await step('honor imported hidden properties in UI', () => expectVisiblePropertyOrder(page, seed, ['title', 'status']));
    await step('apply imported Notion table quick filter to rows', () => expectVisibleRowTitles(page, [seed.todoTitle]));
    await step('show imported filter in the normal filter editor', () => expectNormalFilterEditor(page, apiUrl, seed));
    assertNoBrowserErrors(errors, 'database imported view config UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function openDatabaseRoute(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: 'Table' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function expectScopedImportedViewTabs(page, baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'database',
    databaseId: seed.databaseId,
  });
  const views = Array.isArray(result?.views) ? result.views : [];
  const ids = views.map((view) => view.id);
  assert(ids.includes(seed.tableViewId), `database snapshot should keep the container table view: ${JSON.stringify(views)}`);
  assert(ids.includes(seed.containerPeerViewId), `database snapshot should keep peer views from the same Notion container: ${JSON.stringify(views)}`);
  assert(!ids.includes(seed.otherContainerViewId), `database snapshot should hide views from other Notion containers: ${JSON.stringify(views)}`);

  await page.waitForFunction(
    ({ expected, disallowed }) => {
      const labels = Array.from(document.querySelectorAll('[data-view-tab]'))
        .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      return (
        expected.every((label) => labels.some((text) => text.includes(label))) &&
        disallowed.every((label) => labels.every((text) => !text.includes(label)))
      );
    },
    {
      expected: ['Table', 'All imported'],
      disallowed: ['Other container default'],
    },
    { timeout: options.timeoutMs },
  );
}

async function expectNormalFilterEditor(page, baseUrl, seed) {
  await page.getByRole('button', { name: /^Filter/ }).click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Filters' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Status Is Todo' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectNoVisibleText(dialog, 'Quick filters');
  await expectVisibleRowTitles(page, [seed.todoTitle]);
  await waitForViewConfig(baseUrl, seed, {
    hiddenKeys: ['notes'],
    quickFilterKeys: [],
    filterKeys: ['status'],
    label: 'imported quick filter normalized into active filter tree',
  });
}

async function expectVisiblePropertyOrder(page, seed, expectedKeys) {
  const expectedLabels = expectedKeys.map((key) => seed.propertyNames[key]);
  const knownLabels = Object.values(seed.propertyNames);
  const startedAt = Date.now();
  let lastLabels = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    lastLabels = await visiblePropertyLabels(page, knownLabels);
    if (JSON.stringify(lastLabels) === JSON.stringify(expectedLabels)) return;
    await delay(250);
  }
  throw new Error(
    `expected visible properties ${JSON.stringify(expectedLabels)}, got ${JSON.stringify(lastLabels)}`,
  );
}

async function visiblePropertyLabels(page, knownLabels) {
  return page.evaluate((known) => {
    const knownSet = new Set(known);
    return Array.from(document.querySelectorAll('button[aria-label$=" property options"]'))
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .map((element) => element.getAttribute('aria-label')?.replace(/ property options$/, '') ?? '')
      .filter((label) => knownSet.has(label));
  }, knownLabels);
}

async function expectVisibleRowTitles(page, expectedTitles) {
  await page.waitForFunction(
    (expected) => {
      const values = Array.from(
        document.querySelectorAll('[data-table-cell][data-col-index="0"] input[type="text"]'),
      )
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .map((input) => input.value);
      return JSON.stringify(values) === JSON.stringify(expected);
    },
    expectedTitles,
    { timeout: options.timeoutMs },
  );
}

async function expectNoVisibleText(locator, text) {
  const count = await locator.getByText(text, { exact: true }).count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.getByText(text, { exact: true }).nth(index);
    if (await item.isVisible().catch(() => false)) {
      throw new Error(`Unexpected visible text: ${text}`);
    }
  }
}

async function waitForViewConfig(baseUrl, seed, expectation) {
  const hiddenIds = expectation.hiddenKeys.map((key) => seed.propertyIds[key]);
  const quickFilterIds = expectation.quickFilterKeys.map((key) => seed.propertyIds[key]);
  const filterIds = expectation.filterKeys.map((key) => seed.propertyIds[key]);
  const knownIds = new Set(Object.values(seed.propertyIds));
  const startedAt = Date.now();
  let lastHidden = [];
  let lastQuick = [];
  let lastFilters = [];
  const flattenFilters = (term) => {
    if (!term || typeof term !== 'object') return [];
    if (typeof term.conjunction === 'string') {
      return [
        ...(Array.isArray(term.filters) ? term.filters.flatMap(flattenFilters) : []),
        ...(Array.isArray(term.groups) ? term.groups.flatMap(flattenFilters) : []),
      ];
    }
    return [term];
  };

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'database',
      databaseId: seed.databaseId,
    });
    const views = Array.isArray(result?.views) ? result.views : [];
    const view = views.find((item) => item.id === seed.tableViewId);
    lastHidden = Array.isArray(view?.config?.hiddenProperties)
      ? view.config.hiddenProperties.filter((id) => knownIds.has(id))
      : [];
    lastQuick = Array.isArray(view?.config?.quickFilters)
      ? view.config.quickFilters
          .map((filter) => filter?.propertyId)
          .filter((id) => knownIds.has(id))
      : [];
    lastFilters = flattenFilters(view?.config?.filterGroup)
      .map((filter) => filter?.propertyId)
      .filter((id) => knownIds.has(id));
    if (
      JSON.stringify(lastHidden) === JSON.stringify(hiddenIds) &&
      JSON.stringify(lastQuick) === JSON.stringify(quickFilterIds) &&
      JSON.stringify(lastFilters) === JSON.stringify(filterIds)
    ) {
      return view;
    }
    await delay(250);
  }

  throw new Error(
    `${expectation.label} was not persisted; expected hidden=${JSON.stringify(hiddenIds)} quick=${JSON.stringify(quickFilterIds)} filters=${JSON.stringify(filterIds)} last hidden=${JSON.stringify(lastHidden)} quick=${JSON.stringify(lastQuick)} filters=${JSON.stringify(lastFilters)}`,
  );
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for imported view config UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const todoRowId = randomUUID();
  const doingRowId = randomUUID();
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
  const propertyOrder = [propertyIds.title, propertyIds.status, propertyIds.notes];
  const todoTitle = `Imported quick filter todo ${suffix}`;
  const doingTitle = `Imported quick filter doing ${suffix}`;
  const notionContainerId = `notion-container-${suffix}`;
  const otherContainerId = `other-container-${suffix}`;
  const notionDataSourceId = `notion-data-source-${suffix}`;
  const containerPeerViewId = randomUUID();
  const otherContainerViewId = randomUUID();

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Imported view config smoke ${suffix}`,
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
        ],
      },
      { id: propertyIds.notes, name: propertyNames.notes, type: 'rich_text', position: 3 },
    ],
  });
  assert(created?.page?.id === databaseId, 'imported view config UI smoke database must be created');

  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'imported view config UI smoke must receive a table view');

  await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'update',
    id: databaseId,
    patch: {
      properties: {
        notionDatabaseId: notionContainerId,
        notionDataSourceId,
      },
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    patch: {
      name: 'Table',
      position: 1,
      config: {
        propertyOrder,
        visibleProperties: null,
        hiddenProperties: [propertyIds.notes],
        notionQuickFilters: {
          Status: {
            select: {
              equals: 'Todo',
            },
          },
        },
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: propertyIds.status, operator: 'equals', value: 'todo' }],
          groups: [],
        },
        notionViewId: `notion-table-view-${suffix}`,
        notion: {
          id: `notion-table-view-${suffix}`,
          name: 'Table',
          type: 'table',
          parent: { database_id: notionContainerId },
          data_source_id: notionDataSourceId,
        },
      },
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: containerPeerViewId,
        databaseId,
        name: 'All imported',
        type: 'table',
        position: 2,
        config: {
          propertyOrder,
          visibleProperties: propertyOrder,
          notionViewId: `notion-all-view-${suffix}`,
          notion: {
            id: `notion-all-view-${suffix}`,
            name: 'All imported',
            type: 'table',
            parent: { database_id: notionContainerId },
            data_source_id: notionDataSourceId,
          },
        },
      },
      {
        id: otherContainerViewId,
        databaseId,
        name: 'Other container default',
        type: 'table',
        position: 3,
        config: {
          propertyOrder,
          visibleProperties: propertyOrder,
          notionViewId: `notion-other-view-${suffix}`,
          notion: {
            id: `notion-other-view-${suffix}`,
            name: 'Other container default',
            type: 'table',
            parent: { database_id: otherContainerId },
            data_source_id: notionDataSourceId,
          },
        },
      },
    ],
  });

  await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: todoRowId,
    databaseId,
    title: todoTitle,
    properties: {
      [propertyIds.status]: 'todo',
      [propertyIds.notes]: `Hidden imported note ${suffix}`,
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: doingRowId,
    databaseId,
    title: doingTitle,
    properties: {
      [propertyIds.status]: 'doing',
      [propertyIds.notes]: `Hidden imported doing note ${suffix}`,
    },
  });

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    tableViewId,
    containerPeerViewId,
    otherContainerViewId,
    propertyIds,
    propertyNames,
    todoTitle,
    doingTitle,
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
    'Playwright is required for database imported view config UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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

function resolveChromeExecutable(chromium) {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  const bundled = chromium.executablePath?.();
  if (bundled && existsSync(bundled)) return bundled;
  return undefined;
}

async function launchBrowser(chromium) {
  const executablePath = resolveChromeExecutable(chromium);
  if (!executablePath) return chromium.launch({ headless: !options.headed, timeout: 10_000 });
  try {
    return await chromium.launch({
      headless: !options.headed,
      executablePath,
      timeout: 10_000,
    });
  } catch (error) {
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.PLAYWRIGHT_CHROME_EXECUTABLE) {
      throw error;
    }
    return chromium.launch({ headless: !options.headed, timeout: 10_000 });
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

function parseArgs(args) {
  const parsed = {
    apiUrl: DEFAULT_API_URL,
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
    if (arg === '--api-url') {
      parsed.apiUrl = resolveValue(args, i, arg);
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
  console.log(`Usage: node scripts/database-imported-view-config-ui-smoke.mjs [options]

Checks imported database view config for hidden properties and quick filters with
DOM and product API assertions only.

Options:
  --url <url>             App URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL. Defaults to NOTIONLIKE_EDGEBASE_API_URL or ${DEFAULT_API_URL}.
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
