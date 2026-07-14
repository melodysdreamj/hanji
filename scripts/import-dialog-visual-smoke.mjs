#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  captureBrowserSession,
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
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'import-dialog');

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL import dialog visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('import dialog visual smoke');
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Import dialog visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Import dialog visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedImportWorkspace(apiUrl);
  // Without HANJI_NOTION_IMPORT_SECRET the dialog hides the save-connection
  // affordances and shows the token-not-stored hint instead.
  const connectionsProbe = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
    action: 'listConnections',
    workspaceId: seed.workspaceId,
    limit: 1,
  });
  const connectionStorageAvailable = connectionsProbe.connectionStorageAvailable !== false;
  const connectionSaveTexts = connectionStorageAvailable
    ? ['Connection name']
    : ['never stored on this server'];
  console.log(`Connection storage available: ${connectionStorageAvailable}`);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'desktop-file-import',
      viewport: { width: 1440, height: 1000 },
      open: openFileImportDialog,
      contract: {
        expectedTexts: ['Import', 'File', 'Notion', 'Choose a file', 'Choose file', 'Markdown', 'CSV'],
        minButtons: 4,
        minRows: 4,
        width: [600, 660],
      },
    });
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'desktop-notion-import',
      viewport: { width: 1440, height: 1000 },
      open: openNotionImportDialog,
      contract: {
        // Wizard step 1 (Connect): token guidance only — scope and progress
        // moved to their own steps.
        expectedTexts: ['Import', 'File', 'Notion', 'Prepare Notion token', 'Open Notion token page', 'Setup guide', 'Notion API token', ...connectionSaveTexts, 'Connect', 'Scope', 'Discover', 'Apply', 'Cancel import', 'Resume discovery'],
        // The always-on token walkthrough now occupies the top of step 1, so the
        // token intro card and input sit below the fold (still present via
        // expectedTexts). The step-1 header stays above the fold; the
        // walkthrough's own rendering/behavior is guarded by
        // verify:notion-import-ui.
        expectedVisibleTexts: ['Prepare Notion token'],
        rejectVisibleTexts: ['Connect Notion', 'Start discovery'],
        minButtons: 4,
        minRows: 6,
        width: [600, 660],
      },
    });
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'desktop-notion-pages-scope',
      viewport: { width: 1440, height: 1000 },
      open: openNotionPagesScopeDialog,
      contract: {
        expectedTexts: ['Import', 'File', 'Notion', 'Entire workspace', 'Specific pages', 'Import pages in full width', 'Scan accessible roots', 'Paste links or IDs instead (advanced)', 'Start discovery'],
        expectedVisibleTexts: ['Specific pages', 'Scan accessible roots', 'Paste links or IDs instead (advanced)', 'Start discovery'],
        rejectVisibleTexts: ['Connect Notion', 'Notion API token'],
        expectFullWidthOptionChecked: true,
        minButtons: 5,
        minRows: 7,
        width: [600, 660],
      },
    });
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'desktop-notion-run',
      viewport: { width: 1440, height: 1000 },
      open: openNotionRunDialog,
      contract: {
        // A manual-token job survives dialog dismissal but cannot persist the
        // credential. Reopening returns to Connect with explicit resume and
        // cancel controls instead of presenting a stranded run panel.
        expectedTexts: ['Import', 'File', 'Notion', 'Notion API token', 'Resume discovery', 'Cancel import'],
        expectedVisibleTexts: ['Notion API token', 'Cancel import'],
        minButtons: 4,
        minRows: 5,
        width: [600, 660],
      },
    });
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'mobile-file-import',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openFileImportDialog,
      contract: {
        expectedTexts: ['Import', 'File', 'Notion', 'Choose a file', 'Choose file', 'Markdown', 'CSV'],
        minButtons: 4,
        minRows: 4,
        width: [350, 390],
      },
    });
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'mobile-notion-import',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openNotionImportDialog,
      contract: {
        // See desktop-notion-import: wizard step 1 (Connect) only.
        expectedTexts: ['Import', 'File', 'Notion', 'Prepare Notion token', 'Open Notion token page', 'Setup guide', 'Notion API token', ...connectionSaveTexts, 'Connect', 'Scope', 'Discover', 'Apply', 'Cancel import', 'Resume discovery'],
        expectedVisibleTexts: ['Prepare Notion token'],
        rejectVisibleTexts: ['Connect Notion', 'Start discovery'],
        minButtons: 4,
        minRows: 6,
        width: [350, 390],
      },
    });
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'mobile-notion-pages-scope',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openNotionPagesScopeDialog,
      contract: {
        expectedTexts: ['Import', 'File', 'Notion', 'Entire workspace', 'Specific pages', 'Import pages in full width', 'Scan accessible roots', 'Paste links or IDs instead (advanced)', 'Start discovery'],
        expectedVisibleTexts: ['Specific pages', 'Scan accessible roots', 'Start discovery'],
        rejectVisibleTexts: ['Connect Notion', 'Notion API token'],
        expectFullWidthOptionChecked: true,
        minButtons: 5,
        minRows: 7,
        width: [350, 390],
      },
    });
    await captureImportVariant(browser, appUrl, seed, {
      prefix: 'mobile-notion-run',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openNotionRunDialog,
      contract: {
        // See desktop-notion-run: manual credentials are requested again while
        // the durable job remains resumable and cancellable.
        expectedTexts: ['Import', 'File', 'Notion', 'Notion API token', 'Resume discovery', 'Cancel import'],
        expectedVisibleTexts: ['Notion API token', 'Cancel import'],
        minButtons: 4,
        minRows: 5,
        width: [350, 390],
      },
    });

    await captureBackgroundImportLifecycle(browser, appUrl, seed);

    console.log('PASS import dialog surfaces are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-file-import',
      'desktop-notion-import',
      'desktop-notion-pages-scope',
      'desktop-notion-run',
      'mobile-file-import',
      'mobile-notion-import',
      'mobile-notion-pages-scope',
      'mobile-notion-run',
      'desktop-notion-background',
      'desktop-notion-cancelled',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function captureImportVariant(browser, appUrl, seed, variant) {
  console.log(`Capture ${variant.prefix}...`);
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    locale: 'en-US',
    viewport: variant.viewport,
  });
  await seedSession(context, seed);

  try {
    await variant.open(page, appUrl);
    await assertImportDialogContract(page, variant.contract, { mobile: !!variant.mobile, prefix: variant.prefix });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} import dialog visual flow`);
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      bodyText: document.body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 800) ?? '',
      localStorageKeys: Object.keys(window.localStorage),
      path: window.location.pathname,
      title: document.title,
    })).catch(() => null);
    throw new Error([
      `${variant.prefix}: ${error instanceof Error ? error.message : String(error)}`,
      `browserErrors=${JSON.stringify(errors)}`,
      `diagnostics=${JSON.stringify(diagnostics)}`,
    ].join('\n'));
  } finally {
    await captureBrowserSession(context, seed, {
      appOrigin: appUrl,
      authOrigin: options.apiUrl,
    }).catch(() => {});
    await context.close().catch(() => {});
  }
}

async function openFileImportDialog(page, baseUrl) {
  await openApp(page, baseUrl);
  const dialog = await openImportDialog(page);
  await dialog.getByRole('button', { name: 'File', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Choose a file', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openNotionRunDialog(page, baseUrl) {
  // The seeded manual-token job is durable, but its credential is not. The
  // reconnect state must expose both resume and cancellation controls.
  await openApp(page, baseUrl);
  const dialog = await openImportDialog(page);
  await dialog.getByRole('button', { name: 'Notion', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Cancel import', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return dialog;
}

async function openNotionImportDialog(page, baseUrl) {
  // Step 1 (Connect) for the durable manual-token job.
  const dialog = await openNotionRunDialog(page, baseUrl);
  await dialog.getByRole('tab', { name: 'Connect', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByRole('link', { name: 'Open Notion token page', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function captureBackgroundImportLifecycle(browser, appUrl, seed) {
  console.log('Capture desktop Notion background/cancel lifecycle...');
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    locale: 'en-US',
    viewport: { width: 1440, height: 1000 },
  });
  await seedSession(context, seed);

  try {
    await openApp(page, appUrl);
    const runningButton = page.locator('[data-sidebar-footer-action][data-import-running="true"]');
    await runningButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await assert(
      await runningButton.textContent().then((text) => text?.includes('Importing') && text.includes('%')),
      'dismissed Notion import should stay visible in the sidebar with progress',
    );

    await runningButton.click({ timeout: options.timeoutMs });
    const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
    await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await dialog.getByRole('button', { name: 'Close import', exact: true }).click({ timeout: options.timeoutMs });
    await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
    await runningButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await page.getByRole('heading', { name: 'Welcome to Hanji!', exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-notion-background.png'),
      fullPage: false,
    });

    await runningButton.click({ timeout: options.timeoutMs });
    await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await dialog.getByRole('button', { name: 'Notion', exact: true }).click({ timeout: options.timeoutMs });
    await dialog.getByRole('button', { name: 'Cancel import', exact: true }).click({ timeout: options.timeoutMs });
    await runningButton.waitFor({ state: 'hidden', timeout: options.timeoutMs });
    await dialog.getByRole('button', { name: 'Close import', exact: true }).click({ timeout: options.timeoutMs });
    await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
    const importButton = await onscreenButton(page, 'Import', { timeoutMs: options.timeoutMs });
    assert(await importButton.isEnabled(), 'cancelled import should permit an immediate fresh import');
    await page.getByRole('heading', { name: 'Welcome to Hanji!', exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-notion-cancelled.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'Notion background/cancel lifecycle');
  } finally {
    await captureBrowserSession(context, seed, {
      appOrigin: appUrl,
      authOrigin: options.apiUrl,
    }).catch(() => {});
    await context.close().catch(() => {});
  }
}

async function openNotionPagesScopeDialog(page, baseUrl) {
  // Step 2 (Scope) with the specific-pages root picker expanded.
  const dialog = await openNotionRunDialog(page, baseUrl);
  await dialog.getByRole('tab', { name: 'Scope', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByLabel('Specific pages').check({ timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Scan accessible roots' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openApp(page, baseUrl) {
  await page.goto(resolveUrl(baseUrl, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator('body').waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function openImportDialog(page) {
  let importButton;
  try {
    importButton = await onscreenImportButton(page, { timeoutMs: 1000 });
  } catch {
    const openSidebarButton = await onscreenButton(page, 'Open sidebar', { timeoutMs: options.timeoutMs });
    await openSidebarButton.click({ timeout: options.timeoutMs });
    importButton = await onscreenImportButton(page, { timeoutMs: options.timeoutMs });
  }
  await importButton.click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function onscreenImportButton(page, optionsOverride = {}) {
  const timeoutMs = optionsOverride.timeoutMs ?? options.timeoutMs;
  const buttons = page.locator('button[data-sidebar-footer-action]');
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('button[data-sidebar-footer-action]')).some((button) => {
      if (!(button instanceof HTMLElement)) return false;
      const text = (button.innerText || '').replace(/\s+/g, ' ').trim();
      if (button.dataset.importRunning !== 'true' && text !== 'Import') return false;
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight
      );
    });
  }, undefined, { timeout: timeoutMs });

  const viewport = page.viewportSize() ?? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY };
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const text = (await button.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const running = await button.getAttribute('data-import-running') === 'true';
    if (!running && text !== 'Import') continue;
    if (!(await button.isVisible())) continue;
    const box = await button.boundingBox();
    if (!box) continue;
    if (box.x + box.width > 0 && box.y + box.height > 0 && box.x < viewport.width && box.y < viewport.height) {
      return button;
    }
  }

  throw new Error('Could not find an onscreen import button');
}

async function waitForVisibleDialogText(page, text) {
  await page.waitForFunction((expectedText) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const labelledBy = element.getAttribute('aria-labelledby');
        return labelledBy
          ? document.getElementById(labelledBy)?.textContent?.trim() === 'Import'
          : element.getAttribute('aria-label')?.trim() === 'Import';
      },
    );
    if (!(dialog instanceof HTMLElement)) return false;
    return isTextVisibleInside(dialog, expectedText);

    function isTextVisibleInside(root, expected) {
      const rootRect = root.getBoundingClientRect();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(expected)) continue;
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement)) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        range.detach();
        if (rects.some((rect) => (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= rootRect.left - 1 &&
          rect.right <= rootRect.right + 1 &&
          rect.top >= rootRect.top - 1 &&
          rect.bottom <= rootRect.bottom + 1 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        ))) {
          return true;
        }
      }
      return false;
    }
  }, text, { timeout: options.timeoutMs });
}

async function onscreenButton(page, name, optionsOverride = {}) {
  const timeoutMs = optionsOverride.timeoutMs ?? options.timeoutMs;
  const buttons = page.getByRole('button', { name, exact: true });
  await page.waitForFunction((buttonName) => {
    return Array.from(document.querySelectorAll('button')).some((button) => {
      if (!(button instanceof HTMLElement)) return false;
      const text = (button.innerText || button.getAttribute('aria-label') || '').trim();
      if (text !== buttonName) return false;
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight
      );
    });
  }, name, { timeout: timeoutMs });

  const viewport = page.viewportSize() ?? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY };
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible())) continue;
    const box = await button.boundingBox();
    if (!box) continue;
    const isOnscreen = box.x + box.width > 0 && box.y + box.height > 0 && box.x < viewport.width && box.y < viewport.height;
    if (isOnscreen) return button;
  }

  throw new Error(`Could not find an onscreen ${name} button`);
}

async function assertImportDialogContract(page, contract, variant) {
  const dialogLocator = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialogLocator.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const metrics = await dialogLocator.evaluate((dialog, {
    expectedTexts,
    expectedVisibleTexts,
    rejectVisibleTexts,
  }) => {
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing Import dialog' };
    const rect = dialog.getBoundingClientRect();
    const buttons = visibleElements(dialog.querySelectorAll('button'));
    const inputs = visibleElements(dialog.querySelectorAll('input, textarea, select'));
    const wideInputs = inputs.filter((element) => {
      if (!(element instanceof HTMLInputElement)) return true;
      const type = element.type.toLowerCase();
      return type !== 'checkbox' && type !== 'radio';
    });
    const rows = visibleElements(dialog.querySelectorAll('button, label, [aria-label="Supported imports"] > *, [aria-label="Recent Notion import jobs"] > *'))
      // The token walkthrough is a decorative animated widget, not an import
      // form row — its progress-segment buttons are intentionally thin.
      .filter((element) => !element.closest('[data-walkthrough]'));
    const rowHeights = rows.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0);
    const inputWidths = wideInputs.map((element) => element.getBoundingClientRect().width).filter((width) => width > 0);
    const panel = dialog.querySelector('[aria-label="Import sources"]')?.parentElement;
    const startDiscoveryButton = buttons.find((element) => element.textContent?.trim() === 'Start discovery');
    const startDiscoveryRect = startDiscoveryButton?.getBoundingClientRect();
    const fullWidthOption = Array.from(dialog.querySelectorAll('label')).find(
      (element) => element instanceof HTMLElement && element.textContent?.includes('Import pages in full width'),
    );
    const fullWidthCheckbox = fullWidthOption?.querySelector('input[type="checkbox"]');
    const jobRows = visibleElements(dialog.querySelectorAll('[aria-label="Recent Notion import jobs"] > *'));
    const clippedJobRows = jobRows
      .map((element) => element.getBoundingClientRect())
      .filter((rowRect) => rowRect.top < rect.bottom - 1 && rowRect.bottom > rect.bottom - 1);
    const visibleJobBottomGaps = jobRows
      .map((element) => element.getBoundingClientRect())
      .filter((rowRect) => rowRect.top < rect.bottom && rowRect.bottom <= rect.bottom)
      .map((rowRect) => rect.bottom - rowRect.bottom);
    const text = dialog.textContent ?? '';
    const missingExpectedTexts = expectedTexts.filter((item) => !text.includes(item));
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter((item) => !hasVisibleText(dialog, item));
    const unexpectedVisibleTexts = rejectVisibleTexts.filter((item) => hasVisibleText(dialog, item));
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      buttonCount: buttons.length,
      documentScrollWidth: document.documentElement.scrollWidth,
      expectedTextsPresent: missingExpectedTexts.length === 0,
      fullWidthOptionChecked: fullWidthCheckbox instanceof HTMLInputElement ? fullWidthCheckbox.checked : null,
      height: rect.height,
      inputCount: wideInputs.length,
      inputMinWidth: inputWidths.length ? Math.min(...inputWidths) : 0,
      left: rect.left,
      clippedJobRowCount: clippedJobRows.length,
      minVisibleJobBottomGap: visibleJobBottomGaps.length ? Math.min(...visibleJobBottomGaps) : null,
      maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
      minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
      missingExpectedTexts,
      missingVisibleExpectedTexts,
      panelScrollWidth: panel instanceof HTMLElement ? panel.scrollWidth : 0,
      panelClientWidth: panel instanceof HTMLElement ? panel.clientWidth : 0,
      rightGap: window.innerWidth - rect.right,
      rowCount: rows.length,
      startDiscoveryBottomGap: startDiscoveryRect ? rect.bottom - startDiscoveryRect.bottom : null,
      startDiscoveryTop: startDiscoveryRect?.top ?? null,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
      unexpectedVisibleTexts,
    };

    function visibleElements(items) {
      return Array.from(items).filter(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function hasVisibleText(root, expected) {
      const rootRect = root.getBoundingClientRect();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(expected)) continue;
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement) || !isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        range.detach();
        if (rects.some((rect) => (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= rootRect.left - 1 &&
          rect.right <= rootRect.right + 1 &&
          rect.top >= rootRect.top - 1 &&
          rect.bottom <= rootRect.bottom + 1 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        ))) {
          return true;
        }
      }
      return false;
    }
  }, {
    expectedTexts: contract.expectedTexts ?? [],
    expectedVisibleTexts: contract.expectedVisibleTexts ?? [],
    rejectVisibleTexts: contract.rejectVisibleTexts ?? [],
  });

  assert(metrics.ok, metrics.reason ?? `${variant.prefix} import dialog contract could not run`);
  const [minWidth, maxWidth] = contract.width;
  assert(metrics.width >= minWidth && metrics.width <= maxWidth, `${variant.prefix} dialog width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.left >= (variant.mobile ? 0 : 8), `${variant.prefix} dialog should not drift off left edge: ${JSON.stringify(metrics)}`);
  assert(metrics.rightGap >= (variant.mobile ? 0 : 8), `${variant.prefix} dialog should not drift off right edge: ${JSON.stringify(metrics)}`);
  assert(metrics.top >= (variant.mobile ? 8 : 28), `${variant.prefix} dialog should not crowd the top edge: ${JSON.stringify(metrics)}`);
  assert(metrics.height <= metrics.viewportHeight - (variant.mobile ? 16 : 40), `${variant.prefix} dialog should fit in the viewport: ${JSON.stringify(metrics)}`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${variant.prefix} dialog should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.panelScrollWidth <= metrics.panelClientWidth + 4, `${variant.prefix} dialog body should not need horizontal scrolling: ${JSON.stringify(metrics)}`);
  assert(metrics.buttonCount >= (contract.minButtons ?? 0), `${variant.prefix} has too few visible buttons: ${JSON.stringify(metrics)}`);
  assert(metrics.inputCount >= (contract.minInputs ?? 0), `${variant.prefix} has too few visible inputs: ${JSON.stringify(metrics)}`);
  assert(metrics.rowCount >= (contract.minRows ?? 0), `${variant.prefix} has too few visible rows: ${JSON.stringify(metrics)}`);
  assert(metrics.expectedTextsPresent, `${variant.prefix} is missing expected text: ${JSON.stringify(metrics)}`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${variant.prefix} has expected text outside the visible screenshot: ${JSON.stringify(metrics)}`);
  assert(metrics.unexpectedVisibleTexts.length === 0, `${variant.prefix} shows hidden/advanced text in the default view: ${JSON.stringify(metrics)}`);
  if (contract.expectFullWidthOptionChecked) {
    assert(metrics.fullWidthOptionChecked === true, `${variant.prefix} should default the Notion full-width option on: ${JSON.stringify(metrics)}`);
  }
  if (metrics.startDiscoveryBottomGap !== null) {
    assert(
      metrics.startDiscoveryBottomGap >= (variant.mobile ? 10 : 12),
      `${variant.prefix} primary Notion import action should not be clipped against the dialog bottom: ${JSON.stringify(metrics)}`,
    );
  }
  assert(metrics.clippedJobRowCount === 0, `${variant.prefix} import job rows should not peek partially clipped at the dialog bottom: ${JSON.stringify(metrics)}`);
  if (metrics.minVisibleJobBottomGap !== null) {
    assert(
      metrics.minVisibleJobBottomGap >= (variant.mobile ? 12 : 14),
      `${variant.prefix} visible import job rows should keep a bottom inset: ${JSON.stringify(metrics)}`,
    );
  }
  assert(metrics.inputCount === 0 || metrics.inputMinWidth >= 120, `${variant.prefix} input width is too cramped: ${JSON.stringify(metrics)}`);
  assert(metrics.maxRowHeight <= (contract.maxRowHeight ?? 190), `${variant.prefix} row height is too loose: ${JSON.stringify(metrics)}`);
  assert(metrics.minRowHeight === 0 || metrics.minRowHeight >= 20, `${variant.prefix} row height is too cramped: ${JSON.stringify(metrics)}`);
}

async function seedImportWorkspace(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for import dialog visual smoke');
  const created = await callFunction(baseUrl, session.accessToken, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    rootNotionPageIds: ['visual-smoke-root'],
  });
  assert(created.job?.id, 'notion-import create must return a queued job id for import dialog visual smoke');
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    jobId: created.job.id,
  };
}

async function seedSession(context, seed, theme = 'light') {
  await installBrowserSession(context, seed, {
    appOrigin: options.url,
    authOrigin: options.apiUrl,
    workspaceId: seed.workspaceId,
    localStorage: {
      'hanji:theme': theme,
    },
  });
}

function parseArgs(args) {
  const parsed = {
    apiUrl: process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
  console.log(`Usage: node scripts/import-dialog-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}
