#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'nested-blocks');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL nested blocks visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Nested blocks visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Nested blocks visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedNestedBlocksPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertNestedBlocksUi(browser, appUrl, seed);
    console.log('PASS nested toggle/list block visuals stay within the Notion-style indentation and density contract.');
    console.log(`Desktop screenshot: ${join(options.screenshotDir, 'desktop-nested-blocks.png')}`);
    console.log(`Collapsed toggle screenshot: ${join(options.screenshotDir, 'desktop-collapsed-toggle.png')}`);
    console.log(`Dark desktop screenshot: ${join(options.screenshotDir, 'desktop-dark-nested-blocks.png')}`);
    console.log(`Mobile screenshot: ${join(options.screenshotDir, 'mobile-nested-blocks.png')}`);
    console.log(`Mobile dark screenshot: ${join(options.screenshotDir, 'mobile-dark-nested-blocks.png')}`);
  } finally {
    await Promise.race([browser.close(), delay(5000)]).catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertNestedBlocksUi(browser, appUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded nested blocks page', () => openPage(page, appUrl, seed));
    await step('capture desktop nested blocks', () =>
      captureNestedBlocks(page, seed, {
        mobile: false,
        name: 'desktop-nested-blocks.png',
        theme: 'light',
        viewport: { width: 1280, height: 900 },
      }));
    await step('capture collapsed toggle state', () => captureCollapsedToggle(page, seed));
    await step('capture dark desktop nested blocks', () =>
      captureNestedBlocks(page, seed, {
        mobile: false,
        name: 'desktop-dark-nested-blocks.png',
        theme: 'dark',
        viewport: { width: 1280, height: 900 },
      }));
    await step('capture mobile nested blocks', () =>
      captureNestedBlocks(page, seed, {
        mobile: true,
        name: 'mobile-nested-blocks.png',
        theme: 'light',
        viewport: { width: 390, height: 844 },
      }));
    await step('capture dark mobile nested blocks', () =>
      captureNestedBlocks(page, seed, {
        mobile: true,
        name: 'mobile-dark-nested-blocks.png',
        theme: 'dark',
        viewport: { width: 390, height: 844 },
      }));
    assertNoBrowserErrors(errors, 'nested blocks visual flow');
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
  await page.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, seed.title);
  for (const id of Object.values(seed.blockIds)) {
    await blockGroup(page, id).waitFor({ state: 'visible', timeout: options.timeoutMs });
  }
}

async function captureNestedBlocks(page, seed, variant) {
  await setViewport(page, variant.viewport);
  await setTheme(page, variant.theme);
  await ensureToggleExpanded(page, seed);
  await clearTransientBlockFocus(page);
  await blockGroup(page, seed.blockIds.toggleParent).scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await assertNestedBlocksVisualContract(page, seed, variant);
  await writeNestedBlocksSurfaceInventory(page, seed, {
    fileName: `${variant.name.replace(/\.png$/, '')}-inventory.json`,
    mobile: variant.mobile,
    state: 'expanded',
    theme: variant.theme,
    viewport: variant.viewport,
  });
  await page.screenshot({
    path: join(options.screenshotDir, variant.name),
    fullPage: false,
  });
}

async function captureCollapsedToggle(page, seed) {
  await setViewport(page, { width: 1280, height: 900 });
  await setTheme(page, 'light');
  await ensureToggleExpanded(page, seed);
  await blockGroup(page, seed.blockIds.toggleParent).getByRole('button', { name: 'Close toggle' }).click({
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (childId) => {
      const child = document.querySelector(`[data-block-id="${childId}"]`);
      return child === null || child.getClientRects().length === 0;
    },
    seed.blockIds.toggleTodo,
    { timeout: options.timeoutMs },
  );
  await assertCollapsedToggleVisualContract(page, seed);
  await writeNestedBlocksSurfaceInventory(page, seed, {
    fileName: 'desktop-collapsed-toggle-inventory.json',
    mobile: false,
    state: 'collapsed-toggle',
    theme: 'light',
    viewport: { width: 1280, height: 900 },
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'desktop-collapsed-toggle.png'),
    fullPage: false,
  });
  await ensureToggleExpanded(page, seed);
  await clearTransientBlockFocus(page);
}

async function ensureToggleExpanded(page, seed) {
  const toggle = blockGroup(page, seed.blockIds.toggleParent);
  const openButton = toggle.getByRole('button', { name: 'Open toggle' });
  if (await openButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await openButton.click({ timeout: options.timeoutMs });
  }
  await toggle.getByRole('button', { name: 'Close toggle' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await blockGroup(page, seed.blockIds.toggleTodo).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function clearTransientBlockFocus(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.getSelection()?.removeAllRanges();
  });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(80);
}

async function assertNestedBlocksVisualContract(page, seed, variant) {
  const metrics = await page.evaluate((blockIds) => {
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
    if (!(body instanceof HTMLElement)) return { ok: false, reason: 'missing page body' };

    const getInfo = (key) => {
      const id = blockIds[key];
      const group = document.querySelector(`[data-block-id="${id}"]`);
      const row = document.querySelector(`[data-block-id="${id}"] > [data-type]`);
      if (!(group instanceof HTMLElement) || !(row instanceof HTMLElement)) {
        return { key, ok: false, reason: 'missing block group or row' };
      }
      const editable = row.querySelector('[data-rt-editable="true"]');
      const caret = row.querySelector('button[aria-label="Close toggle"], button[aria-label="Open toggle"]');
      const caretIcon = caret?.querySelector('svg');
      const hasCaretIcon = !!caretIcon && caretIcon.tagName.toLowerCase() === 'svg';
      const bullet = row.querySelector('[class*="bulletDot"], [class*="numDot"]');
      const checkbox = row.querySelector('input[type="checkbox"]');
      const emptyTogglePrompt = group.querySelector('[class*="toggleEmptyChild"]');
      return {
        key,
        ok: true,
        caret: caret instanceof HTMLElement ? rect(caret) : null,
        caretIcon: hasCaretIcon ? rect(caretIcon) : null,
        caretIconSource: hasCaretIcon ? caretIcon.getAttribute('data-hanji-icon-source') : null,
        caretIconWeight: hasCaretIcon ? caretIcon.getAttribute('data-hanji-icon-weight') : null,
        checkbox: checkbox instanceof HTMLElement ? rect(checkbox) : null,
        depth: Number(group.getAttribute('data-depth') ?? 0),
        editable: editable instanceof HTMLElement ? rect(editable) : null,
        emptyTogglePrompt: emptyTogglePrompt instanceof HTMLElement ? {
          rect: rect(emptyTogglePrompt),
          text: emptyTogglePrompt.textContent?.trim() ?? '',
        } : null,
        group: rect(group),
        marker: bullet instanceof HTMLElement ? rect(bullet) : null,
        row: rect(row),
        text: editable instanceof HTMLElement ? editable.textContent?.trim() ?? '' : '',
        type: row.getAttribute('data-type'),
      };
    };

    const rows = Object.keys(blockIds).reduce((acc, key) => {
      acc[key] = getInfo(key);
      return acc;
    }, {});
    const visibleGutters = Array.from(body.querySelectorAll('[class*="gutter"]')).filter((gutter) => {
      if (!(gutter instanceof HTMLElement)) return false;
      if (String(gutter.className).includes('gutterBtn')) return false;
      const style = window.getComputedStyle(gutter);
      const rect = gutter.getBoundingClientRect();
      return style.display !== 'none' && Number.parseFloat(style.opacity) > 0.2 && rect.width > 0 && rect.height > 0;
    });
    return {
      ok: true,
      body: rect(body),
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      rows,
      visibleGutterCount: visibleGutters.length,
      viewportWidth: window.innerWidth,
    };
  }, seed.blockIds);

  assert(metrics.ok, metrics.reason ?? 'nested blocks visual contract could not run');
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `nested block fixture should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.visibleGutterCount === 0, `idle nested block screenshots should not leak transient block gutters: ${JSON.stringify(metrics)}`);

  for (const [key, row] of Object.entries(metrics.rows)) {
    assert(row.ok, `${key} row should be present: ${JSON.stringify(row)}`);
    assert(row.editable, `${key} row should expose editable text bounds: ${JSON.stringify(row)}`);
    assert(row.row.height >= 24 && row.row.height <= 76, `${key} row density drifted: ${JSON.stringify(row)}`);
    assert(row.group.right <= metrics.body.right + 4, `${key} should stay inside the document body: ${JSON.stringify(row)}`);
    assert(row.editable.right <= row.row.right + 1, `${key} text should not overflow its row: ${JSON.stringify(row)}`);
  }

  assertDepthStep(metrics, 'toggleParent', 'toggleTodo', 20, 34);
  assertDepthStep(metrics, 'toggleParent', 'toggleNote', 20, 34);
  assertDepthStep(metrics, 'bulletParent', 'bulletChild', 20, 34);
  assertDepthStep(metrics, 'bulletChild', 'bulletGrandchild', 20, 34);
  assertDepthStep(metrics, 'numberParent', 'numberChild', 20, 34);
  assertSameDepthAlignment(metrics, ['toggleTodo', 'toggleNote'], 3);

  const toggle = metrics.rows.toggleParent;
  assert(toggle.caret, `toggle parent should expose a caret: ${JSON.stringify(toggle)}`);
  assertNotionLikeToggleCaret(toggle, 'toggle parent');
  assert(toggle.caret.right <= toggle.editable.left, `toggle caret should sit before text without overlap: ${JSON.stringify(toggle)}`);
  assert(Math.abs((toggle.caret.top + toggle.caret.height / 2) - (toggle.editable.top + toggle.editable.height / 2)) <= 8,
    `toggle caret should be vertically aligned with its text: ${JSON.stringify(toggle)}`);

  const emptyToggle = metrics.rows.emptyToggle;
  assert(emptyToggle.caret, `empty toggle should expose a caret: ${JSON.stringify(emptyToggle)}`);
  assertNotionLikeToggleCaret(emptyToggle, 'empty toggle');
  assert(emptyToggle.emptyTogglePrompt, `expanded empty toggle should show an inner prompt: ${JSON.stringify(emptyToggle)}`);
  assert(
    emptyToggle.emptyTogglePrompt.text === 'Empty toggle. Click or drag a block inside it.',
    `empty toggle prompt should match the Notion-like helper copy: ${JSON.stringify(emptyToggle)}`,
  );

  for (const key of ['bulletParent', 'bulletChild', 'bulletGrandchild', 'numberParent', 'numberChild']) {
    const row = metrics.rows[key];
    assert(row.marker, `${key} should expose a compact list marker: ${JSON.stringify(row)}`);
    assert(row.marker.width >= 18 && row.marker.width <= 30, `${key} marker width drifted: ${JSON.stringify(row)}`);
    assert(row.marker.right <= row.editable.left + 2, `${key} marker should not overlap text: ${JSON.stringify(row)}`);
  }

  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `mobile nested block contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    for (const key of Object.keys(seed.blockIds)) {
      const row = metrics.rows[key];
      assert(row.group.left >= -4 && row.group.right <= metrics.viewportWidth + 4, `${key} mobile row should stay within viewport: ${JSON.stringify(row)}`);
      assert(row.editable.left >= metrics.body.left - 1, `${key} mobile text should stay inside body start: ${JSON.stringify(row)}`);
      assert(row.editable.left - metrics.body.left <= 140, `${key} mobile nested text should not drift too deep: ${JSON.stringify(row)}`);
    }
  }
}

function assertNotionLikeToggleCaret(row, label) {
  assert(row.caret.width >= 22 && row.caret.width <= 26, `${label} caret hit area should stay close to Notion's 24px button: ${JSON.stringify(row)}`);
  assert(row.caret.height >= 22 && row.caret.height <= 26, `${label} caret hit area should stay close to Notion's 24px button: ${JSON.stringify(row)}`);
  assert(row.caretIcon, `${label} should render the visible caret as an icon, not a text glyph: ${JSON.stringify(row)}`);
  assert(row.caretIcon.width >= 11 && row.caretIcon.width <= 15, `${label} visible caret icon size drifted: ${JSON.stringify(row)}`);
  assert(row.caretIcon.height >= 11 && row.caretIcon.height <= 15, `${label} visible caret icon size drifted: ${JSON.stringify(row)}`);
  assert(row.caretIconSource === 'phosphor', `${label} should use the shared Hanji/Phosphor icon source: ${JSON.stringify(row)}`);
  assert(row.caretIconWeight === 'fill', `${label} should use a filled caret like the Notion reference: ${JSON.stringify(row)}`);
}

function assertDepthStep(metrics, parentKey, childKey, min, max) {
  const parent = metrics.rows[parentKey];
  const child = metrics.rows[childKey];
  const groupStep = child.group.left - parent.group.left;
  const depthStep = child.depth - parent.depth;
  assert(depthStep === 1, `${childKey} should be exactly one visual depth below ${parentKey}: ${JSON.stringify({ parent, child })}`);
  assert(groupStep >= min && groupStep <= max,
    `${childKey} indent step drifted from ${parentKey}: ${JSON.stringify({ groupStep, parent, child })}`);
}

function assertSameDepthAlignment(metrics, keys, tolerance) {
  const lefts = keys.map((key) => metrics.rows[key]?.group?.left).filter((left) => Number.isFinite(left));
  assert(lefts.length === keys.length, `same-depth alignment rows missing: ${JSON.stringify({ keys, lefts })}`);
  const min = Math.min(...lefts);
  const max = Math.max(...lefts);
  assert(max - min <= tolerance, `same-depth child rows should align: ${JSON.stringify({ keys, lefts })}`);
}

async function writeNestedBlocksSurfaceInventory(page, seed, opts) {
  const inventory = await collectNestedBlocksSurfaceInventory(page, seed, opts);
  assertNestedBlocksSurfaceInventory(inventory);
  writeFileSync(join(options.screenshotDir, opts.fileName), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return inventory;
}

async function collectNestedBlocksSurfaceInventory(page, seed, opts) {
  const local = await page.evaluate((blockIds) => {
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
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    if (!(body instanceof HTMLElement)) return { ok: false, reason: 'missing page body' };

    const rows = Object.entries(blockIds).map(([key, id]) => {
      const group = document.querySelector(`[data-block-id="${id}"]`);
      const row = document.querySelector(`[data-block-id="${id}"] > [data-type]`);
      if (!(group instanceof HTMLElement) || !(row instanceof HTMLElement)) {
        return { key, present: false };
      }
      const editable = row.querySelector('[data-rt-editable="true"]');
      const caret = row.querySelector('button[aria-label="Close toggle"], button[aria-label="Open toggle"]');
      const caretIcon = caret?.querySelector('svg');
      const hasCaretIcon = !!caretIcon && caretIcon.tagName.toLowerCase() === 'svg';
      const marker = row.querySelector('[class*="bulletDot"], [class*="numDot"]');
      const checkbox = row.querySelector('input[type="checkbox"]');
      const emptyTogglePrompt = group.querySelector('[class*="toggleEmptyChild"]');
      return {
        key,
        present: true,
        depth: Number(group.getAttribute('data-depth') ?? 0),
        type: row.getAttribute('data-type'),
        group: rect(group),
        row: rect(row),
        editable: editable instanceof HTMLElement ? rect(editable) : null,
        caret: caret instanceof HTMLElement ? rect(caret) : null,
        caretIcon: hasCaretIcon ? rect(caretIcon) : null,
        caretIconSource: hasCaretIcon ? caretIcon.getAttribute('data-hanji-icon-source') : null,
        caretIconWeight: hasCaretIcon ? caretIcon.getAttribute('data-hanji-icon-weight') : null,
        marker: marker instanceof HTMLElement ? rect(marker) : null,
        checkbox: checkbox instanceof HTMLElement ? rect(checkbox) : null,
        emptyTogglePrompt: emptyTogglePrompt instanceof HTMLElement ? {
          rect: rect(emptyTogglePrompt),
          text: emptyTogglePrompt.textContent?.trim() ?? '',
        } : null,
        text: editable instanceof HTMLElement ? editable.textContent?.trim() ?? '' : '',
      };
    });

    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    const childIndentSteps = [
      ['toggleParent', 'toggleTodo'],
      ['toggleParent', 'toggleNote'],
      ['bulletParent', 'bulletChild'],
      ['bulletChild', 'bulletGrandchild'],
      ['numberParent', 'numberChild'],
    ].map(([parentKey, childKey]) => ({
      childKey,
      parentKey,
      step: byKey[childKey]?.present && byKey[parentKey]?.present
        ? Math.round((byKey[childKey].group.left - byKey[parentKey].group.left) * 100) / 100
        : null,
    }));

    return {
      ok: true,
      body: rect(body),
      childIndentSteps,
      documentScrollWidth: document.documentElement.scrollWidth,
      rows,
      viewport: {
        height: window.innerHeight,
        width: window.innerWidth,
      },
    };
  }, seed.blockIds);

  return {
    generatedAt: new Date().toISOString(),
    reference: nestedBlocksReferenceInventory(),
    seed: {
      pageId: seed.pageId,
      title: seed.title,
    },
    target: {
      mobile: !!opts.mobile,
      state: opts.state,
      theme: opts.theme,
      viewport: opts.viewport,
    },
    local,
  };
}

function nestedBlocksReferenceInventory() {
  const artifact = (name) => {
    const path = join(root, '.edgebase', 'notion-reference', 'current', name);
    return {
      path,
      present: existsSync(path),
    };
  };

  return {
    source: 'Current Notion reference loop. Live nested-editor references were captured from the logged-in Chrome Notion workspace on 2026-06-26. These artifacts calibrate indentation rhythm, control columns, and state hierarchy, not raw DOM tags or exact coordinates.',
    artifacts: [
      artifact('live-notion-nested-editor-reference-2026-06-26.png'),
      artifact('live-notion-nested-editor-reference-2026-06-26.json'),
    ],
    normalizedContract: {
      expanded: [
        'Nested editor rows use one quiet gutter with compact marker/control columns rather than page-row-style cards.',
        'Parent and child content align by a regular small indent step; same-depth children share a stable title anchor.',
        'To-do, bullet, numbered, and toggle controls sit before the text without covering or shifting the editable column.',
      ],
      collapsedToggle: [
        'A collapsed toggle keeps a compact triangle/control column and hides children without leaving a stale drop or child row footprint.',
        'The toggle control is visually lightweight at rest, not a boxed sidebar-style caret slab.',
      ],
      mobile: [
        'Nested text remains inside the narrow document gutter and does not drift so deep that the editor feels cramped.',
        'Desktop hover handles do not leak into idle mobile screenshots.',
      ],
      note: 'The reference records product-visible structure and rhythm. Hanji can keep its own tokens and responsive layout, but should not regress into irregular indentation, oversized controls, text overlap, or persistent idle chrome.',
    },
  };
}

function assertNestedBlocksSurfaceInventory(inventory) {
  assert(inventory.local?.ok, inventory.local?.reason ?? 'nested blocks inventory could not run');
  assert(
    inventory.local.rows.some((row) => row.key === 'toggleParent' && row.present),
    `nested blocks inventory should include the toggle parent row: ${JSON.stringify(inventory.local.rows)}`,
  );
  assert(inventory.local.documentScrollWidth <= inventory.local.viewport.width + 4,
    `nested blocks inventory should not show page-level horizontal overflow: ${JSON.stringify(inventory.local)}`);
  assert(inventory.reference.artifacts.length >= 2, 'nested blocks inventory should record live Notion reference artifacts');
}

async function assertCollapsedToggleVisualContract(page, seed) {
  const metrics = await page.evaluate((blockIds) => {
    const group = document.querySelector(`[data-block-id="${blockIds.toggleParent}"]`);
    const row = document.querySelector(`[data-block-id="${blockIds.toggleParent}"] > [data-type]`);
    const child = document.querySelector(`[data-block-id="${blockIds.toggleTodo}"]`);
    const caret = row?.querySelector('button[aria-label="Open toggle"], button[aria-label="Close toggle"]');
    const editable = row?.querySelector('[data-rt-editable="true"]');
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { height: r.height, left: r.left, right: r.right, top: r.top, width: r.width };
    };
    if (!(group instanceof HTMLElement) || !(row instanceof HTMLElement) ||
        !(caret instanceof HTMLElement) || !(editable instanceof HTMLElement)) {
      return { ok: false, reason: 'missing collapsed toggle row, caret, or editable text' };
    }
    return {
      ok: true,
      caret: rect(caret),
      childVisible: child instanceof HTMLElement && child.getClientRects().length > 0,
      editable: rect(editable),
      row: rect(row),
      rowDrop: row.getAttribute('data-drop'),
      viewportWidth: window.innerWidth,
    };
  }, seed.blockIds);

  assert(metrics.ok, metrics.reason ?? 'collapsed toggle contract could not run');
  assert(!metrics.childVisible, `collapsed toggle should hide nested children: ${JSON.stringify(metrics)}`);
  assert(metrics.row.height >= 24 && metrics.row.height <= 76, `collapsed toggle row density drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.caret.right <= metrics.editable.left + 4, `collapsed toggle caret should stay before text: ${JSON.stringify(metrics)}`);
  assert(metrics.rowDrop === null, `collapsed toggle should not retain stale drag state: ${JSON.stringify(metrics)}`);
}

function blockGroup(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    (expected) => {
      return document.body?.innerText.includes(expected) ?? false;
    },
    title,
    { timeout: options.timeoutMs },
  );
}

async function seedNestedBlocksPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for nested blocks visual smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const title = `중첩 블록 정리와 체크리스트 ${suffix}`;
  const blockIds = {
    intro: randomUUID(),
    toggleParent: randomUUID(),
    toggleTodo: randomUUID(),
    toggleNote: randomUUID(),
    emptyToggle: randomUUID(),
    bulletParent: randomUUID(),
    bulletChild: randomUUID(),
    bulletGrandchild: randomUUID(),
    numberParent: randomUUID(),
    numberChild: randomUUID(),
    sibling: randomUUID(),
  };
  const text = {
    intro: `중첩 블록 시각 검증 문서 ${suffix}`,
    toggleParent: '프로젝트 체크리스트',
    toggleTodo: '하위 체크박스 들여쓰기 확인',
    toggleNote: '토글 안에 후속 메모를 남기기',
    emptyToggle: '빈 토글 사용감 확인',
    bulletParent: '상위 글머리 항목',
    bulletChild: '하위 글머리 항목',
    bulletGrandchild: '손자 글머리 항목',
    numberParent: '상위 번호 항목',
    numberChild: '하위 번호 항목',
    sibling: '중첩 내용 다음에 이어지는 일반 문단',
  };

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    icon: '🧩',
    iconType: 'emoji',
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'nested blocks visual smoke page must be created');

  const blocks = [
    {
      id: blockIds.intro,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: text.intro }] },
      plainText: text.intro,
      position: 1,
    },
    {
      id: blockIds.toggleParent,
      pageId,
      parentId: null,
      type: 'toggle',
      content: { rich: [{ text: text.toggleParent }], collapsed: false },
      plainText: text.toggleParent,
      position: 2,
    },
    {
      id: blockIds.toggleTodo,
      pageId,
      parentId: blockIds.toggleParent,
      type: 'to_do',
      content: { rich: [{ text: text.toggleTodo }], checked: false },
      plainText: text.toggleTodo,
      position: 1,
    },
    {
      id: blockIds.toggleNote,
      pageId,
      parentId: blockIds.toggleParent,
      type: 'paragraph',
      content: { rich: [{ text: text.toggleNote }] },
      plainText: text.toggleNote,
      position: 2,
    },
    {
      id: blockIds.emptyToggle,
      pageId,
      parentId: null,
      type: 'toggle',
      content: { rich: [{ text: text.emptyToggle }], collapsed: false },
      plainText: text.emptyToggle,
      position: 3,
    },
    {
      id: blockIds.bulletParent,
      pageId,
      parentId: null,
      type: 'bulleted_list_item',
      content: { rich: [{ text: text.bulletParent }] },
      plainText: text.bulletParent,
      position: 4,
    },
    {
      id: blockIds.bulletChild,
      pageId,
      parentId: blockIds.bulletParent,
      type: 'bulleted_list_item',
      content: { rich: [{ text: text.bulletChild }] },
      plainText: text.bulletChild,
      position: 1,
    },
    {
      id: blockIds.bulletGrandchild,
      pageId,
      parentId: blockIds.bulletChild,
      type: 'bulleted_list_item',
      content: { rich: [{ text: text.bulletGrandchild }] },
      plainText: text.bulletGrandchild,
      position: 1,
    },
    {
      id: blockIds.numberParent,
      pageId,
      parentId: null,
      type: 'numbered_list_item',
      content: { rich: [{ text: text.numberParent }] },
      plainText: text.numberParent,
      position: 5,
    },
    {
      id: blockIds.numberChild,
      pageId,
      parentId: blockIds.numberParent,
      type: 'numbered_list_item',
      content: { rich: [{ text: text.numberChild }] },
      plainText: text.numberChild,
      position: 1,
    },
    {
      id: blockIds.sibling,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: text.sibling }] },
      plainText: text.sibling,
      position: 6,
    },
  ];
  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(createdBlocks?.blocks?.length === blocks.length, 'nested blocks visual smoke blocks must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageId,
    title,
    blockIds,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.pageId,
  }).catch(() => {});
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', 'light');
  }, {
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function setTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem('notionlike:theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.waitForTimeout(80);
}

async function setViewport(page, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForFunction(
    (width) => window.innerWidth === width,
    viewport.width,
    { timeout: options.timeoutMs },
  );
  await page.waitForTimeout(120);
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
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
    'Playwright is required for nested blocks visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a number >= 1000');
      }
      i += 1;
      continue;
    }
    if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(resolveValue(args, i, arg));
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
  console.log(`Usage: node scripts/nested-blocks-visual-smoke.mjs [options]

Captures and checks a nested editor fixture with toggle, to-do, bullet, and
numbered child blocks. The contract focuses on visual indentation, caret/list
marker alignment, mobile containment, and collapsed toggle behavior.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         API/runtime URL for seeding. Defaults to --url.
  --screenshot-dir <path> Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
