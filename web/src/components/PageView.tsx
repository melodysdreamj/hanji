"use client";

import { lazy, Suspense, type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { pickLabels } from "@/lib/i18n";
import { pageFaviconHref, setDocumentChrome } from "@/lib/documentChrome";
import { syntheticNotionImportRootLandingPage } from "@/lib/importedNotionUi";
import { motionSafeScrollBehavior } from "@/lib/motion";
import { pageHref, sharedPageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import {
  publishPageAwareness,
  usePagePresence,
  type PageAwarenessMode,
  type PageAwarenessTextRange,
} from "@/lib/pagePresence";
import {
  PAGE_ROOM_MUTATION_RECEIVED_EVENT,
  type PageRoomMutationReceived,
} from "@/lib/pageRoomEvents";
import { canCommentPage, canEditPage } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import { TopBar } from "./TopBar";
import { PageCover } from "./PageCover";
import { ErrorBoundary } from "./ErrorBoundary";
import { PageHeader } from "./PageHeader";
import { PagePresence } from "./PagePresence";
import { PageFindBar, selectedTextForPageFind } from "./PageFindBar";
import styles from "./PageView.module.css";

const Editor = lazy(() => import("./editor/Editor").then(({ Editor }) => ({ default: Editor })));
const DatabaseView = lazy(() =>
  import("./database/DatabaseView").then(({ DatabaseView }) => ({ default: DatabaseView }))
);
const RowProperties = lazy(() =>
  import("./database/RowProperties").then(({ RowProperties }) => ({ default: RowProperties }))
);

const HASH_BLOCK_PREFIX = "block-";
const HASH_COMMENT_PREFIX = "comment-";

const PAGE_VIEW_LABELS = {
  en: {
    couldntRestorePage: "Couldn't restore page",
    emptyBodyPrompt: "Press Enter to start writing on this empty page.",
    inTrashTopBarTitle: "In Trash",
    notFoundTopBarTitle: "Not found",
    openWorkspace: "Open workspace",
    pageInTrash: "This page is in Trash.",
    pageInTrashDetail: "Restore it before opening or editing its contents.",
    pageUnavailable: "Page unavailable.",
    pageUnavailableDetail:
      "This page may have been deleted, moved, or shared with a different account.",
    restorePage: "Restore page",
    restoredPage: "Restored page",
  },
  ko: {
    couldntRestorePage: "페이지를 복원하지 못했어요",
    emptyBodyPrompt: "Enter 키를 눌러 빈 페이지에 입력을 시작하세요.",
    inTrashTopBarTitle: "휴지통에 있음",
    notFoundTopBarTitle: "찾을 수 없음",
    openWorkspace: "워크스페이스 열기",
    pageInTrash: "이 페이지는 휴지통에 있어요.",
    pageInTrashDetail: "내용을 열거나 편집하려면 먼저 복원하세요.",
    pageUnavailable: "페이지를 열 수 없어요.",
    pageUnavailableDetail:
      "페이지가 삭제되었거나 이동되었거나 다른 계정과 공유되었을 수 있어요.",
    restorePage: "페이지 복원",
    restoredPage: "페이지를 복원했어요",
  },
} as const;
const EMPTY_PAGE_BLOCKS: ReturnType<typeof useStore.getState>["blocksByPage"][string] = [];
const EMPTY_DB_VIEWS: ReturnType<typeof useStore.getState>["viewsByDb"][string] = [];
const TOGGLE_BLOCK_TYPES = new Set([
  "toggle",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
]);

function currentHashTargetId() {
  if (typeof window === "undefined") return "";
  const raw = window.location.hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function hasPageContentHashTarget() {
  const id = currentHashTargetId();
  return id.startsWith(HASH_BLOCK_PREFIX) || id.startsWith(HASH_COMMENT_PREFIX);
}

function ContentFallback() {
  return <div className={styles.contentFallback} aria-busy="true" aria-label="Loading page content" />;
}

export function PageView({
  pageId,
  publicReadOnly = false,
  sharedToken,
}: {
  pageId: string;
  publicReadOnly?: boolean;
  sharedToken?: string;
}) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const page = useStore((s) => s.pagesById[pageId]);
  const rowDatabaseId =
    page?.parentType === "database" && page.parentId ? page.parentId : null;
  const rowDatabaseViews = useStore((s) =>
    rowDatabaseId ? s.viewsByDb[rowDatabaseId] ?? EMPTY_DB_VIEWS : EMPTY_DB_VIEWS
  );
  const rowDetailView =
    rowDatabaseViews.find((view) => (view.config?.rowPagePropertyOrder?.length ?? 0) > 0) ??
    null;
  const ready = useStore((s) => s.ready);
  const blocksLoaded = useStore((s) => s.loadedBlockPages.has(pageId));
  const commentsLoaded = useStore((s) => s.loadedCommentPages.has(pageId));
  const blocks = useStore((s) => s.blocksByPage[pageId] ?? EMPTY_PAGE_BLOCKS);
  const loadBlocks = useStore((s) => s.loadBlocks);
  const loadComments = useStore((s) => s.loadComments);
  const recordPageVisit = useStore((s) => s.recordPageVisit);
  const restorePage = useStore((s) => s.restorePage);
  const notify = useStore((s) => s.notify);
  const [topbarScroll, setTopbarScroll] = useState({ pageId, scrolled: false });
  // Page id whose block load was refused outright (401/403/404): the page
  // meta in the store is stale (revoked share / deleted page), so render the
  // unavailable panel instead of an endless loading skeleton.
  const [blocksDeniedPageId, setBlocksDeniedPageId] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusTick, setFindFocusTick] = useState(0);
  const [findInitialQuery, setFindInitialQuery] = useState("");
  const topbarScrolled = topbarScroll.pageId === pageId && topbarScroll.scrolled;
  // Permission booleans as selectors (not derived from a whole-pagesById
  // subscription): unrelated page edits then can't re-render the page view.
  const roleReadOnly = useStore((s) => {
    const current = s.pagesById[pageId];
    return (
      !!current &&
      !canEditPage({
        page: current,
        pagesById: s.pagesById,
        pageRoles: s.pageRolesById,
        workspace: s.workspace,
        currentMember: s.currentMember,
        userId: s.userId,
      })
    );
  });
  const readOnly = publicReadOnly || roleReadOnly || !!page?.isLocked;
  // A `comment` role is read-only for blocks but may still add/read comments;
  // don't collapse it into full readOnly. Public shares can't comment.
  const canCommentRole = useStore((s) => {
    const current = s.pagesById[pageId];
    return (
      !!current &&
      canCommentPage({
        page: current,
        pagesById: s.pagesById,
        pageRoles: s.pageRolesById,
        workspace: s.workspace,
        currentMember: s.currentMember,
        userId: s.userId,
      })
    );
  });
  const canComment = !publicReadOnly && canCommentRole;
  const presenceEnabled = !publicReadOnly && !findOpen && ready && !!page && !page.inTrash;
  const presence = usePagePresence(pageId, presenceEnabled);
  const publishPageViewAwareness = useCallback(
    (
      blockId: string,
      mode: PageAwarenessMode,
      selectedBlockIds?: string[],
      textRange?: PageAwarenessTextRange,
    ) => {
      if (publicReadOnly) return;
      publishPageAwareness({
        blockId,
        mode,
        pageId,
        selectedBlockIds,
        textRange,
      });
    },
    [pageId, publicReadOnly],
  );
  const awarenessList = presence.awareness;
  const remoteAwarenessByBlock = useMemo<Record<string, typeof awarenessList>>(() => {
    const byBlock: Record<string, typeof awarenessList> = {};
    for (const awareness of awarenessList) {
      const ids =
        awareness.selectedBlockIds.length > 0
          ? awareness.selectedBlockIds
          : awareness.blockId
            ? [awareness.blockId]
            : [];
      for (const id of ids) byBlock[id] = [...(byBlock[id] ?? []), awareness];
    }
    return byBlock;
  }, [awarenessList]);

  useEffect(() => {
    function onRoomMutation(event: Event) {
      const detail = (event as CustomEvent<PageRoomMutationReceived>).detail;
      if (!detail || detail.pageId !== pageId) return;
      if (detail.kind === "page_meta_changed" && detail.targetPageId && detail.patch) {
        useStore.getState().applyRemotePagePatch(detail.targetPageId, detail.patch);
        return;
      }
      if (detail.kind === "permissions_changed") {
        void useStore.getState().refreshPageAccess(pageId).catch(() => {});
        return;
      }
      if (detail.kind === "comments_changed") {
        // Force past the SWR rate limit — the signal means the server HAS
        // newer comments right now.
        void useStore.getState().loadComments(pageId, { force: true }).catch(() => {});
      }
    }

    window.addEventListener(PAGE_ROOM_MUTATION_RECEIVED_EVENT, onRoomMutation);
    return () => window.removeEventListener(PAGE_ROOM_MUTATION_RECEIVED_EVENT, onRoomMutation);
  }, [pageId]);
  const findRevision = useMemo(
    () =>
      [
        page?.title ?? "",
        ...blocks.map((block) => `${block.id}:${block.plainText ?? ""}`),
      ].join("\u0000"),
    [blocks, page?.title],
  );
  const hasRootInlineDatabase = useMemo(
    () =>
      blocks.some((block) => block.type === "inline_database" && !block.parentId) ||
      (!blocksLoaded && page?.layoutHints?.hasRootInlineDatabase === true),
    [blocks, blocksLoaded, page?.layoutHints?.hasRootInlineDatabase],
  );
  const hasRootColumnList = useMemo(
    () =>
      blocks.some((block) => block.type === "column_list" && !block.parentId) ||
      (!blocksLoaded && page?.layoutHints?.hasRootColumnList === true),
    [blocks, blocksLoaded, page?.layoutHints?.hasRootColumnList],
  );
  const hasWideRootContent = useMemo(
    () =>
      !!page &&
      page.kind === "page" &&
      !!page.fullWidth &&
      (hasRootInlineDatabase || hasRootColumnList),
    [hasRootColumnList, hasRootInlineDatabase, page],
  );
  // Identity-stable selector (cheap: short-circuits unless the page is a
  // synthetic Notion-import root) instead of a whole-pagesById dependency.
  const syntheticImportLandingPage = useStore((s) => {
    const current = s.pagesById[pageId];
    return current ? syntheticNotionImportRootLandingPage(current, s.pagesById) : undefined;
  });
  const syntheticImportLandingPageId = syntheticImportLandingPage?.id;

  const onPageScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollLeft !== 0) {
      e.currentTarget.scrollLeft = 0;
    }
    const next = e.currentTarget.scrollTop > 8;
    setTopbarScroll((current) =>
      current.pageId === pageId && current.scrolled === next
        ? current
        : { pageId, scrolled: next }
    );
  }, [pageId]);

  useLayoutEffect(() => {
    if (hasPageContentHashTarget()) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setTopbarScroll({ pageId, scrolled: false });
  }, [pageId]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
  });

  useEffect(() => {
    if ((ready || publicReadOnly) && page && !page.inTrash) {
      if (!publicReadOnly) {
        loadBlocks(pageId).catch((error: unknown) => {
          const status = (error as { status?: unknown; code?: unknown } | null)?.status ??
            (error as { code?: unknown } | null)?.code;
          if (status === 401 || status === 403 || status === 404) {
            setBlocksDeniedPageId(pageId);
          }
        });
      }
      if (!publicReadOnly) void loadComments(pageId).catch(() => {});
    }
  }, [ready, page, pageId, loadBlocks, loadComments, publicReadOnly]);

  useEffect(() => {
    setBlocksDeniedPageId(null);
  }, [pageId]);

  useEffect(() => {
    if (ready && page && !page.inTrash && !publicReadOnly) recordPageVisit(pageId);
  }, [ready, page, pageId, publicReadOnly, recordPageVisit]);

  useEffect(() => {
    if (!ready && !publicReadOnly) return;
    if (syntheticImportLandingPageId) return;
    setDocumentChrome({
      title: page ? `${pageDisplayTitle(page)} - Hanji` : "Hanji",
      iconHref: pageFaviconHref(page),
    });
  }, [page, publicReadOnly, ready, syntheticImportLandingPageId]);

  useEffect(() => {
    if ((!ready && !publicReadOnly) || !syntheticImportLandingPageId) return;
    router.replace(
      publicReadOnly && sharedToken
        ? sharedPageHref(sharedToken, syntheticImportLandingPageId)
        : pageHref(syntheticImportLandingPageId)
    );
  }, [publicReadOnly, ready, router, sharedToken, syntheticImportLandingPageId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "f") return;
      if ((!ready && !publicReadOnly) || !page || page.inTrash) return;
      e.preventDefault();
      setFindInitialQuery(selectedTextForPageFind(docRef.current));
      setFindOpen(true);
      setFindFocusTick((tick) => tick + 1);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [page, publicReadOnly, ready]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setFindOpen(false));
    return () => window.cancelAnimationFrame(frame);
  }, [pageId]);

  useEffect(() => {
    if (!blocksLoaded) return;
    let clearTimer: number | undefined;
    let frame: number | undefined;

    function expandBlockAncestors(blockId: string) {
      const st = useStore.getState();
      const blocks = st.blocksByPage[pageId] ?? [];
      const byId = new Map(blocks.map((block) => [block.id, block]));
      let current = byId.get(blockId);
      while (current?.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent) break;
        if (TOGGLE_BLOCK_TYPES.has(parent.type) && parent.content?.collapsed) {
          st.updateBlock(
            parent.id,
            { content: { ...parent.content, collapsed: false } },
            { history: false }
          );
        }
        current = parent;
      }
    }

    function blockIdForComment(commentId: string) {
      const st = useStore.getState();
      const comments = st.commentsByPage[pageId] ?? [];
      const comment = comments.find((item) => item.id === commentId);
      if (!comment) return "";
      if (comment.blockId) return comment.blockId;
      if (!comment.parentId) return "";
      return comments.find((item) => item.id === comment.parentId)?.blockId ?? "";
    }

    function scrollToHashTarget() {
      const id = currentHashTargetId();
      const isBlockHash = id.startsWith(HASH_BLOCK_PREFIX);
      const isCommentHash = id.startsWith(HASH_COMMENT_PREFIX);
      if (!isBlockHash && !isCommentHash) return;

      const blockId = isBlockHash
        ? id.slice(HASH_BLOCK_PREFIX.length)
        : blockIdForComment(id.slice(HASH_COMMENT_PREFIX.length));
      if (blockId) {
        expandBlockAncestors(blockId);
      }

      function scrollWhenRendered(attempt = 0) {
        const commentId = isCommentHash ? id.slice(HASH_COMMENT_PREFIX.length) : "";
        const target =
          (commentId
            ? docRef.current?.querySelector<HTMLElement>(
                `[data-comment-id="${CSS.escape(commentId)}"]`
              )
            : null) ??
          (blockId ? document.getElementById(`${HASH_BLOCK_PREFIX}${blockId}`) : null);
        if (!target) {
          if (attempt < 6) frame = window.requestAnimationFrame(() => scrollWhenRendered(attempt + 1));
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

    scrollToHashTarget();
    window.addEventListener("hashchange", scrollToHashTarget);
    return () => {
      window.removeEventListener("hashchange", scrollToHashTarget);
      if (frame) window.cancelAnimationFrame(frame);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [blocksLoaded, commentsLoaded, pageId]);

  async function restoreCurrentPage() {
    const labels = pickLabels(PAGE_VIEW_LABELS);
    try {
      await restorePage(pageId);
      notify(labels.restoredPage, "success");
    } catch {
      notify(labels.couldntRestorePage, "error");
    }
  }

  if (!ready && !publicReadOnly) return null;

  if (syntheticImportLandingPageId) return null;

  if (!page) {
    const labels = pickLabels(PAGE_VIEW_LABELS);
    return (
      <>
        <TopBar title={labels.notFoundTopBarTitle} />
        <div className={styles.missing}>
          <strong>{labels.pageUnavailable}</strong>
          <p>{labels.pageUnavailableDetail}</p>
          <div className={styles.missingActions}>
            <button type="button" className={styles.restoreButton} onClick={() => router.push("/")}>
              {labels.openWorkspace}
            </button>
          </div>
        </div>
      </>
    );
  }

  if (blocksDeniedPageId === pageId && !blocksLoaded) {
    const labels = pickLabels(PAGE_VIEW_LABELS);
    return (
      <>
        <TopBar title={labels.notFoundTopBarTitle} />
        <div className={styles.missing}>
          <strong>{labels.pageUnavailable}</strong>
          <p>{labels.pageUnavailableDetail}</p>
          <div className={styles.missingActions}>
            <button type="button" className={styles.restoreButton} onClick={() => router.push("/")}>
              {labels.openWorkspace}
            </button>
          </div>
        </div>
      </>
    );
  }

  if (page.inTrash) {
    const labels = pickLabels(PAGE_VIEW_LABELS);
    return (
      <>
        <TopBar title={labels.inTrashTopBarTitle} />
        <div className={styles.missing}>
          <strong>{labels.pageInTrash}</strong>
          <p>{labels.pageInTrashDetail}</p>
          <div className={styles.missingActions}>
            <button
              type="button"
              className={styles.restoreButton}
              onClick={() => void restoreCurrentPage()}
            >
              {labels.restorePage}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar
        {...(publicReadOnly ? { title: pageDisplayTitle(page) } : { pageId })}
        presence={presenceEnabled ? presence : undefined}
        scrolled={topbarScrolled}
      />
      <PageFindBar
        focusTick={findFocusTick}
        initialQuery={findInitialQuery}
        onClose={() => setFindOpen(false)}
        open={findOpen}
        pageId={pageId}
        revision={findRevision}
        rootRef={docRef}
      />
      <PagePresence presence={presence} disabled={!presenceEnabled} />
      <div ref={scrollRef} className={`${styles.scroll} nscroll`} onScroll={onPageScroll}>
        <PageCover pageId={pageId} readOnly={readOnly} />
        <div
          ref={docRef}
          className={styles.doc}
          data-page-search-root
          data-has-cover={!!page.cover}
          data-kind={page.kind}
          data-font={page.font ?? "default"}
          data-small-text={page.smallText ? "true" : "false"}
          data-full-width={page.fullWidth ? "true" : "false"}
          data-public-read-only={publicReadOnly ? "true" : undefined}
          data-row-page={rowDatabaseId ? "true" : undefined}
          data-has-wide-root-content={hasWideRootContent ? "true" : "false"}
          data-has-root-column-list={hasRootColumnList ? "true" : "false"}
          data-has-inline-database={hasRootInlineDatabase ? "true" : "false"}
        >
          <PageHeader pageId={pageId} readOnly={readOnly} publicReadOnly={publicReadOnly} canComment={canComment} />
          <ErrorBoundary scope="page-content" key={pageId}>
            <Suspense fallback={<ContentFallback />}>
            {page.kind === "database" ? (
              <DatabaseView
                db={page}
                skipRemoteLoad={publicReadOnly}
                readOnly={readOnly}
                publicReadOnly={publicReadOnly}
                sharedToken={sharedToken}
                publishAwareness={publishPageViewAwareness}
                remoteAwarenessByBlock={remoteAwarenessByBlock}
              />
            ) : (
              <>
                {rowDatabaseId && (
                  <RowProperties
                    dbId={rowDatabaseId}
                    row={page}
                    view={rowDetailView ?? undefined}
                    readOnly={readOnly}
                    onOpenPage={(targetPageId) =>
                      router.push(
                        publicReadOnly && sharedToken
                          ? sharedPageHref(sharedToken, targetPageId)
                          : pageHref(targetPageId)
                      )
                    }
                    pageHrefForRelation={(targetPageId) =>
                      publicReadOnly && sharedToken
                        ? sharedPageHref(sharedToken, targetPageId)
                        : pageHref(targetPageId)
                    }
                    relationNavigation={!publicReadOnly}
                    showBackReferences={false}
                    showPropertyControls={false}
                  />
                )}
                <Editor
                  pageId={pageId}
                  collaborationStatus={presence.status}
                  readOnly={readOnly}
                  canComment={canComment}
                  publicReadOnly={publicReadOnly}
                  sharedToken={sharedToken}
                  remoteAwareness={presence.awareness}
                  showPageStarter={!rowDatabaseId}
                  emptyBodyPrompt={
                    rowDatabaseId && !publicReadOnly
                      ? pickLabels(PAGE_VIEW_LABELS).emptyBodyPrompt
                      : undefined
                  }
                  skipRemoteLoad={publicReadOnly}
                />
              </>
            )}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </>
  );
}
