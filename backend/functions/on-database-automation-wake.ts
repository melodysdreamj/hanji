import { defineFunction } from '@edge-base/shared';

import { enqueueDatabaseAutomationWorkspaceWake } from '../lib/database-automation-routing';
import { bestEffort } from '../lib/table-utils';
import type { AdminDbAccessor } from '../lib/workspace-db';

interface AutomationWakeRow {
  workspaceId?: string;
  triggerType?: string;
  enabled?: boolean;
  status?: string;
  revision?: number;
  nextRunAt?: string | null;
}

interface AutomationWakeContext {
  admin: AdminDbAccessor;
  data?: {
    before?: AutomationWakeRow | null;
    after?: AutomationWakeRow | null;
  };
}

function isSchedule(row: AutomationWakeRow | null | undefined) {
  return row?.triggerType === 'schedule';
}

function isSchedulerAdvance(
  before: AutomationWakeRow | null | undefined,
  after: AutomationWakeRow | null | undefined,
) {
  if (!isSchedule(before) || !isSchedule(after)) return false;
  const previous = typeof before?.nextRunAt === 'string' ? Date.parse(before.nextRunAt) : Number.NaN;
  const next = typeof after?.nextRunAt === 'string' ? Date.parse(after.nextRunAt) : Number.NaN;
  return before?.workspaceId === after?.workspaceId
    && before?.revision === after?.revision
    && before?.enabled === true
    && after?.enabled === true
    && before?.status === 'active'
    && after?.status === 'active'
    && Number.isFinite(previous)
    && Number.isFinite(next)
    && next > previous;
}

async function routeAutomationWake(rawContext: unknown, label: string) {
  const context = rawContext as AutomationWakeContext;
  const before = context.data?.before;
  const after = context.data?.after;
  if (!isSchedule(before) && !isSchedule(after)) return;
  // The minute worker already owns the central generation and settles one
  // aggregated deadline after advancing every admitted definition. Per-row
  // advancement triggers would otherwise turn one 8-row batch into 8 central
  // reads/writes and can supersede the worker's exact final settlement.
  if (isSchedulerAdvance(before, after)) return;
  const row = after ?? before;
  if (!row?.workspaceId) return;
  const dueAt = isSchedule(after)
    && after?.enabled === true
    && after.status === 'active'
    && typeof after.nextRunAt === 'string'
    ? after.nextRunAt
    : new Date().toISOString();
  await bestEffort(label, enqueueDatabaseAutomationWorkspaceWake(
    context.admin,
    row.workspaceId,
    dueAt,
  ));
}

export const onDatabaseAutomationInsertForWake = defineFunction({
  trigger: { type: 'db', table: 'database_automations', event: 'insert' },
  handler: async (context) => routeAutomationWake(
    context,
    'database automation wake insert',
  ),
});

export const onDatabaseAutomationUpdateForWake = defineFunction({
  trigger: { type: 'db', table: 'database_automations', event: 'update' },
  handler: async (context) => routeAutomationWake(
    context,
    'database automation wake update',
  ),
});

export const onDatabaseAutomationDeleteForWake = defineFunction({
  trigger: { type: 'db', table: 'database_automations', event: 'delete' },
  handler: async (context) => routeAutomationWake(
    context,
    'database automation wake delete',
  ),
});
