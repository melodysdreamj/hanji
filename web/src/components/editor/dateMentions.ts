import { activeDateLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";

const DAY_MS = 86_400_000;

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
  if (diff === 0) return i18next.t("dateMentions:today");
  if (diff === 1) return i18next.t("dateMentions:tomorrow");
  if (diff === -1) return i18next.t("dateMentions:yesterday");
  return date.toLocaleDateString(activeDateLocale(), {
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
