#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserAuthStorageKeys,
  assert,
  assertRuntimeReachable,
  loadPlaywright,
  normalizeBaseUrl,
  resolveChromeExecutable,
  setDefaultTimeoutMs,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'row-property-alignment');
const DEFAULT_PAGE_ID = '7c1d2e34-5f68-4a90-b2c3-d4e5f6071829';
const DEFAULT_WORKSPACE_ID = '8d2e3f45-6a79-4b01-c3d4-e5f60718293a';
const DEFAULT_TIMEOUT_MS = 20_000;
const CHECK_LABELS = [
  '샘플자료',
  '가상경로',
  '샘플담당',
  '가상식별정보',
  '샘플제품',
  '가상작업',
  '샘플연락',
  '샘플연결(가상작업자)',
];

let options = {
  baseUrl: normalizeBaseUrl(DEFAULT_BASE_URL),
  pageId: DEFAULT_PAGE_ID,
  workspaceId: DEFAULT_WORKSPACE_ID,
  userId: process.env.HANJI_SMOKE_USER_ID ?? '',
  screenshotDir: DEFAULT_SCREENSHOT_DIR,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  headed: false,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const next = () => process.argv[++i] ?? '';
  if (arg === '--url') options.baseUrl = normalizeBaseUrl(next());
  else if (arg === '--page-id') options.pageId = next();
  else if (arg === '--workspace-id') options.workspaceId = next();
  else if (arg === '--user-id') options.userId = next();
  else if (arg === '--screenshot-dir') options.screenshotDir = resolve(next());
  else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
  else if (arg === '--headed') options.headed = true;
  else if (arg === '--help') {
    console.log('Usage: node scripts/row-property-alignment-smoke.mjs [--url http://127.0.0.1:8787] [--page-id <id>] [--workspace-id <id>] [--user-id <id>] [--headed] [--screenshot-dir <dir>] [--timeout-ms 20000]');
    process.exit(0);
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

setDefaultTimeoutMs(options.timeoutMs);

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteJson(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return output ? JSON.parse(output) : [];
}

function findSqliteFiles(startDir) {
  if (!existsSync(startDir)) return [];
  const found = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (name.endsWith('.sqlite')) found.push(path);
    }
  };
  visit(startDir);
  return found.sort((a, b) => sqliteCandidateRank(a) - sqliteCandidateRank(b) || a.localeCompare(b));
}

function sqliteCandidateRank(path) {
  if (/[/\\]dev-app[/\\]\.wrangler[/\\]state[/\\]v3[/\\]d1[/\\]/.test(path)) return 0;
  if (/[/\\]dev-app[/\\]/.test(path)) return 1;
  return 2;
}

function findWorkspaceAuthDb(workspaceId) {
  const candidates = findSqliteFiles(join(root, 'backend', '.edgebase', 'targets'));
  for (const candidate of candidates) {
    try {
      const rows = sqliteJson(candidate, `select id from workspaces where id = ${sqlQuote(workspaceId)} limit 1`);
      if (rows[0]?.id === workspaceId) return candidate;
    } catch {
      // Not every sqlite file is an app metadata/auth database.
    }
  }
  throw new Error(`Could not find a local workspace/auth sqlite database for workspace ${workspaceId}`);
}

function latestRefreshToken({ workspaceId, userId }) {
  const dbPath = findWorkspaceAuthDb(workspaceId);
  const memberRows = sqliteJson(dbPath, `
    select userId, role
    from workspace_members
    where workspaceId = ${sqlQuote(workspaceId)}
    order by case role when 'owner' then 0 when 'admin' then 1 else 2 end, userId
  `);
  const candidateUserIds = userId
    ? [userId]
    : memberRows.map((row) => row.userId).filter(Boolean);
  assert(candidateUserIds.length > 0, `No workspace members found for ${workspaceId}`);
  const sessions = sqliteJson(dbPath, `
    select userId, refreshToken, expiresAt
    from _sessions
    where userId in (${candidateUserIds.map(sqlQuote).join(', ')})
    order by expiresAt desc
    limit 1
  `);
  assert(sessions[0]?.refreshToken, `No local refresh token found for workspace ${workspaceId}`);
  return { dbPath, userId: sessions[0].userId, refreshToken: sessions[0].refreshToken };
}

async function main() {
  mkdirSync(options.screenshotDir, { recursive: true });
  await assertRuntimeReachable(options.baseUrl, { timeoutMs: Math.min(options.timeoutMs, 8_000) });
  const session = latestRefreshToken(options);
  const { chromium } = await loadPlaywright({ label: 'row property alignment smoke' });
  const browser = await chromium.launch({
    headless: !options.headed,
    executablePath: resolveChromeExecutable(),
  });
  const context = await browser.newContext({
    viewport: { width: 1964, height: 1224 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', 'dark');
  }, {
    refreshTokenKey: browserAuthStorageKeys(options.baseUrl).refreshTokenKey,
    refreshToken: session.refreshToken,
    workspaceId: options.workspaceId,
  });

  const page = await context.newPage();
  const browserIssues = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserIssues.push({ type: 'console', text: message.text() });
  });
  page.on('pageerror', (error) => browserIssues.push({ type: 'pageerror', text: error.stack ?? error.message }));
  page.on('response', async (response) => {
    if (response.status() < 400 || !response.url().includes('/api/')) return;
    let body = '';
    try {
      body = (await response.text()).slice(0, 400);
    } catch {
      // Ignore unreadable response bodies.
    }
    browserIssues.push({ type: 'response', status: response.status(), url: response.url(), body });
  });

  const url = `${options.baseUrl}/p/${options.pageId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-row-property-id]').length >= 6 ||
      document.body.innerText.includes('Something went wrong'),
    null,
    { timeout: options.timeoutMs },
  );
  await page.waitForTimeout(600);

  const screenshotPath = join(options.screenshotDir, 'row-property-alignment-smoke.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const evidence = await page.evaluate((labels) => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const opacity = Number(style.opacity);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        (!Number.isFinite(opacity) || opacity > 0.01) &&
        rect.width > 0 &&
        rect.height > 0;
    };
    const readableTextFor = (node) => {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const element = node;
      if (!visible(element)) return '';
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
      return Array.from(element.childNodes).map(readableTextFor).join(' ').replace(/\s+/g, ' ').trim();
    };
    const rectFor = (node) => {
      if (!node || !visible(node)) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      };
    };
    const px = (value) => Number(String(value ?? '0').replace('px', '')) || 0;
    const contentCandidateSelectors = [
      '[class*="rowPropertyEmptyValue"]',
      '[data-row-relation-chip]',
      '[data-row-relation-loading]',
      '[data-row-relation-missing]',
      '[class*="fileChip"]',
      '[class*="personChip"]',
      '[class*="chip"]',
      '[class*="linkText"]',
      '[class*="dateValue"]',
      '[class*="cellInput"]',
      '[class*="numberDisplay"]',
      '[class*="cellReadonly"]',
      '[class*="cardField"]',
      '[class*="cellCheck"]',
    ];
    const contentXFor = (valueEl) => {
      for (const selector of contentCandidateSelectors) {
        const candidates = Array.from(valueEl.querySelectorAll(selector)).filter(visible);
        const node = candidates[0];
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const selectorKey = selector.toLowerCase();
        const measuresVisualBox =
          selectorKey.includes('chip') ||
          selectorKey.includes('rowpropertyemptyvalue') ||
          selectorKey.includes('data-row-relation');
        return Math.round((rect.x + (measuresVisualBox ? 0 : px(style.paddingLeft))) * 10) / 10;
      }
      const rect = valueEl.getBoundingClientRect();
      return Math.round(rect.x * 10) / 10;
    };
    const wanted = new Set(labels);
    const rows = Array.from(document.querySelectorAll('[data-row-property-id]'))
      .map((row) => {
        const label = readableTextFor(row.querySelector('[data-row-property-label]'));
        const valueEl = row.querySelector('[class*="rowPropertyValue"]');
        const valueRect = rectFor(valueEl);
        const contentX = valueEl ? contentXFor(valueEl) : null;
        return {
          label,
          valueText: readableTextFor(valueEl).slice(0, 180),
          row: rectFor(row),
          value: valueRect,
          contentX,
          deltaFromValueColumn: valueRect && Number.isFinite(contentX)
            ? Math.round((contentX - valueRect.x) * 10) / 10
            : null,
        };
      })
      .filter((row) => wanted.has(row.label));
    return {
      url: location.href,
      title: document.title,
      bodySample: document.body.innerText.slice(0, 600),
      rows,
    };
  }, CHECK_LABELS);

  writeFileSync(
    join(options.screenshotDir, 'row-property-alignment-smoke.json'),
    JSON.stringify({ ...evidence, browserIssues, session: { dbPath: session.dbPath, userId: session.userId } }, null, 2),
  );

  assert(!evidence.bodySample.includes('Something went wrong'), `Row page failed to load: ${evidence.bodySample}`);
  assert(evidence.rows.length === CHECK_LABELS.length, `Expected row labels were not all visible: ${JSON.stringify(evidence.rows.map((row) => row.label))}`);
  const misaligned = evidence.rows.filter((row) =>
    !Number.isFinite(row.deltaFromValueColumn) || Math.abs(row.deltaFromValueColumn) > 1,
  );
  assert(
    misaligned.length === 0,
    `Row detail property values should begin on the shared value column axis: ${JSON.stringify(misaligned, null, 2)}`,
  );
  assert(browserIssues.length === 0, `Browser/API errors occurred: ${JSON.stringify(browserIssues.slice(0, 5), null, 2)}`);
  await browser.close();
  console.log(`Row property alignment verified: ${screenshotPath}`);
}

main().catch((error) => {
  console.error(`FAIL row property alignment smoke: ${error.message}`);
  process.exit(1);
});
