#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 30_000;
const NOTION_API_VERSION = '2026-03-11';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const LIVE_NOTION_TOKEN_ENV_NAMES = ['NOTION_TOKEN', 'HANJI_NOTION_TOKEN'];

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL live Notion import smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  const notionToken = liveNotionToken();
  if (!notionToken) {
    const message = `SKIP live Notion import smoke because ${LIVE_NOTION_TOKEN_ENV_NAMES.join(' or ')} is not configured.`;
    if (options.requireToken) throw new Error(message);
    console.log(message);
    return;
  }

  console.log(`Live Notion import smoke target: ${baseUrl}`);
  await assertRuntimeReachable(baseUrl);
  await assertSourceRootPageChrome(notionToken, options);
  const owner = await signIn(baseUrl);
  let workspaceId = '';
  let createdJobId = '';
  let discoveredItemCount = 0;
  let passMessage = '';
  let runError = null;

  try {
    const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
    const defaultWorkspaceId = bootstrap?.workspace?.id;
    assert(defaultWorkspaceId, 'workspace-bootstrap must return a workspace id');

    const workspaceName = `Live Notion import smoke ${Date.now()}`;
    const createdWorkspace = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'createWorkspace',
      name: workspaceName,
      icon: 'N',
    });
    workspaceId = createdWorkspace?.workspace?.id;
    assert(workspaceId, 'live Notion import smoke must create a temporary workspace');
    assert(workspaceId !== defaultWorkspaceId, 'live Notion import smoke must not run in the default workspace');

    if (options.preflight && options.rootNotionPageIds.length > 0) {
      const preflight = await callFunction(baseUrl, owner.token, 'notion-import', {
        action: 'preflight',
        workspaceId,
        connectionKind: 'manual_token',
        notionToken,
        rootNotionPageIds: options.rootNotionPageIds,
      });
      const summary = preflight?.preflight?.summary ?? {};
      const missingPermissions = Array.isArray(preflight?.preflight?.missingPermissions)
        ? preflight.preflight.missingPermissions
        : [];
      assert(
        summary.readableRoots === options.rootNotionPageIds.length,
        `live Notion preflight should read all explicit roots, got ${summary.readableRoots ?? 0}/${options.rootNotionPageIds.length}`,
      );
      assert(missingPermissions.length === 0, `live Notion preflight reported missing permissions: ${JSON.stringify(missingPermissions)}`);
      console.log(
        `PASS live Notion preflight read ${summary.readableRoots ?? 0} root(s), ` +
        `${summary.readableSampledPages ?? 0}/${summary.sampledPages ?? 0} sampled page(s), ` +
        `${summary.queryableSampledDataSources ?? 0}/${summary.sampledDataSources ?? 0} sampled data source(s).`,
      );
    }

    const created = await callFunction(baseUrl, owner.token, 'notion-import', {
      action: 'create',
      workspaceId,
      connectionKind: 'manual_token',
      notionToken,
      maxDiscoveryPages: options.maxDiscoveryPages,
      maxEnrichedItems: options.maxEnrichedItems,
      maxChildrenPages: options.maxChildrenPages,
      maxDataSourceQueryPages: options.maxDataSourceQueryPages,
      maxViewPages: options.maxViewPages,
      discoveryConcurrency: options.discoveryConcurrency,
      includeMarkdownFallback: options.includeMarkdownFallback,
      rootNotionPageIds: options.rootNotionPageIds,
    });

    assert(created.job?.id, 'live Notion import must create a job');
    createdJobId = created.job.id;
    assert(created.job.status === 'ready', `live Notion import should finish discovery as ready, got ${created.job.status}`);
    assert(created.job.apiVersion === '2026-03-11', 'live Notion import must use the configured Notion API version');
    assert(created.job.options?.tokenStored === false, 'live Notion import must not store the one-time token');
    assert(created.job.options?.credentialSource === 'request', 'live Notion import must record request-scoped credential source');
    assert(created.job.progress?.currentStep === 'discover', 'live Notion import must expose discover progress');
    assert(created.job.progress?.currentStatus === 'completed', 'live Notion import discovery must complete');
    assert(typeof created.job.progress?.lastUpdatedAt === 'string', 'live Notion import must record progress timestamp');
    assert(created.job.notionWorkspaceId || created.job.notionWorkspaceName, 'live Notion import must record safe Notion workspace metadata');

    const items = Array.isArray(created.items) ? created.items : [];
    discoveredItemCount = items.length;
    if (!options.allowEmpty) {
      assert(items.length > 0, 'live Notion import discovered no accessible pages/databases; share pages with the integration or pass --allow-empty for token-only preflight');
    }
    const counts = objectCounts(items);
    assertSafeJobPayload(created.job);

    const planned = await callFunction(baseUrl, owner.token, 'notion-import', {
      action: 'plan',
      jobId: created.job.id,
    });
    assert(planned.job?.status === 'ready', 'live Notion import review must keep the job ready');
    assert(planned.job?.progress?.currentStep === 'review', 'live Notion import review must expose review progress');
    assert(planned.job?.progress?.currentStatus === 'completed', 'live Notion import review progress must complete');
    assert(planned.plan?.canApply === true, 'live Notion import review should mark the ready job as applyable');
    assert(typeof planned.plan?.generatedAt === 'string', 'live Notion import review must return a generatedAt timestamp');
    assert(typeof planned.plan?.estimatedWrites === 'object' && planned.plan.estimatedWrites, 'live Notion import review must return estimated writes');
    assert(typeof planned.plan?.conversion?.summary === 'object', 'live Notion import review must return conversion summary');

    let applied = null;
    let publicShareResult = null;
    const shouldApply =
      options.apply ||
      options.shareImportedRoot ||
      options.expectPublicTexts.length > 0 ||
      options.expectPublicVisibleTexts.length > 0 ||
      options.rejectPublicTexts.length > 0 ||
      options.expectImportedOwnerVisibleTexts.length > 0 ||
      options.expectImportedOwnerRowPeekVisibleTexts.length > 0 ||
      options.expectFirstViewName ||
      options.expectViewPropertyOrders.length > 0 ||
      options.expectPublicViewHiddenProperties.length > 0 ||
      options.expectPublicViewConfigProperties.length > 0 ||
      options.expectPublicViewQuickFilters.length > 0 ||
      options.expectPublicViewSortOrders.length > 0 ||
      options.expectPublicViewTypes.length > 0 ||
      options.expectPublicRowProperties.length > 0 ||
      options.expectPublicRowPeekVisibleTexts.length > 0 ||
      options.rejectPublicRowPeekVisibleTexts.length > 0 ||
      options.expectPublicRowPeekPropertyOrders.length > 0 ||
      options.captureImportedOwnerScreenshotDir ||
      options.capturePublicScreenshotDir ||
      options.capturePublicVisibleTextScreenshots ||
      options.expectPublicRootIcon ||
      options.expectPublicRootCover ||
      options.rejectPublicDatabaseTitles.length > 0 ||
      options.rejectPublicVisibleTexts.length > 0 ||
      options.expectPublicViewTabs.length > 0 ||
      options.rejectPublicViewTabs.length > 0 ||
      options.expectImportedInlineDatabaseTabs.length > 0 ||
      options.expectImportedInlineDatabaseSectionTabs.length > 0;
    if (shouldApply) {
      applied = await callFunction(baseUrl, owner.token, 'notion-import', {
        action: 'apply',
        jobId: created.job.id,
        notionToken,
      });
      assert(applied.job?.status === 'completed', `live Notion import apply should complete, got ${applied.job?.status}`);
      assert(typeof applied.applied === 'object' && applied.applied, 'live Notion import apply must return applied write counts');
      assert(Array.isArray(applied.mappings), 'live Notion import apply must return durable Notion/local mappings');
      assertSafeJobPayload(applied.job);

      if (options.expectPlanApplyCounts) {
        assertWriteCountsMatch(planned.plan.estimatedWrites, applied.applied, ['databases', 'rows', 'blocks', 'properties', 'views', 'templates', 'mappings']);
      }

      if (options.captureImportedOwnerScreenshotDir || options.expectImportedOwnerVisibleTexts.length > 0) {
        const ownerScreenshotPaths = await inspectImportedOwnerPage(baseUrl, owner, workspaceId, applied.mappings, options);
        for (const screenshotPath of ownerScreenshotPaths) {
          console.log(`Screenshot: ${screenshotPath}`);
        }
      }

      if (
        options.shareImportedRoot ||
          options.expectPublicTexts.length > 0 ||
          options.expectPublicVisibleTexts.length > 0 ||
          options.rejectPublicTexts.length > 0 ||
          options.expectFirstViewName ||
        options.expectViewPropertyOrders.length > 0 ||
          options.expectPublicViewHiddenProperties.length > 0 ||
          options.expectPublicViewConfigProperties.length > 0 ||
          options.expectPublicViewQuickFilters.length > 0 ||
          options.expectPublicViewSortOrders.length > 0 ||
          options.expectPublicViewTypes.length > 0 ||
          options.expectPublicRowProperties.length > 0 ||
          options.expectPublicRowPeekVisibleTexts.length > 0 ||
          options.rejectPublicRowPeekVisibleTexts.length > 0 ||
          options.expectPublicRowPeekPropertyOrders.length > 0 ||
          options.rejectPublicVisibleTexts.length > 0 ||
          options.expectPublicViewTabs.length > 0 ||
          options.rejectPublicViewTabs.length > 0 ||
          options.expectPublicRootIcon ||
          options.expectPublicRootCover ||
          options.rejectPublicDatabaseTitles.length > 0 ||
          options.expectImportedInlineDatabaseTabs.length > 0 ||
          options.expectImportedInlineDatabaseSectionTabs.length > 0 ||
          options.capturePublicVisibleTextScreenshots ||
          options.capturePublicScreenshotDir
        ) {
          publicShareResult = await shareImportedRootAndReadPublicPayload(baseUrl, owner.token, options, applied.mappings);
        const serialized = JSON.stringify(publicShareResult.publicPayload);
        for (const text of options.expectPublicTexts) {
          assert(serialized.includes(text), `public imported root share must include expected text "${text}"`);
        }
        for (const text of options.rejectPublicTexts) {
          assert(!serialized.includes(text), `public imported root share must not include rejected text "${text}"`);
        }
        assertPublicFirstView(publicShareResult.publicPayload, options.expectFirstViewName);
        assertPublicViewPropertyOrders(publicShareResult.publicPayload, options.expectViewPropertyOrders);
        assertPublicViewHiddenProperties(publicShareResult.publicPayload, options.expectPublicViewHiddenProperties);
        assertPublicViewConfigProperties(publicShareResult.publicPayload, options.expectPublicViewConfigProperties);
        assertPublicViewQuickFilters(publicShareResult.publicPayload, options.expectPublicViewQuickFilters);
        assertPublicViewSortOrders(publicShareResult.publicPayload, options.expectPublicViewSortOrders);
        assertPublicViewTypes(publicShareResult.publicPayload, options.expectPublicViewTypes);
        assertPublicRowProperties(publicShareResult.publicPayload, options.expectPublicRowProperties);
        assertPublicDatabasePropertyTypes(publicShareResult.publicPayload, options.expectPublicPropertyTypes);
        assertPublicComputedPropertyValues(publicShareResult.publicPayload, options.expectPublicComputedValues);
        assertPublicCollapsedBlocks(publicShareResult.publicPayload, options.expectCollapsedBlockTexts);
        assertPublicRootPageChrome(publicShareResult.publicPayload, options);
        assertRejectedPublicDatabaseTitles(publicShareResult.publicPayload, options.rejectPublicDatabaseTitles);
        if (
          options.capturePublicScreenshotDir ||
          options.capturePublicVisibleTextScreenshots ||
          options.rejectPublicVisibleTexts.length > 0 ||
          options.expectPublicViewTabs.length > 0 ||
          options.rejectPublicViewTabs.length > 0 ||
          options.expectImportedInlineDatabaseTabs.length > 0 ||
          options.expectImportedInlineDatabaseSectionTabs.length > 0 ||
          options.expectPublicRowPeekVisibleTexts.length > 0 ||
          options.rejectPublicRowPeekVisibleTexts.length > 0 ||
          options.expectPublicRowPeekPropertyOrders.length > 0
        ) {
          const screenshotPaths = await inspectPublicSharePage(baseUrl, publicShareResult, options);
          for (const screenshotPath of screenshotPaths) {
            console.log(`Screenshot: ${screenshotPath}`);
          }
        }
      }
    }

    passMessage =
      `PASS live Notion import discovers ${items.length} accessible object(s), stores no token, produces a dry-run review` +
      `${applied ? ', applies the graph' : ''}` +
      `${publicShareResult ? ', validates the imported public share' : ''}` +
      `, and cleans up its temporary workspace. Counts: ${formatCounts(counts)}`;
  } catch (error) {
    runError = error;
  } finally {
    let cleanupError = null;
    if (workspaceId) {
      try {
        await cleanupWorkspace(baseUrl, owner.token, workspaceId, {
          expectedItems: discoveredItemCount,
          expectImportJob: Boolean(createdJobId),
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (runError) {
      if (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.error(`WARN live Notion import smoke cleanup failed after test failure: ${message}`);
      }
      throw runError;
    }
    if (cleanupError) throw cleanupError;
  }

  console.log(passMessage);
}

async function inspectImportedOwnerPage(baseUrl, owner, workspaceId, mappings, options) {
  if (options.captureImportedOwnerScreenshotDir) mkdirSync(options.captureImportedOwnerScreenshotDir, { recursive: true });
  assert(owner.refreshToken, 'capturing the imported owner page requires an auth refresh token');
  const rootMapping = importedRootPageMapping(options.rootNotionPageIds, mappings);
  assert(rootMapping?.localId, 'live Notion import apply must include a local page mapping for the requested root page');
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    colorScheme: options.capturePublicColorScheme,
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId: activeWorkspaceId, theme }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', activeWorkspaceId);
    window.localStorage.setItem('hanji:theme', theme);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: owner.refreshToken,
    theme: options.capturePublicColorScheme,
    workspaceId,
  });

  const page = await context.newPage();
  const screenshotPaths = [
    join(options.captureImportedOwnerScreenshotDir, importedOwnerScreenshotName(options, 'latest')),
    join(options.captureImportedOwnerScreenshotDir, importedOwnerScreenshotName(options, 'middle')),
    join(options.captureImportedOwnerScreenshotDir, importedOwnerScreenshotName(options, 'lower')),
  ];
  const capturedScreenshotPaths = [];

  try {
    await page.goto(resolveUrl(baseUrl, `/p/${encodeURIComponent(rootMapping.localId)}`), {
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
    await page.waitForLoadState('networkidle', { timeout: options.timeoutMs }).catch(() => {});
    await moveMouseToNeutralChrome(page);
    await assertRenderedVisibleText(page, options.expectImportedOwnerVisibleTexts, [
      'Something went wrong',
      'Database unavailable',
      'Unsupported Notion block: button',
    ]);

    await page.screenshot({ path: screenshotPaths[0], fullPage: false });
    capturedScreenshotPaths.push(screenshotPaths[0]);
    const rowPeekPaths = await assertRenderedRowPeekVisibleTexts(
      page,
      [
        ...options.expectPublicRowPeekVisibleTexts,
        ...options.expectImportedOwnerRowPeekVisibleTexts,
      ],
      options.rejectPublicRowPeekVisibleTexts,
      options.expectPublicRowPeekPropertyOrders,
      options,
      options.captureImportedOwnerScreenshotDir,
      importedOwnerScreenshotName,
    );
    capturedScreenshotPaths.push(...rowPeekPaths);
    if (await scrollLargestPublicSharePane(page, 0.48)) {
      await page.screenshot({ path: screenshotPaths[1], fullPage: false });
      capturedScreenshotPaths.push(screenshotPaths[1]);
    }
    if (await scrollLargestPublicSharePane(page, 1)) {
      await page.screenshot({ path: screenshotPaths[2], fullPage: false });
      capturedScreenshotPaths.push(screenshotPaths[2]);
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return capturedScreenshotPaths;
}

async function shareImportedRootAndReadPublicPayload(baseUrl, token, options, mappings) {
  const rootMapping = importedRootPageMapping(options.rootNotionPageIds, mappings);
  assert(rootMapping?.localId, 'live Notion import apply must include a local page mapping for the requested root page');
  const sharing = await callFunction(baseUrl, token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: rootMapping.localId,
    enabled: true,
    expiresIn: '7d',
  });
  const shareToken = sharing?.shareLink?.token;
  assert(shareToken, 'setWebSharing must return a public share token for the imported root page');
  const publicPayload = await callPublicFunction(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: shareToken,
  });
  assert(publicPayload?.page?.id === rootMapping.localId, 'public share must return the imported root page');
  return {
    shareToken,
    rootPageId: rootMapping.localId,
    publicPayload,
  };
}

async function inspectPublicSharePage(baseUrl, publicShareResult, options) {
  if (options.capturePublicScreenshotDir) mkdirSync(options.capturePublicScreenshotDir, { recursive: true });
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    colorScheme: options.capturePublicColorScheme,
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const screenshotPaths = options.capturePublicScreenshotDir
    ? [
        join(options.capturePublicScreenshotDir, importedPublicScreenshotName(options, 'latest')),
        join(options.capturePublicScreenshotDir, importedPublicScreenshotName(options, 'middle')),
        join(options.capturePublicScreenshotDir, importedPublicScreenshotName(options, 'lower')),
      ]
    : [];
  const capturedScreenshotPaths = [];

  try {
    const path = `/share/${encodeURIComponent(publicShareResult.shareToken)}?page=${encodeURIComponent(publicShareResult.rootPageId)}`;
    await page.goto(resolveUrl(baseUrl, path), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('textbox', { name: 'Page title' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.waitForLoadState('networkidle', { timeout: options.timeoutMs }).catch(() => {});
    await moveMouseToNeutralChrome(page);
    await assertRenderedVisibleText(page, options.expectPublicVisibleTexts, options.rejectPublicVisibleTexts);
    await assertRenderedViewTabs(page, options.expectPublicViewTabs, options.rejectPublicViewTabs);
    await assertImportedInlineDatabaseDensity(
      page,
      options.expectImportedInlineDatabaseTabs,
      options.expectImportedInlineDatabaseSectionTabs,
    );
    if (screenshotPaths[0]) {
      await page.screenshot({ path: screenshotPaths[0], fullPage: false });
      capturedScreenshotPaths.push(screenshotPaths[0]);
    }
    if (screenshotPaths[1] && await scrollLargestPublicSharePane(page, 0.48)) {
      await page.screenshot({ path: screenshotPaths[1], fullPage: false });
      capturedScreenshotPaths.push(screenshotPaths[1]);
    }
    if (screenshotPaths[2] && await scrollLargestPublicSharePane(page, 1)) {
      await page.screenshot({ path: screenshotPaths[2], fullPage: false });
      capturedScreenshotPaths.push(screenshotPaths[2]);
    }
    if (options.capturePublicVisibleTextScreenshots) {
      const anchoredPaths = await captureExpectedVisibleTextScreenshots(
        page,
        options.expectPublicVisibleTexts,
        options.capturePublicScreenshotDir,
        options,
      );
      capturedScreenshotPaths.push(...anchoredPaths);
    }
    const rowPeekPaths = await assertRenderedRowPeekVisibleTexts(
      page,
      options.expectPublicRowPeekVisibleTexts,
      options.rejectPublicRowPeekVisibleTexts,
      options.expectPublicRowPeekPropertyOrders,
      options,
      options.capturePublicScreenshotDir,
      importedPublicScreenshotName,
    );
    capturedScreenshotPaths.push(...rowPeekPaths);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return capturedScreenshotPaths;
}

async function assertRenderedRowPeekVisibleTexts(
  page,
  expectations,
  rejectedExpectations,
  propertyOrderExpectations,
  options,
  screenshotDir,
  screenshotName,
) {
  if (expectations.length === 0 && rejectedExpectations.length === 0 && propertyOrderExpectations.length === 0) return [];
  const captured = [];
  const grouped = [];
  for (const expectation of expectations) {
    const existing = grouped.find((group) => group.viewName === expectation.viewName && group.rowTitle === expectation.rowTitle);
    if (existing) {
      existing.texts.push(expectation.text);
    } else {
      grouped.push({
        viewName: expectation.viewName,
        rowTitle: expectation.rowTitle,
        texts: [expectation.text],
        rejectedTexts: [],
        propertyOrders: [],
      });
    }
  }
  for (const expectation of rejectedExpectations) {
    const existing = grouped.find((group) => group.viewName === expectation.viewName && group.rowTitle === expectation.rowTitle);
    if (existing) {
      existing.rejectedTexts.push(expectation.text);
    } else {
      grouped.push({
        viewName: expectation.viewName,
        rowTitle: expectation.rowTitle,
        texts: [],
        rejectedTexts: [expectation.text],
        propertyOrders: [],
      });
    }
  }
  for (const expectation of propertyOrderExpectations) {
    const existing = grouped.find((group) => group.viewName === expectation.viewName && group.rowTitle === expectation.rowTitle);
    if (existing) {
      existing.propertyOrders.push(expectation.propertyNames);
    } else {
      grouped.push({
        viewName: expectation.viewName,
        rowTitle: expectation.rowTitle,
        texts: [],
        rejectedTexts: [],
        propertyOrders: [expectation.propertyNames],
      });
    }
  }

  for (const expectation of grouped) {
    const opened = await page.evaluate(({ viewName, rowTitle }) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const cssVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.05 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const databases = Array.from(document.querySelectorAll('[data-placement="inline"]'))
        .filter((element) => element instanceof HTMLElement);
      const database = databases.find((candidate) => {
        const activeTab = candidate.querySelector('[role="tab"][aria-selected="true"]');
        return normalize(activeTab?.textContent) === viewName;
      });
      if (!(database instanceof HTMLElement)) {
        return { ok: false, reason: `inline database "${viewName}" was not found` };
      }

      const openButton = Array.from(database.querySelectorAll('button[aria-label]'))
        .find((button) => button.getAttribute('aria-label') === `Open ${rowTitle}`);
      if (!(openButton instanceof HTMLButtonElement)) {
        const cells = Array.from(database.querySelectorAll('[data-table-cell]'))
          .filter((element) => element instanceof HTMLElement);
        const matchingCell = cells.find((cell) => normalize(cell.textContent).includes(rowTitle));
        return {
          ok: false,
          reason: `row "${rowTitle}" has no Open action`,
          rowTextWasRendered: !!matchingCell,
          visible: matchingCell instanceof HTMLElement ? cssVisible(matchingCell) : false,
        };
      }
      const cell = openButton.closest('[data-table-cell]');
      (cell instanceof HTMLElement ? cell : openButton).scrollIntoView({ block: 'center', inline: 'nearest' });
      openButton.click();
      return { ok: true };
    }, expectation);
    assert(
      opened.ok,
      `imported public share must open row peek for "${expectation.viewName}:${expectation.rowTitle}": ${JSON.stringify(opened)}`,
    );

    const dialog = page.getByRole('dialog', { name: `${expectation.rowTitle} preview` }).first();
    await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    for (const text of expectation.texts) {
      await waitForVisibleTextOrControlValue(page, dialog, text, options.timeoutMs);
      if (screenshotDir) {
        const screenshotPath = join(
          screenshotDir,
          screenshotName(
            options,
            `row-peek-${fileSafeSegment(expectation.rowTitle)}-${fileSafeSegment(text)}`,
          ),
        );
        await page.screenshot({ path: screenshotPath, fullPage: false });
        captured.push(screenshotPath);
      }
    }
    for (const propertyNames of expectation.propertyOrders) {
      await waitForRowPeekPropertyOrder(dialog, propertyNames, options.timeoutMs);
    }
    for (const text of expectation.rejectedTexts) {
      await assertNoVisibleTextOrControlValue(dialog, text);
    }

    const closeButton = dialog.getByRole('button', { name: `Close ${expectation.rowTitle} preview` });
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ timeout: options.timeoutMs });
    } else {
      await page.keyboard.press('Escape');
    }
    await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
    await moveMouseToNeutralChrome(page);
  }
  return captured;
}

async function assertNoVisibleTextOrControlValue(locator, text) {
  const snapshot = await visibleTextAndControlValueSnapshot(locator);
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
  const found = snapshot.some((item) => item.includes(normalizedText));
  assert(
    !found,
    `row peek must not show visible text or control value "${text}". Visible snapshot: ${JSON.stringify(snapshot)}`,
  );
}

async function waitForRowPeekPropertyOrder(locator, propertyNames, timeoutMs) {
  const expected = propertyNames.map((name) => String(name || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const deadline = Date.now() + timeoutMs;
  let lastLabels = [];
  while (Date.now() < deadline) {
    const labels = await locator.evaluate((root) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.05 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      return Array.from(root.querySelectorAll('[data-row-property-label]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element))
        .map((element) => normalize(element.textContent))
        .filter(Boolean);
    });
    lastLabels = labels;
    const prefixMatches =
      labels.length >= expected.length &&
      expected.every((name, index) => labels[index] === name);
    if (prefixMatches) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `row peek property order should start with ${JSON.stringify(expected)}, got ${JSON.stringify(lastLabels)}`,
  );
}

async function waitForVisibleTextOrControlValue(page, locator, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastVisibleSnapshot = '';
  while (Date.now() < deadline) {
    const found = await locator.evaluate((root, needle) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.05 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const elements = [root, ...Array.from(root.querySelectorAll('*'))];
      const visibleParts = [];
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
        const textContent = normalize(element.innerText || element.textContent || '');
        if (textContent) visibleParts.push(textContent);
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          const value = normalize(element.value);
          if (value) visibleParts.push(value);
          if (value.includes(needle)) return { ok: true, snapshot: visibleParts.join(' ').slice(0, 1200) };
        }
        const ariaLabel = normalize(element.getAttribute('aria-label') || '');
        if (ariaLabel) visibleParts.push(ariaLabel);
        if (textContent.includes(needle) || ariaLabel.includes(needle)) {
          return { ok: true, snapshot: visibleParts.join(' ').slice(0, 1200) };
        }
      }
      return { ok: false, snapshot: visibleParts.join(' ').slice(0, 1200) };
    }, text).catch((error) => ({
      ok: false,
      snapshot: `locator evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    if (found.ok) return;
    lastVisibleSnapshot = found.snapshot;
    await page.waitForTimeout(120);
  }
  throw new Error(`row peek must show visible text or control value "${text}". Visible snapshot: ${JSON.stringify(lastVisibleSnapshot)}`);
}

async function visibleTextAndControlValueSnapshot(locator) {
  return locator.evaluate((root) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05 &&
        rect.width > 0 &&
        rect.height > 0;
    };
    const values = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node instanceof HTMLElement && isVisible(node)) {
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          const value = normalize(node.value || node.placeholder || node.getAttribute('aria-label'));
          if (value) values.push(value);
        } else if (node instanceof HTMLSelectElement) {
          const value = normalize(node.value || node.getAttribute('aria-label'));
          if (value) values.push(value);
        } else {
          const ownText = normalize(Array.from(node.childNodes)
            .filter((child) => child.nodeType === Node.TEXT_NODE)
            .map((child) => child.textContent || '')
            .join(' '));
          if (ownText) values.push(ownText);
          const aria = normalize(node.getAttribute('aria-label'));
          if (aria) values.push(aria);
        }
      }
      node = walker.nextNode();
    }
    return values;
  });
}

async function captureExpectedVisibleTextScreenshots(page, expectedTexts, screenshotDir, options) {
  if (!screenshotDir || expectedTexts.length === 0) return [];
  const captured = [];
  const uniqueTexts = Array.from(new Set(expectedTexts.map((text) => text.trim()).filter(Boolean)));
  for (let index = 0; index < uniqueTexts.length; index += 1) {
    const text = uniqueTexts[index];
    const found = await page.evaluate((needle) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.05 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const matches = Array.from(document.querySelectorAll('body *'))
        .filter((element) => element instanceof HTMLElement && isVisible(element) && normalize(element.textContent).includes(needle))
        .sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);
      const target = matches[0];
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    }, text);
    if (!found) continue;
    await page.waitForTimeout(120);
    await moveMouseToNeutralChrome(page);
    const screenshotPath = join(
      screenshotDir,
      importedPublicScreenshotName(options, `visible-${String(index + 1).padStart(2, '0')}-${fileSafeSegment(text)}`),
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });
    captured.push(screenshotPath);
  }
  return captured;
}

function importedPublicScreenshotName(options, segment) {
  const colorScheme = options.capturePublicColorScheme === 'dark' ? 'dark-' : '';
  return `hanji-exam-planner-imported-${colorScheme}${segment}.png`;
}

function importedOwnerScreenshotName(options, segment) {
  const colorScheme = options.capturePublicColorScheme === 'dark' ? 'dark-' : '';
  return `hanji-exam-planner-imported-owner-${colorScheme}${segment}.png`;
}

function fileSafeSegment(value) {
  const safe = String(value)
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return safe || 'text';
}

async function scrollLargestPublicSharePane(page, ratio) {
  const scrolled = await page.evaluate((scrollRatio) => {
    const candidates = [
      document.scrollingElement,
      ...Array.from(document.querySelectorAll('body *')),
    ].filter((element) => element instanceof HTMLElement);
    let best = null;
    let bestScrollableHeight = 0;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const scrollableHeight = element.scrollHeight - element.clientHeight;
      if (
        scrollableHeight > bestScrollableHeight &&
        rect.width >= 320 &&
        rect.height >= 240
      ) {
        best = element;
        bestScrollableHeight = scrollableHeight;
      }
    }
    if (!best || bestScrollableHeight < 80) return false;
    best.scrollTop = Math.round(bestScrollableHeight * scrollRatio);
    return best.scrollTop > 0;
  }, ratio);
  if (scrolled) await page.waitForTimeout(120);
  return scrolled;
}

async function moveMouseToNeutralChrome(page) {
  await page.mouse.move(8, 8);
  await page.waitForTimeout(80);
}

async function assertRenderedVisibleText(page, expectedTexts, rejectedTexts) {
  if (expectedTexts.length === 0 && rejectedTexts.length === 0) return;
  const visibleText = await page.evaluate(() => document.body?.innerText || '');
  const compactVisibleText = visibleText.replace(/\s+/g, ' ').trim();
  for (const text of expectedTexts) {
    assert(
      visibleText.includes(text),
      `imported public share must render visible text "${text}". Visible text: ${JSON.stringify(compactVisibleText.slice(0, 1200))}`,
    );
  }
  for (const text of rejectedTexts) {
    assert(!visibleText.includes(text), `imported public share must not render visible text "${text}".`);
  }
}

async function assertRenderedViewTabs(page, expectedTexts, rejectedTexts) {
  if (expectedTexts.length === 0 && rejectedTexts.length === 0) return;
  const tabTexts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="tab"]'))
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  });
  for (const text of expectedTexts) {
    assert(tabTexts.includes(text), `imported public share must render view tab "${text}". Visible tabs: ${JSON.stringify(tabTexts)}`);
  }
  for (const text of rejectedTexts) {
    assert(!tabTexts.includes(text), `imported public share must not render view tab "${text}". Visible tabs: ${JSON.stringify(tabTexts)}`);
  }
}

async function assertImportedInlineDatabaseDensity(page, expectedTabs, expectedSectionTabs) {
  const allExpectedTabs = Array.from(new Set([...expectedTabs, ...expectedSectionTabs].map((tab) => tab.trim()).filter(Boolean)));
  if (allExpectedTabs.length === 0) return;
  const sectionTabSet = new Set(expectedSectionTabs.map((tab) => tab.trim()).filter(Boolean));
  const metrics = await page.evaluate((tabs) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        bottom: Math.round(r.bottom * 100) / 100,
        height: Math.round(r.height * 100) / 100,
        left: Math.round(r.left * 100) / 100,
        right: Math.round(r.right * 100) / 100,
        top: Math.round(r.top * 100) / 100,
        width: Math.round(r.width * 100) / 100,
      };
    };
    const cssAlpha = (value) => {
      if (!value || value === 'transparent') return 0;
      const slash = value.match(/\/\s*([0-9.]+%?)/);
      if (slash) {
        const raw = slash[1];
        const parsed = Number.parseFloat(raw);
        return raw.endsWith('%') ? parsed / 100 : parsed;
      }
      const rgba = value.match(/^rgba?\((.+)\)$/);
      if (!rgba) return 1;
      const parts = rgba[1].split(',').map((part) => part.trim());
      if (parts.length >= 4) return Number.parseFloat(parts[3]);
      return 1;
    };
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const r = element.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05 &&
        r.width > 0 &&
        r.height > 0;
    };
    const text = (element) => (element?.textContent || '').replace(/\s+/g, ' ').trim();
    const buttonLabel = (button) =>
      button.getAttribute('aria-label') ||
      button.getAttribute('title') ||
      text(button);
    const round = (value) => Math.round(value * 100) / 100;
    const px = (value) => {
      const parsed = Number.parseFloat(value || '0');
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const databases = Array.from(document.querySelectorAll('[data-placement="inline"]'))
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .map((database) => {
        const sectionContainer = database.closest('[data-imported-database-section="true"]');
        const container = sectionContainer ?? database.closest('[data-contained="true"]');
        const tablist = database.querySelector('[role="tablist"]');
        const activeTab = database.querySelector('[role="tab"][aria-selected="true"]');
        const toolbar = database.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
        const summaryRow = database.querySelector('[data-table-summary-row]');
        const cells = Array.from(database.querySelectorAll('[data-table-cell]'))
          .filter((element) => element instanceof HTMLElement && isVisible(element));
        const firstCell = cells[0];
        const containerStyle = container instanceof HTMLElement ? getComputedStyle(container) : null;
        const containerRect = container instanceof HTMLElement ? rect(container) : null;
        const databaseRect = rect(database);
        const tablistRect = tablist instanceof HTMLElement ? rect(tablist) : null;
        const toolbarStyle = toolbar instanceof HTMLElement ? getComputedStyle(toolbar) : null;
        const toolbarRect = toolbar instanceof HTMLElement ? rect(toolbar) : null;
        const tablistStyle = tablist instanceof HTMLElement ? getComputedStyle(tablist) : null;
        const firstCellRect = firstCell instanceof HTMLElement ? rect(firstCell) : null;
        const buttons = toolbar instanceof HTMLElement
          ? Array.from(toolbar.querySelectorAll('button'))
              .filter((button) => button instanceof HTMLElement && isVisible(button) && getComputedStyle(button).pointerEvents !== 'none')
              .map((button) => {
                const style = getComputedStyle(button);
                const buttonRect = rect(button);
                return {
                  colorAlpha: round(cssAlpha(style.color)),
                  height: buttonRect.height,
                  label: buttonLabel(button),
                  opacity: round(Number.parseFloat(style.opacity || '1')),
                  pointerEvents: style.pointerEvents,
                  text: text(button),
                  width: buttonRect.width,
                };
              })
          : [];
        const visibleSummaryTexts = summaryRow instanceof HTMLElement
          ? Array.from(summaryRow.querySelectorAll('button'))
              .filter((element) => element instanceof HTMLElement && isVisible(element))
              .map((element) => text(element))
              .filter(Boolean)
          : [];
        return {
          activeTabText: text(activeTab),
          cellCount: cells.length,
          container: containerRect
            ? {
                ...containerRect,
                borderAlpha: round(cssAlpha(containerStyle.borderTopColor)),
                borderWidth: round(px(containerStyle.borderTopWidth)),
                contained: container.getAttribute('data-contained') === 'true',
                importedDatabaseSection: container.getAttribute('data-imported-database-section') === 'true',
                databaseInsetBottom: round(containerRect.bottom - databaseRect.bottom),
                databaseInsetLeft: round(databaseRect.left - containerRect.left),
                databaseInsetRight: round(containerRect.right - databaseRect.right),
                contentInsetLeft: tablistRect ? round(tablistRect.left - containerRect.left) : null,
                contentInsetRight: tablistRect ? round(containerRect.right - tablistRect.right) : null,
                radius: round(px(containerStyle.borderTopLeftRadius)),
              }
            : null,
          database: databaseRect,
          firstCell: firstCellRect,
          ok: tablist instanceof HTMLElement &&
            activeTab instanceof HTMLElement &&
            toolbar instanceof HTMLElement &&
            firstCell instanceof HTMLElement,
          tablist: tablistRect,
          tablistOpacity: tablistStyle ? Number.parseFloat(tablistStyle.opacity || '1') : null,
          tablistPointerEvents: tablistStyle?.pointerEvents ?? null,
          toolbar: toolbarRect,
          toolbarButtons: buttons,
          toolbarOpacity: toolbarStyle ? Number.parseFloat(toolbarStyle.opacity || '1') : null,
          toolbarPointerEvents: toolbarStyle?.pointerEvents ?? null,
          visibleSummaryTexts,
        };
      });
    return {
      databases,
      expectedTabs: tabs,
      visibleTabs: Array.from(document.querySelectorAll('[role="tab"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element))
        .map((element) => text(element))
        .filter(Boolean),
    };
  }, allExpectedTabs);

  for (const expectedTab of allExpectedTabs) {
    const match = metrics.databases.find((database) => database.activeTabText === expectedTab);
    assert(match, `imported public share must render an inline database with active tab "${expectedTab}". Metrics: ${JSON.stringify(metrics)}`);
    assert(match.ok, `imported inline database "${expectedTab}" is missing tablist, toolbar, or table cells: ${JSON.stringify(match)}`);
    assert(match.cellCount >= 4, `imported inline database "${expectedTab}" should render table body cells, got ${match.cellCount}: ${JSON.stringify(match)}`);
    assert(
      (match.container?.contained === true || match.container?.importedDatabaseSection === true) &&
        match.container.borderWidth >= 0.5 &&
        match.container.borderAlpha >= 0.05 &&
        match.container.radius >= 6 &&
        match.container.radius <= 12 &&
        match.container.contentInsetLeft >= 8 &&
        match.container.contentInsetRight >= 8,
      `imported inline database "${expectedTab}" should render inside a rounded contained block with readable table padding: ${JSON.stringify(match.container)}`,
    );
    if (sectionTabSet.has(expectedTab)) {
      assert(
        match.container?.importedDatabaseSection === true,
        `imported inline database "${expectedTab}" should keep its Notion heading+database section wrapper: ${JSON.stringify(match.container)}`,
      );
    }
    assert(
      match.tablist.height >= 24 &&
        match.tablist.height <= 44 &&
        match.tablistOpacity >= 0.85 &&
        match.tablistPointerEvents === 'auto',
      `imported inline database "${expectedTab}" view tabs should stay visible and compact: ${JSON.stringify(match)}`,
    );
    const chromeVerticalOverlap = Math.min(match.toolbar.bottom, match.tablist.bottom) - Math.max(match.toolbar.top, match.tablist.top);
    const sameChromeRow =
      chromeVerticalOverlap >= Math.min(match.toolbar.height, match.tablist.height) * 0.55 &&
      match.toolbar.left >= match.tablist.left &&
      match.toolbar.top <= match.tablist.bottom;
    const stackedChrome =
      match.toolbar.top >= match.tablist.top + 20 &&
      match.toolbar.top <= match.tablist.bottom + 16;
    assert(
      match.toolbar.height >= 20 &&
        match.toolbar.height <= 42 &&
        match.toolbarOpacity >= 0.85 &&
        match.toolbarPointerEvents === 'auto' &&
        (sameChromeRow || stackedChrome),
      `imported inline database "${expectedTab}" toolbar should be visible at rest and attached to the view-tab chrome: ${JSON.stringify(match)}`,
    );
    assert(
      match.firstCell.top >= match.toolbar.top + 18 &&
        match.firstCell.top <= match.toolbar.bottom + 72,
      `imported inline database "${expectedTab}" table body should follow the toolbar plus the property header without loose whitespace: ${JSON.stringify(match)}`,
    );
    assert(
      match.toolbarButtons.length >= 4 &&
        match.toolbarButtons.every((button) =>
          button.width <= 72 &&
          button.height >= 20 &&
          button.height <= 34 &&
          button.opacity >= 0.85 &&
          button.colorAlpha >= 0.35 &&
          button.pointerEvents !== 'none'
        ),
      `imported inline database "${expectedTab}" toolbar controls should stay compact and visible at rest: ${JSON.stringify(match.toolbarButtons)}`,
    );
    for (const label of ['Properties', 'Filter', 'Sort', 'Search database rows']) {
      assert(
        match.toolbarButtons.some((button) => button.label === label),
        `imported inline database "${expectedTab}" toolbar should expose ${label}: ${JSON.stringify(match.toolbarButtons)}`,
      );
    }
    const noisySummaryTexts = match.visibleSummaryTexts.filter((item) =>
      /^(\d+|[0-9,]+)\s+rows?$/i.test(item) || /^Calculate$/i.test(item)
    );
    assert(
      noisySummaryTexts.length === 0,
      `imported inline database "${expectedTab}" should keep default row-count/Calculate footer controls quiet at rest: ${JSON.stringify(match.visibleSummaryTexts)}`,
    );
  }
}

function importedRootPageMapping(rootNotionPageIds, mappings) {
  const roots = new Set(rootNotionPageIds.map((id) => normalizedNotionId(id)).filter(Boolean));
  if (roots.size === 0) return undefined;
  return mappings.find((mapping) =>
    mapping?.localType === 'page' &&
    typeof mapping.localId === 'string' &&
    roots.has(normalizedNotionId(mapping.notionId))
  );
}

function assertWriteCountsMatch(planned, applied, keys) {
  for (const key of keys) {
    if (planned?.[key] === undefined || applied?.[key] === undefined) continue;
    assert(
      planned[key] === applied[key],
      `live Notion import plan/apply ${key} count mismatch: planned ${planned[key]}, applied ${applied[key]}`,
    );
  }
}

function assertPublicFirstView(publicPayload, expectedViewName) {
  if (!expectedViewName) return;
  const views = sortedPublicViews(publicPayload);
  const expectedView = views.find((view) => view?.name === expectedViewName);
  assert(expectedView, `public imported root share must include database view "${expectedViewName}"`);
  const siblingViews = views.filter((view) => view?.databaseId === expectedView.databaseId);
  const actual = siblingViews[0]?.name;
  assert(
    actual === expectedViewName,
    `public imported root first database view for database ${JSON.stringify(expectedView.databaseId)} should be "${expectedViewName}", got ${JSON.stringify(actual)}`,
  );
}

function assertPublicViewPropertyOrders(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const propertyNamesById = publicPropertyNamesById(publicPayload);

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const config = view.config && typeof view.config === 'object' ? view.config : {};
    const propertyOrder = Array.isArray(config.propertyOrder) ? config.propertyOrder : [];
    const actual = propertyOrder
      .map((propertyId) => propertyNamesById.get(propertyId))
      .filter(Boolean);
    const expected = expectation.propertyNames;
    assert(
      expected.every((name, index) => actual[index] === name),
      `database view "${expectation.viewName}" property order should start with ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertPublicViewHiddenProperties(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const propertyNamesById = publicPropertyNamesById(publicPayload);

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const config = view.config && typeof view.config === 'object' ? view.config : {};
    const actual = Array.isArray(config.hiddenProperties)
      ? config.hiddenProperties.map((propertyId) => propertyNamesById.get(propertyId) ?? propertyId)
      : [];
    for (const propertyName of expectation.propertyNames) {
      assert(
        actual.includes(propertyName),
        `database view "${expectation.viewName}" hidden properties should include "${propertyName}", got ${JSON.stringify(actual)}`,
      );
    }
  }
}

function assertPublicViewConfigProperties(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const propertyNamesById = publicPropertyNamesById(publicPayload);

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const config = view.config && typeof view.config === 'object' ? view.config : {};
    const propertyId = config[expectation.configKey];
    const actual = typeof propertyId === 'string' ? propertyNamesById.get(propertyId) ?? propertyId : propertyId;
    assert(
      actual === expectation.propertyName,
      `database view "${expectation.viewName}" config "${expectation.configKey}" should point to property "${expectation.propertyName}", got ${JSON.stringify(actual)}`,
    );
  }
}

function assertPublicViewQuickFilters(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const propertyNamesById = publicPropertyNamesById(publicPayload);
  const flattenFilters = (term) => {
    if (!term || typeof term !== 'object') return [];
    if (typeof term.conjunction === 'string') {
      return [
        ...(Array.isArray(term.filters) ? term.filters.flatMap(flattenFilters) : []),
        ...(Array.isArray(term.groups) ? term.groups.flatMap(flattenFilters) : []),
      ];
    }
    return [term];
  };

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const config = view.config && typeof view.config === 'object' ? view.config : {};
    const actual = flattenFilters(config.filterGroup)
      .map((filter) => ({
          propertyName: propertyNamesById.get(filter?.propertyId) ?? filter?.propertyId,
          operator: filter?.operator,
          value: filter?.value,
        }));
    const found = actual.some((filter) =>
      filter.propertyName === expectation.propertyName &&
      filter.operator === expectation.operator &&
      filterValueMatchesExpectation(filter.value, expectation.value)
    );
    assert(
      found,
      `database view "${expectation.viewName}" quick filters should include ${JSON.stringify(expectation)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertPublicViewSortOrders(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const propertyNamesById = publicPropertyNamesById(publicPayload);

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const config = view.config && typeof view.config === 'object' ? view.config : {};
    const actual = Array.isArray(config.sorts)
      ? config.sorts.map((sort) => ({
          propertyName: propertyNamesById.get(sort?.propertyId) ?? sort?.propertyId,
          direction: sort?.direction,
        }))
      : [];
    const expected = expectation.sorts;
    assert(
      expected.every((sort, index) =>
        actual[index]?.propertyName === sort.propertyName &&
        actual[index]?.direction === sort.direction
      ),
      `database view "${expectation.viewName}" sort order should start with ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertPublicViewTypes(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    assert(
      view.type === expectation.type,
      `database view "${expectation.viewName}" should be type "${expectation.type}", got "${view.type}"`,
    );
  }
}

function assertPublicRowProperties(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const properties = Array.isArray(publicPayload?.properties) ? publicPayload.properties : [];
  const pages = Array.isArray(publicPayload?.pages) ? publicPayload.pages : [];

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const property = properties.find((item) =>
      item?.databaseId === view.databaseId &&
      String(item?.name ?? '') === expectation.propertyName
    );
    assert(
      property,
      `database view "${expectation.viewName}" must include row property "${expectation.propertyName}". Properties: ${JSON.stringify(properties.map((item) => ({ databaseId: item?.databaseId, name: item?.name, type: item?.type })))}`,
    );
    const rows = pages.filter((page) =>
      page?.parentType === 'database' &&
      page?.parentId === view.databaseId &&
      String(page?.title ?? '') === expectation.rowTitle
    );
    assert(
      rows.length > 0,
      `database view "${expectation.viewName}" must include row "${expectation.rowTitle}". Rows: ${JSON.stringify(pages.filter((page) => page?.parentType === 'database' && page?.parentId === view.databaseId).map((page) => page?.title))}`,
    );
    const rowSummaries = rows.map((row) => ({
      rowId: row?.id,
      title: row?.title,
      values: publicPropertyDisplayValues(row?.properties?.[property.id], property),
    }));
    const found = rowSummaries.some((row) =>
      row.values.some((value) =>
        value === expectation.value ||
        value.includes(expectation.value)
      )
    );
    assert(
      found,
      `database view "${expectation.viewName}" row "${expectation.rowTitle}" property "${expectation.propertyName}" should include value "${expectation.value}", got ${JSON.stringify(rowSummaries)}`,
    );
  }
}

function assertPublicDatabasePropertyTypes(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const properties = Array.isArray(publicPayload?.properties) ? publicPayload.properties : [];

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const property = properties.find((item) =>
      item?.databaseId === view.databaseId &&
      String(item?.name ?? '') === expectation.propertyName
    );
    assert(
      property,
      `database view "${expectation.viewName}" must include property "${expectation.propertyName}". Properties: ${JSON.stringify(properties.map((item) => ({ databaseId: item?.databaseId, name: item?.name, type: item?.type })))}`,
    );
    assert(
      property.type === expectation.type,
      `database view "${expectation.viewName}" property "${expectation.propertyName}" should be type "${expectation.type}", got "${property.type}"`,
    );
  }
}

function assertPublicComputedPropertyValues(publicPayload, expectations) {
  if (expectations.length === 0) return;
  const views = sortedPublicViews(publicPayload);
  const properties = Array.isArray(publicPayload?.properties) ? publicPayload.properties : [];
  const pages = Array.isArray(publicPayload?.pages) ? publicPayload.pages : [];

  for (const expectation of expectations) {
    const view = views.find((item) => item?.name === expectation.viewName);
    assert(view, `public imported root share must include database view "${expectation.viewName}"`);
    const property = properties.find((item) =>
      item?.databaseId === view.databaseId &&
      String(item?.name ?? '') === expectation.propertyName
    );
    assert(property, `database view "${expectation.viewName}" must include computed property "${expectation.propertyName}"`);
    assert(
      property.type === 'formula' || property.type === 'rollup',
      `database view "${expectation.viewName}" property "${expectation.propertyName}" should be formula/rollup for computed assertion, got "${property.type}"`,
    );
    const rowSummaries = pages
      .filter((page) => page?.parentType === 'database' && page?.parentId === view.databaseId)
      .map((row) => {
        const computed = row?.__computed?.[property.id];
        const formatted = typeof computed?.formatted === 'string' ? computed.formatted : '';
        const raw = computed?.value;
        return {
          rowId: row?.id,
          title: row?.title,
          formatted,
          raw,
        };
      });
    const found = rowSummaries.some((row) =>
      row.formatted === expectation.value ||
      String(row.raw ?? '') === expectation.value ||
      JSON.stringify(row.raw).includes(expectation.value)
    );
    assert(
      found,
      `database view "${expectation.viewName}" computed property "${expectation.propertyName}" should include value "${expectation.value}", got ${JSON.stringify(rowSummaries)}`,
    );
  }
}

function assertPublicCollapsedBlocks(publicPayload, expectedTexts) {
  if (expectedTexts.length === 0) return;
  const blocks = Array.isArray(publicPayload?.blocks) ? publicPayload.blocks : [];
  for (const expectedText of expectedTexts) {
    const block = blocks.find((item) => {
      const text = String(item?.plainText ?? textFromBlockRich(item)).trim();
      return text === expectedText;
    });
    assert(block, `public imported root share must include block text "${expectedText}"`);
    assert(
      block?.content?.collapsed === true,
      `public imported block "${expectedText}" should start collapsed, got ${JSON.stringify(block?.content?.collapsed)}`,
    );
  }
}

function textFromBlockRich(block) {
  const rich = Array.isArray(block?.content?.rich) ? block.content.rich : [];
  return rich.map((span) => typeof span?.text === 'string' ? span.text : '').join('');
}

function sortedPublicViews(publicPayload) {
  const views = Array.isArray(publicPayload?.views) ? publicPayload.views : [];
  return views.slice().sort((a, b) => {
    const aPosition = typeof a?.position === 'number' && Number.isFinite(a.position) ? a.position : Number.POSITIVE_INFINITY;
    const bPosition = typeof b?.position === 'number' && Number.isFinite(b.position) ? b.position : Number.POSITIVE_INFINITY;
    return aPosition - bPosition || String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  });
}

function publicPropertyNamesById(publicPayload) {
  const properties = Array.isArray(publicPayload?.properties) ? publicPayload.properties : [];
  return new Map(
    properties
      .filter((property) => typeof property?.id === 'string')
      .map((property) => [property.id, String(property.name ?? property.id)]),
  );
}

function publicPropertyDisplayValues(value, property) {
  const values = [];
  const push = (item) => {
    if (item === undefined || item === null) return;
    const text = String(item);
    if (text && !values.includes(text)) values.push(text);
  };
  const optionNameById = new Map(
    (Array.isArray(property?.config?.options) ? property.config.options : [])
      .filter((option) => typeof option?.id === 'string')
      .map((option) => [option.id, String(option.name ?? option.id)]),
  );
  const visit = (item) => {
    if (item === undefined || item === null) return;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      push(item);
      if (typeof item === 'string') {
        if (optionNameById.has(item)) push(optionNameById.get(item));
        const datePrefix = item.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
        if (datePrefix) push(datePrefix);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item !== 'object') {
      push(item);
      return;
    }
    for (const key of ['formatted', 'name', 'label', 'title', 'plain_text', 'plainText']) {
      if (typeof item[key] === 'string') push(item[key]);
    }
    if (typeof item.start === 'string') {
      push(item.start);
      const startPrefix = item.start.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
      if (startPrefix) push(startPrefix);
    }
    if (typeof item.end === 'string') {
      push(item.end);
      const endPrefix = item.end.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
      if (endPrefix) push(endPrefix);
    }
    if (typeof item.id === 'string' && optionNameById.has(item.id)) push(optionNameById.get(item.id));
    if (item.value !== undefined) visit(item.value);
  };
  visit(value);
  return values;
}

function filterValueMatchesExpectation(actual, expected) {
  if (expected === 'true') return actual === true;
  if (expected === 'false') return actual === false;
  if (expected === 'null') return actual === null;
  return String(actual ?? '') === expected || JSON.stringify(actual) === expected;
}

function liveNotionToken() {
  for (const name of LIVE_NOTION_TOKEN_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function objectCounts(items) {
  return items.reduce((acc, item) => {
    const key = typeof item?.notionObject === 'string' && item.notionObject ? item.notionObject : 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function formatCounts(counts) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([key, value]) => `${key}:${value}`).join(', ') : 'none';
}

function assertSafeJobPayload(job) {
  const serialized = JSON.stringify(job);
  for (const token of LIVE_NOTION_TOKEN_ENV_NAMES.map((name) => process.env[name]).filter(Boolean)) {
    assert(!serialized.includes(token), 'live Notion token leaked into returned job payload');
  }
}

async function cleanupWorkspace(baseUrl, token, workspaceId, expectations = {}) {
  const deletedPages = await deleteWorkspacePages(baseUrl, token, workspaceId);
  assert(deletedPages >= 1, 'live Notion import smoke cleanup must delete the temporary workspace seed pages first');
  const deleted = await callFunctionWithRetry(baseUrl, token, 'workspace-mutation', {
    action: 'deleteWorkspace',
    workspaceId,
  });
  assert(deleted?.deletedId === workspaceId, 'live Notion import smoke cleanup must delete the temporary workspace');
  if (expectations.expectImportJob) {
    const notionImport = deleted?.cleanup?.notionImport ?? {};
    assert((notionImport.jobs ?? 0) >= 1, 'temporary workspace delete must clean the live Notion import job');
    assert(
      (notionImport.items ?? 0) >= expectations.expectedItems,
      'temporary workspace delete must clean the live Notion import items',
    );
  }
}

async function deleteWorkspacePages(baseUrl, token, workspaceId) {
  let deletedPages = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const listed = await callFunctionWithRetry(baseUrl, token, 'page-query', {
      action: 'pages',
      workspaceId,
      includeTrash: true,
    });
    const pages = Array.isArray(listed?.pages) ? listed.pages : [];
    const rootPages = pages.filter((page) =>
      page?.workspaceId === workspaceId &&
      (page.parentType === 'workspace' || page.parentId == null)
    );
    if (rootPages.length === 0) return deletedPages;

    for (const page of rootPages) {
      if (!page?.id) continue;
      const deleted = await permanentlyDeletePage(baseUrl, token, page.id, {
        call: callFunctionWithRetry,
      });
      deletedPages += Array.isArray(deleted?.deletedIds) ? deleted.deletedIds.length : 1;
    }
  }

  const remaining = await callFunctionWithRetry(baseUrl, token, 'page-query', {
    action: 'pages',
    workspaceId,
    includeTrash: true,
  });
  throw new Error(
    `temporary workspace ${workspaceId} still has pages before deleteWorkspace: ${JSON.stringify(remaining?.pages ?? [])}`,
  );
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  });
  const body = await response.text();
  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
}

async function signIn(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert(typeof body?.accessToken === 'string' && body.accessToken, 'anonymous sign-in must return an access token');
  assert(typeof body?.user?.id === 'string' && body.user.id, 'anonymous sign-in must return a user id');
  return {
    token: body.accessToken,
    refreshToken: typeof body?.refreshToken === 'string' ? body.refreshToken : '',
    userId: body.user.id,
  };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(redactSensitive(json))}`);
  }
  return json;
}

async function callFunctionWithRetry(baseUrl, token, name, body, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await callFunction(baseUrl, token, name, body);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/503|worker restarted mid-request|try sending the request again/i.test(message) || attempt >= attempts - 1) {
        throw error;
      }
      await delay(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? `${name} failed`));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callPublicFunction(baseUrl, name, body) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(redactSensitive(json))}`);
  }
  return json;
}

async function assertSourceRootPageChrome(notionToken, runOptions) {
  if (!runOptions.expectSourceRootApiIcon && !runOptions.expectSourceRootApiCover) return;
  assert(
    runOptions.rootNotionPageIds.length > 0,
    'source root API chrome expectations require at least one --root-notion-page-id',
  );

  for (const rootPageId of runOptions.rootNotionPageIds) {
    const page = await fetchNotionPage(notionToken, rootPageId);
    const iconPresent = notionApiPageIconPresent(page);
    const coverPresent = notionApiPageCoverPresent(page);

    if (runOptions.expectSourceRootApiIcon) {
      assert(
        (runOptions.expectSourceRootApiIcon === 'present') === iconPresent,
        `source Notion API root page ${rootPageId} icon should be ${runOptions.expectSourceRootApiIcon}, got ${iconPresent ? 'present' : 'absent'}`,
      );
    }
    if (runOptions.expectSourceRootApiCover) {
      assert(
        (runOptions.expectSourceRootApiCover === 'present') === coverPresent,
        `source Notion API root page ${rootPageId} cover should be ${runOptions.expectSourceRootApiCover}, got ${coverPresent ? 'present' : 'absent'}`,
      );
    }
  }
}

async function fetchNotionPage(notionToken, pageId) {
  const response = await fetchWithTimeout(`${NOTION_API_BASE}/pages/${encodeURIComponent(pageId)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': NOTION_API_VERSION,
    },
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`Notion pages.retrieve returned HTTP ${response.status}: ${JSON.stringify(redactSensitive(json))}`);
  }
  return json;
}

function notionApiPageIconPresent(page) {
  const icon = page?.icon && typeof page.icon === 'object' ? page.icon : null;
  if (!icon) return false;
  return !!(icon.emoji || icon.external?.url || icon.file?.url);
}

function notionApiPageCoverPresent(page) {
  const cover = page?.cover && typeof page.cover === 'object' ? page.cover : null;
  if (!cover) return false;
  return !!(cover.external?.url || cover.file?.url);
}

function assertPublicRootPageChrome(publicPayload, runOptions) {
  if (!runOptions.expectPublicRootIcon && !runOptions.expectPublicRootCover) return;
  const page = publicPayload?.page;
  assert(page?.id, 'public imported root share must include a root page before checking page chrome');

  if (runOptions.expectPublicRootIcon) {
    const actualIconType = page.icon && page.iconType ? page.iconType : 'none';
    assert(
      actualIconType === runOptions.expectPublicRootIcon,
      `public imported root page icon should be ${runOptions.expectPublicRootIcon}, got ${actualIconType}`,
    );
  }

  if (runOptions.expectPublicRootCover) {
    const coverPresent = typeof page.cover === 'string' && page.cover.trim().length > 0;
    assert(
      (runOptions.expectPublicRootCover === 'present') === coverPresent,
      `public imported root page cover should be ${runOptions.expectPublicRootCover}, got ${coverPresent ? 'present' : 'absent'}`,
    );
  }
}

function assertRejectedPublicDatabaseTitles(publicPayload, rejectedTitles) {
  if (rejectedTitles.length === 0) return;
  const rejected = new Set(rejectedTitles.map((title) => String(title || '').trim()).filter(Boolean));
  if (rejected.size === 0) return;
  const pages = Array.isArray(publicPayload?.pages) ? publicPayload.pages : [];
  const matches = pages
    .filter((page) => page?.kind === 'database' && rejected.has(String(page?.title ?? '').trim()))
    .map((page) => ({ id: page.id, title: page.title, parentType: page.parentType, parentId: page.parentId }));
  assert(
    matches.length === 0,
    `public imported share must not include rejected database titles: ${JSON.stringify(matches)}`,
  );
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function redactSensitive(value) {
  if (!value || typeof value !== 'object') return value;
  const json = JSON.stringify(value);
  let redacted = json;
  for (const token of LIVE_NOTION_TOKEN_ENV_NAMES.map((name) => process.env[name]).filter(Boolean)) {
    redacted = redacted.split(token).join('[redacted-notion-token]');
  }
  return JSON.parse(redacted);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
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
    'Playwright is required to capture live Notion import screenshots. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    allowEmpty: false,
    apply: false,
    expectPlanApplyCounts: false,
    expectFirstViewName: '',
    expectCollapsedBlockTexts: [],
    expectImportedInlineDatabaseTabs: [],
    expectImportedInlineDatabaseSectionTabs: [],
    expectImportedOwnerVisibleTexts: [],
    expectImportedOwnerRowPeekVisibleTexts: [],
    expectPublicRootCover: '',
    expectPublicRootIcon: '',
    expectPublicComputedValues: [],
    expectPublicPropertyTypes: [],
    expectPublicRowProperties: [],
    expectPublicRowPeekPropertyOrders: [],
    expectPublicRowPeekVisibleTexts: [],
    expectPublicVisibleTexts: [],
    expectPublicViewConfigProperties: [],
    expectPublicViewHiddenProperties: [],
    expectPublicViewQuickFilters: [],
    expectPublicViewSortOrders: [],
    expectPublicViewTypes: [],
    expectPublicTexts: [],
    expectPublicViewTabs: [],
    expectViewPropertyOrders: [],
    capturePublicColorScheme: 'light',
    captureImportedOwnerScreenshotDir: '',
    capturePublicScreenshotDir: '',
    capturePublicVisibleTextScreenshots: false,
    headed: false,
    discoveryConcurrency: 4,
    includeMarkdownFallback: true,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxDiscoveryPages: 1,
    maxEnrichedItems: 5,
    maxViewPages: 1,
    rejectPublicTexts: [],
    rejectPublicDatabaseTitles: [],
    rejectPublicVisibleTexts: [],
    rejectPublicRowPeekVisibleTexts: [],
    rejectPublicViewTabs: [],
    preflight: true,
    requireToken: false,
    rootNotionPageIds: parseStringList(process.env.HANJI_LIVE_NOTION_ROOT_PAGE_IDS ?? ''),
    shareImportedRoot: false,
    expectSourceRootApiCover: '',
    expectSourceRootApiIcon: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--allow-empty') {
      parsed.allowEmpty = true;
      continue;
    }
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--share-imported-root') {
      parsed.shareImportedRoot = true;
      continue;
    }
    if (arg === '--capture-public-screenshot-dir') {
      parsed.capturePublicScreenshotDir = resolve(resolveValue(args, i, arg));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--capture-imported-owner-screenshot-dir') {
      parsed.captureImportedOwnerScreenshotDir = resolve(resolveValue(args, i, arg));
      parsed.apply = true;
      i += 1;
      continue;
    }
    if (arg === '--capture-public-color-scheme') {
      parsed.capturePublicColorScheme = parseCapturePublicColorScheme(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--capture-public-visible-text-screenshots') {
      parsed.capturePublicVisibleTextScreenshots = true;
      parsed.shareImportedRoot = true;
      continue;
    }
    if (arg === '--headed') {
      parsed.headed = true;
      continue;
    }
    if (arg === '--skip-preflight') {
      parsed.preflight = false;
      continue;
    }
    if (arg === '--skip-markdown-fallback') {
      parsed.includeMarkdownFallback = false;
      continue;
    }
    if (arg === '--expect-plan-apply-counts') {
      parsed.expectPlanApplyCounts = true;
      continue;
    }
    if (arg === '--expect-source-root-api-icon') {
      parsed.expectSourceRootApiIcon = parseAvailabilityExpectation(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--expect-source-root-api-cover') {
      parsed.expectSourceRootApiCover = parseAvailabilityExpectation(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--expect-public-root-icon') {
      parsed.expectPublicRootIcon = parsePublicRootIconExpectation(resolveValue(args, i, arg), arg);
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-root-cover') {
      parsed.expectPublicRootCover = parseAvailabilityExpectation(resolveValue(args, i, arg), arg);
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-text') {
      parsed.expectPublicTexts.push(resolveValue(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--reject-public-text') {
      parsed.rejectPublicTexts.push(resolveValue(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--reject-public-database-title') {
      parsed.rejectPublicDatabaseTitles.push(resolveValue(args, i, arg));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--reject-public-visible-text') {
      parsed.rejectPublicVisibleTexts.push(resolveValue(args, i, arg));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-visible-text') {
      parsed.expectPublicVisibleTexts.push(resolveValue(args, i, arg));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--reject-public-view-tab') {
      parsed.rejectPublicViewTabs.push(resolveValue(args, i, arg).trim());
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-view-tab') {
      parsed.expectPublicViewTabs.push(resolveValue(args, i, arg).trim());
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-imported-inline-database-tab') {
      parsed.expectImportedInlineDatabaseTabs.push(resolveValue(args, i, arg).trim());
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-imported-inline-database-section-tab') {
      parsed.expectImportedInlineDatabaseSectionTabs.push(resolveValue(args, i, arg).trim());
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-imported-owner-visible-text') {
      parsed.expectImportedOwnerVisibleTexts.push(resolveValue(args, i, arg));
      parsed.apply = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-imported-owner-row-peek-visible-text') {
      parsed.expectImportedOwnerRowPeekVisibleTexts.push(parsePublicRowPeekVisibleText(resolveValue(args, i, arg), arg));
      parsed.apply = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-first-view') {
      parsed.expectFirstViewName = resolveValue(args, i, arg).trim();
      i += 1;
      continue;
    }
    if (arg === '--expect-collapsed-block-text') {
      parsed.expectCollapsedBlockTexts.push(resolveValue(args, i, arg).trim());
      i += 1;
      continue;
    }
    if (arg === '--expect-view-property-order') {
      parsed.expectViewPropertyOrders.push(parseViewPropertyOrder(resolveValue(args, i, arg)));
      i += 1;
      continue;
    }
    if (arg === '--expect-public-view-hidden-property') {
      parsed.expectPublicViewHiddenProperties.push(parseViewPropertyList(resolveValue(args, i, arg), arg));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-view-config-property') {
      parsed.expectPublicViewConfigProperties.push(parsePublicViewConfigProperty(resolveValue(args, i, arg)));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-view-quick-filter') {
      parsed.expectPublicViewQuickFilters.push(parsePublicViewQuickFilter(resolveValue(args, i, arg)));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-view-sort-order') {
      parsed.expectPublicViewSortOrders.push(parsePublicViewSortOrder(resolveValue(args, i, arg)));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-view-type') {
      parsed.expectPublicViewTypes.push(parsePublicViewType(resolveValue(args, i, arg)));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-property-type') {
      parsed.expectPublicPropertyTypes.push(parsePublicPropertyType(resolveValue(args, i, arg)));
      i += 1;
      continue;
    }
    if (arg === '--expect-public-computed-value') {
      parsed.expectPublicComputedValues.push(parsePublicComputedValue(resolveValue(args, i, arg)));
      i += 1;
      continue;
    }
    if (arg === '--expect-public-row-property') {
      parsed.expectPublicRowProperties.push(parsePublicRowProperty(resolveValue(args, i, arg)));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-row-peek-visible-text') {
      parsed.expectPublicRowPeekVisibleTexts.push(parsePublicRowPeekVisibleText(resolveValue(args, i, arg), arg));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--reject-public-row-peek-visible-text') {
      parsed.rejectPublicRowPeekVisibleTexts.push(parsePublicRowPeekVisibleText(resolveValue(args, i, arg), arg));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--expect-public-row-peek-property-order') {
      parsed.expectPublicRowPeekPropertyOrders.push(parsePublicRowPeekPropertyOrder(resolveValue(args, i, arg)));
      parsed.shareImportedRoot = true;
      i += 1;
      continue;
    }
    if (arg === '--require-token') {
      parsed.requireToken = true;
      continue;
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--root-notion-page-id') {
      parsed.rootNotionPageIds.push(resolveValue(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = parsePositive(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--max-discovery-pages') {
      parsed.maxDiscoveryPages = parsePositive(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--max-enriched-items') {
      parsed.maxEnrichedItems = parsePositive(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--max-children-pages') {
      parsed.maxChildrenPages = parsePositive(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--max-data-source-query-pages') {
      parsed.maxDataSourceQueryPages = parsePositive(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--max-view-pages') {
      parsed.maxViewPages = parsePositive(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    if (arg === '--discovery-concurrency') {
      parsed.discoveryConcurrency = parsePositive(resolveValue(args, i, arg), arg);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.rootNotionPageIds = Array.from(new Set(parsed.rootNotionPageIds.map((id) => id.trim()).filter(Boolean)));
  if (parsed.capturePublicVisibleTextScreenshots && !parsed.capturePublicScreenshotDir) {
    throw new Error('--capture-public-visible-text-screenshots requires --capture-public-screenshot-dir <dir>');
  }
  return parsed;
}

function normalizedNotionId(value) {
  return typeof value === 'string'
    ? value.trim().replace(/-/g, '').toLowerCase()
    : '';
}

function parseStringList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseViewPropertyOrder(value) {
  return parseViewPropertyList(value, '--expect-view-property-order');
}

function parseViewPropertyList(value, label) {
  const raw = String(value || '');
  const separator = raw.indexOf(':');
  if (separator < 1) {
    throw new Error(`${label} must use "View name:Property,Property" format`);
  }
  const viewName = raw.slice(0, separator).trim();
  const propertyNames = parseStringList(raw.slice(separator + 1));
  if (!viewName || propertyNames.length === 0) {
    throw new Error(`${label} must include a view name and at least one property`);
  }
  return { viewName, propertyNames };
}

function parsePublicViewQuickFilter(value) {
  const spec = parseViewPropertySpec(value, '--expect-public-view-quick-filter');
  const separator = spec.value.indexOf(':');
  if (separator < 1) {
    throw new Error('--expect-public-view-quick-filter must use "View name:Property=operator:value" format');
  }
  const operator = spec.value.slice(0, separator).trim();
  const parsedValue = spec.value.slice(separator + 1).trim();
  if (!operator || !parsedValue) {
    throw new Error('--expect-public-view-quick-filter must include an operator and value');
  }
  return {
    viewName: spec.viewName,
    propertyName: spec.propertyName,
    operator,
    value: parsedValue,
  };
}

function parsePublicViewConfigProperty(value) {
  const spec = parseViewPropertySpec(value, '--expect-public-view-config-property');
  const allowed = new Set([
    'groupBy',
    'subGroupBy',
    'calendarBy',
    'timelineBy',
    'timelineEndBy',
    'coverProperty',
    'dependencyProperty',
  ]);
  if (!allowed.has(spec.propertyName)) {
    throw new Error(`--expect-public-view-config-property key must be one of ${Array.from(allowed).join(', ')}`);
  }
  return {
    viewName: spec.viewName,
    configKey: spec.propertyName,
    propertyName: spec.value,
  };
}

function parsePublicViewSortOrder(value) {
  const raw = String(value || '');
  const separator = raw.indexOf(':');
  if (separator < 1) {
    throw new Error('--expect-public-view-sort-order must use "View name:Property=asc,Property=desc" format');
  }
  const viewName = raw.slice(0, separator).trim();
  const sorts = parseStringList(raw.slice(separator + 1)).map((item) => {
    const equals = item.lastIndexOf('=');
    if (equals < 1) {
      throw new Error('--expect-public-view-sort-order entries must use "Property=asc" or "Property=desc"');
    }
    const propertyName = item.slice(0, equals).trim();
    const direction = item.slice(equals + 1).trim().toLowerCase();
    if (!propertyName || !['asc', 'desc'].includes(direction)) {
      throw new Error('--expect-public-view-sort-order entries must include a property name and asc/desc direction');
    }
    return { propertyName, direction };
  });
  if (!viewName || sorts.length === 0) {
    throw new Error('--expect-public-view-sort-order must include a view name and at least one sort');
  }
  return { viewName, sorts };
}

function parsePublicViewType(value) {
  const raw = String(value || '');
  const equals = raw.lastIndexOf('=');
  if (equals < 1) {
    throw new Error('--expect-public-view-type must use "View name=table|board|list|gallery|calendar|timeline" format');
  }
  const viewName = raw.slice(0, equals).trim();
  const type = raw.slice(equals + 1).trim().toLowerCase();
  const allowed = new Set(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']);
  if (!viewName || !allowed.has(type)) {
    throw new Error('--expect-public-view-type must include a view name and supported view type');
  }
  return { viewName, type };
}

function parseViewPropertySpec(value, label) {
  const raw = String(value || '');
  const separator = raw.indexOf(':');
  const equals = raw.indexOf('=', separator + 1);
  if (separator < 1 || equals <= separator + 1) {
    throw new Error(`${label} must use "View name:Property=value" format`);
  }
  const viewName = raw.slice(0, separator).trim();
  const propertyName = raw.slice(separator + 1, equals).trim();
  const parsedValue = raw.slice(equals + 1).trim();
  if (!viewName || !propertyName || !parsedValue) {
    throw new Error(`${label} must include a view name, property name, and value`);
  }
  return { viewName, propertyName, value: parsedValue };
}

function parsePublicPropertyType(value) {
  const spec = parseViewPropertySpec(value, '--expect-public-property-type');
  return { viewName: spec.viewName, propertyName: spec.propertyName, type: spec.value };
}

function parsePublicComputedValue(value) {
  return parseViewPropertySpec(value, '--expect-public-computed-value');
}

function parsePublicRowProperty(value) {
  const raw = String(value || '');
  const firstSeparator = raw.indexOf(':');
  const secondSeparator = raw.indexOf(':', firstSeparator + 1);
  const equals = raw.indexOf('=', secondSeparator + 1);
  if (firstSeparator < 1 || secondSeparator <= firstSeparator + 1 || equals <= secondSeparator + 1) {
    throw new Error('--expect-public-row-property must use "View name:Row title:Property=value" format');
  }
  const viewName = raw.slice(0, firstSeparator).trim();
  const rowTitle = raw.slice(firstSeparator + 1, secondSeparator).trim();
  const propertyName = raw.slice(secondSeparator + 1, equals).trim();
  const parsedValue = raw.slice(equals + 1).trim();
  if (!viewName || !rowTitle || !propertyName || !parsedValue) {
    throw new Error('--expect-public-row-property must include a view name, row title, property name, and value');
  }
  return {
    viewName,
    rowTitle,
    propertyName,
    value: parsedValue,
  };
}

function parsePublicRowPeekVisibleText(value, label = '--expect-public-row-peek-visible-text') {
  const raw = String(value || '');
  const firstSeparator = raw.indexOf(':');
  const secondSeparator = raw.indexOf(':', firstSeparator + 1);
  if (firstSeparator < 1 || secondSeparator <= firstSeparator + 1 || secondSeparator >= raw.length - 1) {
    throw new Error(`${label} must use "View name:Row title:Visible text" format`);
  }
  const viewName = raw.slice(0, firstSeparator).trim();
  const rowTitle = raw.slice(firstSeparator + 1, secondSeparator).trim();
  const text = raw.slice(secondSeparator + 1).trim();
  if (!viewName || !rowTitle || !text) {
    throw new Error(`${label} must include a view name, row title, and visible text`);
  }
  return { viewName, rowTitle, text };
}

function parsePublicRowPeekPropertyOrder(value) {
  const raw = String(value || '');
  const firstSeparator = raw.indexOf(':');
  const secondSeparator = raw.indexOf(':', firstSeparator + 1);
  if (firstSeparator < 1 || secondSeparator <= firstSeparator + 1 || secondSeparator >= raw.length - 1) {
    throw new Error('--expect-public-row-peek-property-order must use "View name:Row title:Property,Property" format');
  }
  const viewName = raw.slice(0, firstSeparator).trim();
  const rowTitle = raw.slice(firstSeparator + 1, secondSeparator).trim();
  const propertyNames = raw
    .slice(secondSeparator + 1)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!viewName || !rowTitle || propertyNames.length === 0) {
    throw new Error('--expect-public-row-peek-property-order must include a view name, row title, and at least one property');
  }
  return { viewName, rowTitle, propertyNames };
}

function parseAvailabilityExpectation(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'present' || normalized === 'absent') return normalized;
  throw new Error(`${label} must be "present" or "absent"`);
}

function parsePublicRootIconExpectation(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'none' || normalized === 'emoji' || normalized === 'image') return normalized;
  throw new Error(`${label} must be "none", "emoji", or "image"`);
}

function parseCapturePublicColorScheme(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'light' || normalized === 'dark') return normalized;
  throw new Error(`${label} must be "light" or "dark"`);
}

function parsePositive(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return Math.floor(parsed);
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/notion-import-live-smoke.mjs [options]

Checks live Notion API discovery and dry-run review through the Hanji
product API using NOTION_TOKEN or HANJI_NOTION_TOKEN. The smoke never
prints the token or discovered page titles, does not apply the import by
default, and deletes its temporary local workspace when finished.

Options:
  --url <url>                         Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --root-notion-page-id <id>          Add an explicit root Notion page id. Can be repeated.
  --apply                             Apply the discovered graph before cleanup.
  --share-imported-root               Share the imported explicit root page and read the public payload.
  --capture-imported-owner-screenshot-dir <dir> Capture the imported root page as the signed-in owner into this directory.
  --capture-public-screenshot-dir <dir> Capture the imported public share page into this directory.
  --capture-public-color-scheme <light|dark> Capture/render the public share using this color scheme. Defaults to light.
  --capture-public-visible-text-screenshots Capture one screenshot centered on each --expect-public-visible-text value. Requires --capture-public-screenshot-dir.
  --headed                            Show the browser when capturing a screenshot.
  --skip-preflight                    Skip explicit-root Notion API preflight before discovery.
  --skip-markdown-fallback            Skip Notion /pages/{id}/markdown fallback during discovery; block/page/database API import still runs.
  --expect-plan-apply-counts          Require dry-run write estimates to match apply counts where both report a count.
  --expect-source-root-api-icon <present|absent> Require explicit root page icon availability in the source Notion API payload.
  --expect-source-root-api-cover <present|absent> Require explicit root page cover availability in the source Notion API payload.
  --expect-public-root-icon <none|emoji|image> Require the imported public root page icon type.
  --expect-public-root-cover <present|absent> Require the imported public root page cover availability.
  --expect-public-text <text>         Require the imported public share payload to contain text. Can be repeated.
  --reject-public-text <text>         Require the imported public share payload not to contain text. Can be repeated.
  --reject-public-database-title <text> Require imported public database page titles not to equal this text. Can be repeated.
  --expect-public-visible-text <text> Require the rendered imported public share to show visible text. Can be repeated.
  --reject-public-visible-text <text> Require the rendered imported public share not to show visible text. Can be repeated.
  --expect-public-view-tab <text>     Require the rendered imported public share to show a view tab. Can be repeated.
  --reject-public-view-tab <text>     Require the rendered imported public share not to show a view tab. Can be repeated.
  --expect-imported-inline-database-tab <text> Require a rendered imported inline database to use this active view tab and compact tab/toolbar/table density. Can be repeated.
  --expect-imported-inline-database-section-tab <text> Require the rendered imported inline database to keep a Notion heading+database section wrapper. Can be repeated.
  --expect-imported-owner-visible-text <text> Require the rendered signed-in owner imported root page to show visible text. Can be repeated.
  --expect-imported-owner-row-peek-visible-text <spec> Open a signed-in owner imported database row and require visible text in its row peek, formatted as "View name:Row title:Visible text".
  --expect-first-view <name>          Require the first public database view to have this name.
  --expect-collapsed-block-text <text> Require a public block with this text to start collapsed.
  --expect-view-property-order <spec> Require a public database view property order prefix, formatted as "View name:Property,Property".
  --expect-public-view-hidden-property <spec> Require a public database view hidden property, formatted as "View name:Property,Property".
  --expect-public-view-config-property <spec> Require a view config property reference, formatted as "View name:configKey=Property".
  --expect-public-view-quick-filter <spec> Require a public database view quick filter, formatted as "View name:Property=operator:value".
  --expect-public-view-sort-order <spec> Require a public database view sort prefix, formatted as "View name:Property=asc,Property=desc".
  --expect-public-view-type <spec>  Require a public database view type, formatted as "View name=table|board|list|gallery|calendar|timeline".
  --expect-public-property-type <spec> Require a public database property type, formatted as "View name:Property=type".
  --expect-public-computed-value <spec> Require a formula/rollup computed value in a public database row, formatted as "View name:Property=value".
  --expect-public-row-property <spec> Require an imported public database row property value, formatted as "View name:Row title:Property=value".
  --expect-public-row-peek-visible-text <spec> Open a rendered imported public database row and require visible text in its row peek, formatted as "View name:Row title:Visible text".
  --reject-public-row-peek-visible-text <spec> Open a rendered imported public database row and reject visible text in its row peek, formatted as "View name:Row title:Visible text".
  --expect-public-row-peek-property-order <spec> Open a rendered imported public database row and require the row peek property order prefix, formatted as "View name:Row title:Property,Property".
  --allow-empty                       Allow token/search preflight to pass with zero discovered items.
  --require-token                     Fail instead of skipping when no live Notion token is configured.
  --max-discovery-pages <number>      Search pages to fetch. Defaults to 1.
  --max-enriched-items <number>       Search items to enrich. Defaults to 5.
  --max-children-pages <number>       Child pagination pages per page. Defaults to 1.
  --max-data-source-query-pages <n>   Row pagination pages per data source. Defaults to 1.
  --max-view-pages <number>           View pagination pages per data source. Defaults to 1.
  --discovery-concurrency <number>    Concurrent discovery requests. Defaults to 4; backend caps it safely.
  --timeout-ms <number>               Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
