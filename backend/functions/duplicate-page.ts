import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { boundedDbFromPageHint, ensurePageWorkspaceIndex, type AdminDbAccessor } from '../lib/workspace-db';
import { assertSafeStoredFileType, normalizeFileContentType } from '../lib/file-security';
import {
  assertFileTargetsNotDeleting,
  withFileWorkspaceLease,
  type FileWorkspaceLeaseGuard,
} from '../lib/file-operation-lock';
import {
  releaseOrganizationStorage,
  reserveOrganizationStorage,
  type StorageQuotaReservation,
} from '../lib/storage-quota';
import {
  duplicatePageRecoveryData,
  type DuplicatePageRecoveryData,
} from '../lib/duplicate-page-recovery';
import {
  parsePersistentGeneratedLocale,
  persistentGeneratedLabels,
} from '../lib/persistent-generated-labels';
import {
  assertMinimumWorkspaceAccessRole as sharedAssertMinimumWorkspaceAccessRole,
  pageAccessRole as sharedPageAccessRole,
  pageAccessRoleRanks as roleRanks,
  type ShareRole,
} from '../lib/page-access';
import { hasPotentialStoredFileReference } from '../lib/file-reference-lifecycle';

import {
  bestEffort,
  getExisting,
  listAll,
  nowIso,
  newId,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';
import type {
  Block,
  DbProperty,
  DbRef,
  DbTemplate,
  DbView,
  FileUpload,
  FunctionContext,
  Page,
  PageParentType,
  Workspace,
} from '../lib/app-types';

interface TemplateBlock {
  type: string;
  content?: Record<string, unknown>;
  children?: TemplateBlock[];
  [key: string]: unknown;
}

const parentTypes = new Set<PageParentType>(['workspace', 'page', 'database']);
const FILE_BUCKET = 'files';
const DUPLICATE_FILE_RECOVERY_TTL_MS = 30 * 60 * 1000;
const MAX_FILE_REFERENCE_DEPTH = 128;
const MAX_DUPLICATED_FILES = 100;
const MAX_DUPLICATED_BYTES = 512 * 1024 * 1024;
const MAX_DUPLICATED_BYTES_LABEL = '512 MiB';

interface StoredFileObject {
  body: ReadableStream;
  contentType: string;
  size: number;
  etag: string;
  customMetadata?: Record<string, string>;
}

interface DuplicateStorageProxy {
  bucket?(bucket: string): DuplicateStorageProxy;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: { contentType?: string; customMetadata?: Record<string, string> },
  ): Promise<void>;
  get(key: string): Promise<StoredFileObject | null>;
  head(key: string): Promise<Omit<StoredFileObject, 'body'> | null>;
  delete(key: string): Promise<void>;
}

interface DuplicateFilePlan {
  source: FileUpload;
  target: FileUpload;
  reservation: StorageQuotaReservation | null;
  rowCreated: boolean;
  objectWriteAttempted: boolean;
}

function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request) return {};
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanFileSegment(value: string) {
  return (
    value
      .trim()
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'file'
  );
}

function extensionFromName(name: string) {
  const match = name.match(/\.([a-z0-9]{1,12})$/i);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function storageBucket(storage: DuplicateStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

function storageUrl(request: Request | undefined, bucket: string, key: string) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const path = `/api/storage/${encodeURIComponent(bucket)}/${encodedKey}`;
  return request ? `${new URL(request.url).origin}${path}` : path;
}

function streamChunkBytes(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Stored file stream returned a non-byte chunk.');
}

async function streamsHaveSameBytes(
  left: ReadableStream,
  right: ReadableStream,
  expectedSize: number,
) {
  const leftReader = left.getReader();
  const rightReader = right.getReader();
  let leftChunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let rightChunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let leftOffset = 0;
  let rightOffset = 0;
  let leftDone = false;
  let rightDone = false;
  let compared = 0;
  const refillLeft = async () => {
    while (!leftDone && leftOffset >= leftChunk.byteLength) {
      const next = await leftReader.read();
      leftDone = next.done;
      leftChunk = next.done ? new Uint8Array(0) : streamChunkBytes(next.value);
      leftOffset = 0;
    }
  };
  const refillRight = async () => {
    while (!rightDone && rightOffset >= rightChunk.byteLength) {
      const next = await rightReader.read();
      rightDone = next.done;
      rightChunk = next.done ? new Uint8Array(0) : streamChunkBytes(next.value);
      rightOffset = 0;
    }
  };
  try {
    while (true) {
      await Promise.all([refillLeft(), refillRight()]);
      if (leftDone || rightDone) {
        return leftDone && rightDone && compared === expectedSize;
      }
      const length = Math.min(
        leftChunk.byteLength - leftOffset,
        rightChunk.byteLength - rightOffset,
      );
      for (let index = 0; index < length; index += 1) {
        if (leftChunk[leftOffset + index] !== rightChunk[rightOffset + index]) return false;
      }
      compared += length;
      if (compared > expectedSize) return false;
      leftOffset += length;
      rightOffset += length;
    }
  } finally {
    await Promise.all([
      leftReader.cancel().catch(() => undefined),
      rightReader.cancel().catch(() => undefined),
    ]);
  }
}

function duplicateFileConflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}

function decodeStoragePath(value: string) {
  try {
    return value
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    throw duplicateFileConflict('Page contains a malformed local file reference.');
  }
}

function localStorageLocator(value: string): { bucket?: string; key: string } | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^workspaces\//.test(raw)) {
    if (raw.length > 1_024 || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw duplicateFileConflict('Page contains a malformed local file reference.');
    }
    return { key: raw };
  }
  // Absolute URLs are owner identifiers, not path locators: they are accepted
  // only by the exact `file_uploads.url` lookup above. Parsing arbitrary hosts
  // (or nested `/proxy/api/storage`) by pathname could substitute a private
  // object that merely shares the same key.
  if (!raw.startsWith('/api/storage/')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw, 'http://hanji.local');
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const apiIndex = 0;
  if (segments[0] !== 'api' || segments[1] !== 'storage' || segments.length <= 3) return undefined;
  const bucket = decodeStoragePath(segments[apiIndex + 2]);
  const key = decodeStoragePath(segments.slice(apiIndex + 3).join('/'));
  if (
    !bucket
    || bucket.length > 128
    || !key
    || key.length > 1_024
    || /[\u0000-\u001f\u007f]/.test(`${bucket}${key}`)
  ) {
    throw duplicateFileConflict('Page contains a malformed local file reference.');
  }
  return { bucket, key };
}

function uploadBucket(upload: FileUpload) {
  return optionalString(upload.bucket) ?? FILE_BUCKET;
}

function uploadLookupKey(bucket: string, key: string) {
  return `${bucket}\u0000${key}`;
}

interface UploadLookup {
  byId: Map<string, FileUpload>;
  byBucketKey: Map<string, FileUpload[]>;
  byRawKey: Map<string, FileUpload[]>;
  byUrl: Map<string, FileUpload[]>;
}

function buildUploadLookup(uploads: FileUpload[]): UploadLookup {
  const byId = new Map<string, FileUpload>();
  const byBucketKey = new Map<string, FileUpload[]>();
  const byRawKey = new Map<string, FileUpload[]>();
  const byUrl = new Map<string, FileUpload[]>();
  for (const upload of uploads) {
    byId.set(upload.id, upload);
    const bucket = uploadBucket(upload);
    const key = optionalString(upload.key);
    if (key) {
      const lookupKey = uploadLookupKey(bucket, key);
      const bucketMatches = byBucketKey.get(lookupKey) ?? [];
      bucketMatches.push(upload);
      byBucketKey.set(lookupKey, bucketMatches);
      const matches = byRawKey.get(key) ?? [];
      matches.push(upload);
      byRawKey.set(key, matches);
    }
    const url = optionalString(upload.url);
    if (url) {
      const matches = byUrl.get(url) ?? [];
      matches.push(upload);
      byUrl.set(url, matches);
    }
  }
  return { byId, byBucketKey, byRawKey, byUrl };
}

function resolveLocalStorageString(value: string, lookup: UploadLookup) {
  const exactUrlMatches = lookup.byUrl.get(value.trim()) ?? [];
  if (exactUrlMatches.length > 1) {
    throw duplicateFileConflict('Page contains an ambiguous local file URL.');
  }
  if (exactUrlMatches[0]) return exactUrlMatches[0];
  const locator = localStorageLocator(value);
  if (!locator) return undefined;
  if (locator.bucket) {
    const matches = lookup.byBucketKey.get(uploadLookupKey(locator.bucket, locator.key)) ?? [];
    if (matches.length > 1) throw duplicateFileConflict('Page contains an ambiguous local file reference.');
    return matches[0] ?? null;
  }
  const matches = lookup.byRawKey.get(locator.key) ?? [];
  if (matches.length > 1) throw duplicateFileConflict('Page contains an ambiguous local file reference.');
  return matches[0] ?? null;
}

function addResolvedUpload(
  resolved: FileUpload | null | undefined,
  selected: Map<string, FileUpload>,
  label: string,
) {
  if (resolved === null) throw duplicateFileConflict(`Page contains an untracked local file ${label}.`);
  if (!resolved) return;
  const existing = selected.get(resolved.id);
  if (existing && existing.key !== resolved.key) {
    throw duplicateFileConflict('Page contains inconsistent local file metadata.');
  }
  selected.set(resolved.id, resolved);
}

const FILE_UPLOAD_ID_FIELDS = new Set(['uploadId', 'fileUploadId']);
const FILE_LOCATOR_FIELDS = new Set(['key', 'fileKey', 'storageKey', 'url', 'src', 'href']);

interface FileReferenceValue {
  value: unknown;
  /** The value itself (and scalar array entries) is a file locator, e.g. an icon/cover. */
  directString?: boolean;
}

function collectStoredFileReferences(
  value: unknown,
  lookup: UploadLookup,
  selected: Map<string, FileUpload>,
  directString = false,
  seen = new Set<object>(),
  depth = 0,
) {
  if (depth > MAX_FILE_REFERENCE_DEPTH) {
    throw duplicateFileConflict('Page file reference nesting is too deep.');
  }
  if (typeof value === 'string') {
    if (directString) {
      addResolvedUpload(resolveLocalStorageString(value, lookup), selected, 'URL or key');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStoredFileReferences(item, lookup, selected, directString, seen, depth + 1);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const recordUploads = new Map<string, FileUpload>();
  let hasExplicitUploadId = false;
  for (const field of FILE_UPLOAD_ID_FIELDS) {
    const id = optionalString(record[field]);
    if (!id) continue;
    hasExplicitUploadId = true;
    const resolved = lookup.byId.get(id) ?? null;
    addResolvedUpload(resolved, recordUploads, 'upload id');
  }
  for (const field of FILE_LOCATOR_FIELDS) {
    const raw = optionalString(record[field]);
    if (!raw) continue;
    const resolved = resolveLocalStorageString(raw, lookup);
    if (hasExplicitUploadId && resolved === undefined) {
      throw duplicateFileConflict('Page contains a local file upload id with a non-matching key or URL.');
    }
    addResolvedUpload(resolved, recordUploads, 'URL or key');
  }
  if (recordUploads.size > 1) {
    throw duplicateFileConflict('Page contains a local file reference whose id, key, or URL do not match.');
  }
  for (const upload of recordUploads.values()) selected.set(upload.id, upload);
  for (const [field, child] of Object.entries(record)) {
    if (FILE_UPLOAD_ID_FIELDS.has(field) || FILE_LOCATOR_FIELDS.has(field)) continue;
    // Once inside a structured record, arbitrary strings are prose/metadata.
    // Nested records can still expose their own explicit file-bearing fields.
    collectStoredFileReferences(child, lookup, selected, false, seen, depth + 1);
  }
}

interface FileReferenceHints {
  uploadIds: Set<string>;
  locators: Map<string, { bucket?: string; key: string }>;
  urls: Set<string>;
}

function exactAbsoluteStorageUrlCandidate(value: string) {
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return undefined;
  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[0] === 'api' && segments[1] === 'storage' && segments.length > 3
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

function collectStoredFileReferenceHints(
  value: unknown,
  hints: FileReferenceHints,
  directString = false,
  seen = new Set<object>(),
  depth = 0,
): void {
  if (depth > MAX_FILE_REFERENCE_DEPTH) {
    throw duplicateFileConflict('Page file reference nesting is too deep.');
  }
  if (typeof value === 'string') {
    if (directString) {
      const locator = localStorageLocator(value);
      if (locator) hints.locators.set(uploadLookupKey(locator.bucket ?? '', locator.key), locator);
      const url = exactAbsoluteStorageUrlCandidate(value);
      if (url) hints.urls.add(url);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStoredFileReferenceHints(item, hints, directString, seen, depth + 1);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const field of FILE_UPLOAD_ID_FIELDS) {
    const id = optionalString(record[field]);
    if (id) hints.uploadIds.add(id);
  }
  for (const field of FILE_LOCATOR_FIELDS) {
    const raw = optionalString(record[field]);
    if (!raw) continue;
    const locator = localStorageLocator(raw);
    if (locator) hints.locators.set(uploadLookupKey(locator.bucket ?? '', locator.key), locator);
    const url = exactAbsoluteStorageUrlCandidate(raw);
    if (url) hints.urls.add(url);
  }
  for (const [field, child] of Object.entries(record)) {
    if (FILE_UPLOAD_ID_FIELDS.has(field) || FILE_LOCATOR_FIELDS.has(field)) continue;
    collectStoredFileReferenceHints(child, hints, false, seen, depth + 1);
  }
}

async function loadReferencedUploads(
  db: DbRef,
  workspaceId: string,
  values: FileReferenceValue[],
) {
  const hints: FileReferenceHints = { uploadIds: new Set(), locators: new Map(), urls: new Set() };
  for (const reference of values) {
    collectStoredFileReferenceHints(reference.value, hints, reference.directString === true);
  }
  if (
    hints.uploadIds.size > MAX_DUPLICATED_FILES
    || hints.locators.size > MAX_DUPLICATED_FILES
    || hints.urls.size > MAX_DUPLICATED_FILES
  ) {
    throw Object.assign(
      new Error(`Page duplication is limited to ${MAX_DUPLICATED_FILES} stored files per request.`),
      { status: 413 },
    );
  }

  const uploads = db.table<FileUpload>('file_uploads');
  const loaded = new Map<string, FileUpload>();
  const lookups: Array<() => Promise<FileUpload[]>> = [
    ...Array.from(hints.uploadIds, (id) => async () => {
      const upload = await getExisting(uploads, id);
      return upload ? [upload] : [];
    }),
    ...Array.from(hints.locators.values(), (locator) => async () =>
      listAll(
        uploads.where('key', '==', locator.key),
        { maxItems: 100, pageSize: 100, label: `Duplicate-page file key ${locator.key}` },
      )),
    ...Array.from(hints.urls, (url) => async () =>
      listAll(
        uploads.where('url', '==', url),
        { maxItems: 100, pageSize: 100, label: 'Duplicate-page exact file URL' },
      )),
  ];
  for (let i = 0; i < lookups.length; i += 20) {
    const results = await Promise.all(lookups.slice(i, i + 20).map((lookup) => lookup()));
    for (const upload of results.flat()) {
      if (upload.workspaceId === workspaceId) loaded.set(upload.id, upload);
    }
  }
  return Array.from(loaded.values());
}

function assertUploadBelongsToSubtree(
  upload: FileUpload,
  pageMap: Map<string, string>,
  blockMap: Map<string, string>,
  propertyMap: Map<string, string>,
  templateMap: Map<string, string>,
  owner:
    | { kind: 'page'; pageId: string; databaseId?: string }
    | { kind: 'block'; blockId: string; pageId: string }
    | { kind: 'template'; templateId: string; databaseId: string },
) {
  const associations = [upload.pageId, upload.blockId, upload.databaseId, upload.propertyId, upload.templateId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (associations.length === 0) {
    throw duplicateFileConflict('Page references a workspace-level file that is not owned by the duplicated subtree.');
  }
  if (!upload.pageId && !upload.databaseId && !upload.templateId) {
    throw duplicateFileConflict('Page file metadata has no page or database owner for permanent cleanup.');
  }
  if (upload.pageId && !pageMap.has(upload.pageId)) {
    throw duplicateFileConflict('Page references a file owned by a page outside the duplicated subtree.');
  }
  if (upload.blockId && !blockMap.has(upload.blockId)) {
    throw duplicateFileConflict('Page references a file owned by a block outside the duplicated subtree.');
  }
  if (upload.databaseId && !pageMap.has(upload.databaseId)) {
    throw duplicateFileConflict('Page references a file owned by a database outside the duplicated subtree.');
  }
  if (upload.propertyId && !propertyMap.has(upload.propertyId)) {
    throw duplicateFileConflict('Page references a file owned by a property outside the duplicated subtree.');
  }
  if (upload.templateId && !templateMap.has(upload.templateId)) {
    throw duplicateFileConflict('Page references a file owned by a template outside the duplicated subtree.');
  }
  if (owner.kind === 'template') {
    if (upload.templateId && upload.templateId !== owner.templateId) {
      throw duplicateFileConflict('Page template file metadata points to a different template owner.');
    }
    if (upload.pageId || upload.blockId || upload.propertyId) {
      throw duplicateFileConflict('Page template contains a stored file owned by another content record.');
    }
    if (!upload.databaseId || upload.databaseId !== owner.databaseId) {
      throw duplicateFileConflict('Page template file metadata has no database owner for permanent cleanup.');
    }
  } else {
    if (upload.templateId) {
      throw duplicateFileConflict('Page content references a file owned by a database template.');
    }
    if (owner.kind === 'block') {
      if (upload.blockId !== owner.blockId || upload.pageId !== owner.pageId) {
        throw duplicateFileConflict('Page block file metadata points to a different content owner.');
      }
    } else {
      if (upload.blockId) {
        throw duplicateFileConflict('Page file metadata points to a block instead of its referencing page.');
      }
      const databasePageLegacyOwner = !upload.pageId
        && owner.databaseId === owner.pageId
        && upload.databaseId === owner.pageId;
      if (upload.pageId !== owner.pageId && !databasePageLegacyOwner) {
        throw duplicateFileConflict('Page file metadata points to a different page owner.');
      }
      if (upload.databaseId && upload.databaseId !== owner.databaseId) {
        throw duplicateFileConflict('Page file metadata points to a different database owner.');
      }
    }
  }
  if (upload.status !== 'uploaded') {
    throw duplicateFileConflict('Page contains a file upload that is not complete.');
  }
  if (!optionalString(upload.key)) throw duplicateFileConflict('Page file metadata is missing its storage key.');
}

function targetFileAssociation(sourceId: string | null | undefined, ids: Map<string, string>, label: string) {
  if (!sourceId) return undefined;
  const targetId = ids.get(sourceId);
  if (!targetId) {
    throw duplicateFileConflict(`Page file metadata points to an ${label} outside the duplicated subtree.`);
  }
  return targetId;
}

function buildDuplicateFilePlans(input: {
  uploads: FileUpload[];
  pageMap: Map<string, string>;
  blockMap: Map<string, string>;
  propertyMap: Map<string, string>;
  templateMap: Map<string, string>;
  pageValues: Array<{ pageId: string; databaseId?: string; values: FileReferenceValue[] }>;
  blockValues: Array<{ blockId: string; pageId: string; values: FileReferenceValue[] }>;
  templateValues: Array<{ templateId: string; databaseId: string; values: FileReferenceValue[] }>;
  workspaceId: string;
  actorId: string;
  request?: Request;
}) {
  const lookup = buildUploadLookup(input.uploads);
  const selected = new Map<string, FileUpload>();
  type ReferenceOwner =
    | { kind: 'page'; pageId: string; databaseId?: string; values: FileReferenceValue[] }
    | { kind: 'block'; blockId: string; pageId: string; values: FileReferenceValue[] }
    | { kind: 'template'; templateId: string; databaseId: string; values: FileReferenceValue[] };
  const owners: ReferenceOwner[] = [
    ...input.pageValues.map((owner) => ({ kind: 'page' as const, ...owner })),
    ...input.blockValues.map((owner) => ({ kind: 'block' as const, ...owner })),
    ...input.templateValues.map((owner) => ({ kind: 'template' as const, ...owner })),
  ];
  const ownerByUploadId = new Map<string, ReferenceOwner>();
  for (const owner of owners) {
    const ownerUploads = new Map<string, FileUpload>();
    for (const reference of owner.values) {
      collectStoredFileReferences(
        reference.value,
        lookup,
        ownerUploads,
        reference.directString === true,
      );
    }
    for (const [uploadId, upload] of ownerUploads) {
      const priorOwner = ownerByUploadId.get(uploadId);
      if (priorOwner) {
        const sameOwner = priorOwner.kind === owner.kind && (
          (owner.kind === 'page' && priorOwner.kind === 'page' && priorOwner.pageId === owner.pageId)
          || (owner.kind === 'block' && priorOwner.kind === 'block' && priorOwner.blockId === owner.blockId)
          || (
            owner.kind === 'template'
            && priorOwner.kind === 'template'
            && priorOwner.templateId === owner.templateId
          )
        );
        if (!sameOwner) {
          throw duplicateFileConflict('Page contains a stored file shared by multiple content records.');
        }
      }
      ownerByUploadId.set(uploadId, owner);
      selected.set(uploadId, upload);
    }
  }
  if (selected.size > MAX_DUPLICATED_FILES) {
    throw Object.assign(
      new Error(`Page duplication is limited to ${MAX_DUPLICATED_FILES} stored files per request.`),
      { status: 413 },
    );
  }

  let totalBytes = 0;
  for (const source of selected.values()) {
    const size = source.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw duplicateFileConflict('Page file metadata has an invalid size.');
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_DUPLICATED_BYTES) {
      throw Object.assign(
        new Error(
          `Page duplication is limited to ${MAX_DUPLICATED_BYTES_LABEL} of stored files per request.`,
        ),
        { status: 413 },
      );
    }
  }

  return Array.from(selected.values()).map((source): DuplicateFilePlan => {
    const owner = ownerByUploadId.get(source.id);
    if (!owner) throw duplicateFileConflict('Page file ownership could not be resolved.');
    assertUploadBelongsToSubtree(
      source,
      input.pageMap,
      input.blockMap,
      input.propertyMap,
      input.templateMap,
      owner,
    );
    const id = newId();
    const name = (optionalString(source.name) ?? 'Untitled').slice(0, 180);
    const bucket = uploadBucket(source);
    const key = `workspaces/${input.workspaceId}/duplicate-page/${id}-${cleanFileSegment(name)}${extensionFromName(name)}`;
    const now = nowIso();
    return {
      source,
      target: {
        id,
        workspaceId: input.workspaceId,
        bucket,
        key,
        scope: optionalString(source.scope) ?? 'uploads',
        pageId: owner.kind === 'template'
          ? undefined
          : targetFileAssociation(owner.pageId, input.pageMap, 'page'),
        blockId: owner.kind === 'block'
          ? targetFileAssociation(owner.blockId, input.blockMap, 'block')
          : undefined,
        databaseId: targetFileAssociation(
          owner.kind === 'template' ? owner.databaseId : source.databaseId,
          input.pageMap,
          'database',
        ),
        propertyId: targetFileAssociation(source.propertyId, input.propertyMap, 'property'),
        templateId: owner.kind === 'template'
          ? targetFileAssociation(owner.templateId, input.templateMap, 'template')
          : undefined,
        name,
        contentType: source.contentType,
        size: source.size,
        status: 'preparing',
        url: storageUrl(input.request, bucket, key),
        createdBy: input.actorId,
        expiresAt: new Date(Date.now() + DUPLICATE_FILE_RECOVERY_TTL_MS).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
      reservation: null,
      rowCreated: false,
      objectWriteAttempted: false,
    };
  });
}

function remapStoredFileReferences(
  value: unknown,
  plans: DuplicateFilePlan[],
  directString = false,
): unknown {
  if (plans.length === 0 || value == null) return value;
  const planById = new Map(plans.map((plan) => [plan.source.id, plan]));
  const planByKey = new Map(plans.map((plan) => [plan.source.key, plan]));
  const planByBucketKey = new Map(plans.map((plan) => [
    uploadLookupKey(uploadBucket(plan.source), plan.source.key),
    plan,
  ]));
  const planByUrl = new Map(
    plans
      .filter((plan) => optionalString(plan.source.url))
      .map((plan) => [plan.source.url as string, plan]),
  );
  const planForString = (current: string) => {
    const exactUrl = planByUrl.get(current);
    if (exactUrl) return exactUrl;
    const locator = localStorageLocator(current);
    if (!locator) return undefined;
    return locator.bucket
      ? planByBucketKey.get(uploadLookupKey(locator.bucket, locator.key))
      : planByKey.get(locator.key);
  };
  const planForRecord = (record: Record<string, unknown>) => {
    for (const field of ['uploadId', 'fileUploadId']) {
      const id = optionalString(record[field]);
      const plan = id ? planById.get(id) : undefined;
      if (plan) return plan;
    }
    for (const field of ['key', 'fileKey', 'storageKey', 'url', 'src', 'href']) {
      const raw = optionalString(record[field]);
      const plan = raw ? planForString(raw) : undefined;
      if (plan) return plan;
    }
    return undefined;
  };
  const remap = (current: unknown, allowDirectString = false, depth = 0): unknown => {
    if (depth > MAX_FILE_REFERENCE_DEPTH) {
      throw duplicateFileConflict('Page file reference nesting is too deep.');
    }
    if (typeof current === 'string') {
      const plan = allowDirectString ? planForString(current) : undefined;
      return plan?.target.url ?? current;
    }
    if (Array.isArray(current)) {
      return current.map((child) => remap(child, allowDirectString, depth + 1));
    }
    if (!current || typeof current !== 'object') return current;
    const record = current as Record<string, unknown>;
    const filePlan = planForRecord(record);
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => {
        if (filePlan && typeof child === 'string') {
          if (key === 'uploadId' || key === 'fileUploadId') return [key, filePlan.target.id];
          if (key === 'key' || key === 'fileKey' || key === 'storageKey') return [key, filePlan.target.key];
          if (key === 'url' || key === 'src' || key === 'href') return [key, filePlan.target.url];
          if (key === 'id') {
            if (child === filePlan.source.id) return [key, filePlan.target.id];
            if (child === filePlan.source.key) return [key, filePlan.target.key];
            if (child === filePlan.source.url) return [key, filePlan.target.url];
          }
        }
        return [key, remap(child, false, depth + 1)];
      }),
    );
  };
  return remap(value, directString);
}

function fileCustomMetadata(upload: FileUpload) {
  return Object.fromEntries(
    Object.entries({
      uploadId: upload.id,
      workspaceId: upload.workspaceId,
      pageId: upload.pageId,
      blockId: upload.blockId,
      databaseId: upload.databaseId,
      propertyId: upload.propertyId,
      templateId: upload.templateId,
      originalName: upload.name,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0),
  );
}

async function copyDuplicatedFiles(input: {
  db: DbRef;
  admin: AdminDbAccessor;
  workspace: Workspace;
  plans: DuplicateFilePlan[];
  storage?: DuplicateStorageProxy;
  lease: FileWorkspaceLeaseGuard;
}) {
  const uploads = input.db.table<FileUpload>('file_uploads');
  for (const plan of input.plans) {
    await input.lease.renew();
    await assertFileTargetsNotDeleting(input.db, input.workspace.id, [
      plan.source.pageId,
      plan.source.databaseId,
      plan.target.pageId,
      plan.target.databaseId,
    ]);
    const sourceBucket = uploadBucket(plan.source);
    const targetBucket = uploadBucket(plan.target);
    const sourceProxy = storageBucket(input.storage, sourceBucket);
    const targetProxy = storageBucket(input.storage, targetBucket);
    if (!sourceProxy?.get || !targetProxy?.put || !targetProxy.get || !targetProxy.delete) {
      throw new Error('Page duplication with files requires trusted storage access.');
    }

    const stored = await sourceProxy.get(plan.source.key);
    if (!stored) throw new Error(`Source file ${plan.source.id} was not found in storage.`);
    if (!optionalString(plan.source.etag) || stored.etag !== plan.source.etag) {
      throw duplicateFileConflict(`Source file ${plan.source.id} failed its integrity check.`);
    }
    const expectedSize = typeof plan.source.size === 'number' && Number.isFinite(plan.source.size)
      ? Math.max(0, Math.floor(plan.source.size))
      : -1;
    if (expectedSize < 0 || stored.size !== expectedSize) {
      throw duplicateFileConflict(`Source file ${plan.source.id} failed its size check.`);
    }
    const storedContentType = assertSafeStoredFileType(plan.target.name, stored.contentType);
    if (
      optionalString(plan.source.contentType) &&
      normalizeFileContentType(plan.source.contentType) !== storedContentType
    ) {
      throw duplicateFileConflict(`Source file ${plan.source.id} failed its content type check.`);
    }
    plan.target.contentType = storedContentType;
    plan.target.size = stored.size;

    await uploads.insert(plan.target);
    plan.rowCreated = true;
    try {
      plan.reservation = await reserveOrganizationStorage(
        input.admin,
        input.workspace,
        plan.target.id,
        stored.size,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/storage limit/i.test(message) && error && typeof error === 'object') {
        Object.assign(error, { status: 403 });
      }
      throw error;
    }
    await uploads.update(plan.target.id, { status: 'pending', updatedAt: nowIso() });

    plan.objectWriteAttempted = true;
    await targetProxy.put(plan.target.key, stored.body, {
      contentType: storedContentType,
      customMetadata: fileCustomMetadata(plan.target),
    });
    const [stableSource, copied] = await Promise.all([
      sourceProxy.get(plan.source.key),
      targetProxy.get(plan.target.key),
    ]);
    if (!stableSource || stableSource.etag !== stored.etag || stableSource.size !== stored.size) {
      throw duplicateFileConflict(`Source file ${plan.source.id} changed during duplication.`);
    }
    if (!copied) throw new Error(`Duplicated file ${plan.target.id} was not found after storage copy.`);
    if (copied.size !== stored.size) throw new Error(`Duplicated file ${plan.target.id} failed its size check.`);
    if (!optionalString(copied.etag)) throw new Error(`Duplicated file ${plan.target.id} has no integrity metadata.`);
    const copiedContentType = assertSafeStoredFileType(plan.target.name, copied.contentType);
    if (copiedContentType !== storedContentType) {
      throw new Error(`Duplicated file ${plan.target.id} failed its content type check.`);
    }
    if (!(await streamsHaveSameBytes(stableSource.body, copied.body, stored.size))) {
      throw new Error(`Duplicated file ${plan.target.id} failed its byte-for-byte integrity check.`);
    }

    await input.lease.renew();
    await assertFileTargetsNotDeleting(input.db, input.workspace.id, [
      plan.source.pageId,
      plan.source.databaseId,
      plan.target.pageId,
      plan.target.databaseId,
    ]);
    const completedAt = nowIso();
    plan.target = await uploads.update(plan.target.id, {
      status: 'uploaded',
      etag: copied.etag,
      contentType: copiedContentType,
      size: copied.size,
      expiresAt: null,
      completedAt,
      updatedAt: completedAt,
    });
  }
}

async function rollbackDuplicatedFiles(input: {
  db: DbRef;
  admin: AdminDbAccessor;
  plans: DuplicateFilePlan[];
  storage?: DuplicateStorageProxy;
}) {
  const uploads = input.db.table<FileUpload>('file_uploads');
  let allClean = true;
  for (const plan of input.plans.slice().reverse()) {
    let objectDeleted = !plan.objectWriteAttempted;
    if (plan.objectWriteAttempted) {
      const proxy = storageBucket(input.storage, uploadBucket(plan.target));
      objectDeleted = !!proxy && await bestEffort(
        `duplicate-page delete copied object ${plan.target.id}`,
        proxy.delete(plan.target.key),
      );
      if (!objectDeleted) allClean = false;
    }
    let quotaReleased = !plan.reservation;
    if (plan.reservation && objectDeleted) {
      quotaReleased = await bestEffort(
        `duplicate-page release copied quota ${plan.target.id}`,
        releaseOrganizationStorage(input.admin, plan.reservation),
      );
      if (!quotaReleased) allClean = false;
    }
    if (!plan.rowCreated) continue;
    if (objectDeleted && quotaReleased) {
      const metadataDeleted = await bestEffort(
        `duplicate-page delete copied metadata ${plan.target.id}`,
        uploads.delete(plan.target.id),
      );
      if (!metadataDeleted) {
        allClean = false;
        const failedAt = nowIso();
        await bestEffort(
          `duplicate-page expire copied metadata ${plan.target.id}`,
          uploads.update(plan.target.id, {
            status: 'expired',
            expiresAt: failedAt,
            expiredAt: failedAt,
            deletedAt: failedAt,
            deletedBy: plan.target.createdBy,
            updatedAt: failedAt,
          }),
        );
      }
      continue;
    }
    const failedAt = nowIso();
    allClean = false;
    await bestEffort(
      `duplicate-page preserve copied file cleanup state ${plan.target.id}`,
      uploads.update(plan.target.id, {
        status: 'pending',
        expiresAt: failedAt,
        updatedAt: failedAt,
      }),
    );
  }
  return allClean;
}

function pageTitle(page: Page) {
  return page.title || 'Untitled';
}

function positionBetween(a?: number, b?: number): number {
  if (a == null && b == null) return 1;
  if (a == null) return b! / 2;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

function parseParentInput(parentId: unknown, parentType: unknown) {
  const cleanParentId = typeof parentId === 'string' && parentId.trim() ? parentId.trim() : null;
  const cleanParentType =
    typeof parentType === 'string' && parentTypes.has(parentType as PageParentType)
      ? (parentType as PageParentType)
      : cleanParentId
        ? 'page'
        : 'workspace';
  if (cleanParentType === 'workspace') {
    if (cleanParentId) throw new Error('workspace duplicates should omit parentId.');
    return { parentId: null, parentType: 'workspace' as const };
  }
  if (!cleanParentId) throw new Error(`${cleanParentType} duplicates require parentId.`);
  return { parentId: cleanParentId, parentType: cleanParentType };
}

function collectSubtree(pages: Page[], rootId: string) {
  const childrenByParent = new Map<string, Page[]>();
  for (const page of pages) {
    if (page.parentId) {
      const list = childrenByParent.get(page.parentId) ?? [];
      list.push(page);
      childrenByParent.set(page.parentId, list);
    }
    if (page.subitemParentId) {
      const list = childrenByParent.get(page.subitemParentId) ?? [];
      list.push(page);
      childrenByParent.set(page.subitemParentId, list);
    }
  }

  const out = new Set<string>();
  const collect = (pageId: string) => {
    if (out.has(pageId)) return;
    out.add(pageId);
    for (const child of childrenByParent.get(pageId) ?? []) collect(child.id);
  };
  collect(rootId);
  return out;
}

function siblingPages(pages: Page[], parentId: string | null, parentType: PageParentType, excludeId: string) {
  return pages
    .filter((page) => {
      if (page.inTrash || page.id === excludeId) return false;
      if (parentType === 'workspace') return page.parentId == null || page.parentType === 'workspace';
      return page.parentId === parentId && page.parentType === parentType;
    })
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function assertParentAllowsDuplicate(pagesById: Record<string, Page>, parentId?: string | null) {
  const parent = parentId ? pagesById[parentId] : undefined;
  if (parent?.isLocked) throw new Error(`Parent page "${pageTitle(parent)}" is locked.`);
}

function remapRecordKeys(record: Record<string, unknown> | undefined, ids: Map<string, string>) {
  if (!record) return record;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) next[ids.get(key) ?? key] = value;
  return next;
}

function remapFilterGroup(group: Record<string, unknown>, ids: Map<string, string>): Record<string, unknown> {
  return {
    ...group,
    filters: Array.isArray(group.filters)
      ? group.filters.map((filter) =>
          filter && typeof filter === 'object'
            ? {
                ...(filter as Record<string, unknown>),
                propertyId:
                  typeof (filter as Record<string, unknown>).propertyId === 'string'
                    ? ids.get((filter as Record<string, unknown>).propertyId as string) ??
                      (filter as Record<string, unknown>).propertyId
                    : (filter as Record<string, unknown>).propertyId,
              }
            : filter,
        )
      : group.filters,
    groups: Array.isArray(group.groups)
      ? group.groups.map((sub) =>
          sub && typeof sub === 'object' ? remapFilterGroup(sub as Record<string, unknown>, ids) : sub,
        )
      : group.groups,
  };
}

function remapViewConfig(config: Record<string, unknown> | undefined, ids: Map<string, string>) {
  const next = cloneJson(config ?? {});
  const mapList = (value: unknown) => (Array.isArray(value) ? value.map((id) => ids.get(String(id)) ?? id) : value);
  next.visibleProperties = mapList(next.visibleProperties);
  next.propertyOrder = mapList(next.propertyOrder);
  next.wrappedColumns = mapList(next.wrappedColumns);
  next.propertyWidths = remapRecordKeys(next.propertyWidths as Record<string, unknown> | undefined, ids);
  next.tableCalculations = remapRecordKeys(next.tableCalculations as Record<string, unknown> | undefined, ids);
  if (Array.isArray(next.filters)) {
    next.filters = next.filters.map((filter) =>
      filter && typeof filter === 'object'
        ? {
            ...(filter as Record<string, unknown>),
            propertyId:
              typeof (filter as Record<string, unknown>).propertyId === 'string'
                ? ids.get((filter as Record<string, unknown>).propertyId as string) ??
                  (filter as Record<string, unknown>).propertyId
                : (filter as Record<string, unknown>).propertyId,
          }
        : filter,
    );
  }
  if (next.filterGroup && typeof next.filterGroup === 'object') {
    next.filterGroup = remapFilterGroup(next.filterGroup as Record<string, unknown>, ids);
  }
  if (Array.isArray(next.sorts)) {
    next.sorts = next.sorts.map((sort) =>
      sort && typeof sort === 'object'
        ? {
            ...(sort as Record<string, unknown>),
            propertyId:
              typeof (sort as Record<string, unknown>).propertyId === 'string'
                ? ids.get((sort as Record<string, unknown>).propertyId as string) ??
                  (sort as Record<string, unknown>).propertyId
                : (sort as Record<string, unknown>).propertyId,
          }
        : sort,
    );
  }
  for (const key of [
    'groupBy',
    'calendarBy',
    'timelineBy',
    'timelineEndBy',
    'dependencyProperty',
    'coverProperty',
    'subGroupBy',
  ]) {
    if (typeof next[key] === 'string') next[key] = ids.get(next[key] as string) ?? next[key];
  }
  return next;
}

function remapPageMentions(spans: unknown, pageMap: Map<string, string>) {
  return Array.isArray(spans)
    ? spans.map((span) =>
        span && typeof span === 'object' && typeof (span as Record<string, unknown>).pageId === 'string'
          ? {
              ...(span as Record<string, unknown>),
              pageId: pageMap.get((span as Record<string, unknown>).pageId as string) ??
                (span as Record<string, unknown>).pageId,
            }
          : span,
      )
    : spans;
}

function remapTemplateBlocks(
  blocks: unknown,
  pageMap: Map<string, string>,
  blockMap = new Map<string, string>(),
): unknown {
  return Array.isArray(blocks)
    ? blocks.map((block) =>
        block && typeof block === 'object'
          ? {
              ...cloneJson(block as Record<string, unknown>),
              content: remapBlockContent((block as Record<string, unknown>).content, pageMap, blockMap),
              children: remapTemplateBlocks((block as Record<string, unknown>).children, pageMap, blockMap),
            }
          : block,
      )
    : blocks;
}

function remapBlockContent(content: unknown, pageMap: Map<string, string>, blockMap = new Map<string, string>()) {
  const next = cloneJson(content) as Record<string, unknown> | undefined;
  if (!next) return next;
  if (typeof next.childPageId === 'string') next.childPageId = pageMap.get(next.childPageId) ?? next.childPageId;
  if (typeof next.syncedBlockId === 'string') {
    const nextBlockId = blockMap.get(next.syncedBlockId);
    if (nextBlockId) {
      next.syncedBlockId = nextBlockId;
      if (typeof next.syncedPageId === 'string') {
        next.syncedPageId = pageMap.get(next.syncedPageId) ?? next.syncedPageId;
      }
    }
  } else if (typeof next.syncedPageId === 'string') {
    next.syncedPageId = pageMap.get(next.syncedPageId) ?? next.syncedPageId;
  }
  next.rich = remapPageMentions(next.rich, pageMap);
  next.caption = remapPageMentions(next.caption, pageMap);
  next.buttonTemplate = remapTemplateBlocks(next.buttonTemplate, pageMap, blockMap);
  return next;
}

function remapRelationValue(value: unknown, pageMap: Map<string, string>) {
  if (Array.isArray(value)) return value.map((id) => pageMap.get(String(id)) ?? id);
  if (value == null || value === '') return value;
  return pageMap.get(String(value)) ?? value;
}

function remapProperties(
  properties: Record<string, unknown> | undefined,
  propMap: Map<string, string> | undefined,
  pageMap: Map<string, string>,
  propsById = new Map<string, DbProperty>(),
  filePlans: DuplicateFilePlan[] = [],
) {
  const cloned = cloneJson(properties ?? {});
  if (!propMap) return cloned;
  const remapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cloned)) {
    const prop = propsById.get(key);
    const remappedValue = prop?.type === 'relation'
      ? remapRelationValue(value, pageMap)
      : prop?.type === 'files'
        // Legacy files values may be a raw key/URL or an array of them. Only
        // the schema-declared files property gets scalar-string semantics;
        // rich text and captions elsewhere remain literal content.
        ? remapStoredFileReferences(value, filePlans, true)
        : value;
    remapped[propMap.get(key) ?? key] = remappedValue;
  }
  return remapped;
}

function storedFilePropertyValues(
  properties: Record<string, unknown> | undefined,
  propsById: Map<string, DbProperty> | undefined,
): FileReferenceValue[] {
  if (!properties || !propsById) return [];
  return Object.entries(properties)
    .filter(([propertyId]) => propsById.get(propertyId)?.type === 'files')
    .map(([, value]) => ({ value, directString: true }));
}

function remapPropertyConfig(
  config: Record<string, unknown> | undefined,
  propMap: Map<string, string>,
  pageMap: Map<string, string>,
  sourceDbId: string,
  targetDbId: string,
) {
  if (!config) return config;
  const next = cloneJson(config);
  if (next.relationDatabaseId === sourceDbId) next.relationDatabaseId = targetDbId;
  else if (typeof next.relationDatabaseId === 'string') {
    next.relationDatabaseId = pageMap.get(next.relationDatabaseId) ?? next.relationDatabaseId;
  }
  for (const key of ['rollupRelationPropertyId', 'rollupTargetPropertyId', 'rollupVia']) {
    if (typeof next[key] === 'string') next[key] = propMap.get(next[key] as string) ?? next[key];
  }
  return next;
}

async function pageRole(
  db: DbRef,
  page: Page,
  actorId: string,
  actorEmail?: string | null,
): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
}

async function assertCanEditPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Page access required.');
}

async function rollbackPageWorkspaceIndex(admin: AdminDbAccessor, page: Page) {
  const index = admin.db('app').table<{ id: string; workspaceId: string }>('page_workspace_index');
  const current = await getExisting(index, page.id);
  if (!current || current.workspaceId !== page.workspaceId) return;
  await index.delete(page.id);
}

interface DuplicateHierarchyJob {
  id: string;
  workspaceId: string;
  databaseId: string;
  rootRowId: string;
  operation: 'duplicate';
  trashStamp: string;
  featureRevision: number;
  requestedBy: string;
  mutationId: string;
  phase: string;
  targetRootId: string;
  sourceParentId: string;
}

interface DuplicateHierarchyItem {
  id: string;
  workspaceId: string;
  databaseId: string;
  jobId: string;
  rowId: string;
  depth: number;
  scanned: boolean;
  scanLane: 'subitems' | 'pages';
  scanPosition: number;
  scanRowId: string;
  targetRowId: string;
  prepared: boolean;
  applied: boolean;
  sourceUpdatedAt?: string;
  blockScanId: string;
  blocksPrepared: boolean;
  blocksApplied: boolean;
  dependencyLane: 'outgoing' | 'incoming';
  dependencyCursorId: string;
  dependenciesPrepared: boolean;
  dependenciesApplied: boolean;
  fileCursorId: string;
  filesApplied: boolean;
  relationPropertyCursorId: string;
  relationValueOffset: number;
  relationsPrepared: boolean;
}

interface HierarchyRelationUpdate {
  id: string;
  workspaceId: string;
  databaseId: string;
  jobId: string;
  rowId: string;
  sourceUpdatedAt: string;
  properties: Record<string, unknown>;
}

interface DuplicateHierarchyDependencyEdge {
  id: string;
  workspaceId: string;
  databaseId: string;
  predecessorRowId: string;
  successorRowId: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

const DUPLICATE_HIERARCHY_CHILD_WINDOW = 32;
const DUPLICATE_HIERARCHY_PARENT_STEPS = 32;
const DUPLICATE_HIERARCHY_APPLY_WINDOW = 16;
// A block window plus bounded reference resolution and the page/job fences
// stays comfortably below the 128-row lifecycle request ceiling.
const DUPLICATE_HIERARCHY_BLOCK_WINDOW = 8;
const DUPLICATE_HIERARCHY_BLOCK_REFERENCE_LIMIT = 32;
const DUPLICATE_HIERARCHY_DEPENDENCY_WINDOW = 8;
const DUPLICATE_HIERARCHY_RELATION_VALUE_WINDOW = 16;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactDuplicateSubitemChildCount(page: Page) {
  const count = Number(page.subitemChildCount ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw Object.assign(new Error('Sub-item child count is invalid.'), { status: 409 });
  }
  return count;
}

function incrementedDuplicateSubitemChildCount(page: Page) {
  const next = exactDuplicateSubitemChildCount(page) + 1;
  if (!Number.isSafeInteger(next)) {
    throw Object.assign(new Error('Sub-item child count is inconsistent.'), { status: 409 });
  }
  return next;
}

function duplicateHierarchyBinding(database: Page) {
  const binding = objectRecord(objectRecord(database.databaseFeatures)?.subitems);
  if (
    binding?.enabled !== true
    || typeof binding.parentPropertyId !== 'string'
    || typeof binding.childrenPropertyId !== 'string'
  ) return null;
  return {
    ...binding,
    revision: Number(binding.revision ?? 0),
  };
}

async function duplicateHierarchyHash(kind: string, ...parts: string[]) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode([kind, ...parts].join('\u0000')),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function duplicateHierarchyUuid(jobId: string, rowId: string) {
  const hex = await duplicateHierarchyHash('duplicate-hierarchy-row', jobId, rowId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function duplicateHierarchyBlockUuid(jobId: string, blockId: string) {
  const hex = await duplicateHierarchyHash('duplicate-hierarchy-block', jobId, blockId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function duplicateHierarchyFileUuid(jobId: string, uploadId: string) {
  const hex = await duplicateHierarchyHash('duplicate-hierarchy-file', jobId, uploadId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function duplicateHierarchyDatabaseExpectation(database: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: database.id,
    where: [
      ['workspaceId', '==', database.workspaceId],
      ['kind', '==', 'database'],
      ['inTrash', '==', false],
      ['databaseFeaturesRevision', '==', Number(database.databaseFeaturesRevision ?? 0)],
    ],
    exists: true,
  };
}

function duplicateHierarchyJobExpectation(job: DuplicateHierarchyJob): TransactOperation {
  return {
    table: 'database_hierarchy_lifecycle_jobs',
    op: 'expect',
    id: job.id,
    where: [
      ['databaseId', '==', job.databaseId],
      ['rootRowId', '==', job.rootRowId],
      ['operation', '==', 'duplicate'],
      ['featureRevision', '==', job.featureRevision],
      ['requestedBy', '==', job.requestedBy],
      ['mutationId', '==', job.mutationId],
      ['sourceParentId', '==', job.sourceParentId],
    ],
    exists: true,
  };
}

function duplicateHierarchyItemData(item: DuplicateHierarchyItem) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    databaseId: item.databaseId,
    jobId: item.jobId,
    rowId: item.rowId,
    depth: item.depth,
    scanned: item.scanned,
    scanLane: item.scanLane,
    scanPosition: item.scanPosition,
    scanRowId: item.scanRowId,
    targetRowId: item.targetRowId,
    prepared: item.prepared,
    applied: item.applied,
    published: false,
    ...(item.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: item.sourceUpdatedAt } : {}),
    blockScanId: item.blockScanId,
    blocksPrepared: item.blocksPrepared,
    blocksApplied: item.blocksApplied,
    dependencyLane: item.dependencyLane,
    dependencyCursorId: item.dependencyCursorId,
    dependenciesPrepared: item.dependenciesPrepared,
    dependenciesApplied: item.dependenciesApplied,
    fileCursorId: item.fileCursorId,
    filesApplied: item.filesApplied,
    relationPropertyCursorId: item.relationPropertyCursorId,
    relationValueOffset: item.relationValueOffset,
    relationsPrepared: item.relationsPrepared,
  };
}

function duplicateHierarchyItemExpectation(item: DuplicateHierarchyItem): TransactOperation {
  return {
    table: 'database_hierarchy_lifecycle_items',
    op: 'expect',
    id: item.id,
    where: [
      ['jobId', '==', item.jobId],
      ['rowId', '==', item.rowId],
      ['scanned', '==', item.scanned],
      ['scanLane', '==', item.scanLane],
      ['scanPosition', '==', item.scanPosition],
      ['scanRowId', '==', item.scanRowId],
      ['prepared', '==', item.prepared],
      ['applied', '==', item.applied],
      ['blockScanId', '==', item.blockScanId],
      ['blocksPrepared', '==', item.blocksPrepared],
      ['blocksApplied', '==', item.blocksApplied],
      ['dependencyLane', '==', item.dependencyLane],
      ['dependencyCursorId', '==', item.dependencyCursorId],
      ['dependenciesPrepared', '==', item.dependenciesPrepared],
      ['dependenciesApplied', '==', item.dependenciesApplied],
      ['fileCursorId', '==', item.fileCursorId],
      ['filesApplied', '==', item.filesApplied],
      ['relationPropertyCursorId', '==', item.relationPropertyCursorId],
      ['relationValueOffset', '==', item.relationValueOffset],
      ['relationsPrepared', '==', item.relationsPrepared],
    ],
    exists: true,
  };
}

function duplicateHierarchySourcePageExpectation(
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
): TransactOperation {
  if (item.sourceUpdatedAt === undefined) {
    throw Object.assign(new Error('Hierarchy duplicate source fence is incomplete.'), { status: 409 });
  }
  return {
    table: 'pages',
    op: 'expect',
    id: item.rowId,
    where: [
      ['workspaceId', '==', job.workspaceId],
      ['inTrash', '==', false],
      ['updatedAt', '==', item.sourceUpdatedAt || null],
    ],
    exists: true,
  };
}

function duplicateHierarchyBlockExpectation(block: Block): TransactOperation {
  return {
    table: 'blocks',
    op: 'expect',
    id: block.id,
    where: [
      ['pageId', '==', block.pageId],
      ['parentId', '==', block.parentId ?? null],
      ['updatedAt', '==', block.updatedAt ?? null],
    ],
    exists: true,
  };
}

async function firstDuplicateHierarchyItem(
  db: DbRef,
  jobId: string,
  field: 'scanned' | 'prepared' | 'applied' | 'blocksPrepared' | 'blocksApplied'
    | 'dependenciesPrepared' | 'dependenciesApplied' | 'filesApplied' | 'relationsPrepared',
  value: boolean,
  order: 'asc' | 'desc' = 'asc',
) {
  let query: TableQuery<DuplicateHierarchyItem> = db
    .table<DuplicateHierarchyItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy duplication requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!(field, '==', value).orderBy!('depth', order).orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function duplicateHierarchyItems(
  db: DbRef,
  jobId: string,
  field: 'prepared' | 'applied',
  value: boolean,
  order: 'asc' | 'desc',
) {
  let query: TableQuery<DuplicateHierarchyItem> = db
    .table<DuplicateHierarchyItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy duplication requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!(field, '==', value).orderBy!('depth', order).orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(DUPLICATE_HIERARCHY_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function duplicateHierarchyBlockStateItems(
  db: DbRef,
  jobId: string,
  field: 'blocksPrepared' | 'blocksApplied',
) {
  let query: TableQuery<DuplicateHierarchyItem> = db
    .table<DuplicateHierarchyItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy block continuation requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!(field, '==', false).orderBy!('depth', 'asc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(DUPLICATE_HIERARCHY_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function duplicateHierarchyDependencyStateItems(
  db: DbRef,
  jobId: string,
  field: 'dependenciesPrepared' | 'dependenciesApplied',
) {
  let query: TableQuery<DuplicateHierarchyItem> = db
    .table<DuplicateHierarchyItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy dependency copy requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!(field, '==', false).orderBy!('depth', 'asc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(DUPLICATE_HIERARCHY_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function duplicateHierarchyRelationStateItems(db: DbRef, jobId: string) {
  let query: TableQuery<DuplicateHierarchyItem> = db
    .table<DuplicateHierarchyItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy relation copy requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!('relationsPrepared', '==', false).orderBy!('depth', 'asc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(DUPLICATE_HIERARCHY_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function duplicateHierarchyFileStateItems(db: DbRef, jobId: string) {
  let query: TableQuery<DuplicateHierarchyItem> = db
    .table<DuplicateHierarchyItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy file copy requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!('filesApplied', '==', false).orderBy!('depth', 'asc').orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(DUPLICATE_HIERARCHY_APPLY_WINDOW + 1).getList()).items ?? [];
}

async function duplicateHierarchyItemForRow(db: DbRef, jobId: string, rowId: string) {
  let query: TableQuery<DuplicateHierarchyItem> = db
    .table<DuplicateHierarchyItem>('database_hierarchy_lifecycle_items')
    .where('jobId', '==', jobId);
  if (typeof query.where !== 'function') {
    throw Object.assign(new Error('Hierarchy duplication requires bounded item lookup.'), { status: 500 });
  }
  query = query.where!('rowId', '==', rowId);
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function duplicateHierarchyBlockWindow(db: DbRef, item: DuplicateHierarchyItem) {
  let query: TableQuery<Block> = db.table<Block>('blocks').where('pageId', '==', item.rowId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy block continuation requires bounded ordered queries.'), { status: 500 });
  }
  if (item.blockScanId) query = query.where!('id', '>', item.blockScanId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const candidates = (await query.limit(DUPLICATE_HIERARCHY_BLOCK_WINDOW + 1).getList()).items ?? [];
  const rows = candidates
    .filter((block) => block.pageId === item.rowId && (!item.blockScanId || block.id > item.blockScanId))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    rows: rows.slice(0, DUPLICATE_HIERARCHY_BLOCK_WINDOW),
    hasMore: rows.length > DUPLICATE_HIERARCHY_BLOCK_WINDOW,
  };
}

async function duplicateHierarchyDependencyEdgeForRows(
  db: DbRef,
  job: DuplicateHierarchyJob,
  lane: 'outgoing' | 'incoming',
  rowIds: string[],
) {
  const field = lane === 'outgoing' ? 'predecessorRowId' : 'successorRowId';
  let query: TableQuery<DuplicateHierarchyDependencyEdge> = db
    .table<DuplicateHierarchyDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', job.databaseId);
  if (typeof query.where !== 'function') {
    throw Object.assign(new Error('Hierarchy dependency copy requires bounded edge lookup.'), { status: 500 });
  }
  query = query.where!(field, 'in', rowIds);
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function duplicateHierarchyDependencyEdgeWindow(
  db: DbRef,
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
) {
  const field = item.dependencyLane === 'outgoing' ? 'predecessorRowId' : 'successorRowId';
  let query: TableQuery<DuplicateHierarchyDependencyEdge> = db
    .table<DuplicateHierarchyDependencyEdge>('database_dependency_edges')
    .where('databaseId', '==', job.databaseId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy dependency copy requires bounded ordered queries.'), { status: 500 });
  }
  query = query.where!(field, '==', item.rowId);
  if (item.dependencyCursorId) query = query.where!('id', '>', item.dependencyCursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const candidates = (await query.limit(DUPLICATE_HIERARCHY_DEPENDENCY_WINDOW + 1).getList()).items ?? [];
  const rows = candidates
    .filter((edge) => (
      edge.databaseId === job.databaseId
      && edge[field] === item.rowId
      && (!item.dependencyCursorId || edge.id > item.dependencyCursorId)
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    rows: rows.slice(0, DUPLICATE_HIERARCHY_DEPENDENCY_WINDOW),
    hasMore: rows.length > DUPLICATE_HIERARCHY_DEPENDENCY_WINDOW,
  };
}

function duplicateHierarchyDependencyEdgeExpectation(
  edge: DuplicateHierarchyDependencyEdge,
): TransactOperation {
  return {
    table: 'database_dependency_edges',
    op: 'expect',
    id: edge.id,
    where: [
      ['databaseId', '==', edge.databaseId],
      ['predecessorRowId', '==', edge.predecessorRowId],
      ['successorRowId', '==', edge.successorRowId],
      ['updatedAt', '==', edge.updatedAt ?? null],
    ],
    exists: true,
  };
}

async function assertDuplicateHierarchyDependencyEndpoint(
  db: DbRef,
  job: DuplicateHierarchyJob,
  rowId: string,
) {
  const page = await getExisting(db.table<Page>('pages'), rowId);
  if (!page || page.workspaceId !== job.workspaceId || page.inTrash === true) {
    throw Object.assign(new Error('Hierarchy dependency endpoint changed during preflight.'), { status: 409 });
  }
  const hierarchyItem = await duplicateHierarchyItemForRow(db, job.id, rowId);
  const ordinaryDatabaseRow = page.parentType === 'database' && page.parentId === job.databaseId;
  if (!hierarchyItem && !ordinaryDatabaseRow) {
    throw Object.assign(new Error('Hierarchy dependency endpoint is outside the source database.'), { status: 409 });
  }
  return { page, hierarchyItem };
}

function compareDuplicateHierarchyBoundary(page: Page, boundary: { position: number; id: string }) {
  return (page.position ?? 0) - boundary.position || page.id.localeCompare(boundary.id);
}

async function duplicateHierarchyChildWindow(
  db: DbRef,
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
) {
  const read = async (additional: Array<[string, string, unknown]>) => {
    let query: TableQuery<Page> = item.scanLane === 'subitems'
      ? db.table<Page>('pages').where('parentId', '==', job.databaseId)
      : db.table<Page>('pages').where('parentId', '==', item.rowId);
    if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
      throw Object.assign(new Error('Hierarchy duplication requires bounded ordered queries.'), { status: 500 });
    }
    query = query.where!('parentType', '==', item.scanLane === 'subitems' ? 'database' : 'page');
    if (item.scanLane === 'subitems') query = query.where!('subitemParentId', '==', item.rowId);
    query = query.where!('inTrash', '==', false).orderBy!('position', 'asc').orderBy!('id', 'asc');
    for (const [field, operator, value] of additional) query = query.where!(field, operator, value);
    if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
    return (await query.limit(DUPLICATE_HIERARCHY_CHILD_WINDOW + 1).getList()).items ?? [];
  };
  const after = item.scanRowId ? { position: item.scanPosition, id: item.scanRowId } : undefined;
  const candidates = after
    ? (await Promise.all([
        read([['position', '>', after.position]]),
        read([['position', '==', after.position], ['id', '>', after.id]]),
      ])).flat()
    : await read([]);
  const rows = Array.from(new Map(candidates
    .filter((child) => (
      child.workspaceId === job.workspaceId
      && child.inTrash !== true
      && (item.scanLane === 'subitems'
        ? child.parentId === job.databaseId
          && child.parentType === 'database'
          && child.subitemParentId === item.rowId
        : child.parentId === item.rowId && child.parentType === 'page')
      && (!after || compareDuplicateHierarchyBoundary(child, after) > 0)
    ))
    .map((child) => [child.id, child])).values())
    .sort((left, right) => compareDuplicateHierarchyBoundary(left, {
      position: right.position ?? 0,
      id: right.id,
    }));
  const accepted = rows.slice(0, DUPLICATE_HIERARCHY_CHILD_WINDOW);
  const last = accepted.at(-1);
  return {
    rows: accepted,
    hasMore: rows.length > DUPLICATE_HIERARCHY_CHILD_WINDOW,
    boundary: last ? { position: last.position ?? 0, id: last.id } : undefined,
  };
}

async function createDuplicateHierarchyJob(
  db: DbRef,
  database: Page,
  source: Page,
  mutationId: string,
  actorId: string,
) {
  const id = await duplicateHierarchyHash(
    'duplicate-hierarchy-job',
    source.workspaceId,
    database.id,
    source.id,
    mutationId,
  );
  const targetRootId = await duplicateHierarchyUuid(id, source.id);
  const job: DuplicateHierarchyJob = {
    id,
    workspaceId: source.workspaceId,
    databaseId: database.id,
    rootRowId: source.id,
    operation: 'duplicate',
    trashStamp: nowIso(),
    featureRevision: Number(database.databaseFeaturesRevision ?? 0),
    requestedBy: actorId,
    mutationId,
    phase: 'discovering',
    targetRootId,
    sourceParentId: source.subitemParentId ?? '',
  };
  const item: DuplicateHierarchyItem = {
    id: await duplicateHierarchyHash('duplicate-hierarchy-item', id, source.id),
    workspaceId: source.workspaceId,
    databaseId: database.id,
    jobId: id,
    rowId: source.id,
    depth: 0,
    scanned: false,
    scanLane: 'subitems',
    scanPosition: 0,
    scanRowId: '',
    targetRowId: targetRootId,
    prepared: false,
    applied: false,
    blockScanId: '',
    blocksPrepared: false,
    blocksApplied: false,
    dependencyLane: 'outgoing',
    dependencyCursorId: '',
    dependenciesPrepared: false,
    dependenciesApplied: false,
    fileCursorId: '',
    filesApplied: false,
    relationPropertyCursorId: '',
    relationValueOffset: 0,
    relationsPrepared: false,
  };
  await db.transact([
    duplicateHierarchyDatabaseExpectation(database),
    { table: 'database_hierarchy_lifecycle_jobs', op: 'expect', id, exists: false },
    { table: 'database_hierarchy_lifecycle_jobs', op: 'insert', data: job as unknown as Record<string, unknown> },
    { table: 'database_hierarchy_lifecycle_items', op: 'insert', data: duplicateHierarchyItemData(item) },
  ]);
  return job;
}

async function advanceDuplicateHierarchyDiscovery(
  db: DbRef,
  database: Page,
  job: DuplicateHierarchyJob,
) {
  for (let step = 0; step < DUPLICATE_HIERARCHY_PARENT_STEPS; step += 1) {
    const item = await firstDuplicateHierarchyItem(db, job.id, 'scanned', false);
    if (!item) return false;
    const window = await duplicateHierarchyChildWindow(db, job, item);
    const children = await Promise.all(window.rows.map(async (child): Promise<DuplicateHierarchyItem> => ({
      id: await duplicateHierarchyHash('duplicate-hierarchy-item', job.id, child.id),
      workspaceId: job.workspaceId,
      databaseId: job.databaseId,
      jobId: job.id,
      rowId: child.id,
      depth: item.depth + 1,
      scanned: false,
      scanLane: 'subitems',
      scanPosition: 0,
      scanRowId: '',
      targetRowId: await duplicateHierarchyUuid(job.id, child.id),
      prepared: false,
      applied: false,
      blockScanId: '',
      blocksPrepared: false,
      blocksApplied: false,
      dependencyLane: 'outgoing',
      dependencyCursorId: '',
      dependenciesPrepared: false,
      dependenciesApplied: false,
      fileCursorId: '',
      filesApplied: false,
      relationPropertyCursorId: '',
      relationValueOffset: 0,
      relationsPrepared: false,
    })));
    const operations: TransactOperation[] = [
      duplicateHierarchyDatabaseExpectation(database),
      duplicateHierarchyJobExpectation(job),
      duplicateHierarchyItemExpectation(item),
      ...children.map((child): TransactOperation => ({
        table: 'database_hierarchy_lifecycle_items',
        op: 'insert',
        data: duplicateHierarchyItemData(child),
      })),
    ];
    if (window.hasMore && window.boundary) {
      operations.push({
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: { scanPosition: window.boundary.position, scanRowId: window.boundary.id },
      });
      await db.transact(operations);
      return true;
    }
    operations.push({
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: item.scanLane === 'subitems'
        ? { scanLane: 'pages', scanPosition: 0, scanRowId: '' }
        : { scanned: true },
    });
    await db.transact(operations);
  }
  return Boolean(await firstDuplicateHierarchyItem(db, job.id, 'scanned', false));
}

async function loadDuplicateHierarchyPages(db: DbRef, items: DuplicateHierarchyItem[]) {
  const ids = items.map((item) => item.rowId);
  const result = await db.table<Page>('pages').where('id', 'in', ids).limit(ids.length).getList();
  const byId = new Map((result.items ?? []).map((page) => [page.id, page]));
  if (byId.size !== ids.length) {
    throw Object.assign(new Error('Hierarchy changed during duplication.'), { status: 409 });
  }
  return byId;
}

async function duplicateHierarchyFileProperties(
  db: DbRef,
  databaseId: string,
  pages: Page[],
) {
  const propertyIds = Array.from(new Set(pages.flatMap((page) => (
    Object.entries(page.properties ?? {})
      .filter(([, value]) => hasPotentialStoredFileReference(value))
      .map(([propertyId]) => propertyId)
  ))));
  if (propertyIds.length > MAX_DUPLICATED_FILES) {
    throw Object.assign(
      new Error(`Page duplication is limited to ${MAX_DUPLICATED_FILES} stored-file properties per row.`),
      { status: 413 },
    );
  }
  if (propertyIds.length === 0) return new Map<string, DbProperty>();
  const result = await db.table<DbProperty>('db_properties')
    .where('id', 'in', propertyIds)
    .limit(propertyIds.length)
    .getList();
  return new Map((result.items ?? [])
    .filter((property) => property.databaseId === databaseId && property.type === 'files')
    .map((property) => [property.id, property]));
}

async function duplicateHierarchyPageFilePlans(
  db: DbRef,
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
  page: Page,
  request?: Request,
  knownFileProperties?: Map<string, DbProperty>,
) {
  const propsById = knownFileProperties
    ?? await duplicateHierarchyFileProperties(db, job.databaseId, [page]);
  const values: FileReferenceValue[] = [
    { value: page.icon, directString: true },
    { value: page.cover, directString: true },
    { value: page.properties },
    ...storedFilePropertyValues(page.properties, propsById),
  ];
  const uploads = await loadReferencedUploads(db, job.workspaceId, values);
  const propertyMap = new Map(Array.from(propsById.keys(), (propertyId) => [propertyId, propertyId]));
  return buildDuplicateFilePlans({
    uploads,
    pageMap: new Map([[job.databaseId, job.databaseId], [item.rowId, item.targetRowId]]),
    blockMap: new Map(),
    propertyMap,
    templateMap: new Map(),
    pageValues: [{ pageId: item.rowId, databaseId: job.databaseId, values }],
    blockValues: [],
    templateValues: [],
    workspaceId: job.workspaceId,
    actorId: job.requestedBy,
    request,
  });
}

async function prepareDuplicateHierarchyItems(db: DbRef, job: DuplicateHierarchyJob) {
  const candidates = await duplicateHierarchyItems(db, job.id, 'prepared', false, 'asc');
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) return false;
  const pages = await loadDuplicateHierarchyPages(db, items);
  // File-bearing pages are the heavy-payload class: validate one per request.
  // File-free rows retain the existing aggregate preparation window.
  const fileItem = items.find((item) => {
    const page = pages.get(item.rowId)!;
    return hasPotentialStoredFileReference([page.icon, page.cover, page.properties]);
  });
  const preparedItems = fileItem ? [fileItem] : items;
  const fileProperties = fileItem
    ? await duplicateHierarchyFileProperties(db, job.databaseId, [pages.get(fileItem.rowId)!])
    : new Map<string, DbProperty>();
  for (const item of preparedItems) {
    const page = pages.get(item.rowId)!;
    const canonicalParentItem = page.parentType === 'page' && page.parentId
      ? await duplicateHierarchyItemForRow(db, job.id, page.parentId)
      : null;
    const isDatabaseRow = page.parentType === 'database' && page.parentId === job.databaseId;
    const isCanonicalChild = page.parentType === 'page'
      && Boolean(page.parentId)
      && Boolean(canonicalParentItem)
      && !page.subitemParentId;
    if (
      page.kind !== 'page'
      || (!isDatabaseRow && !isCanonicalChild)
    ) {
      throw Object.assign(
        new Error('Bounded hierarchy duplication requires plain database rows.'),
        { status: 409 },
      );
    }
    if (item === fileItem) {
      await duplicateHierarchyPageFilePlans(db, job, item, page, undefined, fileProperties);
    }
  }
  await db.transact([
    duplicateHierarchyJobExpectation(job),
    ...preparedItems.flatMap((item): TransactOperation[] => [
      duplicateHierarchyItemExpectation(item),
      {
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: { prepared: true, sourceUpdatedAt: pages.get(item.rowId)!.updatedAt ?? '' },
      },
    ]),
  ]);
  return candidates.length > preparedItems.length
    || Boolean(await firstDuplicateHierarchyItem(db, job.id, 'prepared', false));
}

async function duplicateHierarchyBlockFilePlans(
  db: DbRef,
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
  block: Block,
  request?: Request,
) {
  if (!hasPotentialStoredFileReference(block.content)) return [];
  const uploads = await loadReferencedUploads(db, job.workspaceId, [{ value: block.content }]);
  return buildDuplicateFilePlans({
    uploads,
    pageMap: new Map([[job.databaseId, job.databaseId], [item.rowId, item.targetRowId]]),
    blockMap: new Map([[block.id, await duplicateHierarchyBlockUuid(job.id, block.id)]]),
    propertyMap: new Map(),
    templateMap: new Map(),
    pageValues: [],
    blockValues: [{ blockId: block.id, pageId: item.rowId, values: [{ value: block.content }] }],
    templateValues: [],
    workspaceId: job.workspaceId,
    actorId: job.requestedBy,
    request,
  });
}

async function prepareDuplicateHierarchyBlocks(
  db: DbRef,
  job: DuplicateHierarchyJob,
  request?: Request,
) {
  const candidates = await duplicateHierarchyBlockStateItems(db, job.id, 'blocksPrepared');
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => !item.prepared || item.sourceUpdatedAt === undefined)) {
    throw Object.assign(new Error('Hierarchy block preflight started before row preflight.'), { status: 409 });
  }
  const rowIds = items.map((item) => item.rowId);
  const firstBlock = (await db.table<Block>('blocks').where('pageId', 'in', rowIds).limit(1).getList()).items?.[0];
  if (!firstBlock) {
    const pages = await loadDuplicateHierarchyPages(db, items);
    const [outgoingEdge, incomingEdge, fileUpload] = await Promise.all([
      duplicateHierarchyDependencyEdgeForRows(db, job, 'outgoing', rowIds),
      duplicateHierarchyDependencyEdgeForRows(db, job, 'incoming', rowIds),
      db.table<FileUpload>('file_uploads').where('pageId', 'in', rowIds).limit(1).getList()
        .then((result) => result.items?.[0]),
    ]);
    const dependenciesPrepared = !outgoingEdge && !incomingEdge;
    const filesApplied = !fileUpload;
    for (const item of items) {
      const page = pages.get(item.rowId)!;
      if ((page.updatedAt ?? '') !== item.sourceUpdatedAt || page.inTrash === true) {
        throw Object.assign(new Error('Hierarchy duplicate source changed during block preflight.'), { status: 409 });
      }
    }
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => [
        duplicateHierarchyItemExpectation(item),
        duplicateHierarchySourcePageExpectation(job, item),
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: {
            blockScanId: '',
            blocksPrepared: true,
            ...(dependenciesPrepared ? { dependenciesPrepared: true } : {}),
            ...(filesApplied ? { filesApplied: true } : {}),
          },
        },
      ]),
    ]);
    return candidates.length > DUPLICATE_HIERARCHY_APPLY_WINDOW;
  }
  const item = items.find((candidate) => candidate.rowId === firstBlock.pageId);
  if (!item) throw Object.assign(new Error('Hierarchy block preflight ownership changed.'), { status: 409 });
  const source = await getExisting(db.table<Page>('pages'), item.rowId);
  if (!source || (source.updatedAt ?? '') !== item.sourceUpdatedAt || source.inTrash === true) {
    throw Object.assign(new Error('Hierarchy duplicate source changed during block preflight.'), { status: 409 });
  }
  const window = await duplicateHierarchyBlockWindow(db, item);
  for (const block of window.rows) {
    await duplicateHierarchyBlockFilePlans(db, job, item, block, request);
    if (block.parentId) {
      const parent = await getExisting(db.table<Block>('blocks'), block.parentId);
      if (!parent || parent.pageId !== item.rowId) {
        throw Object.assign(new Error('Hierarchy block parent changed during preflight.'), { status: 409 });
      }
    }
  }
  const last = window.rows.at(-1);
  await db.transact([
    duplicateHierarchyJobExpectation(job),
    duplicateHierarchyItemExpectation(item),
    duplicateHierarchySourcePageExpectation(job, item),
    ...window.rows.map(duplicateHierarchyBlockExpectation),
    {
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: window.hasMore && last
        ? { blockScanId: last.id }
        : { blockScanId: '', blocksPrepared: true },
    },
  ]);
  return window.hasMore || candidates.length > 1;
}

async function prepareDuplicateHierarchyDependencies(db: DbRef, job: DuplicateHierarchyJob) {
  const candidates = await duplicateHierarchyDependencyStateItems(db, job.id, 'dependenciesPrepared');
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => !item.blocksPrepared || item.sourceUpdatedAt === undefined)) {
    throw Object.assign(new Error('Hierarchy dependency preflight started before block preflight.'), { status: 409 });
  }
  const rowIds = items.map((item) => item.rowId);
  const [anyOutgoing, anyIncoming] = await Promise.all([
    duplicateHierarchyDependencyEdgeForRows(db, job, 'outgoing', rowIds),
    duplicateHierarchyDependencyEdgeForRows(db, job, 'incoming', rowIds),
  ]);
  if (!anyOutgoing && !anyIncoming) {
    const pages = await loadDuplicateHierarchyPages(db, items);
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => {
        const page = pages.get(item.rowId)!;
        if ((page.updatedAt ?? '') !== item.sourceUpdatedAt || page.inTrash === true) {
          throw Object.assign(new Error('Hierarchy source changed during dependency preflight.'), { status: 409 });
        }
        return [
          duplicateHierarchyItemExpectation(item),
          duplicateHierarchySourcePageExpectation(job, item),
          {
            table: 'database_hierarchy_lifecycle_items',
            op: 'update',
            id: item.id,
            data: {
              dependencyLane: 'outgoing',
              dependencyCursorId: '',
              dependenciesPrepared: true,
            },
          },
        ];
      }),
    ]);
    return candidates.length > DUPLICATE_HIERARCHY_APPLY_WINDOW;
  }

  const outgoingItems = items.filter((item) => item.dependencyLane === 'outgoing');
  const lane: 'outgoing' | 'incoming' = outgoingItems.length > 0 ? 'outgoing' : 'incoming';
  const laneItems = lane === 'outgoing' ? outgoingItems : items;
  const firstEdge = await duplicateHierarchyDependencyEdgeForRows(
    db,
    job,
    lane,
    laneItems.map((item) => item.rowId),
  );
  if (!firstEdge) {
    await loadDuplicateHierarchyPages(db, laneItems);
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...laneItems.flatMap((item): TransactOperation[] => [
        duplicateHierarchyItemExpectation(item),
        duplicateHierarchySourcePageExpectation(job, item),
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: lane === 'outgoing'
            ? { dependencyLane: 'incoming', dependencyCursorId: '' }
            : {
                dependencyLane: 'outgoing',
                dependencyCursorId: '',
                dependenciesPrepared: true,
              },
        },
      ]),
    ]);
    return true;
  }
  const ownerId = lane === 'outgoing' ? firstEdge.predecessorRowId : firstEdge.successorRowId;
  const item = laneItems.find((candidate) => candidate.rowId === ownerId);
  if (!item) throw Object.assign(new Error('Hierarchy dependency preflight ownership changed.'), { status: 409 });
  const window = await duplicateHierarchyDependencyEdgeWindow(db, job, item);
  for (const edge of window.rows) {
    await Promise.all([
      assertDuplicateHierarchyDependencyEndpoint(db, job, edge.predecessorRowId),
      assertDuplicateHierarchyDependencyEndpoint(db, job, edge.successorRowId),
    ]);
  }
  const last = window.rows.at(-1);
  await db.transact([
    duplicateHierarchyJobExpectation(job),
    duplicateHierarchyItemExpectation(item),
    duplicateHierarchySourcePageExpectation(job, item),
    ...window.rows.map(duplicateHierarchyDependencyEdgeExpectation),
    {
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: window.hasMore && last
        ? { dependencyCursorId: last.id }
        : lane === 'outgoing'
          ? { dependencyLane: 'incoming', dependencyCursorId: '' }
          : {
              dependencyLane: 'outgoing',
              dependencyCursorId: '',
              dependenciesPrepared: true,
            },
    },
  ]);
  return true;
}

function collectDuplicateHierarchyBlockReferences(
  value: unknown,
  pageIds: Set<string>,
  blockIds: Set<string>,
  depth = 0,
): void {
  if (depth > 64) {
    throw Object.assign(new Error('Hierarchy block content nesting is too deep.'), { status: 409 });
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) collectDuplicateHierarchyBlockReferences(child, pageIds, blockIds, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === 'string'
      && (key === 'pageId' || key === 'childPageId' || key === 'syncedPageId')
    ) pageIds.add(child);
    if (typeof child === 'string' && key === 'syncedBlockId') blockIds.add(child);
    if (pageIds.size + blockIds.size > DUPLICATE_HIERARCHY_BLOCK_REFERENCE_LIMIT) {
      throw Object.assign(
        new Error(`Hierarchy block continuation supports at most ${DUPLICATE_HIERARCHY_BLOCK_REFERENCE_LIMIT} internal references per block.`),
        { status: 413 },
      );
    }
    collectDuplicateHierarchyBlockReferences(child, pageIds, blockIds, depth + 1);
  }
}

async function remapDuplicateHierarchyBlockContent(
  db: DbRef,
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
  block: Block,
) {
  const pageIds = new Set<string>([item.rowId]);
  const blockIds = new Set<string>([block.id]);
  collectDuplicateHierarchyBlockReferences(block.content, pageIds, blockIds);
  const pageMap = new Map<string, string>([[item.rowId, item.targetRowId]]);
  for (const pageId of pageIds) {
    if (pageMap.has(pageId)) continue;
    const referencedItem = await duplicateHierarchyItemForRow(db, job.id, pageId);
    if (referencedItem) pageMap.set(pageId, referencedItem.targetRowId);
  }
  const blockMap = new Map<string, string>([[block.id, await duplicateHierarchyBlockUuid(job.id, block.id)]]);
  for (const blockId of blockIds) {
    if (blockMap.has(blockId)) continue;
    const referencedBlock = await getExisting(db.table<Block>('blocks'), blockId);
    if (!referencedBlock) continue;
    const ownerItem = await duplicateHierarchyItemForRow(db, job.id, referencedBlock.pageId);
    if (ownerItem) blockMap.set(blockId, await duplicateHierarchyBlockUuid(job.id, blockId));
  }
  return remapBlockContent(block.content, pageMap, blockMap);
}

async function applyDuplicateHierarchyBlocks(
  db: DbRef,
  job: DuplicateHierarchyJob,
  actorId: string,
) {
  const candidates = await duplicateHierarchyBlockStateItems(db, job.id, 'blocksApplied');
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => !item.blocksPrepared || !item.applied || item.sourceUpdatedAt === undefined)) {
    throw Object.assign(new Error('Hierarchy block copy started before its fences were ready.'), { status: 409 });
  }
  const rowIds = items.map((item) => item.rowId);
  const firstBlock = (await db.table<Block>('blocks').where('pageId', 'in', rowIds).limit(1).getList()).items?.[0];
  if (!firstBlock) {
    const sourcePages = await loadDuplicateHierarchyPages(db, items);
    const targetIds = items.map((item) => item.targetRowId);
    const loadedTargets = await db.table<Page>('pages').where('id', 'in', targetIds).limit(targetIds.length).getList();
    const targetPages = new Map((loadedTargets.items ?? []).map((page) => [page.id, page]));
    if (targetPages.size !== targetIds.length) {
      throw Object.assign(new Error('Hierarchy block copy target pages changed.'), { status: 409 });
    }
    const [outgoingEdge, incomingEdge] = await Promise.all([
      duplicateHierarchyDependencyEdgeForRows(db, job, 'outgoing', rowIds),
      duplicateHierarchyDependencyEdgeForRows(db, job, 'incoming', rowIds),
    ]);
    const dependenciesApplied = !outgoingEdge && !incomingEdge;
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => {
        const sourcePage = sourcePages.get(item.rowId)!;
        const targetPage = targetPages.get(item.targetRowId)!;
        if (
          (sourcePage.updatedAt ?? '') !== item.sourceUpdatedAt
          || targetPage.inTrash !== true
          || targetPage.trashedAt !== job.trashStamp
        ) throw Object.assign(new Error('Hierarchy block copy page fence changed.'), { status: 409 });
        return [
          duplicateHierarchyItemExpectation(item),
          duplicateHierarchySourcePageExpectation(job, item),
          {
            table: 'pages',
            op: 'expect',
            id: item.targetRowId,
            where: [['inTrash', '==', true], ['trashedAt', '==', job.trashStamp]],
            exists: true,
          },
          {
            table: 'database_hierarchy_lifecycle_items',
            op: 'update',
            id: item.id,
            data: {
              blockScanId: '',
              blocksApplied: true,
              ...(dependenciesApplied ? { dependenciesApplied: true } : {}),
            },
          },
        ];
      }),
    ]);
    return candidates.length > DUPLICATE_HIERARCHY_APPLY_WINDOW;
  }
  const item = items.find((candidate) => candidate.rowId === firstBlock.pageId);
  if (!item) throw Object.assign(new Error('Hierarchy block copy ownership changed.'), { status: 409 });
  const targetPage = await getExisting(db.table<Page>('pages'), item.targetRowId);
  if (!targetPage || targetPage.inTrash !== true || targetPage.trashedAt !== job.trashStamp) {
    throw Object.assign(new Error('Hierarchy block copy target page changed.'), { status: 409 });
  }
  const window = await duplicateHierarchyBlockWindow(db, item);
  const stamp = nowIso();
  const operations: TransactOperation[] = [
    duplicateHierarchyJobExpectation(job),
    duplicateHierarchyItemExpectation(item),
    duplicateHierarchySourcePageExpectation(job, item),
    {
      table: 'pages',
      op: 'expect',
      id: item.targetRowId,
      where: [['inTrash', '==', true], ['trashedAt', '==', job.trashStamp]],
      exists: true,
    },
  ];
  for (const block of window.rows) {
    const targetId = await duplicateHierarchyBlockUuid(job.id, block.id);
    const targetParentId = block.parentId
      ? await duplicateHierarchyBlockUuid(job.id, block.parentId)
      : null;
    const content = await remapDuplicateHierarchyBlockContent(db, job, item, block);
    const existing = await getExisting(db.table<Block>('blocks'), targetId);
    operations.push(duplicateHierarchyBlockExpectation(block));
    if (existing) {
      if (
        existing.pageId !== item.targetRowId
        || (existing.parentId ?? null) !== targetParentId
        || existing.type !== block.type
        || existing.lastMutationId !== `hierarchy-duplicate:${job.id}`
      ) throw Object.assign(new Error('Hierarchy duplicate block target changed during replay.'), { status: 409 });
      operations.push(duplicateHierarchyBlockExpectation(existing));
      continue;
    }
    const target: Block = {
      ...cloneJson(block),
      id: targetId,
      pageId: item.targetRowId,
      parentId: targetParentId,
      content,
      createdBy: actorId,
      lastEditedBy: actorId,
      lastMutationId: `hierarchy-duplicate:${job.id}`,
      createdAt: stamp,
      updatedAt: stamp,
    };
    operations.push(
      { table: 'blocks', op: 'expect', id: targetId, exists: false },
      { table: 'blocks', op: 'insert', data: target as unknown as Record<string, unknown> },
    );
  }
  const last = window.rows.at(-1);
  operations.push({
    table: 'database_hierarchy_lifecycle_items',
    op: 'update',
    id: item.id,
    data: window.hasMore && last
      ? { blockScanId: last.id }
      : { blockScanId: last?.id ?? '', blocksApplied: true },
  });
  await db.transact(operations);
  return window.hasMore || candidates.length > 1;
}

async function nextDuplicateHierarchyFileUpload(
  db: DbRef,
  item: DuplicateHierarchyItem,
) {
  let query: TableQuery<FileUpload> = db.table<FileUpload>('file_uploads')
    .where('pageId', '==', item.rowId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy file copy requires bounded upload keysets.'), { status: 500 });
  }
  if (item.fileCursorId) query = query.where!('id', '>', item.fileCursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

async function stableDuplicateHierarchyFilePlan(
  db: DbRef,
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
  sourceUpload: FileUpload,
  sourceBlock: Block,
  request?: Request,
) {
  const plans = await duplicateHierarchyBlockFilePlans(db, job, item, sourceBlock, request);
  const plan = plans.find((candidate) => candidate.source.id === sourceUpload.id);
  if (!plan) return null;
  const id = await duplicateHierarchyFileUuid(job.id, sourceUpload.id);
  const name = (optionalString(sourceUpload.name) ?? 'Untitled').slice(0, 180);
  const bucket = uploadBucket(sourceUpload);
  const key = `workspaces/${job.workspaceId}/duplicate-page/${id}-${cleanFileSegment(name)}${extensionFromName(name)}`;
  plan.target = {
    ...plan.target,
    id,
    key,
    url: storageUrl(request, bucket, key),
  };
  return plan;
}

async function stableDuplicateHierarchyPageFilePlan(
  db: DbRef,
  job: DuplicateHierarchyJob,
  item: DuplicateHierarchyItem,
  sourceUpload: FileUpload,
  sourcePage: Page,
  fileProperties: Map<string, DbProperty>,
  request?: Request,
) {
  const plans = await duplicateHierarchyPageFilePlans(
    db,
    job,
    item,
    sourcePage,
    request,
    fileProperties,
  );
  const plan = plans.find((candidate) => candidate.source.id === sourceUpload.id);
  if (!plan) return null;
  const id = await duplicateHierarchyFileUuid(job.id, sourceUpload.id);
  const name = (optionalString(sourceUpload.name) ?? 'Untitled').slice(0, 180);
  const bucket = uploadBucket(sourceUpload);
  const key = `workspaces/${job.workspaceId}/duplicate-page/${id}-${cleanFileSegment(name)}${extensionFromName(name)}`;
  plan.target = {
    ...plan.target,
    id,
    key,
    url: storageUrl(request, bucket, key),
  };
  return plan;
}

async function ensureDuplicateHierarchyFileCopy(input: {
  db: DbRef;
  admin: AdminDbAccessor;
  workspace: Workspace;
  plan: DuplicateFilePlan;
  storage: DuplicateStorageProxy | undefined;
  lease: FileWorkspaceLeaseGuard;
}) {
  const { db, admin, workspace, plan, storage, lease } = input;
  const existingTarget = await getExisting(db.table<FileUpload>('file_uploads'), plan.target.id);
  if (existingTarget) {
    const associations = ['pageId', 'blockId', 'databaseId', 'propertyId', 'templateId'] as const;
    if (
      existingTarget.workspaceId !== plan.target.workspaceId
      || existingTarget.key !== plan.target.key
      || uploadBucket(existingTarget) !== uploadBucket(plan.target)
      || associations.some((field) => (
        (existingTarget[field] ?? null) !== (plan.target[field] ?? null)
      ))
    ) {
      throw Object.assign(new Error('Hierarchy file target ownership changed.'), { status: 409 });
    }
    if (existingTarget.status === 'uploaded') {
      plan.target = existingTarget;
    } else {
      plan.target = existingTarget;
      plan.rowCreated = true;
      plan.objectWriteAttempted = true;
      plan.reservation = workspace.organizationId ? {
        id: existingTarget.id,
        organizationId: workspace.organizationId,
        workspaceId: workspace.id,
        bytes: typeof existingTarget.size === 'number' ? existingTarget.size : 0,
      } : null;
      if (!(await rollbackDuplicatedFiles({ db, admin, plans: [plan], storage }))) {
        throw new Error('Hierarchy file retry cleanup did not complete.');
      }
      plan.rowCreated = false;
      plan.objectWriteAttempted = false;
      plan.reservation = null;
      plan.target.status = 'preparing';
    }
  }
  if (plan.target.status !== 'uploaded') {
    await copyDuplicatedFiles({ db, admin, workspace, plans: [plan], storage, lease });
  }
}

async function applyDuplicateHierarchyFiles(
  db: DbRef,
  admin: AdminDbAccessor,
  job: DuplicateHierarchyJob,
  storage: DuplicateStorageProxy | undefined,
  request: Request | undefined,
  lease: FileWorkspaceLeaseGuard,
) {
  const candidates = await duplicateHierarchyFileStateItems(db, job.id);
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => !item.blocksApplied || !item.applied || item.sourceUpdatedAt === undefined)) {
    throw Object.assign(new Error('Hierarchy file copy started before hidden content was ready.'), { status: 409 });
  }
  const nextUploads = await Promise.all(items.map((item) => nextDuplicateHierarchyFileUpload(db, item)));
  const activeIndex = nextUploads.findIndex(Boolean);
  if (activeIndex === -1) {
    const targets = await db.table<Page>('pages')
      .where('id', 'in', items.map((item) => item.targetRowId))
      .limit(items.length)
      .getList();
    const targetsById = new Map((targets.items ?? []).map((page) => [page.id, page]));
    if (targetsById.size !== items.length) {
      throw Object.assign(new Error('Hierarchy file copy target pages changed.'), { status: 409 });
    }
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => [
        duplicateHierarchyItemExpectation(item),
        duplicateHierarchySourcePageExpectation(job, item),
        {
          table: 'pages',
          op: 'expect',
          id: item.targetRowId,
          where: [['inTrash', '==', true], ['trashedAt', '==', job.trashStamp]],
          exists: true,
        },
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: { filesApplied: true },
        },
      ]),
    ]);
    return candidates.length > DUPLICATE_HIERARCHY_APPLY_WINDOW;
  }
  const item = items[activeIndex]!;
  const sourceUpload = nextUploads[activeIndex]!;
  const advanceWithoutCopy = async () => {
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      duplicateHierarchyItemExpectation(item),
      duplicateHierarchySourcePageExpectation(job, item),
      {
        table: 'file_uploads',
        op: 'expect',
        id: sourceUpload.id,
        where: [['pageId', '==', item.rowId]],
        exists: true,
      },
      {
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: { fileCursorId: sourceUpload.id },
      },
    ]);
    return true;
  };
  let sourceBlock: Block | null = null;
  let targetBlock: Block | null = null;
  let sourcePage: Page | null = null;
  let targetPage: Page | null = null;
  let pageFileProperties = new Map<string, DbProperty>();
  let plan: DuplicateFilePlan | null;
  if (sourceUpload.blockId) {
    sourceBlock = await getExisting(db.table<Block>('blocks'), sourceUpload.blockId);
    if (!sourceBlock || sourceBlock.pageId !== item.rowId) {
      throw Object.assign(new Error('Hierarchy file source block changed.'), { status: 409 });
    }
    plan = await stableDuplicateHierarchyFilePlan(
      db,
      job,
      item,
      sourceUpload,
      sourceBlock,
      request,
    );
    const targetBlockId = await duplicateHierarchyBlockUuid(job.id, sourceBlock.id);
    targetBlock = await getExisting(db.table<Block>('blocks'), targetBlockId);
    if (!targetBlock || targetBlock.pageId !== item.targetRowId) {
      throw Object.assign(new Error('Hierarchy file target block changed.'), { status: 409 });
    }
  } else {
    sourcePage = await getExisting(db.table<Page>('pages'), item.rowId);
    if (
      !sourcePage
      || sourcePage.inTrash === true
      || (sourcePage.updatedAt ?? '') !== item.sourceUpdatedAt
    ) {
      throw Object.assign(new Error('Hierarchy file source page changed.'), { status: 409 });
    }
    pageFileProperties = await duplicateHierarchyFileProperties(db, job.databaseId, [sourcePage]);
    plan = await stableDuplicateHierarchyPageFilePlan(
      db,
      job,
      item,
      sourceUpload,
      sourcePage,
      pageFileProperties,
      request,
    );
    targetPage = await getExisting(db.table<Page>('pages'), item.targetRowId);
    if (!targetPage || targetPage.inTrash !== true || targetPage.trashedAt !== job.trashStamp) {
      throw Object.assign(new Error('Hierarchy file target page changed.'), { status: 409 });
    }
  }
  if (!plan) return advanceWithoutCopy();
  const workspace = await getExisting(admin.db('app').table<Workspace>('workspaces'), job.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  await ensureDuplicateHierarchyFileCopy({ db, admin, workspace, plan, storage, lease });
  const sourceUploadExpectation: TransactOperation = {
    table: 'file_uploads',
    op: 'expect',
    id: sourceUpload.id,
    where: [
      ['pageId', '==', item.rowId],
      ['blockId', '==', sourceBlock?.id ?? null],
      ['databaseId', '==', sourceUpload.databaseId ?? null],
      ['propertyId', '==', sourceUpload.propertyId ?? null],
      ['status', '==', 'uploaded'],
      ['etag', '==', sourceUpload.etag ?? null],
    ],
    exists: true,
  };
  const targetUploadExpectation: TransactOperation = {
    table: 'file_uploads',
    op: 'expect',
    id: plan.target.id,
    where: [
      ['pageId', '==', item.targetRowId],
      ['blockId', '==', targetBlock?.id ?? null],
      ['databaseId', '==', plan.target.databaseId ?? null],
      ['propertyId', '==', plan.target.propertyId ?? null],
      ['status', '==', 'uploaded'],
    ],
    exists: true,
  };
  const operations: TransactOperation[] = [
    duplicateHierarchyJobExpectation(job),
    duplicateHierarchyItemExpectation(item),
    duplicateHierarchySourcePageExpectation(job, item),
    ...(sourceBlock ? [duplicateHierarchyBlockExpectation(sourceBlock)] : []),
    ...(targetBlock ? [duplicateHierarchyBlockExpectation(targetBlock)] : []),
    sourceUploadExpectation,
    targetUploadExpectation,
  ];
  if (targetBlock) {
    const content = remapStoredFileReferences(targetBlock.content, [plan]) as Record<string, unknown> | undefined;
    operations.push({
      table: 'blocks',
      op: 'update',
      id: targetBlock.id,
      data: { content, updatedAt: nowIso(), lastEditedBy: job.requestedBy },
    });
  } else if (targetPage) {
    const propertyMap = new Map(Array.from(pageFileProperties.keys(), (propertyId) => [propertyId, propertyId]));
    const properties = remapProperties(
      targetPage.properties,
      propertyMap,
      new Map(),
      pageFileProperties,
      [plan],
    );
    operations.push(
      {
        table: 'pages',
        op: 'expect',
        id: targetPage.id,
        where: [
          ['inTrash', '==', true],
          ['trashedAt', '==', job.trashStamp],
          ['updatedAt', '==', targetPage.updatedAt ?? null],
        ],
        exists: true,
      },
      {
        table: 'pages',
        op: 'update',
        id: targetPage.id,
        data: {
          ...(targetPage.icon !== undefined ? {
            icon: remapStoredFileReferences(targetPage.icon, [plan], true),
          } : {}),
          ...(targetPage.cover !== undefined ? {
            cover: remapStoredFileReferences(targetPage.cover, [plan], true),
          } : {}),
          ...(targetPage.properties !== undefined ? { properties } : {}),
          updatedAt: nowIso(),
          lastEditedBy: job.requestedBy,
        },
      },
    );
  }
  operations.push({
      table: 'database_hierarchy_lifecycle_items',
      op: 'update',
      id: item.id,
      data: { fileCursorId: sourceUpload.id },
  });
  await db.transact(operations);
  return true;
}

async function duplicateHierarchyDependencyTarget(
  db: DbRef,
  job: DuplicateHierarchyJob,
  sourceRowId: string,
) {
  const item = await duplicateHierarchyItemForRow(db, job.id, sourceRowId);
  const targetRowId = item?.targetRowId ?? sourceRowId;
  const page = await getExisting(db.table<Page>('pages'), targetRowId);
  if (item) {
    if (!page || page.inTrash !== true || page.trashedAt !== job.trashStamp) {
      throw Object.assign(new Error('Hierarchy dependency target page changed.'), { status: 409 });
    }
    return {
      targetRowId,
      expectation: {
        table: 'pages',
        op: 'expect',
        id: targetRowId,
        where: [['inTrash', '==', true], ['trashedAt', '==', job.trashStamp]],
        exists: true,
      } as TransactOperation,
      internal: true,
    };
  }
  if (
    !page
    || page.workspaceId !== job.workspaceId
    || page.parentType !== 'database'
    || page.parentId !== job.databaseId
    || page.inTrash === true
  ) throw Object.assign(new Error('Hierarchy dependency external endpoint changed.'), { status: 409 });
  return {
    targetRowId,
    expectation: {
      table: 'pages',
      op: 'expect',
      id: targetRowId,
      where: [
        ['workspaceId', '==', job.workspaceId],
        ['parentId', '==', job.databaseId],
        ['parentType', '==', 'database'],
        ['inTrash', '==', false],
      ],
      exists: true,
    } as TransactOperation,
    internal: false,
  };
}

async function applyDuplicateHierarchyDependencies(
  db: DbRef,
  job: DuplicateHierarchyJob,
  actorId: string,
) {
  const candidates = await duplicateHierarchyDependencyStateItems(db, job.id, 'dependenciesApplied');
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) return false;
  if (items.some((item) => !item.dependenciesPrepared || !item.blocksApplied)) {
    throw Object.assign(new Error('Hierarchy dependency copy started before block copy.'), { status: 409 });
  }
  const rowIds = items.map((item) => item.rowId);
  const [anyOutgoing, anyIncoming] = await Promise.all([
    duplicateHierarchyDependencyEdgeForRows(db, job, 'outgoing', rowIds),
    duplicateHierarchyDependencyEdgeForRows(db, job, 'incoming', rowIds),
  ]);
  if (!anyOutgoing && !anyIncoming) {
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => [
        duplicateHierarchyItemExpectation(item),
        duplicateHierarchySourcePageExpectation(job, item),
        {
          table: 'pages',
          op: 'expect',
          id: item.targetRowId,
          where: [['inTrash', '==', true], ['trashedAt', '==', job.trashStamp]],
          exists: true,
        },
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: {
            dependencyLane: 'outgoing',
            dependencyCursorId: '',
            dependenciesApplied: true,
          },
        },
      ]),
    ]);
    return candidates.length > DUPLICATE_HIERARCHY_APPLY_WINDOW;
  }

  const outgoingItems = items.filter((item) => item.dependencyLane === 'outgoing');
  const lane: 'outgoing' | 'incoming' = outgoingItems.length > 0 ? 'outgoing' : 'incoming';
  const laneItems = lane === 'outgoing' ? outgoingItems : items;
  const firstEdge = await duplicateHierarchyDependencyEdgeForRows(
    db,
    job,
    lane,
    laneItems.map((item) => item.rowId),
  );
  if (!firstEdge) {
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...laneItems.flatMap((item): TransactOperation[] => [
        duplicateHierarchyItemExpectation(item),
        duplicateHierarchySourcePageExpectation(job, item),
        {
          table: 'pages',
          op: 'expect',
          id: item.targetRowId,
          where: [['inTrash', '==', true], ['trashedAt', '==', job.trashStamp]],
          exists: true,
        },
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: lane === 'outgoing'
            ? { dependencyLane: 'incoming', dependencyCursorId: '' }
            : { dependencyCursorId: '', dependenciesApplied: true },
        },
      ]),
    ]);
    return true;
  }
  const ownerId = lane === 'outgoing' ? firstEdge.predecessorRowId : firstEdge.successorRowId;
  const item = laneItems.find((candidate) => candidate.rowId === ownerId);
  if (!item) throw Object.assign(new Error('Hierarchy dependency copy ownership changed.'), { status: 409 });
  const window = await duplicateHierarchyDependencyEdgeWindow(db, job, item);
  const operations: TransactOperation[] = [
    duplicateHierarchyJobExpectation(job),
    duplicateHierarchyItemExpectation(item),
    duplicateHierarchySourcePageExpectation(job, item),
  ];
  const stamp = nowIso();
  for (const edge of window.rows) {
    operations.push(duplicateHierarchyDependencyEdgeExpectation(edge));
    const [predecessor, successor] = await Promise.all([
      duplicateHierarchyDependencyTarget(db, job, edge.predecessorRowId),
      duplicateHierarchyDependencyTarget(db, job, edge.successorRowId),
    ]);
    if (lane === 'incoming' && predecessor.internal) continue;
    const targetId = await duplicateHierarchyHash('duplicate-hierarchy-dependency-edge', job.id, edge.id);
    const existing = await getExisting(
      db.table<DuplicateHierarchyDependencyEdge>('database_dependency_edges'),
      targetId,
    );
    operations.push(predecessor.expectation, successor.expectation);
    if (existing) {
      if (
        existing.workspaceId !== job.workspaceId
        || existing.databaseId !== job.databaseId
        || existing.predecessorRowId !== predecessor.targetRowId
        || existing.successorRowId !== successor.targetRowId
      ) throw Object.assign(new Error('Hierarchy dependency copy target changed during replay.'), { status: 409 });
      operations.push(duplicateHierarchyDependencyEdgeExpectation(existing));
      continue;
    }
    const target: DuplicateHierarchyDependencyEdge = {
      id: targetId,
      workspaceId: job.workspaceId,
      databaseId: job.databaseId,
      predecessorRowId: predecessor.targetRowId,
      successorRowId: successor.targetRowId,
      createdBy: actorId,
      createdAt: stamp,
      updatedAt: stamp,
    };
    operations.push(
      { table: 'database_dependency_edges', op: 'expect', id: targetId, exists: false },
      { table: 'database_dependency_edges', op: 'insert', data: target as unknown as Record<string, unknown> },
    );
  }
  const last = window.rows.at(-1);
  operations.push({
    table: 'database_hierarchy_lifecycle_items',
    op: 'update',
    id: item.id,
    data: window.hasMore && last
      ? { dependencyCursorId: last.id }
      : lane === 'outgoing'
        ? { dependencyLane: 'incoming', dependencyCursorId: '' }
        : { dependencyCursorId: last?.id ?? '', dependenciesApplied: true },
  });
  await db.transact(operations);
  return true;
}

async function applyDuplicateHierarchyItems(
  db: DbRef,
  admin: AdminDbAccessor,
  database: Page,
  source: Page,
  body: Record<string, unknown>,
  actorId: string,
  job: DuplicateHierarchyJob,
) {
  const candidates = await duplicateHierarchyItems(db, job.id, 'applied', false, 'asc');
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) return false;
  let relationProbe: TableQuery<DbProperty> = db.table<DbProperty>('db_properties')
    .where('databaseId', '==', job.databaseId);
  if (typeof relationProbe.where !== 'function') {
    throw Object.assign(new Error('Hierarchy relation copy requires bounded schema lookup.'), { status: 500 });
  }
  relationProbe = relationProbe.where!('type', '==', 'relation');
  if (typeof relationProbe.includeTotal === 'function') relationProbe = relationProbe.includeTotal(false);
  const relationResult = await relationProbe.limit(3).getList();
  const noOrdinaryRelations = relationResult.hasMore !== true
    && (relationResult.items ?? []).every((property) => Boolean(duplicateRelationFeatureRole(property)));
  const pages = await loadDuplicateHierarchyPages(db, items);
  const labels = persistentGeneratedLabels(parsePersistentGeneratedLocale(body.locale));
  const nextSiblingQuery = db.table<Page>('pages')
    .where('parentId', '==', database.id);
  let orderedSiblingQuery = nextSiblingQuery;
  if (typeof orderedSiblingQuery.where === 'function' && typeof orderedSiblingQuery.orderBy === 'function') {
    orderedSiblingQuery = orderedSiblingQuery
      .where!('parentType', '==', 'database')
      .where!('subitemParentId', '==', source.subitemParentId ?? '')
      .where!('inTrash', '==', false)
      .where!('position', '>', source.position ?? 0)
      .orderBy!('position', 'asc')
      .orderBy!('id', 'asc');
  }
  if (typeof orderedSiblingQuery.includeTotal === 'function') orderedSiblingQuery = orderedSiblingQuery.includeTotal(false);
  const nextSibling = (await orderedSiblingQuery.limit(1).getList()).items?.[0];
  for (const item of items) {
    const current = pages.get(item.rowId)!;
    const targetId = item.targetRowId;
    const canonicalPageChild = current.parentType === 'page' && Boolean(current.parentId);
    const targetContainerId = canonicalPageChild
      ? await duplicateHierarchyUuid(job.id, current.parentId!)
      : job.databaseId;
    const targetContainerType: PageParentType = canonicalPageChild ? 'page' : 'database';
    const targetSubitemParentId = canonicalPageChild
      ? ''
      : current.id === source.id
        ? current.subitemParentId ?? ''
        : await duplicateHierarchyUuid(job.id, current.subitemParentId ?? '');
    const existing = await getExisting(db.table<Page>('pages'), targetId);
    if (existing) {
      if (
        existing.workspaceId !== job.workspaceId
        || existing.parentId !== targetContainerId
        || existing.parentType !== targetContainerType
        || existing.trashedAt !== job.trashStamp
      ) throw Object.assign(new Error('Hierarchy duplicate target changed during replay.'), { status: 409 });
      await ensurePageWorkspaceIndex(admin, existing.id, existing.workspaceId);
      await db.transact([
        duplicateHierarchyJobExpectation(job),
        duplicateHierarchyItemExpectation(item),
        duplicateHierarchySourcePageExpectation(job, item),
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: { applied: true, ...(noOrdinaryRelations ? { relationsPrepared: true } : {}) },
        },
      ]);
      continue;
    }
    const stamp = nowIso();
    const target: Page = {
      ...cloneJson(current),
      id: targetId,
      parentId: targetContainerId,
      parentType: targetContainerType,
      subitemParentId: targetSubitemParentId,
      subitemChildCount: exactDuplicateSubitemChildCount(current),
      title: current.id === source.id
        ? typeof body.title === 'string'
          ? body.title
          : labels.copyName(source.title || labels.untitled)
        : current.title,
      position: current.id === source.id
        ? positionBetween(source.position, nextSibling?.position)
        : current.position,
      inTrash: true,
      trashedAt: job.trashStamp,
      isFavorite: false,
      isPublic: false,
      createdBy: actorId,
      lastEditedBy: actorId,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      duplicateHierarchyItemExpectation(item),
      duplicateHierarchySourcePageExpectation(job, item),
      { table: 'pages', op: 'expect', id: target.id, exists: false },
      { table: 'pages', op: 'insert', data: target as unknown as Record<string, unknown> },
      {
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: { applied: true, ...(noOrdinaryRelations ? { relationsPrepared: true } : {}) },
      },
    ]);
    await ensurePageWorkspaceIndex(admin, target.id, target.workspaceId);
  }
  return candidates.length > DUPLICATE_HIERARCHY_APPLY_WINDOW
    || Boolean(await firstDuplicateHierarchyItem(db, job.id, 'applied', false));
}

function duplicateRelationIds(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && Boolean(id))))
    : typeof value === 'string' && value
      ? [value]
      : [];
}

function duplicateRelationDatabaseId(property: DbProperty) {
  const config = objectRecord(property.config);
  return typeof config?.relationDatabaseId === 'string' && config.relationDatabaseId
    ? config.relationDatabaseId
    : property.databaseId;
}

function duplicateRelationFeatureRole(property: DbProperty) {
  const role = objectRecord(property.config)?.databaseFeatureRole;
  return typeof role === 'string' ? role : '';
}

async function nextDuplicateHierarchyRelationProperty(
  db: DbRef,
  job: DuplicateHierarchyJob,
  cursorId: string,
) {
  let query: TableQuery<DbProperty> = db.table<DbProperty>('db_properties')
    .where('databaseId', '==', job.databaseId);
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy relation copy requires bounded schema keysets.'), { status: 500 });
  }
  query = query.where!('type', '==', 'relation');
  if (cursorId) query = query.where!('id', '>', cursorId);
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  return (await query.limit(1).getList()).items?.[0] ?? null;
}

function hierarchyRelationUpdateExpectation(update: HierarchyRelationUpdate): TransactOperation {
  return {
    table: 'database_hierarchy_relation_updates',
    op: 'expect',
    id: update.id,
    where: [
      ['jobId', '==', update.jobId],
      ['rowId', '==', update.rowId],
      ['sourceUpdatedAt', '==', update.sourceUpdatedAt],
    ],
    exists: true,
  };
}

async function prepareDuplicateHierarchyRelations(
  db: DbRef,
  job: DuplicateHierarchyJob,
) {
  let schemaProbe: TableQuery<DbProperty> = db.table<DbProperty>('db_properties')
    .where('databaseId', '==', job.databaseId);
  if (typeof schemaProbe.where !== 'function') {
    throw Object.assign(new Error('Hierarchy relation copy requires bounded schema lookup.'), { status: 500 });
  }
  schemaProbe = schemaProbe.where!('type', '==', 'relation');
  if (typeof schemaProbe.includeTotal === 'function') schemaProbe = schemaProbe.includeTotal(false);
  const schemaResult = await schemaProbe.limit(3).getList();
  if (
    schemaResult.hasMore !== true
    && (schemaResult.items ?? []).every((property) => Boolean(duplicateRelationFeatureRole(property)))
  ) {
    const candidates = await duplicateHierarchyRelationStateItems(db, job.id);
    const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
    if (items.length === 0) return false;
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      ...items.flatMap((item): TransactOperation[] => [
        duplicateHierarchyItemExpectation(item),
        {
          table: 'database_hierarchy_lifecycle_items',
          op: 'update',
          id: item.id,
          data: { relationsPrepared: true },
        },
      ]),
    ]);
    return true;
  }
  const item = await firstDuplicateHierarchyItem(db, job.id, 'relationsPrepared', false);
  if (!item) return false;
  if (!item.applied || item.sourceUpdatedAt === undefined) {
    throw Object.assign(new Error('Hierarchy relation copy started before hidden page staging.'), { status: 409 });
  }
  const [source, target] = await Promise.all([
    getExisting(db.table<Page>('pages'), item.rowId),
    getExisting(db.table<Page>('pages'), item.targetRowId),
  ]);
  if (
    !source
    || (source.updatedAt ?? '') !== item.sourceUpdatedAt
    || !target
    || target.inTrash !== true
    || target.trashedAt !== job.trashStamp
  ) throw Object.assign(new Error('Hierarchy relation copy page fence changed.'), { status: 409 });

  const property = item.relationValueOffset > 0
    ? await getExisting(db.table<DbProperty>('db_properties'), item.relationPropertyCursorId)
    : await nextDuplicateHierarchyRelationProperty(db, job, item.relationPropertyCursorId);
  if (!property) {
    if (item.relationValueOffset > 0) {
      throw Object.assign(new Error('Hierarchy relation copy schema changed during continuation.'), { status: 409 });
    }
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      duplicateHierarchyItemExpectation(item),
      duplicateHierarchySourcePageExpectation(job, item),
      {
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: { relationsPrepared: true },
      },
    ]);
    return true;
  }
  if (property.databaseId !== job.databaseId || property.type !== 'relation') {
    throw Object.assign(new Error('Hierarchy relation copy schema changed during continuation.'), { status: 409 });
  }
  if (duplicateRelationFeatureRole(property)) {
    await db.transact([
      duplicateHierarchyJobExpectation(job),
      duplicateHierarchyItemExpectation(item),
      duplicateHierarchySourcePageExpectation(job, item),
      {
        table: 'database_hierarchy_lifecycle_items',
        op: 'update',
        id: item.id,
        data: { relationPropertyCursorId: property.id },
      },
    ]);
    return true;
  }

  const plans = new Map<string, { update: HierarchyRelationUpdate; existing: boolean; page: Page }>();
  const planFor = async (page: Page) => {
    const cached = plans.get(page.id);
    if (cached) return cached.update;
    const id = await duplicateHierarchyHash('hierarchy-relation-update', job.id, page.id);
    const existing = await getExisting(
      db.table<HierarchyRelationUpdate>('database_hierarchy_relation_updates'),
      id,
    );
    if (existing && existing.sourceUpdatedAt !== (page.updatedAt ?? '')) {
      throw Object.assign(new Error('Hierarchy relation copy plan changed.'), { status: 409 });
    }
    const update = existing ?? {
      id,
      workspaceId: job.workspaceId,
      databaseId: job.databaseId,
      jobId: job.id,
      rowId: page.id,
      sourceUpdatedAt: page.updatedAt ?? '',
      properties: cloneJson(page.properties ?? {}),
    };
    plans.set(page.id, { update, existing: Boolean(existing), page });
    return update;
  };

  const targetPlan = await planFor(target);
  const sourceIds = duplicateRelationIds(source.properties?.[property.id]);
  const valueStart = item.relationValueOffset;
  const valueEnd = Math.min(valueStart + DUPLICATE_HIERARCHY_RELATION_VALUE_WINDOW, sourceIds.length);
  const valueWindow = sourceIds.slice(valueStart, valueEnd);
  const mappedIds = valueStart > 0
    ? duplicateRelationIds(targetPlan.properties[property.id])
    : [];
  const relationDatabaseId = duplicateRelationDatabaseId(property);
  const reciprocalId = typeof objectRecord(property.config)?.relatedPropertyId === 'string'
    ? String(objectRecord(property.config)?.relatedPropertyId)
    : '';
  const reciprocal = reciprocalId
    ? await getExisting(db.table<DbProperty>('db_properties'), reciprocalId)
    : null;
  for (const relationId of valueWindow) {
    const internal = await duplicateHierarchyItemForRow(db, job.id, relationId);
    if (internal) {
      mappedIds.push(internal.targetRowId);
      continue;
    }
    const external = await getExisting(db.table<Page>('pages'), relationId);
    if (
      !external
      || external.workspaceId !== job.workspaceId
      || external.parentType !== 'database'
      || external.parentId !== relationDatabaseId
      || external.inTrash === true
    ) throw Object.assign(new Error('Hierarchy relation copy target changed.'), { status: 409 });
    mappedIds.push(external.id);
    if (
      reciprocal
      && reciprocal.type === 'relation'
      && reciprocal.databaseId === relationDatabaseId
      && duplicateRelationDatabaseId(reciprocal) === job.databaseId
    ) {
      const externalPlan = await planFor(external);
      externalPlan.properties[reciprocal.id] = Array.from(new Set([
        ...duplicateRelationIds(externalPlan.properties[reciprocal.id]),
        item.targetRowId,
      ]));
    }
  }
  targetPlan.properties[property.id] = mappedIds.length ? mappedIds : null;
  const hasMoreValues = valueEnd < sourceIds.length;

  const operations: TransactOperation[] = [
    duplicateHierarchyJobExpectation(job),
    duplicateHierarchyItemExpectation(item),
    duplicateHierarchySourcePageExpectation(job, item),
  ];
  for (const plan of plans.values()) {
    operations.push({
      table: 'pages',
      op: 'expect',
      id: plan.page.id,
      where: [['updatedAt', '==', plan.page.updatedAt ?? null]],
      exists: true,
    });
    if (plan.existing) {
      operations.push(
        hierarchyRelationUpdateExpectation(plan.update),
        {
          table: 'database_hierarchy_relation_updates',
          op: 'update',
          id: plan.update.id,
          data: { properties: plan.update.properties },
        },
      );
    } else {
      operations.push(
        { table: 'database_hierarchy_relation_updates', op: 'expect', id: plan.update.id, exists: false },
        {
          table: 'database_hierarchy_relation_updates',
          op: 'insert',
          data: plan.update as unknown as Record<string, unknown>,
        },
      );
    }
  }
  operations.push({
    table: 'database_hierarchy_lifecycle_items',
    op: 'update',
    id: item.id,
    data: hasMoreValues
      ? { relationPropertyCursorId: property.id, relationValueOffset: valueEnd }
      : { relationPropertyCursorId: property.id, relationValueOffset: 0 },
  });
  await db.transact(operations);
  return true;
}

async function applyDuplicateHierarchyRelationUpdates(
  db: DbRef,
  job: DuplicateHierarchyJob,
) {
  let query: TableQuery<HierarchyRelationUpdate> = db
    .table<HierarchyRelationUpdate>('database_hierarchy_relation_updates')
    .where('jobId', '==', job.id);
  if (typeof query.orderBy !== 'function') {
    throw Object.assign(new Error('Hierarchy relation copy requires bounded update keysets.'), { status: 500 });
  }
  query = query.orderBy!('id', 'asc');
  if (typeof query.includeTotal === 'function') query = query.includeTotal(false);
  const plans = (await query.limit(DUPLICATE_HIERARCHY_APPLY_WINDOW).getList()).items ?? [];
  if (plans.length === 0) return false;
  const rows = await db.table<Page>('pages')
    .where('id', 'in', plans.map((plan) => plan.rowId))
    .limit(plans.length)
    .getList();
  const byId = new Map((rows.items ?? []).map((page) => [page.id, page]));
  if (byId.size !== plans.length) {
    throw Object.assign(new Error('Hierarchy relation copy update target changed.'), { status: 409 });
  }
  const stamp = nowIso();
  const operations: TransactOperation[] = [duplicateHierarchyJobExpectation(job)];
  for (const plan of plans) {
    const page = byId.get(plan.rowId)!;
    if ((page.updatedAt ?? '') !== plan.sourceUpdatedAt) {
      throw Object.assign(new Error('Hierarchy relation copy update target changed.'), { status: 409 });
    }
    operations.push(
      hierarchyRelationUpdateExpectation(plan),
      {
        table: 'pages',
        op: 'expect',
        id: page.id,
        where: [['updatedAt', '==', page.updatedAt ?? null]],
        exists: true,
      },
      {
        table: 'pages',
        op: 'update',
        id: page.id,
        data: { properties: plan.properties, updatedAt: stamp, lastEditedBy: job.requestedBy },
      },
      { table: 'database_hierarchy_relation_updates', op: 'delete', id: plan.id },
    );
  }
  await db.transact(operations);
  return true;
}

async function publishDuplicateHierarchyItems(
  db: DbRef,
  database: Page,
  job: DuplicateHierarchyJob,
  actorId: string,
) {
  const candidates = await duplicateHierarchyItems(db, job.id, 'applied', true, 'desc');
  const items = candidates.slice(0, DUPLICATE_HIERARCHY_APPLY_WINDOW);
  if (items.length === 0) {
    throw Object.assign(new Error('Hierarchy duplicate publication state is incomplete.'), { status: 409 });
  }
  const targetIds = items.map((item) => item.targetRowId);
  const result = await db.table<Page>('pages').where('id', 'in', targetIds).limit(targetIds.length).getList();
  const targets = new Map((result.items ?? []).map((page) => [page.id, page]));
  const finishing = candidates.length <= DUPLICATE_HIERARCHY_APPLY_WINDOW;
  const externalParent = finishing && job.sourceParentId
    ? await getExisting(db.table<Page>('pages'), job.sourceParentId)
    : null;
  if (job.sourceParentId && finishing && (
    !externalParent
    || externalParent.workspaceId !== job.workspaceId
    || externalParent.parentId !== job.databaseId
    || externalParent.parentType !== 'database'
    || externalParent.kind === 'database'
  )) {
    throw Object.assign(
      new Error('External sub-item parent changed during duplicate publication.'),
      { status: 409 },
    );
  }
  const stamp = nowIso();
  const operations: TransactOperation[] = [duplicateHierarchyJobExpectation(job)];
  for (const item of items) {
    if (
      item.relationsPrepared !== true
      || item.blocksApplied !== true
      || item.dependenciesApplied !== true
      || item.filesApplied !== true
    ) {
      throw Object.assign(new Error('Hierarchy duplicate related-content copy is incomplete.'), { status: 409 });
    }
    const target = targets.get(item.targetRowId);
    if (!target || target.inTrash !== true || target.trashedAt !== job.trashStamp) {
      throw Object.assign(new Error('Hierarchy duplicate staging state changed.'), { status: 409 });
    }
    operations.push(
      duplicateHierarchySourcePageExpectation(job, item),
      { table: 'pages', op: 'expect', id: target.id, where: [['inTrash', '==', true], ['trashedAt', '==', job.trashStamp]], exists: true },
      { table: 'pages', op: 'update', id: target.id, data: { inTrash: false, trashedAt: null, updatedAt: stamp, lastEditedBy: actorId } },
      { table: 'database_hierarchy_lifecycle_items', op: 'delete', id: item.id },
    );
  }
  if (finishing) {
    const binding = duplicateHierarchyBinding(database);
    if (!binding) throw Object.assign(new Error('Sub-item feature binding changed.'), { status: 409 });
    const features = cloneJson(objectRecord(database.databaseFeatures) ?? {});
    if (externalParent) {
      operations.push(
        {
          table: 'pages',
          op: 'expect',
          id: externalParent.id,
          where: [
            ['workspaceId', '==', externalParent.workspaceId],
            ['parentId', '==', externalParent.parentId ?? null],
            ['parentType', '==', externalParent.parentType],
            ['inTrash', '==', externalParent.inTrash ?? null],
            ['subitemParentId', '==', externalParent.subitemParentId ?? ''],
            ['subitemChildCount', '==', exactDuplicateSubitemChildCount(externalParent)],
            ['updatedAt', '==', externalParent.updatedAt ?? null],
          ],
          exists: true,
        },
        {
          table: 'pages',
          op: 'update',
          id: externalParent.id,
          data: {
            subitemChildCount: incrementedDuplicateSubitemChildCount(externalParent),
          },
        },
      );
    }
    operations.push(
      duplicateHierarchyDatabaseExpectation(database),
      {
        table: 'pages',
        op: 'update',
        id: database.id,
        data: {
          databaseFeatures: { ...features, subitems: { ...binding, revision: binding.revision + 1 } },
          databaseFeaturesRevision: job.featureRevision + 1,
          updatedAt: stamp,
          lastEditedBy: actorId,
        },
      },
      { table: 'database_hierarchy_lifecycle_jobs', op: 'delete', id: job.id },
    );
  }
  await db.transact(operations);
  const root = targets.get(job.targetRootId)
    ? { ...targets.get(job.targetRootId)!, inTrash: false, trashedAt: null, updatedAt: stamp }
    : await getExisting(db.table<Page>('pages'), job.targetRootId);
  return {
    status: finishing ? 'completed' : 'pending',
    replayed: false,
    ...(finishing ? {} : { jobId: job.id }),
    page: root,
    pages: items.map((item) => ({
      ...targets.get(item.targetRowId)!,
      inTrash: false,
      trashedAt: null,
      updatedAt: stamp,
    })),
  };
}

async function duplicateDatabaseHierarchyWithContinuation(
  db: DbRef,
  admin: AdminDbAccessor,
  database: Page,
  source: Page,
  body: Record<string, unknown>,
  actorId: string,
  mutationId: string,
  storage: DuplicateStorageProxy | undefined,
  request: Request | undefined,
  lease: FileWorkspaceLeaseGuard,
) {
  const jobId = await duplicateHierarchyHash(
    'duplicate-hierarchy-job',
    source.workspaceId,
    database.id,
    source.id,
    mutationId,
  );
  const targetRootId = await duplicateHierarchyUuid(jobId, source.id);
  const jobs = db.table<DuplicateHierarchyJob>('database_hierarchy_lifecycle_jobs');
  let job = await getExisting(jobs, jobId);
  if (!job) {
    const completed = await getExisting(db.table<Page>('pages'), targetRootId);
    if (completed?.inTrash === false && completed.createdBy === actorId) {
      return { status: 'completed', replayed: true, page: completed, pages: [] as Page[] };
    }
    job = await createDuplicateHierarchyJob(db, database, source, mutationId, actorId);
  }
  if (
    job.operation !== 'duplicate'
    || job.databaseId !== database.id
    || job.rootRowId !== source.id
    || job.requestedBy !== actorId
    || job.mutationId !== mutationId
    || job.featureRevision !== Number(database.databaseFeaturesRevision ?? 0)
  ) throw Object.assign(new Error('Hierarchy duplicate state changed; retry from current state.'), { status: 409 });

  if (await advanceDuplicateHierarchyDiscovery(db, database, job)) {
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'prepared', false)) {
    await prepareDuplicateHierarchyItems(db, job);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'blocksPrepared', false)) {
    await prepareDuplicateHierarchyBlocks(db, job, request);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'dependenciesPrepared', false)) {
    await prepareDuplicateHierarchyDependencies(db, job);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'applied', false)) {
    await applyDuplicateHierarchyItems(db, admin, database, source, body, actorId, job);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'relationsPrepared', false)) {
    await prepareDuplicateHierarchyRelations(db, job);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await applyDuplicateHierarchyRelationUpdates(db, job)) {
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'blocksApplied', false)) {
    await applyDuplicateHierarchyBlocks(db, job, actorId);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'filesApplied', false)) {
    await applyDuplicateHierarchyFiles(db, admin, job, storage, request, lease);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  if (await firstDuplicateHierarchyItem(db, job.id, 'dependenciesApplied', false)) {
    await applyDuplicateHierarchyDependencies(db, job, actorId);
    return { status: 'pending', replayed: false, jobId: job.id, page: source, pages: [] as Page[] };
  }
  return publishDuplicateHierarchyItems(db, database, job, actorId);
}

async function duplicatePage(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: DuplicateStorageProxy,
  request?: Request,
) {
  const pagesTable = db.table<Page>('pages');
  const pageId = typeof body.pageId === 'string' ? body.pageId : typeof body.id === 'string' ? body.id : '';
  if (!pageId) throw new Error('pageId is required.');
  const initialSource = await pagesTable.getOne(pageId);
  if (!initialSource) throw new Error('Page was not found.');
  if (initialSource.inTrash) throw new Error('Page is in trash.');
  // Any authenticated caller can name an arbitrary pageId here, so gate on the
  // source: Notion lets you duplicate a page you can edit. Requiring edit (not
  // just view) also means an in-place copy needs no separate destination check.
  // Without this, duplicate was an arbitrary-page read + cross-workspace write.
  await assertCanEditPage(db, initialSource, actorId, actorEmail);

  return withFileWorkspaceLease(db, initialSource.workspaceId, actorId, 'duplicate-page', (lease) =>
    duplicatePageUnderLease(
      db,
      admin,
      body,
      actorId,
      actorEmail,
      storage,
      request,
      pageId,
      initialSource.workspaceId,
      lease,
    ));
}

async function duplicatePageUnderLease(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail: string | null | undefined,
  storage: DuplicateStorageProxy | undefined,
  request: Request | undefined,
  pageId: string,
  workspaceId: string,
  lease: FileWorkspaceLeaseGuard,
) {
  const generatedLabels = persistentGeneratedLabels(parsePersistentGeneratedLocale(body.locale));
  const pagesTable = db.table<Page>('pages');
  const blocksTable = db.table<Block>('blocks');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const viewsTable = db.table<DbView>('db_views');
  const templatesTable = db.table<DbTemplate>('db_templates');

  await lease.assertOwned();
  const source = await getExisting(pagesTable, pageId);
  if (!source) throw new Error('Page was not found.');
  if (source.workspaceId !== workspaceId) throw new Error('Page workspace changed during duplication.');
  if (source.inTrash) throw new Error('Page is in trash.');
  await assertCanEditPage(db, source, actorId, actorEmail);

  const hierarchyMutationId = optionalString(body.mutationId);
  if (
    hierarchyMutationId
    && source.parentType === 'database'
    && source.parentId
    && !('parentId' in body)
    && !('parentType' in body)
  ) {
    const database = await getExisting(pagesTable, source.parentId);
    if (
      database?.kind === 'database'
      && database.workspaceId === source.workspaceId
      && database.inTrash !== true
      && duplicateHierarchyBinding(database)
    ) {
      return duplicateDatabaseHierarchyWithContinuation(
        db,
        admin,
        database,
        source,
        body,
        actorId,
        hierarchyMutationId,
        storage,
        request,
        lease,
      );
    }
  }

  const workspacePages = await listAll(pagesTable.where('workspaceId', '==', source.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  assertParentAllowsDuplicate(pagesById, source.parentId);

  const destination =
    'parentId' in body || 'parentType' in body
      ? parseParentInput(body.parentId, body.parentType)
      : { parentId: source.parentId ?? null, parentType: source.parentType ?? 'workspace' };
  assertParentAllowsDuplicate(pagesById, destination.parentId);

  const sameDestination =
    (source.parentId ?? null) === destination.parentId &&
    (source.parentType ?? 'workspace') === destination.parentType;

  if (destination.parentType !== 'workspace') {
    const parent = pagesById[destination.parentId as string];
    if (!parent || parent.inTrash) throw new Error('Destination parent was not found.');
    if (destination.parentType === 'database' && source.kind !== 'page') {
      throw new Error('Only regular pages can be duplicated into a database.');
    }
    if (destination.parentType === 'database' && parent.kind !== 'database') {
      throw new Error('Destination parent is not a database.');
    }
    if (destination.parentType === 'page' && parent.kind !== 'page') {
      throw new Error('Destination parent is not a page.');
    }
  }

  // Editing the source authorizes an in-place copy. Relocating the copy to a
  // different container additionally requires edit access at that destination.
  if (!sameDestination) {
    if (destination.parentType === 'workspace') {
      await sharedAssertMinimumWorkspaceAccessRole(
        db,
        source.workspaceId,
        actorId,
        'edit',
        { requireWorkspace: true },
      );
    } else {
      await assertCanEditPage(db, pagesById[destination.parentId as string], actorId, actorEmail);
    }
  }

  const sourceIds = collectSubtree(workspacePages, pageId);
  if (destination.parentId && sourceIds.has(destination.parentId)) {
    throw new Error('Cannot duplicate a page inside itself or one of its descendants.');
  }
  const sourceTreePages = workspacePages.filter((page) => sourceIds.has(page.id) && !page.inTrash);
  const pageMap = new Map(sourceTreePages.map((page) => [page.id, newId()]));
  const siblings = siblingPages(workspacePages, destination.parentId, destination.parentType, pageId);
  const nextSibling = sameDestination
    ? siblings.find((page) => (page.position ?? 0) > (source.position ?? 0))
    : undefined;
  const rootPosition = sameDestination
    ? positionBetween(source.position, nextSibling?.position)
    : positionBetween(siblings[siblings.length - 1]?.position, undefined);

  const blocksByPage = new Map<string, Block[]>();
  const globalBlockMap = new Map<string, string>();
  for (const page of sourceTreePages) {
    const blocks = await listAll(blocksTable.where('pageId', '==', page.id));
    blocksByPage.set(page.id, blocks.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    for (const block of blocks) globalBlockMap.set(block.id, newId());
  }

  const propsByDb = new Map<string, DbProperty[]>();
  const propsByIdByDb = new Map<string, Map<string, DbProperty>>();
  const propMapsByDb = new Map<string, Map<string, string>>();
  const viewsByDb = new Map<string, DbView[]>();
  const templatesByDb = new Map<string, DbTemplate[]>();
  const templateMapsByDb = new Map<string, Map<string, string>>();
  for (const page of sourceTreePages.filter((item) => item.kind === 'database')) {
    const [props, views, templates] = await Promise.all([
      listAll(propertiesTable.where('databaseId', '==', page.id)),
      listAll(viewsTable.where('databaseId', '==', page.id)),
      listAll(templatesTable.where('databaseId', '==', page.id)),
    ]);
    propsByDb.set(page.id, props.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    propsByIdByDb.set(page.id, new Map(props.map((prop) => [prop.id, prop])));
    propMapsByDb.set(page.id, new Map(props.map((prop) => [prop.id, newId()])));
    viewsByDb.set(page.id, views.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    templatesByDb.set(page.id, templates.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    templateMapsByDb.set(page.id, new Map(templates.map((template) => [template.id, newId()])));
  }

  const globalPropertyMap = new Map<string, string>();
  for (const propMap of propMapsByDb.values()) {
    for (const [sourcePropertyId, targetPropertyId] of propMap) {
      globalPropertyMap.set(sourcePropertyId, targetPropertyId);
    }
  }
  const globalTemplateMap = new Map<string, string>();
  for (const templateMap of templateMapsByDb.values()) {
    for (const [sourceTemplateId, targetTemplateId] of templateMap) {
      globalTemplateMap.set(sourceTemplateId, targetTemplateId);
    }
  }
  const pageFileValues = sourceTreePages.map((page) => {
    const rowPropsById = page.parentType === 'database' && page.parentId
      ? propsByIdByDb.get(page.parentId)
      : undefined;
    return {
      pageId: page.id,
      databaseId: page.parentType === 'database' && page.parentId
        ? page.parentId
        : page.kind === 'database'
          ? page.id
          : undefined,
      values: [
        { value: page.icon, directString: true },
        { value: page.cover, directString: true },
        { value: page.properties },
        ...storedFilePropertyValues(page.properties, rowPropsById),
      ],
    };
  });
  const blockFileValues = Array.from(blocksByPage.entries()).flatMap(([pageId, blocks]) =>
    blocks.map((block) => ({
      blockId: block.id,
      pageId,
      values: [{ value: block.content }],
    })));
  const templateFileValues = Array.from(templatesByDb.entries()).flatMap(([databaseId, templates]) => {
    const propsById = propsByIdByDb.get(databaseId);
    return templates.map((template) => ({
      templateId: template.id,
      databaseId,
      values: [
        { value: template.icon, directString: true },
        { value: template.properties },
        ...storedFilePropertyValues(template.properties, propsById),
        { value: template.blocks },
      ],
    }));
  });
  const workspaceUploads = await loadReferencedUploads(
    db,
    source.workspaceId,
    [
      ...pageFileValues.flatMap((page) => page.values),
      ...blockFileValues.flatMap((block) => block.values),
      ...templateFileValues.flatMap((template) => template.values),
    ],
  );
  const filePlans = buildDuplicateFilePlans({
    uploads: workspaceUploads,
    pageMap,
    blockMap: globalBlockMap,
    propertyMap: globalPropertyMap,
    templateMap: globalTemplateMap,
    pageValues: pageFileValues,
    blockValues: blockFileValues,
    templateValues: templateFileValues,
    workspaceId: source.workspaceId,
    actorId,
    request,
  });
  const rootSubitemParentId = source.parentType === 'database'
    && destination.parentType === 'database'
    && destination.parentId === source.parentId
    ? source.subitemParentId ?? ''
    : '';
  const workspace = filePlans.length > 0
    ? await getExisting(admin.db('app').table<Workspace>('workspaces'), source.workspaceId)
    : null;
  if (filePlans.length > 0 && !workspace) throw new Error('Workspace was not found.');
  const stagingTrashAt = nowIso();
  // Every duplicate is a multi-row operation, even when it carries no files.
  // Stage the tree behind a durable marker so a worker crash cannot expose a
  // live partial page/block/template hierarchy.
  const recoveryMarker: DuplicatePageRecoveryData = duplicatePageRecoveryData({
    status: 'staging',
    rootPageId: pageMap.get(pageId)!,
    uploadIds: filePlans.map((plan) => plan.target.id),
    stagingTrashAt,
    ...(rootSubitemParentId ? { subitemParentId: rootSubitemParentId } : {}),
  });
  await lease.setRecoveryData(recoveryMarker);

  const created = {
    pages: [] as Page[],
    blocks: [] as Block[],
    properties: [] as DbProperty[],
    views: [] as DbView[],
    templates: [] as DbTemplate[],
    fileUploads: [] as FileUpload[],
  };
  let recoveryCommitted = false;
  let writesSinceLeaseRenewal = 0;
  const keepLeaseAlive = async () => {
    writesSinceLeaseRenewal += 1;
    if (writesSinceLeaseRenewal < 100) return;
    await lease.renew();
    writesSinceLeaseRenewal = 0;
  };

  async function duplicateNode(
    sourceId: string,
    newParentId: string | null,
    newParentType: PageParentType,
    position: number,
    titleOverride?: string,
    subitemParentId = '',
  ): Promise<Page | null> {
    await keepLeaseAlive();
    const cur = pagesById[sourceId];
    if (!cur || cur.inTrash) return null;
    const now = nowIso();
    const newPageId = pageMap.get(sourceId) ?? newId();
    pageMap.set(sourceId, newPageId);
    const rowPropMap = cur.parentType === 'database' && cur.parentId ? propMapsByDb.get(cur.parentId) : undefined;
    const rowPropsById = cur.parentType === 'database' && cur.parentId ? propsByIdByDb.get(cur.parentId) : undefined;
    const page = await pagesTable.insert({
      id: newPageId,
      workspaceId: cur.workspaceId,
      parentId: newParentId,
      parentType: newParentType,
      subitemParentId,
      subitemChildCount: exactDuplicateSubitemChildCount(cur),
      kind: cur.kind,
      title: titleOverride ?? cur.title,
      icon: remapStoredFileReferences(cur.icon, filePlans, true) as string | undefined,
      iconType: cur.iconType ?? 'none',
      cover: remapStoredFileReferences(cur.cover, filePlans, true) as string | undefined,
      coverPosition: cur.coverPosition,
      font: cur.font ?? 'default',
      smallText: !!cur.smallText,
      fullWidth: !!cur.fullWidth,
      isLocked: false,
      isPublic: false,
      backlinksDisplay: cur.backlinksDisplay ?? 'default',
      pageCommentsDisplay: cur.pageCommentsDisplay ?? 'default',
      properties: remapStoredFileReferences(
        remapProperties(cur.properties, rowPropMap, pageMap, rowPropsById, filePlans),
        filePlans,
      ) as Record<string, unknown>,
      isFavorite: false,
      inTrash: true,
      trashedAt: stagingTrashAt,
      position,
      createdBy: actorId,
      lastEditedBy: actorId,
      createdAt: now,
      updatedAt: now,
    });
    // Copies are page rows; index them synchronously for immediate follow-ups.
    await ensurePageWorkspaceIndex(admin, page.id, page.workspaceId);
    created.pages.push(page);

    for (const block of blocksByPage.get(cur.id) ?? []) {
      await keepLeaseAlive();
      const blockId = globalBlockMap.get(block.id) ?? newId();
      const newBlock = await blocksTable.insert({
        id: blockId,
        pageId: page.id,
        parentId: block.parentId ? globalBlockMap.get(block.parentId) ?? null : null,
        type: block.type,
        content: remapStoredFileReferences(
          remapBlockContent(block.content, pageMap, globalBlockMap),
          filePlans,
        ) as Record<string, unknown> | undefined,
        plainText: block.plainText,
        position: block.position,
        createdBy: actorId,
      });
      created.blocks.push(newBlock);
    }

    if (cur.kind === 'database') {
      const props = propsByDb.get(cur.id) ?? [];
      const propMap = propMapsByDb.get(cur.id) ?? new Map<string, string>();
      const templateMap = templateMapsByDb.get(cur.id) ?? new Map<string, string>();
      const propsById = propsByIdByDb.get(cur.id) ?? new Map<string, DbProperty>();
      for (const prop of props) {
        await keepLeaseAlive();
        created.properties.push(
          await propertiesTable.insert({
            id: propMap.get(prop.id),
            databaseId: page.id,
            name: prop.name,
            description: prop.description,
            type: prop.type,
            config: remapPropertyConfig(prop.config, propMap, pageMap, cur.id, page.id),
            position: prop.position,
          }),
        );
      }
      for (const view of viewsByDb.get(cur.id) ?? []) {
        await keepLeaseAlive();
        created.views.push(
          await viewsTable.insert({
            id: newId(),
            databaseId: page.id,
            name: view.name,
            type: view.type,
            config: remapViewConfig(view.config, propMap),
            position: view.position,
          }),
        );
      }
      for (const template of templatesByDb.get(cur.id) ?? []) {
        await keepLeaseAlive();
        created.templates.push(
          await templatesTable.insert({
            id: templateMap.get(template.id),
            databaseId: page.id,
            name: template.name,
            icon: remapStoredFileReferences(template.icon, filePlans, true) as string | undefined,
            title: template.title ?? '',
            properties: remapStoredFileReferences(
              remapProperties(template.properties, propMap, pageMap, propsById, filePlans),
              filePlans,
            ) as Record<string, unknown>,
            blocks: remapStoredFileReferences(
              remapTemplateBlocks(template.blocks, pageMap),
              filePlans,
            ) as TemplateBlock[],
            isDefault: !!template.isDefault,
            position: template.position,
          }),
        );
      }
    }

    const rows = sourceTreePages
      .filter((item) => (
        item.parentType === 'database'
        && item.parentId === cur.id
        && !item.subitemParentId
      ))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const row of rows) await duplicateNode(row.id, page.id, 'database', row.position);

    const subitems = sourceTreePages
      .filter((item) => (
        item.parentType === 'database'
        && item.parentId === cur.parentId
        && item.subitemParentId === cur.id
      ))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const subitem of subitems) {
      await duplicateNode(
        subitem.id,
        page.parentId ?? null,
        'database',
        subitem.position,
        undefined,
        page.id,
      );
    }

    const children = sourceTreePages
      .filter((item) => item.parentType === 'page' && item.parentId === cur.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const child of children) await duplicateNode(child.id, page.id, 'page', child.position);

    return page;
  }

  try {
    let page = await duplicateNode(
      pageId,
      destination.parentId,
      destination.parentType,
      rootPosition,
      typeof body.title === 'string'
        ? body.title
        : generatedLabels.copyName(source.title || generatedLabels.untitled),
      rootSubitemParentId,
    );
    if (filePlans.length > 0) {
      if (!workspace) throw new Error('Workspace was not found.');
      await copyDuplicatedFiles({
        db,
        admin,
        workspace,
        plans: filePlans,
        storage,
        lease,
      });
      created.fileUploads.push(...filePlans.map((plan) => plan.target));
    }
    // All content rows (and, when present, copied objects/metadata) are now
    // durable. Record that decision before publishing the root so a crash can
    // only finish the duplicate, never leave a live partial hierarchy.
    await lease.setRecoveryData({ ...recoveryMarker, status: 'committed' });
    recoveryCommitted = true;
    const finalizeOrder = [
      ...created.pages.filter((createdPage) => createdPage.id !== recoveryMarker.rootPageId).reverse(),
      ...created.pages.filter((createdPage) => createdPage.id === recoveryMarker.rootPageId),
    ];
    for (const stagedPage of finalizeOrder) {
      let finalized: Page;
      if (stagedPage.id === recoveryMarker.rootPageId && rootSubitemParentId) {
        const externalParent = pagesById[rootSubitemParentId];
        if (
          !externalParent
          || externalParent.workspaceId !== stagedPage.workspaceId
          || externalParent.parentId !== stagedPage.parentId
          || externalParent.parentType !== 'database'
          || externalParent.kind === 'database'
        ) {
          throw Object.assign(
            new Error('External sub-item parent changed during duplicate publication.'),
            { status: 409 },
          );
        }
        const externalParentCount = exactDuplicateSubitemChildCount(externalParent);
        await db.transact([
          {
            table: 'pages',
            op: 'expect',
            id: stagedPage.id,
            where: [
              ['inTrash', '==', true],
              ['trashedAt', '==', stagingTrashAt],
              ['subitemParentId', '==', rootSubitemParentId],
            ],
            exists: true,
          },
          {
            table: 'pages',
            op: 'expect',
            id: externalParent.id,
            where: [
              ['workspaceId', '==', externalParent.workspaceId],
              ['parentId', '==', externalParent.parentId ?? null],
              ['parentType', '==', externalParent.parentType],
              ['subitemChildCount', '==', externalParentCount],
            ],
            exists: true,
          },
          {
            table: 'pages',
            op: 'update',
            id: stagedPage.id,
            data: { inTrash: false, trashedAt: null },
          },
          {
            table: 'pages',
            op: 'update',
            id: externalParent.id,
            data: { subitemChildCount: externalParentCount + 1 },
          },
        ]);
        finalized = { ...stagedPage, inTrash: false, trashedAt: null };
      } else {
        finalized = await pagesTable.update(stagedPage.id, {
          inTrash: false,
          trashedAt: null,
        });
      }
      const index = created.pages.findIndex((createdPage) => createdPage.id === finalized.id);
      if (index !== -1) created.pages[index] = finalized;
      if (page?.id === finalized.id) page = finalized;
    }
    return {
      page,
      source,
      parentId: destination.parentId,
      parentType: destination.parentType,
      ...created,
      counts: {
        pages: created.pages.length,
        blocks: created.blocks.length,
        properties: created.properties.length,
        views: created.views.length,
        templates: created.templates.length,
        fileUploads: created.fileUploads.length,
      },
    };
  } catch (error) {
    if (recoveryCommitted) {
      // A committed marker owns complete file copies. Leave the still-hidden
      // staged rows for maintenance to publish instead of rolling them back.
      lease.preserveForRecovery();
      throw error;
    }
    let rollbackClean = await rollbackDuplicatedFiles({ db, admin, plans: filePlans, storage });
    for (const item of created.templates) {
      rollbackClean = await bestEffort('duplicate-page templatesTable.delete', templatesTable.delete(item.id))
        && rollbackClean;
    }
    for (const item of created.views) {
      rollbackClean = await bestEffort('duplicate-page viewsTable.delete', viewsTable.delete(item.id))
        && rollbackClean;
    }
    for (const item of created.properties) {
      rollbackClean = await bestEffort('duplicate-page propertiesTable.delete', propertiesTable.delete(item.id))
        && rollbackClean;
    }
    for (const item of created.blocks) {
      rollbackClean = await bestEffort('duplicate-page blocksTable.delete', blocksTable.delete(item.id))
        && rollbackClean;
    }
    for (const page of created.pages.slice().reverse()) {
      const indexDeleted = await bestEffort(
        'duplicate-page page_workspace_index.delete',
        rollbackPageWorkspaceIndex(admin, page),
      );
      rollbackClean = indexDeleted && rollbackClean;
      if (!indexDeleted) continue;
      rollbackClean = await bestEffort('duplicate-page pagesTable.delete', pagesTable.delete(page.id))
        && rollbackClean;
    }
    if (!rollbackClean) lease.preserveForRecovery();
    throw error;
  }
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request, storage } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    switch (action) {
      case 'duplicate':
        return await duplicatePage(
          await boundedDbFromPageHint(admin, body.pageId, body.id),
          admin,
          body,
          auth.id,
          auth.email ?? null,
          storage as DuplicateStorageProxy | undefined,
          request,
        );
      default:
        return jsonError(400, 'Unknown duplicate page action.');
    }
  } catch (error) {
    // STANDARD rules map "access required" -> 403, "locked" -> 423,
    // "not found" -> 404 (everything else 400).
    const { status, message } = errorStatus(error);
    return jsonError(status, message);
  }
});
