import { describe, expect, it } from 'vitest';

import { POST } from '../../functions/database-row-mutation';
import { fakeDb, type FakeDb } from './helpers/fake-db';
import { expectErrorResponse, handlerOf } from './helpers/function-context';

const OWNER = 'owner-1';

function failSecondPageDeleteTransaction(database: FakeDb) {
  const originalTransact = database.transact.bind(database);
  let pageDeleteTransactions = 0;
  let injected = false;
  database.transact = (async (operations: Parameters<FakeDb['transact']>[0]) => {
    if (operations.some((operation) => operation.table === 'pages' && operation.op === 'delete')) {
      pageDeleteTransactions += 1;
      if (pageDeleteTransactions === 2 && !injected) {
        injected = true;
        throw new Error('Simulated later page-delete transaction failure.');
      }
    }
    return originalTransact(operations);
  }) as FakeDb['transact'];
  return () => pageDeleteTransactions;
}

describe('database-row permanent deletion storage ordering', () => {
  it('does not restore a fenced row while permanent deletion owns the workspace file lease', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: true, createdBy: OWNER,
          trashedAt: '2026-01-02T00:00:00.000Z',
          deletionPendingAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      file_workspace_locks: [{
        id: 'ws1',
        workspaceId: 'ws1',
        leaseId: 'delete-row-lease',
        actorId: OWNER,
        operation: 'permanent-database-row-delete',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    const response = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost:8787/functions/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore', id: 'row1', databaseId: 'db1' }),
      }),
    });

    await expectErrorResponse(response, 409, 'Another file operation is already in progress');
    expect(database.tables.pages.find((page) => page.id === 'row1')).toMatchObject({
      inTrash: true,
      deletionPendingAt: '2026-01-03T00:00:00.000Z',
    });
  });

  it('requires a trashed row and manage-level access', async () => {
    const editor = 'editor-1';
    const makeDatabase = (rowInTrash: boolean) => fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      workspace_members: [{ id: 'member-editor', workspaceId: 'ws1', userId: editor, role: 'member' }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: rowInTrash, createdBy: OWNER,
        },
      ],
    });
    const invoke = (database: ReturnType<typeof fakeDb>, actorId: string) => handlerOf(POST)({
      auth: { id: actorId, email: `${actorId}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost:8787/functions/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'delete', id: 'row1', databaseId: 'db1', workspaceId: 'ws1',
        }),
      }),
    });

    const active = makeDatabase(false);
    await expectErrorResponse(await invoke(active, OWNER), 409, 'must be moved to trash');
    expect(active.tables.pages).toHaveLength(2);

    const editOnly = makeDatabase(true);
    await expectErrorResponse(await invoke(editOnly, editor), 403, 'Permanent delete access required.');
    expect(editOnly.tables.pages).toHaveLength(2);
  });

  it('keeps the row subtree retryable during an outage and completes on retry', async () => {
    const database = fakeDb({
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER, storageLimitBytes: 100 }],
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
      pages: [
        {
          id: 'db1',
          workspaceId: 'ws1',
          parentType: 'workspace',
          kind: 'database',
          title: 'Database',
          position: 0,
          inTrash: false,
          createdBy: OWNER,
        },
        {
          id: 'row1',
          workspaceId: 'ws1',
          parentId: 'db1',
          parentType: 'database',
          kind: 'page',
          title: 'Row',
          position: 0,
          inTrash: true,
          createdBy: OWNER,
        },
      ],
      blocks: [{ id: 'block1', pageId: 'row1', type: 'paragraph', position: 0 }],
      file_uploads: [
        {
          id: 'upload-row',
          workspaceId: 'ws1',
          pageId: 'row1',
          bucket: 'files',
          key: 'workspaces/ws1/database/files/upload-row.txt',
          name: 'upload-row.txt',
          size: 15,
          status: 'uploaded',
          completedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      organization_storage_usage: [{ id: 'org1', organizationId: 'org1', reservedBytes: 15, version: 1 }],
      organization_storage_reservations: [
        {
          id: 'upload-row',
          organizationId: 'org1',
          workspaceId: 'ws1',
          bytes: 15,
          status: 'active',
        },
      ],
      notifications: [
        {
          id: 'row-notification', workspaceId: 'ws1', userId: OWNER, activityKey: 'row', kind: 'comment',
          pageId: 'row1', blockId: 'block1', target: '/p/row1#block-block1',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'unrelated-notification', workspaceId: 'ws1', userId: OWNER, activityKey: 'other', kind: 'system',
          pageId: 'db1', target: '/p/db1', occurredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    let storageAvailable = false;
    let deleteAttempts = 0;
    const storage = {
      bucket() {
        return this;
      },
      async delete() {
        deleteAttempts += 1;
        if (!storageAvailable) throw new Error('Simulated row storage outage.');
      },
    };
    const invokeDelete = () =>
      handlerOf(POST)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage,
        request: new Request('http://localhost:8787/functions/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: 'row1', databaseId: 'db1' }),
        }),
      });

    const failed = await invokeDelete();
    await expectErrorResponse(failed, 500, 'Internal server error.');
    expect(database.tables.pages.map((page) => page.id)).toEqual(['db1', 'row1']);
    expect(database.tables.blocks).toHaveLength(1);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'uploaded' });
    expect(database.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 15, version: 1 });
    expect(database.tables.organization_storage_reservations[0]).toMatchObject({ status: 'active' });
    expect(database.tables.notifications).toHaveLength(2);

    storageAvailable = true;
    const retried = (await invokeDelete()) as { deletedIds: string[]; cleanup: Record<string, number> };
    expect(retried.deletedIds).toEqual(['row1']);
    expect(retried.cleanup.notifications).toBe(1);
    expect(deleteAttempts).toBe(2);
    expect(database.tables.pages.map((page) => page.id)).toEqual(['db1']);
    expect(database.tables.blocks).toHaveLength(0);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'deleted' });
    expect(database.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 0, version: 2 });
    expect(database.tables.organization_storage_reservations[0]).toMatchObject({ status: 'released' });
    expect(database.tables.notifications.map((notification) => notification.id)).toEqual(['unrelated-notification']);
  });

  it('keeps the row root until central row-routing indexes are durably removed', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database',
          kind: 'page', title: 'Row', position: 0, inTrash: true, createdBy: OWNER,
        },
      ],
      page_workspace_index: [
        { id: 'db1', workspaceId: 'ws1' },
        { id: 'row1', workspaceId: 'ws1' },
      ],
      page_permission_index: [{
        id: 'perm-row', workspaceId: 'ws1', pageId: 'row1', principalType: 'user',
        principalId: 'viewer-1',
      }],
      share_link_index: [{
        id: 'share-row', workspaceId: 'ws1', pageId: 'row1', token: 'row-token', enabled: true,
      }],
    });
    const transact = database.transact.bind(database);
    let failCentralOnce = true;
    database.transact = async (operations) => {
      if (
        failCentralOnce
        && operations.some((operation) => operation.table === 'share_link_index')
      ) {
        failCentralOnce = false;
        throw new Error('Simulated central row-index outage.');
      }
      return transact(operations);
    };
    const invoke = () => handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'delete', id: 'row1', databaseId: 'db1', workspaceId: 'ws1',
        }),
      }),
    });

    const failed = await invoke();
    await expectErrorResponse(failed, 500, 'Internal server error.');
    expect(database.tables.pages.find((page) => page.id === 'row1')).toMatchObject({
      deletionPendingAt: expect.any(String),
    });
    expect(database.tables.page_workspace_index).toHaveLength(2);

    const retried = await invoke() as { cleanup: Record<string, number> };
    expect(retried.cleanup).toMatchObject({
      pageWorkspaceIndexes: 1, permissionIndexes: 1, shareLinkIndexes: 1,
    });
    expect(database.tables.pages.map((page) => page.id)).toEqual(['db1']);
    expect(database.tables.page_workspace_index).toEqual([{ id: 'db1', workspaceId: 'ws1' }]);
    expect(database.tables.page_permission_index).toEqual([]);
    expect(database.tables.share_link_index).toEqual([]);
  });

  it('keeps the row root retryable when a later page-delete chunk fails in a 241-page subtree', async () => {
    const databasePage = {
      id: 'db1',
      workspaceId: 'ws1',
      parentType: 'workspace',
      kind: 'database',
      title: 'Database',
      position: 0,
      inTrash: false,
      createdBy: OWNER,
    };
    const rowRoot = {
      id: 'row-root',
      workspaceId: 'ws1',
      parentId: databasePage.id,
      parentType: 'database',
      kind: 'page',
      title: 'Row root',
      position: 0,
      inTrash: true,
      createdBy: OWNER,
    };
    const children = Array.from({ length: 240 }, (_, index) => ({
      id: `row-child-${index}`,
      workspaceId: 'ws1',
      parentId: rowRoot.id,
      parentType: 'page',
      kind: 'page',
      title: `Row child ${index}`,
      position: index + 1,
      inTrash: true,
      createdBy: OWNER,
    }));
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [databasePage, rowRoot, ...children],
    });
    const pageDeleteTransactionCount = failSecondPageDeleteTransaction(database);
    const invokeDelete = () => handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost:8787/functions/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'delete', id: rowRoot.id, databaseId: databasePage.id, workspaceId: 'ws1',
        }),
      }),
    });

    const failed = await invokeDelete();
    await expectErrorResponse(failed, 500, 'Internal server error.');
    expect(pageDeleteTransactionCount()).toBe(2);
    expect(database.tables.pages).toEqual([
      expect.objectContaining({ id: databasePage.id }),
      expect.objectContaining({
        id: rowRoot.id,
        inTrash: true,
        deletionPendingAt: expect.any(String),
      }),
    ]);
    // Only the parent database's route remains. Every row-subtree route was
    // removed before the interrupted page-delete chunks, so workspaceId is
    // the durable retry anchor.
    expect(database.tables.page_workspace_index).toEqual([
      { id: databasePage.id, workspaceId: 'ws1' },
    ]);

    const retried = (await invokeDelete()) as { deletedIds: string[] };
    expect(retried.deletedIds).toEqual([rowRoot.id]);
    expect(pageDeleteTransactionCount()).toBe(3);
    expect(database.tables.pages).toEqual([expect.objectContaining({ id: databasePage.id })]);
  });

  it('fences the row subtree and waits for an active upload grant before deleting anything', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [
        {
          id: 'db1',
          workspaceId: 'ws1',
          parentType: 'workspace',
          kind: 'database',
          title: 'Database',
          position: 0,
          inTrash: false,
          createdBy: OWNER,
        },
        {
          id: 'row1',
          workspaceId: 'ws1',
          parentId: 'db1',
          parentType: 'database',
          kind: 'page',
          title: 'Row',
          position: 0,
          inTrash: true,
          createdBy: OWNER,
        },
      ],
      blocks: [{ id: 'block1', pageId: 'row1', type: 'paragraph', position: 0 }],
      file_uploads: [{
        id: 'upload-row-active',
        workspaceId: 'ws1',
        pageId: 'row1',
        bucket: 'files',
        key: 'workspaces/ws1/database/files/upload-row-active.txt',
        name: 'upload-row-active.txt',
        size: 15,
        status: 'pending',
        expiresAt,
        createdBy: OWNER,
      }],
    });
    const deleted: string[] = [];
    const invokeDelete = () =>
      handlerOf(POST)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage: {
          bucket() {
            return this;
          },
          async delete(key: string) {
            deleted.push(key);
          },
        },
        request: new Request('http://localhost:8787/functions/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: 'row1', databaseId: 'db1' }),
        }),
      });

    const blocked = await invokeDelete();
    await expectErrorResponse(blocked, 409, 'active file upload grant');
    expect(deleted).toEqual([]);
    expect(database.tables.pages.find((page) => page.id === 'row1')).toMatchObject({
      deletionPendingAt: expect.any(String),
    });
    expect(database.tables.pages.find((page) => page.id === 'db1')?.deletionPendingAt).toBeUndefined();
    expect(database.tables.blocks).toHaveLength(1);

    database.tables.file_uploads[0].expiresAt = '2020-01-01T00:00:00.000Z';
    const retried = (await invokeDelete()) as { deletedIds: string[] };
    expect(retried.deletedIds).toEqual(['row1']);
    expect(deleted).toEqual(['workspaces/ws1/database/files/upload-row-active.txt']);
    expect(database.tables.pages.map((page) => page.id)).toEqual(['db1']);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'deleted' });
  });

  it('purges direct and nested Notion import references without matching substrings', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Private row', position: 0, inTrash: true, createdBy: OWNER,
        },
      ],
      blocks: [{ id: 'row-block', pageId: 'row1', type: 'paragraph', position: 0 }],
      collaboration_documents: [{ id: 'row-doc', workspaceId: 'ws1', pageId: 'row1' }],
      page_permissions: [{
        id: 'row-permission', workspaceId: 'ws1', pageId: 'row1',
        principalType: 'user', principalId: 'viewer-1', label: 'Viewer', role: 'view',
      }],
      share_links: [{
        id: 'row-share', workspaceId: 'ws1', pageId: 'row1', token: 'synthetic-token',
        enabled: true, role: 'view',
      }],
      notion_import_mappings: [
        { id: 'map-row', workspaceId: 'ws1', jobId: 'job1', localId: 'row1' },
        { id: 'map-doc', workspaceId: 'ws1', jobId: 'job1', localId: 'kept', metadata: { nested: { local: 'row-doc' } } },
        { id: 'map-keep', workspaceId: 'ws1', jobId: 'job1', localId: 'kept', metadata: { local: 'prefix-row1-suffix' } },
      ],
      notion_import_items: [
        { id: 'item-block', workspaceId: 'ws1', jobId: 'job1', localId: 'row-block' },
        { id: 'item-permission', workspaceId: 'ws1', jobId: 'job1', localId: 'kept', metadata: { refs: ['row-permission'] } },
        { id: 'item-keep', workspaceId: 'ws1', jobId: 'job1', localId: 'kept', metadata: { refs: ['prefix-row-block-suffix'] } },
      ],
    });

    const response = (await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost:8787/functions/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: 'row1', databaseId: 'db1' }),
      }),
    })) as { cleanup: Record<string, number> };

    expect(response.cleanup).toMatchObject({
      collaborationDocuments: 1,
      permissions: 1,
      shareLinks: 1,
      notionImportMappings: 2,
      notionImportItems: 2,
    });
    expect(database.tables.pages.map((page) => page.id)).toEqual(['db1']);
    expect(database.tables.collaboration_documents).toEqual([]);
    expect(database.tables.page_permissions).toEqual([]);
    expect(database.tables.share_links).toEqual([]);
    expect(database.tables.notion_import_mappings.map((item) => item.id)).toEqual(['map-keep']);
    expect(database.tables.notion_import_items.map((item) => item.id)).toEqual(['item-keep']);
  });
});
