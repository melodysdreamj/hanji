#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserAuthStorageKeys,
  permanentlyDeletePage,
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
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
const DEFAULT_API_URL = process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'updates-panel');
const PAGE_TITLE_SELECTOR = '[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]';

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL updates panel visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Updates panel visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Updates panel visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedReplyMentionNotification(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureUpdatesVariant(browser, appUrl, seed, {
      prefix: 'desktop-updates-panel',
      viewport: { width: 1440, height: 1000 },
      open: openDesktopUpdatesPanel,
      contract: {
        title: 'Updates',
        // The narrow sidebar column scrolls the filter tabs, so only the leading
        // tabs are asserted visible; the trailing tabs still exist (tabCount).
        expectedVisibleTexts: ['Updates', 'All', 'Unread', 'Reply mention', seed.replyPreview, 'Mark all as read'],
        minTabs: 5,
        minRows: 1,
        placement: 'sidebar-inline',
      },
    });
    await captureUpdatesVariant(browser, appUrl, seed, {
      prefix: 'desktop-mentions-filter',
      viewport: { width: 1440, height: 1000 },
      open: async (page) => {
        await openDesktopUpdatesPanel(page);
        await page.getByRole('tab', { name: /^Mentions/ }).click({ timeout: options.timeoutMs });
        await page.getByText(seed.replyPreview, { exact: true }).waitFor({
          state: 'visible',
          timeout: options.timeoutMs,
        });
      },
      contract: {
        title: 'Updates',
        expectedVisibleTexts: ['Updates', 'Mentions', 'Reply mention', seed.replyPreview],
        minTabs: 5,
        minRows: 1,
        placement: 'sidebar-inline',
      },
    });
    await captureUpdatesVariant(browser, appUrl, seed, {
      prefix: 'desktop-page-history',
      viewport: { width: 1440, height: 1000 },
      open: openDesktopPageHistory,
      contract: {
        title: 'Page history',
        expectedVisibleTexts: ['Page history', 'Current version', 'Previous', 'Next', 'All', 'Comments', 'Mentions', 'Edits'],
        minTabs: 4,
        minRows: 1,
        placement: 'topbar',
        history: true,
      },
    });
    await captureUpdatesVariant(browser, appUrl, seed, {
      prefix: 'mobile-updates-panel',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openMobileUpdatesPanel,
      contract: {
        title: 'Updates',
        // Mobile inbox is now the same inline drawer swap; trailing tabs scroll.
        expectedVisibleTexts: ['Updates', 'All', 'Unread', 'Reply mention', seed.replyPreview],
        minTabs: 5,
        minRows: 1,
        placement: 'sidebar-inline',
      },
    });

    console.log('PASS Updates panel surfaces are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-updates-panel',
      'desktop-mentions-filter',
      'desktop-page-history',
      'mobile-updates-panel',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await cleanupSeed(apiUrl, seed).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureUpdatesVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  }, {
    captureConnectionRefused: true,
    captureFunctionResponses: true,
    includeConsoleLocation: true,
  });
  await seedSession(context, seed.owner);

  try {
    await openSeedPage(page, appUrl, seed);
    await variant.open(page, seed);
    if (variant.contract.expectedVisibleTexts?.includes(seed.replyPreview)) {
      await page.getByText(seed.replyPreview, { exact: true }).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
    }
    await assertUpdatesPanelContract(page, variant.contract, { mobile: !!variant.mobile, prefix: variant.prefix });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} updates panel visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openSeedPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator(PAGE_TITLE_SELECTOR).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ expected, selector }) => {
      const titleElement = document.querySelector(selector);
      const text = titleElement instanceof HTMLElement ? titleElement.innerText : titleElement?.textContent;
      return text?.trim() === expected;
    },
    { expected: seed.title, selector: PAGE_TITLE_SELECTOR },
    { timeout: options.timeoutMs },
  );
}

// Let the inline enter animation settle before geometry is measured, otherwise the
// transient translateX offset pushes the panel edge past the sidebar bounds.
async function waitForInlineInboxSettled(page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('aside[role="dialog"][data-placement="sidebar-inline"]');
      if (!el) return false;
      const transform = getComputedStyle(el).transform;
      return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
    },
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function openDesktopUpdatesPanel(page) {
  // The sidebar entry point is labeled "Inbox"; the feed it opens is titled Updates.
  // On desktop it now renders inline inside the sidebar (Notion-style tree swap).
  await page.getByRole('button', { name: /^Inbox/ }).click({ timeout: options.timeoutMs });
  await waitForDialog(page, 'Updates');
  await waitForInlineInboxSettled(page);
}

async function openMobileUpdatesPanel(page) {
  // Mobile now swaps the drawer content to the inbox inline too (no floating panel):
  // open the drawer, tap Inbox, and let the same inline swap settle.
  await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: options.timeoutMs });
  await page.getByRole('button', { name: /^Inbox/ }).click({ timeout: options.timeoutMs });
  await waitForDialog(page, 'Updates');
  await waitForInlineInboxSettled(page);
}

async function openDesktopPageHistory(page, seed) {
  await page.getByRole('button', { name: `More actions for ${seed.title}` }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('menuitem', { name: /^Page history$/ }).click({
    timeout: options.timeoutMs,
  });
  await waitForDialog(page, 'Page history');
}

async function waitForDialog(page, name) {
  const dialog = page.getByRole('dialog', { name });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByText(name, { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function assertUpdatesPanelContract(page, contract, variant) {
  const metrics = await page.evaluate(({ title, expectedVisibleTexts }) => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      (element) => element instanceof HTMLElement && isVisible(element),
    );
    const dialog = dialogs.find((element) => element.textContent?.includes(title));
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: `missing ${title} dialog` };
    const sidebar = document.querySelector('[aria-label="Sidebar"]');
    const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : null;
    const dialogRect = dialog.getBoundingClientRect();
    const tabs = visibleElements(dialog.querySelectorAll('[role="tab"]'));
    const tablist = dialog.querySelector('[role="tablist"]');
    const tablistRect = tablist instanceof HTMLElement ? tablist.getBoundingClientRect() : null;
    const tabOverflow = tabs
      .filter((tab) => tab.scrollWidth > tab.clientWidth + 2)
      .map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const clippedTabs = tabs
      .filter((tab) => {
        const tabRect = tab.getBoundingClientRect();
        return (
          tabRect.left < dialogRect.left - 1 ||
          tabRect.right > dialogRect.right + 1 ||
          tabRect.top < dialogRect.top - 1 ||
          tabRect.bottom > dialogRect.bottom + 1
        );
      })
      .map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const rows = visibleElements(dialog.querySelectorAll('li, [role="listitem"]'));
    const list = dialog.querySelector('[role="list"]');
    const listRect = list instanceof HTMLElement ? list.getBoundingClientRect() : null;
    const rowHeights = rows.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0);
    const rowWidths = rows.map((element) => element.getBoundingClientRect().width).filter((width) => width > 0);
    const unreadDots = visibleElements(dialog.querySelectorAll('[aria-label="Unread"]'));
    const markRead = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button instanceof HTMLElement && button.getAttribute('aria-label') === 'Mark all updates as read',
    );
    const close = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button instanceof HTMLElement && button.getAttribute('aria-label') === 'Close updates',
    );
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter((item) => !hasVisibleText(dialog, item));
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      closeButtonVisible: close instanceof HTMLElement && isVisible(close),
      dialogBottomGap: window.innerHeight - dialogRect.bottom,
      dialogHeight: dialogRect.height,
      dialogLeft: dialogRect.left,
      dialogRightGap: window.innerWidth - dialogRect.right,
      dialogTop: dialogRect.top,
      dialogWidth: dialogRect.width,
      documentScrollWidth: document.documentElement.scrollWidth,
      listClientWidth: list instanceof HTMLElement ? list.clientWidth : 0,
      listHeight: listRect?.height ?? 0,
      listScrollWidth: list instanceof HTMLElement ? list.scrollWidth : 0,
      markReadVisible: markRead instanceof HTMLElement && isVisible(markRead),
      maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
      maxRowWidth: rowWidths.length ? Math.max(...rowWidths) : 0,
      minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
      missingVisibleExpectedTexts,
      rowCount: rows.length,
      clippedTabs,
      tablistClientWidth: tablist instanceof HTMLElement ? tablist.clientWidth : 0,
      tablistScrollWidth: tablist instanceof HTMLElement ? tablist.scrollWidth : 0,
      tablistWidth: tablistRect?.width ?? 0,
      tabCount: tabs.length,
      tabOverflow,
      unreadDotCount: unreadDots.length,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      sidebarLeft: sidebarRect?.left ?? null,
      sidebarRight: sidebarRect?.right ?? null,
      sidebarVisible: !!sidebarRect && sidebarRect.width > 0 && sidebarRect.right > 0 && sidebarRect.left < window.innerWidth,
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
    title: contract.title,
  });

  const inlineSidebar = contract.placement === 'sidebar-inline';
  assert(metrics.ok, metrics.reason ?? `${variant.prefix} updates panel contract could not run`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${variant.prefix} should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  if (inlineSidebar) {
    // The desktop inbox now fills the sidebar column (Notion-style page-tree swap),
    // so it lives inside the sidebar bounds and under the top rail rather than as a
    // floating overlay next to the sidebar.
    assert(
      metrics.sidebarVisible && metrics.sidebarLeft !== null && metrics.sidebarRight !== null,
      `${variant.prefix} inline inbox requires a visible sidebar: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.dialogLeft >= metrics.sidebarLeft - 2 &&
        metrics.dialogLeft + metrics.dialogWidth <= metrics.sidebarRight + 2,
      `${variant.prefix} inline inbox should sit inside the sidebar column, not float beside it: ${JSON.stringify(metrics)}`,
    );
    assert(metrics.dialogWidth >= 180, `${variant.prefix} inline inbox should fill the sidebar width: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogTop >= 60, `${variant.prefix} inline inbox should sit under the sidebar top rail: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogHeight >= 170, `${variant.prefix} inline inbox height drifted: ${JSON.stringify(metrics)}`);
  } else {
    assert(metrics.dialogWidth >= (variant.mobile ? 320 : 340) && metrics.dialogWidth <= (variant.mobile ? 390 : 430), `${variant.prefix} dialog width drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogHeight >= 170 && metrics.dialogHeight <= metrics.viewportHeight - 44, `${variant.prefix} dialog height drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogTop >= 44 && metrics.dialogTop <= 60, `${variant.prefix} dialog top drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogBottomGap >= 8, `${variant.prefix} dialog should stay inside viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogLeft >= 8 && metrics.dialogRightGap >= 8, `${variant.prefix} dialog should keep viewport side gutters: ${JSON.stringify(metrics)}`);
  }
  if (contract.placement === 'topbar') {
    assert(metrics.dialogRightGap >= 8 && metrics.dialogRightGap <= 24, `${variant.prefix} topbar panel should align to the right action cluster: ${JSON.stringify(metrics)}`);
  }
  if (contract.placement === 'mobile') {
    assert(metrics.dialogLeft >= 8 && metrics.dialogLeft <= 14, `${variant.prefix} mobile panel left gutter drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogRightGap >= 8 && metrics.dialogRightGap <= 14, `${variant.prefix} mobile panel right gutter drifted: ${JSON.stringify(metrics)}`);
  }
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${variant.prefix} has expected text outside the visible screenshot: ${JSON.stringify(metrics)}`);
  assert(metrics.tabCount >= contract.minTabs, `${variant.prefix} tab count drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.tabOverflow.length === 0, `${variant.prefix} update tabs should fit their labels/counts without internal clipping: ${JSON.stringify(metrics)}`);
  if (!inlineSidebar) {
    // The inline sidebar inbox intentionally lets its filter tabs scroll horizontally
    // in the narrow column instead of clipping, so the no-scroll contract is desktop/
    // topbar/mobile floating-panel only.
    assert(metrics.clippedTabs.length === 0, `${variant.prefix} update tabs should stay fully inside the panel: ${JSON.stringify(metrics)}`);
    assert(metrics.tablistScrollWidth <= metrics.tablistClientWidth + 4, `${variant.prefix} update tab row should not require horizontal scrolling: ${JSON.stringify(metrics)}`);
  }
  assert(metrics.rowCount >= contract.minRows, `${variant.prefix} update row count drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.closeButtonVisible, `${variant.prefix} close button should remain visible: ${JSON.stringify(metrics)}`);
  if (contract.title === 'Updates') {
    assert(metrics.markReadVisible || variant.mobile, `${variant.prefix} mark-all-read control should remain visible on desktop: ${JSON.stringify(metrics)}`);
    assert(metrics.unreadDotCount >= 1, `${variant.prefix} unread indicator should be visible for seeded unread notification: ${JSON.stringify(metrics)}`);
  }
  if (metrics.rowCount > 0) {
    assert(metrics.minRowHeight >= 52, `${variant.prefix} update rows are too cramped: ${JSON.stringify(metrics)}`);
    // The narrow sidebar column wraps the row meta line into more lines than the wider
    // floating panel, so the inline inbox allows taller rows before flagging "too loose".
    assert(metrics.maxRowHeight <= (inlineSidebar ? 140 : 96), `${variant.prefix} update rows are too loose: ${JSON.stringify(metrics)}`);
    assert(metrics.listScrollWidth <= metrics.listClientWidth + 4, `${variant.prefix} update list should not need horizontal scrolling: ${JSON.stringify(metrics)}`);
  }
  if (contract.history) {
    assert(metrics.listHeight >= 120, `${variant.prefix} page history activity list should remain visible under version controls: ${JSON.stringify(metrics)}`);
  }
}

async function seedReplyMentionNotification(baseUrl) {
  const owner = await signIn(baseUrl);
  const viewer = await signIn(baseUrl);
  assert(owner.userId !== viewer.userId, 'owner and viewer must be different users');

  const bootstrap = await callFunction(baseUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for updates panel visual smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const blockId = randomUUID();
  const ownerCommentId = randomUUID();
  const replyCommentId = randomUUID();
  const title = `Updates visual smoke ${suffix}`;
  const blockText = `Updates visual anchor block ${suffix}`;
  const ownerCommentText = `Owner comment for Updates visual smoke ${suffix}`;
  const replyPreview = `Reply mentioning owner from Updates visual smoke ${suffix}`;

  const page = await callFunction(baseUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    icon: '🔔',
    iconType: 'emoji',
    position: Date.now(),
  });
  assert(page?.page?.id === pageId, 'updates panel visual seed page must be created');

  const block = await callFunction(baseUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText }] },
    plainText: blockText,
    position: 1,
  });
  assert(block?.block?.id === blockId, 'updates panel visual seed block must be created');

  const ownerComment = await callFunction(baseUrl, owner.accessToken, 'comment-mutation', {
    action: 'create',
    id: ownerCommentId,
    pageId,
    blockId,
    body: { rich: [{ text: ownerCommentText }] },
  });
  assert(ownerComment?.comment?.id === ownerCommentId, 'updates panel visual owner comment must be created');

  const share = await callFunction(baseUrl, owner.accessToken, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'Updates visual smoke viewer',
    role: 'comment',
  });
  assert(share?.permission?.id, 'updates panel visual page share must be created');

  const reply = await callFunction(baseUrl, viewer.accessToken, 'comment-mutation', {
    action: 'create',
    id: replyCommentId,
    pageId,
    blockId,
    parentId: ownerCommentId,
    body: {
      rich: [
        { text: 'Reply mentioning ' },
        { text: 'owner', mention: 'person', userId: owner.userId },
        { text: ` from Updates visual smoke ${suffix}` },
      ],
    },
  });
  assert(reply?.comment?.id === replyCommentId, 'updates panel visual reply mention must be created');

  const notification = await waitForNotification(baseUrl, owner.accessToken, workspaceId, (item) =>
    item.kind === 'mention' &&
    item.commentId === replyCommentId &&
    item.metadata?.source === 'reply' &&
    item.metadata?.parentId === ownerCommentId &&
    !item.readAt,
  );

  return {
    owner: { ...owner, workspaceId },
    viewer,
    workspaceId,
    pageId,
    blockId,
    ownerCommentId,
    replyCommentId,
    activityKey: notification.activityKey,
    title,
    blockText,
    replyPreview,
  };
}

async function waitForNotification(baseUrl, token, workspaceId, predicate) {
  const deadline = Date.now() + options.timeoutMs;
  let lastNotifications = [];
  while (Date.now() < deadline) {
    const result = await listNotifications(baseUrl, token, workspaceId, true);
    lastNotifications = result.notifications ?? [];
    const notification = lastNotifications.find(predicate);
    if (notification) return notification;
    await delay(150);
  }
  throw new Error(`expected seeded notification, saw ${JSON.stringify(lastNotifications.slice(0, 5))}`);
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.owner?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.owner.accessToken, seed.pageId).catch(() => {});
}

async function seedSession(context, session) {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: session.refreshToken,
    workspaceId: session.workspaceId,
  });
}

async function listNotifications(baseUrl, token, workspaceId, includeRead) {
  return callFunction(baseUrl, token, 'notification-mutation', {
    action: 'list',
    workspaceId,
    includeRead,
    limit: 100,
  });
}

function parseArgs(args) {
  const parsed = {
    apiUrl: DEFAULT_API_URL,
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
  console.log(`Usage: node scripts/updates-panel-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
