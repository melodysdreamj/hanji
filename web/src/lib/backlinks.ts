import {
  blockReferenceKind as sharedBlockReferenceKind,
  pageReferenceTargets,
} from "../../../shared/page-references.mjs";
import {
  getPageBacklinksRemote,
  type BlocksResult,
  type PageBacklinksRemoteOptions,
} from "./edgebase";
import { normalizeLegacyHanjiUri } from "./legacyNamespace";
import { pagePath } from "./pagePath";
import { pageDisplayTitle } from "./pageTitle";
import type { Block, Page, TextSpan } from "./types";

export interface PageReferenceHit {
  block: Block;
  page: Page;
  targetPage: Page;
  kind: "mention" | "link";
  preview: string;
  path: string;
}

const pageBacklinksInflight = new Map<string, Promise<BlocksResult>>();

export async function listPageBacklinks(
  targetPageId: string,
  limit: number,
  workspaceId: string,
  options: PageBacklinksRemoteOptions = {}
): Promise<BlocksResult> {
  const key = JSON.stringify([workspaceId, targetPageId, limit, options.sourceCursor ?? null]);
  const existing = pageBacklinksInflight.get(key);
  if (existing) return existing;
  const request = options.sourceCursor
    ? getPageBacklinksRemote(targetPageId, limit, workspaceId, options)
    : getPageBacklinksRemote(targetPageId, limit, workspaceId);
  pageBacklinksInflight.set(key, request);
  try {
    return await request;
  } finally {
    if (pageBacklinksInflight.get(key) === request) pageBacklinksInflight.delete(key);
  }
}

export function pageTitle(page: Page) {
  return pageDisplayTitle(page);
}

export { pagePath };

function richText(spans: TextSpan[] | undefined) {
  return (spans ?? []).map((span) => span.text).join("").trim();
}

export function blockReferenceKind(block: Block, pageId: string): PageReferenceHit["kind"] | null {
  return sharedBlockReferenceKind(block, pageId, (href) =>
    typeof href === "string" ? normalizeLegacyHanjiUri(href) : href
  );
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
      return pageReferenceTargets(block, (href) =>
        typeof href === "string" ? normalizeLegacyHanjiUri(href) : href
      )
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
