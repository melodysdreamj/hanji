#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_DIR = join(root, '.edgebase', 'ui-discovery', 'database-filter-matrix');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database filter matrix smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Database filter matrix smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Database filter matrix smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.outputDir, { recursive: true });
  const seed = await seedDatabase(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const { context, page, errors } = await newCheckedPage(browser, {
      deviceScaleFactor: 1,
      viewport: { width: 1440, height: 1000 },
    });
    await seedSession(context, seed);
    try {
      await openDatabase(page, appUrl, seed);
      await openFiltersMenu(page);
      const audit = await auditFilterMatrix(page, seed);
      audit.staleRelationFilter = await auditStaleRelationFilter(page, apiUrl, seed);
      await page.screenshot({
        path: join(options.outputDir, 'database-filter-matrix.png'),
        fullPage: false,
      });
      writeFileSync(
        join(options.outputDir, 'database-filter-matrix.json'),
        JSON.stringify(audit, null, 2),
      );
      assertNoBrowserErrors(errors, 'database filter matrix');
    } finally {
      await context.close().catch(() => {});
    }

    console.log('PASS database filter controls cover the property/operator/value matrix.');
    console.log(`Artifact: ${join(options.outputDir, 'database-filter-matrix.json')}`);
    console.log(`Screenshot: ${join(options.outputDir, 'database-filter-matrix.png')}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function auditFilterMatrix(page, seed) {
  const checks = [
    {
      propertyName: 'Name',
      expectedOperators: ['Contains', 'Does not contain', 'Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'text',
    },
    {
      propertyName: 'Text',
      expectedOperators: ['Contains', 'Does not contain', 'Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'text',
    },
    {
      propertyName: 'Amount',
      expectedOperators: ['Is', 'Is not', 'Greater than', 'Less than', 'Is empty', 'Is not empty'],
      valueKind: 'number',
    },
    {
      propertyName: 'Status',
      expectedOperators: ['Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose option', 'Todo', 'Doing'],
    },
    {
      propertyName: 'Tags',
      expectedOperators: ['Contains', 'Does not contain', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose option', 'Alpha', 'Beta'],
    },
    {
      propertyName: 'Stage',
      expectedOperators: ['Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose option', 'Not started', 'Done'],
    },
    {
      propertyName: 'Due',
      expectedOperators: ['On or after', 'On or before', 'Is', 'Is empty', 'Is not empty'],
      valueKind: 'date',
    },
    {
      propertyName: 'Owner',
      expectedOperators: ['Contains', 'Does not contain', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose person', 'You'],
    },
    {
      propertyName: 'Done',
      expectedOperators: ['Is', 'Is not'],
      valueKind: 'menu',
      expectedValueTexts: ['Checked', 'Unchecked'],
    },
    {
      propertyName: 'Files',
      expectedOperators: ['Is empty', 'Is not empty'],
      valueKind: 'none',
    },
    {
      propertyName: 'Related',
      expectedOperators: ['Contains', 'Does not contain', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose page', 'Current page', seed.relationTargetTitle],
    },
    {
      propertyName: 'Formula',
      expectedOperators: ['Contains', 'Does not contain', 'Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'text',
    },
    {
      propertyName: 'Related rollup',
      expectedOperators: ['Contains', 'Does not contain', 'Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose page', 'Current page', seed.relationTargetTitle],
    },
    {
      propertyName: 'URL',
      expectedOperators: ['Contains', 'Does not contain', 'Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'text',
    },
    {
      propertyName: 'Email',
      expectedOperators: ['Contains', 'Does not contain', 'Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'text',
    },
    {
      propertyName: 'Phone',
      expectedOperators: ['Contains', 'Does not contain', 'Is', 'Is not', 'Is empty', 'Is not empty'],
      valueKind: 'text',
    },
    {
      propertyName: 'ID',
      expectedOperators: ['Is', 'Is not', 'Greater than', 'Less than', 'Is empty', 'Is not empty'],
      valueKind: 'number',
    },
    {
      propertyName: 'Created time',
      expectedOperators: ['On or after', 'On or before', 'Is', 'Is empty', 'Is not empty'],
      valueKind: 'date',
    },
    {
      propertyName: 'Last edited time',
      expectedOperators: ['On or after', 'On or before', 'Is', 'Is empty', 'Is not empty'],
      valueKind: 'date',
    },
    {
      propertyName: 'Created by',
      expectedOperators: ['Contains', 'Does not contain', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose person', 'You'],
    },
    {
      propertyName: 'Last edited by',
      expectedOperators: ['Contains', 'Does not contain', 'Is empty', 'Is not empty'],
      valueKind: 'menu',
      expectedValueTexts: ['Choose person', 'You'],
    },
  ];

  const results = [];
  for (const check of checks) {
    const result = await auditFilterProperty(page, check);
    results.push(result);
  }
  return {
    checkedAt: new Date().toISOString(),
    databaseId: seed.databaseId,
    propertyCount: checks.length,
    results,
  };
}

async function auditFilterProperty(page, check) {
  const row = page.locator('[data-filter-row]').first();
  await setFilterProperty(page, row, check.propertyName);
  const operatorTexts = await openAndCollectMenu(page, row.locator('button[aria-label="Filter condition"]'), 'Filter condition');
  for (const text of check.expectedOperators) {
    assert(
      operatorTexts.some((item) => item.text === text),
      `${check.propertyName} filter condition menu is missing ${text}: ${JSON.stringify(operatorTexts)}`,
    );
  }

  const valueLabel = `Filter value for ${check.propertyName}`;
  let valueProbe;
  if (check.valueKind === 'none') {
    valueProbe = await page.evaluate((label) => {
      return {
        valueButtonCount: document.querySelectorAll(`button[aria-label="${CSS.escape(label)}"]`).length,
        valueInputCount: document.querySelectorAll(`input[aria-label="${CSS.escape(label)}"]`).length,
      };
    }, valueLabel);
    assert(
      valueProbe.valueButtonCount === 0 && valueProbe.valueInputCount === 0,
      `${check.propertyName} should not render a value input for no-value filters: ${JSON.stringify(valueProbe)}`,
    );
  } else if (check.valueKind === 'menu') {
    const valueTexts = await openAndCollectMenu(page, row.locator(`button[aria-label="${valueLabel}"]`), valueLabel);
    for (const text of check.expectedValueTexts ?? []) {
      assert(
        valueTexts.some((item) => item.text.includes(text)),
        `${check.propertyName} value menu is missing ${text}: ${JSON.stringify(valueTexts)}`,
      );
    }
    valueProbe = valueTexts;
  } else {
    valueProbe = await page.evaluate((label) => {
      const input = document.querySelector(`input[aria-label="${CSS.escape(label)}"]`);
      if (!(input instanceof HTMLInputElement)) return { ok: false };
      return {
        ok: true,
        inputMode: input.inputMode,
        placeholder: input.placeholder,
        type: input.type,
      };
    }, valueLabel);
    assert(valueProbe.ok, `${check.propertyName} should render an input value editor: ${JSON.stringify(valueProbe)}`);
    if (check.valueKind === 'number') {
      assert(
        valueProbe.inputMode === 'decimal' || valueProbe.type === 'number' || valueProbe.type === 'text',
        `${check.propertyName} should use a numeric-friendly value input: ${JSON.stringify(valueProbe)}`,
      );
    }
  }

  return {
    propertyName: check.propertyName,
    operatorTexts,
    valueKind: check.valueKind,
    valueProbe,
  };
}

async function setFilterProperty(page, row, propertyName) {
  const propertyButton = row.locator('button[aria-label="Filter property"]');
  const currentText = (await propertyButton.textContent({ timeout: options.timeoutMs }).catch(() => '')) ?? '';
  if (currentText.replace(/\s+/g, ' ').includes(propertyName)) return;
  await propertyButton.click({ timeout: options.timeoutMs });
  await page.getByRole('menuitemradio', { name: propertyName, exact: true }).click({
    force: true,
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ propertyName }) =>
      document
        .querySelector('[data-filter-row] button[aria-label="Filter property"]')
        ?.textContent
        ?.replace(/\s+/g, ' ')
        .includes(propertyName),
    { propertyName },
    { timeout: options.timeoutMs },
  );
}

async function openAndCollectMenu(page, trigger, menuLabel) {
  await trigger.click({ timeout: options.timeoutMs });
  await page.locator(`[role="menu"][aria-label="${menuLabel}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return await page.evaluate((label) => {
    const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(
      (element) =>
        element instanceof HTMLElement &&
        element.getAttribute('aria-label') === label &&
        isVisible(element),
    );
    if (!(menu instanceof HTMLElement)) return [];
    return Array.from(menu.querySelectorAll('[role="menuitemradio"]'))
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .map((element) => ({
        checked: element.getAttribute('aria-checked') === 'true',
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      }));

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, menuLabel);
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

async function openFiltersMenu(page) {
  await toolbarButton(page, /^Filter/).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Filters' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

function toolbarButton(page, name) {
  return page.getByRole('toolbar', { name: 'Database toolbar' }).getByRole('button', { name }).first();
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database filter matrix smoke');

  const suffix = Date.now();
  const short = String(suffix).slice(-6);
  const targetDatabaseId = randomUUID();
  const targetRowId = randomUUID();
  const targetTitlePropId = randomUUID();
  const relationTargetTitle = `Filter target ${short}`;

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: targetDatabaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Filter target DB ${short}`,
    position: suffix - 1,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: targetTitlePropId, name: 'Name', type: 'title', position: 1 },
    ],
  });
  await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: targetRowId,
    databaseId: targetDatabaseId,
    title: relationTargetTitle,
    properties: {},
  });

  const databaseId = randomUUID();
  const rowId = randomUUID();
  const propertyIds = {
    title: randomUUID(),
    text: randomUUID(),
    amount: randomUUID(),
    status: randomUUID(),
    tags: randomUUID(),
    stage: randomUUID(),
    due: randomUUID(),
    owner: randomUUID(),
    done: randomUUID(),
    files: randomUUID(),
    related: randomUUID(),
    formula: randomUUID(),
    rollup: randomUUID(),
    url: randomUUID(),
    email: randomUUID(),
    phone: randomUUID(),
    uniqueId: randomUUID(),
    createdTime: randomUUID(),
    lastEditedTime: randomUUID(),
    createdBy: randomUUID(),
    lastEditedBy: randomUUID(),
  };
  const propertyOrder = Object.values(propertyIds);
  const rowTitle = `Filter matrix row ${short}`;

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Filter matrix ${short}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: propertyIds.title, name: 'Name', type: 'title', position: 1 },
      { id: propertyIds.text, name: 'Text', type: 'rich_text', position: 2 },
      { id: propertyIds.amount, name: 'Amount', type: 'number', position: 3 },
      {
        id: propertyIds.status,
        name: 'Status',
        type: 'select',
        position: 4,
        options: [
          { id: 'todo', name: 'Todo', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
        ],
      },
      {
        id: propertyIds.tags,
        name: 'Tags',
        type: 'multi_select',
        position: 5,
        options: [
          { id: 'alpha', name: 'Alpha', color: 'purple' },
          { id: 'beta', name: 'Beta', color: 'green' },
        ],
      },
      {
        id: propertyIds.stage,
        name: 'Stage',
        type: 'status',
        position: 6,
        options: [
          { id: 'not-started', name: 'Not started', color: 'gray' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      { id: propertyIds.due, name: 'Due', type: 'date', position: 7 },
      { id: propertyIds.owner, name: 'Owner', type: 'person', position: 8 },
      { id: propertyIds.done, name: 'Done', type: 'checkbox', position: 9 },
      { id: propertyIds.files, name: 'Files', type: 'files', position: 10 },
      {
        id: propertyIds.related,
        name: 'Related',
        type: 'relation',
        position: 11,
        config: { relationDatabaseId: targetDatabaseId },
      },
      {
        id: propertyIds.formula,
        name: 'Formula',
        type: 'formula',
        position: 12,
        formula: 'format(prop("Amount"))',
      },
      {
        id: propertyIds.rollup,
        name: 'Related rollup',
        type: 'rollup',
        position: 13,
        rollupRelationPropertyId: propertyIds.related,
        rollupFunction: 'show_original',
      },
      { id: propertyIds.url, name: 'URL', type: 'url', position: 14 },
      { id: propertyIds.email, name: 'Email', type: 'email', position: 15 },
      { id: propertyIds.phone, name: 'Phone', type: 'phone', position: 16 },
      { id: propertyIds.uniqueId, name: 'ID', type: 'unique_id', position: 17, idPrefix: 'FM' },
      { id: propertyIds.createdTime, name: 'Created time', type: 'created_time', position: 18 },
      { id: propertyIds.lastEditedTime, name: 'Last edited time', type: 'last_edited_time', position: 19 },
      { id: propertyIds.createdBy, name: 'Created by', type: 'created_by', position: 20 },
      { id: propertyIds.lastEditedBy, name: 'Last edited by', type: 'last_edited_by', position: 21 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database filter matrix smoke database must be created');
  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database filter matrix smoke must receive a table view');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    // Workspace-per-DO routing resolves the target DO from a page/database id;
    // a bare view id can't route, so pass the owning databaseId (as the app does).
    databaseId,
    patch: {
      name: 'Table',
      position: 1,
      config: {
        propertyOrder,
        visibleProperties: propertyOrder,
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: propertyIds.title, operator: 'contains', value: rowTitle }],
          groups: [],
        },
      },
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: rowTitle,
    properties: {
      [propertyIds.text]: `Filter text ${short}`,
      [propertyIds.amount]: 42,
      [propertyIds.status]: 'todo',
      [propertyIds.tags]: ['alpha'],
      [propertyIds.stage]: 'not-started',
      [propertyIds.due]: '2026-07-05',
      [propertyIds.owner]: [session.userId],
      [propertyIds.done]: true,
      [propertyIds.files]: [{ id: randomUUID(), name: `filter-${short}.pdf`, url: 'https://example.com/filter.pdf' }],
      [propertyIds.related]: [targetRowId],
      [propertyIds.url]: 'https://example.com/filter',
      [propertyIds.email]: 'filter@example.com',
      [propertyIds.phone]: '+1 555 0100',
    },
  });

  return {
    accessToken: session.accessToken,
    databaseId,
    propertyIds,
    propertyOrder,
    refreshToken: session.refreshToken,
    relationTargetTitle,
    rowTitle,
    tableViewId,
    targetDatabaseId,
    targetRowId,
    workspaceId,
  };
}

async function auditStaleRelationFilter(page, apiUrl, seed) {
  await callFunction(apiUrl, seed.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: seed.tableViewId,
    databaseId: seed.databaseId,
    patch: {
      config: {
        propertyOrder: seed.propertyOrder,
        visibleProperties: seed.propertyOrder,
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: seed.propertyIds.related, operator: 'equals', value: '' }],
          groups: [],
        },
      },
    },
  });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.getByRole('toolbar', { name: 'Database toolbar' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await openFiltersMenu(page);

  const row = page.locator('[data-filter-row]').first();
  const conditionText = await row.locator('button[aria-label="Filter condition"]').textContent({
    timeout: options.timeoutMs,
  });
  assert(
    (conditionText ?? '').replace(/\s+/g, ' ').includes('Contains'),
    `stale relation equals filter should display Contains, got ${JSON.stringify(conditionText)}`,
  );

  const valueButton = row.locator('button[aria-label="Filter value for Related"]');
  const valueText = await valueButton.textContent({ timeout: options.timeoutMs });
  assert(
    (valueText ?? '').replace(/\s+/g, ' ').includes('Choose page'),
    `stale relation blank value should display Choose page, got ${JSON.stringify(valueText)}`,
  );

  const valueTexts = await openAndCollectMenu(page, valueButton, 'Filter value for Related');
  assert(
    valueTexts.some((item) => item.text.includes(seed.relationTargetTitle)),
    `stale relation value menu should include relation target: ${JSON.stringify(valueTexts)}`,
  );
  return {
    propertyName: 'Related',
    storedOperator: 'equals',
    storedValue: '',
    displayedOperator: (conditionText ?? '').replace(/\s+/g, ' ').trim(),
    displayedValue: (valueText ?? '').replace(/\s+/g, ' ').trim(),
    valueProbe: valueTexts,
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
  assert(typeof body?.user?.id === 'string' && body.user.id, 'anonymous sign-in must return a user id');
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
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
    'Playwright is required for database filter matrix smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    outputDir: DEFAULT_OUTPUT_DIR,
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
    if (arg === '--output-dir' || arg === '--screenshot-dir') {
      parsed.outputDir = resolve(resolveValue(args, i, arg));
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
  console.log(`Usage: node scripts/database-filter-matrix-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --output-dir <dir>      Directory for captured artifacts
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
