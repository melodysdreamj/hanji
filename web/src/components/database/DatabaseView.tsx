"use client";

import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageFaviconHref, setDocumentChrome } from "@/lib/documentChrome";
import { motionSafeScrollBehavior } from "@/lib/motion";
import { databaseDisplayTitle, pageDisplayTitle } from "@/lib/pageTitle";
import type {
  PageAwarenessMode,
  PageAwarenessTextRange,
  PagePresenceAwareness,
} from "@/lib/pagePresence";
import {
  spansToPlainText,
  type Block,
  type BlockType,
  type DbView,
  type Page,
  type TextSpan,
  type ViewType,
} from "@/lib/types";
import {
  databaseRowsQueryKey,
  useStore,
  type DatabaseRowPageState,
  type DatabaseRowsQuery,
} from "@/lib/store";
import {
  LOCAL_DATABASE_MUTATION_EVENT,
  PAGE_ROOM_MUTATION_RECEIVED_EVENT,
  publishPageRoomMutation,
  type LocalDatabaseMutationChange,
  type PageRoomMutationReceived,
} from "@/lib/pageRoomEvents";
import { positionBetween } from "@/lib/ids";
import { copyText } from "@/lib/clipboard";
import {
  absolutePageUrl,
  absoluteSharedPageUrl,
  openPageInNewTab,
  openSharedPageInNewTab,
  pageHref,
  sharedPageHref,
} from "@/lib/navigation";
import {
  ArrowDown,
  ChartIcon,
  CheckIcon,
  ChevronDown,
  CommentIcon,
  Copy,
  DotsHorizontal,
  DoubleChevronRight,
  LinkIcon,
  LockIcon,
  OpenAsPage,
  OpenInNew,
  Plus,
  Star,
  StarFilled,
  TableIcon,
  Trash,
} from "@/icons/hanji";
import { PageCover } from "../PageCover";
import { PageFindBar, selectedTextForPageFind } from "../PageFindBar";
import { PageHeader } from "../PageHeader";
import { RowMenu } from "../RowMenu";
import { Editor } from "../editor/Editor";
import { RowProperties } from "./RowProperties";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { ChartView } from "./ChartView";
import { ListView } from "./ListView";
import { GalleryView } from "./GalleryView";
import { CalendarView } from "./CalendarView";
import { TimelineView } from "./TimelineView";
import { FormView } from "./FormView";
import { createDefaultFormViewConfig } from "@/lib/formView";
import {
  appendScopedViewId,
  cloneInlineScopedViewConfig,
  filterViewsByNotionLinkedDatabaseTargets,
  inlineDatabaseScopedViewOwner,
  isImportedNotionView,
  isImportedUntitledView,
  isInlineDatabaseScopedView,
  isTemplateLinkedView,
  orderImportedInlineViewsForNotionChrome,
} from "./importedViewModel";
import { databaseViewLabels } from "./databaseViewLabels";
import { ViewNameField } from "./DatabaseFilterEditors";
import { DatabaseToolbar } from "./DatabaseToolbar";
import {
  NOTION_2023_VIEW_TYPES,
  ViewTypeIcon,
  databaseViewLink,
  effectiveOpenPageIn,
  onSegmentedOptionGroupKeyDown,
  placeViewTabMenu,
  templateBodyPlaceholder,
} from "./databaseViewShared";
import {
  applyView,
  databaseViewSubitemParentScope,
  tableInitialLoadLimit,
} from "./query";
import styles from "./database.module.css";
const RENDERABLE_IMPORTED_VIEW_TYPE_SET = new Set<ViewType>(
  NOTION_2023_VIEW_TYPES.map((item) => item.type)
);
const INLINE_SCOPED_VIEW_TYPES: ViewType[] = [
  "table",
  "board",
  "gallery",
  "list",
  "timeline",
  "calendar",
  "chart",
];
const INLINE_DATABASE_COMMAND_EVENT = "hanji:inline-database-command";
const VIEW_TAB_DRAG = "application/x-hanji-db-view";
const BOUNDED_CARD_VIEW_ROW_LIMIT = 50;

function isBoundedCardView(view: DbView | undefined): view is DbView {
  return view?.type === "board" || view?.type === "list" || view?.type === "gallery";
}

function isRenderableDatabaseView(view: DbView) {
  return RENDERABLE_IMPORTED_VIEW_TYPE_SET.has(view.type);
}

function ImportedUnsupportedView({ view }: { view: DbView }) {
  const notionType = view.config?.unsupportedNotionViewType ?? view.config?.notionType ?? view.type;
  const labels = databaseViewLabels();
  const typeLabel = labels.viewTypes[notionType as ViewType] ?? (notionType || labels.unsupported);
  return (
    <div className={styles.unsupportedImportedView} role="note">
      <span className={styles.unsupportedImportedViewIcon} aria-hidden="true">
        <ChartIcon size={18} />
      </span>
      <span className={styles.unsupportedImportedViewText}>
        <strong>{labels.unsupportedViewTitle(typeLabel)}</strong>
        <span>{labels.unsupportedViewBody}</span>
      </span>
    </div>
  );
}

function DatabaseLoadingShell({ placement }: { placement: "page" | "inline" }) {
  const hideSingleInlineViewTab = placement === "inline";
  const hasRowGutter = false;
  const cells = placement === "inline" ? [0] : [0, 1, 2];
  const dataColumns = cells.map((_, index) => (index === 0 ? "260px" : "180px")).join(" ");
  const columns = hasRowGutter
    ? `112px ${dataColumns} 58px`
    : `${dataColumns} 58px`;
  const rowColumns = hasRowGutter ? `112px ${dataColumns}` : dataColumns;
  return (
    <div
      className={`${styles.db} ${styles.dbLoadingShell}`}
      data-placement={placement}
      data-imported-notion-inline={placement === "inline" ? "true" : undefined}
      aria-busy="true"
      aria-label={databaseViewLabels().loadingDatabase}
    >
      <div className={styles.dbChrome} data-database-chrome>
        <div
          className={`${styles.viewTabs} ${styles.loadingViewTabs}`}
          data-view-tabs-hidden={hideSingleInlineViewTab ? "true" : undefined}
          aria-hidden={hideSingleInlineViewTab ? "true" : undefined}
        >
          <div className={`${styles.viewTabWrap} ${styles.loadingViewTabWrap}`} data-active="true">
            <div className={`${styles.viewTab} ${styles.viewTabActive} ${styles.loadingViewTab}`}>
              <span className={styles.viewGlyph}>
                <TableIcon size={14} aria-hidden="true" />
              </span>
              <span>{databaseViewLabels().defaultView}</span>
            </div>
          </div>
        </div>
        <div className={`${styles.dbToolbar} ${styles.loadingToolbar}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className={styles.viewBody}>
        <div className={styles.tableScroll}>
          <div
            className={`${styles.table} ${styles.loadingTable}`}
            data-row-gutter={hasRowGutter ? "true" : undefined}
            data-row-height="medium"
          >
            <div className={styles.tableHead} style={{ gridTemplateColumns: columns }}>
              {hasRowGutter && <div className={styles.rowGutterHead} aria-hidden="true" />}
              {cells.map((cell, index) => (
                <div
                  key={`loading-head-${cell}`}
                  className={`${styles.headCell} ${styles.loadingHeadCell}`}
                  data-first={index === 0 ? "true" : undefined}
                >
                  <span />
                </div>
              ))}
              <div className={styles.addCol} aria-hidden="true">
                <span className={styles.loadingAddCol} />
              </div>
            </div>
            {Array.from({ length: 3 }).map((_, rowIndex) => (
              <div
                key={`loading-row-${rowIndex}`}
                className={styles.tableSkeletonRow}
                data-table-rows-loading
                style={{ gridTemplateColumns: rowColumns }}
              >
                {hasRowGutter && <div className={styles.rowGutterCell} aria-hidden="true" />}
                {cells.map((cell, index) => (
                  <div
                    key={`loading-cell-${rowIndex}-${cell}`}
                    className={styles.tableSkeletonCell}
                    data-first={index === 0 ? "true" : undefined}
                  >
                    <span />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
const VIEW_TAB_ADD_BUTTON_WIDTH = 34;
const VIEW_TAB_OVERFLOW_MIN_WIDTH = 92;
const VIEW_TAB_FIT_SAFETY = 10;
const VIEW_TAB_INLINE_TOOLBAR_RESERVE = 72;
const ROW_PEEK_PARAM = "p";
const ROW_PEEK_MODE_PARAM = "pm";
const ROW_PEEK_MODE_SIDE = "s";
const ROW_PEEK_MODE_CENTER = "c";
const HASH_BLOCK_PREFIX = "block-";

function viewTabId(viewId: string) {
  return `database-view-tab-${viewId}`;
}

function viewPanelId(viewId: string) {
  return `database-view-panel-${viewId}`;
}

function viewTabTextWidth(label: string) {
  return Array.from(label || databaseViewLabels().untitled).reduce((width, char) => {
    if (/\p{Emoji_Presentation}/u.test(char)) return width + 16;
    if (/[가-힣ㄱ-ㅎㅏ-ㅣ一-龥ぁ-ゟ゠-ヿ]/u.test(char)) return width + 13.5;
    if (/[A-Z0-9]/.test(char)) return width + 8.2;
    if (char === " ") return width + 4;
    return width + 7.2;
  }, 0);
}

function estimateViewTabWidth(view: DbView) {
  const textWidth = Math.min(160, Math.max(22, viewTabTextWidth(view.name)));
  return Math.ceil(8 + 16 + 6 + textWidth + 22 + 2);
}

function estimateOverflowViewTabWidth(count: number) {
  if (count <= 0) return 0;
  return Math.max(
    VIEW_TAB_OVERFLOW_MIN_WIDTH,
    Math.ceil(8 + viewTabTextWidth(databaseViewLabels().moreViews(count)) + 17 + 8)
  );
}

function importedVisibleViewTabsForWidth(
  views: DbView[],
  activeId: string | undefined,
  availableWidth: number,
  reserveAddView: boolean
) {
  if (views.length <= 4) return views;
  const firstView = views[0];
  if (!firstView) return [];

  if (availableWidth <= 0) {
    const primary = views.slice(0, 3);
    const active = activeId ? views.find((view) => view.id === activeId) : undefined;
    return active && !primary.some((view) => view.id === active.id)
      ? [...views.slice(0, 2), active]
      : primary;
  }

  const mandatoryIds = new Set<string>();
  if (views[0]) mandatoryIds.add(views[0].id);
  if (activeId) mandatoryIds.add(activeId);

  let visibleIds = new Set(mandatoryIds);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hiddenCount = views.length - visibleIds.size;
    const reservedWidth =
      (reserveAddView ? VIEW_TAB_ADD_BUTTON_WIDTH : 0) +
      estimateOverflowViewTabWidth(hiddenCount) +
      VIEW_TAB_INLINE_TOOLBAR_RESERVE +
      VIEW_TAB_FIT_SAFETY;
    const budget = Math.max(estimateViewTabWidth(firstView), availableWidth - reservedWidth);
    const nextVisibleIds = new Set(mandatoryIds);
    let used = views
      .filter((view) => nextVisibleIds.has(view.id))
      .reduce((total, view) => total + estimateViewTabWidth(view), 0);

    for (const view of views) {
      if (nextVisibleIds.has(view.id)) continue;
      const width = estimateViewTabWidth(view);
      if (used + width <= budget) {
        nextVisibleIds.add(view.id);
        used += width;
      }
    }

    if (nextVisibleIds.size === visibleIds.size) {
      visibleIds = nextVisibleIds;
      break;
    }
    visibleIds = nextVisibleIds;
  }

  return views.filter((view) => visibleIds.has(view.id));
}

function currentUrlViewId() {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("v");
}

function currentUrlRowPeekId() {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(ROW_PEEK_PARAM);
}

function replaceUrlViewId(viewId: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (viewId) url.searchParams.set("v", viewId);
  else url.searchParams.delete("v");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function writeUrlRowPeekId(
  pageId: string | null,
  mode: "push" | "replace",
  opts: { clearHash?: boolean; peekMode?: "side" | "center" } = {}
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (pageId) {
    url.searchParams.set(ROW_PEEK_PARAM, pageId);
    url.searchParams.set(
      ROW_PEEK_MODE_PARAM,
      opts.peekMode === "center" ? ROW_PEEK_MODE_CENTER : ROW_PEEK_MODE_SIDE
    );
  } else {
    url.searchParams.delete(ROW_PEEK_PARAM);
    url.searchParams.delete(ROW_PEEK_MODE_PARAM);
  }
  if (opts.clearHash) url.hash = "";
  const href = `${url.pathname}${url.search}${url.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  const state = window.history.state;
  if (mode === "push") window.history.pushState(state, "", href);
  else window.history.replaceState(state, "", href);
}

function rowPeekUrlOwnership(
  rowId: string | null,
  dbId: string,
  rows: Page[],
  pagesById: Record<string, Page>
): "none" | "belongs" | "foreign" | "unknown" {
  if (!rowId) return "none";
  if (rows.some((row) => row.id === rowId)) return "belongs";

  const row = pagesById[rowId];
  if (!row) return "unknown";
  if (row.parentType === "database" && row.parentId === dbId && !row.inTrash) return "belongs";
  return "foreign";
}

function BoundedCardView({
  db,
  view,
  rows,
  rowPage,
  rowQuery,
  readOnly,
  search,
  contextPageId,
  loadMoreDatabaseRows,
  onEditRowProperties,
  onOpenRow,
  onOpenRowIn,
}: {
  db: Page;
  view: DbView;
  rows: Page[];
  rowPage?: DatabaseRowPageState;
  rowQuery: DatabaseRowsQuery;
  readOnly: boolean;
  search: string;
  contextPageId?: string;
  loadMoreDatabaseRows: (dbId: string, query?: DatabaseRowsQuery) => Promise<void>;
  onEditRowProperties: (pageId: string) => void;
  onOpenRow: (pageId: string) => void;
  onOpenRowIn: (pageId: string, mode: "side" | "center" | "full") => void;
}) {
  const [visibleRowLimit, setVisibleRowLimit] = useState(BOUNDED_CARD_VIEW_ROW_LIMIT);
  const renderedRows = rows.slice(0, visibleRowLimit);
  const hasHiddenLocalRows = renderedRows.length < rows.length;
  const hasRemoteMoreRows = rowPage?.hasMore === true;

  function loadMoreRows() {
    if (hasHiddenLocalRows) {
      setVisibleRowLimit((current) =>
        Math.min(rows.length, current + BOUNDED_CARD_VIEW_ROW_LIMIT)
      );
      return;
    }
    if (!hasRemoteMoreRows || rowPage?.loadingMore) return;
    setVisibleRowLimit((current) => current + BOUNDED_CARD_VIEW_ROW_LIMIT);
    void loadMoreDatabaseRows(db.id, rowQuery);
  }

  return (
    <>
      {view.type === "board" && (
        <BoardView
          db={db}
          view={view}
          rows={renderedRows}
          rowsViewApplied
          readOnly={readOnly}
          search={search}
          contextPageId={contextPageId}
          onOpenRow={onOpenRow}
          onEditRowProperties={onEditRowProperties}
          onOpenRowIn={onOpenRowIn}
        />
      )}
      {view.type === "list" && (
        <ListView
          db={db}
          view={view}
          rows={renderedRows}
          rowsViewApplied
          rowQuery={rowQuery}
          readOnly={readOnly}
          search={search}
          contextPageId={contextPageId}
          onOpenRow={onOpenRow}
          onEditRowProperties={onEditRowProperties}
          onOpenRowIn={onOpenRowIn}
        />
      )}
      {view.type === "gallery" && (
        <GalleryView
          db={db}
          view={view}
          rows={renderedRows}
          rowsViewApplied
          readOnly={readOnly}
          search={search}
          contextPageId={contextPageId}
          onOpenRow={onOpenRow}
          onEditRowProperties={onEditRowProperties}
          onOpenRowIn={onOpenRowIn}
        />
      )}
      {(hasHiddenLocalRows || hasRemoteMoreRows) && (
        <button
          type="button"
          className={styles.viewLoadMore}
          data-view-load-more
          disabled={rowPage?.loadingMore}
          onClick={loadMoreRows}
        >
          <ArrowDown size={14} aria-hidden="true" />
          {rowPage?.loadingMore
            ? databaseViewLabels().loadingMore
            : databaseViewLabels().loadMore}
        </button>
      )}
    </>
  );
}

export function DatabaseView({
  db,
  skipRemoteLoad = false,
  readOnly: inheritedReadOnly = false,
  publicReadOnly = false,
  sharedToken,
  initialViewId,
  visibleViewIds,
  notionLinkedDatabaseTargetIds,
  syncUrl = true,
  placement = "page",
  contextPageId,
  scopedViewOwnerId,
  onScopedViewsChange,
  publishAwareness,
  remoteAwarenessByBlock = {},
  syncRowUrl: syncRowUrlProp,
}: {
  db: Page;
  skipRemoteLoad?: boolean;
  readOnly?: boolean;
  publicReadOnly?: boolean;
  sharedToken?: string;
  initialViewId?: string;
  visibleViewIds?: string[];
  notionLinkedDatabaseTargetIds?: string[];
  syncUrl?: boolean;
  placement?: "page" | "inline";
  contextPageId?: string;
  scopedViewOwnerId?: string;
  onScopedViewsChange?: (viewIds: string[], activeViewId: string | null) => void;
  publishAwareness?: (
    blockId: string,
    mode: PageAwarenessMode,
    selectedBlockIds?: string[],
    textRange?: PageAwarenessTextRange,
  ) => void;
  remoteAwarenessByBlock?: Record<string, PagePresenceAwareness[]>;
  syncRowUrl?: boolean;
}) {
  useTranslation(["databaseView", "common"]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const routedViewId = searchParams.get("v");
  const reactSelectionSlotId = useId();
  const tableSelectionChromeSlotId = `table-selection-chrome-${reactSelectionSlotId.replace(/:/g, "")}`;
  const loadDatabase = useStore((s) => s.loadDatabase);
  const loadDatabaseRows = useStore((s) => s.loadDatabaseRows);
  const loadMoreDatabaseRows = useStore((s) => s.loadMoreDatabaseRows);
  const warmDatabaseRowDetail = useStore((s) => s.warmDatabaseRowDetail);
  const views = useStore(useShallow((s) => s.dbViews(db.id)));
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rowPage = useStore(useShallow((s) => s.databaseRowPagesByDb[db.id]));
  const pagesById = useStore((s) => s.pagesById);
  const contextPage = contextPageId ? pagesById[contextPageId] : undefined;
  const containingRowPageId =
    contextPage?.parentType === "database" && !contextPage.inTrash ? contextPage.id : undefined;
  const loaded = useStore((s) => s.loadedDbs.has(db.id));
  const metadataLoaded = loaded || views.length > 0 || props.length > 0;
  const addView = useStore((s) => s.addView);
  const updateView = useStore((s) => s.updateView);
  const deleteView = useStore((s) => s.deleteView);
  const restoreDeletedView = useStore((s) => s.restoreDeletedView);
  const notify = useStore((s) => s.notify);
  const [activeId, setActiveId] = useState<string | null>(() =>
    syncUrl ? currentUrlViewId() ?? initialViewId ?? null : initialViewId ?? null
  );
  const [addOpen, setAddOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewType, setNewViewType] = useState<ViewType>("table");
  const [viewMenuId, setViewMenuId] = useState<string | null>(null);
  const [viewSearches, setViewSearches] = useState<Record<string, string>>({});
  const [draggingViewId, setDraggingViewId] = useState<string | null>(null);
  const [dragOverViewId, setDragOverViewId] = useState<string | null>(null);
  const [dragOverViewSide, setDragOverViewSide] = useState<"before" | "after">("before");
  const [addViewMenuStyle, setAddViewMenuStyle] = useState<CSSProperties | undefined>();
  const [viewActionMenuStyle, setViewActionMenuStyle] = useState<CSSProperties | undefined>();
  const [viewOverflowOpen, setViewOverflowOpen] = useState(false);
  const [viewOverflowMenuStyle, setViewOverflowMenuStyle] = useState<CSSProperties | undefined>();
  const [viewTabsAvailableWidth, setViewTabsAvailableWidth] = useState(0);
  const syncRowUrl = syncRowUrlProp ?? syncUrl;
  const metadataViewIds = useMemo(() => {
    const ids = [...(visibleViewIds ?? [])];
    if (initialViewId) ids.push(initialViewId);
    return ids.filter((id, index) => id.trim().length > 0 && ids.indexOf(id) === index);
  }, [initialViewId, visibleViewIds]);
  const metadataViewIdsKey = metadataViewIds.join(",");
  // The metadata-load effect keys off `metadataViewIdsKey` (a stable content
  // hash) so it fires only when the set of view ids actually changes, not on
  // every render where `metadataViewIds` gets a new array identity. Read the
  // array itself through a ref so the effect can pass it to loadDatabase.
  const metadataViewIdsRef = useRef(metadataViewIds);
  useEffect(() => {
    metadataViewIdsRef.current = metadataViewIds;
  });
  const [peekId, setPeekId] = useState<string | null>(() => (syncUrl && syncRowUrl ? currentUrlRowPeekId() : null));
  const [renderedPeekId, setRenderedPeekId] = useState<string | null>(peekId);
  const [rowPeekClosing, setRowPeekClosing] = useState(false);
  const [rowPropertiesMenuRequest, setRowPropertiesMenuRequest] = useState<{
    pageId: string;
    tick: number;
  } | null>(null);
  const [searchFocusTick, setSearchFocusTick] = useState(0);
  const peekReturnRef = useRef<HTMLElement | null>(null);
  const peekIdRef = useRef<string | null>(peekId);
  const viewTabsRef = useRef<HTMLDivElement>(null);
  const dbRootRef = useRef<HTMLDivElement>(null);
  const addViewButtonRef = useRef<HTMLButtonElement>(null);
  const viewOverflowButtonRef = useRef<HTMLButtonElement>(null);
  const newViewNameRef = useRef<HTMLInputElement>(null);
  const addViewMenuRef = useRef<HTMLDivElement>(null);
  const viewActionMenuRef = useRef<HTMLDivElement>(null);
  const viewOverflowMenuRef = useRef<HTMLDivElement>(null);
  const viewActionReturnRef = useRef<HTMLElement | null>(null);
  const activeRowsRequestControllerRef = useRef<AbortController | null>(null);

  function focusViewTab(viewId: string) {
    viewTabsRef.current
      ?.querySelector<HTMLButtonElement>(`[data-view-tab="${viewId}"]`)
      ?.focus();
  }

  function focusViewActionButton(viewId: string) {
    viewTabsRef.current
      ?.querySelector<HTMLButtonElement>(`[data-view-actions="${viewId}"]`)
      ?.focus();
  }

  function scrollViewTabIntoView(viewId: string, opts: { preferStart?: boolean } = {}) {
    const align = () => {
      const tablist = viewTabsRef.current;
      if (!tablist) return;
      const tabItems = Array.from(tablist.querySelectorAll<HTMLElement>("[data-view-tab-wrap]"));
      const targetIndex = tabItems.findIndex((item) => item.getAttribute("data-view-tab-wrap") === viewId);
      const target = targetIndex >= 0 ? tabItems[targetIndex] : null;
      if (!target) return;

      const margin = 6;
      const tablistRect = tablist.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const visibleLeft = tablist.scrollLeft;
      const visibleRight = visibleLeft + tablist.clientWidth;
      const targetLeft = tablist.scrollLeft + targetRect.left - tablistRect.left;
      const targetRight = tablist.scrollLeft + targetRect.right - tablistRect.left;
      const maxScrollLeft = Math.max(0, tablist.scrollWidth - tablist.clientWidth);
      let nextScrollLeft = tablist.scrollLeft;
      const shouldPreferStart =
        opts.preferStart &&
        window.matchMedia("(max-width: 720px)").matches &&
        targetIndex >= 3;
      const startMargin = shouldPreferStart ? 0 : margin;

      if (shouldPreferStart || targetLeft < visibleLeft + margin || targetRight > visibleRight - margin) {
        nextScrollLeft = targetLeft - startMargin;
      }

      tablist.scrollLeft = Math.min(maxScrollLeft, Math.max(0, nextScrollLeft));
    };

    align();
    window.setTimeout(align, 0);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(align);
      window.setTimeout(align, 80);
      window.setTimeout(align, 140);
    });
  }

  function alignViewTabElementToCleanStart(element: HTMLElement | null) {
    const tablist = viewTabsRef.current;
    if (!tablist || !element || !window.matchMedia("(max-width: 720px)").matches) return;

    const tablistRect = tablist.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const elementLeft = tablist.scrollLeft + elementRect.left - tablistRect.left;
    const maxScrollLeft = Math.max(0, tablist.scrollWidth - tablist.clientWidth);
    tablist.scrollLeft = Math.min(maxScrollLeft, Math.max(0, elementLeft));
  }

  function closeAddViewMenu(restoreFocus = false) {
    setAddOpen(false);
    setAddViewMenuStyle(undefined);
    setNewViewName("");
    setNewViewType("table");
    if (restoreFocus) {
      window.requestAnimationFrame(() => addViewButtonRef.current?.focus());
    }
  }

  function closeViewActionMenu(restoreFocus = false) {
    const id = viewMenuId;
    const returnTarget = viewActionReturnRef.current;
    viewActionReturnRef.current = null;
    setViewMenuId(null);
    setViewActionMenuStyle(undefined);
    if (restoreFocus && id) {
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) {
          returnTarget.focus();
          return;
        }
        focusViewActionButton(id);
      });
    }
  }

  function closeViewOverflowMenu(restoreFocus = false) {
    setViewOverflowOpen(false);
    setViewOverflowMenuStyle(undefined);
    if (restoreFocus) {
      window.requestAnimationFrame(() => viewOverflowButtonRef.current?.focus());
    }
  }

  const warmRowDetail = useCallback(
    (pageId: string) => {
      if (skipRemoteLoad || publicReadOnly) return;
      warmDatabaseRowDetail(db.id, pageId);
    },
    [db.id, publicReadOnly, skipRemoteLoad, warmDatabaseRowDetail],
  );

  function openRowInMode(pageId: string, mode: "side" | "center" | "full") {
    warmRowDetail(pageId);
    if (mode === "full" && (!publicReadOnly || sharedToken)) {
      router.push(publicReadOnly && sharedToken ? sharedPageHref(sharedToken, pageId) : pageHref(pageId));
      return;
    }
    const activeElement = document.activeElement;
    peekReturnRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    setPeekId(pageId);
    if (syncRowUrl) {
      writeUrlRowPeekId(pageId, "push", {
        clearHash: true,
        peekMode: mode === "center" ? "center" : "side",
      });
    }
  }

  function openRowPeek(pageId: string) {
    openRowInMode(pageId, activeOpenPageIn === "full" ? "full" : activeOpenPageIn === "center" ? "center" : "side");
  }

  function openRowPropertiesMenu(pageId: string) {
    setRowPropertiesMenuRequest({ pageId, tick: Date.now() });
    openRowInMode(pageId, "side");
  }

  function closeRowPeek() {
    setPeekId(null);
    if (syncRowUrl) writeUrlRowPeekId(null, "replace", { clearHash: true });
    window.requestAnimationFrame(() => {
      peekReturnRef.current?.focus();
      peekReturnRef.current = null;
    });
  }

  function switchRowPeek(pageId: string) {
    warmRowDetail(pageId);
    setPeekId(pageId);
    if (syncRowUrl) {
      writeUrlRowPeekId(pageId, "replace", {
        clearHash: true,
        peekMode: activeOpenPageIn === "center" ? "center" : "side",
      });
    }
  }

  useEffect(() => {
    if (!skipRemoteLoad) void loadDatabase(db.id, { rows: false, viewIds: metadataViewIdsRef.current });
  }, [db.id, loadDatabase, metadataViewIdsKey, skipRemoteLoad]);

  useEffect(() => {
    peekIdRef.current = peekId;
    if (peekId) warmRowDetail(peekId);
  }, [peekId, warmRowDetail]);

  useEffect(() => {
    if (peekId) {
      setRenderedPeekId(peekId);
      setRowPeekClosing(false);
      return;
    }
    if (renderedPeekId) setRowPeekClosing(true);
  }, [peekId, renderedPeekId]);

  useEffect(() => {
    if (!rowPeekClosing) return;
    const timeout = window.setTimeout(() => {
      setRenderedPeekId(null);
      setRowPeekClosing(false);
    }, ROW_PEEK_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [rowPeekClosing]);

  useEffect(() => {
    if (!syncUrl && !syncRowUrl) return;

    function restorePeekFocus() {
      window.requestAnimationFrame(() => {
        peekReturnRef.current?.focus();
        peekReturnRef.current = null;
      });
    }

    function syncViewFromUrl() {
      if (syncUrl) setActiveId(currentUrlViewId());
      if (!syncRowUrl) return;

      const nextPeekId = currentUrlRowPeekId();
      const ownership = rowPeekUrlOwnership(nextPeekId, db.id, storeRows, pagesById);
      if (ownership === "none") {
        if (peekIdRef.current) restorePeekFocus();
        setPeekId(null);
        return;
      }
      if (ownership === "belongs" || (syncUrl && ownership === "unknown")) {
        setPeekId(nextPeekId);
        return;
      }
      if (ownership === "foreign") {
        if (nextPeekId && containingRowPageId && nextPeekId === containingRowPageId) {
          if (peekIdRef.current) restorePeekFocus();
          setPeekId(null);
          return;
        }
        if (nextPeekId && peekIdRef.current) return;
        if (peekIdRef.current) restorePeekFocus();
        setPeekId(null);
      }
    }

    syncViewFromUrl();
    window.addEventListener("popstate", syncViewFromUrl);
    return () => window.removeEventListener("popstate", syncViewFromUrl);
  }, [containingRowPageId, db.id, pagesById, storeRows, syncRowUrl, syncUrl]);

  useEffect(() => {
    if (syncUrl) setActiveId(routedViewId);
  }, [routedViewId, syncUrl]);

  useEffect(() => {
    if (!addOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (scopedViewOwnerId) {
        addViewMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
        return;
      }
      newViewNameRef.current?.focus();
      newViewNameRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [addOpen, scopedViewOwnerId]);

  useEffect(() => {
    if (!viewMenuId) return;
    const frame = window.requestAnimationFrame(() => {
      const input = viewActionMenuRef.current?.querySelector<HTMLInputElement>("input");
      input?.focus();
      input?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [viewMenuId]);

  const readOnly = inheritedReadOnly || !!db.isLocked;
  const scopedToViewIds = !!visibleViewIds?.length;
  const canCreateScopedViews = !!scopedViewOwnerId && !!onScopedViewsChange;
  const visibleViews = useMemo(() => {
    let supported = views.filter(isRenderableDatabaseView);
    if (!visibleViewIds?.length) {
      supported = supported.filter(
        (view) => !isTemplateLinkedView(view) && !isInlineDatabaseScopedView(view)
      );
    }
    if (placement === "inline") {
      const ownedScoped = scopedViewOwnerId
        ? supported.filter((view) => inlineDatabaseScopedViewOwner(view) === scopedViewOwnerId)
        : [];
      const targetable = supported.filter((view) => {
        const owner = inlineDatabaseScopedViewOwner(view);
        if (!owner) return true;
        return owner !== scopedViewOwnerId ? false : !ownedScoped.some((owned) => owned.id === view.id);
      });
      const filtered = filterViewsByNotionLinkedDatabaseTargets(targetable, notionLinkedDatabaseTargetIds);
      if (ownedScoped.length > 0) {
        const seen = new Set(filtered.map((view) => view.id));
        supported = filtered.concat(ownedScoped.filter((view) => !seen.has(view.id)));
      } else {
        supported = filtered;
      }
      const withoutImportedUntitled = supported.filter((view) => !isImportedUntitledView(view));
      if (withoutImportedUntitled.length > 0) supported = withoutImportedUntitled;
      supported = orderImportedInlineViewsForNotionChrome(supported);
    }
    if (!visibleViewIds?.length) return supported;
    const allowed = new Set(visibleViewIds);
    const order = new Map(visibleViewIds.map((id, index) => [id, index]));
    const scoped = supported
      .filter((view) => allowed.has(view.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return scoped;
  }, [notionLinkedDatabaseTargetIds, placement, scopedViewOwnerId, views, visibleViewIds]);
  const viewChromeReadOnly = readOnly || (scopedToViewIds && !canCreateScopedViews);
  const canAddView = !readOnly && (!scopedToViewIds || canCreateScopedViews);
  const viewTabDragReadOnly = readOnly || (scopedToViewIds && !canCreateScopedViews);
  function canMutateViewTab(view: DbView) {
    if (readOnly) return false;
    if (scopedViewOwnerId) return inlineDatabaseScopedViewOwner(view) === scopedViewOwnerId;
    return !scopedToViewIds;
  }
  function canOpenViewActionMenu(_view: DbView) {
    if (readOnly) return false;
    if (scopedViewOwnerId) return true;
    return !scopedToViewIds;
  }
  function currentScopedViewIds() {
    const ids = visibleViewIds?.length ? visibleViewIds : visibleViews.map((view) => view.id);
    return ids.filter((id, index) => id && ids.indexOf(id) === index);
  }
  function openAddViewMenu(anchor: HTMLElement) {
    if (!canAddView) return;
    alignViewTabElementToCleanStart(anchor.closest("[data-view-add-wrap]"));
    closeViewActionMenu(false);
    closeViewOverflowMenu(false);
    setAddViewMenuStyle(placeViewTabMenu(anchor, scopedViewOwnerId ? 280 : 360));
    setAddOpen(true);
  }
  function renderAddViewMenuLayer() {
    if (!addOpen) return null;
    const layer = (
      <>
        <button
          type="button"
          className={styles.menuBackdrop}
          onClick={() => closeAddViewMenu(true)}
          tabIndex={-1}
          aria-label={databaseViewLabels().closeAddViewMenu}
        />
        <div
          ref={addViewMenuRef}
          className={`${styles.viewMenu} ${styles.addViewMenuPanel} ${
            scopedViewOwnerId ? styles.inlineAddViewMenuPanel : ""
          }`}
          style={addViewMenuStyle}
          role="dialog"
          aria-label={scopedViewOwnerId ? databaseViewLabels().addNewView : databaseViewLabels().addNewView}
          onKeyDown={onAddViewMenuKeyDown}
        >
          {scopedViewOwnerId ? (
            <div className={styles.inlineAddViewMenu}>
              <div className={styles.inlineAddViewTitle}>{databaseViewLabels().addNewView}</div>
              <div className={styles.inlineAddViewGrid} role="menu">
                {INLINE_SCOPED_VIEW_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={styles.inlineAddViewType}
                    role="menuitem"
                    onClick={() => void createNewView(type)}
                  >
                    <span className={styles.viewGlyph}>
                      <ViewTypeIcon type={type} />
                    </span>
                    <span>{databaseViewLabels().viewTypes[type]}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <form
              className={styles.addViewForm}
              onSubmit={(e) => {
                e.preventDefault();
                void createNewView();
              }}
            >
              <div className={styles.addViewTitle}>
                <span>{databaseViewLabels().addView}</span>
                <span>{databaseViewLabels().chooseViewAppearance}</span>
              </div>
              <div className={styles.addViewSectionLabel}>{databaseViewLabels().viewType}</div>
              <div
                className={styles.addViewTypeGrid}
                role="radiogroup"
                tabIndex={-1}
                aria-label={databaseViewLabels().viewType}
                onKeyDown={onSegmentedOptionGroupKeyDown}
              >
                {NOTION_2023_VIEW_TYPES.map((typeOption) => (
                  <button
                    type="button"
                    key={typeOption.type}
                    className={styles.addViewType}
                    data-add-view-type
                    data-segmented-option
                    data-active={newViewType === typeOption.type ? "true" : undefined}
                    role="radio"
                    aria-checked={newViewType === typeOption.type}
                    tabIndex={newViewType === typeOption.type ? 0 : -1}
                    onClick={() => setNewViewType(typeOption.type)}
                  >
                    <span className={styles.viewGlyph}>
                      <ViewTypeIcon type={typeOption.type} />
                    </span>
                    <span className={styles.addViewTypeText}>
                      <span>{databaseViewLabels().viewTypes[typeOption.type]}</span>
                      <span>{databaseViewLabels().viewTypeDescriptions[typeOption.type]}</span>
                    </span>
                    {newViewType === typeOption.type && (
                      <span className={styles.check}>
                        <CheckIcon size={14} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <label className={styles.addViewField}>
                <span>{databaseViewLabels().viewName}</span>
                <input
                  ref={newViewNameRef}
                  value={newViewName}
                  onChange={(e) => setNewViewName(e.target.value)}
                  placeholder={databaseViewLabels().viewTypes[newViewType]}
                />
              </label>
              <div className={styles.addViewActions}>
                <button type="button" onClick={() => closeAddViewMenu(true)}>
                  {databaseViewLabels().cancel}
                </button>
                <button type="submit" className={styles.addViewCreate}>
                  {databaseViewLabels().create}
                </button>
              </div>
            </form>
          )}
        </div>
      </>
    );
    return typeof document === "undefined" ? layer : createPortal(layer, document.body);
  }

  function renderViewTabMenuLayer(children: ReactNode) {
    return typeof document === "undefined" ? children : createPortal(children, document.body);
  }

  useEffect(() => {
    const root = dbRootRef.current;
    if (!root) return;
    function onOpenAddView(event: Event) {
      if (!canAddView) return;
      const anchor = (event as CustomEvent<{ anchor?: HTMLElement }>).detail?.anchor;
      if (!(anchor instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      openAddViewMenu(anchor);
    }
    root.addEventListener("hanji:open-inline-add-view", onOpenAddView);
    return () => root.removeEventListener("hanji:open-inline-add-view", onOpenAddView);
  });
  useEffect(() => {
    if (syncUrl || !initialViewId || activeId === initialViewId) return;
    if (!visibleViews.some((view) => view.id === initialViewId)) return;
    setActiveId(initialViewId);
  }, [activeId, initialViewId, syncUrl, visibleViews]);
  useEffect(() => {
    if (!loaded || readOnly || scopedToViewIds || visibleViews.length > 0) return;
    let cancelled = false;
    void addView(db.id, "table", databaseViewLabels().viewTypes.table)
      .then((view) => {
        if (cancelled) return;
        if (!view) {
          notify(databaseViewLabels().toast.couldntCreateDefaultTableView, "error");
          return;
        }
        setActiveId(view.id);
      })
      .catch(() => {
        if (!cancelled) notify(databaseViewLabels().toast.couldntCreateDefaultTableView, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [addView, db.id, loaded, notify, readOnly, scopedToViewIds, visibleViews.length]);
  const active = visibleViews.find((v) => v.id === activeId) ?? visibleViews[0];
  const hasImportedNotionInlineViews = placement === "inline" && visibleViews.some(isImportedNotionView);
  const hideSingleInlineViewTab = placement === "inline" && visibleViews.length === 1;
  const visibleViewTabs = useMemo(() => {
    if (hideSingleInlineViewTab) return [];
    if (!hasImportedNotionInlineViews) return visibleViews;
    return importedVisibleViewTabsForWidth(
      visibleViews,
      active?.id,
      viewTabsAvailableWidth,
      canAddView
    );
  }, [
    active?.id,
    canAddView,
    hasImportedNotionInlineViews,
    hideSingleInlineViewTab,
    viewTabsAvailableWidth,
    visibleViews,
  ]);
  const overflowViewTabs = useMemo(() => {
    if (hideSingleInlineViewTab) return [];
    const visibleIds = new Set(visibleViewTabs.map((view) => view.id));
    return visibleViews.filter((view) => !visibleIds.has(view.id));
  }, [hideSingleInlineViewTab, visibleViewTabs, visibleViews]);
  const activeTabIsRendered = !!active && visibleViewTabs.some((view) => view.id === active.id);
  const activeOpenPageIn = effectiveOpenPageIn(active);
  const activeSearch = active ? viewSearches[active.id] ?? "" : "";
  const activeViewId = active?.id;
  const activeInitialLoadLimit =
    active?.type === "table" ? tableInitialLoadLimit(active) : undefined;
  const activeSubitemParentScope = databaseViewSubitemParentScope(db, active);
  const activeRowsQuery = useMemo<DatabaseRowsQuery | undefined>(
    () =>
      activeViewId && active?.type !== "form"
        ? {
            viewId: activeViewId,
            search: activeSearch,
            currentPageId: contextPageId,
            limit: activeInitialLoadLimit,
            ...(activeSubitemParentScope !== undefined
              ? { subitemParentId: activeSubitemParentScope }
              : {}),
          }
        : undefined,
    [
      active?.type,
      activeViewId,
      activeInitialLoadLimit,
      activeSearch,
      activeSubitemParentScope,
      contextPageId,
    ]
  );
  const activeRowsViewSignature = active
    ? JSON.stringify({
        type: active.type,
        config: active.config ?? {},
      })
    : "";
  const activeRowsQueryKey = activeRowsQuery ? databaseRowsQueryKey(activeRowsQuery) : "";
  const activeRowPage = rowPage?.queryKey === activeRowsQueryKey ? rowPage : undefined;
  // A query-key transition means the next server page is still loading; it
  // does not invalidate rows we already have. Keep rendering that stale-while-
  // revalidating set through view-local filtering until the matching response
  // replaces it. Clearing the render here made slow/self-hosted boots flash an
  // empty database whenever metadata hydration and the network query briefly
  // disagreed about the active query key.
  const rows = storeRows;
  const rowsLoading = !skipRemoteLoad
    && !!active
    && active.type !== "form"
    && (!activeRowPage || activeRowPage.loading === true);
  const visibleRows = useMemo(
    () =>
      active && active.type !== "form"
        ? applyView(rows, props, active, pagesById, {
            search: activeSearch,
            currentPageId: contextPageId,
          })
        : [],
    [active, activeSearch, contextPageId, pagesById, props, rows]
  );
  const visibleRowIds = useMemo(() => visibleRows.map((row) => row.id), [visibleRows]);

  useEffect(() => {
    if (skipRemoteLoad || !activeRowsQuery) {
      activeRowsRequestControllerRef.current = null;
      return;
    }
    const controller = new AbortController();
    activeRowsRequestControllerRef.current = controller;
    return () => {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException(
          "The database row query was superseded.",
          "AbortError",
        ));
      }
      if (activeRowsRequestControllerRef.current === controller) {
        activeRowsRequestControllerRef.current = null;
      }
    };
  }, [
    activeRowsQuery,
    activeRowsQueryKey,
    activeRowsQuery?.limit,
    activeRowsViewSignature,
    db.id,
    skipRemoteLoad,
  ]);

  const roomPageId = contextPageId || db.id;

  useEffect(() => {
    function onLocalDatabaseMutation(event: Event) {
      const detail = (event as CustomEvent<LocalDatabaseMutationChange>).detail;
      if (!detail || detail.databaseId !== db.id) return;
      publishPageRoomMutation({
        ...detail,
        pageId: roomPageId,
      });
      if (detail.reason === "database_meta_changed" && detail.patch && detail.targetPageId) {
        publishPageRoomMutation({
          kind: "page_meta_changed",
          pageId: roomPageId,
          patch: detail.patch,
          reason: detail.reason,
          revision: detail.revision,
          targetPageId: detail.targetPageId,
          updatedAt: detail.updatedAt,
        });
      }
    }

    window.addEventListener(LOCAL_DATABASE_MUTATION_EVENT, onLocalDatabaseMutation);
    return () => window.removeEventListener(LOCAL_DATABASE_MUTATION_EVENT, onLocalDatabaseMutation);
  }, [db.id, roomPageId]);

  useEffect(() => {
    if (skipRemoteLoad) return;
    function onRoomMutation(event: Event) {
      const detail = (event as CustomEvent<PageRoomMutationReceived>).detail;
      if (!detail || detail.pageId !== roomPageId) return;
      const targetsThisDatabase = detail.databaseId === db.id || detail.targetPageId === db.id;
      if (!targetsThisDatabase) return;

      if (detail.kind === "page_meta_changed" && detail.targetPageId === db.id && detail.patch) {
        useStore.getState().applyRemotePagePatch(db.id, detail.patch);
      }

      if (detail.kind === "database_rows_changed") {
        if (active?.type === "form") return;
        if (activeRowsQuery) {
          void loadDatabaseRows(db.id, { ...activeRowsQuery, force: true, reset: true });
        } else {
          void loadDatabase(db.id, { force: true, rows: true, viewIds: metadataViewIds });
        }
        return;
      }

      if (
        detail.kind === "database_schema_changed" ||
        detail.kind === "database_views_changed" ||
        detail.kind === "database_templates_changed"
      ) {
        void loadDatabase(db.id, { force: true, rows: false, viewIds: metadataViewIds });
        if (activeRowsQuery) {
          void loadDatabaseRows(db.id, { ...activeRowsQuery, force: true, reset: true });
        }
      }
    }

    window.addEventListener(PAGE_ROOM_MUTATION_RECEIVED_EVENT, onRoomMutation);
    return () => window.removeEventListener(PAGE_ROOM_MUTATION_RECEIVED_EVENT, onRoomMutation);
  }, [
    active?.type,
    activeRowsQuery,
    db.id,
    loadDatabase,
    loadDatabaseRows,
    metadataViewIds,
    roomPageId,
    skipRemoteLoad,
  ]);

  useEffect(() => {
    if (skipRemoteLoad || !metadataLoaded || !activeRowsQuery) return;
    const timer = window.setTimeout(() => {
      const signal = activeRowsRequestControllerRef.current?.signal;
      if (!signal || signal.aborted) return;
      void loadDatabaseRows(db.id, { ...activeRowsQuery, reset: true, signal });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [
    activeRowsQuery,
    activeRowsViewSignature,
    db.id,
    loadDatabaseRows,
    metadataLoaded,
    rowPage?.queryKey,
    skipRemoteLoad,
  ]);

  useEffect(() => {
    if (!syncUrl || !activeId || !active || active.id === activeId) return;
    replaceUrlViewId(active.id);
  }, [active, activeId, syncUrl]);
  useLayoutEffect(() => {
    if (!active?.id) return;
    scrollViewTabIntoView(active.id, { preferStart: true });
  }, [active?.id]);
  useLayoutEffect(() => {
    const tablist = viewTabsRef.current;
    if (!tablist) return;

    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setViewTabsAvailableWidth(Math.round(tablist.clientWidth));
      });
    };

    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(tablist);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    active?.id,
    hasImportedNotionInlineViews,
    hideSingleInlineViewTab,
    visibleViews.length,
    viewChromeReadOnly,
  ]);

  function activateView(viewId: string | null, shouldSyncUrl = true) {
    setActiveId(viewId);
    if (syncUrl && shouldSyncUrl) replaceUrlViewId(viewId);
  }

  function selectView(viewId: string) {
    activateView(viewId);
    if (canCreateScopedViews) onScopedViewsChange?.(currentScopedViewIds(), viewId);
    scrollViewTabIntoView(viewId, { preferStart: true });
    setAddOpen(false);
    closeViewActionMenu(false);
    closeViewOverflowMenu(false);
  }

  function openViewActionMenu(view: DbView, trigger: HTMLElement) {
    if (!canOpenViewActionMenu(view)) return;
    alignViewTabElementToCleanStart(trigger.closest("[data-view-tab-wrap]"));
    activateView(view.id);
    if (canCreateScopedViews) onScopedViewsChange?.(currentScopedViewIds(), view.id);
    scrollViewTabIntoView(view.id, { preferStart: true });
    setAddOpen(false);
    setAddViewMenuStyle(undefined);
    closeViewOverflowMenu(false);
    viewActionReturnRef.current = trigger;
    setViewMenuId(view.id);
    setViewActionMenuStyle(placeViewTabMenu(trigger, 260));
    window.requestAnimationFrame(() => trigger.focus());
  }

  function openViewAsFullPage(view: DbView) {
    window.open(databaseViewLink(db.id, view.id), "_blank", "noopener,noreferrer");
    closeViewActionMenu(true);
  }

  function setActiveSearch(next: string) {
    if (!active) return;
    setViewSearches((current) => ({
      ...current,
      [active.id]: next,
    }));
  }

  async function copyViewLink(view: DbView) {
    const copied = await copyText(databaseViewLink(db.id, view.id));
    notify(
      copied ? databaseViewLabels().copiedViewLink : databaseViewLabels().copyViewLinkFailed,
      copied ? "success" : "error"
    );
    closeViewActionMenu(true);
  }

  function onViewTabKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, viewId: string) {
    if (isComposingKeyEvent(e)) return;
    const current = visibleViews.find((view) => view.id === viewId);
    if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && current && canOpenViewActionMenu(current)) {
      e.preventDefault();
      e.stopPropagation();
      openViewActionMenu(current, e.currentTarget);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const index = visibleViews.findIndex((view) => view.id === viewId);
    if (index < 0) return;

    e.preventDefault();
    e.stopPropagation();
    let nextIndex = index;
    if (e.key === "ArrowRight") {
      nextIndex = (index + 1) % visibleViews.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = index > 0 ? index - 1 : visibleViews.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = visibleViews.length - 1;
    }

    const next = visibleViews[nextIndex];
    if (!next) return;
    selectView(next.id);
    window.requestAnimationFrame(() => focusViewTab(next.id));
  }

  function onAddViewMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (handleViewMenuShellKey(e, addViewMenuRef.current, () => closeAddViewMenu(true))) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && (e.key === "Home" || e.key === "End")) return;

    const items = Array.from(
      addViewMenuRef.current?.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not(:disabled)',
      ) ?? [],
    ).filter((element) => element.offsetParent !== null);
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function viewActionMenuItems() {
    return Array.from(
      viewActionMenuRef.current?.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not(:disabled)',
      ) ?? [],
    ).filter((element) => element.offsetParent !== null);
  }

  function viewMenuFocusables(root: HTMLDivElement | null) {
    return Array.from(
      root?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.offsetParent !== null && element.tabIndex >= 0);
  }

  function handleViewMenuShellKey(
    e: ReactKeyboardEvent<HTMLDivElement>,
    root: HTMLDivElement | null,
    onClose: () => void
  ) {
    if (e.defaultPrevented) return true;
    if (isComposingKeyEvent(e)) return true;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return true;
    }
    if (e.key !== "Tab") return false;
    const focusables = viewMenuFocusables(root);
    if (focusables.length === 0) return false;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      e.stopPropagation();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
    return true;
  }

  function onViewActionMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (handleViewMenuShellKey(e, viewActionMenuRef.current, () => closeViewActionMenu(true))) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && (e.key === "Home" || e.key === "End")) return;

    const items = viewActionMenuItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function onViewOverflowMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (handleViewMenuShellKey(e, viewOverflowMenuRef.current, () => closeViewOverflowMenu(true))) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = viewMenuFocusables(viewOverflowMenuRef.current);
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function cloneViewConfig(config: DbView["config"]) {
    return config ? JSON.parse(JSON.stringify(config)) as DbView["config"] : {};
  }

  function copyViewName(view: DbView) {
    const sourceName = (view.name || databaseViewLabels().untitled).trim() || databaseViewLabels().untitled;
    const base = databaseViewLabels().copyName(sourceName);
    const names = new Set(views.map((item) => item.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base} ${i}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} ${views.length + 1}`;
  }

  async function duplicateView(view: DbView) {
    if (!canMutateViewTab(view) && !(scopedViewOwnerId && canCreateScopedViews)) return;
    // Insert the copy directly after its source instead of at the far right.
    const sourceIndex = views.findIndex((v) => v.id === view.id);
    const nextView = sourceIndex >= 0 ? views[sourceIndex + 1] : undefined;
    const copy = await addView(db.id, view.type, copyViewName(view), {
      config: scopedViewOwnerId
        ? cloneInlineScopedViewConfig(view.config, scopedViewOwnerId, view.id)
        : cloneViewConfig(view.config),
      position: positionBetween(view.position, nextView?.position),
    });
    if (!copy) {
      notify(databaseViewLabels().toast.couldntDuplicateView, "error");
      return;
    }
    if (canCreateScopedViews) {
      const nextIds = appendScopedViewId(currentScopedViewIds(), copy.id, view.id);
      onScopedViewsChange?.(nextIds, copy.id);
    }
    activateView(copy.id);
    setViewMenuId(null);
    notify(databaseViewLabels().toast.duplicatedView, "success");
    window.requestAnimationFrame(() => focusViewTab(copy.id));
  }

  async function createNewView(type = newViewType) {
    if (!canAddView) return;
    const typeLabel = databaseViewLabels().viewTypes[type] ?? databaseViewLabels().viewTypes.table;
    const currentIndex = active ? views.findIndex((view) => view.id === active.id) : -1;
    const nextView = currentIndex >= 0 ? views[currentIndex + 1] : undefined;
    const next = await addView(db.id, type, newViewName.trim() || typeLabel, {
      config: type === "form"
        ? {
            type: "form",
            hanjiForm: createDefaultFormViewConfig(props, { title: db.title }),
            hanjiFormAudience: "none",
          }
        : scopedViewOwnerId
          ? cloneInlineScopedViewConfig(active?.config, scopedViewOwnerId, active?.id)
          : undefined,
      position: active ? positionBetween(active.position, nextView?.position) : undefined,
    });
    if (!next) {
      notify(databaseViewLabels().toast.couldntCreateView, "error");
      return;
    }
    if (canCreateScopedViews) {
      const nextIds = appendScopedViewId(currentScopedViewIds(), next.id, active?.id);
      onScopedViewsChange?.(nextIds, next.id);
    }
    activateView(next.id);
    closeAddViewMenu(false);
    notify(databaseViewLabels().toast.createdView, "success");
    window.requestAnimationFrame(() => focusViewTab(next.id));
  }

  async function removeView(view: DbView) {
    if (visibleViews.length <= 1) return;
    const index = visibleViews.findIndex((item) => item.id === view.id);
    const next = visibleViews[index + 1] ?? visibleViews[index - 1] ?? null;
    if (scopedViewOwnerId && !canMutateViewTab(view)) {
      const nextIds = currentScopedViewIds().filter((id) => id !== view.id);
      onScopedViewsChange?.(nextIds, next?.id ?? null);
      activateView(next?.id ?? null);
      setViewMenuId(null);
      notify(databaseViewLabels().toast.removedViewFromInline, "success");
      return;
    }
    if (!canMutateViewTab(view)) return;
    const snapshot = await deleteView(view.id);
    if (!snapshot) {
      notify(databaseViewLabels().toast.couldntDeleteView, "error");
      return;
    }
    const nextScopedIds = canCreateScopedViews
      ? currentScopedViewIds().filter((id) => id !== view.id)
      : undefined;
    if (nextScopedIds) onScopedViewsChange?.(nextScopedIds, next?.id ?? null);
    activateView(next?.id ?? null);
    setViewMenuId(null);
    notify(databaseViewLabels().toast.deletedView, "success", {
      label: databaseViewLabels().undo,
      onClick: async () => {
        const restored = await restoreDeletedView(snapshot);
        if (!restored) {
          notify(databaseViewLabels().toast.couldntRestoreView, "error");
          return;
        }
        if (canCreateScopedViews) {
          const restoredIds = appendScopedViewId(nextScopedIds ?? currentScopedViewIds(), snapshot.id, next?.id);
          onScopedViewsChange?.(restoredIds, snapshot.id);
        }
        activateView(snapshot.id);
        notify(databaseViewLabels().toast.restoredView, "success");
        window.requestAnimationFrame(() => focusViewTab(snapshot.id));
      },
    });
    window.requestAnimationFrame(() => {
      if (next) focusViewTab(next.id);
      else addViewButtonRef.current?.focus();
    });
  }

  useEffect(() => {
    const root = dbRootRef.current;
    if (!root) return;
    function onInlineDatabaseCommand(event: Event) {
      const command = (event as CustomEvent<{ command?: string }>).detail?.command;
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "copy-active-view-link") {
        if (!active) {
          notify(databaseViewLabels().noViewToCopy, "default");
          return;
        }
        void copyViewLink(active);
        return;
      }
      if (command === "duplicate-active-view") {
        if (!active) {
          notify(databaseViewLabels().noViewToDuplicate, "default");
          return;
        }
        void duplicateView(active);
        return;
      }
      if (command === "ensure-calendar-view") {
        const calendarView = visibleViews.find((view) => view.type === "calendar");
        if (calendarView) {
          selectView(calendarView.id);
          window.requestAnimationFrame(() => focusViewTab(calendarView.id));
          return;
        }
        if (!canAddView) {
          notify(databaseViewLabels().cannotAddCalendarView, "default");
          return;
        }
        void createNewView("calendar");
      }
    }
    root.addEventListener(INLINE_DATABASE_COMMAND_EVENT, onInlineDatabaseCommand);
    return () => root.removeEventListener(INLINE_DATABASE_COMMAND_EVENT, onInlineDatabaseCommand);
  });

  function beginViewTabDrag(viewId: string, e: ReactDragEvent<HTMLElement>) {
    if (viewTabDragReadOnly) {
      e.preventDefault();
      return;
    }
    setDraggingViewId(viewId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(VIEW_TAB_DRAG, viewId);
  }

  function updateViewTabDragTarget(viewId: string, e: ReactDragEvent<HTMLElement>) {
    if (viewTabDragReadOnly) return;
    if (!draggingViewId && !Array.from(e.dataTransfer.types).includes(VIEW_TAB_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    setDragOverViewSide(e.clientX > rect.left + rect.width / 2 ? "after" : "before");
    setDragOverViewId(viewId);
  }

  function clearViewTabDragState() {
    setDraggingViewId(null);
    setDragOverViewId(null);
    setDragOverViewSide("before");
  }

  function reorderView(sourceId: string, targetId: string, side: "before" | "after") {
    if (!sourceId || sourceId === targetId) return;
    const next = visibleViews.slice();
    const sourceIndex = next.findIndex((view) => view.id === sourceId);
    const targetIndex = next.findIndex((view) => view.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = next.splice(sourceIndex, 1);
    const insertionIndex = next.findIndex((view) => view.id === targetId);
    next.splice(insertionIndex + (side === "after" ? 1 : 0), 0, source);
    if (canCreateScopedViews) {
      onScopedViewsChange?.(next.map((view) => view.id), active?.id ?? sourceId);
      clearViewTabDragState();
      return;
    }
    const editedAt = new Date().toISOString();
    next.forEach((view, index) => {
      updateView(view.id, {
        config: {
          ...(view.config ?? {}),
          viewTabOrderEditedAt: editedAt,
        },
        position: index + 1,
      });
    });
    clearViewTabDragState();
  }

  function onDatabaseKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(`.${styles.rowPeek}`)) return;
    e.preventDefault();
    e.stopPropagation();
    setViewMenuId(null);
    setAddOpen(false);
    setSearchFocusTick((tick) => tick + 1);
  }

  if (!metadataLoaded) return <DatabaseLoadingShell placement={placement} />;

  const activePeekId = peekId ?? renderedPeekId;
  const activePeekClosing = !peekId && !!renderedPeekId && rowPeekClosing;

  return (
    <div
      ref={dbRootRef}
      className={styles.db}
      data-placement={placement}
      data-public-read-only={publicReadOnly ? "true" : undefined}
      data-imported-notion-inline={
        hasImportedNotionInlineViews ? "true" : undefined
      }
      onKeyDown={onDatabaseKeyDown}
    >
      <div className={styles.dbChrome} data-database-chrome>
        <div
          className={styles.viewTabs}
          data-view-tabs-hidden={hideSingleInlineViewTab ? "true" : undefined}
          ref={viewTabsRef}
          role={hideSingleInlineViewTab ? undefined : "tablist"}
          aria-hidden={hideSingleInlineViewTab ? "true" : undefined}
          aria-label={hideSingleInlineViewTab ? undefined : databaseViewLabels().viewsFor(databaseDisplayTitle(db))}
          aria-orientation={hideSingleInlineViewTab ? undefined : "horizontal"}
        >
          {visibleViewTabs.map((v) => (
            <div
              key={v.id}
              className={styles.viewTabWrap}
              data-view-tab-wrap={v.id}
              data-active={active?.id === v.id ? "true" : undefined}
              data-drag-over={dragOverViewId === v.id ? "true" : undefined}
              data-drop-side={dragOverViewId === v.id ? dragOverViewSide : undefined}
              draggable={!viewTabDragReadOnly}
              onDragStart={(e) => beginViewTabDrag(v.id, e)}
              onDragOver={(e) => updateViewTabDragTarget(v.id, e)}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDragOverViewId((cur) => (cur === v.id ? null : cur));
              }}
              onDrop={(e) => {
                if (viewTabDragReadOnly) return;
                e.preventDefault();
                reorderView(e.dataTransfer.getData(VIEW_TAB_DRAG) || draggingViewId || "", v.id, dragOverViewSide);
              }}
              onDragEnd={clearViewTabDragState}
            >
              <button
                className={`${styles.viewTab} ${active?.id === v.id ? styles.viewTabActive : ""}`}
                data-view-tab={v.id}
                type="button"
                draggable={!viewTabDragReadOnly}
                id={viewTabId(v.id)}
                role="tab"
                aria-label={v.name}
                aria-selected={active?.id === v.id}
                aria-controls={viewPanelId(v.id)}
                aria-haspopup={canOpenViewActionMenu(v) ? "dialog" : undefined}
                aria-expanded={viewMenuId === v.id ? true : undefined}
                tabIndex={active?.id === v.id ? 0 : -1}
                onClick={(e) => {
                  if (active?.id === v.id && canOpenViewActionMenu(v)) {
                    openViewActionMenu(v, e.currentTarget);
                    return;
                  }
                  selectView(v.id);
                }}
                onContextMenu={(e) => {
                  if (!canOpenViewActionMenu(v)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  openViewActionMenu(v, e.currentTarget);
                }}
                onDragStart={(e) => beginViewTabDrag(v.id, e)}
                onKeyDown={(e) => onViewTabKeyDown(e, v.id)}
              >
                <span className={styles.viewGlyph}>
                  <ViewTypeIcon type={v.type} />
                </span>
                <span className={styles.viewTabName} data-view-tab-name={v.id}>
                  {v.name}
                </span>
              </button>
              <button
                type="button"
                className={styles.viewTabMore}
                data-view-actions={v.id}
                aria-label={databaseViewLabels().viewActionsFor(v.name)}
                aria-haspopup="dialog"
                aria-expanded={viewMenuId === v.id}
                tabIndex={active?.id === v.id || viewMenuId === v.id ? 0 : -1}
                disabled={!canOpenViewActionMenu(v)}
                onClick={(e) => {
                  if (!canOpenViewActionMenu(v)) return;
                  if (viewMenuId === v.id) {
                    closeViewActionMenu(true);
                    return;
                  }
                  openViewActionMenu(v, e.currentTarget);
                }}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {viewMenuId === v.id &&
                renderViewTabMenuLayer(
                  <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeViewActionMenu(true)}
                    tabIndex={-1}
                    aria-label={databaseViewLabels().closeViewActions}
                  />
                  <div
                    ref={viewActionMenuRef}
                    className={styles.viewTabMenu}
                    style={viewActionMenuStyle}
                    role="dialog"
                    aria-label={databaseViewLabels().viewActionsFor(v.name)}
                    onKeyDown={onViewActionMenuKeyDown}
                  >
                    <ViewNameField
                      name={v.name}
                      onCommit={(name) => {
                        updateView(v.id, { name });
                        notify(databaseViewLabels().renamedView, "success");
                      }}
                      onClose={() => closeViewActionMenu(true)}
                    />
                    <button type="button" className={styles.viewMenuItem} onClick={() => openViewAsFullPage(v)}>
                      <OpenInNew size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().openAsFullPage}</span>
                    </button>
                    <button type="button" className={styles.viewMenuItem} onClick={() => void copyViewLink(v)}>
                      <LinkIcon size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().copyViewLink}</span>
                    </button>
                    <button type="button" className={styles.viewMenuItem} onClick={() => void duplicateView(v)}>
                      <Copy size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().duplicateView}</span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.viewMenuItem} ${styles.viewMenuDanger}`}
                      disabled={visibleViews.length <= 1}
                      onClick={() => void removeView(v)}
                    >
                      <Trash size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().deleteView}</span>
                    </button>
                  </div>
                  </>
                )}
            </div>
          ))}
          {overflowViewTabs.length > 0 && (
            <div className={`${styles.viewTabWrap} ${styles.viewOverflowWrap}`} data-view-overflow-wrap>
              <button
                type="button"
                className={`${styles.viewTab} ${styles.viewOverflowButton}`}
                ref={viewOverflowButtonRef}
                data-view-overflow
                aria-haspopup="menu"
                aria-expanded={viewOverflowOpen}
                onClick={(e) => {
                  if (viewOverflowOpen) {
                    closeViewOverflowMenu(true);
                    return;
                  }
                  setAddOpen(false);
                  setAddViewMenuStyle(undefined);
                  setViewMenuId(null);
                  setViewActionMenuStyle(undefined);
                  setViewOverflowMenuStyle(placeViewTabMenu(e.currentTarget, 220));
                  setViewOverflowOpen(true);
                }}
              >
                {databaseViewLabels().moreViews(overflowViewTabs.length)}
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {viewOverflowOpen &&
                renderViewTabMenuLayer(
                  <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeViewOverflowMenu(true)}
                    tabIndex={-1}
                    aria-label={databaseViewLabels().closeHiddenViews}
                  />
                  <div
                    ref={viewOverflowMenuRef}
                    className={styles.viewTabMenu}
                    style={viewOverflowMenuStyle}
                    role="menu"
                    tabIndex={-1}
                    aria-label={databaseViewLabels().hiddenViews}
                    onKeyDown={onViewOverflowMenuKeyDown}
                  >
                    {overflowViewTabs.map((view) => (
                      <button
                        key={view.id}
                        type="button"
                        className={styles.viewMenuItem}
                        role="menuitemradio"
                        aria-checked={active?.id === view.id}
                        onClick={() => {
                          selectView(view.id);
                          window.requestAnimationFrame(() => focusViewTab(view.id));
                        }}
                      >
                        <ViewTypeIcon type={view.type} size={15} />
                        <span>{view.name}</span>
                        {active?.id === view.id && <CheckIcon size={13} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                  </>
                )}
            </div>
          )}
          {canAddView && (
            <div className={styles.addViewWrap} data-view-add-wrap>
              <button
                type="button"
                className={styles.addView}
                ref={addViewButtonRef}
                aria-label={
                  scopedViewOwnerId
                    ? databaseViewLabels().addNewView
                    : visibleViews.length === 0
                      ? databaseViewLabels().addAView
                      : databaseViewLabels().addView
                }
                aria-haspopup="dialog"
                aria-expanded={addOpen}
                disabled={!canAddView}
                onClick={(e) => {
                  if (!canAddView) return;
                  if (addOpen) {
                    closeAddViewMenu(true);
                    return;
                  }
                  openAddViewMenu(e.currentTarget);
                }}
              >
                <Plus size={15} aria-hidden="true" />
                {visibleViews.length === 0 ? databaseViewLabels().addAView : ""}
              </button>
              {renderAddViewMenuLayer()}
            </div>
          )}
        </div>

        <div
          id={tableSelectionChromeSlotId}
          className={styles.tableSelectionChromeSlot}
          data-table-selection-chrome-slot
          aria-live="polite"
        />
        {active && active.type !== "form" && (
          <DatabaseToolbar
            key={active.id}
            dbId={db.id}
            view={active}
            compactImportedInline={placement === "inline"}
            readOnly={readOnly}
            search={activeSearch}
            searchFocusTick={searchFocusTick}
            contextPageId={contextPageId}
            onSearchChange={setActiveSearch}
            onOpenRow={openRowPeek}
          />
        )}
      </div>

      <div
        className={styles.viewBody}
        id={active ? viewPanelId(active.id) : undefined}
        role="tabpanel"
        aria-labelledby={activeTabIsRendered ? viewTabId(active.id) : undefined}
      >
        {!active && <div className={styles.dbLoading} />}
        {active?.type === "table" && (
          <TableView
            db={db}
            view={active}
            rows={visibleRows}
            rowsViewApplied
            rowQuery={activeRowsQuery}
            readOnly={readOnly}
            search={activeSearch}
            loadingRows={!metadataLoaded || rowsLoading}
            placement={placement}
            contextPageId={contextPageId}
            selectionChromeSlotId={tableSelectionChromeSlotId}
            publishAwareness={publishAwareness}
            remoteAwarenessByBlock={remoteAwarenessByBlock}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
            onWarmRow={warmRowDetail}
          />
        )}
        {isBoundedCardView(active) && activeRowsQuery && (
          <BoundedCardView
            key={`${active.id}:${activeRowsViewSignature}:${activeSearch}:${contextPageId ?? ""}`}
            db={db}
            view={active}
            rows={visibleRows}
            rowPage={activeRowPage}
            rowQuery={activeRowsQuery}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            loadMoreDatabaseRows={loadMoreDatabaseRows}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "calendar" && (
          <CalendarView
            db={db}
            view={active}
            rows={visibleRows}
            rowsViewApplied
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "timeline" && (
          <TimelineView
            db={db}
            view={active}
            rows={visibleRows}
            rowsViewApplied
            rowQuery={activeRowsQuery}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "chart" && (
          <ChartView
            db={db}
            view={active}
            rows={visibleRows}
            rowsViewApplied
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
          />
        )}
        {active?.type === "form" && (
          <FormView db={db} view={active} readOnly={readOnly} />
        )}
        {/* Genuinely unsupported (unknown) view types keep the imported
            placeholder instead of rendering nothing. */}
        {active && !isRenderableDatabaseView(active) && <ImportedUnsupportedView view={active} />}
        {active &&
          active.type !== "table" &&
          !isBoundedCardView(active) &&
          activeRowsQuery &&
          activeRowPage?.hasMore && (
            <button
              type="button"
              className={styles.viewLoadMore}
              data-view-load-more
              disabled={activeRowPage.loadingMore}
              onClick={() => void loadMoreDatabaseRows(db.id, activeRowsQuery)}
            >
              <ArrowDown size={14} aria-hidden="true" />
              {activeRowPage.loadingMore ? databaseViewLabels().loadingMore : databaseViewLabels().loadMore}
            </button>
          )}
      </div>
      {activePeekId && (
        <RowPeek
          dbId={db.id}
          pageId={activePeekId}
          view={active}
          mode={activeOpenPageIn === "center" ? "center" : "side"}
          openPropertiesTick={
            rowPropertiesMenuRequest?.pageId === activePeekId ? rowPropertiesMenuRequest.tick : 0
          }
          rowIds={visibleRowIds}
          closing={activePeekClosing}
          readOnly={readOnly}
          publicReadOnly={publicReadOnly}
          sharedToken={sharedToken}
          onClose={closeRowPeek}
          onOpenPage={(targetPageId) =>
            router.push(
              publicReadOnly && sharedToken ? sharedPageHref(sharedToken, targetPageId) : pageHref(targetPageId)
            )
          }
          onSwitchRow={switchRowPeek}
        />
      )}
    </div>
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return !!target.closest('[contenteditable="true"], [role="textbox"]');
}

function rowPeekBlockSearchText(block: {
  plainText?: string;
  content?: {
    rich?: TextSpan[];
    caption?: TextSpan[];
    expression?: string;
    fileName?: string;
    table?: string[][];
  };
}) {
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

const EMPTY_ROW_PEEK_BLOCKS: Block[] = [];
const ROW_PEEK_WIDTH_KEY = "hanji:row-peek-side-width:v2";
const ROW_PEEK_FALLBACK_WIDTH = 640;
const ROW_PEEK_MIN_WIDTH = 420;
const ROW_PEEK_VIEWPORT_GAP = 80;
const ROW_PEEK_DEFAULT_VIEWPORT_RATIO = 0.5;
const ROW_PEEK_EXIT_MS = 220;
const ROW_PEEK_TOGGLE_BLOCK_TYPES = new Set<BlockType>([
  "toggle",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
]);

function rowPeekMaxWidth() {
  if (typeof window === "undefined") return ROW_PEEK_FALLBACK_WIDTH;
  return Math.max(ROW_PEEK_MIN_WIDTH, window.innerWidth - ROW_PEEK_VIEWPORT_GAP);
}

function clampRowPeekWidth(width: number) {
  return Math.min(Math.max(Math.round(width), ROW_PEEK_MIN_WIDTH), rowPeekMaxWidth());
}

function rowPeekDefaultWidth() {
  if (typeof window === "undefined") return ROW_PEEK_FALLBACK_WIDTH;
  return clampRowPeekWidth(window.innerWidth * ROW_PEEK_DEFAULT_VIEWPORT_RATIO);
}

function storedRowPeekWidth() {
  const fallback = rowPeekDefaultWidth();
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(ROW_PEEK_WIDTH_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) ? clampRowPeekWidth(parsed) : fallback;
}

function RowPeek({
  dbId,
  pageId,
  view,
  mode,
  openPropertiesTick = 0,
  rowIds,
  closing = false,
  readOnly: inheritedReadOnly = false,
  publicReadOnly = false,
  sharedToken,
  onClose,
  onOpenPage,
  onSwitchRow,
}: {
  dbId: string;
  pageId: string;
  view?: DbView | null;
  mode: "side" | "center";
  openPropertiesTick?: number;
  rowIds: string[];
  closing?: boolean;
  readOnly?: boolean;
  publicReadOnly?: boolean;
  sharedToken?: string;
  onClose: () => void;
  onOpenPage: (pageId: string) => void;
  onSwitchRow: (pageId: string) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const findRootRef = useRef<HTMLDivElement>(null);
  const page = useStore((s) => s.pagesById[pageId]);
  const dbPage = useStore((s) => s.pagesById[dbId]);
  const blocks = useStore((s) => s.blocksByPage[pageId] ?? EMPTY_ROW_PEEK_BLOCKS);
  const ready = useStore((s) => s.ready);
  const loadBlocks = useStore((s) => s.loadBlocks);
  const loadComments = useStore((s) => s.loadComments);
  const openComments = useStore((s) => s.openComments);
  const updatePage = useStore((s) => s.updatePage);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const notify = useStore((s) => s.notify);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const dbPageRef = useRef(dbPage);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sideWidthRef = useRef(rowPeekDefaultWidth());
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusTick, setFindFocusTick] = useState(0);
  const [findInitialQuery, setFindInitialQuery] = useState("");
  const [sideWidth, setSideWidth] = useState(storedRowPeekWidth);
  const [resizingSide, setResizingSide] = useState(false);
  const [entered, setEntered] = useState(false);
  const commentCount = useStore(
    (s) => s.commentsByPage[pageId]?.filter((comment) => !comment.parentId && !comment.resolved).length ?? 0
  );
  const findRevision = useMemo(
    () => [page?.title ?? "", ...blocks.map((block) => `${block.id}:${rowPeekBlockSearchText(block)}`)].join("\u0000"),
    [blocks, page?.title],
  );
  const rowIndex = rowIds.indexOf(pageId);
  const previousRowId = rowIndex > 0 ? rowIds[rowIndex - 1] : null;
  const nextRowId = rowIndex >= 0 && rowIndex < rowIds.length - 1 ? rowIds[rowIndex + 1] : null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!ready) return;
    void loadBlocks(pageId).catch(() => {});
    void loadComments(pageId).catch(() => {});
  }, [ready, pageId, loadBlocks, loadComments]);

  useEffect(() => {
    dbPageRef.current = dbPage;
  }, [dbPage]);

  useEffect(() => {
    if (!page) return;
    setDocumentChrome({
      title: `${pageDisplayTitle(page)} - Hanji`,
      iconHref: pageFaviconHref(page),
    });
  }, [page]);

  useEffect(() => {
    return () => {
      const parentPage = dbPageRef.current;
      setDocumentChrome({
        title: parentPage ? `${pageDisplayTitle(parentPage)} - Hanji` : "Hanji",
        iconHref: pageFaviconHref(parentPage),
      });
    };
  }, []);

  // Lock background scroll while the peek overlay is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
      setMenuAnchor(null);
      setFindOpen(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pageId]);

  useEffect(() => {
    sideWidthRef.current = sideWidth;
  }, [sideWidth]);

  useEffect(() => {
    const onResize = () => {
      const next = clampRowPeekWidth(sideWidthRef.current);
      sideWidthRef.current = next;
      setSideWidth(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!resizingSide) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (event: PointerEvent) => {
      if (!resizeStartRef.current) return;
      const next = clampRowPeekWidth(
        resizeStartRef.current.startWidth + resizeStartRef.current.startX - event.clientX
      );
      sideWidthRef.current = next;
      setSideWidth(next);
    };
    const endResize = () => {
      setResizingSide(false);
      resizeStartRef.current = null;
      window.localStorage.setItem(ROW_PEEK_WIDTH_KEY, String(sideWidthRef.current));
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize, { once: true });
    window.addEventListener("pointercancel", endResize, { once: true });
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
    };
  }, [resizingSide]);

  // Modal semantics: the peek is aria-modal, so Escape must close it even
  // when focus sits OUTSIDE the panel (a click on the page behind can leave
  // focus on the body, where the panel's own onKeyDown never fires — and the
  // open side panel then intercepts topbar clicks with no keyboard way out).
  // Events originating inside the panel stay owned by onPanelKeyDown, which
  // preventDefault()s what it handles.
  useEffect(() => {
    if (closing) return;
    const onDocumentEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (panelRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onDocumentEscape);
    return () => document.removeEventListener("keydown", onDocumentEscape);
  }, [closing, onClose]);

  useEffect(() => {
    let clearTimer: number | undefined;
    let frame: number | undefined;

    function scrollToHashBlock() {
      let hashId = "";
      try {
        hashId = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        hashId = window.location.hash.slice(1);
      }
      if (!hashId.startsWith(HASH_BLOCK_PREFIX)) return;

      const blockId = hashId.slice(HASH_BLOCK_PREFIX.length);
      const st = useStore.getState();
      const pageBlocks = st.blocksByPage[pageId] ?? [];
      const byId = new Map(pageBlocks.map((candidate) => [candidate.id, candidate]));
      if (!byId.has(blockId)) return;

      let current = byId.get(blockId);
      while (current?.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent) break;
        if (ROW_PEEK_TOGGLE_BLOCK_TYPES.has(parent.type) && parent.content?.collapsed) {
          st.updateBlock(
            parent.id,
            { content: { ...parent.content, collapsed: false } },
            { history: false }
          );
        }
        current = parent;
      }

      function scrollWhenRendered(attempt = 0) {
        const target = document.getElementById(hashId);
        if (!target) {
          if (attempt < 30) frame = window.requestAnimationFrame(() => scrollWhenRendered(attempt + 1));
          return;
        }
        document
          .querySelectorAll(".blockLinkTarget")
          .forEach((el) => el.classList.remove("blockLinkTarget"));
        target.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
        target.classList.add("blockLinkTarget");
        if (clearTimer) window.clearTimeout(clearTimer);
        clearTimer = window.setTimeout(() => {
          target.classList.remove("blockLinkTarget");
        }, 1800);
      }

      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => scrollWhenRendered());
    }

    scrollToHashBlock();
    window.addEventListener("hashchange", scrollToHashBlock);
    return () => {
      window.removeEventListener("hashchange", scrollToHashBlock);
      if (frame) window.cancelAnimationFrame(frame);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [blocks.length, pageId]);

  function focusableItems() {
    return Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => element.offsetParent !== null);
  }

  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      setMenuAnchor(null);
      setFindInitialQuery(selectedTextForPageFind(findRootRef.current));
      setFindOpen(true);
      setFindFocusTick((tick) => tick + 1);
      return;
    }
    if (
      (!publicReadOnly || sharedToken) &&
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key === "Enter" &&
      !isEditableTarget(e.target)
    ) {
      e.preventDefault();
      e.stopPropagation();
      onOpenPage(pageId);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (menuAnchor) {
        setMenuAnchor(null);
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
        return;
      }
      onClose();
      return;
    }
    if (!isEditableTarget(e.target)) {
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        switchRow(previousRowId);
        return;
      }
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        switchRow(nextRowId);
        return;
      }
    }
    if (e.key !== "Tab") return;

    const items = focusableItems();
    if (items.length === 0) {
      e.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!page) return null;
  const rowLocked = !!page.isLocked;
  const readOnly = inheritedReadOnly || rowLocked;
  const rowTitle = pageDisplayTitle(page);
  const canOpenRowPage = !publicReadOnly || !!sharedToken;
  const openAsPageShortcut =
    typeof navigator !== "undefined" && navigator.platform.includes("Mac")
      ? "⌘Enter"
      : "Ctrl+Enter";

  async function copyRowLink() {
    const ok = await copyText(
      publicReadOnly && sharedToken ? absoluteSharedPageUrl(sharedToken, pageId) : absolutePageUrl(pageId)
    );
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1200);
    notify(
      ok ? databaseViewLabels().linkCopiedToast : databaseViewLabels().copyLinkFailed,
      ok ? "success" : "error"
    );
  }

  async function toggleRowFavorite() {
    const wasFavorite = !!page.isFavorite;
    try {
      await toggleFavorite(pageId);
      notify(
        wasFavorite ? databaseViewLabels().removedFromFavorites : databaseViewLabels().addedToFavorites,
        "success"
      );
    } catch {
      notify(databaseViewLabels().updateFavoritesFailed, "error");
    }
  }

  function unlockRow() {
    updatePage(page.id, { isLocked: false });
    notify(databaseViewLabels().toast.pageUnlocked, "success");
  }

  function switchRow(nextPageId: string | null) {
    if (!nextPageId || nextPageId === pageId) return;
    setMenuAnchor(null);
    setCopied(false);
    onSwitchRow(nextPageId);
  }

  function commitSideWidth(next: number) {
    const width = clampRowPeekWidth(next);
    sideWidthRef.current = width;
    setSideWidth(width);
    window.localStorage.setItem(ROW_PEEK_WIDTH_KEY, String(width));
  }

  function startSideResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (mode !== "side" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeStartRef.current = { startX: e.clientX, startWidth: sideWidthRef.current };
    setResizingSide(true);
  }

  function onResizeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (mode !== "side") return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 80 : 24;
    if (e.key === "ArrowLeft") commitSideWidth(sideWidthRef.current + step);
    else if (e.key === "ArrowRight") commitSideWidth(sideWidthRef.current - step);
    else if (e.key === "Home") commitSideWidth(ROW_PEEK_MIN_WIDTH);
    else if (e.key === "End") commitSideWidth(rowPeekMaxWidth());
  }

  function onRowPeekBlankPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && !target.closest("[data-editor-tail]")) return;
    // The scroll viewport is portaled from inside a host editor. Its blank
    // surface owns the press and must not seed that editor's rubber band.
    e.stopPropagation();
  }

  function onRowPeekBlankMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget) {
      if (target.closest("[data-editor-tail]")) e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (readOnly || e.button !== 0) return;
    const tail = findRootRef.current?.querySelector<HTMLElement>("[data-editor-tail]");
    if (!tail) return;
    e.preventDefault();
    // Reuse Editor's canonical zero-or-one page-end mutation/focus authority.
    // Forwarding to its real tail avoids a second row-page creation path.
    tail.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: e.clientX,
      clientY: e.clientY,
    }));
  }

  const rowPeekStyle =
    mode === "side"
      ? ({ "--row-peek-width": `${sideWidth}px` } as CSSProperties)
      : undefined;
  const motionState = closing ? "closing" : entered ? "open" : "opening";

  const peek = (
    <>
      <button
        type="button"
        className={styles.rowPeekBackdrop}
        data-mode={mode}
        data-row-peek-backdrop
        data-motion-state={motionState}
        onClick={onClose}
        disabled={closing}
        tabIndex={-1}
        aria-label={databaseViewLabels().closeRowPreview}
      />
      <aside
        ref={panelRef}
        className={styles.rowPeek}
        data-mode={mode}
        data-row-peek-panel
        data-motion-state={motionState}
        data-resizing={resizingSide ? "true" : undefined}
        style={rowPeekStyle}
        role="dialog"
        aria-modal="true"
        aria-label={databaseViewLabels().rowPreviewFor(rowTitle)}
        aria-hidden={closing ? true : undefined}
        inert={closing ? true : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        {mode === "side" && (
          <div
            className={styles.rowPeekResizeHandle}
            role="separator"
            tabIndex={0}
            title={databaseViewLabels().resizeSidePreview}
            aria-label={databaseViewLabels().resizeSidePreview}
            aria-orientation="vertical"
            aria-valuemin={ROW_PEEK_MIN_WIDTH}
            aria-valuemax={rowPeekMaxWidth()}
            aria-valuenow={sideWidth}
            onPointerDown={startSideResize}
            onKeyDown={onResizeKeyDown}
          />
        )}
        <PageFindBar
          focusTick={findFocusTick}
          initialQuery={findInitialQuery}
          onClose={() => setFindOpen(false)}
          open={findOpen}
          pageId={pageId}
          revision={findRevision}
          rootRef={findRootRef}
        />
        <div className={styles.rowPeekTop}>
          <div
            className={styles.rowPeekChromeSide}
            data-row-peek-chrome-side
            aria-label={databaseViewLabels().peekOptions(rowTitle)}
          >
            <button
              type="button"
              className={styles.rowPeekIconAction}
              data-row-peek-close="side-rail"
              title={databaseViewLabels().closePeek(rowTitle)}
              aria-label={databaseViewLabels().closePeek(rowTitle)}
              onClick={onClose}
            >
              <DoubleChevronRight size={16} aria-hidden="true" />
            </button>
            {canOpenRowPage && (
              <button
                type="button"
                className={styles.rowPeekIconAction}
                data-row-peek-open-page
                data-row-peek-open-page-glyph="arrow-square-out"
                title={`${databaseViewLabels().openAsPage(rowTitle)} (${openAsPageShortcut})`}
                aria-label={databaseViewLabels().openAsPage(rowTitle)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    if (publicReadOnly && sharedToken) openSharedPageInNewTab(sharedToken, pageId);
                    else openPageInNewTab(pageId);
                    return;
                  }
                  onOpenPage(pageId);
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  if (publicReadOnly && sharedToken) openSharedPageInNewTab(sharedToken, pageId);
                  else openPageInNewTab(pageId);
                }}
              >
                <OpenAsPage size={15} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={styles.rowPeekActions} data-row-peek-actions>
            {rowLocked && !inheritedReadOnly && (
              <button
                type="button"
                className={`${styles.rowPeekLockPill} ${styles.rowPeekShareAction}`}
                title={databaseViewLabels().unlock(rowTitle)}
                aria-label={databaseViewLabels().unlock(rowTitle)}
                onClick={unlockRow}
              >
                <LockIcon size={14} aria-hidden="true" />
                <span>{databaseViewLabels().locked}</span>
              </button>
            )}
            {canOpenRowPage && (
              <>
                {!publicReadOnly && (
                  <button
                    type="button"
                    className={styles.rowPeekIconAction}
                    title={
                      commentCount
                        ? databaseViewLabels().openComments(rowTitle, commentCount)
                        : databaseViewLabels().addCommentTo(rowTitle)
                    }
                    aria-label={
                      commentCount
                        ? databaseViewLabels().openComments(rowTitle, commentCount)
                        : databaseViewLabels().addCommentTo(rowTitle)
                    }
                    onClick={() => openComments(pageId)}
                  >
                    <CommentIcon size={15} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.rowPeekShareAction}
                  title={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyShareLink(rowTitle)}
                  aria-label={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyShareLink(rowTitle)}
                  onClick={() => void copyRowLink()}
                >
                  <LockIcon size={14} aria-hidden="true" />
                  <span>{databaseViewLabels().share}</span>
                </button>
                <button
                  type="button"
                  className={styles.rowPeekIconAction}
                  title={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyLink(rowTitle)}
                  aria-label={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyLink(rowTitle)}
                  onClick={() => void copyRowLink()}
                >
                  <LinkIcon size={16} aria-hidden="true" />
                </button>
              </>
            )}
            {!publicReadOnly && (
              <>
                <button
                  type="button"
                  className={styles.rowPeekIconAction}
                  title={
                    page.isFavorite
                      ? databaseViewLabels().removeFromFavorites(rowTitle)
                      : databaseViewLabels().addToFavorites(rowTitle)
                  }
                  aria-label={
                    page.isFavorite
                      ? databaseViewLabels().removeFromFavorites(rowTitle)
                      : databaseViewLabels().addToFavorites(rowTitle)
                  }
                  onClick={() => void toggleRowFavorite()}
                >
                  {page.isFavorite ? (
                    <StarFilled size={17} aria-hidden="true" />
                  ) : (
                    <Star size={17} aria-hidden="true" />
                  )}
                </button>
                <button
                  ref={menuButtonRef}
                  type="button"
                  className={styles.rowPeekIconAction}
                  title={databaseViewLabels().openActions(rowTitle)}
                  aria-label={databaseViewLabels().openActions(rowTitle)}
                  aria-haspopup="menu"
                  aria-expanded={!!menuAnchor}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenuAnchor((current) =>
                      current ? null : { x: rect.left, y: rect.bottom }
                    );
                  }}
                >
                  <DotsHorizontal size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>
        {menuAnchor && !publicReadOnly && (
          <RowMenu
            pageId={pageId}
            anchor={menuAnchor}
            onClose={() => {
              setMenuAnchor(null);
              window.requestAnimationFrame(() => menuButtonRef.current?.focus());
            }}
          />
        )}
        <div
          className={`${styles.rowPeekScroll} nscroll`}
          onPointerDown={onRowPeekBlankPointerDown}
          onMouseDown={onRowPeekBlankMouseDown}
        >
          <PageCover pageId={pageId} compact readOnly={readOnly} />
          <div
            ref={findRootRef}
            className={styles.rowPeekDoc}
            data-has-cover={!!page.cover}
            data-row-page="true"
            data-row-peek-search-root
          >
            <PageHeader pageId={pageId} readOnly={readOnly} publicReadOnly={publicReadOnly} />
            <RowProperties
              dbId={dbId}
              row={page}
              view={view ?? undefined}
              openCustomizeTick={openPropertiesTick}
              readOnly={readOnly}
              onOpenPage={onOpenPage}
              pageHrefForRelation={(targetPageId) =>
                publicReadOnly && sharedToken
                  ? sharedPageHref(sharedToken, targetPageId)
                  : pageHref(targetPageId)
              }
              relationNavigation={!publicReadOnly}
              showBackReferences={false}
              showPropertyControls={false}
            />
            <div className={styles.rowPeekEditor}>
              <Editor
                pageId={pageId}
                readOnly={readOnly}
                publicReadOnly={publicReadOnly}
                sharedToken={sharedToken}
                showPageStarter={false}
                emptyBodyPrompt={publicReadOnly ? undefined : templateBodyPlaceholder()}
                skipRemoteLoad={publicReadOnly}
              />
            </div>
          </div>
        </div>
      </aside>
    </>
  );

  return typeof document === "undefined" ? peek : createPortal(peek, document.body);
}
