/**
 * Database-view types accepted by the current Notion API (2026-03-11).
 *
 * Keep storage support separate from rendering support. Compatibility callers
 * must be able to round-trip every official type without silently coercing a
 * form/map/dashboard (or another future type) into a table view that appears
 * functional while losing its original configuration.
 */
export const NOTION_DATABASE_VIEW_TYPES = [
  'table',
  'board',
  'list',
  'calendar',
  'timeline',
  'gallery',
  'form',
  'chart',
  'map',
  'dashboard',
] as const;

export type NotionDatabaseViewType = typeof NOTION_DATABASE_VIEW_TYPES[number];

/** The six long-standing Hanji view types whose product behavior is stable. */
export const HANJI_CORE_DATABASE_VIEW_TYPES = [
  'table',
  'board',
  'list',
  'gallery',
  'calendar',
  'timeline',
] as const satisfies readonly NotionDatabaseViewType[];

/**
 * Official compatibility additions. The storage contract for these types is
 * lossless type/configuration round-tripping; it does not promise a native UI
 * renderer. (Chart may have richer product support independently.)
 */
export const NOTION_COMPAT_DATABASE_VIEW_TYPES = [
  'form',
  'chart',
  'map',
  'dashboard',
] as const satisfies readonly NotionDatabaseViewType[];

const notionViewTypeSet = new Set<string>(NOTION_DATABASE_VIEW_TYPES);
const coreViewTypeSet = new Set<string>(HANJI_CORE_DATABASE_VIEW_TYPES);

function viewValidationError(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

export function parseDatabaseViewType(value: unknown): NotionDatabaseViewType {
  if (typeof value !== 'string' || !value.trim()) {
    throw viewValidationError('Database view type is required.');
  }
  const type = value.trim().toLowerCase();
  if (!notionViewTypeSet.has(type)) {
    throw viewValidationError(
      `Unsupported database view type "${type}". Supported types: ${NOTION_DATABASE_VIEW_TYPES.join(', ')}.`,
    );
  }
  return type as NotionDatabaseViewType;
}

export function isCoreDatabaseViewType(
  value: unknown,
): value is typeof HANJI_CORE_DATABASE_VIEW_TYPES[number] {
  return typeof value === 'string' && coreViewTypeSet.has(value);
}

export function databaseViewStorageCapability(type: NotionDatabaseViewType) {
  return isCoreDatabaseViewType(type) ? 'core' as const : 'notion_compat' as const;
}

function viewConfig(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw viewValidationError('Database view config must be a JSON object.');
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * Canonicalizes only the type token and validates an optional official config
 * discriminator. Every other configuration field is retained verbatim.
 */
export function normalizeDatabaseViewStorageRecord<T extends Record<string, unknown>>(
  record: T,
): Omit<T, 'type'> & { type: NotionDatabaseViewType } {
  const type = parseDatabaseViewType(record.type);
  const config = viewConfig(record.config);
  if (config && 'type' in config) {
    if (typeof config.type !== 'string') {
      throw viewValidationError('Database view config.type must be a string when provided.');
    }
    const configType = parseDatabaseViewType(config.type);
    if (configType !== type) {
      throw viewValidationError(
        `Database view config.type "${configType}" must match view type "${type}".`,
      );
    }
    config.type = configType;
  }
  const normalized: Record<string, unknown> = { ...record, type };
  if (config === undefined) delete normalized.config;
  else normalized.config = config;
  return normalized as Omit<T, 'type'> & { type: NotionDatabaseViewType };
}
