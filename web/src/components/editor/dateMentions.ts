import { pickLabels } from "@/lib/i18n";

const DAY_MS = 86_400_000;

// Display-only labels: date mentions store an absolute ISO date and render
// the visible label from the current local day (and locale) at render time.
const DATE_MENTION_LABELS = {
  en: {
    displayLocale: "en-US",
    today: "Today",
    tomorrow: "Tomorrow",
    yesterday: "Yesterday",
  },
  ko: {
    displayLocale: "ko-KR",
    today: "오늘",
    tomorrow: "내일",
    yesterday: "어제",
  },
} as const;

function startOfLocalDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function parseLocalIsoDate(value: string | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value?.trim() ?? "");
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
  return startOfLocalDay(date);
}

export function dateMentionLabel(value: string, now = new Date()) {
  const date = parseLocalIsoDate(value);
  if (!date) return value;
  const today = startOfLocalDay(now);
  const diff = Math.round((date.getTime() - today.getTime()) / DAY_MS);
  const labels = pickLabels(DATE_MENTION_LABELS);
  if (diff === 0) return labels.today;
  if (diff === 1) return labels.tomorrow;
  if (diff === -1) return labels.yesterday;
  return date.toLocaleDateString(labels.displayLocale, {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

export function dateMentionDisplayText(value: string, storedText = "", now = new Date()) {
  const prefix = storedText.trimStart().startsWith("@") ? "@" : "";
  return `${prefix}${dateMentionLabel(value, now)}`;
}

export function nextDateMentionRefreshDelay(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 1, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
}
