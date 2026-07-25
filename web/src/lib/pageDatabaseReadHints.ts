import type { Block, DbProperty, Page } from "./types";

const PAGE_DATABASE_READ_HINT_MAX = 100;

/** Databases whose chrome can mount as part of the current page surface. */
export function pageDatabaseMetadataRoots(
  page: Page | undefined,
  blocks: Block[]
): string[] {
  const roots = new Set<string>();
  if (page?.kind === "database") roots.add(page.id);
  if (page?.parentType === "database" && page.parentId) roots.add(page.parentId);
  for (const block of blocks) {
    if (block.type !== "inline_database" && block.type !== "child_database") continue;
    const databaseId = block.content?.childPageId?.trim();
    if (databaseId) roots.add(databaseId);
  }
  return [...roots].sort();
}

/**
 * Expand cached relation metadata synchronously so every small schema read is
 * registered in the same 300ms page-read window. Rows stay on their separate,
 * selected-view query path.
 */
export function expandRelatedDatabaseMetadataIds(
  roots: Iterable<string>,
  propsByDb: Record<string, DbProperty[] | undefined>,
  maxItems = PAGE_DATABASE_READ_HINT_MAX
): string[] {
  const limit = Math.max(1, Math.floor(maxItems));
  const queue = [...new Set(roots)].filter(Boolean);
  const accepted: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length && accepted.length < limit; index += 1) {
    const databaseId = queue[index]!;
    if (seen.has(databaseId)) continue;
    seen.add(databaseId);
    accepted.push(databaseId);
    for (const property of propsByDb[databaseId] ?? []) {
      if (property.type !== "relation") continue;
      const targetId = property.config?.relationDatabaseId?.trim();
      if (targetId && !seen.has(targetId)) queue.push(targetId);
    }
  }
  return accepted;
}
