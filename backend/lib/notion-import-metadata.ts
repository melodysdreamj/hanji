/** Scrubs bearer material from durable Notion discovery metadata. */
const NOTION_CREDENTIAL_METADATA_KEY_RE =
  /(?:^|_)(?:access_?token|refresh_?token|token|secret|password|authorization|cookie|credential|api_?key|signature|signed_?url)(?:$|_)/i;
const NOTION_CREDENTIAL_URL_PARAM_RE =
  /^(?:access_?token|refresh_?token|token|signature|credential|authorization|jwt|policy|expires?|key-pair-id|x-amz-.+|x-goog-.+)$/i;
const AZURE_SAS_CONTEXT_URL_PARAMS = new Set([
  'sv',
  'se',
  'sp',
  'sr',
  'st',
  'spr',
  'skoid',
  'sktid',
]);

export function isCredentialBearingNotionUrl(value: string) {
  if (/^data:/i.test(value)) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    // URLSearchParams decodes percent-encoded parameter names before exposing
    // them, and matching below is case-insensitive. Azure Blob SAS uses `sig`
    // together with keys such as sv/se/sp/sr/st/spr/skoid/sktid. An exact
    // standalone `sig` is also a bearer signature in common CDN/object-store
    // schemes, so durable import metadata treats it as secret regardless of
    // host. This deliberately fails closed: a product URL using exact `sig`
    // for non-secret state is scrubbed, while lookalike ordinary keys such as
    // `signal` or `designature` remain intact.
    const parameterNames = Array.from(url.searchParams.keys(), (key) => key.trim().toLowerCase());
    const hasExactSignature = parameterNames.includes('sig');
    const hasAzureSasContext = parameterNames.some((key) => AZURE_SAS_CONTEXT_URL_PARAMS.has(key));
    if (hasExactSignature && hasAzureSasContext) return true;
    if (hasExactSignature) return true;
    return parameterNames.some((key) => NOTION_CREDENTIAL_URL_PARAM_RE.test(key));
  } catch {
    return false;
  }
}

/**
 * Notion discovery payloads can contain temporary or externally signed file
 * URLs. Preserve the structural metadata needed for import repair while
 * removing bearer material before it is copied into durable product rows (and,
 * after a successful apply, from the import staging rows themselves).
 */
export function sanitizeNotionCredentialMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 24) return undefined;
  if (typeof value === 'string') {
    return isCredentialBearingNotionUrl(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeNotionCredentialMetadata(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (
      normalized === 'sourceurl'
      || normalized === 'notionfile'
      || normalized === 'notionfileexpirytime'
      || normalized === 'expirytime'
      || NOTION_CREDENTIAL_METADATA_KEY_RE.test(key)
    ) {
      continue;
    }
    const sanitized = sanitizeNotionCredentialMetadata(item, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}
