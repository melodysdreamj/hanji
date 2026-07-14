"use client";

import { lazy, Suspense, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject, type ReactNode, memo, useCallback, createContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { copyText } from "@/lib/clipboard";
import { i18next } from "@/i18n";
import { isSafeEmbedTarget } from "@/lib/fileSecurity";
import { storageKeyFromUrl, useWorkspaceFileUrl } from "@/lib/fileUrls";
import { positionBetween } from "@/lib/ids";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { motionSafeScrollBehavior } from "@/lib/motion";
import { isolateBodyForModal, trapModalTab } from "@/lib/modalFocus";
import { absolutePageUrl, absoluteSharedPageUrl, pageHref, sharedPageHref } from "@/lib/navigation";
import { pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { linkedDatabaseResolvedTitle, pageDisplayTitle } from "@/lib/pageTitle";
import type { PageAwarenessTextRange, PagePresenceAwareness } from "@/lib/pagePresence";
import { uploadWorkspaceFile } from "@/lib/storage";
import type { Block, BlockContent, BlockType, ButtonTemplateBlock, Page, TextSpan } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import { useStore } from "@/lib/store";
import { NotionSelect } from "../database/NotionSelect";
import { BLOCK_DRAG_TYPE } from "../dndTypes";
import { EmojiPicker } from "../EmojiPicker";
import { PageIconGlyph } from "../PageIcon";
import { RowMenu } from "../RowMenu";
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon, ArrowDown, ArrowUp, AudioIcon, BookmarkIcon, CalendarIcon, CheckIcon, ChevronLeft, ChevronRight, Copy, Database, DotsHorizontal, EyeSlashIcon, FileText, ImageIcon, LayoutIcon, LinkIcon, OpenInNew, Pencil, Plus, SmileIcon, SyncIcon, Trash, VideoIcon } from "../icons";
import { caretOffset, focusBlockControlSettled, focusEditableSettled, getEditable, placeCaret } from "./focus";
import { blockUploadErrorMessage, blockUploadProgressLabel, dataTransferHasFiles, droppedFiles, type BlockUploadProgress, type FileDropPlacement } from "./fileDrop";
import { htmlToSpans, safeUrl, spansToHtml } from "./richtext";
import { inlineDatabasePlaceholderTitle, inlineDatabaseTitleDisplay, meaningfulInlineDatabaseTitle } from "./databaseTitles";
import { TEXT_BLOCKS } from "./blocks";
import { BlockHandle } from "./BlockHandle";
import { BlockIcon } from "./BlockIcon";
import { SimpleTableContent } from "./SimpleTableContent";
import { pageTitle, type MentionTrigger } from "./BlockPickerMenus";
import { TextBlock } from "./TextBlock";
import { blockItemLabels, blockItemText, blockTypeLabel, blockTypePlaceholder } from "./blockItemLabels";
import { getLastEditorColor } from "./colorMemory";
import { providerEmbedUrl, streamingVideoEmbed } from "./mediaEmbeds";
import { normalizePastedLink, printableTextKey, shortcutBlockType, shortcutTextMark } from "./editorInputModel";
import type { EditorOps } from "./Editor";
import { parseInternalPastedBlocks, parsePastedHtml, parsePastedMarkdown } from "./markdownPaste";
import styles from "./editor.module.css";

type InlinePageMenuAnchor = { x: number; y: number };

// The contentEditable sync effects reassign innerHTML only when the DOM no
// longer matches the rendered spans. A naive `el.innerHTML !== spansToHtml(...)`
// compares the browser's serialization (which leaves ' " literal) against
// escapeHtml's output (which escapes them to &#39;/&quot;), so any block
// containing an apostrophe/quote/nbsp mismatches on EVERY keystroke, reassigns
// innerHTML, and destroys the caret. Canonicalize the target through a detached
// element so both sides use the browser's serialization and the guard is a true
// no-op while typing.
let htmlSerializationScratch: HTMLDivElement | null = null;
function editableHtmlMatches(el: HTMLElement, html: string): boolean {
  const current = el.innerHTML.replace(/\u200B/g, "");
  if (typeof document === "undefined") return current === html;
  if (!htmlSerializationScratch) htmlSerializationScratch = document.createElement("div");
  htmlSerializationScratch.innerHTML = html;
  return current === htmlSerializationScratch.innerHTML;
}

function editorPageHref(ops: EditorOps, pageId: string) {
  return ops.publicReadOnly && ops.sharedToken ? sharedPageHref(ops.sharedToken, pageId) : pageHref(pageId);
}

function blockMenuAnchorFromElement(element: HTMLElement): BlockMenuAnchor {
  const rect = element.getBoundingClientRect();
  const y = rect.bottom + 4;
  return {
    x: rect.left - 10,
    y,
    bottom: y,
  };
}

function editorAbsolutePageUrl(ops: EditorOps, pageId: string) {
  return ops.publicReadOnly && ops.sharedToken
    ? absoluteSharedPageUrl(ops.sharedToken, pageId)
    : absolutePageUrl(pageId);
}

function inlinePageMenuAnchorFor(element: HTMLElement): InlinePageMenuAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + 12, y: rect.bottom + 4 };
}

function inlinePageMenuAnchorFromMouseEvent(e: ReactMouseEvent<HTMLElement>): InlinePageMenuAnchor {
  if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
    return { x: e.clientX, y: e.clientY };
  }
  return inlinePageMenuAnchorFor(e.currentTarget);
}

function isInlinePageMenuKeyboardEvent(e: ReactKeyboardEvent<HTMLElement>) {
  return e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
}

function closeCompetingPageLinkMenus() {
  if (typeof document === "undefined") return;
  const closeLabels = new Set([
    i18next.t("blockHandle:buttons.closeBlockActions"),
    i18next.t("rowMenu:aria.closeDatabaseRowActions"),
    i18next.t("rowMenu:aria.closePageActions"),
  ]);
  document.querySelectorAll<HTMLButtonElement>("button[aria-label]").forEach((button) => {
    if (closeLabels.has(button.getAttribute("aria-label") ?? "")) button.click();
  });
}

const DatabaseView = lazy(() =>
  import("../database/DatabaseView").then(({ DatabaseView }) => ({ default: DatabaseView }))
);
const CodeHighlight = lazy(() =>
  import("./CodeHighlight").then(({ CodeHighlight }) => ({ default: CodeHighlight }))
);
const EquationPreview = lazy(() =>
  import("./EquationPreview").then(({ EquationPreview }) => ({ default: EquationPreview }))
);
const MermaidPreview = lazy(() =>
  import("./MermaidPreview").then(({ MermaidPreview }) => ({ default: MermaidPreview }))
);

// Open the slash menu only when "/" starts a token (block start or after space).
const SLASH_RE = /(?:^|\s)\/([\p{L}\w]*)$/u;
const MENTION_RE = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u;
const PAGE_LINK_RE = /(?:^|\s)\[\[([^\]\n]*)$/u;
const PASTED_URL_MENU_REQUEST = "hanji:pasted-url-menu-request";
type DropPlacement = "before" | "after" | "inside";
type BlockMenuAnchor = { x: number; y: number; bottom?: number };
type BlockFrameActions = {
  openBlockMenu: (anchor?: BlockMenuAnchor | null) => void;
  closeBlockMenu: () => void;
};
type InlineMenuAnchor = Pick<DOMRect, "left" | "top" | "bottom">;
const INLINE_LINK_MENU_WIDTH = 420;
const INLINE_LINK_MENU_HEIGHT = 82;
const INLINE_DATE_MENU_WIDTH = 286;
const INLINE_DATE_MENU_HEIGHT = 352;
const INLINE_PERSON_MENU_WIDTH = 280;
const INLINE_PERSON_MENU_HEIGHT = 146;
const INLINE_PAGE_MENU_WIDTH = 300;
const INLINE_PAGE_MENU_HEIGHT = 150;
const INLINE_DATABASE_MENU_WIDTH = 292;
const INLINE_DATABASE_MENU_HEIGHT = 344;
const INLINE_DATABASE_COMMAND_EVENT = "hanji:inline-database-command";
const INLINE_DATABASE_TOOLBAR_MENU_EVENT = "hanji:open-inline-database-toolbar-menu";

const BlockFrameActionsContext = createContext<BlockFrameActions | null>(null);
const PASTED_URL_MENU_WIDTH = 280;
const PASTED_URL_MENU_HEIGHT = 220;
const MENU_VIEWPORT_MARGIN = 8;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

function inlineDatabaseTitleWidth(title: string): string {
  const units = Array.from(title || inlineDatabasePlaceholderTitle()).reduce((width, char) => {
    if (HANGUL_RE.test(char)) return width + 2.55;
    if (/\s/u.test(char)) return width + 0.75;
    return width + 1;
  }, 1.5);

  return `${Math.max(9, Math.min(56, units))}ch`;
}

function InlineDatabaseFallback() {
  return (
    <div
      className={styles.inlineDatabaseFallback}
      data-inline-database-fallback
      aria-busy="true"
      aria-label={blockItemText("database.loading")}
    >
      <div className={styles.inlineDatabaseFallbackChrome}>
        <div className={styles.inlineDatabaseFallbackTabs}>
          <span className={styles.inlineDatabaseFallbackTab}>
            <Database size={14} aria-hidden="true" />
            <span>{blockItemText("database.defaultView")}</span>
          </span>
        </div>
        <div className={styles.inlineDatabaseFallbackTools} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className={styles.inlineDatabaseFallbackTable}>
        <div className={styles.inlineDatabaseFallbackHead}>
          <span data-inline-database-fallback-first-head />
          <span />
          <span />
          <span />
        </div>
        {Array.from({ length: 3 }).map((_, rowIndex) => (
          <div key={rowIndex} className={styles.inlineDatabaseFallbackRow}>
            <span data-inline-database-fallback-first-cell={rowIndex === 0 ? "true" : undefined} />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

function remoteAwarenessText(awareness: PagePresenceAwareness, count: number) {
  const verb = awareness.mode === "selecting" ? "selecting" : "editing";
  return `${awareness.label} ${verb}${count > 1 ? ` +${count - 1}` : ""}`;
}

function remoteAwarenessInitials(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return "?";
  const emailPrefix = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
  const words = emailPrefix
    .replace(/\(you\)$/i, "")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) || "?").toUpperCase();
}

function anchoredMenuPosition(
  anchor: InlineMenuAnchor,
  width: number,
  height: number,
  gap = 8
) {
  const availableWidth = Math.max(0, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
  const availableHeight = Math.max(0, window.innerHeight - MENU_VIEWPORT_MARGIN * 2);
  const menuWidth = Math.min(width, availableWidth);
  const menuHeight = Math.min(height, availableHeight);
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - menuHeight - gap;
  const viewportBottom = window.innerHeight - MENU_VIEWPORT_MARGIN;
  const top =
    belowTop + menuHeight <= viewportBottom
      ? belowTop
      : aboveTop >= MENU_VIEWPORT_MARGIN
        ? aboveTop
        : Math.max(MENU_VIEWPORT_MARGIN, Math.min(belowTop, viewportBottom - menuHeight));

  return {
    left: Math.max(
      MENU_VIEWPORT_MARGIN,
      Math.min(anchor.left, window.innerWidth - menuWidth - MENU_VIEWPORT_MARGIN)
    ),
    top,
  };
}

function inlineMenuAnchorFromRect(rect: Pick<DOMRect, "left" | "top" | "bottom">): InlineMenuAnchor {
  return {
    bottom: rect.bottom,
    left: rect.left,
    top: rect.top,
  };
}

const HEADING_LEVEL: Partial<Record<BlockType, 1 | 2 | 3 | 4>> = {
  heading_1: 1,
  heading_2: 2,
  heading_3: 3,
  heading_4: 4,
  toggle_heading_1: 1,
  toggle_heading_2: 2,
  toggle_heading_3: 3,
  toggle_heading_4: 4,
};

const TOGGLE_BLOCKS: Set<BlockType> = new Set([
  "toggle",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
  "toggle_heading_4",
]);
const PAGE_LINK_BLOCKS: Set<BlockType> = new Set([
  "child_page",
  "link_to_page",
  "child_database",
  "inline_database",
]);

function linkedPageIdForBlock(block: Block) {
  return PAGE_LINK_BLOCKS.has(block.type) ? block.content?.childPageId : undefined;
}

function UploadProgressRow({ progress }: { progress: BlockUploadProgress | null }) {
  if (!progress) return null;
  return (
    <div className={styles.mediaUploadProgress} role="status" aria-live="polite">
      <div className={styles.mediaUploadProgressHeader}>
        <strong>{blockUploadProgressLabel(progress)}</strong>
        <span>{progress.percent}%</span>
      </div>
      <div className={styles.mediaUploadProgressName}>{progress.fileName}</div>
      <div
        className={styles.mediaUploadProgressTrack}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label={blockItemLabels().uploadingFile(progress.fileName)}
      >
        <span style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}


function focusEquationInput(blockId: string) {
  focusBlockControlSettled(blockId, `textarea[data-equation-input="${blockId}"]`);
}

function clampImageWidth(value: number) {
  return Math.max(20, Math.min(100, Math.round(value)));
}


function codeLanguages() {
  return [
    { value: "", label: blockItemText("code.plainText") },
    { value: "javascript", label: "JavaScript" },
    { value: "typescript", label: "TypeScript" },
    { value: "tsx", label: "TSX" },
    { value: "python", label: "Python" },
    { value: "bash", label: "Bash" },
    { value: "json", label: "JSON" },
    { value: "html", label: "HTML" },
    { value: "css", label: "CSS" },
    { value: "sql", label: "SQL" },
    { value: "mermaid", label: "Mermaid" },
  ] as const;
}

const BUTTON_TEMPLATE_BLOCK_TYPES: BlockType[] = [
  "paragraph",
  "to_do",
  "bulleted_list_item",
  "numbered_list_item",
  "heading_2",
  "callout",
];

function shortBlockText(block: Block) {
  const text =
    spansToPlainText(block.content?.rich).trim() ||
    block.plainText?.trim() ||
    "";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function blockAriaLabel(block: Block) {
  const label = blockTypeLabel(block.type);
  const summary = shortBlockText(block);
  return summary
    ? blockItemText("block.ariaWithSummary", { type: label, summary })
    : blockItemText("block.aria", { type: label });
}

function blockTextBoxLabel(block: Block) {
  return blockItemText("block.textbox", { type: blockTypeLabel(block.type) });
}

function blockCaptionText(block: Block) {
  return spansToPlainText(block.content?.caption);
}

function blockCaptionVisible(block: Block) {
  return block.content?.showCaption === true || blockCaptionText(block).length > 0;
}

function blockControlFocusSelector(block: Block) {
  if (block.type === "simple_table") return `[data-table-cell="${block.id}:0:0"]`;
  if (block.type === "equation") return `textarea[data-equation-input="${block.id}"]`;
  if (block.type === "image") {
    if (!block.content?.url) return '[data-block-control="image-link"]';
    return blockCaptionVisible(block) ? '[data-block-control="image-caption"]' : null;
  }
  if (block.type === "video") {
    if (!block.content?.url) return '[data-block-control="video-link"]';
    return blockCaptionVisible(block) ? '[data-block-control="video-caption"]' : null;
  }
  if (block.type === "audio") {
    if (!block.content?.url) return '[data-block-control="audio-link"]';
    return blockCaptionVisible(block) ? '[data-block-control="audio-caption"]' : null;
  }
  if (block.type === "bookmark") {
    return block.content?.url ? null : '[data-block-control="bookmark-link"]';
  }
  if (block.type === "embed") {
    if (!block.content?.url) return '[data-block-control="embed-link"]';
    return blockCaptionVisible(block) ? '[data-block-control="embed-caption"]' : null;
  }
  if (block.type === "file") {
    if (!block.content?.url) return '[data-block-control="file-link"]';
    return blockCaptionVisible(block) ? '[data-block-control="file-caption"]' : null;
  }
  return null;
}

function focusBlockWritingTarget(block: Block, caret: "start" | "end" | number = "end") {
  if (TEXT_BLOCKS.has(block.type)) {
    focusEditableSettled(block.id, caret);
    return true;
  }
  const selector = blockControlFocusSelector(block);
  if (!selector) return false;
  focusBlockControlSettled(block.id, selector);
  return true;
}

function emptyFollowingParagraph(block: Block) {
  const list = (useStore.getState().blocksByPage[block.pageId] ?? [])
    .filter((candidate) => (candidate.parentId ?? null) === (block.parentId ?? null))
    .sort((a, b) => a.position - b.position);
  const index = list.findIndex((candidate) => candidate.id === block.id);
  const next = index >= 0 ? list[index + 1] : undefined;
  if (!next || next.type !== "paragraph") return null;
  return spansToPlainText(next.content?.rich).length === 0 ? next : null;
}

function typeSlashIntoEditableBlock(blockId: string) {
  function insertSlash() {
    const el = getEditable(blockId);
    if (!el) return false;
    placeCaret(el, "start");
    document.execCommand("insertText", false, "/");
    if ((el.textContent ?? "") !== "/") {
      el.textContent = "/";
      el.dataset.empty = "false";
      placeCaret(el, "end");
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    return true;
  }

  if (insertSlash()) return;

  window.requestAnimationFrame(() => {
    if (insertSlash()) return;
    focusEditableSettled(blockId, "start");
    window.requestAnimationFrame(() => {
      insertSlash();
    });
  });
}

function focusAfterCaption(block: Block, ops: EditorOps) {
  const existing = emptyFollowingParagraph(block);
  const targetId = existing?.id ?? ops.insertAfter(block.id, "paragraph")?.id;
  if (targetId) focusEditableSettled(targetId, "start");
}

function singleLineCaptionSpans(spans: TextSpan[]) {
  return spans
    .map((span) => ({
      ...span,
      text: span.text.replace(/\s*[\r\n]+\s*/g, " "),
    }))
    .filter((span) => span.text.length > 0);
}

function singleLineCaptionText(text: string) {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

function redirectEmptyCaptionSlash(
  e: ReactKeyboardEvent<HTMLElement>,
  block: Block,
  ops: EditorOps
) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (e.key !== "/" && e.code !== "Slash") return;
  if ((e.currentTarget.textContent ?? "").replace(/\u200B/g, "").length > 0) return;

  e.preventDefault();
  e.stopPropagation();

  const existing = emptyFollowingParagraph(block);
  const targetId = existing?.id ?? ops.insertAfter(block.id, "paragraph")?.id;
  if (targetId) typeSlashIntoEditableBlock(targetId);
}

function onSingleLineCaptionKeyDown(
  e: ReactKeyboardEvent<HTMLElement>,
  block: Block,
  ops: EditorOps
) {
  if (e.defaultPrevented || isComposingKeyEvent(e)) return;
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    focusAfterCaption(block, ops);
    return;
  }
  redirectEmptyCaptionSlash(e, block, ops);
}

function onSingleLineCaptionPaste(e: React.ClipboardEvent<HTMLElement>) {
  const text = e.clipboardData.getData("text/plain");
  if (!/[\r\n]/.test(text)) return;
  e.preventDefault();
  document.execCommand("insertText", false, singleLineCaptionText(text));
}


// Memoized: the Editor re-renders on every keystroke (the page's block array
// is replaced), but sibling blocks receive the same `block` reference and the
// same memoized `ops` facade, so only the edited block actually re-renders.
// Every prop here must stay referentially stable across unrelated renders —
// see the ops facade in Editor.tsx.
function textBlockRuntime() {
  return {
    editableHtmlMatches,
    CodeHighlight,
    MermaidPreview,
    SLASH_RE,
    PASTED_URL_MENU_REQUEST,
    INLINE_LINK_MENU_WIDTH,
    INLINE_LINK_MENU_HEIGHT,
    INLINE_DATE_MENU_WIDTH,
    INLINE_DATE_MENU_HEIGHT,
    INLINE_PERSON_MENU_WIDTH,
    INLINE_PERSON_MENU_HEIGHT,
    INLINE_PAGE_MENU_WIDTH,
    INLINE_PAGE_MENU_HEIGHT,
    PASTED_URL_MENU_WIDTH,
    PASTED_URL_MENU_HEIGHT,
    MENU_VIEWPORT_MARGIN,
    anchoredMenuPosition,
    inlineMenuAnchorFromRect,
    HEADING_LEVEL,
    TOGGLE_BLOCKS,
    focusEquationInput,
    codeLanguages,
    blockTextBoxLabel,
    focusBlockWritingTarget,
    singleLineCaptionSpans,
    onSingleLineCaptionKeyDown,
    onSingleLineCaptionPaste,
    BlockItem,
    BlockFrame,
    fileNameFromUrl,
    mentionTriggerFromText,
    textOffsetIn,
    selectTextRange,
    textRangeForEditable,
    RemoteTextAwarenessOverlay,
    clearColorAttributes,
    TextFloatingMenuPortal,
  };
}
export type TextBlockRuntime = ReturnType<typeof textBlockRuntime>;

export const BlockItem = memo(function BlockItem({
  block,
  ops,
  depth = 0,
  pagePlaceholder = false,
  pagePlaceholderText,
  onPagePlaceholderInput,
}: {
  block: Block;
  ops: EditorOps;
  depth?: number;
  pagePlaceholder?: boolean;
  pagePlaceholderText?: string;
  onPagePlaceholderInput?: () => void;
}) {
  if (block.type === "column_list") {
    return <ColumnListBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "column") {
    return <ColumnBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "divider") {
    return (
      <BlockFrame block={block} ops={ops} depth={depth}>
        <div className={styles.dividerWrap}>
          <hr className={styles.divider} />
        </div>
      </BlockFrame>
    );
  }
  if (block.type === "equation") {
    return <EquationBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "image") {
    return <ImageBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "video") {
    return <MediaBlock block={block} ops={ops} depth={depth} kind="video" />;
  }
  if (block.type === "audio") {
    return <MediaBlock block={block} ops={ops} depth={depth} kind="audio" />;
  }
  if (block.type === "bookmark") {
    return <BookmarkBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "embed") {
    return <EmbedBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "file") {
    return <FileBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "child_page") {
    return <ChildPageBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "link_to_page") {
    return <LinkToPageBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "child_database") {
    return <ChildDatabaseBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "table_of_contents") {
    return <TableOfContentsBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "synced_block") {
    return <SyncedBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "button") {
    return <ButtonBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "breadcrumb") {
    return <BreadcrumbBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "tab") {
    return <TabBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "inline_database") {
    return <InlineDatabaseBlock block={block} ops={ops} depth={depth} />;
  }
  if (block.type === "simple_table") {
    return <SimpleTableBlock block={block} ops={ops} depth={depth} />;
  }
  return (
    <TextBlock
      runtime={textBlockRuntime}
      block={block}
      ops={ops}
      depth={depth}
      pagePlaceholder={pagePlaceholder}
      pagePlaceholderText={pagePlaceholderText}
      onPagePlaceholderInput={onPagePlaceholderInput}
    />
  );
});

function BlockFrame({
  block,
  ops,
  depth,
  children,
  renderChildren = true,
  allowInsideDrop = true,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
  children: React.ReactNode;
  renderChildren?: boolean;
  allowInsideDrop?: boolean;
}) {
  const router = useRouter();
  const rowRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<DropPlacement | null>(null);
  const [fileDropPlacement, setFileDropPlacement] = useState<FileDropPlacement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<BlockMenuAnchor | null>(null);
  const childBlocks = useStore(
    useShallow((s) => s.childBlocks(block.pageId, block.id))
  );
  const commentCount = useStore(
    (s) =>
      (s.commentsByPage[block.pageId] ?? []).filter(
        (comment) => comment.blockId === block.id && !comment.parentId && !comment.resolved
      ).length
  );
  const openComments = useStore((s) => s.openComments);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const updateBlock = useStore((s) => s.updateBlock);
  const notify = useStore((s) => s.notify);
  const undoBlockChange = useStore((s) => s.undoBlockChange);
  const collapsed = TOGGLE_BLOCKS.has(block.type) && !!block.content?.collapsed;
  const color = block.content?.color === "default_background" ? undefined : block.content?.color;
  const selected = !ops.readOnly && ops.selectedBlockIds.has(block.id);
  const remoteAwareness = ops.remoteAwarenessByBlock[block.id] ?? [];
  const primaryRemoteAwareness = remoteAwareness[0];
  const remoteAwarenessLabel = primaryRemoteAwareness
    ? remoteAwarenessText(primaryRemoteAwareness, remoteAwareness.length)
    : "";
  const remoteAwarenessAvatar = primaryRemoteAwareness
    ? remoteAwarenessInitials(primaryRemoteAwareness.label)
    : "";
  // The anchor block owns keyboard handling for the whole multi-selection.
  const isSelectionAnchor = !ops.readOnly && ops.selectedBlockId === block.id;

  useEffect(() => {
    // Only the anchor row takes DOM focus so keyboard events have one owner;
    // other selected rows are highlighted but not focused.
    if (!isSelectionAnchor) return;
    const row = rowRef.current;
    if (!row) return;
    row.focus({ preventScroll: true });
    const rect = row.getBoundingClientRect();
    const viewportTop = 8;
    const viewportBottom = window.innerHeight - 8;
    const viewportHeight = viewportBottom - viewportTop;
    const topVisible = rect.top >= viewportTop && rect.top <= viewportBottom;
    const bottomVisible = rect.bottom >= viewportTop && rect.bottom <= viewportBottom;
    const fullyVisible = rect.top >= viewportTop && rect.bottom <= viewportBottom;

    if (fullyVisible || (rect.height >= viewportHeight && (topVisible || bottomVisible))) {
      return;
    }
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isSelectionAnchor]);

  const openBlockMenu = useCallback((anchor: BlockMenuAnchor | null = null) => {
    setMenuAnchor(anchor);
    setMenuOpen(true);
  }, []);

  const closeBlockMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuAnchor(null);
  }, []);

  const blockFrameActions = useMemo<BlockFrameActions>(
    () => ({
      openBlockMenu,
      closeBlockMenu,
    }),
    [closeBlockMenu, openBlockMenu]
  );

  const openLinkedPage = useCallback(() => {
    const pageId = linkedPageIdForBlock(block);
    if (!pageId) return false;
    setSidebarOpen(false);
    router.push(pageHref(pageId));
    return true;
  }, [block, router, setSidebarOpen]);

  useEffect(() => {
    if (ops.readOnly || ops.blockActionMenuFor !== block.id) return;
    const rect = rowRef.current?.getBoundingClientRect();
    openBlockMenu(
      rect
        ? { x: rect.left + 24, y: rect.top + 4, bottom: rect.bottom + 4 }
        : null
    );
    ops.openBlockActionMenu(null);
  }, [block.id, openBlockMenu, ops]);

  function placementFromEvent(e: React.DragEvent<HTMLDivElement>): DropPlacement {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (!allowInsideDrop) return y < rect.height * 0.5 ? "before" : "after";
    if (y < rect.height * 0.28) return "before";
    if (y > rect.height * 0.72) return "after";
    return "inside";
  }

  function filePlacementFromEvent(e: React.DragEvent<HTMLDivElement>): FileDropPlacement {
    const canReplace =
      childBlocks.length === 0 &&
      ((block.type === "paragraph" &&
        !(block.plainText?.trim() || spansToPlainText(block.content?.rich).trim())) ||
        ((block.type === "image" ||
          block.type === "video" ||
          block.type === "audio" ||
          block.type === "file") &&
          !block.content?.url));
    if (canReplace) return "replace";
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height * 0.5 ? "before" : "after";
  }

  function draggedRootCount(draggedId: string) {
    return ops.selectedBlockIds.has(draggedId) ? ops.selectedBlockIds.size : 1;
  }

  function notifyDroppedBlocks(copy: boolean, count: number) {
    const labels = blockItemLabels();
    notify(copy ? labels.copiedBlocks(count) : labels.movedBlocks(count), "success", {
      label: labels.undo,
      onClick: async () => {
        const restored = await undoBlockChange(block.pageId);
        notify(
          restored ? (copy ? labels.undidCopy : labels.undidMove) : labels.nothingToUndo,
          restored ? "success" : "default"
        );
      },
    });
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (ops.readOnly) return;
    if (dataTransferHasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setDrop(null);
      setFileDropPlacement(filePlacementFromEvent(e));
      return;
    }
    if (!Array.from(e.dataTransfer.types).includes(BLOCK_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    setDrop(placementFromEvent(e));
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (ops.readOnly) return;
    if (dataTransferHasFiles(e.dataTransfer)) {
      const files = droppedFiles(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setDrop(null);
      const placement = fileDropPlacement ?? filePlacementFromEvent(e);
      setFileDropPlacement(null);
      void ops.uploadDroppedFiles(files, block.id, placement);
      return;
    }
    const draggedId = e.dataTransfer.getData(BLOCK_DRAG_TYPE);
    if (!draggedId) return;
    e.preventDefault();
    const placement = drop ?? placementFromEvent(e);
    setDrop(null);
    if (e.altKey) {
      const copied = ops.copySelectedBlocksTo(draggedId, block.id, placement);
      if (copied.length > 0) notifyDroppedBlocks(true, copied.length);
      else notify(blockItemLabels().cantCopyBlockHere, "default");
      return;
    }
    const count = draggedRootCount(draggedId);
    const moved = ops.moveSelectedBlocksTo(draggedId, block.id, placement);
    if (moved) notifyDroppedBlocks(false, count);
    else notify(blockItemLabels().cantMoveBlockHere, "default");
  }

  function onSelectedKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (ops.readOnly) return;
    if (!isSelectionAnchor) return;
    const multi = ops.selectedBlockIds.size > 1;
    const notifyUndoableBlockChange = (
      message: string,
      restoredMessage: string,
      undoneMessage = restoredMessage
    ) => {
      const labels = blockItemLabels();
      notify(message, "success", {
        label: labels.undo,
        onClick: async () => {
          const restored = await undoBlockChange(block.pageId);
          notify(restored ? undoneMessage : labels.nothingToUndo, restored ? "success" : "default");
        },
      });
    };
    const quoteSelectedBlocks = () => {
      const st = useStore.getState();
      const lines = (st.blocksByPage[block.pageId] ?? [])
        .filter((target) => ops.selectedBlockIds.has(target.id))
        .sort((a, b) => a.position - b.position)
        .map(
          (target) =>
            spansToPlainText(target.content?.rich).trim() ||
            target.plainText?.trim() ||
            blockTypeLabel(target.type)
        )
        .filter(Boolean);
      const quote = lines.slice(0, 6).join("\n");
      const suffix = lines.length > 6 ? "\n..." : "";
      return quote
        ? `${quote}${suffix}`
        : blockItemText("selection.selectedBlocks", { count: ops.selectedBlockIds.size });
    };
    const setSelectedTogglesCollapsed = (collapsed: boolean) => {
      const st = useStore.getState();
      const targets = (st.blocksByPage[block.pageId] ?? []).filter(
        (target) =>
          ops.selectedBlockIds.has(target.id) &&
          TOGGLE_BLOCKS.has(target.type) &&
          !!target.content?.collapsed !== collapsed
      );
      if (targets.length === 0) return false;
      st.captureBlockHistory(block.pageId);
      for (const target of targets) {
        st.updateBlock(
          target.id,
          { content: { ...target.content, collapsed } },
          { history: false }
        );
      }
      return true;
    };
    // Shift+Arrow extends a contiguous multi-block selection.
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        ops.extendSelection(block.id, "up");
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        ops.extendSelection(block.id, "down");
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        ops.extendSelectionToEdge(block.id, "first");
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        ops.extendSelectionToEdge(block.id, "last");
        return;
      }
    }
    if (!(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
      if (e.key === "ArrowLeft" && setSelectedTogglesCollapsed(true)) {
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowRight" && setSelectedTogglesCollapsed(false)) {
        e.preventDefault();
        return;
      }
    }
    // With several blocks selected, Delete/Backspace removes them all and
    // Escape collapses the selection; other typing is ignored to avoid losing
    // multiple blocks to a single keystroke.
    if (multi) {
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        const count = ops.selectedBlockIds.size;
        ops.deleteSelectedBlocks();
        notifyUndoableBlockChange(
          blockItemLabels().deletedBlocks(count),
          blockItemLabels().restoredBlocks(count)
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        ops.selectBlock(null);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        ops.selectAdjacentBlock(block.id, e.key === "ArrowUp" ? "up" : "down");
        return;
      }
      // Copy/duplicate still work on the anchor; fall through for those.
    }
    const shortcutType = shortcutBlockType(e);
    if (shortcutType) {
      e.preventDefault();
      if (shortcutType === "child_page") {
        if (!multi) {
          ops.selectBlock(null);
          ops.createChildPage(block.id);
        }
        return;
      }
      ops.changeSelectedType(block.id, shortcutType);
      if (ops.selectedBlockIds.size <= 1) ops.selectBlock(block.id);
      return;
    }
    const textMark = shortcutTextMark(e);
    if (textMark) {
      e.preventDefault();
      ops.toggleSelectedTextMark(block.id, textMark);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "m") {
        e.preventDefault();
        openComments(block.pageId, block.id, {
          quote: multi ? quoteSelectedBlocks() : undefined,
        });
        return;
      }
      if (e.shiftKey && key === "p") {
        e.preventDefault();
        ops.openMoveDialog(block.id);
        return;
      }
      if (e.shiftKey && key === "h") {
        e.preventDefault();
        ops.setSelectedBlockColor(block.id, getLastEditorColor());
        return;
      }
      if (!e.shiftKey && key === "a") {
        e.preventDefault();
        ops.selectAllBlocks(block.id);
        return;
      }
      if (!e.shiftKey && (key === "/" || e.code === "Slash")) {
        e.preventDefault();
        const rect = rowRef.current?.getBoundingClientRect();
        openBlockMenu(
          rect
            ? { x: rect.left + 24, y: rect.top + 4, bottom: rect.bottom + 4 }
            : null
        );
        return;
      }
      if (e.shiftKey && key === "arrowup") {
        e.preventDefault();
        ops.moveSelectedBlocks(block.id, "up");
        return;
      }
      if (e.shiftKey && key === "arrowdown") {
        e.preventDefault();
        ops.moveSelectedBlocks(block.id, "down");
        return;
      }
      // Cmd/Ctrl+Enter toggles to_do checked / toggle collapsed, mirroring
      // focused-mode behavior so the shortcut is consistent in both modes.
      if (key === "enter") {
        if (openLinkedPage()) {
          e.preventDefault();
          return;
        }
        if (ops.toggleSelectedBlockState(block.id)) {
          e.preventDefault();
        }
        return;
      }
      if (key === "c") {
        e.preventDefault();
        void ops.copyBlock(block.id);
        return;
      }
      if (key === "x") {
        e.preventDefault();
        const count = ops.selectedBlockIds.has(block.id) ? ops.selectedBlockIds.size : 1;
        ops.selectBlock(null);
        void ops.cutBlock(block.id).then((cut) => {
          const labels = blockItemLabels();
          if (cut) {
            notifyUndoableBlockChange(labels.cutBlocks(count), labels.restoredBlocks(count));
          } else {
            notify(labels.couldntCut, "error");
          }
        });
        return;
      }
      if (key === "d") {
        e.preventDefault();
        void ops.duplicateSelectedBlocks(block.id).then((copies) => {
          const labels = blockItemLabels();
          if (copies.length > 0) {
            notifyUndoableBlockChange(
              labels.duplicatedBlocks(copies.length),
              labels.undidDuplicate,
              labels.undidDuplicate
            );
          }
        });
        return;
      }
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      ops.selectBlock(null);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const rect = rowRef.current?.getBoundingClientRect();
      openBlockMenu(
        rect
          ? { x: rect.left + 24, y: rect.top + 4, bottom: rect.bottom + 4 }
          : null
      );
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) ops.outdentSelectedBlocks(block.id);
      else ops.indentSelectedBlocks(block.id);
    } else if (e.key === " " && ops.toggleSelectedBlockState(block.id)) {
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (openLinkedPage()) return;
      ops.selectBlock(null);
      if (focusBlockWritingTarget(block, "end")) return;
      ops.insertAfter(block.id, "paragraph");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      ops.selectAdjacentBlock(block.id, "up");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      ops.selectAdjacentBlock(block.id, "down");
    } else if (e.key === "Home") {
      e.preventDefault();
      ops.selectEdgeBlock("first");
    } else if (e.key === "End") {
      e.preventDefault();
      ops.selectEdgeBlock("last");
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      ops.removeSelectedBlock(block.id);
    } else {
      // A multi-block selection behaves like selected text: typing a printable
      // key replaces the whole selected range with one fresh text block.
      if (isComposingKeyEvent(e)) return;
      const text = printableTextKey(e);
      if (!text) {
        if (e.key === " " && !multi && TEXT_BLOCKS.has(block.type)) {
          e.preventDefault();
          ops.selectBlock(null);
          requestAnimationFrame(() => focusEditableSettled(block.id, "end"));
        }
        return;
      }
      if (multi) {
        e.preventDefault();
        const inserted = ops.replaceSelectedBlocks(block.id, [
          {
            type: "paragraph",
            content: { rich: [{ text }] },
            plainText: text,
          },
        ]);
        if (inserted && TEXT_BLOCKS.has(inserted.type)) {
          requestAnimationFrame(() => {
            getEditable(inserted.id)?.dispatchEvent(new InputEvent("input", { bubbles: true }));
          });
        }
        return;
      }
      // Only printable keys typed over a TEXT block replace its content. Typing
      // over a selected non-text block (image, table, code, equation, columns...)
      // must NOT convert/destroy it, so ignore the key entirely.
      if (!TEXT_BLOCKS.has(block.type)) return;
      e.preventDefault();
      ops.selectBlock(null);
      requestAnimationFrame(() => {
        const editable = getEditable(block.id);
        if (!editable) {
          updateBlock(block.id, {
            content: { ...block.content, rich: [{ text }] },
            plainText: text,
          });
          requestAnimationFrame(() => focusEditableSettled(block.id, "end"));
          return;
        }

        editable.innerHTML = spansToHtml([{ text }]);
        editable.dataset.empty = "false";
        focusEditableSettled(block.id, "end");
        editable.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
    }
  }

  function onSelectedPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (ops.readOnly) return;
    if (!selected) return;
    const internalBlocks = parseInternalPastedBlocks(e.clipboardData);
    const html = e.clipboardData.getData("text/html");
    const htmlBlocks =
      internalBlocks.length === 0 && html ? parsePastedHtml(html) : [];
    const text = e.clipboardData.getData("text/plain");
    if (internalBlocks.length === 0 && htmlBlocks.length === 0 && !text.trim()) return;
    const pastedOnlyUrl =
      internalBlocks.length === 0 &&
      htmlBlocks.length === 0 &&
      !text.trim().includes("\n")
        ? normalizePastedLink(text)
        : "";
    if (pastedOnlyUrl) {
      e.preventDefault();
      const inserted = ops.replaceSelectedBlocks(block.id, [
        {
          type: "paragraph",
          content: { rich: [{ text: pastedOnlyUrl, link: pastedOnlyUrl }] },
          plainText: pastedOnlyUrl,
        },
      ]);
      if (inserted) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            window.dispatchEvent(
              new CustomEvent(PASTED_URL_MENU_REQUEST, {
                detail: { blockId: inserted.id, url: pastedOnlyUrl },
              })
            );
          });
        });
      }
      return;
    }
    const parsed =
      internalBlocks.length > 0
        ? internalBlocks
        : htmlBlocks.length > 0
          ? htmlBlocks
          : parsePastedMarkdown(text);
    if (parsed.length === 0) return;
    e.preventDefault();
    ops.replaceSelectedBlocks(block.id, parsed);
  }

  return (
    <div
      id={`block-${block.id}`}
      className={styles.blockGroup}
      data-block-id={block.id}
      data-page-id={block.pageId}
      data-depth={depth}
      data-block-type={block.type}
      role="group"
      aria-label={blockAriaLabel(block)}
    >
      <div
        ref={rowRef}
        className={styles.blockRow}
        data-template-block-row={ops.templateMode ? "true" : undefined}
        data-type={block.type}
        data-color={color && color !== "default" ? color : undefined}
        data-drop={drop ?? undefined}
        data-file-drop={fileDropPlacement ?? undefined}
        data-dragging={dragging ? "true" : undefined}
        data-remote-awareness={primaryRemoteAwareness ? primaryRemoteAwareness.mode : undefined}
        data-selected={selected ? "true" : undefined}
        style={
          primaryRemoteAwareness
            ? ({ "--remote-awareness-color": primaryRemoteAwareness.color } as CSSProperties)
            : undefined
        }
        role="group"
        tabIndex={isSelectionAnchor ? 0 : -1}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDrop(null);
          setFileDropPlacement(null);
        }}
        onDrop={onDrop}
        onKeyDown={onSelectedKeyDown}
        onPaste={onSelectedPaste}
        onContextMenu={(e) => {
          if (ops.readOnly) return;
          const target = e.target as HTMLElement;
          if (target.closest("button, input, select, textarea, a")) return;
          e.preventDefault();
          e.stopPropagation();
          if (!ops.selectedBlockIds.has(block.id)) {
            ops.selectBlock(block.id);
          }
          openBlockMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {!ops.readOnly && (
          <BlockHandle
            block={block}
            ops={ops}
            dragType={BLOCK_DRAG_TYPE}
            onDragState={setDragging}
            menuOpen={menuOpen}
            menuAnchor={menuAnchor}
            onMenuOpen={openBlockMenu}
            onMenuClose={closeBlockMenu}
          />
        )}
        <div className={styles.blockBody}>
          <BlockFrameActionsContext.Provider value={blockFrameActions}>
            {children}
          </BlockFrameActionsContext.Provider>
        </div>
        {commentCount > 0 && (
          <button
            type="button"
            className={styles.blockCommentPill}
            onClick={() => openComments(block.pageId, block.id)}
            contentEditable={false}
            title={blockItemText("comments.count", { count: commentCount })}
            aria-label={blockItemText("comments.unresolvedOnBlock", {
              count: commentCount,
              type: blockTypeLabel(block.type),
            })}
          >
            {commentCount}
          </button>
        )}
        {primaryRemoteAwareness && (
          <span
            className={styles.remoteAwareness}
            contentEditable={false}
            title={remoteAwarenessLabel}
            aria-label={remoteAwarenessLabel}
          >
            <span className={styles.remoteAwarenessLine} aria-hidden="true" />
            <span className={styles.remoteAwarenessBadge} data-remote-awareness-avatar>
              {remoteAwarenessAvatar}
            </span>
          </span>
        )}
      </div>
      {renderChildren && !collapsed && childBlocks.length > 0 && (
        <div className={styles.children}>
          {childBlocks.map((child) => (
            <BlockItem key={child.id} block={child} ops={ops} depth={depth + 1} />
          ))}
        </div>
      )}
      {renderChildren &&
        !collapsed &&
        childBlocks.length === 0 &&
        TOGGLE_BLOCKS.has(block.type) && (
          <div className={styles.children}>
            <button
              type="button"
              className={styles.toggleEmptyChild}
              contentEditable={false}
              aria-label={blockItemText("toggle.addInsideEmpty")}
              title={blockItemText("toggle.addInside")}
              onClick={() => ops.insertChildBlock(block.id)}
            >
              {blockItemLabels().emptyTogglePrompt}
            </button>
          </div>
        )}
    </div>
  );
}

function TabBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const tabs = useStore(
    useShallow((s) =>
      s
        .childBlocks(block.pageId, block.id)
        .filter((child) => child.type === "paragraph")
    )
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const updateBlock = useStore((s) => s.updateBlock);
  const addBlockLocal = useStore((s) => s.addBlockLocal);
  const deleteBlock = useStore((s) => s.deleteBlock);
  const captureBlockHistory = useStore((s) => s.captureBlockHistory);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const panelId = activeTab ? tabPanelId(block.id, activeTab.id) : undefined;

  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTabId) setActiveTabId(null);
      return;
    }
    if (!activeTab || activeTab.id !== activeTabId) setActiveTabId(activeTab.id);
  }, [activeTab, activeTabId, tabs]);

  function activateTab(index: number, focus = false) {
    const next = tabs[index];
    if (!next) return;
    setEditingTabId(null);
    setActiveTabId(next.id);
    if (focus) {
      requestAnimationFrame(() => {
        document.getElementById(tabButtonId(block.id, next.id))?.focus();
      });
    }
  }

  function onTabKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (tabs.length === 0) return;
    if (
      (e.altKey || e.metaKey) &&
      (e.key === "ArrowLeft" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowDown")
    ) {
      e.preventDefault();
      e.stopPropagation();
      moveTab(index, e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      nextIndex = (index + 1) % tabs.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex == null) return;
    e.preventDefault();
    e.stopPropagation();
    activateTab(nextIndex, true);
  }

  function moveTab(index: number, direction: -1 | 1) {
    if (ops.readOnly) return;
    const tab = tabs[index];
    if (!tab) return;
    let position: number | null = null;
    if (direction < 0) {
      const previous = tabs[index - 1];
      if (!previous) return;
      const beforePrevious = tabs[index - 2];
      position = positionBetween(beforePrevious?.position, previous.position);
    } else {
      const next = tabs[index + 1];
      if (!next) return;
      const afterNext = tabs[index + 2];
      position = positionBetween(next.position, afterNext?.position);
    }
    updateBlock(tab.id, { position });
    setEditingTabId(null);
    setActiveTabId(tab.id);
    requestAnimationFrame(() => {
      document.getElementById(tabButtonId(block.id, tab.id))?.focus();
    });
  }

  function tabLabel(tab: Block) {
    return (
      spansToPlainText(tab.content?.rich).trim() ||
      tab.plainText?.trim() ||
      blockItemText("common.untitled")
    );
  }

  function addTab() {
    if (ops.readOnly) return;
    const lastTab = tabs[tabs.length - 1];
    const label = blockItemText("tabs.newNamed", { number: tabs.length + 1 });
    captureBlockHistory(block.pageId);
    const tab = addBlockLocal({
      pageId: block.pageId,
      parentId: block.id,
      type: "paragraph",
      content: { rich: [{ text: label }] },
      position: positionBetween(lastTab?.position, undefined),
      history: false,
      persist: false,
    });
    const body = addBlockLocal({
      pageId: block.pageId,
      parentId: tab.id,
      type: "paragraph",
      content: { rich: [] },
      position: 1,
      history: false,
      persist: false,
    });
    void useStore.getState().persistBlockCreateBatch([tab, body]);
    setActiveTabId(tab.id);
    requestAnimationFrame(() => {
      document.getElementById(tabButtonId(block.id, tab.id))?.focus();
      focusEditableSettled(body.id, "start");
    });
  }

  function beginRename(tab: Block) {
    if (ops.readOnly) return;
    setActiveTabId(tab.id);
    setEditingTabId(tab.id);
    setEditingLabel(tabLabel(tab));
  }

  function commitRename(tab: Block) {
    if (ops.readOnly) return;
    const label = editingLabel.trim() || blockItemText("common.untitled");
    updateBlock(tab.id, {
      content: { ...tab.content, rich: [{ text: label }] },
      plainText: label,
    });
    setEditingTabId(null);
    requestAnimationFrame(() => {
      document.getElementById(tabButtonId(block.id, tab.id))?.focus();
    });
  }

  function cancelRename() {
    setEditingTabId(null);
  }

  function removeTab(tab: Block, index: number) {
    if (ops.readOnly || tabs.length <= 1) return;
    const next = tabs[index - 1] ?? tabs[index + 1] ?? null;
    setEditingTabId(null);
    setActiveTabId(next?.id ?? null);
    void deleteBlock(tab.id).then(() => {
      if (!next) return;
      requestAnimationFrame(() => {
        document.getElementById(tabButtonId(block.id, next.id))?.focus();
      });
    });
  }

  return (
    <BlockFrame block={block} ops={ops} depth={depth} renderChildren={false}>
      <div className={styles.tabBlock}>
        {tabs.length > 0 ? (
          <>
            <div className={styles.tabList} role="tablist" aria-label={blockItemText("tabs.label")}>
              {tabs.map((tab, index) => {
                const label = tabLabel(tab);
                const icon = typeof tab.content?.icon === "string" ? tab.content.icon : "";
                const active = tab.id === activeTab?.id;
                const editing = tab.id === editingTabId;
                return (
                  <span key={tab.id} className={styles.tabButtonWrap}>
                    {editing ? (
                      <input
                        className={styles.tabLabelInput}
                        aria-label={blockItemText("tabs.rename", { label })}
                          value={editingLabel}
                          autoFocus
                          onChange={(e) => setEditingLabel(e.target.value)}
                          onBlur={() => commitRename(tab)}
                          onKeyDown={(e) => {
                            if (isComposingKeyEvent(e)) return;
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename(tab);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                          }
                        }}
                      />
                    ) : (
                      <button
                        id={tabButtonId(block.id, tab.id)}
                        type="button"
                        className={styles.tabButton}
                        data-active={active ? "true" : undefined}
                        role="tab"
                        aria-selected={active}
                        aria-controls={active ? panelId : undefined}
                        tabIndex={active ? 0 : -1}
                        onClick={() => {
                          setEditingTabId(null);
                          setActiveTabId(tab.id);
                        }}
                        onDoubleClick={() => beginRename(tab)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && active) {
                            e.preventDefault();
                            e.stopPropagation();
                            beginRename(tab);
                            return;
                          }
                          onTabKeyDown(e, index);
                        }}
                      >
                        {icon && <span className={styles.tabIcon}>{icon}</span>}
                        <span>{label}</span>
                      </button>
                    )}
                    {!ops.readOnly && tabs.length > 1 && !editing && (
                      <button
                        type="button"
                        className={styles.tabDeleteButton}
                        aria-label={blockItemText("tabs.deleteNamed", { label })}
                        title={blockItemText("tabs.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTab(tab, index);
                        }}
                      >
                        <Trash size={12} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                );
              })}
              {!ops.readOnly && (
                <button
                  type="button"
                  className={styles.tabAddButton}
                  aria-label={blockItemText("tabs.add")}
                  title={blockItemText("tabs.add")}
                  onClick={addTab}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            {activeTab && (
              <TabPanelBlocks
                tab={activeTab}
                ops={ops}
                depth={depth + 1}
                panelId={panelId}
                labelledBy={tabButtonId(block.id, activeTab.id)}
              />
            )}
          </>
        ) : (
          <button
            type="button"
            className={styles.toggleEmptyChild}
            contentEditable={false}
            aria-label={blockItemText("tabs.add")}
            title={blockItemText("tabs.add")}
            onClick={() => ops.insertChildBlock(block.id, "paragraph")}
          >
            {blockItemText("tabs.emptyGroup")}
          </button>
        )}
      </div>
    </BlockFrame>
  );
}

function TabPanelBlocks({
  tab,
  ops,
  depth,
  panelId,
  labelledBy,
}: {
  tab: Block;
  ops: EditorOps;
  depth: number;
  panelId?: string;
  labelledBy?: string;
}) {
  const childBlocks = useStore(
    useShallow((s) => s.childBlocks(tab.pageId, tab.id))
  );

  return (
    <div
      id={panelId}
      className={styles.tabPanel}
      role="tabpanel"
      aria-labelledby={labelledBy}
    >
      {childBlocks.length > 0 ? (
        childBlocks.map((child) => (
          <BlockItem key={child.id} block={child} ops={ops} depth={depth} />
        ))
      ) : (
        <button
          type="button"
          className={styles.toggleEmptyChild}
          contentEditable={false}
          aria-label={blockItemText("tabs.addBlockInsideEmpty")}
          title={blockItemText("tabs.addBlockInside")}
          onClick={() => ops.insertChildBlock(tab.id)}
        >
          {blockItemText("tabs.empty")}
        </button>
      )}
    </div>
  );
}

function tabButtonId(blockId: string, tabId: string) {
  return `tab-${blockId}-${tabId}`;
}

function tabPanelId(blockId: string, tabId: string) {
  return `tabpanel-${blockId}-${tabId}`;
}

function ColumnListBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const columns = useStore(
    useShallow((s) =>
      s
        .childBlocks(block.pageId, block.id)
        .filter((child) => child.type === "column")
    )
  );

  return (
    <BlockFrame
      block={block}
      ops={ops}
      depth={depth}
      renderChildren={false}
      allowInsideDrop={false}
    >
      <div className={styles.columnList}>
        {columns.map((column, index) => (
          <ColumnSlot
            key={column.id}
            column={column}
            columns={columns}
            columnIndex={index}
            ops={ops}
            depth={depth + 1}
            previousColumn={columns[index - 1]}
            canResize={index > 0}
            canManage={!ops.readOnly}
          />
        ))}
      </div>
    </BlockFrame>
  );
}

function ColumnBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  return (
    <BlockFrame block={block} ops={ops} depth={depth} renderChildren={false}>
      <ColumnSlot column={block} ops={ops} depth={depth + 1} />
    </BlockFrame>
  );
}

function ColumnSlot({
  column,
  columns,
  columnIndex,
  ops,
  depth,
  previousColumn,
  canResize = false,
  canManage = false,
}: {
  column: Block;
  columns?: Block[];
  columnIndex?: number;
  ops: EditorOps;
  depth: number;
  previousColumn?: Block;
  canResize?: boolean;
  canManage?: boolean;
}) {
  const [drop, setDrop] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [columnControlsHot, setColumnControlsHot] = useState(false);
  const updateBlock = useStore((s) => s.updateBlock);
  const addBlockLocal = useStore((s) => s.addBlockLocal);
  const deleteBlock = useStore((s) => s.deleteBlock);
  const captureBlockHistory = useStore((s) => s.captureBlockHistory);
  const notify = useStore((s) => s.notify);
  const undoBlockChange = useStore((s) => s.undoBlockChange);
  const childBlocks = useStore(
    useShallow((s) => s.childBlocks(column.pageId, column.id))
  );
  const columnNumber = typeof columnIndex === "number" ? columnIndex + 1 : 1;
  const managedColumns = columns ?? [];
  const width =
    typeof column.content?.width === "number" && column.content.width > 0
      ? column.content.width
      : 1;

  function updateColumnControlsHotspot(e: ReactMouseEvent<HTMLDivElement>) {
    if (!canManage) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const inHotspot =
      e.clientX >= rect.right - 96 &&
      e.clientY >= rect.top - 28 &&
      e.clientY <= rect.top + 34;
    setColumnControlsHot((current) => (current === inHotspot ? current : inHotspot));
  }

  function clearColumnControlsHotspot() {
    setColumnControlsHot(false);
  }

  function startResize(e: React.PointerEvent<HTMLButtonElement>) {
    if (!previousColumn) return;
    const previous = previousColumn;
    e.preventDefault();
    e.stopPropagation();
    const previousWidth =
      typeof previous.content?.width === "number" && previous.content.width > 0
        ? previous.content.width
        : 1;
    const currentWidth = width;
    const totalWidth = previousWidth + currentWidth;
    const startX = e.clientX;
    const pairWidth =
      e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 1;
    setResizing(true);

    function onPointerMove(ev: PointerEvent) {
      const deltaRatio = ((ev.clientX - startX) / Math.max(pairWidth, 1)) * 1.85;
      const minWidth = Math.min(0.75, totalWidth / 5);
      const nextPrevious = Math.max(
        minWidth,
        Math.min(totalWidth - minWidth, previousWidth + deltaRatio)
      );
      const nextCurrent = totalWidth - nextPrevious;
      updateBlock(
        previous.id,
        { content: { ...previous.content, width: nextPrevious } },
        { debounce: true, history: false }
      );
      updateBlock(
        column.id,
        { content: { ...column.content, width: nextCurrent } },
        { debounce: true, history: false }
      );
    }

    function onPointerUp() {
      setResizing(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function addColumnAfter() {
    if (!canManage || ops.readOnly || typeof columnIndex !== "number" || !column.parentId) return;
    const nextColumn = managedColumns[columnIndex + 1];
    const splitWidth = Math.max(width / 2, 0.2);

    captureBlockHistory(column.pageId);
    updateBlock(
      column.id,
      { content: { ...column.content, width: splitWidth } },
      { history: false }
    );
    const newColumn = addBlockLocal({
      pageId: column.pageId,
      parentId: column.parentId,
      type: "column",
      content: { width: splitWidth },
      position: positionBetween(column.position, nextColumn?.position),
      history: false,
      persist: false,
    });
    const firstParagraph = addBlockLocal({
      pageId: column.pageId,
      parentId: newColumn.id,
      type: "paragraph",
      content: { rich: [] },
      position: 1,
      history: false,
      persist: false,
    });
    void useStore.getState().persistBlockCreateBatch([newColumn, firstParagraph]);
    requestAnimationFrame(() => focusEditableSettled(firstParagraph.id, "start"));
  }

  function moveColumn(direction: -1 | 1) {
    if (!canManage || ops.readOnly || typeof columnIndex !== "number") return;
    let position: number | null = null;
    if (direction < 0) {
      const previous = managedColumns[columnIndex - 1];
      if (!previous) return;
      const beforePrevious = managedColumns[columnIndex - 2];
      position = positionBetween(beforePrevious?.position, previous.position);
    } else {
      const next = managedColumns[columnIndex + 1];
      if (!next) return;
      const afterNext = managedColumns[columnIndex + 2];
      position = positionBetween(next.position, afterNext?.position);
    }
    updateBlock(column.id, { position });
  }

  function removeColumn() {
    if (!canManage || ops.readOnly || typeof columnIndex !== "number" || managedColumns.length <= 2) return;
    const widthTarget = managedColumns[columnIndex - 1] ?? managedColumns[columnIndex + 1];

    captureBlockHistory(column.pageId);
    if (widthTarget) {
      const targetWidth =
        typeof widthTarget.content?.width === "number" && widthTarget.content.width > 0
          ? widthTarget.content.width
          : 1;
      updateBlock(
        widthTarget.id,
        { content: { ...widthTarget.content, width: targetWidth + width } },
        { history: false }
      );
    }
    void deleteBlock(column.id, { history: false });
  }

  function onColumnKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (!(e.altKey || e.metaKey)) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      moveColumn(-1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      moveColumn(1);
    }
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes(BLOCK_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    setDrop(true);
  }

  function draggedRootCount(draggedId: string) {
    return ops.selectedBlockIds.has(draggedId) ? ops.selectedBlockIds.size : 1;
  }

  function notifyDroppedBlocks(copy: boolean, count: number) {
    const labels = blockItemLabels();
    notify(copy ? labels.copiedBlocks(count) : labels.movedBlocks(count), "success", {
      label: labels.undo,
      onClick: async () => {
        const restored = await undoBlockChange(column.pageId);
        notify(
          restored ? (copy ? labels.undidCopy : labels.undidMove) : labels.nothingToUndo,
          restored ? "success" : "default"
        );
      },
    });
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    const draggedId = e.dataTransfer.getData(BLOCK_DRAG_TYPE);
    if (!draggedId) return;
    e.preventDefault();
    setDrop(false);
    if (e.altKey) {
      const copied = ops.copySelectedBlocksTo(draggedId, column.id, "inside");
      if (copied.length > 0) notifyDroppedBlocks(true, copied.length);
      else notify(blockItemLabels().cantCopyBlockHere, "default");
      return;
    }
    const count = draggedRootCount(draggedId);
    const moved = ops.moveSelectedBlocksTo(draggedId, column.id, "inside");
    if (moved) notifyDroppedBlocks(false, count);
    else notify(blockItemLabels().cantMoveBlockHere, "default");
  }

  return (
    <div
      className={styles.column}
      style={{ flexGrow: width, flexBasis: 0 }}
      data-drop={drop ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      data-column-controls-active={columnControlsHot || resizing ? "true" : undefined}
      data-column-id={column.id}
      role="group"
      aria-label={blockItemText("columns.numbered", { number: columnNumber })}
      tabIndex={canManage ? 0 : undefined}
      onMouseMove={canManage ? updateColumnControlsHotspot : undefined}
      onMouseLeave={canManage ? clearColumnControlsHotspot : undefined}
      onDragOver={onDragOver}
      onDragLeave={() => setDrop(false)}
      onDrop={onDrop}
      onKeyDown={onColumnKeyDown}
    >
      {canResize && (
        <button
          type="button"
          className={styles.columnResize}
          aria-label={blockItemText("columns.resize")}
          title={blockItemText("columns.resize")}
          contentEditable={false}
          onPointerDown={startResize}
        />
      )}
      {canManage && typeof columnIndex === "number" && (
        <div className={styles.columnControls} contentEditable={false}>
          <button
            type="button"
            aria-label={blockItemText("columns.addAfter", { number: columnNumber })}
            title={blockItemText("columns.add")}
            onClick={addColumnAfter}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={blockItemText("columns.moveLeftNumbered", { number: columnNumber })}
            title={blockItemText("columns.moveLeft")}
            disabled={columnIndex <= 0}
            onClick={() => moveColumn(-1)}
          >
            <ChevronLeft size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={blockItemText("columns.moveRightNumbered", { number: columnNumber })}
            title={blockItemText("columns.moveRight")}
            disabled={columnIndex >= managedColumns.length - 1}
            onClick={() => moveColumn(1)}
          >
            <ChevronRight size={12} aria-hidden="true" />
          </button>
          {managedColumns.length > 2 && (
            <button
              type="button"
              aria-label={blockItemText("columns.deleteNumbered", { number: columnNumber })}
              title={blockItemText("columns.delete")}
              onClick={removeColumn}
            >
              <Trash size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {childBlocks.length > 0 ? (
        childBlocks.map((child) => (
          <BlockItem key={child.id} block={child} ops={ops} depth={depth} />
        ))
      ) : (
        <div className={styles.columnEmpty} />
      )}
    </div>
  );
}

function displayUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin && url.startsWith("/")) {
      return blockItemText("pageLink.label");
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A secondary line for a bookmark card: the path/query (not the hostname). */
function bookmarkSecondary(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    const tail = `${parsed.pathname}${parsed.search}`.replace(/^\/$/, "");
    return tail || url;
  } catch {
    return url;
  }
}

function fileNameFromUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return name || displayUrl(url);
  } catch {
    return url.split("/").filter(Boolean).at(-1) || blockItemText("common.untitled");
  }
}

function mentionTriggerFromText(beforeText: string): {
  trigger: MentionTrigger;
  query: string;
  length: number;
} | null {
  const pageLink = beforeText.match(PAGE_LINK_RE);
  if (pageLink) {
    const query = pageLink[1] ?? "";
    return { trigger: "page_link", query, length: 2 + query.length };
  }
  const mention = beforeText.match(MENTION_RE);
  if (!mention) return null;
  const query = mention[1] ?? "";
  return { trigger: "mention", query, length: 1 + query.length };
}

function textOffsetIn(root: HTMLElement, node: Node, offset: number) {
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function textNodeAtOffset(root: Node, offset: number): { node: Node; offset: number } | null {
  let remaining = offset;
  let lastText: Text | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    lastText = node;
    node = walker.nextNode() as Text | null;
  }
  if (lastText) return { node: lastText, offset: lastText.textContent?.length ?? 0 };
  return null;
}

function selectTextRange(root: HTMLElement, start: number, end: number) {
  const from = textNodeAtOffset(root, start);
  const to = textNodeAtOffset(root, end);
  const selection = window.getSelection();
  if (!from || !to || !selection) {
    placeCaret(root, end);
    return;
  }
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

interface RemoteTextRect {
  color: string;
  height: number;
  initials: string;
  key: string;
  label: string;
  left: number;
  mode: "cursor" | "selection";
  top: number;
  width: number;
}

function textRangeForEditable(el: HTMLElement): PageAwarenessTextRange {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const offset = caretOffset(el);
    return { start: offset, end: offset };
  }
  const range = selection.getRangeAt(0);
  const containsStart = el.contains(range.startContainer);
  const containsEnd = el.contains(range.endContainer);
  if (!containsStart || !containsEnd) {
    const offset = caretOffset(el);
    return { start: offset, end: offset };
  }
  const start = textOffsetIn(el, range.startContainer, range.startOffset);
  const end = textOffsetIn(el, range.endContainer, range.endOffset);
  if (start === null || end === null) {
    const offset = caretOffset(el);
    return { start: offset, end: offset };
  }
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function rangeForTextOffsets(root: HTMLElement, start: number, end: number) {
  const from = textNodeAtOffset(root, start);
  const to = textNodeAtOffset(root, end);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function lineHeightFor(el: HTMLElement) {
  const lineHeight = window.getComputedStyle(el).lineHeight;
  const parsed = Number.parseFloat(lineHeight);
  return Number.isFinite(parsed) ? parsed : 20;
}

function remoteTextRects(root: HTMLElement, awareness: PagePresenceAwareness[]): RemoteTextRect[] {
  const textLength = root.textContent?.length ?? 0;
  const rootRect = root.getBoundingClientRect();
  const rects: RemoteTextRect[] = [];

  for (const item of awareness) {
    if (!item.textRange) continue;
    const start = Math.min(Math.max(0, item.textRange.start), textLength);
    const end = Math.min(Math.max(0, item.textRange.end), textLength);
    const range = rangeForTextOffsets(root, start, end);
    if (!range) continue;

    if (start === end) {
      const rect = range.getBoundingClientRect();
      const height = rect.height || lineHeightFor(root);
      const top = rect.height ? rect.top : rootRect.top + 2;
      const left = rect.left || (start === 0 ? rootRect.left : rootRect.right);
      rects.push({
        color: item.color,
        height,
        initials: remoteAwarenessInitials(item.label),
        key: `${item.userId}:cursor:${start}`,
        label: item.label,
        left,
        mode: "cursor",
        top,
        width: 2,
      });
      continue;
    }

    const selectionRects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    for (const [index, rect] of selectionRects.entries()) {
        rects.push({
          color: item.color,
          height: rect.height,
          initials: remoteAwarenessInitials(item.label),
          key: `${item.userId}:selection:${start}:${end}:${index}`,
          label: item.label,
          left: rect.left,
        mode: "selection",
        top: rect.top,
        width: rect.width,
      });
    }
  }

  return rects;
}

function RemoteTextAwarenessOverlay({
  awareness,
  editableRef,
  revision,
}: {
  awareness: PagePresenceAwareness[];
  editableRef: RefObject<HTMLElement | null>;
  revision: string;
}) {
  const [rects, setRects] = useState<RemoteTextRect[]>([]);

  useEffect(() => {
    if (!awareness.some((item) => item.textRange)) {
      setRects([]);
      return;
    }

    let frame = 0;
    let resizeObserver: ResizeObserver | undefined;

    function update() {
      const root = editableRef.current;
      setRects(root ? remoteTextRects(root, awareness) : []);
    }

    function schedule() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    }

    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const root = editableRef.current;
    if (root && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(root);
    }

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      resizeObserver?.disconnect();
    };
  }, [awareness, editableRef, revision]);

  if (rects.length === 0) return null;

  return (
    <>
      {rects.map((rect) => (
        <span
          key={rect.key}
          className={rect.mode === "cursor" ? styles.remoteTextCursor : styles.remoteTextSelection}
          style={
            {
              "--remote-text-color": rect.color,
              height: rect.height,
              left: rect.left,
              top: rect.top,
              width: rect.width,
            } as CSSProperties
          }
          aria-hidden="true"
          title={rect.label}
        >
          {rect.mode === "cursor" && (
            <span className={styles.remoteTextCursorBadge} data-remote-awareness-avatar>
              {rect.initials}
            </span>
          )}
        </span>
      ))}
    </>
  );
}

function clearColorAttributes(root: ParentNode) {
  if (root instanceof HTMLElement) delete root.dataset.color;
  root.querySelectorAll("[data-color]").forEach((el) => {
    delete (el as HTMLElement).dataset.color;
  });
}

function EquationBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const updateBlock = useStore((s) => s.updateBlock);
  const expression = block.content?.expression ?? "";
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const autoSize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Keep the textarea sized to its content (multi-line LaTeX stays visible).
  useEffect(autoSize, [autoSize, expression, focused]);

  function setExpression(next: string) {
    updateBlock(
      block.id,
      {
        content: { ...block.content, expression: next },
        plainText: next,
      },
      { debounce: true, history: "merge" }
    );
    autoSize();
  }

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      <div className={styles.equationBlock} contentEditable={false} data-editing={focused ? "true" : undefined}>
        <Suspense
          fallback={
            <div className={styles.equationPreview}>
              {expression.trim() || "E = mc^2"}
            </div>
          }
        >
          <EquationPreview className={styles.equationPreview} expression={expression} />
        </Suspense>
        <textarea
          ref={inputRef}
          className={styles.equationInput}
          data-equation-input={block.id}
          value={expression}
          rows={1}
          placeholder="E = mc^2"
          aria-label={blockItemText("equation.label")}
          spellCheck={false}
          readOnly={ops.readOnly}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={ops.readOnly ? undefined : (e) => setExpression(e.target.value)}
        />
      </div>
    </BlockFrame>
  );
}

function SimpleTableBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      <SimpleTableContent block={block} ops={ops} />
    </BlockFrame>
  );
}

function ImageBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const updateBlock = useStore((s) => s.updateBlock);
  const captionRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewRestoreFocusRef = useRef<HTMLElement | null>(null);
  const imageResize = useRef<{
    startX: number;
    startWidth: number;
    containerWidth: number;
    side: "left" | "right";
  } | null>(null);
  const [draft, setDraft] = useState(block.content?.url ?? "");
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<BlockUploadProgress | null>(null);
  const [imageResizing, setImageResizing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const url = useWorkspaceFileUrl(block.content?.url, ["data:image/"]);
  const imageWidth =
    typeof block.content?.width === "number" ? clampImageWidth(block.content.width) : undefined;
  const imageAlign = block.content?.align ?? "left";
  const selectedForPreview =
    !ops.readOnly && ops.selectedBlockIds.size === 1 && ops.selectedBlockIds.has(block.id);
  const captionText = blockCaptionText(block);
  const showCaption = blockCaptionVisible(block);

  useEffect(() => {
    if (!url || !selectedForPreview) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== " ") return;
      e.preventDefault();
      setPreviewOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedForPreview, url]);

  useEffect(() => {
    if (!previewOpen) return;
    previewRestoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreIsolation = isolateBodyForModal([previewRef.current]);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => previewCloseRef.current?.focus());
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setPreviewOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreIsolation();
      const restore = previewRestoreFocusRef.current;
      previewRestoreFocusRef.current = null;
      if (restore?.isConnected) window.requestAnimationFrame(() => restore.focus());
    };
  }, [previewOpen]);

  useEffect(() => {
    const el = captionRef.current;
    if (!el) return;
    const html = spansToHtml(block.content?.caption);
    if (!editableHtmlMatches(el, html)) el.innerHTML = html;
    el.dataset.empty = String(spansToPlainText(block.content?.caption).length === 0);
  }, [block.id, block.content?.caption]);

  function commitImage(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = safeUrl(draft);
    if (!normalized || normalized.startsWith("#") || /^mailto:/i.test(normalized)) {
      setError(blockItemText("image.invalidLink"));
      return;
    }
    setError("");
    updateBlock(block.id, {
      content: { ...block.content, url: normalized },
      plainText: spansToPlainText(block.content?.caption),
    });
    ops.insertAfter(block.id, "paragraph");
  }

  async function pickImageFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(blockItemText("image.chooseFile"));
      return;
    }
    let uploadedUrl = "";
    try {
      setError("");
      const fallbackName = blockItemText("image.label");
      setUploadProgress({ phase: "preparing", percent: 0, fileName: file.name || fallbackName });
      uploadedUrl = (await uploadWorkspaceFile(file, "blocks/images", {
        pageId: block.pageId,
        blockId: block.id,
      }, {
        onProgress: (progress) => setUploadProgress({ ...progress, fileName: file.name || fallbackName }),
      })).url;
    } catch (err) {
      setUploadProgress(null);
      setError(blockUploadErrorMessage(err, file.name));
      return;
    }
    setError("");
    setDraft("");
    updateBlock(block.id, {
      content: { ...block.content, url: uploadedUrl, fileName: file.name },
      plainText: spansToPlainText(block.content?.caption),
    });
    ops.insertAfter(block.id, "paragraph");
  }

  function onCaptionInput() {
    const el = captionRef.current;
    if (!el) return;
    const caption = singleLineCaptionSpans(htmlToSpans(el));
    const html = spansToHtml(caption);
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      placeCaret(el, "end");
    }
    el.dataset.empty = String(spansToPlainText(caption).length === 0);
    updateBlock(
      block.id,
      {
        content: { ...block.content, caption },
        plainText: spansToPlainText(caption),
      },
      { debounce: true, history: "merge" }
    );
  }

  function startImageResize(side: "left" | "right", e: React.PointerEvent<HTMLButtonElement>) {
    const frame = imageRef.current;
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = frame.getBoundingClientRect();
    const containerWidth = Math.max(
      1,
      frame.parentElement?.getBoundingClientRect().width ?? rect.width
    );
    imageResize.current = {
      startX: e.clientX,
      startWidth: imageWidth ?? clampImageWidth((rect.width / containerWidth) * 100),
      containerWidth,
      side,
    };
    setImageResizing(true);

    function onPointerMove(ev: PointerEvent) {
      const current = imageResize.current;
      if (!current) return;
      const delta = ((ev.clientX - current.startX) / current.containerWidth) * 100;
      const nextWidth = clampImageWidth(
        current.startWidth + (current.side === "right" ? delta : -delta)
      );
      updateBlock(
        block.id,
        { content: { ...block.content, width: nextWidth } },
        { debounce: true, history: "merge" }
      );
    }

    function onPointerUp() {
      imageResize.current = null;
      setImageResizing(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  const body = url ? (
    <figure
      ref={imageRef}
      className={styles.imageBlock}
      data-sized={imageWidth ? "true" : undefined}
      data-resizing={imageResizing ? "true" : undefined}
      data-align={imageAlign}
      style={imageWidth ? { width: `${imageWidth}%` } : undefined}
    >
      <div className={styles.imageFrame}>
        <img
          src={url}
          alt={captionText || ""}
          onDoubleClick={() => setPreviewOpen(true)}
        />
        <button
          type="button"
          className={`${styles.imageResizeHandle} ${styles.imageResizeLeft}`}
          aria-label={blockItemText("image.resizeFromLeft")}
          title={blockItemText("common.resize")}
          onPointerDown={(e) => startImageResize("left", e)}
        />
        <button
          type="button"
          className={`${styles.imageResizeHandle} ${styles.imageResizeRight}`}
          aria-label={blockItemText("image.resizeFromRight")}
          title={blockItemText("common.resize")}
          onPointerDown={(e) => startImageResize("right", e)}
        />
        <div className={styles.imageActions} contentEditable={false}>
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              type="button"
              aria-label={blockItemText("image.alignAction", {
                align: blockItemText(`image.align.${align}`),
              })}
              aria-pressed={imageAlign === align}
              title={blockItemText("image.alignTitle", {
                align: blockItemText(`image.align.${align}`),
              })}
              onClick={() =>
                updateBlock(block.id, {
                  content: { ...block.content, align },
                })
              }
            >
              {align === "left" ? (
                <AlignLeftIcon size={14} aria-hidden="true" />
              ) : align === "center" ? (
                <AlignCenterIcon size={14} aria-hidden="true" />
              ) : (
                <AlignRightIcon size={14} aria-hidden="true" />
              )}
            </button>
          ))}
          <button
            type="button"
            aria-label={blockItemText("image.replace")}
            onClick={() => {
              // Don't seed the input with a data: URL (it can't be re-submitted
              // through safeUrl). Keep http(s) links so they stay editable.
              setDraft(url.startsWith("data:") ? "" : url);
              updateBlock(block.id, { content: { ...block.content, url: "" } });
            }}
          >
            {blockItemText("common.replace")}
          </button>
        </div>
      </div>
      {showCaption && (
        <figcaption
          ref={(el) => {
            captionRef.current = el;
          }}
          className={styles.caption}
          contentEditable={!ops.readOnly}
          role="textbox"
          aria-label={blockItemText("image.caption")}
          data-block-control="image-caption"
          aria-readonly={ops.readOnly}
          aria-multiline="false"
          aria-placeholder={blockItemText("common.addCaption")}
          suppressContentEditableWarning
          data-rt-editable="true"
          data-placeholder={blockItemText("common.addCaption")}
          data-empty={captionText.length === 0 ? "true" : "false"}
          onKeyDown={ops.readOnly ? undefined : (e) => onSingleLineCaptionKeyDown(e, block, ops)}
          onInput={ops.readOnly ? undefined : onCaptionInput}
          onPaste={ops.readOnly ? undefined : onSingleLineCaptionPaste}
        />
      )}
    </figure>
  ) : (
    <form
      className={styles.imageEmpty}
      onSubmit={commitImage}
      contentEditable={false}
      aria-labelledby={titleId}
    >
      <div className={styles.imageEmptyIcon} aria-hidden="true">
        <ImageIcon size={21} />
      </div>
      <div className={styles.imageEmptyBody}>
        <div id={titleId} className={styles.imageEmptyTitle}>
          {blockItemText("image.embed")}
        </div>
        <div id={hintId} className={styles.imageEmptyHint}>
          {blockItemText("image.emptyHint")}
        </div>
        <input
          ref={fileInputRef}
          className={styles.hiddenFileInput}
          type="file"
          accept="image/*"
          onChange={(e) => void pickImageFile(e.target.files?.[0])}
        />
        <div className={styles.imageInputRow}>
          <input
            type="url"
            value={draft}
            aria-label={blockItemText("image.link")}
            data-block-control="image-link"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : hintId}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError("");
            }}
            placeholder="https://..."
          />
          <button
            type="button"
            className={styles.secondaryMediaButton}
            disabled={!!uploadProgress}
            aria-busy={!!uploadProgress}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadProgress ? blockItemText("common.uploading") : blockItemText("common.upload")}
          </button>
          <button type="submit">{blockItemText("common.embed")}</button>
        </div>
        <UploadProgressRow progress={uploadProgress} />
        {error && <div id={errorId} className={styles.imageError} role="alert">{error}</div>}
      </div>
    </form>
  );

  const preview = previewOpen && url ? (
    // Backdrop click is a pointer shortcut. The visible close button and
    // Escape handler provide the equivalent keyboard path.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={previewRef}
      className={styles.imagePreviewBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={blockItemText("image.preview")}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) setPreviewOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setPreviewOpen(false);
          return;
        }
        trapModalTab(event, previewRef.current);
      }}
    >
      <button
        ref={previewCloseRef}
        type="button"
        className={styles.imagePreviewClose}
        aria-label={blockItemText("image.closePreview")}
        onClick={() => setPreviewOpen(false)}
      >
        ×
      </button>
      <img
        className={styles.imagePreviewImage}
        src={url}
        alt={spansToPlainText(block.content?.caption) || blockItemText("image.label")}
      />
    </div>
  ) : null;

  return (
    <>
      <BlockFrame block={block} ops={ops} depth={depth}>
        {body}
      </BlockFrame>
      {preview &&
        (typeof document === "undefined" ? preview : createPortal(preview, document.body))}
    </>
  );
}

function MediaBlock({
  block,
  ops,
  depth,
  kind,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
  kind: "video" | "audio";
}) {
  const updateBlock = useStore((s) => s.updateBlock);
  const captionRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(block.content?.url ?? "");
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<BlockUploadProgress | null>(null);
  const [fileDrop, setFileDrop] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const isVideo = kind === "video";
  const url = useWorkspaceFileUrl(block.content?.url, isVideo ? ["data:video/"] : ["data:audio/"]);
  const title = blockItemText(isVideo ? "media.embedVideo" : "media.embedAudio");
  const hint = blockItemText(isVideo ? "media.videoEmptyHint" : "media.audioEmptyHint");
  const captionText = blockCaptionText(block);
  const showCaption = blockCaptionVisible(block);

  useEffect(() => {
    const el = captionRef.current;
    if (!el) return;
    const html = spansToHtml(block.content?.caption);
    if (!editableHtmlMatches(el, html)) el.innerHTML = html;
    el.dataset.empty = String(spansToPlainText(block.content?.caption).length === 0);
  }, [block.id, block.content?.caption]);

  function commitMedia(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = safeUrl(draft);
    if (!normalized || normalized.startsWith("#") || /^mailto:/i.test(normalized)) {
      setError(blockItemText(isVideo ? "media.invalidVideoLink" : "media.invalidAudioLink"));
      return;
    }
    setError("");
    updateBlock(block.id, {
      content: { ...block.content, url: normalized },
      plainText: normalized,
    });
    ops.insertAfter(block.id, "paragraph");
  }

  async function pickMediaFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith(`${kind}/`)) {
      setError(blockItemText(isVideo ? "media.chooseVideoFile" : "media.chooseAudioFile"));
      return;
    }
    let uploadedUrl = "";
    try {
      const fallbackName = blockItemText(isVideo ? "media.video" : "media.audio");
      setError("");
      setUploadProgress({ phase: "preparing", percent: 0, fileName: file.name || fallbackName });
      uploadedUrl = (await uploadWorkspaceFile(file, isVideo ? "blocks/videos" : "blocks/audio", {
        pageId: block.pageId,
        blockId: block.id,
      }, {
        onProgress: (progress) =>
          setUploadProgress({ ...progress, fileName: file.name || fallbackName }),
      })).url;
    } catch (err) {
      setUploadProgress(null);
      setError(blockUploadErrorMessage(err, file.name));
      return;
    }
    setError("");
    setDraft("");
    updateBlock(block.id, {
      content: { ...block.content, url: uploadedUrl, fileName: file.name },
      plainText: file.name,
    });
    ops.insertAfter(block.id, "paragraph");
  }

  function onMediaDragOver(e: React.DragEvent<HTMLFormElement>) {
    if (ops.readOnly || !dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setFileDrop(true);
  }

  function onMediaDragLeave(e: React.DragEvent<HTMLFormElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setFileDrop(false);
  }

  function onMediaDrop(e: React.DragEvent<HTMLFormElement>) {
    if (ops.readOnly || !dataTransferHasFiles(e.dataTransfer)) return;
    const files = Array.from(e.dataTransfer.files).filter((file) => file.size > 0);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDrop(false);
    const matching = files.find((file) => file.type.startsWith(`${kind}/`));
    void pickMediaFile(matching ?? files[0]);
  }

  function onCaptionInput() {
    const el = captionRef.current;
    if (!el) return;
    const caption = singleLineCaptionSpans(htmlToSpans(el));
    const html = spansToHtml(caption);
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      placeCaret(el, "end");
    }
    el.dataset.empty = String(spansToPlainText(caption).length === 0);
    updateBlock(
      block.id,
      {
        content: { ...block.content, caption },
        plainText: url,
      },
      { debounce: true, history: "merge" }
    );
  }

  const videoEmbed = isVideo ? streamingVideoEmbed(url) : null;
  const body = url ? (
    <figure className={isVideo ? styles.videoBlock : styles.audioBlock} contentEditable={false}>
      <div className={isVideo ? styles.videoFrame : styles.audioFrame}>
        {isVideo ? (
          videoEmbed ? (
            <iframe
              className={styles.videoPlayer}
              src={videoEmbed}
              title={blockItemText("media.embeddedVideo")}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <video className={styles.videoPlayer} src={url} controls preload="metadata" />
          )
        ) : (
          <audio className={styles.audioPlayer} src={url} controls preload="metadata" />
        )}
        <div className={styles.mediaActions}>
          <button
            type="button"
            aria-label={blockItemText(isVideo ? "media.replaceVideo" : "media.replaceAudio")}
            onClick={() => {
              setDraft(url.startsWith("data:") ? "" : url);
              updateBlock(block.id, { content: { ...block.content, url: "" }, plainText: "" });
            }}
          >
            {blockItemText("common.replace")}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={blockItemText(isVideo ? "media.openVideo" : "media.openAudio")}
          >
            {blockItemText("common.open")}
          </a>
        </div>
      </div>
      {showCaption && (
        <figcaption
          ref={(el) => {
            captionRef.current = el;
          }}
          className={styles.caption}
          contentEditable={!ops.readOnly}
          role="textbox"
          aria-label={blockItemText(isVideo ? "media.videoCaption" : "media.audioCaption")}
          data-block-control={`${kind}-caption`}
          aria-readonly={ops.readOnly}
          aria-multiline="false"
          aria-placeholder={blockItemText("common.addCaption")}
          suppressContentEditableWarning
          data-rt-editable="true"
          data-placeholder={blockItemText("common.addCaption")}
          data-empty={captionText.length === 0 ? "true" : "false"}
          onKeyDown={ops.readOnly ? undefined : (e) => onSingleLineCaptionKeyDown(e, block, ops)}
          onInput={ops.readOnly ? undefined : onCaptionInput}
          onPaste={ops.readOnly ? undefined : onSingleLineCaptionPaste}
        />
      )}
    </figure>
  ) : (
    <form
      className={styles.mediaEmpty}
      onSubmit={commitMedia}
      onDragOver={onMediaDragOver}
      onDragLeave={onMediaDragLeave}
      onDrop={onMediaDrop}
      contentEditable={false}
      aria-labelledby={titleId}
      data-file-drop={fileDrop ? "true" : undefined}
    >
      <div className={styles.mediaEmptyIcon} aria-hidden="true">
        {isVideo ? <VideoIcon size={21} /> : <AudioIcon size={21} />}
      </div>
      <div className={styles.imageEmptyBody}>
        <div id={titleId} className={styles.imageEmptyTitle}>{title}</div>
        <div id={hintId} className={styles.imageEmptyHint}>{hint}</div>
        <input
          ref={fileInputRef}
          className={styles.hiddenFileInput}
          type="file"
          accept={`${kind}/*`}
          onChange={(e) => void pickMediaFile(e.target.files?.[0])}
        />
        <div className={styles.imageInputRow}>
          <input
            type="url"
            value={draft}
            aria-label={blockItemText(isVideo ? "media.videoLink" : "media.audioLink")}
            data-block-control={`${kind}-link`}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : hintId}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError("");
            }}
            placeholder="https://..."
          />
          <button
            type="button"
            className={styles.secondaryMediaButton}
            disabled={!!uploadProgress}
            aria-busy={!!uploadProgress}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadProgress ? blockItemText("common.uploading") : blockItemText("common.upload")}
          </button>
          <button type="submit" disabled={!draft.trim() || !!uploadProgress}>
            {blockItemText("common.embed")}
          </button>
        </div>
        <UploadProgressRow progress={uploadProgress} />
        {error && <div id={errorId} className={styles.imageError} role="alert">{error}</div>}
      </div>
    </form>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function BookmarkBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const updateBlock = useStore((s) => s.updateBlock);
  const [draft, setDraft] = useState(block.content?.url ?? "");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const url = useWorkspaceFileUrl(block.content?.url);

  function commitBookmark(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = safeUrl(draft);
    if (!normalized || normalized.startsWith("#") || /^mailto:/i.test(normalized)) {
      setError(blockItemText("bookmark.invalidLink"));
      return;
    }
    setError("");
    updateBlock(block.id, {
      content: { ...block.content, url: normalized },
      plainText: normalized,
    });
    ops.insertAfter(block.id, "paragraph");
  }

  async function copyBookmarkLink() {
    if (!url) return;
    const ok = await copyText(url);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  const body = url ? (
    <div className={styles.bookmarkWrap} contentEditable={false}>
      <a
        className={styles.bookmarkCard}
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={blockItemText("bookmark.openNamed", { title: displayUrl(url) })}
      >
        <span className={styles.bookmarkContent}>
          <span className={styles.bookmarkTitle}>{displayUrl(url)}</span>
          <span className={styles.bookmarkDescription}>{bookmarkSecondary(url)}</span>
          <span className={styles.bookmarkUrl}>
            {blockItemText("bookmark.linkPrefix")} · {url}
          </span>
        </span>
        <span className={styles.bookmarkThumb}>↗</span>
      </a>
      <div className={styles.bookmarkActions}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={blockItemText("bookmark.open")}
        >
          <OpenInNew size={13} aria-hidden="true" />
          {blockItemText("common.open")}
        </a>
        <button
          type="button"
          aria-label={blockItemText("bookmark.copy")}
          onClick={() => void copyBookmarkLink()}
        >
          {copied ? blockItemText("common.copied") : blockItemText("common.copyLink")}
        </button>
        <button
          type="button"
          aria-label={blockItemText("bookmark.replace")}
          onClick={() => {
            setDraft(url);
            updateBlock(block.id, { content: { ...block.content, url: "" }, plainText: "" });
          }}
        >
          {blockItemText("common.replace")}
        </button>
      </div>
    </div>
  ) : (
    <form
      className={styles.bookmarkEmpty}
      onSubmit={commitBookmark}
      contentEditable={false}
      aria-labelledby={titleId}
    >
      <div className={styles.bookmarkEmptyIcon} aria-hidden="true">
        <BookmarkIcon size={21} />
      </div>
      <div className={styles.imageEmptyBody}>
        <div id={titleId} className={styles.imageEmptyTitle}>
          {blockItemText("bookmark.embed")}
        </div>
        <div id={hintId} className={styles.imageEmptyHint}>
          {blockItemText("bookmark.emptyHint")}
        </div>
        <div className={styles.imageInputRow}>
          <input
            type="url"
            value={draft}
            aria-label={blockItemText("bookmark.link")}
            data-block-control="bookmark-link"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : hintId}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError("");
            }}
            placeholder="https://..."
          />
          <button type="submit">{blockItemText("common.embed")}</button>
        </div>
        {error && <div id={errorId} className={styles.imageError} role="alert">{error}</div>}
      </div>
    </form>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function EmbedBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const updateBlock = useStore((s) => s.updateBlock);
  const captionRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(block.content?.url ?? "");
  const [error, setError] = useState("");
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const url = useWorkspaceFileUrl(block.content?.url);
  const captionText = blockCaptionText(block);
  const showCaption = blockCaptionVisible(block);

  useEffect(() => {
    const el = captionRef.current;
    if (!el) return;
    const html = spansToHtml(block.content?.caption);
    if (!editableHtmlMatches(el, html)) el.innerHTML = html;
    el.dataset.empty = String(spansToPlainText(block.content?.caption).length === 0);
  }, [block.id, block.content?.caption]);

  function commitEmbed(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = safeUrl(draft);
    if (
      !normalized ||
      normalized.startsWith("#") ||
      /^mailto:/i.test(normalized) ||
      !isSafeEmbedTarget(
        normalized,
        typeof window === "undefined" ? undefined : window.location.origin
      )
    ) {
      setError(blockItemText("embed.invalidLink"));
      return;
    }
    setError("");
    // Convert common provider share/watch URLs to their embeddable form so the
    // iframe doesn't render a blank, X-Frame-blocked page.
    const embeddable = providerEmbedUrl(normalized) ?? normalized;
    updateBlock(block.id, {
      content: { ...block.content, url: embeddable },
      plainText: embeddable,
    });
    ops.insertAfter(block.id, "paragraph");
  }

  function onCaptionInput() {
    const el = captionRef.current;
    if (!el) return;
    const caption = singleLineCaptionSpans(htmlToSpans(el));
    const html = spansToHtml(caption);
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      placeCaret(el, "end");
    }
    el.dataset.empty = String(spansToPlainText(caption).length === 0);
    updateBlock(
      block.id,
      {
        content: { ...block.content, caption },
        plainText: url,
      },
      { debounce: true, history: "merge" }
    );
  }

  function openEmbedBlockActions(
    e: ReactMouseEvent<HTMLElement>,
    frameActions: BlockFrameActions | null,
    anchor?: BlockMenuAnchor | null
  ) {
    if (ops.readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    if (!ops.selectedBlockIds.has(block.id)) {
      ops.selectBlock(block.id);
    }
    frameActions?.openBlockMenu(anchor ?? { x: e.clientX, y: e.clientY });
  }

  // Existing blocks (stored before normalization) still get the embeddable form.
  const embedAllowed = isSafeEmbedTarget(
    block.content?.url,
    typeof window === "undefined" ? undefined : window.location.origin
  );
  const embedSrc = embedAllowed && url ? providerEmbedUrl(url) ?? url : "";
  const body = embedSrc ? (
    <BlockFrameActionsContext.Consumer>
      {(frameActions) => (
        <figure className={styles.embedBlock} contentEditable={false}>
          <div
            className={styles.embedFrame}
            data-embed-frame="true"
            onContextMenu={(e) => openEmbedBlockActions(e, frameActions)}
          >
            <iframe
              src={embedSrc}
              title={displayUrl(url)}
              loading="lazy"
              referrerPolicy="no-referrer"
              allow="fullscreen; clipboard-write"
              sandbox="allow-forms allow-popups allow-scripts"
              data-embed-iframe="true"
              onContextMenu={(e) => openEmbedBlockActions(e, frameActions)}
            />
            {!ops.readOnly && (
              <div
                className={styles.embedHoverBridge}
                data-embed-hover-bridge="true"
                aria-hidden="true"
                onContextMenu={(e) => openEmbedBlockActions(e, frameActions)}
              />
            )}
            <div className={styles.embedActions}>
              <button
                type="button"
                aria-label={blockItemText("embed.replace")}
                onClick={() => {
                  setDraft(url);
                  updateBlock(block.id, { content: { ...block.content, url: "" }, plainText: "" });
                }}
              >
                {blockItemText("common.replace")}
              </button>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                aria-label={blockItemText("embed.open")}
              >
                {blockItemText("common.open")}
              </a>
              {!ops.readOnly && (
                <button
                  type="button"
                  className={styles.embedActionIcon}
                  aria-label={blockItemText("embed.openActions")}
                  aria-haspopup="menu"
                  data-embed-action-menu="true"
                  onClick={(e) =>
                    openEmbedBlockActions(
                      e,
                      frameActions,
                      blockMenuAnchorFromElement(e.currentTarget)
                    )
                  }
                  onContextMenu={(e) =>
                    openEmbedBlockActions(
                      e,
                      frameActions,
                      blockMenuAnchorFromElement(e.currentTarget)
                    )
                  }
                >
                  <DotsHorizontal size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {showCaption && (
            <figcaption
              ref={(el) => {
                captionRef.current = el;
              }}
              className={styles.caption}
              contentEditable={!ops.readOnly}
              role="textbox"
              aria-label={blockItemText("embed.caption")}
              data-block-control="embed-caption"
              aria-readonly={ops.readOnly}
              aria-multiline="false"
              aria-placeholder={blockItemText("common.addCaption")}
              suppressContentEditableWarning
              data-rt-editable="true"
              data-placeholder={blockItemText("common.addCaption")}
              data-empty={captionText.length === 0 ? "true" : "false"}
              onKeyDown={ops.readOnly ? undefined : (e) => onSingleLineCaptionKeyDown(e, block, ops)}
              onInput={ops.readOnly ? undefined : onCaptionInput}
              onPaste={ops.readOnly ? undefined : onSingleLineCaptionPaste}
            />
          )}
        </figure>
      )}
    </BlockFrameActionsContext.Consumer>
  ) : (
    <form
      className={styles.embedEmpty}
      onSubmit={commitEmbed}
      contentEditable={false}
      aria-labelledby={titleId}
    >
      <div className={styles.embedEmptyIcon} aria-hidden="true">
        <OpenInNew size={21} />
      </div>
      <div className={styles.imageEmptyBody}>
        <div id={titleId} className={styles.imageEmptyTitle}>
          {blockItemText("embed.title")}
        </div>
        <div id={hintId} className={styles.imageEmptyHint}>
          {blockItemText("embed.emptyHint")}
        </div>
        <div className={styles.imageInputRow}>
          <input
            type="url"
            value={draft}
            aria-label={blockItemText("embed.link")}
            data-block-control="embed-link"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : hintId}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError("");
            }}
            placeholder="https://..."
          />
          <button type="submit">{blockItemText("common.embed")}</button>
        </div>
        {error && <div id={errorId} className={styles.imageError} role="alert">{error}</div>}
      </div>
    </form>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function FileBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const updateBlock = useStore((s) => s.updateBlock);
  const captionRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(block.content?.url ?? "");
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<BlockUploadProgress | null>(null);
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const url = useWorkspaceFileUrl(block.content?.url);
  const storedFile = !!storageKeyFromUrl(block.content?.url);
  const fileName = block.content?.fileName || (url ? fileNameFromUrl(url) : blockItemText("common.untitled"));
  const captionText = blockCaptionText(block);
  const showCaption = blockCaptionVisible(block);

  useEffect(() => {
    const el = captionRef.current;
    if (!el) return;
    const html = spansToHtml(block.content?.caption);
    if (!editableHtmlMatches(el, html)) el.innerHTML = html;
    el.dataset.empty = String(spansToPlainText(block.content?.caption).length === 0);
  }, [block.id, block.content?.caption]);

  function commitFile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = safeUrl(draft);
    if (!normalized || normalized.startsWith("#") || /^mailto:/i.test(normalized)) {
      setError(blockItemText("file.invalidLink"));
      return;
    }
    const name = fileNameFromUrl(normalized);
    setError("");
    updateBlock(block.id, {
      content: { ...block.content, url: normalized, fileName: name },
      plainText: name,
    });
    ops.insertAfter(block.id, "paragraph");
  }

  async function pickAttachedFile(file?: File) {
    if (!file) return;
    let uploadedUrl = "";
    try {
      setError("");
      const fallbackName = blockItemText("file.label");
      setUploadProgress({ phase: "preparing", percent: 0, fileName: file.name || fallbackName });
      uploadedUrl = (await uploadWorkspaceFile(file, "blocks/files", {
        pageId: block.pageId,
        blockId: block.id,
      }, {
        onProgress: (progress) => setUploadProgress({ ...progress, fileName: file.name || fallbackName }),
      })).url;
    } catch (err) {
      setUploadProgress(null);
      setError(blockUploadErrorMessage(err, file.name));
      return;
    }
    setError("");
    setDraft("");
    updateBlock(block.id, {
      content: { ...block.content, url: uploadedUrl, fileName: file.name },
      plainText: file.name,
    });
    ops.insertAfter(block.id, "paragraph");
  }

  function onCaptionInput() {
    const el = captionRef.current;
    if (!el) return;
    const caption = singleLineCaptionSpans(htmlToSpans(el));
    const html = spansToHtml(caption);
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      placeCaret(el, "end");
    }
    el.dataset.empty = String(spansToPlainText(caption).length === 0);
    updateBlock(
      block.id,
      {
        content: { ...block.content, caption },
        plainText: fileName,
      },
      { debounce: true, history: "merge" }
    );
  }

  const body = url ? (
    <figure className={styles.fileBlock} contentEditable={false}>
      <div className={styles.fileCard}>
        <span className={styles.fileIcon}>
          <FileText size={18} aria-hidden="true" />
        </span>
        <span className={styles.fileInfo}>
          <span className={styles.fileName}>{fileName}</span>
          <span className={styles.fileMeta}>{displayUrl(url)}</span>
        </span>
        <span className={styles.fileActions}>
          <button
            type="button"
            aria-label={blockItemText("file.replaceNamed", { fileName })}
            onClick={() => {
              setDraft(url.startsWith("data:") ? "" : url);
              updateBlock(block.id, {
                content: { ...block.content, url: "", fileName: undefined },
                plainText: "",
              });
            }}
          >
            {blockItemText("common.replace")}
          </button>
          {!storedFile && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label={blockItemText("file.openNamed", { fileName })}
            >
              {blockItemText("common.open")}
            </a>
          )}
          <a href={url} download aria-label={blockItemText("file.downloadNamed", { fileName })}>
            {blockItemText("common.download")}
          </a>
        </span>
      </div>
      {showCaption && (
        <figcaption
          ref={(el) => {
            captionRef.current = el;
          }}
          className={styles.caption}
          contentEditable={!ops.readOnly}
          role="textbox"
          aria-label={blockItemText("file.caption")}
          data-block-control="file-caption"
          aria-readonly={ops.readOnly}
          aria-multiline="false"
          aria-placeholder={blockItemText("common.addCaption")}
          suppressContentEditableWarning
          data-rt-editable="true"
          data-placeholder={blockItemText("common.addCaption")}
          data-empty={captionText.length === 0 ? "true" : "false"}
          onKeyDown={ops.readOnly ? undefined : (e) => onSingleLineCaptionKeyDown(e, block, ops)}
          onInput={ops.readOnly ? undefined : onCaptionInput}
          onPaste={ops.readOnly ? undefined : onSingleLineCaptionPaste}
        />
      )}
    </figure>
  ) : (
    <form
      className={styles.fileEmpty}
      onSubmit={commitFile}
      contentEditable={false}
      aria-labelledby={titleId}
    >
      <div className={styles.fileEmptyIcon} aria-hidden="true">
        <FileText size={21} />
      </div>
      <div className={styles.imageEmptyBody}>
        <div id={titleId} className={styles.imageEmptyTitle}>
          {blockItemText("file.attach")}
        </div>
        <div id={hintId} className={styles.imageEmptyHint}>
          {blockItemText("file.emptyHint")}
        </div>
        <input
          ref={fileInputRef}
          className={styles.hiddenFileInput}
          type="file"
          accept=".7z,.aac,.avif,.bmp,.csv,.doc,.docx,.flac,.gif,.gz,.heic,.heif,.jpeg,.jpg,.key,.m4a,.m4v,.md,.mov,.mp3,.mp4,.numbers,.odp,.ods,.odt,.oga,.ogg,.opus,.pages,.pdf,.png,.ppt,.pptx,.rar,.rtf,.tar,.tsv,.txt,.wav,.weba,.webm,.webp,.xls,.xlsx,.yaml,.yml,.zip"
          onChange={(e) => void pickAttachedFile(e.target.files?.[0])}
        />
        <div className={styles.imageInputRow}>
          <input
            type="url"
            value={draft}
            aria-label={blockItemText("file.link")}
            data-block-control="file-link"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : hintId}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError("");
            }}
            placeholder="https://..."
          />
          <button
            type="button"
            className={styles.secondaryMediaButton}
            disabled={!!uploadProgress}
            aria-busy={!!uploadProgress}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadProgress ? blockItemText("common.uploading") : blockItemText("common.upload")}
          </button>
          <button type="submit">{blockItemText("common.attach")}</button>
        </div>
        <UploadProgressRow progress={uploadProgress} />
        {error && <div id={errorId} className={styles.imageError} role="alert">{error}</div>}
      </div>
    </form>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function ChildPageBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const nav = useRouter();
  const childPageId = block.content?.childPageId;
  const page = useStore((s) => (childPageId ? s.pagesById[childPageId] : undefined));
  const pageSnapshot = page ?? linkedPageSnapshotFromBlock(block, "page");
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const [copied, setCopied] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<InlinePageMenuAnchor | null>(null);
  const title = pageSnapshot?.title?.trim() || block.plainText || blockItemText("common.untitled");
  const childHref = childPageId ? editorPageHref(ops, childPageId) : "";
  const openChildPage = () => {
    if (!childPageId) return;
    setSidebarOpen(false);
    nav.push(editorPageHref(ops, childPageId));
  };
  async function copyChildPageLink() {
    if (!childPageId) return;
    const url = editorAbsolutePageUrl(ops, childPageId);
    const ok = await copyText(url);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  function openChildPageMenu(e: ReactMouseEvent<HTMLElement>) {
    if (!childPageId || ops.publicReadOnly) return;
    e.preventDefault();
    e.stopPropagation();
    closeCompetingPageLinkMenus();
    setMenuAnchor(inlinePageMenuAnchorFromMouseEvent(e));
  }
  function openChildPageKeyboardMenu(e: ReactKeyboardEvent<HTMLElement>) {
    if (!childPageId || ops.publicReadOnly || !isInlinePageMenuKeyboardEvent(e)) return false;
    e.preventDefault();
    e.stopPropagation();
    closeCompetingPageLinkMenus();
    setMenuAnchor(inlinePageMenuAnchorFor(e.currentTarget));
    return true;
  }

  const body = childPageId ? (
    <>
      <span className={styles.childPageWrap} contentEditable={false}>
        <a
          className={styles.childPageLink}
          href={childHref}
          onContextMenu={openChildPageMenu}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            openChildPage();
          }}
          onKeyDown={(e) => {
            if (openChildPageKeyboardMenu(e)) return;
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key !== "Enter") return;
            e.preventDefault();
            openChildPage();
          }}
        >
          <span className={styles.childPageIcon}>
            {pageSnapshot ? <PageIconGlyph page={pageSnapshot} size={16} /> : <FileText size={16} aria-hidden="true" />}
          </span>
          <span className={styles.childPageTitle}>{title}</span>
        </a>
        <span className={styles.childPageActions}>
          <a
            href={childHref}
            target="_blank"
            rel="noreferrer"
            aria-label={blockItemText("childPage.openNewTab")}
            title={blockItemText("common.openNewTab")}
          >
            <OpenInNew size={13} aria-hidden="true" />
          </a>
          <button
            type="button"
            aria-label={blockItemText(copied ? "childPage.copiedLink" : "childPage.copyLink")}
            title={blockItemText(copied ? "common.copied" : "common.copyLink")}
            onClick={() => void copyChildPageLink()}
          >
            {copied ? <CheckIcon size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          </button>
        </span>
      </span>
      {menuAnchor && (
        <RowMenu
          pageId={childPageId}
          anchor={menuAnchor}
          variant="inline-page"
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </>
  ) : ops.readOnly || isImportedLinkedTargetBlock(block) ? (
    <span className={styles.childPageMissing} contentEditable={false}>
      <span className={styles.childPageIcon}>
        <FileText size={16} aria-hidden="true" />
      </span>
      <span className={styles.childPageTitle}>{title}</span>
    </span>
  ) : (
    <button
      type="button"
      className={styles.childPageMissing}
      onClick={() => ops.createChildPage(block.id)}
      contentEditable={false}
    >
      <span className={styles.childPageIcon}>
        <FileText size={16} aria-hidden="true" />
      </span>
      {blockItemText("childPage.create")}
    </button>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function isImportedLinkedTargetBlock(block: Block) {
  const content = block.content as Record<string, unknown> | undefined;
  if (!content) return !!block.plainText?.trim();
  const linkedTargets = content.notionLinkedTargetIds;
  return (
    !!block.plainText?.trim() ||
    !!content.notionBlock ||
    (Array.isArray(linkedTargets) && linkedTargets.length > 0) ||
    (typeof content.childPageTitle === "string" && content.childPageTitle.trim().length > 0)
  );
}

function linkedPageSnapshotFromBlock(block: Block, fallbackKind: Page["kind"]): Page | undefined {
  const childPageId = block.content?.childPageId;
  const title = typeof block.content?.childPageTitle === "string" ? block.content.childPageTitle.trim() : "";
  const icon = typeof block.content?.childPageIcon === "string" ? block.content.childPageIcon : undefined;
  const rawIconType = block.content?.childPageIconType;
  const iconType: Page["iconType"] =
    rawIconType === "image" || rawIconType === "emoji" || rawIconType === "none"
      ? rawIconType
      : icon
        ? "emoji"
        : "none";
  const kind = block.content?.childPageKind === "database" ? "database" : fallbackKind;
  if (!childPageId || (!title && !icon)) return undefined;
  return {
    id: childPageId,
    workspaceId: "",
    parentId: null,
    parentType: "page",
    kind,
    title: title || block.plainText || blockItemText("common.untitled"),
    icon,
    iconType,
    position: 0,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  };
}

function LinkToPageBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const nav = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const pickerReturnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(!block.content?.childPageId);
  const [query, setQuery] = useState(() =>
    block.content?.childPageId
      ? ""
      : block.plainText?.trim() || spansToPlainText(block.content?.rich).trim()
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<InlinePageMenuAnchor | null>(null);
  const { pagesById, updateBlock, createPage, setSidebarOpen } = useStore(
    useShallow((s) => ({
      pagesById: s.pagesById,
      updateBlock: s.updateBlock,
      createPage: s.createPage,
      setSidebarOpen: s.setSidebarOpen,
    }))
  );
  const linkedPageId = block.content?.childPageId;
  const linkedPage = linkedPageId ? pagesById[linkedPageId] : undefined;
  const currentPage = pagesById[block.pageId];
  const currentPageTitle = currentPage
    ? pageTitle(currentPage)
    : blockItemText("pageLink.currentPage");
  const createTitle = query.trim();
  const exactTitleMatch = createTitle
    ? Object.values(pagesById).some(
        (page) =>
          !page.inTrash &&
          pageTitle(page).trim().toLowerCase() === createTitle.toLowerCase()
      )
    : false;
  const canCreate = createTitle.length > 0 && !exactTitleMatch;
  const pickerId = `page-link-picker-${block.id}`;
  const resultsId = `${pickerId}-results`;

  function openPicker(trigger?: HTMLButtonElement | null) {
    pickerReturnRef.current = trigger ?? null;
    setPickerOpen(true);
  }

  function closePicker(restoreFocus = false) {
    setPickerOpen(false);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      const trigger = pickerReturnRef.current;
      if (trigger?.isConnected) trigger.focus();
    });
  }

  useEffect(() => {
    if (pickerOpen) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [pickerOpen]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(pagesById)
      .filter((page) => !page.inTrash)
      .map((page, index) => {
        const title = pageTitle(page);
        const path = pagePathOrWorkspaceRoot(page, pagesById);
        const haystack = `${title} ${path}`.toLowerCase();
        let score = index + 10;
        if (q) {
          if (title.toLowerCase() === q) score = 0;
          else if (title.toLowerCase().startsWith(q)) score = 1;
          else if (title.toLowerCase().includes(q)) score = 2;
          else if (haystack.includes(q)) score = 3;
          else score = Number.POSITIVE_INFINITY;
        }
        return { page, title, path, score };
      })
      .filter((result) => result.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
      .slice(0, 10);
  }, [pagesById, query]);
  const itemCount = results.length + (canCreate ? 1 : 0);
  const active = itemCount === 0 ? -1 : Math.min(activeIndex, itemCount - 1);

  useEffect(() => {
    resultsRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results.length, canCreate]);

  function choosePage(page: Page) {
    updateBlock(block.id, {
      type: "link_to_page",
      content: { ...block.content, childPageId: page.id },
      plainText: pageTitle(page),
    });
    closePicker(true);
    setQuery("");
  }

  async function createLinkedPage() {
    if (creating) return;
    const title = createTitle || blockItemText("common.untitled");
    setCreating(true);
    try {
      const page = await createPage({
        parentId: block.pageId,
        parentType: "page",
        title,
        focusTitle: false,
      });
      choosePage(page);
    } finally {
      setCreating(false);
    }
  }

  function chooseActive() {
    if (active < 0) return;
    const result = results[active];
    if (result) {
      choosePage(result.page);
      return;
    }
    if (canCreate) void createLinkedPage();
  }

  function openLinkedPage() {
    if (!linkedPageId) return;
    setSidebarOpen(false);
    nav.push(editorPageHref(ops, linkedPageId));
  }

  async function copyLinkedPageLink() {
    if (!linkedPageId) return;
    const url = editorAbsolutePageUrl(ops, linkedPageId);
    const ok = await copyText(url);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  function openLinkedPageMenu(e: ReactMouseEvent<HTMLElement>) {
    if (!linkedPageId || ops.publicReadOnly) return;
    e.preventDefault();
    e.stopPropagation();
    closeCompetingPageLinkMenus();
    setMenuAnchor(inlinePageMenuAnchorFromMouseEvent(e));
  }
  function openLinkedPageKeyboardMenu(e: ReactKeyboardEvent<HTMLElement>) {
    if (!linkedPageId || ops.publicReadOnly || !isInlinePageMenuKeyboardEvent(e)) return false;
    e.preventDefault();
    e.stopPropagation();
    closeCompetingPageLinkMenus();
    setMenuAnchor(inlinePageMenuAnchorFor(e.currentTarget));
    return true;
  }

  function optionId(index: number) {
    return `${pickerId}-option-${index}`;
  }

  function focusResult(index: number) {
    window.requestAnimationFrame(() => {
      resultsRef.current
        ?.querySelector<HTMLButtonElement>(`[data-page-link-index="${index}"]`)
        ?.focus();
    });
  }

  function setActive(nextIndex: number, focus = false) {
    if (itemCount === 0) return;
    const bounded = Math.max(0, Math.min(nextIndex, itemCount - 1));
    setActiveIndex(bounded);
    if (focus) focusResult(bounded);
  }

  function moveActive(delta: number, focus = false) {
    if (itemCount === 0) return;
    setActive((active + delta + itemCount) % itemCount, focus);
  }

  function onPickerInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePicker(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveActive(5);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveActive(-5);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(itemCount - 1);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseActive();
    }
  }

  function onPickerResultsKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePicker(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1, true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1, true);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveActive(5, true);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveActive(-5, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0, true);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(itemCount - 1, true);
    } else if (e.key === "Enter" || e.key === " " || e.key === "Tab") {
      e.preventDefault();
      chooseActive();
    }
  }

  const body = (
    <div className={styles.linkToPageWrap} contentEditable={false}>
      {linkedPage ? (
        <div className={styles.linkToPageRow}>
          <a
            className={styles.linkToPage}
            href={editorPageHref(ops, linkedPage.id)}
            onContextMenu={openLinkedPageMenu}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              openLinkedPage();
            }}
            onKeyDown={(e) => {
              if (openLinkedPageKeyboardMenu(e)) return;
              if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key !== "Enter") return;
              e.preventDefault();
              openLinkedPage();
            }}
          >
            <span className={styles.childPageIcon}>
              <PageIconGlyph page={linkedPage} size={16} />
            </span>
            <span className={styles.linkToPageText}>
              <span>{pageTitle(linkedPage)}</span>
              <span>{pagePathOrWorkspaceRoot(linkedPage, pagesById)}</span>
            </span>
          </a>
          <span className={styles.linkToPageActions}>
            <a
              href={editorPageHref(ops, linkedPage.id)}
              target="_blank"
              rel="noreferrer"
              aria-label={blockItemText("pageLink.openNewTab")}
              title={blockItemText("common.openNewTab")}
            >
              <OpenInNew size={13} aria-hidden="true" />
            </a>
            <button
              type="button"
              aria-label={blockItemText(copied ? "pageLink.copiedUrl" : "pageLink.copyUrl")}
              title={blockItemText(copied ? "common.copied" : "common.copyLink")}
              onClick={() => void copyLinkedPageLink()}
            >
              {copied ? <CheckIcon size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            </button>
            {!ops.readOnly && (
              <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                aria-label={blockItemText("pageLink.change")}
                title={blockItemText("common.change")}
                onClick={(e) => openPicker(e.currentTarget)}
              >
                <DotsHorizontal size={13} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      ) : ops.readOnly ? (
        <span className={styles.childPageMissing}>
          <span className={styles.childPageIcon}>↗</span>
          {blockItemText("pageLink.unavailable")}
        </span>
      ) : (
        <button
          type="button"
          className={styles.childPageMissing}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={(e) => openPicker(e.currentTarget)}
        >
          <span className={styles.childPageIcon}>↗</span>
          {blockItemText("pageLink.linkToPage")}
        </button>
      )}
      {linkedPageId && menuAnchor && (
        <RowMenu
          pageId={linkedPageId}
          anchor={menuAnchor}
          variant="inline-page"
          onClose={() => setMenuAnchor(null)}
        />
      )}
      {pickerOpen && (
        <>
          <button
            type="button"
            className={styles.menuBackdrop}
            aria-label={blockItemText("pageLink.closePicker")}
            onClick={() => closePicker(true)}
          />
          <div
            className={styles.pageLinkPicker}
            role="dialog"
            aria-label={blockItemText("pageLink.linkToPage")}
          >
            <input
              ref={inputRef}
              value={query}
              placeholder={blockItemText("pageLink.searchPlaceholder")}
              role="combobox"
              aria-label={blockItemText("pageLink.search")}
              aria-expanded="true"
              aria-controls={resultsId}
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onPickerInputKeyDown}
            />
            <div
              id={resultsId}
              className={styles.pageLinkResults}
              ref={resultsRef}
              role="listbox"
              tabIndex={-1}
              aria-label={blockItemText("pageLink.pages")}
              onKeyDown={onPickerResultsKeyDown}
            >
              {results.map(({ page, title, path }, index) => (
                <button
                  id={optionId(index)}
                  key={page.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  tabIndex={index === active ? 0 : -1}
                  data-page-link-index={index}
                  data-active={index === active ? "true" : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => choosePage(page)}
                >
                  <span className={styles.childPageIcon}>
                    <PageIconGlyph page={page} size={16} />
                  </span>
                  <span>
                    <span>{title}</span>
                    <span>{path}</span>
                  </span>
                </button>
              ))}
              {canCreate && (
                <button
                  id={optionId(results.length)}
                  type="button"
                  role="option"
                  aria-selected={results.length === active}
                  tabIndex={results.length === active ? 0 : -1}
                  data-page-link-index={results.length}
                  data-active={results.length === active ? "true" : undefined}
                  disabled={creating}
                  onMouseEnter={() => setActiveIndex(results.length)}
                  onFocus={() => setActiveIndex(results.length)}
                  onClick={() => void createLinkedPage()}
                >
                  <span className={styles.childPageIcon}>＋</span>
                  <span>
                    <span>{blockItemText("pageLink.newPageIn", { title: currentPageTitle })}</span>
                    <span>{createTitle}</span>
                  </span>
                </button>
              )}
              {itemCount === 0 && (
                <div className={styles.pageLinkEmpty}>{blockItemText("pageLink.noPages")}</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function ChildDatabaseBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const nav = useRouter();
  const childPageId = block.content?.childPageId;
  const page = useStore((s) => (childPageId ? s.pagesById[childPageId] : undefined));
  const pageSnapshot = page ?? linkedPageSnapshotFromBlock(block, "database");
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const [copied, setCopied] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<InlinePageMenuAnchor | null>(null);
  const title = pageSnapshot?.title?.trim() || block.plainText || blockItemText("common.untitled");
  const databaseHref = childPageId ? editorPageHref(ops, childPageId) : "";
  const openDatabasePage = () => {
    if (!childPageId) return;
    setSidebarOpen(false);
    nav.push(editorPageHref(ops, childPageId));
  };
  async function copyDatabaseLink() {
    if (!childPageId) return;
    const url = editorAbsolutePageUrl(ops, childPageId);
    const ok = await copyText(url);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  function openDatabasePageMenu(e: ReactMouseEvent<HTMLElement>) {
    if (!childPageId || ops.publicReadOnly) return;
    e.preventDefault();
    e.stopPropagation();
    closeCompetingPageLinkMenus();
    setMenuAnchor(inlinePageMenuAnchorFromMouseEvent(e));
  }
  function openDatabasePageKeyboardMenu(e: ReactKeyboardEvent<HTMLElement>) {
    if (!childPageId || ops.publicReadOnly || !isInlinePageMenuKeyboardEvent(e)) return false;
    e.preventDefault();
    e.stopPropagation();
    closeCompetingPageLinkMenus();
    setMenuAnchor(inlinePageMenuAnchorFor(e.currentTarget));
    return true;
  }

  const body = childPageId ? (
    <>
      <span className={styles.childPageWrap} contentEditable={false}>
        <a
          className={styles.childPageLink}
          href={databaseHref}
          onContextMenu={openDatabasePageMenu}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            openDatabasePage();
          }}
          onKeyDown={(e) => {
            if (openDatabasePageKeyboardMenu(e)) return;
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key !== "Enter") return;
            e.preventDefault();
            openDatabasePage();
          }}
        >
          <span className={styles.childPageIcon}>
            {pageSnapshot ? <PageIconGlyph page={pageSnapshot} size={16} fallback="database" /> : <Database size={16} aria-hidden="true" />}
          </span>
          <span className={styles.childPageTitle}>{title}</span>
        </a>
        <span className={styles.childPageActions}>
          <a
            href={databaseHref}
            target="_blank"
            rel="noreferrer"
            aria-label={blockItemText("childDatabase.openNewTab")}
            title={blockItemText("common.openNewTab")}
          >
            <OpenInNew size={13} aria-hidden="true" />
          </a>
          <button
            type="button"
            aria-label={blockItemText(
              copied ? "childDatabase.copiedLink" : "childDatabase.copyLink"
            )}
            title={blockItemText(copied ? "common.copied" : "common.copyLink")}
            onClick={() => void copyDatabaseLink()}
          >
            {copied ? <CheckIcon size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          </button>
        </span>
      </span>
      {menuAnchor && (
        <RowMenu
          pageId={childPageId}
          anchor={menuAnchor}
          variant="inline-page"
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </>
  ) : ops.readOnly || isImportedLinkedTargetBlock(block) ? (
    <span className={styles.childPageMissing} contentEditable={false}>
      <span className={styles.childPageIcon}>
        <Database size={16} aria-hidden="true" />
      </span>
      <span className={styles.childPageTitle}>{title}</span>
    </span>
  ) : (
    <button
      type="button"
      className={styles.childPageMissing}
      onClick={() => ops.createDatabase(block.id)}
      contentEditable={false}
    >
      <span className={styles.childPageIcon}>
        <Database size={16} aria-hidden="true" />
      </span>
      {blockItemText("childDatabase.create")}
    </button>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function orderedBlocks(blocks: Block[], parentId: string | null = null): Block[] {
  const out: Block[] = [];
  const children = blocks
    .filter((b) => (b.parentId ?? null) === parentId)
    .sort((a, b) => a.position - b.position);
  for (const child of children) {
    out.push(child, ...orderedBlocks(blocks, child.id));
  }
  return out;
}

function TableOfContentsBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const highlightTimer = useRef<number | undefined>(undefined);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const headingsJson = useStore((s) =>
    JSON.stringify(
      orderedBlocks(s.blocksByPage[block.pageId] ?? [])
        .filter((b) => HEADING_LEVEL[b.type])
        .map((b) => ({
          id: b.id,
          level: HEADING_LEVEL[b.type] ?? 1,
          title: spansToPlainText(b.content?.rich).trim() || blockItemText("common.untitled"),
        }))
    )
  );
  const headings = useMemo<Array<{ id: string; level: number; title: string }>>(() => {
    try {
      const parsed = JSON.parse(headingsJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [headingsJson]);
  const headingIds = headings.map((heading) => heading.id).join("|");

  useEffect(() => {
    if (headings.length === 0) return;

    let frame: number | undefined;
    const updateActiveHeading = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const viewportLine = Math.min(window.innerHeight * 0.32, 220);
        let active = headings[0]?.id ?? null;
        for (const heading of headings) {
          const element = document.getElementById(`block-${heading.id}`);
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          if (rect.top <= viewportLine) active = heading.id;
          else break;
        }
        setActiveHeadingId(active);
      });
    };

    updateActiveHeading();
    window.addEventListener("scroll", updateActiveHeading, { passive: true });
    window.addEventListener("resize", updateActiveHeading);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateActiveHeading);
      window.removeEventListener("resize", updateActiveHeading);
    };
  }, [headingIds, headings]);

  function jumpTo(id: string, e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    const st = useStore.getState();
    const pageBlocks = st.blocksByPage[block.pageId] ?? [];
    const byId = new Map(pageBlocks.map((b) => [b.id, b]));
    // Expand any collapsed toggle/toggle-heading ancestors so the target renders.
    let cur = byId.get(id);
    while (cur?.parentId) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      if (TOGGLE_BLOCKS.has(parent.type) && parent.content?.collapsed) {
        st.updateBlock(parent.id, { content: { ...parent.content, collapsed: false } });
      }
      cur = parent;
    }
    // Allow the newly-expanded blocks to mount before scrolling.
    requestAnimationFrame(() => {
      const target = document.getElementById(`block-${id}`);
      if (!target) return;
      const hash = `block-${id}`;
      if (window.location.hash !== `#${hash}`) {
        window.history.pushState(null, "", `#${hash}`);
      }
      document
        .querySelectorAll(".blockLinkTarget")
        .forEach((el) => el.classList.remove("blockLinkTarget"));
      target.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
      target.classList.add("blockLinkTarget");
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => {
        target.classList.remove("blockLinkTarget");
      }, 1800);
    });
  }

  useEffect(() => {
    return () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    };
  }, []);

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      <nav className={styles.toc} contentEditable={false} aria-label={blockItemText("toc.label")}>
        {headings.length === 0 ? (
          <div className={styles.tocEmpty}>{blockItemText("toc.empty")}</div>
        ) : (
          headings.map((heading) => (
            <a
              key={heading.id}
              className={styles.tocItem}
              data-level={heading.level}
              data-active={activeHeadingId === heading.id ? "true" : undefined}
              href={`#block-${heading.id}`}
              aria-current={activeHeadingId === heading.id ? "location" : undefined}
              onClick={(e) => jumpTo(heading.id, e)}
            >
              {heading.title}
            </a>
          ))
        )}
      </nav>
    </BlockFrame>
  );
}

function SyncedBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const nav = useRouter();
  const sourceId = block.content?.syncedBlockId ?? block.id;
  const sourcePageId = block.content?.syncedPageId ?? block.pageId;
  const isCopy = !!block.content?.syncedBlockId;
  const loadBlocks = useStore((s) => s.loadBlocks);
  const loaded = useStore((s) => s.loadedBlockPages.has(sourcePageId));
  const source = useStore((s) =>
    (s.blocksByPage[sourcePageId] ?? []).find((candidate) => candidate.id === sourceId)
  );
  const sourceChildren = useStore(
    useShallow((s) => s.childBlocks(sourcePageId, sourceId))
  );

  useEffect(() => {
    if (isCopy && !loaded) void loadBlocks(sourcePageId);
  }, [isCopy, loadBlocks, loaded, sourcePageId]);

  function openOriginal() {
    if (sourcePageId !== block.pageId) {
      nav.push(`${pageHref(sourcePageId)}#block-${encodeURIComponent(sourceId)}`);
      return;
    }
    document
      .getElementById(`block-${sourceId}`)
      ?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
  }

  return (
    <BlockFrame
      block={block}
      ops={ops}
      depth={depth}
      renderChildren={false}
      allowInsideDrop={!isCopy}
    >
      <section className={styles.syncedBlock} data-copy={isCopy ? "true" : undefined}>
        <div className={styles.syncedHeader} contentEditable={false}>
          <span className={styles.syncedIcon}>
            <SyncIcon size={14} aria-hidden="true" />
          </span>
          <span>{blockItemText(isCopy ? "synced.copy" : "synced.block")}</span>
          <span className={styles.syncedHeaderSpacer} />
          {isCopy ? (
            <>
              <button type="button" onClick={openOriginal}>
                {blockItemText("synced.original")}
              </button>
              {!ops.readOnly && (
                <button type="button" onClick={() => void ops.unsyncSyncedBlock(block.id)}>
                  {blockItemText("synced.unsync")}
                </button>
              )}
            </>
          ) : !ops.readOnly ? (
            <button type="button" onClick={() => ops.createSyncedBlockCopy(block.id)}>
              {blockItemText("common.copy")}
            </button>
          ) : (
            <span />
          )}
        </div>
        <div className={styles.syncedContent} contentEditable={isCopy ? false : undefined}>
          {!source ? (
            <div className={styles.syncedMissing}>{blockItemText("synced.unavailable")}</div>
          ) : sourceChildren.length === 0 ? (
            <div className={styles.syncedMissing}>{blockItemText("synced.empty")}</div>
          ) : isCopy ? (
            sourceChildren.map((child) => (
              <SyncedPreviewBlock
                key={child.id}
                block={child}
                depth={depth + 1}
                readOnly={ops.readOnly}
              />
            ))
          ) : (
            sourceChildren.map((child) => (
              <BlockItem key={child.id} block={child} ops={ops} depth={depth + 1} />
            ))
          )}
        </div>
      </section>
    </BlockFrame>
  );
}

function SyncedPreviewBlock({
  block,
  depth,
  readOnly = false,
}: {
  block: Block;
  depth: number;
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const childBlocks = useStore(
    useShallow((s) => s.childBlocks(block.pageId, block.id))
  );
  const pagesById = useStore((s) => s.pagesById);
  const updateBlock = useStore((s) => s.updateBlock);
  const page =
    block.content?.childPageId && (block.type === "child_page" || block.type === "link_to_page")
      ? pagesById[block.content.childPageId]
      : undefined;
  const text = spansToPlainText(block.content?.rich).trim();

  useEffect(() => {
    const el = ref.current;
    if (!el || !TEXT_BLOCKS.has(block.type)) return;
    const next = spansToHtml(block.content?.rich);
    if (el.innerHTML !== next) el.innerHTML = next;
    el.dataset.empty = String(spansToPlainText(block.content?.rich).length === 0);
  }, [block.id, block.type, block.content?.rich]);

  function onTextInput() {
    const el = ref.current;
    if (!el) return;
    const rich = htmlToSpans(el);
    el.dataset.empty = String(spansToPlainText(rich).length === 0);
    updateBlock(
      block.id,
      { content: { ...block.content, rich }, plainText: spansToPlainText(rich) },
      { debounce: true, history: "merge" }
    );
  }

  let body: React.ReactNode;
  if (TEXT_BLOCKS.has(block.type)) {
    if (block.type === "to_do") {
      body = (
        <label className={styles.syncedPreviewTodo} data-checked={block.content?.checked ? "true" : undefined}>
          <input
            type="checkbox"
            checked={!!block.content?.checked}
            disabled={readOnly}
            onChange={() =>
              updateBlock(block.id, {
                content: { ...block.content, checked: !block.content?.checked },
              })
            }
          />
          <span
            ref={ref}
            className={styles.syncedMirrorEditable}
            contentEditable={!readOnly}
            role="textbox"
            aria-label={blockItemText("synced.todoText")}
            aria-readonly={readOnly}
            aria-multiline="true"
            aria-placeholder={blockItemText("synced.todoPlaceholder")}
            suppressContentEditableWarning
            spellCheck
            data-rt-editable="true"
            data-placeholder={blockItemText("synced.todoPlaceholder")}
            onInput={readOnly ? undefined : onTextInput}
          />
        </label>
      );
    } else {
      body = (
        <div
          ref={ref}
          className={`${styles.syncedPreviewText} ${styles.syncedMirrorEditable}`}
          data-type={block.type}
          contentEditable={!readOnly}
          role="textbox"
          aria-label={blockItemText("synced.textbox", { label: blockTextBoxLabel(block) })}
          aria-readonly={readOnly}
          aria-multiline="true"
          aria-placeholder={blockTypePlaceholder(block.type)}
          suppressContentEditableWarning
          spellCheck
          data-rt-editable="true"
          data-placeholder={blockTypePlaceholder(block.type)}
          onInput={readOnly ? undefined : onTextInput}
        />
      );
    }
  } else if (block.type === "divider") {
    body = <hr className={styles.divider} />;
  } else if (block.type === "image" && block.content?.url) {
    body = <img className={styles.syncedPreviewImage} src={block.content.url} alt="" />;
  } else if ((block.type === "child_page" || block.type === "link_to_page") && page) {
    body = (
      <span className={styles.syncedPreviewPage}>
        <span className={styles.childPageIcon}>
          <PageIconGlyph page={page} size={16} />
        </span>
        {pageTitle(page)}
      </span>
    );
  } else {
    body = (
      <div className={styles.syncedPreviewText} data-type="paragraph">
        {text || block.plainText || blockTypeLabel(block.type)}
      </div>
    );
  }

  return (
    <div className={styles.syncedPreviewBlock} data-depth={depth}>
      {body}
      {childBlocks.length > 0 && (
        <div className={styles.syncedPreviewChildren}>
          {childBlocks.map((child) => (
            <SyncedPreviewBlock
              key={child.id}
              block={child}
              depth={depth + 1}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function buttonTemplateText(template?: ButtonTemplateBlock) {
  return spansToPlainText(template?.content?.rich);
}

function normalizeButtonTemplates(templates?: ButtonTemplateBlock[]) {
  return templates && templates.length > 0
    ? templates
    : [makeButtonTemplate("to_do", blockItemText("button.newTask"))];
}

function makeButtonTemplate(type: BlockType, text: string): ButtonTemplateBlock {
  const rich = text ? [{ text }] : [];
  const content: BlockContent = { rich };
  if (type === "to_do") content.checked = false;
  if (type === "callout") content.icon = "💡";
  return { type, content };
}

function ButtonBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const configRef = useRef<HTMLDivElement>(null);
  const updateBlock = useStore((s) => s.updateBlock);
  const isPartialNotionButton = block.content?.notionButtonPartial === true;
  const templates = isPartialNotionButton
    ? block.content?.buttonTemplate ?? []
    : normalizeButtonTemplates(block.content?.buttonTemplate);
  const label = block.content?.buttonLabel ?? block.plainText ?? blockItemText("button.newButton");
  const displayLabel = isPartialNotionButton && templates.length === 0
    ? blockItemText("button.label")
    : label.trim() || blockItemText("button.label");
  const [draftLabel, setDraftLabel] = useState(label);
  const [draftTemplates, setDraftTemplates] = useState<ButtonTemplateBlock[]>(templates);
  const draftLabelRef = useRef(draftLabel);
  const draftTemplatesRef = useRef(draftTemplates);

  function openConfig() {
    draftLabelRef.current = label;
    draftTemplatesRef.current = templates;
    setDraftLabel(label);
    setDraftTemplates(templates);
    setConfigOpen(true);
  }

  function closeConfig(restoreFocus = false) {
    setConfigOpen(false);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      settingsRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!configOpen) return;
    requestAnimationFrame(() => {
      configRef.current
        ?.querySelector<HTMLElement>("input, select, textarea, button")
        ?.focus();
    });
  }, [configOpen]);

  function saveConfig(next: {
    label?: string;
    templates?: ButtonTemplateBlock[];
  }) {
    const nextLabel = next.label ?? draftLabelRef.current;
    const nextTemplates = next.templates ?? draftTemplatesRef.current;
    draftLabelRef.current = nextLabel;
    draftTemplatesRef.current = nextTemplates;
    setDraftLabel(nextLabel);
    setDraftTemplates(nextTemplates);
    updateBlock(
      block.id,
      {
        content: {
          ...block.content,
          rich: [],
          buttonLabel: nextLabel,
          buttonTemplate: nextTemplates,
          notionButtonPartial: undefined,
        },
        plainText: nextLabel,
      },
      { debounce: true, history: "merge" }
    );
  }

  function updateTemplate(index: number, patch: { type?: BlockType; text?: string }) {
    const next = draftTemplatesRef.current.map((template, itemIndex) => {
      if (itemIndex !== index) return template;
      const type = patch.type ?? template.type;
      const text = patch.text ?? buttonTemplateText(template);
      return { ...makeButtonTemplate(type, text), children: template.children };
    });
    saveConfig({ templates: next });
  }

  function moveTemplate(index: number, direction: -1 | 1) {
    const target = index + direction;
    const currentTemplates = draftTemplatesRef.current;
    if (target < 0 || target >= currentTemplates.length) return;
    const next = currentTemplates.slice();
    [next[index], next[target]] = [next[target], next[index]];
    saveConfig({ templates: next });
  }

  function removeTemplate(index: number) {
    const next = draftTemplatesRef.current.filter((_, itemIndex) => itemIndex !== index);
    saveConfig({
      templates: next.length > 0
        ? next
        : [makeButtonTemplate("to_do", blockItemText("button.newTask"))],
    });
  }

  function addTemplate() {
    saveConfig({
      templates: [
        ...draftTemplatesRef.current,
        makeButtonTemplate("paragraph", blockItemText("button.newContent")),
      ],
    });
  }

  function captureNextBlock() {
    ops.captureNextBlockToButton(block.id);
  }

  return (
    <BlockFrame
      block={block}
      ops={ops}
      depth={depth}
      renderChildren={false}
      allowInsideDrop={false}
    >
      <div
        className={styles.buttonBlock}
        contentEditable={false}
        data-imported-partial={isPartialNotionButton && templates.length === 0 ? "true" : undefined}
      >
        <button
          type="button"
          className={styles.buttonAction}
          disabled={ops.readOnly || (isPartialNotionButton && templates.length === 0)}
          title={
            isPartialNotionButton && templates.length === 0
              ? blockItemText("button.importedActionUnavailable")
              : undefined
          }
          onClick={() => ops.runButton(block.id)}
        >
          <span className={styles.buttonIcon}>
            <Plus size={14} aria-hidden="true" />
          </span>
          <span>{displayLabel}</span>
        </button>
        {!ops.readOnly && !(isPartialNotionButton && templates.length === 0) && (
          <button
            type="button"
            className={styles.buttonSettings}
            ref={settingsRef}
            aria-label={blockItemText("button.configure")}
            aria-haspopup="dialog"
            aria-expanded={configOpen}
            onClick={openConfig}
          >
            <DotsHorizontal size={15} aria-hidden="true" />
          </button>
        )}
        {configOpen && (
          <>
            <button
              type="button"
              className={styles.menuBackdrop}
              aria-label={blockItemText("button.closeConfiguration")}
              onClick={() => closeConfig(true)}
            />
            <div
              className={styles.buttonConfig}
              ref={configRef}
              role="dialog"
              aria-label={blockItemText("button.configure")}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                closeConfig(true);
              }}
            >
              <label>
                <span>{blockItemText("button.name")}</span>
                <input
                  value={draftLabel}
                  placeholder={blockItemText("button.label")}
                  onChange={(e) => saveConfig({ label: e.target.value })}
                />
              </label>
              <div className={styles.buttonTemplateList}>
                <div className={styles.buttonConfigLabel}>{blockItemText("button.insertBlocks")}</div>
                {draftTemplates.map((template, index) => {
                  const type = BUTTON_TEMPLATE_BLOCK_TYPES.includes(template.type)
                    ? template.type
                    : "paragraph";
                  const childCount = template.children?.length ?? 0;
                  return (
                    <div className={styles.buttonTemplateItem} key={`${index}-${type}`}>
                      <div className={styles.buttonTemplateTop}>
                        <NotionSelect
                          className={styles.buttonTemplateSelect}
                          buttonClassName={styles.buttonTemplateSelectButton}
                          backdropClassName={styles.editorSelectBackdrop}
                          menuClassName={styles.buttonTemplateSelectMenu}
                          ariaLabel={blockItemText("button.templateBlockType")}
                          value={type}
                          options={BUTTON_TEMPLATE_BLOCK_TYPES.map((type) => ({
                            value: type,
                            label: blockTypeLabel(type),
                            icon: <BlockIcon type={type} size={15} />,
                          }))}
                          onChange={(next) => updateTemplate(index, { type: next as BlockType })}
                        />
                        <div className={styles.buttonTemplateActions}>
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => moveTemplate(index, -1)}
                            aria-label={blockItemText("button.moveTemplateUp")}
                          >
                            <ArrowUp size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={index === draftTemplates.length - 1}
                            onClick={() => moveTemplate(index, 1)}
                            aria-label={blockItemText("button.moveTemplateDown")}
                          >
                            <ArrowDown size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeTemplate(index)}
                            aria-label={blockItemText("button.removeTemplate")}
                          >
                            <Trash size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      <textarea
                        aria-label={blockItemText("button.templateText", { number: index + 1 })}
                        value={buttonTemplateText(template)}
                        rows={2}
                        placeholder={blockItemText("button.newContent")}
                        onChange={(e) => updateTemplate(index, { text: e.target.value })}
                      />
                      {childCount > 0 && (
                        <div className={styles.buttonTemplateMeta}>
                          {blockItemText("button.nestedBlocks", { count: childCount })}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className={styles.buttonTemplateFooter}>
                  <button type="button" className={styles.buttonAddTemplate} onClick={addTemplate}>
                    <Plus size={14} aria-hidden="true" /> {blockItemText("button.addBlock")}
                  </button>
                  <button
                    type="button"
                    className={styles.buttonAddTemplate}
                    onClick={captureNextBlock}
                  >
                    {blockItemText("button.captureNext")}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </BlockFrame>
  );
}

function BreadcrumbBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const nav = useRouter();
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const { workspace, pagesById } = useStore(
    useShallow((s) => ({ workspace: s.workspace, pagesById: s.pagesById }))
  );
  const pages = useMemo(() => {
    const out: Page[] = [];
    const seen = new Set<string>();
    let current: Page | undefined = pagesById[block.pageId];
    while (current && !seen.has(current.id)) {
      out.unshift(current);
      seen.add(current.id);
      current = current.parentId ? pagesById[current.parentId] : undefined;
    }
    return out;
  }, [block.pageId, pagesById]);

  function openPage(pageId: string, e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setSidebarOpen(false);
    nav.push(editorPageHref(ops, pageId));
  }

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      <nav
        className={styles.breadcrumbBlock}
        contentEditable={false}
        aria-label={blockItemText("breadcrumb.label")}
      >
        {workspace && !ops.publicReadOnly && (
          <>
            <button
              type="button"
              className={styles.breadcrumbItem}
              onClick={(e) => {
                e.preventDefault();
                setSidebarOpen(false);
                nav.push("/");
              }}
            >
              {workspace.icon ? `${workspace.icon} ` : ""}
              {workspace.name}
            </button>
            {pages.length > 0 && <span className={styles.breadcrumbSeparator}>/</span>}
          </>
        )}
        {pages.length === 0 ? (
          <span className={styles.breadcrumbEmpty}>{blockItemText("common.untitled")}</span>
        ) : (
          pages.map((page, index) => {
            const icon = page.iconType === "emoji" && page.icon ? `${page.icon} ` : "";
            const title = pageDisplayTitle(page);
            const isLast = index === pages.length - 1;
            return (
              <span key={page.id} className={styles.breadcrumbSegment}>
                <a
                  className={styles.breadcrumbItem}
                  data-current={isLast ? "true" : undefined}
                  href={editorPageHref(ops, page.id)}
                  onClick={(e) => openPage(page.id, e)}
                >
                  {icon}
                  {title}
                </a>
                {!isLast && <span className={styles.breadcrumbSeparator}>/</span>}
              </span>
            );
          })
        )}
      </nav>
    </BlockFrame>
  );
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function notionLinkedDatabaseRecord(contentRecord: Record<string, unknown> | undefined) {
  const linked = contentRecord?.notionLinkedDatabase;
  return linked && typeof linked === "object" && !Array.isArray(linked)
    ? (linked as Record<string, unknown>)
    : undefined;
}

function notionLinkedDatabaseLocalViewId(contentRecord: Record<string, unknown> | undefined) {
  const localViewId = notionLinkedDatabaseRecord(contentRecord)?.localViewId;
  return typeof localViewId === "string" && localViewId.trim().length > 0 ? localViewId : undefined;
}

function notionLinkedDatabaseTargetIds(contentRecord: Record<string, unknown> | undefined) {
  const linked = notionLinkedDatabaseRecord(contentRecord);
  const direct = cleanStringArray(linked?.targetIds);
  if (direct.length > 0) return direct;

  const legacy = cleanStringArray(contentRecord?.notionLinkedTargetIds);
  if (legacy.length > 0) return legacy;

  const references = Array.isArray(linked?.targetReferences) ? linked.targetReferences : [];
  const clean = references
    .map((reference) =>
      reference && typeof reference === "object" && !Array.isArray(reference)
        ? (reference as Record<string, unknown>).id
        : undefined
    )
    .filter((target): target is string => typeof target === "string" && target.trim().length > 0);
  return clean.length > 0 ? clean : undefined;
}

function inlineDatabaseVisibleViewIds(contentRecord: Record<string, unknown> | undefined, fallbackViewId?: string) {
  const ids = cleanStringArray(contentRecord?.databaseViewIds);
  const clean = ids.filter((id, index) => ids.indexOf(id) === index);
  if (clean.length > 0) return clean;
  const fallback = fallbackViewId ?? notionLinkedDatabaseLocalViewId(contentRecord);
  return fallback ? [fallback] : undefined;
}

function importedInlineDatabaseSurfaceTitle(
  block: Block,
  contentRecord: Record<string, unknown> | undefined,
) {
  const notionBlock =
    contentRecord?.notionBlock && typeof contentRecord.notionBlock === "object" && !Array.isArray(contentRecord.notionBlock)
      ? (contentRecord.notionBlock as Record<string, unknown>)
      : undefined;
  const notionChildDatabase =
    notionBlock?.child_database && typeof notionBlock.child_database === "object" && !Array.isArray(notionBlock.child_database)
      ? (notionBlock.child_database as Record<string, unknown>)
      : undefined;
  const candidates = [
    typeof contentRecord?.childPageTitle === "string" ? contentRecord.childPageTitle : undefined,
    spansToPlainText(block.content?.rich ?? []),
    typeof notionChildDatabase?.title === "string" ? notionChildDatabase.title : undefined,
  ];
  return candidates
    .map((candidate) => candidate?.trim())
    .map((candidate) => meaningfulInlineDatabaseTitle(candidate))
    .find((candidate): candidate is string => !!candidate);
}

function shouldHideImportedInlineDatabaseTitle(contentRecord: Record<string, unknown> | undefined) {
  if (contentRecord?.hideDatabaseTitle !== true) return false;
  const context =
    contentRecord.notionHiddenDatabaseTitleContext &&
    typeof contentRecord.notionHiddenDatabaseTitleContext === "object" &&
    !Array.isArray(contentRecord.notionHiddenDatabaseTitleContext)
      ? (contentRecord.notionHiddenDatabaseTitleContext as Record<string, unknown>)
      : undefined;
  const inferredFrom = typeof context?.inferredFrom === "string" ? context.inferredFrom : "";
  return inferredFrom !== "sibling_heading_view_context";
}

function InlineDatabaseBlock({
  block,
  ops,
  depth,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
}) {
  const nav = useRouter();
  const childPageId = block.content?.childPageId;
  const contentRecord = block.content as Record<string, unknown> | undefined;
  const databaseViewId =
    typeof block.content?.databaseViewId === "string"
      ? block.content.databaseViewId
      : notionLinkedDatabaseLocalViewId(contentRecord);
  const importedLinkedDatabase = !!(
    (contentRecord?.notionLinkedDatabase &&
      typeof contentRecord.notionLinkedDatabase === "object") ||
    Array.isArray(contentRecord?.notionLinkedViewIds)
  );
  const linkedDatabaseSource = importedLinkedDatabase || contentRecord?.linkedDatabaseSource === true;
  const hasInlineScopedViews = linkedDatabaseSource;
  const hideDatabaseTitle = shouldHideImportedInlineDatabaseTitle(contentRecord);
  const visibleViewIds = hasInlineScopedViews
    ? inlineDatabaseVisibleViewIds(contentRecord, databaseViewId)
    : undefined;
  const linkedDatabaseTargetIds = notionLinkedDatabaseTargetIds(contentRecord);
  const db = useStore((s) => (childPageId ? s.pagesById[childPageId] : undefined));
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const notify = useStore((s) => s.notify);
  const updateBlock = useStore((s) => s.updateBlock);
  const updatePage = useStore((s) => s.updatePage);
  const wrapRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsAnchor, setActionsAnchor] = useState<InlineMenuAnchor | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const resolvedLinkedDatabaseTitle = linkedDatabaseResolvedTitle(db);
  const importedSurfaceTitle = importedInlineDatabaseSurfaceTitle(block, contentRecord);
  // Use the raw stored title, not pageDisplayTitle(): the latter substitutes an
  // "Untitled" display fallback for an empty title, which would then read as a
  // meaningful value and suppress the placeholder. Clearing the title must leave
  // the field empty so the inline-database placeholder shows (Notion parity).
  const inlineDatabaseTitle = db ? (db.title ?? "") : inlineDatabasePlaceholderTitle();
  const meaningfulResolvedLinkedDatabaseTitle = meaningfulInlineDatabaseTitle(resolvedLinkedDatabaseTitle);
  const shouldPreferResolvedLinkedDatabaseTitle =
    db?.properties?.notionLinkedDatabaseSourceUnavailable === true &&
    !!meaningfulResolvedLinkedDatabaseTitle;
  const canOpenDatabasePage = !ops.publicReadOnly || !!ops.sharedToken;
  const shouldRenderTitleInput = editingTitle;
  const { text: inlineTitleText, isPlaceholder: inlineTitleIsPlaceholder } =
    inlineDatabaseTitleDisplay({
      ownTitle: inlineDatabaseTitle,
      importedSurfaceTitle,
      resolvedLinkedTitle: resolvedLinkedDatabaseTitle,
      preferResolvedLinked: shouldPreferResolvedLinkedDatabaseTitle,
    });
  const dbTitle = db ? inlineTitleText : blockItemText("database.label");
  const inlineTitleWidth = inlineDatabaseTitleWidth(inlineTitleText);
  const inlineChromeLeft = hideDatabaseTitle
    ? "0px"
    : linkedDatabaseSource
      ? `calc(60px + ${inlineTitleWidth} + 60px)`
      : `calc(31px + ${inlineTitleWidth} + 31px)`;

  useEffect(() => {
    if (!db || ops.readOnly || contentRecord?.autoFocusDatabaseTitle !== true) return;
    setEditingTitle(true);
    const nextContent = { ...contentRecord };
    delete nextContent.autoFocusDatabaseTitle;
    updateBlock(block.id, { content: nextContent }, { history: false });
  }, [block.id, contentRecord, db, ops.readOnly, updateBlock]);

  useEffect(() => {
    if (!editingTitle) return;
    const frame = window.requestAnimationFrame(() => {
      const input = titleInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const caret = input.value.length;
      input.setSelectionRange(caret, caret);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editingTitle]);

  function openInlineDatabasePage() {
    if (!childPageId) return;
    closeInlineDatabaseActions();
    setSidebarOpen(false);
    nav.push(editorPageHref(ops, childPageId));
  }

  function openInlineDatabaseActions(button: HTMLButtonElement) {
    setActionsAnchor(inlineMenuAnchorFromRect(button.getBoundingClientRect()));
    setActionsOpen((open) => {
      const next = !open;
      if (!next) setIconPickerOpen(false);
      return next;
    });
  }

  function closeInlineDatabaseActions() {
    setActionsOpen(false);
    setIconPickerOpen(false);
  }

  function openInlineDatabaseAddView(button: HTMLButtonElement) {
    const databaseRoot = wrapRef.current?.querySelector<HTMLElement>('[data-placement="inline"]');
    if (!databaseRoot) {
      notify(blockItemLabels().databaseNotReady, "default");
      return;
    }
    const event = new CustomEvent("hanji:open-inline-add-view", {
      cancelable: true,
      detail: { anchor: button },
    });
    databaseRoot.dispatchEvent(event);
    if (event.defaultPrevented) return;
    const tabAddButton = databaseRoot?.querySelector<HTMLButtonElement>('[data-view-add-wrap] button');
    if (tabAddButton) {
      tabAddButton.click();
    }
  }

  function editInlineDatabaseTitle() {
    if (ops.readOnly) return;
    closeInlineDatabaseActions();
    setEditingTitle(true);
  }

  function inlineDatabaseRoot() {
    return wrapRef.current?.querySelector<HTMLElement>('[data-placement="inline"]') ?? null;
  }

  function dispatchInlineDatabaseCommand(command: string) {
    const databaseRoot = inlineDatabaseRoot();
    if (!databaseRoot) {
      notify(blockItemLabels().databaseNotReady, "default");
      return;
    }
    databaseRoot.dispatchEvent(
      new CustomEvent(INLINE_DATABASE_COMMAND_EVENT, {
        detail: { command },
      })
    );
    closeInlineDatabaseActions();
  }

  function openInlineDatabaseToolbarMenu(menu: "layout" | "sourceProperties") {
    const databaseRoot = inlineDatabaseRoot();
    if (!databaseRoot) {
      notify(blockItemLabels().databaseNotReady, "default");
      return;
    }
    databaseRoot.dispatchEvent(
      new CustomEvent(INLINE_DATABASE_TOOLBAR_MENU_EVENT, {
        detail: { menu },
      })
    );
    closeInlineDatabaseActions();
  }

  function updateInlineDatabaseIcon(icon: string | undefined, iconType: "emoji" | "image" | "none") {
    if (!db || ops.readOnly) return;
    updatePage(db.id, { icon: icon ?? "", iconType });
    closeInlineDatabaseActions();
  }

  function hideInlineDatabaseTitle() {
    if (ops.readOnly) return;
    const nextContent = { ...(block.content ?? {}) } as BlockContent & Record<string, unknown>;
    nextContent.hideDatabaseTitle = true;
    closeInlineDatabaseActions();
    updateBlock(block.id, { content: nextContent }, { history: "merge" });
    notify(blockItemLabels().databaseTitleHidden, "success", {
      label: blockItemLabels().undo,
      onClick: () => {
        const restored = { ...nextContent } as BlockContent & Record<string, unknown>;
        delete restored.hideDatabaseTitle;
        updateBlock(block.id, { content: restored }, { history: "merge" });
      },
    });
  }

  function onInlineDatabaseTitleClick(e: React.MouseEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (linkedDatabaseSource && canOpenDatabasePage) {
      openInlineDatabasePage();
      return;
    }
    editInlineDatabaseTitle();
  }

  function onInlineDatabaseTitleKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (linkedDatabaseSource && canOpenDatabasePage && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      openInlineDatabasePage();
      return;
    }
    if (!linkedDatabaseSource && !ops.readOnly && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      editInlineDatabaseTitle();
      return;
    }
    if (ops.readOnly || e.key !== "F2") return;
    e.preventDefault();
    e.stopPropagation();
    editInlineDatabaseTitle();
  }

  function updateInlineDatabaseViews(viewIds: string[], activeViewId: string | null) {
    if (!hasInlineScopedViews) return;
    const clean = viewIds.filter((id, index) => id.trim().length > 0 && viewIds.indexOf(id) === index);
    const nextActiveId = activeViewId ?? clean[0] ?? databaseViewId;
    updateBlock(
      block.id,
      {
        content: {
          ...block.content,
          databaseViewId: nextActiveId,
          databaseViewIds: clean.length > 0 ? clean : undefined,
        },
      },
      { debounce: true, history: "merge" }
    );
  }

  // Move focus from the title input into the database body (Enter / ArrowDown),
  // so the embedded database feels connected to the title.
  function onTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isComposingKeyEvent(e)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "Enter" && childPageId) {
      e.preventDefault();
      openInlineDatabasePage();
      return;
    }
    if (e.key !== "Enter" && e.key !== "ArrowDown") return;
    const candidates = wrapRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
    );
    const target = candidates
      ? Array.from(candidates).find((el) => el !== e.currentTarget)
      : undefined;
    if (target) {
      e.preventDefault();
      target.focus();
    }
  }

  const inlineDatabaseActionsMenu =
    actionsOpen && actionsAnchor ? (
      <>
        <button
          type="button"
          className={`${styles.menuBackdrop} ${styles.inlineDatabaseMenuBackdrop}`}
          onClick={closeInlineDatabaseActions}
          tabIndex={-1}
          aria-label={blockItemText("database.closeOptions")}
        />
        <div
          className={styles.inlineDatabaseMenu}
          style={anchoredMenuPosition(
            actionsAnchor,
            INLINE_DATABASE_MENU_WIDTH,
            INLINE_DATABASE_MENU_HEIGHT,
            6
          )}
          role="menu"
          aria-label={blockItemText("database.options", { title: dbTitle })}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => dispatchInlineDatabaseCommand("copy-active-view-link")}
          >
            <LinkIcon size={16} aria-hidden="true" />
            <span>{blockItemLabels().copyViewLink}</span>
          </button>
          {!ops.readOnly && (
            <button
              type="button"
              role="menuitem"
              onClick={() => dispatchInlineDatabaseCommand("duplicate-active-view")}
            >
              <Copy size={16} aria-hidden="true" />
              <span>{blockItemLabels().duplicateView}</span>
            </button>
          )}
          <div className={styles.inlineDatabaseMenuSeparator} role="separator" />
          <button type="button" role="menuitem" onClick={openInlineDatabasePage}>
            <OpenInNew size={16} aria-hidden="true" />
            <span>{blockItemLabels().viewDataSource}</span>
          </button>
          {!ops.readOnly && (
            <button type="button" role="menuitem" onClick={editInlineDatabaseTitle}>
              <Pencil size={16} aria-hidden="true" />
              <span>{blockItemLabels().editTitle}</span>
            </button>
          )}
          {!ops.readOnly && (
            <>
              <button
                type="button"
                role="menuitem"
                aria-haspopup="dialog"
                aria-expanded={iconPickerOpen}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIconPickerOpen((open) => !open);
                }}
              >
                <SmileIcon size={16} aria-hidden="true" />
                <span>{blockItemLabels().editIcon}</span>
              </button>
              <div className={styles.inlineDatabaseIconPickerHost}>
                {iconPickerOpen && db && (
                  <EmojiPicker
                    placement="inline"
                    uploadTarget={{ pageId: db.id }}
                    onPick={(emoji) => updateInlineDatabaseIcon(emoji, "emoji")}
                    onPickImage={(url) => updateInlineDatabaseIcon(url, "image")}
                    onRemove={() => updateInlineDatabaseIcon(undefined, "none")}
                    onClose={() => setIconPickerOpen(false)}
                  />
                )}
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => openInlineDatabaseToolbarMenu("layout")}
              >
                <LayoutIcon size={16} aria-hidden="true" />
                <span>{blockItemLabels().editLayout}</span>
              </button>
              <div className={styles.inlineDatabaseMenuSeparator} role="separator" />
              <button type="button" role="menuitem" onClick={hideInlineDatabaseTitle}>
                <EyeSlashIcon size={16} aria-hidden="true" />
                <span>{blockItemLabels().hideTitle}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => dispatchInlineDatabaseCommand("ensure-calendar-view")}
              >
                <CalendarIcon size={16} aria-hidden="true" />
                <span>{blockItemLabels().manageInCalendar}</span>
              </button>
            </>
          )}
        </div>
      </>
    ) : null;
  const inlineDatabaseActionsMenuPortal =
    inlineDatabaseActionsMenu && typeof document !== "undefined"
      ? createPortal(inlineDatabaseActionsMenu, document.body)
      : inlineDatabaseActionsMenu;

  const body = db ? (
    <div
      className={styles.inlineDatabase}
      contentEditable={false}
      data-contained="true"
      data-inline-database-wrapper
      ref={wrapRef}
      data-inline-database-linked-source={linkedDatabaseSource ? "true" : undefined}
      style={{ "--inline-database-chrome-left": inlineChromeLeft } as CSSProperties}
    >
      {!hideDatabaseTitle && (
        <div className={styles.inlineDatabaseHeader}>
          {canOpenDatabasePage && !shouldRenderTitleInput && linkedDatabaseSource && (
            <button
              type="button"
              className={styles.inlineDatabaseOpenButton}
              title={blockItemLabels().openDatabase(dbTitle)}
              aria-label={blockItemLabels().openDatabase(dbTitle)}
              onClick={onInlineDatabaseTitleClick}
              data-inline-database-open-action="true"
              data-inline-database-open-placement="leading"
            >
              <OpenInNew size={18} aria-hidden="true" />
            </button>
          )}
          {shouldRenderTitleInput ? (
            <input
              ref={titleInputRef}
              className={styles.inlineDatabaseTitle}
              style={{ "--inline-database-title-width": inlineTitleWidth } as CSSProperties}
              value={inlineTitleIsPlaceholder ? "" : inlineTitleText}
              placeholder={inlineDatabasePlaceholderTitle()}
              aria-label={blockItemText("database.titleInput", { title: dbTitle })}
              data-inline-database-title
              data-inline-database-placeholder={inlineTitleIsPlaceholder ? "true" : undefined}
              readOnly={ops.readOnly}
              onChange={(e) =>
                updatePage(db.id, { title: e.target.value }, { debounce: true })
              }
              onKeyDown={onTitleKeyDown}
              onBlur={() => setEditingTitle(false)}
            />
          ) : (
            <span
              className={styles.inlineDatabaseTitle}
              style={{ "--inline-database-title-width": inlineTitleWidth } as CSSProperties}
              data-inline-database-title
              data-inline-database-resolved-title={meaningfulResolvedLinkedDatabaseTitle ? "true" : undefined}
              data-inline-database-placeholder={inlineTitleIsPlaceholder ? "true" : undefined}
              data-inline-database-clickable={linkedDatabaseSource && canOpenDatabasePage ? "true" : undefined}
              data-inline-database-editable-title={!linkedDatabaseSource && !ops.readOnly ? "true" : undefined}
              role={linkedDatabaseSource && canOpenDatabasePage ? "link" : ops.readOnly ? undefined : "button"}
              tabIndex={linkedDatabaseSource && canOpenDatabasePage ? 0 : ops.readOnly ? undefined : 0}
              title={
                linkedDatabaseSource && canOpenDatabasePage
                  ? blockItemLabels().openDatabase(dbTitle)
                  : ops.readOnly
                    ? undefined
                    : blockItemLabels().editTitle
              }
              onClick={onInlineDatabaseTitleClick}
              onKeyDown={onInlineDatabaseTitleKeyDown}
            >
              {inlineTitleText}
            </span>
          )}
          {hasInlineScopedViews && !ops.readOnly && !shouldRenderTitleInput && (
            <button
              type="button"
              className={styles.inlineDatabaseAddViewButton}
              title={blockItemLabels().addView}
              aria-label={blockItemLabels().addView}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openInlineDatabaseAddView(e.currentTarget);
              }}
              data-inline-database-add-view-action="true"
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          )}
          {canOpenDatabasePage && (
            <div className={styles.inlineDatabaseActions} data-inline-database-actions="true">
              <button
                type="button"
                title={blockItemText("database.options", { title: dbTitle })}
                aria-label={blockItemText("database.options", { title: dbTitle })}
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  openInlineDatabaseActions(e.currentTarget);
                }}
                data-inline-database-action="menu"
              >
                <DotsHorizontal size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {inlineDatabaseActionsMenuPortal}
        </div>
      )}
      <Suspense fallback={<InlineDatabaseFallback />}>
        <DatabaseView
          db={db}
          readOnly={ops.readOnly}
          publicReadOnly={ops.publicReadOnly}
          sharedToken={ops.sharedToken}
          skipRemoteLoad={ops.publicReadOnly}
          initialViewId={databaseViewId}
          visibleViewIds={visibleViewIds}
          notionLinkedDatabaseTargetIds={linkedDatabaseTargetIds}
          syncUrl={false}
          syncRowUrl
          placement="inline"
          contextPageId={ops.pageId}
          scopedViewOwnerId={hasInlineScopedViews ? block.id : undefined}
          onScopedViewsChange={hasInlineScopedViews ? updateInlineDatabaseViews : undefined}
          publishAwareness={ops.publishAwareness}
          remoteAwarenessByBlock={ops.remoteAwarenessByBlock}
        />
      </Suspense>
    </div>
  ) : ops.readOnly ? (
    <span className={styles.inlineDatabaseMissing} contentEditable={false}>
      <span className={styles.childPageIcon}>
        <Database size={16} aria-hidden="true" />
      </span>
      {blockItemText("database.unavailable")}
    </span>
  ) : (
    <button
      type="button"
      className={styles.inlineDatabaseMissing}
      onClick={() => ops.createInlineDatabase(block.id)}
      contentEditable={false}
    >
      <span className={styles.childPageIcon}>
        <Database size={16} aria-hidden="true" />
      </span>
      {blockItemText("database.createInline")}
    </button>
  );

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      {body}
    </BlockFrame>
  );
}

function TextFloatingMenuPortal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? <>{children}</> : createPortal(children, document.body);
}
