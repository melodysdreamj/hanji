"use client";

import { useMemo, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { pickLabels } from "@/lib/i18n";
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

const GALLERY_VIEW_LABELS = {
  en: {
    emptyDesc: "This database has no pages yet.",
    emptyTitle: "No pages yet",
    newInline: "New",
    newPage: "New page",
    newPageIn: (dbTitle: string) => `New page in ${dbTitle}`,
    noResultsDesc: "No pages match the current filters or search.",
    noResultsTitle: "No results",
    openRow: (title: string) => `Open ${title}`,
  },
  ko: {
    emptyDesc: "이 데이터베이스에는 아직 페이지가 없습니다.",
    emptyTitle: "아직 페이지가 없습니다",
    newInline: "새 페이지",
    newPage: "새 페이지",
    newPageIn: (dbTitle: string) => `새 페이지 추가 (${dbTitle})`,
    noResultsDesc: "현재 필터나 검색과 일치하는 페이지가 없습니다",
    noResultsTitle: "검색 결과가 없습니다",
    openRow: (title: string) => `${title} 열기`,
  },
} as const;

function galleryViewLabels() {
  return pickLabels(GALLERY_VIEW_LABELS);
}

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
  const newPageLabel = galleryViewLabels().newPageIn(dbTitle);

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
            {rows.length === 0 ? galleryViewLabels().emptyTitle : galleryViewLabels().noResultsTitle}
          </div>
          <div className={styles.viewEmptyDesc}>
            {rows.length === 0 ? galleryViewLabels().emptyDesc : galleryViewLabels().noResultsDesc}
          </div>
          {!readOnly && (
            <button
              type="button"
              className={styles.viewEmptyAction}
              title={newPageLabel}
              aria-label={newPageLabel}
              onClick={() => void createRow()}
            >
              <Plus size={14} aria-hidden="true" /> {galleryViewLabels().newPage}
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
            aria-label={galleryViewLabels().openRow(title)}
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
                  <PropValue key={p.id} row={row} prop={p} interactive={!readOnly && !row.isLocked} onOpenPage={openRow} />
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
          <Plus size={16} aria-hidden="true" /> {galleryViewLabels().newInline}
        </button>
      )}
      {rowContextMenu}
    </div>
  );
}
