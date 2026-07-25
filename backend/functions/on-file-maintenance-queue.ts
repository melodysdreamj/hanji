import { defineFunction } from '@edge-base/shared';
import { enqueueWorkspaceFileMaintenance } from '../lib/file-maintenance-routing';
import { bestEffort } from '../lib/table-utils';

interface MaintenanceTriggerRow {
  workspaceId?: string;
  fileCleanupStatus?: string | null;
  status?: string | null;
  recoveryData?: unknown;
}

interface TriggerContext {
  data?: { after?: MaintenanceTriggerRow | null };
  admin: Parameters<typeof enqueueWorkspaceFileMaintenance>[0];
}

async function enqueue(context: unknown, label: string, predicate = () => true) {
  const ctx = context as TriggerContext;
  const row = ctx.data?.after;
  if (!row?.workspaceId || !predicate()) return;
  await bestEffort(label, enqueueWorkspaceFileMaintenance(ctx.admin, row.workspaceId));
}

export const onFileUploadInsertForMaintenance = defineFunction({
  trigger: { type: 'db', table: 'file_uploads', event: 'insert' },
  handler: async (context) => enqueue(context, 'file-maintenance queue file_uploads insert'),
});

export const onFileUploadUpdateForMaintenance = defineFunction({
  trigger: { type: 'db', table: 'file_uploads', event: 'update' },
  handler: async (context) => enqueue(context, 'file-maintenance queue file_uploads update'),
});

export const onFileWorkspaceLockInsertForMaintenance = defineFunction({
  trigger: { type: 'db', table: 'file_workspace_locks', event: 'insert' },
  handler: async (context) => enqueue(
    context,
    'file-maintenance queue lock insert',
    () => Boolean((context as TriggerContext).data?.after?.recoveryData),
  ),
});

export const onFileWorkspaceLockUpdateForMaintenance = defineFunction({
  trigger: { type: 'db', table: 'file_workspace_locks', event: 'update' },
  handler: async (context) => enqueue(
    context,
    'file-maintenance queue lock update',
    () => Boolean((context as TriggerContext).data?.after?.recoveryData),
  ),
});

function terminalCleanupPending(context: unknown) {
  const row = (context as TriggerContext).data?.after;
  return row?.fileCleanupStatus === 'pending'
    && (row.status === 'failed' || row.status === 'cancelled');
}

export const onNotionImportJobInsertForMaintenance = defineFunction({
  trigger: { type: 'db', table: 'notion_import_jobs', event: 'insert' },
  handler: async (context) => enqueue(
    context,
    'file-maintenance queue notion_import_jobs insert',
    () => terminalCleanupPending(context),
  ),
});

export const onNotionImportJobUpdateForMaintenance = defineFunction({
  trigger: { type: 'db', table: 'notion_import_jobs', event: 'update' },
  handler: async (context) => enqueue(
    context,
    'file-maintenance queue notion_import_jobs update',
    () => terminalCleanupPending(context),
  ),
});

export const onOrganizationAuditOutboxInsertForMaintenance = defineFunction({
  trigger: { type: 'db', table: 'organization_audit_outbox', event: 'insert' },
  handler: async (context) => enqueue(context, 'file-maintenance queue audit outbox insert'),
});
