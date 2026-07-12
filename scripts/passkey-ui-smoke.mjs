#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePasswordAuthForm } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL passkey UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Passkey UI smoke target: ${appUrl}`);
  if (process.env.HANJI_ENABLE_PASSKEY_UI_SMOKE !== 'true') {
    console.log('SKIP passkey UI smoke because passkey UI is currently hidden.');
    return;
  }
  const suffix = Date.now();
  const seed = {
    email: `passkey-smoke-${suffix}@example.com`,
    password: `PasskeySmoke${suffix}!aA1`,
    displayName: `Passkey Smoke ${suffix}`,
  };

  await assertRuntimeReachable(apiUrl);
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);

  try {
    await assertPasskeyLifecycle(browser, appUrl, seed);
    console.log('PASS passkey registration, passkey sign-in, and passkey removal work through the browser UI with a virtual authenticator.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertPasskeyLifecycle(browser, appUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  const cdp = await context.newCDPSession(page);
  await installVirtualAuthenticator(cdp);

  try {
    await step(page, 'create password account', () => createPasswordAccount(page, appUrl, seed));
    await step(page, 'register passkey from Security settings', async () => {
      const dialog = await openSecuritySettings(page);
      await addPasskey(dialog);
    });
    await step(page, 'sign out after passkey registration', () => signOut(page));
    await step(page, 'sign in with passkey', () => signInWithPasskey(page, seed));
    await step(page, 'remove passkey from Security settings', async () => {
      const dialog = await openSecuritySettings(page);
      await removePasskey(dialog);
    });
    assertNoBrowserErrors(filterExpectedBrowserErrors(errors), 'passkey UI flow');
  } finally {
    await cdp.send('WebAuthn.disable').catch(() => {});
    await context.close().catch(() => {});
  }
}

async function installVirtualAuthenticator(cdp) {
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function createPasswordAccount(page, appUrl, seed) {
  await page.goto(resolveUrl(appUrl, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await clickPasswordTab(page);
  await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });
  await page.getByRole('textbox', { name: 'Name' }).fill(seed.displayName, { timeout: options.timeoutMs });
  await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
  await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Create account', exact: true }).click({ timeout: options.timeoutMs });
  await expectAppLoaded(page);
}

async function signInWithPasskey(page, seed) {
  await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Continue with passkey' }).click({ timeout: options.timeoutMs });
  await expectAppLoaded(page);
}

async function openSecuritySettings(page) {
  await page.getByRole('button', { name: 'Open workspace menu' }).click({ timeout: options.timeoutMs });
  await page.getByRole('menu', { name: 'Workspace menu' }).getByRole('menuitem', { name: 'Account console' }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.locator('[data-surface="account-console"]').first();
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Account security' }).click({ timeout: options.timeoutMs });
  await dialog.getByText('패스키', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function addPasskey(dialog) {
  await dialog.getByRole('button', { name: '패스키 추가' }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Passkey added.', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: '제거' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function removePasskey(dialog) {
  await dialog.getByRole('button', { name: '제거' }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Passkey removed.', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByText('등록된 패스키가 없습니다.', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function signOut(page) {
  await page.getByRole('button', { name: 'Open workspace menu' }).click({ timeout: options.timeoutMs });
  await page.getByRole('menu', { name: 'Workspace menu' }).getByRole('menuitem', { name: 'Log out' }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('button', { name: 'Continue with passkey' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function expectAppLoaded(page) {
  await page.locator('button[aria-label="Open workspace menu"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function clickPasswordTab(page) {
  try {
    await ensurePasswordAuthForm(page, options.timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Password auth form was not found. If the EdgeBase dev runtime was already running before the SPA was rebuilt, restart it or pass --url for the live Vite app and --api-url for EdgeBase. ${message}`,
    );
  }
}

async function cleanupSeed(baseUrl, seed) {
  const session = await signInWithPassword(baseUrl, seed.email, seed.password).catch(() => null);
  if (!session?.accessToken) return;
  const list = await callFunction(baseUrl, session.accessToken, 'workspace-mutation', {
    action: 'list',
  }).catch(() => null);
  const workspaces = Array.isArray(list?.workspaces) ? list.workspaces : [];
  for (const workspace of workspaces) {
    if (!workspace?.id) continue;
    await callFunction(baseUrl, session.accessToken, 'workspace-mutation', {
      action: 'deleteWorkspace',
      workspaceId: workspace.id,
    }).catch(() => {});
  }
}

async function step(page, label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let text = '';
    try {
      text = await page.locator('body').innerText({ timeout: 1000 });
    } catch {
      text = '';
    }
    const snippet = text ? `\nVisible text: ${text.slice(0, 700)}` : '';
    throw new Error(`${label}: ${message}\nURL: ${page.url()}${snippet}`);
  }
}

async function signInWithPassword(baseUrl, email, password) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.ok, `password sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
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

async function newCheckedPage(browser) {
  const context = await browser.newContext();
  // This smoke drives the AuthGate form directly; keep the dev runtime's
  // master auto-login (HANJI_MASTER_DEV_AUTOLOGIN) out of the way via
  // the shared escape flag.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('hanji:disable-master-autologin', '1');
    } catch {
      // Storage unavailable: the smoke will fail loudly on its form selector.
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

function filterExpectedBrowserErrors(errors) {
  return errors.filter((error) => {
    if (/Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i.test(error)) {
      return false;
    }
    return true;
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

  throw new Error('Playwright is required for passkey UI smoke.');
}

async function launchBrowser(chromium) {
  const executablePath = resolveChromeExecutable();
  const attempts = [
    { headless: !options.headed },
    ...(executablePath ? [{ headless: !options.headed, executablePath }] : []),
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
    url: passkeyCompatibleUrl(DEFAULT_BASE_URL),
    apiUrl: passkeyCompatibleUrl(process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headed: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--url') parsed.url = args[++i] ?? parsed.url;
    else if (arg === '--api-url') parsed.apiUrl = args[++i] ?? parsed.apiUrl;
    else if (arg === '--timeout') parsed.timeoutMs = Number(args[++i] ?? parsed.timeoutMs);
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number(args[++i] ?? parsed.timeoutMs);
    else if (arg === '--headed') parsed.headed = true;
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) parsed.timeoutMs = DEFAULT_TIMEOUT_MS;
  return parsed;
}

function passkeyCompatibleUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
      parsed.hostname = 'localhost';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    return url;
  }
  return url;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, '');
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
