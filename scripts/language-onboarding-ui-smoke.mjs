#!/usr/bin/env node
// Authenticated account-language onboarding visual/runtime smoke. Creates one
// synthetic account through the local EdgeBase service-key admin API, verifies
// browser recommendation + durable account-state, then removes its workspace
// and account. No existing user preference or workspace is touched.
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assert,
  assertRuntimeReachable,
  deleteSmokeWorkspace,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  readJson,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
} from './lib/harness.mjs';

const BASE = normalizeBaseUrl(process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787');
const TIMEOUT_MS = Number(process.env.HANJI_SMOKE_TIMEOUT_MS ?? 30_000);
const SCREENSHOT_DIR = resolve('.edgebase', 'smoke', 'language-onboarding');
setDefaultTimeoutMs(TIMEOUT_MS);

function devServiceKey() {
  if (process.env.SERVICE_KEY?.trim()) return process.env.SERVICE_KEY.trim();
  const raw = readFileSync(new URL('../backend/.dev.vars', import.meta.url), 'utf8');
  return raw.split('\n').find((line) => line.startsWith('SERVICE_KEY='))?.slice('SERVICE_KEY='.length).trim() ?? '';
}

async function request(path, { body, method = 'POST', token, serviceKey } = {}) {
  const response = await fetch(resolveUrl(BASE, path), {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(serviceKey ? { 'X-EdgeBase-Service-Key': serviceKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await readJson(response);
  return { response, json };
}

async function main() {
  await assertRuntimeReachable(BASE);
  const serviceKey = devServiceKey();
  assert(serviceKey, 'SERVICE_KEY is required for isolated synthetic account setup.');
  const suffix = Date.now();
  const email = `language-onboarding-${suffix}@example.com`;
  const password = `LanguageOnboarding!${suffix}aA1`;
  let userId = '';
  let token = '';
  let runError = null;

  try {
    const created = await request('/api/auth/admin/users', {
      serviceKey,
      body: { email, password, displayName: `Language Onboarding ${suffix}` },
    });
    assert(created.response.status === 201, `admin create user expected 201, got ${created.response.status}`);
    userId = created.json?.user?.id ?? created.json?.id ?? '';
    assert(userId, 'admin create user returned no user id');

    const signedIn = await request('/api/auth/signin', { body: { email, password } });
    assert(signedIn.response.ok, `synthetic account sign-in returned HTTP ${signedIn.response.status}`);
    token = signedIn.json?.accessToken ?? signedIn.json?.session?.accessToken ?? '';
    assert(token, 'synthetic account sign-in returned no access token');
    const initialState = await request('/api/functions/account-state', {
      token,
      body: { action: 'get' },
    });
    assert(initialState.json?.languageOnboardingCompleted !== true, 'new account must begin without language completion');

    const { chromium } = await loadPlaywright({ label: 'language onboarding visual smoke' });
    const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
    try {
      const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(
        browser,
        {
          colorScheme: 'light',
          locale: 'en-US',
          viewport: { width: 1280, height: 800 },
        },
        { allowInitialSignedOutRefresh401: true },
      );
      await page.goto(resolveUrl(BASE, '/'), { waitUntil: 'domcontentloaded' });
      await endInitialSignedOutRefreshWindow();
      await page.getByRole('textbox', { name: 'Email' }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: TIMEOUT_MS });

      const onboarding = page.locator('[data-testid="language-onboarding"]');
      await onboarding.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
      const selector = onboarding.getByLabel('Language');
      assert(await selector.locator('option').count() === 59, 'onboarding must expose system + 58 languages');
      assert(await selector.locator('option').first().getAttribute('value') === 'en', 'en-US must be recommended first');
      assert((await selector.locator('option').first().textContent())?.includes('Recommended'), 'first option must show recommendation');
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'language-onboarding.png'), fullPage: true });

      await onboarding.getByRole('button', { name: 'Continue' }).click({ timeout: TIMEOUT_MS });
      await page.locator('button[aria-label="Open workspace menu"]').waitFor({ state: 'visible', timeout: TIMEOUT_MS });

      const savedState = await request('/api/functions/account-state', {
        token,
        body: { action: 'get' },
      });
      assert(savedState.json?.languageOnboardingCompleted === true, 'server must store onboarding completion');
      assert(savedState.json?.languagePreference === 'en', 'server must store the recommended language choice');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('button[aria-label="Open workspace menu"]').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
      assert(await page.locator('[data-testid="language-onboarding"]').count() === 0, 'saved onboarding must not repeat');
      assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
      await context.close();
    } finally {
      await browser.close().catch(() => {});
    }

    console.log('PASS authenticated language onboarding recommends the browser locale, persists once, and exposes all 58 languages.');
    console.log(`Screenshot: ${resolve(SCREENSHOT_DIR, 'language-onboarding.png')}`);
  } catch (error) {
    runError = error;
  } finally {
    const cleanupErrors = [];
    if (token && userId) {
      try {
        const listed = await request('/api/functions/workspace-mutation', {
          token,
          body: { action: 'list' },
        });
        for (const workspace of listed.json?.workspaces ?? []) {
          if (workspace?.ownerId !== userId) continue;
          await deleteSmokeWorkspace(BASE, token, workspace, { timeoutMs: TIMEOUT_MS });
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (userId) {
      try {
        const deleted = await request(`/api/auth/admin/users/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          serviceKey,
        });
        assert(deleted.response.ok, `synthetic user cleanup returned HTTP ${deleted.response.status}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors, 'language onboarding smoke cleanup failed');
      if (!runError) runError = cleanupError;
      else console.error(`WARN ${cleanupError.message}`);
    }
  }
  if (runError) throw runError;
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL language onboarding smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
