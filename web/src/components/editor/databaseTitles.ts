import { i18next } from "@/i18n";

export const DEFAULT_DATABASE_TITLE = "";

// Locale-aware DISPLAY default for a new inline database, resolved at CALL time
// (never at module scope — i18next.t() before init returns the raw key).
export function inlineDatabasePlaceholderTitle(): string {
  return i18next.t("databaseTitles:inlineDatabasePlaceholder");
}

const DATABASE_SLASH_TITLE_ALIASES = new Set([
  "board",
  "/board",
  "calendar",
  "/calendar",
  "database",
  "/database",
  "db",
  "/db",
  "gallery",
  "/gallery",
  "inline database",
  "/inline database",
  "/inline-database",
  "/inline_database",
  "inline-database",
  "inline_database",
  "list",
  "/list",
  "table",
  "/table",
  "timeline",
  "/timeline",
]);

function normalizeDatabaseTitle(title: string | undefined) {
  return title
    ?.normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function isDatabaseSlashCommandTitle(title: string | undefined) {
  const normalized = normalizeDatabaseTitle(title);
  return !!normalized && DATABASE_SLASH_TITLE_ALIASES.has(normalized);
}

export function databaseTitleFromText(text: string | undefined, fallback = DEFAULT_DATABASE_TITLE) {
  const clean = text?.trim();
  if (!clean || isDatabaseSlashCommandTitle(clean)) return fallback;
  return clean;
}

export function meaningfulInlineDatabaseTitle(title: string | undefined) {
  const clean = title?.trim();
  return clean
    && !isDatabaseSlashCommandTitle(clean)
    ? clean
    : undefined;
}

/**
 * Resolve the inline-database title to render plus whether it is only the
 * placeholder. `ownTitle` MUST be the raw stored title, never a display
 * fallback like `pageDisplayTitle()` — an "Untitled" fallback would count as a
 * meaningful value and hide the placeholder the moment the title is cleared.
 */
export function inlineDatabaseTitleDisplay(input: {
  ownTitle?: string;
  importedSurfaceTitle?: string;
  resolvedLinkedTitle?: string;
  preferResolvedLinked?: boolean;
}): { text: string; isPlaceholder: boolean } {
  const imported = meaningfulInlineDatabaseTitle(input.importedSurfaceTitle);
  const own = meaningfulInlineDatabaseTitle(input.ownTitle);
  const resolvedLinked = meaningfulInlineDatabaseTitle(input.resolvedLinkedTitle);
  const text =
    (input.preferResolvedLinked ? resolvedLinked : undefined) ||
    imported ||
    own ||
    resolvedLinked ||
    inlineDatabasePlaceholderTitle();
  const isPlaceholder = !imported && !own && !resolvedLinked;
  return { text, isPlaceholder };
}
