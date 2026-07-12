#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL block actions UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Block actions UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedBlockActionsPage(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertBlockActionsUi(browser, baseUrl, seed);
    console.log('PASS block actions duplicate, indent, outdent, and delete persist through the product API without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertBlockActionsUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded block actions page', () => openPage(page, baseUrl, seed));
    await step('duplicate a block through the action menu', () => assertDuplicateAction(page, baseUrl, seed));
    await step('indent and outdent the duplicate with editor keyboard nesting', () =>
      assertIndentAndOutdent(page, baseUrl, seed));
    await step('delete the duplicate through the action menu', () => assertDeleteAction(page, baseUrl, seed));
    assertNoBrowserErrors(errors, 'block actions UI flow');
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

async function openPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, seed.title);
  for (const id of Object.values(seed.blockIds)) {
    await blockGroup(page, id).waitFor({ state: 'visible', timeout: options.timeoutMs });
  }
  await expectTopLevelDomOrder(page, [seed.blockIds.anchor, seed.blockIds.target, seed.blockIds.after]);
  await waitForTopLevelOrder(
    baseUrl,
    seed,
    [seed.blockIds.anchor, seed.blockIds.target, seed.blockIds.after],
    'initial block action order',
  );
}

async function assertDuplicateAction(page, baseUrl, seed) {
  await openBlockActionMenu(page, seed.blockIds.target);
  const menu = page.getByRole('menu', { name: 'Block actions' });
  await menu.getByRole('menuitem', { name: /^Duplicate/ }).click({ timeout: options.timeoutMs });
  await menu.waitFor({ state: 'hidden', timeout: options.timeoutMs });

  const duplicate = await waitForDuplicateBlock(baseUrl, seed);
  seed.blockIds.duplicate = duplicate.id;
  await blockGroup(page, duplicate.id).waitFor({ state: 'visible', timeout: options.timeoutMs });

  const expectedOrder = [
    seed.blockIds.anchor,
    seed.blockIds.target,
    seed.blockIds.duplicate,
    seed.blockIds.after,
  ];
  await expectTopLevelDomOrder(page, expectedOrder);
  await waitForTopLevelOrder(baseUrl, seed, expectedOrder, 'duplicated block order');
}

async function assertIndentAndOutdent(page, baseUrl, seed) {
  const duplicateId = seed.blockIds.duplicate;
  assert(duplicateId, 'duplicate block id must exist before indenting');

  await blockTextBox(page, duplicateId).click({ timeout: options.timeoutMs });
  await page.keyboard.press('Tab');
  await waitForBlock(
    baseUrl,
    seed,
    duplicateId,
    (block) => block?.parentId === seed.blockIds.target,
    'indented duplicate block',
  );
  await expectBlockDepth(page, duplicateId, 1);

  await blockTextBox(page, duplicateId).click({ timeout: options.timeoutMs });
  await page.keyboard.press('Shift+Tab');
  await waitForBlock(
    baseUrl,
    seed,
    duplicateId,
    (block) => (block?.parentId ?? null) === null,
    'outdented duplicate block',
  );
  await expectBlockDepth(page, duplicateId, 0);
  await waitForTopLevelOrder(
    baseUrl,
    seed,
    [seed.blockIds.anchor, seed.blockIds.target, duplicateId, seed.blockIds.after],
    'outdented duplicate block order',
  );
}

async function assertDeleteAction(page, baseUrl, seed) {
  const duplicateId = seed.blockIds.duplicate;
  assert(duplicateId, 'duplicate block id must exist before deleting');

  await openBlockActionMenu(page, duplicateId);
  const menu = page.getByRole('menu', { name: 'Block actions' });
  await menu.getByRole('menuitem', { name: /^Delete/ }).click({ timeout: options.timeoutMs });
  await menu.waitFor({ state: 'hidden', timeout: options.timeoutMs });

  await blockGroup(page, duplicateId).waitFor({ state: 'detached', timeout: options.timeoutMs });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => !blocks.some((block) => block.id === duplicateId),
    'deleted duplicate block',
  );
  await waitForTopLevelOrder(
    baseUrl,
    seed,
    [seed.blockIds.anchor, seed.blockIds.target, seed.blockIds.after],
    'order after deleting duplicate block',
  );
}

async function openBlockActionMenu(page, blockId) {
  const group = blockGroup(page, blockId);
  await group.hover({ timeout: options.timeoutMs });
  await group.getByRole('button', { name: 'Open block actions' }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('menu', { name: 'Block actions' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

function blockGroup(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

function blockTextBox(page, blockId) {
  return blockGroup(page, blockId).getByRole('textbox', { name: 'Text block text' });
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

async function expectTopLevelDomOrder(page, expectedIds) {
  await page.waitForFunction(
    (ids) => {
      const editor = document.querySelector('[role="region"][aria-label="Page body"]');
      if (!editor) return false;
      const currentIds = Array.from(editor.querySelectorAll('[data-block-id]'))
        .filter((element) => element.getAttribute('data-depth') === '0')
        .map((element) => element.getAttribute('data-block-id'))
        .filter((id) => ids.includes(id));
      return JSON.stringify(currentIds) === JSON.stringify(ids);
    },
    expectedIds,
    { timeout: options.timeoutMs },
  );
}

async function expectBlockDepth(page, blockId, expectedDepth) {
  await page.waitForFunction(
    ({ id, depth }) => {
      const block = document.querySelector(`[data-block-id="${id}"]`);
      return block?.getAttribute('data-depth') === String(depth);
    },
    { id: blockId, depth: expectedDepth },
    { timeout: options.timeoutMs },
  );
}

async function waitForDuplicateBlock(baseUrl, seed) {
  const blocks = await waitForBlocks(
    baseUrl,
    seed,
    (items) =>
      items.filter(
        (block) =>
          block.id !== seed.blockIds.target &&
          block.plainText === seed.blockText.target &&
          (block.parentId ?? null) === null,
      ).length === 1,
    'duplicated action-menu block',
  );
  return blocks.find(
    (block) =>
      block.id !== seed.blockIds.target &&
      block.plainText === seed.blockText.target &&
      (block.parentId ?? null) === null,
  );
}

async function waitForBlock(baseUrl, seed, blockId, predicate, label) {
  return waitForBlocks(
    baseUrl,
    seed,
    (blocks) => predicate(blocks.find((block) => block.id === blockId) ?? null),
    label,
  );
}

async function waitForTopLevelOrder(baseUrl, seed, expectedIds, label) {
  const startedAt = Date.now();
  let lastOrder = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const blocks = await fetchSeedBlocks(baseUrl, seed);
    lastOrder = topLevelOrder(blocks, expectedIds);
    if (JSON.stringify(lastOrder) === JSON.stringify(expectedIds)) return blocks;
    await delay(250);
  }
  throw new Error(`${label} was not persisted; expected=${JSON.stringify(expectedIds)} last=${JSON.stringify(lastOrder)}`);
}

async function waitForBlocks(baseUrl, seed, predicate, label) {
  const startedAt = Date.now();
  let lastBlocks = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    lastBlocks = await fetchSeedBlocks(baseUrl, seed);
    if (predicate(lastBlocks)) return lastBlocks;
    await delay(250);
  }
  throw new Error(`${label} was not persisted for ${seed.pageId}; last blocks=${JSON.stringify(lastBlocks)}`);
}

function topLevelOrder(blocks, expectedIds) {
  const knownIds = new Set(expectedIds);
  return blocks
    .filter((block) => knownIds.has(block.id) && (block.parentId ?? null) === null)
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map((block) => block.id);
}

async function fetchSeedBlocks(baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'blocks',
    pageId: seed.pageId,
  });
  return Array.isArray(result?.blocks) ? result.blocks : [];
}

async function seedBlockActionsPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for block actions UI smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const title = `Block actions smoke ${suffix}`;
  const blockIds = {
    anchor: randomUUID(),
    target: randomUUID(),
    after: randomUUID(),
  };
  const blockText = {
    anchor: `Anchor actions block ${suffix}`,
    target: `Target actions block ${suffix}`,
    after: `After actions block ${suffix}`,
  };

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'block actions UI smoke page must be created');

  const keys = ['anchor', 'target', 'after'];
  const blocks = keys.map((key, index) => ({
    id: blockIds[key],
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText[key] }] },
    plainText: blockText[key],
    position: index + 1,
  }));
  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(createdBlocks?.blocks?.length === blocks.length, 'block actions UI smoke blocks must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageId,
    title,
    blockIds,
    blockText,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, { call: callFunction }).catch(() => {});
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
    'Playwright is required for block actions UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/block-actions-ui-smoke.mjs [options]

Checks block action-menu duplicate/delete plus keyboard nesting with product
API persistence assertions only. The smoke duplicates one block, indents it
under the original, outdents it, and deletes the duplicate.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
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
