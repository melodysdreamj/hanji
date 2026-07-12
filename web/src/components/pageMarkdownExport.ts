import { pageDisplayTitle } from "@/lib/pageTitle";
import { activePersistentGeneratedLabels } from "@/lib/persistentGeneratedLabels";
import type { Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import { getDatabaseRowsRemote } from "@/lib/edgebase";
import { displayPropertyValue } from "./database/rollup";
import { blockTreeMarkdown } from "./editor/blockMarkdown";

function markdownCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

function markdownRow(cells: string[]) {
  return `| ${cells.map(markdownCell).join(" | ")} |`;
}

function pageFileName(page: Page) {
  const untitled = activePersistentGeneratedLabels().untitled;
  const title = pageDisplayTitle(page)
    .replace(/[\\/:*?"<>|#\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${title || untitled}.md`;
}

function downloadMarkdown(page: Page, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = pageFileName(page);
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportPageAsMarkdown(page: Page) {
  const st = useStore.getState();
  if (page.kind === "database") {
    await st.loadDatabase(page.id);
  }
  await st.loadBlocks(page.id);

  const latest = useStore.getState();
  const blocks = latest.blocksByPage[page.id] ?? [];
  const roots = blocks
    .filter((block) => (block.parentId ?? null) === null)
    .sort((a, b) => a.position - b.position);
  const body = roots.map((block) => blockTreeMarkdown(block, blocks)).filter(Boolean);
  const lines = [`# ${pageDisplayTitle(page)}`];

  if (page.kind === "database") {
    const props = latest.dbProperties(page.id);
    const rowsResult = await getDatabaseRowsRemote(page.id, { includeComputed: true });
    const rows = rowsResult.rows ?? [];
    const pagesById = {
      ...latest.pagesById,
      ...Object.fromEntries(rows.map((row) => [row.id, row])),
    };
    if (props.length > 0) {
      lines.push(
        "",
        markdownRow(props.map((prop) => prop.name || activePersistentGeneratedLabels().untitled)),
        markdownRow(props.map(() => "---")),
        ...rows.map((row) =>
          markdownRow(props.map((prop) => displayPropertyValue(row, prop, pagesById)))
        )
      );
    }
  }

  if (body.length > 0) {
    lines.push("", body.join("\n\n"));
  }

  downloadMarkdown(page, `${lines.join("\n")}\n`);
}
