#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePasswordAuthForm } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL page email share UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Page email share UI smoke target: ${appUrl}`);

  await assertRuntimeReachable(apiUrl);
  const seed = await seedEmailSharedPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertEmailSharedPageUi(browser, appUrl, apiUrl, seed);
    console.log(
      'PASS direct email page sharing opens through AuthGate with comment access, read-only content, root/cached-workspace bootstrap, workspace discovery, workspace/organization directory denial, edit/share-management denial, and no private sibling page/block/comment/file/search leakage.',
    );
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertEmailSharedPageUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);

  try {
    await step(page, 'open direct shared page URL', () =>
      page.goto(resolveUrl(appUrl, `/p/${encodeURIComponent(seed.pageId)}`), {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs,
      }));
    await step(page, 'create matching email account', () => signUpFromDirectPage(page, seed));
    await step(page, 'render direct shared page in read-only content mode', () =>
      assertSharedPageRendered(page, seed));
    await step(page, 'create page comment from email shared account', () =>
      createPageComment(page, seed));
    await step(page, 'verify product API role and comment persistence', () =>
      assertSharedAccountProductState(apiUrl, seed));
    assertNoBrowserErrors(errors, 'page email share UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function signUpFromDirectPage(page, seed) {
  await ensurePasswordAuthForm(page, options.timeoutMs);
  await page.getByRole('button', { name: 'Create account' }).click({ timeout: options.timeoutMs });
  await page.getByRole('textbox', { name: 'Name' }).fill(seed.inviteeDisplayName, {
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Email' }).fill(seed.inviteeEmail, {
    timeout: options.timeoutMs,
  });
  await page.getByLabel('Password').fill(seed.inviteePassword, {
    timeout: options.timeoutMs,
  });
  await page.getByRole('button', { name: 'Create account', exact: true }).click({
    timeout: options.timeoutMs,
  });
}

async function assertSharedPageRendered(page, seed) {
  await page.getByText(seed.title, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByText(seed.blockText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tree', { name: 'Shared pages' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  const path = new URL(page.url()).pathname;
  assert(path === `/p/${seed.pageId}`, `direct page route changed to ${path}`);

  await page.waitForFunction(
    ({ title }) => {
      const titleBox = document.querySelector('[role="textbox"][aria-label="Page title"]');
      return titleBox?.textContent?.trim() === title && titleBox.getAttribute('aria-readonly') === 'true';
    },
    { title: seed.title },
    { timeout: options.timeoutMs },
  );
  await page.waitForFunction(
    ({ blockText }) => {
      const editables = Array.from(document.querySelectorAll('[data-rt-editable="true"]'));
      return editables.some(
        (item) =>
          item.textContent?.trim() === blockText &&
          item.getAttribute('aria-readonly') === 'true',
      );
    },
    { blockText: seed.blockText },
    { timeout: options.timeoutMs },
  );
}

async function createPageComment(page, seed) {
  const topbarCommentButton = page.getByRole('button', { name: `Add comment to ${seed.title}` }).first();
  if (await topbarCommentButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await topbarCommentButton.click({ timeout: options.timeoutMs });
  } else {
    const pageCommentButton = page.getByRole('button', { name: 'Add a comment...' }).first();
    if (await pageCommentButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await pageCommentButton.click({ timeout: options.timeoutMs });
    } else {
      await page.getByRole('button', { name: 'Add page comment' }).click({
        timeout: options.timeoutMs,
        force: true,
      });
    }
  }

  const dialog = page.getByRole('dialog', { name: 'Comments' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('textbox', { name: 'Add a page comment' }).fill(seed.commentText, {
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Comment', exact: true }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByText(seed.commentText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertSharedAccountProductState(apiUrl, seed) {
  const invitee = await signInWithPassword(apiUrl, seed.inviteeEmail, seed.inviteePassword);
  const bootstrap = await callFunction(apiUrl, invitee.accessToken, 'workspace-bootstrap', {
    pageId: seed.pageId,
  });
  assertDirectShareBootstrap(bootstrap, seed, 'preferred page');

  const rootBootstrap = await callFunction(apiUrl, invitee.accessToken, 'workspace-bootstrap', {});
  assertDirectShareBootstrap(rootBootstrap, seed, 'root/default');

  const cachedWorkspaceBootstrap = await callFunction(apiUrl, invitee.accessToken, 'workspace-bootstrap', {
    workspaceId: seed.workspaceId,
  });
  assertDirectShareBootstrap(cachedWorkspaceBootstrap, seed, 'cached workspace');

  await expectFunctionStatus(apiUrl, invitee.accessToken, 'page-mutation', {
    action: 'create',
    id: randomUUID(),
    workspaceId: seed.workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: 'Direct share account should not create workspace pages',
    position: Date.now(),
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'workspace-mutation', {
    action: 'members',
    workspaceId: seed.workspaceId,
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'workspace-mutation', {
    action: 'inviteMember',
    workspaceId: seed.workspaceId,
    email: `direct-share-invite-denied-${Date.now()}@example.com`,
    role: 'guest',
    displayName: 'Direct Share Invite Denied',
  }, 403);

  const comments = await callFunction(apiUrl, invitee.accessToken, 'page-query', {
    action: 'comments',
    pageId: seed.pageId,
  });
  assert(
    Array.isArray(comments?.comments) &&
      comments.comments.some((comment) => richText(comment.body) === seed.commentText),
    'email shared UI comment should persist through the product API.',
  );

  await expectFunctionStatus(apiUrl, invitee.accessToken, 'block-mutation', {
    action: 'update',
    id: seed.blockId,
    patch: {
      plainText: `Forbidden edit ${seed.blockId}`,
      content: { rich: [{ text: `Forbidden edit ${seed.blockId}` }] },
    },
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'share-mutation', {
    action: 'updatePermission',
    permissionId: seed.permissionId,
    role: 'edit',
  }, 403);

  await expectFunctionStatus(apiUrl, invitee.accessToken, 'workspace-bootstrap', {
    pageId: seed.hiddenPageId,
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'page-query', {
    action: 'page',
    pageId: seed.hiddenPageId,
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'page-query', {
    action: 'blocks',
    pageId: seed.hiddenPageId,
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'page-query', {
    action: 'comments',
    pageId: seed.hiddenPageId,
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'file-mutation', {
    action: 'list',
    pageId: seed.hiddenPageId,
  }, 403);
  await expectFunctionStatus(apiUrl, invitee.accessToken, 'file-mutation', {
    action: 'signedUrl',
    uploadId: seed.hiddenUploadId,
  }, 403);

  const hiddenPageSearch = await callFunction(apiUrl, invitee.accessToken, 'page-query', {
    action: 'searchPages',
    query: seed.hiddenTitle,
  });
  assert(
    Array.isArray(hiddenPageSearch?.pages) &&
      !hiddenPageSearch.pages.some((page) => page.id === seed.hiddenPageId),
    'email shared account search must not leak private sibling page titles.',
  );
  const hiddenBlockSearch = await callFunction(apiUrl, invitee.accessToken, 'page-query', {
    action: 'searchBlocks',
    query: seed.hiddenBlockText,
  });
  assert(
    Array.isArray(hiddenBlockSearch?.blocks) &&
      !hiddenBlockSearch.blocks.some((block) => block.id === seed.hiddenBlockId),
    'email shared account body search must not leak private sibling page content.',
  );
}

function assertDirectShareBootstrap(bootstrap, seed, label) {
  assert(
    bootstrap?.workspace?.id === seed.workspaceId,
    `email shared account should bootstrap the shared workspace from ${label}.`,
  );
  assert(
    Array.isArray(bootstrap?.workspaces) &&
      bootstrap.workspaces.some((workspace) => workspace.id === seed.workspaceId),
    `email shared account should discover the direct-share workspace from ${label}.`,
  );
  assert(
    !bootstrap?.currentMember,
    `email direct sharing should not create a workspace membership from ${label}.`,
  );
  assert(
    Array.isArray(bootstrap?.members) && bootstrap.members.length === 0,
    `email direct sharing should not expose the workspace member directory from ${label}.`,
  );
  assert(
    Array.isArray(bootstrap?.organizationMembers) && bootstrap.organizationMembers.length === 0,
    `email direct sharing should not expose the organization member directory from ${label}.`,
  );
  assert(
    bootstrap?.pageRoles?.[seed.pageId] === 'comment',
    `email shared account should receive comment page role from ${label}.`,
  );
  assert(
    Array.isArray(bootstrap?.pages) &&
      bootstrap.pages.some((page) => page.id === seed.pageId) &&
      !bootstrap.pages.some((page) => page.id === seed.hiddenPageId),
    `email shared account should see only the directly shared page from ${label}, not private workspace siblings.`,
  );
}

async function seedEmailSharedPage(apiUrl) {
  const owner = await signInAnonymously(apiUrl);
  const bootstrap = await callFunction(apiUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for email share UI smoke.');

  const pageId = randomUUID();
  const blockId = randomUUID();
  const hiddenPageId = randomUUID();
  const hiddenBlockId = randomUUID();
  const hiddenFileBlockId = randomUUID();
  const suffix = Date.now();
  const title = `Email shared page UI ${pageId}`;
  const blockText = `Email shared page body ${pageId}`;
  const hiddenTitle = `Private sibling ${hiddenPageId}`;
  const hiddenBlockText = `Private sibling body ${hiddenBlockId}`;
  const hiddenFileName = `private-sibling-${hiddenFileBlockId}.txt`;
  const inviteeDisplayName = `Email Share UI ${suffix}`;
  const inviteeEmail = `page-email-share-ui-${suffix}@example.com`;
  const inviteePassword = `PageEmailShare${suffix}!aA1`;
  const commentText = `Email shared UI comment ${pageId}`;

  const created = await callFunction(apiUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'email share UI seed page must be created.');

  const block = await callFunction(apiUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText }] },
    plainText: blockText,
    position: 1,
  });
  assert(block?.block?.id === blockId, 'email share UI seed block must be created.');

  const hiddenPage = await callFunction(apiUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: hiddenPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: hiddenTitle,
    position: Date.now() + 1,
  });
  assert(hiddenPage?.page?.id === hiddenPageId, 'email share UI hidden sibling page must be created.');

  const hiddenBlock = await callFunction(apiUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: hiddenBlockId,
    pageId: hiddenPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: hiddenBlockText }] },
    plainText: hiddenBlockText,
    position: 1,
  });
  assert(hiddenBlock?.block?.id === hiddenBlockId, 'email share UI hidden sibling block must be created.');

  const hiddenFileBlock = await callFunction(apiUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: hiddenFileBlockId,
    pageId: hiddenPageId,
    parentId: null,
    type: 'file',
    content: { rich: [], url: '', fileName: hiddenFileName },
    plainText: hiddenFileName,
    position: 2,
  });
  assert(hiddenFileBlock?.block?.id === hiddenFileBlockId, 'email share UI hidden sibling file block must be created.');

  const hiddenUpload = await callFunction(apiUrl, owner.accessToken, 'file-mutation', {
    action: 'prepareUpload',
    pageId: hiddenPageId,
    blockId: hiddenFileBlockId,
    scope: 'blocks/files',
    name: hiddenFileName,
    size: 32,
    contentType: 'text/plain',
  });
  assert(hiddenUpload?.upload?.id, 'email share UI hidden sibling file upload grant must be created.');

  const share = await callFunction(apiUrl, owner.accessToken, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'email',
    label: inviteeEmail.toUpperCase(),
    role: 'comment',
  });
  assert(share?.permission?.id, 'email share UI page permission must be created.');

  return {
    ownerAccessToken: owner.accessToken,
    workspaceId,
    pageId,
    blockId,
    hiddenPageId,
    hiddenBlockId,
    hiddenFileBlockId,
    hiddenUploadId: hiddenUpload.upload.id,
    permissionId: share.permission.id,
    title,
    blockText,
    hiddenTitle,
    hiddenBlockText,
    hiddenFileName,
    inviteeDisplayName,
    inviteeEmail,
    inviteePassword,
    commentText,
  };
}

async function cleanupSeed(apiUrl, seed) {
  if (!seed?.ownerAccessToken) return;
  if (seed.permissionId) {
    await callFunction(apiUrl, seed.ownerAccessToken, 'share-mutation', {
      action: 'removePermission',
      permissionId: seed.permissionId,
    }).catch(() => {});
  }
  if (seed.hiddenUploadId) {
    await callFunction(apiUrl, seed.ownerAccessToken, 'file-mutation', {
      action: 'delete',
      uploadId: seed.hiddenUploadId,
    }).catch(() => {});
  }
  if (seed.pageId) {
    await callFunction(apiUrl, seed.ownerAccessToken, 'page-mutation', {
      action: 'delete',
      id: seed.pageId,
    }).catch(() => {});
  }
  if (seed.hiddenPageId) {
    await callFunction(apiUrl, seed.ownerAccessToken, 'page-mutation', {
      action: 'delete',
      id: seed.hiddenPageId,
    }).catch(() => {});
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
    const snippet = text ? `\nVisible text: ${text.slice(0, 700)}` : '';
    throw new Error(`${label}: ${message}\nURL: ${page.url()}${snippet}`);
  }
}

async function signInAnonymously(apiUrl) {
  const response = await fetch(resolveUrl(apiUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert(typeof body?.accessToken === 'string' && body.accessToken, 'anonymous sign-in must return an access token');
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user?.id,
  };
}

async function signInWithPassword(apiUrl, email, password) {
  const response = await fetch(resolveUrl(apiUrl, '/api/auth/signin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.ok, `password sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert(typeof body?.accessToken === 'string' && body.accessToken, 'password sign-in must return an access token');
  return body;
}

async function callFunction(apiUrl, token, name, body) {
  const response = await fetch(resolveUrl(apiUrl, `/api/functions/${name}`), {
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

async function expectFunctionStatus(apiUrl, token, name, body, expectedStatus) {
  const response = await fetch(resolveUrl(apiUrl, `/api/functions/${name}`), {
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
  assert(
    response.status === expectedStatus,
    `${name} expected HTTP ${expectedStatus} but returned ${response.status}: ${JSON.stringify(json)}`,
  );
  return json;
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

async function assertRuntimeReachable(apiUrl) {
  const response = await fetch(resolveUrl(apiUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}: ${text.slice(0, 200)}`);
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
    'Playwright is required for page email share UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/page-email-share-ui-smoke.mjs [options]

Checks direct email page sharing through AuthGate and the SPA with DOM assertions only.

Options:
  --url <url>             App URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL for split Vite/API runs. Defaults to NOTIONLIKE_EDGEBASE_API_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser while running.
`);
}

function richText(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.plainText === 'string') return value.plainText;
  if (!Array.isArray(value.rich)) return '';
  return value.rich.map((span) => (typeof span?.text === 'string' ? span.text : '')).join('');
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
