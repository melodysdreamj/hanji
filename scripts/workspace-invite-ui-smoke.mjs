#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  console.error(`\nFAIL workspace invite UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Workspace invite UI smoke target: ${appUrl}`);

  await assertRuntimeReachable(apiUrl);
  const seed = await seedInvitation(apiUrl, appUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertInviteAcceptanceUi(browser, appUrl, apiUrl, seed);
    console.log('PASS invite link account creation accepts a guest workspace invitation with read access and guest mutation denial through the SPA without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertInviteAcceptanceUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);

  try {
    await step(page, 'open invite link', () =>
      page.goto(resolveUrl(appUrl, `/workspace/${encodeURIComponent(seed.workspaceSlug)}?invite=${encodeURIComponent(seed.inviteToken)}`), {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs,
      }));
    await step(page, 'create account from invite link', () => signUpFromInvite(page, seed));
    await step(page, 'accept workspace invitation', () => acceptInvite(page, seed));
    await step(page, 'verify guest membership', () => assertGuestMembership(apiUrl, seed));
    assertNoBrowserErrors(errors, 'workspace invite UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function signUpFromInvite(page, seed) {
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

async function acceptInvite(page, seed) {
  await page.getByText('Join this workspace?', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('button', { name: 'Accept invitation' }).click({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (workspaceName) => {
      const button = document.querySelector('button[aria-label="Open workspace menu"]');
      return Boolean(button && button.textContent?.includes(workspaceName));
    },
    seed.workspaceName,
    { timeout: options.timeoutMs },
  );
}

async function assertGuestMembership(apiUrl, seed) {
  const session = await signInWithPassword(apiUrl, seed.inviteeEmail, seed.inviteePassword);
  assert(session?.accessToken, 'invitee password sign-in did not return an access token.');
  const bootstrap = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    workspaceId: seed.workspaceId,
  });
  assert(bootstrap?.workspace?.id === seed.workspaceId, 'accepted invitee should bootstrap the invited workspace.');
  assert(bootstrap?.currentMember?.role === 'guest', 'accepted invitee should have the guest workspace role.');
  assert(bootstrap?.currentMember?.email === seed.inviteeEmail, 'accepted invitee member email should match the invitation.');
  assert(
    Array.isArray(bootstrap?.pages) && bootstrap.pages.some((page) => page.id === seed.pageId),
    'accepted guest should be able to see existing workspace pages.',
  );

  const page = await callFunction(apiUrl, session.accessToken, 'page-query', {
    action: 'page',
    pageId: seed.pageId,
  });
  assert(page?.page?.id === seed.pageId, 'accepted guest should be able to read existing workspace pages.');
  const blocks = await callFunction(apiUrl, session.accessToken, 'page-query', {
    action: 'blocks',
    pageId: seed.pageId,
  });
  assert(
    Array.isArray(blocks?.blocks) &&
      blocks.blocks.some((block) => block.id === seed.blockId && block.plainText === seed.blockText),
    'accepted guest should be able to read existing workspace page blocks.',
  );

  await expectFunctionStatus(apiUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: randomUUID(),
    workspaceId: seed.workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: 'Guest should not create pages',
    position: Date.now(),
  }, 403);
  await expectFunctionStatus(apiUrl, session.accessToken, 'workspace-mutation', {
    action: 'inviteMember',
    workspaceId: seed.workspaceId,
    email: `guest-invite-denied-${Date.now()}@example.com`,
    role: 'guest',
    displayName: 'Guest Invite Denied',
  }, 403);
}

async function seedInvitation(apiUrl, appUrl) {
  const owner = await signInAnonymously(apiUrl);
  const bootstrap = await callFunction(apiUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspace = bootstrap?.workspace;
  assert(workspace?.id, 'workspace-bootstrap must return a workspace id for invite UI smoke.');
  assert(workspace?.name, 'workspace-bootstrap must return a workspace name for invite UI smoke.');
  const workspaceSlug = workspace.domain?.trim() || workspace.id;
  const suffix = Date.now();
  const pageId = randomUUID();
  const blockId = randomUUID();
  const pageTitle = `Guest invite readable page ${suffix}`;
  const blockText = `Guest invite readable block ${suffix}`;
  const inviteeDisplayName = `Invite UI ${suffix}`;
  const inviteeEmail = `invite-ui-${suffix}@example.com`;
  const inviteePassword = `InviteUi${suffix}!aA1`;
  const page = await callFunction(apiUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId: workspace.id,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: pageTitle,
    position: Date.now(),
  });
  assert(page?.page?.id === pageId, 'workspace invitation smoke seed page must be created.');

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
  assert(block?.block?.id === blockId, 'workspace invitation smoke seed block must be created.');

  const invited = await callFunction(apiUrl, owner.accessToken, 'workspace-mutation', {
    action: 'inviteMember',
    workspaceId: workspace.id,
    email: inviteeEmail,
    role: 'guest',
    displayName: inviteeDisplayName,
    appOrigin: appUrl,
  });
  assert(invited?.invitation?.token, 'workspace invitation must return an accept token.');

  return {
    ownerAccessToken: owner.accessToken,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug,
    pageId,
    blockId,
    pageTitle,
    blockText,
    inviteToken: invited.invitation.token,
    inviteeDisplayName,
    inviteeEmail,
    inviteePassword,
  };
}

async function cleanupSeed(apiUrl, seed) {
  if (!seed?.ownerAccessToken || !seed?.workspaceId) return;
  await callFunction(apiUrl, seed.ownerAccessToken, 'workspace-mutation', {
    action: 'deleteWorkspace',
    workspaceId: seed.workspaceId,
  }).catch(() => {});
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
    const snippet = text ? `\nVisible text: ${text.slice(0, 500)}` : '';
    throw new Error(`${label}: ${message}\nURL: ${page.url()}${snippet}`);
  }
}

async function signInAnonymously(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
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

async function signInWithPassword(baseUrl, email, password) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.ok, `password sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
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

async function assertRuntimeReachable(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/health'), {
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
    'Playwright is required for workspace invite UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
    if (arg === '--timeout-ms' || arg === '--timeout') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error(`${arg} must be a number >= 1000`);
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
  console.log(`Usage: node scripts/workspace-invite-ui-smoke.mjs [options]

Checks creating an account from a workspace invitation URL, accepting the
invitation in the SPA, and verifying guest membership through product APIs.

Options:
  --url <url>             App URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL when the app is served by Vite.
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
