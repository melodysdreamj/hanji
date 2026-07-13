#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  browserAuthStorageKeys,
  finalizeRegisteredSmokeAccounts,
  permanentlyDeletePage,
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
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL page template UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('page template UI smoke');
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Page template UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedTemplateRuntime(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertPageTemplateRuntime(browser, baseUrl, seed);
    console.log('PASS page templates apply to an existing blank page and create a new persisted page through the product UI.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertPageTemplateRuntime(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('apply Task List to an existing blank page', () => applyTemplateToExistingPage(page, baseUrl, seed));
    await step('create Meeting Notes from the sidebar template gallery', () => createPageFromSidebarTemplate(page, baseUrl, seed));
    assertNoBrowserErrors(errors, 'page template UI runtime flow');
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

async function applyTemplateToExistingPage(page, baseUrl, seed) {
  await openPage(page, baseUrl, seed.pageId);
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const starter = page.getByRole('group', { name: 'Page starter', exact: true });
  await starter.waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await starter.getByRole('button', { name: 'Templates' }).click({ timeout: options.timeoutMs });

  const dialog = page.getByRole('dialog', { name: 'Templates' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.locator('button[class*="templateCard"]', { hasText: 'Task List' }).first().click({
    timeout: options.timeoutMs,
  });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await expectPageTitle(page, 'Task List');
  await expectPageStarterHidden(page);
  await expectTemplateContentVisible(page, ['Today', 'Set up my task list', 'Add today\'s most important task', 'This week', 'Later', 'Done']);

  const snapshot = await waitForPersistedTemplate(baseUrl, seed.accessToken, seed.pageId, {
    title: 'Task List',
    icon: '✅',
    blocks: [
      { type: 'callout', plainText: 'Check items off as you go. Drag tasks between sections when plans change.' },
      { type: 'heading_2', plainText: 'Today' },
      { type: 'to_do', plainText: 'Set up my task list' },
      { type: 'to_do', plainText: 'Add today\'s most important task' },
      { type: 'to_do', plainText: 'Follow up on yesterday\'s leftovers' },
      { type: 'heading_2', plainText: 'This week' },
      { type: 'to_do', plainText: 'Plan the week on Monday' },
      { type: 'to_do', plainText: 'Prepare for the next meeting' },
      { type: 'heading_2', plainText: 'Later' },
      { type: 'to_do', plainText: 'Park future ideas here so they are not forgotten' },
      { type: 'divider', plainText: '' },
      { type: 'heading_2', plainText: 'Done' },
      { type: 'paragraph', plainText: 'Drag finished tasks here for a satisfying weekly review.' },
    ],
  });
  assert(snapshot.blocks.length === 13, `Task List template should replace the starter placeholder with 13 blocks, got ${snapshot.blocks.length}`);
}

async function createPageFromSidebarTemplate(page, baseUrl, seed) {
  await openPage(page, baseUrl, seed.pageId);
  const sidebarTemplates = page.locator('[data-sidebar-footer]').getByRole('button', { name: 'Templates' });
  await sidebarTemplates.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await sidebarTemplates.click({ timeout: options.timeoutMs });

  const dialog = page.getByRole('dialog', { name: 'Templates' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('tab', { name: 'Work', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.locator('button[class*="templateCard"]', { hasText: 'Meeting Notes' }).first().click({
    timeout: options.timeoutMs,
  });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.waitForFunction(
    (existingPageId) => window.location.pathname.startsWith('/p/') && !window.location.pathname.includes(existingPageId),
    seed.pageId,
    { timeout: options.timeoutMs },
  );

  const createdPageId = await page.evaluate(() => decodeURIComponent(window.location.pathname.slice(3).split('/')[0] ?? ''));
  assert(createdPageId && createdPageId !== seed.pageId, 'Sidebar template creation must navigate to the new page');
  seed.createdPageId = createdPageId;
  await expectPageTitle(page, 'Meeting Notes');
  await expectPageStarterHidden(page);
  await expectTemplateContentVisible(page, ['Agenda', 'First topic to discuss', 'Decisions', 'Action items', 'Next meeting']);
  await expectSidebarPageVisible(page, 'Meeting Notes');

  await waitForPersistedTemplate(baseUrl, seed.accessToken, createdPageId, {
    title: 'Meeting Notes',
    icon: '🗓️',
    blocks: [
      { type: 'callout', plainText: 'One page per meeting. Give every action item an owner before the meeting ends.' },
      { type: 'simple_table', plainText: '' },
      { type: 'heading_2', plainText: 'Agenda' },
      { type: 'numbered_list_item', plainText: 'First topic to discuss' },
      { type: 'numbered_list_item', plainText: 'Second topic to discuss' },
      { type: 'heading_2', plainText: 'Notes' },
      { type: 'bulleted_list_item', plainText: 'Key points, context, and open discussion' },
      { type: 'heading_2', plainText: 'Decisions' },
      { type: 'callout', plainText: 'What was decided, and why' },
      { type: 'heading_2', plainText: 'Action items' },
      { type: 'to_do', plainText: 'Owner — task and due date' },
      { type: 'to_do', plainText: 'Owner — task and due date' },
      { type: 'heading_2', plainText: 'Next meeting' },
      { type: 'paragraph', plainText: 'Date and topics to carry over' },
    ],
  });
}

async function openPage(page, baseUrl, pageId) {
  await page.goto(resolveUrl(baseUrl, `/p/${encodeURIComponent(pageId)}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator('body').waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    (expected) => {
      const titleElement = document.querySelector('[role="textbox"][aria-label="Page title"]');
      const text = titleElement instanceof HTMLElement ? titleElement.innerText : titleElement?.textContent;
      return text?.trim() === expected;
    },
    title,
    { timeout: options.timeoutMs },
  );
}

async function expectPageStarterHidden(page) {
  await page.getByRole('group', { name: 'Page starter', exact: true }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  });
}

async function expectTemplateContentVisible(page, texts) {
  for (const text of texts) {
    await page.getByText(text, { exact: true }).first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
}

async function expectSidebarPageVisible(page, title) {
  const privateTree = page.getByRole('tree', { name: 'Pages' });
  await privateTree.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await privateTree.getByText(title, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function waitForPersistedTemplate(baseUrl, token, pageId, expected) {
  const deadline = Date.now() + options.timeoutMs;
  let latest = null;
  let latestReason = 'not checked yet';

  while (Date.now() < deadline) {
    const [pageResult, blockResult] = await Promise.all([
      callFunction(baseUrl, token, 'page-query', { action: 'page', pageId }),
      callFunction(baseUrl, token, 'page-query', { action: 'blocks', pageId }),
    ]);
    const page = pageResult?.page;
    const blocks = Array.isArray(blockResult?.blocks) ? blockResult.blocks : [];
    latest = { page, blocks };

    const reason = persistedTemplateMismatch(latest, expected);
    if (!reason) return latest;
    latestReason = reason;
    await sleep(150);
  }

  throw new Error(`Persisted template state did not match: ${latestReason}; latest=${JSON.stringify(latest)}`);
}

function persistedTemplateMismatch(snapshot, expected) {
  const page = snapshot?.page;
  const blocks = snapshot?.blocks ?? [];
  if (!page) return 'missing page';
  if (page.title !== expected.title) return `title=${JSON.stringify(page.title)} expected ${JSON.stringify(expected.title)}`;
  if (expected.icon && page.icon !== expected.icon) return `icon=${JSON.stringify(page.icon)} expected ${JSON.stringify(expected.icon)}`;

  const blockIds = new Set(blocks.map((block) => block.id));
  for (const missingBlockId of expected.missingBlockIds ?? []) {
    if (blockIds.has(missingBlockId)) return `placeholder block ${missingBlockId} should have been removed`;
  }

  const expectedBlocks = expected.blocks ?? [];
  if (blocks.length < expectedBlocks.length) return `only ${blocks.length} blocks persisted, expected at least ${expectedBlocks.length}`;
  for (let index = 0; index < expectedBlocks.length; index += 1) {
    const actual = blocks[index];
    const want = expectedBlocks[index];
    if (!actual) return `missing block ${index}`;
    if (actual.type !== want.type) return `block ${index} type=${actual.type} expected ${want.type}`;
    if ((actual.plainText ?? '') !== want.plainText) {
      return `block ${index} text=${JSON.stringify(actual.plainText ?? '')} expected ${JSON.stringify(want.plainText)}`;
    }
  }
  return '';
}

async function seedTemplateRuntime(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for page template UI smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const placeholderBlockId = randomUUID();
  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: 'Untitled',
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'page template UI smoke page must be created');

  const placeholder = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: placeholderBlockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [] },
    plainText: '',
    position: 1,
  });
  assert(placeholder?.block?.id === placeholderBlockId, 'page template UI smoke placeholder block must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageId,
    placeholderBlockId,
    createdPageId: '',
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  for (const id of [seed.createdPageId, seed.pageId]) {
    if (!id) continue;
    await permanentlyDeletePage(baseUrl, seed.accessToken, id).catch(() => {});
  }
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
  console.log(`Usage: node scripts/page-template-ui-smoke.mjs [options]

Checks page-template application through the product UI without screenshots:
an existing blank page adopts the template title/icon/blocks, and the sidebar
Templates gallery creates a new persisted page.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser while running.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
