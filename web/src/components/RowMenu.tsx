"use client";

import {
  lazy,
  Suspense,
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
import { useParams, useRouter } from "@/lib/router";
import { copyText } from "@/lib/clipboard";
import { pickLabels } from "@/lib/i18n";
import { menuTimestampLabel, relativeEditedLabel, relativeTimeLabels } from "@/lib/relativeTime";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { absolutePageUrl, openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { isPageVerified } from "@/lib/pageVerification";
import { canEditPage } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import type { BacklinksDisplay, Block, PageCommentsDisplay, PageFont } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import { actorLabel } from "./database/people";
import {
  CheckIcon,
  ChevronRight,
  ClockIcon,
  Copy,
  Download,
  LinkIcon,
  LockIcon,
  MoveIcon,
  OpenInNew,
  Pencil,
  Plus,
  Settings,
  Star,
  StarFilled,
  Trash,
  UnlockIcon,
  Upload,
} from "./icons";
import { CommentIcon, SmileIcon } from "@/icons/hanji";
import { EmojiPicker } from "./EmojiPicker";
import { PageIconGlyph } from "./PageIcon";
import styles from "./RowMenu.module.css";

const MoveToDialog = lazy(() =>
  import("./MoveToDialog").then(({ MoveToDialog }) => ({ default: MoveToDialog }))
);
const UpdatesPanel = lazy(() =>
  import("./UpdatesPanel").then(({ UpdatesPanel }) => ({ default: UpdatesPanel }))
);

const PAGE_FONTS: { value: PageFont; label: string; sample: string }[] = [
  { value: "default", label: "Default", sample: "Ag" },
  { value: "serif", label: "Serif", sample: "Ag" },
  { value: "mono", label: "Mono", sample: "Ag" },
];
const BACKLINKS_DISPLAY_OPTIONS: { value: BacklinksDisplay; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "expanded", label: "Expanded" },
  { value: "off", label: "Off" },
];
const PAGE_COMMENTS_DISPLAY_OPTIONS: { value: PageCommentsDisplay; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "expanded", label: "Expanded" },
  { value: "off", label: "Off" },
];
const EMPTY_BLOCKS: Block[] = [];

const ROW_MENU_LABELS = {
  en: {
    searchActions: "Search actions",
    toast: {
      copiedLink: "Copied link",
      couldntCopyLink: "Couldn't copy link",
      exportedMarkdown: "Exported Markdown",
      couldntExportMarkdown: "Couldn't export Markdown",
      importedBlocks: (count: number) => `Imported ${count} block${count === 1 ? "" : "s"}`,
      nothingToImport: "Nothing to import",
      couldntImportMarkdown: "Couldn't import Markdown",
      verificationRemoved: "Verification removed",
      pageVerified: "Page verified",
      removedFromFavorites: "Removed from Favorites",
      addedToFavorites: "Added to Favorites",
      couldntUpdateFavorites: "Couldn't update Favorites",
      couldntDuplicatePage: "Couldn't duplicate page",
      duplicatedPage: "Duplicated page",
      pageLocked: "Page locked",
      pageUnlocked: "Page unlocked",
      movedToTrash: "Moved to Trash",
      restoredPage: "Restored page",
      couldntMoveToTrash: "Couldn't move to Trash",
    },
  },
  ko: {
    searchActions: "작업을 검색하세요",
    toast: {
      copiedLink: "링크 복사됨",
      couldntCopyLink: "링크를 복사하지 못했습니다",
      exportedMarkdown: "마크다운을 내보냈습니다",
      couldntExportMarkdown: "마크다운을 내보내지 못했습니다",
      importedBlocks: (count: number) => `블록 ${count}개를 가져왔습니다`,
      nothingToImport: "가져올 내용이 없습니다",
      couldntImportMarkdown: "마크다운을 가져오지 못했습니다",
      verificationRemoved: "인증이 해제되었습니다",
      pageVerified: "페이지가 인증되었습니다",
      removedFromFavorites: "즐겨찾기에서 제거됨",
      addedToFavorites: "즐겨찾기에 추가됨",
      couldntUpdateFavorites: "즐겨찾기를 업데이트하지 못했습니다",
      couldntDuplicatePage: "페이지를 복제하지 못했습니다",
      duplicatedPage: "페이지를 복제했습니다",
      pageLocked: "페이지가 잠겼습니다",
      pageUnlocked: "페이지 잠금이 해제되었습니다",
      movedToTrash: "휴지통으로 이동됨",
      restoredPage: "페이지를 복원했습니다",
      couldntMoveToTrash: "휴지통으로 이동하지 못했습니다",
    },
  },
} as const;

function rowMenuLabels() {
  return pickLabels(ROW_MENU_LABELS);
}

type RowMenuVariant = "page" | "database-row" | "inline-page";
type RowOpenMode = "side" | "center" | "full";

function blockPlainText(block: Block) {
  const content = block.content;
  return [
    block.plainText || spansToPlainText(content?.rich),
    spansToPlainText(content?.caption),
    content?.expression,
    content?.fileName,
    content?.table?.flat().join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function countWords(text: string) {
  return (
    text.match(
      /[\uac00-\ud7af]+|[\u3040-\u30ff\u3400-\u9fff]|[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/g,
    )?.length ?? 0
  );
}

function currentRoutePageId() {
  if (typeof window === "undefined") return undefined;
  const match = window.location.pathname.match(/^\/p\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function pageDocumentStats(blocks: Block[]) {
  const text = blocks.map(blockPlainText).join(" ").trim();
  return {
    blocks: blocks.length,
    characters: Array.from(text.replace(/\s/g, "")).length,
    words: countWords(text),
  };
}

// Localized "Edited …" label; missing/unparseable stamps read "No edits yet".
function editedMenuLabel(value?: string) {
  return relativeEditedLabel(value, { year: true }) || relativeTimeLabels().noEditsYet;
}

export function RowMenu({
  pageId,
  onClose,
  anchor,
  onEditProperties,
  onOpenRowIn,
  onRename,
  onAddSubpage,
  variant = "page",
}: {
  pageId: string;
  onClose: () => void;
  anchor?: { x: number; y: number } | null;
  onEditProperties?: (pageId: string) => void;
  onOpenRowIn?: (pageId: string, mode: RowOpenMode) => void;
  onRename?: () => void;
  onAddSubpage?: () => void;
  variant?: RowMenuVariant;
}) {
  const router = useRouter();
  const params = useParams();
  const page = useStore((s) => s.pagesById[pageId]);
  const pagesById = useStore((s) => s.pagesById);
  const pageRoles = useStore((s) => s.pageRolesById);
  const workspace = useStore((s) => s.workspace);
  const currentMember = useStore((s) => s.currentMember);
  const pageBlocks = useStore((s) => s.blocksByPage[pageId] ?? EMPTY_BLOCKS);
  const duplicatePage = useStore((s) => s.duplicatePage);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const updatePage = useStore((s) => s.updatePage);
  const trashPage = useStore((s) => s.trashPage);
  const restorePage = useStore((s) => s.restorePage);
  const loadBlocks = useStore((s) => s.loadBlocks);
  const notify = useStore((s) => s.notify);
  const userId = useStore((s) => s.userId);
  const [moveOpen, setMoveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [actionQuery, setActionQuery] = useState("");
  const [contextPosition, setContextPosition] = useState<{ left: number; top: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const isDatabaseRowMenu = variant === "database-row";
  const isInlinePageMenu = variant === "inline-page";
  const isCompactPageMenu = isDatabaseRowMenu || isInlinePageMenu;
  const openComments = useStore((s) => s.openComments);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [openInOpen, setOpenInOpen] = useState(false);

  const close = useCallback((restoreFocus = true) => {
    onClose();
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    });
  }, [onClose]);

  useEffect(() => {
    if (moveOpen || historyOpen) return;
    if (!restoreFocusRef.current) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>(isCompactPageMenu ? "[data-action-search]" : "[data-menu-item]")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [historyOpen, isCompactPageMenu, moveOpen]);

  useEffect(() => {
    if (page?.kind !== "page") return;
    void loadBlocks(pageId);
  }, [loadBlocks, page?.kind, pageId]);

  // Positioning hook lives before the `!page` early return so hook order stays
  // stable across renders (rules-of-hooks). It reads only anchor/menu state,
  // never `page`, so running it while the page is missing is a no-op.
  useLayoutEffect(() => {
    if (!anchor) {
      setContextPosition(null);
      return;
    }

    const anchorPoint = anchor;
    const margin = 8;
    let frame = 0;
    function place() {
      const node = menuRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const width = Math.max(rect.width, isCompactPageMenu ? 284 : 240);
      const height = Math.max(rect.height, 180);
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      const left = Math.min(Math.max(margin, anchorPoint.x), maxLeft);
      const top = Math.min(Math.max(margin, anchorPoint.y), maxTop);
      setContextPosition((current) =>
        current && Math.abs(current.left - left) < 1 && Math.abs(current.top - top) < 1
          ? current
          : { left, top },
      );
    }

    frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [actionQuery, anchor, customizeOpen, historyOpen, isCompactPageMenu, moveOpen]);

  if (!page) return null;
  const title = pageDisplayTitle(page);
  const rawTitle = page.title.trim();
  const visibleDatabaseRowTitle = rawTitle === "Untitled" ? "" : rawTitle;
  const visibleMenuTitle = isDatabaseRowMenu ? visibleDatabaseRowTitle : title;
  const menuAriaTitle = visibleMenuTitle || (isDatabaseRowMenu ? "untitled database row" : title);
  const normalizedActionQuery = actionQuery.trim().toLocaleLowerCase();
  const matchesAction = (...labels: string[]) =>
    !normalizedActionQuery ||
    labels.some((label) => label.toLocaleLowerCase().includes(normalizedActionQuery));
  const hasVisibleCompactActions = [
    ["Add to Favorites", "Remove from Favorites", "즐겨찾기"],
    ["Edit icon", "아이콘"],
    ["Edit properties", "속성"],
    ["Open in", "다음에서 열기", "Side peek", "Center peek", "Full page"],
    ["Open in new tab", "새 탭"],
    ["Comments", "댓글"],
    ["Copy link", "링크"],
    ["Duplicate", "복제"],
    ["Move to", "옮기기"],
    ["Move to Trash", "휴지통", "Delete"],
  ].some((labels) => matchesAction(...labels));
  const canEditThisPage = canEditPage({
    page,
    pagesById,
    pageRoles,
    workspace,
    currentMember,
    userId,
  });
  const pageVerified = isPageVerified(page);
  const pageStats = pageDocumentStats(pageBlocks);
  const backlinksDisplay = page.backlinksDisplay ?? "default";
  const pageCommentsDisplay = page.pageCommentsDisplay ?? "default";
  const customizeSummaryLabel =
    backlinksDisplay === "default" && pageCommentsDisplay === "default" ? "Default" : "Customized";
  const hasCustomPageIcon = page.iconType !== "none" && !!page.icon;

  const menuStyle = anchor
    ? ({
        "--menu-x": `${anchor.x}px`,
        "--menu-y": `${anchor.y}px`,
        left: `${contextPosition?.left ?? anchor.x}px`,
        top: `${contextPosition?.top ?? anchor.y}px`,
        ...(contextPosition
          ? {
              left: `${contextPosition.left}px`,
              top: `${contextPosition.top}px`,
            }
          : {}),
      } as CSSProperties)
    : undefined;

  function renderMenuSurface(surface: ReactNode) {
    if (!anchor || typeof document === "undefined") return surface;
    return createPortal(surface, document.body);
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (moveOpen) return;
    if (isComposingKeyEvent(e)) return;
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      !e.repeat &&
      e.key.toLowerCase() === "d"
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (canEditThisPage) void duplicateCurrentPage();
      return;
    }
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      !e.repeat &&
      (e.key === "Backspace" || e.key === "Delete")
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (canEditThisPage) void movePageToTrash();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp", "Tab"].includes(e.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ??
        [],
    ).filter((item) => !item.disabled && item.offsetParent !== null);
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex = activeIndex >= 0 ? activeIndex : 0;

    if (e.key === "Tab") {
      nextIndex = e.shiftKey
        ? activeIndex > 0
          ? activeIndex - 1
          : items.length - 1
        : activeIndex >= 0
          ? (activeIndex + 1) % items.length
          : 0;
    } else if (e.key === "ArrowDown") {
      nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex =
        activeIndex > 0
          ? activeIndex - 1
          : items.length - 1;
    } else if (e.key === "PageDown") {
      nextIndex = Math.min((activeIndex >= 0 ? activeIndex : 0) + 5, items.length - 1);
    } else if (e.key === "PageUp") {
      nextIndex = Math.max((activeIndex >= 0 ? activeIndex : items.length - 1) - 5, 0);
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }

    items[nextIndex]?.focus();
  }

  async function onImportFile(file?: File) {
    if (!file || !page) return;
    setImporting(true);
    try {
      const { importMarkdownIntoPage } = await import("./pageMarkdownImport");
      const count = await importMarkdownIntoPage(page, file);
      notify(
        count > 0 ? rowMenuLabels().toast.importedBlocks(count) : rowMenuLabels().toast.nothingToImport,
        count > 0 ? "success" : "default"
      );
      close();
    } catch {
      notify(rowMenuLabels().toast.couldntImportMarkdown, "error");
    } finally {
      setImporting(false);
    }
  }

  async function copyPageLink() {
    const ok = await copyText(absolutePageUrl(pageId, { preserveCurrentSearch: true, omitSearchParams: ["p", "pm"] }));
    notify(ok ? rowMenuLabels().toast.copiedLink : rowMenuLabels().toast.couldntCopyLink, ok ? "success" : "error");
    close();
  }

  async function exportMarkdown() {
    try {
      const { exportPageAsMarkdown } = await import("./pageMarkdownExport");
      await exportPageAsMarkdown(page);
      notify(rowMenuLabels().toast.exportedMarkdown, "success");
    } catch {
      notify(rowMenuLabels().toast.couldntExportMarkdown, "error");
    } finally {
      close();
    }
  }

  async function exportNative() {
    try {
      const { exportPageAsNative } = await import("./nativeExport");
      const { warnings } = await exportPageAsNative(page);
      notify(
        warnings.length
          ? "Exported as Hanji file — attachments left as placeholders."
          : "Exported as Hanji file.",
        "success"
      );
    } catch {
      notify("Couldn't export Hanji file.", "error");
    } finally {
      close();
    }
  }

  function toggleVerification() {
    updatePage(
      pageId,
      pageVerified
        ? {
            verifiedAt: null,
            verifiedBy: null,
            verificationExpiresAt: null,
          }
        : {
            verifiedAt: new Date().toISOString(),
            verifiedBy: userId || "local-user",
            verificationExpiresAt: null,
          }
    );
    notify(pageVerified ? rowMenuLabels().toast.verificationRemoved : rowMenuLabels().toast.pageVerified, "success");
    close();
  }

  async function toggleFavoriteStatus() {
    const wasFavorite = !!page.isFavorite;
    try {
      await toggleFavorite(pageId);
      notify(wasFavorite ? rowMenuLabels().toast.removedFromFavorites : rowMenuLabels().toast.addedToFavorites, "success");
    } catch {
      notify(rowMenuLabels().toast.couldntUpdateFavorites, "error");
    } finally {
      close();
    }
  }

  function openCommentsPanel() {
    openComments(pageId);
    close();
  }

  function openRowIn(mode: RowOpenMode) {
    if (onOpenRowIn) {
      onOpenRowIn(pageId, mode);
    } else if (mode === "full") {
      router.push(pageHref(pageId));
    } else {
      router.push(pageHref(pageId));
    }
    close();
  }

  function openRowProperties() {
    if (onEditProperties) {
      onEditProperties(pageId);
    } else {
      router.push(pageHref(pageId));
    }
    close();
  }

  async function duplicateCurrentPage() {
    const shouldClose = true;
    try {
      const copyPage = await duplicatePage(pageId);
      if (!copyPage) {
        notify(rowMenuLabels().toast.couldntDuplicatePage, "error");
        return;
      }
      notify(rowMenuLabels().toast.duplicatedPage, "success");
      // Database rows are duplicated in place, while tree/page rows open the copy.
      if (copyPage.parentType !== "database") {
        const href = pageHref(copyPage.id);
        router.push(href);
        window.setTimeout(() => {
          if (window.location.pathname !== new URL(href, window.location.origin).pathname) {
            window.location.assign(href);
          }
        }, 0);
      }
    } catch {
      notify(rowMenuLabels().toast.couldntDuplicatePage, "error");
    } finally {
      if (shouldClose) close();
    }
  }

  function toggleLockStatus() {
    const nextLocked = !page.isLocked;
    updatePage(pageId, { isLocked: nextLocked });
    notify(nextLocked ? rowMenuLabels().toast.pageLocked : rowMenuLabels().toast.pageUnlocked, "success");
    close();
  }

  async function movePageToTrash() {
    try {
      await trashPage(pageId);
      notify(rowMenuLabels().toast.movedToTrash, "success", {
        label: "Undo",
        onClick: async () => {
          await restorePage(pageId);
          notify(rowMenuLabels().toast.restoredPage, "success");
          if (params?.pageId === pageId) router.push(pageHref(pageId));
        },
      });
      const targetPath = new URL(pageHref(pageId), window.location.origin).pathname;
      const viewingPage =
        params?.pageId === pageId ||
        currentRoutePageId() === pageId ||
        window.location.pathname === targetPath;
      if (viewingPage) {
        router.push("/");
        window.setTimeout(() => {
          if (window.location.pathname !== "/") window.location.assign("/");
        }, 50);
      }
    } catch {
      notify(rowMenuLabels().toast.couldntMoveToTrash, "error");
    } finally {
      close();
    }
  }

  if (isCompactPageMenu) {
    return renderMenuSurface(
      <>
        <button
          type="button"
          className={styles.backdrop}
          tabIndex={-1}
          aria-label={isDatabaseRowMenu ? "Close database row actions" : "Close page actions"}
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        />
        <div
          ref={menuRef}
          className={`${styles.menu} ${styles.databaseRowMenu} ${anchor ? styles.contextMenu : ""}`}
          style={menuStyle}
          role="menu"
          tabIndex={-1}
          aria-label={
            isDatabaseRowMenu
              ? `Database row actions for ${menuAriaTitle}`
              : `Page actions for ${menuAriaTitle}`
          }
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          <input
            className={styles.actionSearch}
            data-action-search
            type="search"
            placeholder={rowMenuLabels().searchActions}
            value={actionQuery}
            onChange={(e) => setActionQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && actionQuery) {
                e.preventDefault();
                e.stopPropagation();
                setActionQuery("");
              }
            }}
          />
          <div className={styles.sectionLabel}>Page</div>
          <div className={styles.pageInfo} data-has-icon={hasCustomPageIcon ? "true" : "false"}>
            {hasCustomPageIcon && (
              <span className={styles.pageInfoIcon} aria-hidden="true">
                <PageIconGlyph page={page} size={18} fallback="none" />
              </span>
            )}
            <span className={styles.pageInfoText}>
              <strong>{visibleMenuTitle || "\u00A0"}</strong>
              <span>{editedMenuLabel(page.updatedAt ?? page.createdAt)}</span>
            </span>
          </div>
          <div className={styles.divider} role="separator" />
          {matchesAction("Add to Favorites", "Remove from Favorites", "즐겨찾기") && (
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => void toggleFavoriteStatus()}
            >
              {page.isFavorite ? (
                <StarFilled size={16} aria-hidden="true" />
              ) : (
                <Star size={16} aria-hidden="true" />
              )}
              <span>{page.isFavorite ? "Remove from Favorites" : "Add to Favorites"}</span>
            </button>
          )}
          {matchesAction("Edit icon", "아이콘") && (
            <>
              <button
                type="button"
                className={styles.item}
                data-menu-item
                role="menuitem"
                disabled={!canEditThisPage || !!page.isLocked}
                aria-expanded={iconPickerOpen}
                onClick={() => setIconPickerOpen((current) => !current)}
              >
                <SmileIcon size={16} aria-hidden="true" />
                <span>Edit icon</span>
              </button>
              {iconPickerOpen && (
                <div className={styles.compactPicker}>
                  <EmojiPicker
                    uploadTarget={{ pageId }}
                    onPick={(emoji) => {
                      updatePage(pageId, { icon: emoji, iconType: "emoji" });
                      setIconPickerOpen(false);
                    }}
                    onPickImage={(url) => {
                      updatePage(pageId, { icon: url, iconType: "image" });
                      setIconPickerOpen(false);
                    }}
                    onRemove={() => {
                      updatePage(pageId, { icon: "", iconType: "none" });
                      setIconPickerOpen(false);
                    }}
                    onClose={() => setIconPickerOpen(false)}
                  />
                </div>
              )}
            </>
          )}
          {matchesAction("Edit properties", "속성") && isDatabaseRowMenu && (
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={openRowProperties}
            >
              <Settings size={16} aria-hidden="true" />
              <span>Edit properties</span>
              <ChevronRight className={styles.menuDisclosure} size={14} aria-hidden="true" />
            </button>
          )}
          {matchesAction("Open in", "다음에서 열기", "Side peek", "Center peek", "Full page", "Open in new tab", "새 탭") && (
            <>
              <button
                type="button"
                className={styles.item}
                data-menu-item
                role="menuitem"
                aria-expanded={openInOpen}
                onClick={() => setOpenInOpen((current) => !current)}
              >
                <OpenInNew size={16} aria-hidden="true" />
                <span>Open in</span>
                <ChevronRight
                  className={styles.menuDisclosure}
                  data-open={openInOpen ? "true" : undefined}
                  size={14}
                  aria-hidden="true"
                />
              </button>
              {openInOpen && (
                <div className={styles.compactSubmenu} role="group" aria-label="Open in">
                  {isDatabaseRowMenu && onOpenRowIn && (
                    <>
                      <button
                        type="button"
                        className={styles.subItem}
                        data-menu-item
                        role="menuitem"
                        onClick={() => openRowIn("side")}
                      >
                        Side peek
                      </button>
                      <button
                        type="button"
                        className={styles.subItem}
                        data-menu-item
                        role="menuitem"
                        onClick={() => openRowIn("center")}
                      >
                        Center peek
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={styles.subItem}
                    data-menu-item
                    role="menuitem"
                    onClick={() => openRowIn("full")}
                  >
                    Full page
                  </button>
                  <button
                    type="button"
                    className={styles.subItem}
                    data-menu-item
                    role="menuitem"
                    onClick={() => {
                      openPageInNewTab(pageId, { preserveCurrentSearch: true, omitSearchParams: ["p", "pm"] });
                      close();
                    }}
                  >
                    Open in new tab
                  </button>
                </div>
              )}
            </>
          )}
          {matchesAction("Comments", "댓글") && isDatabaseRowMenu && (
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              onClick={openCommentsPanel}
            >
              <CommentIcon size={16} aria-hidden="true" />
              <span>Comments</span>
            </button>
          )}
          {matchesAction("Copy link", "링크") && (
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              onClick={() => void copyPageLink()}
            >
              <LinkIcon size={16} aria-hidden="true" />
              <span>Copy link</span>
              <span className={styles.itemHint}>⌘L</span>
            </button>
          )}
          {matchesAction("Duplicate", "복제") && (
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => void duplicateCurrentPage()}
            >
              <Copy size={16} aria-hidden="true" />
              <span>Duplicate</span>
              <span className={styles.itemHint}>⌘D</span>
            </button>
          )}
          {matchesAction("Move to", "옮기기") && (
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => setMoveOpen(true)}
            >
              <MoveIcon size={16} aria-hidden="true" />
              <span>Move to</span>
              <span className={styles.itemHint}>⌘⇧P</span>
            </button>
          )}
          <div className={styles.divider} role="separator" />
          {matchesAction("Move to Trash", "휴지통", "Delete") && (
            <button
              type="button"
              className={`${styles.item} ${styles.danger}`}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => void movePageToTrash()}
            >
              <Trash size={16} aria-hidden="true" />
              <span>Move to Trash</span>
              <span className={styles.itemHint}>Del</span>
            </button>
          )}
          {!hasVisibleCompactActions && (
            <div className={styles.menuMeta}>
              <span>No matching actions</span>
            </div>
          )}
          <div className={styles.divider} role="separator" />
          <div className={styles.menuMeta}>
            <span>Last edited</span>
            <span>{menuTimestampLabel(page.updatedAt ?? page.createdAt)}</span>
          </div>
        </div>
        <Suspense fallback={null}>
          {moveOpen && (
            <MoveToDialog
              pageId={pageId}
              onClose={() => setMoveOpen(false)}
              onMoved={close}
            />
          )}
        </Suspense>
      </>
    );
  }

  return renderMenuSurface(
    <>
      {!historyOpen && (
        <>
          <button
            type="button"
            className={styles.backdrop}
            tabIndex={-1}
            aria-label="Close page actions"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
          />
          <div
            ref={menuRef}
            className={`${styles.menu} ${anchor ? styles.contextMenu : ""}`}
            style={menuStyle}
            role="menu"
            tabIndex={-1}
            aria-label={`Page actions for ${title}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onMenuKeyDown}
          >
            <div className={styles.pageInfo}>
              <span className={styles.pageInfoIcon} aria-hidden="true">
                <PageIconGlyph page={page} size={18} />
              </span>
              <span className={styles.pageInfoText}>
                <strong>{title}</strong>
                <span>
                  {pageVerified
                    ? `Verified · ${editedMenuLabel(page.updatedAt ?? page.createdAt)}`
                    : editedMenuLabel(page.updatedAt ?? page.createdAt)}
                </span>
              </span>
            </div>
            <div className={styles.divider} role="separator" />
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => void toggleFavoriteStatus()}
            >
              {page.isFavorite ? (
                <StarFilled size={16} aria-hidden="true" />
              ) : (
                <Star size={16} aria-hidden="true" />
              )}
              <span>
                {page.isFavorite ? "Remove from Favorites" : "Add to Favorites"}
              </span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              onClick={() => {
                openPageInNewTab(pageId, { preserveCurrentSearch: true, omitSearchParams: ["p", "pm"] });
                close();
              }}
            >
              <OpenInNew size={16} aria-hidden="true" />
              <span>Open in new tab</span>
            </button>
            <div className={styles.divider} role="separator" />
            {onRename && (
              <button
                type="button"
                className={styles.item}
                data-menu-item
                role="menuitem"
                disabled={!canEditThisPage || !!page.isLocked}
                onClick={() => {
                  if (!canEditThisPage || page.isLocked) return;
                  onRename();
                  close(false);
                }}
              >
                <Pencil size={16} aria-hidden="true" />
                <span>Rename</span>
              </button>
            )}
            {onAddSubpage && (
              <button
                type="button"
                className={styles.item}
                data-menu-item
                role="menuitem"
                disabled={!canEditThisPage || !!page.isLocked}
                onClick={() => {
                  if (!canEditThisPage || page.isLocked) return;
                  onAddSubpage();
                  close();
                }}
              >
                <Plus size={16} aria-hidden="true" />
                <span>Add page inside</span>
              </button>
            )}
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => void duplicateCurrentPage()}
            >
              <Copy size={16} aria-hidden="true" />
              <span>Duplicate</span>
              <span className={styles.itemHint}>⌘D</span>
            </button>
            <div className={styles.divider} role="separator" />
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => setMoveOpen(true)}
            >
              <MoveIcon size={16} aria-hidden="true" />
              <span>Move to</span>
              <span className={styles.itemHint}>⌘⇧P</span>
            </button>
            <button
              type="button"
              className={`${styles.item} ${styles.danger}`}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage}
              onClick={() => void movePageToTrash()}
            >
              <Trash size={16} aria-hidden="true" />
              <span>Move to Trash</span>
              <span className={styles.itemHint}>⌘⌫</span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              onClick={() => void copyPageLink()}
            >
              <LinkIcon size={16} aria-hidden="true" />
              <span>Copy link</span>
              <span className={styles.itemHint}>⌘L</span>
            </button>
            <div className={styles.divider} role="separator" />
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              onClick={() => void exportMarkdown()}
            >
              <Download size={16} aria-hidden="true" />
              <span>Export as Markdown</span>
              <span className={styles.itemHint}>.md</span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              onClick={() => void exportNative()}
            >
              <Download size={16} aria-hidden="true" />
              <span>Export as Hanji file</span>
              <span className={styles.itemHint}>.hanji.json</span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              disabled={!canEditThisPage || !!page.isLocked || importing}
              onClick={() => {
                if (!canEditThisPage || page.isLocked || importing) return;
                if (importInputRef.current) {
                  importInputRef.current.value = "";
                  importInputRef.current.click();
                }
              }}
            >
              <Upload size={16} aria-hidden="true" />
              <span>{importing ? "Importing..." : "Import Markdown"}</span>
              <span className={styles.itemHint}>.md</span>
            </button>
            <div className={styles.divider} role="separator" />
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitemcheckbox"
              aria-checked={!!page.isLocked}
              disabled={!canEditThisPage}
              onClick={toggleLockStatus}
            >
              {page.isLocked ? (
                <UnlockIcon size={16} aria-hidden="true" />
              ) : (
                <LockIcon size={16} aria-hidden="true" />
              )}
              <span>{page.isLocked ? "Unlock page" : "Lock page"}</span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              onClick={() => setHistoryOpen(true)}
            >
              <ClockIcon size={16} aria-hidden="true" />
              <span>Page history</span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitemcheckbox"
              aria-checked={pageVerified}
              disabled={!canEditThisPage}
              onClick={toggleVerification}
            >
              <CheckIcon size={16} aria-hidden="true" />
              <span>{pageVerified ? "Remove verification" : "Verify page"}</span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitem"
              aria-expanded={customizeOpen}
              onClick={() => setCustomizeOpen((current) => !current)}
            >
              <Settings size={16} aria-hidden="true" />
              <span>Customize page</span>
              <span className={styles.itemHint}>{customizeSummaryLabel}</span>
              <ChevronRight
                className={styles.menuDisclosure}
                data-open={customizeOpen ? "true" : undefined}
                size={14}
                aria-hidden="true"
              />
            </button>
            {customizeOpen && (
              <div className={styles.customizePanel} role="group" aria-label="Customize page">
                <div className={styles.customizeRow}>
                  <span>Backlinks</span>
                  <div className={styles.segmentedMenu} role="group" aria-label="Backlinks display">
                    {BACKLINKS_DISPLAY_OPTIONS.map((option) => {
                      const active = backlinksDisplay === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={styles.segmentedMenuItem}
                          data-active={active ? "true" : undefined}
                          data-menu-item
                          role="menuitemradio"
                          aria-checked={active}
                          disabled={!canEditThisPage || !!page.isLocked}
                          onClick={() => updatePage(pageId, { backlinksDisplay: option.value })}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className={styles.customizeRow}>
                  <span>Page comments</span>
                  <div className={styles.segmentedMenu} role="group" aria-label="Page comments display">
                    {PAGE_COMMENTS_DISPLAY_OPTIONS.map((option) => {
                      const active = pageCommentsDisplay === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={styles.segmentedMenuItem}
                          data-active={active ? "true" : undefined}
                          data-menu-item
                          role="menuitemradio"
                          aria-checked={active}
                          disabled={!canEditThisPage || !!page.isLocked}
                          onClick={() => updatePage(pageId, { pageCommentsDisplay: option.value })}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            <div className={styles.divider} role="separator" />
            <div className={styles.sectionLabel}>Style</div>
            <div className={styles.fontPicker} role="group" aria-label="Page font">
              {PAGE_FONTS.map((font) => {
                const active = (page.font ?? "default") === font.value;
                return (
                  <button
                    key={font.value}
                    type="button"
                    className={styles.fontOption}
                    data-font={font.value}
                    data-active={active ? "true" : undefined}
                    data-menu-item
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={!canEditThisPage || !!page.isLocked}
                    onClick={() => updatePage(pageId, { font: font.value })}
                  >
                    {active && (
                      <span className={styles.fontCheck} aria-hidden="true">
                        <CheckIcon size={11} />
                      </span>
                    )}
                    <span className={styles.fontSample}>{font.sample}</span>
                    <span>{font.label}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitemcheckbox"
              aria-checked={!!page.smallText}
              disabled={!canEditThisPage || !!page.isLocked}
              onClick={() => updatePage(pageId, { smallText: !page.smallText })}
            >
              <span>Small text</span>
              <span className={styles.menuSwitch} data-on={page.smallText ? "true" : undefined} aria-hidden="true">
                <span />
              </span>
            </button>
            <button
              type="button"
              className={styles.item}
              data-menu-item
              role="menuitemcheckbox"
              aria-checked={!!page.fullWidth}
              disabled={!canEditThisPage || !!page.isLocked}
              onClick={() => updatePage(pageId, { fullWidth: !page.fullWidth })}
            >
              <span>Full width</span>
              <span className={styles.menuSwitch} data-on={page.fullWidth ? "true" : undefined} aria-hidden="true">
                <span />
              </span>
            </button>
            <div className={styles.divider} role="separator" />
            <div className={styles.menuMeta}>
              <span>Created</span>
              <span>{menuTimestampLabel(page.createdAt)}</span>
            </div>
            <div className={styles.menuMeta}>
              <span>Created by</span>
              <span>{actorLabel(page.createdBy, userId)}</span>
            </div>
            <div className={styles.menuMeta}>
              <span>Last edited</span>
              <span>{menuTimestampLabel(page.updatedAt)}</span>
            </div>
            <div className={styles.menuMeta}>
              <span>Edited by</span>
              <span>{actorLabel(page.lastEditedBy ?? page.createdBy, userId)}</span>
            </div>
            {pageVerified && (
              <div className={styles.menuMeta}>
                <span>Verified</span>
                <span>{menuTimestampLabel(page.verifiedAt)}</span>
              </div>
            )}
            <div className={styles.divider} role="separator" />
            <div className={styles.menuMeta}>
              <span>Words</span>
              <span>{pageStats.words.toLocaleString()}</span>
            </div>
            <div className={styles.menuMeta}>
              <span>Characters</span>
              <span>{pageStats.characters.toLocaleString()}</span>
            </div>
            <div className={styles.menuMeta}>
              <span>Blocks</span>
              <span>{pageStats.blocks.toLocaleString()}</span>
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              className={styles.hiddenFileInput}
              aria-hidden="true"
              tabIndex={-1}
              onChange={(e) => void onImportFile(e.currentTarget.files?.[0])}
            />
          </div>
        </>
      )}
      <Suspense fallback={null}>
        {historyOpen && (
          <UpdatesPanel
            pageId={pageId}
            placement="topbar"
            title="Page history"
            onClose={() => {
              setHistoryOpen(false);
              close();
            }}
          />
        )}
        {moveOpen && (
          <MoveToDialog
            pageId={pageId}
            onClose={() => setMoveOpen(false)}
            onMoved={close}
          />
        )}
      </Suspense>
    </>
  );
}
