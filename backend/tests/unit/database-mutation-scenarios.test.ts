import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/database-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';

// Two sibling databases in one workspace so cross-database guards are exercised
// against realistic fixtures, plus a row page for cascade checks.
function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    pages: [
      { id: 'db-a', workspaceId: 'ws1', kind: 'database', parentType: 'workspace', parentId: null, title: 'A' },
      { id: 'db-b', workspaceId: 'ws1', kind: 'database', parentType: 'workspace', parentId: null, title: 'B' },
      {
        id: 'row-1',
        workspaceId: 'ws1',
        kind: 'page',
        parentType: 'database',
        parentId: 'db-a',
        title: 'Row',
        properties: { 'prop-status-a': 'todo', 'prop-title-a': 'Row' },
      },
    ],
    db_properties: [
      { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
      { id: 'prop-status-a', databaseId: 'db-a', name: 'Status', type: 'rich_text', position: 2 },
    ],
    ...tables,
  });
}

function updateStatusName(database: ReturnType<typeof fakeDb>, actor: string, extra: Record<string, unknown> = {}) {
  return callFunction(POST, database, actor, {
    action: 'update',
    workspaceId: 'ws1',
    table: 'db_properties',
    id: 'prop-status-a',
    patch: { name: 'Renamed' },
    ...extra,
  });
}

describe('database-mutation cross-database boundary', () => {
  it('rejects an update whose databaseId hint points at a different database', async () => {
    const res = await updateStatusName(db(), OWNER, { databaseId: 'db-b' });
    await expectErrorResponse(res, 400, 'does not belong to the expected database');
  });

  it('accepts the same update when the databaseId hint matches', async () => {
    const res = (await updateStatusName(db(), OWNER, { databaseId: 'db-a' })) as { record: Row };
    expect(res.record.name).toBe('Renamed');
  });
});

describe('database-mutation authorization', () => {
  it('rejects a user with no workspace membership', async () => {
    const res = await updateStatusName(db(), 'intruder-1');
    await expectErrorResponse(res, 403, 'access required');
  });

  it('rejects a guest member (view-only role)', async () => {
    const database = db({
      workspace_members: [{ id: 'wm-1', workspaceId: 'ws1', userId: 'guest-1', role: 'guest' }],
    });
    const res = await updateStatusName(database, 'guest-1');
    await expectErrorResponse(res, 403, 'access required');
  });

  it('allows a regular member to edit', async () => {
    const database = db({
      workspace_members: [{ id: 'wm-2', workspaceId: 'ws1', userId: 'member-1', role: 'member' }],
    });
    const res = (await updateStatusName(database, 'member-1')) as { record: Row };
    expect(res.record.name).toBe('Renamed');
  });

  it('grants edit through an email permission regardless of stored casing', async () => {
    // functionContext derives the actor email as `${userId}@example.com`;
    // the stored permission uses different casing and surrounding whitespace.
    const database = db({
      page_permissions: [
        {
          id: 'perm-1',
          pageId: 'db-a',
          workspaceId: 'ws1',
          principalType: 'email',
          principalId: ' Visitor-1@Example.COM ',
          role: 'edit',
        },
      ],
    });
    const res = (await updateStatusName(database, 'visitor-1')) as { record: Row };
    expect(res.record.name).toBe('Renamed');
  });
});

describe('database-mutation guarded states', () => {
  it('rejects edits to a locked database with a 423', async () => {
    const database = db();
    const dbPage = database.tables.pages.find((page) => page.id === 'db-a');
    if (dbPage) dbPage.isLocked = true;
    const res = await updateStatusName(database, OWNER);
    await expectErrorResponse(res, 423, 'locked');
  });

  it('rejects edits to a trashed database', async () => {
    const database = db();
    const dbPage = database.tables.pages.find((page) => page.id === 'db-a');
    if (dbPage) dbPage.inTrash = true;
    const res = await updateStatusName(database, OWNER);
    await expectErrorResponse(res, 400, 'trash');
  });
});

describe('database-mutation property deletion', () => {
  it('never deletes the title property', async () => {
    const res = await callFunction(POST, db(), OWNER, {
      action: 'delete',
      workspaceId: 'ws1',
      table: 'db_properties',
      id: 'prop-title-a',
    });
    await expectErrorResponse(res, 400, 'title property cannot be deleted');
  });

  it('scrubs a deleted property from existing row values', async () => {
    const database = db();
    const res = (await callFunction(POST, database, OWNER, {
      action: 'delete',
      workspaceId: 'ws1',
      table: 'db_properties',
      id: 'prop-status-a',
    })) as { deletedId: string; cleanup?: { rows: number } };

    expect(res.deletedId).toBe('prop-status-a');
    const row = database.tables.pages.find((page) => page.id === 'row-1');
    expect(row?.properties).toEqual({ 'prop-title-a': 'Row' });
    expect(database.tables.db_properties.find((prop) => prop.id === 'prop-status-a')).toBeUndefined();
  });

  it('retries with fresh row state when a concurrent row edit races the property delete', async () => {
    const database = db();
    const row = database.tables.pages.find((page) => page.id === 'row-1')!;
    row.updatedAt = '2026-01-01T00:00:00.000Z';
    // A concurrent edit lands between the read and the commit: the updatedAt
    // expect must abort the first batch (no silent lost update), and the
    // retry rebuilds from the fresh row so the concurrent change survives.
    const originalTransact = database.transact.bind(database);
    let raced = false;
    database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
      if (!raced && operations.some((op) => op.op === 'expect' && op.table === 'pages')) {
        raced = true;
        Object.assign(row, {
          title: 'Concurrently renamed',
          properties: { ...(row.properties as Record<string, unknown>), 'prop-other': 'kept' },
          updatedAt: '2026-01-02T00:00:00.000Z',
        });
      }
      return originalTransact(operations);
    }) as typeof database.transact;

    const res = (await callFunction(POST, database, OWNER, {
      action: 'delete',
      workspaceId: 'ws1',
      table: 'db_properties',
      id: 'prop-status-a',
    })) as { deletedId: string };

    expect(res.deletedId).toBe('prop-status-a');
    // Re-find: the fake's transact commit replaces the row objects in place.
    const committedRow = database.tables.pages.find((page) => page.id === 'row-1')!;
    expect(committedRow.properties).toEqual({ 'prop-title-a': 'Row', 'prop-other': 'kept' });
    expect(committedRow.title).toBe('Concurrently renamed');
  });

  it('gives up with a conflict when row edits keep racing the property delete', async () => {
    const database = db();
    const row = database.tables.pages.find((page) => page.id === 'row-1')!;
    row.updatedAt = '2026-01-01T00:00:00.000Z';
    const originalTransact = database.transact.bind(database);
    let bumps = 0;
    database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
      if (operations.some((op) => op.op === 'expect' && op.table === 'pages')) {
        bumps += 1;
        row.updatedAt = `2026-01-0${bumps + 1}T00:00:00.000Z`;
      }
      return originalTransact(operations);
    }) as typeof database.transact;

    const res = await callFunction(POST, database, OWNER, {
      action: 'delete',
      workspaceId: 'ws1',
      table: 'db_properties',
      id: 'prop-status-a',
    });

    await expectErrorResponse(res, 409, 'Database rows changed while the property was being deleted.');
    expect(database.tables.db_properties.some((prop) => prop.id === 'prop-status-a')).toBe(true);
  });

  it('rolls back cleanup and reports failure when the primary property delete fails', async () => {
    const database = db({
      db_property_indexes: [{
        id: 'index-status-a',
        workspaceId: 'ws1',
        databaseId: 'db-a',
        rowId: 'row-1',
        propertyId: 'prop-status-a',
      }],
    });
    const originalTransact = database.transact.bind(database);
    database.transact = async (operations) => {
      if (operations.some((operation) => (
        operation.table === 'db_properties'
        && operation.op === 'delete'
        && operation.id === 'prop-status-a'
      ))) {
        throw new Error('Injected property delete failure.');
      }
      return originalTransact(operations);
    };

    const res = await callFunction(POST, database, OWNER, {
      action: 'delete',
      workspaceId: 'ws1',
      table: 'db_properties',
      id: 'prop-status-a',
    });

    await expectErrorResponse(res, 500, 'Internal server error.');
    expect(database.tables.db_properties.some((prop) => prop.id === 'prop-status-a')).toBe(true);
    expect(database.tables.db_property_indexes.some((index) => index.id === 'index-status-a')).toBe(true);
    const row = database.tables.pages.find((page) => page.id === 'row-1');
    expect(row?.properties).toEqual({ 'prop-status-a': 'todo', 'prop-title-a': 'Row' });
  });
});

describe('database-mutation batch atomicity', () => {
  it('insertMany validates every property before inserting any record', async () => {
    const database = db();
    const res = await callFunction(POST, database, OWNER, {
      action: 'insertMany',
      table: 'db_properties',
      records: [
        { id: 'prop-new-1', databaseId: 'db-a', name: 'One', type: 'rich_text', position: 3 },
        { id: 'prop-new-2', databaseId: 'db-a', name: 'Two', type: 'not-real', position: 4 },
      ],
    });
    await expectErrorResponse(res, 400, 'Unsupported database property type');
    expect(database.tables.db_properties.map((property) => property.id).sort()).toEqual([
      'prop-status-a',
      'prop-title-a',
    ]);
  });

  it('updateMany leaves earlier records unchanged when a later record is missing', async () => {
    const database = db();
    const res = await callFunction(POST, database, OWNER, {
      action: 'updateMany',
      table: 'db_properties',
      databaseId: 'db-a',
      updates: [
        { id: 'prop-status-a', patch: { name: 'Should not land' } },
        { id: 'missing-property', patch: { name: 'Missing' } },
      ],
    });
    await expectErrorResponse(res, 404, 'Database record was not found.');
    expect(database.tables.db_properties.find((property) => property.id === 'prop-status-a')?.name).toBe('Status');
  });

  it('deleteMany prevalidates database ownership before deleting any view', async () => {
    const database = db({
      db_views: [
        { id: 'view-a', databaseId: 'db-a', name: 'A', type: 'table', position: 0 },
        { id: 'view-b', databaseId: 'db-b', name: 'B', type: 'table', position: 0 },
      ],
    });
    const res = await callFunction(POST, database, OWNER, {
      action: 'deleteMany',
      table: 'db_views',
      databaseId: 'db-a',
      ids: ['view-a', 'view-b'],
    });
    await expectErrorResponse(res, 400, 'does not belong to the expected database');
    expect(database.tables.db_views.map((view) => view.id).sort()).toEqual(['view-a', 'view-b']);
  });

  it('rejects multi-property schema deletion instead of exposing partial semantics', async () => {
    const database = db({
      db_properties: [
        { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
        { id: 'prop-status-a', databaseId: 'db-a', name: 'Status', type: 'rich_text', position: 2 },
        { id: 'prop-extra-a', databaseId: 'db-a', name: 'Extra', type: 'rich_text', position: 3 },
      ],
    });
    const res = await callFunction(POST, database, OWNER, {
      action: 'deleteMany',
      table: 'db_properties',
      databaseId: 'db-a',
      ids: ['prop-status-a', 'prop-extra-a'],
    });
    await expectErrorResponse(res, 400, 'cannot combine multiple property schema deletions');
    expect(database.tables.db_properties).toHaveLength(3);
  });
});
