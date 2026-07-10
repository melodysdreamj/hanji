#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'workspace-switcher');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL workspace switcher visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Workspace switcher visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Workspace switcher visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedWorkspaceSwitcher(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureWorkspaceSwitcherVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1440, height: 1000 },
    });
    await captureWorkspaceSwitcherVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      viewport: { width: 390, height: 844 },
    });

    console.log('PASS workspace switcher visuals are captured and stay within the Notion-style sidebar contract.');
    for (const name of ['desktop-menu', 'desktop-create-form', 'mobile-menu', 'mobile-create-form']) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await cleanupSeed(apiUrl, seed).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureWorkspaceSwitcherVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed);

  try {
    await openWorkspaceHome(page, appUrl, seed);
    if (variant.mobile) await openMobileSidebar(page);

    let menu = await openWorkspaceMenu(page);
    await waitForWorkspaceMenuState(menu, seed);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-menu.png`),
      fullPage: false,
    });
    await assertWorkspaceSwitcherContract(page, menu, seed, variant, 'workspace menu');

    await menu.getByRole('menuitem', { name: 'New workspace' }).click({ timeout: options.timeoutMs });
    const input = page.getByRole('textbox', { name: 'Workspace name' });
    await input.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await input.fill(seed.createDraftName, { timeout: options.timeoutMs });
    menu = page.getByRole('menu', { name: 'Workspace menu' });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-create-form.png`),
      fullPage: false,
    });
    await assertWorkspaceSwitcherContract(page, menu, seed, variant, 'workspace create form');
    assertNoBrowserErrors(errors, `${variant.prefix} workspace switcher visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openWorkspaceHome(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (expected) => {
      const button = document.querySelector('button[aria-label="Open workspace menu"]');
      return Boolean(button && button.textContent?.includes(expected));
    },
    seed.initialWorkspaceName,
    { timeout: options.timeoutMs },
  );
}

async function openMobileSidebar(page) {
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: options.timeoutMs });
  await sidebar.evaluate((el) => {
    if (!(el instanceof HTMLElement)) return false;
    return el.getAttribute('data-open') === 'true';
  });
  await page.waitForFunction(
    () => {
      const sidebar = document.querySelector('[aria-label="Sidebar"]');
      if (!(sidebar instanceof HTMLElement)) return false;
      const rect = sidebar.getBoundingClientRect();
      return sidebar.getAttribute('data-open') === 'true' && rect.left >= -1 && rect.right > 200;
    },
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function openWorkspaceMenu(page) {
  await page.getByRole('button', { name: 'Open workspace menu' }).click({ timeout: options.timeoutMs });
  const menu = page.getByRole('menu', { name: 'Workspace menu' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return menu;
}

async function waitForWorkspaceMenuState(menu, seed) {
  for (const text of [
    seed.initialWorkspaceName,
    seed.extraWorkspaceName,
    'Workspace',
    'New workspace',
    'Account console',
    'Templates',
    'Import',
    'Trash',
    'Switch to dark mode',
    'Log out',
  ]) {
    await menu.getByText(text, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
}

async function assertWorkspaceSwitcherContract(page, menu, seed, variant, label) {
  const metrics = await page.evaluate(
    ({ expectedVisibleTexts, label }) => {
      const sidebar = document.querySelector('[aria-label="Sidebar"]');
      const button = document.querySelector('button[aria-label="Open workspace menu"]');
      const menu = document.querySelector('[role="menu"][aria-label="Workspace menu"]');
      if (!(sidebar instanceof HTMLElement) || !(button instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
        return { ok: false, reason: `missing sidebar, button, or menu for ${label}` };
      }

      const sidebarRect = sidebar.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const workspaceIcon = button.querySelector('[class*="wsIcon"]');
      const workspaceName = button.querySelector('[class*="wsName"]');
      const actionRows = visibleElements(sidebar.querySelectorAll('[class*="actionRow"]'));
      const menuItems = visibleElements(menu.querySelectorAll('[class*="workspaceMenuItem"]'));
      const account = menu.querySelector('[class*="workspaceMenuAccount"]');
      const form = menu.querySelector('[class*="workspaceCreateForm"]');
      const input = menu.querySelector('input[aria-label="Workspace name"]');
      const controls = visibleElements(menu.querySelectorAll('button, input'));
      const clippedControls = controls
        .filter((item) => item.scrollWidth > item.clientWidth + 2)
        .map((item) => item.textContent?.trim().slice(0, 120) || item.getAttribute('aria-label') || item.tagName);
      const actionRects = actionRows.map((item) => item.getBoundingClientRect());
      const menuItemRects = menuItems.map((item) => item.getBoundingClientRect());
      const missingVisibleExpectedTexts = expectedVisibleTexts.filter((text) => !hasVisibleText(menu, text));
      return {
        ok: true,
        actionCount: actionRows.length,
        actionMaxHeight: Math.max(...actionRects.map((item) => item.height), 0),
        actionMinHeight: Math.min(...actionRects.map((item) => item.height), 999),
        accountHeight: account instanceof HTMLElement ? account.getBoundingClientRect().height : 0,
        buttonHeight: buttonRect.height,
        buttonLeft: buttonRect.left,
        buttonRightGap: window.innerWidth - buttonRect.right,
        clippedControls,
        formVisible: form instanceof HTMLElement && isVisible(form),
        inputHeight: input instanceof HTMLElement ? input.getBoundingClientRect().height : 0,
        inputValue: input instanceof HTMLInputElement ? input.value : '',
        menuBottom: menuRect.bottom,
        menuClientWidth: menu.clientWidth,
        menuItemCount: menuItems.length,
        menuItemMaxHeight: Math.max(...menuItemRects.map((item) => item.height), 0),
        menuItemMinHeight: Math.min(...menuItemRects.map((item) => item.height), 999),
        menuLeft: menuRect.left,
        menuRightGap: window.innerWidth - menuRect.right,
        menuScrollWidth: menu.scrollWidth,
        menuTop: menuRect.top,
        menuWidth: menuRect.width,
        missingVisibleExpectedTexts,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        sidebarWidth: sidebarRect.width,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        workspaceIconHeight: workspaceIcon instanceof HTMLElement ? workspaceIcon.getBoundingClientRect().height : 0,
        workspaceIconWidth: workspaceIcon instanceof HTMLElement ? workspaceIcon.getBoundingClientRect().width : 0,
        workspaceNameText: workspaceName?.textContent?.trim() ?? '',
      };

      function visibleElements(items) {
        return Array.from(items).filter((item) => item instanceof HTMLElement && isVisible(item));
      }

      function hasVisibleText(root, expected) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.nodeValue?.includes(expected)) continue;
          const parent = node.parentElement;
          if (parent instanceof HTMLElement && isVisible(parent)) return true;
        }
        return false;
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
    },
    {
      expectedVisibleTexts: expectedTextsFor(label, seed),
      label,
    },
  );

  assert(metrics.ok, metrics.reason ?? `${label} visual contract could not run`);
  assert(metrics.workspaceNameText.includes(seed.initialWorkspaceName), `${label} should keep the current workspace name in the sidebar header`);
  assert(metrics.buttonHeight >= 28 && metrics.buttonHeight <= 36, `${label} workspace button should stay compact, got ${Math.round(metrics.buttonHeight)}px`);
  assert(metrics.workspaceIconWidth >= 18 && metrics.workspaceIconWidth <= 24, `${label} workspace icon width should stay close to Notion sidebar scale, got ${Math.round(metrics.workspaceIconWidth)}px`);
  assert(metrics.workspaceIconHeight >= 18 && metrics.workspaceIconHeight <= 24, `${label} workspace icon height should stay close to Notion sidebar scale, got ${Math.round(metrics.workspaceIconHeight)}px`);
  assert(metrics.actionCount >= 3, `${label} should expose the top sidebar actions, got ${metrics.actionCount}`);
  assert(metrics.actionMinHeight >= 24 && metrics.actionMaxHeight <= 32, `${label} top sidebar actions should stay compact, got ${Math.round(metrics.actionMinHeight)}-${Math.round(metrics.actionMaxHeight)}px`);
  assert(metrics.menuItemCount >= (label.includes('create form') ? 6 : 8), `${label} should show workspace and command rows, got ${metrics.menuItemCount}`);
  assert(metrics.accountHeight >= 36 && metrics.accountHeight <= 54, `${label} account header should stay compact, got ${Math.round(metrics.accountHeight)}px`);
  assert(metrics.menuItemMinHeight >= 26 && metrics.menuItemMaxHeight <= 36, `${label} menu rows should stay compact, got ${Math.round(metrics.menuItemMinHeight)}-${Math.round(metrics.menuItemMaxHeight)}px`);
  assert(metrics.menuScrollWidth <= metrics.menuClientWidth + 2, `${label} should not horizontally scroll, got ${metrics.menuScrollWidth}/${metrics.menuClientWidth}`);
  assert(metrics.clippedControls.length === 0, `${label} controls should not clip: ${metrics.clippedControls.join(' | ')}`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${label} hides expected text: ${metrics.missingVisibleExpectedTexts.join(', ')}`);
  assert(metrics.menuBottom <= metrics.viewportHeight - 8, `${label} menu should stay inside viewport bottom, got ${Math.round(metrics.menuBottom)}px`);

  if (label.includes('create form')) {
    assert(metrics.formVisible, `${label} should show the workspace create form`);
    assert(metrics.inputValue === seed.createDraftName, `${label} should preserve the typed workspace draft name`);
    assert(metrics.inputHeight >= 28 && metrics.inputHeight <= 36, `${label} workspace name input should stay compact, got ${Math.round(metrics.inputHeight)}px`);
  }

  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `${label} mobile capture should be narrow, got ${Math.round(metrics.viewportWidth)}px`);
    assert(metrics.sidebarLeft >= -1 && metrics.sidebarRight <= metrics.viewportWidth - 72, `${label} mobile sidebar drawer should stay contained, got left=${Math.round(metrics.sidebarLeft)} right=${Math.round(metrics.sidebarRight)} viewport=${metrics.viewportWidth}`);
    const menuRight = metrics.viewportWidth - metrics.menuRightGap;
    const menuLeftInset = metrics.menuLeft - metrics.sidebarLeft;
    const menuRightInset = metrics.sidebarRight - menuRight;
    assert(
      menuLeftInset >= 6 &&
        menuLeftInset <= 14 &&
        menuRightInset >= 6 &&
        menuRightInset <= 18,
      `${label} mobile menu should stay anchored inside the drawer, got ${JSON.stringify({
        menuLeft: Math.round(metrics.menuLeft),
        menuLeftInset: Math.round(menuLeftInset),
        menuRight: Math.round(menuRight),
        menuRightGap: Math.round(metrics.menuRightGap),
        menuRightInset: Math.round(menuRightInset),
        sidebarLeft: Math.round(metrics.sidebarLeft),
        sidebarRight: Math.round(metrics.sidebarRight),
      })}`,
    );
  } else {
    assert(metrics.sidebarWidth >= 220 && metrics.sidebarWidth <= 300, `${label} desktop sidebar should keep Notion-like width, got ${Math.round(metrics.sidebarWidth)}px`);
    assert(metrics.menuWidth >= 220 && metrics.menuWidth <= 270, `${label} desktop workspace menu should stay compact, got ${Math.round(metrics.menuWidth)}px`);
    assert(metrics.menuLeft >= 6 && metrics.menuLeft <= 14, `${label} desktop menu should align to the sidebar gutter, got ${Math.round(metrics.menuLeft)}px`);
    assert(metrics.menuRightGap > metrics.viewportWidth - 320, `${label} desktop menu should stay in the left sidebar, got rightGap=${Math.round(metrics.menuRightGap)}px`);
  }

  await assertNoPageHorizontalOverflow(page, label);
}

function expectedTextsFor(label, seed) {
  const texts = [
    seed.initialWorkspaceName,
    seed.extraWorkspaceName,
    'Account console',
    'Templates',
    'Import',
    'Trash',
  ];
  if (label.includes('create form')) {
    texts.push('Create', 'Cancel');
  } else {
    texts.push('New workspace', 'Switch to dark mode', 'Log out');
  }
  return texts;
}

async function assertNoPageHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  const maxWidth = Math.max(metrics.bodyWidth, metrics.documentWidth);
  assert(
    maxWidth <= metrics.viewportWidth + 4,
    `${label} should not create page-level horizontal overflow, got ${Math.round(maxWidth)}px in ${Math.round(metrics.viewportWidth)}px viewport`,
  );
}

async function seedWorkspaceSwitcher(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  const initialWorkspaceName = bootstrap?.workspace?.name;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for workspace switcher visual smoke');
  assert(initialWorkspaceName, 'workspace-bootstrap must return a workspace name for workspace switcher visual smoke');

  const suffix = String(Date.now()).slice(-6);
  const extraWorkspaceName = `Ops knowledge workspace ${suffix}`;
  const extra = await callFunction(baseUrl, session.accessToken, 'workspace-mutation', {
    action: 'createWorkspace',
    name: extraWorkspaceName,
    icon: '📚',
  });
  const extraWorkspaceId = extra?.workspace?.id;
  assert(extraWorkspaceId, 'workspace switcher visual smoke must create a second workspace');

  return {
    accessToken: session.accessToken,
    createDraftName: `Review ${suffix}`,
    extraWorkspaceId,
    extraWorkspaceName,
    initialWorkspaceName,
    refreshToken: session.refreshToken,
    workspaceId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.extraWorkspaceId) return;
  await callFunction(baseUrl, seed.accessToken, 'workspace-mutation', {
    action: 'deleteWorkspace',
    workspaceId: seed.extraWorkspaceId,
  }).catch(() => {});
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', 'light');
  }, {
    refreshToken: seed.refreshToken,
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
    'Playwright is required for workspace switcher visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/workspace-switcher-visual-smoke.mjs [options]

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
