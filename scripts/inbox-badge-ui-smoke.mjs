#!/usr/bin/env node
// Inbox unread badge smoke: adding an existing server account to a workspace
// generates a membership notification, the sidebar inbox rail shows the unread
// dot when the member opens the workspace, and marking everything read clears
// the dot without a reload.
import {
  assert,
  assertRuntimeReachable,
  deleteSmokeUser,
  deleteSmokeWorkspace,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  waitForStableRoute,
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

async function signin(email, password) {
  const { status, json } = await api('/api/auth/signin', { email, password });
  assert(status === 200, `signin ${email} failed with ${status}`);
  return json.accessToken ?? json.session?.accessToken;
}

async function main() {
  await assertRuntimeReachable(BASE);
  const suffix = Date.now();
  const master = await signin(MASTER_EMAIL, MASTER_PASSWORD);
  let createdUserId = '';
  let createdWorkspace = null;
  let runError = null;

  try {

  // Provisioned member (clear the temp-password gate via the product API so
  // the browser flow lands directly in the workspace).
  const memberEmail = `inbox-badge-${suffix}@example.com`;
  const created = await api(
    '/api/functions/instance-admin',
    {
      action: 'createUser',
      email: memberEmail,
      displayName: `Inbox Badge ${suffix}`,
      query: memberEmail,
    },
    master,
  );
  const tempPassword = created.json.temporaryPassword;
  const memberId = (created.json.users ?? []).find((user) => user.email === memberEmail)?.id;
  assert(tempPassword && memberId, 'provisioned member should exist with a temp password');
  createdUserId = memberId;
  const memberToken = await signin(memberEmail, tempPassword);
  await api('/api/functions/account-state', { action: 'clearMustChangePassword' }, memberToken);

  const ws = await api(
    '/api/functions/workspace-mutation',
    { action: 'createWorkspace', name: `Badge ws ${suffix}`, domain: `badge-ws-${suffix}` },
    master,
  );
  const workspaceId = ws.json.workspace?.id;
  const workspaceSlug = ws.json.workspace?.domain;
  assert(workspaceId && workspaceSlug, 'workspace with slug should be created');
  createdWorkspace = ws.json.workspace;
  // Direct add by userId emits the membership notification for the member.
  const invited = await api(
    '/api/functions/workspace-mutation',
    { action: 'inviteMember', workspaceId, userId: memberId, email: memberEmail, role: 'member' },
    master,
  );
  assert(invited.status === 200, `inviteMember failed: ${JSON.stringify(invited.json).slice(0, 160)}`);

  const list = await api(
    '/api/functions/notification-mutation',
    { action: 'list', workspaceId, includeRead: false },
    memberToken,
  );
  assert((list.json.unreadCount ?? 0) >= 1, `member should have an unread notification, got ${JSON.stringify(list.json).slice(0, 160)}`);
  console.log('PASS membership notification arrives for the added account.');

  const { chromium } = await loadPlaywright({ label: 'inbox badge smoke' });
  const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
  try {
    const { context, page, errors } = await newCheckedPage(browser);
    await page.goto(resolveUrl(BASE, `/workspace/${encodeURIComponent(workspaceSlug)}`), {
      waitUntil: 'domcontentloaded',
    });
    const passwordField = page.getByLabel('Password', { exact: true }).first();
    await passwordField.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await page.getByRole('textbox', { name: 'Email' }).fill(memberEmail);
    await passwordField.fill(tempPassword);
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: TIMEOUT_MS });

    const inboxButton = page.locator('[data-sidebar-rail-slot="inbox"]');
    await inboxButton.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await waitForStableRoute(page, { timeoutMs: TIMEOUT_MS });
    await page
      .locator('[data-sidebar-rail-slot="inbox"][data-unread="true"]')
      .waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    console.log('PASS sidebar inbox shows the unread dot for the fresh notification.');

    try {
      await inboxButton.click({ timeout: TIMEOUT_MS });
      await page
        .getByRole('button', { name: /Mark all updates as read|모두 읽음/ })
        .click({ timeout: TIMEOUT_MS });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${await inboxPanelDiagnostics(page, errors)}`,
      );
    }
    await inboxButton.click({ timeout: TIMEOUT_MS });
    await page
      .locator('[data-sidebar-rail-slot="inbox"]:not([data-unread="true"])')
      .waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    console.log('PASS marking all read clears the unread dot without a reload.');
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('PASS inbox unread badge flow works end to end.');
  } catch (error) {
    runError = error;
  } finally {
    const cleanupErrors = [];
    if (createdWorkspace) {
      try {
        await deleteSmokeWorkspace(BASE, master, createdWorkspace, { timeoutMs: TIMEOUT_MS });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (createdUserId) {
      try {
        await deleteSmokeUser(BASE, master, createdUserId, { timeoutMs: TIMEOUT_MS });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupError = new Error(`inbox-badge smoke cleanup failed: ${cleanupErrors.join('; ')}`);
      if (!runError) runError = cleanupError;
      else console.error(`WARN ${cleanupError.message}`);
    }
  }
  if (runError) throw runError;
}

async function inboxPanelDiagnostics(page, browserErrors) {
  const state = await page.evaluate(() => {
    const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .map((button) => ({
        ariaLabel: button.getAttribute('aria-label'),
        inboxMode: button.getAttribute('data-inbox-mode'),
        pressed: button.getAttribute('aria-pressed'),
        text: button.textContent?.replace(/\s+/g, ' ').trim(),
      }))
      .filter((button) => button.ariaLabel || button.inboxMode || button.text);
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter(visible)
      .map((alert) => alert.textContent?.replace(/\s+/g, ' ').trim());
    return { alerts, buttons };
  }).catch((error) => ({ evaluationError: error instanceof Error ? error.message : String(error) }));
  return `Inbox diagnostics: ${JSON.stringify({ browserErrors, state })}`;
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL inbox badge smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
