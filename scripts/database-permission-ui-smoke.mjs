#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database permission UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Database permission UI smoke target: ${appUrl}${apiUrl === appUrl ? '' : ` (API: ${apiUrl})`}`);

  await assertRuntimeReachable(apiUrl);
  const seed = await seedDatabasePermissions(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertRole(browser, appUrl, apiUrl, seed, 'view');
    await assertRole(browser, appUrl, apiUrl, seed, 'comment');
    await assertRole(browser, appUrl, apiUrl, seed, 'edit');
    await assertRole(browser, appUrl, apiUrl, seed, 'full_access');
    console.log('PASS database user permissions keep inherited view/comment/edit and direct full-access UI/API boundaries aligned.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertRole(browser, appUrl, apiUrl, seed, role) {
  console.log(`Checking ${role} database permission UI...`);
  const session = seed.sessions[role];
  await assertRoleApi(apiUrl, seed, role, session);

  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, session, seed.workspaceId, seed.rowTitle);

  try {
    await step(page, `${role}: open database`, () => openDatabase(page, appUrl, seed));
    await step(page, `${role}: assert database chrome`, () => assertDatabaseChrome(page, seed, role));
    await step(page, `${role}: assert share menu`, () => assertShareMenu(page, seed, role));
    await step(page, `${role}: open row peek`, () => openRowPeek(page, seed));
    await step(page, `${role}: assert row peek permissions`, () => assertRowPeekPermissions(page, seed, role));
    if (role === 'comment') {
      await step(page, `${role}: create page comment`, () => createPageComment(page, seed, role));
    }
    assertNoBrowserErrors(errors, `${role} database permission UI`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function step(page, label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let text = '';
    try {
      text = await page.locator('body').innerText({ timeout: 1000 });
    } catch {
      text = '';
    }
    const snippet = text ? `\nVisible text: ${text.slice(0, 800)}` : '';
    throw new Error(`${label}: ${message}\nURL: ${page.url()}${snippet}`);
  }
}

async function assertRoleApi(apiUrl, seed, role, session) {
  const bootstrap = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    pageId: seed.databaseId,
  });
  const expectedRole = role === 'full_access' ? 'full_access' : role;
  assert(
    bootstrap?.pageRoles?.[seed.databaseId] === expectedRole,
    `${role} database bootstrap should expose the database role: ${JSON.stringify(bootstrap?.pageRoles ?? {})}`,
  );
  const rowBootstrap = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    pageId: seed.rowId,
  });
  assert(
    rowBootstrap?.pageRoles?.[seed.rowId] === expectedRole,
    `${role} row-page bootstrap should expose the inherited/direct row role: ${JSON.stringify(rowBootstrap?.pageRoles ?? {})}`,
  );

  const rows = await callFunction(apiUrl, session.accessToken, 'page-query', {
    action: 'databaseRows',
    databaseId: seed.databaseId,
  });
  assert(
    Array.isArray(rows?.rows) && rows.rows.some((row) => row.id === seed.rowId),
    `${role} should read shared database rows`,
  );

  if (role === 'view') {
    await expectFunctionStatus(apiUrl, session.accessToken, 'comment-mutation', {
      action: 'create',
      id: randomUUID(),
      pageId: seed.databaseId,
      body: { rich: [{ text: 'View role should not comment' }] },
    }, 403);
    await expectFunctionStatus(apiUrl, session.accessToken, 'database-row-mutation', {
      action: 'create',
      id: randomUUID(),
      databaseId: seed.databaseId,
      title: 'View role should not create rows',
    }, 403);
    await expectFunctionStatus(apiUrl, session.accessToken, 'share-mutation', {
      action: 'setWebSharing',
      pageId: seed.databaseId,
      enabled: true,
    }, 403);
  }

  if (role === 'comment') {
    const comment = await callFunction(apiUrl, session.accessToken, 'comment-mutation', {
      action: 'create',
      id: randomUUID(),
      pageId: seed.rowId,
      body: { rich: [{ text: seed.commentApiText }] },
    });
    assert(comment?.comment?.id, 'comment role should create row page comments through inherited access');
    await expectFunctionStatus(apiUrl, session.accessToken, 'database-row-mutation', {
      action: 'create',
      id: randomUUID(),
      databaseId: seed.databaseId,
      title: 'Comment role should not create rows',
    }, 403);
    await expectFunctionStatus(apiUrl, session.accessToken, 'share-mutation', {
      action: 'setWebSharing',
      pageId: seed.databaseId,
      enabled: true,
    }, 403);
  }

  if (role === 'edit') {
    const rowId = randomUUID();
    const created = await callFunction(apiUrl, session.accessToken, 'database-row-mutation', {
      action: 'create',
      id: rowId,
      databaseId: seed.databaseId,
      title: `Editor-created row ${rowId}`,
      properties: {
        [seed.notesPropertyId]: 'editor value',
      },
    });
    assert(created?.row?.id === rowId, 'edit role should create database rows through inherited access');
    const updated = await callFunction(apiUrl, session.accessToken, 'database-row-mutation', {
      action: 'update',
      id: rowId,
      patch: {
        title: `Editor-updated row ${rowId}`,
      },
    });
    assert(updated?.row?.title === `Editor-updated row ${rowId}`, 'edit role should update its database row');
    await expectFunctionStatus(apiUrl, session.accessToken, 'share-mutation', {
      action: 'setWebSharing',
      pageId: seed.databaseId,
      enabled: true,
    }, 403);
  }

  if (role === 'full_access') {
    const access = await callFunction(apiUrl, session.accessToken, 'share-mutation', {
      action: 'get',
      pageId: seed.databaseId,
    });
    assert(access?.canManage === true, 'direct full access should manage database sharing');
  }
}

async function openDatabase(page, appUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/database/${encodeURIComponent(seed.databaseId)}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ databaseTitle, rowTitle }) => {
      const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
      const rowVisible =
        document.body.innerText.includes(rowTitle) ||
        Array.from(document.querySelectorAll('input')).some((input) => input.value === rowTitle);
      return title?.textContent?.trim() === databaseTitle && rowVisible;
    },
    { databaseTitle: seed.databaseTitle, rowTitle: seed.rowTitle },
    { timeout: options.timeoutMs },
  );
}

async function assertDatabaseChrome(page, seed, role) {
  const metrics = await databasePermissionMetrics(page, seed.rowTitle);
  const readonlyRole = role === 'view' || role === 'comment';
  assert(metrics.rowTitleVisible, `${role} should see the seeded row: ${JSON.stringify(metrics)}`);
  if (readonlyRole) {
    assert(metrics.newRowControls.length === 0, `${role} should not expose new-row controls: ${JSON.stringify(metrics)}`);
    assert(metrics.addPropertyControls.length === 0, `${role} should not expose add-property controls: ${JSON.stringify(metrics)}`);
    assert(metrics.editableTableCellCount === 0, `${role} table cells should be read-only values: ${JSON.stringify(metrics)}`);
    assert(metrics.rowGutterControlCount === 0, `${role} should not expose table row edit gutters: ${JSON.stringify(metrics)}`);
  } else {
    assert(metrics.newRowControls.length > 0, `${role} should expose new-row controls: ${JSON.stringify(metrics)}`);
    assert(metrics.editableTableCellCount > 0, `${role} table cells should expose editors: ${JSON.stringify(metrics)}`);
  }
  assert(
    metrics.topbarShareVisible,
    `${role} should still see the Share access surface for the current page: ${JSON.stringify(metrics)}`,
  );
  if (role === 'comment' || role === 'edit' || role === 'full_access') {
    assert(metrics.topbarCommentVisible, `${role} should expose page comments: ${JSON.stringify(metrics)}`);
  }
}

async function assertShareMenu(page, seed, role) {
  await page.locator('[data-topbar-share-action]').click({
    timeout: options.timeoutMs,
  });
  const dialog = page.locator('[data-share-menu="true"]');
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.locator('input[aria-label="Invite people"], input[aria-label="사용자 초대"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  if (role === 'full_access') {
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[data-share-menu="true"]');
      const invite = dialog?.querySelector('input[aria-label="Invite people"], input[aria-label="사용자 초대"]');
      return invite instanceof HTMLInputElement && !invite.disabled;
    }, undefined, { timeout: options.timeoutMs });
  }
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[data-share-menu="true"]');
    if (!(dialog instanceof HTMLElement)) return false;
    return !dialog.textContent?.includes('Loading');
  }, undefined, { timeout: options.timeoutMs }).catch(() => {});

  const state = await page.evaluate(() => {
    const dialog = document.querySelector('[data-share-menu="true"]');
    const invite = dialog?.querySelector('input[aria-label="Invite people"], input[aria-label="사용자 초대"]');
    const permission = dialog?.querySelector('button[aria-label="New invite permission"], button[aria-label="새 초대 권한"]');
    const notice = Array.from(dialog?.querySelectorAll('div, span') ?? [])
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
      .find((text) => text.includes('Only people with full access can change sharing'));
    return {
      inviteDisabled: invite instanceof HTMLInputElement ? invite.disabled : null,
      permissionDisabled: permission instanceof HTMLButtonElement ? permission.disabled : null,
      notice: notice ?? '',
    };
  });
  await dialog.locator('[data-share-tab="publish"]').click({ timeout: options.timeoutMs });
  const publishState = await page.evaluate(() => {
    const dialog = document.querySelector('[data-share-menu="true"]');
    const publishSwitch = dialog?.querySelector('[role="switch"]');
    return {
      publishSwitchDisabled: publishSwitch instanceof HTMLButtonElement ? publishSwitch.disabled : null,
    };
  });

  if (role === 'full_access') {
    assert(state.inviteDisabled === false, `full access should enable invite input: ${JSON.stringify(state)}`);
    assert(state.permissionDisabled === false, `full access should enable invite permission menu: ${JSON.stringify(state)}`);
    assert(publishState.publishSwitchDisabled === false, `full access should enable publish switch: ${JSON.stringify(publishState)}`);
  } else {
    assert(state.inviteDisabled === true, `${role} should lock invite input: ${JSON.stringify(state)}`);
    assert(state.permissionDisabled === true, `${role} should lock invite permission menu: ${JSON.stringify(state)}`);
    assert(publishState.publishSwitchDisabled === true, `${role} should lock publish switch: ${JSON.stringify(publishState)}`);
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function openRowPeek(page, seed) {
  const point = await page.waitForFunction(
    (rowTitle) => {
      const cells = Array.from(document.querySelectorAll('[data-table-cell][data-title="true"]'));
      const cell = cells.find((item) => {
        const input = item.querySelector('input');
        return input?.value === rowTitle || item.textContent?.includes(rowTitle);
      });
      if (!(cell instanceof HTMLElement)) return null;
      const rect = cell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 };
    },
    seed.rowTitle,
    { timeout: options.timeoutMs },
  );
  const hoverPoint = await point.jsonValue();
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await page.getByRole('button', { name: `${seed.rowTitle} Open in side peek` }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('dialog', { name: `${seed.rowTitle} preview` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertRowPeekPermissions(page, seed, role) {
  const metrics = await page.evaluate((rowTitle) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) => node.getAttribute('aria-label') === `${rowTitle} preview`,
    );
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rowPropertyMenuButtons = Array.from(
      dialog?.querySelectorAll('[data-row-property-id] button[aria-haspopup="menu"]') ?? [],
    ).filter(visible);
    const readonlyPropertyLabels = Array.from(
      dialog?.querySelectorAll('[data-row-property-id] [data-readonly="true"]') ?? [],
    ).filter(visible);
    const editableValues = Array.from(
      dialog?.querySelectorAll('[data-row-property-id] input, [data-row-property-id] textarea, [data-row-property-id] [contenteditable="true"]') ?? [],
    ).filter(visible);
    return {
      editableValueCount: editableValues.length,
      readonlyPropertyLabelCount: readonlyPropertyLabels.length,
      rowPropertyMenuButtonCount: rowPropertyMenuButtons.length,
      titleVisible: !!dialog?.textContent?.includes(rowTitle),
    };
  }, seed.rowTitle);

  assert(metrics.titleVisible, `${role} row peek should render the row title: ${JSON.stringify(metrics)}`);
  if (role === 'view' || role === 'comment') {
    assert(metrics.rowPropertyMenuButtonCount === 0, `${role} row peek should hide property menus: ${JSON.stringify(metrics)}`);
    assert(metrics.editableValueCount === 0, `${role} row peek should not expose editable property values: ${JSON.stringify(metrics)}`);
    assert(metrics.readonlyPropertyLabelCount >= 3, `${role} row peek should render read-only property labels: ${JSON.stringify(metrics)}`);
  } else {
    assert(metrics.rowPropertyMenuButtonCount >= 3, `${role} row peek should expose editable property menus: ${JSON.stringify(metrics)}`);
  }
}

async function createPageComment(page, seed, role) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('[data-topbar-comment-action]').click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Comments' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const text = `Comment-role DB page UI comment ${randomUUID()}`;
  await dialog.getByRole('textbox', { name: 'Add a page comment' }).fill(text, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Comment', exact: true }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByText(text, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  assert(role === 'comment', 'only the comment role should use createPageComment in this smoke');
}

async function databasePermissionMetrics(page, rowTitle) {
  return await page.evaluate((expectedRowTitle) => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const text = document.body.innerText;
    const newRowControls = Array.from(document.querySelectorAll([
      '[data-table-new-row]',
      'button[aria-label="New database page"]',
      'button[aria-label="새 데이터베이스 페이지"]',
      'button[aria-label="Choose database template"]',
    ].join(','))).filter(visible).map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '');
    const addPropertyControls = Array.from(document.querySelectorAll('button[aria-label="Add a property"]'))
      .filter(visible)
      .map((node) => node.textContent?.trim() ?? node.getAttribute('aria-label') ?? '');
    const editableTableCells = Array.from(
      document.querySelectorAll('[data-table-cell] input, [data-table-cell] textarea, [data-table-cell] [contenteditable="true"]'),
    ).filter(visible);
    const rowGutterControls = Array.from(
      document.querySelectorAll('[data-row-gutter-cell] button, [data-row-gutter-cell] input, [data-table-row-menu], [data-table-row-select]'),
    ).filter(visible);
    return {
      addPropertyControls,
      editableTableCellCount: editableTableCells.length,
      newRowControls,
      rowGutterControlCount: rowGutterControls.length,
      rowTitleVisible:
        text.includes(expectedRowTitle) ||
        Array.from(document.querySelectorAll('input')).some((input) => input.value === expectedRowTitle),
      topbarCommentVisible: Array.from(document.querySelectorAll('[data-topbar-comment-action]')).some(visible),
      topbarShareVisible: Array.from(document.querySelectorAll('[data-topbar-share-action]')).some(visible),
    };
  }, rowTitle);
}

async function seedDatabasePermissions(apiUrl) {
  const owner = await signIn(apiUrl);
  const sessions = {
    view: await signIn(apiUrl),
    comment: await signIn(apiUrl),
    edit: await signIn(apiUrl),
    full_access: await signIn(apiUrl),
  };
  const bootstrap = await callFunction(apiUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database permission UI smoke');

  const suffix = Date.now();
  const parentPageId = randomUUID();
  const databaseId = randomUUID();
  const rowId = randomUUID();
  const titlePropertyId = randomUUID();
  const statusPropertyId = randomUUID();
  const amountPropertyId = randomUUID();
  const notesPropertyId = randomUUID();
  const viewId = randomUUID();
  const rowBlockId = randomUUID();
  const parentTitle = `Permission parent ${suffix}`;
  const databaseTitle = `Permission database ${suffix}`;
  const rowTitle = `Permission task ${suffix}`;
  const rowBody = `Permission row body ${suffix}`;

  const parent = await callFunction(apiUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: parentPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: parentTitle,
    position: Date.now(),
  });
  assert(parent?.page?.id === parentPageId, 'permission smoke parent page must be created');

  const database = await callFunction(apiUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: databaseId,
    workspaceId,
    parentId: parentPageId,
    parentType: 'page',
    kind: 'database',
    title: databaseTitle,
    position: Date.now() + 1,
  });
  assert(database?.page?.id === databaseId, 'permission smoke database page must be created');

  for (const property of [
    {
      id: titlePropertyId,
      name: 'Name',
      type: 'title',
      position: 1,
    },
    {
      id: statusPropertyId,
      name: 'Status',
      type: 'select',
      config: {
        options: [
          { id: 'todo', name: 'To do', color: 'gray' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      position: 2,
    },
    {
      id: amountPropertyId,
      name: 'Amount',
      type: 'number',
      config: { format: 'number' },
      position: 3,
    },
    {
      id: notesPropertyId,
      name: 'Notes',
      type: 'rich_text',
      position: 4,
    },
  ]) {
    await callFunction(apiUrl, owner.accessToken, 'database-mutation', {
      action: 'insert',
      table: 'db_properties',
      record: {
        ...property,
        databaseId,
      },
    });
  }

  await callFunction(apiUrl, owner.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_views',
    record: {
      id: viewId,
      databaseId,
      name: 'Main table',
      type: 'table',
      config: {
        visibleProperties: [titlePropertyId, statusPropertyId, amountPropertyId, notesPropertyId],
      },
      position: 1,
    },
  });

  const row = await callFunction(apiUrl, owner.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: rowTitle,
    properties: {
      [statusPropertyId]: 'To do',
      [amountPropertyId]: 42,
      [notesPropertyId]: 'Seeded note',
    },
  });
  assert(row?.row?.id === rowId, 'permission smoke database row must be created');

  const block = await callFunction(apiUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: rowBlockId,
    pageId: rowId,
    parentId: null,
    type: 'paragraph',
    plainText: rowBody,
    content: { rich: [{ text: rowBody }] },
    position: 1,
  });
  assert(block?.block?.id === rowBlockId, 'permission smoke row body block must be created');

  await sharePage(apiUrl, owner.accessToken, parentPageId, sessions.view.userId, 'view');
  await sharePage(apiUrl, owner.accessToken, parentPageId, sessions.comment.userId, 'comment');
  await sharePage(apiUrl, owner.accessToken, parentPageId, sessions.edit.userId, 'edit');
  await sharePage(apiUrl, owner.accessToken, databaseId, sessions.full_access.userId, 'full_access');

  return {
    amountPropertyId,
    commentApiText: `Comment-role API row comment ${suffix}`,
    databaseId,
    databaseTitle,
    notesPropertyId,
    owner,
    parentPageId,
    parentTitle,
    rowBody,
    rowBlockId,
    rowId,
    rowTitle,
    sessions,
    statusPropertyId,
    titlePropertyId,
    viewId,
    workspaceId,
  };
}

async function sharePage(apiUrl, token, pageId, principalId, role) {
  const result = await callFunction(apiUrl, token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId,
    label: `Permission smoke ${role}`,
    role,
  });
  assert(result?.permission?.id, `permission smoke ${role} share must be created`);
  return result.permission;
}

async function cleanupSeed(apiUrl, seed) {
  if (!seed?.owner?.accessToken) return;
  if (seed.databaseId) {
    await permanentlyDeletePage(apiUrl, seed.owner.accessToken, seed.databaseId, { call: callFunction }).catch(() => {});
  }
  if (seed.parentPageId) {
    await permanentlyDeletePage(apiUrl, seed.owner.accessToken, seed.parentPageId, { call: callFunction }).catch(() => {});
  }
}

async function seedSession(context, session, workspaceId, rowTitle) {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId, rowTitle }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', 'light');
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: session.refreshToken,
    rowTitle,
    workspaceId,
  });
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

async function expectFunctionStatus(baseUrl, token, name, body, expectedStatus) {
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
  await readJson(response).catch(() => null);
  assert(
    response.status === expectedStatus,
    `${name} expected HTTP ${expectedStatus}, got HTTP ${response.status}`,
  );
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
    'Playwright is required for database permission UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/database-permission-ui-smoke.mjs [options]

Checks inherited view/comment/edit and direct full-access database permissions
through the SPA and product API.

Options:
  --url <url>             App URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL for split Vite/API runs. Defaults to HANJI_EDGEBASE_API_URL or ${DEFAULT_BASE_URL}.
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
