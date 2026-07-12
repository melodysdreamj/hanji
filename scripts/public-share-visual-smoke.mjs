#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'public-share');
const PAGE_TITLE_SELECTOR = '[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL public share visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Public share visual smoke target: ${appUrl}${apiUrl === appUrl ? '' : ` (API: ${apiUrl})`}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedPublicShare(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureSharedVariant(browser, appUrl, seed, {
      prefix: 'desktop-shared-root',
      viewport: { width: 1440, height: 1000 },
      pageId: seed.rootPageId,
      contract: {
        title: seed.rootTitle,
        expectedVisibleTexts: [seed.rootTitle, seed.rootParagraph, seed.rootHeading],
        minBlocks: 2,
      },
    });
    await captureSharedVariant(browser, appUrl, seed, {
      prefix: 'desktop-shared-child',
      viewport: { width: 1440, height: 1000 },
      pageId: seed.childPageId,
      contract: {
        title: seed.childTitle,
        expectedVisibleTexts: [seed.childTitle, seed.childParagraph],
        minBlocks: 1,
      },
    });
    await captureSharedVariant(browser, appUrl, seed, {
      prefix: 'desktop-shared-database',
      viewport: { width: 1440, height: 1000 },
      shareToken: seed.databaseShareToken,
      pageId: seed.databaseId,
      contract: {
        title: seed.databaseTitle,
        expectedVisibleTexts: [
          seed.databaseTitle,
          'Public table',
          seed.firstRowTitle,
          seed.secondRowTitle,
          'Status',
          'Exam date',
          'Attachment',
          seed.fileName,
          seed.firstRowDateText,
        ],
        minBlocks: 0,
        database: true,
        fileLinkText: seed.fileName,
        fileLinkHref: seed.fileUrl,
      },
    });
    await captureSharedVariant(browser, appUrl, seed, {
      prefix: 'desktop-shared-row',
      viewport: { width: 1440, height: 1000 },
      shareToken: seed.databaseShareToken,
      pageId: seed.firstRowId,
      contract: {
        title: seed.firstRowTitle,
        expectedVisibleTexts: [seed.firstRowTitle, 'Status', 'Attachment', seed.fileName],
        minBlocks: 0,
        compactTopGutter: true,
        rowPage: true,
        minReadonlyProperties: 3,
        fileLinkText: seed.fileName,
        fileLinkHref: seed.fileUrl,
      },
    });
    await captureSharedVariant(browser, appUrl, seed, {
      prefix: 'mobile-shared-root',
      viewport: { width: 390, height: 844 },
      mobile: true,
      pageId: seed.rootPageId,
      contract: {
        title: seed.rootTitle,
        expectedVisibleTexts: [seed.rootTitle, seed.rootParagraph, seed.rootHeading],
        minBlocks: 2,
      },
    });

    console.log('PASS public shared pages are captured and stay within the Notion-style read-only layout contract.');
    for (const name of [
      'desktop-shared-root',
      'desktop-shared-child',
      'desktop-shared-database',
      'desktop-shared-row',
      'mobile-shared-root',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await cleanupSeed(apiUrl, seed).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureSharedVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });

  try {
    await openSharedPage(page, appUrl, variant.shareToken ?? seed.shareToken, variant.pageId);
    await assertSharedPageContract(page, variant.contract, {
      mobile: !!variant.mobile,
      prefix: variant.prefix,
    });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} public share visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openSharedPage(page, baseUrl, shareToken, pageId) {
  const path = pageId
    ? `/share/${encodeURIComponent(shareToken)}?page=${encodeURIComponent(pageId)}`
    : `/share/${encodeURIComponent(shareToken)}`;
  await page.goto(resolveUrl(baseUrl, path), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator(PAGE_TITLE_SELECTOR).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction((selector) => {
    const titleElement = document.querySelector(selector);
    return titleElement instanceof HTMLElement && titleElement.getAttribute('aria-readonly') === 'true';
  }, PAGE_TITLE_SELECTOR, { timeout: options.timeoutMs });
}

async function assertSharedPageContract(page, contract, variant) {
  const expectedVisibleTexts = contract.expectedVisibleTexts ?? [];
  if (expectedVisibleTexts.length > 0) {
    await page.waitForFunction(
      (texts) => texts.every((text) => document.body.innerText.includes(text)),
      expectedVisibleTexts,
      { timeout: options.timeoutMs },
    );
  }
  const metrics = await page.evaluate(({ expectedVisibleTexts, fileLinkHref, fileLinkText, title, titleSelector }) => {
    const doc = document.querySelector('[data-page-search-root]');
    const titleElement = document.querySelector(titleSelector);
    if (!(doc instanceof HTMLElement)) return { ok: false, reason: 'missing shared document root' };
    if (!(titleElement instanceof HTMLElement)) return { ok: false, reason: 'missing shared page title' };
    const docRect = doc.getBoundingClientRect();
    const titleRect = titleElement.getBoundingClientRect();
    const titleText = titleElement.innerText?.trim() || titleElement.textContent?.trim() || '';
    const editableTextboxes = Array.from(document.querySelectorAll('[role="textbox"]')).filter(
      (element) =>
        element instanceof HTMLElement &&
        isVisible(element) &&
        element.getAttribute('aria-readonly') !== 'true',
    );
    const blocks = visibleElements(doc.querySelectorAll('[data-block-id]'));
    const topbar = document.querySelector('header');
    const forbiddenControls = ['Share', 'Comment', 'Add comment', 'Add cover', 'Add icon', 'New', 'New row', 'New database page', 'Choose database template'].filter((label) =>
      visibleElements(document.querySelectorAll('button, [role="button"], a')).some((element) => {
        const text = element.textContent?.trim() ?? '';
        const aria = element.getAttribute('aria-label') ?? '';
        return text === label || aria === label || aria.startsWith(`${label} `);
      }),
    );
    const readOnlyPlaceholderContents = visibleElements(
      document.querySelectorAll('[aria-readonly="true"][data-empty="true"][data-placeholder]'),
    )
      .map((element) => window.getComputedStyle(element, '::before').content)
      .filter((content) => content && content !== 'none' && content !== 'normal' && content !== '""');
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter((item) => !hasVisibleText(document.body, item));
    const fileLinks = fileLinkText
      ? visibleElements(document.querySelectorAll('a'))
          .filter((element) => hasVisibleText(element, fileLinkText))
          .map((element) => ({
            href: element.getAttribute('href') ?? '',
            text: element.textContent?.trim() ?? '',
          }))
      : [];
    const fileChipCount = fileLinkText
      ? visibleElements(document.querySelectorAll('[class*="fileChip"]')).filter((element) =>
          hasVisibleText(element, fileLinkText),
        ).length
      : 0;
    const tableScroll = visibleElements(doc.querySelectorAll('[class*="tableScroll"]'))[0];
    const firstHeadCell = visibleElements(doc.querySelectorAll('[class*="headCell"]'))[0];
    const tableScrollRect = tableScroll instanceof HTMLElement ? tableScroll.getBoundingClientRect() : undefined;
    const firstHeadRect = firstHeadCell instanceof HTMLElement ? firstHeadCell.getBoundingClientRect() : undefined;
    const visibleTableEditControls = visibleElements(document.querySelectorAll([
      '[data-table-new-row]',
      'button[aria-label="Add a property"]',
      'button[aria-label="New database page"]',
      'button[aria-label="새 데이터베이스 페이지"]',
      'button[aria-label="Choose database template"]',
      '[data-row-gutter-cell]',
    ].join(','))).map((element) => ({
      aria: element.getAttribute('aria-label') ?? '',
      text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
    const editableTableCells = visibleElements(document.querySelectorAll('[data-table-cell] input, [data-table-cell] textarea'));
    const rowPropertyMenuButtons = visibleElements(
      document.querySelectorAll('[data-row-property-id] button[aria-haspopup="menu"]'),
    ).map((element) => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '');
    const readonlyRowPropertyLabels = visibleElements(
      document.querySelectorAll('[data-row-property-id] [data-readonly="true"]'),
    ).length;
    return {
      ok: true,
      blockCount: blocks.length,
      bodyScrollWidth: document.body.scrollWidth,
      databaseVisible: hasVisibleText(document.body, 'Public table'),
      docLeft: docRect.left,
      docRightGap: window.innerWidth - docRect.right,
      docTop: docRect.top,
      docWidth: docRect.width,
      documentScrollWidth: document.documentElement.scrollWidth,
      editableTextboxCount: editableTextboxes.length,
      forbiddenControls,
      fileChipCount,
      fileLinks,
      firstTableHeadLeft: firstHeadRect?.left ?? null,
      missingVisibleExpectedTexts,
      readOnlyPlaceholderContents,
      rowPropertyMenuButtons,
      readonlyRowPropertyLabels,
      tableScrollLeft: tableScrollRect?.left ?? null,
      editableTableCellCount: editableTableCells.length,
      titleFontSize: Number.parseFloat(window.getComputedStyle(titleElement).fontSize),
      titleLeft: titleRect.left,
      titleMatches: titleText === title,
      titleText,
      titleTop: titleRect.top,
      topbarHeight: topbar instanceof HTMLElement ? topbar.getBoundingClientRect().height : 0,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      visibleTableEditControls,
    };

    function visibleElements(items) {
      return Array.from(items).filter(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function hasVisibleText(root, expected) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(expected)) continue;
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement) || !isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        range.detach();
        if (rects.some((rect) => (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        ))) {
          return true;
        }
      }
      return false;
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, {
    expectedVisibleTexts: contract.expectedVisibleTexts ?? [],
    fileLinkHref: contract.fileLinkHref ?? '',
    fileLinkText: contract.fileLinkText ?? '',
    title: contract.title,
    titleSelector: PAGE_TITLE_SELECTOR,
  });

  assert(metrics.ok, metrics.reason ?? `${variant.prefix} shared page contract could not run`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${variant.prefix} should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.titleMatches, `${variant.prefix} shared title text drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.titleFontSize >= (variant.mobile ? 34 : 38) && metrics.titleFontSize <= 54, `${variant.prefix} shared title should stay page-title scale: ${JSON.stringify(metrics)}`);
  assert(metrics.titleTop - metrics.topbarHeight >= (contract.compactTopGutter ? 42 : variant.mobile ? 42 : 70), `${variant.prefix} shared title should keep document top gutter: ${JSON.stringify(metrics)}`);
  assert(metrics.titleLeft - metrics.docLeft >= (variant.mobile ? 20 : 52), `${variant.prefix} shared title should align to document gutter: ${JSON.stringify(metrics)}`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${variant.prefix} has expected text outside the visible screenshot: ${JSON.stringify(metrics)}`);
  assert(metrics.editableTextboxCount === 0, `${variant.prefix} public share should remain read-only: ${JSON.stringify(metrics)}`);
  assert(metrics.readOnlyPlaceholderContents.length === 0, `${variant.prefix} public share should not render edit placeholders in read-only blocks: ${JSON.stringify(metrics)}`);
  assert(metrics.forbiddenControls.length === 0, `${variant.prefix} public share should not expose signed-in edit/share controls: ${JSON.stringify(metrics)}`);
  if (contract.database) {
    assert(metrics.databaseVisible, `${variant.prefix} shared database body should be visible: ${JSON.stringify(metrics)}`);
    assert(metrics.visibleTableEditControls.length === 0, `${variant.prefix} shared database should not expose table edit controls: ${JSON.stringify(metrics)}`);
    assert(metrics.editableTableCellCount === 0, `${variant.prefix} shared database cells should render as read-only values: ${JSON.stringify(metrics)}`);
    assert(
      metrics.tableScrollLeft !== null &&
        metrics.firstTableHeadLeft !== null &&
        metrics.tableScrollLeft >= metrics.titleLeft - 12 &&
        metrics.firstTableHeadLeft >= metrics.titleLeft - 12,
      `${variant.prefix} shared database table should not drift left of the document content axis: ${JSON.stringify(metrics)}`,
    );
  }
  if (contract.rowPage) {
    assert(metrics.rowPropertyMenuButtons.length === 0, `${variant.prefix} shared row properties should not expose property menus: ${JSON.stringify(metrics)}`);
    assert(metrics.readonlyRowPropertyLabels >= contract.minReadonlyProperties, `${variant.prefix} shared row properties should render read-only labels: ${JSON.stringify(metrics)}`);
  }
  if (!contract.database && !contract.rowPage) {
    assert(metrics.blockCount >= contract.minBlocks, `${variant.prefix} shared page block count drifted: ${JSON.stringify(metrics)}`);
  }
  if (contract.fileLinkText) {
    assert(metrics.fileChipCount > 0, `${variant.prefix} shared files should render as Hanji file chips: ${JSON.stringify(metrics)}`);
    assert(metrics.fileLinks.some((link) => link.href === contract.fileLinkHref), `${variant.prefix} shared files should be clickable links: ${JSON.stringify(metrics)}`);
  }
}

async function seedPublicShare(baseUrl) {
  const owner = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for public share visual smoke');

  const suffix = Date.now();
  const rootPageId = randomUUID();
  const childPageId = randomUUID();
  const databaseId = randomUUID();
  const firstRowId = randomUUID();
  const secondRowId = randomUUID();
  const titlePropertyId = randomUUID();
  const statusPropertyId = randomUUID();
  const datePropertyId = randomUUID();
  const filePropertyId = randomUUID();
  const viewId = randomUUID();
  const rootTitle = `Shared visual page ${suffix}`;
  const childTitle = `Shared child visual ${suffix}`;
  const databaseTitle = `Shared tasks visual ${suffix}`;
  const rootHeading = 'Public roadmap';
  const rootParagraph = `This public share is read-only and should keep the Notion document rhythm ${suffix}.`;
  const childParagraph = `Child pages in the public share should open without exposing private workspace chrome ${suffix}.`;
  const firstRowTitle = `Public task ${suffix}`;
  const secondRowTitle = `Shared review ${suffix}`;
  const firstRowDateText = 'Dec 9, 2025 10:30 AM → 12:00 PM';
  const fileName = `public-brief-${suffix}.pdf`;
  const fileUrl = `https://example.com/downloads/${fileName}`;

  const root = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: rootPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: rootTitle,
    icon: '🌐',
    iconType: 'emoji',
    position: suffix,
  });
  assert(root?.page?.id === rootPageId, 'public share visual root page must be created');

  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: randomUUID(),
    pageId: rootPageId,
    parentId: null,
    type: 'heading_2',
    content: { rich: [{ text: rootHeading }] },
    plainText: rootHeading,
    position: 1,
  });
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: randomUUID(),
    pageId: rootPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: rootParagraph }] },
    plainText: rootParagraph,
    position: 2,
  });
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: randomUUID(),
    pageId: rootPageId,
    parentId: null,
    type: 'callout',
    content: { rich: [], icon: '💡' },
    plainText: '',
    position: 3,
  });

  const child = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: childPageId,
    workspaceId,
    parentId: rootPageId,
    parentType: 'page',
    kind: 'page',
    title: childTitle,
    icon: '📄',
    iconType: 'emoji',
    position: suffix + 1,
  });
  assert(child?.page?.id === childPageId, 'public share visual child page must be created');
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: randomUUID(),
    pageId: childPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: childParagraph }] },
    plainText: childParagraph,
    position: 1,
  });

  const database = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: databaseId,
    workspaceId,
    parentId: rootPageId,
    parentType: 'page',
    kind: 'database',
    title: databaseTitle,
    icon: '📊',
    iconType: 'emoji',
    position: suffix + 2,
  });
  assert(database?.page?.id === databaseId, 'public share visual database must be created');

  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: titlePropertyId,
      databaseId,
      name: 'Name',
      type: 'title',
      position: 1,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: statusPropertyId,
      databaseId,
      name: 'Status',
      type: 'select',
      config: { options: [{ id: 'todo', name: 'To do', color: 'gray' }, { id: 'done', name: 'Done', color: 'green' }] },
      position: 2,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: datePropertyId,
      databaseId,
      name: 'Exam date',
      type: 'date',
      position: 3,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: filePropertyId,
      databaseId,
      name: 'Attachment',
      type: 'files',
      position: 4,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_views',
    record: {
      id: viewId,
      databaseId,
      name: 'Public table',
      type: 'table',
      config: { visibleProperties: [titlePropertyId, statusPropertyId, datePropertyId, filePropertyId] },
      position: 1,
    },
  });
  for (const [id, title, status, position] of [
    [firstRowId, firstRowTitle, 'To do', 1],
    [secondRowId, secondRowTitle, 'Done', 2],
  ]) {
    const row = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
      action: 'create',
      id,
      databaseId,
      title,
      properties: {
        [statusPropertyId]: status,
        ...(position === 1
          ? {
              [datePropertyId]: {
                start: '2025-12-09T10:30:00.000+09:00',
                end: '2025-12-09T12:00:00.000+09:00',
                time_zone: null,
              },
              [filePropertyId]: [{ id: randomUUID(), name: fileName, url: fileUrl, type: 'application/pdf' }],
            }
          : {}),
      },
      position,
    });
    assert(row?.row?.id === id, 'public share visual database row must be created');
  }

  const sharing = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: rootPageId,
    enabled: true,
    expiresAt: null,
  });
  const shareToken = sharing?.shareLink?.token;
  assert(shareToken, 'setWebSharing must return a public share token');

  const databaseSharing = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: databaseId,
    enabled: true,
    expiresAt: null,
  });
  const databaseShareToken = databaseSharing?.shareLink?.token;
  assert(databaseShareToken, 'setWebSharing must return a public share token for direct database visual checks');

  return {
    owner,
    workspaceId,
    rootPageId,
    childPageId,
    databaseId,
    firstRowId,
    secondRowId,
    shareToken,
    databaseShareToken,
    rootTitle,
    childTitle,
    databaseTitle,
    fileName,
    fileUrl,
    firstRowDateText,
    rootHeading,
    rootParagraph,
    childParagraph,
    firstRowTitle,
    secondRowTitle,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.owner?.token) return;
  for (const pageId of [seed.rootPageId].filter(Boolean)) {
    await permanentlyDeletePage(baseUrl, seed.owner.token, pageId, { call: callFunction }).catch(() => {});
  }
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
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
  const token = body?.accessToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'anonymous sign-in must return an access token');
  assert(typeof userId === 'string' && userId, 'anonymous sign-in must return a user id');
  return { token, userId };
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
    'Playwright is required for public share visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: null,
    headed: false,
    screenshotDir: DEFAULT_SCREENSHOT_DIR,
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
    if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(resolveValue(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms' || arg === '--timeout') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error(`Invalid timeout: ${args[i + 1]}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/public-share-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when different from the app URL
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}

function normalizeBaseUrl(url) {
  return String(url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
