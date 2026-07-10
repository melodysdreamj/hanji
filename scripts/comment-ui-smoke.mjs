#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL comment UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Comment UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedCommentPage(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertCommentUi(browser, baseUrl, seed);
    console.log('PASS comments support page creation, block threads, replies, resolve tabs, and comment anchor reveal without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertCommentUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openPage(page, baseUrl, seed.pageId, seed.title);
    await assertPageCommentComposer(page, seed);
    await assertBlockCommentThread(page, seed);
    assertNoBrowserErrors(errors, 'comment UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertPageCommentComposer(page, seed) {
  await openPageCommentDialog(page, seed);
  const dialog = page.getByRole('dialog', { name: 'Comments' });
  await dialog.getByRole('textbox', { name: 'Add a page comment' }).fill(seed.pageCommentText, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Comment', exact: true }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByText(seed.pageCommentText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await closeComments(page);
  await page.getByRole('button', { name: 'Open 1 unresolved page comment' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertBlockCommentThread(page, seed) {
  await page.getByRole('button', { name: /^1 unresolved comment on .* block$/ }).click({
    timeout: options.timeoutMs,
  });

  const dialog = page.getByRole('dialog', { name: 'Comments' });
  await dialog.getByRole('textbox', { name: 'Add a block comment' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  const blockThread = dialog.locator(commentSelector(seed.blockCommentId));
  await blockThread.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await blockThread.getByText(seed.blockCommentText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  await blockThread.getByRole('button', { name: 'Reply' }).first().click({
    timeout: options.timeoutMs,
  });
  await blockThread.getByRole('textbox', { name: 'Reply' }).fill(seed.replyText, {
    timeout: options.timeoutMs,
  });
  await blockThread.getByRole('button', { name: 'Reply' }).last().click({
    timeout: options.timeoutMs,
  });
  await blockThread.getByText(seed.replyText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  await blockThread.getByRole('button', { name: 'Show in page' }).click({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (commentId) => window.location.hash === `#comment-${commentId}`,
    seed.blockCommentId,
    { timeout: options.timeoutMs },
  );
  await page.locator(`#block-${seed.blockId}[data-comment-flash="true"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  await blockThread.getByRole('button', { name: 'Resolve' }).click({
    timeout: options.timeoutMs,
  });
  await blockThread.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await dialog.getByRole('tab', { name: /^Resolved/ }).click({
    timeout: options.timeoutMs,
  });

  const resolvedThread = dialog.locator(`${commentSelector(seed.blockCommentId)}[data-resolved="true"]`);
  await resolvedThread.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await resolvedThread.getByRole('button', { name: 'Reopen' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
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

async function openPage(page, baseUrl, pageId, title) {
  await page.goto(resolveUrl(baseUrl, `/p/${pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByText(title, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByText('Comment UI anchor block', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  const path = new URL(page.url()).pathname;
  assert(path === `/p/${pageId}`, `direct page route changed to ${path}`);
}

async function seedCommentPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for comment UI smoke');

  const pageId = randomUUID();
  const blockId = randomUUID();
  const blockCommentId = randomUUID();
  const title = `Comment UI smoke ${pageId}`;
  const blockText = 'Comment UI anchor block';
  const blockCommentText = `Seeded block comment ${blockCommentId}`;
  const pageCommentText = `Page comment created through UI ${pageId}`;
  const replyText = `Reply created through UI ${blockCommentId}`;

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'comment UI smoke page must be created');

  const block = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText }] },
    plainText: blockText,
    position: 1,
  });
  assert(block?.block?.id === blockId, 'comment UI smoke block must be created');

  const comment = await callFunction(baseUrl, session.accessToken, 'comment-mutation', {
    action: 'create',
    id: blockCommentId,
    pageId,
    blockId,
    parentId: null,
    body: {
      rich: [{ text: blockCommentText }],
      quote: blockText,
      quoteStart: 0,
      quoteEnd: blockText.length,
    },
    resolved: false,
  });
  assert(comment?.comment?.id === blockCommentId, 'comment UI smoke block comment must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageId,
    blockId,
    blockCommentId,
    title,
    blockCommentText,
    pageCommentText,
    replyText,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.pageId,
  });
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
  }, {
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
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
    'Playwright is required for comment UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/comment-ui-smoke.mjs [options]

Checks the running Notionlike app's comment panel with DOM assertions only.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser while running.
`);
}

function commentSelector(commentId) {
  return `[data-comment-id="${commentId.replace(/"/g, '\\"')}"]`;
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
