"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useRouter } from "@/lib/router";
import {
  listPageBacklinks,
  mergedBlocks,
  pageReferenceHits,
  pageTitle,
  type PageReferenceHit,
} from "@/lib/backlinks";
import { pageHref } from "@/lib/navigation";
import { relativeEditedLabel } from "@/lib/relativeTime";
import { useStore } from "@/lib/store";
import type { BacklinksDisplay, Block, Page } from "@/lib/types";
import { ChevronRight, LinkIcon } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import styles from "./PageHeader.module.css";

function referenceEditedLabel(hit: PageReferenceHit) {
  return relativeEditedLabel(
    hit.block.updatedAt ?? hit.block.createdAt ?? hit.page.updatedAt ?? hit.page.createdAt
  );
}

const BACKLINKS_PAGE_LIMIT = 50;

interface RemoteBacklinksState {
  blocks: Block[];
  hasMore: boolean;
  key: string;
  loadingMore: boolean;
  nextCursor?: string;
  pages: Page[];
}

const EMPTY_REMOTE_BACKLINKS: RemoteBacklinksState = {
  blocks: [],
  hasMore: false,
  key: "",
  loadingMore: false,
  pages: [],
};
const EMPTY_LOCAL_BLOCKS_BY_PAGE: Record<string, Block[]> = {};
const EMPTY_LOCAL_PAGES_BY_ID: Record<string, Page> = {};

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  return Array.from(new Map([...current, ...incoming].map((item) => [item.id, item])).values());
}

export function PageBacklinks({
  pageId,
  display = "default",
}: {
  pageId: string;
  display?: BacklinksDisplay;
}) {
  const router = useRouter();
  const { t } = useTranslation("pageBacklinks");
  const listId = useId();
  const targetPage = useStore((s) => s.pagesById[pageId]);
  const workspaceId = targetPage?.workspaceId;
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const [remoteState, setRemoteState] = useState<RemoteBacklinksState>(EMPTY_REMOTE_BACKLINKS);
  const [expandedOverride, setExpandedOverride] = useState<{ key: string; value: boolean } | null>(null);
  const [showAllKey, setShowAllKey] = useState<string | null>(null);
  const expandedKey = `${pageId}:${display}`;
  const expanded = expandedOverride?.key === expandedKey ? expandedOverride.value : display === "expanded";
  const remoteKey = `${pageId}:${workspaceId ?? ""}`;
  const currentRemote = remoteState.key === remoteKey ? remoteState : EMPTY_REMOTE_BACKLINKS;
  const localSourceBlocksByPage = useStore(
    useShallow((state) => {
      if (display === "off") return EMPTY_LOCAL_BLOCKS_BY_PAGE;
      const sources: Record<string, Block[]> = {};
      for (const sourcePageId of state.loadedBlockPages) {
        if (sourcePageId === pageId) continue;
        const blocks = state.blocksByPage[sourcePageId];
        if (blocks) sources[sourcePageId] = blocks;
      }
      return sources;
    })
  );
  const loadedSourcePageIds = useMemo(
    () => Object.keys(localSourceBlocksByPage),
    [localSourceBlocksByPage]
  );
  const loadedSourcePages = useMemo(
    () => new Set(loadedSourcePageIds),
    [loadedSourcePageIds]
  );
  const relevantPageSeedIds = useMemo(() => {
    if (display === "off") return [];
    const ids = new Set<string>([pageId, ...loadedSourcePageIds]);
    for (const block of currentRemote.blocks) ids.add(block.pageId);
    for (const page of currentRemote.pages) {
      ids.add(page.id);
      if (page.parentId) ids.add(page.parentId);
    }
    return Array.from(ids);
  }, [currentRemote.blocks, currentRemote.pages, display, loadedSourcePageIds, pageId]);
  const localPagesById = useStore(
    useShallow((state) => {
      if (display === "off") return EMPTY_LOCAL_PAGES_BY_ID;
      const pages: Record<string, Page> = {};
      const pending = [...relevantPageSeedIds];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const id = pending.pop();
        if (!id || visited.has(id)) continue;
        visited.add(id);
        const page = state.pagesById[id];
        if (!page) continue;
        pages[id] = page;
        if (page.parentId) pending.push(page.parentId);
      }
      return pages;
    })
  );

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (display === "off" || !workspaceId) {
      return () => {
        cancelled = true;
      };
    }

    const load = () => {
      listPageBacklinks(pageId, BACKLINKS_PAGE_LIMIT, workspaceId)
        .then((result) => {
          if (!cancelled) {
            setRemoteState({
              key: remoteKey,
              blocks: result.blocks,
              pages: result.pages ?? [],
              hasMore: result.hasMore === true,
              ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
              loadingMore: false,
            });
          }
        })
        .catch(() => {
          if (!cancelled) setRemoteState({ ...EMPTY_REMOTE_BACKLINKS, key: remoteKey });
        });
    };

    if (display === "expanded") {
      load();
    } else {
      timeoutId = window.setTimeout(() => {
        if (idleWindow.requestIdleCallback) {
          idleId = idleWindow.requestIdleCallback(load, { timeout: 2500 });
          return;
        }
        load();
      }, 4000);
    }

    return () => {
      cancelled = true;
      if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [display, pageId, remoteKey, workspaceId]);

  const loadMore = useCallback(() => {
    if (!workspaceId || !currentRemote.hasMore || !currentRemote.nextCursor || currentRemote.loadingMore) {
      return;
    }
    const sourceCursor = currentRemote.nextCursor;
    setRemoteState((state) => state.key === remoteKey ? { ...state, loadingMore: true } : state);
    listPageBacklinks(pageId, BACKLINKS_PAGE_LIMIT, workspaceId, { sourceCursor })
      .then((result) => {
        setRemoteState((state) => {
          if (state.key !== remoteKey || state.nextCursor !== sourceCursor) return state;
          return {
            key: remoteKey,
            blocks: mergeById(state.blocks, result.blocks),
            pages: mergeById(state.pages, result.pages ?? []),
            hasMore: result.hasMore === true,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            loadingMore: false,
          };
        });
      })
      .catch(() => {
        setRemoteState((state) => state.key === remoteKey ? { ...state, loadingMore: false } : state);
      });
  }, [currentRemote.hasMore, currentRemote.loadingMore, currentRemote.nextCursor, pageId, remoteKey, workspaceId]);

  const effectivePagesById = useMemo(() => ({
    ...Object.fromEntries(currentRemote.pages.map((page) => [page.id, page])),
    ...localPagesById,
  }), [currentRemote.pages, localPagesById]);

  const backlinks = useMemo<PageReferenceHit[]>(() => {
    if (display === "off") return [];
    const allBlocks = mergedBlocks(
      currentRemote.blocks,
      localSourceBlocksByPage,
      loadedSourcePages
    );
    return pageReferenceHits(allBlocks, effectivePagesById, { targetPageId: pageId });
  }, [currentRemote.blocks, display, effectivePagesById, loadedSourcePages, localSourceBlocksByPage, pageId]);
  const backlinkCount = backlinks.length;
  const mentionCount = backlinks.filter((hit) => hit.kind === "mention").length;
  const linkCount = backlinkCount - mentionCount;
  const showAllCurrentKey = `${pageId}:${display}`;
  const showAll = showAllKey === showAllCurrentKey;

  const openBacklink = useCallback(
    (hit: PageReferenceHit, newTab = false) => {
      const href = `${pageHref(hit.page.id)}#block-${encodeURIComponent(hit.block.id)}`;
      if (newTab) {
        window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      setSidebarOpen(false);
      router.push(href);
    },
    [router, setSidebarOpen]
  );

  if (display === "off") return null;
  if (backlinkCount === 0) {
    if (!currentRemote.hasMore) return null;
    return (
      <div className={styles.backlinks}>
        <button
          type="button"
          className={styles.backlinkMore}
          disabled={currentRemote.loadingMore}
          onClick={loadMore}
        >
          {currentRemote.loadingMore
            ? t("pageBacklinks:more.loading")
            : t("pageBacklinks:more.search")}
        </button>
      </div>
    );
  }

  const visible = showAll ? backlinks : backlinks.slice(0, 12);
  const hiddenCount = backlinks.length - visible.length;
  const loadedTypeSummary = [
    mentionCount > 0 ? t("pageBacklinks:summary.mention", { count: mentionCount }) : "",
    linkCount > 0 ? t("pageBacklinks:summary.link", { count: linkCount }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const typeSummary = currentRemote.hasMore
    ? t("pageBacklinks:summary.loaded", { summary: loadedTypeSummary })
    : loadedTypeSummary;

  return (
    <div className={styles.backlinks}>
      <button
        type="button"
        className={styles.backlinkToggle}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => {
          if (expanded) setShowAllKey(null);
          setExpandedOverride({ key: expandedKey, value: !expanded });
        }}
      >
        <ChevronRight size={14} />
        <span>
          {currentRemote.hasMore
            ? t("pageBacklinks:toggle.partial", { count: backlinkCount })
            : t("pageBacklinks:toggle.count", { count: backlinkCount })}
        </span>
      </button>
      {expanded && (
        <div id={listId} className={styles.backlinkList}>
          <div className={styles.backlinkListHeader}>
            <span>{t("pageBacklinks:header.title")}</span>
            <span>{typeSummary}</span>
          </div>
          {visible.map((hit) => {
            const edited = referenceEditedLabel(hit);
            return (
              <button
                type="button"
                key={`${hit.block.pageId}:${hit.block.id}`}
                className={styles.backlinkItem}
                onClick={(e) => openBacklink(hit, e.metaKey || e.ctrlKey)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    openBacklink(hit, true);
                  }
                }}
              >
                <span className={styles.backlinkIcon} aria-hidden="true">
                  <PageIconGlyph page={hit.page} size={15} fallback={<LinkIcon size={15} />} />
                </span>
                <span className={styles.backlinkBody}>
                  <span className={styles.backlinkTitleRow}>
                    <span className={styles.backlinkTitle}>{pageTitle(hit.page)}</span>
                    <span className={styles.backlinkKind} data-kind={hit.kind}>
                      {hit.kind === "mention" ? t("pageBacklinks:kind.mention") : t("pageBacklinks:kind.link")}
                    </span>
                  </span>
                  <span className={styles.backlinkPreview}>{hit.preview}</span>
                  {(hit.path || edited) && (
                    <span className={styles.backlinkMeta}>
                      {hit.path && <span className={styles.backlinkMetaPath}>{hit.path}</span>}
                      {hit.path && edited && <span aria-hidden="true">·</span>}
                      {edited && <span className={styles.backlinkMetaTime}>{edited}</span>}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button type="button" className={styles.backlinkMore} onClick={() => setShowAllKey(showAllCurrentKey)}>
              {t("pageBacklinks:more.count", { count: hiddenCount })}
            </button>
          )}
          {currentRemote.hasMore && (
            <button
              type="button"
              className={styles.backlinkMore}
              disabled={currentRemote.loadingMore}
              onClick={loadMore}
            >
              {currentRemote.loadingMore
                ? t("pageBacklinks:more.loading")
                : t("pageBacklinks:more.load")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
