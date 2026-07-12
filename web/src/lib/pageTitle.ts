import { i18next } from "@/i18n";
import type { Page } from "./types";

export function untitledPageDisplayTitle() {
  return i18next.t("common:labels.untitled", { defaultValue: "Untitled" });
}

export function pageDisplayTitle(page: Pick<Page, "title"> | undefined | null) {
  const title = page?.title.trim() ?? "";
  return title || untitledPageDisplayTitle();
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
