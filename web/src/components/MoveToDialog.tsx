"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { positionBetween } from "@/lib/ids";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Page, PageParentType } from "@/lib/types";
import { useStore } from "@/lib/store";
import { FileText, Home, LockIcon, Search } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import styles from "./MoveToDialog.module.css";

type Destination =
  | { type: "workspace"; id: null; label: string; path: string; score: number; disabled?: boolean; disabledReason?: string }
  | { type: "page"; id: string; page: Page; label: string; path: string; score: number; disabled?: boolean; disabledReason?: string };

function labelOf(page: Page) {
  return pageDisplayTitle(page);
}

function isInSubtree(pagesById: Record<string, Page>, rootId: string, maybeChildId: string) {
  if (rootId === maybeChildId) return true;
  let cur = pagesById[maybeChildId];
  const guard = new Set<string>();
  while (cur?.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.parentId === rootId) return true;
    cur = pagesById[cur.parentId];
  }
  return false;
}

function siblingsFor(
  pagesById: Record<string, Page>,
  parentId: string | null,
  parentType: PageParentType,
  excludeId: string
) {
  return Object.values(pagesById)
    .filter((page) => {
      if (page.inTrash || page.id === excludeId) return false;
      if (parentId === null) return page.parentId == null || page.parentType === "workspace";
      return page.parentId === parentId && page.parentType === parentType;
    })
    .sort((a, b) => a.position - b.position);
}

function scoreDestination(label: string, path: string, query: string, base: number) {
  if (!query) return base;
  const title = label.toLowerCase();
  const haystack = `${title} ${path.toLowerCase()}`;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  if (haystack.includes(query)) return 3;
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return 4;
  return Number.POSITIVE_INFINITY;
}

export function MoveToDialog({
  pageId,
  onClose,
  onMoved,
}: {
  pageId: string;
  onClose: () => void;
  onMoved?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const dialogId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { pagesById, movePage, createPage, setTreePageExpanded } = useStore(
    useShallow((s) => ({
      pagesById: s.pagesById,
      movePage: s.movePage,
      createPage: s.createPage,
      setTreePageExpanded: s.setTreePageExpanded,
    }))
  );
  const notify = useStore((s) => s.notify);
  const movingPage = pagesById[pageId];
  const sourceParentLocked = !!(movingPage?.parentId && pagesById[movingPage.parentId]?.isLocked);

  const destinations = useMemo<Destination[]>(() => {
    if (!movingPage) return [];
    const q = query.trim().toLowerCase();
    const root: Destination = {
      type: "workspace",
      id: null,
      label: "Workspace root",
      path: "Top level",
      score: scoreDestination("Workspace root", "Top level", q, 0),
      disabled: sourceParentLocked,
      disabledReason: sourceParentLocked ? "Locked parent" : undefined,
    };
    const pageDestinations: Destination[] = Object.values(pagesById)
      .filter(
        (page) =>
          !page.inTrash &&
          page.kind === "page" &&
          !isInSubtree(pagesById, pageId, page.id)
      )
      .map((page, index) => {
        const path = pagePathOrWorkspaceRoot(page, pagesById);
        return {
          type: "page" as const,
          id: page.id,
          page,
          label: labelOf(page),
          path,
          score: scoreDestination(labelOf(page), path, q, index + 1),
          disabled: sourceParentLocked || !!page.isLocked,
          disabledReason: sourceParentLocked ? "Locked parent" : page.isLocked ? "Locked page" : undefined,
        };
      });
    return [root, ...pageDestinations]
      .filter((destination) => destination.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
      .slice(0, 14);
  }, [movingPage, pageId, pagesById, query, sourceParentLocked]);

  const hasExactMatch = destinations.some(
    (destination) => destination.label.toLowerCase() === query.trim().toLowerCase()
  );
  const showCreate = query.trim().length > 0 && !hasExactMatch;
  const createIndex = destinations.length;
  const itemCount = destinations.length + (showCreate ? 1 : 0);
  const safeActive =
    itemCount === 0
      ? -1
      : Math.max(0, Math.min(active, itemCount - 1));
  const titleId = `${dialogId}-title`;
  const resultsId = `${dialogId}-results`;
  const activeId =
    safeActive < 0
      ? undefined
      : safeActive === createIndex && showCreate
        ? `${dialogId}-create`
        : `${dialogId}-destination-${safeActive}`;

  const close = useCallback((restoreFocus = true) => {
    onClose();
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
        restoreFocusRef.current = null;
      });
    }
  }, [onClose]);

  const choose = useCallback(async (destination: Destination) => {
    if (sourceParentLocked) {
      notify("Page is in a locked parent", "default");
      return;
    }
    if (destination.type === "page" && destination.page.isLocked) {
      notify("Page is locked", "default");
      return;
    }
    const parentId = destination.type === "workspace" ? null : destination.id;
    const parentType: PageParentType = destination.type === "workspace" ? "workspace" : "page";
    const siblings = siblingsFor(pagesById, parentId, parentType, pageId);
    try {
      await movePage(
        pageId,
        parentId,
        parentType,
        positionBetween(siblings[siblings.length - 1]?.position, undefined)
      );
      notify("Moved page", "success");
    } catch {
      notify("Couldn't move page", "error");
      return;
    }
    if (onMoved) {
      close(false);
      onMoved();
    } else {
      close();
    }
  }, [close, movePage, notify, onMoved, pageId, pagesById, sourceParentLocked]);

  const createDestinationAndMove = useCallback(async () => {
    const title = query.trim();
    if (!title) return;
    if (sourceParentLocked) {
      notify("Page is in a locked parent", "default");
      return;
    }
    const rootSiblings = siblingsFor(pagesById, null, "workspace", pageId);
    try {
      const destination = await createPage({
        parentId: null,
        parentType: "workspace",
        title,
        afterPosition: rootSiblings[rootSiblings.length - 1]?.position,
        focusTitle: false,
      });
      await movePage(pageId, destination.id, "page", positionBetween(undefined, undefined));
      setTreePageExpanded(destination.id, true);
      notify("Moved page", "success");
    } catch {
      notify("Couldn't move page", "error");
      return;
    }
    if (onMoved) {
      close(false);
      onMoved();
    } else {
      close();
    }
  }, [close, createPage, movePage, notify, onMoved, pageId, pagesById, query, setTreePageExpanded, sourceParentLocked]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (safeActive < 0) return;
    resultsRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [safeActive, itemCount]);

  function dialogFocusables() {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || isComposingKeyEvent(e)) return;
    const target = e.target as HTMLElement | null;
    const targetIsTextField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (itemCount > 0) {
        setActive((index) => (Math.max(index, 0) + 1) % itemCount);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (itemCount > 0) {
        setActive((index) => (index <= 0 ? itemCount - 1 : index - 1));
      }
    } else if (e.key === "Home" && !targetIsTextField) {
      e.preventDefault();
      if (itemCount > 0) setActive(0);
    } else if (e.key === "End" && !targetIsTextField) {
      e.preventDefault();
      if (itemCount > 0) setActive(itemCount - 1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      if (itemCount > 0) {
        setActive((index) => Math.min(Math.max(index, 0) + 5, itemCount - 1));
      }
    } else if (e.key === "PageUp") {
      e.preventDefault();
      if (itemCount > 0) {
        setActive((index) => Math.max(index - 5, 0));
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showCreate && safeActive === createIndex) {
        void createDestinationAndMove();
        return;
      }
      const destination = destinations[safeActive];
      if (destination) void choose(destination);
    } else if (e.key === "Tab") {
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
    }
  }

  if (!movingPage) return null;

  return (
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        onClick={() => close()}
        tabIndex={-1}
        aria-label="Close move dialog"
      />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onDialogKeyDown}
      >
        <div id={titleId} className={styles.title}>Move to</div>
        <div className={styles.searchRow}>
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            aria-label="Search move destinations"
            role="combobox"
            aria-expanded="true"
            aria-controls={resultsId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder="Search pages..."
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <div
          id={resultsId}
          className={styles.results}
          ref={resultsRef}
          role="listbox"
          aria-label="Move destinations"
        >
          {destinations.map((destination, index) => (
            <button
              type="button"
              key={destination.type === "workspace" ? "workspace" : destination.id}
              id={`${dialogId}-destination-${index}`}
              className={styles.result}
              role="option"
              aria-selected={index === safeActive}
              aria-label={`Move to ${destination.label}, ${destination.path}`}
              data-active={index === safeActive ? "true" : undefined}
              data-disabled={destination.disabled ? "true" : undefined}
              disabled={destination.disabled}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => void choose(destination)}
            >
              <span className={styles.icon}>
                {destination.type === "workspace" ? (
                  <Home size={17} aria-hidden="true" />
                ) : (
                  <PageIconGlyph page={destination.page} size={17} />
                )}
              </span>
              <span className={styles.text}>
                <span>{destination.label}</span>
                <span>{destination.disabledReason ?? destination.path}</span>
              </span>
              {destination.disabled && <LockIcon className={styles.lock} size={13} aria-hidden="true" />}
            </button>
          ))}
          {showCreate && (
            <button
              type="button"
              id={`${dialogId}-create`}
              className={styles.result}
              role="option"
              aria-selected={safeActive === createIndex}
              aria-label={`Create page ${query.trim()} and move here`}
              data-active={safeActive === createIndex ? "true" : undefined}
              data-disabled={sourceParentLocked ? "true" : undefined}
              disabled={sourceParentLocked}
              onMouseEnter={() => setActive(createIndex)}
              onFocus={() => setActive(createIndex)}
              onClick={() => void createDestinationAndMove()}
            >
              <span className={styles.icon}>
                <FileText size={17} aria-hidden="true" />
              </span>
              <span className={styles.text}>
                <span>Create &quot;{query.trim()}&quot;</span>
                <span>{sourceParentLocked ? "Locked parent" : "New top-level page - move here"}</span>
              </span>
              {sourceParentLocked && <LockIcon className={styles.lock} size={13} aria-hidden="true" />}
            </button>
          )}
          {destinations.length === 0 && !showCreate && (
            <div className={styles.empty} role="status">No pages found.</div>
          )}
        </div>
      </div>
    </div>
  );
}
