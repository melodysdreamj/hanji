"use client";

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { positionBetween } from "@/lib/ids";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { canCreateWorkspacePage, canEditPage } from "@/lib/permissions";
import type { Page, PageParentType } from "@/lib/types";
import { useStore } from "@/lib/store";
import { BLOCK_DRAG_IDS_TYPE, BLOCK_DRAG_TYPE, PAGE_DRAG_TYPE } from "./dndTypes";
import { ChevronRight, DotsHorizontal, DragHandleIcon, LockIcon, Plus } from "@/icons/hanji";
import { PageIconGlyph } from "./PageIcon";
import { RowMenu } from "./RowMenu";
import styles from "./Sidebar.module.css";
import { useTranslation } from "react-i18next";

type DropIntent = "before" | "inside" | "after";
type TreePage = Pick<
  Page,
  "title" | "kind" | "icon" | "iconType" | "parentId" | "parentType" | "isLocked"
>;

function currentPageId(params: ReturnType<typeof useParams>) {
  const value = params?.pageId;
  return typeof value === "string" ? value : undefined;
}

function isAncestor(pagesById: Record<string, Page>, pageId: string, maybeChildId?: string) {
  let cur = maybeChildId ? pagesById[maybeChildId] : undefined;
  const guard = new Set<string>();
  while (cur?.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.parentId === pageId) return true;
    cur = pagesById[cur.parentId];
  }
  return false;
}

function isInSubtree(pagesById: Record<string, Page>, rootId: string, maybeChildId: string) {
  return rootId === maybeChildId || isAncestor(pagesById, rootId, maybeChildId);
}

function dropIntent(e: React.DragEvent<HTMLElement>): DropIntent {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - rect.top;
  if (y < rect.height * 0.28) return "before";
  if (y > rect.height * 0.72) return "after";
  return "inside";
}

function siblingsFor(
  pagesById: Record<string, Page>,
  parentId: string | null,
  parentType: PageParentType,
  excludeId?: string
) {
  return Object.values(pagesById)
    .filter((p) => {
      if (p.inTrash || p.id === excludeId) return false;
      if (parentId === null) return p.parentId == null || p.parentType === "workspace";
      return p.parentId === parentId && p.parentType === parentType;
    })
    .sort((a, b) => a.position - b.position);
}

function focusTreeRow(pageId: string) {
  document
    .querySelector<HTMLElement>(`[data-tree-page-id="${CSS.escape(pageId)}"]`)
    ?.focus();
}

function visibleTreeRows(from?: HTMLElement | null) {
  const tree = from?.closest<HTMLElement>('[role="tree"]');
  if (tree) {
    return Array.from(
      tree.querySelectorAll<HTMLElement>('[data-page-tree-item="true"]'),
    );
  }
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-page-tree-item="true"]'),
  );
}

function isDisplayableSidebarChild(page: Page) {
  if (page.kind === "database" && page.parentType === "page") {
    return page.title.trim().length > 0;
  }
  return true;
}

const TREE_EDGE_ZONE = 56;
const TREE_MAX_SCROLL_SPEED = 14;
let treeAutoScrollRaf = 0;
let treeAutoScrollY = 0;
let treeAutoScrollActive = false;

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

function startTreeAutoScroll() {
  if (treeAutoScrollActive) return;
  treeAutoScrollActive = true;
  let lastTarget: HTMLElement | null = null;

  const onDragOver = (e: DragEvent) => {
    lastTarget = e.target as HTMLElement | null;
    const scroller = nearestScrollable(lastTarget);
    const rect =
      scroller === window
        ? { top: 0, bottom: window.innerHeight }
        : (scroller as HTMLElement).getBoundingClientRect();
    const topDistance = e.clientY - rect.top;
    const bottomDistance = rect.bottom - e.clientY;

    if (topDistance < TREE_EDGE_ZONE) {
      treeAutoScrollY = -Math.ceil(((TREE_EDGE_ZONE - topDistance) / TREE_EDGE_ZONE) * TREE_MAX_SCROLL_SPEED);
    } else if (bottomDistance < TREE_EDGE_ZONE) {
      treeAutoScrollY = Math.ceil(((TREE_EDGE_ZONE - bottomDistance) / TREE_EDGE_ZONE) * TREE_MAX_SCROLL_SPEED);
    } else {
      treeAutoScrollY = 0;
    }
  };

  const tick = () => {
    if (treeAutoScrollY !== 0) {
      const scroller = nearestScrollable(lastTarget);
      if (scroller === window) window.scrollBy(0, treeAutoScrollY);
      else (scroller as HTMLElement).scrollTop += treeAutoScrollY;
    }
    treeAutoScrollRaf = window.requestAnimationFrame(tick);
  };

  document.addEventListener("dragover", onDragOver, true);
  treeAutoScrollRaf = window.requestAnimationFrame(tick);
  (startTreeAutoScroll as { cleanup?: () => void }).cleanup = () => {
    document.removeEventListener("dragover", onDragOver, true);
    window.cancelAnimationFrame(treeAutoScrollRaf);
    treeAutoScrollY = 0;
    treeAutoScrollActive = false;
  };
}

function stopTreeAutoScroll() {
  (startTreeAutoScroll as { cleanup?: () => void }).cleanup?.();
}

// Memoized: the sidebar re-renders per editor keystroke (pagesById identity
// changes on the debounced page touch), and without memo every visible tree
// row re-rendered with it. Props are primitives except excludePageIds, whose
// Set is rebuilt when pagesById changes — compare it by content, not identity.
function excludePageIdsEqual(a?: ReadonlySet<string>, b?: ReadonlySet<string>) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export const PageTreeItem = memo(
  PageTreeItemComponent,
  (prev, next) =>
    prev.pageId === next.pageId &&
    prev.depth === next.depth &&
    prev.expandableShortcut === next.expandableShortcut &&
    prev.flat === next.flat &&
    prev.index === next.index &&
    prev.setSize === next.setSize &&
    excludePageIdsEqual(prev.excludePageIds, next.excludePageIds)
);

function PageTreeItemComponent({
  pageId,
  depth,
  excludePageIds,
  expandableShortcut = false,
  flat = false,
  index,
  setSize,
}: {
  pageId: string;
  depth: number;
  excludePageIds?: ReadonlySet<string>;
  // `flat` renders a non-draggable shortcut row. Favorites/Shared can opt back
  // into nested disclosure while still avoiding duplicate draggable tree nodes
  // that fight the Private tree for the same stored `position`.
  expandableShortcut?: boolean;
  flat?: boolean;
  index?: number;
  setSize?: number;
}) {
  const router = useRouter();
  const params = useParams();
  const { t } = useTranslation(["pageTreeItem", "common"]);
  // Subscribe only to this row's page identity and derived permission. The old
  // whole-map subscriptions re-rendered every visible tree row whenever any
  // unrelated page/block changed (typing in the editor included).
  const pageSnapshot = useStore(
    useShallow((s) => {
      const currentPage = s.pagesById[pageId];
      return {
        exists: !!currentPage,
        title: currentPage?.title,
        kind: currentPage?.kind,
        icon: currentPage?.icon,
        iconType: currentPage?.iconType,
        parentId: currentPage?.parentId,
        parentType: currentPage?.parentType,
        isLocked: currentPage?.isLocked,
        canEditThisPage:
          !!currentPage &&
          canEditPage({
            page: currentPage,
            pagesById: s.pagesById,
            pageRoles: s.pageRolesById,
            workspace: s.workspace,
            currentMember: s.currentMember,
            userId: s.userId,
          }),
      };
    })
  );
  // Page content edits legitimately advance updatedAt/lastEditedBy, but none
  // of those fields affect a tree row. Reconstruct the small visual snapshot
  // from primitive selector values so an editor keystroke cannot re-render
  // the active row merely because the backing Page object got a new identity.
  const page: TreePage = {
    title: pageSnapshot.title ?? "",
    kind: pageSnapshot.kind ?? "page",
    icon: pageSnapshot.icon,
    iconType: pageSnapshot.iconType ?? "none",
    parentId: pageSnapshot.parentId,
    parentType: pageSnapshot.parentType ?? "workspace",
    isLocked: pageSnapshot.isLocked,
  };
  const canEditThisPage = pageSnapshot.canEditThisPage;
  const children = useStore(useShallow((s) => s.childPages(pageId)));
  const displayChildren = children.filter(isDisplayableSidebarChild);
  const visibleChildren = excludePageIds
    ? displayChildren.filter((child) => !excludePageIds.has(child.id))
    : displayChildren;
  const createPage = useStore((s) => s.createPage);
  const duplicatePage = useStore((s) => s.duplicatePage);
  const movePage = useStore((s) => s.movePage);
  const moveBlockToPage = useStore((s) => s.moveBlockToPage);
  const copyBlockToPage = useStore((s) => s.copyBlockToPage);
  const updatePage = useStore((s) => s.updatePage);
  const notify = useStore((s) => s.notify);
  const treeExpanded = useStore((s) => s.treeExpandedPageIds.has(pageId));
  const setTreePageExpanded = useStore((s) => s.setTreePageExpanded);
  const rowRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelledRef = useRef(false);
  const expandTimerRef = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [drop, setDrop] = useState<DropIntent | null>(null);
  const [dropCopy, setDropCopy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [shortcutExpanded, setShortcutExpanded] = useState(false);

  function clearExpandTimer() {
    if (expandTimerRef.current !== null) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  }

  const activeId = currentPageId(params);
  const active = activeId === pageId;
  const canRenderSubtree = !flat || expandableShortcut;
  const hasChildren = canRenderSubtree && visibleChildren.length > 0;
  const usesShortcutExpansion = flat && expandableShortcut;
  const expanded = canRenderSubtree && (usesShortcutExpansion ? shortcutExpanded : treeExpanded);
  const canExpandEmptyPage = canRenderSubtree && page?.kind === "page";
  const canToggleDisclosure = hasChildren || canExpandEmptyPage;
  const showEmptyChildren = canExpandEmptyPage && expanded && !hasChildren;
  const showHoverDisclosure = !renaming;
  const pageTitle = pageDisplayTitle(page);
  const canAddInside = !!page && !flat && page.kind === "page" && !page.isLocked && canEditThisPage;
  const canDragThisPage = !flat && !renaming && canEditThisPage;
  const rowIndent = 8 + depth * 14;
  const rowStyle = {
    paddingLeft: rowIndent,
    "--tree-drag-handle-left": `${rowIndent}px`,
  } as CSSProperties;
  const emptyChildrenStyle = {
    paddingLeft: rowIndent + 38,
  } as CSSProperties;

  function canEditPageById(targetPageId?: string | null) {
    const state = useStore.getState();
    const targetPage = targetPageId ? state.pagesById[targetPageId] : undefined;
    return canEditPage({
      page: targetPage,
      pagesById: state.pagesById,
      pageRoles: state.pageRolesById,
      workspace: state.workspace,
      currentMember: state.currentMember,
      userId: state.userId,
    });
  }

  function canCreateAtRoot() {
    const state = useStore.getState();
    return canCreateWorkspacePage({
      workspace: state.workspace,
      currentMember: state.currentMember,
      userId: state.userId,
    });
  }

  function setExpanded(nextExpanded: boolean) {
    if (usesShortcutExpansion) {
      setShortcutExpanded(nextExpanded);
      return;
    }
    setTreePageExpanded(pageId, nextExpanded);
  }

  // Reveal the active row when navigation lands on a deeply nested page. Flat
  // mirror rows in Favorites/Shared should not fight over the sidebar scroll.
  useEffect(() => {
    if (active && !flat) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, flat]);

  useEffect(() => {
    const tree = rowRef.current?.closest<HTMLElement>('[role="tree"]');
    if (!tree) return;
    const rows = Array.from(
      tree.querySelectorAll<HTMLElement>('[data-page-tree-item="true"]')
    );
    if (rows.length === 0) return;
    const activeRow = rows.find((row) => row.getAttribute("aria-current") === "page");
    const existingTabStop = rows.find((row) => row.tabIndex === 0);
    const tabStop = activeRow ?? existingTabStop ?? rows[0];
    for (const row of rows) row.tabIndex = row === tabStop ? 0 : -1;
  }, [activeId, expanded, visibleChildren.length]);

  useEffect(
    () => () => {
      clearExpandTimer();
      stopTreeAutoScroll();
    },
    []
  );

  useEffect(() => {
    if (!renaming) return;
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renaming]);

  if (!pageSnapshot.exists || excludePageIds?.has(pageId)) return null;

  async function createSubpage() {
    if (!canAddInside) {
      notify(page?.isLocked ? t("pageTreeItem:pageLocked") : t("pageTreeItem:pageAccessRequired"), "default");
      return;
    }
    if (page.isLocked) {
      notify(t("pageTreeItem:pageLocked"), "default");
      return;
    }
    const last = children[children.length - 1];
    const sub = await createPage({
      parentId: pageId,
      parentType: "page",
      afterPosition: last?.position,
    });
    setTreePageExpanded(pageId, true);
    router.push(pageHref(sub.id));
  }

  function addSubpage(e: React.MouseEvent) {
    e.stopPropagation();
    void createSubpage();
  }

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded(!expanded);
  }

  function openPage(e: React.MouseEvent<HTMLElement>) {
    if (renaming) return;
    if (e.metaKey || e.ctrlKey) {
      openPageInNewTab(pageId);
    } else {
      router.push(pageHref(pageId));
    }
  }

  function beginRename() {
    if (!canEditThisPage) {
      notify(t("pageTreeItem:pageAccessRequired"), "default");
      return;
    }
    if (page.isLocked) {
      notify(t("pageTreeItem:pageLocked"), "default");
      return;
    }
    renameCancelledRef.current = false;
    setRenameDraft(page.title);
    setRenaming(true);
  }

  function normalizedRenameTitle() {
    return renameDraft.replace(/\s*\n+\s*/g, " ");
  }

  function commitRename(restoreFocus = false) {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      return;
    }
    const nextTitle = normalizedRenameTitle();
    setRenaming(false);
    if (nextTitle !== page.title) {
      void updatePage(pageId, { title: nextTitle });
    }
    if (restoreFocus) {
      window.requestAnimationFrame(() => rowRef.current?.focus());
    }
  }

  function cancelRename() {
    renameCancelledRef.current = true;
    setRenameDraft(page.title);
    setRenaming(false);
    window.requestAnimationFrame(() => rowRef.current?.focus());
  }

  function onRowKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;

    if (e.key === "F2") {
      e.preventDefault();
      beginRename();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
      else router.push(pageHref(pageId));
    } else if (e.key === "ArrowRight" && canRenderSubtree) {
      e.preventDefault();
      if (!expanded) {
        setExpanded(true);
      } else if (hasChildren) {
        window.requestAnimationFrame(() => focusTreeRow(visibleChildren[0]?.id ?? pageId));
      }
    } else if (e.key === "ArrowLeft" && canRenderSubtree) {
      e.preventDefault();
      if (expanded) {
        setExpanded(false);
      } else if (page.parentId) {
        focusTreeRow(page.parentId);
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = visibleTreeRows(rowRef.current);
      const index = rows.findIndex((row) => row === rowRef.current);
      if (index < 0) return;
      const nextIndex =
        e.key === "ArrowDown"
          ? Math.min(index + 1, rows.length - 1)
          : Math.max(index - 1, 0);
      rows[nextIndex]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const rows = visibleTreeRows(rowRef.current);
      const target = e.key === "Home" ? rows[0] : rows[rows.length - 1];
      target?.focus();
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const rect = rowRef.current?.getBoundingClientRect();
      setMenuAnchor(rect ? { x: rect.left + 24, y: rect.bottom } : null);
      setMenuOpen(true);
    }
  }

  function droppedPageId(e: React.DragEvent) {
    return (
      e.dataTransfer.getData(PAGE_DRAG_TYPE) ||
      e.dataTransfer.getData("text/plain")
    );
  }

  function droppedBlockIds(e: React.DragEvent) {
    const raw = e.dataTransfer.getData(BLOCK_DRAG_IDS_TYPE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
        }
      } catch {
        // Fall through to the single-block payload.
      }
    }
    const id = e.dataTransfer.getData(BLOCK_DRAG_TYPE);
    return id ? [id] : [];
  }

  function sourcePageForBlock(blockId: string) {
    const state = useStore.getState();
    for (const [candidatePageId, blocks] of Object.entries(state.blocksByPage)) {
      if (blocks.some((block) => block.id === blockId)) return state.pagesById[candidatePageId];
    }
    return undefined;
  }

  function canDrop(draggedId: string, intent: DropIntent) {
    const pagesById = useStore.getState().pagesById;
    if (!draggedId || isInSubtree(pagesById, draggedId, pageId)) return false;
    const dragged = pagesById[draggedId];
    if (!canEditPageById(draggedId)) return false;
    const sourceParentLocked = !!(dragged?.parentId && pagesById[dragged.parentId]?.isLocked);
    if (sourceParentLocked) return false;
    if (intent === "inside") {
      if (!canAddInside) return false;
      return true;
    }
    const targetParent = page.parentId ? pagesById[page.parentId] : undefined;
    if (targetParent?.isLocked) return false;
    if (page.parentId) return canEditPageById(page.parentId);
    if (page.parentType === "database") return canEditPageById(page.parentId);
    if (!targetParent) return canCreateAtRoot();
    return true;
  }

  function canDropBlocks(blockIds: string[], copy = false) {
    if (blockIds.length === 0 || !canAddInside) return false;
    const sourcePages = blockIds.map(sourcePageForBlock);
    if (sourcePages.some((sourcePage) => !sourcePage)) return false;
    if (copy) return true;
    const state = useStore.getState();
    return sourcePages.every(
      (sourcePage) =>
        !sourcePage?.isLocked &&
        canEditPage({
          page: sourcePage,
          pagesById: state.pagesById,
          pageRoles: state.pageRolesById,
          workspace: state.workspace,
          currentMember: state.currentMember,
          userId: state.userId,
        })
    );
  }

  function blockDropSuccessMessage(copy: boolean, count: number) {
    return copy ? t("pageTreeItem:copiedBlocks", { count }) : t("pageTreeItem:movedBlocks", { count });
  }

  async function dropPage(draggedId: string, intent: DropIntent, copy: boolean) {
    if (!canDrop(draggedId, intent)) {
      notify(copy ? t("pageTreeItem:cantCopyPageHere") : t("pageTreeItem:cantMovePageHere"), "default");
      return;
    }
    try {
      const droppedPage = copy ? await duplicatePage(draggedId) : undefined;
      const droppedPageId = copy ? droppedPage?.id : draggedId;
      if (!droppedPageId) {
        notify(copy ? t("pageTreeItem:couldntCopyPage") : t("pageTreeItem:couldntMovePage"), "error");
        return;
      }

      if (intent === "inside") {
        const pagesById = useStore.getState().pagesById;
        const siblings = siblingsFor(pagesById, pageId, "page", draggedId);
        await movePage(
          droppedPageId,
          pageId,
          "page",
          positionBetween(siblings[siblings.length - 1]?.position, undefined)
        );
        setTreePageExpanded(pageId, true);
        notify(copy ? t("pageTreeItem:copiedPage") : t("pageTreeItem:movedPage"), "success");
        return;
      }

      const newParentId = page.parentId ?? null;
      const newParentType = newParentId === null ? "workspace" : page.parentType;
      const pagesById = useStore.getState().pagesById;
      const siblings = siblingsFor(pagesById, newParentId, newParentType, draggedId);
      const targetIndex = siblings.findIndex((p) => p.id === pageId);
      const prev = intent === "before" ? siblings[targetIndex - 1] : siblings[targetIndex];
      const next = intent === "before" ? siblings[targetIndex] : siblings[targetIndex + 1];
      await movePage(
        droppedPageId,
        newParentId,
        newParentType,
        positionBetween(prev?.position, next?.position)
      );
      notify(copy ? t("pageTreeItem:copiedPage") : t("pageTreeItem:movedPage"), "success");
    } catch {
      notify(copy ? t("pageTreeItem:couldntCopyPage") : t("pageTreeItem:couldntMovePage"), "error");
    }
  }

  async function dropBlocksIntoPage(blockIds: string[], copy: boolean) {
    if (!canDropBlocks(blockIds, copy)) {
      notify(copy ? t("pageTreeItem:cantCopyBlocksHere") : t("pageTreeItem:cantMoveBlocksHere"), "default");
      return;
    }
    try {
      let copiedCount = 0;
      for (const blockId of blockIds) {
        if (copy) {
          const copied = await copyBlockToPage(blockId, pageId);
          if (copied) copiedCount += 1;
        } else {
          await moveBlockToPage(blockId, pageId);
        }
      }
      const count = copy ? copiedCount : blockIds.length;
      if (count === 0 || (copy && count !== blockIds.length)) {
        notify(copy ? t("pageTreeItem:couldntCopyBlocks") : t("pageTreeItem:couldntMoveBlocks"), "error");
        return;
      }
      notify(blockDropSuccessMessage(copy, count), "success");
    } catch {
      notify(copy ? t("pageTreeItem:couldntCopyBlocks") : t("pageTreeItem:couldntMoveBlocks"), "error");
    }
  }

  function onRowDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer.types).includes(BLOCK_DRAG_TYPE)) {
      const blockIds = droppedBlockIds(e);
      if (!canDropBlocks(blockIds, e.altKey)) {
        setDrop(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      setDrop("inside");
      setDropCopy(e.altKey);
      clearExpandTimer();
      return;
    }

    if (flat) return;
    const draggedId = droppedPageId(e);
    const intent = dropIntent(e);
    if (!canDrop(draggedId, intent)) {
      clearExpandTimer();
      setDrop(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    setDrop(intent);
    setDropCopy(e.altKey);
    // Auto-expand a collapsed parent after a hover dwell so the dragged page
    // can be dropped onto a deep descendant.
    if (intent === "inside" && hasChildren && !expanded) {
      if (expandTimerRef.current === null) {
        expandTimerRef.current = window.setTimeout(() => {
          expandTimerRef.current = null;
          setExpanded(true);
        }, 600);
      }
    } else {
      clearExpandTimer();
    }
  }

  function onRowDragLeave() {
    clearExpandTimer();
    setDrop(null);
    setDropCopy(false);
  }

  function onRowDrop(e: React.DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer.types).includes(BLOCK_DRAG_TYPE)) {
      const blockIds = droppedBlockIds(e);
      if (!canDropBlocks(blockIds, e.altKey)) return;
      e.preventDefault();
      e.stopPropagation();
      setDrop(null);
      setDropCopy(false);
      void dropBlocksIntoPage(blockIds, e.altKey);
      return;
    }

    if (flat) return;
    e.preventDefault();
    e.stopPropagation();
    clearExpandTimer();
    stopTreeAutoScroll();
    const draggedId = droppedPageId(e);
    const intent = dropIntent(e);
    setDrop(null);
    setDropCopy(false);
    void dropPage(draggedId, intent, e.altKey);
  }

  function onPageDragStart(e: React.DragEvent<HTMLElement>) {
    if (!canDragThisPage) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(PAGE_DRAG_TYPE, pageId);
    e.dataTransfer.setData("text/plain", pageId);
    setDragging(true);
    startTreeAutoScroll();
  }

  function onPageDragEnd() {
    clearExpandTimer();
    stopTreeAutoScroll();
    setDragging(false);
    setDrop(null);
    setDropCopy(false);
  }

  return (
    <>
      <div
        ref={rowRef}
        className={`${styles.treeRow} ${active ? styles.treeRowActive : ""}`}
        role="treeitem"
        tabIndex={active || (!activeId && depth === 0 && (index ?? 0) === 0) ? 0 : -1}
        aria-label={page.isLocked ? t("pageTreeItem:lockedName", { title: pageTitle }) : pageTitle}
        aria-level={depth + 1}
        aria-current={active ? "page" : undefined}
        aria-selected={active}
        aria-expanded={canToggleDisclosure ? expanded : undefined}
        aria-posinset={index == null ? undefined : index + 1}
        aria-setsize={setSize}
        draggable={canDragThisPage}
        data-page-tree-item="true"
        data-tree-page-id={pageId}
        data-tree-page-kind={page.kind}
        data-tree-parent-id={page.parentId ?? ""}
        data-tree-parent-type={page.parentType}
        data-can-drag={canDragThisPage ? "true" : undefined}
        data-hover-leading={showHoverDisclosure ? "chevron" : undefined}
        data-dragging={dragging}
        data-drop={drop ?? undefined}
        data-drop-copy={dropCopy ? "true" : undefined}
        data-has-children={hasChildren}
        style={rowStyle}
        onClick={openPage}
        onFocus={(event) => {
          for (const row of visibleTreeRows(event.currentTarget)) {
            row.tabIndex = row === event.currentTarget ? 0 : -1;
          }
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          beginRename();
        }}
        onKeyDown={onRowKeyDown}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            openPageInNewTab(pageId);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuAnchor({ x: e.clientX, y: e.clientY });
          setMenuOpen(true);
        }}
        onDragStart={flat ? undefined : onPageDragStart}
        onDragEnd={flat ? undefined : onPageDragEnd}
        onDragOver={onRowDragOver}
        onDragLeave={onRowDragLeave}
        onDrop={onRowDrop}
      >
        {!flat && (
          <span
            className={styles.treeDragHandle}
            data-tree-drag-handle="true"
            draggable={canDragThisPage}
            title={t("pageTreeItem:dragToMove", { title: pageTitle })}
            aria-hidden="true"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onDragStart={onPageDragStart}
            onDragEnd={onPageDragEnd}
          >
            <DragHandleIcon size={15} />
          </span>
        )}
        <span className={styles.treeLeading} data-tree-leading="true">
          {canToggleDisclosure ? (
            <button
              type="button"
              className={`${styles.disclosure} ${expanded ? styles.disclosureOpen : ""}`}
              onClick={toggle}
              tabIndex={-1}
              aria-label={expanded ? t("pageTreeItem:collapse", { title: pageTitle }) : t("pageTreeItem:expand", { title: pageTitle })}
              aria-expanded={expanded}
              data-tree-disclosure="true"
            >
              <ChevronRight size={14} />
            </button>
          ) : showHoverDisclosure ? (
            <span
              className={styles.disclosure}
              aria-hidden="true"
              data-tree-disclosure="true"
              data-tree-disclosure-kind="hover"
            >
              <ChevronRight size={14} />
            </span>
          ) : null}
          <span className={styles.treeIcon} data-tree-icon="true">
            <PageIconGlyph page={page} size={16} />
          </span>
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            className={styles.treeRenameInput}
            value={renameDraft}
            aria-label={t("pageTreeItem:rename", { title: pageTitle })}
            spellCheck={false}
            onChange={(e) => setRenameDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (isComposingKeyEvent(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            onBlur={() => commitRename()}
          />
        ) : (
          <span className={styles.treeTitle} data-tree-title="true">{pageTitle}</span>
        )}
        {page.isLocked && !renaming && (
          <span className={styles.treeLock} title={t("pageTreeItem:locked")} aria-label={t("pageTreeItem:lockedPage")}>
            <LockIcon size={12} aria-hidden="true" />
          </span>
        )}
        <span className={styles.treeActions}>
          <button
            type="button"
            className={styles.iconBtn}
            title={t("pageTreeItem:actionsTitle")}
            aria-label={t("pageTreeItem:openActions", { title: pageTitle })}
            onClick={(e) => {
              e.stopPropagation();
              // Anchor to the button so RowMenu uses the viewport-clamped
              // .contextMenu placement instead of the unclamped .menu style.
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuAnchor({ x: rect.left, y: rect.bottom });
              setMenuOpen(true);
            }}
          >
            <DotsHorizontal size={16} />
          </button>
          {canAddInside && (
            <button
              type="button"
              className={styles.iconBtn}
              title={t("pageTreeItem:addInsideTitle")}
              aria-label={t("pageTreeItem:addInside", { title: pageTitle })}
              onClick={addSubpage}
            >
              <Plus size={16} />
            </button>
          )}
        </span>
        {menuOpen && (
          <RowMenu
            pageId={pageId}
            anchor={menuAnchor}
            onClose={() => {
              setMenuOpen(false);
              setMenuAnchor(null);
            }}
            onRename={beginRename}
            onAddSubpage={canAddInside ? () => void createSubpage() : undefined}
          />
        )}
      </div>

      {expanded && (hasChildren || showEmptyChildren) && (
        <div role="group" aria-label={t("pageTreeItem:subpages", { title: pageTitle })}>
          {hasChildren ? (
            visibleChildren.map((c, childIndex) => (
              <PageTreeItem
                key={c.id}
                pageId={c.id}
                depth={depth + 1}
                excludePageIds={excludePageIds}
                expandableShortcut={expandableShortcut}
                flat={flat}
                index={childIndex}
                setSize={visibleChildren.length}
              />
            ))
          ) : (
            <div
              className={styles.treeEmptyChildren}
              style={emptyChildrenStyle}
              data-tree-empty-children="true"
            >
              {t("pageTreeItem:noPagesInside")}
            </div>
          )}
        </div>
      )}
    </>
  );
}
