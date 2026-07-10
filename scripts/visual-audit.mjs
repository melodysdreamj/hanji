#!/usr/bin/env node
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchBrowserErrors } from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputDir = join(root, '.edgebase', 'visual-audit', 'current');
const defaultBaseUrl = process.env.NOTIONLIKE_VISUAL_BASE_URL ?? 'http://127.0.0.1:8787';
const defaultCaptureDelayMs = 750;

const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];
const databaseViewTargets = ['Table', 'Board', 'List', 'Gallery', 'Calendar', 'Timeline'];
const databaseViewsToCreate = databaseViewTargets.filter((name) => name !== 'Table');

const options = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(options.baseUrl);
const outputDir = resolve(options.outputDir);
const manifest = {
  baseUrl,
  createdAt: new Date().toISOString(),
  outputDir,
  seededStarterPagePath: null,
  seededPagePath: null,
  seededWrittenPagePath: null,
  seededDatabasePath: null,
  captures: [],
  warnings: [],
};

await waitForEdgeBase(baseUrl, options.timeoutMs);
await assertServedBundleMatchesDist(baseUrl);

const { chromium } = await loadPlaywright();
const executablePath = resolveChromeExecutable();
const browser = await chromium.launch({
  headless: !options.headed,
  ...(executablePath ? { executablePath } : {}),
});

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const errors = [];
const initialAuthErrorWindows = new WeakMap();

try {
  const context = await browser.newContext();
  const seededStarterPagePath = options.seed ? await ensureAuditStarterPage(context, errors) : null;
  const seededPagePath = options.seed ? await ensureAuditPage(context, errors) : null;
  const seededWrittenPagePath = options.seed ? await ensureAuditWrittenPage(context, errors) : null;
  const seededDatabasePath = options.seed ? await ensureAuditDatabase(context, errors) : null;
  manifest.seededStarterPagePath = seededStarterPagePath;
  manifest.seededPagePath = seededPagePath;
  manifest.seededWrittenPagePath = seededWrittenPagePath;
  manifest.seededDatabasePath = seededDatabasePath;

  const targets = buildTargets({
    seededStarterPagePath,
    seededPagePath,
    seededWrittenPagePath,
    seededDatabasePath,
  });
  for (const viewport of viewports) {
    for (const target of targets) {
      await captureTarget(context, viewport, target, errors);
      await sleep(options.captureDelayMs);
    }
  }

  writeFileSync(
    join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
} finally {
  await browser.close();
}

if (errors.length && !options.allowConsoleErrors) {
  console.error('\nVisual audit captured browser errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS visual audit captured ${manifest.captures.length} screenshots.`);
  console.log(`Output: ${outputDir}`);
}

function parseArgs(args) {
  const parsed = {
    allowConsoleErrors: false,
    baseUrl: defaultBaseUrl,
    headed: false,
    outputDir: defaultOutputDir,
    seed: true,
    captureDelayMs: defaultCaptureDelayMs,
    timeoutMs: 30_000,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--allow-console-errors') {
      parsed.allowConsoleErrors = true;
      continue;
    }
    if (arg === '--headed') {
      parsed.headed = true;
      continue;
    }
    if (arg === '--no-seed') {
      parsed.seed = false;
      continue;
    }
    if (arg === '--base-url') {
      parsed.baseUrl = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      parsed.outputDir = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isFinite(value) || value < 1000) {
        throw new Error('--timeout-ms must be a number >= 1000');
      }
      parsed.timeoutMs = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--capture-delay-ms') {
      const value = Number(readValue(args, i, arg));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--capture-delay-ms must be a number >= 0');
      }
      parsed.captureDelayMs = Math.floor(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/visual-audit.mjs [options]

Captures desktop and mobile screenshots from a running Notionlike EdgeBase app.

Options:
  --base-url <url>          App URL. Defaults to NOTIONLIKE_VISUAL_BASE_URL or ${defaultBaseUrl}
  --output <path>           Screenshot output directory. Defaults to ${defaultOutputDir}
  --no-seed                 Do not create a first page when the workspace is empty.
  --headed                  Show the browser while capturing.
  --allow-console-errors    Do not fail when browser console/page errors are captured.
  --timeout-ms <ms>         Server/page timeout. Defaults to 30000.
  --capture-delay-ms <ms>   Delay after each capture. Defaults to ${defaultCaptureDelayMs}.
`);
}

function readValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function waitForEdgeBase(url, timeoutMs) {
  const startedAt = Date.now();
  const healthUrl = new URL('/api/health', url).toString();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { headers: { accept: 'application/json' } });
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  throw new Error(
    `Could not reach EdgeBase at ${healthUrl}. Start it with: npm --prefix backend run dev. Last error: ${lastError}`,
  );
}

async function assertServedBundleMatchesDist(url) {
  const localIndexPath = join(root, 'web', 'dist', 'index.html');
  if (!existsSync(localIndexPath)) return;

  const localHtml = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(localIndexPath, 'utf8'),
  );
  const response = await fetch(new URL('/', url), {
    headers: { accept: 'text/html' },
  });
  if (!response.ok) return;

  const servedHtml = await response.text();
  const localAssets = assetRefs(localHtml);
  const servedAssets = assetRefs(servedHtml);
  if (!localAssets.length || !servedAssets.length) return;

  const localKey = localAssets.join('\n');
  const servedKey = servedAssets.join('\n');
  if (localKey === servedKey) return;

  throw new Error(
    [
      'The running EdgeBase app is serving a stale SPA bundle.',
      'Restart `npm --prefix backend run dev` after the latest web build, then rerun visual audit.',
      `Local dist assets: ${localAssets.join(', ')}`,
      `Served assets: ${servedAssets.join(', ')}`,
    ].join('\n'),
  );
}

function assetRefs(html) {
  return [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('/assets/'))
    .map((value) => value.replace(/[?#].*$/, ''))
    .sort();
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // Continue with the local EdgeBase workspace fallback below.
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
    'Playwright is required for visual audit. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or build the local EdgeBase workspace dependencies.',
  );
}

function edgeBasePlaywrightCandidates() {
  const edgebaseRoot =
    process.env.EDGEBASE_ROOT ?? new URL('../../edgebase', import.meta.url).pathname;
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
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return undefined;
}

async function ensureAuditStarterPage(context, errors) {
  const page = await newPage(context, 'seed:starter-page', errors);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openRoute(page, '/');

    const newPageButton = page.getByRole('button', { name: /^new page$/i }).first();
    await newPageButton.waitFor({ state: 'visible', timeout: 10_000 });
    await newPageButton.click();
    await page.waitForURL(/\/p\//, { timeout: 10_000 }).catch(() => {});
    const starterVisible = await waitForPageStarter(page).then(() => true, () => false);
    if (!starterVisible) {
      manifest.warnings.push(
        'The current new-page flow did not expose the optional database starter; page-starter capture was skipped.',
      );
      return null;
    }

    const createdPath = await currentPath(page);
    if (createdPath.startsWith('/p/')) return createdPath;
    manifest.warnings.push('Could not seed a page starter capture; page-starter capture was skipped.');
    return null;
  } finally {
    await page.close();
  }
}

async function ensureAuditPage(context, errors) {
  const page = await newPage(context, 'seed', errors);
  try {
    await openRoute(page, '/');

    const newPageButton = page.getByRole('button', { name: /^new page$/i }).first();
    if (await newPageButton.isVisible({ timeout: 1500 }).catch(() => false)) {
      await newPageButton.click();
      await page.waitForURL(/\/p\//, { timeout: 10_000 }).catch(() => {});
      await waitForEditableBlock(page).catch(() => {});
      const createdPath = await currentPath(page);
      if (createdPath.startsWith('/p/')) return createdPath;
    }

    const initialPath = await currentPath(page);
    if (initialPath.startsWith('/p/') || initialPath.startsWith('/database/')) {
      return initialPath;
    }

    manifest.warnings.push('Could not seed or locate an editable page; page-editor capture will use /.');
    return null;
  } finally {
    await page.close();
  }
}

async function ensureAuditWrittenPage(context, errors) {
  const page = await newPage(context, 'seed:written-page', errors);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openRoute(page, '/');
    return await page.evaluate(async () => {
      async function createAccessToken() {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-edgebase-auth-transport': 'cookie',
          },
          credentials: 'include',
          body: '{}',
        });
        const text = await response.text();
        const json = text ? JSON.parse(text) : {};
        if (!response.ok || !json?.accessToken || Object.hasOwn(json, 'refreshToken')) {
          throw new Error(
            `auth refresh failed (${response.status}): ${json?.error ?? json?.message ?? text}`,
          );
        }
        return json.accessToken;
      }

      const accessToken = await createAccessToken();

      async function postFunction(name, body) {
        const response = await fetch(`/api/functions/${name}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        const text = await response.text();
        const json = text ? JSON.parse(text) : {};
        if (!response.ok) {
          throw new Error(
            `${name} failed (${response.status}): ${json?.error ?? json?.message ?? text}`,
          );
        }
        return json;
      }

      const bootstrap = await postFunction('workspace-bootstrap', {});
      const workspaceId = bootstrap?.workspace?.id;
      if (!workspaceId) throw new Error('workspace-bootstrap did not return a workspace id.');

      const pageId = crypto.randomUUID();
      await postFunction('page-mutation', {
        action: 'create',
        id: pageId,
        workspaceId,
        parentId: null,
        parentType: 'workspace',
        kind: 'page',
        title: 'Visual audit page',
        icon: '',
        iconType: 'none',
        cover: 'linear-gradient(135deg, #f7f1df 0%, #d9edf7 48%, #e7dff4 100%)',
        coverPosition: 50,
        position: Date.now(),
      });

      const rich = (text, extra = {}) => ({ text, ...extra });
      const blocks = [
        {
          id: crypto.randomUUID(),
          pageId,
          parentId: null,
          type: 'heading_1',
          content: { rich: [rich('Launch readiness')] },
          plainText: 'Launch readiness',
          position: 1000,
        },
        {
          id: crypto.randomUUID(),
          pageId,
          parentId: null,
          type: 'paragraph',
          content: {
            rich: [
              rich('A compact page for visual auditing '),
              rich('spacing', { bold: true }),
              rich(', menus, focus states, and text rhythm.'),
            ],
          },
          plainText: 'A compact page for visual auditing spacing, menus, focus states, and text rhythm.',
          position: 2000,
        },
        {
          id: crypto.randomUUID(),
          pageId,
          parentId: null,
          type: 'to_do',
          content: { checked: false, rich: [rich('Check desktop and mobile alignment')] },
          plainText: 'Check desktop and mobile alignment',
          position: 3000,
        },
        {
          id: crypto.randomUUID(),
          pageId,
          parentId: null,
          type: 'bulleted_list_item',
          content: { rich: [rich('Hover handles, focus rings, and command menus should feel calm.')] },
          plainText: 'Hover handles, focus rings, and command menus should feel calm.',
          position: 4000,
        },
        {
          id: crypto.randomUUID(),
          pageId,
          parentId: null,
          type: 'callout',
          content: {
            icon: 'i',
            color: 'blue_background',
            rich: [rich('This seeded page is created through EdgeBase backend functions.')],
          },
          plainText: 'This seeded page is created through EdgeBase backend functions.',
          position: 5000,
        },
      ];
      await postFunction('block-mutation', { action: 'createMany', blocks });
      return `/p/${pageId}`;
    });
  } finally {
    await page.close();
  }
}

async function ensureAuditDatabase(context, errors) {
  const page = await newPage(context, 'seed:database', errors);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openRoute(page, '/');

    const newPageButton = page.getByRole('button', { name: /^new page$/i }).first();
    await newPageButton.waitFor({ state: 'visible', timeout: 10_000 });
    await newPageButton.click();
    await page.waitForURL(/\/p\//, { timeout: 10_000 }).catch(() => {});
    const starterVisible = await waitForPageStarter(page).then(() => true, () => false);
    if (!starterVisible) {
      manifest.warnings.push(
        'The current new-page flow did not expose the optional database starter; database captures were skipped.',
      );
      return null;
    }

    await clickStarterDatabaseButton(page, 'Table');
    await waitForDatabaseReady(page);

    const openAsPageButton = page.getByRole('button', { name: /^open .+ as page$/i }).first();
    if (await openAsPageButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await openAsPageButton.click({ force: true, timeout: 5000 });
      await page.waitForURL(/\/p\//, { timeout: 10_000 }).catch(() => {});
      await waitForDatabaseReady(page);
    } else {
      manifest.warnings.push(
        'Could not open the seeded inline database as a full page; database captures will use the parent page.',
      );
    }

    for (const viewName of databaseViewsToCreate) {
      await ensureDatabaseView(page, viewName);
    }

    await ensureDatabaseDateProperty(page);
    await seedDatabaseContent(page);
    const seededPath = await currentPathname(page);
    await openRoute(page, seededPath);
    await waitForDatabaseReady(page);
    await selectDatabaseView(page, 'Table');
    await waitForDatabaseSeedReady(page);
    return currentPathname(page);
  } finally {
    await page.close();
  }
}

function buildTargets({
  seededStarterPagePath,
  seededPagePath,
  seededWrittenPagePath,
  seededDatabasePath,
}) {
  const pagePath = seededPagePath ?? '/';
  const writtenPagePath = seededWrittenPagePath ?? pagePath;
  const targets = [
    { id: 'shell-home', path: pagePath },
    { id: 'page-editor', path: pagePath },
    ...(seededStarterPagePath
      ? [{ id: 'page-starter', path: seededStarterPagePath, interact: waitForPageStarter }]
      : []),
    ...(seededWrittenPagePath
      ? [
          { id: 'page-written', path: writtenPagePath, interact: waitForWrittenPageReady },
          {
            id: 'editor-focus',
            path: writtenPagePath,
            interact: async (page) => {
              await focusFirstEditableBlock(page);
            },
          },
          {
            id: 'block-hover',
            path: writtenPagePath,
            interact: async (page) => {
              await hoverFirstBlock(page);
            },
          },
        ]
      : []),
    { id: 'settings-route', path: '/settings' },
    { id: 'trash-route', path: '/trash' },
    {
      id: 'search-overlay',
      path: pagePath,
      interact: async (page) => {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
        await waitForDialog(page, /quick find/i);
      },
    },
    {
      id: 'templates-dialog',
      path: pagePath,
      interact: async (page, viewport) => {
        await openSidebarIfNeeded(page, viewport);
        await clickSidebarButton(page, /^templates$/i);
        await waitForDialog(page, /^templates$/i);
      },
    },
    {
      id: 'import-dialog',
      path: pagePath,
      interact: async (page, viewport) => {
        await openSidebarIfNeeded(page, viewport);
        await clickSidebarButton(page, /^import$/i);
        await waitForDialog(page, /^import$/i);
      },
    },
    {
      id: 'share-menu',
      path: pagePath,
      interact: async (page) => {
        await clickButton(page, /^share\b/i);
        await waitForDialog(page, /^share\b/i);
      },
    },
    {
      id: 'comments-panel',
      path: pagePath,
      interact: async (page) => {
        await clickButton(page, /^(add comment to|open \d+ comments? for)/i);
        await waitForDialog(page, /^comments$/i);
      },
    },
    {
      id: 'slash-menu',
      path: pagePath,
      interact: async (page) => {
        await openSlashMenu(page);
      },
      afterCapture: async (page) => {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      },
    },
    {
      id: 'block-actions-menu',
      path: pagePath,
      interact: async (page) => {
        await openBlockActionsMenu(page);
      },
    },
  ];

  if (!seededDatabasePath) {
    manifest.warnings.push('No seeded database was available; database view captures were skipped.');
    return targets;
  }

  for (const viewName of databaseViewTargets) {
    targets.push({
      id: `database-${viewName.toLowerCase()}`,
      path: seededDatabasePath,
      interact: async (page) => {
        await selectDatabaseView(page, viewName);
        await waitForDatabaseViewSettled(page);
      },
    });
  }

  targets.push({
    id: 'database-row-peek',
    path: seededDatabasePath,
    interact: async (page) => {
      await selectDatabaseView(page, 'Table');
      await waitForDatabaseViewSettled(page);
      await clickFirstOpenRowButton(page);
      await page.getByRole('dialog', { name: /preview$/i }).first().waitFor({
        state: 'visible',
        timeout: 5000,
      });
      await page.waitForTimeout(500);
    },
  });

  return targets;
}

async function waitForPageStarter(page) {
  await page.getByRole('group', { name: /^database$/i }).first().waitFor({
    state: 'visible',
    timeout: 2500,
  });
}

async function clickStarterDatabaseButton(page, viewName) {
  const starterGroup = page.getByRole('group', { name: /^database$/i }).first();
  const button = starterGroup.getByRole('button', {
    name: new RegExp(`^${escapeRegExp(viewName)}$`, 'i'),
  }).first();
  await button.click({ timeout: 5000 });
}

async function waitForDatabaseReady(page) {
  await page.getByRole('button', { name: /^add (a )?view$/i }).first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  await databaseViewTab(page, 'Table').waitFor({ state: 'visible', timeout: 10_000 });
  await waitForDatabaseViewSettled(page);
}

async function ensureDatabaseView(page, viewName) {
  if (await databaseViewTab(page, viewName).isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }

  await clickButton(page, /^add view$/i);
  await waitForDialog(page, /^new view$/i);

  const typeButton = page
    .locator('[data-add-view-type]')
    .filter({ hasText: new RegExp(escapeRegExp(viewName), 'i') })
    .first();
  await typeButton.click({ timeout: 5000 });
  await clickButton(page, /^create$/i);

  await databaseViewTab(page, viewName).waitFor({ state: 'visible', timeout: 10_000 });
  await selectDatabaseView(page, viewName);
}

async function ensureDatabaseDateProperty(page) {
  await selectDatabaseView(page, 'Calendar');
  await waitForDatabaseViewSettled(page);

  const addDateButton = page.getByRole('button', { name: /^date$/i }).first();
  if (!(await addDateButton.isVisible({ timeout: 1000 }).catch(() => false))) {
    return;
  }

  await addDateButton.click({ timeout: 5000 });
  await page.getByText(/^No date \(\d+\)$/i).first().waitFor({
    state: 'visible',
    timeout: 10_000,
  }).catch(() => {});
  await waitForDatabaseViewSettled(page);
}

async function seedDatabaseContent(page) {
  const path = await currentPathname(page);
  const databaseId = path.startsWith('/p/') ? path.slice(3).split('/')[0] : '';
  if (!databaseId) {
    manifest.warnings.push('Could not seed richer database rows because the database page id was not in the route.');
    return;
  }

  await page.evaluate(async (dbId) => {
    async function createAccessToken() {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-edgebase-auth-transport': 'cookie',
        },
        credentials: 'include',
        body: '{}',
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok || !json?.accessToken || Object.hasOwn(json, 'refreshToken')) {
        throw new Error(
          `auth refresh failed (${response.status}): ${json?.error ?? json?.message ?? text}`,
        );
      }
      return json.accessToken;
    }

    const accessToken = await createAccessToken();

    async function postFunction(name, body) {
      const response = await fetch(`/api/functions/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          `${name} failed (${response.status}): ${json?.error ?? json?.message ?? text}`,
        );
      }
      return json;
    }

    function propByName(properties, name) {
      return properties.find((prop) => prop.name === name);
    }

    function optionId(prop, optionName) {
      return prop?.config?.options?.find((option) => option.name === optionName)?.id;
    }

    const snapshot = await postFunction('page-query', {
      action: 'database',
      databaseId: dbId,
    });
    const rowsResult = await postFunction('page-query', {
      action: 'databaseRows',
      databaseId: dbId,
    });

    const properties = snapshot.properties ?? [];
    const views = snapshot.views ?? [];
    const status = propByName(properties, 'Status');
    const tags = propByName(properties, 'Tags');
    const date = propByName(properties, 'Date');
    const visibleProperties = properties.map((prop) => prop.id);

    await postFunction('page-mutation', {
      action: 'update',
      id: dbId,
      patch: { title: 'Visual audit tracker' },
    });

    const viewUpdates = views.map((view) => {
      const config = { ...(view.config ?? {}) };
      if (view.type === 'table') {
        config.propertyOrder = visibleProperties;
        config.visibleProperties = visibleProperties;
      }
      if (view.type === 'board' && status) {
        config.groupBy = status.id;
        config.visibleProperties = visibleProperties;
        config.cardSize = 'medium';
      }
      if (view.type === 'gallery') {
        config.visibleProperties = visibleProperties;
        config.cardSize = 'medium';
      }
      if (view.type === 'calendar' && date) config.calendarBy = date.id;
      if (view.type === 'timeline' && date) {
        config.timelineBy = date.id;
        config.timelineZoom = 'week';
      }
      return { id: view.id, patch: { config } };
    });
    if (viewUpdates.length > 0) {
      await postFunction('database-mutation', {
        action: 'updateMany',
        table: 'db_views',
        updates: viewUpdates,
      });
    }

    const rows = (rowsResult.rows ?? []).slice(0, 3);
    const seededRows = [
      {
        title: 'Planning brief',
        icon: 'P',
        cover: 'linear-gradient(135deg, #f6ead3 0%, #d7ecf3 100%)',
        status: 'Not started',
        tags: ['Idea'],
        date: '2026-06-24',
      },
      {
        title: 'Design polish',
        icon: 'D',
        cover: 'linear-gradient(135deg, #e1f0db 0%, #d9e7fb 100%)',
        status: 'In progress',
        tags: ['Idea', 'Urgent'],
        date: '2026-06-26',
      },
      {
        title: 'Launch checklist',
        icon: 'L',
        cover: 'linear-gradient(135deg, #e9e0f3 0%, #f7e4dc 100%)',
        status: 'Done',
        tags: ['Urgent'],
        date: '2026-06-30',
      },
    ];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const seed = seededRows[index];
      const nextProperties = { ...(row.properties ?? {}) };
      if (status) nextProperties[status.id] = optionId(status, seed.status) ?? null;
      if (tags) {
        nextProperties[tags.id] = seed.tags
          .map((name) => optionId(tags, name))
          .filter(Boolean);
      }
      if (date) nextProperties[date.id] = seed.date;

      await postFunction('page-mutation', {
        action: 'update',
        id: row.id,
        patch: {
          title: seed.title,
          icon: seed.icon,
          iconType: 'emoji',
          cover: seed.cover,
          coverPosition: 50,
        },
      });
      await postFunction('database-row-mutation', {
        action: 'update',
        id: row.id,
        patch: {
          properties: nextProperties,
        },
      });
    }
  }, databaseId);
}

async function waitForDatabaseSeedReady(page) {
  const labels = ['Planning brief', 'Design polish', 'Launch checklist'];
  const ok = await page.waitForFunction(
    (expected) => {
      const bodyText = document.body.innerText;
      const inputValues = Array.from(document.querySelectorAll('input, textarea'))
        .map((element) => element.value);
      return expected.every((label) => bodyText.includes(label) || inputValues.includes(label));
    },
    labels,
    { timeout: 10_000 },
  ).then(() => true, () => false);
  if (ok) return;
  const bodyText = await page.evaluate(() => document.body.innerText);
  const inputText = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea'))
      .map((element) => element.value)
      .filter(Boolean)
      .join(', '),
  );
  throw new Error(
    `Seeded database rows did not render. Expected ${labels.join(', ')}. Body text: ${bodyText.slice(0, 1200)} Input values: ${inputText}`,
  );
}

async function selectDatabaseView(page, viewName) {
  const tab = databaseViewTab(page, viewName);
  await tab.click({ timeout: 5000 });
  await page.waitForFunction(
    (name) => {
      const tabs = Array.from(document.querySelectorAll('button[data-view-tab]'));
      return tabs.some((tab) => tab.getAttribute('aria-current') === 'page' && tab.textContent?.trim() === name);
    },
    viewName,
    { timeout: 5000 },
  ).catch(() => {});
}

function databaseViewTab(page, viewName) {
  return page
    .locator('button[data-view-tab]')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(viewName)}\\s*$`, 'i') })
    .first();
}

async function waitForDatabaseViewSettled(page) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function clickFirstOpenRowButton(page) {
  const firstTitleCell = page.locator('[data-table-cell][data-col-index="0"]').first();
  await firstTitleCell.hover({ timeout: 5000 });
  const openRow = firstTitleCell.locator('button[aria-label^="Open "]').first();
  await openRow.click({ timeout: 5000 });
}

async function waitForWrittenPageReady(page) {
  await page.getByRole('textbox', { name: /^page title$/i }).first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  await page.getByText('Launch readiness').first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  await page.getByText('This seeded page is created through EdgeBase backend functions.').first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
}

async function focusFirstEditableBlock(page) {
  await waitForWrittenPageReady(page);
  const editable = page
    .locator('[data-block-id][data-page-id] [contenteditable="true"][role="textbox"]')
    .first();
  await editable.click({ timeout: 5000 });
  await page.waitForTimeout(500);
}

async function hoverFirstBlock(page) {
  await waitForWrittenPageReady(page);
  const block = page.locator('[data-block-id][data-page-id]').first();
  await block.hover({ timeout: 5000 });
  await page.waitForTimeout(500);
}

async function openSlashMenu(page) {
  const block = page.locator('[data-block-id][data-page-id]').first();
  await block.waitFor({ state: 'visible', timeout: 10_000 });
  await revealBlockGutter(page, block);
  await clickBlockGutterButton(
    page,
    block.getByRole('button', { name: /^add block below$/i }),
  );
  const menu = page.getByRole('listbox', { name: /^block commands$/i }).first();
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
}

async function openBlockActionsMenu(page) {
  const block = page.locator('[data-block-id][data-page-id]').first();
  await block.waitFor({ state: 'visible', timeout: 10_000 });
  await revealBlockGutter(page, block);
  const actionButton = block.getByRole('button', { name: /^open block actions$/i });
  await clickBlockGutterButton(page, actionButton);
  const menu = page.getByRole('menu', { name: /^block actions$/i }).first();
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
}

async function revealBlockGutter(page, block) {
  if ((page.viewportSize()?.width ?? 1024) <= 760) {
    await block.locator('[contenteditable="true"][role="textbox"]').first().click({ timeout: 5000 });
  } else {
    await block.hover({ timeout: 5000 });
  }
}

async function clickBlockGutterButton(page, button) {
  await button.waitFor({ state: 'visible', timeout: 5000 });
  if ((page.viewportSize()?.width ?? 1024) <= 760) {
    // The mobile gutter intentionally sits just outside the content viewport;
    // focus reveals it, and a DOM click mirrors the touch handler without
    // Playwright trying to scroll the negative gutter coordinate onscreen.
    await button.evaluate((element) => element.click());
    return;
  }
  await button.click({ timeout: 5000 });
}

async function waitForEditableBlock(page) {
  const emptyPageButton = page.getByRole('button', { name: /^empty page$/i }).first();
  if (await emptyPageButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await emptyPageButton.click({ timeout: 5000 });
    await page.waitForTimeout(250);
  }

  await page.locator('[data-block-id][data-page-id]').first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  const editable = page
    .locator('[data-block-id][data-page-id] [contenteditable="true"][role="textbox"]')
    .first();
  await editable.waitFor({ state: 'visible', timeout: 10_000 });
  return editable;
}

async function captureTarget(context, viewport, target, errors) {
  const page = await newPage(context, `${viewport.name}:${target.id}`, errors);
  const filename = `${viewport.name}-${target.id}.png`;
  const screenshotPath = join(outputDir, filename);

  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openRoute(page, target.path);
    if (target.interact) await target.interact(page, viewport);
    await assertPageNotBlank(page, target.id);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    if (target.afterCapture) await target.afterCapture(page, viewport);

    const size = statSync(screenshotPath).size;
    if (size < 2000) throw new Error(`${filename} is unexpectedly small (${size} bytes).`);

    manifest.captures.push({
      id: target.id,
      viewport: viewport.name,
      route: await currentPath(page),
      screenshot: screenshotPath,
      bytes: size,
    });
    console.log(`PASS ${viewport.name} ${target.id}: ${screenshotPath}`);
  } catch (error) {
    const failedPath = screenshotPath.replace(/\.png$/, '-failed.png');
    await page.screenshot({ path: failedPath, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
}

async function newPage(context, label, errors) {
  const page = await context.newPage();
  const watcher = watchBrowserErrors(page, {
    errors,
    prefix: `${label}: `,
    allowInitialSignedOutRefresh401: true,
  });
  initialAuthErrorWindows.set(page, watcher.endInitialSignedOutRefreshWindow);
  return page;
}

async function openRoute(page, path) {
  const url = new URL(path, baseUrl).toString();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);
  const guestButton = page.getByRole('button', {
    name: /^(?:Continue as guest|게스트로 계속)$/i,
  }).first();
  if (await guestButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await initialAuthErrorWindows.get(page)?.();
    await guestButton.click({ timeout: 5000 });
    await page.getByRole('button', { name: /^(?:Open workspace menu|워크스페이스 메뉴 열기)$/i })
      .waitFor({ state: 'visible', timeout: 10_000 });
  } else {
    await initialAuthErrorWindows.get(page)?.();
  }
}

async function openSidebarIfNeeded(page, viewport) {
  if (viewport.width > 767) return;
  const openButton = page.getByRole('button', { name: /^open sidebar$/i }).first();
  if (await openButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await openButton.click();
    await page.locator('aside[aria-label="Sidebar"]').first().waitFor({
      state: 'visible',
      timeout: 5000,
    });
    await page.waitForTimeout(250);
  }
}

async function clickSidebarButton(page, name) {
  const sidebar = page.locator('aside[aria-label="Sidebar"]').first();
  await sidebar.waitFor({ state: 'visible', timeout: 5000 });
  const button = sidebar.getByRole('button', { name }).last();
  await button.click({ timeout: 5000 });
}

async function clickButton(page, name) {
  const button = page.getByRole('button', { name }).first();
  await button.click({ timeout: 5000 });
}

async function waitForDialog(page, name) {
  await page.getByRole('dialog', { name }).first().waitFor({
    state: 'visible',
    timeout: 5000,
  });
  await page.waitForTimeout(500);
}

async function assertPageNotBlank(page, label) {
  const startedAt = Date.now();
  let result = await pageRenderState(page);

  while (
    Date.now() - startedAt < 6000 &&
    (result.rootWidth < 100 || result.rootHeight < 100 || result.bodyTextLength < 2)
  ) {
    await page.waitForTimeout(250);
    result = await pageRenderState(page);
  }

  if (result.rootWidth < 100 || result.rootHeight < 100 || result.bodyTextLength < 2) {
    throw new Error(`${label} rendered blank or nearly blank: ${JSON.stringify(result)}`);
  }
}

async function pageRenderState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText?.trim() ?? '';
    const root = document.getElementById('root');
    const rect = root?.getBoundingClientRect();
    return {
      bodyTextLength: text.length,
      rootHeight: rect?.height ?? 0,
      rootWidth: rect?.width ?? 0,
    };
  });
}

async function currentPath(page) {
  return page.evaluate(() => `${location.pathname}${location.search}${location.hash}`);
}

async function currentPathname(page) {
  return page.evaluate(() => location.pathname);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
