const MILLISECONDS_PER_DAY = 86_400_000;

function calendarDayUtcTime(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Compare local calendar dates without treating a civil day as a fixed elapsed
 * duration. UTC-normalized date parts stay one ordinal apart across DST and
 * other IANA time-zone discontinuities.
 */
export function differenceInCalendarDays(date: Date, reference: Date) {
  return (calendarDayUtcTime(date) - calendarDayUtcTime(reference)) / MILLISECONDS_PER_DAY;
}
