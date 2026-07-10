"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { activeDateLocale, pickLabels } from "@/lib/i18n";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { DbProperty, DbView, Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import {
  applyView,
  applyViewFilterSeeds,
  timelineLoadLimit,
  viewFilterSeedValues,
  visibleViewProperties,
} from "./query";
import { NotionSelect } from "./NotionSelect";
import { localizedPropertyTypeLabel } from "./propertyTypes";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { valueAsIds } from "./rollup";
import { PropValue } from "./PropValue";
import { useRowContextMenu, type RowOpenMode } from "./useRowContextMenu";
import { dateKey, parseDate, withTimeOf } from "./dateUtils";
import { Plus } from "../icons";
import styles from "./database.module.css";
import depStyles from "./timelineDeps.module.css";

type TimelineZoom = "day" | "week" | "month";

type ZoomSetting = {
  dayWidth: number;
  rangeDays: number;
};

const ZOOM_SETTINGS: Record<TimelineZoom, ZoomSetting> = {
  day: { dayWidth: 38, rangeDays: 42 },
  week: { dayWidth: 18, rangeDays: 119 },
  month: { dayWidth: 7, rangeDays: 364 },
};

const ZOOM_ORDER: TimelineZoom[] = ["day", "week", "month"];

// Chrome labels (en/ko). Several EN strings double as Playwright selectors in
// CI smokes (e.g. "Timeline zoom", `Open ${title}`) — keep them byte-identical.
const TIMELINE_VIEW_LABELS = {
  en: {
    addDateProperty: "Add a date property",
    addDatePropertyDesc: "Timeline views need a start date property to draw pages across time.",
    addEndDateHint: "Add an end date property to draw ranges instead of single-day bars.",
    dependencies: "Dependencies:",
    dependenciesHint: "add a relation property",
    dependencyRelationProperty: "Dependency relation property",
    jumpTo: (date: string) => `Jump to ${date}`,
    name: "Name",
    newPage: "New",
    newPageIn: (dbTitle: string) => `New page in ${dbTitle}`,
    nextRange: "Next range",
    noDate: (count: number) => `No date (${count})`,
    noDatedItems: "No dated items yet.",
    noItemsInRange: "No items in this range.",
    none: "None",
    openRow: (title: string) => `Open ${title}`,
    previousRange: "Previous range",
    timelineTable: "Timeline table",
    timelineZoom: "Timeline zoom",
    today: "Today",
    untitled: "Untitled",
    zoomDay: "Day",
    zoomMonth: "Month",
    zoomWeek: "Week",
  },
  ko: {
    addDateProperty: "날짜 속성 추가",
    addDatePropertyDesc: "타임라인 뷰는 페이지를 시간축에 표시할 시작일 속성이 필요합니다.",
    addEndDateHint: "종료일 속성을 추가하면 하루짜리 막대 대신 기간으로 표시됩니다.",
    dependencies: "의존 관계:",
    dependenciesHint: "관계형 속성을 추가하세요",
    dependencyRelationProperty: "의존 관계 속성",
    jumpTo: (date: string) => `${date}로 이동`,
    name: "이름",
    newPage: "새 페이지",
    newPageIn: (dbTitle: string) => `새 페이지 추가 (${dbTitle})`,
    nextRange: "다음 범위",
    noDate: (count: number) => `날짜 없음 (${count})`,
    noDatedItems: "아직 날짜가 있는 항목이 없습니다.",
    noItemsInRange: "이 범위에 항목이 없습니다.",
    none: "없음",
    openRow: (title: string) => `${title} 열기`,
    previousRange: "이전 범위",
    timelineTable: "타임라인 표",
    timelineZoom: "타임라인 확대/축소",
    today: "오늘",
    untitled: "제목 없음",
    zoomDay: "일",
    zoomMonth: "월",
    zoomWeek: "주",
  },
} as const;

function timelineViewLabels() {
  return pickLabels(TIMELINE_VIEW_LABELS);
}

function zoomLabel(zoom: TimelineZoom) {
  const labels = timelineViewLabels();
  return zoom === "day" ? labels.zoomDay : zoom === "week" ? labels.zoomWeek : labels.zoomMonth;
}
// Below this width a bar is "narrow": render the title in an overlay/tooltip
// that can extend beyond the bar instead of clipping it.
const NARROW_BAR_PX = 76;
const NARROW_BAR_LABEL_MIN_PX = 92;
const NARROW_BAR_LABEL_MAX_PX = 220;
const NARROW_BAR_LABEL_GAP_PX = 6;

type TimelineItem = {
  row: Page;
  start: Date;
  end: Date;
  first: number;
  last: number;
  lane: number;
};

// Measured screen geometry of a rendered bar, relative to the lanes container.
// Arrows are drawn from these so they line up with the real bar edges even when
// a lane row grows past its minimum height.
type BarRect = {
  left: number;
  right: number;
  midY: number;
};

type TimelineInteraction = {
  mode: "move" | "resize-start" | "resize-end";
  rowId: string;
  lane: number;
  pointerStartX: number;
  baseStartOffset: number;
  baseEndOffset: number;
  durationDays: number;
};

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function diffDays(a: Date, b: Date) {
  const day = 24 * 60 * 60 * 1000;
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcA - utcB) / day);
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// Display-only date labels follow the active UI locale (see i18n.ts).
function monthLabel(date: Date) {
  return date.toLocaleDateString(activeDateLocale(), { month: "short", year: "numeric" });
}

function fullDateLabel(date: Date) {
  return date.toLocaleDateString(activeDateLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function timelineDayLabel(date: Date, zoom: TimelineZoom) {
  const day = date.getDate();
  if (zoom !== "month") return String(day);
  return day === 1 || day === 5 || day === 10 || day === 15 || day === 20 || day === 25
    ? String(day)
    : "";
}

function valueFor(row: Page, prop: DbProperty) {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  return row.properties?.[prop.id];
}

function buildMonthSpans(days: Date[]) {
  const spans: { key: string; label: string; start: number; span: number }[] = [];
  for (let i = 0; i < days.length; i++) {
    const key = `${days[i].getFullYear()}-${days[i].getMonth()}`;
    const last = spans[spans.length - 1];
    if (last?.key === key) {
      last.span += 1;
    } else {
      spans.push({ key, label: monthLabel(days[i]), start: i + 1, span: 1 });
    }
  }
  return spans;
}

function narrowLabelWidth(title: string) {
  return clamp(
    Math.ceil(title.length * 7.2) + 12,
    NARROW_BAR_LABEL_MIN_PX,
    NARROW_BAR_LABEL_MAX_PX
  );
}

function visualLastForLane(item: Omit<TimelineItem, "lane">, dayWidth: number) {
  const widthPx = (item.last - item.first + 1) * dayWidth;
  if (widthPx >= NARROW_BAR_PX) return item.last;
  const title = pageDisplayTitle(item.row);
  const visualWidthPx = widthPx + NARROW_BAR_LABEL_GAP_PX + narrowLabelWidth(title);
  return item.first + Math.ceil(visualWidthPx / dayWidth) - 1;
}

// Greedy interval packing: sort by start, assign each bar to the first lane
// whose previous visible footprint ends before this one starts. Narrow
// single-day bars render their label outside the bar, so the packing reserves
// that label footprint too.
function packLanes(
  items: Omit<TimelineItem, "lane">[],
  dayWidth: number,
  forceUniqueRows = false
): TimelineItem[] {
  const sorted = [...items].sort((a, b) => {
    if (a.first !== b.first) return a.first - b.first;
    return a.last - b.last;
  });
  if (forceUniqueRows) return sorted.map((item, lane) => ({ ...item, lane }));
  const laneEnds: number[] = [];
  return sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end < item.first);
    const visualLast = visualLastForLane(item, dayWidth);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(visualLast);
    } else {
      laneEnds[lane] = visualLast;
    }
    return { ...item, lane };
  });
}

export function TimelineView({
  db,
  view,
  rows: rowsProp,
  readOnly = false,
  search,
  contextPageId,
  onEditRowProperties,
  onOpenRow,
  onOpenRowIn,
}: {
  db: Page;
  view: DbView;
  rows?: Page[];
  readOnly?: boolean;
  search?: string;
  contextPageId?: string;
  onEditRowProperties?: (pageId: string) => void;
  onOpenRow?: (pageId: string) => void;
  onOpenRowIn?: (pageId: string, mode: RowOpenMode) => void;
}) {
  const router = useRouter();
  const reactId = useId();
  const arrowMarkerId = `timeline-dep-arrow-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const addRow = useStore((s) => s.addRow);
  const addProperty = useStore((s) => s.addProperty);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const updateView = useStore((s) => s.updateView);
  const [anchor, setAnchor] = useState(() => startOfMonth(new Date()));
  const [interaction, setInteraction] = useState<TimelineInteraction | null>(null);
  const [preview, setPreview] = useState<{ rowId: string; lane: number; first: number; last: number } | null>(null);
  const [noDateOpen, setNoDateOpen] = useState(false);
  const suppressOpenRef = useRef(false);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollKeyRef = useRef("");
  const barElsRef = useRef(new Map<string, HTMLElement>());
  const [barRects, setBarRects] = useState<Record<string, BarRect>>({});
  const { openRowContextMenu, openRowContextMenuFromElement, rowContextMenu } =
    useRowContextMenu({
      onEditProperties: onEditRowProperties,
      onOpenRowIn,
    });

  const zoom: TimelineZoom = view.config?.timelineZoom ?? "day";
  const { dayWidth: DAY_WIDTH, rangeDays: RANGE_DAYS } = ZOOM_SETTINGS[zoom];
  const loadLimit = timelineLoadLimit(view);
  const showTable = !!view.config?.timelineShowTable;

  const relationProps = props.filter((p) => p.type === "relation");
  const relationPropertyOptions = [
    { value: "", label: timelineViewLabels().none },
    ...relationProps.map((prop) => ({
      value: prop.id,
      label: prop.name || timelineViewLabels().untitled,
      icon: <PropertyTypeIcon type={prop.type} size={14} />,
    })),
  ];
  // The configured dependency relation, but only if it still exists as a relation
  // property. Resolve the id through useMemo so the value is a stable primitive
  // that downstream memos and effects can depend on without the compiler treating
  // it as a possibly-mutated array element.
  const configuredDependency = view.config?.dependencyProperty;
  const dependencyPropId = useMemo(() => {
    if (!configuredDependency) return undefined;
    return relationProps.some((p) => p.id === configuredDependency)
      ? configuredDependency
      : undefined;
  }, [configuredDependency, relationProps]);
  const dependencyProp = relationProps.find((p) => p.id === dependencyPropId);

  const dateProps = props.filter((p) => p.type === "date");
  const startProp =
    dateProps.find((p) => p.id === view.config?.timelineBy) ??
    dateProps.find((p) => p.id === view.config?.calendarBy) ??
    dateProps[0];
  const endProp =
    dateProps.find((p) => p.id === view.config?.timelineEndBy) ?? undefined;
  const days = useMemo(
    () => Array.from({ length: RANGE_DAYS }, (_, i) => addDays(anchor, i)),
    [anchor, RANGE_DAYS]
  );
  const monthSpans = useMemo(() => buildMonthSpans(days), [days]);
  // Memoized like TableView's `shown`: applyView runs a full search-filter +
  // filter-group + multi-key sort over every loaded row on each render.
  const shown = useMemo(
    () => applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [rows, props, view, pagesById, search, contextPageId]
  );
  const metaProps = visibleViewProperties(props, view).filter(
    (p) =>
      p.type !== "title" &&
      p.id !== startProp?.id &&
      p.id !== endProp?.id
  );
  const dbTitle = pageDisplayTitle(db);
  const newPageLabel = timelineViewLabels().newPageIn(dbTitle);

  // All dated rows (regardless of the visible window) and the rows with no date.
  const { datedRows, noDateRows } = useMemo(() => {
    const dated: { row: Page; start: Date; end: Date }[] = [];
    const undated: Page[] = [];
    if (!startProp) return { datedRows: dated, noDateRows: undated };
    for (const row of shown) {
      const start = parseDate(valueFor(row, startProp));
      if (!start) {
        undated.push(row);
        continue;
      }
      const rawEnd = endProp ? parseDate(valueFor(row, endProp)) : null;
      const end = rawEnd && rawEnd >= start ? rawEnd : start;
      dated.push({ row, start, end });
    }
    return { datedRows: dated, noDateRows: undated };
  }, [shown, startProp, endProp]);

  const timelineRows: TimelineItem[] = useMemo(() => {
    if (!startProp) return [];
    const visible = datedRows
      .map(({ row, start, end }) => {
        const first = Math.max(0, diffDays(start, anchor));
        const last = Math.min(RANGE_DAYS - 1, diffDays(end, anchor));
        if (diffDays(end, anchor) < 0 || diffDays(start, anchor) > RANGE_DAYS - 1) {
          return null;
        }
        return { row, start, end, first, last };
      })
      .filter((item): item is Omit<TimelineItem, "lane"> => item !== null)
      .slice(0, loadLimit);
    return packLanes(visible, DAY_WIDTH, showTable);
  }, [datedRows, loadLimit, anchor, RANGE_DAYS, startProp, DAY_WIDTH, showTable]);

  // Set of row ids currently drawn as bars, used to skip dependency pairs whose
  // endpoints are not both visible/positioned in the window.
  const positionedRowIds = useMemo(
    () => new Set(timelineRows.map((item) => item.row.id)),
    [timelineRows]
  );

  // Dependency pairs as [dependentRowId, predecessorRowId]. The relation on the
  // dependent row points at its predecessors (rows that must finish first), so an
  // arrow runs from each predecessor's end to the dependent's start.
  const dependencyPairs = useMemo<[string, string][]>(() => {
    if (!dependencyPropId) return [];
    const pairs: [string, string][] = [];
    for (const item of timelineRows) {
      const predecessorIds = valueAsIds(item.row.properties?.[dependencyPropId]);
      for (const predId of predecessorIds) {
        if (predId === item.row.id) continue;
        if (!positionedRowIds.has(predId)) continue;
        pairs.push([item.row.id, predId]);
      }
    }
    return pairs;
  }, [dependencyPropId, timelineRows, positionedRowIds]);

  // Resolve each pair into measured pixel endpoints. Arrows start at the
  // predecessor bar's right edge and end at the dependent bar's left edge.
  const arrows = useMemo(() => {
    if (!dependencyPropId) return [];
    return dependencyPairs
      .map(([depId, predId]) => {
        const dep = barRects[depId];
        const pred = barRects[predId];
        if (!dep || !pred) return null;
        return {
          key: `${predId}->${depId}`,
          x1: pred.right,
          y1: pred.midY,
          x2: dep.left,
          y2: dep.midY,
        };
      })
      .filter((arrow): arrow is NonNullable<typeof arrow> => arrow !== null);
  }, [dependencyPropId, dependencyPairs, barRects]);

  // Earliest dated row outside the current window, for the "jump" empty state.
  const earliestDate = useMemo(() => {
    let earliest: Date | null = null;
    for (const { start } of datedRows) {
      if (!earliest || start < earliest) earliest = start;
    }
    return earliest;
  }, [datedRows]);

  const todayIndex = diffDays(new Date(), anchor);
  const gridTemplate = `repeat(${RANGE_DAYS}, ${DAY_WIDTH}px)`;

  async function createDateProperty() {
    if (readOnly) return;
    const prop = await addProperty(db.id, "date", "Date");
    updateView(view.id, { config: { ...view.config, timelineBy: prop.id } });
  }

  function setZoom(next: TimelineZoom) {
    if (readOnly) return;
    if (next === zoom) return;
    updateView(view.id, { config: { ...view.config, timelineZoom: next } });
  }

  function setDependencyProperty(value: string) {
    if (readOnly) return;
    updateView(view.id, {
      config: { ...view.config, dependencyProperty: value || undefined },
    });
  }

  async function addAtStart() {
    if (readOnly) return;
    if (!startProp) return;
    const row = await addRow(db.id, true, undefined, { focusTitle: true });
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [startProp.id], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
    setRowProperty(row.id, startProp.id, dateKey(anchor), { debounce: false });
    openRow(row.id);
  }

  // Page by the full visible span instead of a fixed month.
  function moveRange(direction: -1 | 1) {
    setAnchor((cur) => startOfMonth(addDays(cur, direction * RANGE_DAYS)));
  }

  function jumpToEarliest() {
    if (earliestDate) setAnchor(startOfMonth(earliestDate));
  }

  function openRow(pageId: string) {
    if (onOpenRow) {
      onOpenRow(pageId);
    } else {
      router.push(pageHref(pageId));
    }
  }

  function openRowClick(pageId: string, e: React.MouseEvent<HTMLElement>) {
    if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
    else openRow(pageId);
  }

  function openKeyboardRowMenu(pageId: string, target: EventTarget | null) {
    setInteraction(null);
    setPreview(null);
    suppressOpenRef.current = false;
    openRowContextMenuFromElement(pageId, target instanceof HTMLElement ? target : null);
  }

  // Shift a focused bar's start (and end, if any) date by a number of days.
  function shiftRowDate(item: TimelineItem, deltaDays: number) {
    if (readOnly) return;
    if (!startProp) return;
    const nextStart = addDays(item.start, deltaDays);
    setRowProperty(item.row.id, startProp.id, withTimeOf(valueFor(item.row, startProp), nextStart), {
      debounce: false,
    });
    if (endProp) {
      const nextEnd = addDays(item.end, deltaDays);
      setRowProperty(item.row.id, endProp.id, withTimeOf(valueFor(item.row, endProp), nextEnd), {
        debounce: false,
      });
    }
  }

  function onBarKeyDown(item: TimelineItem, e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      e.stopPropagation();
      openKeyboardRowMenu(item.row.id, e.currentTarget);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) openPageInNewTab(item.row.id);
      else openRow(item.row.id);
      return;
    }
    // Arrow keys reschedule: ±1 day, or ±7 days with Shift.
    const step = e.shiftKey ? 7 : 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      shiftRowDate(item, -step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      shiftRowDate(item, step);
    }
  }

  function previewFor(nextInteraction: TimelineInteraction, clientX: number) {
    const delta = Math.round((clientX - nextInteraction.pointerStartX) / DAY_WIDTH);
    const maxIndex = RANGE_DAYS - 1;
    const visibleDuration = Math.min(nextInteraction.durationDays, maxIndex);
    let startOffset = nextInteraction.baseStartOffset;
    let endOffset = nextInteraction.baseEndOffset;

    if (nextInteraction.mode === "move") {
      startOffset = clamp(
        nextInteraction.baseStartOffset + delta,
        0,
        Math.max(0, maxIndex - visibleDuration)
      );
      endOffset = startOffset + nextInteraction.durationDays;
    } else if (nextInteraction.mode === "resize-start") {
      startOffset = clamp(
        nextInteraction.baseStartOffset + delta,
        0,
        clamp(nextInteraction.baseEndOffset, 0, maxIndex)
      );
    } else {
      endOffset = clamp(
        nextInteraction.baseEndOffset + delta,
        clamp(nextInteraction.baseStartOffset, 0, maxIndex),
        maxIndex
      );
    }

    return {
      startOffset,
      endOffset,
      first: clamp(startOffset, 0, maxIndex),
      last: clamp(endOffset, 0, maxIndex),
    };
  }

  function beginInteraction(
    e: ReactPointerEvent<HTMLElement>,
    item: TimelineItem,
    mode: TimelineInteraction["mode"]
  ) {
    if (readOnly) return;
    if (e.button !== 0) return;
    if (mode !== "move") e.preventDefault();
    e.stopPropagation();

    const baseStartOffset = diffDays(item.start, anchor);
    const baseEndOffset = diffDays(item.end, anchor);
    const nextInteraction = {
      mode,
      rowId: item.row.id,
      lane: item.lane,
      pointerStartX: e.clientX,
      baseStartOffset,
      baseEndOffset,
      durationDays: Math.max(0, diffDays(item.end, item.start)),
    };

    setInteraction(nextInteraction);
    setPreview({
      rowId: item.row.id,
      lane: item.lane,
      first: clamp(baseStartOffset, 0, RANGE_DAYS - 1),
      last: clamp(baseEndOffset, 0, RANGE_DAYS - 1),
    });
  }

  // The pointer-drag effect below binds window listeners for the duration of a
  // single interaction and must NOT resubscribe mid-drag (that would drop the
  // in-flight pointer capture). But its commit path needs the *current*
  // pagesById (to read the live cell value being edited) and the current
  // previewFor closure. Keep those in a ref refreshed every render so the
  // handlers read fresh values without re-registering.
  const dragLatestRef = useRef({ pagesById, previewFor });
  useEffect(() => {
    dragLatestRef.current = { pagesById, previewFor };
  });

  useEffect(() => {
    if (readOnly || !interaction || !startProp) return;
    const activeInteraction = interaction;

    function move(clientX: number) {
      if (Math.abs(clientX - activeInteraction.pointerStartX) > 4) {
        suppressOpenRef.current = true;
      }
      const next = dragLatestRef.current.previewFor(activeInteraction, clientX);
      setPreview({
        rowId: activeInteraction.rowId,
        lane: activeInteraction.lane,
        first: next.first,
        last: next.last,
      });
      return next;
    }

    function onPointerMove(e: PointerEvent) {
      move(e.clientX);
    }

    function onPointerUp(e: PointerEvent) {
      const next = move(e.clientX);
      if (next && suppressOpenRef.current) {
        const nextStart = addDays(anchor, next.startOffset);
        const nextEnd = addDays(anchor, next.endOffset);
        const activeRow = dragLatestRef.current.pagesById[activeInteraction.rowId];
        if (activeInteraction.mode === "move" || activeInteraction.mode === "resize-start") {
          const curr = activeRow ? valueFor(activeRow, startProp) : undefined;
          setRowProperty(activeInteraction.rowId, startProp.id, withTimeOf(curr, nextStart), {
            debounce: false,
          });
        }
        if (endProp && (activeInteraction.mode === "move" || activeInteraction.mode === "resize-end")) {
          const curr = activeRow ? valueFor(activeRow, endProp) : undefined;
          setRowProperty(activeInteraction.rowId, endProp.id, withTimeOf(curr, nextEnd), {
            debounce: false,
          });
        }
      }
      setInteraction(null);
      setPreview(null);
      window.setTimeout(() => {
        suppressOpenRef.current = false;
      }, 0);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [anchor, endProp, interaction, readOnly, setRowProperty, startProp, DAY_WIDTH, RANGE_DAYS]);

  // Callback ref that records each bar element so the overlay can measure it.
  const setBarEl = useCallback(
    (rowId: string) => (el: HTMLElement | null) => {
      if (el) barElsRef.current.set(rowId, el);
      else barElsRef.current.delete(rowId);
    },
    []
  );

  // Read every bar's box relative to the lanes container. Called only from the
  // ResizeObserver callback (never synchronously in the effect body) so it does
  // not trip the set-state-in-effect rule.
  const measureBars = useCallback(() => {
    const lanes = lanesRef.current;
    if (!lanes) return;
    const base = lanes.getBoundingClientRect();
    const next: Record<string, BarRect> = {};
    barElsRef.current.forEach((el, rowId) => {
      const r = el.getBoundingClientRect();
      next[rowId] = {
        left: r.left - base.left,
        right: r.right - base.left,
        midY: r.top - base.top + r.height / 2,
      };
    });
    setBarRects((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length) {
        let same = true;
        for (const id of nextKeys) {
          const a = prev[id];
          const b = next[id];
          if (!a || a.left !== b.left || a.right !== b.right || a.midY !== b.midY) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  // Stable signature of the current bar layout; re-observe whenever it changes.
  const layoutSignature = useMemo(
    () =>
      timelineRows
        .map((item) => `${item.row.id}:${item.first}:${item.last}:${item.lane}`)
        .join("|"),
    [timelineRows]
  );

  // Only measure while dependency arrows are active; the observer fires once on
  // observe (priming the initial rects) and again on any resize/reflow. When the
  // feature is off the arrows memo gates on dependencyPropId, so any leftover
  // rects are simply never rendered.
  useEffect(() => {
    if (!dependencyPropId) return;
    const lanes = lanesRef.current;
    if (!lanes || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureBars());
    observer.observe(lanes);
    barElsRef.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [dependencyPropId, measureBars, layoutSignature, DAY_WIDTH]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (todayIndex < 0 || todayIndex >= RANGE_DAYS) return;

    const visibleFirst =
      timelineRows.length > 0
        ? Math.min(...timelineRows.map((item) => item.first))
        : null;
    const key = `${dateKey(anchor)}:${zoom}:${visibleFirst ?? "empty"}`;
    if (autoScrollKeyRef.current === key) return;
    autoScrollKeyRef.current = key;

    let target =
      todayIndex * DAY_WIDTH - (scroller.clientWidth - DAY_WIDTH) / 2;
    if (visibleFirst !== null && scroller.clientWidth < 640) {
      target = Math.max(target, visibleFirst * DAY_WIDTH - DAY_WIDTH);
    }
    scroller.scrollLeft = clamp(
      target,
      0,
      Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    );
  }, [anchor, zoom, todayIndex, RANGE_DAYS, DAY_WIDTH, timelineRows]);

  if (!startProp) {
    return (
      <div className={styles.timelineEmpty}>
        <div className={styles.viewEmptyTitle}>{timelineViewLabels().addDateProperty}</div>
        <div className={styles.viewEmptyDesc}>
          {timelineViewLabels().addDatePropertyDesc}
        </div>
        {!readOnly && (
          <button type="button" onClick={() => void createDateProperty()}>
            <Plus size={14} aria-hidden="true" />
            {localizedPropertyTypeLabel("date")}
          </button>
        )}
      </div>
    );
  }

  const lanesEmpty = timelineRows.length === 0;

  return (
    <div className={styles.timeline}>
      <div className={styles.timelineToolbar}>
        <div className={styles.timelineTitle}>
          {monthLabel(anchor)} - {monthLabel(addDays(anchor, RANGE_DAYS - 1))}
        </div>
        <div className={styles.timelineControls}>
          <div className={styles.timelineZoom} role="group" aria-label={timelineViewLabels().timelineZoom}>
            {ZOOM_ORDER.map((z) => (
              <button
                key={z}
                type="button"
                className={styles.timelineZoomBtn}
                data-active={z === zoom ? "true" : undefined}
                aria-pressed={z === zoom}
                disabled={readOnly}
                onClick={() => setZoom(z)}
              >
                {zoomLabel(z)}
              </button>
            ))}
          </div>
          {relationProps.length > 0 ? (
            <div className={depStyles.depControl}>
              {timelineViewLabels().dependencies}
              <NotionSelect
                className={depStyles.depSelect}
                ariaLabel={timelineViewLabels().dependencyRelationProperty}
                value={dependencyProp?.id ?? ""}
                options={relationPropertyOptions}
                disabled={readOnly}
                onChange={setDependencyProperty}
              />
            </div>
          ) : (
            <span className={depStyles.depControl}>
              {timelineViewLabels().dependencies}
              <span className={depStyles.depControlHint}>{timelineViewLabels().dependenciesHint}</span>
            </span>
          )}
          <button type="button" onClick={() => setAnchor(startOfMonth(new Date()))}>
            {timelineViewLabels().today}
          </button>
          <button type="button" aria-label={timelineViewLabels().previousRange} onClick={() => moveRange(-1)}>
            {"<"}
          </button>
          <button type="button" aria-label={timelineViewLabels().nextRange} onClick={() => moveRange(1)}>
            {">"}
          </button>
          {!readOnly && (
            <button
              type="button"
              className={styles.timelineNew}
              title={newPageLabel}
              aria-label={newPageLabel}
              onClick={() => void addAtStart()}
            >
              <Plus size={15} aria-hidden="true" /> {timelineViewLabels().newPage}
            </button>
          )}
        </div>
      </div>

      {!endProp && (
        <div className={styles.timelineHint}>
          {timelineViewLabels().addEndDateHint}
        </div>
      )}

      <div className={styles.timelineBody} data-show-table={showTable ? "true" : undefined}>
        {showTable && (
          <div className={styles.timelineTablePane} aria-label={timelineViewLabels().timelineTable}>
            <div className={styles.timelineTableHead}>{timelineViewLabels().name}</div>
            <div className={styles.timelineTableRows}>
              {timelineRows.map((item) => {
                const title = pageDisplayTitle(item.row);
                return (
                  <button
                    key={item.row.id}
                    type="button"
                    className={styles.timelineTableRow}
                    style={{ gridRow: item.lane + 1 }}
                    title={title}
                    onKeyDown={(e) => {
                      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                      e.preventDefault();
                      e.stopPropagation();
                      openKeyboardRowMenu(item.row.id, e.currentTarget);
                    }}
                    onClick={(e) => openRowClick(item.row.id, e)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        openPageInNewTab(item.row.id);
                      }
                    }}
                    onContextMenu={(e) => openRowContextMenu(item.row.id, e)}
                  >
                    <span>{title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div ref={scrollRef} className={styles.timelineScroll}>
          <div className={styles.timelineCanvas} style={{ minWidth: RANGE_DAYS * DAY_WIDTH }}>
          <div className={styles.timelineMonths} style={{ gridTemplateColumns: gridTemplate }}>
            {monthSpans.map((span) => (
              <div
                key={span.key}
                className={styles.timelineMonth}
                style={{ gridColumn: `${span.start} / span ${span.span}` }}
              >
                {span.label}
              </div>
            ))}
          </div>
          <div className={styles.timelineDays} style={{ gridTemplateColumns: gridTemplate }}>
            {days.map((day) => {
              const label = timelineDayLabel(day, zoom);
              return (
                <div
                  key={dateKey(day)}
                  className={styles.timelineDay}
                  data-timeline-day-label={label ? "true" : undefined}
                  data-weekend={day.getDay() === 0 || day.getDay() === 6 ? "true" : undefined}
                  title={fullDateLabel(day)}
                >
                  {label}
                </div>
              );
            })}
          </div>
          <div
            ref={lanesRef}
            className={styles.timelineLanes}
            style={{ gridTemplateColumns: gridTemplate, backgroundSize: `${DAY_WIDTH}px 100%` }}
          >
            {todayIndex >= 0 && todayIndex < RANGE_DAYS && (
              <div
                className={styles.timelineToday}
                style={{ left: todayIndex * DAY_WIDTH + DAY_WIDTH / 2 }}
              />
            )}
            {preview && (
              <div
                className={styles.timelineDropPreview}
                style={{
                  gridColumn: `${preview.first + 1} / ${preview.last + 2}`,
                  gridRow: preview.lane + 1,
                }}
              />
            )}
            {timelineRows.map((item) => {
              const widthPx = (item.last - item.first + 1) * DAY_WIDTH;
              const narrow = widthPx < NARROW_BAR_PX;
              const title = pageDisplayTitle(item.row);
              const tooltip = `${title} · ${fullDateLabel(item.start)}${
                endProp && item.end > item.start ? ` – ${fullDateLabel(item.end)}` : ""
              }`;
              return (
                <button
                  type="button"
                  key={item.row.id}
                  ref={dependencyProp ? setBarEl(item.row.id) : undefined}
                  className={styles.timelineBar}
                  data-narrow={narrow ? "true" : undefined}
                  aria-label={timelineViewLabels().openRow(title)}
                  title={tooltip}
                  data-moving={interaction?.rowId === item.row.id ? "true" : undefined}
                  style={{
                    gridColumn: `${item.first + 1} / ${item.last + 2}`,
                    gridRow: item.lane + 1,
                  }}
                  onPointerDown={(e) => beginInteraction(e, item, "move")}
                  onPointerUp={() => {
                    if (!suppressOpenRef.current) {
                      setInteraction(null);
                      setPreview(null);
                    }
                  }}
                  onKeyDown={(e) => onBarKeyDown(item, e)}
                  onClick={(e) => {
                    if (suppressOpenRef.current) {
                      e.preventDefault();
                      e.stopPropagation();
                      return;
                    }
                    openRowClick(item.row.id, e);
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1 && !suppressOpenRef.current) {
                      e.preventDefault();
                      openPageInNewTab(item.row.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    setInteraction(null);
                    setPreview(null);
                    suppressOpenRef.current = false;
                    openRowContextMenu(item.row.id, e);
                  }}
                >
                  {endProp && !readOnly && (
                    <span
                      className={styles.timelineResizeHandle}
                      data-side="start"
                      onPointerDown={(e) => beginInteraction(e, item, "resize-start")}
                    />
                  )}
                  <span className={styles.timelineBarLabel}>
                    <span className={styles.timelineBarTitle}>
                      {title}
                    </span>
                    {!narrow && (
                      <span className={styles.timelineBarMeta}>
                        {metaProps.slice(0, 2).map((prop) => (
                          <PropValue
                            key={prop.id}
                            row={item.row}
                            prop={prop}
                            interactive={!readOnly && !item.row.isLocked}
                            onOpenPage={openRow}
                          />
                        ))}
                      </span>
                    )}
                  </span>
                  {endProp && !readOnly && (
                    <span
                      className={styles.timelineResizeHandle}
                      data-side="end"
                      onPointerDown={(e) => beginInteraction(e, item, "resize-end")}
                    />
                  )}
                </button>
              );
            })}
            {dependencyProp && arrows.length > 0 && (
              <svg className={depStyles.depOverlay} aria-hidden="true">
                <defs>
                  <marker
                    id={arrowMarkerId}
                    viewBox="0 0 8 8"
                    refX="6"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path className={depStyles.depArrowFill} d="M0,0 L8,4 L0,8 Z" />
                  </marker>
                </defs>
                {arrows.map((arrow) => {
                  // Orthogonal elbow: out from the predecessor end, across the gap
                  // at a midpoint, then into the dependent start. A small horizontal
                  // stub on each side keeps the arrowhead square to the bars.
                  const stub = 10;
                  const midX = (arrow.x1 + stub + (arrow.x2 - stub)) / 2;
                  const d = `M ${arrow.x1} ${arrow.y1} L ${arrow.x1 + stub} ${arrow.y1} L ${midX} ${arrow.y1} L ${midX} ${arrow.y2} L ${arrow.x2 - stub} ${arrow.y2} L ${arrow.x2} ${arrow.y2}`;
                  return (
                    <path
                      key={arrow.key}
                      className={depStyles.depPath}
                      d={d}
                      markerEnd={`url(#${arrowMarkerId})`}
                    />
                  );
                })}
              </svg>
            )}
            {lanesEmpty && (
              <div className={styles.timelineLanesEmpty}>
                {earliestDate ? (
                  <>
                    <span>{timelineViewLabels().noItemsInRange}</span>
                    <button type="button" onClick={jumpToEarliest}>
                      {timelineViewLabels().jumpTo(fullDateLabel(earliestDate))}
                    </button>
                  </>
                ) : (
                  <span>{timelineViewLabels().noDatedItems}</span>
                )}
              </div>
            )}
          </div>
          </div>
        </div>
      </div>

      {noDateRows.length > 0 && (
        <div className={styles.timelineNoDate}>
          <button
            type="button"
            className={styles.timelineNoDateHead}
            aria-expanded={noDateOpen}
            onClick={() => setNoDateOpen((v) => !v)}
          >
            <span data-open={noDateOpen ? "true" : undefined}>{"›"}</span>
            {timelineViewLabels().noDate(noDateRows.length)}
          </button>
          {noDateOpen && (
            <div className={styles.timelineNoDateList}>
              {noDateRows.map((row) => {
                const title = pageDisplayTitle(row);
                return (
                  <button
                    type="button"
                    key={row.id}
                    className={styles.timelineNoDateRow}
                    onKeyDown={(e) => {
                      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                      e.preventDefault();
                      e.stopPropagation();
                      openKeyboardRowMenu(row.id, e.currentTarget);
                    }}
                    onClick={(e) => openRowClick(row.id, e)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        openPageInNewTab(row.id);
                      }
                    }}
                    onContextMenu={(e) => openRowContextMenu(row.id, e)}
                  >
                    {title}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {rowContextMenu}
    </div>
  );
}
