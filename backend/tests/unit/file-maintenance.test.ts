import { describe, expect, it, vi } from 'vitest';
import maintenance from '../../functions/file-maintenance';
import { POST as PAGE_POST } from '../../functions/page-mutation';
import { duplicatePageRecoveryData } from '../../lib/duplicate-page-recovery';
import { databasePropertyDeleteRecoveryData } from '../../functions/database-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, handlerOf } from './helpers/function-context';

const PAST = '2020-01-01T00:00:00.000Z';

function expiredPendingUpload(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    bucket: 'files',
    key: `workspaces/ws1/uploads/${id}.bin`,
    name: `${id}.bin`,
    size: 4,
    contentType: 'application/octet-stream',
    etag: `etag-${id}`,
    status: 'pending',
    expiresAt: PAST,
    ...extra,
  };
}

function stalePreparingUpload(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    bucket: 'files',
    key: `workspaces/ws1/uploads/${id}.bin`,
    name: `${id}.bin`,
    status: 'preparing',
    createdAt: PAST,
    updatedAt: PAST,
    ...extra,
  };
}

function expiredDeletingUpload(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    bucket: 'files',
    key: `workspaces/ws1/uploads/${id}.bin`,
    name: `${id}.bin`,
    size: 4,
    contentType: 'application/octet-stream',
    etag: `etag-${id}`,
    status: 'deleting',
    deletionPreviousStatus: 'uploaded',
    completedAt: PAST,
    expiresAt: PAST,
    ...extra,
  };
}

function storageWith(behavior: (key: string) => Promise<void>) {
  return {
    bucket: () => ({
      delete: behavior,
      async head(key: string) {
        const id = key.split('/').at(-1)?.replace(/\.bin$/, '') ?? '';
        return { key, size: 4, contentType: 'application/octet-stream', etag: `etag-${id}` };
      },
      bucket: undefined,
    }),
    async head(key: string) {
      const id = key.split('/').at(-1)?.replace(/\.bin$/, '') ?? '';
      return { key, size: 4, contentType: 'application/octet-stream', etag: `etag-${id}` };
    },
    delete: behavior,
  };
}

function contextWith(database: ReturnType<typeof fakeDb>, storage: unknown) {
  return { admin: { db: () => database }, storage, data: null };
}

describe('file-maintenance expired-upload sweep', () => {
  it('round-robins the global cleanup budget so one workspace backlog cannot starve another', async () => {
    const central = fakeDb({
      workspaces: [{ id: 'ws1', name: 'One' }, { id: 'ws2', name: 'Two' }],
      workspace_members: [],
    });
    const shards: Record<string, ReturnType<typeof fakeDb>> = {
      ws1: fakeDb({
        pages: [], blocks: [], db_templates: [],
        file_uploads: Array.from({ length: 200 }, (_, index) =>
          expiredPendingUpload(`ws1-${index}`)),
      }),
      ws2: fakeDb({
        pages: [], blocks: [], db_templates: [],
        file_uploads: [expiredPendingUpload('ws2-only', { workspaceId: 'ws2' })],
      }),
    };
    const admin = {
      db(namespace: string, instanceId?: string) {
        return namespace === 'app' || !instanceId ? central : shards[instanceId];
      },
    };

    const result = await handlerOf(maintenance)({
      admin,
      storage: storageWith(async () => {}),
      data: null,
    }) as { expired: number };

    expect(result.expired).toBe(200);
    expect(shards.ws2.tables.file_uploads[0].status).toBe('expired');
    expect(shards.ws1.tables.file_uploads.filter((upload) => upload.status === 'pending')).toHaveLength(1);
  });

  it('prioritizes expired explicit deletion over a full old-orphan backlog in one workspace', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      pages: [], blocks: [], db_properties: [], db_templates: [], workspace_members: [],
      file_uploads: [
        ...Array.from({ length: 200 }, (_, index) => ({
          id: `orphan-${index}`, workspaceId: 'ws1', bucket: 'files',
          key: `workspaces/ws1/uploads/orphan-${index}.bin`, name: `orphan-${index}.bin`,
          size: 4, contentType: 'application/octet-stream', etag: `etag-orphan-${index}`,
          status: 'uploaded', completedAt: PAST,
        })),
        expiredDeletingUpload('explicit-delete'),
      ],
    });
    const deleted: string[] = [];

    const result = await handlerOf(maintenance)(contextWith(
      database,
      storageWith(async (key) => { deleted.push(key); }),
    )) as { deletedReferences: number };

    expect(result.deletedReferences).toBe(1);
    expect(deleted).toContain('workspaces/ws1/uploads/explicit-delete.bin');
    expect(database.tables.file_uploads.find((upload) => upload.id === 'explicit-delete'))
      .toMatchObject({ status: 'deleted' });
  });

  it('moves only old unattached completed uploads into grace and lets a late owner attach restore them', async () => {
    const orphanKey = 'workspaces/ws1/uploads/import-crash.bin';
    const attachedKey = 'workspaces/ws1/uploads/attached.bin';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: 'owner-1' }],
      workspace_members: [],
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
        inTrash: false, createdBy: 'owner-1', updatedAt: '2026-01-01T00:00:00.000Z',
        properties: { attached: [{ url: attachedKey }] },
      }],
      blocks: [],
      db_templates: [],
      file_uploads: [
        {
          id: 'import-crash', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: orphanKey,
          name: 'import-crash.bin', size: 4, contentType: 'application/octet-stream',
          etag: 'etag-import-crash', status: 'uploaded', completedAt: PAST,
        },
        {
          id: 'recent', workspaceId: 'ws1', pageId: 'p1', bucket: 'files',
          key: 'workspaces/ws1/uploads/recent.bin', name: 'recent.bin', size: 4,
          contentType: 'application/octet-stream', etag: 'etag-recent', status: 'uploaded',
          completedAt: new Date().toISOString(),
        },
        {
          id: 'attached', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: attachedKey,
          name: 'attached.bin', size: 4, contentType: 'application/octet-stream',
          etag: 'etag-attached', status: 'uploaded', completedAt: PAST,
        },
      ],
    });
    const deleted: string[] = [];
    const result = await handlerOf(maintenance)(contextWith(
      database,
      storageWith(async (key) => { deleted.push(key); }),
    )) as { orphanedUploads: number; deletedReferences: number };

    expect(result.orphanedUploads).toBe(1);
    expect(result.deletedReferences).toBe(0);
    expect(deleted).toEqual([]);
    expect(database.tables.file_uploads.map((upload) => upload.status)).toEqual([
      'deleting', 'uploaded', 'uploaded',
    ]);

    await callFunction(PAGE_POST, database, 'owner-1', {
      action: 'update', id: 'p1', patch: { cover: orphanKey },
    });
    expect(database.tables.pages[0].cover).toBe(orphanKey);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded', deletionPreviousStatus: null, expiresAt: null,
    });
  });

  it('finds old legacy uploaded rows that have only createdAt and no completion/update stamp', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      workspace_members: [],
      pages: [],
      blocks: [],
      db_properties: [],
      db_templates: [],
      file_uploads: [
        {
          id: 'legacy-created-only', workspaceId: 'ws1', bucket: 'files',
          key: 'workspaces/ws1/uploads/legacy-created-only.bin', name: 'legacy.bin',
          size: 4, contentType: 'application/octet-stream', etag: 'etag-legacy-created-only',
          status: 'uploaded', createdAt: PAST,
        },
        {
          id: 'recent-created-only', workspaceId: 'ws1', bucket: 'files',
          key: 'workspaces/ws1/uploads/recent-created-only.bin', name: 'recent.bin',
          size: 4, contentType: 'application/octet-stream', etag: 'etag-recent-created-only',
          status: 'uploaded', createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = await handlerOf(maintenance)(contextWith(
      database,
      storageWith(async () => {}),
    )) as { orphanedUploads: number; deletedReferences: number };

    expect(result.orphanedUploads).toBe(1);
    expect(result.deletedReferences).toBe(0);
    expect(database.tables.file_uploads.map((upload) => upload.status)).toEqual([
      'deleting', 'uploaded',
    ]);
  });

  it('does not race an unverified active legacy grant and preserves future expiry on orphan grace', async () => {
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      workspace_members: [], pages: [], blocks: [], db_properties: [], db_templates: [],
      file_uploads: [
        {
          id: 'unverified-active', workspaceId: 'ws1', bucket: 'files',
          key: 'workspaces/ws1/uploads/unverified-active.bin', name: 'active.bin',
          status: 'uploaded', updatedAt: PAST, expiresAt: futureExpiry,
        },
        {
          id: 'verified-stale-expiry', workspaceId: 'ws1', bucket: 'files',
          key: 'workspaces/ws1/uploads/verified-stale-expiry.bin', name: 'verified.bin',
          status: 'uploaded', completedAt: PAST, expiresAt: futureExpiry,
        },
      ],
    });

    const result = await handlerOf(maintenance)(contextWith(
      database,
      storageWith(async () => {}),
    )) as { orphanedUploads: number };

    expect(result.orphanedUploads).toBe(1);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded', expiresAt: futureExpiry,
    });
    expect(database.tables.file_uploads[1]).toMatchObject({
      status: 'deleting', expiresAt: futureExpiry, deletionPreviousStatus: 'uploaded',
    });
  });

  it('recovers a crashed duplicate before generic pending-upload expiry runs', async () => {
    const key = 'workspaces/ws1/duplicate-page/crashed.bin';
    const stagingTrashAt = '2026-07-11T00:00:00.000Z';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      pages: [{
        id: 'copy-root',
        workspaceId: 'ws1',
        parentId: null,
        parentType: 'workspace',
        inTrash: true,
        trashedAt: stagingTrashAt,
      }],
      file_uploads: [expiredPendingUpload('copy-upload', { key })],
      file_workspace_locks: [{
        id: 'ws1',
        workspaceId: 'ws1',
        leaseId: 'crashed-worker',
        actorId: 'actor-1',
        operation: 'duplicate-page',
        recoveryData: duplicatePageRecoveryData({
          status: 'staging',
          rootPageId: 'copy-root',
          uploadIds: ['copy-upload'],
          stagingTrashAt,
        }),
        expiresAt: PAST,
      }],
    });
    const deleted: string[] = [];

    const result = await handlerOf(maintenance)(
      contextWith(database, storageWith(async (deletedKey) => {
        deleted.push(deletedKey);
      })),
    ) as {
      expired: number;
      duplicatePageRecovery: { recovered: string[]; failures: unknown[] };
    };

    expect(result.duplicatePageRecovery).toEqual({ recovered: ['ws1'], failures: [] });
    expect(result.expired).toBe(0);
    expect(deleted).toEqual([key]);
    expect(database.tables.pages).toEqual([]);
    expect(database.tables.page_workspace_index).toEqual([]);
    expect(database.tables.file_uploads).toEqual([]);
    expect(database.tables.file_workspace_locks).toEqual([]);
  });

  it('automatically resumes an expired database-property cleanup tombstone', async () => {
    const marker = databasePropertyDeleteRecoveryData({
      property: {
        id: 'prop-old', databaseId: 'db-a', name: 'Old', type: 'rich_text', position: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      actorId: 'owner-1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: 'owner-1' }],
      workspace_members: [],
      pages: [
        {
          id: 'db-a', workspaceId: 'ws1', kind: 'database', parentType: 'workspace',
          parentId: null, position: 0,
        },
        {
          id: 'row-a', workspaceId: 'ws1', kind: 'page', parentType: 'database',
          parentId: 'db-a', position: 0, updatedAt: '2026-01-01T00:00:00.000Z',
          properties: { title: 'Row', 'prop-old': 'orphaned-but-hidden' },
        },
      ],
      db_properties: [
        { id: 'title', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
      ],
      db_views: [],
      db_templates: [],
      db_property_indexes: [],
      file_uploads: [],
      file_workspace_locks: [{
        id: 'ws1', workspaceId: 'ws1', leaseId: 'crashed-property-delete',
        actorId: 'owner-1', operation: 'database-property-delete-recovery',
        recoveryData: marker, expiresAt: PAST,
      }],
    });

    const result = await handlerOf(maintenance)(
      contextWith(database, storageWith(async () => {})),
    ) as {
      databasePropertyDeleteRecovery: { recovered: string[]; failures: unknown[] };
      maintenanceRuns: number;
    };

    expect(result.databasePropertyDeleteRecovery).toEqual({ recovered: ['ws1'], failures: [] });
    expect(database.tables.pages.find((page) => page.id === 'row-a')?.properties)
      .toEqual({ title: 'Row' });
    expect(database.tables.file_workspace_locks).toEqual([]);
    expect(result.maintenanceRuns).toBe(1);
    expect(database.tables.file_maintenance_runs[0]).toMatchObject({
      workspaceId: 'ws1',
      details: { databasePropertyDeleteRecoveries: 1 },
    });
  });

  it('reports and retains a failed property tombstone, then completes it on the next sweep', async () => {
    const marker = databasePropertyDeleteRecoveryData({
      property: {
        id: 'prop-retry', databaseId: 'db-a', name: 'Retry', type: 'rich_text', position: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      actorId: 'owner-1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: 'owner-1' }],
      workspace_members: [],
      pages: [
        {
          id: 'db-a', workspaceId: 'ws1', kind: 'database', parentType: 'workspace',
          parentId: null, position: 0,
        },
        {
          id: 'row-retry', workspaceId: 'ws1', kind: 'page', parentType: 'database',
          parentId: 'db-a', position: 0, updatedAt: '2026-01-01T00:00:00.000Z',
          properties: { title: 'Row', 'prop-retry': 'pending cleanup' },
        },
      ],
      db_properties: [
        { id: 'title', databaseId: 'db-a', name: 'Name', type: 'title', position: 1 },
      ],
      db_views: [], db_templates: [], db_property_indexes: [], file_uploads: [],
      file_workspace_locks: [{
        id: 'ws1', workspaceId: 'ws1', leaseId: 'crashed-property-delete',
        actorId: 'owner-1', operation: 'database-property-delete-recovery',
        recoveryData: marker, expiresAt: PAST,
      }],
    });
    const originalTransact = database.transact.bind(database);
    database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
      if (operations.some((operation) => operation.table === 'pages' && operation.op === 'update')) {
        throw new Error('Injected property cleanup outage.');
      }
      return originalTransact(operations);
    }) as typeof database.transact;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const failed = await handlerOf(maintenance)(
        contextWith(database, storageWith(async () => {})),
      ) as {
        ok: boolean;
        databasePropertyDeleteRecoveryFailures: number;
        failures: Array<{ id: string; message: string }>;
        maintenanceRuns: number;
      };

      expect(failed.ok).toBe(false);
      expect(failed.databasePropertyDeleteRecoveryFailures).toBe(1);
      expect(failed.failures).toEqual([expect.objectContaining({
        id: 'database-property-delete-recovery:prop-retry',
        message: 'Injected property cleanup outage.',
      })]);
      expect(failed.maintenanceRuns).toBe(1);
      expect(database.tables.file_maintenance_runs[0]).toMatchObject({
        workspaceId: 'ws1', status: 'partial_failure', failedObjects: 1,
        details: { databasePropertyDeleteRecoveryFailures: 1 },
      });
      expect(database.tables.file_workspace_locks).toHaveLength(1);
      expect(database.tables.pages.find((page) => page.id === 'row-retry')?.properties)
        .toHaveProperty('prop-retry', 'pending cleanup');
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        'database-property-delete-recovery:prop-retry',
      ));

      database.transact = originalTransact;
      const retried = await handlerOf(maintenance)(
        contextWith(database, storageWith(async () => {})),
      ) as { databasePropertyDeleteRecovery: { recovered: string[]; failures: unknown[] } };
      expect(retried.databasePropertyDeleteRecovery).toEqual({ recovered: ['ws1'], failures: [] });
      expect(database.tables.pages.find((page) => page.id === 'row-retry')?.properties)
        .toEqual({ title: 'Row' });
      expect(database.tables.file_workspace_locks).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it('reports, records, logs, and retains a recovery-only failure for retry', async () => {
    const stagingTrashAt = '2026-07-11T00:00:00.000Z';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      pages: [{
        id: 'copy-root',
        workspaceId: 'ws1',
        parentId: null,
        parentType: 'workspace',
        // A staging recovery must never delete a page that has become live.
        inTrash: false,
        trashedAt: null,
      }],
      file_uploads: [],
      file_workspace_locks: [{
        id: 'ws1',
        workspaceId: 'ws1',
        leaseId: 'crashed-worker',
        actorId: 'actor-1',
        operation: 'duplicate-page',
        recoveryData: duplicatePageRecoveryData({
          status: 'staging',
          rootPageId: 'copy-root',
          uploadIds: [],
          stagingTrashAt,
        }),
        expiresAt: PAST,
      }],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await handlerOf(maintenance)(contextWith(database, undefined)) as {
        ok: boolean;
        duplicatePageRecoveryFailures: number;
        failures: Array<{ id: string; message: string }>;
        maintenanceRuns: number;
      };

      expect(result.ok).toBe(false);
      expect(result.duplicatePageRecoveryFailures).toBe(1);
      expect(result.failures).toEqual([expect.objectContaining({
        id: 'duplicate-page-recovery:ws1',
        message: expect.stringContaining('no longer matches its staging marker'),
      })]);
      expect(result.maintenanceRuns).toBe(1);
      expect(database.tables.file_maintenance_runs).toEqual([
        expect.objectContaining({
          workspaceId: 'ws1',
          status: 'partial_failure',
          failedObjects: 1,
          details: expect.objectContaining({ duplicatePageRecoveryFailures: 1 }),
        }),
      ]);
      expect(database.tables.file_workspace_locks).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('duplicate-page-recovery:ws1'));
    } finally {
      log.mockRestore();
    }
  });

  it('keeps a detached upload retryable through storage failure, then retires it as deleted', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      pages: [],
      blocks: [],
      db_templates: [],
      workspace_members: [],
      file_uploads: [expiredDeletingUpload('detached')],
    });

    const failed = await handlerOf(maintenance)(
      contextWith(database, storageWith(async () => {
        throw new Error('Simulated R2 outage.');
      })),
    ) as { deletedReferences: number; failures: Array<{ id: string }> };
    expect(failed.deletedReferences).toBe(0);
    expect(failed.failures.map((failure) => failure.id)).toEqual(['detached']);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'deleting' });

    const deleted: string[] = [];
    const retried = await handlerOf(maintenance)(
      contextWith(database, storageWith(async (key) => {
        deleted.push(key);
      })),
    ) as { deletedReferences: number; failures: unknown[] };
    expect(retried.deletedReferences).toBe(1);
    expect(retried.failures).toEqual([]);
    expect(deleted).toEqual(['workspaces/ws1/uploads/detached.bin']);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleted',
      deletionPreviousStatus: null,
      deletedBy: 'system:file-maintenance',
    });
  });

  it('restores a deleting upload when a legacy template still references its key across split DBs', async () => {
    const central = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      workspace_members: [],
    });
    const content = fakeDb({
      pages: [{
        id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database', position: 0,
      }],
      blocks: [],
      db_templates: [{
        id: 'template-1',
        databaseId: 'db1',
        icon: 'workspaces/ws1/uploads/shared.bin',
      }],
      file_uploads: [expiredDeletingUpload('shared')],
    });
    const deleted: string[] = [];
    const admin = {
      db(namespace: string) {
        return namespace === 'app' ? central : content;
      },
    };

    const result = await handlerOf(maintenance)({
      admin,
      storage: storageWith(async (key) => {
        deleted.push(key);
      }),
      data: null,
    }) as { deletedReferences: number; failures: unknown[] };

    expect(result.deletedReferences).toBe(0);
    expect(result.failures).toEqual([]);
    expect(deleted).toEqual([]);
    expect(content.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded',
      deletionPreviousStatus: null,
      expiresAt: null,
    });
  });

  it('keeps the row pending when the storage delete throws, then expires it on a later successful sweep', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      file_uploads: [expiredPendingUpload('u1')],
    });

    // Sweep 1: the storage delete fails. Stamping 'expired' here would leak
    // the object forever, because the sweep only re-scans 'pending' rows.
    const failing = await handlerOf(maintenance)(
      contextWith(database, storageWith(async () => {
        throw new Error('Simulated storage outage.');
      })),
    ) as { expired: number; failures: Array<{ id: string }> };
    expect(failing.expired).toBe(0);
    expect(failing.failures.map((failure) => failure.id)).toEqual(['u1']);
    expect(database.tables.file_uploads[0].status).toBe('pending');

    // Sweep 2: storage recovered — the same row is retried and expired.
    const deleted: string[] = [];
    const succeeding = await handlerOf(maintenance)(
      contextWith(database, storageWith(async (key: string) => {
        deleted.push(key);
      })),
    ) as { expired: number; failures: unknown[] };
    expect(succeeding.expired).toBe(1);
    expect(succeeding.failures).toEqual([]);
    expect(deleted).toEqual(['workspaces/ws1/uploads/u1.bin']);
    expect(database.tables.file_uploads[0].status).toBe('expired');
    expect(database.tables.file_uploads[0].deletedBy).toBe('system:file-maintenance');
  });

  it('recovers a stale preparing placeholder even when no grant expiry was persisted', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      file_uploads: [stalePreparingUpload('preparing-stale')],
    });
    const deleted: string[] = [];

    const result = await handlerOf(maintenance)(
      contextWith(database, storageWith(async (key: string) => {
        deleted.push(key);
      })),
    ) as { expired: number; failures: unknown[] };

    expect(result.expired).toBe(1);
    expect(result.failures).toEqual([]);
    expect(deleted).toEqual(['workspaces/ws1/uploads/preparing-stale.bin']);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'expired',
      deletedBy: 'system:file-maintenance',
    });
  });

  it('recovers a legacy pending upload after the maximum grant plus safety margin when expiresAt is missing', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      file_uploads: [expiredPendingUpload('pending-no-expiry', {
        expiresAt: null,
        createdAt: PAST,
        updatedAt: PAST,
      })],
    });
    const deleted: string[] = [];

    const result = await handlerOf(maintenance)(contextWith(
      database,
      storageWith(async (key) => { deleted.push(key); }),
    )) as { expired: number; failures: unknown[] };

    expect(result.expired).toBe(1);
    expect(result.failures).toEqual([]);
    expect(deleted).toEqual(['workspaces/ws1/uploads/pending-no-expiry.bin']);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'expired' });
  });

  it('does not recover a fresh preparing placeholder before the recovery TTL', async () => {
    const now = new Date().toISOString();
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      file_uploads: [stalePreparingUpload('preparing-fresh', { createdAt: now, updatedAt: now })],
    });
    const deleted: string[] = [];

    const result = await handlerOf(maintenance)(
      contextWith(database, storageWith(async (key: string) => {
        deleted.push(key);
      })),
    ) as { expired: number; failures: unknown[] };

    expect(result.expired).toBe(0);
    expect(result.failures).toEqual([]);
    expect(deleted).toEqual([]);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'preparing' });
  });

  it('keeps a stale placeholder retryable when trusted storage access is absent', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace' }],
      file_uploads: [stalePreparingUpload('preparing-no-storage')],
    });

    const result = await handlerOf(maintenance)(
      contextWith(database, undefined),
    ) as { expired: number; failures: Array<{ id: string; message: string }> };

    expect(result.expired).toBe(0);
    expect(result.failures).toEqual([
      expect.objectContaining({
        id: 'preparing-no-storage',
        message: 'Stored file deletion requires storage access.',
      }),
    ]);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'preparing' });
  });

  it('settles organization quota before retiring metadata and retries if quota settlement fails', async () => {
    const database = fakeDb({
      organizations: [{ id: 'org1', name: 'Org', ownerId: 'owner-1', storageLimitBytes: 100 }],
      workspaces: [{ id: 'ws1', name: 'Workspace', organizationId: 'org1' }],
      file_uploads: [expiredPendingUpload('quota-upload', { size: 10 })],
      organization_storage_usage: [
        { id: 'org1', organizationId: 'org1', reservedBytes: 10, version: 1 },
      ],
      organization_storage_reservations: [
        {
          id: 'quota-upload',
          organizationId: 'org1',
          workspaceId: 'ws1',
          bytes: 10,
          status: 'active',
        },
      ],
    });
    const transact = database.transact.bind(database);
    let failQuotaOnce = true;
    database.transact = async (operations) => {
      if (
        failQuotaOnce
        && operations.some((operation) => operation.table === 'organization_storage_reservations')
      ) {
        failQuotaOnce = false;
        throw new Error('Simulated quota database outage.');
      }
      return transact(operations);
    };
    const deleted: string[] = [];
    const storage = storageWith(async (key: string) => {
      deleted.push(key);
    });

    const failed = await handlerOf(maintenance)(contextWith(database, storage)) as {
      expired: number;
      failures: Array<{ id: string }>;
    };
    expect(failed.expired).toBe(0);
    expect(failed.failures.map((failure) => failure.id)).toEqual(['quota-upload']);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'pending' });
    expect(database.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 10, version: 1 });
    expect(database.tables.organization_storage_reservations[0]).toMatchObject({ status: 'active' });

    const retried = await handlerOf(maintenance)(contextWith(database, storage)) as {
      expired: number;
      failures: unknown[];
    };
    expect(retried.expired).toBe(1);
    expect(retried.failures).toEqual([]);
    expect(deleted).toEqual([
      'workspaces/ws1/uploads/quota-upload.bin',
      'workspaces/ws1/uploads/quota-upload.bin',
    ]);
    expect(database.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 0, version: 2 });
    expect(database.tables.organization_storage_reservations[0]).toMatchObject({ status: 'released' });
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'expired' });
  });
});
