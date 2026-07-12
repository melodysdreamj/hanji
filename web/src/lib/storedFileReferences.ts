import { storageKeyFromUrl } from "./fileUrls";

const MAX_REFERENCE_DEPTH = 128;
const PLAIN_TEXT_FIELDS = new Set([
  "caption",
  "description",
  "fileName",
  "label",
  "name",
  "plainText",
  "text",
  "title",
]);

function localStorageString(value: string) {
  const raw = value.trim();
  if (!raw) return false;
  if (raw.startsWith("workspaces/")) return true;
  // Use the same origin + exact-prefix guard as signed file resolution. An
  // arbitrary external site may legitimately expose `/api/storage/...`; its
  // pathname alone must not disable block/template copy features.
  return !!storageKeyFromUrl(raw);
}

/**
 * Detects a persisted local-storage locator without mistaking ordinary
 * external links for uploads. Clone paths use this to fail closed until they
 * can mint a new upload row and object instead of sharing ownership metadata.
 */
export function hasStoredFileReference(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
  field = ""
): boolean {
  if (depth > MAX_REFERENCE_DEPTH) return true;
  if (typeof value === "string") {
    return !PLAIN_TEXT_FIELDS.has(field) && localStorageString(value);
  }
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasStoredFileReference(item, seen, depth + 1, field));
  }
  const record = value as Record<string, unknown>;
  if (
    [record.uploadId, record.fileUploadId].some(
      (id) => typeof id === "string" && id.trim().length > 0
    )
  ) {
    return true;
  }
  return Object.entries(record).some(([key, item]) =>
    hasStoredFileReference(item, seen, depth + 1, key)
  );
}

/**
 * Template properties are keyed by dynamic property ids. Only a schema-declared
 * `files` value may interpret a bare string/string array as a stored file;
 * rich text is allowed to literally mention the same path.
 */
export function hasDatabaseTemplateStoredFileReference(
  template: {
    blocks?: unknown;
    icon?: unknown;
    properties?: Record<string, unknown> | null;
  },
  schema: Iterable<{ id: string; type: string }>
) {
  if (hasStoredFileReference({ blocks: template.blocks, icon: template.icon })) return true;
  const properties = template.properties ?? {};
  for (const property of schema) {
    if (
      property.type === "files" &&
      Object.prototype.hasOwnProperty.call(properties, property.id) &&
      hasStoredFileReference({ file: properties[property.id] })
    ) {
      return true;
    }
  }
  return false;
}
