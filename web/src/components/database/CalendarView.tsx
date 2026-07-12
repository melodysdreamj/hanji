"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { activeDateLocale } from "@/lib/i18n";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { DbProperty, DbView, Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import {
  applyView,
  applyViewFilterSeeds,
  viewFilterSeedValues,
  visibleViewProperties,
} from "./query";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { PropValue } from "./PropValue";
import { useRowContextMenu, type RowOpenMode } from "./useRowContextMenu";
import { addDays, dateKey, extractTime, parseDate, shiftDateValueToDay } from "./dateUtils";
import { ChevronLeft, ChevronRight, Plus } from "../icons";
import styles from "./database.module.css";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const CALENDAR_MAX_CARDS = 3;
const CALENDAR_CARD_DRAG = "application/x-hanji-calendar-card";
const DRAG_THRESHOLD = 4;

function monthCells(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  // Render only the weeks the month actually spans (5 or 6) instead of a fixed
  // 6, so short months don't show a trailing all-outside week.
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return date;
  });
}

function weekCells(anchor: Date) {
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return date;
  });
}

function monthLabel(date: Date) {
  return date.toLocaleDateString(activeDateLocale(), { month: "long", year: "numeric" });
}

function shortDateLabel(date: Date) {
  return date.toLocaleDateString(activeDateLocale(), { month: "short", day: "numeric" });
}

function fullDateLabel(date: Date) {
  return date.toLocaleDateString(activeDateLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function calendarTitle(anchor: Date, layout: "month" | "week") {
  if (layout === "month") return monthLabel(anchor);
  const cells = weekCells(anchor);
  const first = cells[0];
  const last = cells[cells.length - 1];
  return `${shortDateLabel(first)} - ${shortDateLabel(last)}, ${last.getFullYear()}`;
}

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthFromKey(key: string) {
  const [year, month] = key.split("-").map(Number);
  return Number.isFinite(year) && Number.isFinite(month)
    ? new Date(year, month - 1, 1)
    : monthStart(new Date());
}

function suggestedCalendarMonth(rows: Page[], dateProp: DbProperty | undefined) {
  if (!dateProp) return monthStart(new Date());
  const counts = new Map<string, { date: Date; count: number; firstIndex: number }>();
  rows.forEach((row, index) => {
    const date = parseDate(valueFor(row, dateProp));
    if (!date) return;
    const start = monthStart(date);
    const key = monthKey(start);
    const current = counts.get(key);
    counts.set(key, {
      date: start,
      count: (current?.count ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index,
    });
  });
  const best = Array.from(counts.values()).sort(
    (a, b) => b.count - a.count || a.firstIndex - b.firstIndex
  )[0];
  return best?.date ?? monthStart(new Date());
}

// Shift a (possibly range) calendar date value by whole days, preserving the
// start time-of-day AND the end date/time — arrow-key nudges must behave
// exactly like a drag, which routes through shiftDateValueToDay. A bare
// dateKey() (the old shiftDateKey) silently dropped the THH:MM and the end
// date. Mirrors TimelineView's shiftRowDate.
export function shiftDateValueByDays(value: unknown, deltaDays: number): string | null {
  const start = parseDate(value);
  if (!start) return null;
  return shiftDateValueToDay(value, addDays(start, deltaDays));
}

// Time portion of a date value ("HH:MM") used to order cards within a day, so
// the day's column reads chronologically rather than in the global view sort.
function dateTimeOf(value: unknown): string {
  return extractTime(value);
}

function valueFor(row: Page, prop: DbProperty) {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  return row.properties?.[prop.id];
}

export function CalendarView({
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
  const { t } = useTranslation("calendarView");
  const router = useRouter();
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const addRow = useStore((s) => s.addRow);
  const addProperty = useStore((s) => s.addProperty);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const updateView = useStore((s) => s.updateView);
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  // Movement-threshold guard: a card "drag" only counts as a reschedule once the
  // pointer has actually moved past DRAG_THRESHOLD px from where it went down, so
  // a slightly-shaky click doesn't silently move the event to another day.
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragMovedRef = useRef(false);
  const { openRowContextMenu, openRowContextMenuFromElement, rowContextMenu } =
    useRowContextMenu({
      onEditProperties: onEditRowProperties,
      onOpenRowIn,
    });

  const dateProps = props.filter((p) => p.type === "date");
  const dateProp =
    dateProps.find((p) => p.id === view.config?.calendarBy) ?? dateProps[0];
  const calendarLayout = view.config?.calendarLayout ?? "month";
  const datePropertyOptions = dateProps.map((prop) => ({
    value: prop.id,
    label: prop.name || t("calendarView:property.untitled"),
    icon: <PropertyTypeIcon type={prop.type} size={14} />,
  }));
  // Memoized like TableView's `shown`: applyView runs a full search-filter +
  // filter-group + multi-key sort over every loaded row on each render.
  const shown = useMemo(
    () => applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [rows, props, view, pagesById, search, contextPageId]
  );
  const suggestedMonthKey = monthKey(suggestedCalendarMonth(shown, dateProp));
  const [month, setMonth] = useState(() => monthFromKey(suggestedMonthKey));
  const monthAnchorRef = useRef("");
  const monthAnchor = `${db.id}:${view.id}:${dateProp?.id ?? ""}`;
  const metaProps = visibleViewProperties(props, view).filter(
    (p) =>
      p.type !== "title" &&
      p.id !== dateProp?.id
  );
  const cells = useMemo(
    () => (calendarLayout === "week" ? weekCells(month) : monthCells(month)),
    [calendarLayout, month]
  );

  useEffect(() => {
    // Derive the visible month from row data ONLY when the anchor (db / view /
    // date property) changes. Re-deriving on every suggestedMonthKey change
    // made the calendar jump out from under a user who was browsing months as
    // rows loaded or a row's date changed. Once mounted for an anchor, month
    // navigation is driven solely by the user (or an explicit anchor switch).
    if (monthAnchorRef.current !== monthAnchor) {
      monthAnchorRef.current = monthAnchor;
      setMonth(monthFromKey(suggestedMonthKey));
    }
  }, [monthAnchor, suggestedMonthKey]);

  // Per-day bucketing + in-day sorting walk every shown row; memoize with
  // `shown` so drag/hover re-renders don't redo the whole calendar layout.
  const { rowsByDay, noDateRows } = useMemo(() => {
    const byDay = new Map<string, Page[]>();
    const undated: Page[] = [];
    if (dateProp) {
      for (const row of shown) {
        const date = parseDate(valueFor(row, dateProp));
        if (!date) {
          undated.push(row);
          continue;
        }
        const key = dateKey(date);
        byDay.set(key, [...(byDay.get(key) ?? []), row]);
      }
      // Within a day, order by the date property's time (then title) so the column
      // reads chronologically rather than following the global view sort.
      for (const dayRows of byDay.values()) {
        dayRows.sort((a, b) => {
          const byTime = dateTimeOf(valueFor(a, dateProp)).localeCompare(
            dateTimeOf(valueFor(b, dateProp)),
          );
          if (byTime !== 0) return byTime;
          return pageDisplayTitle(a).localeCompare(pageDisplayTitle(b));
        });
      }
    }
    return { rowsByDay: byDay, noDateRows: undated };
  }, [shown, dateProp]);

  async function createDateProperty() {
    if (readOnly) return;
    const prop = await addProperty(db.id, "date", t("calendarView:property.dateDefaultName"));
    if (!prop) return;
    updateView(view.id, { config: { ...view.config, calendarBy: prop.id } });
  }

  async function addOn(day: Date) {
    if (readOnly) return;
    if (!dateProp) return;
    const row = await addRow(db.id, true, undefined, { focusTitle: true });
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [dateProp.id], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
    setRowProperty(row.id, dateProp.id, dateKey(day), { debounce: false });
    openRow(row.id);
  }

  function moveMonth(delta: number) {
    setMonth((cur) => {
      if (calendarLayout === "week") {
        const next = new Date(cur);
        next.setDate(next.getDate() + delta * 7);
        return next;
      }
      return new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
    });
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
    openRowContextMenuFromElement(pageId, target instanceof HTMLElement ? target : null);
  }

  function moveRowToDay(day: Date, rowId = draggingRowId) {
    if (readOnly) return;
    if (!dateProp || !rowId) return;
    // Preserve the event's time-of-day and range duration when dragging to a
    // new day (a bare dateKey(day) silently dropped the time and end date).
    const current = pagesById[rowId]?.properties?.[dateProp.id];
    setRowProperty(rowId, dateProp.id, shiftDateValueToDay(current, day), { debounce: false });
    setDraggingRowId(null);
    setDragOverDay(null);
  }

  if (!dateProp) {
    return (
      <div className={styles.calendarEmpty}>
        <div className={styles.viewEmptyTitle}>{t("calendarView:empty.title")}</div>
        <div className={styles.viewEmptyDesc}>
          {t("calendarView:empty.description")}
        </div>
        {!readOnly && (
          <button type="button" onClick={() => void createDateProperty()}>
            <Plus size={14} aria-hidden="true" />
            {t("calendarView:empty.addDateButton")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.calendar} data-layout={calendarLayout}>
      <div className={styles.calendarToolbar}>
        <div className={styles.calendarTitle}>{calendarTitle(month, calendarLayout)}</div>
        <div className={styles.calendarControls}>
          {dateProps.length > 1 && (
            <NotionSelect
              className={styles.calendarSelect}
              ariaLabel={t("calendarView:toolbar.calendarByAriaLabel")}
              value={dateProp.id}
              options={datePropertyOptions}
              disabled={readOnly}
              onChange={(value) =>
                updateView(view.id, {
                  config: { ...view.config, calendarBy: value || undefined },
                })
              }
            />
          )}
          <button
            type="button"
            className={styles.calendarTodayButton}
            onClick={() => {
              setMonth(new Date());
            }}
          >
            {t("calendarView:toolbar.today")}
          </button>
          <button
            type="button"
            className={styles.calendarNavButton}
            aria-label={
              calendarLayout === "week"
                ? t("calendarView:toolbar.previousWeek")
                : t("calendarView:toolbar.previousMonth")
            }
            title={
              calendarLayout === "week"
                ? t("calendarView:toolbar.previousWeek")
                : t("calendarView:toolbar.previousMonth")
            }
            onClick={() => moveMonth(-1)}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className={styles.calendarNavButton}
            aria-label={
              calendarLayout === "week"
                ? t("calendarView:toolbar.nextWeek")
                : t("calendarView:toolbar.nextMonth")
            }
            title={
              calendarLayout === "week"
                ? t("calendarView:toolbar.nextWeek")
                : t("calendarView:toolbar.nextMonth")
            }
            onClick={() => moveMonth(1)}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div
        className={styles.calendarGrid}
        role="grid"
        aria-label={t("calendarView:gridAriaLabel", { title: calendarTitle(month, calendarLayout) })}
        aria-colcount={7}
        aria-rowcount={Math.ceil(cells.length / 7) + 1}
      >
        <div className={styles.calendarGridWeek} role="row">
          {WEEKDAYS.map((day) => (
            <div key={day} className={styles.calendarWeekday} role="columnheader">
              {t(`calendarView:weekdays.${day}`)}
            </div>
          ))}
        </div>
        {Array.from({ length: Math.ceil(cells.length / 7) }, (_, weekIndex) => (
          <div className={styles.calendarGridWeek} role="row" key={`week-${weekIndex}`}>
          {cells.slice(weekIndex * 7, weekIndex * 7 + 7).map((day) => {
          const key = dateKey(day);
          const dayRows = rowsByDay.get(key) ?? [];
          const outside = calendarLayout === "month" && day.getMonth() !== month.getMonth();
          const today = key === dateKey(new Date());
          return (
            // Empty-cell click is a pointer convenience. The dated "New row"
            // button inside every writable cell is the keyboard/AT equivalent.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={key}
              className={styles.calendarCell}
              role="gridcell"
              tabIndex={-1}
              aria-label={t("calendarView:cell.ariaLabel", {
                date: fullDateLabel(day),
                count: dayRows.length,
              })}
              aria-current={today ? "date" : undefined}
              data-outside={outside ? "true" : undefined}
              data-today={today ? "true" : undefined}
              data-drag-over={dragOverDay === key ? "true" : undefined}
              onClick={(e) => {
                if (readOnly) return;
                // Click empty space in a day to create a row on that day; ignore
                // clicks that land on a card or the +/more buttons.
                if ((e.target as HTMLElement).closest("button")) return;
                void addOn(day);
              }}
              onDragOver={(e) => {
                if (readOnly) return;
                const isCalendarCard =
                  draggingRowId || Array.from(e.dataTransfer.types).includes(CALENDAR_CARD_DRAG);
                if (!isCalendarCard) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverDay(key);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDragOverDay((cur) => (cur === key ? null : cur));
              }}
              onDrop={(e) => {
                if (readOnly) return;
                e.preventDefault();
                moveRowToDay(day, e.dataTransfer.getData(CALENDAR_CARD_DRAG) || draggingRowId);
              }}
            >
              <div className={styles.calendarDayHead}>
                <span>{day.getDate()}</span>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={t("calendarView:cell.newRowAriaLabel", { date: key })}
                    title={t("calendarView:cell.newRowTitle")}
                    onClick={() => void addOn(day)}
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
              <div className={styles.calendarCards}>
                {(expandedDays.has(key) ? dayRows : dayRows.slice(0, CALENDAR_MAX_CARDS)).map((row) => {
                  const title = pageDisplayTitle(row);
                  return (
                    <button
                      type="button"
                      key={row.id}
                      className={styles.calendarCard}
                      aria-label={t("calendarView:card.openAriaLabelWithDate", {
                        title,
                        date: fullDateLabel(day),
                      })}
                      draggable={!readOnly}
                      data-dragging={draggingRowId === row.id ? "true" : undefined}
                      onPointerDown={(e) => {
                        dragStartRef.current = { x: e.clientX, y: e.clientY };
                        dragMovedRef.current = false;
                      }}
                      onPointerMove={(e) => {
                        const start = dragStartRef.current;
                        if (!start || dragMovedRef.current) return;
                        if (
                          Math.abs(e.clientX - start.x) > DRAG_THRESHOLD ||
                          Math.abs(e.clientY - start.y) > DRAG_THRESHOLD
                        ) {
                          dragMovedRef.current = true;
                        }
                      }}
                      onDragStart={(e) => {
                        if (readOnly) {
                          e.preventDefault();
                          return;
                        }
                        // Require real movement past the threshold before treating the
                        // gesture as a reschedule, so a shaky click can't silently move
                        // the event to another day.
                        if (!dragMovedRef.current) {
                          e.preventDefault();
                          return;
                        }
                        setDraggingRowId(row.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData(CALENDAR_CARD_DRAG, row.id);
                      }}
                      onDragEnd={() => {
                        dragStartRef.current = null;
                        dragMovedRef.current = false;
                        setDraggingRowId(null);
                        setDragOverDay(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                          e.preventDefault();
                          e.stopPropagation();
                          openKeyboardRowMenu(row.id, e.currentTarget);
                          return;
                        }
                        // Arrow keys reschedule a focused card by a day; Enter opens.
                        const delta =
                          e.key === "ArrowRight" || e.key === "ArrowDown"
                            ? 1
                            : e.key === "ArrowLeft" || e.key === "ArrowUp"
                              ? -1
                              : 0;
                        if (delta === 0) return;
                        // Arrow-key reschedule is a mutation — gate it like drag
                        // (onDragStart) and moveRowToDay, which read-only calendars
                        // and locked rows already block.
                        if (readOnly || row.isLocked) return;
                        if (!dateProp) return;
                        const next = shiftDateValueByDays(valueFor(row, dateProp), delta);
                        if (!next) return;
                        e.preventDefault();
                        setRowProperty(row.id, dateProp.id, next, { debounce: false });
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
                      <span className={styles.calendarCardTitle}>
                        {title}
                      </span>
                      <span className={styles.calendarCardMeta}>
                        {metaProps.slice(0, 2).map((prop) => (
                          <PropValue key={prop.id} row={row} prop={prop} interactive={false} />
                        ))}
                      </span>
                    </button>
                  );
                })}
                {dayRows.length > CALENDAR_MAX_CARDS && (
                  <button
                    type="button"
                    className={styles.calendarMore}
                    onClick={() =>
                      setExpandedDays((cur) => {
                        const next = new Set(cur);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                  >
                    {expandedDays.has(key)
                      ? t("calendarView:cell.showLess")
                      : t("calendarView:cell.showMore", {
                          count: dayRows.length - CALENDAR_MAX_CARDS,
                        })}
                  </button>
                )}
              </div>
            </div>
          );
          })}
          </div>
        ))}
      </div>
      {noDateRows.length > 0 && (
        <div className={styles.calendarNoDate}>
          <div className={styles.calendarNoDateHead}>
            {t("calendarView:noDate.heading", { count: noDateRows.length })}
          </div>
          <div className={styles.calendarNoDateList}>
            {noDateRows.map((row) => {
              const title = pageDisplayTitle(row);
              return (
                <button
                  type="button"
                  key={row.id}
                  className={styles.calendarNoDateItem}
                  aria-label={t("calendarView:card.openNoDateAriaLabel", { title })}
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
        </div>
      )}
      {rowContextMenu}
    </div>
  );
}
