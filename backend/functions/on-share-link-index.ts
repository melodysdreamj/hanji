// DB trigger: mirror share_links rows into the central share_link_index so
// unauthenticated /share/<token> requests can find the owning workspace after
// the split (docs/workspace-do-migration.md). The index is routing-only: the
// authoritative enabled/isPublic checks still run on the workspace-block row,
// so a stale or missing index entry fails closed (404), never open.
import { defineFunction } from '@edge-base/shared';
import { bestEffort, type TableQuery } from '../lib/table-utils';

interface ShareLinkRow {
  id: string;
  token?: string;
  workspaceId?: string;
  pageId?: string;
  enabled?: boolean;
}

interface ShareLinkIndexRow {
  id: string;
  token: string;
  workspaceId: string;
  pageId: string;
  enabled?: boolean;
}

interface IndexTable {
  insert(data: Partial<ShareLinkIndexRow>): Promise<ShareLinkIndexRow>;
  update(id: string, data: Partial<ShareLinkIndexRow>): Promise<ShareLinkIndexRow>;
  delete(id: string): Promise<void>;
  getOne(id: string): Promise<ShareLinkIndexRow | null>;
  where(field: string, op: string, value: unknown): TableQuery<ShareLinkIndexRow>;
}

interface TriggerContext {
  data?: {
    after?: ShareLinkRow | null;
    before?: ShareLinkRow | null;
  };
  admin: { db(namespace: string): { table(name: string): unknown } };
}

function indexTable(ctx: TriggerContext): IndexTable {
  return ctx.admin.db('app').table('share_link_index') as IndexTable;
}

async function upsert(ctx: TriggerContext, link: ShareLinkRow) {
  if (!link.id || !link.token || !link.workspaceId || !link.pageId) return;
  const table = indexTable(ctx);
  const existing = await table.getOne(link.id).catch(() => null);
  const data = {
    token: link.token,
    workspaceId: link.workspaceId,
    pageId: link.pageId,
    enabled: link.enabled === true,
  };
  if (existing) {
    await table.update(link.id, data);
  } else {
    await table.insert({ id: link.id, ...data });
  }
}

export const onShareLinkInsert = defineFunction({
  trigger: { type: 'db', table: 'share_links', event: 'insert' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    if (!ctx.data?.after) return;
    await bestEffort('share_link_index upsert(insert)', upsert(ctx, ctx.data.after));
  },
});

export const onShareLinkUpdate = defineFunction({
  trigger: { type: 'db', table: 'share_links', event: 'update' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    if (!ctx.data?.after) return;
    await bestEffort('share_link_index upsert(update)', upsert(ctx, ctx.data.after));
  },
});

export const onShareLinkDelete = defineFunction({
  trigger: { type: 'db', table: 'share_links', event: 'delete' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    const before = ctx.data?.before;
    if (!before?.id) return;
    await bestEffort(
      'share_link_index delete',
      indexTable(ctx).delete(before.id),
    );
  },
});
