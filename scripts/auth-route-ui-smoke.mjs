#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BASE_URL,
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  console.error(`\nFAIL auth/route UI regression: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main() {
  await assertRuntimeReachable(options.url);
  mkdirSync(options.screenshotDir, { recursive: true });
  const { chromium } = await loadPlaywright({ label: 'auth/route UI regression smoke' });
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    await assertShortViewportSignup(browser);
    await assertMalformedSharedLink(browser);
    console.log('PASS short-viewport signup remains scrollable and malformed shared links render a friendly route state.');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function assertShortViewportSignup(browser) {
  const { context, page, errors, endInitialSignedOutRefreshWindow } = await newCheckedPage(
    browser,
    { viewport: { width: 844, height: 390 }, hasTouch: true },
    { errors: [], allowInitialSignedOutRefresh401: true },
  );
  try {
    await page.goto(resolveUrl(options.url, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await endInitialSignedOutRefreshWindow();
    await page.getByRole('button', { name: 'Create account', exact: true }).click({
      timeout: options.timeoutMs,
    });

    const passwordHelp = page.getByText(/Use 10 or more characters/i);
    await passwordHelp.waitFor({ state: 'visible', timeout: options.timeoutMs });
    const signInInstead = page.getByRole('button', { name: 'Sign in instead', exact: true });
    const legalNotice = page.getByTestId('legal-notice');
    await page.locator('main').evaluate((main) => main.scrollTo({ top: 0, behavior: 'instant' }));
    const topMetrics = await page.evaluate(() => {
      const main = document.querySelector('main');
      const brand = document.querySelector('main h1');
      const brandRect = brand?.getBoundingClientRect();
      return {
        mainScrollTop: main?.scrollTop ?? -1,
        brandTop: brandRect?.top ?? Number.NEGATIVE_INFINITY,
        brandBottom: brandRect?.bottom ?? Number.POSITIVE_INFINITY,
        viewportHeight: window.innerHeight,
      };
    });
    assert(topMetrics.mainScrollTop === 0, `AuthGate could not return to the top: ${JSON.stringify(topMetrics)}`);
    assert(topMetrics.brandTop >= 0 && topMetrics.brandBottom <= topMetrics.viewportHeight, `AuthGate brand is clipped at the top: ${JSON.stringify(topMetrics)}`);
    await page.screenshot({
      path: join(options.screenshotDir, 'signup-landscape-844x390-top.png'),
      fullPage: false,
    });
    await signInInstead.scrollIntoViewIfNeeded();
    await legalNotice.scrollIntoViewIfNeeded();

    const metrics = await page.evaluate(() => {
      const main = document.querySelector('main');
      const legal = document.querySelector('[data-testid="legal-notice"]');
      const buttons = [...document.querySelectorAll('main button')];
      const legalRect = legal?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        mainClientHeight: main?.clientHeight ?? 0,
        mainScrollHeight: main?.scrollHeight ?? 0,
        mainScrollTop: main?.scrollTop ?? 0,
        legalTop: legalRect?.top ?? Number.POSITIVE_INFINITY,
        legalBottom: legalRect?.bottom ?? Number.POSITIVE_INFINITY,
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        minButtonHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
      };
    });

    assert(metrics.viewportWidth === 844 && metrics.viewportHeight === 390, `unexpected auth viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.mainScrollHeight > metrics.mainClientHeight, `signup fixture must pressure vertical scrolling: ${JSON.stringify(metrics)}`);
    assert(metrics.mainScrollTop > 0, `AuthGate did not scroll to its footer in a short viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.legalTop >= 0 && metrics.legalBottom <= metrics.viewportHeight + 1, `legal notice is not reachable in the short viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.minButtonHeight >= 44, `touch AuthGate controls must keep 44px targets: ${JSON.stringify(metrics)}`);
    assert(
      Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 1,
      `short-viewport AuthGate created horizontal overflow: ${JSON.stringify(metrics)}`,
    );

    await page.screenshot({
      path: join(options.screenshotDir, 'signup-landscape-844x390-bottom.png'),
      fullPage: false,
    });
    writeFileSync(
      join(options.screenshotDir, 'signup-landscape-844x390.json'),
      `${JSON.stringify({ top: topMetrics, bottom: metrics }, null, 2)}\n`,
    );
    assertNoBrowserErrors(errors, 'short-viewport signup');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertMalformedSharedLink(browser) {
  const { context, page, errors } = await newCheckedPage(
    browser,
    { viewport: { width: 844, height: 600 } },
    { errors: [] },
  );
  try {
    await page.goto(resolveUrl(options.url, '/share/%'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.locator('[data-surface="route-problem"]').waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.locator('[data-surface="route-problem"]').getByText('This shared link is invalid.', { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    assert(await page.getByLabel('Email').count() === 0, 'malformed public share incorrectly opened the sign-in gate');
    assert(await page.getByText(/Something went wrong/i).count() === 0, 'malformed public share fell into a generic error boundary');
    await page.screenshot({
      path: join(options.screenshotDir, 'malformed-shared-link.png'),
      fullPage: false,
    });
    writeFileSync(
      join(options.screenshotDir, 'malformed-shared-link.json'),
      `${JSON.stringify({ pathname: new URL(page.url()).pathname, surface: 'route-problem' }, null, 2)}\n`,
    );
    assertNoBrowserErrors(errors, 'malformed shared link');
  } finally {
    await context.close().catch(() => {});
  }
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    timeoutMs: 20_000,
    screenshotDir: join(root, '.edgebase', 'ui-discovery', 'auth-route'),
    headed: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--url') parsed.url = args[++index] ?? parsed.url;
    else if (arg === '--timeout' || arg === '--timeout-ms') parsed.timeoutMs = Number(args[++index] ?? parsed.timeoutMs);
    else if (arg === '--screenshot-dir') parsed.screenshotDir = resolve(args[++index] ?? parsed.screenshotDir);
    else if (arg === '--headed') parsed.headed = true;
  }
  assert(Number.isFinite(parsed.timeoutMs) && parsed.timeoutMs > 0, '--timeout-ms must be a positive number');
  parsed.url = normalizeBaseUrl(parsed.url);
  parsed.screenshotDir = resolve(parsed.screenshotDir);
  return parsed;
}
