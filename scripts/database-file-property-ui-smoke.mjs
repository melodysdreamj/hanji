#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserAuthStorageKeys,
  finalizeRegisteredSmokeAccounts,
  permanentlyDeletePage,
  DEFAULT_BASE_URL,
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_DIR = join(root, '.edgebase', 'ui-discovery', 'database-file-property');
const FILES_PROP_NAME = '첨부파일';
const IMAGE_FILE_NAME = 'attachment-preview-image.png';
const PDF_FILE_NAME = 'attachment-preview-document.pdf';
const DOWNLOAD_FILE_NAME = 'attachment-download-sample.txt';
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAFoCAYAAADHMkpRAAAJLElEQVR42u3WQQEAEBBFwQ0kkAIayKSAUk4qkIHrzmEK/Mt/sfc6AADkEUYAABCAAAAIQAAABCAAAAIQAAABCACAAAQAQAACACAAAQAQgAAACEAAAAQgAAACEAAAAQgAIAABABCAAAAIQAAABCAAAAIQAAABCACAAAQAQAACACAAAQAQgAAACEAAAAQgAAACEAAAAQgAIAABABCAAAAIQAAABCAAAAIQAAABCACAAAQAQAACACAAAQAQgAAACEAAAAQgAAACEABAAAIAIAABABCAAAAIQAAABCAAAAIQAAABCACAAPxX2gR4VkcH+CIABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAdGSAAAQEoAAEEICAABSCAAAQEoAAEBCCAABSAgAAEEIACEBCAAAJQAAICEBCAAlAAAgIQEIACUAACAhAQgAJQAAICEBCAAlAAAgIQEIACUAACAhAQgAJQAAICEBCAAlAAAgIQEIACEEAAAgJQAAIIQEAACkAAAQgIQAEICEAAASgAAQEIIAAFICAAAQSgAAQEICAABaAABAQgIAAFoAAEBCAgAAWgAAQEICAABaAABAQgIAAFoAAEBCAgAAWgAAQEICAABaAjAwQgIAAFIIAABASgAAQQgIAAFICAAAQQgAIQEIAAAlAAAgIQQAAKQEAAAgJQAApAQAACAlAACkBAAAICUAAKQEAAAgJQAApAQAACAlAACkBAAAICUAAKQEAAAgJQAApAQAACAlAAAghAQAAKQAABCAhAAQggAAEBKAABAQggAAUgIAABBKAABAQggAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAABBCAgAAUgAACEBCAAhAQgE4MEIACEBCAAAJQAAICEEAACkBAAAICUAAKQEAAAgJQAApAQAACAlAACkBAAAICUAAKQEAAAgJQAApAQAACAlAACkBAAAICUAAKQEAAAgJQAAIIQEAACkAAAQgIQAEIIAABASgAAQEIIAAFICAAAQSgAAQEIIAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgAAQQgIAAFIAAAhAQgAIQQAACAlAAAgIQQAAKQEAAAghAAQgIQAABKAABAQgIQAEoAAEBCAhAASgAAQEICEABKAABAQgIQAEoAAEBCAhAASgAAQEICEABKAABAQgIQAHoyAABCAhAAQggAAEBKAABBCAgAAUgIAABBKAABAQggAAUgIAABBCAAhAQgIAAFIACEBCAgAAUgAIQEICAABSAAhAQgIAAFIACEBCAgAAUgAIQEICAABSAAhAQgIAAFIACEBCAgAAUgAACEBCAAhBAAAICUAACCEBAAApAQAACCEABCAhAAAEoAAEBCCAABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAEEICAABSCAAAQEoAAEBCCAABSAgAAEEIACEBCAAAJQAAICEBCAAlAAAgIQEIACUAACAhAQgAJQAAICEBCAAlAAAgIQEIACUAACAhAQgAJQAAICEBCAAlAAAgIQEIACEEAAAgJQAAIIQEAACkAAAQgIQAEICEAAASgAAQEIIAAFICAAAQSgAAQEICAABaAABAQgIAAFoAAEBCAgAAWgAAQEICAABaAABAQgIAAFoAAEBCAgAAWgAAQEICAABaAABAQgIAAFIIAABASgAAQQgIAAFIAATgwQgAIQEIAAAlAAAgIQQAAKQEAAAgJQAApAQAACAlAACkBAAAICUAAKQEAAAgJQAApAQAACAlAACkBAAAICUAAKQEAAAgJQAApAQAACAlAAAghAQAAKQAABCAhAAQggAAEBKAABAQggAAUgIAABBKAABAQggAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAABBCAgAAUgAACEBCAAhBAAAICUAACAhBAAApAQAACCEABCAhAAAEoAAEBCAhAASgAAQEICEABKAABAQgIQAEoAAEBCAhAASgAAQEICEABKAABAQgIQAEoAAEBCAhAAejIAAEICEABCCAAAQEoAAEEICAABSAgAAEEoAAEBCCAABSAgAAEEIACEBCAgAAUgAIQEICAABSAAhAQgIAAFIACEBCAgAAUgAIQEICAABSAAhAQgIAAFIACEBCAgAAUgAIQEICAABSAAAIQEIACEEAAAgJQAAIIQEAACkBAAAIIQAEICEAAASgAAQEIIAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgAAQQgIAAFIIAABASgAAQEoBMDBKAABAQggAAUgIAABBCAAhAQgIAAFIACEBCAgAAUgAIQEICAABSAAhAQgIAAFIACEBCAgAAUgAIQEICAABSAAhAQgIAAFIACEBCAgAAUgAACEBCAAhBAAAICUAACCEBAAApAQAACCEABCAhAAAEoAAEBCCAABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAUgIAABASgABSAgAAEBKAAFICAAAQEoAAEEICAABSCAAAQEoAAEcGKAABSAgAAEEIACEBCAAAJQAAICEEAACkBAAAICUAAKQEAAAgJQAApAQAACAlAACkBAAAICUAACACAAAQAQgAAACEAAAAQgAAACEAAAAQgAIAABABCAAAAIQAAABCAAAAIQAAABCACAAAQAQAACACAAAQAQgAAACEAAAAQgAAACEABAAAIAIAABABCAAAAIQAAABCAAAAIQAAABCACAAAQAQAACACAAAQAQgAAACEAAAAQgAAACEABAAAIAIAABABCAAAAIQAAABCAAAAIQAAABCACAAAQAQAACACAAAQAQgAAACEAAAAQgAIAANAIAQCYX2FeU6mkBKewAAAAASUVORK5CYII=';
const PDF_SMOKE_PATH = '/__hanji_smoke__/attachment-preview-document.pdf';
const PDF_BYTES = minimalPdfBytes();
const DOWNLOAD_DATA_URL = 'data:text/plain;base64,SGFuamkgYXR0YWNobWVudCBkb3dubG9hZCBzbW9rZQo=';
const FILE_FIXTURES = [
  { name: IMAGE_FILE_NAME, size: 2_405, type: 'image/png', url: IMAGE_DATA_URL },
  { name: PDF_FILE_NAME, size: PDF_BYTES.byteLength, type: 'application/pdf', url: PDF_SMOKE_PATH },
  { name: DOWNLOAD_FILE_NAME, size: 31, type: 'text/plain', url: DOWNLOAD_DATA_URL },
  {
    name: 'attachment-actions-sample.pptx',
    size: 331_000,
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    url: 'https://example.com/files/attachment-actions-sample.pptx',
  },
];
const FILE_NAMES = FILE_FIXTURES.map((file) => file.name);

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database file property UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await finalizeRegisteredSmokeAccounts('database file property UI smoke');
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database file property UI smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  mkdirSync(options.screenshotDir, { recursive: true });
  const seed = await seedDatabase(baseUrl);
  const { chromium } = await loadPlaywright({ label: 'database file property UI smoke' });
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(resolveChromeExecutable() ? { executablePath: resolveChromeExecutable() } : {}),
  });

  try {
    await assertFilePropertyUi(browser, baseUrl, seed);
    console.log('PASS database file property chips stay single-line and the file menu exposes per-file download buttons.');
    console.log(`Screenshots: ${join(options.screenshotDir, 'file-cell-closed.png')}, ${join(options.screenshotDir, 'file-cell-menu.png')}, ${join(options.screenshotDir, 'file-cell-action-menu.png')}`);
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(baseUrl, seed).catch(() => {});
  }
}

async function assertFilePropertyUi(browser, baseUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
  });
  await seedSession(context, seed, 'dark');
  await page.route(`**${PDF_SMOKE_PATH}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    headers: {
      'Content-Disposition': `attachment; filename="${PDF_FILE_NAME}"`,
      'X-Content-Type-Options': 'nosniff',
    },
    body: PDF_BYTES,
  }));

  try {
    await openDatabase(page, baseUrl, seed);
    const closedMetrics = await collectClosedCellMetrics(page, seed);
    await page.screenshot({
      path: join(options.screenshotDir, 'file-cell-closed.png'),
      fullPage: false,
    });

    await page.getByRole('button', { name: `Edit ${FILES_PROP_NAME} files` }).click({
      timeout: options.timeoutMs,
    });
    await page.getByRole('dialog', { name: 'Edit files property' }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    const menuMetrics = await collectFilesMenuMetrics(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'file-cell-menu.png'),
      fullPage: false,
    });

    const previewMetrics = await assertAttachmentOpenBehavior(page, context);

    await page.getByRole('button', { name: `${FILE_NAMES[0]} file menu` }).click({
      timeout: options.timeoutMs,
    });
    await page.getByRole('menu', { name: `${FILE_NAMES[0]} file actions` }).waitFor({
      state: 'visible',
      timeout: options.timeoutMs,
    });
    const actionMenuMetrics = await collectActionMenuMetrics(page);
    await page.screenshot({
      path: join(options.screenshotDir, 'file-cell-action-menu.png'),
      fullPage: false,
    });

    const metrics = { closedMetrics, menuMetrics, previewMetrics, actionMenuMetrics };
    writeFileSync(join(options.screenshotDir, 'database-file-property-ui.json'), `${JSON.stringify(metrics, null, 2)}\n`);

    assert(closedMetrics.rowHeight <= 38, `multi-file table row should stay close to one-line height: ${JSON.stringify(closedMetrics)}`);
    assert(closedMetrics.cellHeight <= 38, `multi-file table cell should not grow vertically: ${JSON.stringify(closedMetrics)}`);
    assert(closedMetrics.triggerHeight <= 33, `file chips trigger should stay one-line high: ${JSON.stringify(closedMetrics)}`);
    assert(closedMetrics.chipRows === 1, `file chips should occupy one visual row: ${JSON.stringify(closedMetrics)}`);
    assert(closedMetrics.flexWrap === 'nowrap', `file chips should use nowrap in table cells: ${JSON.stringify(closedMetrics)}`);
    assert(closedMetrics.overflowX === 'hidden' || closedMetrics.overflow === 'hidden', `file chips overflow should be clipped in table cells: ${JSON.stringify(closedMetrics)}`);

    assert(menuMetrics.itemCount === FILE_NAMES.length, `file menu should list every file: ${JSON.stringify(menuMetrics)}`);
    assert(menuMetrics.rows.every((row) => row.hasDownloadButton), `every file row needs a direct download button: ${JSON.stringify(menuMetrics)}`);
    assert(menuMetrics.rows.every((row) => row.downloadBeforeMenu), `direct download button should sit left of the file menu button: ${JSON.stringify(menuMetrics)}`);
    assert(previewMetrics.imageDialogVisible, `image attachment should open an in-app preview: ${JSON.stringify(previewMetrics)}`);
    assert(previewMetrics.imageStayedInPage, `image preview should not open a second tab: ${JSON.stringify(previewMetrics)}`);
    assert(previewMetrics.imageAboveFilePopover, `image preview should cover the originating file popover: ${JSON.stringify(previewMetrics)}`);
    assert(previewMetrics.pdfOpenedInNewTab, `PDF attachment should open in a new browser tab: ${JSON.stringify(previewMetrics)}`);
    assert(previewMetrics.pdfViewerReady, `stored/download-only PDF bytes should be re-typed for the browser PDF reader: ${JSON.stringify(previewMetrics)}`);
    assert(!previewMetrics.pdfUrl.includes(PDF_SMOKE_PATH), `PDF primary click must not fall back to the forced-download URL: ${JSON.stringify(previewMetrics)}`);
    assert(previewMetrics.downloadName === DOWNLOAD_FILE_NAME, `other attachments should keep downloading: ${JSON.stringify(previewMetrics)}`);
    assert(actionMenuMetrics.items.includes('Download'), `per-file overflow menu should keep the download action: ${JSON.stringify(actionMenuMetrics)}`);
    assert(actionMenuMetrics.withinViewport, `per-file action menu should stay visible in the viewport: ${JSON.stringify(actionMenuMetrics)}`);
    assertNoBrowserErrors(errors, 'database file property UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function assertAttachmentOpenBehavior(page, context) {
  const fileDialog = page.getByRole('dialog', { name: 'Edit files property' });
  assert(await fileDialog.count() === 1, 'file property popover should remain open for attachment actions');
  const imageLink = fileDialog.locator(`[data-attachment-kind="image"][aria-label="Open ${IMAGE_FILE_NAME}"]`);
  assert(await imageLink.count() === 1, 'image attachment should expose one preview link');
  const pagesBeforeImage = context.pages().length;
  await imageLink.click({ timeout: options.timeoutMs });
  const imageDialog = page.getByRole('dialog', { name: 'Image preview' });
  await imageDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const imageDialogVisible = await imageDialog.isVisible();
  const imageStayedInPage = context.pages().length === pagesBeforeImage;
  const imageAboveFilePopover = await page.evaluate(() => {
    const preview = document.querySelector('[data-attachment-image-preview]');
    const filePopover = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) => node.getAttribute('aria-label') === 'Edit files property',
    );
    if (!(preview instanceof HTMLElement) || !(filePopover instanceof HTMLElement)) return false;
    return Number(getComputedStyle(preview).zIndex) > Number(getComputedStyle(filePopover).zIndex);
  });
  await page.screenshot({
    path: join(options.screenshotDir, 'file-image-preview.png'),
    fullPage: false,
  });
  const closePreview = page.getByRole('button', { name: 'Close image preview' });
  assert(await closePreview.count() === 1, 'image preview should expose one close button');
  await closePreview.click({ timeout: options.timeoutMs });
  await imageDialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });

  const pdfLink = fileDialog.locator(`[data-attachment-kind="pdf"][aria-label="Open ${PDF_FILE_NAME}"]`);
  assert(await pdfLink.count() === 1, 'PDF attachment should expose one new-tab link');
  const popupPromise = page.waitForEvent('popup', { timeout: options.timeoutMs });
  await pdfLink.click({ timeout: options.timeoutMs });
  const pdfPage = await popupPromise;
  const readyPdfLink = fileDialog.locator(
    `[data-attachment-kind="pdf"][aria-label="Open ${PDF_FILE_NAME}"][data-pdf-viewer-ready="true"]`,
  );
  await readyPdfLink.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const pdfViewerReady = await readyPdfLink.getAttribute('data-pdf-viewer-ready') === 'true';
  // Headless Chromium does not consistently attach its PDF extension shell to
  // blob popups (it may leave about:blank or report ERR_ABORTED). The durable
  // signal is the same-page viewer-ready marker set only after a verified PDF
  // Blob exists, plus the observed popup and absence of forced-download URL.
  await pdfPage.waitForTimeout(500);
  const pdfUrl = pdfPage.url();
  await pdfPage.screenshot({
    path: join(options.screenshotDir, 'file-pdf-new-tab.png'),
    fullPage: false,
  }).catch(() => {});
  await pdfPage.close();

  const downloadLink = fileDialog.locator(`[data-attachment-kind="download"][aria-label="Open ${DOWNLOAD_FILE_NAME}"]`);
  assert(await downloadLink.count() === 1, 'ordinary attachment should expose one download link');
  const downloadPromise = page.waitForEvent('download', { timeout: options.timeoutMs });
  await downloadLink.click({ timeout: options.timeoutMs });
  const download = await downloadPromise;

  return {
    downloadName: download.suggestedFilename(),
    imageDialogVisible,
    imageAboveFilePopover,
    imageStayedInPage,
    pdfOpenedInNewTab: pdfPage !== page,
    pdfViewerReady,
    pdfUrl,
  };
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
  await page.waitForFunction(
    (rowTitle) =>
      Array.from(document.querySelectorAll('input')).some(
        (input) => input.value === rowTitle && input.offsetParent !== null,
      ),
    seed.rowTitle,
    { timeout: options.timeoutMs },
  );
}

async function collectClosedCellMetrics(page, seed) {
  return page.evaluate(({ rowId, filesPropName, expectedFileCount }) => {
    const row = document.querySelector(`[data-table-row-id="${CSS.escape(rowId)}"]`);
    const cell = row?.querySelector('[data-table-cell][data-col-index="1"]');
    const chipContainer = cell?.querySelector('[data-file-attachments]');
    const chips = Array.from(chipContainer?.children ?? [])
      .filter((node) => node instanceof HTMLElement && node.className.includes('fileChip'));
    const chipTops = chips.map((chip) => Math.round(chip.getBoundingClientRect().top));
    const style = chipContainer ? getComputedStyle(chipContainer) : null;
    return {
      cellHeight: rectHeight(cell),
      chipCount: chips.length,
      chipRows: new Set(chipTops).size,
      expectedFileCount,
      flexWrap: style?.flexWrap ?? '',
      overflow: style?.overflow ?? '',
      overflowX: style?.overflowX ?? '',
      rowHeight: rectHeight(row),
      triggerHeight: rectHeight(chipContainer),
    };

    function rectHeight(node) {
      return node instanceof HTMLElement ? Math.round(node.getBoundingClientRect().height * 10) / 10 : 0;
    }
  }, {
    expectedFileCount: FILE_NAMES.length,
    filesPropName: FILES_PROP_NAME,
    rowId: seed.rowId,
  });
}

async function collectFilesMenuMetrics(page) {
  return page.evaluate((fileNames) => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (node) => node instanceof HTMLElement && node.getAttribute('aria-label') === 'Edit files property',
    );
    const items = Array.from(dialog?.querySelectorAll('[class*="filesMenuItem"]') ?? [])
      .filter((node) => node instanceof HTMLElement);
    const rows = fileNames.map((name) => {
      const item = items.find((node) => (node.textContent ?? '').includes(name));
      const buttons = Array.from(item?.querySelectorAll('button') ?? []).filter((node) => node instanceof HTMLElement);
      const download = buttons.find((button) => button.getAttribute('aria-label') === `Download ${name}`);
      const menu = buttons.find((button) => button.getAttribute('aria-label') === `${name} file menu`);
      const downloadRect = download instanceof HTMLElement ? download.getBoundingClientRect() : null;
      const menuRect = menu instanceof HTMLElement ? menu.getBoundingClientRect() : null;
      return {
        downloadBeforeMenu: !!downloadRect && !!menuRect && downloadRect.right <= menuRect.left,
        hasDownloadButton: !!download,
        hasMenuButton: !!menu,
        name,
      };
    });
    return {
      itemCount: items.length,
      rows,
    };
  }, FILE_NAMES);
}

async function collectActionMenuMetrics(page) {
  return page.evaluate((name) => {
    const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(
      (node) => node instanceof HTMLElement && node.getAttribute('aria-label') === `${name} file actions`,
    );
    const rect = menu instanceof HTMLElement ? menu.getBoundingClientRect() : null;
    return {
      items: Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? [])
        .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
      withinViewport: !!rect && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
    };
  }, FILE_NAMES[0]);
}

async function seedDatabase(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for database file property UI smoke');

  const suffix = Date.now();
  const databaseId = randomUUID();
  const rowId = randomUUID();
  const titlePropId = randomUUID();
  const filesPropId = randomUUID();
  const rowTitle = `파일 칩 한 줄 회귀 ${suffix}`;

  const created = await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `파일 속성 UI 회귀 ${suffix}`,
    position: suffix,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: titlePropId, name: '자료명', type: 'title', position: 1 },
      { id: filesPropId, name: FILES_PROP_NAME, type: 'files', position: 2 },
    ],
  });
  assert(created?.page?.id === databaseId, 'database file property UI smoke database must be created');
  const tableViewId = created.views?.[0]?.id;
  assert(tableViewId, 'database file property UI smoke must receive a table view');

  await callFunction(baseUrl, session.accessToken, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    databaseId,
    id: tableViewId,
    patch: {
      name: 'Table',
      position: 1,
      config: {
        propertyOrder: [titlePropId, filesPropId],
        visibleProperties: [titlePropId, filesPropId],
        propertyWidths: {
          [titlePropId]: 300,
          [filesPropId]: 260,
        },
      },
    },
  });

  const createdRow = await callFunction(baseUrl, session.accessToken, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: rowTitle,
    properties: {
      [filesPropId]: FILE_FIXTURES.map((file, index) => ({
        id: `file-property-ui-${suffix}-${index}`,
        ...file,
      })),
    },
  });
  assert(createdRow?.row?.id === rowId, 'database file property UI smoke row must be created');

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    databaseId,
    rowId,
    rowTitle,
  };
}

function minimalPdfBytes() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 54 >>\nstream\nBT /F1 18 Tf 72 720 Td (Hanji PDF preview) Tj ET\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.databaseId) return;
  await permanentlyDeletePage(baseUrl, seed.accessToken, seed.databaseId).catch(() => {});
}

async function seedSession(context, seed, theme = 'dark') {
  await context.addInitScript(({ refreshToken, refreshTokenKey, workspaceId, theme }) => {
    window.localStorage.setItem(refreshTokenKey, refreshToken);
    window.localStorage.setItem('hanji.workspaceId', workspaceId);
    window.localStorage.setItem('hanji:theme', theme);
  }, {
    refreshTokenKey: browserAuthStorageKeys(normalizeBaseUrl(options.apiUrl ?? options.url)).refreshTokenKey,
    refreshToken: seed.refreshToken,
    theme,
    workspaceId: seed.workspaceId,
  });
}

function parseArgs(args) {
  const parsed = {
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
      parsed.url = valueAfter(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--screenshot-dir') {
      parsed.screenshotDir = resolve(valueAfter(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms' || arg === '--timeout') {
      parsed.timeoutMs = Number(valueAfter(args, i, arg));
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

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/database-file-property-ui-smoke.mjs [options]

Options:
  --url <url>             App URL (default: ${DEFAULT_BASE_URL})
  --screenshot-dir <dir>  Directory for captured screenshots
  --timeout-ms <ms>       Timeout for browser/API operations
  --headed                Show the browser while running
`);
}
