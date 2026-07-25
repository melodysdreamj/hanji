import type { AppState } from "./store";
import type { Page } from "./types";

interface ButtonPageResult {
  createdPages: Page[];
  updatedPages: Page[];
}

export interface ButtonPageMutation {
  databaseId: string;
  reason: `${"database-button" | "page-button"}-${
    "add-page" | "edit-pages" | "execute" | "page-results"
  }`;
  rowIds: string[];
}

export function prepareButtonPageResultAdoption(
  result: ButtonPageResult,
  adoptPage: (page: Page) => Page,
  options: { surface?: "database-button" | "page-button" } = {},
) {
  const surface = options.surface ?? "page-button";
  const createdPages = result.createdPages.map(adoptPage);
  const updatedPages = result.updatedPages.map(adoptPage);
  const changes = new Map<string, { createdIds: string[]; updatedIds: string[] }>();

  function collect(page: Page, kind: "createdIds" | "updatedIds") {
    if (page.parentType !== "database" || !page.parentId) return;
    const change = changes.get(page.parentId) ?? { createdIds: [], updatedIds: [] };
    if (!change[kind].includes(page.id)) change[kind].push(page.id);
    changes.set(page.parentId, change);
  }

  for (const page of createdPages) collect(page, "createdIds");
  for (const page of updatedPages) collect(page, "updatedIds");

  const mutations: ButtonPageMutation[] = Array.from(changes, ([databaseId, change]) => ({
    databaseId,
    reason: change.createdIds.length > 0 && change.updatedIds.length > 0
      ? `${surface}-page-results`
      : change.createdIds.length > 0
        ? `${surface}-add-page`
        : `${surface}-edit-pages`,
    rowIds: Array.from(new Set([...change.createdIds, ...change.updatedIds])),
  }));

  function apply(state: AppState) {
    const pagesById = { ...state.pagesById };
    for (const page of [...createdPages, ...updatedPages]) pagesById[page.id] = page;

    const databaseRowIdsByDb = { ...state.databaseRowIdsByDb };
    const databaseRowPagesByDb = { ...state.databaseRowPagesByDb };
    for (const mutation of mutations) {
      const createdIds = changes.get(mutation.databaseId)?.createdIds ?? [];
      if (createdIds.length === 0) continue;
      const currentIds = databaseRowIdsByDb[mutation.databaseId] ?? [];
      const insertedIds = createdIds.filter((id) => !currentIds.includes(id));
      databaseRowIdsByDb[mutation.databaseId] = [...currentIds, ...insertedIds];
      const currentPage = databaseRowPagesByDb[mutation.databaseId];
      if (currentPage && insertedIds.length > 0) {
        databaseRowPagesByDb[mutation.databaseId] = {
          ...currentPage,
          loadedCount: currentPage.loadedCount + insertedIds.length,
          totalCount: typeof currentPage.totalCount === "number"
            ? currentPage.totalCount + insertedIds.length
            : currentPage.totalCount,
        };
      }
    }
    return { databaseRowIdsByDb, databaseRowPagesByDb, pagesById };
  }

  return { apply, createdPages, mutations, updatedPages };
}
