#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_API_URL = process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL;
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL updates UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Updates UI smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Updates UI smoke API: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  let browser;
  let seed;

  try {
    const { chromium } = await loadPlaywright();
    const executablePath = resolveChromeExecutable();
    browser = await launchBrowser(chromium, executablePath);
    seed = await seedReplyMentionNotification(apiUrl);
    await assertUpdatesUi(browser, appUrl, apiUrl, seed);
    console.log('PASS Updates panel renders persisted reply mention notifications, filters Mentions, opens the comment anchor, and marks the item read without screenshots.');
  } finally {
    await browser?.close().catch(() => {});
    if (seed) await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function launchBrowser(chromium, executablePath) {
  const baseOptions = {
    headless: !options.headed,
  };
  const attempts = [
    executablePath ? { ...baseOptions, executablePath } : null,
    baseOptions,
  ].filter(Boolean);
  let lastError;
  for (const launchOptions of attempts) {
    try {
      return await chromium.launch(launchOptions);
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }
  throw lastError;
}

function resolveChromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return undefined;
}

async function assertUpdatesUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed.owner);

  try {
    await openPage(page, appUrl, seed);
    await openUpdatesPanel(page);
    await assertReplyMentionVisible(page, seed);
    await assertMentionsFilter(page, seed);
    await openReplyMentionActivity(page, seed);
    await waitForNotificationRead(apiUrl, seed);
    assertNoBrowserErrors(errors, 'updates UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function openPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, seed.title);
  await page.getByText(seed.blockText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    (expected) => {
      const titleElement = document.querySelector('[role="textbox"][aria-label="Page title"]');
      if (!titleElement) return false;
      const text = titleElement instanceof HTMLElement ? titleElement.innerText : titleElement.textContent;
      return text?.trim() === expected;
    },
    title,
    { timeout: options.timeoutMs },
  );
}

async function openUpdatesPanel(page) {
  // The sidebar entry point is labeled "Inbox"; the panel it opens is Updates.
  await page.getByRole('button', { name: /^Inbox/ }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Updates' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function assertReplyMentionVisible(page, seed) {
  const dialog = page.getByRole('dialog', { name: 'Updates' });
  await dialog.getByText('Reply mention', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText(seed.replyPreview, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertMentionsFilter(page, seed) {
  const dialog = page.getByRole('dialog', { name: 'Updates' });
  await dialog.getByRole('tab', { name: /^Mentions/ }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByText('Reply mention', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText(seed.replyPreview, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openReplyMentionActivity(page, seed) {
  const dialog = page.getByRole('dialog', { name: 'Updates' });
  await dialog.locator('[role="listitem"]', { hasText: seed.replyPreview }).click({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ([pageId, commentId]) =>
      window.location.pathname === `/p/${pageId}` &&
      window.location.hash === `#comment-${encodeURIComponent(commentId)}`,
    [seed.pageId, seed.replyCommentId],
    { timeout: options.timeoutMs },
  );
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs }).catch(() => {});
}

async function seedReplyMentionNotification(baseUrl) {
  const owner = await signIn(baseUrl);
  const viewer = await signIn(baseUrl);
  assert(owner.userId !== viewer.userId, 'owner and viewer must be different users');

  const bootstrap = await callFunction(baseUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for updates UI smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const blockId = randomUUID();
  const ownerCommentId = randomUUID();
  const replyCommentId = randomUUID();
  const title = `Updates UI smoke ${suffix}`;
  const blockText = `Updates UI smoke anchor block ${suffix}`;
  const ownerCommentText = `Owner comment for updates smoke ${suffix}`;
  const replyPreview = `Reply mentioning owner from Updates UI smoke ${suffix}`;

  const page = await callFunction(baseUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: Date.now(),
  });
  assert(page?.page?.id === pageId, 'updates UI smoke page must be created');

  const block = await callFunction(baseUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText }] },
    plainText: blockText,
    position: 1,
  });
  assert(block?.block?.id === blockId, 'updates UI smoke block must be created');

  const ownerComment = await callFunction(baseUrl, owner.accessToken, 'comment-mutation', {
    action: 'create',
    id: ownerCommentId,
    pageId,
    blockId,
    body: { rich: [{ text: ownerCommentText }] },
  });
  assert(ownerComment?.comment?.id === ownerCommentId, 'updates UI smoke owner comment must be created');

  const share = await callFunction(baseUrl, owner.accessToken, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'Updates UI smoke viewer',
    role: 'comment',
  });
  assert(share?.permission?.id, 'updates UI smoke page share must be created');

  const reply = await callFunction(baseUrl, viewer.accessToken, 'comment-mutation', {
    action: 'create',
    id: replyCommentId,
    pageId,
    blockId,
    parentId: ownerCommentId,
    body: {
      rich: [
        { text: 'Reply mentioning ' },
        { text: 'owner', mention: 'person', userId: owner.userId },
        { text: ` from Updates UI smoke ${suffix}` },
      ],
    },
  });
  assert(reply?.comment?.id === replyCommentId, 'updates UI smoke reply mention must be created');

  const notification = await waitForNotification(baseUrl, owner.accessToken, workspaceId, (item) =>
    item.kind === 'mention' &&
    item.commentId === replyCommentId &&
    item.metadata?.source === 'reply' &&
    item.metadata?.parentId === ownerCommentId &&
    item.target === `/p/${encodeURIComponent(pageId)}#comment-${encodeURIComponent(replyCommentId)}` &&
    !item.readAt,
  );

  return {
    owner: { ...owner, workspaceId },
    viewer,
    workspaceId,
    pageId,
    blockId,
    ownerCommentId,
    replyCommentId,
    activityKey: notification.activityKey,
    title,
    blockText,
    replyPreview,
  };
}

async function waitForNotification(baseUrl, token, workspaceId, predicate) {
  const deadline = Date.now() + options.timeoutMs;
  let lastNotifications = [];
  while (Date.now() < deadline) {
    const result = await listNotifications(baseUrl, token, workspaceId, true);
    lastNotifications = result.notifications ?? [];
    const notification = lastNotifications.find(predicate);
    if (notification) return notification;
    await delay(150);
  }
  throw new Error(`expected seeded notification, saw ${JSON.stringify(lastNotifications.slice(0, 5))}`);
}

async function waitForNotificationRead(baseUrl, seed) {
  await waitForNotification(baseUrl, seed.owner.accessToken, seed.workspaceId, (item) =>
    item.activityKey === seed.activityKey && !!item.readAt,
  );
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.owner?.accessToken || !seed?.pageId) return;
  await callFunction(baseUrl, seed.owner.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.pageId,
  });
}

async function seedSession(context, session) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
  }, {
    refreshToken: session.refreshToken,
    workspaceId: session.workspaceId,
  });
}

async function newCheckedPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', async (response) => {
    if (response.status() < 400 || !response.url().includes('/api/functions/')) return;
    const text = await response.text().catch(() => '');
    errors.push(`${response.status()} ${response.url()}: ${text.slice(0, 300)}`);
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

async function listNotifications(baseUrl, token, workspaceId, includeRead) {
  return callFunction(baseUrl, token, 'notification-mutation', {
    action: 'list',
    workspaceId,
    includeRead,
    limit: 100,
  });
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
    'Playwright is required for updates UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/updates-ui-smoke.mjs [options]

Checks the running Notionlike app's Updates panel with DOM assertions only.

Options:
  --url <url>             App URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL for split Vite/API runs. Defaults to NOTIONLIKE_EDGEBASE_API_URL or ${DEFAULT_API_URL}.
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
