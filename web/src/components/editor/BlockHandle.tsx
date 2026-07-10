"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Block, BlockType } from "@/lib/types";
import { copyText } from "@/lib/clipboard";
import { absolutePageUrl } from "@/lib/navigation";
import { useStore } from "@/lib/store";
import { spansToPlainText } from "@/lib/types";
import { BLOCK_DRAG_IDS_TYPE } from "../dndTypes";
import { BLOCK_DEFS, type BlockDef } from "./blocks";
import { BlockIcon } from "./BlockIcon";
import { BlockMoveToDialog } from "./BlockMoveToDialog";
import { rememberEditorColor } from "./colorMemory";
import type { EditorOps } from "./Editor";
import { SlashMenu, type SlashMenuAnchor } from "./SlashMenu";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckIcon,
  CommentIcon,
  Copy,
  DragHandleIcon,
  LinkIcon,
  MoveIcon,
  PaletteIcon,
  Plus,
  Trash,
  TurnIntoIcon,
} from "@/icons/hanji";
import styles from "./editor.module.css";

const BLOCK_MENU_WIDTH = 238;
const BLOCK_MENU_MAIN_HEIGHT = 460;
const BLOCK_MENU_TALL_HEIGHT = 620;
const BLOCK_MENU_MOBILE_TALL_HEIGHT = 420;
const BLOCK_MENU_MARGIN = 8;
const EMPTY_BLOCKS: Block[] = [];

type BlockMenuAnchor = { x: number; y: number; bottom?: number };
type BlockMenuPanel = "main" | "turn" | "color";

const TURN_INTO: BlockType[] = [
  "paragraph",
  "child_page",
  "link_to_page",
  "heading_1",
  "toggle_heading_1",
  "heading_2",
  "toggle_heading_2",
  "heading_3",
  "toggle_heading_3",
  "heading_4",
  "toggle_heading_4",
  "to_do",
  "bulleted_list_item",
  "numbered_list_item",
  "toggle",
  "quote",
  "callout",
  "code",
  "equation",
  "breadcrumb",
  "synced_block",
  "button",
  "tab",
  "simple_table",
  "table_of_contents",
  "column_list",
  "image",
  "video",
  "audio",
  "bookmark",
  "embed",
  "file",
  "child_database",
  "inline_database",
];

const TEXT_COLORS = [
  { token: "default", label: "Default" },
  { token: "gray", label: "Gray" },
  { token: "brown", label: "Brown" },
  { token: "orange", label: "Orange" },
  { token: "yellow", label: "Yellow" },
  { token: "green", label: "Green" },
  { token: "blue", label: "Blue" },
  { token: "purple", label: "Purple" },
  { token: "pink", label: "Pink" },
  { token: "red", label: "Red" },
] as const;

const BACKGROUND_COLORS = [
  { token: "gray_background", label: "Gray background" },
  { token: "brown_background", label: "Brown background" },
  { token: "orange_background", label: "Orange background" },
  { token: "yellow_background", label: "Yellow background" },
  { token: "green_background", label: "Green background" },
  { token: "blue_background", label: "Blue background" },
  { token: "purple_background", label: "Purple background" },
  { token: "pink_background", label: "Pink background" },
  { token: "red_background", label: "Red background" },
] as const;

const MULTI_TURN_INTO: Set<BlockType> = new Set([
  "paragraph",
  "heading_1",
  "toggle_heading_1",
  "heading_2",
  "toggle_heading_2",
  "heading_3",
  "toggle_heading_3",
  "heading_4",
  "toggle_heading_4",
  "to_do",
  "bulleted_list_item",
  "numbered_list_item",
  "toggle",
  "quote",
  "callout",
  "code",
]);
const CAPTION_BLOCK_TYPES: Set<BlockType> = new Set(["image", "video", "audio", "embed", "file"]);

// Edge auto-scroll while a block is being dragged: when the pointer is within
// EDGE_ZONE px of the top/bottom of the viewport, scroll the nearest scrollable
// ancestor so off-screen drop targets become reachable (native DnD can't do this).
const EDGE_ZONE = 72;
const MAX_SCROLL_SPEED = 18;
let autoScrollRaf = 0;
let autoScrollY = 0;
let autoScrollActive = false;

function nearestScrollable(el: HTMLElement | null): HTMLElement | Window {
  let node = el;
  while (node) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return window;
}

function startBlockAutoScroll() {
  if (autoScrollActive) return;
  autoScrollActive = true;
  const onDragOver = (e: DragEvent) => {
    const y = e.clientY;
    const h = window.innerHeight;
    if (y < EDGE_ZONE) {
      autoScrollY = -Math.ceil(((EDGE_ZONE - y) / EDGE_ZONE) * MAX_SCROLL_SPEED);
    } else if (y > h - EDGE_ZONE) {
      autoScrollY = Math.ceil(((y - (h - EDGE_ZONE)) / EDGE_ZONE) * MAX_SCROLL_SPEED);
    } else {
      autoScrollY = 0;
    }
  };
  let lastTarget: HTMLElement | null = null;
  const onDragOverTarget = (e: DragEvent) => {
    lastTarget = e.target as HTMLElement | null;
  };
  const tick = () => {
    if (autoScrollY !== 0) {
      const scroller = nearestScrollable(lastTarget);
      if (scroller === window) window.scrollBy(0, autoScrollY);
      else (scroller as HTMLElement).scrollTop += autoScrollY;
    }
    autoScrollRaf = window.requestAnimationFrame(tick);
  };
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragover", onDragOverTarget, true);
  autoScrollRaf = window.requestAnimationFrame(tick);
  (startBlockAutoScroll as { cleanup?: () => void }).cleanup = () => {
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("dragover", onDragOverTarget, true);
    window.cancelAnimationFrame(autoScrollRaf);
    autoScrollY = 0;
    autoScrollActive = false;
  };
}

function stopBlockAutoScroll() {
  (startBlockAutoScroll as { cleanup?: () => void }).cleanup?.();
}

function anchorFromButton(button: HTMLElement): SlashMenuAnchor {
  const rect = button.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
  };
}

function blockMenuAnchorFromButton(button: HTMLElement): BlockMenuAnchor {
  const rect = button.getBoundingClientRect();
  const y = rect.bottom + 4;
  return {
    x: rect.left - 10,
    y,
    bottom: y,
  };
}

function relativeBlockEditedLabel(value?: string) {
  if (!value) return "Last edited just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last edited just now";
  const diff = Math.max(0, Date.now() - date.getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "Last edited just now";
  if (diff < hour) return `Last edited ${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `Last edited ${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `Last edited ${Math.floor(diff / day)}d ago`;
  return `Last edited ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function fullBlockEditedLabel(value?: string) {
  if (!value) return "Last edited just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last edited just now";
  return `Last edited ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function BlockActionMenuPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}

export function BlockHandle({
  block,
  ops,
  dragType,
  onDragState,
  menuOpen,
  menuAnchor,
  onMenuOpen,
  onMenuClose,
}: {
  block: Block;
  ops: EditorOps;
  dragType: string;
  onDragState: (dragging: boolean) => void;
  menuOpen: boolean;
  menuAnchor: BlockMenuAnchor | null;
  onMenuOpen: (anchor?: BlockMenuAnchor | null) => void;
  onMenuClose: () => void;
}) {
  const [addMenu, setAddMenu] = useState(false);
  const [addAnchor, setAddAnchor] = useState<SlashMenuAnchor | undefined>();
  const [moveDialog, setMoveDialog] = useState(false);
  const [copiedBlock, setCopiedBlock] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [menuPanel, setMenuPanel] = useState<BlockMenuPanel>("main");
  const [menuMeasuredHeight, setMenuMeasuredHeight] = useState<number | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mainMenuFocusRef = useRef<Exclude<BlockMenuPanel, "main"> | null>(null);
  const dragStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const openComments = useStore((s) => s.openComments);
  const notify = useStore((s) => s.notify);
  const updateBlock = useStore((s) => s.updateBlock);
  const undoBlockChange = useStore((s) => s.undoBlockChange);
  const blocksOnPage = useStore((s) => s.blocksByPage[block.pageId] ?? EMPTY_BLOCKS);

  function menuItems() {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-block-menu-item]") ??
        [],
    ).filter((item) => !item.disabled && item.getClientRects().length > 0);
  }

  const closeAddMenu = useCallback((restoreFocus = false) => {
    setAddMenu(false);
    setAddAnchor(undefined);
    if (restoreFocus) {
      window.requestAnimationFrame(() => addButtonRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  const closeActionMenu = useCallback((restoreFocus = false) => {
    setMenuPanel("main");
    onMenuClose();
    if (restoreFocus) {
      window.requestAnimationFrame(() => actionButtonRef.current?.focus({ preventScroll: true }));
    }
  }, [onMenuClose]);

  const focusMenuItem = useCallback((item?: HTMLButtonElement | null) => {
    if (!item) return;
    item.focus({ preventScroll: true });
    const menu = menuRef.current;
    if (!menu) return;
    const itemRect = item.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    if (itemRect.top < menuRect.top) {
      menu.scrollTop -= menuRect.top - itemRect.top;
    } else if (itemRect.bottom > menuRect.bottom) {
      menu.scrollTop += itemRect.bottom - menuRect.bottom;
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const items = menuItems();
      // In the turn/color submenus, focus the currently-active item (aria-checked)
      // and bring it into view instead of the "← back" button at the top.
      if (menuPanel !== "main") {
        const active = items.find(
          (item) => item.getAttribute("aria-checked") === "true"
        );
        if (active) {
          focusMenuItem(active);
          return;
        }
      }
      const mainFocusPanel = mainMenuFocusRef.current;
      mainMenuFocusRef.current = null;
      const mainFocusTarget = mainFocusPanel
        ? menuRef.current?.querySelector<HTMLButtonElement>(`[data-submenu="${mainFocusPanel}"]`)
        : null;
      focusMenuItem(mainFocusTarget ?? items[0]);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusMenuItem, menuOpen, menuPanel]);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuMeasuredHeight(null);
      return;
    }

    const measure = () => {
      const height = menuRef.current?.getBoundingClientRect().height;
      if (!height || !Number.isFinite(height)) return;
      setMenuMeasuredHeight((current) =>
        current !== null && Math.abs(current - height) < 1 ? current : height
      );
    };

    measure();
    const frame = window.requestAnimationFrame(measure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && menuRef.current) {
      observer = new ResizeObserver(measure);
      observer.observe(menuRef.current);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [menuOpen, menuPanel]);

  function openMenuPanel(panel: Exclude<BlockMenuPanel, "main">) {
    setMenuPanel(panel);
  }

  function returnToMainMenu(fromPanel: Exclude<BlockMenuPanel, "main">) {
    mainMenuFocusRef.current = fromPanel;
    setMenuPanel("main");
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (menuPanel === "main") {
        closeActionMenu(true);
        return;
      }
      returnToMainMenu(menuPanel);
      return;
    }
    if (e.key === "Tab") {
      const items = menuItems();
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      const index = items.findIndex((item) => item === document.activeElement);
      const nextIndex =
        index === -1 ? 0 : (index + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      focusMenuItem(items[nextIndex]);
      return;
    }
    if (e.key === "ArrowLeft" && menuPanel !== "main") {
      e.preventDefault();
      e.stopPropagation();
      returnToMainMenu(menuPanel);
      return;
    }
    if (e.key === "ArrowRight" && menuPanel === "main") {
      const target = document.activeElement as HTMLElement | null;
      const panel = target?.dataset.submenu;
      if (panel === "turn" || panel === "color") {
        e.preventDefault();
        e.stopPropagation();
        openMenuPanel(panel);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)) {
      return;
    }
    const items = menuItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
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

    focusMenuItem(items[nextIndex]);
  }

  function openActionMenu(anchor: BlockMenuAnchor | null = null) {
    setMenuPanel("main");
    onMenuOpen(anchor);
  }

  async function duplicate() {
    const copies = await ops.duplicateSelectedBlocks(block.id);
    if (copies.length > 0) {
      notifyDuplicatedBlocks(copies.length);
    }
    closeActionMenu(true);
  }

  function notifyDuplicatedBlocks(count: number) {
    notify(count > 1 ? `Duplicated ${count} blocks` : "Duplicated block", "success", {
      label: "Undo",
      onClick: async () => {
        const restored = await undoBlockChange(block.pageId);
        notify(restored ? "Undid duplicate" : "Nothing to undo", restored ? "success" : "default");
      },
    });
  }

  function notifyDeletedBlocks(count: number) {
    notify(count > 1 ? `Deleted ${count} blocks` : "Deleted block", "success", {
      label: "Undo",
      onClick: async () => {
        const restored = await undoBlockChange(block.pageId);
        notify(restored ? "Restored block" : "Nothing to undo", restored ? "success" : "default");
      },
    });
  }

  async function copyBlock() {
    const copied = await ops.copySelectedBlocks(block.id);
    setCopiedBlock(copied);
    window.setTimeout(() => setCopiedBlock(false), 1400);
    notify(copied ? "Copied to clipboard" : "Couldn't copy", copied ? "success" : "error");
  }

  async function copyBlockLink() {
    const url = new URL(absolutePageUrl(block.pageId));
    url.hash = `block-${block.id}`;
    const copied = await copyText(url.toString());
    setCopiedLink(copied);
    window.setTimeout(() => setCopiedLink(false), 1400);
    notify(copied ? "Copied block link" : "Couldn't copy link", copied ? "success" : "error");
  }

  function moveSelection(direction: "up" | "down") {
    ops.moveSelectedBlocks(block.id, direction);
    closeActionMenu(true);
  }

  function onDragStart(e: React.DragEvent<HTMLButtonElement>) {
    suppressNextClickRef.current = true;
    onMenuClose();
    onDragState(true);
    const selectedIds = ops.selectedBlockIds.has(block.id)
      ? ops.selectedBlockIds
      : new Set([block.id]);
    const blockById = new Map(blocksOnPage.map((candidate) => [candidate.id, candidate]));
    const hasSelectedAncestor = (candidate: Block) => {
      let parentId = candidate.parentId ?? null;
      while (parentId) {
        if (selectedIds.has(parentId)) return true;
        parentId = blockById.get(parentId)?.parentId ?? null;
      }
      return false;
    };
    const draggedRootIds = blocksOnPage
      .filter((candidate) => selectedIds.has(candidate.id) && !hasSelectedAncestor(candidate))
      .sort((a, b) => a.position - b.position)
      .map((candidate) => candidate.id);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(dragType, block.id);
    e.dataTransfer.setData(BLOCK_DRAG_IDS_TYPE, JSON.stringify(draggedRootIds));
    // Use the block group as the drag image so the preview reads as the block.
    const group = e.currentTarget.closest<HTMLElement>("[data-block-id]");
    if (group) {
      const rect = group.getBoundingClientRect();
      e.dataTransfer.setDragImage(group, e.clientX - rect.left, e.clientY - rect.top);
    }
    startBlockAutoScroll();
  }

  function onDragEnd() {
    onDragState(false);
    stopBlockAutoScroll();
    dragStartPointRef.current = null;
    window.setTimeout(() => {
      suppressNextClickRef.current = false;
    }, 0);
  }

  function setColor(token: string) {
    rememberEditorColor(token);
    const changed = ops.setSelectedBlockColor(block.id, token);
    if (changed) notify(token === "default" ? "Cleared color" : "Changed color", "success");
    closeActionMenu(true);
  }

  function turnInto(type: BlockType) {
    if (selectionCount > 1 && MULTI_TURN_INTO.has(type)) {
      ops.changeSelectedType(block.id, type);
    } else if (type === "child_page") ops.createChildPage(block.id);
    else if (type === "link_to_page") ops.createPageLink(block.id);
    else if (type === "child_database") ops.createDatabase(block.id);
    else if (type === "inline_database") ops.createInlineDatabase(block.id);
    else if (type === "column_list") ops.createColumns(block.id, 2);
    else if (type === "simple_table") ops.createSimpleTable(block.id);
    else if (type === "equation") ops.createEquation(block.id);
    else if (type === "synced_block") ops.createSyncedBlock(block.id);
    else if (type === "button") ops.createButton(block.id);
    else if (type === "tab") ops.createTab(block.id);
    else ops.changeSelectedType(block.id, type);
    notify("Changed block type", "success");
    closeActionMenu(true);
  }

  function addBlock(def: BlockDef) {
    setAddMenu(false);
    const type = def.type;
    if (type === "divider") {
      const divider = ops.insertAfter(block.id, "divider");
      if (divider) ops.insertAfter(divider.id, "paragraph");
      return;
    }
    if (
      type === "child_page" ||
      type === "link_to_page" ||
      type === "child_database" ||
      type === "inline_database" ||
      type === "column_list" ||
      type === "simple_table" ||
      type === "equation" ||
      type === "synced_block" ||
      type === "button" ||
      type === "tab"
    ) {
      const inserted = ops.insertAfter(block.id, "paragraph");
      if (!inserted) return;
      if (type === "child_page") ops.createChildPage(inserted.id);
      else if (type === "link_to_page") ops.createPageLink(inserted.id);
      else if (type === "child_database") ops.createDatabase(inserted.id, def.databaseView);
      else if (type === "inline_database") ops.createInlineDatabase(inserted.id, def.databaseView);
      else if (type === "column_list") ops.createColumns(inserted.id, def.columnCount ?? 2);
      else if (type === "simple_table") ops.createSimpleTable(inserted.id);
      else if (type === "equation") ops.createEquation(inserted.id);
      else if (type === "synced_block") ops.createSyncedBlock(inserted.id);
      else if (type === "button") ops.createButton(inserted.id);
      else if (type === "tab") ops.createTab(inserted.id);
      return;
    }
    ops.insertAfter(block.id, type);
  }

  const selectionCount =
    ops.selectedBlockIds.has(block.id) && ops.selectedBlockIds.size > 1
      ? ops.selectedBlockIds.size
      : 1;
  const selectionSuffix = selectionCount > 1 ? ` ${selectionCount} blocks` : "";
  const selectedBlocks =
    selectionCount > 1
      ? blocksOnPage.filter((candidate) => ops.selectedBlockIds.has(candidate.id))
      : [block];
  const selectedCaptionBlocks = selectedBlocks.filter((candidate) => CAPTION_BLOCK_TYPES.has(candidate.type));
  const captionActionAvailable = selectedCaptionBlocks.length > 0;
  const captionActionShows =
    captionActionAvailable &&
    selectedCaptionBlocks.some(
      (candidate) =>
        candidate.content?.showCaption !== true &&
        spansToPlainText(candidate.content?.caption).length === 0
    );
  const selectedTypes = new Set(selectedBlocks.map((candidate) => candidate.type));
  const selectedColors = new Set(
    selectedBlocks.map((candidate) => candidate.content?.color ?? "default")
  );
  const activeColor = selectedColors.size === 1 ? selectedBlocks[0]?.content?.color ?? "default" : "mixed";
  const activeBlockLabel =
    selectedTypes.size === 1
      ? BLOCK_DEFS.find((definition) => definition.type === block.type)?.label ?? "Text"
      : "Mixed";
  const activeColorLabel =
    activeColor === "mixed"
      ? "Mixed"
      : [...TEXT_COLORS, ...BACKGROUND_COLORS].find((color) => color.token === activeColor)?.label ?? "Default";
  const editedAt = block.updatedAt ?? block.createdAt;
  const editedLabel = relativeBlockEditedLabel(editedAt);
  const editedTitle = fullBlockEditedLabel(editedAt);

  function quoteSelectedBlocks() {
    const lines = selectedBlocks
      .map((candidate) => spansToPlainText(candidate.content?.rich).trim() || candidate.plainText || candidate.type)
      .filter(Boolean);
    const quote = lines.slice(0, 6).join("\n");
    const suffix = lines.length > 6 ? "\n..." : "";
    return quote ? `${quote}${suffix}` : `${selectionCount} selected blocks`;
  }

  function captionLabelFor(type: BlockType) {
    if (type === "image") return "Image caption";
    if (type === "video") return "Video caption";
    if (type === "audio") return "Audio caption";
    if (type === "file") return "File caption";
    return "Embed caption";
  }

  function focusCaption(blockId: string, type: BlockType) {
    window.requestAnimationFrame(() => {
      const root = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      const caption = root?.querySelector<HTMLElement>(
        `[role="textbox"][aria-label="${captionLabelFor(type)}"]`
      );
      caption?.focus({ preventScroll: true });
    });
  }

  function toggleCaption() {
    if (!captionActionAvailable) return;
    const show = captionActionShows;
    for (const target of selectedCaptionBlocks) {
      if (show) {
        updateBlock(target.id, {
          content: { ...target.content, showCaption: true, caption: target.content?.caption ?? [] },
        });
      } else {
        updateBlock(target.id, {
          content: { ...target.content, showCaption: false, caption: [] },
        });
      }
    }
    closeActionMenu(false);
    if (show && selectedCaptionBlocks.length === 1) {
      focusCaption(selectedCaptionBlocks[0].id, selectedCaptionBlocks[0].type);
    }
  }

  const blockMenuStyle = (() => {
    if (typeof window === "undefined") return undefined;
    const rawLeft = menuAnchor?.x ?? BLOCK_MENU_MARGIN;
    const rawTop = menuAnchor?.y ?? BLOCK_MENU_MARGIN;
    const rawBottom = menuAnchor?.bottom ?? rawTop;
    const isMobileMenu = window.innerWidth <= 430;
    const estimatedHeight =
      menuPanel === "main"
        ? BLOCK_MENU_MAIN_HEIGHT
        : isMobileMenu
          ? BLOCK_MENU_MOBILE_TALL_HEIGHT
          : BLOCK_MENU_TALL_HEIGHT;
    const availableWidth = Math.max(0, window.innerWidth - BLOCK_MENU_MARGIN * 2);
    const availableHeight = Math.max(0, window.innerHeight - BLOCK_MENU_MARGIN * 2);
    const menuWidth = Math.min(
      BLOCK_MENU_WIDTH,
      availableWidth
    );
    const placementHeight = Math.min(
      menuMeasuredHeight ?? estimatedHeight,
      availableHeight
    );
    const viewportBottom = window.innerHeight - BLOCK_MENU_MARGIN;
    const belowTop = rawTop;
    const aboveTop = rawBottom - placementHeight;
    const top =
      belowTop + placementHeight <= viewportBottom
        ? belowTop
        : aboveTop >= BLOCK_MENU_MARGIN
          ? aboveTop
          : Math.max(BLOCK_MENU_MARGIN, Math.min(belowTop, viewportBottom - placementHeight));
    const left = Math.max(
      BLOCK_MENU_MARGIN,
      Math.min(rawLeft, window.innerWidth - menuWidth - BLOCK_MENU_MARGIN)
    );
    return {
      top,
      left,
      width: menuWidth,
      maxHeight: `min(${estimatedHeight}px, calc(100vh - ${BLOCK_MENU_MARGIN * 2}px))`,
    } satisfies CSSProperties;
  })();

  return (
    <div
      className={styles.gutter}
      contentEditable={false}
      data-menu-open={addMenu || menuOpen ? "true" : undefined}
    >
      <button
        type="button"
        ref={addButtonRef}
        className={styles.gutterBtn}
        title="Add block below"
        aria-label="Add block below"
        aria-haspopup="menu"
        aria-expanded={addMenu}
        onClick={(e) => {
          closeActionMenu(false);
          if (!ops.selectedBlockIds.has(block.id)) {
            ops.selectBlock(block.id);
          }
          setAddAnchor(anchorFromButton(e.currentTarget));
          setAddMenu((open) => !open);
        }}
      >
        <Plus size={17} aria-hidden="true" />
      </button>
      <button
        type="button"
        ref={actionButtonRef}
        className={styles.gutterBtn}
        title="Drag to move. Click to open menu."
        aria-label="Open block actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        draggable
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          dragStartPointRef.current = { x: e.clientX, y: e.clientY };
          suppressNextClickRef.current = false;
        }}
        onPointerCancel={() => {
          dragStartPointRef.current = null;
        }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={(e) => {
          e.stopPropagation();
          if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            return;
          }
          dragStartPointRef.current = null;
          closeAddMenu(false);
          if (!ops.selectedBlockIds.has(block.id)) {
            ops.selectBlock(block.id);
          }
          if (menuOpen) closeActionMenu(true);
          else openActionMenu(blockMenuAnchorFromButton(e.currentTarget));
        }}
      >
        <DragHandleIcon size={18} aria-hidden="true" />
      </button>

      {addMenu && (
        <SlashMenu
          anchor={addAnchor}
          query=""
          onPick={addBlock}
          onClose={() => closeAddMenu(true)}
        />
      )}

      {menuOpen && (
        <BlockActionMenuPortal>
          <button
            type="button"
            className={`${styles.menuBackdrop} ${styles.blockMenuBackdrop}`}
            onClick={() => closeActionMenu(true)}
            tabIndex={-1}
            aria-label="Close block actions"
          />
          <div
            ref={menuRef}
            className={styles.blockMenu}
            style={blockMenuStyle}
            role="menu"
            tabIndex={-1}
            aria-label="Block actions"
            onKeyDown={onMenuKeyDown}
          >
            {menuPanel === "main" && (
              <>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-block-menu-item
                  role="menuitem"
                  onClick={() => {
                    if (selectionCount > 1) ops.deleteSelectedBlocks();
                    else ops.remove(block.id);
                    notifyDeletedBlocks(selectionCount);
                    closeActionMenu(false);
                  }}
                >
                  <Trash size={16} aria-hidden="true" />
                  <span>Delete{selectionSuffix}</span>
                  <span className={styles.menuShortcut}>Del</span>
                </button>
                <button type="button" className={styles.menuItem} data-block-menu-item role="menuitem" onClick={duplicate}>
                  <Copy size={16} aria-hidden="true" />
                  <span>Duplicate{selectionSuffix}</span>
                  <span className={styles.menuShortcut}>⌘D</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-block-menu-item
                  data-submenu="turn"
                  role="menuitem"
                  aria-haspopup="menu"
                  onClick={() => openMenuPanel("turn")}
                >
                  <TurnIntoIcon size={16} aria-hidden="true" />
                  <span>Turn into</span>
                  <span className={styles.menuHint}>{activeBlockLabel} ›</span>
                </button>
                <div className={styles.menuDivider} />
                <button type="button" className={styles.menuItem} data-block-menu-item role="menuitem" onClick={copyBlock}>
                  <Copy size={16} aria-hidden="true" />
                  <span>{copiedBlock ? "Copied" : `Copy${selectionSuffix}`}</span>
                  <span className={styles.menuShortcut}>⌘C</span>
                </button>
                {!ops.templateMode && (
                  <button type="button" className={styles.menuItem} data-block-menu-item role="menuitem" onClick={copyBlockLink}>
                    <LinkIcon size={16} aria-hidden="true" />
                    <span>{copiedLink ? "Copied block link" : "Copy link to block"}</span>
                  </button>
                )}
                {!ops.templateMode && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    data-block-menu-item
                    role="menuitem"
                    onClick={() => {
                      closeActionMenu(false);
                      setMoveDialog(true);
                    }}
                  >
                    <MoveIcon size={16} aria-hidden="true" />
                    <span>Move to{selectionSuffix}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={styles.menuItem}
                  data-block-menu-item
                  role="menuitem"
                  onClick={() => moveSelection("up")}
                >
                  <ArrowUp size={16} aria-hidden="true" />
                  <span>Move up{selectionSuffix}</span>
                  <span className={styles.menuShortcut}>⌘⇧↑</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-block-menu-item
                  role="menuitem"
                  onClick={() => moveSelection("down")}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                  <span>Move down{selectionSuffix}</span>
                  <span className={styles.menuShortcut}>⌘⇧↓</span>
                </button>
                {!ops.templateMode && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    data-block-menu-item
                    role="menuitem"
                    onClick={() => {
                      if (selectionCount > 1) {
                        openComments(block.pageId, block.id, { quote: quoteSelectedBlocks() });
                      } else {
                        openComments(block.pageId, block.id);
                      }
                      closeActionMenu(true);
                    }}
                  >
                    <CommentIcon size={16} aria-hidden="true" />
                    <span>Comment{selectionSuffix}</span>
                  </button>
                )}
                {captionActionAvailable && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    data-block-menu-item
                    role="menuitem"
                    onClick={toggleCaption}
                  >
                    <CommentIcon size={16} aria-hidden="true" />
                    <span>{captionActionShows ? "Add caption" : "Remove caption"}</span>
                  </button>
                )}
                {block.type === "synced_block" && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    data-block-menu-item
                    role="menuitem"
                    onClick={() => {
                      if (block.content?.syncedBlockId) {
                        void ops.unsyncSyncedBlock(block.id);
                      } else {
                        ops.createSyncedBlockCopy(block.id);
                      }
                      closeActionMenu(true);
                    }}
                  >
                    <Copy size={16} aria-hidden="true" />
                    <span>{block.content?.syncedBlockId ? "Unsync synced block" : "Copy synced block"}</span>
                  </button>
                )}
                <div className={styles.menuDivider} />
                <button
                  type="button"
                  className={styles.menuItem}
                  data-block-menu-item
                  data-submenu="color"
                  role="menuitem"
                  aria-haspopup="menu"
                  onClick={() => openMenuPanel("color")}
                >
                  <PaletteIcon size={16} aria-hidden="true" />
                  <span>Color</span>
                  <span className={styles.menuHint}>{activeColorLabel} ›</span>
                </button>
                <div className={styles.menuDivider} />
                <div className={styles.blockMenuMeta} title={editedTitle}>
                  {editedLabel}
                </div>
              </>
            )}
            {menuPanel === "turn" && (
              <>
                <button
                  type="button"
                  className={`${styles.menuItem} ${styles.submenuBack}`}
                  data-block-menu-item
                  role="menuitem"
                  onClick={() => returnToMainMenu("turn")}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  <span>Turn into</span>
                </button>
                <div className={styles.menuCaption}>Choose a block type</div>
                <div className={styles.turnList}>
                  {TURN_INTO.map((t) => {
                    const d = BLOCK_DEFS.find((b) => b.type === t)!;
                    const disabledForSelection = selectionCount > 1 && !MULTI_TURN_INTO.has(t);
                    return (
                      <button
                        type="button"
                        key={t}
                        className={styles.turnItem}
                        data-block-menu-item
                        role="menuitemradio"
                        aria-checked={selectedTypes.size === 1 && block.type === t}
                        data-active={selectedTypes.size === 1 && block.type === t ? "true" : undefined}
                        disabled={disabledForSelection}
                        onClick={() => turnInto(t)}
                      >
                        <span className={styles.turnGlyph} aria-hidden="true">
                          <BlockIcon def={d} size={20} />
                        </span>
                        <span>{d.label}</span>
                        {selectedTypes.size === 1 && block.type === t && (
                          <CheckIcon className={styles.colorCheck} size={14} aria-hidden="true" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {menuPanel === "color" && (
              <>
                <button
                  type="button"
                  className={`${styles.menuItem} ${styles.submenuBack}`}
                  data-block-menu-item
                  role="menuitem"
                  onClick={() => returnToMainMenu("color")}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  <span>Color</span>
                </button>
                <div className={styles.menuLabel}>Text color</div>
                <div className={styles.colorList}>
                  {TEXT_COLORS.map((c) => (
                    <button
                      type="button"
                      key={c.token}
                      className={styles.colorItem}
                      data-block-menu-item
                      role="menuitemradio"
                      aria-checked={activeColor === c.token}
                      onClick={() => setColor(c.token)}
                    >
                      <span className={styles.colorSwatch} data-color={c.token}>
                        A
                      </span>
                      <span>{c.label}</span>
                      {activeColor === c.token && (
                        <CheckIcon className={styles.colorCheck} size={14} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
                <div className={styles.menuDivider} />
                <div className={styles.menuLabel}>Background color</div>
                <div className={styles.colorList}>
                  {BACKGROUND_COLORS.map((c) => (
                    <button
                      type="button"
                      key={c.token}
                      className={styles.colorItem}
                      data-block-menu-item
                      role="menuitemradio"
                      aria-checked={activeColor === c.token}
                      onClick={() => setColor(c.token)}
                    >
                      <span className={styles.colorSwatch} data-color={c.token}>
                        A
                      </span>
                      <span>{c.label}</span>
                      {activeColor === c.token && (
                        <CheckIcon className={styles.colorCheck} size={14} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </BlockActionMenuPortal>
      )}
      {moveDialog && !ops.templateMode && (
        <BlockMoveToDialog
          blockId={block.id}
          sourcePageId={block.pageId}
          title={selectionCount > 1 ? `Move ${selectionCount} blocks to` : undefined}
          onChooseDestination={
            selectionCount > 1
              ? async (destinationPageId) => {
                  await ops.moveSelectedBlocksToPage(block.id, destinationPageId);
                }
              : undefined
          }
          onClose={() => setMoveDialog(false)}
        />
      )}
    </div>
  );
}
