"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "@/lib/router";
import {
  listAllBlocks,
  mergedBlocks,
  pageReferenceHits,
  pageTitle,
  type PageReferenceHit,
} from "@/lib/backlinks";
import { pageHref } from "@/lib/navigation";
import { relativeEditedLabel } from "@/lib/relativeTime";
import { useStore } from "@/lib/store";
import type { BacklinksDisplay, Block } from "@/lib/types";
import { ChevronRight, LinkIcon } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import styles from "./PageHeader.module.css";

function referenceEditedLabel(hit: PageReferenceHit) {
  return relativeEditedLabel(
    hit.block.updatedAt ?? hit.block.createdAt ?? hit.page.updatedAt ?? hit.page.createdAt
  );
}

export function PageBacklinks({
  pageId,
  display = "default",
}: {
  pageId: string;
  display?: BacklinksDisplay;
}) {
  const router = useRouter();
  const listId = useId();
  const pagesById = useStore((s) => s.pagesById);
  const blocksByPage = useStore((s) => s.blocksByPage);
  const loadedBlockPages = useStore((s) => s.loadedBlockPages);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const [fetchedBlocks, setFetchedBlocks] = useState<Block[]>([]);
  const [expandedOverride, setExpandedOverride] = useState<{ key: string; value: boolean } | null>(null);
  const [showAllKey, setShowAllKey] = useState<string | null>(null);
  const expandedKey = `${pageId}:${display}`;
  const expanded = expandedOverride?.key === expandedKey ? expandedOverride.value : display === "expanded";

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

    if (display === "off") {
      setFetchedBlocks([]);
      return () => {
        cancelled = true;
      };
    }

    const load = () => {
      listAllBlocks()
        .then((blocks) => {
          if (!cancelled) setFetchedBlocks(blocks);
        })
        .catch(() => {
          if (!cancelled) setFetchedBlocks([]);
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
  }, [display]);

  const backlinks = useMemo<PageReferenceHit[]>(() => {
    const allBlocks = mergedBlocks(fetchedBlocks, blocksByPage, loadedBlockPages);
    return pageReferenceHits(allBlocks, pagesById, { targetPageId: pageId });
  }, [blocksByPage, fetchedBlocks, loadedBlockPages, pageId, pagesById]);
  const backlinkCount = backlinks.length;
  const mentionCount = backlinks.filter((hit) => hit.kind === "mention").length;
  const linkCount = backlinkCount - mentionCount;
  const showAllCurrentKey = `${pageId}:${display}:${backlinkCount}`;
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

  if (display === "off" || backlinkCount === 0) return null;

  const visible = showAll ? backlinks : backlinks.slice(0, 12);
  const hiddenCount = backlinks.length - visible.length;
  const typeSummary = [
    mentionCount > 0 ? `${mentionCount} mention${mentionCount === 1 ? "" : "s"}` : "",
    linkCount > 0 ? `${linkCount} link${linkCount === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

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
        <span>{backlinkCount} backlink{backlinkCount === 1 ? "" : "s"}</span>
      </button>
      {expanded && (
        <div id={listId} className={styles.backlinkList}>
          <div className={styles.backlinkListHeader}>
            <span>Linked mentions</span>
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
                      {hit.kind === "mention" ? "Mention" : "Link"}
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
              {hiddenCount} more backlink{hiddenCount === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
