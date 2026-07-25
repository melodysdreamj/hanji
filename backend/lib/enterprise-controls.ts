import {
  listAll,
  getExisting,
  type TransactOperation,
} from './table-utils';

interface ListResult<T> {
  items?: T[];
  hasMore?: boolean;
}

interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  where?(field: string, op: string, value: unknown): TableQuery<T>;
  orderBy?(field: string, direction: 'asc' | 'desc'): TableQuery<T>;
  includeTotal?(include: boolean): TableQuery<T>;
  select?(...fields: string[]): TableQuery<T>;
  getList(): Promise<ListResult<T>>;
}

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
  transact?(operations: TransactOperation[]): Promise<unknown>;
}

interface Workspace {
  id: string;
  organizationId?: string | null;
}

interface OrganizationEnterpriseControls {
  id: string;
  organizationId: string;
  dlpPolicy?: Record<string, unknown> | null;
  mcpGovernancePolicy?: Record<string, unknown> | null;
  auditPolicy?: unknown;
  auditRetentionDays?: number | null;
  auditRetentionPolicyValid?: boolean | null;
  auditRetentionPolicyError?: string | null;
  version?: number | null;
  createdAt?: string | null;
}

interface OrganizationAuditEvent {
  id: string;
  organizationId: string;
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

export interface McpGovernedWorkspace {
  id: string;
  organizationId?: string | null;
}

export interface McpClientGovernanceContext {
  actorId?: string | null;
  clientId: string;
  clientName?: string | null;
  grantId?: string | null;
  stage: 'authorization' | 'manual_token_authorization' | 'hosted_call';
}

export interface ValidMcpApprovedClient extends Record<string, unknown> {
  clientId: string;
}

export interface ValidMcpWorkspacePolicy extends Record<string, unknown> {
  workspaceId: string;
  enabled: boolean;
  approvedClients: ValidMcpApprovedClient[];
}

export interface ValidMcpGovernancePolicy extends Record<string, unknown> {
  workspacePolicies: ValidMcpWorkspacePolicy[];
}

interface Page {
  id: string;
  workspaceId: string;
}

interface PageLinkedRecord {
  id: string;
  pageId?: string | null;
  workspaceId?: string | null;
}

interface OrganizationLegalHold {
  id: string;
  organizationId: string;
  name: string;
  status?: string | null;
  scope?: Record<string, unknown> | null;
}

const dlpBlockKeys: Record<string, string> = {
  publicSharing: 'blockPublicSharing',
  externalSharing: 'blockExternalSharing',
  fileDownloads: 'blockFileDownloads',
  exports: 'blockExports',
};

export type NormalizedAuditRetentionPolicy =
  | { valid: true; days: number; error: null }
  | { valid: false; days: null; error: string };

export const AUDIT_RETENTION_SCALAR_LIMITS = Object.freeze({
  // SQL length() is portable across SQLite and PostgreSQL but counts Unicode
  // characters rather than UTF-8 bytes. Requiring both limits makes the
  // pre-wire SQL guard conservative on either provider (one code point is at
  // most four UTF-8 bytes) and keeps live-writer normalization identical.
  policyCharacters: 6 * 1_024,
  policyBytes: 24 * 1_024,
  rowsPerSlice: 20,
  projectedPayloadBytesPerSlice: 256 * 1_024,
  maximumTransactionOperations: 40,
  // The admin SQL HTTP fallback serializes the result in rows/items/results.
  // These caps keep even that three-copy envelope below the projected bound.
  aggregatePolicyCharactersPerRead: 8 * 1_024,
  identifierCharacters: 64,
  createdAtCharacters: 40,
  priorErrorCharacters: 160,
  rawSqlEnvelopeCopies: 3,
});

function serializedBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function normalizedAuditRetentionPolicy(
  policy: unknown,
): NormalizedAuditRetentionPolicy {
  if (policy == null) {
    return { valid: true, days: 365, error: null };
  }
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    return { valid: false, days: null, error: 'auditPolicy must be an object.' };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(policy);
  } catch {
    return { valid: false, days: null, error: 'auditPolicy must be JSON serializable.' };
  }
  if (
    serialized.length > AUDIT_RETENTION_SCALAR_LIMITS.policyCharacters
    || new TextEncoder().encode(serialized).byteLength
      > AUDIT_RETENTION_SCALAR_LIMITS.policyBytes
  ) {
    return {
      valid: false,
      days: null,
      error: 'auditPolicy exceeds the bounded normalization limit.',
    };
  }
  if (!Object.prototype.hasOwnProperty.call(policy, 'retentionDays')) {
    return { valid: true, days: 365, error: null };
  }
  const days = (policy as Record<string, unknown>).retentionDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 30 || days > 3650) {
    return {
      valid: false,
      days: null,
      error: 'auditPolicy.retentionDays must be an integer between 30 and 3650.',
    };
  }
  return { valid: true, days, error: null };
}

export function auditRetentionScalarPatch(
  policy: unknown,
) {
  const normalized = normalizedAuditRetentionPolicy(policy);
  return {
    auditRetentionPolicyValid: normalized.valid,
    auditRetentionDays: normalized.days,
    auditRetentionPolicyError: normalized.error,
  };
}

export interface RetentionScalarBackfillCursor {
  createdAt: string;
  id: string;
}

export interface RetentionScalarBackfillResult {
  cursor: RetentionScalarBackfillCursor | null;
  scanComplete: boolean;
  complete: boolean;
  scanned: number;
  updated: number;
  unchanged: number;
  projectedBytes: number;
  listRequests: number;
  transactionRequests: number;
  conflicts: Array<{
    organizationId: string;
    reason: 'duplicate' | 'concurrent' | 'malformed_version';
  }>;
}

export interface RetentionScalarRawRow {
  id?: unknown;
  organizationId?: unknown;
  createdAt?: unknown;
  auditPolicyJson?: unknown;
  auditPolicyOversized?: unknown;
  deferred?: unknown;
  duplicateCount?: unknown;
  auditRetentionDays?: unknown;
  auditRetentionPolicyValid?: unknown;
  auditRetentionPolicyError?: unknown;
  scalarStateOversized?: unknown;
  version?: unknown;
}

export interface RetentionScalarReadRequest {
  cursor: RetentionScalarBackfillCursor | null;
  maxRows: number;
  maxProjectedBytes: number;
}

export type RetentionScalarRowReader = (
  request: RetentionScalarReadRequest,
) => Promise<RetentionScalarRawRow[]>;

export type RetentionScalarSqlExecutor = (
  query: string,
  params: unknown[],
) => Promise<unknown[]>;

function asSqlBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function finiteSqlNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Provider-portable (SQLite/PostgreSQL) bounded source read. The SQL only
 * emits a contiguous deliverable prefix plus one deferred marker. Oversized
 * policy documents emit no policy body, so a corrupt row cannot amplify the
 * wire response or starve later keyset rows.
 */
export async function readBoundedRetentionScalarRows(
  execute: RetentionScalarSqlExecutor,
  request: RetentionScalarReadRequest,
): Promise<RetentionScalarRawRow[]> {
  const candidateLimit = request.maxRows + 1;
  const whereSql = request.cursor
    ? 'WHERE ("createdAt" > ? OR ("createdAt" = ? AND "id" > ?))'
    : '';
  const cursorParams = request.cursor
    ? [request.cursor.createdAt, request.cursor.createdAt, request.cursor.id]
    : [];
  const query = `
    WITH candidates AS (
      SELECT
        c."id",
        c."organizationId",
        c."createdAt",
        c."auditPolicy",
        c."auditRetentionDays",
        c."auditRetentionPolicyValid",
        c."auditRetentionPolicyError",
        c."version",
        (SELECT COUNT(*)
           FROM "organization_enterprise_controls" d
          WHERE d."organizationId" = c."organizationId") AS "duplicateCount",
        ROW_NUMBER() OVER (ORDER BY c."createdAt" ASC, c."id" ASC) AS "rowNumber",
        CASE WHEN c."auditPolicy" IS NULL
          THEN 0 ELSE LENGTH(CAST(c."auditPolicy" AS TEXT)) END AS "policyCharacters"
      FROM "organization_enterprise_controls" c
      ${whereSql}
      ORDER BY c."createdAt" ASC, c."id" ASC
      LIMIT ?
    ), measured AS (
      SELECT
        candidates.*,
        SUM(CASE
          WHEN "policyCharacters" <= ? THEN "policyCharacters"
          ELSE 0
        END) OVER (
          ORDER BY "createdAt" ASC, "id" ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "cumulativePolicyCharacters"
      FROM candidates
    ), classified AS (
      SELECT
        measured.*,
        CASE
          WHEN "policyCharacters" > ? THEN 0
          WHEN "cumulativePolicyCharacters" <= ? THEN 0
          ELSE 1
        END AS "deferred"
      FROM measured
    )
    SELECT
      CASE WHEN LENGTH(CAST("id" AS TEXT)) <= ?
        THEN CAST("id" AS TEXT) ELSE NULL END AS "id",
      CASE WHEN LENGTH(CAST("organizationId" AS TEXT)) <= ?
        THEN CAST("organizationId" AS TEXT) ELSE NULL END AS "organizationId",
      CASE WHEN LENGTH(CAST("createdAt" AS TEXT)) <= ?
        THEN CAST("createdAt" AS TEXT) ELSE NULL END AS "createdAt",
      CASE
        WHEN "deferred" = 0 AND "policyCharacters" <= ?
        THEN CAST("auditPolicy" AS TEXT)
        ELSE NULL
      END AS "auditPolicyJson",
      CASE WHEN "policyCharacters" > ? THEN 1 ELSE 0 END AS "auditPolicyOversized",
      "deferred",
      "duplicateCount",
      CASE WHEN "auditRetentionDays" IS NULL THEN NULL
        WHEN LENGTH(CAST("auditRetentionDays" AS TEXT)) <= 32
        THEN "auditRetentionDays" ELSE NULL END AS "auditRetentionDays",
      CASE WHEN "auditRetentionPolicyValid" IS NULL THEN NULL
        WHEN LENGTH(CAST("auditRetentionPolicyValid" AS TEXT)) <= 8
        THEN "auditRetentionPolicyValid" ELSE NULL END AS "auditRetentionPolicyValid",
      CASE WHEN "auditRetentionPolicyError" IS NULL THEN NULL
        WHEN LENGTH(CAST("auditRetentionPolicyError" AS TEXT)) <= ?
        THEN CAST("auditRetentionPolicyError" AS TEXT)
        ELSE NULL END AS "auditRetentionPolicyError",
      CASE WHEN
        ("auditRetentionPolicyError" IS NOT NULL
          AND LENGTH(CAST("auditRetentionPolicyError" AS TEXT)) > ?)
        OR ("auditRetentionDays" IS NOT NULL
          AND LENGTH(CAST("auditRetentionDays" AS TEXT)) > 32)
        OR ("auditRetentionPolicyValid" IS NOT NULL
          AND LENGTH(CAST("auditRetentionPolicyValid" AS TEXT)) > 8)
        OR ("version" IS NOT NULL AND LENGTH(CAST("version" AS TEXT)) > 32)
        THEN 1 ELSE 0 END AS "scalarStateOversized",
      CASE WHEN "version" IS NULL THEN NULL
        WHEN LENGTH(CAST("version" AS TEXT)) <= 32
        THEN "version" ELSE NULL END AS "version"
    FROM classified
    WHERE "rowNumber" <= COALESCE(
      (SELECT MIN("rowNumber") FROM classified WHERE "deferred" = 1),
      ?
    )
    ORDER BY "createdAt" ASC, "id" ASC
  `;
  const params = [
    ...cursorParams,
    candidateLimit,
    AUDIT_RETENTION_SCALAR_LIMITS.policyCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.policyCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.aggregatePolicyCharactersPerRead,
    AUDIT_RETENTION_SCALAR_LIMITS.identifierCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.identifierCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.createdAtCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.policyCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.policyCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.priorErrorCharacters,
    AUDIT_RETENTION_SCALAR_LIMITS.priorErrorCharacters,
    candidateLimit,
  ];
  const rows = await execute(query, params);
  if (!Array.isArray(rows)) throw new Error('Retention scalar SQL read returned no row array.');
  const projectedBytes = serializedBytes(rows)
    * AUDIT_RETENTION_SCALAR_LIMITS.rawSqlEnvelopeCopies;
  if (projectedBytes > request.maxProjectedBytes) {
    throw Object.assign(
      new Error(`Retention scalar SQL response exceeded the ${request.maxProjectedBytes}-byte projected wire limit.`),
      { status: 413 },
    );
  }
  return rows as RetentionScalarRawRow[];
}

class RetentionScalarDeadlineError extends Error {
  constructor(label: string) {
    super(`Retention scalar migration deadline elapsed during ${label}.`);
    this.name = 'RetentionScalarDeadlineError';
  }
}

async function withinRetentionScalarDeadline<T>(
  work: () => Promise<T>,
  deadlineAt: number | undefined,
  clock: () => number,
  label: string,
): Promise<T> {
  if (deadlineAt === undefined) return work();
  const remaining = Math.floor(deadlineAt - clock());
  if (remaining <= 0) throw new RetentionScalarDeadlineError(label);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new RetentionScalarDeadlineError(label)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Explicit bounded rollout for legacy controls rows. The caller persists the
 * returned `(createdAt,id)` keyset cursor. Replaying an unacknowledged slice
 * is harmless: exact scalar rows are no-ops and each write is guarded by the
 * source row's organization/version snapshot. Compatible writes are attempted
 * in one transaction; a conflict recursively bisects the bounded set so one
 * tenant cannot block independent tenants.
 */
export async function backfillAuditRetentionScalars(
  db: DbRef,
  cursor: RetentionScalarBackfillCursor | null = null,
  options: {
    maxRows?: number;
    maxProjectedBytes?: number;
    readRows?: RetentionScalarRowReader;
    deadlineAt?: number;
    clock?: () => number;
  } = {},
): Promise<RetentionScalarBackfillResult> {
  if (!db.transact) throw new Error('Retention scalar backfill requires transact support.');
  if (!options.readRows) {
    throw new Error('Retention scalar backfill requires a bounded raw row reader.');
  }
  const transact = db.transact.bind(db);
  const clock = options.clock ?? Date.now;
  const maxRows = Math.min(
    AUDIT_RETENTION_SCALAR_LIMITS.rowsPerSlice,
    Math.max(1, Math.floor(options.maxRows ?? AUDIT_RETENTION_SCALAR_LIMITS.rowsPerSlice)),
  );
  const maxProjectedBytes = Math.min(
    AUDIT_RETENTION_SCALAR_LIMITS.projectedPayloadBytesPerSlice,
    Math.max(1, Math.floor(
      options.maxProjectedBytes ?? AUDIT_RETENTION_SCALAR_LIMITS.projectedPayloadBytesPerSlice,
    )),
  );
  const listRequests = 1;
  const rawRows = await withinRetentionScalarDeadline(
    () => options.readRows!({ cursor, maxRows, maxProjectedBytes }),
    options.deadlineAt,
    clock,
    'bounded source read',
  );
  const projectedBytes = serializedBytes(rawRows)
    * AUDIT_RETENTION_SCALAR_LIMITS.rawSqlEnvelopeCopies;
  const boundedRawRows: RetentionScalarRawRow[] = [];
  for (const row of rawRows.slice(0, maxRows)) {
    if (asSqlBoolean(row.deferred)) break;
    boundedRawRows.push(row);
  }
  const rows: Array<OrganizationEnterpriseControls & {
    policyOversized: boolean;
    duplicateCount: number;
    scalarStateMalformed: boolean;
    versionMalformed: boolean;
  }> = [];
  for (const raw of boundedRawRows) {
    if (
      typeof raw.id !== 'string'
      || typeof raw.organizationId !== 'string'
      || typeof raw.createdAt !== 'string'
    ) {
      throw new Error('Retention scalar migration encountered an oversized or malformed row identity.');
    }
    let auditPolicy: unknown = null;
    if (!asSqlBoolean(raw.auditPolicyOversized) && raw.auditPolicyJson != null) {
      if (typeof raw.auditPolicyJson !== 'string') {
        throw new Error('Retention scalar migration received a non-text policy projection.');
      }
      try {
        auditPolicy = JSON.parse(raw.auditPolicyJson);
      } catch {
        auditPolicy = raw.auditPolicyJson;
      }
    }
    const rawVersionIsValid = raw.version == null
      || (typeof raw.version === 'number'
        && Number.isSafeInteger(raw.version)
        && raw.version >= 0);
    const rawDaysAreValid = raw.auditRetentionDays == null
      || (typeof raw.auditRetentionDays === 'number'
        && Number.isFinite(raw.auditRetentionDays));
    const rawValidityIsValid = raw.auditRetentionPolicyValid == null
      || typeof raw.auditRetentionPolicyValid === 'boolean'
      || raw.auditRetentionPolicyValid === 0
      || raw.auditRetentionPolicyValid === 1;
    const rawErrorIsValid = raw.auditRetentionPolicyError == null
      || typeof raw.auditRetentionPolicyError === 'string';
    rows.push({
      id: raw.id,
      organizationId: raw.organizationId,
      createdAt: raw.createdAt,
      auditPolicy,
      auditRetentionDays: finiteSqlNumber(raw.auditRetentionDays),
      auditRetentionPolicyValid: raw.auditRetentionPolicyValid == null
        ? null
        : asSqlBoolean(raw.auditRetentionPolicyValid),
      auditRetentionPolicyError: typeof raw.auditRetentionPolicyError === 'string'
        ? raw.auditRetentionPolicyError
        : null,
      version: finiteSqlNumber(raw.version),
      policyOversized: asSqlBoolean(raw.auditPolicyOversized),
      duplicateCount: Math.max(0, Math.floor(finiteSqlNumber(raw.duplicateCount) ?? 0)),
      scalarStateMalformed: asSqlBoolean(raw.scalarStateOversized)
        || !rawDaysAreValid
        || !rawValidityIsValid
        || !rawErrorIsValid,
      versionMalformed: !rawVersionIsValid,
      ...(asSqlBoolean(raw.scalarStateOversized) ? {
        auditRetentionPolicyError: '__oversized_prior_scalar_error__',
      } : {}),
    });
  }
  const sourceHasMore = rawRows.length > rows.length;
  let updated = 0;
  let unchanged = 0;
  let transactionRequests = 0;
  const conflicts: RetentionScalarBackfillResult['conflicts'] = [];

  if (rows.length === 0) {
    return {
      cursor,
      scanComplete: !sourceHasMore,
      complete: !sourceHasMore,
      scanned: 0,
      updated: 0,
      unchanged: 0,
      projectedBytes,
      listRequests,
      transactionRequests,
      conflicts,
    };
  }

  const duplicateOrganizations = new Set(rows
    .filter((row) => row.duplicateCount !== 1)
    .map((row) => row.organizationId));
  for (const organizationId of duplicateOrganizations) {
    conflicts.push({ organizationId, reason: 'duplicate' });
  }

  interface Candidate {
    row: OrganizationEnterpriseControls;
    patch: ReturnType<typeof auditRetentionScalarPatch>;
    expectedVersion: number | null;
    nextVersion: number;
  }
  const candidates: Candidate[] = [];
  for (const row of rows) {
    if (duplicateOrganizations.has(row.organizationId)) continue;
    const patch = row.policyOversized
      ? {
          auditRetentionPolicyValid: false,
          auditRetentionDays: null,
          auditRetentionPolicyError: 'auditPolicy exceeds the bounded normalization limit.',
        }
      : auditRetentionScalarPatch(row.auditPolicy);
    if (row.versionMalformed) {
      conflicts.push({ organizationId: row.organizationId, reason: 'malformed_version' });
      continue;
    }
    const expectedVersion = row.version == null ? null : Number(row.version);
    if (
      expectedVersion !== null
      && !row.scalarStateMalformed
      && row.auditRetentionPolicyValid === patch.auditRetentionPolicyValid
      && row.auditRetentionDays === patch.auditRetentionDays
      && (row.auditRetentionPolicyError ?? null) === patch.auditRetentionPolicyError
    ) {
      unchanged += 1;
      continue;
    }
    candidates.push({ row, patch, expectedVersion, nextVersion: (expectedVersion ?? 0) + 1 });
  }

  const operationsFor = (candidateRows: Candidate[]): TransactOperation[] => candidateRows.flatMap(
    ({ row, patch, expectedVersion, nextVersion }) => [
      {
        table: 'organization_enterprise_controls',
        op: 'expect',
        id: row.id,
        where: [
          ['organizationId', '==', row.organizationId],
          ['version', '==', expectedVersion],
        ],
        exists: true,
      },
      {
        table: 'organization_enterprise_controls',
        op: 'update',
        id: row.id,
        data: { ...patch, version: nextVersion },
      },
    ],
  );
  const transactionConflict = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object'
      ? Number((error as { code?: unknown; status?: unknown }).code
        ?? (error as { code?: unknown; status?: unknown }).status)
      : NaN;
    return code === 409 || /expectation failed|already exists|conflict|unique/i.test(message);
  };
  const applyCandidates = async (candidateRows: Candidate[]): Promise<void> => {
    if (candidateRows.length === 0) return;
    try {
      transactionRequests += 1;
      await withinRetentionScalarDeadline(
        () => transact(operationsFor(candidateRows)),
        options.deadlineAt,
        clock,
        'bounded transaction',
      );
      updated += candidateRows.length;
    } catch (error) {
      if (!transactionConflict(error)) throw error;
      if (candidateRows.length === 1) {
        conflicts.push({
          organizationId: candidateRows[0].row.organizationId,
          reason: 'concurrent',
        });
        return;
      }
      const split = Math.ceil(candidateRows.length / 2);
      await applyCandidates(candidateRows.slice(0, split));
      await applyCandidates(candidateRows.slice(split));
    }
  };
  await applyCandidates(candidates);

  const lastSettled = rows[rows.length - 1];
  const nextCursor = lastSettled?.createdAt
    ? { createdAt: lastSettled.createdAt, id: lastSettled.id }
    : cursor;
  const scanComplete = !sourceHasMore;
  const complete = scanComplete && conflicts.length === 0;
  return {
    cursor: nextCursor,
    scanComplete,
    complete,
    scanned: rows.length,
    updated,
    unchanged,
    projectedBytes,
    listRequests,
    transactionRequests,
    conflicts,
  };
}

function stringSet(value: unknown) {
  if (!Array.isArray(value)) return new Set<string>();
  return new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0));
}

async function workspaceOrganizationId(db: DbRef, workspaceId: string | null | undefined) {
  if (!workspaceId) return null;
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  return workspace?.organizationId ?? null;
}

async function enterpriseControlsForOrganization(db: DbRef, organizationId: string) {
  const records = await listAll(
    db.table<OrganizationEnterpriseControls>('organization_enterprise_controls').where(
      'organizationId',
      '==',
      organizationId,
    ),
  );
  if (records.length > 1) {
    throw new Error('Organization enterprise controls are not uniquely configured.');
  }
  return records[0] ?? null;
}

function malformedMcpGovernancePolicy(reason: string): never {
  throw new Error(`Organization MCP governance policy is malformed: ${reason}.`);
}

function isMcpPolicyIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

/**
 * Validates the security-relevant MCP governance structure without changing
 * the object. Unknown metadata is deliberately retained for forward-compatible
 * admin UI fields, while an ambiguous authority boundary always fails closed.
 */
export function assertValidMcpGovernancePolicy(
  value: unknown,
): asserts value is ValidMcpGovernancePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    malformedMcpGovernancePolicy('the policy must be an object');
  }
  const policy = value as Record<string, unknown>;
  if (!Array.isArray(policy.workspacePolicies)) {
    malformedMcpGovernancePolicy('workspacePolicies must be an array');
  }

  const workspaceIds = new Set<string>();
  for (const [workspaceIndex, candidate] of policy.workspacePolicies.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      malformedMcpGovernancePolicy(`workspacePolicies[${workspaceIndex}] must be an object`);
    }
    const workspacePolicy = candidate as Record<string, unknown>;
    if (!isMcpPolicyIdentifier(workspacePolicy.workspaceId)) {
      malformedMcpGovernancePolicy(`workspacePolicies[${workspaceIndex}].workspaceId must be a non-empty whitespace-free string`);
    }
    if (workspaceIds.has(workspacePolicy.workspaceId)) {
      malformedMcpGovernancePolicy(`workspaceId ${workspacePolicy.workspaceId} appears more than once`);
    }
    workspaceIds.add(workspacePolicy.workspaceId);
    if (typeof workspacePolicy.enabled !== 'boolean') {
      malformedMcpGovernancePolicy(`workspacePolicies[${workspaceIndex}].enabled must be a boolean`);
    }
    if (!Array.isArray(workspacePolicy.approvedClients)) {
      malformedMcpGovernancePolicy(`workspacePolicies[${workspaceIndex}].approvedClients must be an array`);
    }

    const clientIds = new Set<string>();
    for (const [clientIndex, approvedClient] of workspacePolicy.approvedClients.entries()) {
      if (!approvedClient || typeof approvedClient !== 'object' || Array.isArray(approvedClient)) {
        malformedMcpGovernancePolicy(
          `workspacePolicies[${workspaceIndex}].approvedClients[${clientIndex}] must be an object`,
        );
      }
      const clientId = (approvedClient as Record<string, unknown>).clientId;
      if (!isMcpPolicyIdentifier(clientId)) {
        malformedMcpGovernancePolicy(
          `workspacePolicies[${workspaceIndex}].approvedClients[${clientIndex}].clientId must be a non-empty whitespace-free string`,
        );
      }
      if (clientIds.has(clientId)) {
        malformedMcpGovernancePolicy(
          `clientId ${clientId} appears more than once in workspace ${workspacePolicy.workspaceId}`,
        );
      }
      clientIds.add(clientId);
    }
  }
}

function approvedMcpClientIds(policy: ValidMcpWorkspacePolicy) {
  return new Set(policy.approvedClients.map((entry) => entry.clientId));
}

function mcpWorkspacePolicy(policy: ValidMcpGovernancePolicy, workspaceId: string) {
  return policy.workspacePolicies.find((entry) => entry.workspaceId === workspaceId) ?? null;
}

/**
 * Organization MCP governance is an additional workspace authority boundary.
 * It never broadens a grant: scopes, workspace/resource allowlists, and the
 * user's current product access are still evaluated by their existing owners.
 */
export async function deniedMcpClientWorkspaces(
  db: DbRef,
  workspaces: McpGovernedWorkspace[],
  clientId: string,
) {
  const workspacesByOrganization = new Map<string, McpGovernedWorkspace[]>();
  for (const workspace of workspaces) {
    if (!workspace.organizationId) continue;
    const entries = workspacesByOrganization.get(workspace.organizationId) ?? [];
    entries.push(workspace);
    workspacesByOrganization.set(workspace.organizationId, entries);
  }
  const denied: Array<{ organizationId: string; workspaceId: string }> = [];
  for (const [organizationId, organizationWorkspaces] of workspacesByOrganization) {
    const controls = await enterpriseControlsForOrganization(db, organizationId);
    const policy = controls?.mcpGovernancePolicy;
    if (policy === null || policy === undefined) continue;
    assertValidMcpGovernancePolicy(policy);
    for (const workspace of organizationWorkspaces) {
      const workspacePolicy = mcpWorkspacePolicy(policy, workspace.id);
      if (
        workspacePolicy?.enabled === true
        && !approvedMcpClientIds(workspacePolicy).has(clientId)
      ) {
        denied.push({ organizationId, workspaceId: workspace.id });
      }
    }
  }
  return denied;
}

/**
 * Returns only the workspaces this client may currently use. Filtering is
 * deliberate: an account-level grant can span unrelated organizations, and a
 * workspace approval policy must never revoke access outside that workspace.
 */
export async function filterMcpClientApprovedWorkspaces<T extends McpGovernedWorkspace>(
  db: DbRef,
  workspaces: T[],
  clientId: string,
) {
  const denied = await deniedMcpClientWorkspaces(db, workspaces, clientId);
  if (!denied.length) return workspaces;
  const deniedIds = new Set(denied.map((entry) => entry.workspaceId));
  return workspaces.filter((workspace) => !deniedIds.has(workspace.id));
}

export async function assertMcpClientApprovedForWorkspaces(
  db: DbRef,
  workspaces: McpGovernedWorkspace[],
  context: McpClientGovernanceContext,
) {
  const denied = await deniedMcpClientWorkspaces(db, workspaces, context.clientId);
  if (!denied.length) return;
  const occurredAt = new Date().toISOString();
  await Promise.all(denied.map(({ organizationId, workspaceId }) =>
    db.table<OrganizationAuditEvent>('organization_audit_events').insert({
      organizationId,
      workspaceId,
      actorId: context.actorId ?? null,
      action: 'organization_mcp_governance.blocked_call',
      targetType: 'mcp_oauth_client',
      targetId: context.clientId,
      metadata: {
        clientId: context.clientId,
        clientName: context.clientName ?? null,
        grantId: context.grantId ?? null,
        stage: context.stage,
        workspaceId,
      },
      occurredAt,
    }),
  ));
  throw new Error('This MCP client is not approved for the selected workspace.');
}

export async function organizationDlpPolicyAllows(
  db: DbRef,
  workspaceId: string | null | undefined,
  key: string,
  fallback = true,
) {
  const organizationId = await workspaceOrganizationId(db, workspaceId);
  if (!organizationId) return fallback;
  const controls = await enterpriseControlsForOrganization(db, organizationId);
  const policy = controls?.dlpPolicy;
  if (!policy || policy.enabled !== true) return fallback;
  const blockKey = dlpBlockKeys[key];
  if (!blockKey) return fallback;
  return policy[blockKey] !== true;
}

export async function assertOrganizationDlpPolicy(
  db: DbRef,
  workspaceId: string | null | undefined,
  key: string,
  message: string,
  fallback = true,
) {
  if (await organizationDlpPolicyAllows(db, workspaceId, key, fallback)) return;
  throw new Error(message);
}

const ignoredContentKeys = new Set([
  'action',
  'id',
  'ids',
  'workspaceId',
  'pageId',
  'databaseId',
  'rowId',
  'parentId',
  'blockId',
  'commentId',
  'uploadId',
  'key',
  'token',
  'expectedUpdatedAt',
]);

function normalizedSensitiveText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function containsSensitiveTerm(value: unknown, terms: string[]) {
  const normalizedTerms = terms
    .map((term) => normalizedSensitiveText(term.trim()))
    .filter(Boolean);
  if (!normalizedTerms.length) return false;
  const seen = new Set<unknown>();
  let visited = 0;
  const scan = (candidate: unknown): boolean => {
    if (visited >= 10_000) return false;
    visited += 1;
    if (typeof candidate === 'string') {
      const text = normalizedSensitiveText(candidate.slice(0, 1_000_000));
      return normalizedTerms.some((term) => text.includes(term));
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(scan);
    return Object.entries(candidate as Record<string, unknown>)
      .some(([key, nested]) => !ignoredContentKeys.has(key) && scan(nested));
  };
  return scan(value);
}

async function mutationWorkspaceId(
  db: DbRef,
  value: Record<string, unknown>,
): Promise<string | null> {
  if (typeof value.workspaceId === 'string' && value.workspaceId) return value.workspaceId;
  const pageCandidates = [value.pageId, value.databaseId, value.rowId, value.parentId]
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  for (const pageId of pageCandidates) {
    const page = await getExisting(db.table<Page>('pages'), pageId);
    if (page?.workspaceId) return page.workspaceId;
  }
  const id = typeof value.id === 'string' ? value.id : null;
  if (id) {
    const page = await getExisting(db.table<Page>('pages'), id);
    if (page?.workspaceId) return page.workspaceId;
    for (const table of ['blocks', 'comments', 'file_uploads']) {
      const record = await getExisting(db.table<PageLinkedRecord>(table), id);
      if (record?.workspaceId) return record.workspaceId;
      if (record?.pageId) {
        const linkedPage = await getExisting(db.table<Page>('pages'), record.pageId);
        if (linkedPage?.workspaceId) return linkedPage.workspaceId;
      }
    }
  }
  const nestedCollections = [value.blocks, value.updates];
  for (const collection of nestedCollections) {
    if (!Array.isArray(collection)) continue;
    const item = collection.find((entry) => entry && typeof entry === 'object') as Record<string, unknown> | undefined;
    if (item) {
      const workspaceId: string | null = await mutationWorkspaceId(db, item);
      if (workspaceId) return workspaceId;
    }
  }
  return null;
}

export async function assertOrganizationDlpContent(
  db: DbRef,
  mutation: Record<string, unknown>,
) {
  const workspaceId = await mutationWorkspaceId(db, mutation);
  if (!workspaceId) return;
  const organizationId = await workspaceOrganizationId(db, workspaceId);
  if (!organizationId) return;
  const controls = await enterpriseControlsForOrganization(db, organizationId);
  const policy = controls?.dlpPolicy;
  if (!policy || policy.enabled !== true) return;
  const mode = typeof policy.contentScanMode === 'string' ? policy.contentScanMode : 'block';
  if (mode !== 'block') return;
  const terms = Array.isArray(policy.sensitiveTerms)
    ? policy.sensitiveTerms.filter((term): term is string => typeof term === 'string')
    : [];
  if (!containsSensitiveTerm(mutation, terms)) return;
  throw new Error('Content is blocked by organization DLP policy because it matches a sensitive term.');
}

function legalHoldAppliesToPages(
  hold: OrganizationLegalHold,
  workspaceId: string,
  pageIds: string[],
  custodianUserIds: string[],
) {
  const scope = hold.scope ?? {};
  if (scope.all === true || Object.keys(scope).length === 0) return true;

  const workspaceIds = stringSet(scope.workspaceIds);
  if (workspaceIds.size > 0 && workspaceIds.has(workspaceId)) return true;

  const scopedPageIds = stringSet(scope.pageIds);
  if (scopedPageIds.size > 0 && pageIds.some((pageId) => scopedPageIds.has(pageId))) return true;

  const scopedUserIds = stringSet(scope.userIds);
  if (scopedUserIds.size > 0 && custodianUserIds.some((userId) => scopedUserIds.has(userId))) return true;

  return false;
}

export async function assertNoActiveLegalHoldForPermanentDelete(
  db: DbRef,
  workspaceId: string | null | undefined,
  pageIds: string[],
  custodianUserIds: string[] = [],
) {
  if (!workspaceId || pageIds.length === 0) return;
  const organizationId = await workspaceOrganizationId(db, workspaceId);
  if (!organizationId) return;
  const holds = await listAll(
    db.table<OrganizationLegalHold>('organization_legal_holds').where(
      'organizationId',
      '==',
      organizationId,
    ),
  );
  const blockingHold = holds.find(
    (hold) =>
      (hold.status ?? 'active') === 'active' &&
      legalHoldAppliesToPages(hold, workspaceId, pageIds, custodianUserIds),
  );
  if (!blockingHold) return;
  throw new Error(`Active legal hold prevents permanent deletion: ${blockingHold.name}`);
}
