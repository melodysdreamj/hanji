#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBrowserSession, installBrowserSession, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'basic-blocks');

const SAMPLE_IMAGE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1NjAiIGhlaWdodD0iMjgwIiB2aWV3Qm94PSIwIDAgNTYwIDI4MCI+PHJlY3Qgd2lkdGg9IjU2MCIgaGVpZ2h0PSIyODAiIGZpbGw9IiNmN2Y2ZjMiLz48cmVjdCB4PSIzNCIgeT0iMzQiIHdpZHRoPSI0OTIiIGhlaWdodD0iMjEyIiByeD0iMTYiIGZpbGw9IiNmZmYiIHN0cm9rZT0iI2Q4ZDZkMSIvPjxjaXJjbGUgY3g9IjE0MCIgY3k9IjEyMCIgcj0iMzgiIGZpbGw9IiM0NDhiZjQiLz48cGF0aCBkPSJNODAgMjEwIDE5MiAxNDJsNzAgNTUgNjYtODUgMTUyIDk4eiIgZmlsbD0iIzI3YWU2MCIgb3BhY2l0eT0iLjg1Ii8+PHRleHQgeD0iMjgwIiB5PSI2NiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjI0IiBmaWxsPSIjMzczNTJmIj5JbmtsaW5lIGJhc2ljIGJsb2NrczwvdGV4dD48L3N2Zz4=';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL basic blocks visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Basic blocks visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Basic blocks visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedBasicBlocksPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureVariant(browser, appUrl, seed, {
      name: 'desktop-basic-blocks',
      theme: 'light',
      viewport: { width: 1440, height: 1200 },
    });
    await captureUsage(browser, appUrl, seed);
    await captureVariant(browser, appUrl, seed, {
      name: 'desktop-dark-basic-blocks',
      theme: 'dark',
      viewport: { width: 1440, height: 1200 },
    });
    await captureVariant(browser, appUrl, seed, {
      mobile: true,
      name: 'mobile-basic-blocks',
      theme: 'light',
      viewport: { width: 390, height: 920 },
    });
    await captureVariant(browser, appUrl, seed, {
      mobile: true,
      name: 'mobile-dark-basic-blocks',
      theme: 'dark',
      viewport: { width: 390, height: 920 },
    });

    console.log('PASS basic block visuals and core interactions stay within the Notion-style layout contract.');
    for (const file of [
      'desktop-basic-blocks.png',
      'desktop-basic-blocks-usage.png',
      'desktop-dark-basic-blocks.png',
      'mobile-basic-blocks.png',
      'mobile-dark-basic-blocks.png',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, file)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme);

  try {
    await openPage(page, appUrl, seed, errors);
    await setTheme(page, variant.theme);
    await clearTransientState(page);
    await assertBasicBlocksVisualContract(page, seed, variant);
    await writeSurfaceInventory(page, seed, `${variant.name}-inventory.json`, variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.name}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.name} basic blocks visual flow`);
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function captureUsage(browser, appUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1200 },
  });
  await seedSession(context, seed, 'light');

  try {
    await openPage(page, appUrl, seed, errors);
    await setTheme(page, 'light');

    await blockGroup(page, seed.blockIds.todo).getByRole('checkbox', { name: 'Mark to-do as complete' }).click({
      timeout: options.timeoutMs,
    });
    await page.waitForFunction(
      (blockId) => {
        const box = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"] input[type="checkbox"]`);
        return box instanceof HTMLInputElement && box.checked;
      },
      seed.blockIds.todo,
      { timeout: options.timeoutMs },
    );

    await blockGroup(page, seed.blockIds.toggle).getByRole('button', { name: 'Close toggle' }).click({
      timeout: options.timeoutMs,
    });
    await page.waitForFunction(
      (blockId) => {
        const child = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
        return child === null || child.getClientRects().length === 0;
      },
      seed.blockIds.toggleChild,
      { timeout: options.timeoutMs },
    );
    await blockGroup(page, seed.blockIds.toggle).getByRole('button', { name: 'Open toggle' }).click({
      timeout: options.timeoutMs,
    });
    await blockGroup(page, seed.blockIds.toggleChild).waitFor({ state: 'visible', timeout: options.timeoutMs });

    await hoverBlock(page, seed.blockIds.code);
    await assertHoverControls(page, seed, 'code');
    await hoverBlock(page, seed.blockIds.simpleTable);
    await assertHoverControls(page, seed, 'simpleTable');
    await hoverBlock(page, seed.blockIds.bookmark);
    await assertHoverControls(page, seed, 'bookmark');
    await hoverBlock(page, seed.blockIds.image);
    await assertHoverControls(page, seed, 'image');
    await hoverBlock(page, seed.blockIds.file);
    await assertHoverControls(page, seed, 'file');
    await hoverBlock(page, seed.blockIds.equation);
    await assertHoverControls(page, seed, 'equation');

    await writeSurfaceInventory(page, seed, 'desktop-basic-blocks-usage-inventory.json', {
      state: 'usage',
      theme: 'light',
      viewport: { width: 1440, height: 1200 },
    });
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-basic-blocks-usage.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'desktop basic blocks usage flow');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function openPage(page, baseUrl, seed, errors = []) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  try {
    await page.locator(pageTitleSelector()).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  } catch (error) {
    await captureOpenFailure(page, seed, errors);
    throw error;
  }
  try {
    await page.getByRole('region', { name: 'Page body' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  } catch (error) {
    await captureOpenFailure(page, seed, errors);
    throw error;
  }
  await expectPageTitle(page, seed.title);
  for (const id of Object.values(seed.blockIds)) {
    try {
      await blockGroup(page, id).waitFor({ state: 'visible', timeout: options.timeoutMs });
    } catch (error) {
      await captureOpenFailure(page, seed, errors);
      throw error;
    }
  }
}

async function captureOpenFailure(page, seed, errors = []) {
  const suffix = String(seed?.pageId ?? 'unknown').slice(0, 8);
  await page.screenshot({
    path: join(options.screenshotDir, `open-failure-${suffix}.png`),
    fullPage: false,
  }).catch(() => {});
  const snapshot = await page.locator('body').textContent({ timeout: 1000 }).catch(() => '');
  writeFileSync(
    join(options.screenshotDir, `open-failure-${suffix}.txt`),
    [
      `url=${page.url()}`,
      `title=${await page.title().catch(() => '')}`,
      `errors=${JSON.stringify(errors, null, 2)}`,
      '',
      snapshot?.slice(0, 4000) ?? '',
    ].join('\n'),
  );
}

async function assertBasicBlocksVisualContract(page, seed, variant) {
  const metrics = await page.evaluate(collectBasicBlockMetrics, {
    blockIds: seed.blockIds,
    requiredTypes: seed.requiredTypes,
    title: seed.title,
  });

  assert(metrics.ok, metrics.reason ?? 'basic block visual contract could not run');
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `basic blocks should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.titleText === seed.title, `basic block page title should render seeded title, got "${metrics.titleText}"`);
  assert(metrics.visibleGutterCount === 0, `idle screenshots should not leak transient block gutters: ${JSON.stringify(metrics)}`);

  for (const [key, expectedType] of Object.entries(seed.requiredTypes)) {
    const block = metrics.blocks[key];
    assert(block?.ok, `${key} block should be present: ${JSON.stringify(block)}`);
    assert(block.type === expectedType, `${key} should render as ${expectedType}, got ${block.type}`);
    assert(block.groupRight <= metrics.bodyRight + 4, `${key} should stay inside the document body: ${JSON.stringify(block)}`);
    assert(block.rowHeight >= 8 && block.rowHeight <= 520, `${key} row height drifted: ${JSON.stringify(block)}`);
    if (block.editable) {
      assert(block.editableRight <= block.rowRight + 1, `${key} editable text should stay inside its row: ${JSON.stringify(block)}`);
    }
  }

  for (const key of ['paragraph', 'bullet', 'number', 'todo', 'todoChecked', 'toggle', 'toggleHeading', 'quote']) {
    const block = metrics.blocks[key];
    assert(block.editable, `${key} should expose editable text bounds: ${JSON.stringify(block)}`);
    assert(block.editableHeight >= 18 && block.editableHeight <= 70, `${key} text density drifted: ${JSON.stringify(block)}`);
  }

  assertFontRange(metrics.blocks.heading1, 28, 38, 'heading 1');
  assertFontRange(metrics.blocks.heading2, 22, 30, 'heading 2');
  assertFontRange(metrics.blocks.heading3, 18, 25, 'heading 3');
  assertFontRange(metrics.blocks.heading4, 15, 20, 'heading 4');
  assertFontRange(metrics.blocks.paragraph, 15, 17.5, 'paragraph');

  assert(metrics.blocks.bullet.markerWidth >= 18 && metrics.blocks.bullet.markerWidth <= 30, `bullet marker should stay compact: ${JSON.stringify(metrics.blocks.bullet)}`);
  assert(metrics.blocks.number.markerWidth >= 18 && metrics.blocks.number.markerWidth <= 32, `number marker should stay compact: ${JSON.stringify(metrics.blocks.number)}`);
  assert(metrics.blocks.todo.checkboxWidth >= 14 && metrics.blocks.todo.checkboxWidth <= 20, `to-do checkbox should stay compact: ${JSON.stringify(metrics.blocks.todo)}`);
  assert(metrics.blocks.todoChecked.checkboxChecked === true, `checked to-do should render checked: ${JSON.stringify(metrics.blocks.todoChecked)}`);
  assert(metrics.blocks.toggle.caretWidth >= 22 && metrics.blocks.toggle.caretWidth <= 28, `toggle caret hitbox should stay Hanji: ${JSON.stringify(metrics.blocks.toggle)}`);
  assert(metrics.blocks.toggle.caretIconSource === 'phosphor', `toggle caret should use the icon wrapper: ${JSON.stringify(metrics.blocks.toggle)}`);
  assert(metrics.blocks.toggleChild.groupLeft - metrics.blocks.toggle.groupLeft >= 20, `toggle child should indent under parent: ${JSON.stringify(metrics.blocks.toggleChild)}`);
  assert(metrics.blocks.quote.specialLeft >= metrics.blocks.quote.rowLeft - 1, `quote rail should align with row: ${JSON.stringify(metrics.blocks.quote)}`);
  assert(metrics.blocks.callout.specialWidth >= 480 || variant.mobile, `callout should fill the document column on desktop: ${JSON.stringify(metrics.blocks.callout)}`);
  assert(metrics.blocks.divider.specialHeight <= 20, `divider should remain a thin separator: ${JSON.stringify(metrics.blocks.divider)}`);
  assert(metrics.blocks.code.specialHeight >= 82, `code block should keep room for code and toolbar: ${JSON.stringify(metrics.blocks.code)}`);
  assert(metrics.blocks.equation.specialHeight >= 48, `equation preview should keep readable math height: ${JSON.stringify(metrics.blocks.equation)}`);
  assert(metrics.blocks.simpleTable.specialWidth >= 430 || variant.mobile, `simple table should expose a readable grid: ${JSON.stringify(metrics.blocks.simpleTable)}`);
  assert(metrics.blocks.toc.specialHeight >= 60, `table of contents should show seeded headings: ${JSON.stringify(metrics.blocks.toc)}`);
  assert(metrics.blocks.bookmark.specialHeight >= 90, `bookmark should render as a card: ${JSON.stringify(metrics.blocks.bookmark)}`);
  assert(metrics.blocks.image.specialHeight >= 140, `image should render visible media: ${JSON.stringify(metrics.blocks.image)}`);
  assert(metrics.blocks.videoEmpty.specialHeight >= 88, `empty video block should render an input card: ${JSON.stringify(metrics.blocks.videoEmpty)}`);
  assert(metrics.blocks.audioEmpty.specialHeight >= 88, `empty audio block should render an input card: ${JSON.stringify(metrics.blocks.audioEmpty)}`);
  assert(metrics.blocks.embedEmpty.specialHeight >= 82, `empty embed block should render an input card: ${JSON.stringify(metrics.blocks.embedEmpty)}`);
  assert(metrics.blocks.file.specialHeight >= 54, `file block should render a compact file card: ${JSON.stringify(metrics.blocks.file)}`);

  if (variant.mobile) {
    assert(metrics.bodyLeft >= 20 && metrics.bodyRight <= metrics.viewportWidth - 18, `mobile body should fit the viewport gutter: ${JSON.stringify(metrics)}`);
    for (const [key, block] of Object.entries(metrics.blocks)) {
      assert(block.rowLeft >= -2 && block.rowRight <= metrics.viewportWidth + 2, `${key} row should stay inside mobile viewport: ${JSON.stringify(block)}`);
      assert(block.groupRight <= metrics.viewportWidth + 2, `${key} group should stay inside mobile viewport: ${JSON.stringify(block)}`);
    }
  } else {
    assert(metrics.bodyWidth >= 560 && metrics.bodyWidth <= 780, `desktop body should stay in the Notion document column: ${JSON.stringify(metrics)}`);
  }
}

async function assertHoverControls(page, seed, key) {
  const metrics = await page.evaluate(({ blockId, key }) => {
    const group = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (!(group instanceof HTMLElement)) return { ok: false, reason: 'missing block group' };
    const visible = (selector) => {
      const nodes = Array.from(group.querySelectorAll(selector));
      return nodes.filter((node) => {
        if (!(node instanceof HTMLElement || node instanceof SVGElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && Number.parseFloat(style.opacity || '1') > 0.2;
      }).length;
    };
    return {
      ok: true,
      addColumn: visible('[aria-label="Add column to simple table"]'),
      addRow: visible('[aria-label="Add row to simple table"]'),
      bookmarkActions: visible('[aria-label="Open bookmark in a new tab"], [aria-label="Copy bookmark link"], [aria-label="Replace bookmark link"]'),
      codeControls: visible('[aria-label="Code language"], [aria-label="Copy code"], [aria-label="Toggle line numbers"], [aria-label="Toggle word wrap"]'),
      equationInput: visible('[data-equation-input]'),
      fileActions: visible('[aria-label^="Open "], [aria-label^="Download "], [aria-label^="Replace "]'),
      imageActions: visible('[aria-label="Align image left"], [aria-label="Align image center"], [aria-label="Align image right"], [aria-label="Replace image"]'),
      key,
    };
  }, {
    blockId: seed.blockIds[key],
    key,
  });
  assert(metrics.ok, `${key} hover metrics should run: ${JSON.stringify(metrics)}`);
  if (key === 'code') assert(metrics.codeControls >= 4, `code hover controls should appear: ${JSON.stringify(metrics)}`);
  if (key === 'simpleTable') assert(metrics.addColumn >= 1 && metrics.addRow >= 1, `simple table hover controls should appear: ${JSON.stringify(metrics)}`);
  if (key === 'bookmark') assert(metrics.bookmarkActions >= 2, `bookmark hover controls should appear: ${JSON.stringify(metrics)}`);
  if (key === 'image') assert(metrics.imageActions >= 3, `image hover controls should appear: ${JSON.stringify(metrics)}`);
  if (key === 'file') assert(metrics.fileActions >= 2, `file hover controls should appear: ${JSON.stringify(metrics)}`);
  if (key === 'equation') assert(metrics.equationInput >= 1, `equation hover input should appear: ${JSON.stringify(metrics)}`);
}

function assertFontRange(block, min, max, label) {
  assert(block.editableFontSize >= min && block.editableFontSize <= max, `${label} font size drifted: ${JSON.stringify(block)}`);
}

async function writeSurfaceInventory(page, seed, fileName, variant) {
  const inventory = await page.evaluate(collectBasicBlockMetrics, {
    blockIds: seed.blockIds,
    requiredTypes: seed.requiredTypes,
    title: seed.title,
  });
  writeFileSync(
    join(options.screenshotDir, fileName),
    `${JSON.stringify({ ...inventory, variant }, null, 2)}\n`,
  );
}

async function hoverBlock(page, blockId) {
  const group = blockGroup(page, blockId);
  await group.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await group.hover({ timeout: options.timeoutMs });
  await page.waitForTimeout(120);
}

async function clearTransientState(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.getSelection()?.removeAllRanges();
  });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(80);
}

async function setTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem('hanji:theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.waitForTimeout(100);
}

function collectBasicBlockMetrics(expected) {
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
  const body = document.querySelector('[role="region"][aria-label="Page body"]');
  const title = document.querySelector(
    '[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]',
  );
  if (!(body instanceof HTMLElement) || !(title instanceof HTMLElement)) {
    return { ok: false, reason: 'missing page body or title' };
  }
  const bodyRect = rect(body);
  const titleRect = rect(title);
  const blocks = {};
  for (const [key, id] of Object.entries(expected.blockIds)) {
    const group = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
    const row = group?.querySelector(':scope > [data-type]');
    if (!(group instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      blocks[key] = { ok: false, reason: 'missing group or row', id };
      continue;
    }
    const editable = row.querySelector('[data-rt-editable="true"]');
    const special =
      row.querySelector('[class*="quote"], [class*="callout"], [class*="divider"], [class*="codeBlock"], [class*="equationBlock"], [class*="simpleTableWrap"], [class*="toc"], [class*="bookmarkWrap"], [class*="imageBlock"], [class*="mediaEmpty"], [class*="embedEmpty"], [class*="fileBlock"]') ??
      row.querySelector('[class*="blockBody"]');
    const marker = row.querySelector('[class*="bulletDot"], [class*="numDot"]');
    const checkbox = row.querySelector('input[type="checkbox"]');
    const caret = row.querySelector('button[aria-label="Open toggle"], button[aria-label="Close toggle"]');
    const caretIcon = caret?.querySelector('svg');
    const rowRect = rect(row);
    const groupRect = rect(group);
    const editableRect = editable instanceof HTMLElement ? rect(editable) : null;
    const specialRect = special instanceof HTMLElement ? rect(special) : null;
    const rowStyle = getComputedStyle(row);
    const editableStyle = editable instanceof HTMLElement ? getComputedStyle(editable) : null;
    blocks[key] = {
      ok: true,
      id,
      type: row.getAttribute('data-type') ?? '',
      text: editable instanceof HTMLElement ? editable.textContent?.replace(/\s+/g, ' ').trim() ?? '' : '',
      groupLeft: groupRect.left,
      groupRight: groupRect.right,
      groupTop: groupRect.top,
      groupWidth: groupRect.width,
      rowLeft: rowRect.left,
      rowRight: rowRect.right,
      rowTop: rowRect.top,
      rowWidth: rowRect.width,
      rowHeight: rowRect.height,
      rowFontSize: Number.parseFloat(rowStyle.fontSize),
      editable: !!editableRect,
      editableLeft: editableRect?.left ?? null,
      editableRight: editableRect?.right ?? null,
      editableHeight: editableRect?.height ?? null,
      editableFontSize: editableStyle ? Number.parseFloat(editableStyle.fontSize) : null,
      markerWidth: marker instanceof HTMLElement ? marker.getBoundingClientRect().width : 0,
      checkboxWidth: checkbox instanceof HTMLElement ? checkbox.getBoundingClientRect().width : 0,
      checkboxChecked: checkbox instanceof HTMLInputElement ? checkbox.checked : false,
      caretWidth: caret instanceof HTMLElement ? caret.getBoundingClientRect().width : 0,
      caretIconSource: caretIcon instanceof SVGElement ? caretIcon.getAttribute('data-hanji-icon-source') : null,
      specialLeft: specialRect?.left ?? null,
      specialWidth: specialRect?.width ?? 0,
      specialHeight: specialRect?.height ?? 0,
    };
  }

  const visibleGutters = Array.from(body.querySelectorAll('[class*="gutter"]')).filter((gutter) => {
    if (!(gutter instanceof HTMLElement)) return false;
    if (String(gutter.className).includes('gutterBtn')) return false;
    const style = window.getComputedStyle(gutter);
    const gutterRect = gutter.getBoundingClientRect();
    return style.display !== 'none' && Number.parseFloat(style.opacity || '1') > 0.2 && gutterRect.width > 0 && gutterRect.height > 0;
  });

  return {
    ok: true,
    bodyLeft: bodyRect.left,
    bodyRight: bodyRect.right,
    bodyWidth: bodyRect.width,
    bodyScrollWidth: document.body.scrollWidth,
    blocks,
    documentScrollWidth: document.documentElement.scrollWidth,
    titleLeft: titleRect.left,
    titleText: title.textContent?.trim() ?? '',
    viewportWidth: window.innerWidth,
    visibleGutterCount: visibleGutters.length,
  };
}

async function seedBasicBlocksPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for basic blocks visual smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const title = `Basic blocks visual ${suffix}`;
  const blockIds = Object.fromEntries([
    'heading1',
    'heading2',
    'heading3',
    'heading4',
    'paragraph',
    'bullet',
    'number',
    'todo',
    'todoChecked',
    'toggle',
    'toggleChild',
    'toggleHeading',
    'quote',
    'callout',
    'divider',
    'code',
    'equation',
    'toc',
    'simpleTable',
    'bookmark',
    'image',
    'videoEmpty',
    'audioEmpty',
    'embedEmpty',
    'file',
  ].map((key) => [key, randomUUID()]));
  const requiredTypes = {
    heading1: 'heading_1',
    heading2: 'heading_2',
    heading3: 'heading_3',
    heading4: 'heading_4',
    paragraph: 'paragraph',
    bullet: 'bulleted_list_item',
    number: 'numbered_list_item',
    todo: 'to_do',
    todoChecked: 'to_do',
    toggle: 'toggle',
    toggleChild: 'paragraph',
    toggleHeading: 'toggle_heading_2',
    quote: 'quote',
    callout: 'callout',
    divider: 'divider',
    code: 'code',
    equation: 'equation',
    toc: 'table_of_contents',
    simpleTable: 'simple_table',
    bookmark: 'bookmark',
    image: 'image',
    videoEmpty: 'video',
    audioEmpty: 'audio',
    embedEmpty: 'embed',
    file: 'file',
  };

  const rich = (text) => [{ text }];
  const blocks = [
    block(blockIds.heading1, 'heading_1', 'Heading 1 mirrors Notion scale', 1),
    block(blockIds.heading2, 'heading_2', 'Heading 2 section rhythm', 2),
    block(blockIds.heading3, 'heading_3', 'Heading 3 compact section', 3),
    block(blockIds.heading4, 'heading_4', 'Heading 4 smallest heading', 4),
    {
      ...block(blockIds.paragraph, 'paragraph', '', 5),
      content: {
        rich: [
          { text: 'Paragraph with ' },
          { text: 'bold', bold: true },
          { text: ', ' },
          { text: 'inline code', code: true },
          { text: ', and a ' },
          { text: 'link', link: 'https://www.notion.so/help' },
          { text: ' should keep one calm text rhythm.' },
        ],
      },
      plainText: 'Paragraph with bold, inline code, and a link should keep one calm text rhythm.',
    },
    block(blockIds.bullet, 'bulleted_list_item', 'Bulleted list marker and text align tightly.', 6),
    block(blockIds.number, 'numbered_list_item', 'Numbered list marker should not crowd the text.', 7),
    {
      ...block(blockIds.todo, 'to_do', 'Unchecked to-do responds to click without shifting.', 8),
      content: { rich: rich('Unchecked to-do responds to click without shifting.'), checked: false },
    },
    {
      ...block(blockIds.todoChecked, 'to_do', 'Checked to-do keeps the completed rhythm.', 9),
      content: { rich: rich('Checked to-do keeps the completed rhythm.'), checked: true },
    },
    {
      ...block(blockIds.toggle, 'toggle', 'Toggle parent with a visible child', 10),
      content: { rich: rich('Toggle parent with a visible child'), collapsed: false },
    },
    {
      ...block(blockIds.toggleChild, 'paragraph', 'Nested child follows the toggle indent.', 1, blockIds.toggle),
      content: { rich: rich('Nested child follows the toggle indent.') },
    },
    {
      ...block(blockIds.toggleHeading, 'toggle_heading_2', 'Toggle heading keeps heading scale', 11),
      content: { rich: rich('Toggle heading keeps heading scale'), collapsed: true },
    },
    block(blockIds.quote, 'quote', 'Quote rail, text, and spacing should feel like Notion.', 12),
    {
      ...block(blockIds.callout, 'callout', 'Callout icon, padding, and background stay quiet.', 13),
      content: { rich: rich('Callout icon, padding, and background stay quiet.'), icon: '💡', color: 'gray_background' },
    },
    { ...block(blockIds.divider, 'divider', '', 14), content: { rich: [] }, plainText: '' },
    {
      ...block(blockIds.code, 'code', 'const value = blocks.map((block) => block.type);', 15),
      content: {
        rich: rich('function summarize(blocks) {\n  return blocks.map((block) => block.type).join(", ");\n}'),
        language: 'javascript',
        lineNumbers: true,
        wrap: true,
        caption: rich('Code caption stays compact below the block.'),
      },
      plainText: 'function summarize(blocks) {\n  return blocks.map((block) => block.type).join(", ");\n}',
    },
    {
      ...block(blockIds.equation, 'equation', '', 16),
      content: { expression: '\\int_0^1 x^2\\,dx = \\frac{1}{3}' },
      plainText: '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
    },
    { ...block(blockIds.toc, 'table_of_contents', '', 17), content: { rich: [] }, plainText: '' },
    {
      ...block(blockIds.simpleTable, 'simple_table', 'Name\tStatus\tOwner', 18),
      content: {
        table: [
          ['Block', 'State', 'Owner'],
          ['Callout', 'Quiet', 'Hanji'],
          ['Table', 'Readable', 'Hanji'],
        ],
        headerRow: true,
        headerColumn: false,
      },
      plainText: 'Block\tState\tOwner\nCallout\tQuiet\tHanji\nTable\tReadable\tHanji',
    },
    {
      ...block(blockIds.bookmark, 'bookmark', 'https://www.notion.so/help', 19),
      content: { url: 'https://www.notion.so/help' },
      plainText: 'https://www.notion.so/help',
    },
    {
      ...block(blockIds.image, 'image', 'Basic blocks reference image', 20),
      content: {
        url: SAMPLE_IMAGE,
        caption: rich('Image caption aligns with the media frame.'),
        width: 72,
        align: 'left',
      },
      plainText: 'Basic blocks reference image',
    },
    { ...block(blockIds.videoEmpty, 'video', '', 21), content: { rich: [] }, plainText: '' },
    { ...block(blockIds.audioEmpty, 'audio', '', 22), content: { rich: [] }, plainText: '' },
    { ...block(blockIds.embedEmpty, 'embed', '', 23), content: { rich: [] }, plainText: '' },
    {
      ...block(blockIds.file, 'file', 'basic-blocks-reference.pdf', 24),
      content: {
        url: 'https://example.com/basic-blocks-reference.pdf',
        fileName: 'basic-blocks-reference.pdf',
        caption: rich('File caption stays below the compact attachment card.'),
      },
      plainText: 'basic-blocks-reference.pdf',
    },
  ];

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    icon: '🧱',
    iconType: 'emoji',
    cover: '',
    coverPosition: 50,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'basic blocks visual smoke page must be created');
  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(createdBlocks?.blocks?.length === blocks.length, 'basic blocks visual smoke blocks must be created');

  return {
    accessToken: session.accessToken,
    blockIds,
    pageId,
    refreshToken: session.refreshToken,
    requiredTypes,
    title,
    userId: session.userId,
    workspaceId,
  };

  function block(id, type, text, position, parentId = null) {
    return {
      id,
      pageId,
      parentId,
      type,
      content: { rich: rich(text) },
      plainText: text,
      position,
    };
  }
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, { call: callFunction }).catch(() => {});
}

async function seedSession(context, seed, theme = 'light') {
  await installBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
    localStorage: { 'hanji:theme': theme },
    workspaceId: seed.workspaceId,
  });
}

async function closeSeededContext(context, seed) {
  await captureBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
  }).catch(() => {});
  await context.close().catch(() => {});
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    (expected) => {
      const titleElement = document.querySelector('[role="textbox"][aria-label="Page title"]');
      const localizedTitleElement =
        titleElement ?? document.querySelector('[role="textbox"][aria-label="페이지 제목"]');
      if (!localizedTitleElement) return false;
      const text = localizedTitleElement instanceof HTMLElement
        ? localizedTitleElement.innerText
        : localizedTitleElement.textContent;
      return text?.trim() === expected;
    },
    title,
    { timeout: options.timeoutMs },
  );
}

function blockGroup(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

function pageTitleSelector() {
  return '[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]';
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
  assert(typeof body?.user?.id === 'string' && body.user.id, 'anonymous sign-in must return a user id');
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
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
    'Playwright is required for basic blocks visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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

  parsed.screenshotDir = resolve(parsed.screenshotDir);
  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/basic-blocks-visual-smoke.mjs [options]

Captures a seeded page with all core editor blocks and checks Notion-style
density, containment, hover controls, and simple interaction behavior.

Options:
  --url <url>                 App URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>             EdgeBase API URL. Defaults to HANJI_EDGEBASE_API_URL or ${DEFAULT_BASE_URL}.
  --screenshot-dir <path>     Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
  --timeout-ms <number>       Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                    Show the browser while running.
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
