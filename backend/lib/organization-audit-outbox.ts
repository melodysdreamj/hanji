import { getExisting, listAll } from './table-utils';
import type { DbRef } from './app-types';

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

export async function flushOrganizationAuditOutbox(
  contentDb: DbRef,
  centralDb: DbRef,
  workspaceId: string,
) {
  const outbox = contentDb.table<OrganizationAuditOutboxRecord>('organization_audit_outbox');
  const events = centralDb.table<OrganizationAuditOutboxRecord>('organization_audit_events');
  const pending = await listAll(outbox.where('workspaceId', '==', workspaceId));
  const delivered: string[] = [];
  const failures: Array<{ id: string; message: string }> = [];
  for (const record of pending) {
    try {
      const existing = await getExisting(events, record.id);
      if (!existing) {
        await events.insert({
          id: record.id,
          organizationId: record.organizationId,
          workspaceId: record.workspaceId,
          actorId: record.actorId ?? null,
          action: record.action,
          targetType: record.targetType ?? null,
          targetId: record.targetId ?? null,
          metadata: record.metadata ?? null,
          occurredAt: record.occurredAt,
        });
      }
      await outbox.delete(record.id);
      delivered.push(record.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: record.id, message });
      try {
        await outbox.update(record.id, {
          attempts: (record.attempts ?? 0) + 1,
          lastError: message.slice(0, 1000),
        });
      } catch {
        // The durable row still exists even if diagnostic bookkeeping fails.
      }
    }
  }
  return { delivered, failures };
}
