#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserAuthStorageKeys,
  finalizeRegisteredSmokeAccounts,
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
  console.error(`\nFAIL row peek block actions UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('row peek block actions UI smoke');
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Row peek block actions UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedRowPeekBlockActions(baseUrl);
  const { chromium } = await loadPlaywright({ label: 'row peek block actions UI smoke' });
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(options.slowMoMs > 0 ? { slowMo: options.slowMoMs } : {}),
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertRowPeekBlockActionsUi(browser, baseUrl, seed);
    console.log('PASS row peek body block action menu appears near the handle and stays clickable above the side preview.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertRowPeekBlockActionsUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}?p=${seed.rowId}&pm=s`), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page.getByRole('dialog', { name: `${seed.rowTitle} preview` }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    const group = page.locator(`[data-block-id="${seed.blockId}"]`);
    await group.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await group.getByRole('textbox').click({ timeout: options.timeoutMs });
    await group.hover({ timeout: options.timeoutMs });

    const handle = group.getByRole('button', { name: 'Open block actions' });
    await handle.click({ timeout: options.timeoutMs });
    await page.getByRole('menu', { name: 'Block actions' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });

    const metrics = await collectMenuMetrics(page, seed.blockId);
    const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-peek-block-actions');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'row-peek-block-actions-menu.json'),
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
    await page.screenshot({
      path: join(artifactDir, 'row-peek-block-actions-menu.png'),
      fullPage: false,
    });

    assert(metrics.menu.visible, `block actions menu should be visible: ${JSON.stringify(metrics)}`);
    assert(metrics.menu.parentIsBody, `block actions menu should render from the document body layer inside row peek: ${JSON.stringify(metrics)}`);
    assert(metrics.menu.withinViewport, `block actions menu should remain inside the viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.menu.topElementInsideMenu, `block actions menu should be the clickable top layer: ${JSON.stringify(metrics)}`);
    assert(
      metrics.menu.rect.left <= metrics.handle.rect.left + 12 &&
        metrics.menu.rect.right >= metrics.handle.rect.left,
      `block actions menu should open near the clicked row-peek handle: ${JSON.stringify(metrics)}`,
    );
    assert(
      Math.abs(metrics.menu.rect.top - (metrics.handle.rect.bottom + 4)) <= 20,
      `block actions menu should open below the clicked row-peek handle: ${JSON.stringify(metrics)}`,
    );

    if (options.holdOpenMs > 0) {
      console.log(`Holding row peek block action menu open for ${options.holdOpenMs}ms.`);
      await page.waitForTimeout(options.holdOpenMs);
    }

    await assertRowPeekMentionMenuUi(page, group, seed.blockId);
    assertNoBrowserErrors(errors, 'row peek block actions menu flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertRowPeekMentionMenuUi(page, group, blockId) {
  await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: 'Block actions' }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  }).catch(() => {});

  await group.getByRole('textbox').click({ timeout: options.timeoutMs });
  await page.keyboard.press('End');
  await page.keyboard.type(' @');
  await page.getByRole('listbox', { name: 'Mention' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  const metrics = await collectFloatingMenuMetrics(page, {
    backdropSelector: 'button[aria-label="Close mention menu"]',
    blockId,
    menuSelector: '[role="listbox"][aria-label="Mention"]',
  });
  const artifactDir = join(root, '.edgebase', 'ui-discovery', 'row-peek-block-actions');
  writeFileSync(
    join(artifactDir, 'row-peek-mention-menu.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  await page.screenshot({
    path: join(artifactDir, 'row-peek-mention-menu.png'),
    fullPage: false,
  });

  assert(metrics.menu.visible, `mention menu should be visible in row peek body: ${JSON.stringify(metrics)}`);
  assert(metrics.menu.parentIsBody, `mention menu should render from the document body layer: ${JSON.stringify(metrics)}`);
  assert(metrics.menu.withinViewport, `mention menu should remain inside the viewport: ${JSON.stringify(metrics)}`);
  assert(metrics.menu.topElementInsideMenu, `mention menu should be the clickable top layer: ${JSON.stringify(metrics)}`);
  assert(metrics.backdrop.parentIsBody, `mention menu backdrop should render from the document body layer: ${JSON.stringify(metrics)}`);
  assert(
    metrics.backdrop.zIndex > metrics.panel.zIndex,
    `mention menu backdrop should sit above the row peek panel so outside clicks close it: ${JSON.stringify(metrics)}`,
  );

  await page.mouse.click(Math.max(8, metrics.menu.rect.left - 24), metrics.menu.rect.top + 4);
  await page.getByRole('listbox', { name: 'Mention' }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  });
}

async function collectMenuMetrics(page, blockId) {
  return page.evaluate((targetBlockId) => {
    const menu = document.querySelector('[role="menu"][aria-label="Block actions"]');
    const block = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
    const handle = block?.querySelector('button[aria-label="Open block actions"]');
    const panel = document.querySelector('[data-row-peek-panel]');
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
    const menuRect = rectFor(menu);
    const handleRect = rectFor(handle);
    const panelRect = rectFor(panel);
    const center =
      menuRect && {
        x: Math.min(window.innerWidth - 1, Math.max(0, menuRect.left + menuRect.width / 2)),
        y: Math.min(window.innerHeight - 1, Math.max(0, menuRect.top + menuRect.height / 2)),
      };
    const topElement = center ? document.elementFromPoint(center.x, center.y) : null;
    return {
      backdrop: {
        parentIsBody: backdrop?.parentElement === document.body,
        rect: rectFor(backdrop),
      },
      handle: {
        rect: handleRect,
      },
      menu: {
        parentIsBody: menu?.parentElement === document.body,
        rect: menuRect,
        text: menu?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '',
        topElementInsideMenu: !!menu && !!topElement && menu.contains(topElement),
        visible: !!menuRect?.visible,
        withinViewport:
          !!menuRect &&
          menuRect.left >= 0 &&
          menuRect.top >= 0 &&
          menuRect.right <= window.innerWidth &&
          menuRect.bottom <= window.innerHeight,
      },
      panel: {
        rect: panelRect,
        transform: panel instanceof HTMLElement ? window.getComputedStyle(panel).transform : null,
      },
      viewport: {
        height: window.innerHeight,
        width: window.innerWidth,
      },
    };
  }, blockId);
}

async function collectFloatingMenuMetrics(page, { backdropSelector, blockId, menuSelector }) {
  return page.evaluate(({ targetBlockId, targetBackdropSelector, targetMenuSelector }) => {
    const menu = document.querySelector(targetMenuSelector);
    const block = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
    const backdrop = document.querySelector(targetBackdropSelector);
    const panel = document.querySelector('[data-row-peek-panel]');
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
    const menuRect = rectFor(menu);
    const center =
      menuRect && {
        x: Math.min(window.innerWidth - 1, Math.max(0, menuRect.left + menuRect.width / 2)),
        y: Math.min(window.innerHeight - 1, Math.max(0, menuRect.top + menuRect.height / 2)),
      };
    const topElement = center ? document.elementFromPoint(center.x, center.y) : null;
    const backdropRect = rectFor(backdrop);
    const panelRect = rectFor(panel);
    const zIndexNumber = (value) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      backdrop: {
        parentIsBody: backdrop?.parentElement === document.body,
        rect: backdropRect,
        zIndex: zIndexNumber(backdropRect?.zIndex),
      },
      block: {
        rect: rectFor(block),
      },
      menu: {
        parentIsBody: menu?.parentElement === document.body,
        rect: menuRect,
        text: menu?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '',
        topElementInsideMenu: !!menu && !!topElement && menu.contains(topElement),
        visible: !!menuRect?.visible,
        withinViewport:
          !!menuRect &&
          menuRect.left >= 0 &&
          menuRect.top >= 0 &&
          menuRect.right <= window.innerWidth &&
          menuRect.bottom <= window.innerHeight,
      },
      panel: {
        rect: panelRect,
        transform: panel instanceof HTMLElement ? window.getComputedStyle(panel).transform : null,
        zIndex: zIndexNumber(panelRect?.zIndex),
      },
      viewport: {
        height: window.innerHeight,
        width: window.innerWidth,
      },
    };
  }, {
    targetBackdropSelector: backdropSelector,
    targetBlockId: blockId,
    targetMenuSelector: menuSelector,
  });
}

async function seedRowPeekBlockActions(baseUrl) {
  const session = await signIn(baseUrl, { timeoutMs: options.timeoutMs });
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {}, {
    timeoutMs: options.timeoutMs,
  });
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for row peek block actions smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const databaseTitle = `Row peek block actions ${suffix}`;
  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: databaseTitle,
    viewType: 'table',
  }, { timeoutMs: options.timeoutMs });
  assert(created?.page?.id === databaseId, 'row peek block actions smoke database must be created');
  const row = created.rows?.[0];
  assert(row?.id, 'row peek block actions smoke needs a seeded row');
  const rowTitle = `Row peek body menu ${suffix}`;
  await updateRow(baseUrl, session.accessToken, row.id, { title: rowTitle });

  const blockId = randomUUID();
  const blockText = `Row peek block menu target ${suffix}`;
  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: blockId,
        pageId: row.id,
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: blockText }] },
        plainText: blockText,
        position: 1,
      },
    ],
  }, { timeoutMs: options.timeoutMs });
  assert(createdBlocks?.blocks?.length === 1, 'row peek body block must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    databaseTitle,
    rowId: row.id,
    rowTitle,
    blockId,
    blockText,
  };
}

async function updateRow(baseUrl, token, rowId, patch) {
  const updated = await callFunction(baseUrl, token, 'database-row-mutation', {
    action: 'update',
    id: rowId,
    patch,
  }, { timeoutMs: options.timeoutMs });
  if (patch.title) assert(updated?.row?.title === patch.title, `row ${rowId} title must be updated`);
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
      console.log(`Usage: node scripts/row-peek-block-actions-ui-smoke.mjs [options]

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
