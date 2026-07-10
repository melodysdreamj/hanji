#!/usr/bin/env node

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 20_000;
const SHORTCUT_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL block editor UI smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const appUrl = normalizeBaseUrl(options.url);
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Block editor UI smoke target: ${appUrl}`);

  await assertRuntimeReachable(apiUrl);
  const seed = await seedEditorPage(apiUrl);
  const { chromium } = await loadPlaywright();
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    await assertBlockEditorUi(browser, appUrl, apiUrl, seed);
    if (options.onlyFileDrop) {
      console.log('PASS block editor external file drops upload through block rows and empty media cards.');
    } else if (options.onlyFocusFlow) {
      console.log('PASS block creation focus and Enter continuation work across representative block types.');
    } else if (options.onlySlashPageTitle) {
      console.log('PASS slash /page creates an empty-titled page with placeholder-only title chrome.');
    } else if (options.onlyPastedUrlMention) {
      console.log('PASS pasted external URLs default to mention conversion with fetched title and favicon.');
    } else if (options.onlyEmbedCaptionSlash) {
      console.log('PASS embed blocks hide empty captions by default and continue writing in the next paragraph.');
    } else if (options.onlyImeFlow) {
      console.log('PASS IME Enter commits composed text and continues to the next block without copying the composing tail.');
    } else if (options.onlyEmptyListEnter) {
      console.log('PASS empty list and container Enter exits keep the caret in the natural next writing position.');
    } else if (options.onlyMarkdownShortcuts) {
      console.log('PASS Markdown and symbol typing shortcuts match the editor contract.');
    } else if (options.onlySelectionToolbar) {
      console.log('PASS selected-text toolbar keeps context while applying inline formatting and opening the link editor.');
    } else if (options.onlyTabs) {
      console.log('PASS slash-created tabs rename, reorder, and delete with IME-safe Enter handling.');
    } else if (options.onlySelectionEdit) {
      console.log('PASS Enter and paste over a non-collapsed selection replace the selected text.');
    } else {
      console.log('PASS block editor text input, rich HTML paste, keyboard formatting shortcuts, slash commands, synced blocks, tabs, pasted/imported tab icons, columns, buttons, Markdown shortcuts, to-dos, toggles, and dividers persist through the product API without screenshots.');
    }
  } finally {
    await Promise.race([browser.close(), delay(5000)]).catch(() => {});
    await cleanupSeed(apiUrl, seed).catch(() => {});
  }
}

async function assertBlockEditorUi(browser, appUrl, apiUrl, seed) {
  const { context, page, errors } = await newCheckedPage(browser);
  await seedSession(context, seed);

  try {
    await step('open seeded editor page', () => openPage(page, appUrl, seed));
    if (options.onlyFileDrop) {
      await step('drop an external file onto a block row', () => assertFileDropUpload(page, apiUrl, seed));
      await step('drop a video file onto an empty video card', () => assertMediaPlaceholderDropUpload(page, apiUrl, seed));
      assertNoBrowserErrors(errors, 'block editor file drop flow');
      return;
    }
    if (options.onlyFocusFlow) {
      await step('create representative blocks with immediate focus and Enter continuation', () =>
        assertBlockCreationFocusFlow(page, apiUrl, seed)
      );
      assertNoBrowserErrors(
        errors.filter((message) => !isExpectedExternalEmbedBrowserMessage(message)),
        'block editor focus flow',
      );
      return;
    }
    if (options.onlySlashPageTitle) {
      await step('create a blank child page through /page without saving Untitled', () =>
        assertSlashPageCreatesEmptyTitle(page, apiUrl, seed)
      );
      assertNoBrowserErrors(
        errors.filter((message) => !message.includes('Failed to load resource:')),
        'block editor slash page title flow',
      );
      return;
    }
    if (options.onlyPastedUrlMention) {
      await step('paste an external URL and press Enter to create a metadata mention', () =>
        assertPastedUrlMention(page, apiUrl, seed)
      );
      assertNoBrowserErrors(
        errors.filter((message) => !message.includes('Failed to load resource:')),
        'block editor pasted URL mention flow',
      );
      return;
    }
    if (options.onlyEmbedCaptionSlash) {
      await step('hide the empty embed caption and continue slash commands in the following paragraph', () =>
        assertEmbedHasNoDefaultCaptionAndContinues(page, apiUrl, seed)
      );
      assertNoBrowserErrors(
        errors.filter((message) => !isExpectedExternalEmbedBrowserMessage(message)),
        'block editor default-hidden embed caption flow',
      );
      return;
    }
    if (options.onlyImeFlow) {
      await step('commit IME text and continue to the next block without copying the composing tail', () =>
        assertImeEnterContinuesAfterCompositionWithoutCopying(page, apiUrl, seed)
      );
      assertNoBrowserErrors(errors, 'block editor IME flow');
      return;
    }
    if (options.onlyEmptyListEnter) {
      await step('exit empty lists and nested containers without losing the caret', () =>
        assertEmptyListEnterEscapes(page, apiUrl, seed)
      );
      assertNoBrowserErrors(errors, 'block editor empty list Enter flow');
      return;
    }
    if (options.onlyMarkdownShortcuts) {
      await step('turn Markdown shortcuts into structured blocks and symbols', () =>
        assertMarkdownShortcuts(page, apiUrl, seed)
      );
      assertNoBrowserErrors(
        errors.filter((message) => !message.includes('Failed to load resource:')),
        'block editor Markdown shortcut flow',
      );
      return;
    }
    if (options.onlySelectionToolbar) {
      await step('keep selected-text toolbar open across inline formatting clicks', () =>
        assertSelectionToolbarKeepsContext(page, apiUrl, seed)
      );
      assertNoBrowserErrors(errors, 'block editor selection toolbar flow');
      return;
    }
    if (options.onlyTabs) {
      await step('create and switch tabs through slash commands and keyboard', () =>
        assertSlashTabs(page, apiUrl, seed)
      );
      assertNoBrowserErrors(errors, 'block editor tabs flow');
      return;
    }
    if (options.onlySelectionEdit) {
      await step('replace a non-collapsed selection on Enter and paste', () =>
        assertSelectionReplacedOnEnterAndPaste(page, apiUrl, seed)
      );
      assertNoBrowserErrors(errors, 'block editor selection-edit flow');
      return;
    }
    await step('type plain text into a block', () => assertPlainTextInput(page, apiUrl, seed));
    await step('replace a non-collapsed selection on Enter and paste', () =>
      assertSelectionReplacedOnEnterAndPaste(page, apiUrl, seed)
    );
    await step('commit IME text and continue to the next block without copying the composing tail', () =>
      assertImeEnterContinuesAfterCompositionWithoutCopying(page, apiUrl, seed)
    );
    await step('format selected text with keyboard shortcuts', () => assertKeyboardTextMarkShortcuts(page, apiUrl, seed));
    await step('paste rich HTML into a paragraph', () => assertRichHtmlPaste(page, apiUrl, seed));
    await step('drop an external file onto a block row', () => assertFileDropUpload(page, apiUrl, seed));
    await step('drop a video file onto an empty video card', () => assertMediaPlaceholderDropUpload(page, apiUrl, seed));
    await step('paste single-paragraph rich HTML without page mentions', () =>
      assertSingleParagraphRichHtmlPaste(page, apiUrl, seed)
    );
    await step('create and check a to-do through slash commands', () => assertSlashTodo(page, apiUrl, seed));
    await step('create a blank child page through /page without saving Untitled', () =>
      assertSlashPageCreatesEmptyTitle(page, apiUrl, seed)
    );
    await step('paste an external URL and press Enter to create a metadata mention', () =>
      assertPastedUrlMention(page, apiUrl, seed)
    );
    await step('create and switch tabs through slash commands and keyboard', () => assertSlashTabs(page, apiUrl, seed));
    await step('paste Markdown tabs into a structured tabs block', () => assertPastedMarkdownTabs(page, apiUrl, seed));
    await step('paste HTML tabs into a structured tabs block', () => assertPastedHtmlTabs(page, apiUrl, seed));
    await step('render imported tab icons and body structure', () => assertImportedIconTabs(page, apiUrl, seed));
    await step('create and manage columns through slash commands', () => assertSlashColumns(page, apiUrl, seed));
    await step('create, configure, and run a button block', () => assertSlashButton(page, apiUrl, seed));
    await step('create, copy, and unsync a synced block', () => assertSlashSyncedBlock(page, apiUrl, seed));
    await step('turn Markdown shortcuts into structured blocks', () => assertMarkdownShortcuts(page, apiUrl, seed));
    await step('exit empty lists and nested containers without losing the caret', () =>
      assertEmptyListEnterEscapes(page, apiUrl, seed)
    );
    assertNoBrowserErrors(errors, 'block editor UI flow');
  } finally {
    await context.close().catch(() => {});
  }
}

async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

// Column controls only appear while the pointer sits in the column's
// top-right hotspot (right 96px, top -28..+34 — see updateColumnControlsHotspot
// in BlockItem); a center hover leaves them pointer-events: none.
async function hoverColumnControlsHotspot(column) {
  const box = await column.boundingBox();
  if (!box) throw new Error('column bounding box unavailable');
  await column.hover({
    position: { x: Math.max(1, box.width - 20), y: Math.min(10, Math.max(1, box.height / 2)) },
    timeout: options.timeoutMs,
  });
}

async function openPage(page, baseUrl, seed) {
  await page.goto(resolveUrl(baseUrl, `/p/${seed.pageId}`), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.getByRole('region', { name: 'Page body' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await expectPageTitle(page, seed.title);
  await blockTextBox(page, seedBlockId(seed, 'plain'), 'Text block text').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertPlainTextInput(page, baseUrl, seed) {
  await typeIntoBlock(page, seed.blockIds.plain, 'Text block text', seed.plainText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.plain,
    (block) => block?.type === 'paragraph' && block?.plainText === seed.plainText,
    'plain text paragraph',
  );
}

async function assertSelectionReplacedOnEnterAndPaste(page, baseUrl, seed) {
  // Editor-2/3: a non-collapsed selection must be deleted before Enter splits
  // the block or a paste inserts — otherwise the "selected" text survives in one
  // of the halves (Enter) or beside the pasted text (paste). Unique tokens keep
  // the assertions scoped without needing to know the split block's new id.

  // Enter over a selection replaces it with a paragraph break.
  const enterId = seedBlockId(seed, 'selectionEnter');
  await typeIntoBlock(page, enterId, 'Text block text', 'ALPHA BRAVO CHARLIE');
  await waitForBlock(
    baseUrl,
    seed,
    enterId,
    (block) => block?.plainText === 'ALPHA BRAVO CHARLIE',
    'selection-enter seed text',
  );
  await selectTextInLocator(blockTextBox(page, enterId, 'Text block text'), 'BRAVO ');
  await page.keyboard.press('Enter');
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      if (blocks.some((block) => (block.plainText ?? '').includes('BRAVO'))) return false;
      const hasAlpha = blocks.some((block) => (block.plainText ?? '').includes('ALPHA'));
      const hasCharlie = blocks.some((block) => (block.plainText ?? '').includes('CHARLIE'));
      return hasAlpha && hasCharlie;
    },
    'Enter over a selection deletes the selected text and splits the block',
  );

  // A structured (multi-line) paste over a selection replaces it: the plain
  // single-line paste path is handled natively by the browser, but the app's
  // own structured-paste path (splitting the block to insert parsed blocks)
  // must delete the selected text first rather than split around it.
  const pasteId = seedBlockId(seed, 'selectionPaste');
  await typeIntoBlock(page, pasteId, 'Text block text', 'DELTA ECHO FOXTROT');
  await waitForBlock(
    baseUrl,
    seed,
    pasteId,
    (block) => block?.plainText === 'DELTA ECHO FOXTROT',
    'selection-paste seed text',
  );
  await selectTextInLocator(blockTextBox(page, pasteId, 'Text block text'), 'ECHO');
  await pastePlainText(blockTextBox(page, pasteId, 'Text block text'), 'XRAY\nYANKEE');
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      if (blocks.some((block) => (block.plainText ?? '').includes('ECHO'))) return false;
      return blocks.some((block) => (block.plainText ?? '').includes('XRAY'));
    },
    'Structured paste over a selection deletes the selected text',
  );
}

async function assertImeEnterContinuesAfterCompositionWithoutCopying(page, baseUrl, seed) {
  for (const imeCase of seed.imeCases) {
    const beforeBlocks = await fetchSeedBlocks(baseUrl, seed);
    const textbox = blockTextBox(page, imeCase.blockId, 'Text block text');
    await textbox.click({ timeout: options.timeoutMs });
    await page.evaluate(({ blockId, composingText, label }) => {
      const editable = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"] [data-rt-editable="true"]`);
      if (!(editable instanceof HTMLElement)) throw new Error(`${label} IME editable block missing`);
      editable.focus();
      const node = editable.firstChild;
      if (!node) throw new Error(`${label} IME editable text node missing`);
      const text = node.textContent ?? '';
      const composingStart = Math.max(0, text.length - composingText.length);
      const setCaret = (offset) => {
        const range = document.createRange();
        range.setStart(node, Math.max(0, Math.min(offset, text.length)));
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      };
      const dispatchParagraphBeforeInput = () => {
        editable.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertParagraph',
          }),
        );
      };
      setCaret(composingStart);
      editable.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: composingText }));
      editable.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          which: 229,
          isComposing: true,
        }),
      );

      if (label === 'Chinese') {
        dispatchParagraphBeforeInput();
      }

      setCaret(text.length);
      editable.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: composingText }));

      if (label === 'Japanese') {
        dispatchParagraphBeforeInput();
        return;
      }
      if (label === 'Chinese') return;

      editable.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          code: 'Enter',
        }),
      );
    }, imeCase);

    const blocks = await waitForBlocks(
      baseUrl,
      seed,
      (blocks) => {
        if (blocks.length !== beforeBlocks.length + 1) return false;
        const anchor = blocks.find((block) => block.id === imeCase.blockId);
        if (anchor?.type !== 'paragraph' || anchor.plainText !== imeCase.text) return false;
        const siblings = blocks
          .filter((block) => block.parentId === (anchor.parentId ?? null))
          .sort((a, b) => a.position - b.position);
        const anchorIndex = siblings.findIndex((block) => block.id === anchor.id);
        const next = siblings[anchorIndex + 1];
        return next?.type === 'paragraph' && (next.plainText ?? '') === '';
      },
      `${imeCase.label} IME Enter should commit text and create the next blank paragraph`,
    );
    const anchor = blocks.find((block) => block.id === imeCase.blockId);
    const siblings = blocks
      .filter((block) => block.parentId === (anchor?.parentId ?? null))
      .sort((a, b) => a.position - b.position);
    const next = siblings[siblings.findIndex((block) => block.id === imeCase.blockId) + 1];
    assert(next?.id, `${imeCase.label} IME Enter should create a following paragraph`);
    await waitForFocusedBlockTextbox(page, next.id, 'Text block text');
    assert(
      !blocks.some((block) =>
        block.id !== imeCase.blockId &&
        block.parentId === null &&
        block.type === 'paragraph' &&
        block.plainText === imeCase.composingText
      ),
      `${imeCase.label} IME Enter should not copy the composing tail into a new paragraph: ${JSON.stringify(blocks)}`,
    );
  }
}

async function assertKeyboardTextMarkShortcuts(page, baseUrl, seed) {
  const textbox = blockTextBox(page, seed.blockIds.keyboardMarks, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type(seed.keyboardMarkText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.keyboardMarks,
    (block) => block?.type === 'paragraph' && block?.plainText === seed.keyboardMarkText,
    'keyboard shortcut seed text',
  );

  await pressTextMarkShortcut(page, textbox, seed.keyboardMarkSegments.bold, `${SHORTCUT_MODIFIER}+B`);
  await pressTextMarkShortcut(page, textbox, seed.keyboardMarkSegments.italic, `${SHORTCUT_MODIFIER}+I`);
  await pressTextMarkShortcut(page, textbox, seed.keyboardMarkSegments.underline, `${SHORTCUT_MODIFIER}+U`);
  await pressTextMarkShortcut(page, textbox, seed.keyboardMarkSegments.code, `${SHORTCUT_MODIFIER}+E`);
  await pressTextMarkShortcut(page, textbox, seed.keyboardMarkSegments.strike, `${SHORTCUT_MODIFIER}+Shift+S`);

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.keyboardMarks,
    (block) => {
      if (block?.type !== 'paragraph' || block.plainText !== seed.keyboardMarkText) return false;
      const rich = Array.isArray(block.content?.rich) ? block.content.rich : [];
      return (
        rich.some((span) => span.text === seed.keyboardMarkSegments.bold && span.bold === true) &&
        rich.some((span) => span.text === seed.keyboardMarkSegments.italic && span.italic === true) &&
        rich.some((span) => span.text === seed.keyboardMarkSegments.underline && span.underline === true) &&
        rich.some((span) => span.text === seed.keyboardMarkSegments.code && span.code === true) &&
        rich.some((span) => span.text === seed.keyboardMarkSegments.strike && span.strikethrough === true)
      );
    },
    'keyboard formatting shortcuts',
  );
}

async function assertSelectionToolbarKeepsContext(page, baseUrl, seed) {
  const selectedText = 'Toolbar';
  const text = `${selectedText} context ${Date.now()}`;
  const linkUrl = `https://example.com/selection-toolbar-${Date.now()}`;
  const textbox = blockTextBox(page, seed.blockIds.keyboardMarks, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type(text);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.keyboardMarks,
    (block) => block?.type === 'paragraph' && block?.plainText === text,
    'selection toolbar seed text',
  );

  await selectTextInLocator(textbox, selectedText);
  const toolbar = page.getByRole('toolbar', { name: 'Text formatting' });
  await toolbar.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await toolbar.getByRole('button', { name: 'Bold' }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    (expected) => {
      const toolbar = document.querySelector('[role="toolbar"][aria-label="Text formatting"]');
      const bold = toolbar?.querySelector('[aria-label="Bold"]');
      return (
        toolbar instanceof HTMLElement &&
        bold?.getAttribute('aria-pressed') === 'true' &&
        window.getSelection()?.toString() === expected
      );
    },
    selectedText,
    { timeout: options.timeoutMs },
  );

  await page.getByRole('toolbar', { name: 'Text formatting' }).getByRole('button', { name: 'Link' }).click({
    timeout: options.timeoutMs,
  });
  const linkDialog = page.getByRole('dialog', { name: 'Edit link' });
  await linkDialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await page.waitForFunction(
    () =>
      document.querySelector('[role="toolbar"][aria-label="Text formatting"]') instanceof HTMLElement &&
      document.querySelector('[role="dialog"][aria-label="Edit link"]') instanceof HTMLElement,
    {},
    { timeout: options.timeoutMs },
  );
  await linkDialog.getByLabel('Link URL').fill(linkUrl, { timeout: options.timeoutMs });
  await linkDialog.getByRole('button', { name: /^Link$/ }).click({ timeout: options.timeoutMs });

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.keyboardMarks,
    (block) => {
      const rich = Array.isArray(block?.content?.rich) ? block.content.rich : [];
      return (
        block?.type === 'paragraph' &&
        block.plainText === text &&
        rich.some((span) => span.text === selectedText && span.bold === true && span.link === linkUrl)
      );
    },
    'selection toolbar inline bold link persistence',
  );
  await page.waitForFunction(
    (expected) => {
      const toolbar = document.querySelector('[role="toolbar"][aria-label="Text formatting"]');
      const link = toolbar?.querySelector('[aria-label="Link"]');
      return (
        toolbar instanceof HTMLElement &&
        link?.getAttribute('aria-pressed') === 'true' &&
        window.getSelection()?.toString() === expected
      );
    },
    selectedText,
    { timeout: options.timeoutMs },
  );
}

async function assertRichHtmlPaste(page, baseUrl, seed) {
  const suffix = Date.now();
  const boldText = `Bold ${suffix}`;
  const italicText = `Italic ${suffix}`;
  const underlineText = `Underline ${suffix}`;
  const strikeText = `Strike ${suffix}`;
  const codeText = `Code ${suffix}`;
  const linkText = `External ${suffix}`;
  const pageText = `Current page ${suffix}`;
  const dateText = `Today ${suffix}`;
  const personText = `Ada ${suffix}`;
  const colorText = `Blue ${suffix}`;
  const linkUrl = `https://example.com/rich-html-${suffix}`;
  const personId = `user-rich-html-${suffix}`;
  const html = [
    '<html><body><!--StartFragment--><p>',
    `<strong>${boldText}</strong> `,
    `<em>${italicText}</em> `,
    `<u>${underlineText}</u> `,
    `<s>${strikeText}</s> `,
    `<code>${codeText}</code> `,
    `<a href="${linkUrl}">${linkText}</a> `,
    `<a href="/p/${seed.pageId}">${pageText}</a> `,
    `<span data-mention="date" data-date="2026-06-25">${dateText}</span> `,
    `<span data-mention="person" data-user-id="${personId}">${personText}</span> `,
    `<span data-color="blue">${colorText}</span>`,
    '</p><!--EndFragment--></body></html>',
  ].join('');
  const plainText = [
    boldText,
    italicText,
    underlineText,
    strikeText,
    codeText,
    linkText,
    pageText,
    dateText,
    personText,
    colorText,
  ].join(' ');
  const textbox = blockTextBox(page, seed.blockIds.richPaste, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await pasteHtml(textbox, html, plainText);

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.richPaste,
    (block) => {
      if (block?.type !== 'paragraph' || block.plainText !== plainText) return false;
      const rich = Array.isArray(block.content?.rich) ? block.content.rich : [];
      return (
        rich.some((span) => span.text === boldText && span.bold === true) &&
        rich.some((span) => span.text === italicText && span.italic === true) &&
        rich.some((span) => span.text === underlineText && span.underline === true) &&
        rich.some((span) => span.text === strikeText && span.strikethrough === true) &&
        rich.some((span) => span.text === codeText && span.code === true) &&
        rich.some((span) => span.text === linkText && span.link === linkUrl) &&
        rich.some((span) => span.text === pageText && span.mention === 'page' && span.pageId === seed.pageId) &&
        rich.some((span) => span.text === dateText && span.mention === 'date' && span.date === '2026-06-25') &&
        rich.some((span) => span.text === personText && span.mention === 'person' && span.userId === personId) &&
        rich.some((span) => span.text === colorText && span.color === 'blue')
      );
    },
    'pasted rich HTML paragraph',
  );

  const group = blockGroup(page, seed.blockIds.richPaste);
  await group.getByText(linkText).waitFor({ state: 'visible', timeout: options.timeoutMs });
  // Date mentions display the live-computed label (Today/June 25), not the
  // pasted text — assert on the mention span itself (stored text is asserted
  // server-side above).
  await group.locator('[data-mention="date"][data-date="2026-06-25"]').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await group.getByText(personText).waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function assertFileDropUpload(page, baseUrl, seed) {
  const group = blockGroup(page, seed.blockIds.fileDrop);
  await group.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await group.evaluate((element) => {
    const row = element.querySelector('[data-type]');
    if (!(row instanceof HTMLElement)) throw new Error('file drop row is missing');
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([0x78, 0x01, 0x73, 0x0d])], 'dragged-installer.dmg', {
        type: 'application/x-apple-diskimage',
      }),
    );
    for (const type of ['dragenter', 'dragover', 'drop']) {
      row.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      );
    }
  });

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.fileDrop,
    (block) =>
      block?.type === 'file' &&
      block?.content?.fileName === 'dragged-installer.dmg' &&
      typeof block?.content?.url === 'string' &&
      block.content.url.includes('/api/storage/files/'),
    'dragged DMG file upload',
  );
}

async function assertMediaPlaceholderDropUpload(page, baseUrl, seed) {
  const group = blockGroup(page, seed.blockIds.videoDrop);
  await group.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await group.getByText('Embed video').waitFor({ state: 'visible', timeout: options.timeoutMs });
  await group.evaluate((element) => {
    const form = element.querySelector('form');
    if (!(form instanceof HTMLElement)) throw new Error('empty video form is missing');
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109])], 'dragged-video.mp4', {
        type: 'video/mp4',
      }),
    );
    for (const type of ['dragenter', 'dragover', 'drop']) {
      form.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      );
    }
  });

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.videoDrop,
    (block) =>
      block?.type === 'video' &&
      block?.content?.fileName === 'dragged-video.mp4' &&
      typeof block?.content?.url === 'string' &&
      block.content.url.includes('/api/storage/files/') &&
      block.plainText === 'dragged-video.mp4',
    'dragged video file upload into empty video card',
  );
  const videoCount = await fetchSeedBlocks(baseUrl, seed).then(
    (blocks) => blocks.filter((block) => block.type === 'video').length,
  );
  assert(videoCount === 1, `video card drop must not create an extra video block; count=${videoCount}`);
}

async function assertSingleParagraphRichHtmlPaste(page, baseUrl, seed) {
  const suffix = Date.now();
  const boldText = `Inline bold ${suffix}`;
  const linkText = `Inline link ${suffix}`;
  const dateText = `Inline date ${suffix}`;
  const dateTimeText = `Inline date time ${suffix}`;
  const personText = `Inline person ${suffix}`;
  const colorText = `Inline red ${suffix}`;
  const styleColorText = `Inline style blue ${suffix}`;
  const styleBackgroundText = `Inline style background ${suffix}`;
  const modernStyleColorText = `Inline modern style purple ${suffix}`;
  const alphaBackgroundText = `Inline alpha background ${suffix}`;
  const invalidColorText = `Invalid color ${suffix}`;
  const unsafeLinkText = `Unsafe link ${suffix}`;
  const invalidMentionText = `Invalid mention ${suffix}`;
  const invalidDateText = `Invalid date ${suffix}`;
  const invalidDateTimeText = `Invalid date time ${suffix}`;
  const linkUrl = `https://example.com/inline-rich-html-${suffix}`;
  const personId = `user-inline-rich-html-${suffix}`;
  const html = [
    '<html><body><!--StartFragment--><p>',
    `<strong>${boldText}</strong> `,
    `<a href="${linkUrl}">${linkText}</a> `,
    `<span data-mention="date" data-date="2026-06-25">${dateText}</span> `,
    `<span data-mention="date" data-date="2026-06-25T13:45:30Z">${dateTimeText}</span> `,
    `<span data-mention="person" data-user-id="${personId}">${personText}</span> `,
    `<span data-color="red">${colorText}</span> `,
    `<span style="color: rgb(51, 126, 169);">${styleColorText}</span> `,
    `<span style="background-color: rgb(251, 243, 219);">${styleBackgroundText}</span> `,
    `<span style="color: rgb(144 101 176 / 1);">${modernStyleColorText}</span> `,
    `<span style="background-color: rgba(244 240 247 / 0.8);">${alphaBackgroundText}</span> `,
    `<span data-color="notionlikeevil">${invalidColorText}</span> `,
    `<a href="javascript:alert(1)">${unsafeLinkText}</a> `,
    `<span data-mention="person" data-user-id="bad id with spaces">${invalidMentionText}</span> `,
    `<span data-mention="date" data-date="2026-06-25T@@@@">${invalidDateText}</span> `,
    `<span data-mention="date" data-date="2026-02-31T29:99:99Z">${invalidDateTimeText}</span>`,
    '</p><!--EndFragment--></body></html>',
  ].join('');
  const plainText = [
    boldText,
    linkText,
    dateText,
    dateTimeText,
    personText,
    colorText,
    styleColorText,
    styleBackgroundText,
    modernStyleColorText,
    alphaBackgroundText,
    invalidColorText,
    unsafeLinkText,
    invalidMentionText,
    invalidDateText,
    invalidDateTimeText,
  ].join(' ');
  const textbox = blockTextBox(page, seed.blockIds.richInlinePaste, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await pasteHtml(textbox, html, plainText);

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.richInlinePaste,
    (block) => {
      if (block?.type !== 'paragraph' || block.plainText !== plainText) return false;
      const rich = Array.isArray(block.content?.rich) ? block.content.rich : [];
      return (
        rich.some((span) => span.text === boldText && span.bold === true) &&
        rich.some((span) => span.text === linkText && span.link === linkUrl) &&
        rich.some((span) => span.text === dateText && span.mention === 'date' && span.date === '2026-06-25') &&
        rich.some((span) => span.text === dateTimeText && span.mention === 'date' && span.date === '2026-06-25T13:45:30Z') &&
        rich.some((span) => span.text === personText && span.mention === 'person' && span.userId === personId) &&
        rich.some((span) => span.text === colorText && span.color === 'red') &&
        rich.some((span) => span.text === styleColorText && span.color === 'blue') &&
        rich.some((span) => span.text === styleBackgroundText && span.color === 'yellow_background') &&
        rich.some((span) => span.text === modernStyleColorText && span.color === 'purple') &&
        rich.some((span) => span.text === alphaBackgroundText && span.color === 'purple_background') &&
        rich.some((span) => typeof span.text === 'string' && span.text.includes(invalidColorText) && !span.color) &&
        rich.some((span) => typeof span.text === 'string' && span.text.includes(unsafeLinkText) && !span.link) &&
        rich.some((span) => typeof span.text === 'string' && span.text.includes(invalidMentionText) && !span.mention) &&
        rich.some((span) => typeof span.text === 'string' && span.text.includes(invalidDateText) && !span.mention) &&
        rich.some((span) => typeof span.text === 'string' && span.text.includes(invalidDateTimeText) && !span.mention)
      );
    },
    'single-paragraph rich HTML paste without page mentions',
  );
}

async function assertSlashTodo(page, baseUrl, seed) {
  const textbox = blockTextBox(page, seed.blockIds.todo, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type('/todo');

  const menu = page.getByRole('listbox', { name: 'Block commands' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('option', { name: /To-do list/ }).click({ timeout: options.timeoutMs });

  await waitForBlock(baseUrl, seed, seed.blockIds.todo, (block) => block?.type === 'to_do', 'slash to-do type');
  await blockTextBox(page, seed.blockIds.todo, 'To-do list block text').type(seed.todoText, {
    timeout: options.timeoutMs,
  });
  await blockGroup(page, seed.blockIds.todo).getByRole('checkbox', { name: 'Mark to-do as complete' }).click({
    timeout: options.timeoutMs,
  });

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.todo,
    (block) =>
      block?.type === 'to_do' &&
      block?.plainText === seed.todoText &&
      block?.content?.checked === true,
    'checked slash to-do',
  );
}

async function assertSlashPageCreatesEmptyTitle(page, baseUrl, seed) {
  await pickSlashBlock(page, seed.blockIds.slashPage, 'page', /^Page\b/);
  const blocks = await waitForBlocks(
    baseUrl,
    seed,
    (items) => {
      const block = items.find((item) => item.id === seed.blockIds.slashPage);
      return (
        block?.type === 'child_page' &&
        typeof block.content?.childPageId === 'string' &&
        block.content.childPageId.length > 0
      );
    },
    'slash page child block',
  );
  const childBlock = blocks.find((block) => block.id === seed.blockIds.slashPage);
  const childPageId = childBlock?.content?.childPageId;
  assert(typeof childPageId === 'string' && childPageId, 'slash /page must persist a child page id');

  const childPage = await waitForPage(
    baseUrl,
    seed,
    childPageId,
    (item) => item?.title === '',
    'slash page empty persisted title',
  );
  assert(childPage.title === '', `slash /page should save an empty title, got ${JSON.stringify(childPage.title)}`);

  await page.waitForFunction(
    ({ pageId }) => location.pathname.endsWith(`/p/${pageId}`),
    { pageId: childPageId },
    { timeout: options.timeoutMs },
  );
  await page.waitForFunction(
    () => {
      const title = document.querySelector(
        '[role="textbox"][aria-label="페이지 제목"], [role="textbox"][aria-label="Page title"]',
      );
      if (!(title instanceof HTMLElement)) return false;
      const text = (title.innerText || title.textContent || '').trim();
      const placeholder = title.getAttribute('aria-placeholder') || title.getAttribute('data-placeholder') || '';
      return text === '' && title.getAttribute('data-empty') === 'true' && !/\bUntitled\b/.test(text) && !!placeholder;
    },
    {},
    { timeout: options.timeoutMs },
  );

  await page.goto(new URL(`/p/${seed.pageId}`, page.url()).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await blockTextBox(page, seed.blockIds.tabs, 'Text block text').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertPastedUrlMention(page, baseUrl, seed) {
  const textbox = blockTextBox(page, seed.blockIds.pastedUrlMention, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await pastePlainText(textbox, seed.pastedUrlMentionUrl);

  const menu = page.getByRole('dialog', { name: 'Pasted link options' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const firstOption = menu.locator('[data-pasted-url-option]').first();
  await firstOption.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const firstOptionText = ((await firstOption.textContent()) ?? '').trim();
  assert(/^Mention\b/.test(firstOptionText), `pasted URL menu should default to Mention, got "${firstOptionText}"`);
  await page.keyboard.press('Enter');

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.pastedUrlMention,
    (block) => {
      const rich = block?.content?.rich;
      const first = Array.isArray(rich) ? rich[0] : null;
      return (
        block?.type === 'paragraph' &&
        block?.plainText === seed.pastedUrlMentionTitle &&
        Array.isArray(rich) &&
        rich.length === 1 &&
        first?.mention === 'external' &&
        first?.text === seed.pastedUrlMentionTitle &&
        typeof first?.link === 'string' &&
        first.link.startsWith('https://www.naver.com') &&
        typeof first?.iconUrl === 'string' &&
        first.iconUrl.startsWith('http')
      );
    },
    'pasted external URL mention metadata',
  );

  await page.waitForFunction(
    ({ blockId, title }) => {
      const root = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      const mention = root?.querySelector('[data-mention="external"]');
      const icon = mention?.querySelector('img[data-mention-icon="external"]');
      return (
        mention?.textContent?.trim() === title &&
        icon instanceof HTMLImageElement &&
        icon.complete &&
        icon.naturalWidth > 0 &&
        icon.naturalHeight > 0
      );
    },
    { blockId: seed.blockIds.pastedUrlMention, title: seed.pastedUrlMentionTitle },
    { timeout: options.timeoutMs },
  );
}

async function assertSlashTabs(page, baseUrl, seed) {
  const textbox = blockTextBox(page, seed.blockIds.tabs, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type('/tabs');

  const menu = page.getByRole('listbox', { name: 'Block commands' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('option', { name: /Tabs/ }).click({ timeout: options.timeoutMs });

  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.tabs && block.type === 'tab');
      if (!tab) return false;
      const labels = sortedTabLabels(blocks, tab.id);
      const firstBody = blocks.find((block) => block.parentId === labels[0]?.id && block.type === 'paragraph');
      return (
        labels.length === 2 &&
        labels[0]?.plainText === 'Tab 1' &&
        labels[1]?.plainText === 'Tab 2' &&
        !!firstBody
      );
    },
    'slash tabs structure',
  );

  const group = blockGroup(page, seed.blockIds.tabs);
  const tab1 = group.getByRole('tab', { name: 'Tab 1' });
  const tab2 = group.getByRole('tab', { name: 'Tab 2' });
  await tab1.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await tab2.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await tab1.focus({ timeout: options.timeoutMs });
  await waitForSelectedTab(page, seed.blockIds.tabs, 'Tab 1', true);

  await tab1.press('ArrowRight', { timeout: options.timeoutMs });
  await waitForSelectedTab(page, seed.blockIds.tabs, 'Tab 2', true);
  await page.keyboard.press('Home');
  await waitForSelectedTab(page, seed.blockIds.tabs, 'Tab 1', true);
  await page.keyboard.press('End');
  await waitForSelectedTab(page, seed.blockIds.tabs, 'Tab 2', true);
  await page.keyboard.press('ArrowLeft');
  await waitForSelectedTab(page, seed.blockIds.tabs, 'Tab 1', true);

  await group.getByRole('button', { name: 'Add tab' }).click({ timeout: options.timeoutMs });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.tabs && block.type === 'tab');
      if (!tab) return false;
      const labels = sortedTabLabels(blocks, tab.id);
      const newBody = blocks.find((block) => block.parentId === labels[2]?.id && block.type === 'paragraph');
      return labels.length === 3 && labels[2]?.plainText === 'Tab 3' && !!newBody;
    },
    'added tab structure',
  );
  await waitForSelectedTab(page, seed.blockIds.tabs, 'Tab 3');

  const renamedLabel = `Renamed tab ${Date.now()}`;
  let renamedTabLabelId = '';
  let renamedTabBodyId = '';
  const tab3 = group.getByRole('tab', { name: 'Tab 3' });
  await tab3.dblclick({ timeout: options.timeoutMs });
  const renameInput = group.getByRole('textbox', { name: /Rename Tab 3/ });
  await renameInput.fill(renamedLabel, { timeout: options.timeoutMs });
  await dispatchComposingEnter(renameInput);
  await renameInput.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await renameInput.press('Enter', { timeout: options.timeoutMs });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.tabs && block.type === 'tab');
      if (!tab) return false;
      const labels = sortedTabLabels(blocks, tab.id);
      const renamed = labels[2];
      const body = blocks.find((block) => block.parentId === renamed?.id && block.type === 'paragraph');
      if (labels.length !== 3 || renamed?.plainText !== renamedLabel || !body) return false;
      renamedTabLabelId = renamed.id;
      renamedTabBodyId = body.id;
      return true;
    },
    'renamed tab label',
  );
  await group.getByRole('tab', { name: renamedLabel }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await group.getByRole('tab', { name: renamedLabel }).press('Alt+ArrowLeft', {
    timeout: options.timeoutMs,
  });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.tabs && block.type === 'tab');
      if (!tab) return false;
      const labels = sortedTabLabels(blocks, tab.id);
      return (
        labels.length === 3 &&
        labels[0]?.plainText === 'Tab 1' &&
        labels[1]?.plainText === renamedLabel &&
        labels[2]?.plainText === 'Tab 2'
      );
    },
    'reordered tab labels',
  );
  await waitForSelectedTab(page, seed.blockIds.tabs, renamedLabel);

  await group.getByRole('button', { name: `Delete ${renamedLabel}` }).click({ timeout: options.timeoutMs });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.tabs && block.type === 'tab');
      if (!tab) return false;
      const labels = sortedTabLabels(blocks, tab.id);
      return (
        labels.length === 2 &&
        !blocks.some((block) => block.id === renamedTabLabelId || block.id === renamedTabBodyId)
      );
    },
    'deleted tab subtree',
  );
  await waitForSelectedTab(page, seed.blockIds.tabs, 'Tab 1');
}

async function assertPastedMarkdownTabs(page, baseUrl, seed) {
  const label = `Pasted tab ${Date.now()}`;
  const icon = 'P';
  const bodyText = `Pasted tab body ${Date.now()}`;
  const markdown = `[Tabs]\n  [Tab: ${icon} ${label}]\n    ${bodyText}`;
  const textbox = blockTextBox(page, seed.blockIds.pastedTabs, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await pastePlainText(textbox, markdown);

  let labelId = '';
  let bodyId = '';
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.pastedTabs && block.type === 'tab');
      if (!tab) return false;
      const labels = sortedTabLabels(blocks, tab.id);
      const pastedLabel = labels.find((block) => block.plainText === label);
      const body = blocks.find((block) => block.parentId === pastedLabel?.id && block.type === 'paragraph');
      if (
        labels.length !== 1 ||
        !pastedLabel ||
        pastedLabel.content?.icon !== icon ||
        body?.plainText !== bodyText
      ) return false;
      labelId = pastedLabel.id;
      bodyId = body.id;
      return true;
    },
    'pasted Markdown tabs structure',
  );

  const group = blockGroup(page, seed.blockIds.pastedTabs);
  await group.getByRole('tab', { name: new RegExp(`${icon}\\s*${label}`) }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForIconSelectedTab(page, seed.blockIds.pastedTabs, icon, label);
  await blockGroup(page, bodyId).getByRole('textbox', { name: 'Text block text' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  assert(labelId, 'pasted Markdown tab label id should be captured');
}

async function assertPastedHtmlTabs(page, baseUrl, seed) {
  const label = `HTML tab ${Date.now()}`;
  const icon = 'H';
  const bodyText = `HTML tab body ${Date.now()}`;
  const html = [
    '<html><body><!--StartFragment--><div data-notionlike-copy="true">',
    '<div data-notionlike-block-type="tab"><strong>Tabs</strong>',
    `<section data-notionlike-tab-label="true" data-notionlike-tab-icon="${icon}">`,
    `<p data-notionlike-tab-title="true"><span data-notionlike-tab-icon-text="true">${icon}</span> ${label}</p>`,
    `<div data-notionlike-tab-panel="true"><p>${bodyText}</p></div>`,
    '</section>',
    '</div></div><!--EndFragment--></body></html>',
  ].join('');
  const textbox = blockTextBox(page, seed.blockIds.htmlTabs, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await pasteHtml(textbox, html, `[Tabs]\n  [Tab: ${icon} ${label}]\n    ${bodyText}`);

  let bodyId = '';
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.htmlTabs && block.type === 'tab');
      if (!tab) return false;
      const labels = sortedTabLabels(blocks, tab.id);
      const pastedLabel = labels.find((block) => block.plainText === label);
      const body = blocks.find((block) => block.parentId === pastedLabel?.id && block.type === 'paragraph');
      if (
        labels.length !== 1 ||
        !pastedLabel ||
        pastedLabel.content?.icon !== icon ||
        body?.plainText !== bodyText
      ) return false;
      bodyId = body.id;
      return true;
    },
    'pasted HTML tabs structure',
  );

  const group = blockGroup(page, seed.blockIds.htmlTabs);
  await group.getByRole('tab', { name: new RegExp(`${icon}\\s*${label}`) }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForIconSelectedTab(page, seed.blockIds.htmlTabs, icon, label);
  await blockGroup(page, bodyId).getByRole('textbox', { name: 'Text block text' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
}

async function assertImportedIconTabs(page, baseUrl, seed) {
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const tab = blocks.find((block) => block.id === seed.blockIds.importedTabs && block.type === 'tab');
      const label = blocks.find((block) => block.id === seed.blockIds.importedTabLabel);
      const body = blocks.find((block) => block.id === seed.blockIds.importedTabBody);
      return (
        !!tab &&
        label?.parentId === tab.id &&
        label?.type === 'paragraph' &&
        label?.plainText === seed.importedTabLabel &&
        label?.content?.icon === seed.importedTabIcon &&
        body?.parentId === label.id &&
        body?.plainText === seed.importedTabBody
      );
    },
    'imported icon tab seed structure',
  );

  const group = blockGroup(page, seed.blockIds.importedTabs);
  const tab = group.getByRole('tab', { name: new RegExp(`${seed.importedTabIcon}\\s*${seed.importedTabLabel}`) });
  await tab.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await tab.click({ timeout: options.timeoutMs });
  await waitForIconSelectedTab(page, seed.blockIds.importedTabs, seed.importedTabIcon, seed.importedTabLabel);
  await blockGroup(page, seed.blockIds.importedTabBody)
    .getByRole('textbox', { name: 'Text block text' })
    .waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function assertSlashColumns(page, baseUrl, seed) {
  const textbox = blockTextBox(page, seed.blockIds.columns, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type('/columns');

  const menu = page.getByRole('listbox', { name: 'Block commands' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('option', { name: /2 columns/ }).click({ timeout: options.timeoutMs });

  let firstColumnId = '';
  let secondColumnId = '';
  let firstColumnBodyId = '';
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const columnList = blocks.find((block) => block.id === seed.blockIds.columns && block.type === 'column_list');
      if (!columnList) return false;
      const columns = sortedColumns(blocks, columnList.id);
      const firstBody = blocks.find((block) => block.parentId === columns[0]?.id && block.type === 'paragraph');
      const secondBody = blocks.find((block) => block.parentId === columns[1]?.id && block.type === 'paragraph');
      if (columns.length !== 2 || !firstBody || !secondBody) return false;
      firstColumnId = columns[0].id;
      secondColumnId = columns[1].id;
      firstColumnBodyId = firstBody.id;
      return true;
    },
    'slash columns structure',
  );

  const group = blockGroup(page, seed.blockIds.columns);
  const firstColumn = group.getByRole('group', { name: 'Column 1' });
  const secondColumn = group.getByRole('group', { name: 'Column 2' });
  await firstColumn.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await secondColumn.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await firstColumn.getByRole('textbox', { name: 'Text block text' }).type(seed.columnText, {
    timeout: options.timeoutMs,
  });
  await waitForBlock(
    baseUrl,
    seed,
    firstColumnBodyId,
    (block) => block?.plainText === seed.columnText,
    'column body text',
  );

  await hoverColumnControlsHotspot(secondColumn);
  await secondColumn.getByRole('button', { name: 'Add column after column 2' }).click({
    timeout: options.timeoutMs,
  });

  let addedColumnId = '';
  let addedColumnBodyId = '';
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const columns = sortedColumns(blocks, seed.blockIds.columns);
      const added = columns[2];
      const addedBody = blocks.find((block) => block.parentId === added?.id && block.type === 'paragraph');
      if (
        columns.length !== 3 ||
        columns[0]?.id !== firstColumnId ||
        columns[1]?.id !== secondColumnId ||
        !added ||
        !addedBody
      ) {
        return false;
      }
      addedColumnId = added.id;
      addedColumnBodyId = addedBody.id;
      return true;
    },
    'added column structure',
  );

  const thirdColumn = group.getByRole('group', { name: 'Column 3' });
  await hoverColumnControlsHotspot(thirdColumn);
  await thirdColumn.getByRole('button', { name: 'Move column 3 left' }).click({
    timeout: options.timeoutMs,
  });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const columns = sortedColumns(blocks, seed.blockIds.columns);
      return (
        columns.length === 3 &&
        columns[0]?.id === firstColumnId &&
        columns[1]?.id === addedColumnId &&
        columns[2]?.id === secondColumnId
      );
    },
    'reordered columns',
  );

  const movedColumn = group.getByRole('group', { name: 'Column 2' });
  await hoverColumnControlsHotspot(movedColumn);
  await movedColumn.getByRole('button', { name: 'Delete column 2' }).click({
    timeout: options.timeoutMs,
  });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const columns = sortedColumns(blocks, seed.blockIds.columns);
      return (
        columns.length === 2 &&
        columns[0]?.id === firstColumnId &&
        columns[1]?.id === secondColumnId &&
        !blocks.some((block) => block.id === addedColumnId || block.id === addedColumnBodyId)
      );
    },
    'deleted column subtree',
  );
}

async function assertSlashButton(page, baseUrl, seed) {
  const textbox = blockTextBox(page, seed.blockIds.button, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type('/button');

  const menu = page.getByRole('listbox', { name: 'Block commands' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('option', { name: /Button/ }).click({ timeout: options.timeoutMs });

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.button,
    (block) =>
      block?.type === 'button' &&
      block?.content?.buttonLabel === 'New button' &&
      block?.content?.buttonTemplate?.[0]?.type === 'to_do',
    'slash button structure',
  );

  const group = blockGroup(page, seed.blockIds.button);
  await group.getByRole('button', { name: 'Configure button' }).click({ timeout: options.timeoutMs });
  const dialog = page.getByRole('dialog', { name: 'Configure button' });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await dialog.getByLabel('Name').fill(seed.buttonLabel, { timeout: options.timeoutMs });
  await dialog.getByLabel('Template block 1 text').fill(seed.buttonText, { timeout: options.timeoutMs });

  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.button,
    (block) =>
      block?.type === 'button' &&
      block?.content?.buttonLabel === seed.buttonLabel &&
      block?.plainText === seed.buttonLabel &&
      block?.content?.buttonTemplate?.[0]?.type === 'to_do' &&
      block?.content?.buttonTemplate?.[0]?.content?.rich?.[0]?.text === seed.buttonText,
    'configured button template',
  );

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: options.timeoutMs });
  await group.getByRole('button', { name: seed.buttonLabel }).click({ timeout: options.timeoutMs });
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const button = blocks.find((block) => block.id === seed.blockIds.button);
      if (!button) return false;
      return blocks.some(
        (block) =>
          block.type === 'to_do' &&
          block.parentId === button.parentId &&
          block.position > button.position &&
          block.plainText === seed.buttonText &&
          block.content?.checked === false,
      );
    },
    'button inserted template block',
  );
}

async function assertSlashSyncedBlock(page, baseUrl, seed) {
  const textbox = blockTextBox(page, seed.blockIds.synced, 'Text block text');
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type('/synced');

  const menu = page.getByRole('listbox', { name: 'Block commands' });
  await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await menu.getByRole('option', { name: /Synced block/ }).click({ timeout: options.timeoutMs });

  let sourceChildId = '';
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const source = blocks.find((block) => block.id === seed.blockIds.synced && block.type === 'synced_block');
      if (!source || source.content?.syncedBlockId) return false;
      const child = blocks.find((block) => block.parentId === source.id && block.type === 'paragraph');
      if (!child) return false;
      sourceChildId = child.id;
      return true;
    },
    'slash synced block structure',
  );

  await blockTextBox(page, sourceChildId, 'Text block text').type(seed.syncedText, {
    timeout: options.timeoutMs,
  });
  await waitForBlock(
    baseUrl,
    seed,
    sourceChildId,
    (block) => block?.type === 'paragraph' && block?.plainText === seed.syncedText,
    'synced source child text',
  );

  await blockGroup(page, seed.blockIds.synced).getByRole('button', { name: 'Copy' }).click({
    timeout: options.timeoutMs,
  });

  let copyId = '';
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const copy = blocks.find(
        (block) =>
          block.id !== seed.blockIds.synced &&
          block.type === 'synced_block' &&
          block.content?.syncedBlockId === seed.blockIds.synced &&
          block.content?.syncedPageId === seed.pageId,
      );
      if (!copy) return false;
      copyId = copy.id;
      return true;
    },
    'synced block copy reference',
  );

  const copyGroup = blockGroup(page, copyId);
  await copyGroup.getByText('Synced copy').waitFor({ state: 'visible', timeout: options.timeoutMs });
  await copyGroup.getByRole('textbox', { name: 'Synced Text block text' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForTextInLocator(copyGroup.getByRole('textbox', { name: 'Synced Text block text' }), seed.syncedText);

  await copyGroup.getByRole('button', { name: 'Unsync' }).click({ timeout: options.timeoutMs });
  await waitForBlock(
    baseUrl,
    seed,
    copyId,
    (block) =>
      block?.type === 'paragraph' &&
      block?.plainText === seed.syncedText &&
      !block?.content?.syncedBlockId,
    'unsynced copied block',
  );

  const sourceAfterUnsync = `${seed.syncedText} updated`;
  await blockTextBox(page, sourceChildId, 'Text block text').fill(sourceAfterUnsync, {
    timeout: options.timeoutMs,
  });
  await waitForBlock(
    baseUrl,
    seed,
    sourceChildId,
    (block) => block?.plainText === sourceAfterUnsync,
    'updated synced source child text',
  );
  await waitForBlock(
    baseUrl,
    seed,
    copyId,
    (block) => block?.type === 'paragraph' && block?.plainText === seed.syncedText,
    'unsynced block remains independent',
  );
}

async function assertBlockCreationFocusFlow(page, baseUrl, seed) {
  await assertSlashTextFocusAndEnter(page, baseUrl, seed, {
    key: 'focusHeading',
    query: 'h1',
    option: /Heading 1/,
    label: 'Heading 1 block text',
    text: seed.focusHeadingText,
    type: 'heading_1',
    nextText: seed.focusHeadingNextText,
    nextType: 'paragraph',
  });
  await assertSlashTextFocusAndEnter(page, baseUrl, seed, {
    key: 'focusTodo',
    query: 'todo',
    option: /To-do list/,
    label: 'To-do list block text',
    text: seed.focusTodoText,
    type: 'to_do',
    nextText: seed.focusTodoNextText,
    nextType: 'to_do',
  });
  await assertSlashTextFocusAndEnter(page, baseUrl, seed, {
    key: 'focusBullet',
    query: 'bullet',
    option: /Bulleted list/,
    label: 'Bulleted list block text',
    text: seed.focusBulletText,
    type: 'bulleted_list_item',
    nextText: seed.focusBulletNextText,
    nextType: 'bulleted_list_item',
  });
  await assertSlashTextFocusAndEnter(page, baseUrl, seed, {
    key: 'focusQuote',
    query: 'quote',
    option: /Quote/,
    label: 'Quote block text',
    text: seed.focusQuoteText,
    type: 'quote',
    nextText: seed.focusQuoteNextText,
    nextType: 'paragraph',
  });
  await assertSlashTextFocusAndEnter(page, baseUrl, seed, {
    key: 'focusCallout',
    query: 'callout',
    option: /Callout/,
    label: 'Callout block text',
    text: seed.focusCalloutText,
    type: 'callout',
    nextText: seed.focusCalloutNextText,
    nextType: 'paragraph',
  });

  await pickSlashBlock(page, seed.blockIds.focusToggle, 'toggle', /Toggle list/);
  await blockTextBox(page, seed.blockIds.focusToggle, 'Toggle list block text').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForFocusedBlockTextbox(page, seed.blockIds.focusToggle, 'Toggle list block text');
  await page.keyboard.type(seed.focusToggleText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.focusToggle,
    (block) => block?.type === 'toggle' && block?.plainText === seed.focusToggleText,
    'Korean toggle title immediate typing',
  );
  await dispatchCompositionCommitWithoutEnter(page, seed.blockIds.focusToggle, '녕');
  await page.keyboard.press('Enter');
  await page.keyboard.type(seed.focusToggleChildText);
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) =>
      blocks.some(
        (block) =>
          block.parentId === seed.blockIds.focusToggle &&
          block.type === 'paragraph' &&
          block.plainText === seed.focusToggleChildText,
      ),
    'Korean toggle title Enter creates focused child on first press',
  );

  await pickSlashBlock(page, seed.blockIds.focusTable, 'table', /^Table\b/);
  await waitForFocusedBlockControl(page, seed.blockIds.focusTable, '[data-table-cell]');
  await page.keyboard.type(seed.focusTableText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.focusTable,
    (block) => block?.type === 'simple_table' && block?.plainText?.includes(seed.focusTableText),
    'simple table immediate cell typing',
  );

  await pickSlashBlock(page, seed.blockIds.focusEquation, 'equation', /Equation/);
  await waitForFocusedBlockControl(page, seed.blockIds.focusEquation, 'textarea[data-equation-input]');
  await page.keyboard.type(seed.focusEquationText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.focusEquation,
    (block) => block?.type === 'equation' && block?.plainText === seed.focusEquationText,
    'equation immediate input typing',
  );

  await pickSlashBlock(page, seed.blockIds.focusImage, 'image', /Image/);
  await waitForFocusedBlockControl(page, seed.blockIds.focusImage, 'input[aria-label="Image link"]');
  await page.keyboard.type(seed.focusImageUrl);
  await page.keyboard.press('Enter');
  await page.keyboard.type(seed.focusImageNextText);
  await waitForFollowingBlockText(
    baseUrl,
    seed,
    seed.blockIds.focusImage,
    seed.focusImageNextText,
    'paragraph',
    'image URL Enter continuation',
  );

  await pickSlashBlock(page, seed.blockIds.focusBookmark, 'bookmark', /Web bookmark/);
  await waitForFocusedBlockControl(page, seed.blockIds.focusBookmark, 'input[aria-label="Bookmark link"]');
  await page.keyboard.type(seed.focusBookmarkUrl);
  await page.keyboard.press('Enter');
  await page.keyboard.type(seed.focusBookmarkNextText);
  await waitForFollowingBlockText(
    baseUrl,
    seed,
    seed.blockIds.focusBookmark,
    seed.focusBookmarkNextText,
    'paragraph',
    'bookmark URL Enter continuation',
  );

    await assertEmbedHasNoDefaultCaptionAndContinues(page, baseUrl, seed);

  await pickSlashBlock(page, seed.blockIds.focusToc, 'toc', /Table of contents/);
  await page.keyboard.type(seed.focusTocNextText);
  await waitForFollowingBlockText(
    baseUrl,
    seed,
    seed.blockIds.focusToc,
    seed.focusTocNextText,
    'paragraph',
    'table of contents continuation paragraph',
  );

  await pickSlashBlock(page, seed.blockIds.focusButton, 'button', /Button/);
  await page.keyboard.type(seed.focusButtonNextText);
  await waitForFollowingBlockText(
    baseUrl,
    seed,
    seed.blockIds.focusButton,
    seed.focusButtonNextText,
    'paragraph',
    'button continuation paragraph',
  );
}

async function assertEmbedHasNoDefaultCaptionAndContinues(page, baseUrl, seed) {
  const blockId = seed.blockIds.focusEmbed;
  await pickSlashBlock(page, blockId, 'embed', /Embed/);
  await waitForFocusedBlockControl(page, blockId, 'input[aria-label="Embed link"]');
  await page.keyboard.type(seed.focusEmbedUrl);
  await page.keyboard.press('Enter');
  await waitForBlock(
    baseUrl,
    seed,
    blockId,
    (block) => block?.type === 'embed' && block?.content?.url === seed.focusEmbedUrl,
    'embed URL commit',
  );

  await page.waitForFunction(
    ({ targetBlockId }) => {
      const group = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
      const caption = group?.querySelector('[aria-label="Embed caption"]');
      const active = document.activeElement;
      return !caption && active instanceof HTMLElement && active.getAttribute('aria-label') === 'Text block text';
    },
    { targetBlockId: blockId },
    { timeout: options.timeoutMs },
  );
  await page.keyboard.type('/page');
  await page.getByRole('listbox', { name: 'Block commands' }).waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await page.waitForFunction(
    ({ targetBlockId }) => {
      const group = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
      const caption = group?.querySelector('[aria-label="Embed caption"]');
      const active = document.activeElement;
      const menu = document.querySelector('[role="listbox"][aria-label="Block commands"]');
      return (
        !caption &&
        !!menu &&
        active instanceof HTMLElement &&
        active.getAttribute('aria-label') === 'Text block text'
      );
    },
    { targetBlockId: blockId },
    { timeout: options.timeoutMs },
  );
  await waitForFollowingBlockText(
    baseUrl,
    seed,
    blockId,
    '/page',
    'paragraph',
    'embed next paragraph slash continuation',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('listbox', { name: 'Block commands' }).waitFor({
    state: 'hidden',
    timeout: options.timeoutMs,
  });

  await assertEmbedBlockActionChrome(page, blockId);
  const actions = page.getByRole('menu', { name: 'Block actions' });
  await actions.getByRole('menuitem', { name: 'Add caption' }).click({ timeout: options.timeoutMs });
  await page.waitForFunction(
    ({ targetBlockId }) => {
      const group = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
      const caption = group?.querySelector('[aria-label="Embed caption"]');
      return caption instanceof HTMLElement && document.activeElement === caption;
    },
    { targetBlockId: blockId },
    { timeout: options.timeoutMs },
  );
  await page.keyboard.type(seed.focusEmbedCaptionText);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    ({ targetBlockId }) => {
      const group = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
      const caption = group?.querySelector('[aria-label="Embed caption"]');
      const active = document.activeElement;
      return (
        caption instanceof HTMLElement &&
        !/[\r\n]/.test(caption.innerText ?? '') &&
        active instanceof HTMLElement &&
        active.getAttribute('aria-label') === 'Text block text' &&
        active.closest('[data-block-id]')?.getAttribute('data-block-id') !== targetBlockId
      );
    },
    { targetBlockId: blockId },
    { timeout: options.timeoutMs },
  );
  await page.keyboard.type(seed.focusEmbedCaptionNextText);
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const embed = blocks.find((block) => block.id === blockId);
      const captionText = (embed?.content?.caption ?? []).map((span) => span.text ?? '').join('');
      return (
        embed?.type === 'embed' &&
        captionText === seed.focusEmbedCaptionText &&
        !captionText.includes('\n') &&
        blocks.some(
          (block) =>
            block.parentId === embed.parentId &&
            block.position > embed.position &&
            block.type === 'paragraph' &&
            block.plainText === seed.focusEmbedCaptionNextText,
        )
      );
    },
    'single-line embed caption Enter continuation',
  );
}

async function assertEmbedBlockActionChrome(page, blockId) {
  const group = blockGroup(page, blockId);
  const frame = group.locator('[data-embed-frame="true"]');
  const bridge = group.locator('[data-embed-hover-bridge="true"]');
  await frame.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await bridge.waitFor({ state: 'visible', timeout: options.timeoutMs });

  let geometry = await embedChromeGeometry(page, blockId);
  await bridge.hover({ position: { x: 18, y: 24 }, timeout: options.timeoutMs });
  await page.waitForFunction(
    ({ targetBlockId }) => {
      const data = window.__embedChromeGeometry?.(targetBlockId);
      return data?.gutterOpacity === '1' && data?.gutterPointerEvents !== 'none';
    },
    { targetBlockId: blockId },
    { timeout: options.timeoutMs },
  );
  geometry = await embedChromeGeometry(page, blockId);
  await page.mouse.move(geometry.gutter.left + geometry.gutter.width / 2, geometry.gutter.top + geometry.gutter.height / 2, {
    steps: 12,
  });
  await page.mouse.click(geometry.gutter.left + geometry.gutter.width / 2, geometry.gutter.top + geometry.gutter.height / 2);
  const actions = page.getByRole('menu', { name: 'Block actions' });
  await actions.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await closeBlockActionsMenu(page, actions);

  const more = group.getByRole('button', { name: 'Open embed block actions' });
  await frame.hover({ timeout: options.timeoutMs });
  await more.click({ button: 'right', timeout: options.timeoutMs });
  await actions.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await closeBlockActionsMenu(page, actions);

  await frame.hover({ timeout: options.timeoutMs });
  await more.click({ timeout: options.timeoutMs });
  await actions.waitFor({ state: 'visible', timeout: options.timeoutMs });
}

async function closeBlockActionsMenu(page, actions) {
  await actions.locator('[data-block-menu-item]').first().focus({ timeout: options.timeoutMs });
  await page.keyboard.press('Escape');
  await actions.waitFor({ state: 'hidden', timeout: options.timeoutMs });
}

async function embedChromeGeometry(page, blockId) {
  return page.evaluate((targetBlockId) => {
    window.__embedChromeGeometry = (id) => {
      const group = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      const frame = group?.querySelector('[data-embed-frame="true"]');
      const gutter = group?.querySelector('button[aria-label="Open block actions"]');
      const gutterShell = gutter?.parentElement;
      if (!(frame instanceof HTMLElement) || !(gutter instanceof HTMLElement) || !(gutterShell instanceof HTMLElement)) {
        return null;
      }
      const rectInfo = (rect) => ({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
      const shellStyle = getComputedStyle(gutterShell);
      return {
        frame: rectInfo(frame.getBoundingClientRect()),
        gutter: rectInfo(gutter.getBoundingClientRect()),
        gutterOpacity: shellStyle.opacity,
        gutterPointerEvents: shellStyle.pointerEvents,
      };
    };
    const geometry = window.__embedChromeGeometry(targetBlockId);
    if (!geometry) throw new Error(`embed chrome geometry missing for ${targetBlockId}`);
    return geometry;
  }, blockId);
}

async function assertSlashTextFocusAndEnter(page, baseUrl, seed, spec) {
  const blockId = seed.blockIds[spec.key];
  await pickSlashBlock(page, blockId, spec.query, spec.option);
  await blockTextBox(page, blockId, spec.label).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await waitForFocusedBlockTextbox(page, blockId, spec.label);
  await page.keyboard.type(spec.text);
  await waitForBlock(
    baseUrl,
    seed,
    blockId,
    (block) => block?.type === spec.type && block?.plainText === spec.text,
    `${spec.type} immediate typing`,
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type(spec.nextText);
  await waitForFollowingBlockText(
    baseUrl,
    seed,
    blockId,
    spec.nextText,
    spec.nextType,
    `${spec.type} Enter continuation`,
  );
}

async function dispatchCompositionCommitWithoutEnter(page, blockId, text) {
  await page.evaluate(({ blockId, text }) => {
    const editable = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"] [data-rt-editable="true"]`);
    if (!(editable instanceof HTMLElement)) throw new Error(`editable block ${blockId} missing`);
    editable.focus();
    editable.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: text }));
    editable.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
  }, { blockId, text });
}

async function pickSlashBlock(page, blockId, query, optionName) {
  try {
    await blockTextBox(page, blockId, 'Text block text').click({ timeout: options.timeoutMs });
    await page.keyboard.type(`/${query}`);
    const menu = page.getByRole('listbox', { name: 'Block commands' });
    await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await menu.getByRole('option', { name: optionName }).first().click({ timeout: options.timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`slash /${query} on block ${blockId}: ${message}`);
  }
}

async function waitForFollowingBlockText(baseUrl, seed, anchorId, text, type, label) {
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const anchor = blocks.find((block) => block.id === anchorId);
      if (!anchor) return false;
      return blocks.some(
        (block) =>
          block.parentId === anchor.parentId &&
          block.position > anchor.position &&
          block.type === type &&
          block.plainText === text,
      );
    },
    label,
  );
}

async function assertMarkdownShortcuts(page, baseUrl, seed) {
  await typeMarkdownShortcut(page, seed.blockIds.heading, 'Text block text', '# ', 'Heading 1 block text', seed.headingText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.heading,
    (block) => block?.type === 'heading_1' && block?.plainText === seed.headingText,
    'heading Markdown shortcut',
  );

  await typeMarkdownShortcut(page, seed.blockIds.toggle, 'Text block text', '> ', 'Toggle list block text', seed.toggleText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.toggle,
    (block) => block?.type === 'toggle' && block?.plainText === seed.toggleText,
    'toggle Markdown shortcut',
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type(seed.toggleChildText);
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) =>
      blocks.some(
        (block) =>
          block.parentId === seed.blockIds.toggle &&
          block.type === 'paragraph' &&
          block.plainText === seed.toggleChildText,
      ),
    'toggle Enter child writing',
  );
  await blockGroup(page, seed.blockIds.toggle).getByRole('button', { name: 'Close toggle' }).click({
    timeout: options.timeoutMs,
  });
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.toggle,
    (block) => block?.type === 'toggle' && block?.content?.collapsed === true,
    'collapsed toggle',
  );

  await typeIntoBlock(page, seed.blockIds.inlineSymbols, 'Text block text', seed.inlineSymbolTypedText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.inlineSymbols,
    (block) => block?.type === 'paragraph' && block?.plainText === seed.inlineSymbolExpectedText,
    'inline symbol Markdown shortcuts',
  );

  await typeIntoBlock(page, seed.blockIds.inlineCodeSymbols, 'Text block text', seed.inlineCodeSymbolTypedText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.inlineCodeSymbols,
    (block) =>
      block?.type === 'paragraph' &&
      block?.plainText === seed.inlineCodeSymbolExpectedText &&
      (block.content?.rich ?? []).some((span) => span.code === true && span.text === 'right ->'),
    'inline code literal symbol text',
  );

  await typeIntoBlock(page, seed.blockIds.inlineStrike, 'Text block text', seed.inlineStrikeTypedText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.inlineStrike,
    (block) => {
      if (block?.type !== 'paragraph' || block.plainText !== seed.inlineStrikeExpectedText) return false;
      const rich = Array.isArray(block.content?.rich) ? block.content.rich : [];
      return (
        rich.some((span) => span.text === 'single' && span.strikethrough === true) &&
        rich.some((span) => span.text === 'double' && span.strikethrough === true) &&
        rich.every((span) => !span.text.includes('~'))
      );
    },
    'inline strikethrough Markdown shortcuts',
  );

  await typeMarkdownShortcut(
    page,
    seed.blockIds.numbered,
    'Text block text',
    '1. ',
    'Numbered list block text',
    seed.numberedFirstText,
  );
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.numbered,
    (block) => block?.type === 'numbered_list_item' && block?.plainText === seed.numberedFirstText,
    'numbered list Markdown shortcut',
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type(seed.numberedSecondText);
  const numberedBlocks = await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const anchor = blocks.find((block) => block.id === seed.blockIds.numbered);
      if (!anchor) return false;
      return blocks.some(
        (block) =>
          block.parentId === anchor.parentId &&
          block.position > anchor.position &&
          block.type === 'numbered_list_item' &&
          block.plainText === seed.numberedSecondText,
      );
    },
    'numbered list Enter continuation',
  );
  const numberedAnchor = numberedBlocks.find((block) => block.id === seed.blockIds.numbered);
  const numberedSecond = numberedBlocks.find(
    (block) =>
      numberedAnchor &&
      block.parentId === numberedAnchor.parentId &&
      block.position > numberedAnchor.position &&
      block.type === 'numbered_list_item' &&
      block.plainText === seed.numberedSecondText,
  );
  assert(numberedSecond?.id, 'numbered list continuation block must be persisted');
  await page.waitForFunction(
    ({ blockId }) => {
      const group = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      if (!group) return false;
      return Array.from(group.querySelectorAll('span')).some((span) => span.textContent?.trim() === '2.');
    },
    { blockId: numberedSecond.id },
    { timeout: options.timeoutMs },
  );

  await blockTextBox(page, seed.blockIds.codeFence, 'Text block text').click({ timeout: options.timeoutMs });
  await page.keyboard.type('```');
  await blockTextBox(page, seed.blockIds.codeFence, 'Code block text').waitFor({
    state: 'visible',
    timeout: options.timeoutMs,
  });
  await waitForFocusedBlockTextbox(page, seed.blockIds.codeFence, 'Code block text');
  await page.keyboard.type(seed.codeFenceText);
  await waitForBlock(
    baseUrl,
    seed,
    seed.blockIds.codeFence,
    (block) => block?.type === 'code' && block?.plainText === seed.codeFenceText,
    'immediate code fence Markdown shortcut',
  );

  await blockTextBox(page, seed.blockIds.divider, 'Text block text').click({ timeout: options.timeoutMs });
  await page.keyboard.type('---');
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) =>
      blocks.some((block) => block.id === seed.blockIds.divider && block.type === 'divider') &&
      blocks.length >= seed.initialBlockCount + 1,
    'divider Markdown shortcut and inserted follow-up paragraph',
  );
}

async function assertEmptyListEnterEscapes(page, baseUrl, seed) {
  await assertTopLevelEmptyShortcutExits(page, baseUrl, seed, {
    blockId: seed.blockIds.emptyBulletExit,
    trigger: '- ',
    typedLabel: 'Bulleted list block text',
    type: 'bulleted_list_item',
    text: seed.emptyBulletExitText,
    label: 'top-level empty bullet',
  });
  await assertTopLevelEmptyShortcutExits(page, baseUrl, seed, {
    blockId: seed.blockIds.emptyTodoExit,
    trigger: '[] ',
    typedLabel: 'To-do list block text',
    type: 'to_do',
    text: seed.emptyTodoExitText,
    label: 'top-level empty to-do',
  });

  for (const spec of seed.emptyNestedListExitCases) {
    await assertNestedEmptyListOutdentsThenExits(page, baseUrl, seed, spec);
  }

  for (const spec of seed.emptyContainerExitCases) {
    await assertEmptyContainerParagraphExits(page, baseUrl, seed, spec);
  }
}

async function assertTopLevelEmptyShortcutExits(page, baseUrl, seed, spec) {
  await blockTextBox(page, spec.blockId, 'Text block text').click({ timeout: options.timeoutMs });
  await page.keyboard.type(spec.trigger);
  await waitForBlock(
    baseUrl,
    seed,
    spec.blockId,
    (block) => block?.type === spec.type && (block.plainText ?? '') === '',
    `${spec.label} Markdown shortcut`,
  );
  await waitForFocusedBlockTextbox(page, spec.blockId, spec.typedLabel);

  await page.keyboard.press('Enter');
  await waitForBlock(
    baseUrl,
    seed,
    spec.blockId,
    (block) => block?.type === 'paragraph' && (block.plainText ?? '') === '' && block.parentId == null,
    `${spec.label} exits to an empty paragraph`,
  );
  await waitForFocusedBlockTextbox(page, spec.blockId, 'Text block text');

  await page.keyboard.type(spec.text);
  await waitForBlock(
    baseUrl,
    seed,
    spec.blockId,
    (block) => block?.type === 'paragraph' && block.plainText === spec.text && block.parentId == null,
    `${spec.label} keeps caret after exit`,
  );
}

async function assertNestedEmptyListOutdentsThenExits(page, baseUrl, seed, spec) {
  await blockTextBox(page, spec.childId, spec.label).click({ timeout: options.timeoutMs });
  await waitForFocusedBlockTextbox(page, spec.childId, spec.label);

  await page.keyboard.press('Enter');
  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const parent = blocks.find((block) => block.id === spec.parentId);
      const child = blocks.find((block) => block.id === spec.childId);
      return (
        parent?.id &&
        child?.type === spec.type &&
        child.parentId === (parent.parentId ?? null) &&
        child.position > parent.position &&
        (child.plainText ?? '') === ''
      );
    },
    `${spec.name} empty item outdents one level`,
  );
  await waitForFocusedBlockTextbox(page, spec.childId, spec.label);

  await page.keyboard.press('Enter');
  await waitForBlock(
    baseUrl,
    seed,
    spec.childId,
    (block) => block?.type === 'paragraph' && block.parentId == null && (block.plainText ?? '') === '',
    `${spec.name} empty top-level item exits to paragraph`,
  );
  await waitForFocusedBlockTextbox(page, spec.childId, 'Text block text');

  await page.keyboard.type(spec.text);
  await waitForBlock(
    baseUrl,
    seed,
    spec.childId,
    (block) => block?.type === 'paragraph' && block.parentId == null && block.plainText === spec.text,
    `${spec.name} keeps caret after paragraph exit`,
  );
}

async function assertEmptyContainerParagraphExits(page, baseUrl, seed, spec) {
  await blockTextBox(page, spec.childId, 'Text block text').click({ timeout: options.timeoutMs });
  await waitForFocusedBlockTextbox(page, spec.childId, 'Text block text');
  await page.keyboard.press('Enter');

  await waitForBlocks(
    baseUrl,
    seed,
    (blocks) => {
      const parent = blocks.find((block) => block.id === spec.parentId);
      const child = blocks.find((block) => block.id === spec.childId);
      return (
        parent?.id &&
        child?.type === 'paragraph' &&
        child.parentId === (parent.parentId ?? null) &&
        child.position > parent.position &&
        (child.plainText ?? '') === ''
      );
    },
    `${spec.name} empty paragraph exits parent container`,
  );
  await waitForFocusedBlockTextbox(page, spec.childId, 'Text block text');

  await page.keyboard.type(spec.text);
  await waitForBlock(
    baseUrl,
    seed,
    spec.childId,
    (block) => block?.type === 'paragraph' && block.parentId == null && block.plainText === spec.text,
    `${spec.name} keeps caret after parent escape`,
  );
}

async function typeMarkdownShortcut(page, blockId, fromLabel, trigger, toLabel, text) {
  await blockTextBox(page, blockId, fromLabel).click({ timeout: options.timeoutMs });
  await page.keyboard.type(trigger);
  await blockTextBox(page, blockId, toLabel).waitFor({ state: 'visible', timeout: options.timeoutMs });
  await waitForFocusedBlockTextbox(page, blockId, toLabel);
  await blockTextBox(page, blockId, toLabel).type(text, { timeout: options.timeoutMs });
}

async function typeIntoBlock(page, blockId, label, text) {
  const textbox = blockTextBox(page, blockId, label);
  await textbox.click({ timeout: options.timeoutMs });
  await page.keyboard.type(text);
}

function blockGroup(page, blockId) {
  return page.locator(`[data-block-id="${blockId}"]`);
}

function blockTextBox(page, blockId, label) {
  return blockGroup(page, blockId).getByRole('textbox', { name: label });
}

async function pastePlainText(locator, text) {
  await locator.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    element.dispatchEvent(event);
  }, text);
}

async function pasteHtml(locator, html, text = '') {
  await locator.evaluate(
    (element, payload) => {
      const data = new DataTransfer();
      data.setData('text/html', payload.html);
      if (payload.text) data.setData('text/plain', payload.text);
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      element.dispatchEvent(event);
    },
    { html, text },
  );
}

async function pressTextMarkShortcut(page, locator, text, shortcut) {
  await locator.evaluate((element, target) => {
    const fullText = element.textContent ?? '';
    const start = fullText.indexOf(target);
    if (start < 0) throw new Error(`Text "${target}" was not found in editable text "${fullText}"`);
    const end = start + target.length;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    let node = walker.nextNode();
    while (node) {
      const value = node.textContent ?? '';
      const nextOffset = offset + value.length;
      if (!startNode && start >= offset && start <= nextOffset) {
        startNode = node;
        startOffset = start - offset;
      }
      if (endNode === null && end >= offset && end <= nextOffset) {
        endNode = node;
        endOffset = end - offset;
        break;
      }
      offset = nextOffset;
      node = walker.nextNode();
    }
    if (!startNode || !endNode) throw new Error(`Could not select "${target}"`);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.focus();
  }, text);
  await page.keyboard.press(shortcut);
}

async function selectTextInLocator(locator, text) {
  await locator.evaluate((element, target) => {
    const fullText = element.textContent ?? '';
    const start = fullText.indexOf(target);
    if (start < 0) throw new Error(`Text "${target}" was not found in editable text "${fullText}"`);
    const end = start + target.length;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    let node = walker.nextNode();
    while (node) {
      const value = node.textContent ?? '';
      const nextOffset = offset + value.length;
      if (!startNode && start >= offset && start <= nextOffset) {
        startNode = node;
        startOffset = start - offset;
      }
      if (endNode === null && end >= offset && end <= nextOffset) {
        endNode = node;
        endOffset = end - offset;
        break;
      }
      offset = nextOffset;
      node = walker.nextNode();
    }
    if (!startNode || !endNode) throw new Error(`Could not select "${target}"`);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.focus();
  }, text);
}

function seedBlockId(seed, key) {
  const id = seed.blockIds[key];
  assert(id, `missing seed block id for ${key}`);
  return id;
}

async function expectPageTitle(page, title) {
  await page.waitForFunction(
    (expected) => {
      return (document.body?.innerText ?? '').includes(expected);
    },
    title,
    { timeout: options.timeoutMs },
  );
}

async function waitForBlock(baseUrl, seed, blockId, predicate, label) {
  return waitForBlocks(
    baseUrl,
    seed,
    (blocks) => predicate(blocks.find((block) => block.id === blockId) ?? null),
    label,
  );
}

async function waitForBlocks(baseUrl, seed, predicate, label) {
  const startedAt = Date.now();
  let lastBlocks = [];
  while (Date.now() - startedAt < options.timeoutMs) {
    lastBlocks = await fetchSeedBlocks(baseUrl, seed);
    if (predicate(lastBlocks)) return lastBlocks;
    await delay(250);
  }
  throw new Error(`${label} was not persisted for ${seed.pageId}; last blocks=${JSON.stringify(lastBlocks)}`);
}

async function waitForPage(baseUrl, seed, pageId, predicate, label) {
  const startedAt = Date.now();
  let lastPage = null;
  while (Date.now() - startedAt < options.timeoutMs) {
    lastPage = await fetchPage(baseUrl, seed, pageId);
    if (predicate(lastPage)) return lastPage;
    await delay(250);
  }
  throw new Error(`${label} was not persisted for ${pageId}; last page=${JSON.stringify(lastPage)}`);
}

async function waitForTextInLocator(locator, expected) {
  const startedAt = Date.now();
  let lastText = '';
  while (Date.now() - startedAt < options.timeoutMs) {
    lastText = ((await locator.textContent({ timeout: Math.min(1000, options.timeoutMs) }).catch(() => '')) ?? '').trim();
    if (lastText.includes(expected)) return;
    await delay(150);
  }
  throw new Error(`Expected locator text to include "${expected}", got "${lastText}"`);
}

async function waitForSelectedTab(page, blockId, label, requireFocus = false) {
  await page.waitForFunction(
    ({ blockId: targetBlockId, label: expected, requireFocus: needsFocus }) => {
      const group = document.querySelector(`[data-block-id="${targetBlockId}"]`);
      if (!group) return false;
      const selected = group.querySelector('[role="tab"][aria-selected="true"]');
      if (selected?.textContent?.trim() !== expected) return false;
      return !needsFocus || document.activeElement === selected;
    },
    { blockId, label, requireFocus },
    { timeout: options.timeoutMs },
  );
}

async function waitForFocusedBlockTextbox(page, blockId, label) {
  try {
    await page.waitForFunction(
      ({ blockId: targetBlockId, label: expectedLabel }) => {
        const group = document.querySelector(`[data-block-id="${targetBlockId}"]`);
        if (!group) return false;
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !group.contains(active)) return false;
        if (active.getAttribute('role') !== 'textbox') return false;
        return active.getAttribute('aria-label') === expectedLabel;
      },
      { blockId, label },
      { timeout: options.timeoutMs },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const activeInfo = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return { tag: null };
      const block = active.closest('[data-block-id]');
      return {
        tag: active.tagName,
        role: active.getAttribute('role'),
        ariaLabel: active.getAttribute('aria-label'),
        blockId: block?.getAttribute('data-block-id') ?? null,
        text: (active.textContent ?? '').trim().slice(0, 80),
      };
    }).catch((activeError) => ({ error: activeError instanceof Error ? activeError.message : String(activeError) }));
    throw new Error(
      `expected focused textbox "${label}" in block ${blockId}: ${message}; active=${JSON.stringify(activeInfo)}`
    );
  }
}

async function waitForFocusedBlockControl(page, blockId, selector) {
  await page.waitForFunction(
    ({ blockId: targetBlockId, selector: targetSelector }) => {
      const group = document.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
      if (!group) return false;
      const row = group.querySelector(':scope > [data-type]') ?? group;
      const active = document.activeElement;
      return active instanceof HTMLElement && row.contains(active) && active.matches(targetSelector);
    },
    { blockId, selector },
    { timeout: options.timeoutMs },
  );
}

async function waitForIconSelectedTab(page, blockId, icon, label) {
  await page.waitForFunction(
    ({ blockId: targetBlockId, icon: expectedIcon, label: expectedLabel }) => {
      const group = document.querySelector(`[data-block-id="${targetBlockId}"]`);
      if (!group) return false;
      const selected = group.querySelector('[role="tab"][aria-selected="true"]');
      const text = selected?.textContent?.trim() ?? '';
      return text.includes(expectedIcon) && text.includes(expectedLabel);
    },
    { blockId, icon, label },
    { timeout: options.timeoutMs },
  );
}

function sortedTabLabels(blocks, tabBlockId) {
  return blocks
    .filter((block) => block.parentId === tabBlockId && block.type === 'paragraph')
    .sort((a, b) => a.position - b.position);
}

function sortedColumns(blocks, columnListId) {
  return blocks
    .filter((block) => block.parentId === columnListId && block.type === 'column')
    .sort((a, b) => a.position - b.position);
}

async function fetchSeedBlocks(baseUrl, seed) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'blocks',
    pageId: seed.pageId,
  });
  return Array.isArray(result?.blocks) ? result.blocks : [];
}

async function fetchPage(baseUrl, seed, pageId) {
  const result = await callFunction(baseUrl, seed.accessToken, 'page-query', {
    action: 'page',
    pageId,
  });
  return result?.page ?? null;
}

async function seedEditorPage(baseUrl) {
  const session = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id for block editor UI smoke');

  const suffix = Date.now();
  const pageId = randomUUID();
  const title = `Block editor smoke ${suffix}`;
  const blockIds = {
    plain: randomUUID(),
    selectionEnter: randomUUID(),
    selectionPaste: randomUUID(),
    koreanIme: randomUUID(),
    japaneseIme: randomUUID(),
    chineseIme: randomUUID(),
    keyboardMarks: randomUUID(),
    richPaste: randomUUID(),
    fileDrop: randomUUID(),
    videoDrop: randomUUID(),
    richInlinePaste: randomUUID(),
    todo: randomUUID(),
    slashPage: randomUUID(),
    pastedUrlMention: randomUUID(),
    tabs: randomUUID(),
    pastedTabs: randomUUID(),
    htmlTabs: randomUUID(),
    importedTabs: randomUUID(),
    importedTabLabel: randomUUID(),
    importedTabBody: randomUUID(),
    columns: randomUUID(),
    button: randomUUID(),
    synced: randomUUID(),
    heading: randomUUID(),
    toggle: randomUUID(),
    inlineSymbols: randomUUID(),
    inlineCodeSymbols: randomUUID(),
    inlineStrike: randomUUID(),
    numbered: randomUUID(),
    codeFence: randomUUID(),
    divider: randomUUID(),
    focusHeading: randomUUID(),
    focusTodo: randomUUID(),
    focusBullet: randomUUID(),
    focusQuote: randomUUID(),
    focusCallout: randomUUID(),
    focusToggle: randomUUID(),
    focusTable: randomUUID(),
    focusEquation: randomUUID(),
    focusImage: randomUUID(),
    focusBookmark: randomUUID(),
    focusEmbed: randomUUID(),
    focusToc: randomUUID(),
    focusButton: randomUUID(),
    emptyBulletExit: randomUUID(),
    emptyTodoExit: randomUUID(),
    nestedBulletParent: randomUUID(),
    nestedBulletChild: randomUUID(),
    nestedNumberedParent: randomUUID(),
    nestedNumberedChild: randomUUID(),
    nestedTodoParent: randomUUID(),
    nestedTodoChild: randomUUID(),
    quoteEscapeParent: randomUUID(),
    quoteEscapeChild: randomUUID(),
    calloutEscapeParent: randomUUID(),
    calloutEscapeChild: randomUUID(),
  };

  const created = await callFunction(baseUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title,
    position: suffix,
  });
  assert(created?.page?.id === pageId, 'block editor UI smoke page must be created');

  const imeCases = [
    {
      blockId: blockIds.koreanIme,
      composingText: '괴',
      label: 'Korean',
      text: '그러니까 이게 뭐냐고괴',
    },
    {
      blockId: blockIds.japaneseIme,
      composingText: '語',
      label: 'Japanese',
      text: 'これは入力中語',
    },
    {
      blockId: blockIds.chineseIme,
      composingText: '汉',
      label: 'Chinese',
      text: '这是输入中汉',
    },
  ];
  const imeCaseByBlockId = new Map(imeCases.map((imeCase) => [imeCase.blockId, imeCase]));
  const rootParagraphBlockIds = [
    blockIds.plain,
    blockIds.selectionEnter,
    blockIds.selectionPaste,
    blockIds.koreanIme,
    blockIds.japaneseIme,
    blockIds.chineseIme,
    blockIds.keyboardMarks,
    blockIds.richPaste,
    blockIds.fileDrop,
    blockIds.richInlinePaste,
    blockIds.todo,
    blockIds.slashPage,
    blockIds.pastedUrlMention,
    blockIds.tabs,
    blockIds.pastedTabs,
    blockIds.htmlTabs,
    blockIds.columns,
    blockIds.button,
    blockIds.synced,
    blockIds.heading,
    blockIds.toggle,
    blockIds.inlineSymbols,
    blockIds.inlineCodeSymbols,
    blockIds.inlineStrike,
    blockIds.numbered,
    blockIds.codeFence,
    blockIds.divider,
    blockIds.focusHeading,
    blockIds.focusTodo,
    blockIds.focusBullet,
    blockIds.focusQuote,
    blockIds.focusCallout,
    blockIds.focusToggle,
    blockIds.focusTable,
    blockIds.focusEquation,
    blockIds.focusImage,
    blockIds.focusBookmark,
    blockIds.focusEmbed,
    blockIds.focusToc,
    blockIds.focusButton,
    blockIds.emptyBulletExit,
    blockIds.emptyTodoExit,
  ];
  const blocks = rootParagraphBlockIds.map((id, index) => {
    const initialText = imeCaseByBlockId.get(id)?.text ?? '';
    return {
      id,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: { rich: initialText ? [{ text: initialText }] : [] },
      plainText: initialText,
      position: index + 1,
    };
  });
  blocks.push({
    id: blockIds.videoDrop,
    pageId,
    parentId: null,
    type: 'video',
    content: {},
    plainText: '',
    position: rootParagraphBlockIds.length + 1,
  });
  const importedTabIcon = '\u{1F680}';
  const importedTabLabel = `Launch ${suffix}`;
  const importedTabBody = `Imported tab body ${suffix}`;
  blocks.push(
    {
      id: blockIds.importedTabs,
      pageId,
      parentId: null,
      type: 'tab',
      content: { rich: [] },
      plainText: '',
      position: rootParagraphBlockIds.length + 2,
    },
    {
      id: blockIds.importedTabLabel,
      pageId,
      parentId: blockIds.importedTabs,
      type: 'paragraph',
      content: { rich: [{ text: importedTabLabel }], icon: importedTabIcon },
      plainText: importedTabLabel,
      position: 1,
    },
    {
      id: blockIds.importedTabBody,
      pageId,
      parentId: blockIds.importedTabLabel,
      type: 'paragraph',
      content: { rich: [{ text: importedTabBody }] },
      plainText: importedTabBody,
      position: 1,
    },
  );
  const nestedStart = rootParagraphBlockIds.length + 5;
  blocks.push(
    {
      id: blockIds.nestedBulletParent,
      pageId,
      parentId: null,
      type: 'bulleted_list_item',
      content: { rich: [{ text: `Parent bullet ${suffix}` }] },
      plainText: `Parent bullet ${suffix}`,
      position: nestedStart,
    },
    {
      id: blockIds.nestedBulletChild,
      pageId,
      parentId: blockIds.nestedBulletParent,
      type: 'bulleted_list_item',
      content: { rich: [] },
      plainText: '',
      position: 1,
    },
    {
      id: blockIds.nestedNumberedParent,
      pageId,
      parentId: null,
      type: 'numbered_list_item',
      content: { rich: [{ text: `Parent numbered ${suffix}` }] },
      plainText: `Parent numbered ${suffix}`,
      position: nestedStart + 1,
    },
    {
      id: blockIds.nestedNumberedChild,
      pageId,
      parentId: blockIds.nestedNumberedParent,
      type: 'numbered_list_item',
      content: { rich: [] },
      plainText: '',
      position: 1,
    },
    {
      id: blockIds.nestedTodoParent,
      pageId,
      parentId: null,
      type: 'to_do',
      content: { rich: [{ text: `Parent to-do ${suffix}` }], checked: false },
      plainText: `Parent to-do ${suffix}`,
      position: nestedStart + 2,
    },
    {
      id: blockIds.nestedTodoChild,
      pageId,
      parentId: blockIds.nestedTodoParent,
      type: 'to_do',
      content: { rich: [], checked: false },
      plainText: '',
      position: 1,
    },
    {
      id: blockIds.quoteEscapeParent,
      pageId,
      parentId: null,
      type: 'quote',
      content: { rich: [{ text: `Parent quote ${suffix}` }] },
      plainText: `Parent quote ${suffix}`,
      position: nestedStart + 3,
    },
    {
      id: blockIds.quoteEscapeChild,
      pageId,
      parentId: blockIds.quoteEscapeParent,
      type: 'paragraph',
      content: { rich: [] },
      plainText: '',
      position: 1,
    },
    {
      id: blockIds.calloutEscapeParent,
      pageId,
      parentId: null,
      type: 'callout',
      content: { rich: [{ text: `Parent callout ${suffix}` }], icon: '💡' },
      plainText: `Parent callout ${suffix}`,
      position: nestedStart + 4,
    },
    {
      id: blockIds.calloutEscapeChild,
      pageId,
      parentId: blockIds.calloutEscapeParent,
      type: 'paragraph',
      content: { rich: [] },
      plainText: '',
      position: 1,
    },
  );
  const createdBlocks = await callFunction(baseUrl, session.accessToken, 'block-mutation', {
    action: 'createMany',
    blocks,
  });
  assert(createdBlocks?.blocks?.length === blocks.length, 'block editor UI smoke blocks must be created');

  const keyboardMarkSegments = {
    bold: `Keyboard bold ${suffix}`,
    italic: `Keyboard italic ${suffix}`,
    underline: `Keyboard underline ${suffix}`,
    code: `Keyboard code ${suffix}`,
    strike: `Keyboard strike ${suffix}`,
  };

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId,
    pageId,
    title,
    blockIds,
    initialBlockCount: blocks.length,
    plainText: `Plain writing ${suffix}`,
    imeCases,
    keyboardMarkSegments,
    keyboardMarkText: Object.values(keyboardMarkSegments).join(' '),
    todoText: `Slash task ${suffix}`,
    pastedUrlMentionUrl: 'https://www.naver.com/',
    pastedUrlMentionTitle: '네이버',
    importedTabIcon,
    importedTabLabel,
    importedTabBody,
    columnText: `Column writing ${suffix}`,
    buttonLabel: `Insert task ${suffix}`,
    buttonText: `Button task ${suffix}`,
    syncedText: `Synced writing ${suffix}`,
    headingText: `Shortcut heading ${suffix}`,
    toggleChildText: `Nested shortcut toggle writing ${suffix}`,
    toggleText: `Shortcut toggle ${suffix}`,
    inlineSymbolExpectedText: `Arrows ${suffix}: right → left ←`,
    inlineSymbolTypedText: `Arrows ${suffix}: right -> left <-`,
    inlineCodeSymbolExpectedText: `Code arrows ${suffix}: right ->`,
    inlineCodeSymbolTypedText: `Code arrows ${suffix}: \`right ->\``,
    inlineStrikeExpectedText: `Strike ${suffix}: single and double`,
    inlineStrikeTypedText: `Strike ${suffix}: ~single~ and ~~double~~`,
    numberedFirstText: `Numbered first ${suffix}`,
    numberedSecondText: `Numbered second ${suffix}`,
    codeFenceText: `const shortcut_${suffix} = true;`,
    focusHeadingText: `Focused heading ${suffix}`,
    focusHeadingNextText: `Heading continuation ${suffix}`,
    focusTodoText: `Focused task ${suffix}`,
    focusTodoNextText: `Next focused task ${suffix}`,
    focusBulletText: `Focused bullet ${suffix}`,
    focusBulletNextText: `Next focused bullet ${suffix}`,
    focusQuoteText: `Focused quote ${suffix}`,
    focusQuoteNextText: `Quote continuation ${suffix}`,
    focusCalloutText: `Focused callout ${suffix}`,
    focusCalloutNextText: `Callout continuation ${suffix}`,
    focusToggleText: `안녕 ${suffix}`,
    focusToggleChildText: `한번 엔터 자식 ${suffix}`,
    focusTableText: `Focused table cell ${suffix}`,
    focusEquationText: `x_${suffix}=1`,
    focusEquationNextText: `Equation continuation ${suffix}`,
    focusImageUrl: resolveUrl(baseUrl, `/api/health?focus-image=${suffix}`),
    focusImageNextText: `Image continuation ${suffix}`,
    focusBookmarkUrl: resolveUrl(baseUrl, `/api/health?focus-bookmark=${suffix}`),
    focusBookmarkNextText: `Bookmark continuation ${suffix}`,
    focusEmbedUrl: 'https://www.npmjs.com',
    focusEmbedCaptionText: `One line caption ${suffix}`,
    focusEmbedCaptionNextText: `Caption continuation ${suffix}`,
    focusTocNextText: `TOC continuation ${suffix}`,
    focusButtonNextText: `Button continuation ${suffix}`,
    emptyBulletExitText: `After empty bullet ${suffix}`,
    emptyTodoExitText: `After empty task ${suffix}`,
    emptyNestedListExitCases: [
      {
        name: 'nested bullet',
        parentId: blockIds.nestedBulletParent,
        childId: blockIds.nestedBulletChild,
        type: 'bulleted_list_item',
        label: 'Bulleted list block text',
        text: `After nested bullet ${suffix}`,
      },
      {
        name: 'nested numbered list',
        parentId: blockIds.nestedNumberedParent,
        childId: blockIds.nestedNumberedChild,
        type: 'numbered_list_item',
        label: 'Numbered list block text',
        text: `After nested number ${suffix}`,
      },
      {
        name: 'nested to-do',
        parentId: blockIds.nestedTodoParent,
        childId: blockIds.nestedTodoChild,
        type: 'to_do',
        label: 'To-do list block text',
        text: `After nested task ${suffix}`,
      },
    ],
    emptyContainerExitCases: [
      {
        name: 'quote child',
        parentId: blockIds.quoteEscapeParent,
        childId: blockIds.quoteEscapeChild,
        text: `After quote child ${suffix}`,
      },
      {
        name: 'callout child',
        parentId: blockIds.calloutEscapeParent,
        childId: blockIds.calloutEscapeChild,
        text: `After callout child ${suffix}`,
      },
    ],
  };
}

async function cleanupSeed(baseUrl, seed) {
  if (!seed?.accessToken || !seed?.pageId) return;
  await callFunction(baseUrl, seed.accessToken, 'page-mutation', {
    action: 'delete',
    id: seed.pageId,
  }, 10_000).catch(() => {});
}

async function seedSession(context, seed) {
  await context.addInitScript(({ refreshToken, workspaceId }) => {
    window.localStorage.setItem('edgebase:refresh-token', refreshToken);
    window.localStorage.setItem('notionlike.workspaceId', workspaceId);
  }, {
    refreshToken: seed.refreshToken,
    workspaceId: seed.workspaceId,
  });
}

async function newCheckedPage(browser) {
  const context = await browser.newContext();
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

function isExpectedExternalEmbedBrowserMessage(message) {
  return (
    message.includes('Failed to load resource:') ||
    message.includes("Refused to display 'https://www.npmjs.com/' in a frame") ||
    message.includes("Failed to read the 'localStorage' property from 'Window': Access is denied for this document.")
  );
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

async function callFunction(baseUrl, token, name, body, timeoutMs = options.timeoutMs) {
  const response = await fetch(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
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
    'Playwright is required for block editor UI smoke. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.',
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
    onlyFocusFlow: false,
    onlyFileDrop: false,
    onlyEmbedCaptionSlash: false,
    onlyEmptyListEnter: false,
    onlyImeFlow: false,
    onlyMarkdownShortcuts: false,
      onlyPastedUrlMention: false,
      onlySelectionToolbar: false,
      onlySelectionEdit: false,
      onlySlashPageTitle: false,
      onlyTabs: false,
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
    if (arg === '--only-file-drop') {
      parsed.onlyFileDrop = true;
      continue;
    }
    if (arg === '--only-focus-flow') {
      parsed.onlyFocusFlow = true;
      continue;
    }
    if (arg === '--only-embed-caption-slash') {
      parsed.onlyEmbedCaptionSlash = true;
      continue;
    }
    if (arg === '--only-empty-list-enter') {
      parsed.onlyEmptyListEnter = true;
      continue;
    }
    if (arg === '--only-ime-flow') {
      parsed.onlyImeFlow = true;
      continue;
    }
    if (arg === '--only-slash-page-title') {
      parsed.onlySlashPageTitle = true;
      continue;
    }
    if (arg === '--only-pasted-url-mention') {
      parsed.onlyPastedUrlMention = true;
      continue;
    }
    if (arg === '--only-markdown-shortcuts') {
      parsed.onlyMarkdownShortcuts = true;
      continue;
    }
    if (arg === '--only-selection-toolbar') {
      parsed.onlySelectionToolbar = true;
      continue;
    }
    if (arg === '--only-tabs') {
      parsed.onlyTabs = true;
      continue;
    }
    if (arg === '--only-selection-edit') {
      parsed.onlySelectionEdit = true;
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
  console.log(`Usage: node scripts/block-editor-ui-smoke.mjs [options]

Checks core block editor interactions with DOM and product API persistence
assertions only: plain typing, rich HTML paste, slash to-do/synced/tabs/columns/
button insertion, keyboard tab switching, pasted/imported tab icon rendering,
column management, button configuration/execution, synced copy/unsync behavior,
Markdown heading/toggle/divider shortcuts, checkbox state, and toggle collapse.

Options:
  --url <url>             App URL. Defaults to NOTIONLIKE_EDGEBASE_URL or ${DEFAULT_BASE_URL}.
  --api-url <url>         EdgeBase API URL. Defaults to NOTIONLIKE_EDGEBASE_API_URL or ${DEFAULT_BASE_URL}.
  --timeout-ms <number>   Browser/action timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --only-file-drop        Check only external file drag/drop onto a block row.
  --only-focus-flow       Check block creation focus and Enter continuation only.
  --only-embed-caption-slash
                          Check default-hidden embed captions and next-line slash continuation.
  --only-empty-list-enter
                          Check empty list/container Enter exit and outdent behavior.
  --only-ime-flow         Check only IME Enter composition and next-block behavior.
  --only-slash-page-title
                          Check only blank /page creation title placeholder behavior.
  --only-pasted-url-mention
                          Check only external URL paste-to-mention metadata behavior.
  --only-markdown-shortcuts
                          Check only Markdown and symbol typing shortcuts.
  --only-selection-toolbar
                          Check selected-text toolbar persistence after inline formatting clicks.
  --only-tabs             Check slash-created tabs and IME-safe tab rename Enter handling only.
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function dispatchComposingEnter(locator) {
  await locator.evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      which: 229,
    });
    Object.defineProperty(event, 'isComposing', { value: true });
    element.dispatchEvent(event);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
