import { defineFunction } from '@edge-base/shared';
import { contentDbsForAllWorkspaces } from '../lib/workspace-db';

import { nowIso, type TableQuery, type TransactDb } from '../lib/table-utils';
const FILE_BUCKET = 'files';
const SYSTEM_ACTOR_ID = 'system:file-maintenance';
const DEFAULT_CLEANUP_LIMIT = 200;

type FileUploadStatus = 'pending' | 'uploaded' | 'deleted' | 'expired';

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket?: string;
  key: string;
  name: string;
  status: FileUploadStatus;
  expiresAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
}

interface FileMaintenanceRun {
  workspaceId: string;
  kind: string;
  actorId: string;
  status: 'success' | 'partial_failure' | 'failed';
  scheduledAt?: string;
  startedAt: string;
  finishedAt: string;
  scanned: number;
  expired: number;
  deletedObjects: number;
  failedObjects: number;
  failures?: Array<{ id: string; key: string; message: string }>;
  details?: {
    uploadIds?: string[];
  };
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  delete(key: string): Promise<void>;
}

interface FunctionContext {
  admin: {
    db(namespace: string): DbRef;
  };
  storage?: FunctionStorageProxy;
  data?: unknown;
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

function isExpired(upload: FileUpload, at: number) {
  return !!upload.expiresAt && new Date(upload.expiresAt).getTime() <= at;
}

function scheduledAtFromData(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const value = record.scheduledAt ?? record.scheduledTime ?? record.cronTime;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

async function listAll<T>(query: TableQuery<T>, maxItems: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200 && out.length < maxItems; page += 1) {
    const res = await query.page(page).limit(Math.min(1000, maxItems)).getList();
    const items = res.items ?? [];
    out.push(...items);
    if (!res.hasMore || items.length === 0) break;
  }
  return out.slice(0, maxItems);
}

async function deleteStoredFile(storage: FunctionStorageProxy | undefined, upload: FileUpload) {
  const proxy = storageBucket(storage, upload.bucket || FILE_BUCKET);
  if (!proxy) return false;
  await proxy.delete(upload.key);
  return true;
}

function workspaceStats(map: Map<string, WorkspaceMaintenanceStats>, workspaceId: string) {
  let stats = map.get(workspaceId);
  if (!stats) {
    stats = {
      scanned: 0,
      expired: 0,
      deletedObjects: 0,
      failures: [],
      uploadIds: [],
    };
    map.set(workspaceId, stats);
  }
  return stats;
}

interface WorkspaceMaintenanceStats {
  scanned: number;
  expired: number;
  deletedObjects: number;
  failures: Array<{ id: string; key: string; message: string }>;
  uploadIds: string[];
}

async function recordMaintenanceRuns(
  db: DbRef,
  statsByWorkspace: Map<string, WorkspaceMaintenanceStats>,
  startedAt: string,
  finishedAt: string,
  scheduledAt?: string,
) {
  const runs = db.table<FileMaintenanceRun>('file_maintenance_runs');
  const recorded: FileMaintenanceRun[] = [];

  for (const [workspaceId, stats] of statsByWorkspace) {
    if (stats.expired === 0 && stats.failures.length === 0) continue;
    try {
      recorded.push(
        await runs.insert({
          workspaceId,
          kind: 'expired-upload-cleanup',
          actorId: SYSTEM_ACTOR_ID,
          status: stats.failures.length ? 'partial_failure' : 'success',
          scheduledAt,
          startedAt,
          finishedAt,
          scanned: stats.scanned,
          expired: stats.expired,
          deletedObjects: stats.deletedObjects,
          failedObjects: stats.failures.length,
          failures: stats.failures.length ? stats.failures : undefined,
          details: { uploadIds: stats.uploadIds },
        }),
      );
    } catch (err) {
      console.warn(
        `[file-maintenance] failed to record maintenance run for workspace ${workspaceId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  return recorded;
}

export default defineFunction({
  trigger: { type: 'schedule', cron: '*/30 * * * *' },
  handler: async (context) => {
    const { admin, data, storage } = context as FunctionContext;
    const startedAt = nowIso();
    const scheduledAt = scheduledAtFromData(data);
    const db = admin.db('app');
    const now = Date.now();
    // Post-split file_uploads lives per workspace; sweep every content block.
    const contentDbs = await contentDbsForAllWorkspaces(admin);
    const uploadsTables = new Map(
      contentDbs.map(({ workspaceId, db: contentDb }) => [
        workspaceId ?? '',
        contentDb.table<FileUpload>('file_uploads'),
      ]),
    );
    const pending: FileUpload[] = [];
    for (const { db: contentDb } of contentDbs) {
      pending.push(
        ...(await listAll(
          contentDb.table<FileUpload>('file_uploads').where('status', '==', 'pending'),
          DEFAULT_CLEANUP_LIMIT * 4,
        )),
      );
    }
    const uploadsTableFor = (upload: FileUpload) =>
      uploadsTables.get(upload.workspaceId ?? '') ?? uploadsTables.values().next().value;
    const expired = pending
      .filter((upload) => isExpired(upload, now))
      .sort((a, b) => String(a.expiresAt ?? '').localeCompare(String(b.expiresAt ?? '')))
      .slice(0, DEFAULT_CLEANUP_LIMIT);

    let deletedObjects = 0;
    const failures: Array<{ id: string; key: string; message: string }> = [];
    const updated: FileUpload[] = [];
    const statsByWorkspace = new Map<string, WorkspaceMaintenanceStats>();

    for (const upload of pending) {
      workspaceStats(statsByWorkspace, upload.workspaceId).scanned += 1;
    }

    for (const upload of expired) {
      const stats = workspaceStats(statsByWorkspace, upload.workspaceId);
      try {
        const deleted = await deleteStoredFile(storage, upload);
        if (deleted) {
          deletedObjects += 1;
          stats.deletedObjects += 1;
        }
      } catch (err) {
        const failure = {
          id: upload.id,
          key: upload.key,
          message: err instanceof Error ? err.message : 'Stored file delete failed.',
        };
        failures.push(failure);
        stats.failures.push(failure);
        // The stored object still exists; the row must stay 'pending' so the
        // next sweep (which only scans pending rows) retries the delete —
        // stamping it 'expired' here would leak the object forever.
        continue;
      }

      const expiredUpload = await uploadsTableFor(upload)!.update(upload.id, {
        status: 'expired',
        expiredAt: nowIso(),
        deletedAt: nowIso(),
        deletedBy: SYSTEM_ACTOR_ID,
      });
      stats.expired += 1;
      stats.uploadIds.push(upload.id);
      updated.push(expiredUpload);
    }

    const finishedAt = nowIso();
    const maintenanceRuns = await recordMaintenanceRuns(
      db,
      statsByWorkspace,
      startedAt,
      finishedAt,
      scheduledAt,
    );

    const result = {
      ok: true,
      action: 'cleanupExpiredUploads',
      scheduled: data ?? null,
      scanned: pending.length,
      expired: updated.length,
      deletedObjects,
      failures,
      maintenanceRuns: maintenanceRuns.length,
    };

    if (updated.length || failures.length) {
      console.log(`[file-maintenance] ${JSON.stringify(result)}`);
    }

    return result;
  },
});
