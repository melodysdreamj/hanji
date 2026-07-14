#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  deleteSmokeWorkspace,
  finalizeRegisteredSmokeAccounts,
  installBrowserSession,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'notion-import-onboarding');
const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

let seed;
let browser;
let runError;

try {
  await main();
} catch (error) {
  runError = error;
  console.error(`\nFAIL Notion import onboarding visual smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  const cleanupErrors = [];
  if (seed?.workspace && seed?.session?.accessToken) {
    await deleteSmokeWorkspace(options.apiUrl, seed.session.accessToken, seed.workspace, {
      call: callFunction,
    }).catch((error) => cleanupErrors.push(error));
  }
  await finalizeRegisteredSmokeAccounts('Notion import onboarding visual smoke')
    .catch((error) => cleanupErrors.push(error));
  if (cleanupErrors.length && !runError) {
    console.error(`\nFAIL Notion import onboarding cleanup: ${cleanupErrors.map(errorMessage).join('; ')}`);
    process.exitCode = 1;
  }
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  options.apiUrl = apiUrl;
  console.log(`Notion import onboarding visual target: ${appUrl}`);
  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });

  seed = await seedFirstAdminWorkspace(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });
  const { context, page, errors } = await newCheckedPage(browser, {
    locale: 'en-US',
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await installBrowserSession(context, seed.session, {
    appOrigin: appUrl,
    authOrigin: apiUrl,
    workspaceId: seed.workspace.id,
  });
  // Server authorization/atomicity is covered by
  // backend/tests/unit/workspace-notion-onboarding.test.ts. This visual smoke
  // keeps its fixture synthetic and self-cleaning by projecting the anonymous
  // owner as an instance admin only in browser responses. Responsive sidebar
  // remounts may repeat the claim while the prompt is open; once the user
  // accepts it, later claims settle as already presented.
  let claimCalls = 0;
  let allowOnboarding = true;
  await page.route('**/api/functions/workspace-bootstrap', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, isInstanceAdmin: true } });
  });
  await page.route('**/api/functions/workspace-mutation', async (route) => {
    const request = route.request();
    const body = request.postDataJSON?.();
    if (body?.action !== 'claimNotionImportOnboarding') {
      await route.continue();
      return;
    }
    claimCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ show: allowOnboarding }),
    });
  });

  try {
    await page.goto(resolveUrl(appUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    const onboarding = page.getByRole('dialog', { name: 'Bring your Notion workspace to Hanji?' });
    await onboarding.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await assertOnboardingGeometry(page, false);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-admin-notion-import.png'),
      fullPage: false,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    await page.getByRole('dialog', { name: 'Bring your Notion workspace to Hanji?' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await assertOnboardingGeometry(page, true);
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-first-admin-notion-import.png'),
      fullPage: false,
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(150);
    const currentOnboarding = page.getByRole('dialog', { name: 'Bring your Notion workspace to Hanji?' });
    await currentOnboarding.waitFor({ state: 'visible', timeout: options.timeoutMs });
    allowOnboarding = false;
    await currentOnboarding.getByRole('button', { name: 'Import from Notion' }).click({
      timeout: options.timeoutMs,
    });
    const importDialog = page.getByRole('dialog', { name: 'Import', exact: true });
    await importDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await importDialog.getByRole('button', { name: 'Notion', exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await importDialog.getByLabel('Notion API token').waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await importDialog.getByRole('button', { name: 'Close import', exact: true }).click({
      timeout: options.timeoutMs,
    });
    await importDialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });

    await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Import', exact: true }).last().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.waitForTimeout(500);
    assert(
      await page.locator('[data-notion-import-onboarding]').count() === 0,
      'the server-claimed onboarding prompt must not return after reload',
    );
    assert(claimCalls >= 2, `reload must re-check the durable claim, got ${claimCalls} call(s)`);
    assertNoBrowserErrors(errors, 'first-admin Notion import onboarding');
  } finally {
    await context.close().catch(() => {});
  }

  console.log('PASS the first-admin prompt appears once, opens the Notion import tab, and stays dismissed after reload.');
  console.log(`Desktop screenshot: ${join(options.screenshotDir, 'desktop-first-admin-notion-import.png')}`);
  console.log(`Mobile screenshot: ${join(options.screenshotDir, 'mobile-first-admin-notion-import.png')}`);
}

async function seedFirstAdminWorkspace(apiUrl) {
  const session = await signIn(apiUrl, { timeoutMs: options.timeoutMs });
  const bootstrap = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspace = bootstrap?.workspace;
  assert(workspace?.id && workspace?.name, 'workspace bootstrap must create a synthetic starter workspace');
  return { session, workspace };
}

async function assertOnboardingGeometry(page, mobile) {
  const metrics = await page.locator('[data-notion-import-onboarding]').evaluate((overlay) => {
    const dialog = overlay.querySelector('[role="dialog"]');
    const title = dialog?.querySelector('h2');
    const buttons = Array.from(dialog?.querySelectorAll('button') ?? []).filter(
      (button) => button instanceof HTMLElement && button.offsetParent !== null,
    );
    if (!(dialog instanceof HTMLElement) || !(title instanceof HTMLElement)) {
      return { ok: false };
    }
    const rect = dialog.getBoundingClientRect();
    const buttonRects = buttons.map((button) => button.getBoundingClientRect());
    return {
      ok: true,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width },
      title: title.textContent?.trim(),
      buttonRects: buttonRects.map((item) => ({ width: item.width, bottom: item.bottom })),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  assert(metrics.ok, 'onboarding dialog markers must render');
  assert(metrics.title === 'Bring your Notion workspace to Hanji?', `unexpected onboarding title: ${metrics.title}`);
  assert(metrics.rect.left >= 0 && metrics.rect.right <= metrics.viewport.width, `dialog must fit horizontally: ${JSON.stringify(metrics)}`);
  assert(metrics.rect.top >= 0 && metrics.rect.bottom <= metrics.viewport.height, `dialog must fit vertically: ${JSON.stringify(metrics)}`);
  assert(metrics.buttonRects.every((rect) => rect.bottom <= metrics.viewport.height), `actions must stay visible: ${JSON.stringify(metrics)}`);
  if (mobile) {
    assert(metrics.rect.width >= 350 && metrics.rect.width <= 378, `mobile dialog width must fit the viewport: ${JSON.stringify(metrics)}`);
    const actionWidths = metrics.buttonRects.slice(-2).map((rect) => rect.width);
    assert(actionWidths.every((width) => width >= 330), `mobile actions must be full width: ${JSON.stringify(metrics)}`);
  } else {
    assert(metrics.rect.width >= 410 && metrics.rect.width <= 440, `desktop dialog width must stay compact: ${JSON.stringify(metrics)}`);
  }
}

function parseArgs(args) {
  const parsed = {
    apiUrl: undefined,
    headed: false,
    screenshotDir: DEFAULT_SCREENSHOT_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: DEFAULT_BASE_URL,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--headed') {
      parsed.headed = true;
      continue;
    }
    if (arg === '--url' || arg === '--api-url' || arg === '--screenshot-dir' || arg === '--timeout-ms') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--url') parsed.url = value;
      if (arg === '--api-url') parsed.apiUrl = value;
      if (arg === '--screenshot-dir') parsed.screenshotDir = resolve(value);
      if (arg === '--timeout-ms') parsed.timeoutMs = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
    throw new Error('--timeout-ms must be a number >= 1000');
  }
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
