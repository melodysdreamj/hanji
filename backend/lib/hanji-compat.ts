import {
  HANJI_CURRENT_PAGE_FILTER_KIND,
  isHanjiCurrentPageFilterKind,
} from '../../shared/legacy-product-compat';

type Env = Record<string, unknown> | undefined;

const HANJI_ENV_PREFIX = 'HANJI_';
const LEGACY_ENV_PREFIX = 'NOTIONLIKE_';
const HANJI_HEADER_PREFIX = 'X-Hanji-';
const LEGACY_HEADER_PREFIX = 'X-Notionlike-';

export const HANJI_URI_PROTOCOL = 'hanji:';
const LEGACY_HANJI_URI_PROTOCOL = 'notionlike:';

export const HANJI_NATIVE_FORMAT = 'hanji.export';
const LEGACY_HANJI_NATIVE_FORMAT = 'inkline.export';
export const HANJI_NATIVE_FILE_EXTENSION = '.hanji.json';
const LEGACY_HANJI_NATIVE_FILE_EXTENSION = '.inkline.json';

/** Former refresh-cookie base name; deletion only, never authentication input. */
export const LEGACY_REFRESH_COOKIE_BASE_NAME_DELETE_ONLY = 'notionlike-refresh';

export { HANJI_CURRENT_PAGE_FILTER_KIND };

export const HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER = 'hanjiImportedRowContextFilter';
const LEGACY_IMPORTED_ROW_CONTEXT_FILTER_MARKER = 'notionlikeImportedRowContextFilter';

function runtimeEnv() {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env;
}

function legacyEnvName(name: string) {
  if (!name.startsWith(HANJI_ENV_PREFIX)) return undefined;
  return `${LEGACY_ENV_PREFIX}${name.slice(HANJI_ENV_PREFIX.length)}`;
}

function envCandidates(names: readonly string[]) {
  const candidates: string[] = [];
  for (const name of names) {
    candidates.push(name);
    const legacyName = legacyEnvName(name);
    if (legacyName) candidates.push(legacyName);
  }
  return Array.from(new Set(candidates));
}

function ownedEnvValue(env: Record<string, unknown> | undefined, name: string) {
  if (!env || !Object.hasOwn(env, name)) return { present: false as const, value: undefined };
  const raw = env[name];
  if (typeof raw === 'string') {
    return { present: true as const, value: raw.trim() || undefined };
  }
  if (typeof raw === 'boolean') {
    return { present: true as const, value: raw ? 'true' : 'false' };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { present: true as const, value: String(raw) };
  }
  return { present: true as const, value: undefined };
}

/**
 * Read a canonical Hanji environment value, falling back to the former
 * product prefix and then to any explicit platform aliases. Callers always
 * pass the Hanji name, so legacy environment compatibility stays here.
 */
export function hanjiEnvValue(env: Env, ...names: string[]) {
  const processEnv = runtimeEnv();
  for (const name of envCandidates(names)) {
    const contextValue = ownedEnvValue(env, name);
    if (contextValue.present) return contextValue.value;
    const processValue = ownedEnvValue(processEnv, name);
    if (processValue.present) return processValue.value;
  }
  return undefined;
}

/** Read one exact environment key without legacy-prefix or platform aliases. */
export function hanjiCanonicalEnvValue(env: Env, name: string) {
  const contextValue = ownedEnvValue(env, name);
  if (contextValue.present) return contextValue.value;
  const processValue = ownedEnvValue(runtimeEnv(), name);
  return processValue.present ? processValue.value : undefined;
}

export function hanjiEnvFlag(env: Env, ...names: string[]) {
  const value = hanjiEnvValue(env, ...names)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function hanjiEnvList(env: Env, ...names: string[]) {
  const value = hanjiEnvValue(env, ...names);
  return value
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
}

/**
 * Read a comma-separated list while allowing an explicit canonical `off`
 * value to clear stale legacy/platform configuration. The sentinel is
 * intentionally case-sensitive so ordinary identifiers are not broadened
 * into control values by normalization.
 */
export function hanjiEnvListWithOffSentinel(env: Env, ...names: string[]) {
  const value = hanjiEnvValue(env, ...names);
  if (!value || value === 'off') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/** Read a canonical MCP audit header, accepting the former prefix on input. */
export function hanjiHeader(headers: Headers | undefined, name: string) {
  const canonical = headers?.get(name);
  if (canonical !== null && canonical !== undefined) return canonical;
  if (!name.startsWith(HANJI_HEADER_PREFIX)) return null;
  return headers?.get(`${LEGACY_HEADER_PREFIX}${name.slice(HANJI_HEADER_PREFIX.length)}`) ?? null;
}

/** Parse both Hanji links and links emitted by older native exports. */
export function isHanjiUriProtocol(protocol: string) {
  return protocol === HANJI_URI_PROTOCOL || protocol === LEGACY_HANJI_URI_PROTOCOL;
}

/** Accept an older native document on import; exporters use HANJI_NATIVE_FORMAT. */
export function isHanjiNativeFormat(value: unknown) {
  return value === HANJI_NATIVE_FORMAT || value === LEGACY_HANJI_NATIVE_FORMAT;
}

export function isHanjiNativeFileName(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith(HANJI_NATIVE_FILE_EXTENSION)
    || normalized.endsWith(LEGACY_HANJI_NATIVE_FILE_EXTENSION);
}

/** Read current-page relation filters persisted by either namespace. */
export function isHanjiCurrentPageFilterValue(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>).kind;
  return isHanjiCurrentPageFilterKind(kind);
}

/** Read row-context filter markers persisted by either namespace. */
export function hasHanjiImportedRowContextFilterMarker(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record[HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER] === true
    || record[LEGACY_IMPORTED_ROW_CONTEXT_FILTER_MARKER] === true;
}

const HANJI_NATIVE_URI_FIELDS = new Set(['href', 'link', 'uri', 'url']);

function normalizeLegacyHanjiNativeString(value: string, propertyName: string, depth: number) {
  if (depth === 1 && propertyName === 'format' && isHanjiNativeFormat(value)) {
    return HANJI_NATIVE_FORMAT;
  }
  if (propertyName === 'kind' && isHanjiCurrentPageFilterKind(value)) {
    return HANJI_CURRENT_PAGE_FILTER_KIND;
  }
  if (!HANJI_NATIVE_URI_FIELDS.has(propertyName)) return value;
  const legacyUriPrefix = `${LEGACY_HANJI_URI_PROTOCOL}//`;
  return value.toLowerCase().startsWith(legacyUriPrefix)
    ? `${HANJI_URI_PROTOCOL}//${value.slice(legacyUriPrefix.length)}`
    : value;
}

/**
 * Canonicalize namespace identifiers anywhere in an imported native document.
 *
 * Older identifiers are accepted only at this read boundary. The returned
 * JSON tree changes only reserved semantic slots: the envelope format, filter
 * kind, internal link fields, and the row-context marker. Plain/code text is
 * lossless. Canonical documents reuse their original tree; only changed
 * branches are copied. When both row-context marker keys exist, the canonical
 * value is authoritative and the legacy key is discarded.
 */
export function normalizeLegacyHanjiNativeDocument(value: unknown): unknown {
  const normalize = (current: unknown, propertyName: string, depth: number): unknown => {
    if (typeof current === 'string') {
      return normalizeLegacyHanjiNativeString(current, propertyName, depth);
    }
    if (Array.isArray(current)) {
      let changed = false;
      const next = current.map((child) => {
        const normalized = normalize(child, '', depth + 1);
        if (normalized !== child) changed = true;
        return normalized;
      });
      return changed ? next : current;
    }
    if (!current || typeof current !== 'object') return current;

    const record = current as Record<string, unknown>;
    let next: Record<string, unknown> | undefined;
    const mutable = () => (next ??= { ...record });
    for (const [key, child] of Object.entries(record)) {
      if (key === LEGACY_IMPORTED_ROW_CONTEXT_FILTER_MARKER) {
        delete mutable()[key];
        continue;
      }
      const normalized = normalize(child, key, depth + 1);
      if (normalized !== child) mutable()[key] = normalized;
    }
    if (
      Object.hasOwn(record, LEGACY_IMPORTED_ROW_CONTEXT_FILTER_MARKER)
      && !Object.hasOwn(record, HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER)
    ) {
      mutable()[HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER] = normalize(
        record[LEGACY_IMPORTED_ROW_CONTEXT_FILTER_MARKER],
        HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER,
        depth + 1,
      );
    }
    return next ?? current;
  };

  return normalize(value, '', 0);
}
