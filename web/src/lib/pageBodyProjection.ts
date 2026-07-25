import { pageDisplayTitle } from "./pageTitle";
import type { Block, Page } from "./types";

const STORED_CHILD_CONTAINER_TYPES = new Set<Block["type"]>([
  "child_page",
  "child_database",
  "inline_database",
]);

export type PageHierarchyProjectionBlock = Block & {
  readonly __pageHierarchyProjection: true;
};

export function isPageHierarchyProjectionBlock(
  block: Block,
): block is PageHierarchyProjectionBlock {
  return (block as Partial<PageHierarchyProjectionBlock>).__pageHierarchyProjection === true;
}

function directHierarchyChild(page: Page, parentPageId: string) {
  return !page.inTrash && page.parentType === "page" && page.parentId === parentPageId;
}

function projectedBlock(page: Page, parentPageId: string): PageHierarchyProjectionBlock {
  const title = pageDisplayTitle(page);
  return {
    id: `page-hierarchy:${page.id}`,
    pageId: parentPageId,
    parentId: null,
    type: page.kind === "database" ? "child_database" : "child_page",
    content: {
      childPageId: page.id,
      childPageTitle: title,
      childPageIcon: page.icon,
      childPageIconType: page.iconType,
      childPageKind: page.kind,
    },
    plainText: title,
    position: page.position,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    createdBy: page.createdBy,
    lastEditedBy: page.lastEditedBy,
    __pageHierarchyProjection: true,
  };
}

function stableBodyId(block: Block) {
  return isPageHierarchyProjectionBlock(block)
    ? block.content?.childPageId ?? block.id
    : block.id;
}

/**
 * Merge canonical page hierarchy into the page body without materializing
 * block rows. Stored page/database container blocks remain authoritative for
 * their target and suppress only the matching derived representation.
 */
export function mergePageBodyBlocks(
  rootBlocks: readonly Block[],
  childPages: readonly Page[],
  parentPageId: string,
  storedBlocks: readonly Block[] = rootBlocks,
): Block[] {
  const representedChildIds = new Set(
    storedBlocks
      .filter((block) => STORED_CHILD_CONTAINER_TYPES.has(block.type))
      .map((block) => block.content?.childPageId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const projected = childPages
    .filter((page) => directHierarchyChild(page, parentPageId))
    .filter((page) => !representedChildIds.has(page.id))
    .map((page) => projectedBlock(page, parentPageId));

  return [...rootBlocks, ...projected].sort(
    (left, right) =>
      left.position - right.position || stableBodyId(left).localeCompare(stableBodyId(right)),
  );
}
