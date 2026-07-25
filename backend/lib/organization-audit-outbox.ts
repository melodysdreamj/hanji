import type { DbRef } from './app-types';

const ORGANIZATION_AUDIT_BATCH_SIZE = 25;
const ORGANIZATION_AUDIT_BATCHES_PER_TRIGGER = 4;

export interface OrganizationAuditOutboxRecord {
  id: string;
  workspaceId: string;
  organizationId: string;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
  attempts?: number;
  lastError?: string | null;
}

interface OrganizationAuditFlushResult {
  delivered: string[];
  failures: Array<{ id: string; message: string }>;
  hasMore: boolean;
  processedBatches: number;
}

async function readAuditBatch(
  contentDb: DbRef,
  workspaceId: string,
) {
  const query = contentDb
    .table<OrganizationAuditOutboxRecord>('organization_audit_outbox')
    .where('workspaceId', '==', workspaceId);
  if (typeof query.orderBy !== 'function') {
    throw new Error('Organization audit delivery requires stable indexed ordering.');
  }
  const result = await query
    .orderBy('id', 'asc')
    .limit(ORGANIZATION_AUDIT_BATCH_SIZE + 1)
    .getList();
  const candidates = result.items ?? [];
  return {
    records: candidates.slice(0, ORGANIZATION_AUDIT_BATCH_SIZE),
    hasMore:
      candidates.length > ORGANIZATION_AUDIT_BATCH_SIZE
      || result.hasMore === true,
  };
}

function centralEvent(record: OrganizationAuditOutboxRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    workspaceId: record.workspaceId,
    actorId: record.actorId ?? null,
    action: record.action,
    targetType: record.targetType ?? null,
    targetId: record.targetId ?? null,
    metadata: record.metadata ?? null,
    occurredAt: record.occurredAt,
  };
}

async function recordBatchFailure(
  contentDb: DbRef,
  records: OrganizationAuditOutboxRecord[],
  message: string,
) {
  try {
    await contentDb.transact(records.map((record) => ({
      table: 'organization_audit_outbox',
      op: 'update' as const,
      id: record.id,
      data: {
        attempts: (record.attempts ?? 0) + 1,
        lastError: message.slice(0, 1000),
      },
    })));
  } catch {
    // The durable rows remain available to the claimed maintenance retry even
    // when best-effort diagnostic bookkeeping cannot be collected.
  }
}

export async function flushOrganizationAuditOutbox(
  contentDb: DbRef,
  centralDb: DbRef,
  workspaceId: string,
): Promise<OrganizationAuditFlushResult> {
  const delivered: string[] = [];
  const failures: Array<{ id: string; message: string }> = [];
  let hasMore = false;
  let processedBatches = 0;

  for (
    let batchIndex = 0;
    batchIndex < ORGANIZATION_AUDIT_BATCHES_PER_TRIGGER;
    batchIndex += 1
  ) {
    const batch = await readAuditBatch(contentDb, workspaceId);
    if (batch.records.length === 0) {
      hasMore = false;
      break;
    }
    processedBatches += 1;
    hasMore = batch.hasMore;

    try {
      const ids = batch.records.map((record) => record.id);
      const existingResult = await centralDb
        .table<OrganizationAuditOutboxRecord>('organization_audit_events')
        .where('id', 'in', ids)
        .limit(ids.length)
        .getList();
      const existingIds = new Set(
        (existingResult.items ?? []).map((record) => record.id),
      );
      const missing = batch.records.filter((record) => !existingIds.has(record.id));
      if (missing.length > 0) {
        await centralDb.transact(missing.map((record) => ({
          table: 'organization_audit_events',
          op: 'insert' as const,
          data: centralEvent(record),
        })));
      }
      await contentDb.transact(batch.records.map((record) => ({
        table: 'organization_audit_outbox',
        op: 'delete' as const,
        id: record.id,
      })));
      delivered.push(...ids);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(...batch.records.map((record) => ({ id: record.id, message })));
      await recordBatchFailure(contentDb, batch.records, message);
      hasMore = true;
      break;
    }

    if (!batch.hasMore) break;
  }

  return { delivered, failures, hasMore, processedBatches };
}
