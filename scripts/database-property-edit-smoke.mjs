#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  finalizeRegisteredSmokeAccounts,
  installBrowserSession,
  permanentlyDeletePage,
  signIn as signInForSmoke,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database property edit smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('database property edit smoke');
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database property edit smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const seed = await seedDatabase(baseUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertPropertyEditing(browser, baseUrl, seed);
    console.log('PASS database table property edits persist for title, rich text, checkbox, date, select, multi-select, number, URL, email, phone, relation multi-select reciprocal add/remove, and files link/upload/open/download/delete cells without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertPropertyEditing(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await openDatabase(page, baseUrl, seed);
    await step('edit title', () => editTextCell(page, 0, 0, seed.editedTitle));
    await step('edit rich text', () => editTextCell(page, 0, 1, seed.editedNotes));
    await step('edit checkbox', () => checkCell(page, 0, 2));
    await step('edit date', () => editDateCell(page, 0, 3, seed.editedDateInput, seed.editedDateExpectation));
    await step('edit select', () => editSelectCell(page, 0, 4, 'Doing'));
    await step('edit number', () => editButtonBackedTextCell(page, 0, 5, 'Edit Score', seed.editedScoreInput, seed.editedScoreDisplay));
    await step('edit URL', () => editButtonBackedTextCell(page, 0, 6, 'Edit Website', seed.editedWebsite));
    await step('edit email', () => editButtonBackedTextCell(page, 0, 7, 'Edit Contact email', seed.editedEmail));
    await step('edit phone', () => editButtonBackedTextCell(page, 0, 8, 'Edit Phone', seed.editedPhone));
    await step('edit multi-select', () => editMultiSelectCell(page, 0, 9, ['Design', 'Ops']));
    await step('edit reciprocal relation', () => editRelationCell(page, 0, 10, seed.targetRowTitle, seed.secondTargetRowTitle));
    await step('edit files', () => editFilesCell(page, 0, 11, seed));
    await step('open signed files', () => assertFileOpenLinks(page, 0, 11, seed));
    await step('verify edited DOM values', () => assertEditedValues(page, seed));

    await page.waitForTimeout(900);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.getByRole('tab', { name: 'Table' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    await step('verify values after reload', () => assertEditedValues(page, seed));
    await step('verify signed files after reload', () => assertFileOpenLinks(page, 0, 11, seed));
    await step('verify authoritative row after reload', () => assertPersistedRow(baseUrl, seed));
    assertNoBrowserErrors(errors, 'database property edit UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function step(label, operation) {
  try {
    await operation();
    console.log(`  PASS ${label}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${detail}`, { cause: error });
  }
}

async function openDatabase(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/database/${seed.databaseId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('tab', { name: 'Table' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectCellInputValue(page, 0, 0, seed.initialTitle);
  const path = new URL(page.url()).pathname;
  assert(path === `/database/${seed.databaseId}`, `direct database route changed to ${path}`);
}

async function editTextCell(page, rowIndex, colIndex, value) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const input = target.locator('input[type="text"]').first();
  await input.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await input.fill(value, { timeout: options.timeoutMs });
  await input.press('Enter', { timeout: options.timeoutMs });
  await expectCellInputValue(page, rowIndex, colIndex, value);
}

async function editButtonBackedTextCell(page, rowIndex, colIndex, buttonName, value, expectedText = value) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await target.getByRole('button', { name: buttonName }).click({ timeout: options.timeoutMs });
  const input = target.locator('input[type="text"]').first();
  await input.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await input.fill(value, { timeout: options.timeoutMs });
  await input.press('Enter', { timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, expectedText);
}

async function checkCell(page, rowIndex, colIndex) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  const input = target.locator('input[type="checkbox"]').first();
  await input.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await input.check({ timeout: options.timeoutMs });
  await expectCellCheckboxChecked(page, rowIndex, colIndex, true);
}

async function editDateCell(page, rowIndex, colIndex, inputValue, expectedText) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  // The accessible label includes the property name (for example
  // "Edit Due date"), and includes the current value once populated.
  await target.getByRole('button', { name: /^Edit (?:date|.+ date(?:,|$))/ }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Edit date property' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const input = dialog.locator('input[placeholder="Date"]').first();
  await input.fill(inputValue, { timeout: options.timeoutMs });
  await input.press('Enter', { timeout: options.timeoutMs });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, expectedText);
}

async function editSelectCell(page, rowIndex, colIndex, optionName) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await target.getByRole('button', { name: 'Edit Status select' }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Edit select property' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('option', { name: optionName }).click({ timeout: options.timeoutMs });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, optionName);
}

async function editMultiSelectCell(page, rowIndex, colIndex, optionNames) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await target.getByRole('button', { name: 'Edit Tags multi-select' }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Edit multi-select property' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  for (const optionName of optionNames) {
    await dialog.getByRole('option', { name: optionName }).click({ timeout: options.timeoutMs });
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  for (const optionName of optionNames) {
    await expectCellText(page, rowIndex, colIndex, optionName);
  }
}

async function editRelationCell(page, rowIndex, colIndex, firstRelatedTitle, secondRelatedTitle) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await target.getByRole('button', { name: 'Edit Related relation' }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Edit relation property' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('option', { name: firstRelatedTitle, exact: true }).click({ timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, firstRelatedTitle);
  await dialog.getByRole('option', { name: secondRelatedTitle, exact: true }).click({ timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, firstRelatedTitle);
  await expectCellText(page, rowIndex, colIndex, secondRelatedTitle);
  await dialog.getByRole('option', { name: firstRelatedTitle, exact: true }).click({ timeout: options.timeoutMs });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, secondRelatedTitle);
  await expectCellNotText(page, rowIndex, colIndex, firstRelatedTitle);
}

async function editFilesCell(page, rowIndex, colIndex, seed) {
  const target = cell(page, rowIndex, colIndex);
  await target.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
  await target.getByRole('button', { name: 'Edit Attachments files' }).click({
    timeout: options.timeoutMs,
  });
  const dialog = page.getByRole('dialog', { name: 'Edit files property' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Add file or image' }).click({
    timeout: options.timeoutMs,
  });
  const input = dialog.locator('input[placeholder="Paste a file or image URL"]').first();

  await input.fill(seed.removedFileUrl, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click({ timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, seed.removedFileName);

  await input.fill(seed.editedFileUrl, { timeout: options.timeoutMs });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click({ timeout: options.timeoutMs });
  await expectCellText(page, rowIndex, colIndex, seed.editedFileName);

  await removeFileFromDialog(dialog, seed.removedFileName);
  const fileInput = dialog.locator('input[type="file"]');
  await fileInput.setInputFiles([
    {
      name: seed.uploadedFileName,
      mimeType: seed.uploadedFileType,
      buffer: Buffer.from(seed.uploadedFileText),
    },
    {
      name: seed.deletedUploadFileName,
      mimeType: seed.uploadedFileType,
      buffer: Buffer.from(seed.deletedUploadFileText),
    },
  ]);
  await expectCellText(page, rowIndex, colIndex, seed.uploadedFileName);
  await expectCellText(page, rowIndex, colIndex, seed.deletedUploadFileName);
  await page.getByRole('button', { name: 'Close menu' }).click({ timeout: options.timeoutMs });
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await target.getByRole('button', { name: `Remove ${seed.deletedUploadFileName}` }).click({
    timeout: options.timeoutMs,
  });
  await expectCellText(page, rowIndex, colIndex, seed.editedFileName);
  await expectCellText(page, rowIndex, colIndex, seed.uploadedFileName);
  await expectCellNotText(page, rowIndex, colIndex, seed.removedFileName);
  await expectCellNotText(page, rowIndex, colIndex, seed.deletedUploadFileName);
}

async function removeFileFromDialog(dialog, fileName) {
  await dialog.getByRole('button', { name: `${fileName} file menu` }).click({
    timeout: options.timeoutMs,
  });
  await dialog
    .getByRole('menu', { name: `${fileName} file actions` })
    .getByRole('menuitem', { name: 'Delete' })
    .click({ timeout: options.timeoutMs });
}

async function assertFileOpenLinks(page, rowIndex, colIndex, seed) {
  const linkHref = await waitForFileOpenHref(page, seed.editedFileName);
  assert(
    linkHref === seed.editedFileUrl,
    `external file link should keep its original URL; href=${linkHref}`,
  );

  const uploadedHref = await waitForFileOpenHref(page, seed.uploadedFileName);
  assert(
    isSignedWorkspaceFileUrl(uploadedHref),
    `uploaded file link should resolve to a signed storage URL; href=${uploadedHref}`,
  );

  const target = cell(page, rowIndex, colIndex);
  const uploadedLink = target.getByRole('link', { name: `Open ${seed.uploadedFileName}` });
  const openedPromise = Promise.race([
    page.context().waitForEvent('page', { timeout: options.timeoutMs })
      .then((popup) => ({ kind: 'page', popup })),
    page.waitForEvent('download', { timeout: options.timeoutMs })
      .then((download) => ({ kind: 'download', download })),
  ]).catch(() => null);
  await uploadedLink.click({ timeout: options.timeoutMs });
  const opened = await openedPromise;
  assert(opened, 'clicking an uploaded file chip should open or download the stored file');
  if (opened.kind === 'download') {
    assert(
      isSignedWorkspaceFileUrl(opened.download.url()),
      `uploaded file download should use a signed storage URL; opened=${opened.download.url()}`,
    );
    assert(
      opened.download.suggestedFilename() === seed.uploadedFileName,
      `uploaded file download should preserve its name; got=${opened.download.suggestedFilename()}`,
    );
    return;
  }
  const popup = opened.popup;
  await popup.waitForURL((url) => isSignedWorkspaceFileUrl(url.href), {
    timeout: options.timeoutMs,
  }).catch(() => {});
  const openedUrl = popup.url();
  await popup.close().catch(() => {});
  assert(
    isSignedWorkspaceFileUrl(openedUrl),
    `uploaded file chip click should open a signed storage URL; opened=${openedUrl}`,
  );
}

function isSignedWorkspaceFileUrl(value) {
  try {
    const url = new URL(value);
    // EdgeBase accepts the object key as either path segments or one encoded
    // segment. Decode before checking so the smoke follows both equivalent
    // SDK URL shapes while still requiring a signed workspace-scoped object.
    return decodeURIComponent(url.pathname).includes('/api/storage/files/workspaces/')
      && url.searchParams.has('token');
  } catch {
    return false;
  }
}

async function assertEditedValues(page, seed) {
  await step('DOM title value', () => expectCellInputValue(page, 0, 0, seed.editedTitle));
  await step('DOM rich-text value', () => expectCellInputValue(page, 0, 1, seed.editedNotes));
  await step('DOM checkbox value', () => expectCellCheckboxChecked(page, 0, 2, true));
  await step('DOM date value', () => expectCellText(page, 0, 3, seed.editedDateExpectation));
  await step('DOM select value', () => expectCellText(page, 0, 4, 'Doing'));
  await step('DOM number value', () => expectCellText(page, 0, 5, seed.editedScoreDisplay));
  await step('DOM URL value', () => expectCellText(page, 0, 6, seed.editedWebsite));
  await step('DOM email value', () => expectCellText(page, 0, 7, seed.editedEmail));
  await step('DOM phone value', () => expectCellText(page, 0, 8, seed.editedPhone));
  await step('DOM Design tag', () => expectCellText(page, 0, 9, 'Design'));
  await step('DOM Ops tag', () => expectCellText(page, 0, 9, 'Ops'));
  await step('DOM selected relation', () => expectCellText(page, 0, 10, seed.secondTargetRowTitle));
  await step('DOM removed relation', () => expectCellNotText(page, 0, 10, seed.targetRowTitle));
  await step('DOM linked file', () => expectCellText(page, 0, 11, seed.editedFileName));
  await step('DOM uploaded file', () => expectCellText(page, 0, 11, seed.uploadedFileName));
  await step('DOM removed linked file', () => expectCellNotText(page, 0, 11, seed.removedFileName));
  await step('DOM removed uploaded file', () => expectCellNotText(page, 0, 11, seed.deletedUploadFileName));
}

async function assertPersistedRow(baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'databaseRows',
    databaseId: seed.databaseId,
  });
  const row = result?.rows?.find((item) => item.id === seed.rowId);
  assert(row, 'edited row must be returned by page-query');
  assert(row.title === seed.editedTitle, `persisted title should be ${seed.editedTitle}`);
  assert(row.properties?.[seed.notesPropId] === seed.editedNotes, 'persisted rich text property should match');
  assert(row.properties?.[seed.donePropId] === true, 'persisted checkbox property should be checked');
  assert(row.properties?.[seed.duePropId] === seed.editedDateInput, 'persisted date property should match');
  assert(row.properties?.[seed.statusPropId] === 'doing', 'persisted select property should be Doing');
  assert(row.properties?.[seed.scorePropId] === seed.editedScore, 'persisted number property should match');
  assert(row.properties?.[seed.websitePropId] === seed.editedWebsite, 'persisted URL property should match');
  assert(row.properties?.[seed.emailPropId] === seed.editedEmail, 'persisted email property should match');
  assert(row.properties?.[seed.phonePropId] === seed.editedPhone, 'persisted phone property should match');
  assert(
    Array.isArray(row.properties?.[seed.tagsPropId]) &&
      row.properties[seed.tagsPropId].includes('design') &&
      row.properties[seed.tagsPropId].includes('ops'),
    'persisted multi-select property should include Design and Ops',
  );
  assert(
    Array.isArray(row.properties?.[seed.relatedPropId]) &&
      row.properties[seed.relatedPropId].includes(seed.secondTargetRowId) &&
      !row.properties[seed.relatedPropId].includes(seed.targetRowId),
    'persisted relation property should keep only the selected target row after add/remove',
  );
  const files = row.properties?.[seed.filesPropId];
  assert(Array.isArray(files), 'persisted files property should be an array');
  assert(files.length === 2, 'persisted files property should keep exactly one link and one stored upload');
  assert(
    files.some((file) => file?.url === seed.editedFileUrl && file?.name === seed.editedFileName),
    'persisted files property should keep the added file link',
  );
  const uploadedFile = files.find((file) =>
    file?.name === seed.uploadedFileName &&
    storedFileKey(file).startsWith('workspaces/')
  );
  assert(uploadedFile, `persisted files property should keep the stored upload: ${JSON.stringify(files)}`);
  assert(
    uploadedFile.type === seed.uploadedFileType || uploadedFile.type === undefined,
    `stored upload type should be preserved when available: ${JSON.stringify(uploadedFile)}`,
  );
  assert(
    uploadedFile.size === Buffer.byteLength(seed.uploadedFileText) || uploadedFile.size === undefined,
    `stored upload size should be preserved when available: ${JSON.stringify(uploadedFile)}`,
  );
  assert(
    !files.some((file) => file?.name === seed.removedFileName || file?.name === seed.deletedUploadFileName),
    'persisted files property should not keep removed link or removed upload entries',
  );
  await assertFileUploadState(baseUrl, seed, uploadedFile);
  await assertReciprocalRelationState(baseUrl, seed);
}

async function assertFileUploadState(baseUrl, seed, uploadedFile) {
  const uploadedKey = storedFileKey(uploadedFile);
  const active = await callFunction(baseUrl, seed.accessToken, 'file-mutation', {
    action: 'list',
    pageId: seed.rowId,
    databaseId: seed.databaseId,
    propertyId: seed.filesPropId,
    scope: 'database/files',
  });
  const activeUploads = active?.uploads ?? [];
  assert(
    activeUploads.some((upload) =>
      upload.key === uploadedKey &&
      upload.status === 'uploaded' &&
      upload.name === seed.uploadedFileName
    ),
    'file upload listing should keep the stored database file upload active',
  );
  const signed = await callFunction(baseUrl, seed.accessToken, 'file-mutation', {
    action: 'signedUrl',
    key: uploadedKey,
    expiresIn: '5m',
  });
  assert(signed?.url, 'stored database file upload should return a signed download URL');
  const download = await fetch(signed.url, {
    headers: { Accept: seed.uploadedFileType },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await download.text();
  assert(download.ok, `signed database file download returned HTTP ${download.status}: ${body.slice(0, 200)}`);
  assert(body === seed.uploadedFileText, 'signed database file download should return the uploaded file contents');
  assert(
    !activeUploads.some((upload) => upload.name === seed.deletedUploadFileName),
    'file upload listing should hide the upload removed from the Files property',
  );

  const deleting = await callFunction(baseUrl, seed.accessToken, 'file-mutation', {
    action: 'list',
    pageId: seed.rowId,
    databaseId: seed.databaseId,
    propertyId: seed.filesPropId,
    scope: 'database/files',
    status: 'deleting',
  });
  assert(
    (deleting?.uploads ?? []).some((upload) => upload.name === seed.deletedUploadFileName),
    `file upload listing should expose the removed database file upload in its grace-period deletion state: ${JSON.stringify(deleting?.uploads ?? [])}`,
  );
}

async function assertReciprocalRelationState(baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'databaseRows',
    databaseId: seed.targetDatabaseId,
  });
  const targetRow = result?.rows?.find((item) => item.id === seed.targetRowId);
  const reciprocalIds = Array.isArray(targetRow?.properties?.[seed.targetReciprocalPropId])
    ? targetRow.properties[seed.targetReciprocalPropId]
    : [];
  assert(
    !reciprocalIds.includes(seed.rowId),
    'relation removed through the browser cell should remove the reciprocal relation from the first target row',
  );
  const secondTargetRow = result?.rows?.find((item) => item.id === seed.secondTargetRowId);
  const secondReciprocalIds = Array.isArray(secondTargetRow?.properties?.[seed.targetReciprocalPropId])
    ? secondTargetRow.properties[seed.targetReciprocalPropId]
    : [];
  assert(
    secondReciprocalIds.includes(seed.rowId),
    'relation edited through the browser cell should back-fill the reciprocal relation on the remaining selected target row',
  );
}

function storedFileKey(file) {
  return typeof file?.key === 'string' ? file.key : typeof file?.id === 'string' ? file.id : '';
}

function cell(page, rowIndex, colIndex) {
  return page.locator(`[data-table-cell][data-row-index="${rowIndex}"][data-col-index="${colIndex}"]`);
}

async function expectCellInputValue(page, rowIndex, colIndex, value) {
  await page.waitForFunction(
    ([row, col, expected]) => {
      const input = document.querySelector(
        `[data-table-cell][data-row-index="${row}"][data-col-index="${col}"] input[type="text"]`,
      );
      return input && input.offsetParent !== null && input.value === expected;
    },
    [rowIndex, colIndex, value],
    { timeout: options.timeoutMs },
  );
}

async function expectCellCheckboxChecked(page, rowIndex, colIndex, checked) {
  await page.waitForFunction(
    ([row, col, expected]) => {
      const input = document.querySelector(
        `[data-table-cell][data-row-index="${row}"][data-col-index="${col}"] input[type="checkbox"]`,
      );
      return input && input.offsetParent !== null && input.checked === expected;
    },
    [rowIndex, colIndex, checked],
    { timeout: options.timeoutMs },
  );
}

async function expectCellText(page, rowIndex, colIndex, text) {
  await page.waitForFunction(
    ([row, col, expected]) => {
      const el = document.querySelector(
        `[data-table-cell][data-row-index="${row}"][data-col-index="${col}"]`,
      );
      return Boolean(el && el.offsetParent !== null && el.textContent?.includes(expected));
    },
    [rowIndex, colIndex, text],
    { timeout: options.timeoutMs },
  );
}

async function expectCellNotText(page, rowIndex, colIndex, text) {
  await page.waitForFunction(
    ([row, col, expected]) => {
      const el = document.querySelector(
        `[data-table-cell][data-row-index="${row}"][data-col-index="${col}"]`,
      );
      return Boolean(el && el.offsetParent !== null && !el.textContent?.includes(expected));
    },
    [rowIndex, colIndex, text],
    { timeout: options.timeoutMs },
  );
}

async function waitForFileOpenHref(page, fileName) {
  await page.waitForFunction(
    (name) => {
      const link = Array.from(document.querySelectorAll('a'))
        .find((item) => item.getAttribute('aria-label') === `Open ${name}`);
      return Boolean(link?.getAttribute('href'));
    },
    fileName,
    { timeout: options.timeoutMs },
  );
  const link = page.getByRole('link', { name: `Open ${fileName}` }).first();
  const href = await link.getAttribute('href');
  assert(href, `file open link must have href for ${fileName}`);
  return href;
}

async function seedDatabase(baseUrl) {
  const session = await signInForSmoke(baseUrl, { timeoutMs: options.timeoutMs });
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database property edit smoke');

  const suffix = Date.now();
  const databaseId = crypto.randomUUID();
  const notesPropId = crypto.randomUUID();
  const donePropId = crypto.randomUUID();
  const duePropId = crypto.randomUUID();
  const statusPropId = crypto.randomUUID();
  const scorePropId = crypto.randomUUID();
  const websitePropId = crypto.randomUUID();
  const emailPropId = crypto.randomUUID();
  const phonePropId = crypto.randomUUID();
  const tagsPropId = crypto.randomUUID();
  const relatedPropId = crypto.randomUUID();
  const filesPropId = crypto.randomUUID();
  const targetDatabaseId = crypto.randomUUID();
  const targetTitlePropId = crypto.randomUUID();
  const targetReciprocalPropId = crypto.randomUUID();
  const initialTitle = `Property edit alpha ${suffix}`;
  const editedTitle = `Property edit renamed ${suffix}`;
  const editedNotes = `Notes edited through UI ${suffix}`;
  const editedDateInput = '2026-06-24';
  const editedDateExpectation = 'Jun 24';
  const editedScore = 1234.5;
  const editedScoreInput = String(editedScore);
  const editedScoreDisplay = String(editedScore);
  const editedWebsite = `https://example.com/property-${suffix}`;
  const editedEmail = `property-${suffix}@example.com`;
  const editedPhone = '+1 555 010 4242';
  const targetRowTitle = `Related target ${suffix}`;
  const secondTargetRowId = crypto.randomUUID();
  const secondTargetRowTitle = `Related archive ${suffix}`;
  const removedFileName = `property-${suffix}-brief.pdf`;
  const removedFileUrl = `https://example.com/files/${removedFileName}`;
  const editedFileName = `property-${suffix}-receipt.png`;
  const editedFileUrl = `https://example.com/files/${editedFileName}`;
  const uploadedFileName = `property-${suffix}-upload.txt`;
  const uploadedFileType = 'text/plain';
  const uploadedFileText = `hanji database files upload ${suffix}`;
  const deletedUploadFileName = `property-${suffix}-delete-upload.txt`;
  const deletedUploadFileText = `hanji database files delete upload ${suffix}`;

  const targetCreated = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: targetDatabaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Property edit relation target ${suffix}`,
    viewType: 'table',
    properties: [
      { id: targetTitlePropId, name: 'Name', type: 'title', position: 1 },
    ],
  });
  assert(targetCreated?.page?.id === targetDatabaseId, 'database property edit target database must be created');
  assert(Array.isArray(targetCreated?.rows) && targetCreated.rows.length >= 1, 'database property edit needs a target row');
  const targetRow = targetCreated.rows[0];
  await updateRow(baseUrl, session.accessToken, targetRow.id, { title: targetRowTitle });
  const secondTargetCreated = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: secondTargetRowId,
    databaseId: targetDatabaseId,
    title: secondTargetRowTitle,
    properties: {},
  });
  assert(
    secondTargetCreated?.row?.id === secondTargetRowId,
    'database property edit second target relation row must be created',
  );

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Property edit smoke ${suffix}`,
    viewType: 'table',
    properties: [
      { id: crypto.randomUUID(), name: 'Name', type: 'title', position: 1 },
      { id: notesPropId, name: 'Notes', type: 'rich_text', position: 2 },
      { id: donePropId, name: 'Done', type: 'checkbox', position: 3 },
      { id: duePropId, name: 'Due', type: 'date', position: 4 },
      {
        id: statusPropId,
        name: 'Status',
        type: 'select',
        position: 5,
        options: [
          { id: 'todo', name: 'Todo', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      },
      { id: scorePropId, name: 'Score', type: 'number', position: 6, numberFormat: 'number' },
      { id: websitePropId, name: 'Website', type: 'url', position: 7 },
      { id: emailPropId, name: 'Contact email', type: 'email', position: 8 },
      { id: phonePropId, name: 'Phone', type: 'phone', position: 9 },
      {
        id: tagsPropId,
        name: 'Tags',
        type: 'multi_select',
        position: 10,
        options: [
          { id: 'design', name: 'Design', color: 'purple' },
          { id: 'ops', name: 'Ops', color: 'orange' },
          { id: 'finance', name: 'Finance', color: 'green' },
        ],
      },
      {
        id: relatedPropId,
        name: 'Related',
        type: 'relation',
        position: 11,
        config: { relationDatabaseId: targetDatabaseId },
      },
      { id: filesPropId, name: 'Attachments', type: 'files', position: 12 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database property edit smoke database must be created');
  assert(Array.isArray(created?.rows) && created.rows.length >= 1, 'database property edit smoke needs a seeded row');
  const reciprocalCreated = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: targetReciprocalPropId,
      databaseId: targetDatabaseId,
      name: 'Source rows',
      type: 'relation',
      config: { relationDatabaseId: databaseId },
      position: 2,
    },
  });
  assert(
    reciprocalCreated?.record?.id === targetReciprocalPropId,
    'database property edit target reciprocal relation property must be created',
  );

  const row = created.rows[0];
  await updateRow(baseUrl, session.accessToken, row.id, { title: initialTitle });

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    workspaceId,
    databaseId,
    rowId: row.id,
    notesPropId,
    donePropId,
    duePropId,
    statusPropId,
    scorePropId,
    websitePropId,
    emailPropId,
    phonePropId,
    tagsPropId,
    relatedPropId,
    filesPropId,
    targetDatabaseId,
    targetReciprocalPropId,
    targetRowId: targetRow.id,
    targetRowTitle,
    secondTargetRowId,
    secondTargetRowTitle,
    initialTitle,
    editedTitle,
    editedNotes,
    editedDateInput,
    editedDateExpectation,
    editedScore,
    editedScoreInput,
    editedScoreDisplay,
    editedWebsite,
    editedEmail,
    editedPhone,
    removedFileName,
    removedFileUrl,
    editedFileName,
    editedFileUrl,
    uploadedFileName,
    uploadedFileType,
    uploadedFileText,
    deletedUploadFileName,
    deletedUploadFileText,
  };
}

async function updateRow(baseUrl, token, rowId, patch) {
  const updated = await callFunction(baseUrl, token, 'database-row-mutation', {
    action: 'update',
    id: rowId,
    patch,
  });
  assert(updated?.row?.id === rowId, `row ${rowId} must be updated`);
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId, { call: callFunction });
  if (seed.targetDatabaseId) {
    await permanentlyDeletePage(baseUrl, seed.accessToken, seed.targetDatabaseId, { call: callFunction }).catch(() => {});
  }
}

async function seedSession(context, seed) {
  await installBrowserSession(context, seed, {
    appOrigin: normalizeBaseUrl(options.url),
    authOrigin: normalizeBaseUrl(options.apiUrl ?? options.url),
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
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

async function assertRuntimeReachable(baseUrl) {
  const response = await fetch(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
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
    'Playwright is required for database property edit smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    headed: false,
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
  console.log(`Usage: node scripts/database-property-edit-smoke.mjs [options]

Checks database table cell editing and reload persistence with DOM assertions only.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
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
