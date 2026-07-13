#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BASE_URL,
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  captureBrowserSession,
  callFunction,
  finalizeRegisteredSmokeAccounts,
  installBrowserSession,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  permanentlyDeletePage,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'trash');

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL trash visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('trash visual smoke');
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Trash visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Trash visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const emptySeed = await seedTrashWorkspace(apiUrl, { count: 0, label: 'empty' });
  const trashSeed = await seedTrashWorkspace(apiUrl, { count: 3, label: 'populated' });
  const { chromium } = await loadPlaywright({ label: 'trash visual smoke' });
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureTrashVariant(browser, appUrl, emptySeed, {
      prefix: 'desktop-empty-trash',
      viewport: { width: 1440, height: 1000 },
      contract: {
        expectedVisibleTexts: ['Trash', 'Pages you delete land here. Nothing in the trash.'],
        rowCount: 0,
        search: false,
      },
    });
    await captureTrashVariant(browser, appUrl, trashSeed, {
      prefix: 'desktop-populated-trash',
      viewport: { width: 1440, height: 1000 },
      contract: {
        expectedVisibleTexts: ['Trash', trashSeed.pages[0].title, 'Restore', 'Delete forever'],
        rowCount: 3,
        search: true,
        countText: '3 pages',
      },
    });
    await captureTrashVariant(browser, appUrl, trashSeed, {
      prefix: 'desktop-trash-no-results',
      viewport: { width: 1440, height: 1000 },
      prepare: async (page) => {
        await page.getByLabel('Search trash').fill(`no-match-${trashSeed.workspaceId}`, { timeout: options.timeoutMs });
        await page.getByText('No deleted pages match your search.').waitFor({
          state: 'visible',
          timeout: options.timeoutMs,
        });
      },
      contract: {
        expectedVisibleTexts: ['Trash', 'No deleted pages match your search.'],
        rowCount: 0,
        search: true,
        countText: '0 pages',
      },
    });
    await captureTrashVariant(browser, appUrl, trashSeed, {
      prefix: 'desktop-delete-confirm',
      viewport: { width: 1440, height: 1000 },
      prepare: async (page) => {
        await page.getByRole('button', { name: `Delete ${trashSeed.pages[0].title} forever` }).click({
          timeout: options.timeoutMs,
        });
        await page.getByRole('dialog', { name: 'Delete forever?' }).waitFor({
          state: 'visible',
          timeout: options.timeoutMs,
        });
      },
      contract: {
        expectedVisibleTexts: ['Trash', 'Delete forever?', trashSeed.pages[0].title, "You can't undo this action.", 'Cancel'],
        rowCount: 3,
        search: true,
        countText: '3 pages',
        confirmDialog: true,
      },
    });
    await captureTrashVariant(browser, appUrl, trashSeed, {
      prefix: 'mobile-populated-trash',
      viewport: { width: 390, height: 844 },
      mobile: true,
      contract: {
        expectedVisibleTexts: ['Trash', trashSeed.pages[0].title, 'Restore', 'Delete forever'],
        rowCount: 3,
        search: true,
        countText: '3 pages',
      },
    });

    console.log('PASS trash surfaces are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-empty-trash',
      'desktop-populated-trash',
      'desktop-trash-no-results',
      'desktop-delete-confirm',
      'mobile-populated-trash',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await cleanupSeed(apiUrl, trashSeed).catch(() => {});
    await cleanupSeed(apiUrl, emptySeed).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureTrashVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, appUrl);

  try {
    await openTrash(page, appUrl);
    if (variant.prepare) await variant.prepare(page);
    await assertTrashContract(page, variant.contract, { mobile: !!variant.mobile, prefix: variant.prefix });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} trash visual flow`);
  } finally {
    await captureBrowserSession(context, seed, { appOrigin: appUrl }).catch(() => {});
    await context.close().catch(() => {});
  }
}

async function openTrash(page, baseUrl) {
  await page.goto(resolveUrl(baseUrl, '/trash'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('heading', { name: 'Trash' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(() => document.title.includes('Trash'), null, {
    timeout: options.timeoutMs,
  });
  const path = new URL(page.url()).pathname;
  assert(path === '/trash', `direct /trash route changed to ${path}`);
}

async function assertTrashContract(page, contract, variant) {
  const metrics = await page.evaluate(({ expectedVisibleTexts }) => {
    // AppShell owns the document's single <main>; route views are labelled
    // regions inside it so assistive technology never sees nested landmarks.
    const main = document.querySelector('[role="region"][aria-label="Trash"]');
    if (!(main instanceof HTMLElement)) return { ok: false, reason: 'missing Trash main region' };
    const heading = main.querySelector('h1');
    const search = main.querySelector('input[aria-label="Search trash"]');
    const count = main.querySelector('[data-trash-count]');
    const list = main.querySelector('[role="list"]');
    const rows = visibleElements(main.querySelectorAll('[role="listitem"]'));
    const rowHeights = rows.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0);
    const rowWidths = rows.map((element) => element.getBoundingClientRect().width).filter((width) => width > 0);
    const actionButtons = visibleElements(main.querySelectorAll('button')).filter((button) => {
      const text = button.textContent ?? '';
      return text.includes('Restore') || text.includes('Delete forever');
    });
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) => element instanceof HTMLElement && isVisible(element) && element.textContent?.includes('Delete forever?'),
    );
    const mainRect = main.getBoundingClientRect();
    const headingRect = heading instanceof HTMLElement ? heading.getBoundingClientRect() : null;
    const searchRect = search instanceof HTMLElement ? search.getBoundingClientRect() : null;
    const listRect = list instanceof HTMLElement ? list.getBoundingClientRect() : null;
    const dialogRect = dialog instanceof HTMLElement ? dialog.getBoundingClientRect() : null;
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter((item) => !hasVisibleText(document.body, item));
    return {
      ok: true,
      actionButtonCount: actionButtons.length,
      bodyScrollWidth: document.body.scrollWidth,
      countText: count instanceof HTMLElement ? count.textContent?.trim() ?? '' : '',
      dialogHeight: dialogRect?.height ?? 0,
      dialogLeft: dialogRect?.left ?? 0,
      dialogRightGap: dialogRect ? window.innerWidth - dialogRect.right : 0,
      dialogTop: dialogRect?.top ?? 0,
      dialogWidth: dialogRect?.width ?? 0,
      documentScrollWidth: document.documentElement.scrollWidth,
      headingFontSize: heading instanceof HTMLElement ? Number.parseFloat(window.getComputedStyle(heading).fontSize) : 0,
      headingLeft: headingRect?.left ?? 0,
      headingTop: headingRect?.top ?? 0,
      listClientWidth: list instanceof HTMLElement ? list.clientWidth : 0,
      listScrollWidth: list instanceof HTMLElement ? list.scrollWidth : 0,
      mainLeft: mainRect.left,
      mainTop: mainRect.top,
      mainWidth: mainRect.width,
      maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
      maxRowWidth: rowWidths.length ? Math.max(...rowWidths) : 0,
      minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
      missingVisibleExpectedTexts,
      rowCount: rows.length,
      searchPlaceholder: search instanceof HTMLInputElement ? search.placeholder : '',
      searchWidth: searchRect?.width ?? 0,
      toolbarTop: searchRect?.top ?? 0,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };

    function visibleElements(items) {
      return Array.from(items).filter(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function hasVisibleText(root, expected) {
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

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, {
    expectedVisibleTexts: contract.expectedVisibleTexts ?? [],
  });

  assert(metrics.ok, metrics.reason ?? `${variant.prefix} trash contract could not run`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${variant.prefix} trash view should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.headingFontSize >= 32 && metrics.headingFontSize <= 48, `${variant.prefix} Trash heading should stay page-title scale: ${JSON.stringify(metrics)}`);
  assert(metrics.headingTop - metrics.mainTop >= 32 && metrics.headingTop - metrics.mainTop <= 120, `${variant.prefix} Trash heading should keep a Hanji top gutter: ${JSON.stringify(metrics)}`);
  assert(metrics.headingLeft - metrics.mainLeft >= (variant.mobile ? 20 : 52), `${variant.prefix} Trash heading should align to document gutter: ${JSON.stringify(metrics)}`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${variant.prefix} has expected text outside the visible screenshot: ${JSON.stringify(metrics)}`);
  assert(metrics.rowCount === contract.rowCount, `${variant.prefix} row count drifted: ${JSON.stringify(metrics)}`);
  if (contract.search) {
    assert(metrics.searchPlaceholder === 'Search trash', `${variant.prefix} search placeholder drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.countText === contract.countText, `${variant.prefix} trash count drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.searchWidth >= (variant.mobile ? 240 : 260), `${variant.prefix} search field is too cramped: ${JSON.stringify(metrics)}`);
    assert(metrics.toolbarTop > metrics.headingTop, `${variant.prefix} search toolbar should sit below the heading: ${JSON.stringify(metrics)}`);
  } else {
    assert(metrics.searchWidth === 0, `${variant.prefix} empty trash should not show search: ${JSON.stringify(metrics)}`);
  }
  if (metrics.rowCount > 0) {
    assert(metrics.actionButtonCount >= metrics.rowCount * 2, `${variant.prefix} should show restore/delete actions for every row: ${JSON.stringify(metrics)}`);
    assert(metrics.minRowHeight >= (variant.mobile ? 74 : 38), `${variant.prefix} trash rows are too cramped: ${JSON.stringify(metrics)}`);
    assert(metrics.maxRowHeight <= (variant.mobile ? 120 : 62), `${variant.prefix} trash rows are too loose: ${JSON.stringify(metrics)}`);
    assert(metrics.listScrollWidth <= metrics.listClientWidth + 4, `${variant.prefix} trash list should not need horizontal scrolling: ${JSON.stringify(metrics)}`);
  }
  if (contract.confirmDialog) {
    assert(metrics.dialogWidth >= 320 && metrics.dialogWidth <= 440, `${variant.prefix} confirm dialog width drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogLeft >= 8 && metrics.dialogRightGap >= 8, `${variant.prefix} confirm dialog should stay inside viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogTop >= 80 && metrics.dialogTop <= metrics.viewportHeight * 0.34, `${variant.prefix} confirm dialog vertical placement drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogHeight >= 140 && metrics.dialogHeight <= 260, `${variant.prefix} confirm dialog height drifted: ${JSON.stringify(metrics)}`);
  }
}

async function seedTrashWorkspace(baseUrl, { count, label }) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for trash visual smoke');

  const pages = [];
  for (let index = 0; index < count; index += 1) {
    const pageId = randomUUID();
    const title =
      index === 1
        ? `Trash visual long archived planning page ${pageId}`
        : `Trash visual ${label} ${index + 1} ${pageId.slice(0, 8)}`;
    const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'create',
      id: pageId,
      workspaceId,
      parentId: null,
      parentType: 'workspace',
      kind: 'page',
      title,
      icon: index === 2 ? '🗑️' : undefined,
      iconType: index === 2 ? 'emoji' : undefined,
      position: Date.now() + index,
    });
    assert(created?.page?.id === pageId, 'trash visual seed page must be created');

    const trashed = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'trash',
      id: pageId,
    });
    assert(
      Array.isArray(trashed?.pages) &&
        trashed.pages.some((pageRecord) => pageRecord.id === pageId && pageRecord.inTrash === true),
      'trash visual seed page must be moved to trash',
    );
    pages.push({ id: pageId, title });
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    pages,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !Array.isArray(seed.pages)) return;
  for (const page of seed.pages) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, page.id, { call: callFunction }).catch(() => {});
  }
}

async function seedSession(context, seed, appOrigin, theme = 'light') {
  await installBrowserSession(context, seed, {
    appOrigin,
    workspaceId: seed.workspaceId,
    localStorage: { 'hanji:theme': theme },
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
  console.log(`Usage: node scripts/trash-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}
