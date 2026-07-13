"use client";

import { lazy, Suspense, type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isPublicSharePath, routeInfoFromPath, usePathname, useRouter } from "@/lib/router";
import { copyText } from "@/lib/clipboard";
import { useTranslation } from "react-i18next";
import { absolutePageUrl, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { flushAllPending, handleLocalUnlock, readLastUserId, useStore } from "@/lib/store";
import { resolveTheme, useTheme } from "@/lib/theme";
import LocalLockGate from "./LocalLockGate";
import { Sidebar } from "./Sidebar";
import SyncStatusBadge from "./SyncStatusBadge";
import { ToastStack } from "./ToastStack";
import styles from "./AppShell.module.css";

const CommentsPanel = lazy(() =>
  import("./CommentsPanel").then(({ CommentsPanel }) => ({ default: CommentsPanel }))
);
const MoveToDialog = lazy(() =>
  import("./MoveToDialog").then(({ MoveToDialog }) => ({ default: MoveToDialog }))
);
const SearchDialog = lazy(() =>
  import("./SearchDialog").then(({ SearchDialog }) => ({ default: SearchDialog }))
);

const SIDEBAR_WIDTH_KEY = "hanji:sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "hanji:sidebar-collapsed";
const LEGACY_DEFAULT_SIDEBAR_WIDTH = 240;
const DEFAULT_SIDEBAR_WIDTH = 270;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 480;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function isTextEntryTarget(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target : null;
  return !!(
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable)
  );
}

function pageIdFromPath(pathname: string) {
  const route = routeInfoFromPath(pathname);
  if (route.kind === "page") return route.pageId;
  if (route.kind === "database") return route.databaseId;
  return undefined;
}

function workspaceSlugFromPath(pathname: string) {
  const route = routeInfoFromPath(pathname);
  return route.kind === "workspace" ? route.workspaceSlug : undefined;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation(["appShell", "common"]);
  const router = useRouter();
  const ready = useStore((s) => s.ready);
  const bootstrap = useStore((s) => s.bootstrap);
  const refreshPageAccess = useStore((s) => s.refreshPageAccess);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const searchOpen = useStore((s) => s.searchOpen);
  const commentPanel = useStore((s) => s.commentPanel);
  const updatesOpen = useStore((s) => s.updatesOpen);
  const pagesById = useStore((s) => s.pagesById);
  const userId = useStore((s) => s.userId);
  // The lock gate must be able to appear BEFORE bootstrap resolves a user
  // (offline boots), so fall back to the remembered id.
  const lockGateUserId = userId || readLastUserId();
  const notify = useStore((s) => s.notify);
  const closeComments = useStore((s) => s.closeComments);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const setUpdatesOpen = useStore((s) => s.setUpdatesOpen);
  const [themePref, setThemePref] = useTheme();
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveDialogPageId, setMoveDialogPageId] = useState<string | null>(null);
  const pathname = usePathname();
  const publicShareRoute = isPublicSharePath(pathname);
  const workspaceSlug = workspaceSlugFromPath(pathname);
  const activePageId = pageIdFromPath(pathname);
  const mainRef = useRef<HTMLElement>(null);
  const previousPathnameRef = useRef(pathname);
  const navigationCleanupPathnameRef = useRef(pathname);

  async function retryWorkspaceLoad() {
    setError(null);
    try {
      await bootstrap({ workspaceSlug, pageId: activePageId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Local lock unlocked mid-session: hydration/claims that were skipped while
  // the gate was pending resume here (restart boot when it ran locked, else
  // replay + warm).
  async function resumeAfterUnlock() {
    try {
      await handleLocalUnlock({ workspaceSlug, pageId: activePageId });
      setError(null);
    } catch (e) {
      if (!useStore.getState().ready) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  useEffect(() => {
    if (publicShareRoute) return;
    let mounted = true;
    bootstrap({ workspaceSlug, pageId: activePageId }).catch((e) => {
      if (mounted) setError(e instanceof Error ? e.message : String(e));
    });
    const flush = () => void flushAllPending();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      mounted = false;
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      void flushAllPending();
    };
  }, [activePageId, bootstrap, publicShareRoute, workspaceSlug]);

  useEffect(() => {
    if (publicShareRoute || !activePageId) return;
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRefresh < 5000) return;
      lastRefresh = now;
      refreshPageAccess(activePageId).catch(() => {});
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activePageId, publicShareRoute, refreshPageAccess]);

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    const frame = window.requestAnimationFrame(() => {
      const main = mainRef.current;
      if (!main || main.inert) return;
      main.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);


  // Track mobile breakpoint to switch the sidebar between push (desktop) and
  // overlay-drawer (mobile) behavior — like Notion.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
      const width = raw ? Number(raw) : NaN;
      if (Number.isFinite(width)) {
        const nextWidth = width === LEGACY_DEFAULT_SIDEBAR_WIDTH ? DEFAULT_SIDEBAR_WIDTH : width;
        setSidebarWidth(clampSidebarWidth(nextWidth));
        if (nextWidth !== width) window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
      }
      setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [setSidebarCollapsed]);

  // Persist + toggle the desktop collapsed state in one place.
  const toggleCollapsed = useCallback(() => {
    const next = !sidebarCollapsed;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
    setSidebarCollapsed(next);
  }, [setSidebarCollapsed, sidebarCollapsed]);

  // Close transient panels after an actual navigation. On the first mount this
  // effect can run after a user has already opened Inbox, especially on a
  // slower freshly-authenticated runtime; do not treat that initial render as
  // navigation and immediately close the panel again.
  useLayoutEffect(() => {
    if (navigationCleanupPathnameRef.current === pathname) return;
    navigationCleanupPathnameRef.current = pathname;
    setSidebarOpen(false);
    closeComments();
    setUpdatesOpen(false);
    const frame = window.requestAnimationFrame(() => setMoveDialogPageId(null));
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, setSidebarOpen, closeComments, setUpdatesOpen]);

  // Keep the two right-side panels mutually exclusive so they never stack on
  // top of each other: whichever was opened most recently wins.
  const prevUpdatesOpen = useRef(false);
  useEffect(() => {
    const justOpenedUpdates = updatesOpen && !prevUpdatesOpen.current;
    prevUpdatesOpen.current = updatesOpen;
    if (commentPanel && updatesOpen) {
      if (justOpenedUpdates) closeComments();
      else setUpdatesOpen(false);
    }
  }, [commentPanel, updatesOpen, closeComments, setUpdatesOpen]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (publicShareRoute) return;
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      if (
        mod &&
        !e.shiftKey &&
        !e.altKey &&
        !e.repeat &&
        (key === "[" || key === "]" || e.code === "BracketLeft" || e.code === "BracketRight")
      ) {
        e.preventDefault();
        if (key === "[" || e.code === "BracketLeft") router.back();
        else router.forward();
      } else if (mod && !e.shiftKey && !e.altKey && (key === "k" || key === "p")) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && !e.shiftKey && !e.altKey && !e.repeat && key === "l") {
        const activePageId = pageIdFromPath(pathname);
        const activePage = activePageId ? pagesById[activePageId] : undefined;
        if (!activePage || activePage.inTrash) return;
        e.preventDefault();
        const url = absolutePageUrl(activePage.id, { preserveCurrentSearch: true, omitSearchParams: ["p", "pm"] });
        void copyText(url).then((ok) => {
          notify(ok ? t("appShell:copiedLink") : t("appShell:couldntCopyLink"), ok ? "success" : "error");
        });
      } else if (mod && e.shiftKey && !e.altKey && key === "l") {
        e.preventDefault();
        const next = resolveTheme(themePref) === "dark" ? "light" : "dark";
        setThemePref(next);
        notify(next === "dark" ? t("appShell:darkMode") : t("appShell:lightMode"), "success");
      } else if (mod && e.shiftKey && !e.altKey && key === "u") {
        const activePageId = pageIdFromPath(pathname);
        const activePage = activePageId ? pagesById[activePageId] : undefined;
        const parentPage =
          activePage?.parentId &&
          (activePage.parentType === "page" || activePage.parentType === "database")
            ? pagesById[activePage.parentId]
            : undefined;
        if (!parentPage || parentPage.inTrash) return;
        e.preventDefault();
        router.push(pageHref(parentPage.id));
      } else if (mod && e.shiftKey && !e.altKey && !e.repeat && key === "p") {
        if (isTextEntryTarget(target) || searchOpen || commentPanel || updatesOpen || moveDialogPageId) return;
        const activePageId = pageIdFromPath(pathname);
        const activePage = activePageId ? pagesById[activePageId] : undefined;
        if (!activePage || activePage.inTrash) return;
        e.preventDefault();
        setMoveDialogPageId(activePage.id);
      } else if (mod && !e.altKey && !e.repeat && (e.code === "Backslash" || key === "\\")) {
        // Don't hijack a literal backslash typed inside an editable field.
        if (isTextEntryTarget(target)) return;
        e.preventDefault();
        if (isMobile) setSidebarOpen(!sidebarOpen);
        else toggleCollapsed();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    commentPanel,
    isMobile,
    t,
    notify,
    pagesById,
    pathname,
    publicShareRoute,
    router,
    searchOpen,
    setSearchOpen,
    setSidebarOpen,
    setThemePref,
    sidebarOpen,
    themePref,
    toggleCollapsed,
    updatesOpen,
    moveDialogPageId,
  ]);

  function startSidebarResize(e: React.PointerEvent<HTMLDivElement>) {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let nextWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    setSidebarResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onPointerMove(event: PointerEvent) {
      nextWidth = clampSidebarWidth(startWidth + event.clientX - startX);
      setSidebarWidth(nextWidth);
    }

    function onPointerUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setSidebarResizing(false);
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  function nudgeSidebarWidth(delta: number) {
    setSidebarWidth((current) => {
      const next = clampSidebarWidth(current + delta);
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
      return next;
    });
  }

  function resetSidebarWidth() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  }

  if (error && !publicShareRoute) {
    const workspaceRouteError =
      !!workspaceSlug &&
      /workspace url|workspace access/i.test(error);
    const pageRouteError =
      !!activePageId &&
      /page is unavailable|page access|access to this page|page was not found/i.test(error);
    return (
      <div className={styles.boot}>
        {/* A locked OFFLINE boot lands here (network failed, cache still
            sealed): the unlock gate must stay reachable so unlocking can
            retry the load from the cache. */}
        {lockGateUserId && (
          <LocalLockGate
            key={`error:${lockGateUserId}`}
            userId={lockGateUserId}
            onUnlocked={() => void resumeAfterUnlock()}
          />
        )}
        <div className={styles.bootCard} role="alert" aria-live="assertive" tabIndex={-1}>
          <strong>
            {pageRouteError
              ? t("appShell:pageUnavailable")
              : workspaceRouteError
                ? t("appShell:workspaceUnavailable")
                : t("appShell:somethingWentWrong")}
          </strong>
          <p>{pageRouteError || workspaceRouteError ? error : t("appShell:workspaceLoadTrouble")}</p>
          <div className={styles.bootActions}>
            <button type="button" className={styles.bootButton} onClick={() => void retryWorkspaceLoad()}>
              {t("appShell:tryAgain")}
            </button>
            {workspaceRouteError || pageRouteError ? (
              <button
                type="button"
                className={styles.bootButton}
                onClick={() => {
                  setError(null);
                  router.push("/");
                }}
              >
                {t("appShell:openDefaultWorkspace")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!ready && !publicShareRoute) {
    return (
      <div className={styles.boot} aria-busy="true">
        <div className={styles.bootLoading} role="status">
          <span className={styles.bootSpinner} aria-hidden="true" />
          <span>{t("appShell:loadingWorkspace")}</span>
        </div>
      </div>
    );
  }

  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--sidebar-effective-width": `${
      !publicShareRoute && !isMobile && !sidebarCollapsed ? sidebarWidth : 0
    }px`,
  } as CSSProperties;
  const shellBackgroundInert =
    !publicShareRoute &&
    ((isMobile && sidebarOpen) || searchOpen || !!commentPanel || !!moveDialogPageId);
  const routeLabel = activePageId && pagesById[activePageId]
    ? pageDisplayTitle(pagesById[activePageId])
    : pathname === "/trash"
      ? t("appShell:route.trash")
      : pathname === "/settings" || pathname === "/account"
        ? t("appShell:route.settings")
        : publicShareRoute
          ? t("appShell:route.sharedPage")
          : t("appShell:route.home");

  return (
    <div
      className={styles.shell}
      data-public-share={publicShareRoute ? "true" : undefined}
      style={shellStyle}
    >
      <a className={styles.skipLink} href="#app-main-content">
        {t("appShell:skipToMain")}
      </a>
      {!publicShareRoute &&
        (isMobile ? (
          <Sidebar
            mobile={isMobile}
            open={sidebarOpen}
            collapsed={false}
            resizing={false}
            width={sidebarWidth}
            minWidth={MIN_SIDEBAR_WIDTH}
            maxWidth={MAX_SIDEBAR_WIDTH}
            onResizeStart={startSidebarResize}
            onResizeNudge={nudgeSidebarWidth}
            onResizeReset={resetSidebarWidth}
            onToggle={() => setSidebarOpen(false)}
          />
        ) : (
          <div
            className={styles.sidebarSlot}
            data-sidebar-slot
            data-collapsed={sidebarCollapsed ? "true" : undefined}
            data-resizing={sidebarResizing ? "true" : undefined}
          >
            <Sidebar
              mobile={false}
              open={!sidebarCollapsed}
              collapsed={sidebarCollapsed}
              resizing={sidebarResizing}
              width={sidebarWidth}
              minWidth={MIN_SIDEBAR_WIDTH}
              maxWidth={MAX_SIDEBAR_WIDTH}
              onResizeStart={startSidebarResize}
              onResizeNudge={nudgeSidebarWidth}
              onResizeReset={resetSidebarWidth}
              onToggle={toggleCollapsed}
            />
          </div>
        ))}
      {!publicShareRoute && isMobile && sidebarOpen && (
        <div className={styles.backdrop} aria-hidden="true" onClick={() => setSidebarOpen(false)} />
      )}
      <main
        ref={mainRef}
        id="app-main-content"
        className={`${styles.main} nscroll`}
        data-app-main="true"
        data-shell-inert={shellBackgroundInert ? "true" : undefined}
        inert={shellBackgroundInert ? true : undefined}
        tabIndex={-1}
        aria-label={routeLabel}
      >
        {children}
      </main>
      <span className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {t("appShell:navigationComplete", { destination: routeLabel })}
      </span>
      {!publicShareRoute && <SyncStatusBadge />}
      {!publicShareRoute && lockGateUserId && (
        <LocalLockGate
          key={lockGateUserId}
          userId={lockGateUserId}
          onUnlocked={() => void resumeAfterUnlock()}
        />
      )}
      <Suspense fallback={null}>
        {!publicShareRoute && searchOpen && <SearchDialog />}
        {/* The workspace inbox renders inline inside the sidebar (Notion-style
            page-tree swap) on every breakpoint, including the mobile drawer, so there
            is no floating updates panel here. */}
        {!publicShareRoute && moveDialogPageId && (
          <MoveToDialog
            pageId={moveDialogPageId}
            onClose={() => setMoveDialogPageId(null)}
          />
        )}
        {!publicShareRoute && commentPanel && (
          <CommentsPanel
            key={`${commentPanel.pageId}:${commentPanel.blockId ?? ""}:${commentPanel.activeCommentId ?? ""}:${commentPanel.quote ?? ""}:${commentPanel.quoteStart ?? ""}:${commentPanel.quoteEnd ?? ""}`}
            pageId={commentPanel.pageId}
            blockId={commentPanel.blockId}
            activeCommentId={commentPanel.activeCommentId}
            initialQuote={commentPanel.quote}
            initialQuoteStart={commentPanel.quoteStart}
            initialQuoteEnd={commentPanel.quoteEnd}
            onClose={closeComments}
          />
        )}
      </Suspense>
      <ToastStack />
    </div>
  );
}
