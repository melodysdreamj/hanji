#!/usr/bin/env node
// Local-first UI visual pass (docs/notion-reference-loop.md, changed-surface
// loop). Surfaces + normalized contracts:
//
//  1. Boot experience — a cache miss shows only the official Hanji product
//     icon plus one credit line; a cache hit renders the workspace immediately
//     without flashing the icon while auth and sync revalidate in the background.
//  2. TopBar ··· "Available offline" row — must follow the app's existing
//     menu-toggle convention (Small text / Full width rows; current Notion's
//     offline row uses the same label + right-aligned switch pattern): icon,
//     flex-1 label, 32×18 right-aligned switch, sibling row height rhythm.
//  3. SyncStatusBadge — offline pill bottom-left: pill radius, compact 12px
//     type, dot + "오프라인" text, viewport-anchored. NAMED DEVIATION: Notion
//     surfaces connection state in the topbar; Hanji keeps a bottom-left
//     pill (topbar space is already dense) — recorded, not parity-claimed.
//  4. LocalLockGate — product-only surface (no Notion equivalent): centered
//     card ≤360px, password input auto-focused, primary disabled until input,
//     wrong-pass error state, mobile containment.
//  5. Settings 계정 보안 → 로컬 데이터 잠금 panel — must share the security
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
  finalizeRegisteredSmokeAccounts,
  permanentlyDeletePage,
  DEFAULT_BASE_URL,
  assert,
  assertRuntimeReachable,
  captureBrowserSession,
  callFunction,
  installBrowserSession,
  loadPlaywright,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'local-first');
const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL local-first UI visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('local-first UI visual smoke');
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
    await assertBootExperience(browser, appUrl, seed);
    console.log('PASS first visit uses the official product icon/credit fallback and cached reload skips it.');

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

// ── 1. local-first boot experience ──────────────────────────────────────────

async function assertBootExperience(browser, appUrl, seed) {
  const context = await newSeededContext(browser, appUrl, seed, { theme: 'dark' });
  const page = await context.newPage();
  const browserDiagnostics = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      browserDiagnostics.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
  let bootstrapDelayMs = 1_200;

  await page.route('**/api/functions/workspace-bootstrap**', async (route) => {
    const delay = bootstrapDelayMs;
    if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    await route.continue().catch(() => {});
  });

  await page.goto(resolveUrl(appUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });

  const splash = page.getByTestId('product-loading-screen');
  await splash.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const splashFacts = await splash.evaluate((el) => {
    const mark = el.querySelector('[data-testid="product-loading-mark"]');
    const markRect = mark?.getBoundingClientRect() ?? null;
    const credit = el.querySelector('[data-testid="product-loading-credit"]');
    return {
      mark: markRect ? { height: markRect.height, width: markRect.width } : null,
      markSrc: mark instanceof HTMLImageElement ? mark.currentSrc || mark.src : '',
      credit: credit?.textContent?.trim() ?? '',
      text: el.textContent ?? '',
    };
  });
  assert(
    splashFacts.mark && Math.round(splashFacts.mark.width) === 48 && Math.round(splashFacts.mark.height) === 48,
    `first-visit mark must be 48×48px (got ${JSON.stringify(splashFacts.mark)})`
  );
  assert(splashFacts.markSrc.includes('/icon-192.png'), 'first-visit fallback must use the official Hanji product icon');
  assert(splashFacts.credit.length > 0, 'first-visit fallback must show one sponsor/built-with thank-you credit');
  assert(!/Finishing sign-in|로그인 마무리 중/.test(splashFacts.text), 'fallback must omit the old auth heading');
  assert(!/Checking your login session|로그인 세션을 확인/.test(splashFacts.text), 'fallback must omit session prose');
  assert(await page.getByTestId('legal-notice').count() === 0, 'fallback must omit the legal/source footer');
  await page.screenshot({ path: join(SHOT_DIR, 'first-visit-loading-minimal.png'), fullPage: false });

  await page.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.locator(`[data-block-id="${seed.blockId}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  // Bootstrap/block cache writes are asynchronous to the rendered response;
  // prove this is a genuinely warm reload before introducing network delay.
  await waitForCachedBlock(page, seed.recordsDbName, `blocks:${seed.pageId}`);
  await waitForCachedMeta(page, seed.recordsDbName, `bootstrap:page:${seed.pageId}`);
  const warmIdentity = await page.evaluate(() => {
    const cookieSessionKey = Object.keys(localStorage).find((key) => key.endsWith(':cookie-session'));
    return {
      cookieSession: cookieSessionKey ? localStorage.getItem(cookieSessionKey) : null,
      encryptionMode: localStorage.getItem('hanji.encryption.mode'),
      lastUserId: localStorage.getItem('hanji.lastUserId'),
    };
  });

  const revalidationDelayMs = 5_000;
  bootstrapDelayMs = revalidationDelayMs;
  await page.route('**/api/auth/refresh**', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, revalidationDelayMs));
    await route.continue().catch(() => {});
  });

  const reloadStartedAt = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  try {
    await page.locator(`[data-block-id="${seed.blockId}"]`).waitFor({
      state: 'visible',
      timeout: revalidationDelayMs - 500,
    });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 800),
      loadingScreen: !!document.querySelector('[data-testid="product-loading-screen"]'),
      loadingSource: document.querySelector('[data-testid="product-loading-screen"]')?.getAttribute('data-source'),
      loadingOpacity: (() => {
        const content = document.querySelector('[data-testid="product-loading-screen"] > div');
        return content ? getComputedStyle(content).opacity : null;
      })(),
      pageBody: !!document.querySelector('[aria-label="Page body"]'),
      path: window.location.pathname,
    }));
    await page.screenshot({ path: join(SHOT_DIR, 'cached-hard-reload-failure.png'), fullPage: false });
    throw new Error(
      `cached reload missed the local-first window: ${JSON.stringify({
        ...diagnostics,
        browserDiagnostics,
        warmIdentity,
      })}; ${error}`
    );
  }
  const cachedVisibleAfterMs = Date.now() - reloadStartedAt;
  assert(
    cachedVisibleAfterMs < revalidationDelayMs - 500,
    `cached page must render before delayed auth/sync (${cachedVisibleAfterMs}ms vs ${revalidationDelayMs}ms)`
  );
  assert(
    await page.getByTestId('product-loading-screen').count() === 0,
    'cached reload must not leave the mark/credit fallback mounted'
  );
  assert(
    await page.getByText(/Finishing sign-in|로그인 마무리 중/).count() === 0,
    'cached reload must not show the former login-finishing screen'
  );
  await page.screenshot({ path: join(SHOT_DIR, 'cached-hard-reload-no-splash.png'), fullPage: false });
  await closeSeededContext(context, appUrl, seed);
}

// ── 2. offline pin row ──────────────────────────────────────────────────────

async function assertOfflinePinRow(browser, appUrl, seed, theme) {
  const context = await newSeededContext(browser, appUrl, seed, { theme });
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
  await closeSeededContext(context, appUrl, seed);
}

// ── 2. sync badge ───────────────────────────────────────────────────────────

async function assertSyncBadge(browser, appUrl, seed, theme) {
  const context = await newSeededContext(browser, appUrl, seed, { theme });
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
  await closeSeededContext(context, appUrl, seed);
}

// ── 3. local lock gate ──────────────────────────────────────────────────────

async function assertLockGate(browser, appUrl, seed) {
  const PASS = 'visual-pass-1234';
  const lockStorage = {
    'hanji.encryption.mode': 'passphrase',
    'hanji.lastUserId': seed.userId,
  };

  // Desktop: first-run create + geometry contract.
  const context = await newSeededContext(browser, appUrl, seed, { extra: lockStorage });
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
  await closeSeededContext(context, appUrl, seed);

  // Mobile containment.
  const mobile = await newSeededContext(browser, appUrl, seed, {
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
  await closeSeededContext(mobile, appUrl, seed);
}

// ── 4. settings lock panel ──────────────────────────────────────────────────

async function assertSettingsLockPanel(browser, appUrl, seed) {
  const context = await newSeededContext(browser, appUrl, seed, {});
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
  await closeSeededContext(context, appUrl, seed);
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function newSeededContext(browser, appOrigin, seed, { extra = {}, theme = 'light', viewport } = {}) {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    ...(viewport ? { hasTouch: true, isMobile: true, viewport } : {}),
  });
  await installBrowserSession(context, seed, {
    appOrigin,
    workspaceId: seed.workspaceId,
    localStorage: { 'hanji:theme': theme, ...extra },
  });
  return context;
}

async function closeSeededContext(context, appOrigin, seed) {
  await captureBrowserSession(context, seed, { appOrigin }).catch(() => {});
  await context.close();
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

async function waitForCachedBlock(page, databaseName, tableName) {
  await page.waitForFunction(
    async ({ databaseName: name, tableName: table }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === name)) return false;
      return await new Promise((resolveReady) => {
        const request = indexedDB.open(name);
        request.onerror = () => resolveReady(false);
        request.onsuccess = () => {
          const database = request.result;
          try {
            const count = database
              .transaction('records', 'readonly')
              .objectStore('records')
              .index('byTable')
              .count(table);
            count.onerror = () => {
              database.close();
              resolveReady(false);
            };
            count.onsuccess = () => {
              database.close();
              resolveReady(count.result > 0);
            };
          } catch {
            database.close();
            resolveReady(false);
          }
        };
      });
    },
    { databaseName, tableName },
    { timeout: options.timeoutMs }
  );
}

async function waitForCachedMeta(page, databaseName, key) {
  await page.waitForFunction(
    async ({ databaseName: name, key: metaKey }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === name)) return false;
      return await new Promise((resolveReady) => {
        const request = indexedDB.open(name);
        request.onerror = () => resolveReady(false);
        request.onsuccess = () => {
          const database = request.result;
          try {
            const get = database.transaction('meta', 'readonly').objectStore('meta').get(metaKey);
            get.onerror = () => {
              database.close();
              resolveReady(false);
            };
            get.onsuccess = () => {
              database.close();
              resolveReady(get.result !== undefined);
            };
          } catch {
            database.close();
            resolveReady(false);
          }
        };
      });
    },
    { databaseName, key },
    { timeout: options.timeoutMs }
  );
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
    recordsDbName: `hanji-records:${session.userId}`,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.pageId, 10_000).catch(() => {});
}

function parseArgs(args) {
  const parsed = {
    apiUrl: process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
