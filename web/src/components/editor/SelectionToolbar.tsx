"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageIdFromPageHref } from "@/lib/pageLinks";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Block, BlockContent, BlockType, TextSpan } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import { useStore } from "@/lib/store";
import { BlockIcon } from "./BlockIcon";
import { rememberEditorColor } from "./colorMemory";
import { focusEditable } from "./focus";
import { CheckIcon, ChevronDown, CommentIcon, Copy, LinkIcon, OpenInNew } from "../icons";
import {
  concatSpans,
  escapeHtml,
  htmlToSpans,
  safeUrl,
  spansToHtml,
  splitSpans,
} from "./richtext";
import styles from "./editor.module.css";

type Mark = "bold" | "italic" | "underline" | "strikethrough" | "code" | "link";
type ActiveMarks = Record<Mark, boolean>;
type ActiveColor = string | "mixed";
type TextSelectionSnapshot = {
  editable: HTMLElement;
  start: number;
  end: number;
};

const INACTIVE_MARKS: ActiveMarks = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  code: false,
  link: false,
};

const MARK_SELECTORS: Record<Mark, string> = {
  bold: "strong,b",
  italic: "em,i",
  underline: "u",
  strikethrough: "s,strike,del",
  code: "code",
  link: "a[href]",
};

// Block types the floating toolbar can convert a text selection into, mirroring
// the most-used entries of the block handle's "Turn into" list.
const TURN_OPTIONS: { type: BlockType; label: string; glyph: string }[] = [
  { type: "paragraph", label: "selectionToolbar:turnInto.options.text", glyph: "¶" },
  { type: "heading_1", label: "selectionToolbar:turnInto.options.heading1", glyph: "H1" },
  { type: "heading_2", label: "selectionToolbar:turnInto.options.heading2", glyph: "H2" },
  { type: "heading_3", label: "selectionToolbar:turnInto.options.heading3", glyph: "H3" },
  { type: "heading_4", label: "selectionToolbar:turnInto.options.heading4", glyph: "H4" },
  { type: "to_do", label: "selectionToolbar:turnInto.options.toDoList", glyph: "☑" },
  { type: "bulleted_list_item", label: "selectionToolbar:turnInto.options.bulletedList", glyph: "•" },
  { type: "numbered_list_item", label: "selectionToolbar:turnInto.options.numberedList", glyph: "1." },
  { type: "toggle", label: "selectionToolbar:turnInto.options.toggleList", glyph: "▸" },
  { type: "quote", label: "selectionToolbar:turnInto.options.quote", glyph: "❝" },
  { type: "callout", label: "selectionToolbar:turnInto.options.callout", glyph: "💡" },
  { type: "code", label: "selectionToolbar:turnInto.options.code", glyph: "</>" },
];
const TURN_MENU_WIDTH = 220;
const TURN_MENU_MAX_HEIGHT = 360;

function textContentForTurnInto(block?: Block): BlockContent {
  const rich = (
    block?.content?.rich ??
    block?.content?.caption ??
    (block?.content?.expression ? [{ text: block.content.expression }] : undefined) ??
    (block?.plainText ? [{ text: block.plainText }] : [])
  ).map((span) => ({ ...span }));
  return {
    rich,
    ...(block?.content?.color ? { color: block.content.color } : {}),
  };
}

function turnIntoPatch(block: Block | undefined, type: BlockType): Partial<Block> {
  const content = textContentForTurnInto(block);
  if (type === "to_do") content.checked = false;
  if (type === "callout") content.icon = block?.content?.icon ?? "💡";
  return {
    type,
    content,
    plainText: spansToPlainText(content.rich),
  };
}

// All distinct block ids the selection range touches, in document order.
function blockIdsInRange(range: Range): { ids: string[]; pageId: string | null } {
  const editables = new Set<HTMLElement>();
  const collect = (node: Node | null) => {
    const el = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
    const editable = el?.closest<HTMLElement>("[data-rt-editable]");
    if (editable) editables.add(editable);
  };
  collect(range.startContainer);
  collect(range.endContainer);
  // Walk every editable in the document and keep those the range intersects.
  document.querySelectorAll<HTMLElement>("[data-rt-editable]").forEach((el) => {
    if (range.intersectsNode(el)) editables.add(el);
  });
  const ids: string[] = [];
  let pageId: string | null = null;
  document
    .querySelectorAll<HTMLElement>("[data-block-id][data-page-id]")
    .forEach((group) => {
      const editable = group.querySelector<HTMLElement>("[data-rt-editable]");
      if (!editable || !editables.has(editable)) return;
      const id = group.dataset.blockId;
      if (id && !ids.includes(id)) {
        ids.push(id);
        pageId ??= group.dataset.pageId ?? null;
      }
    });
  return { ids, pageId };
}
const TOOLBAR_WIDTH = 348;
const TOOLBAR_HEIGHT = 33;
const TOOLBAR_GAP = 8;
const TOOLBAR_MARGIN = 8;
const COLOR_MENU_WIDTH = 224;
const COLOR_MENU_MAX_HEIGHT = 430;
const LINK_MENU_WIDTH = 430;
const LINK_MENU_HEIGHT = 42;

const TEXT_COLORS = [
  { token: "default", label: "selectionToolbar:colors.text.default" },
  { token: "gray", label: "selectionToolbar:colors.text.gray" },
  { token: "brown", label: "selectionToolbar:colors.text.brown" },
  { token: "orange", label: "selectionToolbar:colors.text.orange" },
  { token: "yellow", label: "selectionToolbar:colors.text.yellow" },
  { token: "green", label: "selectionToolbar:colors.text.green" },
  { token: "blue", label: "selectionToolbar:colors.text.blue" },
  { token: "purple", label: "selectionToolbar:colors.text.purple" },
  { token: "pink", label: "selectionToolbar:colors.text.pink" },
  { token: "red", label: "selectionToolbar:colors.text.red" },
] as const;

const BACKGROUND_COLORS = [
  { token: "gray_background", label: "selectionToolbar:colors.background.gray" },
  { token: "brown_background", label: "selectionToolbar:colors.background.brown" },
  { token: "orange_background", label: "selectionToolbar:colors.background.orange" },
  { token: "yellow_background", label: "selectionToolbar:colors.background.yellow" },
  { token: "green_background", label: "selectionToolbar:colors.background.green" },
  { token: "blue_background", label: "selectionToolbar:colors.background.blue" },
  { token: "purple_background", label: "selectionToolbar:colors.background.purple" },
  { token: "pink_background", label: "selectionToolbar:colors.background.pink" },
  { token: "red_background", label: "selectionToolbar:colors.background.red" },
] as const;

function editableOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  return el?.closest<HTMLElement>("[data-rt-editable]") ?? null;
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

function clearColorAttributes(root: ParentNode) {
  if (root instanceof HTMLElement) delete root.dataset.color;
  root.querySelectorAll("[data-color]").forEach((el) => {
    delete (el as HTMLElement).dataset.color;
  });
}

function closestWithin(node: Node | null, selector: string, boundary: HTMLElement) {
  const el = node?.nodeType === 3 ? node.parentElement : (node as Element | null);
  const match = el?.closest?.(selector);
  return match && boundary.contains(match) ? match : null;
}

function rangeIntersectsNode(range: Range, node: Node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function selectedTextFromNode(range: Range, node: Text) {
  const text = node.textContent ?? "";
  const start = range.startContainer === node ? range.startOffset : 0;
  const end = range.endContainer === node ? range.endOffset : text.length;
  return text.slice(Math.min(start, end), Math.max(start, end));
}

function selectedTextNodes(range: Range, editable: HTMLElement) {
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (rangeIntersectsNode(range, node)) {
      const text = selectedTextFromNode(range, node as Text);
      if (text.length > 0) nodes.push(node as Text);
    }
    node = walker.nextNode();
  }
  return nodes;
}

function toolbarRectForRange(range: Range) {
  const clientRects = range.getClientRects();
  const rect =
    clientRects.length > 1
      ? clientRects[clientRects.length - 1]
      : range.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

function textSelectionSnapshot(editable: HTMLElement, range: Range): TextSelectionSnapshot | null {
  const start = textOffsetIn(editable, range.startContainer, range.startOffset);
  const end = textOffsetIn(editable, range.endContainer, range.endOffset);
  if (start === null || end === null || start === end) return null;
  return {
    editable,
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

function textPositionIn(root: HTMLElement, target: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let lastNode: Text | null = null;
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const text = textNode.textContent ?? "";
    const nextOffset = offset + text.length;
    if (target <= nextOffset) {
      return {
        node: textNode,
        offset: Math.max(0, Math.min(text.length, target - offset)),
      };
    }
    offset = nextOffset;
    lastNode = textNode;
    node = walker.nextNode();
  }
  if (!lastNode) return null;
  return {
    node: lastNode,
    offset: lastNode.textContent?.length ?? 0,
  };
}

function rangeForTextSelection(snapshot: TextSelectionSnapshot) {
  const start = textPositionIn(snapshot.editable, snapshot.start);
  const end = textPositionIn(snapshot.editable, snapshot.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function activeMarksForSelection(range: Range, editable: HTMLElement): ActiveMarks {
  const nodes = selectedTextNodes(range, editable);
  if (nodes.length === 0) return { ...INACTIVE_MARKS };
  return Object.fromEntries(
    (Object.keys(MARK_SELECTORS) as Mark[]).map((mark) => [
      mark,
      nodes.every((node) => !!closestWithin(node, MARK_SELECTORS[mark], editable)),
    ])
  ) as ActiveMarks;
}

function activeColorForSelection(range: Range, editable: HTMLElement): ActiveColor {
  const nodes = selectedTextNodes(range, editable);
  if (nodes.length === 0) return "default";
  const colors = new Set(
    nodes.map((node) => {
      const colored = closestWithin(node, "[data-color]", editable) as HTMLElement | null;
      return colored?.dataset.color || "default";
    })
  );
  return colors.size === 1 ? Array.from(colors)[0] ?? "default" : "mixed";
}

export function SelectionToolbar({ commentOnly = false }: { commentOnly?: boolean } = {}) {
  const { t } = useTranslation(["selectionToolbar", "common"]);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [colorsOpen, setColorsOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [turnOpen, setTurnOpen] = useState(false);
  const [activeType, setActiveType] = useState<BlockType | null>(null);
  const [activeMarks, setActiveMarks] = useState<ActiveMarks>({ ...INACTIVE_MARKS });
  const [activeColor, setActiveColor] = useState<ActiveColor>("default");
  const [linkValue, setLinkValue] = useState("");
  const [hadLinkOnOpen, setHadLinkOnOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const savedRange = useRef<Range | null>(null);
  const savedEditable = useRef<HTMLElement | null>(null);
  const suppressSelectionClearUntil = useRef(0);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const turnButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const turnMenuRef = useRef<HTMLDivElement>(null);
  const colorMenuRef = useRef<HTMLDivElement>(null);
  const toolbarLinkMenuRef = useRef<HTMLDivElement>(null);
  const openComments = useStore((s) => s.openComments);
  const updateBlock = useStore((s) => s.updateBlock);

  const closeTurn = useCallback((restoreFocus = false) => {
    setTurnOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => turnButtonRef.current?.focus());
    }
  }, []);

  const closeColors = useCallback((restoreFocus = false) => {
    setColorsOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => colorButtonRef.current?.focus());
    }
  }, []);

  const closeLinkEditor = useCallback((restoreFocus = false) => {
    setLinkOpen(false);
    setLinkValue("");
    setHadLinkOnOpen(false);
    setLinkCopied(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => linkButtonRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    function onSel() {
      if (linkOpen || turnOpen || colorsOpen) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (shouldPreserveToolbarDuringCommand()) return;
        setRect(null);
        setActiveMarks({ ...INACTIVE_MARKS });
        setActiveColor("default");
        closeColors(false);
        return;
      }
      const anchorEditable = editableOf(sel.anchorNode);
      if (!anchorEditable) {
        if (shouldPreserveToolbarDuringCommand()) return;
        setRect(null);
        setActiveMarks({ ...INACTIVE_MARKS });
        setActiveColor("default");
        closeColors(false);
        return;
      }
      // Don't show formatting marks over code blocks (their text is verbatim).
      if (anchorEditable.closest('[data-type="code"]')) {
        setRect(null);
        setActiveMarks({ ...INACTIVE_MARKS });
        setActiveColor("default");
        closeColors(false);
        return;
      }
      // Remember the anchor block's type so the turn-into menu can mark it active.
      const anchorType = anchorEditable.closest<HTMLElement>("[data-type]")?.dataset
        .type as BlockType | undefined;
      setActiveType(anchorType ?? null);
      const range = sel.getRangeAt(0);
      const r = toolbarRectForRange(range);
      if (!r) {
        if (shouldPreserveToolbarDuringCommand()) return;
        setRect(null);
        setActiveMarks({ ...INACTIVE_MARKS });
        setActiveColor("default");
        closeColors(false);
        return;
      }
      savedRange.current = range.cloneRange();
      savedEditable.current = anchorEditable;
      setActiveMarks(activeMarksForSelection(range, anchorEditable));
      setActiveColor(activeColorForSelection(range, anchorEditable));
      setRect(r);
    }
    document.addEventListener("selectionchange", onSel);
    window.addEventListener("scroll", onSel, true);
    window.addEventListener("resize", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      window.removeEventListener("scroll", onSel, true);
      window.removeEventListener("resize", onSel);
    };
  }, [closeColors, colorsOpen, linkOpen, turnOpen]);

  useEffect(() => {
    if (!linkOpen) return;
    window.requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
  }, [linkOpen]);

  useEffect(() => {
    if (!colorsOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const active = colorMenuRef.current?.querySelector<HTMLButtonElement>(
        '[data-color-menu-item][aria-checked="true"]'
      );
      const first = colorMenuRef.current?.querySelector<HTMLButtonElement>(
        "[data-color-menu-item]"
      );
      (active ?? first)?.focus();
      active?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeColor, colorsOpen]);

  useEffect(() => {
    if (!turnOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const active = turnMenuRef.current?.querySelector<HTMLButtonElement>(
        '[data-turn-menu-item][aria-checked="true"]'
      );
      const first = turnMenuRef.current?.querySelector<HTMLButtonElement>(
        "[data-turn-menu-item]"
      );
      (active ?? first)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [turnOpen]);

  function restoreSelection() {
    const range = savedRange.current;
    if (!range) return null;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return savedEditable.current;
  }

  function shouldPreserveToolbarDuringCommand() {
    return performance.now() < suppressSelectionClearUntil.current && !!savedRange.current;
  }

  function refreshToolbarFromRange(range: Range, editable: HTMLElement) {
    const nextRect = toolbarRectForRange(range);
    if (!nextRect) return false;
    savedRange.current = range.cloneRange();
    savedEditable.current = editable;
    setActiveMarks(activeMarksForSelection(range, editable));
    setActiveColor(activeColorForSelection(range, editable));
    setRect(nextRect);
    return true;
  }

  function restoreTextSelection(snapshot: TextSelectionSnapshot) {
    const range = rangeForTextSelection(snapshot);
    if (!range) return false;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return refreshToolbarFromRange(range, snapshot.editable);
  }

  function preserveToolbarAfterCommand(snapshot: TextSelectionSnapshot | null) {
    if (!snapshot) return;
    suppressSelectionClearUntil.current = performance.now() + 1000;
    const restore = () => {
      if (!snapshot.editable.isConnected) return;
      restoreTextSelection(snapshot);
    };
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    window.setTimeout(restore, 80);
  }

  function currentLinkHref(range: Range) {
    const hrefFromNode = (node: Node | null) => {
      const el = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
      return el?.closest?.("a[href]")?.getAttribute("href") ?? "";
    };
    const direct = hrefFromNode(range.startContainer) || hrefFromNode(range.endContainer);
    if (direct) return direct;
    const cloned = range.cloneContents();
    const clonedLink = cloned.querySelector?.("a[href]");
    if (clonedLink) return clonedLink.getAttribute("href") ?? "";
    const editable = editableOf(range.startContainer);
    const intersecting = Array.from(editable?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])
      .find((link) => {
        try {
          return range.intersectsNode(link);
        } catch {
          return false;
        }
      });
    return intersecting?.getAttribute("href") ?? "";
  }

  function openLinkEditor() {
    let sel = window.getSelection();
    let editable = editableOf(sel?.anchorNode ?? null);
    if (!sel || !editable || sel.rangeCount === 0 || sel.isCollapsed) {
      editable = restoreSelection();
      sel = window.getSelection();
    }
    if (!sel || !editable || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    savedRange.current = range.cloneRange();
    savedEditable.current = editable;
    const href = currentLinkHref(range);
    setLinkValue(href);
    setHadLinkOnOpen(href.length > 0);
    setLinkCopied(false);
    setColorsOpen(false);
    setTurnOpen(false);
    setLinkOpen(true);
  }

  function dispatchSavedInput(editable: HTMLElement | null) {
    editable?.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }

  function pageMentionFromUrl(url: string): TextSpan | null {
    const pageId = pageIdFromPageHref(url);
    const page = pageId ? useStore.getState().pagesById[pageId] : undefined;
    if (!page || page.inTrash) return null;
    return {
      text: pageTitle(page),
      mention: "page",
      pageId: page.id,
    };
  }

  function pageTitle(page: { title: string }) {
    return pageDisplayTitle(page);
  }

  function replaceSelectionWithPageMention(editable: HTMLElement | null, range: Range | null, url: string) {
    const mentionSpan = pageMentionFromUrl(url);
    if (!editable || !range || !mentionSpan) return false;
    const start = textOffsetIn(editable, range.startContainer, range.startOffset);
    const end = textOffsetIn(editable, range.endContainer, range.endOffset);
    if (start === null || end === null || start === end) return false;

    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const spans = htmlToSpans(editable);
    const [head] = splitSpans(spans, from);
    const [, tail] = splitSpans(spans, to);
    const next = concatSpans(concatSpans(head, [mentionSpan]), tail);
    editable.innerHTML = spansToHtml(next);
    dispatchSavedInput(editable);
    return true;
  }

  function applyLinkValue() {
    const range = savedRange.current?.cloneRange() ?? null;
    const editable = restoreSelection();
    const snapshot = editable && range ? textSelectionSnapshot(editable, range) : null;
    const url = normalizedLinkValue();
    if (url && replaceSelectionWithPageMention(editable, range, url)) {
      closeLinkEditor(false);
      return;
    }
    if (url) document.execCommand("createLink", false, url);
    else document.execCommand("unlink");
    dispatchSavedInput(editable);
    closeLinkEditor(false);
    preserveToolbarAfterCommand(snapshot);
  }

  function normalizedLinkValue() {
    let url = linkValue.trim();
    if (!url || /\s/.test(url)) return "";
    const bareDomain = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;
    const localhost = /^localhost(?::\d+)?(?:[/?#].*)?$/i;
    if (bareDomain.test(url) || localhost.test(url)) {
      url = "https://" + url;
    } else if (!/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) {
      return "";
    }
    return safeUrl(url);
  }

  function openCurrentLink() {
    const url = normalizedLinkValue();
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function copyCurrentLink() {
    const url = normalizedLinkValue();
    if (!url) return;
    const ok = await copyText(url);
    if (!ok) return;
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1200);
  }

  function removeLink() {
    const editable = restoreSelection();
    const range = savedRange.current?.cloneRange() ?? null;
    const snapshot = editable && range ? textSelectionSnapshot(editable, range) : null;
    document.execCommand("unlink");
    dispatchSavedInput(editable);
    closeLinkEditor(false);
    preserveToolbarAfterCommand(snapshot);
  }

  function commentSelection() {
    const editable = restoreSelection() ?? savedEditable.current;
    const range = savedRange.current;
    const quote = savedRange.current?.toString().replace(/\s+/g, " ").trim();
    const blockGroup = editable?.closest<HTMLElement>("[data-block-id][data-page-id]");
    const blockId = blockGroup?.dataset.blockId;
    const pageId = blockGroup?.dataset.pageId;
    if (!pageId || !blockId) return;
    const quoteStart =
      editable && range ? textOffsetIn(editable, range.startContainer, range.startOffset) : null;
    const quoteEnd =
      editable && range ? textOffsetIn(editable, range.endContainer, range.endOffset) : null;
    closeColors(false);
    closeLinkEditor(false);
    setRect(null);
    openComments(pageId, blockId, {
      quote: quote || undefined,
      quoteStart: quoteStart ?? undefined,
      quoteEnd: quoteEnd ?? undefined,
    });
  }

  function turnInto(type: BlockType) {
    const range = savedRange.current;
    if (!range) {
      closeTurn(false);
      setRect(null);
      return;
    }
    const { ids, pageId } = blockIdsInRange(range);
    if (ids.length === 0) {
      closeTurn(false);
      setRect(null);
      return;
    }
    // Convert each spanned block. Push a single history entry, then merge the rest
    // so the whole turn-into is one undo step.
    const blocks = pageId ? (useStore.getState().blocksByPage[pageId] ?? []) : [];
    const blocksById = new Map(blocks.map((block) => [block.id, block]));
    ids.forEach((id, i) => {
      updateBlock(id, turnIntoPatch(blocksById.get(id), type), {
        history: i === 0 ? "push" : "merge",
      });
    });
    setActiveType(type);
    closeTurn(false);
    setRect(null);
    // Restore the caret to the (now re-typed) first block so editing continues.
    window.requestAnimationFrame(() => focusEditable(ids[0], "end"));
  }

  useEffect(() => {
    if (!linkOpen && !colorsOpen && !turnOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (toolbarRef.current?.contains(e.target as Node)) return;
      closeColors(false);
      closeLinkEditor(false);
      closeTurn(false);
      setRect(null);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closeColors, closeLinkEditor, closeTurn, colorsOpen, linkOpen, turnOpen]);

  function apply(mark: Mark) {
    const editable = restoreSelection();
    const sel = window.getSelection();
    if (!editable) return;
    const range = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    const snapshot = range ? textSelectionSnapshot(editable, range) : null;
    try {
      document.execCommand("styleWithCSS", false, "false");
    } catch {
      /* ignore */
    }
    if (mark === "code") {
      const text = sel?.toString() ?? "";
      if (text) document.execCommand("insertHTML", false, `<code>${escapeHtml(text)}</code>`);
    } else if (mark === "link") {
      openLinkEditor();
      return;
    } else {
      document.execCommand(mark === "strikethrough" ? "strikeThrough" : mark);
    }
    // make the block reserialize DOM → spans
    editable.dispatchEvent(new InputEvent("input", { bubbles: true }));
    preserveToolbarAfterCommand(snapshot);
  }

  function colorMenuItems() {
    return Array.from(
      colorMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-color-menu-item]") ?? [],
    ).filter((item) => !item.disabled && item.getClientRects().length > 0);
  }

  function onColorMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeColors(true);
      return;
    }
    if (
      !["Tab", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)
    ) {
      return;
    }

    const items = colorMenuItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "Tab") {
      nextIndex =
        index === -1 ? 0 : (index + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    } else if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "PageDown") {
      nextIndex = Math.min(Math.max(index, 0) + 6, items.length - 1);
    } else if (e.key === "PageUp") {
      nextIndex = Math.max(Math.max(index, 0) - 6, 0);
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }

    items[nextIndex]?.focus();
    items[nextIndex]?.scrollIntoView({ block: "nearest" });
  }

  function turnMenuItems() {
    return Array.from(
      turnMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-turn-menu-item]") ?? [],
    ).filter((item) => !item.disabled && item.getClientRects().length > 0);
  }

  function onTurnMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTurn(true);
      return;
    }
    if (
      !["Tab", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)
    ) {
      return;
    }

    const items = turnMenuItems();
    if (!items.length) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "Tab") {
      nextIndex =
        index === -1 ? 0 : (index + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    } else if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "PageDown") {
      nextIndex = Math.min(Math.max(index, 0) + 6, items.length - 1);
    } else if (e.key === "PageUp") {
      nextIndex = Math.max(Math.max(index, 0) - 6, 0);
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }

    items[nextIndex]?.focus();
    items[nextIndex]?.scrollIntoView({ block: "nearest" });
  }

  function linkMenuFocusables() {
    return Array.from(
      toolbarLinkMenuRef.current?.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled])"
      ) ?? [],
    ).filter((item) => item.getClientRects().length > 0 && item.tabIndex >= 0);
  }

  function onLinkMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || isComposingKeyEvent(e)) return;
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
    const index = focusables.findIndex((item) => item === document.activeElement);
    const nextIndex =
      index === -1
        ? 0
        : (index + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[nextIndex]?.focus();
  }

  function applyColor(token: string) {
    rememberEditorColor(token);
    const editable = restoreSelection();
    const sel = window.getSelection();
    if (!sel || !editable || sel.isCollapsed || sel.rangeCount === 0) return;
    if (editableOf(sel.focusNode ?? null) !== editable) return;

    const range = sel.getRangeAt(0);
    const snapshot = textSelectionSnapshot(editable, range);
    const fragment = range.extractContents();
    clearColorAttributes(fragment);

    const inserted = document.createElement("span");
    if (token !== "default") {
      inserted.dataset.color = token;
    }
    inserted.appendChild(fragment);

    range.insertNode(inserted);
    sel.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(inserted);
    sel.addRange(nextRange);
    // Normalize the DOM: reserialize to spans (coalesce merges adjacent runs of
    // the same color and drops the redundant nesting created by extract+wrap),
    // then rewrite the editable from the clean model so no duplicated colored
    // markup lingers. The input event then persists the normalized spans.
    const normalized = htmlToSpans(editable);
    editable.innerHTML = spansToHtml(normalized);
    editable.dispatchEvent(new InputEvent("input", { bubbles: true }));
    setActiveColor(token);
    closeColors(false);
    preserveToolbarAfterCommand(snapshot);
  }

  function toolbarButtons() {
    return Array.from(
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>(
        `.${styles.tbBtn}:not(:disabled)`
      ) ?? []
    );
  }

  function onToolbarKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (colorsOpen || linkOpen || turnOpen) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;

    const buttons = toolbarButtons();
    if (buttons.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = buttons.findIndex((button) => button === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowRight") {
      nextIndex = index >= 0 ? (index + 1) % buttons.length : 0;
    } else if (e.key === "ArrowLeft") {
      nextIndex = index > 0 ? index - 1 : buttons.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = buttons.length - 1;
    }

    buttons[nextIndex]?.focus();
  }

  if (!rect) return null;

  const hasRoomAbove = rect.top >= TOOLBAR_HEIGHT + TOOLBAR_GAP + TOOLBAR_MARGIN;
  const top = hasRoomAbove
    ? rect.top - TOOLBAR_HEIGHT - TOOLBAR_GAP
    : Math.min(rect.bottom + TOOLBAR_GAP, window.innerHeight - TOOLBAR_HEIGHT - TOOLBAR_MARGIN);
  const toolbarWidth = Math.min(TOOLBAR_WIDTH, window.innerWidth - TOOLBAR_MARGIN * 2);
  const colorMenuWidth = Math.min(COLOR_MENU_WIDTH, window.innerWidth - TOOLBAR_MARGIN * 2);
  const linkMenuWidth = Math.min(LINK_MENU_WIDTH, window.innerWidth - TOOLBAR_MARGIN * 2);
  const turnMenuWidth = Math.min(TURN_MENU_WIDTH, window.innerWidth - TOOLBAR_MARGIN * 2);
  const left = Math.max(
    TOOLBAR_MARGIN,
    Math.min(rect.left, window.innerWidth - toolbarWidth - TOOLBAR_MARGIN)
  );
  const openSubmenuBelow = top + TOOLBAR_HEIGHT + TOOLBAR_GAP + COLOR_MENU_MAX_HEIGHT <=
    window.innerHeight - TOOLBAR_MARGIN;
  const colorMenuTop = openSubmenuBelow
    ? top + TOOLBAR_HEIGHT + TOOLBAR_GAP
    : Math.max(TOOLBAR_MARGIN, top - COLOR_MENU_MAX_HEIGHT - TOOLBAR_GAP);
  const colorMenuLeft = Math.max(
    TOOLBAR_MARGIN,
    Math.min(left + toolbarWidth - colorMenuWidth, window.innerWidth - colorMenuWidth - TOOLBAR_MARGIN)
  );
  const linkMenuTop = hasRoomAbove
    ? Math.min(top + TOOLBAR_HEIGHT + TOOLBAR_GAP, window.innerHeight - LINK_MENU_HEIGHT - TOOLBAR_MARGIN)
    : Math.max(TOOLBAR_MARGIN, top - LINK_MENU_HEIGHT - TOOLBAR_GAP);
  const linkMenuLeft = Math.max(
    TOOLBAR_MARGIN,
    Math.min(left, window.innerWidth - linkMenuWidth - TOOLBAR_MARGIN)
  );
  const turnMenuBelow =
    top + TOOLBAR_HEIGHT + TOOLBAR_GAP + TURN_MENU_MAX_HEIGHT <= window.innerHeight - TOOLBAR_MARGIN;
  const turnMenuTop = turnMenuBelow
    ? top + TOOLBAR_HEIGHT + TOOLBAR_GAP
    : Math.max(TOOLBAR_MARGIN, top - TURN_MENU_MAX_HEIGHT - TOOLBAR_GAP);
  const turnMenuLeft = Math.max(
    TOOLBAR_MARGIN,
    Math.min(left, window.innerWidth - turnMenuWidth - TOOLBAR_MARGIN)
  );
  const activeTurn = TURN_OPTIONS.find((o) => o.type === activeType);
  const currentLinkUrl = normalizedLinkValue();
  const activeColorLabel =
    activeColor === "mixed"
      ? t("selectionToolbar:colors.mixed")
      : t(
          [...TEXT_COLORS, ...BACKGROUND_COLORS].find((color) => color.token === activeColor)
            ?.label ?? "selectionToolbar:colors.text.default"
        );
  const toolbarColorToken = activeColor === "mixed" ? "default" : activeColor;

  const btns: { mark: Exclude<Mark, "link">; label: string; cls?: string }[] = [
    { mark: "bold", label: "B", cls: styles.tbBold },
    { mark: "italic", label: "i", cls: styles.tbItalic },
    { mark: "underline", label: "U", cls: styles.tbUnderline },
    { mark: "strikethrough", label: "S", cls: styles.tbStrike },
    { mark: "code", label: "</>" },
  ];
  const markLabels: Record<Mark, string> = {
    bold: t("selectionToolbar:marks.bold"),
    italic: t("selectionToolbar:marks.italic"),
    underline: t("selectionToolbar:marks.underline"),
    strikethrough: t("selectionToolbar:marks.strikethrough"),
    code: t("selectionToolbar:marks.code"),
    link: t("selectionToolbar:marks.link"),
  };

  return (
    <div
      ref={toolbarRef}
      className={styles.selToolbar}
      style={{ top, left }}
      role="toolbar"
      aria-label={t("selectionToolbar:toolbar.ariaLabel")}
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={onToolbarKeyDown}
    >
      {!commentOnly && (
        <>
          <button
            type="button"
            ref={turnButtonRef}
            className={`${styles.tbBtn} ${styles.tbTurn}`}
            aria-label={t("selectionToolbar:turnInto.label")}
            aria-haspopup="menu"
            aria-expanded={turnOpen}
            onClick={() => {
              closeColors(false);
              closeLinkEditor(false);
              if (turnOpen) closeTurn(true);
              else setTurnOpen(true);
            }}
            title={t("selectionToolbar:turnInto.label")}
          >
            {activeTurn ? t(activeTurn.label) : t("selectionToolbar:turnInto.options.text")}
            <span className={styles.tbTurnCaret} aria-hidden="true">
              <ChevronDown size={12} />
            </span>
          </button>
          <div className={styles.tbDivider} />
        </>
      )}
      {turnOpen && (
        <div
          ref={turnMenuRef}
          className={styles.tbTurnMenu}
          style={{ top: turnMenuTop, left: turnMenuLeft }}
          role="menu"
          tabIndex={-1}
          aria-label={t("selectionToolbar:turnInto.label")}
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={onTurnMenuKeyDown}
        >
          <div className={styles.tbColorLabel}>{t("selectionToolbar:turnInto.label")}</div>
          {TURN_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.type}
              className={styles.tbTurnItem}
              data-turn-menu-item
              role="menuitemradio"
              aria-checked={activeType === o.type}
              onClick={() => turnInto(o.type)}
            >
              <span className={styles.tbTurnGlyph} aria-hidden="true">
                <BlockIcon type={o.type} glyph={o.glyph} size={15} />
              </span>
              <span>{t(o.label)}</span>
              {activeType === o.type && (
                <CheckIcon className={styles.colorCheck} size={14} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
      {!commentOnly && (
        <button
          type="button"
          ref={linkButtonRef}
          className={styles.tbBtn}
          aria-label={t("selectionToolbar:marks.link")}
          aria-haspopup="dialog"
          aria-expanded={linkOpen}
          aria-pressed={activeMarks.link}
          onClick={() => apply("link")}
          title={t("selectionToolbar:marks.link")}
        >
          <LinkIcon size={15} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className={styles.tbBtn}
        aria-label={t("selectionToolbar:comment.label")}
        onClick={commentSelection}
        title={t("selectionToolbar:comment.label")}
      >
        <CommentIcon size={15} aria-hidden="true" />
      </button>
      {!commentOnly && (
        <>
          <div className={styles.tbDivider} />
          {btns.map((b) => (
            <button
              type="button"
              key={b.mark}
              className={`${styles.tbBtn} ${b.cls ?? ""}`}
              aria-label={markLabels[b.mark]}
              aria-pressed={activeMarks[b.mark]}
              onClick={() => apply(b.mark)}
              title={markLabels[b.mark]}
            >
              {b.label}
            </button>
          ))}
          <div className={styles.tbDivider} />
          <button
            type="button"
            ref={colorButtonRef}
            className={styles.tbBtn}
            aria-label={t("selectionToolbar:colorButton.ariaLabel", { color: activeColorLabel })}
            aria-haspopup="menu"
            aria-expanded={colorsOpen}
            onClick={() => {
              closeLinkEditor(false);
              closeTurn(false);
              if (colorsOpen) closeColors(true);
              else setColorsOpen(true);
            }}
            title={t("selectionToolbar:colorButton.title", { color: activeColorLabel })}
          >
            <span className={styles.tbColorButtonMark} data-color={toolbarColorToken}>
              A
            </span>
          </button>
        </>
      )}
      {colorsOpen && (
        <div
          ref={colorMenuRef}
          className={styles.tbColorMenu}
          style={{ top: colorMenuTop, left: colorMenuLeft }}
          role="menu"
          tabIndex={-1}
          aria-label={t("selectionToolbar:colors.text.heading")}
          onKeyDown={onColorMenuKeyDown}
        >
          <div className={styles.tbColorLabel}>{t("selectionToolbar:colors.text.heading")}</div>
          {TEXT_COLORS.map((c) => (
            <button
              type="button"
              key={c.token}
              className={styles.tbColorItem}
              data-color-menu-item
              role="menuitemradio"
              aria-checked={activeColor === c.token}
              data-active={activeColor === c.token ? "true" : undefined}
              onClick={() => applyColor(c.token)}
            >
              <span className={styles.colorSwatch} data-color={c.token}>
                A
              </span>
              <span>{t(c.label)}</span>
              {activeColor === c.token && (
                <CheckIcon className={styles.colorCheck} size={14} aria-hidden="true" />
              )}
            </button>
          ))}
          <div className={styles.menuDivider} />
          <div className={styles.tbColorLabel}>{t("selectionToolbar:colors.background.heading")}</div>
          {BACKGROUND_COLORS.map((c) => (
            <button
              type="button"
              key={c.token}
              className={styles.tbColorItem}
              data-color-menu-item
              role="menuitemradio"
              aria-checked={activeColor === c.token}
              data-active={activeColor === c.token ? "true" : undefined}
              onClick={() => applyColor(c.token)}
            >
              <span className={styles.colorSwatch} data-color={c.token}>
                A
              </span>
              <span>{t(c.label)}</span>
              {activeColor === c.token && (
                <CheckIcon className={styles.colorCheck} size={14} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
      {linkOpen && (
        <div
          ref={toolbarLinkMenuRef}
          className={styles.tbLinkMenu}
          style={{ top: linkMenuTop, left: linkMenuLeft }}
          role="dialog"
          aria-label={t("selectionToolbar:linkEditor.ariaLabel")}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onLinkMenuKeyDown}
        >
          <input
            ref={linkInputRef}
            value={linkValue}
            placeholder={t("selectionToolbar:linkEditor.placeholder")}
            aria-label={t("selectionToolbar:linkEditor.urlAriaLabel")}
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
          <button type="button" className={styles.tbLinkPrimary} onClick={applyLinkValue}>
            {hadLinkOnOpen ? t("common:actions.save") : t("selectionToolbar:linkEditor.apply")}
          </button>
          {hadLinkOnOpen && (
            <button
              type="button"
              className={styles.tbLinkIconButton}
              onClick={openCurrentLink}
              disabled={!currentLinkUrl}
              aria-label={t("selectionToolbar:linkEditor.open")}
              title={t("selectionToolbar:linkEditor.open")}
            >
              <OpenInNew size={14} aria-hidden="true" />
            </button>
          )}
          {hadLinkOnOpen && (
            <button
              type="button"
              className={styles.tbLinkIconButton}
              onClick={() => void copyCurrentLink()}
              disabled={!currentLinkUrl}
              aria-label={
                linkCopied
                  ? t("selectionToolbar:linkEditor.copiedLink")
                  : t("selectionToolbar:linkEditor.copy")
              }
              title={
                linkCopied
                  ? t("selectionToolbar:linkEditor.copied")
                  : t("selectionToolbar:linkEditor.copy")
              }
            >
              <Copy size={14} aria-hidden="true" />
            </button>
          )}
          {hadLinkOnOpen && (
            <button type="button" className={styles.tbLinkRemove} onClick={removeLink}>
              {t("selectionToolbar:linkEditor.remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
