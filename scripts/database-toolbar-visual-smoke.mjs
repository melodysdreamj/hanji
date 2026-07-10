#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'database-toolbar');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database toolbar visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Database toolbar visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Database toolbar visual smoke API target: ${apiUrl}`);

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
    await captureToolbarVariant(browser, appUrl, seed, {
      prefix: 'desktop-layout-options',
      viewport: { width: 1440, height: 1000 },
      open: openLayoutMenu,
      contract: {
        dialogLabel: 'Layout options',
        expectedTexts: ['Layout', 'Table', 'Board', 'List', 'Gallery', 'Calendar', 'Timeline', 'Open pages in', 'Row height'],
        minButtons: 12,
        minRows: 10,
        width: [520, 580],
        maxRowHeight: 96,
      },
    });
    await captureToolbarVariant(browser, appUrl, seed, {
      prefix: 'desktop-filters-menu',
      viewport: { width: 1440, height: 1000 },
      open: openFiltersMenu,
      contract: {
        dialogLabel: 'Filters',
        expectedTexts: ['Filters', 'Add filter', 'Add filter group'],
        minButtons: 2,
        minRows: 2,
        width: [420, 540],
      },
    });
    await captureToolbarVariant(browser, appUrl, seed, {
      prefix: 'desktop-relation-filter-value-menu',
      viewport: { width: 1440, height: 1000 },
      open: openRelationFilterValueMenu,
      assert: assertRelationFilterValueMenu,
      contract: {
        dialogLabel: 'Filters',
        expectedTexts: ['Filters', 'Related', seed.relationTargetTitle],
        minButtons: 2,
        minRows: 2,
        width: [420, 540],
      },
    });
    await captureToolbarVariant(browser, appUrl, seed, {
      prefix: 'desktop-sorts-menu',
      viewport: { width: 1440, height: 1000 },
      open: openSortsMenu,
      contract: {
        dialogLabel: 'Sorts',
        expectedTexts: ['Sorts', 'Add sort'],
        minButtons: 1,
        minRows: 1,
        width: [420, 540],
      },
    });
    await captureToolbarVariant(browser, appUrl, seed, {
      prefix: 'desktop-new-page-menu',
      viewport: { width: 1440, height: 1000 },
      open: openNewPageMenu,
      contract: {
        dialogLabel: 'New database page',
        expectedTexts: ['New page', 'Create an empty page', 'New from template', 'No templates yet', 'New template'],
        minButtons: 2,
        minInputs: 1,
        minRows: 2,
        width: [320, 380],
      },
    });
    await captureToolbarVariant(browser, appUrl, seed, {
      prefix: 'mobile-layout-options',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openLayoutMenu,
      contract: {
        dialogLabel: 'Layout options',
        expectedTexts: ['Layout', 'Table', 'Board', 'List', 'Gallery', 'Calendar', 'Timeline', 'Open pages in'],
        minButtons: 10,
        minRows: 9,
        maxRowHeight: 96,
        width: [300, 390],
      },
    });
    await captureToolbarVariant(browser, appUrl, seed, {
      prefix: 'mobile-new-page-menu',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openNewPageMenu,
      contract: {
        dialogLabel: 'New database page',
        expectedTexts: ['New page', 'Create an empty page', 'New from template', 'No templates yet', 'New template'],
        minButtons: 2,
        minInputs: 1,
        minRows: 2,
        width: [300, 390],
      },
    });

    console.log('PASS database toolbar menus are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-layout-options',
      'desktop-filters-menu',
      'desktop-relation-filter-value-menu',
      'desktop-sorts-menu',
      'desktop-new-page-menu',
      'mobile-layout-options',
      'mobile-new-page-menu',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureToolbarVariant(browser, appUrl, seed, variant) {
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
    await assertDialogContract(page, variant.contract, { mobile: !!variant.mobile });
    if (variant.assert) await variant.assert(page, seed);
    await assertToolbarContract(page, { mobile: !!variant.mobile, prefix: variant.prefix });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} database toolbar visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertToolbarContract(page, variant) {
  const metrics = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
    if (!(toolbar instanceof HTMLElement)) return { ok: false, reason: 'missing database toolbar' };
    const toolbarRect = toolbar.getBoundingClientRect();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const visibleButtons = Array.from(toolbar.querySelectorAll('button')).filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.closest('[role="dialog"]')) return false;
      if (element.tabIndex < 0) return false;
      return isVisible(element);
    });
    const visibleToolbarBadges = Array.from(toolbar.querySelectorAll('[class*="toolbarBadge"]'))
      .filter((element) => element instanceof HTMLElement && !element.closest('[role="dialog"]') && isVisible(element))
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const noisyNumberNodes = visibleButtons.flatMap((button) =>
      Array.from(button.querySelectorAll('span'))
        .filter((element) => element instanceof HTMLElement && isVisible(element))
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .filter((text) => /^\d+(?:\s+hidden)?$/i.test(text)),
    );
    const clippedButtons = visibleButtons
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const label = element.getAttribute('aria-label') || element.textContent?.trim() || 'unnamed button';
        return {
          label,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          clipped:
            rect.left < toolbarRect.left - 1 ||
            rect.right > toolbarRect.right + 1 ||
            rect.left < -1 ||
            rect.right > window.innerWidth + 1,
        };
      })
      .filter((item) => item.clipped);
    return {
      ok: true,
      clippedButtons,
      clientWidth: toolbar.clientWidth,
      scrollLeft: toolbar.scrollLeft,
      scrollWidth: toolbar.scrollWidth,
      toolbarLeft: toolbarRect.left,
      toolbarRight: toolbarRect.right,
      noisyNumberNodes,
      visibleToolbarBadges,
      viewportWidth: window.innerWidth,
    };
  });

  assert(metrics.ok, metrics.reason ?? `${variant.prefix} toolbar contract could not run`);
  assert(
    metrics.visibleToolbarBadges.length === 0,
    `${variant.prefix} toolbar should not show Notion-unlike numeric badge chips: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.noisyNumberNodes.length === 0,
    `${variant.prefix} toolbar buttons should not expose standalone numeric status text: ${JSON.stringify(metrics)}`,
  );
  if (!variant.mobile) return;
  assert(metrics.scrollLeft <= 1, `${variant.prefix} mobile toolbar should not stay horizontally scrolled: ${JSON.stringify(metrics)}`);
  assert(metrics.scrollWidth <= metrics.clientWidth + 4, `${variant.prefix} mobile toolbar should not require horizontal scrolling: ${JSON.stringify(metrics)}`);
  assert(metrics.clippedButtons.length === 0, `${variant.prefix} mobile toolbar should not show partially clipped controls: ${JSON.stringify(metrics)}`);
}

async function openDatabase(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('toolbar', { name: 'Database toolbar' }).waitFor({
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

async function openLayoutMenu(page) {
  await toolbarButton(page, /^Layout$/).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Layout options' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openFiltersMenu(page) {
  await toolbarButton(page, /^Filter/).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Filters' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openRelationFilterValueMenu(page, seed) {
  await openFiltersMenu(page);
  await page.waitForFunction(
    (text) => document.body.textContent?.includes(text),
    seed.relationTargetTitle,
    { timeout: options.timeoutMs },
  );
  await page.getByRole('button', { name: 'Filter value for Related' }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('menuitemradio', { name: seed.relationTargetTitle }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertRelationFilterValueMenu(page, seed) {
  const metrics = await page.evaluate((targetTitle) => {
    const menuItems = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .map((element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        checked: element.getAttribute('aria-checked') === 'true',
      }));
    return {
      checkedTargetCount: menuItems.filter((item) => item.checked && item.text.includes(targetTitle)).length,
      hasTarget: menuItems.some((item) => item.text.includes(targetTitle)),
      menuItems,
      targetTitle,
    };

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, seed.relationTargetTitle);
  assert(
    metrics.hasTarget,
    `Relation filter value menu should list the target relation page: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.checkedTargetCount === 1,
    `Relation filter value menu should mark the active target relation page: ${JSON.stringify(metrics)}`,
  );
}

async function openSortsMenu(page) {
  await toolbarButton(page, /^Sort/).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Sorts' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openNewPageMenu(page) {
  await page.getByRole('button', { name: 'Choose database template' }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('dialog', { name: 'New database page' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

function toolbarButton(page, name) {
  return page.getByRole('toolbar', { name: 'Database toolbar' }).getByRole('button', { name }).first();
}

async function assertDialogContract(page, contract, variant) {
  const metrics = await page.evaluate(({ dialogLabel, expectedTexts }) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) =>
        element instanceof HTMLElement &&
        isVisible(element) &&
        element.getAttribute('aria-label') === dialogLabel,
    );
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: `missing dialog ${dialogLabel}` };
    const rect = dialog.getBoundingClientRect();
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
    const text = dialog.textContent ?? '';
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      bottomGap: window.innerHeight - rect.bottom,
      buttonCount: buttons.length,
      documentScrollWidth: document.documentElement.scrollWidth,
      expectedTextsPresent: expectedTexts.every((item) => text.includes(item)),
      height: rect.height,
      inputCount: wideInputs.length,
      inputMinWidth: inputWidths.length ? Math.min(...inputWidths) : 0,
      left: rect.left,
      maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
      minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
      rightGap: window.innerWidth - rect.right,
      rowCount: rows.length,
      top: rect.top,
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
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, {
    dialogLabel: contract.dialogLabel,
    expectedTexts: contract.expectedTexts ?? [],
  });

  assert(metrics.ok, metrics.reason ?? `${contract.dialogLabel} contract could not run`);
  const [minWidth, maxWidth] = contract.width;
  assert(metrics.width >= minWidth && metrics.width <= maxWidth, `${contract.dialogLabel} width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.left >= (variant.mobile ? 0 : 8), `${contract.dialogLabel} should not drift off the left edge: ${JSON.stringify(metrics)}`);
  assert(metrics.rightGap >= (variant.mobile ? 0 : 8), `${contract.dialogLabel} should not drift off the right edge: ${JSON.stringify(metrics)}`);
  assert(metrics.top >= 40 && metrics.bottomGap >= 8, `${contract.dialogLabel} should stay inside the viewport: ${JSON.stringify(metrics)}`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${contract.dialogLabel} should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.height <= metrics.viewportHeight - 16, `${contract.dialogLabel} should fit in viewport height: ${JSON.stringify(metrics)}`);
  assert(metrics.buttonCount >= (contract.minButtons ?? 0), `${contract.dialogLabel} has too few action rows: ${JSON.stringify(metrics)}`);
  assert(metrics.inputCount >= (contract.minInputs ?? 0), `${contract.dialogLabel} has too few inputs: ${JSON.stringify(metrics)}`);
  assert(metrics.rowCount >= (contract.minRows ?? 0), `${contract.dialogLabel} has too few visible rows: ${JSON.stringify(metrics)}`);
  assert(metrics.expectedTextsPresent, `${contract.dialogLabel} is missing expected text: ${JSON.stringify(metrics)}`);
  assert(metrics.inputCount === 0 || metrics.inputMinWidth >= 120, `${contract.dialogLabel} input width is too cramped: ${JSON.stringify(metrics)}`);
  assert(metrics.maxRowHeight <= (contract.maxRowHeight ?? 72), `${contract.dialogLabel} row height is too loose: ${JSON.stringify(metrics)}`);
  assert(metrics.minRowHeight === 0 || metrics.minRowHeight >= 18, `${contract.dialogLabel} row height is too cramped: ${JSON.stringify(metrics)}`);
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database toolbar visual smoke');

  const suffix = Date.now();
  const short = String(suffix).slice(-6);
  const databaseId = randomUUID();
  const targetDatabaseId = randomUUID();
  const rowId = randomUUID();
  const targetRowId = randomUUID();
  const targetTitlePropId = randomUUID();
  const relationTargetTitle = `Toolbar related ${short}`;
  const propertyIds = {
    title: randomUUID(),
    status: randomUUID(),
    related: randomUUID(),
    notes: randomUUID(),
    due: randomUUID(),
  };
  const propertyOrder = [
    propertyIds.title,
    propertyIds.status,
    propertyIds.related,
    propertyIds.notes,
    propertyIds.due,
  ];
  const rowTitle = `Toolbar visual row ${short}`;

  const targetCreated = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: targetDatabaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Toolbar relation targets ${short}`,
    position: suffix - 1,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: targetTitlePropId, name: 'Name', type: 'title', position: 1 },
    ],
  });
  assert(targetCreated?.page?.id === targetDatabaseId, 'database toolbar visual smoke target database must be created');
  const createdTargetRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: targetRowId,
    databaseId: targetDatabaseId,
    title: relationTargetTitle,
    properties: {},
  });
  assert(createdTargetRow?.row?.id === targetRowId, 'database toolbar visual smoke target relation row must be created');

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Toolbar visual ${short}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: propertyIds.title, name: 'Name', type: 'title', position: 1 },
      {
        id: propertyIds.status,
        name: 'Status',
        type: 'select',
        position: 2,
        options: [
          { id: 'todo', name: 'Todo', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      {
        id: propertyIds.related,
        name: 'Related',
        type: 'relation',
        position: 3,
        config: { relationDatabaseId: targetDatabaseId },
      },
      { id: propertyIds.notes, name: 'Notes', type: 'rich_text', position: 4 },
      { id: propertyIds.due, name: 'Due', type: 'date', position: 5 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database toolbar visual smoke database must be created');
  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database toolbar visual smoke must receive a table view');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    workspaceId,
    table: 'db_views',
    id: tableViewId,
    patch: {
      name: 'Table',
      position: 1,
      config: {
        propertyOrder,
        propertyWidths: {
          [propertyIds.title]: 260,
          [propertyIds.status]: 170,
          [propertyIds.related]: 210,
          [propertyIds.notes]: 240,
          [propertyIds.due]: 170,
        },
        visibleProperties: [propertyIds.title, propertyIds.status, propertyIds.related, propertyIds.notes],
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: propertyIds.related, operator: 'contains', value: targetRowId }],
          groups: [],
        },
        sorts: [{ propertyId: propertyIds.due, direction: 'asc' }],
      },
    },
  });

  const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: rowTitle,
    properties: {
      [propertyIds.status]: 'todo',
      [propertyIds.related]: [targetRowId],
      [propertyIds.notes]: `Toolbar note ${short}`,
      [propertyIds.due]: '2026-06-25',
    },
  });
  assert(createdRow?.row?.id === rowId, 'database toolbar visual smoke row must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    targetDatabaseId,
    rowId,
    targetRowId,
    relationTargetTitle,
    rowTitle,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  for (const id of [seed.databaseId, seed.targetDatabaseId].filter(Boolean)) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id,
    }).catch(() => {});
  }
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
    'Playwright is required for database toolbar visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/database-toolbar-visual-smoke.mjs [options]

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
