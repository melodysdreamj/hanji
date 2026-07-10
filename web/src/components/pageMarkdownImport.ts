import type { Page } from "@/lib/types";
import {
  appendMarkdownToPageRemote,
  getPageBlocksRemote,
  importCsvDatabaseRemote,
  importMarkdownPageRemote,
} from "@/lib/edgebase";
import { positionBetween } from "@/lib/ids";
import { useStore } from "@/lib/store";

export interface WorkspaceImportResult {
  page: Page;
  kind: "page" | "database";
  count: number;
}

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "").trim() || "Untitled";
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

  if (!page.title.trim() && fileTitle(file)) {
    useStore.getState().updatePage(page.id, { title: fileTitle(file) });
  }

  return result.count;
}

export async function importWorkspaceFile(file: File): Promise<WorkspaceImportResult> {
  const state = useStore.getState();
  const workspaceId = state.workspace?.id;
  if (!workspaceId) throw new Error("Workspace is not ready.");
  const position = positionBetween(state.childPages(null).at(-1)?.position, undefined);
  const title = fileTitle(file);
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
