import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/block-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';
const T0 = '2026-01-01T00:00:00.000Z';
const FILE_KEY = 'workspaces/ws1/blocks/images/upload-image.png';

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
    ...extra,
  };
}

function blockRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    pageId: 'p1',
    parentId: null,
    type: 'paragraph',
    plainText: `Block ${id}`,
    position: 0,
    createdBy: OWNER,
    updatedAt: T0,
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    pages: [pageRow('p1')],
    ...tables,
  });
}

describe('block-mutation POST', () => {
  it('requires authentication', async () => {
    const res = await callFunction(POST, db(), null, { action: 'create' });
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  describe('create', () => {
    const createBody = {
      action: 'create',
      id: 'b-new',
      pageId: 'p1',
      type: 'paragraph',
      content: { rich: [{ text: 'hello' }] },
      plainText: 'hello',
      position: 1,
    };

    it('creates a block on a writable page', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, createBody)) as { block: Row };
      expect(res.block.id).toBe('b-new');
      expect(res.block.createdBy).toBe(OWNER);
      expect(database.tables.blocks).toHaveLength(1);
    });

    it('rejects duplicate/paste creation that reuses another block stored key', async () => {
      const database = db({
        blocks: [blockRow('source', { content: { url: FILE_KEY } })],
        file_uploads: [{
          id: 'source-upload', workspaceId: 'ws1', pageId: 'p1', blockId: 'source',
          bucket: 'files', key: FILE_KEY, status: 'uploaded', completedAt: T0,
        }],
      });
      const response = await callFunction(POST, database, OWNER, {
        ...createBody,
        content: { url: FILE_KEY },
      });
      await expectErrorResponse(response, 409, 'metadata is missing or belongs to another target');
      expect(database.tables.blocks.map((block) => block.id)).toEqual(['source']);
    });

    it('atomically restores same-id block undo while its upload is in deleting grace', async () => {
      const database = db({
        blocks: [],
        file_uploads: [{
          id: 'undo-upload', workspaceId: 'ws1', pageId: 'p1', blockId: 'b-new',
          bucket: 'files', key: FILE_KEY, status: 'deleting',
          deletionPreviousStatus: 'uploaded', completedAt: T0,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      });
      const result = await callFunction(POST, database, OWNER, {
        ...createBody,
        content: { url: FILE_KEY },
      }) as { block: Row };
      expect(result.block.id).toBe('b-new');
      expect(database.tables.file_uploads[0]).toMatchObject({
        status: 'uploaded', deletionPreviousStatus: null, expiresAt: null,
      });
    });

    it('defaults a null type to paragraph', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, {
        ...createBody,
        type: null,
      })) as { block: Row };
      expect(res.block.type).toBe('paragraph');
    });

    it('denies actors without page access', async () => {
      const res = await callFunction(POST, db(), STRANGER, createBody);
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('refuses blocks on a locked page', async () => {
      const database = db({ pages: [pageRow('p1', { isLocked: true })] });
      const res = await callFunction(POST, database, OWNER, createBody);
      await expectErrorResponse(res, 423, 'Page is locked.');
    });

    it('rejects a non-object content payload', async () => {
      const res = await callFunction(POST, db(), OWNER, { ...createBody, content: 'raw html' });
      await expectErrorResponse(res, 400, 'content must be an object.');
    });

    it('rejects a missing pageId', async () => {
      const { pageId: _unused, ...withoutPageId } = createBody;
      const res = await callFunction(POST, db(), OWNER, withoutPageId);
      await expectErrorResponse(res, 400, 'pageId is required.');
    });

    it('createMany validates each entry', async () => {
      const database = db();
      const res = await callFunction(POST, database, OWNER, {
        action: 'createMany',
        blocks: [
          { id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 },
          { id: 'b2', pageId: 'p1', type: 'paragraph' },
        ],
      });
      await expectErrorResponse(res, 400, 'position must be a number.');
      expect(database.tables.blocks ?? []).toHaveLength(0);
    });

    it('createMany prevalidates parent references before committing any block', async () => {
      const database = db();
      const res = await callFunction(POST, database, OWNER, {
        action: 'createMany',
        blocks: [
          { id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 },
          { id: 'b2', pageId: 'p1', parentId: 'missing', type: 'paragraph', position: 1 },
        ],
      });
      await expectErrorResponse(res, 404, 'Parent block was not found');
      expect(database.tables.blocks ?? []).toHaveLength(0);
    });

    it('createMany supports parent references within the same atomic batch', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, {
        action: 'createMany',
        blocks: [
          { id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 },
          { id: 'b2', pageId: 'p1', parentId: 'b1', type: 'paragraph', position: 1 },
        ],
      })) as { blocks: Row[] };
      expect(res.blocks.map((block) => block.id)).toEqual(['b1', 'b2']);
      expect(database.tables.blocks).toHaveLength(2);
    });

    it('rejects an oversized createMany before inserting any block', async () => {
      const database = db();
      const res = await callFunction(POST, database, OWNER, {
        action: 'createMany',
        blocks: Array.from({ length: 241 }, (_, index) => ({
          id: `batch-create-${index}`,
          pageId: 'p1',
          type: 'paragraph',
          position: index,
        })),
      });

      await expectErrorResponse(res, 413, 'Too many blocks for one atomic create.');
      expect(database.tables.blocks ?? []).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('applies a patch and refreshes updatedAt', async () => {
      const database = db({ blocks: [blockRow('b1')] });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        patch: { plainText: 'edited' },
      })) as { block: Row };
      expect(res.block.plainText).toBe('edited');
      expect(res.block.updatedAt).not.toBe(T0);
    });

    it('atomically retires and reattaches a stored media reference', async () => {
      const database = db({
        blocks: [blockRow('b1', { content: { url: FILE_KEY } })],
        file_uploads: [{
          id: 'upload-image',
          workspaceId: 'ws1',
          pageId: 'p1',
          blockId: 'b1',
          bucket: 'files',
          key: FILE_KEY,
          status: 'uploaded',
          completedAt: T0,
        }],
      });

      const removed = (await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        patch: { content: {} },
      })) as { block: Row };
      expect(database.tables.file_uploads[0]).toMatchObject({
        status: 'deleting',
        deletionPreviousStatus: 'uploaded',
      });

      await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        expectedUpdatedAt: removed.block.updatedAt,
        patch: { content: { url: FILE_KEY } },
      });
      expect(database.tables.file_uploads[0]).toMatchObject({
        status: 'uploaded',
        deletionPreviousStatus: null,
        expiresAt: null,
      });
    });

    it('rejects block content whose uploadId and key resolve to different uploads', async () => {
      const otherKey = 'workspaces/ws1/blocks/files/other.pdf';
      const database = db({
        blocks: [blockRow('b1', { content: {} })],
        file_uploads: [
          {
            id: 'upload-a', workspaceId: 'ws1', pageId: 'p1', blockId: 'b1',
            bucket: 'files', key: FILE_KEY, status: 'uploaded',
          },
          {
            id: 'upload-b', workspaceId: 'ws1', pageId: 'p1', blockId: 'b1',
            bucket: 'files', key: otherKey, status: 'uploaded',
          },
        ],
      });

      const response = await callFunction(POST, database, OWNER, {
        action: 'update', id: 'b1', pageId: 'p1',
        patch: { content: { uploadId: 'upload-a', key: otherKey } },
      });

      await expectErrorResponse(response, 409, 'do not refer to the same upload');
      expect(database.tables.blocks[0].content).toEqual({});
    });

    it('detects concurrent edits through expectedUpdatedAt', async () => {
      const database = db({ blocks: [blockRow('b1')] });
      const res = await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        expectedUpdatedAt: '2026-01-01T00:00:59.000Z',
        patch: { plainText: 'stale edit' },
      });
      await expectErrorResponse(res, 409, 'Block changed since it was loaded.');
      expect(database.tables.blocks[0].plainText).toBe('Block b1');
    });

    it('refuses moving a block under its own descendant', async () => {
      const database = db({
        blocks: [blockRow('b1'), blockRow('b2', { parentId: 'b1' })],
      });
      const res = await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        patch: { parentId: 'b2' },
      });
      await expectErrorResponse(res, 400, 'Block cannot be moved under its own descendant.');
    });

    it('re-stamps every subtree upload association during a cross-page move', async () => {
      const childKey = 'workspaces/ws1/blocks/files/child.pdf';
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [
          blockRow('b1', { content: { url: FILE_KEY } }),
          blockRow('b2', { parentId: 'b1', content: { url: childKey } }),
        ],
        file_uploads: [
          {
            id: 'root-upload', workspaceId: 'ws1', pageId: 'p1', blockId: 'b1',
            bucket: 'files', key: FILE_KEY, status: 'uploaded', completedAt: T0,
          },
          {
            id: 'child-upload', workspaceId: 'ws1', pageId: 'p1', blockId: 'b2',
            bucket: 'files', key: childKey, status: 'uploaded', completedAt: T0,
          },
        ],
      });

      await callFunction(POST, database, OWNER, {
        action: 'update', id: 'b1', pageId: 'p1',
        expectedUpdatedAt: T0,
        patch: { pageId: 'p2', parentId: null },
      });
      expect(database.tables.blocks.map((block) => block.pageId)).toEqual(['p2', 'p2']);
      expect(database.tables.file_uploads.map((upload) => upload.pageId)).toEqual(['p2', 'p2']);
    });

    it('rejects wrongly typed patch values', async () => {
      const database = db({ blocks: [blockRow('b1')] });
      const res = await callFunction(POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        patch: { position: 'first' },
      });
      await expectErrorResponse(res, 400, 'position must be a number.');
    });

    it('updateMany prevalidates every optimistic version before committing', async () => {
      const database = db({ blocks: [blockRow('b1'), blockRow('b2')] });
      const res = await callFunction(POST, database, OWNER, {
        action: 'updateMany',
        pageId: 'p1',
        updates: [
          { id: 'b1', expectedUpdatedAt: T0, patch: { plainText: 'first edit' } },
          { id: 'b2', expectedUpdatedAt: 'stale', patch: { plainText: 'second edit' } },
        ],
      });
      await expectErrorResponse(res, 409, 'Block changed since it was loaded.');
      expect(database.tables.blocks.map((block) => block.plainText)).toEqual(['Block b1', 'Block b2']);
    });

    it('updateMany commits ordinary patches together', async () => {
      const database = db({ blocks: [blockRow('b1'), blockRow('b2')] });
      await callFunction(POST, database, OWNER, {
        action: 'updateMany',
        pageId: 'p1',
        updates: [
          { id: 'b1', expectedUpdatedAt: T0, patch: { position: 1 } },
          { id: 'b2', expectedUpdatedAt: T0, patch: { position: 2 } },
        ],
      });
      expect(database.tables.blocks.map((block) => block.position)).toEqual([1, 2]);
    });

    it('rejects an oversized updateMany before changing any block', async () => {
      const original = Array.from({ length: 241 }, (_, index) =>
        blockRow(`batch-update-${index}`, { position: index }));
      const database = db({ blocks: original });
      const res = await callFunction(POST, database, OWNER, {
        action: 'updateMany',
        pageId: 'p1',
        updates: original.map((block, index) => ({
          id: block.id,
          patch: { position: index + 1000 },
        })),
      });

      await expectErrorResponse(res, 413, 'Too many blocks for one atomic update.');
      expect(database.tables.blocks.map((block) => block.position)).toEqual(
        original.map((block) => block.position),
      );
    });

    it('updateMany commits stored-reference retirement in the same atomic batch', async () => {
      const secondKey = 'workspaces/ws1/blocks/files/upload-file.pdf';
      const database = db({
        blocks: [
          blockRow('b1', { content: { url: FILE_KEY } }),
          blockRow('b2', { content: { url: secondKey } }),
        ],
        file_uploads: [
          {
            id: 'upload-image', workspaceId: 'ws1', pageId: 'p1', blockId: 'b1',
            bucket: 'files', key: FILE_KEY, status: 'uploaded', completedAt: T0,
          },
          {
            id: 'upload-file', workspaceId: 'ws1', pageId: 'p1', blockId: 'b2',
            bucket: 'files', key: secondKey, status: 'uploaded', completedAt: T0,
          },
        ],
      });

      await callFunction(POST, database, OWNER, {
        action: 'updateMany',
        pageId: 'p1',
        updates: [
          { id: 'b1', expectedUpdatedAt: T0, patch: { content: {} } },
          { id: 'b2', expectedUpdatedAt: T0, patch: { position: 2 } },
        ],
      });
      expect(database.tables.blocks.find((block) => block.id === 'b1')?.content).toEqual({});
      expect(database.tables.blocks.find((block) => block.id === 'b2')?.position).toBe(2);
      expect(database.tables.file_uploads.map((upload) => upload.status)).toEqual([
        'deleting',
        'uploaded',
      ]);
    });

    it('updateMany rejects structural moves that cannot share one safe snapshot', async () => {
      const database = db({ blocks: [blockRow('b1'), blockRow('b2')] });
      const res = await callFunction(POST, database, OWNER, {
        action: 'updateMany',
        pageId: 'p1',
        updates: [
          { id: 'b1', patch: { parentId: 'b2' } },
          { id: 'b2', patch: { position: 2 } },
        ],
      });
      await expectErrorResponse(res, 400, 'cannot combine structural block moves');
      expect(database.tables.blocks.map((block) => block.parentId)).toEqual([null, null]);
    });
  });

  describe('delete', () => {
    it('deletes the block together with nested children', async () => {
      const database = db({
        blocks: [
          blockRow('b1'),
          blockRow('b2', { parentId: 'b1' }),
          blockRow('b3', { parentId: 'b2' }),
          blockRow('b4'),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'delete',
        id: 'b1',
        pageId: 'p1',
      })) as { deletedIds: string[] };
      expect(res.deletedIds.sort()).toEqual(['b1', 'b2', 'b3']);
      expect(database.tables.blocks.map((block) => block.id)).toEqual(['b4']);
    });

    it('pairs subtree deletion with durable cleanup states for every stored upload', async () => {
      const childKey = 'workspaces/ws1/blocks/audio/upload-audio.mp3';
      const database = db({
        blocks: [
          blockRow('b1', { content: { url: FILE_KEY } }),
          blockRow('b2', { parentId: 'b1', content: { url: childKey } }),
        ],
        file_uploads: [
          {
            id: 'upload-image', workspaceId: 'ws1', pageId: 'p1', blockId: 'b1',
            bucket: 'files', key: FILE_KEY, status: 'uploaded', completedAt: T0,
          },
          {
            id: 'upload-audio', workspaceId: 'ws1', pageId: 'p1', blockId: 'b2',
            bucket: 'files', key: childKey, status: 'uploaded', completedAt: T0,
          },
        ],
      });

      await callFunction(POST, database, OWNER, {
        action: 'delete', id: 'b1', pageId: 'p1',
      });
      expect(database.tables.blocks).toEqual([]);
      expect(database.tables.file_uploads).toEqual([
        expect.objectContaining({ status: 'deleting', deletionPreviousStatus: 'uploaded' }),
        expect.objectContaining({ status: 'deleting', deletionPreviousStatus: 'uploaded' }),
      ]);
    });

    it('deleteMany rejects non-string ids at the entry', async () => {
      const database = db({ blocks: [blockRow('b1')] });
      const res = await callFunction(POST, database, OWNER, {
        action: 'deleteMany',
        pageId: 'p1',
        ids: [123],
      });
      await expectErrorResponse(res, 400, 'ids[0] is required.');
      expect(database.tables.blocks).toHaveLength(1);
    });

    it('deleteMany commits all requested subtrees in one transaction', async () => {
      const database = db({
        blocks: [blockRow('b1'), blockRow('b2', { parentId: 'b1' }), blockRow('b3')],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'deleteMany',
        pageId: 'p1',
        ids: ['b1', 'b3'],
      })) as { deletedIds: string[] };
      expect(res.deletedIds.sort()).toEqual(['b1', 'b2', 'b3']);
      expect(database.tables.blocks).toHaveLength(0);
    });
  });
});
