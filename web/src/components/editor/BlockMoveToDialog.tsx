"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import { FileText, LockIcon, Search } from "../icons";
import { PageIconGlyph } from "../PageIcon";
import styles from "../MoveToDialog.module.css";

const LIST_NAVIGATION_KEYS = ["ArrowDown", "ArrowUp", "PageDown", "PageUp"];

type Destination = {
  id: string;
  page: Page;
  label: string;
  path: string;
  score: number;
  disabled?: boolean;
  disabledReason?: string;
};

function labelOf(page: Page) {
  return pageDisplayTitle(page);
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

function movedMessage(title: string) {
  const match = title.match(/Move\s+(\d+)\s+blocks/i);
  if (match) return `Moved ${match[1]} blocks`;
  return title.toLowerCase().includes("blocks") ? "Moved blocks" : "Moved block";
}

export function BlockMoveToDialog({
  blockId,
  sourcePageId,
  title = "Move block to",
  onChooseDestination,
  onClose,
}: {
  blockId: string;
  sourcePageId: string;
  title?: string;
  onChooseDestination?: (destinationPageId: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pointerMoved = useRef(false);
  const dialogId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { pagesById, moveBlockToPage, createPage, notify } = useStore(
    useShallow((s) => ({
      pagesById: s.pagesById,
      moveBlockToPage: s.moveBlockToPage,
      createPage: s.createPage,
      notify: s.notify,
    }))
  );

  const destinations = useMemo<Destination[]>(() => {
    const q = query.trim().toLowerCase();
    return Object.values(pagesById)
      .filter((page) => !page.inTrash && page.kind === "page" && page.id !== sourcePageId)
      .map((page, index) => {
        const label = labelOf(page);
        const path = pagePathOrWorkspaceRoot(page, pagesById);
        return {
          id: page.id,
          page,
          label,
          path,
          score: scoreDestination(label, path, q, index),
          disabled: !!page.isLocked,
          disabledReason: page.isLocked ? "Locked page" : undefined,
        };
      })
      .filter((destination) => destination.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
      .slice(0, 14);
  }, [pagesById, query, sourcePageId]);

  const close = useCallback((restoreFocus = true) => {
    onClose();
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
        restoreFocusRef.current = null;
      });
    }
  }, [onClose]);

  const choose = useCallback(
    async (destination: Destination) => {
      if (destination.disabled) {
        notify(destination.disabledReason ?? "Page is locked", "default");
        return;
      }
      try {
        if (onChooseDestination) await onChooseDestination(destination.id);
        else await moveBlockToPage(blockId, destination.id);
        notify(movedMessage(title), "success");
      } catch {
        notify("Couldn't move block", "error");
        return;
      }
      close();
    },
    [blockId, close, moveBlockToPage, notify, onChooseDestination, title]
  );

  // Create a new top-level page and move the block into it.
  const createAndMove = useCallback(async () => {
    const destinationTitle = query.trim() || "Untitled";
    try {
      const page = await createPage({
        parentId: null,
        parentType: "workspace",
        title: destinationTitle,
        focusTitle: false,
      });
      if (onChooseDestination) await onChooseDestination(page.id);
      else await moveBlockToPage(blockId, page.id);
      notify(movedMessage(title), "success");
    } catch {
      notify("Couldn't move block", "error");
      return;
    }
    close();
  }, [blockId, close, createPage, moveBlockToPage, notify, onChooseDestination, query, title]);

  const hasExactMatch = destinations.some(
    (d) => d.label.toLowerCase() === query.trim().toLowerCase()
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

  useEffect(() => {
    pointerMoved.current = false;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function onMove() {
      pointerMoved.current = true;
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
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
    const isListNavigationKey =
      LIST_NAVIGATION_KEYS.includes(e.key) ||
      ((e.key === "Home" || e.key === "End") && !targetIsTextField);
    if (isListNavigationKey && itemCount > 0) {
      pointerMoved.current = false;
    }
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
        void createAndMove();
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
        <div id={titleId} className={styles.title}>{title}</div>
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
              key={destination.id}
              id={`${dialogId}-destination-${index}`}
              className={styles.result}
              role="option"
              aria-selected={index === safeActive}
              aria-label={`Move block to ${destination.label}, ${destination.path}`}
              data-active={index === safeActive ? "true" : undefined}
              data-disabled={destination.disabled ? "true" : undefined}
              disabled={destination.disabled}
              onMouseEnter={() => {
                if (pointerMoved.current) setActive(index);
              }}
              onFocus={() => setActive(index)}
              onClick={() => void choose(destination)}
            >
              <span className={styles.icon}>
                <PageIconGlyph page={destination.page} size={17} />
              </span>
              <span className={styles.text}>
                <span>{destination.label}</span>
                <span>{destination.disabledReason ?? destination.path}</span>
              </span>
              {destination.disabled && <LockIcon className={styles.lock} size={13} aria-hidden="true" />}
            </button>
          ))}
          {destinations.length === 0 && !showCreate && (
            <div className={styles.empty} role="status">No pages found.</div>
          )}
          {showCreate && (
            <button
              type="button"
              id={`${dialogId}-create`}
              className={styles.result}
              role="option"
              aria-selected={safeActive === createIndex}
              aria-label={`Create page "${query.trim()}" and move block here`}
              data-active={safeActive === createIndex ? "true" : undefined}
              onMouseEnter={() => {
                if (pointerMoved.current) setActive(createIndex);
              }}
              onFocus={() => setActive(createIndex)}
              onClick={() => void createAndMove()}
            >
              <span className={styles.icon}>
                <FileText size={17} aria-hidden="true" />
              </span>
              <span className={styles.text}>
                <span>Create &quot;{query.trim()}&quot;</span>
                <span>New page - move block here</span>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
