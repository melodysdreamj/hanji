import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/page-mutation';
import { POST as FILE_POST } from '../../functions/file-mutation';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse, handlerOf } from './helpers/function-context';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';

function workspaceRow(extra: Partial<Row> = {}): Row {
  return { id: 'ws1', name: 'Workspace', ownerId: OWNER, ...extra };
}

function pageRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Page ${id}`,
    position: 0,
    inTrash: false,
    createdBy: OWNER,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({ workspaces: [workspaceRow()], ...tables });
}

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

describe('page-mutation POST', () => {
  it('requires authentication', async () => {
    const res = await callFunction(POST, db(), null, { action: 'create' });
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  it('rejects unknown actions', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'explode' });
    await expectErrorResponse(res, 400, 'Unknown page mutation action.');
  });

  describe('create', () => {
    const createBody = {
      action: 'create',
      id: 'p-new',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      title: 'Fresh page',
      position: 10,
    };

    it('creates a workspace-root page for the workspace owner', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, createBody)) as { page: Row };
      expect(res.page.id).toBe('p-new');
      expect(res.page.kind).toBe('page');
      expect(res.page.createdBy).toBe(OWNER);
      expect(database.tables.pages).toHaveLength(1);
    });

    it('denies workspace outsiders', async () => {
      const res = await callFunction(POST, db(), STRANGER, createBody);
      await expectErrorResponse(res, 403, 'Workspace access required.');
    });

    it('rejects an invalid parentType', async () => {
      const res = await callFunction(POST, db(), OWNER, { ...createBody, parentType: 'folder' });
      await expectErrorResponse(res, 400, 'parentType must be one of');
    });

    it('rejects an oversized title', async () => {
      const res = await callFunction(POST, db(), OWNER, {
        ...createBody,
        title: 'x'.repeat(5_000),
      });
      await expectErrorResponse(res, 400, 'title must be at most');
    });

    it('rejects a missing position', async () => {
      const { position: _unused, ...withoutPosition } = createBody;
      const res = await callFunction(POST, db(), OWNER, withoutPosition);
      await expectErrorResponse(res, 400, 'position must be a number.');
    });

    it('rejects creating a page under a database parent with kind database', async () => {
      const database = db({ pages: [pageRow('db1', { kind: 'database' })] });
      const res = await callFunction(POST, database, OWNER, {
        ...createBody,
        parentId: 'db1',
        parentType: 'database',
        kind: 'database',
      });
      await expectErrorResponse(res, 400, 'Only regular pages can be placed in a database.');
    });

    it('routes valid database-row creation through the dedicated mutation endpoint', async () => {
      const database = db({ pages: [pageRow('db1', { kind: 'database' })] });
      const res = await callFunction(POST, database, OWNER, {
        ...createBody, parentId: 'db1', parentType: 'database', kind: 'page',
      });
      await expectErrorResponse(res, 409, 'database-row mutation endpoint');
      expect(database.tables.pages).toHaveLength(1);
    });

    it.each([
      ['icon key', { icon: 'workspaces/ws1/icons/existing.png' }],
      ['cover route', { cover: '/api/storage/files/workspaces/ws1/covers/existing.png' }],
      ['same-origin absolute route', {
        cover: 'http://localhost:8787/api/storage/files/workspaces/ws1/covers/pending.png',
      }],
      ['same-origin protocol-relative route', {
        cover: '//localhost:8787/api/storage/files/workspaces/ws1/covers/pending.png',
      }],
      ['raw property key', { properties: { attachment: 'workspaces/ws1/files/existing.pdf' } }],
      ['structured property URL', {
        properties: { attachment: { url: '/api/storage/files/workspaces/ws1/files/existing.pdf' } },
      }],
    ])('rejects unowned stored-file input during page create: %s', async (_label, extra) => {
      const database = db();
      const res = await callFunction(POST, database, OWNER, { ...createBody, ...extra });
      await expectErrorResponse(res, 409, 'create it first, then upload');
      expect(database.tables.pages ?? []).toEqual([]);
    });

    it('rejects an exact registered upload URL but allows emoji and ordinary external URLs', async () => {
      const storedUrl = 'https://storage.example/api/storage/files/workspaces/ws1/icons/existing.png';
      const rejectedDb = db({
        file_uploads: [{
          id: 'other-page-upload', workspaceId: 'ws1', pageId: 'other-page', bucket: 'files',
          key: 'workspaces/ws1/icons/existing.png', url: storedUrl, status: 'uploaded',
        }],
      });
      const rejected = await callFunction(POST, rejectedDb, OWNER, {
        ...createBody, icon: storedUrl,
      });
      await expectErrorResponse(rejected, 409, 'create it first, then upload');

      const allowedDb = db();
      const allowed = await callFunction(POST, allowedDb, OWNER, {
        ...createBody,
        icon: '😀',
        cover: 'https://images.example/cover.png',
      }) as { page: Row };
      expect(allowed.page).toMatchObject({ icon: '😀', cover: 'https://images.example/cover.png' });
    });
  });

  describe('update', () => {
    it('applies an allowed patch and drops unknown patch keys', async () => {
      const database = db({ pages: [pageRow('p1')] });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'p1',
        patch: { title: 'Renamed', hackField: 'nope' },
      })) as { page: Row };
      expect(res.page.title).toBe('Renamed');
      expect(res.page.lastEditedBy).toBe(OWNER);
      expect('hackField' in database.tables.pages[0]).toBe(false);
    });

    it('atomically retires a removed stored cover without touching block uploads', async () => {
      const coverKey = 'workspaces/ws1/covers/page-cover.png';
      const database = db({
        pages: [pageRow('p1', { cover: coverKey })],
        file_uploads: [
          {
            id: 'cover-upload', workspaceId: 'ws1', pageId: 'p1', bucket: 'files',
            key: coverKey, status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'block-upload', workspaceId: 'ws1', pageId: 'p1', blockId: 'b1', bucket: 'files',
            key: 'workspaces/ws1/blocks/images/block.png', status: 'uploaded',
          },
        ],
      });

      await callFunction(POST, database, OWNER, {
        action: 'update', id: 'p1', patch: { cover: null },
      });
      expect(database.tables.pages[0].cover).toBeNull();
      expect(database.tables.file_uploads.map((upload) => upload.status)).toEqual([
        'deleting',
        'uploaded',
      ]);
    });

    it('retires a legacy raw stored locator removed from regular page properties', async () => {
      const key = 'workspaces/ws1/files/page-property.pdf';
      const database = db({
        pages: [pageRow('p1', { properties: { attachment: [key] } })],
        file_uploads: [{
          id: 'page-property-upload', workspaceId: 'ws1', pageId: 'p1', bucket: 'files',
          key, status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z',
        }],
      });

      await callFunction(POST, database, OWNER, {
        action: 'update', id: 'p1', patch: { properties: {} },
      });

      expect(database.tables.pages[0].properties).toEqual({});
      expect(database.tables.file_uploads[0]).toMatchObject({
        status: 'deleting', deletionPreviousStatus: 'uploaded',
      });
    });

    it('rejects adding a dead stored cover URL', async () => {
      const coverKey = 'workspaces/ws1/covers/deleted-cover.png';
      const database = db({
        pages: [pageRow('p1')],
        file_uploads: [{
          id: 'deleted-cover', workspaceId: 'ws1', pageId: 'p1', bucket: 'files',
          key: coverKey, status: 'deleted', deletedAt: '2026-01-01T00:00:00.000Z',
        }],
      });
      const response = await callFunction(POST, database, OWNER, {
        action: 'update', id: 'p1', patch: { cover: coverKey },
      });
      await expectErrorResponse(response, 409, 'no longer available');
      expect(database.tables.pages[0].cover).toBeUndefined();
    });

    it('rejects one structured file record whose uploadId and key name different uploads', async () => {
      const keyA = 'workspaces/ws1/files/a.pdf';
      const keyB = 'workspaces/ws1/files/b.pdf';
      const database = db({
        pages: [pageRow('p1')],
        file_uploads: [
          { id: 'upload-a', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: keyA, status: 'uploaded' },
          { id: 'upload-b', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: keyB, status: 'uploaded' },
        ],
      });

      const response = await callFunction(POST, database, OWNER, {
        action: 'update', id: 'p1',
        patch: { properties: { attachment: { uploadId: 'upload-a', key: keyB } } },
      });

      await expectErrorResponse(response, 409, 'do not refer to the same upload');
      expect(database.tables.pages[0].properties).toBeUndefined();
    });

    it('rejects direct page-mutation bypasses for database-row stored files', async () => {
      const key = 'workspaces/ws1/database/files/row.pdf';
      const database = db({
        pages: [
          pageRow('db1', { kind: 'database' }),
          pageRow('row1', {
            parentId: 'db1', parentType: 'database', properties: { files: [{ url: key }] },
          }),
        ],
        file_uploads: [{
          id: 'row-upload', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
          propertyId: 'files', bucket: 'files', key, status: 'uploaded',
        }],
      });
      const response = await callFunction(POST, database, OWNER, {
        action: 'update', id: 'row1', patch: { properties: { files: [] } },
      });
      await expectErrorResponse(response, 409, 'database-row mutation endpoint');
      expect(database.tables.pages.find((page) => page.id === 'row1')?.properties)
        .toEqual({ files: [{ url: key }] });
      expect(database.tables.file_uploads[0].status).toBe('uploaded');
    });

    it('rejects direct database-row property patches even for legacy raw-string files', async () => {
      const key = 'workspaces/ws1/database/files/legacy-row.pdf';
      const database = db({
        pages: [
          pageRow('db1', { kind: 'database' }),
          pageRow('row1', {
            parentId: 'db1', parentType: 'database', properties: { files: [key] },
          }),
        ],
        db_properties: [{
          id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 0,
        }],
        file_uploads: [{
          id: 'legacy-row-upload', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
          propertyId: 'files', bucket: 'files', key, status: 'uploaded',
        }],
      });

      const response = await callFunction(POST, database, OWNER, {
        action: 'update', id: 'row1', patch: { properties: { files: [] } },
      });

      await expectErrorResponse(response, 409, 'database-row mutation endpoint');
      expect(database.tables.pages.find((page) => page.id === 'row1')?.properties)
        .toEqual({ files: [key] });
      expect(database.tables.file_uploads[0].status).toBe('uploaded');
    });

    it.each([
      ['out of', 'row1', { parentId: null, parentType: 'workspace' }],
      ['into', 'p1', { parentId: 'db1', parentType: 'database' }],
    ])('rejects generic moves %s a database because file associations need row semantics', async (
      _direction,
      id,
      patch,
    ) => {
      const key = 'workspaces/ws1/database/files/row.pdf';
      const database = db({
        pages: [
          pageRow('db1', { kind: 'database' }),
          pageRow('row1', { parentId: 'db1', parentType: 'database' }),
          pageRow('p1'),
        ],
        file_uploads: [{
          id: 'row-upload', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
          propertyId: 'files', bucket: 'files', key, status: 'uploaded',
        }],
      });

      const response = await callFunction(POST, database, OWNER, { action: 'update', id, patch });
      await expectErrorResponse(response, 409, 'dedicated database-row mutation endpoint');
      expect(database.tables.pages.find((page) => page.id === 'row1')).toMatchObject({
        parentId: 'db1', parentType: 'database',
      });
      expect(database.tables.file_uploads[0]).toMatchObject({
        pageId: 'row1', databaseId: 'db1', propertyId: 'files',
      });
    });

    it('rejects patches with wrong value types before they reach storage', async () => {
      const database = db({ pages: [pageRow('p1')] });
      const res = await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'p1',
        patch: { title: 123 },
      });
      await expectErrorResponse(res, 400, 'title must be a string.');
      expect(database.tables.pages[0].title).toBe('Page p1');
    });

    it('refuses content edits on a locked page', async () => {
      const database = db({ pages: [pageRow('p1', { isLocked: true })] });
      const res = await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'p1',
        patch: { title: 'New name' },
      });
      await expectErrorResponse(res, 423, 'Page is locked.');
    });

    it('refuses moving a page under its own descendant', async () => {
      const database = db({
        pages: [
          pageRow('p1'),
          pageRow('p2', { parentId: 'p1', parentType: 'page' }),
        ],
      });
      const res = await callFunction(POST, database, OWNER, {
        action: 'move',
        id: 'p1',
        patch: { parentId: 'p2', parentType: 'page' },
      });
      await expectErrorResponse(res, 400, 'Cannot move a page inside itself');
    });

    it('denies actors without page access', async () => {
      const database = db({ pages: [pageRow('p1')] });
      const res = await callFunction(POST, database, STRANGER, {
        action: 'update',
        id: 'p1',
        patch: { title: 'Hijack' },
      });
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('lets a manage-level actor set sharing/verification fields', async () => {
      const database = db({ pages: [pageRow('p1')] });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'p1',
        patch: { isPublic: true, verifiedBy: OWNER, verifiedAt: '2026-01-02T00:00:00.000Z' },
      })) as { page: Row };
      expect(res.page.isPublic).toBe(true);
      expect(res.page.verifiedBy).toBe(OWNER);
    });

    it('forbids an edit-only member from setting sharing/verification fields', async () => {
      const MEMBER = 'member-1';
      const database = db({
        pages: [pageRow('p1')],
        workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' }],
      });
      // The member holds edit — a plain rename succeeds…
      const ok = (await callFunction(POST, database, MEMBER, {
        action: 'update',
        id: 'p1',
        patch: { title: 'Edited' },
      })) as { page: Row };
      expect(ok.page.title).toBe('Edited');
      // …but verification/sharing fields require manage-level rights.
      const res = await callFunction(POST, database, MEMBER, {
        action: 'update',
        id: 'p1',
        patch: { verifiedBy: MEMBER, verifiedAt: '2026-01-02T00:00:00.000Z' },
      });
      await expectErrorResponse(res, 403, 'Page access required.');
      expect(database.tables.pages[0].verifiedBy).toBeUndefined();
    });
  });

  describe('trash / restore', () => {
    it('trashes the page together with its subtree', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2', { parentId: 'p1', parentType: 'page' })],
      });
      const res = await callFunction(POST, database, OWNER, { action: 'trash', id: 'p1' });
      expect(res).not.toBeInstanceOf(Response);
      expect(database.tables.pages.every((page) => page.inTrash === true)).toBe(true);
    });

    it('restores a trashed subtree', async () => {
      const database = db({
        pages: [
          pageRow('p1', {
            inTrash: true,
            trashedAt: '2026-01-02T00:00:00.000Z',
          }),
          pageRow('p2', {
            parentId: 'p1',
            parentType: 'page',
            inTrash: true,
            trashedAt: '2026-01-02T00:00:00.000Z',
          }),
        ],
      });
      const res = await callFunction(POST, database, OWNER, { action: 'restore', id: 'p1' });
      expect(res).not.toBeInstanceOf(Response);
      expect(database.tables.pages.every((page) => page.inTrash === false)).toBe(true);
      expect(database.tables.pages.every((page) => page.deletionPendingAt === null)).toBe(true);
    });

    it('rejects parent restore when any descendant owns a permanent-delete fence', async () => {
      const database = db({
        pages: [
          pageRow('p1', { inTrash: true, trashedAt: '2026-01-02T00:00:00.000Z' }),
          pageRow('p2', {
            parentId: 'p1', parentType: 'page', inTrash: true,
            trashedAt: '2026-01-02T00:00:00.000Z',
            deletionPendingAt: '2026-01-03T00:00:00.000Z',
          }),
        ],
      });

      const response = await callFunction(POST, database, OWNER, { action: 'restore', id: 'p1' });
      await expectErrorResponse(response, 409, 'Permanent page deletion is in progress');
      expect(database.tables.pages.every((page) => page.inTrash === true)).toBe(true);
      expect(database.tables.pages.find((page) => page.id === 'p2')?.deletionPendingAt)
        .toBe('2026-01-03T00:00:00.000Z');
    });

    it('does not clear a permanent-delete fence while that file operation still owns the workspace lease', async () => {
      const database = db({
        pages: [pageRow('p1', {
          inTrash: true,
          trashedAt: '2026-01-02T00:00:00.000Z',
          deletionPendingAt: '2026-01-03T00:00:00.000Z',
        })],
        file_workspace_locks: [{
          id: 'ws1',
          workspaceId: 'ws1',
          leaseId: 'delete-lease',
          actorId: OWNER,
          operation: 'permanent-page-delete',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      });

      const res = await callFunction(POST, database, OWNER, { action: 'restore', id: 'p1' });
      await expectErrorResponse(res, 409, 'Another file operation is already in progress');
      expect(database.tables.pages[0]).toMatchObject({
        inTrash: true,
        deletionPendingAt: '2026-01-03T00:00:00.000Z',
      });
    });
  });

  describe('delete', () => {
    it('requires the page to be in trash before permanent deletion', async () => {
      const database = db({ pages: [pageRow('p1')] });
      const res = await callFunction(POST, database, OWNER, { action: 'delete', id: 'p1' });
      await expectErrorResponse(res, 409, 'must be moved to trash');
      expect(database.tables.pages).toHaveLength(1);
    });

    it('requires manage-level access for permanent deletion', async () => {
      const editor = 'editor-1';
      const database = db({
        pages: [pageRow('p1', { inTrash: true })],
        workspace_members: [{ id: 'member-editor', workspaceId: 'ws1', userId: editor, role: 'member' }],
      });
      const res = await callFunction(POST, database, editor, { action: 'delete', id: 'p1' });
      await expectErrorResponse(res, 403, 'Permanent delete access required.');
      expect(database.tables.pages).toHaveLength(1);
    });

    it('permanently deletes the subtree and its content rows', async () => {
      const database = db({
        pages: [
          pageRow('p1', { inTrash: true }),
          pageRow('p2', { parentId: 'p1', parentType: 'page', inTrash: true }),
        ],
        blocks: [
          { id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 },
          { id: 'b2', pageId: 'p2', type: 'paragraph', position: 0 },
        ],
        comments: [{ id: 'c1', pageId: 'p1', authorId: OWNER }],
        notion_import_mappings: [
          { id: 'map-page', workspaceId: 'ws1', jobId: 'job1', localId: 'p1' },
          { id: 'map-nested', workspaceId: 'ws1', jobId: 'job1', localId: 'kept-local', metadata: { refs: [{ target: 'b2' }] } },
          { id: 'map-unrelated', workspaceId: 'ws1', jobId: 'job1', localId: 'kept-local', metadata: { target: 'prefix-p1-suffix' } },
          { id: 'map-other-workspace', workspaceId: 'ws2', jobId: 'job2', localId: 'p1' },
        ],
        notion_import_items: [
          { id: 'item-page', workspaceId: 'ws1', jobId: 'job1', localId: 'p2' },
          { id: 'item-nested', workspaceId: 'ws1', jobId: 'job1', localId: 'kept-local', metadata: { source: { commentId: 'c1' } } },
          { id: 'item-unrelated', workspaceId: 'ws1', jobId: 'job1', localId: 'kept-local', metadata: { source: 'prefix-c1-suffix' } },
        ],
        notifications: [
          { id: 'n-page', workspaceId: 'ws1', userId: OWNER, activityKey: 'page', kind: 'page_edit', pageId: 'p1', occurredAt: '2026-01-01T00:00:00.000Z' },
          { id: 'n-block', workspaceId: 'ws1', userId: OWNER, activityKey: 'block', kind: 'mention', pageId: 'unrelated', blockId: 'b2', occurredAt: '2026-01-01T00:00:00.000Z' },
          { id: 'n-comment', workspaceId: 'ws1', userId: OWNER, activityKey: 'comment', kind: 'comment', pageId: 'unrelated', commentId: 'c1', occurredAt: '2026-01-01T00:00:00.000Z' },
          { id: 'n-target', workspaceId: 'ws1', userId: OWNER, activityKey: 'target', kind: 'system', target: '/p/p2#block-b2', occurredAt: '2026-01-01T00:00:00.000Z' },
          { id: 'n-metadata', workspaceId: 'ws1', userId: OWNER, activityKey: 'metadata', kind: 'system', metadata: { sourcePageId: 'p2' }, occurredAt: '2026-01-01T00:00:00.000Z' },
          { id: 'n-unrelated', workspaceId: 'ws1', userId: OWNER, activityKey: 'unrelated', kind: 'system', pageId: 'unrelated', target: '/p/unrelated', occurredAt: '2026-01-01T00:00:00.000Z' },
          { id: 'n-other-workspace', workspaceId: 'ws2', userId: OWNER, activityKey: 'other-workspace', kind: 'system', pageId: 'p1', occurredAt: '2026-01-01T00:00:00.000Z' },
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'delete',
        id: 'p1',
      })) as { deletedIds: string[]; cleanup: Record<string, number> };
      expect(res.deletedIds.sort()).toEqual(['p1', 'p2']);
      expect(res.cleanup.blocks).toBe(2);
      expect(res.cleanup.comments).toBe(1);
      expect(res.cleanup.notifications).toBe(5);
      expect(res.cleanup.notionImportMappings).toBe(2);
      expect(res.cleanup.notionImportItems).toBe(2);
      expect(database.tables.pages).toHaveLength(0);
      expect(database.tables.blocks).toHaveLength(0);
      expect(database.tables.comments).toHaveLength(0);
      expect(database.tables.notifications.map((notification) => notification.id).sort()).toEqual([
        'n-other-workspace',
        'n-unrelated',
      ]);
      expect(database.tables.notion_import_mappings.map((item) => item.id).sort()).toEqual([
        'map-other-workspace',
        'map-unrelated',
      ]);
      expect(database.tables.notion_import_items.map((item) => item.id)).toEqual(['item-unrelated']);
      const tombstones = (database.tables.change_log ?? [])
        .filter((entry) => entry.deleted === true)
        .map((entry) => `${entry.tbl}:${entry.recordId}`);
      expect(tombstones).toEqual(expect.arrayContaining([
        'blocks:b1',
        'blocks:b2',
        'pages:p1',
        'pages:p2',
      ]));
    });

    it('re-homes a verified legacy shared upload and keeps the surviving page downloadable', async () => {
      const key = 'workspaces/ws1/covers/legacy-shared.txt';
      const database = db({
        pages: [
          pageRow('p1', { inTrash: true, cover: key }),
          pageRow('p2', { cover: key }),
        ],
        blocks: [],
        db_templates: [],
        workspace_members: [],
        file_uploads: [{
          id: 'legacy-upload',
          workspaceId: 'ws1',
          pageId: 'p1',
          bucket: 'files',
          key,
          name: 'legacy-shared.txt',
          size: 4,
          contentType: 'text/plain',
          etag: 'etag-legacy',
          status: 'uploaded',
          completedAt: '2026-01-01T00:00:00.000Z',
          createdBy: OWNER,
        }],
      });
      const deleted: string[] = [];
      const storage = {
        bucket() {
          return this;
        },
        async head(storedKey: string) {
          return { key: storedKey, size: 4, contentType: 'text/plain', etag: 'etag-legacy' };
        },
        async delete(storedKey: string) {
          deleted.push(storedKey);
        },
        async getSignedUrl(storedKey: string) {
          return `https://download.example/${storedKey}`;
        },
      };
      const invoke = (fn: typeof POST | typeof FILE_POST, body: Record<string, unknown>) => handlerOf(fn)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage,
        request: new Request('http://localhost/functions/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      });

      const removed = await invoke(POST, { action: 'delete', id: 'p1' }) as { deletedIds: string[] };
      expect(removed.deletedIds).toEqual(['p1']);
      expect(deleted).toEqual([]);
      expect(database.tables.file_uploads[0]).toMatchObject({
        status: 'uploaded', pageId: 'p2', blockId: null, databaseId: null,
      });

      const signed = await invoke(FILE_POST, {
        action: 'signedUrl', workspaceId: 'ws1', id: 'legacy-upload',
      }) as { url: string };
      expect(signed.url).toContain('legacy-shared.txt');
    });

    it('stops permanent deletion when surviving shared bytes lack complete integrity metadata', async () => {
      const key = 'workspaces/ws1/covers/unverified-shared.txt';
      const database = db({
        pages: [pageRow('p1', { inTrash: true, cover: key }), pageRow('p2', { cover: key })],
        blocks: [],
        db_templates: [],
        workspace_members: [],
        file_uploads: [{
          id: 'unverified-upload', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key,
          name: 'unverified-shared.txt', size: 4, contentType: 'text/plain', status: 'uploaded',
          completedAt: '2026-01-01T00:00:00.000Z', createdBy: OWNER,
          // Missing etag: never revive/re-home this as a verified upload.
        }],
      });
      const response = await handlerOf(POST)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage: {
          bucket() { return this; },
          async head(storedKey: string) {
            return { key: storedKey, size: 4, contentType: 'text/plain', etag: 'etag-storage' };
          },
          async delete() {},
        },
        request: new Request('http://localhost/functions/page-mutation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: 'p1' }),
        }),
      });

      await expectErrorResponse(response, 409, 'stored-etag verification');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1', 'p2']);
      expect(database.tables.file_uploads[0]).toMatchObject({ status: 'uploaded', pageId: 'p1' });
    });

    it('permanently deletes a subtree whose cleanup exceeds one transact batch', async () => {
      // 300 change-logged block deletes gain 300 appended change_log inserts
      // inside boundedDb, so a naive 500-op raw chunk overflows the runtime's
      // 500-op transact cap (fake-db mirrors it) and the page becomes
      // permanently undeletable.
      const blocks = Array.from({ length: 300 }, (_, index) => ({
        id: `b${index}`,
        pageId: 'p1',
        type: 'paragraph',
        position: index,
      }));
      const database = db({ pages: [pageRow('p1', { inTrash: true })], blocks });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'delete',
        id: 'p1',
      })) as { deletedIds: string[]; cleanup: Record<string, number> };
      expect(res.deletedIds).toEqual(['p1']);
      expect(res.cleanup.blocks).toBe(300);
      expect(database.tables.pages).toHaveLength(0);
      expect(database.tables.blocks).toHaveLength(0);
    });

    it('keeps the root retryable when a later page-delete chunk fails in a 241-page subtree', async () => {
      const root = pageRow('p-root', { inTrash: true });
      const children = Array.from({ length: 240 }, (_, index) =>
        pageRow(`p-child-${index}`, {
          parentId: root.id,
          parentType: 'page',
          position: index + 1,
          inTrash: true,
        }));
      const database = db({ pages: [root, ...children] });
      const pageDeleteTransactionCount = failSecondPageDeleteTransaction(database);
      const invokeDelete = () => callFunction(POST, database, OWNER, {
        action: 'delete',
        id: root.id,
        workspaceId: 'ws1',
      });

      const failed = await invokeDelete();
      await expectErrorResponse(failed, 500, 'Internal server error.');
      expect(pageDeleteTransactionCount()).toBe(2);
      expect(database.tables.pages).toEqual([
        expect.objectContaining({
          id: root.id,
          inTrash: true,
          deletionPendingAt: expect.any(String),
        }),
      ]);
      // Central discovery routes are intentionally gone before content rows;
      // the explicit workspaceId is what makes this retry possible.
      expect(database.tables.page_workspace_index).toEqual([]);

      const retriedResult = await invokeDelete();
      if (retriedResult instanceof Response) {
        throw new Error(`Unexpected retry response: ${await retriedResult.text()}`);
      }
      const retried = retriedResult as { deletedIds: string[] };
      expect(retried.deletedIds).toEqual([root.id]);
      expect(pageDeleteTransactionCount()).toBe(3);
      expect(database.tables.pages).toEqual([]);
    });

    it('is blocked by an active organization legal hold', async () => {
      const database = fakeDb({
        workspaces: [workspaceRow({ organizationId: 'org1' })],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_legal_holds: [
          { id: 'hold1', organizationId: 'org1', name: 'Litigation A', status: 'active', scope: { all: true } },
        ],
        pages: [pageRow('p1', { inTrash: true })],
      });
      const res = await callFunction(POST, database, OWNER, { action: 'delete', id: 'p1' });
      await expectErrorResponse(res, 400, 'Active legal hold prevents permanent deletion: Litigation A');
      expect(database.tables.pages).toHaveLength(1);
    });

    it('keeps page metadata and quota retryable until every stored file is deleted', async () => {
      const database = db({
        workspaces: [workspaceRow({ organizationId: 'org1' })],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER, storageLimitBytes: 100 }],
        pages: [pageRow('p1', { inTrash: true })],
        blocks: [{ id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 }],
        file_uploads: [
          {
            id: 'upload-1',
            workspaceId: 'ws1',
            pageId: 'p1',
            bucket: 'files',
            key: 'workspaces/ws1/uploads/upload-1.txt',
            name: 'upload-1.txt',
            size: 10,
            status: 'uploaded',
            completedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        organization_storage_usage: [
          { id: 'org1', organizationId: 'org1', reservedBytes: 10, version: 1 },
        ],
        organization_storage_reservations: [
          {
            id: 'upload-1',
            organizationId: 'org1',
            workspaceId: 'ws1',
            bytes: 10,
            status: 'active',
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
          if (!storageAvailable) throw new Error('Simulated storage outage.');
        },
      };
      const invokeDelete = () => handlerOf(POST)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage,
        request: new Request('http://localhost:8787/functions/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: 'p1' }),
        }),
      });

      const failed = await invokeDelete();
      await expectErrorResponse(failed, 500, 'Internal server error.');
      expect(database.tables.pages).toHaveLength(1);
      expect(database.tables.blocks).toHaveLength(1);
      expect(database.tables.file_uploads[0]).toMatchObject({ status: 'uploaded' });
      expect(database.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 10, version: 1 });
      expect(database.tables.organization_storage_reservations[0]).toMatchObject({ status: 'active' });
      expect(database.tables.pages[0]).toMatchObject({
        id: 'p1',
        deletionPendingAt: expect.any(String),
      });

      const fencedPrepare = await callFunction(FILE_POST, database, OWNER, {
        action: 'prepareUpload',
        workspaceId: 'ws1',
        pageId: 'p1',
        name: 'late.txt',
        size: 4,
        contentType: 'text/plain',
      });
      await expectErrorResponse(fencedPrepare, 404, 'Target page was not found.');
      expect(database.tables.file_uploads).toHaveLength(1);

      storageAvailable = true;
      const retried = (await invokeDelete()) as { deletedIds: string[] };
      expect(retried.deletedIds).toEqual(['p1']);
      expect(deleteAttempts).toBe(2);
      expect(database.tables.pages).toHaveLength(0);
      expect(database.tables.blocks).toHaveLength(0);
      expect(database.tables.file_uploads[0]).toMatchObject({ status: 'deleted' });
      expect(database.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 0, version: 2 });
      expect(database.tables.organization_storage_reservations[0]).toMatchObject({ status: 'released' });
    });

    it('fences the subtree and blocks permanent deletion until an active upload grant expires', async () => {
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const database = db({
        pages: [pageRow('p1', { inTrash: true })],
        file_uploads: [{
          id: 'upload-active',
          workspaceId: 'ws1',
          pageId: 'p1',
          bucket: 'files',
          key: 'workspaces/ws1/uploads/upload-active.txt',
          name: 'upload-active.txt',
          size: 4,
          status: 'pending',
          expiresAt,
          createdBy: OWNER,
        }],
      });
      const deleted: string[] = [];
      const invokeDelete = () => handlerOf(POST)({
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
          body: JSON.stringify({ action: 'delete', id: 'p1' }),
        }),
      });

      const blocked = await invokeDelete();
      await expectErrorResponse(blocked, 409, 'active file upload grant');
      expect(deleted).toEqual([]);
      expect(database.tables.pages[0]).toMatchObject({
        id: 'p1',
        deletionPendingAt: expect.any(String),
      });
      expect(database.tables.file_uploads[0]).toMatchObject({ status: 'pending', expiresAt });

      database.tables.file_uploads[0].expiresAt = '2020-01-01T00:00:00.000Z';
      const retried = (await invokeDelete()) as { deletedIds: string[] };
      expect(retried.deletedIds).toEqual(['p1']);
      expect(deleted).toEqual(['workspaces/ws1/uploads/upload-active.txt']);
      expect(database.tables.pages).toHaveLength(0);
      expect(database.tables.file_uploads[0]).toMatchObject({ status: 'deleted' });
    });

    it('does not mistake uploaded-reference deletion grace for an active upload grant', async () => {
      const key = 'workspaces/ws1/covers/detached.png';
      const database = db({
        pages: [pageRow('p1', { inTrash: true })],
        blocks: [],
        db_templates: [],
        workspace_members: [],
        file_uploads: [{
          id: 'detached-upload', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key,
          name: 'detached.png', size: 4, contentType: 'image/png', etag: 'etag-detached',
          status: 'deleting', deletionPreviousStatus: 'uploaded',
          completedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      });
      const deleted: string[] = [];
      const result = await handlerOf(POST)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage: {
          bucket() { return this; },
          async delete(storedKey: string) { deleted.push(storedKey); },
        },
        request: new Request('http://localhost/functions/page-mutation', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: 'p1' }),
        }),
      }) as { deletedIds: string[] };

      expect(result.deletedIds).toEqual(['p1']);
      expect(deleted).toEqual([key]);
      expect(database.tables.file_uploads[0].status).toBe('deleted');
    });

    it.each([
      ['future', new Date(Date.now() + 60_000).toISOString()],
      ['unknown', null],
    ])('blocks permanent delete for an unverified deleting upload with %s grant expiry', async (
      _label,
      expiresAt,
    ) => {
      const key = 'workspaces/ws1/covers/unverified-detached.png';
      const database = db({
        pages: [pageRow('p1', { inTrash: true })],
        file_uploads: [{
          id: 'unverified-detached', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key,
          name: 'unverified.png', size: 4, status: 'deleting',
          deletionPreviousStatus: 'uploaded', completedAt: null, expiresAt,
        }],
      });
      const deleted: string[] = [];

      const response = await handlerOf(POST)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage: {
          bucket() { return this; },
          async delete(storedKey: string) { deleted.push(storedKey); },
        },
        request: new Request('http://localhost/functions/page-mutation', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: 'p1' }),
        }),
      });

      await expectErrorResponse(response, 409, 'active file upload grant');
      expect(deleted).toEqual([]);
      expect(database.tables.file_uploads[0]).toMatchObject({ status: 'deleting', expiresAt });
    });

    it('keeps the root retryable until every central routing index is deleted', async () => {
      const database = db({
        pages: [pageRow('p1', { inTrash: true })],
        page_permissions: [{
          id: 'perm-1', workspaceId: 'ws1', pageId: 'p1', principalType: 'user',
          principalId: 'viewer-1', role: 'view',
        }],
        share_links: [{
          id: 'share-1', workspaceId: 'ws1', pageId: 'p1', token: 'token-1', enabled: true,
        }],
        page_workspace_index: [{ id: 'p1', workspaceId: 'ws1' }],
        page_permission_index: [{
          id: 'perm-1', workspaceId: 'ws1', pageId: 'p1', principalType: 'user',
          principalId: 'viewer-1',
        }],
        share_link_index: [{
          id: 'share-1', workspaceId: 'ws1', pageId: 'p1', token: 'token-1', enabled: true,
        }],
      });
      const transact = database.transact.bind(database);
      let failCentralOnce = true;
      database.transact = async (operations) => {
        if (
          failCentralOnce
          && operations.some((operation) => operation.table === 'page_permission_index')
        ) {
          failCentralOnce = false;
          throw new Error('Simulated central routing-index outage.');
        }
        return transact(operations);
      };
      const invoke = () => callFunction(POST, database, OWNER, {
        action: 'delete', id: 'p1', workspaceId: 'ws1',
      });

      const failed = await invoke();
      await expectErrorResponse(failed, 500, 'Internal server error.');
      expect(database.tables.pages[0]).toMatchObject({
        id: 'p1', deletionPendingAt: expect.any(String),
      });
      expect(database.tables.page_workspace_index).toHaveLength(1);
      expect(database.tables.page_permission_index).toHaveLength(1);
      expect(database.tables.share_link_index).toHaveLength(1);

      const retried = await invoke() as { deletedIds: string[]; cleanup: Record<string, number> };
      expect(retried.deletedIds).toEqual(['p1']);
      expect(retried.cleanup).toMatchObject({
        pageWorkspaceIndexes: 1, permissionIndexes: 1, shareLinkIndexes: 1,
      });
      expect(database.tables.pages).toEqual([]);
      expect(database.tables.page_workspace_index).toEqual([]);
      expect(database.tables.page_permission_index).toEqual([]);
      expect(database.tables.share_link_index).toEqual([]);
    });
  });
});
