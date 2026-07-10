#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BASE_URL,
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

const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database view tabs drag UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database view tabs drag UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedViewTabsDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertViewTabsDragUi(browser, baseUrl, seed);
    console.log('PASS database view tabs drag reorders full-page and inline linked tabs with persisted product API order.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertViewTabsDragUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded database', () => openDatabase(page, baseUrl, seed));
    await step('drag Timeline before Board', () =>
      dragViewTab(page, baseUrl, seed, 'timeline', 'board', 'before', ['table', 'timeline', 'board', 'list', 'calendar']));
    await step('drag Timeline after Calendar', () =>
      dragViewTab(page, baseUrl, seed, 'timeline', 'calendar', 'after', ['table', 'board', 'list', 'calendar', 'timeline']));
    await step('reload persisted view tab order', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await expectViewTabOrder(page, seed, ['table', 'board', 'list', 'calendar', 'timeline']);
      await waitForViewOrder(baseUrl, seed, ['table', 'board', 'list', 'calendar', 'timeline'], 'reloaded view tab order');
    });
    await step('open imported inline database with persisted order', async () => {
      await openInlineDatabasePage(page, baseUrl, seed);
      await expectViewTabOrder(page, seed, ['table', 'board']);
    });
    await step('drag Board before Table inside imported inline database', () =>
      dragViewTab(
        page,
        baseUrl,
        seed,
        'board',
        'table',
        'before',
        ['board', 'table'],
        ['board', 'table', 'list', 'calendar', 'timeline'],
        waitForInlineBlockViewOrder,
      ));
    await step('reload persisted imported inline database order', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await expectViewTabOrder(page, seed, ['board', 'table']);
      await waitForInlineBlockViewOrder(baseUrl, seed, ['board', 'table', 'list', 'calendar', 'timeline'], 'reloaded imported inline view tab order');
    });
    assertNoBrowserErrors(errors, 'database view tabs drag UI flow');
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

async function openDatabase(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tablist', { name: `${seed.databaseTitle} views` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectViewTabOrder(page, seed, ['table', 'board', 'list', 'calendar', 'timeline']);
  await waitForViewOrder(baseUrl, seed, ['table', 'board', 'list', 'calendar', 'timeline'], 'initial view tab order');
}

async function openInlineDatabasePage(page, baseUrl, seed) {
  await page.setViewportSize({ width: 1600, height: 929 });
  await page.goto(resolveUrl(baseUrl, `/p/${seed.inlinePageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tablist', { name: `${seed.databaseTitle} views` }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function dragViewTab(
  page,
  baseUrl,
  seed,
  sourceKey,
  targetKey,
  placement,
  expectedKeys,
  persistedKeys = expectedKeys,
  waitForPersistedOrder = waitForViewOrder,
) {
  const source = viewTabWrap(page, seed.viewIds[sourceKey]);
  const target = viewTabWrap(page, seed.viewIds[targetKey]);
  await source.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await target.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const targetBox = await target.boundingBox({ timeout: options.timeoutMs });
  assert(targetBox, `target view tab ${targetKey} must have a bounding box`);

  await source.dragTo(target, {
    targetPosition: {
      x: placement === 'before' ? 2 : Math.max(2, Math.round(targetBox.width - 2)),
      y: Math.max(2, Math.round(targetBox.height / 2)),
    },
    timeout: options.timeoutMs,
  });

  await expectViewTabOrder(page, seed, expectedKeys);
  await waitForPersistedOrder(baseUrl, seed, persistedKeys, `${placement} view tab order`);
}

function viewTabWrap(page, viewId) {
  return page.locator(`[data-view-tab="${viewId}"]`).locator('xpath=..').first();
}

async function expectViewTabOrder(page, seed, expectedKeys) {
  const expectedIds = expectedKeys.map((key) => seed.viewIds[key]);
  try {
    await page.waitForFunction(
      (ids) => {
        const tabIds = Array.from(document.querySelectorAll('[data-view-tab]'))
          .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
          .map((element) => element.getAttribute('data-view-tab'))
          .filter((id) => ids.includes(id));
        return JSON.stringify(tabIds) === JSON.stringify(ids);
      },
      expectedIds,
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const actual = await page.evaluate((ids) =>
      Array.from(document.querySelectorAll('[data-view-tab]'))
        .map((element) => ({
          id: element.getAttribute('data-view-tab'),
          text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          visible: element instanceof HTMLElement && element.offsetParent !== null,
          selected: element.getAttribute('aria-selected') === 'true',
          rect: element instanceof HTMLElement
            ? {
                x: Math.round(element.getBoundingClientRect().x),
                y: Math.round(element.getBoundingClientRect().y),
                width: Math.round(element.getBoundingClientRect().width),
                height: Math.round(element.getBoundingClientRect().height),
              }
            : null,
        }))
        .filter((item) => !item.id || ids.includes(item.id)),
      expectedIds,
    );
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; expected=${JSON.stringify(expectedIds)} actual=${JSON.stringify(actual)}`);
  }
}

async function waitForViewOrder(baseUrl, seed, expectedKeys, label) {
  const expectedIds = expectedKeys.map((key) => seed.viewIds[key]);
  const knownIds = new Set(Object.values(seed.viewIds));
  const startedAt = Date.now();
  let lastOrder = [];

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'database',
      databaseId: seed.databaseId,
    });
    const views = Array.isArray(result?.views) ? result.views : [];
    lastOrder = views.map((view) => view.id).filter((id) => knownIds.has(id));
    if (JSON.stringify(lastOrder) === JSON.stringify(expectedIds)) return views;
    await delay(250);
  }

  throw new Error(`${label} was not persisted; expected=${JSON.stringify(expectedIds)} last=${JSON.stringify(lastOrder)}`);
}

async function waitForInlineBlockViewOrder(baseUrl, seed, expectedKeys, label) {
  const expectedIds = expectedKeys.map((key) => seed.viewIds[key]);
  const knownIds = new Set(Object.values(seed.viewIds));
  const startedAt = Date.now();
  let lastOrder = [];

  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'blocks',
      pageId: seed.inlinePageId,
    });
    const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
    const block = blocks.find((item) => item?.id === seed.inlineBlockId);
    const content = block?.content && typeof block.content === 'object' ? block.content : {};
    lastOrder = Array.isArray(content.databaseViewIds)
      ? content.databaseViewIds.filter((id) => knownIds.has(id))
      : [];
    if (JSON.stringify(lastOrder) === JSON.stringify(expectedIds)) return block;
    await delay(250);
  }

  throw new Error(`${label} was not persisted on inline block; expected=${JSON.stringify(expectedIds)} last=${JSON.stringify(lastOrder)}`);
}

async function seedViewTabsDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database view tabs drag UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const inlinePageId = randomUUID();
  const inlineBlockId = randomUUID();
  const titlePropId = randomUUID();
  const statusPropId = randomUUID();
  const datePropId = randomUUID();
  const databaseTitle = `View tabs drag smoke ${suffix}`;
  const inlinePageTitle = `Inline view tabs drag smoke ${suffix}`;

  const page = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: inlinePageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: inlinePageTitle,
    position: suffix - 1,
  });
  assert(page?.page?.id === inlinePageId, 'database view tabs drag UI smoke inline page must be created');

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: databaseTitle,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: titlePropId, name: 'Name', type: 'title', position: 1 },
      {
        id: statusPropId,
        name: 'Status',
        type: 'status',
        position: 2,
        options: [
          { id: 'todo', name: 'Todo', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      { id: datePropId, name: 'Due', type: 'date', position: 3 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database view tabs drag UI smoke database must be created');

  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database view tabs drag UI smoke must receive a table view');
  const viewIds = {
    table: tableViewId,
    board: randomUUID(),
    list: randomUUID(),
    calendar: randomUUID(),
    timeline: randomUUID(),
  };
  const visibleProperties = [titlePropId, statusPropId, datePropId];
  const importedViewConfig = (key, index, config = {}) => ({
    ...config,
    notionViewId: `notion-view-${key}-${suffix}`,
    notion: {
      id: `notion-view-${key}-${suffix}`,
      created_time: `2026-01-0${index + 1}T00:00:00.000Z`,
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    databaseId,
    id: tableViewId,
    patch: {
      name: 'Table',
      position: 1,
      config: importedViewConfig('table', 0, { propertyOrder: visibleProperties, visibleProperties }),
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: viewIds.board,
        databaseId,
        name: 'Board',
        type: 'board',
        position: 2,
        config: importedViewConfig('board', 1, { groupBy: statusPropId, visibleProperties, cardSize: 'medium' }),
      },
      {
        id: viewIds.list,
        databaseId,
        name: 'List',
        type: 'list',
        position: 3,
        config: importedViewConfig('list', 2, { visibleProperties }),
      },
      {
        id: viewIds.calendar,
        databaseId,
        name: 'Calendar',
        type: 'calendar',
        position: 4,
        config: importedViewConfig('calendar', 3, { calendarBy: datePropId, visibleProperties }),
      },
      {
        id: viewIds.timeline,
        databaseId,
        name: 'Timeline',
        type: 'timeline',
        position: 5,
        config: importedViewConfig('timeline', 4, { timelineBy: datePropId, timelineZoom: 'day', visibleProperties }),
      },
    ],
  });

  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: inlineBlockId,
        pageId: inlinePageId,
        parentId: null,
        type: 'inline_database',
        content: { childPageId: databaseId },
        plainText: databaseTitle,
        position: 1,
      },
    ],
  });
  assert(createdBlocks?.blocks?.length === 1, 'database view tabs drag UI smoke inline block must be created');

  await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'update',
    pageId: inlinePageId,
    id: inlineBlockId,
    patch: {
      content: {
        childPageId: databaseId,
        linkedDatabaseSource: true,
        databaseViewId: tableViewId,
        databaseViewIds: [viewIds.table, viewIds.board, viewIds.list, viewIds.calendar, viewIds.timeline],
      },
    },
  });

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    databaseTitle,
    inlinePageId,
    inlineBlockId,
    viewIds,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  if (seed.inlinePageId) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id: seed.inlinePageId,
    }).catch(() => {});
  }
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.databaseId,
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
  console.log(`Usage: node scripts/database-view-tabs-drag-ui-smoke.mjs [options]

Checks database view tab drag reordering with DOM and product API persistence
assertions only.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser while running.
`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
