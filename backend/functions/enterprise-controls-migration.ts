import { defineFunction } from '@edge-base/shared';
import {
  backfillAuditRetentionScalars,
  readBoundedRetentionScalarRows,
  type DbRef as EnterpriseControlsDbRef,
  type RetentionScalarRowReader,
} from '../lib/enterprise-controls';
import {
  getExisting,
  type TransactOperation,
  type TransactResult,
} from '../lib/table-utils';

interface DbRef extends EnterpriseControlsDbRef {
  transact(operations: TransactOperation[]): Promise<TransactResult>;
}

interface MigrationState {
  id: string;
  kind: string;
  version: number;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  updatedAt: string;
  lastCompletedAt?: string | null;
  migrationCursorCreatedAt?: string | null;
  migrationCursorId?: string | null;
  migrationComplete?: boolean | null;
  migrationConflictCount?: number | null;
  migrationPassConflictCount?: number | null;
  migrationLastConflict?: string | null;
  migrationLastConflictAt?: string | null;
  migrationScheduleIdentity?: string | null;
  migrationLimitProfile?: string | null;
}

interface ScheduledFunctionContext {
  admin: {
    db(namespace: string): DbRef;
    sqlProviderAware(
      namespace: string,
      id: string | undefined,
      query: string,
      params?: unknown[],
    ): Promise<unknown[]>;
  };
}

export const RETENTION_SCALAR_MIGRATION_STATE_ID =
  'enterprise-audit-retention-scalar-backfill';
export const RETENTION_SCALAR_MIGRATION_CRON = '*/2 * * * *';
export const RETENTION_SCALAR_MIGRATION_LIMITS = Object.freeze({
  maxRowsPerDelivery: 20,
  maxProjectedBytesPerDelivery: 256 * 1_024,
  maximumTransactionOperations: 40,
  elapsedMs: 45_000,
  readAwaitMs: 5_000,
  settlementReserveMs: 5_000,
  leaseMs: 60_000,
});
export const RETENTION_SCALAR_MIGRATION_LIMIT_PROFILE = [
  `rows=${RETENTION_SCALAR_MIGRATION_LIMITS.maxRowsPerDelivery}`,
  `projectedBytes=${RETENTION_SCALAR_MIGRATION_LIMITS.maxProjectedBytesPerDelivery}`,
  `transactionOperations=${RETENTION_SCALAR_MIGRATION_LIMITS.maximumTransactionOperations}`,
  `elapsedMs=${RETENTION_SCALAR_MIGRATION_LIMITS.elapsedMs}`,
].join(';');

interface MigrationRunOptions {
  readRows: RetentionScalarRowReader;
  clock?: () => number;
  leaseToken?: () => string;
}

class MigrationDeadlineError extends Error {
  constructor(label: string) {
    super(`Retention scalar scheduled migration deadline elapsed during ${label}.`);
    this.name = 'MigrationDeadlineError';
  }
}

function nonNegativeInteger(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function conflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object'
    ? Number((error as { code?: unknown; status?: unknown }).code
      ?? (error as { code?: unknown; status?: unknown }).status)
    : NaN;
  return code === 409 || /expectation failed|already exists|conflict|unique/i.test(message);
}

async function withinMigrationDeadline<T>(
  work: () => Promise<T>,
  deadlineAt: number,
  clock: () => number,
  label: string,
): Promise<T> {
  const remaining = Math.floor(deadlineAt - clock());
  if (remaining <= 0) throw new MigrationDeadlineError(label);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new MigrationDeadlineError(label)), remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function acquireMigrationLease(
  db: DbRef,
  clock: () => number,
  leaseTokenFactory: () => string,
  deadlineAt: number,
) {
  const table = db.table<MigrationState>('enterprise_maintenance_state');
  const existing = await withinMigrationDeadline(
    () => getExisting(table, RETENTION_SCALAR_MIGRATION_STATE_ID),
    Math.min(deadlineAt, clock() + RETENTION_SCALAR_MIGRATION_LIMITS.readAwaitMs),
    clock,
    'lease state read',
  );
  if (existing?.migrationComplete === true) {
    return { acquired: false, reason: 'complete', state: existing } as const;
  }
  const leaseExpiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
  if (Number.isFinite(leaseExpiry) && leaseExpiry > clock()) {
    return { acquired: false, reason: 'leased', state: existing } as const;
  }
  const now = new Date(clock()).toISOString();
  const leaseToken = leaseTokenFactory();
  const leaseExpiresAt = new Date(
    clock() + RETENTION_SCALAR_MIGRATION_LIMITS.leaseMs,
  ).toISOString();
  const version = nonNegativeInteger(existing?.version, 0);
  const data: MigrationState = {
    id: RETENTION_SCALAR_MIGRATION_STATE_ID,
    kind: RETENTION_SCALAR_MIGRATION_STATE_ID,
    version: version + 1,
    leaseToken,
    leaseExpiresAt,
    updatedAt: now,
    lastCompletedAt: existing?.lastCompletedAt ?? null,
    migrationCursorCreatedAt: existing?.migrationCursorCreatedAt ?? null,
    migrationCursorId: existing?.migrationCursorId ?? null,
    migrationComplete: false,
    migrationConflictCount: nonNegativeInteger(existing?.migrationConflictCount, 0),
    migrationPassConflictCount: nonNegativeInteger(existing?.migrationPassConflictCount, 0),
    migrationLastConflict: existing?.migrationLastConflict ?? null,
    migrationLastConflictAt: existing?.migrationLastConflictAt ?? null,
    migrationScheduleIdentity: RETENTION_SCALAR_MIGRATION_STATE_ID,
    migrationLimitProfile: RETENTION_SCALAR_MIGRATION_LIMIT_PROFILE,
  };
  const operations: TransactOperation[] = existing
    ? [
        {
          table: 'enterprise_maintenance_state',
          op: 'expect',
          id: existing.id,
          where: [
            ['kind', '==', existing.kind],
            ['version', '==', version],
            ['leaseToken', '==', existing.leaseToken ?? null],
            ['leaseExpiresAt', '==', existing.leaseExpiresAt ?? null],
            ['migrationComplete', '==', existing.migrationComplete ?? null],
          ],
          exists: true,
        },
        {
          table: 'enterprise_maintenance_state',
          op: 'update',
          id: existing.id,
          data: data as unknown as Record<string, unknown>,
        },
      ]
    : [
        {
          table: 'enterprise_maintenance_state',
          op: 'expect',
          id: RETENTION_SCALAR_MIGRATION_STATE_ID,
          exists: false,
        },
        {
          table: 'enterprise_maintenance_state',
          op: 'insert',
          data: data as unknown as Record<string, unknown>,
        },
      ];
  try {
    await withinMigrationDeadline(
      () => db.transact(operations),
      deadlineAt,
      clock,
      'lease acquisition transaction',
    );
  } catch (error) {
    if (conflict(error)) return { acquired: false, reason: 'conflict', state: existing } as const;
    throw error;
  }
  return { acquired: true, state: data } as const;
}

function conflictSummary(
  conflicts: Array<{ reason: 'duplicate' | 'concurrent' | 'malformed_version' }>,
) {
  const count = (reason: 'duplicate' | 'concurrent' | 'malformed_version') =>
    conflicts.filter((entry) => entry.reason === reason).length;
  return [
    `${count('duplicate')} duplicate organization control conflict(s)`,
    `${count('concurrent')} concurrent row conflict(s)`,
    `${count('malformed_version')} malformed version conflict(s)`,
  ].join('; ');
}

export async function runRetentionScalarMigration(
  db: DbRef,
  options: MigrationRunOptions,
) {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const deadlineAt = startedAt + RETENTION_SCALAR_MIGRATION_LIMITS.elapsedMs;
  const workDeadlineAt = deadlineAt
    - RETENTION_SCALAR_MIGRATION_LIMITS.settlementReserveMs;
  const acquisition = await acquireMigrationLease(
    db,
    clock,
    options.leaseToken ?? crypto.randomUUID,
    workDeadlineAt,
  );
  if (!acquisition.acquired) {
    return {
      acquired: false,
      complete: acquisition.state?.migrationComplete === true,
      reason: acquisition.reason,
    } as const;
  }
  const state = acquisition.state;
  const cursor = state.migrationCursorCreatedAt && state.migrationCursorId
    ? { createdAt: state.migrationCursorCreatedAt, id: state.migrationCursorId }
    : null;
  try {
    const result = await backfillAuditRetentionScalars(db, cursor, {
      maxRows: RETENTION_SCALAR_MIGRATION_LIMITS.maxRowsPerDelivery,
      maxProjectedBytes: RETENTION_SCALAR_MIGRATION_LIMITS.maxProjectedBytesPerDelivery,
      readRows: options.readRows,
      deadlineAt: workDeadlineAt,
      clock,
    });
    const passConflictCount = nonNegativeInteger(state.migrationPassConflictCount, 0)
      + result.conflicts.length;
    const complete = result.scanComplete && passConflictCount === 0;
    // Conflicts never pin the keyset within a pass. At the safe end of a pass,
    // restart from the beginning until one complete pass observes no conflict.
    const nextCursor = result.scanComplete && !complete ? null : result.cursor;
    const nextPassConflictCount = result.scanComplete ? 0 : passConflictCount;
    // A partial rescan cannot prove that the prior completed-pass conflicts
    // are gone. Keep that durable count visible until the whole new pass is
    // conflict-free, while allowing newly observed conflicts to raise it.
    const durableConflictCount = result.scanComplete
      ? passConflictCount
      : Math.max(
          nonNegativeInteger(state.migrationConflictCount, 0),
          passConflictCount,
        );
    const now = new Date(clock()).toISOString();
    const conflictMessage = result.conflicts.length > 0
      ? conflictSummary(result.conflicts)
      : result.scanComplete && passConflictCount === 0
        ? null
        : state.migrationLastConflict ?? null;
    await withinMigrationDeadline(
      () => db.transact([
        {
          table: 'enterprise_maintenance_state',
          op: 'expect',
          id: state.id,
          where: [
            ['kind', '==', state.kind],
            ['version', '==', state.version],
            ['leaseToken', '==', state.leaseToken],
          ],
          exists: true,
        },
        {
          table: 'enterprise_maintenance_state',
          op: 'update',
          id: state.id,
          data: {
            version: state.version + 1,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
            migrationCursorCreatedAt: nextCursor?.createdAt ?? null,
            migrationCursorId: nextCursor?.id ?? null,
            migrationComplete: complete,
            migrationConflictCount: durableConflictCount,
            migrationPassConflictCount: nextPassConflictCount,
            migrationLastConflict: conflictMessage,
            migrationLastConflictAt: result.conflicts.length
              ? now
              : complete
                ? null
                : state.migrationLastConflictAt ?? null,
            migrationScheduleIdentity: RETENTION_SCALAR_MIGRATION_STATE_ID,
            migrationLimitProfile: RETENTION_SCALAR_MIGRATION_LIMIT_PROFILE,
            ...(complete ? { lastCompletedAt: now } : {}),
          },
        },
      ]),
      deadlineAt,
      clock,
      'checkpoint transaction',
    );
    return {
      acquired: true,
      complete,
      scanComplete: result.scanComplete,
      cursor: nextCursor,
      scanned: result.scanned,
      updated: result.updated,
      unchanged: result.unchanged,
      projectedBytes: result.projectedBytes,
      listRequests: result.listRequests,
      transactionRequests: result.transactionRequests + 2,
      conflicts: result.conflicts,
    } as const;
  } catch (error) {
    const now = new Date(clock()).toISOString();
    try {
      await withinMigrationDeadline(
        () => db.transact([
          {
            table: 'enterprise_maintenance_state',
            op: 'expect',
            id: state.id,
            where: [
              ['version', '==', state.version],
              ['leaseToken', '==', state.leaseToken],
            ],
            exists: true,
          },
          {
            table: 'enterprise_maintenance_state',
            op: 'update',
            id: state.id,
            data: {
              version: state.version + 1,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: now,
              migrationLastConflict: error instanceof Error
                ? error.message.slice(0, 500)
                : 'Retention scalar migration failed.',
              migrationLastConflictAt: now,
            },
          },
        ]),
        deadlineAt,
        clock,
        'failure checkpoint transaction',
      );
    } catch {
      // An expired lease or a takeover owns the next durable checkpoint.
    }
    throw error;
  }
}

export default defineFunction({
  trigger: { type: 'schedule', cron: RETENTION_SCALAR_MIGRATION_CRON },
  handler(rawContext: unknown) {
    const context = rawContext as ScheduledFunctionContext;
    return runRetentionScalarMigration(context.admin.db('app'), {
      readRows: (request) => readBoundedRetentionScalarRows(
        (query, params) => context.admin.sqlProviderAware('app', undefined, query, params),
        request,
      ),
    });
  },
});
