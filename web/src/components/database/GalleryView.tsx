"use client";

import { useMemo, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import { cardCoverValue, coverBackground, hasCardPreview } from "./cardPreview";
import { useRowContextMenu, type RowOpenMode } from "./useRowContextMenu";
import { Plus } from "../icons";
import { PageIconGlyph } from "../PageIcon";
import styles from "./database.module.css";

export function GalleryView({
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
  const { t } = useTranslation(["galleryView", "common"]);
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

  // Memoized like TableView's `shown`: applyView runs a full search-filter +
  // filter-group + multi-key sort over every loaded row on each render.
  const shown = useMemo(
    () => applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [rows, props, view, pagesById, search, contextPageId]
  );
  const visible = visibleViewProperties(props, view);
  const others = visible.filter((p) => p.type !== "title");
  const cardSize = view.config?.cardSize ?? "medium";
  const showPreview = hasCardPreview(view.config?.coverProperty);
  const wrap = !!view.config?.wrap;
  const fitImage = !!view.config?.fitImage;
  const dbTitle = pageDisplayTitle(db);
  const newPageLabel = t("galleryView:newPageIn", { dbTitle });

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
    <div className={styles.gallery} data-size={cardSize}>
      {shown.length === 0 && (
        <div className={styles.viewEmpty}>
          <div className={styles.viewEmptyTitle}>
            {rows.length === 0 ? t("galleryView:emptyTitle") : t("galleryView:noResultsTitle")}
          </div>
          <div className={styles.viewEmptyDesc}>
            {rows.length === 0 ? t("galleryView:emptyDesc") : t("galleryView:noResultsDesc")}
          </div>
          {!readOnly && (
            <button
              type="button"
              className={styles.viewEmptyAction}
              title={newPageLabel}
              aria-label={newPageLabel}
              onClick={() => void createRow()}
            >
              <Plus size={14} aria-hidden="true" /> {t("galleryView:newPage")}
            </button>
          )}
        </div>
      )}
      {shown.map((row) => {
        const cover = cardCoverValue(row, props, view.config?.coverProperty);
        const title = pageDisplayTitle(row);
        return (
          <div
            key={row.id}
            className={styles.galleryCard}
            role="button"
            tabIndex={0}
            aria-label={t("galleryView:openRow", { title })}
            data-wrap={wrap ? "true" : undefined}
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
            {showPreview && (
              <div
                className={styles.galleryCover}
                data-has-image={cover ? "true" : undefined}
                data-fit-image={fitImage ? "true" : undefined}
                style={{ backgroundImage: coverBackground(cover) }}
              >
                {!cover && (
                  <span className={styles.galleryIcon}>
                    <PageIconGlyph page={row} size={22} />
                  </span>
                )}
              </div>
            )}
            <div className={styles.galleryBody}>
              <div className={styles.galleryTitle}>{title}</div>
              <div className={styles.galleryMeta}>
                {others.map((p) => (
                  <PropValue key={p.id} row={row} prop={p} interactive={false} />
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {shown.length > 0 && !readOnly && (
        <button
          type="button"
          className={styles.galleryNew}
          title={newPageLabel}
          aria-label={newPageLabel}
          onClick={() => void createRow()}
        >
          <Plus size={16} aria-hidden="true" /> {t("galleryView:newInline")}
        </button>
      )}
      {rowContextMenu}
    </div>
  );
}
