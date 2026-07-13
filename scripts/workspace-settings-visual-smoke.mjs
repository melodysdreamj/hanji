#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserAuthStorageKeys,
  deleteSmokeUser,
  deleteSmokeWorkspace,
  masterCredentials,
  signInSmokeAdmin,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'workspace-settings');

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL workspace settings visual smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? options.url);
  console.log(`Workspace settings visual smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Workspace settings visual smoke API target: ${apiUrl}`);

  await assertRuntimeReachable(apiUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedWorkspaceSettings(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  let runError;
  try {
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'desktop',
      viewport: { width: 1440, height: 1000 },
      captures: [
        {
          name: 'preferences',
          section: 'preferences',
          activeNavText: 'Profile',
          expectedVisibleTexts: ['Preferences', 'Theme'],
          minControls: 3,
          minRows: 0,
        },
        {
          name: 'profile',
          section: 'profile',
          activeNavText: 'Profile',
          profileIconDraft: '⭐',
          expectedVisibleTexts: ['Profile', 'Profile icon', 'Change icon', 'Save profile'],
          minControls: 4,
          minRows: 0,
        },
        {
          name: 'account-security',
          section: 'account-security',
          activeNavText: 'Account security',
          expectedVisibleTexts: ['Account security', 'Two-step verification', 'Turn on two-step verification', 'Active sessions'],
          minControls: 2,
          minRows: 2,
        },
        {
          name: 'mcp',
          section: 'mcp',
          activeNavText: 'AI connections',
          expectedVisibleTexts: ['AI connections', 'MCP server URL', 'Connected AI apps'],
          minControls: 3,
          minRows: 3,
        },
        {
          name: 'account-security-mfa-setup',
          section: 'account-security',
          activeNavText: 'Account security',
          mfaSetup: true,
          expectedVisibleTexts: ['Account security', 'Scan the QR code in your authenticator app', "Can't scan the QR code?", "Enter the app's 6-digit code", 'Apply verification'],
          minControls: 4,
          minRows: 3,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'desktop-server-admin',
      surface: 'server-admin',
      viewport: { width: 1440, height: 1000 },
      captures: [
        {
          name: 'overview',
          section: 'server-overview',
          activeNavText: 'Overview',
          expectedVisibleTexts: ['Server overview', 'Operational status', 'Workspaces'],
          minControls: 1,
          minRows: 4,
        },
        {
          name: 'instance',
          section: 'instance',
          activeNavText: 'Accounts & signup',
          expectedVisibleTexts: ['Server accounts & signup', 'Signup', 'Create account', seed.email],
          minControls: 10,
          minRows: 1,
        },
        {
          name: 'workspaces',
          section: 'server-workspaces',
          activeNavText: 'Workspaces',
          expectedVisibleTexts: ['Server workspaces', 'every workspace'],
          minControls: 2,
          minRows: 1,
        },
        {
          name: 'security',
          section: 'server-security',
          activeNavText: 'Security',
          expectedVisibleTexts: ['Server security', 'Session revocation', 'Temporary password'],
          minControls: 3,
          minRows: 1,
        },
        {
          name: 'audit',
          section: 'server-audit',
          activeNavText: 'Audit log',
          expectedVisibleTexts: ['Server audit log', 'instance admin actions'],
          minControls: 2,
          minRows: 0,
        },
        {
          name: 'jobs',
          section: 'server-jobs',
          activeNavText: 'Imports',
          expectedVisibleTexts: ['Import jobs', 'Notion migration'],
          minControls: 2,
          minRows: 0,
        },
        {
          name: 'usage',
          section: 'server-usage',
          activeNavText: 'Usage & files',
          expectedVisibleTexts: ['Server usage & files', 'Active storage', 'Files'],
          minControls: 1,
          minRows: 3,
        },
        {
          name: 'backup',
          section: 'server-backup',
          activeNavText: 'Backup',
          expectedVisibleTexts: ['Backup & restore', 'Download snapshot', 'Product data'],
          minControls: 1,
          minRows: 3,
        },
        {
          name: 'system',
          section: 'server-system',
          activeNavText: 'System',
          expectedVisibleTexts: ['Server system', 'operational environment values'],
          minControls: 1,
          minRows: 3,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'desktop-workspace-admin',
      surface: 'workspace-admin',
      viewport: { width: 1440, height: 1000 },
      captures: [
        {
          name: 'workspace-overview',
          section: 'workspace',
          activeNavText: 'Overview',
          expectedVisibleTexts: ['Workspace', 'Workspace URL', 'Change icon'],
          minControls: 3,
          minRows: 0,
        },
        {
          name: 'people',
          section: 'people',
          activeNavText: 'Workspace members',
          expectedVisibleTexts: ['Workspace members', 'Add members'],
          minControls: 3,
          minRows: 1,
        },
        {
          name: 'people-invite-panel',
          section: 'people',
          activeNavText: 'Workspace members',
          inviteDraft: true,
          inviteRole: 'guest',
          draftInviteEmail: seed.draftInviteEmail,
          expectedVisibleTexts: ['Workspace members', 'Add members', seed.draftInviteEmail],
          minControls: 3,
          minRows: 1,
        },
        {
          name: 'workspace-security',
          section: 'workspace-security',
          activeNavText: 'Sharing security',
          expectedVisibleTexts: ['Workspace security', 'Sharing policies', 'Public web sharing', 'File downloads'],
          minControls: 5,
          minRows: 1,
        },
        {
          name: 'organization-policies',
          section: 'organization',
          activeNavText: 'Policies & domains',
          expectedVisibleTexts: ['Organization admin', 'Workspace creation', 'Domain signup'],
          minControls: 5,
          minRows: 4,
        },
        {
          name: 'organization-groups',
          section: 'organization',
          activeNavText: 'Policies & domains',
          anchorText: seed.groupName,
          expectedVisibleTexts: ['Groups', seed.groupName, 'Add group'],
          minControls: 6,
          minRows: 4,
        },
        {
          name: 'organization-domains',
          section: 'organization',
          activeNavText: 'Policies & domains',
          anchorText: seed.domain,
          expectedVisibleTexts: ['Domains', seed.domain, 'Verified', 'Add domain'],
          minControls: 4,
          minRows: 3,
        },
        {
          name: 'usage',
          section: 'usage',
          activeNavText: 'Usage',
          expectedVisibleTexts: ['Usage', 'Organization usage', 'Workspace usage', 'Active storage', 'Storage limit'],
          minControls: 3,
          minRows: 4,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark',
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
      captures: [
        {
          name: 'preferences',
          section: 'preferences',
          activeNavText: 'Profile',
          expectedVisibleTexts: ['Preferences', 'Theme'],
          minControls: 3,
          minRows: 0,
        },
        {
          name: 'account-security-mfa-setup',
          section: 'account-security',
          activeNavText: 'Account security',
          mfaSetup: true,
          expectedVisibleTexts: ['Account security', 'Scan the QR code in your authenticator app', "Can't scan the QR code?", "Enter the app's 6-digit code", 'Apply verification'],
          minControls: 4,
          minRows: 3,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark-server-admin',
      surface: 'server-admin',
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
      captures: [
        {
          name: 'overview',
          section: 'server-overview',
          activeNavText: 'Overview',
          expectedVisibleTexts: ['Server overview', 'Operational status'],
          minControls: 1,
          minRows: 4,
        },
        {
          name: 'instance',
          section: 'instance',
          activeNavText: 'Accounts & signup',
          expectedVisibleTexts: ['Server accounts & signup', 'Signup', seed.email],
          minControls: 10,
          minRows: 1,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'desktop-dark-workspace-admin',
      surface: 'workspace-admin',
      theme: 'dark',
      viewport: { width: 1440, height: 1000 },
      captures: [
        {
          name: 'people',
          section: 'people',
          activeNavText: 'Workspace members',
          expectedVisibleTexts: ['Workspace members', 'Add members'],
          minControls: 3,
          minRows: 1,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'mobile',
      mobile: true,
      viewport: { width: 390, height: 844 },
      captures: [
        {
          name: 'preferences',
          section: 'preferences',
          expectedVisibleTexts: ['Preferences', 'Theme'],
          minControls: 3,
          minRows: 0,
        },
        {
          name: 'account-security',
          section: 'account-security',
          // Mobile (narrow, single-column) stretches this section taller than the
          // viewport, so only the top of it is on-screen for the capture; the
          // full control set is asserted by the desktop account-security capture.
          expectedVisibleTexts: ['Account security', 'Two-step verification'],
          minControls: 2,
          minRows: 2,
        },
        {
          name: 'mcp',
          section: 'mcp',
          // Trailing text sits below the mobile fold; desktop-mcp covers the full section.
          expectedVisibleTexts: ['AI connections', 'MCP server URL'],
          minControls: 3,
          minRows: 3,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'mobile-server-admin',
      surface: 'server-admin',
      mobile: true,
      viewport: { width: 390, height: 844 },
      captures: [
        {
          name: 'overview',
          section: 'server-overview',
          expectedVisibleTexts: ['Server overview', 'Operational status'],
          minControls: 1,
          minRows: 4,
        },
        {
          name: 'instance',
          section: 'instance',
          // seed.email sits below the mobile fold; desktop-server-admin-instance asserts it.
          expectedVisibleTexts: ['Server accounts & signup', 'Signup'],
          minControls: 10,
          minRows: 1,
        },
      ],
    });
    await captureSettingsVariant(browser, appUrl, seed, {
      prefix: 'mobile-workspace-admin',
      surface: 'workspace-admin',
      mobile: true,
      viewport: { width: 390, height: 844 },
      captures: [
        {
          name: 'people-invite-panel',
          section: 'people',
          inviteDraft: true,
          inviteRole: 'guest',
          draftInviteEmail: seed.draftInviteEmail,
          // The capture scrolls to the member-add form near the bottom of the
          // section, so the section title is above the mobile fold.
          expectedVisibleTexts: ['Add members', seed.draftInviteEmail],
          minControls: 3,
          minRows: 1,
        },
        {
          name: 'organization',
          section: 'organization',
          // Trailing text sits below the mobile fold; the desktop organization captures cover it.
          expectedVisibleTexts: ['Organization admin', 'Workspace creation'],
          minControls: 4,
          minRows: 4,
        },
      ],
    });

    console.log('PASS workspace settings deep sections are captured and stay within the Notion-style admin layout contract.');
    for (const name of [
      'desktop-preferences',
      'desktop-profile',
      'desktop-account-security',
      'desktop-mcp',
      'desktop-account-security-mfa-setup',
      'desktop-server-admin-overview',
      'desktop-server-admin-instance',
      'desktop-server-admin-workspaces',
      'desktop-server-admin-security',
      'desktop-server-admin-audit',
      'desktop-server-admin-jobs',
      'desktop-server-admin-usage',
      'desktop-server-admin-backup',
      'desktop-server-admin-system',
      'desktop-workspace-admin-workspace-overview',
      'desktop-workspace-admin-people',
      'desktop-workspace-admin-people-invite-panel',
      'desktop-workspace-admin-workspace-security',
      'desktop-workspace-admin-organization-policies',
      'desktop-workspace-admin-organization-groups',
      'desktop-workspace-admin-organization-domains',
      'desktop-workspace-admin-usage',
      'desktop-dark-preferences',
      'desktop-dark-account-security-mfa-setup',
      'desktop-dark-server-admin-overview',
      'desktop-dark-server-admin-instance',
      'desktop-dark-workspace-admin-people',
      'mobile-preferences',
      'mobile-account-security',
      'mobile-mcp',
      'mobile-server-admin-overview',
      'mobile-server-admin-instance',
      'mobile-workspace-admin-people-invite-panel',
      'mobile-workspace-admin-organization',
    ]) {
      console.log(`Screenshot: ${join(options.screenshotDir, `${name}.png`)}`);
    }
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await cleanupSeed(apiUrl, seed);
    } catch (cleanupError) {
      if (!runError) throw cleanupError;
      console.warn(`Workspace settings smoke cleanup also failed: ${errorMessage(cleanupError)}`);
    }
    await browser.close().catch(() => {});
  }
}

async function captureSettingsVariant(browser, appUrl, seed, variant) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: !!variant.mobile,
    isMobile: !!variant.mobile,
    viewport: variant.viewport,
  });
  await seedSession(context, seed, variant.theme ?? 'light');

  try {
    await openSettings(page, appUrl, variant);
    for (const capture of variant.captures) {
      console.log(`Capture: ${variant.prefix}-${capture.name}`);
      await scrollSettingsSection(page, capture.section, variant.surface ?? 'account-console');
      await scrollToVisibleText(page, capture.anchorText, variant.surface ?? 'account-console');
      if (capture.inviteDraft) {
        await fillInviteDraft(page, capture, variant.surface ?? 'account-console');
        await scrollToVisibleText(page, capture.draftInviteEmail, variant.surface ?? 'account-console');
      }
      if (capture.mfaSetup) {
        await openMfaSetupDraft(page);
        await scrollToVisibleText(page, 'Scan the QR code in your authenticator app', variant.surface ?? 'account-console');
      }
      if (capture.profileIconDraft) {
        await updateProfileIconDraft(page, capture.profileIconDraft);
      }
      await waitForSettingsExpectedTexts(page, capture.section, capture.expectedVisibleTexts, variant.surface ?? 'account-console');
      await assertSettingsSectionContract(page, capture, variant);
      await page.screenshot({
        path: join(options.screenshotDir, `${variant.prefix}-${capture.name}.png`),
        fullPage: false,
      });
    }
    assertNoBrowserErrors(errors, `${variant.prefix} workspace settings visual flow`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function waitForSettingsExpectedTexts(page, section, expectedTexts = [], surface = 'account-console') {
  if (!expectedTexts.length) return;
  await page.waitForFunction(({ section, expectedTexts, surface }) => {
    const sectionMap = {
      Workspace: 'workspace',
      Members: 'people',
      security: 'account-security',
      storage: 'usage',
    };
    const normalizedSection = sectionMap[section] ?? section;
    const dialog = visibleSettingsSurface(surface);
    if (!(dialog instanceof HTMLElement)) return false;
    const target = dialog.querySelector(`#${CSS.escape(normalizedSection)}`);
    if (!(target instanceof HTMLElement)) return false;
    return expectedTexts.every((text) => hasTextOrValue(target, text));

    function visibleSettingsSurface(surface) {
      return Array.from(document.querySelectorAll(`[data-surface="${surface}"]`)).find(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function hasTextOrValue(root, expected) {
      if ((root.textContent ?? '').includes(expected)) return true;
      return Array.from(root.querySelectorAll('input, textarea')).some((element) => (
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        (element.value.includes(expected) || element.getAttribute('aria-label')?.includes(expected))
      ));
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, { section, expectedTexts, surface }, { timeout: options.timeoutMs });
}

async function openMfaSetupDraft(page) {
  const dialog = page.locator('[data-surface="account-console"]').first();
  const setupButton = dialog.getByRole('button', { name: 'Turn on two-step verification' });
  if (await setupButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await setupButton.click({ timeout: options.timeoutMs });
  }
  await dialog.getByText('Scan the QR code in your authenticator app', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('img', { name: 'Two-step verification QR code to scan with Google Authenticator' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function updateProfileIconDraft(page, emoji) {
  const dialog = page.locator('[data-surface="account-console"]').first();
  await dialog.getByRole('button', { name: 'Change profile icon' }).click({
    timeout: options.timeoutMs,
  });
  await dialog.getByRole('dialog', { name: 'Choose icon' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.locator(`button[aria-label="Choose ${emoji} icon"]`).click({
    timeout: options.timeoutMs,
  });
  const saveButton = dialog.getByRole('button', { name: 'Save profile' });
  await saveButton.click({ timeout: options.timeoutMs });
  await page.waitForFunction((expectedEmoji) => {
    const surface = document.querySelector('[data-surface="account-console"]');
    if (!(surface instanceof HTMLElement)) return false;
    const save = Array.from(surface.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save profile',
    );
    return !!surface.textContent?.includes(expectedEmoji) && !(save instanceof HTMLButtonElement && save.disabled);
  }, emoji, { timeout: options.timeoutMs });
}

async function fillInviteDraft(page, capture, surface = 'account-console') {
  const dialog = page.locator(`[data-surface="${surface}"]`).first();
  const addMember = dialog.getByRole('button', { name: 'Add members' });
  if (await addMember.isVisible({ timeout: 1000 }).catch(() => false)) {
    await addMember.click({ timeout: options.timeoutMs });
  }
  await dialog.getByRole('textbox', { name: 'Member email' }).fill(capture.draftInviteEmail, {
    timeout: options.timeoutMs,
  });
  await dialog.getByLabel('New member role').selectOption(capture.inviteRole ?? 'member', {
    timeout: options.timeoutMs,
  });
}

async function openSettings(page, baseUrl, variant) {
  const surface = variant.surface ?? 'account-console';
  const settingsPath =
    surface === 'server-admin'
      ? '/settings?admin=server'
      : surface === 'workspace-admin'
        ? '/settings?admin=workspace'
        : '/account';
  await page.goto(resolveUrl(baseUrl, settingsPath), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const root = page.locator(`[data-surface="${surface}"]`).first();
  await root.waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await root.locator(
    surface === 'server-admin' ? '#server-overview' : surface === 'workspace-admin' ? '#workspace' : '#preferences',
  ).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openSettingsEntry(page) {
  const visibleSettingsButton = page.getByRole('button', { name: 'Account console' }).first();
  if (await visibleSettingsButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await visibleSettingsButton.click({ timeout: options.timeoutMs });
    return;
  }

  await page.getByRole('button', { name: 'Open workspace menu' }).first().click({
    timeout: options.timeoutMs,
  });
  await page.getByRole('menuitem', { name: 'Account console' }).first().click({
    timeout: options.timeoutMs,
  });
}

async function scrollSettingsSection(page, section, surface = 'account-console') {
  await page.waitForFunction(({ targetSection, surface }) => {
    const sectionMap = {
      Workspace: 'workspace',
      Members: 'people',
      security: 'account-security',
      storage: 'usage',
    };
    const navLabels = {
      preferences: 'Profile',
      profile: 'Profile',
      'server-overview': 'Overview',
      instance: 'Accounts & signup',
      'server-workspaces': 'Workspaces',
      'server-security': 'Security',
      'server-audit': 'Audit log',
      'server-jobs': 'Imports',
      'server-usage': 'Usage & files',
      'server-backup': 'Backup',
      'server-system': 'System',
      workspace: surface === 'workspace-admin' ? 'Overview' : 'Workspace',
      people: surface === 'workspace-admin' ? 'Workspace members' : 'People',
      'account-security': 'Account security',
      mcp: 'AI connections',
      'workspace-security': surface === 'workspace-admin' ? 'Sharing security' : 'Workspace security',
      organization: surface === 'workspace-admin' ? 'Policies & domains' : 'Organization admin',
      usage: 'Usage',
    };
    const normalizedSection = sectionMap[targetSection] ?? targetSection;
    const dialog = visibleSettingsSurface(surface);
    if (!(dialog instanceof HTMLElement)) return false;
    const panel = dialog.querySelector('[class*="panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    const navLabel = navLabels[normalizedSection];
    if (navLabel) {
      const nav = dialog.querySelector('nav');
      const navItem = Array.from(nav?.querySelectorAll('button, a') ?? []).find(
        (item) => item instanceof HTMLElement && item.textContent?.trim() === navLabel,
      );
      if (navItem instanceof HTMLElement) navItem.click();
    }
    const target = dialog.querySelector(`#${CSS.escape(normalizedSection)}`);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'start' });
    return true;

    function visibleSettingsSurface(surface) {
      return Array.from(document.querySelectorAll(`[data-surface="${surface}"]`)).find(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, { targetSection: section, surface }, { timeout: options.timeoutMs });
  await page.waitForTimeout(120);
}

async function scrollToVisibleText(page, text, surface = 'account-console') {
  if (!text) return;
  await page.waitForFunction(({ expectedText, surface }) => {
    const dialog = visibleSettingsSurface(surface);
    if (!(dialog instanceof HTMLElement)) return false;
    const panel = dialog.querySelector('[class*="panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    const valueMatch = Array.from(dialog.querySelectorAll('input, textarea')).find(
      (element) =>
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value.includes(expectedText) || element.getAttribute('aria-label')?.includes(expectedText)
          : false,
    );
    if (valueMatch instanceof HTMLElement) {
      valueMatch.scrollIntoView({ block: 'center' });
      return true;
    }
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.includes(expectedText)) continue;
      const parent = node.parentElement;
      if (!(parent instanceof HTMLElement)) continue;
      parent.scrollIntoView({ block: 'center' });
      return true;
    }
    return false;

    function visibleSettingsSurface(surface) {
      return Array.from(document.querySelectorAll(`[data-surface="${surface}"]`)).find(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, { expectedText: text, surface }, { timeout: options.timeoutMs });
  await page.waitForTimeout(120);
}

async function assertSettingsSectionContract(page, capture, variant) {
  const metrics = await page.evaluate(({ expectedVisibleTexts, section, surface }) => {
    const sectionMap = {
      Workspace: 'workspace',
      Members: 'people',
      security: 'account-security',
      storage: 'usage',
    };
    const normalizedSection = sectionMap[section] ?? section;
    const dialog = visibleSettingsSurface(surface);
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: `missing ${surface} surface` };
    const panel = dialog.querySelector('[class*="panel"]');
    const nav = dialog.querySelector('nav');
    const target = dialog.querySelector(`#${CSS.escape(normalizedSection)}`);
    if (!(panel instanceof HTMLElement)) return { ok: false, reason: 'missing Settings panel' };
    if (!(target instanceof HTMLElement)) return { ok: false, reason: `missing ${section} section` };
    const dialogRect = dialog.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const sectionRect = target.getBoundingClientRect();
    const controls = visibleElements(target.querySelectorAll('button, input, select, textarea, [role="radio"]'));
    const rowLike = visibleElements(target.querySelectorAll('[class*="Row"], [class*="Tile"], [class*="Block"], [class*="Option"], [class*="Panel"]'));
    const inviteForm = target.querySelector('[class*="memberInvite"]');
    const inviteEmailInput = target.querySelector('input[aria-label="Member email"]');
    const inviteRoleSelect = target.querySelector('select[aria-label="New member role"]');
    const inviteButton = inviteForm instanceof HTMLElement
      ? Array.from(inviteForm.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Add members')
      : null;
    const controlRects = controls.map((control) => control.getBoundingClientRect());
    const overflowControlLabels = controls
      .filter((control) => (
        !['input', 'select', 'textarea'].includes(control.tagName.toLowerCase()) &&
        control.scrollWidth > control.clientWidth + 2
      ))
      .map((control) => ({
        aria: control.getAttribute('aria-label') ?? '',
        clientWidth: control.clientWidth,
        scrollWidth: control.scrollWidth,
        text: control.textContent?.trim().slice(0, 80) ?? '',
        tag: control.tagName.toLowerCase(),
      }));
    const activeNavLabels = nav instanceof HTMLElement
      ? visibleElements(nav.querySelectorAll('[data-active="true"], [aria-current="page"]'))
          .map((item) => item.textContent?.trim() ?? '')
          .filter(Boolean)
      : [];
    const missingVisibleExpectedTexts = expectedVisibleTexts.filter(
      (text) => !hasVisibleText(target, text) && !hasVisibleValue(target, text),
    );
    const sectionTitle = target.querySelector('[class*="sectionTitle"]');
    const urlPrefix = dialog.querySelector('[class*="urlPrefix"]');
    const visibleDialogText = dialog.innerText ?? '';
    const rawBackendErrorTexts = ['Too many requests', 'Please try again later'].filter((text) =>
      visibleDialogText.includes(text),
    );
    return {
      ok: true,
      controlCount: controls.length,
      controlMaxHeight: Math.max(...controlRects.map((rect) => rect.height), 0),
      controlMinHeight: Math.min(...controlRects.map((rect) => rect.height), 999),
      dialogHeight: dialogRect.height,
      dialogLeft: dialogRect.left,
      dialogTop: dialogRect.top,
      dialogWidth: dialogRect.width,
      missingVisibleExpectedTexts,
      navWidth: nav instanceof HTMLElement && isVisible(nav) ? nav.getBoundingClientRect().width : 0,
      overflowControlLabels,
      overflowControls: overflowControlLabels.length,
      activeNavLabels,
      inviteButtonHeight: inviteButton instanceof HTMLElement ? inviteButton.getBoundingClientRect().height : 0,
      inviteEmailValue: inviteEmailInput instanceof HTMLInputElement ? inviteEmailInput.value : '',
      inviteFormVisible: inviteForm instanceof HTMLElement && isVisible(inviteForm),
      inviteInputCount: inviteForm instanceof HTMLElement ? visibleElements(inviteForm.querySelectorAll('input')).length : 0,
      inviteRoleValue: inviteRoleSelect instanceof HTMLSelectElement ? inviteRoleSelect.value : '',
      panelClientWidth: panel.clientWidth,
      panelScrollWidth: panel.scrollWidth,
      rawBackendErrorTexts,
      rowCount: rowLike.length,
      sectionBottom: sectionRect.bottom,
      sectionHeight: sectionRect.height,
      sectionLeft: sectionRect.left,
      sectionRight: sectionRect.right,
      sectionScrollWidth: target.scrollWidth,
      sectionTop: sectionRect.top,
      sectionWidth: sectionRect.width,
      titleFontSize: sectionTitle instanceof HTMLElement ? Number.parseFloat(getComputedStyle(sectionTitle).fontSize) : 0,
      section: normalizedSection,
      surface,
      urlPrefixText: urlPrefix instanceof HTMLElement ? urlPrefix.textContent?.trim() ?? '' : '',
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };

    function visibleElements(items) {
      return Array.from(items).filter(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function visibleSettingsSurface(surface) {
      return Array.from(document.querySelectorAll(`[data-surface="${surface}"]`)).find(
        (element) => element instanceof HTMLElement && isVisible(element),
      );
    }

    function hasVisibleText(root, expected) {
      const rootRect = root.getBoundingClientRect();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(expected)) continue;
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement) || !isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        range.detach();
        if (rects.some((rect) => (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > rootRect.left &&
          rect.left < rootRect.right &&
          rect.bottom > rootRect.top &&
          rect.top < rootRect.bottom &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        ))) {
          return true;
        }
      }
      return false;
    }

    function hasVisibleValue(root, expected) {
      return Array.from(root.querySelectorAll('input, textarea')).some((element) => {
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false;
        if (!isVisible(element) || !element.value.includes(expected)) return false;
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        );
      });
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
  }, { ...capture, surface: variant.surface ?? 'account-console' });
  assert(metrics.ok, metrics.reason ?? `${capture.name} Settings contract could not run`);
  assert(metrics.missingVisibleExpectedTexts.length === 0, `${capture.name} expected text is not visible in screenshot: ${JSON.stringify(metrics)}`);
  assert(metrics.controlCount >= capture.minControls, `${capture.name} should expose enough controls, got ${metrics.controlCount}: ${JSON.stringify(metrics)}`);
  assert(metrics.rowCount >= capture.minRows, `${capture.name} should expose enough rows/cards, got ${metrics.rowCount}: ${JSON.stringify(metrics)}`);
  assert(metrics.rawBackendErrorTexts.length === 0, `${capture.name} Settings should not expose raw backend errors: ${JSON.stringify(metrics)}`);
  assert(metrics.overflowControls === 0, `${capture.name} has horizontally overflowing controls: ${JSON.stringify(metrics)}`);
  assert(metrics.panelScrollWidth <= metrics.panelClientWidth + 4, `${capture.name} settings panel should not horizontally scroll: ${JSON.stringify(metrics)}`);
  assert(metrics.sectionScrollWidth <= metrics.sectionWidth + 4, `${capture.name} settings section should not horizontally overflow: ${JSON.stringify(metrics)}`);
  assert(!metrics.urlPrefixText.includes('notion.so'), `${capture.name} workspace URL must not show Notion's domain: ${JSON.stringify(metrics)}`);
  if (metrics.section === 'workspace') {
    assert(metrics.urlPrefixText.endsWith('/workspace/'), `${capture.name} workspace URL should point at the app workspace route: ${JSON.stringify(metrics)}`);
  }
  assert(metrics.titleFontSize >= 14 && metrics.titleFontSize <= 17, `${capture.name} section title should stay compact, got ${metrics.titleFontSize}px`);
  assert(metrics.controlMinHeight === 999 || metrics.controlMinHeight >= 20, `${capture.name} controls are too cramped: ${JSON.stringify(metrics)}`);
  assert(metrics.controlMaxHeight <= 74, `${capture.name} controls are too loose: ${JSON.stringify(metrics)}`);
  if (capture.inviteDraft) {
    assert(metrics.inviteFormVisible, `${capture.name} should show the member add form: ${JSON.stringify(metrics)}`);
    assert(metrics.inviteInputCount >= 1, `${capture.name} should show the member email input: ${JSON.stringify(metrics)}`);
    assert(metrics.inviteEmailValue === capture.draftInviteEmail, `${capture.name} should keep the member email draft visible: ${JSON.stringify(metrics)}`);
    assert(metrics.inviteRoleValue === (capture.inviteRole ?? 'member'), `${capture.name} should preserve the selected member role: ${JSON.stringify(metrics)}`);
    assert(metrics.inviteButtonHeight >= 28 && metrics.inviteButtonHeight <= 40, `${capture.name} Add members button should stay compact: ${JSON.stringify(metrics)}`);
  }
  if (variant.mobile) {
    assert(metrics.dialogWidth >= metrics.viewportWidth - 2 && metrics.dialogWidth <= metrics.viewportWidth + 2, `${capture.name} mobile ${metrics.surface} should fill viewport width: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogHeight >= metrics.viewportHeight - 2 && metrics.dialogHeight <= metrics.viewportHeight + 2, `${capture.name} mobile ${metrics.surface} should fill viewport height: ${JSON.stringify(metrics)}`);
    assert(metrics.navWidth >= metrics.viewportWidth - 2, `${capture.name} mobile ${metrics.surface} should expose the horizontal section nav: ${JSON.stringify(metrics)}`);
    assert(metrics.sectionLeft >= -2 && metrics.sectionLeft <= 2, `${capture.name} mobile section should start at the panel edge: ${JSON.stringify(metrics)}`);
    assert(metrics.sectionRight <= metrics.viewportWidth + 2, `${capture.name} mobile section should stay inside viewport: ${JSON.stringify(metrics)}`);
    return;
  }
  if (capture.activeNavText) {
    assert(
      metrics.activeNavLabels.includes(capture.activeNavText),
      `${capture.name} Settings nav should highlight ${capture.activeNavText}: ${JSON.stringify(metrics)}`,
    );
  }
  if (metrics.surface === 'account-console' || metrics.surface === 'workspace-admin' || metrics.surface === 'server-admin') {
    assert(metrics.dialogWidth >= 900, `${capture.name} ${metrics.surface} console should use the page body width: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogHeight >= metrics.viewportHeight - 4, `${capture.name} ${metrics.surface} console should fill the app height: ${JSON.stringify(metrics)}`);
    assert(metrics.dialogTop <= 2, `${capture.name} ${metrics.surface} console should start at the content top: ${JSON.stringify(metrics)}`);
    assert(metrics.navWidth >= 220 && metrics.navWidth <= 260, `${capture.name} desktop ${metrics.surface} nav should keep stable width: ${JSON.stringify(metrics)}`);
    assert(metrics.sectionLeft >= metrics.dialogLeft + metrics.navWidth - 2, `${capture.name} ${metrics.surface} section should clear nav rail: ${JSON.stringify(metrics)}`);
    assert(metrics.sectionRight <= metrics.dialogLeft + metrics.dialogWidth + 2, `${capture.name} ${metrics.surface} section content should stay inside page: ${JSON.stringify(metrics)}`);
    return;
  }
  assert(metrics.dialogWidth >= 860 && metrics.dialogWidth <= 920, `${capture.name} Settings should remain 900px-class: ${JSON.stringify(metrics)}`);
  assert(metrics.dialogHeight >= 580 && metrics.dialogHeight <= 640, `${capture.name} Settings should remain modal height: ${JSON.stringify(metrics)}`);
  assert(metrics.navWidth >= 220 && metrics.navWidth <= 260, `${capture.name} desktop Settings nav should keep stable width: ${JSON.stringify(metrics)}`);
  assert(metrics.sectionLeft >= metrics.dialogLeft + metrics.navWidth - 2, `${capture.name} section should clear nav rail: ${JSON.stringify(metrics)}`);
  assert(metrics.sectionRight <= metrics.dialogLeft + metrics.dialogWidth + 2, `${capture.name} section content should stay inside dialog: ${JSON.stringify(metrics)}`);
}

async function seedWorkspaceSettings(baseUrl) {
  const suffix = Date.now();
  const email = `settings-visual-${suffix}@example.com`;
  const password = `SettingsVisual${suffix}!aA1`;
  const displayName = `Settings Visual ${suffix}`;
  const owner = await signUpWithPassword(baseUrl, email, password, displayName);
  const bootstrap = await callFunction(baseUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  const organizationId = bootstrap?.organization?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for workspace settings visual smoke');
  assert(organizationId, 'workspace-bootstrap must return an organization id for workspace settings visual smoke');

  // Promote the seed owner to instance admin (via the dev master account) so the
  // server-admin console captures render with real data (the console is gated to
  // instance admins).
  const master = masterCredentials();
  const masterSignin = await fetch(resolveUrl(baseUrl, '/api/auth/signin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: master.email, password: master.password }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const masterBody = await readJson(masterSignin);
  assert(masterSignin.ok && masterBody?.accessToken, `master sign-in failed: HTTP ${masterSignin.status}`);
  await callFunction(baseUrl, masterBody.accessToken, 'instance-admin', {
    action: 'setInstanceAdmin',
    userId: owner.userId,
    enabled: true,
  });

  // Draft email typed into the (non-admin) member-add form for the panel capture.
  const draftInviteEmail = `settings-draft-${suffix}@example.com`;

  const groupName = `Visual Admins ${String(suffix).slice(-6)}`;
  await callFunction(baseUrl, owner.accessToken, 'workspace-mutation', {
    action: 'createOrganizationGroup',
    organizationId,
    name: groupName,
  });

  const domain = `settings-visual-${suffix}.example.com`;
  const addedDomain = await callFunction(baseUrl, owner.accessToken, 'workspace-mutation', {
    action: 'addOrganizationDomain',
    organizationId,
    domain,
  });
  const organizationDomain = addedDomain?.organizationDomains?.find((item) => item.domain === domain);
  if (organizationDomain?.id) {
    await callFunction(baseUrl, owner.accessToken, 'workspace-mutation', {
      action: 'verifyOrganizationDomain',
      organizationId,
      organizationDomainId: organizationDomain.id,
    });
  }
  await callFunction(baseUrl, owner.accessToken, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    storageLimitBytes: 256 * 1024 * 1024,
    sharingPolicy: {
      publicWebSharing: true,
      externalEmailSharing: true,
      guestAccess: true,
      fileDownloads: true,
      fullAccessGrants: true,
    },
  });

  return {
    accessToken: owner.accessToken,
    refreshToken: owner.refreshToken,
    workspaceId,
    organizationId,
    draftInviteEmail,
    groupName,
    domain,
    email,
    password,
    userId: owner.userId,
  };
}

async function cleanupSeed(baseUrl, seed) {
  const failures = [];
  try {
    if (seed?.accessToken) {
      const list = await callFunction(baseUrl, seed.accessToken, 'workspace-mutation', { action: 'list' });
      for (const workspace of Array.isArray(list?.workspaces) ? list.workspaces : []) {
        if (workspace?.id && workspace?.name) {
          await deleteSmokeWorkspace(baseUrl, seed.accessToken, workspace, { call: callFunction });
        }
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    if (seed?.userId) {
      const adminToken = await signInSmokeAdmin(baseUrl, { timeoutMs: options.timeoutMs });
      await deleteSmokeUser(baseUrl, adminToken, seed.userId, { call: callFunction });
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Workspace settings smoke did not fully clean up its synthetic account.');
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function seedSession(context, seed, theme = 'light') {
  // Each browser context needs its OWN fresh session. The app rotates the
  // refresh token on first use, which revokes a token replayed into a later
  // context — so reusing seed.refreshToken across variants drops every context
  // after the first back to the sign-in screen. Re-authenticate the seed per
  // context to get an independent, un-rotated refresh token.
  let refreshToken = seed.refreshToken;
  try {
    const signin = await fetch(resolveUrl(normalizeBaseUrl(options.apiUrl ?? options.url), '/api/auth/signin'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: seed.email, password: seed.password }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const body = await readJson(signin);
    if (signin.ok && typeof body?.refreshToken === 'string' && body.refreshToken) {
      refreshToken = body.refreshToken;
    }
  } catch {
    // Fall back to the seed token; a stale token still surfaces as a clear
    // auth-gate failure rather than masking the problem.
  }
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId, theme }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', theme);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
}

async function signUpWithPassword(baseUrl, email, password, displayName) {
  const response = await fetch(resolveUrl(baseUrl, '/api/auth/signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      email,
      password,
      data: displayName ? { displayName } : undefined,
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `password signup returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert(typeof body?.accessToken === 'string' && body.accessToken, 'password signup must return an access token');
  assert(typeof body?.refreshToken === 'string' && body.refreshToken, 'password signup must return a refresh token');
  assert(typeof body?.user?.id === 'string' && body.user.id, 'password signup must return a user id');
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

  throw new Error('Playwright is required for workspace settings visual smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.');
}

function edgeBasePlaywrightCandidates() {
  const edgebaseRoot = process.env.EDGEBASE_ROOT ?? new URL('../../edgebase', import.meta.url).pathname;
  const direct = join(edgebaseRoot, 'node_modules', 'playwright');
  const pnpmCandidates = [];
  const pnpmDir = join(edgebaseRoot, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const name of readdirSync(pnpmDir)) {
      if (name.startsWith('playwright@')) {
        pnpmCandidates.push(join(pnpmDir, name, 'node_modules', 'playwright'));
      }
    }
  }
  const packageCandidates = [];
  const packagesDir = join(edgebaseRoot, 'packages');
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir)) {
      packageCandidates.push(join(packagesDir, name, 'node_modules', 'playwright'));
    }
  }
  return [direct, ...pnpmCandidates, ...packageCandidates];
}

function resolveChromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  return undefined;
}

function parseArgs(args) {
  const parsed = {
    apiUrl: process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
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
  console.log(`Usage: node scripts/workspace-settings-visual-smoke.mjs [options]

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
