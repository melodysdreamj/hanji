"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { i18next } from "@/i18n";
import { isComposingKeyEvent } from "@/lib/keyboard";
import {
  blockDefDescription,
  blockDefLabel,
  blockDefSearchKeywords,
  matchBlocks,
  type BlockDef,
} from "./blocks";
import { BlockIcon } from "./BlockIcon";
import styles from "./editor.module.css";

const RECENT_KEY = "hanji:slash-menu:recent";
const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 400;
const MENU_GAP = 6;
const MENU_MARGIN = 8;
// Keep the template menu viewport on whole command rows. These values mirror
// the compact template-only CSS below; the visual smoke measures both row
// height and bottom clipping so a future style change cannot drift silently.
const TEMPLATE_MENU_FIRST_ROW_OFFSET = 31;
const TEMPLATE_MENU_ROW_HEIGHT = 34;

function groupLabel(group: BlockDef["group"]) {
  return i18next.t(`slashMenu:groups.${group}`);
}

const GROUP_ORDER: BlockDef["group"][] = ["Basic", "Media", "Database", "Advanced"];

function defKey(def: BlockDef) {
  return def.id ?? def.type;
}

function itemDescription(def: BlockDef, query: string) {
  const q = query.trim().toLowerCase();
  const description = blockDefDescription(def);
  if (!q) return description;
  const matches = blockDefSearchKeywords(def)
    .filter((keyword) => keyword.toLowerCase().includes(q))
    .slice(0, 2);
  if (matches.length === 0) return description;
  return `${description} · ${matches.join(", ")}`;
}

function groupedSections(items: BlockDef[]) {
  const sections: { label: string; items: BlockDef[] }[] = [];
  for (const def of items) {
    const label = groupLabel(def.group);
    const section = sections.find((candidate) => candidate.label === label);
    if (section) section.items.push(def);
    else sections.push({ label, items: [def] });
  }
  return sections;
}

function MenuBackdrop({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["slashMenu", "common"]);
  return (
    <button
      type="button"
      className={`${styles.menuBackdrop} ${styles.slashBackdrop}`}
      onClick={onClose}
      tabIndex={-1}
      aria-label={t("slashMenu:closeBlockCommands")}
    />
  );
}

export type SlashMenuAnchor = {
  left: number;
  top: number;
  bottom: number;
  viewportTop?: number;
  viewportBottom?: number;
};

export function SlashMenu({
  anchor,
  query,
  templateMode = false,
  onPick,
  onClose,
}: {
  anchor?: SlashMenuAnchor;
  query: string;
  templateMode?: boolean;
  onPick: (def: BlockDef) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["slashMenu", "common"]);
  const [cursor, setCursor] = useState({ query: "", active: 0 });
  const [recentKeys, setRecentKeys] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
    } catch {
      return [];
    }
  });
  const menuId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // Ignore mouseenter-driven highlight changes until the pointer actually moves,
  // so keyboard navigation isn't hijacked by the cursor sitting over the menu.
  const pointerMoved = useRef(false);

  const results = useMemo(() => matchBlocks(query), [query]);
  const trimmedQuery = query.trim();
  const sections = useMemo(() => {
    if (trimmedQuery) return groupedSections(results);
    const byKey = new Map(results.map((def) => [defKey(def), def]));
    const picked = new Set<string>();
    const next: { label: string; items: BlockDef[] }[] = [];
    const recent = recentKeys
      .map((key) => byKey.get(key))
      .filter((def): def is BlockDef => !!def)
      .slice(0, 4);

    if (recent.length) {
      recent.forEach((def) => picked.add(defKey(def)));
      next.push({ label: t("slashMenu:recentlyUsed"), items: recent });
    }

    for (const group of GROUP_ORDER) {
      const items = results.filter((def) => def.group === group && !picked.has(defKey(def)));
      if (items.length) next.push({ label: groupLabel(group), items });
    }
    return next;
  }, [recentKeys, results, trimmedQuery, t]);
  const visibleItems = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const fixedStyle = useMemo<CSSProperties | undefined>(() => {
    if (!anchor || typeof window === "undefined") return undefined;

    const availableWidth = Math.max(0, window.innerWidth - MENU_MARGIN * 2);
    const viewportTop = Math.max(MENU_MARGIN, anchor.viewportTop ?? MENU_MARGIN);
    const viewportBottom = Math.min(
      window.innerHeight - MENU_MARGIN,
      anchor.viewportBottom ?? window.innerHeight - MENU_MARGIN
    );
    const availableHeight = Math.max(0, viewportBottom - viewportTop);
    const menuWidth = Math.min(MENU_WIDTH, availableWidth);
    const desiredHeight = Math.min(MENU_MAX_HEIGHT, availableHeight);
    const belowTop = anchor.bottom + MENU_GAP;
    const belowRoom = Math.max(0, viewportBottom - belowTop);
    const aboveRoom = Math.max(0, anchor.top - MENU_GAP - viewportTop);
    const openAbove = belowRoom < desiredHeight && aboveRoom > belowRoom;
    const room = openAbove ? aboveRoom : belowRoom;
    const minUsefulHeight = Math.min(96, desiredHeight);
    const unquantizedMenuHeight = Math.min(desiredHeight, Math.max(minUsefulHeight, room));
    const templateRowCount = Math.floor(
      (unquantizedMenuHeight - TEMPLATE_MENU_FIRST_ROW_OFFSET) / TEMPLATE_MENU_ROW_HEIGHT
    );
    const menuHeight =
      templateMode && templateRowCount > 0
        ? TEMPLATE_MENU_FIRST_ROW_OFFSET + templateRowCount * TEMPLATE_MENU_ROW_HEIGHT
        : unquantizedMenuHeight;
    const top = openAbove
      ? Math.max(viewportTop, anchor.top - MENU_GAP - menuHeight)
      : Math.max(viewportTop, Math.min(belowTop, viewportBottom - menuHeight));
    const left = Math.max(
      MENU_MARGIN,
      Math.min(anchor.left, window.innerWidth - menuWidth - MENU_MARGIN)
    );

    return {
      position: "fixed",
      top,
      left,
      width: menuWidth,
      maxHeight: menuHeight,
    };
  }, [anchor, templateMode]);
  const active =
    visibleItems.length === 0
      ? -1
      : cursor.query === query
        ? Math.min(cursor.active, visibleItems.length - 1)
        : 0;
  const activeId = active >= 0 ? `${menuId}-item-${active}` : undefined;
  const emptyId = `${menuId}-empty`;
  const statusId = `${menuId}-status`;
  const activeDef = active >= 0 ? visibleItems[active] : undefined;
  const setActive = useCallback(
    (next: number) => setCursor({ query, active: next }),
    [query]
  );
  const pick = useCallback(
    (def: BlockDef) => {
      const key = defKey(def);
      setRecentKeys((current) => {
        const next = [key, ...current.filter((item) => item !== key)].slice(0, 8);
        try {
          window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      onPick(def);
    },
    [onPick]
  );

  useEffect(() => {
    function onMove() {
      pointerMoved.current = true;
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isComposingKeyEvent(e)) return;

      if (visibleItems.length === 0) {
        // Don't trap navigation when empty — let the caret move (which re-runs
        // slash detection and closes the menu). Only intercept Escape.
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        return;
      }
      // Any keyboard nav suppresses the next mouseenter highlight until the
      // pointer is deliberately moved again.
      if (
        ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)
      ) {
        pointerMoved.current = false;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((active + 1) % visibleItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(active <= 0 ? visibleItems.length - 1 : active - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setActive(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setActive(visibleItems.length - 1);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        setActive(Math.min(active + 5, visibleItems.length - 1));
      } else if (e.key === "PageUp") {
        e.preventDefault();
        setActive(Math.max(active - 5, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const r = visibleItems[active];
        if (r) pick(r);
        else onClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [visibleItems, active, pick, onClose, setActive]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (visibleItems.length === 0) {
    const menu = (
      <>
        <MenuBackdrop onClose={onClose} />
        <div
          ref={listRef}
          className={styles.slash}
          style={fixedStyle}
          role="listbox"
          data-template-slash-menu={templateMode ? "true" : undefined}
          tabIndex={-1}
          aria-label={t("slashMenu:blockCommands")}
          aria-describedby={emptyId}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div id={emptyId} className={styles.slashEmpty} role="status">
            {trimmedQuery
              ? t("slashMenu:noBlocksFor", { query: trimmedQuery })
              : t("slashMenu:noBlocks")}
          </div>
        </div>
      </>
    );
    return typeof document === "undefined" ? menu : createPortal(menu, document.body);
  }

  const menu = (
    <>
      <MenuBackdrop onClose={onClose} />
      <div
        className={styles.slash}
        ref={listRef}
        style={fixedStyle}
        role="listbox"
        data-template-slash-menu={templateMode ? "true" : undefined}
        tabIndex={-1}
        aria-label={t("slashMenu:blockCommands")}
        aria-activedescendant={activeId}
        aria-describedby={statusId}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div id={statusId} className={styles.srOnly} aria-live="polite">
          {activeDef
            ? t("slashMenu:itemStatus", {
                label: blockDefLabel(activeDef),
                position: active + 1,
                total: visibleItems.length,
              })
            : t("slashMenu:listStatus", { total: visibleItems.length })}
        </div>
        {sections.map((section) => {
          const firstIndex = visibleItems.indexOf(section.items[0]);
          const sectionId = `${menuId}-section-${section.label.replace(/\s+/g, "-").toLowerCase()}`;
          return (
            <div
              key={section.label}
              className={styles.slashSection}
              role="group"
              aria-labelledby={sectionId}
            >
              <div id={sectionId} className={styles.slashLabel}>
                {section.label}
              </div>
              {section.items.map((d, i) => {
                const itemIndex = firstIndex + i;
                return (
                  <button
                    type="button"
                    key={`${section.label}-${defKey(d)}`}
                    id={`${menuId}-item-${itemIndex}`}
                    className={styles.slashItem}
                    role="option"
                    aria-selected={itemIndex === active}
                    aria-posinset={itemIndex + 1}
                    aria-setsize={visibleItems.length}
                    data-active={itemIndex === active ? "true" : undefined}
                    onMouseEnter={() => {
                      if (pointerMoved.current) setActive(itemIndex);
                    }}
                    onFocus={() => setActive(itemIndex)}
                    onClick={() => pick(d)}
                  >
                    <span
                      className={styles.slashGlyph}
                      data-template-block-command-icon={templateMode ? "true" : undefined}
                      aria-hidden="true"
                    >
                      <BlockIcon def={d} size={20} />
                    </span>
                    <span className={styles.slashText}>
                      <span className={styles.slashName}>{blockDefLabel(d)}</span>
                      <span className={styles.slashDesc}>{itemDescription(d, trimmedQuery)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
  return typeof document === "undefined" ? menu : createPortal(menu, document.body);
}
