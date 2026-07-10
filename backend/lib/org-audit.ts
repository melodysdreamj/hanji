import { bestEffort, getExisting, nowIso } from './table-utils';

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
}

interface Workspace {
  id: string;
  organizationId?: string | null;
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

export async function recordOrganizationAudit(
  db: DbRef,
  event: Omit<OrganizationAuditEvent, 'id'>,
) {
  return bestEffort(
    `organization audit event ${event.action}`,
    db.table<OrganizationAuditEvent>('organization_audit_events').insert(event),
  );
}

export async function recordWorkspaceAudit(
  db: DbRef,
  options: {
    workspaceId: string | null | undefined;
    actorId?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown> | null;
    occurredAt?: string;
  },
) {
  if (!options.workspaceId) return;
  const workspace = await getExisting(db.table<Workspace>('workspaces'), options.workspaceId);
  if (!workspace?.organizationId) return;
  await recordOrganizationAudit(db, {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    actorId: options.actorId ?? null,
    action: options.action,
    targetType: options.targetType ?? null,
    targetId: options.targetId ?? null,
    metadata: options.metadata ?? null,
    occurredAt: options.occurredAt ?? nowIso(),
  });
}
