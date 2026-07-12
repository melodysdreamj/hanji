import { MAX_RAW_TRANSACT_OPS } from './workspace-db';
import { getExisting, listAll, nowIso, type TransactOperation } from './table-utils';
import type { DbProperty, DbRef, FileUpload } from './app-types';

const FILE_BUCKET = 'files';
const FILE_REFERENCE_STRING_FIELDS = new Set([
  'url',
  'src',
  'href',
  'link',
  'sourceUrl',
  'key',
  'fileKey',
  'storageKey',
  'icon',
  'cover',
  'image',
  'video',
  'audio',
  'file',
  'poster',
  'thumbnail',
]);
const STRUCTURED_FILE_LOCATOR_FIELDS = new Set([
  'url',
  'src',
  'href',
  'link',
  'sourceUrl',
  'key',
  'fileKey',
  'storageKey',
]);
const LOCAL_STORAGE_SENTINEL = new URL('http://hanji.local');
const MAX_WORKSPACE_REFERENCE_ROWS = 100_000;

// Reference removal is reversible for a short period (page cover/icon undo,
// replacing a media URL and then choosing the old file again). The scheduled
// maintenance task performs the irreversible R2/quota cleanup only after this
// deadline, and retries failures while the row remains `deleting`.
export const FILE_REFERENCE_DELETE_GRACE_MS = 5 * 60 * 1000;

type FileAssociationField = 'pageId' | 'blockId' | 'databaseId' | 'propertyId' | 'templateId';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function decodeStoragePath(value: string) {
  try {
    return value
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return '';
  }
}

function storagePathLocator(pathname: string) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api' || segments[1] !== 'storage' || segments.length <= 3) return undefined;
  const bucket = decodeStoragePath(segments[2]);
  const key = decodeStoragePath(segments.slice(3).join('/'));
  return bucket && key ? { bucket, key } : undefined;
}

function originStorageToken(
  kind: 'origin' | 'host',
  authority: string,
  bucket: string,
  key: string,
) {
  return `${kind}-storage:${encodeURIComponent(authority)}:${encodeURIComponent(bucket)}:${encodeURIComponent(key)}`;
}

function parseOriginStorageToken(token: string) {
  if (!token.startsWith('origin-storage:') && !token.startsWith('host-storage:')) return undefined;
  const parts = token.split(':');
  if (parts.length !== 4) return undefined;
  try {
    return {
      kind: token.startsWith('origin-storage:') ? 'origin' as const : 'host' as const,
      authority: decodeURIComponent(parts[1]),
      bucket: decodeURIComponent(parts[2]),
      key: decodeURIComponent(parts[3]),
    };
  } catch {
    return undefined;
  }
}

function originStorageTokenKey(token: string) {
  return parseOriginStorageToken(token)?.key;
}

function addAbsoluteStorageTokens(raw: string, out: Set<string>) {
  const absolute = /^https?:\/\//i.test(raw);
  const protocolRelative = raw.startsWith('//');
  if (!absolute && !protocolRelative) return;
  const bases = protocolRelative
    ? [new URL('http://hanji.local'), new URL('https://hanji.local')]
    : [LOCAL_STORAGE_SENTINEL];
  for (const base of bases) {
    let parsed: URL;
    try {
      parsed = new URL(raw, base);
    } catch {
      continue;
    }
    const locator = storagePathLocator(parsed.pathname);
    if (!locator) continue;
    if (absolute) {
      out.add(originStorageToken('origin', parsed.origin, locator.bucket, locator.key));
    }
    out.add(originStorageToken('host', parsed.host, locator.bucket, locator.key));
  }
}

function storageLocator(value: string): { bucket?: string; key: string } | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw.startsWith('workspaces/')) return { key: raw };
  // Absolute URLs are origin-sensitive. Their path alone must never make an
  // attacker-controlled origin look like local storage; exact upload.url
  // matching is handled by the `url:` token below.
  if (/^https?:\/\//i.test(raw)) return undefined;
  if (!raw.startsWith('/api/storage/')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw, LOCAL_STORAGE_SENTINEL);
  } catch {
    return undefined;
  }
  if (parsed.origin !== LOCAL_STORAGE_SENTINEL.origin) return undefined;
  return storagePathLocator(parsed.pathname);
}

function referenceTokens(
  value: unknown,
  out = new Set<string>(),
  seen = new Set<object>(),
  field?: string,
  fileContext = false,
) {
  const explicitFileContext = fileContext || field === 'file';
  if (typeof value === 'string') {
    if (
      field
      && !FILE_REFERENCE_STRING_FIELDS.has(field)
      && !(explicitFileContext && field === 'id')
    ) return out;
    const raw = value.trim();
    if (/^https?:\/\//i.test(raw)) out.add(`url:${raw}`);
    addAbsoluteStorageTokens(raw, out);
    const locator = storageLocator(value);
    if (locator) {
      out.add(`key:${locator.key}`);
      if (locator.bucket) out.add(`storage:${locator.bucket}:${locator.key}`);
    }
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) referenceTokens(item, out, seen, field, explicitFileContext);
    seen.delete(value);
    return out;
  }
  const record = value as Record<string, unknown>;
  for (const field of ['uploadId', 'fileUploadId']) {
    const id = optionalString(record[field]);
    if (id) out.add(`id:${id}`);
  }
  for (const [childField, child] of Object.entries(record)) {
    referenceTokens(child, out, seen, childField, explicitFileContext);
  }
  seen.delete(value);
  return out;
}

/**
 * Database `files` values have historically been persisted both as attachment
 * objects and as raw storage strings/string arrays. The generic walker must
 * ignore arbitrary strings under dynamic property IDs (otherwise ordinary
 * text that resembles a storage path can delete bytes), so schema-confirmed
 * file values are explicitly placed below the allowlisted `file` field.
 */
export function schemaFilePropertyReferences(
  properties: unknown,
  filePropertyIds: Iterable<string>,
) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const record = properties as Record<string, unknown>;
  const references: Array<{ file: unknown }> = [];
  for (const propertyId of filePropertyIds) {
    if (Object.prototype.hasOwnProperty.call(record, propertyId)) {
      references.push({ file: record[propertyId] });
    }
  }
  return references;
}

interface StructuredFileLocator {
  field: string;
  tokens: Set<string>;
}

function structuredFileLocatorGroups(
  value: unknown,
  out: StructuredFileLocator[][] = [],
  seen = new Set<object>(),
  field?: string,
  fileContext = false,
) {
  const explicitFileContext = fileContext || field === 'file';
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      structuredFileLocatorGroups(item, out, seen, field, explicitFileContext);
    }
    seen.delete(value);
    return out;
  }
  const record = value as Record<string, unknown>;
  const locators: StructuredFileLocator[] = [];
  let hasExplicitUploadId = false;
  for (const field of ['uploadId', 'fileUploadId']) {
    const id = optionalString(record[field]);
    if (id) {
      hasExplicitUploadId = true;
      locators.push({ field, tokens: new Set([`id:${id}`]) });
    }
  }
  const legacyId = explicitFileContext && typeof record.id === 'string'
    ? record.id.trim()
    : '';
  if (legacyId) {
    const tokens = referenceTokens(legacyId, new Set<string>(), new Set<object>(), 'id', true);
    if (tokens.size > 0) locators.push({ field: 'id', tokens });
  }
  for (const field of FILE_REFERENCE_STRING_FIELDS) {
    const raw = record[field];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const tokens = referenceTokens(raw, new Set<string>(), new Set<object>(), field);
    // Preserve an ordinary external URL as a locator too: paired with an
    // uploadId/key it is contradictory even though it is not stored-file
    // ownership on its own.
    if (tokens.size === 0 && /^https?:\/\//i.test(raw.trim())) {
      tokens.add(`url:${raw.trim()}`);
    }
    if (tokens.size > 0) locators.push({ field, tokens });
  }
  const identityLocatorCount = locators.filter((locator) => (
    locator.field === 'uploadId'
    || locator.field === 'fileUploadId'
    || locator.field === 'id'
    || STRUCTURED_FILE_LOCATOR_FIELDS.has(locator.field)
  )).length;
  if (locators.length > 1 && (hasExplicitUploadId || identityLocatorCount > 1)) out.push(locators);
  for (const [childField, child] of Object.entries(record)) {
    structuredFileLocatorGroups(child, out, seen, childField, explicitFileContext);
  }
  seen.delete(value);
  return out;
}

function structuredFileLocatorSignature(value: unknown) {
  return structuredFileLocatorGroups(value)
    .map((locators) => locators
      .map((locator) => `${locator.field}:${Array.from(locator.tokens).sort().join(',')}`)
      .sort()
      .join('|'))
    .sort()
    .join('||');
}

function uploadTokens(upload: FileUpload) {
  const bucket = optionalString(upload.bucket) ?? FILE_BUCKET;
  const out = new Set([`id:${upload.id}`, `key:${upload.key}`, `storage:${bucket}:${upload.key}`]);
  const url = optionalString(upload.url);
  if (url) {
    referenceTokens(url, out, new Set<object>(), 'url');
  }
  return out;
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

function referencesUpload(tokens: Set<string>, upload: FileUpload) {
  return Array.from(uploadTokens(upload)).some((token) => tokens.has(token));
}

function lifecycleConflict(message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code: 409 });
}

function deletionDeadline(upload: FileUpload, now = Date.now()) {
  const grace = now + FILE_REFERENCE_DELETE_GRACE_MS;
  const existing = typeof upload.expiresAt === 'string' ? Date.parse(upload.expiresAt) : Number.NaN;
  // A pending signed upload may still write bytes until its grant expires.
  // Never schedule cleanup before that credential is dead.
  return new Date(Number.isFinite(existing) ? Math.max(grace, existing) : grace).toISOString();
}

function transitionOperations(
  upload: FileUpload,
  status: 'restore' | 'deleting',
  actorId: string,
): TransactOperation[] {
  const previousStatus = upload.status ?? 'pending';
  const timestamp = nowIso();
  const deletionPreviousStatus = upload.deletionPreviousStatus;
  const restoredStatus =
    deletionPreviousStatus === 'preparing'
    || deletionPreviousStatus === 'pending'
    || deletionPreviousStatus === 'uploaded'
      ? deletionPreviousStatus
      : upload.completedAt
        ? 'uploaded'
        : 'pending';
  return [
    {
      table: 'file_uploads',
      op: 'expect',
      id: upload.id,
      where: [['status', '==', previousStatus]],
      exists: true,
    },
    {
      table: 'file_uploads',
      op: 'update',
      id: upload.id,
      data:
        status === 'deleting'
          ? {
              status,
              expiresAt: deletionDeadline(upload),
              deletionPreviousStatus: previousStatus,
              deletedBy: actorId,
              updatedAt: timestamp,
            }
          : {
              status: restoredStatus,
              // Completed uploads have no reusable signed grant. Pending and
              // preparing uploads retain their original credential deadline.
              expiresAt: restoredStatus === 'uploaded' ? null : upload.expiresAt ?? null,
              deletedAt: null,
              deletedBy: null,
              deletionPreviousStatus: null,
              updatedAt: timestamp,
            },
    },
  ];
}

async function associatedUploads(
  db: DbRef,
  field: FileAssociationField,
  id: string,
  filter?: (upload: FileUpload) => boolean,
) {
  const uploads = await listAll(
    db.table<FileUpload>('file_uploads').where(field, '==', id),
    { label: `File references for ${field} ${id}` },
  );
  return filter ? uploads.filter(filter) : uploads;
}

export interface FileReferenceUpdateInput<T extends { id: string; updatedAt?: string }> {
  table: 'pages' | 'blocks' | 'db_templates';
  current: T;
  data: Partial<T> & Record<string, unknown>;
  currentReferences: unknown;
  nextReferences: unknown;
  association: {
    field: FileAssociationField;
    id: string;
    filter?: (upload: FileUpload) => boolean;
    legacy?: {
      field: FileAssociationField;
      id: string;
      filter?: (upload: FileUpload) => boolean;
    };
  };
  actorId: string;
}

export async function fileReferenceTransitionOperations<
  T extends { id: string; updatedAt?: string },
>(
  db: DbRef,
  input: FileReferenceUpdateInput<T>,
): Promise<TransactOperation[]> {
  const currentTokens = referenceTokens(input.currentReferences);
  const nextTokens = referenceTokens(input.nextReferences);
  if (
    setsEqual(currentTokens, nextTokens)
    && structuredFileLocatorSignature(input.currentReferences)
      === structuredFileLocatorSignature(input.nextReferences)
  ) return [];

  const primaryUploads = await associatedUploads(
    db,
    input.association.field,
    input.association.id,
    input.association.filter,
  );
  const legacyUploads = input.association.legacy
    ? await associatedUploads(
        db,
        input.association.legacy.field,
        input.association.legacy.id,
        input.association.legacy.filter,
      )
    : [];
  const uploads = Array.from(
    new Map([...primaryUploads, ...legacyUploads].map((upload) => [upload.id, upload])).values(),
  );
  const legacyUploadIds = new Set(legacyUploads.map((upload) => upload.id));
  for (const locators of structuredFileLocatorGroups(input.nextReferences)) {
    let matchingIds: Set<string> | undefined;
    let hasStoredLocator = false;
    for (const locator of locators) {
      const locatorMatches = new Set(
        uploads
          .filter((upload) => Array.from(locator.tokens).some((token) => uploadTokens(upload).has(token)))
          .map((upload) => upload.id),
      );
      if (
        locator.field === 'uploadId'
        || locator.field === 'fileUploadId'
        || Array.from(locator.tokens).some((token) => !token.startsWith('url:'))
        || locatorMatches.size > 0
      ) {
        hasStoredLocator = true;
      }
      matchingIds = matchingIds === undefined
        ? locatorMatches
        : new Set(Array.from(matchingIds).filter((id) => locatorMatches.has(id)));
    }
    if (!hasStoredLocator) continue;
    if (!matchingIds || matchingIds.size === 0) {
      throw lifecycleConflict(
        'Stored file identifiers do not refer to the same upload; upload the file again.',
      );
    }
  }
  const addedTokens = new Set(Array.from(nextTokens).filter((token) => !currentTokens.has(token)));
  for (const token of addedTokens) {
    const upload = uploads.find((candidate) => uploadTokens(candidate).has(token));
    if (!upload) {
      if (token.startsWith('url:')) {
        const knownUploads = await listAll(
          db.table<FileUpload>('file_uploads').where('url', '==', token.slice(4)),
          { label: 'Stored-file exact URL ownership check' },
        );
        // Ordinary external URLs are not stored-file lifecycle references.
        if (knownUploads.length === 0) continue;
      }
      const normalizedStorageKey = originStorageTokenKey(token);
      if (normalizedStorageKey) {
        const knownUploads = await listAll(
          db.table<FileUpload>('file_uploads').where('key', '==', normalizedStorageKey),
          { label: 'Normalized stored-file URL ownership check' },
        );
        // A canonical-looking path on another origin remains an external URL.
        // Equivalent origin/host/default-port/encoding variants of a known
        // upload remain bound to that upload's real owner.
        if (!knownUploads.some((candidate) => uploadTokens(candidate).has(token))) continue;
      }
      throw lifecycleConflict(
        'Stored file metadata is missing or belongs to another target; upload the file again.',
      );
    }
    if (upload.status === 'deleted' || upload.status === 'expired') {
      throw lifecycleConflict('Stored file is no longer available; upload the file again.');
    }
    if (upload.status === 'preparing' || upload.status === 'pending') {
      throw lifecycleConflict('Stored file upload has not completed yet.');
    }
    const completedAt = typeof upload.completedAt === 'string'
      ? Date.parse(upload.completedAt)
      : Number.NaN;
    if (upload.status === 'deleting') {
      if (
        upload.deletionPreviousStatus === 'uploaded'
        || (upload.deletionPreviousStatus == null && Number.isFinite(completedAt))
      ) continue;
      throw lifecycleConflict('Stored file upload has not completed yet.');
    }
    if (upload.status !== 'uploaded') {
      throw lifecycleConflict(
        'Stored file status is not attachable; upload the file again.',
      );
    }
  }
  const transitions: TransactOperation[] = [];
  let legacyClaimSnapshot: WorkspaceFileReferenceSnapshot | undefined;
  for (const upload of uploads) {
    const before = referencesUpload(currentTokens, upload);
    const after = referencesUpload(nextTokens, upload);
    if (
      after
      && legacyUploadIds.has(upload.id)
      && input.association.field === 'templateId'
      && optionalString(upload.templateId) !== input.association.id
    ) {
      legacyClaimSnapshot ??= await workspaceFileReferenceSnapshot(db, upload.workspaceId);
      const conflictingOwner = fileUploadReferenceOwners(upload, legacyClaimSnapshot)
        .find((owner) => owner.templateId !== input.association.id);
      if (conflictingOwner) {
        throw lifecycleConflict(
          'Stored file is already referenced by another owner; upload an independent copy.',
        );
      }
      transitions.push(
        {
          table: 'file_uploads',
          op: 'expect',
          id: upload.id,
          where: [['templateId', '==', upload.templateId ?? null]],
          exists: true,
        },
        {
          table: 'file_uploads',
          op: 'update',
          id: upload.id,
          data: { templateId: input.association.id, updatedAt: nowIso() },
        },
      );
    }
    if (
      before
      && !after
      && (upload.status === 'preparing' || upload.status === 'pending' || upload.status === 'uploaded')
    ) {
      transitions.push(...transitionOperations(upload, 'deleting', input.actorId));
    } else if (after && upload.status === 'deleting') {
      transitions.push(...transitionOperations(upload, 'restore', input.actorId));
    }
  }
  return transitions;
}

/**
 * Atomically commits a record patch and the corresponding upload state
 * transitions. A crash can therefore leave either the old reference + live
 * object or the detached reference + durable `deleting` row, never a dead URL.
 */
export async function updateWithFileReferenceLifecycle<T extends { id: string; updatedAt?: string }>(
  db: DbRef,
  input: FileReferenceUpdateInput<T>,
): Promise<T> {
  const currentTokens = referenceTokens(input.currentReferences);
  const nextTokens = referenceTokens(input.nextReferences);
  if (
    setsEqual(currentTokens, nextTokens)
    && structuredFileLocatorSignature(input.currentReferences)
      === structuredFileLocatorSignature(input.nextReferences)
  ) {
    return db.table<T>(input.table).update(input.current.id, input.data);
  }

  const transitions = await fileReferenceTransitionOperations(db, input);
  if (transitions.length === 0) {
    return db.table<T>(input.table).update(input.current.id, input.data);
  }

  const operations: TransactOperation[] = [
    {
      table: input.table,
      op: 'expect',
      id: input.current.id,
      where: [['updatedAt', '==', input.current.updatedAt ?? null]],
      exists: true,
    },
    ...transitions,
    {
      table: input.table,
      op: 'update',
      id: input.current.id,
      data: input.data,
    },
  ];
  if (operations.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Too many stored files changed in one mutation; remove them in smaller batches.'),
      { status: 413 },
    );
  }
  await db.transact(operations);
  return { ...input.current, ...input.data } as T;
}

/** Upload transitions paired with a target-record delete in the same chunk. */
export async function deletionOperationsForAssociation(
  db: DbRef,
  field: FileAssociationField,
  id: string,
  actorId: string,
) {
  const uploads = await associatedUploads(db, field, id);
  const operations: TransactOperation[] = [];
  for (const upload of uploads) {
    const status = upload.status ?? 'pending';
    if (status === 'deleted' || status === 'expired' || status === 'deleting') continue;
    if (!['preparing', 'pending', 'uploaded'].includes(status)) {
      throw new Error(`Unsupported file upload status during reference deletion: ${status}.`);
    }
    operations.push(...transitionOperations(upload, 'deleting', actorId));
  }
  return operations;
}

/**
 * Last-chance maintenance/delete fence. Normal detach/reattach transitions
 * are atomic with their owner record, but this keeps legacy rows and manual
 * API calls from deleting bytes while a durable owner still advertises them.
 */
export interface WorkspaceFileReferenceSnapshot {
  workspaceId: string;
  tokens: Set<string>;
  owners: WorkspaceFileReferenceOwner[];
}

export interface WorkspaceFileReferenceOwner {
  kind: 'page' | 'block' | 'template' | 'workspace' | 'member';
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  templateId?: string;
  tokens: Set<string>;
}

export interface WorkspaceFileReferenceSnapshotOptions {
  excludePageIds?: Iterable<string>;
  excludeWorkspaceMetadata?: boolean;
}

/**
 * Build one workspace-wide live-reference snapshot. This deliberately does
 * not trust `file_uploads.pageId/blockId`: old duplicated pages could share a
 * key while only the original association row survived. Scanning every live
 * owner before irreversible deletion keeps those legacy references intact.
 */
export async function workspaceFileReferenceSnapshot(
  contentDb: DbRef,
  workspaceId: string,
  metadataDb: DbRef = contentDb,
  options: WorkspaceFileReferenceSnapshotOptions = {},
): Promise<WorkspaceFileReferenceSnapshot> {
  const excludedPageIds = new Set(options.excludePageIds ?? []);
  const pages = (await listAll(
    contentDb.table<{
      id: string;
      workspaceId?: string;
      parentId?: string | null;
      parentType?: string;
      icon?: unknown;
      cover?: unknown;
      properties?: unknown;
    }>('pages')
      .where('workspaceId', '==', workspaceId),
    {
      label: `Stored-file page references for workspace ${workspaceId}`,
      maxItems: MAX_WORKSPACE_REFERENCE_ROWS,
      allowLargeMaterialization: true,
    },
  )).filter((page) => !excludedPageIds.has(page.id));
  const pageIds = new Set(pages.map((page) => page.id));
  const blocks = (await listAll(
    contentDb.table<{ id: string; pageId?: string; content?: unknown }>('blocks'),
    {
      label: `Stored-file block references for workspace ${workspaceId}`,
      maxItems: MAX_WORKSPACE_REFERENCE_ROWS,
      allowLargeMaterialization: true,
    },
  )).filter((block) => typeof block.pageId === 'string' && pageIds.has(block.pageId));
  const templates = (await listAll(
    contentDb.table<{
      id: string;
      databaseId?: string;
      icon?: unknown;
      properties?: unknown;
      blocks?: unknown;
    }>('db_templates'),
    {
      label: `Stored-file template references for workspace ${workspaceId}`,
      maxItems: MAX_WORKSPACE_REFERENCE_ROWS,
      allowLargeMaterialization: true,
    },
  )).filter((template) => typeof template.databaseId === 'string' && pageIds.has(template.databaseId));
  const fileProperties = await listAll(
    contentDb.table<Pick<DbProperty, 'id' | 'databaseId' | 'type'>>('db_properties')
      .where('type', '==', 'files'),
    {
      label: `Stored-file property schemas for workspace ${workspaceId}`,
      maxItems: MAX_WORKSPACE_REFERENCE_ROWS,
      allowLargeMaterialization: true,
    },
  );
  const filePropertyIdsByDatabase = new Map<string, Set<string>>();
  for (const property of fileProperties) {
    if (!pageIds.has(property.databaseId)) continue;
    const ids = filePropertyIdsByDatabase.get(property.databaseId) ?? new Set<string>();
    ids.add(property.id);
    filePropertyIdsByDatabase.set(property.databaseId, ids);
  }
  const workspace = options.excludeWorkspaceMetadata
    ? null
    : await getExisting(
        metadataDb.table<{ id: string; icon?: unknown }>('workspaces'),
        workspaceId,
      );
  const members = options.excludeWorkspaceMetadata
    ? []
    : await listAll(
        metadataDb.table<{ id: string; workspaceId: string; avatar?: unknown }>('workspace_members')
          .where('workspaceId', '==', workspaceId),
        {
          label: `Stored-file member references for workspace ${workspaceId}`,
          maxItems: MAX_WORKSPACE_REFERENCE_ROWS,
          allowLargeMaterialization: true,
        },
      );

  const owners: WorkspaceFileReferenceOwner[] = [
    ...pages.map((page) => ({
      kind: 'page' as const,
      pageId: page.id,
      databaseId:
        page.parentType === 'database' && typeof page.parentId === 'string'
          ? page.parentId
          : undefined,
      tokens: referenceTokens({
        icon: page.icon,
        cover: page.cover,
        properties: page.properties,
        schemaFileProperties: schemaFilePropertyReferences(
          page.properties,
          page.parentType === 'database' && typeof page.parentId === 'string'
            ? filePropertyIdsByDatabase.get(page.parentId) ?? []
            : page.properties && typeof page.properties === 'object' && !Array.isArray(page.properties)
              ? Object.keys(page.properties as Record<string, unknown>)
              : [],
        ),
      }),
    })),
    ...blocks.map((block) => ({
      kind: 'block' as const,
      pageId: block.pageId,
      blockId: block.id,
      tokens: referenceTokens(block.content),
    })),
    ...templates.map((template) => ({
      kind: 'template' as const,
      databaseId: template.databaseId,
      templateId: template.id,
      tokens: referenceTokens({
        icon: template.icon,
        properties: template.properties,
        schemaFileProperties: schemaFilePropertyReferences(
          template.properties,
          filePropertyIdsByDatabase.get(template.databaseId!) ?? [],
        ),
        blocks: template.blocks,
      }),
    })),
    ...(workspace
      ? [{
          kind: 'workspace' as const,
          tokens: referenceTokens(workspace.icon),
        }]
      : []),
    ...members.map((member) => ({
      kind: 'member' as const,
      tokens: referenceTokens(member.avatar),
    })),
  ];

  return {
    workspaceId,
    tokens: new Set(owners.flatMap((owner) => Array.from(owner.tokens))),
    owners,
  };
}

export function fileUploadReferenceOwners(
  upload: FileUpload,
  snapshot: WorkspaceFileReferenceSnapshot,
) {
  return snapshot.owners.filter((owner) => referencesUpload(owner.tokens, upload));
}

export async function fileUploadStillReferenced(
  db: DbRef,
  upload: FileUpload,
  snapshot?: WorkspaceFileReferenceSnapshot,
) {
  const current = snapshot?.workspaceId === upload.workspaceId
    ? snapshot
    : await workspaceFileReferenceSnapshot(db, upload.workspaceId);
  return referencesUpload(current.tokens, upload);
}

export function hasPotentialStoredFileReference(value: unknown) {
  return referenceTokens(value).size > 0;
}

/**
 * Fail-closed guard for owner creation paths that do not yet have an atomic
 * upload-claim/copy protocol. Ordinary external URLs and emoji are allowed;
 * local keys, upload IDs, canonical storage routes, and exact URLs already
 * registered in file_uploads are rejected.
 */
export async function assertNoUnownedStoredFileReferences(
  db: DbRef,
  value: unknown,
  options: { requestUrl?: string } = {},
) {
  const tokens = referenceTokens(value);
  if (Array.from(tokens).some((token) => (
    token.startsWith('id:') || token.startsWith('key:') || token.startsWith('storage:')
  ))) {
    throw lifecycleConflict(
      'Stored files cannot be attached while creating this item; create it first, then upload the file.',
    );
  }
  let requestOrigin: URL | undefined;
  if (options.requestUrl) {
    try {
      requestOrigin = new URL(options.requestUrl);
    } catch {
      requestOrigin = undefined;
    }
  }
  for (const token of tokens) {
    const normalizedStorage = parseOriginStorageToken(token);
    if (
      requestOrigin
      && normalizedStorage
      && (
        (normalizedStorage.kind === 'origin' && normalizedStorage.authority === requestOrigin.origin)
        || (normalizedStorage.kind === 'host' && normalizedStorage.authority === requestOrigin.host)
      )
    ) {
      throw lifecycleConflict(
        'Stored files cannot be attached while creating this item; create it first, then upload the file.',
      );
    }
    if (!token.startsWith('url:')) continue;
    const known = await listAll(
      db.table<FileUpload>('file_uploads').where('url', '==', token.slice(4)),
      { label: 'Create-time stored-file URL ownership check' },
    );
    if (known.length > 0) {
      throw lifecycleConflict(
        'Stored files cannot be attached while creating this item; create it first, then upload the file.',
      );
    }
  }
}

export function storedFileReferencesChanged(current: unknown, next: unknown) {
  return !setsEqual(referenceTokens(current), referenceTokens(next))
    || structuredFileLocatorSignature(current) !== structuredFileLocatorSignature(next);
}
