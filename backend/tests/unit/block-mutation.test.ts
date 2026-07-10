import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/block-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';
const T0 = '2026-01-01T00:00:00.000Z';

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
