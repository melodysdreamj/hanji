#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePasswordAuthForm, watchBrowserErrors } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'first-workspace');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL first workspace visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  const suffix = Date.now();
  const seed = {
    email: `first-workspace-${suffix}@example.com`,
    password: `FirstWorkspace${suffix}!aA1`,
    displayName: `First Workspace ${suffix}`,
  };
  console.log(`First workspace visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`First workspace visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);

  try {
    const createdPageId = await assertSignupFirstWorkspace(browser, appUrl, seed);
    await assertStalePasswordSigninWorkspace(browser, appUrl, seed, createdPageId);
    console.log(`PASS first workspace visual layout is captured and stays within the Notion-style layout contract.`);
    console.log(`Screenshot: ${join(options.screenshotDir, 'desktop-first-workspace.png')}`);
    console.log(`Dark screenshot: ${join(options.screenshotDir, 'desktop-first-workspace-dark.png')}`);
    console.log(`First page screenshot: ${join(options.screenshotDir, 'desktop-first-page.png')}`);
    console.log(`First page dark screenshot: ${join(options.screenshotDir, 'desktop-first-page-dark.png')}`);
    console.log(`First page database starter screenshot: ${join(options.screenshotDir, 'desktop-first-page-database.png')}`);
    console.log(`Stale-login screenshot: ${join(options.screenshotDir, 'desktop-stale-login-workspace.png')}`);
    console.log(`Stale-login dark screenshot: ${join(options.screenshotDir, 'desktop-stale-login-workspace-dark.png')}`);
    console.log(`Mobile screenshot: ${join(options.screenshotDir, 'mobile-first-workspace.png')}`);
    console.log(`Mobile dark screenshot: ${join(options.screenshotDir, 'mobile-first-workspace-dark.png')}`);
    console.log(`Mobile first page screenshot: ${join(options.screenshotDir, 'mobile-first-page.png')}`);
    console.log(`Mobile first page dark screenshot: ${join(options.screenshotDir, 'mobile-first-page-dark.png')}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertSignupFirstWorkspace(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  try {
    await seedStaleWorkspaceCache(page);
    await page.goto(resolveUrl(baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await clickPasswordTab(page);
    await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });
    await page.getByRole('textbox', { name: 'Name' }).fill(seed.displayName, { timeout: options.timeoutMs });
    await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
    await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });

    await expectFirstWorkspaceLoaded(page);
    await assertFirstWorkspaceVisualContract(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-workspace.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await assertFirstWorkspaceVisualContract(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-workspace-dark.png'),
      fullPage: false,
    });
    await setTheme(page, 'light');
    await setViewport(page, { width: 390, height: 844 });
    await expectFirstWorkspaceLoaded(page);
    await assertMobileFirstWorkspaceVisualContract(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-first-workspace.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await assertMobileFirstWorkspaceVisualContract(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-first-workspace-dark.png'),
      fullPage: false,
    });
    await setTheme(page, 'light');
    await setViewport(page, { width: 1440, height: 1000 });
    await expectFirstWorkspaceLoaded(page);
    const createdPageId = await openFirstCreatedPage(page);
    await assertFirstCreatedPageVisualContract(page, createdPageId);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-page.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await assertFirstCreatedPageVisualContract(page, createdPageId);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-page-dark.png'),
      fullPage: false,
    });
    await setTheme(page, 'light');
    await setViewport(page, { width: 390, height: 844 });
    await expectFirstCreatedPageLoaded(page, createdPageId);
    await assertMobileFirstCreatedPageVisualContract(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-first-page.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await assertMobileFirstCreatedPageVisualContract(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-first-page-dark.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'first workspace visual smoke');
    return createdPageId;
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertStalePasswordSigninWorkspace(browser, baseUrl, seed, createdPageId) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  try {
    await seedStaleWorkspaceCache(page);
    await page.goto(resolveUrl(baseUrl, `/p/${createdPageId}`), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await clickPasswordTab(page);
    await page.getByRole('textbox', { name: 'Email' }).fill(seed.email, { timeout: options.timeoutMs });
    await page.getByLabel('Password').fill(seed.password, { timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: options.timeoutMs });

    await expectStaleSigninWorkspaceLoaded(page, createdPageId);
    await assertStaleSigninVisualContract(page, createdPageId);
    await assertFirstCreatedPageVisualContract(page, createdPageId);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-stale-login-workspace.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await assertStaleSigninVisualContract(page, createdPageId);
    await assertFirstCreatedPageVisualContract(page, createdPageId);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-stale-login-workspace-dark.png'),
      fullPage: false,
    });
    await setTheme(page, 'light');
    await assertFirstPageDatabaseStarterRuntime(page, createdPageId);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-page-database.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'stale password sign-in workspace visual smoke');
  } finally {
    await context.close().catch(() => {});
  }
}

async function expectFirstWorkspaceLoaded(page) {
  await page.locator('button[aria-label="Open workspace menu"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="textbox"][aria-label="Page title"]')
        ?.textContent?.trim() === 'Hanji에 오신 것을 환영합니다!',
    undefined,
    { timeout: options.timeoutMs },
  );
  await waitForFirstWorkspaceVisualMarkers(page);
  const errorCount = await page.getByText('Something went wrong.').count();
  assert(errorCount === 0, 'signup first workspace rendered the generic error screen.');
}

async function waitForFirstWorkspaceVisualMarkers(page) {
  await page.waitForFunction(
    () => {
      const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
      const richTextItems = Array.from(document.querySelectorAll('[data-rt-editable="true"]'));
      const hasWelcomeBody = richTextItems.some((element) => element.textContent?.includes('EdgeBase 기반'));
      const hasStartedHeading = richTextItems.some((element) => element.textContent?.trim() === '시작하기');
      const treeRows = Array.from(document.querySelectorAll('[data-tree-page-id]'));
      const hasWelcomeRow = treeRows.some((element) =>
        element.textContent?.includes('Hanji에 오신 것을 환영합니다!'),
      );
      const hasUnexpectedSampleRows = treeRows.some((element) =>
        ['주간 할 일 목록', '프로젝트', '회의록'].some((title) => element.textContent?.includes(title)),
      );
      const topActions = document.querySelector('[data-sidebar-top-actions]');
      const homeAction = topActions?.querySelector('[data-sidebar-home-action]');
      const iconActions = topActions?.querySelectorAll('[data-sidebar-icon-action]');
      return (
        title?.textContent?.trim() === 'Hanji에 오신 것을 환영합니다!' &&
        hasWelcomeBody &&
        hasStartedHeading &&
        hasWelcomeRow &&
        treeRows.length === 1 &&
        !hasUnexpectedSampleRows &&
        topActions instanceof HTMLElement &&
        homeAction instanceof HTMLElement &&
        (iconActions?.length ?? 0) >= 2
      );
    },
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function expectStaleSigninWorkspaceLoaded(page, createdPageId) {
  await page.locator('button[aria-label="Open workspace menu"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForURL(new RegExp(`/p/${createdPageId}(?:[/?#]|$)`), {
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('group', { name: 'Page starter', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.locator(`[data-tree-page-id="${createdPageId}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const errorCount = await page.getByText('Something went wrong.').count();
  assert(errorCount === 0, 'stale password sign-in rendered the generic error screen.');
}

async function expectFirstCreatedPageLoaded(page, pageId) {
  await page.waitForURL(new RegExp(`/p/${pageId}(?:[/?#]|$)`), {
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('group', { name: 'Page starter', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const errorCount = await page.getByText('Something went wrong.').count();
  assert(errorCount === 0, 'first created page rendered the generic error screen.');
}

async function assertFirstWorkspaceVisualContract(page) {
  const metrics = await page.evaluate(() => {
    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const welcomeText = Array.from(document.querySelectorAll('[data-rt-editable="true"]')).find(
      (element) => element.textContent?.includes('EdgeBase 기반'),
    );
    const startedHeading = Array.from(document.querySelectorAll('[data-rt-editable="true"]')).find(
      (element) => element.textContent?.trim() === '시작하기',
    );
    const emptySurface = document.querySelector('[data-testid="empty-workspace-surface"]');
    const treeRows = Array.from(document.querySelectorAll('[data-tree-page-id]')).filter(
      (element) => element instanceof HTMLElement && element.offsetParent !== null,
    );
    const treeTexts = treeRows.map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const welcomeRow = treeRows.find((element) => element.textContent?.includes('Hanji에 오신 것을 환영합니다!'));
    const topActions = document.querySelector('[data-sidebar-top-actions]');
    const homeAction = topActions?.querySelector('[data-sidebar-home-action]');
    const homeLabel = homeAction?.querySelector('span');
    const iconActions = Array.from(topActions?.querySelectorAll('[data-sidebar-icon-action]') ?? []);
    if (
      !(doc instanceof HTMLElement) ||
      !(scroll instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(welcomeText instanceof HTMLElement) ||
      !(startedHeading instanceof HTMLElement) ||
      !(welcomeRow instanceof HTMLElement) ||
      !(topActions instanceof HTMLElement) ||
      !(homeAction instanceof HTMLElement) ||
      !(homeLabel instanceof HTMLElement) ||
      iconActions.some((item) => !(item instanceof HTMLElement))
    ) {
      return { ok: false, reason: 'missing first workspace visual markers' };
    }

    const scrollRect = scroll.getBoundingClientRect();
    const docRect = doc.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const welcomeTextRect = welcomeText.getBoundingClientRect();
    const startedHeadingRect = startedHeading.getBoundingClientRect();
    const welcomeRowRect = welcomeRow.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const topActionsRect = topActions.getBoundingClientRect();
    const homeRect = homeAction.getBoundingClientRect();
    const homeStyle = getComputedStyle(homeAction);
    const homeSvgRect = homeAction.querySelector('svg')?.getBoundingClientRect();
    const iconRects = iconActions.map((item) => item.getBoundingClientRect());
    const iconStyles = iconActions.map((item) => getComputedStyle(item));
    const iconSvgRects = iconActions.map((item) => item.querySelector('svg')?.getBoundingClientRect()).filter(Boolean);
    const topRailSvgs = [
      homeAction.querySelector('svg'),
      ...iconActions.map((item) => item.querySelector('svg')),
    ].filter((svg) => svg instanceof SVGElement);
    const iconWidths = iconRects.map((rect) => rect.width);
    const iconHeights = iconRects.map((rect) => rect.height);
    const iconTops = iconRects.map((rect) => rect.top);
    // Middle icons are everything before the right-aligned search slot; with a
    // single middle icon (home/inbox/search rail) there is no pair to measure.
    const middleIconRects = iconRects.slice(0, -1);
    const contiguousIconGaps = middleIconRects.slice(1).map((rect, index) => rect.left - middleIconRects[index].left);
    const searchRect = iconRects[iconRects.length - 1];
    const previousIconRect = iconRects[iconRects.length - 2];
    return {
      ok: true,
      scrollTop: scrollRect.top,
      scrollLeft: scrollRect.left,
      docLeft: docRect.left,
      docWidth: docRect.width,
      titleTop: titleRect.top,
      titleLeft: titleRect.left,
      titleBottom: titleRect.bottom,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      titleColor: titleStyle.color,
      titleText: title.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      welcomeTextTop: welcomeTextRect.top,
      welcomeTextLeft: welcomeTextRect.left,
      startedHeadingTop: startedHeadingRect.top,
      emptySurfaceVisible: emptySurface instanceof HTMLElement && emptySurface.offsetParent !== null,
      treeRowCount: treeRows.length,
      treeTexts,
      welcomeRowHeight: welcomeRowRect.height,
      welcomeRowCurrent: welcomeRow.getAttribute('aria-current'),
      topActionsHeight: topActionsRect.height,
      topActionsText: topActions.textContent?.trim() ?? '',
      topActionSlots: [
        homeAction.getAttribute('data-sidebar-rail-slot'),
        ...iconActions.map((item) => item.getAttribute('data-sidebar-rail-slot')),
      ],
      topActionLabels: [
        homeAction.getAttribute('aria-label') ?? '',
        ...iconActions.map((item) => item.getAttribute('aria-label') ?? ''),
      ],
      topRailIconCount: topRailSvgs.length,
      topRailHanjiIconCount: topRailSvgs.filter((svg) => svg.getAttribute('data-hanji-icon') === 'true').length,
      topRailIconSources: Array.from(
        new Set(topRailSvgs.map((svg) => svg.getAttribute('data-hanji-icon-source') ?? 'unknown')),
      ),
      topRailIconWeights: Array.from(
        new Set(topRailSvgs.map((svg) => svg.getAttribute('data-hanji-icon-weight') ?? 'unknown')),
      ),
      homeActionWidth: homeRect.width,
      homeActionHeight: homeRect.height,
      homeActionRadius: Number.parseFloat(homeStyle.borderTopLeftRadius),
      homeIconWidth: homeSvgRect?.width ?? 0,
      homeIconHeight: homeSvgRect?.height ?? 0,
      homeActionActive: homeAction.getAttribute('data-active'),
      homeLabelText: homeLabel.textContent?.trim() ?? '',
      homeLabelFits: homeLabel.scrollWidth <= homeLabel.clientWidth + 1,
      iconActionCount: iconRects.length,
      iconActionMinWidth: Math.min(...iconWidths),
      iconActionMaxWidth: Math.max(...iconWidths),
      iconActionMinHeight: Math.min(...iconHeights),
      iconActionMaxHeight: Math.max(...iconHeights),
      iconActionMinRadius: Math.min(...iconStyles.map((style) => Number.parseFloat(style.borderTopLeftRadius))),
      iconSvgMinWidth: Math.min(...iconSvgRects.map((rect) => rect.width)),
      iconSvgMaxWidth: Math.max(...iconSvgRects.map((rect) => rect.width)),
      iconActionTopSpread: Math.max(...iconTops) - Math.min(...iconTops),
      iconActionContiguousGapMin: contiguousIconGaps.length ? Math.min(...contiguousIconGaps) : null,
      iconActionContiguousGapMax: contiguousIconGaps.length ? Math.max(...contiguousIconGaps) : null,
      searchActionSpacer: searchRect && previousIconRect ? searchRect.left - previousIconRect.right : null,
      searchActionRightInset: searchRect ? topActionsRect.right - searchRect.right : null,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'first workspace visual contract could not run');
  assert(
    metrics.emptySurfaceVisible === false,
    'first workspace should open a seeded welcome page instead of the old empty Untitled workspace surface',
  );
  assert(
    metrics.docWidth <= 960,
    `first workspace welcome page should stay inside a document-width column, got ${Math.round(metrics.docWidth)}px`,
  );
  assert(
    metrics.titleText === 'Hanji에 오신 것을 환영합니다!',
    `first workspace should open the seeded welcome page, got title=${JSON.stringify(metrics.titleText)}`,
  );
  assert(
    // The seeded welcome page carries a 👋 page icon above the title, which
    // pushes the title down ~60px versus an icon-less page (Notion-matching).
    metrics.titleTop - metrics.scrollTop >= 80 && metrics.titleTop - metrics.scrollTop <= 230,
    `first workspace welcome title should sit near the document top, got ${Math.round(metrics.titleTop - metrics.scrollTop)}px from page viewport top`,
  );
  assert(
    metrics.titleLeft - metrics.scrollLeft >= 200 && metrics.titleLeft - metrics.scrollLeft <= 280,
    `first workspace welcome title should align with the shared document text column, got ${Math.round(metrics.titleLeft - metrics.scrollLeft)}px from content left`,
  );
  assert(
    metrics.titleFontSize >= 36 && metrics.titleFontSize <= 48,
    `first workspace welcome title should be page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    Math.abs(metrics.welcomeTextLeft - metrics.titleLeft) <= 2,
    `welcome body should align with the title column, got offset=${Math.round(metrics.welcomeTextLeft - metrics.titleLeft)}px`,
  );
  assert(
    metrics.welcomeTextTop > metrics.titleBottom && metrics.startedHeadingTop > metrics.welcomeTextTop,
    `welcome page should show starter content in document flow, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.treeRowCount === 1 &&
      metrics.treeTexts.some((text) => text.includes('Hanji에 오신 것을 환영합니다!')) &&
      !metrics.treeTexts.some((text) =>
        ['주간 할 일 목록', '프로젝트', '회의록'].some((title) => text.includes(title)),
      ),
    `first workspace sidebar should start with one welcome root page, not sample sibling pages, got ${JSON.stringify(metrics.treeTexts)}`,
  );
  assert(
    metrics.welcomeRowCurrent === 'page' &&
      metrics.welcomeRowHeight >= 28 &&
      metrics.welcomeRowHeight <= 31,
    `welcome sidebar row should be current and stay on the 30px rhythm, got ${JSON.stringify({
      current: metrics.welcomeRowCurrent,
      height: metrics.welcomeRowHeight,
    })}`,
  );
  assert(
    metrics.topActionsHeight >= 42 && metrics.topActionsHeight <= 48,
    `sidebar top actions should stay close to the live Notion 32px tab rail rhythm, got ${Math.round(metrics.topActionsHeight)}px`,
  );
  assert(
    metrics.homeActionActive === 'true',
    `sidebar top rail should show Home as the active pill on the workspace surface, got ${metrics.homeActionActive}`,
  );
  assert(
    metrics.homeActionWidth >= 72 && /* >=72: Linux CI fonts render the label ~1-3px narrower than macOS */
      metrics.homeActionWidth <= 108 &&
      metrics.homeActionHeight >= 31 &&
      metrics.homeActionHeight <= 34 &&
      metrics.homeActionRadius >= 15 &&
      metrics.homeIconWidth >= 18.5 &&
      metrics.homeIconWidth <= 19.5 &&
      metrics.homeIconHeight >= 18.5 &&
      metrics.homeIconHeight <= 19.5,
    `sidebar Home pill should stay compact, rounded, and Notion-reference scaled, got ${JSON.stringify({
      width: Math.round(metrics.homeActionWidth),
      height: Math.round(metrics.homeActionHeight),
      radius: Math.round(metrics.homeActionRadius),
      iconWidth: Math.round(metrics.homeIconWidth),
      iconHeight: Math.round(metrics.homeIconHeight),
    })}`,
  );
  assert(
    metrics.homeLabelText === 'Home' && metrics.homeLabelFits === true,
    `sidebar Home pill label should fit without ellipsis, got text=${JSON.stringify(metrics.homeLabelText)} fits=${metrics.homeLabelFits}`,
  );
  assert(
    metrics.topRailIconCount === 3,
    `sidebar top rail should keep five SVG icons, got ${JSON.stringify({
      count: metrics.topRailIconCount,
    })}`,
  );
  assert(
    metrics.topRailHanjiIconCount === 3 &&
      JSON.stringify(metrics.topRailIconSources) === JSON.stringify(['phosphor']),
    `sidebar top rail icons should come from the approved imported Phosphor wrapper, got ${JSON.stringify({
      count: metrics.topRailHanjiIconCount,
      sources: metrics.topRailIconSources,
      weights: metrics.topRailIconWeights,
    })}`,
  );
  assert(
    metrics.iconActionCount >= 2 &&
      metrics.iconActionMinWidth >= 31 &&
      metrics.iconActionMaxWidth <= 34 &&
      metrics.iconActionMinHeight >= 31 &&
      metrics.iconActionMaxHeight <= 34 &&
      metrics.iconActionMinRadius >= 15 &&
      metrics.iconSvgMinWidth >= 18.5 &&
      metrics.iconSvgMaxWidth <= 19.5 &&
      metrics.iconActionTopSpread <= 1,
    `sidebar top icon buttons should be uniform, compact, and Notion-reference scaled, got ${JSON.stringify({
      count: metrics.iconActionCount,
      widths: `${Math.round(metrics.iconActionMinWidth)}-${Math.round(metrics.iconActionMaxWidth)}`,
      heights: `${Math.round(metrics.iconActionMinHeight)}-${Math.round(metrics.iconActionMaxHeight)}`,
      radius: Math.round(metrics.iconActionMinRadius),
      svgWidths: `${Math.round(metrics.iconSvgMinWidth)}-${Math.round(metrics.iconSvgMaxWidth)}`,
      topSpread: metrics.iconActionTopSpread,
    })}`,
  );
  assert(
      (metrics.iconActionContiguousGapMin === null ||
        (metrics.iconActionContiguousGapMin >= 33 && metrics.iconActionContiguousGapMax <= 36)) &&
      metrics.searchActionSpacer >= 4 &&
      metrics.searchActionRightInset >= 6 &&
      metrics.searchActionRightInset <= 10,
    `sidebar top rail should keep compact middle icons and right-aligned search, got gaps=${metrics.iconActionContiguousGapMin}-${metrics.iconActionContiguousGapMax} searchSpacer=${metrics.searchActionSpacer} searchInset=${metrics.searchActionRightInset}`,
  );
  assert(
    !/Quick Find|Settings|Account console|Workspace console|Server console|Templates/.test(metrics.topActionsText),
    `sidebar top rail should not fall back to tall text action rows, got text=${JSON.stringify(metrics.topActionsText)}`,
  );
  assert(
    JSON.stringify(metrics.topActionSlots) === JSON.stringify(['home', 'inbox', 'search']),
    `sidebar top rail should stay as Home/inbox/search slots, got ${JSON.stringify(metrics.topActionSlots)}`,
  );
  assert(
    metrics.topActionLabels.every((label) => !/Settings|Templates|Import|Trash/.test(label)),
    `sidebar top rail should not mix management/template actions into the navigation rail, got ${JSON.stringify(metrics.topActionLabels)}`,
  );
}

async function assertMobileFirstWorkspaceVisualContract(page) {
  const metrics = await page.evaluate(() => {
    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const welcomeText = Array.from(document.querySelectorAll('[data-rt-editable="true"]')).find(
      (element) => element.textContent?.includes('EdgeBase 기반'),
    );
    const emptySurface = document.querySelector('[data-testid="empty-workspace-surface"]');
    const sidebar = document.querySelector('[aria-label="Sidebar"]');
    const topActions = document.querySelector('[data-sidebar-top-actions]');
    const homeAction = topActions?.querySelector('[data-sidebar-home-action]');
    const homeLabel = homeAction?.querySelector('span');
    const iconActions = Array.from(topActions?.querySelectorAll('[data-sidebar-icon-action]') ?? []);
    if (
      !(doc instanceof HTMLElement) ||
      !(scroll instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(welcomeText instanceof HTMLElement) ||
      !(topActions instanceof HTMLElement) ||
      !(homeAction instanceof HTMLElement) ||
      !(homeLabel instanceof HTMLElement) ||
      iconActions.some((item) => !(item instanceof HTMLElement))
    ) {
      return { ok: false, reason: 'missing mobile first workspace visual markers' };
    }

    const scrollRect = scroll.getBoundingClientRect();
    const docRect = doc.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const welcomeTextRect = welcomeText.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : null;
    const topActionsRect = topActions.getBoundingClientRect();
    const homeRect = homeAction.getBoundingClientRect();
    const homeStyle = getComputedStyle(homeAction);
    const homeSvgRect = homeAction.querySelector('svg')?.getBoundingClientRect();
    const iconRects = iconActions.map((item) => item.getBoundingClientRect());
    const iconStyles = iconActions.map((item) => getComputedStyle(item));
    const iconSvgRects = iconActions.map((item) => item.querySelector('svg')?.getBoundingClientRect()).filter(Boolean);
    const topRailSvgs = [
      homeAction.querySelector('svg'),
      ...iconActions.map((item) => item.querySelector('svg')),
    ].filter((svg) => svg instanceof SVGElement);
    const iconWidths = iconRects.map((rect) => rect.width);
    const iconHeights = iconRects.map((rect) => rect.height);
    const iconTops = iconRects.map((rect) => rect.top);
    // Middle icons are everything before the right-aligned search slot; with a
    // single middle icon (home/inbox/search rail) there is no pair to measure.
    const middleIconRects = iconRects.slice(0, -1);
    const contiguousIconGaps = middleIconRects.slice(1).map((rect, index) => rect.left - middleIconRects[index].left);
    const searchRect = iconRects[iconRects.length - 1];
    const previousIconRect = iconRects[iconRects.length - 2];
    return {
      ok: true,
      viewportWidth: window.innerWidth,
      scrollTop: scrollRect.top,
      scrollLeft: scrollRect.left,
      docWidth: docRect.width,
      titleTop: titleRect.top,
      titleLeft: titleRect.left,
      titleBottom: titleRect.bottom,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      titleText: title.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      welcomeTextLeft: welcomeTextRect.left,
      welcomeTextTop: welcomeTextRect.top,
      emptySurfaceVisible: emptySurface instanceof HTMLElement && emptySurface.offsetParent !== null,
      sidebarVisible: !!sidebarRect && sidebarRect.right > 16 && sidebarRect.left < window.innerWidth - 16,
      topActionsHeight: topActionsRect.height,
      topActionsText: topActions.textContent?.trim() ?? '',
      topActionSlots: [
        homeAction.getAttribute('data-sidebar-rail-slot'),
        ...iconActions.map((item) => item.getAttribute('data-sidebar-rail-slot')),
      ],
      topActionLabels: [
        homeAction.getAttribute('aria-label') ?? '',
        ...iconActions.map((item) => item.getAttribute('aria-label') ?? ''),
      ],
      topRailIconCount: topRailSvgs.length,
      topRailHanjiIconCount: topRailSvgs.filter((svg) => svg.getAttribute('data-hanji-icon') === 'true').length,
      topRailIconSources: Array.from(
        new Set(topRailSvgs.map((svg) => svg.getAttribute('data-hanji-icon-source') ?? 'unknown')),
      ),
      topRailIconWeights: Array.from(
        new Set(topRailSvgs.map((svg) => svg.getAttribute('data-hanji-icon-weight') ?? 'unknown')),
      ),
      homeActionWidth: homeRect.width,
      homeActionHeight: homeRect.height,
      homeActionRadius: Number.parseFloat(homeStyle.borderTopLeftRadius),
      homeIconWidth: homeSvgRect?.width ?? 0,
      homeIconHeight: homeSvgRect?.height ?? 0,
      homeLabelText: homeLabel.textContent?.trim() ?? '',
      homeLabelFits: homeLabel.scrollWidth <= homeLabel.clientWidth + 1,
      iconActionCount: iconRects.length,
      iconActionMinWidth: Math.min(...iconWidths),
      iconActionMaxWidth: Math.max(...iconWidths),
      iconActionMinHeight: Math.min(...iconHeights),
      iconActionMaxHeight: Math.max(...iconHeights),
      iconActionMinRadius: Math.min(...iconStyles.map((style) => Number.parseFloat(style.borderTopLeftRadius))),
      iconSvgMinWidth: Math.min(...iconSvgRects.map((rect) => rect.width)),
      iconSvgMaxWidth: Math.max(...iconSvgRects.map((rect) => rect.width)),
      iconActionTopSpread: Math.max(...iconTops) - Math.min(...iconTops),
      iconActionContiguousGapMin: contiguousIconGaps.length ? Math.min(...contiguousIconGaps) : null,
      iconActionContiguousGapMax: contiguousIconGaps.length ? Math.max(...contiguousIconGaps) : null,
      searchActionSpacer: searchRect && previousIconRect ? searchRect.left - previousIconRect.right : null,
      searchActionRightInset: searchRect ? topActionsRect.right - searchRect.right : null,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'mobile first workspace visual contract could not run');
  assert(
    metrics.viewportWidth <= 430,
    `mobile first workspace should run in a narrow viewport, got ${Math.round(metrics.viewportWidth)}px`,
  );
  assert(
    metrics.emptySurfaceVisible === false,
    'mobile first workspace should open the seeded welcome page instead of the old empty Untitled workspace surface',
  );
  assert(
    metrics.sidebarVisible === false,
    'mobile first workspace should not leave the desktop sidebar open over the document',
  );
  assert(
    metrics.docWidth <= metrics.viewportWidth && metrics.docWidth >= metrics.viewportWidth - 64,
    `mobile first workspace document should fit the viewport, got ${Math.round(metrics.docWidth)}px in ${Math.round(metrics.viewportWidth)}px viewport`,
  );
  assert(
    metrics.titleText === 'Hanji에 오신 것을 환영합니다!',
    `mobile first workspace should open the seeded welcome page, got title=${JSON.stringify(metrics.titleText)}`,
  );
  assert(
    // Same 👋 page-icon offset as the desktop welcome assertion above.
    metrics.titleTop - metrics.scrollTop >= 80 && metrics.titleTop - metrics.scrollTop <= 230,
    `mobile welcome title should sit near the top, got ${Math.round(metrics.titleTop - metrics.scrollTop)}px from page viewport top`,
  );
  assert(
    metrics.titleLeft - metrics.scrollLeft >= 20 && metrics.titleLeft - metrics.scrollLeft <= 40,
    `mobile welcome title should align to the document gutter, got ${Math.round(metrics.titleLeft - metrics.scrollLeft)}px`,
  );
  assert(
    metrics.titleFontSize >= 36 && metrics.titleFontSize <= 48,
    `mobile welcome title should stay page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    Math.abs(metrics.welcomeTextLeft - metrics.titleLeft) <= 2 &&
      metrics.welcomeTextTop > metrics.titleBottom,
    `mobile welcome body should align below the title, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topActionsHeight >= 42 && metrics.topActionsHeight <= 48,
    `mobile sidebar top actions should stay close to the live Notion 32px tab rail rhythm, got ${Math.round(metrics.topActionsHeight)}px`,
  );
  assert(
    metrics.homeActionWidth >= 72 && /* >=72: Linux CI fonts render the label ~1-3px narrower than macOS */
      metrics.homeActionWidth <= 108 &&
      metrics.homeActionHeight >= 31 &&
      metrics.homeActionHeight <= 34 &&
      metrics.homeActionRadius >= 15 &&
      metrics.homeIconWidth >= 18.5 &&
      metrics.homeIconWidth <= 19.5 &&
      metrics.homeIconHeight >= 18.5 &&
      metrics.homeIconHeight <= 19.5,
    `mobile sidebar Home pill should stay compact, rounded, and Notion-reference scaled, got ${JSON.stringify({
      width: Math.round(metrics.homeActionWidth),
      height: Math.round(metrics.homeActionHeight),
      radius: Math.round(metrics.homeActionRadius),
      iconWidth: Math.round(metrics.homeIconWidth),
      iconHeight: Math.round(metrics.homeIconHeight),
    })}`,
  );
  assert(
    metrics.homeLabelText === 'Home' && metrics.homeLabelFits === true,
    `mobile sidebar Home pill label should fit without ellipsis, got text=${JSON.stringify(metrics.homeLabelText)} fits=${metrics.homeLabelFits}`,
  );
  assert(
    metrics.topRailIconCount === 3,
    `mobile sidebar top rail should keep five SVG icons, got ${JSON.stringify({
      count: metrics.topRailIconCount,
    })}`,
  );
  assert(
    metrics.topRailHanjiIconCount === 3 &&
      JSON.stringify(metrics.topRailIconSources) === JSON.stringify(['phosphor']),
    `mobile sidebar top rail icons should come from the approved imported Phosphor wrapper, got ${JSON.stringify({
      count: metrics.topRailHanjiIconCount,
      sources: metrics.topRailIconSources,
      weights: metrics.topRailIconWeights,
    })}`,
  );
  assert(
    metrics.iconActionCount >= 2 &&
      metrics.iconActionMinWidth >= 31 &&
      metrics.iconActionMaxWidth <= 34 &&
      metrics.iconActionMinHeight >= 31 &&
      metrics.iconActionMaxHeight <= 34 &&
      metrics.iconActionMinRadius >= 15 &&
      metrics.iconSvgMinWidth >= 18.5 &&
      metrics.iconSvgMaxWidth <= 19.5 &&
      metrics.iconActionTopSpread <= 1,
    `mobile sidebar top icon buttons should be uniform, compact, and Notion-reference scaled, got ${JSON.stringify({
      count: metrics.iconActionCount,
      widths: `${Math.round(metrics.iconActionMinWidth)}-${Math.round(metrics.iconActionMaxWidth)}`,
      heights: `${Math.round(metrics.iconActionMinHeight)}-${Math.round(metrics.iconActionMaxHeight)}`,
      radius: Math.round(metrics.iconActionMinRadius),
      svgWidths: `${Math.round(metrics.iconSvgMinWidth)}-${Math.round(metrics.iconSvgMaxWidth)}`,
      topSpread: metrics.iconActionTopSpread,
    })}`,
  );
  assert(
      (metrics.iconActionContiguousGapMin === null ||
        (metrics.iconActionContiguousGapMin >= 33 && metrics.iconActionContiguousGapMax <= 36)) &&
      metrics.searchActionSpacer >= 4 &&
      metrics.searchActionRightInset >= 6 &&
      metrics.searchActionRightInset <= 10,
    `mobile sidebar top rail should keep compact middle icons and right-aligned search, got gaps=${metrics.iconActionContiguousGapMin}-${metrics.iconActionContiguousGapMax} searchSpacer=${metrics.searchActionSpacer} searchInset=${metrics.searchActionRightInset}`,
  );
  assert(
    !/Quick Find|Settings|Account console|Workspace console|Server console|Templates/.test(metrics.topActionsText),
    `mobile sidebar top rail should not fall back to tall text action rows, got text=${JSON.stringify(metrics.topActionsText)}`,
  );
  assert(
    JSON.stringify(metrics.topActionSlots) === JSON.stringify(['home', 'inbox', 'search']),
    `mobile sidebar top rail should stay as Home/inbox/search slots, got ${JSON.stringify(metrics.topActionSlots)}`,
  );
  assert(
    metrics.topActionLabels.every((label) => !/Settings|Templates|Import|Trash/.test(label)),
    `mobile sidebar top rail should not mix management/template actions into the navigation rail, got ${JSON.stringify(metrics.topActionLabels)}`,
  );
}

async function assertStaleSigninVisualContract(page, createdPageId) {
  const metrics = await page.evaluate((id) => {
    const sidebar = document.querySelector('[aria-label="Sidebar"]');
    const workspaceButton = document.querySelector('button[aria-label="Open workspace menu"]');
    const actions = document.querySelector('nav[aria-label="Workspace actions"]');
    const treeRow = document.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
    const error = Array.from(document.querySelectorAll('strong, h1, h2, p')).find(
      (node) => node.textContent?.includes('Something went wrong.'),
    );
    if (
      !(sidebar instanceof HTMLElement) ||
      !(workspaceButton instanceof HTMLElement) ||
      !(actions instanceof HTMLElement) ||
      !(treeRow instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'missing stale-login workspace visual markers' };
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    const workspaceRect = workspaceButton.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const treeRowRect = treeRow.getBoundingClientRect();
    const actionButtons = Array.from(actions.querySelectorAll('button, a')).filter(
      (node) => node instanceof HTMLElement && node.offsetParent !== null,
    );
    return {
      ok: true,
      errorVisible: error instanceof HTMLElement && error.offsetParent !== null,
      sidebarTop: sidebarRect.top,
      sidebarLeft: sidebarRect.left,
      sidebarWidth: sidebarRect.width,
      workspaceTop: workspaceRect.top,
      workspaceLeft: workspaceRect.left,
      workspaceWidth: workspaceRect.width,
      workspaceHeight: workspaceRect.height,
      actionsTop: actionsRect.top,
      actionsLeft: actionsRect.left,
      actionCount: actionButtons.length,
      treeRowTop: treeRowRect.top,
      treeRowLeft: treeRowRect.left,
      treeRowWidth: treeRowRect.width,
      treeRowHeight: treeRowRect.height,
      treeRowText: treeRow.textContent?.trim() ?? '',
    };
  }, createdPageId);

  assert(metrics.ok, metrics.reason ?? 'stale sign-in visual contract could not run');
  assert(metrics.errorVisible === false, 'stale sign-in should not show the generic workspace error screen');
  assert(
    metrics.sidebarWidth >= 220 && metrics.sidebarWidth <= 280,
    `stale sign-in sidebar should keep a Hanji width, got ${Math.round(metrics.sidebarWidth)}px`,
  );
  assert(
    metrics.workspaceTop >= 0 && metrics.workspaceTop <= 32,
    `stale sign-in workspace switcher should sit at the top of the sidebar, got top=${Math.round(metrics.workspaceTop)}px`,
  );
  assert(
    metrics.workspaceHeight >= 28 && metrics.workspaceHeight <= 42,
    `stale sign-in workspace switcher should stay compact, got ${Math.round(metrics.workspaceHeight)}px`,
  );
  assert(
    metrics.actionsTop - metrics.workspaceTop >= 34 && metrics.actionsTop - metrics.workspaceTop <= 96,
    `stale sign-in sidebar actions should follow the workspace switcher, got ${Math.round(metrics.actionsTop - metrics.workspaceTop)}px gap`,
  );
  assert(metrics.actionCount >= 3, `stale sign-in sidebar should expose main workspace actions, got ${metrics.actionCount}`);
  assert(
    metrics.treeRowHeight >= 28 && metrics.treeRowHeight <= 31,
    `stale sign-in page tree row should stay on the current Notion-style 30px rhythm, got ${Math.round(metrics.treeRowHeight)}px`,
  );
  assert(
    metrics.treeRowLeft - metrics.sidebarLeft >= 6 && metrics.treeRowLeft - metrics.sidebarLeft <= 28,
    `stale sign-in page tree row should align inside the sidebar, got ${Math.round(metrics.treeRowLeft - metrics.sidebarLeft)}px inset`,
  );
  assert(
    metrics.treeRowWidth >= 120 && metrics.treeRowWidth <= metrics.sidebarWidth - 8,
    `stale sign-in page tree row should stay inside sidebar bounds, got ${Math.round(metrics.treeRowWidth)}px row for ${Math.round(metrics.sidebarWidth)}px sidebar`,
  );
}

async function openFirstCreatedPage(page) {
  const beforeUrl = page.url();
  const create = page.locator('[data-sidebar-footer-new-page]');
  await create.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await Promise.all([
    page.waitForFunction((url) => window.location.href !== url, beforeUrl, { timeout: options.timeoutMs }),
    create.click({ timeout: options.timeoutMs }),
  ]);
  const path = new URL(page.url()).pathname;
  const pageId = path.split('/').filter(Boolean).at(-1);
  assert(pageId, `first created page route did not include a page id: ${path}`);
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('group', { name: 'Page starter', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.locator(`[data-tree-page-id="${pageId}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return pageId;
}

async function assertFirstCreatedPageVisualContract(page, pageId) {
  const metrics = await page.evaluate((id) => {
    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const starter = document.querySelector('[role="group"][aria-label="Page starter"]');
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    const addIcon = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add icon',
    );
    const addCover = document.querySelector('button[aria-label="Add page cover"]');
    const addComment = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add comment',
    );
    const treeRow = document.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
    const presence = document.querySelector('[data-testid="page-presence"]');
    const shareAction = document.querySelector('[data-topbar-share-action]');
    const commentAction = document.querySelector('[data-topbar-comment-action]');
    const iconActions = Array.from(document.querySelectorAll('[data-topbar-icon-action]'));
    if (
      !(scroll instanceof HTMLElement) ||
      !(doc instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(starter instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(addIcon instanceof HTMLElement) ||
      !(addCover instanceof HTMLElement) ||
      !(addComment instanceof HTMLElement) ||
      !(treeRow instanceof HTMLElement) ||
      !(shareAction instanceof HTMLElement) ||
      !(commentAction instanceof HTMLElement) ||
      iconActions.some((item) => !(item instanceof HTMLElement))
    ) {
      return { ok: false, reason: 'missing first page visual markers' };
    }

    const scrollRect = scroll.getBoundingClientRect();
    const docRect = doc.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const starterRect = starter.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const addIconRect = addIcon.getBoundingClientRect();
    const addCoverRect = addCover.getBoundingClientRect();
    const addCommentRect = addComment.getBoundingClientRect();
    const treeRowRect = treeRow.getBoundingClientRect();
    const shareRect = shareAction.getBoundingClientRect();
    const commentRect = commentAction.getBoundingClientRect();
    const iconActionRects = iconActions.map((item) => item.getBoundingClientRect());
    const titleStyle = getComputedStyle(title);
    const titlePlaceholderStyle = getComputedStyle(title, '::before');
    const starterStyle = getComputedStyle(starter);
    const pagePlaceholder = document.querySelector('[data-page-placeholder="true"]');
    const pagePlaceholderStyle =
      pagePlaceholder instanceof HTMLElement
        ? getComputedStyle(pagePlaceholder, '::before')
        : null;
    const shareStyle = getComputedStyle(shareAction);
    const iconActionWidths = iconActionRects.map((rect) => rect.width);
    const iconActionHeights = iconActionRects.map((rect) => rect.height);
    const actionCenters = [
      shareRect.top + shareRect.height / 2,
      commentRect.top + commentRect.height / 2,
      ...iconActionRects.map((rect) => rect.top + rect.height / 2),
    ];
    const parseColor = (color) => {
      const srgbMatch = color.match(/color\(srgb\s+([^)]+)\)/);
      if (srgbMatch) {
        const parts = srgbMatch[1]
          .replace(/\//g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .map((part) => Number.parseFloat(part));
        if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
      }
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: Number.isFinite(parts[3]) ? parts[3] : 1 };
    };
    const blend = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const channel = (value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    const contrastRatio = (fgColor, bgColor) => {
      const fg = parseColor(fgColor);
      const bg = parseColor(bgColor);
      if (!fg || !bg) return 0;
      const blendedFg = blend(fg, bg);
      const lighter = Math.max(luminance(blendedFg), luminance(bg));
      const darker = Math.min(luminance(blendedFg), luminance(bg));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const pageBackground = getComputedStyle(document.body).backgroundColor;
    const starterButtons = Array.from(starter.querySelectorAll('button')).filter(
      (button) => button instanceof HTMLElement && button.offsetParent !== null,
    );
    const starterButtonLabels = starterButtons.map((button) =>
      button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
    const starterTextContrasts = starterButtons.map((button) =>
      contrastRatio(getComputedStyle(button).color, pageBackground),
    );
    const starterButtonRects = starterButtons.map((button) => button.getBoundingClientRect());
    const starterButtonWidths = starterButtonRects.map((rect) => rect.width);
    const starterButtonTops = starterButtonRects.map((rect) => rect.top);
    return {
      ok: true,
      scrollTop: scrollRect.top,
      scrollLeft: scrollRect.left,
      scrollWidth: scrollRect.width,
      docLeft: docRect.left,
      docWidth: docRect.width,
      titleTop: titleRect.top,
      titleLeft: titleRect.left,
      titleBottom: titleRect.bottom,
      titleWidth: titleRect.width,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      titleLineHeight: Number.parseFloat(titleStyle.lineHeight),
      titleColor: titleStyle.color,
      titlePlaceholderColor: titlePlaceholderStyle.color,
      titlePlaceholderContrast: contrastRatio(titlePlaceholderStyle.color, pageBackground),
      addIconTop: addIconRect.top,
      addIconLeft: addIconRect.left,
      addIconBottom: addIconRect.bottom,
      addIconHeight: addIconRect.height,
      addIconContrast: contrastRatio(getComputedStyle(addIcon).color, pageBackground),
      addCoverTop: addCoverRect.top,
      addCoverLeft: addCoverRect.left,
      addCoverHeight: addCoverRect.height,
      addCoverContrast: contrastRatio(getComputedStyle(addCover).color, pageBackground),
      addCommentTop: addCommentRect.top,
      addCommentLeft: addCommentRect.left,
      addCommentHeight: addCommentRect.height,
      addCommentContrast: contrastRatio(getComputedStyle(addComment).color, pageBackground),
      starterTop: starterRect.top,
      starterLeft: starterRect.left,
      starterWidth: starterRect.width,
      starterDisplay: starterStyle.display,
      starterActionCount: starterButtons.length,
      starterButtonLabels,
      starterMinTextContrast: Math.min(...starterTextContrasts),
      starterMaxButtonWidth: Math.max(...starterButtonWidths),
      starterButtonTopSpread: Math.max(...starterButtonTops) - Math.min(...starterButtonTops),
      pagePlaceholderText: pagePlaceholderStyle?.content ?? null,
      bodyTop: bodyRect.top,
      bodyLeft: bodyRect.left,
      bodyWidth: bodyRect.width,
      treeRowWidth: treeRowRect.width,
      treeRowHeight: treeRowRect.height,
      treeRowCurrent: treeRow.getAttribute('aria-current'),
      treeRowLevel: treeRow.getAttribute('aria-level'),
      presenceVisible: presence instanceof HTMLElement,
      topbarShareText: shareAction.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topbarShareWidth: shareRect.width,
      topbarShareHeight: shareRect.height,
      topbarShareBorderWidth: Number.parseFloat(shareStyle.borderTopWidth),
      topbarShareBorderColor: shareStyle.borderTopColor,
      topbarCommentWidth: commentRect.width,
      topbarCommentHeight: commentRect.height,
      topbarIconActionCount: iconActionRects.length,
      topbarIconActionMinWidth: Math.min(...iconActionWidths),
      topbarIconActionMaxWidth: Math.max(...iconActionWidths),
      topbarIconActionMinHeight: Math.min(...iconActionHeights),
      topbarIconActionMaxHeight: Math.max(...iconActionHeights),
      topbarActionCenterSpread: Math.max(...actionCenters) - Math.min(...actionCenters),
    };
  }, pageId);

  assert(metrics.ok, metrics.reason ?? 'first created page visual contract could not run');
  assert(
    metrics.docWidth <= 960,
    `first page should stay inside a document-width column, got ${Math.round(metrics.docWidth)}px`,
  );
  assert(
    metrics.titleTop - metrics.scrollTop >= 80 && metrics.titleTop - metrics.scrollTop <= 135,
    `first page title should sit near the document top, got ${Math.round(metrics.titleTop - metrics.scrollTop)}px from page viewport top`,
  );
  assert(
    metrics.titleLeft - metrics.scrollLeft >= 200 && metrics.titleLeft - metrics.scrollLeft <= 280,
    `first page title should align with the shared document text column, got ${Math.round(metrics.titleLeft - metrics.scrollLeft)}px from content left`,
  );
  assert(
    metrics.titleFontSize >= 36 && metrics.titleFontSize <= 48,
    `first page title placeholder should be page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    metrics.titlePlaceholderContrast >= 4.5,
    `first page empty title placeholder should stay readable in light/dark themes instead of looking disabled: ${JSON.stringify({
      color: metrics.titlePlaceholderColor,
      contrast: metrics.titlePlaceholderContrast,
    })}`,
  );
  assert(
    metrics.addIconHeight >= 22 && metrics.addIconHeight <= 28 && metrics.addCoverHeight >= 22 && metrics.addCoverHeight <= 28,
    `first page add-icon/add-cover controls should stay compact, got icon=${metrics.addIconHeight}px cover=${metrics.addCoverHeight}px`,
  );
  assert(
    metrics.addIconContrast >= 3.5 &&
      metrics.addCoverContrast >= 3.5 &&
      metrics.addCommentContrast >= 3.5,
    `first page option controls should stay quiet but readable instead of fading into the page: ${JSON.stringify({
      addIcon: metrics.addIconContrast,
      addCover: metrics.addCoverContrast,
      addComment: metrics.addCommentContrast,
    })}`,
  );
  assert(
    metrics.topbarShareText === 'Share' &&
      metrics.topbarShareWidth >= 58 &&
      metrics.topbarShareWidth <= 84 &&
      metrics.topbarShareHeight >= 26 &&
      metrics.topbarShareHeight <= 30 &&
      metrics.topbarShareBorderWidth >= 0.5 &&
      metrics.topbarShareBorderColor !== 'rgba(0, 0, 0, 0)',
    `first page Share action should be a compact bordered pill, got ${JSON.stringify({
      text: metrics.topbarShareText,
      width: Math.round(metrics.topbarShareWidth),
      height: Math.round(metrics.topbarShareHeight),
      borderWidth: metrics.topbarShareBorderWidth,
      borderColor: metrics.topbarShareBorderColor,
    })}`,
  );
  assert(
    metrics.topbarCommentWidth >= 26 &&
      metrics.topbarCommentWidth <= 30 &&
      metrics.topbarCommentHeight >= 26 &&
      metrics.topbarCommentHeight <= 30 &&
      metrics.topbarIconActionCount >= 2 &&
      metrics.topbarIconActionMinWidth >= 27 &&
      metrics.topbarIconActionMaxWidth <= 29 &&
      metrics.topbarIconActionMinHeight >= 27 &&
      metrics.topbarIconActionMaxHeight <= 29 &&
      metrics.topbarActionCenterSpread <= 1,
    `first page topbar actions should keep Comment icon-sized and aligned, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.titleTop - metrics.addIconBottom >= 0 && metrics.titleTop - metrics.addIconBottom <= 10,
    `first page controls should sit directly above the title, got ${Math.round(metrics.titleTop - metrics.addIconBottom)}px gap`,
  );
  assert(
    Math.abs(metrics.addCoverTop - metrics.addIconTop) <= 1 && metrics.addCoverLeft > metrics.addIconLeft,
    `first page controls should align on one row, got addIconTop=${metrics.addIconTop} addCoverTop=${metrics.addCoverTop}`,
  );
  assert(
    metrics.starterTop - metrics.titleBottom >= 260 && metrics.starterTop - metrics.titleBottom <= 560,
    `first page starter should read as a quiet lower creation rail like the live Notion new-page reference, got ${Math.round(metrics.starterTop - metrics.titleBottom)}px gap`,
  );
  assert(
    Math.abs(metrics.bodyLeft - metrics.titleLeft) <= 2,
    `first page body should align with title, got body offset=${Math.round(metrics.bodyLeft - metrics.titleLeft)}`,
  );
  assert(
    Math.abs(metrics.starterLeft - metrics.titleLeft) <= 2,
    `first page starter should align with the title axis instead of the block gutter, got ${Math.round(metrics.starterLeft - metrics.titleLeft)}px`,
  );
  assert(
    metrics.starterActionCount >= 4 &&
      metrics.starterMinTextContrast >= 4.5 &&
      metrics.starterMaxButtonWidth <= 150 &&
      metrics.starterButtonTopSpread <= 2,
    `first page starter actions should stay readable, compact, and pill-like instead of a large chooser grid: ${JSON.stringify({
      count: metrics.starterActionCount,
      labels: metrics.starterButtonLabels,
      contrast: metrics.starterMinTextContrast,
      maxWidth: metrics.starterMaxButtonWidth,
      topSpread: metrics.starterButtonTopSpread,
    })}`,
  );
  assert(
    !metrics.starterButtonLabels.includes('Empty page') &&
      metrics.starterButtonLabels.includes('Database') &&
      metrics.starterButtonLabels.includes('Templates') &&
      metrics.starterButtonLabels.includes('Import') &&
      metrics.starterButtonLabels.includes('More'),
    `first page starter should mirror current Notion's creation rail minus AI actions, not ask the user to choose an already-empty page: ${JSON.stringify(metrics.starterButtonLabels)}`,
  );
  assert(
    metrics.pagePlaceholderText === '""' || metrics.pagePlaceholderText === 'none',
    `first page body placeholder should stay quiet while starter is visible, got ${metrics.pagePlaceholderText}`,
  );
  assert(
    metrics.treeRowCurrent === 'page',
    `first created page should be selected in the sidebar tree, got aria-current=${metrics.treeRowCurrent}`,
  );
  assert(
    metrics.treeRowLevel === '1',
    `sidebar footer New page should create a Private root page instead of a nested child, got aria-level=${metrics.treeRowLevel}`,
  );
  assert(
    metrics.treeRowHeight >= 28 && metrics.treeRowHeight <= 31 && metrics.treeRowWidth >= 120,
    `first created page sidebar row should stay on the current Notion-style 30px rhythm and visible, got ${Math.round(metrics.treeRowWidth)}x${Math.round(metrics.treeRowHeight)}`,
  );
  assert(
    metrics.presenceVisible === false,
    'first created page should not show a floating presence badge for the current user alone',
  );
}

async function assertFirstPageDatabaseStarterRuntime(page, parentPageId) {
  await expectFirstCreatedPageLoaded(page, parentPageId);
  const beforeUrl = page.url();
  const starter = page.getByRole('group', { name: 'Page starter', exact: true });
  const databaseButton = starter.getByRole('button', { name: 'Database' });
  await databaseButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await Promise.all([
    page.waitForFunction((url) => window.location.href !== url, beforeUrl, { timeout: options.timeoutMs }),
    databaseButton.click({ timeout: options.timeoutMs }),
  ]);

  const path = new URL(page.url()).pathname;
  const databasePageId = path.split('/').filter(Boolean).at(-1);
  assert(databasePageId && databasePageId !== parentPageId, `database starter should navigate to the new database page, got ${path}`);

  await page.waitForFunction(
    () => {
      const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
      const tablist = document.querySelector('[role="tablist"]');
      const newRow = document.querySelector('[data-table-new-row]');
      const rowsLoading = document.querySelector('[data-table-rows-loading]');
      return (
        title instanceof HTMLElement &&
        title.textContent?.trim() === '' &&
        tablist?.getAttribute('aria-label') === 'Untitled views' &&
        newRow instanceof HTMLElement &&
        rowsLoading === null
      );
    },
    undefined,
    { timeout: options.timeoutMs },
  );

  const metrics = await page.evaluate(() => {
    const visibleElement = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.offsetParent !== null &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05 &&
        rect.width > 0 &&
        rect.height > 0;
    };
    const doc = document.querySelector('[data-page-search-root]');
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const tablist = document.querySelector('[role="tablist"]');
    const starter = document.querySelector('[role="group"][aria-label="Page starter"]');
    const inlineTitleInput = document.querySelector('input[aria-label$="database title"]');
    const addPropertyButton = document.querySelector('button[aria-label="Add a property"]');
    const addPropertyGroup = document.querySelector('[data-add-property-column]');
    const headerRow = document.querySelector('[data-table-head]');
    const summaryRow = document.querySelector('[data-table-summary-row]');
    const newRow = document.querySelector('[data-table-new-row]');
    const tableEmpty = document.querySelector('[class*="tableEmpty"]');
    const visibleCells = Array.from(document.querySelectorAll('[data-table-cell]')).filter(visibleElement);
    const headerRect = headerRow instanceof HTMLElement ? headerRow.getBoundingClientRect() : null;
    const visibleHeaderChildren = headerRow instanceof HTMLElement
      ? Array.from(headerRow.children).filter(visibleElement)
      : [];
    const propertyHeaderNames = visibleHeaderChildren
      .filter((child) => child.hasAttribute('data-table-property-header'))
      .map((cell) =>
        (cell.querySelector('button[aria-label$=" property options"]')?.getAttribute('aria-label') ?? '')
          .replace(/ property options$/, ''),
      );
    const rowGutterHeadVisible = visibleHeaderChildren.some(
      (child) => typeof child.className === 'string' && child.className.includes('rowGutterHead'),
    );
    const addPropertyGroupIsLastHeaderChild =
      visibleHeaderChildren.length > 0 && visibleHeaderChildren.at(-1) === addPropertyGroup;
    const addPropertyGroupButtonLabels = addPropertyGroup instanceof HTMLElement
      ? Array.from(addPropertyGroup.querySelectorAll(':scope > button'))
          .filter(visibleElement)
          .map((button) => button.getAttribute('aria-label') ?? '')
      : [];
    const newRowRect = newRow instanceof HTMLElement ? newRow.getBoundingClientRect() : null;
    const rowTitleValues = visibleCells
      .map((cell) => cell.querySelector('input[type="text"]')?.value ?? '')
      .filter(Boolean);
    return {
      titleText: title?.textContent?.trim() ?? '',
      titlePlaceholder: title?.getAttribute('data-placeholder') ?? title?.getAttribute('aria-placeholder') ?? '',
      tablistLabel: tablist?.getAttribute('aria-label') ?? '',
      docText: doc instanceof HTMLElement ? doc.textContent?.replace(/\s+/g, ' ').trim() ?? '' : '',
      bodyText: document.body.innerText?.replace(/\s+/g, ' ').trim() ?? '',
      starterVisible: starter instanceof HTMLElement && visibleElement(starter),
      inlineTitleInputVisible: inlineTitleInput instanceof HTMLElement && visibleElement(inlineTitleInput),
      addPropertyButtonLabel: addPropertyButton instanceof HTMLElement
        ? addPropertyButton.getAttribute('aria-label') ?? ''
        : '',
      headerChildCount: visibleHeaderChildren.length,
      propertyHeaderNames,
      rowGutterHeadVisible,
      addPropertyGroupIsLastHeaderChild,
      addPropertyGroupButtonLabels,
      headerWidth: headerRect?.width ?? 0,
      summaryVisible: summaryRow instanceof HTMLElement && visibleElement(summaryRow),
      summaryChildCount: summaryRow instanceof HTMLElement
        ? Array.from(summaryRow.children).filter(visibleElement).length
        : 0,
      tableEmptyVisible: tableEmpty instanceof HTMLElement && visibleElement(tableEmpty),
      visibleCellCount: visibleCells.length,
      rowTitleValues,
      newRowText: newRow instanceof HTMLElement ? newRow.textContent?.replace(/\s+/g, ' ').trim() ?? '' : '',
      newRowWidth: newRowRect?.width ?? 0,
    };
  });

  assert(
    metrics.titleText === '',
    `page starter Database should leave the database title empty instead of persisting New database: ${JSON.stringify(metrics)}`,
  );
  assert(
    ['Untitled', '새 페이지'].includes(metrics.titlePlaceholder) && metrics.tablistLabel === 'Untitled views',
    `new starter database should use placeholder/fallback labels without storing a title: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.starterVisible === false && metrics.inlineTitleInputVisible === false,
    `page starter Database should not leave an inline Untitled database block on the parent page: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.addPropertyButtonLabel === 'Add a property' &&
      metrics.propertyHeaderNames.join('|') === 'Name' &&
      metrics.rowGutterHeadVisible === true &&
      metrics.addPropertyGroupIsLastHeaderChild === true &&
      metrics.addPropertyGroupButtonLabels.join('|') === 'Add a property|Property options' &&
      metrics.headerChildCount === 3,
    `new starter database header should be row gutter + Name + trailing add-property (+ before ...) group, not default Status/Tags columns: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.visibleCellCount === 0 &&
      metrics.rowTitleValues.length === 0 &&
      metrics.tableEmptyVisible === false &&
      metrics.summaryVisible === false &&
      metrics.newRowWidth >= metrics.headerWidth - 2 &&
      metrics.newRowText === 'New',
    `new starter database should start as a blank table with only the New row affordance, not an empty-state card or seeded Untitled rows: ${JSON.stringify(metrics)}`,
  );
  assert(
    !/\bUntitled\b/.test(metrics.docText) &&
      !/\bNo pages yet\b/.test(metrics.docText) &&
      !/\bThis database has no pages yet\b/.test(metrics.docText) &&
      !/\bStatus\b/.test(metrics.docText) &&
      !/\bTags\b/.test(metrics.docText),
    `new starter database document should not show fallback empty-state/Untitled/Status/Tags copy (sidebar/topbar may show the Untitled fallback label for the blank title): ${JSON.stringify({ docText: metrics.docText, bodyText: metrics.bodyText })}`,
  );
}

async function assertMobileFirstCreatedPageVisualContract(page) {
  const metrics = await page.evaluate(() => {
    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const starter = document.querySelector('[role="group"][aria-label="Page starter"]');
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    const addIcon = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add icon',
    );
    const addCover = document.querySelector('button[aria-label="Add page cover"]');
    const addComment = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add comment',
    );
    const sidebar = document.querySelector('[aria-label="Sidebar"]');
    const presence = document.querySelector('[data-testid="page-presence"]');
    if (
      !(scroll instanceof HTMLElement) ||
      !(doc instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(starter instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(addIcon instanceof HTMLElement) ||
      !(addCover instanceof HTMLElement) ||
      !(addComment instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'missing mobile first page visual markers' };
    }

    const scrollRect = scroll.getBoundingClientRect();
    const docRect = doc.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const starterRect = starter.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const addIconRect = addIcon.getBoundingClientRect();
    const addCoverRect = addCover.getBoundingClientRect();
    const addCommentRect = addComment.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const titlePlaceholderStyle = getComputedStyle(title, '::before');
    const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : null;
    const pagePlaceholder = document.querySelector('[data-page-placeholder="true"]');
    const pagePlaceholderStyle =
      pagePlaceholder instanceof HTMLElement
        ? getComputedStyle(pagePlaceholder, '::before')
        : null;
    const parseColor = (color) => {
      const srgbMatch = color.match(/color\(srgb\s+([^)]+)\)/);
      if (srgbMatch) {
        const parts = srgbMatch[1]
          .replace(/\//g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .map((part) => Number.parseFloat(part));
        if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
      }
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: Number.isFinite(parts[3]) ? parts[3] : 1 };
    };
    const blend = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const channel = (value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    const contrastRatio = (fgColor, bgColor) => {
      const fg = parseColor(fgColor);
      const bg = parseColor(bgColor);
      if (!fg || !bg) return 0;
      const blendedFg = blend(fg, bg);
      const lighter = Math.max(luminance(blendedFg), luminance(bg));
      const darker = Math.min(luminance(blendedFg), luminance(bg));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const pageBackground = getComputedStyle(document.body).backgroundColor;
    const starterButtons = Array.from(starter.querySelectorAll('button')).filter(
      (button) => button instanceof HTMLElement && button.offsetParent !== null,
    );
    const starterButtonLabels = starterButtons.map((button) =>
      button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
    const starterTextContrasts = starterButtons.map((button) =>
      contrastRatio(getComputedStyle(button).color, pageBackground),
    );
    const starterButtonRects = starterButtons.map((button) => button.getBoundingClientRect());
    const starterButtonTops = starterButtonRects.map((rect) => rect.top);
    return {
      ok: true,
      viewportWidth: window.innerWidth,
      scrollTop: scrollRect.top,
      scrollLeft: scrollRect.left,
      docWidth: docRect.width,
      titleTop: titleRect.top,
      titleLeft: titleRect.left,
      titleBottom: titleRect.bottom,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      titlePlaceholderColor: titlePlaceholderStyle.color,
      titlePlaceholderContrast: contrastRatio(titlePlaceholderStyle.color, pageBackground),
      addIconTop: addIconRect.top,
      addIconLeft: addIconRect.left,
      addIconBottom: addIconRect.bottom,
      addIconHeight: addIconRect.height,
      addIconContrast: contrastRatio(getComputedStyle(addIcon).color, pageBackground),
      addCoverTop: addCoverRect.top,
      addCoverLeft: addCoverRect.left,
      addCoverHeight: addCoverRect.height,
      addCoverContrast: contrastRatio(getComputedStyle(addCover).color, pageBackground),
      addCommentTop: addCommentRect.top,
      addCommentLeft: addCommentRect.left,
      addCommentHeight: addCommentRect.height,
      addCommentContrast: contrastRatio(getComputedStyle(addComment).color, pageBackground),
      starterTop: starterRect.top,
      starterLeft: starterRect.left,
      starterWidth: starterRect.width,
      starterActionCount: starterButtons.length,
      starterButtonLabels,
      starterMinTextContrast: Math.min(...starterTextContrasts),
      starterButtonTopSpread: Math.max(...starterButtonTops) - Math.min(...starterButtonTops),
      pagePlaceholderText: pagePlaceholderStyle?.content ?? null,
      bodyLeft: bodyRect.left,
      bodyWidth: bodyRect.width,
      sidebarVisible: !!sidebarRect && sidebarRect.right > 16 && sidebarRect.left < window.innerWidth - 16,
      presenceVisible: presence instanceof HTMLElement,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'mobile first page visual contract could not run');
  assert(
    metrics.viewportWidth <= 430,
    `mobile first page should run in a narrow viewport, got ${Math.round(metrics.viewportWidth)}px`,
  );
  assert(
    metrics.sidebarVisible === false,
    'mobile first page should not leave the desktop sidebar open over the page',
  );
  assert(
    metrics.docWidth <= metrics.viewportWidth && metrics.docWidth >= metrics.viewportWidth - 64,
    `mobile first page document should fit the viewport, got ${Math.round(metrics.docWidth)}px in ${Math.round(metrics.viewportWidth)}px viewport`,
  );
  assert(
    metrics.titleTop - metrics.scrollTop >= 80 && metrics.titleTop - metrics.scrollTop <= 145,
    `mobile first page title should sit near the top, got ${Math.round(metrics.titleTop - metrics.scrollTop)}px from page viewport top`,
  );
  assert(
    metrics.titleLeft - metrics.scrollLeft >= 20 && metrics.titleLeft - metrics.scrollLeft <= 40,
    `mobile first page title should align to the mobile document gutter, got ${Math.round(metrics.titleLeft - metrics.scrollLeft)}px`,
  );
  assert(
    metrics.titleFontSize >= 36 && metrics.titleFontSize <= 48,
    `mobile first page title placeholder should be page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    metrics.titlePlaceholderContrast >= 4.5,
    `mobile first page empty title placeholder should stay readable instead of looking disabled: ${JSON.stringify({
      color: metrics.titlePlaceholderColor,
      contrast: metrics.titlePlaceholderContrast,
    })}`,
  );
  assert(
    metrics.addIconHeight >= 22 && metrics.addIconHeight <= 30 && metrics.addCoverHeight >= 22 && metrics.addCoverHeight <= 30,
    `mobile first page add-icon/add-cover controls should stay compact, got icon=${metrics.addIconHeight}px cover=${metrics.addCoverHeight}px`,
  );
  assert(
    metrics.addIconContrast >= 3.5 &&
      metrics.addCoverContrast >= 3.5 &&
      metrics.addCommentContrast >= 3.5,
    `mobile first page option controls should stay quiet but readable: ${JSON.stringify({
      addIcon: metrics.addIconContrast,
      addCover: metrics.addCoverContrast,
      addComment: metrics.addCommentContrast,
    })}`,
  );
  assert(
    Math.abs(metrics.addCoverTop - metrics.addIconTop) <= 1 && metrics.addCoverLeft > metrics.addIconLeft,
    `mobile first page controls should align on one row, got addIconTop=${metrics.addIconTop} addCoverTop=${metrics.addCoverTop}`,
  );
  assert(
    metrics.starterTop - metrics.titleBottom >= 180 && metrics.starterTop - metrics.titleBottom <= 390,
    `mobile first page starter should stay visible but lower in the first viewport like the live Notion new-page reference, got ${Math.round(metrics.starterTop - metrics.titleBottom)}px gap`,
  );
  assert(
    Math.abs(metrics.bodyLeft - metrics.titleLeft) <= 2,
    `mobile first page body should align with title, got body offset=${Math.round(metrics.bodyLeft - metrics.titleLeft)}`,
  );
  assert(
    Math.abs(metrics.starterLeft - metrics.titleLeft) <= 2,
    `mobile first page starter should align with the title axis, got ${Math.round(metrics.starterLeft - metrics.titleLeft)}px`,
  );
  assert(
    metrics.starterActionCount >= 4 &&
      metrics.starterMinTextContrast >= 4.5 &&
      metrics.starterButtonTopSpread <= 2,
    `mobile first page starter actions should stay readable and compact: ${JSON.stringify({
      count: metrics.starterActionCount,
      labels: metrics.starterButtonLabels,
      contrast: metrics.starterMinTextContrast,
      topSpread: metrics.starterButtonTopSpread,
    })}`,
  );
  assert(
    !metrics.starterButtonLabels.includes('Empty page') &&
      metrics.starterButtonLabels.includes('Database') &&
      metrics.starterButtonLabels.includes('Templates') &&
      metrics.starterButtonLabels.includes('Import') &&
      metrics.starterButtonLabels.includes('More'),
    `mobile first page starter should keep the current Notion-style creation rail minus AI actions: ${JSON.stringify(metrics.starterButtonLabels)}`,
  );
  assert(
    metrics.pagePlaceholderText === '""' || metrics.pagePlaceholderText === 'none',
    `mobile first page body placeholder should stay quiet while starter is visible, got ${metrics.pagePlaceholderText}`,
  );
  assert(
    metrics.presenceVisible === false,
    'mobile first page should not show a floating presence badge for the current user alone',
  );
}

async function seedStaleWorkspaceCache(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('hanji.workspaceId', 'first-workspace-stale-workspace-id');
    window.localStorage.setItem('hanji:theme', 'light');
  });
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
  const expectedMobile = viewport.width <= 767;
  await page.waitForFunction(
    ([width, expectedMobile]) => {
      if (window.innerWidth !== width) return false;
      const sidebar = document.querySelector('[aria-label="Sidebar"]');
      if (!sidebar) return true;
      return (sidebar.getAttribute('data-mobile') === 'true') === expectedMobile;
    },
    [viewport.width, expectedMobile],
    { timeout: options.timeoutMs },
  );
  if (expectedMobile) {
    await page.waitForFunction(
      () => {
        const sidebar = document.querySelector('[aria-label="Sidebar"]');
        if (!(sidebar instanceof HTMLElement)) return true;
        const rect = sidebar.getBoundingClientRect();
        const open = sidebar.getAttribute('data-open') === 'true';
        return open ? rect.left >= -1 && rect.right > 200 : rect.right <= 16;
      },
      undefined,
      { timeout: options.timeoutMs },
    );
  }
  await page.waitForTimeout(80);
}

async function clickPasswordTab(page) {
  try {
    await ensurePasswordAuthForm(page, options.timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Password auth form was not found. Restart the EdgeBase dev runtime after rebuilding the SPA or pass --url and --api-url explicitly. ${message}`,
    );
  }
}

async function cleanupSeed(baseUrl, seed) {
  const session = await signInWithPassword(baseUrl, seed.email, seed.password).catch(() => null);
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

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
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
  // Signed-out boot fires one expected /api/auth/refresh 401 (cookie-session
  // probe); the shared watcher allows exactly that one and records the rest.
  const { errors } = watchBrowserErrors(page, { allowInitialSignedOutRefresh401: true });
  return { context, page, errors };
}

function assertNoBrowserErrors(errors, label) {
  if (errors.length) {
    throw new Error(`Browser errors while checking ${label}:\n- ${errors.join('\n- ')}`);
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
    'Playwright is required for first workspace visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
  );
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
  return [direct, ...pnpmCandidates];
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
    screenshotDir: DEFAULT_SCREENSHOT_DIR,
    headed: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--url') {
      parsed.url = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--api-url') {
      parsed.apiUrl = readValue(args, i, arg);
      i += 1;
    } else if (arg === '--timeout' || arg === '--timeout-ms') {
      parsed.timeoutMs = Number(readValue(args, i, arg));
      i += 1;
    } else if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(readValue(args, i, arg));
      i += 1;
    } else if (arg === '--headed') {
      parsed.headed = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) parsed.timeoutMs = DEFAULT_TIMEOUT_MS;
  parsed.screenshotDir = resolve(parsed.screenshotDir);
  return parsed;
}

function readValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
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
