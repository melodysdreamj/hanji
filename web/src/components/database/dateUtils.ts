import { activeDateLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";
import type { DbProperty } from "@/lib/types";

function isDatePayload(value: unknown): value is { start?: unknown; end?: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    ("start" in value || "end" in value)
  );
}

function dateStart(value: unknown): unknown {
  if (isDatePayload(value)) return value.start ?? "";
  return value;
}

export function dateKey(value: unknown) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const source = dateStart(value);
  if (source == null || source === "") return "";
  const s = String(source).trim();
  // An absolute instant (explicit Z / numeric offset) denotes a point in time
  // whose calendar day depends on the viewer's zone — fall through to local-time
  // resolution below so day grouping/calendar placement match the local time the
  // cell displays and the shared filter/sort engine (query-core, given the browser
  // zone). A zone-less "YYYY-MM-DD[THH:MM]" is a wall-clock value taken verbatim.
  const isZonedInstant = /T.*(Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (!isZonedInstant && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function makeDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function parseDate(value: unknown): Date | null {
  const raw = dateKey(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  return makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function parseDateDraft(
  value: string,
  fallbackYear = new Date().getFullYear()
): Date | null {
  const raw = value.trim();
  if (!raw) return null;

  // Korean display formats round-trip through the date-cell draft inputs:
  // "2026. 7. 9." (ko-KR toLocaleDateString) and "2026년 7월 9일". Parse them
  // explicitly — Date.parse support for these is engine-dependent.
  const koreanDraft = /^(\d{4})(?:\.|년)\s*(\d{1,2})(?:\.|월)\s*(\d{1,2})(?:\.|일)?\s*$/.exec(raw);
  if (koreanDraft) {
    return makeDate(Number(koreanDraft[1]), Number(koreanDraft[2]), Number(koreanDraft[3]));
  }

  // Numeric drafts must win before parseDate(): its new Date() fallback would
  // consume "7/4" with V8's default year (2001) and "1/2/99" as 1999,
  // bypassing fallbackYear and the two-digit-year expansion below.
  const numeric = /^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/.exec(raw);
  if (numeric) {
    let year = numeric[3] ? Number(numeric[3]) : fallbackYear;
    if (year < 100) year += 2000;
    return makeDate(year, Number(numeric[1]), Number(numeric[2]));
  }

  const iso = parseDate(raw);
  if (iso) return iso;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return makeDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

export function formatDateInput(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleDateString(activeDateLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

export function addMonths(date: Date, months: number) {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

export function monthCells(anchor: Date) {
  const first = startOfMonth(anchor);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function monthLabel(date: Date) {
  return date.toLocaleDateString(activeDateLocale(), { month: "long", year: "numeric" });
}

export function extractTime(value: unknown): string {
  const source = dateStart(value);
  const m = /[T ](\d{2}:\d{2})/.exec(String(source ?? ""));
  return m ? m[1] : "";
}

export function formatTime12(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const period = h < 12 ? i18next.t("dateUtils:period.am") : i18next.t("dateUtils:period.pm");
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

export function parseTimeDraft(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const m = /^(\d{1,2})(?::(\d{1,2}))?\s*(a|am|p|pm)?$/.exec(raw);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const period = m[3]?.[0];
  if (minute > 59) return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (period === "p" && hour < 12) hour += 12;
    if (period === "a" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function extractEnd(value: unknown): string {
  if (isDatePayload(value)) return value.end ? String(value.end) : "";
  const s = String(value ?? "");
  const slash = s.indexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : "";
}

/**
 * Set a date value's day to `targetDay` while preserving its time-of-day. Used
 * by calendar/timeline drag so moving an event to another day doesn't discard
 * the time (dragging with a bare `dateKey(day)` silently lost `T14:00`).
 */
export function withTimeOf(value: unknown, targetDay: Date): string {
  const time = extractTime(value);
  const key = dateKey(targetDay);
  return time ? `${key}T${time}` : key;
}

/**
 * Move a (possibly range) date value so its start lands on `targetDay`,
 * preserving the start time AND shifting the end by the same day delta so the
 * event's duration and both times survive the drag.
 */
export function shiftDateValueToDay(value: unknown, targetDay: Date): string {
  const start = withTimeOf(dateStart(value), targetDay);
  const endRaw = extractEnd(value);
  if (!endRaw) return start;
  const oldStart = parseDate(dateStart(value));
  const oldEnd = parseDate(endRaw);
  const targetDate = parseDate(targetDay) ?? targetDay;
  const deltaDays =
    oldStart && oldEnd ? Math.round((targetDate.getTime() - oldStart.getTime()) / 86_400_000) : 0;
  const shiftedEndDay = oldEnd ? addDays(oldEnd, deltaDays) : targetDate;
  return `${start}/${withTimeOf(endRaw, shiftedEndDay)}`;
}

type DateDisplayOptions = {
  locale?: string;
  year?: "auto" | "always";
};

function formatDatePart(part: unknown, options: DateDisplayOptions = {}) {
  const date = parseDate(part);
  if (!date) return "";
  // Display-only: the locale controls presentation (month names, ordering),
  // never the stored value. Defaults to the active app locale.
  const locale = options.locale ?? activeDateLocale();
  const intlOptions: Intl.DateTimeFormatOptions = locale.toLowerCase().startsWith("ko")
    ? { year: "numeric", month: "long", day: "numeric" }
    : { month: "short", day: "numeric" };
  if (options.year === "always") intlOptions.year = "numeric";
  if (!intlOptions.year && date.getFullYear() !== new Date().getFullYear()) {
    intlOptions.year = "numeric";
  }
  let out = date.toLocaleDateString(locale, intlOptions);
  const time = extractTime(part);
  if (time) out += ` ${formatTime12(time)}`;
  return out;
}

export function formatDate(value: unknown, options: DateDisplayOptions = {}) {
  const startValue = dateStart(value);
  const start = formatDatePart(startValue, options);
  if (!start) return "";
  const endPart = extractEnd(value);
  if (endPart) {
    const end = formatDatePart(endPart, options);
    if (end) {
      const startKey = dateKey(startValue);
      const endKey = dateKey(endPart);
      const endTime = extractTime(endPart);
      if (startKey && startKey === endKey && endTime) {
        return `${start} → ${formatTime12(endTime)}`;
      }
      return `${start} → ${end}`;
    }
  }
  return start;
}

export function formatDateForProperty(value: unknown, prop: Pick<DbProperty, "config">) {
  const notionType = prop.config?.notionType ?? prop.config?.notion?.type;
  if (notionType === "date") {
    // Notion-imported date properties always show the year; the locale itself
    // follows the active app locale (it was previously hardcoded to ko-KR,
    // which forced Korean dates on English UIs).
    return formatDate(value, { year: "always" });
  }
  return formatDate(value);
}

export function formatNotionTimestamp(value: unknown) {
  const source = dateStart(value);
  if (source == null || source === "") return "";
  const date = new Date(String(source));
  if (Number.isNaN(date.getTime())) return String(source);

  const hour = date.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period =
    hour < 12 ? i18next.t("dateUtils:period.am") : i18next.t("dateUtils:period.pm");
  return i18next.t("dateUtils:notionTimestamp", {
    date: date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour12,
    minutes,
    period,
  });
}
