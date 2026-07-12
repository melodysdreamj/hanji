#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserAuthStorageKeys,
  permanentlyDeletePage,
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  DEFAULT_BASE_URL,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 20_000;
const options = parseArgs(process.argv.slice(2));

setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL template block actions UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Template block actions UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedTemplateBlockActions(baseUrl);
  const { chromium } = await loadPlaywright({ label: 'template block actions UI smoke' });
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(options.slowMoMs > 0 ? { slowMo: options.slowMoMs } : {}),
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertTemplateBlockActionsUi(browser, baseUrl, seed);
    console.log('PASS template editor traps focus, isolates the background, restores its trigger, and opens a visible shared block action menu.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertTemplateBlockActionsUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(resolveUrl(baseUrl, `/p/${seed.databaseId}`), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('toolbar', { name: 'Database toolbar' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    const templateTrigger = page.getByRole('button', { name: 'Choose database template' });
    const initialRootIsolation = await collectRootIsolation(page);
    await templateTrigger.click({
      timeout: options.timeoutMs,
    });
    const templateMenu = page.getByRole('dialog', { name: 'New database page' });
    await templateMenu.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await templateMenu.getByRole('button', { name: 'Edit' }).first().click({
      timeout: options.timeoutMs,
    });
    const editor = page.getByRole('dialog', { name: 'Edit database template' });
    await editor.waitFor({ state: 'visible', timeout: options.timeoutMs });

    const artifactDir = join(root, '.edgebase', 'ui-discovery', 'template-block-actions');
    mkdirSync(artifactDir, { recursive: true });
    const focusIsolationMetrics = await assertTemplateEditorFocusIsolation(page, editor);
    writeFileSync(
      join(artifactDir, 'template-editor-focus-isolation.json'),
      `${JSON.stringify(focusIsolationMetrics, null, 2)}\n`,
    );
    const sharedSurfaceMetrics = await collectTemplateSharedSurfaceMetrics(page);
    writeFileSync(
      join(artifactDir, 'template-editor-shared-surface.json'),
      `${JSON.stringify(sharedSurfaceMetrics, null, 2)}\n`,
    );
    assert(
      sharedSurfaceMetrics.properties.visible,
      `template editor should render the shared row property panel: ${JSON.stringify(sharedSurfaceMetrics)}`,
    );
    assert(
      sharedSurfaceMetrics.properties.rowCount >= 3,
      `template editor should show seeded non-title properties through RowProperties: ${JSON.stringify(sharedSurfaceMetrics)}`,
    );
    assert(
      sharedSurfaceMetrics.properties.labels.includes('분류') &&
        sharedSurfaceMetrics.properties.labels.includes('상태') &&
        sharedSurfaceMetrics.properties.labels.includes('연락처'),
      `template editor should preserve shared row property labels: ${JSON.stringify(sharedSurfaceMetrics)}`,
    );
    assert(
      sharedSurfaceMetrics.editor.visible,
      `template editor should render the shared page editor body: ${JSON.stringify(sharedSurfaceMetrics)}`,
    );
    assert(
      sharedSurfaceMetrics.legacy.templateRows === 0 &&
        sharedSurfaceMetrics.legacy.templateActionHandles === 0,
      `template editor should not render legacy template-only block rows or handles: ${JSON.stringify(sharedSurfaceMetrics)}`,
    );

    const chromeMetrics = await assertTemplateEditorChrome(page, artifactDir);
    writeFileSync(
      join(artifactDir, 'template-editor-chrome.json'),
      `${JSON.stringify(chromeMetrics, null, 2)}\n`,
    );

    await page.setViewportSize({ width: 1440, height: 650 });
    await editor.waitFor({ state: 'visible', timeout: options.timeoutMs });

    const firstRow = page.locator('[data-template-shared-editor="true"] [data-block-id]').first();
    await firstRow.hover({ timeout: options.timeoutMs });
    const handle = firstRow.getByRole('button', { name: 'Open block actions' });
    await handle.click({ timeout: options.timeoutMs });
    const menu = page.getByRole('menu', { name: 'Block actions' });
    await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await page.waitForFunction(
      () => {
        const editor = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
        const menu = document.querySelector('[role="menu"][aria-label="Block actions"]');
        const handle = editor?.querySelector('button[aria-label="Open block actions"]');
        if (!(menu instanceof HTMLElement) || !(handle instanceof HTMLElement)) return false;
        const menuRect = menu.getBoundingClientRect();
        const handleRect = handle.getBoundingClientRect();
        const gap =
          menuRect.bottom <= handleRect.top
            ? handleRect.top - menuRect.bottom
            : menuRect.top >= handleRect.bottom
              ? menuRect.top - handleRect.bottom
              : 0;
        return gap <= 24;
      },
      null,
      { timeout: options.timeoutMs },
    );

    const metrics = await collectTemplateBlockActionMetrics(page);
    writeFileSync(
      join(artifactDir, 'template-block-actions-menu.json'),
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
    await page.screenshot({
      path: join(artifactDir, 'template-block-actions-menu.png'),
      fullPage: false,
    });

    assert(metrics.menu.visible, `shared block action menu should be visible in the template editor: ${JSON.stringify(metrics)}`);
    assert(metrics.menu.parentIsBody, `shared block action menu should render from document.body: ${JSON.stringify(metrics)}`);
    assert(metrics.menu.withinViewport, `shared block action menu should remain inside the viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.menu.topElementInsideMenu, `shared block action menu should be the clickable top layer: ${JSON.stringify(metrics)}`);
    assert(metrics.backdrop.parentIsBody, `shared block action backdrop should render from document.body: ${JSON.stringify(metrics)}`);
    assert(
      metrics.backdrop.zIndex > metrics.editor.zIndex,
      `shared block action backdrop should sit above the template editor: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.menu.rect.left <= metrics.handle.rect.left + 12 &&
        metrics.menu.rect.right >= metrics.handle.rect.left,
      `shared block action menu should open near the clicked dotted handle: ${JSON.stringify(metrics)}`,
    );
    assert(
      metrics.menu.verticalGap <= 24,
      `shared block action menu should stay vertically near the clicked dotted handle: ${JSON.stringify(metrics)}`,
    );
    assert(!metrics.menu.text.includes('Copy link to block'), `template block menu should hide page-only copy-link action: ${JSON.stringify(metrics)}`);
    assert(!metrics.menu.text.includes('Move to'), `template block menu should hide page-only move-to action: ${JSON.stringify(metrics)}`);
    assert(!metrics.menu.text.includes('Comment'), `template block menu should hide page-only comment action: ${JSON.stringify(metrics)}`);

    if (options.holdOpenMs > 0) {
      console.log(`Holding template block action menu open for ${options.holdOpenMs}ms.`);
      await page.waitForTimeout(options.holdOpenMs);
    }

    await menu.getByRole('menuitem', { name: /Duplicate/ }).click({
      timeout: options.timeoutMs,
    });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-template-shared-editor="true"] [data-block-id]').length >= 2,
      null,
      { timeout: options.timeoutMs },
    );

    const restoredFocusMetrics = await closeTemplateEditorAndAssertRestore(
      page,
      editor,
      templateTrigger,
      initialRootIsolation,
    );
    writeFileSync(
      join(artifactDir, 'template-editor-focus-restored.json'),
      `${JSON.stringify(restoredFocusMetrics, null, 2)}\n`,
    );

    assertNoBrowserErrors(errors, 'template block actions menu flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function collectRootIsolation(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#root');
    return {
      ariaHidden: root?.getAttribute('aria-hidden') ?? null,
      inert: root instanceof HTMLElement ? root.inert : null,
    };
  });
}

async function assertTemplateEditorFocusIsolation(page, editor) {
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
      return dialog instanceof HTMLElement && dialog.contains(document.activeElement);
    },
    null,
    { timeout: options.timeoutMs },
  );

  const initialized = await page.evaluate(() => {
    const root = document.querySelector('#root');
    const dialog = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
    const focusables = Array.from(
      dialog?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], ' +
          '[tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter(
      (element) =>
        element instanceof HTMLElement &&
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.closest('[aria-hidden="true"], [hidden]'),
    );
    const first = focusables[0];
    if (first instanceof HTMLElement) first.focus();
    return {
      activeInsideDialog: dialog instanceof HTMLElement && dialog.contains(document.activeElement),
      firstLabel: first?.getAttribute('aria-label') ?? first?.textContent?.trim() ?? '',
      focusableCount: focusables.length,
      rootAriaHidden: root?.getAttribute('aria-hidden') ?? null,
      rootInert: root instanceof HTMLElement ? root.inert : null,
    };
  });
  assert(initialized.focusableCount > 1, `template editor needs at least two focus targets: ${JSON.stringify(initialized)}`);
  assert(initialized.activeInsideDialog, `template editor should receive initial focus: ${JSON.stringify(initialized)}`);
  assert(initialized.rootInert === true, `template editor should make the application root inert: ${JSON.stringify(initialized)}`);
  assert(initialized.rootAriaHidden === 'true', `template editor should hide the application root from assistive technology: ${JSON.stringify(initialized)}`);

  await page.keyboard.press('Shift+Tab');
  const shiftedBackward = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
    const focusables = Array.from(
      dialog?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], ' +
          '[tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter(
      (element) =>
        element instanceof HTMLElement &&
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.closest('[aria-hidden="true"], [hidden]'),
    );
    return document.activeElement === focusables.at(-1);
  });
  assert(shiftedBackward, 'Shift+Tab from the first template-editor control should wrap to the last control');

  await page.keyboard.press('Tab');
  const shiftedForward = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
    const focusables = Array.from(
      dialog?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], ' +
          '[tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter(
      (element) =>
        element instanceof HTMLElement &&
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.closest('[aria-hidden="true"], [hidden]'),
    );
    return document.activeElement === focusables[0];
  });
  assert(shiftedForward, 'Tab from the last template-editor control should wrap to the first control');

  const backgroundAttempt = await page.evaluate(() => {
    const root = document.querySelector('#root');
    const dialog = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
    const backgroundTarget = root?.querySelector('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (backgroundTarget instanceof HTMLElement) backgroundTarget.focus();
    return {
      activeInsideDialog: dialog instanceof HTMLElement && dialog.contains(document.activeElement),
      backgroundFound: backgroundTarget instanceof HTMLElement,
      backgroundReceivedFocus: document.activeElement === backgroundTarget,
    };
  });
  assert(backgroundAttempt.backgroundFound, `focus-isolation smoke needs a background focus target: ${JSON.stringify(backgroundAttempt)}`);
  assert(!backgroundAttempt.backgroundReceivedFocus, `inert background must reject focus: ${JSON.stringify(backgroundAttempt)}`);
  assert(backgroundAttempt.activeInsideDialog, `focus must remain inside the modal after a background focus attempt: ${JSON.stringify(backgroundAttempt)}`);

  await editor.focus();
  return { backgroundAttempt, initialized, shiftedBackward, shiftedForward };
}

async function closeTemplateEditorAndAssertRestore(page, editor, templateTrigger, initialRootIsolation) {
  await editor.press('Escape');
  await editor.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'Choose database template',
    null,
    { timeout: options.timeoutMs },
  );
  const restored = await page.evaluate(() => {
    const root = document.querySelector('#root');
    return {
      activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
      ariaHidden: root?.getAttribute('aria-hidden') ?? null,
      inert: root instanceof HTMLElement ? root.inert : null,
    };
  });
  assert(await templateTrigger.evaluate((element) => document.activeElement === element), `closing the template editor should restore its trigger: ${JSON.stringify(restored)}`);
  assert(restored.inert === initialRootIsolation.inert, `closing the template editor should restore root inert state: ${JSON.stringify({ initialRootIsolation, restored })}`);
  assert(restored.ariaHidden === initialRootIsolation.ariaHidden, `closing the template editor should restore root aria-hidden state: ${JSON.stringify({ initialRootIsolation, restored })}`);
  return restored;
}

async function assertTemplateEditorChrome(page, artifactDir) {
  const compact = await collectTemplateEditorChromeMetrics(page);
  await page.screenshot({
    path: join(artifactDir, 'template-editor-compact.png'),
    fullPage: false,
  });

  assert(compact.editor.visible, `template editor should be visible before expanding: ${JSON.stringify(compact)}`);
  assert(compact.editor.mode === 'peek', `template editor should start in peek mode: ${JSON.stringify(compact)}`);
  assert(compact.openButton.visible, `template editor open-as-page control should be visible: ${JSON.stringify(compact)}`);
  assert(compact.openButton.tag === 'BUTTON', `template editor open-as-page control must be a real button: ${JSON.stringify(compact)}`);
  assert(compact.openButton.ariaPressed === 'false', `template editor open-as-page control should start unpressed: ${JSON.stringify(compact)}`);
  assert(/Expand template editor/.test(compact.openButton.ariaLabel), `template editor open button should announce the expand action: ${JSON.stringify(compact)}`);
  assert(compact.closeButton.visible, `template editor close control should be visible beside open-as-page: ${JSON.stringify(compact)}`);
  assert(compact.closeButton.tag === 'BUTTON', `template editor close control must be a real button: ${JSON.stringify(compact)}`);

  await page.locator('[data-template-editor-open-page="true"]').click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"][aria-label="Edit database template"]')?.getAttribute('data-mode') === 'page',
    null,
    { timeout: options.timeoutMs },
  );
  const expanded = await collectTemplateEditorChromeMetrics(page);
  await page.screenshot({
    path: join(artifactDir, 'template-editor-expanded.png'),
    fullPage: false,
  });

  assert(expanded.editor.mode === 'page', `template editor should switch to page mode after clicking open-as-page: ${JSON.stringify(expanded)}`);
  assert(expanded.openButton.ariaPressed === 'true', `expanded template editor open-as-page control should be pressed: ${JSON.stringify(expanded)}`);
  assert(/Return template editor to center view/.test(expanded.openButton.ariaLabel), `expanded template editor button should announce restore action: ${JSON.stringify(expanded)}`);
  assert(expanded.editor.left <= 1, `expanded template editor should reach the left viewport edge: ${JSON.stringify(expanded)}`);
  assert(expanded.editor.right >= expanded.viewport.width - 1, `expanded template editor should reach the right viewport edge: ${JSON.stringify(expanded)}`);
  assert(expanded.editor.width >= compact.editor.width + 120, `expanded template editor should visibly grow: ${JSON.stringify({ compact, expanded })}`);

  await page.locator('[data-template-editor-open-page="true"]').click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"][aria-label="Edit database template"]')?.getAttribute('data-mode') === 'peek',
    null,
    { timeout: options.timeoutMs },
  );
  const restored = await collectTemplateEditorChromeMetrics(page);
  await page.screenshot({
    path: join(artifactDir, 'template-editor-restored.png'),
    fullPage: false,
  });

  assert(restored.editor.mode === 'peek', `template editor should restore to peek mode: ${JSON.stringify(restored)}`);
  assert(restored.openButton.ariaPressed === 'false', `restored template editor open-as-page control should be unpressed: ${JSON.stringify(restored)}`);
  assert(restored.editor.width <= expanded.editor.width - 120, `restored template editor should shrink back from page mode: ${JSON.stringify({ expanded, restored })}`);

  return { compact, expanded, restored };
}

async function collectTemplateEditorChromeMetrics(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
    const openButton = document.querySelector('[data-template-editor-open-page="true"]');
    const closeButton = document.querySelector('[data-template-editor-close="true"]');
    const rectFor = (node) => {
      if (!(node instanceof HTMLElement)) {
        return {
          ariaLabel: '',
          ariaPressed: '',
          bottom: null,
          height: 0,
          left: null,
          mode: '',
          right: null,
          tag: '',
          top: null,
          visible: false,
          width: 0,
        };
      }
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return {
        ariaLabel: node.getAttribute('aria-label') ?? '',
        ariaPressed: node.getAttribute('aria-pressed') ?? '',
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        mode: node.getAttribute('data-mode') ?? '',
        right: Math.round(rect.right),
        tag: node.tagName,
        top: Math.round(rect.top),
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number.parseFloat(style.opacity || '1') > 0.01,
        width: Math.round(rect.width),
      };
    };
    return {
      closeButton: rectFor(closeButton),
      editor: rectFor(editor),
      openButton: rectFor(openButton),
      viewport: {
        height: window.innerHeight,
        width: window.innerWidth,
      },
    };
  });
}

async function collectTemplateBlockActionMetrics(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('[role="dialog"][aria-label="Edit database template"]');
    const menu = document.querySelector('[role="menu"][aria-label="Block actions"]');
    const handle = editor?.querySelector('button[aria-label="Open block actions"]');
    const backdrop = document.querySelector('button[aria-label="Close block actions"]');
    const rectFor = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        width: rect.width,
        zIndex: style.zIndex,
      };
    };
    const zIndexNumber = (value) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const menuRect = rectFor(menu);
    const center =
      menuRect && {
        x: Math.min(window.innerWidth - 1, Math.max(0, menuRect.left + menuRect.width / 2)),
        y: Math.min(window.innerHeight - 1, Math.max(0, menuRect.top + menuRect.height / 2)),
      };
    const topElement = center ? document.elementFromPoint(center.x, center.y) : null;
    const backdropRect = rectFor(backdrop);
    const editorRect = rectFor(editor);
    const handleRect = rectFor(handle);
    const verticalGap =
      menuRect && handleRect
        ? menuRect.bottom <= handleRect.top
          ? handleRect.top - menuRect.bottom
          : menuRect.top >= handleRect.bottom
            ? menuRect.top - handleRect.bottom
            : 0
        : null;
    return {
      backdrop: {
        parentIsBody: backdrop?.parentElement === document.body,
        rect: backdropRect,
        zIndex: zIndexNumber(backdropRect?.zIndex),
      },
      editor: {
        rect: editorRect,
        zIndex: zIndexNumber(editorRect?.zIndex),
      },
      handle: {
        rect: handleRect,
      },
      menu: {
        parentIsBody: menu?.parentElement === document.body,
        rect: menuRect,
        text: menu?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) ?? '',
        topElementInsideMenu: !!menu && !!topElement && menu.contains(topElement),
        verticalGap,
        visible: !!menuRect?.visible,
        withinViewport:
          !!menuRect &&
          menuRect.left >= 0 &&
          menuRect.top >= 0 &&
          menuRect.right <= window.innerWidth &&
          menuRect.bottom <= window.innerHeight,
      },
      viewport: {
        height: window.innerHeight,
        width: window.innerWidth,
      },
    };
  });
}

async function collectTemplateSharedSurfaceMetrics(page) {
  return page.evaluate(() => {
    const properties = document.querySelector('[data-template-shared-properties="true"]');
    const editor = document.querySelector('[data-template-shared-editor="true"]');
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const labels = Array.from(properties?.querySelectorAll('[data-row-property-label]') ?? [])
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
    return {
      editor: {
        blockCount: editor?.querySelectorAll('[data-block-id]').length ?? 0,
        visible: visible(editor),
      },
      legacy: {
        templateActionHandles: document.querySelectorAll('button[aria-label="Open template block actions"]').length,
        templateRows: document.querySelectorAll('[data-template-block-row="true"]').length,
      },
      properties: {
        labels,
        rowCount: properties?.querySelectorAll('[data-row-property-id]').length ?? 0,
        visible: visible(properties),
      },
    };
  });
}

async function seedTemplateBlockActions(baseUrl) {
  const session = await signIn(baseUrl, { timeoutMs: options.timeoutMs });
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {}, {
    timeoutMs: options.timeoutMs,
  });
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for template block actions smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const titlePropertyId = randomUUID();
  const categoryPropertyId = randomUUID();
  const statusPropertyId = randomUUID();
  const contactPropertyId = randomUUID();
  const templateId = randomUUID();
  const createdDatabase = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Template block actions ${suffix}`,
    viewType: 'table',
    properties: [
      { id: titlePropertyId, name: 'Name', type: 'title', position: 1 },
      {
        id: categoryPropertyId,
        name: '분류',
        type: 'select',
        position: 2,
        config: {
          options: [{ id: 'vendor', name: '거래처', color: 'blue' }],
        },
      },
      {
        id: statusPropertyId,
        name: '상태',
        type: 'status',
        position: 3,
        config: {
          options: [{ id: 'new', name: '신규', color: 'green' }],
        },
      },
      { id: contactPropertyId, name: '연락처', type: 'phone', position: 4 },
    ],
  }, { timeoutMs: options.timeoutMs });
  assert(createdDatabase?.page?.id === databaseId, 'template block actions database must be created');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_templates',
    records: [
      {
        id: templateId,
        databaseId,
        name: `Template block menu ${suffix}`,
        icon: '',
        title: '',
        properties: {
          [categoryPropertyId]: 'vendor',
          [statusPropertyId]: 'new',
          [contactPropertyId]: '010-1234-5678',
        },
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
  }, { timeoutMs: options.timeoutMs });

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    templateId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { timeoutMs: options.timeoutMs }).catch(() => {});
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId, theme }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', theme);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
    theme: options.theme,
  });
}

function parseArgs(args) {
  const parsed = {
    headed: false,
    holdOpenMs: 0,
    slowMoMs: 0,
    theme: 'dark',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--headed') {
      parsed.headed = true;
    } else if (arg === '--show') {
      parsed.headed = true;
      if (parsed.holdOpenMs === 0) parsed.holdOpenMs = 5_000;
      if (parsed.slowMoMs === 0) parsed.slowMoMs = 150;
    } else if (arg === '--hold-open-ms') {
      parsed.holdOpenMs = Number(args[++i] ?? parsed.holdOpenMs);
    } else if (arg === '--slow-mo-ms') {
      parsed.slowMoMs = Number(args[++i] ?? parsed.slowMoMs);
    } else if (arg === '--theme') {
      parsed.theme = args[++i] ?? parsed.theme;
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(args[++i] ?? parsed.timeoutMs);
    } else if (arg === '--url') {
      parsed.url = args[++i] ?? parsed.url;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/template-block-actions-ui-smoke.mjs [options]

Options:
  --url <url>          Base URL of the local app. Default: ${DEFAULT_BASE_URL}
  --theme <light|dark> Theme to apply before opening the page. Default: dark
  --timeout-ms <ms>    Timeout for browser/API operations. Default: ${DEFAULT_TIMEOUT_MS}
  --headed            Run with a visible browser.
  --show              Visible browser with slow motion and a 5s open-menu pause.
  --slow-mo-ms <ms>   Delay browser actions in visible runs. Default: 0
  --hold-open-ms <ms> Keep the opened menu visible before closing. Default: 0
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  if (!Number.isFinite(parsed.slowMoMs) || parsed.slowMoMs < 0) {
    throw new Error('--slow-mo-ms must be zero or a positive number');
  }
  if (!Number.isFinite(parsed.holdOpenMs) || parsed.holdOpenMs < 0) {
    throw new Error('--hold-open-ms must be zero or a positive number');
  }
  if (!['light', 'dark', 'system'].includes(parsed.theme)) {
    throw new Error('--theme must be light, dark, or system');
  }
  return parsed;
}
