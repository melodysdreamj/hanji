#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
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
  console.error(`\nFAIL search UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Search UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedSearchPage(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertSearchUi(browser, baseUrl, seed);
    console.log('PASS Quick Find opens from keyboard and mobile sidebar controls, searches page titles/body blocks, clears stale results on empty searches, replays recent searches, and creates a page from the keyboard without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertSearchUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded page', () => openPage(page, baseUrl, seed.pageId, seed.title));
    await step('search page title', () => assertTitleSearch(page, seed));
    await step('show recent search', () => assertRecentSearch(page, seed.titleQuery));
    await step('search page body', () => assertBodySearch(page, seed));
    await step('clear stale results for empty search', () => assertNoStaleResultsAfterEmptySearch(page, seed));
    await step('create page from search', () => assertNewPageFromSearch(page, seed));
    assertNoBrowserErrors(errors, 'search UI flow');
  } finally {
    await closeSeededContext(context, seed);
  }

  const mobile = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  await seedSession(mobile.context, seed);

  try {
    await step('open seeded page on mobile', () => openPage(mobile.page, baseUrl, seed.pageId, seed.title));
    await step('search page body from mobile sidebar', () => assertMobileBodySearch(mobile.page, seed));
    assertNoBrowserErrors(mobile.errors, 'mobile search UI flow');
  } finally {
    await closeSeededContext(mobile.context, seed);
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

async function openPage(page, baseUrl, pageId, title) {
  await page.goto(resolveUrl(baseUrl, `/p/${pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, title);
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    (expected) => {
      const titleElement = document.querySelector('[role="textbox"][aria-label="Page title"]');
      if (!titleElement) {
        return false;
      }
      const text = titleElement instanceof HTMLElement ? titleElement.innerText : titleElement.textContent;
      return text?.trim() === expected;
    },
    title,
    { timeout: options.timeoutMs },
  );
}

async function assertTitleSearch(page, seed) {
  const dialog = await openQuickFind(page);
  const input = dialog.getByRole('combobox', { name: 'Quick Find' });
  await input.fill(seed.titleQuery, { timeout: options.timeoutMs });
  await dialog.getByRole('option', { name: `New page "${seed.titleQuery}"` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('option', { name: new RegExp(escapeRegExp(seed.title)) }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await input.press('Enter', { timeout: options.timeoutMs });
  await page.waitForFunction(
    (pageId) => window.location.pathname === `/p/${pageId}`,
    seed.pageId,
    { timeout: options.timeoutMs },
  );
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await expectRecentSearchStored(page, seed.titleQuery);
}

async function assertRecentSearch(page, query) {
  const dialog = await openQuickFind(page);
  await expectQuickFindQuery(page, '');
  await dialog.getByText('Recent searches', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const recentOption = dialog.locator('[role="option"][data-kind="search"]', { hasText: query });
  await recentOption.waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('combobox', { name: 'Quick Find' }).press('End', { timeout: options.timeoutMs });
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll('[role="option"][data-kind="search"]')).some(
        (element) => element.textContent?.includes(expected) && element.getAttribute('aria-selected') === 'true',
      ),
    query,
    { timeout: options.timeoutMs },
  );
  await page.keyboard.press('Enter');
  await expectQuickFindQuery(page, query);
  await dialog.locator('[role="option"][data-kind="page"]', { hasText: query }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await closeQuickFind(page, dialog);
}

async function expectRecentSearchStored(page, query) {
  try {
    await page.waitForFunction(
      (expected) => {
        try {
          const parsed = JSON.parse(window.localStorage.getItem('hanji:quick-find:recent-searches') ?? '[]');
          return Array.isArray(parsed) && parsed.some((item) => String(item) === expected);
        } catch {
          return false;
        }
      },
      query,
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      value: window.localStorage.getItem('hanji:quick-find:recent-searches'),
      input: document.querySelector('[role="dialog"] input[aria-label="Quick Find"]') instanceof HTMLInputElement
        ? document.querySelector('[role="dialog"] input[aria-label="Quick Find"]')?.value
        : null,
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `recent search storage missing for "${query}" with localStorage=${JSON.stringify(snapshot.value)} input=${JSON.stringify(snapshot.input)}: ${message}`,
    );
  }
}

async function expectQuickFindQuery(page, query) {
  await page.waitForFunction(
    (expected) => {
      const input = document.querySelector('[role="dialog"] input[aria-label="Quick Find"]');
      return input instanceof HTMLInputElement && input.value === expected;
    },
    query,
    { timeout: options.timeoutMs },
  );
}

async function assertBodySearch(page, seed) {
  const dialog = await openQuickFind(page);
  const input = dialog.getByRole('combobox', { name: 'Quick Find' });
  await input.fill(seed.bodyNeedle, { timeout: options.timeoutMs });
  await dialog.getByText('Page content', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('option', { name: new RegExp(escapeRegExp(seed.blockText)) }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await input.press('Enter', { timeout: options.timeoutMs });
  await page.waitForFunction(
    ([pageId, blockId]) =>
      window.location.pathname === `/p/${pageId}` &&
      window.location.hash === `#block-${encodeURIComponent(blockId)}`,
    [seed.pageId, seed.blockId],
    { timeout: options.timeoutMs },
  );
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function assertNoStaleResultsAfterEmptySearch(page, seed) {
  const dialog = await openQuickFind(page);
  const input = dialog.getByRole('combobox', { name: 'Quick Find' });
  await input.fill(seed.bodyNeedle, { timeout: options.timeoutMs });
  await dialog.getByRole('option', { name: new RegExp(escapeRegExp(seed.blockText)) }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  await input.fill(seed.noHitQuery, { timeout: options.timeoutMs });
  await dialog.getByText(`No results for "${seed.noHitQuery}"`, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectNoQuickFindOptionText(dialog, seed.blockText);
  await expectNoQuickFindOptionText(dialog, seed.title);
  await dialog.getByRole('option', { name: `New page "${seed.noHitQuery}"` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await closeQuickFind(page, dialog);
}

async function assertMobileBodySearch(page, seed) {
  const dialog = await openQuickFindFromVisibleButton(page);
  const input = dialog.getByRole('combobox', { name: 'Quick Find' });
  await input.fill(seed.bodyNeedle, { timeout: options.timeoutMs });
  await dialog.getByText('Page content', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('option', { name: new RegExp(escapeRegExp(seed.blockText)) }).click({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ([pageId, blockId]) =>
      window.location.pathname === `/p/${pageId}` &&
      window.location.hash === `#block-${encodeURIComponent(blockId)}`,
    [seed.pageId, seed.blockId],
    { timeout: options.timeoutMs },
  );
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await expectRecentSearchStored(page, seed.bodyNeedle);
}

async function expectNoQuickFindOptionText(dialog, text) {
  const count = await dialog
    .locator('[role="option"][data-kind="page"], [role="option"][data-kind="block"]')
    .filter({ hasText: text })
    .count();
  assert(count === 0, `Quick Find should not keep stale result text after an empty search: ${text}`);
}

async function assertNewPageFromSearch(page, seed) {
  const dialog = await openQuickFind(page);
  const input = dialog.getByRole('combobox', { name: 'Quick Find' });
  await input.fill(seed.newPageTitle, { timeout: options.timeoutMs });
  const createOption = dialog.getByRole('option', { name: `New page "${seed.newPageTitle}"` });
  await createOption.waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await input.press('Enter', { timeout: options.timeoutMs });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.waitForFunction(
    () => window.location.pathname.startsWith('/p/'),
    undefined,
    { timeout: options.timeoutMs },
  );
  await expectPageTitle(page, seed.newPageTitle);
  const createdPageId = await page.evaluate(() => window.location.pathname.slice(3).split('/')[0]);
  assert(createdPageId && createdPageId !== seed.pageId, 'Quick Find new page should navigate to a new page');
  seed.createdPageId = createdPageId;
}

async function openQuickFind(page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const dialog = page.getByRole('dialog', { name: 'Quick Find' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('combobox', { name: 'Quick Find' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return dialog;
}

async function openQuickFindFromVisibleButton(page) {
  let quickFindButton;
  try {
    quickFindButton = await onscreenButton(page, 'Quick Find', { timeoutMs: 1000 });
  } catch {
    const openSidebarButton = await onscreenButton(page, 'Open sidebar', { timeoutMs: options.timeoutMs });
    await openSidebarButton.click({ timeout: options.timeoutMs });
    quickFindButton = await onscreenButton(page, 'Quick Find', { timeoutMs: options.timeoutMs });
  }
  await quickFindButton.click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Quick Find' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('combobox', { name: 'Quick Find' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return dialog;
}

async function onscreenButton(page, name, optionsOverride = {}) {
  const timeoutMs = optionsOverride.timeoutMs ?? options.timeoutMs;
  const buttons = page.getByRole('button', { name, exact: true });
  await page.waitForFunction((buttonName) => {
    return Array.from(document.querySelectorAll('button')).some((button) => {
      if (!(button instanceof HTMLElement)) return false;
      const text = (button.innerText || button.getAttribute('aria-label') || '').trim();
      if (text !== buttonName) return false;
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight
      );
    });
  }, name, { timeout: timeoutMs });

  const viewport = page.viewportSize() ?? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY };
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible())) continue;
    const box = await button.boundingBox();
    if (!box) continue;
    const isOnscreen = box.x + box.width > 0 && box.y + box.height > 0 && box.x < viewport.width && box.y < viewport.height;
    if (isOnscreen) return button;
  }

  throw new Error(`Could not find an onscreen ${name} button`);
}

async function closeQuickFind(page, dialog) {
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function seedSearchPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for search UI smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const blockId = randomUUID();
  const title = `Quick Find alpha ${suffix}`;
  const titleQuery = `alpha ${suffix}`;
  const bodyNeedle = `searchbody${suffix}`;
  const blockText = `Quick Find body result ${bodyNeedle}`;
  const newPageTitle = `Quick Find created ${suffix}`;
  const noHitQuery = `no-hit-${suffix}`;

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'search UI smoke page must be created');

  const block = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText }] },
    plainText: blockText,
    position: 1,
  });
  assert(block?.block?.id === blockId, 'search UI smoke block must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    pageId,
    blockId,
    title,
    titleQuery,
    bodyNeedle,
    blockText,
    newPageTitle,
    noHitQuery,
    createdPageId: '',
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  for (const id of [seed.createdPageId, seed.pageId]) {
    if (!id) continue;
    await permanentlyDeletePage(baseUrl, seed.accessToken, id, { call: callFunction }).catch(() => {});
  }
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

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
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
    'Playwright is required for search UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/search-ui-smoke.mjs [options]

Checks Quick Find title/body search, empty-result stale-result clearing, recent
query keyboard replay, and keyboard new-page creation with DOM assertions only.

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
