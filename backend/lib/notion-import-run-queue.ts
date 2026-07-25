import type { DbRef } from './app-types';
import { getExisting, isNotFoundError, newId } from './table-utils';

export const NOTION_IMPORT_RUN_QUEUE_TABLE = 'notion_import_run_queue';
export const NOTION_IMPORT_RUN_QUEUE_CANDIDATE_LIMIT = 24;
export const NOTION_IMPORT_RUN_STALE_RECOVERY_LIMIT = 8;
export const NOTION_IMPORT_RUN_MAX_CHUNKS_PER_TICK = 4;
// One heavy Notion graph chunk at a time per appliance process. Cross-job
// fairness comes from rotating the settled dueAt; product writes remain
// independently fenced by each workspace job lease.
export const NOTION_IMPORT_RUN_CONCURRENCY = 1;
export const NOTION_IMPORT_RUN_TICK_DEADLINE_MS = 25_000;
export const NOTION_IMPORT_RUN_LEASE_TTL_MS = 2 * 60 * 1000;
export const NOTION_IMPORT_RUN_ORPHAN_RECHECK_MS = 60_000;
export const NOTION_IMPORT_RUN_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface NotionImportRunQueueRecord {
  id: string;
  jobId: string;
  workspaceId: string;
  actorId: string;
  state: 'pending' | 'leased';
  dueAt: string;
  leaseId?: string | null;
  leaseExpiresAt?: string | null;
  attempts?: number;
  missingJobChecks?: number;
  lastStartedAt?: string | null;
  lastSettledAt?: string | null;
  lastErrorCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotionImportRunQueueLease extends NotionImportRunQueueRecord {
  state: 'leased';
  leaseId: string;
  leaseExpiresAt: string;
}

export type NotionImportRunChunkOutcome =
  | { action: 'terminal'; errorCode?: string }
  | {
      action: 'continue';
      notBeforeMs?: number;
      errorCode?: string;
      missingJob?: boolean;
    };

interface OrderedQueueQuery<T> {
  where?(field: string, op: string, value: unknown): OrderedQueueQuery<T>;
  orderBy?(field: string, direction: 'asc' | 'desc'): OrderedQueueQuery<T>;
  page(n: number): OrderedQueueQuery<T>;
  limit(n: number): OrderedQueueQuery<T>;
  getList(): Promise<{ items?: T[]; hasMore?: boolean }>;
}

function queueTable(db: DbRef) {
  return db.table<NotionImportRunQueueRecord>(NOTION_IMPORT_RUN_QUEUE_TABLE);
}

function isQueueCasConflict(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; status?: unknown; message?: unknown };
  if (record.code === 409 || record.status === 409) return true;
  return typeof record.message === 'string' && (
    record.message.includes('Transaction expectation failed')
    || record.message.includes('already exists')
  );
}

function safeQueueErrorCode(value: unknown, fallback = 'worker_error') {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(value)
    ? value
    : fallback;
}

function asOrderedQuery<T>(query: unknown): OrderedQueueQuery<T> {
  return query as OrderedQueueQuery<T>;
}

async function boundedQueueCandidates(
  db: DbRef,
  state: NotionImportRunQueueRecord['state'],
  timeField: 'dueAt' | 'leaseExpiresAt',
  atIso: string,
  limit: number,
) {
  const table = queueTable(db);
  let query = asOrderedQuery<NotionImportRunQueueRecord>(table.where('state', '==', state));
  if (typeof query.where === 'function') query = query.where(timeField, '<=', atIso);
  if (typeof query.orderBy === 'function') query = query.orderBy(timeField, 'asc');
  const result = await query.page(1).limit(limit).getList();
  return (result.items ?? [])
    .filter((row) => row.state === state && typeof row[timeField] === 'string' && row[timeField]! <= atIso)
    .sort((left, right) => {
      const timeDelta = String(left[timeField] ?? '').localeCompare(String(right[timeField] ?? ''));
      if (timeDelta !== 0) return timeDelta;
      const startedDelta = String(left.lastStartedAt ?? '').localeCompare(String(right.lastStartedAt ?? ''));
      if (startedDelta !== 0) return startedDelta;
      return left.id.localeCompare(right.id);
    });
}

/**
 * The central row is written before the workspace job. That ordering means a
 * committed server-owned job can never exist without a durable continuation;
 * a crash between the writes leaves only a harmless orphan row, which the
 * scheduled worker rechecks before retiring.
 */
export async function enqueueNotionImportRun(
  db: DbRef,
  input: {
    jobId: string;
    workspaceId: string;
    actorId: string;
    dueAt?: string;
  },
) {
  const table = queueTable(db);
  const existing = await getExisting(table, input.jobId);
  if (existing) {
    if (
      existing.jobId !== input.jobId
      || existing.workspaceId !== input.workspaceId
      || existing.actorId !== input.actorId
    ) {
      throw new Error('Notion import run queue identity does not match the existing record.');
    }
    return existing;
  }

  const dueAt = input.dueAt ?? new Date().toISOString();
  try {
    return await table.insert({
      id: input.jobId,
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      state: 'pending',
      dueAt,
      leaseId: null,
      leaseExpiresAt: null,
      attempts: 0,
      missingJobChecks: 0,
      lastErrorCode: null,
    });
  } catch (error) {
    if (!isQueueCasConflict(error)) throw error;
    const raced = await getExisting(table, input.jobId);
    if (
      raced
      && raced.jobId === input.jobId
      && raced.workspaceId === input.workspaceId
      && raced.actorId === input.actorId
    ) return raced;
    throw error;
  }
}

export async function deleteNotionImportRun(db: DbRef, jobId: string) {
  try {
    await queueTable(db).delete(jobId);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export async function recoverStaleNotionImportRunLeases(
  db: DbRef,
  options: { nowMs?: number; limit?: number } = {},
) {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const candidates = await boundedQueueCandidates(
    db,
    'leased',
    'leaseExpiresAt',
    now,
    options.limit ?? NOTION_IMPORT_RUN_STALE_RECOVERY_LIMIT,
  );
  let recovered = 0;
  for (const candidate of candidates) {
    if (!candidate.leaseId || !candidate.leaseExpiresAt) continue;
    try {
      await db.transact([
        {
          table: NOTION_IMPORT_RUN_QUEUE_TABLE,
          op: 'expect',
          id: candidate.id,
          where: [
            ['state', '==', 'leased'],
            ['leaseId', '==', candidate.leaseId],
            ['leaseExpiresAt', '==', candidate.leaseExpiresAt],
          ],
          exists: true,
        },
        {
          table: NOTION_IMPORT_RUN_QUEUE_TABLE,
          op: 'update',
          id: candidate.id,
          data: {
            state: 'pending',
            dueAt: now,
            leaseId: null,
            leaseExpiresAt: null,
            lastSettledAt: now,
            lastErrorCode: 'stale_lease_recovered',
          },
        },
      ]);
      recovered += 1;
    } catch (error) {
      if (!isQueueCasConflict(error)) throw error;
    }
  }
  return recovered;
}

export async function acquireNextNotionImportRunLease(
  db: DbRef,
  options: {
    nowMs?: number;
    candidateLimit?: number;
    leaseTtlMs?: number;
  } = {},
): Promise<NotionImportRunQueueLease | null> {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const candidates = await boundedQueueCandidates(
    db,
    'pending',
    'dueAt',
    now,
    options.candidateLimit ?? NOTION_IMPORT_RUN_QUEUE_CANDIDATE_LIMIT,
  );
  for (const candidate of candidates) {
    const leaseId = newId();
    const leaseExpiresAt = new Date(
      nowMs + (options.leaseTtlMs ?? NOTION_IMPORT_RUN_LEASE_TTL_MS),
    ).toISOString();
    const attempts = Math.max(0, Number(candidate.attempts) || 0) + 1;
    try {
      await db.transact([
        {
          table: NOTION_IMPORT_RUN_QUEUE_TABLE,
          op: 'expect',
          id: candidate.id,
          where: [
            ['state', '==', 'pending'],
            ['dueAt', '==', candidate.dueAt],
          ],
          exists: true,
        },
        {
          table: NOTION_IMPORT_RUN_QUEUE_TABLE,
          op: 'update',
          id: candidate.id,
          data: {
            state: 'leased',
            leaseId,
            leaseExpiresAt,
            attempts,
            lastStartedAt: now,
          },
        },
      ]);
      return {
        ...candidate,
        state: 'leased',
        leaseId,
        leaseExpiresAt,
        attempts,
        lastStartedAt: now,
      };
    } catch (error) {
      if (!isQueueCasConflict(error)) throw error;
    }
  }
  return null;
}

export async function settleNotionImportRunLease(
  db: DbRef,
  lease: NotionImportRunQueueLease,
  outcome: NotionImportRunChunkOutcome,
  nowMs = Date.now(),
) {
  const now = new Date(nowMs).toISOString();
  const expectation = {
    table: NOTION_IMPORT_RUN_QUEUE_TABLE,
    op: 'expect' as const,
    id: lease.id,
    where: [
      ['state', '==', 'leased'] as [string, '==', unknown],
      ['leaseId', '==', lease.leaseId] as [string, '==', unknown],
    ],
    exists: true,
  };
  if (outcome.action === 'terminal') {
    await db.transact([
      expectation,
      { table: NOTION_IMPORT_RUN_QUEUE_TABLE, op: 'delete', id: lease.id },
    ]);
    return;
  }

  const dueAt = new Date(Math.max(nowMs, outcome.notBeforeMs ?? nowMs)).toISOString();
  await db.transact([
    expectation,
    {
      table: NOTION_IMPORT_RUN_QUEUE_TABLE,
      op: 'update',
      id: lease.id,
      data: {
        state: 'pending',
        dueAt,
        leaseId: null,
        leaseExpiresAt: null,
        lastSettledAt: now,
        lastErrorCode: outcome.errorCode
          ? safeQueueErrorCode(outcome.errorCode)
          : null,
        missingJobChecks: outcome.missingJob
          ? Math.max(0, Number(lease.missingJobChecks) || 0) + 1
          : 0,
      },
    },
  ]);
}

export async function drainNotionImportRunQueue(
  db: DbRef,
  execute: (
    lease: NotionImportRunQueueLease,
  ) => Promise<NotionImportRunChunkOutcome>,
  options: {
    now?: () => number;
    maxChunks?: number;
    deadlineMs?: number;
    candidateLimit?: number;
    staleRecoveryLimit?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const maxChunks = options.maxChunks ?? NOTION_IMPORT_RUN_MAX_CHUNKS_PER_TICK;
  const deadlineMs = options.deadlineMs ?? NOTION_IMPORT_RUN_TICK_DEADLINE_MS;
  const recovered = await recoverStaleNotionImportRunLeases(db, {
    nowMs: startedAt,
    limit: options.staleRecoveryLimit,
  });
  let processed = 0;
  let terminal = 0;
  let continued = 0;
  let failed = 0;

  for (let index = 0; index < maxChunks; index += 1) {
    if (processed > 0 && now() - startedAt >= deadlineMs) break;
    const lease = await acquireNextNotionImportRunLease(db, {
      nowMs: now(),
      candidateLimit: options.candidateLimit,
    });
    if (!lease) break;
    processed += 1;
    let outcome: NotionImportRunChunkOutcome;
    try {
      outcome = await execute(lease);
    } catch {
      // Never persist or log an arbitrary exception message: it may originate
      // in an upstream credential-bearing transport. The durable job owns any
      // user-safe error; the central queue stores only this bounded code.
      failed += 1;
      outcome = {
        action: 'continue',
        notBeforeMs: now() + 5_000,
        errorCode: 'chunk_exception',
      };
    }
    try {
      await settleNotionImportRunLease(db, lease, outcome, now());
      if (outcome.action === 'terminal') terminal += 1;
      else continued += 1;
    } catch (error) {
      // Settlement response loss is intentionally recoverable: leave the
      // exact leased row in place. A later tick reclaims it after the bounded
      // lease, and the workspace job cursor makes the chunk replay-safe. One
      // row's settlement failure must not prevent safe independent rows from
      // reaching a terminal result in this bounded pass.
      if (!isQueueCasConflict(error)) failed += 1;
    }
  }

  return { recovered, processed, terminal, continued, failed };
}
