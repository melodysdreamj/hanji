import { getExisting, listAll, nowIso, type TableQuery, type TransactDb } from './table-utils';
import { workspaceDb, type AdminDbAccessor } from './workspace-db';

const QUOTA_CAS_MAX_ATTEMPTS = 12;

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface Workspace {
  id: string;
  organizationId?: string | null;
}

interface Organization {
  id: string;
  storageLimitBytes?: number | null;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  size?: number;
  status?: string;
  expiresAt?: string | null;
}

interface OrganizationStorageUsage {
  id: string;
  organizationId: string;
  reservedBytes: number;
  version: number;
  reconciledAt?: string;
  updatedAt?: string;
}

interface OrganizationStorageReservation {
  id: string;
  organizationId: string;
  workspaceId: string;
  bytes: number;
  status: 'active' | 'released';
  releasedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface StorageQuotaReservation {
  id: string;
  organizationId: string;
  workspaceId: string;
  bytes: number;
}

function positiveBytes(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function uploadReservesStorage(upload: FileUpload, now: number) {
  // `deleting` is only a durable grace/retry state. Bytes and the reservation
  // are still live until object deletion + quota settlement both succeed.
  if (upload.status === 'uploaded' || upload.status === 'deleting') return true;
  if (upload.status !== 'pending') return false;
  if (!upload.expiresAt) return true;
  const expiresAt = new Date(upload.expiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

async function scanOrganizationStorageBytes(admin: AdminDbAccessor, central: DbRef, organizationId: string) {
  const reservations = await listAll(
    central
      .table<OrganizationStorageReservation>('organization_storage_reservations')
      .where('organizationId', '==', organizationId),
  );
  const activeReservations = reservations.filter((reservation) => reservation.status === 'active');
  const reservedUploadIds = new Set(activeReservations.map((reservation) => reservation.id));
  const workspaces = await listAll(
    central.table<Workspace>('workspaces').where('organizationId', '==', organizationId),
  );
  const now = Date.now();
  // The central reservation ledger is authoritative for new uploads. Scan
  // active file rows only to include legacy rows that predate that ledger;
  // de-duplicating by upload id prevents a row and its reservation from being
  // counted twice.
  let bytes = activeReservations.reduce((total, reservation) => total + positiveBytes(reservation.bytes), 0);
  for (const workspace of workspaces) {
    const uploads = await listAll(
      workspaceDb(admin, workspace.id).table<FileUpload>('file_uploads').where('workspaceId', '==', workspace.id),
    );
    for (const upload of uploads) {
      if (uploadReservesStorage(upload, now) && !reservedUploadIds.has(upload.id)) {
        bytes += positiveBytes(upload.size);
      }
    }
  }
  return bytes;
}

function transactionConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null
      ? ((error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status)
      : undefined;
  return code === 409 || /expectation failed|already exists|conflict/i.test(message);
}

/**
 * Atomically reserves organization storage in the central control-plane DO.
 * The per-upload reservation makes retries idempotent and lets release avoid
 * double-decrementing the aggregate counter.
 */
export async function reserveOrganizationStorage(
  admin: AdminDbAccessor,
  workspace: Workspace,
  reservationId: string,
  requestedBytes: number,
): Promise<StorageQuotaReservation | null> {
  if (!workspace.organizationId) return null;
  const bytes = positiveBytes(requestedBytes);
  if (bytes <= 0) throw new Error('Storage reservation bytes must be positive.');

  const central = admin.db('app') as DbRef;
  const organization = await getExisting(central.table<Organization>('organizations'), workspace.organizationId);
  if (!organization) throw new Error('Organization was not found.');
  const limit = positiveBytes(organization.storageLimitBytes);
  const usageTable = central.table<OrganizationStorageUsage>('organization_storage_usage');
  const reservations = central.table<OrganizationStorageReservation>('organization_storage_reservations');

  for (let attempt = 0; attempt < QUOTA_CAS_MAX_ATTEMPTS; attempt += 1) {
    const existingReservation = await getExisting(reservations, reservationId);
    if (existingReservation) {
      if (
        existingReservation.organizationId !== workspace.organizationId ||
        existingReservation.workspaceId !== workspace.id ||
        positiveBytes(existingReservation.bytes) !== bytes
      ) {
        throw new Error('Storage reservation does not match the upload.');
      }
      if (existingReservation.status !== 'active') {
        throw new Error('Storage reservation is no longer active.');
      }
      return {
        id: reservationId,
        organizationId: workspace.organizationId,
        workspaceId: workspace.id,
        bytes,
      };
    }

    const usage = await getExisting(usageTable, workspace.organizationId);
    const currentBytes = usage
      ? positiveBytes(usage.reservedBytes)
      : await scanOrganizationStorageBytes(admin, central, workspace.organizationId);
    if (limit > 0 && currentBytes + bytes > limit) {
      throw new Error('Organization storage limit exceeded.');
    }

    const now = nowIso();
    try {
      if (usage) {
        const version = positiveBytes(usage.version);
        await central.transact([
          {
            table: 'organization_storage_usage',
            op: 'expect',
            id: usage.id,
            where: [['version', '==', version]],
            exists: true,
          },
          {
            table: 'organization_storage_reservations',
            op: 'expect',
            id: reservationId,
            exists: false,
          },
          {
            table: 'organization_storage_usage',
            op: 'update',
            id: usage.id,
            data: {
              reservedBytes: currentBytes + bytes,
              version: version + 1,
              updatedAt: now,
            },
          },
          {
            table: 'organization_storage_reservations',
            op: 'insert',
            data: {
              id: reservationId,
              organizationId: workspace.organizationId,
              workspaceId: workspace.id,
              bytes,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          },
        ]);
      } else {
        await central.transact([
          {
            table: 'organization_storage_usage',
            op: 'expect',
            id: workspace.organizationId,
            exists: false,
          },
          {
            table: 'organization_storage_reservations',
            op: 'expect',
            id: reservationId,
            exists: false,
          },
          {
            table: 'organization_storage_usage',
            op: 'insert',
            data: {
              id: workspace.organizationId,
              organizationId: workspace.organizationId,
              reservedBytes: currentBytes + bytes,
              version: 1,
              reconciledAt: now,
              updatedAt: now,
            },
          },
          {
            table: 'organization_storage_reservations',
            op: 'insert',
            data: {
              id: reservationId,
              organizationId: workspace.organizationId,
              workspaceId: workspace.id,
              bytes,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          },
        ]);
      }
      return {
        id: reservationId,
        organizationId: workspace.organizationId,
        workspaceId: workspace.id,
        bytes,
      };
    } catch (error) {
      if (!transactionConflict(error) || attempt === QUOTA_CAS_MAX_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error('Storage reservation could not be acquired.');
}

/** Atomically settles a reservation. Repeated calls are safe no-ops. */
export async function releaseOrganizationStorage(
  admin: AdminDbAccessor,
  reservation: Pick<StorageQuotaReservation, 'id' | 'organizationId' | 'workspaceId' | 'bytes'> | null,
) {
  if (!reservation) return;
  const central = admin.db('app') as DbRef;
  const usageTable = central.table<OrganizationStorageUsage>('organization_storage_usage');
  const reservations = central.table<OrganizationStorageReservation>('organization_storage_reservations');

  for (let attempt = 0; attempt < QUOTA_CAS_MAX_ATTEMPTS; attempt += 1) {
    const existing = await getExisting(reservations, reservation.id);
    if (existing?.status === 'released') return;
    if (existing && existing.organizationId !== reservation.organizationId) {
      throw new Error('Storage reservation organization does not match.');
    }
    const bytes = positiveBytes(existing?.bytes ?? reservation.bytes);
    const now = nowIso();
    const reservationData = {
      organizationId: reservation.organizationId,
      workspaceId: reservation.workspaceId,
      bytes,
      status: 'released',
      releasedAt: now,
      updatedAt: now,
    };
    const usage = await getExisting(usageTable, reservation.organizationId);
    if (!existing && usage) {
      // A legacy/unreserved row must not blindly decrement the aggregate: it
      // may have been created after the counter was initialized and therefore
      // never counted. Reconcile from the central ledger + legacy shard rows,
      // then exclude this still-active target before retiring its metadata.
      const scannedBytes = await scanOrganizationStorageBytes(admin, central, reservation.organizationId);
      const targetUpload = await getExisting(
        workspaceDb(admin, reservation.workspaceId).table<FileUpload>('file_uploads'),
        reservation.id,
      );
      const targetIncluded = !!targetUpload && uploadReservesStorage(targetUpload, Date.now());
      const version = positiveBytes(usage.version);
      try {
        await central.transact([
          {
            table: 'organization_storage_usage',
            op: 'expect',
            id: usage.id,
            where: [['version', '==', version]],
            exists: true,
          },
          {
            table: 'organization_storage_reservations',
            op: 'expect',
            id: reservation.id,
            exists: false,
          },
          {
            table: 'organization_storage_usage',
            op: 'update',
            id: usage.id,
            data: {
              reservedBytes: Math.max(0, scannedBytes - (targetIncluded ? bytes : 0)),
              version: version + 1,
              reconciledAt: now,
              updatedAt: now,
            },
          },
          {
            table: 'organization_storage_reservations',
            op: 'insert',
            data: { id: reservation.id, ...reservationData },
          },
        ]);
        return;
      } catch (error) {
        if (!transactionConflict(error) || attempt === QUOTA_CAS_MAX_ATTEMPTS - 1) throw error;
        continue;
      }
    }
    if (!usage) {
      // A missing aggregate must not strand an active reservation forever.
      // Rebuild from the authoritative workspace shards and subtract this
      // upload only when it is still part of that scan. Callers often stamp a
      // row expired before releasing, in which case the scan already excludes
      // it and subtracting again would undercount sibling files.
      const scannedBytes = await scanOrganizationStorageBytes(admin, central, reservation.organizationId);
      const targetUpload = await getExisting(
        workspaceDb(admin, reservation.workspaceId).table<FileUpload>('file_uploads'),
        reservation.id,
      );
      const targetIncluded = existing?.status === 'active'
        || (!!targetUpload && uploadReservesStorage(targetUpload, Date.now()));
      try {
        await central.transact([
          {
            table: 'organization_storage_usage',
            op: 'expect',
            id: reservation.organizationId,
            exists: false,
          },
          existing
            ? {
                table: 'organization_storage_reservations',
                op: 'expect',
                id: existing.id,
                where: [['status', '==', 'active']],
                exists: true,
              }
            : {
                table: 'organization_storage_reservations',
                op: 'expect',
                id: reservation.id,
                exists: false,
              },
          {
            table: 'organization_storage_usage',
            op: 'insert',
            data: {
              id: reservation.organizationId,
              organizationId: reservation.organizationId,
              reservedBytes: Math.max(0, scannedBytes - (targetIncluded ? bytes : 0)),
              version: 1,
              reconciledAt: now,
              updatedAt: now,
            },
          },
          existing
            ? {
                table: 'organization_storage_reservations',
                op: 'update',
                id: existing.id,
                data: reservationData,
              }
            : {
                table: 'organization_storage_reservations',
                op: 'insert',
                data: { id: reservation.id, ...reservationData },
              },
        ]);
        return;
      } catch (error) {
        if (!transactionConflict(error) || attempt === QUOTA_CAS_MAX_ATTEMPTS - 1) throw error;
        continue;
      }
    }
    const currentBytes = positiveBytes(usage.reservedBytes);
    const version = positiveBytes(usage.version);
    try {
      await central.transact([
        {
          table: 'organization_storage_usage',
          op: 'expect',
          id: usage.id,
          where: [['version', '==', version]],
          exists: true,
        },
        existing
          ? {
              table: 'organization_storage_reservations',
              op: 'expect',
              id: existing.id,
              where: [['status', '==', 'active']],
              exists: true,
            }
          : {
              table: 'organization_storage_reservations',
              op: 'expect',
              id: reservation.id,
              exists: false,
            },
        {
          table: 'organization_storage_usage',
          op: 'update',
          id: usage.id,
          data: {
            reservedBytes: Math.max(0, currentBytes - bytes),
            version: version + 1,
            updatedAt: now,
          },
        },
        existing
          ? {
              table: 'organization_storage_reservations',
              op: 'update',
              id: existing.id,
              data: reservationData,
            }
          : {
              table: 'organization_storage_reservations',
              op: 'insert',
              data: { id: reservation.id, ...reservationData },
            },
      ]);
      return;
    } catch (error) {
      if (!transactionConflict(error) || attempt === QUOTA_CAS_MAX_ATTEMPTS - 1) throw error;
    }
  }
}
