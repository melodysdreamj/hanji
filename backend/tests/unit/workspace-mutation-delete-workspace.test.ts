import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const ADMIN = 'admin-1';
const OWNER = 'owner-1';

function deletionDb() {
  return fakeDb({
    organizations: [
      { id: 'org1', name: 'Org', ownerId: OWNER, workspaceCreationPolicy: 'owners_admins' },
    ],
    organization_members: [
      { id: 'om-owner', organizationId: 'org1', userId: OWNER, role: 'owner', status: 'active', email: 'owner@example.com' },
      { id: 'om-admin', organizationId: 'org1', userId: ADMIN, role: 'admin', status: 'active', email: 'admin@example.com' },
    ],
    workspaces: [
      { id: 'ws-old', name: 'Old Workspace', ownerId: OWNER, organizationId: 'org1' },
      { id: 'ws-next', name: 'Next Workspace', ownerId: ADMIN, organizationId: 'org1' },
    ],
    workspace_members: [
      { id: 'wm-old-owner', workspaceId: 'ws-old', userId: OWNER, role: 'owner' },
      { id: 'wm-old-admin', workspaceId: 'ws-old', userId: ADMIN, role: 'admin' },
      { id: 'wm-next-admin', workspaceId: 'ws-next', userId: ADMIN, role: 'owner' },
    ],
    workspace_invitations: [
      { id: 'inv-old', workspaceId: 'ws-old', email: 'pending@example.com', role: 'member', token: 'token' },
    ],
    pages: [
      { id: 'db-old', workspaceId: 'ws-old', kind: 'database', title: 'Imported DB' },
      { id: 'row-old', workspaceId: 'ws-old', parentId: 'db-old', parentType: 'database', kind: 'page', title: 'Imported Row' },
      { id: 'page-next', workspaceId: 'ws-next', kind: 'page', title: 'Keep me' },
    ],
    blocks: [{ id: 'block-old', workspaceId: 'ws-old', pageId: 'row-old', type: 'paragraph' }] as Row[],
    comments: [{ id: 'comment-old', pageId: 'row-old', authorId: ADMIN }] as Row[],
    page_permissions: [{ id: 'perm-old', workspaceId: 'ws-old', pageId: 'row-old', principalType: 'user', principalId: ADMIN, label: 'Admin' }] as Row[],
    share_links: [{ id: 'share-old', workspaceId: 'ws-old', pageId: 'row-old', token: 'share', enabled: 1 }] as Row[],
    db_properties: [{ id: 'prop-old', databaseId: 'db-old', name: 'Name', type: 'title' }] as Row[],
    db_views: [{ id: 'view-old', databaseId: 'db-old', name: 'Default view', type: 'table' }] as Row[],
    db_templates: [{ id: 'template-old', databaseId: 'db-old', name: 'Template' }] as Row[],
    db_property_indexes: [{ id: 'index-old', workspaceId: 'ws-old', databaseId: 'db-old', rowId: 'row-old', propertyId: 'prop-old' }] as Row[],
    collaboration_operations: [{ id: 'op-old', workspaceId: 'ws-old', pageId: 'row-old', clientId: 'client', occurredAt: '2026-07-05T00:00:00.000Z' }] as Row[],
    collaboration_documents: [{ id: 'doc-old', workspaceId: 'ws-old', pageId: 'row-old', documentId: 'doc', stateBase64: '' }] as Row[],
    file_uploads: [{ id: 'file-old', workspaceId: 'ws-old', key: 'old/file.txt', bucket: 'files', status: 'uploaded', name: 'file.txt' }] as Row[],
    notifications: [{ id: 'note-old', workspaceId: 'ws-old', userId: ADMIN, activityKey: 'a', kind: 'system', occurredAt: '2026-07-05T00:00:00.000Z' }] as Row[],
    file_maintenance_runs: [{ id: 'maintenance-old', workspaceId: 'ws-old', startedAt: '2026-07-05T00:00:00.000Z', finishedAt: '2026-07-05T00:00:00.000Z' }] as Row[],
    notion_import_connections: [{ id: 'conn-old', workspaceId: 'ws-old' }] as Row[],
    notion_import_jobs: [{ id: 'job-old', workspaceId: 'ws-old' }] as Row[],
    notion_import_items: [{ id: 'item-old', workspaceId: 'ws-old', jobId: 'job-old' }] as Row[],
    notion_import_mappings: [{ id: 'mapping-old', workspaceId: 'ws-old', jobId: 'job-old' }] as Row[],
  });
}

describe('workspace-mutation deleteWorkspace', () => {
  it('lets a workspace admin delete a populated workspace after name confirmation', async () => {
    const database = deletionDb();
    const res = await callFunction(POST, database, ADMIN, {
      action: 'deleteWorkspace',
      workspaceId: 'ws-old',
      confirmWorkspaceName: 'Old Workspace',
    });

    expect(res).not.toBeInstanceOf(Response);
    expect(database.tables.workspaces.map((row) => row.id)).toEqual(['ws-next']);
    expect(database.tables.pages.map((row) => row.id)).toEqual(['page-next']);
    for (const table of [
      'blocks',
      'comments',
      'page_permissions',
      'share_links',
      'db_properties',
      'db_views',
      'db_templates',
      'db_property_indexes',
      'collaboration_operations',
      'collaboration_documents',
      'file_uploads',
      'notifications',
      'file_maintenance_runs',
      'workspace_invitations',
      'notion_import_connections',
      'notion_import_jobs',
      'notion_import_items',
      'notion_import_mappings',
    ]) {
      expect(database.tables[table] ?? [], table).toHaveLength(0);
    }
    expect(database.tables.workspace_members.map((row) => row.id)).toEqual(['wm-next-admin']);
    const audit = database.tables.organization_audit_events ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('workspace.delete');
    expect((audit[0].metadata as Record<string, unknown>).deletedPages).toBe(2);
  });

  it('keeps a populated workspace when the confirmation name is missing', async () => {
    const database = deletionDb();
    const res = await callFunction(POST, database, ADMIN, {
      action: 'deleteWorkspace',
      workspaceId: 'ws-old',
    });

    await expectErrorResponse(res, 400, 'Type the workspace name');
    expect(database.tables.workspaces.map((row) => row.id)).toEqual(['ws-old', 'ws-next']);
    expect(database.tables.pages.map((row) => row.id)).toEqual(['db-old', 'row-old', 'page-next']);
  });
});
