#!/usr/bin/env node
// Workspace creation dialog smoke: the sidebar "New workspace" item opens a
// dialog with three start choices (blank / Notion import / Hanji import).
// Blank keeps the starter pages; import choices skip them and land the
// ImportDialog on the matching tab inside the new workspace.
import {
  assert,
  assertRuntimeReachable,
  deleteSmokeWorkspace,
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

async function suppressExistingWorkspaceOnboarding(token) {
  // A clean self-host runtime creates its first workspace lazily during
  // workspace-bootstrap. Listing before this call can legitimately return an
  // empty array and leave the later UI-created workspace unsuppressed.
  const bootstrap = await api('/api/functions/workspace-bootstrap', {}, token);
  assert(
    bootstrap.status === 200 && bootstrap.json.workspace?.id,
    `workspace bootstrap for onboarding suppression failed: ${bootstrap.status}`,
  );
  const list = await api('/api/functions/workspace-mutation', { action: 'list' }, token);
  assert(list.status === 200, `workspace list for onboarding suppression failed: ${list.status}`);
  assert(
    (list.json.workspaces ?? []).length > 0,
    'workspace bootstrap should create an accessible workspace',
  );
  for (const workspace of list.json.workspaces ?? []) {
    const suppressed = await api(
      '/api/functions/workspace-mutation',
      { action: 'suppressNotionImportOnboarding', workspaceId: workspace.id },
      token,
    );
    assert(
      suppressed.status === 200 && suppressed.json.suppressed === true,
      `workspace onboarding suppression failed for ${workspace.id}: ${suppressed.status}`,
    );
  }
}

async function signInThroughUi(page) {
  await page.goto(resolveUrl(BASE, '/'), { waitUntil: 'domcontentloaded' });
  const passwordField = page.getByLabel('Password', { exact: true }).first();
  await passwordField.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await page.getByRole('textbox', { name: 'Email' }).fill(MASTER_EMAIL);
  await passwordField.fill(MASTER_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: TIMEOUT_MS });
  const workspaceMenu = page.locator('[data-sidebar-workspace-button]');
  const languageOnboarding = page.locator('[data-testid="language-onboarding"]');
  const firstSurface = await Promise.race([
    workspaceMenu.waitFor({ state: 'visible', timeout: TIMEOUT_MS }).then(() => 'workspace'),
    languageOnboarding.waitFor({ state: 'visible', timeout: TIMEOUT_MS }).then(() => 'language'),
  ]);
  if (firstSurface === 'language') {
    await languageOnboarding.getByRole('button', { name: 'Continue' }).click({ timeout: TIMEOUT_MS });
    await workspaceMenu.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  }
}

async function openCreateDialog(page) {
  const dialog = page.getByRole('dialog', { name: /New workspace|새 워크스페이스/ });
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (await dialog.isVisible().catch(() => false)) return dialog;
    await page.keyboard.press('Escape').catch(() => {});
    const workspaceMenu = page.locator('[data-sidebar-workspace-button]');
    await workspaceMenu.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const createItem = page.getByRole('menuitem', { name: /New workspace|새 워크스페이스/ });
    try {
      await workspaceMenu.click({ timeout: Math.min(TIMEOUT_MS, 5_000) });
      await createItem.waitFor({ state: 'visible', timeout: Math.min(TIMEOUT_MS, 5_000) });
      await createItem.click({ timeout: TIMEOUT_MS });
      await dialog.waitFor({ state: 'visible', timeout: Math.min(TIMEOUT_MS, 5_000) });
      return dialog;
    } catch (error) {
      lastError = error;
    }
  }
  const state = await page.evaluate(() => ({
    body: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 800),
    url: window.location.href,
    workspaceMenuOpen: document.querySelector('[role="menu"]') instanceof HTMLElement,
    importOnboardingOpen: document.querySelector('[data-notion-import-onboarding]') instanceof HTMLElement,
  }));
  throw new Error(
    `workspace create dialog did not open after two bounded attempts; state=${JSON.stringify(state)}; `
      + `lastError=${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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
  await suppressExistingWorkspaceOnboarding(token);
  const suffix = Date.now();
  const createdWorkspaces = [];
  const createdWorkspaceNames = new Set();

  const { chromium } = await loadPlaywright({ label: 'workspace-create-dialog smoke' });
  const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
  let runError = null;
  try {
    const { context, page } = await newCheckedPage(browser);
    await signInThroughUi(page);

    // Case 1: blank keeps starter pages.
    const blankName = `Create blank ${suffix}`;
    createdWorkspaceNames.add(blankName);
    let dialog = await openCreateDialog(page);
    await createFromDialog(page, dialog, blankName, /Blank workspace|빈 워크스페이스/);
    await page
      .locator('[data-sidebar-workspace-button]')
      .filter({ hasText: blankName })
      .waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const blank = await workspacePages(token, blankName);
    createdWorkspaces.push(blank.workspace);
    assert(blank.pages.length > 0, 'blank workspace should keep the starter pages');
    console.log(`PASS blank choice creates a workspace with ${blank.pages.length} starter pages.`);

    // Case 2: Notion import choice skips starter pages and opens the import
    // dialog on the Notion tab.
    const notionName = `Create notion ${suffix}`;
    createdWorkspaceNames.add(notionName);
    dialog = await openCreateDialog(page);
    await createFromDialog(page, dialog, notionName, /Import from Notion|노션에서 가져오기/);
    const importDialog = page.getByRole('dialog').filter({ hasText: /Import|가져오기/ }).first();
    await importDialog.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const activeTab = importDialog.locator('aside button[data-active="true"]');
    assert(
      (await activeTab.first().innerText()).includes('Notion'),
      'import dialog should open on the Notion tab',
    );
    await page.keyboard.press('Escape');
    const notion = await workspacePages(token, notionName);
    createdWorkspaces.push(notion.workspace);
    assert(notion.pages.length === 0, `import choice should skip starter pages, got ${notion.pages.length}`);
    console.log('PASS Notion choice skips starter pages and lands the import dialog on Notion.');

    // Case 3: Hanji import choice lands on the Hanji tab.
    const hanjiName = `Create hanji ${suffix}`;
    createdWorkspaceNames.add(hanjiName);
    dialog = await openCreateDialog(page);
    await createFromDialog(page, dialog, hanjiName, /Import from another Hanji|다른 한지에서 가져오기/);
    const importDialog2 = page.getByRole('dialog').filter({ hasText: /Import|가져오기/ }).first();
    await importDialog2.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const activeTab2 = importDialog2.locator('aside button[data-active="true"]');
    assert(
      /Hanji|한지/.test(await activeTab2.first().innerText()),
      'import dialog should open on the Hanji tab',
    );
    const hanji = await workspacePages(token, hanjiName);
    createdWorkspaces.push(hanji.workspace);
    console.log('PASS Hanji choice lands the import dialog on the Hanji tab.');
    await context.close();
  } catch (error) {
    runError = error;
  } finally {
    await browser.close().catch(() => {});
    const cleanupErrors = [];
    const workspaceList = await api(
      '/api/functions/workspace-mutation',
      { action: 'list' },
      token,
    ).catch(() => ({ status: 0, json: {} }));
    for (const workspace of workspaceList.json.workspaces ?? []) {
      if (createdWorkspaceNames.has(workspace?.name)) createdWorkspaces.push(workspace);
    }
    const uniqueWorkspaces = Array.from(
      new Map(createdWorkspaces.map((workspace) => [workspace.id, workspace])).values(),
    );
    for (const workspace of uniqueWorkspaces.reverse()) {
      try {
        await deleteSmokeWorkspace(BASE, token, workspace, { timeoutMs: TIMEOUT_MS });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupError = new Error(`workspace-create smoke cleanup failed: ${cleanupErrors.join('; ')}`);
      if (!runError) runError = cleanupError;
      else console.error(`WARN ${cleanupError.message}`);
    }
  }
  if (runError) throw runError;
  console.log('PASS workspace creation dialog flow works end to end.');
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL workspace create dialog smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
