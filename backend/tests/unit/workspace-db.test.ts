import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_CONTENT_TABLES,
  boundedDb,
  isWorkspaceContentTable,
  type AdminDbAccessor,
} from '../../lib/workspace-db';
import type { DbRef } from '../../lib/app-types';
import { fakeDb } from './helpers/fake-db';

function stubDb(label: string, log: string[], workspaceDeletionPending = false): DbRef {
  return {
    table(name: string) {
      log.push(`${label}:table:${name}`);
      return {
        async getOne(id: string) {
          if (label === 'app' && name === 'workspaces') {
            return {
              id,
              ...(workspaceDeletionPending
                ? { deletionPendingAt: '2026-07-11T00:00:00.000Z' }
                : {}),
            };
          }
          return null;
        },
      } as ReturnType<DbRef['table']>;
    },
    async transact(operations) {
      log.push(`${label}:transact:${operations.map((op) => op.table).join(',')}`);
      return { results: [] };
    },
  } as DbRef;
}

function stubAdmin(log: string[], workspaceDeletionPending = false): AdminDbAccessor {
  return {
    db(namespace: string, instanceId?: string) {
      return stubDb(
        instanceId ? `${namespace}/${instanceId}` : namespace,
        log,
        workspaceDeletionPending,
      );
    },
  };
}

function splitFakeWorkspace() {
  const central = fakeDb({
    workspaces: [{ id: 'ws-42', name: 'Workspace' }],
  });
  const content = fakeDb({ pages: [], change_log: [] });
  const admin: AdminDbAccessor = {
    db(namespace: string, instanceId?: string) {
      if (namespace === 'app') return central as DbRef;
      if (namespace === 'workspace' && instanceId === 'ws-42') return content as DbRef;
      throw new Error(`Unexpected database route: ${namespace}/${instanceId ?? ''}`);
    },
  };
  return { admin, central, content };
}

describe('workspace-db boundary', () => {
  it('classifies the boundary constant consistently', () => {
    expect(isWorkspaceContentTable('pages')).toBe(true);
    expect(isWorkspaceContentTable('blocks')).toBe(true);
    expect(isWorkspaceContentTable('workspaces')).toBe(false);
    expect(isWorkspaceContentTable('organization_members')).toBe(false);
    expect(isWorkspaceContentTable('notifications')).toBe(false);
    expect(WORKSPACE_CONTENT_TABLES).toContain('page_permissions');
    expect(WORKSPACE_CONTENT_TABLES).toContain('share_links');
  });

  it('routes content tables to the workspace instance and the rest centrally', () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log), 'ws-42');
    db.table('pages');
    db.table('blocks');
    db.table('workspaces');
    db.table('organization_members');
    expect(log).toEqual([
      'workspace/ws-42:table:pages',
      'workspace/ws-42:table:blocks',
      'app:table:workspaces',
      'app:table:organization_members',
    ]);
  });

  it('delegates homogeneous transact batches to the matching side', async () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log), 'ws-42');
    await db.transact([
      { table: 'blocks', op: 'delete', id: 'b1' },
      { table: 'pages', op: 'delete', id: 'p1' },
    ]);
    await db.transact([
      { table: 'workspace_members', op: 'delete', id: 'wm1' },
    ]);
    expect(log).toEqual([
      // The central workspace fence is checked before content mutation.
      'app:table:workspaces',
      // Change-log scope resolution reads each mutated record first…
      'workspace/ws-42:table:blocks',
      'workspace/ws-42:table:pages',
      // …then the content batch carries one appended change_log tombstone per
      // logged-table op, atomically. Central batches stay untouched.
      'workspace/ws-42:transact:blocks,pages,change_log,change_log',
      // Re-check after the commit to close the fence race.
      'app:table:workspaces',
      'app:transact:workspace_members',
    ]);
  });

  it('fails content writes closed once workspace deletion is fenced', async () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log, true), 'ws-42');

    await expect(db.transact([
      { table: 'blocks', op: 'delete', id: 'b1' },
    ])).rejects.toMatchObject({ code: 409 });
    expect(log).toEqual(['app:table:workspaces']);
  });

  it('allows the internal permanent-delete cleanup facade to drain fenced content', async () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log, true), 'ws-42', { allowWorkspaceDeletion: true });

    await db.transact([{ table: 'blocks', op: 'delete', id: 'b1' }]);
    expect(log).toEqual([
      'workspace/ws-42:table:blocks',
      'workspace/ws-42:transact:blocks,change_log',
    ]);
  });

  it('rolls back a table insert if the workspace is fenced during the insert window', async () => {
    const { admin, central, content } = splitFakeWorkspace();
    const originalTable = content.table.bind(content);
    content.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'pages') return table;
      return new Proxy(table, {
        get(target, property) {
          if (property !== 'insert') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (data: Record<string, unknown>) => {
            const inserted = await target.insert(data);
            await central.table('workspaces').update('ws-42', {
              deletionPendingAt: '2026-07-11T00:00:00.000Z',
            });
            return inserted;
          };
        },
      });
    }) as typeof content.table;
    const db = boundedDb(admin, 'ws-42');

    await expect(db.table('pages').insert({
      id: 'late-page',
      workspaceId: 'ws-42',
      parentType: 'workspace',
    })).rejects.toMatchObject({ code: 409 });
    expect(content.tables.pages).toHaveLength(0);
    expect(content.tables.change_log).toHaveLength(0);
  });

  it('rolls back rows inserted by a transaction if the fence appears just after commit', async () => {
    const { admin, central, content } = splitFakeWorkspace();
    const originalTransact = content.transact.bind(content);
    let fenceAfterFirstInsert = true;
    content.transact = async (operations) => {
      const result = await originalTransact(operations);
      if (fenceAfterFirstInsert && operations.some((operation) => operation.op === 'insert')) {
        fenceAfterFirstInsert = false;
        await central.table('workspaces').update('ws-42', {
          deletionPendingAt: '2026-07-11T00:00:00.000Z',
        });
      }
      return result;
    };
    const db = boundedDb(admin, 'ws-42');

    await expect(db.transact([{
      table: 'pages',
      op: 'insert',
      data: {
        id: 'late-page',
        workspaceId: 'ws-42',
        parentType: 'workspace',
      },
    }])).rejects.toMatchObject({ code: 409 });
    expect(content.tables.pages).toHaveLength(0);
  });

  it('rejects new or moved content anywhere below a page deletion fence', async () => {
    const { admin, content } = splitFakeWorkspace();
    content.tables.pages.push(
      {
        id: 'parent',
        workspaceId: 'ws-42',
        parentId: null,
        parentType: 'workspace',
        deletionPendingAt: '2026-07-11T00:00:00.000Z',
      },
      {
        id: 'child',
        workspaceId: 'ws-42',
        parentId: 'parent',
        parentType: 'page',
      },
    );
    const db = boundedDb(admin, 'ws-42');

    await expect(db.table('blocks').insert({
      id: 'late-block',
      pageId: 'parent',
    })).rejects.toMatchObject({ code: 409 });
    await expect(db.table('pages').insert({
      id: 'late-child',
      workspaceId: 'ws-42',
      parentId: 'parent',
      parentType: 'page',
    })).rejects.toMatchObject({ code: 409 });
    await expect(db.table('pages').update('child', {
      parentId: 'parent',
      parentType: 'page',
    })).rejects.toMatchObject({ code: 409 });
    await expect(db.table('pages').update('child', {
      parentId: null,
      parentType: 'workspace',
    })).rejects.toMatchObject({ code: 409 });

    expect(content.tables.blocks ?? []).toHaveLength(0);
    expect(content.tables.pages.map((page) => page.id)).toEqual(['parent', 'child']);
  });

  it.each([
    {
      direction: 'out of',
      initialParentId: 'deleting-root',
      initialParentType: 'page',
      nextParentId: 'outside-root',
      nextParentType: 'page',
    },
    {
      direction: 'into',
      initialParentId: 'outside-root',
      initialParentType: 'page',
      nextParentId: 'deleting-root',
      nextParentType: 'page',
    },
  ])('rolls back a table move $direction a subtree when its fence lands after pre-check', async ({
    initialParentId,
    initialParentType,
    nextParentId,
    nextParentType,
  }) => {
    const { admin, content } = splitFakeWorkspace();
    content.tables.pages.push(
      {
        id: 'deleting-root',
        workspaceId: 'ws-42',
        parentId: null,
        parentType: 'workspace',
      },
      {
        id: 'outside-root',
        workspaceId: 'ws-42',
        parentId: null,
        parentType: 'workspace',
      },
      {
        id: 'moving-page',
        workspaceId: 'ws-42',
        parentId: initialParentId,
        parentType: initialParentType,
      },
    );
    const originalTable = content.table.bind(content);
    let injectFence = true;
    content.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'pages') return table;
      return new Proxy(table, {
        get(target, property) {
          if (property !== 'update') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (id: string, data: Record<string, unknown>) => {
            const updated = await target.update(id, data);
            if (id === 'moving-page' && injectFence) {
              injectFence = false;
              await originalTable('pages').update('deleting-root', {
                deletionPendingAt: '2026-07-11T00:00:00.000Z',
              });
            }
            return updated;
          };
        },
      });
    }) as typeof content.table;
    const db = boundedDb(admin, 'ws-42');

    await expect(db.table('pages').update('moving-page', {
      parentId: nextParentId,
      parentType: nextParentType,
    })).rejects.toMatchObject({ code: 409 });

    expect(content.tables.pages.find((page) => page.id === 'moving-page')).toMatchObject({
      parentId: initialParentId,
      parentType: initialParentType,
    });
  });

  it('restores a moved page without clearing a fence written to that same row', async () => {
    const { admin, content } = splitFakeWorkspace();
    content.tables.pages.push(
      {
        id: 'deleting-root',
        workspaceId: 'ws-42',
        parentId: null,
        parentType: 'workspace',
      },
      {
        id: 'outside-root',
        workspaceId: 'ws-42',
        parentId: null,
        parentType: 'workspace',
      },
      {
        id: 'moving-page',
        workspaceId: 'ws-42',
        parentId: 'deleting-root',
        parentType: 'page',
        updatedAt: '2026-07-11T00:00:00.000Z',
      },
    );
    const originalTable = content.table.bind(content);
    let injectFence = true;
    content.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'pages') return table;
      return new Proxy(table, {
        get(target, property) {
          if (property !== 'update') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (id: string, data: Record<string, unknown>) => {
            const updated = await target.update(id, data);
            if (id === 'moving-page' && injectFence) {
              injectFence = false;
              await target.update(id, {
                deletionPendingAt: '2026-07-11T00:01:00.000Z',
                updatedAt: '2026-07-11T00:01:00.000Z',
              });
            }
            return updated;
          };
        },
      });
    }) as typeof content.table;
    const db = boundedDb(admin, 'ws-42');

    await expect(db.table('pages').update('moving-page', {
      parentId: 'outside-root',
      parentType: 'page',
    })).rejects.toMatchObject({ code: 409 });

    expect(content.tables.pages.find((page) => page.id === 'moving-page')).toMatchObject({
      parentId: 'deleting-root',
      parentType: 'page',
      deletionPendingAt: '2026-07-11T00:01:00.000Z',
      updatedAt: '2026-07-11T00:01:00.000Z',
    });
  });

  it('rejects a direct child-row delete when its page ancestry is already fenced', async () => {
    const { admin, content } = splitFakeWorkspace();
    content.tables.pages.push({
      id: 'parent',
      workspaceId: 'ws-42',
      parentId: null,
      parentType: 'workspace',
      deletionPendingAt: '2026-07-11T00:00:00.000Z',
    });
    content.tables.blocks = [{ id: 'block-1', pageId: 'parent', type: 'text' }];
    const db = boundedDb(admin, 'ws-42');

    await expect(db.table('blocks').delete('block-1')).rejects.toMatchObject({ code: 409 });
    expect(content.tables.blocks).toEqual([
      expect.objectContaining({ id: 'block-1', pageId: 'parent' }),
    ]);
  });

  it('atomically rejects a direct delete if the target page is fenced after its pre-check', async () => {
    const { admin, content } = splitFakeWorkspace();
    content.tables.pages.push({
      id: 'parent',
      workspaceId: 'ws-42',
      parentId: null,
      parentType: 'workspace',
    });
    content.tables.blocks = [{ id: 'block-1', pageId: 'parent', type: 'text' }];
    const originalTransact = content.transact.bind(content);
    let injectFence = true;
    content.transact = async (operations) => {
      if (
        injectFence
        && operations.some((operation) =>
          operation.table === 'blocks'
          && operation.op === 'delete'
          && operation.id === 'block-1')
      ) {
        injectFence = false;
        await content.table('pages').update('parent', {
          deletionPendingAt: '2026-07-11T00:00:00.000Z',
        });
      }
      return originalTransact(operations);
    };
    const db = boundedDb(admin, 'ws-42');

    await expect(db.table('blocks').delete('block-1'))
      .rejects.toThrow('Transaction expectation failed');
    expect(content.tables.blocks).toEqual([
      expect.objectContaining({ id: 'block-1', pageId: 'parent' }),
    ]);
  });

  it('rolls back a transact move when the destination is fenced just after commit', async () => {
    const { admin, content } = splitFakeWorkspace();
    content.tables.pages.push(
      {
        id: 'deleting-root',
        workspaceId: 'ws-42',
        parentId: null,
        parentType: 'workspace',
      },
      {
        id: 'outside-root',
        workspaceId: 'ws-42',
        parentId: null,
        parentType: 'workspace',
      },
      {
        id: 'moving-page',
        workspaceId: 'ws-42',
        parentId: 'outside-root',
        parentType: 'page',
      },
    );
    const originalTransact = content.transact.bind(content);
    let injectFence = true;
    content.transact = async (operations) => {
      const result = await originalTransact(operations);
      if (
        injectFence
        && operations.some((operation) =>
          operation.table === 'pages'
          && operation.op === 'update'
          && operation.id === 'moving-page')
      ) {
        injectFence = false;
        await content.table('pages').update('deleting-root', {
          deletionPendingAt: '2026-07-11T00:00:00.000Z',
        });
      }
      return result;
    };
    const db = boundedDb(admin, 'ws-42');

    await expect(db.transact([{
      table: 'pages',
      op: 'update',
      id: 'moving-page',
      data: { parentId: 'deleting-root', parentType: 'page' },
    }])).rejects.toMatchObject({ code: 409 });

    expect(content.tables.pages.find((page) => page.id === 'moving-page')).toMatchObject({
      parentId: 'outside-root',
      parentType: 'page',
    });
  });

  it('rejects transact batches that mix central and workspace tables', async () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log), 'ws-42');
    await expect(
      db.transact([
        { table: 'pages', op: 'delete', id: 'p1' },
        { table: 'workspaces', op: 'delete', id: 'ws-42' },
      ]),
    ).rejects.toThrow('split the batch per side');
    expect(log).toEqual([]);
  });
});
