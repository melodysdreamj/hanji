// Shared database filter/sort engine — the single implementation consumed by
// both the web app (web/src/components/database/query.ts) and the backend
// (backend/functions/page-query.ts), mirroring formula-core.ts / rollup-core.ts.
// Previously each side reimplemented `matches`/`matchesFilterGroup`/`sortKey`
// byte-for-byte and drifted only in value-extraction/normalization helpers.
//
// Environment-specific concerns (how to read a cell, render display text,
// normalize a date key, extract person/rollup ids) are injected through
// `QueryAdapters`; the operator predicates, group evaluation, sort keys, and
// effective-filter-group derivation live here so web and backend agree.

/** Loose property shape — both web's strict `DbProperty` and backend's loose one satisfy it. */
export interface QueryProperty {
  id: string;
  type: string;
  config?: Record<string, unknown> | null;
}

/** Loose page/row shape. Values are read through `QueryAdapters.cellValue`. */
export interface QueryPage {
  id: string;
  title?: string;
  properties?: Record<string, unknown> | null;
  inTrash?: boolean;
}

export interface QueryFilter {
  propertyId: string;
  operator: string;
  value?: unknown;
}

export interface QueryFilterGroup {
  conjunction: string;
  filters: QueryFilter[];
  groups?: QueryFilterGroup[];
}

export interface QuerySort {
  propertyId: string;
  direction: string;
}

/** The view-config subset the effective-filter-group derivation reads. */
export interface QueryViewConfig {
  filterGroup?: QueryFilterGroup;
  filters?: QueryFilter[];
  filterConjunction?: string;
  quickFilters?: Array<QueryFilter | QueryFilterGroup>;
}

export interface QueryAdapters {
  /** Raw value for a (row, property) pair (incl. computed formula/rollup). */
  cellValue: (row: QueryPage, prop: QueryProperty) => unknown;
  /** Human-readable text for the row's value (search/text-filter/string-sort). */
  displayText: (row: QueryPage, prop: QueryProperty) => string;
  /** Text for an arbitrary value (filter query values, files/person rendering). */
  asText: (value: unknown, prop?: QueryProperty) => string;
  /** Extract person ids from a person/created_by/last_edited_by value. */
  personIds: (value: unknown) => string[];
  /** Leaf ids a rollup relation reaches, for rollup relation filters. */
  rollupTargetIds: (row: QueryPage, prop: QueryProperty) => string[];
  currentPageId?: string;
  /**
   * IANA timezone used to resolve the *calendar day* of absolute-instant date
   * values (created_time/last_edited_time and zoned datetimes). The web app
   * passes the browser zone so that date filtering/sorting/grouping agree with
   * the local time the cell actually displays; when omitted the UTC day is used
   * (the correct default for headless/backend callers).
   */
  timeZone?: string;
}

const CURRENT_PAGE_FILTER_KIND = "notionlike.current_page";

export function currentPageFilterValue() {
  return { kind: CURRENT_PAGE_FILTER_KIND };
}

export function isCurrentPageFilterValue(value: unknown) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === CURRENT_PAGE_FILTER_KIND
  );
}

export function resolveFilterValue(value: unknown, currentPageId?: string): unknown {
  if (isCurrentPageFilterValue(value)) return currentPageId ?? "";
  if (!Array.isArray(value)) return value;
  return value.map((item) => (isCurrentPageFilterValue(item) ? currentPageId ?? "" : item));
}

export function optionIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function selectOptions(prop: QueryProperty): Array<{ id: string; name: string }> {
  const options = prop.config?.options;
  return Array.isArray(options) ? (options as Array<{ id: string; name: string }>) : [];
}

function optionIndex(prop: QueryProperty, id: string): number {
  // Match by id or name (unified to backend's superset; web values are ids so
  // the name branch is a no-op there).
  const idx = selectOptions(prop).findIndex((option) => option.id === id || option.name === id);
  return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
}

function optionTargets(prop: QueryProperty, value: unknown): Set<string> {
  const values = Array.isArray(value) ? value : [value];
  const targets = new Set<string>();
  for (const item of values) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    targets.add(raw);
    for (const option of selectOptions(prop)) {
      if (option.id.toLowerCase() === lower || option.name.toLowerCase() === lower) {
        targets.add(option.id);
      }
    }
  }
  return targets;
}

function isDateLike(prop: QueryProperty): boolean {
  return prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time";
}

// A rollup either SURFACES its related leaf values (show_original — the default)
// or AGGREGATES them into a scalar (sum/average/min/max/range/count_*/percent_*/
// checked/unchecked/earliest_date/latest_date/date_range/…). Only surfacing
// rollups filter by relation membership over the individual leaf ids; aggregate
// rollups fall through to the numeric/date/text comparison paths that operate on
// the scalar cell value, so equals/does_not_equal agree with greater_than/less_than.
function isRelationSurfacingRollup(prop: QueryProperty): boolean {
  const fn = prop.config?.rollupFunction;
  return typeof fn !== "string" || fn === "show_original";
}

// A datetime string is an *absolute instant* when it carries an explicit UTC
// marker (Z) or a numeric offset — its calendar day depends on the viewer's
// timezone. A bare "YYYY-MM-DD" (or a zone-less "YYYY-MM-DDTHH:MM") is a
// wall-clock value taken verbatim.
function hasExplicitZone(raw: string): boolean {
  return /T.*(Z|[+-]\d{2}:?\d{2})$/.test(raw);
}

// Calendar day (YYYY-MM-DD) of an instant, resolved in `timeZone` when given
// (en-CA formats as ISO), else the UTC day.
function dayFromInstant(instantMs: number, timeZone?: string): string {
  if (timeZone) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instantMs));
  }
  return new Date(instantMs).toISOString().slice(0, 10);
}

// Day-granular date comparison key.
//
// When a `timeZone` is supplied (the web app passes the browser zone), absolute
// instants — created_time/last_edited_time, zoned datetimes, epoch numbers —
// resolve to their calendar day in that zone so the key matches the local time
// the cell displays. This is the fix for created_time being stored as "…Z" and
// shown in local time: a KST user's 01:00-Mar-16 row (stored "…T16:00:00Z"
// Mar 15) now keys as 2024-03-16, matching the cell and the filter.
//
// Without a `timeZone` (headless/backend default) the literal leading
// YYYY-MM-DD prefix is kept verbatim, so a day is never shifted off the zone it
// was written in — preserving the established backend semantics.
export function dateKey(value: unknown, timeZone?: string): string {
  if (value == null || value === "") return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? dayFromInstant(value, timeZone) : "";
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const start = (value as { start?: unknown }).start;
    if (start != null && start !== "") return dateKey(start, timeZone);
    return "";
  }
  const raw = String(value).trim();
  if (!raw) return "";
  if (timeZone && hasExplicitZone(raw)) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return dayFromInstant(t, timeZone);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) return dayFromInstant(parsed.getTime(), timeZone);
  return raw.slice(0, 10);
}

// Sub-day-precise sort key for date-like values, so same-day rows order by time
// (the day-granular `dateKey` collapses them). Absolute instants resolve to
// their UTC instant (comparable and environment-independent); zone-less values
// sort by their literal ISO text, so a day-only "2024-03-15" precedes same-day
// datetimes (i.e. sorts at the start of that day).
export function dateSortKey(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value).toISOString() : "";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const start = (value as { start?: unknown }).start;
    return start != null && start !== "" ? dateSortKey(start) : "";
  }
  const raw = String(value).trim();
  if (!raw) return "";
  if (hasExplicitZone(raw)) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return raw;
}

export function filterMatches(
  row: QueryPage,
  prop: QueryProperty,
  f: QueryFilter,
  a: QueryAdapters
): boolean {
  const v = a.cellValue(row, prop);

  if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    const ids = optionIds(v);
    const targets = optionTargets(prop, f.value);
    const hasTarget = ids.some((id) => targets.has(id));
    switch (f.operator) {
      case "equals":
      case "contains":
        return hasTarget;
      case "does_not_equal":
      case "does_not_contain":
        return !hasTarget;
      case "is_empty":
        return ids.length === 0;
      case "is_not_empty":
        return ids.length > 0;
      default:
        return true;
    }
  }

  if (prop.type === "checkbox") {
    const checked = v === true || v === "true";
    const want = f.value === true || f.value === "true";
    switch (f.operator) {
      case "equals":
        return checked === want;
      case "does_not_equal":
        return checked !== want;
      default:
        return true;
    }
  }

  if (prop.type === "relation" || prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    const ids = prop.type === "relation" ? optionIds(v) : a.personIds(v);
    const resolvedFilterValue = resolveFilterValue(f.value, a.currentPageId);
    const targetIds = optionIds(resolvedFilterValue);
    const hasTarget = targetIds.length > 0 && ids.some((id) => targetIds.includes(id));
    const t = a.displayText(row, prop).toLowerCase();
    const q = a.asText(resolvedFilterValue).toLowerCase().trim();
    switch (f.operator) {
      case "is_empty":
        return ids.length === 0;
      case "is_not_empty":
        return ids.length > 0;
      case "contains":
        if (targetIds.length > 0) return hasTarget;
        return q === "" || t.includes(q);
      case "does_not_contain":
        if (targetIds.length > 0) return !hasTarget;
        if (q === "") return true;
        return !t.includes(q);
      case "equals":
        if (targetIds.length > 0) return hasTarget;
        if (q === "") return true;
        return t === q;
      case "does_not_equal":
        if (targetIds.length > 0) return !hasTarget;
        if (q === "") return true;
        return t !== q;
      default:
        return true;
    }
  }

  if (prop.type === "number" || prop.type === "unique_id") {
    const empty = v == null || v === "";
    if (f.operator === "is_empty") return empty;
    if (f.operator === "is_not_empty") return !empty;
    // A cleared/unset cell has no numeric value: it must not coerce to 0 and
    // spuriously match `equals 0` / `> -1`. Value comparisons treat it as
    // "no match", except `does_not_equal` which an empty cell trivially satisfies
    // (mirrors the permissive negation in the relation/text branches).
    if (empty) return f.operator === "does_not_equal";
    const n = Number(v);
    const q = Number(f.value);
    switch (f.operator) {
      case "equals":
        return n === q;
      case "does_not_equal":
        return n !== q;
      case "greater_than":
        return n > q;
      case "less_than":
        return n < q;
      default:
        return true;
    }
  }

  if (isDateLike(prop)) {
    const dv = dateKey(v, a.timeZone);
    const dq = dateKey(f.value, a.timeZone);
    switch (f.operator) {
      case "is_empty":
        return dv === "";
      case "is_not_empty":
        return dv !== "";
      case "equals":
        return dv !== "" && dv === dq;
      case "on_or_after":
        return dv !== "" && dv >= dq;
      case "on_or_before":
        return dv !== "" && dv <= dq;
      default:
        return true;
    }
  }

  if (prop.type === "rollup" && isRelationSurfacingRollup(prop)) {
    const resolvedFilterValue = resolveFilterValue(f.value, a.currentPageId);
    const targetIds = optionIds(resolvedFilterValue);
    const rollupTargetIds = a.rollupTargetIds(row, prop);
    if (targetIds.length > 0 && rollupTargetIds.length > 0) {
      const hasTarget = rollupTargetIds.some((id) => targetIds.includes(id));
      switch (f.operator) {
        case "contains":
        case "equals":
          return hasTarget;
        case "does_not_contain":
        case "does_not_equal":
          return !hasTarget;
        default:
          break;
      }
    }
  }

  // Text-like (title, rich_text, url, email, phone, files, formula).
  const t = a.displayText(row, prop).toLowerCase();
  const q = a.asText(f.value).toLowerCase();
  // An empty-value negation filter is an inert no-op (mirrors the relation/person
  // branch): a blank "does not contain"/"does not equal" must not hide every row.
  if (q === "" && (f.operator === "does_not_contain" || f.operator === "does_not_equal")) return true;
  switch (f.operator) {
    case "equals":
      return t === q;
    case "does_not_equal":
      return t !== q;
    case "contains":
      return t.includes(q);
    case "does_not_contain":
      return !t.includes(q);
    case "is_empty":
      return t === "";
    case "is_not_empty":
      return t !== "";
    case "greater_than":
      return Number(v) > Number(f.value);
    case "less_than":
      return Number(v) < Number(f.value);
    case "on_or_after":
      return a.asText(v, prop) >= a.asText(f.value);
    case "on_or_before":
      return a.asText(v, prop) <= a.asText(f.value);
    default:
      return true;
  }
}

/**
 * Recursively evaluate a nested AND/OR filter tree against a row. Leaves whose
 * property is missing from `byId` are skipped; an empty group matches every row.
 */
export function matchesFilterGroup(
  row: QueryPage,
  group: QueryFilterGroup,
  a: QueryAdapters,
  byId: Map<string, QueryProperty>
): boolean {
  const terms: boolean[] = [];
  for (const f of group.filters) {
    const prop = byId.get(f.propertyId);
    if (!prop) continue;
    terms.push(filterMatches(row, prop, f, a));
  }
  for (const sub of group.groups ?? []) {
    terms.push(matchesFilterGroup(row, sub, a, byId));
  }
  if (terms.length === 0) return true;
  return group.conjunction === "or" ? terms.some(Boolean) : terms.every(Boolean);
}

/** Comparable key for sorting: number for numeric/ordinal types, else lowercased text. */
export function sortKey(row: QueryPage, prop: QueryProperty, a: QueryAdapters): number | string {
  const v = a.cellValue(row, prop);
  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    const ids = optionIds(v);
    return ids.length ? optionIndex(prop, ids[0]) : Number.MAX_SAFE_INTEGER;
  }
  if (prop.type === "number" || prop.type === "unique_id") {
    // Cleared (null) and never-set (undefined) cells both sort last; without the
    // explicit empty check `Number(null)` would coerce to 0 and interleave
    // cleared cells among real zeros.
    if (v == null || v === "") return Number.POSITIVE_INFINITY;
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  }
  if (prop.type === "checkbox") return v ? 1 : 0;
  if (isDateLike(prop)) {
    // Time-precise key so same-day rows order by time. Empty sorts last in
    // ascending order (the sentinel is above any ISO string); under `desc` the
    // caller negates the comparison, so empties lead — matching the existing
    // string-key behavior.
    const k = dateSortKey(v);
    return k === "" ? "￿" : k;
  }
  return a.displayText(row, prop).toLowerCase();
}

export function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function knownFilterTerm(term: QueryFilter | QueryFilterGroup, byId: Map<string, QueryProperty>): boolean {
  if ("conjunction" in term) {
    return (
      (term.filters ?? []).some((filter) => byId.has(filter.propertyId)) ||
      (term.groups ?? []).some((group) => knownFilterTerm(group, byId))
    );
  }
  return byId.has(term.propertyId);
}

function filterGroupFromTerms(terms: Array<QueryFilter | QueryFilterGroup>): QueryFilterGroup | undefined {
  const filters: QueryFilter[] = [];
  const groups: QueryFilterGroup[] = [];
  for (const term of terms) {
    if ("conjunction" in term) groups.push(term);
    else filters.push(term);
  }
  return filters.length || groups.length ? { conjunction: "and", filters, groups } : undefined;
}

export function filterGroupHasTerms(group: QueryFilterGroup | undefined): group is QueryFilterGroup {
  return !!group && (group.filters.length > 0 || (group.groups?.length ?? 0) > 0);
}

/** Merge stored filter group (or legacy flat filters) + quick filters into one tree. */
export function effectiveFilterGroup(
  config: QueryViewConfig | undefined,
  byId?: Map<string, QueryProperty>
): QueryFilterGroup | undefined {
  const groups: QueryFilterGroup[] = [];
  const terms: Array<QueryFilter | QueryFilterGroup> = [];
  const storedFilterGroup = filterGroupHasTerms(config?.filterGroup) ? config?.filterGroup : undefined;
  if (storedFilterGroup) groups.push(storedFilterGroup);
  if (!storedFilterGroup && Array.isArray(config?.filters) && config.filters.length > 0) {
    groups.push({
      conjunction: config.filterConjunction === "or" ? "or" : "and",
      filters: config.filters,
      groups: [],
    });
  }
  for (const term of config?.quickFilters ?? []) {
    if (!byId || knownFilterTerm(term, byId)) terms.push(term);
  }
  const quickGroup = filterGroupFromTerms(terms);
  if (quickGroup) groups.push(quickGroup);
  if (groups.length === 0) return undefined;
  if (groups.length === 1) return groups[0];
  return { conjunction: "and", filters: [], groups };
}
