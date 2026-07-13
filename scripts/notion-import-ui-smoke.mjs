#!/usr/bin/env node

import { createServer } from 'node:http';
import {
  browserAuthStorageKeys,
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  finalizeRegisteredSmokeAccounts,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  postFunction,
  readJson,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_API_URL = process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL;
const DEFAULT_MOCK_NOTION_API_BASE = process.env.HANJI_MOCK_NOTION_API_BASE ?? 'http://127.0.0.1:9797/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL Notion import UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime with HANJI_NOTION_API_BASE pointing at the mock API base.');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('Notion import UI smoke');
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  const mockNotionApiBase = normalizeBaseUrl(options.mockNotionApiBase);
  console.log(`Notion import UI smoke target: ${appUrl}`);
  if (apiUrl !== appUrl) console.log(`Notion import UI smoke API: ${apiUrl}`);
  console.log(`Mock Notion API target: ${mockNotionApiBase}`);

  const mockNotionApi = await startMockNotionApi(mockNotionApiBase);
  try {
    await assertRuntimeReachable(apiUrl);
    const seed = await seedImportJob(apiUrl);
    const { chromium } = await loadPlaywright();
    const executablePath = resolveChromeExecutable();
    const browser = await chromium.launch({
      headless: !options.headed,
      ...(executablePath ? { executablePath } : {}),
    });

    try {
      await assertNotionImportUi(browser, appUrl, apiUrl, seed);
      console.log('PASS Notion import wizard walks connect → scope → discover → apply with a live activity feed, reviews, and checks stored connections when available without screenshots.');
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    await mockNotionApi.close().catch(() => {});
  }
}

async function assertNotionImportUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open app', () => openApp(page, appUrl));
    await step('open Notion import tab', () => openNotionImportTab(page));
    if (options.resumeOnly) {
      await step('resume a reloaded one-time-token job only after token re-entry', () => (
        assertManualTokenReloadResume(page, apiUrl, seed)
      ));
      const storedConnectionChecked = await step(
        'reload-resume a stored Notion connection automatically',
        () => assertStoredConnectionReloadResume(page, apiUrl, seed),
      );
      assertNoBrowserErrors(
        filterExpectedBrowserErrors(errors, { storedConnectionChecked }),
        'Notion import resume UI flow',
      );
      return;
    }
    await step('show Notion token setup guidance', () => assertTokenSetupGuidanceUi(page));
    await step('scan accessible Notion roots from UI', () => assertRootScanUi(page));
    await step('discover and apply import through the wizard', async () => {
      // Wizard flow: token on step 1 → Next → Start discovery on step 2 →
      // run panel (step 3) with the installer-style live feed → Apply from the
      // footer → apply run panel (step 4) → completed.
      const dialog = page.getByRole('dialog', { name: 'Import' });
      await gotoWizardStep(dialog, 1);
      await openManualTokenDetails(dialog);
      await dialog.getByLabel('Notion API token').fill('ntn_mock-notion-token', { timeout: options.timeoutMs });
      await dialog.getByRole('button', { name: 'Next', exact: true }).click({ timeout: options.timeoutMs });
      // Entire-workspace scope is selected at the end of the root-scan step.
      await dialog.getByRole('button', { name: 'Start discovery', exact: true }).click({ timeout: options.timeoutMs });
      // Inline discovery against the mock finishes to a Ready job with items,
      // and the wizard auto-advances to the discover run panel.
      await dialog.locator('[data-run-panel="discover"]').waitFor({ state: 'visible', timeout: options.timeoutMs });
      await expectRunStatus(page, 'Ready');
      // The installer-style live feed carries the discovery activity ring.
      await dialog.locator('[aria-label="Live activity"]').getByText(/Search finished|Reading page/).first().waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await dialog.getByRole('button', { name: 'Review', exact: true }).click({ timeout: options.timeoutMs });
      await page.getByText('Notion import review ready.', { exact: true }).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      // Apply from the wizard footer: advances to the apply run panel and
      // finishes against the mock graph.
      await dialog.getByRole('button', { name: 'Apply import', exact: true }).click({ timeout: options.timeoutMs });
      await dialog.locator('[data-run-panel="apply"]').waitFor({ state: 'visible', timeout: options.timeoutMs });
      await expectRunStatus(page, 'Complete');
      // The live feed now carries apply activity, and the footer resolves to a
      // Done action (workspace-scope imports have no single root page to open).
      await dialog.locator('[aria-label="Live activity"]').getByText(/Created (page|row|database)/).first().waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
      await dialog.getByRole('button', { name: 'Done', exact: true }).waitFor({
        state: 'visible',
        timeout: options.timeoutMs,
      });
    });
    // NOTE: The "reopen must not resurface a finished job in the step-3 Progress
    // panel" behavior is guarded by the component test
    // web/tests/unit/importDialogActiveJob.test.tsx (fresh-mount activeJob
    // derivation), not here — driving a close+reopen through this Playwright flow
    // proved flaky (the reopened dialog intermittently failed to resolve), and a
    // flaky assertion in a CI-gated smoke is worse than a precise unit guard.
    await step('resume a reloaded one-time-token job only after token re-entry', () => (
      assertManualTokenReloadResume(page, apiUrl, seed)
    ));
    const storedConnectionChecked = await step('save, use, and reload-resume a stored Notion connection from UI', () => (
      assertStoredTokenConnectionUi(page, apiUrl, seed)
    ));
    assertNoBrowserErrors(filterExpectedBrowserErrors(errors, { storedConnectionChecked }), 'Notion import UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function openApp(page, baseUrl) {
  await page.goto(resolveUrl(baseUrl, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('button', { name: 'Import' }).last().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function openNotionImportTab(page, { expectTokenInput = true } = {}) {
  await page.getByRole('button', { name: 'Import' }).last().click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Import' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Notion' }).click({ timeout: options.timeoutMs });
  if (expectTokenInput) {
    await dialog.getByLabel('Notion API token').waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  }
}

async function expectRunStatus(page, expected) {
  await page.waitForFunction(
    (expectedText) => {
      const pill = document.querySelector('[data-run-panel] [data-status]');
      return (pill?.textContent ?? '').includes(expectedText);
    },
    expected,
    { timeout: options.timeoutMs },
  ).catch(async (error) => {
    const text = await page.locator('[data-run-panel] [data-status]').first().textContent({ timeout: 1000 }).catch(() => '');
    throw new Error(
      `Expected run panel status to include ${JSON.stringify(expected)}, got ${JSON.stringify((text ?? '').trim())}: ${error.message}`,
    );
  });
}

// Navigate the wizard's step tabs; steps 1-2 are always unlocked, so tests use
// the tabs to hop back (Back also works but tabs are position-independent).
// NOTE: function (not const) — this module runs main() via top-level await
// before later const declarations initialize.
function wizardStepName(step) {
  return { 1: 'Connect', 2: 'Scope', 3: 'Discover', 4: 'Apply' }[step];
}

async function gotoWizardStep(dialog, step) {
  const tab = dialog.getByRole('tab', { name: wizardStepName(step), exact: true });
  if (await tab.getAttribute('aria-selected', { timeout: options.timeoutMs }) === 'true') return;
  await tab.click({ timeout: options.timeoutMs });
}

async function assertStoredTokenConnectionUi(page, apiUrl, seed) {
  const dialog = page.getByRole('dialog', { name: 'Import' });
  const connectionName = `UI stored connection ${Date.now()}`;
  await gotoWizardStep(dialog, 1);
  await openManualTokenDetails(dialog);
  await dialog.getByLabel('Notion API token').fill('ntn_mock-notion-token', { timeout: options.timeoutMs });

  const probe = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
    action: 'listConnections',
    workspaceId: seed.workspaceId,
    limit: 1,
  });
  if (probe.connectionStorageAvailable === false) {
    if (options.expectStoredConnection) {
      throw new Error('Stored Notion connection UI requires HANJI_NOTION_IMPORT_SECRET, but the runtime reports connection storage as unavailable.');
    }
    // Without the storage secret the save-connection affordances must be hidden
    // and replaced by the token-not-stored hint.
    const saveButton = dialog.getByRole('button', { name: 'Save connection' });
    assert(!(await saveButton.isVisible().catch(() => false)), 'Save connection button must be hidden when connection storage is unavailable');
    const nameField = dialog.getByLabel('Connection name');
    assert(!(await nameField.isVisible().catch(() => false)), 'Connection name field must be hidden when connection storage is unavailable');
    await dialog.getByText('never stored on this server').waitFor({ state: 'visible', timeout: options.timeoutMs });
    await dialog.getByLabel('Notion API token').fill('', { timeout: options.timeoutMs });
    console.log('SKIP Notion import UI stored connection smoke because connection storage is unavailable (HANJI_NOTION_IMPORT_SECRET is not configured); verified the save UI stays hidden.');
    return false;
  }

  await dialog.getByLabel('Connection name').fill(connectionName, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Save connection' }).click({ timeout: options.timeoutMs });

  const connection = await waitForSavedConnectionOrMissingSecret(page, apiUrl, seed, connectionName);
  if (!connection) return false;

  const picker = dialog.getByLabel('Saved connection');
  await picker.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await picker.selectOption({ value: connection.id }, { timeout: options.timeoutMs });
  await expectLocatorValue(dialog.getByLabel('Notion API token'), '');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Start discovery' }).click({ timeout: options.timeoutMs });

  const job = await waitForImportJob(apiUrl, seed, (candidate) => (
    candidate.connectionId === connection.id &&
    candidate.status === 'ready' &&
    candidate.options?.credentialSource === 'connection' &&
    candidate.options?.tokenStored === false
  ), 'stored connection discovery job');
  assert(job.report?.credentialSource === 'connection', 'Stored connection discovery report must record the credential source');
  await expectRunStatus(page, 'Ready');

  // Simulate the durable state left behind when the browser or local runtime
  // disappears between chunks: create a deferred job through the product API,
  // then reload the SPA. The remounted dialog must use the job's exact stored
  // connection and drive it to Ready without asking for or retaining a token.
  const deferred = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
    action: 'create',
    workspaceId: seed.workspaceId,
    connectionKind: connection.connectionKind,
    connectionId: connection.id,
    rootNotionPageIds: [],
    rootNotionDataSourceIds: [],
    deferDiscovery: true,
  });
  assert(
    deferred.job?.id && (deferred.job.status === 'queued' || deferred.job.status === 'discovering'),
    'Stored-connection reload fixture must persist an active deferred job',
  );
  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Import' }).last().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await openNotionImportTab(page, { expectTokenInput: false });
  const resumed = await waitForImportJob(apiUrl, seed, (candidate) => (
    candidate.id === deferred.job.id &&
    candidate.status === 'ready' &&
    candidate.connectionId === connection.id &&
    candidate.options?.credentialSource === 'connection' &&
    candidate.options?.tokenStored === false
  ), 'reloaded stored-connection discovery job');
  assert(resumed.report?.credentialSource === 'connection', 'Reloaded discovery must keep the stored connection authority');
  await expectRunStatus(page, 'Ready');

  await gotoWizardStep(dialog, 1);
  await picker.selectOption({ value: connection.id }, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Remove' }).click({ timeout: options.timeoutMs });
  await waitForConnection(apiUrl, seed, (candidate) => (
    candidate.id === connection.id &&
    candidate.status === 'revoked' &&
    candidate.hasStoredCredential === false
  ), 'revoked stored connection');
  await expectSelectNotToHaveValue(picker, connection.id);
  return true;
}

async function assertManualTokenReloadResume(page, apiUrl, seed) {
  // A request-scoped token is intentionally absent from the durable job. A
  // reload must therefore stop at Connect and ask for the original token; it
  // must never guess, persist, or auto-run with an unrelated credential.
  const deferred = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
    action: 'create',
    workspaceId: seed.workspaceId,
    connectionKind: 'manual_token',
    notionToken: 'ntn_mock-notion-token',
    rootNotionPageIds: [],
    rootNotionDataSourceIds: [],
    deferDiscovery: true,
  });
  assert(
    deferred.job?.id &&
      (deferred.job.status === 'queued' || deferred.job.status === 'discovering') &&
      !deferred.job.connectionId &&
      deferred.job.options?.tokenStored === false,
    'Manual-token reload fixture must persist an active job without credential material',
  );

  await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Import' }).last().waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await openNotionImportTab(page);
  const dialog = page.getByRole('dialog', { name: 'Import' });
  await dialog.getByLabel('Notion API token').waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.getByText(
    'Reconnect the saved integration or enter the original Notion token to resume this discovery.',
    { exact: true },
  ).waitFor({ state: 'visible', timeout: options.timeoutMs });

  // Give the automatic stored-connection path enough time to reveal an
  // accidental request. The durable job must still be active and untouched.
  await delay(500);
  const paused = await waitForImportJob(apiUrl, seed, (candidate) => candidate.id === deferred.job.id, 'manual-token paused job');
  assert(
    paused.status === 'queued' || paused.status === 'discovering',
    `Manual-token job unexpectedly advanced without token re-entry: ${paused.status}`,
  );

  await dialog.getByLabel('Notion API token').fill('ntn_mock-notion-token', { timeout: options.timeoutMs });
  // The credential step owns an explicit resume action for this orphaned job;
  // it must not route through Scope and accidentally create a second import.
  await dialog.getByRole('button', { name: 'Resume discovery', exact: true }).click({ timeout: options.timeoutMs });
  const resumed = await waitForImportJob(apiUrl, seed, (candidate) => (
    candidate.id === deferred.job.id &&
    candidate.status === 'ready' &&
    !candidate.connectionId &&
    candidate.options?.credentialSource === 'request' &&
    candidate.options?.tokenStored === false
  ), 'manual-token resumed job');
  assert(resumed.report?.credentialSource === 'request', 'Manual resume must use only the re-entered request token');
  await expectRunStatus(page, 'Ready');
}

async function assertStoredConnectionReloadResume(page, apiUrl, seed) {
  const connectionName = `Reload resume connection ${Date.now()}`;
  const created = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
    action: 'createConnection',
    workspaceId: seed.workspaceId,
    name: connectionName,
    connectionKind: 'internal_integration',
    notionToken: 'ntn_mock-notion-token',
  });
  const connection = created.connection;
  assert(
    connection?.id && connection.hasStoredCredential === true,
    'Stored-connection reload fixture must create encrypted credential metadata',
  );

  try {
    const deferred = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
      action: 'create',
      workspaceId: seed.workspaceId,
      connectionKind: connection.connectionKind,
      connectionId: connection.id,
      rootNotionPageIds: [],
      rootNotionDataSourceIds: [],
      deferDiscovery: true,
    });
    assert(
      deferred.job?.id && (deferred.job.status === 'queued' || deferred.job.status === 'discovering'),
      'Stored-connection reload fixture must persist an active deferred job',
    );

    await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.getByRole('button', { name: 'Import' }).last().waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await openNotionImportTab(page, { expectTokenInput: false });
    const resumed = await waitForImportJob(apiUrl, seed, (candidate) => (
      candidate.id === deferred.job.id &&
      candidate.status === 'ready' &&
      candidate.connectionId === connection.id &&
      candidate.options?.credentialSource === 'connection' &&
      candidate.options?.tokenStored === false
    ), 'reloaded stored-connection discovery job');
    assert(
      resumed.report?.credentialSource === 'connection',
      'Reloaded discovery must keep the exact stored connection authority',
    );
    await expectRunStatus(page, 'Ready');
  } finally {
    await callFunction(apiUrl, seed.accessToken, 'notion-import', {
      action: 'revokeConnection',
      workspaceId: seed.workspaceId,
      connectionId: connection.id,
    }).catch(() => {});
  }

  return true;
}

async function assertTokenSetupGuidanceUi(page) {
  const dialog = page.getByRole('dialog', { name: 'Import' });
  // Scope to the real token-guide card: the animated walkthrough intentionally
  // mirrors this same copy, so match the marked card to avoid a strict-mode
  // collision with the walkthrough's mock intro scene.
  await dialog.locator('[data-token-guide]').getByText('Import with a Notion API token', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  const tokenPage = dialog.getByRole('link', { name: 'Open Notion token page' });
  await tokenPage.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const href = await tokenPage.getAttribute('href');
  assert(href === 'https://www.notion.so/profile/integrations', `Notion token link drifted: ${href}`);
  const tokenInput = dialog.getByLabel('Notion API token');
  await tokenInput.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const placeholder = await tokenInput.getAttribute('placeholder');
  assert(placeholder === 'ntn_...', `Notion token placeholder must only advertise ntn_ tokens, got ${placeholder}`);
  // A legacy secret_ token passes the step-1 gate (any credential text) but is
  // rejected when discovery actually starts on step 2.
  await tokenInput.fill('secret_old-token', { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Next', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Start discovery', exact: true }).click({ timeout: options.timeoutMs });
  await page.getByText('Use a Notion API token that starts with ntn_.', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await gotoWizardStep(dialog, 1);
  await tokenInput.fill('', { timeout: options.timeoutMs });
  await dialog.getByText('Before importing', { exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByText('Use a current Notion API token that starts with ntn_.', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText(/Share or Connections/).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await expectLocatorValue(tokenInput, '');

  // The animated token walkthrough is ALWAYS SHOWN and AUTO-PLAYING on the
  // Notion tab (no collapse toggle). Pause it, step until scene 1 is showing
  // (autoplay may have advanced past it), then assert scene 2 via Next.
  const walkthrough = dialog.getByRole('region', { name: 'Notion token walkthrough' });
  await walkthrough.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await walkthrough.getByRole('button', { name: 'Pause' }).click({ timeout: options.timeoutMs });
  const sceneOne = walkthrough.getByText('1. Open the token page from Hanji', { exact: true });
  for (let hop = 0; hop < 7; hop += 1) {
    if (await sceneOne.isVisible().catch(() => false)) break;
    await walkthrough.getByRole('button', { name: 'Next step' }).click({ timeout: options.timeoutMs });
  }
  await sceneOne.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await walkthrough.getByRole('button', { name: 'Next step' }).click({ timeout: options.timeoutMs });
  await walkthrough.getByText('2. Create a connection', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  return true;
}

async function assertRootScanUi(page) {
  const dialog = page.getByRole('dialog', { name: 'Import' });
  await gotoWizardStep(dialog, 1);
  const tokenInput = dialog.getByLabel('Notion API token');
  await tokenInput.fill('ntn_mock-notion-token', { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Next', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByLabel('Specific pages').check({ timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Scan accessible roots' }).click({ timeout: options.timeoutMs });
  // Do not require one exact transient progress frame: a fast runtime can
  // commit both mock search pages between browser paints. The settled candidate
  // and aggregate assertions below prove the same scan without a timing race.
  try {
    await dialog.getByText('Mock first page', { exact: true }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
  } catch (error) {
    const dialogText = await dialog.textContent({ timeout: 1000 }).catch(() => '');
    throw new Error(
      `Root scan did not return the mock candidate. Dialog: ${JSON.stringify((dialogText ?? '').slice(0, 1200))}. ${error.message}`,
    );
  }
  await dialog.getByText('Mock shared database', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  const childVisible = await dialog.getByText('Mock child page', { exact: true }).isVisible().catch(() => false);
  assert(!childVisible, 'Root scan should not show children whose accessible parent is already listed.');
  await dialog.getByText('2 root candidates · 3 items checked · Notion workspace: Mock Notion Workspace', { exact: true }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await dialog.getByText('2 of 2 selected', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });

  // Toggling a scanned candidate must not crash. Regression guard: the checkbox
  // onChange read `event.currentTarget.checked` inside the setState updater,
  // which React runs after nulling currentTarget — it threw during render and,
  // since the dialog mounts outside the route ErrorBoundary, unmounted the whole
  // app to a blank white screen. Unchecking one candidate must simply update the
  // count and leave the dialog standing.
  const rootPicker = dialog.getByRole('group', { name: 'Accessible top-level items' });
  await rootPicker.locator('label').filter({ hasText: 'Mock first page' }).getByRole('checkbox')
    .uncheck({ timeout: options.timeoutMs });
  await dialog.getByText('1 of 2 selected', { exact: true }).waitFor({ state: 'visible', timeout: options.timeoutMs });
  // Dialog still mounted == no blank-screen crash.
  await dialog.getByRole('button', { name: 'Scan accessible roots' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  // An empty scan must explain that the token is fine but nothing is shared,
  // name the token's Notion workspace, and walk through the Connections steps.
  // The token field lives on wizard step 1; hop back to swap credentials.
  await gotoWizardStep(dialog, 1);
  await tokenInput.fill('ntn_mock-empty-token', { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Next', exact: true }).click({ timeout: options.timeoutMs });
  await dialog.getByLabel('Specific pages').check({ timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Scan accessible roots' }).click({ timeout: options.timeoutMs });
  await dialog.getByText(
    'The token works and is connected to the Notion workspace “Mock Notion Workspace” — but no pages are shared with this integration yet.',
    { exact: true },
  ).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByText(/Connections → add this integration/).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByText(/a Notion workspace other than “Mock Notion Workspace”/).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });

  await dialog.getByLabel('Entire workspace').check({ timeout: options.timeoutMs });
  await gotoWizardStep(dialog, 1);
  await tokenInput.fill('', { timeout: options.timeoutMs });
  return true;
}

async function openManualTokenDetails(dialog) {
  const tokenInput = dialog.getByLabel('Notion API token');
  if (await tokenInput.isVisible().catch(() => false)) return;
  const details = dialog.locator('details').filter({ hasText: 'Notion API token' }).first();
  await details.locator('summary').click({ timeout: options.timeoutMs });
  await tokenInput.waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function waitForSavedConnectionOrMissingSecret(page, apiUrl, seed, connectionName) {
  const deadline = Date.now() + options.timeoutMs;
  let lastMessage = '';
  while (Date.now() < deadline) {
    const listed = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
      action: 'listConnections',
      workspaceId: seed.workspaceId,
      limit: 100,
    });
    const connection = (listed.connections ?? []).find((candidate) => (
      candidate.name === connectionName &&
      candidate.status === 'active' &&
      candidate.hasStoredCredential === true &&
      !Object.prototype.hasOwnProperty.call(candidate, 'credentialCiphertext')
    ));
    if (connection) return connection;

    const bodyText = await page.locator('body').textContent({ timeout: 1000 }).catch(() => '');
    if (bodyText?.includes('HANJI_NOTION_IMPORT_SECRET')) {
      if (options.expectStoredConnection) {
        throw new Error('Stored Notion connection UI requires HANJI_NOTION_IMPORT_SECRET, but the runtime rejected the save.');
      }
      console.log('SKIP Notion import UI stored connection smoke because HANJI_NOTION_IMPORT_SECRET is not configured.');
      return null;
    }

    lastMessage = bodyText?.slice(0, 200) ?? '';
    await delay(250);
  }
  throw new Error(`Stored Notion connection did not appear in connection metadata. Last page text: ${lastMessage}`);
}

async function waitForConnection(apiUrl, seed, predicate, label) {
  const deadline = Date.now() + options.timeoutMs;
  let lastConnections = [];
  while (Date.now() < deadline) {
    const listed = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
      action: 'listConnections',
      workspaceId: seed.workspaceId,
      limit: 100,
    });
    lastConnections = listed.connections ?? [];
    const match = lastConnections.find(predicate);
    if (match) return match;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}. Last connections: ${JSON.stringify(lastConnections)}`);
}

async function waitForImportJob(apiUrl, seed, predicate, label) {
  const deadline = Date.now() + options.timeoutMs;
  let lastJobs = [];
  while (Date.now() < deadline) {
    const listed = await callFunction(apiUrl, seed.accessToken, 'notion-import', {
      action: 'list',
      workspaceId: seed.workspaceId,
      limit: 20,
    });
    lastJobs = listed.jobs ?? [];
    const match = lastJobs.find(predicate);
    if (match) return match;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}. Last jobs: ${JSON.stringify(lastJobs)}`);
}

async function expectLocatorValue(locator, expected) {
  const deadline = Date.now() + options.timeoutMs;
  let actual = '';
  while (Date.now() < deadline) {
    actual = await locator.inputValue({ timeout: 1000 }).catch(() => '');
    if (actual === expected) return;
    await delay(100);
  }
  throw new Error(`Expected input value ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function expectSelectNotToHaveValue(locator, unwantedValue) {
  const deadline = Date.now() + options.timeoutMs;
  let values = [];
  while (Date.now() < deadline) {
    values = await locator.evaluate((select) => (
      Array.from(select.options).map((option) => option.value)
    )).catch(() => []);
    if (!values.includes(unwantedValue)) return;
    await delay(100);
  }
  throw new Error(`Expected select not to include ${JSON.stringify(unwantedValue)}, got ${JSON.stringify(values)}`);
}

async function seedImportJob(baseUrl) {
  // No pre-seeded job: the recent-jobs history list was removed, so the import
  // is driven entirely through the dialog (Start discovery → step-3 Progress
  // panel). We only need an authenticated session + workspace here.
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for Notion import UI smoke');
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
  };
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function startMockNotionApi(apiBase) {
  const base = new URL(apiBase);
  if (!base.port) {
    throw new Error('--mock-notion-api-base must include an explicit localhost port');
  }
  const prefix = base.pathname.replace(/\/+$/, '') || '/v1';
  const server = createServer((request, response) => {
    handleMockNotionRequest(request, response, prefix).catch((error) => {
      writeJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(Number(base.port), base.hostname, () => {
      server.off('error', reject);
      resolveServer();
    });
  });
  return {
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    }),
  };
}

async function handleMockNotionRequest(request, response, prefix) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith(prefix)) {
    writeJson(response, 404, { message: 'Mock Notion path was not found.' });
    return;
  }
  const route = url.pathname.slice(prefix.length) || '/';

  if (request.method === 'GET' && route === '/users/me') {
    writeJson(response, 200, {
      object: 'user',
      id: 'mock-bot',
      type: 'bot',
      bot: {
        workspace_id: 'mock-notion-workspace',
        workspace_name: 'Mock Notion Workspace',
      },
    });
    return;
  }

  if (request.method === 'POST' && route === '/search') {
    const body = await readRequestJson(request);
    if (request.headers.authorization === 'Bearer ntn_mock-empty-token') {
      writeJson(response, 200, {
        object: 'list',
        results: [],
        has_more: false,
        next_cursor: null,
      });
      return;
    }
    if (body.sort) {
      if (body.start_cursor === 'root-cursor-second') {
        await delay(500);
        writeJson(response, 200, {
          object: 'list',
          results: [
            mockNotionPage('mock-child-page', 'Mock child page', { type: 'page_id', page_id: 'mock-page-first' }),
            mockNotionDataSource('mock-data-source', 'Mock shared database', { type: 'page_id', page_id: 'not-shared-parent' }),
          ],
          has_more: false,
          next_cursor: null,
        });
        return;
      }
      writeJson(response, 200, {
        object: 'list',
        results: [
          mockNotionPage('mock-page-first', 'Mock first page'),
        ],
        has_more: true,
        next_cursor: 'root-cursor-second',
      });
      return;
    }
    if (body.start_cursor === 'cursor-second') {
      writeJson(response, 200, {
        object: 'list',
        results: [mockNotionPage('mock-page-second', 'Mock second page')],
        has_more: false,
        next_cursor: null,
      });
      return;
    }
    writeJson(response, 200, {
      object: 'list',
      results: [mockNotionPage('mock-page-first', 'Mock first page')],
      has_more: true,
      next_cursor: 'cursor-second',
    });
    return;
  }

  const pageMatch = /^\/pages\/([^/]+)$/.exec(route);
  if (request.method === 'GET' && pageMatch) {
    const pageId = decodeURIComponent(pageMatch[1]);
    writeJson(response, 200, mockNotionPage(pageId, pageId === 'mock-page-second' ? 'Mock second page' : 'Mock first page'));
    return;
  }

  if (request.method === 'GET' && /^\/blocks\/[^/]+\/children$/.test(route)) {
    writeJson(response, 200, {
      object: 'list',
      results: [],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  const markdownMatch = /^\/pages\/([^/]+)\/markdown$/.exec(route);
  if (request.method === 'GET' && markdownMatch) {
    writeJson(response, 200, {
      markdown: `# ${decodeURIComponent(markdownMatch[1])}`,
      truncated: false,
      unknown_block_ids: [],
    });
    return;
  }

  writeJson(response, 404, { message: `Mock Notion route not implemented: ${request.method} ${route}` });
}

function mockNotionPage(id, title, parent = { type: 'workspace', workspace: true }) {
  return {
    object: 'page',
    id,
    title: [{ plain_text: title }],
    parent,
    archived: false,
    in_trash: false,
    created_time: '2026-03-11T00:00:00.000Z',
    last_edited_time: '2026-03-11T00:00:00.000Z',
  };
}

function mockNotionDataSource(id, title, parent = { type: 'workspace', workspace: true }) {
  return {
    object: 'data_source',
    id,
    title: [{ plain_text: title }],
    parent,
    archived: false,
    in_trash: false,
    created_time: '2026-03-11T00:00:00.000Z',
    last_edited_time: '2026-03-11T00:00:00.000Z',
  };
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function writeJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function filterExpectedBrowserErrors(errors, { storedConnectionChecked }) {
  return errors.filter((error) => {
    if (
      storedConnectionChecked === false &&
      error.includes('Failed to load resource') &&
      error.includes('status of 400')
    ) {
      return false;
    }
    return true;
  });
}

async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

function parseArgs(args) {
  const parsed = {
    apiUrl: DEFAULT_API_URL,
    expectStoredConnection: process.env.HANJI_EXPECT_STORED_NOTION_CONNECTION === '1',
    headed: false,
    mockNotionApiBase: DEFAULT_MOCK_NOTION_API_BASE,
    resumeOnly: false,
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
    if (arg === '--expect-stored-connection') {
      parsed.expectStoredConnection = true;
      continue;
    }
    if (arg === '--mock-notion-api-base') {
      parsed.mockNotionApiBase = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--resume-only') {
      parsed.resumeOnly = true;
      continue;
    }
    if (arg === '--api-url') {
      parsed.apiUrl = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/notion-import-ui-smoke.mjs [options]

Checks Notion import UI discovery state, open-panel job refresh, expansion, and
review controls through DOM and product API assertions only.

Start EdgeBase with HANJI_NOTION_API_BASE set to the same mock API base.

Options:
  --url <url>                     App URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>                 EdgeBase API URL. Defaults to HANJI_EDGEBASE_API_URL or ${DEFAULT_API_URL}.
  --mock-notion-api-base <url>    Mock Notion API base. Defaults to ${DEFAULT_MOCK_NOTION_API_BASE}.
  --resume-only                   Run only persisted-job reload/resume checks.
  --timeout-ms <number>           Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --expect-stored-connection      Fail if encrypted stored Notion connections are not configured.
  --headed                        Show the browser while running.
`);
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
