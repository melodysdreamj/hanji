#!/usr/bin/env node
// Workspace creation dialog smoke: the sidebar "New workspace" item opens a
// dialog with three start choices (blank / Notion import / Hanji import).
// Blank keeps the starter pages; import choices skip them and land the
// ImportDialog on the matching tab inside the new workspace.
import {
  assert,
  assertRuntimeReachable,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  masterCredentials,
} from './lib/harness.mjs';

const BASE = normalizeBaseUrl(process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787');
const { email: MASTER_EMAIL, password: MASTER_PASSWORD } = masterCredentials();
const TIMEOUT_MS = Number(process.env.HANJI_SMOKE_TIMEOUT_MS ?? 30_000);
setDefaultTimeoutMs(TIMEOUT_MS);

async function api(path, body, token) {
  const response = await fetch(resolveUrl(BASE, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function signinToken() {
  const { status, json } = await api('/api/auth/signin', {
    email: MASTER_EMAIL,
    password: MASTER_PASSWORD,
  });
  assert(status === 200, `master signin failed: ${status}`);
  return json.accessToken ?? json.session?.accessToken;
}

async function signInThroughUi(page) {
  await page.goto(resolveUrl(BASE, '/'), { waitUntil: 'domcontentloaded' });
  const passwordField = page.getByLabel('Password', { exact: true }).first();
  await passwordField.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await page.getByRole('textbox', { name: 'Email' }).fill(MASTER_EMAIL);
  await passwordField.fill(MASTER_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: TIMEOUT_MS });
  await page.locator('button[aria-label="Open workspace menu"]').waitFor({
    state: 'visible',
    timeout: TIMEOUT_MS,
  });
}

async function openCreateDialog(page) {
  await page.locator('button[aria-label="Open workspace menu"]').click({ timeout: TIMEOUT_MS });
  await page
    .getByRole('menuitem', { name: /New workspace|새 워크스페이스/ })
    .click({ timeout: TIMEOUT_MS });
  const dialog = page.getByRole('dialog', { name: /New workspace|새 워크스페이스/ });
  await dialog.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  return dialog;
}

async function createFromDialog(page, dialog, name, optionPattern) {
  await dialog.locator('#workspace-create-name').fill(name);
  if (optionPattern) {
    await dialog.getByRole('radio', { name: optionPattern }).click({ timeout: TIMEOUT_MS });
  }
  await dialog
    .getByRole('button', { name: /Create workspace|워크스페이스 만들기/ })
    .click({ timeout: TIMEOUT_MS });
  await dialog.waitFor({ state: 'hidden', timeout: TIMEOUT_MS });
}

async function workspacePages(token, workspaceName) {
  const list = await api('/api/functions/workspace-mutation', { action: 'list' }, token);
  const workspace = (list.json.workspaces ?? []).find((item) => item.name === workspaceName);
  assert(workspace, `workspace "${workspaceName}" should exist`);
  const bootstrap = await api(
    '/api/functions/workspace-bootstrap',
    { workspaceId: workspace.id },
    token,
  );
  return { workspace, pages: bootstrap.json.pages ?? [] };
}

async function main() {
  await assertRuntimeReachable(BASE);
  const token = await signinToken();
  const suffix = Date.now();

  const { chromium } = await loadPlaywright({ label: 'workspace-create-dialog smoke' });
  const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
  try {
    const { context, page } = await newCheckedPage(browser);
    await signInThroughUi(page);

    // Case 1: blank keeps starter pages.
    const blankName = `Create blank ${suffix}`;
    let dialog = await openCreateDialog(page);
    await createFromDialog(page, dialog, blankName, /Blank workspace|빈 워크스페이스/);
    await page
      .locator('button[aria-label="Open workspace menu"]')
      .filter({ hasText: blankName })
      .waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const blank = await workspacePages(token, blankName);
    assert(blank.pages.length > 0, 'blank workspace should keep the starter pages');
    console.log(`PASS blank choice creates a workspace with ${blank.pages.length} starter pages.`);

    // Case 2: Notion import choice skips starter pages and opens the import
    // dialog on the Notion tab.
    const notionName = `Create notion ${suffix}`;
    dialog = await openCreateDialog(page);
    await createFromDialog(page, dialog, notionName, /Import from Notion|노션에서 가져오기/);
    const importDialog = page.getByRole('dialog').filter({ hasText: /Import|가져오기/ }).first();
    await importDialog.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const activeTab = importDialog.locator('[data-active="true"]');
    assert(
      (await activeTab.first().innerText()).includes('Notion'),
      'import dialog should open on the Notion tab',
    );
    await page.keyboard.press('Escape');
    const notion = await workspacePages(token, notionName);
    assert(notion.pages.length === 0, `import choice should skip starter pages, got ${notion.pages.length}`);
    console.log('PASS Notion choice skips starter pages and lands the import dialog on Notion.');

    // Case 3: Hanji import choice lands on the Hanji tab.
    const hanjiName = `Create hanji ${suffix}`;
    dialog = await openCreateDialog(page);
    await createFromDialog(page, dialog, hanjiName, /Import from another Hanji|다른 한지에서 가져오기/);
    const importDialog2 = page.getByRole('dialog').filter({ hasText: /Import|가져오기/ }).first();
    await importDialog2.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const activeTab2 = importDialog2.locator('[data-active="true"]');
    assert(
      /Hanji|한지/.test(await activeTab2.first().innerText()),
      'import dialog should open on the Hanji tab',
    );
    console.log('PASS Hanji choice lands the import dialog on the Hanji tab.');
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
  console.log('PASS workspace creation dialog flow works end to end.');
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL workspace create dialog smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
