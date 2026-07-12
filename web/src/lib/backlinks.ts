import { getAllBlocksRemote } from "./edgebase";
import { pagePath } from "./pagePath";
import { pageDisplayTitle } from "./pageTitle";
import { pageIdFromPageHref } from "./pageLinks";
import type { Block, Page, TextSpan } from "./types";

export interface PageReferenceHit {
  block: Block;
  page: Page;
  targetPage: Page;
  kind: "mention" | "link";
  preview: string;
  path: string;
}

export async function listAllBlocks(): Promise<Block[]> {
  return (await getAllBlocksRemote()).blocks;
}

export function pageTitle(page: Page) {
  return pageDisplayTitle(page);
}

export { pagePath };

function richText(spans: TextSpan[] | undefined) {
  return (spans ?? []).map((span) => span.text).join("").trim();
}

function mentionedPageIds(spans: TextSpan[] | undefined) {
  return (spans ?? [])
    .filter((span) => span.mention === "page" && span.pageId)
    .map((span) => span.pageId as string);
}

function linkedPageIds(spans: TextSpan[] | undefined) {
  return (spans ?? []).flatMap((span) => {
    const pageId = pageIdFromPageHref(span.link);
    return pageId ? [pageId] : [];
  });
}

function blockReferenceTargets(block: Block) {
  const targets: Array<{ pageId: string; kind: PageReferenceHit["kind"] }> = [
    ...mentionedPageIds(block.content?.rich).map((pageId) => ({ pageId, kind: "mention" as const })),
    ...mentionedPageIds(block.content?.caption).map((pageId) => ({ pageId, kind: "mention" as const })),
    ...linkedPageIds(block.content?.rich).map((pageId) => ({ pageId, kind: "link" as const })),
    ...linkedPageIds(block.content?.caption).map((pageId) => ({ pageId, kind: "link" as const })),
  ];
  if (block.type === "link_to_page" && block.content?.childPageId) {
    targets.push({ pageId: block.content.childPageId, kind: "link" });
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.pageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function blockReferenceKind(block: Block, pageId: string): PageReferenceHit["kind"] | null {
  return blockReferenceTargets(block).find((target) => target.pageId === pageId)?.kind ?? null;
}

export function blockReferencePreview(block: Block, kind: PageReferenceHit["kind"]) {
  const text = richText(block.content?.rich) || richText(block.content?.caption) || block.plainText?.trim();
  if (text) return text;
  if (kind === "link") return block.type === "link_to_page" ? "Linked page block" : "Linked to this page";
  return "Mentioned this page";
}

export function mergedBlocks(
  fetchedBlocks: Block[],
  localBlocksByPage: Record<string, Block[]>,
  loadedPages: Set<string>
) {
  const out = fetchedBlocks.filter((block) => !loadedPages.has(block.pageId));
  for (const [pageId, blocks] of Object.entries(localBlocksByPage)) {
    if (loadedPages.has(pageId)) out.push(...blocks);
  }
  return out;
}

export function pageReferenceHits(
  blocks: Block[],
  pagesById: Record<string, Page>,
  opts: { targetPageId?: string; includeSelfReferences?: boolean } = {}
): PageReferenceHit[] {
  return blocks
    .flatMap((block) => {
      const page = pagesById[block.pageId];
      if (!page || page.inTrash) return [];
      return blockReferenceTargets(block)
        .filter((target) => !opts.targetPageId || target.pageId === opts.targetPageId)
        .map((target) => {
          const targetPage = pagesById[target.pageId];
          if (!targetPage || targetPage.inTrash) return null;
          if (!opts.includeSelfReferences && targetPage.id === page.id) return null;
          return {
            block,
            page,
            targetPage,
            kind: target.kind,
            preview: blockReferencePreview(block, target.kind),
            path: pagePath(page, pagesById),
          };
        });
    })
    .filter((hit): hit is PageReferenceHit => !!hit)
    .sort((a, b) => {
      const updated = (b.page.updatedAt ?? "").localeCompare(a.page.updatedAt ?? "");
      return updated || pageTitle(a.page).localeCompare(pageTitle(b.page)) || a.block.position - b.block.position;
    });
}
