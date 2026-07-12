import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { expectErrorResponse, handlerOf } from './helpers/function-context';

const ADMIN = 'admin-1';
const OWNER = 'owner-1';

function deletionFixture() {
  const central = fakeDb({
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
    page_workspace_index: [
      { id: 'db-old', workspaceId: 'ws-old' },
      { id: 'row-old', workspaceId: 'ws-old' },
      { id: 'page-next', workspaceId: 'ws-next' },
    ],
    workspace_members: [
      { id: 'wm-old-owner', workspaceId: 'ws-old', userId: OWNER, role: 'owner' },
      { id: 'wm-old-admin', workspaceId: 'ws-old', userId: ADMIN, role: 'admin' },
      { id: 'wm-next-admin', workspaceId: 'ws-next', userId: ADMIN, role: 'owner' },
    ],
    workspace_invitations: [
      { id: 'inv-old', workspaceId: 'ws-old', email: 'pending@example.com', role: 'member', token: 'token' },
    ],
    organization_storage_usage: [
      { id: 'org1', organizationId: 'org1', reservedBytes: 20, version: 1 },
    ] as Row[],
    organization_storage_reservations: [
      { id: 'file-old', organizationId: 'org1', workspaceId: 'ws-old', bytes: 20, status: 'active' },
    ] as Row[],
    notifications: [{ id: 'note-old', workspaceId: 'ws-old', userId: ADMIN, activityKey: 'a', kind: 'system', occurredAt: '2026-07-05T00:00:00.000Z' }] as Row[],
    file_maintenance_runs: [{ id: 'maintenance-old', workspaceId: 'ws-old', startedAt: '2026-07-05T00:00:00.000Z', finishedAt: '2026-07-05T00:00:00.000Z' }] as Row[],
  });
  const oldContent = fakeDb({
    pages: [
      { id: 'db-old', workspaceId: 'ws-old', kind: 'database', title: 'Imported DB' },
      { id: 'row-old', workspaceId: 'ws-old', parentId: 'db-old', parentType: 'database', kind: 'page', title: 'Imported Row' },
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
    file_uploads: [{
      id: 'file-old', workspaceId: 'ws-old', key: 'old/file.txt', bucket: 'files',
      status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z', name: 'file.txt', size: 20,
    }] as Row[],
    notion_import_connections: [{ id: 'conn-old', workspaceId: 'ws-old' }] as Row[],
    notion_import_jobs: [{ id: 'job-old', workspaceId: 'ws-old' }] as Row[],
    notion_import_items: [{ id: 'item-old', workspaceId: 'ws-old', jobId: 'job-old' }] as Row[],
    notion_import_mappings: [{ id: 'mapping-old', workspaceId: 'ws-old', jobId: 'job-old' }] as Row[],
    change_log: [
      {
        id: 'change-old',
        workspaceId: 'ws-old',
        tbl: 'pages',
        recordId: 'row-old',
        deleted: false,
        at: '2026-07-05T00:00:00.000Z',
      },
    ] as Row[],
  });
  const nextContent = fakeDb({
    pages: [{ id: 'page-next', workspaceId: 'ws-next', kind: 'page', title: 'Keep me' }],
  });
  const admin = {
    db(namespace: string, instanceId?: string) {
      if (namespace === 'app') return central;
      if (namespace === 'workspace' && instanceId === 'ws-old') return oldContent;
      if (namespace === 'workspace' && instanceId === 'ws-next') return nextContent;
      throw new Error(`Unexpected database route: ${namespace}/${instanceId ?? ''}`);
    },
  };
  return { admin, central, oldContent, nextContent };
}

function deleteWorkspaceWithStorage(
  fixture: ReturnType<typeof deletionFixture>,
  storage: { bucket(): unknown; delete(key: string): Promise<void> },
) {
  return handlerOf(POST)({
    auth: { id: ADMIN, email: `${ADMIN}@example.com` },
    admin: fixture.admin,
    storage,
    request: new Request('http://localhost:8787/functions/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'deleteWorkspace',
        workspaceId: 'ws-old',
        confirmWorkspaceName: 'Old Workspace',
      }),
    }),
  });
}

function callWorkspaceMutation(
  fixture: ReturnType<typeof deletionFixture>,
  body: Record<string, unknown>,
) {
  return handlerOf(POST)({
    auth: { id: ADMIN, email: `${ADMIN}@example.com` },
    admin: fixture.admin,
    request: new Request('http://localhost:8787/functions/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
}

describe('workspace-mutation deleteWorkspace', () => {
  it('lets a workspace admin delete a populated workspace after name confirmation', async () => {
    const fixture = deletionFixture();
    const storage = {
      bucket() {
        return this;
      },
      async delete() {},
    };
    const res = await deleteWorkspaceWithStorage(fixture, storage);

    expect(res).not.toBeInstanceOf(Response);
    expect(fixture.central.tables.workspaces.map((row) => row.id)).toEqual(['ws-next']);
    expect(fixture.oldContent.tables.pages).toHaveLength(0);
    expect(fixture.nextContent.tables.pages.map((row) => row.id)).toEqual(['page-next']);
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
      'notion_import_connections',
      'notion_import_jobs',
      'notion_import_items',
      'notion_import_mappings',
    ]) {
      expect(fixture.oldContent.tables[table] ?? [], table).toHaveLength(0);
    }
    for (const table of ['notifications', 'file_maintenance_runs', 'workspace_invitations']) {
      expect(fixture.central.tables[table] ?? [], table).toHaveLength(0);
    }
    expect(fixture.central.tables.workspace_members.map((row) => row.id)).toEqual(['wm-next-admin']);
    expect(fixture.central.tables.page_workspace_index).toEqual([
      { id: 'page-next', workspaceId: 'ws-next' },
    ]);
    const audit = fixture.central.tables.organization_audit_events ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('workspace.delete');
    expect((audit[0].metadata as Record<string, unknown>).deletedPages).toBe(2);
    expect(fixture.central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 0, version: 2 });
    expect(fixture.central.tables.organization_storage_reservations[0]).toMatchObject({ status: 'released' });
    expect(fixture.oldContent.tables.change_log).toHaveLength(0);
  });

  it('keeps a populated workspace when the confirmation name is missing', async () => {
    const fixture = deletionFixture();
    const res = await callWorkspaceMutation(fixture, {
      action: 'deleteWorkspace',
      workspaceId: 'ws-old',
    });

    await expectErrorResponse(res, 400, 'Type the workspace name');
    expect(fixture.central.tables.workspaces.map((row) => row.id)).toEqual(['ws-old', 'ws-next']);
    expect(fixture.oldContent.tables.pages.map((row) => row.id)).toEqual(['db-old', 'row-old']);
    expect(fixture.nextContent.tables.pages.map((row) => row.id)).toEqual(['page-next']);
  });

  it('retains every workspace deletion surface during a storage outage and succeeds on retry', async () => {
    const fixture = deletionFixture();
    let storageAvailable = false;
    let deleteAttempts = 0;
    const storage = {
      bucket() {
        return this;
      },
      async delete() {
        deleteAttempts += 1;
        if (!storageAvailable) throw new Error('Simulated workspace storage outage.');
      },
    };

    const failed = await deleteWorkspaceWithStorage(fixture, storage);
    await expectErrorResponse(failed, 500, 'Internal server error.');
    expect(fixture.central.tables.workspaces.map((row) => row.id)).toEqual(['ws-old', 'ws-next']);
    expect(fixture.oldContent.tables.pages.map((row) => row.id)).toEqual(['db-old', 'row-old']);
    expect(fixture.nextContent.tables.pages.map((row) => row.id)).toEqual(['page-next']);
    expect(fixture.oldContent.tables.blocks).toHaveLength(1);
    expect(fixture.oldContent.tables.file_uploads[0]).toMatchObject({ status: 'uploaded' });
    expect(fixture.oldContent.tables.notion_import_jobs).toHaveLength(1);
    expect(fixture.central.tables.workspace_members.map((row) => row.id)).toEqual([
      'wm-old-owner',
      'wm-old-admin',
      'wm-next-admin',
    ]);
    expect(fixture.central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 20, version: 1 });
    expect(fixture.central.tables.organization_storage_reservations[0]).toMatchObject({ status: 'active' });
    expect(fixture.central.tables.workspaces.find((row) => row.id === 'ws-old')).toMatchObject({
      deletionPendingAt: expect.any(String),
    });

    storageAvailable = true;
    const retried = await deleteWorkspaceWithStorage(fixture, storage);
    expect(retried).not.toBeInstanceOf(Response);
    expect(deleteAttempts).toBe(2);
    expect(fixture.central.tables.workspaces.map((row) => row.id)).toEqual(['ws-next']);
    expect(fixture.oldContent.tables.pages).toHaveLength(0);
    expect(fixture.nextContent.tables.pages.map((row) => row.id)).toEqual(['page-next']);
    expect(fixture.oldContent.tables.file_uploads).toHaveLength(0);
    expect(fixture.oldContent.tables.notion_import_jobs).toHaveLength(0);
    expect(fixture.central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 0, version: 2 });
    expect(fixture.central.tables.organization_storage_reservations[0]).toMatchObject({ status: 'released' });
  });

  it('blocks permanent workspace deletion while an uploaded row still has an active grant', async () => {
    const fixture = deletionFixture();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    fixture.oldContent.tables.file_uploads[0].expiresAt = expiresAt;
    fixture.oldContent.tables.file_uploads[0].completedAt = null;
    const deleted: string[] = [];
    const result = await deleteWorkspaceWithStorage(fixture, {
      bucket() {
        return this;
      },
      async delete(key: string) {
        deleted.push(key);
      },
    });

    await expectErrorResponse(result, 409, 'active file upload grant');
    expect(deleted).toEqual([]);
    expect(fixture.central.tables.workspaces.find((row) => row.id === 'ws-old')).toMatchObject({
      deletionPendingAt: expect.any(String),
    });
    expect(fixture.oldContent.tables.pages.map((row) => row.id)).toEqual(['db-old', 'row-old']);
    expect(fixture.nextContent.tables.pages.map((row) => row.id)).toEqual(['page-next']);
    expect(fixture.oldContent.tables.file_uploads[0]).toMatchObject({ status: 'uploaded', expiresAt });
  });

  it('preserves the requesting admin through a failed final batch so the same principal can retry', async () => {
    const fixture = deletionFixture();
    const transact = fixture.central.transact.bind(fixture.central);
    let failFinalBatchOnce = true;
    fixture.central.transact = async (operations) => {
      if (
        failFinalBatchOnce
        && operations.some((operation) => operation.table === 'workspaces' && operation.op === 'delete')
      ) {
        failFinalBatchOnce = false;
        throw new Error('Simulated final workspace batch outage.');
      }
      return transact(operations);
    };
    const storage = {
      bucket() {
        return this;
      },
      async delete() {},
    };

    const failed = await deleteWorkspaceWithStorage(fixture, storage);
    await expectErrorResponse(failed, 500, 'Internal server error.');
    expect(fixture.central.tables.workspaces.map((row) => row.id)).toEqual(['ws-old', 'ws-next']);
    expect(fixture.central.tables.workspace_members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wm-old-admin', workspaceId: 'ws-old', userId: ADMIN }),
    ]));
    expect(fixture.central.tables.workspace_members.some((row) => row.id === 'wm-old-owner')).toBe(false);
    expect(fixture.oldContent.tables.pages).toHaveLength(0);
    expect(fixture.nextContent.tables.pages.map((row) => row.id)).toEqual(['page-next']);
    expect(fixture.oldContent.tables.change_log).toHaveLength(0);

    const retried = await deleteWorkspaceWithStorage(fixture, storage);
    expect(retried).not.toBeInstanceOf(Response);
    expect(fixture.central.tables.workspaces.map((row) => row.id)).toEqual(['ws-next']);
    expect(fixture.central.tables.workspace_members.map((row) => row.id)).toEqual(['wm-next-admin']);
  });

  it('keeps the workspace retry anchor when central page-index cleanup fails', async () => {
    const fixture = deletionFixture();
    const transact = fixture.central.transact.bind(fixture.central);
    let failPageIndexCleanupOnce = true;
    fixture.central.transact = async (operations) => {
      if (
        failPageIndexCleanupOnce &&
        operations.some((operation) => operation.table === 'page_workspace_index')
      ) {
        failPageIndexCleanupOnce = false;
        throw new Error('Simulated page index control-plane outage.');
      }
      return transact(operations);
    };
    const storage = {
      bucket() {
        return this;
      },
      async delete() {},
    };

    const failed = await deleteWorkspaceWithStorage(fixture, storage);
    await expectErrorResponse(failed, 500, 'Internal server error.');
    expect(fixture.central.tables.workspaces.some((row) => row.id === 'ws-old')).toBe(true);
    expect(fixture.central.tables.workspace_members.some((row) => row.id === 'wm-old-admin')).toBe(true);
    expect(fixture.central.tables.page_workspace_index.map((row) => row.id)).toEqual([
      'db-old', 'row-old', 'page-next',
    ]);

    const retried = await deleteWorkspaceWithStorage(fixture, storage);
    expect(retried).not.toBeInstanceOf(Response);
    expect(fixture.central.tables.workspaces.map((row) => row.id)).toEqual(['ws-next']);
    expect(fixture.central.tables.page_workspace_index).toEqual([
      { id: 'page-next', workspaceId: 'ws-next' },
    ]);
  });
});

describe('workspace metadata stored-file boundaries', () => {
  const localLocators = [
    'workspaces/ws-old/profile/avatar.png',
    '/api/storage/files/workspaces/ws-old/profile/avatar.png',
    '//evil.example/api/storage/files/workspaces/ws-old/profile/avatar.png',
    'http://localhost:8787/api/storage/files/workspaces/ws-old/profile/avatar.png',
  ];

  it.each(localLocators)('rejects a local workspace icon locator: %s', async (icon) => {
    const fixture = deletionFixture();
    const result = await callWorkspaceMutation(fixture, {
      action: 'update',
      workspaceId: 'ws-old',
      patch: { icon },
    });

    await expectErrorResponse(result, 400, 'Stored file references are not allowed');
    expect(fixture.central.tables.workspaces.find((row) => row.id === 'ws-old')?.icon).toBeUndefined();
  });

  it.each(localLocators)('rejects a local profile avatar locator: %s', async (avatar) => {
    const fixture = deletionFixture();
    const result = await callWorkspaceMutation(fixture, {
      action: 'updateMyProfile',
      workspaceId: 'ws-old',
      avatar,
    });

    await expectErrorResponse(result, 400, 'Stored file references are not allowed');
    expect(fixture.central.tables.workspace_members.find((row) => row.id === 'wm-old-admin')?.avatar)
      .toBeUndefined();
  });

  it('rejects a local locator during workspace creation before inserting metadata', async () => {
    const fixture = deletionFixture();
    const result = await callWorkspaceMutation(fixture, {
      action: 'createWorkspace',
      organizationId: 'org1',
      name: 'Unsafe workspace',
      icon: '/api/storage/files/workspaces/ws-old/icons/copied.png',
      skipDefaultPages: true,
    });

    await expectErrorResponse(result, 400, 'Stored file references are not allowed');
    expect(fixture.central.tables.workspaces.some((row) => row.name === 'Unsafe workspace')).toBe(false);
  });

  it('continues to allow emoji and genuinely external HTTPS metadata images', async () => {
    const fixture = deletionFixture();
    const updated = await callWorkspaceMutation(fixture, {
      action: 'update',
      workspaceId: 'ws-old',
      patch: { icon: '🏢' },
    });
    expect(updated).not.toBeInstanceOf(Response);

    const profile = await callWorkspaceMutation(fixture, {
      action: 'updateMyProfile',
      workspaceId: 'ws-old',
      avatar: 'https://cdn.example/api/storage/files/public/avatar.png',
    });
    expect(profile).not.toBeInstanceOf(Response);
    expect(fixture.central.tables.workspaces.find((row) => row.id === 'ws-old')).toMatchObject({ icon: '🏢' });
    expect(fixture.central.tables.workspace_members.find((row) => row.id === 'wm-old-admin')).toMatchObject({
      avatar: 'https://cdn.example/api/storage/files/public/avatar.png',
    });
  });
});
