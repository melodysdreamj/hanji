export const DEFAULT_DATABASE_TITLE = "";
export const INLINE_DATABASE_PLACEHOLDER_TITLE = "새 데이터베이스";

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
  return clean &&
    clean !== "Untitled" &&
    clean !== "New database" &&
    clean !== DEFAULT_DATABASE_TITLE &&
    clean !== "Untitled database" &&
    clean !== INLINE_DATABASE_PLACEHOLDER_TITLE &&
    !isDatabaseSlashCommandTitle(clean)
    ? clean
    : undefined;
}
