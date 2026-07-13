import type { Page } from "./types";

export function isSyntheticNotionImportRootPage(page: Page) {
  const properties = page.properties ?? {};
  return (
    page.kind === "page" &&
    typeof properties.notionImportJobId === "string" &&
    typeof properties.notionPageId !== "string" &&
    typeof properties.notionDatabaseId !== "string" &&
    typeof properties.notionDataSourceId !== "string"
  );
}

export function isPromotableSyntheticNotionImportChild(page: Page) {
  if (page.kind === "database") return false;
  return page.title.trim().length > 0;
}

export function syntheticNotionImportRootLandingPage(
  root: Page,
  pagesById: Record<string, Page>
) {
  if (!isSyntheticNotionImportRootPage(root)) return undefined;
  return Object.values(pagesById)
    .filter(
      (page) =>
        !page.inTrash &&
        page.parentType === "page" &&
        page.parentId === root.id &&
        isPromotableSyntheticNotionImportChild(page)
    )
    .sort((a, b) => {
      if (!!a.isFavorite !== !!b.isFavorite) return a.isFavorite ? -1 : 1;
      return a.position - b.position || a.title.localeCompare(b.title);
    })[0];
}

export function isHanjiStarterWelcomePage(page: Page) {
  return (
    page.parentType === "workspace" &&
    page.kind === "page" &&
    page.title === "Hanji에 오신 것을 환영합니다!" &&
    page.icon === "👋" &&
    page.iconType === "emoji" &&
    !page.properties
  );
}
