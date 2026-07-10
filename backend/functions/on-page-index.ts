// DB trigger: keep the central page → workspace routing index in lockstep
// with the pages table (docs/workspace-do-migration.md). Fires on every page
// insert/delete regardless of which surface wrote it (functions, MCP,
// import), on both the legacy single block and the post-split workspace DOs,
// so pageId-only entry points can resolve their workspace with one central
// point read after the flip. Index rows use the page id as their own id.
import { defineFunction } from '@edge-base/shared';
import { bestEffort } from '../lib/table-utils';

interface TriggerContext {
  data?: {
    after?: { id?: string; workspaceId?: string } | null;
    before?: { id?: string } | null;
  };
  trigger?: { event?: string };
  admin: { db(namespace: string): { table<T>(name: string): {
    insert(data: Partial<T>): Promise<T>;
    update(id: string, data: Partial<T>): Promise<T>;
    delete(id: string): Promise<void>;
    getOne(id: string): Promise<T | null>;
  } } };
}

interface PageWorkspaceIndex {
  id: string;
  workspaceId: string;
}

async function upsertIndex(ctx: TriggerContext, pageId: string, workspaceId: string) {
  const table = ctx.admin.db('app').table<PageWorkspaceIndex>('page_workspace_index');
  const existing = await table.getOne(pageId).catch(() => null);
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      await table.update(pageId, { workspaceId });
    }
    return;
  }
  await table.insert({ id: pageId, workspaceId });
}

export const onPageInsert = defineFunction({
  trigger: { type: 'db', table: 'pages', event: 'insert' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    const after = ctx.data?.after;
    if (!after?.id || !after.workspaceId) return;
    await bestEffort(
      'page_workspace_index upsert',
      upsertIndex(ctx, after.id, after.workspaceId),
    );
  },
});

// Upsert-shaped writes can surface as `update` events (INSERT .. ON CONFLICT
// classifies as update when the row pre-exists), so the update event also
// maintains the index — id/workspaceId never change after creation.
export const onPageUpdate = defineFunction({
  trigger: { type: 'db', table: 'pages', event: 'update' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    const after = ctx.data?.after;
    if (!after?.id || !after.workspaceId) return;
    await bestEffort(
      'page_workspace_index upsert(update)',
      upsertIndex(ctx, after.id, after.workspaceId),
    );
  },
});

export const onPageDelete = defineFunction({
  trigger: { type: 'db', table: 'pages', event: 'delete' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    const before = ctx.data?.before;
    if (!before?.id) return;
    await bestEffort(
      'page_workspace_index delete',
      ctx.admin.db('app').table<PageWorkspaceIndex>('page_workspace_index').delete(before.id),
    );
  },
});
