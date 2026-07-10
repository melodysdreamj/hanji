#!/usr/bin/env node
// Local-first UI visual pass (docs/notion-reference-loop.md, changed-surface
// loop). Surfaces + normalized contracts:
//
//  1. TopBar ··· "Available offline" row — must follow the app's existing
//     menu-toggle convention (Small text / Full width rows; current Notion's
//     offline row uses the same label + right-aligned switch pattern): icon,
//     flex-1 label, 32×18 right-aligned switch, sibling row height rhythm.
//  2. SyncStatusBadge — offline pill bottom-left: pill radius, compact 12px
//     type, dot + "오프라인" text, viewport-anchored. NAMED DEVIATION: Notion
//     surfaces connection state in the topbar; Notionlike keeps a bottom-left
//     pill (topbar space is already dense) — recorded, not parity-claimed.
//  3. LocalLockGate — product-only surface (no Notion equivalent): centered
//     card ≤360px, password input auto-focused, primary disabled until input,
//     wrong-pass error state, mobile containment.
//  4. Settings 계정 보안 → 로컬 데이터 잠금 panel — must share the security
//     panel rhythm (strong+span header, passwordChangeForm rows) with the
//     비밀번호 panel above it.
//
// Reference note (loop rule): real-Notion capture for the offline row was
// SKIPPED by user choice this pass — contracts are internal-consistency
// based; the surfaces stay Partial in the feature matrix and are not
// promoted to parity-Done from these screenshots alone.

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASE_URL,
  assert,
  assertRuntimeReachable,
  callFunction,
  loadPlaywright,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'local-first');
const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL local-first UI visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Local-first UI visual smoke target: ${appUrl}`);
  mkdirSync(SHOT_DIR, { recursive: true });

  await assertRuntimeReachable(apiUrl);
  const seed = await seedPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertOfflinePinRow(browser, appUrl, seed, 'light');
    await assertOfflinePinRow(browser, appUrl, seed, 'dark');
    console.log('PASS offline pin row follows the menu-toggle convention (light/dark).');

    await assertSyncBadge(browser, appUrl, seed, 'light');
    await assertSyncBadge(browser, appUrl, seed, 'dark');
    console.log('PASS sync badge pill geometry/type contract (light/dark).');

    await assertLockGate(browser, appUrl, seed);
    console.log('PASS local lock gate card/input/error contracts (desktop/mobile).');

    await assertSettingsLockPanel(browser, appUrl, seed);
    console.log('PASS settings 로컬 데이터 잠금 panel shares the security panel rhythm.');

    console.log('\nPASS local-first UI surfaces match their normalized contracts.');
    console.log(`Screenshots: ${SHOT_DIR}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed);
  }
}

// ── 1. offline pin row ──────────────────────────────────────────────────────

async function assertOfflinePinRow(browser, appUrl, seed, theme) {
  const context = await newSeededContext(browser, seed, { theme });
  const page = await context.newPage();
  await openSeededPage(page, appUrl, seed);

  await page.getByRole('button', { name: /More actions|더보기|기타/ }).first().click({
    timeout: options.timeoutMs,
  }).catch(async () => {
    // Fallback: the more button carries a page-title-derived label; target by
    // its stable DOM hook instead.
    await page.locator('[data-topbar-icon-action][aria-haspopup="menu"]').last().click({
      timeout: options.timeoutMs,
    });
  });

  const row = page.getByTestId('offline-pin-toggle');
  await row.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const facts = await row.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const icon = el.querySelector('svg')?.getBoundingClientRect() ?? null;
    const label = el.querySelector('span:not([class*="menuSwitch"])');
    const switchEl = el.querySelector('[class*="menuSwitch"]');
    const switchRect = switchEl?.getBoundingClientRect() ?? null;
    const sibling = el.parentElement
      ? [...el.parentElement.querySelectorAll('[data-menu-item]')].find((item) => item !== el)
      : null;
    return {
      row: { height: rect.height, right: rect.right },
      icon: icon ? { height: icon.height, width: icon.width } : null,
      labelText: label?.textContent ?? '',
      switch: switchRect
        ? { height: switchRect.height, right: switchRect.right, width: switchRect.width }
        : null,
      siblingHeight: sibling ? sibling.getBoundingClientRect().height : null,
      checked: el.getAttribute('aria-checked'),
    };
  });

  assert(facts.labelText.includes('Available offline'), 'pin row label must read Available offline');
  assert(facts.icon && Math.round(facts.icon.width) === 16, `pin icon must be 16px (got ${facts.icon?.width})`);
  assert(facts.switch, 'pin row must render the menuSwitch toggle (sibling convention)');
  assert(
    Math.round(facts.switch.width) === 32 && Math.round(facts.switch.height) === 18,
    `switch must be 32×18 (got ${facts.switch.width}×${facts.switch.height})`
  );
  assert(
    facts.row.right - facts.switch.right <= 12,
    `switch must right-align inside the row (gap ${facts.row.right - facts.switch.right}px)`
  );
  assert(
    facts.siblingHeight === null || Math.abs(facts.row.height - facts.siblingHeight) <= 2,
    `pin row height must match sibling menu rows (${facts.row.height} vs ${facts.siblingHeight})`
  );
  assert(facts.checked === 'false', 'pin row starts unchecked');

  await page.screenshot({
    path: join(SHOT_DIR, `offline-pin-menu-${theme}.png`),
    fullPage: false,
  });

  // Toggling flips the switch state on next open and reports readiness.
  await row.click();
  await page
    .getByText(/available offline|finish saving on your next online visit/)
    .first()
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.locator('[data-topbar-icon-action][aria-haspopup="menu"]').last().click();
  const rowAfter = page.getByTestId('offline-pin-toggle');
  await rowAfter.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const checkedAfter = await rowAfter.getAttribute('aria-checked');
  assert(checkedAfter === 'true', 'pin row must report checked after toggling');
  const switchOn = await rowAfter.locator('[class*="menuSwitch"][data-on="true"]').count();
  assert(switchOn === 1, 'switch must render its on state after toggling');
  if (theme === 'light') {
    await page.screenshot({ path: join(SHOT_DIR, 'offline-pin-menu-on.png'), fullPage: false });
  }
  await context.close();
}

// ── 2. sync badge ───────────────────────────────────────────────────────────

async function assertSyncBadge(browser, appUrl, seed, theme) {
  const context = await newSeededContext(browser, seed, { theme });
  const page = await context.newPage();
  await openSeededPage(page, appUrl, seed);
  await context.setOffline(true);

  const badge = page.getByTestId('sync-status-badge');
  await badge.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const facts = await badge.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const sidebar = document.querySelector('[data-sidebar-slot]')?.getBoundingClientRect() ?? null;
    return {
      rightGap: window.innerWidth - rect.right,
      left: rect.left,
      bottomGap: window.innerHeight - rect.bottom,
      height: rect.height,
      fontSize: style.fontSize,
      radius: style.borderRadius,
      text: el.textContent ?? '',
      dot: !!el.querySelector('span'),
      sidebarRight: sidebar ? sidebar.right : 0,
    };
  });
  assert(facts.text.includes('Offline'), `badge must announce offline (got "${facts.text}")`);
  assert(facts.dot, 'badge must render its status dot');
  assert(Math.abs(facts.rightGap - 14) <= 4, `badge anchors 14px from the right (got ${facts.rightGap})`);
  assert(Math.abs(facts.bottomGap - 14) <= 4, `badge anchors 14px from the bottom (got ${facts.bottomGap})`);
  // Finding H2: the pill must live in the content area, never over the
  // sidebar's bottom actions (New page row).
  assert(
    facts.left > facts.sidebarRight,
    `badge must not overlap the sidebar (left ${facts.left} vs sidebar right ${facts.sidebarRight})`
  );
  assert(facts.height <= 28, `badge stays a compact pill (height ${facts.height})`);
  assert(facts.fontSize === '12px', `badge type stays 12px (got ${facts.fontSize})`);
  assert(facts.radius.includes('999'), `badge keeps the pill radius (got ${facts.radius})`);

  await page.screenshot({ path: join(SHOT_DIR, `sync-badge-offline-${theme}.png`), fullPage: false });
  await context.close();
}

// ── 3. local lock gate ──────────────────────────────────────────────────────

async function assertLockGate(browser, appUrl, seed) {
  const PASS = 'visual-pass-1234';
  const lockStorage = {
    'notionlike.encryption.mode': 'passphrase',
    'notionlike.lastUserId': seed.userId,
  };

  // Desktop: first-run create + geometry contract.
  const context = await newSeededContext(browser, seed, { extra: lockStorage });
  const page = await context.newPage();
  await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const gate = page.getByTestId('local-lock-gate');
  await gate.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const facts = await gate.evaluate((el) => {
    const card = el.firstElementChild;
    const rect = card.getBoundingClientRect();
    const input = el.querySelector('input[type="password"]');
    return {
      cardWidth: rect.width,
      centeredX: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
      inputFocused: document.activeElement === input,
      viewport: window.innerWidth,
    };
  });
  assert(facts.cardWidth <= 360, `gate card stays ≤360px (got ${facts.cardWidth})`);
  assert(facts.centeredX <= 2, `gate card centers horizontally (offset ${facts.centeredX})`);
  assert(facts.inputFocused, 'passphrase input must be auto-focused');
  const unlockDisabled = await page.getByTestId('local-lock-unlock').isDisabled();
  assert(unlockDisabled, 'unlock stays disabled until a passphrase is typed');
  await page.screenshot({ path: join(SHOT_DIR, 'lock-gate-desktop.png'), fullPage: false });

  await page.getByTestId('local-lock-passphrase').fill(PASS);
  await page.getByTestId('local-lock-unlock').click();
  await gate.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await page.close();

  // Second session: wrong-pass error state (needs the key created above).
  const errorPage = await context.newPage();
  await errorPage.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await errorPage.getByTestId('local-lock-gate').waitFor({ state: 'visible', timeout: options.timeoutMs });
  await errorPage.getByTestId('local-lock-passphrase').fill('wrong-pass');
  await errorPage.getByTestId('local-lock-unlock').click();
  await errorPage.getByTestId('local-lock-error').waitFor({ state: 'visible', timeout: options.timeoutMs });
  await errorPage.screenshot({ path: join(SHOT_DIR, 'lock-gate-error.png'), fullPage: false });
  await errorPage.close();
  await context.close();

  // Mobile containment.
  const mobile = await newSeededContext(browser, seed, {
    extra: lockStorage,
    viewport: { height: 812, width: 375 },
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const mobileGate = mobilePage.getByTestId('local-lock-gate');
  await mobileGate.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const mobileFacts = await mobileGate.evaluate((el) => {
    const rect = el.firstElementChild.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth };
  });
  assert(
    mobileFacts.left >= 12 && mobileFacts.viewport - mobileFacts.right >= 12,
    `mobile gate card keeps ≥12px gutters (${mobileFacts.left}/${mobileFacts.viewport - mobileFacts.right})`
  );
  await mobilePage.screenshot({ path: join(SHOT_DIR, 'lock-gate-mobile.png'), fullPage: false });
  await mobile.close();
}

// ── 4. settings lock panel ──────────────────────────────────────────────────

async function assertSettingsLockPanel(browser, appUrl, seed) {
  const context = await newSeededContext(browser, seed, {});
  const page = await context.newPage();
  await page.goto(resolveUrl(appUrl, '/account'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator('[data-surface="account-console"]').first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  // The panel lives in the 계정 보안 section; activate its nav entry first.
  await page.getByRole('button', { name: 'Account security' }).first().click({
    timeout: options.timeoutMs,
  });

  const panel = page.getByTestId('local-lock-panel');
  await panel.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await panel.waitFor({ state: 'visible', timeout: options.timeoutMs });

  const facts = await panel.evaluate((el) => {
    const header = el.querySelector('strong');
    const inputs = [...el.querySelectorAll('input[type="password"]')];
    const button = [...el.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Turn on lock')
    );
    // Rhythm reference: the password-change panel right above shares the same
    // securityPanel/passwordChangeForm classes — compare input heights.
    const reference = el.previousElementSibling?.querySelector('input[type="password"]');
    return {
      header: header?.textContent ?? '',
      inputCount: inputs.length,
      inputHeight: inputs[0]?.getBoundingClientRect().height ?? 0,
      referenceHeight: reference?.getBoundingClientRect().height ?? null,
      hasEnable: !!button,
    };
  });
  assert(facts.header.includes('Local data lock'), 'panel header must read Local data lock');
  assert(facts.inputCount === 2, `device mode shows passphrase + confirm inputs (got ${facts.inputCount})`);
  assert(facts.hasEnable, 'panel must expose the Turn on lock action');
  assert(
    facts.referenceHeight === null || Math.abs(facts.inputHeight - facts.referenceHeight) <= 2,
    `lock inputs share the password-form rhythm (${facts.inputHeight} vs ${facts.referenceHeight})`
  );

  await panel.screenshot({ path: join(SHOT_DIR, 'settings-lock-panel.png') });
  await context.close();
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function newSeededContext(browser, seed, { extra = {}, theme = 'light', viewport } = {}) {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    ...(viewport ? { hasTouch: true, isMobile: true, viewport } : {}),
  });
  await context.addInitScript(({ refreshToken, workspaceId, theme, extra }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', theme);
    for (const [key, value] of Object.entries(extra)) {
      window.localStorage.setItem(key, value);
    }
  }, { extra, refreshToken: seed.refreshToken, theme, workspaceId: seed.workspaceId });
  return context;
}

async function openSeededPage(page, appUrl, seed) {
  await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page
    .locator(`[data-block-id="${seed.blockId}"]`)
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function seedPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  const suffix = Date.now();
  const pageId = randomUUID();
  const blockId = randomUUID();
  await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Local-first UI smoke ${suffix}`,
    position: suffix,
  });
  await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: `Seed ${suffix}` }] },
    plainText: `Seed ${suffix}`,
    position: 1,
  });
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    pageId,
    blockId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.pageId,
  }, 10_000).catch(() => {});
}

function parseArgs(args) {
  const parsed = {
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
    headed: false,
    timeoutMs: 20_000,
    url: DEFAULT_BASE_URL,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--headed') parsed.headed = true;
    else if (arg === '--url') parsed.url = args[++i] ?? parsed.url;
    else if (arg === '--api-url') parsed.apiUrl = args[++i] ?? parsed.apiUrl;
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number(args[++i] ?? parsed.timeoutMs) || parsed.timeoutMs;
  }
  return parsed;
}
