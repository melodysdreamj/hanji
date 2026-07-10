#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'mentions');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL mentions visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Mentions visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Mentions visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedMentionPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureInlineMentionVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1280, height: 900 },
    });
    await captureInlineMentionVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark',
      theme: 'dark',
      viewport: { width: 1280, height: 900 },
    });
    await captureInlineMentionVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      viewport: { width: 390, height: 844 },
    });
    await captureInlineMentionVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile-dark',
      theme: 'dark',
      viewport: { width: 390, height: 844 },
    });
    await captureMentionMenusVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1280, height: 900 },
    });
    await captureMentionMenusVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      viewport: { width: 390, height: 844 },
    });
    await captureEditorMentionMenuVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1280, height: 900 },
    });
    await captureEditorMentionMenuVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark',
      theme: 'dark',
      viewport: { width: 1280, height: 900 },
    });
    await captureEditorMentionMenuVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      viewport: { width: 390, height: 844 },
    });
    await captureEditorMentionMenuVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile-dark',
      theme: 'dark',
      viewport: { width: 390, height: 844 },
    });

    console.log('PASS inline mention rendering, mention popovers, and editor @ insertion menu stay within the Notion-style layout contract.');
    for (const name of ['desktop', 'desktop-dark', 'mobile', 'mobile-dark']) {
      console.log(`Inline screenshot: ${join(options.screenshotDir, `${name}-inline-mentions.png`)}`);
    }
    for (const name of ['desktop', 'mobile']) {
      for (const kind of ['page', 'date', 'person']) {
        console.log(`${kind} popover screenshot: ${join(options.screenshotDir, `${name}-${kind}-mention-popover.png`)}`);
      }
    }
    for (const name of ['desktop', 'desktop-dark', 'mobile', 'mobile-dark']) {
      console.log(`Editor @ menu screenshot: ${join(options.screenshotDir, `${name}-editor-mention-menu.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function captureInlineMentionVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openMentionPage(page, appUrl, seed);
    await assertInlineMentionContract(page, seed, variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-inline-mentions.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} inline mention visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureMentionMenusVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openMentionPage(page, appUrl, seed);
    await openInlineMentionPopover(page, 'page');
    await assertMentionPopoverContract(page, 'Page mention', variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-page-mention-popover.png`),
      fullPage: false,
    });
    await closeOpenPopover(page);

    await openInlineMentionPopover(page, 'date');
    await assertMentionPopoverContract(page, 'Edit date mention', variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-date-mention-popover.png`),
      fullPage: false,
    });
    await closeOpenPopover(page);

    await openInlineMentionPopover(page, 'person');
    await assertMentionPopoverContract(page, 'Person mention', variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-person-mention-popover.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} mention popover visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureEditorMentionMenuVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openMentionPage(page, appUrl, seed);
    await openEditorMentionMenu(page, seed);
    await assertEditorMentionMenuContract(page, seed, variant);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-editor-mention-menu.png`),
      fullPage: false,
    });
    assertNoBrowserErrors(errors, `${variant.prefix} editor @ mention menu visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openMentionPage(page, baseUrl, seed) {
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
  await expectPageTitle(page, seed.pageTitle);
  await page.locator(`[data-block-id="${seed.blockId}"] [data-mention="page"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.locator(`[data-block-id="${seed.blockId}"] [data-mention="date"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.locator(`[data-block-id="${seed.blockId}"] [data-mention="person"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openEditorMentionMenu(page, seed) {
  const editable = page.locator(`[data-block-id="${seed.inputBlockId}"] [data-rt-editable="true"]`).first();
  await editable.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await editable.click({ timeout: options.timeoutMs });
  await page.keyboard.type('@');
  await page.getByRole('listbox', { name: 'Mention' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openInlineMentionPopover(page, kind) {
  const mention = page.locator(`[data-mention="${kind}"]`).first();
  await mention.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await mention.click({ timeout: options.timeoutMs });
  const label = kind === 'page' ? 'Page mention' : kind === 'date' ? 'Edit date mention' : 'Person mention';
  await page.getByRole('dialog', { name: label }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function closeOpenPopover(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(4, 4).catch(() => {});
  await page.waitForTimeout(80);
}

async function assertInlineMentionContract(page, seed, variant) {
  const metrics = await page.evaluate(({ blockId }) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        bottom: r.bottom,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        width: r.width,
      };
    };
    const body = document.querySelector('[role="region"][aria-label="Page body"]');
    const block = document.querySelector(`[data-block-id="${blockId}"]`);
    const editable = block?.querySelector('[data-rt-editable="true"]');
    if (!(body instanceof HTMLElement) || !(block instanceof HTMLElement) || !(editable instanceof HTMLElement)) {
      return { ok: false, reason: 'missing page body, mention block, or editable' };
    }
    const mentions = Array.from(editable.querySelectorAll('[data-mention]')).filter((item) => item instanceof HTMLElement);
    return {
      ok: true,
      body: rect(body),
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      editable: rect(editable),
      mentions: mentions.map((item) => {
        const style = getComputedStyle(item);
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          color: style.color,
          kind: item.getAttribute('data-mention'),
          date: item.getAttribute('data-date') ?? '',
          rect: rect(item),
          text: item.textContent?.trim() ?? '',
        };
      }),
      viewportWidth: window.innerWidth,
    };
  }, { blockId: seed.blockId });

  assert(metrics.ok, metrics.reason ?? 'inline mention contract could not run');
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `mention fixture should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.mentions.length === 3, `inline mention fixture should render page/date/person mentions: ${JSON.stringify(metrics)}`);
  const kinds = new Set(metrics.mentions.map((item) => item.kind));
  for (const kind of ['page', 'date', 'person']) {
    assert(kinds.has(kind), `inline mention fixture missing ${kind}: ${JSON.stringify(metrics)}`);
  }
  const dateMention = metrics.mentions.find((item) => item.kind === 'date');
  assert(dateMention?.date === seed.dateMentionIso, `inline date mention should keep the stored absolute date: ${JSON.stringify(metrics)}`);
  assert(
    dateMention.text === `@${expectedDateMentionLabel(seed.dateMentionIso)}`,
    `inline date mention should render relative to current local day instead of stale insertion text: ${JSON.stringify({ dateMention, expected: expectedDateMentionLabel(seed.dateMentionIso) })}`,
  );
  assert(
    dateMention.text !== seed.dateMentionStoredText,
    `inline date mention should not reuse stale stored label text: ${JSON.stringify({ dateMention, stored: seed.dateMentionStoredText })}`,
  );
  for (const mention of metrics.mentions) {
    assert(mention.rect.height >= 17 && mention.rect.height <= 26, `inline mention height drifted: ${JSON.stringify(mention)}`);
    assert(mention.rect.right <= metrics.editable.right + 2, `inline mention should stay inside editable text: ${JSON.stringify(mention)}`);
    assert(Number.parseFloat(mention.borderRadius) >= 3, `inline mention should use chip-like rounding: ${JSON.stringify(mention)}`);
    assert(mention.text.length > 0, `inline mention text should stay visible: ${JSON.stringify(mention)}`);
  }
  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `mobile inline mention contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.editable.left >= 20 && metrics.editable.right <= metrics.viewportWidth - 8, `mobile editable should stay inside viewport: ${JSON.stringify(metrics)}`);
  }
}

function expectedDateMentionLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  assert(match, `date mention fixture must use ISO date: ${value}`);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

async function assertMentionPopoverContract(page, label, variant) {
  const metrics = await page.evaluate((label) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (item) => item instanceof HTMLElement && item.getAttribute('aria-label') === label,
    );
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        bottom: r.bottom,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        width: r.width,
      };
    };
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: `missing ${label} dialog` };
    const buttons = Array.from(dialog.querySelectorAll('button')).filter((button) => button instanceof HTMLElement);
    const inputs = Array.from(dialog.querySelectorAll('input')).filter((input) => input instanceof HTMLElement);
    return {
      ok: true,
      bodyScrollWidth: document.body.scrollWidth,
      buttonCount: buttons.length,
      buttons: buttons.map((button) => ({ rect: rect(button), text: button.textContent?.trim() ?? '' })),
      dialog: rect(dialog),
      documentScrollWidth: document.documentElement.scrollWidth,
      inputCount: inputs.length,
      label,
      text: dialog.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  }, label);

  assert(metrics.ok, metrics.reason ?? 'mention popover contract could not run');
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `mention popover should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.dialog.left >= 6, `mention popover should stay inside left viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.dialog.right <= metrics.viewportWidth - 6, `mention popover should stay inside right viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.dialog.top >= 6, `mention popover should stay inside top viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.dialog.bottom <= metrics.viewportHeight - 6, `mention popover should stay inside bottom viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.dialog.width >= 210 && metrics.dialog.width <= 310, `mention popover width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.dialog.height >= 70, `mention popover should have visible content: ${JSON.stringify(metrics)}`);
  if (label === 'Edit date mention') {
    assert(metrics.inputCount === 1, `date mention popover should expose one date input: ${JSON.stringify(metrics)}`);
    assert(metrics.buttonCount >= 35, `date mention popover should expose calendar/actions: ${JSON.stringify(metrics)}`);
  } else {
    assert(metrics.buttonCount >= 1, `${label} should expose at least one action: ${JSON.stringify(metrics)}`);
  }
  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `mobile mention popover contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.dialog.width <= metrics.viewportWidth - 12, `mobile mention popover should fit the viewport: ${JSON.stringify(metrics)}`);
  }
}

async function assertEditorMentionMenuContract(page, seed, variant) {
  const metrics = await page.evaluate(({ targetPageTitle }) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        bottom: r.bottom,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        width: r.width,
      };
    };
    const menu = document.querySelector('[role="listbox"][aria-label="Mention"]');
    if (!(menu instanceof HTMLElement)) return { ok: false, reason: 'missing editor mention menu' };
    const options = Array.from(menu.querySelectorAll('[role="option"]')).filter(
      (option) => option instanceof HTMLElement,
    );
    const style = getComputedStyle(menu);
    return {
      ok: true,
      backgroundColor: style.backgroundColor,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      firstOptionText: options[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      menu: rect(menu),
      optionTexts: options.map((option) => option.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
      targetPageTitle,
      text: menu.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  }, { targetPageTitle: seed.targetPageTitle });

  assert(metrics.ok, metrics.reason ?? 'editor mention menu contract could not run');
  assert(
    Math.max(metrics.bodyScrollWidth, metrics.documentScrollWidth) <= metrics.viewportWidth + 4,
    `editor mention menu should not create page-level horizontal overflow: ${JSON.stringify(metrics)}`,
  );
  assert(metrics.menu.left >= 6, `editor mention menu should stay inside left viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.menu.right <= metrics.viewportWidth - 6, `editor mention menu should stay inside right viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.menu.top >= 6, `editor mention menu should stay inside top viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.menu.bottom <= metrics.viewportHeight - 6, `editor mention menu should stay inside bottom viewport edge: ${JSON.stringify(metrics)}`);
  assert(metrics.menu.width >= 280 && metrics.menu.width <= Math.min(370, metrics.viewportWidth - 12), `editor mention menu width drifted: ${JSON.stringify(metrics)}`);
  assert(metrics.firstOptionText.includes('Today'), `editor mention menu should start with Today: ${JSON.stringify(metrics)}`);
  assert(metrics.text.includes('Date'), `editor mention menu should label the date section first: ${JSON.stringify(metrics)}`);
  assert(metrics.text.includes('Tomorrow') && metrics.text.includes('Yesterday'), `editor mention menu should expose nearby date shortcuts: ${JSON.stringify(metrics)}`);
  assert(metrics.text.includes('People'), `editor mention menu should keep the people section available: ${JSON.stringify(metrics)}`);
  const todayIndex = metrics.text.indexOf('Today');
  const peopleIndex = metrics.text.indexOf('People');
  assert(
    todayIndex >= 0 && peopleIndex > todayIndex,
    `date shortcuts should appear before people suggestions: ${JSON.stringify(metrics)}`,
  );
  assert(!metrics.text.includes('Link to page'), `editor @ menu should not include page-link suggestions: ${JSON.stringify(metrics)}`);
  assert(!metrics.text.includes('New page'), `editor @ menu should not include create-page suggestions: ${JSON.stringify(metrics)}`);
  assert(
    !metrics.text.includes(metrics.targetPageTitle),
    `editor @ menu should keep page suggestions out of the normal @ flow: ${JSON.stringify(metrics)}`,
  );
  assert(!/rgba\([^)]+,\s*0(?:\.0+)?\)/.test(metrics.backgroundColor), `editor mention menu should have an opaque surface: ${JSON.stringify(metrics)}`);
  if (variant.mobile) {
    assert(metrics.viewportWidth <= 430, `mobile editor mention menu contract should run in a narrow viewport: ${JSON.stringify(metrics)}`);
    assert(metrics.menu.width <= metrics.viewportWidth - 12, `mobile editor mention menu should fit the viewport: ${JSON.stringify(metrics)}`);
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

async function seedMentionPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for mentions visual smoke');

  const suffix = Date.now();
  const targetPageId = randomUUID();
  const pageId = randomUUID();
  const blockId = randomUUID();
  const inputBlockId = randomUUID();
  const targetTitle = `Mention target page ${suffix}`;
  const pageTitle = `Inline mentions visual ${suffix}`;

  const target = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: targetPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: targetTitle,
    icon: '📎',
    iconType: 'emoji',
    position: suffix,
  });
  assert(target?.page?.id === targetPageId, 'mention target page must be created');

  const page = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: pageTitle,
    icon: '💬',
    iconType: 'emoji',
    position: suffix + 1,
  });
  assert(page?.page?.id === pageId, 'mention visual page must be created');

  const dateIso = '2026-06-26';
  const dateText = '@Jun 26, 2026';
  const personText = '@You';
  const blocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks: [
      {
        id: blockId,
        pageId,
        parentId: null,
        type: 'paragraph',
        content: {
          rich: [
            { text: 'Inline mentions should stay compact: ' },
            { text: targetTitle, mention: 'page', pageId: targetPageId },
            { text: ' · ' },
            { text: dateText, mention: 'date', date: dateIso },
            { text: ' · ' },
            { text: personText, mention: 'person', userId: session.userId },
            { text: ' with surrounding text for wrapping pressure.' },
          ],
        },
        plainText: `Inline mentions should stay compact: ${targetTitle} · ${dateText} · ${personText} with surrounding text for wrapping pressure.`,
        position: 1,
      },
      {
        id: inputBlockId,
        pageId,
        parentId: null,
        type: 'paragraph',
        content: {
          rich: [],
        },
        plainText: '',
        position: 2,
      },
    ],
  });
  assert(blocks?.blocks?.length === 2, 'mention visual blocks must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    userId: session.userId,
    targetPageId,
    targetPageTitle: targetTitle,
    dateMentionIso: dateIso,
    dateMentionStoredText: dateText,
    pageId,
    pageTitle,
    blockId,
    inputBlockId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  for (const pageId of [seed.pageId, seed.targetPageId]) {
    if (!pageId) continue;
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id: pageId,
    }).catch(() => {});
  }
}

async function seedSession(context, seed, theme = 'light') {
  await context.addInitScript(({ refreshToken, workspaceId, theme }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', theme);
  }, {
    refreshToken: seed.refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
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
    'Playwright is required for mentions visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: null,
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
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a number >= 1000');
      }
      i += 1;
      continue;
    }
    if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(resolveValue(args, i, arg));
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
  console.log(`Usage: node scripts/mentions-visual-smoke.mjs [options]

Seeds a page with page/date/person rich-text mentions, then captures inline
mention rendering and page/date/person popovers across desktop/mobile visual
states. The contract checks chip density, popover containment, calendar/action
visibility, and viewport overflow.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         API/runtime URL for seeding. Defaults to --url.
  --screenshot-dir <path> Screenshot output directory. Defaults to ${DEFAULT_SCREENSHOT_DIR}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
