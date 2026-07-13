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
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'sidebar-tree');
const PAGE_DRAG_TYPE = 'application/x-hanji-page-id';
const BLOCK_DRAG_TYPE = 'application/x-hanji-block';
const BLOCK_DRAG_IDS_TYPE = 'application/x-hanji-block-ids';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL page tree UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Page tree UI smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Page tree UI smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedPageTree(apiUrl);
  seed.apiUrl = apiUrl;
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);

  try {
    if (options.onlyActiveParentCollapse) {
      await assertActiveDescendantParentDisclosureOnly(browser, appUrl, seed);
      console.log('PASS sidebar parent rows are not forced open by the active descendant, and manual disclosure remains isolated.');
      return;
    }
    if (options.onlyDatabaseChildViews) {
      await assertDatabaseChildViewsOnly(browser, appUrl, seed);
      console.log('PASS sidebar hides database view rows and keeps database internals out of the page tree.');
      return;
    }
    if (options.onlySidebarCollapseMotion) {
      await assertSidebarCollapseMotionOnly(browser, appUrl, seed);
      console.log('PASS desktop sidebar collapse and expand use Hanji panel slide motion.');
      return;
    }
    await assertPageTreeUi(browser, appUrl, seed);
    await assertViewOnlyPageTreeUi(browser, appUrl, seed);
    await assertEmptyPrivateTreeFirstPage(browser, appUrl, seed);
    console.log('PASS sidebar page tree expands, focuses, jumps to edges, opens nested pages, captures nested tree screenshots, drags pages inside/back to root, reorders roots/nested children, copies pages by drag, moves/copies pages through the private root drop zone, moves/copies blocks into tree pages, creates private-root pages from block drops, runs menu rename/duplicate/trash actions, blocks view-only tree edits, and creates the first page in an empty workspace.');
    console.log(`Nested tree screenshot: ${join(options.screenshotDir, 'desktop-nested-sidebar-tree.png')}`);
    console.log(`Sidebar inventory: ${join(options.screenshotDir, 'desktop-sidebar-inventory-idle.json')}`);
    console.log(`Private header hover screenshot: ${join(options.screenshotDir, 'desktop-private-section-header-hover.png')}`);
    console.log(`Private header inventory: ${join(options.screenshotDir, 'desktop-sidebar-inventory-private-header-hover.json')}`);
    console.log(`Secondary header hover screenshot: ${join(options.screenshotDir, 'desktop-secondary-section-header-hover.png')}`);
    console.log(`Nested tree hover screenshot: ${join(options.screenshotDir, 'desktop-nested-sidebar-tree-hover.png')}`);
    console.log(`Page row hover inventory: ${join(options.screenshotDir, 'desktop-sidebar-inventory-page-row-hover.json')}`);
    console.log(`Nested tree dark screenshot: ${join(options.screenshotDir, 'desktop-nested-sidebar-tree-dark.png')}`);
    console.log(`Private header dark hover screenshot: ${join(options.screenshotDir, 'desktop-private-section-header-dark-hover.png')}`);
    console.log(`Secondary header dark hover screenshot: ${join(options.screenshotDir, 'desktop-secondary-section-header-dark-hover.png')}`);
    console.log(`Nested tree dark hover screenshot: ${join(options.screenshotDir, 'desktop-nested-sidebar-tree-dark-hover.png')}`);
    console.log(`Nested tree mobile screenshot: ${join(options.screenshotDir, 'mobile-nested-sidebar-tree.png')}`);
    console.log(`Nested tree mobile dark screenshot: ${join(options.screenshotDir, 'mobile-nested-sidebar-tree-dark.png')}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertActiveDescendantParentDisclosureOnly(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  const favoritedRoot = await callFunction(apiBaseUrl(baseUrl, seed), seed.accessToken, 'page-mutation', {
    action: 'update',
    id: seed.rootPageId,
    patch: { isFavorite: true },
  });
  assert(favoritedRoot?.page?.isFavorite === true, 'active-parent collapse fixture root page must be favorited');
  await seedSession(context, seed);

  try {
    await assertActiveDescendantParentDisclosureManual(page, baseUrl, seed, {
      assertShortcutIsolation: true,
      capture: true,
    });
    assertNoBrowserErrors(errors, 'active-descendant parent manual disclosure flow');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertDatabaseChildViewsOnly(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await assertDatabaseChildViewsManualExpansion(page, baseUrl, seed);
    assertNoBrowserErrors(errors, 'database child view manual disclosure flow');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertSidebarCollapseMotionOnly(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
    await assertPrivateTreeRendered(page, seed);
    await assertSidebarCollapseExpandMotion(page);
    assertNoBrowserErrors(errors, 'sidebar collapse and expand motion flow');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertPageTreeUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
    await step('render private page tree', () => assertPrivateTreeRendered(page, seed));
    await step('animate desktop sidebar collapse and expand', () => assertSidebarCollapseExpandMotion(page));
    await step('expand shared shortcut tree children', () => assertSharedShortcutTreeExpansion(page, seed));
    await step('keep database view tabs out of the sidebar page tree', () =>
      assertDatabaseChildViewsManualExpansion(page, baseUrl, seed),
    );
    await step('verify populated private tree has no persistent add row', () =>
      assertNoPersistentPrivateAddRow(page),
    );
    await step('verify private section header hover-only affordances', () =>
      assertPrivateSectionHeaderAffordanceLayout(page, seed),
    );
    await step('verify secondary section header compact affordances', () =>
      assertSecondarySectionHeaderAffordanceLayout(page, seed),
    );
    await step('verify sidebar workspace header idle/hover chrome', () =>
      assertSidebarWorkspaceHeaderLayout(page),
    );
    await step('verify sidebar top action layout contract', () => assertSidebarTopActionLayout(page));
    await step('keep member management out of sidebar promo cards', () => assertNoSidebarMemberCard(page));
    await step('verify sidebar footer action layout contract', () => assertSidebarFooterActionLayout(page));
    await step('discover collapsed page tree caret layout issues', () =>
      assertCollapsedTreeDisclosureLayout(page, seed),
    );
    await step('expand and focus nested pages with keyboard', () => assertKeyboardExpansion(page, seed));
    await step('keep active descendant navigation from forcing parent disclosure', () =>
      assertActiveDescendantParentDisclosureManual(page, baseUrl, seed),
    );
    await step('discover expanded page tree idle/hover affordance issues', () =>
      assertExpandedTreeDisclosureLayout(page, seed),
    );
    await step('verify page tree row grid and indentation contract', () =>
      assertPageTreeRowLayout(page, seed),
    );
    await step('verify page tree hover keeps row geometry stable', () =>
      assertTreeHoverDoesNotShiftLayout(page, seed),
    );
    await step('capture nested sidebar tree visual fixture', () =>
      captureNestedSidebarTreeScreenshots(page, seed),
    );
    await step('capture mobile nested sidebar tree visual fixture', () =>
      captureMobileNestedSidebarTreeScreenshots(page, seed),
    );
    await step('open nested page from tree keyboard', () => assertKeyboardOpen(page, seed));
    await step('drag a root page inside another page and back to the root', () =>
      assertTreeDragAndDrop(page, baseUrl, seed),
    );
    await step('move and copy editor blocks into pages from the tree', () =>
      assertBlockDropIntoPageTree(page, baseUrl, seed),
    );
    await step('move and copy editor blocks onto private root as new pages', () =>
      assertBlockDropToPrivateRoot(page, baseUrl, seed),
    );
    await step('rename, duplicate, and trash pages from the tree menu', () =>
      assertTreeMenuActions(page, baseUrl, seed),
    );
    assertNoBrowserErrors(errors, 'page tree UI flow');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertEmptyPrivateTreeFirstPage(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  // Same user, different workspace: reuse the hand-off session (replaying the
  // original refresh token would trip rotation reuse detection).
  await seedSession(context, seed, { workspaceId: seed.emptyWorkspaceId });

  try {
    await page.goto(resolveUrl(baseUrl, `/workspace/${encodeURIComponent(seed.emptyWorkspaceDomain)}`), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await step('render empty private page tree', () => assertEmptyPrivateTree(page));
    await step('create first private page from empty tree', async () => {
      await page.getByRole('button', { name: 'Create first page' }).click({
        timeout: options.timeoutMs,
      });
      const createdPageId = await waitForCurrentPageId(page);
      seed.emptyCreatedPageId = createdPageId;
      await page.getByRole('textbox', { name: 'Page title' }).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await treeRow(page, createdPageId).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await expectTreeRowAttribute(page, createdPageId, 'aria-current', 'page');
    });
    assertNoBrowserErrors(errors, 'empty page tree first-page flow');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertViewOnlyPageTreeUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  // Separate user: keep its session object stable on the seed so its rotated
  // cookie is captured/replayed independently of the owner session.
  seed.viewOnlySession ??= {
    refreshToken: seed.viewOnlyRefreshToken,
    userId: seed.viewOnlyUserId,
    workspaceId: seed.workspaceId,
  };
  await seedSession(context, seed.viewOnlySession);
  const viewOnlyPageId = seed.sharedPageId;
  const viewOnlyTitle = seed.sharedTitle;

  try {
    await openPage(page, baseUrl, viewOnlyPageId, viewOnlyTitle);
    await step('render view-only shared page in the tree', async () => {
      await treeRow(page, viewOnlyPageId).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await expectTreeRowHidden(page, seed.rootPageId);
      await expectTreeRowAttribute(page, viewOnlyPageId, 'aria-level', '1');
      await expectTreeRowAttribute(page, viewOnlyPageId, 'aria-current', 'page');
    });
    await step('disable view-only page tree creation and drag entry points', async () => {
      await expectButtonDisabledOrHidden(page.getByRole('button', { name: 'Add a page' }));
      await expectButtonDisabledOrHidden(page.getByRole('button', { name: /^Add a page$/ }));
      await expectTreeRowNotDraggable(page, viewOnlyPageId);
      await expectLocatorHidden(page.getByRole('button', { name: `Add a page inside ${viewOnlyTitle}` }));
    });
    await step('disable view-only tree menu mutation actions', async () => {
      const menu = await openTreePageMenu(page, viewOnlyPageId);
      await expectButtonDisabled(menu.getByRole('menuitem', { name: /^Add to Favorites/ }));
      await expectButtonDisabled(menu.getByRole('menuitem', { name: /^Rename/ }));
      await expectButtonDisabled(menu.getByRole('menuitem', { name: /^Duplicate/ }));
      await expectButtonDisabled(menu.getByRole('menuitem', { name: /^Move to(?! Trash)/ }));
      await expectButtonDisabled(menu.getByRole('menuitem', { name: /^Import Markdown/ }));
      await expectButtonDisabled(menu.getByRole('menuitemcheckbox', { name: /^(Lock|Unlock) page/ }));
      await expectButtonDisabled(menu.getByRole('menuitemcheckbox', { name: /^(Verify|Remove verification)/ }));
      await expectButtonDisabled(menu.getByRole('menuitem', { name: /^Move to Trash/ }));
      await expectLocatorHidden(menu.getByRole('menuitem', { name: /^Add page inside/ }));
      await page.getByRole('button', { name: 'Close page actions' }).click({ timeout: options.timeoutMs });
      await expectLocatorHidden(menu);
    });
    await step('keep F2 rename disabled for view-only tree rows', async () => {
      const row = treeRow(page, viewOnlyPageId);
      await row.focus({ timeout: options.timeoutMs });
      await row.press('F2', { timeout: options.timeoutMs });
      await expectLocatorHidden(page.locator('input[aria-label^="Rename "]'));
    });
    assertNoBrowserErrors(errors, 'view-only page tree permission flow');
  } finally {
    await closeSeededContext(context, seed.viewOnlySession);
  }
}

async function assertSidebarCollapseExpandMotion(page) {
  const artifactDir = options.screenshotDir;
  mkdirSync(artifactDir, { recursive: true });
  await page.waitForFunction(
    () => {
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      const main = document.querySelector('main');
      return (
        sidebar instanceof HTMLElement &&
        main instanceof HTMLElement &&
        sidebar.getBoundingClientRect().width >= 260 &&
        main.getBoundingClientRect().left >= 260 &&
        sidebar.getAttribute('data-collapsed') !== 'true'
      );
    },
    null,
    { timeout: options.timeoutMs },
  );
  const before = await collectSidebarMotionState(page);
  assert(before.sidebarPresent, `sidebar should be present before collapse: ${JSON.stringify(before)}`);
  assert(
    before.sidebarWidth >= 264 && before.sidebarWidth <= 276,
    `desktop sidebar should start near the Hanji 270px width: ${JSON.stringify(before)}`,
  );
  assert(
    before.slotWidth >= 264 && before.slotWidth <= 276,
    `desktop sidebar layout slot should start at the sidebar width: ${JSON.stringify(before)}`,
  );

  const closeButton = page.locator('[data-sidebar-collapse-action]');
  const closeTarget = await closeButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(closeTarget.x, closeTarget.y);
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-sidebar-collapse-action]');
      if (!(button instanceof HTMLElement)) return false;
      const style = getComputedStyle(button);
      return Number.parseFloat(style.opacity) >= 0.8 && style.pointerEvents !== 'none';
    },
    null,
    { timeout: options.timeoutMs },
  );
  await closeButton.click({
    timeout: options.timeoutMs,
  });
  const closingSamples = await collectSidebarMotionSamples(page);
  const closingState = closingSamples.find((sample) => sample.dataCollapsed === 'true') ?? closingSamples.at(-1);
  const closing = closingSamples.find(
    (sample) =>
      sample.dataCollapsed === 'true' &&
      sample.slotWidth > 4 &&
      sample.slotWidth < before.slotWidth - 8 &&
      (sample.sidebarLeft < before.sidebarLeft - 8 || sample.opacity < before.opacity - 0.02),
  );
  assert(closingState?.sidebarPresent, `collapsing sidebar should stay mounted: ${JSON.stringify(closingSamples)}`);
  assert(closingState.dataCollapsed === 'true', `collapsing sidebar should expose collapsed state: ${JSON.stringify(closingSamples)}`);
  assert(
    closingState.ariaHidden === 'true' && closingState.inert,
    `collapsed sidebar should be inert to hidden focus: ${JSON.stringify(closingSamples)}`,
  );
  if (!closingState.reducedMotion) {
    assert(closing, `sidebar collapse should have a visible intermediate slide frame: ${JSON.stringify({ before, closingSamples })}`);
    assert(
      Math.abs(closing.sidebarWidth - before.sidebarWidth) <= 2,
      `sidebar panel should keep its real width while sliding away: ${JSON.stringify({ before, closing })}`,
    );
    assert(
      closing.sidebarLeft < before.sidebarLeft - 8 || closing.opacity < before.opacity,
      `sidebar collapse should visibly slide or fade instead of disappearing: ${JSON.stringify({ before, closing })}`,
    );
    assert(
      closing.slotWidth > 4 && closing.slotWidth < before.slotWidth - 8,
      `sidebar layout slot should pass through an intermediate width while the panel slides: ${JSON.stringify({ before, closing })}`,
    );
    assert(
      closing.mainLeft > 4 && closing.mainLeft < before.mainLeft - 8,
      `main column should glide while the sidebar closes: ${JSON.stringify({ before, closing })}`,
    );
    assert(
      closing.transitionProperty.includes('transform') || closing.transitionProperty.includes('all'),
      `sidebar panel should transition transform like Notion: ${JSON.stringify(closing)}`,
    );
    assert(
      closing.slotTransitionProperty.includes('width') ||
        closing.slotTransitionProperty.includes('flex-basis') ||
        closing.slotTransitionProperty.includes('all'),
      `sidebar slot should transition layout width/flex-basis: ${JSON.stringify(closing)}`,
    );
  }

  await page.waitForFunction(
    () => {
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      const main = document.querySelector('main');
      if (!(sidebar instanceof HTMLElement) || !(main instanceof HTMLElement)) return false;
      const sidebarRect = sidebar.getBoundingClientRect();
      return sidebarRect.width >= 260 && sidebarRect.right <= 24 && main.getBoundingClientRect().left <= 1;
    },
    null,
    { timeout: options.timeoutMs },
  );
  const closed = await collectSidebarMotionState(page);
  assert(closed.sidebarPresent, `closed sidebar should remain mounted for smooth reopening: ${JSON.stringify(closed)}`);
  assert(
    Math.abs(closed.sidebarWidth - before.sidebarWidth) <= 2,
    `closed sidebar panel should keep its Hanji real width offscreen: ${JSON.stringify(closed)}`,
  );
  assert(closed.sidebarRight <= 24, `closed sidebar should settle mostly offscreen with only the edge left: ${JSON.stringify(closed)}`);
  assert(closed.slotWidth <= 1, `closed sidebar layout slot should settle to zero width: ${JSON.stringify(closed)}`);
  assert(closed.mainLeft <= 1, `main column should glide to the viewport edge when sidebar closes: ${JSON.stringify(closed)}`);
  await page.screenshot({
    path: join(artifactDir, 'desktop-sidebar-collapse-closed.png'),
    fullPage: false,
  });

  await page.getByRole('button', { name: /^(Open sidebar|사이드바 열기)$/ }).click({
    timeout: options.timeoutMs,
  });
  const openingSamples = await collectSidebarMotionSamples(page);
  const openingState = openingSamples.find((sample) => sample.dataCollapsed !== 'true') ?? openingSamples.at(-1);
  const opening = openingSamples.find(
    (sample) =>
      sample.dataCollapsed !== 'true' &&
      sample.slotWidth > 4 &&
      sample.slotWidth < before.slotWidth - 8 &&
      (sample.sidebarLeft > closed.sidebarLeft + 8 || sample.opacity > closed.opacity + 0.02),
  );
  assert(openingState?.sidebarPresent, `opening sidebar should stay mounted: ${JSON.stringify(openingSamples)}`);
  assert(openingState.dataCollapsed !== 'true', `opening sidebar should clear collapsed state: ${JSON.stringify(openingSamples)}`);
  if (!openingState.reducedMotion) {
    assert(opening, `sidebar reopen should have a visible intermediate slide frame: ${JSON.stringify({ closed, openingSamples })}`);
    assert(
      Math.abs(opening.sidebarWidth - before.sidebarWidth) <= 2,
      `sidebar reopen should keep the panel width while sliding in: ${JSON.stringify({ before, opening })}`,
    );
    assert(
      opening.slotWidth > 4 && opening.slotWidth < before.slotWidth - 8,
      `sidebar reopen should animate the layout slot instead of appearing instantly: ${JSON.stringify({ before, opening })}`,
    );
    assert(
      opening.sidebarLeft > closed.sidebarLeft + 8 || opening.opacity > closed.opacity,
      `sidebar reopen should visibly slide or fade in: ${JSON.stringify({ closed, opening })}`,
    );
  }

  await page.waitForFunction(
    (targetWidth) => {
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      const slot = document.querySelector('[data-sidebar-slot]');
      const main = document.querySelector('main');
      if (!(sidebar instanceof HTMLElement) || !(slot instanceof HTMLElement) || !(main instanceof HTMLElement)) return false;
      const sidebarRect = sidebar.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const style = getComputedStyle(sidebar);
      return (
        Math.abs(sidebarRect.width - targetWidth) <= 2 &&
        Math.abs(slotRect.width - targetWidth) <= 2 &&
        Math.abs(sidebarRect.left) <= 2 &&
        Math.abs(mainRect.left - targetWidth) <= 2 &&
        Number.parseFloat(style.opacity) >= 0.99
      );
    },
    before.sidebarWidth,
    { timeout: options.timeoutMs },
  );
  const reopened = await collectSidebarMotionState(page);
  assert(reopened.ariaHidden === null && !reopened.inert, `reopened sidebar should be interactive again: ${JSON.stringify(reopened)}`);
  assert(
    Math.abs(reopened.mainLeft - reopened.sidebarRight) <= 2,
    `main column should end flush with the reopened sidebar: ${JSON.stringify(reopened)}`,
  );
  assert(
    Math.abs(reopened.slotWidth - before.slotWidth) <= 2,
    `reopened sidebar slot should restore the original layout width: ${JSON.stringify(reopened)}`,
  );

  await page.screenshot({
    path: join(artifactDir, 'desktop-sidebar-collapse-reopened.png'),
    fullPage: false,
  });
  writeFileSync(
    join(artifactDir, 'desktop-sidebar-collapse-motion.json'),
    `${JSON.stringify({ before, closingSamples, closing, closed, openingSamples, opening, reopened }, null, 2)}\n`,
  );
}

async function collectSidebarMotionSamples(page, sampleCount = 9, intervalMs = 28) {
  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    if (i > 0) await page.waitForTimeout(intervalMs);
    samples.push(await collectSidebarMotionState(page));
  }
  return samples;
}

async function collectSidebarMotionState(page) {
  return await page.evaluate(() => {
    const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
    const slot = document.querySelector('[data-sidebar-slot]');
    const main = document.querySelector('main');
    const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : null;
    const slotRect = slot instanceof HTMLElement ? slot.getBoundingClientRect() : null;
    const mainRect = main instanceof HTMLElement ? main.getBoundingClientRect() : null;
    const style = sidebar instanceof HTMLElement ? getComputedStyle(sidebar) : null;
    const slotStyle = slot instanceof HTMLElement ? getComputedStyle(slot) : null;
    return {
      sidebarPresent: sidebar instanceof HTMLElement,
      slotPresent: slot instanceof HTMLElement,
      slotWidth: slotRect?.width ?? null,
      slotLeft: slotRect?.left ?? null,
      slotRight: slotRect?.right ?? null,
      sidebarWidth: sidebarRect?.width ?? null,
      sidebarLeft: sidebarRect?.left ?? null,
      sidebarRight: sidebarRect?.right ?? null,
      mainLeft: mainRect?.left ?? null,
      mainWidth: mainRect?.width ?? null,
      dataCollapsed: sidebar instanceof HTMLElement ? sidebar.getAttribute('data-collapsed') : null,
      dataOpen: sidebar instanceof HTMLElement ? sidebar.getAttribute('data-open') : null,
      ariaHidden: sidebar instanceof HTMLElement ? sidebar.getAttribute('aria-hidden') : null,
      inert: sidebar instanceof HTMLElement ? sidebar.hasAttribute('inert') : false,
      opacity: style ? Number.parseFloat(style.opacity) : null,
      transform: style?.transform ?? null,
      transitionProperty: style?.transitionProperty ?? '',
      transitionDuration: style?.transitionDuration ?? '',
      slotTransitionProperty: slotStyle?.transitionProperty ?? '',
      slotTransitionDuration: slotStyle?.transitionDuration ?? '',
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });
}

async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

async function assertEmptyPrivateTree(page) {
  await page.locator('[role="tree"][aria-label="Pages"]').waitFor({
    state: 'attached',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    () => {
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      if (!tree) return false;
      return tree.querySelectorAll('[data-page-tree-item="true"]').length === 0;
    },
    undefined,
    { timeout: options.timeoutMs },
  );
  await page.getByRole('button', { name: 'Create first page' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertPrivateTreeRendered(page, seed) {
  await page.getByRole('tree', { name: 'Pages', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await treeRow(page, seed.rootPageId).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await treeRow(page, seed.siblingPageId).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
  await expectTreeRowHidden(page, seed.childPageId);
}

async function assertSharedShortcutTreeExpansion(page, seed) {
  const sharedTree = page.getByRole('tree', { name: 'Shared pages' });
  await sharedTree.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const row = sharedTree.locator(`[data-tree-page-id="${seed.sharedPageId}"]`);
  await row.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectScopedTreeRowAttribute(page, 'Shared pages', seed.sharedPageId, 'data-has-children', 'true');
  await expectScopedTreeRowAttribute(page, 'Shared pages', seed.sharedPageId, 'data-can-drag', null);
  const beforeChildCount = await sharedTree.locator(`[data-tree-page-id="${seed.sharedChildPageId}"]`).count();
  assert(beforeChildCount === 0, `shared shortcut child should stay hidden before expansion, got ${beforeChildCount}`);
  await row.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
  await expectScopedTreeRowAttribute(page, 'Shared pages', seed.sharedPageId, 'aria-expanded', 'true');
  await sharedTree.locator(`[data-tree-page-id="${seed.sharedChildPageId}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectScopedTreeRowAttribute(page, 'Shared pages', seed.sharedChildPageId, 'aria-level', '2');
  await expectTreeRowTitle(page, seed.sharedChildPageId, seed.sharedChildTitle);
}

async function assertDatabaseChildViewsManualExpansion(page, baseUrl, seed) {
  await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
  const root = privateTreeRow(page, seed.rootPageId);
  await root.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
  await expectTreeRowHidden(page, seed.childDatabaseId);
  await expectSidebarDatabaseViewRows(page, seed, []);

  await root.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'true');
  const dbRow = privateTreeRow(page, seed.childDatabaseId);
  await dbRow.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectPrivateTreeRowAttribute(page, seed.childDatabaseId, 'data-tree-page-kind', 'database');
  await expectPrivateTreeRowAttribute(page, seed.childDatabaseId, 'aria-expanded', null);
  await expectSidebarDatabaseViewRows(page, seed, []);
  await expectPrivateTreeDatabaseDisclosure(page, seed.childDatabaseId, false);

  await captureDatabaseChildViewsState(page, seed, 'database-internals-hidden');
  await setTheme(page, 'dark');
  await captureDatabaseChildViewsState(page, seed, 'database-internals-hidden-dark');
  await setTheme(page, 'light');

  await root.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
  await expectTreeRowHidden(page, seed.childDatabaseId);
}

async function captureDatabaseChildViewsState(page, seed, label) {
  const state = await page.evaluate(({ rootPageId, databaseId }) => {
    const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
    const rowData = (row) => {
      if (!(row instanceof HTMLElement)) return null;
      const rect = row.getBoundingClientRect();
      return {
        id: row.getAttribute('data-tree-page-id') ?? row.getAttribute('data-tree-db-view-id') ?? '',
        title:
          row.querySelector('[data-tree-title="true"]')?.textContent?.replace(/\s+/g, ' ').trim() ??
          row.textContent?.replace(/\s+/g, ' ').trim() ??
          '',
        kind: row.getAttribute('data-tree-page-kind') ?? row.getAttribute('data-tree-db-view-type') ?? '',
        level: row.getAttribute('aria-level') ?? '',
        expanded: row.getAttribute('aria-expanded') ?? '',
        current: row.getAttribute('aria-current') ?? '',
        visible: row.offsetParent !== null,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    };
    const root = tree?.querySelector(`[data-tree-page-id="${CSS.escape(rootPageId)}"]`);
    const database = tree?.querySelector(`[data-tree-page-id="${CSS.escape(databaseId)}"]`);
    const viewRows = Array.from(tree?.querySelectorAll('[data-tree-db-view-id]') ?? []).map(rowData);
    const emptyChildren = Array.from(tree?.querySelectorAll('[data-tree-empty-children="true"]') ?? [])
      .filter((row) => row instanceof HTMLElement && row.offsetParent !== null)
      .map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    return {
      root: rowData(root),
      database: rowData(database),
      viewRows,
      emptyChildren,
    };
  }, { rootPageId: seed.rootPageId, databaseId: seed.childDatabaseId });
  writeJsonArtifact(`desktop-database-child-views-${label}.json`, state);
  await page.screenshot({
    path: join(options.screenshotDir, `desktop-database-child-views-${label}.png`),
    fullPage: false,
  });
}

async function expectSidebarDatabaseViewRows(page, seed, expectedEntries) {
  await page.waitForFunction(
    ([databaseId, expected]) => {
      const expectedRows = Array.isArray(expected) ? expected : [];
      const rows = Array.from(document.querySelectorAll('[data-tree-db-view-id]'))
        .map((node) => ({
          id: node.getAttribute('data-tree-db-view-id'),
          text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          visible: node instanceof HTMLElement && node.offsetParent !== null,
        }))
        .filter((row) => row.visible);
      if (expectedRows.length === 0) return rows.length === 0;
      const byId = new Map(rows.map((row) => [row.id, row.text]));
      return expectedRows.every(([key, label]) => {
        const viewId = databaseId[key];
        const text = byId.get(viewId);
        return typeof viewId === 'string' && typeof text === 'string' && text.includes(label);
      });
    },
    [seed.childDatabaseViewIds, expectedEntries],
    { timeout: options.timeoutMs },
  );
}

async function expectPrivateTreeDatabaseDisclosure(page, databaseId, expectedVisible) {
  await page.waitForFunction(
    ([id, expected]) => {
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
      const disclosure = row?.querySelector('button[data-tree-disclosure="true"]');
      const visible = disclosure instanceof HTMLElement && disclosure.offsetParent !== null;
      return visible === expected;
    },
    [databaseId, expectedVisible],
    { timeout: options.timeoutMs },
  );
}

async function assertNoPersistentPrivateAddRow(page) {
  const metrics = await page.evaluate(() => {
    const privateSection = document.querySelector('#sidebar-private-section');
    const rootDropArea = privateSection?.parentElement;
    if (!(rootDropArea instanceof HTMLElement)) {
      return { ok: false, reason: 'missing private root drop area' };
    }
    const visibleAddRows = Array.from(rootDropArea.querySelectorAll('button'))
      .filter((button) => {
        if (!(button instanceof HTMLElement)) return false;
        const label = button.textContent?.replace(/\s+/g, ' ').trim();
        if (label !== 'Add a page') return false;
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity) > 0.2
        );
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
    return {
      ok: true,
      visibleAddRowCount: visibleAddRows.length,
      visibleAddRows,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'private add row contract failed');
  assert(
    metrics.visibleAddRowCount === 0,
    `populated private tree should not show a persistent Add a page row; use the hover header +, footer New page, or empty-state CTA instead: ${JSON.stringify(metrics)}`,
  );
}

async function assertPrivateSectionHeaderAffordanceLayout(page, seed) {
  await clearTreeHoverAndFocus(page);
  const idle = await privateSectionHeaderMetrics(page);
  assert(idle.actionsOpacity <= 0.2, `private section actions should be hidden at rest: ${JSON.stringify(idle)}`);
  assert(idle.chevronOpacity <= 0.2, `private section chevron should be quiet at rest: ${JSON.stringify(idle)}`);
  assert(idle.actionsPointerEvents === 'none', `private section actions should not intercept idle clicks: ${JSON.stringify(idle)}`);
  assert(
    idle.headerBackground === 'rgba(0, 0, 0, 0)',
    `private section header should not look selected or row-highlighted at rest: ${JSON.stringify(idle)}`,
  );

  await privateTreeRow(page, seed.rootPageId).hover({ timeout: options.timeoutMs });
  await page.waitForTimeout(120);
  const rowHover = await privateSectionHeaderMetrics(page);
  assert(
    rowHover.actionsOpacity <= 0.2 && rowHover.chevronOpacity <= 0.2,
    `private section controls should not appear just because a page row is hovered: ${JSON.stringify(rowHover)}`,
  );

  await hoverPrivateSectionHeader(page);
  const headerHover = await privateSectionHeaderMetrics(page);
  assert(headerHover.actionsOpacity >= 0.8, `private section action rail should appear on header hover: ${JSON.stringify(headerHover)}`);
  assert(headerHover.actionButtonCount === 3, `private section hover should expose library/more/add as one compact action rail: ${JSON.stringify(headerHover)}`);
  assert(headerHover.actionLabels.includes('Open pages library'), `private section hover should expose the library action before more/add: ${JSON.stringify(headerHover)}`);
  assert(
    headerHover.actionIconCount === 3,
    `private section hover actions should keep three compact SVG icons, got ${JSON.stringify({
      count: headerHover.actionIconCount,
    })}`,
  );
  assert(headerHover.libraryOpacity >= 0.8, `private section library button should appear on header hover: ${JSON.stringify(headerHover)}`);
  assert(headerHover.moreOpacity >= 0.8, `private section more button should appear on header hover: ${JSON.stringify(headerHover)}`);
  assert(headerHover.addOpacity >= 0.8, `private section add button should appear on header hover: ${JSON.stringify(headerHover)}`);
  assert(headerHover.chevronOpacity >= 0.8, `private section chevron should appear on header hover: ${JSON.stringify(headerHover)}`);
  assert(headerHover.actionsPointerEvents === 'auto', `private section actions should become interactive only on header hover/focus: ${JSON.stringify(headerHover)}`);
  assert(
    headerHover.titleLeft - headerHover.headerLeft >= 6 &&
      headerHover.titleLeft - headerHover.headerLeft <= 14 &&
      headerHover.chevronLeft >= headerHover.titleRight - 1,
    `private section caret should be an inline label affordance, not a separate leading column: ${JSON.stringify(headerHover)}`,
  );
  assert(headerHover.titleContrast >= 3, `private section label should stay readable on header hover: ${JSON.stringify(headerHover)}`);
  assert(headerHover.actionContrast >= 3, `private section action rail should be visible enough on header hover: ${JSON.stringify(headerHover)}`);
  assert(headerHover.headerHeight >= 27 && headerHover.headerHeight <= 31, `private section header row should match the compact Notion section row rhythm: ${JSON.stringify(headerHover)}`);
  assert(
    headerHover.titleFontSize >= 11.5 &&
      headerHover.titleFontSize <= 12.75 &&
      headerHover.firstRowTitleFontSize >= headerHover.titleFontSize + 1.25,
    `private section label should read as quiet 12px section chrome, not a page-row label: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.titleHeight < headerHover.firstRowTitleHeight &&
      headerHover.firstRowTitleHeight - headerHover.titleHeight <= 5,
    `private section label should be smaller than page rows without collapsing into a tiny caption: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.titleFontWeight >= 450 && headerHover.titleFontWeight <= headerHover.firstRowTitleFontWeight + 150,
    `private section label weight should look like Notion section chrome rather than an over-bold heading: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.headerBackground !== 'rgba(0, 0, 0, 0)',
    `private section hover should light the section header itself: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.headerBackgroundAlpha >= 0.03 && headerHover.headerBackgroundAlpha <= 0.07,
    `private section hover should stay quieter than selected/active page-row chrome: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.actionCenterSpread <= 1.5 &&
      Math.abs(headerHover.actionCenterY - headerHover.headerCenterY) <= 1.5,
    `private section actions should sit on the section-header rail, not drift into the page-row area: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.sectionToFirstRowGap >= 0 &&
      headerHover.sectionToFirstRowGap <= 7,
    `private section header should sit just above its first page row without a loose or collapsed gap: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.actionLeft > headerHover.chevronRight + 8 && headerHover.actionGapMin >= 18 && headerHover.actionGapMax <= 23,
    `private section right actions should stay grouped as compact 20px rail buttons: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.libraryWidth >= 18 && headerHover.libraryWidth <= 22 && headerHover.libraryHeight >= 18 && headerHover.libraryHeight <= 22,
    `private section library hit area should stay compact: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.libraryIconWidth >= 15 && headerHover.libraryIconWidth <= 17 &&
      headerHover.libraryIconHeight >= 15 && headerHover.libraryIconHeight <= 17,
    `private section library glyph should match the current Notion 16px section-action rhythm: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.addWidth >= 18 && headerHover.addWidth <= 22 && headerHover.addHeight >= 18 && headerHover.addHeight <= 22,
    `private section add hit area should stay compact: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.addIconWidth >= 15 && headerHover.addIconWidth <= 17 &&
      headerHover.addIconHeight >= 15 && headerHover.addIconHeight <= 17,
    `private section add glyph should match the current Notion 16px section-action rhythm: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.moreWidth >= 18 && headerHover.moreWidth <= 22 && headerHover.moreHeight >= 18 && headerHover.moreHeight <= 22,
    `private section more hit area should stay compact: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.moreIconWidth >= 15 && headerHover.moreIconWidth <= 17 &&
      headerHover.moreIconHeight >= 15 && headerHover.moreIconHeight <= 17,
    `private section more glyph should match the current Notion 16px section-action rhythm: ${JSON.stringify(headerHover)}`,
  );
  assert(
    headerHover.addRight <= headerHover.headerRight - 3 &&
      headerHover.addRight >= headerHover.headerRight - 14,
    `private section add action should sit near the right edge of the header row, like the Notion section rail: ${JSON.stringify(headerHover)}`,
  );
  await clearTreeHoverAndFocus(page);
}

async function hoverPrivateSectionHeader(page) {
  await page.locator('button[aria-controls="sidebar-private-section"]').hover({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => {
      const actions = document.querySelector('[data-section-actions="private"]');
      if (!(actions instanceof HTMLElement)) return false;
      return Number.parseFloat(getComputedStyle(actions).opacity) >= 0.8;
    },
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function privateSectionHeaderMetrics(page) {
  const metrics = await page.evaluate(() => {
    const toggle = document.querySelector('button[aria-controls="sidebar-private-section"]');
    const library = document.querySelector('button[aria-label="Open pages library"]');
    const add = document.querySelector('button[aria-label="Add a page"]');
    const more = document.querySelector('button[aria-label="Open page section options"]');
    const actions = document.querySelector('[data-section-actions="private"]');
    const header = toggle?.parentElement;
    const chevron = toggle?.querySelector('svg');
    const firstRowTitle = document.querySelector(
      '[role="tree"][aria-label="Pages"] [data-tree-title="true"]',
    );
    const firstRow = firstRowTitle?.closest('[data-page-tree-item="true"]');
    if (
      !(toggle instanceof HTMLElement) ||
      !(library instanceof HTMLElement) ||
      !(add instanceof HTMLElement) ||
      !(more instanceof HTMLElement) ||
      !(actions instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(chevron instanceof SVGElement) ||
      !(firstRowTitle instanceof HTMLElement) ||
      !(firstRow instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'missing private section header controls' };
    }
    const headerRect = header.getBoundingClientRect();
    const libraryRect = library.getBoundingClientRect();
    const addRect = add.getBoundingClientRect();
    const moreRect = more.getBoundingClientRect();
    const libraryIconRect = library.querySelector('svg')?.getBoundingClientRect();
    const addIconRect = add.querySelector('svg')?.getBoundingClientRect();
    const moreIconRect = more.querySelector('svg')?.getBoundingClientRect();
    const actionSvgs = [
      library.querySelector('svg'),
      more.querySelector('svg'),
      add.querySelector('svg'),
    ].filter((svg) => svg instanceof SVGElement);
    const toggleRect = toggle.getBoundingClientRect();
    const chevronRect = chevron.getBoundingClientRect();
    const firstRowRect = firstRow.getBoundingClientRect();
    const title = toggle.querySelector('span');
    const titleRect = title instanceof HTMLElement ? title.getBoundingClientRect() : toggleRect;
    const firstRowTitleRect = firstRowTitle.getBoundingClientRect();
    const actionButtons = Array.from(actions.querySelectorAll('button')).filter((button) => button instanceof HTMLElement);
    const actionRects = actionButtons.map((button) => button.getBoundingClientRect());
    const actionLefts = actionRects.map((rect) => rect.left);
    const actionCenters = actionRects.map((rect) => rect.top + rect.height / 2);
    const actionGaps = actionRects.slice(1).map((rect, index) => rect.left - actionRects[index].left);
    const actionLabels = actionButtons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');
    const libraryStyle = getComputedStyle(library);
    const addStyle = getComputedStyle(add);
    const moreStyle = getComputedStyle(more);
    const actionsStyle = getComputedStyle(actions);
    const chevronStyle = getComputedStyle(chevron);
    const titleStyle = title instanceof HTMLElement ? getComputedStyle(title) : getComputedStyle(toggle);
    const firstRowTitleStyle = getComputedStyle(firstRowTitle);
    const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
    const sidebarStyle = sidebar instanceof HTMLElement ? getComputedStyle(sidebar) : getComputedStyle(document.body);
    const headerBackground = getComputedStyle(header).backgroundColor;
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
    const contrastRatio = (a, b) => {
      const fg = parseColor(a);
      const bg = parseColor(b);
      if (!fg || !bg) return 0;
      const aLum = luminance(blend(fg, bg));
      const bLum = luminance(bg);
      const lighter = Math.max(aLum, bLum);
      const darker = Math.min(aLum, bLum);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const contrastAgainstSidebar = (color) => contrastRatio(color, sidebarStyle.backgroundColor);
    const actionsOpacity = Number.parseFloat(actionsStyle.opacity);
    return {
      ok: true,
      headerHeight: headerRect.height,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      headerCenterY: headerRect.top + headerRect.height / 2,
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      toggleLeft: toggleRect.left,
      titleLeft: titleRect.left,
      titleRight: titleRect.right,
      titleHeight: titleRect.height,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      titleFontWeight: Number.parseFloat(titleStyle.fontWeight),
      firstRowTitleHeight: firstRowTitleRect.height,
      firstRowTitleFontSize: Number.parseFloat(firstRowTitleStyle.fontSize),
      firstRowTitleFontWeight: Number.parseFloat(firstRowTitleStyle.fontWeight),
      firstRowTop: firstRowRect.top,
      sectionToFirstRowGap: firstRowRect.top - headerRect.bottom,
      chevronLeft: chevronRect.left,
      chevronRight: chevronRect.right,
      actionLeft: Math.min(...actionLefts),
      actionGapMin: Math.min(...actionGaps),
      actionGapMax: Math.max(...actionGaps),
      actionCenterY: actionCenters.length
        ? actionCenters.reduce((total, value) => total + value, 0) / actionCenters.length
        : null,
      actionCenterSpread: actionCenters.length
        ? Math.max(...actionCenters) - Math.min(...actionCenters)
        : null,
      actionLabels,
      actionIconCount: actionSvgs.length,
      actionHanjiIconCount: actionSvgs.filter((svg) => svg.getAttribute('data-hanji-icon') === 'true').length,
      actionIconSources: Array.from(
        new Set(actionSvgs.map((svg) => svg.getAttribute('data-hanji-icon-source') ?? 'unknown')),
      ),
      actionIconWeights: Array.from(
        new Set(actionSvgs.map((svg) => svg.getAttribute('data-hanji-icon-weight') ?? 'unknown')),
      ).sort(),
      addRight: addRect.right,
      libraryWidth: libraryRect.width,
      libraryHeight: libraryRect.height,
      libraryIconWidth: libraryIconRect?.width ?? null,
      libraryIconHeight: libraryIconRect?.height ?? null,
      libraryOpacity: Math.min(Number.parseFloat(libraryStyle.opacity), actionsOpacity),
      addWidth: addRect.width,
      addHeight: addRect.height,
      addIconWidth: addIconRect?.width ?? null,
      addIconHeight: addIconRect?.height ?? null,
      addOpacity: Math.min(Number.parseFloat(addStyle.opacity), actionsOpacity),
      moreWidth: moreRect.width,
      moreHeight: moreRect.height,
      moreIconWidth: moreIconRect?.width ?? null,
      moreIconHeight: moreIconRect?.height ?? null,
      moreOpacity: Math.min(Number.parseFloat(moreStyle.opacity), actionsOpacity),
      actionsOpacity,
      actionButtonCount: actions.querySelectorAll('button').length,
      actionsPointerEvents: actionsStyle.pointerEvents,
      chevronOpacity: Number.parseFloat(chevronStyle.opacity),
      headerBackground,
      headerBackgroundAlpha: parseColor(headerBackground)?.a ?? 1,
      titleColor: titleStyle.color,
      titleContrast: contrastAgainstSidebar(titleStyle.color),
      actionColor: addStyle.color,
      actionContrast: Math.min(contrastAgainstSidebar(addStyle.color), contrastAgainstSidebar(moreStyle.color)),
    };
  });
  assert(metrics.ok, metrics.reason ?? 'private section header metrics failed');
  return metrics;
}

async function assertSecondarySectionHeaderAffordanceLayout(page, seed) {
  await clearTreeHoverAndFocus(page);
  for (const section of ['favorites', 'shared']) {
    const idle = await secondarySectionHeaderMetrics(page, section);
    assert(idle.buttonCount === 1, `${section} section header should not grow persistent right-side actions: ${JSON.stringify(idle)}`);
    assert(idle.inlineSvgCount === 1, `${section} section header should only keep the hover/focus inline caret, not a persistent page-like icon: ${JSON.stringify(idle)}`);
    assert(idle.chevronOpacity <= 0.2, `${section} section chevron should stay quiet at rest: ${JSON.stringify(idle)}`);
    assert(idle.headerHeight >= 28 && idle.headerHeight <= 31, `${section} section header should stay on the current Notion-style 30px row rhythm at rest: ${JSON.stringify(idle)}`);
    assert(
      idle.titleFontSize >= 11.5 && idle.titleFontSize <= 12.75,
      `${section} section title should use quiet 12px section chrome rather than page-row scale: ${JSON.stringify(idle)}`,
    );
    assert(
      idle.titleLeft - idle.headerLeft >= 6 && idle.titleLeft - idle.headerLeft <= 14,
      `${section} section title should anchor the header left edge without a page-like leading icon column: ${JSON.stringify(idle)}`,
    );

    await privateTreeRow(page, seed.rootPageId).hover({ timeout: options.timeoutMs });
    await page.waitForTimeout(120);
    const rowHover = await secondarySectionHeaderMetrics(page, section);
    assert(
      rowHover.chevronOpacity <= 0.2,
      `${section} section controls should not appear just because a page row is hovered: ${JSON.stringify(rowHover)}`,
    );

    await hoverSecondarySectionHeader(page, section);
    const headerHover = await secondarySectionHeaderMetrics(page, section);
    assert(headerHover.chevronOpacity >= 0.8, `${section} section chevron should appear on header hover: ${JSON.stringify(headerHover)}`);
    assert(headerHover.inlineSvgCount === 1, `${section} section hover should not add a persistent section icon: ${JSON.stringify(headerHover)}`);
    assert(headerHover.headerBackground !== 'rgba(0, 0, 0, 0)', `${section} section hover should have a quiet hover background: ${JSON.stringify(headerHover)}`);
    assert(
      headerHover.headerBackgroundAlpha >= 0.03 && headerHover.headerBackgroundAlpha <= 0.07,
      `${section} section hover should stay quieter than selected/active page-row chrome: ${JSON.stringify(headerHover)}`,
    );
    assert(headerHover.titleContrast >= 3, `${section} section label should stay readable on header hover: ${JSON.stringify(headerHover)}`);
    assert(
      headerHover.chevronLeft >= headerHover.titleRight - 1,
      `${section} section caret should be inline after the label rather than a leading page-row affordance: ${JSON.stringify(headerHover)}`,
    );
    assert(
      headerHover.toggleLeft - headerHover.headerLeft >= -1 &&
        headerHover.toggleRight <= headerHover.headerRight + 1,
      `${section} section toggle should stay inside the compact header row: ${JSON.stringify(headerHover)}`,
    );
    await clearTreeHoverAndFocus(page);
  }
}

async function hoverSecondarySectionHeader(page, section) {
  await page.locator(`button[aria-controls="sidebar-${section}-section"]`).hover({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (sectionName) => {
      const toggle = document.querySelector(`button[aria-controls="sidebar-${sectionName}-section"]`);
      const chevron = toggle?.querySelector('svg');
      if (!(chevron instanceof SVGElement)) return false;
      return Number.parseFloat(getComputedStyle(chevron).opacity) >= 0.8;
    },
    section,
    { timeout: options.timeoutMs },
  );
}

async function secondarySectionHeaderMetrics(page, section) {
  const metrics = await page.evaluate((sectionName) => {
    const toggle = document.querySelector(`button[aria-controls="sidebar-${sectionName}-section"]`);
    const header = toggle?.parentElement;
    const chevron = toggle?.querySelector('svg');
    const icons = Array.from(toggle?.querySelectorAll('svg') ?? []);
    const title = toggle?.querySelector('span');
    const sectionRoot = toggle?.closest('section');
    if (
      !(toggle instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(chevron instanceof SVGElement) ||
      !(title instanceof HTMLElement) ||
      !(sectionRoot instanceof HTMLElement)
    ) {
      return { ok: false, reason: `missing ${sectionName} section header controls` };
    }
    const headerRect = header.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const chevronRect = chevron.getBoundingClientRect();
    const chevronStyle = getComputedStyle(chevron);
    const titleStyle = getComputedStyle(title);
    const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
    const sidebarStyle = sidebar instanceof HTMLElement ? getComputedStyle(sidebar) : getComputedStyle(document.body);
    const headerBackground = getComputedStyle(header).backgroundColor;
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
    const contrastRatio = (a, b) => {
      const fg = parseColor(a);
      const bg = parseColor(b);
      if (!fg || !bg) return 0;
      const aLum = luminance(blend(fg, bg));
      const bLum = luminance(bg);
      const lighter = Math.max(aLum, bLum);
      const darker = Math.min(aLum, bLum);
      return (lighter + 0.05) / (darker + 0.05);
    };
    return {
      ok: true,
      section: sectionName,
      buttonCount: header.querySelectorAll('button').length,
      headerHeight: headerRect.height,
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      toggleLeft: toggleRect.left,
      toggleRight: toggleRect.right,
      titleLeft: titleRect.left,
      titleRight: titleRect.right,
      chevronLeft: chevronRect.left,
      chevronRight: chevronRect.right,
      chevronOpacity: Number.parseFloat(chevronStyle.opacity),
      inlineSvgCount: icons.length,
      headerBackground,
      headerBackgroundAlpha: parseColor(headerBackground)?.a ?? 1,
      titleColor: titleStyle.color,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      titleContrast: contrastRatio(titleStyle.color, sidebarStyle.backgroundColor),
    };
  }, section);
  assert(metrics.ok, metrics.reason ?? `${section} section header metrics failed`);
  return metrics;
}

async function assertSidebarTopActionLayout(page) {
  const metrics = await page.evaluate(() => {
    const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
    const actions = sidebar?.querySelector('[data-sidebar-top-actions]');
    const home = actions?.querySelector('[data-sidebar-home-action]');
    const homeLabel = home?.querySelector('span');
    const iconActions = Array.from(actions?.querySelectorAll('[data-sidebar-icon-action]') ?? []);
    if (
      !(sidebar instanceof HTMLElement) ||
      !(actions instanceof HTMLElement) ||
      !(home instanceof HTMLElement) ||
      !(homeLabel instanceof HTMLElement) ||
      iconActions.some((item) => !(item instanceof HTMLElement))
    ) {
      return { ok: false, reason: 'missing sidebar top action rail markers' };
    }
    const railRect = actions.getBoundingClientRect();
    const homeRect = home.getBoundingClientRect();
    const homeStyle = getComputedStyle(home);
    const homeSvgRect = home.querySelector('svg')?.getBoundingClientRect();
    const iconRects = iconActions.map((item) => item.getBoundingClientRect());
    const iconStyles = iconActions.map((item) => getComputedStyle(item));
    const iconSvgRects = iconActions.map((item) => item.querySelector('svg')?.getBoundingClientRect()).filter(Boolean);
    const topRailSvgs = [
      home.querySelector('svg'),
      ...iconActions.map((item) => item.querySelector('svg')),
    ].filter((svg) => svg instanceof SVGElement);
    const iconWidths = iconRects.map((rect) => rect.width);
    const iconHeights = iconRects.map((rect) => rect.height);
    const iconTops = iconRects.map((rect) => rect.top);
    const contiguousIconGaps = iconRects.slice(1, 3).map((rect, index) => rect.left - iconRects[index].left);
    const searchRect = iconRects[iconRects.length - 1];
    const previousIconRect = iconRects[iconRects.length - 2];
    const allTops = [homeRect.top, ...iconTops];
    const allCenters = [homeRect.top + homeRect.height / 2, ...iconRects.map((rect) => rect.top + rect.height / 2)];
    return {
      ok: true,
      railText: actions.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      railSlots: [
        home.getAttribute('data-sidebar-rail-slot'),
        ...iconActions.map((item) => item.getAttribute('data-sidebar-rail-slot')),
      ],
      iconActionLabels: iconActions.map((item) => item.getAttribute('aria-label') ?? ''),
      topRailIconCount: topRailSvgs.length,
      topRailHanjiIconCount: topRailSvgs.filter((svg) => svg.getAttribute('data-hanji-icon') === 'true').length,
      topRailIconSources: Array.from(
        new Set(topRailSvgs.map((svg) => svg.getAttribute('data-hanji-icon-source') ?? 'unknown')),
      ),
      topRailIconWeights: Array.from(
        new Set(topRailSvgs.map((svg) => svg.getAttribute('data-hanji-icon-weight') ?? 'unknown')),
      ),
      railWidth: railRect.width,
      railHeight: railRect.height,
      homeText: homeLabel.textContent?.trim() ?? '',
      homeActive: home.getAttribute('data-active'),
      homeFits: homeLabel.scrollWidth <= homeLabel.clientWidth + 1,
      homeWidth: homeRect.width,
      homeHeight: homeRect.height,
      homeRadius: Number.parseFloat(homeStyle.borderTopLeftRadius),
      homeIconWidth: homeSvgRect?.width ?? 0,
      homeIconHeight: homeSvgRect?.height ?? 0,
      iconCount: iconRects.length,
      iconMinWidth: Math.min(...iconWidths),
      iconMaxWidth: Math.max(...iconWidths),
      iconMinHeight: Math.min(...iconHeights),
      iconMaxHeight: Math.max(...iconHeights),
      iconMinRadius: Math.min(...iconStyles.map((style) => Number.parseFloat(style.borderTopLeftRadius))),
      iconSvgMinWidth: Math.min(...iconSvgRects.map((rect) => rect.width)),
      iconSvgMaxWidth: Math.max(...iconSvgRects.map((rect) => rect.width)),
      contiguousIconGapMin: Math.min(...contiguousIconGaps),
      contiguousIconGapMax: Math.max(...contiguousIconGaps),
      searchSpacer: searchRect && previousIconRect ? searchRect.left - previousIconRect.right : null,
      searchRightInset: searchRect ? railRect.right - searchRect.right : null,
      topSpread: Math.max(...allTops) - Math.min(...allTops),
      centerSpread: Math.max(...allCenters) - Math.min(...allCenters),
    };
  });

  assert(metrics.ok, metrics.reason ?? 'sidebar action layout contract could not run');
  assert(
    metrics.railHeight >= 42 && metrics.railHeight <= 48,
    `sidebar top actions should stay close to the live Notion 32px tab rail rhythm, got ${Math.round(metrics.railHeight)}px`,
  );
  assert(
    metrics.homeText === 'Home' && metrics.homeFits === true,
    `sidebar Home label should fit without ellipsis, got text=${JSON.stringify(metrics.homeText)} fits=${metrics.homeFits}`,
  );
  assert(
    metrics.homeActive === 'true',
    `sidebar Home should stay as the active top-rail pill on document pages, got ${metrics.homeActive}`,
  );
  assert(
    metrics.homeWidth >= 72 && /* >=72: Linux CI fonts render the label ~1-3px narrower than macOS */
      metrics.homeWidth <= 108 &&
      metrics.homeHeight >= 31 &&
      metrics.homeHeight <= 34 &&
      metrics.homeRadius >= 15 &&
      metrics.homeIconWidth >= 18.5 &&
      metrics.homeIconWidth <= 19.5 &&
      metrics.homeIconHeight >= 18.5 &&
      metrics.homeIconHeight <= 19.5,
    `sidebar Home pill should stay compact, rounded, and Notion-reference scaled, got ${JSON.stringify({
      width: Math.round(metrics.homeWidth),
      height: Math.round(metrics.homeHeight),
      radius: Math.round(metrics.homeRadius),
      iconWidth: Math.round(metrics.homeIconWidth),
      iconHeight: Math.round(metrics.homeIconHeight),
    })}`,
  );
  assert(
    metrics.topRailIconCount === 3,
    `sidebar top rail should keep Home, inbox, and search SVG icons after chat/meeting removal, got ${JSON.stringify({
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
    metrics.iconCount === 2 &&
      metrics.iconMinWidth >= 31 &&
      metrics.iconMaxWidth <= 34 &&
      metrics.iconMinHeight >= 31 &&
      metrics.iconMaxHeight <= 34 &&
      metrics.iconMinRadius >= 15 &&
      metrics.iconSvgMinWidth >= 18.5 &&
      metrics.iconSvgMaxWidth <= 19.5,
    `sidebar top icon buttons should be uniform, compact, and Notion-reference scaled, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.searchSpacer >= 4 &&
      metrics.searchRightInset >= 6 &&
      metrics.searchRightInset <= 10,
    `sidebar top rail should keep a compact inbox action and a right-aligned search action, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topSpread <= 1 && metrics.centerSpread <= 1,
    `sidebar top rail buttons should share one row, got topSpread=${metrics.topSpread} centerSpread=${metrics.centerSpread}`,
  );
  assert(
    !/Quick Find|Settings|Account console|Workspace console|Server console|Templates/.test(metrics.railText),
    `sidebar top rail should not fall back to tall text action rows, got text=${JSON.stringify(metrics.railText)}`,
  );
  assert(
    JSON.stringify(metrics.railSlots) === JSON.stringify(['home', 'inbox', 'search']),
    `sidebar top rail should stay as Home, inbox, search slots after chat/meeting removal, got ${JSON.stringify(metrics.railSlots)}`,
  );
  assert(
    metrics.iconActionLabels.every((label) => !/Chat|Comment|Meeting|Update|Settings|Templates|Import|Trash/.test(label)),
    `sidebar top rail should not mix chat/meeting or management/template actions into the navigation rail, got ${JSON.stringify(metrics.iconActionLabels)}`,
  );
}

async function assertSidebarWorkspaceHeaderLayout(page) {
  const readMetrics = () =>
    page.evaluate(() => {
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      const header = sidebar?.querySelector('[class*="header"]');
      const button = sidebar?.querySelector('[data-sidebar-workspace-button]');
      const name = button?.querySelector('[class*="wsName"]');
      const chevron = button?.querySelector('[data-sidebar-workspace-chevron]');
      const collapse = sidebar?.querySelector('[data-sidebar-collapse-action]');
      if (
        !(sidebar instanceof HTMLElement) ||
        !(header instanceof HTMLElement) ||
        !(button instanceof HTMLElement) ||
        !(name instanceof HTMLElement) ||
        !(chevron instanceof SVGElement) ||
        !(collapse instanceof HTMLElement)
      ) {
        return { ok: false, reason: 'missing sidebar workspace header markers' };
      }

      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          top: box.top,
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const headerRect = rect(header);
      const buttonRect = rect(button);
      const nameRect = rect(name);
      const chevronRect = rect(chevron);
      const collapseRect = rect(collapse);
      const chevronStyle = getComputedStyle(chevron);
      const collapseStyle = getComputedStyle(collapse);

      return {
        ok: true,
        headerRect,
        buttonRect,
        nameRect,
        chevronRect,
        collapseRect,
        nameText: name.textContent?.trim() ?? '',
        nameFits: name.scrollWidth <= name.clientWidth + 1,
        chevronOpacity: Number.parseFloat(chevronStyle.opacity || '1'),
        collapseOpacity: Number.parseFloat(collapseStyle.opacity || '1'),
        collapsePointerEvents: collapseStyle.pointerEvents,
        headerCenterY: headerRect.top + headerRect.height / 2,
        buttonCenterY: buttonRect.top + buttonRect.height / 2,
        chevronCenterY: chevronRect.top + chevronRect.height / 2,
        collapseCenterY: collapseRect.top + collapseRect.height / 2,
      };
    });

  await page.mouse.move(1000, 700);
  await page.waitForTimeout(120);
  const idle = await readMetrics();
  assert(idle.ok, idle.reason ?? 'sidebar workspace header idle contract could not run');
  assert(
    idle.headerRect.height >= 42 &&
      idle.headerRect.height <= 48 &&
      idle.buttonRect.height >= 30 &&
      idle.buttonRect.height <= 34,
    `sidebar workspace header should stay compact, got header=${Math.round(idle.headerRect.height)} button=${Math.round(idle.buttonRect.height)}`,
  );
  assert(
    idle.nameText.length > 0 && idle.nameFits === true,
    `sidebar workspace name should fit without ellipsis in the header contract, got ${JSON.stringify(idle)}`,
  );
  assert(
    idle.chevronOpacity <= 0.2,
    `sidebar workspace dropdown chevron should stay quiet at rest like the Notion reference, got opacity=${idle.chevronOpacity}`,
  );
  assert(
    idle.collapseOpacity <= 0.2 && idle.collapsePointerEvents === 'none',
    `sidebar collapse control should stay quiet at rest, got opacity=${idle.collapseOpacity} pointer=${idle.collapsePointerEvents}`,
  );

  await page.locator('[data-sidebar-workspace-button]').hover();
  await page.waitForTimeout(120);
  const hover = await readMetrics();
  assert(hover.ok, hover.reason ?? 'sidebar workspace header hover contract could not run');
  assert(
    hover.chevronOpacity >= 0.85,
    `sidebar workspace dropdown chevron should reveal on workspace header hover, got opacity=${hover.chevronOpacity}`,
  );
  assert(
    hover.collapseOpacity >= 0.85 && hover.collapsePointerEvents !== 'none',
    `sidebar collapse control should reveal on workspace header hover, got opacity=${hover.collapseOpacity} pointer=${hover.collapsePointerEvents}`,
  );
  assert(
    Math.abs(hover.buttonCenterY - hover.chevronCenterY) <= 1.5 &&
      Math.abs(hover.buttonCenterY - hover.collapseCenterY) <= 2,
    `sidebar workspace header hover controls should stay vertically centered, got ${JSON.stringify(hover)}`,
  );

  await page.mouse.move(1000, 700);
}

async function assertNoSidebarMemberCard(page) {
  const metrics = await page.evaluate(() => {
    const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
    return {
      sidebarPresent: sidebar instanceof HTMLElement,
      collaborationAreaPresent: Boolean(sidebar?.querySelector('[data-sidebar-collaboration]')),
      memberCardPresent: Boolean(sidebar?.querySelector('[data-sidebar-member-invite]')),
    };
  });
  assert(metrics.sidebarPresent, `sidebar should be present for the member-card contract: ${JSON.stringify(metrics)}`);
  assert(
    !metrics.collaborationAreaPresent && !metrics.memberCardPresent,
    `workspace membership belongs in the workspace console, not a persistent sidebar card: ${JSON.stringify(metrics)}`,
  );
}

async function assertSidebarFooterActionLayout(page) {
  const metrics = await page.evaluate(() => {
    const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
    const footer = sidebar?.querySelector('[data-sidebar-footer]');
    const newPage = footer?.querySelector('[data-sidebar-footer-new-page]');
    const footerActions = Array.from(footer?.querySelectorAll('[data-sidebar-footer-action]') ?? []);
    const rect = (el) => {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const parseColor = (value) => {
      const text = String(value).trim();
      const legacy = text.match(/rgba?\(([^)]+)\)/) ?? text.match(/rgb\(([^)]+)\)/);
      if (legacy) {
        const body = legacy[1].trim();
        const parts = body.includes(',')
          ? body.split(',').map((part) => part.trim())
          : body.replace(/\s*\/\s*/, ' ').split(/\s+/);
        const [r, g, b, a = 1] = parts.map((part) => Number.parseFloat(part));
        if (![r, g, b, a].every(Number.isFinite)) return null;
        return { r, g, b, a };
      }
      const srgb = text.match(/color\(srgb\s+([^)]+)\)/);
      if (!srgb) return null;
      const parts = srgb[1].replace(/\s*\/\s*/, ' ').split(/\s+/);
      const [rRaw, gRaw, bRaw, a = 1] = parts.map((part) => Number.parseFloat(part));
      const [r, g, b] = [rRaw, gRaw, bRaw].map((part) => (part <= 1 ? part * 255 : part));
      if (![r, g, b, a].every(Number.isFinite)) return null;
      return { r, g, b, a };
    };
    const blend = (fg, bg) => {
      if (!fg || !bg) return null;
      const a = fg.a ?? 1;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1,
      };
    };
    const luminance = (color) => {
      if (!color) return null;
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const contrastRatio = (fgColor, bgColor) => {
      const fg = blend(parseColor(fgColor), parseColor(bgColor));
      const bg = parseColor(bgColor);
      const fgL = luminance(fg);
      const bgL = luminance(bg);
      if (fgL == null || bgL == null) return 0;
      const lighter = Math.max(fgL, bgL);
      const darker = Math.min(fgL, bgL);
      return (lighter + 0.05) / (darker + 0.05);
    };

    if (
      !(sidebar instanceof HTMLElement) ||
      !(footer instanceof HTMLElement) ||
      !(newPage instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'missing sidebar footer markers' };
    }

    const newRect = rect(newPage);
    const iconRect = rect(newPage.querySelector('svg'));
    const label = newPage.querySelector('span');
    const labelRect = rect(label);
    const shortcut = newPage.querySelector('kbd');
    const shortcutRect = rect(shortcut);
    const newStyle = getComputedStyle(newPage);
    const labelStyle = label instanceof HTMLElement ? getComputedStyle(label) : null;
    const sidebarStyle = getComputedStyle(sidebar);
    const newIconStyle = newPage.querySelector('svg') instanceof SVGElement
      ? getComputedStyle(newPage.querySelector('svg'))
      : null;
    const actionRows = footerActions.map((action) => {
      const actionRect = rect(action);
      const actionIcon = action.querySelector('svg');
      const actionIconRect = rect(actionIcon);
      const actionIconStyle = actionIcon instanceof SVGElement ? getComputedStyle(actionIcon) : null;
      const actionLabel = action.querySelector('span');
      const actionLabelRect = rect(actionLabel);
      const actionLabelStyle = actionLabel instanceof HTMLElement ? getComputedStyle(actionLabel) : null;
      return {
        width: actionRect?.width ?? null,
        height: actionRect?.height ?? null,
        iconColor: actionIconStyle?.color ?? null,
        iconLeft: actionIconRect?.left ?? null,
        iconRight: actionIconRect?.right ?? null,
        iconContrast: actionIconStyle ? contrastRatio(actionIconStyle.color, sidebarStyle.backgroundColor) : 0,
        labelColor: actionLabelStyle?.color ?? null,
        labelLeft: actionLabelRect?.left ?? null,
        labelText: actionLabel?.textContent?.trim() ?? '',
        labelContrast: actionLabelStyle ? contrastRatio(actionLabelStyle.color, sidebarStyle.backgroundColor) : 0,
      };
    });

    return {
      ok: true,
      footerWidth: footer.getBoundingClientRect().width,
      actionRowCount: footerActions.length,
      actionRows,
      newText: label?.textContent?.trim() ?? '',
      newTextAlign: newStyle.textAlign,
      labelTextAlign: labelStyle?.textAlign ?? null,
      newHeight: newRect?.height ?? null,
      newLeft: newRect?.left ?? null,
      newRight: newRect?.right ?? null,
      iconLeft: iconRect?.left ?? null,
      iconRight: iconRect?.right ?? null,
      iconWidth: iconRect?.width ?? null,
      iconColor: newIconStyle?.color ?? null,
      iconContrast: newIconStyle ? contrastRatio(newIconStyle.color, sidebarStyle.backgroundColor) : 0,
      labelColor: labelStyle?.color ?? null,
      labelLeft: labelRect?.left ?? null,
      labelRight: labelRect?.right ?? null,
      labelContrast: labelStyle ? contrastRatio(labelStyle.color, sidebarStyle.backgroundColor) : 0,
      sidebarBackground: sidebarStyle.backgroundColor,
      shortcutLeft: shortcutRect?.left ?? null,
      shortcutOpacity: shortcut instanceof HTMLElement ? Number.parseFloat(getComputedStyle(shortcut).opacity) : null,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'sidebar footer layout contract could not run');
  assert(metrics.actionRowCount >= 3, `sidebar footer should keep utility rows above New page: ${JSON.stringify(metrics)}`);
  assert(metrics.newText === 'New page', `sidebar footer New page label drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.newTextAlign === 'left' && metrics.labelTextAlign === 'left', `sidebar footer New page should be left-aligned, got ${JSON.stringify(metrics)}`);
  assert(metrics.newHeight >= 28 && metrics.newHeight <= 32, `sidebar footer New page should stay compact, got ${JSON.stringify(metrics)}`);
  assert(metrics.iconWidth >= 15 && metrics.iconWidth <= 18, `sidebar footer New page icon size drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.iconLeft - metrics.newLeft >= 7 && metrics.iconLeft - metrics.newLeft <= 9, `sidebar footer New page icon should sit in the left gutter: ${JSON.stringify(metrics)}`);
  assert(metrics.labelLeft - metrics.iconRight >= 6 && metrics.labelLeft - metrics.iconRight <= 10, `sidebar footer New page label should follow the plus icon instead of floating centered: ${JSON.stringify(metrics)}`);
  assert(metrics.labelLeft - metrics.newLeft <= 36, `sidebar footer New page label should read as a left-aligned row, got ${JSON.stringify(metrics)}`);
  assert(metrics.labelContrast >= 3.5, `sidebar footer New page label should be readable utility text: ${JSON.stringify(metrics)}`);
  assert(metrics.iconContrast >= 2.75, `sidebar footer New page icon should not look disabled: ${JSON.stringify(metrics)}`);
  assert(metrics.shortcutLeft === null || metrics.shortcutLeft > metrics.labelRight + 8, `sidebar footer shortcut should stay secondary on the right: ${JSON.stringify(metrics)}`);

  for (const row of metrics.actionRows) {
    assert(row.height >= 26 && row.height <= 30, `sidebar footer utility row should stay compact: ${JSON.stringify(row)}`);
    assert(row.labelLeft - row.iconRight >= 6 && row.labelLeft - row.iconRight <= 10, `sidebar footer utility labels should align after icons: ${JSON.stringify(row)}`);
    assert(row.labelContrast >= 3.5, `sidebar footer utility label should be readable, not washed out: ${JSON.stringify(row)}`);
    assert(row.iconContrast >= 2.75, `sidebar footer utility icon should not look disabled: ${JSON.stringify(row)}`);
  }
}

async function assertCollapsedTreeDisclosureLayout(page, seed) {
  await clearTreeHoverAndFocus(page);
  const before = await treeDisclosureOpacity(page, seed.rootPageId);
  const iconBefore = await treeIconOpacity(page, seed.rootPageId);
  assert(
    before <= 0.2,
    `collapsed page-tree caret should stay hidden until hover/focus, got opacity ${before}`,
  );
  assert(
    iconBefore >= 0.8,
    `collapsed page-tree icon should occupy the leading slot at rest, got opacity ${iconBefore}`,
  );
  await privateTreeRow(page, seed.rootPageId).hover({ timeout: options.timeoutMs });
  const afterHover = await waitForTreeDisclosureOpacity(page, seed.rootPageId, 0.8);
  const iconAfterHover = await waitForTreeIconOpacity(page, seed.rootPageId, 0.2, 'below');
  assert(afterHover >= 0.8, `page-tree caret should appear on row hover, got opacity ${afterHover}`);
  assert(iconAfterHover <= 0.2, `page-tree icon should yield to the caret on row hover, got opacity ${iconAfterHover}`);
  await clearTreeHoverAndFocus(page);
}

async function assertExpandedTreeDisclosureLayout(page, seed) {
  await ensurePrivateTreeExpanded(page, seed.rootPageId);
  await privateTreeRow(page, seed.childPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await clearTreeHoverAndFocus(page);

  const idleDisclosure = await treeDisclosureOpacity(page, seed.rootPageId);
  const idleActions = await treeActionsOpacity(page, seed.rootPageId);
  const idleIcon = await treeIconOpacity(page, seed.rootPageId);
  assert(
    idleDisclosure <= 0.2,
    `expanded desktop page-tree caret should stay visually quiet until hover/focus, got opacity ${idleDisclosure}`,
  );
  assert(
    idleActions <= 0.2,
    `expanded desktop page-tree actions should stay hidden until hover/focus, got opacity ${idleActions}`,
  );
  assert(
    idleIcon >= 0.8,
    `expanded desktop page-tree icon should stay visible at rest, got opacity ${idleIcon}`,
  );

  await privateTreeRow(page, seed.rootPageId).hover({ timeout: options.timeoutMs });
  const hoverDisclosure = await waitForTreeDisclosureOpacity(page, seed.rootPageId, 0.8);
  const hoverActions = await waitForTreeActionsOpacity(page, seed.rootPageId, 0.8);
  const hoverIcon = await waitForTreeIconOpacity(page, seed.rootPageId, 0.2, 'below');
  assert(hoverDisclosure >= 0.8, `expanded page-tree caret should appear on row hover, got opacity ${hoverDisclosure}`);
  assert(hoverActions >= 0.8, `expanded page-tree actions should appear on row hover, got opacity ${hoverActions}`);
  assert(hoverIcon <= 0.2, `expanded page-tree icon should yield to caret on row hover, got opacity ${hoverIcon}`);
  await clearTreeHoverAndFocus(page);
}

async function assertPageTreeRowLayout(page, seed) {
  await privateTreeRow(page, seed.childPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  const metrics = await page.evaluate(
    ({ rootPageId, childPageId, rootTitle, childTitle }) => {
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const readRow = (id, title) => {
        const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
        if (!(row instanceof HTMLElement)) return { ok: false, reason: `missing row ${id}` };
        const titleEl = Array.from(row.children).find(
          (child) => child instanceof HTMLElement && child.textContent?.trim() === title,
        );
        if (!(titleEl instanceof HTMLElement)) return { ok: false, reason: `missing title ${title}` };
        const leading = row.querySelector('[data-tree-leading="true"]');
        const disclosure = row.querySelector('[data-tree-disclosure="true"]');
        const icon = row.querySelector('[data-tree-icon="true"]');
        const actions = row.querySelector('button[aria-label^="Open page actions"]')?.parentElement;
        const rowRect = row.getBoundingClientRect();
        const titleRect = titleEl.getBoundingClientRect();
        const leadingRect = leading instanceof HTMLElement ? leading.getBoundingClientRect() : null;
        const disclosureRect = disclosure?.getBoundingClientRect();
        const iconRect = icon instanceof HTMLElement ? icon.getBoundingClientRect() : null;
        const actionsRect = actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
        const titleStyle = getComputedStyle(titleEl);
        const actionsStyle = actions instanceof HTMLElement ? getComputedStyle(actions) : null;
        return {
          ok: true,
          id,
          title,
          rowHeight: rowRect.height,
          rowLeft: rowRect.left,
          rowRight: rowRect.right,
          leadingLeft: leadingRect?.left ?? null,
          leadingRight: leadingRect?.right ?? null,
          leadingWidth: leadingRect?.width ?? null,
          leadingHeight: leadingRect?.height ?? null,
          titleLeft: titleRect.left,
          titleRight: titleRect.right,
          titleClientWidth: titleEl.clientWidth,
          titleScrollWidth: titleEl.scrollWidth,
          titlePaddingRight: Number.parseFloat(titleStyle.paddingRight || '0'),
          disclosureLeft: disclosureRect?.left ?? null,
          disclosureWidth: disclosureRect?.width ?? null,
          disclosureHeight: disclosureRect?.height ?? null,
          disclosureOpacity:
            disclosure instanceof HTMLElement
              ? Number.parseFloat(getComputedStyle(disclosure).opacity)
              : null,
          iconLeft: iconRect?.left ?? null,
          iconWidth: iconRect?.width ?? null,
          iconHeight: iconRect?.height ?? null,
          iconRight: iconRect?.right ?? null,
          iconOpacity: icon instanceof HTMLElement ? Number.parseFloat(getComputedStyle(icon).opacity) : null,
          titleCenterY: titleRect.top + titleRect.height / 2,
          iconCenterY: iconRect ? iconRect.top + iconRect.height / 2 : null,
          actionsLeft: actionsRect?.left ?? null,
          actionsRight: actionsRect?.right ?? null,
          actionsOpacity: actionsStyle ? Number.parseFloat(actionsStyle.opacity) : null,
          actionsPosition: actionsStyle?.position ?? null,
        };
      };
      return {
        root: readRow(rootPageId, rootTitle),
        child: readRow(childPageId, childTitle),
      };
    },
    {
      rootPageId: seed.rootPageId,
      childPageId: seed.childPageId,
      rootTitle: seed.rootTitle,
      childTitle: seed.childTitle,
    },
  );

  assert(metrics.root.ok, metrics.root.reason ?? 'root tree row layout contract failed');
  assert(metrics.child.ok, metrics.child.reason ?? 'child tree row layout contract failed');
  for (const row of [metrics.root, metrics.child]) {
    assert(row.rowHeight >= 28 && row.rowHeight <= 31, `tree row height should stay on the current Notion-style 30px row rhythm: ${JSON.stringify(row)}`);
    assert(
      row.leadingWidth !== null && row.leadingHeight !== null && row.leadingWidth >= 18 && row.leadingWidth <= 22 && row.leadingHeight >= 18 && row.leadingHeight <= 22,
      `tree leading icon/caret slot should stay compact: ${JSON.stringify(row)}`,
    );
    assert(
      row.iconWidth !== null && row.iconHeight !== null && row.iconWidth >= 18 && row.iconHeight >= 18,
      `tree icon column should stay stable: ${JSON.stringify(row)}`,
    );
    assert(
      row.leadingLeft !== null && row.iconLeft !== null && Math.abs(row.iconLeft - row.leadingLeft) <= 1,
      `tree icon should share the leading slot instead of sitting after a caret column: ${JSON.stringify(row)}`,
    );
    assert(
      row.disclosureLeft === null || (row.leadingLeft !== null && Math.abs(row.disclosureLeft - row.leadingLeft) <= 1),
      `tree caret should overlay the icon slot instead of creating a separate column: ${JSON.stringify(row)}`,
    );
    assert(
      row.iconOpacity === null || row.iconOpacity >= 0.8,
      `idle tree icon should stay visible until hover/focus: ${JSON.stringify(row)}`,
    );
    assert(
      row.disclosureOpacity === null || row.disclosureOpacity <= 0.2,
      `idle tree caret should stay quiet until hover/focus: ${JSON.stringify(row)}`,
    );
    assert(
      row.iconCenterY !== null && Math.abs(row.iconCenterY - row.titleCenterY) <= 1.5,
      `tree icon and title should align vertically: ${JSON.stringify(row)}`,
    );
    assert(
      row.leadingRight !== null && row.titleLeft - row.leadingRight >= 3 && row.titleLeft - row.leadingRight <= 6,
      `tree title should follow the leading slot with a compact fixed gap: ${JSON.stringify(row)}`,
    );
    assert(
      row.actionsRight === null || row.actionsRight <= row.rowRight + 1,
      `tree row actions should stay inside row bounds: ${JSON.stringify(row)}`,
    );
    assert(
      row.actionsPosition === null || row.actionsPosition === 'absolute',
      `idle tree row actions should be overlay affordances, not a flex column that reserves blank title width: ${JSON.stringify(row)}`,
    );
    assert(
      row.actionsOpacity === null || row.actionsOpacity <= 0.2,
      `idle tree row actions should stay visually hidden: ${JSON.stringify(row)}`,
    );
    assert(
      row.titlePaddingRight <= 1,
      `idle tree row title should not reserve hover action padding: ${JSON.stringify(row)}`,
    );
  }
  const indentStep = metrics.child.titleLeft - metrics.root.titleLeft;
  assert(
    indentStep >= 12 && indentStep <= 16,
    `child page title indentation should use a compact Notion-style depth step, got ${indentStep}`,
  );
}

async function assertTreeHoverDoesNotShiftLayout(page, seed) {
  await ensurePrivateTreeExpanded(page, seed.rootPageId);
  await privateTreeRow(page, seed.childPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await clearTreeHoverAndFocus(page);
  const idle = await pageTreeLayoutSnapshot(page, seed);

  await privateTreeRow(page, seed.rootPageId).hover({ timeout: options.timeoutMs });
  await waitForTreeDisclosureOpacity(page, seed.rootPageId, 0.8);
  await waitForTreeActionsOpacity(page, seed.rootPageId, 0.8);
  const hover = await pageTreeLayoutSnapshot(page, seed);

  assertTreeSnapshotOk(idle, 'idle');
  assertTreeSnapshotOk(hover, 'hover');
  assert(hover.root.disclosureOpacity >= 0.8, `root caret should be visible on hover: ${JSON.stringify(hover.root)}`);
  assert(hover.root.actionsOpacity >= 0.8, `root actions should be visible on hover: ${JSON.stringify(hover.root)}`);
  assert(hover.root.iconOpacity <= 0.2, `root icon should yield to caret on hover: ${JSON.stringify(hover.root)}`);

  for (const key of ['root', 'child', 'sibling']) {
    assertRowGeometryStable(idle[key], hover[key], key);
  }

  assert(
    Math.abs((hover.child.titleLeft - hover.root.titleLeft) - (idle.child.titleLeft - idle.root.titleLeft)) <= 0.75,
    `child indent should not change when the parent row is hovered: ${JSON.stringify({ idle, hover })}`,
  );
  assert(
    Math.abs((hover.sibling.titleLeft - hover.root.titleLeft) - (idle.sibling.titleLeft - idle.root.titleLeft)) <= 0.75,
    `root-level sibling alignment should not change when the parent row is hovered: ${JSON.stringify({ idle, hover })}`,
  );
  assert(
    hover.child.actionsOpacity <= 0.2 && hover.child.titlePaddingRight <= 1,
    `hovering a parent row should not leak hidden actions or blank padding into child rows: ${JSON.stringify(hover.child)}`,
  );
  assert(
    hover.sibling.actionsOpacity <= 0.2 && hover.sibling.titlePaddingRight <= 1,
    `hovering a parent row should not leak hidden actions or blank padding into sibling rows: ${JSON.stringify(hover.sibling)}`,
  );
  await clearTreeHoverAndFocus(page);
}

async function pageTreeLayoutSnapshot(page, seed) {
  const metrics = await page.evaluate(
    ({ rootPageId, childPageId, siblingPageId, rootTitle, childTitle, siblingTitle }) => {
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const readRow = (id, title) => {
        const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
        if (!(row instanceof HTMLElement)) return { ok: false, reason: `missing tree row ${id}` };
        const leading = row.querySelector('[data-tree-leading="true"]');
        const disclosure = row.querySelector('[data-tree-disclosure="true"]');
        const icon = row.querySelector('[data-tree-icon="true"]');
        const titleEl = Array.from(row.children).find(
          (child) => child instanceof HTMLElement && child.textContent?.trim() === title,
        );
        const actions = row.querySelector('button[aria-label^="Open page actions"]')?.parentElement;
        if (!(leading instanceof HTMLElement) || !(icon instanceof HTMLElement) || !(titleEl instanceof HTMLElement)) {
          return { ok: false, reason: `missing tree row geometry for ${title}` };
        }
        const rowRect = row.getBoundingClientRect();
        const leadingRect = leading.getBoundingClientRect();
        const disclosureRect = disclosure instanceof HTMLElement ? disclosure.getBoundingClientRect() : null;
        const iconRect = icon.getBoundingClientRect();
        const titleRect = titleEl.getBoundingClientRect();
        const actionsRect = actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
        const disclosureStyle = disclosure instanceof HTMLElement ? getComputedStyle(disclosure) : null;
        const iconStyle = getComputedStyle(icon);
        const titleStyle = getComputedStyle(titleEl);
        const actionsStyle = actions instanceof HTMLElement ? getComputedStyle(actions) : null;
        return {
          ok: true,
          id,
          title,
          rowLeft: rowRect.left,
          rowRight: rowRect.right,
          rowTop: rowRect.top,
          rowHeight: rowRect.height,
          leadingLeft: leadingRect.left,
          leadingRight: leadingRect.right,
          titleLeft: titleRect.left,
          titleRight: titleRect.right,
          titlePaddingRight: Number.parseFloat(titleStyle.paddingRight || '0'),
          disclosureLeft: disclosureRect?.left ?? null,
          disclosureOpacity: disclosureStyle ? Number.parseFloat(disclosureStyle.opacity) : null,
          iconLeft: iconRect.left,
          iconOpacity: Number.parseFloat(iconStyle.opacity),
          actionsLeft: actionsRect?.left ?? null,
          actionsRight: actionsRect?.right ?? null,
          actionsOpacity: actionsStyle ? Number.parseFloat(actionsStyle.opacity) : null,
          actionsPosition: actionsStyle?.position ?? null,
        };
      };
      if (!(tree instanceof HTMLElement)) return { ok: false, reason: 'missing private page tree' };
      return {
        ok: true,
        root: readRow(rootPageId, rootTitle),
        child: readRow(childPageId, childTitle),
        sibling: readRow(siblingPageId, siblingTitle),
      };
    },
    {
      rootPageId: seed.rootPageId,
      childPageId: seed.childPageId,
      siblingPageId: seed.siblingPageId,
      rootTitle: seed.rootTitle,
      childTitle: seed.childTitle,
      siblingTitle: seed.siblingTitle,
    },
  );
  assert(metrics.ok, metrics.reason ?? 'page tree geometry snapshot failed');
  return metrics;
}

function assertTreeSnapshotOk(snapshot, state) {
  for (const key of ['root', 'child', 'sibling']) {
    assert(snapshot[key].ok, snapshot[key].reason ?? `${state} ${key} row geometry failed`);
  }
}

function assertRowGeometryStable(before, after, label) {
  const fields = ['rowLeft', 'rowRight', 'leadingLeft', 'leadingRight', 'titleLeft'];
  for (const field of fields) {
    assert(
      Math.abs(after[field] - before[field]) <= 0.75,
      `${label} row ${field} should not shift between idle and parent hover: ${JSON.stringify({ before, after })}`,
    );
  }
  assert(
    Math.abs(after.rowHeight - before.rowHeight) <= 0.75,
    `${label} row height should not change between idle and parent hover: ${JSON.stringify({ before, after })}`,
  );
  assert(
    after.actionsPosition === null || after.actionsPosition === 'absolute',
    `${label} row actions should remain overlay controls during hover comparison: ${JSON.stringify(after)}`,
  );
}

async function captureNestedSidebarTreeScreenshots(page, seed) {
  await ensurePrivateTreeExpanded(page, seed.rootPageId);
  await privateTreeRow(page, seed.childPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await clearTreeHoverAndFocus(page);
  await assertNestedSidebarTreeVisualContract(page, seed, { state: 'idle' });
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'desktop-sidebar-inventory-idle.json',
    state: 'desktop-idle',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-nested-sidebar-tree.png'),
    fullPage: false,
  });
  await hoverPrivateSectionHeader(page);
  const headerHover = await privateSectionHeaderMetrics(page);
  assert(headerHover.addOpacity >= 0.8, `private section add should be visible in hover screenshot: ${JSON.stringify(headerHover)}`);
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'desktop-sidebar-inventory-private-header-hover.json',
    state: 'desktop-private-header-hover',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-private-section-header-hover.png'),
    fullPage: false,
  });
  await clearTreeHoverAndFocus(page);
  await hoverSecondarySectionHeader(page, 'favorites');
  const favoritesHover = await secondarySectionHeaderMetrics(page, 'favorites');
  assert(favoritesHover.chevronOpacity >= 0.8, `favorites section chevron should be visible in hover screenshot: ${JSON.stringify(favoritesHover)}`);
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-secondary-section-header-hover.png'),
    fullPage: false,
  });
  await clearTreeHoverAndFocus(page);
  await privateTreeRow(page, seed.rootPageId).hover({ timeout: options.timeoutMs });
  await waitForTreeDisclosureOpacity(page, seed.rootPageId, 0.8);
  await waitForTreeActionsOpacity(page, seed.rootPageId, 0.8);
  await assertNestedSidebarTreeVisualContract(page, seed, { state: 'hover' });
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'desktop-sidebar-inventory-page-row-hover.json',
    state: 'desktop-page-row-hover',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-nested-sidebar-tree-hover.png'),
    fullPage: false,
  });

  await setTheme(page, 'dark');
  await ensurePrivateTreeExpanded(page, seed.rootPageId);
  await clearTreeHoverAndFocus(page);
  await assertNestedSidebarTreeVisualContract(page, seed, { state: 'idle' });
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'desktop-sidebar-inventory-dark-idle.json',
    state: 'desktop-dark-idle',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-nested-sidebar-tree-dark.png'),
    fullPage: false,
  });
  await hoverPrivateSectionHeader(page);
  const darkHeaderHover = await privateSectionHeaderMetrics(page);
  assert(darkHeaderHover.addOpacity >= 0.8, `private section add should be visible in dark hover screenshot: ${JSON.stringify(darkHeaderHover)}`);
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'desktop-sidebar-inventory-dark-private-header-hover.json',
    state: 'desktop-dark-private-header-hover',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-private-section-header-dark-hover.png'),
    fullPage: false,
  });
  await clearTreeHoverAndFocus(page);
  await hoverSecondarySectionHeader(page, 'shared');
  const sharedHover = await secondarySectionHeaderMetrics(page, 'shared');
  assert(sharedHover.chevronOpacity >= 0.8, `shared section chevron should be visible in dark hover screenshot: ${JSON.stringify(sharedHover)}`);
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-secondary-section-header-dark-hover.png'),
    fullPage: false,
  });
  await clearTreeHoverAndFocus(page);
  await privateTreeRow(page, seed.rootPageId).hover({ timeout: options.timeoutMs });
  await waitForTreeDisclosureOpacity(page, seed.rootPageId, 0.8);
  await waitForTreeActionsOpacity(page, seed.rootPageId, 0.8);
  await assertNestedSidebarTreeVisualContract(page, seed, { state: 'hover' });
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'desktop-sidebar-inventory-dark-page-row-hover.json',
    state: 'desktop-dark-page-row-hover',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-nested-sidebar-tree-dark-hover.png'),
    fullPage: false,
  });

  await setTheme(page, 'light');
}

async function captureMobileNestedSidebarTreeScreenshots(page, seed) {
  await setViewport(page, { width: 390, height: 844 });
  await openMobileSidebar(page);
  await ensurePrivateTreeExpanded(page, seed.rootPageId);
  await privateTreeRow(page, seed.childPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await assertMobileNestedSidebarTreeVisualContract(page, seed);
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'mobile-sidebar-inventory-idle.json',
    state: 'mobile-idle',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'mobile-nested-sidebar-tree.png'),
    fullPage: false,
  });

  await setTheme(page, 'dark');
  await openMobileSidebar(page);
  await ensurePrivateTreeExpanded(page, seed.rootPageId);
  await assertMobileNestedSidebarTreeVisualContract(page, seed);
  await writeSidebarSurfaceInventory(page, seed, {
    fileName: 'mobile-sidebar-inventory-dark-idle.json',
    state: 'mobile-dark-idle',
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'mobile-nested-sidebar-tree-dark.png'),
    fullPage: false,
  });

  await setTheme(page, 'light');
  await setViewport(page, { width: 1280, height: 720 });
  await page.waitForFunction(
    () => document.querySelector('aside[aria-label="Sidebar"]')?.getAttribute('data-mobile') !== 'true',
    undefined,
    { timeout: options.timeoutMs },
  );
}

function sidebarReferenceInventory() {
  return {
    sourceUrl: 'https://app.notion.com/p/Notion-38afebeb4f9a80bcb487fe0139c8132d',
    artifacts: {
      idle: '.edgebase/notion-reference/current/notion-sidebar-section-idle-2026-06-26.json',
      privateHeaderHover: '.edgebase/notion-reference/current/notion-sidebar-private-header-hover-2026-06-26.json',
      sectionHeaderHoverCurrent:
        '.edgebase/notion-reference/current/notion-sidebar-section-header-hover-current-2026-06-26.json',
      privateRowHover: '.edgebase/notion-reference/current/notion-sidebar-private-row-hover-2026-06-26.json',
      sectionTextScale:
        '.edgebase/notion-reference/current/notion-sidebar-section-text-scale-reference-2026-06-26.json',
      liveChrome:
        '.edgebase/notion-reference/current/live-notion-sidebar-workspace-header-while-row-hover-chrome-2026-06-26.png',
      privateHeaderHoverLive:
        '.edgebase/notion-reference/current/live-notion-sidebar-private-section-hover-2026-06-26.png',
      privateHeaderHoverLiveMetrics:
        '.edgebase/notion-reference/current/live-notion-sidebar-private-section-hover-2026-06-26.json',
    },
    normalizedContract: {
      sectionHeaders: [
        'section headers are text-led groups, not page rows',
        'section header actions are scoped to section header hover/focus/open state',
        'page-row hover must not reveal section-level actions',
        'private/personal section exposes one compact right action rail for library, more, and add-page',
        'section caret/dropdown is inline with the section label rather than a separate page-row leading column',
      ],
      pageRows: [
        'page rows keep one leading icon slot at rest',
        'the disclosure caret replaces or overlays the page icon on row hover/focus',
        'row-level more and add-child controls reveal on the row, not on the section header',
        'hidden row actions must not reserve blank title width while idle',
        'child rows advance by a compact consistent indentation step',
      ],
      localDeviationPolicy:
        'Use Hanji labels and responsive tokens, preserve the reference surface inventory and reveal rules, and keep member management in the workspace console instead of a persistent sidebar promo card.',
    },
  };
}

async function writeSidebarSurfaceInventory(page, seed, { fileName, state }) {
  const inventory = {
    surface: 'sidebar/page-tree',
    state,
    reference: sidebarReferenceInventory(),
    local: await collectSidebarSurfaceInventory(page, seed),
  };
  assertSidebarSurfaceInventory(inventory);
  writeJsonArtifact(fileName, inventory);
}

function writeJsonArtifact(fileName, payload) {
  writeFileSync(join(options.screenshotDir, fileName), `${JSON.stringify(payload, null, 2)}\n`);
}

async function collectSidebarSurfaceInventory(page, seed) {
  return await page.evaluate(
    ({ rootPageId, childPageId, siblingPageId }) => {
      const readRect = (node) => {
        if (!(node instanceof Element)) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        };
      };
      const styleOf = (node) => (node instanceof Element ? getComputedStyle(node) : null);
      const opacityOf = (node) => {
        const style = styleOf(node);
        return style ? Number.parseFloat(style.opacity) : null;
      };
      const effectiveOpacityOf = (node) => {
        if (!(node instanceof Element)) return null;
        let current = node;
        let opacity = 1;
        while (current instanceof Element) {
          const style = getComputedStyle(current);
          opacity *= Number.parseFloat(style.opacity || '1');
          if (current.matches('aside[aria-label="Sidebar"]')) break;
          current = current.parentElement;
        }
        return opacity;
      };
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return false;
        const style = getComputedStyle(node);
        const effectiveOpacity = effectiveOpacityOf(node) ?? Number.parseFloat(style.opacity || '1');
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          effectiveOpacity > 0.2 &&
          node.getBoundingClientRect().width > 0 &&
          node.getBoundingClientRect().height > 0
        );
      };
      const buttonInfo = (button) => ({
        label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
        text: button.textContent?.trim() ?? '',
        disabled: button.disabled,
        opacity: opacityOf(button),
        effectiveOpacity: effectiveOpacityOf(button),
        visible: isVisible(button),
        rect: readRect(button),
      });
      const readSection = (section) => {
        const toggle = document.querySelector(`button[aria-controls="sidebar-${section}-section"]`);
        const header = toggle?.parentElement;
        const chevron = toggle?.querySelector('svg');
        const title = toggle?.querySelector('span');
        const actions = document.querySelector(`[data-section-actions="${section}"]`);
        const actionButtons = Array.from(actions?.querySelectorAll('button') ?? []).filter(
          (button) => button instanceof HTMLButtonElement,
        );
        const headerStyle = styleOf(header);
        const actionsStyle = styleOf(actions);
        return {
          present: toggle instanceof HTMLElement,
          label: title?.textContent?.trim() ?? '',
          expanded: toggle instanceof HTMLElement ? toggle.getAttribute('aria-expanded') : null,
          headerBackground: headerStyle?.backgroundColor ?? null,
          headerRect: readRect(header),
          chevronOpacity: opacityOf(chevron),
          chevronVisible: isVisible(chevron),
          actionsOpacity: opacityOf(actions),
          actionsVisible: isVisible(actions),
          actionsPointerEvents: actionsStyle?.pointerEvents ?? null,
          actionLabels: actionButtons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
          buttons: [toggle, ...actionButtons].filter((button) => button instanceof HTMLButtonElement).map(buttonInfo),
        };
      };
      const readSectionHeader = (sectionNode) => {
        const toggle = sectionNode.querySelector('button[aria-controls]');
        const header = toggle?.parentElement;
        const title = toggle?.querySelector('span');
        const chevron = toggle?.querySelector('svg');
        const buttons = Array.from(header?.querySelectorAll('button') ?? []).filter(
          (button) => button instanceof HTMLButtonElement,
        );
        const actionButtons = buttons.filter((button) => button !== toggle);
        const icons = Array.from(header?.querySelectorAll('svg') ?? []).filter((icon) => icon instanceof SVGElement);
        const headerRect = readRect(header);
        const titleRect = readRect(title);
        const titleStyle = styleOf(title);
        const visibleActionButtons = actionButtons.filter(isVisible);
        const visibleLeadingIcons = icons.filter((icon) => {
          const iconRect = icon.getBoundingClientRect();
          const titleBox = title instanceof HTMLElement ? title.getBoundingClientRect() : null;
          if (!titleBox || !isVisible(icon)) return false;
          return iconRect.right <= titleBox.left - 1;
        });
        return {
          label: title?.textContent?.trim() ?? '',
          controls: toggle instanceof HTMLElement ? toggle.getAttribute('aria-controls') : null,
          expanded: toggle instanceof HTMLElement ? toggle.getAttribute('aria-expanded') : null,
          headerRect,
          titleRect,
          titleFontSize: titleStyle ? Number.parseFloat(titleStyle.fontSize) : null,
          titleLeftFromHeader:
            headerRect && titleRect ? Math.round((titleRect.x - headerRect.x) * 100) / 100 : null,
          chevronVisible: isVisible(chevron),
          buttonCount: buttons.length,
          actionLabels: actionButtons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
          visibleActionLabels: visibleActionButtons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
          visibleLeadingIconCount: visibleLeadingIcons.length,
          visibleLeadingIconRects: visibleLeadingIcons.map(readRect),
        };
      };
      const readRow = (id) => {
        const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
        const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
        const title = row?.querySelector('[data-tree-title="true"]');
        const leading = row?.querySelector('[data-tree-leading="true"]');
        const disclosure = row?.querySelector('[data-tree-disclosure="true"]');
        const icon = row?.querySelector('[data-tree-icon="true"]');
        const dragHandle = row?.querySelector('[data-tree-drag-handle="true"]');
        const actions = row?.querySelector('button[aria-label^="Open page actions"]')?.parentElement;
        const actionButtons = Array.from(actions?.querySelectorAll('button') ?? []).filter(
          (button) => button instanceof HTMLButtonElement,
        );
        const rowStyle = styleOf(row);
        const titleStyle = styleOf(title);
        return {
          present: row instanceof HTMLElement,
          title: title?.textContent?.trim() ?? '',
          level: row instanceof HTMLElement ? row.getAttribute('aria-level') : null,
          current: row instanceof HTMLElement ? row.getAttribute('aria-current') : null,
          expanded: row instanceof HTMLElement ? row.getAttribute('aria-expanded') : null,
          hasChildren: row instanceof HTMLElement ? row.getAttribute('data-has-children') : null,
          rowBackground: rowStyle?.backgroundColor ?? null,
          rowRect: readRect(row),
          leadingRect: readRect(leading),
          disclosureOpacity: opacityOf(disclosure),
          disclosureVisible: isVisible(disclosure),
          iconOpacity: opacityOf(icon),
          iconVisible: isVisible(icon),
          dragHandleOpacity: opacityOf(dragHandle),
          dragHandleVisible: isVisible(dragHandle),
          actionsOpacity: opacityOf(actions),
          actionsVisible: isVisible(actions),
          actionLabels: actionButtons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
          titlePaddingRight: titleStyle ? Number.parseFloat(titleStyle.paddingRight || '0') : null,
          titleRect: readRect(title),
        };
      };
      const readTopRail = () => {
        const actions = document.querySelector('[data-sidebar-top-actions]');
        const home = actions?.querySelector('[data-sidebar-home-action]');
        const iconActions = Array.from(actions?.querySelectorAll('[data-sidebar-icon-action]') ?? []).filter(
          (button) => button instanceof HTMLButtonElement,
        );
        const buttons = [home, ...iconActions].filter((button) => button instanceof HTMLButtonElement);
        return {
          present: actions instanceof HTMLElement,
          rect: readRect(actions),
          text: actions?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          slots: buttons.map((button) => button.getAttribute('data-sidebar-rail-slot')),
          labels: buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
          buttons: buttons.map((button) => ({
            ...buttonInfo(button),
            active: button.getAttribute('data-active'),
            slot: button.getAttribute('data-sidebar-rail-slot'),
            svgRects: Array.from(button.querySelectorAll('svg')).map(readRect),
          })),
        };
      };
      const sectionOrder = Array.from(document.querySelectorAll('aside[aria-label="Sidebar"] section'))
        .map((sectionNode) => {
          const label = sectionNode.querySelector('button[aria-controls] span')?.textContent?.trim();
          return label || null;
        })
        .filter(Boolean);
      const sectionHeaders = Array.from(document.querySelectorAll('aside[aria-label="Sidebar"] section')).map(readSectionHeader);
      const privateTree = document.querySelector('#sidebar-private-section');
      const persistentAddRows = Array.from(privateTree?.querySelectorAll('button') ?? [])
        .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
        .filter((label) => label === 'Add a page' || label === '+ Add a page');
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        theme: document.documentElement.dataset.theme ?? document.body.dataset.theme ?? null,
        sidebar: {
          mobile: sidebar instanceof HTMLElement ? sidebar.getAttribute('data-mobile') : null,
          open: sidebar instanceof HTMLElement ? sidebar.getAttribute('data-open') : null,
          rect: readRect(sidebar),
          collaborationAreaPresent: Boolean(sidebar?.querySelector('[data-sidebar-collaboration]')),
          memberCardPresent: Boolean(sidebar?.querySelector('[data-sidebar-member-invite]')),
        },
        topRail: readTopRail(),
        sectionOrder,
        sectionHeaders,
        sections: {
          favorites: readSection('favorites'),
          shared: readSection('shared'),
          private: readSection('private'),
        },
        privateTree: {
          persistentAddRows,
          rowCount: privateTree?.querySelectorAll('[data-page-tree-item="true"]').length ?? 0,
        },
        rows: {
          root: readRow(rootPageId),
          child: readRow(childPageId),
          sibling: readRow(siblingPageId),
        },
      };
    },
    {
      rootPageId: seed.rootPageId,
      childPageId: seed.childPageId,
      siblingPageId: seed.siblingPageId,
    },
  );
}

function assertSidebarSurfaceInventory(inventory) {
  const { state, local } = inventory;
  const privateSection = local.sections.private;
  assertTopRailInventory(inventory);
  assertSectionHeaderInventory(inventory);
  assert(
    !local.sidebar.collaborationAreaPresent && !local.sidebar.memberCardPresent,
    `sidebar inventory should keep member management in the workspace console, not a promo card: ${JSON.stringify(local.sidebar)}`,
  );
  assert(privateSection.present, `sidebar inventory must include the Private section: ${JSON.stringify(inventory)}`);
  // The private section header renders as "Pages" since the i18n label sweep
  // (Sidebar labels.private, commit 0cdac3bf).
  assert(privateSection.label === 'Pages', `local Private section label drifted: ${JSON.stringify(privateSection)}`);
  assert(privateSection.expanded === 'true', `Private section should be expanded in sidebar inventory: ${JSON.stringify(privateSection)}`);
  assert(
    JSON.stringify(privateSection.actionLabels) ===
      JSON.stringify(['Open pages library', 'Open page section options', 'Add a page']),
    `Private section action inventory should be library/more/add only: ${JSON.stringify(privateSection)}`,
  );
  assert(
    local.privateTree.persistentAddRows.length === 0,
    `populated Private tree inventory should not contain a persistent Add a page row: ${JSON.stringify(local.privateTree)}`,
  );
  assert(local.rows.root.present && local.rows.child.present && local.rows.sibling.present, `sidebar inventory must include root/child/sibling rows: ${JSON.stringify(local.rows)}`);
  assert(local.rows.child.level === '2', `child page should remain a level-2 tree row in inventory: ${JSON.stringify(local.rows.child)}`);
  assert(local.rows.root.hasChildren === 'true', `root page should expose expandable children in inventory: ${JSON.stringify(local.rows.root)}`);

  const privateIndex = local.sectionOrder.indexOf('Pages');
  if (local.sections.favorites.present) {
    assert(
      local.sectionOrder.indexOf('Favorites') < privateIndex,
      `Favorites should stay before Private in sidebar inventory: ${JSON.stringify(local.sectionOrder)}`,
    );
  }
  if (local.sections.shared.present) {
    assert(
      local.sectionOrder.indexOf('Shared') > privateIndex,
      `Shared should stay after Private in sidebar inventory: ${JSON.stringify(local.sectionOrder)}`,
    );
  }

  if (state.includes('private-header-hover')) {
    assert(privateSection.actionsVisible, `Private header hover should reveal section actions: ${JSON.stringify(inventory)}`);
    assert(privateSection.chevronVisible, `Private header hover should reveal inline section chevron: ${JSON.stringify(inventory)}`);
    assert(
      !local.rows.root.actionsVisible && !local.rows.root.disclosureVisible,
      `Private header hover must not reveal page-row controls: ${JSON.stringify(local.rows.root)}`,
    );
    return;
  }

  if (state.includes('page-row-hover')) {
    assert(
      !privateSection.actionsVisible && !privateSection.chevronVisible,
      `Page-row hover must not reveal Private section actions: ${JSON.stringify(privateSection)}`,
    );
    assert(local.rows.root.actionsVisible, `Page-row hover should reveal row-level actions: ${JSON.stringify(local.rows.root)}`);
    assert(local.rows.root.disclosureVisible, `Page-row hover should reveal the row caret: ${JSON.stringify(local.rows.root)}`);
    assert(!local.rows.root.iconVisible, `Page-row hover should let the caret replace/yield the icon slot: ${JSON.stringify(local.rows.root)}`);
    assert(!local.rows.root.dragHandleVisible, `Page-row hover must not reveal the dotted drag handle: ${JSON.stringify(local.rows.root)}`);
    return;
  }

  assert(!privateSection.actionsVisible, `Idle sidebar inventory should keep Private section actions hidden: ${JSON.stringify(privateSection)}`);
  assert(!local.rows.root.actionsVisible, `Idle sidebar inventory should keep root row actions hidden: ${JSON.stringify(local.rows.root)}`);
  assert(!local.rows.root.dragHandleVisible, `Idle sidebar inventory should keep dotted drag handles hidden: ${JSON.stringify(local.rows.root)}`);
}

function assertTopRailInventory(inventory) {
  const rail = inventory.local.topRail;
  assert(rail?.present, `sidebar inventory must include the top navigation rail: ${JSON.stringify(inventory)}`);
  assert(
    JSON.stringify(rail.slots) === JSON.stringify(['home', 'inbox', 'search']),
    `sidebar top rail inventory should stay as Home/inbox/search slots after chat/meeting removal: ${JSON.stringify(rail)}`,
  );
  assert(
    rail.labels.every((label) => !/Chat|Comment|Meeting|Update|Settings|Templates|Import|Trash/.test(label)),
    `sidebar top rail inventory should not contain chat/meeting or management/template actions: ${JSON.stringify(rail.labels)}`,
  );
  assert(
    rail.buttons.length === 3 &&
      rail.buttons.every((button) => button.rect?.height >= 31 && button.rect?.height <= 34) &&
      rail.buttons.every((button) => {
        const width = button.svgRects?.[0]?.width ?? 0;
        return width >= 18.5 && width <= 19.5;
      }),
    `sidebar top rail buttons should stay compact and Notion-reference scaled in inventory: ${JSON.stringify(rail.buttons)}`,
  );
  const home = rail.buttons.find((button) => button.slot === 'home');
  const iconButtons = rail.buttons.filter((button) => button.slot !== 'home');
  assert(home?.active === 'true', `sidebar top Home inventory should stay active on workspace content: ${JSON.stringify(home)}`);
  assert(
    iconButtons.every((button) => button.rect?.width >= 31 && button.rect?.width <= 34),
    `sidebar top icon inventory should use uniform compact hit areas: ${JSON.stringify(iconButtons)}`,
  );
}

function assertSectionHeaderInventory(inventory) {
  const { state, local } = inventory;
  const headers = local.sectionHeaders ?? [];
  assert(headers.length >= 1, `sidebar inventory must record every section header: ${JSON.stringify(inventory)}`);

  for (const header of headers) {
    assert(header.label, `section header inventory needs a visible label: ${JSON.stringify(header)}`);
    assert(
      header.headerRect?.height >= 28 && header.headerRect?.height <= 31,
      `section header "${header.label}" should stay on the current Notion-style 30px row rhythm: ${JSON.stringify(header)}`,
    );
    assert(
      header.titleLeftFromHeader >= 6 && header.titleLeftFromHeader <= 16,
      `section header "${header.label}" should be text-led, not pushed over by a page-row leading column: ${JSON.stringify(header)}`,
    );
    assert(
      header.titleFontSize >= 11.5 && header.titleFontSize <= 12.75,
      `section header "${header.label}" should use quiet 12px section chrome, not page-row text scale: ${JSON.stringify(header)}`,
    );
    assert(
      header.visibleLeadingIconCount === 0,
      `section header "${header.label}" should not show a page-row-style leading icon before the label: ${JSON.stringify(header)}`,
    );
  }

  const headersWithVisibleActions = headers.filter((header) => header.visibleActionLabels.length > 0);
  if (state.includes('private-header-hover')) {
    const privateHeader = headers.find((header) => header.controls === 'sidebar-private-section');
    assert(
      privateHeader?.visibleActionLabels.length === 3,
      `Private header hover should be the only section header state with a three-button action rail: ${JSON.stringify(headers)}`,
    );
    assert(
      headersWithVisibleActions.length === 1 && headersWithVisibleActions[0].controls === 'sidebar-private-section',
      `hovering the Private header must not reveal actions on other section headers: ${JSON.stringify(headersWithVisibleActions)}`,
    );
    return;
  }

  assert(
    headersWithVisibleActions.length === 0,
    `section header actions should stay hidden outside their own header hover/focus/open state: ${JSON.stringify(headersWithVisibleActions)}`,
  );
}

async function openMobileSidebar(page) {
  await page.waitForFunction(
    () => document.querySelector('aside[aria-label="Sidebar"]')?.getAttribute('data-mobile') === 'true',
    undefined,
    { timeout: options.timeoutMs },
  );
  const sidebar = page.locator('aside[aria-label="Sidebar"]');
  if ((await sidebar.getAttribute('data-open')) !== 'true') {
    await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: options.timeoutMs });
  }
  await page.waitForFunction(
    () => {
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      if (!(sidebar instanceof HTMLElement)) return false;
      const rect = sidebar.getBoundingClientRect();
      return (
        sidebar.getAttribute('data-mobile') === 'true' &&
        sidebar.getAttribute('data-open') === 'true' &&
        Math.abs(rect.left) <= 1
      );
    },
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function assertMobileNestedSidebarTreeVisualContract(page, seed) {
  const metrics = await page.evaluate(
    ({ rootPageId, childPageId, siblingPageId, rootTitle, childTitle, siblingTitle }) => {
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const readRow = (id, title) => {
        const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
        if (!(row instanceof HTMLElement)) return { ok: false, reason: `missing mobile tree row ${id}` };
        const leading = row.querySelector('[data-tree-leading="true"]');
        const disclosure = row.querySelector('[data-tree-disclosure="true"]');
        const icon = row.querySelector('[data-tree-icon="true"]');
        const titleEl = Array.from(row.children).find((child) => child.textContent?.trim() === title);
        const actions = row.querySelector('button[aria-label^="Open page actions"]')?.parentElement;
        if (!(leading instanceof HTMLElement) || !(icon instanceof HTMLElement) || !(titleEl instanceof HTMLElement)) {
          return { ok: false, reason: `missing mobile tree row columns for ${title}` };
        }
        const rowRect = row.getBoundingClientRect();
        const leadingRect = leading.getBoundingClientRect();
        const disclosureRect = disclosure instanceof HTMLElement ? disclosure.getBoundingClientRect() : null;
        const iconRect = icon.getBoundingClientRect();
        const titleRect = titleEl.getBoundingClientRect();
        const actionsRect = actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
        const disclosureStyle = disclosure instanceof HTMLElement ? getComputedStyle(disclosure) : null;
        const iconStyle = getComputedStyle(icon);
        const titleStyle = getComputedStyle(titleEl);
        const actionsStyle = actions instanceof HTMLElement ? getComputedStyle(actions) : null;
        return {
          ok: true,
          id,
          title,
          level: row.getAttribute('aria-level'),
          expanded: row.getAttribute('aria-expanded'),
          current: row.getAttribute('aria-current'),
          rowLeft: rowRect.left,
          rowRight: rowRect.right,
          rowTop: rowRect.top,
          rowHeight: rowRect.height,
          leadingLeft: leadingRect.left,
          leadingRight: leadingRect.right,
          leadingWidth: leadingRect.width,
          leadingHeight: leadingRect.height,
          disclosureLeft: disclosureRect?.left ?? null,
          disclosureWidth: disclosureRect?.width ?? null,
          disclosureHeight: disclosureRect?.height ?? null,
          disclosureOpacity: disclosureStyle ? Number.parseFloat(disclosureStyle.opacity) : null,
          iconLeft: iconRect.left,
          iconRight: iconRect.right,
          iconWidth: iconRect.width,
          iconHeight: iconRect.height,
          iconOpacity: Number.parseFloat(iconStyle.opacity),
          titleLeft: titleRect.left,
          titleRight: titleRect.right,
          titleClientWidth: titleEl.clientWidth,
          titleScrollWidth: titleEl.scrollWidth,
          titlePaddingRight: Number.parseFloat(titleStyle.paddingRight || '0'),
          titleCenterY: titleRect.top + titleRect.height / 2,
          iconCenterY: iconRect.top + iconRect.height / 2,
          actionsLeft: actionsRect?.left ?? null,
          actionsRight: actionsRect?.right ?? null,
          actionsWidth: actionsRect?.width ?? null,
          actionsOpacity: actionsStyle ? Number.parseFloat(actionsStyle.opacity) : null,
          actionsPosition: actionsStyle?.position ?? null,
        };
      };

      if (!(sidebar instanceof HTMLElement) || !(tree instanceof HTMLElement)) {
        return { ok: false, reason: 'missing mobile sidebar or private page tree' };
      }
      const sidebarRect = sidebar.getBoundingClientRect();
      const treeRect = tree.getBoundingClientRect();
      const sectionAdd = document.querySelector('button[aria-label="Add a page"]');
      const sectionActions = document.querySelector('[data-section-actions="private"]');
      const sectionToggle = document.querySelector('button[aria-controls="sidebar-private-section"]');
      const sectionHeader = sectionToggle?.parentElement;
      const sectionChevron = sectionToggle?.querySelector('svg');
      const sectionAddStyle = sectionAdd instanceof HTMLElement ? getComputedStyle(sectionAdd) : null;
      const sectionActionsStyle = sectionActions instanceof HTMLElement ? getComputedStyle(sectionActions) : null;
      const sectionChevronStyle = sectionChevron instanceof SVGElement ? getComputedStyle(sectionChevron) : null;
      const sectionActionsOpacity = sectionActionsStyle
        ? Number.parseFloat(sectionActionsStyle.opacity)
        : null;
      const sectionHeaderRect = sectionHeader instanceof HTMLElement ? sectionHeader.getBoundingClientRect() : null;
      return {
        ok: true,
        bodyWidth: document.body.scrollWidth,
        documentWidth: document.documentElement.scrollWidth,
        coarsePointer: window.matchMedia('(pointer: coarse)').matches,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        sidebarWidth: sidebarRect.width,
        sidebarMobile: sidebar.getAttribute('data-mobile'),
        sidebarOpen: sidebar.getAttribute('data-open'),
        treeLeft: treeRect.left,
        treeRight: treeRect.right,
        treeTop: treeRect.top,
        sectionAddOpacity: sectionAddStyle
          ? Math.min(Number.parseFloat(sectionAddStyle.opacity), sectionActionsOpacity ?? 1)
          : null,
        sectionAddPointerEvents: sectionActionsStyle?.pointerEvents ?? sectionAddStyle?.pointerEvents ?? null,
        sectionActionsOpacity,
        sectionActionsPointerEvents: sectionActionsStyle?.pointerEvents ?? null,
        sectionChevronOpacity: sectionChevronStyle ? Number.parseFloat(sectionChevronStyle.opacity) : null,
        sectionHeaderHeight: sectionHeaderRect?.height ?? null,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        root: readRow(rootPageId, rootTitle),
        child: readRow(childPageId, childTitle),
        sibling: readRow(siblingPageId, siblingTitle),
      };
    },
    {
      rootPageId: seed.rootPageId,
      childPageId: seed.childPageId,
      siblingPageId: seed.siblingPageId,
      rootTitle: seed.rootTitle,
      childTitle: seed.childTitle,
      siblingTitle: seed.siblingTitle,
    },
  );

  assert(metrics.ok, metrics.reason ?? 'mobile nested sidebar tree visual contract could not run');
  assert(metrics.viewportWidth <= 430, `mobile nested tree should run in a narrow viewport, got ${Math.round(metrics.viewportWidth)}px`);
  assert(metrics.sidebarMobile === 'true' && metrics.sidebarOpen === 'true', `mobile sidebar should be open for nested tree capture: ${JSON.stringify(metrics)}`);
  assert(Math.abs(metrics.sidebarLeft) <= 1, `mobile sidebar drawer should start at the left edge, got ${Math.round(metrics.sidebarLeft)}px`);
  assert(
    metrics.sidebarWidth >= 276 && metrics.sidebarWidth <= 284,
    `mobile sidebar drawer should keep the 280px Hanji width, got ${Math.round(metrics.sidebarWidth)}px`,
  );
  assert(metrics.sidebarRight <= metrics.viewportWidth + 1, `mobile sidebar should fit the viewport, got right=${Math.round(metrics.sidebarRight)} viewport=${Math.round(metrics.viewportWidth)}`);
  assert(metrics.treeLeft >= 7 && metrics.treeRight <= metrics.sidebarRight - 7, `mobile tree should sit inside sidebar gutters: ${JSON.stringify(metrics)}`);
  assert(Math.max(metrics.bodyWidth, metrics.documentWidth) <= metrics.viewportWidth + 4, `mobile nested sidebar should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.root.ok, metrics.root.reason ?? 'mobile root nested tree row contract failed');
  assert(metrics.child.ok, metrics.child.reason ?? 'mobile child nested tree row contract failed');
  assert(metrics.sibling.ok, metrics.sibling.reason ?? 'mobile sibling nested tree row contract failed');
  assert(metrics.root.expanded === 'true', `mobile root row should be expanded in nested tree screenshot: ${JSON.stringify(metrics.root)}`);
  assert(metrics.root.level === '1' && metrics.child.level === '2' && metrics.sibling.level === '1', `mobile nested tree levels drifted: ${JSON.stringify(metrics)}`);
  if (metrics.coarsePointer) {
    assert(metrics.root.disclosureOpacity >= 0.8, `touch mobile expanded root caret should be visible, got ${metrics.root.disclosureOpacity}`);
    assert(metrics.root.iconOpacity <= 0.2, `touch mobile expanded root icon should yield to the visible caret, got ${metrics.root.iconOpacity}`);
  } else {
    assert(metrics.root.disclosureOpacity <= 0.2, `fine-pointer mobile-width root caret should stay quiet until hover/focus, got ${metrics.root.disclosureOpacity}`);
    assert(metrics.root.iconOpacity >= 0.8, `fine-pointer mobile-width root icon should stay visible until hover/focus, got ${metrics.root.iconOpacity}`);
  }
  assert(
    metrics.sectionAddOpacity === null || metrics.sectionAddOpacity <= 0.2,
    `mobile private section add action should stay quiet until focus, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.sectionActionsOpacity === null || metrics.sectionActionsOpacity <= 0.2,
    `mobile private section action rail should stay hidden at rest: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.sectionActionsPointerEvents === null || metrics.sectionActionsPointerEvents === 'none',
    `mobile private section actions should not intercept idle row clicks: ${JSON.stringify(metrics)}`,
  );
  if (!metrics.coarsePointer) {
    assert(
      metrics.sectionChevronOpacity === null || metrics.sectionChevronOpacity <= 0.2,
      `fine-pointer mobile-width private section chevron should stay hover-only: ${JSON.stringify(metrics)}`,
    );
  }
  assert(
    metrics.sectionHeaderHeight === null || (metrics.sectionHeaderHeight >= 28 && metrics.sectionHeaderHeight <= 31),
    `mobile private section header should remain on the current Notion-style 30px section rhythm: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.child.rowTop > metrics.root.rowTop && metrics.sibling.rowTop > metrics.child.rowTop, `mobile nested rows should stack in root/child/sibling order: ${JSON.stringify(metrics)}`);

  for (const row of [metrics.root, metrics.child, metrics.sibling]) {
    assert(row.rowHeight >= 28 && row.rowHeight <= 31, `mobile nested tree row height should stay on the current Notion-style 30px row rhythm: ${JSON.stringify(row)}`);
    assert(row.rowLeft >= metrics.treeLeft - 1 && row.rowRight <= metrics.sidebarRight - 6, `mobile tree row should stay inside the drawer: ${JSON.stringify(row)}`);
    assert(row.leadingWidth >= 18 && row.leadingWidth <= 22, `mobile nested tree leading slot width drifted: ${JSON.stringify(row)}`);
    assert(row.iconLeft >= row.leadingLeft - 1 && row.iconLeft <= row.leadingLeft + 1, `mobile nested tree icon should share the leading slot: ${JSON.stringify(row)}`);
    assert(row.disclosureLeft === null || Math.abs(row.disclosureLeft - row.leadingLeft) <= 1, `mobile tree caret should overlay the leading slot: ${JSON.stringify(row)}`);
    if (row.expanded === 'true' && metrics.coarsePointer) {
      assert(row.disclosureOpacity >= 0.8, `mobile expanded tree caret should remain visible on touch: ${JSON.stringify(row)}`);
      assert(row.iconOpacity <= 0.2, `mobile expanded tree icon should yield to the caret: ${JSON.stringify(row)}`);
    } else {
      assert(row.disclosureOpacity === null || row.disclosureOpacity <= 0.2, `mobile leaf tree rows should not show a stray caret: ${JSON.stringify(row)}`);
      assert(row.iconOpacity >= 0.8, `mobile leaf tree rows should keep the page icon visible: ${JSON.stringify(row)}`);
    }
    assert(row.iconWidth >= 18 && row.iconWidth <= 22 && row.iconHeight >= 18 && row.iconHeight <= 22, `mobile nested tree icon column drifted: ${JSON.stringify(row)}`);
    assert(Math.abs(row.iconCenterY - row.titleCenterY) <= 1.5, `mobile nested tree icon/title vertical alignment drifted: ${JSON.stringify(row)}`);
    assert(row.titleLeft - row.leadingRight >= 3 && row.titleLeft - row.leadingRight <= 6, `mobile nested tree title/leading gap drifted: ${JSON.stringify(row)}`);
    assert(row.actionsRight === null || row.actionsRight <= row.rowRight + 1, `mobile nested tree actions overflow row bounds: ${JSON.stringify(row)}`);
    assert(row.actionsPosition === null || row.actionsPosition === 'absolute', `mobile tree row actions should be overlay affordances instead of reserving idle title width: ${JSON.stringify(row)}`);
    if (row.current === 'page' && metrics.coarsePointer) {
      assert(row.actionsOpacity === null || row.actionsOpacity >= 0.8, `mobile current tree row actions should remain discoverable: ${JSON.stringify(row)}`);
      assert(row.titlePaddingRight >= 36, `mobile current tree row title should reserve padding for visible row actions: ${JSON.stringify(row)}`);
      assert(
        row.actionsLeft === null || row.titleRight - row.titlePaddingRight <= row.actionsLeft + 4,
        `mobile current tree row title text should stop before the overlay action rail: ${JSON.stringify(row)}`,
      );
      assert(row.actionsLeft === null || row.actionsLeft >= row.rowRight - 54, `mobile current tree row actions should sit in a compact right overlay rail: ${JSON.stringify(row)}`);
    } else {
      assert(row.actionsOpacity === null || row.actionsOpacity <= 0.2, `mobile idle non-current tree row actions should stay quiet: ${JSON.stringify(row)}`);
      assert(row.titlePaddingRight <= 1, `mobile idle non-current row should not reserve action padding: ${JSON.stringify(row)}`);
    }
  }

  const childIndent = metrics.child.titleLeft - metrics.root.titleLeft;
  const siblingIndent = metrics.sibling.titleLeft - metrics.root.titleLeft;
  assert(childIndent >= 12 && childIndent <= 16, `mobile nested child indent should use a compact Notion-style depth step, got ${childIndent}`);
  assert(Math.abs(siblingIndent) <= 1, `mobile root-level sibling should align with root row, got ${siblingIndent}`);
}

async function assertNestedSidebarTreeVisualContract(page, seed, { state } = { state: 'idle' }) {
  const metrics = await page.evaluate(
    ({ rootPageId, childPageId, siblingPageId, rootTitle, childTitle, siblingTitle }) => {
      const sidebar = document.querySelector('aside[aria-label="Sidebar"]');
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const sidebarBackground =
        sidebar instanceof HTMLElement ? getComputedStyle(sidebar).backgroundColor : 'rgb(255, 255, 255)';
      const parseRgba = (color) => {
        const srgbMatch = color.match(/color\(srgb\s+([^)]+)\)/);
        if (srgbMatch) {
          const parts = srgbMatch[1]
            .replace(/\//g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => Number.parseFloat(part));
          if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
          return {
            r: parts[0],
            g: parts[1],
            b: parts[2],
            a: Number.isFinite(parts[3]) ? parts[3] : 1,
          };
        }
        const match = color.match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
        if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
        return {
          r: parts[0] / 255,
          g: parts[1] / 255,
          b: parts[2] / 255,
          a: Number.isFinite(parts[3]) ? parts[3] : 1,
        };
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
        const fg = parseRgba(fgColor);
        const bg = parseRgba(bgColor);
        if (!fg || !bg) return 0;
        const blendedFg = blend(fg, bg);
        const lighter = Math.max(luminance(blendedFg), luminance(bg));
        const darker = Math.min(luminance(blendedFg), luminance(bg));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const readRow = (id, title) => {
        const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
        if (!(row instanceof HTMLElement)) return { ok: false, reason: `missing tree row ${id}` };
        const leading = row.querySelector('[data-tree-leading="true"]');
        const disclosure = row.querySelector('[data-tree-disclosure="true"]');
        const icon = row.querySelector('[data-tree-icon="true"]');
        const titleEl = Array.from(row.children).find((child) => child.textContent?.trim() === title);
        const actions = row.querySelector('button[aria-label^="Open page actions"]')?.parentElement;
        if (!(leading instanceof HTMLElement) || !(icon instanceof HTMLElement) || !(titleEl instanceof HTMLElement)) {
          return { ok: false, reason: `missing tree row columns for ${title}` };
        }
        const rowRect = row.getBoundingClientRect();
        const leadingRect = leading.getBoundingClientRect();
        const disclosureRect = disclosure instanceof HTMLElement ? disclosure.getBoundingClientRect() : null;
        const iconRect = icon.getBoundingClientRect();
        const titleRect = titleEl.getBoundingClientRect();
        const actionsRect = actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
        const disclosureStyle = disclosure instanceof HTMLElement ? getComputedStyle(disclosure) : null;
        const iconStyle = getComputedStyle(icon);
        const titleStyle = getComputedStyle(titleEl);
        const actionsStyle = actions instanceof HTMLElement ? getComputedStyle(actions) : null;
        return {
          ok: true,
          id,
          title,
          level: row.getAttribute('aria-level'),
          expanded: row.getAttribute('aria-expanded'),
          current: row.getAttribute('aria-current'),
          rowLeft: rowRect.left,
          rowRight: rowRect.right,
          rowTop: rowRect.top,
          rowHeight: rowRect.height,
          leadingLeft: leadingRect.left,
          leadingRight: leadingRect.right,
          leadingWidth: leadingRect.width,
          leadingHeight: leadingRect.height,
          disclosureLeft: disclosureRect?.left ?? null,
          disclosureWidth: disclosureRect?.width ?? null,
          disclosureHeight: disclosureRect?.height ?? null,
          disclosureOpacity: disclosureStyle ? Number.parseFloat(disclosureStyle.opacity) : null,
          disclosureBackground: disclosureStyle?.backgroundColor ?? null,
          iconLeft: iconRect.left,
          iconRight: iconRect.right,
          iconWidth: iconRect.width,
          iconHeight: iconRect.height,
          iconOpacity: Number.parseFloat(iconStyle.opacity),
          titleLeft: titleRect.left,
          titleRight: titleRect.right,
          titlePaddingRight: Number.parseFloat(titleStyle.paddingRight || '0'),
          titleCenterY: titleRect.top + titleRect.height / 2,
          titleColor: titleStyle.color,
          titleContrast: contrastRatio(titleStyle.color, sidebarBackground),
          iconCenterY: iconRect.top + iconRect.height / 2,
          actionsLeft: actionsRect?.left ?? null,
          actionsRight: actionsRect?.right ?? null,
          actionsOpacity: actionsStyle ? Number.parseFloat(actionsStyle.opacity) : null,
          actionsPosition: actionsStyle?.position ?? null,
        };
      };

      if (!(sidebar instanceof HTMLElement) || !(tree instanceof HTMLElement)) {
        return { ok: false, reason: 'missing sidebar or private page tree' };
      }
      const sidebarRect = sidebar.getBoundingClientRect();
      const treeRect = tree.getBoundingClientRect();
      return {
        ok: true,
        sidebarWidth: sidebarRect.width,
        treeTop: treeRect.top,
        treeLeft: treeRect.left,
        root: readRow(rootPageId, rootTitle),
        child: readRow(childPageId, childTitle),
        sibling: readRow(siblingPageId, siblingTitle),
      };
    },
    {
      rootPageId: seed.rootPageId,
      childPageId: seed.childPageId,
      siblingPageId: seed.siblingPageId,
      rootTitle: seed.rootTitle,
      childTitle: seed.childTitle,
      siblingTitle: seed.siblingTitle,
    },
  );

  assert(metrics.ok, metrics.reason ?? 'nested sidebar tree visual contract could not run');
  assert(
    metrics.sidebarWidth >= 264 && metrics.sidebarWidth <= 276,
    `nested sidebar tree should keep the current Notion-reference desktop sidebar width near 270px, got ${Math.round(metrics.sidebarWidth)}px`,
  );
  assert(metrics.root.ok, metrics.root.reason ?? 'root nested tree row contract failed');
  assert(metrics.child.ok, metrics.child.reason ?? 'child nested tree row contract failed');
  assert(metrics.sibling.ok, metrics.sibling.reason ?? 'sibling nested tree row contract failed');
  assert(metrics.root.expanded === 'true', `root row should be expanded in nested tree screenshot: ${JSON.stringify(metrics.root)}`);
  assert(metrics.root.level === '1' && metrics.child.level === '2' && metrics.sibling.level === '1', `nested tree levels drifted: ${JSON.stringify(metrics)}`);
  if (state === 'hover') {
    assert(metrics.root.disclosureOpacity >= 0.8, `hovered expanded root caret should be visible, got ${metrics.root.disclosureOpacity}`);
    assert(metrics.root.iconOpacity <= 0.2, `hovered expanded root icon should yield to the caret, got ${metrics.root.iconOpacity}`);
    assert(metrics.root.actionsOpacity === null || metrics.root.actionsOpacity >= 0.8, `hovered expanded root actions should be visible, got ${metrics.root.actionsOpacity}`);
    assert(metrics.root.titlePaddingRight >= 36, `hovered expanded root title should reserve padding for the overlay action rail: ${JSON.stringify(metrics.root)}`);
    assert(
      metrics.root.actionsLeft === null || metrics.root.titleRight - metrics.root.titlePaddingRight <= metrics.root.actionsLeft + 4,
      `hovered expanded root title text should stop before the overlay action rail: ${JSON.stringify(metrics.root)}`,
    );
    assert(metrics.root.actionsLeft === null || metrics.root.actionsLeft >= metrics.root.rowRight - 54, `hovered expanded root actions should sit in a compact right overlay rail: ${JSON.stringify(metrics.root)}`);
  } else {
    assert(metrics.root.disclosureOpacity <= 0.2, `idle expanded root caret should stay visually quiet until hover/focus, got ${metrics.root.disclosureOpacity}`);
    assert(metrics.root.iconOpacity >= 0.8, `idle expanded root icon should stay visible until hover/focus, got ${metrics.root.iconOpacity}`);
    assert(metrics.root.actionsOpacity === null || metrics.root.actionsOpacity <= 0.2, `idle expanded root actions should stay hidden until hover/focus, got ${metrics.root.actionsOpacity}`);
    assert(metrics.root.titlePaddingRight <= 1, `idle expanded root title should not reserve hover action padding: ${JSON.stringify(metrics.root)}`);
  }
  assert(metrics.child.rowTop > metrics.root.rowTop && metrics.sibling.rowTop > metrics.child.rowTop, `nested rows should stack in root/child/sibling order: ${JSON.stringify(metrics)}`);

  for (const row of [metrics.root, metrics.child, metrics.sibling]) {
    assert(row.rowHeight >= 28 && row.rowHeight <= 31, `nested tree row height should stay on the current Notion-style 30px row rhythm: ${JSON.stringify(row)}`);
    assert(row.leadingWidth >= 18 && row.leadingWidth <= 22, `nested tree leading slot width drifted: ${JSON.stringify(row)}`);
    assert(row.iconLeft >= row.leadingLeft - 1 && row.iconLeft <= row.leadingLeft + 1, `nested tree icon should share the leading slot: ${JSON.stringify(row)}`);
    assert(row.disclosureLeft === null || Math.abs(row.disclosureLeft - row.leadingLeft) <= 1, `nested tree caret should overlay the leading slot: ${JSON.stringify(row)}`);
    if (row.expanded === 'true') {
      if (state === 'hover') {
        assert(row.disclosureOpacity >= 0.8, `hovered nested tree caret should be visible: ${JSON.stringify(row)}`);
        assert(row.iconOpacity <= 0.2, `hovered nested tree icon should yield to caret: ${JSON.stringify(row)}`);
      } else {
        assert(row.disclosureOpacity <= 0.2, `idle nested tree caret should stay quiet: ${JSON.stringify(row)}`);
        assert(row.iconOpacity >= 0.8, `idle nested tree icon should stay visible: ${JSON.stringify(row)}`);
      }
    } else {
      assert(row.disclosureOpacity === null || row.disclosureOpacity <= 0.2, `desktop leaf rows should not show a stray caret: ${JSON.stringify(row)}`);
      assert(row.iconOpacity >= 0.8, `desktop leaf rows should keep the page icon visible: ${JSON.stringify(row)}`);
    }
    assert(row.iconWidth >= 18 && row.iconWidth <= 22 && row.iconHeight >= 18 && row.iconHeight <= 22, `nested tree icon column drifted: ${JSON.stringify(row)}`);
    assert(Math.abs(row.iconCenterY - row.titleCenterY) <= 1.5, `nested tree icon/title vertical alignment drifted: ${JSON.stringify(row)}`);
    assert(row.titleContrast >= 4.5, `nested tree row title should stay readable against the sidebar surface: ${JSON.stringify(row)}`);
    assert(row.titleLeft - row.leadingRight >= 3 && row.titleLeft - row.leadingRight <= 6, `nested tree title/leading gap drifted: ${JSON.stringify(row)}`);
    assert(row.actionsRight === null || row.actionsRight <= row.rowRight + 1, `nested tree actions overflow row bounds: ${JSON.stringify(row)}`);
    assert(row.actionsPosition === null || row.actionsPosition === 'absolute', `nested tree row actions should be overlay affordances instead of reserving idle title width: ${JSON.stringify(row)}`);
    assert(
      state === 'hover' ||
        row.actionsOpacity === null ||
        row.actionsOpacity > 0.2 ||
        row.titlePaddingRight <= 1,
      `idle nested tree rows should not keep blank right padding for hidden .../+ controls: ${JSON.stringify(row)}`,
    );
    if (state === 'hover' && row.actionsOpacity !== null && row.actionsOpacity >= 0.8) {
      assert(row.titlePaddingRight >= 36, `hovered nested tree rows should reserve padding for visible .../+ controls: ${JSON.stringify(row)}`);
      assert(
        row.actionsLeft === null || row.titleRight - row.titlePaddingRight <= row.actionsLeft + 4,
        `hovered nested tree row title text should stop before the overlay .../+ controls: ${JSON.stringify(row)}`,
      );
      assert(row.actionsLeft === null || row.actionsLeft >= row.rowRight - 54, `hovered nested tree row actions should sit in a compact right overlay rail: ${JSON.stringify(row)}`);
    }
  }

  const childIndent = metrics.child.titleLeft - metrics.root.titleLeft;
  const siblingIndent = metrics.sibling.titleLeft - metrics.root.titleLeft;
  assert(childIndent >= 12 && childIndent <= 16, `nested child indent should use a compact Notion-style depth step, got ${childIndent}`);
  assert(Math.abs(siblingIndent) <= 1, `root-level sibling should align with root row, got ${siblingIndent}`);
}

async function assertKeyboardExpansion(page, seed) {
  const root = treeRow(page, seed.rootPageId);
  await root.focus({ timeout: options.timeoutMs });
  await expectFocusedTreeRow(page, seed.rootPageId);

  await root.press('ArrowRight', { timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'true');
  await treeRow(page, seed.childPageId).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  await root.press('ArrowRight', { timeout: options.timeoutMs });
  await expectFocusedTreeRow(page, seed.childPageId);

  await page.keyboard.press('ArrowLeft');
  await expectFocusedTreeRow(page, seed.rootPageId);

  await page.keyboard.press('End');
  await expectFocusedTreeEdge(page, 'last');
  await page.keyboard.press('Home');
  await expectFocusedTreeEdge(page, 'first');
}

async function assertActiveDescendantParentDisclosureManual(page, baseUrl, seed, opts = {}) {
  const existingRoot = privateTreeRow(page, seed.rootPageId);
  if (await existingRoot.isVisible({ timeout: 1000 }).catch(() => false)) {
    const expandedBeforeNavigation = await existingRoot.getAttribute('aria-expanded').catch(() => null);
    if (expandedBeforeNavigation === 'true') {
      await existingRoot.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
      await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
    }
  }
  await openPage(page, baseUrl, seed.childPageId, seed.childTitle);
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
  await expectTreeRowHidden(page, seed.childPageId);
  if (opts.assertShortcutIsolation) {
    await assertFavoriteShortcutStaysCollapsed(page, seed);
    await assertFavoriteShortcutExpansionDoesNotMirrorPrivate(page, seed);
  }
  if (opts.capture) {
    await captureActiveParentCollapseState(page, seed, 'not-forced-open-after-navigation');
  }

  const root = privateTreeRow(page, seed.rootPageId);
  await root.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'true');
  await privateTreeRow(page, seed.childPageId).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  if (opts.capture) {
    await captureActiveParentCollapseState(page, seed, 'manual-expanded-after-click');
  }

  await root.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
  await expectTreeRowHidden(page, seed.childPageId);
}

async function assertFavoriteShortcutStaysCollapsed(page, seed) {
  const favoritesTree = page.getByRole('tree', { name: 'Favorite pages' });
  await favoritesTree.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await favoritesTree.locator(`[data-tree-page-id="${seed.rootPageId}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectScopedTreeRowAttribute(page, 'Favorite pages', seed.rootPageId, 'aria-expanded', 'false');
  const favoriteChildCount = await favoritesTree.locator(`[data-tree-page-id="${seed.childPageId}"]`).count();
  assert(
    favoriteChildCount === 0,
    `favorite shortcut should stay collapsed when navigation opens an active descendant elsewhere, got ${favoriteChildCount} child rows`,
  );
}

async function assertFavoriteShortcutExpansionDoesNotMirrorPrivate(page, seed) {
  const favoritesTree = page.getByRole('tree', { name: 'Favorite pages' });
  const favoriteRoot = favoritesTree.locator(`[data-tree-page-id="${seed.rootPageId}"]`);
  await favoriteRoot.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
  await expectScopedTreeRowAttribute(page, 'Favorite pages', seed.rootPageId, 'aria-expanded', 'true');
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
  await favoritesTree.locator(`[data-tree-page-id="${seed.childPageId}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  await favoriteRoot.locator('[data-tree-disclosure="true"]').click({ timeout: options.timeoutMs });
  await expectScopedTreeRowAttribute(page, 'Favorite pages', seed.rootPageId, 'aria-expanded', 'false');
  await expectPrivateTreeRowAttribute(page, seed.rootPageId, 'aria-expanded', 'false');
  await expectTreeRowHidden(page, seed.childPageId);
}

async function captureActiveParentCollapseState(page, seed, label) {
  const state = await page.evaluate(({ rootPageId, childPageId }) => {
    const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
    const favoritesTree = document.querySelector('[role="tree"][aria-label="Favorite pages"]');
    const root = tree?.querySelector(`[data-tree-page-id="${CSS.escape(rootPageId)}"]`);
    const child = tree?.querySelector(`[data-tree-page-id="${CSS.escape(childPageId)}"]`);
    const favoriteRoot = favoritesTree?.querySelector(`[data-tree-page-id="${CSS.escape(rootPageId)}"]`);
    const favoriteChild = favoritesTree?.querySelector(`[data-tree-page-id="${CSS.escape(childPageId)}"]`);
    const disclosure = root?.querySelector('[data-tree-disclosure="true"]');
    const favoriteDisclosure = favoriteRoot?.querySelector('[data-tree-disclosure="true"]');
    const readRect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return {
      rootExpanded: root?.getAttribute('aria-expanded') ?? null,
      rootVisible: root instanceof HTMLElement && root.offsetParent !== null,
      childVisible: child instanceof HTMLElement && child.offsetParent !== null,
      childExists: child instanceof HTMLElement,
      disclosureExpanded: disclosure instanceof HTMLElement ? disclosure.getAttribute('aria-expanded') : null,
      favoriteExpanded: favoriteRoot?.getAttribute('aria-expanded') ?? null,
      favoriteChildVisible: favoriteChild instanceof HTMLElement && favoriteChild.offsetParent !== null,
      favoriteDisclosureExpanded:
        favoriteDisclosure instanceof HTMLElement ? favoriteDisclosure.getAttribute('aria-expanded') : null,
      rootRect: readRect(root),
      childRect: readRect(child),
      favoriteRootRect: readRect(favoriteRoot),
      favoriteChildRect: readRect(favoriteChild),
    };
  }, { rootPageId: seed.rootPageId, childPageId: seed.childPageId });
  writeJsonArtifact(`desktop-active-parent-${label}.json`, state);
  await page.screenshot({
    path: join(options.screenshotDir, `desktop-active-parent-${label}.png`),
    fullPage: false,
  });
}

async function assertKeyboardOpen(page, seed) {
  const root = treeRow(page, seed.rootPageId);
  await root.focus({ timeout: options.timeoutMs });
  await root.press('ArrowRight', { timeout: options.timeoutMs });
  await root.press('ArrowRight', { timeout: options.timeoutMs });
  await expectFocusedTreeRow(page, seed.childPageId);

  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (pageId) => window.location.pathname === `/p/${pageId}`,
    seed.childPageId,
    { timeout: options.timeoutMs },
  );
  await expectPageTitle(page, seed.childTitle);
  await expectTreeRowAttribute(page, seed.childPageId, 'aria-current', 'page');
}

async function assertTreeMenuActions(page, baseUrl, seed) {
  const renamedTitle = `${seed.siblingTitle} renamed`;
  await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
  await setTheme(page, 'dark');

  let menu = await openTreePageMenu(page, seed.siblingPageId);
  await assertTreeMenuTrashActionVisible(page, menu, 'desktop-dark-tree-page-menu-actions');
  await menu.getByRole('menuitem', { name: /^Rename/ }).click({ timeout: options.timeoutMs });
  const renameInput = page.locator('input[aria-label^="Rename "]');
  await renameInput.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await renameInput.fill(renamedTitle, { timeout: options.timeoutMs });
  await renameInput.press('Enter', { timeout: options.timeoutMs });
  await expectTreeRowTitle(page, seed.siblingPageId, renamedTitle);
  await waitForPageState(baseUrl, seed, seed.siblingPageId, (item) => item?.title === renamedTitle, 'renamed tree page');
  seed.siblingTitle = renamedTitle;

  menu = await openTreePageMenu(page, seed.siblingPageId);
  await menu.getByRole('menuitem', { name: /^Duplicate/ }).click({ timeout: options.timeoutMs });
  const duplicateTitle = `${renamedTitle} copy`;
  const duplicate = await waitForDuplicatedTreePage(baseUrl, seed, duplicateTitle);
  const duplicatePageId = duplicate.id;
  seed.menuDuplicatePageId = duplicatePageId;
  await openPage(page, baseUrl, duplicatePageId, duplicateTitle);
  await treeRow(page, duplicatePageId).waitFor({ state: 'visible', timeout: options.timeoutMs });

  menu = await openTreePageMenu(page, duplicatePageId);
  await menu.getByRole('menuitem', { name: /^Move to Trash/ }).click({ timeout: options.timeoutMs });
  await waitForPageState(
    baseUrl,
    seed,
    duplicatePageId,
    (item) => !!item?.inTrash,
    'trashed duplicated tree page',
    { includeTrash: true },
  );
  await waitForPageRouteToChangeAway(page, duplicatePageId);
  await expectTreeRowHidden(page, duplicatePageId);
}

async function assertTreeMenuTrashActionVisible(page, menu, artifactName) {
  const metrics = await menu.evaluate((node) => {
    const menuRect = node.getBoundingClientRect();
    const items = Array.from(node.querySelectorAll('[data-menu-item]'))
      .filter((item) => item instanceof HTMLElement && item.getAttribute('role') === 'menuitem')
      .map((item, index) => {
        const rect = item.getBoundingClientRect();
        return {
          index,
          text: item.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          rect: {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
          },
        };
      });
    const find = (label) => items.find((item) => item.text.startsWith(label)) ?? null;
    const findMoveTo = () =>
      items.find((item) => item.text.startsWith('Move to') && !item.text.startsWith('Move to Trash')) ?? null;
    return {
      menu: {
        top: Math.round(menuRect.top),
        bottom: Math.round(menuRect.bottom),
        height: Math.round(menuRect.height),
        scrollTop: Math.round(node.scrollTop),
      },
      items,
      duplicate: find('Duplicate'),
      moveTo: findMoveTo(),
      trash: find('Move to Trash'),
      copyLink: find('Copy link'),
      exportMarkdown: find('Export as Markdown'),
    };
  });
  writeJsonArtifact(`${artifactName}.json`, metrics);
  await page.screenshot({
    path: join(options.screenshotDir, `${artifactName}.png`),
    fullPage: false,
  });
  assert(metrics.trash, `tree page menu should expose Move to Trash: ${JSON.stringify(metrics)}`);
  assert(metrics.duplicate, `tree page menu should expose Duplicate before trash: ${JSON.stringify(metrics)}`);
  assert(metrics.moveTo, `tree page menu should expose Move to near trash: ${JSON.stringify(metrics)}`);
  assert(metrics.copyLink, `tree page menu should expose Copy link after trash: ${JSON.stringify(metrics)}`);
  assert(
    metrics.trash.index > metrics.moveTo.index && metrics.trash.index < metrics.copyLink.index,
    `tree page menu trash should sit in the primary page-action group after Move to and before Copy link: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.trash.rect.top >= metrics.menu.top - 1 && metrics.trash.rect.bottom <= metrics.menu.bottom + 1,
    `tree page menu trash should be visible without scrolling: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.menu.scrollTop <= 1,
    `tree page menu should not need initial scrolling to expose Move to Trash: ${JSON.stringify(metrics)}`,
  );
}

async function assertTreeDragAndDrop(page, baseUrl, seed) {
  await setRootPageOrder(baseUrl, seed, [seed.rootPageId, seed.siblingPageId], 'initial root/sibling tree fixture order');
  await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
  await ensureTreeExpanded(page, seed.rootPageId);
  await expectTreeLevelRelativeOrder(page, 1, [seed.rootPageId, seed.siblingPageId]);

  await dragTreePage(page, seed.siblingPageId, seed.rootPageId, 'inside');
  await treeRow(page, seed.siblingPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, seed.siblingPageId, 'aria-level', '2');
  await expectTreeLevelRelativeOrder(page, 2, [seed.childPageId, seed.siblingPageId]);
  await waitForPageState(
    baseUrl,
    seed,
    seed.siblingPageId,
    (item) =>
      !!item &&
      item.parentId === seed.rootPageId &&
      item.parentType === 'page' &&
      !item.inTrash,
    'tree page dragged inside another page',
  );

  await dragTreePage(page, seed.siblingPageId, seed.rootPageId, 'after');
  await treeRow(page, seed.siblingPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, seed.siblingPageId, 'aria-level', '1');
  await expectTreeLevelRelativeOrder(page, 1, [seed.rootPageId, seed.siblingPageId]);
  await waitForPageState(
    baseUrl,
    seed,
    seed.siblingPageId,
    (item) =>
      !!item &&
      (item.parentId ?? null) === null &&
      (item.parentType ?? 'workspace') === 'workspace' &&
      !item.inTrash,
    'tree page dragged back to root',
  );
  await waitForRelativePageOrder(baseUrl, seed, [seed.rootPageId, seed.siblingPageId], 'root page restored after inside drag');

  await dragTreePage(page, seed.siblingPageId, seed.rootPageId, 'before');
  await treeRow(page, seed.siblingPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeLevelRelativeOrder(page, 1, [seed.siblingPageId, seed.rootPageId]);
  await waitForRelativePageOrder(baseUrl, seed, [seed.siblingPageId, seed.rootPageId], 'root page reordered before target');

  await dragTreePage(page, seed.siblingPageId, seed.rootPageId, 'after');
  await treeRow(page, seed.siblingPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeLevelRelativeOrder(page, 1, [seed.rootPageId, seed.siblingPageId]);
  await waitForRelativePageOrder(baseUrl, seed, [seed.rootPageId, seed.siblingPageId], 'root page reordered back after target');

  await ensureTreeExpanded(page, seed.rootPageId);
  await dragTreePage(page, seed.childPageId, seed.siblingPageId, 'after');
  await treeRow(page, seed.childPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, seed.childPageId, 'aria-level', '1');
  await expectTreeLevelRelativeOrder(page, 1, [seed.rootPageId, seed.siblingPageId, seed.childPageId]);
  await waitForPageState(
    baseUrl,
    seed,
    seed.childPageId,
    (item) =>
      !!item &&
      (item.parentId ?? null) === null &&
      (item.parentType ?? 'workspace') === 'workspace' &&
      !item.inTrash,
    'nested child dragged out to root',
  );
  await waitForRelativePageOrder(
    baseUrl,
    seed,
    [seed.rootPageId, seed.siblingPageId, seed.childPageId],
    'nested child reordered at root',
  );

  await dragTreePage(page, seed.childPageId, seed.rootPageId, 'inside');
  await treeRow(page, seed.childPageId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, seed.childPageId, 'aria-level', '2');
  await expectTreeLevelRelativeOrder(page, 2, [seed.childPageId]);
  await waitForPageState(
    baseUrl,
    seed,
    seed.childPageId,
    (item) =>
      !!item &&
      item.parentId === seed.rootPageId &&
      item.parentType === 'page' &&
      !item.inTrash,
    'nested child dragged back inside parent',
  );

  const copyTitle = `${seed.siblingTitle} copy`;
  await dragTreePage(page, seed.siblingPageId, seed.rootPageId, 'inside', { copy: true });
  const copied = await waitForDuplicatedTreePage(baseUrl, seed, copyTitle, {
    parentId: seed.rootPageId,
    parentType: 'page',
  });
  seed.dragCopyPageId = copied.id;
  await treeRow(page, copied.id).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, copied.id, 'aria-level', '2');
  await expectTreeLevelRelativeOrder(page, 1, [seed.rootPageId, seed.siblingPageId]);
  await waitForPageState(
    baseUrl,
    seed,
    seed.siblingPageId,
    (item) =>
      !!item &&
      (item.parentId ?? null) === null &&
      (item.parentType ?? 'workspace') === 'workspace' &&
      !item.inTrash,
    'drag-copy source page kept at root',
  );
  await waitForPageState(
    baseUrl,
    seed,
    copied.id,
    (item) =>
      !!item &&
      item.title === copyTitle &&
      item.parentId === seed.rootPageId &&
      item.parentType === 'page' &&
      !item.inTrash,
    'drag-copied page persisted inside target',
  );

  const childCopyTitle = `${seed.childTitle} copy`;
  await dragTreePageToPrivateRoot(page, seed.childPageId, { copy: true });
  const rootChildCopy = await waitForDuplicatedTreePage(baseUrl, seed, childCopyTitle, {
    parentId: null,
    parentType: 'workspace',
  });
  seed.privateRootPageCopyId = rootChildCopy.id;
  await treeRow(page, rootChildCopy.id).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, rootChildCopy.id, 'aria-level', '1');
  await waitForPageState(
    baseUrl,
    seed,
    seed.childPageId,
    (item) =>
      !!item &&
      item.parentId === seed.rootPageId &&
      item.parentType === 'page' &&
      !item.inTrash,
    'private-root page copy kept source child inside parent',
  );
  await waitForPageState(
    baseUrl,
    seed,
    rootChildCopy.id,
    (item) =>
      !!item &&
      item.title === childCopyTitle &&
      (item.parentId ?? null) === null &&
      (item.parentType ?? 'workspace') === 'workspace' &&
      !item.inTrash,
    'private-root page copy persisted at workspace root',
  );

  await dragTreePageToPrivateRoot(page, copied.id);
  await treeRow(page, copied.id).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectTreeRowAttribute(page, copied.id, 'aria-level', '1');
  await waitForPageState(
    baseUrl,
    seed,
    copied.id,
    (item) =>
      !!item &&
      item.title === copyTitle &&
      (item.parentId ?? null) === null &&
      (item.parentType ?? 'workspace') === 'workspace' &&
      !item.inTrash,
    'private-root page move persisted at workspace root',
  );
  await waitForRelativePageOrder(
    baseUrl,
    seed,
    [seed.rootPageId, seed.siblingPageId, rootChildCopy.id, copied.id],
    'private-root page drops appended root pages',
  );
  await expectTreeLevelRelativeOrder(page, 1, [seed.rootPageId, seed.siblingPageId, rootChildCopy.id, copied.id]);
}

async function assertBlockDropIntoPageTree(page, baseUrl, seed) {
  const { moveBlockId, copyBlockId } = seed.blockIds;
  await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
  await ensureTreeExpanded(page, seed.rootPageId);
  await blockGroup(page, moveBlockId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await blockGroup(page, copyBlockId).waitFor({ state: 'visible', timeout: options.timeoutMs });

  await dragBlockToTreePage(page, moveBlockId, seed.rootPageId);
  await expectBlockHidden(page, moveBlockId);
  await waitForBlockList(
    baseUrl,
    seed,
    seed.siblingPageId,
    (blocks) => !blocks.some((block) => block.id === moveBlockId),
    'moved block removed from source page',
  );
  await waitForBlockList(
    baseUrl,
    seed,
    seed.rootPageId,
    (blocks) => blocks.some((block) => block.id === moveBlockId && block.pageId === seed.rootPageId),
    'moved block persisted on target tree page',
  );

  await dragBlockToTreePage(page, copyBlockId, seed.rootPageId, { copy: true });
  await blockGroup(page, copyBlockId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await waitForBlockList(
    baseUrl,
    seed,
    seed.siblingPageId,
    (blocks) => blocks.some((block) => block.id === copyBlockId && block.pageId === seed.siblingPageId),
    'copied block source kept on source page',
  );
  const copiedBlock = await waitForBlockList(
    baseUrl,
    seed,
    seed.rootPageId,
    (blocks) =>
      blocks.find(
        (block) =>
          block.id !== copyBlockId &&
          block.pageId === seed.rootPageId &&
          block.plainText === seed.blockText.copy,
      ) ?? false,
    'copied block persisted on target tree page',
  );
  seed.dragCopiedBlockId = copiedBlock.id;
}

async function assertBlockDropToPrivateRoot(page, baseUrl, seed) {
  const { rootMoveBlockId, rootCopyBlockId } = seed.blockIds;
  await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
  await blockGroup(page, rootMoveBlockId).waitFor({ state: 'visible', timeout: options.timeoutMs });

  await dragBlockToPrivateRoot(page, rootMoveBlockId);
  const movedPage = await waitForPageByTitle(
    baseUrl,
    seed,
    seed.blockText.rootMove,
    'block moved to private root as a new page',
  );
  seed.privateRootMovePageId = movedPage.id;
  await waitForCurrentPage(page, movedPage.id, seed.blockText.rootMove);
  await waitForBlockList(
    baseUrl,
    seed,
    seed.siblingPageId,
    (blocks) => !blocks.some((block) => block.id === rootMoveBlockId),
    'private-root moved block removed from source page',
  );

  await openPage(page, baseUrl, seed.siblingPageId, seed.siblingTitle);
  await blockGroup(page, rootCopyBlockId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dragBlockToPrivateRoot(page, rootCopyBlockId, { copy: true });
  const copiedPage = await waitForPageByTitle(
    baseUrl,
    seed,
    seed.blockText.rootCopy,
    'block copied to private root as a new page',
    { excludeIds: [movedPage.id] },
  );
  seed.privateRootCopyPageId = copiedPage.id;
  await waitForCurrentPage(page, copiedPage.id, seed.blockText.rootCopy);
  await waitForBlockList(
    baseUrl,
    seed,
    seed.siblingPageId,
    (blocks) => blocks.some((block) => block.id === rootCopyBlockId && block.pageId === seed.siblingPageId),
    'private-root copied block kept on source page',
  );
}

async function dragTreePage(page, sourcePageId, targetPageId, placement, opts = {}) {
  const sourceRow = treeRow(page, sourcePageId);
  const targetRow = treeRow(page, targetPageId);
  await sourceRow.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await targetRow.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const copy = !!opts.copy;
  const result = await page.evaluate(
    ({ sourcePageId, targetPageId, placement, copy, dragType }) => {
      const source = document.querySelector(`[data-tree-page-id="${CSS.escape(sourcePageId)}"]`);
      const target = document.querySelector(`[data-tree-page-id="${CSS.escape(targetPageId)}"]`);
      if (!(source instanceof HTMLElement)) {
        return { ok: false, reason: `missing source tree row ${sourcePageId}` };
      }
      if (!(target instanceof HTMLElement)) {
        return { ok: false, reason: `missing target tree row ${targetPageId}` };
      }

      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return { ok: false, reason: `target tree row ${targetPageId} has no layout box` };
      }
      const clientX = Math.min(rect.right - 4, Math.max(rect.left + 16, rect.left + rect.width * 0.2));
      const clientY =
        placement === 'inside'
          ? rect.top + rect.height / 2
          : placement === 'before'
            ? rect.top + 2
            : rect.bottom - 2;
      const dataTransfer = new DataTransfer();
      dataTransfer.effectAllowed = 'copyMove';
      dataTransfer.dropEffect = copy ? 'copy' : 'move';
      dataTransfer.setData(dragType, sourcePageId);
      dataTransfer.setData('text/plain', sourcePageId);

      const dispatchDragEvent = (element, type) =>
        element.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX,
            clientY,
            altKey: copy,
            dataTransfer,
          }),
        );

      dispatchDragEvent(source, 'dragstart');
      dispatchDragEvent(target, 'dragenter');
      dispatchDragEvent(target, 'dragover');
      const dropped = dispatchDragEvent(target, 'drop');
      dispatchDragEvent(source, 'dragend');
      return { ok: true, dropped };
    },
    { sourcePageId, targetPageId, placement, copy, dragType: PAGE_DRAG_TYPE },
  );
  assert(result?.ok, `tree drag event dispatch failed: ${JSON.stringify(result)}`);
}

async function dragTreePageToPrivateRoot(page, sourcePageId, opts = {}) {
  const sourceRow = treeRow(page, sourcePageId);
  await sourceRow.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const copy = !!opts.copy;
  const result = await page.evaluate(
    ({ sourcePageId, copy, dragType }) => {
      const source = document.querySelector(`[data-tree-page-id="${CSS.escape(sourcePageId)}"]`);
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const target = tree?.parentElement;
      if (!(source instanceof HTMLElement)) {
        return { ok: false, reason: `missing source tree row ${sourcePageId}` };
      }
      if (!(target instanceof HTMLElement)) {
        return { ok: false, reason: 'missing private root drop area' };
      }

      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return { ok: false, reason: 'private root drop area has no layout box' };
      }
      const clientX = Math.min(rect.right - 12, Math.max(rect.left + 24, rect.left + rect.width / 2));
      const clientY = Math.max(rect.top + 8, rect.bottom - 8);
      const dataTransfer = new DataTransfer();
      dataTransfer.effectAllowed = 'copyMove';
      dataTransfer.dropEffect = copy ? 'copy' : 'move';
      dataTransfer.setData(dragType, sourcePageId);
      dataTransfer.setData('text/plain', sourcePageId);

      const dispatchDragEvent = (element, type) =>
        element.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX,
            clientY,
            altKey: copy,
            dataTransfer,
          }),
        );

      dispatchDragEvent(source, 'dragstart');
      dispatchDragEvent(target, 'dragenter');
      dispatchDragEvent(target, 'dragover');
      const dropped = dispatchDragEvent(target, 'drop');
      dispatchDragEvent(source, 'dragend');
      return { ok: true, dropped };
    },
    { sourcePageId, copy, dragType: PAGE_DRAG_TYPE },
  );
  assert(result?.ok, `tree-to-private-root drag event dispatch failed: ${JSON.stringify(result)}`);
}

async function dragBlockToTreePage(page, blockId, targetPageId, opts = {}) {
  const sourceBlock = blockGroup(page, blockId);
  const targetRow = treeRow(page, targetPageId);
  await sourceBlock.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await targetRow.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const copy = !!opts.copy;
  const result = await page.evaluate(
    ({ blockId, targetPageId, copy, blockDragType, blockDragIdsType }) => {
      const source = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      const target = document.querySelector(`[data-tree-page-id="${CSS.escape(targetPageId)}"]`);
      if (!(source instanceof HTMLElement)) {
        return { ok: false, reason: `missing source block ${blockId}` };
      }
      if (!(target instanceof HTMLElement)) {
        return { ok: false, reason: `missing target tree row ${targetPageId}` };
      }

      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return { ok: false, reason: `target tree row ${targetPageId} has no layout box` };
      }
      const clientX = Math.min(rect.right - 4, Math.max(rect.left + 16, rect.left + rect.width * 0.2));
      const clientY = rect.top + rect.height / 2;
      const dataTransfer = new DataTransfer();
      dataTransfer.effectAllowed = 'copyMove';
      dataTransfer.dropEffect = copy ? 'copy' : 'move';
      dataTransfer.setData(blockDragType, blockId);
      dataTransfer.setData(blockDragIdsType, JSON.stringify([blockId]));

      const dispatchDragEvent = (element, type) =>
        element.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX,
            clientY,
            altKey: copy,
            dataTransfer,
          }),
        );

      dispatchDragEvent(source, 'dragstart');
      dispatchDragEvent(target, 'dragenter');
      dispatchDragEvent(target, 'dragover');
      const dropped = dispatchDragEvent(target, 'drop');
      dispatchDragEvent(source, 'dragend');
      return { ok: true, dropped };
    },
    {
      blockId,
      targetPageId,
      copy,
      blockDragType: BLOCK_DRAG_TYPE,
      blockDragIdsType: BLOCK_DRAG_IDS_TYPE,
    },
  );
  assert(result?.ok, `block-to-tree drag event dispatch failed: ${JSON.stringify(result)}`);
}

async function dragBlockToPrivateRoot(page, blockId, opts = {}) {
  const sourceBlock = blockGroup(page, blockId);
  await sourceBlock.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const copy = !!opts.copy;
  const result = await page.evaluate(
    ({ blockId, copy, blockDragType, blockDragIdsType }) => {
      const source = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const target = tree?.parentElement;
      if (!(source instanceof HTMLElement)) {
        return { ok: false, reason: `missing source block ${blockId}` };
      }
      if (!(target instanceof HTMLElement)) {
        return { ok: false, reason: 'missing private root drop area' };
      }

      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return { ok: false, reason: 'private root drop area has no layout box' };
      }
      const clientX = Math.min(rect.right - 12, Math.max(rect.left + 24, rect.left + rect.width / 2));
      const clientY = Math.max(rect.top + 8, rect.bottom - 8);
      const dataTransfer = new DataTransfer();
      dataTransfer.effectAllowed = 'copyMove';
      dataTransfer.dropEffect = copy ? 'copy' : 'move';
      dataTransfer.setData(blockDragType, blockId);
      dataTransfer.setData(blockDragIdsType, JSON.stringify([blockId]));

      const dispatchDragEvent = (element, type) =>
        element.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX,
            clientY,
            altKey: copy,
            dataTransfer,
          }),
        );

      dispatchDragEvent(source, 'dragstart');
      dispatchDragEvent(target, 'dragenter');
      dispatchDragEvent(target, 'dragover');
      const dropped = dispatchDragEvent(target, 'drop');
      dispatchDragEvent(source, 'dragend');
      return { ok: true, dropped };
    },
    {
      blockId,
      copy,
      blockDragType: BLOCK_DRAG_TYPE,
      blockDragIdsType: BLOCK_DRAG_IDS_TYPE,
    },
  );
  assert(result?.ok, `block-to-private-root drag event dispatch failed: ${JSON.stringify(result)}`);
}

async function ensureTreeExpanded(page, pageId) {
  const row = treeRow(page, pageId);
  await row.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const expanded = await row.getAttribute('aria-expanded', { timeout: options.timeoutMs });
  if (expanded !== 'true') {
    await row.press('ArrowRight', { timeout: options.timeoutMs });
  }
  await expectTreeRowAttribute(page, pageId, 'aria-expanded', 'true');
}

async function ensurePrivateTreeExpanded(page, pageId) {
  const row = privateTreeRow(page, pageId);
  await row.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const expanded = await row.getAttribute('aria-expanded', { timeout: options.timeoutMs });
  if (expanded !== 'true') {
    await row.press('ArrowRight', { timeout: options.timeoutMs });
  }
  await expectPrivateTreeRowAttribute(page, pageId, 'aria-expanded', 'true');
}

async function waitForDuplicatedTreePage(baseUrl, seed, duplicateTitle, opts = {}) {
  const startedAt = Date.now();
  let lastMatches = [];
  const expectedParentId = Object.hasOwn(opts, 'parentId') ? opts.parentId : null;
  const expectedParentType = opts.parentType ?? (expectedParentId === null ? 'workspace' : 'page');
  const excludedIds = new Set([seed.siblingPageId, ...(opts.excludeIds ?? [])]);

  while (Date.now() - startedAt < options.timeoutMs) {
    const pages = await fetchWorkspacePages(baseUrl, seed);
    lastMatches = pages.filter(
      (candidate) =>
        !excludedIds.has(candidate.id) &&
        candidate.title === duplicateTitle &&
        !candidate.inTrash &&
        (candidate.parentId ?? null) === expectedParentId &&
        (candidate.parentType ?? 'workspace') === expectedParentType,
    );
    if (lastMatches.length === 1) return lastMatches[0];
    await delay(250);
  }

  throw new Error(`duplicated tree page was not persisted; matches=${JSON.stringify(lastMatches)}`);
}

async function waitForCurrentPageId(page) {
  const handle = await page.waitForFunction(
    () => {
      const match = window.location.pathname.match(/^\/p\/([^/]+)$/);
      return match?.[1] ?? null;
    },
    undefined,
    { timeout: options.timeoutMs },
  );
  const pageId = await handle.jsonValue();
  assert(typeof pageId === 'string' && pageId, 'new page route must include a page id');
  return pageId;
}

async function waitForPageRouteToChangeAway(page, pageId) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < options.timeoutMs) {
    last = await page.evaluate(() => ({
      href: window.location.href,
      pathname: window.location.pathname,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 500),
    }));
    const match = last.pathname.match(/^\/p\/([^/?#]+)/);
    const currentPageId = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (currentPageId !== pageId && !last.bodyText.includes('This page is in Trash.')) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting to leave trashed page ${pageId}; last=${JSON.stringify(last)}`);
}

async function waitForCurrentPage(page, pageId, title) {
  await page.waitForFunction(
    (id) => window.location.pathname === `/p/${id}`,
    pageId,
    { timeout: options.timeoutMs },
  );
  await expectPageTitle(page, title);
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

function treeRow(page, pageId) {
  return page.locator(`[data-tree-page-id="${pageId}"]`);
}

function privateTreeRow(page, pageId) {
  return page.locator('[role="tree"][aria-label="Pages"]').locator(`[data-tree-page-id="${pageId}"]`);
}

async function clearTreeHoverAndFocus(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
}

async function treeDisclosureOpacity(page, pageId) {
  const result = await page.evaluate((id) => {
    const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
    const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
    const disclosure = row?.querySelector('[data-tree-disclosure="true"]');
    if (!(disclosure instanceof HTMLElement)) return { ok: false, reason: `missing disclosure for ${id}` };
    return { ok: true, opacity: Number.parseFloat(getComputedStyle(disclosure).opacity) };
  }, pageId);
  assert(result?.ok, result?.reason ?? `missing disclosure for ${pageId}`);
  assert(Number.isFinite(result.opacity), `invalid disclosure opacity for ${pageId}: ${JSON.stringify(result)}`);
  return result.opacity;
}

async function treeIconOpacity(page, pageId) {
  const result = await page.evaluate((id) => {
    const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
    const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
    const icon = row?.querySelector('[data-tree-icon="true"]');
    if (!(icon instanceof HTMLElement)) return { ok: false, reason: `missing icon for ${id}` };
    return { ok: true, opacity: Number.parseFloat(getComputedStyle(icon).opacity) };
  }, pageId);
  assert(result?.ok, result?.reason ?? `missing icon for ${pageId}`);
  assert(Number.isFinite(result.opacity), `invalid icon opacity for ${pageId}: ${JSON.stringify(result)}`);
  return result.opacity;
}

async function treeActionsOpacity(page, pageId) {
  const result = await page.evaluate((id) => {
    const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
    const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
    const actions = row?.querySelector('button[aria-label^="Open page actions"]')?.parentElement;
    if (!(actions instanceof HTMLElement)) return { ok: false, reason: `missing actions for ${id}` };
    return { ok: true, opacity: Number.parseFloat(getComputedStyle(actions).opacity) };
  }, pageId);
  assert(result?.ok, result?.reason ?? `missing actions for ${pageId}`);
  assert(Number.isFinite(result.opacity), `invalid actions opacity for ${pageId}: ${JSON.stringify(result)}`);
  return result.opacity;
}

async function waitForTreeDisclosureOpacity(page, pageId, minOpacity) {
  return waitForTreePartOpacity(page, pageId, {
    part: 'disclosure',
    selector: '[data-tree-disclosure="true"]',
    targetOpacity: minOpacity,
    direction: 'above',
  });
}

async function waitForTreeIconOpacity(page, pageId, targetOpacity, direction = 'above') {
  return waitForTreePartOpacity(page, pageId, {
    part: 'icon',
    selector: '[data-tree-icon="true"]',
    targetOpacity,
    direction,
  });
}

async function waitForTreeActionsOpacity(page, pageId, minOpacity) {
  return waitForTreePartOpacity(page, pageId, {
    part: 'actions',
    selector: 'button[aria-label^="Open page actions"]',
    targetOpacity: minOpacity,
    direction: 'above',
    parent: true,
  });
}

async function waitForTreePartOpacity(page, pageId, { part, selector, targetOpacity, direction, parent = false }) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < options.timeoutMs) {
    last = await page.evaluate(
      ({ id, selector: partSelector, parent: useParent }) => {
        const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
        const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
        const raw = row?.querySelector(partSelector);
        const element = useParent ? raw?.parentElement : raw;
        if (!(row instanceof HTMLElement)) return { ok: false, reason: `missing row ${id}` };
        if (!(element instanceof HTMLElement)) return { ok: false, reason: `missing ${partSelector} for ${id}` };
        const opacity = Number.parseFloat(getComputedStyle(element).opacity);
        return {
          ok: true,
          opacity,
          rowHovered: row.matches(':hover'),
          rowFocused: row.matches(':focus-visible') || row.matches(':focus-within'),
          rowRect: row.getBoundingClientRect().toJSON(),
          elementRect: element.getBoundingClientRect().toJSON(),
        };
      },
      { id: pageId, selector, parent },
    );
    if (last?.ok && Number.isFinite(last.opacity)) {
      if (direction === 'below' ? last.opacity <= targetOpacity : last.opacity >= targetOpacity) {
        return last.opacity;
      }
    }
    await page.waitForTimeout(80);
  }
  throw new Error(
    `timed out waiting for tree ${part} opacity to be ${direction === 'below' ? '<=' : '>='} ${targetOpacity} for ${pageId}; last=${JSON.stringify(last)}`,
  );
}

function blockGroup(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

async function openTreePageMenu(page, pageId) {
  const row = treeRow(page, pageId);
  await row.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await row.focus({ timeout: options.timeoutMs });
  await row.press('Shift+F10', { timeout: options.timeoutMs });
  const menu = page.getByRole('menu', { name: /^Page actions for / });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return menu;
}

async function expectTreeRowTitle(page, pageId, title) {
  await page.waitForFunction(
    ([id, expected]) => {
      const row = document.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
      if (!(row instanceof HTMLElement)) return false;
      const label = row.getAttribute('aria-label') ?? '';
      const text = row.textContent ?? '';
      return label === expected || text.includes(expected);
    },
    [pageId, title],
    { timeout: options.timeoutMs },
  );
}

async function expectTreeLevelRelativeOrder(page, level, expectedPageIds) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < options.timeoutMs) {
    last = await page.evaluate(
      ([targetLevel, ids]) => {
      const expected = Array.isArray(ids) ? ids : [];
      const expectedSet = new Set(expected);
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
        if (!tree) return { ok: false, reason: 'missing private pages tree' };
      const actual = Array.from(tree.querySelectorAll('[data-page-tree-item="true"]'))
        .filter((row) => row instanceof HTMLElement && row.offsetParent !== null)
        .filter((row) => row.getAttribute('aria-level') === String(targetLevel))
          .map((row) => ({
            id: row.getAttribute('data-tree-page-id'),
            label: row.getAttribute('aria-label'),
            text: row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          }));
        const filtered = actual.map((row) => row.id).filter((id) => typeof id === 'string' && expectedSet.has(id));
        return {
          ok: filtered.length === expected.length && expected.every((id, index) => filtered[index] === id),
          expected,
          actual,
          filtered,
          level: targetLevel,
        };
      },
      [level, expectedPageIds],
    );
    if (last?.ok) return;
    await page.waitForTimeout(120);
  }

  throw new Error(`tree level ${level} order mismatch: ${JSON.stringify(last)}`);
}

async function expectButtonDisabled(locator) {
  await locator.waitFor({ state: 'attached', timeout: options.timeoutMs });
  const disabled = await locator.isDisabled({ timeout: options.timeoutMs });
  assert(disabled, 'expected button to be disabled');
}

async function expectButtonDisabledOrHidden(locator) {
  const count = await locator.count();
  if (count === 0) return;
  const button = locator.first();
  const visible = await button.isVisible({ timeout: options.timeoutMs }).catch(() => false);
  if (!visible) return;
  await expectButtonDisabled(button);
}

async function expectLocatorHidden(locator) {
  const count = await locator.count();
  if (count === 0) return;
  await locator.first().waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function expectBlockHidden(page, blockId) {
  await page.waitForFunction(
    (id) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      if (!block) return true;
      return block instanceof HTMLElement && block.offsetParent === null;
    },
    blockId,
    { timeout: options.timeoutMs },
  );
}

async function expectTreeRowNotDraggable(page, pageId) {
  const result = await page.evaluate((id) => {
    const row = document.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
    if (!(row instanceof HTMLElement)) return { found: false };
    return {
      found: true,
      draggable: row.draggable,
      attr: row.getAttribute('draggable'),
    };
  }, pageId);
  assert(result?.found, `tree row ${pageId} must be visible before checking draggable state`);
  assert(result.draggable === false, `view-only tree row must not be draggable: ${JSON.stringify(result)}`);
}

async function expectTreeRowAttribute(page, pageId, name, value) {
  await page.waitForFunction(
    ([id, attr, expected]) => {
      const row = document.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
      return row?.getAttribute(attr) === expected;
    },
    [pageId, name, value],
    { timeout: options.timeoutMs },
  );
}

async function expectPrivateTreeRowAttribute(page, pageId, name, value) {
  await page.waitForFunction(
    ([id, attr, expected]) => {
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
      return (row?.getAttribute(attr) ?? null) === expected;
    },
    [pageId, name, value],
    { timeout: options.timeoutMs },
  );
}

async function expectScopedTreeRowAttribute(page, treeLabel, pageId, name, value) {
  await page.waitForFunction(
    ([label, id, attr, expected]) => {
      const tree = Array.from(document.querySelectorAll('[role="tree"]'))
        .find((node) => node.getAttribute('aria-label') === label);
      const row = tree?.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
      return (row?.getAttribute(attr) ?? null) === expected;
    },
    [treeLabel, pageId, name, value],
    { timeout: options.timeoutMs },
  );
}

async function expectTreeRowHidden(page, pageId) {
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`[data-tree-page-id="${CSS.escape(id)}"]`);
      if (!row) return true;
      return row instanceof HTMLElement && row.offsetParent === null;
    },
    pageId,
    { timeout: options.timeoutMs },
  );
}

async function expectFocusedTreeRow(page, pageId) {
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute('data-tree-page-id') === id,
    pageId,
    { timeout: options.timeoutMs },
  );
}

async function expectFocusedTreeEdge(page, edge) {
  await page.waitForFunction(
    (targetEdge) => {
      const tree = document.querySelector('[role="tree"][aria-label="Pages"]');
      if (!tree) return false;
      const rows = Array.from(tree.querySelectorAll('[data-page-tree-item="true"]'))
        .filter((row) => row instanceof HTMLElement && row.offsetParent !== null);
      const target = targetEdge === 'first' ? rows[0] : rows[rows.length - 1];
      return !!target && document.activeElement === target;
    },
    edge,
    { timeout: options.timeoutMs },
  );
}

async function seedPageTree(baseUrl) {
  const session = await signIn(baseUrl);
  const viewOnlySession = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for page tree UI smoke');

  const suffix = Date.now();
  const rootPageId = randomUUID();
  const childPageId = randomUUID();
  const childDatabaseId = randomUUID();
  const siblingPageId = randomUUID();
  const favoritePageId = randomUUID();
  const sharedPageId = randomUUID();
  const sharedChildPageId = randomUUID();
  const blockIds = {
    moveBlockId: randomUUID(),
    copyBlockId: randomUUID(),
    rootMoveBlockId: randomUUID(),
    rootCopyBlockId: randomUUID(),
  };
  const rootTitle = `해빌리온 거래처 장부 ${suffix}`;
  const childTitle = `회사 정보 검토 요청 자료 ${suffix}`;
  const childDatabaseTitle = `거래처 관리 ${suffix}`;
  const siblingTitle = `모두물산 주식회사 물품공급계약 ${suffix}`;
  const favoriteTitle = `대표님 보고용 자금 흐름 ${suffix}`;
  const sharedTitle = `조조에 보낸 자료 검토 요청 ${suffix}`;
  const sharedChildTitle = `공유 페이지 하위 점검 ${suffix}`;
  const blockText = {
    move: `사이드바 이동 블록 ${suffix}`,
    copy: `사이드바 복사 블록 ${suffix}`,
    rootMove: `개인 페이지 루트로 이동할 블록 ${suffix}`,
    rootCopy: `개인 페이지 루트로 복사할 블록 ${suffix}`,
  };
  const emptyWorkspaceDomain = `tree-empty-${suffix}`;

  const rootPage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: rootPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: rootTitle,
    iconType: 'emoji',
    icon: '🚀',
    position: suffix,
  });
  assert(rootPage?.page?.id === rootPageId, 'page tree root page must be created');

  const childPage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: childPageId,
    workspaceId,
    parentId: rootPageId,
    parentType: 'page',
    kind: 'page',
    title: childTitle,
    iconType: 'emoji',
    icon: '📝',
    position: suffix + 1,
  });
  assert(childPage?.page?.id === childPageId, 'page tree child page must be created');

  const childDatabase = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: childDatabaseId,
    workspaceId,
    parentId: rootPageId,
    parentType: 'page',
    kind: 'database',
    title: childDatabaseTitle,
    iconType: 'emoji',
    icon: '📊',
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: randomUUID(), name: '샘플대상명', type: 'title', position: 1 },
    ],
  });
  assert(childDatabase?.page?.id === childDatabaseId, 'page tree database child must be created');
  const defaultViewId = childDatabase.views?.[0]?.id;
  assert(defaultViewId, 'page tree database child must receive its default view');
  const childDatabaseViewIds = {
    default: defaultViewId,
    all: randomUUID(),
    suppliers: randomUUID(),
  };
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: childDatabaseViewIds.default,
    // Routing hint for the workspace-DO split (view ids are not pages).
    databaseId: childDatabaseId,
    patch: { name: 'Default view', position: 1 },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: childDatabaseViewIds.all,
        databaseId: childDatabaseId,
        name: '전체 테이블',
        type: 'table',
        position: 2,
        config: {},
      },
      {
        id: childDatabaseViewIds.suppliers,
        databaseId: childDatabaseId,
        name: '공급처',
        type: 'table',
        position: 3,
        config: {},
      },
    ],
  });

  const siblingPage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: siblingPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: siblingTitle,
    iconType: 'emoji',
    icon: '👥',
    position: suffix + 2,
  });
  assert(siblingPage?.page?.id === siblingPageId, 'page tree sibling page must be created');

  const favoritePage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: favoritePageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: favoriteTitle,
    iconType: 'emoji',
    icon: '💿',
    position: suffix + 3,
  });
  assert(favoritePage?.page?.id === favoritePageId, 'page tree favorite fixture page must be created');
  const favoritedPage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'update',
    id: favoritePageId,
    patch: { isFavorite: true },
  });
  assert(favoritedPage?.page?.isFavorite === true, 'page tree favorite fixture page must be favorited');

  const sharedPage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: sharedPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: sharedTitle,
    iconType: 'emoji',
    icon: '💬',
    position: suffix + 4,
  });
  assert(sharedPage?.page?.id === sharedPageId, 'page tree shared fixture page must be created');
  const sharedChildPage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: sharedChildPageId,
    workspaceId,
    parentId: sharedPageId,
    parentType: 'page',
    kind: 'page',
    title: sharedChildTitle,
    iconType: 'emoji',
    icon: '📎',
    position: suffix + 5,
  });
  assert(sharedChildPage?.page?.id === sharedChildPageId, 'page tree shared child fixture page must be created');
  const sharedPagePermission = await callFunction(baseUrl, session.accessToken, 'share-mutation', {
    action: 'invite',
    pageId: sharedPageId,
    principalType: 'user',
    principalId: viewOnlySession.userId,
    label: 'Page tree smoke shared shortcut user',
    role: 'view',
  });
  assert(sharedPagePermission?.permission?.id, 'page tree shared shortcut permission must be created');

  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: blockIds.moveBlockId,
        pageId: siblingPageId,
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: blockText.move }] },
        plainText: blockText.move,
        position: 1,
      },
      {
        id: blockIds.copyBlockId,
        pageId: siblingPageId,
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: blockText.copy }] },
        plainText: blockText.copy,
        position: 2,
      },
      {
        id: blockIds.rootMoveBlockId,
        pageId: siblingPageId,
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: blockText.rootMove }] },
        plainText: blockText.rootMove,
        position: 3,
      },
      {
        id: blockIds.rootCopyBlockId,
        pageId: siblingPageId,
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: blockText.rootCopy }] },
        plainText: blockText.rootCopy,
        position: 4,
      },
    ],
  });
  assert(createdBlocks?.blocks?.length === 4, 'page tree block drop smoke blocks must be created');

  const emptyWorkspace = await callFunction(baseUrl, session.accessToken, 'workspace-mutation', {
    action: 'createWorkspace',
    name: `빈 개인 페이지 검증 ${suffix}`,
    icon: '해',
    domain: emptyWorkspaceDomain,
  });
  const emptyWorkspaceId = emptyWorkspace?.workspace?.id;
  assert(emptyWorkspaceId, 'empty page tree workspace must be created');
  const seededEmptyWorkspacePages = await callFunction(baseUrl, session.accessToken, 'page-query', {
    action: 'pages',
    workspaceId: emptyWorkspaceId,
  });
  const seededEmptyWorkspaceRootPages = (Array.isArray(seededEmptyWorkspacePages?.pages)
    ? seededEmptyWorkspacePages.pages
    : []
  ).filter((page) => !page?.parentId || page?.parentType === 'workspace');
  for (const page of seededEmptyWorkspaceRootPages) {
    await permanentlyDeletePage(baseUrl, session.accessToken, page.id, { call: callFunction });
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    viewOnlyRefreshToken: viewOnlySession.refreshToken,
    viewOnlyUserId: viewOnlySession.userId,
    workspaceId,
    emptyWorkspaceId,
    emptyWorkspaceDomain,
    emptyCreatedPageId: null,
    dragCopyPageId: null,
    dragCopiedBlockId: null,
    privateRootMovePageId: null,
    privateRootCopyPageId: null,
    privateRootPageCopyId: null,
    menuDuplicatePageId: null,
    blockIds,
    blockText,
    favoritePageId,
    favoriteTitle,
    childDatabaseId,
    childDatabaseTitle,
    childDatabaseViewIds,
    rootPageId,
    childPageId,
    sharedChildPageId,
    sharedPageId,
    sharedTitle,
    sharedChildTitle,
    siblingPageId,
    rootTitle,
    childTitle,
    siblingTitle,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  if (seed.emptyCreatedPageId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.emptyCreatedPageId, { call: callFunction }).catch(() => {});
  }
  if (seed.emptyWorkspaceId) {
    await callFunction(baseUrl, seed.accessToken, 'workspace-mutation', {
      action: 'deleteWorkspace',
      workspaceId: seed.emptyWorkspaceId,
    }).catch(() => {});
  }
  for (const id of [
    seed.menuDuplicatePageId,
    seed.privateRootCopyPageId,
    seed.privateRootMovePageId,
    seed.privateRootPageCopyId,
    seed.dragCopyPageId,
    seed.sharedChildPageId,
    seed.sharedPageId,
    seed.favoritePageId,
    seed.childDatabaseId,
    seed.childPageId,
    seed.rootPageId,
    seed.siblingPageId,
  ]) {
    if (!id) continue;
    await permanentlyDeletePage(baseUrl, seed.accessToken, id, { call: callFunction }).catch(() => {});
  }
}

async function seedSession(context, seed, { workspaceId = seed.workspaceId } = {}) {
  // Shared harness install: the first context bootstraps from the API-issued
  // refresh token; later contexts transplant the rotated HttpOnly cookie
  // captured by closeSeededContext (EdgeBase rotation reuse detection forbids
  // replaying the original token across contexts).
  await installBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
    workspaceId,
    localStorage: { 'hanji:sidebar-section-collapsed': null },
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
  await page.waitForTimeout(150);
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
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
    // "Failed to load resource" console messages carry the failing URL only in
    // the message location, so append it — a bare 400 is unattributable.
    if (message.type() === 'error') {
      const url = message.location()?.url;
      errors.push(url ? `${message.text()} (${url})` : message.text());
    }
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
  assert(typeof body?.user?.id === 'string' && body.user.id, 'anonymous sign-in must return a user id');
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body?.user?.id ?? '',
    userId: body.user.id,
  };
}

async function callFunction(baseUrl, token, name, body) {
  const canRetryRead = name === 'page-query' && (body?.action === 'pages' || body?.action === 'blocks');
  const canRetryIdempotentMove = name === 'page-mutation' && body?.action === 'move';
  const retryableWorkerRestart = canRetryRead || canRetryIdempotentMove;
  for (let attempt = 0; attempt < (retryableWorkerRestart ? 5 : 1); attempt += 1) {
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
    const text = await response.text();
    let json = null;
    try {
      json = parseJsonText(text, `${name}:${body?.action ?? 'unknown'}`);
    } catch (error) {
      if (retryableWorkerRestart && isWorkerRestartResponse(text) && attempt < 4) {
        await delay(500 * (attempt + 1));
        continue;
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
    }
    return json;
  }
  throw new Error(`${name} did not return JSON after retrying the request.`);
}

async function fetchWorkspacePages(baseUrl, seed, opts = {}) {
  const result = await callFunction(apiBaseUrl(baseUrl, seed), seed.accessToken, 'page-query', {
    action: 'pages',
    workspaceId: seed.workspaceId,
    includeTrash: !!opts.includeTrash,
  });
  return Array.isArray(result?.pages) ? result.pages : [];
}

async function fetchPageBlocks(baseUrl, seed, pageId) {
  const result = await callFunction(apiBaseUrl(baseUrl, seed), seed.accessToken, 'page-query', {
    action: 'blocks',
    pageId,
  });
  return Array.isArray(result?.blocks) ? result.blocks : [];
}

function apiBaseUrl(baseUrl, seed) {
  return seed?.apiUrl ?? baseUrl;
}

async function waitForPageState(baseUrl, seed, pageId, predicate, label, opts = {}) {
  const startedAt = Date.now();
  let lastPage = null;

  while (Date.now() - startedAt < options.timeoutMs) {
    const pages = await fetchWorkspacePages(baseUrl, seed, opts);
    lastPage = pages.find((item) => item.id === pageId) ?? null;
    if (predicate(lastPage)) return lastPage;
    await delay(250);
  }

  throw new Error(`${label} was not persisted; last=${JSON.stringify(lastPage)}`);
}

async function waitForPageByTitle(baseUrl, seed, title, label, opts = {}) {
  const startedAt = Date.now();
  let lastMatches = [];
  const excludedIds = new Set(opts.excludeIds ?? []);

  while (Date.now() - startedAt < options.timeoutMs) {
    const pages = await fetchWorkspacePages(baseUrl, seed, opts);
    lastMatches = pages.filter(
      (page) =>
        page.title === title &&
        !page.inTrash &&
        !excludedIds.has(page.id) &&
        (page.parentId ?? null) === null &&
        (page.parentType ?? 'workspace') === 'workspace',
    );
    if (lastMatches.length === 1) return lastMatches[0];
    await delay(250);
  }

  throw new Error(`${label} was not persisted; matches=${JSON.stringify(lastMatches)}`);
}

async function waitForBlockList(baseUrl, seed, pageId, predicate, label) {
  const startedAt = Date.now();
  let lastBlocks = [];

  while (Date.now() - startedAt < options.timeoutMs) {
    lastBlocks = await fetchPageBlocks(baseUrl, seed, pageId);
    const result = predicate(lastBlocks);
    if (result) return result === true ? lastBlocks : result;
    await delay(250);
  }

  throw new Error(`${label} was not persisted; last=${JSON.stringify(lastBlocks)}`);
}

async function waitForRelativePageOrder(baseUrl, seed, expectedPageIds, label, opts = {}) {
  const startedAt = Date.now();
  let lastOrder = [];
  const expectedSet = new Set(expectedPageIds);

  while (Date.now() - startedAt < options.timeoutMs) {
    const pages = await fetchWorkspacePages(baseUrl, seed, opts);
    lastOrder = pages
      .filter((page) => !page.inTrash && expectedSet.has(page.id))
      .sort((a, b) => a.position - b.position)
      .map((page) => page.id);
    if (
      lastOrder.length === expectedPageIds.length &&
      expectedPageIds.every((id, index) => lastOrder[index] === id)
    ) {
      return;
    }
    await delay(250);
  }

  throw new Error(`${label} order was not persisted; last=${JSON.stringify(lastOrder)}`);
}

async function setRootPageOrder(baseUrl, seed, pageIds, label) {
  const basePosition = Date.now();
  for (const [index, pageId] of pageIds.entries()) {
    await callFunction(apiBaseUrl(baseUrl, seed), seed.accessToken, 'page-mutation', {
      action: 'move',
      id: pageId,
      parentId: null,
      parentType: 'workspace',
      position: basePosition + index,
    });
  }
  await waitForRelativePageOrder(baseUrl, seed, pageIds, label);
}

async function readJson(response) {
  const text = await response.text();
  return parseJsonText(text);
}

function parseJsonText(text, label = 'response') {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} expected JSON, got: ${text.slice(0, 200)}`);
  }
}

function isWorkerRestartResponse(text) {
  return text.includes('Your worker restarted mid-request');
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
    'Playwright is required for page tree UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
    onlyActiveParentCollapse: false,
    onlyDatabaseChildViews: false,
    onlySidebarCollapseMotion: false,
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
    if (arg === '--only-active-parent-collapse') {
      parsed.onlyActiveParentCollapse = true;
      continue;
    }
    if (arg === '--only-database-child-views') {
      parsed.onlyDatabaseChildViews = true;
      continue;
    }
    if (arg === '--only-sidebar-collapse-motion') {
      parsed.onlySidebarCollapseMotion = true;
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
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a number >= 1000');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/page-tree-ui-smoke.mjs [options]

Checks sidebar page tree keyboard expansion, focus movement, edge jumps, nested
page opening, and nested tree visual screenshots.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL when checking a separate Vite app.
  --screenshot-dir <dir>  Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --only-active-parent-collapse
                          Run only the active-descendant parent disclosure check.
  --only-database-child-views
                          Run only the database child/view manual disclosure check.
  --only-sidebar-collapse-motion
                          Run only the desktop sidebar collapse/expand motion check.
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
