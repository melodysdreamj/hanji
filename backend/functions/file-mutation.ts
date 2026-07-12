import { defineFunction } from '@edge-base/shared';
import { boundedDb, boundedDbFromPageHint, boundedDbFromWorkspaceHint, type AdminDbAccessor } from '../lib/workspace-db';
import {
  assertNoActiveLegalHoldForPermanentDelete,
  assertOrganizationDlpPolicy,
} from '../lib/enterprise-controls';
import { assertNotDeactivatedWorkspaceAccess } from '../lib/org-access';
import { assertOrganizationSharingPolicy } from '../lib/org-policy';
import { assertSafeStoredFileType, normalizeFileContentType } from '../lib/file-security';
import {
  assertFileTargetsNotDeleting,
  fileOperationConflict,
  withFileWorkspaceLease,
} from '../lib/file-operation-lock';
import {
  fileUploadReferenceOwners,
  fileUploadStillReferenced,
  workspaceFileReferenceSnapshot,
} from '../lib/file-reference-lifecycle';
import { assertPreservableStoredUpload } from '../lib/permanent-file-delete';
import {
  releaseOrganizationStorage,
  reserveOrganizationStorage,
  type StorageQuotaReservation,
} from '../lib/storage-quota';
import {
  pageAccessRole as sharedPageAccessRole,
  workspaceAccessRole as sharedWorkspaceAccessRole,
} from '../lib/page-access';

import {
  bestEffort,
  listAll,
  requireString,
  getExisting,
  nowIso,
  newId,
  type TableQuery,
  type TransactDb,
} from '../lib/table-utils';
import type { ShareRole } from '../lib/page-access';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

const FILE_BUCKET = 'files';
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE_LABEL = '5 GB';
const UPLOAD_GRANT_TTL_MS = 30 * 60 * 1000;
const UPLOAD_GRANT_SAFETY_MS = 5 * 60 * 1000;
// Hard cap on caller-requested signed-download TTLs. Without it, `expiresIn`
// like "3650d" mints an effectively permanent URL, defeating the point of a
// time-limited signature.
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
type PageParentType = 'workspace' | 'page' | 'database';
type FileUploadStatus = 'preparing' | 'pending' | 'uploaded' | 'deleting' | 'deleted' | 'expired';

const allowedScopes = new Set([
  'uploads',
  'icons',
  'covers',
  'blocks/images',
  'blocks/videos',
  'blocks/audio',
  'blocks/files',
  'database/files',
]);

interface Workspace {
  id: string;
  name?: string;
  domain?: string | null;
  ownerId?: string;
  organizationId?: string | null;
  deletionPendingAt?: string | null;
}

interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
}

interface Organization {
  id: string;
  name?: string;
  ownerId?: string;
  storageLimitBytes?: number | null;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  status?: string;
}

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType;
  kind?: 'page' | 'database';
  inTrash?: boolean;
  deletionPendingAt?: string | null;
  createdBy?: string;
}

interface Block {
  id: string;
  pageId: string;
}

interface DbProperty {
  id: string;
  databaseId: string;
  type: string;
}

interface DbTemplate {
  id: string;
  databaseId: string;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket: string;
  key: string;
  scope: string;
  pageId?: string | null;
  blockId?: string | null;
  databaseId?: string | null;
  propertyId?: string | null;
  templateId?: string | null;
  name: string;
  contentType?: string;
  size: number;
  etag?: string;
  status: FileUploadStatus;
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionPreviousStatus?: 'preparing' | 'pending' | 'uploaded' | null;
  createdAt?: string;
  updatedAt?: string;
}

interface FileMaintenanceRun {
  id: string;
  workspaceId: string;
  kind?: string;
  actorId?: string;
  status?: 'success' | 'partial_failure' | 'failed' | string;
  scheduledAt?: string | null;
  startedAt?: string;
  finishedAt?: string;
  scanned?: number;
  expired?: number;
  deletedObjects?: number;
  failedObjects?: number;
  failures?: unknown;
  details?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
  limit(n: number): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  head(key: string): Promise<{
    key: string;
    size: number;
    contentType: string;
    etag?: string;
    customMetadata?: Record<string, string>;
  } | null>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, options?: { expiresIn?: number }): Promise<string>;
  getSignedUploadUrl?(
    key: string,
    options?: { expiresIn?: number; maxBytes?: number | null },
  ): Promise<{ url: string; expiresAt: string; maxBytes: number | null }>;
}

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  admin: {
    db(namespace: string): DbRef;
  };
  storage?: FunctionStorageProxy;
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

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanSegment(value: string) {
  return (
    value
      .trim()
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'file'
  );
}

function normalizeScope(value: unknown) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'uploads';
  const scope = raw
    .split('/')
    .map(cleanSegment)
    .filter(Boolean)
    .join('/');
  if (!allowedScopes.has(scope)) {
    throw new Error('Upload scope is not allowed.');
  }
  return scope;
}

function extensionFromName(name: string) {
  const match = name.match(/\.([a-z0-9]{1,12})$/i);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function normalizeFileName(value: unknown) {
  const name = typeof value === 'string' && value.trim() ? value.trim() : 'Untitled';
  return name.slice(0, 180);
}

function parseSize(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('size must be a positive number.');
  }
  if (value > MAX_FILE_SIZE) {
    throw new Error(`File is too large. The current upload limit is ${MAX_FILE_SIZE_LABEL}.`);
  }
  return Math.floor(value);
}

function parseContentType(value: unknown) {
  return normalizeFileContentType(value);
}

function storageUrl(request: Request | undefined, bucket: string, key: string) {
  if (!request) return undefined;
  const origin = new URL(request.url).origin;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${origin}/api/storage/${encodeURIComponent(bucket)}/${encodedKey}`;
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

export function secondsFromDuration(value: string) {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) return 3600;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  if (unit === 'd') return Math.ceil((amount * 24 * 60 * 60 * 1000) / 1000);
  if (unit === 'h') return Math.ceil((amount * 60 * 60 * 1000) / 1000);
  if (unit === 'm') return Math.ceil((amount * 60 * 1000) / 1000);
  if (unit === 's') return amount;
  return Math.ceil(amount / 1000);
}

async function assertStoredFileExists(
  storage: FunctionStorageProxy | undefined,
  request: Request | undefined,
  bucket: string,
  key: string,
) {
  const proxy = storageBucket(storage, bucket);
  if (!proxy) throw new Error('File verification requires trusted storage access.');
  const file = await proxy.head(key);
  if (!file) throw new Error('Uploaded file was not found.');
  if (typeof file.etag !== 'string' || !file.etag) {
    throw new Error('Uploaded file integrity metadata is not available.');
  }
  return {
    url: storageUrl(request, bucket, key),
    size: file.size,
    contentType: normalizeFileContentType(file.contentType),
    etag: file.etag,
  };
}

async function deleteStoredFile(
  storage: FunctionStorageProxy | undefined,
  bucket: string,
  key: string,
) {
  const proxy = storageBucket(storage, bucket);
  if (!proxy) throw new Error('Stored file deletion requires trusted storage access.');
  await proxy.delete(key);
}

async function createSignedDownloadUrl(
  storage: FunctionStorageProxy | undefined,
  bucket: string,
  key: string,
  expiresIn: string,
) {
  const proxy = storageBucket(storage, bucket);
  if (!proxy) throw new Error('Download URL requires trusted storage access.');
  const url = await proxy.getSignedUrl(key, { expiresIn: secondsFromDuration(expiresIn) });
  const expiresAt = new Date(Date.now() + secondsFromDuration(expiresIn) * 1000).toISOString();
  return { url, expiresAt };
}

async function createSignedUploadUrl(
  storage: FunctionStorageProxy | undefined,
  bucket: string,
  key: string,
  maxBytes: number,
) {
  const proxy = storageBucket(storage, bucket);
  if (!proxy?.getSignedUploadUrl) return undefined;
  const grant = await proxy.getSignedUploadUrl(key, {
    expiresIn: Math.ceil(UPLOAD_GRANT_TTL_MS / 1000),
    maxBytes,
  });
  return {
    uploadUrl: grant.url,
    uploadExpiresAt: grant.expiresAt,
    uploadMaxBytes: grant.maxBytes,
  };
}

function isUploadGrantExpired(upload: FileUpload, at = Date.now()) {
  return !!upload.expiresAt && new Date(upload.expiresAt).getTime() <= at;
}

function hasUnsettledLegacyUploadGrant(upload: FileUpload, at = Date.now()) {
  const completedAt = typeof upload.completedAt === 'string'
    ? Date.parse(upload.completedAt)
    : Number.NaN;
  if (Number.isFinite(completedAt)) return false;
  const uploadedBytesStatus = upload.status === 'uploaded'
    || (upload.status === 'deleting' && upload.deletionPreviousStatus === 'uploaded');
  if (!uploadedBytesStatus) return false;
  const expiry = typeof upload.expiresAt === 'string' ? Date.parse(upload.expiresAt) : Number.NaN;
  return !Number.isFinite(expiry) || expiry > at;
}

async function expirePendingUpload(
  db: DbRef,
  admin: AdminDbAccessor,
  uploads: TableRef<FileUpload>,
  upload: FileUpload,
  actorId: string,
  storage?: FunctionStorageProxy,
) {
  if (upload.status !== 'pending' && upload.status !== 'preparing') return upload;
  if (!isUploadGrantExpired(upload)) {
    // A signed upload URL remains usable until its exact EdgeBase expiry. An
    // early metadata retirement would let a replay recreate an untracked key.
    // Delete the currently invalid object, but leave the durable pending row
    // and quota reservation for the post-expiry maintenance sweep.
    await deleteStoredFile(storage, upload.bucket || FILE_BUCKET, upload.key);
    return upload;
  }
  // Do not retire the row or release its quota until object deletion succeeds.
  // Keeping it pending lets the scheduled maintenance sweep retry safely.
  await deleteStoredFile(storage, upload.bucket || FILE_BUCKET, upload.key);
  await releaseUploadStorageReservation(db, admin, upload);
  const expired = await uploads.update(upload.id, {
    status: 'expired',
    expiredAt: nowIso(),
    deletedAt: nowIso(),
    deletedBy: actorId,
  });
  return expired;
}

async function releaseUploadStorageReservation(
  db: DbRef,
  admin: AdminDbAccessor,
  upload: FileUpload,
) {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), upload.workspaceId);
  if (!workspace?.organizationId) return;
  await releaseOrganizationStorage(admin, {
    id: upload.id,
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    bytes: fileSize(upload),
  });
}

// Role resolution is canonical in lib/page-access; these wrappers only pin
// this function's "missing workspace is an error" contract.
async function workspaceRole(db: DbRef, workspaceId: string, actorId: string): Promise<ShareRole | undefined> {
  return sharedWorkspaceAccessRole(db, workspaceId, actorId, { requireWorkspace: true });
}

async function assertWorkspaceRole(db: DbRef, workspace: Workspace, actorId: string, minRole: ShareRole) {
  const role = await workspaceRole(db, workspace.id, actorId);
  if (role && roleRanks[role] >= roleRanks[minRole]) return role;
  throw new Error('Workspace admin access required.');
}

async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
}

async function assertPageRole(db: DbRef, page: Page, actorId: string, minRole: ShareRole, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks[minRole]) return role;
  throw new Error('Page access required.');
}

async function assertWorkspaceMember(
  db: DbRef,
  members: TableRef<WorkspaceMember>,
  workspace: Workspace,
  actorId: string,
) {
  await assertNotDeactivatedWorkspaceAccess(db, workspace.id, actorId);
  if (workspace.ownerId === actorId) return;
  const workspaceMembers = await listAll(members.where('workspaceId', '==', workspace.id));
  if (!workspaceMembers.some((member) => member.userId === actorId)) {
    throw new Error('Workspace access required.');
  }
}

async function resolveWorkspace(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const workspaces = db.table<Workspace>('workspaces');
  const members = db.table<WorkspaceMember>('workspace_members');
  const requestedWorkspaceId = optionalString(body.workspaceId);

  if (requestedWorkspaceId) {
    const workspace = await workspaces.getOne(requestedWorkspaceId);
    if (!workspace) throw new Error('Workspace was not found.');
    await assertWorkspaceMember(db, members, workspace, actorId);
    return workspace;
  }

  const memberships = await listAll(members.where('userId', '==', actorId));
  for (const membership of memberships) {
    const workspace = await workspaces.getOne(membership.workspaceId).catch(() => null);
    if (workspace) {
      await assertNotDeactivatedWorkspaceAccess(db, workspace.id, actorId);
      return workspace;
    }
  }

  const owned = await listAll(workspaces.where('ownerId', '==', actorId));
  if (owned[0]) return owned[0];

  throw new Error('workspaceId is required.');
}

async function workspaceById(db: DbRef, workspaceId: string) {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  return workspace;
}

function organizationRoleValue(role: string | undefined) {
  if (role === 'owner' || role === 'admin' || role === 'member' || role === 'guest') return role;
  return 'member';
}

async function assertOrganizationStorageAdmin(db: DbRef, organizationId: string, actorId: string) {
  const organization = await getExisting(db.table<Organization>('organizations'), organizationId);
  if (!organization) throw new Error('Organization was not found.');
  if (organization.ownerId === actorId) return organization;
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
  );
  const member = members.find((item) => item.userId === actorId) ?? null;
  const role = organizationRoleValue(member?.role);
  if (member && (member.status ?? 'active') === 'active' && (role === 'owner' || role === 'admin')) {
    return organization;
  }
  throw new Error('Organization admin access required.');
}

async function assertUploadWorkspaceAccess(
  db: DbRef,
  upload: FileUpload,
  actorId: string,
  minRole: ShareRole,
) {
  const workspaces = db.table<Workspace>('workspaces');
  const workspace = await workspaces.getOne(upload.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  if (workspace.deletionPendingAt) {
    throw fileOperationConflict('Workspace deletion is already in progress.');
  }
  // A workspace-scoped upload (no page/block/database target) must still honor
  // the caller's minRole — otherwise a viewer could finalize edit-level uploads.
  await assertWorkspaceRole(db, workspace, actorId, minRole);
  return workspace;
}

async function resolveUploadTarget(
  db: DbRef,
  source: Record<string, unknown> | FileUpload,
  actorId: string,
  minRole: ShareRole,
  actorEmail?: string | null,
) {
  const pages = db.table<Page>('pages');
  const blocks = db.table<Block>('blocks');
  const properties = db.table<DbProperty>('db_properties');
  const templates = db.table<DbTemplate>('db_templates');

  let pageId = optionalString(source.pageId);
  const blockId = optionalString(source.blockId);
  let databaseId = optionalString(source.databaseId);
  const propertyId = optionalString(source.propertyId);
  const templateId = optionalString(source.templateId);

  if (blockId) {
    const block = await getExisting(blocks, blockId);
    if (!block) throw new Error('Target block was not found.');
    if (pageId && pageId !== block.pageId) throw new Error('Target block is outside the page.');
    pageId = block.pageId;
  }

  if (templateId && (pageId || blockId)) {
    throw new Error('Template uploads cannot also target a page or block.');
  }

  if (propertyId) {
    const property = await getExisting(properties, propertyId);
    if (!property) throw new Error('Target database property was not found.');
    if (property.type !== 'files') throw new Error('Target database property is not a files property.');
    if (blockId) throw new Error('A block upload cannot also target a database property.');
    if (databaseId && databaseId !== property.databaseId) {
      throw new Error('Target property is outside the database.');
    }
    databaseId = property.databaseId;
  }

  if (templateId) {
    const template = await getExisting(templates, templateId);
    if (!template) throw new Error('Target database template was not found.');
    if (databaseId && databaseId !== template.databaseId) {
      throw new Error('Target template is outside the database.');
    }
    databaseId = template.databaseId;
  }

  const page = pageId ? await getExisting(pages, pageId) : null;
  if (pageId && (!page || page.inTrash)) throw new Error('Target page was not found.');
  if (page?.deletionPendingAt) throw fileOperationConflict('Target deletion is already in progress.');

  if (page?.parentType === 'database' && page.parentId) {
    if (databaseId && databaseId !== page.parentId) {
      throw new Error('Target database is outside the database row.');
    }
    databaseId = page.parentId;
  } else if (page && databaseId) {
    throw new Error('Target page is not a row in the database.');
  }

  const database = databaseId ? await getExisting(pages, databaseId) : null;
  if (databaseId && (!database || database.kind !== 'database' || database.inTrash)) {
    throw new Error('Target database was not found.');
  }
  if (database?.deletionPendingAt) throw fileOperationConflict('Target deletion is already in progress.');

  const targetPage = page ?? database;
  if (!targetPage) return {};
  if (page && database && page.workspaceId !== database.workspaceId) {
    throw new Error('Target database is outside the page workspace.');
  }

  if (page) await assertPageRole(db, page, actorId, minRole, actorEmail);
  if (database && database.id !== page?.id) {
    await assertPageRole(db, database, actorId, minRole, actorEmail);
  }
  return {
    workspaceId: targetPage.workspaceId,
    pageId: page?.id,
    blockId,
    databaseId: database?.id ?? (page?.parentType === 'database' ? page.parentId ?? undefined : undefined),
    propertyId,
    templateId,
  };
}

async function assertUploadAccess(
  db: DbRef,
  upload: FileUpload,
  actorId: string,
  minRole: ShareRole,
  actorEmail?: string | null,
) {
  const target = await resolveUploadTarget(db, upload, actorId, minRole, actorEmail);
  if (target.workspaceId) {
    if (target.workspaceId !== upload.workspaceId) {
      throw new Error('File target is outside the upload workspace.');
    }
    return;
  }
  await assertUploadWorkspaceAccess(db, upload, actorId, minRole);
}

async function findUpload(uploads: TableRef<FileUpload>, body: Record<string, unknown>) {
  const id =
    typeof body.id === 'string' && body.id.trim()
      ? body.id.trim()
      : typeof body.uploadId === 'string' && body.uploadId.trim()
        ? body.uploadId.trim()
        : undefined;
  const providedKey = typeof body.key === 'string' && body.key.trim()
    ? body.key.trim()
    : undefined;
  if (id) {
    const upload = await uploads.getOne(id);
    if (upload && providedKey && upload.key !== providedKey) {
      throw fileOperationConflict('File upload id and storage key do not match.');
    }
    return upload;
  }

  const key = requireString(providedKey, 'key');
  const matches = await listAll(uploads.where('key', '==', key));
  if (matches.length > 1) {
    throw fileOperationConflict('Storage key matches more than one file upload; provide its upload id.');
  }
  return matches[0] ?? null;
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return fallback;
}

function parseLimit(value: unknown, fallback = 200, max = 1000) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function normalizeStatus(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const status = value.trim();
  if (!['preparing', 'pending', 'uploaded', 'deleting', 'deleted', 'expired'].includes(status)) {
    throw new Error('status is invalid.');
  }
  return status as FileUploadStatus;
}

export function normalizeExpiresIn(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '1h';
  const expiresIn = value.trim();
  if (!/^\d+(ms|s|m|h|d)$/i.test(expiresIn)) {
    throw new Error('expiresIn is invalid.');
  }
  // Clamp so no caller can mint an effectively permanent signed URL.
  const seconds = Math.min(
    Math.max(1, secondsFromDuration(expiresIn)),
    MAX_SIGNED_URL_TTL_SECONDS,
  );
  return `${seconds}s`;
}

function fileSize(upload: FileUpload) {
  return typeof upload.size === 'number' && Number.isFinite(upload.size)
    ? Math.max(0, Math.floor(upload.size))
    : 0;
}

function bumpFileStat(
  stats: Record<string, { count: number; bytes: number }>,
  key: string | undefined,
  bytes: number,
) {
  const name = key || 'unknown';
  stats[name] ??= { count: 0, bytes: 0 };
  stats[name].count += 1;
  stats[name].bytes += bytes;
}

function uploadTimestamp(upload: FileUpload) {
  return String(upload.completedAt ?? upload.updatedAt ?? upload.createdAt ?? '');
}

function summarizeFileUploads(uploads: FileUpload[], now: number) {
  const byStatus: Record<string, { count: number; bytes: number }> = {};
  const byScope: Record<string, { count: number; bytes: number }> = {};
  const byContentType: Record<string, { count: number; bytes: number }> = {};
  const totals = {
    files: 0,
    bytes: 0,
    activeStorageBytes: 0,
    uploadedBytes: 0,
    pendingBytes: 0,
    deletedBytes: 0,
    expiredBytes: 0,
  };
  const pending = {
    active: 0,
    expired: 0,
  };

  for (const upload of uploads) {
    const status = upload.status || 'pending';
    const bytes = fileSize(upload);
    totals.files += 1;
    totals.bytes += bytes;
    bumpFileStat(byStatus, status, bytes);
    bumpFileStat(byScope, upload.scope || 'uploads', bytes);
    bumpFileStat(byContentType, upload.contentType || 'unknown', bytes);

    if (status === 'uploaded') {
      totals.uploadedBytes += bytes;
      totals.activeStorageBytes += bytes;
    } else if (status === 'pending' || status === 'preparing') {
      totals.pendingBytes += bytes;
      if (isUploadGrantExpired(upload, now)) pending.expired += 1;
      else pending.active += 1;
    } else if (status === 'deleted') {
      totals.deletedBytes += bytes;
    } else if (status === 'expired') {
      totals.expiredBytes += bytes;
    }
  }

  const recentUploads = [...uploads]
    .sort((a, b) => uploadTimestamp(b).localeCompare(uploadTimestamp(a)))
    .slice(0, 20);
  const largestUploads = [...uploads]
    .filter((upload) => upload.status === 'uploaded')
    .sort((a, b) => fileSize(b) - fileSize(a))
    .slice(0, 10);

  return {
    totals,
    pending,
    byStatus,
    byScope,
    byContentType,
    largestUploads,
    recentUploads,
  };
}

function buildFileUsageReport(input: {
  workspaceId?: string;
  organizationId?: string;
  organizationName?: string;
  storageLimitBytes?: number | null;
  workspaces?: Workspace[];
  uploads: FileUpload[];
  maintenanceRuns: FileMaintenanceRun[];
  maintenanceLimit: unknown;
}) {
  const now = Date.now();
  const summary = summarizeFileUploads(input.uploads, now);
  const maintenanceLimit = parseLimit(input.maintenanceLimit, 10, 50);
  const maintenanceRuns = [...input.maintenanceRuns]
    .sort((a, b) => String(b.startedAt ?? b.createdAt ?? '').localeCompare(String(a.startedAt ?? a.createdAt ?? '')))
    .slice(0, maintenanceLimit);
  const uploadsByWorkspace = new Map<string, FileUpload[]>();
  for (const upload of input.uploads) {
    const list = uploadsByWorkspace.get(upload.workspaceId) ?? [];
    list.push(upload);
    uploadsByWorkspace.set(upload.workspaceId, list);
  }
  const byWorkspace = input.workspaces?.map((workspace) => {
    const workspaceSummary = summarizeFileUploads(uploadsByWorkspace.get(workspace.id) ?? [], now);
    return {
      workspaceId: workspace.id,
      name: workspace.name ?? 'Untitled workspace',
      domain: workspace.domain ?? null,
      totals: workspaceSummary.totals,
      pending: workspaceSummary.pending,
    };
  });

  return {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    storageLimitBytes: input.storageLimitBytes ?? null,
    workspaceCount: input.workspaces?.length,
    generatedAt: nowIso(),
    ...summary,
    maintenanceRuns,
    byWorkspace,
  };
}

async function fileUsageReport(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const workspace = await resolveWorkspace(db, body, actorId);
  await assertWorkspaceRole(db, workspace, actorId, 'full_access');

  const uploads = await listAll(db.table<FileUpload>('file_uploads').where('workspaceId', '==', workspace.id));
  const maintenanceRuns = await listAll(
    db.table<FileMaintenanceRun>('file_maintenance_runs').where('workspaceId', '==', workspace.id),
  );

  return buildFileUsageReport({
    workspaceId: workspace.id,
    uploads,
    maintenanceRuns,
    maintenanceLimit: body.maintenanceLimit,
  });
}

async function organizationFileUsageReport(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const organization = await assertOrganizationStorageAdmin(db, organizationId, actorId);
  const workspaces = await listAll(
    db.table<Workspace>('workspaces').where('organizationId', '==', organizationId),
  );
  const uploads: FileUpload[] = [];
  const maintenanceRuns: FileMaintenanceRun[] = [];
  for (const workspace of workspaces) {
    // file_uploads lives per workspace block after the split; maintenance
    // runs stay central.
    const contentDb = boundedDb(admin, workspace.id) as unknown as DbRef;
    uploads.push(
      ...(await listAll(contentDb.table<FileUpload>('file_uploads').where('workspaceId', '==', workspace.id))),
    );
    maintenanceRuns.push(
      ...(await listAll(
        db.table<FileMaintenanceRun>('file_maintenance_runs').where('workspaceId', '==', workspace.id),
      )),
    );
  }
  return buildFileUsageReport({
    organizationId,
    organizationName: organization.name,
    storageLimitBytes: organization.storageLimitBytes ?? null,
    workspaces,
    uploads,
    maintenanceRuns,
    maintenanceLimit: body.maintenanceLimit,
  });
}

async function prepareUpload(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
) {
  const initialTarget = await resolveUploadTarget(db, body, actorId, 'edit', actorEmail);
  const workspace = initialTarget.workspaceId
    ? await workspaceById(db, initialTarget.workspaceId)
    : await resolveWorkspace(db, body, actorId);
  const requestedWorkspaceId = optionalString(body.workspaceId);
  if (requestedWorkspaceId && requestedWorkspaceId !== workspace.id) {
    throw new Error('Target file is outside the requested workspace.');
  }
  if (!initialTarget.workspaceId) {
    await assertWorkspaceRole(db, workspace, actorId, 'edit');
  }
  return withFileWorkspaceLease(db, workspace.id, actorId, 'prepare-upload', async (lease) => {
    await lease.assertOwned();
    const target = await resolveUploadTarget(db, body, actorId, 'edit', actorEmail);
    const currentWorkspace = target.workspaceId
      ? await workspaceById(db, target.workspaceId)
      : await workspaceById(db, workspace.id);
    if (currentWorkspace.id !== workspace.id) {
      throw new Error('Target file is outside the requested workspace.');
    }
    if (!target.workspaceId) {
      await assertWorkspaceRole(db, currentWorkspace, actorId, 'edit');
    }
    await assertFileTargetsNotDeleting(db, workspace.id, [target.pageId, target.databaseId]);

    const uploads = db.table<FileUpload>('file_uploads');
    const id = newId();
    const scope = normalizeScope(body.scope);
    const name = normalizeFileName(body.name);
    const size = parseSize(body.size);
    const contentType = assertSafeStoredFileType(name, parseContentType(body.contentType));
    const base = cleanSegment(name);
    const ext = extensionFromName(name);
    const key = `workspaces/${workspace.id}/${scope}/${id}-${base}${ext}`;
    const provisionalExpiresAt = new Date(
      Date.now() + UPLOAD_GRANT_TTL_MS + UPLOAD_GRANT_SAFETY_MS,
    ).toISOString();

    let reservation: StorageQuotaReservation | null = null;
    let upload: FileUpload | null = null;
    let issuedGrantExpiresAt: string | null = null;
    let grantIssued = false;
    try {
      // Register a durable, scan-excluded placeholder before reserving quota.
      // A crash at any later step remains discoverable by maintenance without
      // double-counting the placeholder during aggregate reconstruction.
      upload = await uploads.insert({
        id,
        workspaceId: workspace.id,
        bucket: FILE_BUCKET,
        key,
        scope,
        pageId: target.pageId,
        blockId: target.blockId,
        databaseId: target.databaseId,
        propertyId: target.propertyId,
        templateId: target.templateId,
        name,
        contentType,
        size,
        status: 'preparing',
        createdBy: actorId,
        expiresAt: provisionalExpiresAt,
      });
      reservation = await reserveOrganizationStorage(admin, currentWorkspace, id, size);
      const grant = await createSignedUploadUrl(storage, FILE_BUCKET, key, size);
      grantIssued = !!grant;
      issuedGrantExpiresAt = grant?.uploadExpiresAt ?? provisionalExpiresAt;
      const activated = await uploads.update(id, {
        status: 'pending',
        // The platform-generated token can expire slightly after a locally
        // computed timestamp. Persist its exact expiry so cleanup never races
        // a still-valid signed PUT.
        expiresAt: issuedGrantExpiresAt,
      });

      return { upload: activated, ...grant };
    } catch (error) {
      if (upload && grantIssued) {
        // A signed PUT can remain usable even though activating the metadata
        // row failed. Keep the row + quota reservation retryable until the
        // exact credential deadline; maintenance will delete bytes, release
        // quota, and retire metadata after that boundary.
        await bestEffort(
          'file-mutation preserve issued grant after activation failure',
          uploads.update(upload.id, {
            status: 'pending',
            expiresAt: issuedGrantExpiresAt ?? provisionalExpiresAt,
          }),
        );
        throw error;
      }
      let quotaReleased = !reservation;
      if (reservation) {
        quotaReleased = await bestEffort(
          'file-mutation release quota after prepare failure',
          releaseOrganizationStorage(admin, reservation),
        );
      }
      if (upload && quotaReleased) {
        await bestEffort(
          'file-mutation expire upload after prepare failure',
          uploads.update(upload.id, {
            status: 'expired',
            // A quota/storage failure before URL issuance has no credential
            // that can race later deletion. Preserve the expiry only when a
            // signed grant was actually minted and may still be usable.
            expiresAt: issuedGrantExpiresAt,
            expiredAt: nowIso(),
            deletedAt: nowIso(),
            deletedBy: actorId,
          }),
        );
      }
      throw error;
    }
  });
}

async function completeUpload(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const id = requireString(body.id, 'id');
  const uploads = db.table<FileUpload>('file_uploads');
  const initial = await uploads.getOne(id);
  if (!initial) throw new Error('Upload grant was not found.');

  return withFileWorkspaceLease(db, initial.workspaceId, actorId, 'complete-upload', async (lease) => {
    await lease.assertOwned();
    const upload = await uploads.getOne(id);
    if (!upload) throw new Error('Upload grant was not found.');
    if (upload.createdBy && upload.createdBy !== actorId) {
      throw new Error('Upload grant was created by a different user.');
    }
    if (typeof body.key === 'string' && body.key !== upload.key) {
      throw new Error('Upload key does not match the grant.');
    }
    await assertUploadAccess(db, upload, actorId, 'edit', actorEmail);
    await assertFileTargetsNotDeleting(db, upload.workspaceId, [upload.pageId, upload.databaseId]);
    if (upload.status === 'uploaded') return { upload };
    if (upload.status !== 'pending') {
      throw new Error('Upload grant is no longer active.');
    }
    if (isUploadGrantExpired(upload)) {
      await expirePendingUpload(db, admin, uploads, upload, actorId, storage);
      throw new Error('Upload grant has expired.');
    }

    let stored: Awaited<ReturnType<typeof assertStoredFileExists>>;
    try {
      stored = await assertStoredFileExists(storage, request, upload.bucket, upload.key);
      if (stored.size !== fileSize(upload)) {
        throw new Error('Uploaded file size does not match the grant.');
      }
      const expectedContentType = assertSafeStoredFileType(upload.name, upload.contentType);
      const actualContentType = assertSafeStoredFileType(upload.name, stored.contentType);
      if (actualContentType !== expectedContentType) {
        throw new Error('Uploaded file content type does not match the grant.');
      }
    } catch (error) {
      await expirePendingUpload(db, admin, uploads, upload, actorId, storage);
      throw error;
    }
    await lease.renew();
    await assertFileTargetsNotDeleting(db, upload.workspaceId, [upload.pageId, upload.databaseId]);
    const url =
      stored.url ?? (typeof body.url === 'string' && body.url.trim() ? body.url.trim() : upload.url);
    const completed = await uploads.update(id, {
      status: 'uploaded',
      url,
      etag: stored.etag,
      completedAt: nowIso(),
      // A successful signed upload consumed EdgeBase's one-time grant. Clear
      // the grant expiry so permanent page/workspace deletion does not wait
      // for a credential that can no longer be replayed. Legacy uploaded rows
      // that still carry a future expiry remain fail-closed until it passes.
      expiresAt: null,
    });

    return { upload: completed };
  });
}

async function restoreDeletingUploadWhenLive(
  db: DbRef,
  uploads: TableRef<FileUpload>,
  upload: FileUpload,
  snapshot: Awaited<ReturnType<typeof workspaceFileReferenceSnapshot>>,
  actorId: string,
  actorEmail?: string | null,
) {
  if (upload.status !== 'deleting') return upload;
  if (
    upload.deletionPreviousStatus
    && upload.deletionPreviousStatus !== 'uploaded'
  ) {
    return upload;
  }
  if (!(await fileUploadStillReferenced(db, upload, snapshot))) return upload;
  let accessibleOwnerUpload: FileUpload | null = null;
  for (const owner of fileUploadReferenceOwners(upload, snapshot)) {
    const candidate: FileUpload = {
      ...upload,
      pageId: owner.pageId ?? null,
      blockId: owner.blockId ?? null,
      databaseId: owner.databaseId ?? null,
      propertyId: null,
      templateId: owner.templateId ?? null,
    };
    try {
      await assertUploadAccess(db, candidate, actorId, 'view', actorEmail);
      accessibleOwnerUpload = candidate;
      break;
    } catch {
      // A stale association never authorizes a different surviving owner.
    }
  }
  if (!accessibleOwnerUpload) return upload;
  return uploads.update(upload.id, {
    status: 'uploaded',
    expiresAt: null,
    deletedAt: null,
    deletedBy: null,
    deletionPreviousStatus: null,
    pageId: accessibleOwnerUpload.pageId,
    blockId: accessibleOwnerUpload.blockId,
    databaseId: accessibleOwnerUpload.databaseId,
    propertyId: accessibleOwnerUpload.propertyId,
    templateId: accessibleOwnerUpload.templateId,
    updatedAt: nowIso(),
  });
}

async function listUploads(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
) {
  const target = await resolveUploadTarget(db, body, actorId, 'view', actorEmail);
  const workspace = target.workspaceId
    ? await workspaceById(db, target.workspaceId)
    : await resolveWorkspace(db, body, actorId);
  const requestedWorkspaceId = optionalString(body.workspaceId);
  if (requestedWorkspaceId && requestedWorkspaceId !== workspace.id) {
    throw new Error('Target file is outside the requested workspace.');
  }
  const uploads = db.table<FileUpload>('file_uploads');
  const includeDeleted = parseBoolean(body.includeDeleted);
  const status = normalizeStatus(body.status);
  if (includeDeleted || status === 'deleting' || status === 'deleted' || status === 'expired') {
    await assertWorkspaceRole(db, workspace, actorId, 'full_access');
  }
  const scope =
    typeof body.scope === 'string' && body.scope.trim() ? normalizeScope(body.scope) : undefined;

  let records = await listAll(uploads.where('workspaceId', '==', workspace.id));
  if (scope) records = records.filter((upload) => upload.scope === scope);
  // Reconnect only to an owner the requesting actor can actually view. This
  // happens before target filtering: the stale association may point at the
  // detached source while the surviving reference belongs to another page.
  if (!status && !includeDeleted && records.some((upload) => upload.status === 'deleting')) {
    records = await withFileWorkspaceLease(
      db,
      workspace.id,
      actorId,
      'restore-live-file-list',
      async (lease) => {
        await lease.assertOwned();
        const snapshot = await workspaceFileReferenceSnapshot(db, workspace.id);
        const restored: FileUpload[] = [];
        for (const record of records) {
          const fresh = await uploads.getOne(record.id).catch(() => null);
          if (!fresh) continue;
          if (fresh.status === 'deleting') {
            try {
              await assertPreservableStoredUpload(storage, fresh);
            } catch {
              restored.push(fresh);
              continue;
            }
          }
          restored.push(await restoreDeletingUploadWhenLive(
            db,
            uploads,
            fresh,
            snapshot,
            actorId,
            actorEmail,
          ));
        }
        return restored;
      },
    );
  }
  const pageId = target.pageId ?? optionalString(body.pageId);
  const blockId = target.blockId ?? optionalString(body.blockId);
  const databaseId = target.databaseId ?? optionalString(body.databaseId);
  const propertyId = target.propertyId ?? optionalString(body.propertyId);
  const templateId = target.templateId ?? optionalString(body.templateId);
  if (pageId) records = records.filter((upload) => upload.pageId === pageId);
  if (blockId) records = records.filter((upload) => upload.blockId === blockId);
  if (databaseId) records = records.filter((upload) => upload.databaseId === databaseId);
  if (propertyId) records = records.filter((upload) => upload.propertyId === propertyId);
  if (templateId) records = records.filter((upload) => upload.templateId === templateId);

  const accessible: FileUpload[] = [];
  for (const upload of records) {
    try {
      await assertUploadAccess(db, upload, actorId, 'view', actorEmail);
      accessible.push(upload);
    } catch {
      // Omit files attached to pages the actor cannot view.
    }
  }
  records = accessible;

  if (status) {
    records = records.filter((upload) => upload.status === status);
  } else if (!includeDeleted) {
    records = records.filter(
      (upload) => upload.status !== 'deleting' && upload.status !== 'deleted' && upload.status !== 'expired',
    );
  }

  records.sort((a, b) =>
    String(b.completedAt ?? b.createdAt ?? '').localeCompare(String(a.completedAt ?? a.createdAt ?? '')),
  );

  return { uploads: records };
}

async function deleteUpload(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
) {
  const uploads = db.table<FileUpload>('file_uploads');
  const initial = await findUpload(uploads, body);
  if (!initial) throw new Error('File upload was not found.');

  return withFileWorkspaceLease(db, initial.workspaceId, actorId, 'delete-upload', async (lease) => {
    await lease.assertOwned();
    const upload = await uploads.getOne(initial.id);
    if (!upload) throw new Error('File upload was not found.');
    await assertUploadAccess(db, upload, actorId, 'edit', actorEmail);
    await assertFileTargetsNotDeleting(db, upload.workspaceId, [upload.pageId, upload.databaseId]);
    await assertNoActiveLegalHoldForPermanentDelete(
      db,
      upload.workspaceId,
      [upload.pageId, upload.databaseId].filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    const referenceSnapshot = await workspaceFileReferenceSnapshot(db, upload.workspaceId);
    if (await fileUploadStillReferenced(db, upload, referenceSnapshot)) {
      throw fileOperationConflict('Detach every stored-file reference before deleting the file.');
    }
    const grantExpiry = typeof upload.expiresAt === 'string' ? Date.parse(upload.expiresAt) : Number.NaN;
    if (
      hasUnsettledLegacyUploadGrant(upload)
      || (Number.isFinite(grantExpiry) && grantExpiry > Date.now())
      || ((!upload.expiresAt || !Number.isFinite(grantExpiry)) && (upload.status === 'preparing' || upload.status === 'pending'))
    ) {
      throw fileOperationConflict('File deletion is waiting for the active upload grant to expire.');
    }

    // Re-delete even an already-retired row to repair legacy best-effort
    // paths. Object deletion and quota settlement must both succeed before
    // metadata stops advertising a retryable active state.
    await deleteStoredFile(storage, upload.bucket || FILE_BUCKET, upload.key);
    await releaseUploadStorageReservation(db, admin, upload);
    await lease.renew();
    const deleted = await uploads.update(upload.id, {
      status: 'deleted',
      deletedAt: nowIso(),
      deletedBy: actorId,
    });

    return { upload: deleted };
  });
}

async function signedUrl(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const uploads = db.table<FileUpload>('file_uploads');
  let upload = await findUpload(uploads, body);
  if (!upload) throw new Error('File upload was not found.');
  if (upload.status !== 'deleting') {
    await assertUploadAccess(db, upload, actorId, 'view', actorEmail);
    await assertFileTargetsNotDeleting(db, upload.workspaceId, [upload.pageId, upload.databaseId]);
  } else if (hasUnsettledLegacyUploadGrant(upload)) {
    await assertUploadAccess(db, upload, actorId, 'view', actorEmail);
  }
  if (hasUnsettledLegacyUploadGrant(upload)) {
    throw fileOperationConflict(
      'File download is waiting for the active legacy upload grant to expire.',
    );
  }
  if (upload.status === 'deleting') {
    upload = await withFileWorkspaceLease(
      db,
      upload.workspaceId,
      actorId,
      'restore-live-file-download',
      async (lease) => {
        await lease.assertOwned();
        const fresh = await uploads.getOne(upload!.id).catch(() => null);
        if (!fresh) throw new Error('File upload was not found.');
        await assertPreservableStoredUpload(storage, fresh);
        const snapshot = await workspaceFileReferenceSnapshot(db, fresh.workspaceId);
        return restoreDeletingUploadWhenLive(
          db,
          uploads,
          fresh,
          snapshot,
          actorId,
          actorEmail,
        );
      },
    );
  }
  if (upload.status !== 'uploaded') {
    throw new Error('File is not available for download.');
  }
  await assertUploadAccess(db, upload, actorId, 'view', actorEmail);
  await assertFileTargetsNotDeleting(db, upload.workspaceId, [upload.pageId, upload.databaseId]);
  await assertOrganizationSharingPolicy(
    db,
    upload.workspaceId,
    'fileDownloads',
    'File downloads are disabled by organization policy.',
  );
  await assertOrganizationDlpPolicy(
    db,
    upload.workspaceId,
    'fileDownloads',
    'File downloads are blocked by organization DLP policy.',
  );

  const stored = await assertStoredFileExists(
    storage,
    request,
    upload.bucket || FILE_BUCKET,
    upload.key,
  );
  const expectedContentType = assertSafeStoredFileType(upload.name, upload.contentType);
  const actualContentType = assertSafeStoredFileType(upload.name, stored.contentType);
  if (
    !upload.etag
    || stored.etag !== upload.etag
    || stored.size !== fileSize(upload)
    || actualContentType !== expectedContentType
  ) {
    throw fileOperationConflict('Stored file integrity verification failed.');
  }

  const grant = await createSignedDownloadUrl(
    storage,
    upload.bucket || FILE_BUCKET,
    upload.key,
    normalizeExpiresIn(body.expiresIn),
  );

  return { upload, ...grant };
}

async function cleanupExpiredUploads(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
) {
  const workspace = await resolveWorkspace(db, body, actorId);
  const uploads = db.table<FileUpload>('file_uploads');
  const limit = parseLimit(body.limit);
  const dryRun = parseBoolean(body.dryRun);
  const now = Date.now();

  const pending = (await listAll(uploads.where('workspaceId', '==', workspace.id)))
    .filter(
      (upload) =>
        (upload.status === 'pending' || upload.status === 'preparing')
        && isUploadGrantExpired(upload, now),
    )
    .sort((a, b) => String(a.expiresAt ?? '').localeCompare(String(b.expiresAt ?? '')))
    .slice(0, limit);

  const accessible: FileUpload[] = [];
  for (const upload of pending) {
    try {
      await assertUploadAccess(db, upload, actorId, 'edit');
      accessible.push(upload);
    } catch {
      // Omit expired grants attached to pages the actor cannot edit.
    }
  }

  if (dryRun) {
    return { workspaceId: workspace.id, dryRun: true, scanned: pending.length, expired: accessible };
  }

  const expired = await withFileWorkspaceLease(
    db,
    workspace.id,
    actorId,
    'cleanup-expired-uploads',
    async (lease) => {
      const cleaned: FileUpload[] = [];
      for (const candidate of accessible) {
        await lease.renew();
        const upload = await uploads.getOne(candidate.id).catch(() => null);
        if (!upload || (upload.status !== 'pending' && upload.status !== 'preparing') || !isUploadGrantExpired(upload, now)) {
          continue;
        }
        cleaned.push(await expirePendingUpload(db, admin, uploads, upload, actorId, storage));
      }
      return cleaned;
    },
  );

  return {
    workspaceId: workspace.id,
    dryRun: false,
    scanned: pending.length,
    expired,
  };
}

function statusForError(message: string) {
  if (/already in progress|operation is already in progress|lease ownership was lost|waiting for the active/i.test(message)) return 409;
  if (/access required|access denied|different user|disabled by organization policy|storage limit/i.test(message)) return 403;
  if (/not found|was not found/i.test(message)) return 404;
  if (
    // "is outside the …" covers the target-mismatch family (block outside the
    // page, file outside the workspace, property outside the database).
    /required|invalid|large|allowed|positive|match|unknown|not available|not a files|requires|expired|no longer active|outside the|cannot also target/i.test(message)
  ) {
    return 400;
  }
  return 500;
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request, storage } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  // Upload keys embed their workspace (`workspaces/<id>/<scope>/...`), so
  // key-shaped requests (completeUpload, delete, signedUrl) route without a
  // client-provided hint. A forged key only reaches a facade whose
  // file_uploads rows won't contain the upload — lookups fail closed.
  const keyWorkspaceId =
    typeof body.key === 'string' ? /^workspaces\/([^/]+)\//.exec(body.key)?.[1] : undefined;
  const actorEmail = auth.email ?? null;
  const routeHint = optionalString(body.workspaceId)
    ?? keyWorkspaceId
    ?? optionalString(body.pageId)
    ?? optionalString(body.databaseId);
  if (
    ['completeUpload', 'list', 'delete', 'signedUrl', 'cleanupExpired', 'report'].includes(action)
    && !routeHint
  ) {
    return jsonError(400, 'workspaceId or a workspace-qualified storage key is required.');
  }

  try {
    // Inside the try so routing misses map through statusForError below.
    // organizationReport is a cross-workspace admin read: it starts from the
    // central directory and fans out per workspace itself.
    const db =
      action === 'organizationReport'
        ? admin.db('app')
        : body.workspaceId
          ? boundedDbFromWorkspaceHint(admin, body.workspaceId)
          : keyWorkspaceId
            ? boundedDbFromWorkspaceHint(admin, keyWorkspaceId)
            : await boundedDbFromPageHint(admin, body.pageId, body.databaseId);
    switch (action) {
      case 'prepareUpload':
        return await prepareUpload(db, admin, body, auth.id, actorEmail, storage);
      case 'completeUpload':
        return await completeUpload(db, admin, body, auth.id, actorEmail, storage, request);
      case 'list':
        return await listUploads(db, body, auth.id, actorEmail, storage);
      case 'delete':
        return await deleteUpload(db, admin, body, auth.id, actorEmail, storage);
      case 'signedUrl':
        return await signedUrl(db, body, auth.id, actorEmail, storage, request);
      case 'cleanupExpired':
        return await cleanupExpiredUploads(db, admin, body, auth.id, storage);
      case 'report':
        return await fileUsageReport(db, body, auth.id);
      case 'organizationReport':
        return await organizationFileUsageReport(db, admin, body, auth.id);
      default:
        return jsonError(400, 'Unknown file mutation action.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'File mutation failed.';
    const explicitStatus = err && typeof err === 'object'
      ? Number((err as { status?: unknown; code?: unknown }).status
        ?? (err as { status?: unknown; code?: unknown }).code)
      : Number.NaN;
    const status = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
      ? explicitStatus
      : statusForError(message);
    return jsonError(status, status >= 500 ? 'Internal server error.' : message);
  }
});
