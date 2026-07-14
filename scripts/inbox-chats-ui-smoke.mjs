#!/usr/bin/env node
// Inbox chat rooms smoke (2026-07-10 approved chat contract revision):
// a mention pulls a page into the invitee's Chats mode as a room; opening the
// room opens the page's comment thread; leaving hides the room; a NEWER
// mention calls the user back in. The notification feed itself stays intact.
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
import { randomUUID } from 'node:crypto';

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

async function mentionComment(master, pageId, memberId, text) {
  const id = randomUUID();
  const res = await api('/api/functions/comment-mutation', {
    action: 'create',
    id,
    pageId,
    blockId: null,
    body: {
      rich: [
        { text: `${text} ` },
        { text: '@member', mention: 'person', userId: memberId },
      ],
    },
  }, master);
  assert(res.status === 200, `mention comment failed: ${JSON.stringify(res.json).slice(0, 160)}`);
}

async function main() {
  await assertRuntimeReachable(BASE);
  const suffix = Date.now();
  const master = await signin(MASTER_EMAIL, MASTER_PASSWORD);
  let createdUserId = '';
  let createdWorkspace = null;
  let runError = null;

  try {

  const memberEmail = `chat-member-${suffix}@example.com`;
  const created = await api(
    '/api/functions/instance-admin',
    {
      action: 'createUser',
      email: memberEmail,
      displayName: `Chat Member ${suffix}`,
      query: memberEmail,
    },
    master,
  );
  const tempPassword = created.json.temporaryPassword;
  const memberId = (created.json.users ?? []).find((user) => user.email === memberEmail)?.id;
  assert(tempPassword && memberId, 'member should be provisioned');
  createdUserId = memberId;
  const memberToken = await signin(memberEmail, tempPassword);
  await api('/api/functions/account-state', { action: 'clearMustChangePassword' }, memberToken);
  await api(
    '/api/functions/account-state',
    { action: 'setLanguagePreference', languagePreference: 'system' },
    memberToken,
  );

  const ws = await api(
    '/api/functions/workspace-mutation',
    { action: 'createWorkspace', name: `Chat ws ${suffix}`, domain: `chat-ws-${suffix}`, skipDefaultPages: true },
    master,
  );
  const workspaceId = ws.json.workspace?.id;
  const slug = ws.json.workspace?.domain;
  assert(workspaceId && slug, 'workspace should exist');
  createdWorkspace = ws.json.workspace;
  await api(
    '/api/functions/workspace-mutation',
    { action: 'inviteMember', workspaceId, userId: memberId, email: memberEmail, role: 'member' },
    master,
  );

  const pageId = randomUUID();
  const pageTitle = `Chat room page ${suffix}`;
  const page = await api('/api/functions/page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: pageTitle,
    position: 1,
  }, master);
  assert(page.status === 200, 'seed page should be created');
  await mentionComment(master, pageId, memberId, 'First call');

  const { chromium } = await loadPlaywright({ label: 'inbox chats smoke' });
  const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
  try {
    const { context, page: tab } = await newCheckedPage(browser);
    await tab.goto(resolveUrl(BASE, `/workspace/${encodeURIComponent(slug)}`), {
      waitUntil: 'domcontentloaded',
    });
    const passwordField = tab.getByLabel('Password', { exact: true }).first();
    await passwordField.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await tab.getByRole('textbox', { name: 'Email' }).fill(memberEmail);
    await passwordField.fill(tempPassword);
    await tab.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: TIMEOUT_MS });
    await tab.locator('button[aria-label="Open workspace menu"]').waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    await waitForStableRoute(tab, { timeoutMs: TIMEOUT_MS });

    // Deterministically land in Chats mode: the rail button TOGGLES the
    // inbox, so only click it when the mode switch is not already visible.
    async function openChats() {
      const modeButton = tab.locator('[data-inbox-mode="chats"]');
      if (!(await modeButton.isVisible().catch(() => false))) {
        await tab.locator('[data-sidebar-rail-slot="inbox"]').click({ timeout: TIMEOUT_MS });
        await modeButton.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
      }
      await modeButton.click({ timeout: TIMEOUT_MS });
    }

    await openChats();
    const rooms = tab.locator('[data-testid="inbox-chat-rooms"]');
    await rooms.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const room = rooms.locator('li').filter({ hasText: pageTitle }).first();
    await room.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    console.log('PASS a mention surfaces the page as a chat room for the added member.');

    // Opening the room opens the page's comment thread.
    await room.getByRole('button').first().click({ timeout: TIMEOUT_MS });
    await tab.getByRole('dialog', { name: /Comments|댓글/ }).waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    console.log('PASS opening a room opens the page comment thread.');
    await tab
      .getByRole('dialog', { name: /Comments|댓글/ })
      .getByLabel(/Close comments|댓글 닫기/)
      .click({ timeout: TIMEOUT_MS });
    await tab
      .getByRole('dialog', { name: /Comments|댓글/ })
      .waitFor({ state: 'hidden', timeout: TIMEOUT_MS })
      .catch(() => {});

    // Leave hides the room.
    await openChats();
    const roomAgain = tab.locator('[data-testid="inbox-chat-rooms"] li').filter({ hasText: pageTitle }).first();
    await roomAgain.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await roomAgain.hover();
    await roomAgain.getByRole('button', { name: /Leave|나가기/ }).click({ timeout: TIMEOUT_MS });
    await roomAgain.waitFor({ state: 'hidden', timeout: TIMEOUT_MS });
    console.log('PASS leaving hides the room.');

    // A newer mention calls the member back in.
    await mentionComment(master, pageId, memberId, 'Calling you back');
    await tab.reload({ waitUntil: 'domcontentloaded' });
    await tab.locator('button[aria-label="Open workspace menu"]').waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    await waitForStableRoute(tab, { timeoutMs: TIMEOUT_MS });
    await openChats();
    await tab
      .locator('[data-testid="inbox-chat-rooms"] li')
      .filter({ hasText: pageTitle })
      .first()
      .waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    console.log('PASS a newer mention re-summons the left room.');
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
  console.log('PASS inbox chat rooms flow works end to end.');
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
      const cleanupError = new Error(`inbox-chats smoke cleanup failed: ${cleanupErrors.join('; ')}`);
      if (!runError) runError = cleanupError;
      else console.error(`WARN ${cleanupError.message}`);
    }
  }
  if (runError) throw runError;
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL inbox chats smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
