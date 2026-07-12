#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'dialogs');
const PAGE_TITLE_SELECTOR = '[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL dialog visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Dialog visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Dialog visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedDialogPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertDialogVisuals(browser, appUrl, seed);
    console.log('PASS dialog visual layout is captured and stays within the Notion-style layout contract.');
    for (const prefix of ['desktop', 'mobile', 'mobile-dark']) {
      for (const name of ['quick-find', 'comments', 'share', 'settings']) {
        console.log(`Screenshot: ${join(options.screenshotDir, `${prefix}-${name}.png`)}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertDialogVisuals(browser, appUrl, seed) {
  await assertDialogVisualsForViewport(browser, appUrl, seed, {
    prefix: 'desktop',
    viewport: { width: 1440, height: 1000 },
  });
  await assertDialogVisualsForViewport(browser, appUrl, seed, {
    mobile: true,
    prefix: 'mobile',
    viewport: { width: 390, height: 844 },
  });
  await assertDialogVisualsForViewport(browser, appUrl, seed, {
    mobile: true,
    prefix: 'mobile-dark',
    theme: 'dark',
    viewport: { width: 390, height: 844 },
  });
}

async function assertDialogVisualsForViewport(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openPage(page, appUrl, seed);
    await captureQuickFind(page, seed, variant);
    await captureComments(page, seed, variant);
    await captureShare(page, seed, variant);
    await captureSettings(page, seed, variant);
    assertNoBrowserErrors(errors, `${variant.prefix} dialog visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator(PAGE_TITLE_SELECTOR).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByText(seed.blockText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, seed.title);
}

async function captureQuickFind(page, seed, variant) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const dialog = page.getByRole('dialog', { name: 'Quick Find' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('combobox', { name: 'Quick Find' }).fill(seed.titleSearch, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('option', { name: new RegExp(escapeRegExp(seed.title)) }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await assertQuickFindContract(dialog, variant);
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} Quick Find`);
  await page.screenshot({
    path: join(options.screenshotDir, `${variant.prefix}-quick-find.png`),
    fullPage: false,
  });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function captureComments(page, seed, variant) {
  await page.getByRole('button', { name: /^1 unresolved comment on .* block$/ }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Comments' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByText(seed.blockCommentText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await assertCommentsContract(dialog, variant);
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} Comments`);
  await page.screenshot({
    path: join(options.screenshotDir, `${variant.prefix}-comments.png`),
    fullPage: false,
  });
  await dialog.getByRole('button', { name: 'Close comments' }).click({ timeout: options.timeoutMs });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function captureShare(page, seed, variant) {
  await page.getByRole('button', { name: `Share ${seed.title}` }).click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: `Share ${seed.title}` });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByText('Share to web', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText('Who has access', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await assertShareContract(dialog, variant);
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} Share`);
  await page.screenshot({
    path: join(options.screenshotDir, `${variant.prefix}-share.png`),
    fullPage: false,
  });
  await closeShareDialog(page, dialog, seed);
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function closeShareDialog(page, dialog, seed) {
  const backdrop = page.locator('button[aria-label="Close page menu"]');
  if (await backdrop.isVisible({ timeout: 1000 }).catch(() => false)) {
    await backdrop.click({ timeout: options.timeoutMs, force: true });
  } else {
    await page.mouse.click(24, 120);
  }
  if (await dialog.isHidden({ timeout: 1500 }).catch(() => false)) return;
  await page.getByRole('button', { name: `Share ${seed.title}` }).click({
    timeout: options.timeoutMs,
    force: true,
  });
}

async function captureSettings(page, seed, variant) {
  await openSettingsEntry(page, variant);
  const surface = page.locator('[data-surface="account-console"]').first();
  await surface.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await surface.getByText('Manage your profile, account security, and MCP and AI connections.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await surface.getByLabel('Profile display name').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await surface.getByLabel('Profile email').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await assertSettingsContract(surface, variant);
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} Settings`);
  await page.screenshot({
    path: join(options.screenshotDir, `${variant.prefix}-settings.png`),
    fullPage: false,
  });
  await page.goto(resolveUrl(new URL(page.url()).origin, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.waitForURL(new RegExp(`/p/${seed.pageId}(?:[/?#]|$)`), {
    timeout: options.timeoutMs,
  });
}

async function openSettingsEntry(page, variant) {
  if (variant.mobile) {
    await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: options.timeoutMs });
  }

  const visibleSettingsButton = page.getByRole('button', { name: 'Account console' }).first();
  if (await visibleSettingsButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await visibleSettingsButton.click({ timeout: options.timeoutMs });
    return;
  }

  await page.getByRole('button', { name: 'Open workspace menu' }).first().click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('menuitem', { name: 'Account console' }).first().click({
    timeout: options.timeoutMs,
  });
}

async function assertQuickFindContract(dialog, variant) {
  const metrics = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const input = el.querySelector('input[aria-label="Quick Find"]');
    const searchRow = input?.closest('[class*="searchRow"]');
    const options = Array.from(el.querySelectorAll('[role="option"]'));
    const optionRects = options.map((option) => option.getBoundingClientRect());
    const overflowItems = Array.from(el.querySelectorAll('input, [role="option"], button')).filter(
      (item) => item instanceof HTMLElement && item.scrollWidth > item.clientWidth + 2,
    ).length;
    return {
      height: rect.height,
      searchRowHeight: searchRow instanceof HTMLElement ? searchRow.getBoundingClientRect().height : 0,
      left: rect.left,
      rightGap: window.innerWidth - rect.right,
      optionCount: options.length,
      optionMaxHeight: Math.max(...optionRects.map((item) => item.height), 0),
      optionMinHeight: Math.min(...optionRects.map((item) => item.height), 999),
      overflowItems,
      top: rect.top,
      width: rect.width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  if (variant.mobile) {
    assert(metrics.width >= 360 && metrics.width <= 380, `Mobile Quick Find should fit the viewport with tight margins, got ${Math.round(metrics.width)}px`);
    assert(metrics.height >= 110 && metrics.height <= 620, `Mobile Quick Find height should stay usable, got ${Math.round(metrics.height)}px`);
    assert(metrics.top >= 14 && metrics.top <= 28, `Mobile Quick Find should open near the top, got top=${Math.round(metrics.top)}px`);
    assert(metrics.left >= 8 && metrics.left <= 14, `Mobile Quick Find should keep a left margin, got ${Math.round(metrics.left)}px`);
    assert(metrics.rightGap >= 8 && metrics.rightGap <= 14, `Mobile Quick Find should keep a right margin, got ${Math.round(metrics.rightGap)}px`);
    assert(metrics.top + metrics.height <= metrics.viewportHeight - 8, 'Mobile Quick Find should stay within the viewport.');
    assert(metrics.searchRowHeight >= 44 && metrics.searchRowHeight <= 54, `Mobile Quick Find input row should be compact, got ${Math.round(metrics.searchRowHeight)}px`);
    assert(metrics.optionCount >= 2, `Mobile Quick Find should show search/create options, got ${metrics.optionCount}`);
    assert(
      metrics.optionMinHeight >= 34 && metrics.optionMaxHeight <= 76,
      `Mobile Quick Find result rows should stay dense, got ${Math.round(metrics.optionMinHeight)}-${Math.round(metrics.optionMaxHeight)}px`,
    );
    assert(metrics.overflowItems === 0, `Mobile Quick Find should not horizontally overflow controls, got ${metrics.overflowItems} overflowing items`);
    return;
  }
  assert(metrics.width >= 580 && metrics.width <= 660, `Quick Find should be 640px-class, got ${Math.round(metrics.width)}px`);
  assert(metrics.height >= 120 && metrics.height <= 560, `Quick Find height should stay compact, got ${Math.round(metrics.height)}px`);
  assert(metrics.top >= 60 && metrics.top <= 92, `Quick Find should open below the browser chrome area, got top=${Math.round(metrics.top)}px`);
  assert(
    Math.abs(metrics.left + metrics.width / 2 - metrics.viewportWidth / 2) <= 24,
    `Quick Find should be horizontally centered, got left=${Math.round(metrics.left)} width=${Math.round(metrics.width)}`,
  );
  assert(metrics.searchRowHeight >= 46 && metrics.searchRowHeight <= 58, `Quick Find input row should be Notion-density, got ${Math.round(metrics.searchRowHeight)}px`);
  assert(metrics.optionCount >= 2, `Quick Find should show search/create options, got ${metrics.optionCount}`);
  assert(
    metrics.optionMinHeight >= 36 && metrics.optionMaxHeight <= 72,
    `Quick Find result rows should stay dense, got ${Math.round(metrics.optionMinHeight)}-${Math.round(metrics.optionMaxHeight)}px`,
  );
  assert(metrics.overflowItems === 0, `Quick Find should not horizontally overflow controls, got ${metrics.overflowItems} overflowing items`);
}

async function assertCommentsContract(dialog, variant) {
  const metrics = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const tabs = el.querySelector('[role="tablist"]');
    const composer = el.querySelector('textarea');
    const comments = Array.from(el.querySelectorAll('[data-comment-id]'));
    const title = el.querySelector('[id]');
    return {
      bottomGap: window.innerHeight - rect.bottom,
      commentCount: comments.length,
      composerHeight: composer instanceof HTMLElement ? composer.getBoundingClientRect().height : 0,
      headerText: title?.textContent?.trim() ?? '',
      height: rect.height,
      left: rect.left,
      rightGap: window.innerWidth - rect.right,
      tabCount: tabs ? tabs.querySelectorAll('[role="tab"]').length : 0,
      top: rect.top,
      width: rect.width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  if (variant.mobile) {
    assert(metrics.width >= metrics.viewportWidth - 2 && metrics.width <= metrics.viewportWidth + 2, `Mobile Comments panel should fill viewport width, got ${Math.round(metrics.width)}px in ${Math.round(metrics.viewportWidth)}px`);
    assert(Math.abs(metrics.left) <= 2, `Mobile Comments panel should start at the left edge, got left=${Math.round(metrics.left)}px`);
    assert(metrics.top >= 40 && metrics.top <= 52, `Mobile Comments panel should start below the top bar, got top=${Math.round(metrics.top)}px`);
    assert(metrics.rightGap >= -2 && metrics.rightGap <= 2, `Mobile Comments panel should end at the right edge, got gap=${Math.round(metrics.rightGap)}px`);
    assert(metrics.bottomGap >= -2 && metrics.bottomGap <= 2, `Mobile Comments panel should fill to the bottom edge, got gap=${Math.round(metrics.bottomGap)}px`);
    assert(metrics.height >= metrics.viewportHeight - 56, `Mobile Comments panel should use available height, got ${Math.round(metrics.height)}px`);
    assert(metrics.tabCount === 2, `Mobile Comments panel should expose Open/Resolved tabs, got ${metrics.tabCount}`);
    assert(metrics.commentCount >= 1, `Mobile Comments panel should show seeded thread, got ${metrics.commentCount}`);
    assert(metrics.composerHeight >= 68 && metrics.composerHeight <= 124, `Mobile Comments composer should stay compact, got ${Math.round(metrics.composerHeight)}px`);
    return;
  }
  assert(metrics.width >= 360 && metrics.width <= 410, `Comments panel should be side-panel width, got ${Math.round(metrics.width)}px`);
  assert(metrics.top >= 40 && metrics.top <= 60, `Comments panel should start below the top bar, got top=${Math.round(metrics.top)}px`);
  assert(metrics.rightGap >= 0 && metrics.rightGap <= 2, `Comments panel should dock to the right edge, got gap=${Math.round(metrics.rightGap)}px`);
  assert(metrics.bottomGap >= 0 && metrics.bottomGap <= 2, `Comments panel should fill to the bottom edge, got gap=${Math.round(metrics.bottomGap)}px`);
  assert(metrics.height >= 900, `Comments panel should use the full side-panel height, got ${Math.round(metrics.height)}px`);
  assert(metrics.tabCount === 2, `Comments panel should expose Open/Resolved tabs, got ${metrics.tabCount}`);
  assert(metrics.commentCount >= 1, `Comments panel should show seeded thread, got ${metrics.commentCount}`);
  assert(metrics.composerHeight >= 68 && metrics.composerHeight <= 120, `Comments composer should stay compact, got ${Math.round(metrics.composerHeight)}px`);
}

async function assertShareContract(dialog, variant) {
  const metrics = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const input = el.querySelector('input[aria-label="Invite people"]');
    const rows = Array.from(el.querySelectorAll('[role="switch"], [class*="shareRow"]'));
    const title = el.querySelector('[class*="shareTitle"]');
    const rowRects = rows.map((row) => row.getBoundingClientRect());
    const inputRect = input instanceof HTMLElement ? input.getBoundingClientRect() : new DOMRect();
    let placeholderFits = false;
    if (input instanceof HTMLInputElement) {
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        context.font = style.font;
        const padding =
          Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
        placeholderFits = context.measureText(input.placeholder).width + padding <= inputRect.width - 2;
      }
    }
    return {
      height: rect.height,
      inputHeight: inputRect.height,
      inputWidth: inputRect.width,
      left: rect.left,
      placeholderFits,
      rightGap: window.innerWidth - rect.right,
      rowCount: rows.length,
      rowMaxHeight: Math.max(...rowRects.map((item) => item.height), 0),
      rowMinHeight: Math.min(...rowRects.map((item) => item.height), 999),
      titleText: title?.textContent?.trim() ?? '',
      top: rect.top,
      width: rect.width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  if (variant.mobile) {
    assert(metrics.width >= 360 && metrics.width <= 374, `Mobile Share dialog should fit between viewport gutters, got ${Math.round(metrics.width)}px`);
    assert(metrics.height >= 200 && metrics.height <= 620, `Mobile Share dialog should stay usable, got ${Math.round(metrics.height)}px`);
    assert(metrics.top >= 44 && metrics.top <= 56, `Mobile Share dialog should open under the top bar, got top=${Math.round(metrics.top)}px`);
    assert(metrics.left >= 8 && metrics.left <= 14, `Mobile Share dialog should keep a left gutter, got ${Math.round(metrics.left)}px`);
    assert(metrics.rightGap >= 8 && metrics.rightGap <= 14, `Mobile Share dialog should keep a right gutter, got gap=${Math.round(metrics.rightGap)}px`);
    assert(metrics.top + metrics.height <= metrics.viewportHeight - 8, 'Mobile Share dialog should stay within the viewport.');
    assert(metrics.titleText === 'Share', `Mobile Share dialog should keep a concise title, got "${metrics.titleText}"`);
    assert(metrics.inputHeight >= 28 && metrics.inputHeight <= 38, `Mobile Share invite input should stay compact, got ${Math.round(metrics.inputHeight)}px`);
    assert(metrics.inputWidth >= 330, `Mobile Share invite input should span the menu width, got ${Math.round(metrics.inputWidth)}px`);
    assert(metrics.placeholderFits, 'Mobile Share invite placeholder should fit without clipping.');
    assert(metrics.rowCount >= 2, `Mobile Share dialog should show web sharing and access rows, got ${metrics.rowCount}`);
    assert(
      metrics.rowMinHeight >= 36 && metrics.rowMaxHeight <= 64,
      `Mobile Share rows should stay dense, got ${Math.round(metrics.rowMinHeight)}-${Math.round(metrics.rowMaxHeight)}px`,
    );
    return;
  }
  assert(metrics.width >= 300 && metrics.width <= 340, `Share dialog should be a compact menu, got ${Math.round(metrics.width)}px`);
  assert(metrics.height >= 170 && metrics.height <= 520, `Share dialog should stay compact, got ${Math.round(metrics.height)}px`);
  assert(metrics.top >= 42 && metrics.top <= 76, `Share dialog should open under the top bar, got top=${Math.round(metrics.top)}px`);
  assert(metrics.rightGap >= 8 && metrics.rightGap <= 24, `Share dialog should align near the right edge, got gap=${Math.round(metrics.rightGap)}px`);
  assert(metrics.titleText === 'Share', `Share dialog should keep a concise title, got "${metrics.titleText}"`);
  assert(metrics.inputHeight >= 28 && metrics.inputHeight <= 36, `Share invite input should stay compact, got ${Math.round(metrics.inputHeight)}px`);
  assert(metrics.rowCount >= 2, `Share dialog should show web sharing and access rows, got ${metrics.rowCount}`);
  assert(
    metrics.rowMinHeight >= 36 && metrics.rowMaxHeight <= 58,
    `Share rows should stay Notion-density, got ${Math.round(metrics.rowMinHeight)}-${Math.round(metrics.rowMaxHeight)}px`,
  );
}

async function assertSettingsContract(dialog, variant) {
  const metrics = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const nav = el.querySelector('aside');
    const header = el.querySelector('header');
    const navItems = Array.from(el.querySelectorAll('aside button, aside a'));
    const inputs = Array.from(el.querySelectorAll('input'));
    const urlPrefix = el.querySelector('[class*="urlPrefix"]');
    return {
      headerHeight: header instanceof HTMLElement ? header.getBoundingClientRect().height : 0,
      height: rect.height,
      inputCount: inputs.length,
      left: rect.left,
      navItemCount: navItems.length,
      navWidth: nav instanceof HTMLElement ? nav.getBoundingClientRect().width : 0,
      urlPrefixText: urlPrefix instanceof HTMLElement ? urlPrefix.textContent?.trim() ?? '' : '',
      top: rect.top,
      width: rect.width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  assert(!metrics.urlPrefixText.includes('notion.so'), `Account console must not show Notion's domain: ${JSON.stringify(metrics)}`);
  if (variant.mobile) {
    assert(metrics.width >= metrics.viewportWidth - 2 && metrics.width <= metrics.viewportWidth + 2, `Mobile Settings dialog should fill viewport width, got ${Math.round(metrics.width)}px in ${Math.round(metrics.viewportWidth)}px`);
    assert(metrics.height >= metrics.viewportHeight - 2 && metrics.height <= metrics.viewportHeight + 2, `Mobile Settings dialog should fill viewport height, got ${Math.round(metrics.height)}px in ${Math.round(metrics.viewportHeight)}px`);
    assert(Math.abs(metrics.top) <= 2, `Mobile Settings dialog should start at the top, got top=${Math.round(metrics.top)}px`);
    assert(Math.abs(metrics.left) <= 2, `Mobile Settings dialog should start at the left edge, got left=${Math.round(metrics.left)}px`);
    assert(metrics.navWidth >= metrics.viewportWidth - 2, `Mobile Settings dialog should expose the horizontal section nav, got ${Math.round(metrics.navWidth)}px`);
    assert(metrics.headerHeight >= 48 && metrics.headerHeight <= 66, `Mobile Settings header should stay compact, got ${Math.round(metrics.headerHeight)}px`);
    assert(metrics.inputCount >= 2, `Mobile account console should expose profile fields, got ${metrics.inputCount}`);
    return;
  }
  assert(metrics.width >= 900, `Account console should use the page body width, got ${Math.round(metrics.width)}px`);
  assert(metrics.height >= metrics.viewportHeight - 4, `Account console should fill the app height, got ${Math.round(metrics.height)}px`);
  assert(metrics.top <= 2, `Account console should start at the content top, got top=${Math.round(metrics.top)}px`);
  assert(metrics.navWidth >= 220 && metrics.navWidth <= 260, `Settings dialog nav should keep stable width, got ${Math.round(metrics.navWidth)}px`);
  assert(metrics.headerHeight >= 64 && metrics.headerHeight <= 76, `Settings header should stay page-console height, got ${Math.round(metrics.headerHeight)}px`);
  assert(metrics.navItemCount >= 3, `Settings dialog should expose the main nav items, got ${metrics.navItemCount}`);
  assert(metrics.inputCount >= 2, `Account console should expose profile fields, got ${metrics.inputCount}`);
}

async function assertNoPageHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  const maxWidth = Math.max(metrics.bodyWidth, metrics.documentWidth);
  assert(
    maxWidth <= metrics.viewportWidth + 4,
    `${label} should not create page-level horizontal overflow, got ${Math.round(maxWidth)}px in ${Math.round(metrics.viewportWidth)}px viewport`,
  );
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    ({ expected, selector }) => {
      const titleElement = document.querySelector(selector);
      if (!titleElement) return false;
      const text = titleElement instanceof HTMLElement ? titleElement.innerText : titleElement.textContent;
      return text?.trim() === expected;
    },
    { expected: title, selector: PAGE_TITLE_SELECTOR },
    { timeout: options.timeoutMs },
  );
}

async function seedDialogPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for dialog visual smoke');

  const suffix = Date.now();
  const shortSuffix = String(suffix).slice(-6);
  const pageId = randomUUID();
  const blockId = randomUUID();
  const blockCommentId = randomUUID();
  const title = `Dialog ${shortSuffix}`;
  const titleSearch = shortSuffix;
  const blockText = 'Dialog visual anchor block';
  const blockCommentText = `Seeded dialog comment ${shortSuffix}`;

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    icon: '💬',
    iconType: 'emoji',
    cover: '',
    coverPosition: 50,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'dialog visual smoke page must be created');

  const block = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText }] },
    plainText: blockText,
    position: 1,
  });
  assert(block?.block?.id === blockId, 'dialog visual smoke block must be created');

  const comment = await callFunction(baseUrl, session.accessToken, 'comment-mutation', {
    action: 'create',
    id: blockCommentId,
    pageId,
    blockId,
    parentId: null,
    body: {
      rich: [{ text: blockCommentText }],
      quote: blockText,
      quoteStart: 0,
      quoteEnd: blockText.length,
    },
    resolved: false,
  });
  assert(comment?.comment?.id === blockCommentId, 'dialog visual smoke comment must be created');

  return {
    accessToken: session.accessToken,
    blockCommentId,
    blockCommentText,
    blockId,
    blockText,
    pageId,
    refreshToken: session.refreshToken,
    title,
    titleSearch,
    workspaceId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, { call: callFunction }).catch(() => {});
}

async function seedSession(context, seed, theme = 'light') {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId, theme }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', theme);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  // Smokes own their sign-in state: keep the dev runtime's master
  // auto-login (HANJI_MASTER_DEV_AUTOLOGIN) from racing this script.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('hanji:disable-master-autologin', '1');
    } catch {
      // Storage unavailable: the smoke controls auth through its own flow.
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    const source = location.url ? ` (${location.url}:${location.lineNumber})` : '';
    errors.push(`${message.text()}${source}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (!failure.includes('CONNECTION_REFUSED')) return;
    errors.push(`${failure} ${request.method()} ${request.url()}`);
  });
  return { context, page, errors };
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

async function signIn(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  assert(typeof body?.accessToken === 'string' && body.accessToken, 'anonymous sign-in must return an access token');
  assert(typeof body?.refreshToken === 'string' && body.refreshToken, 'anonymous sign-in must return a refresh token');
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
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

  throw new Error(
    'Playwright is required for dialog visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
  );
}

function edgeBasePlaywrightCandidates() {
  const edgebaseRoot = process.env.EDGEBASE_ROOT ?? new URL('../../edgebase', import.meta.url).pathname;
  const direct = join(edgebaseRoot, 'node_modules', 'playwright');
  const pnpmRoot = join(edgebaseRoot, 'node_modules', '.pnpm');
  const candidates = [direct];

  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      if (!entry.startsWith('playwright@')) continue;
      candidates.push(join(pnpmRoot, entry, 'node_modules', 'playwright'));
    }
  }

  return candidates;
}

function resolveChromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return undefined;
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
  console.log(`Usage: node scripts/dialog-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}

function normalizeBaseUrl(url) {
  return String(url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
