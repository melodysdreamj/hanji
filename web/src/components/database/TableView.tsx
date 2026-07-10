"use client";

import {
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { copyTextWithMime, NOTIONLIKE_TABLE_ROWS_MIME } from "@/lib/clipboard";
import { isKoreanLocale, pickLabels } from "@/lib/i18n";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type {
  PageAwarenessMode,
  PageAwarenessTextRange,
  PagePresenceAwareness,
} from "@/lib/pagePresence";
import type {
  DbProperty,
  DbView,
  Page,
  PropertyConfig,
  SelectOption,
  PropertyType,
  TableCalculation,
} from "@/lib/types";
import { useStore, type DatabaseRowsQuery } from "@/lib/store";
import { newId, positionBetween } from "@/lib/ids";
import {
  applyView,
  applyViewFilterSeeds,
  effectiveFilterGroup,
  orderViewProperties,
  tableInitialLoadLimit,
  viewFilterSeedValues,
  visibleViewProperties,
} from "./query";
import { evaluateFormula, formatFormulaValue } from "./formula";
import { backendComputedValue } from "./computed";
import { normalizeFileAttachments } from "./files";
import { formatNumberValue, numberFormatForProperty } from "./numberFormat";
import { normalizePersonIds, personLabel } from "./people";
import { nextColor } from "./colors";
import {
  dateKey,
  extractEnd,
  formatDate,
  formatDateForProperty,
  formatNotionTimestamp,
  parseDate,
} from "./dateUtils";
import { usePropertyTypeChangeConfirm } from "./PropertyTypeChangeConfirm";
import { PropertyTypeConfig } from "./PropertyTypeConfig";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import {
  configForType,
  CREATABLE_PROPERTY_TYPES,
  PROPERTY_TYPES,
  localizedPropertyTypeLabel,
} from "./propertyTypes";
import { evaluateRollup, valueAsIds } from "./rollup";
import { chipStyle } from "./colors";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  Copy,
  DragHandleIcon,
  FilterIcon,
  LayoutIcon,
  Plus,
  PropertiesIcon,
  Search,
  SortIcon,
  SyncIcon,
  Trash,
  X,
} from "../icons";
import { PropValue } from "./PropValue";
import { PropertyCell } from "./PropertyCell";
import { useRowContextMenu } from "./useRowContextMenu";
import styles from "./database.module.css";

const TABLE_PROP_DRAG = "application/x-notionlike-db-property";
const TABLE_ROW_DRAG = "application/x-notionlike-db-row";
const DEFAULT_TITLE_WIDTH = 260;
const DEFAULT_PROP_WIDTH = 180;
const MIN_PROP_WIDTH = 96;
const MAX_PROP_WIDTH = 640;
const TABLE_ROW_GUTTER_WIDTH = 112;
const TABLE_PAGE_ROW_GUTTER_WIDTH = 64;
const TABLE_ADD_PROPERTY_WIDTH = 132;
// Inline databases live inside the page column, so the trailing add-property
// track must be able to shrink (down to the +/... buttons) instead of forcing
// the whole grid past the inline container's right edge.
const TABLE_INLINE_ADD_PROPERTY_MIN_WIDTH = 64;
const PROPERTY_HEADER_MENU_WIDTH = 360;
const CELL_FOCUS_SELECTOR = [
  'input:not([type="hidden"]):not(:disabled)',
  "textarea:not(:disabled)",
  "button:not(:disabled)",
  '[role="button"][tabindex]:not([aria-disabled="true"])',
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const TABLE_VIEW_LABELS = {
  en: {
    addDescription: "Add a description",
    addProperty: "Add a property",
    aiAutofill: "AI autofill",
    backToPropertyMenu: "Back to property menu",
    changeType: "Change type",
    clearSort: "Remove sort",
    closeAddPropertyMenu: "Close add property menu",
    comingSoon: "Coming soon",
    deleteProperty: "Delete property",
    description: "Description",
    duplicateProperty: "Duplicate property",
    editProperty: "Edit property",
    filter: "Filter",
    hide: "Hide",
    loadMore: "Load more",
    loadMoreAria: (remaining: number | undefined) =>
      `Load more rows${remaining === undefined ? "" : ` (${remaining} remaining)`}`,
    loadingMore: "Loading ...",
    manageInViewSettings: "Manage in view settings",
    moveLeft: "Move left",
    moveRight: "Move right",
    name: "Name",
    newPage: "New",
    newPageIn: (dbTitle: string) => `New page in ${dbTitle}`,
    noSearchResults: "No results",
    openInSidePeek: "Open in side peek",
    openRow: "Open",
    propertyOptions: "Property options",
    retry: "Try again",
    rowLoadErrorTitle: "Couldn't load database rows.",
    searchPropertyTypes: "Search property types",
    selectedCount: (count: number) => `${count} selected`,
    sortAscending: "Sort ascending",
    sortDescending: "Sort descending",
    type: "Type",
    unwrapText: "Unwrap text",
    wrapText: "Wrap text",
  },
  ko: {
    addDescription: "설명을 추가하세요",
    addProperty: "속성 추가",
    aiAutofill: "AI 자동 채우기",
    backToPropertyMenu: "속성 메뉴로 돌아가기",
    changeType: "유형 변경",
    clearSort: "정렬 해제",
    closeAddPropertyMenu: "속성 추가 메뉴 닫기",
    comingSoon: "준비 중",
    deleteProperty: "속성 삭제",
    description: "설명",
    duplicateProperty: "속성 복제",
    editProperty: "속성 편집",
    filter: "필터",
    hide: "숨기기",
    loadMore: "더 불러오기 ...",
    loadMoreAria: (remaining: number | undefined) =>
      `더 불러오기${remaining === undefined ? "" : ` (${remaining}개 남음)`}`,
    loadingMore: "불러오는 중 ...",
    manageInViewSettings: "보기 설정에서 관리",
    moveLeft: "왼쪽으로 이동",
    moveRight: "오른쪽으로 이동",
    name: "이름",
    newPage: "새 페이지",
    newPageIn: (dbTitle: string) => `새 페이지 추가 (${dbTitle})`,
    noSearchResults: "검색 결과가 없습니다",
    openInSidePeek: "사이드 보기에서 열기",
    openRow: "열기",
    propertyOptions: "속성 옵션",
    retry: "다시 시도",
    rowLoadErrorTitle: "데이터베이스 행을 불러오지 못했어요.",
    searchPropertyTypes: "속성 유형 검색",
    selectedCount: (count: number) => `${count}개 선택됨`,
    sortAscending: "오름차순 정렬",
    sortDescending: "내림차순 정렬",
    type: "유형",
    unwrapText: "콘텐츠 줄바꿈 해제하기",
    wrapText: "콘텐츠 줄바꿈하기",
  },
} as const;

function tableViewLabels() {
  return pickLabels(TABLE_VIEW_LABELS);
}

function tableActionLabels(text: string) {
  const koreanText = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text);
  return koreanText || isKoreanLocale() ? TABLE_VIEW_LABELS.ko : TABLE_VIEW_LABELS.en;
}

export function databaseCellAwarenessId(rowId: string, propertyId: string) {
  return `database-cell:${rowId}:${propertyId}`;
}

function remoteAwarenessText(awareness: PagePresenceAwareness, count: number) {
  const verb = awareness.mode === "selecting" ? "selecting" : "editing";
  return `${awareness.label} ${verb}${count > 1 ? ` +${count - 1}` : ""}`;
}

function remoteAwarenessInitials(awareness: PagePresenceAwareness) {
  const label = awareness.label.trim();
  if (!label) return "?";
  const emailPrefix = label.includes("@") ? label.split("@")[0] : label;
  const parts = emailPrefix.split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "?").toUpperCase();
}

function textRangeFromFocusTarget(target: EventTarget | null): PageAwarenessTextRange | undefined {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return undefined;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

// Reserved property key storing a row's sub-item parent (Notion-style nested rows).
const SUBITEM_KEY = "__subitemParent";

type TreeRow = { row: Page; depth: number; hasChildren: boolean };
type TableGroup = {
  key: string;
  label: string;
  color?: string;
  rank: number;
  rows: TreeRow[];
};
type TableGroupSubtotal = {
  propertyId: string;
  label: string;
  value: string;
};
type TableRenderItem =
  | { kind: "group"; group: TableGroup }
  | { kind: "row"; item: TreeRow };
type TableRowsClipboard = {
  version: 1;
  databaseId: string;
  rowIds: string[];
};

function menuButtons(root: HTMLDivElement | null) {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>("[data-menu-item]:not(:disabled)") ?? [])
    .filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
}

function menuFocusables(root: HTMLDivElement | null) {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
}

function moveMenuFocus(e: ReactKeyboardEvent<HTMLDivElement>, root: HTMLDivElement | null) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return;
  }
  const items = menuButtons(root);
  if (items.length === 0) return;

  e.preventDefault();
  e.stopPropagation();
  const activeIndex = items.findIndex((item) => item === document.activeElement);
  let nextIndex = activeIndex >= 0 ? activeIndex : 0;
  if (e.key === "ArrowDown") {
    nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
  } else if (e.key === "ArrowUp") {
    nextIndex = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
  } else if (e.key === "Home") {
    nextIndex = 0;
  } else if (e.key === "End") {
    nextIndex = items.length - 1;
  }
  items[nextIndex]?.focus();
}

function onTableMenuKeyDown(
  e: ReactKeyboardEvent<HTMLDivElement>,
  root: HTMLDivElement | null,
  onClose: () => void,
) {
  if (e.defaultPrevented) return;
  if (isComposingKeyEvent(e)) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    onClose();
    return;
  }
  if (e.key === "Tab") {
    const focusables = menuFocusables(root);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      e.stopPropagation();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
    return;
  }
  moveMenuFocus(e, root);
}

function isTextControl(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(target.type);
}

function canLeaveHorizontalCell(target: EventTarget | null, key: "ArrowLeft" | "ArrowRight") {
  if (!isTextControl(target)) return true;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  if (typeof start !== "number" || typeof end !== "number") return true;
  if (start !== end) return false;
  return key === "ArrowLeft" ? start === 0 : end === target.value.length;
}

function isInsideCellPopup(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('[role="dialog"], [role="listbox"], [role="menu"]');
}

function isEditingCellText(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (isTextControl(target)) return true;
  return target.isContentEditable || !!target.closest('[contenteditable="true"]');
}

function parseInternalRowsClipboard(data: DataTransfer, databaseId: string) {
  const raw = data.getData(NOTIONLIKE_TABLE_ROWS_MIME);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<TableRowsClipboard>;
    if (parsed.version !== 1 || parsed.databaseId !== databaseId || !Array.isArray(parsed.rowIds)) {
      return [];
    }
    return parsed.rowIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function parseTsv(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.includes("\t") && !normalized.includes("\n")) return null;
  const rows = normalized.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const parsed = rows.map((row) => row.split("\t"));
  if (parsed.length === 0 || (parsed.length === 1 && parsed[0].length <= 1)) return null;
  return parsed.some((row) => row.some((cell) => cell.length > 0)) ? parsed : null;
}

function fileNameFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return name || parsed.hostname || "File";
  } catch {
    return url.split("/").filter(Boolean).at(-1) || "File";
  }
}

function parseNumberInput(text: string) {
  const normalized = text.trim().replace(/[,\s$€₩%]/g, "");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

function parseCheckboxInput(text: string) {
  const value = text.trim().toLowerCase();
  if (!value) return false;
  if (["true", "yes", "y", "1", "checked", "check", "x", "☑", "✓"].includes(value)) return true;
  if (["false", "no", "n", "0", "unchecked", "☐"].includes(value)) return false;
  return undefined;
}

function parseDateInput(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const y = iso[1];
    const m = iso[2].padStart(2, "0");
    const d = iso[3].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

type OptionCacheEntry = {
  prop: DbProperty;
  options: SelectOption[];
  changed: boolean;
};

function optionIdForLabel(
  prop: DbProperty,
  label: string,
  optionCache: Map<string, OptionCacheEntry>
) {
  const name = label.trim();
  if (!name) return null;
  let entry = optionCache.get(prop.id);
  if (!entry) {
    entry = { prop, options: [...(prop.config?.options ?? [])], changed: false };
    optionCache.set(prop.id, entry);
  }
  const existing = entry.options.find((option) => option.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const option = { id: newId(), name, color: nextColor(entry.options.length) };
  entry.options.push(option);
  entry.changed = true;
  return option.id;
}

type TableCalculationOption = { value: TableCalculation | "none"; label: string };

const BASE_TABLE_CALCULATIONS: TableCalculationOption[] = [
  { value: "none", label: "None" },
  { value: "count_all", label: "Count all" },
  { value: "count_values", label: "Count values" },
  { value: "count_unique", label: "Count unique" },
  { value: "count_empty", label: "Count empty" },
  { value: "percent_empty", label: "Percent empty" },
  { value: "percent_not_empty", label: "Percent not empty" },
];

const CHECKBOX_TABLE_CALCULATIONS: TableCalculationOption[] = [
  { value: "checked", label: "Checked" },
  { value: "unchecked", label: "Unchecked" },
  { value: "percent_checked", label: "Percent checked" },
  { value: "percent_unchecked", label: "Percent unchecked" },
];

const NUMBER_TABLE_CALCULATIONS: TableCalculationOption[] = [
  { value: "sum", label: "Sum" },
  { value: "average", label: "Average" },
  { value: "median", label: "Median" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "range", label: "Range" },
];

const DATE_TABLE_CALCULATIONS: TableCalculationOption[] = [
  { value: "earliest_date", label: "Earliest date" },
  { value: "latest_date", label: "Latest date" },
  { value: "date_range", label: "Date range" },
];

function tableCalculationsFor(prop: DbProperty): TableCalculationOption[] {
  const options = [...BASE_TABLE_CALCULATIONS];
  if (prop.type === "checkbox") options.push(...CHECKBOX_TABLE_CALCULATIONS);
  if (prop.type === "number" || prop.type === "formula" || prop.type === "rollup") {
    options.push(...NUMBER_TABLE_CALCULATIONS);
  }
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    options.push(...DATE_TABLE_CALCULATIONS);
  }
  return options;
}

function tableCalculationLabel(calculation: TableCalculation) {
  return (
    [
      ...BASE_TABLE_CALCULATIONS,
      ...CHECKBOX_TABLE_CALCULATIONS,
      ...NUMBER_TABLE_CALCULATIONS,
      ...DATE_TABLE_CALCULATIONS,
    ].find((item) => item.value === calculation)?.label.toUpperCase() ?? "CALCULATE"
  );
}

function copyPropertyName(props: DbProperty[], name: string) {
  const base = `${name.trim() || "Untitled"} copy`;
  const names = new Set(props.map((prop) => prop.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${newId().slice(0, 4)}`;
}

function clonePropertyConfig(config?: PropertyConfig) {
  return config ? (JSON.parse(JSON.stringify(config)) as PropertyConfig) : undefined;
}

function isTableGroupProperty(prop: DbProperty | undefined): prop is DbProperty {
  return prop?.type === "select" || prop?.type === "status" || prop?.type === "date";
}

function firstOptionValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw == null || raw === "" ? null : String(raw);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function relativeDateGroup(date: Date | null, prop: DbProperty): Omit<TableGroup, "rows"> {
  const korean = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(prop.name);
  if (!date) {
    return {
      key: "__none",
      label: korean ? "날짜 없음" : `No ${prop.name}`,
      rank: 600,
    };
  }
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diff < -1) return { key: "relative:past", label: korean ? "지난 날짜" : "Past", rank: 100 };
  if (diff === -1) return { key: "relative:yesterday", label: korean ? "어제" : "Yesterday", rank: 200 };
  if (diff === 0) return { key: "relative:today", label: korean ? "오늘" : "Today", rank: 300 };
  if (diff === 1) return { key: "relative:tomorrow", label: korean ? "내일" : "Tomorrow", rank: 400 };
  if (diff <= 7) return { key: "relative:next-7", label: korean ? "다음 7일" : "Next 7 days", rank: 500 };
  return { key: "relative:later", label: korean ? "나중" : "Later", rank: 550 };
}

function groupedTableRows(treeRows: TreeRow[], groupProp: DbProperty | undefined): TableGroup[] {
  if (!isTableGroupProperty(groupProp)) return [{ key: "__all", label: "", rank: 0, rows: treeRows }];
  if (groupProp.type === "date") {
    const groups = new Map<string, TableGroup>();
    for (const item of treeRows) {
      const group = relativeDateGroup(parseDate(item.row.properties?.[groupProp.id]), groupProp);
      const existing = groups.get(group.key);
      if (existing) {
        existing.rows.push(item);
      } else {
        groups.set(group.key, { ...group, rows: [item] });
      }
    }
    return Array.from(groups.values()).sort((a, b) => a.rank - b.rank);
  }

  const options = groupProp.config?.options ?? [];
  const statusDefault = groupProp.type === "status" ? options[0] : undefined;
  const groups = new Map<string, TableGroup>();

  function ensure(key: string, label: string, rank: number, color?: string) {
    const existing = groups.get(key);
    if (existing) return existing;
    const group = { key, label, color, rank, rows: [] };
    groups.set(key, group);
    return group;
  }

  for (const [index, option] of options.entries()) ensure(option.id, option.name, index, option.color);
  const none = ensure("__none", `No ${groupProp.name}`, options.length + 100);

  for (const item of treeRows) {
    const value = firstOptionValue(item.row.properties?.[groupProp.id]) ?? statusDefault?.id ?? "__none";
    const option = options.find((candidate) => candidate.id === value);
    const group = option
      ? ensure(option.id, option.name, options.findIndex((candidate) => candidate.id === option.id), option.color)
      : value === "__none"
        ? none
        : ensure(`unknown:${value}`, value, options.length + 50);
    group.rows.push(item);
  }

  return Array.from(groups.values())
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => a.rank - b.rank);
}

function tableGroupSubtotals({
  group,
  visible,
  tableCalculations,
  props,
  pagesById,
  propsByDb,
}: {
  group: TableGroup;
  visible: DbProperty[];
  tableCalculations: Record<string, TableCalculation | undefined>;
  props: DbProperty[];
  pagesById: Record<string, Page>;
  propsByDb: Record<string, DbProperty[]>;
}): TableGroupSubtotal[] {
  const rows = group.rows.map((item) => item.row);
  return visible.flatMap((prop) => {
    const calculation = tableCalculations[prop.id];
    if (!calculation || !tableCalculationsFor(prop).some((item) => item.value === calculation)) return [];
    const summary = summarizeColumn(calculation, prop, props, rows, pagesById, propsByDb);
    if (!summary.value) return [];
    return [{ propertyId: prop.id, label: summary.label, value: summary.value }];
  });
}

export function TableView({
  db,
  view,
  rows: rowsProp,
  rowQuery,
  readOnly = false,
  search,
  loadingRows = false,
  placement = "page",
  contextPageId,
  selectionChromeSlotId,
  publishAwareness,
  remoteAwarenessByBlock = {},
  onEditRowProperties,
  onOpenRow,
  onOpenRowIn,
  onWarmRow,
}: {
  db: Page;
  view: DbView;
  rows?: Page[];
  rowQuery?: DatabaseRowsQuery;
  readOnly?: boolean;
  search?: string;
  loadingRows?: boolean;
  placement?: "page" | "inline";
  contextPageId?: string;
  selectionChromeSlotId?: string;
  publishAwareness?: (
    blockId: string,
    mode: PageAwarenessMode,
    selectedBlockIds?: string[],
    textRange?: PageAwarenessTextRange,
  ) => void;
  remoteAwarenessByBlock?: Record<string, PagePresenceAwareness[]>;
  onEditRowProperties?: (pageId: string) => void;
  onOpenRow?: (pageId: string) => void;
  onOpenRowIn?: (pageId: string, mode: "side" | "center" | "full") => void;
  onWarmRow?: (pageId: string) => void;
}) {
  const router = useRouter();
  const tableRef = useRef<HTMLDivElement>(null);
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const rowPage = useStore(useShallow((s) => s.databaseRowPagesByDb[db.id]));
  const loadDatabaseRows = useStore((s) => s.loadDatabaseRows);
  const loadMoreDatabaseRows = useStore((s) => s.loadMoreDatabaseRows);
  const addProperty = useStore((s) => s.addProperty);
  const addRow = useStore((s) => s.addRow);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const moveDatabaseRow = useStore((s) => s.moveDatabaseRow);
  const updateProperty = useStore((s) => s.updateProperty);
  const userId = useStore((s) => s.userId);
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const propsByDb = useStore(useShallow((s) => s.propsByDb));
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [draggingRowIds, setDraggingRowIds] = useState<Set<string>>(() => new Set());
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [dragOverSide, setDragOverSide] = useState<"before" | "after">("before");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(() => new Set());
  const [lastSelectedRowId, setLastSelectedRowId] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const [titleFocusRowId, setTitleFocusRowId] = useState<string | null>(null);
  const [copiedRows, setCopiedRows] = useState(false);
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [selectionChromeSlot, setSelectionChromeSlot] = useState<HTMLElement | null>(null);
  const initialRowLimit = tableInitialLoadLimit(view);
  const [visibleRowLimit, setVisibleRowLimit] = useState(initialRowLimit);
  // Transient column width while a header resize drag is in flight. Keeping it
  // in local state (instead of writing view config per pointermove) means the
  // drag repaints live without firing a persisted sync write per frame.
  const [resizePreview, setResizePreview] = useState<{ propId: string; width: number } | null>(
    null
  );
  const trashPage = useStore((s) => s.trashPage);
  const restorePage = useStore((s) => s.restorePage);
  const duplicatePage = useStore((s) => s.duplicatePage);
  const notify = useStore((s) => s.notify);
  const { openRowContextMenuAt, rowContextMenu } = useRowContextMenu({
    onEditProperties: onEditRowProperties,
    onOpenRowIn,
  });
  const tableShortcutRef = useRef<{
    shown: Page[];
    selectedCount: number;
    clearSelection: () => void;
    copySelected: () => void;
    duplicateSelected: () => void;
    deleteSelected: () => void;
    indentSelectedRows: () => void;
    outdentSelectedRows: () => void;
  } | null>(null);

  const groupProp = isTableGroupProperty(props.find((p) => p.id === view.config?.groupBy))
    ? props.find((p) => p.id === view.config?.groupBy)
    : undefined;
  const visible = visibleViewProperties(props, view).filter(
    (prop) => !(view.config?.notionViewId && groupProp && prop.id === groupProp.id)
  );
  // Memoized: applyView runs a full search-filter + filter-group + multi-key
  // sort over every loaded row, so recomputing it on high-frequency state
  // changes (drag-over, hover, selection) was a re-render hotspot. Inputs are
  // stable across those renders (useShallow props/pagesById, prop-provided
  // view/search/contextPageId), so it recomputes only when the data changes.
  const shown = useMemo(
    () => applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [rows, props, view, pagesById, search, contextPageId]
  );
  const hasSearchQuery = !!(search ?? "").trim();
  const hasViewFilters = !!effectiveFilterGroup(view.config);
  const rowLoadError = !loadingRows && rows.length === 0 && rowPage?.error ? rowPage.error : "";
  const inlineEmptyTablePreview =
    placement === "inline" &&
    !loadingRows &&
    !rowLoadError &&
    rows.length === 0 &&
    !hasSearchQuery &&
    !hasViewFilters &&
    shown.length === 0;
  const updateView = useStore((s) => s.updateView);
  const canReorderRows = (view.config?.sorts ?? []).length === 0;
  const dbTitle = pageDisplayTitle(db);
  // The dictionary EN strings equal the old hardcoded fallback ("New" /
  // `New page in …`), so full-page native tables localize too with EN output
  // byte-identical (several smokes select these EN labels).
  const newRowText = tableViewLabels().newPage;
  const newPageLabel = tableViewLabels().newPageIn(dbTitle);
  const tableCalculations = view.config?.tableCalculations ?? {};
  const hasVisibleCalculation = visible.some((prop) => {
    const calculation = tableCalculations[prop.id];
    return !!calculation && tableCalculationsFor(prop).some((item) => item.value === calculation);
  });

  const wrappedColumns = new Set(view.config?.wrappedColumns ?? []);

  // Build the sub-item tree from the (filtered/sorted) rows: a row references its
  // parent via the reserved SUBITEM_KEY property. Rows whose parent isn't in the
  // current result become roots (so children of a filtered-out parent still show).
  const shownIds = new Set(shown.map((r) => r.id));
  const childrenByParent = new Map<string, Page[]>();
  const rootRows: Page[] = [];
  for (const row of shown) {
    const parent = row.properties?.[SUBITEM_KEY];
    const parentId = typeof parent === "string" && shownIds.has(parent) ? parent : null;
    if (parentId) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(row);
      childrenByParent.set(parentId, list);
    } else {
      rootRows.push(row);
    }
  }
  const allTreeRows: TreeRow[] = [];
  const pushTree = (row: Page, depth: number) => {
    const kids = childrenByParent.get(row.id) ?? [];
    allTreeRows.push({ row, depth, hasChildren: kids.length > 0 });
    if (kids.length && expandedRows.has(row.id)) {
      for (const kid of kids) pushTree(kid, depth + 1);
    }
  };
  for (const row of rootRows) pushTree(row, 0);
  const hasHiddenLocalRows = allTreeRows.length > visibleRowLimit;
  const hasRemoteMoreRows = rowPage?.hasMore === true;
  const hasMoreRows = hasHiddenLocalRows || hasRemoteMoreRows;
  const treeRows = allTreeRows.slice(0, visibleRowLimit);
  const displayTreeRows = useMemo(
    () => (inlineEmptyTablePreview ? [] : treeRows),
    [inlineEmptyTablePreview, treeRows],
  );
  const renderedRows = displayTreeRows.map((item) => item.row);
  const remainingRowCount = hasHiddenLocalRows
    ? allTreeRows.length - treeRows.length
    : typeof rowPage?.totalCount === "number"
      ? Math.max(0, rowPage.totalCount - (rowPage.loadedCount ?? rows.length))
      : undefined;
  const selectedShown = renderedRows.filter((row) => selectedRows.has(row.id));
  const allSelected = renderedRows.length > 0 && selectedShown.length === renderedRows.length;
  const rowIndexById = new Map(displayTreeRows.map((item, index) => [item.row.id, index]));
  const tableHasSubitems = displayTreeRows.some((item) => item.depth > 0 || item.hasChildren);
  const tableGroups = groupedTableRows(displayTreeRows, groupProp);
  const renderItems: TableRenderItem[] = groupProp
    ? tableGroups.flatMap((group) => [
        { kind: "group", group } as TableRenderItem,
        ...group.rows.map((item) => ({ kind: "row", item } as TableRenderItem)),
      ])
    : displayTreeRows.map((item) => ({ kind: "row", item }));

  function toggleExpanded(id: string) {
    setExpandedRows((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleRowSelected(id: string, selected: boolean, range = false) {
    const orderedIds = treeRows.map((item) => item.row.id);
    const lastIndex = lastSelectedRowId ? orderedIds.indexOf(lastSelectedRowId) : -1;
    const currentIndex = orderedIds.indexOf(id);
    setSelectedRows((cur) => {
      const next = new Set(cur);
      if (range && lastIndex >= 0 && currentIndex >= 0) {
        const [start, end] =
          lastIndex < currentIndex ? [lastIndex, currentIndex] : [currentIndex, lastIndex];
        for (const rowId of orderedIds.slice(start, end + 1)) {
          if (selected) next.add(rowId);
          else next.delete(rowId);
        }
      } else if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    setLastSelectedRowId(id);
  }
  function toggleSelectAll() {
    setSelectedRows(allSelected ? new Set() : new Set(renderedRows.map((row) => row.id)));
    setLastSelectedRowId(null);
  }
  function clearSelection() {
    setSelectedRows(new Set());
    setLastSelectedRowId(null);
    setSelectionMenuOpen(false);
  }

  function publishCellAwareness(
    rowId: string,
    propertyId: string,
    mode: PageAwarenessMode,
    target?: EventTarget | null,
  ) {
    if (readOnly || !publishAwareness) return;
    const awarenessId = databaseCellAwarenessId(rowId, propertyId);
    publishAwareness(
      awarenessId,
      mode,
      mode === "idle" ? [] : [awarenessId],
      mode === "idle" ? undefined : textRangeFromFocusTarget(target ?? null),
    );
  }

  function onCellFocus(rowId: string, propertyId: string, e: ReactFocusEvent<HTMLDivElement>) {
    publishCellAwareness(rowId, propertyId, "editing", e.target);
  }

  function onCellBlur(rowId: string, propertyId: string, e: ReactFocusEvent<HTMLDivElement>) {
    const nextTarget = e.relatedTarget;
    if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
    publishCellAwareness(rowId, propertyId, "idle");
  }

  function onCellPointerUp(rowId: string, propertyId: string, e: ReactMouseEvent<HTMLDivElement>) {
    publishCellAwareness(rowId, propertyId, "editing", e.target);
  }

  function onCellKeyUp(rowId: string, propertyId: string, e: ReactKeyboardEvent<HTMLDivElement>) {
    publishCellAwareness(rowId, propertyId, "editing", e.target);
  }

  function hasSelectedRowAncestor(row: Page) {
    let parentId = row.properties?.[SUBITEM_KEY];
    while (typeof parentId === "string") {
      if (selectedRows.has(parentId)) return true;
      parentId = pagesById[parentId]?.properties?.[SUBITEM_KEY];
    }
    return false;
  }

  function selectedRootTreeRows() {
    return treeRows.filter((item) => selectedRows.has(item.row.id) && !hasSelectedRowAncestor(item.row));
  }

  function indentTargetForSelectedRows() {
    const roots = selectedRootTreeRows();
    if (roots.length === 0) return null;
    const firstIndex = treeRows.findIndex((item) => item.row.id === roots[0].row.id);
    if (firstIndex <= 0) return null;
    for (let index = firstIndex - 1; index >= 0; index -= 1) {
      const candidate = treeRows[index]?.row;
      if (candidate && !selectedRows.has(candidate.id)) return candidate;
    }
    return null;
  }

  function canIndentSelectedRows() {
    return !readOnly && !!indentTargetForSelectedRows();
  }

  function canOutdentSelectedRows() {
    return !readOnly && selectedRootTreeRows().some((item) => typeof item.row.properties?.[SUBITEM_KEY] === "string");
  }

  function indentSelectedRows() {
    if (readOnly) return;
    const parent = indentTargetForSelectedRows();
    if (!parent) return;
    for (const item of selectedRootTreeRows()) {
      if (item.row.id === parent.id) continue;
      setRowProperty(item.row.id, SUBITEM_KEY, parent.id, { debounce: false });
    }
    setExpandedRows((cur) => new Set(cur).add(parent.id));
  }

  function outdentSelectedRows() {
    if (readOnly) return;
    const expandedParentIds = new Set<string>();
    for (const item of selectedRootTreeRows()) {
      const parentId = item.row.properties?.[SUBITEM_KEY];
      if (typeof parentId !== "string") continue;
      const parent = pagesById[parentId];
      const grandparentId = parent?.properties?.[SUBITEM_KEY];
      const properties = { ...(item.row.properties ?? {}) };
      if (typeof grandparentId === "string") {
        properties[SUBITEM_KEY] = grandparentId;
        expandedParentIds.add(grandparentId);
      } else {
        delete properties[SUBITEM_KEY];
      }
      updatePage(item.row.id, { properties });
    }
    if (expandedParentIds.size > 0) {
      setExpandedRows((cur) => new Set([...cur, ...expandedParentIds]));
    }
  }

  async function deleteSelected() {
    if (readOnly) return;
    const ids = selectedShown.map((row) => row.id);
    if (ids.length === 0) return;
    clearSelection();
    try {
      for (const id of ids) await trashPage(id);
      notify(ids.length === 1 ? "Moved row to Trash" : `Moved ${ids.length} rows to Trash`, "success", {
        label: "Undo",
        onClick: async () => {
          for (const id of ids) await restorePage(id);
          notify(ids.length === 1 ? "Restored row" : `Restored ${ids.length} rows`, "success");
        },
      });
    } catch {
      notify("Couldn't move rows to Trash", "error");
    }
  }
  async function duplicateSelected() {
    if (readOnly) return;
    const ids = selectedShown.map((row) => row.id);
    if (ids.length === 0) return;
    clearSelection();
    try {
      let copiedCount = 0;
      for (const id of ids) {
        const copy = await duplicatePage(id);
        if (copy) copiedCount += 1;
      }
      if (copiedCount === 0) {
        notify("Couldn't duplicate rows", "error");
      } else {
        notify(
          copiedCount === 1 ? "Duplicated row" : `Duplicated ${copiedCount} rows`,
          "success"
        );
      }
    } catch {
      notify("Couldn't duplicate rows", "error");
    }
  }
  async function copySelected() {
    const text = rowsToTsv(selectedShown, visible, props, pagesById, propsByDb);
    const payload: TableRowsClipboard = {
      version: 1,
      databaseId: db.id,
      rowIds: selectedShown.map((row) => row.id),
    };
    const ok = await copyTextWithMime(text, NOTIONLIKE_TABLE_ROWS_MIME, JSON.stringify(payload));
    setCopiedRows(ok);
    if (ok) window.setTimeout(() => setCopiedRows(false), 1200);
    notify(
      ok
        ? selectedShown.length === 1
          ? "Copied row to clipboard"
          : "Copied rows to clipboard"
        : "Couldn't copy rows",
      ok ? "success" : "error"
    );
  }

  useLayoutEffect(() => {
    tableShortcutRef.current = {
      shown: renderedRows,
      selectedCount: selectedShown.length,
      clearSelection,
      copySelected: () => void copySelected(),
      duplicateSelected: () => void duplicateSelected(),
      deleteSelected: () => void deleteSelected(),
      indentSelectedRows,
      outdentSelectedRows,
    };
  });

  useEffect(() => {
    if (selectedShown.length === 0) setSelectionMenuOpen(false);
  }, [selectedShown.length]);

  useEffect(() => {
    setVisibleRowLimit(initialRowLimit);
  }, [db.id, initialRowLimit, search, view.config, view.id]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || isComposingKeyEvent(e)) return;
      const target = e.target as HTMLElement | null;
      const insideTable = !!target && !!tableRef.current?.contains(target);
      const insideSelectionBar = !!target?.closest("[data-table-selection-bar]");
      if (!insideTable && !insideSelectionBar) return;
      if (isInsideCellPopup(target)) return;

      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && key === "a" && !isEditingCellText(target)) {
        const state = tableShortcutRef.current;
        if (!state || state.shown.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        setSelectedRows(new Set(state.shown.map((row) => row.id)));
        setLastSelectedRowId(null);
        return;
      }

      const state = tableShortcutRef.current;
      if (!state || state.selectedCount === 0) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        state.clearSelection();
        tableRef.current?.focus();
        return;
      }

      if (isEditingCellText(target)) return;

      if (!mod && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) state.outdentSelectedRows();
        else state.indentSelectedRows();
        return;
      }

      if (mod && !e.altKey && !e.shiftKey && key === "c") {
        e.preventDefault();
        e.stopPropagation();
        state.copySelected();
        return;
      }

      if (mod && !e.altKey && !e.shiftKey && key === "d") {
        e.preventDefault();
        e.stopPropagation();
        state.duplicateSelected();
        return;
      }

      if (!mod && !e.altKey && !e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        e.stopPropagation();
        state.deleteSelected();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const titlePropertyId = props.find((prop) => prop.type === "title")?.id ?? null;
  const displayColumnWidth = (prop: DbProperty) =>
    resizePreview && resizePreview.propId === prop.id
      ? resizePreview.width
      : columnWidth(prop, view);
  const propertyGridWidth = visible.reduce((sum, prop) => sum + displayColumnWidth(prop), 0);
  const propertyGridTemplate = visible.map((prop) => `${displayColumnWidth(prop)}px`).join(" ");
  const showRowGutter = !readOnly && !inlineEmptyTablePreview;
  const tableRowGutterWidth =
    showRowGutter && placement === "page"
      ? TABLE_PAGE_ROW_GUTTER_WIDTH
      : showRowGutter
        ? TABLE_ROW_GUTTER_WIDTH
        : 0;
  const tableGutterStyle = {
    "--table-gutter-width": `${tableRowGutterWidth}px`,
  } as CSSProperties;
  const gridTemplate = showRowGutter
    ? `${tableRowGutterWidth}px ${propertyGridTemplate}`
    : propertyGridTemplate;
  const emptyPreviewPropertyGridTemplate = propertyGridTemplate || `${DEFAULT_TITLE_WIDTH}px`;
  const emptyPreviewGridTemplate =
    inlineEmptyTablePreview && !readOnly
      ? `${emptyPreviewPropertyGridTemplate} minmax(220px, 1fr)`
      : gridTemplate;
  const addPropertyMinWidth =
    placement === "inline" ? TABLE_INLINE_ADD_PROPERTY_MIN_WIDTH : TABLE_ADD_PROPERTY_WIDTH;
  const headerGridTemplate = readOnly
    ? gridTemplate
    : inlineEmptyTablePreview
      ? emptyPreviewGridTemplate
      : `${gridTemplate} minmax(${addPropertyMinWidth}px, 1fr)`;
  const shouldRenderTrailingGridCell = !readOnly && !inlineEmptyTablePreview;
  const bodyGridTemplate = shouldRenderTrailingGridCell ? headerGridTemplate : gridTemplate;
  const tableGridMinWidth = tableRowGutterWidth + propertyGridWidth;
  const headerMinWidth =
    !readOnly && !inlineEmptyTablePreview
      ? tableGridMinWidth + addPropertyMinWidth
      : undefined;
  const tableHeadStyle: CSSProperties = {
    gridTemplateColumns: headerGridTemplate,
    ...(headerMinWidth ? { minWidth: `${headerMinWidth}px` } : {}),
  };
  const inlineEmptyPreviewRowCount = inlineEmptyTablePreview ? 3 : 0;
  const showSummaryRow = !inlineEmptyTablePreview && (hasVisibleCalculation || shown.length > 1);
  const selectionQuickProperties = visible
    .filter((prop) => prop.id !== titlePropertyId)
    .slice(0, 3);
  // Localize for ALL views (the dict already routes by locale); the old
  // imported-only gate left native views' chrome in English under a ko locale.
  const selectedRowsLabel = tableViewLabels().selectedCount(selectedShown.length);

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    setSelectionChromeSlot(
      selectionChromeSlotId ? document.getElementById(selectionChromeSlotId) : null
    );
  }, [selectionChromeSlotId]);

  useLayoutEffect(() => {
    if (!titleFocusRowId) return;
    if (focusTitleCell(titleFocusRowId)) setTitleFocusRowId(null);
  }, [displayTreeRows, titleFocusRowId]);

  function reorderProperty(sourceId: string, targetId: string) {
    if (readOnly) return;
    if (!sourceId || sourceId === targetId) return;
    const ids = orderViewProperties(props, view).map((prop) => prop.id);
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = ids.splice(sourceIndex, 1);
    // Removing the source shifts everything after it left by one, so when the
    // source sat before the target the target index must be decremented to drop
    // the column at the intended position (insert directly before the target).
    const insertAt = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    ids.splice(insertAt, 0, source);
    const visibleIds = view.config?.visibleProperties
      ? new Set(view.config.visibleProperties)
      : null;
    const nextVisibleProperties = visibleIds
      ? ids.filter((id) => visibleIds.has(id))
      : undefined;
    updateView(view.id, {
      config: {
        ...view.config,
        propertyOrder: ids,
        ...(nextVisibleProperties ? { visibleProperties: nextVisibleProperties } : {}),
      },
    });
  }

  const openRow = useCallback(
    (pageId: string) => {
      if (onOpenRow) {
        onOpenRow(pageId);
      } else {
        router.push(pageHref(pageId));
      }
    },
    [onOpenRow, router],
  );

  function openRowClick(pageId: string, e: React.MouseEvent<HTMLElement>) {
    if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
    else openRow(pageId);
  }

  function openKeyboardRowMenu(pageId: string, target: EventTarget | null) {
    const el = target instanceof HTMLElement ? target : null;
    const cell = el?.closest<HTMLElement>("[data-table-cell]");
    const row = cell?.closest<HTMLElement>(`.${styles.tableRow}`);
    const rect = row?.getBoundingClientRect() ?? cell?.getBoundingClientRect();
    if (!selectedRows.has(pageId)) {
      setSelectedRows(new Set([pageId]));
    }
    setLastSelectedRowId(pageId);
    openRowContextMenuAt(
      pageId,
      rect ? { x: rect.left + 24, y: rect.top + Math.min(rect.height, 32) } : { x: 16, y: 16 },
      el ?? cell ?? row,
    );
  }

  function openTableRowContextMenu(
    pageId: string,
    e: ReactMouseEvent<HTMLElement>,
    anchor: HTMLElement = e.currentTarget,
  ) {
    if (isInsideCellPopup(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    if (!selectedRows.has(pageId)) {
      setSelectedRows(new Set([pageId]));
    }
    setLastSelectedRowId(pageId);

    const rect = anchor.getBoundingClientRect();
    const keyboardFallback = e.clientX === 0 && e.clientY === 0;
    openRowContextMenuAt(
      pageId,
      keyboardFallback
        ? { x: rect.left + 16, y: rect.top + Math.min(rect.height, 32) }
        : { x: e.clientX, y: e.clientY },
      anchor,
    );
  }

  function onTableContextMenuCapture(e: ReactMouseEvent<HTMLDivElement>) {
    if (isInsideCellPopup(e.target)) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const rowEl = target.closest("[data-table-row-id]") as HTMLElement | null;
    if (!rowEl || !tableRef.current?.contains(rowEl)) return;
    const rowId = rowEl.dataset.tableRowId;
    if (!rowId) return;
    openTableRowContextMenu(rowId, e, rowEl);
  }

  async function createRow() {
    if (readOnly) return;
    const row = await addRow(db.id, true, undefined, { focusTitle: false });
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
    setSelectedRows(new Set());
    setLastSelectedRowId(null);
    setTitleFocusRowId(row.id);
  }

  async function loadMoreRows() {
    if (hasHiddenLocalRows) {
      setVisibleRowLimit((current) => Math.min(allTreeRows.length, current + initialRowLimit));
      return;
    }
    if (!hasRemoteMoreRows || rowPage?.loadingMore) return;
    setVisibleRowLimit((current) => current + initialRowLimit);
    await loadMoreDatabaseRows(db.id, rowQuery);
  }

  async function createRowAfter(anchorId: string) {
    if (readOnly) return;
    const row = await addRow(db.id, true, undefined, { focusTitle: false });
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
    if (canReorderRows) {
      await moveDatabaseRow(row.id, anchorId, "after");
    }
    setSelectedRows(new Set());
    setLastSelectedRowId(null);
    setTitleFocusRowId(row.id);
  }

  function focusNewRow() {
    const next = tableRef.current?.querySelector<HTMLButtonElement>("[data-table-new-row]");
    next?.focus();
    next?.scrollIntoView({ block: "nearest", inline: "nearest" });
    return !!next;
  }

  function focusTitleCell(rowId: string) {
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-table-row-id="${rowId}"]`);
    const cell = row?.querySelector<HTMLElement>('[data-table-cell][data-title="true"]');
    const editor = cell?.querySelector<HTMLElement>("[data-cell-editor]") ?? cell;
    const focusTarget = editor?.querySelector<HTMLElement>(CELL_FOCUS_SELECTOR);
    if (!cell || !focusTarget) return false;
    focusTarget.focus();
    if (focusTarget instanceof HTMLInputElement || focusTarget instanceof HTMLTextAreaElement) {
      const caret = focusTarget.value.length;
      focusTarget.setSelectionRange(caret, caret);
    }
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }

  function focusCell(rowIndex: number, colIndex: number) {
    if (visible.length === 0) return false;
    if (colIndex < 0) {
      if (rowIndex <= 0) return false;
      return focusCell(rowIndex - 1, visible.length - 1);
    }
    if (colIndex >= visible.length) return focusCell(rowIndex + 1, 0);
    if (rowIndex < 0) return false;
    if (rowIndex >= treeRows.length) return focusNewRow();

    const cell = tableRef.current?.querySelector<HTMLElement>(
      `[data-table-cell][data-row-index="${rowIndex}"][data-col-index="${colIndex}"]`
    );
    if (!cell) return false;

    const editor = cell.querySelector<HTMLElement>("[data-cell-editor]") ?? cell;
    const focusTarget = editor.querySelector<HTMLElement>(CELL_FOCUS_SELECTOR) ?? cell;
    focusTarget.focus();
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }

  function focusLinearCell(rowIndex: number, colIndex: number, delta: -1 | 1) {
    const colCount = visible.length;
    if (colCount === 0) return false;
    const nextIndex = rowIndex * colCount + colIndex + delta;
    if (nextIndex < 0) return false;
    if (nextIndex >= treeRows.length * colCount) return focusNewRow();
    return focusCell(Math.floor(nextIndex / colCount), nextIndex % colCount);
  }

  function onCellKeyDown(
    e: ReactKeyboardEvent<HTMLDivElement>,
    rowIndex: number,
    colIndex: number
  ) {
    if (
      !e.defaultPrevented &&
      !isComposingKeyEvent(e) &&
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key === "Enter" &&
      !isInsideCellPopup(e.target)
    ) {
      const row = treeRows[rowIndex]?.row;
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      openRow(row.id);
      return;
    }

    if (
      !e.defaultPrevented &&
      !isComposingKeyEvent(e) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) &&
      !isInsideCellPopup(e.target)
    ) {
      const row = treeRows[rowIndex]?.row;
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      openKeyboardRowMenu(row.id, e.target);
      return;
    }

    if (
      e.defaultPrevented ||
      isComposingKeyEvent(e) ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      isInsideCellPopup(e.target)
    ) {
      return;
    }

    if (e.key === "Tab") {
      if (focusLinearCell(rowIndex, colIndex, e.shiftKey ? -1 : 1)) e.preventDefault();
      return;
    }

    if (e.key === "Enter" && isTextControl(e.target)) {
      if (focusCell(rowIndex + (e.shiftKey ? -1 : 1), colIndex)) e.preventDefault();
      return;
    }

    if (e.shiftKey) return;

    if (e.key === "ArrowUp") {
      if (focusCell(rowIndex - 1, colIndex)) e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (focusCell(rowIndex + 1, colIndex)) e.preventDefault();
    } else if (e.key === "ArrowLeft" && canLeaveHorizontalCell(e.target, "ArrowLeft")) {
      const row = treeRows[rowIndex]?.row;
      if (colIndex === 0 && row && childrenByParent.has(row.id) && expandedRows.has(row.id)) {
        e.preventDefault();
        setExpandedRows((cur) => {
          const next = new Set(cur);
          next.delete(row.id);
          return next;
        });
        return;
      }
      if (focusCell(rowIndex, colIndex - 1)) e.preventDefault();
    } else if (e.key === "ArrowRight" && canLeaveHorizontalCell(e.target, "ArrowRight")) {
      const row = treeRows[rowIndex]?.row;
      if (colIndex === 0 && row && childrenByParent.has(row.id) && !expandedRows.has(row.id)) {
        e.preventDefault();
        setExpandedRows((cur) => new Set(cur).add(row.id));
        return;
      }
      if (focusCell(rowIndex, colIndex + 1)) e.preventDefault();
    }
  }

  function relationIdsForText(prop: DbProperty, text: string) {
    const targetDbId = prop.config?.relationDatabaseId;
    if (!targetDbId) return undefined;
    const labels = text.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
    if (labels.length === 0) return null;
    const candidates = Object.values(pagesById).filter(
      (page) => page.parentType === "database" && page.parentId === targetDbId && !page.inTrash
    );
    const ids = labels
      .map((label) =>
        candidates.find((page) => pageDisplayTitle(page).toLowerCase() === label.toLowerCase())?.id
      )
      .filter((id): id is string => !!id);
    return ids.length ? ids : undefined;
  }

  function personIdsForText(text: string) {
    const label = text.trim().toLowerCase();
    if (!label) return null;
    const id = userId || "local-user";
    const currentLabel = personLabel(id, userId).toLowerCase();
    if (label === "me" || label === "you" || label === currentLabel) return [id];
    return undefined;
  }

  function pastedValueForProp(
    prop: DbProperty,
    text: string,
    optionCache: Map<string, OptionCacheEntry>
  ) {
    const trimmed = text.trim();
    if (prop.type === "title" || prop.type === "rich_text" || prop.type === "url" || prop.type === "email" || prop.type === "phone") {
      return text;
    }
    if (prop.type === "number") return parseNumberInput(text);
    if (prop.type === "checkbox") return parseCheckboxInput(text);
    if (prop.type === "date") return parseDateInput(text);
    if (prop.type === "select" || prop.type === "status") {
      if (!trimmed) return null;
      return optionIdForLabel(prop, trimmed, optionCache);
    }
    if (prop.type === "multi_select") {
      const labels = trimmed.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
      if (labels.length === 0) return null;
      const ids = labels
        .map((label) => optionIdForLabel(prop, label, optionCache))
        .filter((id): id is string => !!id);
      return ids.length ? ids : null;
    }
    if (prop.type === "relation") return relationIdsForText(prop, text);
    if (prop.type === "person") return personIdsForText(text);
    if (prop.type === "files") {
      if (!trimmed) return null;
      if (!/^https?:\/\//i.test(trimmed)) return undefined;
      return [{ id: newId(), name: fileNameFromUrl(trimmed), url: trimmed }];
    }
    return undefined;
  }

  function applyPastedCell(
    row: Page,
    prop: DbProperty,
    text: string,
    optionCache: Map<string, OptionCacheEntry>
  ) {
    if (readOnly) return;
    if (row.isLocked) return;
    const value = pastedValueForProp(prop, text, optionCache);
    if (value === undefined) return;
    if (prop.type === "title") updatePage(row.id, { title: String(value ?? "") });
    else setRowProperty(row.id, prop.id, value, { debounce: false });
  }

  async function pasteCells(startRow: number, startCol: number, cells: string[][]) {
    if (readOnly) return;
    const targetRows = treeRows.map((item) => item.row);
    while (targetRows.length < startRow + cells.length) {
    const row = await addRow(db.id);
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
      targetRows.push(row);
    }

    const optionCache = new Map<string, OptionCacheEntry>();
    cells.forEach((rowCells, rowOffset) => {
      const row = targetRows[startRow + rowOffset];
      if (!row) return;
      rowCells.forEach((text, colOffset) => {
        const prop = visible[startCol + colOffset];
        if (!prop) return;
        applyPastedCell(row, prop, text, optionCache);
      });
    });

    for (const entry of optionCache.values()) {
      if (!entry.changed) continue;
      updateProperty(entry.prop.id, {
        config: { ...entry.prop.config, options: entry.options },
      });
    }
  }

  async function pasteCopiedRowsAfter(rowIndex: number, rowIds: string[]) {
    if (readOnly) return false;
    const state = useStore.getState();
    const sourceIds = rowIds.filter((id) => {
      const row = state.pagesById[id];
      return row?.parentType === "database" && row.parentId === db.id && !row.inTrash;
    });
    if (sourceIds.length === 0) return false;

    const visibleRows = treeRows.map((item) => item.row);
    const anchorIndex = rowIndex >= 0 ? rowIndex : visibleRows.length - 1;
    const anchor = visibleRows[anchorIndex] ?? shown.at(-1);
    const next = anchor ? allTreeRows[anchorIndex + 1]?.row : undefined;
    let afterPosition = anchor?.position;
    const beforePosition = next?.position;
    const pasted: string[] = [];
    const rowMap = new Map<string, string>();
    const positionMap = new Map<string, number>();
    const pastedParentIds = new Set<string>();

    for (const sourceId of sourceIds) {
      const source = useStore.getState().pagesById[sourceId];
      if (!source) continue;
      const copy = await duplicatePage(sourceId);
      if (!copy) continue;
      const position = positionBetween(afterPosition, beforePosition);
      afterPosition = position;
      rowMap.set(sourceId, copy.id);
      positionMap.set(copy.id, position);
      pasted.push(copy.id);
    }

    for (const [sourceId, pastedId] of rowMap) {
      const source = useStore.getState().pagesById[sourceId];
      const pastedRow = useStore.getState().pagesById[pastedId];
      if (!source || !pastedRow) continue;
      const properties = { ...(pastedRow.properties ?? {}) };
      const originalParent = properties[SUBITEM_KEY];
      if (typeof originalParent === "string") {
        const mappedParent = rowMap.get(originalParent);
        if (mappedParent) {
          properties[SUBITEM_KEY] = mappedParent;
          pastedParentIds.add(mappedParent);
        } else {
          delete properties[SUBITEM_KEY];
        }
      }
      updatePage(pastedId, {
        title: source.title,
        position: positionMap.get(pastedId) ?? pastedRow.position,
        properties,
      });
    }

    if (pasted.length > 0) {
      setSelectedRows(new Set(pasted));
      setLastSelectedRowId(pasted.at(-1) ?? null);
      if (pastedParentIds.size > 0) {
        setExpandedRows((cur) => new Set([...cur, ...pastedParentIds]));
      }
    }
    return pasted.length > 0;
  }

  function onCellPaste(
    e: ReactClipboardEvent<HTMLDivElement>,
    rowIndex: number,
    colIndex: number
  ) {
    if (readOnly) return;
    if (e.defaultPrevented || isInsideCellPopup(e.target)) return;
    const internalRows = parseInternalRowsClipboard(e.clipboardData, db.id);
    if (internalRows.length > 0) {
      e.preventDefault();
      void pasteCopiedRowsAfter(rowIndex, internalRows);
      return;
    }
    const parsed = parseTsv(e.clipboardData.getData("text/plain"));
    if (!parsed) return;
    e.preventDefault();
    void pasteCells(rowIndex, colIndex, parsed);
  }

  function selectedRowIndexes() {
    return treeRows
      .map((item, index) => (selectedRows.has(item.row.id) ? index : -1))
      .filter((index) => index >= 0);
  }

  function onTablePaste(e: ReactClipboardEvent<HTMLElement>) {
    if (readOnly) return;
    if (e.defaultPrevented || isInsideCellPopup(e.target) || isEditingCellText(e.target)) return;
    const indexes = selectedRowIndexes();
    if (indexes.length === 0) return;

    const internalRows = parseInternalRowsClipboard(e.clipboardData, db.id);
    if (internalRows.length > 0) {
      e.preventDefault();
      void pasteCopiedRowsAfter(Math.max(...indexes), internalRows);
      return;
    }

    const parsed = parseTsv(e.clipboardData.getData("text/plain"));
    if (!parsed) return;
    e.preventDefault();
    void pasteCells(Math.min(...indexes), 0, parsed);
  }

  function draggedRowIdsFor(sourceId: string) {
    if (!selectedRows.has(sourceId)) return [sourceId];
    return treeRows.map((item) => item.row.id).filter((id) => selectedRows.has(id));
  }

  function parseDraggedRowIds(value: string, fallbackId: string | null) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
      }
    } catch {
      // Older drag payloads were a single row id.
    }
    if (value) return [value];
    return fallbackId ? [fallbackId] : [];
  }

  function resetRowDragState() {
    setDraggingRowId(null);
    setDraggingRowIds(new Set());
    setDragOverRowId(null);
    setDragOverSide("before");
  }

  function reorderRows(sourceIds: string[], targetId: string, side: "before" | "after") {
    if (readOnly) return resetRowDragState();
    const uniqueSourceIds = Array.from(new Set(sourceIds)).filter(Boolean);
    if (uniqueSourceIds.length === 0 || !targetId || !canReorderRows) return resetRowDragState();
    const movingIds = new Set(uniqueSourceIds);
    if (movingIds.has(targetId)) return resetRowDragState();

    const movingRows = shown.filter((row) => movingIds.has(row.id));
    if (movingRows.length === 0) return resetRowDragState();
    const next = shown.filter((row) => !movingIds.has(row.id));
    const targetIndex = next.findIndex((row) => row.id === targetId);
    if (targetIndex < 0) return resetRowDragState();

    const insertionIndex = targetIndex + (side === "after" ? 1 : 0);
    const beforeRow = next[insertionIndex - 1];
    void (async () => {
      let anchorId = side === "after" ? beforeRow?.id : targetId;
      for (const row of movingRows) {
        if (!anchorId) continue;
        await moveDatabaseRow(row.id, anchorId, side === "after" ? "after" : "before");
        if (side === "after") anchorId = row.id;
      }
    })();

    setSelectedRows(new Set(movingRows.map((row) => row.id)));
    setLastSelectedRowId(movingRows.at(-1)?.id ?? null);
    resetRowDragState();
  }

  const selectionBar =
    selectedShown.length > 0 ? (
      <div
        className={styles.selectionBar}
        data-table-selection-bar
        role="toolbar"
        aria-label="Selected row actions"
        onPaste={onTablePaste}
      >
        <label className={styles.selectionCount}>
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = !allSelected && selectedShown.length > 0;
            }}
            onChange={toggleSelectAll}
          />
          <span>{selectedRowsLabel}</span>
        </label>
        <div className={styles.selectionProperties} aria-label="Quick property actions">
          {selectionQuickProperties.map((prop) => (
            <span
              key={prop.id}
              className={styles.selectionPropertyChip}
              data-table-selection-property-chip
            >
              <PropertyTypeIcon type={prop.type} size={14} />
              <span>{prop.name}</span>
            </span>
          ))}
        </div>
        <button
          type="button"
          className={styles.selectionIconAction}
          disabled={readOnly}
          title="Delete selected rows"
          aria-label="Delete selected rows"
          onClick={() => void deleteSelected()}
        >
          <Trash size={14} aria-hidden="true" />
        </button>
        <div className={styles.selectionMoreWrap}>
          <button
            type="button"
            className={styles.selectionMore}
            aria-label="More selected row actions"
            aria-expanded={selectionMenuOpen}
            onClick={() => setSelectionMenuOpen((open) => !open)}
          >
            ...
          </button>
          {selectionMenuOpen && (
            <div className={styles.selectionMenu} role="menu">
              <button
                type="button"
                className={styles.selectionMenuItem}
                role="menuitem"
                onClick={() => void copySelected()}
              >
                <Copy size={14} aria-hidden="true" />
                {copiedRows ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className={styles.selectionMenuItem}
                role="menuitem"
                disabled={readOnly}
                onClick={() => void duplicateSelected()}
              >
                <Copy size={14} aria-hidden="true" />
                Duplicate
              </button>
              <button
                type="button"
                className={styles.selectionMenuItem}
                role="menuitem"
                disabled={!canOutdentSelectedRows()}
                onClick={outdentSelectedRows}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                Outdent
              </button>
              <button
                type="button"
                className={styles.selectionMenuItem}
                role="menuitem"
                disabled={!canIndentSelectedRows()}
                onClick={indentSelectedRows}
              >
                <ArrowRight size={14} aria-hidden="true" />
                Indent
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className={styles.selectionClose}
          aria-label="Clear selection"
          onClick={clearSelection}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    ) : null;

  return (
    <>
      {selectionBar && selectionChromeSlot ? createPortal(selectionBar, selectionChromeSlot) : null}
	    <div
        className={styles.tableScroll}
        data-inline-empty-preview={inlineEmptyTablePreview ? "true" : undefined}
        style={tableGutterStyle}
      >
	      <div
	        className={styles.table}
        ref={tableRef}
        tabIndex={-1}
        data-row-height={view.config?.rowHeight ?? "medium"}
        data-row-gutter={showRowGutter ? "true" : undefined}
        data-inline-empty-preview={inlineEmptyTablePreview ? "true" : undefined}
        style={tableGutterStyle}
	        onPaste={onTablePaste}
	        onContextMenuCapture={onTableContextMenuCapture}
	      >
		        {/* header */}
		        <div
		          className={styles.tableHead}
		          data-table-head
		          data-inline-empty-preview={inlineEmptyTablePreview ? "true" : undefined}
		          style={tableHeadStyle}
		        >
          {showRowGutter && <div className={styles.rowGutterHead} aria-hidden="true" />}
          {visible.map((p, index) => (
            <PropertyHeader
              key={p.id}
              prop={p}
              props={props}
              view={view}
              isFirst={index === 0}
              readOnly={readOnly}
              onDropProperty={reorderProperty}
              onResizePreview={setResizePreview}
            />
          ))}
          {!readOnly && (
            <AddPropertyButton
              dbId={db.id}
              onAdd={(type, name, config) => void addProperty(db.id, type, name, config)}
            />
          )}
        </div>

        {/* rows */}
        {loadingRows && rows.length === 0 && (
          <>
            {Array.from({ length: 3 }).map((_, rowIndex) => (
              <div
                key={`loading-row-${rowIndex}`}
                className={styles.tableSkeletonRow}
                data-table-rows-loading
                style={{ gridTemplateColumns: bodyGridTemplate }}
              >
                {showRowGutter && <div className={styles.rowGutterCell} aria-hidden="true" />}
                {visible.map((p, colIndex) => (
                  <div
                    key={`${p.id}-loading-${rowIndex}`}
                    className={styles.tableSkeletonCell}
                    data-first={colIndex === 0 ? "true" : undefined}
                  >
                    <span />
                  </div>
                ))}
                {shouldRenderTrailingGridCell && (
                  <div
                    className={styles.trailingGridCell}
                    data-table-trailing-grid-cell
                    aria-hidden="true"
                  />
                )}
              </div>
            ))}
          </>
        )}
        {renderItems.map((entry) => {
          if (entry.kind === "group") {
            const subtotals = tableGroupSubtotals({
              group: entry.group,
              visible,
              tableCalculations,
              props,
              pagesById,
              propsByDb,
            });
            return (
              <div
                key={`group-${entry.group.key}`}
                className={styles.tableGroupHeader}
                style={{ gridTemplateColumns: bodyGridTemplate }}
              >
                <div className={styles.tableGroupHeaderInner}>
                  {entry.group.color && (
                    <span
                      className={styles.tableGroupSwatch}
                      style={chipStyle(entry.group.color)}
                      aria-hidden="true"
                    />
                  )}
                  <span className={styles.tableGroupLabel}>{entry.group.label}</span>
                  <span className={styles.tableGroupCount}>{entry.group.rows.length}</span>
                  {subtotals.length > 0 && (
                    <span
                      className={styles.tableGroupSubtotals}
                      aria-label={`${entry.group.label} subtotals`}
                    >
                      {subtotals.map((summary) => (
                        <span
                          key={summary.propertyId}
                          className={styles.tableGroupSubtotal}
                          data-table-group-subtotal
                          data-property-id={summary.propertyId}
                        >
                          <span>{summary.label}</span>
                          <strong>{summary.value}</strong>
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          }
          const { row, depth, hasChildren } = entry.item;
          const rowIndex = rowIndexById.get(row.id) ?? 0;
          const rowTitle = pageDisplayTitle(row);
          const showOpenRowButton = row.title.trim() !== "" && row.title.trim() !== "Untitled";
          const rowActionLabels = tableActionLabels(rowTitle);
          const subitemsExpanded = expandedRows.has(row.id);
          const subitemsLabel = subitemsExpanded
            ? `Collapse sub-items for ${rowTitle}`
            : `Expand sub-items for ${rowTitle}`;

          return (
            <div
              key={row.id}
              className={styles.tableRow}
              data-table-row-id={row.id}
              data-row-selected={selectedRows.has(row.id) ? "true" : undefined}
              data-row-dragging={draggingRowIds.has(row.id) ? "true" : undefined}
              data-row-drag-over={dragOverRowId === row.id ? "true" : undefined}
              data-drop-side={dragOverRowId === row.id ? dragOverSide : undefined}
              style={{ gridTemplateColumns: bodyGridTemplate }}
              onDragOver={(e) => {
                if (readOnly || !canReorderRows) return;
                const isRowDrag =
                  draggingRowIds.size > 0 || Array.from(e.dataTransfer.types).includes(TABLE_ROW_DRAG);
                if (!isRowDrag) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                setDragOverSide(e.clientY > rect.top + rect.height / 2 ? "after" : "before");
                setDragOverRowId(row.id);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDragOverRowId((cur) => (cur === row.id ? null : cur));
              }}
              onDrop={(e) => {
                e.preventDefault();
                reorderRows(
                  parseDraggedRowIds(e.dataTransfer.getData(TABLE_ROW_DRAG), draggingRowId),
                  row.id,
                  dragOverSide
                );
              }}
            >
              {showRowGutter && (
                <div className={styles.rowGutterCell} data-table-row-gutter-cell>
                  <button
                    type="button"
                    className={styles.rowGutterButton}
                    data-table-row-add
                    title={`Add row below ${rowTitle}`}
                    aria-label={`Add row below ${rowTitle}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void createRowAfter(row.id);
                    }}
                  >
                    <Plus size={17} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.rowDragHandle}
                    data-table-row-menu
                    title={canReorderRows ? "Drag row or open menu" : "Open row menu"}
                    aria-label={`${rowTitle} row menu`}
                    draggable={canReorderRows}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      openRowContextMenuAt(
                        row.id,
                        { x: rect.left + rect.width / 2, y: rect.bottom + 4 },
                        e.currentTarget
                      );
                    }}
                    onDragStart={(e) => {
                      if (!canReorderRows) {
                        e.preventDefault();
                        return;
                      }
                      const rowIds = draggedRowIdsFor(row.id);
                      setDraggingRowId(row.id);
                      setDraggingRowIds(new Set(rowIds));
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(TABLE_ROW_DRAG, JSON.stringify(rowIds));
                    }}
                    onDragEnd={resetRowDragState}
                  >
                    <DragHandleIcon size={17} aria-hidden="true" />
                  </button>
	                  <input
	                    type="checkbox"
	                    className={styles.rowSelect}
	                    data-table-row-select
	                    aria-label={`Select ${pageDisplayTitle(row)}`}
	                    checked={selectedRows.has(row.id)}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRowSelected(row.id, !selectedRows.has(row.id), e.shiftKey);
                    }}
                    onChange={() => {}}
                  />
                </div>
              )}
              {visible.map((p, i) => {
                const isFirstCell = i === 0;
                const isTitleCell = p.id === titlePropertyId;
                const cellAwarenessId = databaseCellAwarenessId(row.id, p.id);
                const remoteAwareness = remoteAwarenessByBlock[cellAwarenessId] ?? [];
                const primaryRemoteAwareness = remoteAwareness[0];
                const remoteAwarenessLabel = primaryRemoteAwareness
                  ? remoteAwarenessText(primaryRemoteAwareness, remoteAwareness.length)
                  : "";
                return (
                  <div
                    key={p.id}
                    className={styles.cell}
                    data-first={isFirstCell ? "true" : undefined}
                    data-title={isTitleCell ? "true" : undefined}
                    data-wrap={wrappedColumns.has(p.id) ? "true" : undefined}
                    data-selected={isTitleCell && selectedRows.has(row.id) ? "true" : undefined}
                    data-remote-awareness={primaryRemoteAwareness ? primaryRemoteAwareness.mode : undefined}
                    data-table-cell
                    data-row-index={rowIndex}
                    data-col-index={i}
                    style={
                      primaryRemoteAwareness
                        ? ({ "--remote-awareness-color": primaryRemoteAwareness.color } as CSSProperties)
                        : undefined
                    }
                    tabIndex={-1}
                    title={remoteAwarenessLabel || undefined}
                    aria-label={remoteAwarenessLabel || undefined}
                    onFocus={(e) => onCellFocus(row.id, p.id, e)}
                    onBlur={(e) => onCellBlur(row.id, p.id, e)}
                    onMouseUp={(e) => onCellPointerUp(row.id, p.id, e)}
                    onKeyUp={(e) => onCellKeyUp(row.id, p.id, e)}
                    onKeyDown={(e) => onCellKeyDown(e, rowIndex, i)}
                    onPaste={(e) => onCellPaste(e, rowIndex, i)}
                  >
                    {isTitleCell && showOpenRowButton && (
                      <>
                        <button
                          type="button"
                          className={styles.openRow}
                          data-table-row-open
                          title={rowActionLabels.openInSidePeek}
                          aria-label={`${rowTitle} ${rowActionLabels.openInSidePeek}`}
                          aria-keyshortcuts="Meta+Enter Control+Enter"
                          onClick={(e) => openRowClick(row.id, e)}
                          onPointerEnter={() => onWarmRow?.(row.id)}
                          onFocus={() => onWarmRow?.(row.id)}
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.preventDefault();
                              openPageInNewTab(row.id);
                            }
                          }}
                        >
                          <LayoutIcon size={15} />
                          <span>{rowActionLabels.openRow}</span>
                        </button>
                      </>
                    )}
                    {isTitleCell && depth > 0 && (
                      <span className={styles.subitemIndent} style={{ width: depth * 20 }} aria-hidden="true" />
                    )}
                    {isTitleCell && tableHasSubitems && (
                      hasChildren ? (
                        <button
                          type="button"
                          className={styles.subitemToggle}
                          data-visible="true"
                          aria-expanded={subitemsExpanded}
                          aria-label={subitemsLabel}
                          title={subitemsLabel}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(row.id);
                          }}
                        >
                          {subitemsExpanded ? (
                            <ChevronDown size={13} aria-hidden="true" />
                          ) : (
                            <ChevronRight size={13} aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        <span className={styles.subitemToggle} aria-hidden="true" />
                      )
                    )}
                    <div className={styles.cellEditor} data-cell-editor>
                      {readOnly || row.isLocked ? (
                        <PropValue row={row} prop={p} interactive={false} />
                      ) : (
                        <PropertyCell row={row} prop={p} onOpenPage={openRow} />
                      )}
                    </div>
                    {primaryRemoteAwareness && (
                      <span
                        className={styles.cellRemoteAwareness}
                        contentEditable={false}
                        title={remoteAwarenessLabel}
                        aria-label={remoteAwarenessLabel}
                      >
                        <span className={styles.cellRemoteAwarenessLine} aria-hidden="true" />
                        <span className={styles.cellRemoteAwarenessAvatar}>
                          {remoteAwarenessInitials(primaryRemoteAwareness)}
                        </span>
                      </span>
                    )}
                  </div>
                );
              })}
              {shouldRenderTrailingGridCell && (
                <div
                  className={styles.trailingGridCell}
                  data-table-trailing-grid-cell
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}

        {rowLoadError && (
          <div className={styles.tableLoadError} data-table-load-error role="status">
            <div className={styles.viewEmptyTitle}>{tableViewLabels().rowLoadErrorTitle}</div>
            <div className={styles.viewEmptyDesc}>{rowLoadError}</div>
            <button
              type="button"
              className={styles.viewEmptyAction}
              onClick={() => void loadDatabaseRows(db.id, { ...(rowQuery ?? {}), reset: true })}
            >
              <SyncIcon size={14} aria-hidden="true" />
              {tableViewLabels().retry}
            </button>
          </div>
        )}

        {inlineEmptyPreviewRowCount > 0 && (
          <>
            {Array.from({ length: inlineEmptyPreviewRowCount }).map((_, rowIndex) => (
              <div
                key={`empty-preview-row-${rowIndex}`}
                className={styles.tableEmptyPreviewRow}
                data-table-empty-preview-row
                data-clickable={!readOnly ? "true" : undefined}
                role={!readOnly ? "button" : undefined}
                tabIndex={!readOnly ? 0 : undefined}
                aria-label={!readOnly ? newPageLabel : undefined}
                style={{ gridTemplateColumns: emptyPreviewGridTemplate }}
                onClick={!readOnly ? () => void createRow() : undefined}
                onKeyDown={
                  !readOnly
                    ? (e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        void createRow();
                      }
                    : undefined
                }
              >
                {showRowGutter && <div className={styles.rowGutterCell} aria-hidden="true" />}
                {visible.map((p, colIndex) => (
                  <div
                    key={`${p.id}-empty-preview-${rowIndex}`}
                    className={styles.tableEmptyPreviewCell}
                    data-table-empty-preview-cell
                    data-first={colIndex === 0 ? "true" : undefined}
                  >
                    {colIndex === 0 && !readOnly && (
                      <span
                        className={styles.emptyPreviewNewRow}
                        data-empty-preview-new-row
                        aria-hidden="true"
                      >
                        <Plus size={15} aria-hidden="true" /> {newRowText}
                      </span>
                    )}
                  </div>
                ))}
                {!readOnly && (
                  <div
                    className={styles.tableEmptyPreviewCell}
                    data-table-empty-preview-cell
                    data-add-property-preview="true"
                  />
                )}
              </div>
            ))}
          </>
        )}

        {inlineEmptyTablePreview && !readOnly && (
          <button
            type="button"
            className={styles.newRow}
            data-table-new-row
            title={newPageLabel}
            aria-label={newPageLabel}
            style={{ gridTemplateColumns: emptyPreviewGridTemplate }}
            onClick={() => void createRow()}
          >
            <span className={styles.newRowInner}>
              <Plus size={15} aria-hidden="true" /> {newRowText}
            </span>
          </button>
        )}

        {shown.length === 0 && rows.length > 0 && (
          <div className={styles.tableEmpty} data-table-empty-results>
            <div className={styles.viewEmptyTitle}>
              No results
            </div>
            <div className={styles.viewEmptyDesc}>
              No pages match the current filters or search.
            </div>
          </div>
        )}

        {hasMoreRows && (
          <button
            type="button"
            className={styles.loadMoreRow}
            data-table-load-more
            aria-label={tableViewLabels().loadMoreAria(remainingRowCount)}
            style={{ gridTemplateColumns: gridTemplate }}
            disabled={rowPage?.loadingMore}
            onClick={() => void loadMoreRows()}
          >
            <span className={styles.loadMoreRowInner}>
              <ArrowDown size={14} aria-hidden="true" />
              {rowPage?.loadingMore ? tableViewLabels().loadingMore : tableViewLabels().loadMore}
            </span>
          </button>
        )}

        {!inlineEmptyTablePreview && !readOnly && (
          <button
            type="button"
            className={styles.newRow}
            data-table-new-row
            title={newPageLabel}
            aria-label={newPageLabel}
            style={{ gridTemplateColumns: gridTemplate }}
            onClick={() => void createRow()}
          >
            <span className={styles.newRowInner}>
              <Plus size={15} aria-hidden="true" /> {newRowText}
            </span>
          </button>
        )}
        {showSummaryRow && (
          <div
            className={styles.tableSummary}
            data-table-summary-row
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {!readOnly && <div className={styles.summaryCell} aria-hidden="true" />}
            {visible.map((prop, index) => (
              <TableSummaryCell
                key={prop.id}
                prop={prop}
                props={props}
                rows={shown}
                pagesById={pagesById}
                propsByDb={propsByDb}
                view={view}
                isFirst={index === 0}
                showDefaultRowCount={index === 0 && !hasVisibleCalculation}
                updateView={updateView}
              />
            ))}
          </div>
        )}
      </div>
      {rowContextMenu}
    </div>
	    </>
	  );
	}

function TableSummaryCell({
  prop,
  props,
  rows,
  pagesById,
  propsByDb,
  view,
  isFirst,
  showDefaultRowCount,
  updateView,
}: {
  prop: DbProperty;
  props: DbProperty[];
  rows: Page[];
  pagesById: Record<string, Page>;
  propsByDb: Record<string, DbProperty[]>;
  view: DbView;
  isFirst: boolean;
  showDefaultRowCount: boolean;
  updateView: (id: string, patch: Partial<DbView>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number; maxHeight: number } | null>(
    null
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const calculationOptions = tableCalculationsFor(prop);
  const configuredCalculation = view.config?.tableCalculations?.[prop.id];
  const calculation = calculationOptions.some((item) => item.value === configuredCalculation)
    ? configuredCalculation
    : undefined;

  // Portal + clamp so the calculation menu isn't clipped by the scroll container
  // and never overflows the top of the viewport when it opens upward.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const MENU_WIDTH = 220;
      const MARGIN = 8;
      const left = Math.min(
        Math.max(MARGIN, r.right - MENU_WIDTH),
        window.innerWidth - MENU_WIDTH - MARGIN
      );
      const maxHeight = Math.max(160, r.top - MARGIN - 4);
      setMenuPos({ bottom: window.innerHeight - r.top + 4, left, maxHeight });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const summary = calculation
    ? summarizeColumn(calculation, prop, props, rows, pagesById, propsByDb)
    : null;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      menuButtons(menuRef.current)[0]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function setCalculation(next: TableCalculation | "none") {
    const tableCalculations = { ...(view.config?.tableCalculations ?? {}) };
    if (next === "none") delete tableCalculations[prop.id];
    else tableCalculations[prop.id] = next;
    updateView(view.id, {
      config: {
        ...view.config,
        tableCalculations: Object.keys(tableCalculations).length ? tableCalculations : undefined,
      },
    });
    closeMenu(true);
  }

  return (
    <div
      className={styles.summaryCell}
      data-first={isFirst ? "true" : undefined}
      data-table-summary-cell
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.summaryButton}
        data-empty={summary ? undefined : "true"}
        data-row-count={showDefaultRowCount && !summary ? "true" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {summary ? (
          <>
            <span>{summary.label}</span>
            <strong>{summary.value}</strong>
          </>
        ) : (
          <span>{showDefaultRowCount ? `${rows.length} rows` : "Calculate"}</span>
        )}
      </button>
      {open && menuPos && createPortal(
        <>
          <button
            type="button"
            className={styles.menuBackdrop}
            onClick={() => closeMenu(true)}
            tabIndex={-1}
            aria-label="Close calculation menu"
          />
          <div
            ref={menuRef}
            className={styles.summaryMenu}
            style={{
              position: "fixed",
              bottom: menuPos.bottom,
              left: menuPos.left,
              right: "auto",
              maxHeight: menuPos.maxHeight,
              overflowY: "auto",
            }}
            role="menu"
            tabIndex={-1}
            aria-label={`${prop.name} calculation`}
            onKeyDown={(e) => onTableMenuKeyDown(e, menuRef.current, () => closeMenu(true))}
          >
            <div className={styles.propMenuLabel}>Calculate</div>
            {calculationOptions.map((item) => (
              <button
                type="button"
                key={item.value}
                className={styles.summaryMenuItem}
                data-active={(calculation ?? "none") === item.value ? "true" : undefined}
                data-menu-item
                role="menuitemradio"
                aria-checked={(calculation ?? "none") === item.value}
                onClick={() => setCalculation(item.value)}
              >
                <span>{item.label}</span>
                {(calculation ?? "none") === item.value && (
                  <span className={styles.check}>
                    <CheckIcon size={14} aria-hidden="true" />
                  </span>
                )}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

function rawPropertyValue(
  row: Page,
  prop: DbProperty,
  props: DbProperty[],
  pagesById: Record<string, Page>,
  propsByDb: Record<string, DbProperty[]>
): unknown {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "created_by") return row.createdBy;
  if (prop.type === "last_edited_by") return row.lastEditedBy;
  if (prop.type === "formula") {
    const computed = backendComputedValue(row, prop);
    if (computed !== undefined) return computed;
    return evaluateFormula({ row, prop, props, pagesById });
  }
  if (prop.type === "rollup") {
    const computed = backendComputedValue(row, prop);
    if (computed !== undefined) return computed;
    const relationProp = props.find(
      (item) => item.id === prop.config?.rollupRelationPropertyId
    );
    const targetDbId = relationProp?.config?.relationDatabaseId ?? relationProp?.databaseId;
    return evaluateRollup({
      row,
      prop,
      sourceProps: props,
      targetProps: targetDbId ? propsByDb[targetDbId] ?? [] : [],
      pagesById,
    });
  }
  return row.properties?.[prop.id];
}

function displaySummaryValue(
  value: unknown,
  prop: DbProperty,
  pagesById: Record<string, Page>
): string | string[] {
  if (prop.type === "select" || prop.type === "status") {
    const id = value ? String(value) : "";
    return prop.config?.options?.find((option) => option.id === id)?.name ?? id;
  }
  if (prop.type === "multi_select") {
    return valueAsIds(value).map(
      (id) => prop.config?.options?.find((option) => option.id === id)?.name ?? id
    );
  }
  if (prop.type === "relation") {
    return valueAsIds(value).map((id) => pageDisplayTitle(pagesById[id]));
  }
  if (prop.type === "files") {
    return normalizeFileAttachments(value).map((file) => file.name);
  }
  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    return normalizePersonIds(value).map((id) => personLabel(id));
  }
  if (prop.type === "created_time" || prop.type === "last_edited_time") {
    return formatNotionTimestamp(value);
  }
  if (prop.type === "formula") return formatFormulaValue(value as ReturnType<typeof evaluateFormula>);
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return "";
  return String(value);
}

function tsvCell(text: string) {
  return text.replace(/\r?\n|\t/g, " ").replace(/\s+/g, " ").trim();
}

function clipboardValue(
  row: Page,
  prop: DbProperty,
  props: DbProperty[],
  pagesById: Record<string, Page>,
  propsByDb: Record<string, DbProperty[]>
) {
  const value = rawPropertyValue(row, prop, props, pagesById, propsByDb);
  if (prop.type === "checkbox") return value ? "TRUE" : "FALSE";
  if (prop.type === "date") return formatDateForProperty(value, prop);
  if (prop.type === "number") return formatNumberValue(value, numberFormatForProperty(prop));
  if (prop.type === "created_time" || prop.type === "last_edited_time") {
    return formatNotionTimestamp(value);
  }
  if (prop.type === "unique_id") {
    if (value == null || value === "") return "";
    const prefix = prop.config?.idPrefix?.trim();
    return prefix ? `${prefix}-${value}` : String(value);
  }

  const display = displaySummaryValue(value, prop, pagesById);
  return Array.isArray(display) ? display.join(", ") : display;
}

function rowsToTsv(
  rows: Page[],
  visible: DbProperty[],
  props: DbProperty[],
  pagesById: Record<string, Page>,
  propsByDb: Record<string, DbProperty[]>
) {
  const header = visible.map((prop) => tsvCell(prop.name)).join("\t");
  const body = rows.map((row) =>
    visible
      .map((prop) => tsvCell(clipboardValue(row, prop, props, pagesById, propsByDb)))
      .join("\t")
  );
  return [header, ...body].join("\n");
}

function valuePieces(value: unknown, prop: DbProperty, pagesById: Record<string, Page>) {
  const display = displaySummaryValue(value, prop, pagesById);
  const parts = Array.isArray(display) ? display : [display];
  return parts.map((part) => String(part).trim()).filter(Boolean);
}

function valuePresent(value: unknown, prop: DbProperty, pagesById: Record<string, Page>) {
  return valuePieces(value, prop, pagesById).length > 0;
}

function numericValue(value: unknown) {
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateValues(value: unknown) {
  const dates: Date[] = [];
  const start = parseDate(value);
  const end = parseDate(extractEnd(value));
  if (start) dates.push(start);
  if (end) dates.push(end);
  return dates;
}

function formatNumber(n: number) {
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function formatNumericSummary(n: number, prop: DbProperty) {
  if (prop.type === "number") {
    return formatNumberValue(n, numberFormatForProperty(prop));
  }
  return formatNumber(n);
}

function formatPercent(n: number) {
  if (!Number.isFinite(n)) return "0%";
  return `${formatNumber(n * 100)}%`;
}

function formatSummaryDate(date: Date) {
  return formatDate(dateKey(date));
}

function summarizeColumn(
  calculation: TableCalculation,
  prop: DbProperty,
  props: DbProperty[],
  rows: Page[],
  pagesById: Record<string, Page>,
  propsByDb: Record<string, DbProperty[]>
) {
  const values = rows.map((row) => rawPropertyValue(row, prop, props, pagesById, propsByDb));
  const pieces = values.flatMap((value) => valuePieces(value, prop, pagesById));
  const present = values.filter((value) => valuePresent(value, prop, pagesById));
  const numbers = values
    .map(numericValue)
    .filter((value): value is number => value !== null);
  const sortedNumbers = [...numbers].sort((a, b) => a - b);
  const dates = values
    .flatMap(dateValues)
    .sort((a, b) => a.getTime() - b.getTime());
  const checked = values.filter((value) => value === true).length;
  const label = tableCalculationLabel(calculation);

  switch (calculation) {
    case "count_all":
      return { label, value: String(rows.length) };
    case "count_values":
      return { label, value: String(present.length) };
    case "count_unique":
      return { label, value: String(new Set(pieces).size) };
    case "count_empty":
      return { label, value: String(rows.length - present.length) };
    case "percent_empty":
      return { label, value: rows.length ? formatPercent((rows.length - present.length) / rows.length) : "0%" };
    case "percent_not_empty":
      return { label, value: rows.length ? formatPercent(present.length / rows.length) : "0%" };
    case "checked":
      return { label, value: String(checked) };
    case "unchecked":
      return { label, value: String(rows.length - checked) };
    case "percent_checked":
      return { label, value: rows.length ? formatPercent(checked / rows.length) : "0%" };
    case "percent_unchecked":
      return { label, value: rows.length ? formatPercent((rows.length - checked) / rows.length) : "0%" };
    case "sum":
      return { label, value: numbers.length ? formatNumericSummary(numbers.reduce((sum, n) => sum + n, 0), prop) : "" };
    case "average":
      return {
        label,
        value: numbers.length
          ? formatNumericSummary(numbers.reduce((sum, n) => sum + n, 0) / numbers.length, prop)
          : "",
      };
    case "median": {
      if (!sortedNumbers.length) return { label, value: "" };
      const middle = Math.floor(sortedNumbers.length / 2);
      const median =
        sortedNumbers.length % 2
          ? sortedNumbers[middle]
          : (sortedNumbers[middle - 1] + sortedNumbers[middle]) / 2;
      return { label, value: formatNumericSummary(median, prop) };
    }
    case "min":
      return { label, value: numbers.length ? formatNumericSummary(Math.min(...numbers), prop) : "" };
    case "max":
      return { label, value: numbers.length ? formatNumericSummary(Math.max(...numbers), prop) : "" };
    case "range":
      return {
        label,
        value: numbers.length ? formatNumericSummary(Math.max(...numbers) - Math.min(...numbers), prop) : "",
      };
    case "earliest_date":
      return { label, value: dates.length ? formatSummaryDate(dates[0]) : "" };
    case "latest_date":
      return { label, value: dates.length ? formatSummaryDate(dates[dates.length - 1]) : "" };
    case "date_range": {
      if (!dates.length) return { label, value: "" };
      const start = dates[0];
      const end = dates[dates.length - 1];
      const startText = formatSummaryDate(start);
      const endText = formatSummaryDate(end);
      return {
        label,
        value: start.getTime() === end.getTime() ? startText : `${startText} → ${endText}`,
      };
    }
    default:
      return { label, value: "" };
  }
}

function PropertyHeader({
  prop,
  props,
  view,
  isFirst,
  readOnly = false,
  onDropProperty,
  onResizePreview,
}: {
  prop: DbProperty;
  props: DbProperty[];
  view: DbView;
  isFirst: boolean;
  readOnly?: boolean;
  onDropProperty: (sourceId: string, targetId: string) => void;
  onResizePreview: (preview: { propId: string; width: number } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPanel, setMenuPanel] = useState<"main" | "edit" | "type">("main");
  const [typeSearch, setTypeSearch] = useState("");
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [descriptionTooltip, setDescriptionTooltip] = useState<{
    top: number;
    left: number;
    text: string;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const { confirmPropertyTypeChange, typeChangeConfirmDialog } = usePropertyTypeChangeConfirm();

  // Position the config menu in a portal clamped to the viewport — rendered
  // inline it gets clipped by the table's horizontal-scroll container.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const MARGIN = 8;
      const left = Math.min(
        Math.max(MARGIN, r.left),
        window.innerWidth - PROPERTY_HEADER_MENU_WIDTH - MARGIN
      );
      setMenuPos({ top: r.bottom + 4, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const updateProperty = useStore((s) => s.updateProperty);
  const deleteProperty = useStore((s) => s.deleteProperty);
  const restoreDeletedProperty = useStore((s) => s.restoreDeletedProperty);
  const addProperty = useStore((s) => s.addProperty);
  const updateView = useStore((s) => s.updateView);
  const notify = useStore((s) => s.notify);
  const ordered = orderViewProperties(props, view);
  const isTitle = prop.type === "title";
  const isSystemProp =
    prop.type === "created_time" ||
    prop.type === "last_edited_time" ||
    prop.type === "created_by" ||
    prop.type === "last_edited_by";
  const sorts = view.config?.sorts ?? [];
  const sortIndex = sorts.findIndex((item) => item.propertyId === prop.id);
  const activeSort = sortIndex >= 0 ? sorts[sortIndex] : undefined;
  const propertyTypeOptions = [
    ...(isTitle
      ? [
          {
            value: "title",
            label: localizedPropertyTypeLabel("title"),
            icon: <PropertyTypeIcon type="title" size={14} />,
          },
        ]
      : []),
    ...PROPERTY_TYPES.filter(
      (type) =>
        type.type === prop.type ||
        !["created_time", "last_edited_time", "created_by", "last_edited_by"].includes(type.type)
    ).map((type) => ({
      value: type.type,
      label: localizedPropertyTypeLabel(type.type),
      icon: <PropertyTypeIcon type={type.type} size={14} />,
    })),
  ];
  const typeSearchTerms = typeSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredPropertyTypeOptions =
    typeSearchTerms.length > 0
      ? propertyTypeOptions.filter((type) => {
          const haystack = `${type.label} ${type.value}`.toLowerCase();
          return typeSearchTerms.every((term) => haystack.includes(term));
        })
      : propertyTypeOptions;

  useEffect(() => {
    if (open) return;
    setMenuPanel("main");
    setTypeSearch("");
  }, [open]);

  useEffect(() => {
    if (!open || menuPanel !== "main") return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("[data-menu-item]:not(:disabled)")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, menuPanel, prop.id]);

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    setMenuPanel("main");
    setTypeSearch("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function updateConfig(config: Partial<DbView["config"]>) {
    if (readOnly) return;
    updateView(view.id, { config: { ...view.config, ...config } });
  }

  function setWidth(width: number) {
    if (readOnly) return;
    updateConfig({
      propertyWidths: {
        ...(view.config?.propertyWidths ?? {}),
        [prop.id]: clampColumnWidth(width),
      },
    });
  }

  function startResize(e: React.PointerEvent<HTMLButtonElement>) {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = columnWidth(prop, view);
    const body = document.body;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    // Live-preview the drag through local table state only (rAF-coalesced);
    // the persisted view-config write — a durable remote call plus broadcast
    // per invocation — happens exactly once, on release.
    let latestWidth = startWidth;
    let frame = 0;

    function cleanup() {
      body.style.cursor = "";
      body.style.userSelect = "";
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      onResizePreview(null);
    }
    function onPointerMove(ev: PointerEvent) {
      latestWidth = clampColumnWidth(startWidth + ev.clientX - startX);
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        onResizePreview({ propId: prop.id, width: latestWidth });
      });
    }
    function onPointerUp(ev: PointerEvent) {
      latestWidth = clampColumnWidth(startWidth + ev.clientX - startX);
      if (latestWidth !== startWidth) setWidth(latestWidth);
      cleanup();
    }
    function onPointerCancel() {
      // Abort without persisting; the preview reset snaps back to the stored width.
      cleanup();
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  }

  function sort(direction: "asc" | "desc") {
    if (readOnly) return;
    const sorts = view.config?.sorts ?? [];
    updateConfig({
      sorts: [
        { propertyId: prop.id, direction },
        ...sorts.filter((item) => item.propertyId !== prop.id),
      ],
    });
    closeMenu(true);
  }

  function clearSort() {
    if (readOnly) return;
    const next = (view.config?.sorts ?? []).filter((item) => item.propertyId !== prop.id);
    updateConfig({ sorts: next.length ? next : undefined });
    closeMenu(true);
  }

  function hide() {
    if (readOnly) return;
    if (isTitle) return;
    const allIds = props.map((p) => p.id);
    const visible = new Set(view.config?.visibleProperties ?? allIds);
    visible.delete(prop.id);
    updateConfig({ visibleProperties: allIds.filter((id) => visible.has(id)) });
    closeMenu(true);
  }

  function move(direction: -1 | 1) {
    if (readOnly) return;
    const ids = ordered.map((p) => p.id);
    const index = ids.indexOf(prop.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    updateConfig({ propertyOrder: ids });
  }

  async function duplicateProperty() {
    if (readOnly) return;
    if (isTitle || isSystemProp) return;
    try {
      const physical = [...props].sort((a, b) => a.position - b.position);
      const physicalIndex = physical.findIndex((item) => item.id === prop.id);
      const nextPhysical = physical[physicalIndex + 1];
      const duplicate = await addProperty(
        prop.databaseId,
        prop.type,
        copyPropertyName(props, prop.name),
        clonePropertyConfig(prop.config)
      );
      const position = positionBetween(prop.position, nextPhysical?.position);
      updateProperty(duplicate.id, { description: prop.description, position });

      const currentOrder = view.config?.propertyOrder ?? ordered.map((item) => item.id);
      const sourceIndex = currentOrder.indexOf(prop.id);
      const withoutDuplicate = currentOrder.filter((id) => id !== duplicate.id);
      const propertyOrder =
        sourceIndex >= 0
          ? [
              ...withoutDuplicate.slice(0, sourceIndex + 1),
              duplicate.id,
              ...withoutDuplicate.slice(sourceIndex + 1),
            ]
          : [...withoutDuplicate, duplicate.id];
      const visible = new Set(view.config?.visibleProperties ?? props.map((item) => item.id));
      visible.add(duplicate.id);
      const propertyWidths = view.config?.propertyWidths?.[prop.id]
        ? {
            ...(view.config?.propertyWidths ?? {}),
            [duplicate.id]: view.config.propertyWidths[prop.id],
          }
        : view.config?.propertyWidths;
      updateConfig({
        propertyOrder,
        visibleProperties: [...props.map((item) => item.id), duplicate.id].filter((id) =>
          visible.has(id)
        ),
        propertyWidths,
      });
      notify("Duplicated property", "success");
      closeMenu(true);
    } catch {
      notify("Couldn't duplicate property", "error");
    }
  }

  async function remove() {
    if (readOnly) return;
    if (isTitle) return;
    try {
      const snapshot = await deleteProperty(prop.id);
      if (!snapshot) {
        notify("Couldn't delete property", "error");
        return;
      }
      updateConfig({
        propertyOrder: (view.config?.propertyOrder ?? props.map((p) => p.id)).filter(
          (id) => id !== prop.id
        ),
        propertyWidths: omitKey(view.config?.propertyWidths, prop.id),
        visibleProperties: (view.config?.visibleProperties ?? props.map((p) => p.id)).filter(
          (id) => id !== prop.id
        ),
        filters: (view.config?.filters ?? []).filter((filter) => filter.propertyId !== prop.id),
        sorts: (view.config?.sorts ?? []).filter((item) => item.propertyId !== prop.id),
        groupBy: view.config?.groupBy === prop.id ? undefined : view.config?.groupBy,
        calendarBy: view.config?.calendarBy === prop.id ? undefined : view.config?.calendarBy,
        timelineBy: view.config?.timelineBy === prop.id ? undefined : view.config?.timelineBy,
        timelineEndBy:
          view.config?.timelineEndBy === prop.id ? undefined : view.config?.timelineEndBy,
      });
      notify("Deleted property", "success", {
        label: "Undo",
        onClick: async () => {
          const restored = await restoreDeletedProperty(snapshot);
          notify(restored ? "Restored property" : "Couldn't restore property", restored ? "success" : "error");
        },
      });
      setOpen(false);
    } catch {
      notify("Couldn't delete property", "error");
    }
  }

  function startPropertyDrag(e: ReactDragEvent<HTMLElement>) {
    if (readOnly) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(TABLE_PROP_DRAG, prop.id);
  }

  function showDescriptionTooltip(target: HTMLElement) {
    if (!prop.description) return;
    const rect = target.getBoundingClientRect();
    setDescriptionTooltip({
      top: rect.bottom + 8,
      left: rect.left + rect.width / 2,
      text: prop.description,
    });
  }

  function openPropertyMenuFromContext(e: ReactMouseEvent<HTMLElement>) {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setDescriptionTooltip(null);
    setMenuPanel("main");
    setOpen(true);
  }

  return (
    <div
      className={styles.headCell}
      data-table-property-header={prop.id}
      data-first={isFirst ? "true" : undefined}
      data-drag-over={dragOver ? "true" : undefined}
      draggable={!readOnly}
      onContextMenu={openPropertyMenuFromContext}
      onDragStart={startPropertyDrag}
      onDragOver={(e) => {
        if (readOnly) return;
        if (!Array.from(e.dataTransfer.types).includes(TABLE_PROP_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (readOnly) return;
        const sourceId = e.dataTransfer.getData(TABLE_PROP_DRAG);
        if (!sourceId) return;
        e.preventDefault();
        setDragOver(false);
        onDropProperty(sourceId, prop.id);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.headCellBtn}
        aria-label={`${prop.name} property options`}
        aria-describedby={prop.description ? `property-description-${prop.id}` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={readOnly}
        draggable={!readOnly}
        onDragStart={startPropertyDrag}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("[data-description]")) return;
          setOpen((current) => {
            const next = !current;
            if (next) setMenuPanel("main");
            return next;
          });
        }}
        onContextMenu={openPropertyMenuFromContext}
      >
        <span className={styles.headGlyph} aria-hidden="true">
          <PropertyTypeIcon type={prop.type} size={14} />
        </span>
        <span className={styles.headName}>{prop.name}</span>
        {prop.description && (
          <>
            <span
              className={styles.headDescriptionBadge}
              data-description={prop.description}
              aria-hidden="true"
              onMouseEnter={(e) => showDescriptionTooltip(e.currentTarget)}
              onMouseLeave={() => setDescriptionTooltip(null)}
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => e.preventDefault()}
            >
              i
            </span>
            <span id={`property-description-${prop.id}`} className={styles.srOnly}>
              {`Description: ${prop.description}`}
            </span>
          </>
        )}
      </button>
      <button
        type="button"
        className={styles.colResize}
        aria-label="Resize column"
        disabled={readOnly}
        onPointerDown={startResize}
      />
      {descriptionTooltip &&
        createPortal(
          <div
            className={styles.headDescriptionTooltip}
            data-table-header-description-tooltip
            role="tooltip"
            style={{ top: descriptionTooltip.top, left: descriptionTooltip.left }}
          >
            {descriptionTooltip.text}
          </div>,
          document.body
        )}
      {open && menuPos && createPortal(
        <>
          <button
            type="button"
            className={styles.menuBackdrop}
            style={{ zIndex: 59 }}
            onClick={() => closeMenu(true)}
            tabIndex={-1}
            aria-label="Close property menu"
          />
          <div
            ref={menuRef}
            className={styles.propertyHeaderMenu}
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
            role="dialog"
            aria-label={`${prop.name} property options`}
            onKeyDown={(e) => onTableMenuKeyDown(e, menuRef.current, () => closeMenu(true))}
          >
            {menuPanel === "main" && (
              <>
                <div className={styles.propertyHeaderSummary}>
                  <span className={styles.propertyHeaderSummaryIcon} aria-hidden="true">
                    <PropertyTypeIcon type={prop.type} size={18} />
                  </span>
                  <span className={styles.propertyHeaderSummaryText}>
                    <strong>{prop.name}</strong>
                    <span>{localizedPropertyTypeLabel(prop.type)}</span>
                  </span>
                  {prop.description && <span className={styles.propertyHeaderInfo}>i</span>}
                </div>
                <button
                  className={styles.propertyHeaderItem}
                  data-menu-item
                  onClick={() => setMenuPanel("edit")}
                >
                  <PropertiesIcon size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().editProperty}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <button
                  className={styles.propertyHeaderItem}
                  data-menu-item
                  onClick={() => setMenuPanel("type")}
                  disabled={isTitle || isSystemProp}
                >
                  <PropertyTypeIcon type={prop.type} size={15} />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().changeType}</span>
                  <span className={styles.propertyHeaderMeta}>{localizedPropertyTypeLabel(prop.type)}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <button className={styles.propertyHeaderItem} data-menu-item disabled>
                  <SyncIcon size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().aiAutofill}</span>
                  <span className={styles.propertyHeaderMeta}>{tableViewLabels().comingSoon}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <div className={styles.propertyHeaderDivider} />
                <button
                  className={styles.propertyHeaderItem}
                  data-active={activeSort?.direction === "asc" ? "true" : undefined}
                  data-menu-item
                  onClick={() => sort("asc")}
                >
                  <SortIcon size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().sortAscending}</span>
                  {activeSort?.direction === "asc" && (
                    <span className={styles.propertyHeaderCheck}>
                      <CheckIcon size={14} aria-hidden="true" />
                    </span>
                  )}
                </button>
                <button
                  className={styles.propertyHeaderItem}
                  data-active={activeSort?.direction === "desc" ? "true" : undefined}
                  data-menu-item
                  onClick={() => sort("desc")}
                >
                  <SortIcon size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().sortDescending}</span>
                  {activeSort?.direction === "desc" && (
                    <span className={styles.propertyHeaderCheck}>
                      <CheckIcon size={14} aria-hidden="true" />
                    </span>
                  )}
                </button>
                {activeSort && (
                  <button className={styles.propertyHeaderItem} data-menu-item onClick={clearSort}>
                    <X size={15} aria-hidden="true" />
                    <span className={styles.propertyHeaderItemText}>{tableViewLabels().clearSort}</span>
                  </button>
                )}
                <button className={styles.propertyHeaderItem} data-menu-item disabled>
                  <FilterIcon size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().filter}</span>
                  <span className={styles.propertyHeaderMeta}>{tableViewLabels().manageInViewSettings}</span>
                </button>
                <button
                  className={styles.propertyHeaderItem}
                  data-menu-item
                  onClick={hide}
                  disabled={isTitle}
                >
                  <LayoutIcon size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().hide}</span>
                </button>
                <button
                  className={styles.propertyHeaderItem}
                  data-menu-item
                  onClick={() => {
                    const cur = view.config?.wrappedColumns ?? [];
                    const next = cur.includes(prop.id)
                      ? cur.filter((id) => id !== prop.id)
                      : [...cur, prop.id];
                    updateView(view.id, {
                      config: { ...view.config, wrappedColumns: next.length ? next : undefined },
                    });
                  }}
                >
                  <ArrowDown size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>
                    {(view.config?.wrappedColumns ?? []).includes(prop.id)
                      ? tableViewLabels().unwrapText
                      : tableViewLabels().wrapText}
                  </span>
                </button>
                <div className={styles.propertyHeaderDivider} />
                <div className={styles.propertyHeaderRow}>
                  <button
                    className={styles.propertyHeaderItem}
                    data-menu-item
                    onClick={() => move(-1)}
                    disabled={ordered[0]?.id === prop.id}
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                    <span className={styles.propertyHeaderItemText}>{tableViewLabels().moveLeft}</span>
                  </button>
                  <button
                    className={styles.propertyHeaderItem}
                    data-menu-item
                    onClick={() => move(1)}
                    disabled={ordered.at(-1)?.id === prop.id}
                  >
                    <ArrowRight size={15} aria-hidden="true" />
                    <span className={styles.propertyHeaderItemText}>{tableViewLabels().moveRight}</span>
                  </button>
                </div>
                <button
                  className={styles.propertyHeaderItem}
                  data-menu-item
                  onClick={() => void duplicateProperty()}
                  disabled={isTitle || isSystemProp}
                >
                  <Copy size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().duplicateProperty}</span>
                </button>
                <button
                  className={`${styles.propertyHeaderItem} ${styles.propertyDanger}`}
                  data-menu-item
                  onClick={remove}
                  disabled={isTitle}
                >
                  <Trash size={15} aria-hidden="true" />
                  <span className={styles.propertyHeaderItemText}>{tableViewLabels().deleteProperty}</span>
                </button>
              </>
            )}
            {menuPanel === "edit" && (
              <div className={styles.propertyHeaderPanel}>
                <div className={styles.propertyHeaderPanelHead}>
                  <button
                    type="button"
                    aria-label={tableViewLabels().backToPropertyMenu}
                    onClick={() => setMenuPanel("main")}
                  >
                    <ArrowLeft size={16} aria-hidden="true" />
                  </button>
                  <strong>{tableViewLabels().editProperty}</strong>
                  <button type="button" aria-label="Close property menu" onClick={() => closeMenu(true)}>
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
                <label className={styles.propertyHeaderField}>
                  <span>{tableViewLabels().name}</span>
                  <input
                    value={prop.name}
                    autoFocus
                    onChange={(e) => updateProperty(prop.id, { name: e.target.value })}
                    onKeyDown={(e) => {
                      if (isComposingKeyEvent(e)) return;
                      if (e.key !== "Escape" && e.key !== "Enter") return;
                      e.preventDefault();
                      closeMenu(true);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className={styles.propertyHeaderTypeButton}
                  disabled={isTitle || isSystemProp}
                  onClick={() => setMenuPanel("type")}
                >
                  <span>{tableViewLabels().type}</span>
                  <span>
                    <PropertyTypeIcon type={prop.type} size={15} />
                    {localizedPropertyTypeLabel(prop.type)}
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <label className={styles.propertyHeaderField}>
                  <span>{tableViewLabels().description}</span>
                  <textarea
                    value={prop.description ?? ""}
                    placeholder={tableViewLabels().addDescription}
                    rows={2}
                    onChange={(e) =>
                      updateProperty(prop.id, { description: e.target.value || undefined })
                    }
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") return;
                      e.preventDefault();
                      closeMenu(true);
                    }}
                  />
                </label>
                <PropertyTypeConfig prop={prop} onClose={() => closeMenu(true)} />
              </div>
            )}
            {menuPanel === "type" && (
              <div className={styles.propertyHeaderPanel}>
                <div className={styles.propertyHeaderPanelHead}>
                  <button
                    type="button"
                    aria-label={tableViewLabels().backToPropertyMenu}
                    onClick={() => setMenuPanel("main")}
                  >
                    <ArrowLeft size={16} aria-hidden="true" />
                  </button>
                  <strong>{tableViewLabels().changeType}</strong>
                  <button type="button" aria-label="Close property menu" onClick={() => closeMenu(true)}>
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.propertyHeaderTypeSearch}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    value={typeSearch}
                    autoFocus
                    placeholder={tableViewLabels().searchPropertyTypes}
                    aria-label={tableViewLabels().searchPropertyTypes}
                    onChange={(e) => setTypeSearch(e.target.value)}
                  />
                </div>
                <div className={styles.propertyHeaderTypeList}>
                  {filteredPropertyTypeOptions.map((type) => (
                    <button
                      key={type.value}
                      type="button"
                      className={styles.propertyHeaderTypeOption}
                      data-active={type.value === prop.type ? "true" : undefined}
                      disabled={isTitle || isSystemProp}
                      onClick={() => {
                        const nextType = type.value as PropertyType;
                        confirmPropertyTypeChange(prop, nextType, () => {
                          updateProperty(prop.id, {
                            type: nextType,
                            config: configForType(nextType, prop.config, prop.databaseId),
                          });
                          setMenuPanel("edit");
                        });
                      }}
                    >
                      <span>{type.icon}</span>
                      <span>{type.label}</span>
                      {type.value === prop.type && <CheckIcon size={14} aria-hidden="true" />}
                    </button>
                  ))}
                  {filteredPropertyTypeOptions.length === 0 && (
                    <div className={styles.propertiesEmpty}>{tableViewLabels().noSearchResults}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>,
        document.body
      )}
      {typeChangeConfirmDialog}
    </div>
  );
}

function clampColumnWidth(width: number) {
  return Math.max(MIN_PROP_WIDTH, Math.min(MAX_PROP_WIDTH, Math.round(width)));
}

function columnWidth(prop: DbProperty, view: DbView) {
  const width = view.config?.propertyWidths?.[prop.id];
  if (typeof width === "number" && Number.isFinite(width)) {
    return clampColumnWidth(width);
  }
  return prop.type === "title" ? DEFAULT_TITLE_WIDTH : DEFAULT_PROP_WIDTH;
}

function omitKey<T>(record: Record<string, T> | undefined, key: string) {
  if (!record || !(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function AddPropertyButton({
  dbId,
  onAdd,
}: {
  dbId: string;
  onAdd: (type: PropertyType, name: string, config?: PropertyConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [typeSearch, setTypeSearch] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeSearchTerms = typeSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredPropertyTypes =
    typeSearchTerms.length > 0
      ? CREATABLE_PROPERTY_TYPES.filter((type) => {
          const haystack = `${type.label} ${type.type}`.toLowerCase();
          return typeSearchTerms.every((term) => haystack.includes(term));
        })
      : CREATABLE_PROPERTY_TYPES;

  // Position the menu in a portal, clamped to the viewport (the table's
  // horizontal-scroll container would otherwise clip it).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const MENU_WIDTH = 220;
    const MARGIN = 8;
    const r = btnRef.current.getBoundingClientRect();
    const left = Math.min(
      Math.max(MARGIN, r.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - MARGIN
    );
    setPos({ top: r.bottom + 4, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    setTypeSearch("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => btnRef.current?.focus());
    }
  }

  function addSelectedProperty(type: PropertyType, label: string) {
    onAdd(type, label, configForType(type, undefined, dbId));
    closeMenu(true);
  }

  return (
    <div className={styles.addCol} data-add-property-column>
      <button
        ref={btnRef}
        type="button"
        className={styles.addColBtn}
        aria-label={tableViewLabels().addProperty}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            closeMenu(false);
          } else {
            setOpen(true);
          }
        }}
        title={tableViewLabels().addProperty}
      >
        <Plus size={15} aria-hidden="true" />
        <span className={styles.addColText}>{tableViewLabels().addProperty}</span>
      </button>
      <button
        type="button"
        className={styles.addColMoreBtn}
        aria-label={tableViewLabels().propertyOptions}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            closeMenu(false);
          } else {
            setOpen(true);
          }
        }}
        title={tableViewLabels().propertyOptions}
      >
        ...
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <button
              type="button"
              className={styles.menuBackdrop}
              onClick={() => closeMenu(true)}
              tabIndex={-1}
              aria-label={tableViewLabels().closeAddPropertyMenu}
            />
            <div
              ref={menuRef}
              className={styles.propMenu}
              style={{ position: "fixed", top: pos.top, left: pos.left }}
              role="menu"
              tabIndex={-1}
              aria-label="New property type"
              onKeyDown={(e) => onTableMenuKeyDown(e, menuRef.current, () => closeMenu(true))}
            >
              <div className={styles.propMenuLabel}>New property</div>
              <label className={styles.propMenuSearch}>
                <Search size={14} aria-hidden="true" />
                <input
                  ref={searchRef}
                  value={typeSearch}
                  onChange={(e) => setTypeSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (isComposingKeyEvent(e)) return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      menuButtons(menuRef.current)[0]?.focus();
                    } else if (e.key === "Enter" && filteredPropertyTypes[0]) {
                      e.preventDefault();
                      addSelectedProperty(filteredPropertyTypes[0].type, filteredPropertyTypes[0].label);
                    }
                  }}
                  placeholder="Search property types"
                  aria-label="Search property types"
                />
              </label>
              {filteredPropertyTypes.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  className={styles.propMenuItem}
                  data-menu-item
                  role="menuitem"
                  onClick={() => addSelectedProperty(t.type, t.label)}
                >
                  <span className={styles.propGlyph} aria-hidden="true">
                    <PropertyTypeIcon type={t.type} size={15} />
                  </span>
                  <span>{t.label}</span>
                </button>
              ))}
              {filteredPropertyTypes.length === 0 && (
                <div className={styles.propMenuEmpty}>No property types found</div>
              )}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
