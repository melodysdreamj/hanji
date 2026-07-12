#!/usr/bin/env node
// Regenerates the README "Notion → Hanji" hero screenshots from the live app
// (screenshot-as-code: rerun after visual changes to keep the README honest).
//   assets/screenshots/import-from-notion.png  — ImportDialog on the Notion tab
//   assets/screenshots/workspace.png           — the destination workspace
// Requires the local dev runtime (npm --prefix backend run dev:refresh).
import { mkdirSync } from 'node:fs';
import {
  assert,
  assertRuntimeReachable,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  masterCredentials,
} from './lib/harness.mjs';

const BASE = normalizeBaseUrl(process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787');
const { email: MASTER_EMAIL, password: MASTER_PASSWORD } = masterCredentials();
const OUT_DIR = new URL('../assets/screenshots/', import.meta.url).pathname;
const TIMEOUT_MS = 30_000;

async function api(path, body, token) {
  const response = await fetch(resolveUrl(BASE, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function main() {
  await assertRuntimeReachable(BASE);
  mkdirSync(OUT_DIR, { recursive: true });
  const signin = await api('/api/auth/signin', { email: MASTER_EMAIL, password: MASTER_PASSWORD });
  const token = signin.json.accessToken ?? signin.json.session?.accessToken;
  assert(token, 'master signin failed — start the dev runtime with the dev master env');

  // Fresh demo workspace with the starter pages (they carry the welcome copy).
  const suffix = Date.now();
  const ws = await api(
    '/api/functions/workspace-mutation',
    { action: 'createWorkspace', name: 'Hanji', domain: `readme-hero-${suffix}` },
    token,
  );
  const workspaceId = ws.json.workspace?.id;
  const slug = ws.json.workspace?.domain;
  assert(workspaceId && slug, 'demo workspace creation failed');

  const { chromium } = await loadPlaywright({ label: 'readme hero capture' });
  const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
  try {
    const { context, page } = await newCheckedPage(browser, {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('hanji:theme', 'light');
    });
    await page.goto(resolveUrl(BASE, `/workspace/${encodeURIComponent(slug)}`), {
      waitUntil: 'domcontentloaded',
    });
    const passwordField = page.getByLabel('Password', { exact: true }).first();
    const formShown = await passwordField
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (formShown) {
      await page.getByRole('textbox', { name: 'Email' }).fill(MASTER_EMAIL);
      await passwordField.fill(MASTER_PASSWORD);
      await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: TIMEOUT_MS });
    }
    await page.locator('button[aria-label="Open workspace menu"]').waitFor({
      state: 'visible',
      timeout: TIMEOUT_MS,
    });
    // Open the welcome starter page for a populated destination shot.
    await page.getByText('환영합니다', { exact: false }).first().click({ timeout: TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: `${OUT_DIR}workspace.png` });
    console.log(`saved ${OUT_DIR}workspace.png`);

    // Import dialog on the Notion tab — the migration story.
    await page.locator('button[aria-label="Open workspace menu"]').click({ timeout: TIMEOUT_MS });
    await page.getByRole('menuitem', { name: /^Import|가져오기/ }).click({ timeout: TIMEOUT_MS });
    const dialog = page.getByRole('dialog').filter({ hasText: /Import|가져오기/ }).first();
    await dialog.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT_DIR}import-from-notion.png` });
    console.log(`saved ${OUT_DIR}import-from-notion.png`);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await api('/api/functions/workspace-mutation', { action: 'deleteWorkspace', workspaceId }, token).catch(() => {});
  }
  console.log('PASS README hero screenshots regenerated.');
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL readme hero capture: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
