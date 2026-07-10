#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureBrowserSession,
  installBrowserSession,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));

const options = parseArgs(process.argv.slice(2));
let yjsModulePromise;

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL presence UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Presence UI smoke target: ${baseUrl}${apiUrl === baseUrl ? '' : ` (API ${apiUrl})`}`);

  await assertRuntimeReachable(apiUrl);
  const seed = await seedPresencePage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertPresenceRoomState(browser, baseUrl, apiUrl, seed);
    console.log('PASS page presence shows two connected users, page metadata room sync, read-only shared viewer presence, database row invalidation, database cell awareness, mobile shared viewer presence, offline/online reconnect, remote editing cursor avatars, live CRDT room text apply, active-editor caret preservation, divergent active-editor CRDT merge, scoped Yjs text undo, and durable CRDT reload resync without screenshots.');
  } finally {
    await browser.close().catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertPresenceRoomState(browser, baseUrl, apiUrl, seed) {
  const owner = await newCheckedPage(browser);
  const viewer = await newCheckedPage(browser);
  await seedSession(owner.context, seed.owner);
  await seedSession(viewer.context, seed.viewer);

  try {
    await Promise.all([
      openPage(owner.page, baseUrl, seed.pageId, seed.title, 'owner initial'),
      openPage(viewer.page, baseUrl, seed.pageId, seed.title, 'edit viewer initial'),
    ]);

    try {
      await waitForTopbarPresenceConnected(owner.page);
      await waitForTopbarPresenceConnected(viewer.page);
    } catch (error) {
      const [ownerDiagnostics, viewerDiagnostics] = await Promise.all([
        collectPresenceDiagnostics(owner.page, 'owner'),
        collectPresenceDiagnostics(viewer.page, 'viewer'),
      ]);
      throw new Error([
        error instanceof Error ? error.message : String(error),
        'Presence diagnostics:',
        JSON.stringify({ owner: ownerDiagnostics, viewer: viewerDiagnostics }, null, 2),
      ].join('\n'));
    }
    await persistSessionFromContext(owner.context, seed.owner);
    await persistSessionFromContext(viewer.context, seed.viewer);

    await assertPageMetaRoomMutation(owner.page, viewer.page, apiUrl, seed);

    await viewer.page.evaluate(({ pageId, blockId }) => {
      window.dispatchEvent(new CustomEvent('notionlike:page-presence-awareness', {
        detail: {
          pageId,
          blockId,
          mode: 'editing',
          selectedBlockIds: [blockId],
          textRange: { start: 0, end: 0 },
        },
      }));
    }, {
      pageId: seed.pageId,
      blockId: seed.blockId,
    });

    await waitForFloatingPresenceEditing(owner.page);
    await waitForRemoteCursorAvatar(owner.page);

    await assertCrdtRoomSignal(owner.page, viewer.page, seed);
    await assertDurableCrdtDocumentResync(browser, baseUrl, apiUrl, seed);

    assertNoBrowserErrors(owner.errors, 'owner presence page');
    assertNoBrowserErrors(viewer.errors, 'shared viewer presence page');
  } finally {
    await persistSessionFromContext(owner.context, seed.owner);
    await owner.context.close().catch(() => {});
    await viewer.context.close().catch(() => {});
  }

  await assertReadOnlyPresenceJoin(browser, baseUrl, seed);
  await assertDatabaseCellAwareness(browser, baseUrl, apiUrl, seed);
  await assertMobilePresenceJoin(browser, baseUrl, seed);
}

async function assertReadOnlyPresenceJoin(browser, baseUrl, seed) {
  const owner = await newCheckedPage(browser);
  const readonlyViewer = await newCheckedPage(browser);
  await seedSession(owner.context, seed.owner);
  await seedSession(readonlyViewer.context, seed.readonlyViewer);

  try {
    await Promise.all([
      openPage(owner.page, baseUrl, seed.pageId, seed.title, 'owner with read-only viewer'),
      openPage(readonlyViewer.page, baseUrl, seed.pageId, seed.title, 'read-only viewer'),
    ]);

    await waitForTopbarPresenceConnected(owner.page);
    await waitForTopbarPresenceConnected(readonlyViewer.page);

    assertNoBrowserErrors(owner.errors, 'owner presence page with read-only viewer');
    assertNoBrowserErrors(readonlyViewer.errors, 'read-only shared viewer presence page');
  } finally {
    await persistSessionFromContext(owner.context, seed.owner);
    await persistSessionFromContext(readonlyViewer.context, seed.readonlyViewer);
    await owner.context.close().catch(() => {});
    await readonlyViewer.context.close().catch(() => {});
  }
}

async function assertDatabaseCellAwareness(browser, baseUrl, apiUrl, seed) {
  const owner = await newCheckedPage(browser);
  const viewer = await newCheckedPage(browser);
  await seedSession(owner.context, seed.owner);
  await seedSession(viewer.context, seed.viewer);

  try {
    await Promise.all([
      openPage(owner.page, baseUrl, seed.databaseId, seed.databaseTitle, 'owner database awareness'),
      openPage(viewer.page, baseUrl, seed.databaseId, seed.databaseTitle, 'viewer database awareness'),
    ]);
    await waitForTopbarPresenceConnected(owner.page);
    await waitForTopbarPresenceConnected(viewer.page);

    await assertDatabaseRowsRoomInvalidation(owner.page, viewer.page, apiUrl, seed);

    await viewer.page.waitForSelector('[data-table-title-input]', { timeout: options.timeoutMs });
    const titleInputs = viewer.page.locator('[data-table-title-input]');
    await titleInputs.first().click({ timeout: options.timeoutMs });
    await viewer.page.evaluate(() => {
      const input = document.querySelector('[data-table-title-input]');
      if (!(input instanceof HTMLInputElement)) throw new Error('database title input not found');
      input.focus();
      input.setSelectionRange(0, input.value.length);
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });

    try {
      await owner.page.waitForFunction(() => {
        const cell = document.querySelector('[data-table-cell][data-remote-awareness="editing"]');
        if (!(cell instanceof HTMLElement)) return false;
        const marker = cell.querySelector('[class*="cellRemoteAwarenessAvatar"]');
        const label = cell.getAttribute('title') ?? '';
        const rect = marker instanceof HTMLElement ? marker.getBoundingClientRect() : null;
        return !!marker && !!rect && rect.width > 0 && rect.height > 0 && label.includes('editing');
      }, undefined, { timeout: options.timeoutMs });
    } catch (error) {
      const [ownerDiagnostics, viewerDiagnostics] = await Promise.all([
        collectDatabaseAwarenessDiagnostics(owner.page, 'owner database awareness'),
        collectDatabaseAwarenessDiagnostics(viewer.page, 'viewer database awareness'),
      ]);
      throw new Error([
        'database cell awareness marker did not render',
        error instanceof Error ? error.message : String(error),
        JSON.stringify({ owner: ownerDiagnostics, viewer: viewerDiagnostics }, null, 2),
      ].join('\n'));
    }

    assertNoBrowserErrors(owner.errors, 'owner database cell awareness page');
    assertNoBrowserErrors(viewer.errors, 'viewer database cell awareness page');
  } finally {
    await persistSessionFromContext(owner.context, seed.owner);
    await persistSessionFromContext(viewer.context, seed.viewer);
    await owner.context.close().catch(() => {});
    await viewer.context.close().catch(() => {});
  }
}

async function assertPageMetaRoomMutation(ownerPage, viewerPage, apiUrl, seed) {
  const title = `Presence meta ${randomUUID()}`;
  const icon = '🚀';
  const updatedAt = new Date(Date.now() + 30_000).toISOString();
  await callFunction(apiUrl, seed.owner.accessToken, 'page-mutation', {
    action: 'update',
    id: seed.pageId,
    patch: {
      icon,
      iconType: 'emoji',
      title,
      updatedAt,
    },
  });
  await ownerPage.evaluate(({ icon, pageId, title, updatedAt }) => {
    window.dispatchEvent(new CustomEvent('notionlike:page-room-mutation', {
      detail: {
        kind: 'page_meta_changed',
        pageId,
        patch: { icon, iconType: 'emoji', title, updatedAt },
        reason: 'smoke_page_meta',
        revision: Date.now(),
        targetPageId: pageId,
        updatedAt,
      },
    }));
  }, {
    icon,
    pageId: seed.pageId,
    title,
    updatedAt,
  });
  await viewerPage.waitForFunction(
    ({ icon, title }) => {
      const titleBox = Array.from(document.querySelectorAll('[role="textbox"][aria-label]')).find((element) => {
        const label = element.getAttribute('aria-label');
        return label === 'Page title' || label === '페이지 제목';
      });
      return (
        document.title.includes(title) &&
        titleBox?.textContent?.includes(title) === true &&
        document.body.textContent?.includes(icon) === true
      );
    },
    { icon, title },
    { timeout: options.timeoutMs },
  );
  seed.title = title;
}

async function assertDatabaseRowsRoomInvalidation(ownerPage, viewerPage, apiUrl, seed) {
  const rowId = randomUUID();
  const title = `Presence row invalidation ${rowId}`;
  await callFunction(apiUrl, seed.owner.accessToken, 'database-row-mutation', {
    action: 'create',
    databaseId: seed.databaseId,
    id: rowId,
    properties: {},
    title,
  });
  await ownerPage.evaluate(({ databaseId, rowId }) => {
    window.dispatchEvent(new CustomEvent('notionlike:page-room-mutation', {
      detail: {
        databaseId,
        kind: 'database_rows_changed',
        pageId: databaseId,
        reason: 'smoke_row_created',
        revision: Date.now(),
        rowIds: [rowId],
        updatedAt: new Date().toISOString(),
      },
    }));
  }, {
    databaseId: seed.databaseId,
    rowId,
  });
  await viewerPage.waitForFunction(
    ({ title }) =>
      Array.from(document.querySelectorAll('[data-table-title-input]')).some(
        (input) => input instanceof HTMLInputElement && input.value === title,
      ) || document.body.textContent?.includes(title) === true,
    { title },
    { timeout: options.timeoutMs },
  );
}

async function waitForRemoteCursorAvatar(page) {
  try {
    await page.waitForFunction(() => {
      const badge = document.querySelector('[class*="remoteTextCursorBadge"]');
      if (!(badge instanceof HTMLElement)) return false;
      const rect = badge.getBoundingClientRect();
      return (
        rect.width >= 14 &&
        rect.width <= 24 &&
        rect.height >= 14 &&
        rect.height <= 24 &&
        (badge.textContent ?? '').trim().length > 0 &&
        (badge.textContent ?? '').trim().length <= 3
      );
    }, undefined, { timeout: options.timeoutMs });
  } catch (error) {
    const diagnostics = await collectPresenceDiagnostics(page, 'remote cursor avatar wait');
    throw new Error([
      'remote cursor avatar did not render',
      error instanceof Error ? error.message : String(error),
      JSON.stringify(diagnostics, null, 2),
    ].join('\n'));
  }
}

async function collectDatabaseAwarenessDiagnostics(page, label) {
  return {
    label,
    url: page.url(),
    ...(await page.evaluate(() => ({
      activeElement: document.activeElement
        ? {
            tag: document.activeElement.tagName,
            value:
              document.activeElement instanceof HTMLInputElement ||
              document.activeElement instanceof HTMLTextAreaElement
                ? document.activeElement.value
                : document.activeElement.textContent?.slice(0, 120),
          }
        : null,
      bodyText: document.body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500) ?? '',
      debug: window.__notionlikePresenceDebug ?? null,
      inputs: Array.from(document.querySelectorAll('[data-table-title-input]')).map((input) => ({
        value: input instanceof HTMLInputElement ? input.value : '',
        visible: !!(
          input instanceof HTMLElement &&
          (input.offsetWidth || input.offsetHeight || input.getClientRects().length)
        ),
      })),
      remoteCells: Array.from(document.querySelectorAll('[data-table-cell][data-remote-awareness]')).map((cell) => ({
        html: cell.outerHTML.slice(0, 500),
        title: cell.getAttribute('title'),
        awareness: cell.getAttribute('data-remote-awareness'),
      })),
      topbar: document.querySelector('[data-testid="topbar-page-presence"]')?.outerHTML.slice(0, 500) ?? null,
    }))),
  };
}

async function assertMobilePresenceJoin(browser, baseUrl, seed) {
  const owner = await newCheckedPage(browser);
  const mobileViewer = await newCheckedPage(browser, {
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  await seedSession(owner.context, seed.owner);
  await seedSession(mobileViewer.context, seed.viewer);

  try {
    await Promise.all([
      openPage(owner.page, baseUrl, seed.pageId, seed.title, 'owner with mobile viewer'),
      openPage(mobileViewer.page, baseUrl, seed.pageId, seed.title, 'mobile edit viewer'),
    ]);

    await waitForTopbarPresenceConnected(owner.page);
    await waitForTopbarPresenceConnected(mobileViewer.page);

    await mobileViewer.page.evaluate(({ pageId, blockId }) => {
      window.dispatchEvent(new CustomEvent('notionlike:page-presence-awareness', {
        detail: {
          pageId,
          blockId,
          mode: 'editing',
          selectedBlockIds: [blockId],
          textRange: { start: 0, end: 0 },
        },
      }));
    }, {
      pageId: seed.pageId,
      blockId: seed.blockId,
    });

    await waitForFloatingPresenceEditing(owner.page);

    await owner.context.setOffline(true);
    await owner.page.waitForFunction(() => {
      const presence =
        document.querySelector('[data-testid="topbar-page-presence"]') ??
        document.querySelector('[data-testid="page-presence"]');
      const status = presence?.getAttribute('data-status') ?? '';
      return ['connecting', 'reconnecting', 'disconnected'].includes(status);
    }, undefined, { timeout: options.timeoutMs });

    await owner.context.setOffline(false);
    await waitForTopbarPresenceConnected(owner.page);

    removeExpectedOfflineNetworkErrors(owner.errors);
    assertNoBrowserErrors(owner.errors, 'owner presence page with mobile viewer');
    assertNoBrowserErrors(mobileViewer.errors, 'mobile shared viewer presence page');
  } finally {
    await persistSessionFromContext(owner.context, seed.owner);
    await persistSessionFromContext(mobileViewer.context, seed.viewer);
    await owner.context.close().catch(() => {});
    await mobileViewer.context.close().catch(() => {});
  }
}

async function waitForTopbarPresenceConnected(page) {
  try {
    await page.waitForFunction(() => {
      const presence = document.querySelector('[data-testid="topbar-page-presence"]');
      if (!(presence instanceof HTMLElement)) return false;
      const rect = presence.getBoundingClientRect();
      const label = presence.getAttribute('aria-label') ?? '';
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        presence.getAttribute('data-status') === 'connected' &&
        label.startsWith('2 connected')
      );
    }, undefined, { timeout: options.timeoutMs });
  } catch (error) {
    const diagnostics = await collectPresenceDiagnostics(page, 'topbar wait');
    throw new Error([
      'topbar presence did not reach 2 connected',
      error instanceof Error ? error.message : String(error),
      JSON.stringify(diagnostics, null, 2),
    ].join('\n'));
  }
}

async function waitForFloatingPresenceEditing(page) {
  try {
    await page.waitForFunction(() => {
      const presence = document.querySelector('[data-testid="page-presence"]');
      if (!(presence instanceof HTMLElement)) return false;
      const rect = presence.getBoundingClientRect();
      const label = presence.getAttribute('aria-label') ?? '';
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        presence.getAttribute('data-status') === 'connected' &&
        /^2 connected, .* editing/i.test(label)
      );
    }, undefined, { timeout: options.timeoutMs });
  } catch (error) {
    const diagnostics = await collectPresenceDiagnostics(page, 'floating wait');
    throw new Error([
      'floating presence did not show remote editing',
      error instanceof Error ? error.message : String(error),
      JSON.stringify(diagnostics, null, 2),
    ].join('\n'));
  }
}

async function assertCrdtRoomSignal(senderPage, receiverPage, seed) {
  const nextText = `Presence CRDT live update ${randomUUID()}`;
  const updatedAt = new Date(Date.now() + 60_000).toISOString();
  const operation = await syntheticYjsBlockTextUpdate({
    blockId: seed.blockId,
    rich: [{ text: nextText }],
    updatedAt,
  });

  await receiverPage.locator(`[data-block-id="${seed.blockId}"]`).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await receiverPage.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.__notionlikePresenceSmokeCrdtReceived = null;
    window.addEventListener(
      'notionlike:page-crdt-update-received',
      (event) => {
        window.__notionlikePresenceSmokeCrdtReceived = event.detail?.blockId ?? null;
      },
      { once: true },
    );
  });

  await senderPage.evaluate(({ blockId, operation, pageId, updatedAt }) => {
    window.dispatchEvent(
      new CustomEvent('notionlike:page-crdt-update', {
        detail: {
          blockId,
          operation,
          pageId,
          revision: Date.now(),
          updatedAt,
        },
      }),
    );
  }, {
    blockId: seed.blockId,
    operation,
    pageId: seed.pageId,
    updatedAt,
  });

  await receiverPage.waitForFunction(
    ({ blockId }) => window.__notionlikePresenceSmokeCrdtReceived === blockId,
    { blockId: seed.blockId },
    { timeout: options.timeoutMs },
  );
  await receiverPage
    .locator(`[data-block-id="${seed.blockId}"]`)
    .getByText(nextText, { exact: true })
    .waitFor({ state: 'visible', timeout: options.timeoutMs });

  await assertActiveEditorCrdtApply(senderPage, receiverPage, seed, nextText);
  await assertDivergentActiveEditorCrdtMerge(senderPage, receiverPage, seed);
  await assertScopedYjsTextUndo(senderPage, receiverPage, seed);
}

async function assertActiveEditorCrdtApply(senderPage, receiverPage, seed, currentText) {
  const nextText = `${currentText} active merge ${randomUUID()}`;
  const updatedAt = new Date(Date.now() + 120_000).toISOString();
  const operation = await syntheticYjsBlockTextUpdate({
    blockId: seed.blockId,
    rich: [{ text: nextText }],
    updatedAt,
  });
  const caretOffsetBefore = currentText.length;

  await receiverPage.evaluate(({ blockId, caretOffsetBefore }) => {
    const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
    if (!(editable instanceof HTMLElement)) throw new Error('editable block was not found');
    editable.focus();
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let remaining = caretOffsetBefore;
    let target = null;
    let text = walker.nextNode();
    while (text) {
      const length = text.textContent?.length ?? 0;
      if (remaining <= length) {
        target = { node: text, offset: remaining };
        break;
      }
      remaining -= length;
      text = walker.nextNode();
    }
    const range = document.createRange();
    if (target) {
      range.setStart(target.node, target.offset);
    } else {
      range.selectNodeContents(editable);
      range.collapse(false);
    }
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, {
    blockId: seed.blockId,
    caretOffsetBefore,
  });

  await senderPage.evaluate(({ blockId, operation, pageId, updatedAt }) => {
    window.dispatchEvent(
      new CustomEvent('notionlike:page-crdt-update', {
        detail: {
          blockId,
          operation,
          pageId,
          revision: Date.now(),
          updatedAt,
        },
      }),
    );
  }, {
    blockId: seed.blockId,
    operation,
    pageId: seed.pageId,
    updatedAt,
  });

  await receiverPage
    .locator(`[data-block-id="${seed.blockId}"]`)
    .getByText(nextText, { exact: true })
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
  await receiverPage.waitForFunction(
    ({ blockId, caretOffsetBefore }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      if (!(editable instanceof HTMLElement) || !editable.contains(document.activeElement)) return false;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      const range = selection.getRangeAt(0).cloneRange();
      if (!editable.contains(range.startContainer) || !range.collapsed) return false;
      const prefix = document.createRange();
      prefix.selectNodeContents(editable);
      prefix.setEnd(range.startContainer, range.startOffset);
      return prefix.toString().length === caretOffsetBefore;
    },
    {
      blockId: seed.blockId,
      caretOffsetBefore,
    },
    { timeout: options.timeoutMs },
  );
  await assertActiveEditorCrdtSelectionRangeApply(senderPage, receiverPage, seed, nextText);
}

async function assertActiveEditorCrdtSelectionRangeApply(senderPage, receiverPage, seed, currentText) {
  const suffix = ` range merge ${randomUUID()}`;
  const nextText = `${currentText}${suffix}`;
  const updatedAt = new Date(Date.now() + 150_000).toISOString();
  const operation = await syntheticYjsBlockTextUpdate({
    blockId: seed.blockId,
    rich: [
      { text: currentText, bold: true },
      { text: suffix, link: 'https://example.com/presence-selection-range' },
    ],
    updatedAt,
  });
  const selectionStart = Math.max(0, Math.min(4, currentText.length - 1));
  const selectionEnd = Math.max(selectionStart + 1, Math.min(currentText.length, selectionStart + 12));

  await receiverPage.evaluate(({ blockId, selectionStart, selectionEnd }) => {
    const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
    if (!(editable instanceof HTMLElement)) throw new Error('editable block was not found');
    editable.focus();
    const nodeAtOffset = (root, offset) => {
      let remaining = offset;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      let last = null;
      while (text) {
        last = text;
        const length = text.textContent?.length ?? 0;
        if (remaining <= length) return { node: text, offset: remaining };
        remaining -= length;
        text = walker.nextNode();
      }
      return last ? { node: last, offset: last.textContent?.length ?? 0 } : null;
    };
    const start = nodeAtOffset(editable, selectionStart);
    const end = nodeAtOffset(editable, selectionEnd);
    if (!start || !end) throw new Error('selection range nodes were not found');
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, {
    blockId: seed.blockId,
    selectionEnd,
    selectionStart,
  });

  await senderPage.evaluate(({ blockId, operation, pageId, updatedAt }) => {
    window.dispatchEvent(
      new CustomEvent('notionlike:page-crdt-update', {
        detail: {
          blockId,
          operation,
          pageId,
          revision: Date.now(),
          updatedAt,
        },
      }),
    );
  }, {
    blockId: seed.blockId,
    operation,
    pageId: seed.pageId,
    updatedAt,
  });

  await receiverPage
    .locator(`[data-block-id="${seed.blockId}"]`)
    .getByText(nextText, { exact: true })
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
  await receiverPage.waitForFunction(
    ({ blockId, selectionStart, selectionEnd }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      if (!(editable instanceof HTMLElement) || !editable.contains(document.activeElement)) return false;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      const range = selection.getRangeAt(0).cloneRange();
      if (!editable.contains(range.startContainer) || !editable.contains(range.endContainer)) return false;
      if (range.collapsed) return false;
      const startRange = document.createRange();
      startRange.selectNodeContents(editable);
      startRange.setEnd(range.startContainer, range.startOffset);
      const endRange = document.createRange();
      endRange.selectNodeContents(editable);
      endRange.setEnd(range.endContainer, range.endOffset);
      return startRange.toString().length === selectionStart && endRange.toString().length === selectionEnd;
    },
    {
      blockId: seed.blockId,
      selectionEnd,
      selectionStart,
    },
    { timeout: options.timeoutMs },
  );
}

async function assertDivergentActiveEditorCrdtMerge(senderPage, receiverPage, seed) {
  const localText = `Local active divergent ${randomUUID()}`;
  const remoteText = `Remote active divergent ${randomUUID()}`;
  const updatedAt = new Date(Date.now() + 180_000).toISOString();
  const operation = await syntheticYjsBlockTextUpdate({
    blockId: seed.blockId,
    rich: [{ text: remoteText }],
    updatedAt,
  });

  await receiverPage.evaluate(({ blockId, localText }) => {
    const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
    if (!(editable instanceof HTMLElement)) throw new Error('editable block was not found');
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('insertText', false, localText);
  }, {
    blockId: seed.blockId,
    localText,
  });
  await receiverPage.waitForFunction(
    ({ blockId, localText }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      return editable?.textContent?.includes(localText) === true;
    },
    { blockId: seed.blockId, localText },
    { timeout: options.timeoutMs },
  );
  await receiverPage.waitForTimeout(250);

  await senderPage.evaluate(({ blockId, operation, pageId, updatedAt }) => {
    window.dispatchEvent(
      new CustomEvent('notionlike:page-crdt-update', {
        detail: {
          blockId,
          operation,
          pageId,
          revision: Date.now(),
          updatedAt,
        },
      }),
    );
  }, {
    blockId: seed.blockId,
    operation,
    pageId: seed.pageId,
    updatedAt,
  });

  await receiverPage.waitForFunction(
    ({ blockId, localText, remoteText }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      const text = editable?.textContent ?? '';
      return text.includes(localText) && text.includes(remoteText);
    },
    { blockId: seed.blockId, localText, remoteText },
    { timeout: options.timeoutMs },
  );
  await receiverPage.waitForFunction(
    ({ blockId }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      return editable instanceof HTMLElement && editable.contains(document.activeElement);
    },
    { blockId: seed.blockId },
    { timeout: options.timeoutMs },
  );
}

async function assertScopedYjsTextUndo(senderPage, receiverPage, seed) {
  const baselineText = `Scoped undo baseline ${randomUUID()}`;
  const localText = `Scoped local undo ${randomUUID()}`;
  const remoteText = `Scoped remote keep ${randomUUID()}`;
  const baselineUpdatedAt = new Date(Date.now() + 210_000).toISOString();
  const remoteUpdatedAt = new Date(Date.now() + 220_000).toISOString();
  const baselineOperation = await syntheticYjsBlockTextUpdate({
    blockId: seed.blockId,
    rich: [{ text: baselineText }],
    updatedAt: baselineUpdatedAt,
  });
  const remoteOperation = await syntheticYjsBlockTextUpdate({
    blockId: seed.blockId,
    rich: [{ text: remoteText }],
    updatedAt: remoteUpdatedAt,
  });

  await receiverPage.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await senderPage.evaluate(({ blockId, operation, pageId, updatedAt }) => {
    window.dispatchEvent(
      new CustomEvent('notionlike:page-crdt-update', {
        detail: {
          blockId,
          operation,
          pageId,
          revision: Date.now(),
          updatedAt,
        },
      }),
    );
  }, {
    blockId: seed.blockId,
    operation: baselineOperation,
    pageId: seed.pageId,
    updatedAt: baselineUpdatedAt,
  });

  await receiverPage
    .locator(`[data-block-id="${seed.blockId}"]`)
    .getByText(baselineText, { exact: true })
    .waitFor({ state: 'visible', timeout: options.timeoutMs });

  await receiverPage.evaluate(({ blockId, localText }) => {
    const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
    if (!(editable instanceof HTMLElement)) throw new Error('editable block was not found');
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('insertText', false, localText);
  }, {
    blockId: seed.blockId,
    localText,
  });
  await receiverPage.waitForFunction(
    ({ blockId, localText }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      return editable instanceof HTMLElement && editable.textContent === localText;
    },
    { blockId: seed.blockId, localText },
    { timeout: options.timeoutMs },
  );
  await receiverPage.waitForTimeout(300);

  await senderPage.evaluate(({ blockId, operation, pageId, updatedAt }) => {
    window.dispatchEvent(
      new CustomEvent('notionlike:page-crdt-update', {
        detail: {
          blockId,
          operation,
          pageId,
          revision: Date.now(),
          updatedAt,
        },
      }),
    );
  }, {
    blockId: seed.blockId,
    operation: remoteOperation,
    pageId: seed.pageId,
    updatedAt: remoteUpdatedAt,
  });

  await receiverPage.waitForFunction(
    ({ blockId, localText, remoteText }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      const text = editable?.textContent ?? '';
      return text.includes(localText) && text.includes(remoteText);
    },
    { blockId: seed.blockId, localText, remoteText },
    { timeout: options.timeoutMs },
  );

  await receiverPage.keyboard.press(shortcut('z'));
  await receiverPage.waitForFunction(
    ({ blockId, localText, remoteText }) => {
      const editable = document.querySelector(`[data-block-id="${blockId}"] [data-rt-editable="true"]`);
      const text = editable?.textContent ?? '';
      return !text.includes(localText) && text.includes(remoteText);
    },
    { blockId: seed.blockId, localText, remoteText },
    { timeout: options.timeoutMs },
  );
  await senderPage.waitForFunction(
    ({ blockId, localText, remoteText }) => {
      const block = document.querySelector(`[data-block-id="${blockId}"]`);
      const text = block?.textContent ?? '';
      return !text.includes(localText) && text.includes(remoteText);
    },
    { blockId: seed.blockId, localText, remoteText },
    { timeout: options.timeoutMs },
  );
}

async function assertDurableCrdtDocumentResync(browser, baseUrl, apiUrl, seed) {
  const durableText = `Durable CRDT reload ${randomUUID()}`;
  const updatedAt = new Date(Date.now() + 240_000).toISOString();
  const operation = await syntheticYjsBlockTextUpdate({
    blockId: seed.blockId,
    rich: [{ text: durableText }],
    updatedAt,
  });

  await callFunction(apiUrl, seed.owner.accessToken, 'collaboration-mutation', {
    action: 'create',
    blockId: seed.blockId,
    clientId: 'presence-durable-resync-smoke',
    kind: 'crdt_update',
    operation,
    pageId: seed.pageId,
    revision: Date.now() + 1,
    occurredAt: updatedAt,
  });

  const resync = await newCheckedPage(browser);
  await seedSession(resync.context, seed.viewer);
  try {
    const documentResyncSeen = resync.page.waitForResponse(async (response) => {
      if (!response.url().includes('/api/functions/collaboration-mutation')) return false;
      const request = response.request();
      if (request.method() !== 'POST') return false;
      return request.postData()?.includes('"action":"documents"') === true;
    }, { timeout: options.timeoutMs });

    await openPage(resync.page, baseUrl, seed.pageId, seed.title, 'durable resync viewer');
    await documentResyncSeen;
    await resync.page.waitForFunction(
      ({ blockId, durableText }) => {
        const block = document.querySelector(`[data-block-id="${blockId}"]`);
        return block?.textContent?.includes(durableText) === true;
      },
      { blockId: seed.blockId, durableText },
      { timeout: options.timeoutMs },
    );
    assertNoBrowserErrors(resync.errors, 'durable CRDT resync page');
  } finally {
    await persistSessionFromContext(resync.context, seed.viewer);
    await resync.context.close().catch(() => {});
  }
}

async function openPage(page, baseUrl, pageId, title, label = 'page') {
  await page.goto(resolveUrl(baseUrl, `/p/${pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  try {
    await page.waitForFunction(
      ({ title }) =>
        Array.from(document.querySelectorAll('[role="textbox"][aria-label]')).some((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const label = element.getAttribute('aria-label');
          if (label !== 'Page title' && label !== '페이지 제목') return false;
          const visible = !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
          return visible && (element.innerText || element.textContent || '').includes(title);
        }),
      { title },
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      bodyText: document.body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 600) ?? '',
      path: window.location.pathname,
      textboxes: Array.from(document.querySelectorAll('[role="textbox"][aria-label]')).map((element) => ({
        ariaLabel: element.getAttribute('aria-label'),
        text: element instanceof HTMLElement ? (element.innerText || element.textContent || '').slice(0, 200) : '',
        visible: !!(
          element instanceof HTMLElement &&
          (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        ),
      })),
      title: document.title,
    }));
    throw new Error([
      `${label}: page ${pageId} did not show seeded title "${title}"`,
      error instanceof Error ? error.message : String(error),
      `browserErrors: ${JSON.stringify(page.__notionlikeErrors ?? [])}`,
      JSON.stringify(diagnostics, null, 2),
    ].join('\n'));
  }
  const path = new URL(page.url()).pathname;
  assert(path === `/p/${pageId}`, `direct page route changed to ${path}`);
}

async function seedSession(context, session) {
  await installBrowserSession(context, session, {
    appOrigin: options.url,
    authOrigin: options.apiUrl,
    workspaceId: session.workspaceId,
    localStorage: {
      'notionlike.debugPresence': '1',
    },
  });
}

async function persistSessionFromContext(context, session) {
  await captureBrowserSession(context, session, {
    appOrigin: options.url,
    authOrigin: options.apiUrl,
  });
}

async function collectPresenceDiagnostics(page, label) {
  const diagnostics = await page.evaluate(() => {
    const presence =
      document.querySelector('[data-testid="topbar-page-presence"]') ??
      document.querySelector('[data-testid="page-presence"]');
    const labelled = Array.from(
      document.querySelectorAll('[aria-label*="connected"], [data-testid="topbar-page-presence"], [data-testid="page-presence"]'),
    ).map((element) => ({
      ariaLabel: element.getAttribute('aria-label'),
      dataStatus: element.getAttribute('data-status'),
      html: element.outerHTML.slice(0, 800),
      visible: !!(
        element instanceof HTMLElement &&
        (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      ),
    }));
    return {
      bodyText: document.body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 400) ?? '',
      debug: window.__notionlikePresenceDebug ?? null,
      hasPresenceNode: !!presence,
      labelled,
      path: window.location.pathname,
      title: document.title,
    };
  });
  return {
    label,
    url: page.url(),
    ...diagnostics,
  };
}

async function newCheckedPage(browser, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.__notionlikeErrors = errors;
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

function removeExpectedOfflineNetworkErrors(errors) {
  const unexpectedErrors = errors.filter((message) => (
    !message.includes('Failed to load resource: net::ERR_INTERNET_DISCONNECTED')
  ));
  errors.length = 0;
  errors.push(...unexpectedErrors);
}

async function seedPresencePage(baseUrl) {
  const owner = await signIn(baseUrl);
  const viewer = await signIn(baseUrl);
  const readonlyViewer = await signIn(baseUrl);
  assert(
    new Set([owner.userId, viewer.userId, readonlyViewer.userId]).size === 3,
    'presence smoke requires three different users',
  );

  const bootstrap = await callFunction(baseUrl, owner.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for presence smoke');

  const pageId = randomUUID();
  const blockId = randomUUID();
  const databaseId = randomUUID();
  const databaseTitlePropertyId = randomUUID();
  const databaseRowId = randomUUID();
  const title = `Presence smoke ${pageId}`;
  const databaseTitle = `Presence database ${databaseId}`;
  const created = await callFunction(baseUrl, owner.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'presence smoke page must be created');

  const block = await callFunction(baseUrl, owner.accessToken, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Presence smoke shared editing block' }] },
    plainText: 'Presence smoke shared editing block',
    position: 1,
  });
  assert(block?.block?.id === blockId, 'presence smoke block must be created');

  const database = await callFunction(baseUrl, owner.accessToken, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: databaseTitle,
    position: 2,
    viewType: 'table',
    seedRows: false,
    properties: [
      { id: databaseTitlePropertyId, name: 'Name', type: 'title', position: 1 },
    ],
  });
  assert(database?.page?.id === databaseId, 'presence smoke database must be created');

  const databaseRow = await callFunction(baseUrl, owner.accessToken, 'database-row-mutation', {
    action: 'create',
    id: databaseRowId,
    databaseId,
    title: 'Presence row',
    properties: {},
  });
  assert(databaseRow?.row?.id === databaseRowId, 'presence smoke database row must be created');

  const access = await callFunction(baseUrl, owner.accessToken, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'Presence smoke viewer',
    role: 'edit',
  });
  assert(access?.permission?.id, 'presence smoke viewer must receive edit access');

  const databaseAccess = await callFunction(baseUrl, owner.accessToken, 'share-mutation', {
    action: 'invite',
    pageId: databaseId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'Presence smoke database viewer',
    role: 'edit',
  });
  assert(databaseAccess?.permission?.id, 'presence smoke database viewer must receive edit access');

  const readonlyAccess = await callFunction(baseUrl, owner.accessToken, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: readonlyViewer.userId,
    label: 'Presence smoke read-only viewer',
    role: 'view',
  });
  assert(readonlyAccess?.permission?.id, 'presence smoke read-only viewer must receive view access');

  return {
    blockId,
    databaseId,
    databaseRowId,
    databaseTitle,
    databaseTitlePropertyId,
    pageId,
    title,
    owner: {
      accessToken: owner.accessToken,
      refreshToken: owner.refreshToken,
      workspaceId,
    },
    viewer: {
      accessToken: viewer.accessToken,
      refreshToken: viewer.refreshToken,
      userId: viewer.userId,
      workspaceId,
    },
    readonlyViewer: {
      accessToken: readonlyViewer.accessToken,
      refreshToken: readonlyViewer.refreshToken,
      userId: readonlyViewer.userId,
      workspaceId,
    },
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.owner?.accessToken || !seed?.pageId) return;
  if (seed.databaseId) {
    await callFunction(baseUrl, seed.owner.accessToken, 'page-mutation', {
      action: 'delete',
      id: seed.databaseId,
    });
  }
  await callFunction(baseUrl, seed.owner.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.pageId,
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

async function loadYjs() {
  if (!yjsModulePromise) yjsModulePromise = import(requireFromWeb.resolve('yjs'));
  return yjsModulePromise;
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function syntheticYjsBlockTextUpdate({ blockId, rich, updatedAt }) {
  const Y = await loadYjs();
  const doc = new Y.Doc();
  const plainText = rich.map((span) => (typeof span?.text === 'string' ? span.text : '')).join('');
  const textKey = `block:${blockId}:plainText`;
  doc.transact(() => {
    const text = doc.getText(textKey);
    if (plainText) text.insert(0, plainText);
    doc.getMap('blocks').set(blockId, {
      kind: 'block_text_snapshot',
      schemaVersion: 2,
      rich,
      plainText,
      crdtTextKey: textKey,
      updatedAt,
    });
  });
  return {
    engine: 'yjs',
    schemaVersion: 2,
    documentId: `block:${blockId}`,
    updateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    stateVectorBase64: bytesToBase64(Y.encodeStateVector(doc)),
  };
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
    'Playwright is required for presence UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return undefined;
}

function shortcut(kind) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  if (kind === 'redo') return process.platform === 'darwin' ? `${mod}+Shift+Z` : `${mod}+Y`;
  return `${mod}+Z`;
}

function parseArgs(args) {
  const parsed = {
    apiUrl: undefined,
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
    if (arg === '--api-url') {
      parsed.apiUrl = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.apiUrl ??= parsed.url;
  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/presence-ui-smoke.mjs [options]

Checks that desktop and mobile browser sessions can join the same page presence
room, that an offline/online transition recovers, and that remote editing
awareness plus live CRDT room text updates apply, including the active-editor
caret-preservation, divergent active-editor merge, and durable CRDT reload-resync
paths, without screenshots.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or http://127.0.0.1:8787.
  --api-url <url>         EdgeBase API URL when checking a separate Vite frontend.
  --timeout-ms <number>   Per-action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --headed                Show the browser window.
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
  if (!condition) {
    throw new Error(message);
  }
}
