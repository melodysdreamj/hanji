import { defineFunction } from '@edge-base/shared';

import type { FunctionContext } from '../lib/app-types';
import { processDatabaseAutomationEventPass } from '../lib/database-automation-evaluator';
import { boundedDbFromWorkspaceHint } from '../lib/workspace-db';

const WINDOW_MS = 3_000;
const MAX_TRIGGER_DRAIN_PASSES = 16;

type DatabaseTriggerContext = FunctionContext & {
  trigger?: {
    namespace: string;
    id?: string;
    table?: string;
    event?: 'insert' | 'update' | 'delete';
  };
  data?: { after?: Record<string, unknown> };
  after?: Record<string, unknown>;
};

export const ON_DATABASE_AUTOMATION_EVENT_INSERT = defineFunction({
  trigger: { type: 'db', table: 'database_automation_events', event: 'insert' },
  handler: async (rawContext) => {
    const context = rawContext as DatabaseTriggerContext;
    const workspaceId = context.trigger?.namespace === 'workspace'
      ? context.trigger.id
      : undefined;
    if (!workspaceId) throw new Error('Database automation event trigger requires a workspace route.');
    const after = context.data?.after ?? context.after;
    const occurredAt = typeof after?.occurredAt === 'string'
      ? Date.parse(after.occurredAt)
      : Date.now();
    const delay = Math.max(0, Math.min(WINDOW_MS + 25, occurredAt + WINDOW_MS + 25 - Date.now()));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    const db = boundedDbFromWorkspaceHint(context.admin, workspaceId);
    try {
      for (let pass = 0; pass < MAX_TRIGGER_DRAIN_PASSES; pass += 1) {
        const result = await processDatabaseAutomationEventPass(db, workspaceId);
        if (result.busy || !result.hasMore) break;
      }
    } catch (error) {
      // A delayed best-effort trigger can outlive permanent workspace cleanup.
      // The durable queue was removed by that cleanup, so there is no work to
      // retry and the missing workspace is a terminal, successful no-op.
      if (error instanceof Error && error.message === 'Workspace was not found.') return;
      throw error;
    }
  },
});
