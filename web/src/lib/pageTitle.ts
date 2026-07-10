import type { Page } from "./types";

export function pageDisplayTitle(page: Pick<Page, "title"> | undefined | null) {
  return page?.title.trim() || "Untitled";
}

export function linkedDatabaseResolvedTitle(
  page: Pick<Page, "properties"> | undefined | null
) {
  const value = page?.properties?.notionLinkedDatabaseResolvedTitle;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function databaseDisplayTitle(
  page: Pick<Page, "title" | "properties"> | undefined | null
) {
  return linkedDatabaseResolvedTitle(page) ?? pageDisplayTitle(page);
}
