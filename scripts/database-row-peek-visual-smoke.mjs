#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAuthStorageKeys, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'row-peek');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database row peek visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Database row peek visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Database row peek visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedDatabase(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureRowPeekVariant(browser, appUrl, seed, {
      mode: 'side',
      prefix: 'desktop-side',
      target: seed.targets.desktopSide,
      viewport: { width: 1440, height: 1000 },
    });
    await captureRowPeekVariant(browser, appUrl, seed, {
      mode: 'side',
      prefix: 'desktop-side-dark',
      target: seed.targets.desktopSideDark,
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
    });
    await captureRowPeekVariant(browser, appUrl, seed, {
      mode: 'center',
      prefix: 'desktop-center',
      target: seed.targets.desktopCenter,
      viewport: { width: 1440, height: 1000 },
    });
    await captureRowPeekVariant(browser, appUrl, seed, {
      mobile: true,
      mode: 'side',
      prefix: 'mobile-side',
      target: seed.targets.mobileSide,
      viewport: { width: 390, height: 844 },
    });
    await captureRowPeekVariant(browser, appUrl, seed, {
      mobile: true,
      mode: 'side',
      prefix: 'mobile-side-dark',
      target: seed.targets.mobileSideDark,
      theme: 'dark',
      viewport: { width: 390, height: 844 },
    });
    await captureRowPeekVariant(browser, appUrl, seed, {
      mode: 'side',
      prefix: 'desktop-public-side',
      target: seed.targets.desktopPublicSide,
      viewport: { width: 1440, height: 1000 },
    });

    console.log('PASS database row peek visuals are captured and stay within the Notion-style layout contract.');
    for (const name of ['desktop-side', 'desktop-side-dark', 'desktop-center', 'mobile-side', 'mobile-side-dark', 'desktop-public-side']) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}-row-peek.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureRowPeekVariant(browser, appUrl, seed, variant) {
  console.log(`Capture: ${variant.prefix}`);
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, variant.target, variant.theme ?? 'light');

  try {
    await openDatabase(page, appUrl, variant.target);
    if (variant.mode === 'center') await setOpenPagesIn(page, 'Center');
    await openRow(page, variant.target.rowTitle);
    await page.getByText(variant.target.bodyText, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await assertRowPeekContract(page, variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-row-peek.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} row peek visual flow`);
  } catch (error) {
    const state = await captureFailureState(page, variant).catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${variant.prefix} row peek variant failed: ${message}\n${formatFailureState(state)}`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureFailureState(page, variant) {
  const screenshotPath = join(options.screenshotDir, `${variant.prefix}-failure.png`);
  const statePath = join(options.screenshotDir, `${variant.prefix}-failure.json`);
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  const state = await page.evaluate(() => ({
    bodyText: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 1000),
    buttons: Array.from(document.querySelectorAll('button')).slice(0, 40).map((button) => ({
      aria: button.getAttribute('aria-label'),
      text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      visible: button instanceof HTMLElement && button.offsetParent !== null,
    })),
    inputs: Array.from(document.querySelectorAll('input')).slice(0, 20).map((input) => ({
      aria: input.getAttribute('aria-label'),
      value: input.value,
      visible: input.offsetParent !== null,
    })),
    tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => ({
      aria: tab.getAttribute('aria-label'),
      text: tab.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      visible: tab instanceof HTMLElement && tab.offsetParent !== null,
    })),
    title: document.title,
    url: location.href,
  }));
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { screenshotPath, state, statePath };
}

function formatFailureState(result) {
  if ('error' in result) return `Failure diagnostics could not be captured: ${result.error}`;
  return [
    `Failure screenshot: ${result.screenshotPath}`,
    `Failure state: ${result.statePath}`,
    `Page title: ${result.state.title}`,
    `Visible tabs: ${result.state.tabs.filter((tab) => tab.visible).map((tab) => tab.aria || tab.text).join(', ') || '(none)'}`,
    `Body: ${result.state.bodyText.slice(0, 240)}`,
  ].join('\n');
}

async function openDatabase(page, baseUrl, target) {
  const path = target.shareToken
    ? `/share/${encodeURIComponent(target.shareToken)}?page=${encodeURIComponent(target.databaseId)}`
    : `/database/${target.databaseId}`;
  await page.goto(resolveUrl(baseUrl, path), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: 'Table' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await rowTitleTarget(page, target.rowTitle);
}

async function openRow(page, rowTitle) {
  const target = await rowTitleTarget(page, rowTitle);
  await target.locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await target.locator.hover({ timeout: options.timeoutMs }).catch(() => {});
  if (target.kind === 'input') {
    await target.locator.focus({ timeout: options.timeoutMs });
  }
  if (!(await clickVisibleOpenRowButton(page, rowTitle))) {
    if (target.kind === 'input') await page.keyboard.press('Control+Enter');
    else await target.locator.dblclick({ timeout: options.timeoutMs });
  }
  await rowPeekDialog(page, rowTitle);
}

async function clickVisibleOpenRowButton(page, rowTitle) {
  const button = page.getByRole('button', { name: `Open ${rowTitle}` });
  try {
    await button.waitFor({ state: 'visible', timeout: 2500 });
    await button.click({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function setOpenPagesIn(page, label) {
  await page.getByRole('button', { name: 'Layout' }).click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Layout options' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('radio', { name: label }).click({ timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Close layout options' }).click({ timeout: options.timeoutMs });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function rowTitleTarget(page, rowTitle) {
  const inputIndex = await page.locator('input').evaluateAll(
    (inputs, title) =>
      inputs.findIndex((input) => input.value === title && input.offsetParent !== null),
    rowTitle,
  );
  if (inputIndex >= 0) {
    return { kind: 'input', locator: page.locator('input').nth(inputIndex) };
  }

  const cell = page
    .locator('[data-table-cell][data-col-index="0"]')
    .filter({ hasText: rowTitle })
    .first();
  await cell.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return { kind: 'cell', locator: cell };
}

async function rowPeekDialog(page, rowTitle) {
  const dialog = page.getByRole('dialog', { name: `${rowTitle} preview` });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function assertRowPeekContract(page, variant) {
  const metrics = await page.evaluate(({ rowTitle, bodyText }) => {
    const dialog = document.querySelector(`[role="dialog"][aria-label="${cssString(rowTitle)} preview"]`);
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing row peek dialog' };
    const rect = dialog.getBoundingClientRect();
    const top = dialog.querySelector('[class*="rowPeekTop"]');
    const context = dialog.querySelector('[class*="rowPeekContext"]');
    const actions = dialog.querySelector('[class*="rowPeekActions"]');
    const doc = dialog.querySelector('[class*="rowPeekDoc"]');
    const title = dialog.querySelector('[role="textbox"][aria-label="Page title"]');
    const props = dialog.querySelector('[class*="rowProperties"]');
    const editor = dialog.querySelector('[class*="rowPeekEditor"]');
    const resize = dialog.querySelector('[role="separator"][aria-label="Resize side preview"]');
    const topRect = top instanceof HTMLElement ? top.getBoundingClientRect() : null;
    const contextRect = context instanceof HTMLElement ? context.getBoundingClientRect() : null;
    const actionsRect = actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
    const docRect = doc instanceof HTMLElement ? doc.getBoundingClientRect() : null;
    const titleRect = title instanceof HTMLElement ? title.getBoundingClientRect() : null;
    const titleLineRects = title instanceof HTMLElement ? mergedLineRects(title) : [];
    const propsRect = props instanceof HTMLElement ? props.getBoundingClientRect() : null;
    const editorRect = editor instanceof HTMLElement ? editor.getBoundingClientRect() : null;
    const textValue = (item) => {
      if (!(item instanceof HTMLElement)) return '';
      if (item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement) return item.value;
      return (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const seededBodyBlock =
      Array.from(dialog.querySelectorAll('[data-block-id]')).find((item) =>
        textValue(item).includes(bodyText),
      ) ??
      Array.from(dialog.querySelectorAll('[role="textbox"], [contenteditable="true"], input, textarea')).find((item) =>
        textValue(item).includes(bodyText),
      );
    const seededBodyRect = seededBodyBlock instanceof HTMLElement ? seededBodyBlock.getBoundingClientRect() : null;
    const actionButtons = Array.from(actions?.querySelectorAll('button') ?? []).filter(
      (button) => button instanceof HTMLElement && button.offsetParent !== null,
    );
    const labels = actionButtons.map((button) =>
      Array.from(button.querySelectorAll('span')).some((span) => span instanceof HTMLElement && span.offsetParent !== null),
    );
    const labelMetrics = actionButtons.flatMap((button) =>
      Array.from(button.querySelectorAll('span'))
        .filter((span) => span instanceof HTMLElement && span.offsetParent !== null)
        .map((span) => ({
          buttonAria: button.getAttribute('aria-label') ?? '',
          clientWidth: span.clientWidth,
          scrollWidth: span.scrollWidth,
          text: span.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          width: span.getBoundingClientRect().width,
          lineCount: span.getClientRects().length,
        })),
    );
    const visibleCrumbTitles = Array.from(context?.querySelectorAll('[class*="rowPeekCrumbTitle"]') ?? [])
      .filter((item) => item instanceof HTMLElement && item.offsetParent !== null)
      .map((item) => {
        const itemRect = item.getBoundingClientRect();
        return {
          text: item.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          width: itemRect.width,
          scrollWidth: item.scrollWidth,
          clientWidth: item.clientWidth,
        };
      });
    const visibleCrumbSeparators = Array.from(context?.querySelectorAll('[class*="rowPeekCrumbSep"]') ?? [])
      .filter((item) => item instanceof SVGElement && item.getClientRects().length > 0);
    return {
      ok: true,
      actionButtonCount: actionButtons.length,
      actionLabelMaxLineCount: Math.max(0, ...labelMetrics.map((label) => label.lineCount)),
      actionLabelClippedTexts: labelMetrics
        .filter((label) => label.scrollWidth > label.clientWidth + 1)
        .map((label) => label.text || label.buttonAria),
      actionLabelWrappedTexts: labelMetrics
        .filter((label) => label.lineCount > 1)
        .map((label) => label.text),
      visibleActionLabelTexts: labelMetrics.map((label) => label.text).filter(Boolean),
      actionsLeft: actionsRect?.left ?? null,
      actionsRight: actionsRect?.right ?? null,
      bodyScrollWidth: document.body.scrollWidth,
      bottomGap: window.innerHeight - rect.bottom,
      contextLeft: contextRect?.left ?? null,
      contextRight: contextRect?.right ?? null,
      docLeft: docRect?.left ?? null,
      docRight: docRect?.right ?? null,
      documentScrollWidth: document.documentElement.scrollWidth,
      editorTop: editorRect?.top ?? null,
      hasResize: resize instanceof HTMLElement && resize.offsetParent !== null,
      height: rect.height,
      labeledActionCount: labels.filter(Boolean).length,
      left: rect.left,
      mode: dialog.getAttribute('data-mode'),
      propsTop: propsRect?.top ?? null,
      rightGap: window.innerWidth - rect.right,
      titleLeft: titleRect?.left ?? null,
      titleLineCount: titleLineRects.length,
      titleLineRects,
      titleLastLineWidth: titleLineRects.at(-1)?.width ?? 0,
      titleMaxLineWidth: titleLineRects.length
        ? Math.max(...titleLineRects.map((line) => line.width))
        : 0,
      titleTop: titleRect?.top ?? null,
      top: rect.top,
      topHeight: topRect?.height ?? 0,
      seededBodyBlockExists: seededBodyBlock instanceof HTMLElement,
      seededBodyBlockTop: seededBodyRect?.top ?? null,
      seededBodyBlockBottom: seededBodyRect?.bottom ?? null,
      seededBodyBlockHeight: seededBodyRect?.height ?? null,
      seededBodyBlockText: seededBodyBlock instanceof HTMLElement
        ? textValue(seededBodyBlock)
        : '',
      visibleCrumbCount: visibleCrumbTitles.length,
      visibleCrumbMinWidth: visibleCrumbTitles.length
        ? Math.min(...visibleCrumbTitles.map((item) => item.width))
        : 0,
      visibleCrumbSeparators: visibleCrumbSeparators.length,
      visibleCrumbTitles,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };

    function cssString(value) {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function mergedLineRects(element) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const segments = Array.from(range.getClientRects())
        .map((line) => ({
          bottom: line.bottom,
          height: line.height,
          left: line.left,
          right: line.right,
          top: line.top,
          width: line.width,
        }))
        .filter((line) => line.width > 1 && line.height > 1);
      range.detach();
      const lines = [];
      for (const segment of segments) {
        const line = lines.find((item) => Math.abs(item.top - segment.top) <= 2);
        if (line) {
          line.bottom = Math.max(line.bottom, segment.bottom);
          line.height = Math.max(line.height, segment.height);
          line.left = Math.min(line.left, segment.left);
          line.right = Math.max(line.right, segment.right);
          line.width = line.right - line.left;
        } else {
          lines.push({ ...segment });
        }
      }
      return lines;
    }
  }, { bodyText: variant.target.bodyText, rowTitle: variant.target.rowTitle });

  assert(metrics.ok, metrics.reason ?? 'row peek visual contract could not run');
  assert(metrics.mode === variant.mode, `Row peek mode should be ${variant.mode}, got ${metrics.mode}`);
  assert(metrics.actionButtonCount >= 4, `Row peek should expose compact actions, got ${metrics.actionButtonCount}`);
  const minTopHeight = variant.mobile ? 38 : 42;
  assert(metrics.topHeight >= minTopHeight && metrics.topHeight <= 52, `Row peek top bar height drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.contextLeft !== null && metrics.actionsLeft !== null && metrics.contextRight < metrics.actionsLeft, `Row peek crumb/actions should not collide: ${JSON.stringify(metrics)}`);
  assert(metrics.actionsRight !== null && metrics.actionsRight <= metrics.left + metrics.width - 8, `Row peek actions should stay inside the top rail: ${JSON.stringify(metrics)}`);
  assert(metrics.titleLeft !== null && metrics.docLeft !== null, `Row peek title/document gutter should be measurable: ${JSON.stringify(metrics)}`);
  const titleInset = metrics.titleLeft - metrics.docLeft;
  assert(titleInset >= (variant.mobile ? 24 : 72) && titleInset <= (variant.mobile ? 36 : 96), `Row peek title gutter drifted: ${JSON.stringify({ titleInset, metrics })}`);
  assert(metrics.titleLineCount <= (variant.mobile ? 3 : 2), `Row peek title should not fragment into too many lines: ${JSON.stringify(metrics.titleLineRects)}`);
  assert(
    metrics.titleLineCount < 2 ||
      metrics.titleLastLineWidth >= Math.min(140, metrics.titleMaxLineWidth * 0.42),
    `Row peek title should avoid orphaned short final lines: ${JSON.stringify(metrics.titleLineRects)}`,
  );
  assert(metrics.propsTop !== null && metrics.editorTop !== null && metrics.propsTop < metrics.editorTop, `Row peek properties should sit above the editor: ${JSON.stringify(metrics)}`);
  assert(metrics.seededBodyBlockExists, `Row peek should render seeded body content, not only properties: ${JSON.stringify(metrics)}`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `Row peek should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);

  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `Mobile row peek should run in a narrow viewport, got ${Math.round(metrics.viewportWidth)}px`);
    assert(metrics.width <= metrics.viewportWidth + 2, `Mobile row peek should fit the viewport, got ${Math.round(metrics.width)}px`);
    assert(metrics.left <= 1 && metrics.rightGap <= 1, `Mobile side row peek should fill the viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.titleLeft !== null && metrics.titleLeft - metrics.left >= 24, `Mobile row peek content gutter is too tight: ${JSON.stringify(metrics)}`);
    assert(metrics.labeledActionCount <= 1, `Mobile row peek actions should collapse text labels: ${JSON.stringify(metrics)}`);
    assert(metrics.visibleCrumbCount === 1, `Mobile row peek top rail should expose one readable source crumb, not multiple truncated breadcrumbs: ${JSON.stringify(metrics)}`);
    assert(metrics.visibleCrumbSeparators === 0, `Mobile row peek top rail should hide breadcrumb separators to avoid clipped R... > R... chrome: ${JSON.stringify(metrics)}`);
    assert(metrics.visibleCrumbMinWidth >= 112, `Mobile row peek source crumb should remain readable instead of collapsing to a tiny ellipsis: ${JSON.stringify(metrics)}`);
    assert(
      metrics.seededBodyBlockTop !== null &&
        metrics.seededBodyBlockTop <= metrics.viewportHeight - 180 &&
        metrics.seededBodyBlockBottom > 0,
      `Mobile row peek should show seeded body content in the first viewport instead of looking empty below properties: ${JSON.stringify(metrics)}`,
    );
    assert(!metrics.hasResize, 'Mobile side row peek should hide the resize handle.');
    return;
  }

  assert(
    metrics.actionLabelMaxLineCount <= 1,
    `Desktop row peek action labels should not wrap across lines: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.actionLabelClippedTexts.length === 0,
    `Desktop row peek action labels should not be clipped into icon-sized controls: ${JSON.stringify(metrics)}`,
  );
  const expectedActionLabels = variant.target.shareToken
    ? ['Copy link', 'Open as page']
    : ['Comment', 'Copy link', 'Open as page'];
  for (const expectedActionLabel of expectedActionLabels) {
    assert(
      metrics.visibleActionLabelTexts.includes(expectedActionLabel),
      `Desktop row peek should keep the ${expectedActionLabel} action label visible: ${JSON.stringify(metrics)}`,
    );
  }
  assert(
    metrics.seededBodyBlockTop !== null && metrics.seededBodyBlockTop <= metrics.viewportHeight - 160,
    `Desktop row peek seeded body content should be visible without deep scrolling: ${JSON.stringify(metrics)}`,
  );

  if (variant.mode === 'side') {
    assert(metrics.top === 0 && metrics.bottomGap === 0, `Side row peek should fill viewport height: ${JSON.stringify(metrics)}`);
    assert(metrics.rightGap <= 1, `Side row peek should dock to the right edge: ${JSON.stringify(metrics)}`);
    assert(metrics.width >= 700 && metrics.width <= 820, `Side row peek width drifted: ${JSON.stringify(metrics)}`);
    assert(metrics.hasResize, 'Desktop side row peek should show the resize handle.');
    return;
  }

  assert(metrics.top >= 48 && metrics.bottomGap >= 48, `Center row peek should keep modal gutters: ${JSON.stringify(metrics)}`);
  assert(metrics.left >= 40 && metrics.rightGap >= 40, `Center row peek should be centered with side gutters: ${JSON.stringify(metrics)}`);
  assert(metrics.width >= 680 && metrics.width <= 780, `Center row peek width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.height <= metrics.viewportHeight * 0.9, `Center row peek should not exceed modal height: ${JSON.stringify(metrics)}`);
}

async function seedDatabase(baseUrl) {
  const targets = {};
  const variants = ['desktopSide', 'desktopSideDark', 'desktopCenter', 'mobileSide', 'mobileSideDark', 'desktopPublicSide'];
  const databaseTitles = [
    '거래처 운영 데이터베이스',
    '월간 장부 관리 데이터베이스',
    '대표님 보고 자료 데이터베이스',
    '자금 흐름 점검 데이터베이스',
    '자료DB 연결 상태 데이터베이스',
    '공개 공유 거래처 데이터베이스',
  ];
  const rowTitles = [
    '장기 미수 거래처 정리 계획',
    '월별 세금계산서 발행 확인 요청',
    '대표님 보고용 지표 마감 검토',
    '자금 흐름 확인 회의 준비',
    '자료DB 연결 상태 점검',
    '공개 공유 거래처 검토 메모',
  ];
  for (const [index, key] of variants.entries()) {
    const session = await signIn(baseUrl);
    const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
    const workspaceId = bootstrap?.workspace?.id;
    assert(workspaceId, 'workspace-bootstrap must return a workspace id for database row peek visual smoke');
    const databaseId = randomUUID();
    const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
      action: 'createDatabase',
      id: databaseId,
      workspaceId,
      parentId: null,
      parentType: 'workspace',
      title: databaseTitles[index],
      viewType: 'table',
    });
    assert(created?.page?.id === databaseId, 'database row peek visual smoke database must be created');
    assert(Array.isArray(created?.rows) && created.rows.length >= 1, 'database row peek visual smoke needs seeded rows');
    const row = created.rows[0];
    const rowTitle = rowTitles[index];
    await updateRowTitle(baseUrl, session.accessToken, row.id, rowTitle);
    const bodySeed = await addRowBodyBlocks(baseUrl, session.accessToken, row.id, index);
    const publicShare =
      key === 'desktopPublicSide'
        ? await callFunction(baseUrl, session.accessToken, 'share-mutation', {
            action: 'setWebSharing',
            pageId: databaseId,
            enabled: true,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          })
        : null;
    targets[key] = {
      accessToken: session.accessToken,
      bodyText: bodySeed.paragraphText,
      databaseId,
      refreshToken: session.refreshToken,
      rowId: row.id,
      rowTitle,
      shareToken: publicShare?.shareLink?.token ?? null,
      workspaceId,
    };
    if (key === 'desktopPublicSide') {
      assert(targets[key].shareToken, 'database row peek visual smoke public database must get a share token');
    }
  }

  return { targets };
}

async function updateRowTitle(baseUrl, token, rowId, title) {
  const updated = await callFunction(baseUrl, token, 'database-row-mutation', {
    action: 'update',
    id: rowId,
    patch: { title },
  });
  assert(updated?.row?.title === title, `row ${rowId} title must be updated`);
}

async function addRowBodyBlocks(baseUrl, token, pageId, index) {
  const paragraph = [
    '거래처별 입금 예정일과 담당자 메모를 한 화면에서 검토합니다.',
    '세금계산서 발행 상태와 다음 확인 일정을 함께 정리합니다.',
    '보고 전에 숫자, 상태값, 공유 범위를 마지막으로 점검합니다.',
    '자금 흐름 회의 전에 수금 일정과 보류 사유를 확인합니다.',
    '자료DB 연결 상태와 누락된 문서 링크를 빠르게 확인합니다.',
    '공개 공유 상태에서도 행 미리보기의 핵심 내용을 읽을 수 있어야 합니다.',
  ][index];
  const todoText = [
    '담당자에게 확인 요청 보내기',
    '증빙 자료와 입금 예정일 비교하기',
    '공유 전 보고 숫자 재확인하기',
    '회의 전 보류 사유 메모하기',
    '누락된 문서 링크 보완하기',
    '읽기 전용 공유 링크 표시 확인하기',
  ][index];
  const blocks = [
    {
      id: randomUUID(),
      pageId,
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: paragraph }] },
      plainText: paragraph,
      position: 1,
    },
    {
      id: randomUUID(),
      pageId,
      parentId: null,
      type: 'to_do',
      content: { rich: [{ text: todoText }], checked: false },
      plainText: todoText,
      position: 2,
    },
  ];
  const created = await callFunction(baseUrl, token, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(created?.blocks?.length === blocks.length, 'database row peek visual smoke blocks must be created');
  return { paragraphText: paragraph };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.targets) return;
  for (const target of Object.values(seed.targets)) {
    if (!target?.accessToken) continue;
    await permanentlyDeletePage(baseUrl, target.accessToken, target.databaseId, { call: callFunction }).catch(() => {});
  }
}

async function seedSession(context, target, theme = 'light') {
  if (target.shareToken) {
    await context.addInitScript(({ theme }) => {
      window.localStorage.setItem('hanji:theme', theme);
    }, { theme });
    return;
  }
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId, theme }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', theme);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: target.refreshToken,
    theme,
    workspaceId: target.workspaceId,
  });
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
    'Playwright is required for database row peek visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/database-row-peek-visual-smoke.mjs [options]

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
