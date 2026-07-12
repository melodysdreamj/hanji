import type { Page } from "@/lib/types";
import {
  appendMarkdownToPageRemote,
  getPageBlocksRemote,
  importCsvDatabaseRemote,
  importMarkdownPageRemote,
} from "@/lib/edgebase";
import { positionBetween } from "@/lib/ids";
import {
  activePersistentGeneratedLabels,
  type ProductLocale,
} from "@/lib/persistentGeneratedLabels";
import { useStore } from "@/lib/store";

export interface WorkspaceImportResult {
  page: Page;
  kind: "page" | "database";
  count: number;
}

export function importedFileTitle(file: Pick<File, "name">, untitled: string) {
  return file.name.replace(/\.[^.]+$/, "").trim() || untitled;
}

function isCsvFile(file: File) {
  return /\.csv$/i.test(file.name) || file.type === "text/csv" || file.type === "application/csv";
}

export async function importMarkdownIntoPage(page: Page, file: File) {
  if (page.isLocked) throw new Error("Page is locked.");
  const text = await file.text();

  const st = useStore.getState();
  await st.loadBlocks(page.id);
  useStore.getState().captureBlockHistory(page.id);
  const result = await appendMarkdownToPageRemote({ pageId: page.id, markdown: text });
  const refreshed = (await getPageBlocksRemote(page.id)).blocks.sort((a, b) => a.position - b.position);
  useStore.setState((state) => ({
    blocksByPage: { ...state.blocksByPage, [page.id]: refreshed },
    loadedBlockPages: new Set(state.loadedBlockPages).add(page.id),
  }));

  const importedTitle = importedFileTitle(file, activePersistentGeneratedLabels().untitled);
  if (!page.title.trim() && importedTitle) {
    useStore.getState().updatePage(page.id, { title: importedTitle });
  }

  return result.count;
}

export async function importWorkspaceFile(
  file: File,
  options: { locale: ProductLocale; untitled: string },
): Promise<WorkspaceImportResult> {
  const state = useStore.getState();
  const workspaceId = state.workspace?.id;
  if (!workspaceId) throw new Error("Workspace is not ready.");
  const position = positionBetween(state.childPages(null).at(-1)?.position, undefined);
  const title = importedFileTitle(file, options.untitled);
  const text = await file.text();
  const csv = isCsvFile(file);
  const result = csv
    ? await importCsvDatabaseRemote({
        workspaceId,
        parentId: null,
        parentType: "workspace",
        title,
        position,
        csv: text,
        locale: options.locale,
      })
    : await importMarkdownPageRemote({
        workspaceId,
        parentId: null,
        parentType: "workspace",
        title,
        position,
        markdown: text,
      });

  await useStore.getState().bootstrap({ workspaceId, pageId: result.page.id });
  const page = useStore.getState().pagesById[result.page.id] ?? result.page;
  return { page, kind: csv ? "database" : "page", count: result.count };
}
