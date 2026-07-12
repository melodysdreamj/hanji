#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'templates-dialog');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL templates dialog visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Templates dialog visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Templates dialog visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedTemplateWorkspace(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureTemplatesVariant(browser, appUrl, seed, {
      prefix: 'desktop-all-templates',
      viewport: { width: 1440, height: 1000 },
      open: openTemplatesDialog,
      contract: {
        expectedVisibleTexts: ['Templates', 'All', 'Personal', 'Work', 'Education', 'Journal', 'Task List', 'Meeting Notes', 'Use'],
        minButtons: 14,
        minCards: 10,
        minTabs: 4,
        width: [680, 740],
      },
    });
    await captureTemplatesVariant(browser, appUrl, seed, {
      prefix: 'desktop-work-templates',
      viewport: { width: 1440, height: 1000 },
      open: openWorkTemplatesDialog,
      contract: {
        expectedVisibleTexts: ['Templates', 'Work', 'Meeting Notes', '1:1 Notes', 'Project Brief', 'Product Spec', 'Decision Log', 'Use'],
        minButtons: 8,
        minCards: 5,
        minTabs: 4,
        width: [680, 740],
      },
    });
    await captureTemplatesVariant(browser, appUrl, seed, {
      prefix: 'desktop-empty-search',
      viewport: { width: 1440, height: 1000 },
      open: openEmptySearchTemplatesDialog,
      contract: {
        expectedVisibleTexts: ['Templates', 'No templates found.'],
        minButtons: 5,
        minCards: 0,
        minTabs: 4,
        width: [680, 740],
      },
    });
    await captureTemplatesVariant(browser, appUrl, seed, {
      prefix: 'mobile-all-templates',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openTemplatesDialog,
      contract: {
        expectedVisibleTexts: ['Templates', 'All', 'Personal', 'Work', 'Journal', 'Task List', 'Use'],
        minButtons: 10,
        minCards: 6,
        minTabs: 4,
        width: [350, 390],
      },
    });

    console.log('PASS templates dialog surfaces are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-all-templates',
      'desktop-work-templates',
      'desktop-empty-search',
      'mobile-all-templates',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function captureTemplatesVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed);

  try {
    await variant.open(page, appUrl);
    await assertTemplatesDialogContract(page, variant.contract, { mobile: !!variant.mobile, prefix: variant.prefix });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} templates dialog visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openTemplatesDialog(page, baseUrl) {
  await openApp(page, baseUrl);
  const dialog = await openSidebarDialog(page, 'Templates');
  await dialog.getByRole('tab', { name: 'All', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return dialog;
}

async function openWorkTemplatesDialog(page, baseUrl) {
  const dialog = await openTemplatesDialog(page, baseUrl);
  await dialog.getByRole('tab', { name: 'Work', exact: true }).click({ timeout: options.timeoutMs });
  await waitForVisibleDialogText(page, 'Project Brief');
  return dialog;
}

async function openEmptySearchTemplatesDialog(page, baseUrl) {
  const dialog = await openTemplatesDialog(page, baseUrl);
  const search = dialog.getByLabel('Search templates');
  await search.fill('zzzzzz visual smoke template', { timeout: options.timeoutMs });
  await waitForVisibleDialogText(page, 'No templates found.');
  return dialog;
}

async function openApp(page, baseUrl) {
  await page.goto(resolveUrl(baseUrl, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator('body').waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function openSidebarDialog(page, buttonName) {
  let button;
  try {
    button = await onscreenButton(page, buttonName, { timeoutMs: 1000 });
  } catch {
    const openSidebarButton = await onscreenButton(page, 'Open sidebar', { timeoutMs: options.timeoutMs });
    await openSidebarButton.click({ timeout: options.timeoutMs });
    button = await onscreenButton(page, buttonName, { timeoutMs: options.timeoutMs });
  }
  await button.click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: buttonName });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function waitForVisibleDialogText(page, text) {
  await page.waitForFunction((expectedText) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) => element instanceof HTMLElement && isVisible(element) && element.textContent?.includes('Templates'),
    );
    if (!(dialog instanceof HTMLElement)) return false;
    return hasVisibleText(dialog, expectedText);

    function hasVisibleText(root, expected) {
      const rootRect = root.getBoundingClientRect();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(expected)) continue;
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement) || !isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        range.detach();
        if (rects.some((rect) => (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= rootRect.left - 1 &&
          rect.right <= rootRect.right + 1 &&
          rect.top >= rootRect.top - 1 &&
          rect.bottom <= rootRect.bottom + 1 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        ))) {
          return true;
        }
      }
      return false;
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, text, { timeout: options.timeoutMs });
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

async function assertTemplatesDialogContract(page, contract, variant) {
  const metrics = await page.evaluate(({ expectedVisibleTexts }) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) => element instanceof HTMLElement && isVisible(element) && element.textContent?.includes('Templates'),
    );
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing Templates dialog' };
    const rect = dialog.getBoundingClientRect();
    const buttons = visibleElements(dialog.querySelectorAll('button'));
    const cards = visibleElements(dialog.querySelectorAll('button[class*="templateCard"]'));
    const tabs = visibleElements(dialog.querySelectorAll('[role="tab"]'));
    const search = dialog.querySelector('input[aria-label="Search templates"]');
    const nav = dialog.querySelector('[aria-label="Template categories"]');
    const panel = dialog.querySelector('[role="tabpanel"]');
    const rows = visibleElements(dialog.querySelectorAll('button, [role="status"]'));
    const cardHeights = cards.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0);
    const panelRect = panel instanceof HTMLElement ? panel.getBoundingClientRect() : null;
    const partiallyClippedCards = panelRect
      ? cards.filter((element) => {
          const cardRect = element.getBoundingClientRect();
          const intersectsPanel = cardRect.bottom > panelRect.top && cardRect.top < panelRect.bottom;
          return intersectsPanel && (cardRect.top < panelRect.top - 1 || cardRect.bottom > panelRect.bottom + 1);
        }).length
      : 0;
    const rowHeights = rows.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0);
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter((item) => !hasVisibleText(dialog, item));
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      buttonCount: buttons.length,
      cardCount: cards.length,
      dialogText: dialog.textContent ?? '',
      documentScrollWidth: document.documentElement.scrollWidth,
      height: rect.height,
      left: rect.left,
      maxCardHeight: cardHeights.length ? Math.max(...cardHeights) : 0,
      maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
      minCardHeight: cardHeights.length ? Math.min(...cardHeights) : 0,
      minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
      missingVisibleExpectedTexts,
      navClientWidth: nav instanceof HTMLElement ? nav.clientWidth : 0,
      navScrollWidth: nav instanceof HTMLElement ? nav.scrollWidth : 0,
      panelClientWidth: panel instanceof HTMLElement ? panel.clientWidth : 0,
      panelScrollWidth: panel instanceof HTMLElement ? panel.scrollWidth : 0,
      partiallyClippedCards,
      rightGap: window.innerWidth - rect.right,
      searchPlaceholder: search instanceof HTMLInputElement ? search.placeholder : '',
      searchWidth: search instanceof HTMLElement ? search.getBoundingClientRect().width : 0,
      tabCount: tabs.length,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };

    function visibleElements(items) {
      return Array.from(items).filter(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function hasVisibleText(root, expected) {
      const rootRect = root.getBoundingClientRect();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(expected)) continue;
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement) || !isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        range.detach();
        if (rects.some((rect) => (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= rootRect.left - 1 &&
          rect.right <= rootRect.right + 1 &&
          rect.top >= rootRect.top - 1 &&
          rect.bottom <= rootRect.bottom + 1 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        ))) {
          return true;
        }
      }
      return false;
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, {
    expectedVisibleTexts: contract.expectedVisibleTexts ?? [],
  });

  assert(metrics.ok, metrics.reason ?? `${variant.prefix} templates dialog contract could not run`);
  const [minWidth, maxWidth] = contract.width;
  assert(metrics.width >= minWidth && metrics.width <= maxWidth, `${variant.prefix} dialog width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.left >= (variant.mobile ? 0 : 8), `${variant.prefix} dialog should not drift off left edge: ${JSON.stringify(metrics)}`);
  assert(metrics.rightGap >= (variant.mobile ? 0 : 8), `${variant.prefix} dialog should not drift off right edge: ${JSON.stringify(metrics)}`);
  assert(metrics.top >= (variant.mobile ? 8 : 28), `${variant.prefix} dialog should not crowd the top edge: ${JSON.stringify(metrics)}`);
  assert(metrics.height <= metrics.viewportHeight - (variant.mobile ? 16 : 40), `${variant.prefix} dialog should fit in the viewport: ${JSON.stringify(metrics)}`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${variant.prefix} dialog should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.panelScrollWidth <= metrics.panelClientWidth + 4, `${variant.prefix} template panel should not need horizontal scrolling: ${JSON.stringify(metrics)}`);
  assert(metrics.buttonCount >= (contract.minButtons ?? 0), `${variant.prefix} has too few visible buttons: ${JSON.stringify(metrics)}`);
  assert(metrics.cardCount >= (contract.minCards ?? 0), `${variant.prefix} has too few visible template cards: ${JSON.stringify(metrics)}`);
  assert(metrics.tabCount >= (contract.minTabs ?? 0), `${variant.prefix} has too few category tabs: ${JSON.stringify(metrics)}`);
  assert(metrics.searchPlaceholder === 'Search templates', `${variant.prefix} search placeholder drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.searchWidth >= 120, `${variant.prefix} search field is too cramped: ${JSON.stringify(metrics)}`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${variant.prefix} has expected text outside the visible screenshot: ${JSON.stringify(metrics)}`);
  assert(metrics.cardCount === 0 || metrics.minCardHeight >= 48, `${variant.prefix} template cards are too cramped: ${JSON.stringify(metrics)}`);
  assert(metrics.maxCardHeight <= 96, `${variant.prefix} template cards are too loose: ${JSON.stringify(metrics)}`);
  if (!variant.mobile) {
    assert(metrics.partiallyClippedCards === 0, `${variant.prefix} should not show partially clipped template cards: ${JSON.stringify(metrics)}`);
  }
  assert(metrics.maxRowHeight <= 120, `${variant.prefix} rows are too loose: ${JSON.stringify(metrics)}`);
  assert(metrics.minRowHeight === 0 || metrics.minRowHeight >= 20, `${variant.prefix} rows are too cramped: ${JSON.stringify(metrics)}`);
}

async function seedTemplateWorkspace(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for templates dialog visual smoke');
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
  };
}

async function seedSession(context, seed, theme = 'light') {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId, theme }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', theme);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
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
    'Playwright is required for templates dialog visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
    headed: false,
    screenshotDir: DEFAULT_SCREENSHOT_DIR,
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
    if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(resolveValue(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms' || arg === '--timeout') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error(`Invalid timeout: ${args[i + 1]}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/templates-dialog-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}

function visibleDialog(label) {
  return Array.from(document.querySelectorAll('[role="dialog"]')).find(
    (element) => element instanceof HTMLElement && isVisible(element) && element.textContent?.includes(label),
  );
}

function hasVisibleText(root, expected) {
  const rootRect = root.getBoundingClientRect();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.includes(expected)) continue;
    const parent = node.parentElement;
    if (!(parent instanceof HTMLElement) || !isVisible(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects());
    range.detach();
    if (rects.some((rect) => (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= rootRect.left - 1 &&
      rect.right <= rootRect.right + 1 &&
      rect.top >= rootRect.top - 1 &&
      rect.bottom <= rootRect.bottom + 1 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    ))) {
      return true;
    }
  }
  return false;
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function normalizeBaseUrl(url) {
  return String(url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
