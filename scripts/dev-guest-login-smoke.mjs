#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchBrowserErrors } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'dev-guest-login');
const NON_LOCAL_TEST_HOST = 'notionlike-nonlocal.test';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL dev guest login smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Dev guest login smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Dev guest login smoke API target: ${apiUrl}`);

  assertLocalAppUrl(appUrl);
  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);
  const cleanupSeeds = [];

  try {
    cleanupSeeds.push(await assertDevGuestLogin(browser, appUrl, apiUrl, 'light'));
    cleanupSeeds.push(await assertDevGuestLogin(browser, appUrl, apiUrl, 'dark'));
    await assertDevGuestHiddenOnNonLocalHost(browser, appUrl);
    console.log('PASS dev guest login button is available and enters the workspace shell.');
    console.log(`Auth screenshot: ${join(options.screenshotDir, 'desktop-auth-dev-guest.png')}`);
    console.log(`Workspace screenshot: ${join(options.screenshotDir, 'desktop-dev-guest-workspace.png')}`);
    console.log(`Dark auth screenshot: ${join(options.screenshotDir, 'desktop-auth-dev-guest-dark.png')}`);
    console.log(`Dark workspace screenshot: ${join(options.screenshotDir, 'desktop-dev-guest-workspace-dark.png')}`);
    console.log(`Non-local host screenshot: ${join(options.screenshotDir, 'desktop-auth-dev-guest-hidden-nonlocal.png')}`);
  } finally {
    for (const seed of cleanupSeeds) {
      await cleanupSeed(apiUrl, seed).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

async function assertDevGuestLogin(browser, baseUrl, apiUrl, theme) {
  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(browser, {
    viewport: { width: 1100, height: 850 },
    deviceScaleFactor: 1,
  });

  try {
    await page.addInitScript((pref) => {
      window.localStorage.setItem('notionlike:theme', pref);
    }, theme);

    await page.goto(resolveUrl(baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });

    await page.getByRole('heading', { name: 'Hanji' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    const guestButton = page.getByRole('button', { name: 'Continue as guest' });
    try {
      await guestButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
    } catch {
      // The email/password form is the always-present auth surface (the
      // "Send code" OTP button was removed from AuthGate in 0960bdfa).
      const hasEmailAuth = await page.locator('#auth-password-email').count();
      throw new Error(
        hasEmailAuth
          ? 'Continue as guest is missing. Rebuild the SPA with VITE_ALLOW_ANONYMOUS_BOOTSTRAP=true, run EdgeBase dev with NOTIONLIKE_ALLOW_DEV_GUEST_LOGIN=true, and refresh the EdgeBase dev runtime.'
          : 'AuthGate did not render the expected development guest login surface.',
      );
    }
    await endInitialSignedOutRefreshWindow();

    await assertAuthButtonContract(page, guestButton);
    await page.screenshot({
      path: join(
        options.screenshotDir,
        theme === 'dark' ? 'desktop-auth-dev-guest-dark.png' : 'desktop-auth-dev-guest.png',
      ),
      fullPage: false,
    });

    await guestButton.click({ timeout: options.timeoutMs });
    await expectWorkspaceLoaded(page);
    await page.screenshot({
      path: join(
        options.screenshotDir,
        theme === 'dark' ? 'desktop-dev-guest-workspace-dark.png' : 'desktop-dev-guest-workspace.png',
      ),
      fullPage: false,
    });

    const cleanupSeed = await readCleanupSeed(context, page, baseUrl);
    assertNoBrowserErrors(errors, `${theme} dev guest login`);
    await cleanupSeedWorkspace(apiUrl, cleanupSeed);
    await assertGuestLogout(context, page, apiUrl, cleanupSeed, errors);
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertDevGuestHiddenOnNonLocalHost(browser, baseUrl) {
  const mappedUrl = nonLocalMappedUrl(baseUrl);
  if (!mappedUrl) return;

  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(browser, {
    viewport: { width: 1100, height: 850 },
    deviceScaleFactor: 1,
  });

  try {
    await page.goto(resolveUrl(mappedUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('heading', { name: 'Hanji' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    // The email/password form is the always-present auth surface (the
    // "Send code" OTP button was removed from AuthGate in 0960bdfa).
    await page.locator('#auth-password-email').waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await endInitialSignedOutRefreshWindow();
    const guestButtonCount = await page.getByRole('button', { name: 'Continue as guest' }).count();
    assert(
      guestButtonCount === 0,
      `dev guest login should be hidden on non-local host ${NON_LOCAL_TEST_HOST}, got ${guestButtonCount} button(s)`,
    );
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-auth-dev-guest-hidden-nonlocal.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'non-local dev guest hidden check');
  } finally {
    await context.close().catch(() => {});
  }
}

async function readCleanupSeed(context, page, baseUrl) {
  const browserState = await page.evaluate(async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-EdgeBase-Auth-Transport': 'cookie',
      },
      body: '{}',
    });
    const body = await response.json().catch(() => null);
    return {
      accessToken: body?.accessToken ?? '',
      exposedRefreshToken: Object.prototype.hasOwnProperty.call(body ?? {}, 'refreshToken'),
      localRefreshToken: window.localStorage.getItem('edgebase:refresh-token') ?? '',
      readableCookie: document.cookie,
      refreshStatus: response.status,
      workspaceId: window.localStorage.getItem('notionlike.workspaceId') ?? '',
    };
  });
  const cookies = await context.cookies(resolveUrl(baseUrl, '/api/auth/refresh'));
  const refreshCookie = cookies.find((cookie) =>
    cookie.name === 'notionlike-refresh' || cookie.name === '__Secure-notionlike-refresh'
  );
  assert(browserState.refreshStatus === 200, `cookie refresh returned HTTP ${browserState.refreshStatus}`);
  assert(browserState.accessToken, 'cookie refresh did not return a cleanup access token');
  assert(!browserState.exposedRefreshToken, 'cookie refresh exposed refreshToken in JSON');
  assert(!browserState.localRefreshToken, 'guest login retained refreshToken in localStorage');
  assert(refreshCookie?.httpOnly === true, 'guest login did not create an HttpOnly refresh cookie');
  assert(
    !browserState.readableCookie.includes(refreshCookie.name),
    'guest refresh cookie was visible to document.cookie',
  );
  return {
    ...browserState,
    refreshCookieHeader: `${refreshCookie.name}=${refreshCookie.value}`,
  };
}

async function assertGuestLogout(context, page, apiUrl, seed, errors) {
  const unauthorizedResponses = [];
  page.on('response', (response) => {
    if (response.status() === 401) unauthorizedResponses.push(response.url());
  });
  await page.getByRole('button', { name: 'Open workspace menu' }).click({ timeout: options.timeoutMs });
  const menu = page.getByRole('menu', { name: 'Workspace menu' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('menuitem', { name: 'Log out' }).click({ timeout: options.timeoutMs });

  await page.locator('#auth-password-email').waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForTimeout(100);
  assert(
    !(await page.locator('button[aria-label="Open workspace menu"]').isVisible().catch(() => false)),
    'private workspace UI remained visible after logout',
  );
  const browserState = await page.evaluate(() => ({
    credentialStorageEntries: Object.entries(window.localStorage).filter(([key, value]) =>
      /(?:refresh|access)[-_:\s]?token/i.test(key)
      || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
    ),
    cookieSessionMarker: window.localStorage.getItem('edgebase:cookie-session') ?? '',
    readableCookie: document.cookie,
  }));
  assert(
    browserState.credentialStorageEntries.length === 0,
    `logout retained a browser credential: ${JSON.stringify(browserState.credentialStorageEntries)}`,
  );
  assert(!browserState.cookieSessionMarker, 'logout retained the non-secret cookie session marker');
  const cookies = await context.cookies(resolveUrl(apiUrl, '/api/auth/refresh'));
  const authCookie = cookies.find((cookie) =>
    cookie.name === 'notionlike-refresh' || cookie.name === '__Secure-notionlike-refresh'
  );
  assert(!authCookie, 'logout did not clear the HttpOnly refresh cookie');
  assert(!browserState.readableCookie.includes('notionlike-refresh'), 'logout left a readable auth cookie');

  const expectedRefresh401s = unauthorizedResponses.filter((responseUrl) => {
    try {
      return new URL(responseUrl).pathname === '/api/auth/refresh';
    } catch {
      return false;
    }
  });
  const unexpected401s = unauthorizedResponses.filter((responseUrl) => !expectedRefresh401s.includes(responseUrl));
  assert(
    expectedRefresh401s.length === 1,
    `logout reload expected one auth refresh 401, got ${JSON.stringify(unauthorizedResponses)}`,
  );
  assert(unexpected401s.length === 0, `logout produced unexpected 401 responses: ${JSON.stringify(unexpected401s)}`);
  let generic401Allowance = expectedRefresh401s.length;
  const unexpectedErrors = errors.filter((message) => {
    if (
      (
        message === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)'
        || message.startsWith('Failed to load resource: the server responded with a status of 401 (Unauthorized) (')
      )
      && generic401Allowance > 0
    ) {
      generic401Allowance -= 1;
      return false;
    }
    return true;
  });
  assertNoBrowserErrors(unexpectedErrors, 'dev guest logout');

  const revoked = await fetch(resolveUrl(apiUrl, '/api/auth/refresh'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: seed.refreshCookieHeader,
      Origin: new URL(apiUrl).origin,
      'X-EdgeBase-Auth-Transport': 'cookie',
    },
    body: '{}',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  assert(revoked.status === 401, `revoked logout cookie refreshed with HTTP ${revoked.status}`);
}

async function cleanupSeedWorkspace(baseUrl, seed) {
  if (!seed?.accessToken) return;
  const listed = await callFunction(baseUrl, seed.accessToken, 'workspace-mutation', {
    action: 'list',
  }).catch(() => null);
  const workspaces = Array.isArray(listed?.workspaces) ? listed.workspaces : [];
  for (const workspace of workspaces) {
    if (!workspace?.id) continue;
    await callFunction(baseUrl, seed.accessToken, 'workspace-mutation', {
      action: 'deleteWorkspace',
      workspaceId: workspace.id,
    }).catch(() => {});
  }
}

async function cleanupSeed(baseUrl, seed) {
  return cleanupSeedWorkspace(baseUrl, seed);
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

async function assertAuthButtonContract(page, guestButton) {
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('main section');
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Continue as guest',
    );
    if (!(panel instanceof HTMLElement) || !(button instanceof HTMLElement)) {
      return { ok: false, reason: 'missing auth panel or guest button' };
    }
    const panelRect = panel.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      ok: true,
      buttonBottom: buttonRect.bottom,
      buttonHeight: buttonRect.height,
      buttonLeft: buttonRect.left,
      buttonRight: buttonRect.right,
      buttonText: button.textContent?.trim() ?? '',
      buttonWidth: buttonRect.width,
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
      viewportWidth: window.innerWidth,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'dev guest auth button metrics could not run');
  assert(metrics.buttonText === 'Continue as guest', 'dev guest button label should stay explicit.');
  assert(metrics.buttonHeight >= 34 && metrics.buttonHeight <= 42, `dev guest button height should match auth buttons, got ${Math.round(metrics.buttonHeight)}px`);
  assert(metrics.buttonLeft >= metrics.panelLeft - 1, 'dev guest button should stay within the auth panel left edge.');
  assert(metrics.buttonRight <= metrics.panelRight + 1, 'dev guest button should stay within the auth panel right edge.');

  await guestButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function expectWorkspaceLoaded(page) {
  await page.locator('button[aria-label="Open workspace menu"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const genericErrorCount = await page.getByText('Something went wrong.').count();
  assert(genericErrorCount === 0, 'dev guest login rendered the generic workspace error screen.');
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  const watcher = watchBrowserErrors(page, {
    errors,
    includeConsoleLocation: true,
    allowInitialSignedOutRefresh401: true,
  });
  return { context, page, ...watcher };
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

  throw new Error('Playwright is required for dev guest login smoke.');
}

async function launchBrowser(chromium) {
  const executablePath = resolveChromeExecutable();
  const args = [`--host-resolver-rules=MAP ${NON_LOCAL_TEST_HOST} 127.0.0.1`];
  const attempts = [
    { args, headless: !options.headed },
    ...(executablePath ? [{ args, headless: !options.headed, executablePath }] : []),
  ];
  let lastError;

  for (const launchOptions of attempts) {
    try {
      return await chromium.launch(launchOptions);
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }

  throw lastError;
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
  const packageCandidates = [];
  const packagesDir = join(edgebaseRoot, 'packages');
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir)) {
      packageCandidates.push(join(packagesDir, name, 'node_modules', 'playwright'));
    }
  }
  return [direct, ...pnpmCandidates, ...packageCandidates];
}

function resolveChromeExecutable() {
  const explicit = process.env.PLAYWRIGHT_CHROME_EXECUTABLE || process.env.CHROME_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  return '';
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headed: false,
    screenshotDir: DEFAULT_SCREENSHOT_DIR,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--url') parsed.url = args[++i] ?? parsed.url;
    else if (arg === '--api-url') parsed.apiUrl = args[++i] ?? parsed.apiUrl;
    else if (arg === '--timeout' || arg === '--timeout-ms') parsed.timeoutMs = Number(args[++i] ?? parsed.timeoutMs);
    else if (arg === '--screenshot-dir') parsed.screenshotDir = resolve(args[++i] ?? parsed.screenshotDir);
    else if (arg === '--headed') parsed.headed = true;
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) parsed.timeoutMs = DEFAULT_TIMEOUT_MS;
  return parsed;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, '');
}

function assertLocalAppUrl(url) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid app URL for dev guest login smoke: ${url}`);
  }
  assert(
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1',
    `dev guest login is a local-only bootstrap path; refusing to verify it against non-local host "${hostname}"`,
  );
}

function nonLocalMappedUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:') return '';
  parsed.hostname = NON_LOCAL_TEST_HOST;
  return parsed.toString().replace(/\/$/, '');
}

function resolveUrl(baseUrl, path) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
