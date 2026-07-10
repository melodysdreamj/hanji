#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'block-drag');
const BLOCK_DRAG_TYPE = 'application/x-notionlike-block';
const BLOCK_DRAG_IDS_TYPE = 'application/x-notionlike-block-ids';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL block drag UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Block drag UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedDragPage(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertBlockDragUi(browser, baseUrl, seed);
    console.log('PASS block drag handle visuals, drop indicators, and persisted block order stay within the Notion-style contract.');
    console.log(`Hover screenshot: ${join(options.screenshotDir, 'desktop-block-hover.png')}`);
    console.log(`Drop screenshot: ${join(options.screenshotDir, 'desktop-block-drop-before.png')}`);
    console.log(`Dark hover screenshot: ${join(options.screenshotDir, 'desktop-dark-block-hover.png')}`);
    console.log(`Mobile row screenshot: ${join(options.screenshotDir, 'mobile-block-row.png')}`);
    console.log(`Mobile dark row screenshot: ${join(options.screenshotDir, 'mobile-dark-block-row.png')}`);
    console.log(`Idle inventory: ${join(options.screenshotDir, 'desktop-block-inventory-idle.json')}`);
    console.log(`Hover inventory: ${join(options.screenshotDir, 'desktop-block-inventory-hover.json')}`);
    console.log(`Drop inventory: ${join(options.screenshotDir, 'desktop-block-inventory-drop-before.json')}`);
    console.log(`Dark hover inventory: ${join(options.screenshotDir, 'desktop-dark-block-inventory-hover.json')}`);
    console.log(`Mobile row inventory: ${join(options.screenshotDir, 'mobile-block-inventory-row.json')}`);
    console.log(`Mobile dark row inventory: ${join(options.screenshotDir, 'mobile-dark-block-inventory-row.json')}`);
  } finally {
    await Promise.race([browser.close(), delay(5000)]).catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertBlockDragUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded drag page', () => openPage(page, baseUrl, seed));
    await step('capture block drag visual fixtures', () => captureBlockDragVisuals(page, seed));
    await step('keep block gutters reachable across representative block types', () =>
      assertBlockGutterHoverPaths(page, seed)
    );
    await step('drag middle block before the first block', () =>
      dragBlockTo(page, baseUrl, seed, 'middle', 'first', 'before', ['middle', 'first', 'last', 'toggleTarget']));
    await step('drag moved block after the last block', () =>
      dragBlockTo(page, baseUrl, seed, 'middle', 'last', 'after', ['first', 'last', 'middle', 'toggleTarget']));
    await step('drag moved block inside collapsed toggle and continue writing', () =>
      dragBlockIntoToggleAndContinue(page, baseUrl, seed));
    assertNoBrowserErrors(errors, 'block drag UI flow');
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
  for (const block of seed.hoverBlocks ?? []) {
    await blockGroup(page, block.id).waitFor({ state: 'visible', timeout: options.timeoutMs });
  }
  await expectDomOrder(page, seed, ['first', 'middle', 'last', 'toggleTarget']);
  await waitForBlockOrder(baseUrl, seed, ['first', 'middle', 'last', 'toggleTarget'], 'initial drag block order');
}

async function dragBlockTo(page, baseUrl, seed, sourceKey, targetKey, placement, expectedKeys) {
  const sourceId = seed.blockIds[sourceKey];
  const targetId = seed.blockIds[targetKey];
  const sourceHandle = dragHandle(page, sourceId);
  const targetRow = blockRow(page, targetId);
  const targetBox = await targetRow.boundingBox({ timeout: options.timeoutMs });
  assert(targetBox, `target block row ${targetId} must have a bounding box`);
  const targetPosition = {
    x: Math.min(16, Math.max(2, Math.round(targetBox.width * 0.2))),
    y: placement === 'before' ? 2 : Math.max(2, Math.round(targetBox.height - 2)),
  };

  await blockGroup(page, sourceId).hover({ timeout: options.timeoutMs });
  await sourceHandle.dragTo(targetRow, {
    targetPosition,
    timeout: options.timeoutMs,
  });

  await expectDomOrder(page, seed, expectedKeys);
  await waitForBlockOrder(baseUrl, seed, expectedKeys, `${placement} drag order`);
}

async function dragBlockIntoToggleAndContinue(page, baseUrl, seed) {
  const sourceId = seed.blockIds.middle;
  const targetId = seed.blockIds.toggleTarget;
  const sourceHandle = dragHandle(page, sourceId);
  const targetRow = blockRow(page, targetId);
  const targetBox = await targetRow.boundingBox({ timeout: options.timeoutMs });
  assert(targetBox, `target toggle row ${targetId} must have a bounding box`);

  await blockGroup(page, sourceId).hover({ timeout: options.timeoutMs });
  await sourceHandle.dragTo(targetRow, {
    targetPosition: {
      x: Math.min(18, Math.max(4, Math.round(targetBox.width * 0.18))),
      y: Math.max(3, Math.round(targetBox.height * 0.5)),
    },
    timeout: options.timeoutMs,
  });

  await expectDomOrder(page, seed, ['first', 'last', 'toggleTarget']);
  await waitForBlocks(baseUrl, seed, (blocks) => {
    const moved = blocks.find((block) => block.id === sourceId);
    const target = blocks.find((block) => block.id === targetId);
    return (
      moved?.parentId === targetId &&
      target?.type === 'toggle' &&
      target?.content?.collapsed === false
    );
  }, 'dragged block inside expanded toggle');
  await blockGroup(page, sourceId).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await waitForFocusedBlockTextbox(page, sourceId, 'Text block text');

  await page.keyboard.press('Enter');
  await page.keyboard.type(seed.toggleFollowupText);
  await waitForBlocks(baseUrl, seed, (blocks) =>
    blocks.some(
      (block) =>
        block.parentId === targetId &&
        block.type === 'paragraph' &&
        block.plainText === seed.toggleFollowupText,
    ), 'Enter after toggle drop follow-up block');
}

async function captureBlockDragVisuals(page, seed) {
  await setViewport(page, { width: 1280, height: 900 });
  await setTheme(page, 'light');
  await captureBlockIdle(page, seed, 'desktop');
  await captureBlockHover(page, seed, 'desktop');
  await captureBlockDropIndicator(page, seed, 'desktop', 'middle', 'first', 'before');

  await setTheme(page, 'dark');
  await captureBlockIdle(page, seed, 'desktop-dark');
  await captureBlockHover(page, seed, 'desktop-dark');

  await setViewport(page, { width: 390, height: 844 });
  await setTheme(page, 'light');
  await captureMobileBlockRow(page, seed, 'mobile');

  await setTheme(page, 'dark');
  await captureMobileBlockRow(page, seed, 'mobile-dark');

  await setViewport(page, { width: 1280, height: 900 });
  await setTheme(page, 'light');
}

async function captureBlockIdle(page, seed, prefix) {
  const blockId = seed.blockIds.first;
  await blockGroup(page, blockId).scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await page.mouse.move(24, 24);
  await waitForBlockGutter(page, blockId, false);
  await writeBlockDragSurfaceInventory(page, seed, {
    blockId,
    filename: `${prefix}-block-inventory-idle.json`,
    mobile: false,
    state: 'idle',
  });
}

async function captureBlockHover(page, seed, prefix) {
  const blockId = seed.blockIds.first;
  await blockGroup(page, blockId).hover({ timeout: options.timeoutMs });
  await waitForBlockGutter(page, blockId, true);
  await assertBlockDragVisualContract(page, seed, {
    blockId,
    mobile: false,
    state: 'hover',
  });
  await writeBlockDragSurfaceInventory(page, seed, {
    blockId,
    filename: `${prefix}-block-inventory-hover.json`,
    mobile: false,
    state: 'hover',
  });
  await page.screenshot({
    path: join(options.screenshotDir, `${prefix}-block-hover.png`),
    fullPage: false,
  });
}

async function captureBlockDropIndicator(page, seed, prefix, sourceKey, targetKey, placement) {
  const sourceId = seed.blockIds[sourceKey];
  const targetId = seed.blockIds[targetKey];
  await synthesizeBlockDragOver(page, sourceId, targetId, placement);
  await page.waitForFunction(
    ({ targetId, placement }) => {
      const target = document.querySelector(`[data-block-id="${targetId}"] > [data-type]`);
      return target instanceof HTMLElement && target.dataset.drop === placement;
    },
    { targetId, placement },
    { timeout: options.timeoutMs },
  );
  await assertBlockDragVisualContract(page, seed, {
    blockId: targetId,
    mobile: false,
    placement,
    sourceId,
    state: 'drop',
  });
  await writeBlockDragSurfaceInventory(page, seed, {
    blockId: targetId,
    filename: `${prefix}-block-inventory-drop-${placement}.json`,
    mobile: false,
    placement,
    sourceId,
    state: 'drop',
  });
  await page.screenshot({
    path: join(options.screenshotDir, `${prefix}-block-drop-${placement}.png`),
    fullPage: false,
  });
  await clearSyntheticBlockDrag(page, sourceId, targetId);
}

async function captureMobileBlockRow(page, seed, prefix) {
  const blockId = seed.blockIds.first;
  await blockGroup(page, blockId).scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await assertBlockDragVisualContract(page, seed, {
    blockId,
    mobile: true,
    state: 'mobile-row',
  });
  await writeBlockDragSurfaceInventory(page, seed, {
    blockId,
    filename: `${prefix}-block-inventory-row.json`,
    mobile: true,
    state: 'mobile-row',
  });
  await page.screenshot({
    path: join(options.screenshotDir, `${prefix}-block-row.png`),
    fullPage: false,
  });
}

async function assertBlockGutterHoverPaths(page, seed) {
  await setViewport(page, { width: 1280, height: 900 });
  await setTheme(page, 'light');
  const targets = [
    { id: seed.blockIds.first, key: 'paragraph', type: 'paragraph' },
    { id: seed.blockIds.toggleTarget, key: 'toggle', type: 'toggle' },
    ...(seed.hoverBlocks ?? []),
  ];

  for (const target of targets) {
    await assertBlockGutterHoverPath(page, target);
  }
}

async function assertBlockGutterHoverPath(page, target) {
  await blockGroup(page, target.id).scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const geometry = await page.evaluate((targetBlockId) => {
    const group = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
    const row = group?.querySelector('[class*="blockRow"]');
    const body = group?.querySelector('[class*="blockBody"]');
    const gutter = group?.querySelector('[class*="gutter"]');
    const action = group?.querySelector('button[aria-label="Open block actions"]');
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
    if (
      !(row instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(gutter instanceof HTMLElement) ||
      !(action instanceof HTMLElement)
    ) {
      return null;
    }
    return {
      action: rect(action),
      body: rect(body),
      gutter: rect(gutter),
      row: rect(row),
    };
  }, target.id);
  assert(geometry, `block gutter hover geometry missing for ${target.key}`);

  const start = {
    x: Math.max(
      geometry.row.left + 4,
      Math.min(geometry.body.left + 28, geometry.row.right - 6)
    ),
    y: Math.max(
      geometry.row.top + 4,
      Math.min(geometry.row.top + geometry.row.height / 2, geometry.row.bottom - 4)
    ),
  };
  const actionCenter = {
    x: geometry.action.left + geometry.action.width / 2,
    y: geometry.action.top + geometry.action.height / 2,
  };

  await page.mouse.move(start.x, start.y);
  await waitForBlockGutter(page, target.id, true);
  await page.mouse.move(actionCenter.x, actionCenter.y, { steps: 18 });
  await page.waitForFunction(
    (targetBlockId) => {
      const gutter = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"] [class*="gutter"]`);
      if (!(gutter instanceof HTMLElement)) return false;
      const style = getComputedStyle(gutter);
      return Number.parseFloat(style.opacity) >= 0.8 && style.pointerEvents !== 'none';
    },
    target.id,
    { timeout: options.timeoutMs },
  );
  await page.mouse.click(actionCenter.x, actionCenter.y);
  const actions = page.getByRole('menu', { name: 'Block actions' });
  await actions.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await actions.locator('[data-block-menu-item]').first().focus({ timeout: options.timeoutMs });
  await page.keyboard.press('Escape');
  await actions.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function waitForBlockGutter(page, blockId, visible) {
  await page.waitForFunction(
    ({ blockId, visible }) => {
      const gutter = document.querySelector(`[data-block-id="${blockId}"] [class*="gutter"]`);
      if (!(gutter instanceof HTMLElement)) return false;
      const opacity = Number.parseFloat(getComputedStyle(gutter).opacity);
      return visible ? opacity >= 0.8 : opacity <= 0.2;
    },
    { blockId, visible },
    { timeout: options.timeoutMs },
  );
}

async function synthesizeBlockDragOver(page, sourceId, targetId, placement) {
  await page.evaluate(({ sourceId, targetId, placement, dragType, dragIdsType }) => {
    const source = document.querySelector(`[data-block-id="${sourceId}"]`);
    const target = document.querySelector(`[data-block-id="${targetId}"]`);
    const handle = source?.querySelector('button[draggable="true"]');
    const targetRow = Array.from(target?.children ?? []).find(
      (child) => child instanceof HTMLElement && child.hasAttribute('data-type'),
    );
    if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) ||
        !(handle instanceof HTMLElement) || !(targetRow instanceof HTMLElement)) {
      throw new Error('missing block drag source handle or target row');
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.setData(dragType, sourceId);
    dataTransfer.setData(dragIdsType, JSON.stringify([sourceId]));
    const handleRect = handle.getBoundingClientRect();
    const targetRect = targetRow.getBoundingClientRect();
    const clientY = placement === 'before'
      ? targetRect.top + Math.max(2, targetRect.height * 0.12)
      : placement === 'after'
        ? targetRect.bottom - Math.max(2, targetRect.height * 0.12)
        : targetRect.top + targetRect.height * 0.5;
    const clientX = targetRect.left + Math.min(18, Math.max(4, targetRect.width * 0.12));

    handle.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: handleRect.left + handleRect.width / 2,
      clientY: handleRect.top + handleRect.height / 2,
      dataTransfer,
    }));
    targetRow.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer,
    }));
  }, { sourceId, targetId, placement, dragType: BLOCK_DRAG_TYPE, dragIdsType: BLOCK_DRAG_IDS_TYPE });
}

async function clearSyntheticBlockDrag(page, sourceId, targetId) {
  await page.evaluate(({ sourceId, targetId }) => {
    const source = document.querySelector(`[data-block-id="${sourceId}"]`);
    const target = document.querySelector(`[data-block-id="${targetId}"]`);
    const handle = source?.querySelector('button[draggable="true"]');
    const targetRow = Array.from(target?.children ?? []).find(
      (child) => child instanceof HTMLElement && child.hasAttribute('data-type'),
    );
    targetRow?.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
    handle?.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
  }, { sourceId, targetId });
}

async function assertBlockDragVisualContract(page, seed, opts) {
  const metrics = await page.evaluate(({ blockId, placement, sourceId, state }) => {
    const block = document.querySelector(`[data-block-id="${blockId}"]`);
    const row = document.querySelector(`[data-block-id="${blockId}"] > [data-type]`);
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    const sourceRow = sourceId ? document.querySelector(`[data-block-id="${sourceId}"] > [data-type]`) : null;
    if (!(block instanceof HTMLElement) || !(row instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      return { ok: false, reason: 'missing block, row, or page body' };
    }

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
    const gutter = block.querySelector('[class*="gutter"]');
    const buttons = Array.from(gutter?.querySelectorAll('button') ?? []).filter(
      (button) => button instanceof HTMLElement,
    );
    const gutterRect = gutter instanceof HTMLElement ? rect(gutter) : null;
    const buttonRects = buttons.map((button) => rect(button));
    const rowRect = rect(row);
    const bodyRect = rect(body);
    const blockBody = row.querySelector('[class*="blockBody"]');
    const blockBodyRect = blockBody instanceof HTMLElement ? rect(blockBody) : null;
    const before = getComputedStyle(row, '::before');
    const after = getComputedStyle(row, '::after');
    const sourceDataDragging = sourceRow instanceof HTMLElement ? sourceRow.dataset.dragging === 'true' : false;

    return {
      ok: true,
      blockBodyLeft: blockBodyRect?.left ?? null,
      blockBodyRight: blockBodyRect?.right ?? null,
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      bodyScrollWidth: document.body.scrollWidth,
      buttonRects,
      documentScrollWidth: document.documentElement.scrollWidth,
      drop: row.dataset.drop ?? null,
      gutterButtonCount: buttonRects.length,
      gutterHeight: gutterRect?.height ?? null,
      gutterLeft: gutterRect?.left ?? null,
      gutterOpacity: gutter instanceof HTMLElement ? Number.parseFloat(getComputedStyle(gutter).opacity) : null,
      gutterRight: gutterRect?.right ?? null,
      gutterWidth: gutterRect?.width ?? null,
      indicatorBackground: placement === 'after' ? after.backgroundColor : before.backgroundColor,
      indicatorHeight: Number.parseFloat(placement === 'after' ? after.height : before.height),
      indicatorLeft: Number.parseFloat(placement === 'after' ? after.left : before.left),
      indicatorRight: Number.parseFloat(placement === 'after' ? after.right : before.right),
      rowHeight: rowRect.height,
      rowLeft: rowRect.left,
      rowRight: rowRect.right,
      sourceDataDragging,
      state,
      viewportWidth: window.innerWidth,
    };
  }, opts);

  assert(metrics.ok, metrics.reason ?? 'block drag visual contract could not run');
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `block drag fixture should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.rowHeight >= 26 && metrics.rowHeight <= 72, `block row density drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.blockBodyLeft >= metrics.rowLeft - 1, `block body should stay inside its row: ${JSON.stringify(metrics)}`);
  assert(metrics.blockBodyRight <= metrics.rowRight + 1, `block body should not overflow its row: ${JSON.stringify(metrics)}`);

  if (opts.mobile) {
    assert(metrics.viewportWidth <= 430, `mobile block row contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.rowLeft >= -4 && metrics.rowRight <= metrics.viewportWidth + 4, `mobile block row should stay within viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.blockBodyLeft >= 20 && metrics.blockBodyRight <= metrics.viewportWidth - 8, `mobile block body gutter drifted: ${JSON.stringify(metrics)}`);
    return;
  }

  assert(metrics.rowLeft >= metrics.bodyLeft - 56, `desktop block row should not drift far outside document gutter: ${JSON.stringify(metrics)}`);
  assert(metrics.rowRight <= metrics.bodyRight + 4, `desktop block row should stay inside document body: ${JSON.stringify(metrics)}`);

  if (opts.state === 'hover') {
    assert(metrics.gutterOpacity >= 0.8, `hovered block gutter should reveal compact actions: ${JSON.stringify(metrics)}`);
    assert(metrics.gutterButtonCount >= 2, `hovered block gutter should expose add and drag handles: ${JSON.stringify(metrics)}`);
    assert(metrics.gutterWidth >= 42 && metrics.gutterWidth <= 50, `block gutter width drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.gutterHeight >= 24 && metrics.gutterHeight <= 30, `block gutter height drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.gutterRight <= metrics.blockBodyLeft - 2, `block gutter should sit in the left document gutter without covering text: ${JSON.stringify(metrics)}`);
    for (const button of metrics.buttonRects) {
      assert(button.width >= 20 && button.width <= 24, `block gutter button width drifted: ${JSON.stringify(button)}`);
      assert(button.height >= 22 && button.height <= 26, `block gutter button height drifted: ${JSON.stringify(button)}`);
    }
  }

  if (opts.state === 'drop') {
    assert(metrics.drop === opts.placement, `drag-over target should expose ${opts.placement} drop state: ${JSON.stringify(metrics)}`);
    assert(metrics.sourceDataDragging, `drag source should expose dragging state while indicator is captured: ${JSON.stringify(metrics)}`);
    assert(metrics.indicatorHeight >= 1.5 && metrics.indicatorHeight <= 3, `drop indicator should stay as a quiet insertion line: ${JSON.stringify(metrics)}`);
    assert(String(metrics.indicatorBackground).includes('35') || String(metrics.indicatorBackground).includes('226'), `drop indicator should use the accent insertion color: ${JSON.stringify(metrics)}`);
  }
}

async function writeBlockDragSurfaceInventory(page, seed, opts) {
  const inventory = await collectBlockDragSurfaceInventory(page, seed, opts);
  assertBlockDragSurfaceInventory(inventory);
  const path = join(options.screenshotDir, opts.filename);
  writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return inventory;
}

async function collectBlockDragSurfaceInventory(page, seed, opts) {
  const local = await page.evaluate(({ blockId, placement, sourceId, state }) => {
    const block = document.querySelector(`[data-block-id="${blockId}"]`);
    const row = document.querySelector(`[data-block-id="${blockId}"] > [data-type]`);
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    const sourceRow = sourceId ? document.querySelector(`[data-block-id="${sourceId}"] > [data-type]`) : null;
    if (!(block instanceof HTMLElement) || !(row instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      return { ok: false, reason: 'missing block, row, or page body' };
    }

    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        bottom: round(r.bottom),
        height: round(r.height),
        left: round(r.left),
        right: round(r.right),
        top: round(r.top),
        width: round(r.width),
      };
    };
    const round = (value) => Math.round(value * 100) / 100;
    const effectiveOpacity = (element) => {
      let opacity = 1;
      let node = element;
      while (node instanceof HTMLElement) {
        opacity *= Number.parseFloat(getComputedStyle(node).opacity || '1');
        node = node.parentElement;
      }
      return round(opacity);
    };
    const isEffectivelyVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const r = element.getBoundingClientRect();
      let node = element;
      while (node instanceof HTMLElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number.parseFloat(style.opacity || '1') <= 0.2) return false;
        node = node.parentElement;
      }
      return r.width > 0 && r.height > 0;
    };
    const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const styleSummary = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return {
        color: style.color,
        display: style.display,
        opacity: round(effectiveOpacity(element)),
        pointerEvents: style.pointerEvents,
        visibility: style.visibility,
      };
    };

    const gutter = block.querySelector('[class*="gutter"]');
    const buttons = Array.from(gutter?.querySelectorAll('button') ?? [])
      .filter((button) => button instanceof HTMLElement)
      .map((button) => ({
        ariaLabel: button.getAttribute('aria-label'),
        draggable: button.getAttribute('draggable') === 'true',
        expanded: button.getAttribute('aria-expanded') === 'true',
        rect: rect(button),
        title: button.getAttribute('title'),
        visible: isEffectivelyVisible(button),
      }));
    const blockBody = row.querySelector('[class*="blockBody"]');
    const editable = row.querySelector('[contenteditable="true"], [role="textbox"]');
    const before = getComputedStyle(row, '::before');
    const after = getComputedStyle(row, '::after');

    return {
      ok: true,
      block: {
        ariaLabel: block.getAttribute('aria-label'),
        depth: block.getAttribute('data-depth'),
        rect: rect(block),
      },
      body: {
        rect: rect(body),
      },
      dropIndicator: {
        afterBackground: after.backgroundColor,
        afterHeight: round(Number.parseFloat(after.height) || 0),
        beforeBackground: before.backgroundColor,
        beforeHeight: round(Number.parseFloat(before.height) || 0),
        drop: row instanceof HTMLElement ? row.dataset.drop ?? null : null,
      },
      gutter: gutter instanceof HTMLElement
        ? {
            buttonCount: buttons.length,
            buttons,
            rect: rect(gutter),
            style: styleSummary(gutter),
            visible: isEffectivelyVisible(gutter),
          }
        : null,
      page: {
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme || 'light',
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      },
      row: {
        rect: rect(row),
        sourceDragging: sourceRow instanceof HTMLElement ? sourceRow.dataset.dragging === 'true' : false,
        style: styleSummary(row),
        text: text(row),
        type: row.getAttribute('data-type'),
      },
      state,
      textColumn: blockBody instanceof HTMLElement
        ? {
            editableRect: editable instanceof HTMLElement ? rect(editable) : null,
            editableText: text(editable),
            rect: rect(blockBody),
            visible: isEffectivelyVisible(blockBody),
          }
        : null,
      requestedPlacement: placement ?? null,
    };
  }, opts);

  return {
    generatedAt: new Date().toISOString(),
    reference: blockDragReferenceInventory(),
    seed: {
      blockText: seed.blockText,
      pageId: seed.pageId,
      title: seed.title,
    },
    target: {
      blockId: opts.blockId,
      mobile: opts.mobile,
      placement: opts.placement ?? null,
      sourceId: opts.sourceId ?? null,
      state: opts.state,
    },
    local,
  };
}

function blockDragReferenceInventory() {
  const artifact = (name) => {
    const path = join(root, '.edgebase', 'notion-reference', 'current', name);
    return {
      path,
      present: existsSync(path),
    };
  };

  return {
    source: 'Current Notion reference artifacts captured through the Notion reference loop.',
    artifacts: [
      artifact('notion-block-row-reference-2026-06-26.json'),
      artifact('notion-block-row-reference-2026-06-26.png'),
      artifact('notion-block-row-hover-reference-2026-06-26.png'),
      artifact('live-notion-block-editor-idle-reference-2026-06-26.png'),
      artifact('live-notion-editor-reference-2026-06-26.png'),
      artifact('live-notion-block-page-reference.json'),
      artifact('live-notion-block-page-reference.png'),
    ],
    normalizedContract: {
      desktopIdle: [
        'Block text rows keep a stable document text column without permanent add/drag controls.',
        'The left block gutter exists as an interaction target, but it is visually quiet until row hover, focus, selection, or menu state.',
      ],
      desktopHover: [
        'Hover reveals exactly the compact block affordance pair in the left gutter: add-below and drag/actions.',
        'The revealed controls stay left of the text column and do not cover or shift the block text.',
        'Moving the pointer from the block body to the left gutter keeps the controls hittable across common block types.',
      ],
      dragDrop: [
        'A drag-over target shows a thin accent insertion line before/after the row rather than a large filled drop zone.',
        'The dragged source row exposes a quiet dragging state while the target indicator is visible.',
      ],
      mobile: [
        'The document text column remains within the viewport.',
        'Desktop hover controls do not persist as visible row clutter in the idle narrow layout.',
      ],
      note: 'Notion DOM measurements calibrate the interaction model. The app should preserve the Notion-style hierarchy, density, and reveal behavior through its own responsive design tokens rather than copying raw Notion DOM geometry.',
    },
  };
}

function assertBlockDragSurfaceInventory(inventory) {
  const { local, target } = inventory;
  assert(local?.ok, local?.reason ?? 'block drag surface inventory could not run');
  const maxScrollWidth = Math.max(local.page.bodyScrollWidth, local.page.documentScrollWidth);
  assert(
    maxScrollWidth <= local.page.viewportWidth + 4,
    `block surface inventory found horizontal overflow: ${JSON.stringify(local, null, 2)}`,
  );
  assert(local.textColumn?.visible, `block text column must be visible: ${JSON.stringify(local, null, 2)}`);
  assert(
    local.textColumn.rect.left >= local.row.rect.left - 1 && local.textColumn.rect.right <= local.row.rect.right + 1,
    `block text column should stay inside its row: ${JSON.stringify(local, null, 2)}`,
  );

  const labels = local.gutter?.buttons.map((button) => button.ariaLabel).filter(Boolean) ?? [];
  const visibleButtons = local.gutter?.buttons.filter((button) => button.visible) ?? [];
  const gutterVisible = !!local.gutter?.visible;

  if (!target.mobile && target.state === 'idle') {
    assert(local.gutter, `desktop block row should include a hover-revealed gutter primitive: ${JSON.stringify(local, null, 2)}`);
    assert(!gutterVisible, `desktop idle block gutter should stay visually quiet until hover/focus: ${JSON.stringify(local, null, 2)}`);
    assert(visibleButtons.length === 0, `desktop idle block row should not leak add/drag buttons: ${JSON.stringify(local, null, 2)}`);
    assert(labels.includes('Add block below') && labels.includes('Open block actions'), `desktop block gutter should keep the expected hidden affordance pair: ${JSON.stringify(local, null, 2)}`);
  }

  if (!target.mobile && target.state === 'hover') {
    assert(gutterVisible, `hovered block gutter should become visible: ${JSON.stringify(local, null, 2)}`);
    assert(labels.includes('Add block below'), `hovered block gutter should expose Add block below: ${JSON.stringify(local, null, 2)}`);
    assert(labels.includes('Open block actions'), `hovered block gutter should expose Open block actions: ${JSON.stringify(local, null, 2)}`);
    assert(visibleButtons.length === 2, `hovered block gutter should expose the compact two-button pair only: ${JSON.stringify(local, null, 2)}`);
    assert(
      local.gutter.rect.right <= local.textColumn.rect.left - 2,
      `hovered block gutter should sit left of text without covering it: ${JSON.stringify(local, null, 2)}`,
    );
  }

  if (!target.mobile && target.state === 'drop') {
    const height = target.placement === 'after'
      ? local.dropIndicator.afterHeight
      : local.dropIndicator.beforeHeight;
    assert(local.dropIndicator.drop === target.placement, `block drag inventory should expose ${target.placement} drop state: ${JSON.stringify(local, null, 2)}`);
    assert(local.row.sourceDragging, `block drag inventory should show the source row dragging state: ${JSON.stringify(local, null, 2)}`);
    assert(height >= 1.5 && height <= 3, `block drag indicator should remain a thin insertion line: ${JSON.stringify(local, null, 2)}`);
  }

  if (target.mobile) {
    assert(local.page.viewportWidth <= 430, `mobile block inventory should run in a narrow viewport: ${JSON.stringify(local, null, 2)}`);
    assert(local.row.rect.left >= -4 && local.row.rect.right <= local.page.viewportWidth + 4, `mobile block row should stay within the viewport: ${JSON.stringify(local, null, 2)}`);
    assert(visibleButtons.length === 0, `mobile idle block row should not show desktop hover buttons as permanent clutter: ${JSON.stringify(local, null, 2)}`);
  }
}

function dragHandle(page, blockId) {
  return blockGroup(page, blockId).getByRole('button', { name: 'Open block actions' });
}

function blockGroup(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

function blockRow(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"] > [data-type]`).first();
}

async function waitForFocusedBlockTextbox(page, blockId, label) {
  await page.waitForFunction(
    ({ blockId: targetBlockId, label: expectedLabel }) => {
      const group = document.querySelector(`[data-block-id="${targetBlockId}"]`);
      if (!group) return false;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !group.contains(active)) return false;
      if (active.getAttribute('role') !== 'textbox') return false;
      return active.getAttribute('aria-label') === expectedLabel;
    },
    { blockId, label },
    { timeout: options.timeoutMs },
  );
}

async function expectDomOrder(page, seed, expectedKeys) {
  const expectedIds = expectedKeys.map((key) => seed.blockIds[key]);
  await page.waitForFunction(
    (ids) => {
      const editor = document.querySelector('[role="region"][aria-label="Page body"]');
      if (!editor) return false;
      const currentIds = Array.from(editor.querySelectorAll('[data-block-id]'))
        .filter((element) => element.getAttribute('data-depth') === '0')
        .map((element) => element.getAttribute('data-block-id'))
        .filter((id) => ids.includes(id));
      return JSON.stringify(currentIds) === JSON.stringify(ids);
    },
    expectedIds,
    { timeout: options.timeoutMs },
  );
}

async function waitForBlockOrder(baseUrl, seed, expectedKeys, label) {
  const expectedIds = expectedKeys.map((key) => seed.blockIds[key]);
  const startedAt = Date.now();
  let lastOrder = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const blocks = await fetchSeedBlocks(baseUrl, seed);
    lastOrder = topLevelOrder(blocks, seed);
    if (JSON.stringify(lastOrder) === JSON.stringify(expectedIds)) return blocks;
    await delay(250);
  }
  throw new Error(`${label} was not persisted; expected=${JSON.stringify(expectedIds)} last=${JSON.stringify(lastOrder)}`);
}

async function waitForBlocks(baseUrl, seed, predicate, label) {
  const startedAt = Date.now();
  let lastBlocks = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    lastBlocks = await fetchSeedBlocks(baseUrl, seed);
    if (predicate(lastBlocks)) return lastBlocks;
    await delay(250);
  }
  throw new Error(`${label} was not persisted for ${seed.pageId}; last blocks=${JSON.stringify(lastBlocks)}`);
}

function topLevelOrder(blocks, seed) {
  const knownIds = new Set(Object.values(seed.blockIds));
  return blocks
    .filter((block) => knownIds.has(block.id) && block.parentId == null)
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map((block) => block.id);
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

async function fetchSeedBlocks(baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'blocks',
    pageId: seed.pageId,
  });
  return Array.isArray(result?.blocks) ? result.blocks : [];
}

async function seedDragPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for block drag UI smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const title = `Block drag smoke ${suffix}`;
  const blockIds = {
    first: randomUUID(),
    middle: randomUUID(),
    last: randomUUID(),
    toggleTarget: randomUUID(),
  };
  const hoverBlocks = [
    { key: 'heading', type: 'heading_1', text: `Heading hover bridge ${suffix}` },
    { key: 'todo', type: 'to_do', text: `Task hover bridge ${suffix}` },
    { key: 'bullet', type: 'bulleted_list_item', text: `Bullet hover bridge ${suffix}` },
    { key: 'quote', type: 'quote', text: `Quote hover bridge ${suffix}` },
    { key: 'callout', type: 'callout', text: `Callout hover bridge ${suffix}` },
    { key: 'divider', type: 'divider', text: '' },
  ].map((block) => ({
    ...block,
    id: randomUUID(),
  }));
  const blockText = {
    first: `First drag block ${suffix}`,
    middle: `Middle drag block ${suffix}`,
    last: `Last drag block ${suffix}`,
    toggleTarget: `Drop into toggle ${suffix}`,
  };

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'block drag UI smoke page must be created');

  const keys = ['first', 'middle', 'last'];
  const blocks = keys.map((key, index) => ({
    id: blockIds[key],
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText[key] }] },
    plainText: blockText[key],
    position: index + 1,
  }));
  blocks.push({
    id: blockIds.toggleTarget,
    pageId,
    parentId: null,
    type: 'toggle',
    content: { rich: [{ text: blockText.toggleTarget }], collapsed: true },
    plainText: blockText.toggleTarget,
    position: keys.length + 1,
  });
  hoverBlocks.forEach((block, index) => {
    blocks.push({
      id: block.id,
      pageId,
      parentId: null,
      type: block.type,
      content: block.type === 'divider' ? {} : { rich: [{ text: block.text }] },
      plainText: block.text,
      position: keys.length + 2 + index,
    });
  });
  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(createdBlocks?.blocks?.length === blocks.length, 'block drag UI smoke blocks must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageId,
    title,
    blockIds,
    hoverBlocks,
    blockText,
    toggleFollowupText: `Typed immediately after toggle drop ${suffix}`,
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
    'Playwright is required for block drag UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/block-drag-ui-smoke.mjs [options]

Checks drag-handle block reordering with DOM and product API persistence
assertions plus screenshot/layout contracts for block hover gutters and drop
indicators. The smoke also checks that representative block gutters remain
hittable while moving from the body to the left controls, then drags the middle
block before the first block and after the last block.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
