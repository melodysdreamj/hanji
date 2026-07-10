#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'comments-panel');
const PAGE_TITLE_SELECTOR = '[role="textbox"][aria-label="Page title"], [role="textbox"][aria-label="페이지 제목"]';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL comments panel visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Comments panel visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Comments panel visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedCommentsWorkspace(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureCommentsVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1440, height: 1000 },
    });
    await captureCommentsVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      viewport: { width: 390, height: 844 },
    });
    await captureCommentsVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark',
      submitMentionFlow: true,
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
    });

    console.log('PASS comments panel open/resolved thread visuals stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-open-thread',
      'desktop-resolved-thread',
      'mobile-open-thread',
      'mobile-resolved-thread',
      'desktop-dark-open-thread',
      'desktop-dark-resolved-thread',
      'desktop-dark-mention-submitted',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } finally {
    await cleanupSeed(apiUrl, seed).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureCommentsVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openSeedPage(page, appUrl, seed);
    const dialog = await openBlockComments(page);
    await waitForOpenThread(dialog, seed);
    await hoverFirstThread(dialog, seed.openBlockCommentId);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-open-thread.png`),
      fullPage: false,
    });
    await assertOpenThreadContract(page, dialog, seed, variant);
    await assertComposerMentionFlow(dialog, `${variant.prefix} comments panel mention picker`, seed.expectedMentionLabel, {
      screenshotPath: variant.submitMentionFlow
        ? join(options.screenshotDir, `${variant.prefix}-mention-submitted.png`)
        : null,
      submit: !!variant.submitMentionFlow,
    });

    await dialog.locator('[data-comment-tab="resolved"]').click({ timeout: options.timeoutMs });
    await waitForResolvedThread(dialog, seed);
    await hoverFirstThread(dialog, seed.resolvedBlockCommentId);
    await page.screenshot({
      path: join(options.screenshotDir, `${variant.prefix}-resolved-thread.png`),
      fullPage: false,
    });
    await assertResolvedThreadContract(page, dialog, seed, variant);
    assertNoBrowserErrors(errors, `${variant.prefix} comments panel visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openSeedPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.locator(PAGE_TITLE_SELECTOR).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ expected, selector }) => {
      const title = document.querySelector(selector);
      return title instanceof HTMLElement && title.innerText.trim() === expected;
    },
    { expected: seed.title, selector: PAGE_TITLE_SELECTOR },
    { timeout: options.timeoutMs },
  );
  await page.getByText(seed.blockText, { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openBlockComments(page) {
  const commentButton = page.getByRole('button', { name: /unresolved comments? on .* block/i }).first();
  await commentButton.click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Comments' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function waitForOpenThread(dialog, seed) {
  await dialog.locator('[data-comment-tab="open"][aria-selected="true"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  for (const text of [seed.openBlockCommentText, seed.pageCommentText, seed.replyText]) {
    await dialog.getByText(text, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
  await dialog.getByText(seed.blockText, { exact: false }).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function waitForResolvedThread(dialog, seed) {
  await dialog.locator('[data-comment-tab="resolved"][aria-selected="true"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText(seed.resolvedBlockCommentText, { exact: false }).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('button', { name: 'Reopen' }).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function hoverFirstThread(dialog, commentId) {
  await dialog.locator(commentSelector(commentId)).hover({ timeout: options.timeoutMs }).catch(() => {});
}

async function assertOpenThreadContract(page, dialog, seed, variant) {
  const metrics = await commentsMetrics(dialog, [
    seed.openBlockCommentText,
    seed.pageCommentText,
    seed.replyText,
    seed.blockText,
  ]);
  assertPanelGeometry(metrics, variant, 'Comments open panel');
  assert(metrics.selectedTab === 'open', `Comments open panel should keep Open selected, got ${metrics.selectedTab}`);
  assert(metrics.tabCount === 2, `Comments open panel should expose Open/Resolved tabs, got ${metrics.tabCount}`);
  assert(metrics.openCount === 2, `Comments open panel should show two open top-level threads, got ${metrics.openCount}`);
  assert(metrics.resolvedCount === 0, `Comments open panel should not show resolved threads in Open view, got ${metrics.resolvedCount}`);
  assert(metrics.replyCount >= 1, `Comments open panel should show the seeded reply, got ${metrics.replyCount}`);
  assert(metrics.replyListCount >= 1, `Comments open panel should keep replies nested under the parent thread, got ${metrics.replyListCount}`);
  assert(metrics.actionButtonCount >= 5, `Comments open panel should keep reply/show/resolve actions reachable, got ${metrics.actionButtonCount}`);
  assert(metrics.mentionTriggerCount >= 1, `Comments open panel should expose an @ mention trigger in the composer, got ${metrics.mentionTriggerCount}`);
  assertTargetCommentChrome(metrics, 'Comments open panel');
  assert(!metrics.composerFocused, `Comments open panel should not auto-focus the composer when viewing an existing thread: ${JSON.stringify(metrics)}`);
  assert(metrics.composerHeight >= 68 && metrics.composerHeight <= 124, `Comments open composer should stay compact, got ${Math.round(metrics.composerHeight)}px`);
  assert(metrics.commentMinHeight >= 56, `Comments open rows should not collapse, got min ${Math.round(metrics.commentMinHeight)}px`);
  assert(metrics.commentMaxHeight <= (variant.mobile ? 330 : 310), `Comments open rows should stay dense, got max ${Math.round(metrics.commentMaxHeight)}px`);
  assert(metrics.avatarMin >= 26 && metrics.avatarMax <= 30, `Comments open avatars should stay 28px-class, got ${Math.round(metrics.avatarMin)}-${Math.round(metrics.avatarMax)}px`);
  assert(metrics.replyAvatarMin >= 22 && metrics.replyAvatarMax <= 26, `Comments reply avatars should stay 24px-class, got ${Math.round(metrics.replyAvatarMin)}-${Math.round(metrics.replyAvatarMax)}px`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `Comments open panel hides expected text: ${metrics.missingVisibleExpectedTexts.join(', ')}`);
  assertNoHorizontalCommentOverflow(metrics, 'Comments open panel');
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} comments open panel`);
}

async function assertResolvedThreadContract(page, dialog, seed, variant) {
  const metrics = await commentsMetrics(dialog, [seed.resolvedBlockCommentText]);
  assertPanelGeometry(metrics, variant, 'Comments resolved panel');
  assert(metrics.selectedTab === 'resolved', `Comments resolved panel should keep Resolved selected, got ${metrics.selectedTab}`);
  assert(metrics.tabCount === 2, `Comments resolved panel should expose Open/Resolved tabs, got ${metrics.tabCount}`);
  assert(metrics.openCount === 0, `Comments resolved panel should only show resolved threads, got ${metrics.openCount} open`);
  assert(metrics.resolvedCount === 1, `Comments resolved panel should show one resolved top-level thread, got ${metrics.resolvedCount}`);
  assert(metrics.reopenButtonCount >= 1, `Comments resolved panel should expose a Reopen action, got ${metrics.reopenButtonCount}`);
  assert(metrics.mentionTriggerCount >= 1, `Comments resolved panel should expose an @ mention trigger in the composer, got ${metrics.mentionTriggerCount}`);
  assertTargetCommentChrome(metrics, 'Comments resolved panel');
  assert(!metrics.composerFocused, `Comments resolved panel should not auto-focus the composer while reading resolved threads: ${JSON.stringify(metrics)}`);
  assert(metrics.commentMaxHeight <= (variant.mobile ? 220 : 200), `Comments resolved rows should stay dense, got max ${Math.round(metrics.commentMaxHeight)}px`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `Comments resolved panel hides expected text: ${metrics.missingVisibleExpectedTexts.join(', ')}`);
  assertNoHorizontalCommentOverflow(metrics, 'Comments resolved panel');
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} comments resolved panel`);
}

async function commentsMetrics(dialog, expectedVisibleTexts) {
  return dialog.evaluate((el, expectedVisibleTexts) => {
    if (!(el instanceof HTMLElement)) return { ok: false, reason: 'missing comments panel' };
    const rect = el.getBoundingClientRect();
    const panelStyle = window.getComputedStyle(el);
    const tabs = Array.from(el.querySelectorAll('[role="tab"]')).filter(isVisibleElement);
    const selectedTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    const composer = el.querySelector('textarea');
    const list = el.querySelector('[role="list"][aria-label="Comment threads"]');
    const topLevelComments = Array.from(el.querySelectorAll('[data-comment-id]')).filter(isVisibleElement);
    const articleItems = Array.from(el.querySelectorAll('article[role="listitem"]')).filter(isVisibleElement);
    const replyItems = articleItems.filter((item) => /reply,/i.test(item.getAttribute('aria-label') ?? ''));
    const replyLists = Array.from(el.querySelectorAll('[role="list"][aria-label$=" replies"]')).filter(isVisibleElement);
    const avatars = topLevelComments
      .map((comment) => comment.firstElementChild)
      .filter((item) => item instanceof HTMLElement && isVisibleElement(item));
    const replyAvatars = replyItems
      .map((reply) => reply.firstElementChild)
      .filter((item) => item instanceof HTMLElement && isVisibleElement(item));
    const commentRects = topLevelComments.map((comment) => comment.getBoundingClientRect());
    const targetComments = topLevelComments.filter((comment) => comment.getAttribute('data-target') === 'true');
    const targetBlueFillIssues = targetComments
      .filter((comment) => isBlueTintedFill(window.getComputedStyle(comment).backgroundColor))
      .map((comment) => comment.textContent?.trim().slice(0, 100) ?? '');
    const targetMarkers = targetComments
      .map((comment) => Number.parseFloat(window.getComputedStyle(comment, '::before').width))
      .filter((width) => Number.isFinite(width) && width > 0);
    const actionButtons = Array.from(el.querySelectorAll('button')).filter((button) => {
      if (!(button instanceof HTMLElement) || !isVisibleElement(button)) return false;
      return ['Reply', 'Show in page', 'Resolve', 'Reopen'].includes(button.textContent?.trim() ?? '');
    });
    const mentionTriggers = Array.from(el.querySelectorAll('button[aria-label="Mention people"]')).filter(isVisibleElement);
    const reopenButtonCount = actionButtons.filter((button) => button.textContent?.trim() === 'Reopen').length;
    const textBlocks = Array.from(el.querySelectorAll('[class*="commentText"], [class*="commentQuote"], [class*="commentMeta"], [class*="anchorLabel"]'))
      .filter(isVisibleElement);
    const overflowingTextBlocks = textBlocks
      .filter((item) => item.scrollWidth > item.clientWidth + 2)
      .map((item) => item.textContent?.trim().slice(0, 100) ?? '');
    const controlOverflow = Array.from(el.querySelectorAll('button, textarea, input, [role="tab"]'))
      .filter((item) => item instanceof HTMLElement && isVisibleElement(item) && item.scrollWidth > item.clientWidth + 2)
      .map((item) => item.textContent?.trim().slice(0, 100) || item.getAttribute('aria-label') || item.tagName);
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter((text) => !hasVisibleText(el, text));
    const tabText = selectedTab?.textContent?.toLowerCase() ?? '';
    return {
      ok: true,
      actionButtonCount: actionButtons.length,
      avatarMax: maxRectSize(avatars, 'width'),
      avatarMin: minRectSize(avatars, 'width'),
      bottomGap: window.innerHeight - rect.bottom,
      commentCount: topLevelComments.length,
      commentMaxHeight: Math.max(...commentRects.map((item) => item.height), 0),
      commentMinHeight: Math.min(...commentRects.map((item) => item.height), 999),
      composerFocused: document.activeElement === composer,
      composerHeight: composer instanceof HTMLElement ? composer.getBoundingClientRect().height : 0,
      controlOverflow,
      height: rect.height,
      left: rect.left,
      listClientWidth: list instanceof HTMLElement ? list.clientWidth : 0,
      listScrollWidth: list instanceof HTMLElement ? list.scrollWidth : 0,
      missingVisibleExpectedTexts,
      mentionTriggerCount: mentionTriggers.length,
      openCount: topLevelComments.filter((item) => item.getAttribute('data-resolved') !== 'true').length,
      panelBorderTopWidth: Number.parseFloat(panelStyle.borderTopWidth),
      panelClientWidth: el.clientWidth,
      panelScrollWidth: el.scrollWidth,
      reopenButtonCount,
      replyAvatarMax: maxRectSize(replyAvatars, 'width'),
      replyAvatarMin: minRectSize(replyAvatars, 'width'),
      replyCount: replyItems.length,
      replyListCount: replyLists.length,
      resolvedCount: topLevelComments.filter((item) => item.getAttribute('data-resolved') === 'true').length,
      rightGap: window.innerWidth - rect.right,
      selectedTab: tabText.includes('resolved') ? 'resolved' : tabText.includes('open') ? 'open' : '',
      tabCount: tabs.length,
      targetBlueFillCount: targetBlueFillIssues.length,
      targetBlueFillIssues,
      targetMarkerCount: targetMarkers.length,
      targetMarkerMax: Math.max(...targetMarkers, 0),
      targetMarkerMin: Math.min(...targetMarkers, 999),
      textOverflowCount: overflowingTextBlocks.length,
      overflowingTextBlocks,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };

    function isVisibleElement(item) {
      if (!(item instanceof HTMLElement)) return false;
      const itemRect = item.getBoundingClientRect();
      const style = window.getComputedStyle(item);
      return itemRect.width > 0 && itemRect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    function hasVisibleText(root, text) {
      const needle = String(text);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.includes(needle)) continue;
        const parent = node.parentElement;
        if (parent && isVisibleElement(parent)) return true;
      }
      return false;
    }

    function maxRectSize(items, key) {
      return Math.max(...items.map((item) => item.getBoundingClientRect()[key]), 0);
    }

    function minRectSize(items, key) {
      return Math.min(...items.map((item) => item.getBoundingClientRect()[key]), 999);
    }

    function isBlueTintedFill(color) {
      const match = String(color).match(/rgba?\(([^)]+)\)/);
      if (!match) return false;
      const [red = 0, green = 0, blue = 0, alpha = 1] = match[1]
        .split(',')
        .map((part) => Number.parseFloat(part.trim()));
      if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return false;
      const opacity = Number.isFinite(alpha) ? alpha : 1;
      return opacity > 0.03 && blue > red + 32 && blue > green + 32;
    }
  }, expectedVisibleTexts);
}

async function assertComposerMentionFlow(dialog, label, expectedMentionLabel, flowOptions = {}) {
  const trigger = dialog.getByRole('button', { name: 'Mention people' }).first();
  await trigger.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await trigger.click({ timeout: options.timeoutMs });

  const menu = dialog.getByRole('listbox', { name: 'Comment mention people' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const metrics = await menu.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const panel = el.closest('[data-comments-panel]');
    const panelRect = panel instanceof HTMLElement ? panel.getBoundingClientRect() : null;
    const options = Array.from(el.querySelectorAll('[role="option"]')).filter(isVisibleElement);
    const optionTexts = options.map((option) => option.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const hasEmptyState = Array.from(el.querySelectorAll('*')).some((item) => {
      if (!(item instanceof HTMLElement) || !isVisibleElement(item)) return false;
      return item.textContent?.includes('No matching people') ?? false;
    });
    return {
      bottom: rect.bottom,
      hasEmptyState,
      left: rect.left,
      optionCount: options.length,
      optionTexts,
      panelLeft: panelRect?.left ?? 0,
      panelRight: panelRect?.right ?? window.innerWidth,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
    };

    function isVisibleElement(item) {
      if (!(item instanceof HTMLElement)) return false;
      const itemRect = item.getBoundingClientRect();
      const style = window.getComputedStyle(item);
      return itemRect.width > 0 && itemRect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }
  });

  assert(metrics.optionCount > 0, `${label} should show at least the current user instead of an empty people state`);
  assert(!metrics.hasEmptyState, `${label} should not show "No matching people" when the current user is signed in`);
  assert(
    metrics.optionTexts.some((text) => text.includes(expectedMentionLabel) || text.includes('You')),
    `${label} should include the current user in @ suggestions, got: ${metrics.optionTexts.join(' | ')}`
  );
  assert(metrics.left >= metrics.panelLeft - 2, `${label} menu should stay inside the comments panel left edge`);
  assert(metrics.right <= metrics.panelRight + 2, `${label} menu should stay inside the comments panel right edge`);
  assert(metrics.bottom <= metrics.viewportHeight + 2, `${label} menu should stay inside the viewport`);

  const composer = dialog
    .locator('textarea[aria-label="Add a page comment"], textarea[aria-label="Add a block comment"]')
    .first();
  await composer.waitFor({ state: 'visible', timeout: options.timeoutMs });

  if (!flowOptions.submit) {
    await composer.press('Escape', { timeout: options.timeoutMs }).catch(() => {});
    await composer.fill('', { timeout: options.timeoutMs });
    await menu.waitFor({ state: 'hidden', timeout: options.timeoutMs }).catch(() => {});
    return;
  }

  await menu.getByRole('option').first().click({ timeout: options.timeoutMs });
  await menu.waitFor({ state: 'hidden', timeout: options.timeoutMs });

  const pickedMentionText = (await composer.inputValue()).trim();
  assert(
    pickedMentionText.startsWith('@') && pickedMentionText.length > 1,
    `${label} option click should insert a visible @person mention into the composer, got ${JSON.stringify(pickedMentionText)}`
  );
  assert(
    !pickedMentionText.includes('\n'),
    `${label} option click should replace the active @ cue, not stack people on separate lines: ${JSON.stringify(pickedMentionText)}`
  );
  await composer.fill(`${pickedMentionText} mention selection smoke`, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Comment', exact: true }).click({ timeout: options.timeoutMs });

  const mention = dialog.locator('[data-comment-mention-user-id]').filter({ hasText: pickedMentionText }).first();
  await mention.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const mentionMetrics = await mention.evaluate((el) => {
    if (!(el instanceof HTMLElement)) return { ok: false, reason: 'missing rendered comment mention' };
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      height: rect.height,
      ok: true,
      text: el.textContent?.trim() ?? '',
      userId: el.dataset.commentMentionUserId ?? '',
      width: rect.width,
    };
  });
  assert(mentionMetrics.ok, `${label} should render the submitted person mention`);
  assert(mentionMetrics.userId, `${label} rendered mention should retain its person user id`);
  assert(
    mentionMetrics.text === pickedMentionText,
    `${label} rendered mention should keep the picked label, got ${JSON.stringify(mentionMetrics.text)}`
  );
  assert(
    mentionMetrics.width > 12 && mentionMetrics.height >= 14,
    `${label} rendered mention should have a visible chip-sized box, got ${Math.round(mentionMetrics.width)}x${Math.round(mentionMetrics.height)}`
  );
  if (flowOptions.screenshotPath) {
    await dialog.screenshot({ path: flowOptions.screenshotPath });
  }
}

function assertTargetCommentChrome(metrics, label) {
  assert(metrics.targetBlueFillCount === 0, `${label} should mark the active block with a quiet rail instead of a blue full-card fill: ${metrics.targetBlueFillIssues.join(' | ')}`);
  assert(metrics.targetMarkerCount >= 1, `${label} should expose a subtle target rail for block-scoped threads`);
  assert(metrics.targetMarkerMin >= 1 && metrics.targetMarkerMax <= 4, `${label} target rail should stay subtle, got ${Math.round(metrics.targetMarkerMin)}-${Math.round(metrics.targetMarkerMax)}px`);
}

function assertPanelGeometry(metrics, variant, label) {
  assert(metrics.ok !== false, `${label} is missing: ${metrics.reason ?? 'unknown reason'}`);
  if (variant.mobile) {
    assert(metrics.width >= metrics.viewportWidth - 2 && metrics.width <= metrics.viewportWidth + 2, `${label} should fill mobile width, got ${Math.round(metrics.width)}px in ${Math.round(metrics.viewportWidth)}px`);
    assert(Math.abs(metrics.left) <= 2, `${label} should start at the mobile left edge, got left=${Math.round(metrics.left)}px`);
    assert(metrics.top >= 40 && metrics.top <= 56, `${label} should start below the top bar on mobile, got top=${Math.round(metrics.top)}px`);
    assert(metrics.panelBorderTopWidth >= 1, `${label} should draw its own top hairline under the top bar, got ${metrics.panelBorderTopWidth}px`);
    assert(metrics.rightGap >= -2 && metrics.rightGap <= 2, `${label} should end at the mobile right edge, got gap=${Math.round(metrics.rightGap)}px`);
    assert(metrics.bottomGap >= -2 && metrics.bottomGap <= 2, `${label} should fill to the mobile bottom edge, got gap=${Math.round(metrics.bottomGap)}px`);
    assert(metrics.height >= metrics.viewportHeight - 60, `${label} should use mobile viewport height, got ${Math.round(metrics.height)}px`);
    return;
  }
  assert(metrics.width >= 360 && metrics.width <= 410, `${label} should keep side-panel width, got ${Math.round(metrics.width)}px`);
  assert(metrics.top >= 40 && metrics.top <= 60, `${label} should start below the top bar, got top=${Math.round(metrics.top)}px`);
  assert(metrics.panelBorderTopWidth >= 1, `${label} should draw its own top hairline under the top bar, got ${metrics.panelBorderTopWidth}px`);
  assert(metrics.rightGap >= 0 && metrics.rightGap <= 2, `${label} should dock to the right edge, got gap=${Math.round(metrics.rightGap)}px`);
  assert(metrics.bottomGap >= 0 && metrics.bottomGap <= 2, `${label} should fill to the bottom edge, got gap=${Math.round(metrics.bottomGap)}px`);
  assert(metrics.height >= 900, `${label} should use full side-panel height, got ${Math.round(metrics.height)}px`);
}

function assertNoHorizontalCommentOverflow(metrics, label) {
  assert(metrics.panelScrollWidth <= metrics.panelClientWidth + 2, `${label} should not horizontally scroll the panel, got ${metrics.panelScrollWidth}/${metrics.panelClientWidth}`);
  assert(metrics.listScrollWidth <= metrics.listClientWidth + 2, `${label} should not horizontally scroll the thread list, got ${metrics.listScrollWidth}/${metrics.listClientWidth}`);
  assert(metrics.textOverflowCount === 0, `${label} should wrap comment text/quotes/meta without horizontal overflow: ${metrics.overflowingTextBlocks.join(' | ')}`);
  assert(metrics.controlOverflow.length === 0, `${label} controls should not clip horizontally: ${metrics.controlOverflow.join(' | ')}`);
}

async function assertNoPageHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  const maxWidth = Math.max(metrics.bodyWidth, metrics.documentWidth);
  assert(
    maxWidth <= metrics.viewportWidth + 4,
    `${label} should not create page-level horizontal overflow, got ${Math.round(maxWidth)}px in ${Math.round(metrics.viewportWidth)}px viewport`,
  );
}

async function seedCommentsWorkspace(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for comments panel visual smoke');
  const expectedMentionLabel =
    bootstrap?.currentMember?.displayName?.trim() ||
    bootstrap?.currentMember?.email?.trim() ||
    bootstrap?.currentOrganizationMember?.displayName?.trim() ||
    bootstrap?.currentOrganizationMember?.email?.trim() ||
    'You';

  const suffix = Date.now();
  const shortSuffix = String(suffix).slice(-6);
  const pageId = randomUUID();
  const blockId = randomUUID();
  const openBlockCommentId = randomUUID();
  const pageCommentId = randomUUID();
  const resolvedBlockCommentId = randomUUID();
  const replyId = randomUUID();
  const title = `Comment visual ${shortSuffix}`;
  const blockText = `Comment panel visual anchor ${shortSuffix}`;
  const openBlockCommentText = `Open block comment ${shortSuffix}: please keep this anchored thread readable, compact, and wrapped inside the side panel.`;
  const replyText = `Thread reply ${shortSuffix}: nested replies should align under the parent without creating a second visual column.`;
  const pageCommentText = `Page comment ${shortSuffix}: page-level discussions should share the same panel density as block threads.`;
  const resolvedBlockCommentText = `Resolved block comment ${shortSuffix}: resolved threads should feel muted but still readable.`;

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    icon: '💬',
    iconType: 'emoji',
    cover: '',
    coverPosition: 50,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'comments panel visual smoke page must be created');

  const block = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: blockText }] },
    plainText: blockText,
    position: 1,
  });
  assert(block?.block?.id === blockId, 'comments panel visual smoke block must be created');

  const openComment = await callFunction(baseUrl, session.accessToken, 'comment-mutation', {
    action: 'create',
    id: openBlockCommentId,
    pageId,
    blockId,
    parentId: null,
    body: {
      rich: [{ text: openBlockCommentText }],
      quote: blockText,
      quoteStart: 0,
      quoteEnd: blockText.length,
    },
    resolved: false,
  });
  assert(openComment?.comment?.id === openBlockCommentId, 'comments panel open block comment must be created');

  const reply = await callFunction(baseUrl, session.accessToken, 'comment-mutation', {
    action: 'create',
    id: replyId,
    pageId,
    blockId,
    parentId: openBlockCommentId,
    body: { rich: [{ text: replyText }] },
    resolved: false,
  });
  assert(reply?.comment?.id === replyId, 'comments panel reply must be created');

  const pageComment = await callFunction(baseUrl, session.accessToken, 'comment-mutation', {
    action: 'create',
    id: pageCommentId,
    pageId,
    blockId: null,
    parentId: null,
    body: { rich: [{ text: pageCommentText }] },
    resolved: false,
  });
  assert(pageComment?.comment?.id === pageCommentId, 'comments panel page comment must be created');

  const resolvedComment = await callFunction(baseUrl, session.accessToken, 'comment-mutation', {
    action: 'create',
    id: resolvedBlockCommentId,
    pageId,
    blockId,
    parentId: null,
    body: {
      rich: [{ text: resolvedBlockCommentText }],
      quote: blockText,
      quoteStart: 0,
      quoteEnd: blockText.length,
    },
    resolved: true,
  });
  assert(resolvedComment?.comment?.id === resolvedBlockCommentId, 'comments panel resolved comment must be created');

  return {
    accessToken: session.accessToken,
    blockId,
    blockText,
    expectedMentionLabel,
    openBlockCommentId,
    openBlockCommentText,
    pageCommentId,
    pageCommentText,
    pageId,
    refreshToken: session.refreshToken,
    replyId,
    replyText,
    resolvedBlockCommentId,
    resolvedBlockCommentText,
    title,
    workspaceId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.pageId,
  }).catch(() => {});
}

async function seedSession(context, seed, theme) {
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
    if (message.type() !== 'error') return;
    const location = message.location();
    const source = location.url ? ` (${location.url}:${location.lineNumber})` : '';
    errors.push(`${message.text()}${source}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (!failure.includes('CONNECTION_REFUSED')) return;
    errors.push(`${failure} ${request.method()} ${request.url()}`);
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
    'Playwright is required for comments panel visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
  console.log(`Usage: node scripts/comments-panel-visual-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --api-url <url>         EdgeBase API URL when the app URL differs
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}

function commentSelector(commentId) {
  return `[data-comment-id="${commentId.replace(/"/g, '\\"')}"]`;
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
