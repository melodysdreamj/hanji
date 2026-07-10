#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'slash-menu');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL slash menu visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Slash menu visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Slash menu visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedSlashMenuPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureSlashMenuVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      target: seed.targets.desktop,
      viewport: { width: 1440, height: 1000 },
    });
    await captureSlashMenuVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark',
      target: seed.targets.desktopDark,
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
    });
    await captureSlashMenuVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      target: seed.targets.mobile,
      viewport: { width: 390, height: 844 },
    });
    await captureSlashMenuVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile-dark',
      target: seed.targets.mobileDark,
      theme: 'dark',
      viewport: { width: 390, height: 844 },
    });
    await captureDatabaseSourcePickerVariant(browser, appUrl, seed, {
      prefix: 'desktop-database-source',
      target: seed.targets.desktop,
      viewport: { width: 1440, height: 1000 },
    });
    await captureDatabaseSourcePickerVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark-database-source',
      target: seed.targets.desktopDark,
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
    });
    await captureDatabaseSourceNewDatabaseVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark-database-source-new',
      target: seed.targets.mobileDark,
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
    });
    await captureDatabaseSourceLowPlacementVariant(browser, appUrl, seed, {
      prefix: 'desktop-database-source-low',
      target: {
        ...seed.targets.desktopLow,
        blockId: seed.targets.desktopLow.lowBlockId,
      },
      viewport: { width: 1440, height: 760 },
    });
    await captureTemplateEditorSlashMenuVariant(browser, appUrl, seed, {
      prefix: 'desktop-template-editor',
      target: seed.targets.desktopLow,
      viewport: { width: 1440, height: 760 },
    });

    console.log('PASS slash menu visual layout, database source picker flow, and template editor block menu are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop',
      'desktop-dark',
      'mobile',
      'mobile-dark',
      'desktop-database-source-picker',
      'desktop-database-source-linked',
      'desktop-dark-database-source-picker',
      'desktop-dark-database-source-linked',
      'desktop-dark-database-source-new',
      'desktop-database-source-low-picker',
      'desktop-template-editor-template-editor',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}-slash-menu.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureSlashMenuVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openPage(page, appUrl, variant.target);
    await openSlashMenu(page, variant.target.blockId);
    await assertSlashMenuContract(page, variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-slash-menu.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} slash menu visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureDatabaseSourcePickerVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openPage(page, appUrl, variant.target);
    await openSlashMenu(page, variant.target.blockId);
    await openDatabaseSourcePicker(page, variant.target);
    await assertDatabaseSourcePickerContract(page, variant.target);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-picker-slash-menu.png`),
      fullPage: false,
    });
    await chooseExistingDatabaseSource(page, variant.target);
    await assertLinkedExistingDatabase(page, variant.target);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-linked-slash-menu.png`),
      fullPage: false,
    });
    await assertLinkedExistingDatabaseTitleNavigation(page, variant.target);
    assertNoBrowserErrors(errors, `${variant.prefix} database source picker flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureDatabaseSourceNewDatabaseVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openPage(page, appUrl, variant.target);
    await openSlashMenu(page, variant.target.blockId);
    await openDatabaseSourcePicker(page, variant.target);
    await assertDatabaseSourcePickerContract(page, variant.target);
    await chooseNewDatabaseSourceWithEnter(page, variant.target);
    await assertNewInlineDatabaseCreated(page);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-slash-menu.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} new database source flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureDatabaseSourceLowPlacementVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openPage(page, appUrl, variant.target);
    await positionBlockNearViewportBottom(page, variant.target.blockId, 210);
    await openSlashMenu(page, variant.target.blockId);
    await openDatabaseSourcePicker(page, variant.target);
    await assertDatabaseSourcePickerContract(page, variant.target);
    await assertDatabaseSourcePickerLowPlacement(page, variant.target);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-picker-slash-menu.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} database source picker low placement`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureTemplateEditorSlashMenuVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openTemplateEditor(page, appUrl, variant.target);
    await positionTemplateBlockNearViewportBottom(page, 112);
    await openTemplateSlashMenu(page);
    await assertTemplateEditorSlashMenuContract(page);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-template-editor-slash-menu.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} template editor slash menu`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openPage(page, baseUrl, target) {
  await page.goto(resolveUrl(baseUrl, `/p/${target.pageId}`), {
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
  await expectPageTitle(page, target.title);
}

async function openDatabasePage(page, baseUrl, target) {
  await page.goto(resolveUrl(baseUrl, `/p/${target.existingDatabaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, target.existingDatabaseTitle);
  await page.getByRole('toolbar', { name: 'Database toolbar' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openSlashMenu(page, blockId) {
  const textbox = blockTextBox(page, blockId);
  await textbox.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Block commands' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('option', { name: /^Text\b/ }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openTemplateEditor(page, appUrl, target) {
  await openDatabasePage(page, appUrl, target);
  await page.getByRole('button', { name: 'Choose database template' }).click({
    timeout: options.timeoutMs,
  });
  const templateMenu = page.getByRole('dialog', { name: 'New database page' });
  await templateMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await templateMenu.getByRole('button', { name: '편집' }).first().click({
    timeout: options.timeoutMs,
  });
  const editor = page.getByRole('dialog', { name: 'Edit database template' });
  await editor.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.getByRole('textbox', { name: 'Template page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function positionTemplateBlockNearViewportBottom(page, bottomGap) {
  await page.evaluate((desiredBottomGap) => {
    const editable = document.querySelector('[data-template-block-key="0"]');
    const scroll = document.querySelector('[class*="templateEditorScroll"]');
    if (!(editable instanceof HTMLElement) || !(scroll instanceof HTMLElement)) return;

    editable.scrollIntoView({ block: 'end', inline: 'nearest' });
    const targetBottom = window.innerHeight - desiredBottomGap;
    const delta = editable.getBoundingClientRect().bottom - targetBottom;
    if (Math.abs(delta) > 1) scroll.scrollTop += delta;
  }, bottomGap);
}

async function openTemplateSlashMenu(page) {
  const editable = page.locator('[data-template-block-key="0"]').first();
  await editable.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await editable.click({ timeout: options.timeoutMs });
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Template block commands' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('option', { name: /텍스트/ }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openDatabaseSourcePicker(page, target) {
  const menu = page.getByRole('listbox', { name: 'Block commands' });
  const option = menu.getByRole('option', { name: /^Database - Inline\b/ });
  await option.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  try {
    await option.click({ timeout: Math.min(options.timeoutMs, 5000) });
  } catch {
    await option.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  }
  const picker = page.getByRole('dialog', { name: 'Choose database source' });
  await picker.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await picker.getByRole('button', { name: /^New database\b/ }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await picker.getByRole('option', { name: new RegExp(escapeRegExp(target.existingDatabaseTitle)) }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function positionBlockNearViewportBottom(page, blockId, bottomGap) {
  await page.evaluate(
    ({ blockId, bottomGap }) => {
      const block = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      if (!(block instanceof HTMLElement)) return;
      block.scrollIntoView({ block: 'end', inline: 'nearest' });

      const collectScrollers = () => {
        const scrollers = [];
        let current = block.parentElement;
        while (current) {
          const style = window.getComputedStyle(current);
          if (
            /(auto|scroll)/.test(style.overflowY) &&
            current.scrollHeight > current.clientHeight
          ) {
            scrollers.push(current);
          }
          current = current.parentElement;
        }
        if (document.scrollingElement instanceof HTMLElement) {
          scrollers.push(document.scrollingElement);
        }
        return scrollers;
      };

      const targetBottom = window.innerHeight - bottomGap;
      const delta = block.getBoundingClientRect().bottom - targetBottom;
      if (Math.abs(delta) < 1) return;

      for (const scroller of collectScrollers()) {
        const before = scroller.scrollTop;
        scroller.scrollTop += delta;
        if (Math.abs(scroller.scrollTop - before) > 0.5) return;
      }
      window.scrollBy(0, delta);
    },
    { blockId, bottomGap },
  );
}

async function chooseExistingDatabaseSource(page, target) {
  const picker = page.getByRole('dialog', { name: 'Choose database source' });
  await picker.getByRole('option', { name: new RegExp(escapeRegExp(target.existingDatabaseTitle)) }).click({
    timeout: options.timeoutMs,
  });
}

async function chooseNewDatabaseSourceWithEnter(page, target) {
  const picker = page.getByRole('dialog', { name: 'Choose database source' });
  await picker.locator('[data-database-source-action="new"][data-active="true"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.evaluate((blockId) => {
    const editable = document.querySelector(
      `[data-block-id="${CSS.escape(blockId)}"] [data-database-source-picker-open="true"]`,
    );
    if (editable instanceof HTMLElement) editable.focus({ preventScroll: true });
  }, target.blockId);
  await page.keyboard.press('Enter');
}

async function assertSlashMenuContract(page, variant) {
  const metrics = await page.evaluate(() => {
    const menu = document.querySelector('[role="listbox"][aria-label="Block commands"]');
    const pageBody = document.querySelector('[role="region"][aria-label="Page body"]');
    if (!(menu instanceof HTMLElement) || !(pageBody instanceof HTMLElement)) {
      return { ok: false, reason: 'missing slash menu or page body' };
    }
    const rect = menu.getBoundingClientRect();
    const bodyRect = pageBody.getBoundingClientRect();
    const labels = Array.from(menu.querySelectorAll('[class*="slashLabel"]')).filter(
      (item) => item instanceof HTMLElement,
    );
    const options = Array.from(menu.querySelectorAll('[role="option"]')).filter(
      (item) => item instanceof HTMLElement,
    );
    const optionRects = options.map((option) => {
      const rect = option.getBoundingClientRect();
      const glyph = option.querySelector('[class*="slashGlyph"]');
      const name = option.querySelector('[class*="slashName"]');
      const desc = option.querySelector('[class*="slashDesc"]');
      const glyphRect = glyph instanceof HTMLElement ? glyph.getBoundingClientRect() : null;
      const nameRect = name instanceof HTMLElement ? name.getBoundingClientRect() : null;
      const descRect = desc instanceof HTMLElement ? desc.getBoundingClientRect() : null;
      return {
        bottom: rect.bottom,
        height: rect.height,
        glyphHeight: glyphRect?.height ?? 0,
        glyphHasSvg: glyph instanceof HTMLElement && !!glyph.querySelector('svg'),
        glyphText: glyph instanceof HTMLElement ? glyph.textContent?.trim() ?? '' : '',
        glyphWidth: glyphRect?.width ?? 0,
        label: name instanceof HTMLElement ? name.textContent?.trim() ?? '' : '',
        nameLeft: nameRect?.left ?? null,
        descLeft: descRect?.left ?? null,
        nameCenterY: nameRect ? nameRect.top + nameRect.height / 2 : null,
        descCenterY: descRect ? descRect.top + descRect.height / 2 : null,
        textOverflow: desc instanceof HTMLElement && desc.scrollWidth > desc.clientWidth + 2,
        top: rect.top,
      };
    });
    const contentBottom = rect.bottom - 2;
    const clippedBottomOptions = optionRects
      .filter((option) => option.top < contentBottom - 2 && option.bottom > contentBottom + 2)
      .map((option) => option.label);
    const active = menu.querySelector('[role="option"][data-active="true"]');
    return {
      ok: true,
      activeCount: active ? 1 : 0,
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      bodyWidth: bodyRect.width,
      bottomGap: window.innerHeight - rect.bottom,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      height: rect.height,
      labelCount: labels.length,
      left: rect.left,
      optionCount: options.length,
      clippedBottomOptions,
      optionMaxHeight: Math.max(...optionRects.map((item) => item.height), 0),
      optionMinHeight: Math.min(...optionRects.map((item) => item.height), 999),
      optionRects,
      rightGap: window.innerWidth - rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'slash menu visual contract could not run');
  assert(metrics.activeCount === 1, 'Slash menu should expose one active option.');
  assert(metrics.labelCount >= 2, `Slash menu should group commands, got ${metrics.labelCount} labels`);
  assert(metrics.optionCount >= 8, `Slash menu should expose core block commands, got ${metrics.optionCount}`);
  assert(metrics.clippedBottomOptions.length === 0, `Slash menu should not leave a partially clipped command row at the bottom: ${metrics.clippedBottomOptions.join(', ')}`);
  assert(metrics.optionMinHeight >= 48 && metrics.optionMaxHeight <= 58, `Slash menu rows should stay dense, got ${metrics.optionMinHeight}-${metrics.optionMaxHeight}px`);
  assert(metrics.bottomGap >= 8, `Slash menu should stay inside the viewport bottom, got gap=${Math.round(metrics.bottomGap)}px`);
  assert(metrics.top >= 8, `Slash menu should stay inside the viewport top, got top=${Math.round(metrics.top)}px`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `Slash menu should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);

  for (const row of metrics.optionRects.slice(0, 6)) {
    assert(row.glyphWidth >= 38 && row.glyphWidth <= 42, `Slash menu glyph width drifted: ${JSON.stringify(row)}`);
    assert(row.glyphHeight >= 38 && row.glyphHeight <= 42, `Slash menu glyph height drifted: ${JSON.stringify(row)}`);
    assert(row.glyphHasSvg && row.glyphText === '', `Slash menu core commands should use real block SVG icons, not text glyphs: ${JSON.stringify(row)}`);
    assert(row.nameLeft !== null && row.descLeft !== null && Math.abs(row.nameLeft - row.descLeft) <= 1, `Slash menu text column drifted: ${JSON.stringify(row)}`);
    assert(row.nameCenterY !== null && row.descCenterY !== null && row.descCenterY > row.nameCenterY, `Slash menu description should sit below the name: ${JSON.stringify(row)}`);
  }

  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `Mobile slash menu should run in a narrow viewport, got ${Math.round(metrics.viewportWidth)}px`);
    assert(metrics.width >= 300 && metrics.width <= 374, `Mobile slash menu should fit narrow viewports, got ${Math.round(metrics.width)}px`);
    assert(metrics.left >= 8 && metrics.rightGap >= 8, `Mobile slash menu should keep viewport gutters, got left=${Math.round(metrics.left)} right=${Math.round(metrics.rightGap)}`);
    assert(metrics.height >= 300 && metrics.height <= 410, `Mobile slash menu should remain scrollable but not oversized, got ${Math.round(metrics.height)}px`);
    return;
  }

  assert(metrics.width >= 316 && metrics.width <= 324, `Desktop slash menu should be 320px-class, got ${Math.round(metrics.width)}px`);
  assert(metrics.left >= metrics.bodyLeft - 4 && metrics.left <= metrics.bodyRight - 320, `Desktop slash menu should anchor inside the page body column: ${JSON.stringify(metrics)}`);
  assert(metrics.height >= 300 && metrics.height <= 410, `Desktop slash menu should remain compact, got ${Math.round(metrics.height)}px`);
}

async function assertDatabaseSourcePickerContract(page, target) {
  const metrics = await page.evaluate((expected) => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose database source"]');
    const pageBody = document.querySelector('[role="region"][aria-label="Page body"]');
    const slashMenu = document.querySelector('[role="listbox"][aria-label="Block commands"]');
    const activeBlock = document.querySelector(`[data-block-id="${expected.blockId}"]`);
    const editable = activeBlock?.querySelector('[role="textbox"][aria-label="Text block text"]');
    const gutter = activeBlock?.querySelector('[class*="gutter"]');
    if (!(dialog instanceof HTMLElement) || !(pageBody instanceof HTMLElement)) {
      return { ok: false, reason: 'missing database source dialog or page body' };
    }
    const rect = dialog.getBoundingClientRect();
    const bodyRect = pageBody.getBoundingClientRect();
    const editableRect = editable instanceof HTMLElement ? editable.getBoundingClientRect() : null;
    const editableBeforeContent =
      editable instanceof HTMLElement ? window.getComputedStyle(editable, '::before').content : '';
    const gutterStyle = gutter instanceof HTMLElement ? window.getComputedStyle(gutter) : null;
    const newAction = dialog.querySelector('[data-database-source-action="new"]');
    const existingActions = Array.from(dialog.querySelectorAll('[data-database-source-action="existing"]')).filter(
      (item) => item instanceof HTMLElement,
    );
    const newActionRect = newAction instanceof HTMLElement ? newAction.getBoundingClientRect() : null;
    const newActionHit =
      newAction instanceof HTMLElement && newActionRect
        ? document.elementFromPoint(
            newActionRect.left + newActionRect.width / 2,
            newActionRect.top + newActionRect.height / 2,
          )
        : null;
    const existingRows = existingActions.map((item) => ({
      description: item.querySelector('[class*="databaseSourcePath"]')?.textContent?.trim() ?? '',
      icon: item.querySelector('[data-database-source-icon]')?.getAttribute('data-database-source-icon') ?? '',
      kind: item.getAttribute('data-database-source-kind') ?? '',
    }));
    const search = dialog.querySelector('input[aria-label="Search existing databases"]');
    const activeAction = dialog.querySelector('[data-active="true"]')?.getAttribute('data-database-source-action') ?? null;
    const labels = Array.from(dialog.querySelectorAll('[class*="databaseSourceTitle"]')).map((item) =>
      item.textContent?.trim() ?? '',
    );
    const inlineDatabase = document.querySelector('[data-inline-database-wrapper]');
    return {
      ok: true,
      activeCount: dialog.querySelectorAll('[data-active="true"]').length,
      activeAction,
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      bottomGap: window.innerHeight - rect.bottom,
      editableBeforeContent,
      editableBottom: editableRect?.bottom ?? null,
      editablePickerOpen: editable instanceof HTMLElement && editable.getAttribute('data-database-source-picker-open') === 'true',
      existingRows,
      gutterOpacity: gutterStyle?.opacity ?? null,
      gutterPointerEvents: gutterStyle?.pointerEvents ?? null,
      hasExpectedExisting: labels.includes(expected.existingDatabaseTitle),
      hasInlineDatabaseBeforeChoice: !!inlineDatabase,
      hasNewAction: newAction instanceof HTMLElement,
      newActionHitTarget:
        newActionHit instanceof HTMLElement
          ? {
              aria: newActionHit.getAttribute('aria-label') ?? '',
              tag: newActionHit.tagName,
              text: newActionHit.textContent?.trim().slice(0, 80) ?? '',
            }
          : null,
      newActionReceivesPointer: newAction instanceof HTMLElement && !!newActionHit && newAction.contains(newActionHit),
      hasSearch: search instanceof HTMLInputElement,
      searchFocused: search instanceof HTMLInputElement && document.activeElement === search,
      hasSlashMenu: !!slashMenu,
      existingCount: existingActions.length,
      height: rect.height,
      left: rect.left,
      rightGap: window.innerWidth - rect.right,
      top: rect.top,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  }, target);

  assert(metrics.ok, metrics.reason ?? 'database source picker contract could not run');
  assert(!metrics.hasSlashMenu, `Database source picker should replace the slash menu, not stack over it: ${JSON.stringify(metrics)}`);
  assert(!metrics.hasInlineDatabaseBeforeChoice, `Picking Database - Inline should not create an inline database before a source is chosen: ${JSON.stringify(metrics)}`);
  assert(metrics.hasNewAction, `Database source picker should expose a New database action: ${JSON.stringify(metrics)}`);
  assert(
    metrics.activeCount === 1 && metrics.activeAction === 'new',
    `Database source picker should make New database the active default keyboard choice: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.newActionReceivesPointer,
    `New database should be the pointer hit target, not an editor line behind the picker: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.hasSearch, `Database source picker should expose existing database search: ${JSON.stringify(metrics)}`);
  assert(metrics.existingCount >= 1 && metrics.hasExpectedExisting, `Database source picker should list existing databases: ${JSON.stringify(metrics)}`);
  assert(metrics.editablePickerOpen, `Database source picker should mark the active empty block while open: ${JSON.stringify(metrics)}`);
  assert(
    metrics.editableBeforeContent === 'none' || metrics.editableBeforeContent === '""',
    `Database source picker should suppress the active block placeholder behind the menu: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.editableBottom === null || metrics.top >= metrics.editableBottom - 2,
    `Database source picker should open below the active text line instead of overlapping it: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.gutterOpacity === null || Number(metrics.gutterOpacity) === 0,
    `Database source picker should hide active block gutter controls while open: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.gutterPointerEvents === null || metrics.gutterPointerEvents === 'none',
    `Hidden active block gutter controls should not intercept database source picker clicks: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.existingRows.every((row) => row.kind === 'database' && row.icon === 'database'),
    `Existing database source rows should be visually marked as databases only: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.existingRows.every((row) => row.description === 'Database' || row.description === 'Imported database'),
    `Existing database source rows should not display page paths such as Private or parent breadcrumbs: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.activeCount === 1, `Database source picker should expose one active option: ${JSON.stringify(metrics)}`);
  assert(metrics.width >= 340 && metrics.width <= 370, `Database source picker width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.left >= metrics.bodyLeft - 4 && metrics.left <= metrics.bodyRight - metrics.width, `Database source picker should anchor inside the page body column: ${JSON.stringify(metrics)}`);
  assert(metrics.top >= 8 && metrics.bottomGap >= 8, `Database source picker should stay within the viewport: ${JSON.stringify(metrics)}`);
  assert(metrics.rightGap >= 8, `Database source picker should keep a right viewport gutter: ${JSON.stringify(metrics)}`);
}

async function assertDatabaseSourcePickerLowPlacement(page, target) {
  const metrics = await page.evaluate((expected) => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose database source"]');
    const activeBlock = document.querySelector(`[data-block-id="${expected.blockId}"]`);
    const editable = activeBlock?.querySelector('[role="textbox"][aria-label="Text block text"]');
    if (!(dialog instanceof HTMLElement) || !(editable instanceof HTMLElement)) {
      return { ok: false, reason: 'missing database source dialog or active editable' };
    }
    const dialogRect = dialog.getBoundingClientRect();
    const editableRect = editable.getBoundingClientRect();
    return {
      ok: true,
      dialogHeight: dialogRect.height,
      editableBottom: editableRect.bottom,
      editableTop: editableRect.top,
      gap: dialogRect.top - editableRect.bottom,
      top: dialogRect.top,
      viewportBottomGap: window.innerHeight - dialogRect.bottom,
    };
  }, target);

  assert(metrics.ok, metrics.reason ?? 'low database source picker placement could not run');
  assert(
    metrics.editableTop > 380,
    `Low-placement regression should exercise a lower viewport line: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.gap >= -2 && metrics.gap <= 32,
    `Database source picker should stay attached below the active low line instead of flipping far above it: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.dialogHeight < 430 && metrics.dialogHeight >= 96,
    `Low database source picker should shrink to the available below-line space: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.viewportBottomGap >= 8,
    `Low database source picker should still keep a viewport bottom gutter: ${JSON.stringify(metrics)}`,
  );
}

async function assertTemplateEditorSlashMenuContract(page) {
  const metrics = await page.evaluate(() => {
    const menu = document.querySelector('[data-template-slash-menu="true"]');
    const dialog = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
    const scroll = document.querySelector('[class*="templateEditorScroll"]');
    const editable = document.querySelector('[data-template-block-key="0"]');
    const row = editable?.closest('[data-template-block-row="true"]');
    const addHandle = row?.querySelector('[data-template-add-handle="true"]');
    const dragHandle = row?.querySelector('[data-template-drag-handle="true"]');
    if (
      !(menu instanceof HTMLElement) ||
      !(dialog instanceof HTMLElement) ||
      !(scroll instanceof HTMLElement) ||
      !(editable instanceof HTMLElement) ||
      !(row instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'missing template editor, row, or slash menu' };
    }

    const rect = menu.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const editableRect = editable.getBoundingClientRect();
    const optionRows = Array.from(menu.querySelectorAll('[role="option"]')).filter(
      (item) => item instanceof HTMLElement,
    );
    const optionRects = optionRows.map((option) => {
      const optionRect = option.getBoundingClientRect();
      const icon = option.querySelector('[data-template-block-command-icon]');
      return {
        bottom: optionRect.bottom,
        height: optionRect.height,
        iconHasSvg: icon instanceof HTMLElement && !!icon.querySelector('svg'),
        iconText: icon instanceof HTMLElement ? icon.textContent?.trim() ?? '' : '',
        label: option.textContent?.trim() ?? '',
        top: optionRect.top,
      };
    });
    const activeOptions = optionRows.filter((option) => option.getAttribute('data-active') === 'true');
    const contentBottom = rect.bottom - 2;
    const clippedBottomOptions = optionRects
      .filter((option) => option.top < contentBottom - 2 && option.bottom > contentBottom + 2)
      .map((option) => option.label);
    const handleMetrics = (handle) => {
      if (!(handle instanceof HTMLElement)) return null;
      const handleRect = handle.getBoundingClientRect();
      const style = window.getComputedStyle(handle);
      return {
        hasSvg: !!handle.querySelector('svg'),
        height: handleRect.height,
        opacity: Number.parseFloat(style.opacity || '1'),
        pointerEvents: style.pointerEvents,
        text: handle.textContent?.trim() ?? '',
        width: handleRect.width,
      };
    };

    return {
      ok: true,
      activeCount: activeOptions.length,
      addHandle: handleMetrics(addHandle),
      bottomGap: window.innerHeight - rect.bottom,
      clippedBottomOptions,
      dialogBottom: dialogRect.bottom,
      dialogTop: dialogRect.top,
      dragHandle: handleMetrics(dragHandle),
      editableBottom: editableRect.bottom,
      editableTop: editableRect.top,
      height: rect.height,
      optionCount: optionRows.length,
      optionMaxHeight: Math.max(...optionRects.map((item) => item.height), 0),
      optionMinHeight: Math.min(...optionRects.map((item) => item.height), 999),
      optionRects,
      placementGap: editableRect.top - rect.bottom,
      scrollBottom: scrollRect.bottom,
      scrollTop: scrollRect.top,
      top: rect.top,
      viewportHeight: window.innerHeight,
      width: rect.width,
    };
  });

  assert(metrics.ok, metrics.reason ?? 'template editor slash menu contract could not run');
  assert(metrics.activeCount === 1, `Template slash menu should expose one active option: ${JSON.stringify(metrics)}`);
  assert(metrics.optionCount >= 8, `Template slash menu should expose core block commands: ${JSON.stringify(metrics)}`);
  assert(
    metrics.optionMinHeight >= 30 && metrics.optionMaxHeight <= 38,
    `Template slash menu rows should stay dense and stable: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.optionRects.slice(0, 6).every((row) => row.iconHasSvg && row.iconText === ''),
    `Template slash menu core rows should use real block SVG icons, not text glyphs: ${JSON.stringify(metrics.optionRects.slice(0, 6))}`,
  );
  assert(
    metrics.clippedBottomOptions.length === 0,
    `Template slash menu should not leave a partially clipped command row at the bottom: ${metrics.clippedBottomOptions.join(', ')} ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.top >= metrics.scrollTop + 4 && metrics.bottomGap >= 8 && metrics.scrollBottom - (metrics.viewportHeight - metrics.bottomGap) >= -4,
    `Template slash menu should stay inside the visible editor scroller and viewport: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.scrollBottom - metrics.editableBottom <= 112 && metrics.placementGap >= -4 && metrics.placementGap <= 16,
    `Template slash menu should flex above a low-in-editor template block instead of clipping below it: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.addHandle?.hasSvg &&
      metrics.addHandle.text === '' &&
      metrics.addHandle.opacity >= 0.85 &&
      metrics.addHandle.pointerEvents !== 'none' &&
      metrics.dragHandle?.hasSvg &&
      metrics.dragHandle.text === '' &&
      metrics.dragHandle.opacity >= 0.85 &&
      metrics.dragHandle.pointerEvents !== 'none',
    `Template block gutter should use normal plus/drag SVG controls while the block is focused: ${JSON.stringify(metrics)}`,
  );
}

async function assertNewInlineDatabaseCreated(page) {
  await page.locator('[data-inline-database-wrapper]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.locator('[data-inline-database-wrapper] [data-table-head]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const metrics = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-inline-database-wrapper]');
    const title = document.querySelector('[data-inline-database-title]');
    const tableHead = document.querySelector('[data-inline-database-wrapper] [data-table-head]');
    const loadingShell = document.querySelector('[data-inline-database-wrapper] [aria-busy="true"]');
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose database source"]');
    const block = wrapper?.closest('[data-block-id]');
    const blockRow = block?.querySelector('[class*="blockRow"]');
    const viewTabs = wrapper?.querySelector('[data-view-tabs-hidden="true"]');
    const openAction = wrapper?.querySelector('[data-inline-database-open-action="true"]');
    const visibleTabs = Array.from(wrapper?.querySelectorAll('[role="tab"]') ?? []).filter((tab) => {
      if (!(tab instanceof HTMLElement)) return false;
      const rect = tab.getBoundingClientRect();
      const style = getComputedStyle(tab);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const titleText =
      title instanceof HTMLInputElement
        ? title.value
        : title instanceof HTMLElement
          ? title.textContent?.trim() ?? ''
          : '';
    return {
      dialogStillOpen: !!dialog,
      loadingStillVisible: !!loadingShell,
      tableHeadVisible: tableHead instanceof HTMLElement,
      titleActive: title instanceof HTMLElement && document.activeElement === title,
      titleSelectionEnd: title instanceof HTMLInputElement ? title.selectionEnd : null,
      titleSelectionStart: title instanceof HTMLInputElement ? title.selectionStart : null,
      titleIsInput: title instanceof HTMLInputElement,
      titlePlaceholder: title instanceof HTMLInputElement ? title.placeholder : null,
      titleText,
      blockSelected: blockRow instanceof HTMLElement && blockRow.getAttribute('data-selected') === 'true',
      selectedBlockRows: document.querySelectorAll('[class*="blockRow"][data-selected="true"]').length,
      viewTabsHidden: viewTabs instanceof HTMLElement,
      hasLinkedOpenAction: openAction instanceof HTMLElement,
      linkedSource: wrapper instanceof HTMLElement && wrapper.getAttribute('data-inline-database-linked-source') === 'true',
      visibleTabCount: visibleTabs.length,
      wrapperVisible: wrapper instanceof HTMLElement,
    };
  });
  assert(metrics.wrapperVisible, `New database choice should render an inline database wrapper: ${JSON.stringify(metrics)}`);
  assert(!metrics.dialogStillOpen, `Database source picker should close after choosing New database: ${JSON.stringify(metrics)}`);
  assert(metrics.tableHeadVisible && !metrics.loadingStillVisible, `New database choice should settle into final database chrome: ${JSON.stringify(metrics)}`);
  assert(metrics.titleIsInput, `New database choice should immediately open the inline database title field for naming: ${JSON.stringify(metrics)}`);
  assert(metrics.titleActive, `New database inline title field should receive focus immediately: ${JSON.stringify(metrics)}`);
  assert(
    metrics.titleText === '' && metrics.titlePlaceholder === '새 데이터베이스',
    `New database title input should be empty with the Korean placeholder ready to type: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.titleSelectionStart === metrics.titleSelectionEnd,
    `New database title field should show a caret, not a selected title range: ${JSON.stringify(metrics)}`,
  );
  assert(
    !metrics.blockSelected && metrics.selectedBlockRows === 0,
    `New database should leave the caret in the title instead of selecting the whole database block: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.viewTabsHidden && metrics.visibleTabCount === 0,
    `New single-view inline database should hide the redundant view tab row: ${JSON.stringify(metrics)}`,
  );
  assert(
    !metrics.linkedSource && !metrics.hasLinkedOpenAction,
    `New inline databases created in the page should stay locally editable without a linked-source title arrow: ${JSON.stringify(metrics)}`,
  );
}

async function assertLinkedExistingDatabase(page, target) {
  await page.locator('[data-inline-database-wrapper]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.locator('[data-inline-database-wrapper] [data-table-head]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const metrics = await page.evaluate((expectedTitle) => {
    const wrapper = document.querySelector('[data-inline-database-wrapper]');
    const title = document.querySelector('[data-inline-database-title]');
    const tableHead = document.querySelector('[data-inline-database-wrapper] [data-table-head]');
    const loadingShell = document.querySelector('[data-inline-database-wrapper] [aria-busy="true"]');
    const pageBody = document.querySelector('[role="region"][aria-label="Page body"]');
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose database source"]');
    const block = wrapper?.closest('[data-block-id]');
    const blockRow = block?.querySelector('[class*="blockRow"]');
    const openAction = wrapper?.querySelector('[data-inline-database-open-action="true"]');
    const openActionStyle = openAction instanceof HTMLElement ? getComputedStyle(openAction) : null;
    const titleRect = title instanceof HTMLElement ? title.getBoundingClientRect() : null;
    const openRect = openAction instanceof HTMLElement ? openAction.getBoundingClientRect() : null;
    return {
      bodyText: pageBody instanceof HTMLElement ? pageBody.innerText : '',
      blockSelected: blockRow instanceof HTMLElement && blockRow.getAttribute('data-selected') === 'true',
      dialogStillOpen: !!dialog,
      linkedSource: wrapper instanceof HTMLElement && wrapper.getAttribute('data-inline-database-linked-source') === 'true',
      loadingStillVisible: !!loadingShell,
      openActionLabel: openAction instanceof HTMLElement ? openAction.getAttribute('aria-label') ?? '' : '',
      openActionOpacity: openActionStyle ? Number.parseFloat(openActionStyle.opacity || '1') : null,
      openActionPlacement: openAction instanceof HTMLElement ? openAction.getAttribute('data-inline-database-open-placement') ?? '' : '',
      openActionPointerEvents: openActionStyle?.pointerEvents ?? null,
      openActionVisible: openRect ? openRect.width >= 18 && openRect.height >= 18 : false,
      openBeforeTitle: openRect && titleRect ? openRect.right <= titleRect.left + 2 : false,
      selectedBlockRows: document.querySelectorAll('[class*="blockRow"][data-selected="true"]').length,
      tableHeadVisible: tableHead instanceof HTMLElement,
      titleClickable: title instanceof HTMLElement ? title.getAttribute('data-inline-database-clickable') ?? '' : '',
      titleEditable: title instanceof HTMLElement ? title.getAttribute('data-inline-database-editable-title') ?? '' : '',
      titleRole: title instanceof HTMLElement ? title.getAttribute('role') ?? '' : '',
      titleText: title instanceof HTMLElement ? title.textContent?.trim() ?? '' : '',
      wrapperVisible: wrapper instanceof HTMLElement,
      expectedTitle,
    };
  }, target.existingDatabaseTitle);
  assert(metrics.wrapperVisible, `Existing database choice should render an inline database wrapper: ${JSON.stringify(metrics)}`);
  assert(!metrics.dialogStillOpen, `Database source picker should close after choosing an existing database: ${JSON.stringify(metrics)}`);
  assert(metrics.tableHeadVisible && !metrics.loadingStillVisible, `Existing database choice should settle into final database chrome: ${JSON.stringify(metrics)}`);
  assert(
    metrics.titleText === target.existingDatabaseTitle || metrics.bodyText.includes(target.existingDatabaseTitle),
    `Existing database choice should link the chosen database title: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.linkedSource &&
      metrics.titleClickable === 'true' &&
      metrics.titleEditable !== 'true' &&
      metrics.titleRole === 'link' &&
      metrics.openActionVisible &&
      metrics.openActionPlacement === 'leading' &&
      metrics.openActionOpacity >= 0.85 &&
      metrics.openActionPointerEvents !== 'none' &&
      metrics.openBeforeTitle &&
      metrics.openActionLabel.includes(target.existingDatabaseTitle),
    `Existing database choice should render as a linked-source inline database with leading arrow and clickable title: ${JSON.stringify(metrics)}`,
  );
  assert(
    !metrics.blockSelected && metrics.selectedBlockRows === 0,
    `Existing database choice should not leave the whole inline database block selected: ${JSON.stringify(metrics)}`,
  );
}

async function assertLinkedExistingDatabaseTitleNavigation(page, target) {
  const title = page.locator('[data-inline-database-wrapper] [data-inline-database-title]').first();
  await title.click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (databaseId) => location.pathname === `/p/${databaseId}`,
    target.existingDatabaseId,
    { timeout: options.timeoutMs },
  );
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

function blockTextBox(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`).getByRole('textbox', { name: 'Text block text' });
}

async function seedSlashMenuPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for slash menu visual smoke');

  const suffix = Date.now();
  const targets = {};
  const variants = ['desktop', 'desktopDark', 'mobile', 'mobileDark', 'desktopLow'];
  for (const [index, key] of variants.entries()) {
    const pageId = randomUUID();
    const blockId = randomUUID();
    const existingDatabaseId = randomUUID();
    const templateId = randomUUID();
    const title = `Slash menu ${String(suffix).slice(-6)} ${index + 1}`;
    const existingDatabaseTitle = `Existing source ${String(suffix).slice(-6)} ${index + 1}`;
    const templateTitle = `Template commands ${String(suffix).slice(-6)} ${index + 1}`;

    const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
      action: 'create',
      id: pageId,
      workspaceId,
      parentId: null,
      parentType: 'workspace',
      kind: 'page',
      title,
      icon: '⌘',
      iconType: 'emoji',
      cover: '',
      coverPosition: 50,
      position: suffix + index,
    });
    assert(created?.page?.id === pageId, 'slash menu visual smoke page must be created');

    const trailingBlockIds = Array.from({ length: 13 }, () => randomUUID());
    const lowBlockId = trailingBlockIds[5];
    const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
      action: 'createMany',
      blocks: [
        {
          id: blockId,
          pageId,
          parentId: null,
          type: 'paragraph',
          content: { rich: [] },
          plainText: '',
          position: 1,
        },
        ...trailingBlockIds.map((id, trailingIndex) => ({
          id,
          pageId,
          parentId: null,
          type: 'paragraph',
          content: { rich: [] },
          plainText: '',
          position: trailingIndex + 2,
        })),
      ],
    });
    assert(createdBlocks?.blocks?.length === 14, 'slash menu visual smoke blocks must be created');
    const createdDatabase = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
      action: 'createDatabase',
      id: existingDatabaseId,
      workspaceId,
      parentId: null,
      parentType: 'workspace',
      title: existingDatabaseTitle,
      viewType: 'table',
      properties: [
        { id: randomUUID(), name: 'Name', type: 'title', position: 1 },
      ],
    });
    assert(createdDatabase?.page?.id === existingDatabaseId, 'slash menu visual smoke existing database must be created');
    await callFunction(baseUrl, session.accessToken, 'database-mutation', {
      action: 'insertMany',
      table: 'db_templates',
      records: [
        {
          id: templateId,
          databaseId: existingDatabaseId,
          name: templateTitle,
          icon: '',
          title: '',
          properties: {},
          blocks: [
            {
              type: 'paragraph',
              content: { rich: [] },
            },
          ],
          isDefault: false,
          position: 1,
        },
      ],
    });
    targets[key] = { blockId, existingDatabaseId, existingDatabaseTitle, lowBlockId, pageId, templateId, templateTitle, title };
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    targets,
    workspaceId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.targets) return;
  for (const target of Object.values(seed.targets)) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id: target.pageId,
    }).catch(() => {});
    if (target.existingDatabaseId) {
      await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
        action: 'delete',
        id: target.existingDatabaseId,
      }).catch(() => {});
    }
  }
}

async function seedSession(context, seed, theme = 'light') {
  await context.addInitScript(({ refreshToken, workspaceId, theme }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', theme);
  }, {
    refreshToken: seed.refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
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
    'Playwright is required for slash menu visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
  console.log(`Usage: node scripts/slash-menu-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
