#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 15_000;

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL trash UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Trash UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);

  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });
  const seeds = [];

  try {
    await assertEmptyTrashState(browser, baseUrl);
    const restoreSeed = await seedTrashedPage(baseUrl, 'restore');
    seeds.push(restoreSeed);
    await assertPopulatedTrashState(browser, baseUrl, restoreSeed);
    const deleteSeed = await seedTrashedPage(baseUrl, 'delete');
    seeds.push(deleteSeed);
    await assertPermanentDeleteState(browser, baseUrl, deleteSeed);
    const emptySeed = await seedTrashedPages(baseUrl, 2, 'empty');
    seeds.push(emptySeed);
    await assertEmptyTrashBulkState(browser, baseUrl, emptySeed);
    console.log('PASS /trash direct route renders empty, populated, search-filtered, restored, permanent-delete, and empty-trash confirmation states without screenshots.');
  } finally {
    for (const seed of seeds) {
      await cleanupSeed(baseUrl, seed).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

async function assertEmptyTrashState(browser, baseUrl) {
  const seed = await seedWorkspaceSession(baseUrl);
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openTrash(page, baseUrl);
    await assertEmptyTrashRendered(page);
    assertNoBrowserErrors(errors, 'empty trash state');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertPopulatedTrashState(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openTrash(page, baseUrl);
    await page.getByText(seed.title, { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.getByText('1 page', { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    const search = page.getByLabel('Search trash');
    await search.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await search.fill(seed.title.slice(0, 24));
    await page.getByText(seed.title, { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    await search.fill(`no-match-${seed.pageId}`);
    await page.getByText('No deleted pages match your search.').waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    const hiddenAfterFilter = await page
      .getByText(seed.title, { exact: true })
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    assert(!hiddenAfterFilter, 'trash search no-results state should hide unmatched pages');

    await search.fill(seed.title);
    await page.getByRole('button', { name: `Restore ${seed.title}` }).click({
      timeout: options.timeoutMs,
    });
    await assertEmptyTrashRendered(page);
    seed.restored = true;

    assertNoBrowserErrors(errors, 'populated trash state');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertPermanentDeleteState(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openTrash(page, baseUrl);
    await page.getByText(seed.title, { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    await page.getByRole('button', { name: `Delete ${seed.title} forever` }).click({
      timeout: options.timeoutMs,
    });
    const dialog = page.getByRole('dialog', { name: 'Delete forever?' });
    await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await dialog.getByText(seed.title, { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    await dialog.getByRole('button', { name: 'Cancel' }).click({
      timeout: options.timeoutMs,
    });
    await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
    await page.getByText(seed.title, { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    await page.getByRole('button', { name: `Delete ${seed.title} forever` }).click({
      timeout: options.timeoutMs,
    });
    const confirmDialog = page.getByRole('dialog', { name: 'Delete forever?' });
    await confirmDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await confirmDialog.getByRole('button', { name: 'Delete forever' }).click({
      timeout: options.timeoutMs,
    });
    await assertEmptyTrashRendered(page);
    seed.deleted = true;

    assertNoBrowserErrors(errors, 'permanent delete trash state');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertEmptyTrashBulkState(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);
  const countLabel = `${seed.pageIds.length} pages`;

  try {
    await openTrash(page, baseUrl);
    await page.getByText(countLabel, { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    // Cancelling the confirmation must leave every trashed page in place.
    await page.getByRole('button', { name: 'Empty trash', exact: true }).click({
      timeout: options.timeoutMs,
    });
    const dialog = page.getByRole('dialog', { name: 'Empty trash?' });
    await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await dialog.getByRole('button', { name: 'Cancel' }).click({
      timeout: options.timeoutMs,
    });
    await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
    await page.getByText(countLabel, { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    // Confirming permanently deletes all trashed pages at once.
    await page.getByRole('button', { name: 'Empty trash', exact: true }).click({
      timeout: options.timeoutMs,
    });
    const confirmDialog = page.getByRole('dialog', { name: 'Empty trash?' });
    await confirmDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await confirmDialog.getByRole('button', { name: 'Empty trash', exact: true }).click({
      timeout: options.timeoutMs,
    });
    await assertEmptyTrashRendered(page);
    seed.deleted = true;

    assertNoBrowserErrors(errors, 'empty trash bulk state');
  } finally {
    await context.close().catch(() => {});
  }
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

async function openTrash(page, baseUrl) {
  await page.goto(resolveUrl(baseUrl, '/trash'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('heading', { name: 'Trash' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(() => document.title.includes('Trash'), null, {
    timeout: options.timeoutMs,
  });

  const path = new URL(page.url()).pathname;
  assert(path === '/trash', `direct /trash route changed to ${path}`);
}

async function assertEmptyTrashRendered(page) {
  await page.getByText('Pages you delete land here. Nothing in the trash.').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const searchVisible = await page
    .getByLabel('Search trash')
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  assert(!searchVisible, 'empty trash state should not show the trash search field');
}

async function seedTrashedPage(baseUrl, label = 'page') {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for trash UI smoke');

  const pageId = randomUUID();
  const title = `Trash UI smoke ${label} ${pageId}`;
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
  assert(created?.page?.id === pageId, 'trash UI smoke seed page must be created');

  const trashed = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'trash',
    id: pageId,
  });
  assert(
    Array.isArray(trashed?.pages) &&
      trashed.pages.some((pageRecord) => pageRecord.id === pageId && pageRecord.inTrash === true),
    'trash UI smoke seed page must be moved to trash',
  );

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageId,
    title,
    restored: false,
    deleted: false,
  };
}

async function seedTrashedPages(baseUrl, count, label = 'bulk') {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for trash UI smoke');

  const pageIds = [];
  for (let i = 0; i < count; i += 1) {
    const pageId = randomUUID();
    const title = `Trash UI smoke ${label} ${i} ${pageId}`;
    const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'create',
      id: pageId,
      workspaceId,
      parentId: null,
      parentType: 'workspace',
      kind: 'page',
      title,
      position: Date.now() + i,
    });
    assert(created?.page?.id === pageId, 'trash UI smoke bulk seed page must be created');

    const trashed = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'trash',
      id: pageId,
    });
    assert(
      Array.isArray(trashed?.pages) &&
        trashed.pages.some((pageRecord) => pageRecord.id === pageId && pageRecord.inTrash === true),
      'trash UI smoke bulk seed page must be moved to trash',
    );
    pageIds.push(pageId);
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageIds,
    deleted: false,
  };
}

async function seedWorkspaceSession(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for trash UI smoke');
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (seed?.deleted) return;
  if (!seed?.accessToken) return;
  const ids = seed.pageIds ?? (seed.pageId ? [seed.pageId] : []);
  for (const id of ids) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id,
    }).catch(() => {});
  }
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
  console.log(`Usage: node scripts/trash-ui-smoke.mjs [options]

Checks the running Notionlike app's /trash route with DOM assertions only.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser while running.
`);
}
