"use client";

import { Suspense, type CompositionEvent as ReactCompositionEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { copyText } from "@/lib/clipboard";
import { fetchUrlMetadataRemote } from "@/lib/edgebase";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { absolutePageUrl, pageHref } from "@/lib/navigation";
import { pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageIdFromPageHref } from "@/lib/pageLinks";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { PageAwarenessMode } from "@/lib/pagePresence";
import type { Block, BlockType, Page, TextSpan } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import { useStore } from "@/lib/store";
import { NotionSelect } from "../database/NotionSelect";
import { personInitials, personLabel } from "../database/people";
import { EmojiPicker } from "../EmojiPicker";
import { PageIconGlyph } from "../PageIcon";
import { AudioIcon, BookmarkIcon, CalendarIcon, CaretRightFill, ChevronLeft, ChevronRight, Copy, FileText, ImageIcon, LinkIcon, OpenInNew, Trash, UserIcon, VideoIcon } from "../icons";
import { caretOffset, focusEditableSettled, isEditableFullySelected, isCaretAtEnd, isCaretAtStart, placeCaret, selectionOffsetsIn, registerEditable, selectEditableContents } from "./focus";
import { concatSpans, escapeHtml, htmlToSpans, safeUrl, spansToHtml, splitSpans } from "./richtext";
import { blockDefPlaceholder, getDef, matchBlocks, MD_SHORTCUTS, TEXT_BLOCKS, type BlockDef } from "./blocks";
import { SlashMenu, type SlashMenuAnchor } from "./SlashMenu";
import { DatabaseSourcePicker, MentionMenu, pageTitle, type DatabaseSourcePickerRequest, type MentionItem, type MentionState, type MentionTrigger } from "./BlockPickerMenus";
import { blockItemLabels, blockItemText } from "./blockItemLabels";
import { getLastEditorColor, rememberEditorColor } from "./colorMemory";
import { dateMentionLabel, nextDateMentionRefreshDelay } from "./dateMentions";
import { localIsoDate, mentionCalendar, monthStartForDate, parseLocalIsoDate, shiftDateByDays, shiftDateByMonths, shiftMonth, weekEdgeDate, weekdayLabels } from "./mentionCalendarModel";
import { blockTypeForPastedAssetUrl } from "./mediaEmbeds";
import { clearNativeInlineTypingState, findInlineMarkdownLinkShortcut, findInlineMarkdownShortcut, findInlineSymbolShortcut, findTypedAutoLinkShortcut, inlineSymbolReplacementSpan, isExternalPastedWebUrl, isSingleRichParagraphHtmlPaste, isStructuredHtmlPaste, normalizePastedLink, pastedBlockTextSpans, pastedUrlFallbackTitle, shortcutBlockType, typedMarkdownBlockFromText, unescapeMarkdownLinkLabelSpans, type PastedUrlConversion } from "./editorInputModel";
import type { EditorOps } from "./Editor";
import { parseInternalPastedBlocks, parsePastedHtml, parsePastedMarkdown, type PastedBlock } from "./markdownPaste";
import styles from "./editor.module.css";
import type { TextBlockRuntime } from "./BlockItem";

type InlineMenuAnchor = Pick<DOMRect, "left" | "top" | "bottom">;

export function TextBlock({
  runtime,
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
  runtime: () => TextBlockRuntime;
}) {
  const {
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
  } = runtime();

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
  }, [block.id, block.type, block.content?.rich, dateMentionRenderTick, editableHtmlMatches]);

  useEffect(() => {
    if (block.type !== "code") return;
    const el = codeCaptionRef.current;
    if (!el) return;
    const html = spansToHtml(block.content?.caption);
    if (!editableHtmlMatches(el, html)) el.innerHTML = html;
    el.dataset.empty = String(spansToPlainText(block.content?.caption).length === 0);
  }, [block.id, block.type, block.content?.caption, editableHtmlMatches]);

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
  }, [PASTED_URL_MENU_REQUEST, block.id]);

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
  }, [INLINE_DATE_MENU_HEIGHT, INLINE_DATE_MENU_WIDTH, anchoredMenuPosition, dateEditor]);

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
  }, [
    INLINE_PERSON_MENU_HEIGHT,
    INLINE_PERSON_MENU_WIDTH,
    anchoredMenuPosition,
    personEditor,
  ]);

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
  }, [INLINE_PAGE_MENU_HEIGHT, INLINE_PAGE_MENU_WIDTH, anchoredMenuPosition, pageEditor]);

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
