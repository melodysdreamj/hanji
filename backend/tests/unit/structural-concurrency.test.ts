import { describe, expect, it } from 'vitest';

import { POST as blockMutation } from '../../functions/block-mutation';
import { POST as databaseMutation } from '../../functions/database-mutation';
import { POST as databaseRowMutation } from '../../functions/database-row-mutation';
import { fakeDb, type FakeDb, type FakeTransactOperation, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const T0 = '2026-01-01T00:00:00.000Z';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pauseMatchingTransaction(
  database: FakeDb,
  matches: (operations: FakeTransactOperation[]) => boolean,
) {
  const entered = deferred();
  const release = deferred();
  const original = database.transact.bind(database);
  let paused = false;
  database.transact = async (operations) => {
    if (!paused && matches(operations)) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return original(operations);
  };
  return { entered: entered.promise, release: release.resolve };
}

function signalNextWorkspaceLeaseRead(database: FakeDb) {
  const seen = deferred();
  const originalTable = database.table.bind(database);
  let signaled = false;
  database.table = ((name: string) => {
    const table = originalTable(name);
    if (name !== 'file_workspace_locks') return table;
    return {
      ...table,
      getOne: async (id: string) => {
        if (!signaled) {
          signaled = true;
          seen.resolve();
        }
        return table.getOne(id);
      },
    };
  }) as typeof database.table;
  return seen.promise;
}

async function expectPromptSignal(signal: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not join the workspace lease.`)), 500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function databaseFixture() {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    pages: [
      {
        id: 'db1', workspaceId: 'ws1', parentId: null, parentType: 'workspace',
        kind: 'database', title: 'Database', position: 0, inTrash: false,
        createdBy: OWNER, updatedAt: T0,
      },
      {
        id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database',
        kind: 'page', title: 'Existing', position: 0, inTrash: false,
        createdBy: OWNER, updatedAt: T0,
        properties: { title: 'Existing', status: 'before' },
      },
    ],
    db_properties: [
      { id: 'title', databaseId: 'db1', name: 'Name', type: 'title', position: 0, updatedAt: T0 },
      { id: 'status', databaseId: 'db1', name: 'Status', type: 'rich_text', position: 1, updatedAt: T0 },
    ],
    db_templates: [],
    file_uploads: [],
  });
}

async function startPausedPropertyDelete(database: FakeDb) {
  const gate = pauseMatchingTransaction(database, (operations) => operations.some((operation) => (
    operation.table === 'db_properties'
    && operation.op === 'delete'
    && operation.id === 'status'
  )));
  const deletion = callFunction(databaseMutation, database, OWNER, {
    action: 'delete',
    workspaceId: 'ws1',
    databaseId: 'db1',
    table: 'db_properties',
    id: 'status',
  });
  await gate.entered;
  return { deletion, release: gate.release };
}

describe('database row/schema serialization', () => {
  it('re-reads schema after a concurrent property tombstone before creating a row', async () => {
    const database = databaseFixture();
    const { deletion, release } = await startPausedPropertyDelete(database);
    const leaseRead = signalNextWorkspaceLeaseRead(database);

    const creation = callFunction(databaseRowMutation, database, OWNER, {
      action: 'create', databaseId: 'db1', id: 'row-new', empty: true,
      properties: { status: 'stale-create' },
    });
    await expectPromptSignal(leaseRead, 'database row create');
    release();

    await expect(deletion).resolves.toMatchObject({ deletedId: 'status' });
    await expectErrorResponse(await creation, 400, 'Unknown database property: status');
    expect(database.tables.db_properties.some((property) => property.id === 'status')).toBe(false);
    expect(database.tables.pages.some((page) => page.id === 'row-new')).toBe(false);
  });

  it('re-reads schema after a concurrent property tombstone before updating a row', async () => {
    const database = databaseFixture();
    const { deletion, release } = await startPausedPropertyDelete(database);
    const leaseRead = signalNextWorkspaceLeaseRead(database);

    const update = callFunction(databaseRowMutation, database, OWNER, {
      action: 'update', id: 'row1', databaseId: 'db1',
      patch: { properties: { status: 'stale-update' } },
    });
    await expectPromptSignal(leaseRead, 'database row update');
    release();

    await expect(deletion).resolves.toMatchObject({ deletedId: 'status' });
    await expectErrorResponse(await update, 400, 'Unknown database property: status');
    expect(database.tables.pages.find((page) => page.id === 'row1')?.properties)
      .toEqual({ title: 'Existing' });
  });
});

function pageRow(id: string): Row {
  return {
    id, workspaceId: 'ws1', parentId: null, parentType: 'workspace', kind: 'page',
    title: id, position: 0, inTrash: false, createdBy: OWNER, updatedAt: T0,
  };
}

function blockRow(id: string, pageId: string, parentId: string | null = null): Row {
  return {
    id, pageId, parentId, type: 'paragraph', plainText: id, position: 0,
    createdBy: OWNER, createdAt: T0, updatedAt: T0,
  };
}

function blockFixture() {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    pages: [pageRow('p1'), pageRow('p2')],
    blocks: [
      blockRow('delete-root', 'p1'),
      blockRow('mover', 'p1'),
      blockRow('target-root', 'p2'),
    ],
    file_uploads: [],
  });
}

async function startPausedBlockDelete(database: FakeDb, id: string) {
  const gate = pauseMatchingTransaction(database, (operations) => operations.some((operation) => (
    operation.table === 'blocks' && operation.op === 'delete' && operation.id === id
  )));
  const deletion = callFunction(blockMutation, database, OWNER, {
    action: 'delete', id, pageId: id === 'target-root' ? 'p2' : 'p1',
  });
  await gate.entered;
  return { deletion, release: gate.release };
}

describe('block structural mutation/subtree deletion serialization', () => {
  it('preflights createMany base operations before acquiring a workspace lease', async () => {
    const database = blockFixture();
    const original = database.transact.bind(database);
    let transactCalls = 0;
    database.transact = async (operations) => {
      transactCalls += 1;
      return original(operations);
    };
    const creation = await callFunction(blockMutation, database, OWNER, {
      action: 'createMany', pageId: 'p1',
      blocks: Array.from({ length: 120 }, (_, index) => ({
        id: `large-create-${index}`, pageId: 'p1', parentId: null,
        type: 'paragraph', position: index,
      })),
    });

    await expectErrorResponse(creation, 413, 'too many records or stored files');
    expect(transactCalls).toBe(0);
    expect(database.tables.blocks.some((block) => String(block.id).startsWith('large-create-')))
      .toBe(false);
  });

  it('CAS-rejects a concurrent single-block edit instead of overwriting it', async () => {
    const database = blockFixture();
    const original = database.transact.bind(database);
    let injected = false;
    database.transact = async (operations) => {
      if (!injected && operations.some((operation) => (
        operation.table === 'blocks' && operation.op === 'update' && operation.id === 'mover'
      ))) {
        injected = true;
        Object.assign(database.tables.blocks.find((block) => block.id === 'mover')!, {
          plainText: 'concurrent edit', updatedAt: '2026-01-01T00:00:01.000Z',
        });
      }
      return original(operations);
    };

    const update = await callFunction(blockMutation, database, OWNER, {
      action: 'update', id: 'mover', pageId: 'p1', expectedUpdatedAt: T0,
      patch: { plainText: 'stale overwrite' },
    });

    await expectErrorResponse(update, 409, 'Transaction expectation failed');
    expect(database.tables.blocks.find((block) => block.id === 'mover')).toMatchObject({
      plainText: 'concurrent edit', updatedAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('CAS-rejects updateMany when any block changes after prevalidation', async () => {
    const database = blockFixture();
    const original = database.transact.bind(database);
    let injected = false;
    database.transact = async (operations) => {
      if (!injected && operations.some((operation) => (
        operation.table === 'blocks' && operation.op === 'update' && operation.id === 'mover'
      ))) {
        injected = true;
        Object.assign(database.tables.blocks.find((block) => block.id === 'target-root')!, {
          plainText: 'concurrent batch edit', updatedAt: '2026-01-01T00:00:01.000Z',
        });
      }
      return original(operations);
    };

    const update = await callFunction(blockMutation, database, OWNER, {
      action: 'updateMany', pageId: 'p1', updates: [
        { id: 'mover', expectedUpdatedAt: T0, patch: { plainText: 'first stale edit' } },
        { id: 'target-root', expectedUpdatedAt: T0, patch: { plainText: 'second stale edit' } },
      ],
    });

    await expectErrorResponse(update, 409, 'Transaction expectation failed');
    expect(database.tables.blocks.find((block) => block.id === 'mover')?.plainText).toBe('mover');
    expect(database.tables.blocks.find((block) => block.id === 'target-root')).toMatchObject({
      plainText: 'concurrent batch edit', updatedAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('rejects a block update when its page becomes locked before commit', async () => {
    const database = blockFixture();
    const original = database.transact.bind(database);
    let injected = false;
    database.transact = async (operations) => {
      if (!injected && operations.some((operation) => (
        operation.table === 'blocks' && operation.op === 'update' && operation.id === 'mover'
      ))) {
        injected = true;
        database.tables.pages.find((page) => page.id === 'p1')!.isLocked = true;
      }
      return original(operations);
    };

    const update = await callFunction(blockMutation, database, OWNER, {
      action: 'update', id: 'mover', pageId: 'p1', expectedUpdatedAt: T0,
      patch: { plainText: 'must not commit' },
    });

    await expectErrorResponse(update, 409, 'Transaction expectation failed');
    expect(database.tables.blocks.find((block) => block.id === 'mover')?.plainText).toBe('mover');
  });

  it('rejects a cross-page move when the source page becomes locked before commit', async () => {
    const database = blockFixture();
    const original = database.transact.bind(database);
    let injected = false;
    database.transact = async (operations) => {
      if (!injected && operations.some((operation) => (
        operation.table === 'blocks' && operation.op === 'update' && operation.id === 'mover'
      ))) {
        injected = true;
        database.tables.pages.find((page) => page.id === 'p1')!.isLocked = true;
      }
      return original(operations);
    };

    const move = await callFunction(blockMutation, database, OWNER, {
      action: 'update', id: 'mover', pageId: 'p1', expectedUpdatedAt: T0,
      patch: { pageId: 'p2', parentId: null },
    });

    await expectErrorResponse(move, 409, 'Transaction expectation failed');
    expect(database.tables.blocks.find((block) => block.id === 'mover')).toMatchObject({
      pageId: 'p1', parentId: null,
    });
  });

  it('rejects an oversized cross-page subtree before moving any descendant', async () => {
    const blocks = Array.from({ length: 121 }, (_, index) => blockRow(
      `move-${index}`,
      'p1',
      index === 0 ? null : `move-${index - 1}`,
    ));
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [pageRow('p1'), pageRow('p2')],
      blocks,
      file_uploads: [],
    });

    const move = await callFunction(blockMutation, database, OWNER, {
      action: 'update', id: 'move-0', pageId: 'p1', expectedUpdatedAt: T0,
      patch: { pageId: 'p2', parentId: null },
    });

    await expectErrorResponse(move, 413, 'too large to move atomically');
    expect(database.tables.blocks).toHaveLength(blocks.length);
    expect(database.tables.blocks.every((block) => block.pageId === 'p1')).toBe(true);
    expect(database.tables.blocks.slice(1).every((block, index) => (
      block.parentId === `move-${index}`
    ))).toBe(true);
  });

  it('fails a delete transaction if an uncoordinated child appears after its snapshot', async () => {
    const database = blockFixture();
    const original = database.transact.bind(database);
    let injected = false;
    database.transact = async (operations) => {
      if (!injected && operations.some((operation) => (
        operation.table === 'blocks'
        && operation.op === 'delete'
        && operation.id === 'delete-root'
      ))) {
        injected = true;
        database.tables.blocks.push(blockRow('uncoordinated-child', 'p1', 'delete-root'));
      }
      return original(operations);
    };

    const deletion = await callFunction(blockMutation, database, OWNER, {
      action: 'delete', id: 'delete-root', pageId: 'p1',
    });

    await expectErrorResponse(deletion, 409, 'Transaction expectation failed');
    expect(database.tables.blocks.find((block) => block.id === 'delete-root')).toBeTruthy();
    expect(database.tables.blocks.find((block) => block.id === 'uncoordinated-child'))
      .toMatchObject({ parentId: 'delete-root' });
  });

  it('does not create a child below a concurrently deleted parent', async () => {
    const database = blockFixture();
    const { deletion, release } = await startPausedBlockDelete(database, 'delete-root');
    const leaseRead = signalNextWorkspaceLeaseRead(database);
    const creation = callFunction(blockMutation, database, OWNER, {
      action: 'create', id: 'late-child', pageId: 'p1', parentId: 'delete-root',
      type: 'paragraph', position: 1,
    });
    await expectPromptSignal(leaseRead, 'block create');
    release();

    await expect(deletion).resolves.toMatchObject({ deletedIds: ['delete-root'] });
    await expectErrorResponse(await creation, 404, 'Parent block was not found');
    expect(database.tables.blocks.some((block) => block.id === 'late-child')).toBe(false);
  });

  it('does not createMany below a concurrently deleted parent', async () => {
    const database = blockFixture();
    const { deletion, release } = await startPausedBlockDelete(database, 'delete-root');
    const leaseRead = signalNextWorkspaceLeaseRead(database);
    const creation = callFunction(blockMutation, database, OWNER, {
      action: 'createMany', pageId: 'p1', blocks: [
        { id: 'late-parent', pageId: 'p1', parentId: 'delete-root', type: 'paragraph', position: 1 },
        { id: 'late-child', pageId: 'p1', parentId: 'late-parent', type: 'paragraph', position: 2 },
      ],
    });
    await expectPromptSignal(leaseRead, 'block createMany');
    release();

    await expect(deletion).resolves.toMatchObject({ deletedIds: ['delete-root'] });
    await expectErrorResponse(await creation, 404, 'Parent block was not found');
    expect(database.tables.blocks.some((block) => block.id.startsWith('late-'))).toBe(false);
  });

  it('does not reparent a block below a concurrently deleted parent', async () => {
    const database = blockFixture();
    const { deletion, release } = await startPausedBlockDelete(database, 'delete-root');
    const leaseRead = signalNextWorkspaceLeaseRead(database);
    const update = callFunction(blockMutation, database, OWNER, {
      action: 'update', id: 'mover', pageId: 'p1', expectedUpdatedAt: T0,
      patch: { parentId: 'delete-root' },
    });
    await expectPromptSignal(leaseRead, 'block reparent');
    release();

    await expect(deletion).resolves.toMatchObject({ deletedIds: ['delete-root'] });
    await expectErrorResponse(await update, 404, 'Parent block was not found');
    expect(database.tables.blocks.find((block) => block.id === 'mover')?.parentId).toBeNull();
  });

  it('does not move a subtree below a concurrently deleted target parent', async () => {
    const database = blockFixture();
    const { deletion, release } = await startPausedBlockDelete(database, 'target-root');
    const leaseRead = signalNextWorkspaceLeaseRead(database);
    const move = callFunction(blockMutation, database, OWNER, {
      action: 'update', id: 'mover', pageId: 'p1', expectedUpdatedAt: T0,
      patch: { pageId: 'p2', parentId: 'target-root' },
    });
    await expectPromptSignal(leaseRead, 'cross-page block move');
    release();

    await expect(deletion).resolves.toMatchObject({ deletedIds: ['target-root'] });
    await expectErrorResponse(await move, 404, 'Parent block was not found');
    expect(database.tables.blocks.find((block) => block.id === 'mover')).toMatchObject({
      pageId: 'p1', parentId: null,
    });
  });
});
