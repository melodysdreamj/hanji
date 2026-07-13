#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  permanentlyDeletePage,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'inline-database');
const PROPERTY_DIALOG_LABEL = 'Property visibility';
const SHOWN_SECTION_LABEL = 'Shown in table';
const HIDDEN_SECTION_LABEL = 'Hidden in table';

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error && error.stack ? error.stack : message;
  console.error(`\nFAIL inline database visual smoke: ${detail}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('inline database visual smoke');
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Inline database visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Inline database visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedInlineDatabasePage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertInlineDatabasePage(browser, appUrl, apiUrl, seed);
    console.log('PASS inline database visual layout is captured and stays within the Notion-style embedded database contract.');
    console.log(`Screenshot: ${join(options.screenshotDir, 'desktop-inline-database.png')}`);
    console.log(`Empty inline database screenshot: ${join(options.screenshotDir, 'desktop-empty-inline-database.png')}`);
    console.log(`Empty inline database hover screenshot: ${join(options.screenshotDir, 'desktop-empty-inline-database-hover-new-row.png')}`);
    console.log(`Empty inline database new row screenshot: ${join(options.screenshotDir, 'desktop-empty-inline-database-new-row.png')}`);
    console.log(`Hover screenshot: ${join(options.screenshotDir, 'desktop-inline-database-hover.png')}`);
    console.log(`Title menu screenshot: ${join(options.screenshotDir, 'desktop-inline-database-title-menu.png')}`);
    console.log(`Settings menu screenshot: ${join(options.screenshotDir, 'desktop-inline-database-settings-menu.png')}`);
    console.log(`Layout menu screenshot: ${join(options.screenshotDir, 'desktop-inline-database-layout-menu.png')}`);
    console.log(`Properties submenu screenshot: ${join(options.screenshotDir, 'desktop-inline-database-properties-submenu.png')}`);
    console.log(`Property edit screenshot: ${join(options.screenshotDir, 'desktop-inline-database-property-edit.png')}`);
    console.log(`New property types screenshot: ${join(options.screenshotDir, 'desktop-inline-database-new-property-types.png')}`);
    console.log(`Dark screenshot: ${join(options.screenshotDir, 'desktop-inline-database-dark.png')}`);
    console.log(`Mobile screenshot: ${join(options.screenshotDir, 'mobile-inline-database.png')}`);
    console.log(`Mobile dark screenshot: ${join(options.screenshotDir, 'mobile-inline-database-dark.png')}`);
    console.log(`Column screenshot: ${join(options.screenshotDir, 'desktop-column-inline-databases.png')}`);
    console.log(`Column dark screenshot: ${join(options.screenshotDir, 'desktop-column-inline-databases-dark.png')}`);
    console.log(`Column mobile screenshot: ${join(options.screenshotDir, 'mobile-column-inline-databases.png')}`);
    console.log(`Column mobile dark screenshot: ${join(options.screenshotDir, 'mobile-column-inline-databases-dark.png')}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertInlineDatabasePage(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  }, { captureFunctionResponses: true });
  await installBrowserSession(context, seed, {
    appOrigin: appUrl,
    authOrigin: apiUrl,
    workspaceId: seed.workspaceId,
    localStorage: { 'hanji:theme': 'light' },
  });

  try {
    await openInlineDatabasePage(page, appUrl, seed);
    await moveMouseToIdleChrome(page);
    await assertInlineDatabaseVisualContract(page, seed, { mobile: false });
    await assertPopulatedInlineDatabaseAddPropertyHeader(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-inline-database.png'),
      fullPage: false,
    });
    await assertInlineDatabaseScopedViewAdd(page, apiUrl, seed);
    await assertInlineDatabaseTitleMenuActions(page, apiUrl, seed);
    await assertLinkedDatabaseSourceScopedViewAdd(page, apiUrl, seed);
    await assertLinkedInlineDatabaseTitleNavigation(page, seed);
    await reopenInlineDatabasePageAfterNavigation(page, appUrl, seed);
    await scrollToEmptyInlineDatabase(page, seed);
    await moveMouseToIdleChrome(page);
    await assertEmptyInlineDatabaseVisualContract(page, seed);
    await assertLocalInlineDatabaseTitleEditing(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-empty-inline-database.png'),
      fullPage: false,
    });
    await assertEmptyInlineDatabasePreviewRowHover(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-empty-inline-database-hover-new-row.png'),
      fullPage: false,
    });
    await assertEmptyInlineDatabaseNewRowFocus(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-empty-inline-database-new-row.png'),
      fullPage: false,
    });
    await openInlineDatabasePage(page, appUrl, seed);
    await moveMouseToIdleChrome(page);
    await assertInlineDatabaseToolbarReveal(page, seed.inlineBlockId);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-inline-database-hover.png'),
      fullPage: false,
    });
    await assertInlineDatabaseSettingsMenu(page, seed.inlineBlockId);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-inline-database-settings-menu.png'),
      fullPage: false,
    });
    await assertInlineDatabaseLayoutSubmenu(page);
    await assertInlineDatabaseSettingsMenu(page, seed.inlineBlockId);
    await assertInlineDatabaseSettingsSubmenu(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-inline-database-properties-submenu.png'),
      fullPage: false,
    });
    await page.keyboard.press('Escape').catch(() => {});
    await assertInlineDatabaseSettingsMenu(page, seed.inlineBlockId);
    await assertInlineDatabaseSourcePropertyEditMenu(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-inline-database-property-edit.png'),
      fullPage: false,
    });
    await assertInlineDatabaseNewPropertyTypeMenu(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-inline-database-new-property-types.png'),
      fullPage: false,
    });
    await assertInlineDatabaseNewPropertyTypeSelection(page);
    await page.mouse.move(12, 12);
    await page.getByRole('button', { name: 'Close properties' }).click({ timeout: options.timeoutMs });
    await setTheme(page, 'dark');
    await moveMouseToIdleChrome(page);
    await assertInlineDatabaseVisualContract(page, seed, { mobile: false });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-inline-database-dark.png'),
      fullPage: false,
    });
    await setViewport(page, { width: 390, height: 844 });
    await setTheme(page, 'light');
    await moveMouseToIdleChrome(page);
    await assertInlineDatabaseVisualContract(page, seed, { mobile: true });
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-inline-database.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await moveMouseToIdleChrome(page);
    await assertInlineDatabaseVisualContract(page, seed, { mobile: true });
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-inline-database-dark.png'),
      fullPage: false,
    });
    await setViewport(page, { width: 1440, height: 1000 });
    await setTheme(page, 'light');
    await scrollToColumnInlineDatabases(page, seed);
    await moveMouseToIdleChrome(page);
    await assertColumnInlineDatabaseVisualContract(page, seed, { mobile: false });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-column-inline-databases.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await scrollToColumnInlineDatabases(page, seed);
    await moveMouseToIdleChrome(page);
    await assertColumnInlineDatabaseVisualContract(page, seed, { mobile: false });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-column-inline-databases-dark.png'),
      fullPage: false,
    });
    await setViewport(page, { width: 390, height: 844 });
    await setTheme(page, 'light');
    await scrollToColumnInlineDatabases(page, seed);
    await moveMouseToIdleChrome(page);
    await assertColumnInlineDatabaseVisualContract(page, seed, { mobile: true });
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-column-inline-databases.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await scrollToColumnInlineDatabases(page, seed);
    await moveMouseToIdleChrome(page);
    await assertColumnInlineDatabaseVisualContract(page, seed, { mobile: true });
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-column-inline-databases-dark.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'inline database visual flow');
  } catch (error) {
    await page.screenshot({
      path: join(options.screenshotDir, 'inline-database-failure.png'),
      fullPage: false,
    }).catch(() => {});
    const diagnostics = await collectInlineDatabaseDiagnostics(page, seed).catch((diagnosticError) => ({
      diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
    }));
    console.error(`Inline database visual diagnostics: ${JSON.stringify({
      ...diagnostics,
      browserErrors: errors,
    }, null, 2)}`);
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

async function moveMouseToIdleChrome(page) {
  await page.mouse.move(8, 8);
  await page.waitForTimeout(80);
}

async function openInlineDatabasePage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (pageTitle) => document.body.innerText.includes(pageTitle),
    seed.pageTitle,
    { timeout: options.timeoutMs },
  );
  await page.waitForFunction(
    () => Boolean(document.querySelector('[role="region"][aria-label="Page body"], [data-page-search-root]')),
    null,
    { timeout: options.timeoutMs },
  );
  const rootInlineBlock = page.locator(`[data-block-id="${seed.inlineBlockId}"]`);
  await rootInlineBlock.waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await rootInlineBlock.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  await page.waitForFunction(
    ({ inlineBlockId, databaseTitle }) => {
      const inlineBlock = document.querySelector(`[data-block-id="${CSS.escape(inlineBlockId)}"]`);
      if (!(inlineBlock instanceof HTMLElement)) return false;
      const labeledTitle = Array.from(inlineBlock.querySelectorAll('[aria-label]')).some(
        (element) => element.getAttribute('aria-label') === `${databaseTitle} database title`
      );
      return labeledTitle || (inlineBlock.textContent ?? '').includes(databaseTitle);
    },
    { inlineBlockId: seed.inlineBlockId, databaseTitle: seed.databaseTitle },
    { timeout: options.timeoutMs },
  );
  await page.waitForFunction(
    (inlineBlockId) => {
      const inlineBlock = document.querySelector(`[data-block-id="${CSS.escape(inlineBlockId)}"]`);
      return Boolean(inlineBlock?.querySelector('[data-placement="inline"] [role="tab"][aria-selected="true"]'));
    },
    seed.inlineBlockId,
    { timeout: options.timeoutMs },
  );
  await page.waitForFunction(
    (inlineBlockId) => {
      const inlineBlock = document.querySelector(`[data-block-id="${CSS.escape(inlineBlockId)}"]`);
      return (inlineBlock?.querySelectorAll('[data-table-cell]').length ?? 0) >= 8;
    },
    seed.inlineBlockId,
    { timeout: options.timeoutMs },
  );
}

async function reopenInlineDatabasePageAfterNavigation(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ inlineBlockId, databaseTitle }) => {
      const inlineBlock = document.querySelector(`[data-block-id="${CSS.escape(inlineBlockId)}"]`);
      return Boolean(
        inlineBlock instanceof HTMLElement &&
          inlineBlock.querySelector('[data-inline-database-title]') &&
          (inlineBlock.textContent ?? '').includes(databaseTitle) &&
          inlineBlock.querySelector('[data-placement="inline"]'),
      );
    },
    { inlineBlockId: seed.inlineBlockId, databaseTitle: seed.databaseTitle },
    { timeout: options.timeoutMs },
  );
}

async function assertLinkedInlineDatabaseTitleNavigation(page, seed) {
  const title = page.locator(`[data-block-id="${seed.inlineBlockId}"] [data-inline-database-title]`).first();
  await title.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const affordance = await title.evaluate((element) => {
    const wrapper = element.closest('[data-inline-database-wrapper]');
    const openAction = wrapper?.querySelector('[data-inline-database-open-action="true"]');
    const openActionStyle = openAction instanceof HTMLElement ? getComputedStyle(openAction) : null;
    const titleRect = element.getBoundingClientRect();
    const openRect = openAction instanceof HTMLElement ? openAction.getBoundingClientRect() : null;
    return {
      clickable: element.getAttribute('data-inline-database-clickable'),
      editable: element.getAttribute('data-inline-database-editable-title'),
      hasDatabaseIcon: Boolean(wrapper?.querySelector('[data-inline-database-icon="true"]')),
      openActionLabel: openAction?.getAttribute('aria-label') ?? '',
      openActionOpacity: openActionStyle ? Number.parseFloat(openActionStyle.opacity || '1') : null,
      openActionPlacement: openAction?.getAttribute('data-inline-database-open-placement') ?? '',
      openActionPointerEvents: openActionStyle?.pointerEvents ?? null,
      openActionVisible: openAction instanceof HTMLElement && openAction.getBoundingClientRect().width > 0,
      openBeforeTitle: openRect ? openRect.right <= titleRect.left + 2 : false,
      role: element.getAttribute('role'),
      title: element.getAttribute('title'),
      text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    };
  });
  assert(
    affordance.clickable === 'true' &&
      affordance.editable !== 'true' &&
      affordance.role === 'link' &&
      affordance.hasDatabaseIcon === false &&
      affordance.openActionVisible === true &&
      affordance.openActionPlacement === 'leading' &&
      affordance.openActionOpacity >= 0.85 &&
      affordance.openActionPointerEvents !== 'none' &&
      affordance.openBeforeTitle &&
      affordance.openActionLabel.includes(seed.databaseTitle),
    `linked inline database title should show a leading open arrow and behave as a database link: ${JSON.stringify(affordance)}`,
  );

  await title.click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (databaseId) => location.pathname === `/p/${databaseId}`,
    seed.databaseId,
    { timeout: options.timeoutMs },
  );
  await page.waitForFunction(
    () => Boolean(document.querySelector('[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]')),
    null,
    { timeout: options.timeoutMs },
  );
  const destination = await page.evaluate(() => {
    const titleInput = document.querySelector('[aria-label="Page title"], [aria-label="페이지 제목"]');
    return {
      path: location.pathname,
      pageTitle:
        titleInput instanceof HTMLInputElement || titleInput instanceof HTMLTextAreaElement
          ? titleInput.value
          : titleInput?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    };
  });
  assert(
    destination.path === `/p/${seed.databaseId}` && destination.pageTitle.includes(seed.databaseTitle),
    `clicking the linked inline database title should navigate to the database page: ${JSON.stringify({ affordance, destination, expectedDatabaseId: seed.databaseId, expectedTitle: seed.databaseTitle })}`,
  );
  if (seed.scopedViewId) {
    await page.waitForFunction(
      (tableViewId) => Boolean(document.querySelector(`[data-view-tab="${CSS.escape(tableViewId)}"]`)),
      seed.tableViewId,
      { timeout: options.timeoutMs },
    );
    await page.waitForFunction(
      (scopedViewId) => !document.querySelector(`[data-view-tab="${CSS.escape(scopedViewId)}"]`),
      seed.scopedViewId,
      { timeout: options.timeoutMs },
    );
  }
}

async function assertLocalInlineDatabaseTitleEditing(page, seed) {
  const title = page.locator(`[data-block-id="${seed.emptyInlineBlockId}"] [data-inline-database-title]`).first();
  await title.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const affordance = await title.evaluate((element) => {
    const wrapper = element.closest('[data-inline-database-wrapper]');
    const openAction = wrapper?.querySelector('[data-inline-database-open-action="true"]');
    return {
      clickable: element.getAttribute('data-inline-database-clickable'),
      editable: element.getAttribute('data-inline-database-editable-title'),
      hasOpenAction: openAction instanceof HTMLElement,
      placeholder: element.getAttribute('data-inline-database-placeholder'),
      role: element.getAttribute('role'),
      text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      title: element.getAttribute('title'),
    };
  });
  assert(
    affordance.clickable !== 'true' &&
      affordance.editable === 'true' &&
      affordance.hasOpenAction === false &&
      affordance.placeholder === 'true' &&
      affordance.role === 'button',
    `local inline database title should be directly editable without a title-adjacent open arrow: ${JSON.stringify(affordance)}`,
  );

  const parentPath = await page.evaluate(() => location.pathname);
  await title.click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (emptyInlineBlockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
      const input = block?.querySelector('[data-inline-database-title]');
      return input instanceof HTMLInputElement && document.activeElement === input;
    },
    seed.emptyInlineBlockId,
    { timeout: options.timeoutMs },
  );
  const afterClick = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      language: document.documentElement.lang,
      path: location.pathname,
      titleIsInput: active instanceof HTMLInputElement && active.hasAttribute('data-inline-database-title'),
      placeholder: active instanceof HTMLInputElement ? active.placeholder : '',
      value: active instanceof HTMLInputElement ? active.value : '',
    };
  });
  const expectedPlaceholder = afterClick.language.toLowerCase().startsWith('ko')
    ? '새 데이터베이스'
    : 'New database';
  assert(
    afterClick.path === parentPath &&
      afterClick.titleIsInput &&
      afterClick.placeholder === expectedPlaceholder &&
      afterClick.value === '',
    `clicking a local inline database title should edit it in place, not navigate: ${JSON.stringify({ affordance, afterClick, parentPath })}`,
  );
  await page.evaluate((emptyInlineBlockId) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    const closePropertyMenu = document.querySelector('button[aria-label="Close property menu"]');
    if (closePropertyMenu instanceof HTMLElement) closePropertyMenu.click();
    return Boolean(block);
  }, seed.emptyInlineBlockId);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForFunction(
    (emptyInlineBlockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
      const title = block?.querySelector('[data-inline-database-title]');
      return !(title instanceof HTMLInputElement) && !document.querySelector('button[aria-label="Close property menu"]');
    },
    seed.emptyInlineBlockId,
    { timeout: options.timeoutMs },
  );
}

async function assertInlineDatabaseScopedViewAdd(page, apiUrl, seed) {
  const title = page.locator(`[data-block-id="${seed.inlineBlockId}"] [data-inline-database-title]`).first();
  const addButton = page.locator(`[data-block-id="${seed.inlineBlockId}"] [data-inline-database-add-view-action="true"]`).first();
  await title.hover({ timeout: options.timeoutMs });
  await addButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await addButton.click({ timeout: options.timeoutMs });
  const menu = page.getByRole('dialog', { name: 'New view' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const menuMetrics = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="New view"]');
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing add-view dialog' };
    const labels = Array.from(dialog.querySelectorAll('button'))
      .map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
    const rect = dialog.getBoundingClientRect();
    return {
      ok: true,
      labels,
      title: dialog.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      width: rect.width,
    };
  });
  assert(menuMetrics.ok, menuMetrics.reason ?? 'inline add-view menu should open');
  assert(
    ['Table', 'Board', 'Gallery', 'List', 'Timeline', 'Calendar'].every((label) => menuMetrics.labels.includes(label)),
    `inline add-view menu should expose Hanji view type choices: ${JSON.stringify(menuMetrics)}`,
  );
  assert(menuMetrics.width >= 240 && menuMetrics.width <= 320, `inline add-view menu should stay compact: ${JSON.stringify(menuMetrics)}`);

  await menu.getByRole('menuitem', { name: 'Board' }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (inlineBlockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(inlineBlockId)}"]`);
      const active = block?.querySelector('[data-placement="inline"] [role="tab"][aria-selected="true"]');
      return active?.textContent?.replace(/\s+/g, ' ').trim() === 'Board';
    },
    seed.inlineBlockId,
    { timeout: options.timeoutMs },
  );

  const persisted = await waitForPersistedInlineScopedView(apiUrl, seed, (state) => {
    const content = state.block?.content ?? {};
    const viewIds = Array.isArray(content.databaseViewIds) ? content.databaseViewIds : [];
    const activeId = typeof content.databaseViewId === 'string' ? content.databaseViewId : '';
    const view = state.database?.views?.find((item) => item.id === activeId);
    return (
      activeId &&
      activeId !== seed.tableViewId &&
      viewIds.includes(seed.tableViewId) &&
      viewIds.includes(activeId) &&
      view?.type === 'board' &&
      view?.config?.inlineDatabaseBlockId === seed.inlineBlockId &&
      view?.config?.inlineDatabaseSourceViewId === seed.tableViewId
    );
  });
  const scopedViewId = persisted.block.content.databaseViewId;
  seed.scopedViewId = scopedViewId;

  const sourcePageTabs = await page.evaluate((expected) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(expected.inlineBlockId)}"]`);
    return Array.from(block?.querySelectorAll('[data-placement="inline"] [role="tab"]') ?? []).map((tab) => ({
      id: tab.getAttribute('data-view-tab') ?? '',
      selected: tab.getAttribute('aria-selected') === 'true',
      text: tab.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
  }, { inlineBlockId: seed.inlineBlockId });
  assert(
    sourcePageTabs.some((tab) => tab.id === seed.tableViewId) &&
      sourcePageTabs.some((tab) => tab.id === scopedViewId && tab.text === 'Board' && tab.selected),
    `inline scoped view should appear only inside the linked inline database tab strip: ${JSON.stringify(sourcePageTabs)}`,
  );

  await page.locator(`[data-block-id="${seed.inlineBlockId}"] [data-view-tab="${seed.tableViewId}"]`).click({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ inlineBlockId, tableViewId }) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(inlineBlockId)}"]`);
      const active = block?.querySelector('[data-placement="inline"] [role="tab"][aria-selected="true"]');
      return active?.getAttribute('data-view-tab') === tableViewId;
    },
    { inlineBlockId: seed.inlineBlockId, tableViewId: seed.tableViewId },
    { timeout: options.timeoutMs },
  );
  await waitForPersistedInlineScopedView(apiUrl, seed, (state) => {
    const content = state.block?.content ?? {};
    return content.databaseViewId === seed.tableViewId &&
      Array.isArray(content.databaseViewIds) &&
      content.databaseViewIds.includes(scopedViewId);
  });
}

async function openInlineDatabaseTitleMenu(page, seed) {
  const blockSelector = `[data-block-id="${seed.inlineBlockId}"]`;
  await page.locator(`${blockSelector} [data-inline-database-title]`).first().hover({
    timeout: options.timeoutMs,
  });
  const menuButton = page.locator(`${blockSelector} [data-inline-database-action="menu"]`).first();
  await menuButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menuButton.click({ timeout: options.timeoutMs });
  const menu = page.getByRole('menu', { name: `${seed.databaseTitle} options` });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return menu;
}

async function assertInlineDatabaseTitleMenuActions(page, apiUrl, seed) {
  const menu = await openInlineDatabaseTitleMenu(page, seed);
  const menuMetrics = await page.evaluate(() => {
    const dialog = document.querySelector('[role="menu"][aria-label$=" options"]');
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing inline database title menu' };
    const labels = Array.from(dialog.querySelectorAll('[role="menuitem"]'))
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
    const separators = dialog.querySelectorAll('[role="separator"]').length;
    const rect = dialog.getBoundingClientRect();
    return {
      ok: true,
      labels,
      separators,
      width: rect.width,
    };
  });
  assert(menuMetrics.ok, menuMetrics.reason ?? 'inline database title menu should open');
  assert(
    [
      'Copy view link',
      'Duplicate view',
      'View data source',
      'Edit title',
      'Edit icon',
      'Edit layout',
      'Hide title',
      'Manage in calendar',
    ].every((label) => menuMetrics.labels.includes(label)),
    `inline database title menu should expose Hanji database/view actions: ${JSON.stringify(menuMetrics)}`,
  );
  assert(menuMetrics.separators >= 2, `inline database title menu should group view, source, and display actions: ${JSON.stringify(menuMetrics)}`);
  assert(menuMetrics.width >= 260 && menuMetrics.width <= 320, `inline database title menu should stay compact: ${JSON.stringify(menuMetrics)}`);
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-inline-database-title-menu.png'),
    fullPage: false,
  });

  await menu.getByRole('menuitem', { name: 'Duplicate view' }).click({ timeout: options.timeoutMs });
  const duplicateState = await waitForPersistedInlineScopedView(apiUrl, seed, (state) => {
    const content = state.block?.content ?? {};
    const activeId = typeof content.databaseViewId === 'string' ? content.databaseViewId : '';
    const view = state.database?.views?.find((item) => item.id === activeId);
    return (
      activeId &&
      activeId !== seed.tableViewId &&
      view?.name === 'Default view copy' &&
      view?.type === 'table' &&
      view?.config?.inlineDatabaseBlockId === seed.inlineBlockId
    );
  });
  seed.duplicatedScopedViewId = duplicateState.block.content.databaseViewId;

  const layoutMenu = await openInlineDatabaseTitleMenu(page, seed);
  await layoutMenu.getByRole('menuitem', { name: 'Edit layout' }).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Layout options' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.getByRole('button', { name: 'Close layout options' }).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Layout options' }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  });

  const calendarMenu = await openInlineDatabaseTitleMenu(page, seed);
  await calendarMenu.getByRole('menuitem', { name: 'Manage in calendar' }).click({ timeout: options.timeoutMs });
  const calendarState = await waitForPersistedInlineScopedView(apiUrl, seed, (state) => {
    const content = state.block?.content ?? {};
    const activeId = typeof content.databaseViewId === 'string' ? content.databaseViewId : '';
    const view = state.database?.views?.find((item) => item.id === activeId);
    return (
      activeId &&
      activeId !== seed.tableViewId &&
      view?.type === 'calendar' &&
      view?.config?.inlineDatabaseBlockId === seed.inlineBlockId
    );
  });
  seed.calendarScopedViewId = calendarState.block.content.databaseViewId;

  await page.locator(`[data-block-id="${seed.inlineBlockId}"] [data-view-tab="${seed.tableViewId}"]`).click({
    timeout: options.timeoutMs,
  });
  await waitForPersistedInlineScopedView(apiUrl, seed, (state) => {
    const content = state.block?.content ?? {};
    return content.databaseViewId === seed.tableViewId;
  });
}

async function assertLinkedDatabaseSourceScopedViewAdd(page, apiUrl, seed) {
  const blockSelector = `[data-block-id="${seed.legacyLinkedInlineBlockId}"]`;
  const title = page.locator(`${blockSelector} [data-inline-database-title]`).first();
  await title.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await title.hover({ timeout: options.timeoutMs });
  const addButton = page.locator(`${blockSelector} [data-inline-database-add-view-action="true"]`).first();
  await addButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForFunction(
    (blockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      const add = block?.querySelector('[data-inline-database-add-view-action="true"]');
      if (!(add instanceof HTMLElement)) return false;
      const style = getComputedStyle(add);
      return Number.parseFloat(style.opacity || '0') >= 0.85 && style.pointerEvents === 'auto';
    },
    seed.legacyLinkedInlineBlockId,
    { timeout: options.timeoutMs },
  );

  const metrics = await page.evaluate((blockId) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    const open = block?.querySelector('[data-inline-database-open-action="true"]');
    const titleNode = block?.querySelector('[data-inline-database-title]');
    const add = block?.querySelector('[data-inline-database-add-view-action="true"]');
    const menu = block?.querySelector('[data-inline-database-action="menu"]');
    if (
      !(open instanceof HTMLElement) ||
      !(titleNode instanceof HTMLElement) ||
      !(add instanceof HTMLElement) ||
      !(menu instanceof HTMLElement)
    ) {
      return {
        ok: false,
        open: open instanceof HTMLElement,
        title: titleNode instanceof HTMLElement,
        add: add instanceof HTMLElement,
        menu: menu instanceof HTMLElement,
      };
    }
    const openRect = open.getBoundingClientRect();
    const titleRect = titleNode.getBoundingClientRect();
    const addRect = add.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const addStyle = getComputedStyle(add);
    return {
      ok: true,
      addOpacity: Number.parseFloat(addStyle.opacity || '1'),
      addPointerEvents: addStyle.pointerEvents,
      openRight: openRect.right,
      titleLeft: titleRect.left,
      titleRight: titleRect.right,
      addLeft: addRect.left,
      addRight: addRect.right,
      addWidth: addRect.width,
      menuLeft: menuRect.left,
    };
  }, seed.legacyLinkedInlineBlockId);
  assert(metrics.ok, `linked-source inline database title add-view markers are missing: ${JSON.stringify(metrics)}`);
  assert(
    metrics.addOpacity >= 0.85 &&
      metrics.addPointerEvents === 'auto' &&
      metrics.titleLeft - metrics.openRight >= 2 &&
      metrics.titleLeft - metrics.openRight <= 12 &&
      metrics.addWidth >= 18 &&
      metrics.addWidth <= 28 &&
      metrics.addLeft - metrics.titleRight >= 0 &&
      metrics.addLeft - metrics.titleRight <= 12 &&
      metrics.menuLeft - metrics.addRight >= 0 &&
      metrics.menuLeft - metrics.addRight <= 12,
    `linked-source inline database title row should expose open, title, add-view, and ellipsis controls in order: ${JSON.stringify(metrics)}`,
  );

  await addButton.click({ timeout: options.timeoutMs });
  const menu = page.getByRole('dialog', { name: 'New view' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('menuitem', { name: 'List' }).click({ timeout: options.timeoutMs });

  await waitForPersistedInlineScopedView(apiUrl, { ...seed, inlineBlockId: seed.legacyLinkedInlineBlockId }, (state) => {
    const content = state.block?.content ?? {};
    const viewIds = Array.isArray(content.databaseViewIds) ? content.databaseViewIds : [];
    const activeId = typeof content.databaseViewId === 'string' ? content.databaseViewId : '';
    const view = state.database?.views?.find((item) => item.id === activeId);
    return (
      activeId &&
      activeId !== seed.tableViewId &&
      viewIds.includes(seed.tableViewId) &&
      viewIds.includes(activeId) &&
      view?.type === 'list' &&
      view?.config?.inlineDatabaseBlockId === seed.legacyLinkedInlineBlockId &&
      view?.config?.inlineDatabaseSourceViewId === seed.tableViewId
    );
  });

  await page.locator(`${blockSelector} [data-view-tab="${seed.tableViewId}"]`).click({
    timeout: options.timeoutMs,
  });
  await waitForPersistedInlineScopedView(apiUrl, { ...seed, inlineBlockId: seed.legacyLinkedInlineBlockId }, (state) => {
    const content = state.block?.content ?? {};
    return content.databaseViewId === seed.tableViewId;
  });
  await page.getByRole('button', { name: 'Close add view menu' }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  }).catch(() => {});
  await page.locator(`[data-block-id="${seed.inlineBlockId}"] [data-inline-database-title]`).first().scrollIntoViewIfNeeded({
    timeout: options.timeoutMs,
  });
}

async function waitForPersistedInlineScopedView(apiUrl, seed, predicate) {
  const deadline = Date.now() + options.timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const [blocksResult, database] = await Promise.all([
      callFunction(apiUrl, seed.accessToken, 'page-query', {
        action: 'blocks',
        pageId: seed.pageId,
      }),
      callFunction(apiUrl, seed.accessToken, 'page-query', {
        action: 'database',
        databaseId: seed.databaseId,
      }),
    ]);
    const block = blocksResult.blocks?.find((item) => item.id === seed.inlineBlockId);
    lastState = { block, database };
    if (block && predicate(lastState)) return lastState;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Timed out waiting for persisted inline scoped view state: ${JSON.stringify(lastState)}`);
}

async function collectInlineDatabaseDiagnostics(page, seed) {
  return page.evaluate((expected) => {
    const blockSummary = (id) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      const rect = block instanceof HTMLElement ? block.getBoundingClientRect() : null;
      const databaseRoot = block?.querySelector('[data-placement]');
      const grid = block?.querySelector('[role="grid"]');
      return {
        ariaBusy: grid?.getAttribute('aria-busy') ?? null,
        exists: block instanceof HTMLElement,
        cellCount: block?.querySelectorAll('[data-table-cell]').length ?? null,
        emptyResults: block?.querySelectorAll('[data-table-empty-results]').length ?? null,
        inlineEmptyMarkers: block
          ? Array.from(block.querySelectorAll('[data-inline-empty-preview]')).map((element) => ({
              tag: element.tagName,
              value: element.getAttribute('data-inline-empty-preview'),
              rowHeight: element.getAttribute('data-row-height'),
            }))
          : [],
        rowHeightMarkers: block
          ? Array.from(block.querySelectorAll('[data-row-height]')).map((element) => ({
              tag: element.tagName,
              value: element.getAttribute('data-row-height'),
              inlineEmpty: element.getAttribute('data-inline-empty-preview'),
            }))
          : [],
        loadErrors: block
          ? Array.from(block.querySelectorAll('[data-table-load-error]')).map((element) =>
              element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          : [],
        placement: databaseRoot?.getAttribute('data-placement') ?? null,
        rect: rect
          ? {
              bottom: rect.bottom,
              height: rect.height,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              width: rect.width,
            }
          : null,
        text: block?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? null,
      };
    };
    return {
      allCellCount: document.querySelectorAll('[data-table-cell]').length,
      allTabs: Array.from(document.querySelectorAll('[role="tab"]')).map((tab) =>
        tab.textContent?.replace(/\s+/g, ' ').trim()
      ),
      bodyText: document.body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500),
      columnList: blockSummary(expected.columnListId),
      emptyInlineBlock: blockSummary(expected.emptyInlineBlockId),
      inlineBlock: blockSummary(expected.inlineBlockId),
      leftInlineBlock: blockSummary(expected.leftInlineBlockId),
      rightInlineBlock: blockSummary(expected.rightInlineBlockId),
      url: window.location.href,
    };
  }, {
    columnListId: seed.columnListId,
    emptyInlineBlockId: seed.emptyInlineBlockId,
    inlineBlockId: seed.inlineBlockId,
    leftInlineBlockId: seed.leftInlineBlockId,
    rightInlineBlockId: seed.rightInlineBlockId,
  });
}

async function scrollToColumnInlineDatabases(page, seed) {
  const columns = page.locator(`[data-block-id="${seed.columnListId}"]`);
  await columns.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await columns.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  await page.waitForFunction(
    (columnListId) => {
      const columnList = document.querySelector(`[data-block-id="${CSS.escape(columnListId)}"]`);
      if (!(columnList instanceof HTMLElement)) return false;
      const rect = columnList.getBoundingClientRect();
      return rect.top >= 72 && rect.top <= window.innerHeight - 120;
    },
    seed.columnListId,
    { timeout: options.timeoutMs },
  );
}

async function scrollToEmptyInlineDatabase(page, seed) {
  const emptyBlock = page.locator(`[data-block-id="${seed.emptyInlineBlockId}"]`);
  await emptyBlock.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await emptyBlock.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  await page.waitForFunction(
    (emptyInlineBlockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
      if (!(block instanceof HTMLElement)) return false;
      const rect = block.getBoundingClientRect();
      const table = block.querySelector('[data-row-height][data-inline-empty-preview="true"]');
      return Boolean(table) && rect.top >= 72 && rect.top <= window.innerHeight - 140;
    },
    seed.emptyInlineBlockId,
    { timeout: options.timeoutMs },
  );
}

async function assertEmptyInlineDatabaseVisualContract(page, seed) {
  const metrics = await page.evaluate((expected) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(expected.emptyInlineBlockId)}"]`);
    if (!(block instanceof HTMLElement)) return { ok: false, reason: 'missing empty inline database block' };
    const table = block.querySelector('[data-row-height][data-inline-empty-preview="true"]');
    const head = block.querySelector('[data-table-head]');
    const previewRows = Array.from(block.querySelectorAll('[data-table-empty-preview-row]'));
    const newRow = block.querySelector('[data-table-new-row]');
    const hiddenViewTabs = block.querySelector('[data-view-tabs-hidden="true"]');
    const visibleTabs = Array.from(block.querySelectorAll('[role="tab"]')).filter((tab) => {
      if (!(tab instanceof HTMLElement)) return false;
      const rect = tab.getBoundingClientRect();
      const style = getComputedStyle(tab);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!(table instanceof HTMLElement)) return { ok: false, reason: 'missing empty inline database table' };
    if (!(head instanceof HTMLElement)) return { ok: false, reason: 'missing empty inline database header' };
    if (!(newRow instanceof HTMLElement)) return { ok: false, reason: 'missing empty inline database new row' };
    if (previewRows.some((row) => !(row instanceof HTMLElement))) {
      return { ok: false, reason: 'empty preview row is not an element' };
    }
    const headRect = head.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const firstPreviewRow = previewRows[0];
    const lastPreviewRow = previewRows[previewRows.length - 1];
    const firstRowRect = firstPreviewRow instanceof HTMLElement ? firstPreviewRow.getBoundingClientRect() : null;
    const lastRowRect = lastPreviewRow instanceof HTMLElement ? lastPreviewRow.getBoundingClientRect() : null;
    const newRowRect = newRow.getBoundingClientRect();
    const firstRowCells = firstPreviewRow
      ? Array.from(firstPreviewRow.querySelectorAll('[data-table-empty-preview-cell]'))
      : [];
    const firstCell = firstRowCells[0];
    const addPreviewCell = firstRowCells[firstRowCells.length - 1];
    const firstCellStyle = firstCell instanceof HTMLElement ? window.getComputedStyle(firstCell) : null;
    const addPreviewCellRect = addPreviewCell instanceof HTMLElement ? addPreviewCell.getBoundingClientRect() : null;
    const addPropertyCol = head.querySelector('[data-add-property-column]');
    const addPropertyColRect =
      addPropertyCol instanceof HTMLElement ? addPropertyCol.getBoundingClientRect() : null;
    const bodyScrollWidth = document.body.scrollWidth;
    const documentScrollWidth = document.documentElement.scrollWidth;
    const viewportWidth = window.innerWidth;
    return {
      ok: true,
      addPropertyColText:
        addPropertyCol instanceof HTMLElement ? addPropertyCol.textContent?.replace(/\s+/g, ' ').trim() : null,
      addPropertyColWidth: addPropertyColRect?.width ?? 0,
      addPropertyColLeft: addPropertyColRect?.left ?? null,
      addPropertyColRight: addPropertyColRect?.right ?? null,
      addPreviewCellLeft: addPreviewCellRect?.left ?? null,
      addPreviewCellRight: addPreviewCellRect?.right ?? null,
      addPreviewCellWidth: addPreviewCellRect?.width ?? 0,
      blockLeft: blockRect.left,
      blockWidth: blockRect.width,
      bodyScrollWidth,
      documentScrollWidth,
      firstCellBorderBottom: firstCellStyle?.borderBottomWidth ?? null,
      firstCellBorderRight: firstCellStyle?.borderRightWidth ?? null,
      firstRowCellCount: firstRowCells.length,
      firstRowLeft: firstRowRect?.left ?? null,
      firstRowRight: firstRowRect?.right ?? null,
      firstRowTop: firstRowRect?.top ?? null,
      gridTemplateColumns: window.getComputedStyle(head).gridTemplateColumns,
      headBottom: headRect.bottom,
      headLeft: headRect.left,
      headRight: headRect.right,
      lastPreviewBottom: lastRowRect?.bottom ?? null,
      newRowTop: newRowRect.top,
      previewRowCount: previewRows.length,
      tableWidth: tableRect.width,
      viewTabsHidden: hiddenViewTabs instanceof HTMLElement,
      visibleTabCount: visibleTabs.length,
      viewportWidth,
    };
  }, { emptyInlineBlockId: seed.emptyInlineBlockId });

  assert(metrics.ok, metrics.reason ?? 'empty inline database visual contract could not run');
  assert(
    metrics.viewTabsHidden && metrics.visibleTabCount === 0,
    `empty single-view inline database should hide the redundant view tab row: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.previewRowCount === 3, `empty inline database should show three blank preview rows before + New: ${JSON.stringify(metrics)}`);
  assert(metrics.firstRowCellCount >= 2, `empty inline database preview should include title and add-property columns: ${JSON.stringify(metrics)}`);
  assert(metrics.addPreviewCellWidth >= 160, `empty inline database add-property area should fill remaining table width instead of collapsing: ${JSON.stringify(metrics)}`);
  assert(metrics.addPropertyColWidth >= 160, `empty inline database add-property header should occupy the add-property area, not collapse to a tiny icon rail: ${JSON.stringify(metrics)}`);
  assert(
    typeof metrics.addPropertyColText === 'string' && metrics.addPropertyColText.includes('Add a property'),
    `empty inline database add-property header should expose the Hanji + property label: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.firstCellBorderBottom === '1px', `empty inline database preview rows should keep Hanji horizontal rules: ${JSON.stringify(metrics)}`);
  assert(metrics.firstCellBorderRight === '1px', `empty inline database title column should keep a vertical divider: ${JSON.stringify(metrics)}`);
  assert(
    Math.abs(metrics.addPropertyColLeft - metrics.addPreviewCellLeft) <= 2 &&
      Math.abs(metrics.addPropertyColRight - metrics.addPreviewCellRight) <= 2,
    `empty inline database add-property header should align with the preview add-property column: ${JSON.stringify(metrics)}`,
  );
  assert(
    Math.abs(metrics.headLeft - metrics.firstRowLeft) <= 1 && Math.abs(metrics.headRight - metrics.firstRowRight) <= 2,
    `empty inline database header and preview rows should share the same table axis: ${JSON.stringify(metrics)}`,
  );
  assert(
    Math.abs(metrics.firstRowTop - metrics.headBottom) <= 2,
    `empty inline database blank preview rows should begin directly under the property header rule: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.newRowTop >= metrics.lastPreviewBottom - 1,
    `empty inline database + New row should appear after blank preview rows, not before them: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.tableWidth >= Math.min(metrics.blockWidth - 4, 520),
    `empty inline database should use the available inline content width: ${JSON.stringify(metrics)}`,
  );
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `empty inline database should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
}

async function assertEmptyInlineDatabasePreviewRowHover(page, seed) {
  const block = page.locator(`[data-block-id="${seed.emptyInlineBlockId}"]`);
  const firstPreviewRow = block.locator('[data-table-empty-preview-row]').first();
  await firstPreviewRow.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const before = await page.evaluate((emptyInlineBlockId) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
    if (!(block instanceof HTMLElement)) return { ok: false, reason: 'missing empty inline database block' };
    const row = block.querySelector('[data-table-empty-preview-row]');
    const affordance = row?.querySelector('[data-empty-preview-new-row]');
    if (!(row instanceof HTMLElement) || !(affordance instanceof HTMLElement)) {
      return { ok: false, reason: 'missing empty preview row hover affordance' };
    }
    const style = window.getComputedStyle(affordance);
    return {
      ok: true,
      cursor: window.getComputedStyle(row).cursor,
      opacity: Number(style.opacity),
      text: affordance.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    };
  }, seed.emptyInlineBlockId);

  assert(before.ok, before.reason ?? 'empty preview row hover contract could not run before hover');
  assert(before.cursor === 'text', `empty preview rows should feel like editable table rows: ${JSON.stringify(before)}`);
  assert(before.opacity <= 0.05, `empty preview + New affordance should stay hidden until row hover: ${JSON.stringify(before)}`);
  assert(before.text.includes('새 페이지') || before.text.includes('New'), `empty preview row should contain a local add-row affordance: ${JSON.stringify(before)}`);

  await firstPreviewRow.hover({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (emptyInlineBlockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
      const affordance = block?.querySelector('[data-table-empty-preview-row] [data-empty-preview-new-row]');
      return affordance instanceof HTMLElement && Number(window.getComputedStyle(affordance).opacity) > 0.8;
    },
    seed.emptyInlineBlockId,
    { timeout: options.timeoutMs },
  );

  const after = await page.evaluate((emptyInlineBlockId) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
    if (!(block instanceof HTMLElement)) return { ok: false, reason: 'missing empty inline database block after hover' };
    const affordance = block.querySelector('[data-table-empty-preview-row] [data-empty-preview-new-row]');
    const row = block.querySelector('[data-table-empty-preview-row]');
    if (!(row instanceof HTMLElement) || !(affordance instanceof HTMLElement)) {
      return { ok: false, reason: 'missing empty preview row hover affordance after hover' };
    }
    return {
      ok: true,
      opacity: Number(window.getComputedStyle(affordance).opacity),
      rowBackground: window.getComputedStyle(row).backgroundColor,
      text: affordance.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    };
  }, seed.emptyInlineBlockId);

  assert(after.ok, after.reason ?? 'empty preview row hover contract could not run after hover');
  assert(after.opacity > 0.8, `empty preview row hover should reveal + New in that row: ${JSON.stringify(after)}`);
  assert(after.text.includes('새 페이지') || after.text.includes('New'), `hovered empty preview row should show the add-row label: ${JSON.stringify(after)}`);
}

async function assertEmptyInlineDatabaseNewRowFocus(page, seed) {
  const block = page.locator(`[data-block-id="${seed.emptyInlineBlockId}"]`);
  const previewRow = block.locator('[data-table-empty-preview-row]').first();
  await previewRow.hover({ timeout: options.timeoutMs });
  await previewRow.click({ timeout: options.timeoutMs });

  await page.waitForFunction(
    (emptyInlineBlockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
      if (!(block instanceof HTMLElement)) return false;
      const input = block.querySelector('[data-table-row-id] [data-table-title-input]');
      return input instanceof HTMLInputElement && document.activeElement === input;
    },
    seed.emptyInlineBlockId,
    { timeout: options.timeoutMs },
  );

  const metrics = await page.evaluate((emptyInlineBlockId) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(emptyInlineBlockId)}"]`);
    if (!(block instanceof HTMLElement)) return { ok: false, reason: 'missing empty inline database block after new row click' };
    const rows = Array.from(block.querySelectorAll('[data-table-row-id]')).filter((row) => row instanceof HTMLElement);
    const input = block.querySelector('[data-table-row-id] [data-table-title-input]');
    const newRow = block.querySelector('[data-table-new-row]');
    const url = new URL(window.location.href);
    return {
      ok: true,
      activeTitleInput: input instanceof HTMLInputElement && document.activeElement === input,
      newRowStillVisible: newRow instanceof HTMLElement && newRow.getBoundingClientRect().height > 0,
      previewRowCount: block.querySelectorAll('[data-table-empty-preview-row]').length,
      rowCount: rows.length,
      rowPeekOpen: !!document.querySelector('[data-row-peek-panel]'),
      selectedRowCount: block.querySelectorAll('[data-table-row-id][data-row-selected="true"]').length,
      titleSelectionEnd: input instanceof HTMLInputElement ? input.selectionEnd : null,
      titleSelectionStart: input instanceof HTMLInputElement ? input.selectionStart : null,
      titleValue: input instanceof HTMLInputElement ? input.value : null,
      urlRowParam: url.searchParams.get('p'),
      urlPeekMode: url.searchParams.get('pm'),
    };
  }, seed.emptyInlineBlockId);

  assert(metrics.ok, metrics.reason ?? 'empty inline database new row focus contract could not run');
  assert(metrics.rowCount === 1, `clicking an empty preview row should create one real table row: ${JSON.stringify(metrics)}`);
  assert(metrics.previewRowCount === 0, `empty preview rows should be replaced by the real editable row after the preview-row click: ${JSON.stringify(metrics)}`);
  assert(metrics.activeTitleInput, `clicking an empty preview row should focus the new row title cell input: ${JSON.stringify(metrics)}`);
  assert(metrics.titleValue === '', `new inline database row title should start empty and ready to type: ${JSON.stringify(metrics)}`);
  assert(
    metrics.titleSelectionStart === metrics.titleSelectionEnd,
    `new inline database row title should show a caret, not a selected range: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.selectedRowCount === 0, `new inline database row should not be left as a selected row: ${JSON.stringify(metrics)}`);
  assert(metrics.newRowStillVisible, `the + New row affordance should remain available below the editable row: ${JSON.stringify(metrics)}`);
  assert(!metrics.rowPeekOpen && !metrics.urlRowParam && !metrics.urlPeekMode, `clicking an empty preview row should edit in the table instead of opening row peek: ${JSON.stringify(metrics)}`);
}

async function assertPopulatedInlineDatabaseAddPropertyHeader(page, seed) {
  const metrics = await page.evaluate((expected) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(expected.inlineBlockId)}"]`);
    if (!(block instanceof HTMLElement)) return { ok: false, reason: 'missing populated inline database block' };
    const inlineDatabase = block.querySelector('[data-placement="inline"]');
    const head = inlineDatabase?.querySelector('[data-table-head]');
    if (!(inlineDatabase instanceof HTMLElement)) return { ok: false, reason: 'missing populated inline database wrapper' };
    if (!(head instanceof HTMLElement)) return { ok: false, reason: 'missing populated inline database table head' };
    const propertyHeaders = Array.from(head.querySelectorAll('[data-table-property-header]')).filter(
      (header) => header instanceof HTMLElement && header.getBoundingClientRect().width > 0,
    );
    const addPropertyCol = head.querySelector('[data-add-property-column]');
    const addPropertyButton = addPropertyCol?.querySelector('button[aria-label="Add a property"]');
    const addMoreButton = addPropertyCol?.querySelector('button[aria-label="Property options"]');
    if (
      propertyHeaders.length === 0 ||
      !(addPropertyCol instanceof HTMLElement) ||
      !(addPropertyButton instanceof HTMLElement) ||
      !(addMoreButton instanceof HTMLElement)
    ) {
      return {
        ok: false,
        reason: `missing populated inline add-property markers: ${JSON.stringify({
          propertyHeaders: propertyHeaders.length,
          addPropertyCol: addPropertyCol instanceof HTMLElement,
          addPropertyButton: addPropertyButton instanceof HTMLElement,
          addMoreButton: addMoreButton instanceof HTMLElement,
        })}`,
      };
    }
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        width: r.width,
      };
    };
    const lastHeader = propertyHeaders[propertyHeaders.length - 1];
    const inlineRect = rect(inlineDatabase);
    const headRect = rect(head);
    const lastHeaderRect = rect(lastHeader);
    const addColRect = rect(addPropertyCol);
    const addButtonRect = rect(addPropertyButton);
    const moreButtonRect = rect(addMoreButton);
    return {
      ok: true,
      addButtonRight: addButtonRect.right,
      addButtonText: addPropertyButton.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      addButtonWidth: addButtonRect.width,
      addColLeft: addColRect.left,
      addColRight: addColRect.right,
      addColText: addPropertyCol.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      addColWidth: addColRect.width,
      headRight: headRect.right,
      inlineRight: inlineRect.right,
      lastHeaderRight: lastHeaderRect.right,
      moreButtonLeft: moreButtonRect.left,
      propertyHeaderCount: propertyHeaders.length,
      viewportWidth: window.innerWidth,
    };
  }, { inlineBlockId: seed.inlineBlockId });

  assert(metrics.ok, metrics.reason ?? 'populated inline add-property header contract could not run');
  assert(
    metrics.addColText.includes('Add a property') && metrics.addButtonText.includes('Add a property'),
    `populated inline database should expose the Hanji + property label at the table end: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.addColWidth >= 90 && metrics.addButtonWidth >= 70,
    `populated inline database add-property area should use the available trailing header space instead of collapsing to an icon rail: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.addColLeft >= metrics.lastHeaderRight - 2 &&
      metrics.moreButtonLeft >= metrics.addButtonRight - 1 &&
      metrics.addColRight <= Math.min(metrics.viewportWidth, metrics.inlineRight) + 4,
    `populated inline database add-property controls should sit after the last real property header without overlapping it: ${JSON.stringify(metrics)}`,
  );
}

async function assertInlineDatabaseVisualContract(page, seed, { mobile }) {
  const metrics = await page.evaluate((expected) => {
    const doc = document.querySelector('[data-page-search-root]');
    const pageTitle = document.querySelector('[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]');
    const pageBody = document.querySelector('[role="region"][aria-label="Page body"]');
    const inlineBlock = document.querySelector(`[data-block-id="${CSS.escape(expected.inlineBlockId)}"]`);
    const inlineTitle = inlineBlock?.querySelector('[data-inline-database-title]');
    const inlineWrapper = inlineTitle?.closest('[data-inline-database-wrapper]');
    const inlineIcon = inlineWrapper?.querySelector('[data-inline-database-icon="true"]');
    const inlineOpenAction = inlineWrapper?.querySelector('[data-inline-database-open-action="true"]');
    const inlineActions = inlineWrapper?.querySelector('[data-inline-database-actions="true"]');
    const inlineDatabase = inlineWrapper?.querySelector('[data-placement="inline"]');
    const viewTabs = inlineDatabase?.querySelector('[role="tablist"]');
    const activeTab = inlineDatabase?.querySelector('[role="tab"][aria-selected="true"]');
    const toolbar = inlineDatabase?.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
    const summaryRow = inlineDatabase?.querySelector('[data-table-summary-row]');
    const tableCells = Array.from(inlineDatabase?.querySelectorAll('[data-table-cell]') ?? []);
    const cellText = (cell) => [
      cell.textContent ?? '',
      ...Array.from(cell.querySelectorAll('input, textarea')).map((input) => input.value ?? ''),
    ].join(' ').replace(/\s+/g, ' ').trim();
    const titleCell =
      inlineDatabase?.querySelector('[data-table-cell][data-row-index="0"][data-col-index="0"]') ??
      tableCells.find((cell) => cellText(cell).includes(expected.rowTitles[0]));
    const amountCell =
      inlineDatabase?.querySelector('[data-table-cell][data-row-index="0"][data-col-index="1"]') ??
      tableCells.find((cell) => cellText(cell).includes(expected.amountText));
    if (
      !(doc instanceof HTMLElement) ||
      !(pageTitle instanceof HTMLElement) ||
      !(pageBody instanceof HTMLElement) ||
      !(inlineBlock instanceof HTMLElement) ||
      !(inlineTitle instanceof HTMLElement) ||
      !(inlineOpenAction instanceof HTMLElement) ||
      !(inlineActions instanceof HTMLElement) ||
      !(inlineWrapper instanceof HTMLElement) ||
      !(inlineDatabase instanceof HTMLElement) ||
      !(viewTabs instanceof HTMLElement) ||
      !(activeTab instanceof HTMLElement) ||
      !(toolbar instanceof HTMLElement) ||
      !(summaryRow instanceof HTMLElement) ||
      tableCells.length < 8 ||
      !(titleCell instanceof HTMLElement) ||
      !(amountCell instanceof HTMLElement)
    ) {
      return {
        ok: false,
        reason: `missing inline database visual markers: ${JSON.stringify({
          doc: doc instanceof HTMLElement,
          pageTitle: pageTitle instanceof HTMLElement,
          pageBody: pageBody instanceof HTMLElement,
          inlineBlock: inlineBlock instanceof HTMLElement,
          inlineTitle: inlineTitle instanceof HTMLElement,
          inlineIcon: inlineIcon instanceof HTMLElement,
          inlineOpenAction: inlineOpenAction instanceof HTMLElement,
          inlineActions: inlineActions instanceof HTMLElement,
          inlineWrapper: inlineWrapper instanceof HTMLElement,
          inlineDatabase: inlineDatabase instanceof HTMLElement,
          viewTabs: viewTabs instanceof HTMLElement,
          activeTab: activeTab instanceof HTMLElement,
          toolbar: toolbar instanceof HTMLElement,
          summaryRow: summaryRow instanceof HTMLElement,
          tableCellCount: tableCells.length,
          titleCell: titleCell instanceof HTMLElement,
          amountCell: amountCell instanceof HTMLElement,
        })}`,
      };
    }

    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const titleRect = rect(pageTitle);
    const bodyRect = rect(pageBody);
    const inlineBlockRect = rect(inlineBlock);
    const inlineRect = rect(inlineDatabase);
    const inlineTitleRect = rect(inlineTitle);
    const inlineOpenActionRect = rect(inlineOpenAction);
    const viewTabsRect = rect(viewTabs);
    const activeTabRect = rect(activeTab);
    const toolbarRect = rect(toolbar);
    const summaryRect = rect(summaryRow);
    const firstCellRect = rect(tableCells[0]);
    const titleCellRect = rect(titleCell);
    const amountCellRect = rect(amountCell);
    const inlineTitleStyle = getComputedStyle(inlineTitle);
    const inlineOpenActionStyle = getComputedStyle(inlineOpenAction);
    const inlineActionsStyle = getComputedStyle(inlineActions);
    const viewTabsStyle = getComputedStyle(viewTabs);
    const toolbarStyle = getComputedStyle(toolbar);
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
    const round = (value) => Math.round(value * 100) / 100;
    const summaryText = summaryRow.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const visibleSummaryTexts = Array.from(summaryRow.querySelectorAll('button, span, strong'))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const r = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number.parseFloat(style.opacity) > 0.05 && r.width > 0 && r.height > 0;
      })
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
    const buttonLabel = (button) =>
      button.getAttribute('aria-label') ||
      button.getAttribute('title') ||
      button.textContent?.replace(/\s+/g, ' ').trim() ||
      '';
    const toolbarButtons = Array.from(toolbar.querySelectorAll('button'))
      .filter((button) => {
        if (!(button instanceof HTMLElement)) return false;
        const r = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return button.offsetParent !== null &&
          style.visibility !== 'hidden' &&
          Number.parseFloat(style.opacity || '1') > 0.05 &&
          style.pointerEvents !== 'none' &&
          r.width > 0 &&
          r.height > 0;
      })
      .map((button) => {
        const r = rect(button);
        const style = getComputedStyle(button);
        return {
          label: buttonLabel(button),
          text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
          fontSize: Number.parseFloat(style.fontSize),
          colorAlpha: round(cssAlpha(style.color)),
          opacity: round(Number.parseFloat(style.opacity || '1')),
          pointerEvents: style.pointerEvents,
        };
      });
    const visibleTabButtons = Array.from(viewTabs.querySelectorAll('[role="tab"]')).filter((tab) => {
      if (!(tab instanceof HTMLElement)) return false;
      const r = tab.getBoundingClientRect();
      const style = getComputedStyle(tab);
      return tab.offsetParent !== null &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05 &&
        r.width > 0 &&
        r.height > 0;
    });
    const overflowButton = viewTabs.querySelector('[data-view-overflow]');
    const overflowButtonRect = overflowButton instanceof HTMLElement ? rect(overflowButton) : null;
    const addViewButton = viewTabs.querySelector('[data-view-add-wrap] button');
    const addViewButtonRect = addViewButton instanceof HTMLElement ? rect(addViewButton) : null;
    const overflowText = overflowButton instanceof HTMLElement
      ? overflowButton.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      : '';
    const overflowCountMatch = overflowText.match(/(\d+)\s*more/);
    const visibleViewTabLabels = visibleTabButtons
      .map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
    const lastVisibleTabRight = Math.max(
      ...visibleTabButtons.map((tab) => tab.getBoundingClientRect().right),
      overflowButtonRect?.right ?? Number.NEGATIVE_INFINITY,
      addViewButtonRect?.right ?? Number.NEGATIVE_INFINITY,
    );
    return {
      ok: true,
      viewportWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      fineHoverPointer: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
      pageTitleText: pageTitle.textContent?.trim() ?? '',
      activeTabViewId: activeTab.getAttribute('data-view-tab') ?? '',
      activeTabText: activeTab.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      inlineTitleValue:
        inlineTitle instanceof HTMLInputElement
          ? inlineTitle.value
          : inlineTitle.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      titleCellText: cellText(titleCell),
      amountCellText: cellText(amountCell),
      pageTitleLeft: titleRect.left,
      pageTitleRight: titleRect.right,
      pageTitleBottom: titleRect.bottom,
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      inlineBlockLeft: inlineBlockRect.left,
      inlineBlockRight: inlineBlockRect.right,
      inlineBlockTop: inlineBlockRect.top,
      inlineBlockWidth: inlineBlockRect.width,
      inlineLeft: inlineRect.left,
      inlineRight: inlineRect.right,
      inlineWidth: inlineRect.width,
      inlineDatabaseIconVisible: inlineIcon instanceof HTMLElement,
      inlineOpenActionLeft: inlineOpenActionRect.left,
      inlineOpenActionRight: inlineOpenActionRect.right,
      inlineOpenActionWidth: inlineOpenActionRect.width,
      inlineOpenActionHeight: inlineOpenActionRect.height,
      inlineOpenActionCenterY: inlineOpenActionRect.top + inlineOpenActionRect.height / 2,
      inlineOpenActionLabel: inlineOpenAction.getAttribute('aria-label') ?? '',
      inlineOpenActionPlacement: inlineOpenAction.getAttribute('data-inline-database-open-placement') ?? '',
      inlineOpenActionOpacity: Number.parseFloat(inlineOpenActionStyle.opacity || '1'),
      inlineOpenActionPointerEvents: inlineOpenActionStyle.pointerEvents,
      inlineActionsOpacity: Number.parseFloat(inlineActionsStyle.opacity || '1'),
      inlineActionsPointerEvents: inlineActionsStyle.pointerEvents,
      inlineTitleLeft: inlineTitleRect.left,
      inlineTitleRight: inlineTitleRect.right,
      inlineTitleTop: inlineTitleRect.top,
      inlineTitleHeight: inlineTitleRect.height,
      inlineTitleCenterY: inlineTitleRect.top + inlineTitleRect.height / 2,
      inlineTitleFontSize: Number.parseFloat(inlineTitleStyle.fontSize),
      viewTabsLeft: viewTabsRect.left,
      viewTabsRight: viewTabsRect.right,
      viewTabsToToolbarGap: toolbarRect.left - viewTabsRect.right,
      visibleViewTabLabels,
      visibleViewTabCount: visibleViewTabLabels.length,
      viewOverflowText: overflowText,
      viewOverflowHiddenCount: overflowCountMatch ? Number(overflowCountMatch[1]) : 0,
      viewOverflowVisible: overflowButton instanceof HTMLElement && overflowButtonRect !== null,
      viewAddButtonVisible: addViewButton instanceof HTMLElement && addViewButtonRect !== null,
      viewAddButtonRight: addViewButtonRect?.right ?? null,
      viewAddButtonToToolbarGap: addViewButtonRect ? toolbarRect.left - addViewButtonRect.right : null,
      visibleViewChromeToToolbarGap: Number.isFinite(lastVisibleTabRight)
        ? toolbarRect.left - lastVisibleTabRight
        : toolbarRect.left - viewTabsRect.right,
      viewTabsTop: viewTabsRect.top,
      viewTabsHeight: viewTabsRect.height,
      viewTabsOpacity: Number.parseFloat(viewTabsStyle.opacity),
      viewTabsPointerEvents: viewTabsStyle.pointerEvents,
      activeTabHeight: activeTabRect.height,
      toolbarLeft: toolbarRect.left,
      toolbarRight: toolbarRect.right,
      toolbarTop: toolbarRect.top,
      toolbarHeight: toolbarRect.height,
      toolbarOpacity: Number.parseFloat(toolbarStyle.opacity),
      toolbarPointerEvents: toolbarStyle.pointerEvents,
      summaryTop: summaryRect.top,
      summaryHeight: summaryRect.height,
      summaryText,
      visibleSummaryTexts,
      firstCellLeft: firstCellRect.left,
      firstCellTop: firstCellRect.top,
      firstCellHeight: firstCellRect.height,
      titleCellLeft: titleCellRect.left,
      amountCellLeft: amountCellRect.left,
      tableCellCount: tableCells.length,
      toolbarButtons,
    };
  }, {
    amountText: seed.amountText,
    databaseTitle: seed.databaseTitle,
    importedInlineViewNames: seed.importedInlineViewNames,
    inlineBlockId: seed.inlineBlockId,
    rowTitles: seed.rowTitles,
  });

  assert(metrics.ok, metrics.reason ?? 'inline database visual contract could not run');
  assert(metrics.pageTitleText === seed.pageTitle, `inline database page title should render seeded title: ${JSON.stringify(metrics)}`);
  assert(metrics.inlineTitleValue === seed.databaseTitle, `inline database title should render seeded title: ${JSON.stringify(metrics)}`);
  assert(
    metrics.activeTabViewId === seed.tableViewId,
    `inline database should honor the linked block databaseViewId instead of falling back to the first database view: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.activeTabText.includes(seed.importedInlineViewNames[0]),
    `inline database active tab should be ${seed.importedInlineViewNames[0]}: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.tableCellCount >= 8, `inline database table should render seeded rows and properties: ${JSON.stringify(metrics)}`);
  assert(metrics.titleCellText.includes(seed.rowTitles[0]), `inline database first row title should render seeded title: ${JSON.stringify(metrics)}`);
  assert(metrics.amountCellText.includes(seed.amountText), `inline database first row amount should render seeded number: ${JSON.stringify(metrics)}`);
  assert(
    metrics.visibleSummaryTexts.some((text) => /sum/i.test(text)) &&
      metrics.visibleSummaryTexts.some((text) => text.includes('4,260,000')),
    `inline database should show the configured amount summary instead of a row-count-only footer: ${JSON.stringify(metrics)}`,
  );
  assert(
    !metrics.visibleSummaryTexts.some((text) => /^3 rows$/i.test(text)),
    `inline database should not keep the default row count visible when a numeric summary is configured: ${JSON.stringify(metrics)}`,
  );
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `inline database should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.inlineTitleTop > metrics.pageTitleBottom + 24,
    `inline database should sit below the page title and intro body, not collide with page chrome: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.inlineTitleFontSize >= 20 && metrics.inlineTitleFontSize <= 24 && metrics.inlineTitleHeight >= 30 && metrics.inlineTitleHeight <= 40,
    `inline database title should keep compact Notion-style embedded database scale: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.inlineDatabaseIconVisible === false,
    `inline database title should not show a separate database icon before the title: ${JSON.stringify(metrics)}`,
  );
  assert(
      metrics.inlineOpenActionWidth >= 18 &&
      metrics.inlineOpenActionWidth <= 28 &&
      metrics.inlineOpenActionHeight >= 18 &&
      metrics.inlineOpenActionHeight <= 28 &&
      metrics.inlineOpenActionPlacement === 'leading' &&
      metrics.inlineTitleLeft - metrics.inlineOpenActionRight >= 2 &&
      metrics.inlineTitleLeft - metrics.inlineOpenActionRight <= 12 &&
      Math.abs(metrics.inlineOpenActionCenterY - metrics.inlineTitleCenterY) <= 3 &&
      metrics.inlineOpenActionLabel.includes(seed.databaseTitle),
    `linked inline database title should expose a compact leading open-arrow action before the title: ${JSON.stringify(metrics)}`,
  );
  if (metrics.fineHoverPointer) {
    assert(
      metrics.inlineOpenActionOpacity >= 0.85 &&
        metrics.inlineOpenActionPointerEvents !== 'none' &&
        metrics.inlineActionsOpacity <= 0.05 &&
        metrics.inlineActionsPointerEvents === 'none',
      `linked inline database leading open arrow should remain visible while the ellipsis stays hidden until title-row hover/focus: ${JSON.stringify(metrics)}`,
    );
  } else {
    assert(
      metrics.inlineOpenActionOpacity >= 0.85 &&
        metrics.inlineOpenActionPointerEvents !== 'none' &&
        metrics.inlineActionsOpacity >= 0.85 &&
        metrics.inlineActionsPointerEvents !== 'none',
      `touch inline database title actions should remain available without hover: ${JSON.stringify(metrics)}`,
    );
  }
  assert(
    metrics.firstCellHeight >= 30 && metrics.firstCellHeight <= 44,
    `inline database table rows should keep dense Notion-style row rhythm: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.amountCellLeft > metrics.titleCellLeft + 120,
    `inline database columns should not collapse into one text stack: ${JSON.stringify(metrics)}`,
  );

  if (mobile) {
    assert(metrics.viewportWidth <= 430, `mobile inline database contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(
      metrics.inlineLeft >= 20 &&
        metrics.inlineRight <= metrics.viewportWidth - 20 &&
        metrics.viewTabsLeft >= metrics.inlineLeft - 1 &&
        metrics.toolbarLeft >= metrics.inlineLeft - 1,
      `mobile inline database should stay inside the page gutter: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarButtons.every((button) => button.height >= 22 && button.height <= 34),
      `mobile inline database toolbar buttons should stay compact: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.viewTabsTop >= metrics.inlineTitleTop + 28 &&
        metrics.viewTabsHeight >= 28 &&
        metrics.viewTabsHeight <= 40 &&
        metrics.activeTabHeight >= 26 &&
        metrics.activeTabHeight <= 34,
      `mobile inline database view tabs should remain touch-available compact chrome: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarTop >= metrics.viewTabsTop + 26 &&
        metrics.toolbarHeight >= 24 &&
        metrics.toolbarHeight <= 36,
      `mobile inline database toolbar should stay compact and attached to the view tabs: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarOpacity >= 0.85,
      `mobile inline database toolbar should stay available as compact icon chrome: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarButtons.every((button) => button.width <= 64),
      `mobile inline database toolbar should not expose full desktop text buttons: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarButtons.every(
        (button) =>
          button.opacity >= 0.85 &&
          button.colorAlpha >= 0.44 &&
          button.pointerEvents !== 'none'
      ),
      `mobile inline database toolbar controls should be optically visible at rest, not hover-only: ${JSON.stringify(metrics.toolbarButtons)}`,
    );
  } else {
    assert(
      metrics.inlineLeft >= metrics.pageTitleLeft - 2 &&
        metrics.inlineRight <= metrics.bodyRight + 2 &&
        Math.abs(metrics.inlineOpenActionLeft - metrics.pageTitleLeft) <= 2 &&
        metrics.inlineTitleLeft > metrics.inlineOpenActionRight,
      `desktop linked inline database should align its leading open arrow with the document text column: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.inlineWidth >= 620 && metrics.inlineWidth <= 920,
      `desktop inline database should stay document-width, not full app-width: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.viewTabsTop >= metrics.inlineTitleTop + 28 &&
        metrics.viewTabsHeight >= 28 &&
        metrics.viewTabsHeight <= 40 &&
        metrics.viewTabsOpacity >= 0.85 &&
        metrics.viewTabsPointerEvents === 'auto' &&
        metrics.activeTabHeight >= 26 &&
        metrics.activeTabHeight <= 34,
      `desktop inline database view tabs should be visible and usable at rest: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarHeight >= 24 &&
        metrics.toolbarHeight <= 36 &&
        metrics.toolbarOpacity >= 0.85 &&
        metrics.toolbarPointerEvents === 'auto' &&
        metrics.toolbarLeft >= metrics.inlineLeft - 1 &&
        metrics.toolbarRight <= metrics.inlineRight + 2 &&
        metrics.toolbarTop >= metrics.viewTabsTop - 2 &&
        metrics.toolbarTop <= metrics.viewTabsTop + 6,
      `desktop inline database toolbar should stay visible on the same chrome row as the view tabs at rest: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarButtons.length >= 5 &&
        metrics.toolbarButtons.every((button) => {
          const isNewButton = isNewDatabaseButtonLabel(button.label);
          const isTemplateButton = button.label === 'Choose database template';
          const maxWidth = isNewButton ? 128 : isTemplateButton ? 40 : 64;
          return button.width <= maxWidth && button.height >= 22 && button.height <= 32;
        }),
      `desktop inline database toolbar should stay icon-scale and compact at rest: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.toolbarButtons.every(
        (button) =>
          button.opacity >= 0.85 &&
          button.colorAlpha >= 0.44 &&
          button.pointerEvents !== 'none'
      ),
      `desktop inline database toolbar controls should be optically visible at rest, not hover-only: ${JSON.stringify(metrics.toolbarButtons)}`,
    );
    assert(
      ['Filter', 'Sort', 'Search database rows'].every((label) =>
        metrics.toolbarButtons.some((button) => button.label === label)
      ) &&
        metrics.toolbarButtons.some((button) => button.label === 'Database settings') &&
        metrics.toolbarButtons.some((button) => isNewDatabaseButtonLabel(button.label)) &&
        !metrics.toolbarButtons.some((button) => button.label === 'Properties') &&
        !metrics.toolbarButtons.some((button) => button.label === 'Layout'),
      `desktop inline database toolbar should keep quick controls without duplicating Properties next to settings: ${JSON.stringify(metrics.toolbarButtons)}`,
    );
    assert(
      metrics.visibleViewTabLabels.some((text) => text.includes(seed.importedInlineViewNames[0])) &&
        (!metrics.viewOverflowVisible || metrics.viewOverflowHiddenCount >= 1),
      `desktop imported inline database view tabs should remain width-driven, with overflow only when lower-priority views need to collapse: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.viewAddButtonVisible &&
        typeof metrics.viewAddButtonToToolbarGap === 'number' &&
        metrics.viewAddButtonToToolbarGap >= 12,
      `desktop inline database should hide tabs before the add-view + is covered by the toolbar: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.visibleViewChromeToToolbarGap >= 12 && metrics.visibleViewChromeToToolbarGap <= 220,
      `desktop inline database visible tabs/add button and toolbar should have Hanji breathing room without hiding tabs while excessive space remains, got ${Math.round(metrics.visibleViewChromeToToolbarGap)}px: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.firstCellTop - metrics.inlineTitleTop <= 160,
      `desktop inline database table should follow visible tabs and toolbar without loose whitespace: ${JSON.stringify(metrics)}`,
    );
  }
}

async function assertInlineDatabaseToolbarReveal(page, inlineBlockId) {
  const root = page.locator(`[data-block-id="${inlineBlockId}"] [data-placement="inline"]`).first();
  await root.hover({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (blockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      const toolbar = block?.querySelector(
        '[data-placement="inline"] [role="toolbar"][aria-label="Database toolbar"]'
      );
      if (!(toolbar instanceof HTMLElement)) return false;
      const style = getComputedStyle(toolbar);
      return (
        Number.parseFloat(style.opacity) >= 0.85 &&
        style.pointerEvents === 'auto'
      );
    },
    inlineBlockId,
    { timeout: options.timeoutMs },
  );
  const bodyHoverTitleActions = await page.evaluate((blockId) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    const inlineActions = block?.querySelector('[data-inline-database-actions="true"]');
    const inlineOpenAction = block?.querySelector('[data-inline-database-open-action="true"]');
    const inlineActionsStyle = inlineActions instanceof HTMLElement ? getComputedStyle(inlineActions) : null;
    const inlineOpenActionStyle = inlineOpenAction instanceof HTMLElement ? getComputedStyle(inlineOpenAction) : null;
    return {
      fineHoverPointer: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
      inlineActions: inlineActions instanceof HTMLElement,
      inlineActionsOpacity: inlineActionsStyle ? Number.parseFloat(inlineActionsStyle.opacity || '1') : null,
      inlineActionsPointerEvents: inlineActionsStyle?.pointerEvents ?? null,
      inlineOpenAction: inlineOpenAction instanceof HTMLElement,
      inlineOpenActionOpacity: inlineOpenActionStyle ? Number.parseFloat(inlineOpenActionStyle.opacity || '1') : null,
      inlineOpenActionPointerEvents: inlineOpenActionStyle?.pointerEvents ?? null,
    };
  }, inlineBlockId);
  assert(
    bodyHoverTitleActions.inlineActions && bodyHoverTitleActions.inlineOpenAction,
    `inline database title action markers should exist while checking body hover: ${JSON.stringify(bodyHoverTitleActions)}`,
  );
  if (bodyHoverTitleActions.fineHoverPointer) {
    assert(
      bodyHoverTitleActions.inlineOpenActionOpacity >= 0.85 &&
        bodyHoverTitleActions.inlineOpenActionPointerEvents === 'auto' &&
        bodyHoverTitleActions.inlineActionsOpacity <= 0.05 &&
        bodyHoverTitleActions.inlineActionsPointerEvents === 'none',
      `hovering the linked inline database body should keep the leading open arrow visible while the ellipsis waits for title-row hover: ${JSON.stringify(bodyHoverTitleActions)}`,
    );
  }
  await page.locator(`[data-block-id="${inlineBlockId}"] [data-inline-database-title]`).first().hover({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (blockId) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      const inlineActions = block?.querySelector('[data-inline-database-actions="true"]');
      const inlineOpenAction = block?.querySelector('[data-inline-database-open-action="true"]');
      if (!(inlineActions instanceof HTMLElement) || !(inlineOpenAction instanceof HTMLElement)) return false;
      const inlineActionsStyle = getComputedStyle(inlineActions);
      const inlineOpenActionStyle = getComputedStyle(inlineOpenAction);
      return (
        Number.parseFloat(inlineActionsStyle.opacity || '1') >= 0.85 &&
        inlineActionsStyle.pointerEvents === 'auto' &&
        Number.parseFloat(inlineOpenActionStyle.opacity || '1') >= 0.85 &&
        inlineOpenActionStyle.pointerEvents === 'auto'
      );
    },
    inlineBlockId,
    { timeout: options.timeoutMs },
  );
  const metrics = await page.evaluate((blockId) => {
    const block = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    const database = block?.querySelector('[data-placement="inline"]');
    const toolbar = database?.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
    const viewTabs = database?.querySelector('[role="tablist"]');
    const activeTab = database?.querySelector('[role="tab"][aria-selected="true"]');
    const inlineActions = block?.querySelector('[data-inline-database-actions="true"]');
    const inlineOpenAction = block?.querySelector('[data-inline-database-open-action="true"]');
    const inlineAddViewAction = block?.querySelector('[data-inline-database-add-view-action="true"]');
    const inlineTitle = block?.querySelector('[data-inline-database-title]');
    if (
      !(database instanceof HTMLElement) ||
      !(toolbar instanceof HTMLElement) ||
      !(viewTabs instanceof HTMLElement) ||
      !(inlineActions instanceof HTMLElement) ||
      !(inlineOpenAction instanceof HTMLElement) ||
      !(inlineAddViewAction instanceof HTMLElement) ||
      !(inlineTitle instanceof HTMLElement)
    ) {
      return {
        ok: false,
        database: database instanceof HTMLElement,
        toolbar: toolbar instanceof HTMLElement,
        viewTabs: viewTabs instanceof HTMLElement,
        inlineActions: inlineActions instanceof HTMLElement,
        inlineAddViewAction: inlineAddViewAction instanceof HTMLElement,
        inlineOpenAction: inlineOpenAction instanceof HTMLElement,
        inlineTitle: inlineTitle instanceof HTMLElement,
      };
    }
    const style = getComputedStyle(toolbar);
    const viewTabsStyle = getComputedStyle(viewTabs);
    const inlineActionsStyle = getComputedStyle(inlineActions);
    const inlineActionsRect = inlineActions.getBoundingClientRect();
    const inlineAddViewActionRect = inlineAddViewAction.getBoundingClientRect();
    const inlineOpenActionRect = inlineOpenAction.getBoundingClientRect();
    const inlineTitleRect = inlineTitle.getBoundingClientRect();
    const inlineActionButtons = Array.from(inlineActions.querySelectorAll('button')).map((button) => {
      const r = button.getBoundingClientRect();
      const icon = button.querySelector('svg');
      const iconRect = icon instanceof SVGElement ? icon.getBoundingClientRect() : null;
      return {
        ariaLabel: button.getAttribute('aria-label') ?? '',
        height: r.height,
        iconHeight: iconRect?.height ?? null,
        iconWidth: iconRect?.width ?? null,
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        width: r.width,
      };
    });
    const buttonLabel = (button) =>
      button.getAttribute('aria-label') ||
      button.getAttribute('title') ||
      button.textContent?.replace(/\s+/g, ' ').trim() ||
      '';
    const buttons = Array.from(toolbar.querySelectorAll('button'))
      .filter((button) => {
        if (!(button instanceof HTMLElement)) return false;
        const r = button.getBoundingClientRect();
        const buttonStyle = getComputedStyle(button);
        return button.offsetParent !== null &&
          buttonStyle.visibility !== 'hidden' &&
          Number.parseFloat(buttonStyle.opacity || '1') > 0.05 &&
          buttonStyle.pointerEvents !== 'none' &&
          r.width > 0 &&
          r.height > 0;
      })
      .map((button) => {
        const r = button.getBoundingClientRect();
        return {
          height: r.height,
          label: buttonLabel(button),
          width: r.width,
        };
      });
    return {
      ok: true,
      activeTabHeight: activeTab instanceof HTMLElement ? activeTab.getBoundingClientRect().height : null,
      buttonCount: buttons.length,
      buttons,
      inlineActionButtonCount: inlineActionButtons.length,
      inlineActionButtons,
      inlineAddViewActionLeft: inlineAddViewActionRect.left,
      inlineAddViewActionRight: inlineAddViewActionRect.right,
      inlineAddViewActionWidth: inlineAddViewActionRect.width,
      inlineActionGapFromOpenAction: inlineActionsRect.left - inlineOpenActionRect.right,
      inlineActionsLeft: inlineActionsRect.left,
      inlineActionsRight: inlineActionsRect.right,
      inlineActionsOpacity: Number.parseFloat(inlineActionsStyle.opacity),
      inlineActionsPointerEvents: inlineActionsStyle.pointerEvents,
      inlineOpenActionLeft: inlineOpenActionRect.left,
      inlineOpenActionRight: inlineOpenActionRect.right,
      inlineOpenActionWidth: inlineOpenActionRect.width,
      inlineTitleLeft: inlineTitleRect.left,
      inlineTitleRight: inlineTitleRect.right,
      opacity: Number.parseFloat(style.opacity),
      pointerEvents: style.pointerEvents,
      viewTabsHeight: viewTabs.getBoundingClientRect().height,
      viewTabsOpacity: Number.parseFloat(viewTabsStyle.opacity),
      viewTabsPointerEvents: viewTabsStyle.pointerEvents,
    };
  }, inlineBlockId);

  assert(metrics.ok, `inline database toolbar reveal markers are missing: ${JSON.stringify(metrics)}`);
  assert(
    metrics.opacity >= 0.85 && metrics.pointerEvents === 'auto',
    `desktop inline database toolbar should remain available as compact title-line chrome: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.viewTabsHeight >= 28 &&
      metrics.viewTabsHeight <= 40 &&
      metrics.viewTabsOpacity >= 0.85 &&
      metrics.viewTabsPointerEvents === 'auto',
    `desktop inline database view tabs should stay visible through hover: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.buttonCount >= 5 && metrics.buttons.every((button) => button.height >= 24 && button.height <= 34),
    `desktop inline database revealed toolbar should keep compact hit areas: ${JSON.stringify(metrics)}`,
  );
  assert(
    ['Filter', 'Sort', 'Search database rows'].every((label) =>
      metrics.buttons.some((button) => button.label === label)
    ) &&
      metrics.buttons.some((button) => button.label === 'Database settings') &&
      metrics.buttons.some((button) => isNewDatabaseButtonLabel(button.label)) &&
      !metrics.buttons.some((button) => button.label === 'Properties'),
    `desktop inline database revealed toolbar should keep core quick controls without duplicating Properties: ${JSON.stringify(metrics.buttons)}`,
  );
  assert(
    metrics.inlineActionsOpacity >= 0.85 && metrics.inlineActionsPointerEvents === 'auto',
    `desktop inline database title actions should reveal on hover: ${JSON.stringify(metrics)}`,
  );
  assert(
      metrics.inlineOpenActionWidth >= 18 &&
      metrics.inlineOpenActionWidth <= 28 &&
      metrics.inlineTitleLeft - metrics.inlineOpenActionRight >= 2 &&
      metrics.inlineTitleLeft - metrics.inlineOpenActionRight <= 12 &&
      metrics.inlineAddViewActionWidth >= 18 &&
      metrics.inlineAddViewActionWidth <= 28 &&
      metrics.inlineAddViewActionLeft - metrics.inlineTitleRight >= 0 &&
      metrics.inlineAddViewActionLeft - metrics.inlineTitleRight <= 12 &&
      metrics.inlineActionsLeft - metrics.inlineAddViewActionRight >= 0 &&
      metrics.inlineActionsLeft - metrics.inlineAddViewActionRight <= 12,
    `desktop linked inline database title actions should sit as leading open arrow, title, add view, then ellipsis without drifting to the far edge: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.inlineActionButtonCount === 1 &&
      metrics.inlineActionButtons.every(
        (button) =>
          button.ariaLabel.endsWith(' options') &&
          button.width >= 20 &&
          button.width <= 26 &&
          button.height >= 20 &&
          button.height <= 26 &&
          button.text.length === 0,
      ),
    `desktop inline database title actions should collapse to one compact Hanji ellipsis menu: ${JSON.stringify(metrics)}`,
  );
}

async function assertInlineDatabaseSettingsMenu(page, inlineBlockId) {
  const root = page.locator(`[data-block-id="${inlineBlockId}"] [data-placement="inline"]`).first();
  const settingsButton = root.getByRole('button', { name: 'Database settings' });
  await settingsButton.click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'View settings' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="View settings"]');
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing view settings dialog' };
    const rect = dialog.getBoundingClientRect();
    const text = dialog.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const buttons = Array.from(dialog.querySelectorAll('button')).map((button) => ({
      disabled: button.disabled,
      text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
    return {
      ok: true,
      bottom: rect.bottom,
      buttonTexts: buttons.map((button) => button.text),
      hasPropertiesDialog: Boolean(document.querySelector('[role="dialog"][aria-label="Property visibility"]')),
      left: rect.left,
      right: rect.right,
      text,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'inline database settings menu contract could not run');
  assert(!metrics.hasPropertiesDialog, `database settings button should open the view settings hub first, not the Properties panel: ${JSON.stringify(metrics)}`);
  assert(
    metrics.width >= 240 &&
      metrics.width <= 320 &&
      metrics.left >= 8 &&
      metrics.right <= metrics.viewportWidth - 8 &&
      metrics.top >= 8 &&
      metrics.bottom <= metrics.viewportHeight + 28,
    `inline database settings menu should stay compact and viewport-clamped: ${JSON.stringify(metrics)}`,
  );
  assert(
    ['View settings', 'Layout', 'Property visibility', 'Filter', 'Sort', 'Copy view link', 'Data source settings', 'Edit properties'].every((label) =>
      metrics.text.includes(label)
    ),
    `inline database settings menu should mirror the Hanji view settings hub before drilling into Properties: ${JSON.stringify(metrics)}`,
  );
}

async function assertInlineDatabaseSettingsSubmenu(page) {
  const settingsMenu = page.getByRole('dialog', { name: 'View settings' });
  await settingsMenu.getByRole('button', { name: /Property visibility/ }).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: PROPERTY_DIALOG_LABEL }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const metrics = await page.evaluate(() => {
    const settingsDialog = document.querySelector('[role="dialog"][aria-label="View settings"]');
    const propertiesDialog = document.querySelector('[role="dialog"][aria-label="Property visibility"]');
    if (!(propertiesDialog instanceof HTMLElement)) {
      return { ok: false, reason: 'missing properties submenu dialog' };
    }
    const rect = propertiesDialog.getBoundingClientRect();
    const formText = Array.from(propertiesDialog.querySelectorAll('input, textarea, select'))
      .map((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return `${element.value} ${element.placeholder}`;
        }
        if (element instanceof HTMLSelectElement) {
          return Array.from(element.selectedOptions).map((option) => option.textContent ?? '').join(' ');
        }
        return '';
      })
      .join(' ');
    const text = `${propertiesDialog.textContent ?? ''} ${formText}`.replace(/\s+/g, ' ').trim();
    const rows = Array.from(propertiesDialog.querySelectorAll('[data-property-row]')).filter(
      (row) => row instanceof HTMLElement && row.getBoundingClientRect().height > 0,
    );
    const visibleButtons = Array.from(propertiesDialog.querySelectorAll('[data-property-visible="true"]')).filter(
      (button) => button instanceof HTMLElement && button.getBoundingClientRect().height > 0,
    );
    const hiddenButtons = Array.from(propertiesDialog.querySelectorAll('[data-property-visible="false"]')).filter(
      (button) => button instanceof HTMLElement && button.getBoundingClientRect().height > 0,
    );
    const intersectingOutsideControls = Array.from(document.querySelectorAll('button')).flatMap((button) => {
      if (!(button instanceof HTMLElement)) return [];
      if (propertiesDialog.contains(button)) return [];
      const buttonRect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        buttonRect.width <= 0 ||
        buttonRect.height <= 0
      ) {
        return [];
      }
      const xOverlap = Math.max(0, Math.min(rect.right, buttonRect.right) - Math.max(rect.left, buttonRect.left));
      const yOverlap = Math.max(0, Math.min(rect.bottom, buttonRect.bottom) - Math.max(rect.top, buttonRect.top));
      const overlapArea = xOverlap * yOverlap;
      if (overlapArea < 16) return [];
      const sampleX = Math.max(rect.left, Math.min(rect.right - 1, Math.max(buttonRect.left, rect.left) + xOverlap / 2));
      const sampleY = Math.max(rect.top, Math.min(rect.bottom - 1, Math.max(buttonRect.top, rect.top) + yOverlap / 2));
      const topElement = document.elementFromPoint(sampleX, sampleY);
      if (!topElement || propertiesDialog.contains(topElement)) return [];
      if (topElement !== button && !button.contains(topElement)) return [];
      return [{
        aria: button.getAttribute('aria-label') ?? '',
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        x: Math.round(buttonRect.left),
        y: Math.round(buttonRect.top),
        width: Math.round(buttonRect.width),
        height: Math.round(buttonRect.height),
      }];
    });
    return {
      ok: true,
      bottom: rect.bottom,
      hasRequestedVisibilityCopy: ['Property visibility', 'Search for a property', 'Shown in table', 'Hidden in table', 'Hide all', 'Show all'].every((label) =>
        text.includes(label)
      ),
      hiddenButtonCount: hiddenButtons.length,
      intersectingOutsideControls,
      left: rect.left,
      propertiesText: text,
      right: rect.right,
      rowCount: rows.length,
      settingsStillOpen: settingsDialog instanceof HTMLElement,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      visibleButtonCount: visibleButtons.length,
      width: rect.width,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'inline database settings submenu contract could not run');
  assert(!metrics.settingsStillOpen, `opening Properties from view settings should replace the settings hub: ${JSON.stringify(metrics)}`);
  assert(
    metrics.width >= 330 &&
      metrics.width <= 390 &&
      metrics.left >= 8 &&
      metrics.right <= metrics.viewportWidth - 8 &&
      metrics.top >= 8 &&
      metrics.bottom <= metrics.viewportHeight + 28,
    `Properties from view settings should use the requested compact Korean visibility panel: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.hasRequestedVisibilityCopy &&
      metrics.rowCount >= 4 &&
      metrics.visibleButtonCount >= 1 &&
      metrics.hiddenButtonCount >= 1,
    `Properties entry in the view settings menu should lead to the Korean shown/hidden visibility panel: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.intersectingOutsideControls.length === 0,
    `Properties panel should render above sibling inline database toolbar/new-button chrome: ${JSON.stringify(metrics)}`,
  );
}

async function assertInlineDatabaseSourcePropertyEditMenu(page) {
  const settingsMenu = page.getByRole('dialog', { name: 'View settings' });
  await settingsMenu.getByRole('button', { name: /Edit properties/ }).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: /^Properties$/ }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const metrics = await page.evaluate(() => {
    const settingsDialog = document.querySelector('[role="dialog"][aria-label="View settings"]');
    const visibilityDialog = document.querySelector('[role="dialog"][aria-label="Property visibility"]');
    const editDialog = document.querySelector('[role="dialog"][aria-label="Properties"]');
    if (!(editDialog instanceof HTMLElement)) {
      return { ok: false, reason: 'missing source property editor dialog' };
    }
    const rect = editDialog.getBoundingClientRect();
    const formText = Array.from(editDialog.querySelectorAll('input, textarea, select'))
      .map((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return `${element.value} ${element.placeholder}`;
        }
        if (element instanceof HTMLSelectElement) {
          return Array.from(element.selectedOptions).map((option) => option.textContent ?? '').join(' ');
        }
        return '';
      })
      .join(' ');
    const text = `${editDialog.textContent ?? ''} ${formText}`.replace(/\s+/g, ' ').trim();
    const rows = Array.from(editDialog.querySelectorAll('[data-source-property-row]')).filter(
      (row) => row instanceof HTMLElement && row.getBoundingClientRect().height > 0,
    );
    const rowTexts = rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const visibilityRows = Array.from(editDialog.querySelectorAll('[data-property-row]')).filter(
      (row) => row instanceof HTMLElement && row.getBoundingClientRect().height > 0,
    );
    const eyeControls = Array.from(editDialog.querySelectorAll('[data-property-visible]')).filter(
      (button) => button instanceof HTMLElement && button.getBoundingClientRect().height > 0,
    );
    const dragHandles = Array.from(editDialog.querySelectorAll('[data-property-drag-handle]')).filter(
      (button) => button instanceof HTMLElement && button.getBoundingClientRect().height > 0,
    );
    const propertyRowButtons = rows.filter((row) => row.tagName === 'BUTTON');
    const intersectingOutsideControls = Array.from(document.querySelectorAll('button')).flatMap((button) => {
      if (!(button instanceof HTMLElement)) return [];
      if (editDialog.contains(button)) return [];
      const buttonRect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        buttonRect.width <= 0 ||
        buttonRect.height <= 0
      ) {
        return [];
      }
      const xOverlap = Math.max(0, Math.min(rect.right, buttonRect.right) - Math.max(rect.left, buttonRect.left));
      const yOverlap = Math.max(0, Math.min(rect.bottom, buttonRect.bottom) - Math.max(rect.top, buttonRect.top));
      const overlapArea = xOverlap * yOverlap;
      if (overlapArea < 16) return [];
      const sampleX = Math.max(rect.left, Math.min(rect.right - 1, Math.max(buttonRect.left, rect.left) + xOverlap / 2));
      const sampleY = Math.max(rect.top, Math.min(rect.bottom - 1, Math.max(buttonRect.top, rect.top) + yOverlap / 2));
      const topElement = document.elementFromPoint(sampleX, sampleY);
      if (!topElement || editDialog.contains(topElement)) return [];
      if (topElement !== button && !button.contains(topElement)) return [];
      return [{
        aria: button.getAttribute('aria-label') ?? '',
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        x: Math.round(buttonRect.left),
        y: Math.round(buttonRect.top),
        width: Math.round(buttonRect.width),
        height: Math.round(buttonRect.height),
      }];
    });
    return {
      ok: true,
      bottom: rect.bottom,
      hasEditCopy: ['Properties', 'Search for a property', '수입 항목', '금액', '상태', '숨김 메모', 'New property', 'Deleted properties', 'Learn about properties'].every((label) =>
        text.includes(label)
      ),
      hasVisibilityCopy: ['Shown in table', 'Hidden in table', 'Hide all', 'Show all'].some((label) =>
        text.includes(label)
      ),
      intersectingOutsideControls,
      left: rect.left,
      propertyRowButtonCount: propertyRowButtons.length,
      right: rect.right,
      rowCount: rows.length,
      rowTexts,
      settingsStillOpen: settingsDialog instanceof HTMLElement,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      visibilityDialogOpen: visibilityDialog instanceof HTMLElement,
      visibilityRowCount: visibilityRows.length,
      eyeControlCount: eyeControls.length,
      dragHandleCount: dragHandles.length,
      width: rect.width,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'inline database source property editor contract could not run');
  assert(!metrics.settingsStillOpen, `opening source property edit should replace the settings hub: ${JSON.stringify(metrics)}`);
  assert(!metrics.visibilityDialogOpen, `source property edit should not open the visibility panel: ${JSON.stringify(metrics)}`);
  assert(
    metrics.width >= 290 &&
      metrics.width <= 340 &&
      metrics.left >= 8 &&
      metrics.right <= metrics.viewportWidth - 8 &&
      metrics.top >= 8 &&
      metrics.bottom <= metrics.viewportHeight + 28,
    `source property edit should use the compact Hanji Korean panel: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.hasEditCopy &&
      !metrics.hasVisibilityCopy &&
      metrics.rowCount >= 4 &&
      metrics.propertyRowButtonCount === metrics.rowCount &&
      metrics.visibilityRowCount === 0 &&
      metrics.eyeControlCount === 0 &&
      metrics.dragHandleCount === 0,
    `source property edit should be a flat data-source property list, not the shown/hidden visibility manager: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.rowTexts.slice(0, 4).join('|') === '수입 항목|금액|상태|숨김 메모',
    `source property edit should follow database property order rather than view visibility order: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.intersectingOutsideControls.length === 0,
    `source property edit panel should render above sibling inline database toolbar/new-button chrome: ${JSON.stringify(metrics)}`,
  );
}

async function assertInlineDatabaseNewPropertyTypeMenu(page) {
  const dialog = page.getByRole('dialog', { name: /^Properties$/ });
  await dialog.getByRole('button', { name: /^New property$/ }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => {
      const editDialog = document.querySelector('[role="dialog"][aria-label="Properties"]');
      return editDialog instanceof HTMLElement && (editDialog.textContent ?? '').includes('New property');
    },
    null,
    { timeout: options.timeoutMs },
  );
  const metrics = await page.evaluate(() => {
    const editDialog = document.querySelector('[role="dialog"][aria-label="Properties"]');
    if (!(editDialog instanceof HTMLElement)) {
      return { ok: false, reason: 'missing source property editor dialog' };
    }
    const rect = editDialog.getBoundingClientRect();
    const text = editDialog.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const typeRows = Array.from(editDialog.querySelectorAll('[data-source-property-type]')).filter(
      (row) => row instanceof HTMLElement && row.getBoundingClientRect().height > 0,
    );
    const typeLabels = typeRows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const propertyRows = Array.from(editDialog.querySelectorAll('[data-source-property-row]')).filter(
      (row) => row instanceof HTMLElement && row.getBoundingClientRect().height > 0,
    );
    return {
      ok: true,
      bottom: rect.bottom,
      hasTypePickerCopy: ['New property', 'Type', 'Text', 'Number', 'Select', 'Multi-select', 'Status', 'Date', 'Person', 'Files & media', 'Checkbox', 'URL', 'Email', 'Phone', 'Formula', 'Relation', 'Rollup'].every((label) =>
        text.includes(label)
      ),
      left: rect.left,
      propertyRowCount: propertyRows.length,
      right: rect.right,
      text,
      top: rect.top,
      typeLabels,
      typeRowCount: typeRows.length,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'new source property type picker contract could not run');
  assert(
    metrics.width >= 290 &&
      metrics.width <= 340 &&
      metrics.left >= 8 &&
      metrics.right <= metrics.viewportWidth - 8 &&
      metrics.top >= 8 &&
      metrics.bottom <= metrics.viewportHeight + 28,
    `new source property type picker should stay in the compact Hanji panel: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.hasTypePickerCopy &&
      metrics.typeRowCount >= 18 &&
      metrics.propertyRowCount === 0 &&
      metrics.typeLabels.slice(0, 5).join('|') === 'Text|Number|Select|Multi-select|Status',
    `new source property should open a type picker instead of immediately creating a text property: ${JSON.stringify(metrics)}`,
  );
}

async function assertInlineDatabaseNewPropertyTypeSelection(page) {
  await page.getByRole('button', { name: /^Email$/ }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => {
      const editDialog = document.querySelector('[role="dialog"][aria-label="Properties"]');
      if (!(editDialog instanceof HTMLElement)) return false;
      const inputs = Array.from(editDialog.querySelectorAll('input'));
      return inputs.some((input) => input instanceof HTMLInputElement && input.value === 'Email');
    },
    null,
    { timeout: options.timeoutMs },
  );
  const metrics = await page.evaluate(() => {
    const editDialog = document.querySelector('[role="dialog"][aria-label="Properties"]');
    if (!(editDialog instanceof HTMLElement)) {
      return { ok: false, reason: 'missing source property editor dialog after type selection' };
    }
    const text = editDialog.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const inputs = Array.from(editDialog.querySelectorAll('input')).map((input) => ({
      aria: input.getAttribute('aria-label') ?? '',
      value: input.value,
    }));
    const typeRows = Array.from(editDialog.querySelectorAll('[data-source-property-type]')).filter(
      (row) => row instanceof HTMLElement && row.getBoundingClientRect().height > 0,
    );
    return {
      ok: true,
      hasDetailCopy: ['Name', 'Type', 'Description'].every((label) => text.includes(label)),
      inputs,
      text,
      titleText: editDialog.querySelector('[class*="propertiesVisibilityTitle"]')?.textContent?.trim() ?? '',
      typeRowCount: typeRows.length,
    };
  });
  assert(metrics.ok, metrics.reason ?? 'new source property type selection contract could not run');
  assert(
    metrics.hasDetailCopy &&
      metrics.inputs.some((input) => input.value === 'Email') &&
      metrics.titleText === 'Email' &&
      metrics.typeRowCount === 0,
    `selecting a new property type should create that property and open its detail editor: ${JSON.stringify(metrics)}`,
  );

  const dialog = page.getByRole('dialog', { name: /^Properties$/ });
  const nameInput = dialog.getByLabel('Name', { exact: true });
  await dispatchComposingEnter(nameInput);
  await nameInput.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const composingState = await page.evaluate(() => {
    const editDialog = document.querySelector('[role="dialog"][aria-label="Properties"]');
    const title = editDialog?.querySelector('[class*="propertiesVisibilityTitle"]')?.textContent?.trim() ?? '';
    const hasNameInput = Array.from(editDialog?.querySelectorAll('input') ?? []).some(
      (input) => input instanceof HTMLInputElement && input.value === 'Email',
    );
    return { title, hasNameInput };
  });
  assert(
    composingState.title === 'Email' && composingState.hasNameInput,
    `source property detail should ignore composing Enter in the name input: ${JSON.stringify(composingState)}`,
  );

  await nameInput.press('Enter', { timeout: options.timeoutMs });
  await page.waitForFunction(
    () => {
      const editDialog = document.querySelector('[role="dialog"][aria-label="Properties"]');
      if (!(editDialog instanceof HTMLElement)) return false;
      const title = editDialog.querySelector('[class*="propertiesVisibilityTitle"]')?.textContent?.trim() ?? '';
      const rows = Array.from(editDialog.querySelectorAll('[data-source-property-row]')).filter(
        (row) => row instanceof HTMLElement && row.getBoundingClientRect().height > 0,
      );
      return title === 'Properties' && rows.length >= 1;
    },
    null,
    { timeout: options.timeoutMs },
  );
}

async function assertInlineDatabaseLayoutSubmenu(page) {
  const settingsMenu = page.getByRole('dialog', { name: 'View settings' });
  await settingsMenu.getByRole('button', { name: /Layout/ }).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Layout options' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const metrics = await page.evaluate(() => {
    const settingsDialog = document.querySelector('[role="dialog"][aria-label="View settings"]');
    const layoutDialog = document.querySelector('[role="dialog"][aria-label="Layout options"]');
    if (!(layoutDialog instanceof HTMLElement)) {
      return { ok: false, reason: 'missing layout submenu dialog' };
    }
    const rect = layoutDialog.getBoundingClientRect();
    const text = layoutDialog.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const isNewButtonLabel = (label) => label === 'New database page' || label === '새 데이터베이스 페이지';
    const intersectingChrome = Array.from(document.querySelectorAll('button'))
      .map((button) => {
        const buttonText = button.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const label = button.getAttribute('aria-label') ?? buttonText;
        const buttonRect = button.getBoundingClientRect();
        const left = Math.max(rect.left, buttonRect.left);
        const right = Math.min(rect.right, buttonRect.right);
        const top = Math.max(rect.top, buttonRect.top);
        const bottom = Math.min(rect.bottom, buttonRect.bottom);
        const intersects = right > left && bottom > top;
        if (!intersects || !isNewButtonLabel(label)) return null;
        const sampleX = (left + right) / 2;
        const sampleY = (top + bottom) / 2;
        const topElement = document.elementFromPoint(sampleX, sampleY);
        return {
          coveredByLayoutDialog: topElement ? layoutDialog.contains(topElement) : false,
          label,
          topElementLabel: topElement?.getAttribute?.('aria-label') ?? topElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
      })
      .filter(Boolean);
    return {
      ok: true,
      bottom: rect.bottom,
      intersectingChrome,
      left: rect.left,
      right: rect.right,
      settingsStillOpen: settingsDialog instanceof HTMLElement,
      text,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'inline database layout submenu contract could not run');
  assert(!metrics.settingsStillOpen, `opening Layout from view settings should replace the settings hub: ${JSON.stringify(metrics)}`);
  assert(
    metrics.width >= 360 &&
      metrics.left >= 8 &&
      metrics.right <= metrics.viewportWidth - 8 &&
      metrics.top >= 8 &&
      metrics.bottom <= metrics.viewportHeight + 28,
    `inline database layout submenu should stay visible and viewport-clamped: ${JSON.stringify(metrics)}`,
  );
  assert(
    ['Layout', 'Open pages in', 'Row height', 'Initial load'].every((label) => metrics.text.includes(label)),
    `clicking Layout from settings should open the real layout controls: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.intersectingChrome.every((item) => item.coveredByLayoutDialog),
    `layout controls should render above the inline toolbar and New button chrome: ${JSON.stringify(metrics.intersectingChrome)}`,
  );
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-inline-database-layout-menu.png'),
    fullPage: false,
  });
  await page.getByRole('button', { name: 'Close layout options' }).click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Layout options' }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  });
}

async function assertColumnInlineDatabaseVisualContract(page, seed, { mobile }) {
  const metrics = await page.evaluate((expected) => {
    const columnList = document.querySelector(`[data-block-id="${CSS.escape(expected.columnListId)}"]`);
    const leftColumn = document.querySelector(`[data-column-id="${CSS.escape(expected.leftColumnId)}"]`);
    const rightColumn = document.querySelector(`[data-column-id="${CSS.escape(expected.rightColumnId)}"]`);
    const leftBlock = document.querySelector(`[data-block-id="${CSS.escape(expected.leftInlineBlockId)}"]`);
    const rightBlock = document.querySelector(`[data-block-id="${CSS.escape(expected.rightInlineBlockId)}"]`);
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        bottom: r.bottom,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        width: r.width,
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
    const round = (value) => Math.round(value * 100) / 100;
    const inlineMetrics = (block, title) => {
      if (!(block instanceof HTMLElement)) return { ok: false, reason: `missing ${title} block` };
      const titleElement = block.querySelector('[data-inline-database-title]');
      const wrapper = titleElement?.closest('[data-inline-database-wrapper]');
      const icon = wrapper?.querySelector('[data-inline-database-icon="true"]');
      const openAction = wrapper?.querySelector('[data-inline-database-open-action="true"]');
      const database = block.querySelector('[data-placement="inline"]');
      const tablist = database?.querySelector('[role="tablist"]');
      const toolbar = database?.querySelector('[role="toolbar"][aria-label="Database toolbar"]');
      const cells = Array.from(database?.querySelectorAll('[data-table-cell]') ?? []);
      const controls = block.closest('[data-column-id]')?.querySelector('[class*="columnControls"]');
      if (
        !(titleElement instanceof HTMLElement) ||
        !(database instanceof HTMLElement) ||
        !(toolbar instanceof HTMLElement)
      ) {
        return {
          ok: false,
          reason: `missing ${title} inline database markers`,
          cellCount: cells.length,
          database: database instanceof HTMLElement,
          icon: icon instanceof HTMLElement,
          openAction: openAction instanceof HTMLElement,
          tablist: tablist instanceof HTMLElement,
          titleElement: titleElement instanceof HTMLElement,
          toolbar: toolbar instanceof HTMLElement,
        };
      }
      const toolbarStyle = getComputedStyle(toolbar);
      const tablistStyle = tablist instanceof HTMLElement ? getComputedStyle(tablist) : null;
      const buttonLabel = (button) =>
        button.getAttribute('aria-label') ||
        button.getAttribute('title') ||
        button.textContent?.replace(/\s+/g, ' ').trim() ||
        '';
      const toolbarButtons = Array.from(toolbar.querySelectorAll('button'))
        .filter((button) => {
          if (!(button instanceof HTMLElement)) return false;
          const style = getComputedStyle(button);
          const r = button.getBoundingClientRect();
          return button.offsetParent !== null &&
            style.visibility !== 'hidden' &&
            Number.parseFloat(style.opacity || '1') > 0.05 &&
            style.pointerEvents !== 'none' &&
            r.width > 0 &&
            r.height > 0;
        })
        .map((button) => {
          const r = rect(button);
          const style = getComputedStyle(button);
          return {
            centerVisible: document.elementsFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            ).some((element) => element === button || button.contains(element)),
            clientWidth: button.clientWidth,
            colorAlpha: round(cssAlpha(style.color)),
            fontSize: round(Number.parseFloat(style.fontSize || '0')),
            height: r.height,
            label: buttonLabel(button),
            opacity: round(Number.parseFloat(style.opacity || '1')),
            pointerEvents: style.pointerEvents,
            right: r.right,
            scrollWidth: button.scrollWidth,
            text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            width: r.width,
          };
        });
      const summaryRow = database.querySelector('[data-table-summary-row]');
      const summaryText = summaryRow?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const visibleSummaryTexts = summaryRow instanceof HTMLElement
        ? Array.from(summaryRow.querySelectorAll('button, span, strong'))
            .filter((element) => {
              if (!(element instanceof HTMLElement)) return false;
              const style = getComputedStyle(element);
              const r = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && Number.parseFloat(style.opacity) > 0.05 && r.width > 0 && r.height > 0;
            })
            .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
            .filter(Boolean)
        : [];
      return {
        ok: true,
        block: rect(block),
        controlsOpacity: controls instanceof HTMLElement ? Number.parseFloat(getComputedStyle(controls).opacity) : null,
        database: rect(database),
        tableCellCount: cells.length,
        title:
          titleElement instanceof HTMLInputElement
            ? titleElement.value
            : titleElement.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        hasDatabaseIcon: icon instanceof HTMLElement,
        hasOpenAction: openAction instanceof HTMLElement,
        isLinkedSource: wrapper?.getAttribute('data-inline-database-linked-source') === 'true',
        openActionLabel: openAction instanceof HTMLElement ? openAction.getAttribute('aria-label') ?? '' : '',
        openActionRect: openAction instanceof HTMLElement ? rect(openAction) : null,
        titleClickable: titleElement.getAttribute('data-inline-database-clickable') ?? '',
        titleEditable: titleElement.getAttribute('data-inline-database-editable-title') ?? '',
        titleRect: rect(titleElement),
        titleRole: titleElement.getAttribute('role') ?? '',
        toolbar: rect(toolbar),
        toolbarButtons,
        toolbarOpacity: Number.parseFloat(toolbarStyle.opacity),
        toolbarPointerEvents: toolbarStyle.pointerEvents,
        summaryText,
        visibleSummaryTexts,
        viewTabs: tablist instanceof HTMLElement ? rect(tablist) : null,
        viewTabsOpacity: tablistStyle ? Number.parseFloat(tablistStyle.opacity) : null,
        viewTabsPointerEvents: tablistStyle?.pointerEvents ?? null,
      };
    };
    if (!(columnList instanceof HTMLElement) || !(leftColumn instanceof HTMLElement) || !(rightColumn instanceof HTMLElement)) {
      return {
        ok: false,
        reason: 'missing column inline database fixture',
        hasColumnList: columnList instanceof HTMLElement,
        hasLeftColumn: leftColumn instanceof HTMLElement,
        hasRightColumn: rightColumn instanceof HTMLElement,
      };
    }
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      columnList: rect(columnList),
      documentScrollWidth: document.documentElement.scrollWidth,
      left: {
        column: rect(leftColumn),
        inline: inlineMetrics(leftBlock, expected.leftDatabaseTitle),
      },
      right: {
        column: rect(rightColumn),
        inline: inlineMetrics(rightBlock, expected.rightDatabaseTitle),
      },
      viewportWidth: window.innerWidth,
    };
  }, {
    columnListId: seed.columnListId,
    leftColumnId: seed.leftColumnId,
    leftDatabaseTitle: seed.databaseTitle,
    leftInlineBlockId: seed.leftInlineBlockId,
    rightColumnId: seed.rightColumnId,
    rightDatabaseTitle: seed.rightDatabaseTitle,
    rightInlineBlockId: seed.rightInlineBlockId,
  });

  assert(metrics.ok, metrics.reason ?? 'column inline database contract could not run');
  assert(
    metrics.left.inline.ok,
    metrics.left.inline.reason ? `${metrics.left.inline.reason}: ${JSON.stringify(metrics.left)}` : `left inline database missing: ${JSON.stringify(metrics.left)}`,
  );
  assert(
    metrics.right.inline.ok,
    metrics.right.inline.reason ? `${metrics.right.inline.reason}: ${JSON.stringify(metrics.right)}` : `right inline database missing: ${JSON.stringify(metrics.right)}`,
  );
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `column inline databases should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.left.inline.title === seed.databaseTitle, `left column database title drifted: ${JSON.stringify(metrics.left.inline)}`);
  assert(metrics.right.inline.title === seed.rightDatabaseTitle, `right column database title drifted: ${JSON.stringify(metrics.right.inline)}`);
  for (const item of [metrics.left.inline, metrics.right.inline]) {
    assert(item.titleRect.height >= 28 && item.titleRect.height <= 40, `column inline database title height drifted: ${JSON.stringify(item)}`);
    assert(!item.hasDatabaseIcon, `column inline database title should not show a separate database icon: ${JSON.stringify(item)}`);
    assert(
      !item.isLinkedSource &&
        !item.hasOpenAction &&
        item.titleClickable !== 'true' &&
        item.titleEditable === 'true' &&
        item.titleRole === 'button',
      `local column inline database titles should edit in place without a linked-source open arrow: ${JSON.stringify(item)}`,
    );
    assert(item.tableCellCount >= 6, `column inline database should render rows and properties: ${JSON.stringify(item)}`);
    assert(
      item.visibleSummaryTexts.some((text) => /sum/i.test(text)) &&
        item.visibleSummaryTexts.some((text) => text.includes(item.title === seed.databaseTitle ? '4,260,000' : '1,725,000')),
      `column inline database should show configured amount summary: ${JSON.stringify(item)}`,
    );
    assert(
      !item.visibleSummaryTexts.some((text) => /^3 rows$/i.test(text)),
      `column inline database should not keep default row count visible beside a configured summary: ${JSON.stringify(item)}`,
    );
  }

  const toolbarButtonOk = (button) => {
    const isNewButton = isNewDatabaseButtonLabel(button.label);
    const isTemplateButton = button.label === 'Choose database template';
    const maxWidth = isNewButton ? 128 : isTemplateButton ? 40 : 64;
    const visibleLabelFits = !isNewButton || button.fontSize === 0 || button.scrollWidth <= button.clientWidth + 1;
    return (
      button.width <= maxWidth &&
      button.height >= 22 &&
      button.height <= 32 &&
      button.opacity >= 0.85 &&
      button.colorAlpha >= 0.44 &&
      button.pointerEvents !== 'none' &&
      button.centerVisible &&
      visibleLabelFits
    );
  };
  const visibleTabsOk = (item) =>
    item.viewTabs === null ||
    (item.viewTabs.height >= 28 &&
      item.viewTabs.height <= 40 &&
      item.viewTabsOpacity >= 0.85 &&
      item.viewTabsPointerEvents === 'auto');
  const toolbarAttachedToTabsOk = (item) =>
    item.viewTabs === null ||
    (item.toolbar.top >= item.viewTabs.top - 2 && item.toolbar.top <= item.viewTabs.top + 8);

  if (mobile) {
    assert(metrics.viewportWidth <= 430, `mobile column inline database contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(
      Math.abs(metrics.left.column.left - metrics.right.column.left) <= 1 &&
        metrics.right.column.top > metrics.left.column.bottom - 4,
      `mobile inline database columns should stack into one document column: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.left.inline.controlsOpacity === null || metrics.left.inline.controlsOpacity <= 0.2,
      `mobile column controls should stay quiet at rest for the left inline database: ${JSON.stringify(metrics.left.inline)}`,
    );
    assert(
      metrics.right.inline.controlsOpacity === null || metrics.right.inline.controlsOpacity <= 0.2,
      `mobile column controls should stay quiet at rest for the right inline database: ${JSON.stringify(metrics.right.inline)}`,
    );
    assert(
      [metrics.left.inline, metrics.right.inline].every(
        (item) =>
          visibleTabsOk(item) &&
          item.toolbar.height >= 24 &&
          item.toolbar.height <= 36 &&
          item.toolbarOpacity >= 0.85 &&
          item.toolbarButtons.every(toolbarButtonOk)
      ),
      `mobile column inline database toolbars should stay compact and touch-available: ${JSON.stringify(metrics)}`,
    );
  } else {
    assert(
      metrics.right.column.left > metrics.left.column.right + 24 &&
        Math.abs(metrics.left.column.top - metrics.right.column.top) <= 4,
      `desktop inline database columns should sit side by side with an even top rhythm: ${JSON.stringify(metrics)}`,
    );
    assert(metrics.left.column.width >= 260 && metrics.right.column.width >= 260, `desktop inline database columns should keep useful width: ${JSON.stringify(metrics)}`);
    assert(
      [metrics.left.inline, metrics.right.inline].every(
        (item) =>
          visibleTabsOk(item) &&
          item.toolbar.height >= 24 &&
          item.toolbar.height <= 36 &&
          item.toolbarOpacity >= 0.85 &&
          item.toolbarPointerEvents === 'auto' &&
          toolbarAttachedToTabsOk(item) &&
          item.toolbar.right <= item.database.right + 2 &&
          item.toolbarButtons.every((button) => button.right <= item.database.right + 2) &&
          item.toolbarButtons.length >= 5 &&
          item.toolbarButtons.every(toolbarButtonOk)
      ),
      `desktop column inline database tabs and toolbars should stay visible, compact, and attached at rest: ${JSON.stringify(metrics)}`,
    );
    assert(
      [metrics.left.inline, metrics.right.inline].every((item) =>
        ['Filter', 'Sort', 'Search database rows'].every((label) =>
          item.toolbarButtons.some((button) => button.label === label)
        ) &&
          item.toolbarButtons.some((button) => button.label === 'Database settings') &&
          item.toolbarButtons.some((button) => isNewDatabaseButtonLabel(button.label)) &&
          !item.toolbarButtons.some((button) => button.label === 'Properties') &&
          !item.toolbarButtons.some((button) => button.label === 'Layout')
      ),
      `desktop column inline database toolbars should keep quick controls without duplicating Properties next to settings: ${JSON.stringify(metrics)}`,
    );
  }
}

async function seedInlineDatabasePage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for inline database visual smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const databaseId = randomUUID();
  const rightDatabaseId = randomUUID();
  const emptyDatabaseId = randomUUID();
  const inlineBlockId = randomUUID();
  const legacyLinkedInlineBlockId = randomUUID();
  const emptyInlineBlockId = randomUUID();
  const introBlockId = randomUUID();
  const columnListId = randomUUID();
  const leftColumnId = randomUUID();
  const rightColumnId = randomUUID();
  const leftInlineBlockId = randomUUID();
  const rightInlineBlockId = randomUUID();
  const statusPropId = randomUUID();
  const amountPropId = randomUUID();
  const hiddenMemoPropId = randomUUID();
  const expenseStatusPropId = randomUUID();
  const expenseAmountPropId = randomUUID();
  const pageTitle = `Embedded finance ${suffix}`;
  const databaseTitle = '수입 (월별)';
  const rightDatabaseTitle = '지출 (월별)';
  const emptyDatabaseTitle = '';
  const amountText = '₩3,200,000';
  const rowTitles = ['월급', '부업', '정산'];
  const expenseRowTitles = ['월세', '식료품', '레이첼(Rachel)과 저녁 식사'];

  const page = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: pageTitle,
    icon: '💼',
    iconType: 'emoji',
    position: suffix,
  });
  assert(page?.page?.id === pageId, 'inline database visual parent page must be created');

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: pageId,
    parentType: 'page',
    title: databaseTitle,
    icon: '💰',
    iconType: 'emoji',
    viewType: 'table',
    properties: [
      { id: randomUUID(), name: '수입 항목', type: 'title', position: 1 },
      { id: amountPropId, name: '금액', type: 'number', position: 2, numberFormat: 'won' },
      {
        id: statusPropId,
        name: '상태',
        type: 'status',
        position: 3,
        options: [
          { id: 'planned', name: '예정', color: 'gray' },
          { id: 'done', name: '완료', color: 'green' },
        ],
      },
      {
        id: hiddenMemoPropId,
        name: '숨김 메모',
        type: 'rich_text',
        position: 4,
        description: '패널의 표에서 숨기기 섹션을 검증하기 위한 숨김 속성',
      },
    ],
  });
  assert(created?.page?.id === databaseId, 'inline database visual child database must be created');
  assert(Array.isArray(created?.rows) && created.rows.length >= 3, 'inline database visual smoke needs seeded rows');
  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'inline database visual smoke must receive a table view');
  assert(Array.isArray(created.properties), 'inline database visual smoke must receive created properties');
  const propertyOrder = created.properties.map((prop) => prop.id);
  const visibleProperties = propertyOrder.filter((propertyId) => propertyId !== hiddenMemoPropId);
  const importedInlineViewIds = [
    tableViewId,
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const importedInlineViewNames = [
    'Default view',
    '전체 테이블',
    '공급처',
    '설치업체',
    '내부직원',
    '개인고객',
  ];

  const expenses = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: rightDatabaseId,
    workspaceId,
    parentId: pageId,
    parentType: 'page',
    title: rightDatabaseTitle,
    icon: '💸',
    iconType: 'emoji',
    viewType: 'table',
    properties: [
      { id: randomUUID(), name: '지출 항목', type: 'title', position: 1 },
      { id: expenseAmountPropId, name: '금액', type: 'number', position: 2, numberFormat: 'won' },
      {
        id: expenseStatusPropId,
        name: '상태',
        type: 'status',
        position: 3,
        options: [
          { id: 'planned', name: '예정', color: 'gray' },
          { id: 'paid', name: '완료', color: 'red' },
        ],
      },
    ],
  });
  assert(expenses?.page?.id === rightDatabaseId, 'column inline database visual expense database must be created');
  assert(Array.isArray(expenses?.rows) && expenses.rows.length >= 3, 'column inline database visual smoke needs expense rows');
  const expenseTableViewId = expenses.views?.[0]?.id;
  assert(expenseTableViewId, 'column inline database visual smoke must receive an expense table view');
  const expenseVisibleProperties = expenses.properties.map((prop) => prop.id);

  const emptyCreated = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: emptyDatabaseId,
    workspaceId,
    parentId: pageId,
    parentType: 'page',
    title: emptyDatabaseTitle,
    icon: '🧾',
    iconType: 'emoji',
    viewType: 'table',
    properties: [
      { id: randomUUID(), name: '이름', type: 'title', position: 1 },
    ],
  });
  assert(emptyCreated?.page?.id === emptyDatabaseId, 'empty inline database visual child database must be created');
  assert(Array.isArray(emptyCreated?.rows), 'empty inline database visual smoke must receive seed rows to clear');
  const emptyTableViewId = emptyCreated.views?.[0]?.id;
  assert(emptyTableViewId, 'empty inline database visual smoke must receive a table view');
  for (const row of emptyCreated.rows) {
    await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
      action: 'trash',
      id: row.id,
    });
  }

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: tableViewId,
    workspaceId,
    patch: {
      name: importedInlineViewNames[0],
      position: 2,
      config: {
        propertyOrder,
        visibleProperties,
        tableCalculations: { [amountPropId]: 'sum' },
        notionViewId: tableViewId,
        notionViewChromeCreatedTime: new Date(suffix).toISOString(),
        notion: { type: 'table' },
      },
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    workspaceId,
    records: [
      ...importedInlineViewIds.slice(1).map((id, index) => ({
        id,
        databaseId,
        name: importedInlineViewNames[index + 1],
        type: 'table',
        position: index + 3,
        config: {
          propertyOrder,
          visibleProperties,
          notionViewId: id,
          notionViewChromeCreatedTime: new Date(suffix + index + 1).toISOString(),
          notion: { type: 'table' },
        },
      })),
      {
        id: randomUUID(),
        databaseId,
        name: 'Board',
        type: 'board',
        position: importedInlineViewIds.length + 3,
        config: { groupBy: statusPropId, propertyOrder, visibleProperties, cardSize: 'medium' },
      },
    ],
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: expenseTableViewId,
    workspaceId,
    patch: {
      name: 'Table',
      config: {
        propertyOrder: expenseVisibleProperties,
        visibleProperties: expenseVisibleProperties,
        tableCalculations: { [expenseAmountPropId]: 'sum' },
      },
    },
  });

  for (let index = 0; index < 3; index += 1) {
    const row = created.rows[index];
    await updateRow(baseUrl, session.accessToken, row.id, {
      title: rowTitles[index],
      properties: {
        [amountPropId]: index === 0 ? 3_200_000 : index === 1 ? 850_000 : 210_000,
        [statusPropId]: index === 2 ? 'planned' : 'done',
      },
    });
  }
  for (let index = 0; index < 3; index += 1) {
    const row = expenses.rows[index];
    await updateRow(baseUrl, session.accessToken, row.id, {
      title: expenseRowTitles[index],
      properties: {
        [expenseAmountPropId]: index === 0 ? 1_200_000 : index === 1 ? 430_000 : 95_000,
        [expenseStatusPropId]: index === 2 ? 'planned' : 'paid',
      },
    });
  }

  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: introBlockId,
        pageId,
        parentId: null,
        type: 'paragraph',
        content: {
          rich: [{ text: 'Inline databases should feel embedded in the page, not like a full-page database pasted into the document.' }],
        },
        plainText: 'Inline databases should feel embedded in the page, not like a full-page database pasted into the document.',
        position: 1,
      },
      {
        id: inlineBlockId,
        pageId,
        parentId: null,
        type: 'inline_database',
        content: {
          childPageId: databaseId,
          databaseViewId: tableViewId,
          databaseViewIds: importedInlineViewIds,
          notionLinkedViewIds: importedInlineViewIds,
        },
        plainText: databaseTitle,
        position: 2,
      },
      {
        id: legacyLinkedInlineBlockId,
        pageId,
        parentId: null,
        type: 'inline_database',
        content: {
          childPageId: databaseId,
          databaseViewId: tableViewId,
          linkedDatabaseSource: true,
        },
        plainText: databaseTitle,
        position: 2.5,
      },
      {
        id: columnListId,
        pageId,
        parentId: null,
        type: 'column_list',
        content: {},
        plainText: '',
        position: 4,
      },
      {
        id: emptyInlineBlockId,
        pageId,
        parentId: null,
        type: 'inline_database',
        content: { childPageId: emptyDatabaseId, databaseViewId: emptyTableViewId },
        plainText: emptyDatabaseTitle,
        position: 3,
      },
      {
        id: leftColumnId,
        pageId,
        parentId: columnListId,
        type: 'column',
        content: { width: 1 },
        plainText: '',
        position: 1,
      },
      {
        id: rightColumnId,
        pageId,
        parentId: columnListId,
        type: 'column',
        content: { width: 1 },
        plainText: '',
        position: 2,
      },
      {
        id: leftInlineBlockId,
        pageId,
        parentId: leftColumnId,
        type: 'inline_database',
        content: { childPageId: databaseId, databaseViewId: tableViewId },
        plainText: databaseTitle,
        position: 1,
      },
      {
        id: rightInlineBlockId,
        pageId,
        parentId: rightColumnId,
        type: 'inline_database',
        content: { childPageId: rightDatabaseId, databaseViewId: expenseTableViewId },
        plainText: rightDatabaseTitle,
        position: 1,
      },
    ],
  });
  assert(createdBlocks?.blocks?.length === 9, 'inline database visual smoke blocks must be created');

  return {
    accessToken: session.accessToken,
    amountText,
    columnListId,
    databaseId,
    databaseTitle,
    emptyDatabaseId,
    emptyDatabaseTitle,
    emptyInlineBlockId,
    emptyTableViewId,
    leftColumnId,
    leftInlineBlockId,
    inlineBlockId,
    importedInlineViewIds,
    importedInlineViewNames,
    legacyLinkedInlineBlockId,
    pageId,
    pageTitle,
    refreshToken: session.refreshToken,
    userId: session.userId,
    rightColumnId,
    rightDatabaseId,
    rightDatabaseTitle,
    rightInlineBlockId,
    rowTitles,
    tableViewId,
    workspaceId,
  };
}

async function updateRow(baseUrl, token, rowId, patch) {
  const updated = await callFunction(baseUrl, token, 'database-row-mutation', {
    action: 'update',
    id: rowId,
    patch,
  });
  assert(updated?.row?.id === rowId, `row ${rowId} must be updated`);
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, { call: callFunction }).catch(() => {});
  if (seed.databaseId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { call: callFunction }).catch(() => {});
  }
  if (seed.rightDatabaseId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.rightDatabaseId, { call: callFunction }).catch(() => {});
  }
  if (seed.emptyDatabaseId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.emptyDatabaseId, { call: callFunction }).catch(() => {});
  }
}

async function setTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem('hanji:theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.waitForTimeout(100);
}

async function setViewport(page, viewport) {
  await page.setViewportSize(viewport);
  const expectedMobile = viewport.width <= 767;
  await page.waitForFunction(
    ([width, expectedMobile]) => {
      if (window.innerWidth !== width) return false;
      const sidebar = document.querySelector('[aria-label="Sidebar"]');
      if (!sidebar) return true;
      return (sidebar.getAttribute('data-mobile') === 'true') === expectedMobile;
    },
    [viewport.width, expectedMobile],
    { timeout: options.timeoutMs },
  );
  if (expectedMobile) {
    await page.waitForFunction(
      () => {
        const sidebar = document.querySelector('[aria-label="Sidebar"]');
        if (!(sidebar instanceof HTMLElement)) return true;
        const rect = sidebar.getBoundingClientRect();
        const open = sidebar.getAttribute('data-open') === 'true';
        return open ? rect.left >= -1 && rect.right > 200 : rect.right <= 4;
      },
      undefined,
      { timeout: options.timeoutMs },
    );
  }
  await page.waitForTimeout(80);
}

function parseArgs(args) {
  const parsed = {
    apiUrl: process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
        throw new Error(`${arg} must be a number >= 1000`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.screenshotDir = resolve(parsed.screenshotDir);
  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/inline-database-visual-smoke.mjs [options]

Captures a seeded page with an embedded inline database and checks Notion-style
title, view-tab, toolbar, table-density, and mobile containment contracts.

Options:
  --url <url>                 App URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>             EdgeBase API URL. Defaults to HANJI_EDGEBASE_API_URL or ${DEFAULT_BASE_URL}.
  --screenshot-dir <path>     Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
  --timeout-ms <number>       Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                    Show the browser while running.
`);
}

async function dispatchComposingEnter(locator) {
  await locator.evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      which: 229,
    });
    Object.defineProperty(event, 'isComposing', { value: true });
    element.dispatchEvent(event);
  });
}

function isNewDatabaseButtonLabel(label) {
  return label === 'New database page' || label === '새 데이터베이스 페이지';
}
