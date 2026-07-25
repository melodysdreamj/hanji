"use client";

import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { scheduleOrganizationPeopleTypeahead } from "@/lib/typeaheadSearch";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pagePath, pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import {
  databaseDisplayTitle,
  linkedDatabaseResolvedTitle,
  pageDisplayTitle,
} from "@/lib/pageTitle";
import { useStore } from "@/lib/store";
import type { BlockType, OrganizationProfile, Page } from "@/lib/types";
import { personLabel } from "../database/people";
import { CalendarIcon, Database, Plus } from "../icons";
import { pageIconText } from "../PageIcon";
import { VerificationBadge } from "../VerificationBadge";
import type { BlockDef } from "./blocks";
import { blockItemLabels, blockItemText } from "./blockItemLabels";
import { localDateForOffset, localIsoDate } from "./mentionCalendarModel";
import type { SlashMenuAnchor } from "./SlashMenu";
import styles from "./editor.module.css";

type InlineMenuAnchor = Pick<DOMRect, "left" | "top" | "bottom">;
const DATABASE_SOURCE_MENU_WIDTH = 360;
const DATABASE_SOURCE_MENU_HEIGHT = 430;
const DATABASE_SOURCE_MENU_GAP = 24;
const MENU_VIEWPORT_MARGIN = 8;

export type MentionTrigger = "mention" | "page_link";

type DatabaseBlockKind = Extract<BlockType, "child_database" | "inline_database">;

export type DatabaseSourcePickerRequest = {
  anchor?: SlashMenuAnchor;
  type: DatabaseBlockKind;
  viewType?: BlockDef["databaseView"];
};

export type MentionState = {
  open: boolean;
  query: string;
  anchor?: SlashMenuAnchor;
  trigger?: MentionTrigger;
};

export type MentionItem =
  | {
      kind: "date";
      id: string;
      label: string;
      description: string;
      icon: string;
      date: string;
    }
  | {
      kind: "person";
      id: string;
      label: string;
      description: string;
      icon: string;
      userId: string;
    }
  | {
      kind: "page";
      id: string;
      label: string;
      description: string;
      icon: string;
      pageId: string;
      page: Page;
    }
  | {
      kind: "create_page";
      id: string;
      label: string;
      description: string;
      icon: string;
      title: string;
    };

function belowAnchorMenuPosition(
  anchor: InlineMenuAnchor,
  width: number,
  height: number,
  gap = 8
): Pick<CSSProperties, "bottom" | "left" | "maxHeight" | "top"> {
  const availableWidth = Math.max(0, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
  const menuWidth = Math.min(width, availableWidth);
  const viewportHeight = Math.max(0, window.innerHeight - MENU_VIEWPORT_MARGIN * 2);
  const desiredHeight = Math.min(height, viewportHeight);
  const belowTop = anchor.bottom + gap;
  const aboveBottom = anchor.top - gap;
  const viewportBottom = window.innerHeight - MENU_VIEWPORT_MARGIN;
  const availableBelow = Math.max(0, viewportBottom - belowTop);
  const availableAbove = Math.max(0, aboveBottom - MENU_VIEWPORT_MARGIN);
  const placeAbove = availableBelow < desiredHeight && availableAbove > availableBelow;
  const availableOnSide = placeAbove ? availableAbove : availableBelow;
  const minimumUsableHeight = Math.min(96, desiredHeight);
  const maxHeight = Math.max(
    minimumUsableHeight,
    Math.min(desiredHeight, availableOnSide)
  );
  const maximumStart = Math.max(MENU_VIEWPORT_MARGIN, viewportBottom - maxHeight);
  const left = Math.max(
    MENU_VIEWPORT_MARGIN,
    Math.min(anchor.left, window.innerWidth - menuWidth - MENU_VIEWPORT_MARGIN)
  );

  if (placeAbove) {
    const desiredBottom = window.innerHeight - aboveBottom;
    const maximumBottom = Math.max(
      MENU_VIEWPORT_MARGIN,
      window.innerHeight - MENU_VIEWPORT_MARGIN - maxHeight
    );
    return {
      bottom: Math.max(MENU_VIEWPORT_MARGIN, Math.min(desiredBottom, maximumBottom)),
      left,
      maxHeight,
      top: "auto",
    };
  }

  return {
    bottom: "auto",
    left,
    maxHeight,
    top: Math.max(MENU_VIEWPORT_MARGIN, Math.min(belowTop, maximumStart)),
  };
}

export function pageTitle(page: Page) {
  return pageDisplayTitle(page);
}

function pageIcon(page: Page, fallback = "P") {
  return pageIconText(page, fallback);
}

function isDatabaseSourcePage(page: Page) {
  const properties = page.properties ?? {};
  const linkedDatabaseTitle = linkedDatabaseResolvedTitle(page);
  return (
    page.kind === "database" &&
    page.parentType !== "database" &&
    !page.inTrash &&
    !linkedDatabaseTitle &&
    properties.notionLinkedDatabaseSourceUnavailable !== true
  );
}

function databaseSourceDescription(page: Page) {
  const properties = page.properties ?? {};
  return typeof properties.notionDatabaseId === "string" ||
    typeof properties.notionDataSourceId === "string"
    ? blockItemText("database.imported")
    : blockItemText("database.label");
}

function mentionSearchRank(label: string, description: string, query: string) {
  if (!query) return 0;
  const normalizedLabel = label.toLowerCase();
  const haystack = `${normalizedLabel} ${description.toLowerCase()}`;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (normalizedLabel === query) return 0;
  if (normalizedLabel.startsWith(query)) return 1;
  if (normalizedLabel.includes(query)) return 2;
  if (haystack.includes(query)) return 3;
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return 4;
  return Number.POSITIVE_INFINITY;
}

function mentionDateDescription(offsetDays: number) {
  const date = localDateForOffset(offsetDays);
  return new Intl.DateTimeFormat(blockItemLabels().dateDisplayLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function mentionDateRank(
  item: MentionItem & { kind: "date" },
  aliases: string[],
  query: string,
  index: number
) {
  if (!query) return index;
  return Math.min(
    mentionSearchRank(item.label, item.description, query),
    ...aliases.map((alias) => mentionSearchRank(alias, item.description, query))
  );
}

function organizationProfileMentionLabel(profile: OrganizationProfile) {
  return profile.displayName?.trim() || profile.email?.trim() || profile.userId?.trim() || blockItemText("person.label");
}

function organizationProfileMentionDescription(profile: OrganizationProfile) {
  const parts = [
    profile.email?.trim(),
    profile.organizationRole
      ? blockItemText("person.roleInOrganization", { role: profile.organizationRole })
      : null,
    profile.status && profile.status !== "active" ? profile.status : null,
  ].filter(Boolean);
  return parts.join(" - ") || blockItemText("person.organizationMember");
}

export function MentionMenu({
  anchor,
  query,
  mode = "mention",
  onPick,
  onClose,
}: {
  anchor?: SlashMenuAnchor;
  query: string;
  mode?: MentionTrigger;
  onPick: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState({ query: "", active: 0 });
  const pagesById = useStore((s) => s.pagesById);
  const userId = useStore((s) => s.userId);
  const organization = useStore((s) => s.organization);
  const organizationProfiles = useStore((s) => s.organizationProfiles);
  const [searchedPeople, setSearchedPeople] = useState<{
    key: string;
    people: OrganizationProfile[];
  }>({ key: "", people: [] });
  const menuId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // Match the slash menu: after keyboard navigation, ignore stale mouseenter
  // events until the pointer actually moves.
  const pointerMoved = useRef(false);
  const menuStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!anchor || typeof window === "undefined") return undefined;
    const targetWidth = mode === "mention" ? 360 : 300;
    const width = Math.min(targetWidth, Math.max(0, window.innerWidth - MENU_VIEWPORT_MARGIN * 2));
    const maxHeight = Math.min(310, Math.max(0, window.innerHeight - MENU_VIEWPORT_MARGIN * 2));
    const margin = 8;
    const gap = 6;
    const belowTop = anchor.bottom + gap;
    const aboveTop = anchor.top - maxHeight - gap;
    const viewportBottom = window.innerHeight - margin;
    const top =
      mode === "mention" && aboveTop >= margin
        ? aboveTop
        : belowTop + maxHeight <= viewportBottom
        ? belowTop
        : aboveTop >= margin
          ? aboveTop
          : Math.max(margin, Math.min(belowTop, viewportBottom - maxHeight));
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    return {
      position: "fixed",
      top,
      left,
      width,
      maxHeight,
    };
  }, [anchor, mode]);

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (mode === "page_link" || !organization?.id || !q) {
      setSearchedPeople({ key: "", people: [] });
      return;
    }
    return scheduleOrganizationPeopleTypeahead({
        organizationId: organization.id,
        query: q,
        limit: 8,
      }, {
        onResult: (result) => setSearchedPeople({ key: q, people: result.people ?? [] }),
        onError: () => setSearchedPeople({ key: q, people: [] }),
      });
  }, [mode, organization?.id, q]);

  const results = useMemo(() => {
    const dateChoices: Array<{ item: MentionItem & { kind: "date" }; aliases: string[] }> = [
      {
        item: {
          kind: "date",
          id: "today",
          label: blockItemLabels().mentionToday,
          description: mentionDateDescription(0),
          icon: "@",
          date: localIsoDate(0),
        },
        aliases: ["today", "tod", "금일"],
      },
      {
        item: {
          kind: "date",
          id: "tomorrow",
          label: blockItemLabels().mentionTomorrow,
          description: mentionDateDescription(1),
          icon: "@",
          date: localIsoDate(1),
        },
        aliases: ["tomorrow", "tmr", "tom"],
      },
      {
        item: {
          kind: "date",
          id: "yesterday",
          label: blockItemLabels().mentionYesterday,
          description: mentionDateDescription(-1),
          icon: "@",
          date: localIsoDate(-1),
        },
        aliases: ["yesterday", "yday"],
      },
    ];
    const dates = mode === "page_link"
      ? []
      : dateChoices
          .map(({ item, aliases }, index) => ({
            item,
            index,
            rank: mentionDateRank(item, aliases, q, index),
          }))
          .filter((candidate) => Number.isFinite(candidate.rank))
          .sort((a, b) => a.rank - b.rank || a.index - b.index)
          .map((candidate) => candidate.item);
    const currentUserId = userId || "local-user";
    const currentUserLabel = personLabel(currentUserId, userId);
    const personItem: MentionItem = {
      kind: "person",
      id: `person:${currentUserId}`,
      label: currentUserLabel,
      description: blockItemText("person.label"),
      icon: currentUserLabel.slice(0, 1).toUpperCase(),
      userId: currentUserId,
    };
    const personRank = Math.min(
      mentionSearchRank(currentUserLabel, blockItemText("person.collaborator"), q),
      ["you", "나", "본인"].some((alias) => alias.includes(q)) ? 1 : Number.POSITIVE_INFINITY
    );
    const profileCandidates = new Map<string, OrganizationProfile>();
    const currentUserKey = currentUserId.trim();
    const searchPeople = searchedPeople.key === q ? searchedPeople.people : [];
    for (const profile of [...searchPeople, ...organizationProfiles]) {
      const profileUserId = profile.userId?.trim();
      if (!profileUserId || profileUserId === currentUserKey || profileCandidates.has(profileUserId)) continue;
      profileCandidates.set(profileUserId, profile);
    }
    const organizationPeople: MentionItem[] = Array.from(profileCandidates.values())
      .map((profile, index) => {
        const profileUserId = profile.userId?.trim() ?? "";
        const label = organizationProfileMentionLabel(profile);
        const description = organizationProfileMentionDescription(profile);
        return {
          item: {
            kind: "person" as const,
            id: `person:${profileUserId}`,
            label,
            description,
            icon: label.slice(0, 1).toUpperCase(),
            userId: profileUserId,
          },
          index,
          rank: mentionSearchRank(label, description, q),
        };
      })
      .filter((candidate) => Number.isFinite(candidate.rank))
      .sort((a, b) => a.rank - b.rank || a.item.label.localeCompare(b.item.label) || a.index - b.index)
      .map((candidate) => candidate.item)
      .slice(0, 8);
    const people: MentionItem[] =
      mode === "page_link"
        ? []
        : [...(Number.isFinite(personRank) ? [personItem] : []), ...organizationPeople];

    const allPages = mode === "page_link" ? Object.values(pagesById).filter((page) => !page.inTrash) : [];
    const pages =
      mode === "page_link"
        ? allPages
            .map((page, index) => {
              const label = pageTitle(page);
              const description = pagePathOrWorkspaceRoot(page, pagesById);
              return {
                item: {
                  kind: "page" as const,
                  id: `page:${page.id}`,
                  label,
                  description,
                  icon: pageIcon(page),
                  pageId: page.id,
                  page,
                },
                index,
                rank: mentionSearchRank(label, description, q),
              };
            })
            .filter((candidate) => Number.isFinite(candidate.rank))
            .sort((a, b) => {
              if (a.rank !== b.rank) return a.rank - b.rank;
              return a.item.label.localeCompare(b.item.label) || a.index - b.index;
            })
            .map((candidate) => candidate.item)
            .slice(0, 12)
        : [];
    const exactPage = q
      ? allPages.some((page) => pageTitle(page).trim().toLowerCase() === q)
      : true;
    const createItem: MentionItem[] =
      mode === "page_link" && q && !exactPage
        ? [
            {
              kind: "create_page",
              id: `create:${q}`,
              label: blockItemText("mention.newPageNamed", { title: query.trim() }),
              description: blockItemText("mention.createPage"),
              icon: "+",
              title: query.trim(),
            },
          ]
        : [];

    return [...dates, ...people, ...createItem, ...pages];
  }, [mode, organizationProfiles, pagesById, q, query, searchedPeople, userId]);

  const activeIndex =
    results.length === 0
      ? -1
      : cursor.query === query
        ? Math.min(cursor.active, results.length - 1)
        : 0;
  const activeId = activeIndex >= 0 ? `${menuId}-item-${activeIndex}` : undefined;
  const emptyId = `${menuId}-empty`;
  const groupedResults = useMemo(() => {
    const groups: Array<{ label: string; items: Array<{ item: MentionItem; index: number }> }> = [];
    for (const [index, item] of results.entries()) {
      const label =
        item.kind === "date"
          ? blockItemLabels().groupDate
          : item.kind === "person"
            ? blockItemLabels().groupPeople
            : item.kind === "create_page"
              ? blockItemLabels().groupNewPage
              : blockItemLabels().groupLinkToPage;
      const group = groups.find((candidate) => candidate.label === label);
      if (group) group.items.push({ item, index });
      else groups.push({ label, items: [{ item, index }] });
    }
    return groups;
  }, [results]);
  const setActiveIndex = useCallback(
    (active: number) => setCursor({ query, active }),
    [query]
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

      if (results.length === 0) {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (
        ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)
      ) {
        pointerMoved.current = false;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((activeIndex + 1) % results.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex(activeIndex <= 0 ? results.length - 1 : activeIndex - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setActiveIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setActiveIndex(results.length - 1);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        setActiveIndex(Math.min(activeIndex + 5, results.length - 1));
      } else if (e.key === "PageUp") {
        e.preventDefault();
        setActiveIndex(Math.max(activeIndex - 5, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = results[activeIndex];
        if (item) onPick(item);
        else onClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [activeIndex, onClose, onPick, results, setActiveIndex]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const picker = (
    <>
      <button
        type="button"
        className={`${styles.menuBackdrop} ${styles.editorFloatingBackdrop}`}
        onClick={onClose}
        tabIndex={-1}
        aria-label={blockItemText(
          mode === "page_link" ? "mention.closePageLinkMenu" : "mention.closeMenu"
        )}
      />
      <div
        className={styles.mentionMenu}
        ref={listRef}
        style={menuStyle}
        role="listbox"
        tabIndex={-1}
        aria-label={blockItemText(mode === "page_link" ? "pageLink.linkToPage" : "mention.label")}
        aria-activedescendant={activeId}
        aria-describedby={results.length === 0 ? emptyId : undefined}
        onMouseDown={(e) => e.preventDefault()}
      >
        {mode === "page_link" ? (
          <div className={styles.slashLabel}>{blockItemLabels().groupLinkToPage}</div>
        ) : null}
        {results.length === 0 ? (
          <div id={emptyId} className={styles.slashEmpty} role="status">
            {query.trim()
              ? blockItemText("mention.noResultsFor", { query: query.trim() })
              : mode === "page_link"
                ? blockItemText("mention.noPages")
                : blockItemText("mention.noResults")}
          </div>
        ) : (
          groupedResults.map((group) => (
            <div key={group.label} className={styles.mentionSection}>
              <div className={styles.mentionSectionLabel} aria-hidden="true">
                {group.label}
              </div>
              {group.items.map(({ item, index }) => (
                <button
                  type="button"
                  key={item.id}
                  id={`${menuId}-item-${index}`}
                  className={styles.mentionItem}
                  data-active={index === activeIndex ? "true" : undefined}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => {
                    if (pointerMoved.current) setActiveIndex(index);
                  }}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => onPick(item)}
                >
                  <span className={styles.mentionGlyph} data-kind={item.kind} aria-hidden="true">
                    {item.kind === "date" ? (
                      <CalendarIcon size={15} />
                    ) : item.kind === "create_page" ? (
                      <Plus size={15} />
                    ) : (
                      item.icon
                    )}
                  </span>
                  <span className={styles.slashText}>
                    <span className={styles.slashName}>
                      {item.label}
                      {item.kind === "page" && <VerificationBadge page={item.page} compact />}
                    </span>
                    <span className={styles.slashDesc}>{item.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );

  return typeof document === "undefined" ? picker : createPortal(picker, document.body);
}

export function DatabaseSourcePicker({
  anchor,
  type,
  onCreate,
  onLink,
  onClose,
}: {
  anchor?: SlashMenuAnchor;
  type: DatabaseBlockKind;
  viewType?: BlockDef["databaseView"];
  onCreate: () => void;
  onLink: (databaseId: string) => void;
  onClose: () => void;
}) {
  const pagesById = useStore((s) => s.pagesById);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const pointerMoved = useRef(false);
  const pickerId = useId();
  const listId = `${pickerId}-list`;
  const q = query.trim().toLowerCase();
  const placementLabel = blockItemText(
    type === "inline_database" ? "database.inlinePlacement" : "database.fullPagePlacement"
  );

  const results = useMemo(() => {
    return Object.values(pagesById)
      .filter(isDatabaseSourcePage)
      .map((page, index) => {
        const title = databaseDisplayTitle(page);
        const path = pagePath(page, pagesById);
        const description = databaseSourceDescription(page);
        const haystack = `${title} ${path} ${description}`.toLowerCase();
        let score = index + 10;
        if (q) {
          if (title.toLowerCase() === q) score = 0;
          else if (title.toLowerCase().startsWith(q)) score = 1;
          else if (title.toLowerCase().includes(q)) score = 2;
          else if (haystack.includes(q)) score = 3;
          else score = Number.POSITIVE_INFINITY;
        }
        return { page, title, description, score };
      })
      .filter((result) => result.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
      .slice(0, 12);
  }, [pagesById, q]);

  const itemCount = 1 + results.length;
  const active = Math.max(0, Math.min(activeIndex, itemCount - 1));
  const activeId = `${pickerId}-option-${active}`;
  const menuStyle = useMemo<CSSProperties | undefined>(() => {
    if (!anchor || typeof window === "undefined") return undefined;
    const width = Math.min(
      DATABASE_SOURCE_MENU_WIDTH,
      Math.max(0, window.innerWidth - MENU_VIEWPORT_MARGIN * 2)
    );
    const position = belowAnchorMenuPosition(
      anchor,
      DATABASE_SOURCE_MENU_WIDTH,
      DATABASE_SOURCE_MENU_HEIGHT,
      DATABASE_SOURCE_MENU_GAP
    );
    return {
      ...position,
      position: "fixed",
      width,
    };
  }, [anchor]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    setActiveIndex(q && results.length > 0 ? 1 : 0);
  }, [q, results.length]);

  useEffect(() => {
    function onMove() {
      pointerMoved.current = true;
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    resultsRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function setActive(next: number) {
    setActiveIndex((next + itemCount) % itemCount);
  }

  function choose(index = active) {
    if (index === 0) {
      onCreate();
      return;
    }
    const result = results[index - 1];
    if (result) onLink(result.page.id);
  }

  function chooseNewFromMouseDown(e: ReactMouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    choose(0);
  }

  function handlePickerKeyDown(e: React.KeyboardEvent<HTMLElement> | KeyboardEvent) {
    if (isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActive(active - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      pointerMoved.current = false;
      setActiveIndex(itemCount - 1);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      choose();
    }
  }

  // Latest-ref pattern: the handler closes over per-render state (active row,
  // result list), but the document listener must attach exactly once instead
  // of detaching/re-attaching on every render.
  const handlePickerKeyDownRef = useRef(handlePickerKeyDown);
  useEffect(() => {
    handlePickerKeyDownRef.current = handlePickerKeyDown;
  });

  useEffect(() => {
    function onDocumentKeyDown(e: KeyboardEvent) {
      handlePickerKeyDownRef.current(e);
    }

    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => document.removeEventListener("keydown", onDocumentKeyDown, true);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    handlePickerKeyDown(e);
  }

  const picker = (
    <>
      <button
        type="button"
        className={`${styles.menuBackdrop} ${styles.editorFloatingBackdrop}`}
        onClick={onClose}
        tabIndex={-1}
        aria-label={blockItemText("databaseSource.closePicker")}
      />
      <div
        className={styles.databaseSourceMenu}
        style={menuStyle}
        role="dialog"
        aria-label={blockItemText("databaseSource.choose")}
        contentEditable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          id={`${pickerId}-option-0`}
          className={styles.databaseSourceItem}
          data-active={active === 0 ? "true" : undefined}
          data-database-source-action="new"
          onMouseEnter={() => {
            if (pointerMoved.current) setActiveIndex(0);
          }}
          onFocus={() => setActiveIndex(0)}
          onMouseDown={chooseNewFromMouseDown}
          onClick={() => choose(0)}
        >
          <span className={styles.databaseSourceIcon} aria-hidden="true">
            <Plus size={17} />
          </span>
          <span className={styles.databaseSourceText}>
            <span className={styles.databaseSourceTitle}>
              {blockItemText("databaseSource.newDatabase")}
            </span>
            <span className={styles.databaseSourcePath}>
              {blockItemText("databaseSource.createNew", { placement: placementLabel })}
            </span>
          </span>
        </button>
        <div className={styles.databaseSourceLabel}>
          {blockItemText("databaseSource.existingSources")}
        </div>
        <input
          ref={inputRef}
          className={styles.databaseSourceSearch}
          value={query}
          placeholder={blockItemText("databaseSource.searchPlaceholder")}
          aria-label={blockItemText("databaseSource.searchExisting")}
          aria-controls={listId}
          aria-activedescendant={activeId}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div
          id={listId}
          ref={resultsRef}
          className={styles.databaseSourceResults}
          role="listbox"
          tabIndex={-1}
          aria-label={blockItemText("databaseSource.existingDatabases")}
          aria-activedescendant={active > 0 ? activeId : undefined}
        >
          {results.length === 0 ? (
            <div className={styles.databaseSourceEmpty}>
              {blockItemText(q ? "databaseSource.noMatching" : "databaseSource.noneYet")}
            </div>
          ) : (
            results.map((result, index) => {
              const itemIndex = index + 1;
              return (
                <button
                  type="button"
                  key={result.page.id}
                  id={`${pickerId}-option-${itemIndex}`}
                  className={styles.databaseSourceItem}
                  role="option"
                  aria-selected={itemIndex === active}
                  data-active={itemIndex === active ? "true" : undefined}
                  data-database-source-action="existing"
                  data-database-source-kind="database"
                  onMouseEnter={() => {
                    if (pointerMoved.current) setActiveIndex(itemIndex);
                  }}
                  onFocus={() => setActiveIndex(itemIndex)}
                  onClick={() => choose(itemIndex)}
                >
                  <span
                    className={styles.databaseSourceIcon}
                    data-database-source-icon="database"
                    aria-hidden="true"
                  >
                    <Database size={15} />
                  </span>
                  <span className={styles.databaseSourceText}>
                    <span className={styles.databaseSourceTitle}>{result.title}</span>
                    <span className={styles.databaseSourcePath}>{result.description}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );

  return typeof document === "undefined" ? picker : createPortal(picker, document.body);
}
