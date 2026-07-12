const DEFAULT_BINARY_CONTENT_TYPE = 'application/octet-stream';

// These formats can execute script or active markup when served from the app
// origin. Hanji never needs them as inline-renderable attachments; accepting
// them would turn a normal file upload into a same-origin stored-XSS primitive.
const ACTIVE_CONTENT_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/xhtml+xml',
  'application/xml',
  'image/svg+xml',
  'text/css',
  'text/ecmascript',
  'text/html',
  'text/javascript',
  'text/xml',
]);

const ACTIVE_FILE_EXTENSIONS = new Set([
  'cjs',
  'css',
  'hta',
  'htm',
  'html',
  'js',
  'mht',
  'mhtml',
  'mjs',
  'shtml',
  'svg',
  'svgz',
  'xht',
  'xhtml',
  'xml',
  'xsl',
  'xslt',
]);

function baseContentType(value: string) {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function normalizeFileContentType(value: unknown, fallback = DEFAULT_BINARY_CONTENT_TYPE) {
  const raw = typeof value === 'string' ? baseContentType(value) : '';
  const contentType = raw || baseContentType(fallback) || DEFAULT_BINARY_CONTENT_TYPE;
  if (contentType.length > 128 || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(contentType)) {
    throw new Error('contentType is invalid.');
  }
  return contentType;
}

export function isActiveFileContentType(value: unknown) {
  if (typeof value !== 'string') return false;
  const contentType = baseContentType(value);
  return ACTIVE_CONTENT_TYPES.has(contentType) || contentType.endsWith('+xml');
}

export function isActiveFileName(value: unknown) {
  if (typeof value !== 'string') return false;
  const match = value
    .trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return !!match && ACTIVE_FILE_EXTENSIONS.has(match[1]);
}

export function assertSafeStoredFileType(name: unknown, contentType: unknown) {
  const normalized = normalizeFileContentType(contentType);
  if (isActiveFileName(name) || isActiveFileContentType(normalized)) {
    throw new Error('Active web content files are not allowed.');
  }
  return normalized;
}
