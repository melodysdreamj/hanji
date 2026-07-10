import { defineFunction } from '@edge-base/shared';
import { boundedDb, boundedDbFromPageHint, boundedDbFromWorkspaceHint, type AdminDbAccessor } from '../lib/workspace-db';
import {
  assertNoActiveLegalHoldForPermanentDelete,
  assertOrganizationDlpPolicy,
} from '../lib/enterprise-controls';
import { assertNotDeactivatedWorkspaceAccess } from '../lib/org-access';
import { assertOrganizationSharingPolicy } from '../lib/org-policy';
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
// Hard cap on caller-requested signed-download TTLs. Without it, `expiresIn`
// like "3650d" mints an effectively permanent URL, defeating the point of a
// time-limited signature.
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
type PageParentType = 'workspace' | 'page' | 'database';
type FileUploadStatus = 'pending' | 'uploaded' | 'deleted' | 'expired';

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
  createdBy?: string;
}

interface Block {
  id: string;
  pageId: string;
}

interface DbProperty {
  id: string;
  databaseId: string;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket: string;
  key: string;
  scope: string;
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  name: string;
  contentType?: string;
  size: number;
  status: FileUploadStatus;
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
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
  head(key: string): Promise<unknown | null>;
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

function uploadGrantExpiresAt() {
  return new Date(Date.now() + UPLOAD_GRANT_TTL_MS).toISOString();
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
  if (typeof value !== 'string') return undefined;
  const contentType = value.trim().toLowerCase();
  if (!contentType) return undefined;
  if (
    contentType.length > 128 ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(contentType)
  ) {
    throw new Error('contentType is invalid.');
  }
  return contentType;
}

function storageUrl(request: Request | undefined, bucket: string, key: string) {
  if (!request) return undefined;
  const origin = new URL(request.url).origin;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${origin}/api/storage/${encodeURIComponent(bucket)}/${encodedKey}`;
}

function storageSignedUrlEndpoint(request: Request | undefined, bucket: string) {
  if (!request) return undefined;
  const origin = new URL(request.url).origin;
  return `${origin}/api/storage/${encodeURIComponent(bucket)}/signed-url`;
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
  if (proxy) {
    const file = await proxy.head(key);
    if (!file) throw new Error('Uploaded file was not found.');
    return storageUrl(request, bucket, key);
  }

  const url = storageUrl(request, bucket, key);
  if (!url) return undefined;
  const headers = new Headers();
  const authorization = request?.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  const response = await fetch(url, { method: 'HEAD', headers });
  if (!response.ok) throw new Error('Uploaded file was not found.');
  return url;
}

async function deleteStoredFile(
  storage: FunctionStorageProxy | undefined,
  request: Request | undefined,
  bucket: string,
  key: string,
) {
  const proxy = storageBucket(storage, bucket);
  if (proxy) {
    await proxy.delete(key);
    return;
  }

  const url = storageUrl(request, bucket, key);
  if (!url || !request) return;
  const headers = new Headers();
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  const response = await fetch(url, { method: 'DELETE', headers });
  if (response.ok || response.status === 404) return;
  throw new Error('Stored file delete failed.');
}

async function createSignedDownloadUrl(
  storage: FunctionStorageProxy | undefined,
  request: Request | undefined,
  bucket: string,
  key: string,
  expiresIn: string,
) {
  const proxy = storageBucket(storage, bucket);
  if (proxy) {
    const url = await proxy.getSignedUrl(key, { expiresIn: secondsFromDuration(expiresIn) });
    const expiresAt = new Date(Date.now() + secondsFromDuration(expiresIn) * 1000).toISOString();
    return { url, expiresAt };
  }

  const url = storageSignedUrlEndpoint(request, bucket);
  if (!url || !request) throw new Error('Download URL requires a request context.');
  const headers = new Headers({ 'content-type': 'application/json' });
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key, expiresIn }),
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error('Stored file was not found.');
    throw new Error('Download URL could not be created.');
  }
  return response.json() as Promise<{ url: string; expiresAt: string }>;
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

async function expirePendingUpload(
  uploads: TableRef<FileUpload>,
  upload: FileUpload,
  actorId: string,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  if (upload.status !== 'pending') return upload;
  await bestEffort('file-mutation deleteStoredFile', deleteStoredFile(storage, request, upload.bucket || FILE_BUCKET, upload.key));
  return uploads.update(upload.id, {
    status: 'expired',
    expiredAt: nowIso(),
    deletedAt: nowIso(),
    deletedBy: actorId,
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

  let pageId = optionalString(source.pageId);
  const blockId = optionalString(source.blockId);
  let databaseId = optionalString(source.databaseId);
  const propertyId = optionalString(source.propertyId);

  if (blockId) {
    const block = await getExisting(blocks, blockId);
    if (!block) throw new Error('Target block was not found.');
    if (pageId && pageId !== block.pageId) throw new Error('Target block is outside the page.');
    pageId = block.pageId;
  }

  if (propertyId) {
    const property = await getExisting(properties, propertyId);
    if (!property) throw new Error('Target database property was not found.');
    if (databaseId && databaseId !== property.databaseId) {
      throw new Error('Target property is outside the database.');
    }
    databaseId = property.databaseId;
  }

  const page = pageId ? await getExisting(pages, pageId) : null;
  if (pageId && (!page || page.inTrash)) throw new Error('Target page was not found.');

  const database = databaseId ? await getExisting(pages, databaseId) : null;
  if (databaseId && (!database || database.kind !== 'database' || database.inTrash)) {
    throw new Error('Target database was not found.');
  }

  const targetPage = page ?? database;
  if (!targetPage) return {};
  if (page && database && page.workspaceId !== database.workspaceId) {
    throw new Error('Target database is outside the page workspace.');
  }

  await assertPageRole(db, targetPage, actorId, minRole, actorEmail);
  return {
    workspaceId: targetPage.workspaceId,
    pageId: page?.id,
    blockId,
    databaseId: database?.id ?? (page?.parentType === 'database' ? page.parentId ?? undefined : undefined),
    propertyId,
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
  if (id) return uploads.getOne(id);

  const key = requireString(body.key, 'key');
  const matches = await listAll(uploads.where('key', '==', key));
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
  if (!['pending', 'uploaded', 'deleted', 'expired'].includes(status)) {
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

function activeStorageReservationBytes(upload: FileUpload, now: number) {
  if (upload.status === 'uploaded') return fileSize(upload);
  if (upload.status === 'pending' && !isUploadGrantExpired(upload, now)) return fileSize(upload);
  return 0;
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
    } else if (status === 'pending') {
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

async function assertOrganizationStorageLimit(
  db: DbRef,
  admin: AdminDbAccessor,
  workspace: Workspace,
  requestedBytes: number,
) {
  if (!workspace.organizationId) return;
  const organization = await getExisting(db.table<Organization>('organizations'), workspace.organizationId);
  const limit = organization?.storageLimitBytes;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return;

  const workspaces = await listAll(
    db.table<Workspace>('workspaces').where('organizationId', '==', workspace.organizationId),
  );
  const now = Date.now();
  let reservedBytes = 0;
  for (const organizationWorkspace of workspaces) {
    // file_uploads lives in each workspace's own block after the split;
    // sibling workspaces' rows are invisible through THIS workspace's routed
    // facade, so the usage sum reads each workspace through its own handle
    // (mirrors organizationFileUsageReport above).
    const contentDb = boundedDb(admin, organizationWorkspace.id) as unknown as DbRef;
    const uploads = await listAll(
      contentDb.table<FileUpload>('file_uploads').where('workspaceId', '==', organizationWorkspace.id),
    );
    for (const upload of uploads) {
      reservedBytes += activeStorageReservationBytes(upload, now);
    }
  }

  if (reservedBytes + requestedBytes > limit) {
    throw new Error('Organization storage limit exceeded.');
  }
}

async function prepareUpload(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
) {
  const target = await resolveUploadTarget(db, body, actorId, 'edit', actorEmail);
  const workspace = target.workspaceId
    ? await workspaceById(db, target.workspaceId)
    : await resolveWorkspace(db, body, actorId);
  const requestedWorkspaceId = optionalString(body.workspaceId);
  if (requestedWorkspaceId && requestedWorkspaceId !== workspace.id) {
    throw new Error('Target file is outside the requested workspace.');
  }
  const uploads = db.table<FileUpload>('file_uploads');
  const id = newId();
  const scope = normalizeScope(body.scope);
  const name = normalizeFileName(body.name);
  const size = parseSize(body.size);
  await assertOrganizationStorageLimit(db, admin, workspace, size);
  const contentType = parseContentType(body.contentType);
  const base = cleanSegment(name);
  const ext = extensionFromName(name);
  const key = `workspaces/${workspace.id}/${scope}/${id}-${base}${ext}`;

  const upload = await uploads.insert({
    id,
    workspaceId: workspace.id,
    bucket: FILE_BUCKET,
    key,
    scope,
    pageId: target.pageId,
    blockId: target.blockId,
    databaseId: target.databaseId,
    propertyId: target.propertyId,
    name,
    contentType,
    size,
    status: 'pending',
    createdBy: actorId,
    expiresAt: uploadGrantExpiresAt(),
  });

  return {
    upload,
    ...(await createSignedUploadUrl(storage, FILE_BUCKET, key, size)),
  };
}

async function completeUpload(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const id = requireString(body.id, 'id');
  const uploads = db.table<FileUpload>('file_uploads');
  const upload = await uploads.getOne(id);
  if (!upload) throw new Error('Upload grant was not found.');
  if (upload.createdBy && upload.createdBy !== actorId) {
    throw new Error('Upload grant was created by a different user.');
  }
  if (typeof body.key === 'string' && body.key !== upload.key) {
    throw new Error('Upload key does not match the grant.');
  }
  await assertUploadAccess(db, upload, actorId, 'edit', actorEmail);
  if (upload.status === 'uploaded') return { upload };
  if (upload.status === 'deleted' || upload.status === 'expired') {
    throw new Error('Upload grant is no longer active.');
  }
  if (isUploadGrantExpired(upload)) {
    await expirePendingUpload(uploads, upload, actorId, storage, request);
    throw new Error('Upload grant has expired.');
  }

  const checkedUrl = await assertStoredFileExists(storage, request, upload.bucket, upload.key);
  const url =
    checkedUrl ?? (typeof body.url === 'string' && body.url.trim() ? body.url.trim() : upload.url);
  const completed = await uploads.update(id, {
    status: 'uploaded',
    url,
    completedAt: nowIso(),
  });

  return { upload: completed };
}

async function listUploads(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
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
  const scope =
    typeof body.scope === 'string' && body.scope.trim() ? normalizeScope(body.scope) : undefined;

  let records = await listAll(uploads.where('workspaceId', '==', workspace.id));
  if (status) {
    records = records.filter((upload) => upload.status === status);
  } else if (!includeDeleted) {
    records = records.filter((upload) => upload.status !== 'deleted' && upload.status !== 'expired');
  }
  if (scope) records = records.filter((upload) => upload.scope === scope);
  const pageId = target.pageId ?? optionalString(body.pageId);
  const blockId = target.blockId ?? optionalString(body.blockId);
  const databaseId = target.databaseId ?? optionalString(body.databaseId);
  const propertyId = target.propertyId ?? optionalString(body.propertyId);
  if (pageId) records = records.filter((upload) => upload.pageId === pageId);
  if (blockId) records = records.filter((upload) => upload.blockId === blockId);
  if (databaseId) records = records.filter((upload) => upload.databaseId === databaseId);
  if (propertyId) records = records.filter((upload) => upload.propertyId === propertyId);

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

  records.sort((a, b) =>
    String(b.completedAt ?? b.createdAt ?? '').localeCompare(String(a.completedAt ?? a.createdAt ?? '')),
  );

  return { uploads: records };
}

async function deleteUpload(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const uploads = db.table<FileUpload>('file_uploads');
  const upload = await findUpload(uploads, body);
  if (!upload) throw new Error('File upload was not found.');
  await assertUploadAccess(db, upload, actorId, 'edit', actorEmail);
  await assertNoActiveLegalHoldForPermanentDelete(
    db,
    upload.workspaceId,
    [upload.pageId, upload.databaseId].filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  if (upload.status !== 'deleted') {
    await deleteStoredFile(storage, request, upload.bucket || FILE_BUCKET, upload.key);
  }

  const deleted = await uploads.update(upload.id, {
    status: 'deleted',
    deletedAt: nowIso(),
    deletedBy: actorId,
  });

  return { upload: deleted };
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
  const upload = await findUpload(uploads, body);
  if (!upload) throw new Error('File upload was not found.');
  await assertUploadAccess(db, upload, actorId, 'view', actorEmail);
  if (upload.status !== 'uploaded') {
    throw new Error('File is not available for download.');
  }
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

  const grant = await createSignedDownloadUrl(
    storage,
    request,
    upload.bucket || FILE_BUCKET,
    upload.key,
    normalizeExpiresIn(body.expiresIn),
  );

  return { upload, ...grant };
}

async function cleanupExpiredUploads(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const workspace = await resolveWorkspace(db, body, actorId);
  const uploads = db.table<FileUpload>('file_uploads');
  const limit = parseLimit(body.limit);
  const dryRun = parseBoolean(body.dryRun);
  const now = Date.now();

  const pending = (await listAll(uploads.where('workspaceId', '==', workspace.id)))
    .filter((upload) => upload.status === 'pending' && isUploadGrantExpired(upload, now))
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

  const expired: FileUpload[] = [];
  for (const upload of accessible) {
    expired.push(await expirePendingUpload(uploads, upload, actorId, storage, request));
  }

  return {
    workspaceId: workspace.id,
    dryRun: false,
    scanned: pending.length,
    expired,
  };
}

function statusForError(message: string) {
  if (/access required|access denied|different user|disabled by organization policy|storage limit/i.test(message)) return 403;
  if (/not found|was not found/i.test(message)) return 404;
  if (
    // "is outside the …" covers the target-mismatch family (block outside the
    // page, file outside the workspace, property outside the database).
    /required|invalid|large|allowed|positive|match|unknown|not available|requires|expired|no longer active|outside the/i.test(message)
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
        return await completeUpload(db, body, auth.id, actorEmail, storage, request);
      case 'list':
        return await listUploads(db, body, auth.id, actorEmail);
      case 'delete':
        return await deleteUpload(db, body, auth.id, actorEmail, storage, request);
      case 'signedUrl':
        return await signedUrl(db, body, auth.id, actorEmail, storage, request);
      case 'cleanupExpired':
        return await cleanupExpiredUploads(db, body, auth.id, storage, request);
      case 'report':
        return await fileUsageReport(db, body, auth.id);
      case 'organizationReport':
        return await organizationFileUsageReport(db, admin, body, auth.id);
      default:
        return jsonError(400, 'Unknown file mutation action.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'File mutation failed.';
    return jsonError(statusForError(message), message);
  }
});
