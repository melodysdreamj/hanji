import { describe, expect, it } from 'vitest';
import {
  POST,
  databasePropertyDeleteRecoveryData,
  recoverStaleDatabasePropertyDeleteOperations,
} from '../../functions/database-mutation';
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

describe('database-mutation property option integrity', () => {
  function optionDatabase() {
    return db({
      db_properties: [
        { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
        {
          id: 'prop-status-a', databaseId: 'db-a', name: 'Status', type: 'status', position: 2,
          config: {
            options: [
              { id: 'todo', name: 'To do', color: 'gray' },
              { id: 'done', name: 'Done', color: 'green' },
            ],
          },
        },
        {
          id: 'prop-tags-a', databaseId: 'db-a', name: 'Tags', type: 'multi_select', position: 3,
          config: { options: [{ id: 'important', name: 'Important', color: 'red' }] },
        },
      ],
    });
  }

  it('rejects direct API removal of an option while preserving the durable schema', async () => {
    const database = optionDatabase();
    const response = await callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_properties', id: 'prop-status-a',
      databaseId: 'db-a',
      patch: { config: { options: [{ id: 'done', name: 'Done', color: 'green' }] } },
    });

    await expectErrorResponse(response, 409, 'options cannot be deleted');
    expect((database.tables.db_properties.find((item) => item.id === 'prop-status-a')?.config as Row)
      .options).toHaveLength(2);
  });

  it('rejects option removal in updateMany without committing an earlier safe update', async () => {
    const database = optionDatabase();
    const response = await callFunction(POST, database, OWNER, {
      action: 'updateMany', workspaceId: 'ws1', table: 'db_properties', databaseId: 'db-a',
      updates: [
        { id: 'prop-status-a', patch: { name: 'Renamed status' } },
        { id: 'prop-tags-a', patch: { config: { options: [] } } },
      ],
    });

    await expectErrorResponse(response, 409, 'options cannot be deleted');
    expect(database.tables.db_properties.find((item) => item.id === 'prop-status-a')?.name)
      .toBe('Status');
    expect((database.tables.db_properties.find((item) => item.id === 'prop-tags-a')?.config as Row)
      .options).toHaveLength(1);
  });

  it('still allows option addition, rename, color change, and reorder', async () => {
    const database = optionDatabase();
    const nextOptions = [
      { id: 'done', name: 'Completed', color: 'blue' },
      { id: 'todo', name: 'Backlog', color: 'yellow' },
      { id: 'blocked', name: 'Blocked', color: 'red' },
    ];
    const result = await callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_properties', id: 'prop-status-a',
      databaseId: 'db-a', patch: { config: { options: nextOptions } },
    }) as { record: Row };

    expect((result.record.config as Row).options).toEqual(nextOptions);
  });

  it('rejects malformed or duplicate option ids before writing', async () => {
    const database = optionDatabase();
    const response = await callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_properties', id: 'prop-status-a',
      databaseId: 'db-a',
      patch: {
        config: {
          options: [
            { id: 'todo', name: 'One', color: 'gray' },
            { id: 'todo', name: 'Two', color: 'blue' },
            { id: 'done', name: 'Done', color: 'green' },
          ],
        },
      },
    });

    await expectErrorResponse(response, 400, 'option ids must be unique');
    expect((database.tables.db_properties.find((item) => item.id === 'prop-status-a')?.config as Row)
      .options).toHaveLength(2);
  });

  it.each([
    ['surrounding-whitespace id', { id: ' todo ', name: 'To do', color: 'gray' }, 'surrounding whitespace'],
    ['missing name', { id: 'todo', color: 'gray' }, 'must have a name'],
    ['blank name', { id: 'todo', name: '   ', color: 'gray' }, 'must have a name'],
    ['missing color', { id: 'todo', name: 'To do' }, 'supported color'],
    ['unknown color', { id: 'todo', name: 'To do', color: 'neon' }, 'supported color'],
  ])('rejects an option with an invalid %s', async (_label, invalidOption, errorText) => {
    const database = optionDatabase();
    const response = await callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_properties', id: 'prop-status-a',
      databaseId: 'db-a',
      patch: {
        config: {
          options: [invalidOption, { id: 'done', name: 'Done', color: 'green' }],
        },
      },
    });

    await expectErrorResponse(response, 400, errorText);
    expect((database.tables.db_properties.find((item) => item.id === 'prop-status-a')?.config as Row)
      .options).toHaveLength(2);
  });
});

describe('database schema deletion fencing', () => {
  function pauseSchemaMutationLease(database: ReturnType<typeof fakeDb>, operation: string) {
    const originalTransact = database.transact.bind(database);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
      const acquiringTargetLease = operations.some((item) =>
        item.table === 'file_workspace_locks'
        && item.op === 'insert'
        && item.data.operation === operation);
      if (!paused && acquiringTargetLease) {
        paused = true;
        entered();
        await releasePromise;
      }
      return originalTransact(operations);
    }) as typeof database.transact;
    return { entered: enteredPromise, release };
  }

  it('rejects a stale view update that waited behind property deletion', async () => {
    const database = db({
      db_views: [{
        id: 'view-1', databaseId: 'db-a', name: 'Table', type: 'table', position: 1,
        config: { visibleProperties: ['prop-title-a'] },
      }],
    });
    const gate = pauseSchemaMutationLease(database, 'database-schema-dependent-update');
    const staleUpdate = callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_views', id: 'view-1',
      patch: { config: { visibleProperties: ['prop-title-a', 'prop-status-a'] } },
    });
    await gate.entered;

    await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', table: 'db_properties', id: 'prop-status-a',
    });
    gate.release();

    await expectErrorResponse(await staleUpdate, 409, 'no longer exists');
    expect(database.tables.db_views[0].config).toEqual({ visibleProperties: ['prop-title-a'] });
  });

  it('rejects a stale template insert that waited behind property deletion', async () => {
    const database = db();
    const gate = pauseSchemaMutationLease(database, 'database-schema-dependent-insert');
    const staleInsert = callFunction(POST, database, OWNER, {
      action: 'insert', workspaceId: 'ws1', table: 'db_templates',
      record: {
        id: 'template-stale', databaseId: 'db-a', name: 'Stale', position: 1,
        properties: { 'prop-status-a': 'todo' },
      },
    });
    await gate.entered;

    await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', table: 'db_properties', id: 'prop-status-a',
    });
    gate.release();

    await expectErrorResponse(await staleInsert, 409, 'no longer exists');
    expect(database.tables.db_templates).toEqual([]);
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
    const database = db({
      db_views: [{
        id: 'view-1', databaseId: 'db-a', name: 'Table', type: 'table', position: 1,
        config: {
          visibleProperties: ['prop-title-a', 'prop-status-a'],
          hiddenProperties: ['prop-status-a'],
          propertyOrder: ['prop-title-a', 'prop-status-a'],
          rowPagePropertyOrder: ['prop-status-a', 'prop-title-a'],
          quickFilters: [
            { propertyId: 'prop-status-a', operator: 'equals', value: 'todo' },
            {
              conjunction: 'and',
              filters: [{ propertyId: 'prop-status-a', operator: 'equals', value: 'todo' }],
              groups: [],
            },
            { propertyId: 'prop-title-a', operator: 'contains', value: 'Row' },
          ],
          chartGroupBy: 'prop-status-a',
          chartAggregateBy: 'prop-status-a',
          templateLinkedRelationPropertyId: 'prop-status-a',
        },
      }],
    });
    const res = (await callFunction(POST, database, OWNER, {
      action: 'delete',
      workspaceId: 'ws1',
      table: 'db_properties',
      id: 'prop-status-a',
    })) as { deletedId: string; cleanup?: { rows: number } };

    expect(res.deletedId).toBe('prop-status-a');
    const row = database.tables.pages.find((page) => page.id === 'row-1');
    expect(row?.properties).toEqual({ 'prop-title-a': 'Row' });
    expect(database.tables.db_views[0].config).toEqual({
      visibleProperties: ['prop-title-a'],
      hiddenProperties: [],
      propertyOrder: ['prop-title-a'],
      rowPagePropertyOrder: ['prop-title-a'],
      quickFilters: [{ propertyId: 'prop-title-a', operator: 'contains', value: 'Row' }],
    });
    expect(database.tables.db_properties.find((prop) => prop.id === 'prop-status-a')).toBeUndefined();
  });

  it('retires row and template uploads even when legacy association fields are missing', async () => {
    const rowKey = 'workspaces/ws1/database/files/row.pdf';
    const templateKey = 'workspaces/ws1/database/files/template.pdf';
    const database = db({
      pages: [
        { id: 'db-a', workspaceId: 'ws1', kind: 'database', parentType: 'workspace', parentId: null, title: 'A' },
        {
          id: 'row-1', workspaceId: 'ws1', kind: 'page', parentType: 'database', parentId: 'db-a',
          title: 'Row', updatedAt: '2026-01-01T00:00:00.000Z',
          properties: { 'prop-title-a': 'Row', 'prop-files': [rowKey] },
        },
      ],
      db_properties: [
        { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
        { id: 'prop-files', databaseId: 'db-a', name: 'Files', type: 'files', position: 2 },
      ],
      db_templates: [{
        id: 'template-1', databaseId: 'db-a', name: 'Template', position: 0,
        properties: { 'prop-files': templateKey },
      }],
      file_uploads: [
        {
          id: 'row-upload', workspaceId: 'ws1', pageId: 'row-1', bucket: 'files',
          key: rowKey, status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z',
          // Legacy row: no propertyId.
        },
        {
          id: 'template-upload', workspaceId: 'ws1', databaseId: 'db-a', propertyId: 'prop-files',
          bucket: 'files', key: templateKey, status: 'uploaded',
          completedAt: '2026-01-01T00:00:00.000Z',
          // Legacy template row: propertyId existed before templateId.
        },
      ],
    });

    await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', table: 'db_properties', id: 'prop-files',
    });
    expect(database.tables.pages.find((page) => page.id === 'row-1')?.properties)
      .toEqual({ 'prop-title-a': 'Row' });
    expect(database.tables.db_templates[0].properties).toEqual({});
    expect(database.tables.file_uploads.map((upload) => upload.status)).toEqual([
      'deleting',
      'deleting',
    ]);
  });

  it.each(['update', 'updateMany'] as const)(
    'rejects files property type changes through %s',
    async (action) => {
      const database = db({
        db_properties: [
          { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
          { id: 'prop-files', databaseId: 'db-a', name: 'Files', type: 'files', position: 2 },
        ],
      });
      const body = action === 'update'
        ? {
            action, workspaceId: 'ws1', table: 'db_properties', id: 'prop-files',
            patch: { type: 'rich_text' },
          }
        : {
            action, workspaceId: 'ws1', table: 'db_properties',
            updates: [{ id: 'prop-files', patch: { type: 'rich_text' } }],
          };
      const response = await callFunction(POST, database, OWNER, body);
      await expectErrorResponse(response, 409, 'Files properties cannot change type');
      expect(database.tables.db_properties.find((prop) => prop.id === 'prop-files')?.type).toBe('files');
    },
  );

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
        const liveRow = database.tables.pages.find((page) => page.id === 'row-1')!;
        Object.assign(liveRow, {
          title: 'Concurrently renamed',
          properties: { ...(liveRow.properties as Record<string, unknown>), 'prop-other': 'kept' },
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

  it('keeps a durable tombstone and resumes after row edits keep racing cleanup', async () => {
    const database = db();
    const row = database.tables.pages.find((page) => page.id === 'row-1')!;
    row.updatedAt = '2026-01-01T00:00:00.000Z';
    const originalTransact = database.transact.bind(database);
    let bumps = 0;
    database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
      if (operations.some((op) => op.op === 'expect' && op.table === 'pages')) {
        bumps += 1;
        const liveRow = database.tables.pages.find((page) => page.id === 'row-1')!;
        liveRow.updatedAt = `2026-01-0${bumps + 1}T00:00:00.000Z`;
      }
      return originalTransact(operations);
    }) as typeof database.transact;

    const res = await callFunction(POST, database, OWNER, {
      action: 'delete',
      workspaceId: 'ws1',
      table: 'db_properties',
      id: 'prop-status-a',
    });

    expect(res).toMatchObject({ deletedId: 'prop-status-a', cleanupPending: true });
    expect(database.tables.db_properties.some((prop) => prop.id === 'prop-status-a')).toBe(false);
    expect(database.tables.file_workspace_locks).toEqual([
      expect.objectContaining({
        workspaceId: 'ws1',
        recoveryData: expect.objectContaining({
          kind: 'database-property-delete-v1',
          property: expect.objectContaining({ id: 'prop-status-a', databaseId: 'db-a' }),
        }),
      }),
    ]);

    database.transact = originalTransact;
    const resumed = await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', databaseId: 'db-a',
      table: 'db_properties', id: 'prop-status-a',
    }) as { deletedId: string };
    expect(resumed.deletedId).toBe('prop-status-a');
    expect(database.tables.pages.find((page) => page.id === 'row-1')?.properties)
      .toEqual({ 'prop-title-a': 'Row' });
    expect(database.tables.file_workspace_locks).toEqual([]);
  });

  it('tombstones first, preserves a durable marker after a later chunk outage, and resumes', async () => {
    const rows = Array.from({ length: 121 }, (_, index) => ({
      id: `row-${index}`,
      workspaceId: 'ws1',
      kind: 'page',
      parentType: 'database',
      parentId: 'db-a',
      title: `Row ${index}`,
      updatedAt: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      properties: { 'prop-title-a': `Row ${index}`, 'prop-status-a': 'todo' },
    }));
    const database = db({
      pages: [
        { id: 'db-a', workspaceId: 'ws1', kind: 'database', parentType: 'workspace', parentId: null, title: 'A' },
        ...rows,
      ],
    });
    const originalTransact = database.transact.bind(database);
    let cleanupChunks = 0;
    let failed = false;
    database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
      if (operations.some((operation) => operation.table === 'pages' && operation.op === 'update')) {
        cleanupChunks += 1;
        if (cleanupChunks === 2 && !failed) {
          failed = true;
          throw new Error('Injected second cleanup chunk outage.');
        }
      }
      return originalTransact(operations);
    }) as typeof database.transact;

    const response = await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', databaseId: 'db-a',
      table: 'db_properties', id: 'prop-status-a',
    });
    expect(response).toMatchObject({ deletedId: 'prop-status-a', cleanupPending: true });
    expect(database.tables.db_properties.some((property) => property.id === 'prop-status-a')).toBe(false);
    expect(database.tables.pages.filter((page) => (
      page.parentId === 'db-a'
      && !('prop-status-a' in (page.properties as Record<string, unknown>))
    ))).toHaveLength(120);
    expect(database.tables.pages.find((page) => page.id === 'row-120')?.properties)
      .toHaveProperty('prop-status-a', 'todo');
    expect(database.tables.file_workspace_locks[0]?.recoveryData).toMatchObject({
      kind: 'database-property-delete-v1',
      property: { id: 'prop-status-a', databaseId: 'db-a' },
    });

    database.transact = originalTransact;
    const resumed = await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', databaseId: 'db-a',
      table: 'db_properties', id: 'prop-status-a',
    }) as { deletedId: string };
    expect(resumed.deletedId).toBe('prop-status-a');
    expect(database.tables.pages.filter((page) => (
      page.parentId === 'db-a'
      && 'prop-status-a' in (page.properties as Record<string, unknown>)
    ))).toEqual([]);
    expect(database.tables.file_workspace_locks).toEqual([]);
  });

  it('preflights every cleanup unit before tombstoning when a late row has too many file transitions', async () => {
    const normalRows = Array.from({ length: 120 }, (_, index) => ({
      id: `normal-row-${index}`,
      workspaceId: 'ws1', kind: 'page', parentType: 'database', parentId: 'db-a',
      updatedAt: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      properties: { 'prop-title-a': `Row ${index}`, 'prop-files': [] },
    }));
    const keys = Array.from(
      { length: 120 },
      (_, index) => `workspaces/ws1/database/files/oversized-${index}.bin`,
    );
    const oversizedRow = {
      id: 'oversized-row', workspaceId: 'ws1', kind: 'page',
      parentType: 'database', parentId: 'db-a', updatedAt: '2026-01-02T00:00:00.000Z',
      properties: { 'prop-title-a': 'Oversized', 'prop-files': keys },
    };
    const uploads = keys.map((key, index) => ({
      id: `oversized-upload-${index}`, workspaceId: 'ws1', pageId: 'oversized-row',
      propertyId: 'prop-files', bucket: 'files', key, status: 'uploaded',
      completedAt: '2026-01-01T00:00:00.000Z',
    }));
    const database = db({
      pages: [
        { id: 'db-a', workspaceId: 'ws1', kind: 'database', parentType: 'workspace', parentId: null, title: 'A' },
        ...normalRows,
        oversizedRow,
      ],
      db_properties: [
        { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
        { id: 'prop-files', databaseId: 'db-a', name: 'Files', type: 'files', position: 2 },
      ],
      file_uploads: uploads,
    });

    const response = await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', databaseId: 'db-a',
      table: 'db_properties', id: 'prop-files',
    });
    await expectErrorResponse(response, 413, 'too many stored files');
    expect(database.tables.db_properties.some((property) => property.id === 'prop-files')).toBe(true);
    expect(database.tables.pages.filter((page) => (
      page.parentId === 'db-a'
      && 'prop-files' in (page.properties as Record<string, unknown>)
    ))).toHaveLength(121);
    expect(database.tables.file_uploads.every((upload) => upload.status === 'uploaded')).toBe(true);
    expect(database.tables.file_workspace_locks).toEqual([]);
  });

  it('keeps a matching property id fenced until deletion recovery finishes', async () => {
    const property = {
      id: 'prop-files', databaseId: 'db-a', name: 'Files', type: 'files', position: 2,
    };
    const marker = databasePropertyDeleteRecoveryData({
      property,
      actorId: OWNER,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const database = db({
      pages: [
        { id: 'db-a', workspaceId: 'ws1', kind: 'database', parentType: 'workspace', parentId: null, title: 'A' },
      ],
      db_properties: [
        { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
      ],
      file_workspace_locks: [{
        id: 'ws1', workspaceId: 'ws1', leaseId: 'failed-delete', actorId: OWNER,
        operation: 'database-property-delete-recovery', recoveryData: marker,
        expiresAt: '2020-01-01T00:00:00.000Z',
      }],
    });

    const blocked = await callFunction(POST, database, OWNER, {
      action: 'insert', workspaceId: 'ws1', table: 'db_properties', record: property,
    });
    await expectErrorResponse(blocked, 409, 'still finishing deletion');
    expect(database.tables.db_properties.some((item) => item.id === property.id)).toBe(false);
    expect(database.tables.file_workspace_locks[0].recoveryData).toMatchObject({
      property: { id: property.id },
    });

    await expect(recoverStaleDatabasePropertyDeleteOperations({
      contentDbs: [{ workspaceId: 'ws1', db: database }],
      now: Date.now(),
    })).resolves.toEqual({ recovered: ['ws1'], failures: [] });
    expect(database.tables.file_workspace_locks).toEqual([]);

    const inserted = await callFunction(POST, database, OWNER, {
      action: 'insert', workspaceId: 'ws1', table: 'db_properties', record: property,
    }) as { record: Row };
    expect(inserted.record).toMatchObject(property);
  });

  it('rejects a different same-id property while deletion recovery owns the id', async () => {
    const property = {
      id: 'prop-recovering', databaseId: 'db-a', name: 'Original', type: 'rich_text', position: 2,
    };
    const database = db({
      file_workspace_locks: [{
        id: 'ws1', workspaceId: 'ws1', leaseId: 'failed-delete', actorId: OWNER,
        operation: 'database-property-delete-recovery',
        recoveryData: databasePropertyDeleteRecoveryData({
          property, actorId: OWNER, startedAt: '2026-01-01T00:00:00.000Z',
        }),
        expiresAt: '2020-01-01T00:00:00.000Z',
      }],
    });

    const response = await callFunction(POST, database, OWNER, {
      action: 'insert', workspaceId: 'ws1', table: 'db_properties',
      record: { ...property, name: 'Different' },
    });
    await expectErrorResponse(response, 409, 'still finishing deletion');
    expect(database.tables.db_properties.some((item) => item.id === property.id)).toBe(false);
    expect(database.tables.file_workspace_locks[0].recoveryData).toMatchObject({
      property: { id: property.id, name: 'Original' },
    });
  });

  it('rejects insertMany before any write when deletion recovery owns a property id', async () => {
    const property = {
      id: 'prop-recovering', databaseId: 'db-a', name: 'Original', type: 'rich_text', position: 2,
    };
    const database = db({
      file_workspace_locks: [{
        id: 'ws1', workspaceId: 'ws1', leaseId: 'failed-delete', actorId: OWNER,
        operation: 'database-property-delete-recovery',
        recoveryData: databasePropertyDeleteRecoveryData({
          property, actorId: OWNER, startedAt: '2026-01-01T00:00:00.000Z',
        }),
        expiresAt: '2020-01-01T00:00:00.000Z',
      }],
    });
    const beforeProperties = structuredClone(database.tables.db_properties);

    const response = await callFunction(POST, database, OWNER, {
      action: 'insertMany', workspaceId: 'ws1', table: 'db_properties',
      records: [
        property,
        { id: 'prop-unrelated', databaseId: 'db-a', name: 'Other', type: 'number', position: 3 },
      ],
    });

    await expectErrorResponse(response, 409, 'cannot be recreated');
    expect(database.tables.db_properties).toEqual(beforeProperties);
    expect(database.tables.file_workspace_locks[0].recoveryData).toMatchObject({
      property: { id: property.id, name: 'Original' },
    });
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

describe('database template stored-file lifecycle', () => {
  const key = 'workspaces/ws1/icons/template.png';

  it('rejects a template file record whose uploadId and key resolve to different uploads', async () => {
    const keyB = 'workspaces/ws1/database/files/template-b.pdf';
    const database = db({
      db_properties: [
        { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
        { id: 'prop-files', databaseId: 'db-a', name: 'Files', type: 'files', position: 2 },
      ],
      db_templates: [{
        id: 'template-1', databaseId: 'db-a', name: 'Template', position: 0,
        properties: { 'prop-files': [] },
      }],
      file_uploads: [
        {
          id: 'upload-a', workspaceId: 'ws1', databaseId: 'db-a', templateId: 'template-1',
          bucket: 'files', key, status: 'uploaded',
        },
        {
          id: 'upload-b', workspaceId: 'ws1', databaseId: 'db-a', templateId: 'template-1',
          bucket: 'files', key: keyB, status: 'uploaded',
        },
      ],
    });

    const response = await callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_templates', id: 'template-1',
      patch: { properties: { 'prop-files': [{ uploadId: 'upload-a', key: keyB }] } },
    });

    await expectErrorResponse(response, 409, 'do not refer to the same upload');
    expect(database.tables.db_templates[0].properties).toEqual({ 'prop-files': [] });
  });

  it('atomically claims a database-only legacy upload for one template and rejects sharing it', async () => {
    const legacyKey = 'workspaces/ws1/database/files/legacy-template.pdf';
    const database = db({
      db_properties: [
        { id: 'prop-title-a', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
        { id: 'prop-files', databaseId: 'db-a', name: 'Files', type: 'files', position: 2 },
      ],
      db_templates: [
        { id: 'template-a', databaseId: 'db-a', name: 'A', position: 0, properties: {} },
        { id: 'template-b', databaseId: 'db-a', name: 'B', position: 1, properties: {} },
      ],
      file_uploads: [{
        id: 'legacy-upload', workspaceId: 'ws1', databaseId: 'db-a', propertyId: 'prop-files',
        bucket: 'files', key: legacyKey, status: 'uploaded',
        completedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    await callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_templates', id: 'template-a',
      patch: { properties: { 'prop-files': [legacyKey] } },
    });
    expect(database.tables.file_uploads[0]).toMatchObject({ templateId: 'template-a' });

    const shared = await callFunction(POST, database, OWNER, {
      action: 'update', workspaceId: 'ws1', table: 'db_templates', id: 'template-b',
      patch: { properties: { 'prop-files': [legacyKey] } },
    });
    await expectErrorResponse(shared, 409, 'metadata is missing or belongs to another target');
    expect(database.tables.db_templates.find((template) => template.id === 'template-b')?.properties)
      .toEqual({});
  });

  it('allows ordinary external image URLs but rejects copying another template stored key', async () => {
    const database = db({
      db_templates: [{ id: 'source-template', databaseId: 'db-a', name: 'Source', icon: key, position: 0 }],
      file_uploads: [{
        id: 'source-upload', workspaceId: 'ws1', databaseId: 'db-a', templateId: 'source-template',
        bucket: 'files', key, status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    const external = await callFunction(POST, database, OWNER, {
      action: 'insert', workspaceId: 'ws1', table: 'db_templates',
      record: {
        id: 'external-template', databaseId: 'db-a', name: 'External',
        icon: 'https://images.example/template.png', position: 1,
      },
    }) as { record: Row };
    expect(external.record.id).toBe('external-template');

    const copied = await callFunction(POST, database, OWNER, {
      action: 'insert', workspaceId: 'ws1', table: 'db_templates',
      record: { id: 'copied-template', databaseId: 'db-a', name: 'Copied', icon: key, position: 2 },
    });
    await expectErrorResponse(copied, 409, 'metadata is missing or belongs to another target');
  });

  it('retires template files on delete and restores them with same-id undo', async () => {
    const database = db({
      db_templates: [{ id: 'template-1', databaseId: 'db-a', name: 'Template', icon: key, position: 0 }],
      file_uploads: [{
        id: 'template-upload', workspaceId: 'ws1', databaseId: 'db-a', templateId: 'template-1',
        bucket: 'files', key, status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    await callFunction(POST, database, OWNER, {
      action: 'delete', workspaceId: 'ws1', table: 'db_templates', id: 'template-1',
    });
    expect(database.tables.db_templates).toEqual([]);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleting', deletionPreviousStatus: 'uploaded',
    });

    await callFunction(POST, database, OWNER, {
      action: 'insert', workspaceId: 'ws1', table: 'db_templates',
      record: { id: 'template-1', databaseId: 'db-a', name: 'Template', icon: key, position: 0 },
    });
    expect(database.tables.db_templates).toHaveLength(1);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded', deletionPreviousStatus: null, expiresAt: null,
    });
  });
});

describe('database-mutation batch atomicity', () => {
  it.each(['insertMany', 'updateMany', 'deleteMany'] as const)(
    '%s rejects an oversized batch before its first transact',
    async (action) => {
      const views = Array.from({ length: 241 }, (_, index) => ({
        id: `view-${index}`, databaseId: 'db-a', name: `View ${index}`,
        type: 'table', position: index,
      }));
      const database = db({ db_views: action === 'insertMany' ? [] : views });
      const originalTransact = database.transact.bind(database);
      let transactCalls = 0;
      database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
        transactCalls += 1;
        return originalTransact(operations);
      }) as typeof database.transact;
      const body = action === 'insertMany'
        ? { action, table: 'db_views', workspaceId: 'ws1', records: views }
        : action === 'updateMany'
          ? {
              action, table: 'db_views', workspaceId: 'ws1', databaseId: 'db-a',
              updates: views.map((view) => ({ id: view.id, patch: { name: `Changed ${view.id}` } })),
            }
          : {
              action, table: 'db_views', workspaceId: 'ws1', databaseId: 'db-a',
              ids: views.map((view) => view.id),
            };

      const response = await callFunction(POST, database, OWNER, body);
      await expectErrorResponse(response, 413, 'Atomic database batch is too large');
      expect(transactCalls).toBe(0);
      if (action === 'insertMany') expect(database.tables.db_views).toEqual([]);
      else expect(database.tables.db_views).toEqual(views);
    },
  );

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
