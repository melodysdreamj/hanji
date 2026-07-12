const LEGACY_ENV_PREFIX = "NOTIONLIKE_";
const LEGACY_URI_SCHEME = "notionlike";
const CANONICAL_ENV_PREFIX = "HANJI_";
const CANONICAL_URI_SCHEME = "hanji";

/**
 * Read a canonical Hanji environment variable, falling back to its former
 * namespace only when the canonical variable is absent. An explicitly empty
 * canonical value therefore still disables an inherited legacy value.
 *
 * @param {string} canonicalName
 */
export function hanjiEnv(canonicalName) {
  if (!canonicalName.startsWith(CANONICAL_ENV_PREFIX)) {
    throw new Error(`Expected a ${CANONICAL_ENV_PREFIX} environment variable name.`);
  }
  if (Object.hasOwn(process.env, canonicalName)) return process.env[canonicalName];
  const legacyName = `${LEGACY_ENV_PREFIX}${canonicalName.slice(CANONICAL_ENV_PREFIX.length)}`;
  return process.env[legacyName];
}

/** @param {string} name */
export function isHanjiProductEnvName(name) {
  return name.startsWith(CANONICAL_ENV_PREFIX) || name.startsWith(LEGACY_ENV_PREFIX);
}

/** @param {NodeJS.ProcessEnv} env */
export function withoutHanjiProductEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !isHanjiProductEnvName(name)),
  );
}

/** @param {string} kind @param {string} value */
export function hanjiUri(kind, value) {
  return `${CANONICAL_URI_SCHEME}://${kind}/${value}`;
}

/**
 * Return the encoded payload from either the canonical URI or its read-only
 * compatibility alias.
 *
 * @param {unknown} value
 * @param {string} kind
 */
export function hanjiUriPayload(value, kind) {
  const raw = String(value ?? "").trim();
  for (const scheme of [CANONICAL_URI_SCHEME, LEGACY_URI_SCHEME]) {
    const prefix = `${scheme}://${kind}/`;
    if (raw.toLowerCase().startsWith(prefix)) {
      return raw.slice(prefix.length).split(/[?#]/, 1)[0];
    }
  }
  return "";
}

const markdownUriSchemes = `(?:${CANONICAL_URI_SCHEME}|${LEGACY_URI_SCHEME})`;
const markdownPageLinkPattern = new RegExp(
  `^\\[([^\\]]+)\\]\\(${markdownUriSchemes}:\\/\\/page\\/([^)]+)\\)$`,
  "i",
);
const markdownSyncedBlockPattern = new RegExp(
  `^\\[synced block\\](?:\\(${markdownUriSchemes}:\\/\\/block\\/([^)]+)\\))?$`,
  "i",
);

/** @param {string} value */
export function matchHanjiPageLink(value) {
  return String(value).match(markdownPageLinkPattern);
}

/** @param {string} value */
export function matchHanjiSyncedBlock(value) {
  return String(value).match(markdownSyncedBlockPattern);
}
