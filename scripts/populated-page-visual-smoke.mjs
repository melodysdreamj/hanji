#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'populated-page');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL populated page visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Populated page visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Populated page visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedPopulatedPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertPopulatedPage(browser, appUrl, seed);
    console.log('PASS populated page visual layout is captured and stays within the Notion-style layout contract.');
    console.log(`Screenshot: ${join(options.screenshotDir, 'desktop-populated-page.png')}`);
    console.log(`Dark screenshot: ${join(options.screenshotDir, 'desktop-populated-page-dark.png')}`);
    console.log(`Mobile screenshot: ${join(options.screenshotDir, 'mobile-populated-page.png')}`);
    console.log(`Mobile dark screenshot: ${join(options.screenshotDir, 'mobile-populated-page-dark.png')}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertPopulatedPage(browser, appUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await seedSession(context, seed);

  try {
    await openPage(page, appUrl, seed);
    await assertPopulatedPageVisualContract(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-populated-page.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await assertPopulatedPageVisualContract(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-populated-page-dark.png'),
      fullPage: false,
    });
    await setViewport(page, { width: 390, height: 844 });
    await setTheme(page, 'light');
    await assertMobilePopulatedPageVisualContract(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-populated-page.png'),
      fullPage: false,
    });
    await setTheme(page, 'dark');
    await assertMobilePopulatedPageVisualContract(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'mobile-populated-page-dark.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'populated page visual flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function openPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
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
  await page.getByRole('button', { name: 'Change page icon' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  for (const id of Object.values(seed.blockIds)) {
    await page.locator(`[data-block-id="${id}"]`).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  await expectPageTitle(page, seed.title);
}

async function assertPopulatedPageVisualContract(page, seed) {
  const metrics = await page.evaluate((expected) => {
    const doc = document.querySelector('[data-page-search-root]');
    const scroll = doc?.parentElement;
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const icon = document.querySelector('button[aria-label="Change page icon"]');
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    const starter = document.querySelector('[role="group"][aria-label="Page starter"]');
    const presence = document.querySelector('[data-testid="page-presence"]');
    const topbarIcon = document.querySelector('[data-topbar-crumb-icon]');
    const topbarLabel = document.querySelector('[data-topbar-crumb-label]');
    const shareAction = document.querySelector('[data-topbar-share-action]');
    const commentAction = document.querySelector('[data-topbar-comment-action]');
    const iconActions = Array.from(document.querySelectorAll('[data-topbar-icon-action]'));
    if (
      !(doc instanceof HTMLElement) ||
      !(scroll instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(icon instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(topbarIcon instanceof HTMLElement) ||
      !(topbarLabel instanceof HTMLElement) ||
      !(shareAction instanceof HTMLElement) ||
      !(commentAction instanceof HTMLElement) ||
      iconActions.some((item) => !(item instanceof HTMLElement))
    ) {
      return { ok: false, reason: 'missing populated page visual markers' };
    }

    const blockMetrics = [];
    for (const [key, id] of Object.entries(expected.blockIds)) {
      const group = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      const row = group?.firstElementChild;
      const editable = group?.querySelector('[role="textbox"]');
      if (!(group instanceof HTMLElement) || !(row instanceof HTMLElement) || !(editable instanceof HTMLElement)) {
        return { ok: false, reason: `missing block markers for ${key}` };
      }
      const groupRect = group.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const editableRect = editable.getBoundingClientRect();
      const editableStyle = getComputedStyle(editable);
      blockMetrics.push({
        key,
        type: row.getAttribute('data-type') ?? '',
        text: editable.textContent?.trim() ?? '',
        groupTop: groupRect.top,
        rowTop: rowRect.top,
        rowLeft: rowRect.left,
        rowWidth: rowRect.width,
        rowHeight: rowRect.height,
        editableTop: editableRect.top,
        editableLeft: editableRect.left,
        editableWidth: editableRect.width,
        editableHeight: editableRect.height,
        editableFontSize: Number.parseFloat(editableStyle.fontSize),
        editableLineHeight: Number.parseFloat(editableStyle.lineHeight),
      });
    }

    const titleRect = title.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const docRect = doc.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const iconStyle = getComputedStyle(icon);
    const topbarIconRect = topbarIcon.getBoundingClientRect();
    const topbarLabelRect = topbarLabel.getBoundingClientRect();
    const shareRect = shareAction.getBoundingClientRect();
    const commentRect = commentAction.getBoundingClientRect();
    const shareStyle = getComputedStyle(shareAction);
    const iconActionRects = iconActions.map((item) => item.getBoundingClientRect());
    const iconActionWidths = iconActionRects.map((rect) => rect.width);
    const iconActionHeights = iconActionRects.map((rect) => rect.height);
    const actionCenters = [
      shareRect.top + shareRect.height / 2,
      commentRect.top + commentRect.height / 2,
      ...iconActionRects.map((rect) => rect.top + rect.height / 2),
    ];
    const toDo = document.querySelector(`[data-block-id="${CSS.escape(expected.blockIds.todo)}"] input[type="checkbox"]`);
    const callout = document.querySelector(`[data-block-id="${CSS.escape(expected.blockIds.callout)}"] [class*="callout"]`);
    const quote = document.querySelector(`[data-block-id="${CSS.escape(expected.blockIds.quote)}"] [class*="quote"]`);
    const toDoRect = toDo instanceof HTMLElement ? toDo.getBoundingClientRect() : null;
    const calloutRect = callout instanceof HTMLElement ? callout.getBoundingClientRect() : null;
    const quoteRect = quote instanceof HTMLElement ? quote.getBoundingClientRect() : null;
    return {
      ok: true,
      docWidth: docRect.width,
      scrollTop: scrollRect.top,
      scrollLeft: scrollRect.left,
      titleText: title.textContent?.trim() ?? '',
      titleTop: titleRect.top,
      titleLeft: titleRect.left,
      titleBottom: titleRect.bottom,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      iconTop: iconRect.top,
      iconBottom: iconRect.bottom,
      iconWidth: iconRect.width,
      iconHeight: iconRect.height,
      iconFontSize: Number.parseFloat(iconStyle.fontSize),
      topbarCrumbText: topbarLabel.textContent?.trim() ?? '',
      topbarCrumbIconWidth: topbarIconRect.width,
      topbarCrumbIconHeight: topbarIconRect.height,
      topbarCrumbGap: topbarLabelRect.left - topbarIconRect.right,
      topbarCrumbCenterOffset:
        Math.abs((topbarIconRect.top + topbarIconRect.height / 2) - (topbarLabelRect.top + topbarLabelRect.height / 2)),
      topbarShareText: shareAction.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      topbarShareWidth: shareRect.width,
      topbarShareHeight: shareRect.height,
      topbarShareBorderWidth: Number.parseFloat(shareStyle.borderTopWidth),
      topbarShareBorderColor: shareStyle.borderTopColor,
      topbarCommentWidth: commentRect.width,
      topbarCommentHeight: commentRect.height,
      topbarIconActionCount: iconActionRects.length,
      topbarIconActionMinWidth: Math.min(...iconActionWidths),
      topbarIconActionMaxWidth: Math.max(...iconActionWidths),
      topbarIconActionMinHeight: Math.min(...iconActionHeights),
      topbarIconActionMaxHeight: Math.max(...iconActionHeights),
      topbarActionCenterSpread: Math.max(...actionCenters) - Math.min(...actionCenters),
      bodyTop: bodyRect.top,
      bodyLeft: bodyRect.left,
      bodyWidth: bodyRect.width,
      starterVisible: starter instanceof HTMLElement && starter.offsetParent !== null,
      presenceVisible: presence instanceof HTMLElement,
      toDoWidth: toDoRect?.width ?? 0,
      toDoHeight: toDoRect?.height ?? 0,
      calloutTop: calloutRect?.top ?? 0,
      calloutLeft: calloutRect?.left ?? 0,
      calloutWidth: calloutRect?.width ?? 0,
      calloutHeight: calloutRect?.height ?? 0,
      quoteLeft: quoteRect?.left ?? 0,
      quoteWidth: quoteRect?.width ?? 0,
      blocks: blockMetrics,
    };
  }, {
    blockIds: seed.blockIds,
  });

  assert(metrics.ok, metrics.reason ?? 'populated page visual contract could not run');
  assert(metrics.titleText === seed.title, `populated page title should render seeded title, got "${metrics.titleText}"`);
  assert(
    metrics.topbarCrumbText === seed.title,
    `topbar breadcrumb should expose the current page title text, got "${metrics.topbarCrumbText}"`,
  );
  assert(
    metrics.topbarCrumbIconWidth >= 14 &&
      metrics.topbarCrumbIconWidth <= 18 &&
      metrics.topbarCrumbIconHeight >= 14 &&
      metrics.topbarCrumbIconHeight <= 18,
    `topbar breadcrumb icon should stay compact, got ${Math.round(metrics.topbarCrumbIconWidth)}x${Math.round(metrics.topbarCrumbIconHeight)}`,
  );
  assert(
    metrics.topbarCrumbGap >= 4 && metrics.topbarCrumbGap <= 9,
    `topbar breadcrumb icon/title gap should not look glued or loose, got ${Math.round(metrics.topbarCrumbGap)}px`,
  );
  assert(
    metrics.topbarCrumbCenterOffset <= 2,
    `topbar breadcrumb icon/title should share a visual center, got ${metrics.topbarCrumbCenterOffset}px`,
  );
  assert(
    metrics.topbarShareText === 'Share' &&
      metrics.topbarShareWidth >= 58 &&
      metrics.topbarShareWidth <= 84 &&
      metrics.topbarShareHeight >= 26 &&
      metrics.topbarShareHeight <= 30 &&
      metrics.topbarShareBorderWidth >= 0.5 &&
      metrics.topbarShareBorderColor !== 'rgba(0, 0, 0, 0)',
    `populated page Share action should be a compact bordered pill, got ${JSON.stringify({
      text: metrics.topbarShareText,
      width: Math.round(metrics.topbarShareWidth),
      height: Math.round(metrics.topbarShareHeight),
      borderWidth: metrics.topbarShareBorderWidth,
      borderColor: metrics.topbarShareBorderColor,
    })}`,
  );
  assert(
    metrics.topbarCommentWidth >= 26 &&
      metrics.topbarCommentWidth <= 30 &&
      metrics.topbarCommentHeight >= 26 &&
      metrics.topbarCommentHeight <= 30 &&
      metrics.topbarIconActionCount >= 2 &&
      metrics.topbarIconActionMinWidth >= 27 &&
      metrics.topbarIconActionMaxWidth <= 29 &&
      metrics.topbarIconActionMinHeight >= 27 &&
      metrics.topbarIconActionMaxHeight <= 29 &&
      metrics.topbarActionCenterSpread <= 1,
    `populated page topbar actions should keep Comment icon-sized and aligned, got ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.docWidth <= 960,
    `populated page should stay inside a document-width column, got ${Math.round(metrics.docWidth)}px`,
  );
  assert(
    metrics.iconWidth >= 70 && metrics.iconWidth <= 92 && metrics.iconHeight >= 70 && metrics.iconHeight <= 92,
    `populated page icon should render at page-icon scale, got ${Math.round(metrics.iconWidth)}x${Math.round(metrics.iconHeight)}`,
  );
  assert(
    metrics.iconFontSize >= 64,
    `populated page emoji icon should not render at body-text size, got ${metrics.iconFontSize}px`,
  );
  assert(
    metrics.titleTop - metrics.scrollTop >= 130 && metrics.titleTop - metrics.scrollTop <= 205,
    `populated page title should sit near the document top after the icon, got ${Math.round(metrics.titleTop - metrics.scrollTop)}px`,
  );
  assert(
    metrics.titleLeft - metrics.scrollLeft >= 200 && metrics.titleLeft - metrics.scrollLeft <= 280,
    `populated page title should align with the document text column, got ${Math.round(metrics.titleLeft - metrics.scrollLeft)}px from content left`,
  );
  assert(
    metrics.titleFontSize >= 36 && metrics.titleFontSize <= 48,
    `populated page title should stay page-title scale, got ${metrics.titleFontSize}px`,
  );
  assert(
    metrics.iconBottom <= metrics.titleTop + 10,
    `populated page icon should sit above the title without overlap, iconBottom=${metrics.iconBottom} titleTop=${metrics.titleTop}`,
  );
  assert(metrics.starterVisible === false, 'populated page should not show the empty-page starter');
  assert(metrics.presenceVisible === false, 'populated page should not show a floating presence badge for the current user alone');

  const blocks = Object.fromEntries(metrics.blocks.map((block) => [block.key, block]));
  const requiredTypes = {
    heading: 'heading_2',
    paragraph: 'paragraph',
    bullet: 'bulleted_list_item',
    todo: 'to_do',
    quote: 'quote',
    callout: 'callout',
  };
  for (const [key, type] of Object.entries(requiredTypes)) {
    assert(blocks[key]?.type === type, `expected ${key} block to render as ${type}, got ${blocks[key]?.type}`);
  }

  const first = blocks.heading;
  assert(
    first.groupTop - metrics.titleBottom >= 16 && first.groupTop - metrics.titleBottom <= 86,
    `first populated block should follow the title in document flow, got ${Math.round(first.groupTop - metrics.titleBottom)}px gap`,
  );
  const textOffsets = {
    heading: [0, 4],
    paragraph: [0, 4],
    bullet: [24, 34],
    todo: [24, 36],
    quote: [14, 24],
    callout: [44, 58],
  };
  for (const block of metrics.blocks) {
    const [minOffset, maxOffset] = textOffsets[block.key] ?? [0, 58];
    const textOffset = block.editableLeft - metrics.titleLeft;
    assert(
      textOffset >= minOffset && textOffset <= maxOffset,
      `${block.key} text should align on its expected block column, got ${Math.round(textOffset)}px from title`,
    );
    assert(
      block.rowWidth >= 560 && block.rowWidth <= 760,
      `${block.key} row should stay within the document column, got ${Math.round(block.rowWidth)}px`,
    );
    assert(
      block.rowHeight >= 24 && block.rowHeight <= 92,
      `${block.key} row height should stay within Notion-density bounds, got ${Math.round(block.rowHeight)}px`,
    );
  }
  assert(
    blocks.heading.editableFontSize >= 22 && blocks.heading.editableFontSize <= 28,
    `heading block should be a compact H2, got ${blocks.heading.editableFontSize}px`,
  );
  assert(
    blocks.paragraph.editableFontSize >= 15 && blocks.paragraph.editableFontSize <= 17,
    `paragraph block should be body text scale, got ${blocks.paragraph.editableFontSize}px`,
  );
  assert(
    blocks.paragraph.groupTop > blocks.heading.groupTop &&
      blocks.bullet.groupTop > blocks.paragraph.groupTop &&
      blocks.todo.groupTop > blocks.bullet.groupTop &&
      blocks.quote.groupTop > blocks.todo.groupTop &&
      blocks.callout.groupTop > blocks.quote.groupTop,
    'populated blocks should keep their seeded vertical order',
  );
  assert(
    metrics.toDoWidth >= 14 && metrics.toDoWidth <= 20 && metrics.toDoHeight >= 14 && metrics.toDoHeight <= 20,
    `to-do checkbox should stay compact, got ${Math.round(metrics.toDoWidth)}x${Math.round(metrics.toDoHeight)}`,
  );
  assert(
    metrics.quoteWidth >= 500 && metrics.quoteWidth <= 760 && Math.abs(metrics.quoteLeft - metrics.titleLeft) <= 3,
    `quote block should stay aligned in the text column, got left=${Math.round(metrics.quoteLeft)} width=${Math.round(metrics.quoteWidth)}`,
  );
  assert(
    metrics.calloutWidth >= 500 &&
      metrics.calloutWidth <= 760 &&
      metrics.calloutHeight >= 44 &&
      metrics.calloutHeight <= 90 &&
      Math.abs(metrics.calloutLeft - metrics.titleLeft) <= 3,
    `callout should stay compact in the document column, got left=${Math.round(metrics.calloutLeft)} size=${Math.round(metrics.calloutWidth)}x${Math.round(metrics.calloutHeight)}`,
  );
}

async function assertMobilePopulatedPageVisualContract(page, seed) {
  const metrics = await page.evaluate((expected) => {
    const doc = document.querySelector('[data-page-search-root]');
    const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
    const icon = document.querySelector('button[aria-label="Change page icon"]');
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    const controls = document.querySelector('[role="toolbar"][aria-label="Page options"]');
    const topbar = document.querySelector('header');
    const hamburger = document.querySelector('button[aria-label="Open sidebar"], button[aria-label="Close sidebar"]');
    const sidebar = document.querySelector('[aria-label="Sidebar"]');
    const shareAction = document.querySelector('[data-topbar-share-action]');
    const commentAction = document.querySelector('[data-topbar-comment-action]');
    const topbarIconActions = Array.from(document.querySelectorAll('[data-topbar-icon-action]'));
    if (
      !(doc instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(icon instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(controls instanceof HTMLElement) ||
      !(topbar instanceof HTMLElement) ||
      !(hamburger instanceof HTMLElement) ||
      !(shareAction instanceof HTMLElement) ||
      !(commentAction instanceof HTMLElement) ||
      topbarIconActions.some((item) => !(item instanceof HTMLElement))
    ) {
      return { ok: false, reason: 'missing mobile populated page visual markers' };
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
    const controlRows = Array.from(controls.querySelectorAll('button')).map((button) => {
      const label = button.querySelector('span');
      const buttonRect = rect(button);
      const labelRect = label instanceof HTMLElement ? rect(label) : null;
      return {
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        buttonLeft: buttonRect.left,
        buttonRight: buttonRect.right,
        buttonWidth: buttonRect.width,
        buttonHeight: buttonRect.height,
        labelClientWidth: label instanceof HTMLElement ? label.clientWidth : 0,
        labelScrollWidth: label instanceof HTMLElement ? label.scrollWidth : 0,
        labelHeight: labelRect?.height ?? 0,
      };
    });
    const blockMetrics = [];
    for (const [key, id] of Object.entries(expected.blockIds)) {
      const group = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      const row = group?.firstElementChild;
      const editable = group?.querySelector('[role="textbox"]');
      if (!(group instanceof HTMLElement) || !(row instanceof HTMLElement) || !(editable instanceof HTMLElement)) {
        return { ok: false, reason: `missing mobile block markers for ${key}` };
      }
      const rowRect = rect(row);
      const editableRect = rect(editable);
      blockMetrics.push({
        key,
        rowLeft: rowRect.left,
        rowRight: rowRect.right,
        rowWidth: rowRect.width,
        rowHeight: rowRect.height,
        editableLeft: editableRect.left,
        editableRight: editableRect.right,
        editableWidth: editableRect.width,
      });
    }

    const titleRect = rect(title);
    const iconRect = rect(icon);
    const bodyRect = rect(body);
    const docRect = rect(doc);
    const controlsRect = rect(controls);
    const topbarRect = rect(topbar);
    const hamburgerRect = rect(hamburger);
    const sidebarRect = sidebar instanceof HTMLElement ? rect(sidebar) : null;
    const shareRect = rect(shareAction);
    const commentRect = rect(commentAction);
    const iconActionRects = topbarIconActions.map(rect);
    const titleStyle = getComputedStyle(title);
    const iconStyle = getComputedStyle(icon);
    const controlsStyle = getComputedStyle(controls);
    const actionCenters = [
      shareRect.top + shareRect.height / 2,
      commentRect.top + commentRect.height / 2,
      ...iconActionRects.map((item) => item.top + item.height / 2),
    ];

    return {
      ok: true,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      topbarLeft: topbarRect.left,
      topbarRight: topbarRect.right,
      topbarHeight: topbarRect.height,
      hamburgerWidth: hamburgerRect.width,
      hamburgerHeight: hamburgerRect.height,
      mobileSidebarOpen: sidebar instanceof HTMLElement ? sidebar.getAttribute('data-open') === 'true' : false,
      mobileSidebarRight: sidebarRect?.right ?? 0,
      shareText: shareAction.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      shareRight: shareRect.right,
      shareWidth: shareRect.width,
      shareHeight: shareRect.height,
      commentWidth: commentRect.width,
      commentHeight: commentRect.height,
      iconActionCount: iconActionRects.length,
      iconActionMinWidth: Math.min(...iconActionRects.map((item) => item.width)),
      iconActionMaxWidth: Math.max(...iconActionRects.map((item) => item.width)),
      actionCenterSpread: Math.max(...actionCenters) - Math.min(...actionCenters),
      docLeft: docRect.left,
      docRight: docRect.right,
      docWidth: docRect.width,
      controlsLeft: controlsRect.left,
      controlsRight: controlsRect.right,
      controlsWidth: controlsRect.width,
      controlsOpacity: Number.parseFloat(controlsStyle.opacity),
      titleText: title.textContent?.trim() ?? '',
      titleLeft: titleRect.left,
      titleRight: titleRect.right,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      iconLeft: iconRect.left,
      iconRight: iconRect.right,
      iconWidth: iconRect.width,
      iconHeight: iconRect.height,
      iconFontSize: Number.parseFloat(iconStyle.fontSize),
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      bodyWidth: bodyRect.width,
      controls: controlRows,
      blocks: blockMetrics,
    };
  }, {
    blockIds: seed.blockIds,
  });

  assert(metrics.ok, metrics.reason ?? 'mobile populated page visual contract could not run');
  assert(metrics.viewportWidth <= 430, `mobile populated page should run in a narrow viewport, got ${metrics.viewportWidth}px`);
  assert(
    Math.max(metrics.bodyWidth, metrics.documentWidth) <= metrics.viewportWidth + 4,
    `mobile populated page should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.topbarLeft >= 0 &&
      metrics.topbarRight <= metrics.viewportWidth + 1 &&
      metrics.topbarHeight >= 42 &&
      metrics.topbarHeight <= 48,
    `mobile topbar should fit as one compact rail: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.hamburgerWidth >= 28 &&
      metrics.hamburgerWidth <= 34 &&
      metrics.hamburgerHeight >= 28 &&
      metrics.hamburgerHeight <= 34,
    `mobile topbar hamburger should stay compact: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.mobileSidebarOpen === false && metrics.mobileSidebarRight <= 4,
    `closed mobile sidebar should not overlap the document screenshot: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.shareText === 'Share' &&
      metrics.shareWidth >= 58 &&
      metrics.shareWidth <= 84 &&
      metrics.shareHeight >= 26 &&
      metrics.shareHeight <= 30 &&
      metrics.shareRight <= metrics.viewportWidth - 32,
    `mobile Share action should stay visible and compact beside icon actions: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.commentWidth >= 26 &&
      metrics.commentWidth <= 30 &&
      metrics.commentHeight >= 26 &&
      metrics.commentHeight <= 30 &&
      metrics.iconActionCount >= 2 &&
      metrics.iconActionMinWidth >= 27 &&
      metrics.iconActionMaxWidth <= 29 &&
      metrics.actionCenterSpread <= 1,
    `mobile topbar actions should collapse labels and align as one rail: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.docLeft >= -1 &&
      metrics.docRight <= metrics.viewportWidth + 1 &&
      metrics.docWidth >= metrics.viewportWidth - 2 &&
      metrics.docWidth <= metrics.viewportWidth + 2,
    `mobile document should use the viewport-width document shell: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.titleLeft >= 22 &&
      metrics.titleLeft <= 28 &&
      metrics.bodyLeft >= 22 &&
      metrics.bodyLeft <= 28 &&
      Math.abs(metrics.titleLeft - metrics.bodyLeft) <= 1,
    `mobile title and body should share the same narrow document gutter: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.controlsLeft >= 22 &&
      metrics.controlsRight <= metrics.viewportWidth - 22 &&
      metrics.controlsWidth <= metrics.viewportWidth - 44,
    `mobile page option controls should stay inside the document gutter: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.controlsOpacity <= 0.25,
    `mobile populated page option controls should stay hidden in idle visual evidence: ${JSON.stringify(metrics)}`,
  );
  for (const control of metrics.controls) {
    assert(control.buttonHeight >= 22 && control.buttonHeight <= 26, `mobile page option control height drifted: ${JSON.stringify(control)}`);
    assert(control.labelScrollWidth <= control.labelClientWidth + 1, `mobile page option label should not clip: ${JSON.stringify(control)}`);
    assert(control.labelHeight <= 20, `mobile page option label should stay on one line: ${JSON.stringify(control)}`);
  }
  assert(
    metrics.iconWidth >= 70 &&
      metrics.iconWidth <= 92 &&
      metrics.iconHeight >= 70 &&
      metrics.iconHeight <= 92 &&
      metrics.iconFontSize >= 64,
    `mobile populated page icon should stay at page-icon scale: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.titleFontSize >= 34 &&
      metrics.titleFontSize <= 44 &&
      metrics.titleRight <= metrics.viewportWidth - 22,
    `mobile populated page title should stay page-scale without overflowing: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.bodyRight <= metrics.viewportWidth - 22 &&
      metrics.bodyWidth >= metrics.viewportWidth - 56 &&
      metrics.bodyWidth <= metrics.viewportWidth - 44,
    `mobile populated page body should stay inside the document column: ${JSON.stringify(metrics)}`,
  );
  for (const block of metrics.blocks) {
    assert(block.rowLeft >= 6 && block.rowRight <= metrics.viewportWidth - 6, `mobile block row should stay inside the viewport: ${JSON.stringify(block)}`);
    assert(block.editableRight <= metrics.viewportWidth - 22, `mobile block text should stay inside the document gutter: ${JSON.stringify(block)}`);
    assert(block.rowHeight >= 24 && block.rowHeight <= 112, `mobile block row height should stay within density bounds: ${JSON.stringify(block)}`);
  }
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

async function seedPopulatedPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for populated page visual smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const title = `Populated visual ${suffix}`;
  const blockIds = {
    heading: randomUUID(),
    paragraph: randomUUID(),
    bullet: randomUUID(),
    todo: randomUUID(),
    quote: randomUUID(),
    callout: randomUUID(),
  };
  const blocks = [
    {
      id: blockIds.heading,
      pageId,
      parentId: null,
      type: 'heading_2',
      content: { rich: [{ text: 'Project summary' }] },
      plainText: 'Project summary',
      position: 1,
    },
    {
      id: blockIds.paragraph,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: {
        rich: [
          { text: 'This populated page checks body copy density, ' },
          { text: 'rich inline emphasis', bold: true },
          { text: ', and document column alignment.' },
        ],
      },
      plainText: 'This populated page checks body copy density, rich inline emphasis, and document column alignment.',
      position: 2,
    },
    {
      id: blockIds.bullet,
      pageId,
      parentId: null,
      type: 'bulleted_list_item',
      content: { rich: [{ text: 'Sidebar, title, and block rows should feel like one system.' }] },
      plainText: 'Sidebar, title, and block rows should feel like one system.',
      position: 3,
    },
    {
      id: blockIds.todo,
      pageId,
      parentId: null,
      type: 'to_do',
      content: { rich: [{ text: 'Keep visual issues as testable findings.' }], checked: false },
      plainText: 'Keep visual issues as testable findings.',
      position: 4,
    },
    {
      id: blockIds.quote,
      pageId,
      parentId: null,
      type: 'quote',
      content: { rich: [{ text: 'A page can load and still feel unfinished.' }] },
      plainText: 'A page can load and still feel unfinished.',
      position: 5,
    },
    {
      id: blockIds.callout,
      pageId,
      parentId: null,
      type: 'callout',
      content: { rich: [{ text: 'This fixture turns first-impression awkwardness into a repeatable check.' }], icon: '✨' },
      plainText: 'This fixture turns first-impression awkwardness into a repeatable check.',
      position: 6,
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
    icon: '🧭',
    iconType: 'emoji',
    cover: '',
    coverPosition: 50,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'populated page visual smoke page must be created');
  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(createdBlocks?.blocks?.length === blocks.length, 'populated page visual smoke blocks must be created');

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
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, { call: callFunction }).catch(() => {});
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', 'light');
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function setTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem('hanji:theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.waitForTimeout(100);
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
    'Playwright is required for populated page visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/populated-page-visual-smoke.mjs [options]

Captures a seeded populated page and checks Notion-style title/icon/body-block
layout contracts in light and dark themes.

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
