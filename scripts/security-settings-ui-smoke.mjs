#!/usr/bin/env node

import { webcrypto } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteSmokeUserByEmail,
  deleteSmokeWorkspace,
  masterCredentials,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL security settings UI smoke: ${message}`);
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
    email: `security-settings-${suffix}@example.com`,
    password: `SecuritySettings${suffix}!aA1`,
    displayName: `Security Settings ${suffix}`,
  };
  console.log(`Security settings UI smoke target: ${appUrl}`);

  await assertRuntimeReachable(apiUrl);
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);

  let runError;
  try {
    await assertSecuritySettingsUi(browser, appUrl, apiUrl, seed);
    console.log('PASS settings Security identifies the current session, revokes other sessions, enrolls TOTP, regenerates recovery codes, lists sessions, and disables TOTP through the browser UI without screenshots.');
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    await browser.close().catch(() => {});
    try {
      await cleanupSeed(apiUrl, seed);
    } catch (cleanupError) {
      if (!runError) throw cleanupError;
      console.warn(`Security settings smoke cleanup also failed: ${errorMessage(cleanupError)}`);
    }
  }
}

async function assertSecuritySettingsUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  try {
    await step('create password account through AuthGate', () => createAccountThroughUi(page, appUrl, seed));
    // A signed-out boot fires one expected /api/auth/refresh 401 (cookie
    // session probe) before the form renders; only later 401s are failures.
    dismissExpectedBrowserError(errors, /status of 401 \(Unauthorized\)/);
    seed.controlSession = await step('create control auth session', () => signInWithPassword(apiUrl, seed.email, seed.password, {
      userAgent: `hanji-security-control/${Date.now()}`,
    }));
    seed.revokedSession = await step('create revokable auth session', () => signInWithPassword(apiUrl, seed.email, seed.password, {
      userAgent: `hanji-security-revoke-target/${Date.now()}`,
    }));
    const dialog = await step('open Security settings', () => openSecuritySettings(page));
    await step('load active sessions panel', () => assertSessionPanel(dialog, [
      seed.controlSession.userAgent,
      seed.revokedSession.userAgent,
    ]));
    await step('revoke other sessions from settings', () => revokeOtherSessionsFromSettings(dialog, [
      seed.controlSession,
      seed.revokedSession,
    ]));
    await step('verify other sessions cannot refresh', () => assertOtherSessionsRevoked(apiUrl, [
      seed.controlSession,
      seed.revokedSession,
    ]));
    const enrollment = await step('enroll TOTP from settings', () => enrollTotpThroughSettings(dialog, errors));
    seed.mfaSecret = enrollment.secret;
    seed.originalRecoveryCodes = enrollment.recoveryCodes;
    await step('verify factor is enabled through EdgeBase auth API', () => assertFactorState(apiUrl, seed, true));
    seed.regeneratedRecoveryCodes = await step('regenerate recovery codes from settings', () => regenerateRecoveryCodesThroughSettings(dialog, seed));
    await step('verify old recovery code is invalidated', () => assertRecoveryCodeRejected(apiUrl, seed, seed.originalRecoveryCodes[0]));
    await step('verify regenerated recovery code can sign in', () => assertRecoveryCodeAccepted(apiUrl, seed, seed.regeneratedRecoveryCodes[0]));
    await step('verify regenerated recovery code is single-use', () => assertRecoveryCodeConsumed(apiUrl, seed, seed.regeneratedRecoveryCodes[0]));
    await step('disable TOTP from settings', () => disableTotpThroughSettings(dialog, seed));
    await step('verify factor is disabled through EdgeBase auth API', () => assertFactorState(apiUrl, seed, false));
    assertNoBrowserErrors(errors, 'security settings UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function createAccountThroughUi(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });
  await page.getByRole('textbox', { name: 'Name' }).fill(seed.displayName, { timeout: options.timeoutMs });
  await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
  await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });
  await page.locator('button[aria-label="Open workspace menu"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openSecuritySettings(page) {
  await page.getByRole('button', { name: 'Open workspace menu' }).click({ timeout: options.timeoutMs });
  await page.getByRole('menu', { name: 'Workspace menu' }).getByRole('menuitem', { name: 'Account console' }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.locator('[data-surface="account-console"]').first();
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Account security' }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Two-step verification', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return dialog;
}

async function assertSessionPanel(dialog, targetUserAgents) {
  await dialog.getByText('Active sessions', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText(/Review the browser sessions connected to this account\./).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText('Current session', { exact: false }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByText('Current', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  for (const targetUserAgent of targetUserAgents) {
    await dialog.getByText(targetUserAgent, { exact: false }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  await dialog.getByRole('button', { name: 'Revoke other sessions' }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  const revokeButtons = await dialog.getByRole('button', { name: 'Revoke' }).count();
  assert(revokeButtons >= 2, `expected at least two revokable sessions, got ${revokeButtons}`);
  await assertNoSecurityNotice(dialog, 'Could not load account security');
}

async function revokeOtherSessionsFromSettings(dialog, sessions) {
  await dialog.getByRole('button', { name: 'Revoke other sessions' }).click({ timeout: options.timeoutMs });
  await dialog.getByText(`Revoked ${sessions.length} other sessions.`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  for (const session of sessions) {
    await expectGone(dialog.getByText(session.userAgent, { exact: false }), `revoked other session row ${session.userAgent}`);
  }
}

async function enrollTotpThroughSettings(dialog, browserErrors) {
  await dialog.getByRole('button', { name: 'Turn on two-step verification' }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByText('Scan the QR code in your authenticator app', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('img', { name: 'Two-step verification QR code to scan with Google Authenticator' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText("Can't scan the QR code?", { exact: true }).click({ timeout: options.timeoutMs });
  const secretInput = dialog.getByLabel('Authenticator secret');
  await secretInput.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const secret = await secretInput.inputValue({ timeout: options.timeoutMs });
  assert(secret, 'TOTP enrollment did not expose an authenticator secret.');
  await dialog.getByText('Advanced: view the setup URI', { exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByLabel('Authenticator setup URI').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const code = await generateTotpCode(secret);
  const wrongCode = code === '000000' ? '000001' : '000000';
  await dialog.getByLabel('Setup verification code').fill(wrongCode, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Apply verification', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByText('That authenticator code is incorrect. Check the newest 6-digit code in your app and try again.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  dismissExpectedBrowserError(browserErrors, /status of 400 \(Bad Request\)/);
  await dialog.getByLabel('Setup verification code').fill(code, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Apply verification', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Two-step verification is on. Save your recovery codes.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText('Recovery codes', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText('An authenticator app code is required after password sign-in.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const recoveryCodes = await getVisibleRecoveryCodes(dialog);
  assert(recoveryCodes.length > 0, 'TOTP setup did not display recovery codes.');
  return { secret, recoveryCodes };
}

async function regenerateRecoveryCodesThroughSettings(dialog, seed) {
  await dialog.getByLabel('Recovery code regeneration confirmation').fill(seed.password, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Regenerate codes' }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Recovery codes regenerated.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const recoveryCodes = await getVisibleRecoveryCodes(dialog);
  assert(recoveryCodes.length > 0, 'Regenerating recovery codes did not display new recovery codes.');
  assert(
    !seed.originalRecoveryCodes?.includes(recoveryCodes[0]),
    'Regenerated recovery codes should not reuse the previous first recovery code.',
  );
  return recoveryCodes;
}

async function disableTotpThroughSettings(dialog, seed) {
  await dialog.getByLabel('Authenticator code or password').fill(seed.password, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Turn off two-step verification' }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Two-step verification is off.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText('Add an authenticator app code to protect password sign-in.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertFactorState(baseUrl, seed, expectedEnabled) {
  const session = await signInWithPasswordAndMaybeMfa(baseUrl, seed);
  assert(session?.accessToken, 'password sign-in for factor check did not return an access token.');
  const result = await callAuth(baseUrl, session.accessToken, 'GET', '/api/auth/mfa/factors');
  const factors = Array.isArray(result?.factors) ? result.factors : [];
  const enabled = factors.some((factor) => factor?.type === 'totp' && factor?.verified !== false);
  assert(
    enabled === expectedEnabled,
    `expected TOTP enabled=${expectedEnabled}, got enabled=${enabled} from ${JSON.stringify(factors)}`,
  );
}

async function assertOtherSessionsRevoked(baseUrl, sessions) {
  for (const session of sessions) {
    await expectAuthStatus(baseUrl, null, 'POST', '/api/auth/refresh', {
      refreshToken: session.refreshToken,
    }, 401);
  }
}

async function assertRecoveryCodeRejected(baseUrl, seed, recoveryCode) {
  assert(recoveryCode, 'missing old recovery code to reject.');
  const signin = await signInWithPassword(baseUrl, seed.email, seed.password);
  assert(signin?.mfaRequired === true && signin.mfaTicket, 'password sign-in should require MFA before rejecting an old recovery code.');
  await expectAuthStatus(baseUrl, null, 'POST', '/api/auth/mfa/recovery', {
    mfaTicket: signin.mfaTicket,
    recoveryCode,
  }, 401);
}

async function assertRecoveryCodeAccepted(baseUrl, seed, recoveryCode) {
  assert(recoveryCode, 'missing regenerated recovery code to accept.');
  const signin = await signInWithPassword(baseUrl, seed.email, seed.password);
  assert(signin?.mfaRequired === true && signin.mfaTicket, 'password sign-in should require MFA before accepting a regenerated recovery code.');
  const result = await callAuth(baseUrl, null, 'POST', '/api/auth/mfa/recovery', {
    mfaTicket: signin.mfaTicket,
    recoveryCode,
  });
  assert(result?.accessToken, 'regenerated recovery code did not create an authenticated session.');
}

async function assertRecoveryCodeConsumed(baseUrl, seed, recoveryCode) {
  assert(recoveryCode, 'missing regenerated recovery code to verify consumption.');
  const signin = await signInWithPassword(baseUrl, seed.email, seed.password);
  assert(signin?.mfaRequired === true && signin.mfaTicket, 'password sign-in should require MFA before rejecting a consumed recovery code.');
  await expectAuthStatus(baseUrl, null, 'POST', '/api/auth/mfa/recovery', {
    mfaTicket: signin.mfaTicket,
    recoveryCode,
  }, 401);
}

async function getVisibleRecoveryCodes(dialog) {
  const text = await dialog.locator('code').last().textContent({ timeout: options.timeoutMs });
  return (text ?? "")
    .split(/\s+/)
    .map((code) => code.trim())
    .filter(Boolean);
}

async function cleanupSeed(baseUrl, seed) {
  const failures = [];
  try {
    const session = await signInWithPasswordAndMaybeMfa(baseUrl, seed).catch(() => null);
    if (session?.accessToken) {
      const list = await callFunction(baseUrl, session.accessToken, 'workspace-mutation', { action: 'list' });
      for (const workspace of Array.isArray(list?.workspaces) ? list.workspaces : []) {
        if (workspace?.id && workspace?.name) {
          await deleteSmokeWorkspace(baseUrl, session.accessToken, workspace, { call: callFunction });
        }
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const master = masterCredentials();
    const admin = await signInWithPassword(baseUrl, master.email, master.password);
    assert(admin?.accessToken, 'master cleanup sign-in did not return an access token.');
    await deleteSmokeUserByEmail(baseUrl, admin.accessToken, seed.email, { call: callFunction });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Security settings smoke did not fully clean up its synthetic account.');
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function signInWithPasswordAndMaybeMfa(baseUrl, seed) {
  const signin = await signInWithPassword(baseUrl, seed.email, seed.password);
  if (signin?.accessToken || !signin?.mfaRequired) return signin;
  if (!seed.mfaSecret || !signin.mfaTicket) return null;
  return callAuth(baseUrl, null, 'POST', '/api/auth/mfa/verify', {
    mfaTicket: signin.mfaTicket,
    code: await generateTotpCode(seed.mfaSecret),
  });
}

async function signInWithPassword(baseUrl, email, password, requestOptions = {}) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signin'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(requestOptions.userAgent ? { 'User-Agent': requestOptions.userAgent } : {}),
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.ok, `password sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return {
    ...body,
    userAgent: requestOptions.userAgent,
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

async function callAuth(baseUrl, token, method, path, body) {
  const headers = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(resolveUrl(baseUrl, path), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function expectAuthStatus(baseUrl, token, method, path, body, status) {
  const headers = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(resolveUrl(baseUrl, path), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(`${path} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
}

async function assertNoSecurityNotice(dialog, text) {
  const count = await dialog.getByText(text).count();
  assert(count === 0, `unexpected security notice: ${text}`);
}

async function expectGone(locator, label) {
  try {
    await locator.waitFor({ state: 'detached', timeout: options.timeoutMs });
  } catch {
    const count = await locator.count();
    assert(count === 0, `${label} should be gone, but ${count} match(es) remain`);
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

function dismissExpectedBrowserError(errors, pattern) {
  const index = errors.findIndex((message) => pattern.test(message));
  if (index >= 0) errors.splice(index, 1);
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

  throw new Error('Playwright is required for security settings UI smoke.');
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
    apiUrl: process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headed: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--url') parsed.url = args[++i] ?? parsed.url;
    else if (arg === '--api-url') parsed.apiUrl = args[++i] ?? parsed.apiUrl;
    else if (arg === '--timeout' || arg === '--timeout-ms') parsed.timeoutMs = Number(args[++i] ?? parsed.timeoutMs);
    else if (arg === '--headed') parsed.headed = true;
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) parsed.timeoutMs = DEFAULT_TIMEOUT_MS;
  return parsed;
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
