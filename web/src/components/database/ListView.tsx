"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { DbView, Page } from "@/lib/types";
import {
  databaseRowsQueryKey,
  useStore,
  type DatabaseRowsQuery,
  type DatabaseSubitemRowWindow,
} from "@/lib/store";
import {
  applyView,
  applyViewFilterSeeds,
  viewFilterSeedValues,
  visibleViewProperties,
} from "./query";
import { PropValue } from "./PropValue";
import { useRowContextMenu, type RowOpenMode } from "./useRowContextMenu";
import { ChevronDown, ChevronRight, Plus } from "../icons";
import { PageIconGlyph } from "../PageIcon";
import styles from "./database.module.css";

const EMPTY_SUBITEM_ROW_WINDOWS: Record<string, DatabaseSubitemRowWindow> = {};

export function ListView({
  db,
  view,
  rows: rowsProp,
  rowsViewApplied = false,
  rowQuery,
  readOnly = false,
  search,
  contextPageId,
  onEditRowProperties,
  onOpenRow,
  onOpenRowIn,
}: {
  db: Page;
  view: DbView;
  rows?: Page[];
  rowsViewApplied?: boolean;
  rowQuery?: DatabaseRowsQuery;
  readOnly?: boolean;
  search?: string;
  contextPageId?: string;
  onEditRowProperties?: (pageId: string) => void;
  onOpenRow?: (pageId: string) => void;
  onOpenRowIn?: (pageId: string, mode: RowOpenMode) => void;
}) {
  const { t } = useTranslation(["listView", "tableView", "common"]);
  const router = useRouter();
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const subitemWindows = useStore((s) => s.databaseSubitemRowWindowsByDb[db.id])
    ?? EMPTY_SUBITEM_ROW_WINDOWS;
  const loadDatabaseSubitemRows = useStore((s) => s.loadDatabaseSubitemRows);
  const loadMoreDatabaseSubitemRows = useStore((s) => s.loadMoreDatabaseSubitemRows);
  const addRow = useStore((s) => s.addRow);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const { openRowContextMenu, openRowContextMenuFromElement, rowContextMenu } =
    useRowContextMenu({
      onEditProperties: onEditRowProperties,
      onOpenRowIn,
    });

  const baseShown = useMemo(
    () => rowsViewApplied
      ? rows
      : applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [contextPageId, pagesById, props, rows, rowsViewApplied, search, view]
  );
  const subitemQuery = useMemo<DatabaseRowsQuery>(
    () => rowQuery ?? { viewId: view.id, search, currentPageId: contextPageId },
    [contextPageId, rowQuery, search, view.id]
  );
  const subitemQueryKey = databaseRowsQueryKey(subitemQuery);
  useEffect(() => {
    setExpandedRows(new Set());
  }, [subitemQueryKey]);
  const matchingSubitemWindow = useCallback((parentId: string) => {
    const window = subitemWindows[parentId];
    if (!window) return undefined;
    const expectedQueryKey = databaseRowsQueryKey({
      ...subitemQuery,
      subitemParentId: parentId,
    });
    return window.queryKey === expectedQueryKey ? window : undefined;
  }, [subitemQuery, subitemWindows]);
  const shown = useMemo(() => {
    if (expandedRows.size === 0) return baseShown;
    const merged = [...baseShown];
    const seen = new Set(merged.map((row) => row.id));
    for (const parentId of expandedRows) {
      const window = matchingSubitemWindow(parentId);
      if (!window) continue;
      for (const rowId of window.rowIds) {
        const row = pagesById[rowId];
        if (!row || row.subitemParentId !== parentId || seen.has(row.id)) continue;
        merged.push(row);
        seen.add(row.id);
      }
    }
    return merged;
  }, [baseShown, expandedRows, matchingSubitemWindow, pagesById]);
  const subtaskConfig = view.config?.subtasks;
  const subtaskDisplayMode = subtaskConfig?.displayMode ?? "show";
  const subtaskFilterScope = subtaskConfig?.filterScope ?? "parents_and_subitems";
  const subtaskRenderingEnabled = db.databaseFeatures?.subitems?.enabled === true
    && subtaskDisplayMode !== "disabled";
  const expandableSubtasks = subtaskRenderingEnabled
    && subtaskDisplayMode === "show"
    && subtaskFilterScope === "parents_and_subitems";
  const flattenedSubtasks = subtaskRenderingEnabled && subtaskDisplayMode === "flattened";
  const hiddenSubtasks = subtaskRenderingEnabled && subtaskDisplayMode === "hidden";
  const hierarchyRows = useMemo(() => {
    const eligible = shown.filter((row) => (
      row.__structuralPlaceholder !== true || expandableSubtasks
    ));
    if (!subtaskRenderingEnabled) return eligible;
    if (subtaskDisplayMode === "hidden" || subtaskFilterScope === "parents") {
      return eligible.filter((row) => !row.subitemParentId);
    }
    if (subtaskFilterScope === "subitems") {
      return eligible.filter((row) => !!row.subitemParentId);
    }
    return eligible;
  }, [
    expandableSubtasks,
    shown,
    subtaskDisplayMode,
    subtaskFilterScope,
    subtaskRenderingEnabled,
  ]);
  const childCountByParent = new Map<string, number>();
  for (const row of shown) {
    if (!row.subitemParentId) continue;
    childCountByParent.set(
      row.subitemParentId,
      (childCountByParent.get(row.subitemParentId) ?? 0) + 1
    );
  }
  for (const row of shown) {
    if (
      typeof row.subitemChildCount === "number"
      && Number.isSafeInteger(row.subitemChildCount)
      && row.subitemChildCount >= 0
    ) {
      childCountByParent.set(row.id, row.subitemChildCount);
    }
  }
  const shownIds = new Set(hierarchyRows.map((row) => row.id));
  const childrenByParent = new Map<string, Page[]>();
  const rootRows: Page[] = [];
  for (const row of hierarchyRows) {
    const parentId = expandableSubtasks
      && row.subitemParentId
      && shownIds.has(row.subitemParentId)
      ? row.subitemParentId
      : undefined;
    if (!parentId) {
      rootRows.push(row);
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(row);
    childrenByParent.set(parentId, children);
  }
  const renderedItems: Array<{ row: Page; depth: number; hasChildren: boolean }> = [];
  const pushTree = (row: Page, depth: number) => {
    const children = childrenByParent.get(row.id) ?? [];
    const hasChildren = expandableSubtasks && (
      row.__structuralPlaceholder === true
      || (childCountByParent.get(row.id) ?? 0) > 0
    );
    renderedItems.push({ row, depth, hasChildren });
    if (expandedRows.has(row.id)) {
      for (const child of children) pushTree(child, depth + 1);
    }
  };
  for (const row of rootRows) pushTree(row, 0);
  const visible = visibleViewProperties(props, view);
  const others = visible.filter((p) => p.type !== "title");
  const dbTitle = pageDisplayTitle(db);
  const newPageLabel = t("listView:newPageIn", { dbTitle });

  function openRow(pageId: string) {
    if (onOpenRow) {
      onOpenRow(pageId);
    } else {
      router.push(pageHref(pageId));
    }
  }

  function openRowClick(pageId: string, e: React.MouseEvent<HTMLElement>) {
    if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
    else openRow(pageId);
  }

  function openRowKey(pageId: string, e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      e.stopPropagation();
      openRowContextMenuFromElement(pageId, e.currentTarget);
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
    else openRow(pageId);
  }

  async function createRow() {
    if (readOnly) return;
    const row = await addRow(db.id, true, undefined, { focusTitle: true });
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
    openRow(row.id);
  }

  function toggleExpanded(id: string) {
    const expanding = !expandedRows.has(id);
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (expanding && rowQuery?.subitemParentId === "") {
      void loadDatabaseSubitemRows(db.id, id, subitemQuery);
    }
  }

  return (
    <div className={styles.list}>
      {renderedItems.length === 0 && (
        <div className={styles.viewEmpty}>
          <div className={styles.viewEmptyTitle}>
            {rows.length === 0 ? t("listView:emptyTitle") : t("listView:noResultsTitle")}
          </div>
          <div className={styles.viewEmptyDesc}>
            {rows.length === 0 ? t("listView:emptyDesc") : t("listView:noResultsDesc")}
          </div>
          {!readOnly && (
            <button
              type="button"
              className={styles.viewEmptyAction}
              title={newPageLabel}
              aria-label={newPageLabel}
              onClick={() => void createRow()}
            >
              <Plus size={14} aria-hidden="true" /> {t("listView:newPage")}
            </button>
          )}
        </div>
      )}
      {renderedItems.map(({ row, depth, hasChildren }) => {
        const isStructuralPlaceholder = row.__structuralPlaceholder === true;
        const title = isStructuralPlaceholder
          ? t("tableView:restrictedParent")
          : pageDisplayTitle(row);
        const expanded = expandedRows.has(row.id);
        const subitemLabel = expanded
          ? t("tableView:collapseSubitems", { title })
          : t("tableView:expandSubitems", { title });
        const parent = row.subitemParentId ? pagesById[row.subitemParentId] : undefined;
        const parentTitle = parent?.__structuralPlaceholder === true
          ? t("tableView:restrictedParent")
          : parent
            ? pageDisplayTitle(parent)
            : "";
        const childCount = childCountByParent.get(row.id) ?? 0;
        const subitemWindow = expanded ? matchingSubitemWindow(row.id) : undefined;
        return (
          <div
            key={row.id}
            className={styles.listTreeRow}
            data-list-row-id={row.id}
            data-list-row-title={title}
            data-structural-placeholder={isStructuralPlaceholder ? "true" : undefined}
            data-subitem-depth={depth > 0 ? depth : undefined}
          >
            {depth > 0 && (
              <span
                className={styles.subitemIndent}
                style={{ width: depth * 20 }}
                aria-hidden="true"
              />
            )}
            {hasChildren && (
              <button
                type="button"
                className={styles.subitemToggle}
                data-visible="true"
                aria-expanded={expanded}
                aria-label={subitemLabel}
                title={subitemLabel}
                onClick={() => toggleExpanded(row.id)}
              >
                {expanded
                  ? <ChevronDown size={13} aria-hidden="true" />
                  : <ChevronRight size={13} aria-hidden="true" />}
              </button>
            )}
            {expanded && subitemWindow?.hasMore && (
              <button
                type="button"
                className={styles.subitemToggle}
                data-subitem-load-more
                data-visible="true"
                aria-label={`${t("tableView:loadMore")}: ${title}`}
                title={`${t("tableView:loadMore")}: ${title}`}
                disabled={subitemWindow.loadingMore === true}
                onClick={() => void loadMoreDatabaseSubitemRows(db.id, row.id, subitemQuery)}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            )}
            {isStructuralPlaceholder ? (
              <div className={styles.listRow} aria-label={title}>
                <span className={styles.listTitle}>{title}</span>
              </div>
            ) : (
              <div
                className={styles.listRow}
                role="button"
                tabIndex={0}
                aria-label={t("listView:openRow", { title })}
                onClick={(e) => openRowClick(row.id, e)}
                onKeyDown={(e) => openRowKey(row.id, e)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    openPageInNewTab(row.id);
                  }
                }}
                onContextMenu={(e) => openRowContextMenu(row.id, e)}
              >
                <span className={styles.listIcon}>
                  <PageIconGlyph page={row} size={16} />
                </span>
                <span className={styles.listTitle}>{title}</span>
                {flattenedSubtasks && row.subitemParentId && (
                  <span
                    className={styles.subitemParentIndicator}
                    data-subitem-parent-id={row.subitemParentId}
                    title={t("tableView:subitemOf", { title: parentTitle })}
                  >
                    {t("tableView:subitemOf", { title: parentTitle })}
                  </span>
                )}
                {hiddenSubtasks && childCount > 0 && (
                  <span className={styles.subitemCount} data-subitem-count={childCount}>
                    {t("tableView:subitemCount", { count: childCount })}
                  </span>
                )}
                <span className={styles.listMeta}>
                  {others.map((p) => (
                    <PropValue key={p.id} row={row} prop={p} interactive={false} />
                  ))}
                </span>
              </div>
            )}
          </div>
        );
      })}
      {renderedItems.length > 0 && !readOnly && (
        <button
          type="button"
          className={styles.listNew}
          title={newPageLabel}
          aria-label={newPageLabel}
          onClick={() => void createRow()}
        >
          <Plus size={15} aria-hidden="true" /> {t("listView:newInline")}
        </button>
      )}
      {rowContextMenu}
    </div>
  );
}
