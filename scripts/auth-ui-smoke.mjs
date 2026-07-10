#!/usr/bin/env node

import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchBrowserErrors } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'auth');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL auth UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  const suffix = Date.now();
  const seed = {
    email: `auth-smoke-${suffix}@example.com`,
    password: `AuthSmoke${suffix}!aA1`,
    displayName: `Auth Smoke ${suffix}`,
  };
  console.log(`Auth UI smoke target: ${appUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);

  try {
    await assertPasswordOnlySignInSurface(browser, appUrl, 'light');
    await assertPasswordOnlySignInSurface(browser, appUrl, 'dark');
    await assertPasswordSignup(browser, appUrl, seed);
    await assertPasswordSignin(browser, appUrl, seed);
    await enrollTotp(apiUrl, seed);
    await assertPasswordSigninWithMfa(browser, appUrl, seed);
    await assertPasswordSigninWithRecoveryCode(browser, appUrl, apiUrl, seed);
    console.log('PASS password-only AuthGate surface, password account creation, password sign-in, MFA challenge sign-in, and recovery-code MFA sign-in work through the AuthGate UI.');
    console.log(`Password-only auth screenshot: ${join(options.screenshotDir, passwordOnlyAuthScreenshotName('light'))}`);
    console.log(`Dark password-only auth screenshot: ${join(options.screenshotDir, passwordOnlyAuthScreenshotName('dark'))}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertPasswordOnlySignInSurface(browser, baseUrl, theme) {
  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(browser);
  try {
    await page.addInitScript((themePreference) => {
      window.localStorage.setItem('notionlike:theme', themePreference);
    }, theme);
    await page.goto(resolveUrl(baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await endInitialSignedOutRefreshWindow();
    await page.getByLabel('Password').waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.getByRole('button', { name: 'Continue', exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Create account' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
    for (const [label, locator] of [
      ['email-code tab', page.getByText('Email code', { exact: true })],
      ['send-code button', page.getByRole('button', { name: 'Send code' })],
      ['magic-link button', page.getByRole('button', { name: 'Send magic link' })],
      ['passkey button', page.getByRole('button', { name: 'Continue with passkey' })],
    ]) {
      assert(await locator.count() === 0, `${label} should be hidden on the password-only AuthGate surface.`);
    }
    await page.screenshot({
      path: join(options.screenshotDir, passwordOnlyAuthScreenshotName(theme)),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'password-only AuthGate surface');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertPasswordSignup(browser, baseUrl, seed) {
  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(browser);
  try {
    await seedStaleWorkspaceCache(page);
    await page.goto(resolveUrl(baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
    await endInitialSignedOutRefreshWindow();
    await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });
    await page.getByRole('textbox', { name: 'Name' }).fill(seed.displayName, { timeout: options.timeoutMs });
    await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
    await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });
    await expectAppLoaded(page);
    assertNoBrowserErrors(errors, 'password account creation');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertPasswordSignin(browser, baseUrl, seed) {
  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(browser);
  try {
    await seedStaleWorkspaceCache(page);
    await page.goto(resolveUrl(baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
    await endInitialSignedOutRefreshWindow();
    await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
    await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: options.timeoutMs });
    await expectAppLoaded(page);
    assertNoBrowserErrors(errors, 'password sign-in');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertPasswordSigninWithMfa(browser, baseUrl, seed) {
  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(browser);
  try {
    await seedStaleWorkspaceCache(page);
    await page.goto(resolveUrl(baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
    await endInitialSignedOutRefreshWindow();
    await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
    await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: options.timeoutMs });
    const code = await generateTotpCode(seed.mfaSecret);
    await page.getByRole('textbox', { name: 'Verification code' }).fill(code, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Verify code' }).click({ timeout: options.timeoutMs });
    await expectAppLoaded(page);
    assertNoBrowserErrors(errors, 'password MFA sign-in');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertPasswordSigninWithRecoveryCode(browser, baseUrl, apiUrl, seed) {
  const recoveryCode = seed.recoveryCodes?.[0];
  assert(recoveryCode, 'MFA enrollment did not return a recovery code for AuthGate recovery-code sign-in.');
  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(browser);
  try {
    await seedStaleWorkspaceCache(page);
    await page.goto(resolveUrl(baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
    await endInitialSignedOutRefreshWindow();
    await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
    await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: options.timeoutMs });
    await page.getByRole('textbox', { name: 'Verification code' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.getByRole('button', { name: 'Use recovery code' }).click({ timeout: options.timeoutMs });
    await page.getByRole('textbox', { name: 'Recovery code' }).fill(recoveryCode, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Verify code' }).click({ timeout: options.timeoutMs });
    await expectAppLoaded(page);
    assertNoBrowserErrors(errors, 'password MFA recovery-code sign-in');
  } finally {
    await context.close().catch(() => {});
  }
  await assertRecoveryCodeSingleUse(apiUrl, seed, recoveryCode);
}

async function expectAppLoaded(page) {
  await page.locator('button[aria-label="Open workspace menu"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function seedStaleWorkspaceCache(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('notionlike.workspaceId', 'auth-smoke-stale-workspace-id');
  });
}

async function cleanupSeed(baseUrl, seed) {
  const session = await signInWithPasswordAndMaybeMfa(baseUrl, seed).catch(() => null);
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

async function enrollTotp(baseUrl, seed) {
  const session = await signInWithPassword(baseUrl, seed.email, seed.password);
  assert(session?.accessToken, 'password sign-in before MFA enrollment did not return an access token.');
  const enrolled = await callAuth(baseUrl, session.accessToken, '/api/auth/mfa/totp/enroll', {});
  assert(typeof enrolled?.factorId === 'string', 'MFA enrollment did not return a factorId.');
  assert(typeof enrolled?.secret === 'string', 'MFA enrollment did not return a secret.');
  const code = await generateTotpCode(enrolled.secret);
  const verified = await callAuth(baseUrl, session.accessToken, '/api/auth/mfa/totp/verify', {
    factorId: enrolled.factorId,
    code,
  });
  assert(verified?.ok === true, 'MFA enrollment verification did not return ok.');
  seed.mfaSecret = enrolled.secret;
  seed.recoveryCodes = Array.isArray(enrolled.recoveryCodes) ? enrolled.recoveryCodes : [];
  assert(seed.recoveryCodes.length > 0, 'MFA enrollment did not return recovery codes.');
}

async function assertRecoveryCodeSingleUse(baseUrl, seed, recoveryCode) {
  const signin = await signInWithPassword(baseUrl, seed.email, seed.password);
  assert(signin?.mfaRequired === true, 'password sign-in should still require MFA after recovery-code sign-in.');
  assert(typeof signin.mfaTicket === 'string' && signin.mfaTicket, 'MFA-required sign-in did not return a ticket.');
  await expectAuthStatus(baseUrl, null, '/api/auth/mfa/recovery', {
    mfaTicket: signin.mfaTicket,
    recoveryCode,
  }, 401);
}

async function signInWithPasswordAndMaybeMfa(baseUrl, seed) {
  const signin = await signInWithPassword(baseUrl, seed.email, seed.password);
  if (signin?.accessToken || !signin?.mfaRequired) return signin;
  if (!seed.mfaSecret || !signin.mfaTicket) return null;
  return callAuth(baseUrl, null, '/api/auth/mfa/verify', {
    mfaTicket: signin.mfaTicket,
    code: await generateTotpCode(seed.mfaSecret),
  });
}

async function signInWithPassword(baseUrl, email, password) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.ok, `password cleanup sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
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

async function callAuth(baseUrl, token, path, body) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(resolveUrl(baseUrl, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function expectAuthStatus(baseUrl, token, path, body, expectedStatus) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(resolveUrl(baseUrl, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const json = await readJson(response);
  assert(
    response.status === expectedStatus,
    `${path} expected HTTP ${expectedStatus}, got HTTP ${response.status}: ${JSON.stringify(json)}`,
  );
  return json;
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const watcher = watchBrowserErrors(page, {
    errors,
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

  throw new Error('Playwright is required for auth UI smoke.');
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
    url: DEFAULT_BASE_URL,
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    screenshotDir: DEFAULT_SCREENSHOT_DIR,
    headed: false,
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
  parsed.screenshotDir = resolve(parsed.screenshotDir);
  return parsed;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, '');
}

function passwordOnlyAuthScreenshotName(theme) {
  return theme === 'dark' ? 'desktop-password-only-auth-dark.png' : 'desktop-password-only-auth.png';
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

async function generateTotpCode(secret) {
  const key = base32Decode(secret);
  const counter = Math.floor(Math.floor(Date.now() / 1000) / 30);
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter));
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const hmac = new Uint8Array(await webcrypto.subtle.sign('HMAC', cryptoKey, counterBytes));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function base32Decode(encoded) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = [];
  let bits = 0;
  let buffer = 0;
  for (const char of encoded.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    const value = chars.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
