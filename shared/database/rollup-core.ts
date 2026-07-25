// Shared database rollup engine — the single implementation consumed by both
// the web app (web/src/components/database/rollup.ts) and the backend
// (backend/functions/page-query.ts, share-mutation.ts), mirroring how
// formula-core.ts is shared. Previously each side reimplemented this and the
// copies drifted (percent rounding, date normalization, return types).
//
// Environment-specific concerns are injected through `RollupContext` adapters
// (how to read a raw cell value, how to render a leaf cell for `show_original`,
// how to look up pages/props). The divergence-prone core logic — the reducers,
// relation-hop resolution, and date normalization — lives here and is unified:
// dates use a deterministic UTC key and percents round to 2 decimals.

/** Loose property shape — both web's strict `DbProperty` and backend's loose one satisfy it. */
export interface RollupProperty {
  id: string;
  databaseId: string;
  type: string;
  config?: Record<string, unknown> | null;
}

/** Loose page/row shape. Title and metadata are read through `RollupContext.rawValue`. */
export interface RollupPage {
  id: string;
  inTrash?: boolean;
  properties?: Record<string, unknown> | null;
}

export interface RollupContext {
  /** Resolve a related row by id (web: Record lookup, backend: Map lookup). */
  pagesById: (id: string) => RollupPage | undefined;
  /** Properties of a database by id (for multi-hop relation/rollup resolution). */
  propsByDb: (databaseId: string) => RollupProperty[];
  /** Read the raw value of a property on a row (title/metadata/properties[id]). */
  rawValue: (page: RollupPage, prop: RollupProperty) => unknown;
  /** Render a leaf cell to display text for the `show_original` fallback. */
  displayValue: (page: RollupPage, prop: RollupProperty) => string;
}

export const NOTION_ROLLUP_FUNCTIONS = [
  "count",
  "count_values",
  "empty",
  "not_empty",
  "unique",
  "show_unique",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest_date",
  "latest_date",
  "date_range",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
  "count_per_group",
  "percent_per_group",
  "show_original",
] as const;

/**
 * Hanji stored these names before Notion standardized the current public API
 * spellings. They remain accepted so existing databases do not change meaning.
 */
export const LEGACY_ROLLUP_FUNCTION_ALIASES = {
  count_all: "count",
  count_empty: "empty",
  count_unique: "unique",
} as const;

export const ROLLUP_FUNCTIONS = [
  ...NOTION_ROLLUP_FUNCTIONS,
  ...Object.keys(LEGACY_ROLLUP_FUNCTION_ALIASES),
] as const;

export type NotionRollupFunction = (typeof NOTION_ROLLUP_FUNCTIONS)[number];
export type LegacyRollupFunction = keyof typeof LEGACY_ROLLUP_FUNCTION_ALIASES;
export type RollupFunction = NotionRollupFunction | LegacyRollupFunction;
export type RollupResult = string | number;

const NOTION_ROLLUP_FUNCTION_SET = new Set<string>(NOTION_ROLLUP_FUNCTIONS);

/** Return a current Notion function name, preserving unknown-value detection. */
export function canonicalRollupFunction(value: unknown): NotionRollupFunction | undefined {
  if (typeof value !== "string") return undefined;
  const alias = LEGACY_ROLLUP_FUNCTION_ALIASES[value as LegacyRollupFunction];
  const normalized = alias ?? value;
  return NOTION_ROLLUP_FUNCTION_SET.has(normalized)
    ? normalized as NotionRollupFunction
    : undefined;
}

const MAX_HOPS = 3;

export function valueAsIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value) return [String(value)];
  return [];
}

function valueIsPresent(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== "";
}

/**
 * 2-decimal display percent (unified: web used toFixed(2), backend used
 * toFixed(6)). This engine's computed-value contract cannot yet carry Notion's
 * typed number/date/array rollup envelopes, so percentages remain display
 * strings and date/array rollups are flattened below. REST projection must not
 * mistake those flattened values for native typed rollup payloads.
 */
function rollupPercent(count: number, total: number): string {
  if (!total) return "0%";
  const value = (count / total) * 100;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

function rollupValuePieces(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(rollupValuePieces);
  if (!valueIsPresent(value)) return [];
  if (typeof value === "object") return [JSON.stringify(value)];
  return [String(value)];
}

function rollupCheckedValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "checked"].includes(value.trim().toLowerCase());
}

// Deterministic UTC date parsing (unified: web parsed in local time, backend in
// UTC). Date-only values are unaffected; datetime values with an offset resolve
// by their absolute instant so the same value keys identically everywhere.
function rollupDate(value: unknown): Date | null {
  const raw = String(value ?? "").split("/")[0].trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] ?? 0);
    const minute = Number(match[5] ?? 0);
    const second = Number(match[6] ?? 0);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(date.getTime())) return null;
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute ||
      date.getUTCSeconds() !== second
    ) {
      return null;
    }
    return date;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function rollupDateKey(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function rollupDateValues(value: unknown): Date[] {
  if (Array.isArray(value)) return value.flatMap(rollupDateValues);
  if (!value) return [];
  if (typeof value === "object") {
    const item = value as { start?: unknown; end?: unknown };
    return [item.start, item.end].flatMap(rollupDateValues);
  }
  return String(value)
    .split("/")
    .map((part) => rollupDate(part))
    .filter((date): date is Date => !!date)
    .sort((a, b) => a.getTime() - b.getTime());
}

function relationTargetDatabaseId(relationProp: RollupProperty): string {
  const configured = relationProp.config?.relationDatabaseId;
  return typeof configured === "string" ? configured : relationProp.databaseId;
}

function relationTargetProps(relationProp: RollupProperty, ctx: RollupContext): RollupProperty[] {
  return ctx.propsByDb(relationTargetDatabaseId(relationProp));
}

function followRelation(page: RollupPage, relationProp: RollupProperty, ctx: RollupContext): RollupPage[] {
  return valueAsIds(page.properties?.[relationProp.id])
    .map((id) => ctx.pagesById(id))
    .filter((related): related is RollupPage => !!related && !related.inTrash);
}

/**
 * Walk from a starting set of related pages through an optional second hop when
 * the rollup target is itself a relation or rollup. Depth-capped and
 * cycle-guarded so malformed configs cannot loop.
 */
export function resolveRollupHops(
  startPages: RollupPage[],
  targetProp: RollupProperty | undefined,
  prop: RollupProperty,
  ctx: RollupContext,
): { pages: RollupPage[]; targetProp: RollupProperty | undefined } {
  let pages = startPages;
  let current = targetProp;
  const seenDbs = new Set<string>();

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (!current) break;
    if (current.type !== "relation" && current.type !== "rollup") break;

    const ownerProps = ctx.propsByDb(current.databaseId);
    let hopRelation: RollupProperty | undefined;
    if (current.type === "relation") {
      hopRelation = current;
    } else {
      const viaId = hop === 0 && typeof prop.config?.rollupVia === "string" ? prop.config.rollupVia : undefined;
      hopRelation =
        (viaId ? ownerProps.find((item) => item.id === viaId) : undefined) ??
        ownerProps.find((item) => item.id === current?.config?.rollupRelationPropertyId);
    }
    if (!hopRelation || hopRelation.type !== "relation") break;

    const hopDbId = relationTargetDatabaseId(hopRelation);
    if (seenDbs.has(hopDbId)) break;
    seenDbs.add(hopDbId);

    pages = pages.flatMap((page) => followRelation(page, hopRelation as RollupProperty, ctx));
    const hopProps = relationTargetProps(hopRelation, ctx);
    current =
      current.type === "rollup"
        ? hopProps.find((item) => item.id === current?.config?.rollupTargetPropertyId)
        : undefined;
  }

  return { pages, targetProp: current };
}

export function evaluateRollup(
  row: RollupPage,
  prop: RollupProperty,
  sourceProps: RollupProperty[],
  targetProps: RollupProperty[],
  ctx: RollupContext,
): RollupResult {
  const relationProp = sourceProps.find((item) => item.id === prop.config?.rollupRelationPropertyId);
  if (!relationProp) return "";

  const relatedPages = valueAsIds(row.properties?.[relationProp.id])
    .map((id) => ctx.pagesById(id))
    .filter((page): page is RollupPage => !!page && !page.inTrash);
  const fn = canonicalRollupFunction(prop.config?.rollupFunction) ?? "show_original";
  if (fn === "count") return relatedPages.length;

  const firstHopTarget = targetProps.find((item) => item.id === prop.config?.rollupTargetPropertyId);

  const { pages: leafPages, targetProp } =
    firstHopTarget && (firstHopTarget.type === "relation" || firstHopTarget.type === "rollup")
      ? resolveRollupHops(relatedPages, firstHopTarget, prop, ctx)
      : { pages: relatedPages, targetProp: firstHopTarget };

  const values = targetProp
    ? leafPages.map((page) => ctx.rawValue(page, targetProp))
    : leafPages.map((page) => ctx.rawValue(page, TITLE_PROP));
  const presentValues = values.filter(valueIsPresent);

  if (fn === "count_values") return presentValues.length;
  if (fn === "unique") return new Set(values.flatMap(rollupValuePieces)).size;
  if (fn === "empty") return values.length - presentValues.length;
  if (fn === "not_empty") return presentValues.length;
  if (fn === "percent_empty") return rollupPercent(values.length - presentValues.length, values.length);
  if (fn === "percent_not_empty") return rollupPercent(presentValues.length, values.length);

  // Notion's public rollup config exposes these function names but not the
  // selected status-group id needed to evaluate them. Returning empty is
  // deliberate: backend adapters can then use a preserved imported computed
  // value instead of manufacturing a plausible-but-wrong group count.
  if (fn === "count_per_group" || fn === "percent_per_group") return "";

  const checkedCount = values.filter(rollupCheckedValue).length;
  if (fn === "checked") return checkedCount;
  if (fn === "unchecked") return values.length - checkedCount;
  if (fn === "percent_checked") return rollupPercent(checkedCount, values.length);
  if (fn === "percent_unchecked") return rollupPercent(values.length - checkedCount, values.length);

  const numbers = presentValues.map((value) => Number(value)).filter((value) => Number.isFinite(value));

  if (fn === "sum") return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : "";
  if (fn === "average") {
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : "";
  }
  if (fn === "median") {
    if (!numbers.length) return "";
    const sorted = numbers.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  if (fn === "min") return numbers.length ? Math.min(...numbers) : "";
  if (fn === "max") return numbers.length ? Math.max(...numbers) : "";
  if (fn === "range") return numbers.length ? Math.max(...numbers) - Math.min(...numbers) : "";

  const dates = values.flatMap(rollupDateValues).sort((a, b) => a.getTime() - b.getTime());
  if (fn === "earliest_date") return dates.length ? rollupDateKey(dates[0]) : "";
  if (fn === "latest_date") return dates.length ? rollupDateKey(dates[dates.length - 1]) : "";
  if (fn === "date_range") {
    if (!dates.length) return "";
    const start = rollupDateKey(dates[0]);
    const end = rollupDateKey(dates[dates.length - 1]);
    return start === end ? start : `${start} → ${end}`;
  }

  const displayedValues = leafPages
    .map((page) => (targetProp ? ctx.displayValue(page, targetProp) : ctx.displayValue(page, TITLE_PROP)))
    .filter(Boolean);
  // The shared computed-value type is scalar, so show_original/show_unique are
  // display strings rather than Notion property-item arrays. Scalar values are
  // deduplicated faithfully; multi-valued cells stay flattened by the adapter.
  return (fn === "show_unique" ? [...new Set(displayedValues)] : displayedValues).join(", ");
}

// Synthetic title property so the show_original / title fallbacks route the leaf
// through the caller's `rawValue`/`displayValue` adapters, which know how to
// read/render a row title in their environment.
const TITLE_PROP: RollupProperty = { id: "__title", databaseId: "", type: "title", config: null };
