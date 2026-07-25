import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { FileUpload } from './app-types';
import {
  NATIVE_DOCUMENT_LIMITS,
  NATIVE_FORMAT,
  redactNativeExportValue,
  sanitizeNativeEntitiesForExport,
  validateNativeEnvelope,
  type NativeEntities,
  type NativeExportEnvelope,
  type NativeWarning,
  type RelationPair,
} from './native-document';

export const NATIVE_ARCHIVE_FORMAT = 'hanji.archive' as const;
export const NATIVE_ARCHIVE_FORMAT_VERSION = 1;
export const NATIVE_ARCHIVE_DOCUMENT_PATH = 'hanji/document.json';
export const NATIVE_ARCHIVE_MANIFEST_PATH = 'hanji/manifest.json';
export const NATIVE_ARCHIVE_MIME = 'application/vnd.hanji.archive+zip';

export const NATIVE_ARCHIVE_LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalFileBytes: 512 * 1024 * 1024,
  maxDocumentBytes: NATIVE_DOCUMENT_LIMITS.maxBytes,
  maxManifestBytes: 64 * 1024,
  maxArchiveBytes: 518 * 1024 * 1024,
  maxEntries: 102,
  maxPathBytes: 240,
  maxPathDepth: 3,
  maxInventoryItems: 20_000,
  metadataConcurrency: 8,
  heavyConcurrency: 3,
  transactionChunkItems: 25,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FILE_ID = /^file-\d{6}$/;
const FILE_MARKER = /^hanji-archive:\/\/files\/(file-\d{6})$/;
const FILE_MARKER_PREFIX = 'hanji-archive://files/';
const ID_FIELDS = new Set(['uploadId', 'fileUploadId']);
const KEY_FIELDS = new Set(['key', 'fileKey', 'storageKey']);
const URL_FIELDS = new Set(['url', 'src', 'href']);
const LOCATOR_FIELDS = new Set([...KEY_FIELDS, ...URL_FIELDS]);
const ALLOWED_SCOPES = new Set([
  'uploads',
  'icons',
  'covers',
  'blocks/images',
  'blocks/videos',
  'blocks/audio',
  'blocks/files',
  'database/files',
]);

export interface NativeArchiveDocument
  extends Omit<NativeExportEnvelope, 'format' | 'formatVersion' | 'files'> {
  format: typeof NATIVE_ARCHIVE_FORMAT;
  formatVersion: typeof NATIVE_ARCHIVE_FORMAT_VERSION;
  files: { included: true; count: number; strippedReferences: number };
}

export interface NativeArchiveFileEntry {
  id: string;
  path: string;
  name: string;
  contentType: string;
  scope: string;
  bytes: number;
  sha256: string;
}

export interface NativeArchiveManifest {
  format: typeof NATIVE_ARCHIVE_FORMAT;
  formatVersion: typeof NATIVE_ARCHIVE_FORMAT_VERSION;
  generatedAt: string;
  document: { path: typeof NATIVE_ARCHIVE_DOCUMENT_PATH; bytes: number; sha256: string };
  files: NativeArchiveFileEntry[];
  totals: { files: number; fileBytes: number };
}

export interface NativeArchivePlannedFile {
  entry: Omit<NativeArchiveFileEntry, 'sha256'>;
  source: FileUpload;
}

export interface NativeArchiveWritableFile extends Omit<NativeArchiveFileEntry, 'sha256'> {
  open(): Promise<ReadableStream<Uint8Array>>;
}

export interface NativeArchiveFileTarget {
  id: string;
  bucket: string;
  key: string;
  url: string;
}

export interface NativeArchiveBinding {
  fileId: string;
  scope: string;
  source: {
    pageId?: string;
    blockId?: string;
    databaseId?: string;
    propertyId?: string;
    templateId?: string;
    commentId?: string;
  };
}

type FileOwner = NativeArchiveBinding['source'] & {
  scope: string;
  entityId: string;
};

interface UploadLookup {
  byId: Map<string, FileUpload>;
  byKey: Map<string, FileUpload[]>;
  byBucketKey: Map<string, FileUpload[]>;
  byUrl: Map<string, FileUpload[]>;
}

function archiveError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(`Invalid Hanji archive: ${message}`), { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function exactInteger(value: unknown, label: string, minimum = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw archiveError(`${label} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim()) throw archiveError(`${label} must be a non-empty string.`);
  if (value.length > max || CONTROL_CHARS.test(value)) throw archiveError(`${label} is too long or contains invalid characters.`);
  return value;
}

function canonicalJsonBytes(value: unknown, maxBytes: number, label: string) {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw archiveError(`${label} must be serializable JSON.`);
  }
  const bytes = encoder.encode(text);
  if (bytes.byteLength > maxBytes) throw archiveError(`${label} is too large.`, 413);
  return bytes;
}

function uploadBucket(upload: FileUpload) {
  return optionalString(upload.bucket) ?? 'files';
}

function uploadLookupKey(bucket: string, key: string) {
  return `${bucket}\u0000${key}`;
}

function buildUploadLookup(uploads: FileUpload[]): UploadLookup {
  const byId = new Map<string, FileUpload>();
  const byKey = new Map<string, FileUpload[]>();
  const byBucketKey = new Map<string, FileUpload[]>();
  const byUrl = new Map<string, FileUpload[]>();
  for (const upload of uploads) {
    if (byId.has(upload.id)) throw archiveError('the upload inventory contains a duplicate id.');
    byId.set(upload.id, upload);
    const key = optionalString(upload.key);
    if (key) {
      const keyMatches = byKey.get(key) ?? [];
      keyMatches.push(upload);
      byKey.set(key, keyMatches);
      const bucketKey = uploadLookupKey(uploadBucket(upload), key);
      const bucketMatches = byBucketKey.get(bucketKey) ?? [];
      bucketMatches.push(upload);
      byBucketKey.set(bucketKey, bucketMatches);
    }
    const url = optionalString(upload.url);
    if (url) {
      const matches = byUrl.get(url) ?? [];
      matches.push(upload);
      byUrl.set(url, matches);
    }
  }
  return { byId, byKey, byBucketKey, byUrl };
}

function decodeStoragePath(value: string) {
  try {
    return value.split('/').map((part) => decodeURIComponent(part)).join('/');
  } catch {
    throw archiveError('a local storage reference is malformed.');
  }
}

function localStorageLocator(value: string): { bucket?: string; key: string } | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw.startsWith('workspaces/')) {
    if (raw.length > 1_024 || CONTROL_CHARS.test(raw)) throw archiveError('a local storage key is malformed.');
    return { key: raw };
  }
  // An absolute URL is an identifier only when it exactly matches a stored
  // upload row. Never reinterpret an arbitrary host's pathname as our object.
  if (/^https?:\/\//i.test(raw) || !raw.startsWith('/api/storage/')) return undefined;
  let url: URL;
  try {
    url = new URL(raw, 'http://hanji.local');
  } catch {
    throw archiveError('a local storage URL is malformed.');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api' || segments[1] !== 'storage' || segments.length < 4) return undefined;
  const bucket = decodeStoragePath(segments[2]);
  const key = decodeStoragePath(segments.slice(3).join('/'));
  if (!bucket || !key || bucket.length > 128 || key.length > 1_024 || CONTROL_CHARS.test(`${bucket}${key}`)) {
    throw archiveError('a local storage URL is malformed.');
  }
  return { bucket, key };
}

function oneUpload(matches: FileUpload[], missingIsLocal: boolean) {
  if (matches.length > 1) throw archiveError('a file reference is ambiguous.');
  if (matches[0]) return matches[0];
  return missingIsLocal ? null : undefined;
}

function resolveStringUpload(value: string, lookup: UploadLookup) {
  const raw = value.trim();
  const exact = oneUpload(lookup.byUrl.get(raw) ?? [], false);
  if (exact) return exact;
  const locator = localStorageLocator(raw);
  if (!locator) return undefined;
  return locator.bucket
    ? oneUpload(lookup.byBucketKey.get(uploadLookupKey(locator.bucket, locator.key)) ?? [], true)
    : oneUpload(lookup.byKey.get(locator.key) ?? [], true);
}

function marker(fileId: string) {
  return `${FILE_MARKER_PREFIX}${fileId}`;
}

function markerId(value: unknown) {
  return typeof value === 'string' ? FILE_MARKER.exec(value)?.[1] : undefined;
}

function blockScope(type: string) {
  if (type === 'image') return 'blocks/images';
  if (type === 'video') return 'blocks/videos';
  if (type === 'audio') return 'blocks/audio';
  return 'blocks/files';
}

function sameOwner(left: FileOwner, right: FileOwner) {
  return left.scope === right.scope
    && left.pageId === right.pageId
    && left.blockId === right.blockId
    && left.databaseId === right.databaseId
    && left.propertyId === right.propertyId
    && left.templateId === right.templateId
    && left.commentId === right.commentId;
}

function assertSourceOwner(upload: FileUpload, owner: FileOwner) {
  const mismatch = (actual: unknown, expected: unknown) => {
    const normalized = optionalString(actual);
    return normalized !== undefined && normalized !== expected;
  };
  if (upload.workspaceId === '' || upload.status !== 'uploaded') {
    throw archiveError(`file ${upload.id} is not a complete workspace upload.`);
  }
  if (mismatch(upload.pageId, owner.pageId)
    || mismatch(upload.blockId, owner.blockId)
    || mismatch(upload.databaseId, owner.databaseId)
    || mismatch(upload.propertyId, owner.propertyId)
    || mismatch(upload.templateId, owner.templateId)
    || mismatch(upload.commentId, owner.commentId)) {
    throw archiveError(`file ${upload.id} belongs to a different content owner.`);
  }
  if (owner.blockId && upload.blockId !== owner.blockId) {
    throw archiveError(`file ${upload.id} is outside its referencing block owner.`);
  }
  if (owner.templateId && upload.templateId !== owner.templateId) {
    throw archiveError(`file ${upload.id} is outside its referencing template owner.`);
  }
  if (owner.commentId && upload.commentId !== owner.commentId) {
    throw archiveError(`file ${upload.id} is outside its referencing comment owner.`);
  }
  if (!owner.blockId && !owner.templateId && !owner.commentId && owner.pageId && upload.pageId !== owner.pageId) {
    const legacyDatabaseOwner = owner.databaseId === owner.pageId && upload.databaseId === owner.pageId;
    if (!legacyDatabaseOwner) throw archiveError(`file ${upload.id} is outside its referencing page owner.`);
  }
  const bytes = exactInteger(upload.size ?? 0, `file ${upload.id} size`);
  if (bytes > NATIVE_ARCHIVE_LIMITS.maxFileBytes) throw archiveError(`file ${upload.id} exceeds the per-file limit.`, 413);
  boundedString(upload.key, `file ${upload.id} key`, 1_024);
}

function safeFileName(upload: FileUpload) {
  return (optionalString(upload.name) ?? 'Untitled')
    .replace(CONTROL_CHARS, '')
    .slice(0, 180) || 'Untitled';
}

function safeContentType(upload: FileUpload) {
  const value = optionalString(upload.contentType) ?? 'application/octet-stream';
  if (value.length > 128 || CONTROL_CHARS.test(value)) throw archiveError(`file ${upload.id} content type is invalid.`);
  return value;
}

function safeScope(upload: FileUpload, owner: FileOwner) {
  const source = optionalString(upload.scope);
  const scope = source && ALLOWED_SCOPES.has(source) ? source : owner.scope;
  if (!ALLOWED_SCOPES.has(scope)) throw archiveError(`file ${upload.id} scope is not allowed.`);
  if (owner.scope !== 'uploads' && scope !== owner.scope) {
    throw archiveError(`file ${upload.id} scope does not match its content owner.`);
  }
  return scope;
}

export function buildNativeArchiveDocument(
  sourceDocument: NativeExportEnvelope,
  uploads: FileUpload[],
): { document: NativeArchiveDocument; files: NativeArchivePlannedFile[] } {
  if (sourceDocument.source?.workspaceId === undefined) throw archiveError('source workspace is required.');
  if (uploads.length > NATIVE_ARCHIVE_LIMITS.maxInventoryItems) {
    throw archiveError('the workspace upload inventory is too large.', 413);
  }
  const sanitized = sanitizeNativeEntitiesForExport(sourceDocument.entities);
  const entities = cloneJson(sanitized.entities);
  const lookup = buildUploadLookup(uploads.filter((upload) => upload.workspaceId === sourceDocument.source.workspaceId));
  const fileByUploadId = new Map<string, NativeArchivePlannedFile>();
  const ownerByUploadId = new Map<string, FileOwner>();
  let includedReferences = 0;
  let totalBytes = 0;

  const planFor = (upload: FileUpload, owner: FileOwner) => {
    assertSourceOwner(upload, owner);
    const priorOwner = ownerByUploadId.get(upload.id);
    if (priorOwner && !sameOwner(priorOwner, owner)) {
      throw archiveError(`file ${upload.id} is shared by incompatible content owners.`);
    }
    ownerByUploadId.set(upload.id, owner);
    const existing = fileByUploadId.get(upload.id);
    if (existing) return existing;
    if (fileByUploadId.size >= NATIVE_ARCHIVE_LIMITS.maxFiles) {
      throw archiveError(`archives are limited to ${NATIVE_ARCHIVE_LIMITS.maxFiles} files.`, 413);
    }
    const bytes = exactInteger(upload.size ?? 0, `file ${upload.id} size`);
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > NATIVE_ARCHIVE_LIMITS.maxTotalFileBytes) {
      throw archiveError('the archive exceeds the total file byte limit.', 413);
    }
    const id = `file-${String(fileByUploadId.size + 1).padStart(6, '0')}`;
    const planned: NativeArchivePlannedFile = {
      entry: {
        id,
        path: `files/${id}`,
        name: safeFileName(upload),
        contentType: safeContentType(upload),
        scope: safeScope(upload, owner),
        bytes,
      },
      source: upload,
    };
    fileByUploadId.set(upload.id, planned);
    return planned;
  };

  const resolvedRecordUpload = (record: Record<string, unknown>) => {
    const matches = new Map<string, FileUpload>();
    let hasId = false;
    for (const field of ID_FIELDS) {
      const id = optionalString(record[field]);
      if (!id) continue;
      hasId = true;
      const upload = lookup.byId.get(id);
      if (!upload) throw archiveError(`file upload id ${id} was not found in the workspace inventory.`);
      matches.set(upload.id, upload);
    }
    for (const field of LOCATOR_FIELDS) {
      const raw = optionalString(record[field]);
      if (!raw) continue;
      const upload = resolveStringUpload(raw, lookup);
      if (upload === null) throw archiveError('a local file locator has no tracked upload.');
      if (hasId && upload === undefined) throw archiveError('a file upload id has a non-matching locator.');
      if (upload) matches.set(upload.id, upload);
    }
    if (matches.size > 1) throw archiveError('a file record resolves to more than one upload.');
    return matches.values().next().value as FileUpload | undefined;
  };

  const overlay = (
    raw: unknown,
    safe: unknown,
    owner: FileOwner,
    directString = false,
    depth = 0,
  ): unknown => {
    if (depth > 128) throw archiveError('file reference nesting is too deep.');
    if (typeof raw === 'string') {
      if (!directString) return safe;
      const upload = resolveStringUpload(raw, lookup);
      if (upload === null) throw archiveError('a local file locator has no tracked upload.');
      if (!upload) return safe;
      includedReferences += 1;
      return marker(planFor(upload, owner).entry.id);
    }
    if (Array.isArray(raw)) {
      const safeItems = Array.isArray(safe) ? safe : [];
      return raw.map((item, index) => overlay(item, safeItems[index], owner, directString, depth + 1));
    }
    if (!isRecord(raw)) return safe;

    const upload = resolvedRecordUpload(raw);
    if (upload) {
      includedReferences += 1;
      const fileMarker = marker(planFor(upload, owner).entry.id);
      const redacted = redactNativeExportValue(raw).value;
      const next = isRecord(redacted) ? cloneJson(redacted) : {};
      delete next.strippedFile;
      delete next.etag;
      delete next.bucket;
      for (const field of ID_FIELDS) if (field in raw) next[field] = fileMarker;
      for (const field of LOCATOR_FIELDS) if (field in raw) next[field] = fileMarker;
      for (const [field, child] of Object.entries(raw)) {
        if (ID_FIELDS.has(field) || LOCATOR_FIELDS.has(field) || field === 'bucket' || field === 'etag') continue;
        if (field in next) next[field] = overlay(child, next[field], owner, false, depth + 1);
      }
      return next;
    }

    // Preserve the sanitizer's shape and recurse only through fields it kept.
    // A stripped unknown/external file reference therefore stays a friendly
    // placeholder instead of recovering a source locator.
    if (!isRecord(safe)) return safe;
    const next = cloneJson(safe);
    for (const [field, child] of Object.entries(raw)) {
      if (!(field in next)) continue;
      next[field] = overlay(child, next[field], owner, false, depth + 1);
    }
    return next;
  };

  const propertiesByDatabase = new Map<string, Map<string, string>>();
  for (const property of sourceDocument.entities.dbProperties) {
    const types = propertiesByDatabase.get(property.databaseId) ?? new Map<string, string>();
    types.set(property.id, property.type);
    propertiesByDatabase.set(property.databaseId, types);
  }
  const safePages = new Map(entities.pages.map((page) => [page.id, page]));
  for (const raw of sourceDocument.entities.pages) {
    const safe = safePages.get(raw.id);
    if (!safe) continue;
    const databaseId = raw.parentType === 'database' ? optionalString(raw.parentId) : undefined;
    if (raw.iconType === 'image' && typeof raw.icon === 'string') {
      const restored = overlay(raw.icon, safe.icon, { entityId: raw.id, pageId: raw.id, databaseId, scope: 'icons' }, true);
      if (markerId(restored)) {
        safe.icon = restored as string;
        safe.iconType = 'image';
      }
    }
    if (typeof raw.cover === 'string') {
      const restored = overlay(raw.cover, safe.cover, { entityId: raw.id, pageId: raw.id, databaseId, scope: 'covers' }, true);
      if (markerId(restored)) safe.cover = restored as string;
    }
    if (isRecord(raw.properties) && isRecord(safe.properties) && databaseId) {
      const types = propertiesByDatabase.get(databaseId);
      for (const [propertyId, rawValue] of Object.entries(raw.properties)) {
        if (types?.get(propertyId) !== 'files') continue;
        safe.properties[propertyId] = overlay(
          rawValue,
          safe.properties[propertyId],
          { entityId: raw.id, pageId: raw.id, databaseId, propertyId, scope: 'database/files' },
          true,
        );
      }
    }
  }

  const safeBlocks = new Map(entities.blocks.map((block) => [block.id, block]));
  for (const raw of sourceDocument.entities.blocks) {
    const safe = safeBlocks.get(raw.id);
    if (!safe) continue;
    safe.content = overlay(
      raw.content,
      safe.content,
      { entityId: raw.id, pageId: raw.pageId, blockId: raw.id, scope: blockScope(raw.type) },
    ) as typeof safe.content;
  }

  const overlayTemplateBlocks = (
    rawBlocks: unknown,
    safeBlocksValue: unknown,
    templateId: string,
    databaseId: string,
  ): unknown[] => {
    if (!Array.isArray(rawBlocks)) return Array.isArray(safeBlocksValue) ? safeBlocksValue : [];
    const safeItems = Array.isArray(safeBlocksValue) ? safeBlocksValue : [];
    return rawBlocks.map((rawBlock, index) => {
      if (!isRecord(rawBlock)) return safeItems[index];
      const safeBlock = isRecord(safeItems[index]) ? cloneJson(safeItems[index]) : {};
      const type = optionalString(rawBlock.type) ?? '';
      safeBlock.content = overlay(
        rawBlock.content,
        safeBlock.content,
        { entityId: templateId, templateId, databaseId, scope: blockScope(type) },
      );
      if (Array.isArray(rawBlock.children)) {
        safeBlock.children = overlayTemplateBlocks(rawBlock.children, safeBlock.children, templateId, databaseId);
      }
      return safeBlock;
    });
  };
  const safeTemplates = new Map(entities.dbTemplates.map((template) => [template.id, template]));
  for (const raw of sourceDocument.entities.dbTemplates) {
    const safe = safeTemplates.get(raw.id);
    if (!safe) continue;
    if (typeof raw.icon === 'string') {
      const restored = overlay(raw.icon, safe.icon, { entityId: raw.id, templateId: raw.id, databaseId: raw.databaseId, scope: 'icons' }, true);
      if (markerId(restored)) safe.icon = restored as string;
    }
    if (isRecord(raw.properties) && isRecord(safe.properties)) {
      const types = propertiesByDatabase.get(raw.databaseId);
      for (const [propertyId, rawValue] of Object.entries(raw.properties)) {
        if (types?.get(propertyId) !== 'files') continue;
        safe.properties[propertyId] = overlay(
          rawValue,
          safe.properties[propertyId],
          { entityId: raw.id, templateId: raw.id, databaseId: raw.databaseId, propertyId, scope: 'database/files' },
          true,
        );
      }
    }
    safe.blocks = overlayTemplateBlocks(raw.blocks, safe.blocks, raw.id, raw.databaseId);
  }

  const safeComments = new Map(entities.comments.map((comment) => [comment.id, comment]));
  for (const raw of sourceDocument.entities.comments) {
    const safe = safeComments.get(raw.id);
    if (!safe) continue;
    safe.body = overlay(
      raw.body,
      safe.body,
      { entityId: raw.id, pageId: raw.pageId, commentId: raw.id, scope: 'uploads' },
    ) as typeof safe.body;
  }

  const strippedReferences = Math.max(0, sanitized.strippedReferences - includedReferences);
  const warnings = strippedReferences === 0
    ? sanitized.warnings.filter((warning) => !['stripped_file', 'stripped_image_icon', 'stripped_cover'].includes(warning.code))
    : sanitized.warnings;
  const document: NativeArchiveDocument = {
    format: NATIVE_ARCHIVE_FORMAT,
    formatVersion: NATIVE_ARCHIVE_FORMAT_VERSION,
    generatedAt: sourceDocument.generatedAt,
    app: sourceDocument.app,
    scope: cloneJson(sourceDocument.scope),
    source: cloneJson(sourceDocument.source),
    counts: cloneJson(sourceDocument.counts),
    files: { included: true, count: fileByUploadId.size, strippedReferences },
    entities,
    relationPairs: cloneJson(sourceDocument.relationPairs),
    warnings: [...cloneJson(sourceDocument.warnings), ...warnings] as NativeWarning[],
  };
  validateNativeArchiveDocument(document);
  return { document, files: [...fileByUploadId.values()] };
}

export function validateNativeArchiveDocument(value: unknown): NativeArchiveDocument {
  canonicalJsonBytes(value, NATIVE_ARCHIVE_LIMITS.maxDocumentBytes, 'document');
  if (!isRecord(value)) throw archiveError('document must be an object.');
  if (value.format !== NATIVE_ARCHIVE_FORMAT || value.formatVersion !== NATIVE_ARCHIVE_FORMAT_VERSION) {
    throw archiveError('document format or version is unsupported.');
  }
  if (!isRecord(value.files) || value.files.included !== true) throw archiveError('document must declare included files.');
  const count = exactInteger(value.files.count, 'document file count');
  if (count > NATIVE_ARCHIVE_LIMITS.maxFiles) throw archiveError('document file count exceeds the limit.', 413);
  exactInteger(value.files.strippedReferences, 'document stripped reference count');
  const compatibility = cloneJson(value) as Record<string, unknown>;
  compatibility.format = NATIVE_FORMAT;
  compatibility.files = { included: false, strippedReferences: value.files.strippedReferences };
  validateNativeEnvelope(compatibility, { ...NATIVE_DOCUMENT_LIMITS, maxBytes: NATIVE_ARCHIVE_LIMITS.maxDocumentBytes });
  return value as unknown as NativeArchiveDocument;
}

function countAllMarkers(value: unknown) {
  let count = 0;
  const stack = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === 'string') {
      if (next.includes(FILE_MARKER_PREFIX)) count += 1;
      continue;
    }
    if (Array.isArray(next)) stack.push(...next);
    else if (isRecord(next)) stack.push(...Object.values(next));
  }
  return count;
}

function assertNoUnboundArchiveStorageReferences(value: unknown) {
  const stack: Array<{ value: unknown; field?: string }> = [{ value }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current.value === 'string') {
      if (markerId(current.value)) continue;
      if (current.value.includes(FILE_MARKER_PREFIX)) throw archiveError('a file marker is malformed.');
      const raw = current.value.trim();
      let local = raw.startsWith('workspaces/') || raw.startsWith('/api/storage/');
      if (!local && /^https?:\/\//i.test(raw)) {
        try {
          local = new URL(raw).pathname.startsWith('/api/storage/');
        } catch {
          // Structural string validation reports malformed URLs only when they
          // occupy an actual file locator field below.
        }
      }
      if (local || (current.field && ID_FIELDS.has(current.field))) {
        throw archiveError('document contains an unbound local storage reference.');
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child });
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [field, child] of Object.entries(current.value)) stack.push({ value: child, field });
  }
}

function transformArchiveReferences(
  source: NativeEntities,
  targets?: Map<string, NativeArchiveFileTarget>,
): { entities: NativeEntities; bindings: NativeArchiveBinding[]; markerCount: number } {
  const entities = cloneJson(source);
  const bindingByFile = new Map<string, NativeArchiveBinding>();
  let markerCount = 0;
  const register = (fileId: string, owner: FileOwner) => {
    const current: NativeArchiveBinding = {
      fileId,
      scope: owner.scope,
      source: {
        pageId: owner.pageId,
        blockId: owner.blockId,
        databaseId: owner.databaseId,
        propertyId: owner.propertyId,
        templateId: owner.templateId,
        commentId: owner.commentId,
      },
    };
    const prior = bindingByFile.get(fileId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(current)) {
      throw archiveError(`file ${fileId} is bound to incompatible content owners.`);
    }
    bindingByFile.set(fileId, current);
  };
  const replacement = (fileId: string, kind: 'id' | 'key' | 'url') => {
    const target = targets?.get(fileId);
    if (!targets) return marker(fileId);
    if (!target) throw archiveError(`file ${fileId} has no staged target.`);
    return kind === 'id' ? target.id : kind === 'key' ? target.key : target.url;
  };
  const transform = (value: unknown, owner: FileOwner, direct = false, depth = 0): unknown => {
    if (depth > 128) throw archiveError('file marker nesting is too deep.');
    if (typeof value === 'string') {
      const fileId = markerId(value);
      if (!fileId) return value;
      if (!direct) throw archiveError(`file marker ${fileId} appears outside a file locator.`);
      markerCount += 1;
      register(fileId, owner);
      return replacement(fileId, 'url');
    }
    if (Array.isArray(value)) return value.map((item) => transform(item, owner, direct, depth + 1));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(value)) {
      const fileId = markerId(child);
      if (fileId) {
        const kind = ID_FIELDS.has(field) ? 'id' : KEY_FIELDS.has(field) ? 'key' : URL_FIELDS.has(field) ? 'url' : null;
        if (!kind) throw archiveError(`file marker ${fileId} appears in unsupported field ${field}.`);
        markerCount += 1;
        register(fileId, owner);
        out[field] = replacement(fileId, kind);
      } else {
        out[field] = transform(child, owner, false, depth + 1);
      }
    }
    return out;
  };

  const propsByDb = new Map<string, Map<string, string>>();
  for (const property of entities.dbProperties) {
    const types = propsByDb.get(property.databaseId) ?? new Map<string, string>();
    types.set(property.id, property.type);
    propsByDb.set(property.databaseId, types);
  }
  for (const page of entities.pages) {
    const databaseId = page.parentType === 'database' ? optionalString(page.parentId) : undefined;
    if (page.iconType === 'image') page.icon = transform(page.icon, { entityId: page.id, pageId: page.id, databaseId, scope: 'icons' }, true) as string;
    page.cover = transform(page.cover, { entityId: page.id, pageId: page.id, databaseId, scope: 'covers' }, true) as string | undefined;
    if (isRecord(page.properties) && databaseId) {
      for (const [propertyId, value] of Object.entries(page.properties)) {
        if (propsByDb.get(databaseId)?.get(propertyId) !== 'files') continue;
        page.properties[propertyId] = transform(value, {
          entityId: page.id, pageId: page.id, databaseId, propertyId, scope: 'database/files',
        }, true);
      }
    }
  }
  for (const block of entities.blocks) {
    block.content = transform(block.content, {
      entityId: block.id, pageId: block.pageId, blockId: block.id, scope: blockScope(block.type),
    }) as typeof block.content;
  }
  const transformTemplateBlocks = (blocks: unknown, templateId: string, databaseId: string): unknown[] => {
    if (!Array.isArray(blocks)) return [];
    return blocks.map((block) => {
      if (!isRecord(block)) return block;
      const out = cloneJson(block);
      const type = optionalString(out.type) ?? '';
      out.content = transform(out.content, { entityId: templateId, templateId, databaseId, scope: blockScope(type) });
      if (Array.isArray(out.children)) out.children = transformTemplateBlocks(out.children, templateId, databaseId);
      return out;
    });
  };
  for (const template of entities.dbTemplates) {
    template.icon = transform(template.icon, {
      entityId: template.id, templateId: template.id, databaseId: template.databaseId, scope: 'icons',
    }, true) as string | undefined;
    if (isRecord(template.properties)) {
      for (const [propertyId, value] of Object.entries(template.properties)) {
        if (propsByDb.get(template.databaseId)?.get(propertyId) !== 'files') continue;
        template.properties[propertyId] = transform(value, {
          entityId: template.id,
          templateId: template.id,
          databaseId: template.databaseId,
          propertyId,
          scope: 'database/files',
        }, true);
      }
    }
    template.blocks = transformTemplateBlocks(template.blocks, template.id, template.databaseId);
  }
  for (const comment of entities.comments) {
    comment.body = transform(comment.body, {
      entityId: comment.id, pageId: comment.pageId, commentId: comment.id, scope: 'uploads',
    }) as typeof comment.body;
  }
  return { entities, bindings: [...bindingByFile.values()], markerCount };
}

export function restoreNativeArchiveFileReferences(
  entities: NativeEntities,
  targets: Map<string, NativeArchiveFileTarget>,
) {
  const totalMarkers = countAllMarkers(entities);
  const restored = transformArchiveReferences(entities, targets);
  if (totalMarkers !== restored.markerCount) throw archiveError('one or more file markers are outside supported file fields.');
  for (const fileId of targets.keys()) {
    if (!restored.bindings.some((binding) => binding.fileId === fileId)) {
      throw archiveError(`staged file ${fileId} is not referenced by the document.`);
    }
  }
  return { entities: restored.entities, bindings: restored.bindings };
}

export async function sha256HexBytes(bytes: Uint8Array) {
  return bytesToHex(sha256(bytes));
}

export async function sha256HexStream(stream: ReadableStream<Uint8Array>, expectedBytes: number) {
  const hash = sha256.create();
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw archiveError('a stored object returned a non-byte stream chunk.');
      bytes += next.value.byteLength;
      if (bytes > expectedBytes || bytes > NATIVE_ARCHIVE_LIMITS.maxFileBytes) {
        throw archiveError('a stored object exceeded its declared byte length.');
      }
      hash.update(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (bytes !== expectedBytes) throw archiveError('a stored object did not match its declared byte length.');
  return bytesToHex(hash.digest());
}

export async function validateNativeArchiveBundle(
  documentValue: unknown,
  manifestValue: unknown,
): Promise<{ document: NativeArchiveDocument; manifest: NativeArchiveManifest; bindings: NativeArchiveBinding[] }> {
  const document = validateNativeArchiveDocument(documentValue);
  canonicalJsonBytes(manifestValue, NATIVE_ARCHIVE_LIMITS.maxManifestBytes, 'manifest');
  if (!isRecord(manifestValue)) throw archiveError('manifest must be an object.');
  if (manifestValue.format !== NATIVE_ARCHIVE_FORMAT || manifestValue.formatVersion !== NATIVE_ARCHIVE_FORMAT_VERSION) {
    throw archiveError('manifest format or version is unsupported.');
  }
  if (!isRecord(manifestValue.document)) throw archiveError('manifest document descriptor is required.');
  if (manifestValue.document.path !== NATIVE_ARCHIVE_DOCUMENT_PATH) throw archiveError('manifest document path is invalid.');
  const documentBytes = canonicalJsonBytes(document, NATIVE_ARCHIVE_LIMITS.maxDocumentBytes, 'document');
  const declaredDocumentBytes = exactInteger(manifestValue.document.bytes, 'manifest document bytes');
  if (declaredDocumentBytes !== documentBytes.byteLength) throw archiveError('document byte length does not match the manifest.');
  const documentDigest = boundedString(manifestValue.document.sha256, 'manifest document digest', 64);
  if (!SHA256_HEX.test(documentDigest) || documentDigest !== await sha256HexBytes(documentBytes)) {
    throw archiveError('document digest does not match the manifest.');
  }
  if (!Array.isArray(manifestValue.files)) throw archiveError('manifest files must be an array.');
  if (manifestValue.files.length > NATIVE_ARCHIVE_LIMITS.maxFiles) throw archiveError('manifest file count exceeds the limit.', 413);
  const ids = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = manifestValue.files.map((value, index): NativeArchiveFileEntry => {
    if (!isRecord(value)) throw archiveError(`manifest file ${index} must be an object.`);
    const id = boundedString(value.id, `manifest file ${index} id`, 32);
    if (!FILE_ID.test(id)) throw archiveError(`manifest file ${index} id is invalid.`);
    const path = boundedString(value.path, `manifest file ${index} path`, NATIVE_ARCHIVE_LIMITS.maxPathBytes);
    if (path !== `files/${id}` || path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      throw archiveError(`manifest file ${index} path is invalid.`);
    }
    if (ids.has(id) || paths.has(path)) throw archiveError('manifest contains a duplicate file id or path.');
    ids.add(id);
    paths.add(path);
    const name = boundedString(value.name, `manifest file ${index} name`, 180);
    const contentType = boundedString(value.contentType, `manifest file ${index} content type`, 128);
    const scope = boundedString(value.scope, `manifest file ${index} scope`, 64);
    if (!ALLOWED_SCOPES.has(scope)) throw archiveError(`manifest file ${index} scope is not allowed.`);
    const bytes = exactInteger(value.bytes, `manifest file ${index} bytes`);
    if (bytes > NATIVE_ARCHIVE_LIMITS.maxFileBytes) throw archiveError(`manifest file ${index} exceeds the per-file limit.`, 413);
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > NATIVE_ARCHIVE_LIMITS.maxTotalFileBytes) {
      throw archiveError('manifest exceeds the total file byte limit.', 413);
    }
    const digest = boundedString(value.sha256, `manifest file ${index} digest`, 64);
    if (!SHA256_HEX.test(digest)) throw archiveError(`manifest file ${index} digest is invalid.`);
    return { id, path, name, contentType, scope, bytes, sha256: digest };
  });
  if (!isRecord(manifestValue.totals)) throw archiveError('manifest totals are required.');
  if (exactInteger(manifestValue.totals.files, 'manifest total files') !== files.length
    || exactInteger(manifestValue.totals.fileBytes, 'manifest total bytes') !== totalBytes) {
    throw archiveError('manifest totals do not match its files.');
  }
  if (document.files.count !== files.length) throw archiveError('document and manifest file counts do not match.');
  assertNoUnboundArchiveStorageReferences(document.entities);
  const transformed = transformArchiveReferences(document.entities);
  const allMarkers = countAllMarkers(document.entities);
  if (allMarkers !== transformed.markerCount) throw archiveError('one or more file markers are outside supported file fields.');
  const markerIds = new Set(transformed.bindings.map((binding) => binding.fileId));
  if (markerIds.size !== ids.size || [...markerIds].some((id) => !ids.has(id))) {
    throw archiveError('document file markers do not exactly match the manifest.');
  }
  for (const binding of transformed.bindings) {
    const file = files.find((candidate) => candidate.id === binding.fileId)!;
    if (binding.scope !== 'uploads' && binding.scope !== file.scope) {
      throw archiveError(`file ${file.id} scope does not match its document binding.`);
    }
  }
  return { document, manifest: manifestValue as unknown as NativeArchiveManifest, bindings: transformed.bindings };
}

let crcTable: Uint32Array | undefined;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

class Crc32 {
  private value = 0xffffffff;
  update(bytes: Uint8Array) {
    const table = getCrcTable();
    for (const byte of bytes) this.value = (this.value >>> 8) ^ table[(this.value ^ byte) & 0xff];
  }
  digest() {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

function writeU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

interface CentralEntry {
  name: Uint8Array;
  flags: number;
  crc: number;
  bytes: number;
  offset: number;
}

function localHeader(name: Uint8Array, flags: number, crc: number, bytes: number) {
  const out = new Uint8Array(30 + name.byteLength);
  const view = new DataView(out.buffer);
  writeU32(view, 0, 0x04034b50);
  writeU16(view, 4, 20);
  writeU16(view, 6, flags);
  writeU16(view, 8, 0);
  writeU32(view, 14, crc);
  writeU32(view, 18, bytes);
  writeU32(view, 22, bytes);
  writeU16(view, 26, name.byteLength);
  out.set(name, 30);
  return out;
}

function dataDescriptor(crc: number, bytes: number) {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  writeU32(view, 0, 0x08074b50);
  writeU32(view, 4, crc);
  writeU32(view, 8, bytes);
  writeU32(view, 12, bytes);
  return out;
}

function centralHeader(entry: CentralEntry) {
  const out = new Uint8Array(46 + entry.name.byteLength);
  const view = new DataView(out.buffer);
  writeU32(view, 0, 0x02014b50);
  writeU16(view, 4, 20);
  writeU16(view, 6, 20);
  writeU16(view, 8, entry.flags);
  writeU16(view, 10, 0);
  writeU32(view, 16, entry.crc);
  writeU32(view, 20, entry.bytes);
  writeU32(view, 24, entry.bytes);
  writeU16(view, 28, entry.name.byteLength);
  writeU32(view, 42, entry.offset);
  out.set(entry.name, 46);
  return out;
}

function endOfCentralDirectory(entries: number, centralBytes: number, centralOffset: number) {
  const out = new Uint8Array(22);
  const view = new DataView(out.buffer);
  writeU32(view, 0, 0x06054b50);
  writeU16(view, 8, entries);
  writeU16(view, 10, entries);
  writeU32(view, 12, centralBytes);
  writeU32(view, 16, centralOffset);
  return out;
}

export function createNativeArchiveStream(input: {
  document: NativeArchiveDocument;
  files: NativeArchiveWritableFile[];
}): ReadableStream<Uint8Array> {
  const document = validateNativeArchiveDocument(input.document);
  if (input.files.length !== document.files.count || input.files.length > NATIVE_ARCHIVE_LIMITS.maxFiles) {
    throw archiveError('stream file count does not match the document.');
  }
  const ids = new Set<string>();
  let declaredTotal = 0;
  for (const file of input.files) {
    if (!FILE_ID.test(file.id) || file.path !== `files/${file.id}` || ids.has(file.id)) {
      throw archiveError('stream file ids and paths must be unique and canonical.');
    }
    ids.add(file.id);
    declaredTotal += exactInteger(file.bytes, `stream file ${file.id} bytes`);
    if (file.bytes > NATIVE_ARCHIVE_LIMITS.maxFileBytes || declaredTotal > NATIVE_ARCHIVE_LIMITS.maxTotalFileBytes) {
      throw archiveError('stream files exceed archive byte limits.', 413);
    }
  }

  async function* generate() {
    let offset = 0;
    const central: CentralEntry[] = [];
    const emit = (bytes: Uint8Array) => {
      offset += bytes.byteLength;
      if (offset > NATIVE_ARCHIVE_LIMITS.maxArchiveBytes) throw archiveError('archive output exceeds the byte limit.', 413);
      return bytes;
    };
    const writeStatic = async function* (nameText: string, bytes: Uint8Array) {
      const name = encoder.encode(nameText);
      const crc = new Crc32();
      crc.update(bytes);
      const entry: CentralEntry = { name, flags: 0x0800, crc: crc.digest(), bytes: bytes.byteLength, offset };
      yield emit(localHeader(name, entry.flags, entry.crc, entry.bytes));
      yield emit(bytes);
      central.push(entry);
    };

    const documentBytes = canonicalJsonBytes(document, NATIVE_ARCHIVE_LIMITS.maxDocumentBytes, 'document');
    yield* writeStatic(NATIVE_ARCHIVE_DOCUMENT_PATH, documentBytes);
    const manifestFiles: NativeArchiveFileEntry[] = [];

    for (const file of input.files) {
      const name = encoder.encode(file.path);
      const flags = 0x0808;
      const entry: CentralEntry = { name, flags, crc: 0, bytes: file.bytes, offset };
      // Size is known from trusted metadata and retained in the local header;
      // bit 3 permits CRC to be completed only after the streamed body.
      yield emit(localHeader(name, flags, 0, file.bytes));
      const hash = sha256.create();
      const crc = new Crc32();
      const body = await file.open();
      const reader = body.getReader();
      let received = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (!(next.value instanceof Uint8Array)) throw archiveError(`file ${file.id} returned a non-byte chunk.`);
          received += next.value.byteLength;
          if (received > file.bytes || received > NATIVE_ARCHIVE_LIMITS.maxFileBytes) {
            throw archiveError(`file ${file.id} exceeded its declared byte length.`);
          }
          hash.update(next.value);
          crc.update(next.value);
          yield emit(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (received !== file.bytes) throw archiveError(`file ${file.id} did not match its declared byte length.`);
      entry.crc = crc.digest();
      yield emit(dataDescriptor(entry.crc, entry.bytes));
      central.push(entry);
      manifestFiles.push({
        id: file.id,
        path: file.path,
        name: file.name,
        contentType: file.contentType,
        scope: file.scope,
        bytes: file.bytes,
        sha256: bytesToHex(hash.digest()),
      });
    }

    const manifest: NativeArchiveManifest = {
      format: NATIVE_ARCHIVE_FORMAT,
      formatVersion: NATIVE_ARCHIVE_FORMAT_VERSION,
      generatedAt: document.generatedAt,
      document: {
        path: NATIVE_ARCHIVE_DOCUMENT_PATH,
        bytes: documentBytes.byteLength,
        sha256: await sha256HexBytes(documentBytes),
      },
      files: manifestFiles,
      totals: { files: manifestFiles.length, fileBytes: declaredTotal },
    };
    await validateNativeArchiveBundle(document, manifest);
    yield* writeStatic(NATIVE_ARCHIVE_MANIFEST_PATH, canonicalJsonBytes(manifest, NATIVE_ARCHIVE_LIMITS.maxManifestBytes, 'manifest'));
    const centralOffset = offset;
    let centralBytes = 0;
    for (const entry of central) {
      const bytes = centralHeader(entry);
      centralBytes += bytes.byteLength;
      yield emit(bytes);
    }
    yield emit(endOfCentralDirectory(central.length, centralBytes, centralOffset));
  }

  const iterator = generate();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export function nativeArchiveFileName(stem: string, at = new Date()) {
  const safe = stem
    .replace(/[\\/:*?"<>|#\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'hanji';
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${safe}-${date}.hanji.zip`;
}

export function archiveDocumentJson(document: NativeArchiveDocument) {
  return decoder.decode(canonicalJsonBytes(document, NATIVE_ARCHIVE_LIMITS.maxDocumentBytes, 'document'));
}

export function nativeArchiveRelationPairs(document: NativeArchiveDocument): RelationPair[] {
  return cloneJson(document.relationPairs);
}
