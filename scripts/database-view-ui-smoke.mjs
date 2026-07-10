#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'first-database');
const NON_TABLE_VIEW_CASES = [
  {
    name: 'Board',
    idKey: 'board',
    rowIndex: 0,
    file: 'desktop-first-database-board.png',
    darkFile: 'desktop-first-database-board-dark.png',
    mobileFile: 'mobile-first-database-board.png',
    mobileDarkFile: 'mobile-first-database-board-dark.png',
  },
  {
    name: 'List',
    idKey: 'list',
    rowIndex: 1,
    file: 'desktop-first-database-list.png',
    darkFile: 'desktop-first-database-list-dark.png',
    mobileFile: 'mobile-first-database-list.png',
    mobileDarkFile: 'mobile-first-database-list-dark.png',
  },
  {
    name: 'Gallery',
    idKey: 'gallery',
    rowIndex: 2,
    file: 'desktop-first-database-gallery.png',
    darkFile: 'desktop-first-database-gallery-dark.png',
    mobileFile: 'mobile-first-database-gallery.png',
    mobileDarkFile: 'mobile-first-database-gallery-dark.png',
  },
  {
    name: 'Calendar',
    idKey: 'calendar',
    rowIndex: 0,
    file: 'desktop-first-database-calendar.png',
    darkFile: 'desktop-first-database-calendar-dark.png',
    mobileFile: 'mobile-first-database-calendar.png',
    mobileDarkFile: 'mobile-first-database-calendar-dark.png',
  },
  {
    name: 'Timeline',
    idKey: 'timeline',
    rowIndex: 0,
    file: 'desktop-first-database-timeline.png',
    darkFile: 'desktop-first-database-timeline-dark.png',
    mobileFile: 'mobile-first-database-timeline.png',
    mobileDarkFile: 'mobile-first-database-timeline-dark.png',
  },
];

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database view UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Database view UI smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Database view UI smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedDatabase(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    if (options.onlySelection) {
      await assertDatabaseSelectionChrome(browser, appUrl, seed);
      console.log('PASS database table row selection replaces the toolbar slot without shifting the property header.');
      console.log(`Selected-row screenshot: ${join(options.screenshotDir, 'desktop-first-database-selected-row.png')}`);
      console.log(`Selected-row dark screenshot: ${join(options.screenshotDir, 'desktop-first-database-selected-row-dark.png')}`);
      return;
    }
    if (options.onlyFilterSelect) {
      await assertDatabaseFilterSelectChrome(browser, appUrl, seed);
      console.log('PASS database filter select menus remain selectable and adjacent Current page value menus open.');
      console.log(`Filter value menu screenshot: ${join(options.screenshotDir, 'desktop-first-database-filter-current-page-menu.png')}`);
      console.log(`Filter value selected screenshot: ${join(options.screenshotDir, 'desktop-first-database-filter-current-page-selected.png')}`);
      console.log(`Filter value dark screenshot: ${join(options.screenshotDir, 'desktop-first-database-filter-current-page-menu-dark.png')}`);
      console.log(`Low-viewport second-filter property menu screenshot: ${join(options.screenshotDir, 'desktop-low-filter-second-property-menu.png')}`);
      return;
    }
    if (options.onlyPropertyHeaderContextMenu) {
      await assertDatabasePropertyHeaderContextMenu(browser, appUrl, seed);
      console.log('PASS database property headers open the product menu on right-click.');
      console.log(`Property header menu screenshot: ${join(options.screenshotDir, 'desktop-first-database-property-header-context-menu.png')}`);
      console.log(`Property header menu dark screenshot: ${join(options.screenshotDir, 'desktop-first-database-property-header-context-menu-dark.png')}`);
      return;
    }
    if (options.onlyRowContextMenu) {
      await assertDatabaseRowContextMenu(browser, appUrl, seed);
      console.log('PASS database rows open the compact row menu with Notion-like row actions.');
      console.log(`Row menu screenshot: ${join(options.screenshotDir, 'desktop-first-database-row-context-menu.png')}`);
      console.log(`Row Open in submenu screenshot: ${join(options.screenshotDir, 'desktop-first-database-row-context-menu-open-in.png')}`);
      console.log(`Row properties menu screenshot: ${join(options.screenshotDir, 'desktop-first-database-row-context-menu-edit-properties.png')}`);
      return;
    }
    if (options.onlyViewTabMenu) {
      await assertDatabaseViewTabMenu(browser, appUrl, seed);
      console.log('PASS selected database view tabs open the product view menu on click and right-click.');
      console.log(`View tab menu screenshot: ${join(options.screenshotDir, 'desktop-first-database-view-tab-menu.png')}`);
      console.log(`View tab menu dark screenshot: ${join(options.screenshotDir, 'desktop-first-database-view-tab-menu-dark.png')}`);
      return;
    }
    await assertDatabaseViews(browser, appUrl, seed);
    console.log('PASS database table, board, list, gallery, calendar, and timeline views render and route through browser tabs.');
    console.log(`Screenshot: ${join(options.screenshotDir, 'desktop-first-database.png')}`);
    console.log(`Dark screenshot: ${join(options.screenshotDir, 'desktop-first-database-dark.png')}`);
    console.log(`Mobile screenshot: ${join(options.screenshotDir, 'mobile-first-database.png')}`);
    console.log(`Mobile dark screenshot: ${join(options.screenshotDir, 'mobile-first-database-dark.png')}`);
    console.log(`Surface inventories: ${options.screenshotDir}`);
    for (const view of NON_TABLE_VIEW_CASES) {
      console.log(`${view.name} screenshots: ${join(options.screenshotDir, view.file)}, ${join(options.screenshotDir, view.darkFile)}`);
      console.log(`${view.name} mobile screenshots: ${join(options.screenshotDir, view.mobileFile)}, ${join(options.screenshotDir, view.mobileDarkFile)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertDatabaseSelectionChrome(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertTableSelectionChromeStability(page, 'desktop-first-database-selected-row.png');
    await openDatabase(page, baseUrl, seed);
    await setTheme(page, 'dark');
    await assertTableSelectionChromeStability(page, 'desktop-first-database-selected-row-dark.png');
    assertNoBrowserErrors(errors, 'database row selection chrome flow');
  } finally {
    await context.close().catch(() => {});
  }

  await assertNarrowDatabasePageCanvas(browser, baseUrl, seed);
}

async function assertDatabaseFilterSelectChrome(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertToolbarFilterSelectClickThrough(page, seed);
    await openDatabase(page, baseUrl, seed);
    await setTheme(page, 'dark');
    await assertToolbarFilterSelectClickThrough(page, seed, 'dark');
    assertNoBrowserErrors(errors, 'database filter select menu flow');
  } finally {
    await context.close().catch(() => {});
  }

  const lowViewport = await newCheckedPage(browser, {
    viewport: { width: 1024, height: 650 },
    deviceScaleFactor: 1,
  });
  await seedSession(lowViewport.context, seed);

  try {
    await openDatabase(lowViewport.page, baseUrl, seed);
    await setTheme(lowViewport.page, 'dark');
    await assertSecondFilterPropertySelectLayering(lowViewport.page);
    assertNoBrowserErrors(lowViewport.errors, 'low-viewport database filter property menu flow');
  } finally {
    await lowViewport.context.close().catch(() => {});
  }
}

async function assertDatabasePropertyHeaderContextMenu(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertPropertyHeaderContextMenu(page, seed);
    await openDatabase(page, baseUrl, seed);
    await setTheme(page, 'dark');
    await assertPropertyHeaderContextMenu(page, seed, 'dark');
    assertNoBrowserErrors(errors, 'database property header context menu flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertDatabaseRowContextMenu(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertRowContextMenu(page, seed);
    assertNoBrowserErrors(errors, 'database row context menu flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertDatabaseViewTabMenu(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertViewTabActionMenu(page, seed);
    await openDatabase(page, baseUrl, seed);
    await setTheme(page, 'dark');
    await assertViewTabActionMenu(page, seed, 'dark');
    assertNoBrowserErrors(errors, 'database view tab action menu flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertDatabaseViews(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertToolbarLayoutMenuClickThrough(page, seed);
    await assertToolbarFilterSelectClickThrough(page, seed);
    await moveMouseToIdleChrome(page);
    await assertFirstDatabaseVisualContract(page, seed);
    await writeDatabaseViewSurfaceInventory(page, seed, {
      filename: 'desktop-first-database-inventory-table.json',
      mobile: false,
      theme: 'light',
      view: { name: 'Table', idKey: 'table', rowIndex: 0 },
    });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-database.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await moveMouseToIdleChrome(page);
    await assertFirstDatabaseVisualContract(page, seed);
    await writeDatabaseViewSurfaceInventory(page, seed, {
      filename: 'desktop-first-database-inventory-table-dark.json',
      mobile: false,
      theme: 'dark',
      view: { name: 'Table', idKey: 'table', rowIndex: 0 },
    });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-database-dark.png'),
      fullPage: false,
    });
    await setTheme(page, 'light');
    await assertDefaultSummaryControlsStayQuiet(page, baseUrl, seed);
    await assertViewTabs(page, seed);
    await captureNonTableDatabaseViewScreenshots(page, seed);
    await assertTableView(page, seed);
    await assertBoardView(page, seed);
    await assertListView(page, seed);
    await assertGalleryView(page, seed);
    await assertCalendarView(page, seed);
    await assertTimelineView(page, seed);
    await assertDirectViewUrl(page, baseUrl, seed);
    assertNoBrowserErrors(errors, 'database view UI flow');
  } finally {
    await context.close().catch(() => {});
  }

  await assertMobileDatabaseViews(browser, baseUrl, seed);
}

async function assertMobileDatabaseViews(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await moveMouseToIdleChrome(page);
    await assertMobileDatabaseViewVisualContract(page, seed, { name: 'Table', idKey: 'table', rowIndex: 0 });
    await writeDatabaseViewSurfaceInventory(page, seed, {
      filename: 'mobile-first-database-inventory-table.json',
      mobile: true,
      theme: 'light',
      view: { name: 'Table', idKey: 'table', rowIndex: 0 },
    });
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-first-database.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await moveMouseToIdleChrome(page);
    await assertMobileDatabaseViewVisualContract(page, seed, { name: 'Table', idKey: 'table', rowIndex: 0 });
    await writeDatabaseViewSurfaceInventory(page, seed, {
      filename: 'mobile-first-database-inventory-table-dark.json',
      mobile: true,
      theme: 'dark',
      view: { name: 'Table', idKey: 'table', rowIndex: 0 },
    });
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-first-database-dark.png'),
      fullPage: false,
    });
    await setTheme(page, 'light');
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      for (const view of NON_TABLE_VIEW_CASES) {
        await selectView(page, view.name, seed.viewIds[view.idKey]);
        await waitForDatabaseViewVisualReady(page, view, seed);
        await moveMouseToIdleChrome(page);
        await assertMobileDatabaseViewVisualContract(page, seed, view);
        await writeDatabaseViewSurfaceInventory(page, seed, {
          filename: theme === 'dark'
            ? `mobile-first-database-inventory-${view.idKey}-dark.json`
            : `mobile-first-database-inventory-${view.idKey}.json`,
          mobile: true,
          theme,
          view,
        });
        await page.screenshot({
          path: join(options.screenshotDir, theme === 'dark' ? view.mobileDarkFile : view.mobileFile),
          fullPage: false,
        });
      }
    }
    assertNoBrowserErrors(errors, 'mobile database view UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function moveMouseToIdleChrome(page) {
  await page.mouse.move(8, 8);
  await page.waitForTimeout(80);
}

async function openDatabase(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tablist', { name: `${seed.databaseTitle} views` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectSelectedTab(page, 'Table', seed.viewIds.table, false);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);
  await page.getByRole('toolbar', { name: 'Database toolbar' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function captureNonTableDatabaseViewScreenshots(page, seed) {
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    for (const view of NON_TABLE_VIEW_CASES) {
      await selectView(page, view.name, seed.viewIds[view.idKey]);
      await waitForDatabaseViewVisualReady(page, view, seed);
      await moveMouseToIdleChrome(page);
      await assertDatabaseViewShellVisualContract(page, seed, view);
      await writeDatabaseViewSurfaceInventory(page, seed, {
        filename: theme === 'dark'
          ? `desktop-first-database-inventory-${view.idKey}-dark.json`
          : `desktop-first-database-inventory-${view.idKey}.json`,
        mobile: false,
        theme,
        view,
      });
      await page.screenshot({
        path: join(options.screenshotDir, theme === 'dark' ? view.darkFile : view.file),
        fullPage: false,
      });
    }
  }
  await setTheme(page, 'light');
}

async function waitForDatabaseViewVisualReady(page, view, seed) {
  await expectSelectedTab(page, view.name, seed.viewIds[view.idKey]);
  const panel = currentPanel(page);
  if (view.name === 'Board') {
    await panel.getByRole('button', { name: `${seed.statusOptionNames[0]} group options` }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  if (view.name === 'Calendar') {
    await panel.getByRole('button', { name: 'Previous month' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await panel.getByRole('button', { name: 'Next month' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  if (view.name === 'Timeline') {
    await panel.getByRole('group', { name: 'Timeline zoom' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  await expectOpenRowButton(page, seed.rowTitles[view.rowIndex]);
}

async function assertViewTabs(page, seed) {
  const tablist = page.getByRole('tablist', { name: `${seed.databaseTitle} views` });
  for (const name of ['Table', 'Board', 'List', 'Gallery', 'Calendar', 'Timeline']) {
    await tablist.getByRole('tab', { name, exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  const count = await tablist.getByRole('tab').count();
  assert(count === 6, `expected 6 database view tabs, got ${count}`);
}

async function assertTableView(page, seed) {
  await selectView(page, 'Table', seed.viewIds.table);
  await expectSelectedTab(page, 'Table', seed.viewIds.table);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);
  await assertTableSelectionChromeStability(page);
}

async function assertTableSelectionChromeStability(page, screenshotFile = 'desktop-first-database-selected-row.png') {
  const targetPoint = await page.evaluate(() => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const opacity = Number(style.opacity);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        (!Number.isFinite(opacity) || opacity > 0.01)
      );
    };
    const checkbox = document.querySelector('[data-table-row-select]');
    const row = checkbox?.closest('[data-table-row-id]');
    if (!(checkbox instanceof HTMLElement) || !row || !visible(row)) return null;
    const checkboxRect = checkbox.getBoundingClientRect();
    const gutter = row.querySelector('[data-table-row-gutter-cell]');
    const gutterRect = gutter?.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      hoverX: Math.round(rowRect.left + Math.min(Math.max(rowRect.width / 2, 24), 320)),
      hoverY: Math.round(rowRect.top + rowRect.height / 2),
      gutterX: Math.round((gutterRect?.left ?? checkboxRect.left) + Math.max(8, (gutterRect?.width ?? checkboxRect.width) / 2)),
      gutterY: Math.round((gutterRect?.top ?? checkboxRect.top) + (gutterRect?.height ?? checkboxRect.height) / 2),
      x: Math.round(checkboxRect.left + checkboxRect.width / 2),
      y: Math.round(checkboxRect.top + checkboxRect.height / 2),
    };
  });
  assert(targetPoint, 'database table row selection checkbox should be available in the row gutter');

  const snapshot = () =>
    page.evaluate(() => {
      const snapshotElement = (node) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const opacity = Number(style.opacity);
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          opacity,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          boxShadow: style.boxShadow,
          display: style.display,
          hittable: !!hit && node.contains(hit),
          hitTagName: hit instanceof HTMLElement ? hit.tagName : null,
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            (!Number.isFinite(opacity) || opacity > 0.01),
        };
      };
      const snapshotTitleLayout = () => {
        const cell = document.querySelector(
          '[data-table-cell][data-row-index="0"][data-col-index="0"][data-title="true"]',
        );
        const editor = cell?.querySelector('[data-cell-editor]');
        const input = cell?.querySelector('input[type="text"]');
        const openRow = cell?.querySelector('[data-table-row-open]');
        if (
          !(cell instanceof HTMLElement) ||
          !(editor instanceof HTMLElement) ||
          !(input instanceof HTMLInputElement) ||
          !(openRow instanceof HTMLElement)
        ) {
          return null;
        }
        const cellRect = cell.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        const openRect = openRow.getBoundingClientRect();
        const editorStyle = getComputedStyle(editor);
        const openStyle = getComputedStyle(openRow);
        return {
          cell: snapshotElement(cell),
          input: snapshotElement(input),
          openRow: snapshotElement(openRow),
          editorPaddingRight: Number.parseFloat(editorStyle.paddingRight || '0'),
          inputRightGap: Math.round(cellRect.right - inputRect.right),
          inputRight: Math.round(inputRect.right),
          inputWidth: Math.round(inputRect.width),
          openPosition: openStyle.position,
          openLeft: Math.round(openRect.left),
          openWidth: Math.round(openRect.width),
        };
      };
      return {
        viewTab: snapshotElement(document.querySelector('[data-view-tab][aria-selected="true"]')),
        toolbar: snapshotElement(document.querySelector('[class*="dbToolbar"]')),
        selectionBar: snapshotElement(document.querySelector('[data-table-selection-bar]')),
        tableHead: snapshotElement(document.querySelector('[data-table-head]')),
        selectedRow: snapshotElement(document.querySelector('[data-row-selected="true"]')),
        rowGutter: snapshotElement(document.querySelector('[data-table-row-gutter-cell]')),
        rowAdd: snapshotElement(document.querySelector('[data-table-row-add]')),
        rowMenu: snapshotElement(document.querySelector('[data-table-row-menu]')),
        rowCheckbox: snapshotElement(document.querySelector('[data-table-row-select]')),
        titleLayout: snapshotTitleLayout(),
        checked: !!document.querySelector('[data-table-row-select]:checked'),
      };
    });

  const before = await snapshot();
  await page.locator('[data-table-row-gutter-cell]').first().hover({
    force: true,
    timeout: options.timeoutMs,
  });
  await page.waitForTimeout(80);
  const hoverFromGutter = await snapshot();
  await page.keyboard.press('Escape');
  await page.locator('[aria-label="Close view actions"]').waitFor({
    state: 'detached',
    timeout: 1_500,
  }).catch(() => {});
  await page.locator('[data-table-cell][data-row-index="0"][data-col-index="0"][data-title="true"]').hover({
    timeout: options.timeoutMs,
  });
  await page.waitForTimeout(80);
  const hoverFromTitleCell = await snapshot();
  assert(
    before.titleLayout?.editorPaddingRight <= 2 &&
      before.titleLayout?.inputRightGap <= 18 &&
      before.titleLayout?.openPosition === 'absolute',
    `row title text should keep the full title-cell width while the Open button is an overlay, not a reserved slot: ${JSON.stringify({ before })}`,
  );
  assert(
    hoverFromTitleCell.titleLayout?.openRow?.visible &&
      Math.abs((hoverFromTitleCell.titleLayout?.inputRight ?? 0) - (before.titleLayout?.inputRight ?? 0)) <= 1 &&
      hoverFromTitleCell.titleLayout?.inputRightGap <= 18 &&
      hasOpaqueFloatingSurface(hoverFromTitleCell.titleLayout?.openRow),
    `title-cell hover Open button should appear above the title text without shrinking or interrupting the text line: ${JSON.stringify({ before: before.titleLayout, hover: hoverFromTitleCell.titleLayout })}`,
  );
  assert(
    hoverFromGutter.rowAdd?.visible &&
      hoverFromGutter.rowMenu?.visible &&
      hoverFromGutter.rowCheckbox?.visible,
    `row gutter should expose the add/menu/checkbox controls before the direct selection click verifies hit behavior: ${JSON.stringify({ before, hoverFromGutter })}`,
  );
  const clickTarget = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    if (!(node instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      tagName: node.tagName,
      className: node.className,
      ariaLabel: node.getAttribute('aria-label'),
      dataSelect: node.getAttribute('data-table-row-select'),
      pointerEvents: style.pointerEvents,
      opacity: style.opacity,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, targetPoint);
  assert(
    hoverFromGutter.rowAdd?.visible &&
      hoverFromGutter.rowMenu?.visible &&
      hoverFromGutter.rowCheckbox?.visible,
    `row gutter controls should remain available before the direct selection click verifies hit behavior: ${JSON.stringify({ hoverFromGutter, clickTarget })}`,
  );
  await page.mouse.click(targetPoint.x, targetPoint.y);
  await page.waitForTimeout(300);
  const after = await snapshot();
  await page.screenshot({
    path: join(options.screenshotDir, screenshotFile),
    fullPage: false,
  });
  assert(
    after.checked &&
      after.selectedRow?.visible &&
      after.selectionBar?.visible &&
      /selected|선택됨/.test(after.selectionBar.text),
    `selected row action bar should appear with a checked row state: ${JSON.stringify({ before, clickTarget, after })}`,
  );
  assert(
    before.viewTab?.visible && after.viewTab?.visible,
    `row selection should not hide the visible database view tab: ${JSON.stringify({ before, after })}`,
  );
  assert(
    Number.isFinite(before.tableHead?.y) &&
      Number.isFinite(after.tableHead?.y) &&
      Math.abs(after.tableHead.y - before.tableHead.y) <= 1,
    `row selection should replace existing database chrome instead of shifting the property header: ${JSON.stringify({ before, after })}`,
  );
  assert(
    before.toolbar?.visible && !after.toolbar?.visible,
    `row selection should use the existing toolbar slot rather than adding a separate row: ${JSON.stringify({ before, after })}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
}

async function assertNarrowDatabasePageCanvas(browser, baseUrl, seed) {
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'update',
    id: seed.databaseId,
    patch: { fullWidth: true },
  });

  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 920, height: 735 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await setTheme(page, 'dark');
    await page.waitForTimeout(120);

    const metrics = await page.evaluate(() => {
      const rect = (node) => {
        if (!(node instanceof HTMLElement)) return null;
        const r = node.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
        };
      };
      const title =
        document.querySelector('[data-page-header-root] [role="textbox"]') ??
        document.querySelector('[role="textbox"][aria-label="Page title"]') ??
        document.querySelector('[role="textbox"][aria-label="페이지 제목"]');
      const main = document.querySelector('main');
      const doc = document.querySelector('[data-page-search-root]');
      const tableScroll = document.querySelector('[class*="tableScroll"]');
      const table = document.querySelector('[class*="table"][data-row-gutter="true"]');
      const firstCell = document.querySelector('[data-table-cell][data-row-index="0"][data-col-index="0"]');
      const secondCell = document.querySelector('[data-table-cell][data-row-index="1"][data-col-index="0"]');
      const rowGutter = document.querySelector('[data-table-row-gutter-cell]');
      const rowCheckbox = document.querySelector('[data-table-row-select]');
      const tableScrollStyle = tableScroll instanceof HTMLElement ? getComputedStyle(tableScroll) : null;
      const tableStyle = table instanceof HTMLElement ? getComputedStyle(table) : null;
      return {
        ok:
          title instanceof HTMLElement &&
          main instanceof HTMLElement &&
          doc instanceof HTMLElement &&
          tableScroll instanceof HTMLElement &&
          table instanceof HTMLElement &&
          firstCell instanceof HTMLElement &&
          secondCell instanceof HTMLElement &&
          rowGutter instanceof HTMLElement &&
          rowCheckbox instanceof HTMLElement,
        viewportWidth: window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        main: rect(main),
        doc: rect(doc),
        title: rect(title),
        tableScroll: rect(tableScroll),
        table: rect(table),
        firstCell: rect(firstCell),
        secondCell: rect(secondCell),
        rowGutter: rect(rowGutter),
        rowCheckbox: rect(rowCheckbox),
        tableScrollMarginLeft: tableScrollStyle ? Number.parseFloat(tableScrollStyle.marginLeft || '0') : null,
        tableGutterWidth: tableStyle ? Number.parseFloat(tableStyle.getPropertyValue('--table-gutter-width') || '0') : null,
      };
    });

    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-first-database-narrow-dark.png'),
      fullPage: false,
    });

    assert(metrics.ok, `narrow database page canvas markers should be present: ${JSON.stringify(metrics)}`);
    assert(
      metrics.main?.width >= 600,
      `narrow desktop fixture should leave a desktop main pane for the database, got ${JSON.stringify(metrics.main)}`,
    );
    assert(
      metrics.title.x - metrics.main.x >= 52 && metrics.title.x - metrics.main.x <= 68,
      `full-width database page should not waste a wide left document gutter at narrow desktop width: ${JSON.stringify(metrics)}`,
    );
    assert(
      Math.abs(metrics.firstCell.x - metrics.title.x) <= 3,
      `narrow database first column should align with the title axis: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.tableGutterWidth >= 60 &&
        metrics.tableGutterWidth <= 68 &&
        metrics.firstCell.x - metrics.rowGutter.x >= 56 &&
        metrics.firstCell.x - metrics.rowGutter.x <= 70 &&
        metrics.rowGutter.x >= metrics.main.x - 10,
      `narrow database row gutter should be compact instead of consuming the old wide 112px gutter: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.viewportWidth - metrics.firstCell.x >= 520,
      `narrow database should leave enough visible table width to avoid a cramped first screen: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.firstCell.height >= 30 &&
        metrics.firstCell.height <= 38 &&
        metrics.secondCell.y - metrics.firstCell.y >= 30 &&
        metrics.secondCell.y - metrics.firstCell.y <= 38,
      `narrow database row height should keep a Notion-like compact rhythm: ${JSON.stringify(metrics)}`,
    );
    assertNoBrowserErrors(errors, 'narrow database page canvas flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertToolbarLayoutMenuClickThrough(page, seed) {
  await assertTableView(page, seed);

  const toolbar = page.getByRole('toolbar', { name: 'Database toolbar' });
  const layoutButton = toolbar.getByRole('button', { name: 'Layout', exact: true });
  const layoutButtonCount = await layoutButton.count();
  assert(layoutButtonCount === 1, `expected one Layout toolbar button, got ${layoutButtonCount}`);
  await layoutButton.click({ timeout: options.timeoutMs });

  const dialog = page.getByRole('dialog', { name: 'Layout options' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const hit = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Layout options"]');
    const backdrop = document.querySelector('[class*="menuBackdrop"]');
    const board = Array.from(dialog?.querySelectorAll('button[role="radio"]') ?? [])
      .find((button) => ['Board', '보드'].includes(button.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
    const initialLoadRow = Array.from(dialog?.querySelectorAll('[class*="layoutRow"]') ?? [])
      .find((row) => row.textContent?.includes('Initial load'));
    const rect = board?.getBoundingClientRect();
    const top = rect
      ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : null;
    const topButton = top?.closest?.('button');
    return {
      boardFound: !!board,
      boardText: board?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      backdropZIndex: backdrop ? getComputedStyle(backdrop).zIndex : null,
      dialogZIndex: dialog ? getComputedStyle(dialog).zIndex : null,
      topButtonText: topButton?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      topButtonAriaLabel: topButton?.getAttribute?.('aria-label') ?? null,
      initialLoadFound: !!initialLoadRow,
      initialLoadText: initialLoadRow?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    };
  });
  assert(
    hit.boardFound &&
      ['Board', '보드'].includes(hit.topButtonText) &&
      hit.initialLoadFound &&
      hit.initialLoadText?.includes('50') &&
      Number(hit.dialogZIndex) > Number(hit.backdropZIndex),
    `Layout menu entries should sit above the outside-click backdrop and receive clicks: ${JSON.stringify(hit)}`,
  );

  await dialog.getByRole('radio', { name: /^(Board|보드)$/ }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="dialog"][aria-label="Layout options"] [role="radio"][aria-checked="true"]')
        ?.textContent
        ?.match(/Board|보드/),
    null,
    { timeout: options.timeoutMs },
  );
  await currentPanel(page).getByRole('button', { name: `${seed.statusOptionNames[0]} group options` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  const boardSettings = await dialog.evaluate((node) => node.textContent ?? '');
  assert(
    boardSettings.includes('Card preview') &&
      boardSettings.includes('Card size') &&
      boardSettings.includes('Fit image') &&
      boardSettings.includes('Wrap properties'),
    `Board layout settings should include Notion-like card controls: ${boardSettings}`,
  );

  await dialog.getByRole('radio', { name: /^(Calendar|캘린더)$/ }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="dialog"][aria-label="Layout options"] [role="radio"][aria-checked="true"]')
        ?.textContent
        ?.match(/Calendar|캘린더/),
    null,
    { timeout: options.timeoutMs },
  );
  const calendarSettings = await dialog.evaluate((node) => node.textContent ?? '');
  assert(
    calendarSettings.includes('Show calendar by') && calendarSettings.includes('Calendar view'),
    `Calendar layout settings should include date and month/week controls: ${calendarSettings}`,
  );

  await dialog.getByRole('radio', { name: /^(Timeline|타임라인)$/ }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="dialog"][aria-label="Layout options"] [role="radio"][aria-checked="true"]')
        ?.textContent
        ?.match(/Timeline|타임라인/),
    null,
    { timeout: options.timeoutMs },
  );
  const timelineSettings = await dialog.evaluate((node) => node.textContent ?? '');
  assert(
    timelineSettings.includes('Show timeline by') &&
      timelineSettings.includes('End date') &&
      timelineSettings.includes('Time scale') &&
      timelineSettings.includes('Load limit') &&
      timelineSettings.includes('Show table'),
    `Timeline layout settings should include Notion-like timeline controls: ${timelineSettings}`,
  );

  await dialog.getByRole('radio', { name: /^(Table|표)$/ }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="dialog"][aria-label="Layout options"] [role="radio"][aria-checked="true"]')
        ?.textContent
        ?.match(/Table|표/),
    null,
    { timeout: options.timeoutMs },
  );
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.getByRole('toolbar', { name: 'Database toolbar' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectSelectedTab(page, 'Table', seed.viewIds.table, false);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);
}

async function assertToolbarFilterSelectClickThrough(page, seed, screenshotSuffix = '') {
  await expectSelectedTab(page, 'Table', seed.viewIds.table, false);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);

  const toolbar = page.getByRole('toolbar', { name: 'Database toolbar' });
  const filterButton = toolbar.getByRole('button', { name: 'Filter', exact: true });
  await filterButton.click({ timeout: options.timeoutMs });

  const dialog = page.getByRole('dialog', { name: 'Filters' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Add filter', exact: true }).click({ timeout: options.timeoutMs });

  const row = dialog.locator('[data-filter-row]').last();
  await row.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const propertyButton = row.locator('button[aria-label="Filter property"]');
  const conditionButton = row.locator('button[aria-label="Filter condition"]');
  await propertyButton.click({ timeout: options.timeoutMs });
  await page.getByRole('menuitemradio', { name: '계약DB', exact: true }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-filter-row] button[aria-label="Filter property"]')
        ?.textContent
        ?.includes('계약DB'),
    null,
    { timeout: options.timeoutMs },
  );

  await conditionButton.click({ timeout: options.timeoutMs });
  const doesNotContain = page.getByRole('menuitemradio', { name: 'Does not contain', exact: true });
  await doesNotContain.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const operatorHit = await doesNotContain.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const topButton = top?.closest?.('button');
    return {
      expected: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topText: topButton?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topRole: topButton?.getAttribute?.('role') ?? null,
      topAriaLabel: topButton?.getAttribute?.('aria-label') ?? null,
    };
  });
  assert(
    operatorHit.topRole === 'menuitemradio' && operatorHit.topText === 'Does not contain',
    `Filter condition menu option should be the top click target, not a backdrop: ${JSON.stringify(operatorHit)}`,
  );
  await doesNotContain.click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-filter-row] button[aria-label="Filter condition"]')
        ?.textContent
        ?.includes('Does not contain'),
    null,
    { timeout: options.timeoutMs },
  );

  await conditionButton.click({ timeout: options.timeoutMs });
  await page.getByRole('menuitemradio', { name: 'Contains', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const valueButton = row.locator('button[aria-label="Filter value for 계약DB"]');
  await valueButton.click({ timeout: options.timeoutMs });
  const currentPageOption = page.getByRole('menuitemradio', { name: 'Current page', exact: true });
  await currentPageOption.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const adjacentMenuState = await page.evaluate(() => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]')).map((menu) => ({
      label: menu.getAttribute('aria-label'),
      text: menu.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      rect: (() => {
        const rect = menu.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          bottom: Math.round(rect.bottom),
        };
      })(),
    }));
    return {
      menus,
      hasConditionMenu: menus.some((menu) => menu.label === 'Filter condition'),
      hasValueMenu: menus.some((menu) => menu.label === 'Filter value for 계약DB' && menu.text.includes('Current page')),
      viewportHeight: window.innerHeight,
    };
  });
  assert(
    adjacentMenuState.hasValueMenu && !adjacentMenuState.hasConditionMenu,
    `Clicking the adjacent Current page selector should replace the condition menu instead of being swallowed: ${JSON.stringify(adjacentMenuState)}`,
  );
  await page.screenshot({
    path: join(options.screenshotDir, `desktop-first-database-filter-current-page-menu${screenshotSuffix ? `-${screenshotSuffix}` : ''}.png`),
    fullPage: false,
  });

  await currentPageOption.click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-filter-row] button[aria-label="Filter value for 계약DB"]')
        ?.textContent
        ?.includes('Current page'),
    null,
    { timeout: options.timeoutMs },
  );
  await page.screenshot({
    path: join(options.screenshotDir, `desktop-first-database-filter-current-page-selected${screenshotSuffix ? `-${screenshotSuffix}` : ''}.png`),
    fullPage: false,
  });

  await dialog.getByRole('button', { name: 'Clear all', exact: true }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-filter-row]').length === 0,
    null,
    { timeout: options.timeoutMs },
  );
  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.getByRole('toolbar', { name: 'Database toolbar' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectSelectedTab(page, 'Table', seed.viewIds.table, false);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);
}

async function assertSecondFilterPropertySelectLayering(page) {
  const toolbar = page.getByRole('toolbar', { name: 'Database toolbar' });
  await toolbar.getByRole('button', { name: 'Filter', exact: true }).click({ timeout: options.timeoutMs });

  const dialog = page.getByRole('dialog', { name: 'Filters' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Add filter', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Add filter', exact: true }).click({ timeout: options.timeoutMs });

  const row = dialog.locator('[data-filter-row]').last();
  const propertyButton = row.locator('button[aria-label="Filter property"]');
  await propertyButton.click({ timeout: options.timeoutMs });

  const statusOption = page.getByRole('menuitemradio', { name: '상태', exact: true });
  await statusOption.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const layering = await statusOption.evaluate((button) => {
    const optionRect = button.getBoundingClientRect();
    const top = document.elementFromPoint(optionRect.left + optionRect.width / 2, optionRect.top + optionRect.height / 2);
    const topButton = top?.closest?.('button');
    const menu = button.closest('[role="menu"]');
    const dialog = document.querySelector('[role="dialog"][aria-label="Filters"]');
    const addFilter = Array.from(dialog?.querySelectorAll('button') ?? [])
      .find((candidate) => candidate.textContent?.replace(/\s+/g, ' ').trim() === 'Add filter');
    const rect = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const r = node.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        bottom: Math.round(r.bottom),
        right: Math.round(r.right),
      };
    };
    return {
      expectedText: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topText: topButton?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topRole: topButton?.getAttribute?.('role') ?? null,
      topAriaLabel: topButton?.getAttribute?.('aria-label') ?? null,
      menuZIndex: menu instanceof HTMLElement ? getComputedStyle(menu).zIndex : null,
      dialogZIndex: dialog instanceof HTMLElement ? getComputedStyle(dialog).zIndex : null,
      optionRect: rect(button),
      menuRect: rect(menu),
      dialogRect: rect(dialog),
      addFilterRect: rect(addFilter),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  assert(
    layering.topRole === 'menuitemradio' && layering.topText === '상태',
    `Second filter property menu should sit above the filter popover chrome and receive clicks: ${JSON.stringify(layering)}`,
  );
  assert(
    Number(layering.menuZIndex) > Number(layering.dialogZIndex) &&
      layering.menuRect &&
      layering.menuRect.bottom <= layering.viewport.height,
    `Second filter property menu should be layered above the filter dialog and stay inside the viewport: ${JSON.stringify(layering)}`,
  );

  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-low-filter-second-property-menu.png'),
    fullPage: false,
  });
  await statusOption.click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[data-filter-row] button[aria-label="Filter property"]'))
        .at(-1)
        ?.textContent
        ?.includes('상태'),
    null,
    { timeout: options.timeoutMs },
  );
}

async function assertPropertyHeaderContextMenu(page, seed, screenshotSuffix = '') {
  await expectSelectedTab(page, 'Table', seed.viewIds.table, false);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);

  const propertyName = seed.propertyNames?.[0] ?? '이름';
  const header = page.getByRole('button', { name: `${propertyName} property options`, exact: true });
  await header.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const box = await header.boundingBox();
  assert(box, 'database property header should have a measurable trigger box');
  await page.mouse.click(
    Math.round(box.x + Math.min(72, Math.max(16, box.width / 2))),
    Math.round(box.y + box.height / 2),
    { button: 'right' },
  );

  const dialog = page.getByRole('dialog', { name: `${propertyName} property options`, exact: true });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForTimeout(80);
  const contextMenuProbe = await header.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(72, Math.max(16, rect.width / 2)),
      clientY: rect.top + rect.height / 2,
    });
    node.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      targetAriaLabel: node.getAttribute('aria-label'),
    };
  });

  const metrics = await page.evaluate((name) => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
      .find((node) => node.getAttribute('aria-label') === `${name} property options`);
    const header = Array.from(document.querySelectorAll('[data-table-property-header] button'))
      .find((node) => node.getAttribute('aria-label') === `${name} property options`);
    const rowMenu = Array.from(document.querySelectorAll('[role="menu"]'))
      .find((node) => node.getAttribute('aria-label')?.startsWith('Database row actions for'));
    const dialogRect = dialog instanceof HTMLElement ? dialog.getBoundingClientRect() : null;
    const headerRect = header instanceof HTMLElement ? header.getBoundingClientRect() : null;
    const text = dialog instanceof HTMLElement ? dialog.textContent ?? '' : '';
    return {
      dialogVisible: visible(dialog),
      rowMenuVisible: visible(rowMenu),
      hasPropertyName: text.includes(name),
      hasEditRoute: text.includes('Edit property'),
      hasTypeRoute: text.includes('Change type'),
      dialogRect: dialogRect
        ? {
            x: Math.round(dialogRect.x),
            y: Math.round(dialogRect.y),
            width: Math.round(dialogRect.width),
            height: Math.round(dialogRect.height),
          }
        : null,
      headerRect: headerRect
        ? {
            x: Math.round(headerRect.x),
            y: Math.round(headerRect.y),
            width: Math.round(headerRect.width),
            height: Math.round(headerRect.height),
          }
        : null,
    };
  }, propertyName);

  await page.screenshot({
    path: join(
      options.screenshotDir,
      `desktop-first-database-property-header-context-menu${screenshotSuffix ? `-${screenshotSuffix}` : ''}.png`,
    ),
    fullPage: false,
  });

  assert(
    contextMenuProbe.defaultPrevented === true,
    `right-clicking a property header should prevent the browser/native context menu: ${JSON.stringify({ contextMenuProbe, metrics })}`,
  );
  assert(
    metrics.dialogVisible &&
      metrics.hasPropertyName &&
      metrics.hasEditRoute &&
      metrics.hasTypeRoute &&
      !metrics.rowMenuVisible,
    `right-clicking a property header should open the property menu, not the row menu: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.dialogRect &&
      metrics.headerRect &&
      metrics.dialogRect.y >= metrics.headerRect.y &&
      Math.abs(metrics.dialogRect.x - metrics.headerRect.x) <= 24,
    `property header context menu should anchor near the clicked header: ${JSON.stringify(metrics)}`,
  );

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function assertRowContextMenu(page, seed) {
  await expectSelectedTab(page, 'Table', seed.viewIds.table, false);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);

  const firstTitleInput = page.locator('[data-table-title-input]').first();
  await firstTitleInput.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const targetBox = await firstTitleInput.boundingBox();
  assert(targetBox, 'database first row title input should have a measurable box');

  const contextMenuProbe = await firstTitleInput.evaluate((node) => {
    const row = node.closest('[data-table-row-id]');
    const rect = node.getBoundingClientRect();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(48, Math.max(8, rect.width / 2)),
      clientY: rect.top + rect.height / 2,
    });
    row?.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      rowId: row instanceof HTMLElement ? row.dataset.tableRowId : null,
    };
  });

  await page.mouse.click(
    Math.round(targetBox.x + Math.min(48, Math.max(8, targetBox.width / 2))),
    Math.round(targetBox.y + targetBox.height / 2),
    { button: 'right' },
  );

  const menu = page.getByRole('menu', { name: /Database row actions for/ });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForTimeout(80);

  const closedMetrics = await collectRowContextMenuMetrics(page, contextMenuProbe.rowId);
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-first-database-row-context-menu.png'),
    fullPage: false,
  });

  for (const label of [
    'Add to Favorites',
    'Edit icon',
    'Edit properties',
    'Open in',
    'Comments',
    'Copy link',
    'Duplicate',
    'Move to',
    'Move to Trash',
    'Last edited',
  ]) {
    assert(
      closedMetrics.menuText.includes(label),
      `database row context menu should include "${label}": ${JSON.stringify(closedMetrics)}`,
    );
  }
  assert(
    contextMenuProbe.defaultPrevented === true,
    `right-clicking a row title cell should prevent the browser/native context menu: ${JSON.stringify({ contextMenuProbe, closedMetrics })}`,
  );
  assert(
    /^Database row actions for/.test(closedMetrics.menuAriaLabel ?? '') &&
      closedMetrics.selectedRowVisible &&
      closedMetrics.selectedRowId === contextMenuProbe.rowId,
    `right-clicking a row title cell should select the row and open the database-row menu: ${JSON.stringify({ contextMenuProbe, closedMetrics })}`,
  );
  assert(
    !closedMetrics.titleCellIconVisible && !closedMetrics.menuPageInfoIconVisible,
    `database rows without an explicit icon should not show a default page icon in the title cell or row menu: ${JSON.stringify(closedMetrics)}`,
  );

  await menu.getByRole('menuitem', { name: /^Open in/ }).click({ timeout: options.timeoutMs });
  await menu.getByRole('menuitem', { name: 'Side peek', exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const openInMetrics = await collectRowContextMenuMetrics(page, contextMenuProbe.rowId);
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-first-database-row-context-menu-open-in.png'),
    fullPage: false,
  });
  for (const label of ['Side peek', 'Center peek', 'Full page', 'Open in new tab']) {
    assert(
      openInMetrics.menuText.includes(label),
      `database row Open in submenu should include "${label}": ${JSON.stringify(openInMetrics)}`,
    );
  }

  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.mouse.click(
    Math.round(targetBox.x + Math.min(48, Math.max(8, targetBox.width / 2))),
    Math.round(targetBox.y + targetBox.height / 2),
    { button: 'right' },
  );
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('menuitem', { name: /^Edit properties/ }).click({ timeout: options.timeoutMs });

  const rowPeek = page.getByRole('dialog', { name: `${seed.rowTitles[0]} preview`, exact: true });
  await rowPeek.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const propertiesMenu = page.getByRole('menu', { name: 'Customize properties', exact: true });
  await propertiesMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-first-database-row-context-menu-edit-properties.png'),
    fullPage: false,
  });
  const propertyMenuMetrics = await propertiesMenu.evaluate((node) => ({
    text: node.textContent ?? '',
    searchInputFocused: node.querySelector('input') === document.activeElement,
    rect: (() => {
      const rect = node.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    })(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }));
  assert(
    propertyMenuMetrics.text.includes('상태') &&
      propertyMenuMetrics.text.includes('마감일') &&
      propertyMenuMetrics.searchInputFocused &&
      propertyMenuMetrics.rect.left >= 0 &&
      propertyMenuMetrics.rect.right <= propertyMenuMetrics.viewport.width &&
      propertyMenuMetrics.rect.top >= 0 &&
      propertyMenuMetrics.rect.bottom <= propertyMenuMetrics.viewport.height,
    `Edit properties should open the row property customization menu with focus in search: ${JSON.stringify(propertyMenuMetrics)}`,
  );
}

async function collectRowContextMenuMetrics(page, expectedRowId) {
  return page.evaluate((rowId) => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const menu = Array.from(document.querySelectorAll('[role="menu"]'))
      .find((node) => node.getAttribute('aria-label')?.startsWith('Database row actions for'));
    const targetRow = rowId
      ? document.querySelector(`[data-table-row-id="${CSS.escape(rowId)}"]`)
      : document.querySelector('[data-table-row-id]');
    const selectedRow = document.querySelector('[data-table-row-id][data-row-selected="true"]');
    const titleCellIcon = targetRow?.querySelector('[class*="titleCellIcon"]');
    const menuPageInfoIcon = menu instanceof HTMLElement
      ? menu.querySelector('[class*="pageInfoIcon"]')
      : null;
    return {
      menuVisible: visible(menu),
      menuAriaLabel: menu?.getAttribute('aria-label') ?? '',
      menuText: menu?.textContent ?? '',
      selectedRowVisible: visible(selectedRow),
      selectedRowId: selectedRow instanceof HTMLElement ? selectedRow.dataset.tableRowId : null,
      expectedRowId: rowId,
      titleCellIconVisible: visible(titleCellIcon),
      menuPageInfoIconVisible: visible(menuPageInfoIcon),
    };
  }, expectedRowId);
}

async function assertViewTabActionMenu(page, seed, screenshotSuffix = '') {
  await expectSelectedTab(page, 'Table', seed.viewIds.table, false);
  await expectCellInputValue(page, 0, 0, seed.rowTitles[0]);

  const tableTab = page.getByRole('tab', { name: 'Table', exact: true });
  await tableTab.click({ timeout: options.timeoutMs });
  const tableDialog = page.getByRole('dialog', { name: 'Table view actions', exact: true });
  await tableDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForTimeout(80);

  const tableMetrics = await collectViewTabActionMenuMetrics(page, 'Table');
  await page.screenshot({
    path: join(
      options.screenshotDir,
      `desktop-first-database-view-tab-menu${screenshotSuffix ? `-${screenshotSuffix}` : ''}.png`,
    ),
    fullPage: false,
  });

  assert(
    tableMetrics.dialogVisible &&
      tableMetrics.inputValue === 'Table' &&
      tableMetrics.menuText.includes('View name') &&
      tableMetrics.menuText.includes('Open as full page') &&
      tableMetrics.menuText.includes('Copy view link') &&
      tableMetrics.menuText.includes('Duplicate view') &&
      tableMetrics.menuText.includes('Delete view'),
    `clicking the selected visible view tab should open a complete app view menu: ${JSON.stringify(tableMetrics)}`,
  );
  assert(
    tableMetrics.dialogRect &&
      tableMetrics.tabRect &&
      tableMetrics.dialogRect.y >= tableMetrics.tabRect.y &&
      Math.abs(tableMetrics.dialogRect.x - tableMetrics.tabRect.x) <= 32,
    `selected visible view tab menu should anchor near the clicked tab: ${JSON.stringify(tableMetrics)}`,
  );

  await page.keyboard.press('Escape');
  await tableDialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });

  const boardTab = page.getByRole('tab', { name: 'Board', exact: true });
  await boardTab.click({ timeout: options.timeoutMs });
  await expectSelectedTab(page, 'Board', seed.viewIds.board);
  await page.waitForTimeout(80);
  const afterInactiveClick = await collectViewTabActionMenuMetrics(page, 'Board');
  assert(
    !afterInactiveClick.dialogVisible,
    `clicking an inactive visible view tab should select it first instead of opening actions immediately: ${JSON.stringify(afterInactiveClick)}`,
  );

  await boardTab.click({ timeout: options.timeoutMs });
  const boardDialog = page.getByRole('dialog', { name: 'Board view actions', exact: true });
  await boardDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.keyboard.press('Escape');
  await boardDialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });

  const contextMenuProbe = await boardTab.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(64, Math.max(16, rect.width / 2)),
      clientY: rect.top + rect.height / 2,
    });
    node.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      targetAriaLabel: node.getAttribute('aria-label'),
    };
  });
  await boardDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const contextMetrics = await collectViewTabActionMenuMetrics(page, 'Board');
  assert(
    contextMenuProbe.defaultPrevented === true && contextMetrics.dialogVisible,
    `right-clicking a visible view tab should prevent the browser/native context menu and open the app menu: ${JSON.stringify({ contextMenuProbe, contextMetrics })}`,
  );
  await page.keyboard.press('Escape');
  await boardDialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function collectViewTabActionMenuMetrics(page, viewName) {
  return page.evaluate((name) => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const rect = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const box = node.getBoundingClientRect();
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        bottom: Math.round(box.bottom),
        right: Math.round(box.right),
      };
    };
    const tab = document.querySelector(`[role="tab"][aria-label="${name}"]`);
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
      .find((node) => node.getAttribute('aria-label') === `${name} view actions`);
    const input = dialog instanceof HTMLElement ? dialog.querySelector('input') : null;
    return {
      dialogVisible: visible(dialog),
      inputValue: input instanceof HTMLInputElement ? input.value : null,
      menuText: dialog instanceof HTMLElement ? dialog.textContent?.replace(/\s+/g, ' ').trim() ?? '' : '',
      tabAriaExpanded: tab?.getAttribute('aria-expanded') ?? null,
      tabAriaSelected: tab?.getAttribute('aria-selected') ?? null,
      tabRect: rect(tab),
      dialogRect: rect(dialog),
      visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter(visible)
        .map((node) => ({
          label: node.getAttribute('aria-label'),
          text: node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '',
          rect: rect(node),
        })),
    };
  }, viewName);
}

async function assertDefaultSummaryControlsStayQuiet(page, baseUrl, seed) {
  try {
    await updateTableViewConfig(baseUrl, seed, {
      propertyOrder: seed.visibleProperties,
      visibleProperties: seed.visibleProperties,
      groupBy: seed.statusPropId,
    });
    await openDatabase(page, baseUrl, seed);
    await moveMouseToIdleChrome(page);

    const idle = await collectTableSummaryButtonMetrics(page);
    assert(
      idle.emptyButtons.length >= 2,
      `default table summary should expose empty calculation buttons to the DOM: ${JSON.stringify(idle)}`,
    );
    assert(
      idle.emptyButtons.every((button) => !button.visible),
      `default table summary row-count/Calculate controls should stay quiet at rest: ${JSON.stringify(idle.emptyButtons)}`,
    );

    await page.locator('[data-table-summary-row]').hover({ timeout: options.timeoutMs });
    await page.waitForTimeout(180);
    const hover = await collectTableSummaryButtonMetrics(page);
    assert(
      hover.emptyButtons.some((button) => button.visible),
      `default table summary controls should reveal on intentional summary-row hover: ${JSON.stringify(hover.emptyButtons)}`,
    );
  } finally {
    await updateTableViewConfig(baseUrl, seed, {
      propertyOrder: seed.visibleProperties,
      visibleProperties: seed.visibleProperties,
      groupBy: seed.statusPropId,
      tableCalculations: { [seed.amountPropId]: 'sum' },
    });
    await openDatabase(page, baseUrl, seed);
    await moveMouseToIdleChrome(page);
  }
}

async function collectTableSummaryButtonMetrics(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-table-summary-row]');
    const buttons = Array.from(row?.querySelectorAll('button') ?? []).map((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const opacity = Number.parseFloat(style.opacity || '1');
      return {
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        empty: button.getAttribute('data-empty') === 'true',
        rowCount: button.getAttribute('data-row-count') === 'true',
        opacity,
        visible: style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          opacity > 0.05 &&
          rect.width > 0 &&
          rect.height > 0,
      };
    });
    return {
      exists: row instanceof HTMLElement,
      buttons,
      emptyButtons: buttons.filter((button) => button.empty),
    };
  });
}

async function updateTableViewConfig(baseUrl, seed, config) {
  await callFunction(baseUrl, seed.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: seed.viewIds.table,
    // Routing hint for the workspace-DO split (view ids are not pages).
    databaseId: seed.databaseId,
    patch: {
      config,
    },
  });
}

async function assertBoardView(page, seed) {
  await selectView(page, 'Board', seed.viewIds.board);
  await expectSelectedTab(page, 'Board', seed.viewIds.board);
  const panel = currentPanel(page);
  await panel.getByRole('button', { name: `${seed.statusOptionNames[0]} group options` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectOpenRowButton(page, seed.rowTitles[0]);
}

async function assertListView(page, seed) {
  await selectView(page, 'List', seed.viewIds.list);
  await expectSelectedTab(page, 'List', seed.viewIds.list);
  await expectOpenRowButton(page, seed.rowTitles[1]);
}

async function assertGalleryView(page, seed) {
  await selectView(page, 'Gallery', seed.viewIds.gallery);
  await expectSelectedTab(page, 'Gallery', seed.viewIds.gallery);
  await expectOpenRowButton(page, seed.rowTitles[2]);
}

async function assertCalendarView(page, seed) {
  await selectView(page, 'Calendar', seed.viewIds.calendar);
  await expectSelectedTab(page, 'Calendar', seed.viewIds.calendar);
  const panel = currentPanel(page);
  await panel.getByRole('button', { name: 'Previous month' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await panel.getByRole('button', { name: 'Next month' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectOpenRowButton(page, seed.rowTitles[0]);
}

async function assertTimelineView(page, seed) {
  await selectView(page, 'Timeline', seed.viewIds.timeline);
  await expectSelectedTab(page, 'Timeline', seed.viewIds.timeline);
  const panel = currentPanel(page);
  await panel.getByRole('group', { name: 'Timeline zoom' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectOpenRowButton(page, seed.rowTitles[0]);
}

async function assertDirectViewUrl(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?v=${seed.viewIds.timeline}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await expectSelectedTab(page, 'Timeline', seed.viewIds.timeline);
  await currentPanel(page).getByRole('group', { name: 'Timeline zoom' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectOpenRowButton(page, seed.rowTitles[0]);
}

async function assertFirstDatabaseVisualContract(page, seed) {
  await assertSidebarTopActionRail(page);

  const metrics = await page.evaluate((expected) => {
    const visibleElement = (element) => element instanceof HTMLElement && element.offsetParent !== null;
    const cssAlpha = (value) => {
      if (!value || value === 'transparent') return 0;
      const slash = value.match(/\/\s*([0-9.]+%?)/);
      if (slash) {
        const raw = slash[1];
        const parsed = Number.parseFloat(raw);
        return raw.endsWith('%') ? parsed / 100 : parsed;
      }
      const rgba = value.match(/^rgba?\((.+)\)$/);
      if (!rgba) return 1;
      const parts = rgba[1].split(',').map((part) => part.trim());
      if (parts.length >= 4) return Number.parseFloat(parts[3]);
      return 1;
    };
    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const tablist = document.querySelector('[role="tablist"][aria-label$=" views"]');
    const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const selectedTabWrap = selectedTab?.closest('[data-view-tab-wrap]');
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
    const firstCell = document.querySelector('[data-table-cell][data-row-index="0"][data-col-index="0"]');
    const firstCellInput = firstCell?.querySelector('input[type="text"]');
    const summaryRow = document.querySelector('[data-table-summary-row]');
    const secondRowCell = document.querySelector('[data-table-cell][data-row-index="1"][data-col-index="0"]');
    const newRow = document.querySelector('[data-table-new-row]');
    const addPropertyButton = document.querySelector(
      'button[aria-label="속성 추가"], button[aria-label="Add a property"]',
    );
    const addPropertyRail = addPropertyButton?.parentElement;
    const headerRow = addPropertyRail?.parentElement;
    const firstDataRow = firstCell?.parentElement;
    const presence = document.querySelector('[data-testid="page-presence"]');

    if (
      !(doc instanceof HTMLElement) ||
      !(scroll instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(tablist instanceof HTMLElement) ||
      !(selectedTab instanceof HTMLElement) ||
      !(selectedTabWrap instanceof HTMLElement) ||
      !(toolbar instanceof HTMLElement) ||
      !(firstCell instanceof HTMLElement) ||
      !(firstCellInput instanceof HTMLInputElement) ||
      !(secondRowCell instanceof HTMLElement) ||
      !(newRow instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'missing first database visual markers' };
    }

    const docRect = doc.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const tablistRect = tablist.getBoundingClientRect();
    const selectedTabRect = selectedTab.getBoundingClientRect();
    const selectedTabWrapRect = selectedTabWrap.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const firstCellRect = firstCell.getBoundingClientRect();
    const secondRowCellRect = secondRowCell.getBoundingClientRect();
    const newRowRect = newRow.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const selectedTabStyle = getComputedStyle(selectedTab);
    const selectedTabWrapStyle = getComputedStyle(selectedTabWrap);
    const toolbarStyle = getComputedStyle(toolbar);
    const addPropertyButtonRect =
      addPropertyButton instanceof HTMLElement ? addPropertyButton.getBoundingClientRect() : null;
    const allCells = Array.from(document.querySelectorAll('[data-table-cell]'))
      .filter((cell) => cell instanceof HTMLElement && cell.offsetParent !== null);
    const buttonLabel = (button) =>
      button.getAttribute('aria-label') ||
      button.getAttribute('title') ||
      button.textContent?.replace(/\s+/g, ' ').trim() ||
      '';
    const toolbarButtons = Array.from(toolbar.querySelectorAll('button'))
      .filter((button) => {
        if (!(button instanceof HTMLElement)) return false;
        const style = getComputedStyle(button);
        const r = button.getBoundingClientRect();
        return button.offsetParent !== null &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.05 &&
          style.pointerEvents !== 'none' &&
          r.width > 0 &&
          r.height > 0;
      })
      .map((button) => ({
        label: buttonLabel(button),
      }));
    const visibleSummaryTexts = summaryRow instanceof HTMLElement
      ? Array.from(summaryRow.querySelectorAll('button'))
          .filter((button) => {
            if (!visibleElement(button)) return false;
            const style = getComputedStyle(button);
            const r = button.getBoundingClientRect();
            return style.visibility !== 'hidden' &&
              Number.parseFloat(style.opacity || '0') > 0.05 &&
              r.width > 0 &&
              r.height > 0;
          })
          .map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .filter(Boolean)
      : [];
    const groupSubtotalTexts = Array.from(document.querySelectorAll('[data-table-group-subtotal]'))
      .filter((item) => item instanceof HTMLElement && visibleElement(item))
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
    return {
      ok: true,
      scrollTop: scrollRect.top,
      scrollLeft: scrollRect.left,
      docWidth: docRect.width,
      docLeft: docRect.left,
      titleTop: titleRect.top,
      titleLeft: titleRect.left,
      titleBottom: titleRect.bottom,
      titleWidth: titleRect.width,
      titleText: title.textContent?.trim() ?? '',
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      tablistTop: tablistRect.top,
      tablistLeft: tablistRect.left,
      tablistBottom: tablistRect.bottom,
      tablistWidth: tablistRect.width,
      tablistHeight: tablistRect.height,
      tablistLabel: tablist.getAttribute('aria-label') ?? '',
      selectedTabText: selectedTab.textContent?.trim() ?? '',
      selectedTabFontSize: Number.parseFloat(selectedTabStyle.fontSize),
      selectedTabHeight: selectedTabRect.height,
      selectedTabBackgroundAlpha: cssAlpha(selectedTabStyle.backgroundColor),
      selectedTabWrapHeight: selectedTabWrapRect.height,
      selectedTabWrapBackgroundAlpha: cssAlpha(selectedTabWrapStyle.backgroundColor),
      // The wrap paints var(--bg-app) (same as body) to mask the rail's bottom
      // border while tabs scroll — visually still text/underline selection.
      selectedTabWrapMatchesAppBackground:
        selectedTabWrapStyle.backgroundColor === getComputedStyle(document.body).backgroundColor,
      toolbarTop: toolbarRect.top,
      toolbarBottom: toolbarRect.bottom,
      toolbarLeft: toolbarRect.left,
      toolbarHeight: toolbarRect.height,
      toolbarDisplay: toolbarStyle.display,
      toolbarButtonCount: toolbarButtons.length,
      toolbarButtonLabels: toolbarButtons.map((button) => button.label),
      tableHeadTop: document.querySelector('[data-table-head]')?.getBoundingClientRect().top ?? null,
      firstCellTop: firstCellRect.top,
      firstCellLeft: firstCellRect.left,
      firstCellWidth: firstCellRect.width,
      firstCellHeight: firstCellRect.height,
      firstCellValue: firstCellInput.value,
      secondRowCellTop: secondRowCellRect.top,
      newRowTop: newRowRect.top,
      // The row spans the full grid incl. the row-select gutter; its inner
      // label is what aligns with the title column (grid-column: 2 / -1).
      newRowLeft: (newRow?.querySelector('span') ?? newRow)?.getBoundingClientRect().left ?? newRowRect.left,
      newRowHeight: newRowRect.height,
      addPropertyButtonLabel: addPropertyButton instanceof HTMLElement
        ? buttonLabel(addPropertyButton)
        : '',
      addPropertyButtonText: addPropertyButton instanceof HTMLElement
        ? addPropertyButton.textContent?.replace(/\s+/g, ' ').trim() ?? ''
        : '',
      addPropertyButtonWidth: addPropertyButtonRect?.width ?? 0,
      addPropertyButtonRight: addPropertyButtonRect?.right ?? 0,
      viewportWidth: document.documentElement.clientWidth,
      headerChildCount: headerRow instanceof HTMLElement
        ? Array.from(headerRow.children).filter(visibleElement).length
        : 0,
      firstDataRowChildCount: firstDataRow instanceof HTMLElement
        ? Array.from(firstDataRow.children).filter(visibleElement).length
        : 0,
      summaryChildCount: summaryRow instanceof HTMLElement
        ? Array.from(summaryRow.children).filter(visibleElement).length
        : 0,
      visibleSummaryTexts,
      groupSubtotalTexts,
      visibleCellCount: allCells.length,
      presenceVisible: presence instanceof HTMLElement,
    };
  }, {
    databaseTitle: seed.databaseTitle,
    visiblePropertyCount: seed.visibleProperties.length,
  });

  assert(metrics.ok, metrics.reason ?? 'first database visual contract could not run');
  assert(
    metrics.titleText === seed.databaseTitle,
    `first database title should render seeded title, got "${metrics.titleText}"`,
  );
  assert(
    metrics.tablistLabel === `${seed.databaseTitle} views`,
    `first database tablist should belong to the seeded database, got "${metrics.tablistLabel}"`,
  );
  assert(
    metrics.docWidth >= 900 && metrics.docWidth <= 1500,
    `first database should use the wider database canvas, got ${Math.round(metrics.docWidth)}px`,
  );
  assert(
    metrics.titleTop - metrics.scrollTop >= 80 && metrics.titleTop - metrics.scrollTop <= 145,
    `first database title should sit near the document top, got ${Math.round(metrics.titleTop - metrics.scrollTop)}px from page viewport top`,
  );
  assert(
    metrics.titleLeft - metrics.scrollLeft >= 40 && metrics.titleLeft - metrics.scrollLeft <= 90,
    `first database title should align to the database canvas gutter, got ${Math.round(metrics.titleLeft - metrics.scrollLeft)}px from content left`,
  );
  assert(
    metrics.titleFontSize >= 36 && metrics.titleFontSize <= 48,
    `first database title should be page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    metrics.tablistTop - metrics.titleBottom >= 8 && metrics.tablistTop - metrics.titleBottom <= 36,
    `database view tabs should follow the title closely, got ${Math.round(metrics.tablistTop - metrics.titleBottom)}px gap`,
  );
  assert(
    Math.abs(metrics.tablistLeft - metrics.titleLeft) <= 2,
    `database view tabs should align with title, got ${Math.round(metrics.tablistLeft - metrics.titleLeft)}px offset`,
  );
  assert(
    metrics.tablistHeight >= 30 && metrics.tablistHeight <= 40,
    `database view tabs should stay compact, got ${Math.round(metrics.tablistHeight)}px height`,
  );
  assert(
    metrics.selectedTabText.includes('Table') && metrics.selectedTabFontSize >= 13 && metrics.selectedTabFontSize <= 15,
    `selected database tab should be compact Table tab, got "${metrics.selectedTabText}" at ${metrics.selectedTabFontSize}px`,
  );
  assert(
    metrics.selectedTabHeight >= 28 &&
      metrics.selectedTabHeight <= 34 &&
      metrics.selectedTabWrapHeight >= 30 &&
      metrics.selectedTabWrapHeight <= 36,
    `selected database tab should stay inside the compact tab rail instead of reading as a large chip, got tab=${Math.round(metrics.selectedTabHeight)}px wrap=${Math.round(metrics.selectedTabWrapHeight)}px`,
  );
  assert(
    metrics.selectedTabBackgroundAlpha <= 0.01 &&
      (metrics.selectedTabWrapBackgroundAlpha <= 0.01 || metrics.selectedTabWrapMatchesAppBackground === true),
    `selected database tab should use text/underline selection rather than a filled chip, got alpha tab=${metrics.selectedTabBackgroundAlpha} wrap=${metrics.selectedTabWrapBackgroundAlpha}`,
  );
  assert(
    metrics.toolbarTop - metrics.tablistBottom >= -1 && metrics.toolbarTop - metrics.tablistBottom <= 8,
    `database toolbar should sit directly under view tabs, got ${Math.round(metrics.toolbarTop - metrics.tablistBottom)}px gap`,
  );
  assert(
    Math.abs(metrics.toolbarLeft - metrics.titleLeft) <= 2,
    `database toolbar should align with title/tabs, got ${Math.round(metrics.toolbarLeft - metrics.titleLeft)}px offset`,
  );
  assert(
    metrics.toolbarHeight >= 28 && metrics.toolbarHeight <= 38 && metrics.toolbarButtonCount >= 4,
    `database toolbar should be compact and useful, got height=${metrics.toolbarHeight}px buttons=${metrics.toolbarButtonCount}`,
  );
  assert(
    ['Properties', 'Filter', 'Sort', 'Search database rows', 'New database page'].every((label) =>
      metrics.toolbarButtonLabels.includes(label)
    ),
    `database toolbar should expose Properties, Filter, Sort, Search, and New at rest: ${JSON.stringify(metrics.toolbarButtonLabels)}`,
  );
  assert(
    metrics.tableHeadTop - metrics.toolbarBottom >= 4 &&
      metrics.tableHeadTop - metrics.toolbarBottom <= 16 &&
      // Seeded table view is grouped by 상태, so the first data cell sits below
      // the 34px property header AND the ~35px group header row.
      metrics.firstCellTop - metrics.toolbarBottom >= 4 &&
      metrics.firstCellTop - metrics.toolbarBottom <= 96,
    `database table should start below toolbar without a large blank gap, got head-gap=${Math.round(metrics.tableHeadTop - metrics.toolbarBottom)}px cell-gap=${Math.round(metrics.firstCellTop - metrics.toolbarBottom)}px`,
  );
  assert(
    Math.abs(metrics.firstCellLeft - metrics.titleLeft) <= 3,
    `database first column should align with title/tabs, got ${Math.round(metrics.firstCellLeft - metrics.titleLeft)}px offset`,
  );
  assert(
    metrics.firstCellHeight >= 28 && metrics.firstCellHeight <= 42,
    `database rows should stay Notion-density compact, got first row height ${Math.round(metrics.firstCellHeight)}px`,
  );
  assert(
    // The seeded table view is grouped by 상태 and every seeded row has a
    // different status, so consecutive rows sit in different groups — the gap
    // includes one ~35px group header on top of the ~35px row rhythm.
    metrics.secondRowCellTop > metrics.firstCellTop && metrics.secondRowCellTop - metrics.firstCellTop <= 84,
    `database second row should follow within one group boundary of the first row, got ${Math.round(metrics.secondRowCellTop - metrics.firstCellTop)}px gap`,
  );
  assert(
    metrics.firstCellValue === seed.rowTitles[0],
    `database first row should render seeded title, got "${metrics.firstCellValue}"`,
  );
  assert(
    metrics.visibleCellCount >= 12,
    `database table should show the seeded property grid, got ${metrics.visibleCellCount} visible cells`,
  );
  assert(
    (metrics.addPropertyButtonLabel === '속성 추가' || metrics.addPropertyButtonLabel === 'Add a property') &&
      metrics.addPropertyButtonWidth >= 20 &&
      metrics.addPropertyButtonRight <= metrics.viewportWidth,
    `database add-property header affordance should stay visible and unclipped: ${JSON.stringify({
      label: metrics.addPropertyButtonLabel,
      text: metrics.addPropertyButtonText,
      width: metrics.addPropertyButtonWidth,
      right: metrics.addPropertyButtonRight,
      viewportWidth: metrics.viewportWidth,
    })}`,
  );
  assert(
    // visible properties + the row-select gutter head (2a7bca0c) + one
    // add-property rail.
    metrics.headerChildCount === seed.visibleProperties.length + 2,
    `database header should have visible properties plus the row gutter and one add-property rail, got ${metrics.headerChildCount} for ${seed.visibleProperties.length} properties`,
  );
  assert(
    // Body rows carry the row-select gutter cell plus the aria-hidden trailing
    // grid filler; the summary row carries only the trailing filler. Anything
    // beyond that would be a phantom data cell from the add-property rail.
    metrics.firstDataRowChildCount === seed.visibleProperties.length + 2 &&
      metrics.summaryChildCount === seed.visibleProperties.length + 1,
    `database add-property rail should not create phantom body/summary cells: ${JSON.stringify({
      body: metrics.firstDataRowChildCount,
      summary: metrics.summaryChildCount,
      visibleProperties: seed.visibleProperties.length,
    })}`,
  );
  assert(
    metrics.visibleSummaryTexts.some((text) => /sum/i.test(text)) &&
      metrics.visibleSummaryTexts.some((text) => text.includes(seed.amountSummaryText)),
    `database table should show the configured amount summary, got ${JSON.stringify(metrics.visibleSummaryTexts)}`,
  );
  assert(
    metrics.groupSubtotalTexts.some((text) => /sum/i.test(text)) &&
      metrics.groupSubtotalTexts.some((text) => text.includes(seed.firstGroupSubtotalText)),
    `database grouped table should show per-group subtotals, got ${JSON.stringify(metrics.groupSubtotalTexts)}`,
  );
  assert(
    !metrics.visibleSummaryTexts.some((text) => /^3 rows$/i.test(text)),
    `database table should not keep the default row count visible when a numeric summary is configured: ${JSON.stringify(metrics.visibleSummaryTexts)}`,
  );
  assert(
    metrics.newRowTop > metrics.secondRowCellTop && metrics.newRowHeight >= 28 && metrics.newRowHeight <= 42,
    `database New row should stay compact and below seeded rows, got top=${metrics.newRowTop} height=${metrics.newRowHeight}`,
  );
  assert(
    Math.abs(metrics.newRowLeft - metrics.titleLeft) <= 3,
    `database New row should align with the table column, got ${Math.round(metrics.newRowLeft - metrics.titleLeft)}px offset`,
  );
  assert(
    metrics.presenceVisible === false,
    'first database should not show a floating presence badge for the current user alone',
  );
}

async function assertSidebarTopActionRail(page) {
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
      return { ok: false, reason: 'missing database sidebar top action rail markers' };
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
    const homeToFirstIconGap = iconRects[0] ? iconRects[0].left - homeRect.right : null;
    const searchRect = iconRects[iconRects.length - 1];
    const previousIconRect = iconRects[iconRects.length - 2];
    const allTops = [homeRect.top, ...iconRects.map((rect) => rect.top)];
    const allCenters = [
      homeRect.top + homeRect.height / 2,
      ...iconRects.map((rect) => rect.top + rect.height / 2),
    ];

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
      homeToFirstIconGap,
      searchSpacer: searchRect && previousIconRect ? searchRect.left - previousIconRect.right : null,
      searchRightInset: searchRect ? railRect.right - searchRect.right : null,
      topSpread: Math.max(...allTops) - Math.min(...allTops),
      centerSpread: Math.max(...allCenters) - Math.min(...allCenters),
    };
  });

  assert(metrics.ok, metrics.reason ?? 'database sidebar top action rail contract could not run');
  assert(
    metrics.railHeight >= 42 && metrics.railHeight <= 48,
    `database sidebar top actions should stay close to the live Notion 32px tab rail rhythm, got ${Math.round(metrics.railHeight)}px`,
  );
  assert(
    metrics.homeText === 'Home' && metrics.homeFits === true,
    `database sidebar Home label should fit without ellipsis, got text=${JSON.stringify(metrics.homeText)} fits=${metrics.homeFits}`,
  );
  assert(
    metrics.homeActive === 'true',
    `database sidebar Home should stay as the active top-rail pill on database pages, got ${metrics.homeActive}`,
  );
  assert(
    metrics.homeWidth >= 76 &&
      metrics.homeWidth <= 108 &&
      metrics.homeHeight >= 31 &&
      metrics.homeHeight <= 34 &&
      metrics.homeRadius >= 15 &&
      metrics.homeIconWidth >= 18.5 &&
      metrics.homeIconWidth <= 19.5 &&
      metrics.homeIconHeight >= 18.5 &&
      metrics.homeIconHeight <= 19.5,
    `database sidebar Home pill should stay compact, rounded, and Notion-reference scaled, got ${JSON.stringify({
      width: Math.round(metrics.homeWidth),
      height: Math.round(metrics.homeHeight),
      radius: Math.round(metrics.homeRadius),
      iconWidth: Math.round(metrics.homeIconWidth),
      iconHeight: Math.round(metrics.homeIconHeight),
    })}`,
  );
  // Confirmed contract ("Hanji sidebar excludes chat/meeting surfaces",
  // docs/confirmed-contracts.md): the top rail must NOT show chat/comment or
  // meeting/update icons, so the approved rail is Home / Inbox / Search
  // (comments+updates slots were removed in 2a7bca0c).
  assert(
    metrics.iconCount === 2 &&
      metrics.iconMinWidth >= 31 &&
      metrics.iconMaxWidth <= 34 &&
      metrics.iconMinHeight >= 31 &&
      metrics.iconMaxHeight <= 34 &&
      metrics.iconMinRadius >= 15 &&
      metrics.iconSvgMinWidth >= 18.5 &&
      metrics.iconSvgMaxWidth <= 19.5,
    `database sidebar top icon buttons should be uniform, compact, and Notion-reference scaled, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topRailIconCount === 3 &&
      metrics.topRailHanjiIconCount === 3 &&
      JSON.stringify(metrics.topRailIconSources) === JSON.stringify(['phosphor']),
    `database sidebar top rail icons should come from the approved imported Phosphor wrapper, got ${JSON.stringify({
      count: metrics.topRailIconCount,
      hanjiCount: metrics.topRailHanjiIconCount,
      sources: metrics.topRailIconSources,
      weights: metrics.topRailIconWeights,
    })}`,
  );
  assert(
    metrics.homeToFirstIconGap >= 2 &&
      metrics.homeToFirstIconGap <= 8 &&
      metrics.searchSpacer >= 4 &&
      metrics.searchRightInset >= 6 &&
      metrics.searchRightInset <= 10,
    `database sidebar top rail should keep Inbox next to the Home pill and a right-aligned search action, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topSpread <= 1 && metrics.centerSpread <= 1,
    `database sidebar top rail buttons should share one row, got topSpread=${metrics.topSpread} centerSpread=${metrics.centerSpread}`,
  );
  assert(
    !/Quick Find|Settings|Account console|Workspace console|Server console|Templates/.test(metrics.railText),
    `database sidebar top rail should not fall back to tall text action rows, got text=${JSON.stringify(metrics.railText)}`,
  );
  assert(
    JSON.stringify(metrics.railSlots) === JSON.stringify(['home', 'inbox', 'search']),
    `database sidebar top rail should stay as Home/inbox/search slots (confirmed contract: no chat/comment or meeting/update icons), got ${JSON.stringify(metrics.railSlots)}`,
  );
  assert(
    metrics.iconActionLabels.every((label) => !/Settings|Templates|Import|Trash/.test(label)),
    `database sidebar top rail should not mix management/template actions into the navigation rail, got ${JSON.stringify(metrics.iconActionLabels)}`,
  );
}

async function assertDatabaseViewShellVisualContract(page, seed, view) {
  await assertSidebarTopActionRail(page);

  const metrics = await page.evaluate((expected) => {
    const visibleElement = (element) =>
      element instanceof HTMLElement && element.offsetParent !== null;
    const rect = (element) => {
      if (!visibleElement(element)) return null;
      const r = element.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const cssAlpha = (value) => {
      if (!value || value === 'transparent') return 0;
      const slash = value.match(/\/\s*([0-9.]+%?)/);
      if (slash) {
        const raw = slash[1];
        const parsed = Number.parseFloat(raw);
        return raw.endsWith('%') ? parsed / 100 : parsed;
      }
      const rgba = value.match(/^rgba?\((.+)\)$/);
      if (!rgba) return 1;
      const parts = rgba[1].split(',').map((part) => part.trim());
      if (parts.length >= 4) return Number.parseFloat(parts[3]);
      return 1;
    };

    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const tablist = document.querySelector('[role="tablist"][aria-label$=" views"]');
    const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const selectedTabWrap = selectedTab?.closest('[data-view-tab-wrap]');
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
    const panel = Array.from(document.querySelectorAll('[role="tabpanel"]')).find(visibleElement);
    const presence = document.querySelector('[data-testid="page-presence"]');

    if (
      !visibleElement(doc) ||
      !visibleElement(scroll) ||
      !visibleElement(title) ||
      !visibleElement(tablist) ||
      !visibleElement(selectedTab) ||
      !visibleElement(selectedTabWrap) ||
      !visibleElement(toolbar) ||
      !visibleElement(panel)
    ) {
      return { ok: false, reason: `missing ${expected.viewName} database view visual markers` };
    }

    const titleStyle = getComputedStyle(title);
    const selectedTabStyle = getComputedStyle(selectedTab);
    const selectedTabWrapStyle = getComputedStyle(selectedTabWrap);
    const toolbarButtons = Array.from(toolbar.querySelectorAll('button')).filter(visibleElement);
    const openButtons = Array.from(panel.querySelectorAll('button, [role="button"]'))
      .filter(visibleElement)
      .filter((item) => (item.getAttribute('aria-label') ?? '').startsWith('Open '));
    const firstOpenButton = openButtons[0] ?? null;
    const openButtonLabels = openButtons.map((item) => item.getAttribute('aria-label') ?? '');
    const cardCoverRects = Array.from(panel.querySelectorAll('[class*="cardCover"]'))
      .filter(visibleElement)
      .map(rect)
      .filter(Boolean);
    const boardGroupButtons = Array.from(panel.querySelectorAll('button[aria-label$=" group options"]'))
      .filter(visibleElement);
    const panelRectValue = rect(panel);
    const boardColumnVisibility = Array.from(panel.querySelectorAll('[class*="boardCol"]'))
      .filter(visibleElement)
      .map((item, index) => {
        const itemRect = rect(item);
        const visibleLeft = Math.max(itemRect.left, panelRectValue.left, 0);
        const visibleRight = Math.min(itemRect.right, panelRectValue.right, window.innerWidth);
        return {
          index,
          left: itemRect.left,
          right: itemRect.right,
          width: itemRect.width,
          visibleWidth: Math.max(0, visibleRight - visibleLeft),
        };
      });
    const visibleBoardColumns = boardColumnVisibility.filter((item) => item.visibleWidth > 8);
    const partiallyVisibleBoardColumns = visibleBoardColumns.filter(
      (item) => item.visibleWidth < item.width - 4,
    );
    const calendarPrevious = panel.querySelector('button[aria-label="Previous month"]');
    const calendarNext = panel.querySelector('button[aria-label="Next month"]');
    const calendarGrid = panel.querySelector('[class*="calendarGrid"]');
    const calendarWeekdayRects = Array.from(panel.querySelectorAll('[class*="calendarWeekday"]'))
      .filter(visibleElement)
      .map(rect)
      .filter(Boolean);
    const timelineZoom = panel.querySelector('[role="group"][aria-label="Timeline zoom"]');
    const timelineDayLabelRects = Array.from(panel.querySelectorAll('[data-timeline-day-label="true"]'))
      .filter(visibleElement)
      .map(rect)
      .filter(Boolean);
    const newPageButton = Array.from(panel.querySelectorAll('button'))
      .filter(visibleElement)
      .find((button) => (button.getAttribute('aria-label') ?? '').startsWith('New page'));
    const timelineDayLabelGaps = timelineDayLabelRects
      .slice(1)
      .map((item, index) => item.left - timelineDayLabelRects[index].left);

    return {
      ok: true,
      scrollTop: rect(scroll).top,
      scrollLeft: rect(scroll).left,
      docRect: rect(doc),
      titleRect: rect(title),
      titleText: title.textContent?.trim() ?? '',
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      tablistRect: rect(tablist),
      tablistLabel: tablist.getAttribute('aria-label') ?? '',
      selectedTabRect: rect(selectedTab),
      selectedTabText: selectedTab.textContent?.trim() ?? '',
      selectedTabFontSize: Number.parseFloat(selectedTabStyle.fontSize),
      selectedTabBackgroundAlpha: cssAlpha(selectedTabStyle.backgroundColor),
      selectedTabWrapRect: rect(selectedTabWrap),
      selectedTabWrapBackgroundAlpha: cssAlpha(selectedTabWrapStyle.backgroundColor),
      // The wrap paints var(--bg-app) (same as body) to mask the rail's bottom
      // border while tabs scroll — visually still text/underline selection.
      selectedTabWrapMatchesAppBackground:
        selectedTabWrapStyle.backgroundColor === getComputedStyle(document.body).backgroundColor,
      toolbarRect: rect(toolbar),
      toolbarButtonCount: toolbarButtons.length,
      panelRect: rect(panel),
      openButtonCount: openButtons.length,
      openButtonLabels,
      firstOpenButtonRect: rect(firstOpenButton),
      cardCoverRects,
      boardGroupButtonCount: boardGroupButtons.length,
      firstBoardGroupRect: rect(boardGroupButtons[0] ?? null),
      calendarPreviousRect: rect(calendarPrevious),
      calendarNextRect: rect(calendarNext),
      timelineZoomRect: rect(timelineZoom),
      timelineDayLabelCount: timelineDayLabelRects.length,
      minTimelineDayLabelGap: timelineDayLabelGaps.length
        ? Math.min(...timelineDayLabelGaps)
        : null,
      newPageButtonRect: rect(newPageButton ?? null),
      presenceVisible: visibleElement(presence),
    };
  }, {
    databaseTitle: seed.databaseTitle,
    rowTitle: seed.rowTitles[view.rowIndex],
    viewName: view.name,
  });

  assert(metrics.ok, metrics.reason ?? `${view.name} database visual contract could not run`);
  assert(
    metrics.titleText === seed.databaseTitle,
    `${view.name} view should keep the seeded database title, got "${metrics.titleText}"`,
  );
  assert(
    metrics.tablistLabel === `${seed.databaseTitle} views`,
    `${view.name} tablist should belong to the seeded database, got "${metrics.tablistLabel}"`,
  );
  assert(
    metrics.selectedTabText.includes(view.name) &&
      metrics.selectedTabFontSize >= 13 &&
      metrics.selectedTabFontSize <= 15,
    `${view.name} selected tab should stay compact and selected, got "${metrics.selectedTabText}" at ${metrics.selectedTabFontSize}px`,
  );
  assert(
    metrics.selectedTabRect.height >= 28 &&
      metrics.selectedTabRect.height <= 34 &&
      metrics.selectedTabWrapRect.height >= 30 &&
      metrics.selectedTabWrapRect.height <= 36,
    `${view.name} selected tab should stay inside the compact tab rail instead of reading as a large chip, got tab=${Math.round(metrics.selectedTabRect.height)}px wrap=${Math.round(metrics.selectedTabWrapRect.height)}px`,
  );
  assert(
    metrics.selectedTabBackgroundAlpha <= 0.01 &&
      (metrics.selectedTabWrapBackgroundAlpha <= 0.01 || metrics.selectedTabWrapMatchesAppBackground === true),
    `${view.name} selected tab should use text/underline selection rather than a filled chip, got alpha tab=${metrics.selectedTabBackgroundAlpha} wrap=${metrics.selectedTabWrapBackgroundAlpha}`,
  );
  assert(
    metrics.docRect.width >= 900 && metrics.docRect.width <= 1500,
    `${view.name} view should use the wider database canvas, got ${Math.round(metrics.docRect.width)}px`,
  );
  assert(
    metrics.titleRect.top - metrics.scrollTop >= 80 && metrics.titleRect.top - metrics.scrollTop <= 145,
    `${view.name} title should sit near the document top, got ${Math.round(metrics.titleRect.top - metrics.scrollTop)}px from page viewport top`,
  );
  assert(
    metrics.titleRect.left - metrics.scrollLeft >= 40 && metrics.titleRect.left - metrics.scrollLeft <= 90,
    `${view.name} title should align to the database canvas gutter, got ${Math.round(metrics.titleRect.left - metrics.scrollLeft)}px from content left`,
  );
  assert(
    metrics.titleFontSize >= 36 && metrics.titleFontSize <= 48,
    `${view.name} title should be page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    metrics.tablistRect.top - metrics.titleRect.bottom >= 8 &&
      metrics.tablistRect.top - metrics.titleRect.bottom <= 36,
    `${view.name} tabs should follow the title closely, got ${Math.round(metrics.tablistRect.top - metrics.titleRect.bottom)}px gap`,
  );
  assert(
    Math.abs(metrics.tablistRect.left - metrics.titleRect.left) <= 2,
    `${view.name} tabs should align with title, got ${Math.round(metrics.tablistRect.left - metrics.titleRect.left)}px offset`,
  );
  assert(
    metrics.toolbarRect.top - metrics.tablistRect.bottom >= -1 &&
      metrics.toolbarRect.top - metrics.tablistRect.bottom <= 8,
    `${view.name} toolbar should sit directly under view tabs, got ${Math.round(metrics.toolbarRect.top - metrics.tablistRect.bottom)}px gap`,
  );
  assert(
    Math.abs(metrics.toolbarRect.left - metrics.titleRect.left) <= 2,
    `${view.name} toolbar should align with title/tabs, got ${Math.round(metrics.toolbarRect.left - metrics.titleRect.left)}px offset`,
  );
  assert(
    metrics.toolbarRect.height >= 28 &&
      metrics.toolbarRect.height <= 38 &&
      metrics.toolbarButtonCount >= 4,
    `${view.name} toolbar should be compact and useful, got height=${metrics.toolbarRect.height}px buttons=${metrics.toolbarButtonCount}`,
  );
  assert(
    metrics.panelRect.top - metrics.toolbarRect.bottom >= -1 &&
      metrics.panelRect.top - metrics.toolbarRect.bottom <= 80,
    `${view.name} body should start close to the toolbar, got ${Math.round(metrics.panelRect.top - metrics.toolbarRect.bottom)}px gap`,
  );
  assert(
    Math.abs(metrics.panelRect.left - metrics.titleRect.left) <= 28,
    `${view.name} body should align with the database canvas, got ${Math.round(metrics.panelRect.left - metrics.titleRect.left)}px offset`,
  );
  assert(
    metrics.openButtonCount >= 1 &&
      metrics.openButtonLabels.some((label) => label === `Open ${seed.rowTitles[view.rowIndex]}`),
    `${view.name} should show seeded database rows as openable items, got ${metrics.openButtonLabels.join(', ') || 'none'}`,
  );
  assert(
    metrics.firstOpenButtonRect.height >= 24 && metrics.firstOpenButtonRect.height <= 220,
    `${view.name} first open row/card should have a sane height, got ${Math.round(metrics.firstOpenButtonRect.height)}px`,
  );
  assert(
    metrics.firstOpenButtonRect.width >= (view.name === 'Timeline' ? 14 : 120),
    `${view.name} first open row/card should have a usable width, got ${Math.round(metrics.firstOpenButtonRect.width)}px`,
  );
  assert(
    metrics.newPageButtonRect === null ||
      (metrics.newPageButtonRect.height >= 24 &&
        metrics.newPageButtonRect.height <= (view.name === 'Gallery' ? 240 : 44)),
    `${view.name} New page affordance should stay compact, got ${metrics.newPageButtonRect?.height}px`,
  );
  assert(
    metrics.presenceVisible === false,
    `${view.name} view should not show a floating presence badge for the current user alone`,
  );

  if (view.name === 'Board') {
    assert(
      metrics.cardCoverRects.length === 0,
      `Board view should default to compact cards without empty preview covers, got ${metrics.cardCoverRects.length} cover blocks`,
    );
    assert(
      metrics.boardGroupButtonCount >= 3,
      `Board view should show seeded status columns, got ${metrics.boardGroupButtonCount} group option buttons`,
    );
    assert(
      metrics.firstBoardGroupRect.height >= 22 && metrics.firstBoardGroupRect.height <= 40,
      `Board group header should stay compact, got ${Math.round(metrics.firstBoardGroupRect.height)}px`,
    );
  }

  if (view.name === 'Calendar') {
    assert(
      metrics.calendarPreviousRect && metrics.calendarNextRect,
      'Calendar view should show previous and next month controls',
    );
    assert(
      metrics.calendarPreviousRect.height >= 24 &&
        metrics.calendarPreviousRect.height <= 40 &&
        metrics.calendarNextRect.height >= 24 &&
        metrics.calendarNextRect.height <= 40,
      `Calendar month controls should stay compact, got ${metrics.calendarPreviousRect.height}px and ${metrics.calendarNextRect.height}px`,
    );
  }

  if (view.name === 'Timeline') {
    assert(metrics.timelineZoomRect, 'Timeline view should show its zoom control group');
    assert(
      metrics.timelineZoomRect.height >= 24 && metrics.timelineZoomRect.height <= 44,
      `Timeline zoom controls should stay compact, got ${metrics.timelineZoomRect.height}px`,
    );
  }
}

async function assertMobileDatabaseViewVisualContract(page, seed, view) {
  const metrics = await page.evaluate((expected) => {
    const visibleElement = (element) =>
      element instanceof HTMLElement && element.offsetParent !== null;
    const rect = (element) => {
      if (!visibleElement(element)) return null;
      const r = element.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const cssAlpha = (value) => {
      if (!value || value === 'transparent') return 0;
      const slash = value.match(/\/\s*([0-9.]+%?)/);
      if (slash) {
        const raw = slash[1];
        const parsed = Number.parseFloat(raw);
        return raw.endsWith('%') ? parsed / 100 : parsed;
      }
      const rgba = value.match(/^rgba?\((.+)\)$/);
      if (!rgba) return 1;
      const parts = rgba[1].split(',').map((part) => part.trim());
      if (parts.length >= 4) return Number.parseFloat(parts[3]);
      return 1;
    };

    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const topbarCommentAction = document.querySelector('[data-topbar-comment-action]');
    const topbarCommentLabel = document.querySelector('[data-topbar-comment-label]');
    const topbarShareAction = document.querySelector('[data-topbar-share-action]');
    const topbarIconActions = Array.from(document.querySelectorAll('[data-topbar-icon-action]'));
    const pageOptions = document.querySelector('[role="toolbar"][aria-label="Page options"]');
    const tablist = document.querySelector('[role="tablist"][aria-label$=" views"]');
    const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const selectedTabWrap = selectedTab?.closest('[data-view-tab-wrap]');
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
    const panel = Array.from(document.querySelectorAll('[role="tabpanel"]')).find(visibleElement);
    const firstCell = document.querySelector('[data-table-cell][data-row-index="0"][data-col-index="0"]');
    const firstCellInput = firstCell?.querySelector('input[type="text"]');
    const presence = document.querySelector('[data-testid="page-presence"]');

    if (
      !visibleElement(doc) ||
      !visibleElement(scroll) ||
      !visibleElement(title) ||
      !visibleElement(tablist) ||
      !visibleElement(selectedTab) ||
      !visibleElement(selectedTabWrap) ||
      !visibleElement(toolbar) ||
      !visibleElement(panel)
    ) {
      return { ok: false, reason: `missing mobile ${expected.viewName} database visual markers` };
    }

    const titleStyle = getComputedStyle(title);
    const titleRange = document.createRange();
    titleRange.selectNodeContents(title);
    const titleSegmentRects = Array.from(titleRange.getClientRects())
      .map((line) => ({
        bottom: line.bottom,
        height: line.height,
        left: line.left,
        right: line.right,
        top: line.top,
        width: line.width,
      }))
      .filter((line) => line.width > 1 && line.height > 1);
    titleRange.detach();
    const titleLineRects = [];
    for (const segment of titleSegmentRects) {
      const line = titleLineRects.find((item) => Math.abs(item.top - segment.top) <= 2);
      if (line) {
        line.bottom = Math.max(line.bottom, segment.bottom);
        line.height = Math.max(line.height, segment.height);
        line.left = Math.min(line.left, segment.left);
        line.right = Math.max(line.right, segment.right);
        line.width = line.right - line.left;
      } else {
        titleLineRects.push({ ...segment });
      }
    }
    const topbarCommentRect = rect(topbarCommentAction);
    const topbarCommentHasIcon =
      topbarCommentAction?.querySelector('svg') instanceof SVGElement;
    const topbarCommentLabelRect = rect(topbarCommentLabel);
    const topbarCommentLabelStyle =
      topbarCommentLabel instanceof HTMLElement ? getComputedStyle(topbarCommentLabel) : null;
    const topbarShareRect = rect(topbarShareAction);
    const topbarShareStyle =
      topbarShareAction instanceof HTMLElement ? getComputedStyle(topbarShareAction) : null;
    const topbarIconActionRects = topbarIconActions.map(rect).filter(Boolean);
    const topbarIconActionWidths = topbarIconActionRects.map((item) => item.width);
    const topbarIconActionHeights = topbarIconActionRects.map((item) => item.height);
    const topbarActionCenters = [
      topbarCommentRect ? topbarCommentRect.top + topbarCommentRect.height / 2 : null,
      topbarShareRect ? topbarShareRect.top + topbarShareRect.height / 2 : null,
      ...topbarIconActionRects.map((item) => item.top + item.height / 2),
    ].filter((item) => typeof item === 'number');
    const pageOptionButtons = Array.from(pageOptions?.querySelectorAll('button') ?? []).filter(visibleElement);
    const pageOptionRects = pageOptionButtons.map(rect).filter(Boolean);
    const pageOptionTops = pageOptionRects.map((item) => item.top);
    const pageOptionLabels = pageOptionButtons
      .map((button) => button.querySelector('span'))
      .filter((item) => item instanceof HTMLElement);
    const wrappedPageOptionLabels = pageOptionLabels
      .filter((label) => label.getClientRects().length > 1 || label.getBoundingClientRect().height > 20)
      .map((label) => label.textContent?.trim() ?? '');
    const clippedPageOptionLabels = pageOptionLabels
      .filter((label) => label.scrollWidth > label.clientWidth + 1)
      .map((label) => label.textContent?.trim() ?? '');
    const selectedTabStyle = getComputedStyle(selectedTab);
    const selectedTabWrapStyle = getComputedStyle(selectedTabWrap);
    const tablistRect = rect(tablist);
    const tabNameClipping = Array.from(tablist.querySelectorAll('[data-view-tab-name]'))
      .filter(visibleElement)
      .map((label) => {
        const labelRect = label.getBoundingClientRect();
        const centerX = labelRect.left + labelRect.width / 2;
        const labelText = label.textContent?.trim() ?? '';
        const clippedByOwnBox = label.scrollWidth > label.clientWidth + 1;
        const clippedByViewport =
          tablistRect &&
          centerX >= tablistRect.left &&
          centerX <= tablistRect.right &&
          (labelRect.left < tablistRect.left - 1 || labelRect.right > tablistRect.right + 1);
        return {
          text: labelText,
          left: labelRect.left,
          right: labelRect.right,
          centerX,
          clippedByOwnBox,
          clippedByViewport,
        };
      })
      .filter((item) => item.clippedByOwnBox || item.clippedByViewport);
    const firstFourTabNameClipping = tabNameClipping
      .filter((item) => ['Table', 'Board', 'List', 'Gallery'].includes(item.text))
      .map((item) => item.text);
    const partiallyClippedVisibleTabNames = Array.from(tablist.querySelectorAll('[data-view-tab-name]'))
      .filter(visibleElement)
      .map((label) => {
        const labelRect = label.getBoundingClientRect();
        const visibleWidth = tablistRect
          ? Math.min(labelRect.right, tablistRect.right) - Math.max(labelRect.left, tablistRect.left)
          : labelRect.width;
        return {
          text: label.textContent?.trim() ?? '',
          width: labelRect.width,
          visibleWidth,
        };
      })
      .filter((item) => item.width > 2 && item.visibleWidth > 2 && item.visibleWidth < item.width - 1)
      .map((item) => item.text);
    const partiallyClippedVisibleTabs = Array.from(tablist.querySelectorAll('[data-view-tab-wrap]'))
      .filter(visibleElement)
      .map((wrap) => {
        const wrapRect = wrap.getBoundingClientRect();
        const visibleWidth = tablistRect
          ? Math.min(wrapRect.right, tablistRect.right) - Math.max(wrapRect.left, tablistRect.left)
          : wrapRect.width;
        const tab = wrap.querySelector('[role="tab"]');
        return {
          name: tab?.getAttribute('aria-label') ?? tab?.textContent?.trim() ?? '',
          left: wrapRect.left,
          right: wrapRect.right,
          width: wrapRect.width,
          visibleWidth,
        };
      })
      .filter((item) => item.width > 4 && item.visibleWidth > 1 && item.visibleWidth < item.width - 1)
      .map((item) => ({
        name: item.name,
        left: item.left,
        right: item.right,
        width: item.width,
        visibleWidth: item.visibleWidth,
      }));
    const primaryViewNames = new Set(['Table', 'Board', 'List', 'Gallery', 'Calendar']);
    const visiblePrimaryIconOnlyTabs = Array.from(tablist.querySelectorAll('[data-view-tab-wrap]'))
      .filter(visibleElement)
      .map((wrap) => {
        const wrapRect = wrap.getBoundingClientRect();
        const visibleWidth = tablistRect
          ? Math.min(wrapRect.right, tablistRect.right) - Math.max(wrapRect.left, tablistRect.left)
          : wrapRect.width;
        const tab = wrap.querySelector('[role="tab"]');
        const label = wrap.querySelector('[data-view-tab-name]');
        const labelRect = label instanceof HTMLElement ? label.getBoundingClientRect() : null;
        const labelStyle = label instanceof HTMLElement ? getComputedStyle(label) : null;
        const labelHidden =
          !labelRect ||
          labelRect.width <= 2 ||
          labelRect.height <= 2 ||
          labelStyle?.clipPath === 'inset(50%)' ||
          labelStyle?.position === 'absolute';
        return {
          name: tab?.getAttribute('aria-label') ?? tab?.textContent?.trim() ?? '',
          visibleWidth,
          labelWidth: labelRect?.width ?? null,
          labelHeight: labelRect?.height ?? null,
          labelHidden,
        };
      })
      .filter((item) => primaryViewNames.has(item.name) && item.visibleWidth >= 12 && item.labelHidden)
      .map((item) => item.name);
    const selectedTabName = selectedTab.querySelector('[data-view-tab-name]');
    const selectedTabNameText = selectedTabName?.textContent?.trim() ?? '';
    const selectedTabNameClipped = selectedTabName
      ? tabNameClipping.some((item) => item.text === selectedTabNameText)
      : false;
    const visibleInactiveViewActions = Array.from(tablist.querySelectorAll('[data-view-actions]'))
      .filter((button) => {
        if (!visibleElement(button)) return false;
        const wrap = button.closest('[data-active]');
        if (wrap?.getAttribute('data-active') === 'true') return false;
        const style = getComputedStyle(button);
        return Number.parseFloat(style.opacity || '0') > 0.5 && style.pointerEvents !== 'none';
      })
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');
    const toolbarButtons = Array.from(toolbar.querySelectorAll('button')).filter(visibleElement);
    const openButtons = Array.from(panel.querySelectorAll('button, [role="button"]'))
      .filter(visibleElement)
      .filter((item) => (item.getAttribute('aria-label') ?? '').startsWith('Open '));
    const openButtonLabels = openButtons.map((item) => item.getAttribute('aria-label') ?? '');
    const cardCoverRects = Array.from(panel.querySelectorAll('[class*="cardCover"]'))
      .filter(visibleElement)
      .map(rect)
      .filter(Boolean);
    const boardGroupButtons = Array.from(panel.querySelectorAll('button[aria-label$=" group options"]'))
      .filter(visibleElement);
    const panelRectValue = rect(panel);
    const boardColumnVisibility = Array.from(panel.querySelectorAll('[class*="boardCol"]'))
      .filter(visibleElement)
      .map((item, index) => {
        const itemRect = rect(item);
        const visibleLeft = Math.max(itemRect.left, panelRectValue.left, 0);
        const visibleRight = Math.min(itemRect.right, panelRectValue.right, window.innerWidth);
        return {
          index,
          left: itemRect.left,
          right: itemRect.right,
          width: itemRect.width,
          visibleWidth: Math.max(0, visibleRight - visibleLeft),
        };
      });
    const visibleBoardColumns = boardColumnVisibility.filter((item) => item.visibleWidth > 8);
    const partiallyVisibleBoardColumns = visibleBoardColumns.filter(
      (item) => item.visibleWidth < item.width - 4,
    );
    const calendarPrevious = panel.querySelector('button[aria-label="Previous month"]');
    const calendarNext = panel.querySelector('button[aria-label="Next month"]');
    const calendarGrid = panel.querySelector('[class*="calendarGrid"]');
    const calendarWeekdayRects = Array.from(panel.querySelectorAll('[class*="calendarWeekday"]'))
      .filter(visibleElement)
      .map(rect)
      .filter(Boolean);
    const timelineZoom = panel.querySelector('[role="group"][aria-label="Timeline zoom"]');
    const timelineDayLabelRects = Array.from(panel.querySelectorAll('[data-timeline-day-label="true"]'))
      .filter(visibleElement)
      .map(rect)
      .filter(Boolean);
    const timelineDayLabelGaps = timelineDayLabelRects
      .slice(1)
      .map((item, index) => item.left - timelineDayLabelRects[index].left);
    const newPageButton = Array.from(panel.querySelectorAll('button'))
      .filter(visibleElement)
      .find((button) => (button.getAttribute('aria-label') ?? '').startsWith('New page'));

    return {
      ok: true,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      scrollRect: rect(scroll),
      docRect: rect(doc),
      titleRect: rect(title),
      titleText: title.textContent?.trim() ?? '',
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      titleLineCount: titleLineRects.length,
      titleLineRects,
      titleLastLineWidth: titleLineRects.at(-1)?.width ?? 0,
      titleMaxLineWidth: titleLineRects.length
        ? Math.max(...titleLineRects.map((line) => line.width))
        : 0,
      topbarCommentText: topbarCommentAction?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topbarCommentRect,
      topbarCommentHasIcon,
      topbarCommentLabelRect,
      topbarCommentLabelPosition: topbarCommentLabelStyle?.position ?? null,
      topbarShareText: topbarShareAction?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topbarShareRect,
      topbarShareBorderWidth: topbarShareStyle
        ? Number.parseFloat(topbarShareStyle.borderTopWidth)
        : 0,
      topbarShareBorderColor: topbarShareStyle?.borderTopColor ?? null,
      topbarIconActionCount: topbarIconActionRects.length,
      topbarIconActionMinWidth: topbarIconActionWidths.length ? Math.min(...topbarIconActionWidths) : 0,
      topbarIconActionMaxWidth: topbarIconActionWidths.length ? Math.max(...topbarIconActionWidths) : 0,
      topbarIconActionMinHeight: topbarIconActionHeights.length ? Math.min(...topbarIconActionHeights) : 0,
      topbarIconActionMaxHeight: topbarIconActionHeights.length ? Math.max(...topbarIconActionHeights) : 0,
      topbarActionCenterSpread: topbarActionCenters.length
        ? Math.max(...topbarActionCenters) - Math.min(...topbarActionCenters)
        : 0,
      pageOptionsRect: rect(pageOptions),
      pageOptionButtonCount: pageOptionRects.length,
      pageOptionMinHeight: pageOptionRects.length ? Math.min(...pageOptionRects.map((item) => item.height)) : 0,
      pageOptionMaxHeight: pageOptionRects.length ? Math.max(...pageOptionRects.map((item) => item.height)) : 0,
      pageOptionTopSpread: pageOptionTops.length ? Math.max(...pageOptionTops) - Math.min(...pageOptionTops) : 0,
      wrappedPageOptionLabels,
      clippedPageOptionLabels,
      tablistRect,
      tablistScrollLeft: tablist.scrollLeft,
      tablistScrollWidth: tablist.scrollWidth,
      tablistClientWidth: tablist.clientWidth,
      tablistLabel: tablist.getAttribute('aria-label') ?? '',
      tabNameClipping,
      firstFourTabNameClipping,
      partiallyClippedVisibleTabNames,
      partiallyClippedVisibleTabs,
      visiblePrimaryIconOnlyTabs,
      selectedTabNameClipped,
      visibleInactiveViewActionCount: visibleInactiveViewActions.length,
      visibleInactiveViewActions,
      selectedTabRect: rect(selectedTab),
      selectedTabText: selectedTab.textContent?.trim() ?? '',
      selectedTabFontSize: Number.parseFloat(selectedTabStyle.fontSize),
      selectedTabBackgroundAlpha: cssAlpha(selectedTabStyle.backgroundColor),
      selectedTabWrapRect: rect(selectedTabWrap),
      selectedTabWrapBackgroundAlpha: cssAlpha(selectedTabWrapStyle.backgroundColor),
      // The wrap paints var(--bg-app) (same as body) to mask the rail's bottom
      // border while tabs scroll — visually still text/underline selection.
      selectedTabWrapMatchesAppBackground:
        selectedTabWrapStyle.backgroundColor === getComputedStyle(document.body).backgroundColor,
      toolbarRect: rect(toolbar),
      toolbarButtonCount: toolbarButtons.length,
      panelRect: panelRectValue,
      firstCellRect: rect(firstCell),
      firstCellValue: firstCellInput instanceof HTMLInputElement ? firstCellInput.value : null,
      openButtonCount: openButtons.length,
      openButtonLabels,
      firstOpenButtonRect: rect(openButtons[0] ?? null),
      cardCoverRects,
      boardGroupButtonCount: boardGroupButtons.length,
      visibleBoardColumnCount: visibleBoardColumns.length,
      firstVisibleBoardColumnRect: visibleBoardColumns[0] ?? null,
      partiallyVisibleBoardColumns,
      calendarPreviousRect: rect(calendarPrevious),
      calendarNextRect: rect(calendarNext),
      calendarGridRect: rect(calendarGrid),
      calendarGridScrollWidth: calendarGrid?.scrollWidth ?? null,
      calendarGridClientWidth: calendarGrid?.clientWidth ?? null,
      calendarWeekdayCount: calendarWeekdayRects.length,
      calendarWeekdayFirstRect: calendarWeekdayRects[0] ?? null,
      calendarWeekdayLastRect: calendarWeekdayRects[calendarWeekdayRects.length - 1] ?? null,
      calendarWeekdayMinWidth: calendarWeekdayRects.length
        ? Math.min(...calendarWeekdayRects.map((item) => item.width))
        : null,
      timelineZoomRect: rect(timelineZoom),
      timelineDayLabelCount: timelineDayLabelRects.length,
      minTimelineDayLabelGap: timelineDayLabelGaps.length
        ? Math.min(...timelineDayLabelGaps)
        : null,
      newPageButtonRect: rect(newPageButton ?? null),
      presenceVisible: visibleElement(presence),
    };
  }, {
    databaseTitle: seed.databaseTitle,
    rowTitle: seed.rowTitles[view.rowIndex],
    viewName: view.name,
  });

  assert(metrics.ok, metrics.reason ?? `mobile ${view.name} database visual contract could not run`);
  assert(
    metrics.titleText === seed.databaseTitle,
    `mobile ${view.name} view should keep the seeded database title, got "${metrics.titleText}"`,
  );
  assert(
    metrics.tablistLabel === `${seed.databaseTitle} views`,
    `mobile ${view.name} tablist should belong to the seeded database, got "${metrics.tablistLabel}"`,
  );
  assert(
    Math.max(metrics.documentScrollWidth, metrics.bodyScrollWidth) <= metrics.viewportWidth + 4,
    `mobile ${view.name} should not create page-level horizontal overflow, got document=${metrics.documentScrollWidth}px body=${metrics.bodyScrollWidth}px viewport=${metrics.viewportWidth}px`,
  );
  assert(
    metrics.docRect.left >= -1 && metrics.docRect.right <= metrics.viewportWidth + 1,
    `mobile ${view.name} document should stay inside the viewport, got left=${Math.round(metrics.docRect.left)} right=${Math.round(metrics.docRect.right)} viewport=${metrics.viewportWidth}`,
  );
  assert(
    metrics.titleRect.left - metrics.scrollRect.left >= 20 &&
      metrics.titleRect.left - metrics.scrollRect.left <= 64,
    `mobile ${view.name} title should keep the mobile document gutter, got ${Math.round(metrics.titleRect.left - metrics.scrollRect.left)}px`,
  );
  assert(
    metrics.titleRect.top - metrics.scrollRect.top >= 72 &&
      metrics.titleRect.top - metrics.scrollRect.top <= 150,
    `mobile ${view.name} title should sit in the first mobile viewport, got ${Math.round(metrics.titleRect.top - metrics.scrollRect.top)}px`,
  );
  assert(
    metrics.titleFontSize >= 30 && metrics.titleFontSize <= 46,
    `mobile ${view.name} title should stay page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    metrics.titleLineCount <= 2,
    `mobile ${view.name} title should not fragment into too many short lines: ${JSON.stringify(metrics.titleLineRects)}`,
  );
  assert(
    metrics.titleLineCount < 2 ||
      metrics.titleLastLineWidth >= Math.min(160, metrics.titleMaxLineWidth * 0.45),
    `mobile ${view.name} title should avoid orphaned short final lines: ${JSON.stringify(metrics.titleLineRects)}`,
  );
  assert(
    metrics.topbarCommentText.startsWith('Comment') &&
      metrics.topbarCommentRect &&
      metrics.topbarCommentRect.width >= 27 &&
      metrics.topbarCommentRect.width <= 31 &&
      metrics.topbarCommentRect.height >= 26 &&
      metrics.topbarCommentRect.height <= 30 &&
      metrics.topbarCommentHasIcon === true &&
      metrics.topbarCommentLabelRect &&
      metrics.topbarCommentLabelRect.width <= 2 &&
      metrics.topbarCommentLabelRect.height <= 2 &&
      metrics.topbarCommentLabelPosition === 'absolute',
    `mobile ${view.name} topbar Comment action should collapse to an icon button, got ${JSON.stringify({
      text: metrics.topbarCommentText,
      button: metrics.topbarCommentRect,
      hasIcon: metrics.topbarCommentHasIcon,
      label: metrics.topbarCommentLabelRect,
      labelPosition: metrics.topbarCommentLabelPosition,
    })}`,
  );
  assert(
    metrics.topbarShareText === 'Share' &&
      metrics.topbarShareRect &&
      metrics.topbarShareRect.width >= 58 &&
      metrics.topbarShareRect.width <= 86 &&
      metrics.topbarShareRect.height >= 26 &&
      metrics.topbarShareRect.height <= 32 &&
      metrics.topbarShareBorderWidth >= 0.5 &&
      metrics.topbarShareBorderColor !== 'rgba(0, 0, 0, 0)' &&
      metrics.topbarIconActionCount >= 2 &&
      metrics.topbarIconActionMinWidth >= 27 &&
      metrics.topbarIconActionMaxWidth <= 31 &&
      metrics.topbarIconActionMinHeight >= 27 &&
      metrics.topbarIconActionMaxHeight <= 31 &&
      metrics.topbarActionCenterSpread <= 1.5,
    `mobile ${view.name} topbar actions should keep compact one-row chrome, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.pageOptionsRect && metrics.pageOptionButtonCount >= 3,
    `mobile ${view.name} page chrome should expose Add icon/cover/comment controls: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.pageOptionMinHeight >= 22 && metrics.pageOptionMaxHeight <= 28 && metrics.pageOptionTopSpread <= 1,
    `mobile ${view.name} page chrome controls should stay compact on one row: ${JSON.stringify({
      min: metrics.pageOptionMinHeight,
      max: metrics.pageOptionMaxHeight,
      topSpread: metrics.pageOptionTopSpread,
    })}`,
  );
  assert(
    metrics.wrappedPageOptionLabels.length === 0,
    `mobile ${view.name} page chrome labels should not wrap inside controls: ${metrics.wrappedPageOptionLabels.join(', ')}`,
  );
  assert(
    metrics.clippedPageOptionLabels.length === 0,
    `mobile ${view.name} page chrome labels should fit without ellipsis: ${metrics.clippedPageOptionLabels.join(', ')}`,
  );
  assert(
    metrics.tablistRect.left >= metrics.titleRect.left - 2 &&
      metrics.tablistRect.right <= metrics.viewportWidth + 1,
    `mobile ${view.name} view tabs should stay in the viewport, got left=${Math.round(metrics.tablistRect.left)} right=${Math.round(metrics.tablistRect.right)}`,
  );
  if (view.name === 'Table') {
    assert(
      metrics.firstFourTabNameClipping.length === 0,
      `mobile ${view.name} view tabs should not clip primary labels at the viewport edge: ${metrics.firstFourTabNameClipping.join(', ')}`,
    );
  }
  assert(
    metrics.selectedTabNameClipped === false,
    `mobile ${view.name} selected view tab label should remain fully readable: ${JSON.stringify({
      selectedTabText: metrics.selectedTabText,
      tablistRect: metrics.tablistRect,
      selectedTabRect: metrics.selectedTabRect,
      tabNameClipping: metrics.tabNameClipping,
    })}`,
  );
  assert(
    metrics.partiallyClippedVisibleTabNames.length === 0,
    `mobile ${view.name} view tab rail should avoid half-visible clipped labels at the viewport edge: ${metrics.partiallyClippedVisibleTabNames.join(', ')}`,
  );
  assert(
    metrics.partiallyClippedVisibleTabs.length === 0,
    `mobile ${view.name} view tab rail should avoid half-visible clipped tab fragments at the viewport edge: ${JSON.stringify({
      tablistRect: metrics.tablistRect,
      scrollLeft: metrics.tablistScrollLeft,
      scrollWidth: metrics.tablistScrollWidth,
      clientWidth: metrics.tablistClientWidth,
      fragments: metrics.partiallyClippedVisibleTabs,
    })}`,
  );
  assert(
    metrics.visiblePrimaryIconOnlyTabs.length === 0,
    `mobile ${view.name} primary view tabs should not degrade into icon-only fragments: ${metrics.visiblePrimaryIconOnlyTabs.join(', ')}`,
  );
  assert(
    metrics.visibleInactiveViewActionCount === 0,
    `mobile ${view.name} inactive view tabs should keep secondary actions quiet instead of crowding labels: ${metrics.visibleInactiveViewActions.join(', ')}`,
  );
  assert(
    metrics.selectedTabText.includes(view.name) &&
      metrics.selectedTabFontSize >= 13 &&
      metrics.selectedTabFontSize <= 15,
    `mobile ${view.name} selected tab should stay compact and selected, got "${metrics.selectedTabText}" at ${metrics.selectedTabFontSize}px`,
  );
  assert(
    metrics.selectedTabRect.height >= 28 &&
      metrics.selectedTabRect.height <= 34 &&
      metrics.selectedTabWrapRect.height >= 30 &&
      metrics.selectedTabWrapRect.height <= 36,
    `mobile ${view.name} selected tab should stay inside the compact tab rail instead of reading as a large chip, got tab=${Math.round(metrics.selectedTabRect.height)}px wrap=${Math.round(metrics.selectedTabWrapRect.height)}px`,
  );
  assert(
    metrics.selectedTabBackgroundAlpha <= 0.01 &&
      (metrics.selectedTabWrapBackgroundAlpha <= 0.01 || metrics.selectedTabWrapMatchesAppBackground === true),
    `mobile ${view.name} selected tab should use text/underline selection rather than a filled chip, got alpha tab=${metrics.selectedTabBackgroundAlpha} wrap=${metrics.selectedTabWrapBackgroundAlpha}`,
  );
  assert(
    metrics.toolbarRect.left >= metrics.titleRect.left - 2 &&
      metrics.toolbarRect.right <= metrics.viewportWidth + 1,
    `mobile ${view.name} toolbar should stay in the viewport, got left=${Math.round(metrics.toolbarRect.left)} right=${Math.round(metrics.toolbarRect.right)}`,
  );
  assert(
    metrics.toolbarRect.height >= 28 &&
      metrics.toolbarRect.height <= (view.name === 'Calendar' || view.name === 'Timeline' ? 76 : 44) &&
      metrics.toolbarButtonCount >= 4,
    `mobile ${view.name} toolbar should be compact and useful, got height=${metrics.toolbarRect.height}px buttons=${metrics.toolbarButtonCount}`,
  );
  assert(
    metrics.panelRect.left >= metrics.titleRect.left - 2 &&
      metrics.panelRect.right <= metrics.viewportWidth + 1,
    `mobile ${view.name} body container should stay in the viewport, got left=${Math.round(metrics.panelRect.left)} right=${Math.round(metrics.panelRect.right)}`,
  );
  assert(
    metrics.panelRect.top - metrics.toolbarRect.bottom >= -1 &&
      metrics.panelRect.top - metrics.toolbarRect.bottom <= 90,
    `mobile ${view.name} body should start close to the toolbar, got ${Math.round(metrics.panelRect.top - metrics.toolbarRect.bottom)}px gap`,
  );
  assert(
    metrics.presenceVisible === false,
    `mobile ${view.name} should not show a floating presence badge for the current user alone`,
  );

  if (view.name === 'Table') {
    assert(
      metrics.firstCellRect &&
        metrics.firstCellValue === seed.rowTitles[0] &&
        metrics.firstCellRect.height >= 28 &&
        metrics.firstCellRect.height <= 44,
      `mobile Table should show a compact seeded first row, got value="${metrics.firstCellValue}" height=${metrics.firstCellRect?.height}`,
    );
    return;
  }

  assert(
    metrics.openButtonCount >= 1 &&
      metrics.openButtonLabels.some((label) => label === `Open ${seed.rowTitles[view.rowIndex]}`),
    `mobile ${view.name} should show seeded database rows as openable items, got ${metrics.openButtonLabels.join(', ') || 'none'}`,
  );
  assert(
    metrics.firstOpenButtonRect.height >= 18 && metrics.firstOpenButtonRect.height <= 260,
    `mobile ${view.name} first row/card should have a sane height, got ${Math.round(metrics.firstOpenButtonRect.height)}px`,
  );
  assert(
    metrics.newPageButtonRect === null ||
      (metrics.newPageButtonRect.height >= 24 &&
        metrics.newPageButtonRect.height <= (view.name === 'Gallery' ? 260 : 52)),
    `mobile ${view.name} New page affordance should stay compact, got ${metrics.newPageButtonRect?.height}px`,
  );

  if (view.name === 'Board') {
    assert(
      metrics.cardCoverRects.length === 0,
      `mobile Board should default to compact cards without empty preview covers, got ${metrics.cardCoverRects.length} cover blocks`,
    );
    assert(
      metrics.boardGroupButtonCount >= 3,
      `mobile Board should show seeded status columns, got ${metrics.boardGroupButtonCount} group option buttons`,
    );
    assert(
      metrics.visibleBoardColumnCount >= 1,
      `mobile Board should show at least one readable board column, got ${metrics.visibleBoardColumnCount}`,
    );
    assert(
      metrics.partiallyVisibleBoardColumns.length === 0,
      `mobile Board should not expose clipped half-columns in the first viewport: ${JSON.stringify(metrics.partiallyVisibleBoardColumns)}`,
    );
    assert(
      metrics.firstVisibleBoardColumnRect &&
        metrics.firstVisibleBoardColumnRect.visibleWidth >= metrics.panelRect.width - 4,
      `mobile Board first column should fill the board viewport instead of leaving room for a clipped neighbor: ${JSON.stringify({
        first: metrics.firstVisibleBoardColumnRect,
        panel: metrics.panelRect,
      })}`,
    );
  }

  if (view.name === 'Calendar') {
    assert(
      metrics.calendarPreviousRect && metrics.calendarNextRect,
      'mobile Calendar should show previous and next month controls',
    );
    assert(
      metrics.calendarGridRect &&
        metrics.calendarGridScrollWidth !== null &&
        metrics.calendarGridClientWidth !== null,
      `mobile Calendar should expose a measurable month grid: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.calendarGridScrollWidth <= metrics.calendarGridClientWidth + 2,
      `mobile Calendar month grid should fit all weekdays without internal horizontal scroll, got scroll=${metrics.calendarGridScrollWidth}px client=${metrics.calendarGridClientWidth}px`,
    );
    assert(
      metrics.calendarWeekdayCount === 7,
      `mobile Calendar should show all 7 weekday headers, got ${metrics.calendarWeekdayCount}`,
    );
    assert(
      metrics.calendarWeekdayFirstRect &&
        metrics.calendarWeekdayLastRect &&
        metrics.calendarWeekdayFirstRect.left >= metrics.panelRect.left - 1 &&
        metrics.calendarWeekdayLastRect.right <= metrics.viewportWidth + 1,
      `mobile Calendar weekday headers should all be visible in the viewport: ${JSON.stringify({
        first: metrics.calendarWeekdayFirstRect,
        last: metrics.calendarWeekdayLastRect,
        panel: metrics.panelRect,
        viewport: metrics.viewportWidth,
      })}`,
    );
    assert(
      metrics.calendarWeekdayMinWidth === null || metrics.calendarWeekdayMinWidth >= 34,
      `mobile Calendar weekday columns should stay readable, got min width ${metrics.calendarWeekdayMinWidth}px`,
    );
  }

  if (view.name === 'Timeline') {
    assert(metrics.timelineZoomRect, 'mobile Timeline should show its zoom control group');
    assert(
      metrics.timelineDayLabelCount >= 4,
      `mobile Timeline should show sparse readable day labels, got ${metrics.timelineDayLabelCount}`,
    );
    assert(
      metrics.minTimelineDayLabelGap === null || metrics.minTimelineDayLabelGap >= 28,
      `mobile Timeline day labels should not visually collide, got min gap ${metrics.minTimelineDayLabelGap}px`,
    );
  }
}

async function writeDatabaseViewSurfaceInventory(page, seed, opts) {
  const inventory = await collectDatabaseViewSurfaceInventory(page, seed, opts);
  assertDatabaseViewSurfaceInventory(inventory);
  const path = join(options.screenshotDir, opts.filename);
  writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return inventory;
}

async function collectDatabaseViewSurfaceInventory(page, seed, opts) {
  const local = await page.evaluate(({ expectedRowTitle, mobile, viewName }) => {
    const round = (value) => Math.round(value * 100) / 100;
    const visibleElement = (element) => element instanceof HTMLElement && element.offsetParent !== null;
    const rect = (element) => {
      if (!visibleElement(element)) return null;
      const r = element.getBoundingClientRect();
      return {
        bottom: round(r.bottom),
        height: round(r.height),
        left: round(r.left),
        right: round(r.right),
        top: round(r.top),
        width: round(r.width),
      };
    };
    const cssAlpha = (value) => {
      if (!value || value === 'transparent') return 0;
      const slash = value.match(/\/\s*([0-9.]+%?)/);
      if (slash) {
        const raw = slash[1];
        const parsed = Number.parseFloat(raw);
        return raw.endsWith('%') ? parsed / 100 : parsed;
      }
      const rgba = value.match(/^rgba?\((.+)\)$/);
      if (!rgba) return 1;
      const parts = rgba[1].split(',').map((part) => part.trim());
      if (parts.length >= 4) return Number.parseFloat(parts[3]);
      return 1;
    };
    const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const buttonLabel = (button) =>
      button.getAttribute('aria-label') || button.getAttribute('title') || text(button);
    const visibleButtons = (root) => Array.from(root?.querySelectorAll('button, [role="button"]') ?? [])
      .filter((element) => {
        if (!visibleElement(element)) return false;
        const style = getComputedStyle(element);
        const r = element.getBoundingClientRect();
        return style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.05 &&
          style.pointerEvents !== 'none' &&
          r.width > 0 &&
          r.height > 0;
      });

    const doc = document.querySelector('[data-page-search-root]');
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const tablist = document.querySelector('[role="tablist"][aria-label$=" views"]');
    const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const selectedTabWrap = selectedTab?.closest('[data-view-tab-wrap]');
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
    const panel = Array.from(document.querySelectorAll('[role="tabpanel"]')).find(visibleElement);
    const pageOptions = document.querySelector('[role="toolbar"][aria-label="Page options"]');
    const firstCell = document.querySelector('[data-table-cell][data-row-index="0"][data-col-index="0"]');
    const firstCellInput = firstCell?.querySelector('input[type="text"]');
    const summaryRow = document.querySelector('[data-table-summary-row]');

    if (
      !visibleElement(doc) ||
      !visibleElement(title) ||
      !visibleElement(tablist) ||
      !visibleElement(selectedTab) ||
      !visibleElement(selectedTabWrap) ||
      !visibleElement(toolbar) ||
      !visibleElement(panel)
    ) {
      return { ok: false, reason: `missing ${viewName} database shell markers` };
    }

    const selectedTabStyle = getComputedStyle(selectedTab);
    const selectedTabWrapStyle = getComputedStyle(selectedTabWrap);
    const tabEntries = Array.from(tablist.querySelectorAll('[data-view-tab-wrap]'))
      .filter(visibleElement)
      .map((wrap) => {
        const tab = wrap.querySelector('[role="tab"]');
        const label = wrap.querySelector('[data-view-tab-name]');
        const action = wrap.querySelector('[data-view-actions]');
        const actionStyle = action instanceof HTMLElement ? getComputedStyle(action) : null;
        return {
          actionLabel: action instanceof HTMLElement ? buttonLabel(action) : null,
          actionVisible: action instanceof HTMLElement &&
            visibleElement(action) &&
            Number.parseFloat(actionStyle?.opacity || '0') > 0.5 &&
            actionStyle?.pointerEvents !== 'none',
          active: wrap.getAttribute('data-active') === 'true',
          label: label instanceof HTMLElement ? text(label) : text(tab),
          rect: rect(wrap),
          selected: tab?.getAttribute('aria-selected') === 'true',
          tabLabel: tab instanceof HTMLElement ? buttonLabel(tab) : null,
        };
      });
    const toolbarButtons = visibleButtons(toolbar).map((button) => ({
      label: buttonLabel(button),
      rect: rect(button),
      style: {
        colorAlpha: round(cssAlpha(getComputedStyle(button).color)),
        opacity: round(Number.parseFloat(getComputedStyle(button).opacity || '1')),
        pointerEvents: getComputedStyle(button).pointerEvents,
      },
    }));
    const pageOptionButtons = visibleButtons(pageOptions).map((button) => ({
      label: buttonLabel(button),
      rect: rect(button),
    }));
    const openButtons = visibleButtons(panel)
      .filter((item) => (item.getAttribute('aria-label') ?? '').startsWith('Open '))
      .map((button) => ({
        label: button.getAttribute('aria-label') ?? '',
        rect: rect(button),
      }));
    const cardCovers = Array.from(panel.querySelectorAll('[class*="cardCover"]'))
      .filter(visibleElement)
      .map((cover) => ({
        rect: rect(cover),
        hasImage: cover.getAttribute('data-has-image') === 'true',
      }));
    const rowLikeText = text(panel).slice(0, 500);
    const visibleSummaryTexts = summaryRow instanceof HTMLElement
      ? Array.from(summaryRow.querySelectorAll('button'))
          .filter((button) => {
            if (!visibleElement(button)) return false;
            const style = getComputedStyle(button);
            const r = button.getBoundingClientRect();
            return style.visibility !== 'hidden' &&
              Number.parseFloat(style.opacity || '0') > 0.05 &&
              r.width > 0 &&
              r.height > 0;
          })
          .map((button) => text(button))
          .filter(Boolean)
      : [];
    const groupSubtotalTexts = Array.from(panel.querySelectorAll('[data-table-group-subtotal]'))
      .filter((item) => item instanceof HTMLElement && visibleElement(item))
      .map((item) => text(item))
      .filter(Boolean);
    const boardGroups = Array.from(panel.querySelectorAll('button[aria-label$=" group options"]'))
      .filter(visibleElement)
      .map((button) => ({
        label: buttonLabel(button),
        rect: rect(button),
      }));
    const calendarControls = {
      next: rect(panel.querySelector('button[aria-label="Next month"]')),
      previous: rect(panel.querySelector('button[aria-label="Previous month"]')),
    };
    const timelineZoom = panel.querySelector('[role="group"][aria-label="Timeline zoom"]');
    const timelineDayLabels = Array.from(panel.querySelectorAll('[data-timeline-day-label="true"]'))
      .filter(visibleElement)
      .map((label) => ({
        rect: rect(label),
        text: text(label),
      }));
    const newPageButton = visibleButtons(panel)
      .find((button) => (button.getAttribute('aria-label') ?? '').startsWith('New page'));
    const visibleInactiveViewActions = tabEntries
      .filter((entry) => !entry.selected && entry.actionVisible)
      .map((entry) => entry.actionLabel || entry.label);

    return {
      ok: true,
      body: {
        boardGroups,
        calendarControls,
        firstCell: firstCell instanceof HTMLElement
          ? {
              rect: rect(firstCell),
              value: firstCellInput instanceof HTMLInputElement ? firstCellInput.value : text(firstCell),
            }
          : null,
        newPageButton: newPageButton instanceof HTMLElement
          ? {
              label: buttonLabel(newPageButton),
              rect: rect(newPageButton),
            }
          : null,
        cardCovers,
        openButtons,
        panelRect: rect(panel),
        groupSubtotalTexts,
        summaryTexts: visibleSummaryTexts,
        textSample: rowLikeText,
        timelineDayLabels,
        timelineZoomRect: rect(timelineZoom),
      },
      chrome: {
        pageOptionButtons,
        titleRect: rect(title),
        titleText: text(title),
        toolbarButtons,
        toolbarRect: rect(toolbar),
        viewTabs: tabEntries,
        tablistRect: rect(tablist),
        tablistScroll: {
          clientWidth: tablist.clientWidth,
          scrollLeft: tablist.scrollLeft,
          scrollWidth: tablist.scrollWidth,
        },
        selectedTab: {
          backgroundAlpha: round(cssAlpha(selectedTabStyle.backgroundColor)),
          label: text(selectedTab),
          rect: rect(selectedTab),
          wrapBackgroundAlpha: round(cssAlpha(selectedTabWrapStyle.backgroundColor)),
          // The wrap paints var(--bg-app) (same as body) to mask the rail's
          // bottom border while tabs scroll — still text/underline selection.
          wrapMatchesAppBackground:
            selectedTabWrapStyle.backgroundColor === getComputedStyle(document.body).backgroundColor,
          wrapRect: rect(selectedTabWrap),
        },
      },
      expectedRowTitle,
      mobile,
      page: {
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme || 'light',
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      },
      viewName,
      visibleInactiveViewActions,
    };
  }, {
    expectedRowTitle: seed.rowTitles[opts.view.rowIndex],
    mobile: opts.mobile,
    viewName: opts.view.name,
  });

  return {
    generatedAt: new Date().toISOString(),
    reference: databaseViewReferenceInventory(),
    seed: {
      amountSummaryText: seed.amountSummaryText,
      databaseId: seed.databaseId,
      databaseTitle: seed.databaseTitle,
      firstGroupSubtotalText: seed.firstGroupSubtotalText,
      rowTitles: seed.rowTitles,
    },
    target: {
      mobile: opts.mobile,
      theme: opts.theme,
      view: opts.view.name,
    },
    local,
  };
}

function databaseViewReferenceInventory() {
  const artifact = (name) => {
    const path = join(root, '.edgebase', 'notion-reference', 'current', name);
    return {
      path,
      present: existsSync(path),
    };
  };

  return {
    source: 'Current Notion database reference artifacts captured through the Notion reference loop.',
    artifacts: [
      artifact('notion-database-view-reference-desktop.json'),
      artifact('notion-database-view-reference-desktop.png'),
      artifact('notion-database-reference-candidate.json'),
      artifact('notion-database-reference-candidate.png'),
      artifact('live-notion-database-reference-2026-06-26c.png'),
      artifact('live-notion-database-page-reference-2026-06-27.png'),
      artifact('live-notion-database-page-reference-2026-06-27.json'),
      artifact('live-notion-database-page-reference-2026-06-26.png'),
      artifact('live-notion-database-title-hover-reference-2026-06-26.png'),
    ],
    normalizedContract: {
      body: [
        'Each database view should expose real row/card/event content, not only an empty shell.',
        'View-specific controls should appear in the body only where that view needs them: board groups, calendar month navigation, or timeline zoom.',
        'Default board cards should stay compact and content-first; empty cover placeholders only belong to explicit card-preview/page-cover configurations or Gallery-like views.',
      ],
      mobile: [
        'The database shell should stay inside the narrow viewport without page-level horizontal overflow.',
        'Inactive view tab actions should remain quiet so mobile labels do not become crowded by desktop hover chrome.',
      ],
      shell: [
        'Database title, view tabs, toolbar, and body should read as one compact product surface.',
        'The selected view tab should use quiet text/underline selection instead of a filled chip.',
        'Toolbar controls should remain visible, compact, and aligned with the database canvas.',
      ],
      note: 'Notion reference artifacts calibrate hierarchy, density, and reveal behavior. Local implementation should use Notionlike tokens and responsive rules rather than copying raw Notion DOM geometry.',
    },
  };
}

function assertDatabaseViewSurfaceInventory(inventory) {
  const { local, seed, target } = inventory;
  assert(local?.ok, local?.reason ?? 'database view surface inventory could not run');
  assert(
    local.chrome.titleText === seed.databaseTitle,
    `${target.view} database inventory title drifted: ${JSON.stringify(local.chrome.titleText)}`,
  );

  const expectedTabs = ['Table', 'Board', 'List', 'Gallery', 'Calendar', 'Timeline'];
  const tabLabels = local.chrome.viewTabs.map((tab) => tab.label);
  for (const name of expectedTabs) {
    assert(
      tabLabels.includes(name),
      `${target.view} database inventory is missing the ${name} view tab: ${JSON.stringify(tabLabels)}`,
    );
  }
  assert(
    local.chrome.selectedTab.label.includes(target.view),
    `${target.view} database inventory selected tab mismatch: ${JSON.stringify(local.chrome.selectedTab)}`,
  );
  assert(
    local.chrome.selectedTab.backgroundAlpha <= 0.01 &&
      (local.chrome.selectedTab.wrapBackgroundAlpha <= 0.01 ||
        local.chrome.selectedTab.wrapMatchesAppBackground === true),
    `${target.view} selected tab should stay quiet instead of becoming a filled chip: ${JSON.stringify(local.chrome.selectedTab)}`,
  );
  assert(
    local.chrome.toolbarButtons.length >= 4,
    `${target.view} database toolbar should expose compact controls: ${JSON.stringify(local.chrome.toolbarButtons)}`,
  );
  assert(
    ['Properties', 'Filter', 'Sort', 'Search database rows', 'New database page'].every((label) =>
      local.chrome.toolbarButtons.some((button) => button.label === label)
    ),
    `${target.view} database toolbar should expose Properties, Filter, Sort, Search, and New at rest: ${JSON.stringify(local.chrome.toolbarButtons)}`,
  );
  assert(
    local.chrome.toolbarButtons.every(
      (button) =>
        button.style.opacity >= 0.85 &&
        button.style.colorAlpha >= 0.44 &&
        button.style.pointerEvents !== 'none',
    ),
    `${target.view} database toolbar buttons should be optically discoverable at rest, not hover-only: ${JSON.stringify(local.chrome.toolbarButtons)}`,
  );
  assert(
    local.body.panelRect,
    `${target.view} database inventory should include a visible body panel`,
  );

  if (target.mobile) {
    assert(
      local.page.viewportWidth <= 430,
      `mobile ${target.view} inventory should run in a narrow viewport: ${JSON.stringify(local.page)}`,
    );
    assert(
      Math.max(local.page.documentScrollWidth, local.page.bodyScrollWidth) <= local.page.viewportWidth + 4,
      `mobile ${target.view} database shell should not create page-level horizontal overflow: ${JSON.stringify(local.page)}`,
    );
    assert(
      local.visibleInactiveViewActions.length === 0,
      `mobile ${target.view} inactive view actions should stay quiet: ${local.visibleInactiveViewActions.join(', ')}`,
    );
  }

  if (target.view === 'Table') {
    assert(
      local.body.firstCell?.value === seed.rowTitles[0],
      `Table inventory should expose the seeded first row, got ${JSON.stringify(local.body.firstCell)}`,
    );
    assert(
      local.body.summaryTexts.some((text) => /sum/i.test(text)) &&
        local.body.summaryTexts.some((text) => text.includes(seed.amountSummaryText)),
      `Table inventory should expose the configured amount summary: ${JSON.stringify(local.body.summaryTexts)}`,
    );
    assert(
      local.body.groupSubtotalTexts.some((text) => /sum/i.test(text)) &&
        local.body.groupSubtotalTexts.some((text) => text.includes(seed.firstGroupSubtotalText)),
      `Table inventory should expose the configured grouped amount subtotal: ${JSON.stringify(local.body.groupSubtotalTexts)}`,
    );
    assert(
      !local.body.summaryTexts.some((text) => /^3 rows$/i.test(text)),
      `Table inventory should not expose the default row-count footer beside a configured numeric summary: ${JSON.stringify(local.body.summaryTexts)}`,
    );
    return;
  }

  assert(
    local.body.openButtons.some((button) => button.label === `Open ${local.expectedRowTitle}`),
    `${target.view} inventory should expose the expected open row/card: ${JSON.stringify(local.body.openButtons)}`,
  );

  if (target.view === 'Board') {
    assert(
      local.body.boardGroups.length >= 3,
      `Board inventory should expose status group controls: ${JSON.stringify(local.body.boardGroups)}`,
    );
  }

  if (target.view === 'Calendar') {
    assert(
      local.body.calendarControls.previous && local.body.calendarControls.next,
      `Calendar inventory should expose month navigation controls: ${JSON.stringify(local.body.calendarControls)}`,
    );
  }

  if (target.view === 'Timeline') {
    assert(
      local.body.timelineZoomRect,
      `Timeline inventory should expose zoom controls: ${JSON.stringify(local.body.timelineZoomRect)}`,
    );
  }
}

async function selectView(page, name, viewId) {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click({ timeout: options.timeoutMs });
  await expectSelectedTab(page, name, viewId);
  await page.waitForTimeout(160);
}

async function expectSelectedTab(page, name, viewId, expectUrl = true) {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-view-tab="${id}"]`)?.getAttribute('aria-selected') === 'true',
    viewId,
    { timeout: options.timeoutMs },
  );
  const selected = page.getByRole('tab', { name, selected: true, exact: true });
  await selected.waitFor({ state: 'visible', timeout: options.timeoutMs });
  if (expectUrl) {
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get('v') === id,
      viewId,
      { timeout: options.timeoutMs },
    );
  }
}

async function expectOpenRowButton(page, rowTitle) {
  await currentPanel(page).getByRole('button', { name: `Open ${rowTitle}` }).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

function currentPanel(page) {
  return page.getByRole('tabpanel');
}

async function expectCellInputValue(page, rowIndex, colIndex, value) {
  await page.waitForFunction(
    ([row, col, expected]) => {
      const input = document.querySelector(
        `[data-table-cell][data-row-index="${row}"][data-col-index="${col}"] input[type="text"]`,
      );
      return input && input.offsetParent !== null && input.value === expected;
    },
    [rowIndex, colIndex, value],
    { timeout: options.timeoutMs },
  );
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database view UI smoke');

  const databaseId = crypto.randomUUID();
  const statusPropId = crypto.randomUUID();
  const duePropId = crypto.randomUUID();
  const amountPropId = crypto.randomUUID();
  const notesPropId = crypto.randomUUID();
  const relationPropId = crypto.randomUUID();
  const databaseTitle = '거래처 운영 데이터베이스';
  const rowTitles = [
    '광동이상위생도자기 (Guangdong Ideal Sanitary Ware Co., Ltd.) 장기 미수 거래처 정리 계획',
    '월별 세금계산서 발행 확인',
    '대표님 보고용 지표 마감',
  ];
  const statusOptionNames = ['예정', '진행 중', '완료'];
  const amounts = [1_200_000, 450_000, 200_000];
  const amountSummaryText = '1,850,000';
  const firstGroupSubtotalText = '1,200,000';
  const dates = [dateKey(new Date()), dateKey(addDays(new Date(), 2)), dateKey(addDays(new Date(), 6))];
  const visibleProperties = [];

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: databaseTitle,
    viewType: 'table',
    properties: [
      { id: crypto.randomUUID(), name: '이름', type: 'title', position: 1 },
      {
        id: statusPropId,
        name: '상태',
        type: 'status',
        position: 2,
        options: [
          { id: 'todo', name: statusOptionNames[0], color: 'gray' },
          { id: 'doing', name: statusOptionNames[1], color: 'blue' },
          { id: 'done', name: statusOptionNames[2], color: 'green' },
        ],
      },
      { id: duePropId, name: '마감일', type: 'date', position: 3 },
      { id: amountPropId, name: '금액', type: 'number', position: 4, numberFormat: 'won' },
      { id: notesPropId, name: '메모', type: 'rich_text', position: 5 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database view UI smoke database must be created');
  assert(Array.isArray(created?.rows) && created.rows.length >= 3, 'database view UI smoke needs seeded rows');
  assert(Array.isArray(created?.properties), 'database view UI smoke must receive properties');
  visibleProperties.push(...created.properties.map((prop) => prop.id));

  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database view UI smoke must receive a table view');
  const viewIds = {
    table: tableViewId,
    board: crypto.randomUUID(),
    list: crypto.randomUUID(),
    gallery: crypto.randomUUID(),
    calendar: crypto.randomUUID(),
    timeline: crypto.randomUUID(),
  };

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    // Routing hint for the workspace-DO split (view ids are not pages).
    databaseId,
    patch: {
      name: 'Table',
      config: {
        propertyOrder: visibleProperties,
        visibleProperties,
        groupBy: statusPropId,
        tableCalculations: { [amountPropId]: 'sum' },
      },
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: relationPropId,
      databaseId,
      name: '계약DB',
      type: 'relation',
      config: { relationDatabaseId: databaseId },
      position: 6,
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: viewIds.board,
        databaseId,
        name: 'Board',
        type: 'board',
        position: 2,
        config: { groupBy: statusPropId, visibleProperties, cardSize: 'medium' },
      },
      {
        id: viewIds.list,
        databaseId,
        name: 'List',
        type: 'list',
        position: 3,
        config: { visibleProperties },
      },
      {
        id: viewIds.gallery,
        databaseId,
        name: 'Gallery',
        type: 'gallery',
        position: 4,
        config: { visibleProperties, cardSize: 'medium' },
      },
      {
        id: viewIds.calendar,
        databaseId,
        name: 'Calendar',
        type: 'calendar',
        position: 5,
        config: { calendarBy: duePropId, visibleProperties },
      },
      {
        id: viewIds.timeline,
        databaseId,
        name: 'Timeline',
        type: 'timeline',
        position: 6,
        config: { timelineBy: duePropId, timelineZoom: 'month', visibleProperties },
      },
    ],
  });

  const statusValues = ['todo', 'doing', 'done'];
  for (let index = 0; index < 3; index += 1) {
    const row = created.rows[index];
    await updateRow(baseUrl, session.accessToken, row.id, {
      title: rowTitles[index],
      properties: {
        [statusPropId]: statusValues[index],
        [duePropId]: dates[index],
        [amountPropId]: amounts[index],
        [notesPropId]: [
          '담당자 확인 후 다음 액션 기록',
          '증빙 자료와 입금 예정일 비교',
          '공유 전 숫자와 상태값 최종 검토',
        ][index],
      },
    });
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    databaseTitle,
    amountPropId,
    amountSummaryText,
    firstGroupSubtotalText,
    relationPropId,
    statusPropId,
    propertyNames: created.properties.map((prop) => prop.name),
    rowTitles,
    statusOptionNames,
    visibleProperties,
    viewIds,
  };
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

async function updateRow(baseUrl, token, rowId, patch) {
  const updated = await callFunction(baseUrl, token, 'database-row-mutation', {
    action: 'update',
    id: rowId,
    patch,
  });
  assert(updated?.row?.id === rowId, `row ${rowId} must be updated`);
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.databaseId,
  });
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', 'light');
  }, {
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function setTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem('notionlike:theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.waitForTimeout(100);
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
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
    'Playwright is required for database view UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
    onlyFilterSelect: false,
    onlyPropertyHeaderContextMenu: false,
    onlyRowContextMenu: false,
    onlySelection: false,
    onlyViewTabMenu: false,
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
    if (arg === '--only-selection') {
      parsed.onlySelection = true;
      continue;
    }
    if (arg === '--only-filter-select') {
      parsed.onlyFilterSelect = true;
      continue;
    }
    if (arg === '--only-property-header-context-menu') {
      parsed.onlyPropertyHeaderContextMenu = true;
      continue;
    }
    if (arg === '--only-row-context-menu') {
      parsed.onlyRowContextMenu = true;
      continue;
    }
    if (arg === '--only-view-tab-menu') {
      parsed.onlyViewTabMenu = true;
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
        throw new Error(`${arg} must be a number >= 1000`);
      }
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
  console.log(`Usage: node scripts/database-view-ui-smoke.mjs [options]

Checks database first-screen visual layout plus table/board/list/gallery/calendar/timeline rendering.

Options:
  --url <url>                 App runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>             API runtime URL. Defaults to NOTIONLIKE_EDGEBASE_API_URL or ${DEFAULT_BASE_URL}.
  --screenshot-dir <path>     Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
  --timeout-ms <number>       Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --only-filter-select        Only verify filter condition/value select menu click-through.
  --only-property-header-context-menu
                              Only verify property-header right-click opens the product menu.
  --only-row-context-menu     Only verify row right-click opens the compact database-row action menu.
  --only-view-tab-menu        Only verify selected visible view tabs open the product menu.
  --only-selection            Only verify selected-row chrome placement.
  --headed                    Show the browser while running.
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

function hasOpaqueFloatingSurface(snapshot) {
  return (
    !!snapshot?.backgroundColor &&
    cssColorAlpha(snapshot.backgroundColor) >= 0.99 &&
    !!snapshot?.boxShadow &&
    snapshot.boxShadow !== 'none'
  );
}

function cssColorAlpha(value) {
  if (!value || value === 'transparent') return 0;
  const color = String(value);
  const slash = color.match(/\/\s*([0-9.]+%?)/);
  if (slash) {
    const raw = slash[1];
    const parsed = Number.parseFloat(raw);
    return raw.endsWith('%') ? parsed / 100 : parsed;
  }
  const rgba = color.match(/^rgba?\((.+)\)$/);
  if (!rgba) return 1;
  const parts = rgba[1].split(',').map((part) => part.trim());
  if (parts.length >= 4) return Number.parseFloat(parts[3]);
  return 1;
}
