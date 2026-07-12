// Shared relative-time labels for menus, search results, and backlinks.
// PageBacklinks, SearchDialog, and RowMenu previously carried three diverging
// English-only copies of this formatting; this is the single localized home.
// Date/time parts format with activeDateLocale() per the i18n.ts convention —
// display only, never the underlying value.
import { activeDateLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";

// Labels resolve at CALL time (never at module load) so i18next has
// initialized before `i18next.t` runs — a module-scope resolution would bake in
// raw keys. The returned object preserves its prior shape (string labels and
// interpolating functions) so existing call sites are unchanged.
export function relativeTimeLabels() {
  return {
    justNow: i18next.t("relativeTime:justNow"),
    editedJustNow: i18next.t("relativeTime:editedJustNow"),
    editedMinutesAgo: (minutes: number) =>
      i18next.t("relativeTime:editedMinutesAgo", { minutes }),
    editedHoursAgo: (hours: number) =>
      i18next.t("relativeTime:editedHoursAgo", { hours }),
    editedDaysAgo: (days: number) =>
      i18next.t("relativeTime:editedDaysAgo", { days }),
    editedOn: (date: string) => i18next.t("relativeTime:editedOn", { date }),
    noEdits: i18next.t("relativeTime:noEdits"),
    noEditsYet: i18next.t("relativeTime:noEditsYet"),
    todayAt: (time: string) => i18next.t("relativeTime:todayAt", { time }),
    yesterdayAt: (time: string) =>
      i18next.t("relativeTime:yesterdayAt", { time }),
    dateAt: (date: string, time: string) =>
      i18next.t("relativeTime:dateAt", { date, time }),
  };
}

function isSameLocalDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Edited 5m ago" / "5분 전 편집됨"-style label for a page or block edit stamp.
 * Missing/unparseable values yield "" so callers can chain their own fallback
 * (`|| labels.noEditsYet`). `year: true` matches the RowMenu convention of
 * always including the year in the far-past fallback.
 */
export function relativeEditedLabel(
  value: string | undefined | null,
  opts: { year?: boolean } = {}
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const labels = relativeTimeLabels();
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return labels.editedJustNow;
  if (diff < hour) return labels.editedMinutesAgo(Math.floor(diff / minute));
  if (diff < day) return labels.editedHoursAgo(Math.floor(diff / hour));
  if (diff < 7 * day) return labels.editedDaysAgo(Math.floor(diff / day));
  return labels.editedOn(
    date.toLocaleDateString(activeDateLocale(), {
      month: "short",
      day: "numeric",
      ...(opts.year ? { year: "numeric" } : {}),
    })
  );
}

/**
 * "Today at 3:24 PM" / "오늘 오후 3:24"-style absolute-ish menu timestamp.
 * Missing/unparseable values read as "Just now" (RowMenu convention).
 */
export function menuTimestampLabel(value?: string | null): string {
  const labels = relativeTimeLabels();
  if (!value) return labels.justNow;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return labels.justNow;

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const locale = activeDateLocale();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  if (isSameLocalDay(date, now)) return labels.todayAt(time);
  if (isSameLocalDay(date, yesterday)) return labels.yesterdayAt(time);

  const datePart = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
  return labels.dateAt(datePart, time);
}
