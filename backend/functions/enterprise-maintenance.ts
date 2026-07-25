import { defineFunction } from '@edge-base/shared';
import {
  getExisting,
  newId,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';

interface OrderedTableQuery<T> extends TableQuery<T> {
  where(field: string, op: string, value: unknown): OrderedTableQuery<T>;
  orderBy(field: string, direction: 'asc' | 'desc'): OrderedTableQuery<T>;
  page(n: number): OrderedTableQuery<T>;
  limit(n: number): OrderedTableQuery<T>;
  includeTotal(include: boolean): OrderedTableQuery<T>;
  select(...fields: string[]): OrderedTableQuery<T>;
}

interface TableRef<T> extends OrderedTableQuery<T> {
  getOne(id: string): Promise<T>;
}

interface CompactTransactResult {
  committed: true;
  operationCount: number;
}

interface DbRef {
  table<T>(name: string): TableRef<T>;
  transact(
    operations: TransactOperation[],
    options: { resultMode: 'compact' },
  ): Promise<CompactTransactResult>;
}

interface Organization {
  id: string;
  createdAt: string;
  governanceVersion?: number | null;
}

interface OrganizationEnterpriseControls {
  id: string;
  organizationId: string;
  auditRetentionDays?: number | null;
  auditRetentionPolicyValid?: boolean | null;
  version?: number | null;
}

interface OrganizationAuditEvent {
  id: string;
  organizationId: string;
  occurredAt: string;
}

interface OrganizationLegalHold {
  id: string;
  organizationId: string;
  status?: string | null;
}

type RetentionWorkStatus = 'ready' | 'backlog' | 'retry' | 'done' | 'failed';

interface EnterpriseRetentionWork {
  id: string;
  organizationId: string;
  organizationCreatedAt: string;
  sweepId: string;
  status: RetentionWorkStatus;
  version: number;
  nextAttemptAt: string;
  failureCount: number;
  lastFailure?: string | null;
  lastFailureAt?: string | null;
  lastDeliveryId?: string | null;
  completedAt?: string | null;
}

interface EnterpriseMaintenanceState {
  id: string;
  kind: string;
  cursorOrganizationId?: string | null;
  cursorOrganizationCreatedAt?: string | null;
  version: number;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  updatedAt: string;
  lastCompletedAt?: string | null;
  nextDueAt?: string | null;
  sweepId?: string | null;
  sweepStartedAt?: string | null;
  sweepUpperCreatedAt?: string | null;
  discoveryComplete?: boolean | null;
  discoveryFailureCount?: number | null;
  discoveryNextAttemptAt?: string | null;
  discoveryLastFailure?: string | null;
  discoveryLastFailureAt?: string | null;
  selectionFailureCount?: number | null;
  selectionNextAttemptAt?: string | null;
  selectionLastFailure?: string | null;
  selectionLastFailureAt?: string | null;
  pendingWorkCount?: number | null;
  failedWorkCount?: number | null;
  lastFailedWorkCount?: number | null;
  currentDeliveryId?: string | null;
  currentDeliveryScheduledAt?: string | null;
  currentDeliveryAttempted?: number | null;
  currentDeliveryRetryAttempted?: number | null;
  currentDeliveryBacklogAttempted?: number | null;
  currentDeliveryReadyAttempted?: number | null;
  currentDeliverySettled?: boolean | null;
  orphanWorkCursorOrganizationId?: string | null;
}

interface ScheduledFunctionContext {
  admin: { db(namespace: string): DbRef };
  data?: {
    after?: {
      scheduledTime?: string;
      cron?: string;
      scheduleIdentity?: string;
      deliveryId?: string;
    };
  };
}

interface RetentionAuthority {
  organization?: Organization;
  controls?: OrganizationEnterpriseControls;
  activeHold: boolean;
  projectedBytes: number;
  permanentError?: string;
  organizationMissing?: boolean;
}

interface RetentionResult {
  organizationId: string;
  deleted: number;
  cutoff?: string;
  preservedByLegalHold?: boolean;
  status: 'done' | 'backlog' | 'removed' | 'failed';
}

interface RetentionFailure {
  organizationId: string;
  error: string;
  terminal: boolean;
}

interface SliceProgress {
  processedOrganizations: number;
  deleted: number;
  eventRowsRead: number;
  orphanWorkRowsRemoved: number;
  results: RetentionResult[];
  failures: RetentionFailure[];
}

interface ParsedResponseAccounting {
  bytes: number;
  count: number;
}

interface LeaseContext {
  token: string;
  state: EnterpriseMaintenanceState;
  responses: ParsedResponseAccounting;
}

type AcquisitionReason = 'idle' | 'duplicate' | 'superseded';
type QueryFailureLane = 'discovery' | 'selection';
type WorkLane = Extract<RetentionWorkStatus, 'ready' | 'backlog' | 'retry'>;
type DestructiveTransactionOutcome = 'conflict' | 'definitely-aborted' | 'ambiguous';
type Acquisition =
  | { acquired: false; reason: AcquisitionReason; state: EnterpriseMaintenanceState | null }
  | { acquired: true; lease: LeaseContext };

export const ENTERPRISE_AUDIT_RETENTION_STATE_ID = 'organization-audit-retention';
export const ENTERPRISE_AUDIT_RETENTION_CRON = '1-59/2 * * * *';
export const ENTERPRISE_AUDIT_RETENTION_LIMITS = Object.freeze({
  organizationsDiscoveredPerSlice: 128,
  readyWorkItemsPerSlice: 16,
  backlogWorkItemsPerSlice: 2,
  retryWorkItemsPerSlice: 2,
  workItemsPerSlice: 20,
  eventsPerOrganization: 100,
  eventRowsReadPerSlice: 200,
  eventsPerSlice: 200,
  readyEventsPerSlice: 100,
  retryEventsPerSlice: 50,
  backlogEventsPerSlice: 50,
  transactionOperations: 300,
  compactTransactionResponseBytes: 39,
  listRequestsPerSlice: 58,
  transactionRequestsPerSlice: 45,
  databaseRequestsPerSlice: 104,
  providerTransactionAttemptsPerRequest: 3,
  providerTransactionAttemptsPerSlice: 135,
  authorityItemConcurrency: 4,
  authorityBatchSize: 4,
  authorityListConcurrency: 12,
  orphanWorkItemsPerSlice: 32,
  projectedPayloadBytesPerWorkItem: 8 * 1024,
  projectedPayloadBytesPerSlice: 512 * 1024,
  projectedPayloadBytesPerAuthority: 8 * 1024,
  projectedPayloadBytesPerEventPage: 64 * 1024,
  elapsedMs: 5_000,
  settlementReserveMs: 750,
  readAwaitMs: 500,
  leaseMs: 60_000,
  physicalIntervalMs: 2 * 60_000,
  maxTransientFailuresPerSweep: 5,
  logicalDailyHourUtc: 3,
  logicalDailyMinuteUtc: 15,
});

const SCALE_ORGANIZATIONS = 10_000;
const SCALE_EVENTS_PER_HEALTHY_ORGANIZATION = 40;
const SCALE_HEAVY_EVENTS = 50_000;
const PHYSICAL_INTERVAL_MINUTES =
  ENTERPRISE_AUDIT_RETENTION_LIMITS.physicalIntervalMs / 60_000;
const FORTY_EVENT_ORGANIZATIONS_PER_DELIVERY = Math.min(
  ENTERPRISE_AUDIT_RETENTION_LIMITS.readyWorkItemsPerSlice,
  Math.floor(
    ENTERPRISE_AUDIT_RETENTION_LIMITS.eventsPerSlice
      / SCALE_EVENTS_PER_HEALTHY_ORGANIZATION,
  ),
);
const FORTY_EVENT_DELIVERIES = Math.ceil(
  SCALE_ORGANIZATIONS / FORTY_EVENT_ORGANIZATIONS_PER_DELIVERY,
) + 1;
const HEAVY_PAGES = Math.ceil(
  SCALE_HEAVY_EVENTS / ENTERPRISE_AUDIT_RETENTION_LIMITS.eventsPerOrganization,
);
const ONE_HEAVY_READY_DELIVERIES = Math.ceil(
  (SCALE_ORGANIZATIONS - 1) / ENTERPRISE_AUDIT_RETENTION_LIMITS.readyWorkItemsPerSlice,
);
const ONE_HEAVY_DELIVERIES = ONE_HEAVY_READY_DELIVERIES + (HEAVY_PAGES - 1) + 1;
const TWO_HEAVY_MIXED_DELIVERIES = Math.ceil(
  (SCALE_ORGANIZATIONS - 2) / ENTERPRISE_AUDIT_RETENTION_LIMITS.readyWorkItemsPerSlice,
);
const TWO_HEAVY_REMAINING_PAGES = [
  HEAVY_PAGES - 1 - Math.ceil(TWO_HEAVY_MIXED_DELIVERIES / 2),
  HEAVY_PAGES - 1 - Math.floor(TWO_HEAVY_MIXED_DELIVERIES / 2),
];
const TWO_HEAVY_DELIVERIES = 1
  + TWO_HEAVY_MIXED_DELIVERIES
  + Math.max(...TWO_HEAVY_REMAINING_PAGES)
  + 1;

// These are exact no-failure scheduler-capacity bounds, including terminal
// zero-page confirmation. They are deliberately not called real wall-clock
// upper bounds: retry/backoff time and exact-image per-slice runtime/health
// still need to be added by the shared candidate and Synology gates.
export const ENTERPRISE_AUDIT_RETENTION_SERVICE_BOUNDS = Object.freeze({
  tenThousandOrganizationDiscoveryMinutes:
    Math.ceil(
      SCALE_ORGANIZATIONS / ENTERPRISE_AUDIT_RETENTION_LIMITS.organizationsDiscoveredPerSlice,
    ) * PHYSICAL_INTERVAL_MINUTES,
  tenThousandEmptyOrganizationsMinutes:
    Math.ceil(
      SCALE_ORGANIZATIONS / ENTERPRISE_AUDIT_RETENTION_LIMITS.readyWorkItemsPerSlice,
    ) * PHYSICAL_INTERVAL_MINUTES,
  tenThousandOrganizationsWithFortyEventsMinutes:
    FORTY_EVENT_DELIVERIES * PHYSICAL_INTERVAL_MINUTES,
  oneHeavyFiftyThousandEventOrganizationAmongTenThousandMinutes:
    ONE_HEAVY_DELIVERIES * PHYSICAL_INTERVAL_MINUTES,
  twoHeavyFiftyThousandEventOrganizationsAmongTenThousandMinutes:
    TWO_HEAVY_DELIVERIES * PHYSICAL_INTERVAL_MINUTES,
});

const TRANSIENT_BACKOFF_MS = [
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

export interface EnterpriseAuditRetentionOptions {
  clock?: () => number;
  leaseToken?: () => string;
  deliveryId?: string;
}

export function enterpriseRetentionWorkId(organizationId: string): string {
  return `enterprise-retention-${organizationId}`;
}

class SliceDeadlineError extends Error {
  constructor(label: string) {
    super(`Enterprise retention slice deadline elapsed during ${label}.`);
    this.name = 'SliceDeadlineError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? 'null').byteLength;
}

function chargeParsedResponse(accounting: ParsedResponseAccounting, value: unknown): number {
  const bytes = serializedBytes(value);
  accounting.bytes += bytes;
  accounting.count += 1;
  return bytes;
}

function requireCompactTransactionAck(
  value: unknown,
  expectedOperationCount: number,
  label: string,
): CompactTransactResult {
  const keys = isRecord(value) ? Object.keys(value).sort() : [];
  const valid = isRecord(value)
    && keys.length === 2
    && keys[0] === 'committed'
    && keys[1] === 'operationCount'
    && value.committed === true
    && Number.isSafeInteger(value.operationCount)
    && value.operationCount === expectedOperationCount
    && serializedBytes(value)
      <= ENTERPRISE_AUDIT_RETENTION_LIMITS.compactTransactionResponseBytes;
  if (!valid) {
    throw new Error(
      `Enterprise retention ${label} returned an invalid compact transaction acknowledgement `
        + `for ${expectedOperationCount} operations.`,
    );
  }
  return value as unknown as CompactTransactResult;
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function definiteTransactionConflict(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === 409 || error.status === 409) return true;
  return typeof error.message === 'string'
    && /transaction expectation failed|serialization|deadlock/i.test(error.message);
}

function destructiveTransactionOutcome(error: unknown): DestructiveTransactionOutcome {
  if (error instanceof SliceDeadlineError) return 'ambiguous';
  if (!isRecord(error)) return 'ambiguous';
  if (error.slug === 'network-error' || error.slug === 'request-timeout') return 'ambiguous';
  if (error.code === 0 || error.status === 0) return 'ambiguous';
  if (definiteTransactionConflict(error)) return 'conflict';
  const status = typeof error.status === 'number'
    ? error.status
    : typeof error.code === 'number'
      ? error.code
      : undefined;
  return status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599
    ? 'definitely-aborted'
    : 'ambiguous';
}

async function withinDeadline<T>(
  work: () => Promise<T>,
  deadlineAt: number,
  clock: () => number,
  label: string,
): Promise<T> {
  const remaining = Math.floor(deadlineAt - clock());
  if (remaining <= 0) throw new SliceDeadlineError(label);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new SliceDeadlineError(label)), remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function listWithinDeadline<T>(
  query: OrderedTableQuery<T>,
  deadlineAt: number,
  clock: () => number,
  accounting: ParsedResponseAccounting,
  label: string,
): Promise<T[]> {
  const readDeadlineAt = Math.min(
    deadlineAt,
    clock() + ENTERPRISE_AUDIT_RETENTION_LIMITS.readAwaitMs,
  );
  const response = await withinDeadline(() => query.getList(), readDeadlineAt, clock, label);
  chargeParsedResponse(accounting, response);
  return response.items ?? [];
}

function responseAdmissionExhausted(accounting: ParsedResponseAccounting): boolean {
  return accounting.bytes >= ENTERPRISE_AUDIT_RETENTION_LIMITS.projectedPayloadBytesPerSlice;
}

function nextLogicalDailyBoundary(afterMs: number): string {
  const next = new Date(afterMs);
  next.setUTCHours(
    ENTERPRISE_AUDIT_RETENTION_LIMITS.logicalDailyHourUtc,
    ENTERPRISE_AUDIT_RETENTION_LIMITS.logicalDailyMinuteUtc,
    0,
    0,
  );
  if (next.getTime() <= afterMs) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function leaseExpectation(lease: LeaseContext): TransactOperation {
  return {
    table: 'enterprise_maintenance_state',
    op: 'expect',
    id: ENTERPRISE_AUDIT_RETENTION_STATE_ID,
    where: [
      ['version', '==', lease.state.version],
      ['leaseToken', '==', lease.token],
    ],
    exists: true,
  };
}

async function commitLeaseState(
  db: DbRef,
  lease: LeaseContext,
  operations: TransactOperation[],
  patch: Partial<EnterpriseMaintenanceState>,
  updatedAt: Date,
  deadlineAt: number,
  clock: () => number,
  stateUpdateFirst = false,
): Promise<void> {
  const next: EnterpriseMaintenanceState = {
    ...lease.state,
    ...patch,
    id: ENTERPRISE_AUDIT_RETENTION_STATE_ID,
    kind: 'organization-audit-retention',
    version: lease.state.version + 1,
    updatedAt: updatedAt.toISOString(),
  };
  const stateUpdate: TransactOperation = {
    table: 'enterprise_maintenance_state',
    op: 'update',
    id: ENTERPRISE_AUDIT_RETENTION_STATE_ID,
    data: { ...next },
  };
  const transaction = stateUpdateFirst
    ? [leaseExpectation(lease), stateUpdate, ...operations]
    : [leaseExpectation(lease), ...operations, stateUpdate];
  if (transaction.length > ENTERPRISE_AUDIT_RETENTION_LIMITS.transactionOperations) {
    throw new Error(
      `Enterprise retention transaction exceeded ${ENTERPRISE_AUDIT_RETENTION_LIMITS.transactionOperations} operations.`,
    );
  }
  const rawResponse = await withinDeadline(
    () => db.transact(transaction, { resultMode: 'compact' }),
    deadlineAt,
    clock,
    'transaction settlement',
  );
  const response = requireCompactTransactionAck(
    rawResponse,
    transaction.length,
    'transaction settlement',
  );
  chargeParsedResponse(lease.responses, response);
  lease.state = next;
}

function normalizedDeliveryLaneAttempts(
  state: EnterpriseMaintenanceState | null,
): Record<WorkLane, number> {
  const total = finiteNonNegativeInteger(state?.currentDeliveryAttempted);
  const explicit: Record<WorkLane, number> = {
    retry: finiteNonNegativeInteger(state?.currentDeliveryRetryAttempted),
    backlog: finiteNonNegativeInteger(state?.currentDeliveryBacklogAttempted),
    ready: finiteNonNegativeInteger(state?.currentDeliveryReadyAttempted),
  };
  if (explicit.retry + explicit.backlog + explicit.ready === total) return explicit;

  const retry = Math.min(total, ENTERPRISE_AUDIT_RETENTION_LIMITS.retryEventsPerSlice);
  const backlog = Math.min(
    Math.max(0, total - retry),
    ENTERPRISE_AUDIT_RETENTION_LIMITS.backlogEventsPerSlice,
  );
  return { retry, backlog, ready: Math.max(0, total - retry - backlog) };
}

function deliveryLaneRemaining(state: EnterpriseMaintenanceState, lane: WorkLane): number {
  const attempted = normalizedDeliveryLaneAttempts(state);
  if (lane === 'retry') {
    return Math.max(0, ENTERPRISE_AUDIT_RETENTION_LIMITS.retryEventsPerSlice - attempted.retry);
  }
  if (lane === 'backlog') {
    return Math.max(
      0,
      ENTERPRISE_AUDIT_RETENTION_LIMITS.retryEventsPerSlice
        + ENTERPRISE_AUDIT_RETENTION_LIMITS.backlogEventsPerSlice
        - attempted.retry
        - attempted.backlog,
    );
  }
  return Math.max(
    0,
    ENTERPRISE_AUDIT_RETENTION_LIMITS.eventsPerSlice
      - attempted.retry
      - attempted.backlog
      - attempted.ready,
  );
}

async function acquireLease(
  db: DbRef,
  scheduledAt: Date,
  deliveryId: string,
  leaseToken: string,
  deadlineAt: number,
  clock: () => number,
  responses: ParsedResponseAccounting,
): Promise<Acquisition> {
  const table = db.table<EnterpriseMaintenanceState>('enterprise_maintenance_state');
  const existing = await withinDeadline(
    () => getExisting(table, ENTERPRISE_AUDIT_RETENTION_STATE_ID),
    deadlineAt,
    clock,
    'state acquisition read',
  );
  if (existing) chargeParsedResponse(responses, existing);
  const scheduledMs = scheduledAt.getTime();
  const recordedDeliveryMs = asTimestamp(existing?.currentDeliveryScheduledAt);

  if (recordedDeliveryMs !== undefined && recordedDeliveryMs > scheduledMs) {
    return { acquired: false, reason: 'superseded', state: existing };
  }
  if (recordedDeliveryMs === scheduledMs && existing?.currentDeliveryId !== deliveryId) {
    throw Object.assign(
      new Error('Enterprise maintenance delivery identity changed at one boundary.'),
      { status: 409 },
    );
  }
  if (existing?.currentDeliveryId === deliveryId && existing.currentDeliverySettled === true) {
    return { acquired: false, reason: 'duplicate', state: existing };
  }

  const sweepActive = Boolean(existing?.sweepId && existing.sweepStartedAt);
  const nextDueMs = asTimestamp(existing?.nextDueAt);
  if (!sweepActive && nextDueMs !== undefined && nextDueMs > scheduledMs) {
    return { acquired: false, reason: 'idle', state: existing };
  }

  const leaseExpiresAtMs = asTimestamp(existing?.leaseExpiresAt);
  if (
    existing?.leaseToken
    && leaseExpiresAtMs !== undefined
    && leaseExpiresAtMs > scheduledMs
    && existing.currentDeliveryId !== deliveryId
  ) {
    throw Object.assign(
      new Error('Enterprise maintenance lease is active for another delivery.'),
      { status: 409 },
    );
  }

  const startsSweep = !sweepActive;
  const sameDelivery = existing?.currentDeliveryId === deliveryId
    && recordedDeliveryMs === scheduledMs;
  const priorLaneAttempts = normalizedDeliveryLaneAttempts(existing);
  const next: EnterpriseMaintenanceState = {
    ...(existing ?? {}),
    id: ENTERPRISE_AUDIT_RETENTION_STATE_ID,
    kind: 'organization-audit-retention',
    cursorOrganizationId: startsSweep ? null : (existing?.cursorOrganizationId ?? null),
    cursorOrganizationCreatedAt: startsSweep
      ? null
      : (existing?.cursorOrganizationCreatedAt ?? null),
    version: finiteNonNegativeInteger(existing?.version) + 1,
    leaseToken,
    leaseExpiresAt: new Date(
      scheduledMs + ENTERPRISE_AUDIT_RETENTION_LIMITS.leaseMs,
    ).toISOString(),
    updatedAt: scheduledAt.toISOString(),
    nextDueAt: startsSweep ? null : (existing?.nextDueAt ?? null),
    sweepId: startsSweep ? newId() : existing?.sweepId,
    sweepStartedAt: startsSweep ? scheduledAt.toISOString() : existing?.sweepStartedAt,
    sweepUpperCreatedAt: startsSweep
      ? scheduledAt.toISOString()
      : existing?.sweepUpperCreatedAt,
    discoveryComplete: startsSweep ? false : existing?.discoveryComplete === true,
    discoveryFailureCount: startsSweep
      ? 0
      : finiteNonNegativeInteger(existing?.discoveryFailureCount),
    discoveryNextAttemptAt: startsSweep ? null : (existing?.discoveryNextAttemptAt ?? null),
    discoveryLastFailure: startsSweep ? null : (existing?.discoveryLastFailure ?? null),
    discoveryLastFailureAt: startsSweep ? null : (existing?.discoveryLastFailureAt ?? null),
    selectionFailureCount: startsSweep
      ? 0
      : finiteNonNegativeInteger(existing?.selectionFailureCount),
    selectionNextAttemptAt: startsSweep ? null : (existing?.selectionNextAttemptAt ?? null),
    selectionLastFailure: startsSweep ? null : (existing?.selectionLastFailure ?? null),
    selectionLastFailureAt: startsSweep ? null : (existing?.selectionLastFailureAt ?? null),
    pendingWorkCount: startsSweep ? 0 : finiteNonNegativeInteger(existing?.pendingWorkCount),
    failedWorkCount: startsSweep ? 0 : finiteNonNegativeInteger(existing?.failedWorkCount),
    currentDeliveryId: deliveryId,
    currentDeliveryScheduledAt: scheduledAt.toISOString(),
    currentDeliveryAttempted: sameDelivery
      ? finiteNonNegativeInteger(existing?.currentDeliveryAttempted)
      : 0,
    currentDeliveryRetryAttempted: sameDelivery ? priorLaneAttempts.retry : 0,
    currentDeliveryBacklogAttempted: sameDelivery ? priorLaneAttempts.backlog : 0,
    currentDeliveryReadyAttempted: sameDelivery ? priorLaneAttempts.ready : 0,
    currentDeliverySettled: false,
  };
  const operations: TransactOperation[] = existing
    ? [
        {
          table: 'enterprise_maintenance_state',
          op: 'expect',
          id: existing.id,
          where: [['version', '==', finiteNonNegativeInteger(existing.version)]],
          exists: true,
        },
        { table: 'enterprise_maintenance_state', op: 'update', id: existing.id, data: { ...next } },
      ]
    : [
        {
          table: 'enterprise_maintenance_state',
          op: 'expect',
          id: ENTERPRISE_AUDIT_RETENTION_STATE_ID,
          exists: false,
        },
        { table: 'enterprise_maintenance_state', op: 'insert', data: { ...next } },
      ];
  const rawResponse = await withinDeadline(
    () => db.transact(operations, { resultMode: 'compact' }),
    deadlineAt,
    clock,
    'lease acquisition transaction',
  );
  const response = requireCompactTransactionAck(
    rawResponse,
    operations.length,
    'lease acquisition transaction',
  );
  chargeParsedResponse(responses, response);
  return { acquired: true, lease: { token: leaseToken, state: next, responses } };
}

function assertOrganizationRows(rows: Organization[]): Organization[] {
  for (const row of rows) {
    if (!row.id || asTimestamp(row.createdAt) === undefined) {
      throw new Error('Enterprise retention discovered an organization without a stable creation key.');
    }
  }
  return rows;
}

async function queryOrganizations(
  db: DbRef,
  state: EnterpriseMaintenanceState,
  deadlineAt: number,
  clock: () => number,
  responses: ParsedResponseAccounting,
): Promise<Organization[]> {
  const upper = state.sweepUpperCreatedAt;
  if (typeof upper !== 'string' || asTimestamp(upper) === undefined) {
    throw new Error('Enterprise retention sweep creation boundary is missing.');
  }
  const cursorCreatedAt = state.cursorOrganizationCreatedAt ?? null;
  const cursorId = state.cursorOrganizationId ?? '';
  const limit = ENTERPRISE_AUDIT_RETENTION_LIMITS.organizationsDiscoveredPerSlice;
  const rows: Organization[] = [];

  if (cursorCreatedAt) {
    const tied = await listWithinDeadline(
      db
        .table<Organization>('organizations')
        .where('createdAt', '==', cursorCreatedAt)
        .where('id', '>', cursorId)
        .where('createdAt', '<', upper)
        .orderBy('id', 'asc')
        .select('id', 'createdAt')
        .page(1)
        .limit(limit)
        .includeTotal(false),
      deadlineAt,
      clock,
      responses,
      'equal-time organization discovery',
    );
    rows.push(...assertOrganizationRows(tied));
    if (responseAdmissionExhausted(responses)) return rows;
  }

  const remaining = limit - rows.length;
  if (remaining > 0) {
    let query = db
      .table<Organization>('organizations')
      .where('createdAt', '<', upper);
    if (cursorCreatedAt) query = query.where('createdAt', '>', cursorCreatedAt);
    const later = await listWithinDeadline(
      query
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .select('id', 'createdAt')
        .page(1)
        .limit(remaining)
        .includeTotal(false),
      deadlineAt,
      clock,
      responses,
      'organization discovery',
    );
    rows.push(...assertOrganizationRows(later));
  }

  return rows;
}

async function discoverOrganizations(
  db: DbRef,
  lease: LeaseContext,
  scheduledAt: Date,
  readDeadlineAt: number,
  deadlineAt: number,
  clock: () => number,
): Promise<{ discovered: number }> {
  if (lease.state.discoveryComplete === true) return { discovered: 0 };
  const organizations = await queryOrganizations(
    db,
    lease.state,
    readDeadlineAt,
    clock,
    lease.responses,
  );
  if (responseAdmissionExhausted(lease.responses)) {
    throw new Error('Enterprise retention organization discovery payload exceeded its bound.');
  }

  const organizationIds = organizations.map(({ id }) => id);
  const existingWork = organizationIds.length === 0
    ? []
    : await listWithinDeadline(
        db
          .table<EnterpriseRetentionWork>('enterprise_retention_work')
          .where('organizationId', 'in', organizationIds)
          .select('id', 'organizationId', 'sweepId', 'status', 'version')
          .page(1)
          .limit(organizationIds.length)
          .includeTotal(false),
        readDeadlineAt,
        clock,
        lease.responses,
        'existing retention-work aggregation',
      );
  if (responseAdmissionExhausted(lease.responses)) {
    throw new Error('Enterprise retention existing-work payload exceeded its admission bound.');
  }
  const existingByOrganization = new Map(existingWork.map((work) => [work.organizationId, work]));
  const sweepId = lease.state.sweepId;
  if (typeof sweepId !== 'string' || sweepId.length === 0) {
    throw new Error('Enterprise retention sweep identity is missing.');
  }

  const operations: TransactOperation[] = [];
  for (const organization of organizations) {
    const existing = existingByOrganization.get(organization.id);
    if (existing?.sweepId === sweepId) {
      throw new Error('Enterprise retention discovery attempted to enqueue one organization twice.');
    }
    const id = existing?.id ?? enterpriseRetentionWorkId(organization.id);
    const version = finiteNonNegativeInteger(existing?.version);
    const data: Record<string, unknown> = {
      id,
      organizationId: organization.id,
      organizationCreatedAt: organization.createdAt,
      sweepId,
      status: 'ready',
      version: version + 1,
      nextAttemptAt: scheduledAt.toISOString(),
      failureCount: 0,
      lastFailure: null,
      lastFailureAt: null,
      lastDeliveryId: lease.state.currentDeliveryId ?? null,
      completedAt: null,
    };
    if (existing) {
      operations.push({
        table: 'enterprise_retention_work',
        op: 'expect',
        id: existing.id,
        where: [
          ['organizationId', '==', organization.id],
          ['version', '==', version],
        ],
        exists: true,
      });
      operations.push({
        table: 'enterprise_retention_work',
        op: 'update',
        id: existing.id,
        data,
      });
    } else {
      operations.push({
        table: 'enterprise_retention_work',
        op: 'expect',
        id,
        exists: false,
      });
      operations.push({ table: 'enterprise_retention_work', op: 'insert', data });
    }
  }

  const last = organizations.at(-1);
  await commitLeaseState(db, lease, operations, {
    cursorOrganizationId: last?.id ?? lease.state.cursorOrganizationId ?? null,
    cursorOrganizationCreatedAt:
      last?.createdAt ?? lease.state.cursorOrganizationCreatedAt ?? null,
    discoveryComplete:
      organizations.length < ENTERPRISE_AUDIT_RETENTION_LIMITS.organizationsDiscoveredPerSlice,
    discoveryFailureCount: 0,
    discoveryNextAttemptAt: null,
    discoveryLastFailure: null,
    discoveryLastFailureAt: null,
    pendingWorkCount:
      finiteNonNegativeInteger(lease.state.pendingWorkCount) + organizations.length,
  }, scheduledAt, deadlineAt, clock);

  return { discovered: organizations.length };
}

async function queryWorkLane(
  db: DbRef,
  state: EnterpriseMaintenanceState,
  status: RetentionWorkStatus,
  limit: number,
  scheduledAt: Date,
  deadlineAt: number,
  clock: () => number,
  responses: ParsedResponseAccounting,
): Promise<EnterpriseRetentionWork[]> {
  if (!state.sweepId) return [];
  return listWithinDeadline(
    db
      .table<EnterpriseRetentionWork>('enterprise_retention_work')
      .where('sweepId', '==', state.sweepId)
      .where('status', '==', status)
      .where('nextAttemptAt', '<=', scheduledAt.toISOString())
      .orderBy('nextAttemptAt', 'asc')
      .orderBy('organizationId', 'asc')
      .select(
        'id',
        'organizationId',
        'organizationCreatedAt',
        'sweepId',
        'status',
        'version',
        'nextAttemptAt',
        'failureCount',
      )
      .page(1)
      .limit(limit)
      .includeTotal(false),
    deadlineAt,
    clock,
    responses,
    `${status} retention-work selection`,
  );
}

async function queryWorkCandidates(
  db: DbRef,
  state: EnterpriseMaintenanceState,
  scheduledAt: Date,
  deadlineAt: number,
  clock: () => number,
  responses: ParsedResponseAccounting,
): Promise<EnterpriseRetentionWork[]> {
  const [retry, backlog, ready] = await Promise.all([
    queryWorkLane(
      db,
      state,
      'retry',
      ENTERPRISE_AUDIT_RETENTION_LIMITS.retryWorkItemsPerSlice,
      scheduledAt,
      deadlineAt,
      clock,
      responses,
    ),
    queryWorkLane(
      db,
      state,
      'backlog',
      ENTERPRISE_AUDIT_RETENTION_LIMITS.backlogWorkItemsPerSlice,
      scheduledAt,
      deadlineAt,
      clock,
      responses,
    ),
    queryWorkLane(
      db,
      state,
      'ready',
      ENTERPRISE_AUDIT_RETENTION_LIMITS.readyWorkItemsPerSlice,
      scheduledAt,
      deadlineAt,
      clock,
      responses,
    ),
  ]);
  const candidates: EnterpriseRetentionWork[] = [];
  const seen = new Set<string>();
  for (const work of [...retry, ...backlog, ...ready]) {
    if (seen.has(work.id)) continue;
    seen.add(work.id);
    candidates.push(work);
  }
  if (candidates.length > ENTERPRISE_AUDIT_RETENTION_LIMITS.workItemsPerSlice) {
    throw new Error('Enterprise retention selected more work items than its declared bound.');
  }
  return candidates;
}

function queryLaneDue(
  state: EnterpriseMaintenanceState,
  lane: QueryFailureLane,
  scheduledAt: Date,
): boolean {
  const value = lane === 'discovery'
    ? state.discoveryNextAttemptAt
    : state.selectionNextAttemptAt;
  const nextAttemptMs = asTimestamp(value);
  return nextAttemptMs === undefined || nextAttemptMs <= scheduledAt.getTime();
}

async function markQueryLaneFailure(
  db: DbRef,
  lease: LeaseContext,
  lane: QueryFailureLane,
  error: unknown,
  scheduledAt: Date,
  deadlineAt: number,
  clock: () => number,
): Promise<void> {
  const previous = lane === 'discovery'
    ? lease.state.discoveryFailureCount
    : lease.state.selectionFailureCount;
  const failureCount = finiteNonNegativeInteger(previous) + 1;
  const delay = TRANSIENT_BACKOFF_MS[
    Math.min(failureCount - 1, TRANSIENT_BACKOFF_MS.length - 1)
  ] ?? ENTERPRISE_AUDIT_RETENTION_LIMITS.physicalIntervalMs;
  const message = describeError(error);
  const patch: Partial<EnterpriseMaintenanceState> = lane === 'discovery'
    ? {
        discoveryFailureCount: failureCount,
        discoveryNextAttemptAt: new Date(scheduledAt.getTime() + delay).toISOString(),
        discoveryLastFailure: message,
        discoveryLastFailureAt: scheduledAt.toISOString(),
      }
    : {
        selectionFailureCount: failureCount,
        selectionNextAttemptAt: new Date(scheduledAt.getTime() + delay).toISOString(),
        selectionLastFailure: message,
        selectionLastFailureAt: scheduledAt.toISOString(),
      };
  await commitLeaseState(db, lease, [], patch, scheduledAt, deadlineAt, clock);
}

type CapturedRead<T> = { items: T[]; error?: never } | { items?: never; error: Error };

async function captureRead<T>(read: () => Promise<T[]>): Promise<CapturedRead<T>> {
  try {
    return { items: await read() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function queryRetentionAuthorityRound(
  db: DbRef,
  workItems: EnterpriseRetentionWork[],
  deadlineAt: number,
  clock: () => number,
  responses: ParsedResponseAccounting,
): Promise<Array<RetentionAuthority | Error>> {
  const organizationIds = workItems.map(({ organizationId }) => organizationId);
  const [organizationsRead, controlsRead, holdReads] = await Promise.all([
    captureRead(() => listWithinDeadline(
      db
        .table<Organization>('organizations')
        .where('id', 'in', organizationIds)
        .select('id', 'createdAt', 'governanceVersion')
        .page(1)
        .limit(organizationIds.length)
        .includeTotal(false),
      deadlineAt,
      clock,
      responses,
      'organization governance authority batch',
    )),
    captureRead(() => listWithinDeadline(
      db
        .table<OrganizationEnterpriseControls>('organization_enterprise_controls')
        .where('organizationId', 'in', organizationIds)
        .select(
          'id',
          'organizationId',
          'auditRetentionDays',
          'auditRetentionPolicyValid',
          'version',
        )
        .page(1)
        .limit(organizationIds.length * 2)
        .includeTotal(false),
      deadlineAt,
      clock,
      responses,
      'enterprise-controls retention authority batch',
    )),
    Promise.all(workItems.map((work) => captureRead(() => listWithinDeadline(
      db
        .table<OrganizationLegalHold>('organization_legal_holds')
        .where('organizationId', '==', work.organizationId)
        .where('status', '==', 'active')
        .select('id', 'organizationId', 'status')
        .page(1)
        .limit(1)
        .includeTotal(false),
      deadlineAt,
      clock,
      responses,
      `active legal-hold authority for ${work.organizationId}`,
    )))),
  ]);

  if (organizationsRead.error) return workItems.map(() => organizationsRead.error);
  if (controlsRead.error) return workItems.map(() => controlsRead.error);
  const organizationById = new Map(
    organizationsRead.items.map((organization) => [organization.id, organization]),
  );
  const controlsByOrganization = new Map<string, OrganizationEnterpriseControls[]>();
  for (const controls of controlsRead.items) {
    const rows = controlsByOrganization.get(controls.organizationId) ?? [];
    rows.push(controls);
    controlsByOrganization.set(controls.organizationId, rows);
  }

  return workItems.map((work, index) => {
    const holdsRead = holdReads[index];
    if (!holdsRead) return new Error('Enterprise retention hold authority result is missing.');
    if (holdsRead.error) return holdsRead.error;
    const organization = organizationById.get(work.organizationId);
    const controlsRows = controlsByOrganization.get(work.organizationId) ?? [];
    const projectedBytes = serializedBytes(organization ? [organization] : [])
      + serializedBytes(controlsRows)
      + serializedBytes(holdsRead.items);
    if (projectedBytes > ENTERPRISE_AUDIT_RETENTION_LIMITS.projectedPayloadBytesPerAuthority) {
      return {
        activeHold: true,
        projectedBytes,
        permanentError: 'Projected retention authority payload exceeded its per-tenant bound.',
      };
    }
    if (!organization) {
      return { activeHold: false, projectedBytes, organizationMissing: true };
    }
    if (controlsRows.length > 1) {
      return {
        organization,
        activeHold: true,
        projectedBytes,
        permanentError: 'Multiple enterprise-controls rows exist for one organization.',
      };
    }
    return {
      organization,
      controls: controlsRows[0],
      activeHold: holdsRead.items.length > 0,
      projectedBytes,
    };
  });
}

function resolveRetentionDays(
  controls: OrganizationEnterpriseControls | undefined,
): { ok: true; days: number } | { ok: false; error: string } {
  if (!controls) return { ok: true, days: 365 };
  if (controls.auditRetentionPolicyValid !== true) {
    return {
      ok: false,
      error: 'Enterprise audit retention policy is invalid or has not been normalized.',
    };
  }
  const days = controls.auditRetentionDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 30 || days > 3650) {
    return {
      ok: false,
      error: 'Enterprise audit retentionDays must be an integer from 30 to 3650.',
    };
  }
  return { ok: true, days };
}

function controlsVersion(value: unknown): number {
  return finiteNonNegativeInteger(value);
}

function retentionAuthorityExpectations(
  organization: Organization,
  controls: OrganizationEnterpriseControls | undefined,
): TransactOperation[] {
  const governanceVersion = finiteNonNegativeInteger(organization.governanceVersion);
  const governanceFence = {
    table: 'organizations',
    id: organization.id,
    field: 'governanceVersion',
  };
  const controlsExpectation: TransactOperation = controls
    ? {
        table: 'organization_enterprise_controls',
        op: 'expect',
        id: controls.id,
        where: [
          ['organizationId', '==', organization.id],
          ['version', '==', controlsVersion(controls.version)],
        ],
        exists: true,
      }
    : {
        table: 'organization_enterprise_controls',
        op: 'expect',
        where: [['organizationId', '==', organization.id]],
        exists: false,
        fencedBy: governanceFence,
      };
  return [
    {
      table: 'organizations',
      op: 'expect',
      id: organization.id,
      where: [['governanceVersion', '==', governanceVersion]],
      exists: true,
    },
    {
      table: 'organizations',
      op: 'update',
      id: organization.id,
      data: { governanceVersion: governanceVersion + 1 },
    },
    controlsExpectation,
    {
      table: 'organization_legal_holds',
      op: 'expect',
      where: [
        ['organizationId', '==', organization.id],
        ['status', '==', 'active'],
      ],
      exists: false,
      fencedBy: governanceFence,
    },
  ];
}

function workExpectation(work: EnterpriseRetentionWork): TransactOperation {
  return {
    table: 'enterprise_retention_work',
    op: 'expect',
    id: work.id,
    where: [
      ['sweepId', '==', work.sweepId],
      ['status', '==', work.status],
      ['version', '==', finiteNonNegativeInteger(work.version)],
    ],
    exists: true,
  };
}

function workUpdate(
  work: EnterpriseRetentionWork,
  patch: Record<string, unknown>,
  deliveryId: string | null,
): TransactOperation {
  return {
    table: 'enterprise_retention_work',
    op: 'update',
    id: work.id,
    data: {
      ...patch,
      version: finiteNonNegativeInteger(work.version) + 1,
      lastDeliveryId: deliveryId,
    },
  };
}

function pendingWorkStatus(status: RetentionWorkStatus): boolean {
  return status === 'ready' || status === 'backlog' || status === 'retry';
}

function workBelongsToCurrentPendingSweep(
  state: EnterpriseMaintenanceState,
  work: EnterpriseRetentionWork,
): boolean {
  return Boolean(state.sweepId)
    && work.sweepId === state.sweepId
    && pendingWorkStatus(work.status);
}

function missingOrganizationExpectation(work: EnterpriseRetentionWork): TransactOperation {
  return {
    table: 'organizations',
    op: 'expect',
    id: work.organizationId,
    exists: false,
    fencedBy: {
      table: 'enterprise_maintenance_state',
      id: ENTERPRISE_AUDIT_RETENTION_STATE_ID,
      field: 'version',
    },
  };
}

async function removeMissingOrganizationWork(
  db: DbRef,
  lease: LeaseContext,
  workItems: EnterpriseRetentionWork[],
  patch: Partial<EnterpriseMaintenanceState>,
  scheduledAt: Date,
  deadlineAt: number,
  clock: () => number,
): Promise<number> {
  if (workItems.length === 0 && Object.keys(patch).length === 0) return 0;
  const pendingRemoved = workItems.filter((work) => (
    workBelongsToCurrentPendingSweep(lease.state, work)
  )).length;
  const failedRemoved = workItems.filter((work) => (
    work.sweepId === lease.state.sweepId && work.status === 'failed'
  )).length;
  const operations = workItems.flatMap((work): TransactOperation[] => [
    missingOrganizationExpectation(work),
    workExpectation(work),
    { table: 'enterprise_retention_work', op: 'delete', id: work.id },
  ]);
  await commitLeaseState(db, lease, operations, {
    ...patch,
    pendingWorkCount: Math.max(
      0,
      finiteNonNegativeInteger(lease.state.pendingWorkCount) - pendingRemoved,
    ),
    failedWorkCount: Math.max(
      0,
      finiteNonNegativeInteger(lease.state.failedWorkCount) - failedRemoved,
    ),
  }, scheduledAt, deadlineAt, clock, true);
  return workItems.length;
}

async function pruneOrphanRetentionWork(
  db: DbRef,
  lease: LeaseContext,
  scheduledAt: Date,
  readDeadlineAt: number,
  deadlineAt: number,
  clock: () => number,
): Promise<{ checked: number; removed: number }> {
  const limit = ENTERPRISE_AUDIT_RETENTION_LIMITS.orphanWorkItemsPerSlice;
  const cursor = lease.state.orphanWorkCursorOrganizationId ?? null;
  const query = db
    .table<EnterpriseRetentionWork>('enterprise_retention_work')
    .where('organizationId', '>', cursor ?? '');
  const workItems = await listWithinDeadline(
    query
      .orderBy('organizationId', 'asc')
      .select('id', 'organizationId', 'sweepId', 'status', 'version')
      .page(1)
      .limit(limit)
      .includeTotal(false),
    readDeadlineAt,
    clock,
    lease.responses,
    'orphan retention-work keyset',
  );
  if (responseAdmissionExhausted(lease.responses)) {
    throw new Error('Enterprise retention orphan-work payload exceeded its admission bound.');
  }

  const eligibleWorkItems = workItems.filter((work) => !(
    work.sweepId === lease.state.sweepId
    && serializedBytes(work)
      > ENTERPRISE_AUDIT_RETENTION_LIMITS.projectedPayloadBytesPerWorkItem
  ));
  const organizationIds = eligibleWorkItems.map(({ organizationId }) => organizationId);
  const organizations = organizationIds.length === 0
    ? []
    : await listWithinDeadline(
        db
          .table<Organization>('organizations')
          .where('id', 'in', organizationIds)
          .select('id')
          .page(1)
          .limit(organizationIds.length)
          .includeTotal(false),
        readDeadlineAt,
        clock,
        lease.responses,
        'orphan retention-work organization authority',
      );
  if (responseAdmissionExhausted(lease.responses)) {
    throw new Error('Enterprise retention orphan authority payload exceeded its admission bound.');
  }
  const requestedIds = new Set(organizationIds);
  const liveIds = new Set<string>();
  for (const organization of organizations) {
    if (!requestedIds.has(organization.id) || liveIds.has(organization.id)) {
      throw new Error('Enterprise retention orphan authority returned an invalid organization set.');
    }
    liveIds.add(organization.id);
  }
  const missing = eligibleWorkItems.filter((work) => !liveIds.has(work.organizationId));
  const nextCursor = workItems.length === limit
    ? (workItems.at(-1)?.organizationId ?? cursor)
    : null;
  const cursorChanged = nextCursor !== cursor;
  const removed = await removeMissingOrganizationWork(
    db,
    lease,
    missing,
    cursorChanged || missing.length > 0
      ? { orphanWorkCursorOrganizationId: nextCursor }
      : {},
    scheduledAt,
    deadlineAt,
    clock,
  );
  return { checked: workItems.length, removed };
}

async function markWorkDone(
  db: DbRef,
  lease: LeaseContext,
  work: EnterpriseRetentionWork,
  scheduledAt: Date,
  deadlineAt: number,
  clock: () => number,
): Promise<void> {
  await commitLeaseState(db, lease, [
    workExpectation(work),
    workUpdate(work, {
      status: 'done',
      nextAttemptAt: scheduledAt.toISOString(),
      failureCount: 0,
      lastFailure: null,
      lastFailureAt: null,
      completedAt: scheduledAt.toISOString(),
    }, lease.state.currentDeliveryId ?? null),
  ], {
    pendingWorkCount: Math.max(0, finiteNonNegativeInteger(lease.state.pendingWorkCount) - 1),
  }, scheduledAt, deadlineAt, clock);
}

async function markWorkFailure(
  db: DbRef,
  lease: LeaseContext,
  work: EnterpriseRetentionWork,
  error: string,
  permanent: boolean,
  scheduledAt: Date,
  deadlineAt: number,
  clock: () => number,
): Promise<{ terminal: boolean }> {
  const failureCount = finiteNonNegativeInteger(work.failureCount) + 1;
  const terminal = permanent
    || failureCount >= ENTERPRISE_AUDIT_RETENTION_LIMITS.maxTransientFailuresPerSweep;
  const delay = TRANSIENT_BACKOFF_MS[
    Math.min(failureCount - 1, TRANSIENT_BACKOFF_MS.length - 1)
  ] ?? ENTERPRISE_AUDIT_RETENTION_LIMITS.physicalIntervalMs;
  await commitLeaseState(db, lease, [
    workExpectation(work),
    workUpdate(work, {
      status: terminal ? 'failed' : 'retry',
      nextAttemptAt: new Date(scheduledAt.getTime() + delay).toISOString(),
      failureCount,
      lastFailure: error.slice(0, 512),
      lastFailureAt: scheduledAt.toISOString(),
      completedAt: terminal ? scheduledAt.toISOString() : null,
    }, lease.state.currentDeliveryId ?? null),
  ], terminal
    ? {
        pendingWorkCount: Math.max(
          0,
          finiteNonNegativeInteger(lease.state.pendingWorkCount) - 1,
        ),
        failedWorkCount: finiteNonNegativeInteger(lease.state.failedWorkCount) + 1,
      }
    : {}, scheduledAt, deadlineAt, clock);
  return { terminal };
}

async function processRetentionCandidate(
  db: DbRef,
  lease: LeaseContext,
  work: EnterpriseRetentionWork,
  authorityOrError: RetentionAuthority | Error,
  scheduledAt: Date,
  readDeadlineAt: number,
  deadlineAt: number,
  clock: () => number,
  progress: SliceProgress,
): Promise<'continue' | 'stop'> {
  if (authorityOrError instanceof Error) {
    const message = describeError(authorityOrError);
    const failure = await markWorkFailure(
      db,
      lease,
      work,
      message,
      false,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: message,
      terminal: failure.terminal,
    });
    progress.processedOrganizations += 1;
    return clock() >= readDeadlineAt ? 'stop' : 'continue';
  }

  const authority = authorityOrError;
  if (authority.organizationMissing) {
    const removed = await removeMissingOrganizationWork(
      db,
      lease,
      [work],
      {},
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.orphanWorkRowsRemoved += removed;
    progress.results.push({ organizationId: work.organizationId, deleted: 0, status: 'removed' });
    progress.processedOrganizations += 1;
    return 'continue';
  }
  if (authority.permanentError) {
    await markWorkFailure(
      db,
      lease,
      work,
      authority.permanentError,
      true,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: authority.permanentError,
      terminal: true,
    });
    progress.results.push({ organizationId: work.organizationId, deleted: 0, status: 'failed' });
    progress.processedOrganizations += 1;
    return 'continue';
  }
  const retention = resolveRetentionDays(authority.controls);
  if (!retention.ok) {
    await markWorkFailure(
      db,
      lease,
      work,
      retention.error,
      true,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: retention.error,
      terminal: true,
    });
    progress.results.push({ organizationId: work.organizationId, deleted: 0, status: 'failed' });
    progress.processedOrganizations += 1;
    return 'continue';
  }

  const sweepStartedAt = asTimestamp(lease.state.sweepStartedAt) ?? scheduledAt.getTime();
  const cutoff = new Date(
    sweepStartedAt - retention.days * 24 * 60 * 60 * 1000,
  ).toISOString();
  if (authority.activeHold) {
    await markWorkDone(db, lease, work, scheduledAt, deadlineAt, clock);
    progress.results.push({
      organizationId: work.organizationId,
      deleted: 0,
      cutoff,
      preservedByLegalHold: true,
      status: 'done',
    });
    progress.processedOrganizations += 1;
    return 'continue';
  }
  if (finiteNonNegativeInteger(lease.state.currentDeliveryAttempted)
    >= ENTERPRISE_AUDIT_RETENTION_LIMITS.eventsPerSlice) {
    return 'stop';
  }
  if (responseAdmissionExhausted(lease.responses)) {
    const message = 'Enterprise retention parsed-response admission watermark was exhausted.';
    const failure = await markWorkFailure(
      db,
      lease,
      work,
      message,
      false,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: message,
      terminal: failure.terminal,
    });
    progress.processedOrganizations += 1;
    return 'continue';
  }
  if (clock() >= readDeadlineAt) {
    const message = 'Enterprise retention authority read completed after the mutation admission deadline.';
    const failure = await markWorkFailure(
      db,
      lease,
      work,
      message,
      false,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: message,
      terminal: failure.terminal,
    });
    progress.processedOrganizations += 1;
    return 'stop';
  }

  if (work.status !== 'ready' && work.status !== 'retry' && work.status !== 'backlog') {
    throw new Error(`Enterprise retention selected terminal work status "${work.status}".`);
  }
  const lane = work.status;
  const globalRemaining = ENTERPRISE_AUDIT_RETENTION_LIMITS.eventsPerSlice
    - finiteNonNegativeInteger(lease.state.currentDeliveryAttempted);
  const readRemaining = ENTERPRISE_AUDIT_RETENTION_LIMITS.eventRowsReadPerSlice
    - progress.eventRowsRead;
  const laneRemaining = deliveryLaneRemaining(lease.state, lane);
  const eventLimit = Math.min(
    ENTERPRISE_AUDIT_RETENTION_LIMITS.eventsPerOrganization,
    globalRemaining,
    readRemaining,
    laneRemaining,
  );
  if (eventLimit <= 0) return globalRemaining <= 0 || readRemaining <= 0 ? 'stop' : 'continue';

  let expired: OrganizationAuditEvent[];
  const responseBytesBeforeEventPage = lease.responses.bytes;
  try {
    expired = await listWithinDeadline(
      db
        .table<OrganizationAuditEvent>('organization_audit_events')
        .where('organizationId', '==', work.organizationId)
        .where('occurredAt', '<', cutoff)
        .orderBy('occurredAt', 'asc')
        .orderBy('id', 'asc')
        .select('id', 'organizationId', 'occurredAt')
        .page(1)
        .limit(eventLimit)
        .includeTotal(false),
      readDeadlineAt,
      clock,
      lease.responses,
      'expired audit-event page',
    );
  } catch (error) {
    const message = describeError(error);
    const failure = await markWorkFailure(
      db,
      lease,
      work,
      message,
      false,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: message,
      terminal: failure.terminal,
    });
    progress.processedOrganizations += 1;
    return clock() >= readDeadlineAt ? 'stop' : 'continue';
  }

  progress.eventRowsRead += expired.length;
  const eventBytes = lease.responses.bytes - responseBytesBeforeEventPage;
  if (
    expired.length > eventLimit
    || progress.eventRowsRead > ENTERPRISE_AUDIT_RETENTION_LIMITS.eventRowsReadPerSlice
    || eventBytes > ENTERPRISE_AUDIT_RETENTION_LIMITS.projectedPayloadBytesPerEventPage
  ) {
    const message = 'Enterprise retention event page exceeded its row or payload bound.';
    await markWorkFailure(db, lease, work, message, true, scheduledAt, deadlineAt, clock);
    progress.failures.push({ organizationId: work.organizationId, error: message, terminal: true });
    progress.results.push({ organizationId: work.organizationId, deleted: 0, cutoff, status: 'failed' });
    progress.processedOrganizations += 1;
    return 'continue';
  }
  if (clock() >= readDeadlineAt) {
    const message = 'Enterprise retention read completed after the mutation admission deadline.';
    const failure = await markWorkFailure(
      db,
      lease,
      work,
      message,
      false,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: message,
      terminal: failure.terminal,
    });
    progress.processedOrganizations += 1;
    return 'stop';
  }

  if (expired.length === 0) {
    await markWorkDone(db, lease, work, scheduledAt, deadlineAt, clock);
    progress.results.push({ organizationId: work.organizationId, deleted: 0, cutoff, status: 'done' });
    progress.processedOrganizations += 1;
    return 'continue';
  }
  const organization = authority.organization;
  if (!organization) throw new Error('Enterprise retention organization authority is missing.');
  const backlog = expired.length === eventLimit;
  const operations: TransactOperation[] = [
    workExpectation(work),
    workUpdate(work, {
      status: backlog ? 'backlog' : 'done',
      nextAttemptAt: backlog
        ? new Date(
            scheduledAt.getTime() + ENTERPRISE_AUDIT_RETENTION_LIMITS.physicalIntervalMs,
          ).toISOString()
        : scheduledAt.toISOString(),
      failureCount: 0,
      lastFailure: null,
      lastFailureAt: null,
      completedAt: backlog ? null : scheduledAt.toISOString(),
    }, lease.state.currentDeliveryId ?? null),
    ...retentionAuthorityExpectations(organization, authority.controls),
  ];
  for (const event of expired) {
    operations.push({
      table: 'organization_audit_events',
      op: 'expect',
      id: event.id,
      where: [
        ['organizationId', '==', work.organizationId],
        ['occurredAt', '==', event.occurredAt],
      ],
      exists: true,
    });
    operations.push({ table: 'organization_audit_events', op: 'delete', id: event.id });
  }
  operations.push({
    table: 'organization_audit_events',
    op: 'insert',
    data: {
      id: newId(),
      organizationId: work.organizationId,
      actorId: null,
      action: 'organization_audit.retention_prune',
      targetType: 'organization',
      targetId: work.organizationId,
      metadata: { deleted: expired.length, retentionDays: retention.days, cutoff },
      occurredAt: scheduledAt.toISOString(),
    },
  });

  try {
    const laneAttempts = normalizedDeliveryLaneAttempts(lease.state);
    const laneAttemptPatch: Partial<EnterpriseMaintenanceState> = lane === 'retry'
      ? { currentDeliveryRetryAttempted: laneAttempts.retry + expired.length }
      : lane === 'backlog'
        ? { currentDeliveryBacklogAttempted: laneAttempts.backlog + expired.length }
        : { currentDeliveryReadyAttempted: laneAttempts.ready + expired.length };
    await commitLeaseState(db, lease, operations, {
      ...laneAttemptPatch,
      currentDeliveryAttempted:
        finiteNonNegativeInteger(lease.state.currentDeliveryAttempted) + expired.length,
      pendingWorkCount: backlog
        ? finiteNonNegativeInteger(lease.state.pendingWorkCount)
        : Math.max(0, finiteNonNegativeInteger(lease.state.pendingWorkCount) - 1),
    }, scheduledAt, deadlineAt, clock);
  } catch (error) {
    const outcome = destructiveTransactionOutcome(error);
    if (outcome === 'ambiguous') throw error;
    const message = describeError(error);
    const failure = await markWorkFailure(
      db,
      lease,
      work,
      message,
      false,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({
      organizationId: work.organizationId,
      error: message,
      terminal: failure.terminal,
    });
    progress.processedOrganizations += 1;
    return 'continue';
  }
  progress.deleted += expired.length;
  progress.results.push({
    organizationId: work.organizationId,
    deleted: expired.length,
    cutoff,
    status: backlog ? 'backlog' : 'done',
  });
  progress.processedOrganizations += 1;
  return 'continue';
}

function completionPatch(
  state: EnterpriseMaintenanceState,
  scheduledAt: Date,
  selectionSucceeded: boolean,
): Partial<EnterpriseMaintenanceState> {
  const selectionReset: Partial<EnterpriseMaintenanceState> = selectionSucceeded
    ? {
        selectionFailureCount: 0,
        selectionNextAttemptAt: null,
        selectionLastFailure: null,
        selectionLastFailureAt: null,
      }
    : {};
  const complete = state.discoveryComplete === true
    && finiteNonNegativeInteger(state.pendingWorkCount) === 0;
  if (!complete) {
    return {
      ...selectionReset,
      leaseToken: null,
      leaseExpiresAt: null,
      currentDeliverySettled: true,
    };
  }
  const sweepStartedAt = asTimestamp(state.sweepStartedAt) ?? scheduledAt.getTime();
  return {
    cursorOrganizationId: null,
    cursorOrganizationCreatedAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastCompletedAt: scheduledAt.toISOString(),
    nextDueAt: nextLogicalDailyBoundary(sweepStartedAt),
    sweepId: null,
    sweepStartedAt: null,
    sweepUpperCreatedAt: null,
    discoveryComplete: false,
    discoveryFailureCount: 0,
    discoveryNextAttemptAt: null,
    discoveryLastFailure: null,
    discoveryLastFailureAt: null,
    selectionFailureCount: 0,
    selectionNextAttemptAt: null,
    selectionLastFailure: null,
    selectionLastFailureAt: null,
    pendingWorkCount: 0,
    lastFailedWorkCount: finiteNonNegativeInteger(state.failedWorkCount),
    failedWorkCount: 0,
    currentDeliverySettled: true,
  };
}

function emptyResult(
  reason: AcquisitionReason,
  state: EnterpriseMaintenanceState | null,
  responses: ParsedResponseAccounting,
) {
  const attemptedByLane = normalizedDeliveryLaneAttempts(state);
  return {
    discovered: 0,
    organizations: 0,
    attempted: finiteNonNegativeInteger(state?.currentDeliveryAttempted),
    deleted: 0,
    eventRowsRead: 0,
    orphanWorkRowsChecked: 0,
    orphanWorkRowsRemoved: 0,
    projectedBytes: responses.bytes,
    parsedResponseCount: responses.count,
    responseAdmissionExceeded:
      responses.bytes > ENTERPRISE_AUDIT_RETENTION_LIMITS.projectedPayloadBytesPerSlice,
    attemptedByLane,
    results: [],
    failures: [],
    cursorOrganizationId: state?.cursorOrganizationId ?? null,
    pendingWorkCount: finiteNonNegativeInteger(state?.pendingWorkCount),
    leaseActive: false,
    campaignActive: Boolean(state?.sweepId),
    exhausted: Boolean(state?.sweepId),
    idleReason: reason,
  };
}

export async function pruneOrganizationAuditRetention(
  db: DbRef,
  scheduledAt = new Date(),
  options: EnterpriseAuditRetentionOptions = {},
) {
  if (!Number.isFinite(scheduledAt.getTime())) {
    throw new Error('Enterprise maintenance time must be valid.');
  }
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const deadlineAt = startedAt + ENTERPRISE_AUDIT_RETENTION_LIMITS.elapsedMs;
  const readDeadlineAt = deadlineAt - ENTERPRISE_AUDIT_RETENTION_LIMITS.settlementReserveMs;
  const leaseToken = options.leaseToken?.() ?? newId();
  const deliveryId = options.deliveryId ?? `manual:${scheduledAt.toISOString()}:${leaseToken}`;
  const responses: ParsedResponseAccounting = { bytes: 0, count: 0 };
  const acquisition = await acquireLease(
    db,
    scheduledAt,
    deliveryId,
    leaseToken,
    deadlineAt,
    clock,
    responses,
  );
  if (!acquisition.acquired) return emptyResult(acquisition.reason, acquisition.state, responses);
  const lease = acquisition.lease;

  let discovered = 0;
  const queryFailures: Array<{ lane: QueryFailureLane; error: string }> = [];
  const progress: SliceProgress = {
    processedOrganizations: 0,
    deleted: 0,
    eventRowsRead: 0,
    orphanWorkRowsRemoved: 0,
    results: [],
    failures: [],
  };
  let orphanCleanup = { checked: 0, removed: 0 };

  if (
    clock() < readDeadlineAt
    && lease.state.discoveryComplete !== true
    && queryLaneDue(lease.state, 'discovery', scheduledAt)
  ) {
    try {
      const discovery = await discoverOrganizations(
        db,
        lease,
        scheduledAt,
        readDeadlineAt,
        deadlineAt,
        clock,
      );
      discovered = discovery.discovered;
    } catch (error) {
      await markQueryLaneFailure(
        db,
        lease,
        'discovery',
        error,
        scheduledAt,
        deadlineAt,
        clock,
      );
      queryFailures.push({ lane: 'discovery', error: describeError(error) });
    }
  }

  let candidates: EnterpriseRetentionWork[] = [];
  let selectionSucceeded = false;
  if (
    clock() < readDeadlineAt
    && finiteNonNegativeInteger(lease.state.pendingWorkCount) > 0
    && queryLaneDue(lease.state, 'selection', scheduledAt)
  ) {
    try {
      candidates = await queryWorkCandidates(
        db,
        lease.state,
        scheduledAt,
        readDeadlineAt,
        clock,
        lease.responses,
      );
      selectionSucceeded = true;
    } catch (error) {
      await markQueryLaneFailure(
        db,
        lease,
        'selection',
        error,
        scheduledAt,
        deadlineAt,
        clock,
      );
      queryFailures.push({ lane: 'selection', error: describeError(error) });
    }
  }

  const regularCandidates: EnterpriseRetentionWork[] = [];
  for (const candidate of candidates) {
    if (serializedBytes(candidate) <= ENTERPRISE_AUDIT_RETENTION_LIMITS.projectedPayloadBytesPerWorkItem) {
      regularCandidates.push(candidate);
      continue;
    }
    const message = 'Enterprise retention work candidate exceeded its per-item payload bound.';
    await markWorkFailure(
      db,
      lease,
      candidate,
      message,
      true,
      scheduledAt,
      deadlineAt,
      clock,
    );
    progress.failures.push({ organizationId: candidate.organizationId, error: message, terminal: true });
    progress.results.push({
      organizationId: candidate.organizationId,
      deleted: 0,
      status: 'failed',
    });
    progress.processedOrganizations += 1;
  }

  let stopProcessing = false;
  for (
    let offset = 0;
    offset < regularCandidates.length && !stopProcessing;
    offset += ENTERPRISE_AUDIT_RETENTION_LIMITS.authorityBatchSize
  ) {
    if (
      clock() >= readDeadlineAt
      || finiteNonNegativeInteger(lease.state.currentDeliveryAttempted)
        >= ENTERPRISE_AUDIT_RETENTION_LIMITS.eventsPerSlice
      || responseAdmissionExhausted(lease.responses)
    ) {
      break;
    }
    const round = regularCandidates.slice(
      offset,
      offset + ENTERPRISE_AUDIT_RETENTION_LIMITS.authorityBatchSize,
    );
    const authorities = await queryRetentionAuthorityRound(
      db,
      round,
      readDeadlineAt,
      clock,
      lease.responses,
    );
    for (let index = 0; index < round.length; index += 1) {
      const work = round[index];
      const authority = authorities[index];
      if (!work || !authority) continue;
      const outcome = await processRetentionCandidate(
        db,
        lease,
        work,
        authority,
        scheduledAt,
        readDeadlineAt,
        deadlineAt,
        clock,
        progress,
      );
      if (outcome === 'stop') {
        stopProcessing = true;
        break;
      }
    }
  }

  if (
    (
      selectionSucceeded
      || finiteNonNegativeInteger(lease.state.pendingWorkCount) === 0
    )
    && clock() < readDeadlineAt
    && !responseAdmissionExhausted(lease.responses)
  ) {
    orphanCleanup = await pruneOrphanRetentionWork(
      db,
      lease,
      scheduledAt,
      readDeadlineAt,
      deadlineAt,
      clock,
    );
    progress.orphanWorkRowsRemoved += orphanCleanup.removed;
  }

  await commitLeaseState(
    db,
    lease,
    [],
    completionPatch(lease.state, scheduledAt, selectionSucceeded),
    scheduledAt,
    deadlineAt,
    clock,
  );

  const attemptedByLane = normalizedDeliveryLaneAttempts(lease.state);

  return {
    discovered,
    organizations: progress.processedOrganizations,
    attempted: finiteNonNegativeInteger(lease.state.currentDeliveryAttempted),
    deleted: progress.deleted,
    eventRowsRead: progress.eventRowsRead,
    orphanWorkRowsChecked: orphanCleanup.checked,
    orphanWorkRowsRemoved: progress.orphanWorkRowsRemoved,
    projectedBytes: lease.responses.bytes,
    parsedResponseCount: lease.responses.count,
    responseAdmissionExceeded:
      lease.responses.bytes > ENTERPRISE_AUDIT_RETENTION_LIMITS.projectedPayloadBytesPerSlice,
    attemptedByLane,
    results: progress.results,
    failures: progress.failures,
    queryFailures,
    cursorOrganizationId: lease.state.cursorOrganizationId ?? null,
    pendingWorkCount: finiteNonNegativeInteger(lease.state.pendingWorkCount),
    leaseActive: false,
    campaignActive: Boolean(lease.state.sweepId),
    exhausted: Boolean(lease.state.sweepId),
    idleReason: null,
  };
}

export default defineFunction({
  trigger: { type: 'schedule', cron: ENTERPRISE_AUDIT_RETENTION_CRON },
  async handler(rawContext: unknown) {
    const context = rawContext as ScheduledFunctionContext;
    const after = context.data?.after;
    const scheduledTime = after?.scheduledTime;
    const scheduledAt = scheduledTime && Number.isFinite(Date.parse(scheduledTime))
      ? new Date(scheduledTime)
      : new Date();
    return pruneOrganizationAuditRetention(context.admin.db('app'), scheduledAt, {
      deliveryId: after?.deliveryId
        ?? `schedule:${after?.cron ?? ENTERPRISE_AUDIT_RETENTION_CRON}:${scheduledAt.toISOString()}`,
    });
  },
});
