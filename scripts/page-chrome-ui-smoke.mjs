#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permanentlyDeletePage, captureBrowserSession, installBrowserSession } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'page-chrome');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL page chrome UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Page chrome UI smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Page chrome UI smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedChromePage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertPageChromeUi(browser, appUrl, apiUrl, seed);
    console.log('PASS page title, icon picker, cover controls, and page chrome visual contracts persist through the product API.');
    console.log(`No-cover screenshot: ${join(options.screenshotDir, 'desktop-page-chrome-no-cover.png')}`);
    console.log(`No-cover inventory: ${join(options.screenshotDir, 'desktop-page-chrome-inventory-no-cover-options-hover.json')}`);
    console.log(`Icon screenshot: ${join(options.screenshotDir, 'desktop-page-chrome-icon.png')}`);
    console.log(`Icon inventory: ${join(options.screenshotDir, 'desktop-page-chrome-inventory-icon-idle.json')}`);
    console.log(`Cover screenshot: ${join(options.screenshotDir, 'desktop-page-chrome-cover.png')}`);
    console.log(`Cover inventory: ${join(options.screenshotDir, 'desktop-page-chrome-inventory-cover-idle.json')}`);
    console.log(`Cover dark screenshot: ${join(options.screenshotDir, 'desktop-page-chrome-cover-dark.png')}`);
    console.log(`Cover + icon screenshot: ${join(options.screenshotDir, 'desktop-page-chrome-cover-icon.png')}`);
    console.log(`Cover + icon inventory: ${join(options.screenshotDir, 'desktop-page-chrome-inventory-cover-icon-idle.json')}`);
    console.log(`Cover + icon dark screenshot: ${join(options.screenshotDir, 'desktop-page-chrome-cover-icon-dark.png')}`);
    console.log(`Cover mobile screenshot: ${join(options.screenshotDir, 'mobile-page-chrome-cover.png')}`);
    console.log(`Cover mobile inventory: ${join(options.screenshotDir, 'mobile-page-chrome-inventory-cover-idle.json')}`);
    console.log(`Cover mobile dark screenshot: ${join(options.screenshotDir, 'mobile-page-chrome-cover-dark.png')}`);
    console.log(`Korean chrome screenshot: ${join(options.screenshotDir, 'desktop-page-chrome-ko-locale.png')}`);
    console.log(`Korean chrome inventory: ${join(options.screenshotDir, 'desktop-page-chrome-ko-locale.json')}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertPageChromeUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded page', () => openPage(page, appUrl, seed.pageId, seed.initialTitle));
    await step('edit page title', () => assertTitleEdit(page, apiUrl, seed));
    await step('capture no-cover page chrome', () => captureNoCoverPageChrome(page, seed));
    await step('select and remove page icon', () => assertIconControls(page, apiUrl, seed));
    await step('add, change, and remove page cover', () => assertCoverControls(page, apiUrl, seed));
    assertNoBrowserErrors(errors, 'page chrome UI flow');
  } finally {
    await closeSeededContext(context, seed);
  }

  await step('capture Korean page chrome locale', () => assertKoreanPageChromeLocale(browser, appUrl, seed));
}

async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

async function openPage(page, baseUrl, pageId, title) {
  await page.goto(resolveUrl(baseUrl, `/p/${pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, title);
  const path = new URL(page.url()).pathname;
  assert(path === `/p/${pageId}`, `direct page route changed to ${path}`);
}

async function assertTitleEdit(page, baseUrl, seed) {
  const titleBox = page.getByRole('textbox', { name: 'Page title' });
  await titleBox.click({ timeout: options.timeoutMs });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(seed.editedTitle);
  await titleBox.press('Enter', { timeout: options.timeoutMs });
  await expectPageTitle(page, seed.editedTitle);
  await waitForSeedPage(baseUrl, seed, (persisted) => persisted?.title === seed.editedTitle, 'edited title');

  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await expectPageTitle(page, seed.editedTitle);
}

async function captureNoCoverPageChrome(page, seed) {
  await revealPageOptions(page);
  await waitForNoToasts(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: true,
    hasCover: false,
    hasIcon: false,
    mobile: false,
  });
  await writePageChromeSurfaceInventory(page, seed, {
    fileName: 'desktop-page-chrome-inventory-no-cover-options-hover.json',
    state: 'desktop-no-cover-options-hover',
    controlsVisible: true,
    hasCover: false,
    hasIcon: false,
    mobile: false,
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-page-chrome-no-cover.png'),
    fullPage: false,
  });
}

async function assertKoreanPageChromeLocale(browser, appUrl, seed) {
  const context = await browser.newContext({ locale: 'ko-KR' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await seedSession(context, seed);

  try {
    await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.waitForFunction(
      (expected) => document.body.innerText.includes(expected),
      seed.editedTitle,
      { timeout: options.timeoutMs },
    );
    await page.locator('[role="textbox"]').first().hover({ timeout: options.timeoutMs });
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector('[role="toolbar"]');
        return toolbar instanceof HTMLElement && Number.parseFloat(getComputedStyle(toolbar).opacity) >= 0.8;
      },
      undefined,
      { timeout: options.timeoutMs },
    );
    await waitForNoToasts(page);

    const inventory = await collectKoreanPageChromeLocaleInventory(page);
    assertKoreanPageChromeLocaleInventory(inventory);
    writeJsonArtifact('desktop-page-chrome-ko-locale.json', inventory);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-page-chrome-ko-locale.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'Korean page chrome locale');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function collectKoreanPageChromeLocaleInventory(page) {
  return await page.evaluate(() => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      let opacity = 1;
      let current = node;
      while (current instanceof Element) {
        const currentStyle = getComputedStyle(current);
        opacity *= Number.parseFloat(currentStyle.opacity || '1');
        if (current.matches('body')) break;
        current = current.parentElement;
      }
      return style.visibility !== 'hidden' && style.display !== 'none' && opacity > 0.2 && rect.width > 0 && rect.height > 0;
    };
    const describe = (node) => ({
      text: node?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      aria: node?.getAttribute?.('aria-label') ?? '',
      title: node?.getAttribute?.('title') ?? '',
      visible: isVisible(node),
    });
    const toolbar = document.querySelector('[role="toolbar"]');
    const toolbarControls = Array.from(toolbar?.querySelectorAll('button') ?? []).map(describe);
    const topbarPresence = document.querySelector('[data-topbar-presence]');
    const topbarShare = document.querySelector('[data-topbar-share-action]');
    const topbarLink = document.querySelector('[data-topbar-link-action]');
    const topbarComment = document.querySelector('[data-topbar-comment-action]');
    const title = document.querySelector('[role="textbox"]');
    const visibleChrome = [describe(topbarPresence), describe(topbarShare), describe(topbarLink), describe(topbarComment), ...toolbarControls]
      .filter((item) => item.visible)
      .map((item) => [item.text, item.aria, item.title].filter(Boolean).join(' '));
    const combined = visibleChrome.join(' | ');
    const englishChromeTerms = ['Share', 'Comment', 'Add cover', 'Add comment', 'Add icon', 'Page title', 'Page options']
      .filter((term) => combined.includes(term));
    return {
      language: navigator.language,
      title: describe(title),
      topbar: {
        presence: describe(topbarPresence),
        share: describe(topbarShare),
        link: describe(topbarLink),
        comment: describe(topbarComment),
      },
      pageOptions: {
        toolbar: describe(toolbar),
        controls: toolbarControls,
      },
      visibleChrome,
      englishChromeTerms,
    };
  });
}

function assertKoreanPageChromeLocaleInventory(inventory) {
  assert(
    inventory.language.toLowerCase().startsWith('ko'),
    `Korean page chrome smoke must run with a Korean browser locale: ${JSON.stringify(inventory)}`,
  );
  assert(
    inventory.topbar.share.visible && inventory.topbar.share.text === '공유',
    `Korean topbar Share action should render as 공유: ${JSON.stringify(inventory.topbar.share)}`,
  );
  assert(
    inventory.topbar.link.visible && inventory.topbar.link.aria.includes('링크'),
    `Korean topbar link-copy action should expose a Korean label: ${JSON.stringify(inventory.topbar.link)}`,
  );
  assert(
    inventory.topbar.comment.visible && inventory.topbar.comment.aria.includes('댓글'),
    `Korean topbar comment action should expose a Korean label: ${JSON.stringify(inventory.topbar.comment)}`,
  );
  const controlLabels = inventory.pageOptions.controls
    .filter((control) => control.visible)
    .map((control) => control.text || control.aria);
  for (const label of ['아이콘 추가', '커버 추가', '댓글 추가']) {
    assert(
      controlLabels.includes(label),
      `Korean page option controls should include ${label}: ${JSON.stringify(inventory.pageOptions.controls)}`,
    );
  }
  assert(
    inventory.englishChromeTerms.length === 0,
    `Korean page chrome should not leak visible English chrome labels: ${JSON.stringify(inventory)}`,
  );
}

async function assertIconControls(page, baseUrl, seed) {
  await page.getByRole('button', { name: 'Add icon' }).click({ timeout: options.timeoutMs });
  const picker = page.getByRole('dialog', { name: 'Choose icon' });
  await picker.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await picker.getByRole('option', { name: 'Choose 💡 icon' }).click({ timeout: options.timeoutMs });
  await picker.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Change page icon' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await assertPageTitleIconLayout(page);
  await settleIdleChrome(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: false,
    hasCover: false,
    hasIcon: true,
    mobile: false,
  });
  await writePageChromeSurfaceInventory(page, seed, {
    fileName: 'desktop-page-chrome-inventory-icon-idle.json',
    state: 'desktop-icon-idle',
    controlsVisible: false,
    hasCover: false,
    hasIcon: true,
    mobile: false,
  });
  await parkPointer(page);
  await waitForNoToasts(page);
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-page-chrome-icon.png'),
    fullPage: false,
  });
  await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => persisted?.icon === '💡' && persisted?.iconType === 'emoji',
    'selected emoji icon',
  );

  await page.getByRole('button', { name: 'Change page icon' }).click({ timeout: options.timeoutMs });
  await picker.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await picker.getByRole('button', { name: 'Remove icon' }).click({ timeout: options.timeoutMs });
  await picker.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Add icon' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => persisted?.icon === '' && persisted?.iconType === 'none',
    'removed page icon',
  );
  await waitForNoToasts(page);
}

async function assertPageTitleIconLayout(page) {
  const metrics = await page.evaluate(() => {
    const icon = document.querySelector('button[aria-label="Change page icon"]');
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    if (!(icon instanceof HTMLElement) || !(title instanceof HTMLElement)) {
      return { ok: false, reason: 'missing page title icon or title element' };
    }
    const iconRect = icon.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const iconStyle = getComputedStyle(icon);
    const titleStyle = getComputedStyle(title);
    return {
      ok: true,
      iconWidth: iconRect.width,
      iconHeight: iconRect.height,
      iconBottom: iconRect.bottom,
      titleTop: titleRect.top,
      iconFontSize: Number.parseFloat(iconStyle.fontSize),
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
    };
  });

  assert(metrics.ok, metrics.reason ?? 'page title icon layout contract could not run');
  assert(
    metrics.iconWidth >= 70 && metrics.iconHeight >= 70,
    `page title icon must render as a large page icon, got ${Math.round(metrics.iconWidth)}x${Math.round(metrics.iconHeight)}`,
  );
  assert(
    metrics.iconFontSize >= 64,
    `page title emoji font size must stay close to Notion-scale, got ${metrics.iconFontSize}px`,
  );
  assert(
    metrics.titleFontSize >= 36,
    `page title heading must stay page-scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    metrics.iconHeight >= metrics.titleFontSize * 1.6,
    `page title icon must not look tiny next to the heading; icon=${metrics.iconHeight}px title=${metrics.titleFontSize}px`,
  );
  assert(
    metrics.iconBottom <= metrics.titleTop + 10,
    `page title icon should sit above the title without overlapping it; iconBottom=${metrics.iconBottom} titleTop=${metrics.titleTop}`,
  );
}

async function assertCoverControls(page, baseUrl, seed) {
  // The header controls are hover-revealed; earlier steps may have parked the
  // pointer elsewhere (e.g. dismissing the icon-removal undo toast).
  await revealPageOptions(page);
  await page.getByRole('button', { name: 'Add page cover' }).click({ timeout: options.timeoutMs });
  const cover = page.getByRole('group', { name: 'Page cover' });
  await cover.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const added = await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => Boolean(persisted?.cover) && persisted?.coverPosition === 50,
    'added page cover',
  );

  await cover.hover({ timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Change page cover' }).click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Change cover' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Select cover 2' }).click({ timeout: options.timeoutMs });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => Boolean(persisted?.cover) && persisted?.cover !== added.cover,
    'changed page cover',
  );
  await captureCoverPageChrome(page, seed);
  await assertCoverIconControls(page, baseUrl, seed);

  await cover.hover({ timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Remove page cover' }).click({ timeout: options.timeoutMs });
  await cover.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => persisted?.cover === '' && persisted?.coverPosition === 50,
    'removed page cover',
  );
}

async function assertCoverIconControls(page, baseUrl, seed) {
  await revealPageOptions(page);
  await page.getByRole('button', { name: 'Add icon' }).click({ timeout: options.timeoutMs });
  const picker = page.getByRole('dialog', { name: 'Choose icon' });
  await picker.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await picker.getByRole('option', { name: 'Choose 💡 icon' }).click({ timeout: options.timeoutMs });
  await picker.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Change page icon' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await assertPageTitleIconLayout(page);
  await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => persisted?.icon === '💡' && persisted?.iconType === 'emoji' && Boolean(persisted?.cover),
    'selected emoji icon with page cover',
  );
  await captureCoverIconPageChrome(page, seed);
  await assertCoverActionsSurviveIconOverlapHover(page, baseUrl, seed);

  await page.getByRole('button', { name: 'Change page icon' }).click({ timeout: options.timeoutMs });
  await picker.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await picker.getByRole('button', { name: 'Remove icon' }).click({ timeout: options.timeoutMs });
  await picker.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Add icon' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => persisted?.icon === '' && persisted?.iconType === 'none' && Boolean(persisted?.cover),
    'removed page icon while keeping page cover',
  );
  await waitForNoToasts(page);
}

async function assertCoverActionsSurviveIconOverlapHover(page, baseUrl, seed) {
  // Regression guard (2026-07-11): with cover + icon, `.iconWrap` pulls the
  // header 42px up over the cover. That invisible strip used to swallow the
  // cover's :hover wherever the doc column overlaps the hover-revealed action
  // buttons — on full-width pages "Change cover" vanished as the pointer
  // approached it. Walk the pointer through the strip and require the actions
  // to stay visible and clickable.
  await setSeedPageFullWidth(page, baseUrl, seed, true);
  const cover = page.getByRole('group', { name: 'Page cover' });
  const coverBox = await cover.boundingBox();
  assert(coverBox, 'page cover must have a bounding box for the icon-overlap hover walk');
  await page.mouse.move(coverBox.x + coverBox.width / 2, coverBox.y + coverBox.height / 2);
  const changeButton = page.getByRole('button', { name: 'Change page cover' });
  await changeButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const buttonBox = await changeButton.boundingBox();
  assert(buttonBox, 'Change page cover button must have a bounding box');
  const coverBottom = coverBox.y + coverBox.height;
  assert(
    buttonBox.y + buttonBox.height / 2 >= coverBottom - 42,
    `cover actions are expected inside the 42px icon-overlap strip; button=${JSON.stringify(buttonBox)} coverBottom=${coverBottom}`,
  );
  const probes = [
    { label: 'cover body above the strip', x: buttonBox.x + buttonBox.width / 2, y: coverBottom - 50 },
    { label: 'strip band above the button', x: buttonBox.x + buttonBox.width / 2, y: coverBottom - 41 },
    { label: 'strip gap left of the button', x: buttonBox.x - 3, y: buttonBox.y + buttonBox.height / 2 },
    { label: 'strip band below the button', x: buttonBox.x + buttonBox.width / 2, y: coverBottom - 5 },
    { label: 'button center', x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 },
  ];
  for (const probe of probes) {
    await page.mouse.move(probe.x, probe.y);
    // Outlast the 120ms actions opacity transition before sampling.
    await page.waitForTimeout(220);
    const state = await page.evaluate(() => {
      const button = document.querySelector('[aria-label="Change page cover"]');
      if (!(button instanceof HTMLElement) || !button.parentElement) return null;
      const style = getComputedStyle(button.parentElement);
      return { opacity: Number.parseFloat(style.opacity), pointerEvents: style.pointerEvents };
    });
    assert(
      state && state.opacity >= 0.9 && state.pointerEvents !== 'none',
      `cover actions must stay hover-revealed at ${probe.label} (${Math.round(probe.x)}, ${Math.round(probe.y)}); got ${JSON.stringify(state)}`,
    );
  }
  await changeButton.click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Change cover' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  // The menu handles Escape via its own keydown listener; wait for its
  // deferred (rAF) focus hand-off so the key lands inside the dialog.
  await page.waitForFunction(
    () => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Change cover"]')),
    undefined,
    { timeout: options.timeoutMs },
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await setSeedPageFullWidth(page, baseUrl, seed, false);
}

async function setSeedPageFullWidth(page, baseUrl, seed, fullWidth) {
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'update',
    id: seed.pageId,
    workspaceId: seed.workspaceId,
    patch: { fullWidth },
  });
  await waitForSeedPage(
    baseUrl,
    seed,
    (persisted) => Boolean(persisted?.fullWidth) === fullWidth,
    `set full width ${fullWidth}`,
  );
  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  const cover = page.getByRole('group', { name: 'Page cover' });
  await cover.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForFunction(
    (expected) => {
      const doc = document.querySelector('[data-page-search-root]');
      return doc?.getAttribute('data-full-width') === expected;
    },
    fullWidth ? 'true' : 'false',
    { timeout: options.timeoutMs },
  );
}

async function captureCoverPageChrome(page, seed) {
  await assertCoverActionsReveal(page, seed, { mobile: false });
  await settleIdleChrome(page);
  await waitForNoToasts(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: false,
    mobile: false,
  });
  await writePageChromeSurfaceInventory(page, seed, {
    fileName: 'desktop-page-chrome-inventory-cover-idle.json',
    state: 'desktop-cover-idle',
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: false,
    mobile: false,
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-page-chrome-cover.png'),
    fullPage: false,
  });

  await setTheme(page, 'dark');
  await assertCoverActionsReveal(page, seed, { mobile: false });
  await settleIdleChrome(page);
  await waitForNoToasts(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: false,
    mobile: false,
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-page-chrome-cover-dark.png'),
    fullPage: false,
  });

  await setViewport(page, { width: 390, height: 844 });
  await setTheme(page, 'light');
  await assertCoverActionsReveal(page, seed, { mobile: true });
  await settleIdleChrome(page);
  await waitForNoToasts(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: false,
    mobile: true,
  });
  await writePageChromeSurfaceInventory(page, seed, {
    fileName: 'mobile-page-chrome-inventory-cover-idle.json',
    state: 'mobile-cover-idle',
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: false,
    mobile: true,
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'mobile-page-chrome-cover.png'),
    fullPage: false,
  });

  await setTheme(page, 'dark');
  await assertCoverActionsReveal(page, seed, { mobile: true });
  await settleIdleChrome(page);
  await waitForNoToasts(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: false,
    mobile: true,
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'mobile-page-chrome-cover-dark.png'),
    fullPage: false,
  });

  await setViewport(page, { width: 1280, height: 900 });
  await setTheme(page, 'light');
}

async function captureCoverIconPageChrome(page, seed) {
  await setViewport(page, { width: 1280, height: 900 });
  await setTheme(page, 'light');
  await settleIdleChrome(page);
  await waitForNoToasts(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: true,
    mobile: false,
  });
  await writePageChromeSurfaceInventory(page, seed, {
    fileName: 'desktop-page-chrome-inventory-cover-icon-idle.json',
    state: 'desktop-cover-icon-idle',
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: true,
    mobile: false,
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-page-chrome-cover-icon.png'),
    fullPage: false,
  });

  await setTheme(page, 'dark');
  await settleIdleChrome(page);
  await waitForNoToasts(page);
  await assertPageChromeVisualContract(page, seed, {
    controlsVisible: false,
    coverActionsVisible: false,
    hasCover: true,
    hasIcon: true,
    mobile: false,
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-page-chrome-cover-icon-dark.png'),
    fullPage: false,
  });

  await setTheme(page, 'light');
}

function pageChromeReferenceInventory() {
  return {
    sourceUrl: 'https://app.notion.com/p/Notion-38afebeb4f9a80bcb487fe0139c8132d',
    artifacts: {
      pageChrome: '.edgebase/notion-reference/current/notion-page-chrome-current-2026-06-26.json',
      pageIconIdle: '.edgebase/notion-reference/current/notion-page-icon-idle-current.json',
      inlineActions: '.edgebase/notion-reference/current/notion-page-inline-actions-current-2026-06-26.json',
      livePage: '.edgebase/notion-reference/current/live-notion-page-reference-2026-06-26.png',
    },
    normalizedContract: {
      topbar: [
        'Comment is icon-sized',
        'Share is a compact readable bordered action with a lock affordance',
        'favorite and more are uniformly sized icon actions',
        'the action rail stays one row and does not overlap the viewport edge',
      ],
      pageOptions: [
        'Add icon, Add cover, and Add comment are hover/focus page chrome, not persistent idle chrome',
        'when revealed, page options stay one compact row and labels fit',
        'idle screenshots must not normalize accidental hover or focus leakage',
      ],
      titleIconCover: [
        'page title remains page-scale inside the document column',
        'large page icons are page-chrome scale, not body/sidebar icon scale',
        'cover actions reveal only on cover hover/focus',
        'cover plus icon states visibly overlap the icon across the cover edge',
      ],
      localDeviationPolicy:
        'Use Hanji labels/tokens and responsive gutters while preserving the current-Notion reveal rules and hierarchy.',
    },
  };
}

async function writePageChromeSurfaceInventory(page, seed, opts) {
  const inventory = {
    surface: 'page-chrome',
    state: opts.state,
    expected: {
      title: seed.editedTitle,
      controlsVisible: opts.controlsVisible,
      coverActionsVisible: opts.coverActionsVisible ?? false,
      hasCover: opts.hasCover,
      hasIcon: opts.hasIcon,
      mobile: opts.mobile,
    },
    reference: pageChromeReferenceInventory(),
    local: await collectPageChromeSurfaceInventory(page),
  };
  assertPageChromeSurfaceInventory(inventory);
  writeJsonArtifact(opts.fileName, inventory);
}

function writeJsonArtifact(fileName, payload) {
  writeFileSync(join(options.screenshotDir, fileName), `${JSON.stringify(payload, null, 2)}\n`);
}

async function collectPageChromeSurfaceInventory(page) {
  return await page.evaluate(() => {
    const readRect = (node) => {
      if (!(node instanceof Element)) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        bottom: Math.round(rect.bottom * 100) / 100,
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
      };
    };
    const styleOf = (node) => (node instanceof Element ? getComputedStyle(node) : null);
    const opacityOf = (node) => {
      const style = styleOf(node);
      return style ? Number.parseFloat(style.opacity || '1') : null;
    };
    const effectiveOpacityOf = (node) => {
      if (!(node instanceof Element)) return null;
      let current = node;
      let opacity = 1;
      while (current instanceof Element) {
        const style = getComputedStyle(current);
        opacity *= Number.parseFloat(style.opacity || '1');
        if (current.matches('body')) break;
        current = current.parentElement;
      }
      return opacity;
    };
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const effectiveOpacity = effectiveOpacityOf(node) ?? Number.parseFloat(style.opacity || '1');
      return style.visibility !== 'hidden' && style.display !== 'none' && effectiveOpacity > 0.2 && rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const controlInfo = (node) => {
      const label = node?.getAttribute?.('aria-label') ?? textOf(node);
      const style = styleOf(node);
      return {
        label,
        text: textOf(node),
        opacity: opacityOf(node),
        effectiveOpacity: effectiveOpacityOf(node),
        visible: isVisible(node),
        rect: readRect(node),
        fontSize: style ? Number.parseFloat(style.fontSize) : null,
      };
    };

    const doc = document.querySelector('[data-page-search-root]');
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Page options"]');
    const toolbarButtons = Array.from(toolbar?.querySelectorAll('button') ?? []).filter(
      (button) => button instanceof HTMLButtonElement,
    );
    const icon = document.querySelector('button[aria-label="Change page icon"]');
    const cover = document.querySelector('[role="group"][aria-label="Page cover"]');
    const coverChange = document.querySelector('button[aria-label="Change page cover"]');
    const coverRemove = document.querySelector('button[aria-label="Remove page cover"]');
    const coverActions = coverChange instanceof HTMLElement ? coverChange.parentElement : null;
    const topbar = document.querySelector('header');
    const topbarPresence = document.querySelector('[data-topbar-presence]');
    const topbarComment = document.querySelector('[data-topbar-comment-action]');
    const topbarShare = document.querySelector('[data-topbar-share-action]');
    const topbarLink = document.querySelector('[data-topbar-link-action]');
    const topbarIconActions = Array.from(document.querySelectorAll('[data-topbar-icon-action]')).filter(
      (item) => item instanceof HTMLElement,
    );
    const titleStyle = styleOf(title);
    const iconStyle = styleOf(icon);
    const shareStyle = styleOf(topbarShare);
    const iconRect = readRect(icon);
    const coverRect = readRect(cover);

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      theme: document.documentElement.dataset.theme ?? window.localStorage.getItem('hanji:theme') ?? null,
      document: {
        rect: readRect(doc),
        scrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      },
      title: {
        text: textOf(title),
        rect: readRect(title),
        fontSize: titleStyle ? Number.parseFloat(titleStyle.fontSize) : null,
        visible: isVisible(title),
      },
      pageOptions: {
        present: toolbar instanceof HTMLElement,
        visible: isVisible(toolbar),
        opacity: opacityOf(toolbar),
        effectiveOpacity: effectiveOpacityOf(toolbar),
        rect: readRect(toolbar),
        controls: toolbarButtons.map(controlInfo),
      },
      icon: {
        present: icon instanceof HTMLElement,
        visible: isVisible(icon),
        rect: iconRect,
        fontSize: iconStyle ? Number.parseFloat(iconStyle.fontSize) : null,
      },
      cover: {
        present: cover instanceof HTMLElement,
        visible: isVisible(cover),
        rect: coverRect,
        actionsVisible: isVisible(coverActions),
        actionsOpacity: opacityOf(coverActions),
        actionsEffectiveOpacity: effectiveOpacityOf(coverActions),
        controls: [coverChange, coverRemove].filter((node) => node instanceof HTMLElement).map(controlInfo),
      },
      topbar: {
        present: topbar instanceof HTMLElement,
        rect: readRect(topbar),
        presence: controlInfo(topbarPresence),
        comment: controlInfo(topbarComment),
        link: controlInfo(topbarLink),
        share: {
          ...controlInfo(topbarShare),
          borderWidth: shareStyle ? Number.parseFloat(shareStyle.borderTopWidth) : null,
          borderColor: shareStyle?.borderTopColor ?? null,
        },
        iconActions: topbarIconActions.map(controlInfo),
      },
      relationships: {
        iconCoverOverlap:
          iconRect && coverRect ? Math.round((coverRect.bottom - iconRect.top) * 100) / 100 : null,
        titleIconGap:
          iconRect && title instanceof Element
            ? Math.round((title.getBoundingClientRect().top - iconRect.bottom) * 100) / 100
            : null,
        titleCoverGap:
          coverRect && title instanceof Element
            ? Math.round((title.getBoundingClientRect().top - coverRect.bottom) * 100) / 100
            : null,
      },
    };
  });
}

function assertPageChromeSurfaceInventory(inventory) {
  const { expected, local, state } = inventory;
  assert(local.title.visible, `page chrome inventory must include visible title: ${JSON.stringify(inventory)}`);
  assert(local.title.text === expected.title, `page chrome inventory title drifted: ${JSON.stringify(local.title)}`);
  assert(
    local.document.scrollWidth <= local.viewport.width + 4,
    `page chrome inventory should not have page-level horizontal overflow: ${JSON.stringify(local.document)}`,
  );
  assert(
    local.title.fontSize >= 34 && local.title.fontSize <= 44,
    `page chrome inventory title should stay page-scale: ${JSON.stringify(local.title)}`,
  );
  assertTopbarSurfaceInventory(local.topbar, expected.mobile, local.viewport);

  const optionLabels = local.pageOptions.controls.map((control) => control.text || control.label);
  if (expected.controlsVisible) {
    assert(local.pageOptions.visible, `page options should be visible for ${state}: ${JSON.stringify(local.pageOptions)}`);
    for (const label of ['Add icon', 'Add cover', 'Add comment']) {
      assert(optionLabels.includes(label), `page options inventory missing ${label}: ${JSON.stringify(local.pageOptions)}`);
    }
  } else {
    assert(!local.pageOptions.visible, `page options should be idle-hidden for ${state}: ${JSON.stringify(local.pageOptions)}`);
  }
  if (expected.hasCover && expected.hasIcon) {
    assert(
      !optionLabels.includes('Add comment'),
      `cover + icon page chrome should not leave a floating Add comment control in the page header; use the topbar comment action instead: ${JSON.stringify(local.pageOptions)}`,
    );
  }

  if (expected.hasIcon) {
    assert(local.icon.present && local.icon.visible, `page icon should be visible for ${state}: ${JSON.stringify(local.icon)}`);
    assert(
      local.icon.rect.width >= 70 && local.icon.rect.height >= 70 && local.icon.fontSize >= 64,
      `page icon should stay large page-chrome scale for ${state}: ${JSON.stringify(local.icon)}`,
    );
  } else {
    assert(!local.icon.present, `page icon should not be present for ${state}: ${JSON.stringify(local.icon)}`);
  }

  if (expected.hasCover) {
    assert(local.cover.present && local.cover.visible, `page cover should be visible for ${state}: ${JSON.stringify(local.cover)}`);
    assert(local.cover.rect.height >= (expected.mobile ? 128 : 140), `page cover height too small for ${state}: ${JSON.stringify(local.cover)}`);
    if (expected.coverActionsVisible) {
      assert(local.cover.actionsVisible, `cover actions should reveal for ${state}: ${JSON.stringify(local.cover)}`);
    } else {
      assert(!local.cover.actionsVisible, `cover actions should stay idle-hidden for ${state}: ${JSON.stringify(local.cover)}`);
    }
  } else {
    assert(!local.cover.present, `page cover should not be present for ${state}: ${JSON.stringify(local.cover)}`);
  }

  if (expected.hasCover && expected.hasIcon) {
    assert(
      local.relationships.iconCoverOverlap >= 28 && local.relationships.titleIconGap >= -4,
      `cover + icon inventory should preserve visible overlap and title relationship: ${JSON.stringify(local.relationships)}`,
    );
  }
}

function assertTopbarSurfaceInventory(topbar, mobile, viewport) {
  assert(topbar.present, `page topbar inventory missing topbar: ${JSON.stringify(topbar)}`);
  assert(topbar.share.visible && topbar.share.text === 'Share', `page topbar Share should be a visible readable action: ${JSON.stringify(topbar.share)}`);
  assert(topbar.share.rect.width >= 58 && topbar.share.rect.width <= 84, `page topbar Share width drifted: ${JSON.stringify(topbar.share)}`);
  assert(topbar.share.borderWidth >= 0.5 && topbar.share.borderColor !== 'rgba(0, 0, 0, 0)', `page topbar Share should keep a compact bordered sharing affordance: ${JSON.stringify(topbar.share)}`);
  assert(topbar.link.visible, `page topbar link-copy action should be visible after Share: ${JSON.stringify(topbar.link)}`);
  assert(topbar.link.rect.width >= 27 && topbar.link.rect.width <= 30, `page topbar link-copy action width drifted: ${JSON.stringify(topbar.link)}`);
  assert(topbar.comment.visible, `page topbar Comment should be visible after link copy as an icon action: ${JSON.stringify(topbar.comment)}`);
  assert(topbar.comment.rect.width >= 26 && topbar.comment.rect.width <= 30, `page topbar Comment should stay icon-sized: ${JSON.stringify(topbar.comment)}`);
  assert(topbar.share.rect.left < topbar.link.rect.left && topbar.link.rect.left < topbar.comment.rect.left, `page topbar actions should follow Share, link, Comment order: ${JSON.stringify(topbar)}`);
  if (topbar.presence.visible) {
    assert(topbar.presence.rect.width >= 20 && topbar.presence.rect.width <= 80, `page topbar presence avatars should stay compact: ${JSON.stringify(topbar.presence)}`);
    assert(topbar.presence.rect.right <= topbar.share.rect.left + 4, `page topbar presence should sit before Share: ${JSON.stringify(topbar)}`);
  }
  assert(topbar.iconActions.length >= 3, `page topbar should expose link/favorite/more icon actions: ${JSON.stringify(topbar)}`);
  for (const action of topbar.iconActions) {
    assert(action.visible, `page topbar icon action should be visible: ${JSON.stringify(action)}`);
    assert(action.rect.width >= 27 && action.rect.width <= 30, `page topbar icon action width drifted: ${JSON.stringify(action)}`);
  }
  assert(
    topbar.comment.rect.right <= viewport.width - (mobile ? 6 : 12) &&
      topbar.share.rect.right <= viewport.width - (mobile ? 6 : 12) &&
      topbar.link.rect.right <= viewport.width - (mobile ? 6 : 12) &&
      topbar.iconActions.every((action) => action.rect.right <= topbar.rect.right + 1) &&
      topbar.iconActions.every((action) => action.rect.right <= viewport.width - (mobile ? 6 : 12)),
    `page topbar actions should stay inside the viewport rail: ${JSON.stringify({ topbar, viewport })}`,
  );
}

async function revealPageOptions(page) {
  await page.getByRole('textbox', { name: 'Page title' }).hover({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => {
      const toolbar = document.querySelector('[role="toolbar"][aria-label="Page options"]');
      return toolbar instanceof HTMLElement && Number.parseFloat(getComputedStyle(toolbar).opacity) >= 0.8;
    },
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function revealCoverActions(page) {
  await page.getByRole('group', { name: 'Page cover' }).hover({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => {
      const cover = document.querySelector('[role="group"][aria-label="Page cover"]');
      const change = document.querySelector('button[aria-label="Change page cover"]');
      if (!(cover instanceof HTMLElement) || !(change instanceof HTMLElement)) return false;
      return Number.parseFloat(getComputedStyle(change.parentElement ?? change).opacity) >= 0.8;
    },
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function assertCoverActionsReveal(page, _seed, { mobile }) {
  await settleIdleChrome(page);
  await revealCoverActions(page);
  const metrics = await page.evaluate(() => {
    const cover = document.querySelector('[role="group"][aria-label="Page cover"]');
    const change = document.querySelector('button[aria-label="Change page cover"]');
    const remove = document.querySelector('button[aria-label="Remove page cover"]');
    const actions = change instanceof HTMLElement ? change.parentElement : null;
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        right: r.right,
        height: r.height,
      };
    };
    const actionStyle = actions instanceof HTMLElement ? getComputedStyle(actions) : null;
    return {
      coverExists: cover instanceof HTMLElement,
      changeExists: change instanceof HTMLElement,
      removeExists: remove instanceof HTMLElement,
      actionsOpacity: actionStyle ? Number.parseFloat(actionStyle.opacity) : null,
      changeHeight: change instanceof HTMLElement ? rect(change).height : null,
      removeHeight: remove instanceof HTMLElement ? rect(remove).height : null,
      actionsRight: actions instanceof HTMLElement ? rect(actions).right : null,
      viewportWidth: window.innerWidth,
    };
  });
  assert(metrics.coverExists, `cover actions reveal check needs a page cover: ${JSON.stringify(metrics)}`);
  assert(metrics.changeExists && metrics.removeExists, `cover actions should exist on editable covers: ${JSON.stringify(metrics)}`);
  assert(metrics.actionsOpacity >= 0.8, `cover actions should reveal on cover hover: ${JSON.stringify(metrics)}`);
  assert(metrics.changeHeight >= 26 && metrics.changeHeight <= 32, `cover Change action height drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.removeHeight >= 26 && metrics.removeHeight <= 32, `cover Remove action height drifted: ${JSON.stringify(metrics)}`);
  assert(
    metrics.actionsRight <= metrics.viewportWidth - (mobile ? 10 : 18),
    `cover actions should stay inside the viewport on hover: ${JSON.stringify(metrics)}`,
  );
}

async function waitForNoToasts(page) {
  // Action toasts (e.g. "Removed icon — Undo") persist BY DESIGN until acted
  // on or dismissed (see store.notify). Dismiss anything lingering the way a
  // user would, then wait for the transient ones to expire.
  const dismissButtons = page.getByRole('button', { name: 'Dismiss notification' });
  for (let i = await dismissButtons.count(); i > 0; i -= 1) {
    await dismissButtons.first().click({ timeout: options.timeoutMs }).catch(() => {});
  }
  await page.waitForFunction(
    () => document.querySelector('[role="status"]') === null,
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function parkPointer(page) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
  await page.mouse.move(Math.max(16, viewport.width - 24), Math.max(16, viewport.height - 24));
  await page.waitForTimeout(80);
}

async function settleIdleChrome(page) {
  await parkPointer(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(160);
}

async function assertPageChromeVisualContract(page, seed, opts) {
  const metrics = await page.evaluate(({ expectedTitle, opts }) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const doc = document.querySelector('[data-page-search-root]');
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Page options"]');
    const icon = document.querySelector('button[aria-label="Change page icon"]');
    const cover = document.querySelector('[role="group"][aria-label="Page cover"]');
    const coverChange = document.querySelector('button[aria-label="Change page cover"]');
    const coverRemove = document.querySelector('button[aria-label="Remove page cover"]');
    const topbar = document.querySelector('header');
    const topbarShare = document.querySelector('[data-topbar-share-action]');
    const topbarLink = document.querySelector('[data-topbar-link-action]');
    const topbarComment = document.querySelector('[data-topbar-comment-action]');
    const topbarIconActions = Array.from(document.querySelectorAll('[data-topbar-icon-action]'));
    const starter = document.querySelector('[aria-label="Page starter"]');
    const starterActions = Array.from(document.querySelectorAll('[data-page-starter-action]'));

    if (
      !(doc instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(topbar instanceof HTMLElement) ||
      !(topbarShare instanceof HTMLElement) ||
      !(topbarLink instanceof HTMLElement) ||
      !(topbarComment instanceof HTMLElement) ||
      topbarIconActions.some((item) => !(item instanceof HTMLElement))
    ) {
      return { ok: false, reason: 'missing page document or title' };
    }

    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const textOf = (element) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const titleRect = rect(title);
    const docRect = rect(doc);
    const titleStyle = getComputedStyle(title);
    const toolbarStyle = toolbar instanceof HTMLElement ? getComputedStyle(toolbar) : null;
    const toolbarRect = toolbar instanceof HTMLElement ? rect(toolbar) : null;
    const toolbarButtons = Array.from(toolbar?.querySelectorAll('button') ?? []).map((button) => {
      const r = rect(button);
      const label = button.querySelector('span');
      const labelRect = label instanceof HTMLElement ? rect(label) : null;
      return {
        text: textOf(button),
        height: r.height,
        width: r.width,
        labelWidth: labelRect?.width ?? null,
        labelScrollWidth: label instanceof HTMLElement ? label.scrollWidth : null,
      };
    });
    const iconRect = icon instanceof HTMLElement ? rect(icon) : null;
    const iconStyle = icon instanceof HTMLElement ? getComputedStyle(icon) : null;
    const coverRect = cover instanceof HTMLElement ? rect(cover) : null;
    const coverChangeRect = coverChange instanceof HTMLElement ? rect(coverChange) : null;
    const coverRemoveRect = coverRemove instanceof HTMLElement ? rect(coverRemove) : null;
    const coverActions = coverChange instanceof HTMLElement ? coverChange.parentElement : null;
    const coverActionsStyle = coverActions instanceof HTMLElement ? getComputedStyle(coverActions) : null;
    const topbarRect = rect(topbar);
    const topbarPresence = document.querySelector('[data-topbar-presence]');
    const topbarPresenceRect = topbarPresence instanceof HTMLElement ? rect(topbarPresence) : null;
    const topbarShareRect = rect(topbarShare);
    const topbarLinkRect = rect(topbarLink);
    const topbarCommentRect = rect(topbarComment);
    const topbarShareStyle = getComputedStyle(topbarShare);
    const topbarIconActionRects = topbarIconActions.map((item) => rect(item));
    const starterRect = starter instanceof HTMLElement ? rect(starter) : null;
    const starterActionRects = starterActions
      .filter((item) => item instanceof HTMLElement)
      .map((item) => rect(item));
    const topbarActionRects = [
      ...(topbarPresenceRect ? [topbarPresenceRect] : []),
      topbarShareRect,
      topbarCommentRect,
      ...topbarIconActionRects,
    ].sort(
      (a, b) => a.left - b.left,
    );
    const topbarActionCenters = [
      topbarCommentRect.top + topbarCommentRect.height / 2,
      topbarShareRect.top + topbarShareRect.height / 2,
      ...topbarIconActionRects.map((item) => item.top + item.height / 2),
    ];
    const topbarIconWidths = topbarIconActionRects.map((item) => item.width);
    const topbarIconHeights = topbarIconActionRects.map((item) => item.height);

    return {
      ok: true,
      viewportWidth,
      viewportHeight,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      titleText: textOf(title),
      titleLeft: titleRect.left,
      titleRight: titleRect.right,
      titleTop: titleRect.top,
      titleHeight: titleRect.height,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      docLeft: docRect.left,
      docRight: docRect.right,
      docWidth: docRect.width,
      toolbarExists: toolbar instanceof HTMLElement,
      toolbarOpacity: toolbarStyle ? Number.parseFloat(toolbarStyle.opacity) : null,
      toolbarTop: toolbarRect?.top ?? null,
      toolbarLeft: toolbarRect?.left ?? null,
      toolbarHeight: toolbarRect?.height ?? null,
      toolbarButtons,
      iconExists: icon instanceof HTMLElement,
      iconLeft: iconRect?.left ?? null,
      iconRight: iconRect?.right ?? null,
      iconTop: iconRect?.top ?? null,
      iconBottom: iconRect?.bottom ?? null,
      iconWidth: iconRect?.width ?? null,
      iconHeight: iconRect?.height ?? null,
      iconFontSize: iconStyle ? Number.parseFloat(iconStyle.fontSize) : null,
      coverExists: cover instanceof HTMLElement,
      coverLeft: coverRect?.left ?? null,
      coverRight: coverRect?.right ?? null,
      coverTop: coverRect?.top ?? null,
      coverBottom: coverRect?.bottom ?? null,
      coverWidth: coverRect?.width ?? null,
      coverHeight: coverRect?.height ?? null,
      coverChangeHeight: coverChangeRect?.height ?? null,
      coverRemoveHeight: coverRemoveRect?.height ?? null,
      coverActionsOpacity: coverActionsStyle ? Number.parseFloat(coverActionsStyle.opacity) : null,
      coverActionsRight: coverActions instanceof HTMLElement ? rect(coverActions).right : null,
      starterExists: starter instanceof HTMLElement,
      starterTop: starterRect?.top ?? null,
      starterBottom: starterRect?.bottom ?? null,
      starterActionCount: starterActionRects.length,
      starterActionMaxBottom:
        starterActionRects.length > 0 ? Math.max(...starterActionRects.map((item) => item.bottom)) : null,
      topbarLeft: topbarRect.left,
      topbarRight: topbarRect.right,
      topbarHeight: topbarRect.height,
      topbarShareText: textOf(topbarShare),
      topbarPresenceLeft: topbarPresenceRect?.left ?? null,
      topbarPresenceRight: topbarPresenceRect?.right ?? null,
      topbarPresenceWidth: topbarPresenceRect?.width ?? null,
      topbarShareLeft: topbarShareRect.left,
      topbarShareRight: topbarShareRect.right,
      topbarShareWidth: topbarShareRect.width,
      topbarShareHeight: topbarShareRect.height,
      topbarShareBorderWidth: Number.parseFloat(topbarShareStyle.borderTopWidth),
      topbarShareBorderColor: topbarShareStyle.borderTopColor,
      topbarLinkLeft: topbarLinkRect?.left ?? null,
      topbarLinkRight: topbarLinkRect?.right ?? null,
      topbarLinkWidth: topbarLinkRect?.width ?? null,
      topbarLinkHeight: topbarLinkRect?.height ?? null,
      topbarCommentLeft: topbarCommentRect.left,
      topbarCommentRight: topbarCommentRect.right,
      topbarCommentWidth: topbarCommentRect.width,
      topbarCommentHeight: topbarCommentRect.height,
      topbarIconActionCount: topbarIconActionRects.length,
      topbarIconActionMinWidth: Math.min(...topbarIconWidths),
      topbarIconActionMaxWidth: Math.max(...topbarIconWidths),
      topbarIconActionMinHeight: Math.min(...topbarIconHeights),
      topbarIconActionMaxHeight: Math.max(...topbarIconHeights),
      topbarActionCenterSpread: Math.max(...topbarActionCenters) - Math.min(...topbarActionCenters),
      topbarActionRailLeft: topbarActionRects[0]?.left ?? null,
      topbarActionRailRight: topbarActionRects.at(-1)?.right ?? null,
      topbarActionRailWidth:
        topbarActionRects.length > 0
          ? (topbarActionRects.at(-1)?.right ?? 0) - (topbarActionRects[0]?.left ?? 0)
          : null,
      topbarActionOverlapCount: topbarActionRects.reduce((count, item, index) => {
        if (index === 0) return count;
        return item.left < topbarActionRects[index - 1].right - 1 ? count + 1 : count;
      }, 0),
    };
  }, {
    expectedTitle: seed.editedTitle,
    opts,
  });

  assert(metrics.ok, metrics.reason ?? 'page chrome visual contract could not run');
  assert(metrics.titleText === seed.editedTitle, `page chrome title should render edited title: ${JSON.stringify(metrics)}`);
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `page chrome should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.titleFontSize >= 34 && metrics.titleFontSize <= 44,
    `page title should stay page-scale without becoming body text or hero text: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.titleLeft >= metrics.docLeft - 1 && metrics.titleRight <= metrics.docRight + 1,
    `page title should stay inside the document column: ${JSON.stringify(metrics)}`,
  );
  assertTopbarActionRailContract(metrics, opts);

  if (opts.mobile) {
    assert(metrics.viewportWidth <= 430, `mobile page chrome contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(
      metrics.titleLeft >= 20 && metrics.titleRight <= metrics.viewportWidth - 20,
      `mobile document gutter drifted: ${JSON.stringify(metrics)}`,
    );
    if (opts.hasCover) {
      assert(metrics.starterExists, `mobile cover page should expose page starter actions: ${JSON.stringify(metrics)}`);
      assert(metrics.starterActionCount >= 4, `mobile cover page starter should keep its core actions available: ${JSON.stringify(metrics)}`);
      assert(
        metrics.starterActionMaxBottom <= metrics.viewportHeight - 12,
        `mobile cover page starter actions should not be clipped at the first viewport edge: ${JSON.stringify(metrics)}`,
      );
    }
  } else {
    assert(metrics.docWidth >= 560 && metrics.docWidth <= 900, `desktop page document width drifted: ${JSON.stringify(metrics)}`);
  }

  if (opts.controlsVisible) {
    assert(metrics.toolbarExists, `page options toolbar should exist: ${JSON.stringify(metrics)}`);
    assert(metrics.toolbarOpacity >= 0.8, `page options should reveal as compact hover chrome: ${JSON.stringify(metrics)}`);
    assert(metrics.toolbarHeight >= 22 && metrics.toolbarHeight <= 28, `page options toolbar height drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.toolbarButtons.length >= 3, `page options should expose icon/cover/comment controls: ${JSON.stringify(metrics)}`);
    for (const button of metrics.toolbarButtons) {
      assert(button.height >= 22 && button.height <= 28, `page option button should stay compact: ${JSON.stringify(button)}`);
      assert(
        button.labelWidth === null || button.labelScrollWidth === null || button.labelScrollWidth <= button.labelWidth + 2,
        `page option label should not clip or ellipsize in its normal desktop state: ${JSON.stringify(button)}`,
      );
    }
  } else if (metrics.toolbarExists) {
    assert(
      metrics.toolbarOpacity <= 0.25,
      `page options should stay hidden in idle visual evidence: ${JSON.stringify(metrics)}`,
    );
  }

  if (opts.hasIcon) {
    assert(metrics.iconExists, `page title icon should exist: ${JSON.stringify(metrics)}`);
    assert(metrics.iconWidth >= 70 && metrics.iconHeight >= 70, `page title icon size drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.iconFontSize >= 64, `page title icon glyph should not render as body text: ${JSON.stringify(metrics)}`);
    assert(
      metrics.iconLeft >= metrics.docLeft - 6 && metrics.iconRight <= metrics.docRight + 6,
      `page title icon should stay anchored to the document column: ${JSON.stringify(metrics)}`,
    );
  } else {
    assert(!metrics.iconExists, `page title icon should not be visible in this capture: ${JSON.stringify(metrics)}`);
  }

  if (opts.hasCover) {
    assert(metrics.coverExists, `page cover should exist: ${JSON.stringify(metrics)}`);
    assert(
      metrics.coverWidth >= metrics.docWidth &&
        metrics.coverLeft <= metrics.docLeft + 2 &&
        metrics.coverRight <= metrics.viewportWidth + 2,
      `page cover should span the app content area without overflowing the viewport: ${JSON.stringify(metrics)}`,
    );
    assert(metrics.coverHeight >= (opts.mobile ? 128 : 140) && metrics.coverHeight <= (opts.mobile ? 260 : 300), `page cover height drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.titleTop > metrics.coverBottom + 28, `page title should sit below cover with breathing room: ${JSON.stringify(metrics)}`);
    if (opts.hasIcon) {
      assert(
        metrics.iconTop < metrics.coverBottom && metrics.iconBottom > metrics.coverBottom + 20,
        `cover + icon page chrome should let the large icon overlap the cover edge: ${JSON.stringify(metrics)}`,
      );
      assert(
        metrics.coverBottom - metrics.iconTop >= 28 && metrics.coverBottom - metrics.iconTop <= metrics.iconHeight - 16,
        `cover + icon overlap should be visible but not swallow the page icon: ${JSON.stringify(metrics)}`,
      );
      assert(
        metrics.titleTop >= metrics.iconBottom - 4 && metrics.titleTop <= metrics.iconBottom + 56,
        `cover + icon title should sit directly below the large icon: ${JSON.stringify(metrics)}`,
      );
      assert(
        Math.abs(metrics.titleLeft - metrics.iconLeft) <= 10,
        `cover + icon title and icon should share the same document-column anchor: ${JSON.stringify(metrics)}`,
      );
    }
    if (opts.coverActionsVisible) {
      assert(metrics.coverActionsOpacity >= 0.8, `cover actions should reveal on cover hover: ${JSON.stringify(metrics)}`);
      assert(metrics.coverChangeHeight >= 26 && metrics.coverChangeHeight <= 32, `cover Change action height drifted: ${JSON.stringify(metrics)}`);
      assert(metrics.coverRemoveHeight >= 26 && metrics.coverRemoveHeight <= 32, `cover Remove action height drifted: ${JSON.stringify(metrics)}`);
      assert(metrics.coverActionsRight <= metrics.viewportWidth - (opts.mobile ? 10 : 18), `cover actions should stay inside the viewport: ${JSON.stringify(metrics)}`);
    } else {
      assert(
        metrics.coverActionsOpacity === null || metrics.coverActionsOpacity <= 0.25,
        `cover actions should stay hidden in idle visual evidence: ${JSON.stringify(metrics)}`,
      );
    }
  } else {
    assert(!metrics.coverExists, `page cover should not be visible in this capture: ${JSON.stringify(metrics)}`);
  }
}

function assertTopbarActionRailContract(metrics, opts) {
  assert(
    metrics.topbarLeft >= -1 &&
      metrics.topbarRight <= metrics.viewportWidth + 1 &&
      metrics.topbarHeight >= 42 &&
      metrics.topbarHeight <= 48,
    `page topbar should remain one compact viewport-contained rail: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topbarShareText === 'Share' &&
      metrics.topbarShareWidth >= 58 &&
      metrics.topbarShareWidth <= 84 &&
      metrics.topbarShareHeight >= 26 &&
      metrics.topbarShareHeight <= 30 &&
      metrics.topbarShareBorderWidth >= 0.5 &&
      metrics.topbarShareBorderColor !== 'rgba(0, 0, 0, 0)',
    `page topbar Share should stay a compact bordered action with a line sharing affordance: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topbarLinkWidth >= 27 &&
      metrics.topbarLinkWidth <= 30 &&
      metrics.topbarLinkHeight >= 27 &&
      metrics.topbarLinkHeight <= 30 &&
      metrics.topbarShareLeft < metrics.topbarLinkLeft &&
      metrics.topbarLinkLeft < metrics.topbarCommentLeft,
    `page topbar should order Share, link-copy, and Comment like the Notion reference: ${JSON.stringify(metrics)}`,
  );
  if (metrics.topbarPresenceWidth !== null) {
    assert(
      metrics.topbarPresenceWidth >= 20 &&
        metrics.topbarPresenceWidth <= 80 &&
        metrics.topbarPresenceRight <= metrics.topbarShareLeft + 4,
      `page topbar presence avatars should stay compact before Share: ${JSON.stringify(metrics)}`,
    );
  }
  assert(
    metrics.topbarIconActionCount >= 3 &&
      metrics.topbarIconActionMinWidth >= 27 &&
      metrics.topbarIconActionMaxWidth <= 30 &&
      metrics.topbarIconActionMinHeight >= 27 &&
      metrics.topbarIconActionMaxHeight <= 30 &&
      metrics.topbarActionCenterSpread <= 1.5,
    `page topbar icon actions should stay uniformly sized and aligned: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topbarActionOverlapCount === 0 &&
      metrics.topbarActionRailRight <= metrics.viewportWidth - (opts.mobile ? 6 : 12),
    `page topbar actions should not overlap or overflow the right edge: ${JSON.stringify(metrics)}`,
  );

  assert(
      metrics.topbarCommentWidth >= 26 &&
      metrics.topbarCommentWidth <= 30 &&
      metrics.topbarCommentHeight >= 26 &&
      metrics.topbarCommentHeight <= 30 &&
      metrics.topbarActionRailWidth <= 232,
    `${opts.mobile ? 'mobile' : 'desktop'} page topbar should keep presence/link/comment compact while Share stays readable: ${JSON.stringify(metrics)}`,
  );
}

async function expectPageTitle(page, title) {
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (expected) => {
      const titleElement = document.querySelector('[role="textbox"][aria-label="Page title"]');
      if (!titleElement) return false;
      const text = titleElement instanceof HTMLElement ? titleElement.innerText : titleElement.textContent;
      return text?.trim() === expected;
    },
    title,
    { timeout: options.timeoutMs },
  );
}

async function waitForSeedPage(baseUrl, seed, predicate, label) {
  const startedAt = Date.now();
  let lastPage = null;
  while (Date.now() - startedAt < options.timeoutMs) {
    lastPage = await fetchSeedPage(baseUrl, seed);
    if (predicate(lastPage)) return lastPage;
    await delay(250);
  }
  throw new Error(`${label} was not persisted for ${seed.pageId}; last page=${JSON.stringify(lastPage)}`);
}

async function fetchSeedPage(baseUrl, seed) {
  const bootstrap = await callFunction(baseUrl, seed.accessToken, 'workspace-bootstrap', {
    workspaceId: seed.workspaceId,
  });
  return bootstrap?.pages?.find((page) => page.id === seed.pageId) ?? null;
}

async function seedChromePage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for page chrome UI smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const initialTitle = `페이지 크롬 검증 ${suffix}`;
  const editedTitle = `회사 정보와 자료 검토 요청 페이지 ${suffix}`;

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: initialTitle,
    icon: '',
    iconType: 'none',
    cover: '',
    coverPosition: 50,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'page chrome UI smoke page must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    pageId,
    initialTitle,
    editedTitle,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, { call: callFunction }).catch(() => {});
}

async function seedSession(context, seed) {
  // Shared harness install: the first context bootstraps from the API-issued
  // refresh token; later contexts transplant the rotated HttpOnly cookie
  // captured by closeSeededContext (EdgeBase rotation reuse detection forbids
  // replaying the original token across contexts).
  await installBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
    workspaceId: seed.workspaceId,
    localStorage: { 'hanji:theme': 'light' },
  });
}

async function closeSeededContext(context, seed) {
  // Capture the FINAL rotated HttpOnly cookie before the context dies — any
  // in-flow reload/goto rotates the credential again, and replaying an older
  // cookie in the next context would trip reuse detection (family revocation).
  await captureBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
  }).catch(() => {});
  await context.close().catch(() => {});
}

async function setTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem('hanji:theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.waitForTimeout(100);
}

async function setViewport(page, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForFunction(
    (width) => window.innerWidth === width,
    viewport.width,
    { timeout: options.timeoutMs },
  );
  await page.waitForTimeout(120);
}

async function newCheckedPage(browser) {
  const context = await browser.newContext({ locale: 'en-US' });
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
    if (message.type() === 'error') errors.push(message.text());
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
    userId: body?.user?.id ?? '',
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
    'Playwright is required for page chrome UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a number >= 1000');
      }
      i += 1;
      continue;
    }
    if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(resolveValue(args, i, arg));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.screenshotDir = resolve(parsed.screenshotDir);
  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/page-chrome-ui-smoke.mjs [options]

Checks page-title editing, emoji icon selection/removal, and cover add/change/
remove with DOM, screenshot, layout, and product API persistence assertions.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL when checking a separate Vite app.
  --screenshot-dir <path> Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser while running.
`);
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
