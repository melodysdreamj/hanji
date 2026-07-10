import { describe, expect, it } from 'vitest';
import maintenance from '../../functions/file-maintenance';
import { fakeDb, type Row } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const PAST = '2020-01-01T00:00:00.000Z';

function expiredPendingUpload(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    bucket: 'files',
    key: `workspaces/ws1/uploads/${id}.bin`,
    name: `${id}.bin`,
    status: 'pending',
    expiresAt: PAST,
    ...extra,
  };
}

function storageWith(behavior: (key: string) => Promise<void>) {
  return {
    bucket: () => ({ delete: behavior, bucket: undefined }),
    delete: behavior,
  };
}

function contextWith(database: ReturnType<typeof fakeDb>, storage: unknown) {
  return { admin: { db: () => database }, storage, data: null };
}

describe('file-maintenance expired-upload sweep', () => {
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
});
