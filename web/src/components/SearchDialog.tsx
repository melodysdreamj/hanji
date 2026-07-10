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
import { useStore } from "@/lib/store";
import { pickLabels } from "@/lib/i18n";
import { relativeEditedLabel, relativeTimeLabels } from "@/lib/relativeTime";
import { Plus, Search, StarFilled } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import styles from "./SearchDialog.module.css";

const SEARCH_DIALOG_LABELS = {
  en: {
    searchPlaceholder: "Search or jump to...",
    quickFind: "Quick Find",
    closeSearch: "Close search",
    quickFindResults: "Quick Find results",
    recentlyViewed: "Recently viewed",
    recentSearches: "Recent searches",
    pages: "Pages",
    pageContent: "Page content",
    favorites: "Favorites",
    inPage: "in page",
    searchingDetail: "Searching...",
    searchAgain: "Search again",
    searchingPageContent: "Searching page content...",
    noResultsFor: (query: string) => `No results for "${query}"`,
    noPagesFound: "No pages found",
    creating: "Creating...",
    newPage: (query: string) => `New page "${query}"`,
    couldntCreatePage: "Couldn't create page",
    hintSelect: "Select",
    hintOpen: "Open",
    hintNewTab: "New tab",
    hintClose: "Close",
  },
  ko: {
    searchPlaceholder: "검색하거나 이동하기...",
    quickFind: "빠른 찾기",
    closeSearch: "검색 닫기",
    quickFindResults: "빠른 찾기 결과",
    recentlyViewed: "최근 본 항목",
    recentSearches: "최근 검색",
    pages: "페이지",
    pageContent: "페이지 내용",
    favorites: "즐겨찾기",
    inPage: "페이지 내",
    searchingDetail: "검색 중...",
    searchAgain: "다시 검색",
    searchingPageContent: "페이지 내용 검색 중...",
    noResultsFor: (query: string) => `"${query}"에 대한 결과가 없어요`,
    noPagesFound: "페이지를 찾을 수 없어요",
    creating: "만드는 중...",
    newPage: (query: string) => `새 페이지 "${query}"`,
    couldntCreatePage: "페이지를 만들지 못했어요",
    hintSelect: "선택",
    hintOpen: "열기",
    hintNewTab: "새 탭",
    hintClose: "닫기",
  },
} as const;

const LIST_NAVIGATION_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];
const RECENT_SEARCH_KEY = "notionlike:quick-find:recent-searches";
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
      const key = query.toLowerCase();
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
  return [
    query,
    ...searches.filter((item) => item.toLowerCase() !== query.toLowerCase()),
  ].slice(0, RECENT_SEARCH_LIMIT);
}

function blockPlainText(block: Block) {
  return (
    block.plainText ??
    block.content?.rich?.map((span) => span.text).join("") ??
    ""
  ).trim();
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
  const title = labelOf(page).toLowerCase();
  const haystack = `${title} ${path.toLowerCase()}`;
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;

  const pattern = new RegExp(`(${escapeRegExp(needle)})`, "ig");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle.toLowerCase() ? (
          <mark key={`${part}-${index}`} className={styles.match}>
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

export function SearchDialog() {
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
    const q = query.trim().toLowerCase();
    return Object.values(pagesById)
      .filter((page) => !page.inTrash)
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
  }, [pagesById, query, recentOrder]);

  const hits = useMemo<SearchHit[]>(() => {
    if (!query.trim()) return localPageHits;

    const pageHitIds = new Set(localPageHits.map((hit) => hit.page.id));
    const blockResults: SearchHit[] = bodyHits
      .filter((hit) => !hit.page.inTrash)
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
  }, [bodyHits, localPageHits, pagesById, query]);

  const sections = useMemo<SearchSection[]>(() => {
    const q = query.trim();
    if (q) {
      const pageHits = hits.filter((hit) => hit.kind === "page");
      const contentHits = hits.filter((hit) => hit.kind === "block");
      const next: SearchSection[] = [];
      if (pageHits.length) {
        next.push({
          label: pickLabels(SEARCH_DIALOG_LABELS).pages,
          hits: pageHits,
        });
      }
      if (contentHits.length || searchingBody) {
        next.push({
          label: pickLabels(SEARCH_DIALOG_LABELS).pageContent,
          detail: searchingBody ? pickLabels(SEARCH_DIALOG_LABELS).searchingDetail : undefined,
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
        label: pickLabels(SEARCH_DIALOG_LABELS).recentlyViewed,
        hits: recentHits,
      });
    }
    if (favoriteHits.length) {
      next.push({
        label: pickLabels(SEARCH_DIALOG_LABELS).favorites,
        hits: favoriteHits,
      });
    }
    if (pageHits.length) {
      next.push({
        label: pickLabels(SEARCH_DIALOG_LABELS).pages,
        hits: pageHits,
      });
    }
    return next;
  }, [hits, query, recentOrder, searchingBody]);

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
          labelOf(page).trim().toLowerCase() === trimmedQuery.toLowerCase()
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
        error instanceof Error ? error.message : pickLabels(SEARCH_DIALOG_LABELS).couldntCreatePage,
        "error"
      );
    } finally {
      setCreatingPage(false);
    }
  }, [canCreateRootPage, close, createPage, creatingPage, notify, pagesById, query, rememberSearch, router]);

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

    // Debounce the remote dispatch so fast typing doesn't fire a request per
    // keystroke; the cleanup below also discards stale in-flight responses
    // once the query has moved on. `pagesById` is intentionally read via
    // `useStore.getState()` at response time so unrelated store updates don't
    // re-run the search.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const currentPages = useStore.getState().pagesById;
      searchBlocksRemote(q, 20)
        .then((res) => {
          if (cancelled) return;
          const seen = new Set<string>();
          const next: BodyHit[] = [];
          for (const block of res.blocks) {
            const page = currentPages[block.pageId];
            if (!page || page.inTrash || seen.has(block.id)) continue;
            const preview = blockPlainText(block);
            if (!preview) continue;
            seen.add(block.id);
            next.push({ page, block, preview });
            if (next.length >= 8) break;
          }
          setBodyHits(next);
        })
        .catch(async () => {
          // Server search unreachable (offline): fall back to the local record
          // cache so quick-find still surfaces block content (local-first §P3).
          try {
            const localHits = await searchCachedBlockHits(userId ?? "", q, 8);
            if (cancelled) return;
            const next: BodyHit[] = [];
            for (const hit of localHits) {
              const page = currentPages[hit.pageId];
              if (!page || page.inTrash) continue;
              const preview = blockPlainText(hit.block);
              if (!preview) continue;
              next.push({ page, block: hit.block, preview });
            }
            setBodyHits(next);
          } catch {
            if (!cancelled) setBodyHits([]);
          }
        })
        .finally(() => {
          if (!cancelled) setSearchingBody(false);
        });
    }, REMOTE_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, userId]);

  if (!open) return null;

  return (
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        onClick={close}
        tabIndex={-1}
        aria-label={pickLabels(SEARCH_DIALOG_LABELS).closeSearch}
      />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onDialogKeyDown}
      >
        <div id={titleId} className={styles.srOnly}>Quick Find</div>
        <div className={styles.searchRow}>
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            aria-label={pickLabels(SEARCH_DIALOG_LABELS).quickFind}
            role="combobox"
            aria-expanded="true"
            aria-controls={resultsId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder={pickLabels(SEARCH_DIALOG_LABELS).searchPlaceholder}
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
          aria-label={pickLabels(SEARCH_DIALOG_LABELS).quickFindResults}
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
                          {hit.kind === "block" && (
                            <span className={styles.resultBadge}>{pickLabels(SEARCH_DIALOG_LABELS).inPage}</span>
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
                <div className={styles.groupLabel}>{pickLabels(SEARCH_DIALOG_LABELS).recentSearches}</div>
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
                          <span className={styles.resultPath}>{pickLabels(SEARCH_DIALOG_LABELS).searchAgain}</span>
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
                  ? pickLabels(SEARCH_DIALOG_LABELS).searchingPageContent
                  : trimmedQuery
                    ? pickLabels(SEARCH_DIALOG_LABELS).noResultsFor(trimmedQuery)
                    : pickLabels(SEARCH_DIALOG_LABELS).noPagesFound}
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
                <span>{creatingPage ? pickLabels(SEARCH_DIALOG_LABELS).creating : pickLabels(SEARCH_DIALOG_LABELS).newPage(trimmedQuery)}</span>
              </button>
            )}
            <div className={styles.hints} aria-hidden="true">
              <span><kbd>↑↓</kbd> {pickLabels(SEARCH_DIALOG_LABELS).hintSelect}</span>
              <span><kbd>Enter</kbd> {pickLabels(SEARCH_DIALOG_LABELS).hintOpen}</span>
              <span><kbd>⌘</kbd><kbd>Enter</kbd> {pickLabels(SEARCH_DIALOG_LABELS).hintNewTab}</span>
              <span><kbd>Esc</kbd> {pickLabels(SEARCH_DIALOG_LABELS).hintClose}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
