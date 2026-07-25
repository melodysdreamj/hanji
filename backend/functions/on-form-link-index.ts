// DB trigger safety net for the routing-only form_link_index. Foreground
// configure calls also confirm this row synchronously before returning a URL.
import { defineFunction } from '@edge-base/shared';
import { bestEffort } from '../lib/table-utils';

interface FormLinkRow {
  id: string;
  token?: string;
  workspaceId?: string;
  databaseId?: string;
  viewId?: string;
  enabled?: boolean;
}

interface FormLinkIndexRow {
  id: string;
  token: string;
  workspaceId: string;
  databaseId: string;
  viewId: string;
  enabled?: boolean;
}

interface IndexTable {
  insert(data: Partial<FormLinkIndexRow>): Promise<FormLinkIndexRow>;
  update(id: string, data: Partial<FormLinkIndexRow>): Promise<FormLinkIndexRow>;
  delete(id: string): Promise<void>;
  getOne(id: string): Promise<FormLinkIndexRow | null>;
}

interface TriggerContext {
  data?: { after?: FormLinkRow | null; before?: FormLinkRow | null };
  admin: { db(namespace: string): { table(name: string): unknown } };
}

function indexTable(context: TriggerContext) {
  return context.admin.db('app').table('form_link_index') as IndexTable;
}

async function upsert(context: TriggerContext, link: FormLinkRow) {
  if (!link.id || !link.token || !link.workspaceId || !link.databaseId || !link.viewId) return;
  const table = indexTable(context);
  const data = {
    token: link.token,
    workspaceId: link.workspaceId,
    databaseId: link.databaseId,
    viewId: link.viewId,
    enabled: link.enabled === true,
  };
  const existing = await table.getOne(link.id).catch(() => null);
  if (existing) await table.update(link.id, data);
  else await table.insert({ id: link.id, ...data });
}

export const onFormLinkInsert = defineFunction({
  trigger: { type: 'db', table: 'form_links', event: 'insert' },
  handler: async (rawContext) => {
    const context = rawContext as TriggerContext;
    if (!context.data?.after) return;
    await bestEffort('form_link_index upsert(insert)', upsert(context, context.data.after));
  },
});

export const onFormLinkUpdate = defineFunction({
  trigger: { type: 'db', table: 'form_links', event: 'update' },
  handler: async (rawContext) => {
    const context = rawContext as TriggerContext;
    if (!context.data?.after) return;
    await bestEffort('form_link_index upsert(update)', upsert(context, context.data.after));
  },
});

export const onFormLinkDelete = defineFunction({
  trigger: { type: 'db', table: 'form_links', event: 'delete' },
  handler: async (rawContext) => {
    const context = rawContext as TriggerContext;
    const before = context.data?.before;
    if (!before?.id) return;
    await bestEffort('form_link_index delete', indexTable(context).delete(before.id));
  },
});
