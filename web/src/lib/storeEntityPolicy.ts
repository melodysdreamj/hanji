import type { Block, Page, Workspace } from "./types";

export function nowIso() {
  return new Date().toISOString();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function persistableDatabaseRowProperties(
  properties?: Record<string, unknown> | null
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties ?? {}).filter(([key]) => !key.startsWith("__"))
  );
}

export function persistableRowProperties(row: {
  properties?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return persistableDatabaseRowProperties(row.properties);
}

export function persistablePagePatch(patch: Partial<Page>, page?: Page): Partial<Page> {
  const next = { ...patch };
  delete next.__computed;
  delete next.__databaseRowOrder;
  delete next.createdAt;
  delete next.updatedAt;
  if (page?.parentType === "database" && isPlainObject(next.properties)) {
    // Imported rows keep raw Notion snapshots under internal "__" keys; those
    // are not database schema properties and make row mutations fail.
    next.properties = persistableDatabaseRowProperties(next.properties);
  }
  return next;
}

export function persistableWorkspacePatch(patch: Partial<Workspace>): Partial<Workspace> {
  const next = { ...patch };
  delete next.id;
  delete next.createdAt;
  delete next.updatedAt;
  return next;
}

export function persistableBlockPatch(patch: Partial<Block>): Partial<Block> {
  const next = { ...patch };
  delete next.id;
  delete next.createdAt;
  delete next.updatedAt;
  return next;
}

export function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function stripComputedFromPages(pagesById: Record<string, Page>) {
  let changed = false;
  const next: Record<string, Page> = {};
  for (const [id, page] of Object.entries(pagesById)) {
    if (!page.__computed) {
      next[id] = page;
      continue;
    }
    const pageWithoutComputed = { ...page };
    delete pageWithoutComputed.__computed;
    next[id] = pageWithoutComputed;
    changed = true;
  }
  return changed ? next : pagesById;
}

const LOCKED_PAGE_PATCH_KEYS = new Set<keyof Page>([
  "isLocked",
  "isFavorite",
  "isPublic",
  "backlinksDisplay",
  "pageCommentsDisplay",
  "verifiedAt",
  "verifiedBy",
  "verificationExpiresAt",
  "parentId",
  "parentType",
  "position",
  "inTrash",
  "trashedAt",
  "updatedAt",
  "lastEditedBy",
]);

export function lockedPageAllowsPatch(patch: Partial<Page>) {
  return Object.keys(patch).every((key) =>
    LOCKED_PAGE_PATCH_KEYS.has(key as keyof Page)
  );
}

export function isDatabaseLocked(
  pagesById: Record<string, Page>,
  databaseId: string | null | undefined
) {
  return !!(databaseId && pagesById[databaseId]?.isLocked);
}

export function isPageParentLocked(
  pagesById: Record<string, Page>,
  parentId: string | null | undefined
) {
  return !!(parentId && pagesById[parentId]?.isLocked);
}

export function assertDatabaseUnlocked(pagesById: Record<string, Page>, databaseId: string) {
  if (isDatabaseLocked(pagesById, databaseId)) {
    throw new Error("Database is locked.");
  }
}

export function iconTypeForValue(icon?: string): Page["iconType"] {
  if (!icon) return "none";
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(icon.trim()) ? "image" : "emoji";
}

export function collectPageSubtree(pagesById: Record<string, Page>, rootId: string) {
  const out = new Set<string>();
  const collect = (pageId: string) => {
    if (out.has(pageId)) return;
    out.add(pageId);
    for (const page of Object.values(pagesById)) {
      if (page.parentId === pageId) collect(page.id);
    }
  };
  collect(rootId);
  return out;
}

export function hasTrashedAncestor(pagesById: Record<string, Page>, page: Page) {
  let current = page.parentId ? pagesById[page.parentId] : undefined;
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    if (current.inTrash) return true;
    current = current.parentId ? pagesById[current.parentId] : undefined;
  }
  return false;
}
