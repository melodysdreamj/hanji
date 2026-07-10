import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/duplicate-page';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const GUEST = 'guest-1';
const STRANGER = 'stranger-1';

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
    isLocked: false,
    isPublic: false,
    createdBy: OWNER,
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    workspace_members: [
      { id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' },
      { id: 'm2', workspaceId: 'ws1', userId: GUEST, role: 'guest' },
    ],
    pages: [pageRow('p1')],
    ...tables,
  });
}

function duplicate(database: FakeDb, userId: string | null, extra: Record<string, unknown> = {}) {
  return callFunction(POST, database, userId, { action: 'duplicate', pageId: 'p1', ...extra });
}

describe('duplicate-page POST', () => {
  it('requires authentication', async () => {
    const res = await duplicate(db(), null);
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  it('rejects an unknown action', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'bogus', pageId: 'p1' });
    await expectErrorResponse(res, 400, 'Unknown duplicate page action.');
  });

  it('rejects a body without a pageId routing hint', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'duplicate' });
    await expectErrorResponse(res, 400, 'pageId is required.');
  });

  describe('authorization', () => {
    it('denies strangers with no relation to the workspace', async () => {
      const res = await duplicate(db(), STRANGER);
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('denies a view-role workspace guest', async () => {
      const res = await duplicate(db(), GUEST);
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('allows an edit-role workspace member', async () => {
      const database = db();
      const res = (await duplicate(database, MEMBER)) as { page: Row };
      expect(res.page.createdBy).toBe(MEMBER);
    });

    it('allows a stranger holding a direct edit grant on the source page', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'edit',
          },
        ],
      });
      const res = (await duplicate(database, STRANGER)) as { page: Row };
      expect(res.page.title).toBe('Page p1 copy');
    });

    it('denies a stranger whose only grant is view', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'view',
          },
        ],
      });
      const res = await duplicate(database, STRANGER);
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('honors an edit grant inherited from an ancestor page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('child', { parentId: 'p1', parentType: 'page' })],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'edit',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, {
        action: 'duplicate',
        pageId: 'child',
      })) as { page: Row };
      expect(res.page.parentId).toBe('p1');
    });

    it('requires edit access at a different destination, not just on the source', async () => {
      // STRANGER can edit p1 through a direct grant but has no access to p2.
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'edit',
          },
        ],
      });
      const res = await duplicate(database, STRANGER, { parentId: 'p2', parentType: 'page' });
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('rejects deactivated organization members', async () => {
      const database = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_members: [
          { id: 'om1', organizationId: 'org1', userId: MEMBER, status: 'deactivated' },
        ],
        workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' }],
        pages: [pageRow('p1')],
      });
      const res = await duplicate(database, MEMBER);
      await expectErrorResponse(res, 403, 'Organization active access required.');
    });
  });

  describe('source and destination guards', () => {
    it('rejects a source page in trash', async () => {
      const database = db({ pages: [pageRow('p1', { inTrash: true })] });
      const res = await duplicate(database, OWNER);
      await expectErrorResponse(res, 400, 'Page is in trash.');
    });

    it('duplicates a locked source but the copy is unlocked and private', async () => {
      const database = db({ pages: [pageRow('p1', { isLocked: true, isPublic: true })] });
      const res = (await duplicate(database, OWNER)) as { page: Row };
      expect(res.page.isLocked).toBe(false);
      expect(res.page.isPublic).toBe(false);
    });

    it('rejects duplication under a locked parent with 423', async () => {
      const database = db({
        pages: [
          pageRow('parent', { isLocked: true }),
          pageRow('p1', { parentId: 'parent', parentType: 'page' }),
        ],
      });
      const res = await duplicate(database, OWNER);
      await expectErrorResponse(res, 423, 'Parent page "Page parent" is locked.');
    });

    it('rejects a destination parent in trash', async () => {
      const database = db({ pages: [pageRow('p1'), pageRow('p2', { inTrash: true })] });
      const res = await duplicate(database, OWNER, { parentId: 'p2', parentType: 'page' });
      await expectErrorResponse(res, 404, 'Destination parent was not found.');
    });

    it('rejects explicit workspace destinations that carry a parentId', async () => {
      const database = db({ pages: [pageRow('p1'), pageRow('p2')] });
      const res = await duplicate(database, OWNER, { parentId: 'p2', parentType: 'workspace' });
      await expectErrorResponse(res, 400, 'workspace duplicates should omit parentId.');
    });

    it('rejects duplicating a database into a database', async () => {
      const database = db({
        pages: [pageRow('p1', { kind: 'database' }), pageRow('target', { kind: 'database' })],
      });
      const res = await duplicate(database, OWNER, { parentId: 'target', parentType: 'database' });
      await expectErrorResponse(res, 400, 'Only regular pages can be duplicated into a database.');
    });

    it('rejects a database destination whose parent is a plain page', async () => {
      const database = db({ pages: [pageRow('p1'), pageRow('target')] });
      const res = await duplicate(database, OWNER, { parentId: 'target', parentType: 'database' });
      await expectErrorResponse(res, 400, 'Destination parent is not a database.');
    });

    it('rejects duplicating a page inside its own subtree', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('child', { parentId: 'p1', parentType: 'page' })],
      });
      const res = await duplicate(database, OWNER, { parentId: 'child', parentType: 'page' });
      await expectErrorResponse(res, 400, 'Cannot duplicate a page inside itself or one of its descendants.');
    });
  });

  describe('copy semantics', () => {
    it('copies the subtree with fresh ids, remapped block links, and sibling position', async () => {
      const database = db({
        pages: [
          pageRow('p1', { position: 1 }),
          pageRow('sibling', { position: 2 }),
          pageRow('child', { parentId: 'p1', parentType: 'page', position: 1 }),
        ],
        blocks: [
          { id: 'b1', pageId: 'p1', parentId: null, type: 'paragraph', plainText: 'root', position: 1 },
          { id: 'b2', pageId: 'p1', parentId: 'b1', type: 'paragraph', plainText: 'nested', position: 2 },
          {
            id: 'b3',
            pageId: 'p1',
            parentId: null,
            type: 'child_page',
            content: { childPageId: 'child' },
            position: 3,
          },
        ],
      });

      const res = (await duplicate(database, OWNER)) as {
        page: Row;
        pages: Row[];
        blocks: Row[];
        counts: Record<string, number>;
      };

      expect(res.page.title).toBe('Page p1 copy');
      expect(res.page.id).not.toBe('p1');
      // In-place copies land between the source and its next sibling.
      expect(res.page.position).toBe(1.5);
      expect(res.counts).toEqual({ pages: 2, blocks: 3, properties: 0, views: 0, templates: 0 });

      const copiedChild = res.pages.find((page) => page.id !== res.page.id);
      expect(copiedChild?.parentId).toBe(res.page.id);
      expect(copiedChild?.title).toBe('Page child');

      const byText = Object.fromEntries(res.blocks.map((block) => [block.plainText, block]));
      // Nested block parent links are remapped onto the new block ids.
      expect(byText.nested.parentId).toBe(byText.root.id);
      expect(byText.root.id).not.toBe('b1');
      // child_page block content points at the copied child page.
      const childPageBlock = res.blocks.find((block) => block.type === 'child_page');
      expect((childPageBlock?.content as Record<string, unknown>).childPageId).toBe(copiedChild?.id);
      // The source tree is untouched.
      expect(database.tables.pages.filter((page) => page.id === 'p1')).toHaveLength(1);
      expect(database.tables.blocks.filter((block) => block.pageId === 'p1')).toHaveLength(3);
    });

    it('honors a title override', async () => {
      const res = (await duplicate(db(), OWNER, { title: 'Renamed copy' })) as { page: Row };
      expect(res.page.title).toBe('Renamed copy');
    });

    it('copies database schema with remapped property ids and view configs', async () => {
      const database = db({
        pages: [
          pageRow('p1', { kind: 'database' }),
          pageRow('row1', {
            parentId: 'p1',
            parentType: 'database',
            properties: { prop1: 'todo', prop2: ['row1'] },
          }),
        ],
        db_properties: [
          { id: 'prop1', databaseId: 'p1', name: 'Status', type: 'select', position: 1 },
          {
            id: 'prop2',
            databaseId: 'p1',
            name: 'Self link',
            type: 'relation',
            config: { relationDatabaseId: 'p1' },
            position: 2,
          },
        ],
        db_views: [
          {
            id: 'view1',
            databaseId: 'p1',
            name: 'Board',
            type: 'board',
            config: { groupBy: 'prop1', visibleProperties: ['prop1', 'prop2'] },
            position: 1,
          },
        ],
        db_templates: [
          { id: 'tpl1', databaseId: 'p1', name: 'Task', title: 'New task', properties: { prop1: 'todo' }, position: 1 },
        ],
      });

      const res = (await duplicate(database, OWNER)) as {
        page: Row;
        pages: Row[];
        properties: Row[];
        views: Row[];
        templates: Row[];
        counts: Record<string, number>;
      };

      expect(res.counts).toEqual({ pages: 2, blocks: 0, properties: 2, views: 1, templates: 1 });
      const statusCopy = res.properties.find((property) => property.name === 'Status');
      const relationCopy = res.properties.find((property) => property.name === 'Self link');
      expect(statusCopy?.id).not.toBe('prop1');
      expect(statusCopy?.databaseId).toBe(res.page.id);
      // Self-referential relations retarget the copied database.
      expect((relationCopy?.config as Record<string, unknown>).relationDatabaseId).toBe(res.page.id);

      const viewConfig = res.views[0].config as Record<string, unknown>;
      expect(viewConfig.groupBy).toBe(statusCopy?.id);
      expect(viewConfig.visibleProperties).toEqual([statusCopy?.id, relationCopy?.id]);

      // Row property keys and relation values are remapped too.
      const rowCopy = res.pages.find((page) => page.parentType === 'database');
      const rowProperties = rowCopy?.properties as Record<string, unknown>;
      expect(rowProperties[statusCopy?.id as string]).toBe('todo');
      expect(rowProperties[relationCopy?.id as string]).toEqual([rowCopy?.id]);

      const templateCopy = res.templates[0];
      expect(templateCopy.databaseId).toBe(res.page.id);
      expect((templateCopy.properties as Record<string, unknown>)[statusCopy?.id as string]).toBe('todo');
    });

    it('appends to the end when relocating to a different destination', async () => {
      const database = db({
        pages: [
          pageRow('p1', { position: 1 }),
          pageRow('target', { position: 2 }),
          pageRow('existing-child', { parentId: 'target', parentType: 'page', position: 7 }),
        ],
      });
      const res = (await duplicate(database, OWNER, { parentId: 'target', parentType: 'page' })) as {
        page: Row;
      };
      expect(res.page.parentId).toBe('target');
      expect(res.page.parentType).toBe('page');
      expect(res.page.position).toBe(8);
    });

    it('rolls back created rows when a later insert fails', async () => {
      const database = db({
        pages: [pageRow('p1', { kind: 'database' })],
        db_properties: [{ id: 'prop1', databaseId: 'p1', name: 'Status', type: 'select', position: 1 }],
        db_views: [
          { id: 'view1', databaseId: 'p1', name: 'Table', type: 'table', config: {}, position: 1 },
        ],
      });
      const originalTable = database.table.bind(database);
      database.table = ((name: string) => {
        const ref = originalTable(name);
        if (name !== 'db_views') return ref;
        return {
          ...ref,
          insert: async () => {
            throw new Error('Simulated storage failure.');
          },
        };
      }) as typeof database.table;

      const res = await duplicate(database, OWNER);
      await expectErrorResponse(res, 500, 'Internal server error.');
      // Everything created before the failure was rolled back.
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.db_properties.map((property) => property.id)).toEqual(['prop1']);
      expect(database.tables.db_views.map((view) => view.id)).toEqual(['view1']);
    });
  });
});
