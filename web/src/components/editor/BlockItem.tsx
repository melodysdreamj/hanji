"use client";

import {
  lazy,
  Suspense,
  type CompositionEvent as ReactCompositionEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type ReactNode,
  memo,
  useCallback,
  createContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { copyText } from "@/lib/clipboard";
import { activeDateLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";
import { fetchUrlMetadataRemote, searchOrganizationPeopleRemote } from "@/lib/edgebase";
import { isSafeEmbedTarget } from "@/lib/fileSecurity";
import { storageKeyFromUrl, useWorkspaceFileUrl } from "@/lib/fileUrls";
import { positionBetween } from "@/lib/ids";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { motionSafeScrollBehavior } from "@/lib/motion";
import { isolateBodyForModal, trapModalTab } from "@/lib/modalFocus";
import { absolutePageUrl, absoluteSharedPageUrl, pageHref, sharedPageHref } from "@/lib/navigation";
import { pagePath, pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageIdFromPageHref } from "@/lib/pageLinks";
import { databaseDisplayTitle, linkedDatabaseResolvedTitle, pageDisplayTitle } from "@/lib/pageTitle";
import type {
  PageAwarenessMode,
  PageAwarenessTextRange,
  PagePresenceAwareness,
} from "@/lib/pagePresence";
import { uploadWorkspaceFile } from "@/lib/storage";
import type {
  Block,
  BlockContent,
  BlockType,
  ButtonTemplateBlock,
  OrganizationProfile,
  Page,
  TextSpan,
} from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import { useStore } from "@/lib/store";
import { NotionSelect } from "../database/NotionSelect";
import { personInitials, personLabel } from "../database/people";
import { BLOCK_DRAG_TYPE } from "../dndTypes";
import { EmojiPicker } from "../EmojiPicker";
import { PageIconGlyph, pageIconText } from "../PageIcon";
import { RowMenu } from "../RowMenu";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowDown,
  ArrowUp,
  AudioIcon,
  BookmarkIcon,
  CalendarIcon,
  CaretRightFill,
  CheckIcon,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  DotsHorizontal,
  EyeSlashIcon,
  FileText,
  ImageIcon,
  LayoutIcon,
  LinkIcon,
  OpenInNew,
  Pencil,
  Plus,
  SmileIcon,
  SyncIcon,
  Trash,
  UserIcon,
  VideoIcon,
} from "../icons";
import {
  caretOffset,
  focusBlockControlSettled,
  focusEditableSettled,
  getEditable,
  isEditableFullySelected,
  isCaretAtEnd,
  isCaretAtStart,
  placeCaret,
  selectionOffsetsIn,
  registerEditable,
  selectEditableContents,
} from "./focus";
import {
  blockUploadErrorMessage,
  blockUploadProgressLabel,
  dataTransferHasFiles,
  droppedFiles,
  type BlockUploadProgress,
  type FileDropPlacement,
} from "./fileDrop";
import {
  concatSpans,
  escapeHtml,
  htmlToSpans,
  safeUrl,
  spansToHtml,
  splitSpans,
} from "./richtext";
import {
  inlineDatabasePlaceholderTitle,
  inlineDatabaseTitleDisplay,
  meaningfulInlineDatabaseTitle,
} from "./databaseTitles";
import {
  blockDefLabel,
  blockDefPlaceholder,
  getDef,
  matchBlocks,
  MD_SHORTCUTS,
  TEXT_BLOCKS,
  type BlockDef,
} from "./blocks";
import { SlashMenu, type SlashMenuAnchor } from "./SlashMenu";
import { BlockHandle } from "./BlockHandle";
import { BlockIcon } from "./BlockIcon";
import { getLastEditorColor, rememberEditorColor } from "./colorMemory";
import { dateMentionLabel, nextDateMentionRefreshDelay } from "./dateMentions";
import type { EditorOps } from "./Editor";
import {
  parseInternalPastedBlocks,
  parseMarkdownTableRows,
  parsePastedHtml,
  parsePastedMarkdown,
  type PastedBlock,
} from "./markdownPaste";
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
type MentionTrigger = "mention" | "page_link";
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
const DATABASE_SOURCE_MENU_WIDTH = 360;
const DATABASE_SOURCE_MENU_HEIGHT = 430;

// User-facing copy for this file now lives in the react-i18next catalogs at
// locales/<lang>/blockItem.json (English is the source). This resolver reads
// the active-language strings through i18next.t at call time so non-hook
// helpers and render code can share one shape.
function blockItemText(key: string, values?: Record<string, unknown>) {
  return i18next.t(`blockItem:${key}`, values);
}

function blockTypeLabel(type: BlockType) {
  return blockDefLabel(getDef(type));
}

function blockTypePlaceholder(type: BlockType) {
  return blockDefPlaceholder(getDef(type));
}

function blockItemLabels() {
  const t = i18next.t;
  return {
    addView: t("blockItem:addView"),
    cantCopyBlockHere: t("blockItem:cantCopyBlockHere"),
    cantMoveBlockHere: t("blockItem:cantMoveBlockHere"),
    copiedBlocks: (count: number) =>
      count === 1 ? t("blockItem:copiedBlock") : t("blockItem:copiedBlocks", { count }),
    copyViewLink: t("blockItem:copyViewLink"),
    couldntCut: t("blockItem:couldntCut"),
    cutBlocks: (count: number) =>
      count === 1 ? t("blockItem:cutBlock") : t("blockItem:cutBlocks", { count }),
    dateDisplayLocale: activeDateLocale(),
    databaseNotReady: t("blockItem:databaseNotReady"),
    databaseTitleHidden: t("blockItem:databaseTitleHidden"),
    deletedBlocks: (count: number) =>
      count === 1 ? t("blockItem:deletedBlock") : t("blockItem:deletedBlocks", { count }),
    duplicatedBlocks: (count: number) =>
      count === 1
        ? t("blockItem:duplicatedBlock")
        : t("blockItem:duplicatedBlocks", { count }),
    duplicateView: t("blockItem:duplicateView"),
    editIcon: t("blockItem:editIcon"),
    editLayout: t("blockItem:editLayout"),
    editTitle: t("blockItem:editTitle"),
    emptyTogglePrompt: t("blockItem:emptyTogglePrompt"),
    groupDate: t("blockItem:groupDate"),
    groupLinkToPage: t("blockItem:groupLinkToPage"),
    groupNewPage: t("blockItem:groupNewPage"),
    groupPeople: t("blockItem:groupPeople"),
    hideTitle: t("blockItem:hideTitle"),
    manageInCalendar: t("blockItem:manageInCalendar"),
    mentionToday: t("blockItem:mentionToday"),
    mentionTomorrow: t("blockItem:mentionTomorrow"),
    mentionYesterday: t("blockItem:mentionYesterday"),
    movedBlocks: (count: number) =>
      count === 1 ? t("blockItem:movedBlock") : t("blockItem:movedBlocks", { count }),
    nothingToUndo: t("blockItem:nothingToUndo"),
    openDatabase: (dbTitle: string) => t("blockItem:openDatabase", { title: dbTitle }),
    restoredBlocks: (count: number) =>
      count === 1 ? t("blockItem:restoredBlock") : t("blockItem:restoredBlocks", { count }),
    undidCopy: t("blockItem:undidCopy"),
    undidDuplicate: t("blockItem:undidDuplicate"),
    undidMove: t("blockItem:undidMove"),
    undo: t("blockItem:undo"),
    uploadComplete: t("blockItem:uploadComplete"),
    uploadedFiles: (count: number) =>
      count === 1 ? t("blockItem:uploadedFile") : t("blockItem:uploadedFiles", { count }),
    uploadFailed: (fileName: string) =>
      fileName
        ? t("blockItem:uploadFailed", { fileName })
        : t("blockItem:uploadFailedUnknown"),
    uploadFileTooLarge: t("blockItem:uploadFileTooLarge"),
    uploadUnsafeFileType: t("blockItem:uploadUnsafeFileType"),
    uploadFinalizing: t("blockItem:uploadFinalizing"),
    uploadingFile: (fileName: string) => t("blockItem:uploadingFile", { fileName }),
    uploadPreparing: t("blockItem:uploadPreparing"),
    uploadUploading: t("blockItem:uploadUploading"),
    viewDataSource: t("blockItem:viewDataSource"),
  };
}

const BlockFrameActionsContext = createContext<BlockFrameActions | null>(null);
const DATABASE_SOURCE_MENU_GAP = 24;
const PASTED_URL_MENU_WIDTH = 280;
const PASTED_URL_MENU_HEIGHT = 220;
const MENU_VIEWPORT_MARGIN = 8;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
type DatabaseBlockKind = Extract<BlockType, "child_database" | "inline_database">;
type DatabaseSourcePickerRequest = {
  anchor?: SlashMenuAnchor;
  type: DatabaseBlockKind;
  viewType?: BlockDef["databaseView"];
};

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

type MentionState = {
  open: boolean;
  query: string;
  anchor?: SlashMenuAnchor;
  trigger?: MentionTrigger;
};
type MentionItem =
  | {
      kind: "date";
      id: string;
      label: string;
      description: string;
      icon: string;
      date: string;
    }
  | {
      kind: "person";
      id: string;
      label: string;
      description: string;
      icon: string;
      userId: string;
    }
  | {
      kind: "page";
      id: string;
      label: string;
      description: string;
      icon: string;
      pageId: string;
    }
  | {
      kind: "create_page";
      id: string;
      label: string;
      description: string;
      icon: string;
      title: string;
    };

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

function belowAnchorMenuPosition(
  anchor: InlineMenuAnchor,
  width: number,
  height: number,
  gap = 8
) {
  const availableWidth = Math.max(0, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
  const menuWidth = Math.min(width, availableWidth);
  const belowTop = anchor.bottom + gap;
  const viewportBottom = window.innerHeight - MENU_VIEWPORT_MARGIN;
  const availableBelow = Math.max(0, viewportBottom - belowTop);
  const maxHeight = Math.max(
    96,
    Math.min(height, availableBelow || height, Math.max(0, window.innerHeight - MENU_VIEWPORT_MARGIN * 2))
  );

  return {
    left: Math.max(
      MENU_VIEWPORT_MARGIN,
      Math.min(anchor.left, window.innerWidth - menuWidth - MENU_VIEWPORT_MARGIN)
    ),
    maxHeight,
    top:
      availableBelow >= 96
        ? belowTop
        : Math.max(MENU_VIEWPORT_MARGIN, Math.min(belowTop, viewportBottom - maxHeight)),
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

function shortcutBlockType(e: ReactKeyboardEvent<HTMLElement>): BlockType | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  const digit = e.code.startsWith("Digit") ? e.code.slice("Digit".length) : key;
  const hasTypeShortcutModifier = e.altKey || (e.ctrlKey && !e.metaKey && e.shiftKey);
  if (hasTypeShortcutModifier) {
    if (digit === "0") return "paragraph";
    if (digit === "1") return "heading_1";
    if (digit === "2") return "heading_2";
    if (digit === "3") return "heading_3";
    if (digit === "4") return "to_do";
    if (digit === "5") return "bulleted_list_item";
    if (digit === "6") return "numbered_list_item";
    if (digit === "7") return "toggle";
    if (digit === "8") return "code";
    if (digit === "9") return "child_page";
  }
  return null;
}

function printableTextKey(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.metaKey || e.ctrlKey || e.altKey) return "";
  if (e.key.length !== 1) return "";
  if (e.key === " ") return "";
  return e.key;
}

type BlockTextMark = "bold" | "italic" | "underline" | "strikethrough" | "code";

function shortcutTextMark(e: ReactKeyboardEvent<HTMLElement>): BlockTextMark | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    if (key === "s" || key === "x") return "strikethrough";
    return null;
  }
  if (key === "b") return "bold";
  if (key === "i") return "italic";
  if (key === "u") return "underline";
  if (key === "e") return "code";
  return null;
}

type InlineMarkdownMark = "bold" | "italic" | "strikethrough" | "code";

const TYPED_MARKDOWN_BLOCK_TYPES: Set<BlockType> = new Set([
  "image",
  "video",
  "audio",
  "embed",
  "file",
  "bookmark",
  "divider",
  "equation",
]);

const INLINE_MARKDOWN_SHORTCUTS: {
  open: string;
  close: string;
  mark: InlineMarkdownMark;
}[] = [
  { open: "**", close: "**", mark: "bold" },
  { open: "__", close: "__", mark: "bold" },
  { open: "~~", close: "~~", mark: "strikethrough" },
  { open: "`", close: "`", mark: "code" },
  { open: "~", close: "~", mark: "strikethrough" },
  { open: "*", close: "*", mark: "italic" },
  { open: "_", close: "_", mark: "italic" },
];

const INLINE_SYMBOL_SHORTCUTS = [
  { trigger: "->", replacement: "→" },
  { trigger: "<-", replacement: "←" },
] as const;

function weekdayLabels() {
  const formatter = new Intl.DateTimeFormat(activeDateLocale(), { weekday: "narrow" });
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(2024, 0, 7 + index))
  );
}

function findInlineSymbolShortcut(textBeforeCaret: string) {
  for (const shortcut of INLINE_SYMBOL_SHORTCUTS) {
    if (!textBeforeCaret.endsWith(shortcut.trigger)) continue;
    const start = textBeforeCaret.length - shortcut.trigger.length;
    if (isEscaped(textBeforeCaret, start)) continue;
    if (hasOpenInlineCodeDelimiter(textBeforeCaret, start)) continue;
    return { ...shortcut, start };
  }
  return null;
}

function inlineSymbolReplacementSpan(spans: TextSpan[], text: string): TextSpan {
  const source = [...spans].reverse().find((span) => span.text.length > 0);
  if (!source) return { text };
  const next: TextSpan = { text };
  if (source.bold) next.bold = true;
  if (source.italic) next.italic = true;
  if (source.underline) next.underline = true;
  if (source.strikethrough) next.strikethrough = true;
  if (source.code) next.code = true;
  if (source.color) next.color = source.color;
  return next;
}

function findInlineMarkdownShortcut(textBeforeCaret: string) {
  for (const shortcut of INLINE_MARKDOWN_SHORTCUTS) {
    if (!textBeforeCaret.endsWith(shortcut.close)) continue;
    const innerEnd = textBeforeCaret.length - shortcut.close.length;
    if (isEscaped(textBeforeCaret, innerEnd)) continue;
    const start = textBeforeCaret.lastIndexOf(shortcut.open, innerEnd - 1);
    if (start < 0) continue;
    if (isEscaped(textBeforeCaret, start)) continue;
    if (
      shortcut.open === "~" &&
      (textBeforeCaret[start - 1] === "~" || textBeforeCaret[start + 1] === "~")
    ) continue;
    const beforeOpen = textBeforeCaret[start - 1] ?? "";
    if (beforeOpen && /[\p{L}\p{N}_]/u.test(beforeOpen)) continue;
    const innerStart = start + shortcut.open.length;
    if (innerStart >= innerEnd) continue;
    const inner = textBeforeCaret.slice(innerStart, innerEnd);
    if (!inner.trim() || /^\s|\s$/.test(inner)) continue;
    return {
      ...shortcut,
      start,
      innerLength: inner.length,
    };
  }
  return null;
}

function clearNativeInlineTypingState(mark: InlineMarkdownMark) {
  const command =
    mark === "bold"
      ? "bold"
      : mark === "italic"
        ? "italic"
        : mark === "strikethrough"
          ? "strikeThrough"
          : null;
  if (!command || typeof document === "undefined") return;
  try {
    if (document.queryCommandState(command)) document.execCommand(command, false);
  } catch {
    // Some browsers restrict queryCommandState/execCommand in synthetic tests.
  }
}

function isEscaped(text: string, index: number) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function hasOpenInlineCodeDelimiter(text: string, beforeIndex: number) {
  let open = false;
  for (let i = 0; i < beforeIndex; i++) {
    if (text[i] !== "`" || isEscaped(text, i)) continue;
    open = !open;
  }
  return open;
}

function findUnescapedReverse(text: string, needle: string, from: number) {
  for (
    let index = Math.min(from, text.length - 1);
    index >= 0;
    index = text.lastIndexOf(needle, index - 1)
  ) {
    if (text[index] === needle && !isEscaped(text, index)) return index;
  }
  return -1;
}

function unescapeMarkdownLinkLabelSpans(spans: TextSpan[]) {
  const unescape = (text: string) => {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\" && /[\\`*_~\[\]]/.test(text[i + 1] ?? "")) {
        out += text[i + 1];
        i++;
      } else {
        out += text[i];
      }
    }
    return out;
  };
  return spans.map((span) => ({
    ...span,
    text: unescape(span.text),
  }));
}

function findInlineMarkdownLinkShortcut(textBeforeCaret: string) {
  if (!textBeforeCaret.endsWith(")")) return null;
  const closeLabel = findUnescapedReverse(textBeforeCaret, "]", textBeforeCaret.length - 2);
  if (closeLabel < 0 || textBeforeCaret[closeLabel + 1] !== "(") return null;
  const linkMarker = closeLabel;
  const start = findUnescapedReverse(textBeforeCaret, "[", linkMarker - 1);
  if (start < 0) return null;
  const beforeOpen = textBeforeCaret[start - 1] ?? "";
  if (beforeOpen && /[\p{L}\p{N}_]/u.test(beforeOpen)) return null;

  const label = textBeforeCaret.slice(start + 1, linkMarker);
  const rawUrl = textBeforeCaret.slice(linkMarker + 2, -1);
  if (!label.trim() || /^\s|\s$/.test(label)) return null;

  const url = normalizePastedLink(rawUrl);
  if (!url) return null;
  return {
    start,
    labelLength: label.length,
    rawUrlLength: rawUrl.length,
    url,
  };
}

function findTypedAutoLinkShortcut(textBeforeCaret: string) {
  const match = textBeforeCaret.match(/(\S+)(\s+)$/u);
  if (!match) return null;
  const token = match[1] ?? "";
  const whitespace = match[2] ?? "";
  if (!token || !whitespace) return null;

  const urlText = token.replace(/[.,;:!?]+$/u, "");
  if (!urlText) return null;
  const url = normalizePastedLink(urlText);
  if (!url) return null;
  return {
    start: textBeforeCaret.length - token.length - whitespace.length,
    urlLength: urlText.length,
    trailingLength: token.length - urlText.length + whitespace.length,
    url,
  };
}

function typedMarkdownBlockFromText(text: string): PastedBlock | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed !== text || trimmed.includes("\n")) return null;
  if (trimmed === "```") {
    return {
      type: "code",
      content: { rich: [] },
      plainText: "",
    };
  }
  const parsed = parsePastedMarkdown(trimmed);
  if (parsed.length !== 1) return null;
  const [block] = parsed;
  if (!block || !TYPED_MARKDOWN_BLOCK_TYPES.has(block.type)) return null;
  if (block.children?.length) return null;
  if (block.type === "equation" && !block.content?.expression?.trim()) return null;
  return block;
}

function isStructuredHtmlPaste(blocks: PastedBlock[]) {
  return (
    blocks.length > 1 ||
    blocks.some(
      (item) =>
        item.type !== "paragraph" ||
        (item.children?.length ?? 0) > 0 ||
        item.content?.rich?.some((span) => span.mention === "page")
    )
  );
}

function isSingleRichParagraphHtmlPaste(blocks: PastedBlock[]) {
  if (blocks.length !== 1) return false;
  const [block] = blocks;
  if (!block || block.type !== "paragraph" || (block.children?.length ?? 0) > 0) return false;
  return (block.content?.rich ?? []).some(
    (span) =>
      !!(
        span.bold ||
        span.italic ||
        span.underline ||
        span.strikethrough ||
        span.code ||
        span.color ||
        span.link ||
        span.commentId ||
        span.mention ||
        span.pageId ||
        span.date ||
        span.userId ||
        span.iconUrl
      )
  );
}

function normalizePastedLink(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return "";
  let candidate = trimmed;
  const bareDomain = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;
  const localhost = /^localhost(?::\d+)?(?:[/?#].*)?$/i;
  if (bareDomain.test(candidate) || localhost.test(candidate)) {
    candidate = `https://${candidate}`;
  } else if (!/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(candidate)) {
    return "";
  }
  return safeUrl(candidate);
}

function isExternalPastedWebUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Text carried by a pasted block, as spans — null when it has none. */
function pastedBlockTextSpans(pasted: PastedBlock): TextSpan[] | null {
  const rich = pasted.content?.rich;
  if (Array.isArray(rich) && spansToPlainText(rich).length > 0) return rich;
  const text = pasted.plainText ?? "";
  if (text) return [{ text }];
  return null;
}

function pastedUrlFallbackTitle(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "") || url;
  } catch {
    return url;
  }
}

type PastedUrlConversion =
  | "external_mention"
  | "page_mention"
  | "page_link"
  | "bookmark"
  | "embed"
  | "image"
  | "video"
  | "audio"
  | "file";

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

function blockTypeForPastedAssetUrl(url: string): Extract<PastedUrlConversion, "image" | "video" | "audio" | "file"> | null {
  const lower = url.trim().toLowerCase();
  let pathname = lower;
  try {
    pathname = new URL(url, "https://hanji.local").pathname.toLowerCase();
  } catch {
    /* keep the lower-cased input */
  }

  if (/\.(?:apng|avif|gif|jpe?g|png|svg|webp)$/i.test(pathname)) return "image";
  if (streamingVideoEmbed(url) || /\.(?:m4v|mov|mp4|ogv|webm)$/i.test(pathname)) return "video";
  if (/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/i.test(pathname)) return "audio";
  if (
    /\.(?:7z|csv|docx?|gz|key|md|numbers|odp|ods|odt|pages|pdf|pptx?|rar|rtf|tar|tsv|txt|xlsx?|xml|yaml|yml|zip)$/i.test(
      pathname
    )
  ) {
    return "file";
  }
  return null;
}

function focusEquationInput(blockId: string) {
  focusBlockControlSettled(blockId, `textarea[data-equation-input="${blockId}"]`);
}

function clampImageWidth(value: number) {
  return Math.max(20, Math.min(100, Math.round(value)));
}

/**
 * Convert a common provider share/watch URL into its embeddable iframe URL.
 * Returns null when the URL isn't a recognized provider (caller falls back to
 * the raw URL for already-embeddable links).
 */
function providerEmbedUrl(raw: string): string | null {
  const safe = safeUrl(raw.trim());
  if (!safe || !/^https?:/i.test(safe)) return null;
  let u: URL;
  try {
    u = new URL(safe);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  // YouTube
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    if (id) return `https://www.youtube.com/embed/${id}`;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (u.pathname.startsWith("/embed/")) return safe;
    if (u.pathname.startsWith("/shorts/")) {
      const id = u.pathname.split("/")[2];
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
  }

  // Vimeo
  if (host === "vimeo.com") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
  }
  if (host === "player.vimeo.com") return safe;

  // Loom
  if (host === "loom.com") {
    const id = u.pathname.replace(/^\/(share|embed)\//, "").split("/")[0];
    if (id) return `https://www.loom.com/embed/${id}`;
  }

  // Google Maps
  if (host === "google.com" || host === "maps.google.com") {
    if (u.pathname.startsWith("/maps")) {
      if (u.pathname.includes("/embed")) return safe;
      return `https://maps.google.com/maps?q=${encodeURIComponent(
        u.searchParams.get("q") ?? u.pathname
      )}&output=embed`;
    }
  }

  // SoundCloud (audio) — uses its player widget.
  if (host === "soundcloud.com") {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(safe)}`;
  }

  // Figma / CodePen / Twitter use embed wrappers; pass through their embed forms.
  if (host === "figma.com" && u.pathname.startsWith("/embed")) return safe;
  if (host === "codepen.io" && u.pathname.includes("/embed/")) return safe;

  return null;
}

/** Streaming providers whose video can't play in a native <video> element. */
function streamingVideoEmbed(raw: string): string | null {
  const embed = providerEmbedUrl(raw);
  if (!embed) return null;
  return /youtube\.com\/embed|player\.vimeo\.com|loom\.com\/embed/.test(embed)
    ? embed
    : null;
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

function localIsoDate(offsetDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return localIsoDateFromDate(date);
}

function localDateForOffset(offsetDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date;
}

function localIsoDateFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalIsoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function monthStartForDate(value: string) {
  const date = parseLocalIsoDate(value) ?? new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return localIsoDateFromDate(date);
}

function shiftMonth(monthValue: string, offset: number) {
  const month = parseLocalIsoDate(monthValue) ?? new Date();
  const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
  return localIsoDateFromDate(next);
}

function shiftDateByDays(value: string, offset: number) {
  const date = parseLocalIsoDate(value) ?? parseLocalIsoDate(localIsoDate(0)) ?? new Date();
  date.setDate(date.getDate() + offset);
  return localIsoDateFromDate(date);
}

function shiftDateByMonths(value: string, offset: number) {
  const date = parseLocalIsoDate(value) ?? parseLocalIsoDate(localIsoDate(0)) ?? new Date();
  const day = date.getDate();
  const next = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, maxDay));
  return localIsoDateFromDate(next);
}

function weekEdgeDate(value: string, edge: "start" | "end") {
  const date = parseLocalIsoDate(value) ?? parseLocalIsoDate(localIsoDate(0)) ?? new Date();
  const offset = edge === "start" ? -date.getDay() : 6 - date.getDay();
  date.setDate(date.getDate() + offset);
  return localIsoDateFromDate(date);
}

function mentionCalendar(monthValue: string, selectedValue: string) {
  const month = parseLocalIsoDate(monthValue) ?? parseLocalIsoDate(monthStartForDate(selectedValue)) ?? new Date();
  const selected = parseLocalIsoDate(selectedValue);
  const today = localIsoDate(0);
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const firstVisible = new Date(monthStart);
  firstVisible.setDate(1 - monthStart.getDay());
  const label = monthStart.toLocaleDateString(activeDateLocale(), {
    month: "long",
    year: "numeric",
  });
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstVisible);
    date.setDate(firstVisible.getDate() + index);
    const iso = localIsoDateFromDate(date);
    return {
      iso,
      day: date.getDate(),
      outside: date.getMonth() !== monthStart.getMonth(),
      selected: !!selected && iso === selectedValue,
      today: iso === today,
    };
  });
  return { label, days };
}

// Memoized: the Editor re-renders on every keystroke (the page's block array
// is replaced), but sibling blocks receive the same `block` reference and the
// same memoized `ops` facade, so only the edited block actually re-renders.
// Every prop here must stay referentially stable across unrelated renders —
// see the ops facade in Editor.tsx.
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

function pageTitle(page: Page) {
  return pageDisplayTitle(page);
}

function pageIcon(page: Page, fallback = "P") {
  return pageIconText(page, fallback);
}

function isDatabaseSourcePage(page: Page) {
  const properties = page.properties ?? {};
  const linkedDatabaseTitle = linkedDatabaseResolvedTitle(page);
  return (
    page.kind === "database" &&
    page.parentType !== "database" &&
    !page.inTrash &&
    !linkedDatabaseTitle &&
    properties.notionLinkedDatabaseSourceUnavailable !== true
  );
}

function databaseSourceDescription(page: Page) {
  const properties = page.properties ?? {};
  return typeof properties.notionDatabaseId === "string" ||
    typeof properties.notionDataSourceId === "string"
    ? blockItemText("database.imported")
    : blockItemText("database.label");
}

function mentionSearchRank(label: string, description: string, query: string) {
  if (!query) return 0;
  const normalizedLabel = label.toLowerCase();
  const haystack = `${normalizedLabel} ${description.toLowerCase()}`;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (normalizedLabel === query) return 0;
  if (normalizedLabel.startsWith(query)) return 1;
  if (normalizedLabel.includes(query)) return 2;
  if (haystack.includes(query)) return 3;
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return 4;
  return Number.POSITIVE_INFINITY;
}

function mentionDateDescription(offsetDays: number) {
  const date = localDateForOffset(offsetDays);
  return new Intl.DateTimeFormat(blockItemLabels().dateDisplayLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function mentionDateRank(
  item: MentionItem & { kind: "date" },
  aliases: string[],
  query: string,
  index: number
) {
  if (!query) return index;
  return Math.min(
    mentionSearchRank(item.label, item.description, query),
    ...aliases.map((alias) => mentionSearchRank(alias, item.description, query))
  );
}

function organizationProfileMentionLabel(profile: OrganizationProfile) {
  return profile.displayName?.trim() || profile.email?.trim() || profile.userId?.trim() || blockItemText("person.label");
}

function organizationProfileMentionDescription(profile: OrganizationProfile) {
  const parts = [
    profile.email?.trim(),
    profile.organizationRole
      ? blockItemText("person.roleInOrganization", { role: profile.organizationRole })
      : null,
    profile.status && profile.status !== "active" ? profile.status : null,
  ].filter(Boolean);
  return parts.join(" - ") || blockItemText("person.organizationMember");
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

function normalizeSimpleTable(table?: string[][]) {
  const source = Array.isArray(table) && table.length > 0 ? table : [["", ""], ["", ""]];
  const rowCount = Math.max(2, source.length);
  const colCount = Math.max(2, ...source.map((row) => (Array.isArray(row) ? row.length : 0)));
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: colCount }, (_, colIndex) => source[rowIndex]?.[colIndex] ?? "")
  );
}

function simpleTablePlainText(table: string[][]) {
  return table.map((row) => row.join("\t")).join("\n");
}

type SimpleTableMove = "previous" | "next" | "left" | "right" | "up" | "down";

function parsePastedTable(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const markdownTable = parseMarkdownTableRows(normalized);
  if (markdownTable) return markdownTable;
  if (!normalized.includes("\t") && !normalized.includes("\n")) return null;
  const rows = normalized.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const table = rows.map((row) => row.split("\t"));
  return table.some((row) => row.some((cell) => cell.length > 0)) ? table : null;
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
  const updateBlock = useStore((s) => s.updateBlock);
  const table = normalizeSimpleTable(block.content?.table);
  const headerRow = block.content?.headerRow ?? true;
  const headerColumn = !!block.content?.headerColumn;

  function commitTable(
    nextTable: string[][],
    opts?: { debounce?: boolean; history?: "merge" | false }
  ) {
    updateBlock(
      block.id,
      {
        content: { ...block.content, table: nextTable },
        plainText: simpleTablePlainText(nextTable),
      },
      opts
    );
  }

  function setCell(rowIndex: number, colIndex: number, value: string) {
    const next = table.map((row) => row.slice());
    next[rowIndex][colIndex] = value;
    commitTable(next, { debounce: true, history: "merge" });
  }

  function addRow(focus = false) {
    const next = [...table, Array.from({ length: table[0]?.length ?? 2 }, () => "")];
    commitTable(next);
    if (focus) focusCell(next.length - 1, 0);
  }

  function addColumn(focus = false) {
    const nextColIndex = table[0]?.length ?? 0;
    commitTable(table.map((row) => [...row, ""]));
    if (focus) focusCell(0, nextColIndex);
  }

  function deleteRow() {
    if (table.length <= 2) return; // keep the 2x2 minimum
    commitTable(table.slice(0, -1));
  }

  function deleteColumn() {
    if ((table[0]?.length ?? 0) <= 2) return; // keep the 2x2 minimum
    commitTable(table.map((row) => row.slice(0, -1)));
  }

  function toggleHeader(key: "headerRow" | "headerColumn") {
    updateBlock(block.id, {
      content: { ...block.content, table, [key]: !block.content?.[key] },
      plainText: simpleTablePlainText(table),
    });
  }

  function focusCell(rowIndex: number, colIndex: number) {
    requestAnimationFrame(() => {
      const selector = `[data-table-cell="${block.id}:${rowIndex}:${colIndex}"]`;
      const cell = document.querySelector<HTMLElement>(selector);
      cell?.focus();
      if (cell) placeCaret(cell, "end");
    });
  }

  function moveCell(rowIndex: number, colIndex: number, move: SimpleTableMove) {
    const colCount = table[0]?.length ?? 0;
    const rowCount = table.length;
    if (move === "previous" || move === "next") {
      const offset = rowIndex * colCount + colIndex + (move === "previous" ? -1 : 1);
      if (offset < 0) return;
      if (offset >= rowCount * colCount) {
        addRow(true);
        return;
      }
      focusCell(Math.floor(offset / colCount), offset % colCount);
    } else if (move === "left" && colIndex > 0) {
      focusCell(rowIndex, colIndex - 1);
    } else if (move === "right" && colIndex < colCount - 1) {
      focusCell(rowIndex, colIndex + 1);
    } else if (move === "up" && rowIndex > 0) {
      focusCell(rowIndex - 1, colIndex);
    } else if (move === "down" && rowIndex < rowCount - 1) {
      focusCell(rowIndex + 1, colIndex);
    }
  }

  function pasteTableAt(rowIndex: number, colIndex: number, text: string) {
    const pasted = parsePastedTable(text);
    if (!pasted) return false;

    const rowCount = Math.max(table.length, rowIndex + pasted.length, 2);
    const colCount = Math.max(
      table[0]?.length ?? 0,
      colIndex + Math.max(...pasted.map((row) => row.length)),
      2
    );
    const next = Array.from({ length: rowCount }, (_, r) =>
      Array.from({ length: colCount }, (_, c) => table[r]?.[c] ?? "")
    );

    pasted.forEach((row, pastedRow) => {
      row.forEach((cell, pastedCol) => {
        next[rowIndex + pastedRow][colIndex + pastedCol] = cell;
      });
    });

    commitTable(next);
    focusCell(rowIndex + pasted.length - 1, colIndex + pasted[pasted.length - 1].length - 1);
    return true;
  }

  return (
    <BlockFrame block={block} ops={ops} depth={depth}>
      <div className={styles.simpleTableWrap} contentEditable={false}>
        <div
          className={styles.simpleTableScroller}
          role="region"
          aria-label={blockItemText("simpleTable.label")}
        >
          <div className={styles.simpleTableCanvas}>
            <table
              className={styles.simpleTable}
              aria-label={blockItemText("simpleTable.dimensions", {
                rows: table.length,
                columns: table[0]?.length ?? 0,
              })}
            >
              <tbody>
                {table.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, colIndex) => {
                      const isHeader =
                        (headerRow && rowIndex === 0) || (headerColumn && colIndex === 0);
                      const CellTag = isHeader ? "th" : "td";
                      return (
                        <CellTag
                          key={`${rowIndex}-${colIndex}`}
                          data-header={isHeader ? "true" : undefined}
                          scope={
                            isHeader
                              ? rowIndex === 0
                                ? "col"
                                : "row"
                              : undefined
                          }
                        >
                          <SimpleTableCell
                            id={`${block.id}:${rowIndex}:${colIndex}`}
                            value={cell}
                            placeholder={
                              rowIndex === 0 && colIndex === 0
                                ? blockItemText("simpleTable.typeSomething")
                                : ""
                            }
                            readOnly={ops.readOnly}
                            onInput={(value) => setCell(rowIndex, colIndex, value)}
                            onMove={(move) => moveCell(rowIndex, colIndex, move)}
                            onPaste={(text) => pasteTableAt(rowIndex, colIndex, text)}
                            onSelectBlock={() => ops.selectBlock(block.id)}
                          />
                        </CellTag>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {!ops.readOnly && (
              <>
                <button
                  type="button"
                  className={styles.simpleTableAddColumn}
                  aria-label={blockItemText("simpleTable.addColumn")}
                  title={blockItemText("columns.add")}
                  onClick={() => addColumn(true)}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.simpleTableAddRow}
                  aria-label={blockItemText("simpleTable.addRow")}
                  title={blockItemText("simpleTable.addRowShort")}
                  onClick={() => addRow(true)}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>
        {!ops.readOnly && (
          <div
            className={styles.simpleTableTools}
            aria-label={blockItemText("simpleTable.actions")}
          >
            <button
              type="button"
              aria-label={blockItemText("simpleTable.removeLastRow")}
              title={blockItemText("simpleTable.removeLastRowShort")}
              disabled={table.length <= 2}
              onClick={deleteRow}
            >
              <Trash size={14} aria-hidden="true" />
              <span className={styles.simpleTableToolGlyph} data-kind="row" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={blockItemText("simpleTable.removeLastColumn")}
              title={blockItemText("simpleTable.removeLastColumnShort")}
              disabled={(table[0]?.length ?? 0) <= 2}
              onClick={deleteColumn}
            >
              <Trash size={14} aria-hidden="true" />
              <span className={styles.simpleTableToolGlyph} data-kind="column" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-active={headerRow ? "true" : undefined}
              aria-pressed={headerRow}
              aria-label={blockItemText("simpleTable.toggleHeaderRow")}
              title={blockItemText("simpleTable.headerRow")}
              onClick={() => toggleHeader("headerRow")}
            >
              <span className={styles.simpleTableHeaderGlyph} data-kind="row" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-active={headerColumn ? "true" : undefined}
              aria-pressed={headerColumn}
              aria-label={blockItemText("simpleTable.toggleHeaderColumn")}
              title={blockItemText("simpleTable.headerColumn")}
              onClick={() => toggleHeader("headerColumn")}
            >
              <span className={styles.simpleTableHeaderGlyph} data-kind="column" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </BlockFrame>
  );
}

function SimpleTableCell({
  id,
  value,
  placeholder,
  readOnly = false,
  onInput,
  onMove,
  onPaste,
  onSelectBlock,
}: {
  id: string;
  value: string;
  placeholder: string;
  readOnly?: boolean;
  onInput: (value: string) => void;
  onMove: (move: SimpleTableMove) => void;
  onPaste: (text: string) => boolean;
  onSelectBlock: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [, rowPart, columnPart] = id.split(":");
  const rowIndex = Number(rowPart);
  const columnIndex = Number(columnPart);
  const cellLabel =
    Number.isFinite(rowIndex) && Number.isFinite(columnIndex)
      ? blockItemText("simpleTable.cellNumbered", {
          row: rowIndex + 1,
          column: columnIndex + 1,
        })
      : blockItemText("simpleTable.cell");

  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    if ((el.textContent ?? "") !== value) el.textContent = value;
    el.dataset.empty = String(value.length === 0);
  }, [value]);

  function handleInput() {
    const el = ref.current;
    if (!el) return;
    const text = el.innerText.replace(/\n+$/g, "");
    el.dataset.empty = String(text.length === 0);
    onInput(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if ((el.textContent?.length ?? 0) === 0 || isEditableFullySelected(el)) {
        window.getSelection()?.removeAllRanges();
        el.blur();
        onSelectBlock();
      } else {
        selectEditableContents(el);
      }
    } else if (e.key === "Escape" && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
      onSelectBlock();
    } else if (e.key === "Tab") {
      e.preventDefault();
      onMove(e.shiftKey ? "previous" : "next");
    } else if (e.key === "ArrowLeft" && isCaretAtStart(el)) {
      e.preventDefault();
      onMove("left");
    } else if (e.key === "ArrowRight" && isCaretAtEnd(el)) {
      e.preventDefault();
      onMove("right");
    } else if (e.key === "ArrowUp" && isCaretAtStart(el)) {
      e.preventDefault();
      onMove("up");
    } else if (e.key === "ArrowDown" && isCaretAtEnd(el)) {
      e.preventDefault();
      onMove("down");
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const text = e.clipboardData.getData("text/plain");
    if (!text || !onPaste(text)) return;
    e.preventDefault();
  }

  return (
    <div
      ref={ref}
      className={styles.simpleTableCell}
      contentEditable={!readOnly}
      role="textbox"
      tabIndex={0}
      aria-label={cellLabel}
      aria-readonly={readOnly}
      aria-multiline="true"
      aria-placeholder={placeholder}
      suppressContentEditableWarning
      spellCheck
      data-table-cell={id}
      data-empty={value.length === 0}
      data-placeholder={placeholder}
      onInput={readOnly ? undefined : handleInput}
      onKeyDown={readOnly ? undefined : handleKeyDown}
      onPaste={readOnly ? undefined : handlePaste}
    />
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

function MentionMenu({
  anchor,
  query,
  mode = "mention",
  onPick,
  onClose,
}: {
  anchor?: SlashMenuAnchor;
  query: string;
  mode?: MentionTrigger;
  onPick: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState({ query: "", active: 0 });
  const pagesById = useStore((s) => s.pagesById);
  const userId = useStore((s) => s.userId);
  const organization = useStore((s) => s.organization);
  const organizationProfiles = useStore((s) => s.organizationProfiles);
  const [searchedPeople, setSearchedPeople] = useState<{
    key: string;
    people: OrganizationProfile[];
  }>({ key: "", people: [] });
  const menuId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // Match the slash menu: after keyboard navigation, ignore stale mouseenter
  // events until the pointer actually moves.
  const pointerMoved = useRef(false);
  const menuStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!anchor || typeof window === "undefined") return undefined;
    const targetWidth = mode === "mention" ? 360 : 300;
    const width = Math.min(targetWidth, Math.max(0, window.innerWidth - MENU_VIEWPORT_MARGIN * 2));
    const maxHeight = Math.min(310, Math.max(0, window.innerHeight - MENU_VIEWPORT_MARGIN * 2));
    const margin = 8;
    const gap = 6;
    const belowTop = anchor.bottom + gap;
    const aboveTop = anchor.top - maxHeight - gap;
    const viewportBottom = window.innerHeight - margin;
    const top =
      mode === "mention" && aboveTop >= margin
        ? aboveTop
        : belowTop + maxHeight <= viewportBottom
        ? belowTop
        : aboveTop >= margin
          ? aboveTop
          : Math.max(margin, Math.min(belowTop, viewportBottom - maxHeight));
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    return {
      position: "fixed",
      top,
      left,
      width,
      maxHeight,
    };
  }, [anchor, mode]);

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (mode === "page_link" || !organization?.id || !q) {
      setSearchedPeople({ key: "", people: [] });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchOrganizationPeopleRemote({
        organizationId: organization.id,
        query: q,
        limit: 8,
      })
        .then((result) => {
          if (!cancelled) setSearchedPeople({ key: q, people: result.people ?? [] });
        })
        .catch(() => {
          if (!cancelled) setSearchedPeople({ key: q, people: [] });
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, organization?.id, q]);

  const results = useMemo(() => {
    const dateChoices: Array<{ item: MentionItem & { kind: "date" }; aliases: string[] }> = [
      {
        item: {
          kind: "date",
          id: "today",
          label: blockItemLabels().mentionToday,
          description: mentionDateDescription(0),
          icon: "@",
          date: localIsoDate(0),
        },
        aliases: ["today", "tod", "금일"],
      },
      {
        item: {
          kind: "date",
          id: "tomorrow",
          label: blockItemLabels().mentionTomorrow,
          description: mentionDateDescription(1),
          icon: "@",
          date: localIsoDate(1),
        },
        aliases: ["tomorrow", "tmr", "tom"],
      },
      {
        item: {
          kind: "date",
          id: "yesterday",
          label: blockItemLabels().mentionYesterday,
          description: mentionDateDescription(-1),
          icon: "@",
          date: localIsoDate(-1),
        },
        aliases: ["yesterday", "yday"],
      },
    ];
    const dates = mode === "page_link"
      ? []
      : dateChoices
          .map(({ item, aliases }, index) => ({
            item,
            index,
            rank: mentionDateRank(item, aliases, q, index),
          }))
          .filter((candidate) => Number.isFinite(candidate.rank))
          .sort((a, b) => a.rank - b.rank || a.index - b.index)
          .map((candidate) => candidate.item);
    const currentUserId = userId || "local-user";
    const currentUserLabel = personLabel(currentUserId, userId);
    const personItem: MentionItem = {
      kind: "person",
      id: `person:${currentUserId}`,
      label: currentUserLabel,
      description: blockItemText("person.label"),
      icon: currentUserLabel.slice(0, 1).toUpperCase(),
      userId: currentUserId,
    };
    const personRank = Math.min(
      mentionSearchRank(currentUserLabel, blockItemText("person.collaborator"), q),
      ["you", "나", "본인"].some((alias) => alias.includes(q)) ? 1 : Number.POSITIVE_INFINITY
    );
    const profileCandidates = new Map<string, OrganizationProfile>();
    const currentUserKey = currentUserId.trim();
    const searchPeople = searchedPeople.key === q ? searchedPeople.people : [];
    for (const profile of [...searchPeople, ...organizationProfiles]) {
      const profileUserId = profile.userId?.trim();
      if (!profileUserId || profileUserId === currentUserKey || profileCandidates.has(profileUserId)) continue;
      profileCandidates.set(profileUserId, profile);
    }
    const organizationPeople: MentionItem[] = Array.from(profileCandidates.values())
      .map((profile, index) => {
        const profileUserId = profile.userId?.trim() ?? "";
        const label = organizationProfileMentionLabel(profile);
        const description = organizationProfileMentionDescription(profile);
        return {
          item: {
            kind: "person" as const,
            id: `person:${profileUserId}`,
            label,
            description,
            icon: label.slice(0, 1).toUpperCase(),
            userId: profileUserId,
          },
          index,
          rank: mentionSearchRank(label, description, q),
        };
      })
      .filter((candidate) => Number.isFinite(candidate.rank))
      .sort((a, b) => a.rank - b.rank || a.item.label.localeCompare(b.item.label) || a.index - b.index)
      .map((candidate) => candidate.item)
      .slice(0, 8);
    const people: MentionItem[] =
      mode === "page_link"
        ? []
        : [...(Number.isFinite(personRank) ? [personItem] : []), ...organizationPeople];

    const allPages = mode === "page_link" ? Object.values(pagesById).filter((page) => !page.inTrash) : [];
    const pages =
      mode === "page_link"
        ? allPages
            .map((page, index) => {
              const label = pageTitle(page);
              const description = pagePathOrWorkspaceRoot(page, pagesById);
              return {
                item: {
                  kind: "page" as const,
                  id: `page:${page.id}`,
                  label,
                  description,
                  icon: pageIcon(page),
                  pageId: page.id,
                },
                index,
                rank: mentionSearchRank(label, description, q),
              };
            })
            .filter((candidate) => Number.isFinite(candidate.rank))
            .sort((a, b) => {
              if (a.rank !== b.rank) return a.rank - b.rank;
              return a.item.label.localeCompare(b.item.label) || a.index - b.index;
            })
            .map((candidate) => candidate.item)
            .slice(0, 12)
        : [];
    const exactPage = q
      ? allPages.some((page) => pageTitle(page).trim().toLowerCase() === q)
      : true;
    const createItem: MentionItem[] =
      mode === "page_link" && q && !exactPage
        ? [
            {
              kind: "create_page",
              id: `create:${q}`,
              label: blockItemText("mention.newPageNamed", { title: query.trim() }),
              description: blockItemText("mention.createPage"),
              icon: "+",
              title: query.trim(),
            },
          ]
        : [];

    return [...dates, ...people, ...createItem, ...pages];
  }, [mode, organizationProfiles, pagesById, q, query, searchedPeople, userId]);

  const activeIndex =
    results.length === 0
      ? -1
      : cursor.query === query
        ? Math.min(cursor.active, results.length - 1)
        : 0;
  const activeId = activeIndex >= 0 ? `${menuId}-item-${activeIndex}` : undefined;
  const emptyId = `${menuId}-empty`;
  const groupedResults = useMemo(() => {
    const groups: Array<{ label: string; items: Array<{ item: MentionItem; index: number }> }> = [];
    for (const [index, item] of results.entries()) {
      const label =
        item.kind === "date"
          ? blockItemLabels().groupDate
          : item.kind === "person"
            ? blockItemLabels().groupPeople
            : item.kind === "create_page"
              ? blockItemLabels().groupNewPage
              : blockItemLabels().groupLinkToPage;
      const group = groups.find((candidate) => candidate.label === label);
      if (group) group.items.push({ item, index });
      else groups.push({ label, items: [{ item, index }] });
    }
    return groups;
  }, [results]);
  const setActiveIndex = useCallback(
    (active: number) => setCursor({ query, active }),
    [query]
  );

  useEffect(() => {
    function onMove() {
      pointerMoved.current = true;
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isComposingKeyEvent(e)) return;

      if (results.length === 0) {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (
        ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)
      ) {
        pointerMoved.current = false;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((activeIndex + 1) % results.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex(activeIndex <= 0 ? results.length - 1 : activeIndex - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setActiveIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setActiveIndex(results.length - 1);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        setActiveIndex(Math.min(activeIndex + 5, results.length - 1));
      } else if (e.key === "PageUp") {
        e.preventDefault();
        setActiveIndex(Math.max(activeIndex - 5, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = results[activeIndex];
        if (item) onPick(item);
        else onClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [activeIndex, onClose, onPick, results, setActiveIndex]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const picker = (
    <>
      <button
        type="button"
        className={`${styles.menuBackdrop} ${styles.editorFloatingBackdrop}`}
        onClick={onClose}
        tabIndex={-1}
        aria-label={blockItemText(
          mode === "page_link" ? "mention.closePageLinkMenu" : "mention.closeMenu"
        )}
      />
      <div
        className={styles.mentionMenu}
        ref={listRef}
        style={menuStyle}
        role="listbox"
        tabIndex={-1}
        aria-label={blockItemText(mode === "page_link" ? "pageLink.linkToPage" : "mention.label")}
        aria-activedescendant={activeId}
        aria-describedby={results.length === 0 ? emptyId : undefined}
        onMouseDown={(e) => e.preventDefault()}
      >
        {mode === "page_link" ? (
          <div className={styles.slashLabel}>{blockItemLabels().groupLinkToPage}</div>
        ) : null}
        {results.length === 0 ? (
          <div id={emptyId} className={styles.slashEmpty} role="status">
            {query.trim()
              ? blockItemText("mention.noResultsFor", { query: query.trim() })
              : mode === "page_link"
                ? blockItemText("mention.noPages")
                : blockItemText("mention.noResults")}
          </div>
        ) : (
          groupedResults.map((group) => (
            <div key={group.label} className={styles.mentionSection}>
              <div className={styles.mentionSectionLabel} aria-hidden="true">
                {group.label}
              </div>
              {group.items.map(({ item, index }) => (
                <button
                  type="button"
                  key={item.id}
                  id={`${menuId}-item-${index}`}
                  className={styles.mentionItem}
                  data-active={index === activeIndex ? "true" : undefined}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => {
                    if (pointerMoved.current) setActiveIndex(index);
                  }}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => onPick(item)}
                >
                  <span className={styles.mentionGlyph} data-kind={item.kind} aria-hidden="true">
                    {item.kind === "date" ? (
                      <CalendarIcon size={15} />
                    ) : item.kind === "create_page" ? (
                      <Plus size={15} />
                    ) : (
                      item.icon
                    )}
                  </span>
                  <span className={styles.slashText}>
                    <span className={styles.slashName}>{item.label}</span>
                    <span className={styles.slashDesc}>{item.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );

  return typeof document === "undefined" ? picker : createPortal(picker, document.body);
}

function TextFloatingMenuPortal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? <>{children}</> : createPortal(children, document.body);
}

function DatabaseSourcePicker({
  anchor,
  type,
  onCreate,
  onLink,
  onClose,
}: {
  anchor?: SlashMenuAnchor;
  type: DatabaseBlockKind;
  viewType?: BlockDef["databaseView"];
  onCreate: () => void;
  onLink: (databaseId: string) => void;
  onClose: () => void;
}) {
  const pagesById = useStore((s) => s.pagesById);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const pointerMoved = useRef(false);
  const pickerId = useId();
  const listId = `${pickerId}-list`;
  const q = query.trim().toLowerCase();
  const placementLabel = blockItemText(
    type === "inline_database" ? "database.inlinePlacement" : "database.fullPagePlacement"
  );

  const results = useMemo(() => {
    return Object.values(pagesById)
      .filter(isDatabaseSourcePage)
      .map((page, index) => {
        const title = databaseDisplayTitle(page);
        const path = pagePath(page, pagesById);
        const description = databaseSourceDescription(page);
        const haystack = `${title} ${path} ${description}`.toLowerCase();
        let score = index + 10;
        if (q) {
          if (title.toLowerCase() === q) score = 0;
          else if (title.toLowerCase().startsWith(q)) score = 1;
          else if (title.toLowerCase().includes(q)) score = 2;
          else if (haystack.includes(q)) score = 3;
          else score = Number.POSITIVE_INFINITY;
        }
        return { page, title, description, score };
      })
      .filter((result) => result.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
      .slice(0, 12);
  }, [pagesById, q]);

  const itemCount = 1 + results.length;
  const active = Math.max(0, Math.min(activeIndex, itemCount - 1));
  const activeId = `${pickerId}-option-${active}`;
  const menuStyle = useMemo<CSSProperties | undefined>(() => {
    if (!anchor || typeof window === "undefined") return undefined;
    const width = Math.min(
      DATABASE_SOURCE_MENU_WIDTH,
      Math.max(0, window.innerWidth - MENU_VIEWPORT_MARGIN * 2)
    );
    const position = belowAnchorMenuPosition(
      anchor,
      DATABASE_SOURCE_MENU_WIDTH,
      DATABASE_SOURCE_MENU_HEIGHT,
      DATABASE_SOURCE_MENU_GAP
    );
    return {
      ...position,
      position: "fixed",
      width,
    };
  }, [anchor]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    setActiveIndex(q && results.length > 0 ? 1 : 0);
  }, [q, results.length]);

  useEffect(() => {
    function onMove() {
      pointerMoved.current = true;
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    resultsRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function setActive(next: number) {
    setActiveIndex((next + itemCount) % itemCount);
  }

  function choose(index = active) {
    if (index === 0) {
      onCreate();
      return;
    }
    const result = results[index - 1];
    if (result) onLink(result.page.id);
  }

  function chooseNewFromMouseDown(e: ReactMouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    choose(0);
  }

  function handlePickerKeyDown(e: React.KeyboardEvent<HTMLElement> | KeyboardEvent) {
    if (isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActive(active - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActiveIndex(itemCount - 1);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      choose();
    }
  }

  // Latest-ref pattern: the handler closes over per-render state (active row,
  // result list), but the document listener must attach exactly once instead
  // of detaching/re-attaching on every render.
  const handlePickerKeyDownRef = useRef(handlePickerKeyDown);
  useEffect(() => {
    handlePickerKeyDownRef.current = handlePickerKeyDown;
  });

  useEffect(() => {
    function onDocumentKeyDown(e: KeyboardEvent) {
      handlePickerKeyDownRef.current(e);
    }

    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => document.removeEventListener("keydown", onDocumentKeyDown, true);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    handlePickerKeyDown(e);
  }

  const picker = (
    <>
      <button
        type="button"
        className={`${styles.menuBackdrop} ${styles.editorFloatingBackdrop}`}
        onClick={onClose}
        tabIndex={-1}
        aria-label={blockItemText("databaseSource.closePicker")}
      />
      <div
        className={styles.databaseSourceMenu}
        style={menuStyle}
        role="dialog"
        aria-label={blockItemText("databaseSource.choose")}
        contentEditable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          id={`${pickerId}-option-0`}
          className={styles.databaseSourceItem}
          data-active={active === 0 ? "true" : undefined}
          data-database-source-action="new"
          onMouseEnter={() => {
            if (pointerMoved.current) setActiveIndex(0);
          }}
          onFocus={() => setActiveIndex(0)}
          onMouseDown={chooseNewFromMouseDown}
          onClick={() => choose(0)}
        >
          <span className={styles.databaseSourceIcon} aria-hidden="true">
            <Plus size={17} />
          </span>
          <span className={styles.databaseSourceText}>
            <span className={styles.databaseSourceTitle}>
              {blockItemText("databaseSource.newDatabase")}
            </span>
            <span className={styles.databaseSourcePath}>
              {blockItemText("databaseSource.createNew", { placement: placementLabel })}
            </span>
          </span>
        </button>
        <div className={styles.databaseSourceLabel}>
          {blockItemText("databaseSource.existingSources")}
        </div>
        <input
          ref={inputRef}
          className={styles.databaseSourceSearch}
          value={query}
          placeholder={blockItemText("databaseSource.searchPlaceholder")}
          aria-label={blockItemText("databaseSource.searchExisting")}
          aria-controls={listId}
          aria-activedescendant={activeId}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div
          id={listId}
          ref={resultsRef}
          className={styles.databaseSourceResults}
          role="listbox"
          tabIndex={-1}
          aria-label={blockItemText("databaseSource.existingDatabases")}
          aria-activedescendant={active > 0 ? activeId : undefined}
        >
          {results.length === 0 ? (
            <div className={styles.databaseSourceEmpty}>
              {blockItemText(q ? "databaseSource.noMatching" : "databaseSource.noneYet")}
            </div>
          ) : (
            results.map((result, index) => {
              const itemIndex = index + 1;
              return (
                <button
                  type="button"
                  key={result.page.id}
                  id={`${pickerId}-option-${itemIndex}`}
                  className={styles.databaseSourceItem}
                  role="option"
                  aria-selected={itemIndex === active}
                  data-active={itemIndex === active ? "true" : undefined}
                  data-database-source-action="existing"
                  data-database-source-kind="database"
                  onMouseEnter={() => {
                    if (pointerMoved.current) setActiveIndex(itemIndex);
                  }}
                  onFocus={() => setActiveIndex(itemIndex)}
                  onClick={() => choose(itemIndex)}
                >
                  <span
                    className={styles.databaseSourceIcon}
                    data-database-source-icon="database"
                    aria-hidden="true"
                  >
                    <Database size={15} />
                  </span>
                  <span className={styles.databaseSourceText}>
                    <span className={styles.databaseSourceTitle}>{result.title}</span>
                    <span className={styles.databaseSourcePath}>{result.description}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );

  return typeof document === "undefined" ? picker : createPortal(picker, document.body);
}

function TextBlock({
  block,
  ops,
  depth,
  pagePlaceholder,
  pagePlaceholderText,
  onPagePlaceholderInput,
}: {
  block: Block;
  ops: EditorOps;
  depth: number;
  pagePlaceholder: boolean;
  pagePlaceholderText?: string;
  onPagePlaceholderInput?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const composingEnterRef = useRef(false);
  const compositionEnterHandledRef = useRef(false);
  const compositionEnterShiftRef = useRef(false);
  const compositionEnterGuardUntilRef = useRef(0);
  const compositionEnterFrameRef = useRef<number | null>(null);
  const pendingCompositionParagraphInputRef = useRef<"insertParagraph" | "insertLineBreak" | null>(null);
  const lastCompositionTextRef = useRef("");
  const codeCaptionRef = useRef<HTMLDivElement>(null);
  const linkRangeRef = useRef<Range | null>(null);
  const dateRangeRef = useRef<Range | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const linkMenuRef = useRef<HTMLDivElement>(null);
  const dateMenuRef = useRef<HTMLDivElement>(null);
  const personMenuRef = useRef<HTMLDivElement>(null);
  const pageMenuRef = useRef<HTMLDivElement>(null);
  const pastedUrlMenuRef = useRef<HTMLDivElement>(null);
  const def = getDef(block.type);
  const placeholder =
    pagePlaceholder && block.type === "paragraph"
      ? pagePlaceholderText ?? blockItemText("block.pagePlaceholder")
      : blockDefPlaceholder(def);
  const [slash, setSlash] = useState<{ open: boolean; query: string; anchor?: SlashMenuAnchor }>({
    open: false,
    query: "",
  });
  const [databasePicker, setDatabasePicker] = useState<DatabaseSourcePickerRequest | null>(null);
  const [mention, setMention] = useState<MentionState>({
    open: false,
    query: "",
  });
  const [linkEditor, setLinkEditor] = useState<{ top: number; left: number } | null>(null);
  const [dateEditor, setDateEditor] = useState<{
    top: number;
    left: number;
    anchor: InlineMenuAnchor;
    value: string;
    month: string;
    prefix: string;
  } | null>(null);
  const [personEditor, setPersonEditor] = useState<{
    top: number;
    left: number;
    anchor: InlineMenuAnchor;
    userId: string;
    label: string;
    copied: boolean;
  } | null>(null);
  const [pageEditor, setPageEditor] = useState<{
    top: number;
    left: number;
    anchor: InlineMenuAnchor;
    pageId: string;
    title: string;
    path: string;
    page?: Page;
    copied: boolean;
  } | null>(null);
  const [pastedUrlMenu, setPastedUrlMenu] = useState<{ url: string; top: number; left: number } | null>(null);
  const [calloutIconOpen, setCalloutIconOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [copied, setCopied] = useState(false);
  const [codeFocused, setCodeFocused] = useState(false);
  const dateCalendar = dateEditor ? mentionCalendar(dateEditor.month, dateEditor.value) : null;
  const dateEditorFocusKey = dateEditor ? `${dateEditor.top}:${dateEditor.left}` : "";
  const nav = useRouter();
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const openComments = useStore((s) => s.openComments);
  const updateBlock = useStore((s) => s.updateBlock);
  const calloutChildren = useStore(
    useShallow((s) => s.childBlocks(block.pageId, block.id))
  );
  const calloutText = spansToPlainText(block.content?.rich).trim() || block.plainText?.trim() || "";
  const isImportedCallout = block.type === "callout" && !!(block.content as Record<string, unknown> | undefined)?.notionBlock;
  const isQuietImportedCallout =
    isImportedCallout &&
    !block.content?.color &&
    !calloutText &&
    calloutChildren.length > 0;
  const isImportedDatabaseSectionCallout =
    isQuietImportedCallout &&
    calloutChildren.some((child) =>
      child.type === "heading_1" ||
      child.type === "heading_2" ||
      child.type === "heading_3" ||
      child.type === "heading_4"
    ) &&
    calloutChildren.some((child) => child.type === "inline_database");
  const hideImportedEmptyCalloutText =
    isImportedCallout &&
    !calloutText &&
    calloutChildren.length > 0;
  const showCalloutIcon =
    !!block.content?.icon ||
    !isImportedCallout ||
    !!calloutText;
  const numberedIndex = useStore((s) => {
    if (block.type !== "numbered_list_item") return 1;
    const parentId = block.parentId ?? null;
    const list = (s.blocksByPage[block.pageId] ?? [])
      .filter((b) => (b.parentId ?? null) === parentId)
      .sort((a, b) => a.position - b.position);
    const idx = list.findIndex((b) => b.id === block.id);
    let count = 1;
    for (let i = idx - 1; i >= 0; i--) {
      if (list[i].type !== "numbered_list_item") break;
      count++;
    }
    return count;
  });
  const pastedUrlPage = useStore((s) => {
    const pageId = pastedUrlMenu ? pageIdFromPageHref(pastedUrlMenu.url) : null;
    const page = pageId ? s.pagesById[pageId] : undefined;
    return page && !page.inTrash ? page : undefined;
  });
  const remoteTextAwareness = (ops.remoteAwarenessByBlock[block.id] ?? []).filter(
    (item) => !!item.textRange,
  );
  const textAwarenessRevision = `${block.id}:${spansToPlainText(block.content?.rich).length}:${remoteTextAwareness
    .map((item) => `${item.userId}:${item.textRange?.start}-${item.textRange?.end}`)
    .join("|")}`;
  const hasDateMention = useMemo(
    () => (block.content?.rich ?? []).some((span) => span.mention === "date" && !!span.date),
    [block.content?.rich],
  );
  const [dateMentionRenderTick, setDateMentionRenderTick] = useState(0);

  useEffect(() => {
    if (!hasDateMention) return undefined;
    let timeoutId: number | undefined;
    const schedule = () => {
      timeoutId = window.setTimeout(() => {
        setDateMentionRenderTick((tick) => tick + 1);
        schedule();
      }, nextDateMentionRefreshDelay());
    };
    schedule();
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [hasDateMention]);

  // Initial / identity sync (don't fight the caret on every keystroke).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const html = spansToHtml(block.content?.rich);
    if (!editableHtmlMatches(el, html)) el.innerHTML = html;
    el.dataset.empty = String(spansToPlainText(block.content?.rich).length === 0);
  }, [block.id, block.type, block.content?.rich, dateMentionRenderTick]);

  useEffect(() => {
    if (block.type !== "code") return;
    const el = codeCaptionRef.current;
    if (!el) return;
    const html = spansToHtml(block.content?.caption);
    if (!editableHtmlMatches(el, html)) el.innerHTML = html;
    el.dataset.empty = String(spansToPlainText(block.content?.caption).length === 0);
  }, [block.id, block.type, block.content?.caption]);

  // Latest-ref pattern: keep one window listener per block instead of
  // re-attaching on every render, while still calling the freshest handler.
  const showPastedUrlMenuRef = useRef(showPastedUrlMenu);
  useEffect(() => {
    showPastedUrlMenuRef.current = showPastedUrlMenu;
  });

  useEffect(() => {
    function onPastedUrlMenuRequest(event: Event) {
      const detail = (event as CustomEvent<{ blockId?: string; url?: string }>).detail;
      if (detail?.blockId !== block.id || !detail.url) return;
      showPastedUrlMenuRef.current(detail.url);
    }
    window.addEventListener(PASTED_URL_MENU_REQUEST, onPastedUrlMenuRequest);
    return () => window.removeEventListener(PASTED_URL_MENU_REQUEST, onPastedUrlMenuRequest);
  }, [block.id]);

  useEffect(() => {
    if (!linkEditor) return;
    window.requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
  }, [linkEditor]);

  useEffect(() => {
    if (!dateEditorFocusKey) return;
    window.requestAnimationFrame(() => {
      dateInputRef.current?.focus();
      dateInputRef.current?.select();
    });
  }, [dateEditorFocusKey]);

  useLayoutEffect(() => {
    if (!dateEditor || !dateMenuRef.current) return;
    const rect = dateMenuRef.current.getBoundingClientRect();
    const next = anchoredMenuPosition(
      dateEditor.anchor,
      rect.width || INLINE_DATE_MENU_WIDTH,
      rect.height || INLINE_DATE_MENU_HEIGHT
    );
    if (Math.abs(next.top - dateEditor.top) <= 0.5 && Math.abs(next.left - dateEditor.left) <= 0.5) return;
    setDateEditor((current) => current ? { ...current, ...next } : current);
  }, [dateEditor]);

  useLayoutEffect(() => {
    if (!personEditor || !personMenuRef.current) return;
    const rect = personMenuRef.current.getBoundingClientRect();
    const next = anchoredMenuPosition(
      personEditor.anchor,
      rect.width || INLINE_PERSON_MENU_WIDTH,
      rect.height || INLINE_PERSON_MENU_HEIGHT
    );
    if (Math.abs(next.top - personEditor.top) <= 0.5 && Math.abs(next.left - personEditor.left) <= 0.5) return;
    setPersonEditor((current) => current ? { ...current, ...next } : current);
  }, [personEditor]);

  useLayoutEffect(() => {
    if (!pageEditor || !pageMenuRef.current) return;
    const rect = pageMenuRef.current.getBoundingClientRect();
    const next = anchoredMenuPosition(
      pageEditor.anchor,
      rect.width || INLINE_PAGE_MENU_WIDTH,
      rect.height || INLINE_PAGE_MENU_HEIGHT
    );
    if (Math.abs(next.top - pageEditor.top) <= 0.5 && Math.abs(next.left - pageEditor.left) <= 0.5) return;
    setPageEditor((current) => current ? { ...current, ...next } : current);
  }, [pageEditor]);

  function rangeInsideEditable(range: Range) {
    const el = ref.current;
    if (!el) return false;
    const node = range.commonAncestorContainer;
    const contained = node.nodeType === 3 ? node.parentNode : node;
    return contained === el || (contained ? el.contains(contained) : false);
  }

  function publishEditableAwareness(mode?: PageAwarenessMode) {
    const el = ref.current;
    if (!el || ops.readOnly) return;
    const textRange = textRangeForEditable(el);
    ops.publishAwareness(
      block.id,
      mode ?? (textRange.start === textRange.end ? "editing" : "selecting"),
      [block.id],
      textRange,
    );
  }

  // Latest-ref pattern: selectionchange fires constantly while typing, so the
  // document listener must attach once (per readOnly flip) rather than being
  // torn down and re-added on every render.
  const publishEditableAwarenessRef = useRef(publishEditableAwareness);
  useEffect(() => {
    publishEditableAwarenessRef.current = publishEditableAwareness;
  });

  useEffect(() => {
    if (ops.readOnly) return;
    function onSelectionChange() {
      const el = ref.current;
      const selection = window.getSelection();
      if (!el || document.activeElement !== el || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const contained = node.nodeType === 3 ? node.parentNode : node;
      const inside = contained === el || (contained ? el.contains(contained) : false);
      if (!inside) return;
      publishEditableAwarenessRef.current();
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [ops.readOnly]);

  function linkForRange(range: Range) {
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    return el?.closest?.<HTMLAnchorElement>("a[href]") ?? null;
  }

  const closeLinkEditor = useCallback((restoreFocus = false) => {
    setLinkEditor(null);
    setLinkValue("");
    setLinkCopied(false);
    linkRangeRef.current = null;
    if (restoreFocus) {
      window.requestAnimationFrame(() => ref.current?.focus());
    }
  }, []);

  const closeDateEditor = useCallback((restoreFocus = false) => {
    setDateEditor(null);
    dateRangeRef.current = null;
    if (restoreFocus) {
      window.requestAnimationFrame(() => ref.current?.focus());
    }
  }, []);

  const closePersonEditor = useCallback((restoreFocus = false) => {
    setPersonEditor(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => ref.current?.focus());
    }
  }, []);

  const closePageEditor = useCallback((restoreFocus = false) => {
    setPageEditor(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => ref.current?.focus());
    }
  }, []);

  function linkMenuFocusables() {
    return Array.from(
      linkMenuRef.current?.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled])",
      ) ?? [],
    ).filter((item) => item.getClientRects().length > 0 && item.tabIndex >= 0);
  }

  function dateMenuFocusables() {
    return Array.from(
      dateMenuRef.current?.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled])",
      ) ?? [],
    ).filter((item) => item.getClientRects().length > 0 && item.tabIndex >= 0);
  }

  function personMenuFocusables() {
    return Array.from(
      personMenuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
    ).filter((item) => item.getClientRects().length > 0 && item.tabIndex >= 0);
  }

  function pageMenuFocusables() {
    return Array.from(
      pageMenuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
    ).filter((item) => item.getClientRects().length > 0 && item.tabIndex >= 0);
  }

  function onLinkMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeLinkEditor(true);
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = linkMenuFocusables();
    if (!focusables.length) return;
    e.preventDefault();
    e.stopPropagation();
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[nextIndex]?.focus();
  }

  function onDateMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeDateEditor(true);
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const activeDay = active?.dataset.dateDay;
    if (active === dateInputRef.current && e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      focusDateButton(dateEditor?.value ?? localIsoDate(0));
      return;
    }
    if (activeDay) {
      const moves: Record<string, string> = {
        ArrowLeft: shiftDateByDays(activeDay, -1),
        ArrowRight: shiftDateByDays(activeDay, 1),
        ArrowUp: shiftDateByDays(activeDay, -7),
        ArrowDown: shiftDateByDays(activeDay, 7),
        Home: weekEdgeDate(activeDay, "start"),
        End: weekEdgeDate(activeDay, "end"),
        PageUp: shiftDateByMonths(activeDay, -1),
        PageDown: shiftDateByMonths(activeDay, 1),
      };
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        applyDateMention(activeDay);
        return;
      }
      const nextDate = moves[e.key];
      if (nextDate) {
        e.preventDefault();
        e.stopPropagation();
        setDateMentionDraftAndFocus(nextDate);
        return;
      }
    }
    if (e.key !== "Tab") return;
    const focusables = dateMenuFocusables();
    if (!focusables.length) return;
    e.preventDefault();
    e.stopPropagation();
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[nextIndex]?.focus();
  }

  function onPersonMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePersonEditor(true);
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = personMenuFocusables();
    if (!focusables.length) return;
    e.preventDefault();
    e.stopPropagation();
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[nextIndex]?.focus();
  }

  function onPageMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePageEditor(true);
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = pageMenuFocusables();
    if (!focusables.length) return;
    e.preventDefault();
    e.stopPropagation();
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[nextIndex]?.focus();
  }

  const closePastedUrlMenu = useCallback((restoreFocus = false) => {
    setPastedUrlMenu(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => ref.current?.focus());
    }
  }, []);

  function pastedUrlMenuButtons() {
    return Array.from(
      pastedUrlMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-pasted-url-option]") ??
        [],
    ).filter((button) => !button.disabled && button.getClientRects().length > 0);
  }

  function onPastedUrlMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePastedUrlMenu(true);
      return;
    }
    if (
      e.key === "Tab" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      const buttons = pastedUrlMenuButtons();
      if (!buttons.length) return;
      e.preventDefault();
      e.stopPropagation();
      const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex = currentIndex >= 0 ? currentIndex : 0;
      if (e.key === "Tab") {
        nextIndex =
          currentIndex === -1
            ? 0
            : (currentIndex + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      } else if (e.key === "ArrowDown") {
        nextIndex = currentIndex >= 0 ? (currentIndex + 1) % buttons.length : 0;
      } else if (e.key === "ArrowUp") {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : buttons.length - 1;
      } else if (e.key === "Home") {
        nextIndex = 0;
      } else if (e.key === "End") {
        nextIndex = buttons.length - 1;
      }
      buttons[nextIndex]?.focus();
    }
  }

  function currentCaretAnchor(el: HTMLDivElement): SlashMenuAnchor | undefined {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return undefined;
    const range = sel.getRangeAt(0);
    if (!rangeInsideEditable(range)) return undefined;
    const rect = range.getBoundingClientRect();
    const fallback = el.getBoundingClientRect();
    const left = rect.left || fallback.left;
    const top = rect.top || fallback.top;
    const bottom = rect.bottom || Math.min(fallback.bottom, top + 24);
    const viewport = menuViewportBoundsFor(el);
    return { left, top, bottom, ...viewport };
  }

  function menuViewportBoundsFor(el: HTMLElement) {
    let viewportTop = MENU_VIEWPORT_MARGIN;
    let viewportBottom = window.innerHeight - MENU_VIEWPORT_MARGIN;

    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      const clipsVertically =
        /(auto|scroll|overlay)/.test(style.overflowY) ||
        (/(hidden|clip)/.test(style.overflowY) && node.clientHeight < window.innerHeight);
      if (!clipsVertically) continue;
      const bounds = node.getBoundingClientRect();
      if (bounds.height <= 0) continue;
      viewportTop = Math.max(viewportTop, bounds.top + 4);
      viewportBottom = Math.min(viewportBottom, bounds.bottom - 4);
    }

    if (viewportBottom <= viewportTop + 24) {
      return {};
    }
    return { viewportTop, viewportBottom };
  }

  useEffect(() => {
    if (!linkEditor) return;
    function onPointerDown(e: PointerEvent) {
      if (linkMenuRef.current?.contains(e.target as Node)) return;
      closeLinkEditor(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closeLinkEditor, linkEditor]);

  useEffect(() => {
    if (!dateEditor) return;
    function onPointerDown(e: PointerEvent) {
      if (dateMenuRef.current?.contains(e.target as Node)) return;
      closeDateEditor(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closeDateEditor, dateEditor]);

  useEffect(() => {
    if (!personEditor) return;
    function onPointerDown(e: PointerEvent) {
      if (personMenuRef.current?.contains(e.target as Node)) return;
      closePersonEditor(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closePersonEditor, personEditor]);

  useEffect(() => {
    if (!pageEditor) return;
    function onPointerDown(e: PointerEvent) {
      if (pageMenuRef.current?.contains(e.target as Node)) return;
      closePageEditor(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closePageEditor, pageEditor]);

  useEffect(() => {
    if (!pastedUrlMenu) return;
    const frame = window.requestAnimationFrame(() => {
      pastedUrlMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    function onPointerDown(e: PointerEvent) {
      if (pastedUrlMenuRef.current?.contains(e.target as Node)) return;
      closePastedUrlMenu(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [closePastedUrlMenu, pastedUrlMenu]);

  function restoreLinkRange() {
    const range = linkRangeRef.current;
    const el = ref.current;
    if (!range || !el) return null;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return el;
  }

  function openLinkEditor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    let range = sel.getRangeAt(0);
    if (!rangeInsideEditable(range)) return;

    const link = linkForRange(range);
    if (range.collapsed) {
      if (!link) return;
      const nextRange = document.createRange();
      nextRange.selectNodeContents(link);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      range = nextRange;
    }

    const rect = (link ?? range).getBoundingClientRect();
    const fallback = ref.current?.getBoundingClientRect();
    const anchor = rect.width || rect.height ? rect : fallback;
    if (!anchor) return;
    const { left, top } = anchoredMenuPosition(
      anchor,
      INLINE_LINK_MENU_WIDTH,
      INLINE_LINK_MENU_HEIGHT
    );
    linkRangeRef.current = range.cloneRange();
    setLinkValue(link?.getAttribute("href") ?? "");
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeDateEditor(false);
    closePersonEditor(false);
    closePageEditor(false);
    setLinkEditor({ top, left });
  }

  function openLinkEditorForAnchor(link: HTMLAnchorElement) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(link);
    sel.removeAllRanges();
    sel.addRange(range);

    const rect = link.getBoundingClientRect();
    const { left, top } = anchoredMenuPosition(
      rect,
      INLINE_LINK_MENU_WIDTH,
      INLINE_LINK_MENU_HEIGHT
    );
    linkRangeRef.current = range.cloneRange();
    setLinkValue(link.getAttribute("href") ?? "");
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeDateEditor(false);
    closePersonEditor(false);
    closePageEditor(false);
    setLinkEditor({ top, left });
  }

  function openDateEditorForMention(dateMention: HTMLElement) {
    const date = dateMention.dataset.date;
    if (!date) return;
    const prefix = dateMention.textContent?.trim().startsWith("@") ? "@" : "";
    const range = document.createRange();
    range.selectNodeContents(dateMention);
    const rect = dateMention.getBoundingClientRect();
    const anchor = inlineMenuAnchorFromRect(rect);
    const { left, top } = anchoredMenuPosition(
      anchor,
      INLINE_DATE_MENU_WIDTH,
      INLINE_DATE_MENU_HEIGHT
    );
    dateRangeRef.current = range.cloneRange();
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeLinkEditor(false);
    closePastedUrlMenu(false);
    closePersonEditor(false);
    closePageEditor(false);
    setDateEditor({ top, left, anchor, value: date, month: monthStartForDate(date), prefix });
  }

  function openPersonEditorForMention(personMention: HTMLElement) {
    const mentionedUserId = personMention.dataset.userId || "local-user";
    const currentUserId = useStore.getState().userId;
    const label = personLabel(mentionedUserId, currentUserId);
    const rect = personMention.getBoundingClientRect();
    const anchor = inlineMenuAnchorFromRect(rect);
    const { left, top } = anchoredMenuPosition(
      anchor,
      INLINE_PERSON_MENU_WIDTH,
      INLINE_PERSON_MENU_HEIGHT
    );
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeLinkEditor(false);
    closeDateEditor(false);
    closePastedUrlMenu(false);
    setPersonEditor({ top, left, anchor, userId: mentionedUserId, label, copied: false });
  }

  function openPageEditorForMention(pageMention: HTMLElement) {
    const mentionedPageId = pageMention.dataset.pageId;
    if (!mentionedPageId) return;
    const pagesById = useStore.getState().pagesById;
    const page = pagesById[mentionedPageId];
    const rect = pageMention.getBoundingClientRect();
    const anchor = inlineMenuAnchorFromRect(rect);
    const title = page
      ? pageTitle(page)
      : pageMention.textContent?.trim() || blockItemText("common.untitled");
    const path = page
      ? pagePathOrWorkspaceRoot(page, pagesById)
      : blockItemText("pageLink.pathFallback");
    const { left, top } = anchoredMenuPosition(
      anchor,
      INLINE_PAGE_MENU_WIDTH,
      INLINE_PAGE_MENU_HEIGHT
    );
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeLinkEditor(false);
    closeDateEditor(false);
    closePersonEditor(false);
    closePageEditor(false);
    closePastedUrlMenu(false);
    setPageEditor({ top, left, anchor, pageId: mentionedPageId, title, path, page, copied: false });
  }

  function openCommentShortcut() {
    const el = ref.current;
    if (!el) return;
    const sel = window.getSelection();
    let quote: string | undefined;
    let quoteStart: number | undefined;
    let quoteEnd: number | undefined;

    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (rangeInsideEditable(range)) {
        quote = range.toString().replace(/\s+/g, " ").trim() || undefined;
        quoteStart = textOffsetIn(el, range.startContainer, range.startOffset) ?? undefined;
        quoteEnd = textOffsetIn(el, range.endContainer, range.endOffset) ?? undefined;
      }
    }

    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeLinkEditor(false);
    closeDateEditor(false);
    closePersonEditor(false);
    closePageEditor(false);
    closePastedUrlMenu(false);
    openComments(block.pageId, block.id, { quote, quoteStart, quoteEnd });
  }

  function applyInlineColor(token: string) {
    const el = ref.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!rangeInsideEditable(range)) return false;

    const fragment = range.extractContents();
    clearColorAttributes(fragment);

    const inserted = document.createElement("span");
    if (token !== "default") inserted.dataset.color = token;
    inserted.appendChild(fragment);

    range.insertNode(inserted);
    sel.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(inserted);
    sel.addRange(nextRange);

    const normalized = htmlToSpans(el);
    el.innerHTML = spansToHtml(normalized);
    el.dataset.empty = String(spansToPlainText(normalized).length === 0);
    ops.setText(block.id, normalized);
    return true;
  }

  function pageMentionFromUrl(url: string): TextSpan | null {
    const pageId = pageIdFromPageHref(url);
    const pagesById = useStore.getState().pagesById;
    const page = pageId ? pagesById[pageId] : undefined;
    if (!page || page.inTrash) return null;
    return {
      text: pageTitle(page),
      mention: "page",
      pageId: page.id,
    };
  }

  function replaceSelectionWithPageMention(range: Range, url: string) {
    const el = ref.current;
    const mentionSpan = pageMentionFromUrl(url);
    if (!el || !mentionSpan || !rangeInsideEditable(range)) return false;
    const start = textOffsetIn(el, range.startContainer, range.startOffset);
    const end = textOffsetIn(el, range.endContainer, range.endOffset);
    if (start === null || end === null || start === end) return false;

    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const spans = htmlToSpans(el);
    const [head] = splitSpans(spans, from);
    const [, tail] = splitSpans(spans, to);
    const next = concatSpans(concatSpans(head, [mentionSpan]), tail);
    el.innerHTML = spansToHtml(next);
    el.dataset.empty = String(spansToPlainText(next).length === 0);
    ops.setText(block.id, next);
    placeCaret(el, from + mentionSpan.text.length);
    return true;
  }

  function applyLastColorShortcut() {
    const token = getLastEditorColor();
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeLinkEditor(false);
    closeDateEditor(false);
    closePersonEditor(false);
    closePastedUrlMenu(false);
    if (applyInlineColor(token)) return;

    const content = { ...(block.content ?? {}) };
    if (token === "default") delete content.color;
    else content.color = token;
    updateBlock(block.id, { content });
  }

  function applyLinkValue() {
    const range = linkRangeRef.current?.cloneRange() ?? null;
    const editable = restoreLinkRange();
    const url = normalizePastedLink(linkValue) || safeUrl(linkValue.trim());
    if (url && range && replaceSelectionWithPageMention(range, url)) {
      closeLinkEditor();
      return;
    }
    if (url) document.execCommand("createLink", false, url);
    else document.execCommand("unlink");
    if (editable) onInput();
    closeLinkEditor();
  }

  function removeLink() {
    const editable = restoreLinkRange();
    document.execCommand("unlink");
    if (editable) onInput();
    closeLinkEditor();
  }

  function setDateMentionDraft(value: string) {
    setDateEditor((current) => {
      if (!current) return current;
      return {
        ...current,
        value,
        month: parseLocalIsoDate(value) ? monthStartForDate(value) : current.month,
      };
    });
  }

  function focusDateButton(value: string) {
    window.requestAnimationFrame(() => {
      const button = Array.from(
        dateMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-date-day]") ?? [],
      ).find((candidate) => candidate.dataset.dateDay === value);
      button?.focus();
    });
  }

  function setDateMentionDraftAndFocus(value: string) {
    setDateMentionDraft(value);
    focusDateButton(value);
  }

  function shiftDateCalendar(offset: number) {
    setDateEditor((current) =>
      current ? { ...current, month: shiftMonth(current.month, offset) } : current
    );
  }

  function replaceStoredDateRange(nextSpan: TextSpan | null) {
    const el = ref.current;
    const range = dateRangeRef.current?.cloneRange() ?? null;
    if (!el || !range || !rangeInsideEditable(range)) return false;
    const start = textOffsetIn(el, range.startContainer, range.startOffset);
    const end = textOffsetIn(el, range.endContainer, range.endOffset);
    if (start === null || end === null) return false;

    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const spans = htmlToSpans(el);
    const [head] = splitSpans(spans, from);
    const [, tail] = splitSpans(spans, to);
    const middle = nextSpan ? [nextSpan] : [];
    const next = concatSpans(concatSpans(head, middle), tail);
    el.innerHTML = spansToHtml(next);
    el.dataset.empty = String(spansToPlainText(next).length === 0);
    ops.setText(block.id, next);
    placeCaret(el, from + (nextSpan?.text.length ?? 0));
    return true;
  }

  function applyDateMention(value = dateEditor?.value ?? "") {
    const nextDate = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return;
    const parsed = new Date(`${nextDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return;
    const changed = replaceStoredDateRange({
      text: `${dateEditor?.prefix ?? ""}${dateMentionLabel(nextDate)}`,
      mention: "date",
      date: nextDate,
    });
    if (changed) closeDateEditor();
  }

  function removeDateMention() {
    const changed = replaceStoredDateRange(null);
    if (changed) closeDateEditor();
  }

  function openCurrentLink() {
    const url = normalizePastedLink(linkValue) || safeUrl(linkValue.trim());
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
    closeLinkEditor();
  }

  async function copyCurrentLink() {
    const url = normalizePastedLink(linkValue) || safeUrl(linkValue.trim());
    if (!url) return;
    const ok = await copyText(url);
    setLinkCopied(ok);
    if (ok) window.setTimeout(() => setLinkCopied(false), 1200);
  }

  async function copyMentionedPerson() {
    if (!personEditor) return;
    const ok = await copyText(personEditor.label);
    if (!ok) return;
    setPersonEditor((current) => current ? { ...current, copied: true } : current);
    window.setTimeout(() => {
      setPersonEditor((current) => current ? { ...current, copied: false } : current);
    }, 1200);
  }

  function openMentionedPage() {
    if (!pageEditor) return;
    const targetPageId = pageEditor.pageId;
    closePageEditor();
    setSidebarOpen(false);
    nav.push(pageHref(targetPageId));
  }

  async function copyMentionedPageLink() {
    if (!pageEditor) return;
    const url = absolutePageUrl(pageEditor.pageId);
    const ok = await copyText(url);
    if (!ok) return;
    setPageEditor((current) => current ? { ...current, copied: true } : current);
    window.setTimeout(() => {
      setPageEditor((current) => current ? { ...current, copied: false } : current);
    }, 1200);
  }

  function applyMark(kind: "bold" | "italic" | "underline" | "strikethrough" | "code" | "link") {
    const el = ref.current;
    if (!el) return;
    if (block.type === "code") return;
    try {
      document.execCommand("styleWithCSS", false, "false");
    } catch {
      /* ignore */
    }
    if (kind === "code") {
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      if (text) {
        document.execCommand("insertHTML", false, `<code>${escapeHtml(text)}</code>`);
      } else {
        // Collapsed caret: insert an empty code span and place the caret inside
        // so subsequently typed text becomes code (consistent with bold/italic).
        document.execCommand("insertHTML", false, '<code id="__code-mark-tmp">\u200B</code>');
        const codeEl = el.querySelector("#__code-mark-tmp");
        if (codeEl) {
          codeEl.removeAttribute("id");
          const range = document.createRange();
          range.selectNodeContents(codeEl);
          range.collapse(false);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }
    } else if (kind === "link") {
      openLinkEditor();
      return;
    } else {
      const cmd = kind === "strikethrough" ? "strikeThrough" : kind;
      document.execCommand(cmd);
    }
    onInput(); // reserialize DOM → spans
  }

  function maybeSlash() {
    const el = ref.current;
    if (!el) return;
    const off = caretOffset(el);
    const before = el.innerText.slice(0, off);
    const m = before.match(SLASH_RE);
    if (m) {
      setSlash({ open: true, query: m[1], anchor: currentCaretAnchor(el) });
      setMention({ open: false, query: "" });
    }
    else if (slash.open) setSlash({ open: false, query: "" });
  }

  function maybeMention() {
    const el = ref.current;
    if (!el) return;
    const off = caretOffset(el);
    const before = el.innerText.slice(0, off);
    const trigger = mentionTriggerFromText(before);
    if (trigger) {
      setMention({
        open: true,
        query: trigger.query,
        anchor: currentCaretAnchor(el),
        trigger: trigger.trigger,
      });
      setSlash({ open: false, query: "" });
    } else if (mention.open) {
      setMention({ open: false, query: "" });
    }
  }

  function onInput() {
    const el = ref.current;
    if (!el) return;
    setPastedUrlMenu(null);
    el.dataset.empty = String((el.textContent ?? "").length === 0);
    const spans = htmlToSpans(el);
    if (pagePlaceholder && spansToPlainText(spans).length > 0) {
      onPagePlaceholderInput?.();
    }
    if (block.type !== "code" && applyInlineMarkdownShortcut(el, spans)) return;
    ops.setText(block.id, spans);
    maybeSlash();
    maybeMention();
    publishEditableAwareness();
  }

  function cancelPendingCompositionEnterFrame() {
    if (compositionEnterFrameRef.current === null) return;
    window.cancelAnimationFrame(compositionEnterFrameRef.current);
    compositionEnterFrameRef.current = null;
  }

  function compositionCommittedOffset(spans: TextSpan[], offset: number) {
    const text = lastCompositionTextRef.current;
    if (!text) return offset;
    const plain = spansToPlainText(spans);
    return plain.slice(offset, offset + text.length) === text
      ? offset + text.length
      : offset;
  }

  function splitTextBlockAt(el: HTMLDivElement, offset = caretOffset(el)) {
    const spans = htmlToSpans(el);
    const [before, after] = splitSpans(spans, offset);
    el.innerHTML = spansToHtml(before);
    el.dataset.empty = String(before.length === 0);
    ops.splitBlock(block.id, before, after);
  }

  function applyDefaultSlashCommandAt(
    el: HTMLDivElement,
    spans: TextSpan[],
    offset: number
  ) {
    const beforeCaret = spansToPlainText(spans).slice(0, offset);
    const slashMatch = beforeCaret.match(SLASH_RE);
    const slashQuery = slashMatch?.[1] ?? "";
    // An empty `/` menu can be reordered by recent commands, so its selected
    // item must remain owned by SlashMenu. A non-empty query has a stable
    // content-derived default that can safely recover when React menu state is
    // one input behind the committed contenteditable DOM.
    const slashDefinition = slashQuery ? matchBlocks(slashQuery)[0] : undefined;
    if (!slashDefinition) return false;
    placeCaret(el, offset);
    applyType(slashDefinition);
    return true;
  }

  function runEnterFromCommittedComposition(
    el: HTMLDivElement,
    inputType: "insertParagraph" | "insertLineBreak" = "insertParagraph"
  ) {
    const spans = htmlToSpans(el);
    const offset = compositionCommittedOffset(spans, caretOffset(el));
    const softBreak = inputType === "insertLineBreak" || compositionEnterShiftRef.current;
    // Some IMEs report the Enter that commits an ASCII slash query as a
    // composing key. The slash menu intentionally ignores composing keydown,
    // so apply its default selected command after composition commits instead
    // of falling through to a normal paragraph split.
    if (!softBreak && applyDefaultSlashCommandAt(el, spans, offset)) {
      compositionEnterHandledRef.current = true;
      return;
    }
    if (block.type === "code") {
      placeCaret(el, offset);
      insertCodeLineBreak(el);
    } else if (softBreak) {
      placeCaret(el, offset);
      insertSoftBreak(el);
    } else {
      splitTextBlockAt(el, offset);
    }
    compositionEnterHandledRef.current = true;
  }

  function scheduleCompositionEnter(
    inputType: "insertParagraph" | "insertLineBreak" = "insertParagraph"
  ) {
    cancelPendingCompositionEnterFrame();
    compositionEnterFrameRef.current = window.requestAnimationFrame(() => {
      compositionEnterFrameRef.current = null;
      if (compositionEnterHandledRef.current) return;
      const el = ref.current;
      if (!el) return;
      runEnterFromCommittedComposition(el, inputType);
    });
  }

  useEffect(() => {
    return () => cancelPendingCompositionEnterFrame();
  }, []);

  function onCompositionStart() {
    cancelPendingCompositionEnterFrame();
    composingRef.current = true;
    // Editor-level remote appliers consult this DOM flag so a collaborator's
    // CRDT text can't rewrite this block mid-IME-composition (see
    // applyRemoteCrdtBlockText in Editor.tsx).
    if (ref.current) ref.current.dataset.composing = "true";
    composingEnterRef.current = false;
    compositionEnterHandledRef.current = false;
    compositionEnterShiftRef.current = false;
    compositionEnterGuardUntilRef.current = 0;
    pendingCompositionParagraphInputRef.current = null;
    lastCompositionTextRef.current = "";
  }

  function onCompositionEnd(e: ReactCompositionEvent<HTMLDivElement>) {
    composingRef.current = false;
    if (ref.current) delete ref.current.dataset.composing;
    lastCompositionTextRef.current = e.data ?? "";
    if (!composingEnterRef.current) {
      compositionEnterGuardUntilRef.current = 0;
      return;
    }
    composingEnterRef.current = false;
    const now = typeof performance === "undefined" ? Date.now() : performance.now();
    compositionEnterGuardUntilRef.current = now + 80;
    const pendingInput = pendingCompositionParagraphInputRef.current;
    pendingCompositionParagraphInputRef.current = null;
    scheduleCompositionEnter(pendingInput ?? (compositionEnterShiftRef.current ? "insertLineBreak" : "insertParagraph"));
  }

  function handlePostCompositionEnter(e: React.KeyboardEvent<HTMLDivElement>, el: HTMLDivElement) {
    if (e.key !== "Enter" || compositionEnterGuardUntilRef.current <= 0) return false;
    const now = typeof performance === "undefined" ? Date.now() : performance.now();
    if (now > compositionEnterGuardUntilRef.current) {
      compositionEnterGuardUntilRef.current = 0;
      return false;
    }
    e.preventDefault();
    compositionEnterGuardUntilRef.current = 0;
    if (!compositionEnterHandledRef.current) {
      runEnterFromCommittedComposition(el, e.shiftKey ? "insertLineBreak" : "insertParagraph");
    }
    return true;
  }

  function onBeforeInput(native: InputEvent) {
    if (native.inputType !== "insertParagraph" && native.inputType !== "insertLineBreak") return;
    // Some IMEs expose the committed slash query and the visible command menu,
    // but report the confirming key only as an ambiguous Process/229 event.
    // In that case keydown cannot prove that Enter was pressed; the subsequent
    // paragraph beforeinput is the authoritative signal. Apply the visible
    // menu's default command here instead of allowing a paragraph split.
    if (native.inputType === "insertParagraph" && slash.open) {
      const el = ref.current;
      if (el && applyDefaultSlashCommandAt(el, htmlToSpans(el), caretOffset(el))) {
        native.preventDefault();
        composingEnterRef.current = false;
        compositionEnterHandledRef.current = true;
        compositionEnterGuardUntilRef.current = 0;
        pendingCompositionParagraphInputRef.current = null;
        return;
      }
    }
    if (!composingRef.current && compositionEnterGuardUntilRef.current <= 0) return;

    native.preventDefault();
    if (composingRef.current) {
      pendingCompositionParagraphInputRef.current = native.inputType;
      composingEnterRef.current = true;
      return;
    }

    if (!compositionEnterHandledRef.current) {
      const el = ref.current;
      if (el) runEnterFromCommittedComposition(el, native.inputType);
    }
  }

  useEffect(() => {
    const el = ref.current;
    if (!el || ops.readOnly) return;
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  });

  function applyInlineMarkdownShortcut(el: HTMLDivElement, spans: TextSpan[]) {
    const off = caretOffset(el);
    const fullText = spansToPlainText(spans);
    if (block.type === "paragraph" && off === fullText.length) {
      const typedBlock = typedMarkdownBlockFromText(fullText);
      if (typedBlock) {
        el.innerHTML = "";
        el.dataset.empty = "true";
        updateBlock(block.id, {
          type: typedBlock.type,
          content: typedBlock.content ?? { rich: [] },
          plainText: typedBlock.plainText ?? spansToPlainText(typedBlock.content?.rich),
        });
        setSlash({ open: false, query: "" });
        setMention({ open: false, query: "" });
        if (typedBlock.type === "equation") focusEquationInput(block.id);
        else if (!focusBlockWritingTarget({ ...block, type: typedBlock.type, content: typedBlock.content })) {
          ops.insertAfter(block.id, "paragraph");
        }
        return true;
      }
    }

    const beforeCaret = fullText.slice(0, off);
    const linkShortcut = findInlineMarkdownLinkShortcut(beforeCaret);
    if (linkShortcut) {
      const [head, fromStart] = splitSpans(spans, linkShortcut.start);
      const [, fromLabelStart] = splitSpans(fromStart, 1);
      const [label, fromLabelEnd] = splitSpans(fromLabelStart, linkShortcut.labelLength);
      const [, tail] = splitSpans(fromLabelEnd, linkShortcut.rawUrlLength + 3);
      const linked = unescapeMarkdownLinkLabelSpans(label).map((span) => ({
        ...span,
        link: linkShortcut.url,
      }));
      const next = concatSpans(concatSpans(head, linked), tail);
      const linkedLength = spansToPlainText(linked).length;

      el.innerHTML = spansToHtml(next);
      el.dataset.empty = String(spansToPlainText(next).length === 0);
      ops.setText(block.id, next);
      placeCaret(el, linkShortcut.start + linkedLength);
      setSlash({ open: false, query: "" });
      setMention({ open: false, query: "" });
      return true;
    }

    const autoLinkShortcut = findTypedAutoLinkShortcut(beforeCaret);
    if (autoLinkShortcut) {
      const [head, fromUrlStart] = splitSpans(spans, autoLinkShortcut.start);
      const [urlText, fromUrlEnd] = splitSpans(fromUrlStart, autoLinkShortcut.urlLength);
      const [trailing, tail] = splitSpans(fromUrlEnd, autoLinkShortcut.trailingLength);
      const linked = urlText.map((span) => ({ ...span, link: autoLinkShortcut.url }));
      const next = concatSpans(concatSpans(concatSpans(head, linked), trailing), tail);

      el.innerHTML = spansToHtml(next);
      el.dataset.empty = String(spansToPlainText(next).length === 0);
      ops.setText(block.id, next);
      placeCaret(el, autoLinkShortcut.start + autoLinkShortcut.urlLength + autoLinkShortcut.trailingLength);
      setSlash({ open: false, query: "" });
      setMention({ open: false, query: "" });
      return true;
    }

    const symbolShortcut = findInlineSymbolShortcut(beforeCaret);
    if (symbolShortcut) {
      const [head, fromStart] = splitSpans(spans, symbolShortcut.start);
      const [typedSymbol, fromSymbolEnd] = splitSpans(
        fromStart,
        symbolShortcut.trigger.length
      );
      if (typedSymbol.some((span) => span.code)) return false;
      const next = concatSpans(
        concatSpans(head, [
          inlineSymbolReplacementSpan(typedSymbol, symbolShortcut.replacement),
        ]),
        fromSymbolEnd
      );
      const nextOffset = symbolShortcut.start + symbolShortcut.replacement.length;

      el.innerHTML = spansToHtml(next);
      el.dataset.empty = String(spansToPlainText(next).length === 0);
      ops.setText(block.id, next);
      placeCaret(el, nextOffset);
      setSlash({ open: false, query: "" });
      setMention({ open: false, query: "" });
      return true;
    }

    const shortcut = findInlineMarkdownShortcut(beforeCaret);
    if (!shortcut) return false;

    const [head, fromStart] = splitSpans(spans, shortcut.start);
    const [, fromInnerStart] = splitSpans(fromStart, shortcut.open.length);
    const [inner, fromInnerEnd] = splitSpans(fromInnerStart, shortcut.innerLength);
    const [, tail] = splitSpans(fromInnerEnd, shortcut.close.length);
    const marked = inner.map((span) => ({ ...span, [shortcut.mark]: true }));
    const next = concatSpans(concatSpans(head, marked), tail);
    const nextOffset = shortcut.start + shortcut.innerLength;

    const nextPlainText = spansToPlainText(next);
    el.innerHTML = spansToHtml(next);
    if (nextOffset >= nextPlainText.length) el.appendChild(document.createTextNode("\u200B"));
    el.dataset.empty = String(nextPlainText.length === 0);
    ops.setText(block.id, next);
    placeCaret(el, nextOffset);
    clearNativeInlineTypingState(shortcut.mark);
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    return true;
  }

  function onCodeCaptionInput() {
    const el = codeCaptionRef.current;
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
      { content: { ...block.content, caption } },
      { debounce: true, history: "merge" }
    );
  }

  async function copyCode() {
    const ok = await copyText(spansToPlainText(block.content?.rich));
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1200);
  }

  // Remove the trailing "/query" trigger text, preserving inline marks. Returns
  // the caret offset where the trigger used to start.
  function stripSlashTrigger(el: HTMLDivElement): number {
    const off = caretOffset(el);
    const beforeText = (el.textContent ?? "").slice(0, off);
    const m = beforeText.match(SLASH_RE);
    const triggerLen = m ? 1 + (m[1]?.length ?? 0) : 0; // "/" + query
    const cut = Math.max(0, off - triggerLen);
    const spans = htmlToSpans(el);
    const [head] = splitSpans(spans, cut);
    const [, tail] = splitSpans(spans, off);
    const merged = concatSpans(head, tail);
    el.innerHTML = spansToHtml(merged);
    el.dataset.empty = String(spansToPlainText(merged).length === 0);
    ops.setText(block.id, merged);
    placeCaret(el, cut);
    return cut;
  }

  // Close the slash menu and remove the pending "/query" trigger text, restoring
  // the block to its pre-slash content (mirrors applyType's cleanup).
  function dismissSlash() {
    const el = ref.current;
    if (el) stripSlashTrigger(el);
    setSlash({ open: false, query: "" });
  }

  function closeDatabasePicker(restoreFocus = true) {
    setDatabasePicker(null);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
    });
  }

  function createDatabaseFromPicker(request: DatabaseSourcePickerRequest) {
    setDatabasePicker(null);
    if (request.type === "child_database") {
      void ops.createDatabase(block.id, request.viewType);
    } else {
      void ops.createInlineDatabase(block.id, request.viewType);
    }
  }

  function linkDatabaseFromPicker(request: DatabaseSourcePickerRequest, databaseId: string) {
    setDatabasePicker(null);
    ops.linkDatabase(block.id, databaseId, request.type, request.viewType);
  }

  function applyType(definition: BlockDef) {
    const type = definition.type;
    const slashAnchor = slash.anchor;
    // Remove the "/query" trigger before transforming, preserving inline marks.
    const el = ref.current;
    let cut = 0;
    // Text-formatting slash commands transform the current block in place while
    // preserving the text before the "/" trigger. Insert-style commands (media
    // and other non-text blocks) keep that text block intact and add the chosen
    // block below it. `stripSlashTrigger` records emptiness on the dataset.
    let hasResidualText = false;
    if (el) {
      cut = stripSlashTrigger(el);
      hasResidualText = el.dataset.empty !== "true";
    }
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    if (definition.action === "duplicate") {
      void ops.duplicateBlock(block.id);
    } else if (definition.action === "delete") {
      ops.remove(block.id);
    } else if (definition.action === "move_to") {
      ops.openMoveDialog(block.id);
    } else if (definition.action === "turn_into" || definition.action === "color") {
      ops.selectBlock(block.id);
      ops.openBlockActionMenu(block.id);
    } else if (definition.action === "set_color" && definition.colorToken) {
      rememberEditorColor(definition.colorToken);
      ops.setSelectedBlockColor(block.id, definition.colorToken);
    } else if (type === "child_database") {
      setDatabasePicker({ anchor: slashAnchor, type, viewType: definition.databaseView });
    } else if (type === "inline_database") {
      setDatabasePicker({ anchor: slashAnchor, type, viewType: definition.databaseView });
    } else if (type === "link_to_page") {
      ops.createPageLink(block.id);
    } else if (type === "column_list") {
      ops.createColumns(block.id, definition.columnCount ?? 2);
    } else if (type === "simple_table") {
      ops.createSimpleTable(block.id);
    } else if (type === "equation") {
      ops.createEquation(block.id);
    } else if (type === "synced_block") {
      ops.createSyncedBlock(block.id);
    } else if (type === "button") {
      ops.createButton(block.id);
    } else if (type === "tab") {
      ops.createTab(block.id);
    } else if (type === "child_page") {
      ops.createChildPage(block.id);
    } else if (type === "divider") {
      if (hasResidualText) {
        ops.insertAfter(block.id, "divider");
      } else {
        ops.changeType(block.id, "divider");
        ops.insertAfter(block.id, "paragraph");
      }
    } else if (type === "table_of_contents" || type === "breadcrumb") {
      if (hasResidualText) {
        ops.insertAfter(block.id, type);
      } else {
        ops.changeType(block.id, type);
        ops.insertAfter(block.id, "paragraph");
      }
    } else if (hasResidualText && !TEXT_BLOCKS.has(type)) {
      ops.insertAfter(block.id, type);
    } else {
      ops.changeType(block.id, type, cut);
    }
  }

  async function applyMention(item: MentionItem, trigger: MentionTrigger = "mention") {
    const el = ref.current;
    if (!el) return;
    const off = caretOffset(el);
    const beforeText = (el.textContent ?? "").slice(0, off);
    const match = mentionTriggerFromText(beforeText);
    const triggerLength = match?.trigger === trigger ? match.length : 0;
    const cut = Math.max(0, off - triggerLength);
    const spans = htmlToSpans(el);
    const [head] = splitSpans(spans, cut);
    const [, tail] = splitSpans(spans, off);
    setMention({ open: false, query: "" });
    closeDateEditor(false);
    closePersonEditor(false);
    closePageEditor(false);

    let mentionSpan: TextSpan;
    const prefix = trigger === "mention" ? "@" : "";
    if (item.kind === "create_page") {
      const page = await useStore.getState().createPage({
        parentId: block.pageId,
        parentType: "page",
        title: item.title,
        focusTitle: false,
      });
      mentionSpan = {
        text: `${prefix}${pageDisplayTitle(page)}`,
        mention: "page" as const,
        pageId: page.id,
      };
    } else {
      mentionSpan = item.kind === "page"
        ? {
            text: `${prefix}${item.label}`,
            mention: "page" as const,
            pageId: item.pageId,
          }
        : item.kind === "person"
          ? {
              text: `@${item.label}`,
              mention: "person" as const,
              userId: item.userId,
            }
          : {
              text: `@${dateMentionLabel(item.date)}`,
              mention: "date" as const,
              date: item.date,
            };
    }
    const next = concatSpans(concatSpans(head, [mentionSpan, { text: " " }]), tail);
    el.innerHTML = spansToHtml(next);
    el.dataset.empty = String(spansToPlainText(next).length === 0);
    ops.setText(block.id, next);
    placeCaret(el, cut + mentionSpan.text.length + 1);
  }

  function onEditableClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const commentAnchor = target.closest<HTMLElement>("[data-comment-id]");
    if (commentAnchor?.dataset.commentId) {
      e.preventDefault();
      openComments(block.pageId, block.id, { activeCommentId: commentAnchor.dataset.commentId });
      return;
    }
    const dateMention = target.closest<HTMLElement>('[data-mention="date"]');
    if (dateMention?.dataset.date) {
      e.preventDefault();
      openDateEditorForMention(dateMention);
      return;
    }
    const personMention = target.closest<HTMLElement>('[data-mention="person"]');
    if (personMention?.dataset.userId) {
      e.preventDefault();
      openPersonEditorForMention(personMention);
      return;
    }
    const pageMention = target.closest<HTMLAnchorElement>('a[data-mention="page"]');
    const pageId = pageMention?.dataset.pageId;
    if (pageId) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPageEditorForMention(pageMention);
      return;
    }

    const regularLink = target.closest<HTMLAnchorElement>("a[href]");
    if (regularLink) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      openLinkEditorForAnchor(regularLink);
    }
  }

  function insertSoftBreak(el: HTMLDivElement) {
    const off = caretOffset(el);
    const spans = htmlToSpans(el);
    const [before, after] = splitSpans(spans, off);
    const next = concatSpans(concatSpans(before, [{ text: "\n" }]), after);
    el.innerHTML = spansToHtml(next);
    el.dataset.empty = String(spansToPlainText(next).length === 0);
    ops.setText(block.id, next);
    placeCaret(el, off + 1);
  }

  function insertCodeLineBreak(el: HTMLDivElement) {
    const offsets = codeSelectionOffsets(el);
    const text = el.textContent ?? "";
    const lineStart = text.lastIndexOf("\n", Math.max(0, offsets.start - 1)) + 1;
    const indent = text.slice(lineStart).match(/^[\t ]*/)?.[0] ?? "";
    const insertion = `\n${indent}`;
    const nextText = text.slice(0, offsets.start) + insertion + text.slice(offsets.end);
    const next = [{ text: nextText }];
    el.innerHTML = spansToHtml(next);
    el.dataset.empty = String(nextText.length === 0);
    ops.setText(block.id, next);
    placeCaret(el, offsets.start + insertion.length);
  }

  function codeSelectionOffsets(el: HTMLDivElement) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      const offset = caretOffset(el);
      return { start: offset, end: offset };
    }
    const range = selection.getRangeAt(0);
    if (!rangeInsideEditable(range)) {
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

  function codeLineStartsForRange(text: string, start: number, end: number) {
    const effectiveEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
    const starts: number[] = [];
    let lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    while (lineStart <= effectiveEnd) {
      starts.push(lineStart);
      const nextBreak = text.indexOf("\n", lineStart);
      if (nextBreak < 0) break;
      lineStart = nextBreak + 1;
    }
    return starts;
  }

  function adjustCodeIndent(el: HTMLDivElement, direction: "indent" | "outdent") {
    const offsets = codeSelectionOffsets(el);
    const text = el.textContent ?? "";
    if (direction === "indent" && offsets.start === offsets.end) {
      document.execCommand("insertText", false, "  ");
      return true;
    }
    const lineStarts = codeLineStartsForRange(text, offsets.start, offsets.end);
    const edits = lineStarts
      .map((lineStart) => {
        if (direction === "indent") return { position: lineStart, remove: 0, insert: "  " };
        const prefix = text.slice(lineStart, lineStart + 2);
        const remove = prefix.startsWith("\t")
          ? 1
          : prefix.startsWith("  ")
            ? 2
            : prefix.startsWith(" ")
              ? 1
              : 0;
        return { position: lineStart, remove, insert: "" };
      })
      .filter((edit) => edit.remove > 0 || edit.insert.length > 0);
    if (edits.length === 0) return false;

    let nextText = text;
    for (const edit of edits.slice().reverse()) {
      nextText =
        nextText.slice(0, edit.position) +
        edit.insert +
        nextText.slice(edit.position + edit.remove);
    }

    const next = [{ text: nextText }];
    el.innerHTML = spansToHtml(next);
    el.dataset.empty = String(nextText.length === 0);
    ops.setText(block.id, next);

    const startDelta = edits.reduce(
      (sum, edit) => sum + (edit.position < offsets.start ? edit.insert.length - edit.remove : 0),
      0
    );
    const endDelta = edits.reduce(
      (sum, edit) => sum + (edit.position < offsets.end ? edit.insert.length - edit.remove : 0),
      0
    );
    const nextStart = Math.max(0, offsets.start + startDelta);
    const nextEnd = Math.max(nextStart, offsets.end + endDelta);
    if (offsets.start === offsets.end) placeCaret(el, nextEnd);
    else selectTextRange(el, nextStart, nextEnd);
    return true;
  }

  function applyClipboardFiles(files: File[]) {
    const el = ref.current;
    if (!el || files.length === 0) return;
    const currentPlainText = spansToPlainText(htmlToSpans(el)).trim();

    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeLinkEditor();
    closeDateEditor();
    closePersonEditor();
    closePageEditor();
    void ops.uploadDroppedFiles(
      files,
      block.id,
      currentPlainText.length === 0 ? "replace" : "after"
    );
  }

  function showPastedUrlMenu(url: string) {
    const el = ref.current;
    if (!el) return;
    const spans: TextSpan[] = [{ text: url, link: url }];
    el.innerHTML = spansToHtml(spans);
    el.dataset.empty = "false";
    ops.setText(block.id, spans);
    placeCaret(el, url.length);
    const rect = el.getBoundingClientRect();
    const { left, top } = anchoredMenuPosition(
      rect,
      PASTED_URL_MENU_WIDTH,
      PASTED_URL_MENU_HEIGHT,
      6
    );
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });
    closeLinkEditor();
    closeDateEditor();
    closePersonEditor();
    closePageEditor();
    setPastedUrlMenu({
      url,
      left,
      top,
    });
  }

  async function convertPastedUrl(type: PastedUrlConversion) {
    if (!pastedUrlMenu) return;
    const url = pastedUrlMenu.url;
    if (type === "external_mention") {
      closePastedUrlMenu(false);
      let metadata: { url?: string; title?: string; iconUrl?: string } = {};
      try {
        metadata = await fetchUrlMetadataRemote(url);
      } catch {
        metadata = {};
      }
      const href = safeUrl(metadata.url) || url;
      const title = (metadata.title || pastedUrlFallbackTitle(href)).trim() || href;
      const iconUrl = safeUrl(metadata.iconUrl);
      const rich: TextSpan[] = [
        {
          text: title,
          mention: "external",
          link: href,
          ...(iconUrl && /^https?:/i.test(iconUrl) ? { iconUrl } : {}),
        },
      ];
      updateBlock(block.id, {
        type: "paragraph",
        content: { ...block.content, rich },
        plainText: title,
      });
      window.requestAnimationFrame(() => focusEditableSettled(block.id, "end"));
      return;
    }
    if (type === "page_mention" || type === "page_link") {
      const page = pastedUrlPage;
      if (!page) return;
      const title = pageTitle(page);
      if (type === "page_mention") {
        const rich: TextSpan[] = [{ text: title, mention: "page", pageId: page.id }];
        updateBlock(block.id, {
          type: "paragraph",
          content: { ...block.content, rich },
          plainText: title,
        });
        closePastedUrlMenu(false);
        window.requestAnimationFrame(() => focusEditableSettled(block.id, "end"));
        return;
      }
      updateBlock(block.id, {
        type: "link_to_page",
        content: { childPageId: page.id },
        plainText: title,
      });
      closePastedUrlMenu(false);
      ops.selectBlock(block.id);
      return;
    }
    const mediaContent = type === "image" || type === "video" || type === "audio";
    const fileContent = type === "file";
    updateBlock(block.id, {
      type,
      content: mediaContent ? { url, caption: [] } : fileContent ? { url, fileName: fileNameFromUrl(url) } : { url },
      plainText: fileContent ? fileNameFromUrl(url) : url,
    });
    closePastedUrlMenu(false);
    const nextBlock = {
      ...block,
      type: type as BlockType,
      content: mediaContent
        ? { url, caption: [] }
        : fileContent
          ? { url, fileName: fileNameFromUrl(url) }
          : { url },
    };
    if (!focusBlockWritingTarget(nextBlock)) ops.insertAfter(block.id, "paragraph");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;

    // A portalled editor menu can own the native key during document capture.
    // Its synchronous command may re-render this block before the same event
    // reaches React; never run the newly rendered block's normal Enter path a
    // second time after that menu already prevented the event.
    if (e.defaultPrevented) return;

    // The contenteditable DOM commits a keystroke before React's slash-menu
    // state is guaranteed to render. Short commands such as /h1 can therefore
    // receive Enter while `slash.open` is still false and incorrectly fall
    // through to paragraph splitting. Re-read the active DOM at confirmation
    // time. If SlashMenu already handled the capture-phase Enter it has
    // synchronously stripped the trigger, so this cannot apply twice.
    if (
      !composingRef.current &&
      !e.shiftKey &&
      (e.key === "Enter" || e.code === "Enter") &&
      applyDefaultSlashCommandAt(el, htmlToSpans(el), caretOffset(el))
    ) {
      e.preventDefault();
      composingEnterRef.current = false;
      compositionEnterHandledRef.current = true;
      compositionEnterGuardUntilRef.current = 0;
      return;
    }

    const composingKey = isComposingKeyEvent(e);
    const ambiguousProcessSlashConfirm =
      slash.open &&
      !composingRef.current &&
      !e.shiftKey &&
      (e.key === "Process" || e.key === "Unidentified") &&
      (e.keyCode === 229 || e.which === 229);
    if (composingKey || composingRef.current) {
      if (e.key === "Enter" || e.code === "Enter" || ambiguousProcessSlashConfirm) {
        // Korean IMEs can report Enter as keyCode 229 even when no composition
        // lifecycle was emitted for an ASCII slash query. Waiting for a
        // compositionend that will never arrive leaves the visible menu stuck.
        // If the committed DOM already contains a matching slash command,
        // apply it immediately; a real active composition still waits for its
        // normal compositionend path above.
        if (
          composingKey &&
          !composingRef.current &&
          !e.shiftKey &&
          applyDefaultSlashCommandAt(el, htmlToSpans(el), caretOffset(el))
        ) {
          e.preventDefault();
          composingEnterRef.current = false;
          compositionEnterHandledRef.current = true;
          compositionEnterGuardUntilRef.current = 0;
          return;
        }
        composingEnterRef.current = true;
        compositionEnterShiftRef.current = e.shiftKey;
      }
      return;
    }
    if (handlePostCompositionEnter(e, el)) {
      return;
    }
    compositionEnterGuardUntilRef.current = 0;

    if (mention.open) {
      const navKeys = [
        "ArrowDown",
        "ArrowUp",
        "Home",
        "End",
        "PageDown",
        "PageUp",
        "Enter",
        "Tab",
        "Escape",
      ];
      if (navKeys.includes(e.key)) return;
    }

    if (slash.open) {
      const navKeys = [
        "ArrowDown",
        "ArrowUp",
        "Home",
        "End",
        "PageDown",
        "PageUp",
        "Enter",
        "Tab",
        "Escape",
      ];
      if (navKeys.includes(e.key)) {
        // Only let the SlashMenu own these keys when it has something to show.
        if (e.key === "Escape" || matchBlocks(slash.query).length > 0) {
          return;
        }
        // No results → close the menu and let the key run its normal handler
        // (Enter splits, arrows navigate) instead of getting trapped.
        setSlash({ open: false, query: "" });
      }
    }

    if (e.key === "Escape" && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
      setSlash({ open: false, query: "" });
      setMention({ open: false, query: "" });
      closeLinkEditor();
      closeDateEditor();
      closePersonEditor();
      closePageEditor();
      window.getSelection()?.removeAllRanges();
      el.blur();
      ops.selectBlock(block.id);
      return;
    }

    const shortcutType = shortcutBlockType(e);
    if (shortcutType) {
      e.preventDefault();
      if (shortcutType === "child_page") {
        ops.createChildPage(block.id);
        return;
      }
      ops.changeType(block.id, shortcutType, caretOffset(el));
      return;
    }

    // Inline formatting shortcuts.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      if (e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSlash({ open: false, query: "" });
        setMention({ open: false, query: "" });
        closeLinkEditor(false);
        closeDateEditor(false);
        closePersonEditor(false);
        closePageEditor(false);
        closePastedUrlMenu(false);
        ops.openMoveDialog(block.id);
        return;
      }
      if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        setSlash({ open: false, query: "" });
        setMention({ open: false, query: "" });
        closeLinkEditor(false);
        closeDateEditor(false);
        closePersonEditor(false);
        closePageEditor(false);
        closePastedUrlMenu(false);
        const caret = caretOffset(el);
        const moved = ops.moveSelectedBlock(block.id, e.key === "ArrowUp" ? "up" : "down");
        if (moved) {
          ops.selectBlock(null);
          requestAnimationFrame(() => focusEditableSettled(block.id, caret));
        }
        return;
      }
      if (e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        applyLastColorShortcut();
        return;
      }
      if (e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        openCommentShortcut();
        return;
      }
      if (!e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if ((el.textContent?.length ?? 0) === 0 || isEditableFullySelected(el)) {
          setSlash({ open: false, query: "" });
          setMention({ open: false, query: "" });
          closeLinkEditor();
          closeDateEditor();
          closePersonEditor();
          closePageEditor();
          window.getSelection()?.removeAllRanges();
          el.blur();
          ops.selectBlock(block.id);
        } else {
          selectEditableContents(el);
        }
        return;
      }
      if (e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "s" || k === "x") {
          e.preventDefault();
          applyMark("strikethrough");
          return;
        }
      }
      if (e.key === "Enter") {
        if (block.type === "to_do") {
          e.preventDefault();
          updateBlock(block.id, {
            content: { ...block.content, checked: !block.content?.checked },
          });
        } else if (TOGGLE_BLOCKS.has(block.type)) {
          e.preventDefault();
          updateBlock(block.id, {
            content: { ...block.content, collapsed: !block.content?.collapsed },
          });
        } else if (block.type === "code") {
          e.preventDefault();
          ops.insertAfter(block.id, "paragraph");
        }
        return;
      }
      if (!e.shiftKey && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        setSlash({ open: false, query: "" });
        setMention({ open: false, query: "" });
        closeLinkEditor(false);
        closeDateEditor(false);
        closePersonEditor(false);
        closePageEditor(false);
        closePastedUrlMenu(false);
        ops.selectBlock(block.id);
        ops.openBlockActionMenu(block.id);
        return;
      }
      const k = e.key.toLowerCase();
      const map: Record<string, Parameters<typeof applyMark>[0]> = {
        b: "bold",
        i: "italic",
        u: "underline",
        e: "code",
        k: "link",
      };
      if (map[k]) {
        e.preventDefault();
        applyMark(map[k]);
        return;
      }
    }

    // Markdown shortcuts: trigger + space at block start. Code blocks keep
    // literal text, so "# ", "--- ", etc. must not transform while editing code.
    if (e.key === " " && block.type !== "code") {
      const off = caretOffset(el);
      const before = el.innerText.slice(0, off);
      const sc = MD_SHORTCUTS.find((s) => s.trigger === before);
      if (sc) {
        e.preventDefault();
        const spans = htmlToSpans(el);
        const [, after] = splitSpans(spans, off); // drop the trigger, keep the rest
        el.innerHTML = spansToHtml(after);
        el.dataset.empty = String(spansToPlainText(after).length === 0);
        ops.setText(block.id, after);
        if (sc.type === "divider") {
          ops.changeType(block.id, "divider");
          ops.insertAfter(block.id, "paragraph");
        } else if (sc.type === "equation") {
          const expression = spansToPlainText(after).trim();
          updateBlock(block.id, {
            type: "equation",
            content: { expression },
            plainText: expression,
          });
          focusEquationInput(block.id);
        } else if (sc.content) {
          // Collapse type + content into a single write so the to_do `checked`
          // flag and the trimmed rich text land together (avoids a stale
          // block.content read between changeType and updateBlock).
          updateBlock(block.id, {
            type: sc.type,
            content: { ...block.content, rich: after, ...sc.content },
            plainText: spansToPlainText(after),
          });
          requestAnimationFrame(() => {
            requestAnimationFrame(() => focusEditableSettled(block.id, "start"));
          });
        } else {
          ops.changeType(block.id, sc.type);
        }
        return;
      }
    }

    if (e.key === "Enter" && block.type === "code") {
      e.preventDefault();
      insertCodeLineBreak(el);
      return;
    }

    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      insertSoftBreak(el);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const spans = htmlToSpans(el);
      // A non-collapsed selection must be removed by the break, not carried into
      // one of the halves: keep the spans before the selection start, drop the
      // selected middle, and push the spans after the selection end down.
      const selection = selectionOffsetsIn(el);
      const off = caretOffset(el);
      const from = selection && selection.end > selection.start ? selection.start : off;
      const to = selection && selection.end > selection.start ? selection.end : off;
      const [before] = splitSpans(spans, from);
      const [, after] = splitSpans(spans, to);
      // trim current block's DOM to the part before the caret/selection
      el.innerHTML = spansToHtml(before);
      el.dataset.empty = String(before.length === 0);
      ops.splitBlock(block.id, before, after);
      return;
    }

    if (e.key === "Backspace") {
      if (isCaretAtStart(el)) {
        const handled = ops.backspace(block.id, htmlToSpans(el));
        if (handled) e.preventDefault();
      }
      return;
    }

    if (e.key === "Delete") {
      if (isCaretAtEnd(el)) {
        const handled = ops.deleteForward(block.id, htmlToSpans(el));
        if (handled) e.preventDefault();
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      // Inside a code block, Tab inserts literal indentation at the caret
      // rather than nesting the whole block; Shift+Tab reduces line indent.
      if (block.type === "code") {
        adjustCodeIndent(el, e.shiftKey ? "outdent" : "indent");
        return;
      }
      if (e.shiftKey) ops.outdentBlock(block.id);
      else ops.indentBlock(block.id);
      return;
    }

    const plainArrowKey = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
    if (plainArrowKey && e.key === "ArrowLeft" && isCaretAtStart(el)) {
      e.preventDefault();
      ops.arrowUp(block.id);
    } else if (plainArrowKey && e.key === "ArrowRight" && isCaretAtEnd(el)) {
      e.preventDefault();
      ops.arrowDown(block.id);
    } else if (plainArrowKey && e.key === "ArrowUp" && isCaretAtStart(el)) {
      e.preventDefault();
      ops.arrowUp(block.id);
    } else if (plainArrowKey && e.key === "ArrowDown" && isCaretAtEnd(el)) {
      e.preventDefault();
      ops.arrowDown(block.id);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (block.type !== "code") {
      const files = Array.from(e.clipboardData.files).filter((file) => file.size > 0);
      if (files.length > 0) {
        e.preventDefault();
        void applyClipboardFiles(files);
        return;
      }
    }

    const text = e.clipboardData.getData("text/plain");
    const internalBlocks = block.type !== "code" ? parseInternalPastedBlocks(e.clipboardData) : [];
    const html = block.type !== "code" ? e.clipboardData.getData("text/html") : "";
    const htmlBlocks =
      internalBlocks.length === 0 && html ? parsePastedHtml(html) : [];
    if (block.type !== "code" && internalBlocks.length === 0) {
      const pastedLink = normalizePastedLink(text);
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (pastedLink && range && !range.collapsed && rangeInsideEditable(range)) {
        e.preventDefault();
        if (replaceSelectionWithPageMention(range, pastedLink)) return;
        document.execCommand("createLink", false, pastedLink);
        onInput();
        return;
      }
    }

    // Structured paste applies to every text-bearing block type — falling
    // through to the browser's native rich-text paste would inject foreign
    // markup into headings, lists, quotes, callouts and toggles.
    if (!TEXT_BLOCKS.has(block.type)) return;

    if (block.type === "code") {
      // Code takes the clipboard as literal plain text at the caret; the
      // native paste would insert the clipboard's HTML markup instead.
      const insert = text.replace(/\r\n?/g, "\n");
      if (!insert) return;
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      const spans = htmlToSpans(el);
      const selection = selectionOffsetsIn(el);
      const off = caretOffset(el);
      const from = selection && selection.end > selection.start ? selection.start : off;
      const to = selection && selection.end > selection.start ? selection.end : off;
      const [before] = splitSpans(spans, from);
      const [, after] = splitSpans(spans, to);
      const next = concatSpans(concatSpans(before, [{ text: insert }]), after);
      el.innerHTML = spansToHtml(next);
      el.dataset.empty = String(spansToPlainText(next).length === 0);
      ops.setText(block.id, next);
      placeCaret(el, spansToPlainText(before).length + insert.length);
      return;
    }

    if (internalBlocks.length === 0 && htmlBlocks.length === 0 && !text.trim()) return;
    const pastedOnlyUrl = normalizePastedLink(text);
    const existing = spansToPlainText(block.content?.rich).trim() || (ref.current?.innerText ?? "").trim();
    if (
      block.type === "paragraph" &&
      internalBlocks.length === 0 &&
      htmlBlocks.length === 0 &&
      pastedOnlyUrl &&
      existing.length === 0 &&
      !text.trim().includes("\n")
    ) {
      e.preventDefault();
      showPastedUrlMenu(pastedOnlyUrl);
      return;
    }
    const parsed =
      internalBlocks.length > 0
        ? internalBlocks
        : htmlBlocks.length > 0
          ? htmlBlocks
          : parsePastedMarkdown(text);
    if (parsed.length === 0) return;
    const structured =
      internalBlocks.length > 0 ||
      isStructuredHtmlPaste(htmlBlocks) ||
      (!existing && internalBlocks.length === 0 && isSingleRichParagraphHtmlPaste(htmlBlocks)) ||
      text.includes("\n") ||
      parsed.some((item) => item.type !== "paragraph");
    if (!structured) return;

    e.preventDefault();
    setSlash({ open: false, query: "" });
    setMention({ open: false, query: "" });

    if (block.type !== "paragraph") {
      insertStructuredPasteIntoTextBlock(parsed);
      return;
    }

    if (!existing) {
      ops.replaceWithBlocks(block.id, parsed);
      return;
    }

    // Block already has text: split at the caret (or replace a non-collapsed
    // selection), keep the head in this block, insert the parsed blocks after
    // it, then a trailing paragraph for the tail.
    const el = ref.current;
    const spans = el ? htmlToSpans(el) : block.content?.rich ?? [];
    const selection = el ? selectionOffsetsIn(el) : null;
    const off = el ? caretOffset(el) : spansToPlainText(block.content?.rich).length;
    const from = selection && selection.end > selection.start ? selection.start : off;
    const to = selection && selection.end > selection.start ? selection.end : off;
    const [before] = splitSpans(spans, from);
    const [, after] = splitSpans(spans, to);
    if (el) {
      el.innerHTML = spansToHtml(before);
      el.dataset.empty = String(before.length === 0);
    }
    ops.setText(block.id, before);
    const toInsert: PastedBlock[] = [...parsed];
    if (after.length > 0) {
      toInsert.push({
        type: "paragraph",
        content: { rich: after },
        plainText: spansToPlainText(after),
      });
    }
    ops.insertBlocksAfter(block.id, toInsert);
  }

  // Merge a structured paste into a non-paragraph text block (heading, list
  // item, quote, callout, toggle…): the first pasted block's text lands at the
  // caret while the block keeps its type, and the remaining pasted blocks are
  // inserted after it. Text after the caret moves to a trailing paragraph when
  // new blocks are inserted in between.
  function insertStructuredPasteIntoTextBlock(parsed: PastedBlock[]) {
    const el = ref.current;
    const spans = el ? htmlToSpans(el) : block.content?.rich ?? [];
    const selection = el ? selectionOffsetsIn(el) : null;
    const off = el ? caretOffset(el) : spansToPlainText(block.content?.rich).length;
    const from = selection && selection.end > selection.start ? selection.start : off;
    const to = selection && selection.end > selection.start ? selection.end : off;
    const [before] = splitSpans(spans, from);
    const [, after] = splitSpans(spans, to);
    const [first, ...rest] = parsed;
    // A first block that carries children must stay a standalone block —
    // merging only its text would silently drop the nested content.
    const mergeable = first && !(first.children && first.children.length > 0);
    const firstSpans = mergeable ? pastedBlockTextSpans(first) : null;
    const head = firstSpans ? concatSpans(before, firstSpans) : before;
    const toInsert: PastedBlock[] = firstSpans ? [...rest] : [...parsed];
    const inline = toInsert.length === 0 ? concatSpans(head, after) : head;
    if (el) {
      el.innerHTML = spansToHtml(inline);
      el.dataset.empty = String(spansToPlainText(inline).length === 0);
    }
    ops.setText(block.id, inline);
    if (toInsert.length === 0) {
      if (el) placeCaret(el, spansToPlainText(head).length);
      return;
    }
    if (after.length > 0) {
      toInsert.push({
        type: "paragraph",
        content: { rich: after },
        plainText: spansToPlainText(after),
      });
    }
    ops.insertBlocksAfter(block.id, toInsert);
  }

  const editable = (
    <div
      ref={(el) => {
        ref.current = el;
        registerEditable(block.id, el);
      }}
      className={styles.editable}
      contentEditable={!ops.readOnly}
      role="textbox"
      tabIndex={0}
      aria-label={blockTextBoxLabel(block)}
      aria-readonly={ops.readOnly}
      aria-multiline="true"
      aria-placeholder={placeholder}
      suppressContentEditableWarning
      spellCheck
      data-rt-editable="true"
      data-template-block-key={
        ops.templateMode ? block.id.match(/:block:(.+)$/)?.[1] : undefined
      }
      data-placeholder={placeholder}
      data-empty={spansToPlainText(block.content?.rich).length === 0 ? "true" : "false"}
      data-page-placeholder={pagePlaceholder ? "true" : undefined}
      data-database-source-picker-open={databasePicker ? "true" : undefined}
      onInput={ops.readOnly ? undefined : onInput}
      onFocus={() => {
        if (!ops.readOnly) {
          ops.selectBlock(null);
          publishEditableAwareness("editing");
        }
      }}
      onBlur={() => {
        // Slash and mention menus are portalled per block and listen on the
        // document. Close the owner menu as soon as editing moves elsewhere so
        // a stale menu cannot consume Enter intended for another block.
        setSlash({ open: false, query: "" });
        setMention({ open: false, query: "" });
      }}
      onClick={onEditableClick}
      onCompositionStart={ops.readOnly ? undefined : onCompositionStart}
      onCompositionEnd={ops.readOnly ? undefined : onCompositionEnd}
      onKeyDown={ops.readOnly ? undefined : onKeyDown}
      onPaste={ops.readOnly ? undefined : onPaste}
    />
  );

  // ── Type-specific layouts ──────────────────────────────────────────
  let body: React.ReactNode;
  switch (block.type) {
    case "to_do": {
      const checked = !!block.content?.checked;
      body = (
        <div className={styles.todo} data-checked={checked}>
          <input
            type="checkbox"
            checked={checked}
            disabled={ops.readOnly}
            aria-label={blockItemText(
              checked ? "todo.markIncomplete" : "todo.markComplete"
            )}
            onChange={() =>
              updateBlock(block.id, {
                content: { ...block.content, checked: !checked },
              })
            }
          />
          {editable}
        </div>
      );
      break;
    }
    case "bulleted_list_item":
      body = (
        <div className={styles.bullet}>
          <span className={styles.bulletDot}>•</span>
          {editable}
        </div>
      );
      break;
    case "numbered_list_item":
      body = (
        <div className={styles.bullet}>
          <span className={styles.numDot}>{numberedIndex}.</span>
          {editable}
        </div>
      );
      break;
    case "toggle":
    case "toggle_heading_1":
    case "toggle_heading_2":
    case "toggle_heading_3":
    case "toggle_heading_4": {
      const collapsed = !!block.content?.collapsed;
      const isHeadingToggle = block.type !== "toggle";
      body = (
        <div
          className={isHeadingToggle ? styles.toggleHeading : styles.toggle}
          data-level={HEADING_LEVEL[block.type] ?? undefined}
        >
          <button
            type="button"
            className={`${styles.toggleCaret} ${collapsed ? "" : styles.toggleOpen}`}
            aria-label={blockItemText(collapsed ? "toggle.open" : "toggle.close")}
            aria-expanded={!collapsed}
            title={blockItemText(collapsed ? "common.open" : "common.close")}
            onClick={() =>
              updateBlock(block.id, {
                content: { ...block.content, collapsed: !collapsed },
              })
            }
          >
            <CaretRightFill className={styles.toggleCaretIcon} size={13} aria-hidden="true" />
          </button>
          {editable}
        </div>
      );
      break;
    }
    case "quote":
      body = <div className={styles.quote}>{editable}</div>;
      break;
    case "callout":
      body = (
        <div
          className={[
            styles.callout,
            isQuietImportedCallout ? styles.calloutQuiet : "",
            isImportedDatabaseSectionCallout ? styles.calloutDatabaseSection : "",
          ].filter(Boolean).join(" ")}
          data-imported-database-section={isImportedDatabaseSectionCallout ? "true" : undefined}
        >
          {showCalloutIcon && (
            <span className={styles.calloutIconWrap} contentEditable={false}>
              <button
                type="button"
                className={styles.calloutIcon}
                aria-label={blockItemText("callout.changeIcon")}
                aria-haspopup="dialog"
                aria-expanded={calloutIconOpen}
                title={blockItemText("callout.changeIcon")}
                disabled={ops.readOnly}
                onClick={() => {
                  if (!ops.readOnly) setCalloutIconOpen(true);
                }}
              >
                {block.content?.icon || "💡"}
              </button>
              {!ops.readOnly && calloutIconOpen && (
                <EmojiPicker
                  placement="inline"
                  onPick={(emoji) => {
                    updateBlock(block.id, { content: { ...block.content, icon: emoji } });
                    setCalloutIconOpen(false);
                  }}
                  onClose={() => setCalloutIconOpen(false)}
                />
              )}
            </span>
          )}
          <div className={styles.calloutContent}>
            {!hideImportedEmptyCalloutText && editable}
            {calloutChildren.length > 0 && (
              <div className={styles.calloutChildren}>
                {calloutChildren.map((child) => (
                  <BlockItem key={child.id} block={child} ops={ops} depth={depth + 1} />
                ))}
              </div>
            )}
          </div>
        </div>
      );
      break;
    case "code": {
      const language = block.content?.language ?? "";
      const languageLabel = codeLanguages().find((option) => option.value === language)?.label;
      const isMermaid = language === "mermaid";
      const lineNumbers = !!block.content?.lineNumbers;
      const wrap = !!block.content?.wrap;
      const codeText = spansToPlainText(block.content?.rich);
      // Show a highlighted, read-only overlay when the block isn't being edited,
      // and only when a highlightable language is selected. While editing we show
      // the plain editable so the caret/selection stay intact.
      const showHighlight =
        !codeFocused && !isMermaid && !!language && codeText.length > 0;
      const lineCount = codeText.length ? codeText.split("\n").length : 1;
      body = (
        <div
          className={styles.codeBlock}
          contentEditable={false}
          data-line-numbers={lineNumbers ? "true" : undefined}
          data-wrap={wrap ? "true" : undefined}
        >
          {language && languageLabel && (
            <div className={styles.codeLangBadge} aria-hidden="true">
              {languageLabel}
            </div>
          )}
          <div className={styles.codeToolbar}>
            <NotionSelect
              className={styles.codeLanguageSelect}
              buttonClassName={styles.codeLanguageButton}
              backdropClassName={styles.editorSelectBackdrop}
              menuClassName={styles.codeLanguageMenu}
              optionClassName={styles.codeLanguageOption}
              ariaLabel={blockItemText("code.language")}
              value={language}
              disabled={ops.readOnly}
              options={codeLanguages().map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(next) =>
                updateBlock(block.id, {
                  content: { ...block.content, language: next || undefined },
                })
              }
            />
            <button
              type="button"
              className={styles.codeOption}
              aria-label={blockItemText("code.toggleLineNumbers")}
              aria-pressed={lineNumbers}
              data-active={lineNumbers ? "true" : undefined}
              title={blockItemText("code.showLineNumbers")}
              disabled={ops.readOnly}
              onClick={() =>
                updateBlock(block.id, {
                  content: { ...block.content, lineNumbers: !lineNumbers },
                })
              }
            >
              #
            </button>
            <button
              type="button"
              className={styles.codeOption}
              aria-label={blockItemText("code.toggleWrap")}
              aria-pressed={wrap}
              data-active={wrap ? "true" : undefined}
              title={blockItemText("code.wrap")}
              disabled={ops.readOnly}
              onClick={() =>
                updateBlock(block.id, {
                  content: { ...block.content, wrap: !wrap },
                })
              }
            >
              ↵
            </button>
            <button
              type="button"
              className={styles.codeCopy}
              aria-label={blockItemText("code.copy")}
              onClick={copyCode}
            >
              {blockItemText(copied ? "common.copied" : "common.copy")}
            </button>
          </div>
          <div
            className={styles.codeBody}
            onFocusCapture={() => setCodeFocused(true)}
            onBlurCapture={() => setCodeFocused(false)}
          >
            {lineNumbers && (
              <div className={styles.codeGutter} aria-hidden="true">
                {Array.from({ length: lineCount }, (_, i) => (
                  <span key={i}>{i + 1}</span>
                ))}
              </div>
            )}
            <div className={styles.codeStack}>
              <pre className={styles.code} data-hidden={showHighlight ? "true" : undefined}>
                {editable}
              </pre>
              {showHighlight && (
                <pre
                  className={styles.codeHighlighted}
                  aria-hidden="true"
                  onMouseDown={(e) => {
                    // Clicking the highlighted overlay focuses the editable so
                    // editing resumes at the click point.
                    e.preventDefault();
                    ref.current?.focus();
                  }}
                >
                  <Suspense fallback={<code className="hljs">{codeText || "\u200b"}</code>}>
                    <CodeHighlight code={codeText} language={language} />
                  </Suspense>
                </pre>
              )}
            </div>
          </div>
          {isMermaid && (
            <Suspense
              fallback={
                <div
                  className={styles.mermaidPreview}
                  contentEditable={false}
                  role="img"
                  aria-label={blockItemText("code.diagramPreview")}
                >
                  <div className={styles.mermaidEmpty}>
                    {blockItemText("code.diagramPreview")}
                  </div>
                </div>
              }
            >
              <MermaidPreview source={codeText} blockId={block.id} />
            </Suspense>
          )}
          <div
            ref={(el) => {
              codeCaptionRef.current = el;
            }}
            className={styles.codeCaption}
            contentEditable={!ops.readOnly}
            role="textbox"
            tabIndex={0}
            aria-label={blockItemText("code.caption")}
            aria-readonly={ops.readOnly}
            aria-multiline="false"
            aria-placeholder={blockItemText("common.addCaption")}
            suppressContentEditableWarning
            spellCheck
            data-rt-editable="true"
            data-placeholder={blockItemText("common.addCaption")}
            onKeyDown={ops.readOnly ? undefined : (e) => onSingleLineCaptionKeyDown(e, block, ops)}
            onInput={ops.readOnly ? undefined : onCodeCaptionInput}
            onPaste={ops.readOnly ? undefined : onSingleLineCaptionPaste}
          />
        </div>
      );
      break;
    }
    default:
      body = editable;
  }

  const pastedUrlAssetType = pastedUrlMenu ? blockTypeForPastedAssetUrl(pastedUrlMenu.url) : null;
  const pastedUrlCanCreateExternalMention =
    !!pastedUrlMenu && !pastedUrlPage && isExternalPastedWebUrl(pastedUrlMenu.url);
  const currentLinkUrl = normalizePastedLink(linkValue) || safeUrl(linkValue.trim());

  return (
    <BlockFrame block={block} ops={ops} depth={depth} renderChildren={block.type !== "callout"}>
      {body}
      <RemoteTextAwarenessOverlay
        awareness={remoteTextAwareness}
        editableRef={ref}
        revision={textAwarenessRevision}
      />
      {slash.open && (
        <SlashMenu
          anchor={slash.anchor}
          query={slash.query}
          templateMode={ops.templateMode}
          ownerBlockId={block.id}
          onPick={applyType}
          onClose={dismissSlash}
        />
      )}
      {databasePicker && (
        <DatabaseSourcePicker
          anchor={databasePicker.anchor}
          type={databasePicker.type}
          viewType={databasePicker.viewType}
          onCreate={() => createDatabaseFromPicker(databasePicker)}
          onLink={(databaseId) => linkDatabaseFromPicker(databasePicker, databaseId)}
          onClose={() => closeDatabasePicker(true)}
        />
      )}
      {mention.open && (
        <MentionMenu
          anchor={mention.anchor}
          query={mention.query}
          mode={mention.trigger ?? "mention"}
          onPick={(item) => void applyMention(item, mention.trigger ?? "mention")}
          onClose={() => setMention({ open: false, query: "" })}
        />
      )}
      {pastedUrlMenu && (
        <TextFloatingMenuPortal>
          <div
            ref={pastedUrlMenuRef}
            className={styles.pastedUrlMenu}
            style={{ top: pastedUrlMenu.top, left: pastedUrlMenu.left }}
            role="dialog"
            aria-label={blockItemText("pastedLink.options")}
            contentEditable={false}
            onMouseDown={(e) => e.preventDefault()}
            onKeyDown={onPastedUrlMenuKeyDown}
          >
            <div className={styles.pastedUrlTitle}>{blockItemText("pastedLink.pasteAs")}</div>
            {pastedUrlPage && (
              <>
                <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("page_mention")}>
                  <PageIconGlyph page={pastedUrlPage} size={15} />
                  {blockItemText("pastedLink.mentionPage")}
                </button>
                <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("page_link")}>
                  <LinkIcon size={15} aria-hidden="true" />
                  {blockItemText("pageLink.linkToPage")}
                </button>
              </>
            )}
            {pastedUrlCanCreateExternalMention && (
              <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("external_mention")}>
                <LinkIcon size={15} aria-hidden="true" />
                {blockItemText("mention.label")}
              </button>
            )}
            {pastedUrlAssetType === "image" && (
              <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("image")}>
                <ImageIcon size={15} aria-hidden="true" />
                {blockItemText("pastedLink.createImage")}
              </button>
            )}
            {pastedUrlAssetType === "video" && (
              <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("video")}>
                <VideoIcon size={15} aria-hidden="true" />
                {blockItemText("pastedLink.createVideo")}
              </button>
            )}
            {pastedUrlAssetType === "audio" && (
              <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("audio")}>
                <AudioIcon size={15} aria-hidden="true" />
                {blockItemText("pastedLink.createAudio")}
              </button>
            )}
            {pastedUrlAssetType === "file" && (
              <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("file")}>
                <FileText size={15} aria-hidden="true" />
                {blockItemText("pastedLink.createFile")}
              </button>
            )}
            <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("bookmark")}>
              <BookmarkIcon size={15} aria-hidden="true" />
              {blockItemText("bookmark.label")}
            </button>
            <button type="button" data-pasted-url-option onClick={() => void convertPastedUrl("embed")}>
              <OpenInNew size={15} aria-hidden="true" />
              {blockItemText("common.embed")}
            </button>
            <button type="button" data-pasted-url-option onClick={() => closePastedUrlMenu(true)}>
              <OpenInNew size={15} aria-hidden="true" />
              {blockItemText("pastedLink.url")}
            </button>
          </div>
        </TextFloatingMenuPortal>
      )}
      {linkEditor && (
        <TextFloatingMenuPortal>
          <div
            ref={linkMenuRef}
            className={styles.inlineLinkMenu}
            style={{ top: linkEditor.top, left: linkEditor.left }}
            role="dialog"
            aria-label={blockItemText("linkEditor.edit")}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onLinkMenuKeyDown}
            contentEditable={false}
          >
            <input
              ref={linkInputRef}
              value={linkValue}
              placeholder={blockItemText("linkEditor.pastePlaceholder")}
              aria-label={blockItemText("linkEditor.url")}
              onChange={(e) => setLinkValue(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingKeyEvent(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLinkValue();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeLinkEditor(true);
                }
              }}
            />
            <button type="button" onClick={openCurrentLink} disabled={!currentLinkUrl}>
              <OpenInNew size={14} aria-hidden="true" />
              {blockItemText("linkEditor.open")}
            </button>
            <button type="button" onClick={() => void copyCurrentLink()} disabled={!currentLinkUrl}>
              <Copy size={14} aria-hidden="true" />
              {blockItemText(linkCopied ? "common.copied" : "common.copyLink")}
            </button>
            <button type="button" onClick={applyLinkValue}>
              <LinkIcon size={14} aria-hidden="true" />
              {blockItemText("common.save")}
            </button>
            <button type="button" onClick={removeLink}>
              <Trash size={14} aria-hidden="true" />
              {blockItemText("common.remove")}
            </button>
          </div>
        </TextFloatingMenuPortal>
      )}
      {dateEditor && (
        <TextFloatingMenuPortal>
          <div
            ref={dateMenuRef}
            className={styles.inlineDateMenu}
            style={{ top: dateEditor.top, left: dateEditor.left }}
            role="dialog"
            aria-label={blockItemText("date.editMention")}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onDateMenuKeyDown}
            contentEditable={false}
          >
            <div className={styles.inlineDateHeader}>
              <CalendarIcon size={15} aria-hidden="true" />
              <span>{blockItemText("date.label")}</span>
            </div>
            <input
              ref={dateInputRef}
              type="date"
              value={dateEditor.value}
              aria-label={blockItemText("date.mention")}
              onChange={(e) => setDateMentionDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingKeyEvent(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyDateMention();
                }
              }}
            />
            {dateCalendar && (
              <div className={styles.inlineDateCalendar}>
                <div className={styles.inlineDateMonth}>
                  <button
                    type="button"
                    aria-label={blockItemText("date.previousMonth")}
                    onClick={() => shiftDateCalendar(-1)}
                  >
                    <ChevronLeft size={14} aria-hidden="true" />
                  </button>
                  <span>{dateCalendar.label}</span>
                  <button
                    type="button"
                    aria-label={blockItemText("date.nextMonth")}
                    onClick={() => shiftDateCalendar(1)}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.inlineDateWeekdays} aria-hidden="true">
                  {weekdayLabels().map((label, index) => (
                    <span key={`${label}-${index}`}>{label}</span>
                  ))}
                </div>
                <div className={styles.inlineDateGrid}>
                  {dateCalendar.days.map((day) => (
                    <button
                      type="button"
                      key={day.iso}
                      className={styles.inlineDateDay}
                      data-date-day={day.iso}
                      data-outside={day.outside ? "true" : undefined}
                      data-selected={day.selected ? "true" : undefined}
                      data-today={day.today ? "true" : undefined}
                      aria-label={day.iso}
                      aria-pressed={day.selected}
                      onClick={() => applyDateMention(day.iso)}
                    >
                      {day.day}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className={styles.inlineDateActions}>
              <button type="button" onClick={() => applyDateMention(localIsoDate(0))}>
                {blockItemLabels().mentionToday}
              </button>
              <button type="button" onClick={() => applyDateMention(localIsoDate(1))}>
                {blockItemLabels().mentionTomorrow}
              </button>
            </div>
            <div className={styles.inlineDateActions}>
              <button type="button" onClick={() => applyDateMention()}>
                {blockItemText("common.done")}
              </button>
              <button type="button" className={styles.inlineDateDanger} onClick={removeDateMention}>
                {blockItemText("common.remove")}
              </button>
            </div>
          </div>
        </TextFloatingMenuPortal>
      )}
      {personEditor && (
        <TextFloatingMenuPortal>
          <div
            ref={personMenuRef}
            className={styles.inlinePersonMenu}
            style={{ top: personEditor.top, left: personEditor.left }}
            role="dialog"
            aria-label={blockItemText("person.mention")}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onPersonMenuKeyDown}
            contentEditable={false}
          >
            <div className={styles.inlinePersonTop}>
              <span className={styles.inlinePersonAvatar} aria-hidden="true">
                {personInitials(personEditor.userId, useStore.getState().userId)}
              </span>
              <span className={styles.inlinePersonInfo}>
                <span className={styles.inlinePersonName}>{personEditor.label}</span>
                <span className={styles.inlinePersonMeta}>
                  {blockItemText("person.workspaceMember")}
                </span>
              </span>
            </div>
            <button type="button" className={styles.inlinePersonAction} onClick={() => void copyMentionedPerson()}>
              <Copy size={14} aria-hidden="true" />
              {blockItemText(personEditor.copied ? "common.copied" : "person.copyName")}
            </button>
            <div className={styles.inlinePersonFoot}>
              <UserIcon size={14} aria-hidden="true" />
              {blockItemText("person.profile")}
            </div>
          </div>
        </TextFloatingMenuPortal>
      )}
      {pageEditor && (
        <TextFloatingMenuPortal>
          <div
            ref={pageMenuRef}
            className={styles.inlinePageMenu}
            style={{ top: pageEditor.top, left: pageEditor.left }}
            role="dialog"
            aria-label={blockItemText("pageLink.mention")}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onPageMenuKeyDown}
            contentEditable={false}
          >
            <div className={styles.inlinePageTop}>
              <span className={styles.inlinePageIcon} aria-hidden="true">
                {pageEditor.page ? (
                  <PageIconGlyph page={pageEditor.page} size={18} />
                ) : (
                  <LinkIcon size={16} />
                )}
              </span>
              <span className={styles.inlinePageInfo}>
                <span className={styles.inlinePageTitle}>{pageEditor.title}</span>
                <span className={styles.inlinePagePath}>{pageEditor.path}</span>
              </span>
            </div>
            <div className={styles.inlinePageActions}>
              <button type="button" onClick={openMentionedPage}>
                <OpenInNew size={14} aria-hidden="true" />
                {blockItemText("common.open")}
              </button>
              <button type="button" onClick={() => void copyMentionedPageLink()}>
                <Copy size={14} aria-hidden="true" />
                {blockItemText(pageEditor.copied ? "common.copied" : "common.copyLink")}
              </button>
            </div>
          </div>
        </TextFloatingMenuPortal>
      )}
    </BlockFrame>
  );
}
