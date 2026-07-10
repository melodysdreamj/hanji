#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'share-dialog');

const options = parseArgs(process.argv.slice(2));
const SHARE_LABELS = {
  anyoneWithLink: ['Anyone with the link', '링크가 있는 모든 사용자'],
  canComment: ['Can comment', '댓글 가능'],
  canEdit: ['Can edit', '편집 가능'],
  canView: ['Can view', '보기 가능'],
  copyPageLink: ['Copy page link', '페이지 링크 복사'],
  copyWebLink: ['Copy web link', '웹 링크 복사'],
  fullAccess: ['Full access', '전체 권한'],
  guest: ['Guest', '게스트'],
  invitePeople: ['Invite people', '사용자 초대'],
  linkExpires: ['Link expires', '링크 만료'],
  newInvitePermission: ['New invite permission', '새 초대 권한'],
  on: ['On', '켬'],
  publish: ['Publish', '게시'],
  publicLinkExpiration: ['Public link expiration', '공개 링크 만료'],
  removeAccess: ['Remove', '권한 제거'],
  share: ['Share', '공유'],
  shareToWeb: ['Share to web', '웹에 공유'],
  whoHasAccess: ['Who has access', '접근 권한'],
  you: ['You', '나'],
};
const SHARE_PERMISSION_LABELS = [
  SHARE_LABELS.fullAccess,
  SHARE_LABELS.canEdit,
  SHARE_LABELS.canComment,
  SHARE_LABELS.canView,
];

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL share dialog visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Share dialog visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Share dialog visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedSharePage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await captureShareVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1440, height: 1000 },
      captures: ['main', 'publish', 'existing-permission', 'new-invite-permission'],
    });
    await captureShareVariant(browser, appUrl, seed, {
      mobile: true,
      prefix: 'mobile',
      viewport: { width: 390, height: 844 },
      captures: ['main', 'publish', 'existing-permission'],
    });

    console.log('PASS share dialog access states are captured and stay within the Notion-style layout contract.');
    for (const name of [
      'desktop-main',
      'desktop-publish',
      'desktop-existing-permission',
      'desktop-new-invite-permission',
      'mobile-main',
      'mobile-publish',
      'mobile-existing-permission',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
    console.log(`Surface inventories: ${options.screenshotDir}`);
  } finally {
    await cleanupSeed(apiUrl, seed).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function captureShareVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed);

  try {
    await openSeedPage(page, appUrl, seed);
    let dialog = await openShareDialog(page, seed);
    await waitForMainShareState(dialog, seed);
    if (variant.captures.includes('main')) {
      await writeShareSurfaceInventory(page, dialog, seed, variant, {
        fileName: `${variant.prefix}-main-inventory.json`,
        state: 'main',
      });
      await page.screenshot({
        path: join(options.screenshotDir, `${variant.prefix}-main.png`),
        fullPage: false,
      });
      await assertShareMainContract(page, dialog, seed, variant);
    }

    if (variant.captures.includes('publish')) {
      await openShareTab(dialog, 'publish');
      await waitForPublishShareState(dialog);
      await writeShareSurfaceInventory(page, dialog, seed, variant, {
        fileName: `${variant.prefix}-publish-inventory.json`,
        state: 'publish',
      });
      await page.screenshot({
        path: join(options.screenshotDir, `${variant.prefix}-publish.png`),
        fullPage: false,
      });
      await assertSharePublishContract(page, dialog, seed, variant);
      await openShareTab(dialog, 'share');
      await waitForMainShareState(dialog, seed);
    }

    if (variant.captures.includes('existing-permission')) {
      await openExistingPermissionMenu(dialog, seed);
      await writeShareSurfaceInventory(page, dialog, seed, variant, {
        fileName: `${variant.prefix}-existing-permission-inventory.json`,
        state: 'existing-permission',
      });
      await page.screenshot({
        path: join(options.screenshotDir, `${variant.prefix}-existing-permission.png`),
        fullPage: false,
      });
      await assertSharePermissionMenuContract(page, dialog, seed, variant, 'existing permission menu');
      await page.keyboard.press('Escape');
      dialog = page.getByRole('dialog', { name: shareDialogNameMatcher(seed.title) });
      await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
    }

    if (variant.captures.includes('new-invite-permission')) {
      await openNewInvitePermissionMenu(dialog, seed);
      await writeShareSurfaceInventory(page, dialog, seed, variant, {
        fileName: `${variant.prefix}-new-invite-permission-inventory.json`,
        state: 'new-invite-permission',
      });
      await page.screenshot({
        path: join(options.screenshotDir, `${variant.prefix}-new-invite-permission.png`),
        fullPage: false,
      });
      await assertSharePermissionMenuContract(page, dialog, seed, variant, 'new invite permission menu');
    }
    assertNoBrowserErrors(errors, `${variant.prefix} share dialog visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function openSeedPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('textbox', { name: 'Page title' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    (expected) => {
      const title = document.querySelector('[role="textbox"][aria-label="Page title"]');
      return title instanceof HTMLElement && title.innerText.trim() === expected;
    },
    seed.title,
    { timeout: options.timeoutMs },
  );
}

async function openShareDialog(page, seed) {
  await page.getByRole('button', { name: sharePageNameMatcher(seed.title) }).click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: shareDialogNameMatcher(seed.title) });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  return dialog;
}

async function waitForMainShareState(dialog, seed) {
  for (const text of [
    SHARE_LABELS.share,
    SHARE_LABELS.publish,
    SHARE_LABELS.whoHasAccess,
    SHARE_LABELS.you,
    SHARE_LABELS.fullAccess,
    seed.inviteeEmail,
    SHARE_LABELS.guest,
    SHARE_LABELS.canComment,
    SHARE_LABELS.copyPageLink,
  ]) {
    await dialog.getByText(textMatcher(text), { exact: false }).first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
}

async function waitForPublishShareState(dialog) {
  for (const text of [
    SHARE_LABELS.shareToWeb,
    SHARE_LABELS.on,
    SHARE_LABELS.linkExpires,
    SHARE_LABELS.anyoneWithLink,
    SHARE_LABELS.canView,
    SHARE_LABELS.copyWebLink,
    SHARE_LABELS.copyPageLink,
  ]) {
    await dialog.getByText(textMatcher(text), { exact: false }).first().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
}

async function openShareTab(dialog, tab) {
  const labels = tab === 'publish' ? SHARE_LABELS.publish : SHARE_LABELS.share;
  await dialog.getByRole('tab', { name: labelMatcher(labels) }).click({ timeout: options.timeoutMs });
}

async function openExistingPermissionMenu(dialog, seed) {
  const row = dialog.locator('[class*="shareRow"]').filter({ hasText: seed.inviteeEmail }).first();
  await row.getByRole('button', { name: textMatcher(SHARE_PERMISSION_LABELS.flat()) }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('menu').filter({ hasText: textMatcher(SHARE_LABELS.removeAccess) }).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openNewInvitePermissionMenu(dialog, seed) {
  const input = dialog.getByRole('textbox', { name: labelMatcher(SHARE_LABELS.invitePeople) });
  await input.fill(seed.newInviteEmail, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: labelMatcher(SHARE_LABELS.newInvitePermission) }).click({ timeout: options.timeoutMs });
  await dialog.getByRole('menu').filter({ hasText: textMatcher(SHARE_LABELS.canEdit) }).first().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertShareMainContract(page, dialog, seed, variant) {
  const metrics = await shareMetrics(dialog, [
    SHARE_LABELS.whoHasAccess,
    seed.inviteeEmail,
    SHARE_LABELS.canComment,
    SHARE_LABELS.copyPageLink,
  ]);
  assertShareGeometry(metrics, variant, 'Share dialog');
  assert(matchesAnyText(metrics.titleText, SHARE_LABELS.share), `Share dialog should keep concise title, got ${metrics.titleText}`);
  assert(metrics.inviteInputCount === 1, `Share dialog should expose one invite input, got ${metrics.inviteInputCount}`);
  assert(metrics.inviteInputHeight >= 28 && metrics.inviteInputHeight <= 38, `Share invite input should stay compact, got ${Math.round(metrics.inviteInputHeight)}px`);
  assert(metrics.placeholderFits, 'Share invite placeholder should fit without clipping.');
  assert(metrics.accessRows >= 3, `Share dialog should show owner, existing invite, and access summary rows, got ${metrics.accessRows}`);
  assert(metrics.copyLinkCount >= 1, `Share dialog should show page copy link, got ${metrics.copyLinkCount}`);
  assert(metrics.permissionButtonCount >= 2, `Share dialog should expose new and existing permission buttons, got ${metrics.permissionButtonCount}`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `Share dialog hides expected text: ${metrics.missingVisibleExpectedTexts.join(', ')}`);
  assertNoShareOverflow(metrics, 'Share dialog');
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} Share dialog`);
}

async function assertSharePublishContract(page, dialog, seed, variant) {
  const metrics = await shareMetrics(dialog, [
    SHARE_LABELS.shareToWeb,
    SHARE_LABELS.linkExpires,
    SHARE_LABELS.anyoneWithLink,
    SHARE_LABELS.canView,
    SHARE_LABELS.copyWebLink,
    SHARE_LABELS.copyPageLink,
  ]);
  assertShareGeometry(metrics, variant, 'Share publish tab');
  assert(matchesAnyText(metrics.titleText, SHARE_LABELS.publish), `Share publish tab should show publish title, got ${metrics.titleText}`);
  assert(metrics.webSwitchCount === 1, `Share publish tab should show one Share to web switch, got ${metrics.webSwitchCount}`);
  assert(metrics.expirySelectCount === 1, `Share publish tab should show public-link expiration controls, got ${metrics.expirySelectCount}`);
  assert(metrics.accessRows >= 2, `Share publish tab should show public access and copy rows, got ${metrics.accessRows}`);
  assert(metrics.copyLinkCount >= 2, `Share publish tab should show web/page copy links, got ${metrics.copyLinkCount}`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `Share publish tab hides expected text: ${metrics.missingVisibleExpectedTexts.join(', ')}`);
  assertNoShareOverflow(metrics, 'Share publish tab');
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} Share publish tab`);
}

async function assertSharePermissionMenuContract(page, dialog, seed, variant, label) {
  const metrics = await shareMetrics(dialog, SHARE_PERMISSION_LABELS);
  assertShareGeometry(metrics, variant, `Share ${label}`);
  assert(metrics.permissionMenuCount === 1, `Share ${label} should show one permission menu, got ${metrics.permissionMenuCount}`);
  assert(metrics.permissionMenuItemCount >= (label.includes('existing') ? 5 : 4), `Share ${label} should show permission options${label.includes('existing') ? ' and Remove' : ''}, got ${metrics.permissionMenuItemCount}`);
  assert(metrics.permissionMenuMinItemHeight >= 24 && metrics.permissionMenuMaxItemHeight <= 34, `Share ${label} rows should stay compact, got ${Math.round(metrics.permissionMenuMinItemHeight)}-${Math.round(metrics.permissionMenuMaxItemHeight)}px`);
  assert(metrics.permissionMenuTriggerHorizontalGap <= 8, `Share ${label} permission menu should stay attached to its trigger, got horizontal gap ${Math.round(metrics.permissionMenuTriggerHorizontalGap)}px`);
  assert(metrics.permissionMenuTriggerVerticalGap >= 2 && metrics.permissionMenuTriggerVerticalGap <= 12, `Share ${label} permission menu should open directly below its trigger, got vertical gap ${Math.round(metrics.permissionMenuTriggerVerticalGap)}px`);
  assert(metrics.permissionMenuRightGap >= 6 || variant.mobile, `Share ${label} should stay inside viewport, got right gap ${Math.round(metrics.permissionMenuRightGap)}px`);
  assert(metrics.permissionMenuBottom <= metrics.viewportHeight - 8, `Share ${label} should stay inside viewport bottom, got bottom=${Math.round(metrics.permissionMenuBottom)}px`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `Share ${label} hides expected permission text: ${metrics.missingVisibleExpectedTexts.join(', ')}`);
  assertNoShareOverflow(metrics, `Share ${label}`);
  await assertNoPageHorizontalOverflow(page, `${variant.prefix} Share ${label}`);
}

async function writeShareSurfaceInventory(page, dialog, seed, variant, opts) {
  const inventory = await collectShareSurfaceInventory(page, dialog, seed, variant, opts);
  assertShareSurfaceInventory(inventory);
  writeFileSync(join(options.screenshotDir, opts.fileName), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return inventory;
}

async function collectShareSurfaceInventory(page, dialog, seed, variant, opts) {
  const local = await dialog.evaluate((el, expected) => {
    if (!(el instanceof HTMLElement)) return { ok: false, reason: 'missing Share dialog' };
    const round = (value) => Math.round(value * 100) / 100;
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.2 &&
        rect.width > 0 &&
        rect.height > 0;
    };
    const rect = (element) => {
      if (!isVisible(element)) return null;
      const r = element.getBoundingClientRect();
      return {
        bottom: round(r.bottom),
        height: round(r.height),
        left: round(r.left),
        right: round(r.right),
        top: round(r.top),
        width: round(r.width),
      };
    };
    const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const labelFor = (element) =>
      element?.getAttribute?.('aria-label') ||
      element?.getAttribute?.('title') ||
      text(element);
    const visibleElements = (items) => Array.from(items).filter(isVisible);
    const visibleControls = visibleElements(el.querySelectorAll('button, input, select, [role="switch"], [role="menuitemradio"], [role="menuitem"]'));
    const rows = visibleElements(el.querySelectorAll('[class*="shareRow"], [class*="shareWebRow"], [class*="shareExpiryRow"], [class*="shareAccessRow"]'));
    const permissionMenus = visibleElements(el.querySelectorAll('[class*="sharePermissionMenu"], [role="menu"]'));
    const permissionMenuItems = permissionMenus.flatMap((menu) => visibleElements(menu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]')));
    const input = visibleElements(el.querySelectorAll('input')).find((item) => item instanceof HTMLInputElement) ?? null;
    const title = el.querySelector('[data-share-tab][data-active="true"]') ?? el.querySelector('[class*="shareTitle"]');
    const switches = visibleElements(el.querySelectorAll('[role="switch"]'));
    const selects = visibleElements(el.querySelectorAll('select'));
    const copyLinks = visibleElements(el.querySelectorAll('[class*="copyLink"], button'))
      .filter((item) => /copy|복사/i.test(labelFor(item)) || /copy|복사/i.test(text(item)));
    const permissionButtons = visibleElements(el.querySelectorAll('[class*="shareInvitePermissionButton"], [class*="sharePermissionButton"]'));
    const clippedControls = visibleControls
      .filter((item) => item.scrollWidth > item.clientWidth + 2)
      .map((item) => labelFor(item).slice(0, 120));
    const matchingRows = rows.map((row) => {
      const buttons = visibleElements(row.querySelectorAll('button, [role="button"], [role="switch"], select'));
      return {
        buttons: buttons.map((button) => labelFor(button)),
        rect: rect(row),
        text: text(row).slice(0, 220),
      };
    });

    return {
      ok: true,
      accessRows: matchingRows,
      clippedControls,
      copyLinks: copyLinks.map((item) => ({
        label: labelFor(item),
        rect: rect(item),
      })),
      dialog: {
        clientWidth: el.clientWidth,
        rect: rect(el),
        scrollWidth: el.scrollWidth,
        title: text(title),
      },
      invite: input instanceof HTMLInputElement
        ? {
            placeholder: input.placeholder,
            rect: rect(input),
            value: input.value,
          }
        : null,
      expected: {
        inviteeEmail: expected.inviteeEmail,
        newInviteEmail: expected.newInviteEmail,
        title: expected.title,
      },
      page: {
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      },
      permissionButtons: permissionButtons.map((button) => ({
        label: labelFor(button),
        rect: rect(button),
      })),
      permissionMenuItems: permissionMenuItems.map((item) => ({
        label: labelFor(item),
        rect: rect(item),
        role: item.getAttribute('role'),
      })),
      selects: selects.map((select) => ({
        label: labelFor(select),
        rect: rect(select),
        value: select instanceof HTMLSelectElement ? select.value : null,
      })),
      state: expected.state,
      switches: switches.map((control) => ({
        checked: control.getAttribute('aria-checked'),
        label: labelFor(control),
        rect: rect(control),
      })),
      visibleControlLabels: visibleControls.map(labelFor),
    };
  }, {
    inviteeEmail: seed.inviteeEmail,
    newInviteEmail: seed.newInviteEmail,
    state: opts.state,
    title: seed.title,
  });

  return {
    generatedAt: new Date().toISOString(),
    reference: shareDialogReferenceInventory(),
    seed: {
      inviteeEmail: seed.inviteeEmail,
      newInviteEmail: seed.newInviteEmail,
      pageId: seed.pageId,
      title: seed.title,
    },
    target: {
      mobile: !!variant.mobile,
      state: opts.state,
    },
    local,
  };
}

function shareDialogReferenceInventory() {
  const artifact = (name) => {
    const path = join(root, '.edgebase', 'notion-reference', 'current', name);
    return {
      path,
      present: existsSync(path),
    };
  };

  return {
    source: 'Current Notion reference loop. Live Share dialog and owner permission-menu references were captured from the logged-in Chrome Notion workspace on 2026-06-26. These artifacts calibrate structure and rhythm, not raw DOM tags or exact coordinates.',
    artifacts: [
      artifact('live-notion-share-dialog-reference-2026-06-26.png'),
      artifact('live-notion-share-dialog-reference-2026-06-26.json'),
      artifact('live-notion-share-permission-menu-reference-2026-06-26.png'),
      artifact('live-notion-share-permission-menu-reference-2026-06-26.json'),
    ],
    normalizedContract: {
      main: [
        'The Share dialog should split private access management and public publishing into compact Share/Publish tabs.',
        'The Share tab should expose invite input and primary invite action at the top, access rows with right-side role selectors, and the page copy-link action in one compact panel.',
        'The Publish tab should expose public-web sharing, expiration controls, public access summary, and web/page copy-link actions without pushing controls outside the panel.',
        'Existing users/guests should remain visible as rows with role controls, not hidden behind a generic summary.',
        'Notion currently implements many controls as role=button divs; Notionlike should keep semantic, accessible controls while preserving the visible grouping and density.',
      ],
      permissionMenu: [
        'Permission menus should expose Full access, Can edit, Can comment, Can view, and Remove where relevant, using compact rows with short explanatory text where useful.',
        'Menu rows should remain compact and stay inside the dialog/viewport.',
      ],
      mobile: [
        'Mobile Share keeps full permission functionality while fitting within the viewport gutters.',
        'Inputs, role buttons, and copy actions should not clip or create horizontal page overflow.',
      ],
      note: 'The contract records product-visible structure and compactness from the live Notion reference. Local UI may add product-specific Cloudflare/expiration/public-web controls, but it should not drift into clipped inputs, loose rows, hidden access controls, or viewport overflow.',
    },
  };
}

function assertShareSurfaceInventory(inventory) {
  const { local, target } = inventory;
  assert(local?.ok, local?.reason ?? 'share surface inventory could not run');
  assert(
    matchesAnyText(local.dialog.title, target.state === 'publish' ? SHARE_LABELS.publish : SHARE_LABELS.share),
    `Share inventory active tab drifted: ${JSON.stringify(local.dialog)}`,
  );
  assert(
    local.dialog.scrollWidth <= local.dialog.clientWidth + 2,
    `Share inventory should not need horizontal dialog scrolling: ${JSON.stringify(local.dialog)}`,
  );
  assert(
    Math.max(local.page.bodyScrollWidth, local.page.documentScrollWidth) <= local.page.viewportWidth + 4,
    `Share inventory should not create page-level horizontal overflow: ${JSON.stringify(local.page)}`,
  );
  assert(
    local.clippedControls.length === 0,
    `Share inventory controls should not clip: ${local.clippedControls.join(' | ')}`,
  );

  if (target.mobile) {
    assert(local.page.viewportWidth <= 430, `mobile Share inventory should run in a narrow viewport: ${JSON.stringify(local.page)}`);
  }

  if (target.state === 'main') {
    assert(local.invite, 'Share main inventory should expose the invite input');
    assert(
      local.accessRows.some((row) => includesAnyText(row.text, SHARE_LABELS.you) && includesAnyText(row.text, SHARE_LABELS.fullAccess)),
      `Share main inventory should expose the owner row: ${JSON.stringify(local.accessRows)}`,
    );
    assert(
      local.accessRows.some((row) => row.text.includes(local.expected.inviteeEmail) && includesAnyText(row.text, SHARE_LABELS.canComment)),
      `Share main inventory should expose the existing invite row: ${JSON.stringify(local.accessRows)}`,
    );
    assert(
      local.copyLinks.some((item) => matchesAnyText(item.label, SHARE_LABELS.copyPageLink)),
      `Share main inventory should expose page copy action: ${JSON.stringify(local.copyLinks)}`,
    );
    assert(
      local.permissionButtons.length >= 2,
      `Share main inventory should expose invite and existing permission controls: ${JSON.stringify(local.permissionButtons)}`,
    );
    return;
  }

  if (target.state === 'publish') {
    assert(
      local.switches.length === 1 && local.switches[0].checked === 'true',
      `Share publish inventory should expose one enabled public web switch: ${JSON.stringify(local.switches)}`,
    );
    assert(
      local.selects.some((select) => matchesAnyText(select.label, SHARE_LABELS.publicLinkExpiration)),
      `Share publish inventory should expose public link expiration: ${JSON.stringify(local.selects)}`,
    );
    assert(
      local.accessRows.some((row) => includesAnyText(row.text, SHARE_LABELS.anyoneWithLink) && includesAnyText(row.text, SHARE_LABELS.canView)),
      `Share publish inventory should expose the public access row: ${JSON.stringify(local.accessRows)}`,
    );
    assert(
      local.copyLinks.some((item) => matchesAnyText(item.label, SHARE_LABELS.copyWebLink)) &&
        local.copyLinks.some((item) => matchesAnyText(item.label, SHARE_LABELS.copyPageLink)),
      `Share publish inventory should expose web/page copy actions: ${JSON.stringify(local.copyLinks)}`,
    );
    return;
  }

  const menuLabels = local.permissionMenuItems.map((item) => item.label);
  for (const label of SHARE_PERMISSION_LABELS) {
    assert(
      menuLabels.some((item) => matchesAnyText(item, label)),
      `Share ${target.state} inventory missing ${labelName(label)}: ${JSON.stringify(menuLabels)}`,
    );
  }
  if (target.state === 'existing-permission') {
    assert(
      menuLabels.some((item) => matchesAnyText(item, SHARE_LABELS.removeAccess)),
      `Share existing permission inventory missing ${labelName(SHARE_LABELS.removeAccess)}: ${JSON.stringify(menuLabels)}`,
    );
  }
}

async function shareMetrics(dialog, expectedVisibleTexts) {
  return dialog.evaluate((el, expectedVisibleTexts) => {
    if (!(el instanceof HTMLElement)) return { ok: false, reason: 'missing Share dialog' };
    const rect = el.getBoundingClientRect();
    const title = el.querySelector('[data-share-tab][data-active="true"]') ?? el.querySelector('[class*="shareTitle"]');
    const input = visibleElements(el.querySelectorAll('input')).find((item) => item instanceof HTMLInputElement) ?? null;
    const inviteInputRect = input instanceof HTMLElement ? input.getBoundingClientRect() : new DOMRect();
    const rows = visibleElements(el.querySelectorAll('[class*="shareRow"], [class*="shareWebRow"], [class*="shareExpiryRow"], [class*="shareAccessRow"]'));
    const copyLinks = visibleElements(el.querySelectorAll('[class*="copyLink"]'));
    const permissionButtons = visibleElements(el.querySelectorAll('[class*="shareInvitePermissionButton"], [class*="sharePermissionButton"]'));
    const permissionMenus = visibleElements(el.querySelectorAll('[class*="sharePermissionMenu"]'));
    const permissionMenuItems = permissionMenus.flatMap((menu) => visibleElements(menu.querySelectorAll('button')));
    const permissionMenuRects = permissionMenus.map((menu) => menu.getBoundingClientRect());
    const permissionMenuItemRects = permissionMenuItems.map((item) => item.getBoundingClientRect());
    const expandedPermissionButton = permissionButtons.find((button) => button.getAttribute('aria-expanded') === 'true');
    const expandedPermissionButtonRect = expandedPermissionButton instanceof HTMLElement
      ? expandedPermissionButton.getBoundingClientRect()
      : new DOMRect();
    const permissionMenuTriggerHorizontalGap =
      permissionMenuRects.length && expandedPermissionButton instanceof HTMLElement
        ? Math.min(...permissionMenuRects.map((menuRect) => {
            if (menuRect.right < expandedPermissionButtonRect.left) return expandedPermissionButtonRect.left - menuRect.right;
            if (expandedPermissionButtonRect.right < menuRect.left) return menuRect.left - expandedPermissionButtonRect.right;
            return 0;
          }))
        : 0;
    const permissionMenuTriggerVerticalGap =
      permissionMenuRects.length && expandedPermissionButton instanceof HTMLElement
        ? Math.min(...permissionMenuRects.map((menuRect) => menuRect.top - expandedPermissionButtonRect.bottom))
        : 0;
    const visibleControls = visibleElements(el.querySelectorAll('button, input, select, [role="switch"], [role="menuitemradio"], [role="menuitem"]'));
    const clippedControls = visibleControls
      .filter((item) => item.scrollWidth > item.clientWidth + 2)
      .map((item) => item.textContent?.trim().slice(0, 120) || item.getAttribute('aria-label') || item.tagName);
    const missingVisibleExpectedTexts = expectedVisibleTexts
      .filter((expected) => !textVariants(expected).some((text) => hasVisibleText(el, text)))
      .map((expected) => textVariants(expected).join(' / '));
    return {
      ok: true,
      accessRows: rows.length,
      bottom: rect.bottom,
      copyLinkCount: copyLinks.length,
      dialogClientWidth: el.clientWidth,
      dialogScrollWidth: el.scrollWidth,
      height: rect.height,
      inviteInputCount: input instanceof HTMLElement ? 1 : 0,
      inviteInputHeight: inviteInputRect.height,
      inviteInputWidth: inviteInputRect.width,
      left: rect.left,
      missingVisibleExpectedTexts,
      permissionButtonCount: permissionButtons.length,
      permissionMenuBottom: Math.max(...permissionMenuRects.map((item) => item.bottom), 0),
      permissionMenuCount: permissionMenus.length,
      permissionMenuItemCount: permissionMenuItems.length,
      permissionMenuMaxItemHeight: Math.max(...permissionMenuItemRects.map((item) => item.height), 0),
      permissionMenuMinItemHeight: Math.min(...permissionMenuItemRects.map((item) => item.height), 999),
      permissionMenuRightGap: Math.min(...permissionMenuRects.map((item) => window.innerWidth - item.right), 999),
      permissionMenuTriggerHorizontalGap,
      permissionMenuTriggerVerticalGap,
      placeholderFits: input instanceof HTMLInputElement ? placeholderFits(input) : false,
      rightGap: window.innerWidth - rect.right,
      clippedControls,
      titleText: title?.textContent?.trim() ?? '',
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      webSwitchCount: visibleElements(el.querySelectorAll('[role="switch"]')).length,
      expirySelectCount: visibleElements(el.querySelectorAll('select')).length,
      width: rect.width,
    };

    function textVariants(expected) {
      return Array.isArray(expected)
        ? expected.flatMap((item) => textVariants(item))
        : [String(expected)];
    }

    function visibleElements(items) {
      return Array.from(items).filter((item) => item instanceof HTMLElement && isVisible(item));
    }

    function hasVisibleText(root, expected) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(expected)) continue;
        const parent = node.parentElement;
        if (parent instanceof HTMLElement && isVisible(parent)) return true;
      }
      return false;
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const itemRect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && itemRect.width > 0 && itemRect.height > 0;
    }

    function placeholderFits(input) {
      const style = window.getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return true;
      context.font = style.font;
      const padding =
        Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
      return context.measureText(input.placeholder).width + padding <= input.getBoundingClientRect().width - 2;
    }
  }, expectedVisibleTexts);
}

function assertShareGeometry(metrics, variant, label) {
  assert(metrics.ok !== false, `${label} is missing: ${metrics.reason ?? 'unknown reason'}`);
  if (variant.mobile) {
    assert(metrics.width >= metrics.viewportWidth - 24 && metrics.width <= metrics.viewportWidth - 12, `${label} should fit mobile gutters, got ${Math.round(metrics.width)}px in ${metrics.viewportWidth}px`);
    assert(metrics.left >= 8 && metrics.left <= 14, `${label} should keep a mobile left gutter, got ${Math.round(metrics.left)}px`);
    assert(metrics.rightGap >= 8 && metrics.rightGap <= 14, `${label} should keep a mobile right gutter, got ${Math.round(metrics.rightGap)}px`);
    assert(metrics.top >= 44 && metrics.top <= 56, `${label} should open below the mobile top bar, got ${Math.round(metrics.top)}px`);
    assert(metrics.bottom <= metrics.viewportHeight - 8, `${label} should stay inside mobile viewport, got bottom=${Math.round(metrics.bottom)}px`);
    return;
  }
  assert(metrics.width >= 440 && metrics.width <= 470, `${label} should be a compact tabbed share panel, got ${Math.round(metrics.width)}px`);
  assert(metrics.top >= 42 && metrics.top <= 76, `${label} should open under the top bar, got top=${Math.round(metrics.top)}px`);
  assert(metrics.rightGap >= 8 && metrics.rightGap <= 24, `${label} should align near the right edge, got gap=${Math.round(metrics.rightGap)}px`);
  assert(metrics.bottom <= metrics.viewportHeight - 8, `${label} should stay in viewport, got bottom=${Math.round(metrics.bottom)}px`);
}

function assertNoShareOverflow(metrics, label) {
  assert(metrics.dialogScrollWidth <= metrics.dialogClientWidth + 2, `${label} should not horizontally scroll, got ${metrics.dialogScrollWidth}/${metrics.dialogClientWidth}`);
  assert(metrics.clippedControls.length === 0, `${label} controls should not clip: ${metrics.clippedControls.join(' | ')}`);
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

async function seedSharePage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for share dialog visual smoke');

  const suffix = Date.now();
  const shortSuffix = String(suffix).slice(-6);
  const pageId = randomUUID();
  const blockId = randomUUID();
  const title = `Share visual ${shortSuffix}`;
  const blockText = `Share dialog visual body ${shortSuffix}`;
  const inviteeEmail = `share-visual-${shortSuffix}@example.com`;
  const newInviteEmail = `new-share-visual-${shortSuffix}@example.com`;

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    icon: '🔗',
    iconType: 'emoji',
    cover: '',
    coverPosition: 50,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'share dialog visual page must be created');

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
  assert(block?.block?.id === blockId, 'share dialog visual block must be created');

  const invited = await callFunction(baseUrl, session.accessToken, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'email',
    label: inviteeEmail,
    role: 'comment',
  });
  const permissionId = invited?.permission?.id;
  assert(permissionId, 'share dialog visual email permission must be created');

  const webSharing = await callFunction(baseUrl, session.accessToken, 'share-mutation', {
    action: 'setWebSharing',
    pageId,
    enabled: true,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert(webSharing?.shareLink?.token, 'share dialog visual web sharing must return a public token');

  return {
    accessToken: session.accessToken,
    blockId,
    blockText,
    inviteeEmail,
    newInviteEmail,
    pageId,
    permissionId,
    refreshToken: session.refreshToken,
    title,
    workspaceId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken) return;
  if (seed.permissionId) {
    await callFunction(baseUrl, seed.accessToken, 'share-mutation', {
      action: 'removePermission',
      permissionId: seed.permissionId,
    }).catch(() => {});
  }
  if (seed.pageId) {
    await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
      action: 'delete',
      id: seed.pageId,
    }).catch(() => {});
  }
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
    window.localStorage.setItem('notionlike:theme', 'light');
  }, {
    refreshToken: seed.refreshToken,
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
    'Playwright is required for share dialog visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  console.log(`Usage: node scripts/share-dialog-visual-smoke.mjs [options]

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

function shareDialogNameMatcher(pageTitle) {
  return labelMatcher([`Share ${pageTitle}`, `${pageTitle} 공유`]);
}

function sharePageNameMatcher(pageTitle) {
  return labelMatcher([`Share ${pageTitle}`, `${pageTitle} 공유`]);
}

function labelMatcher(labels) {
  return new RegExp(`^(?:${labelVariants(labels).map(escapeRegExp).join('|')})$`);
}

function textMatcher(labels) {
  return new RegExp(labelVariants(labels).map(escapeRegExp).join('|'));
}

function labelVariants(labels) {
  return Array.isArray(labels)
    ? labels.flatMap((label) => labelVariants(label))
    : [String(labels)];
}

function labelName(labels) {
  return labelVariants(labels).join(' / ');
}

function matchesAnyText(value, labels) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return labelVariants(labels).some((label) => normalized === label);
}

function includesAnyText(value, labels) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return labelVariants(labels).some((label) => normalized.includes(label));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
