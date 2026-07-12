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
  console.error(`\nFAIL database calendar drag UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database calendar drag UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedCalendarDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertCalendarDragUi(browser, baseUrl, seed);
    console.log('PASS database calendar card drag reschedules a row and persists the date property through the product API without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertCalendarDragUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded calendar view', () => openCalendar(page, baseUrl, seed));
    await step('drag calendar card to target day', () => dragCardToDay(page, baseUrl, seed));
    await step('reload persisted calendar drag state', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await expectSelectedCalendarTab(page, seed);
      await expectDayCards(page, seed, seed.sourceDate, []);
      await expectDayCards(page, seed, seed.targetDate, ['event']);
      await waitForRowDate(baseUrl, seed, seed.targetDate, 'reloaded calendar date');
    });
    assertNoBrowserErrors(errors, 'database calendar drag UI flow');
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

async function openCalendar(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?v=${seed.calendarViewId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await expectSelectedCalendarTab(page, seed);
  await expectDayCards(page, seed, seed.sourceDate, ['event']);
  await expectDayCards(page, seed, seed.targetDate, []);
  await waitForRowDate(baseUrl, seed, seed.sourceDate, 'initial calendar date');
}

async function expectSelectedCalendarTab(page, seed) {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-view-tab="${id}"]`)?.getAttribute('aria-selected') === 'true',
    seed.calendarViewId,
    { timeout: options.timeoutMs },
  );
  await page.getByRole('tab', { name: 'Calendar', selected: true, exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function dragCardToDay(page, baseUrl, seed) {
  const source = calendarCard(page, seed.rowTitles.event);
  const target = dayCell(page, seed.targetDate);
  await source.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await target.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const sourceBox = await source.boundingBox({ timeout: options.timeoutMs });
  const targetBox = await target.boundingBox({ timeout: options.timeoutMs });
  assert(sourceBox, 'source calendar card must have a bounding box');
  assert(targetBox, 'target calendar day must have a bounding box');

  const sourcePoint = {
    x: sourceBox.x + Math.min(24, Math.max(8, sourceBox.width * 0.3)),
    y: sourceBox.y + Math.min(14, Math.max(6, sourceBox.height * 0.5)),
  };
  const targetPoint = {
    x: targetBox.x + Math.min(40, Math.max(14, targetBox.width * 0.25)),
    y: targetBox.y + 44,
  };

  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + 10, sourcePoint.y + 10, { steps: 4 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
  await page.mouse.up();

  await expectDayCards(page, seed, seed.sourceDate, []);
  await expectDayCards(page, seed, seed.targetDate, ['event']);
  await waitForRowDate(baseUrl, seed, seed.targetDate, 'dragged calendar date');
}

function calendarCard(page, title) {
  return page.getByRole('tabpanel').getByRole('button', { name: `Open ${title}` }).first();
}

function dayCell(page, date) {
  return page.locator(`button[aria-label="New row on ${date}"]`).locator('xpath=../..').first();
}

async function expectDayCards(page, seed, date, expectedKeys) {
  const expectedTitles = expectedKeys.map((key) => seed.rowTitles[key]);
  try {
    await page.waitForFunction(
      ({ day, titles }) => {
        const dayButton = Array.from(document.querySelectorAll('button'))
          .find((button) => button.getAttribute('aria-label') === `New row on ${day}`);
        if (!dayButton) return false;
        const cell = dayButton.closest('[class*="calendarCell"]');
        if (!cell) return false;
        const current = Array.from(cell.querySelectorAll('button[aria-label^="Open "]'))
          .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
          .map((element) => (element.getAttribute('aria-label') ?? '').replace(/^Open /, ''));
        return JSON.stringify(current) === JSON.stringify(titles);
      },
      { day: date, titles: expectedTitles },
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const snapshot = await page.evaluate((day) => {
      const dayButton = Array.from(document.querySelectorAll('button'))
        .find((button) => button.getAttribute('aria-label') === `New row on ${day}`);
      const cell = dayButton?.closest('[class*="calendarCell"]') ?? null;
      return {
        day,
        cellText: cell?.textContent?.trim() ?? null,
        cards: Array.from(document.querySelectorAll('button[aria-label^="Open "]'))
          .map((element) => element.getAttribute('aria-label') ?? '')
          .slice(0, 80),
        body: document.body.innerText.slice(0, 1200),
      };
    }, date);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`expected ${date} cards ${JSON.stringify(expectedTitles)}; ${message}; snapshot=${JSON.stringify(snapshot)}`);
  }
}

async function waitForRowDate(baseUrl, seed, expectedDate, label) {
  const startedAt = Date.now();
  let lastValue = null;

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'databaseRows',
      databaseId: seed.databaseId,
    });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const row = rows.find((item) => item.id === seed.rowIds.event);
    lastValue = row?.properties?.[seed.datePropId] ?? null;
    if (lastValue === expectedDate) return row;
    await delay(250);
  }

  throw new Error(`${label} was not persisted; expected=${expectedDate} last=${lastValue}`);
}

async function seedCalendarDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database calendar drag UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const titlePropId = randomUUID();
  const datePropId = randomUUID();
  const calendarViewId = randomUUID();
  const sourceDate = currentMonthDate(10);
  const targetDate = currentMonthDate(15);
  const rowIds = {
    event: randomUUID(),
  };
  const rowTitles = {
    event: `Calendar drag event ${suffix}`,
  };

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Calendar drag smoke ${suffix}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: titlePropId, name: 'Name', type: 'title', position: 1 },
      { id: datePropId, name: 'Due', type: 'date', position: 2 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database calendar drag UI smoke database must be created');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: calendarViewId,
        databaseId,
        name: 'Calendar',
        type: 'calendar',
        position: 2,
        config: { calendarBy: datePropId, visibleProperties: [titlePropId, datePropId] },
      },
    ],
  });

  const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowIds.event,
    databaseId,
    title: rowTitles.event,
    properties: {
      [datePropId]: sourceDate,
    },
  });
  assert(createdRow?.row?.id === rowIds.event, 'database calendar drag UI smoke row must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    datePropId,
    calendarViewId,
    sourceDate,
    targetDate,
    rowIds,
    rowTitles,
  };
}

function currentMonthDate(day) {
  const now = new Date();
  return dateKey(new Date(now.getFullYear(), now.getMonth(), day));
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
    'Playwright is required for database calendar drag UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/database-calendar-drag-ui-smoke.mjs [options]

Checks calendar card drag rescheduling with DOM and product API persistence
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
