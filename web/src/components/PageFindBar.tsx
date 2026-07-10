"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { motionSafeScrollBehavior } from "@/lib/motion";
import { ArrowDown, ArrowUp, Search, X } from "./icons";
import styles from "./PageView.module.css";

const FIND_MATCH_HIGHLIGHT = "notionlike-page-find-match";
const FIND_ACTIVE_HIGHLIGHT = "notionlike-page-find-active";
const FIND_STYLE_ID = "notionlike-page-find-highlight-style";

type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

type HighlightApi = {
  Highlight: new (...ranges: Range[]) => unknown;
  registry: HighlightRegistry;
};

type FindMatch = {
  range: Range;
};

export function selectedTextForPageFind(root: HTMLElement | null) {
  if (!root || typeof window === "undefined") return "";
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";

  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  if (!ranges.some((range) => range.intersectsNode(root))) return "";

  return selection
    .toString()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function pageFindApi(): HighlightApi | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function clearPageFindHighlights() {
  const api = pageFindApi();
  api?.registry.delete(FIND_MATCH_HIGHLIGHT);
  api?.registry.delete(FIND_ACTIVE_HIGHLIGHT);
}

function ensurePageFindHighlightStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(FIND_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FIND_STYLE_ID;
  style.textContent = `
::highlight(${FIND_MATCH_HIGHLIGHT}) {
  background: var(--page-find-match-bg, rgba(255, 212, 0, 0.38));
  color: inherit;
}
::highlight(${FIND_ACTIVE_HIGHLIGHT}) {
  background: var(--page-find-active-bg, rgba(255, 176, 0, 0.72));
  color: inherit;
}`;
  document.head.appendChild(style);
}

function searchableTextNodes(root: HTMLElement) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue ?? "";
      if (!value.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (
        parent.closest(
          'script, style, noscript, button, input, select, textarea, [aria-hidden="true"], [data-page-find-exclude]',
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      const editableAncestor = parent.closest('[contenteditable="true"]');
      if (!editableAncestor && parent.closest('[contenteditable="false"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

function pageFindMatches(root: HTMLElement, query: string): FindMatch[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: FindMatch[] = [];

  for (const node of searchableTextNodes(root)) {
    const text = node.nodeValue ?? "";
    const haystack = text.toLocaleLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      matches.push({ range });
      index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
    }
  }

  return matches;
}

function applyPageFindHighlights(matches: FindMatch[], activeIndex: number) {
  const api = pageFindApi();
  if (!api) return;
  api.registry.delete(FIND_MATCH_HIGHLIGHT);
  api.registry.delete(FIND_ACTIVE_HIGHLIGHT);
  if (matches.length === 0) return;
  api.registry.set(
    FIND_MATCH_HIGHLIGHT,
    new api.Highlight(...matches.map((match) => match.range)),
  );
  const active = matches[activeIndex];
  if (active) {
    api.registry.set(FIND_ACTIVE_HIGHLIGHT, new api.Highlight(active.range));
  }
}

export function PageFindBar({
  focusTick,
  initialQuery = "",
  onClose,
  open,
  pageId,
  revision,
  rootRef,
}: {
  focusTick: number;
  initialQuery?: string;
  onClose: () => void;
  open: boolean;
  pageId: string;
  revision: string;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FindMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const normalizedQuery = query.trim();

  const step = useCallback((delta: number) => {
    setActiveIndex((current) => {
      if (matches.length === 0) return -1;
      const base = current < 0 ? 0 : current;
      return (base + delta + matches.length) % matches.length;
    });
  }, [matches.length]);

  useEffect(() => {
    if (!open) return;
    ensurePageFindHighlightStyle();
    const seededQuery = initialQuery.trim();
    const frame = window.requestAnimationFrame(() => {
      if (seededQuery) setQuery(seededQuery);
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusTick, initialQuery, open]);

  useEffect(() => {
    if (!open || !normalizedQuery) {
      clearPageFindHighlights();
      const frame = window.requestAnimationFrame(() => {
        setMatches([]);
        setActiveIndex(-1);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      const nextMatches = root ? pageFindMatches(root, normalizedQuery) : [];
      setMatches(nextMatches);
      setActiveIndex(nextMatches.length ? 0 : -1);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [normalizedQuery, open, pageId, revision, rootRef]);

  useEffect(() => {
    if (!open) {
      clearPageFindHighlights();
      return;
    }
    applyPageFindHighlights(matches, activeIndex);
    return clearPageFindHighlights;
  }, [activeIndex, matches, open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const match = matches[activeIndex];
    if (!match) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = match.range.getBoundingClientRect();
      const target =
        rect.width > 0 || rect.height > 0
          ? document.elementFromPoint(rect.left, rect.top)
          : null;
      const element =
        target?.closest<HTMLElement>("[data-block-id]") ??
        target?.closest<HTMLElement>("[data-page-search-root]") ??
        target?.closest<HTMLElement>("[data-row-peek-search-root]") ??
        match.range.commonAncestorContainer.parentElement;
      element?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: motionSafeScrollBehavior(),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, matches, open]);

  useEffect(() => clearPageFindHighlights, []);

  if (!open) return null;

  function onFindBarKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }

    const key = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    const repeatShortcut =
      (mod && !e.altKey && key === "g") ||
      (!mod && !e.altKey && e.key === "F3");
    if (!repeatShortcut) return;

    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  }

  const countLabel = normalizedQuery ? `${activeIndex >= 0 ? activeIndex + 1 : 0}/${matches.length}` : "0/0";

  return (
    <div
      className={styles.findBar}
      role="dialog"
      aria-label="Find in page"
      data-page-find-exclude
      onKeyDown={onFindBarKeyDown}
    >
      <div className={styles.findInputWrap}>
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          aria-label="Find in page"
          aria-keyshortcuts="Enter Shift+Enter Meta+G Control+G F3"
            placeholder="Find in page"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingKeyEvent(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
            }
          }}
        />
      </div>
      <span className={styles.findCount} aria-live="polite">
        {countLabel}
      </span>
      <button
        type="button"
        className={styles.findButton}
        onClick={() => step(-1)}
        disabled={matches.length === 0}
        aria-label="Previous match"
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className={styles.findButton}
        onClick={() => step(1)}
        disabled={matches.length === 0}
        aria-label="Next match"
      >
        <ArrowDown size={14} />
      </button>
      <button type="button" className={styles.findButton} onClick={onClose} aria-label="Close find">
        <X size={14} />
      </button>
    </div>
  );
}
