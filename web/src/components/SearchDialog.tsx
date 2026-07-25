"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageHref } from "@/lib/navigation";
import { pagePath, pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { canCreateWorkspacePage } from "@/lib/permissions";
import type { Block, Page } from "@/lib/types";
import { searchBlocksRemote } from "@/lib/edgebase";
import { searchCachedBlockHits } from "@/lib/localSearch";
import { canonicalTextRanges } from "@/lib/textMatch";
import { useStore } from "@/lib/store";
import { useTranslation } from "react-i18next";
import { relativeEditedLabel, relativeTimeLabels } from "@/lib/relativeTime";
import { Plus, Search, StarFilled } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import { VerificationBadge } from "./VerificationBadge";
import styles from "./SearchDialog.module.css";
import { foldNfcText } from "../../../shared/database/natural-order.mjs";

const LIST_NAVIGATION_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];
const RECENT_SEARCH_KEY = "hanji:quick-find:recent-searches";
const RECENT_SEARCH_LIMIT = 6;
// Remote content search is debounced and only fires for queries this long;
// local title matching stays instant on every keystroke.
const REMOTE_SEARCH_MIN_LENGTH = 2;
const REMOTE_SEARCH_DEBOUNCE_MS = 220;
const MAX_RESULTS = 12;
// When content (block) hits exist, cap title hits so content results are
// never fully crowded out of the 12-slot list.
const MAX_TITLE_HITS_WITH_CONTENT = 8;

type SearchHit =
  | {
      kind: "page";
      page: Page;
      path: string;
      score: number;
    }
  | {
      kind: "block";
      page: Page;
      block: Block;
      path: string;
      preview: string;
      score: number;
    };

type SearchSection = {
  label: string;
  detail?: string;
  hits: SearchHit[];
};

interface BodyHit {
  page: Page;
  block: Block;
  preview: string;
}

function labelOf(page: Page) {
  return pageDisplayTitle(page);
}

function normalizedSearchQuery(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function readRecentSearches() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_SEARCH_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const next: string[] = [];
    for (const item of parsed) {
      const query = normalizedSearchQuery(String(item));
      const key = foldNfcText(query);
      if (!query || seen.has(key)) continue;
      seen.add(key);
      next.push(query);
      if (next.length >= RECENT_SEARCH_LIMIT) break;
    }
    return next;
  } catch {
    return [];
  }
}

function writeRecentSearches(searches: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(searches));
  } catch {
    // Local storage can be unavailable in private browsing or restricted embeds.
  }
}

function withRecentSearch(searches: string[], query: string) {
  const queryKey = foldNfcText(query);
  return [
    query,
    ...searches.filter((item) => foldNfcText(item) !== queryKey),
  ].slice(0, RECENT_SEARCH_LIMIT);
}

function blockPlainText(block: Block) {
  return (
    block.plainText ??
    block.content?.rich?.map((span) => span.text).join("") ??
    ""
  ).trim();
}

function isRemoteSearchNetworkError(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.code === 0 || record.status === 0 || record.slug === "network-error";
}

function yieldRemoteSearch() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function timeValue(page: Page) {
  return Date.parse(page.updatedAt ?? page.createdAt ?? "") || 0;
}

function editedLabel(page: Page) {
  // Shared localized helper; unparseable/missing stamps fall back to the
  // "No edits" label like the old inline implementation.
  return (
    relativeEditedLabel(page.updatedAt ?? page.createdAt) || relativeTimeLabels().noEdits
  );
}

function score(page: Page, path: string, query: string) {
  if (!query) return page.isFavorite ? 0 : 10;
  const title = foldNfcText(labelOf(page));
  const haystack = `${title} ${foldNfcText(path)}`;
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  if (haystack.includes(query)) return 3;
  return Number.POSITIVE_INFINITY;
}

function hitHref(hit: SearchHit) {
  const hash = hit.kind === "block" ? `#block-${encodeURIComponent(hit.block.id)}` : "";
  return `${pageHref(hit.page.id)}${hash}`;
}

function hitKey(hit: SearchHit) {
  return hit.kind === "page" ? `page:${hit.page.id}` : `block:${hit.page.id}:${hit.block.id}`;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const ranges = canonicalTextRanges(text, needle);
  if (!ranges.length) return <>{text}</>;
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), match: false });
    parts.push({ text: text.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={`${part.text}-${index}`} className={styles.match}>
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </>
  );
}

export function SearchDialog() {
  const { t } = useTranslation(["searchDialog", "common"]);
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pointerMoved = useRef(false);
  const dialogId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [bodyHits, setBodyHits] = useState<BodyHit[]>([]);
  const [searchingBody, setSearchingBody] = useState(false);
  const [creatingPage, setCreatingPage] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(readRecentSearches);
  const {
    open,
    pagesById,
    recentPageIds,
    setSearchOpen,
    createPage,
    notify,
    workspace,
    currentMember,
    userId,
  } = useStore(
    useShallow((s) => ({
      open: s.searchOpen,
      pagesById: s.pagesById,
      recentPageIds: s.recentPageIds,
      setSearchOpen: s.setSearchOpen,
      createPage: s.createPage,
      notify: s.notify,
      workspace: s.workspace,
      currentMember: s.currentMember,
      userId: s.userId,
    }))
  );
  const canCreateRootPage = canCreateWorkspacePage({ workspace, currentMember, userId });

  const recentOrder = useMemo(
    () => new Map(recentPageIds.map((id, index) => [id, index])),
    [recentPageIds]
  );

  const localPageHits = useMemo<SearchHit[]>(() => {
    const workspaceId = workspace?.id?.trim();
    if (!workspaceId) return [];
    const q = foldNfcText(query.trim());
    return Object.values(pagesById)
      .filter(
        (page) =>
          !page.inTrash && page.workspaceId === workspaceId
      )
      .map((page) => {
        const path = pagePath(page, pagesById);
        return { kind: "page" as const, page, path, score: score(page, path, q) };
      })
      .filter((hit) => hit.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => {
        if (!q) {
          const aRecent = recentOrder.get(a.page.id);
          const bRecent = recentOrder.get(b.page.id);
          if (aRecent !== undefined || bRecent !== undefined) {
            return (aRecent ?? Number.POSITIVE_INFINITY) - (bRecent ?? Number.POSITIVE_INFINITY);
          }
        }
        if (a.score !== b.score) return a.score - b.score;
        if (!!b.page.isFavorite !== !!a.page.isFavorite) {
          return b.page.isFavorite ? 1 : -1;
        }
        return timeValue(b.page) - timeValue(a.page) || a.page.position - b.page.position;
      })
      .slice(0, MAX_RESULTS);
  }, [pagesById, query, recentOrder, workspace?.id]);

  const hits = useMemo<SearchHit[]>(() => {
    if (!query.trim()) return localPageHits;

    const pageHitIds = new Set(localPageHits.map((hit) => hit.page.id));
    const blockResults: SearchHit[] = bodyHits
      .filter(
        (hit) =>
          !hit.page.inTrash && !!workspace?.id && hit.page.workspaceId === workspace.id
      )
      .map((hit, index) => ({
        kind: "block" as const,
        page: hit.page,
        block: hit.block,
        path: pagePath(hit.page, pagesById),
        preview: hit.preview,
        score: pageHitIds.has(hit.page.id) ? 4 + index / 100 : 3 + index / 100,
      }));

    // Reserve slots for content hits: when block results exist, cap title
    // hits so at least a few content results always survive the total cap.
    const cappedPageHits = blockResults.length
      ? localPageHits.slice(0, MAX_TITLE_HITS_WITH_CONTENT)
      : localPageHits;

    return [...cappedPageHits, ...blockResults]
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return timeValue(b.page) - timeValue(a.page);
      })
      .slice(0, MAX_RESULTS);
  }, [bodyHits, localPageHits, pagesById, query, workspace?.id]);

  const sections = useMemo<SearchSection[]>(() => {
    const q = query.trim();
    if (q) {
      const pageHits = hits.filter((hit) => hit.kind === "page");
      const contentHits = hits.filter((hit) => hit.kind === "block");
      const next: SearchSection[] = [];
      if (pageHits.length) {
        next.push({
          label: t("searchDialog:sections.pages"),
          hits: pageHits,
        });
      }
      if (contentHits.length || searchingBody) {
        next.push({
          label: t("searchDialog:sections.pageContent"),
          detail: searchingBody ? t("searchDialog:searchingDetail") : undefined,
          hits: contentHits,
        });
      }
      return next;
    }

    const recentHits = hits.filter((hit) => recentOrder.has(hit.page.id));
    const recentIds = new Set(recentHits.map((hit) => hit.page.id));
    const favoriteHits = hits.filter((hit) => hit.page.isFavorite && !recentIds.has(hit.page.id));
    const favoriteIds = new Set(favoriteHits.map((hit) => hit.page.id));
    const pageHits = hits.filter(
      (hit) => !recentIds.has(hit.page.id) && !favoriteIds.has(hit.page.id)
    );

    const next: SearchSection[] = [];
    if (recentHits.length) {
      next.push({
        label: t("searchDialog:sections.recentlyViewed"),
        hits: recentHits,
      });
    }
    if (favoriteHits.length) {
      next.push({
        label: t("searchDialog:sections.favorites"),
        hits: favoriteHits,
      });
    }
    if (pageHits.length) {
      next.push({
        label: t("searchDialog:sections.pages"),
        hits: pageHits,
      });
    }
    return next;
  }, [hits, query, recentOrder, searchingBody, t]);

  const hitIndex = useMemo(() => {
    const indexes = new Map<string, number>();
    hits.forEach((hit, index) => {
      indexes.set(hitKey(hit), index);
    });
    return indexes;
  }, [hits]);

  const trimmedQuery = query.trim();
  const exactPageMatch = trimmedQuery
    ? Object.values(pagesById).some(
        (page) =>
          !page.inTrash &&
          foldNfcText(labelOf(page).trim()) === foldNfcText(trimmedQuery)
      )
    : false;
  const showCreate = canCreateRootPage && trimmedQuery.length > 0 && !exactPageMatch;
  const visibleRecentSearches = trimmedQuery ? [] : recentSearches;
  const recentSearchStart = hits.length;
  const createIndex = hits.length + visibleRecentSearches.length;
  const itemCount = createIndex + (showCreate ? 1 : 0);
  const safeActive = itemCount === 0 ? -1 : Math.max(0, Math.min(active, itemCount - 1));
  const titleId = `${dialogId}-title`;
  const resultsId = `${dialogId}-results`;
  const activeId =
    safeActive < 0
      ? undefined
      : safeActive < hits.length
      ? `${dialogId}-result-${safeActive}`
      : safeActive < createIndex
      ? `${dialogId}-recent-search-${safeActive - recentSearchStart}`
      : safeActive === createIndex
      ? `${dialogId}-new-page`
      : undefined;

  const rememberSearch = useCallback((value: string) => {
    const nextQuery = normalizedSearchQuery(value);
    if (!nextQuery) return;
    const stored = withRecentSearch(readRecentSearches(), nextQuery);
    writeRecentSearches(stored);
    setRecentSearches((current) => withRecentSearch(current, nextQuery));
  }, []);

  const close = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setActive(0);
    setBodyHits([]);
    setSearchingBody(false);
    window.requestAnimationFrame(() => {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    });
  }, [setSearchOpen]);

  const openHit = useCallback((hit: SearchHit) => {
    rememberSearch(inputRef.current?.value ?? query);
    router.push(hitHref(hit));
    close();
  }, [close, query, rememberSearch, router]);

  const openHitInNewTab = useCallback((hit: SearchHit) => {
    rememberSearch(inputRef.current?.value ?? query);
    window.open(hitHref(hit), "_blank", "noopener,noreferrer");
    close();
  }, [close, query, rememberSearch]);

  const applyRecentSearch = useCallback((value: string) => {
    setQuery(value);
    setActive(0);
    setBodyHits([]);
    setSearchingBody(value.trim().length >= REMOTE_SEARCH_MIN_LENGTH);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const newPage = useCallback(async (openInNewTab = false) => {
    const title = (inputRef.current?.value ?? query).trim();
    if (!title || creatingPage || !canCreateRootPage) return;
    const newWindow = openInNewTab ? window.open("about:blank", "_blank") : null;
    setCreatingPage(true);
    const roots = Object.values(pagesById)
      .filter((p) => !p.inTrash && (p.parentType === "workspace" || p.parentId == null))
      .sort((a, b) => a.position - b.position);
    try {
      const page = await createPage({
        parentId: null,
        parentType: "workspace",
        title,
        afterPosition: roots[roots.length - 1]?.position,
        focusTarget: "body",
      });
      const href = pageHref(page.id);
      if (newWindow) {
        newWindow.opener = null;
        newWindow.location.href = href;
      } else {
        router.push(href);
      }
      rememberSearch(title);
      close();
    } catch (error) {
      newWindow?.close();
      notify(
        error instanceof Error ? error.message : t("searchDialog:couldntCreatePage"),
        "error"
      );
    } finally {
      setCreatingPage(false);
    }
  }, [canCreateRootPage, close, createPage, creatingPage, notify, pagesById, query, rememberSearch, router, t]);

  function dialogFocusables() {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([type="hidden"]):not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;

    if (e.key === "Tab") {
      const focusables = dialogFocusables();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    if (itemCount === 0) return;

    if (LIST_NAVIGATION_KEYS.includes(e.key)) {
      pointerMoved.current = false;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setActive((i) => (Math.max(i, 0) + 1) % itemCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setActive((i) => (i <= 0 ? itemCount - 1 : i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setActive(itemCount - 1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      e.stopPropagation();
      setActive((i) => Math.min(Math.max(i, 0) + 5, itemCount - 1));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      e.stopPropagation();
      setActive((i) => Math.max(i - 5, 0));
    } else if (e.key === "Enter" && !isComposingKeyEvent(e)) {
      e.preventDefault();
      e.stopPropagation();
      const hit = hits[safeActive];
      const recentSearch =
        safeActive >= recentSearchStart && safeActive < createIndex
          ? visibleRecentSearches[safeActive - recentSearchStart]
          : undefined;
      if (hit && (e.metaKey || e.ctrlKey)) openHitInNewTab(hit);
      else if (hit) openHit(hit);
      else if (recentSearch) applyRecentSearch(recentSearch);
      else if (showCreate) void newPage(e.metaKey || e.ctrlKey);
    }
  }

  useEffect(() => {
    if (!open) return;
    pointerMoved.current = false;
    setRecentSearches(readRecentSearches());
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onMove() {
      pointerMoved.current = true;
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [open]);

  useEffect(() => {
    if (!open || safeActive < 0 || safeActive === createIndex) return;
    resultsRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [createIndex, open, safeActive, hits.length]);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < REMOTE_SEARCH_MIN_LENGTH) {
      return;
    }
    const workspaceId = workspace?.id?.trim() ?? "";
    if (!workspaceId) {
      setBodyHits([]);
      setSearchingBody(false);
      return;
    }

    // Debounce the remote dispatch so fast typing doesn't fire a request per
    // keystroke; the cleanup below also discards stale in-flight responses
    // once the query has moved on. `pagesById` is intentionally read via
    // `useStore.getState()` at response time so unrelated store updates don't
    // re-run the search.
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const applyCachedHits = async () => {
        try {
          const localHits = await searchCachedBlockHits(userId ?? "", q, 8);
          if (cancelled) return;
          const currentPages = useStore.getState().pagesById;
          const next: BodyHit[] = [];
          for (const hit of localHits) {
            const page = currentPages[hit.pageId];
            if (!page || page.inTrash || (workspaceId && page.workspaceId !== workspaceId)) continue;
            const preview = blockPlainText(hit.block);
            if (!preview) continue;
            next.push({ page, block: hit.block, preview });
          }
          setBodyHits(next);
        } catch {
          if (!cancelled) setBodyHits([]);
        }
      };
      const finishSearch = () => {
        if (!cancelled) setSearchingBody(false);
      };

      const runRemoteSearch = async () => {
        const seenBlocks = new Set<string>();
        const seenCursors = new Set<string>();
        const remotePages = new Map<string, Page>();
        const next: BodyHit[] = [];
        let sourceCursor: string | undefined;
        let completedRequest = false;
        try {
          while (!cancelled && next.length < 8) {
            const res = await searchBlocksRemote(q, 20, workspaceId, {
              ...(sourceCursor ? { sourceCursor } : {}),
              signal: controller.signal,
            });
            completedRequest = true;
            for (const page of res.pages ?? []) {
              if (page.workspaceId === workspaceId) remotePages.set(page.id, page);
            }
            const currentPages = useStore.getState().pagesById;
            for (const block of res.blocks) {
              if (seenBlocks.has(block.id)) continue;
              const page = remotePages.get(block.pageId) ?? currentPages[block.pageId];
              if (!page || page.inTrash || page.workspaceId !== workspaceId) continue;
              const preview = blockPlainText(block);
              if (!preview) continue;
              seenBlocks.add(block.id);
              next.push({ page, block, preview });
              if (next.length >= 8) break;
            }
            if (cancelled) return;
            setBodyHits([...next]);
            if (next.length >= 8 || res.hasMore !== true) return;
            if (!res.nextCursor || seenCursors.has(res.nextCursor)) {
              throw new Error("Block search continuation did not advance.");
            }
            seenCursors.add(res.nextCursor);
            sourceCursor = res.nextCursor;
            await yieldRemoteSearch();
          }
        } catch (error) {
          // Only a transport failure before any server result may fall back to
          // the local record cache. A later failure preserves the verified
          // prefix instead of replacing it with a misleading local snapshot.
          if (!completedRequest && isRemoteSearchNetworkError(error)) {
            await applyCachedHits();
          } else if (!cancelled) {
            setBodyHits([...next]);
          }
        }
      };

      void runRemoteSearch().finally(finishSearch);
    }, REMOTE_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, userId, workspace?.id]);

  if (!open) return null;

  return (
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        onClick={close}
        tabIndex={-1}
        aria-label={t("searchDialog:closeSearch")}
      />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onDialogKeyDown}
      >
        <div id={titleId} className={styles.srOnly}>{t("searchDialog:quickFind")}</div>
        <div className={styles.searchRow}>
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            aria-label={t("searchDialog:quickFind")}
            role="combobox"
            aria-expanded="true"
            aria-controls={resultsId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder={t("searchDialog:searchPlaceholder")}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              setActive(0);
              setBodyHits([]);
              setSearchingBody(next.trim().length >= REMOTE_SEARCH_MIN_LENGTH);
            }}
          />
        </div>

        <div
          id={resultsId}
          className={styles.listbox}
          role="listbox"
          aria-label={t("searchDialog:quickFindResults")}
        >
          <div className={styles.results} ref={resultsRef}>
            {sections.map((section) => (
              <section key={section.label} className={styles.section}>
                <div className={styles.groupLabel}>
                  {section.label}
                  {section.detail && <span>{section.detail}</span>}
                </div>
                {section.hits.map((hit) => {
                  const index = hitIndex.get(hitKey(hit));
                  if (index === undefined) return null;
                  return (
                    <button
                      type="button"
                      key={hitKey(hit)}
                      id={`${dialogId}-result-${index}`}
                      className={styles.result}
                      role="option"
                      aria-selected={index === safeActive}
                      data-active={index === safeActive ? "true" : undefined}
                      data-kind={hit.kind}
                      onMouseEnter={() => {
                        if (pointerMoved.current) setActive(index);
                      }}
                      onFocus={() => setActive(index)}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) openHitInNewTab(hit);
                        else openHit(hit);
                      }}
                    >
                      <span className={styles.pageIcon}>
                        <PageIconGlyph page={hit.page} size={18} />
                      </span>
                      <span className={styles.resultText}>
                        <span className={styles.resultTitle}>
                          <HighlightedText text={labelOf(hit.page)} query={query} />
                          {hit.page.isFavorite && <StarFilled size={12} aria-hidden="true" />}
                          <VerificationBadge page={hit.page} />
                          {hit.kind === "block" && (
                            <span className={styles.resultBadge}>{t("searchDialog:inPage")}</span>
                          )}
                        </span>
                        <span className={styles.resultMeta}>
                          <span className={styles.resultPath}>
                            <HighlightedText text={pagePathOrWorkspaceRoot(hit.page, pagesById)} query={query} />
                          </span>
                          <span className={styles.resultTime}>{editedLabel(hit.page)}</span>
                        </span>
                        {hit.kind === "block" && (
                          <span className={styles.resultPreview}>
                            <HighlightedText text={hit.preview} query={query} />
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}

            {visibleRecentSearches.length > 0 && (
              <section className={styles.section}>
                <div className={styles.groupLabel}>{t("searchDialog:sections.recentSearches")}</div>
                {visibleRecentSearches.map((recentSearch, index) => {
                  const optionIndex = recentSearchStart + index;
                  return (
                    <button
                      type="button"
                      key={recentSearch}
                      id={`${dialogId}-recent-search-${index}`}
                      className={styles.result}
                      role="option"
                      aria-selected={optionIndex === safeActive}
                      data-active={optionIndex === safeActive ? "true" : undefined}
                      data-kind="search"
                      onMouseEnter={() => {
                        if (pointerMoved.current) setActive(optionIndex);
                      }}
                      onFocus={() => setActive(optionIndex)}
                      onClick={() => applyRecentSearch(recentSearch)}
                    >
                      <span className={styles.pageIcon}>
                        <Search size={17} aria-hidden="true" />
                      </span>
                      <span className={styles.resultText}>
                        <span className={styles.resultTitle}>{recentSearch}</span>
                        <span className={styles.resultMeta}>
                          <span className={styles.resultPath}>{t("searchDialog:searchAgain")}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            )}

            {hits.length === 0 && visibleRecentSearches.length === 0 && (
              <div className={styles.empty} role="status">
                {searchingBody
                  ? t("searchDialog:searchingPageContent")
                  : trimmedQuery
                    ? t("searchDialog:noResultsFor", { query: trimmedQuery })
                    : t("searchDialog:noPagesFound")}
              </div>
            )}
          </div>

          <div className={styles.footer} data-has-create={showCreate ? "true" : "false"}>
            {showCreate && (
              <button
                type="button"
                id={`${dialogId}-new-page`}
                className={styles.newPage}
                role="option"
                aria-selected={safeActive === createIndex}
                data-active={safeActive === createIndex ? "true" : undefined}
                disabled={creatingPage}
                onMouseEnter={() => {
                  if (pointerMoved.current) setActive(createIndex);
                }}
                onFocus={() => setActive(createIndex)}
                onClick={(e) => void newPage(e.metaKey || e.ctrlKey)}
              >
                <Plus size={16} aria-hidden="true" />
                <span>{creatingPage ? t("searchDialog:creating") : t("searchDialog:newPage", { query: trimmedQuery })}</span>
              </button>
            )}
            <div className={styles.hints} aria-hidden="true">
              <span><kbd>↑↓</kbd> {t("searchDialog:hints.select")}</span>
              <span><kbd>Enter</kbd> {t("searchDialog:hints.open")}</span>
              <span><kbd>⌘</kbd><kbd>Enter</kbd> {t("searchDialog:hints.newTab")}</span>
              <span><kbd>Esc</kbd> {t("common:actions.close")}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
