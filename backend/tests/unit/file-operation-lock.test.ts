import { describe, expect, it, vi } from 'vitest';

import {
  acquireFileWorkspaceLease,
  assertFileTargetsNotDeleting,
  assertFileWorkspaceLease,
  markFileDeletionPending,
  releaseFileWorkspaceLease,
  renewFileWorkspaceLease,
  withFileWorkspaceLease,
} from '../../lib/file-operation-lock';
import { fakeDb } from './helpers/fake-db';

describe('file workspace operation leases', () => {
  it('allows only one of two concurrent acquisitions to own a workspace', async () => {
    const database = fakeDb();
    const results = await Promise.allSettled([
      acquireFileWorkspaceLease(database, 'ws1', 'actor-a', 'upload-a'),
      acquireFileWorkspaceLease(database, 'ws1', 'actor-b', 'upload-b'),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<{ id: string; leaseId: string }> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 409 });
    expect(String(rejected[0].reason)).toContain('Another file operation is already in progress');
    expect(database.tables.file_workspace_locks).toHaveLength(1);

    await releaseFileWorkspaceLease(database, fulfilled[0].value);
    expect(database.tables.file_workspace_locks).toHaveLength(0);
  });

  it('atomically takes over an expired lease instead of waiting for it', async () => {
    const database = fakeDb({
      file_workspace_locks: [{
        id: 'ws1',
        workspaceId: 'ws1',
        leaseId: 'stale-owner',
        actorId: 'old-actor',
        operation: 'old-operation',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }],
    });

    const lease = await acquireFileWorkspaceLease(database, 'ws1', 'new-actor', 'retry-delete');
    expect(lease.id).toBe('ws1');
    expect(lease.leaseId).not.toBe('stale-owner');
    expect(database.tables.file_workspace_locks[0]).toMatchObject({
      id: 'ws1',
      workspaceId: 'ws1',
      leaseId: lease.leaseId,
      actorId: 'new-actor',
      operation: 'retry-delete',
    });
  });

  it('reserves an expired recovery marker for an explicit recovery worker', async () => {
    const marker = { kind: 'duplicate-page-v1', status: 'staging' };
    const database = fakeDb({
      file_workspace_locks: [{
        id: 'ws1',
        workspaceId: 'ws1',
        leaseId: 'crashed-owner',
        actorId: 'old-actor',
        operation: 'duplicate-page',
        recoveryData: marker,
        expiresAt: '2020-01-01T00:00:00.000Z',
      }],
    });

    await expect(acquireFileWorkspaceLease(database, 'ws1', 'actor', 'ordinary-operation'))
      .rejects.toMatchObject({ code: 409 });

    const recoveryLease = await acquireFileWorkspaceLease(
      database,
      'ws1',
      'system:recovery',
      'duplicate-page-recovery',
      { recoverMarkedLease: true },
    );
    expect(database.tables.file_workspace_locks[0]).toMatchObject({
      leaseId: recoveryLease.leaseId,
      recoveryData: marker,
      operation: 'duplicate-page-recovery',
    });
  });

  it('renews only a still-owned, unexpired lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    try {
      const database = fakeDb();
      const lease = await acquireFileWorkspaceLease(database, 'ws1', 'actor', 'long-delete');
      const firstExpiry = String(database.tables.file_workspace_locks[0].expiresAt);

      vi.setSystemTime(new Date('2026-07-11T00:05:00.000Z'));
      await renewFileWorkspaceLease(database, lease);

      const renewedExpiry = String(database.tables.file_workspace_locks[0].expiresAt);
      expect(Date.parse(renewedExpiry)).toBeGreaterThan(Date.parse(firstExpiry));
      await assertFileWorkspaceLease(database, lease);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects assert, renew, and release after another owner takes the row', async () => {
    const database = fakeDb();
    const lostLease = await acquireFileWorkspaceLease(database, 'ws1', 'actor-a', 'upload-a');
    await database.table('file_workspace_locks').update('ws1', {
      leaseId: 'replacement-owner',
      actorId: 'actor-b',
      operation: 'upload-b',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(assertFileWorkspaceLease(database, lostLease)).rejects.toMatchObject({ code: 409 });
    await expect(renewFileWorkspaceLease(database, lostLease)).rejects.toMatchObject({ code: 409 });
    await expect(releaseFileWorkspaceLease(database, lostLease)).rejects.toThrow('expectation failed');
    expect(database.tables.file_workspace_locks[0]).toMatchObject({ leaseId: 'replacement-owner' });
  });

  it('always releases its lease when the protected operation throws', async () => {
    const database = fakeDb();
    await expect(withFileWorkspaceLease(
      database,
      'ws1',
      'actor',
      'failing-operation',
      async (guard) => {
        await guard.assertOwned();
        throw new Error('sentinel operation failure');
      },
    )).rejects.toThrow('sentinel operation failure');
    expect(database.tables.file_workspace_locks).toHaveLength(0);
  });

  it('defers instead of releasing a lease whose partial operation needs recovery', async () => {
    const database = fakeDb();
    const before = Date.now();

    await withFileWorkspaceLease(
      database,
      'ws1',
      'actor',
      'duplicate-page',
      async (guard) => {
        await guard.setRecoveryData({ kind: 'duplicate-page-v1', status: 'staging' });
        guard.preserveForRecovery();
      },
    );

    expect(database.tables.file_workspace_locks).toHaveLength(1);
    expect(database.tables.file_workspace_locks[0]).toMatchObject({
      operation: 'duplicate-page-recovery',
      recoveryData: { kind: 'duplicate-page-v1', status: 'staging' },
    });
    expect(Date.parse(String(database.tables.file_workspace_locks[0].expiresAt))).toBeGreaterThan(before);
  });
});

describe('file deletion fences', () => {
  it('rejects a target when any ancestor page is fenced for deletion', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      pages: [
        {
          id: 'parent',
          workspaceId: 'ws1',
          parentId: null,
          parentType: 'workspace',
          deletionPendingAt: '2026-07-11T00:00:00.000Z',
        },
        {
          id: 'child',
          workspaceId: 'ws1',
          parentId: 'parent',
          parentType: 'page',
        },
      ],
    });

    await expect(assertFileTargetsNotDeleting(database, 'ws1', ['child']))
      .rejects.toMatchObject({ code: 409 });
  });

  it('rejects every target when the workspace itself is fenced', async () => {
    const database = fakeDb({
      workspaces: [{
        id: 'ws1',
        name: 'Workspace',
        deletionPendingAt: '2026-07-11T00:00:00.000Z',
      }],
      pages: [{ id: 'page1', workspaceId: 'ws1', parentId: null, parentType: 'workspace' }],
    });

    await expect(assertFileTargetsNotDeleting(database, 'ws1', ['page1']))
      .rejects.toMatchObject({ code: 409 });
  });

  it.each([
    {
      scenario: 'a snapshotted child already moved out',
      snapshotIds: ['root', 'child'],
      pages: [
        { id: 'root', workspaceId: 'ws1', parentId: null, parentType: 'workspace' },
        { id: 'child', workspaceId: 'ws1', parentId: null, parentType: 'workspace' },
      ],
    },
    {
      scenario: 'an unsnapshotted page already moved in',
      snapshotIds: ['root'],
      pages: [
        { id: 'root', workspaceId: 'ws1', parentId: null, parentType: 'workspace' },
        { id: 'outsider', workspaceId: 'ws1', parentId: 'root', parentType: 'page' },
      ],
    },
  ])('rejects a stale permanent-delete snapshot when $scenario', async ({ snapshotIds, pages }) => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      pages,
    });

    await expect(markFileDeletionPending(database, 'ws1', snapshotIds))
      .rejects.toMatchObject({ code: 409 });
    expect(database.tables.pages.every((page) => !page.deletionPendingAt)).toBe(true);
  });

  it('rechecks topology after fencing and clears partial stamps on a concurrent move-in', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      pages: [
        { id: 'root', workspaceId: 'ws1', parentId: null, parentType: 'workspace' },
        { id: 'child', workspaceId: 'ws1', parentId: 'root', parentType: 'page' },
        { id: 'outsider', workspaceId: 'ws1', parentId: null, parentType: 'workspace' },
      ],
    });
    const originalTable = database.table.bind(database);
    let moveAfterRootFence = true;
    database.table = ((name: string) => {
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
            if (
              id === 'root'
              && typeof data.deletionPendingAt === 'string'
              && moveAfterRootFence
            ) {
              moveAfterRootFence = false;
              await originalTable('pages').update('outsider', {
                parentId: 'root',
                parentType: 'page',
              });
            }
            return updated;
          };
        },
      });
    }) as typeof database.table;

    await expect(markFileDeletionPending(database, 'ws1', ['root', 'child']))
      .rejects.toMatchObject({ code: 409 });
    expect(database.tables.pages.find((page) => page.id === 'root')?.deletionPendingAt).toBeNull();
    expect(database.tables.pages.find((page) => page.id === 'child')?.deletionPendingAt).toBeNull();
    expect(database.tables.pages.find((page) => page.id === 'outsider')).toMatchObject({
      parentId: 'root',
      parentType: 'page',
    });
  });
});
