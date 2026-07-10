// DB trigger: mirror page_permissions rows into the central
// page_permission_index (docs/workspace-do-migration.md). The index answers
// two routing questions after the workspace-DO split without fan-out:
// which workspaces hold grants for a principal (bootstrap shared-workspace
// discovery) and which workspace owns a permissionId (permissionId-only
// share mutations). Rows are routing hints only — authoritative permission
// checks always re-read the workspace-block page_permissions row, so stale
// index entries fail closed. Index rows reuse the permission id as their id.
import { defineFunction } from '@edge-base/shared';
import { bestEffort } from '../lib/table-utils';

interface PermissionRow {
  id: string;
  workspaceId?: string;
  pageId?: string;
  principalType?: string;
  principalId?: string;
  label?: string;
}

interface IndexRow {
  id: string;
  workspaceId: string;
  pageId: string;
  principalType: string;
  principalId?: string;
}

interface IndexTable {
  insert(data: Partial<IndexRow>): Promise<IndexRow>;
  update(id: string, data: Partial<IndexRow>): Promise<IndexRow>;
  delete(id: string): Promise<void>;
  getOne(id: string): Promise<IndexRow | null>;
}

interface TriggerContext {
  data?: { after?: PermissionRow | null; before?: PermissionRow | null };
  admin: { db(namespace: string): { table(name: string): unknown } };
}

function indexTable(ctx: TriggerContext): IndexTable {
  return ctx.admin.db('app').table('page_permission_index') as IndexTable;
}

function principalKey(row: PermissionRow) {
  // Email principals dedupe case-insensitively across the product; store the
  // discovery key the same way bootstrap will look it up.
  const raw = row.principalId ?? row.label ?? '';
  return row.principalType === 'email' ? raw.trim().toLowerCase() : raw;
}

async function upsert(ctx: TriggerContext, row: PermissionRow) {
  if (!row.id || !row.workspaceId || !row.pageId || !row.principalType) return;
  const table = indexTable(ctx);
  const data = {
    workspaceId: row.workspaceId,
    pageId: row.pageId,
    principalType: row.principalType,
    principalId: principalKey(row),
  };
  const existing = await table.getOne(row.id).catch(() => null);
  if (existing) {
    await table.update(row.id, data);
  } else {
    await table.insert({ id: row.id, ...data });
  }
}

export const onPagePermissionInsert = defineFunction({
  trigger: { type: 'db', table: 'page_permissions', event: 'insert' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    if (!ctx.data?.after) return;
    await bestEffort('page_permission_index upsert(insert)', upsert(ctx, ctx.data.after));
  },
});

export const onPagePermissionUpdate = defineFunction({
  trigger: { type: 'db', table: 'page_permissions', event: 'update' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    if (!ctx.data?.after) return;
    await bestEffort('page_permission_index upsert(update)', upsert(ctx, ctx.data.after));
  },
});

export const onPagePermissionDelete = defineFunction({
  trigger: { type: 'db', table: 'page_permissions', event: 'delete' },
  handler: async (context) => {
    const ctx = context as TriggerContext;
    const before = ctx.data?.before;
    if (!before?.id) return;
    await bestEffort('page_permission_index delete', indexTable(ctx).delete(before.id));
  },
});
