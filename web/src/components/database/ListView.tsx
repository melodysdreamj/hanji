"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { DbView, Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import {
  applyView,
  applyViewFilterSeeds,
  viewFilterSeedValues,
  visibleViewProperties,
} from "./query";
import { PropValue } from "./PropValue";
import { useRowContextMenu, type RowOpenMode } from "./useRowContextMenu";
import { Plus } from "../icons";
import { PageIconGlyph } from "../PageIcon";
import styles from "./database.module.css";

export function ListView({
  db,
  view,
  rows: rowsProp,
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
  readOnly?: boolean;
  search?: string;
  contextPageId?: string;
  onEditRowProperties?: (pageId: string) => void;
  onOpenRow?: (pageId: string) => void;
  onOpenRowIn?: (pageId: string, mode: RowOpenMode) => void;
}) {
  const { t } = useTranslation(["listView", "common"]);
  const router = useRouter();
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const addRow = useStore((s) => s.addRow);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const { openRowContextMenu, openRowContextMenuFromElement, rowContextMenu } =
    useRowContextMenu({
      onEditProperties: onEditRowProperties,
      onOpenRowIn,
    });

  const shown = applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId });
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

  return (
    <div className={styles.list}>
      {shown.length === 0 && (
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
      {shown.map((row) => {
        const title = pageDisplayTitle(row);
        return (
          <div
            key={row.id}
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
            <span className={styles.listMeta}>
              {others.map((p) => (
                <PropValue key={p.id} row={row} prop={p} interactive={false} />
              ))}
            </span>
          </div>
        );
      })}
      {shown.length > 0 && !readOnly && (
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
