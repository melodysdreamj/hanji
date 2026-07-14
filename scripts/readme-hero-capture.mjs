#!/usr/bin/env node

// Regenerates the README product hero from the live app. The script creates a
// temporary anonymous workspace with synthetic data, captures the real Hanji
// UI, and removes the account again through the shared smoke harness.
//
//   output: assets/screenshots/hanji-product-hero.png
//   run:    node scripts/readme-hero-capture.mjs

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  finalizeRegisteredSmokeAccounts,
  installBrowserSession,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  signIn,
  waitForStableRoute,
} from './lib/harness.mjs';

const BASE_URL = normalizeBaseUrl(process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787');
const OUTPUT_PATH = new URL('../assets/screenshots/hanji-product-hero.png', import.meta.url).pathname;
const FAILURE_DIR = new URL('../.edgebase/ui-discovery/readme-hero/', import.meta.url).pathname;
const FAILURE_PATH = `${FAILURE_DIR}failure.png`;
const TIMEOUT_MS = 30_000;

try {
  await main();
} catch (error) {
  console.error(`\nFAIL README hero capture: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main() {
  await assertRuntimeReachable(BASE_URL);
  mkdirSync(new URL('../assets/screenshots/', import.meta.url).pathname, { recursive: true });

  let browser;
  let runError;
  try {
    const seed = await seedShowcase(BASE_URL);
    const { chromium } = await loadPlaywright({ label: 'README product hero capture' });
    browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
    await captureHero(browser, seed);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    const cleanup = await finalizeRegisteredSmokeAccounts('README product hero capture');
    if (!runError && cleanup.cleanupError) throw cleanup.cleanupError;
  }

  console.log(`saved ${OUTPUT_PATH}`);
  console.log('PASS README product hero regenerated from a temporary synthetic Hanji workspace.');
}

async function seedShowcase(baseUrl) {
  const session = await signIn(baseUrl);
  const collaboratorOne = await signIn(baseUrl);
  const collaboratorTwo = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for the README hero');

  await callFunction(baseUrl, session.accessToken, 'workspace-mutation', {
    action: 'update',
    workspaceId,
    patch: { name: 'Hanji Demo', icon: '/icon-192.png' },
  });

  const starterWelcomePage = bootstrap?.pages?.find((item) => item?.title === 'Welcome to Hanji!');
  assert(starterWelcomePage?.id, 'README hero bootstrap must include the starter welcome page');
  const handbook = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'update',
    id: starterWelcomePage.id,
    patch: {
      title: 'Hanji handbook',
      icon: '/icon-192.png',
      iconType: 'image',
    },
  });
  assert(handbook?.page?.title === 'Hanji handbook', 'README hero starter page must become the Hanji handbook');

  await callFunction(baseUrl, session.accessToken, 'workspace-mutation', {
    action: 'updateMyProfile',
    workspaceId,
    displayName: 'Alex Demo',
    email: 'alex@example.com',
  });
  for (const collaborator of [
    { session: collaboratorOne, displayName: 'Mina Demo', email: 'mina@example.com' },
    { session: collaboratorTwo, displayName: 'Noah Demo', email: 'noah@example.com' },
  ]) {
    const invited = await callFunction(baseUrl, session.accessToken, 'workspace-mutation', {
      action: 'inviteMember',
      workspaceId,
      userId: collaborator.session.userId,
      email: collaborator.email,
      role: 'member',
    });
    assert(invited?.member?.id, `README hero member ${collaborator.displayName} must be invited`);
    const profile = await callFunction(baseUrl, collaborator.session.accessToken, 'workspace-mutation', {
      action: 'updateMyProfile',
      workspaceId,
      displayName: collaborator.displayName,
      email: collaborator.email,
    });
    assert(profile?.member?.displayName === collaborator.displayName, `README hero member ${collaborator.displayName} must have a profile`);
  }

  const position = Date.now();
  const pageId = randomUUID();
  const introBlockId = randomUUID();
  const inlineBlockId = randomUUID();
  const pageTitle = 'Welcome to Hanji';
  const databaseTitle = 'Getting started';
  const introText = 'Your workspace is ready — build pages, databases, files, and team workflows on infrastructure you control.';
  const page = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: pageTitle,
    icon: '/icon-192.png',
    iconType: 'image',
    fullWidth: true,
    position,
  });
  assert(page?.page?.id === pageId, 'README hero launch page must be created');

  const sidebarPrivatePages = [
    {
      id: randomUUID(),
      title: 'Import from Notion',
      icon: '📥',
      summary: 'Bring pages, databases, relations, files, and views into Hanji.',
      position: position + 10,
    },
    {
      id: randomUUID(),
      title: 'MCP & automations',
      icon: '🔌',
      summary: 'Connect agents and tools through Hanji\'s unrestricted MCP server.',
      position: position + 20,
    },
    {
      id: randomUUID(),
      title: 'Docker & self-hosting',
      icon: '🐳',
      summary: 'Run Hanji on your own machine or NAS and keep all data in /data.',
      position: position + 30,
    },
  ];
  const sidebarSharedPages = [
    {
      id: randomUUID(),
      title: 'Product roadmap',
      icon: '🗺️',
      summary: 'Shared product direction, milestones, and upcoming work.',
      position: position + 40,
    },
    {
      id: randomUUID(),
      title: 'Release notes',
      icon: '📣',
      summary: 'What shipped, what changed, and what comes next.',
      position: position + 50,
    },
  ];
  for (const sidebarPage of [...sidebarPrivatePages, ...sidebarSharedPages]) {
    const createdSidebarPage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'create',
      id: sidebarPage.id,
      workspaceId,
      parentId: null,
      parentType: 'workspace',
      kind: 'page',
      title: sidebarPage.title,
      icon: sidebarPage.icon,
      iconType: 'emoji',
      position: sidebarPage.position,
    });
    assert(createdSidebarPage?.page?.id === sidebarPage.id, `README hero sidebar page "${sidebarPage.title}" must be created`);
    const summaryBlock = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
      action: 'create',
      id: randomUUID(),
      pageId: sidebarPage.id,
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: sidebarPage.summary }] },
      plainText: sidebarPage.summary,
      position: 1,
    });
    assert(summaryBlock?.block?.id, `README hero sidebar page "${sidebarPage.title}" must have example content`);
  }

  const projectDatabaseId = randomUUID();
  const projectTitlePropertyId = randomUUID();
  const projectStagePropertyId = randomUUID();
  const projectRows = [
    { id: randomUUID(), title: 'Workspace setup', stage: 'ready' },
    { id: randomUUID(), title: 'Migration', stage: 'ready' },
    { id: randomUUID(), title: 'Collaboration', stage: 'building' },
    { id: randomUUID(), title: 'Agent workflows', stage: 'planned' },
  ];

  const projectDatabase = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: projectDatabaseId,
    workspaceId,
    parentId: pageId,
    parentType: 'page',
    title: 'Projects',
    position: position - 1,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: projectTitlePropertyId, name: 'Project', type: 'title', position: 1 },
      {
        id: projectStagePropertyId,
        name: 'Stage',
        type: 'status',
        position: 2,
        options: [
          { id: 'planned', name: 'Planned', color: 'gray' },
          { id: 'building', name: 'Building', color: 'blue' },
          { id: 'ready', name: 'Ready', color: 'green' },
        ],
      },
    ],
  });
  assert(projectDatabase?.page?.id === projectDatabaseId, 'README hero project database must be created');

  for (const row of projectRows) {
    const created = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
      action: 'create',
      id: row.id,
      databaseId: projectDatabaseId,
      title: row.title,
      properties: { [projectStagePropertyId]: row.stage },
    });
    assert(created?.row?.id === row.id, `README hero project row "${row.title}" must be created`);
  }

  const databaseId = randomUUID();
  const propertyIds = {
    title: randomUUID(),
    status: randomUUID(),
    due: randomUUID(),
    project: randomUUID(),
    projectStage: randomUUID(),
    files: randomUUID(),
  };
  const visibleProperties = Object.values(propertyIds);
  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: pageId,
    parentType: 'page',
    title: databaseTitle,
    position,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: propertyIds.title, name: 'Task', type: 'title', position: 1 },
      {
        id: propertyIds.status,
        name: 'Status',
        type: 'status',
        position: 2,
        options: [
          { id: 'planned', name: 'Planned', color: 'gray' },
          { id: 'doing', name: 'In progress', color: 'blue' },
          { id: 'review', name: 'Review', color: 'yellow' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      { id: propertyIds.due, name: 'Due', type: 'date', position: 3 },
      {
        id: propertyIds.project,
        name: 'Project',
        type: 'relation',
        position: 4,
        config: { relationDatabaseId: projectDatabaseId },
      },
      { id: propertyIds.files, name: 'Files', type: 'files', position: 6 },
    ],
  });
  assert(created?.page?.id === databaseId, 'README hero product database must be created');

  const rollup = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: propertyIds.projectStage,
      databaseId,
      name: 'Project stage',
      type: 'rollup',
      position: 5,
      config: {
        rollupRelationPropertyId: propertyIds.project,
        rollupTargetPropertyId: projectStagePropertyId,
        rollupFunction: 'show_original',
      },
    },
  });
  assert(rollup?.record?.id === propertyIds.projectStage, 'README hero rollup property must be created');

  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'README hero product database must include a table view');
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    databaseId,
    patch: {
      name: 'Overview',
      position: 1,
      config: {
        propertyOrder: visibleProperties,
        visibleProperties,
        propertyWidths: {
          [propertyIds.title]: 240,
          [propertyIds.status]: 130,
          [propertyIds.due]: 110,
          [propertyIds.project]: 170,
          [propertyIds.projectStage]: 140,
          [propertyIds.files]: 220,
        },
      },
    },
  });

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: randomUUID(),
        databaseId,
        name: 'Board',
        type: 'board',
        position: 2,
        config: { groupBy: propertyIds.status, visibleProperties, cardSize: 'medium' },
      },
      {
        id: randomUUID(),
        databaseId,
        name: 'List',
        type: 'list',
        position: 3,
        config: { visibleProperties },
      },
      {
        id: randomUUID(),
        databaseId,
        name: 'Gallery',
        type: 'gallery',
        position: 4,
        config: { visibleProperties, cardSize: 'medium' },
      },
      {
        id: randomUUID(),
        databaseId,
        name: 'Calendar',
        type: 'calendar',
        position: 5,
        config: { calendarBy: propertyIds.due, visibleProperties },
      },
      {
        id: randomUUID(),
        databaseId,
        name: 'Timeline',
        type: 'timeline',
        position: 6,
        config: { timelineBy: propertyIds.due, timelineZoom: 'month', visibleProperties },
      },
    ],
  });

  const rows = [
    {
      title: 'Create your first page',
      status: 'done',
      due: '2026-07-18',
      project: projectRows[0].id,
      file: 'welcome-guide.pdf',
    },
    {
      title: 'Import a Notion workspace',
      status: 'review',
      due: '2026-07-22',
      project: projectRows[1].id,
      file: 'import-checklist.pdf',
    },
    {
      title: 'Invite your team',
      status: 'doing',
      due: '2026-07-25',
      project: projectRows[2].id,
      file: 'access-matrix.xlsx',
    },
    {
      title: 'Connect an MCP client',
      status: 'planned',
      due: '2026-07-29',
      project: projectRows[3].id,
      file: 'mcp-setup.md',
    },
    {
      title: 'Publish and share',
      status: 'planned',
      due: '2026-08-01',
      project: projectRows[2].id,
      file: 'sharing-guide.pdf',
    },
  ];

  for (const row of rows) {
    const rowId = randomUUID();
    const inserted = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
      action: 'create',
      id: rowId,
      databaseId,
      title: row.title,
      properties: {
        [propertyIds.status]: row.status,
        [propertyIds.due]: row.due,
        [propertyIds.project]: [row.project],
        [propertyIds.files]: [
          {
            id: randomUUID(),
            name: row.file,
            url: `https://example.com/hanji-demo/${encodeURIComponent(row.file)}`,
          },
        ],
      },
    });
    assert(inserted?.row?.id === rowId, `README hero task "${row.title}" must be created`);
  }

  const blocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: introBlockId,
        pageId,
        parentId: null,
        type: 'callout',
        content: {
          icon: '✨',
          rich: [
            { text: 'Your workspace is ready', bold: true },
            { text: ' — build pages, databases, files, and team workflows on infrastructure you control.' },
          ],
        },
        plainText: introText,
        position: 1,
      },
      {
        id: inlineBlockId,
        pageId,
        parentId: null,
        type: 'inline_database',
        content: { childPageId: databaseId, databaseViewId: tableViewId },
        plainText: databaseTitle,
        position: 2,
      },
    ],
  });
  assert(Array.isArray(blocks?.blocks) && blocks.blocks.length === 2, 'README hero page blocks must be created');

  for (const collaborator of [
    { member: collaboratorOne, label: 'Mina Demo', role: 'edit' },
    { member: collaboratorTwo, label: 'Noah Demo', role: 'comment' },
  ]) {
    const shared = await callFunction(baseUrl, session.accessToken, 'share-mutation', {
      action: 'invite',
      pageId,
      principalType: 'user',
      principalId: collaborator.member.userId,
      label: collaborator.label,
      role: collaborator.role,
    });
    assert(shared?.permission?.id, `README hero page must be shared with ${collaborator.label}`);
  }
  for (const [index, sidebarPage] of sidebarSharedPages.entries()) {
    const collaborator = index === 0 ? collaboratorOne : collaboratorTwo;
    const shared = await callFunction(baseUrl, session.accessToken, 'share-mutation', {
      action: 'invite',
      pageId: sidebarPage.id,
      principalType: 'user',
      principalId: collaborator.userId,
      label: index === 0 ? 'Mina Demo' : 'Noah Demo',
      role: index === 0 ? 'edit' : 'comment',
    });
    assert(shared?.permission?.id, `README hero sidebar page "${sidebarPage.title}" must be shared`);
  }
  const published = await callFunction(baseUrl, session.accessToken, 'share-mutation', {
    action: 'setWebSharing',
    pageId,
    enabled: true,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert(published?.shareLink?.token, 'README hero page must have a live synthetic share link');

  const commentSeeds = [
    { author: collaboratorOne, text: 'Migration notes are ready for review.' },
    { author: collaboratorTwo, text: 'I attached the access matrix for the team.' },
    { author: collaboratorOne, text: 'The project-stage rollup looks good.' },
  ];
  for (const commentSeed of commentSeeds) {
    const commentId = randomUUID();
    const comment = await callFunction(baseUrl, commentSeed.author.accessToken, 'comment-mutation', {
      action: 'create',
      id: commentId,
      pageId,
      blockId: null,
      parentId: null,
      body: {
        rich: [
          { text: 'Alex', mention: 'person', userId: session.userId },
          { text: ` — ${commentSeed.text}` },
        ],
      },
      resolved: false,
    });
    assert(comment?.comment?.id === commentId, 'README hero team comment must be created');
  }
  await waitForUnreadNotifications(baseUrl, session.accessToken, workspaceId, commentSeeds.length);

  return {
    ...session,
    workspaceId,
    pageId,
    pageTitle,
    introBlockId,
    introText,
    inlineBlockId,
    databaseId,
    databaseTitle,
    expectedCommentCount: commentSeeds.length,
    expectedRows: rows.map((row) => row.title),
    expectedFiles: rows.map((row) => row.file),
    expectedRollups: [...new Set(projectRows.map((row) => row.stage))],
    sidebarPrivateTitles: ['Hanji handbook', ...sidebarPrivatePages.map((sidebarPage) => sidebarPage.title)],
    sidebarSharedTitles: sidebarSharedPages.map((sidebarPage) => sidebarPage.title),
    collaborators: [
      { ...collaboratorOne, workspaceId },
      { ...collaboratorTwo, workspaceId },
    ],
  };
}

async function captureHero(browser, seed) {
  const ownerBrowser = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 820 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const collaboratorBrowsers = await Promise.all(seed.collaborators.map(() => newCheckedPage(browser, {
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })));
  await installBrowserSession(ownerBrowser.context, seed, {
    appOrigin: BASE_URL,
    authOrigin: BASE_URL,
    workspaceId: seed.workspaceId,
    localStorage: {
      'hanji:theme': 'light',
      'hanji:language': 'en',
    },
  });
  await Promise.all(collaboratorBrowsers.map((browserPage, index) => installBrowserSession(
    browserPage.context,
    seed.collaborators[index],
    {
      appOrigin: BASE_URL,
      authOrigin: BASE_URL,
      workspaceId: seed.workspaceId,
      localStorage: {
        'hanji:theme': 'light',
        'hanji:language': 'en',
      },
    },
  )));

  try {
    await Promise.all(collaboratorBrowsers.map(({ page }) => openSharedHeroPage(page, seed)));
    const page = ownerBrowser.page;
    await openSharedHeroPage(page, seed);
    await page.locator('button[aria-label="Open workspace menu"]').waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    await page.getByText(seed.pageTitle, { exact: true }).first().waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    await page.getByText(seed.introText, { exact: true }).waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await page.locator(`[data-block-id="${seed.inlineBlockId}"]`).waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await page.waitForFunction(
      (expectedTitles) => {
        const values = Array.from(
          document.querySelectorAll('[data-table-cell] input[type="text"]'),
          (input) => input instanceof HTMLInputElement ? input.value : '',
        );
        return expectedTitles.every((title) => values.includes(title));
      },
      seed.expectedRows,
      { timeout: TIMEOUT_MS },
    );
    await page.waitForFunction(
      (expectedFiles) => expectedFiles.every((name) => document.body.innerText.includes(name)),
      seed.expectedFiles,
      { timeout: TIMEOUT_MS },
    );
    await page.waitForFunction(
      (expectedRollups) => expectedRollups.every((value) => document.body.innerText.toLowerCase().includes(value)),
      seed.expectedRollups,
      { timeout: TIMEOUT_MS },
    );
    const groupHeaderCount = await page.locator('[class*="tableGroupHeader"]').count();
    assert(groupHeaderCount === 0, `README hero should use an ungrouped table, found ${groupHeaderCount} group headers`);
    await page.locator('[data-table-cell]').first().waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await page.locator('[data-testid="topbar-page-presence"]').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await page.waitForFunction(
      (expectedCount) => document.querySelector('[data-testid="topbar-page-presence"]')?.getAttribute('aria-label')?.startsWith(`${expectedCount} connected`) === true,
      seed.collaborators.length + 1,
      { timeout: TIMEOUT_MS },
    );
    await page.locator('[data-topbar-comment-label]').getByText(`Comment ${seed.expectedCommentCount}`, { exact: true }).waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    await page.locator('[data-sidebar-rail-slot="inbox"][data-unread="true"]').waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    await page.locator('[data-sidebar-rail-slot="home"][data-active="true"]').waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    const sidebar = page.locator('[aria-label="Sidebar"]');
    for (const title of [...seed.sidebarPrivateTitles, ...seed.sidebarSharedTitles]) {
      await sidebar.getByText(title, { exact: true }).waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await page.screenshot({ path: OUTPUT_PATH, fullPage: false });
    assertNoBrowserErrors(ownerBrowser.errors, 'README product hero capture');
    collaboratorBrowsers.forEach((browserPage, index) => {
      assertNoBrowserErrors(browserPage.errors, `README product hero collaborator ${index + 1}`);
    });
  } catch (error) {
    mkdirSync(FAILURE_DIR, { recursive: true });
    await ownerBrowser.page.screenshot({ path: FAILURE_PATH, fullPage: false }).catch(() => {});
    const bodyText = await ownerBrowser.page.locator('body').innerText().catch(() => '');
    console.error(`README hero failure screenshot: ${FAILURE_PATH}`);
    console.error(`README hero visible text:\n${bodyText.slice(0, 4_000)}`);
    throw error;
  } finally {
    await Promise.all([
      ownerBrowser.context.close().catch(() => {}),
      ...collaboratorBrowsers.map(({ context }) => context.close().catch(() => {})),
    ]);
  }
}

async function openSharedHeroPage(page, seed) {
  await page.goto(resolveUrl(BASE_URL, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT_MS,
  });
  await waitForStableRoute(page, { timeoutMs: TIMEOUT_MS });
  await page.getByText(seed.pageTitle, { exact: true }).first().waitFor({ state: 'visible', timeout: TIMEOUT_MS });
}

async function waitForUnreadNotifications(baseUrl, accessToken, workspaceId, expectedCount) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const result = await callFunction(baseUrl, accessToken, 'notification-mutation', {
      action: 'list',
      workspaceId,
      includeRead: false,
      limit: 20,
    });
    lastCount = result?.unreadCount ?? 0;
    if (lastCount >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`README hero expected at least ${expectedCount} unread notifications, saw ${lastCount}`);
}
