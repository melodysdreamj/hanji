#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'database-view-tabs');

const options = parseArgs(process.argv.slice(2));
const VIEW_TABS_FIXTURE = {
  databaseTitlePrefix: '거래처 운영 데이터베이스',
  rowTitlePrefix: '커넥트티앤아이 월말 정산 확인',
  titleProperty: '거래처명',
  statusProperty: '진행 상태',
  dateProperty: '정산 예정일',
  options: {
    todo: '검토 대기',
    doing: '진행 중',
    done: '완료',
  },
  views: {
    table: '거래처 표',
    board: '진행 보드',
    list: '정산 목록',
    gallery: '자료 갤러리',
    calendar: '정산 달력',
    timeline: '계약 타임라인',
  },
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database view tabs visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Database view tabs visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Database view tabs visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedViewTabsDatabase(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureViewTabsVariant(browser, appUrl, seed, {
      prefix: 'desktop-add-view-menu',
      viewport: { width: 1440, height: 1000 },
      open: openAddViewMenu,
      contract: {
        dialogLabel: 'New view',
        expectedTexts: ['Add view', 'Choose how this database should appear.', 'View type', 'Table', 'Board', 'List', 'Gallery', 'Calendar', 'Timeline', 'View name', 'Cancel', 'Create'],
        expectedTabLabels: Object.values(VIEW_TABS_FIXTURE.views),
        minButtons: 8,
        minInputs: 1,
        minRows: 8,
        width: [330, 380],
      },
    });
    await captureViewTabsVariant(browser, appUrl, seed, {
      prefix: 'desktop-view-actions-menu',
      viewport: { width: 1440, height: 1000 },
      open: openTableViewActionsMenu,
      contract: {
        dialogLabel: `${VIEW_TABS_FIXTURE.views.table} view actions`,
        expectedTexts: [VIEW_TABS_FIXTURE.views.table, 'Copy link to view', 'Duplicate view', 'Delete view'],
        expectedTabLabels: Object.values(VIEW_TABS_FIXTURE.views),
        minButtons: 3,
        minInputs: 1,
        minRows: 4,
        mustFitTexts: [VIEW_TABS_FIXTURE.views.table],
        width: [220, 270],
      },
    });
    await captureViewTabsVariant(browser, appUrl, seed, {
      prefix: 'mobile-add-view-menu',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openAddViewMenu,
      contract: {
        dialogLabel: 'New view',
        expectedTexts: ['Add view', 'View type', 'Table', 'Board', 'List', 'Gallery', 'Calendar', 'Timeline', 'View name', 'Cancel', 'Create'],
        expectedTabLabels: Object.values(VIEW_TABS_FIXTURE.views),
        minButtons: 8,
        minInputs: 1,
        minRows: 8,
        width: [330, 390],
      },
    });
    await captureViewTabsVariant(browser, appUrl, seed, {
      prefix: 'mobile-view-actions-menu',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openTableViewActionsMenu,
      contract: {
        dialogLabel: `${VIEW_TABS_FIXTURE.views.table} view actions`,
        expectedTexts: [VIEW_TABS_FIXTURE.views.table, 'Copy link to view', 'Duplicate view', 'Delete view'],
        expectedTabLabels: Object.values(VIEW_TABS_FIXTURE.views),
        minButtons: 3,
        minInputs: 1,
        minRows: 4,
        mustFitTexts: [VIEW_TABS_FIXTURE.views.table],
        width: [220, 270],
      },
    });

    console.log('PASS database view tab menus are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-add-view-menu',
      'desktop-view-actions-menu',
      'mobile-add-view-menu',
      'mobile-view-actions-menu',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureViewTabsVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, appUrl, seed);
    await variant.open(page, seed);
    await assertDialogContract(page, variant.contract, { mobile: !!variant.mobile, prefix: variant.prefix });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} database view tabs visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
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
  await page.getByRole('tab', { name: seed.viewNames.table }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (rowTitle) =>
      Array.from(document.querySelectorAll('input')).some(
        (input) => input.value === rowTitle && input.offsetParent !== null,
      ),
    seed.rowTitle,
    { timeout: options.timeoutMs },
  );
}

async function openAddViewMenu(page) {
  await page.getByRole('button', { name: /^Add view$/ }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('dialog', { name: 'New view' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openTableViewActionsMenu(page) {
  await page.getByRole('button', { name: `${VIEW_TABS_FIXTURE.views.table} view actions` }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('dialog', { name: `${VIEW_TABS_FIXTURE.views.table} view actions` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertDialogContract(page, contract, variant) {
  const metrics = await page.evaluate(({ dialogLabel, expectedTexts, expectedTabLabels, mustFitTexts }) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) =>
        element instanceof HTMLElement &&
        isVisible(element) &&
        element.getAttribute('aria-label') === dialogLabel,
    );
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: `missing dialog ${dialogLabel}` };
    const rect = dialog.getBoundingClientRect();
    const clipped = clippedByOverflowAncestor(dialog, rect);
    const buttons = visibleElements(dialog.querySelectorAll('button, [role="option"], [role="menuitem"], [role="radio"]'));
    const inputs = visibleElements(dialog.querySelectorAll('input, textarea, select, [role="combobox"]'));
    const wideInputs = inputs.filter((element) => {
      if (!(element instanceof HTMLInputElement)) return true;
      const type = element.type.toLowerCase();
      return type !== 'checkbox' && type !== 'radio';
    });
    const rows = visibleElements(dialog.querySelectorAll('button, [role="option"], [role="menuitem"], [role="radio"], label'));
    const rowHeights = rows.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0);
    const inputWidths = wideInputs.map((element) => element.getBoundingClientRect().width).filter((width) => width > 0);
    const formText = visibleElements(dialog.querySelectorAll('input, textarea, select'))
      .map((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return `${element.value} ${element.placeholder}`;
        }
        if (element instanceof HTMLSelectElement) {
          return Array.from(element.selectedOptions).map((option) => option.textContent ?? '').join(' ');
        }
        return '';
      })
      .join(' ');
    const interactiveRects = [...buttons, ...wideInputs].map((element) => {
      const itemRect = element.getBoundingClientRect();
      return {
        bottom: itemRect.bottom,
        left: itemRect.left,
        right: itemRect.right,
        text: element.textContent?.replace(/\s+/g, ' ').trim() || element.getAttribute('aria-label') || '',
        top: itemRect.top,
      };
    });
    const clippedInteractive = interactiveRects.filter(
      (item) =>
        item.top < 0 ||
        item.bottom > window.innerHeight - 4 ||
        item.left < 0 ||
        item.right > window.innerWidth + 1,
    );
    const text = `${dialog.textContent ?? ''} ${formText}`;
    const textLower = text.toLowerCase();
    const clippedTexts = mustFitTexts
      .map((item) => {
        const target = visibleElements(dialog.querySelectorAll('span, button, label, input, textarea, [role="option"], [role="menuitem"], [role="radio"]')).find(
          (element) => {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              return element.value === item || element.placeholder === item;
            }
            return (element.textContent ?? '').trim() === item;
          },
        );
        if (!(target instanceof HTMLElement)) return { item, status: 'missing' };
        const targetRect = target.getBoundingClientRect();
        return {
          clientWidth: target.clientWidth,
          item,
          rectWidth: targetRect.width,
          scrollWidth: target.scrollWidth,
          status: target.scrollWidth > target.clientWidth + 1 ? 'clipped' : 'ok',
        };
      })
      .filter((entry) => entry.status !== 'ok');
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      bottomGap: window.innerHeight - rect.bottom,
      buttonCount: buttons.length,
      clipped,
      clippedInteractive,
      clippedTexts,
      documentScrollWidth: document.documentElement.scrollWidth,
      expectedTextsPresent: expectedTexts.every((item) => textLower.includes(String(item).toLowerCase())),
      height: rect.height,
      inputCount: wideInputs.length,
      inputMinWidth: inputWidths.length ? Math.min(...inputWidths) : 0,
      left: rect.left,
      maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
      minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
      rightGap: window.innerWidth - rect.right,
      rowCount: rows.length,
      top: rect.top,
      tabRail: measureTabRail(expectedTabLabels),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };

    function visibleElements(items) {
      return Array.from(items).filter(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    }

    function clippedByOverflowAncestor(element, baseRect) {
      if (window.getComputedStyle(element).position === 'fixed') {
        return { height: baseRect.height, isClipped: false, width: baseRect.width };
      }
      let left = baseRect.left;
      let top = baseRect.top;
      let right = baseRect.right;
      let bottom = baseRect.bottom;
      let current = element.parentElement;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const clipsX = !['visible', 'clip'].includes(style.overflowX);
        const clipsY = !['visible', 'clip'].includes(style.overflowY);
        if (clipsX || clipsY) {
          const currentRect = current.getBoundingClientRect();
          if (clipsX) {
            left = Math.max(left, currentRect.left);
            right = Math.min(right, currentRect.right);
          }
          if (clipsY) {
            top = Math.max(top, currentRect.top);
            bottom = Math.min(bottom, currentRect.bottom);
          }
        }
        current = current.parentElement;
      }
      const visibleWidth = Math.max(0, right - left);
      const visibleHeight = Math.max(0, bottom - top);
      return {
        height: visibleHeight,
        isClipped: visibleWidth < baseRect.width - 1 || visibleHeight < baseRect.height - 1,
        width: visibleWidth,
      };
    }

    function measureTabRail(expectedLabels) {
      const tablist = document.querySelector('[role="tablist"]');
      if (!(tablist instanceof HTMLElement)) {
        return { ok: false, reason: 'missing view tablist', partialLabelEdges: [] };
      }
      const railRect = tablist.getBoundingClientRect();
      const items = Array.from(tablist.querySelectorAll('[data-view-tab-wrap]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element))
        .map((element) => measureViewTabItem(element, railRect));
      const partialLabelEdges = items.filter((item) => item.labelVisible && (item.leftClipped || item.rightClipped));
      const allLabels = items.map((item) => item.text);
      const visibleLabels = items.filter((item) => item.labelVisible).map((item) => item.text);
      const missingExpectedLabels = expectedLabels.filter((label) => !allLabels.includes(label));
      const active = items.find((item) => item.active);
      return {
        ok: true,
        active,
        allLabels,
        left: Math.round(railRect.left),
        missingExpectedLabels,
        partialLabelEdges,
        right: Math.round(railRect.right),
        scrollLeft: Math.round(tablist.scrollLeft),
        visibleLabels,
      };
    }

    function measureViewTabItem(element, railRect) {
      const rect = element.getBoundingClientRect();
      const label = element.querySelector('[data-view-tab-name]');
      const labelRect = label instanceof HTMLElement ? label.getBoundingClientRect() : null;
      const labelStyle = label instanceof HTMLElement ? window.getComputedStyle(label) : null;
      const labelVisible = !!labelRect && !!labelStyle && isReadableTabLabel(labelStyle, labelRect);
      const leftClipped = !!labelRect && labelRect.left < railRect.left - 1 && labelRect.right > railRect.left + 8;
      const rightClipped = !!labelRect && labelRect.right > railRect.right + 1 && labelRect.left < railRect.right - 8;
      const visibleInRail = !!labelRect && labelRect.right > railRect.left + 8 && labelRect.left < railRect.right - 8;
      return {
        active: element.getAttribute('data-active') === 'true',
        itemLeft: Math.round(rect.left),
        itemRight: Math.round(rect.right),
        labelLeft: labelRect ? Math.round(labelRect.left) : null,
        labelRight: labelRect ? Math.round(labelRect.right) : null,
        labelVisible,
        leftClipped,
        rightClipped,
        text: label?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        visibleInRail,
      };
    }

    function isReadableTabLabel(style, rect) {
      const clippedForA11y =
        style.clipPath !== 'none' ||
        (style.clip !== 'auto' && style.clip !== 'rect(auto, auto, auto, auto)');
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        !clippedForA11y &&
        rect.width >= 8 &&
        rect.height >= 8
      );
    }
  }, {
    dialogLabel: contract.dialogLabel,
    expectedTexts: contract.expectedTexts ?? [],
    expectedTabLabels: contract.expectedTabLabels ?? [],
    mustFitTexts: contract.mustFitTexts ?? [],
  });

  assert(metrics.ok, metrics.reason ?? `${contract.dialogLabel} contract could not run`);
  const [minWidth, maxWidth] = contract.width;
  assert(metrics.width >= minWidth && metrics.width <= maxWidth, `${contract.dialogLabel} width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.left >= (variant.mobile ? 0 : 8), `${contract.dialogLabel} should not drift off the left edge: ${JSON.stringify(metrics)}`);
  assert(metrics.rightGap >= (variant.mobile ? 0 : 8), `${contract.dialogLabel} should not drift off the right edge: ${JSON.stringify(metrics)}`);
  assert(metrics.top >= 32, `${contract.dialogLabel} should not overlap the browser/top chrome: ${JSON.stringify(metrics)}`);
  assert(metrics.bottomGap >= 8, `${contract.dialogLabel} should leave a bottom inset instead of clipping the last row/actions: ${JSON.stringify(metrics)}`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${contract.dialogLabel} should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.height <= metrics.viewportHeight - 16, `${contract.dialogLabel} should fit in viewport height: ${JSON.stringify(metrics)}`);
  assert(!metrics.clipped.isClipped, `${contract.dialogLabel} should not be clipped by tablist/menu ancestors: ${JSON.stringify(metrics)}`);
  assert(metrics.clippedInteractive.length === 0, `${contract.dialogLabel} should not partially clip interactive controls: ${JSON.stringify(metrics)}`);
  assert(!variant.mobile || metrics.tabRail.ok, `${contract.dialogLabel} surrounding view tab rail should be measurable on mobile: ${JSON.stringify(metrics)}`);
  assert(
    !variant.mobile || metrics.tabRail.partialLabelEdges.length === 0,
    `${contract.dialogLabel} should not leave half-clipped view tab labels in the surrounding rail: ${JSON.stringify(metrics)}`
  );
  assert(
    !variant.mobile || metrics.tabRail.missingExpectedLabels.length === 0,
    `${contract.dialogLabel} should keep all seeded Korean view labels discoverable in the surrounding rail: ${JSON.stringify(metrics)}`
  );
  assert(
    !variant.mobile || !metrics.tabRail.active || !metrics.tabRail.active.visibleInRail || !metrics.tabRail.active.leftClipped,
    `${contract.dialogLabel} should align the active view tab to a clean readable start on mobile: ${JSON.stringify(metrics)}`
  );
  assert(metrics.buttonCount >= (contract.minButtons ?? 0), `${contract.dialogLabel} has too few action rows: ${JSON.stringify(metrics)}`);
  assert(metrics.inputCount >= (contract.minInputs ?? 0), `${contract.dialogLabel} has too few inputs: ${JSON.stringify(metrics)}`);
  assert(metrics.rowCount >= (contract.minRows ?? 0), `${contract.dialogLabel} has too few visible rows: ${JSON.stringify(metrics)}`);
  assert(metrics.expectedTextsPresent, `${contract.dialogLabel} is missing expected text: ${JSON.stringify(metrics)}`);
  assert(metrics.clippedTexts.length === 0, `${contract.dialogLabel} clipped required Korean text: ${JSON.stringify(metrics)}`);
  assert(metrics.inputCount === 0 || metrics.inputMinWidth >= 120, `${contract.dialogLabel} input width is too cramped: ${JSON.stringify(metrics)}`);
  assert(metrics.maxRowHeight <= (contract.maxRowHeight ?? 76), `${contract.dialogLabel} row height is too loose: ${JSON.stringify(metrics)}`);
  assert(metrics.minRowHeight === 0 || metrics.minRowHeight >= 18, `${contract.dialogLabel} row height is too cramped: ${JSON.stringify(metrics)}`);
}

async function seedViewTabsDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database view tabs visual smoke');

  const suffix = Date.now();
  const short = String(suffix).slice(-6);
  const databaseId = randomUUID();
  const rowId = randomUUID();
  const titlePropId = randomUUID();
  const statusPropId = randomUUID();
  const datePropId = randomUUID();
  const databaseTitle = `${VIEW_TABS_FIXTURE.databaseTitlePrefix} ${short}`;
  const rowTitle = `${VIEW_TABS_FIXTURE.rowTitlePrefix} ${short}`;

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: databaseTitle,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: titlePropId, name: VIEW_TABS_FIXTURE.titleProperty, type: 'title', position: 1 },
      {
        id: statusPropId,
        name: VIEW_TABS_FIXTURE.statusProperty,
        type: 'status',
        position: 2,
        options: [
          { id: 'todo', name: VIEW_TABS_FIXTURE.options.todo, color: 'gray' },
          { id: 'doing', name: VIEW_TABS_FIXTURE.options.doing, color: 'blue' },
          { id: 'done', name: VIEW_TABS_FIXTURE.options.done, color: 'green' },
        ],
      },
      { id: datePropId, name: VIEW_TABS_FIXTURE.dateProperty, type: 'date', position: 3 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database view tabs visual smoke database must be created');

  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database view tabs visual smoke must receive a table view');
  const visibleProperties = [titlePropId, statusPropId, datePropId];

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    patch: {
      name: VIEW_TABS_FIXTURE.views.table,
      position: 1,
      config: { propertyOrder: visibleProperties, visibleProperties },
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: randomUUID(),
        databaseId,
        name: VIEW_TABS_FIXTURE.views.board,
        type: 'board',
        position: 2,
        config: { groupBy: statusPropId, visibleProperties, cardSize: 'medium' },
      },
      {
        id: randomUUID(),
        databaseId,
        name: VIEW_TABS_FIXTURE.views.list,
        type: 'list',
        position: 3,
        config: { visibleProperties },
      },
      {
        id: randomUUID(),
        databaseId,
        name: VIEW_TABS_FIXTURE.views.gallery,
        type: 'gallery',
        position: 4,
        config: { visibleProperties, cardSize: 'medium' },
      },
      {
        id: randomUUID(),
        databaseId,
        name: VIEW_TABS_FIXTURE.views.calendar,
        type: 'calendar',
        position: 5,
        config: { calendarBy: datePropId, visibleProperties },
      },
      {
        id: randomUUID(),
        databaseId,
        name: VIEW_TABS_FIXTURE.views.timeline,
        type: 'timeline',
        position: 6,
        config: { timelineBy: datePropId, timelineZoom: 'day', visibleProperties },
      },
    ],
  });

  const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: rowTitle,
    properties: {
      [statusPropId]: 'doing',
      [datePropId]: '2026-06-25',
    },
  });
  assert(createdRow?.row?.id === rowId, 'database view tabs visual smoke row must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    databaseTitle,
    rowTitle,
    viewNames: VIEW_TABS_FIXTURE.views,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.databaseId,
  }).catch(() => {});
}

async function seedSession(context, seed, theme = 'light') {
  await context.addInitScript(({ refreshToken, workspaceId, theme }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', theme);
  }, {
    refreshToken: seed.refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
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
    'Playwright is required for database view tabs visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
  console.log(`Usage: node scripts/database-view-tabs-visual-smoke.mjs [options]

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
