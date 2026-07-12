#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'search-dialog');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL search dialog visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Search dialog visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Search dialog visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedSearchWorkspace(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureSearchVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1440, height: 1000 },
      captures: [
        {
          name: 'title-results',
          query: seed.titleQuery,
          expectedVisibleTexts: ['Pages', seed.longTitleTail, seed.siblingTitleTail, `New page "${seed.titleQuery}"`],
          minOptions: 4,
          minPreviewRows: 0,
        },
        {
          name: 'body-results',
          query: seed.bodyNeedle,
          expectedVisibleTexts: ['Page content', seed.bodyPreview, 'in page', `New page "${seed.bodyNeedle}"`],
          minOptions: 2,
          minPreviewRows: 1,
        },
        {
          name: 'empty-results',
          query: seed.emptyQuery,
          expectedVisibleTexts: [`No results for "${seed.emptyQuery}"`, `New page "${seed.emptyQuery}"`],
          minOptions: 1,
          minPreviewRows: 0,
        },
      ],
    });
    await captureSearchVariant(browser, appUrl, seed, {
      prefix: 'mobile',
      mobile: true,
      viewport: { width: 390, height: 844 },
      captures: [
        {
          name: 'title-results',
          query: seed.titleQuery,
          expectedVisibleTexts: ['Pages', seed.longTitleTail, `New page "${seed.titleQuery}"`],
          minOptions: 3,
          minPreviewRows: 0,
        },
        {
          name: 'empty-results',
          query: seed.emptyQuery,
          expectedVisibleTexts: [`No results for "${seed.emptyQuery}"`, `New page "${seed.emptyQuery}"`],
          minOptions: 1,
          minPreviewRows: 0,
        },
      ],
    });

    console.log('PASS search dialog result states are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-title-results',
      'desktop-body-results',
      'desktop-empty-results',
      'mobile-title-results',
      'mobile-empty-results',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await cleanupSeed(apiUrl, seed).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureSearchVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openSeedPage(page, appUrl, seed);
    for (const capture of variant.captures) {
      const dialog = await openQuickFind(page);
      const input = dialog.getByRole('combobox', { name: 'Quick Find' });
      await input.fill(capture.query, { timeout: options.timeoutMs });
      await waitForExpectedSearchState(dialog, capture);
      await page.screenshot({
        path: join(options.screenshotDir, `${variant.prefix}-${capture.name}.png`),
        fullPage: false,
      });
      await assertSearchDialogContract(page, dialog, capture, variant);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
    }
    assertNoBrowserErrors(errors, `${variant.prefix} search dialog visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openSeedPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.rootPageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (expected) => {
      const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
      return title instanceof HTMLElement && title.innerText.trim() === expected;
    },
    seed.rootTitle,
    { timeout: options.timeoutMs },
  );
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

async function waitForExpectedSearchState(dialog, capture) {
  for (const text of capture.expectedVisibleTexts) {
    await dialog.getByText(text, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  if (capture.minPreviewRows > 0) {
    await dialog.locator('[class*="resultPreview"]').first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
}

async function assertSearchDialogContract(page, dialog, capture, variant) {
  const metrics = await dialog.evaluate((dialog, { expectedVisibleTexts }) => {
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing Quick Find dialog' };
    const rect = dialog.getBoundingClientRect();
    const input = dialog.querySelector('input[aria-label="Quick Find"]');
    const searchRow = input?.closest('[class*="searchRow"]');
    const results = dialog.querySelector('[class*="results"]');
    const footer = dialog.querySelector('[class*="footer"]');
    const options = visibleElements(dialog.querySelectorAll('[role="option"]'));
    const pageIcons = visibleElements(dialog.querySelectorAll('[class*="pageIcon"]'));
    const previews = visibleElements(dialog.querySelectorAll('[class*="resultPreview"]'));
    const sections = visibleElements(dialog.querySelectorAll('[class*="groupLabel"]'));
    const marks = visibleElements(dialog.querySelectorAll('mark'));
    const optionRects = options.map((option) => option.getBoundingClientRect());
    const overflowingOptions = options
      .filter((option) => option.scrollWidth > option.clientWidth + 2)
      .map((option) => option.textContent?.trim().slice(0, 120) ?? '');
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter((text) => !hasVisibleText(dialog, text));
    return {
      ok: true,
      dialogClientWidth: dialog.clientWidth,
      dialogScrollWidth: dialog.scrollWidth,
      emptyVisible: !!dialog.querySelector('[role="status"]'),
      footerHeight: footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0,
      height: rect.height,
      left: rect.left,
      markMaxHeight: Math.max(...marks.map((mark) => mark.getBoundingClientRect().height), 0),
      missingVisibleExpectedTexts,
      optionCount: options.length,
      optionMaxHeight: Math.max(...optionRects.map((item) => item.height), 0),
      optionMinHeight: Math.min(...optionRects.map((item) => item.height), 999),
      overflowOptionCount: overflowingOptions.length,
      overflowingOptions,
      pageIconMax: Math.max(...pageIcons.map((item) => item.getBoundingClientRect().width), 0),
      pageIconMin: Math.min(...pageIcons.map((item) => item.getBoundingClientRect().width), 999),
      previewCount: previews.length,
      resultClientWidth: results instanceof HTMLElement ? results.clientWidth : 0,
      resultScrollWidth: results instanceof HTMLElement ? results.scrollWidth : 0,
      rightGap: window.innerWidth - rect.right,
      searchRowHeight: searchRow instanceof HTMLElement ? searchRow.getBoundingClientRect().height : 0,
      sectionLabels: sections.map((section) => section.textContent?.trim() ?? '').filter(Boolean),
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

    function elRect(element) {
      return element instanceof HTMLElement
        ? element.getBoundingClientRect()
        : { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
    }

    function hasVisibleText(root, expected) {
      const visibleCompositeText = Array.from(root.querySelectorAll('*')).some((element) => {
        if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
        if (!element.innerText?.includes(expected)) return false;
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        );
      });
      if (visibleCompositeText) return true;
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
          rect.right > rootRect.left &&
          rect.left < rootRect.right &&
          rect.bottom > rootRect.top &&
          rect.top < rootRect.bottom &&
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
      const itemRect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && itemRect.width > 0 && itemRect.height > 0;
    }
  }, capture);

  assert(metrics.ok, metrics.reason ?? `${capture.name} Quick Find contract could not run`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${capture.name} expected text is not visible in screenshot: ${JSON.stringify(metrics)}`);
  assert(metrics.optionCount >= capture.minOptions, `${capture.name} should expose enough options, got ${metrics.optionCount}: ${JSON.stringify(metrics)}`);
  assert(metrics.previewCount >= capture.minPreviewRows, `${capture.name} should expose expected preview rows, got ${metrics.previewCount}: ${JSON.stringify(metrics)}`);
  assert(metrics.dialogScrollWidth <= metrics.dialogClientWidth + 4, `${capture.name} dialog should not horizontally scroll: ${JSON.stringify(metrics)}`);
  assert(metrics.resultScrollWidth <= metrics.resultClientWidth + 4, `${capture.name} results should not horizontally scroll: ${JSON.stringify(metrics)}`);
  assert(metrics.overflowOptionCount === 0, `${capture.name} result options should not visibly overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.searchRowHeight >= 44 && metrics.searchRowHeight <= 56, `${capture.name} input row should stay Notion-density, got ${Math.round(metrics.searchRowHeight)}px`);
  assert(metrics.optionMinHeight === 999 || metrics.optionMinHeight >= 34, `${capture.name} options are too cramped: ${JSON.stringify(metrics)}`);
  const optionMaxHeight = capture.minPreviewRows > 0 || variant.mobile ? 96 : 78;
  assert(metrics.optionMaxHeight <= optionMaxHeight, `${capture.name} options are too loose: ${JSON.stringify(metrics)}`);
  assert(metrics.pageIconMin === 999 || metrics.pageIconMin >= 24, `${capture.name} page icons are too small: ${JSON.stringify(metrics)}`);
  assert(metrics.pageIconMax <= 30, `${capture.name} page icons are too large: ${JSON.stringify(metrics)}`);
  assert(metrics.markMaxHeight <= 26, `${capture.name} highlighted query marks should stay inline, not wrap into a block: ${JSON.stringify(metrics)}`);
  assert(metrics.footerHeight >= 40 && metrics.footerHeight <= 56, `${capture.name} footer should stay compact: ${JSON.stringify(metrics)}`);
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} ${capture.name}`);

  if (variant.mobile) {
    assert(metrics.width >= 360 && metrics.width <= 380, `${capture.name} mobile Quick Find should fit the viewport, got ${Math.round(metrics.width)}px`);
    assert(metrics.top >= 14 && metrics.top <= 28, `${capture.name} mobile Quick Find should open near top, got ${Math.round(metrics.top)}px`);
    assert(metrics.left >= 8 && metrics.left <= 14, `${capture.name} mobile Quick Find should keep left gutter, got ${Math.round(metrics.left)}px`);
    assert(metrics.rightGap >= 8 && metrics.rightGap <= 14, `${capture.name} mobile Quick Find should keep right gutter, got ${Math.round(metrics.rightGap)}px`);
    assert(metrics.height <= metrics.viewportHeight - 32, `${capture.name} mobile Quick Find should fit vertically: ${JSON.stringify(metrics)}`);
    return;
  }

  assert(metrics.width >= 580 && metrics.width <= 660, `${capture.name} Quick Find should be 640px-class, got ${Math.round(metrics.width)}px`);
  assert(metrics.top >= 60 && metrics.top <= 92, `${capture.name} Quick Find should open below top chrome, got ${Math.round(metrics.top)}px`);
  assert(
    Math.abs(metrics.left + metrics.width / 2 - metrics.viewportWidth / 2) <= 24,
    `${capture.name} Quick Find should be centered: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.height >= 130 && metrics.height <= 560, `${capture.name} Quick Find should stay compact: ${JSON.stringify(metrics)}`);
}

async function assertNoPageHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
  assert(
    overflow.bodyScrollWidth <= overflow.bodyClientWidth + 4 &&
      overflow.documentScrollWidth <= overflow.documentClientWidth + 4,
    `${label} should not create page-level horizontal overflow: ${JSON.stringify(overflow)}`,
  );
}

async function seedSearchWorkspace(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for search dialog visual smoke');

  const suffix = String(Date.now()).slice(-6);
  const rootPageId = randomUUID();
  const longPageId = randomUUID();
  const siblingPageId = randomUUID();
  const bodyPageId = randomUUID();
  const bodyBlockId = randomUUID();
  const titleQuery = `visual ${suffix}`;
  const emptyQuery = `zz-no-result-${suffix}`;
  const bodyNeedle = `bodyneedle${suffix}`;
  const rootTitle = `Search Visual Hub ${suffix}`;
  const longTitle = `Search Visual ${suffix} Quarterly planning with unusually long customer escalation title`;
  const siblingTitle = `Search Visual ${suffix} Finance rollup`;
  const bodyTitle = `Search Visual ${suffix} Body archive`;
  const bodyPreview = `Needle paragraph ${bodyNeedle} with a long enough preview to check Quick Find wrapping and hierarchy.`;

  await createPage(baseUrl, session.accessToken, {
    id: rootPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: rootTitle,
    icon: '🔎',
    iconType: 'emoji',
    position: Date.now(),
  });
  await createPage(baseUrl, session.accessToken, {
    id: longPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: longTitle,
    icon: '📌',
    iconType: 'emoji',
    position: 1,
  });
  await createPage(baseUrl, session.accessToken, {
    id: siblingPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: siblingTitle,
    icon: '💼',
    iconType: 'emoji',
    position: 2,
  });
  await createPage(baseUrl, session.accessToken, {
    id: bodyPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: bodyTitle,
    icon: '🧭',
    iconType: 'emoji',
    position: 3,
  });
  const block = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: bodyBlockId,
    pageId: bodyPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: bodyPreview }] },
    plainText: bodyPreview,
    position: 1,
  });
  assert(block?.block?.id === bodyBlockId, 'search dialog visual body block must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    rootPageId,
    pageIds: [bodyPageId, siblingPageId, longPageId, rootPageId],
    rootTitle,
    longTitle,
    longTitleTail: 'Quarterly planning with unusually long customer escalation title',
    siblingTitle,
    siblingTitleTail: 'Finance rollup',
    bodyTitle,
    bodyPreview,
    bodyNeedle,
    titleQuery,
    emptyQuery,
  };
}

async function createPage(baseUrl, token, body) {
  const created = await callFunction(baseUrl, token, 'page-mutation', {
    action: 'create',
    ...body,
  });
  assert(created?.page?.id === body.id, `search dialog visual page must be created: ${body.title}`);
  return created.page;
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  for (const id of seed.pageIds ?? []) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, id, { call: callFunction }).catch(() => {});
  }
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
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
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

  throw new Error('Playwright is required for search dialog visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.');
}

function edgeBasePlaywrightCandidates() {
  const edgebaseRoot = process.env.EDGEBASE_ROOT ?? new URL('../../edgebase', import.meta.url).pathname;
  const direct = join(edgebaseRoot, 'node_modules', 'playwright');
  const pnpmCandidates = [];
  const pnpmDir = join(edgebaseRoot, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const name of readdirSync(pnpmDir)) {
      if (name.startsWith('playwright@')) {
        pnpmCandidates.push(join(pnpmDir, name, 'node_modules', 'playwright'));
      }
    }
  }
  return [direct, ...pnpmCandidates];
}

function resolveChromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
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
  console.log(`Usage: node scripts/search-dialog-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
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
