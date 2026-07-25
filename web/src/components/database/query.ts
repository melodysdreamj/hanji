import type { DbProperty, DbView, FilterGroup, Page, ViewFilter } from "@/lib/types";
import { normalizeFileAttachments } from "./files";
import { normalizePersonIds, personLabel } from "./people";
import { evaluateFormula, formatFormulaValue } from "./formula";
import { backendComputedText, backendComputedValue } from "./computed";
import { dateKey as normalizeDateKey } from "./dateUtils";
import { resolvedViewerTimeZone } from "@/lib/timeZone";
import {
  compareKeys as coreCompareKeys,
  currentPageFilterValue as coreCurrentPageFilterValue,
  effectiveFilterGroup as coreEffectiveFilterGroup,
  isCurrentPageFilterValue as coreIsCurrentPageFilterValue,
  matchesFilterGroup as coreMatchesFilterGroup,
  resolveFilterValue as coreResolveFilterValue,
  sortKey as coreSortKey,
  type QueryAdapters,
  type QueryFilterGroup,
  type QueryPage,
  type QueryProperty,
  type QueryViewConfig,
} from "../../../../shared/database/query-core";
import { foldNfcText } from "../../../../shared/database/natural-order.mjs";

const NO_FILTER_SEED = Symbol("no-filter-seed");
export const TABLE_INITIAL_LOAD_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_TABLE_INITIAL_LOAD_LIMIT = 50;
export const TIMELINE_LOAD_LIMIT_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_TIMELINE_LOAD_LIMIT = 50;

export interface ViewFilterSeedValues {
  title?: string;
  properties: Record<string, unknown>;
}

/** Context needed to resolve relation/formula/person values during a query. */
export interface QueryContext {
  props: DbProperty[];
  pagesById: Record<string, Page>;
  currentPageId?: string;
}

export interface ApplyViewOptions {
  search?: string;
  currentPageId?: string;
}

export type CardViewSubitemPresentationMode = "card_property" | "flattened" | "disabled";

export interface CardViewSubitemPresentation {
  rows: Page[];
  mode: CardViewSubitemPresentationMode;
  childCountByParent: ReadonlyMap<string, number>;
}

/**
 * Derive the complete card-view sub-item presentation in one bounded pass.
 * Card property consumes roots plus their server-owned direct-child count;
 * Flattened list retains the ordinary flat row window for parent labels.
 */
export function projectCardViewSubitems(
  database: Pick<Page, "databaseFeatures">,
  view: Pick<DbView, "config" | "type">,
  rows: Page[]
): CardViewSubitemPresentation {
  const isCardView =
    view.type === "board" || view.type === "calendar" || view.type === "gallery";
  if (!isCardView || database.databaseFeatures?.subitems?.enabled !== true) {
    return { rows, mode: "disabled", childCountByParent: new Map() };
  }

  const displayMode = view.config?.subtasks?.displayMode ?? "show";
  if (displayMode === "disabled") {
    return { rows, mode: "disabled", childCountByParent: new Map() };
  }

  const childCountByParent = new Map<string, number>();
  const exactChildCountByParent = new Map<string, number>();
  for (const row of rows) {
    if (row.subitemParentId) {
      childCountByParent.set(
        row.subitemParentId,
        (childCountByParent.get(row.subitemParentId) ?? 0) + 1
      );
    }
    if (
      typeof row.subitemChildCount === "number"
      && Number.isSafeInteger(row.subitemChildCount)
      && row.subitemChildCount >= 0
    ) {
      exactChildCountByParent.set(row.id, row.subitemChildCount);
    }
  }
  // The server scalar is exact even when the bounded window does not contain
  // every child; loaded-row counts are only a standalone/local fallback.
  for (const [parentId, count] of exactChildCountByParent) {
    childCountByParent.set(parentId, count);
  }

  if (displayMode === "flattened") {
    return { rows, mode: "flattened", childCountByParent };
  }

  // Board, Calendar and Gallery expose only the parents filter. Both the
  // normalized Card property mode and a legacy hidden value therefore consume
  // one root window; stale table-only filterScope values are intentionally ignored.
  return {
    rows: rows.filter((row) => !row.subitemParentId),
    mode: "card_property",
    childCountByParent,
  };
}

export function tableInitialLoadLimit(view?: Pick<DbView, "config">) {
  const raw = Number(view?.config?.initialLoadLimit);
  return TABLE_INITIAL_LOAD_OPTIONS.includes(raw as (typeof TABLE_INITIAL_LOAD_OPTIONS)[number])
    ? raw
    : DEFAULT_TABLE_INITIAL_LOAD_LIMIT;
}

/**
 * Select the exact hierarchy window a nested row-based view can render.
 * An empty string is the backend's explicit root scope; undefined preserves
 * the ordinary unscoped query for flat/sub-item-only presentations.
 */
export function databaseViewSubitemParentScope(
  database: Pick<Page, "databaseFeatures">,
  view?: Pick<DbView, "config" | "type">
): "" | undefined {
  if (database.databaseFeatures?.subitems?.enabled !== true) {
    return undefined;
  }
  const rowHierarchyView =
    view?.type === "table" || view?.type === "list" || view?.type === "timeline";
  const cardView =
    view?.type === "board" || view?.type === "calendar" || view?.type === "gallery";
  if (!rowHierarchyView && !cardView) return undefined;
  const displayMode = view.config?.subtasks?.displayMode ?? "show";
  if (displayMode === "disabled") return undefined;
  if (cardView) return displayMode === "flattened" ? undefined : "";
  const filterScope = view.config?.subtasks?.filterScope ?? "parents_and_subitems";
  if (displayMode === "hidden" || filterScope === "parents") return "";
  return displayMode === "show" && filterScope === "parents_and_subitems" ? "" : undefined;
}

export function timelineLoadLimit(view?: Pick<DbView, "config">) {
  const raw = Number(view?.config?.timelineLoadLimit);
  return TIMELINE_LOAD_LIMIT_OPTIONS.includes(raw as (typeof TIMELINE_LOAD_LIMIT_OPTIONS)[number])
    ? raw
    : DEFAULT_TIMELINE_LOAD_LIMIT;
}

export function currentPageFilterValue() {
  return coreCurrentPageFilterValue();
}

export function isCurrentPageFilterValue(value: unknown) {
  return coreIsCurrentPageFilterValue(value);
}

/** Raw value for a (row, property) pair. */
export function cellValue(row: Page, prop: DbProperty): unknown {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "created_by") return row.createdBy;
  if (prop.type === "last_edited_by") return row.lastEditedBy;
  if (prop.type === "formula" || prop.type === "rollup") {
    const computed = backendComputedValue(row, prop);
    if (computed !== undefined) return computed;
  }
  return row.properties?.[prop.id];
}

/** Property types that can be meaningfully filtered/sorted in the query layer. */
export function isQueryableProperty(_prop: DbProperty): boolean {
  return true;
}

export function orderViewProperties(props: DbProperty[], view: DbView): DbProperty[] {
  const order = view.config?.propertyOrder;
  if (!order) return withTitlePropertyFirst(props);
  const map = new Map(props.map((p) => [p.id, p]));
  const out: DbProperty[] = [];
  for (const id of order) {
    const prop = map.get(id);
    if (prop) {
      out.push(prop);
      map.delete(id);
    }
  }
  return [...out, ...map.values()];
}

export function visibleViewProperties(props: DbProperty[], view: DbView): DbProperty[] {
  const visible = view.config?.visibleProperties;
  const hidden = new Set(view.config?.hiddenProperties ?? []);
  if (visible && isImportedNotionViewConfig(view)) {
    const visibleIds = new Set(visible);
    const byId = new Map(props.map((prop) => [prop.id, prop]));
    const orderedVisible: DbProperty[] = [];
    for (const id of visible) {
      const prop = byId.get(id);
      if (prop) orderedVisible.push(prop);
    }
    const seen = new Set(orderedVisible.map((prop) => prop.id));
    for (const prop of orderViewProperties(props, view)) {
      if ((prop.type === "title" || visibleIds.has(prop.id)) && !seen.has(prop.id)) {
        orderedVisible.push(prop);
        seen.add(prop.id);
      }
    }
    return withTitlePropertyFirst(orderedVisible);
  }
  return orderViewProperties(props, view).filter((prop) => {
    if (prop.type === "title") return true;
    return visible ? visible.includes(prop.id) : !hidden.has(prop.id);
  });
}

function isImportedNotionViewConfig(view: DbView) {
  return (
    typeof view.config?.notionViewId === "string" ||
    Array.isArray(view.config?.notionPropertySettings)
  );
}

function withTitlePropertyFirst(props: DbProperty[]): DbProperty[] {
  const title = props.find((prop) => prop.type === "title");
  if (!title || props[0]?.id === title.id) return props;
  return [title, ...props.filter((prop) => prop.id !== title.id)];
}

function asText(v: unknown, prop?: DbProperty): string {
  if (v == null) return "";
  if (prop?.type === "files") {
    return normalizeFileAttachments(v)
      .map((file) => `${file.name} ${file.url}`)
      .join(" ");
  }
  if (prop?.type === "person" || prop?.type === "created_by" || prop?.type === "last_edited_by") {
    return normalizePersonIds(v)
      .map((id) => `${personLabel(id)} ${id}`)
      .join(" ");
  }
  if (Array.isArray(v)) return v.join(" ");
  return String(v);
}

function optionIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function rollupRelationTargetIds(row: Page, prop: DbProperty, ctx: QueryContext): string[] {
  const ids = new Set<string>();
  const relationPropId = prop.config?.rollupRelationPropertyId;
  const targetPropId = prop.config?.rollupTargetPropertyId;
  if (!relationPropId || !targetPropId) return [];

  for (const relatedId of optionIds(row.properties?.[relationPropId])) {
    const related = ctx.pagesById[relatedId];
    if (!related || related.inTrash) continue;
    for (const targetId of optionIds(related.properties?.[targetPropId])) {
      ids.add(targetId);
    }
  }
  return Array.from(ids);
}

function optionLabel(prop: DbProperty, id: string) {
  return prop.config?.options?.find((option) => option.id === id)?.name ?? id;
}

export function effectiveFilterGroup(config: DbView["config"], byId?: Map<string, DbProperty>): FilterGroup | undefined {
  return coreEffectiveFilterGroup(
    config as unknown as QueryViewConfig | undefined,
    byId as unknown as Map<string, QueryProperty> | undefined
  ) as unknown as FilterGroup | undefined;
}

function isDateLike(prop: DbProperty) {
  return prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time";
}

/** Normalize any date-ish value (ISO string, YYYY-MM-DD, timestamp) to YYYY-MM-DD. */
function dateKey(value: unknown): string {
  return normalizeDateKey(value);
}

function seedDateKey(value: unknown): string {
  return dateKey(value);
}

function optionSeedValue(prop: DbProperty, value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return (
    prop.config?.options?.find(
      (option) => option.id.toLowerCase() === lower || option.name.toLowerCase() === lower
    )?.id ?? raw
  );
}

function filterSeedValue(prop: DbProperty, filter: ViewFilter): unknown | typeof NO_FILTER_SEED {
  if (filter.operator === "is_empty" || filter.operator === "is_not_empty") return NO_FILTER_SEED;

  if (prop.type === "select" || prop.type === "status") {
    if (filter.operator !== "equals") return NO_FILTER_SEED;
    const value = optionSeedValue(prop, filter.value);
    return value ? value : NO_FILTER_SEED;
  }

  if (prop.type === "multi_select") {
    if (filter.operator !== "equals" && filter.operator !== "contains") return NO_FILTER_SEED;
    const value = optionSeedValue(prop, filter.value);
    return value ? [value] : NO_FILTER_SEED;
  }

  if (prop.type === "checkbox") {
    if (filter.operator !== "equals") return NO_FILTER_SEED;
    return filter.value === true || filter.value === "true";
  }

  if (prop.type === "number" || prop.type === "unique_id") {
    if (filter.operator !== "equals") return NO_FILTER_SEED;
    const value = Number(filter.value);
    return Number.isFinite(value) ? value : NO_FILTER_SEED;
  }

  if (prop.type === "date") {
    if (
      filter.operator !== "equals" &&
      filter.operator !== "on_or_after" &&
      filter.operator !== "on_or_before"
    ) {
      return NO_FILTER_SEED;
    }
    const value = seedDateKey(filter.value);
    return value ? value : NO_FILTER_SEED;
  }

  if (
    prop.type === "title" ||
    prop.type === "rich_text" ||
    prop.type === "url" ||
    prop.type === "email" ||
    prop.type === "phone"
  ) {
    if (filter.operator !== "equals" && filter.operator !== "contains") return NO_FILTER_SEED;
    const value = String(filter.value ?? "").trim();
    return value ? value : NO_FILTER_SEED;
  }

  if (prop.type === "relation") {
    if (filter.operator !== "contains" && filter.operator !== "equals") return NO_FILTER_SEED;
    const ids = optionIds(filter.value);
    return ids.length ? ids : NO_FILTER_SEED;
  }

  return NO_FILTER_SEED;
}

function sameSeedValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function viewFilterSeedValues(
  props: DbProperty[],
  view: DbView,
  omitPropertyIds: Iterable<string> = [],
  options: { currentPageId?: string } = {}
): ViewFilterSeedValues {
  const byId = new Map(props.map((prop) => [prop.id, prop]));
  const omitted = new Set(omitPropertyIds);
  const blocked = new Set<string>();
  const seeds: ViewFilterSeedValues = { properties: {} };

  function put(prop: DbProperty, value: unknown) {
    if (omitted.has(prop.id) || blocked.has(prop.id)) return;
    if (prop.type === "title") {
      if (seeds.title == null) seeds.title = String(value);
      else if (seeds.title !== String(value)) seeds.title = undefined;
      return;
    }
    const current = seeds.properties[prop.id];
    if (current === undefined) {
      seeds.properties[prop.id] = value;
      return;
    }
    if (prop.type === "multi_select") {
      const merged = Array.from(
        new Set([...(Array.isArray(current) ? current : [current]), ...(Array.isArray(value) ? value : [value])])
      ).filter(Boolean);
      seeds.properties[prop.id] = merged;
      return;
    }
    if (sameSeedValue(current, value)) return;
    delete seeds.properties[prop.id];
    blocked.add(prop.id);
  }

  function collectFilter(filter: ViewFilter) {
    const prop = byId.get(filter.propertyId);
    if (!prop || !isQueryableProperty(prop)) return;
    const value = filterSeedValue(prop, {
      ...filter,
      value: coreResolveFilterValue(filter.value, options.currentPageId),
    });
    if (value === NO_FILTER_SEED) return;
    put(prop, value);
  }

  function collectGroup(group: FilterGroup) {
    if (group.conjunction !== "and") return;
    for (const filter of group.filters) collectFilter(filter);
    for (const sub of group.groups ?? []) collectGroup(sub);
  }

  if (view.config?.filterGroup) {
    collectGroup(view.config.filterGroup);
  } else if ((view.config?.filterConjunction ?? "and") === "and") {
    for (const filter of view.config?.filters ?? []) collectFilter(filter);
  }

  return seeds;
}

export function applyViewFilterSeeds(
  rowId: string,
  seeds: ViewFilterSeedValues,
  updatePage: (pageId: string, patch: Partial<Page>) => void,
  setRowProperty: (
    rowId: string,
    propId: string,
    value: unknown,
    opts?: { debounce?: boolean }
  ) => void
) {
  if (seeds.title != null) updatePage(rowId, { title: seeds.title });
  for (const [propId, value] of Object.entries(seeds.properties)) {
    setRowProperty(rowId, propId, value, { debounce: false });
  }
}

/** Human-readable text for a value, used for search, text filters, and string sorts. */
function displayText(v: unknown, prop: DbProperty, ctx: QueryContext, row?: Page): string {
  if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    return optionIds(v).map((id) => optionLabel(prop, id)).join(" ");
  }
  if (prop.type === "checkbox") return v ? "checked true yes" : "unchecked false no";
  if (prop.type === "unique_id") {
    if (v == null || v === "") return "";
    const prefix = prop.config?.idPrefix?.trim();
    return prefix ? `${prefix}-${v}` : String(v);
  }
  if (isDateLike(prop)) return dateKey(v);
  if (prop.type === "relation") {
    return optionIds(v)
      .map((id) => ctx.pagesById[id]?.title || "")
      .filter(Boolean)
      .join(" ");
  }
  if (prop.type === "formula" && row) {
    const computed = backendComputedText(row, prop);
    if (computed !== undefined) return computed;
    return formatFormulaValue(
      evaluateFormula({ row, prop, props: ctx.props, pagesById: ctx.pagesById })
    );
  }
  return asText(v, prop);
}

function searchableText(row: Page, prop: DbProperty, ctx: QueryContext): string {
  return displayText(cellValue(row, prop), prop, ctx, row);
}

// The viewer's IANA timezone, resolved once. Passed to the shared engine so an
// absolute-instant date (created_time/last_edited_time, stored as "…Z") is
// filtered/sorted on the same local calendar day the cell displays — without it
// a KST user's post-15:00-UTC row keys to the previous day and drops out of a
// "created today" filter.
const viewerTimeZone = resolvedViewerTimeZone();

// Web adapters over the shared filter/sort engine (shared/database/query-core.ts):
// injects web value-reading (`cellValue` → precomputed `__computed`), display
// text, date-key, person-id, and rollup-target resolution. The operator
// predicates, group evaluation, and sort keys live in the shared core.
function webAdapters(ctx: QueryContext): QueryAdapters {
  return {
    cellValue: (row, prop) => cellValue(row as Page, prop as DbProperty),
    displayText: (row, prop) =>
      displayText(cellValue(row as Page, prop as DbProperty), prop as DbProperty, ctx, row as Page),
    asText: (value, prop) => asText(value, prop as DbProperty | undefined),
    personIds: (value) => normalizePersonIds(value),
    rollupTargetIds: (row, prop) => rollupRelationTargetIds(row as Page, prop as DbProperty, ctx),
    currentPageId: ctx.currentPageId,
    timeZone: viewerTimeZone,
  };
}

/**
 * Recursively evaluate a nested AND/OR filter tree against a row. Leaf conditions
 * (`group.filters`) and nested sub-groups (`group.groups`) are combined with
 * `group.conjunction`: "and" requires every term, "or" requires some term. Leaves
 * whose property is missing from `byId` are skipped. An empty group matches every row.
 */
export function matchesFilterGroup(
  row: Page,
  group: FilterGroup,
  ctx: QueryContext,
  byId: Map<string, DbProperty>
): boolean {
  return coreMatchesFilterGroup(
    row as unknown as QueryPage,
    group as unknown as QueryFilterGroup,
    webAdapters(ctx),
    byId as unknown as Map<string, QueryProperty>
  );
}

/** Apply a view's filters + sorts to the row set. */
export function applyView(
  rows: Page[],
  props: DbProperty[],
  view: DbView,
  pagesById: Record<string, Page> = {},
  options: ApplyViewOptions = {}
): Page[] {
  const ctx: QueryContext = { props, pagesById, currentPageId: options.currentPageId };
  const adapters = webAdapters(ctx);
  const byId = new Map(props.map((p) => [p.id, p]));
  const coreById = byId as unknown as Map<string, QueryProperty>;
  let out = rows.slice();
  const search = foldNfcText((options.search ?? view.config?.search ?? "").trim());

  if (search) {
    out = out.filter((row) =>
      props.some((prop) => foldNfcText(searchableText(row, prop, ctx)).includes(search))
    );
  }

  const filterGroup = effectiveFilterGroup(view.config, byId);
  if (filterGroup) {
    out = out.filter((r) =>
      coreMatchesFilterGroup(r as unknown as QueryPage, filterGroup as unknown as QueryFilterGroup, adapters, coreById)
    );
  }

  for (const s of [...(view.config?.sorts ?? [])].reverse()) {
    const prop = byId.get(s.propertyId);
    if (!prop) continue;
    const coreProp = prop as unknown as QueryProperty;
    // Decorate-sort-undecorate: compute each row's sort key once (O(n))
    // instead of inside the comparator (O(n log n) recomputations). The index
    // tie-break keeps the pass stable, preserving the previous multi-sort
    // order exactly.
    const decorated = out.map((row, index) => ({
      row,
      index,
      key: coreSortKey(row as unknown as QueryPage, coreProp, adapters),
    }));
    decorated.sort((a, b) => {
      const cmp = coreCompareKeys(a.key, b.key);
      const ordered = s.direction === "desc" ? -cmp : cmp;
      return ordered !== 0 ? ordered : a.index - b.index;
    });
    out = decorated.map((item) => item.row);
  }

  return out;
}
