import { describe, expect, it } from 'vitest';
import { POST as BLOCK_POST } from '../../functions/block-mutation';
import { POST as PAGE_POST } from '../../functions/page-mutation';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
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
    updatedAt: T0,
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

// Wraps a fake db so that deleting a specific block id throws a real failure
// (not a 404), exercising the partial-failure path where bestEffort() returns
// false. Block deletes route through the change-logged bounded db as a
// transact op, so the failure is injected at the transact layer.
function withFailingBlockDelete(database: FakeDb, failingId: string): FakeDb {
  const originalTransact = database.transact.bind(database);
  database.transact = ((operations: Parameters<FakeDb['transact']>[0]) => {
    if (operations.some((op) => op.op === 'delete' && op.table === 'blocks' && op.id === failingId)) {
      throw new Error('Simulated storage failure.');
    }
    return originalTransact(operations);
  }) as FakeDb['transact'];
  return database;
}

describe('block-page integrity guards', () => {
  // FIX #22: a cross-page block move must carry the whole descendant subtree.
  describe('cross-page block move (#22)', () => {
    it('cascades pageId to every descendant so children are not orphaned', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [
          blockRow('b1'),
          blockRow('b2', { parentId: 'b1' }),
          blockRow('b3', { parentId: 'b2' }),
          blockRow('other'),
        ],
      });

      const res = (await callFunction(BLOCK_POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        patch: { pageId: 'p2' },
      })) as { block: Row };

      expect(res.block.pageId).toBe('p2');
      const byId = Object.fromEntries(database.tables.blocks.map((b) => [b.id, b]));
      // The moved block and its full subtree now live on the target page.
      expect(byId.b1.pageId).toBe('p2');
      expect(byId.b2.pageId).toBe('p2');
      expect(byId.b3.pageId).toBe('p2');
      // Parent links inside the subtree are preserved (not orphaned).
      expect(byId.b2.parentId).toBe('b1');
      expect(byId.b3.parentId).toBe('b2');
      // An unrelated block on the source page is untouched.
      expect(byId.other.pageId).toBe('p1');
    });

    it('moves a nested block to another page top level with an explicit parentId: null', async () => {
      // `patch.parentId ?? current.parentId` conflated explicit null with
      // absent and asserted the OLD parent against the NEW page (404).
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [blockRow('b1'), blockRow('b2', { parentId: 'b1' })],
      });

      const res = (await callFunction(BLOCK_POST, database, OWNER, {
        action: 'update',
        id: 'b2',
        pageId: 'p1',
        patch: { pageId: 'p2', parentId: null },
      })) as { block: Row };

      expect(res.block.pageId).toBe('p2');
      const moved = database.tables.blocks.find((b) => b.id === 'b2');
      expect(moved?.pageId).toBe('p2');
      expect(moved?.parentId).toBeNull();
    });

    it('commits root and descendant re-stamps atomically (no orphaned children on failure)', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [blockRow('b1'), blockRow('b2', { parentId: 'b1' })],
      });
      // Fail any transact touching the descendant: the whole move must roll
      // back rather than leave b2 stranded on the source page while b1 moved.
      const originalTransact = database.transact.bind(database);
      database.transact = (async (operations: Parameters<FakeDb['transact']>[0]) => {
        if (operations.some((op) => op.op === 'update' && op.table === 'blocks' && op.id === 'b2')) {
          throw new Error('Simulated storage failure.');
        }
        return originalTransact(operations);
      }) as FakeDb['transact'];

      const res = await callFunction(BLOCK_POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        patch: { pageId: 'p2' },
      });

      await expectErrorResponse(res, 500, 'Internal server error.');
      const byId = Object.fromEntries(database.tables.blocks.map((b) => [b.id, b]));
      expect(byId.b1.pageId).toBe('p1');
      expect(byId.b2.pageId).toBe('p1');
    });

    it('leaves a childless block move as a single re-stamp', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [blockRow('b1')],
      });

      await callFunction(BLOCK_POST, database, OWNER, {
        action: 'update',
        id: 'b1',
        pageId: 'p1',
        patch: { pageId: 'p2' },
      });

      expect(database.tables.blocks[0].pageId).toBe('p2');
    });
  });

  // FIX #23 follow-up: the whole cascade is now one transaction, so a failed
  // delete leaves neither the root nor a child partially removed.
  describe('deleteBlock atomic failure (#23)', () => {
    it('reports the storage failure and rolls the whole cascade back', async () => {
      const database = withFailingBlockDelete(
        db({
          blocks: [
            blockRow('b1'),
            blockRow('b2', { parentId: 'b1' }),
          ],
        }),
        'b2',
      );

      const res = await callFunction(BLOCK_POST, database, OWNER, {
        action: 'delete',
        id: 'b1',
        pageId: 'p1',
      });

      await expectErrorResponse(res, 500, 'Internal server error.');
      expect(database.tables.blocks.map((b) => b.id).sort()).toEqual(['b1', 'b2']);
    });

    it('still deletes cleanly when every cascade delete succeeds', async () => {
      const database = db({
        blocks: [blockRow('b1'), blockRow('b2', { parentId: 'b1' })],
      });

      const res = (await callFunction(BLOCK_POST, database, OWNER, {
        action: 'delete',
        id: 'b1',
        pageId: 'p1',
      })) as { deletedIds: string[] };

      expect(res.deletedIds.sort()).toEqual(['b1', 'b2']);
      expect(database.tables.blocks).toHaveLength(0);
    });
  });

  // FIX #24: optional optimistic-concurrency guard on page property updates.
  describe('updatePage optimistic concurrency (#24)', () => {
    it('rejects a mismatched expectedUpdatedAt with a conflict', async () => {
      const database = db({ pages: [pageRow('p1', { updatedAt: T0 })] });

      const res = await callFunction(PAGE_POST, database, OWNER, {
        action: 'update',
        id: 'p1',
        expectedUpdatedAt: '2026-06-01T00:00:00.000Z',
        patch: { title: 'Stale rename' },
      });

      await expectErrorResponse(res, 409, 'Page changed since it was loaded.');
      // The stale write did not land.
      expect(database.tables.pages[0].title).toBe('Page p1');
    });

    it('applies the update when expectedUpdatedAt matches', async () => {
      const database = db({ pages: [pageRow('p1', { updatedAt: T0 })] });

      const res = (await callFunction(PAGE_POST, database, OWNER, {
        action: 'update',
        id: 'p1',
        expectedUpdatedAt: T0,
        patch: { title: 'Fresh rename' },
      })) as { page: Row };

      expect(res.page.title).toBe('Fresh rename');
    });

    it('preserves last-write-wins when expectedUpdatedAt is absent', async () => {
      const database = db({ pages: [pageRow('p1', { updatedAt: T0 })] });

      const res = (await callFunction(PAGE_POST, database, OWNER, {
        action: 'update',
        id: 'p1',
        patch: { title: 'Unguarded rename' },
      })) as { page: Row };

      expect(res.page.title).toBe('Unguarded rename');
    });
  });
});
