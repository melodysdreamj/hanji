#!/usr/bin/env node

import { createRequire } from 'node:module';
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
  console.error(`\nFAIL workspace switcher UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Workspace switcher UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedWorkspace(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertWorkspaceSwitcherUi(browser, baseUrl, seed);
    console.log('PASS workspace switcher creates a second workspace, switches between workspaces, and cleans up through product APIs without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertWorkspaceSwitcherUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open current workspace', () => openApp(page, baseUrl, seed.initialWorkspaceName));
    await step('create another workspace from sidebar menu', () => createWorkspaceFromMenu(page, baseUrl, seed));
    await step('switch back to the original workspace', () => switchBackToOriginalWorkspace(page, seed));
    assertNoBrowserErrors(errors, 'workspace switcher UI flow');
  } finally {
    await context.close().catch(() => {});
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

async function openApp(page, baseUrl, workspaceName) {
  await page.goto(resolveUrl(baseUrl, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await expectWorkspaceButton(page, workspaceName);
}

async function createWorkspaceFromMenu(page, baseUrl, seed) {
  await openWorkspaceMenu(page);
  await page.getByRole('menuitem', { name: 'New workspace' }).click({ timeout: options.timeoutMs });
  const input = page.getByRole('textbox', { name: 'Workspace name' });
  await input.fill(seed.createdWorkspaceName, { timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Create' }).click({ timeout: options.timeoutMs });
  await expectWorkspaceButton(page, seed.createdWorkspaceName);
  seed.createdWorkspaceId = await waitForWorkspaceByName(baseUrl, seed, seed.createdWorkspaceName);
}

async function switchBackToOriginalWorkspace(page, seed) {
  await openWorkspaceMenu(page);
  await page.getByRole('menuitemradio', { name: seed.initialWorkspaceName }).click({
    timeout: options.timeoutMs,
  });
  await expectWorkspaceButton(page, seed.initialWorkspaceName);
}

async function openWorkspaceMenu(page) {
  await page.getByRole('button', { name: 'Open workspace menu' }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('menu', { name: 'Workspace menu' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function expectWorkspaceButton(page, name) {
  await page.waitForFunction(
    (expected) => {
      const button = document.querySelector('button[aria-label="Open workspace menu"]');
      return Boolean(button && button.textContent?.includes(expected));
    },
    name,
    { timeout: options.timeoutMs },
  );
}

async function waitForWorkspaceByName(baseUrl, seed, name) {
  const startedAt = Date.now();
  let lastNames = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'workspace-mutation', {
      action: 'list',
    });
    const workspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
    lastNames = workspaces.map((workspace) => workspace.name);
    const workspace = workspaces.find((item) => item.name === name);
    if (workspace?.id) return workspace.id;
    await delay(250);
  }
  throw new Error(`workspace ${name} was not listed; last=${JSON.stringify(lastNames)}`);
}

async function seedWorkspace(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  const initialWorkspaceName = bootstrap?.workspace?.name;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for workspace switcher UI smoke');
  assert(initialWorkspaceName, 'workspace-bootstrap must return a workspace name for workspace switcher UI smoke');
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    initialWorkspaceName,
    createdWorkspaceName: `Switcher smoke ${Date.now()}`,
    createdWorkspaceId: '',
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.createdWorkspaceId) return;
  await callFunction(baseUrl, seed.accessToken, 'workspace-mutation', {
    action: 'deleteWorkspace',
    workspaceId: seed.createdWorkspaceId,
  }).catch(() => {});
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
    'Playwright is required for workspace switcher UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/workspace-switcher-ui-smoke.mjs [options]

Checks creating and switching workspaces from the sidebar menu with DOM and
product API assertions only.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
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
