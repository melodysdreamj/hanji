#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBrowserSession, installBrowserSession, permanentlyDeletePage } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'database-properties');
const PROPERTY_DIALOG_LABEL = 'Property visibility';
const SHOWN_SECTION_LABEL = 'Shown in table';
const HIDDEN_SECTION_LABEL = 'Hidden in table';
const PROPERTY_FIXTURE = {
  title: '샘플대상명',
  status: '진행 상태',
  notes: '검토 메모 및 후속 조치',
  done: '계약서 확인',
  due: '정산 예정일',
  relation: '관련 계약 문서',
  files: '첨부 파일',
  hiddenMemo: '숨긴 내부 메모',
  targetTitle: '법무팀 검토 문서',
  linkedFileName: '계약서_검토_요청_자료.pdf',
  options: {
    todo: '검토 대기',
    doing: '진행 중',
    done: '완료',
  },
  descriptions: {
    title: '회사는 상호명, 개인은 실명으로 입력. 예: 샘플대상명',
    status: '현재 거래 상태 선택. 거래중, 보류, 종료 등',
    notes: '이 거래처에서 우리와 소통하는 실무 담당자와 후속 조치',
    done: '계약서 수령 및 검토 완료 여부',
    due: '정산 또는 다음 확인 예정일',
    relation: '이 거래처와 연결된 계약 문서',
    files: '거래처 관련 파일과 첨부 자료',
    hiddenMemo: '숨겨 둔 내부 검토 메모',
  },
};

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database property visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Database property visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Database property visual smoke API target: ${apiUrl}`);

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
    if (options.onlyToolbarProperties) {
      await capturePropertyVariant(browser, appUrl, seed, {
        prefix: 'desktop-toolbar-properties',
        viewport: { width: 1440, height: 1000 },
        open: openToolbarPropertiesMenu,
        contract: toolbarPropertiesContract([330, 390]),
      });
      await capturePropertyVariant(browser, appUrl, seed, {
        prefix: 'desktop-toolbar-properties-dark',
        viewport: { width: 1440, height: 1000 },
        theme: 'dark',
        open: openToolbarPropertiesMenu,
        contract: toolbarPropertiesContract([330, 390]),
      });
      await capturePropertyVariant(browser, appUrl, seed, {
        prefix: 'mobile-toolbar-properties',
        viewport: { width: 390, height: 844 },
        mobile: true,
        open: openToolbarPropertiesMenu,
        contract: toolbarPropertiesContract([300, 390]),
      });
      await assertToolbarPropertiesInteractions(browser, appUrl, apiUrl, seed);
      console.log('PASS toolbar property visibility panel matches the requested Korean visibility/reorder contract.');
      for (const name of [
        'desktop-toolbar-properties',
        'desktop-toolbar-properties-dark',
        'mobile-toolbar-properties',
        'desktop-toolbar-properties-interaction',
      ]) {
        console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
      }
      return;
    }
    if (options.onlyPropertyHeaderOptions) {
      await capturePropertyVariant(browser, appUrl, seed, {
        prefix: 'desktop-status-property-menu',
        viewport: { width: 1440, height: 1000 },
        open: openStatusPropertyMenu,
        contract: statusPropertyMenuContract(),
      });
      await capturePropertyVariant(browser, appUrl, seed, {
        prefix: 'desktop-status-property-edit-options',
        viewport: { width: 1440, height: 1000 },
        open: openStatusPropertyEditMenu,
        contract: statusPropertyEditOptionsContract(),
      });
      await assertStatusPropertyOptionCreation(browser, appUrl, apiUrl, seed);
      await assertStatusPropertyNameEnterCloses(browser, appUrl, apiUrl, seed);
      await assertRollupCalculationMenuPlacement(browser, appUrl, seed);
      console.log('PASS property header menu exposes Hanji edit/type routes, persists select/status options, closes name edits on Enter, and keeps rollup selectors in view.');
      for (const name of [
        'desktop-status-property-menu',
        'desktop-status-property-edit-options',
        'desktop-status-property-edit-created',
        'desktop-status-property-enter-closed',
        'desktop-rollup-calculation-menu',
      ]) {
        console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
      }
      return;
    }

    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'desktop-toolbar-properties',
      viewport: { width: 1440, height: 1000 },
      open: openToolbarPropertiesMenu,
      contract: toolbarPropertiesContract([330, 390]),
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'desktop-status-property-menu',
      viewport: { width: 1440, height: 1000 },
      open: openStatusPropertyMenu,
      contract: statusPropertyMenuContract(),
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'desktop-status-property-edit-options',
      viewport: { width: 1440, height: 1000 },
      open: openStatusPropertyEditMenu,
      contract: statusPropertyEditOptionsContract(),
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'desktop-status-select-editor',
      viewport: { width: 1440, height: 1000 },
      open: openStatusCellEditor,
      contract: {
        dialogLabel: 'Edit select property',
        minButtons: 3,
        minInputs: 1,
        minRows: 3,
        expectedTexts: [
          PROPERTY_FIXTURE.options.todo,
          PROPERTY_FIXTURE.options.doing,
          PROPERTY_FIXTURE.options.done,
        ],
        mustFitTexts: [
          PROPERTY_FIXTURE.options.todo,
          PROPERTY_FIXTURE.options.doing,
          PROPERTY_FIXTURE.options.done,
        ],
        width: [240, 300],
      },
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'desktop-due-date-editor',
      viewport: { width: 1440, height: 1000 },
      open: openDueDateEditor,
      contract: {
        dialogLabel: 'Edit date property',
        minButtons: 20,
        minInputs: 1,
        minRows: 28,
        expectedTexts: ['Today', 'Tomorrow', 'Include time', 'End date'],
        width: [240, 300],
      },
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'desktop-relation-editor',
      viewport: { width: 1440, height: 1000 },
      open: openRelationEditor,
      contract: {
        dialogLabel: 'Edit relation property',
        minButtons: 1,
        minInputs: 1,
        minRows: 1,
        expectedTexts: [PROPERTY_FIXTURE.targetTitle],
        mustFitTexts: [PROPERTY_FIXTURE.targetTitle],
        width: [240, 320],
      },
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'desktop-files-editor',
      viewport: { width: 1440, height: 1000 },
      open: openFilesEditor,
      contract: {
        dialogLabel: 'Edit files property',
        minButtons: 2,
        minInputs: 1,
        minRows: 2,
        expectedTexts: ['Upload', PROPERTY_FIXTURE.linkedFileName],
        mustFitTexts: [PROPERTY_FIXTURE.linkedFileName],
        minRowHeight: 14,
        width: [330, 350],
      },
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'mobile-toolbar-properties',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openToolbarPropertiesMenu,
      contract: toolbarPropertiesContract([300, 390]),
    });
    await capturePropertyVariant(browser, appUrl, seed, {
      prefix: 'mobile-files-editor',
      viewport: { width: 390, height: 844 },
      mobile: true,
      open: openFilesEditor,
      contract: {
        dialogLabel: 'Edit files property',
        minButtons: 2,
        minInputs: 1,
        minRows: 2,
        expectedTexts: ['Upload', PROPERTY_FIXTURE.linkedFileName],
        mustFitTexts: [PROPERTY_FIXTURE.linkedFileName],
        minRowHeight: 14,
        width: [260, 340],
      },
    });
    await assertToolbarPropertiesInteractions(browser, appUrl, apiUrl, seed);
    await assertStatusPropertyOptionCreation(browser, appUrl, apiUrl, seed);
    await assertStatusPropertyNameEnterCloses(browser, appUrl, apiUrl, seed);

    console.log('PASS database property menus and cell editors are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-toolbar-properties',
      'desktop-status-property-menu',
      'desktop-status-property-edit-options',
      'desktop-status-select-editor',
      'desktop-due-date-editor',
      'desktop-relation-editor',
      'desktop-files-editor',
      'mobile-toolbar-properties',
      'mobile-files-editor',
      'desktop-toolbar-properties-interaction',
      'desktop-status-property-edit-created',
      'desktop-status-property-enter-closed',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

function toolbarPropertiesContract(width) {
  return {
    dialogLabel: PROPERTY_DIALOG_LABEL,
    minButtons: 4,
    minInputs: 1,
    minRows: 4,
    expectedTexts: [
      PROPERTY_DIALOG_LABEL,
      'Search for a property',
      SHOWN_SECTION_LABEL,
      'Hide all',
      PROPERTY_FIXTURE.title,
      PROPERTY_FIXTURE.status,
      PROPERTY_FIXTURE.notes,
      PROPERTY_FIXTURE.done,
      PROPERTY_FIXTURE.due,
      HIDDEN_SECTION_LABEL,
      'Show all',
      PROPERTY_FIXTURE.hiddenMemo,
    ],
    mustFitTexts: [
      PROPERTY_DIALOG_LABEL,
      SHOWN_SECTION_LABEL,
      PROPERTY_FIXTURE.title,
      PROPERTY_FIXTURE.status,
      PROPERTY_FIXTURE.notes,
      PROPERTY_FIXTURE.done,
      PROPERTY_FIXTURE.due,
      HIDDEN_SECTION_LABEL,
      PROPERTY_FIXTURE.hiddenMemo,
    ],
    width,
  };
}

function statusPropertyMenuContract() {
  return {
    dialogLabel: `${PROPERTY_FIXTURE.status} property options`,
    minButtons: 8,
    minInputs: 0,
    maxRowHeight: 56,
    expectedTexts: [
      PROPERTY_FIXTURE.status,
      'Edit property',
      'Change type',
      'Sort ascending',
      'Hide',
      'Wrap text',
    ],
    mustFitTexts: [PROPERTY_FIXTURE.status, 'Edit property', 'Change type'],
    width: [340, 380],
  };
}

function statusPropertyEditOptionsContract() {
  return {
    dialogLabel: `${PROPERTY_FIXTURE.status} property options`,
    minButtons: 5,
    minInputs: 4,
    minRows: 8,
    maxRowHeight: 112,
    expectedTexts: [
      'Edit property',
      'Name',
      'Type',
      'Description',
      'Options',
      'Add option',
      PROPERTY_FIXTURE.status,
      PROPERTY_FIXTURE.options.todo,
      PROPERTY_FIXTURE.options.doing,
      PROPERTY_FIXTURE.options.done,
    ],
    mustFitTexts: ['Edit property', 'Options', 'Add option'],
    width: [340, 380],
  };
}

async function capturePropertyVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openDatabase(page, appUrl, seed);
    await variant.open(page, appUrl, seed);
    await assertDialogContract(page, variant.contract, { mobile: !!variant.mobile });
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} database property visual flow`);
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertToolbarPropertiesInteractions(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1000 },
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, appUrl, seed);
    await openToolbarPropertiesMenu(page);
    await assertPropertiesPanelInventory(page);
    await assertSinglePropertyDropIndicatorStyle(page);

    const notesRow = propertyManagerRow(page, PROPERTY_FIXTURE.notes);
    await notesRow.locator('[data-property-visible]').first().click({ timeout: options.timeoutMs });
    await waitForPropertiesSection(page, HIDDEN_SECTION_LABEL, PROPERTY_FIXTURE.notes);
    await waitForVisibleProperties(apiUrl, seed, [PROPERTY_FIXTURE.notes], false, 'hidden notes property');

    const hiddenNotesRow = propertyManagerRow(page, PROPERTY_FIXTURE.notes);
    await hiddenNotesRow.locator('[data-property-visible]').first().click({ timeout: options.timeoutMs });
    await waitForPropertiesSection(page, SHOWN_SECTION_LABEL, PROPERTY_FIXTURE.notes);
    await waitForVisibleProperties(apiUrl, seed, [PROPERTY_FIXTURE.notes], true, 'reshown notes property');

    await dragPropertyManagerRow(page, PROPERTY_FIXTURE.due, PROPERTY_FIXTURE.status);
    await waitForViewPropertyConfig(apiUrl, seed, {
      propertyOrderPrefix: ['title', 'due', 'status', 'notes', 'done'],
      visiblePropertiesPrefix: ['title', 'due', 'status', 'notes', 'done'],
      label: 'Properties panel dragged Due before Status',
    });

    await dragPropertyManagerRow(page, PROPERTY_FIXTURE.title, PROPERTY_FIXTURE.status, 'after');
    await waitForViewPropertyConfig(apiUrl, seed, {
      propertyOrderPrefix: ['due', 'status', 'title', 'notes', 'done'],
      visiblePropertiesPrefix: ['due', 'status', 'title', 'notes', 'done'],
      label: 'Properties panel dragged Title after Status',
    });

    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-toolbar-properties-interaction.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'desktop toolbar Properties interaction flow');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertStatusPropertyOptionCreation(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1000 },
  });
  await seedSession(context, seed);
  const createdOption = `검토 승인 ${String(Date.now()).slice(-4)}`;

  try {
    await openDatabase(page, appUrl, seed);
    await openStatusPropertyEditMenu(page);
    const dialog = page.getByRole('dialog', { name: `${PROPERTY_FIXTURE.status} property options` });
    await dialog.getByRole('textbox', { name: 'New option name' }).fill(createdOption, {
      timeout: options.timeoutMs,
    });
    await dialog.getByRole('button', { name: /Add option/ }).click({ timeout: options.timeoutMs });
    await waitForPropertyOption(apiUrl, seed, 'status', createdOption);
    await page.waitForFunction(
      (name) =>
        Array.from(document.querySelectorAll('input')).some(
          (input) => input instanceof HTMLInputElement && input.value === name && input.offsetParent !== null,
        ),
      createdOption,
      { timeout: options.timeoutMs },
    );
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-status-property-edit-created.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'status property edit option creation');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertStatusPropertyNameEnterCloses(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1000 },
  });
  await seedSession(context, seed);
  const nextName = `진행 단계 ${String(Date.now()).slice(-4)}`;

  try {
    await openDatabase(page, appUrl, seed);
    await openStatusPropertyEditMenu(page);
    const dialog = page.getByRole('dialog', { name: /property options$/ });
    const nameInput = dialog.getByLabel('Name', { exact: true });
    await nameInput.fill(nextName, { timeout: options.timeoutMs });
    await dispatchComposingEnter(nameInput);
    await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await nameInput.press('Enter', { timeout: options.timeoutMs });
    await page.waitForFunction(
      () => {
        return !Array.from(document.querySelectorAll('[role="dialog"][aria-label$=" property options"]')).some(
          (element) => element instanceof HTMLElement && isVisible(element),
        );

        function isVisible(element) {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        }
      },
      null,
      { timeout: options.timeoutMs },
    );
    await propertyHeaderButton(page, nextName);
    await waitForPropertyName(apiUrl, seed, 'status', nextName);
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-status-property-enter-closed.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'status property name Enter close');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertRollupCalculationMenuPlacement(browser, appUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 780 },
  });
  await seedSession(context, seed);

  try {
    await openDatabase(page, appUrl, seed);
    const addProperty = page.getByRole('button', { name: 'Add a property' });
    await addProperty.click({ timeout: options.timeoutMs });
    await page.getByRole('menu', { name: 'New property type' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await page.getByRole('menuitem', { name: 'Rollup' }).click({ timeout: options.timeoutMs });

    const rollupHeader = await propertyHeaderButton(page, 'Rollup');
    await rollupHeader.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
    await rollupHeader.click({ timeout: options.timeoutMs });
    const dialog = page.getByRole('dialog', { name: 'Rollup property options' });
    await dialog.getByRole('button', { name: /^Edit property$/ }).click({ timeout: options.timeoutMs });
    await dialog.getByRole('button', { name: 'Rollup calculation' }).click({ timeout: options.timeoutMs });
    await page.getByRole('menu', { name: 'Rollup calculation' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    const metrics = await page.evaluate(() => {
      const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(
        (element) =>
          element instanceof HTMLElement &&
          isVisible(element) &&
          element.getAttribute('aria-label') === 'Rollup calculation',
      );
      if (!(menu instanceof HTMLElement)) return { ok: false, reason: 'missing rollup calculation menu' };
      const rect = menu.getBoundingClientRect();
      const optionRects = Array.from(menu.querySelectorAll('button'))
        .filter((button) => button instanceof HTMLElement && isVisible(button))
        .map((button) => {
          const optionRect = button.getBoundingClientRect();
          return {
            bottom: optionRect.bottom,
            text: button.textContent?.trim() ?? '',
            top: optionRect.top,
          };
        });
      return {
        ok: true,
        bottom: rect.bottom,
        optionRects: optionRects.slice(0, 4),
        top: rect.top,
        viewportHeight: window.innerHeight,
      };

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
    });
    assert(metrics.ok, metrics.reason ?? 'rollup calculation menu placement probe failed');
    assert(metrics.top >= 8, `Rollup calculation menu should not open above the viewport: ${JSON.stringify(metrics)}`);
    assert(
      metrics.bottom <= metrics.viewportHeight - 8,
      `Rollup calculation menu should fit below the viewport edge: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.optionRects.some((item) => item.text === 'Count all' && item.top >= metrics.top && item.bottom <= metrics.bottom),
      `Rollup calculation menu should keep Count all selectable inside the visible menu: ${JSON.stringify(metrics)}`,
    );
    await page.screenshot({
      path: join(options.screenshotDir, 'desktop-rollup-calculation-menu.png'),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, 'rollup calculation menu placement');
  } finally {
    await closeSeededContext(context, seed);
  }
}

async function assertPropertiesPanelInventory(page) {
  const metrics = await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) =>
        element instanceof HTMLElement &&
        isVisible(element) &&
        element.getAttribute('aria-label') === 'Property visibility',
    );
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: 'missing property visibility dialog' };
    const rows = Array.from(dialog.querySelectorAll('[data-property-row]'))
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .map((row) => {
        const handle = row.querySelector('[data-property-drag-handle="true"]');
        const visibility = row.querySelector('[data-property-visible]');
        return {
          visibilityDisabled: visibility instanceof HTMLButtonElement ? visibility.disabled : null,
          visibilityState: visibility instanceof HTMLElement ? visibility.getAttribute('data-property-visible') : null,
          isTitle: row.getAttribute('data-property-title') === 'true',
          handleDisabled: handle instanceof HTMLButtonElement ? handle.disabled : null,
          handleDraggable: handle instanceof HTMLElement ? handle.getAttribute('draggable') : null,
          text: row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
      });
    const text = dialog.textContent ?? '';
    const draggableRows = rows.filter((row) => row.handleDraggable === 'true').length;
    const hiddenRows = rows.filter((row) => row.visibilityState === 'false').length;
    const visibleRows = rows.filter((row) => row.visibilityState === 'true').length;
    return {
      ok: true,
      draggableRows,
      hasTitleVisibilityLockAndDrag: rows.some(
        (row) =>
          row.isTitle &&
          row.visibilityDisabled &&
          row.visibilityState === 'true' &&
          row.handleDisabled === false &&
          row.handleDraggable === 'true',
      ),
      hasVisibilityPanelCopy:
        text.includes('Property visibility') &&
        text.includes('Shown in table') &&
        text.includes('Hidden in table') &&
        text.includes('Hide all') &&
        text.includes('Show all'),
      hiddenRows,
      rowCount: rows.length,
      rows,
      visibleRows,
    };

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  });

  assert(metrics.ok, metrics.reason ?? 'Properties panel inventory could not run');
  assert(metrics.rowCount >= 8, `Properties panel should list shown and hidden properties: ${JSON.stringify(metrics)}`);
  assert(metrics.draggableRows >= 8, `Properties panel rows should expose drag handles for every property, including title: ${JSON.stringify(metrics)}`);
  assert(metrics.visibleRows >= 6, `Properties panel should show visible rows with eye controls: ${JSON.stringify(metrics)}`);
  assert(metrics.hiddenRows >= 1, `Properties panel should show hidden rows with eye-slash controls: ${JSON.stringify(metrics)}`);
  assert(metrics.hasVisibilityPanelCopy, `Properties panel should use the requested Korean visibility copy: ${JSON.stringify(metrics)}`);
  assert(metrics.hasTitleVisibilityLockAndDrag, `Title property should remain visible but still be draggable: ${JSON.stringify(metrics)}`);
}

async function assertSinglePropertyDropIndicatorStyle(page) {
  const metrics = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[data-property-row]')).find(
      (element) => element instanceof HTMLElement && isVisible(element),
    );
    if (!(row instanceof HTMLElement)) return { ok: false, reason: 'missing property row for drop indicator check' };
    const originalOver = row.getAttribute('data-property-drag-over');
    const originalSide = row.getAttribute('data-drop-side');
    const states = [];
    for (const side of ['before', 'after']) {
      row.setAttribute('data-property-drag-over', 'true');
      row.setAttribute('data-drop-side', side);
      const before = window.getComputedStyle(row, '::before');
      const after = window.getComputedStyle(row, '::after');
      states.push({
        afterContent: after.content,
        beforeContent: before.content,
        side,
        visibleCount: Number(hasContent(before)) + Number(hasContent(after)),
      });
    }
    if (originalOver == null) row.removeAttribute('data-property-drag-over');
    else row.setAttribute('data-property-drag-over', originalOver);
    if (originalSide == null) row.removeAttribute('data-drop-side');
    else row.setAttribute('data-drop-side', originalSide);
    return { ok: true, states };

    function hasContent(style) {
      return style.content !== 'none' && style.content !== 'normal' && style.content !== '';
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  });
  assert(metrics.ok, metrics.reason ?? 'drop indicator style check could not run');
  assert(
    metrics.states.every((state) => state.visibleCount === 1),
    `Property drag drop indicator should render one line, not two: ${JSON.stringify(metrics)}`,
  );
}

function propertyManagerRow(page, propertyName) {
  return page.locator('[data-property-row]').filter({ hasText: propertyName }).first();
}

async function waitForPropertiesSection(page, sectionLabel, propertyName) {
  await page.waitForFunction(
    ({ sectionLabel, propertyName }) => {
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (element) =>
          element instanceof HTMLElement &&
          isVisible(element) &&
          element.getAttribute('aria-label') === 'Property visibility',
      );
      if (!(dialog instanceof HTMLElement)) return false;
      const sections = Array.from(dialog.querySelectorAll('[class*="propertiesSection"]'));
      return sections.some((section) => {
        const text = section.textContent ?? '';
        return text.includes(sectionLabel) && text.includes(propertyName);
      });

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
    },
    { sectionLabel, propertyName },
    { timeout: options.timeoutMs },
  );
}

async function dragPropertyManagerRow(page, sourceName, targetName, side = 'before') {
  const source = propertyManagerRow(page, sourceName);
  const target = propertyManagerRow(page, targetName);
  await source.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await target.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const targetBox = await target.boundingBox({ timeout: options.timeoutMs });
  assert(targetBox, `target Properties row ${targetName} must have a bounding box`);
  await source.locator('[data-property-drag-handle="true"]').first().dragTo(target, {
    targetPosition: {
      x: Math.max(4, Math.round(targetBox.width / 2)),
      y: side === 'after'
        ? Math.min(Math.max(4, targetBox.height - 4), Math.round((targetBox.height * 2) / 3))
        : Math.max(4, Math.round(targetBox.height / 3)),
    },
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ sourceName, targetName, side }) => {
      const rows = Array.from(document.querySelectorAll('[data-property-row]'))
        .filter((row) => row instanceof HTMLElement && isVisible(row))
        .map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      const sourceIndex = rows.findIndex((text) => text.includes(sourceName));
      const targetIndex = rows.findIndex((text) => text.includes(targetName));
      return sourceIndex >= 0 &&
        targetIndex >= 0 &&
        (side === 'after' ? sourceIndex > targetIndex : sourceIndex < targetIndex);

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
    },
    { sourceName, targetName, side },
    { timeout: options.timeoutMs },
  );
}

async function waitForVisibleProperties(baseUrl, seed, propertyLabels, visible, label) {
  const propertyIds = propertyLabels.map((name) => propertyIdForFixtureName(seed, name));
  const startedAt = Date.now();
  let lastVisible = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const config = await readSeedTableViewConfig(baseUrl, seed);
    lastVisible = Array.isArray(config.visibleProperties) ? config.visibleProperties : [];
    const matches = propertyIds.every((id) => lastVisible.includes(id) === visible);
    if (matches) return;
    await delay(100);
  }
  throw new Error(`${label} did not persist visibleProperties=${visible}: ${JSON.stringify(lastVisible)}`);
}

async function waitForViewPropertyConfig(baseUrl, seed, expectation) {
  const expectedOrderPrefix = expectation.propertyOrderPrefix.map((key) => seed.propertyIds[key]);
  const expectedVisiblePrefix = expectation.visiblePropertiesPrefix.map((key) => seed.propertyIds[key]);
  const startedAt = Date.now();
  let lastConfig = {};
  while (Date.now() - startedAt < options.timeoutMs) {
    const config = await readSeedTableViewConfig(baseUrl, seed);
    lastConfig = config;
    const order = Array.isArray(config.propertyOrder) ? config.propertyOrder : [];
    const visible = Array.isArray(config.visibleProperties) ? config.visibleProperties : [];
    if (startsWith(order, expectedOrderPrefix) && startsWith(visible, expectedVisiblePrefix)) return;
    await delay(100);
  }
  throw new Error(`${expectation.label} did not persist: ${JSON.stringify(lastConfig)}`);
}

async function readSeedTableViewConfig(baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'database',
    databaseId: seed.databaseId,
  });
  const view = (Array.isArray(result?.views) ? result.views : []).find((item) => item.id === seed.tableViewId);
  assert(view, 'database property visual smoke table view must be readable');
  return view.config ?? {};
}

async function waitForPropertyOption(baseUrl, seed, propertyKey, optionName) {
  const propertyId = seed.propertyIds[propertyKey];
  assert(propertyId, `missing property id for ${propertyKey}`);
  const startedAt = Date.now();
  let lastOptions = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'database',
      databaseId: seed.databaseId,
    });
    const property = (Array.isArray(result?.properties) ? result.properties : []).find(
      (item) => item.id === propertyId,
    );
    lastOptions = property?.config?.options ?? [];
    if (lastOptions.some((option) => option.name === optionName)) return;
    await delay(100);
  }
  throw new Error(`${propertyKey} property option ${optionName} did not persist: ${JSON.stringify(lastOptions)}`);
}

async function waitForPropertyName(baseUrl, seed, propertyKey, expectedName) {
  const propertyId = seed.propertyIds[propertyKey];
  assert(propertyId, `missing property id for ${propertyKey}`);
  const startedAt = Date.now();
  let lastName = '';
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
      action: 'database',
      databaseId: seed.databaseId,
    });
    const property = (Array.isArray(result?.properties) ? result.properties : []).find(
      (item) => item.id === propertyId,
    );
    lastName = property?.name ?? '';
    if (lastName === expectedName) return;
    await delay(100);
  }
  throw new Error(`${propertyKey} property name did not persist as ${expectedName}: ${lastName}`);
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

function propertyIdForFixtureName(seed, name) {
  const entry = Object.entries(PROPERTY_FIXTURE).find(([, value]) => value === name);
  assert(entry, `unknown property fixture name ${name}`);
  const id = seed.propertyIds[entry[0]];
  assert(id, `missing property id for fixture ${entry[0]}`);
  return id;
}

function startsWith(actual, expected) {
  return expected.every((item, index) => actual[index] === item);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  await page.waitForFunction(
    (rowTitle) =>
      Array.from(document.querySelectorAll('input')).some(
        (input) => input.value === rowTitle && input.offsetParent !== null,
      ),
    seed.rowTitle,
    { timeout: options.timeoutMs },
  );
}

async function openToolbarPropertiesMenu(page) {
  const button = page.getByRole('button', { name: /^Properties/ }).first();
  await button.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await button.click({ timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: PROPERTY_DIALOG_LABEL }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openStatusPropertyMenu(page) {
  const button = await propertyHeaderButton(page, PROPERTY_FIXTURE.status);
  await button.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const box = await button.boundingBox({ timeout: options.timeoutMs });
  assert(box, 'Status property header button must have a bounding box');
  await button.click({
    position: {
      x: Math.min(24, Math.max(1, box.width / 2)),
      y: Math.min(16, Math.max(1, box.height / 2)),
    },
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: `${PROPERTY_FIXTURE.status} property options` });
  try {
    await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((element) => ({
        label: element.getAttribute('aria-label'),
        text: element.textContent?.slice(0, 80) ?? '',
        visible: element instanceof HTMLElement && element.offsetParent !== null,
      })),
      propertyButtons: Array.from(document.querySelectorAll('button[aria-label$=" property options"]')).map((element) => ({
        disabled: element instanceof HTMLButtonElement ? element.disabled : false,
        label: element.getAttribute('aria-label'),
        text: element.textContent?.trim() ?? '',
        visible: element instanceof HTMLElement && element.offsetParent !== null,
      })),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Status property options did not open: ${message}; diagnostics=${JSON.stringify(diagnostics)}`);
  }
}

async function openStatusPropertyEditMenu(page) {
  await openStatusPropertyMenu(page);
  const dialog = page.getByRole('dialog', { name: `${PROPERTY_FIXTURE.status} property options` });
  await dialog.getByRole('button', { name: /^Edit property$/ }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Options', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function propertyHeaderButton(page, propertyName) {
  await page.waitForFunction(
    (name) =>
      Array.from(document.querySelectorAll('button[aria-label$=" property options"]')).some(
        (button) =>
          button instanceof HTMLElement &&
          button.offsetParent !== null &&
          button.getAttribute('aria-label') === `${name} property options`,
      ),
    propertyName,
    { timeout: options.timeoutMs },
  );
  const index = await page.locator('button[aria-label$=" property options"]').evaluateAll(
    (buttons, name) =>
      buttons.findIndex(
        (button) =>
          button instanceof HTMLElement &&
          button.offsetParent !== null &&
          button.getAttribute('aria-label') === `${name} property options`,
      ),
    propertyName,
  );
  assert(index >= 0, `${propertyName} property header button must be visible`);
  return page.locator('button[aria-label$=" property options"]').nth(index);
}

async function openStatusCellEditor(page) {
  await cell(page, 0, 1).getByRole('button', { name: `Edit ${PROPERTY_FIXTURE.status} select` }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('dialog', { name: 'Edit select property' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openDueDateEditor(page) {
  await cell(page, 0, 4).getByRole('button', {
    name: new RegExp(`^Edit ${PROPERTY_FIXTURE.due} date(?:,|$)`),
  }).click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('dialog', { name: 'Edit date property' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openRelationEditor(page, appUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/database/${seed.targetDatabaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: 'Table' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (rowTitle) =>
      Array.from(document.querySelectorAll('input')).some(
        (input) => input.value === rowTitle && input.offsetParent !== null,
      ),
    PROPERTY_FIXTURE.targetTitle,
    { timeout: options.timeoutMs },
  );
  await openDatabase(page, appUrl, seed);
  const target = cell(page, 0, 5);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const trigger = target.getByRole('button', { name: `Edit ${PROPERTY_FIXTURE.relation} relation` });
  await trigger.focus({ timeout: options.timeoutMs });
  await trigger.press('Enter', { timeout: options.timeoutMs });
  await page.getByRole('dialog', { name: 'Edit relation property' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openFilesEditor(page) {
  const target = cell(page, 0, 6);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const trigger = target.getByRole('button', { name: `Edit ${PROPERTY_FIXTURE.files} files` });
  await trigger.focus({ timeout: options.timeoutMs });
  await trigger.press('Enter', { timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Edit files property' });
  await dialog.waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Add file or image' }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('textbox', {
    name: `File or image URL for ${PROPERTY_FIXTURE.files}`,
  }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

function cell(page, rowIndex, colIndex) {
  return page.locator(`[data-table-cell][data-row-index="${rowIndex}"][data-col-index="${colIndex}"]`);
}

async function assertDialogContract(page, contract, variant) {
  const metrics = await page.evaluate(({ dialogLabel, expectedTexts, mustFitTexts }) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) =>
        element instanceof HTMLElement &&
        isVisible(element) &&
        element.getAttribute('aria-label') === dialogLabel,
    );
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: `missing dialog ${dialogLabel}` };
    const rect = dialog.getBoundingClientRect();
    const buttons = visibleElements(dialog.querySelectorAll('button, [role="option"], [role="menuitem"]'));
    const inputs = visibleElements(dialog.querySelectorAll('input, textarea, select, [role="combobox"]'));
    const wideInputs = inputs.filter((element) => {
      if (!(element instanceof HTMLInputElement)) return true;
      const type = element.type.toLowerCase();
      return type !== 'checkbox' && type !== 'radio';
    });
    const rows = visibleElements(dialog.querySelectorAll('button, [role="option"], [role="menuitem"], label'));
    const rowHeights = rows.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0);
    const inputWidths = wideInputs.map((element) => element.getBoundingClientRect().width).filter((width) => width > 0);
    const formText = visibleElements(dialog.querySelectorAll('input, textarea, select'))
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
    const text = `${dialog.textContent ?? ''} ${formText}`;
    const clippedTexts = mustFitTexts
      .map((item) => {
        const target = visibleElements(dialog.querySelectorAll('strong, span, div, button, label, input, textarea, [role="option"], [role="menuitem"]')).find(
          (element) => {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              return element.value === item || element.placeholder === item;
            }
            return (element.textContent ?? '').trim() === item;
          },
        );
        if (!(target instanceof HTMLElement)) return { item, status: 'missing' };
        const rect = target.getBoundingClientRect();
        return {
          clientWidth: target.clientWidth,
          item,
          rectWidth: rect.width,
          scrollWidth: target.scrollWidth,
          status: target.scrollWidth > target.clientWidth + 1 ? 'clipped' : 'ok',
        };
      })
      .filter((entry) => entry.status !== 'ok');
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      bottomGap: window.innerHeight - rect.bottom,
      buttonCount: buttons.length,
      documentScrollWidth: document.documentElement.scrollWidth,
      expectedTextsPresent: expectedTexts.every((item) => text.includes(item)),
      clippedTexts,
      height: rect.height,
      inputCount: wideInputs.length,
      inputMinWidth: inputWidths.length ? Math.min(...inputWidths) : 0,
      left: rect.left,
      maxRowHeight: rowHeights.length ? Math.max(...rowHeights) : 0,
      minRowHeight: rowHeights.length ? Math.min(...rowHeights) : 0,
      rightGap: window.innerWidth - rect.right,
      rowCount: rows.length,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };

    function visibleElements(items) {
      return Array.from(items).filter(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, {
    dialogLabel: contract.dialogLabel,
    expectedTexts: contract.expectedTexts ?? [],
    mustFitTexts: contract.mustFitTexts ?? [],
  });

  assert(metrics.ok, metrics.reason ?? `${contract.dialogLabel} contract could not run`);
  const [minWidth, maxWidth] = contract.width;
  assert(metrics.width >= minWidth && metrics.width <= maxWidth, `${contract.dialogLabel} width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.left >= (variant.mobile ? 0 : 8), `${contract.dialogLabel} should not drift off the left edge: ${JSON.stringify(metrics)}`);
  assert(metrics.rightGap >= (variant.mobile ? 0 : 8), `${contract.dialogLabel} should not drift off the right edge: ${JSON.stringify(metrics)}`);
  assert(metrics.top >= 40 && metrics.bottomGap >= 8, `${contract.dialogLabel} should stay inside the viewport: ${JSON.stringify(metrics)}`);
  assert(Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4, `${contract.dialogLabel} should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.height <= metrics.viewportHeight - 16, `${contract.dialogLabel} should fit in viewport height: ${JSON.stringify(metrics)}`);
  assert(metrics.buttonCount >= (contract.minButtons ?? 0), `${contract.dialogLabel} has too few action rows: ${JSON.stringify(metrics)}`);
  assert(metrics.inputCount >= (contract.minInputs ?? 0), `${contract.dialogLabel} has too few inputs: ${JSON.stringify(metrics)}`);
  assert(metrics.rowCount >= (contract.minRows ?? 0), `${contract.dialogLabel} has too few visible rows: ${JSON.stringify(metrics)}`);
  assert(metrics.expectedTextsPresent, `${contract.dialogLabel} is missing expected text: ${JSON.stringify(metrics)}`);
  assert(metrics.clippedTexts.length === 0, `${contract.dialogLabel} has clipped or missing required text: ${JSON.stringify(metrics)}`);
  assert(metrics.inputCount === 0 || metrics.inputMinWidth >= 120, `${contract.dialogLabel} input width is too cramped: ${JSON.stringify(metrics)}`);
  assert(metrics.maxRowHeight <= (contract.maxRowHeight ?? 72), `${contract.dialogLabel} row height is too loose: ${JSON.stringify(metrics)}`);
  assert(metrics.minRowHeight === 0 || metrics.minRowHeight >= (contract.minRowHeight ?? 18), `${contract.dialogLabel} row height is too cramped: ${JSON.stringify(metrics)}`);
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database property visual smoke');

  const suffix = Date.now();
  const short = String(suffix).slice(-6);
  const databaseId = randomUUID();
  const rowId = randomUUID();
  const targetDatabaseId = randomUUID();
  const targetRowId = randomUUID();
  const targetTitlePropId = randomUUID();
  const propertyIds = {
    title: randomUUID(),
    status: randomUUID(),
    notes: randomUUID(),
    done: randomUUID(),
    due: randomUUID(),
    relation: randomUUID(),
    files: randomUUID(),
    hiddenMemo: randomUUID(),
  };
  const propertyOrder = [
    propertyIds.title,
    propertyIds.status,
    propertyIds.notes,
    propertyIds.done,
    propertyIds.due,
    propertyIds.relation,
    propertyIds.files,
    propertyIds.hiddenMemo,
  ];
  const rowTitle = `가상연결연구소 계약 정산 확인 ${short}`;
  const targetCreated = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: targetDatabaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `계약 문서 자료실 ${short}`,
    position: suffix - 1,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: targetTitlePropId, name: '문서명', type: 'title', position: 1 },
    ],
  });
  assert(targetCreated?.page?.id === targetDatabaseId, 'database property visual target database must be created');
  const createdTargetRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: targetRowId,
    databaseId: targetDatabaseId,
    title: PROPERTY_FIXTURE.targetTitle,
    properties: {},
  });
  assert(createdTargetRow?.row?.id === targetRowId, 'database property visual target row must be created');

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `거래처 운영 데이터베이스 ${short}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      {
        id: propertyIds.title,
        name: PROPERTY_FIXTURE.title,
        type: 'title',
        position: 1,
        description: PROPERTY_FIXTURE.descriptions.title,
      },
      {
        id: propertyIds.status,
        name: PROPERTY_FIXTURE.status,
        type: 'select',
        position: 2,
        description: PROPERTY_FIXTURE.descriptions.status,
        options: [
          { id: 'todo', name: PROPERTY_FIXTURE.options.todo, color: 'gray' },
          { id: 'doing', name: PROPERTY_FIXTURE.options.doing, color: 'blue' },
          { id: 'done', name: PROPERTY_FIXTURE.options.done, color: 'green' },
        ],
      },
      {
        id: propertyIds.notes,
        name: PROPERTY_FIXTURE.notes,
        type: 'rich_text',
        position: 3,
        description: PROPERTY_FIXTURE.descriptions.notes,
      },
      {
        id: propertyIds.done,
        name: PROPERTY_FIXTURE.done,
        type: 'checkbox',
        position: 4,
        description: PROPERTY_FIXTURE.descriptions.done,
      },
      {
        id: propertyIds.due,
        name: PROPERTY_FIXTURE.due,
        type: 'date',
        position: 5,
        description: PROPERTY_FIXTURE.descriptions.due,
      },
      {
        id: propertyIds.relation,
        name: PROPERTY_FIXTURE.relation,
        type: 'relation',
        position: 6,
        description: PROPERTY_FIXTURE.descriptions.relation,
        config: { relationDatabaseId: targetDatabaseId },
      },
      {
        id: propertyIds.files,
        name: PROPERTY_FIXTURE.files,
        type: 'files',
        position: 7,
        description: PROPERTY_FIXTURE.descriptions.files,
      },
      {
        id: propertyIds.hiddenMemo,
        name: PROPERTY_FIXTURE.hiddenMemo,
        type: 'rich_text',
        position: 8,
        description: PROPERTY_FIXTURE.descriptions.hiddenMemo,
      },
    ],
  });
  assert(created?.page?.id === databaseId, 'database property visual smoke database must be created');
  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database property visual smoke must receive a table view');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    workspaceId,
    table: 'db_views',
    id: tableViewId,
    patch: {
      name: 'Table',
      position: 1,
      config: {
        propertyOrder,
        visibleProperties: propertyOrder.filter((id) => id !== propertyIds.hiddenMemo),
        propertyWidths: {
          [propertyIds.title]: 260,
          [propertyIds.status]: 180,
          [propertyIds.notes]: 260,
          [propertyIds.done]: 130,
          [propertyIds.due]: 170,
          [propertyIds.relation]: 220,
          [propertyIds.files]: 220,
        },
      },
    },
  });

  const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: rowTitle,
    properties: {
      [propertyIds.status]: 'doing',
      [propertyIds.notes]: `세금계산서 발행 전 담당자 확인이 필요합니다 ${short}`,
      [propertyIds.done]: true,
      [propertyIds.due]: '2026-06-25',
      [propertyIds.relation]: [targetRowId],
      [propertyIds.files]: [
        {
          id: `visual-file-${short}`,
          name: PROPERTY_FIXTURE.linkedFileName,
          url: `https://example.com/files/${encodeURIComponent(PROPERTY_FIXTURE.linkedFileName)}`,
        },
      ],
    },
  });
  assert(createdRow?.row?.id === rowId, 'database property visual smoke row must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    databaseId,
    targetDatabaseId,
    rowId,
    rowTitle,
    propertyIds,
    tableViewId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { call: callFunction }).catch(() => {});
  if (seed.targetDatabaseId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.targetDatabaseId, { call: callFunction }).catch(() => {});
  }
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
    'Playwright is required for database property visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    onlyPropertyHeaderOptions: false,
    onlyToolbarProperties: false,
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
    if (arg === '--only-toolbar-properties') {
      parsed.onlyToolbarProperties = true;
      continue;
    }
    if (arg === '--only-property-header-options') {
      parsed.onlyPropertyHeaderOptions = true;
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
  console.log(`Usage: node scripts/database-property-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --only-toolbar-properties
                          Capture and verify only the toolbar Properties panel
  --only-property-header-options
                          Verify property header edit/type routes and option creation
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
