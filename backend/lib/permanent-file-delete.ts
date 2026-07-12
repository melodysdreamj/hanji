import type { FunctionStorageProxy } from './app-types';
import { assertSafeStoredFileType } from './file-security';
import { fileOperationConflict, type FileWorkspaceLeaseGuard } from './file-operation-lock';
import { releaseOrganizationStorage } from './storage-quota';
import {
  fileUploadReferenceOwners,
  workspaceFileReferenceSnapshot,
} from './file-reference-lifecycle';
import { workspaceDb, type AdminDbAccessor } from './workspace-db';

const FILE_BUCKET = 'files';
const DELETE_CONCURRENCY = 10;

export interface PermanentDeleteUpload {
  id: string;
  workspaceId: string;
  bucket?: string | null;
  key?: string | null;
  name?: string | null;
  size?: number | null;
  contentType?: string | null;
  etag?: string | null;
  completedAt?: string | null;
  status?: string | null;
  expiresAt?: string | null;
  pageId?: string | null;
  blockId?: string | null;
  databaseId?: string | null;
  propertyId?: string | null;
  templateId?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionPreviousStatus?: string | null;
}

interface PermanentDeleteWorkspace {
  id: string;
  organizationId?: string | null;
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
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

export async function assertPreservableStoredUpload(
  storage: FunctionStorageProxy | undefined,
  upload: PermanentDeleteUpload,
) {
  if (
    upload.status !== 'uploaded'
    && !(upload.status === 'deleting' && upload.deletionPreviousStatus === 'uploaded')
  ) {
    throw fileOperationConflict(
      'A surviving file reference points to an upload that was never completed; permanent deletion was stopped.',
    );
  }
  if (!upload.key) {
    throw fileOperationConflict('A surviving file reference has no stored object key.');
  }
  if (!upload.completedAt || !Number.isFinite(Date.parse(upload.completedAt))) {
    throw fileOperationConflict('A surviving file reference has no verified completion record.');
  }
  const proxy = storageBucket(storage, upload.bucket || FILE_BUCKET);
  if (!proxy?.head) {
    throw fileOperationConflict('Surviving file integrity could not be verified before permanent deletion.');
  }
  const stored = await proxy.head(upload.key);
  if (!stored) {
    throw fileOperationConflict('A surviving file reference points to a missing stored object.');
  }
  if (
    typeof upload.size !== 'number'
    || !Number.isFinite(upload.size)
    || typeof stored.size !== 'number'
    || !Number.isFinite(stored.size)
    || stored.size !== upload.size
  ) {
    throw fileOperationConflict('A surviving file reference failed stored-size verification.');
  }
  if (!upload.etag || !stored.etag || stored.etag !== upload.etag) {
    throw fileOperationConflict('A surviving file reference failed stored-etag verification.');
  }
  if (!upload.contentType || !stored.contentType) {
    throw fileOperationConflict('A surviving file reference has no verified stored content type.');
  }
  const name = upload.name || upload.key.split('/').at(-1) || 'file';
  if (
    assertSafeStoredFileType(name, stored.contentType)
      !== assertSafeStoredFileType(name, upload.contentType)
  ) {
    throw fileOperationConflict('A surviving file reference failed stored-type verification.');
  }
}

/**
 * Permanent content deletion is fail-closed around object storage. Every
 * object is deleted (404 is idempotent success), then its organization quota
 * reservation is settled, before callers may delete the file/page/workspace
 * metadata that makes a retry possible.
 */
export async function deleteStoredUploadsBeforeMetadata(input: {
  admin: AdminDbAccessor;
  workspace: PermanentDeleteWorkspace;
  uploads: PermanentDeleteUpload[];
  storage?: FunctionStorageProxy;
  request?: Request;
  leaseGuard?: FileWorkspaceLeaseGuard;
  excludePageIds?: string[];
  excludeWorkspaceMetadata?: boolean;
}) {
  const now = Date.now();
  const activeGrant = input.uploads.find((upload) => {
    const expiry = typeof upload.expiresAt === 'string' ? Date.parse(upload.expiresAt) : Number.NaN;
    const verifiedCompletion = typeof upload.completedAt === 'string'
      && Number.isFinite(Date.parse(upload.completedAt));
    const legacyCompletedStatus = upload.status === 'uploaded'
      || (upload.status === 'deleting' && upload.deletionPreviousStatus === 'uploaded');
    if (
      legacyCompletedStatus
      && !verifiedCompletion
      && (!Number.isFinite(expiry) || expiry > now)
    ) {
      // Legacy uploaded/deleting rows did not always persist a verified
      // completion stamp. A future or unknown credential deadline may still
      // permit PUT replay, so byte deletion must wait for maintenance to
      // settle the grant-bearing row first.
      return true;
    }
    const grantBearingStatus = upload.status === 'pending'
      || upload.status === 'preparing'
      || (
        upload.status === 'deleting'
        && upload.deletionPreviousStatus !== 'uploaded'
      );
    if (!grantBearingStatus) return false;
    if (Number.isFinite(expiry)) return expiry > now;
    return true;
  });
  if (activeGrant) {
    throw fileOperationConflict(
      'Permanent deletion is waiting for an active file upload grant or operation to expire.',
    );
  }

  const contentDb = workspaceDb(input.admin, input.workspace.id);
  const referenceSnapshot = await workspaceFileReferenceSnapshot(
    contentDb,
    input.workspace.id,
    input.admin.db('app'),
    {
      excludePageIds: input.excludePageIds,
      excludeWorkspaceMetadata: input.excludeWorkspaceMetadata,
    },
  );
  const preservedUploadIds = new Set<string>();
  for (const upload of input.uploads) {
    const owners = fileUploadReferenceOwners(upload as never, referenceSnapshot);
    if (owners.length === 0) continue;
    await assertPreservableStoredUpload(input.storage, upload);
    const owner = owners.find((candidate) => candidate.kind === 'block')
      ?? owners.find((candidate) => candidate.kind === 'page')
      ?? owners.find((candidate) => candidate.kind === 'template')
      ?? owners[0]!;
    await input.leaseGuard?.renew();
    // Re-home legacy shared-key metadata before the original page/block is
    // deleted. Use the raw workspace DB because the old owner is deliberately
    // fenced; the workspace file lease is the serialization boundary here.
    await contentDb.table<PermanentDeleteUpload>('file_uploads').update(upload.id, {
      status: 'uploaded',
      expiresAt: null,
      pageId: owner.pageId ?? null,
      blockId: owner.blockId ?? null,
      databaseId: owner.databaseId ?? null,
      propertyId: null,
      templateId: owner.templateId ?? null,
      deletedAt: null,
      deletedBy: null,
      deletionPreviousStatus: null,
    });
    preservedUploadIds.add(upload.id);
  }

  // Re-delete even rows already marked `deleted`: older best-effort paths may
  // have stamped that status after an object delete failed. Storage 404 is an
  // idempotent success, so verifying every known key safely repairs that state.
  const uploadsToDelete = input.uploads.filter((upload) => !preservedUploadIds.has(upload.id));
  const uploadsWithKeys = uploadsToDelete.filter(
    (upload): upload is PermanentDeleteUpload & { key: string } =>
      typeof upload.key === 'string' && upload.key.length > 0,
  );
  for (let i = 0; i < uploadsWithKeys.length; i += DELETE_CONCURRENCY) {
    await input.leaseGuard?.renew();
    const chunk = uploadsWithKeys.slice(i, i + DELETE_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((upload) => deleteStoredFile(input.storage, upload.bucket || FILE_BUCKET, upload.key)),
    );
    const failedIndex = results.findIndex((result) => result.status === 'rejected');
    if (failedIndex !== -1) {
      const failure = results[failedIndex] as PromiseRejectedResult;
      const upload = chunk[failedIndex];
      const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      throw new Error(`Stored file delete failed for upload ${upload.id}: ${reason}`);
    }
  }

  if (input.workspace.organizationId) {
    for (const upload of uploadsToDelete) {
      await input.leaseGuard?.renew();
      await releaseOrganizationStorage(input.admin, {
        id: upload.id,
        organizationId: input.workspace.organizationId,
        workspaceId: input.workspace.id,
        bytes:
          typeof upload.size === 'number' && Number.isFinite(upload.size) ? Math.max(0, Math.floor(upload.size)) : 0,
      });
    }
  }
  return { preservedUploadIds: Array.from(preservedUploadIds) };
}
