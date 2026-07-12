#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_API_URL = process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL;
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL identity lookup UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Identity lookup UI smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Identity lookup UI smoke API: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  const seed = await seedIdentityWorkspace(apiUrl);
  let browser;

  try {
    const { chromium } = await loadPlaywright();
    const executablePath = resolveChromeExecutable();
    browser = await chromium.launch({
      headless: !options.headed,
      ...(executablePath ? { executablePath } : {}),
    });
    await assertIdentityLookupUi(browser, appUrl, apiUrl, seed);
    console.log('PASS organization people search powers Share, comment/reply @ mention, editor @ mention, and database Person property multi-select add/remove UI without screenshots.');
  } finally {
    await browser?.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertIdentityLookupUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('share menu finds organization person', () => assertShareMenuPeopleSearch(page, appUrl, apiUrl, seed));
    await step('comment composer finds organization person', () => assertCommentMentionSearch(page, appUrl, apiUrl, seed));
    await step('editor @ mention finds organization person', () => assertMentionPeopleSearch(page, appUrl, apiUrl, seed));
    await step('database Person property finds organization person', () => assertDatabasePersonSearch(page, appUrl, apiUrl, seed));
    assertNoBrowserErrors(errors, 'identity lookup UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertShareMenuPeopleSearch(page, appUrl, apiUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('button', { name: `Share ${seed.pageTitle}` }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: `Share ${seed.pageTitle}` });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByLabel('Invite people').fill(seed.inviteeEmail, { timeout: options.timeoutMs });
  const people = dialog.locator('[aria-label="Organization people"]');
  await people.getByRole('button', { name: new RegExp(escapeRegex(seed.inviteeLookupLabel)) }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click({ timeout: options.timeoutMs });
  await waitForPagePermission(apiUrl, seed);
  await page.waitForFunction(
    (name) => document.body.textContent?.includes(name),
    seed.inviteeLookupLabel,
    { timeout: options.timeoutMs },
  );
}

async function assertMentionPeopleSearch(page, appUrl, apiUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const textbox = page.getByRole('textbox', { name: 'Text block text' }).first();
  await textbox.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type(`@${seed.inviteeMentionQuery}`, { delay: 5 });
  const mentionMenu = page.getByRole('listbox', { name: 'Mention' });
  await mentionMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await mentionMenu.getByRole('option', { name: new RegExp(escapeRegex(seed.inviteeEmail)) }).click({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (name) => {
      const editable = document.querySelector('[data-rt-editable="true"][aria-label="Text block text"]');
      return Boolean(editable?.textContent?.includes(`@${name}`));
    },
    seed.inviteeLookupLabel,
    { timeout: options.timeoutMs },
  );
  await waitForBlockMention(apiUrl, seed);
}

async function assertCommentMentionSearch(page, appUrl, apiUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await openPageCommentDialog(page, seed);
  const dialog = page.getByRole('dialog', { name: 'Comments' });
  const textbox = dialog.getByRole('textbox', { name: 'Add a page comment' });
  await textbox.fill(`Please review @${seed.inviteeMentionQuery}`, { timeout: options.timeoutMs });
  const mentionMenu = dialog.getByRole('listbox', { name: 'Comment mention people' });
  await mentionMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await mentionMenu.getByRole('option', { name: new RegExp(escapeRegex(seed.inviteeLookupLabel)) }).click({
    timeout: options.timeoutMs,
  });
  await textbox.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter', {
    timeout: options.timeoutMs,
  });
  await dialog.getByText(`Please review @${seed.inviteeLookupLabel}`, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForCommentMention(apiUrl, seed);
  await dialog.getByText(`Please review @${seed.inviteeLookupLabel}`, { exact: true })
    .locator('xpath=ancestor::article[1]')
    .getByRole('button', { name: 'Reply' })
    .click({ timeout: options.timeoutMs });
  const replyTextbox = dialog.getByRole('textbox', { name: 'Reply' });
  await replyTextbox.fill(`Follow up @${seed.inviteeMentionQuery}`, { timeout: options.timeoutMs });
  const replyMentionMenu = dialog.getByRole('listbox', { name: 'Reply mention people' });
  await replyMentionMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await replyMentionMenu.getByRole('option', { name: new RegExp(escapeRegex(seed.inviteeLookupLabel)) }).click({
    timeout: options.timeoutMs,
  });
  await replyTextbox.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter', {
    timeout: options.timeoutMs,
  });
  await dialog.getByText(`Follow up @${seed.inviteeLookupLabel}`, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForReplyMention(apiUrl, seed);
  await closeComments(page);
}

async function assertDatabasePersonSearch(page, appUrl, apiUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: 'Table' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await cell(page, 0, 1).getByRole('button', { name: `Edit ${seed.personPropName} people` }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Edit person property' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByLabel('Search organization people').fill(seed.inviteeEmail, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('option', { name: new RegExp(escapeRegex(seed.inviteeLookupLabel)) }).click({
    timeout: options.timeoutMs,
  });
  await expectCellText(page, 0, 1, seed.inviteeLookupLabel);
  await waitForPersonProperty(apiUrl, seed, {
    present: [seed.inviteeUserId],
    absent: [seed.secondInviteeUserId],
  });

  await dialog.getByLabel('Search organization people').fill(seed.secondInviteeEmail, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('option', { name: new RegExp(escapeRegex(seed.secondInviteeLookupLabel)) }).click({
    timeout: options.timeoutMs,
  });
  await expectCellText(page, 0, 1, seed.inviteeLookupLabel);
  await expectCellText(page, 0, 1, seed.secondInviteeLookupLabel);
  await waitForPersonProperty(apiUrl, seed, {
    present: [seed.inviteeUserId, seed.secondInviteeUserId],
  });

  await dialog.getByLabel('Search organization people').fill(seed.inviteeEmail, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('option', { name: new RegExp(escapeRegex(seed.inviteeLookupLabel)) }).click({
    timeout: options.timeoutMs,
  });
  await expectCellText(page, 0, 1, seed.secondInviteeLookupLabel);
  await expectCellNotText(page, 0, 1, seed.inviteeLookupLabel);
  await waitForPersonProperty(apiUrl, seed, {
    present: [seed.secondInviteeUserId],
    absent: [seed.inviteeUserId],
  });
}

async function seedIdentityWorkspace(baseUrl) {
  const owner = await signIn(baseUrl);
  const invitee = await signIn(baseUrl);
  const secondInvitee = await signIn(baseUrl);
  assert(owner.userId !== invitee.userId, 'identity lookup smoke requires two different users');
  assert(
    owner.userId !== secondInvitee.userId && invitee.userId !== secondInvitee.userId,
    'identity lookup smoke requires three different users for multi-person selection',
  );

  const bootstrap = await callFunction(baseUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  const organizationId = bootstrap?.organization?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for identity lookup smoke');
  assert(organizationId, 'workspace-bootstrap must return an organization id for identity lookup smoke');

  const suffix = Date.now();
  const inviteeDisplayName = `IdentityAlpha${suffix}`;
  const inviteeEmail = `identity-ui-${suffix}@example.test`;
  const secondInviteeDisplayName = `IdentityBeta${suffix}`;
  const secondInviteeEmail = `identity-ui-second-${suffix}@example.test`;
  await inviteWorkspaceMember(baseUrl, {
    ownerToken: owner.accessToken,
    inviteeToken: invitee.accessToken,
    workspaceId,
    email: inviteeEmail,
    displayName: inviteeDisplayName,
    expectedUserId: invitee.userId,
    label: 'identity lookup invitee',
  });
  await inviteWorkspaceMember(baseUrl, {
    ownerToken: owner.accessToken,
    inviteeToken: secondInvitee.accessToken,
    workspaceId,
    email: secondInviteeEmail,
    displayName: secondInviteeDisplayName,
    expectedUserId: secondInvitee.userId,
    label: 'identity lookup second invitee',
  });

  const inviteeProfile = await lookupOrganizationProfile(baseUrl, {
    accessToken: owner.accessToken,
    organizationId,
    query: inviteeEmail,
    userId: invitee.userId,
    label: 'seeded invitee',
  });
  const secondInviteeProfile = await lookupOrganizationProfile(baseUrl, {
    accessToken: owner.accessToken,
    organizationId,
    query: secondInviteeEmail,
    userId: secondInvitee.userId,
    label: 'seeded second invitee',
  });
  const inviteeLookupLabel = profileLookupLabel(inviteeProfile);
  const secondInviteeLookupLabel = profileLookupLabel(secondInviteeProfile);
  assert(inviteeLookupLabel, 'seeded invitee must have a usable people lookup label');
  assert(secondInviteeLookupLabel, 'seeded second invitee must have a usable people lookup label');
  const inviteeMentionQuery = inviteeLookupLabel.includes('@')
    ? inviteeLookupLabel.split('@')[0]
    : inviteeLookupLabel;

  const pageId = randomUUID();
  const blockId = randomUUID();
  const pageTitle = `Identity lookup UI ${suffix}`;
  const createdPage = await callFunction(baseUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: pageTitle,
    position: suffix,
  });
  assert(createdPage?.page?.id === pageId, 'identity lookup page must be created');
  const createdBlock = await callFunction(baseUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [] },
    plainText: '',
    position: 1,
  });
  assert(createdBlock?.block?.id === blockId, 'identity lookup paragraph block must be created');

  const databaseId = randomUUID();
  const personPropId = randomUUID();
  const personPropName = 'Assignee';
  const createdDatabase = await callFunction(baseUrl, owner.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Identity people DB ${suffix}`,
    viewType: 'table',
    properties: [
      { id: randomUUID(), name: 'Name', type: 'title', position: 1 },
      { id: personPropId, name: personPropName, type: 'person', position: 2 },
    ],
  });
  assert(createdDatabase?.page?.id === databaseId, 'identity lookup database must be created');
  assert(Array.isArray(createdDatabase?.rows) && createdDatabase.rows.length >= 1, 'identity lookup database needs a row');
  const rowId = createdDatabase.rows[0].id;
  await callFunction(baseUrl, owner.accessToken, 'database-row-mutation', {
    action: 'update',
    id: rowId,
    patch: { title: `Identity row ${suffix}` },
  });

  return {
    accessToken: owner.accessToken,
    refreshToken: owner.refreshToken,
    workspaceId,
    organizationId,
    inviteeUserId: invitee.userId,
    inviteeDisplayName,
    inviteeLookupLabel,
    inviteeMentionQuery,
    inviteeEmail,
    secondInviteeUserId: secondInvitee.userId,
    secondInviteeDisplayName,
    secondInviteeLookupLabel,
    secondInviteeEmail,
    pageId,
    pageTitle,
    blockId,
    databaseId,
    rowId,
    personPropId,
    personPropName,
  };
}

async function inviteWorkspaceMember(baseUrl, {
  ownerToken,
  inviteeToken,
  workspaceId,
  email,
  displayName,
  expectedUserId,
  label,
}) {
  const invited = await callFunction(baseUrl, ownerToken, 'workspace-mutation', {
    action: 'inviteMember',
    workspaceId,
    email,
    role: 'member',
    displayName,
  });
  assert(invited?.invitation?.token, `${label} invite must return an accept token`);
  const accepted = await callFunction(baseUrl, inviteeToken, 'workspace-mutation', {
    action: 'acceptInvitation',
    token: invited.invitation.token,
    email,
  });
  assert(accepted?.member?.userId === expectedUserId, `${label} must accept membership`);
}

async function lookupOrganizationProfile(baseUrl, {
  accessToken,
  organizationId,
  query,
  userId,
  label,
}) {
  const peopleSearch = await callFunction(baseUrl, accessToken, 'workspace-mutation', {
    action: 'searchOrganizationPeople',
    organizationId,
    query,
    limit: 5,
  });
  const profile = peopleSearch?.people?.find((item) => item.userId === userId);
  assert(profile, `${label} must be searchable in organization people lookup`);
  return profile;
}

function profileLookupLabel(profile) {
  return profile.displayName?.trim() || profile.email?.trim() || profile.userId?.trim();
}

async function waitForPagePermission(baseUrl, seed) {
  const startedAt = Date.now();
  let lastPermissions = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'share-mutation', {
      action: 'get',
      pageId: seed.pageId,
    });
    lastPermissions = Array.isArray(result?.permissions) ? result.permissions : [];
    if (lastPermissions.some((permission) => permission.principalType === 'user' && permission.principalId === seed.inviteeUserId)) {
      return;
    }
    await delay(250);
  }
  throw new Error(`share permission was not created for invitee; last=${JSON.stringify(lastPermissions)}`);
}

async function waitForBlockMention(baseUrl, seed) {
  const startedAt = Date.now();
  let lastRich = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'blocks',
      pageId: seed.pageId,
    });
    const block = result?.blocks?.find((item) => item.id === seed.blockId);
    lastRich = Array.isArray(block?.content?.rich) ? block.content.rich : [];
    if (
      lastRich.some(
        (span) => span?.mention === 'person' && span?.userId === seed.inviteeUserId,
      )
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`person mention was not persisted; last=${JSON.stringify(lastRich)}`);
}

async function waitForCommentMention(baseUrl, seed) {
  const startedAt = Date.now();
  let lastComments = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'comments',
      pageId: seed.pageId,
    });
    lastComments = Array.isArray(result?.comments) ? result.comments : [];
    if (
      lastComments.some((comment) =>
        (comment.body?.rich ?? []).some(
          (span) => span?.mention === 'person' && span?.userId === seed.inviteeUserId,
        ),
      )
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`comment person mention was not persisted; last=${JSON.stringify(lastComments)}`);
}

async function waitForReplyMention(baseUrl, seed) {
  const startedAt = Date.now();
  let lastComments = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'comments',
      pageId: seed.pageId,
    });
    lastComments = Array.isArray(result?.comments) ? result.comments : [];
    if (
      lastComments.some((comment) =>
        comment.parentId &&
        (comment.body?.rich ?? []).some(
          (span) => span?.mention === 'person' && span?.userId === seed.inviteeUserId,
        ),
      )
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`reply person mention was not persisted; last=${JSON.stringify(lastComments)}`);
}

async function openPageCommentDialog(page, seed) {
  const pageCommentButton = page.getByRole('button', { name: 'Add a comment...' }).first();
  if (await pageCommentButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await pageCommentButton.click({ timeout: options.timeoutMs });
  } else {
    await page.getByRole('textbox', { name: 'Page title' }).hover({ timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Add page comment' }).click({
      timeout: options.timeoutMs,
    });
  }

  await page.getByRole('dialog', { name: 'Comments' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function closeComments(page) {
  const dialog = page.getByRole('dialog', { name: 'Comments' });
  await dialog.getByRole('button', { name: 'Close comments' }).click({
    timeout: options.timeoutMs,
  });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function waitForPersonProperty(baseUrl, seed, expectation = {}) {
  const present = expectation.present ?? [seed.inviteeUserId];
  const absent = expectation.absent ?? [];
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'databaseRows',
      databaseId: seed.databaseId,
    });
    const row = result?.rows?.find((item) => item.id === seed.rowId);
    lastValue = row?.properties?.[seed.personPropId];
    const values = Array.isArray(lastValue) ? lastValue : lastValue ? [lastValue] : [];
    if (
      present.every((id) => values.includes(id)) &&
      absent.every((id) => !values.includes(id))
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(
    `database person property did not match expectation present=${JSON.stringify(present)} absent=${JSON.stringify(absent)}; last=${JSON.stringify(lastValue)}`,
  );
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  if (seed.pageId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, { call: callFunction }).catch(() => {});
  }
  if (seed.databaseId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { call: callFunction }).catch(() => {});
  }
}

async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

function cell(page, rowIndex, colIndex) {
  return page.locator(`[data-table-cell][data-row-index="${rowIndex}"][data-col-index="${colIndex}"]`);
}

async function expectCellText(page, rowIndex, colIndex, text) {
  await page.waitForFunction(
    ([row, col, expected]) => {
      const el = document.querySelector(
        `[data-table-cell][data-row-index="${row}"][data-col-index="${col}"]`,
      );
      return Boolean(el && el.offsetParent !== null && el.textContent?.includes(expected));
    },
    [rowIndex, colIndex, text],
    { timeout: options.timeoutMs },
  );
}

async function expectCellNotText(page, rowIndex, colIndex, text) {
  await page.waitForFunction(
    ([row, col, expected]) => {
      const el = document.querySelector(
        `[data-table-cell][data-row-index="${row}"][data-col-index="${col}"]`,
      );
      return Boolean(el && el.offsetParent !== null && !el.textContent?.includes(expected));
    },
    [rowIndex, colIndex, text],
    { timeout: options.timeoutMs },
  );
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
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
    'Playwright is required for identity lookup UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: DEFAULT_BASE_URL,
    apiUrl: DEFAULT_API_URL,
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
  console.log(`Usage: node scripts/identity-lookup-ui-smoke.mjs [options]

Checks organization people lookup in Share, comment/reply @ mention, editor @ mention, and database Person property UI with DOM assertions only.

Options:
  --url <url>             App URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL for split Vite/API runs. Defaults to HANJI_EDGEBASE_API_URL or ${DEFAULT_API_URL}.
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
