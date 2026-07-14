import type { DbView } from "@/lib/types";

/** Notion-import compatibility rules kept outside the interactive database renderer. */
const IMPORTED_VIEW_CONFIG_KEYS = [
  "notionViewId",
  "notionType",
  "notionChromeCreatedTime",
  "unsupportedNotionViewType",
  "notion",
  "notionFilter",
  "notionSorts",
  "notionVisibleProperties",
  "notionHiddenProperties",
  "notionPropertyOrder",
  "notionPropertySettings",
  "notionQuickFilters",
  "unresolvedPropertyReferences",
  "viewTabOrderEditedAt",
];

export function isImportedUntitledView(view: DbView) {
  const name = (view.name || "").trim().toLowerCase();
  return (name === "" || name === "untitled") && typeof view.config?.notionViewId === "string";
}

export function isImportedNotionView(view: DbView) {
  return typeof view.config?.notionViewId === "string" && !!view.config?.notion;
}

export function isTemplateLinkedView(view: DbView) {
  return view.config?.templateLinkedView === true;
}

export function inlineDatabaseScopedViewOwner(view: DbView) {
  const owner = view.config?.inlineDatabaseBlockId;
  return typeof owner === "string" && owner.trim().length > 0 ? owner : undefined;
}

export function isInlineDatabaseScopedView(view: DbView) {
  return !!inlineDatabaseScopedViewOwner(view);
}

export function cloneInlineScopedViewConfig(
  config: DbView["config"],
  ownerId: string,
  sourceViewId?: string
) {
  const next = (config ? JSON.parse(JSON.stringify(config)) : {}) as Record<string, unknown>;
  for (const key of IMPORTED_VIEW_CONFIG_KEYS) delete next[key];
  next.inlineDatabaseBlockId = ownerId;
  if (sourceViewId) next.inlineDatabaseSourceViewId = sourceViewId;
  else delete next.inlineDatabaseSourceViewId;
  return next as DbView["config"];
}

export function appendScopedViewId(ids: string[], viewId: string, afterId?: string) {
  const next = ids.filter((id) => id !== viewId);
  const index = afterId ? next.indexOf(afterId) : -1;
  next.splice(index >= 0 ? index + 1 : next.length, 0, viewId);
  return next;
}

export function normalizedNotionScopeId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/^collection:\/\//i, "")
    .replace(/^data_source:\/\//i, "")
    .replace(/-/g, "")
    .trim()
    .toLowerCase();
  return clean || undefined;
}

export function notionParentDatabaseId(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const record = notion as Record<string, unknown>;
  const parent = record.parent;
  if (parent && typeof parent === "object") {
    const parentRecord = parent as Record<string, unknown>;
    const id =
      parentRecord.database_id ??
      parentRecord.databaseId ??
      parentRecord.id;
    if (typeof id === "string") return id;
  }
  const fallback =
    record.parent_database_id ??
    record.parentDatabaseId ??
    record.database_id ??
    record.databaseId;
  return typeof fallback === "string" ? fallback : undefined;
}

export function notionViewCreatedAtMs(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const createdTime = (notion as Record<string, unknown>).created_time;
  if (typeof createdTime !== "string") return undefined;
  const ms = Date.parse(createdTime);
  return Number.isFinite(ms) ? ms : undefined;
}

export function notionViewChromeCreatedAtMs(view: DbView) {
  const createdTime = view.config?.notionChromeCreatedTime;
  if (typeof createdTime === "string") {
    const ms = Date.parse(createdTime);
    if (Number.isFinite(ms)) return ms;
  }
  return notionViewCreatedAtMs(view);
}

export function notionViewCreatedTime(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const createdTime = (notion as Record<string, unknown>).created_time;
  return typeof createdTime === "string" ? createdTime : undefined;
}

export function notionViewDataSourceId(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const dataSourceId = (notion as Record<string, unknown>).data_source_id;
  return typeof dataSourceId === "string" ? normalizedNotionScopeId(dataSourceId) : undefined;
}

export function importedVisiblePropertySignature(view: DbView) {
  const visibleProperties = view.config?.visibleProperties;
  if (!Array.isArray(visibleProperties)) return "";
  return visibleProperties.map(String).join("|");
}

export function hasUserEditedViewTabOrder(view: DbView) {
  return typeof view.config?.viewTabOrderEditedAt === "string";
}

export function restoreImportedPeerViewsForLinkedTarget(allViews: DbView[], scopedViews: DbView[]) {
  if (scopedViews.length === 0) return scopedViews;
  const restored = scopedViews.map((view) => {
    if (!isImportedNotionView(view)) return view;
    if (view.name.trim().toLowerCase() !== "default view") return view;
    const dataSourceId = notionViewDataSourceId(view);
    const propertySignature = importedVisiblePropertySignature(view);
    if (!dataSourceId || !propertySignature) return view;

    const peers = allViews
      .filter((candidate) =>
        candidate.type === view.type &&
        isImportedNotionView(candidate) &&
        candidate.name.trim().toLowerCase() === view.name.trim().toLowerCase() &&
        notionViewDataSourceId(candidate) === dataSourceId &&
        importedVisiblePropertySignature(candidate) === propertySignature &&
        notionViewCreatedAtMs(candidate) != null
      )
      .sort((a, b) =>
        (notionViewCreatedAtMs(a) ?? 0) - (notionViewCreatedAtMs(b) ?? 0) ||
        a.position - b.position ||
        a.id.localeCompare(b.id)
      );
    const peer = peers[0];
    const peerCreatedTime = peer ? notionViewCreatedTime(peer) : undefined;
    const peerCreatedAt = peer ? notionViewCreatedAtMs(peer) : undefined;
    const viewCreatedAt = notionViewCreatedAtMs(view);
    if (!peerCreatedTime || peerCreatedAt == null || (viewCreatedAt != null && peerCreatedAt >= viewCreatedAt)) {
      return view;
    }

    return {
      ...view,
      config: {
        ...view.config,
        notionChromeCreatedTime: peerCreatedTime,
      },
    };
  });

  const seen = new Set<string>();
  return restored.filter((view) => {
    if (seen.has(view.id)) return false;
    seen.add(view.id);
    return true;
  });
}

export function filterViewsByNotionLinkedDatabaseTargets(views: DbView[], targetIds?: string[]) {
  const allowed = new Set((targetIds ?? []).map(normalizedNotionScopeId).filter(Boolean));
  if (allowed.size === 0) return views;
  const scoped = views.filter((view) => {
    const parentId = normalizedNotionScopeId(notionParentDatabaseId(view));
    return !!parentId && allowed.has(parentId);
  });
  return scoped.length > 0 ? restoreImportedPeerViewsForLinkedTarget(views, scoped) : views;
}

export function orderImportedInlineViewsForNotionChrome(views: DbView[]) {
  if (views.some(hasUserEditedViewTabOrder)) return views;
  const defaultTableView = views.find(
    (view) => view.name.trim().toLowerCase() === "default view" && view.type === "table"
  );
  const shouldOrderSmallTableBoardSet =
    views.length === 3 &&
    !!defaultTableView &&
    importedVisiblePropertySignature(defaultTableView) !== "" &&
    views.filter((view) => view.type === "table").length >= 2 &&
    views.some((view) => view.type === "board");
  if (views.length < 4 && !shouldOrderSmallTableBoardSet) return views;
  if (!views.every(isImportedNotionView)) return views;
  if (!views.some((view) => view.name.trim().toLowerCase() === "default view")) return views;
  const created = views.map((view) => ({ view, createdAt: notionViewChromeCreatedAtMs(view) }));
  if (created.some((item) => item.createdAt == null)) return views;

  const byCreatedAt = created
    .slice()
    .sort((a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      a.view.position - b.view.position ||
      a.view.name.localeCompare(b.view.name)
    )
    .map((item) => item.view);

  return byCreatedAt[0]?.id === views[0]?.id ? views : byCreatedAt;
}
