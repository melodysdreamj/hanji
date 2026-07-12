#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'backlinks');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL backlinks visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Backlinks visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Backlinks visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedBacklinksWorkspace(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureBacklinksVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1280, height: 900 },
    });
    await captureBacklinksVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark',
      theme: 'dark',
      viewport: { width: 1280, height: 900 },
    });
    await captureBacklinksVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      viewport: { width: 390, height: 844 },
    });
    await captureBacklinksVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile-dark',
      theme: 'dark',
      viewport: { width: 390, height: 844 },
    });

    console.log('PASS backlinks and page mention surfaces stay within the Notion-style layout contract.');
    for (const name of ['desktop', 'desktop-dark', 'mobile', 'mobile-dark']) {
      console.log(`Collapsed screenshot: ${join(options.screenshotDir, `${name}-backlinks-collapsed.png`)}`);
      console.log(`Expanded screenshot: ${join(options.screenshotDir, `${name}-backlinks-expanded.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureBacklinksVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openTargetPage(page, appUrl, seed);
    await assertBacklinksContract(page, seed, { ...variant, expanded: false });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-backlinks-collapsed.png`),
      fullPage: false,
    });

    await page.getByRole('button', { name: `${seed.referenceCount} backlinks` }).click({
      timeout: options.timeoutMs,
    });
    await page.getByText('Linked mentions', { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await assertBacklinksContract(page, seed, { ...variant, expanded: true });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-backlinks-expanded.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} backlinks visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openTargetPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.targetPageId}`), {
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
  await expectPageTitle(page, seed.targetTitle);
  await page.getByRole('button', { name: `${seed.referenceCount} backlinks` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertBacklinksContract(page, seed, variant) {
  const metrics = await page.evaluate(({ referenceCount, expanded }) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        bottom: r.bottom,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        width: r.width,
      };
    };
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const toggle = Array.from(document.querySelectorAll('button')).find(
      (button) => button instanceof HTMLElement && button.textContent?.trim() === `${referenceCount} backlinks`,
    );
    const list = document.querySelector('[class*="backlinkList"]');
    const header = document.querySelector('[class*="backlinkListHeader"]');
    const items = Array.from(document.querySelectorAll('[class*="backlinkItem"]')).filter(
      (item) => item instanceof HTMLElement,
    );
    const more = document.querySelector('[class*="backlinkMore"]');
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    if (!(title instanceof HTMLElement) || !(toggle instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      return { ok: false, reason: 'missing title, backlink toggle, or page body' };
    }
    const itemMetrics = items.map((item) => {
      const icon = item.querySelector('[class*="backlinkIcon"]');
      const title = Array.from(item.querySelectorAll('[class*="backlinkTitle"]')).find(
        (element) => element instanceof HTMLElement && !String(element.className).includes('backlinkTitleRow'),
      );
      const kind = item.querySelector('[class*="backlinkKind"]');
      const preview = item.querySelector('[class*="backlinkPreview"]');
      const meta = item.querySelector('[class*="backlinkMeta"]');
      const itemRect = rect(item);
      return {
        height: itemRect.height,
        icon: icon instanceof HTMLElement ? rect(icon) : null,
        item: itemRect,
        kind: kind instanceof HTMLElement ? rect(kind) : null,
        kindText: kind instanceof HTMLElement ? kind.textContent?.trim() ?? '' : '',
        meta: meta instanceof HTMLElement ? rect(meta) : null,
        preview: preview instanceof HTMLElement ? rect(preview) : null,
        previewText: preview instanceof HTMLElement ? preview.textContent?.trim() ?? '' : '',
        title: title instanceof HTMLElement ? rect(title) : null,
        titleText: title instanceof HTMLElement ? title.textContent?.trim() ?? '' : '',
      };
    });
    return {
      ok: true,
      body: rect(body),
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      expanded,
      header: header instanceof HTMLElement ? rect(header) : null,
      itemCount: itemMetrics.length,
      items: itemMetrics,
      list: list instanceof HTMLElement ? rect(list) : null,
      more: more instanceof HTMLElement ? rect(more) : null,
      moreText: more instanceof HTMLElement ? more.textContent?.trim() ?? '' : '',
      title: rect(title),
      toggle: rect(toggle),
      toggleExpanded: toggle.getAttribute('aria-expanded'),
      toggleText: toggle.textContent?.trim() ?? '',
      viewportWidth: window.innerWidth,
    };
  }, { referenceCount: seed.referenceCount, expanded: variant.expanded });

  assert(metrics.ok, metrics.reason ?? 'backlinks visual contract could not run');
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `backlinks fixture should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.toggleText === `${seed.referenceCount} backlinks`, `backlink count label drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.toggle.height >= 20 && metrics.toggle.height <= 28, `collapsed backlink toggle density drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.toggle.left >= metrics.title.left - 2, `backlink toggle should align with the title column: ${JSON.stringify(metrics)}`);
  assert(metrics.toggle.right <= metrics.body.right + 4, `backlink toggle should stay inside document body: ${JSON.stringify(metrics)}`);

  if (!variant.expanded) {
    assert(metrics.toggleExpanded === 'false', `collapsed backlink toggle should expose collapsed state: ${JSON.stringify(metrics)}`);
    assert(metrics.itemCount === 0, `collapsed backlinks should not render list rows: ${JSON.stringify(metrics)}`);
    assert(!metrics.list, `collapsed backlinks should not leave list chrome visible: ${JSON.stringify(metrics)}`);
    return;
  }

  assert(metrics.toggleExpanded === 'true', `expanded backlink toggle should expose expanded state: ${JSON.stringify(metrics)}`);
  assert(metrics.list, `expanded backlinks should render a list: ${JSON.stringify(metrics)}`);
  assert(metrics.header, `expanded backlinks should render a compact list header: ${JSON.stringify(metrics)}`);
  assert(metrics.itemCount === 12, `expanded backlinks should show first 12 rows before the more control: ${JSON.stringify(metrics)}`);
  assert(metrics.moreText === '2 more backlinks', `expanded backlinks should expose hidden count: ${JSON.stringify(metrics)}`);
  assert(metrics.list.left >= metrics.title.left - 2, `backlink list should align with title column: ${JSON.stringify(metrics)}`);
  assert(metrics.list.right <= metrics.body.right + 4, `backlink list should stay inside document body: ${JSON.stringify(metrics)}`);
  assert(metrics.header.height >= 18 && metrics.header.height <= 28, `backlink header density drifted: ${JSON.stringify(metrics)}`);

  const kinds = new Set(metrics.items.map((item) => item.kindText));
  assert(kinds.has('Mention') && kinds.has('Link'), `backlink rows should show both Mention and Link pills: ${JSON.stringify(metrics)}`);
  for (const item of metrics.items) {
    assert(item.height >= 46 && item.height <= 66, `backlink row density drifted: ${JSON.stringify(item)}`);
    assert(item.icon && item.icon.width >= 16 && item.icon.width <= 24, `backlink icon size drifted: ${JSON.stringify(item)}`);
    assert(item.title && item.preview && item.kind, `backlink row should expose title, preview, and kind: ${JSON.stringify(item)}`);
    assert(item.title.right <= item.kind.left - 2, `backlink title should not collide with the kind pill: ${JSON.stringify(item)}`);
    assert(item.preview.right <= item.item.right - 4, `backlink preview should stay inside row: ${JSON.stringify(item)}`);
    assert(item.kind.height >= 15 && item.kind.height <= 21, `backlink kind pill height drifted: ${JSON.stringify(item)}`);
    assert(item.kind.width <= 76, `backlink kind pill should stay compact: ${JSON.stringify(item)}`);
  }

  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `mobile backlinks contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.list.right <= metrics.viewportWidth - 8, `mobile backlink list should stay inside viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.toggle.right <= metrics.viewportWidth - 8, `mobile backlink toggle should stay inside viewport: ${JSON.stringify(metrics)}`);
    for (const item of metrics.items) {
      assert(item.item.left >= 20 && item.item.right <= metrics.viewportWidth - 8, `mobile backlink row should fit viewport: ${JSON.stringify(item)}`);
    }
  }
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

async function seedBacklinksWorkspace(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for backlinks visual smoke');

  const suffix = Date.now();
  const targetPageId = randomUUID();
  const parentPageId = randomUUID();
  const targetTitle = `Backlink target ${suffix}`;
  const parentTitle = `Reference sources ${suffix}`;
  const referenceCount = 14;

  const target = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: targetPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: targetTitle,
    icon: '🔗',
    iconType: 'emoji',
    position: suffix,
  });
  assert(target?.page?.id === targetPageId, 'backlinks target page must be created');

  const parent = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: parentPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: parentTitle,
    icon: '🧭',
    iconType: 'emoji',
    position: suffix + 1,
  });
  assert(parent?.page?.id === parentPageId, 'backlinks source parent page must be created');

  const sourcePages = [];
  const blocks = [];
  for (let index = 0; index < referenceCount; index += 1) {
    const pageId = randomUUID();
    const blockId = randomUUID();
    const isMention = index < 8;
    const title = `${isMention ? 'Mention' : 'Link'} source ${index + 1} with a deliberately long title ${suffix}`;
    const preview = isMention
      ? `Mention source ${index + 1} points to ${targetTitle} with enough surrounding text to test truncation.`
      : `Link source ${index + 1} stores a page link to ${targetTitle} with a long preview.`;
    const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'create',
      id: pageId,
      workspaceId,
      parentId: parentPageId,
      parentType: 'page',
      kind: 'page',
      title,
      icon: isMention ? '💬' : '🔖',
      iconType: 'emoji',
      position: index + 1,
    });
    assert(created?.page?.id === pageId, `backlinks source page ${index + 1} must be created`);
    sourcePages.push(pageId);
    blocks.push({
      id: blockId,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: {
        rich: isMention
          ? [
              { text: `${preview} ` },
              { text: targetTitle, mention: 'page', pageId: targetPageId },
              { text: ' as a page mention.' },
            ]
          : [
              { text: `${preview} ` },
              { text: targetTitle, link: `/p/${targetPageId}` },
              { text: ' as a link.' },
            ],
      },
      plainText: `${preview} ${targetTitle} as a ${isMention ? 'page mention' : 'link'}.`,
      position: 1,
    });
  }

  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(createdBlocks?.blocks?.length === blocks.length, 'backlink source blocks must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    targetPageId,
    targetTitle,
    parentPageId,
    sourcePages,
    referenceCount,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  for (const pageId of [...(seed.sourcePages ?? []), seed.parentPageId, seed.targetPageId]) {
    if (!pageId) continue;
    await permanentlyDeletePage(baseUrl, seed.accessToken, pageId, { call: callFunction }).catch(() => {});
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
    'Playwright is required for backlinks visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: null,
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
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a number >= 1000');
      }
      i += 1;
      continue;
    }
    if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(resolveValue(args, i, arg));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.screenshotDir = resolve(parsed.screenshotDir);
  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/backlinks-visual-smoke.mjs [options]

Seeds a target page plus mention/link source pages, then captures collapsed and
expanded backlinks in desktop/mobile and light/dark themes. The contract checks
compact count chrome, row density, Mention/Link pills, preview/meta truncation,
hidden-count rows, and viewport containment.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         API/runtime URL for seeding. Defaults to --url.
  --screenshot-dir <path> Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
