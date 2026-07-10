import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/page-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

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
          pageRow('p1', { inTrash: true, trashedAt: '2026-01-02T00:00:00.000Z' }),
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
    });
  });

  describe('delete', () => {
    it('permanently deletes the subtree and its content rows', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2', { parentId: 'p1', parentType: 'page' })],
        blocks: [
          { id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 },
          { id: 'b2', pageId: 'p2', type: 'paragraph', position: 0 },
        ],
        comments: [{ id: 'c1', pageId: 'p1', authorId: OWNER }],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'delete',
        id: 'p1',
      })) as { deletedIds: string[]; cleanup: Record<string, number> };
      expect(res.deletedIds.sort()).toEqual(['p1', 'p2']);
      expect(res.cleanup.blocks).toBe(2);
      expect(res.cleanup.comments).toBe(1);
      expect(database.tables.pages).toHaveLength(0);
      expect(database.tables.blocks).toHaveLength(0);
      expect(database.tables.comments).toHaveLength(0);
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
      const database = db({ pages: [pageRow('p1')], blocks });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'delete',
        id: 'p1',
      })) as { deletedIds: string[]; cleanup: Record<string, number> };
      expect(res.deletedIds).toEqual(['p1']);
      expect(res.cleanup.blocks).toBe(300);
      expect(database.tables.pages).toHaveLength(0);
      expect(database.tables.blocks).toHaveLength(0);
    });

    it('is blocked by an active organization legal hold', async () => {
      const database = fakeDb({
        workspaces: [workspaceRow({ organizationId: 'org1' })],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_legal_holds: [
          { id: 'hold1', organizationId: 'org1', name: 'Litigation A', status: 'active', scope: { all: true } },
        ],
        pages: [pageRow('p1')],
      });
      const res = await callFunction(POST, database, OWNER, { action: 'delete', id: 'p1' });
      await expectErrorResponse(res, 400, 'Active legal hold prevents permanent deletion: Litigation A');
      expect(database.tables.pages).toHaveLength(1);
    });
  });
});
