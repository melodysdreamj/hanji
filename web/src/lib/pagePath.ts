import { isSyntheticNotionImportRootPage } from "./importedNotionUi";
import { pageDisplayTitle } from "./pageTitle";
import type { Page } from "./types";

export const WORKSPACE_ROOT_PATH_LABEL = "Workspace root";

export function pagePath(page: Page, pagesById: Record<string, Page>) {
  const labels: string[] = [];
  const seen = new Set<string>();
  let current = page.parentId ? pagesById[page.parentId] : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (!isSyntheticNotionImportRootPage(current)) {
      labels.unshift(pageDisplayTitle(current));
    }
    current = current.parentId ? pagesById[current.parentId] : undefined;
  }
  return labels.join(" / ");
}

export function pagePathOrWorkspaceRoot(page: Page, pagesById: Record<string, Page>) {
  return pagePath(page, pagesById) || WORKSPACE_ROOT_PATH_LABEL;
}
