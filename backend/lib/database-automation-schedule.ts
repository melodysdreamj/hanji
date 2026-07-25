const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DatabaseAutomationDailyScheduleTrigger {
  type: 'schedule';
  frequency: 'daily';
  interval: number;
  time: string;
  timeZone: string;
  startsOn: string;
  endsOn?: string;
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function dateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year
    || instant.getUTCMonth() + 1 !== month
    || instant.getUTCDate() !== day
  ) return null;
  return { year, month, day, ordinal: Math.floor(instant.getTime() / DAY_MS) };
}

function dateFromOrdinal(ordinal: number) {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-US-u-hc-h23', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function partsAt(format: Intl.DateTimeFormat, timestamp: number): LocalDateTimeParts & { second: number } {
  const parts = new Map(format.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    hour: Number(parts.get('hour')),
    minute: Number(parts.get('minute')),
    second: Number(parts.get('second')),
  };
}

function sameLocalMinute(left: LocalDateTimeParts, right: LocalDateTimeParts) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

function localMinuteToUtc(
  format: Intl.DateTimeFormat,
  local: LocalDateTimeParts,
) {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set<number>();
  for (const deltaHours of [-36, -12, 0, 12, 36]) {
    const reference = naive + deltaHours * 60 * 60 * 1_000;
    const displayed = partsAt(format, reference);
    offsets.add(Date.UTC(
      displayed.year,
      displayed.month - 1,
      displayed.day,
      displayed.hour,
      displayed.minute,
      displayed.second,
    ) - reference);
  }
  const candidates = Array.from(offsets, (offset) => naive - offset)
    .filter((candidate) => sameLocalMinute(partsAt(format, candidate), local))
    .sort((left, right) => left - right);
  return candidates[0] ?? null;
}

export function validScheduleDate(value: string) {
  return dateParts(value) !== null;
}

export function validScheduleTimeZone(value: string) {
  try {
    formatter(value).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function nextDatabaseAutomationScheduleRun(
  trigger: DatabaseAutomationDailyScheduleTrigger,
  after: string | number | Date,
) {
  const afterTimestamp = after instanceof Date
    ? after.getTime()
    : typeof after === 'number'
      ? after
      : Date.parse(after);
  const start = dateParts(trigger.startsOn);
  const end = trigger.endsOn ? dateParts(trigger.endsOn) : null;
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(trigger.time);
  if (
    !Number.isFinite(afterTimestamp)
    || !start
    || (trigger.endsOn && !end)
    || !timeMatch
    || !Number.isSafeInteger(trigger.interval)
    || trigger.interval < 1
  ) return null;

  const format = formatter(trigger.timeZone);
  const afterLocal = partsAt(format, afterTimestamp);
  const afterLocalDate = dateParts(
    `${String(afterLocal.year).padStart(4, '0')}-${String(afterLocal.month).padStart(2, '0')}-${String(afterLocal.day).padStart(2, '0')}`,
  )!;
  let ordinal = Math.max(start.ordinal, afterLocalDate.ordinal);
  const remainder = (ordinal - start.ordinal) % trigger.interval;
  if (remainder !== 0) ordinal += trigger.interval - remainder;

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (end && ordinal > end.ordinal) return null;
    const candidateDate = dateParts(dateFromOrdinal(ordinal))!;
    const candidate = localMinuteToUtc(format, {
      year: candidateDate.year,
      month: candidateDate.month,
      day: candidateDate.day,
      hour,
      minute,
    });
    if (candidate !== null && candidate > afterTimestamp) {
      return new Date(candidate).toISOString();
    }
    ordinal += trigger.interval;
  }
  return null;
}
