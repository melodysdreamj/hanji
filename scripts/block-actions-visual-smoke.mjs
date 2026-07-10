#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'block-actions');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL block actions visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Block actions visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Block actions visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedBlockActionsPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureBlockMenuVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      target: seed.targets.desktop,
      viewport: { width: 1440, height: 1000 },
    });
    await captureBlockMenuVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark',
      target: seed.targets.desktopDark,
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
    });
    await captureBlockMenuVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      target: seed.targets.mobile,
      viewport: { width: 390, height: 844 },
    });
    await captureBlockMenuVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile-dark',
      target: seed.targets.mobileDark,
      theme: 'dark',
      viewport: { width: 390, height: 844 },
    });

    console.log('PASS block actions menu visuals are captured and stay within the Notion-style layout contract.');
    for (const name of ['desktop', 'desktop-dark', 'mobile', 'mobile-dark']) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}-block-actions.png`)}`);
      console.log(`Turn-into screenshot: ${join(options.screenshotDir, `${name}-turn-into.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureBlockMenuVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openPage(page, appUrl, variant.target);
    await openBlockActionMenu(page, variant.target.blockId, { focusBlockFirst: !!variant.mobile });
    await assertBlockMenuContract(page, variant, 'main');
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-block-actions.png`),
      fullPage: false,
    });

    await page.getByRole('menuitem', { name: /^Turn into\b/ }).click({ timeout: options.timeoutMs });
    await page.getByRole('menu', { name: 'Block actions' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
    await page.locator('[role="menuitemradio"]').first().waitFor({ state: 'visible', timeout: options.timeoutMs });
    await assertBlockMenuContract(page, variant, 'turn');
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-turn-into.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} block actions visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openPage(page, baseUrl, target) {
  await page.goto(resolveUrl(baseUrl, `/p/${target.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, target.title);
  await blockGroup(page, target.blockId).waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function openBlockActionMenu(page, blockId, { focusBlockFirst = false } = {}) {
  const group = blockGroup(page, blockId);
  await group.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  if (focusBlockFirst) {
    await group.getByRole('textbox', { name: 'Text block text' }).click({ timeout: options.timeoutMs });
  }
  await group.hover({ timeout: options.timeoutMs });
  const button = group.getByRole('button', { name: 'Open block actions' });
  await button.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await button.click({ timeout: options.timeoutMs });
  await page.getByRole('menu', { name: 'Block actions' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertBlockMenuContract(page, variant, panel) {
  const metrics = await page.evaluate(({ blockId }) => {
    const menu = document.querySelector('[role="menu"][aria-label="Block actions"]');
    const block = document.querySelector(`[data-block-id="${blockId}"]`);
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    if (!(menu instanceof HTMLElement) || !(block instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      return { ok: false, reason: 'missing block actions menu, block, or page body' };
    }
    const rect = menu.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const blockBody = block.querySelector('[class*="blockBody"]');
    const gutter = block.querySelector('[data-menu-open="true"]');
    const blockBodyBackground = blockBody instanceof HTMLElement
      ? window.getComputedStyle(blockBody).backgroundColor
      : '';
    const gutterRect = gutter instanceof HTMLElement ? gutter.getBoundingClientRect() : null;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter(
      (item) => item instanceof HTMLElement,
    );
    const itemRects = items.map((item) => {
      const rect = item.getBoundingClientRect();
      const icon = item.querySelector('svg, [class*="turnGlyph"]');
      const iconRect = icon instanceof SVGElement ? icon.getBoundingClientRect() : null;
      const glyphRect = icon instanceof HTMLElement ? icon.getBoundingClientRect() : iconRect;
      const spans = Array.from(item.querySelectorAll('span')).filter((span) => span instanceof HTMLElement);
      const label = item.getAttribute('role') === 'menuitemradio'
        ? (spans.at(-1) ?? null)
        : (spans[0] ?? null);
      const labelRect = label instanceof HTMLElement ? label.getBoundingClientRect() : null;
      return {
        height: rect.height,
        iconHeight: glyphRect?.height ?? 0,
        iconWidth: glyphRect?.width ?? 0,
        labelLeft: labelRect?.left ?? null,
        textOverflow: item.scrollWidth > item.clientWidth + 2,
      };
    });
    return {
      ok: true,
      blockBottom: blockRect.bottom,
      blockBodyBlueFill: isBlueTintedFill(blockBodyBackground),
      blockBodyBackground,
      blockLeft: blockRect.left,
      blockTop: blockRect.top,
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      bodyScrollWidth: document.body.scrollWidth,
      bottomGap: window.innerHeight - rect.bottom,
      documentScrollWidth: document.documentElement.scrollWidth,
      gutterHeight: gutterRect?.height ?? 0,
      gutterLeft: gutterRect?.left ?? null,
      gutterTop: gutterRect?.top ?? null,
      gutterWidth: gutterRect?.width ?? 0,
      height: rect.height,
      itemCount: items.length,
      itemMaxHeight: Math.max(...itemRects.map((item) => item.height), 0),
      itemMinHeight: Math.min(...itemRects.map((item) => item.height), 999),
      itemRects,
      left: rect.left,
      rightGap: window.innerWidth - rect.right,
      selectedTextLength: String(window.getSelection()?.toString() ?? '').length,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };

    function isBlueTintedFill(color) {
      const match = String(color).match(/rgba?\(([^)]+)\)/);
      if (!match) return false;
      const [red = 0, green = 0, blue = 0, alpha = 1] = match[1]
        .split(',')
        .map((part) => Number.parseFloat(part.trim()));
      if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return false;
      const opacity = Number.isFinite(alpha) ? alpha : 1;
      return opacity > 0.03 && blue > red + 24 && blue > green + 8;
    }
  }, { blockId: variant.target.blockId });

  assert(metrics.ok, metrics.reason ?? 'block actions visual contract could not run');
  assert(metrics.itemCount >= (panel === 'turn' ? 20 : 8), `Block ${panel} menu should expose enough actions, got ${metrics.itemCount}`);
  assert(metrics.itemMinHeight >= 28 && metrics.itemMaxHeight <= 36, `Block menu rows should stay compact, got ${metrics.itemMinHeight}-${metrics.itemMaxHeight}px`);
  assert(metrics.top >= 8, `Block menu should stay inside viewport top, got ${Math.round(metrics.top)}px`);
  assert(metrics.bottomGap >= 8, `Block menu should stay inside viewport bottom, got gap=${Math.round(metrics.bottomGap)}px`);
  if (panel === 'main') {
    assert(metrics.top >= metrics.blockBottom - 2, `Block main menu should open below the active block row instead of covering text: ${JSON.stringify(metrics)}`);
  }
  assert(!metrics.blockBodyBlueFill, `Block ${panel} menu should not leave a blue selected-block fill behind the menu: ${JSON.stringify(metrics)}`);
  assert(metrics.selectedTextLength === 0, `Block ${panel} menu should not leave native text selected behind the menu, got ${metrics.selectedTextLength} characters`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `Block menu should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.gutterLeft !== null, 'Block menu should keep the block gutter mounted while open.');

  for (const row of metrics.itemRects.slice(0, 8)) {
    const minIcon = 14;
    const maxIcon = panel === 'turn' ? 24 : 18;
    assert(row.iconWidth === 0 || (row.iconWidth >= minIcon && row.iconWidth <= maxIcon), `Block ${panel} menu icon width drifted: ${JSON.stringify(row)}`);
    assert(row.iconHeight === 0 || (row.iconHeight >= minIcon && row.iconHeight <= maxIcon), `Block ${panel} menu icon height drifted: ${JSON.stringify(row)}`);
    assert(row.labelLeft === null || row.labelLeft > metrics.left + 26, `Block menu label column is too close to the edge: ${JSON.stringify({ row, metrics })}`);
    assert(!row.textOverflow, `Block menu item text should not clip horizontally: ${JSON.stringify(row)}`);
  }

  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `Mobile block menu should run in a narrow viewport, got ${Math.round(metrics.viewportWidth)}px`);
    assert(metrics.width >= 220 && metrics.width <= metrics.viewportWidth - 16, `Mobile block menu should fit narrow viewport, got ${Math.round(metrics.width)}px`);
    assert(metrics.left >= 8 && metrics.rightGap >= 8, `Mobile block menu should keep viewport gutters, got left=${Math.round(metrics.left)} right=${Math.round(metrics.rightGap)}`);
    assert(metrics.gutterWidth <= 2 || metrics.gutterLeft <= metrics.blockLeft, `Mobile block gutter should not create a visible stray toolbar: ${JSON.stringify(metrics)}`);
    if (panel === 'turn') {
      assert(metrics.top >= metrics.blockBottom - 2, `Mobile turn-into menu should stay attached below the active block instead of covering the page title: ${JSON.stringify(metrics)}`);
      assert(metrics.height <= Math.min(430, metrics.viewportHeight * 0.58), `Mobile turn-into menu should be a compact scrollable panel, got ${Math.round(metrics.height)}px: ${JSON.stringify(metrics)}`);
    }
    return;
  }

  assert(metrics.width >= 232 && metrics.width <= 244, `Desktop block menu should be 238px-class, got ${Math.round(metrics.width)}px`);
  assert(metrics.left < metrics.blockLeft, `Desktop block menu should stay anchored to the block gutter, got menu left=${Math.round(metrics.left)} block left=${Math.round(metrics.blockLeft)}`);
  assert(metrics.left >= metrics.bodyLeft - 64, `Desktop block menu should not float far outside the document gutter: ${JSON.stringify(metrics)}`);
  assert(metrics.gutterWidth >= 42 && metrics.gutterWidth <= 48, `Desktop block gutter width drifted: ${JSON.stringify(metrics)}`);
  assert(Math.abs(metrics.gutterTop - metrics.blockTop) <= 6, `Desktop block gutter should align to the active block row: ${JSON.stringify(metrics)}`);
}

function blockGroup(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    (expected) => {
      const titleElement = document.querySelector('[role="textbox"][aria-label="Page title"]');
      if (!titleElement) return false;
      const text = titleElement instanceof HTMLElement ? titleElement.innerText : titleElement.textContent;
      return text?.trim() === expected;
    },
    title,
    { timeout: options.timeoutMs },
  );
}

async function seedBlockActionsPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for block actions visual smoke');

  const suffix = Date.now();
  const targets = {};
  const variants = ['desktop', 'desktopDark', 'mobile', 'mobileDark'];
  for (const [index, key] of variants.entries()) {
    const pageId = randomUUID();
    const blockId = randomUUID();
    const title = `Block actions ${String(suffix).slice(-6)} ${index + 1}`;
    const plainText = `Review the block action menu alignment ${index + 1}`;

    const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'create',
      id: pageId,
      workspaceId,
      parentId: null,
      parentType: 'workspace',
      kind: 'page',
      title,
      icon: '☰',
      iconType: 'emoji',
      cover: '',
      coverPosition: 50,
      position: suffix + index,
    });
    assert(created?.page?.id === pageId, 'block actions visual smoke page must be created');

    const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
      action: 'createMany',
      blocks: [{
        id: blockId,
        pageId,
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: plainText }] },
        plainText,
        position: 1,
      }],
    });
    assert(createdBlocks?.blocks?.length === 1, 'block actions visual smoke block must be created');
    targets[key] = { blockId, pageId, title };
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    targets,
    workspaceId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.targets) return;
  for (const target of Object.values(seed.targets)) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id: target.pageId,
    }).catch(() => {});
  }
}

async function seedSession(context, seed, theme = 'light') {
  await context.addInitScript(({ refreshToken, workspaceId, theme }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', theme);
  }, {
    refreshToken: seed.refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
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
    'Playwright is required for block actions visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
  console.log(`Usage: node scripts/block-actions-visual-smoke.mjs [options]

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
