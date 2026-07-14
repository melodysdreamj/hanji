import { activeDateLocale } from "@/lib/i18n";

/** Pure date and calendar model used by the editor mention popover. */
export function weekdayLabels() {
  const formatter = new Intl.DateTimeFormat(activeDateLocale(), { weekday: "narrow" });
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(2024, 0, 7 + index))
  );
}

export function localIsoDate(offsetDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return localIsoDateFromDate(date);
}

export function localDateForOffset(offsetDays = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date;
}

export function localIsoDateFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalIsoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

export function monthStartForDate(value: string) {
  const date = parseLocalIsoDate(value) ?? new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return localIsoDateFromDate(date);
}

export function shiftMonth(monthValue: string, offset: number) {
  const month = parseLocalIsoDate(monthValue) ?? new Date();
  const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
  return localIsoDateFromDate(next);
}

export function shiftDateByDays(value: string, offset: number) {
  const date = parseLocalIsoDate(value) ?? parseLocalIsoDate(localIsoDate(0)) ?? new Date();
  date.setDate(date.getDate() + offset);
  return localIsoDateFromDate(date);
}

export function shiftDateByMonths(value: string, offset: number) {
  const date = parseLocalIsoDate(value) ?? parseLocalIsoDate(localIsoDate(0)) ?? new Date();
  const day = date.getDate();
  const next = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, maxDay));
  return localIsoDateFromDate(next);
}

export function weekEdgeDate(value: string, edge: "start" | "end") {
  const date = parseLocalIsoDate(value) ?? parseLocalIsoDate(localIsoDate(0)) ?? new Date();
  const offset = edge === "start" ? -date.getDay() : 6 - date.getDay();
  date.setDate(date.getDate() + offset);
  return localIsoDateFromDate(date);
}

export function mentionCalendar(monthValue: string, selectedValue: string) {
  const month = parseLocalIsoDate(monthValue) ?? parseLocalIsoDate(monthStartForDate(selectedValue)) ?? new Date();
  const selected = parseLocalIsoDate(selectedValue);
  const today = localIsoDate(0);
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const firstVisible = new Date(monthStart);
  firstVisible.setDate(1 - monthStart.getDay());
  const label = monthStart.toLocaleDateString(activeDateLocale(), {
    month: "long",
    year: "numeric",
  });
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstVisible);
    date.setDate(firstVisible.getDate() + index);
    const iso = localIsoDateFromDate(date);
    return {
      iso,
      day: date.getDate(),
      outside: date.getMonth() !== monthStart.getMonth(),
      selected: !!selected && iso === selectedValue,
      today: iso === today,
    };
  });
  return { label, days };
}
