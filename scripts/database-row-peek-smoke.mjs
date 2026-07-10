#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database row peek smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database row peek smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    if (options.onlyRowSelect) {
      await assertRowSelectMenuUi(browser, baseUrl, seed);
      console.log('PASS row detail multi-select menu clicks update selected chips.');
    } else if (options.onlyMenuDismissAudit) {
      await assertMenuDismissAuditUi(browser, baseUrl, seed);
      console.log('PASS database row peek menu outside-click dismissal audit.');
    } else if (options.onlyInlinePropertySelect) {
      await assertInlinePropertySelectUi(browser, baseUrl, seed);
      console.log('PASS row peek inline database relation property select dismisses cleanly.');
    } else if (options.onlyRowPeekMotion) {
      await assertRowPeekMotionUi(browser, baseUrl, seed);
      console.log('PASS row side peek opens and closes with Notion-like slide motion.');
    } else {
      await assertRowPeekUi(browser, baseUrl, seed);
      console.log('PASS database rows open in side/center peek modes, use a plain body-loading fallback, hydrate relation target chips, survive direct p= row URLs, keep inline row peek history/back behavior, navigate rows, and switch to full-page opening.');
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertRowSelectMenuUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertSidePeek(page, seed);
    assertNoBrowserErrors(errors, 'row detail multi-select menu flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertRowPeekMotionUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await assertRowPeekOpenCloseMotion(page, seed);
    assertNoBrowserErrors(errors, 'row side peek motion flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertInlinePropertySelectUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?p=${seed.rowTwoId}&pm=s`), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    try {
      await assertPeekMode(page, seed.rowTwoTitle, 'side');
    } catch (error) {
      const state = await page.evaluate(() => ({
        url: window.location.href,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((node) => ({
          label: node.getAttribute('aria-label'),
          mode: node instanceof HTMLElement ? node.getAttribute('data-mode') : null,
          text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
          visible: node instanceof HTMLElement && node.offsetParent !== null,
        })),
        bodyText: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 500),
      }));
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`direct row peek URL did not open rowTwo in side mode: ${message}; state=${JSON.stringify(state)}`);
    }
    await assertNestedInlineRelationPropertySelectDismiss(page, seed);
    assertNoBrowserErrors(errors, 'row peek inline relation property select flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertMenuDismissAuditUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?p=${seed.rowTwoId}&pm=s`), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await assertPeekMode(page, seed.rowTwoTitle, 'side');
    await assertNestedInlineDatabaseRendered(page, seed);

    const audit = [];
    audit.push(await assertRowPeekToolbarMenuDismiss(page, seed, {
      triggerName: 'Filter',
      surfaceRole: 'dialog',
      surfaceName: 'Filters',
      label: 'inline row-peek filter toolbar menu',
    }));
    audit.push(await assertRowPeekViewActionMenuDismiss(page, seed));
    audit.push(await assertBoardGroupMenuDismiss(page, baseUrl, seed));

    const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-peek-menu-dismiss-audit');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'menu-dismiss-audit.json'),
      `${JSON.stringify(audit, null, 2)}\n`,
    );
    await page.screenshot({
      path: join(artifactDir, 'menu-dismiss-audit.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'database row peek menu dismiss audit');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertRowPeekUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await assertDatabaseRowsIncludeRelationTargets(baseUrl, seed);
    await openDatabase(page, baseUrl, seed);
    await assertSidePeek(page, seed);
    await assertDirectPeekUrl(page, baseUrl, seed);
    await assertRowNavigation(page, seed);
    await assertNestedInlineRowPeek(page, seed);
    await closeRowPeek(page, seed.rowTwoTitle);
    await assertInlineRowPeekHistory(page, baseUrl, seed);
    await assertNonTableViewRowPeek(page, baseUrl, seed, {
      label: 'Board',
      viewId: seed.boardViewId,
      rowTitle: seed.rowOneTitle,
      rowId: seed.rowOneId,
      mode: 'side',
    });
    await assertNonTableViewRowPeek(page, baseUrl, seed, {
      label: 'List',
      viewId: seed.listViewId,
      rowTitle: seed.rowTwoTitle,
      rowId: seed.rowTwoId,
      mode: 'side',
    });
    await assertNonTableViewRowPeek(page, baseUrl, seed, {
      label: 'Gallery',
      viewId: seed.galleryViewId,
      rowTitle: seed.rowOneTitle,
      rowId: seed.rowOneId,
      mode: 'center',
    });
    await assertNonTableViewRowPeek(page, baseUrl, seed, {
      label: 'Calendar',
      viewId: seed.calendarViewId,
      rowTitle: seed.rowTwoTitle,
      rowId: seed.rowTwoId,
      mode: 'center',
    });
    await assertNonTableViewRowPeek(page, baseUrl, seed, {
      label: 'Timeline',
      viewId: seed.timelineViewId,
      rowTitle: seed.rowOneTitle,
      rowId: seed.rowOneId,
      mode: 'side',
    });
    await openDatabaseView(page, baseUrl, seed, { label: 'Table', viewId: seed.tableViewId });
    await setOpenPagesIn(page, 'Center');
    await openRow(page, seed.rowOneTitle);
    await assertPeekMode(page, seed.rowOneTitle, 'center');
    await closeRowPeek(page, seed.rowOneTitle);
    await setOpenPagesIn(page, 'Full');
    await openRow(page, seed.rowOneTitle);
    await page.waitForFunction(
      (rowId) => window.location.pathname === `/p/${rowId}`,
      seed.rowOneId,
      { timeout: options.timeoutMs },
    );
    await page.getByRole('textbox', { name: 'Page title' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await assertNoRowPeek(page);
    assertNoBrowserErrors(errors, 'database row peek UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertSidePeek(page, seed) {
  const delayedBlocks = await delayRowBlocksLoad(page, seed.rowOneId);
  try {
    await openRow(page, seed.rowOneTitle);
    await withTimeout(
      delayedBlocks.matched,
      options.timeoutMs,
      `row peek should request body blocks for ${seed.rowOneTitle}`,
    );
    await assertPeekMode(page, seed.rowOneTitle, 'side');
    await page.getByRole('separator', { name: 'Resize side preview' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await assertRowPeekUrl(page, seed.rowOneId);
    await assertRowPeekModeParam(page, 's');
    await page.waitForFunction(
      (rowTitle) => {
        const dialog = findRowPeekDialog(rowTitle);
        return !!dialog?.querySelector('[aria-label="Loading page body"][aria-busy="true"]');

        function findRowPeekDialog(title) {
          return Array.from(document.querySelectorAll('[role="dialog"]')).find(
            (node) => node.getAttribute('aria-label') === `${title} preview`,
          );
        }
      },
      seed.rowOneTitle,
      { timeout: options.timeoutMs },
    );

    const loadingState = await collectRowPeekBodyState(page, seed.rowOneTitle);
    assert(
      loadingState.hasBodyLoadingFallback,
      `row peek should expose a page-body loading state while blocks load: ${JSON.stringify(loadingState)}`,
    );
    assert(
      !loadingState.hasEditorLoadingDatabase,
      `row peek body loading should not render the editor-level fake database skeleton: ${JSON.stringify(loadingState)}`,
    );
    assert(
      !loadingState.hasUntitledVisible,
      `row peek body loading should not flash an Untitled inline database title: ${JSON.stringify(loadingState)}`,
    );

    delayedBlocks.release();
    await waitForRowPeekEmptyBodyPrompt(page, seed.rowOneTitle);
    await assertRowLongTextProperties(page, seed);
    await assertRowPropertyValue(page, seed.rowOneTitle, seed.amountPropId, {
      label: 'Amount',
      includes: ['0'],
      excludes: ['Empty'],
    });
    await assertRowPropertyValue(page, seed.rowOneTitle, seed.relationPropId, {
      label: 'Related',
      includes: [seed.relatedTitle],
      excludes: ['Empty'],
      relationLoading: false,
      relationMissing: false,
    });
    await assertRowMultiSelectOptionInteraction(page, seed);
    await assertRowPropertyMenu(page, seed.rowOneTitle, seed.amountPropId, 'Amount');
    await captureRelationResolvedArtifact(page, seed);
  } finally {
    delayedBlocks.release();
    await delayedBlocks.cleanup();
  }
}

async function assertRowPeekOpenCloseMotion(page, seed) {
  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-peek-motion');
  mkdirSync(artifactDir, { recursive: true });
  const before = await collectRowPeekMotionState(page);
  assert(!before.present, `row peek should start closed for motion check: ${JSON.stringify(before)}`);

  await openRow(page, seed.rowOneTitle);
  const openingSamples = await collectRowPeekMotionSamples(page);
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-row-peek-panel]');
      if (!(panel instanceof HTMLElement)) return false;
      const rect = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return (
        panel.getAttribute('data-motion-state') === 'open' &&
        panel.getAttribute('data-mode') === 'side' &&
        Math.abs(rect.right - window.innerWidth) <= 2 &&
        Number.parseFloat(style.opacity) >= 0.99
      );
    },
    null,
    { timeout: options.timeoutMs },
  );
  const opened = await collectRowPeekMotionState(page);
  assert(opened.present, `row peek should be present after opening: ${JSON.stringify(opened)}`);
  assert(opened.motionState === 'open', `row peek should settle to open state: ${JSON.stringify(opened)}`);
  assert(opened.mode === 'side', `motion check should use side peek mode: ${JSON.stringify(opened)}`);
  assert(opened.panelRight <= opened.viewportWidth + 2, `opened side peek should end flush right: ${JSON.stringify(opened)}`);

  if (!opened.reducedMotion) {
    const opening = openingSamples.find(
      (sample) =>
        sample.present &&
        sample.panelLeft > opened.panelLeft + 12 &&
        sample.panelLeft <= opened.viewportWidth + 2,
    );
    assert(
      opening,
      `row side peek should have an intermediate opening slide frame: ${JSON.stringify({ opened, openingSamples })}`,
    );
  }

  await page.screenshot({
    path: join(artifactDir, 'row-side-peek-opened.png'),
    fullPage: false,
  });

  await page.locator('[data-row-peek-close="side-rail"]').click({ timeout: options.timeoutMs });
  const closingSamples = await collectRowPeekMotionSamples(page);
  const closing = closingSamples.find(
    (sample) =>
      sample.present &&
      sample.motionState === 'closing' &&
      sample.panelLeft > opened.panelLeft + 12 &&
      sample.panelLeft <= opened.viewportWidth + 2,
  );
  if (!opened.reducedMotion) {
    assert(
      closing,
      `row side peek should have an intermediate closing slide frame: ${JSON.stringify({ opened, closingSamples })}`,
    );
  }
  await page.waitForFunction(
    () => !document.querySelector('[data-row-peek-panel]'),
    null,
    { timeout: options.timeoutMs },
  );
  const closed = await collectRowPeekMotionState(page);
  assert(!closed.present, `row peek should unmount after close animation: ${JSON.stringify(closed)}`);
  await page.waitForFunction(
    () => {
      const url = new URL(window.location.href);
      return !url.searchParams.has('p') && !url.searchParams.has('pm');
    },
    null,
    { timeout: options.timeoutMs },
  );

  await page.screenshot({
    path: join(artifactDir, 'row-side-peek-closed.png'),
    fullPage: false,
  });
  writeFileSync(
    join(artifactDir, 'row-side-peek-motion.json'),
    `${JSON.stringify({ before, openingSamples, opened, closingSamples, closing, closed }, null, 2)}\n`,
  );
}

async function collectRowPeekMotionSamples(page, sampleCount = 10, intervalMs = 28) {
  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    if (i > 0) await page.waitForTimeout(intervalMs);
    samples.push(await collectRowPeekMotionState(page));
  }
  return samples;
}

async function collectRowPeekMotionState(page) {
  return await page.evaluate(() => {
    const panel = document.querySelector('[data-row-peek-panel]');
    const backdrop = document.querySelector('[data-row-peek-backdrop]');
    const panelRect = panel instanceof HTMLElement ? panel.getBoundingClientRect() : null;
    const panelStyle = panel instanceof HTMLElement ? getComputedStyle(panel) : null;
    const backdropStyle = backdrop instanceof HTMLElement ? getComputedStyle(backdrop) : null;
    const url = new URL(window.location.href);
    return {
      present: panel instanceof HTMLElement,
      viewportWidth: window.innerWidth,
      mode: panel instanceof HTMLElement ? panel.getAttribute('data-mode') : null,
      motionState: panel instanceof HTMLElement ? panel.getAttribute('data-motion-state') : null,
      panelWidth: panelRect?.width ?? null,
      panelLeft: panelRect?.left ?? null,
      panelRight: panelRect?.right ?? null,
      panelOpacity: panelStyle ? Number.parseFloat(panelStyle.opacity) : null,
      panelTransform: panelStyle?.transform ?? null,
      panelTransitionProperty: panelStyle?.transitionProperty ?? '',
      panelTransitionDuration: panelStyle?.transitionDuration ?? '',
      backdropPresent: backdrop instanceof HTMLElement,
      backdropMotionState: backdrop instanceof HTMLElement ? backdrop.getAttribute('data-motion-state') : null,
      backdropOpacity: backdropStyle ? Number.parseFloat(backdropStyle.opacity) : null,
      rowParam: url.searchParams.get('p'),
      modeParam: url.searchParams.get('pm'),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });
}

async function captureRelationResolvedArtifact(page, seed) {
  const dir = join(root, '.edgebase', 'ui-discovery', 'row-relation-loading');
  mkdirSync(dir, { recursive: true });
  const state = await page.evaluate(
    ({ rowTitle, relationPropId }) => {
      const dialog = findRowPeekDialog(rowTitle);
      const row = dialog?.querySelector(`[data-row-property-id="${cssString(relationPropId)}"]`);
      const label = row?.querySelector('[data-row-property-label]');
      const value = row?.querySelector('[class*="rowPropertyValue"]');
      const chips = Array.from(row?.querySelectorAll('[data-row-relation-chip]') ?? []);
      return {
        rowTitle,
        label: (label?.innerText ?? label?.textContent ?? '').trim(),
        value: (value?.innerText ?? value?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        relationChipCount: chips.length,
        relationLoading: !!row?.querySelector('[data-row-relation-loading]'),
        relationMissing: !!row?.querySelector('[data-row-relation-missing]'),
        relationShowsEmpty: (value?.innerText ?? value?.textContent ?? '').includes('Empty'),
      };

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }

      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    { rowTitle: seed.rowOneTitle, relationPropId: seed.relationPropId },
  );
  writeFileSync(
    join(dir, 'local-row-relation-loaded.json'),
    `${JSON.stringify(
      {
        ...state,
        databaseId: seed.databaseId,
        rowId: seed.rowOneId,
        relatedRowId: seed.relatedRowId,
        relatedTitle: seed.relatedTitle,
      },
      null,
      2,
    )}\n`,
  );
  await page.screenshot({
    path: join(dir, 'local-row-relation-loaded.png'),
    fullPage: false,
  });
}

async function waitForRowPeekEmptyBodyPrompt(page, rowTitle) {
  try {
    await page.waitForFunction(
      (title) => {
        const dialog = findRowPeekDialog(title);
        const editor = dialog?.querySelector('[data-editor-page][data-empty-body-prompt-visible="true"]');
        const placeholder = editor?.querySelector(
          '[role="textbox"][data-empty="true"][data-page-placeholder="true"]',
        );
        if (!(placeholder instanceof HTMLElement)) return false;
        if (placeholder.getAttribute('aria-placeholder') !== 'Press Enter to continue with an empty page.') {
          return false;
        }
        const beforeContent = window.getComputedStyle(placeholder, '::before').content;
        return beforeContent.includes('Press Enter to continue with an empty page.');

        function findRowPeekDialog(dialogTitle) {
          return Array.from(document.querySelectorAll('[role="dialog"]')).find(
            (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
          );
        }
      },
      rowTitle,
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const state = await collectRowPeekBodyState(page, rowTitle).catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `row peek empty body prompt did not appear after blocks loaded: ${message}; state=${JSON.stringify(state)}`,
    );
  }
}

async function assertDatabaseRowsIncludeRelationTargets(baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'databaseRows',
    databaseId: seed.databaseId,
    includeRelationTargets: true,
    limit: 2,
  });
  assert(
    result?.relatedPages?.some((page) => page.id === seed.relatedRowId && page.title === seed.relatedTitle),
    `databaseRows should return relation target pages for row-detail chips: ${JSON.stringify(result?.relatedPages ?? [])}`,
  );
  assert(
    result?.relationTargetIds?.includes(seed.relatedRowId),
    `databaseRows should mark relation target ids as hydrated: ${JSON.stringify(result?.relationTargetIds ?? [])}`,
  );
}

async function assertDirectPeekUrl(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?p=${seed.rowOneId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await assertPeekMode(page, seed.rowOneTitle, 'side');
  await assertRowPeekUrl(page, seed.rowOneId);
}

async function assertRowNavigation(page, seed) {
  const dialog = await rowPeekDialog(page, seed.rowOneTitle);
  await dialog.focus({ timeout: options.timeoutMs });
  await page.keyboard.press('Alt+ArrowDown');
  await assertPeekMode(page, seed.rowTwoTitle, 'side');
  await assertRowPeekUrl(page, seed.rowTwoId);
  await assertRowPeekModeParam(page, 's');
  await assertRowPropertyValue(page, seed.rowTwoTitle, seed.amountPropId, {
    label: 'Amount',
    includes: ['Empty'],
    excludes: ['0'],
  });
}

async function assertNestedInlineRowPeek(page, seed) {
  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-peek-nested-inline');
  mkdirSync(artifactDir, { recursive: true });
  await rowPeekDialog(page, seed.rowTwoTitle);
  await page.waitForFunction(
    ({ outerTitle, nestedTitle }) => {
      const outer = findRowPeekDialog(outerTitle);
      return Array.from(outer?.querySelectorAll('input') ?? []).some(
        (input) => input instanceof HTMLInputElement && input.value === nestedTitle && input.offsetParent !== null,
      );

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }
    },
    { outerTitle: seed.rowTwoTitle, nestedTitle: seed.nestedRowTitle },
    { timeout: options.timeoutMs },
  );

  const before = await collectNestedInlineRowPeekState(page, seed);
  const target = await page.evaluate(
    ({ outerTitle, nestedTitle }) => {
      const outer = findRowPeekDialog(outerTitle);
      const rows = Array.from(outer?.querySelectorAll('[data-table-row-id]') ?? []);
      const row = rows.find((candidate) =>
        Array.from(candidate.querySelectorAll('input')).some(
          (input) => input instanceof HTMLInputElement && input.value === nestedTitle,
        ),
      );
      const button = row?.querySelector('[data-table-row-open]');
      if (!(row instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
      // The nested inline database can sit below the fold when the row detail
      // above it grows; hover coordinates are only meaningful in-viewport.
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rowRect = row.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        hoverX: Math.round(rowRect.left + Math.min(Math.max(rowRect.width / 2, 24), 320)),
        hoverY: Math.round(rowRect.top + rowRect.height / 2),
        x: Math.round(buttonRect.left + buttonRect.width / 2),
        y: Math.round(buttonRect.top + buttonRect.height / 2),
        buttonText: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      };

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }
    },
    { outerTitle: seed.rowTwoTitle, nestedTitle: seed.nestedRowTitle },
  );
  assert(target, `nested inline database row open button should be available for ${seed.nestedRowTitle}`);
  await page.mouse.move(target.hoverX, target.hoverY);
  await page.waitForFunction(
    ({ outerTitle, nestedTitle }) => {
      const outer = findRowPeekDialog(outerTitle);
      const rows = Array.from(outer?.querySelectorAll('[data-table-row-id]') ?? []);
      const row = rows.find((candidate) =>
        Array.from(candidate.querySelectorAll('input')).some(
          (input) => input instanceof HTMLInputElement && input.value === nestedTitle,
        ),
      );
      const button = row?.querySelector('[data-table-row-open]');
      if (!(button instanceof HTMLElement)) return false;
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none' &&
        Number(style.opacity) > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }
    },
    { outerTitle: seed.rowTwoTitle, nestedTitle: seed.nestedRowTitle },
    { timeout: options.timeoutMs },
  );
  await page.mouse.click(target.x, target.y);
  await assertPeekMode(page, seed.nestedRowTitle, 'side');
  await rowPeekDialog(page, seed.rowTwoTitle);

  const after = await collectNestedInlineRowPeekState(page, seed);
  assert(after.outerVisible, `outer row peek should remain visible after opening nested row: ${JSON.stringify(after)}`);
  assert(after.nestedVisible, `nested inline row peek should open: ${JSON.stringify(after)}`);
  assert(
    after.rowParam === seed.nestedRowId,
    `nested inline row peek should push its own row URL param: ${JSON.stringify(after)}`,
  );
  assert(after.modeParam === 's', `nested row peek mode should remain side: ${JSON.stringify(after)}`);

  await page.screenshot({
    path: join(artifactDir, 'nested-inline-row-open.png'),
    fullPage: false,
  });

  await page.evaluate(() => window.history.back());
  await page.waitForFunction(
    ({ outerId, outerTitle, nestedTitle }) => {
      const url = new URL(window.location.href);
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0)
        .map((node) => node.getAttribute('aria-label') ?? '');
      return (
        url.searchParams.get('p') === outerId &&
        url.searchParams.get('pm') === 's' &&
        dialogs.includes(`${outerTitle} preview`) &&
        !dialogs.includes(`${nestedTitle} preview`)
      );
    },
    {
      outerId: seed.rowTwoId,
      outerTitle: seed.rowTwoTitle,
      nestedTitle: seed.nestedRowTitle,
    },
    { timeout: options.timeoutMs },
  );
  const afterBack = await collectNestedInlineRowPeekState(page, seed);
  assert(afterBack.outerVisible, `browser Back should keep the outer row peek visible: ${JSON.stringify(afterBack)}`);
  assert(!afterBack.nestedVisible, `browser Back should close only the nested row peek: ${JSON.stringify(afterBack)}`);
  assert(
    afterBack.rowParam === seed.rowTwoId,
    `browser Back should restore the outer row URL param: ${JSON.stringify(afterBack)}`,
  );
  assert(
    afterBack.modeParam === 's',
    `browser Back should keep the outer row peek in side mode: ${JSON.stringify(afterBack)}`,
  );

  await page.screenshot({
    path: join(artifactDir, 'nested-inline-row-after-back.png'),
    fullPage: false,
  });
  writeFileSync(
    join(artifactDir, 'nested-inline-row-open.json'),
    `${JSON.stringify({ before, after, afterBack, target }, null, 2)}\n`,
  );

  await rowPeekDialog(page, seed.rowTwoTitle);
}

async function assertNestedInlineRelationPropertySelectDismiss(page, seed) {
  const dialog = await rowPeekDialog(page, seed.rowTwoTitle);
  try {
    await page.waitForFunction(
      ({ outerTitle, nestedTitle }) => {
        const outer = findRowPeekDialog(outerTitle);
        return Array.from(outer?.querySelectorAll('input') ?? []).some(
          (input) => input instanceof HTMLInputElement && input.value === nestedTitle && input.offsetParent !== null,
        );

        function findRowPeekDialog(dialogTitle) {
          return Array.from(document.querySelectorAll('[role="dialog"]')).find(
            (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
          );
        }
      },
      { outerTitle: seed.rowTwoTitle, nestedTitle: seed.nestedRowTitle },
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const state = await page.evaluate(({ outerTitle }) => {
      const outer = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (node) => node.getAttribute('aria-label') === `${outerTitle} preview`,
      );
      return {
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((node) => node.getAttribute('aria-label')),
        inputs: Array.from(outer?.querySelectorAll('input') ?? []).map((input) => ({
          value: input.value,
          visible: input instanceof HTMLElement && input.offsetParent !== null,
        })),
        bodyText: (outer?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      };
    }, { outerTitle: seed.rowTwoTitle });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`nested inline database did not render before relation select check: ${message}; state=${JSON.stringify(state)}`);
  }

  const headerButton = await inlineRelationPropertyHeaderButton(page, seed.rowTwoTitle);
  await positionInlineRelationHeaderForMenu(page, seed.rowTwoTitle);
  await headerButton.click({ timeout: options.timeoutMs });
  const propertyDialog = page.getByRole('dialog', { name: 'Relation property options' });
  await propertyDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await propertyDialog.getByRole('button', { name: /^Edit property$/ }).click({ timeout: options.timeoutMs });

  const selectButton = propertyDialog.getByRole('button', { name: 'Relation database' });
  await selectButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await selectButton.click({ timeout: options.timeoutMs });
  let selectMenu = page.getByRole('menu', { name: 'Relation database' });
  await selectMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await selectMenu.getByRole('menuitemradio', { name: seed.databaseTitle }).click({ timeout: options.timeoutMs });
  await selectMenu.waitFor({ state: 'hidden', timeout: options.timeoutMs });

  await selectButton.click({ timeout: options.timeoutMs });
  selectMenu = page.getByRole('menu', { name: 'Relation database' });
  await selectMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const beforeOutsideClick = await inlineRelationSelectState(page, seed.rowTwoTitle);
  assert(
    beforeOutsideClick.selectMenuVisible && beforeOutsideClick.propertyDialogVisible && beforeOutsideClick.rowPeekVisible,
    `inline relation database select should be visible before outside click: ${JSON.stringify(beforeOutsideClick)}`,
  );
  await clickInlineRelationSelectOutsidePoint(page);
  await selectMenu.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  const afterOutsideClick = await inlineRelationSelectState(page, seed.rowTwoTitle);
  assert(
    !afterOutsideClick.selectMenuVisible && afterOutsideClick.propertyDialogVisible && afterOutsideClick.rowPeekVisible,
    `inline relation database select should close while property dialog and row peek stay open: ${JSON.stringify({ beforeOutsideClick, afterOutsideClick })}`,
  );

  await selectButton.click({ timeout: options.timeoutMs });
  selectMenu = page.getByRole('menu', { name: 'Relation database' });
  await selectMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const beforeDialogOutsideClick = await inlineRelationSelectState(page, seed.rowTwoTitle);
  await clickInlinePropertyDialogOutsidePoint(page, seed.rowTwoTitle);
  await selectMenu.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await propertyDialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  const afterDialogOutsideClick = await inlineRelationSelectState(page, seed.rowTwoTitle);
  assert(
    !afterDialogOutsideClick.selectMenuVisible && !afterDialogOutsideClick.propertyDialogVisible && afterDialogOutsideClick.rowPeekVisible,
    `clicking outside the inline property dialog should close both the dropdown and property dialog while row peek stays open: ${JSON.stringify({ beforeDialogOutsideClick, afterDialogOutsideClick })}`,
  );

  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-inline-property-select');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'local-inline-relation-database-select-dismiss.json'),
    `${JSON.stringify(
      {
        rowTitle: seed.rowTwoTitle,
        propertyId: seed.nestedRelationPropId,
        beforeOutsideClick,
        afterOutsideClick,
        beforeDialogOutsideClick,
        afterDialogOutsideClick,
      },
      null,
      2,
    )}\n`,
  );
  await page.screenshot({
    path: join(artifactDir, 'local-inline-relation-database-select-dismiss.png'),
    fullPage: false,
  });
}

async function inlineRelationPropertyHeaderButton(page, rowTitle) {
  await page.waitForFunction(
    (outerTitle) => {
      const outer = findRowPeekDialog(outerTitle);
      return Array.from(outer?.querySelectorAll('button[aria-label="Relation property options"]') ?? []).some(
        (button) => button instanceof HTMLElement && isVisible(button),
      );

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }
      function isVisible(element) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
    },
    rowTitle,
    { timeout: options.timeoutMs },
  );
  const index = await page.locator('button[aria-label="Relation property options"]').evaluateAll(
    (buttons, outerTitle) => {
      const outer = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (node) => node.getAttribute('aria-label') === `${outerTitle} preview`,
      );
      return buttons.findIndex((button) => button instanceof HTMLElement && outer?.contains(button) && button.offsetParent !== null);
    },
    rowTitle,
  );
  assert(index >= 0, 'inline relation property header button should be visible inside row peek');
  return page.locator('button[aria-label="Relation property options"]').nth(index);
}

async function positionInlineRelationHeaderForMenu(page, rowTitle) {
  await page.evaluate((outerTitle) => {
    const outer = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) => node.getAttribute('aria-label') === `${outerTitle} preview`,
    );
    const scroller = outer?.querySelector('[class*="rowPeekScroll"]');
    const button = Array.from(outer?.querySelectorAll('button[aria-label="Relation property options"]') ?? []).find(
      (node) => node instanceof HTMLElement && node.offsetParent !== null,
    );
    if (!(scroller instanceof HTMLElement) || !(button instanceof HTMLElement)) return;
    const buttonRect = button.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const targetTop = scrollerRect.top + Math.min(260, scrollerRect.height * 0.36);
    scroller.scrollTop += buttonRect.top - targetTop;
  }, rowTitle);
  await page.waitForTimeout(100);
}

async function inlineRelationSelectState(page, rowTitle) {
  return await page.evaluate((outerTitle) => {
    const rowPeek = findRowPeekDialog(outerTitle);
    const propertyDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) =>
        node instanceof HTMLElement &&
        node.getAttribute('aria-label') === 'Relation property options' &&
        isVisible(node),
    );
    const selectMenu = Array.from(document.querySelectorAll('[role="menu"]')).find(
      (node) =>
        node instanceof HTMLElement &&
        node.getAttribute('aria-label') === 'Relation database' &&
        isVisible(node),
    );
    const selectRect = selectMenu instanceof HTMLElement ? selectMenu.getBoundingClientRect() : null;
    const hit =
      selectRect &&
      document.elementFromPoint(selectRect.left + selectRect.width / 2, selectRect.top + Math.min(16, selectRect.height / 2));
    return {
      rowPeekVisible: !!rowPeek,
      propertyDialogVisible: !!propertyDialog,
      selectMenuVisible: !!selectMenu,
      selectMenuText: (selectMenu?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      selectMenuHitTag: hit?.tagName ?? null,
      selectMenuHitLabel: hit?.closest?.('[aria-label]')?.getAttribute('aria-label') ?? null,
    };

    function findRowPeekDialog(dialogTitle) {
      return Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
      );
    }
    function isVisible(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, rowTitle);
}

async function clickInlineRelationSelectOutsidePoint(page) {
  const point = await page.evaluate(() => {
    const propertyDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) =>
        node instanceof HTMLElement &&
        node.getAttribute('aria-label') === 'Relation property options' &&
        isVisible(node),
    );
    const selectMenu = Array.from(document.querySelectorAll('[role="menu"]')).find(
      (node) =>
        node instanceof HTMLElement &&
        node.getAttribute('aria-label') === 'Relation database' &&
        isVisible(node),
    );
    const nameInput = Array.from(propertyDialog?.querySelectorAll('input') ?? []).find(
      (input) => input instanceof HTMLInputElement && input.value === 'Relation',
    );
    const targetRect = nameInput instanceof HTMLElement
      ? nameInput.getBoundingClientRect()
      : propertyDialog instanceof HTMLElement
        ? propertyDialog.getBoundingClientRect()
        : null;
    const menuRect = selectMenu instanceof HTMLElement ? selectMenu.getBoundingClientRect() : null;
    if (!targetRect || !menuRect) return null;
    const point = {
      x: targetRect.left + Math.min(Math.max(targetRect.width / 2, 12), Math.max(12, targetRect.width - 12)),
      y: targetRect.top + Math.min(Math.max(targetRect.height / 2, 12), Math.max(12, targetRect.height - 12)),
    };
    if (!inside(point, menuRect)) return point;
    return { x: Math.max(8, menuRect.left - 12), y: Math.max(8, menuRect.top - 12) };

    function inside(candidate, rect) {
      return candidate.x >= rect.left && candidate.x <= rect.right && candidate.y >= rect.top && candidate.y <= rect.bottom;
    }
    function isVisible(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  });
  assert(point, 'inline relation database select outside-click point should be available');
  await page.mouse.click(point.x, point.y);
}

async function clickInlinePropertyDialogOutsidePoint(page, rowTitle) {
  const state = await page.evaluate((outerTitle) => {
    const rowPeek = findRowPeekDialog(outerTitle);
    const propertyDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) =>
        node instanceof HTMLElement &&
        node.getAttribute('aria-label') === 'Relation property options' &&
        isVisible(node),
    );
    const selectMenu = Array.from(document.querySelectorAll('[role="menu"]')).find(
      (node) =>
        node instanceof HTMLElement &&
        node.getAttribute('aria-label') === 'Relation database' &&
        isVisible(node),
    );
    const rowRect = rowPeek instanceof HTMLElement ? rowPeek.getBoundingClientRect() : null;
    const dialogRect = propertyDialog instanceof HTMLElement ? propertyDialog.getBoundingClientRect() : null;
    const menuRect = selectMenu instanceof HTMLElement ? selectMenu.getBoundingClientRect() : null;
    if (!rowRect || !dialogRect) return null;
    const candidates = [
      { x: rowRect.left + 88, y: rowRect.top + 88 },
      { x: rowRect.left + 120, y: Math.min(rowRect.bottom - 40, dialogRect.bottom + 40) },
      { x: rowRect.right - 48, y: rowRect.top + 72 },
    ];
    const point = candidates.find((candidate) => {
      if (!inside(candidate, rowRect) || inside(candidate, dialogRect)) return false;
      if (menuRect && inside(candidate, menuRect)) return false;
      return true;
    }) ?? null;
    if (!point) return null;
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      x: Math.round(point.x),
      y: Math.round(point.y),
      hitTag: hit?.tagName ?? null,
      hitLabel: hit?.closest?.('[aria-label]')?.getAttribute('aria-label') ?? null,
      hitClass: hit instanceof HTMLElement ? hit.className : null,
    };

    function findRowPeekDialog(dialogTitle) {
      return Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
      );
    }
    function inside(candidate, rect) {
      return candidate.x >= rect.left && candidate.x <= rect.right && candidate.y >= rect.top && candidate.y <= rect.bottom;
    }
    function isVisible(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, rowTitle);
  assert(state, 'inline property dialog outside-click point should be available');
  await page.mouse.click(state.x, state.y);
  return state;
}

async function assertNestedInlineDatabaseRendered(page, seed) {
  try {
    await page.waitForFunction(
      ({ outerTitle, nestedTitle }) => {
        const outer = findRowPeekDialog(outerTitle);
        return Array.from(outer?.querySelectorAll('input') ?? []).some(
          (input) => input instanceof HTMLInputElement && input.value === nestedTitle && input.offsetParent !== null,
        );

        function findRowPeekDialog(dialogTitle) {
          return Array.from(document.querySelectorAll('[role="dialog"]')).find(
            (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
          );
        }
      },
      { outerTitle: seed.rowTwoTitle, nestedTitle: seed.nestedRowTitle },
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const state = await page.evaluate(({ outerTitle }) => {
      const outer = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (node) => node.getAttribute('aria-label') === `${outerTitle} preview`,
      );
      return {
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((node) => node.getAttribute('aria-label')),
        bodyText: (outer?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      };
    }, { outerTitle: seed.rowTwoTitle });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`nested inline database did not render for menu dismiss audit: ${message}; state=${JSON.stringify(state)}`);
  }
}

async function assertRowPeekToolbarMenuDismiss(page, seed, { triggerName, surfaceRole, surfaceName, label }) {
  const dialog = await rowPeekDialog(page, seed.rowTwoTitle);
  const trigger = dialog.getByRole('button', { name: triggerName }).last();
  await trigger.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await trigger.click({ timeout: options.timeoutMs });
  const surface = page.getByRole(surfaceRole, { name: surfaceName }).last();
  await surface.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return await dismissSurfaceFromRowPeek(page, seed.rowTwoTitle, {
    label,
    surfaceName,
    surfaceRole,
  });
}

async function assertRowPeekViewActionMenuDismiss(page, seed) {
  const dialog = await rowPeekDialog(page, seed.rowTwoTitle);
  const triggers = dialog.locator('button[aria-label$=" view actions"]');
  const count = await triggers.count();
  if (count === 0) {
    return {
      label: 'inline row-peek view action menu',
      skipped: true,
      reason: 'seeded row peek inline database did not expose a visible view action trigger',
    };
  }
  const trigger = triggers.last();
  await trigger.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await trigger.click({ timeout: options.timeoutMs });
  const surfaceName = await trigger.getAttribute('aria-label');
  assert(surfaceName, 'row peek inline view action trigger should expose an aria-label');
  const surface = page.getByRole('dialog', { name: surfaceName }).last();
  await surface.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return await dismissSurfaceFromRowPeek(page, seed.rowTwoTitle, {
    label: 'inline row-peek view action menu',
    surfaceName,
    surfaceRole: 'dialog',
  });
}

async function assertBoardGroupMenuDismiss(page, baseUrl, seed) {
  await openDatabaseView(page, baseUrl, seed, { label: 'Board', viewId: seed.boardViewId });
  const trigger = page.locator('button[aria-label$=" group options"]').first();
  await trigger.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const triggerLabel = await trigger.getAttribute('aria-label');
  assert(triggerLabel, 'board group action trigger should expose an aria-label');
  const surfaceName = triggerLabel;
  await trigger.click({ timeout: options.timeoutMs });
  const surface = page.getByRole('dialog', { name: surfaceName });
  await surface.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const before = await collectSurfaceLayerState(page, { surfaceName, surfaceRole: 'dialog' });
  assert(
    before.surfaceHitLabel !== before.backdropLabel,
    `board group menu should sit above its outside-click backdrop: ${JSON.stringify(before)}`,
  );

  const click = await clickOutsideSurface(page, { surfaceName, surfaceRole: 'dialog' });
  await surface.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  const after = await collectSurfaceLayerState(page, { surfaceName, surfaceRole: 'dialog' });
  assert(!after.surfaceVisible, `board group menu should close on outside click: ${JSON.stringify({ before, click, after })}`);
  return { label: 'board group menu', surfaceName, before, click, after };
}

async function dismissSurfaceFromRowPeek(page, rowTitle, { label, surfaceName, surfaceRole }) {
  const before = await collectSurfaceLayerState(page, { rowTitle, surfaceName, surfaceRole });
  assert(
    before.rowPeekVisible && before.surfaceVisible,
    `${label} should be visible before outside-click dismissal: ${JSON.stringify(before)}`,
  );
  const click = await clickInsideRowPeekOutsideSurface(page, rowTitle, { surfaceName, surfaceRole });
  const surface = page.getByRole(surfaceRole, { name: surfaceName }).last();
  try {
    await surface.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  } catch (error) {
    const afterFailure = await collectSurfaceLayerState(page, { rowTitle, surfaceName, surfaceRole });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} did not close after outside click: ${message}; state=${JSON.stringify({ before, click, afterFailure })}`);
  }
  const after = await collectSurfaceLayerState(page, { rowTitle, surfaceName, surfaceRole });
  assert(
    after.rowPeekVisible && !after.surfaceVisible,
    `${label} should close while row peek stays open: ${JSON.stringify({ before, click, after })}`,
  );
  return { label, surfaceName, before, click, after };
}

async function collectSurfaceLayerState(page, { rowTitle = null, surfaceName, surfaceRole }) {
  return await page.evaluate(
    ({ rowTitle, surfaceName, surfaceRole }) => {
      const rowPeek = rowTitle ? findRowPeekDialog(rowTitle) : null;
      const surface = Array.from(document.querySelectorAll(`[role="${cssEscape(surfaceRole)}"]`)).find(
        (node) =>
          node instanceof HTMLElement &&
          node.getAttribute('aria-label') === surfaceName &&
          isVisible(node),
      );
      const backdrop = Array.from(document.querySelectorAll('button[class*="menuBackdrop"]')).find(
        (node) => node instanceof HTMLElement && isVisible(node),
      );
      const surfaceRect = surface instanceof HTMLElement ? surface.getBoundingClientRect() : null;
      const surfaceHit = surfaceRect
        ? document.elementFromPoint(
            surfaceRect.left + Math.min(Math.max(surfaceRect.width / 2, 8), Math.max(8, surfaceRect.width - 8)),
            surfaceRect.top + Math.min(Math.max(surfaceRect.height / 2, 8), Math.max(8, surfaceRect.height - 8)),
          )
        : null;
      const rowRect = rowPeek instanceof HTMLElement ? rowPeek.getBoundingClientRect() : null;
      const backdropStyle = backdrop instanceof HTMLElement ? getComputedStyle(backdrop) : null;
      const surfaceStyle = surface instanceof HTMLElement ? getComputedStyle(surface) : null;
      const rowStyle = rowPeek instanceof HTMLElement ? getComputedStyle(rowPeek) : null;
      return {
        rowPeekVisible: rowTitle ? rowPeek instanceof HTMLElement && isVisible(rowPeek) : null,
        rowPeekZIndex: rowStyle?.zIndex ?? null,
        rowRect: rowRect ? rectSummary(rowRect) : null,
        surfaceVisible: surface instanceof HTMLElement,
        surfaceName,
        surfaceRole,
        surfaceZIndex: surfaceStyle?.zIndex ?? null,
        surfaceRect: surfaceRect ? rectSummary(surfaceRect) : null,
        surfaceHitTag: surfaceHit?.tagName ?? null,
        surfaceHitLabel: surfaceHit?.closest?.('[aria-label]')?.getAttribute('aria-label') ?? null,
        backdropVisible: backdrop instanceof HTMLElement,
        backdropLabel: backdrop?.getAttribute?.('aria-label') ?? null,
        backdropZIndex: backdropStyle?.zIndex ?? null,
      };

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }
      function isVisible(element) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
      function rectSummary(rect) {
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }
      function cssEscape(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    { rowTitle, surfaceName, surfaceRole },
  );
}

async function clickInsideRowPeekOutsideSurface(page, rowTitle, { surfaceName, surfaceRole }) {
  const point = await page.evaluate(
    ({ rowTitle, surfaceName, surfaceRole }) => {
      const rowPeek = findRowPeekDialog(rowTitle);
      const surface = Array.from(document.querySelectorAll(`[role="${cssEscape(surfaceRole)}"]`)).find(
        (node) =>
          node instanceof HTMLElement &&
          node.getAttribute('aria-label') === surfaceName &&
          isVisible(node),
      );
      const rowRect = rowPeek instanceof HTMLElement ? rowPeek.getBoundingClientRect() : null;
      const surfaceRect = surface instanceof HTMLElement ? surface.getBoundingClientRect() : null;
      if (!rowRect || !surfaceRect) return null;
      const candidates = [
        { x: rowRect.left + 96, y: rowRect.top + 92 },
        { x: rowRect.right - 56, y: rowRect.top + 76 },
        { x: rowRect.left + 130, y: rowRect.bottom - 72 },
        { x: rowRect.right - 72, y: rowRect.bottom - 72 },
      ];
      const point = candidates.find((candidate) => inside(candidate, rowRect) && !inside(candidate, surfaceRect)) ?? null;
      if (!point) return null;
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        x: Math.round(point.x),
        y: Math.round(point.y),
        hitTag: hit?.tagName ?? null,
        hitLabel: hit?.closest?.('[aria-label]')?.getAttribute('aria-label') ?? null,
        hitClass: hit instanceof HTMLElement ? hit.className : null,
      };

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }
      function inside(candidate, rect) {
        return candidate.x >= rect.left && candidate.x <= rect.right && candidate.y >= rect.top && candidate.y <= rect.bottom;
      }
      function isVisible(element) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
      function cssEscape(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    { rowTitle, surfaceName, surfaceRole },
  );
  assert(point, `outside-click point inside row peek should be available for ${surfaceName}`);
  await page.mouse.click(point.x, point.y);
  return point;
}

async function clickOutsideSurface(page, { surfaceName, surfaceRole }) {
  const point = await page.evaluate(
    ({ surfaceName, surfaceRole }) => {
      const surface = Array.from(document.querySelectorAll(`[role="${cssEscape(surfaceRole)}"]`)).find(
        (node) =>
          node instanceof HTMLElement &&
          node.getAttribute('aria-label') === surfaceName &&
          isVisible(node),
      );
      const rect = surface instanceof HTMLElement ? surface.getBoundingClientRect() : null;
      const candidates = [
        { x: 24, y: 24 },
        { x: window.innerWidth - 24, y: 24 },
        { x: 24, y: window.innerHeight - 24 },
        { x: window.innerWidth - 24, y: window.innerHeight - 24 },
      ];
      const point = candidates.find((candidate) => !rect || !inside(candidate, rect)) ?? null;
      if (!point) return null;
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        x: Math.round(point.x),
        y: Math.round(point.y),
        hitTag: hit?.tagName ?? null,
        hitLabel: hit?.closest?.('[aria-label]')?.getAttribute('aria-label') ?? null,
        hitClass: hit instanceof HTMLElement ? hit.className : null,
      };

      function inside(candidate, rect) {
        return candidate.x >= rect.left && candidate.x <= rect.right && candidate.y >= rect.top && candidate.y <= rect.bottom;
      }
      function isVisible(element) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
      function cssEscape(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    { surfaceName, surfaceRole },
  );
  assert(point, `outside-click point should be available for ${surfaceName}`);
  await page.mouse.click(point.x, point.y);
  return point;
}

async function collectNestedInlineRowPeekState(page, seed) {
  return await page.evaluate(
    ({ outerTitle, nestedTitle }) => {
      const url = new URL(window.location.href);
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0)
        .map((node) => ({
          label: node.getAttribute('aria-label') ?? '',
          mode: node.getAttribute('data-mode') ?? '',
        }));
      return {
        url: `${url.pathname}${url.search}${url.hash}`,
        rowParam: url.searchParams.get('p'),
        modeParam: url.searchParams.get('pm'),
        dialogs,
        outerVisible: dialogs.some((dialog) => dialog.label === `${outerTitle} preview`),
        nestedVisible: dialogs.some((dialog) => dialog.label === `${nestedTitle} preview`),
      };
    },
    { outerTitle: seed.rowTwoTitle, nestedTitle: seed.nestedRowTitle },
  );
}

async function assertInlineRowPeekHistory(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.inlinePageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await rowTitleInput(page, seed.rowOneTitle);
  await openRow(page, seed.rowOneTitle);
  await assertPeekMode(page, seed.rowOneTitle, 'side');
  await assertRowPeekUrl(page, seed.rowOneId);
  await assertRowPeekModeParam(page, 's');
  const beforeBack = await collectInlineRowPeekHistoryState(page, seed);
  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-peek-history');
  mkdirSync(artifactDir, { recursive: true });
  await page.screenshot({
    path: join(artifactDir, 'inline-row-peek-open.png'),
    fullPage: false,
  });

  await page.evaluate(() => window.history.back());
  await page.waitForFunction(
    (inlinePageId) => {
      const url = new URL(window.location.href);
      return (
        url.pathname === `/p/${inlinePageId}` &&
        !url.searchParams.has('p') &&
        !url.searchParams.has('pm')
      );
    },
    seed.inlinePageId,
    { timeout: options.timeoutMs },
  );
  await page.getByRole('dialog', { name: `${seed.rowOneTitle} preview` }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  });
  await rowTitleInput(page, seed.rowOneTitle);
  const afterBack = await collectInlineRowPeekHistoryState(page, seed);
  await page.screenshot({
    path: join(artifactDir, 'inline-row-peek-after-back.png'),
    fullPage: false,
  });
  writeFileSync(
    join(artifactDir, 'inline-row-peek-history.json'),
    `${JSON.stringify({ beforeBack, afterBack }, null, 2)}\n`,
  );
}

async function collectInlineRowPeekHistoryState(page, seed) {
  return await page.evaluate(
    ({ inlinePageId, rowTitle }) => {
      const url = new URL(window.location.href);
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0)
        .map((node) => ({
          label: node.getAttribute('aria-label') ?? '',
          mode: node.getAttribute('data-mode') ?? '',
        }));
      const rowInputVisible = Array.from(document.querySelectorAll('input')).some(
        (input) => input instanceof HTMLInputElement && input.value === rowTitle && input.offsetParent !== null,
      );
      return {
        url: `${url.pathname}${url.search}${url.hash}`,
        pathnameMatchesInlinePage: url.pathname === `/p/${inlinePageId}`,
        rowParam: url.searchParams.get('p'),
        rowPeekModeParam: url.searchParams.get('pm'),
        visibleDialogs: dialogs,
        rowInputVisible,
      };
    },
    { inlinePageId: seed.inlinePageId, rowTitle: seed.rowOneTitle },
  );
}

async function assertRowPropertyValue(page, rowTitle, propertyId, expectation) {
  await page.waitForFunction(
    ([title, propId]) => {
      const dialog = findRowPeekDialog(title);
      const row = dialog?.querySelector(`[data-row-property-id="${cssString(propId)}"]`);
      const value = row?.querySelector('[class*="rowPropertyValue"]');
      return !!row && !!value && value.getClientRects().length > 0;

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }

      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    [rowTitle, propertyId],
    { timeout: options.timeoutMs },
  );
  const state = await page.evaluate(
    ([title, propId]) => {
      const dialog = findRowPeekDialog(title);
      const row = dialog?.querySelector(`[data-row-property-id="${cssString(propId)}"]`);
      const label = row?.querySelector('[data-row-property-label]');
      const value = row?.querySelector('[class*="rowPropertyValue"]');
      const valueText = collectVisibleControlText(value).replace(/\s+/g, ' ').trim();
      return {
        label: (label?.innerText ?? label?.textContent ?? '').trim(),
        value: valueText,
        relationLoading: !!row?.querySelector('[data-row-relation-loading]'),
        relationMissing: !!row?.querySelector('[data-row-relation-missing]'),
      };

      function collectVisibleControlText(root) {
        if (!root) return '';
        const parts = [root.innerText ?? root.textContent ?? ''];
        for (const control of root.querySelectorAll('input, textarea')) {
          if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
            parts.push(control.value);
          }
        }
        return parts.join(' ');
      }

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }

      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    [rowTitle, propertyId],
  );
  assert(
    state.label === expectation.label,
    `${rowTitle} row property label should be ${expectation.label}: ${JSON.stringify(state)}`,
  );
  for (const text of expectation.includes ?? []) {
    assert(
      state.value.includes(text),
      `${rowTitle} ${expectation.label} row property value should include ${text}: ${JSON.stringify(state)}`,
    );
  }
  for (const text of expectation.excludes ?? []) {
    assert(
      !state.value.includes(text),
      `${rowTitle} ${expectation.label} row property value should not include ${text}: ${JSON.stringify(state)}`,
    );
  }
  if (typeof expectation.relationLoading === 'boolean') {
    assert(
      state.relationLoading === expectation.relationLoading,
      `${rowTitle} ${expectation.label} relation loading state should be ${expectation.relationLoading}: ${JSON.stringify(state)}`,
    );
  }
  if (typeof expectation.relationMissing === 'boolean') {
    assert(
      state.relationMissing === expectation.relationMissing,
      `${rowTitle} ${expectation.label} relation missing state should be ${expectation.relationMissing}: ${JSON.stringify(state)}`,
    );
  }
}

async function assertRowLongTextProperties(page, seed) {
  const account = await collectRowLongTextProperty(page, seed.rowOneTitle, seed.accountPropId);
  const memo = await collectRowLongTextProperty(page, seed.rowOneTitle, seed.memoPropId);
  assert(account.label === '계좌정보', `account property label should match: ${JSON.stringify(account)}`);
  assert(memo.label === '메모', `memo property label should match: ${JSON.stringify(memo)}`);
  assert(
    account.text.includes('샘플은행') && account.text.includes('개설일 2026-01-02'),
    `account property should expose full multiline text: ${JSON.stringify(account)}`,
  );
  assert(
    memo.text.includes('## 본사 기본 정보') && memo.text.includes('## 사업자등록증 업태/종목'),
    `memo property should expose full multiline text: ${JSON.stringify(memo)}`,
  );
  assert(account.isTextarea, `account property should render as a row-detail multiline editor: ${JSON.stringify(account)}`);
  assert(memo.isTextarea, `memo property should render as a row-detail multiline editor: ${JSON.stringify(memo)}`);
  assert(account.whiteSpace === 'pre-wrap', `account property should preserve line breaks: ${JSON.stringify(account)}`);
  assert(memo.whiteSpace === 'pre-wrap', `memo property should preserve line breaks: ${JSON.stringify(memo)}`);
  assert(account.height >= 58, `account property should not collapse to one line: ${JSON.stringify(account)}`);
  assert(memo.height >= 100, `memo property should not collapse to one line: ${JSON.stringify(memo)}`);
  assert(
    account.scrollHeight <= account.clientHeight + 2 && memo.scrollHeight <= memo.clientHeight + 2,
    `long row properties should auto-size to their content instead of clipping: ${JSON.stringify({ account, memo })}`,
  );

  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-long-text');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'local-row-long-text.json'),
    `${JSON.stringify({ rowTitle: seed.rowOneTitle, account, memo }, null, 2)}\n`,
  );
  await page.screenshot({
    path: join(artifactDir, 'local-row-long-text.png'),
    fullPage: false,
  });
}

async function collectRowLongTextProperty(page, rowTitle, propertyId) {
  return await page.evaluate(
    ([title, propId]) => {
      const dialog = findRowPeekDialog(title);
      const row = dialog?.querySelector(`[data-row-property-id="${cssString(propId)}"]`);
      const label = row?.querySelector('[data-row-property-label]');
      const value = row?.querySelector('[data-row-property-text="true"]');
      const rect = value?.getBoundingClientRect();
      const style = value ? getComputedStyle(value) : null;
      const isTextarea = value instanceof HTMLTextAreaElement;
      return {
        label: (label?.innerText ?? label?.textContent ?? '').trim(),
        tagName: value?.tagName ?? null,
        isTextarea,
        text: isTextarea ? value.value : (value?.innerText ?? value?.textContent ?? ''),
        height: rect?.height ?? 0,
        width: rect?.width ?? 0,
        clientHeight: isTextarea ? value.clientHeight : rect?.height ?? 0,
        scrollHeight: isTextarea ? value.scrollHeight : rect?.height ?? 0,
        whiteSpace: style?.whiteSpace ?? null,
        overflowY: style?.overflowY ?? null,
      };

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }

      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    [rowTitle, propertyId],
  );
}

async function assertRowPropertyMenu(page, rowTitle, propertyId, label) {
  const dialog = await rowPeekDialog(page, rowTitle);
  const managementState = await page.evaluate((title) => {
    const dialog = findRowPeekDialog(title);
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(
      dialog?.querySelectorAll('[class*="rowCustomizeButton"], [class*="rowAddProperty"], [class*="rowBackrefs"]') ?? [],
    ).filter(visible);
    return { visibleManagementControlCount: controls.length };

    function findRowPeekDialog(dialogTitle) {
      return Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
      );
    }
  }, rowTitle);
  assert(
    managementState.visibleManagementControlCount === 0,
    `row detail should keep bottom property management scaffolding hidden at rest: ${JSON.stringify(managementState)}`,
  );

  const propertyButton = dialog
    .locator(`[data-row-property-id="${propertyId}"] button[aria-haspopup="menu"]`)
    .first();
  await propertyButton.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await propertyButton.click({ timeout: options.timeoutMs });
  const menu = dialog.getByRole('menu', { name: `${label} property options` });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const state = await page.evaluate(
    ({ title, propId, expectedLabel }) => {
      const dialog = findRowPeekDialog(title);
      const row = dialog?.querySelector(`[data-row-property-id="${cssString(propId)}"]`);
      const labelNode = row?.querySelector('[data-row-property-label]');
      const button = row?.querySelector('button[aria-haspopup="menu"]');
      const menu = dialog?.querySelector(`[role="menu"][aria-label="${cssString(expectedLabel)} property options"]`);
      const menuText = (menu?.innerText ?? menu?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const menuRect = menu?.getBoundingClientRect();
      const menuStyle = menu ? getComputedStyle(menu) : null;
      return {
        label: (labelNode?.innerText ?? labelNode?.textContent ?? '').trim(),
        buttonTag: button?.tagName ?? null,
        buttonExpanded: button?.getAttribute('aria-expanded') ?? null,
        menuVisible:
          !!menu &&
          menuStyle?.display !== 'none' &&
          menuStyle?.visibility !== 'hidden' &&
          (menuRect?.width ?? 0) > 0 &&
          (menuRect?.height ?? 0) > 0,
        menuText,
        hasNameField: menuText.includes('Name'),
        hasTypeField: menuText.includes('Type'),
        hasDescriptionField: menuText.includes('Description'),
        hasHideAction: menuText.includes('Hide property') || menuText.includes('Show property'),
        hasDuplicateAction: menuText.includes('Duplicate property'),
        hasHideEmptyAction: menuText.includes('Hide when empty'),
        hasDeleteAction: menuText.includes('Delete property'),
      };

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }

      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    { title: rowTitle, propId: propertyId, expectedLabel: label },
  );
  assert(
    state.label === label && state.buttonTag === 'BUTTON' && state.buttonExpanded === 'true',
    `row property label should be a clickable expanded menu trigger: ${JSON.stringify(state)}`,
  );
  assert(state.menuVisible, `row property options menu should open inside row peek: ${JSON.stringify(state)}`);
  assert(
    state.hasNameField &&
      state.hasTypeField &&
      state.hasDescriptionField &&
      state.hasHideAction &&
      state.hasDuplicateAction &&
      state.hasHideEmptyAction &&
      state.hasDeleteAction,
    `row property options menu should expose edit, visibility, duplicate, hide-empty, and delete actions: ${JSON.stringify(state)}`,
  );

  const nameInput = menu.getByLabel('Name', { exact: true });
  await dispatchComposingEnter(nameInput);
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const keyState = {
    composingEnterKeptOpen: await menu.isVisible({ timeout: options.timeoutMs }),
  };

  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-property-menu');
  mkdirSync(artifactDir, { recursive: true });
  await page.screenshot({
    path: join(artifactDir, 'local-row-property-menu.png'),
    fullPage: false,
  });
  await nameInput.press('Enter', { timeout: options.timeoutMs });
  await menu.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  keyState.enterClosedMenu = !(await menu.isVisible().catch(() => false));
  assert(
    keyState.composingEnterKeptOpen && keyState.enterClosedMenu,
    `row property name input should ignore composing Enter and close on regular Enter: ${JSON.stringify(keyState)}`,
  );
  writeFileSync(
    join(artifactDir, 'local-row-property-menu.json'),
    `${JSON.stringify({ rowTitle, propertyId, label, state, keyState }, null, 2)}\n`,
  );

  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function assertRowMultiSelectOptionInteraction(page, seed) {
  await assertRowPropertyValue(page, seed.rowOneTitle, seed.classificationPropId, {
    label: '분류',
    includes: [seed.classificationFirstLabel],
    excludes: [seed.classificationSecondLabel, 'Empty'],
  });

  const { menu } = await openRowMultiSelectMenu(page, seed);
  const option = menu.locator('button[role="option"]').filter({ hasText: seed.classificationSecondLabel }).first();
  await option.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const beforeClick = await page.evaluate((label) => {
    const menu = document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]');
    const button = Array.from(menu?.querySelectorAll('button[role="option"]') ?? []).find((node) =>
      (node.innerText ?? node.textContent ?? '').includes(label),
    );
    const row = button?.closest?.('[data-option-id]') ?? null;
    const chip = button?.querySelector?.('[class*="chip"]') ?? null;
    const handle = row?.querySelector?.('[data-select-option-drag-handle]') ?? null;
    const rect = button?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    const chipRect = chip?.getBoundingClientRect();
    const handleRect = handle?.getBoundingClientRect();
    const chipStyle = chip instanceof HTMLElement ? getComputedStyle(chip) : null;
    const handleStyle = handle instanceof HTMLElement ? getComputedStyle(handle) : null;
    const menuStyle = menu instanceof HTMLElement ? getComputedStyle(menu) : null;
    const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    const hitOption = hit?.closest?.('button[role="option"]') ?? null;
    const backdrop = Array.from(document.querySelectorAll('[aria-label="Close menu"]')).find((node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    return {
      menuZIndex: menu ? getComputedStyle(menu).zIndex : null,
      backdropZIndex: backdrop ? getComputedStyle(backdrop).zIndex : null,
      optionText: (button?.innerText ?? button?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      hitTag: hit?.tagName ?? null,
      hitRole: hit?.getAttribute?.('role') ?? null,
      hitText: (hit?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      hitOptionText: (hitOption?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      visual: {
        optionRowHeight: rowRect?.height ?? 0,
        optionButtonHeight: rect?.height ?? 0,
        chipHeight: chipRect?.height ?? 0,
        chipFontSize: chipStyle ? Number.parseFloat(chipStyle.fontSize) : 0,
        chipFontWeight: chipStyle ? Number.parseFloat(chipStyle.fontWeight) : 0,
        chipBackground: chipStyle?.backgroundColor ?? null,
        menuBackground: menuStyle?.backgroundColor ?? null,
        handleWidth: handleRect?.width ?? 0,
        handleHeight: handleRect?.height ?? 0,
        handleColor: handleStyle?.color ?? null,
      },
    };
  }, seed.classificationSecondLabel);
  assert(
    beforeClick.hitOptionText.includes(seed.classificationSecondLabel),
    `row multi-select option should be the topmost click target, not the backdrop: ${JSON.stringify(beforeClick)}`,
  );
  assert(
    beforeClick.visual.optionRowHeight >= 34 &&
      beforeClick.visual.optionButtonHeight >= 28 &&
      beforeClick.visual.chipHeight >= 22 &&
      beforeClick.visual.chipFontSize >= 13 &&
      beforeClick.visual.chipFontWeight >= 500 &&
      beforeClick.visual.handleWidth >= 23 &&
      beforeClick.visual.handleHeight >= 29,
    `row multi-select options should keep Notion-like dark-menu density and readable chips: ${JSON.stringify(beforeClick.visual)}`,
  );

  await option.click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    ({ title, propId, label }) => {
      const dialog = findRowPeekDialog(title);
      const row = dialog?.querySelector(`[data-row-property-id="${cssString(propId)}"]`);
      const value = row?.querySelector('[class*="rowPropertyValue"]');
      return (value?.innerText ?? value?.textContent ?? '').includes(label);

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }

      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    {
      title: seed.rowOneTitle,
      propId: seed.classificationPropId,
      label: seed.classificationSecondLabel,
    },
    { timeout: options.timeoutMs },
  );

  const afterClick = await page.evaluate(
    ({ title, propId, firstLabel, secondLabel }) => {
      const dialog = findRowPeekDialog(title);
      const row = dialog?.querySelector(`[data-row-property-id="${cssString(propId)}"]`);
      const value = row?.querySelector('[class*="rowPropertyValue"]');
      const menu = document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]');
      const secondOption = Array.from(menu?.querySelectorAll('button[role="option"]') ?? []).find((node) =>
        (node.innerText ?? node.textContent ?? '').includes(secondLabel),
      );
      return {
        value: (value?.innerText ?? value?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        firstSelected: (value?.innerText ?? value?.textContent ?? '').includes(firstLabel),
        secondSelected: (value?.innerText ?? value?.textContent ?? '').includes(secondLabel),
        secondOptionSelected: secondOption?.getAttribute('aria-selected') ?? null,
        menuStillVisible: !!menu,
      };

      function findRowPeekDialog(dialogTitle) {
        return Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
        );
      }

      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    {
      title: seed.rowOneTitle,
      propId: seed.classificationPropId,
      firstLabel: seed.classificationFirstLabel,
      secondLabel: seed.classificationSecondLabel,
    },
  );
  assert(
    afterClick.firstSelected && afterClick.secondSelected && afterClick.secondOptionSelected === 'true',
    `row multi-select option click should add the selected chip: ${JSON.stringify(afterClick)}`,
  );

  const beforeReorder = await collectSelectOptionOrder(page);
  await dragSelectOptionBefore(page, seed.classificationSecondLabel, seed.classificationFirstLabel);
  await page.waitForFunction(
    ({ firstLabel, secondLabel }) => {
      const labels = optionLabels();
      return labels.indexOf(secondLabel) >= 0 && labels.indexOf(secondLabel) < labels.indexOf(firstLabel);

      function optionLabels() {
        const menu = document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]');
        return Array.from(menu?.querySelectorAll('[data-option-id]') ?? []).map((node) =>
          (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        );
      }
    },
    {
      firstLabel: seed.classificationFirstLabel,
      secondLabel: seed.classificationSecondLabel,
    },
    { timeout: options.timeoutMs },
  );
  const afterReorder = await collectSelectOptionOrder(page);
  assert(
    afterReorder.labels.indexOf(seed.classificationSecondLabel) <
      afterReorder.labels.indexOf(seed.classificationFirstLabel),
    `row multi-select option drag should reorder menu options: ${JSON.stringify({ beforeReorder, afterReorder })}`,
  );

  const outsideDismiss = await dismissRowMultiSelectMenuFromPeek(page, seed.rowOneTitle);
  assert(
    !outsideDismiss.after.menuStillVisible && outsideDismiss.after.rowPeekStillVisible,
    `row multi-select menu should close when clicking elsewhere in the row peek: ${JSON.stringify(outsideDismiss)}`,
  );

  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-select-menu');
  const artifactName =
    options.theme === 'dark' ? 'local-row-multi-select-click-dark' : 'local-row-multi-select-click';
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, `${artifactName}.json`),
    `${JSON.stringify(
      {
        rowTitle: seed.rowOneTitle,
        propertyId: seed.classificationPropId,
        beforeClick,
        afterClick,
        beforeReorder,
        afterReorder,
        outsideDismiss,
      },
      null,
      2,
    )}\n`,
  );
  await page.screenshot({
    path: join(artifactDir, `${artifactName}.png`),
    fullPage: false,
  });
}

async function openRowMultiSelectMenu(page, seed) {
  const dialog = await rowPeekDialog(page, seed.rowOneTitle);
  const row = dialog.locator(`[data-row-property-id="${seed.classificationPropId}"]`);
  const trigger = row.locator('[role="button"][aria-haspopup="dialog"]').first();
  await trigger.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await trigger.click({ timeout: options.timeoutMs });
  const menu = page.getByRole('dialog', { name: 'Edit multi-select property' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return { menu };
}

async function dismissRowMultiSelectMenuFromPeek(page, rowTitle) {
  const before = await page.evaluate((title) => {
    const menu = document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]');
    const panel = findRowPeekDialog(title);
    const scroll = panel?.querySelector('[class*="rowPeekScroll"]') ?? panel;
    if (!(menu instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
      return null;
    }
    const menuRect = menu.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const candidates = [
      { x: panelRect.left + Math.min(160, panelRect.width - 24), y: panelRect.top + 88 },
      { x: scrollRect.left + Math.min(120, scrollRect.width - 24), y: scrollRect.top + 24 },
      { x: panelRect.left + Math.min(96, panelRect.width - 24), y: Math.min(panelRect.bottom - 24, menuRect.bottom + 40) },
      { x: panelRect.right - 32, y: panelRect.bottom - 32 },
    ];
    const point =
      candidates.find((candidate) => {
        if (!inside(candidate, panelRect) || inside(candidate, menuRect)) return false;
        const hit = document.elementFromPoint(candidate.x, candidate.y);
        return !menu.contains(hit);
      }) ?? candidates[0];
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      x: Math.round(point.x),
      y: Math.round(point.y),
      menuRect: rectSummary(menuRect),
      panelRect: rectSummary(panelRect),
      hitTag: hit?.tagName ?? null,
      hitRole: hit?.getAttribute?.('role') ?? null,
      hitLabel: hit?.getAttribute?.('aria-label') ?? null,
      hitClass: hit instanceof HTMLElement ? hit.className : null,
      hitText: (hit?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      hitInsideMenu: menu.contains(hit),
    };

    function findRowPeekDialog(dialogTitle) {
      return Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (node) => node.getAttribute('aria-label') === `${dialogTitle} preview`,
      );
    }
    function inside(point, rect) {
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }
    function rectSummary(rect) {
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }
  }, rowTitle);
  assert(before && !before.hitInsideMenu, `row multi-select outside-dismiss click target should be outside the menu: ${JSON.stringify(before)}`);

  await page.mouse.click(before.x, before.y);
  try {
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]'),
      null,
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const menu = document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]');
      const backdrop = document.querySelector('[aria-label="Close menu"]');
      const menuStyle = menu instanceof HTMLElement ? getComputedStyle(menu) : null;
      const backdropStyle = backdrop instanceof HTMLElement ? getComputedStyle(backdrop) : null;
      return {
        menuStillVisible: !!menu,
        menuZIndex: menuStyle?.zIndex ?? null,
        backdropZIndex: backdropStyle?.zIndex ?? null,
      };
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`row multi-select menu did not close after outside click: ${message}; before=${JSON.stringify(before)} after=${JSON.stringify(state)}`);
  }
  const after = await page.evaluate((title) => {
    const rowPeek = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) => node.getAttribute('aria-label') === `${title} preview`,
    );
    return {
      menuStillVisible: !!document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]'),
      rowPeekStillVisible: !!rowPeek,
    };
  }, rowTitle);
  return { before, after };
}

async function collectSelectOptionOrder(page) {
  return await page.evaluate(() => {
    const menu = document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]');
    const rows = Array.from(menu?.querySelectorAll('[data-option-id]') ?? []);
    return {
      labels: rows.map((node) => {
        const option = node.querySelector('button[role="option"]');
        return (option?.textContent ?? '').replace(/\s+/g, ' ').trim();
      }),
      handleCount: rows.filter((node) => !!node.querySelector('[data-select-option-drag-handle]')).length,
      draggingRows: rows.filter((node) => node.getAttribute('data-option-dragging') === 'true').length,
    };
  });
}

async function dragSelectOptionBefore(page, sourceLabel, targetLabel) {
  const source = await page.evaluate(({ sourceLabel, targetLabel }) => {
    const menu = document.querySelector('[role="dialog"][aria-label="Edit multi-select property"]');
    const rows = Array.from(menu?.querySelectorAll('[data-option-id]') ?? []);
    const sourceRow = rows.find((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim().includes(sourceLabel),
    );
    const targetRow = rows.find((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim().includes(targetLabel),
    );
    const sourceHandle = sourceRow?.querySelector('[data-select-option-drag-handle]');
    const sourceRect = sourceHandle?.getBoundingClientRect();
    const targetRect = targetRow?.getBoundingClientRect();
    if (!sourceRect || !targetRect) return null;
    return {
      startX: sourceRect.left + sourceRect.width / 2,
      startY: sourceRect.top + sourceRect.height / 2,
      targetX: targetRect.left + targetRect.width / 2,
      targetY: targetRect.top + 2,
    };
  }, { sourceLabel, targetLabel });
  assert(source, `row multi-select option drag handles should exist for ${sourceLabel} and ${targetLabel}`);

  await page.mouse.move(source.startX, source.startY);
  await page.mouse.down();
  await page.mouse.move(source.startX, source.startY - 16, { steps: 4 });
  await page.mouse.move(source.targetX, source.targetY, { steps: 12 });
  await page.mouse.up();
}

async function assertNonTableViewRowPeek(page, baseUrl, seed, view) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?v=${view.viewId}&p=${view.rowId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: view.label }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await assertPeekMode(page, view.rowTitle, view.mode);
  await assertRowPeekUrl(page, view.rowId);
  await assertActiveViewUrl(page, view.viewId);
  await closeRowPeek(page, view.rowTitle);
  await assertActiveViewUrl(page, view.viewId);
}

async function openDatabaseView(page, baseUrl, seed, view) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?v=${view.viewId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const tab = page.getByRole('tab', { name: view.label });
  await tab.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForFunction(
    (expectedViewId) => new URL(window.location.href).searchParams.get('v') === expectedViewId,
    view.viewId,
    { timeout: options.timeoutMs },
  );
}

async function setOpenPagesIn(page, label) {
  const visibleLabel = { Side: 'Side peek', Center: 'Center peek', Full: 'Full page' }[label] ?? label;
  await page.getByRole('button', { name: 'Layout' }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Layout options' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('radio', { name: visibleLabel }).click({
    timeout: options.timeoutMs,
  });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function openDatabase(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: 'Table' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await rowTitleInput(page, seed.rowOneTitle);
  const path = new URL(page.url()).pathname;
  assert(path === `/database/${seed.databaseId}`, `direct database route changed to ${path}`);
}

async function openRow(page, rowTitle) {
  const input = await rowTitleInput(page, rowTitle);
  await input.focus({ timeout: options.timeoutMs });
  await page.keyboard.press('Control+Enter');
}

async function rowTitleInput(page, rowTitle) {
  await page.waitForFunction(
    (title) =>
      Array.from(document.querySelectorAll('input')).some(
        (input) => input.value === title && input.offsetParent !== null,
      ),
    rowTitle,
    { timeout: options.timeoutMs },
  );
  const index = await page.locator('input').evaluateAll(
    (inputs, title) =>
      inputs.findIndex((input) => input.value === title && input.offsetParent !== null),
    rowTitle,
  );
  assert(index >= 0, `row title input was not found for ${rowTitle}`);
  return page.locator('input').nth(index);
}

async function closeRowPeek(page, rowTitle) {
  const dialog = await rowPeekDialog(page, rowTitle);
  await dialog.focus({ timeout: options.timeoutMs });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.waitForFunction(
    () => {
      const url = new URL(window.location.href);
      return !url.searchParams.has('p') && !url.searchParams.has('pm');
    },
    null,
    { timeout: options.timeoutMs },
  );
}

async function assertPeekMode(page, rowTitle, mode) {
  const dialog = await rowPeekDialog(page, rowTitle);
  await page.waitForFunction(
    ([title, expectedMode]) => {
      const dialogEl = document.querySelector(`[role="dialog"][aria-label="${cssString(title)} preview"]`);
      return dialogEl?.getAttribute('data-mode') === expectedMode;
      function cssString(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }
    },
    [rowTitle, mode],
    { timeout: options.timeoutMs },
  );
  assert((await dialog.getAttribute('data-mode')) === mode, `${rowTitle} preview should use ${mode} mode`);
}

async function assertRowPeekUrl(page, rowId) {
  await page.waitForFunction(
    (expected) => new URL(window.location.href).searchParams.get('p') === expected,
    rowId,
    { timeout: options.timeoutMs },
  );
}

async function assertRowPeekModeParam(page, mode) {
  await page.waitForFunction(
    (expected) => new URL(window.location.href).searchParams.get('pm') === expected,
    mode,
    { timeout: options.timeoutMs },
  );
}

async function assertActiveViewUrl(page, viewId) {
  await page.waitForFunction(
    (expected) => new URL(window.location.href).searchParams.get('v') === expected,
    viewId,
    { timeout: options.timeoutMs },
  );
}

async function assertNoRowPeek(page) {
  const visible = await page
    .getByRole('dialog', { name: /preview$/ })
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  assert(!visible, 'full-page row opening should not leave a row preview dialog visible');
}

async function rowPeekDialog(page, rowTitle) {
  const dialog = page.getByRole('dialog', { name: `${rowTitle} preview` });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function delayRowBlocksLoad(page, rowId) {
  let releaseRoute;
  let released = false;
  let matchedCount = 0;
  const releasePromise = new Promise((resolve) => {
    releaseRoute = resolve;
  });
  let resolveMatched;
  const matched = new Promise((resolve) => {
    resolveMatched = resolve;
  });
  const handler = async (route) => {
    const request = route.request();
    const postData = request.postData() ?? '';
    const isTargetBlocksRequest =
      request.method() === 'POST' &&
      request.url().includes('/api/functions/page-query') &&
      postData.includes('"action":"blocks"') &&
      postData.includes(`"pageId":"${rowId}"`);
    if (isTargetBlocksRequest) {
      matchedCount += 1;
      resolveMatched(matchedCount);
      await releasePromise;
    }
    await route.continue();
  };
  await page.route('**/api/functions/page-query', handler);
  return {
    matched,
    release() {
      if (released) return;
      released = true;
      releaseRoute();
    },
    async cleanup() {
      await page.unroute('**/api/functions/page-query', handler).catch(() => {});
    },
  };
}

async function collectRowPeekBodyState(page, rowTitle) {
  return await page.evaluate((title) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) => node.getAttribute('aria-label') === `${title} preview`,
    );
    const text = dialog?.innerText?.replace(/[ \t]+/g, ' ').trim() ?? '';
    return {
      textSample: text.slice(0, 700),
      hasBodyLoadingFallback: !!dialog?.querySelector('[aria-label="Loading page body"][aria-busy="true"]'),
      hasEditorLoadingDatabase: !!dialog?.querySelector('[data-editor-loading-database]'),
      hasInlineDatabaseFallback: !!dialog?.querySelector('[data-inline-database-fallback]'),
      hasUntitledVisible: /\bUntitled\b/.test(text),
      hasEmptyBodyPrompt: !!dialog?.querySelector(
        '[data-editor-page][data-empty-body-prompt-visible="true"] [role="textbox"][aria-placeholder="Press Enter to continue with an empty page."][data-empty="true"][data-page-placeholder="true"]',
      ),
    };
  }, rowTitle);
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database row peek smoke');

  const suffix = Date.now();
  const databaseId = crypto.randomUUID();
  const databaseTitle = `Row peek smoke ${suffix}`;
  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: databaseTitle,
    viewType: 'table',
  });
  assert(created?.page?.id === databaseId, 'database row peek smoke database must be created');
  assert(Array.isArray(created?.rows) && created.rows.length >= 2, 'database row peek smoke needs seeded rows');
  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database row peek smoke must receive a default table view');
  const statusProp = created.properties?.find((prop) => prop.type === 'status');
  const statusPropId = statusProp?.id;
  assert(statusPropId, 'database row peek smoke must receive a status property');
  const statusOptions = Array.isArray(statusProp.config?.options) ? statusProp.config.options : [];
  const firstStatus = statusOptions[0]?.id ?? statusOptions[0]?.name;
  const secondStatus = statusOptions[1]?.id ?? statusOptions[1]?.name ?? firstStatus;
  assert(firstStatus && secondStatus, 'database row peek smoke status property must have options');

  const [rowOne, rowTwo] = created.rows;
  const rowOneTitle = `Row peek alpha ${suffix}`;
  const rowTwoTitle = `Row peek beta ${suffix}`;
  const relatedDatabaseId = crypto.randomUUID();
  const relatedDatabaseTitle = `Row peek related ${suffix}`;
  const relatedTitle = `Related account ${suffix}`;
  const relatedCreated = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: relatedDatabaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: relatedDatabaseTitle,
    viewType: 'table',
  });
  const relatedRow = relatedCreated?.rows?.[0];
  assert(relatedRow?.id, 'database row peek smoke needs a related database row');
  await updateRow(baseUrl, session.accessToken, relatedRow.id, { title: relatedTitle });
  const accountPropId = crypto.randomUUID();
  const memoPropId = crypto.randomUUID();
  const duePropId = crypto.randomUUID();
  const amountPropId = crypto.randomUUID();
  const relationPropId = crypto.randomUUID();
  const classificationPropId = crypto.randomUUID();
  const classificationFirstOption = { id: crypto.randomUUID(), name: '공급처', color: 'blue' };
  const classificationSecondOption = { id: crypto.randomUUID(), name: '설치업체(기사)', color: 'green' };
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: accountPropId,
      databaseId,
      name: '계좌정보',
      type: 'rich_text',
      position: 4,
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: memoPropId,
      databaseId,
      name: '메모',
      type: 'rich_text',
      position: 5,
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: duePropId,
      databaseId,
      name: 'Due',
      type: 'date',
      position: 6,
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: amountPropId,
      databaseId,
      name: 'Amount',
      type: 'number',
      position: 7,
      config: { numberFormat: 'won' },
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: relationPropId,
      databaseId,
      name: 'Related',
      type: 'relation',
      position: 8,
      config: { relationDatabaseId: relatedDatabaseId },
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: classificationPropId,
      databaseId,
      name: '분류',
      type: 'multi_select',
      position: 9,
      config: { options: [classificationFirstOption, classificationSecondOption] },
    },
  });
  const accountText = [
    '샘플은행 000-000000-00-000',
    '예금주: 주식회사 샘플컴퍼니',
    '개설일 2026-01-02',
  ].join('\n');
  const memoText = [
    '## 본사 기본 정보',
    '- 법인 설립일(등기): 2026.01.02',
    '- 사업자 개업일(등록): 2026.01.03',
    '- 자본금: 1,000,000원',
    '',
    '## 사업자등록증 업태/종목',
    '- 도매 및 소매업 / 자동차 부품 도소매업',
    '- 도매 및 소매업 / 생활용품 도소매업',
  ].join('\n');
  await updateRow(baseUrl, session.accessToken, rowOne.id, {
    title: rowOneTitle,
    properties: {
      [statusPropId]: firstStatus,
      [accountPropId]: accountText,
      [memoPropId]: memoText,
      [duePropId]: '2026-06-24/2026-06-25',
      [amountPropId]: 0,
      [relationPropId]: [relatedRow.id],
      [classificationPropId]: [classificationFirstOption.id],
    },
  });
  await updateRow(baseUrl, session.accessToken, rowTwo.id, {
    title: rowTwoTitle,
    properties: {
      [statusPropId]: secondStatus,
      [duePropId]: '2026-06-26',
    },
  });

  const boardViewId = crypto.randomUUID();
  const listViewId = crypto.randomUUID();
  const galleryViewId = crypto.randomUUID();
  const calendarViewId = crypto.randomUUID();
  const timelineViewId = crypto.randomUUID();
  const visibleProperties = created.properties
    .map((prop) => prop.id)
    .concat(accountPropId, memoPropId, duePropId, amountPropId, relationPropId, classificationPropId);
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_views',
    records: [
      {
        id: boardViewId,
        databaseId,
        name: 'Board',
        type: 'board',
        position: 2,
        config: { groupBy: statusPropId, visibleProperties, cardSize: 'medium' },
      },
      {
        id: listViewId,
        databaseId,
        name: 'List',
        type: 'list',
        position: 3,
        config: { visibleProperties },
      },
      {
        id: galleryViewId,
        databaseId,
        name: 'Gallery',
        type: 'gallery',
        position: 4,
        config: { visibleProperties, cardSize: 'medium' },
      },
      {
        id: calendarViewId,
        databaseId,
        name: 'Calendar',
        type: 'calendar',
        position: 5,
        config: { calendarBy: duePropId, visibleProperties },
      },
      {
        id: timelineViewId,
        databaseId,
        name: 'Timeline',
        type: 'timeline',
        position: 6,
        config: { timelineBy: duePropId, timelineZoom: 'day', visibleProperties },
      },
    ],
  });

  const nestedDatabaseId = crypto.randomUUID();
  const nestedCreated = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: nestedDatabaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Nested row peek target ${suffix}`,
    viewType: 'table',
  });
  const nestedViewId = nestedCreated?.views?.[0]?.id;
  const nestedRow = nestedCreated?.rows?.[0];
  const nestedRowTitle = `Nested payment row ${suffix}`;
  assert(nestedViewId, 'database row peek smoke nested database must receive a table view');
  assert(nestedRow?.id, 'database row peek smoke nested database must receive a row');
  const nestedTitlePropId = nestedCreated?.properties?.find((prop) => prop.type === 'title')?.id;
  const nestedRelationPropId = crypto.randomUUID();
  assert(nestedTitlePropId, 'database row peek smoke nested database must receive a title property');
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: nestedRelationPropId,
      databaseId: nestedDatabaseId,
      name: 'Relation',
      type: 'relation',
      position: 4,
      config: { relationDatabaseId: relatedDatabaseId },
    },
  });
  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: nestedViewId,
    databaseId: nestedDatabaseId,
    patch: {
      config: {
        visibleProperties: [nestedTitlePropId, nestedRelationPropId],
        propertyOrder: [nestedTitlePropId, nestedRelationPropId],
        propertyWidths: {
          [nestedTitlePropId]: 260,
          [nestedRelationPropId]: 220,
        },
      },
    },
  });
  await updateRow(baseUrl, session.accessToken, nestedRow.id, {
    title: nestedRowTitle,
    properties: { [nestedRelationPropId]: [relatedRow.id] },
  });
  const nestedInlineBlock = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: crypto.randomUUID(),
        pageId: rowTwo.id,
        parentId: null,
        type: 'inline_database',
        content: { childPageId: nestedDatabaseId, databaseViewId: nestedViewId },
        plainText: `Nested inline ${nestedRowTitle}`,
        position: 1,
      },
    ],
  });
  assert(
    nestedInlineBlock?.blocks?.length === 1,
    'database row peek smoke nested inline database block must be created',
  );

  const inlinePageId = crypto.randomUUID();
  const inlineBlockId = crypto.randomUUID();
  const inlinePageTitle = `Row peek inline host ${suffix}`;
  const inlinePage = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: inlinePageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: inlinePageTitle,
    icon: '🧭',
    iconType: 'emoji',
    cover: '',
    coverPosition: 50,
    position: suffix + 10,
  });
  assert(inlinePage?.page?.id === inlinePageId, 'database row peek smoke inline host page must be created');
  const inlineBlock = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: inlineBlockId,
        pageId: inlinePageId,
        parentId: null,
        type: 'inline_database',
        content: { childPageId: databaseId, databaseViewId: tableViewId },
        plainText: `Inline ${rowOneTitle}`,
        position: 1,
      },
    ],
  });
  assert(inlineBlock?.blocks?.length === 1, 'database row peek smoke inline database block must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    databaseTitle,
    relatedDatabaseId,
    relatedDatabaseTitle,
    nestedDatabaseId,
    inlinePageId,
    inlinePageTitle,
    tableViewId,
    boardViewId,
    listViewId,
    galleryViewId,
    calendarViewId,
    timelineViewId,
    rowOneId: rowOne.id,
    rowTwoId: rowTwo.id,
    nestedRowId: nestedRow.id,
    nestedRelationPropId,
    rowOneTitle,
    rowTwoTitle,
    nestedRowTitle,
    accountPropId,
    accountText,
    memoPropId,
    memoText,
    amountPropId,
    relationPropId,
    classificationPropId,
    classificationFirstLabel: classificationFirstOption.name,
    classificationSecondLabel: classificationSecondOption.name,
    relatedRowId: relatedRow.id,
    relatedTitle,
  };
}

async function updateRow(baseUrl, token, rowId, patch) {
  const updated = await callFunction(baseUrl, token, 'database-row-mutation', {
    action: 'update',
    id: rowId,
    patch,
  });
  if (patch.title) assert(updated?.row?.title === patch.title, `row ${rowId} title must be updated`);
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
  });
  if (seed.relatedDatabaseId) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id: seed.relatedDatabaseId,
    }).catch(() => {});
  }
  if (seed.nestedDatabaseId) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id: seed.nestedDatabaseId,
    }).catch(() => {});
  }
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId, theme }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', theme);
  }, {
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
    theme: options.theme,
  });
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
    'Playwright is required for database row peek smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    onlyInlinePropertySelect: false,
    onlyMenuDismissAudit: false,
    onlyRowPeekMotion: false,
    onlyRowSelect: false,
    theme: 'light',
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
    if (arg === '--only-row-select') {
      parsed.onlyRowSelect = true;
      continue;
    }
    if (arg === '--only-inline-property-select') {
      parsed.onlyInlinePropertySelect = true;
      continue;
    }
    if (arg === '--only-menu-dismiss-audit') {
      parsed.onlyMenuDismissAudit = true;
      continue;
    }
    if (arg === '--only-row-peek-motion') {
      parsed.onlyRowPeekMotion = true;
      continue;
    }
    if (arg === '--theme') {
      parsed.theme = resolveValue(args, i, arg);
      if (parsed.theme !== 'light' && parsed.theme !== 'dark') {
        throw new Error('--theme must be "light" or "dark"');
      }
      i += 1;
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
  console.log(`Usage: node scripts/database-row-peek-smoke.mjs [options]

Checks database row opening modes, row preview URL behavior, and the body-loading fallback with DOM assertions only.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --only-row-select       Check the row-detail multi-select menu click flow only.
  --only-inline-property-select
                          Check an inline database relation property dropdown inside row peek only.
  --only-menu-dismiss-audit
                          Check representative database menus close from row peek/outside clicks.
  --only-row-peek-motion  Check row side peek open/close animation only.
  --theme <light|dark>    Browser theme preference for captures. Defaults to light.
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

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
