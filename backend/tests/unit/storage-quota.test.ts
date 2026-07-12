import { describe, expect, it } from 'vitest';

import { releaseOrganizationStorage, reserveOrganizationStorage } from '../../lib/storage-quota';
import { fakeDb, type FakeDb } from './helpers/fake-db';

function quotaFixture(limit = 1000) {
  const central = fakeDb({
    organizations: [{ id: 'org-1', storageLimitBytes: limit }],
    workspaces: [
      { id: 'ws-1', organizationId: 'org-1' },
      { id: 'ws-2', organizationId: 'org-1' },
    ],
  });
  const shards: Record<string, FakeDb> = {
    'ws-1': fakeDb({ file_uploads: [] }),
    'ws-2': fakeDb({
      file_uploads: [
        {
          id: 'legacy-upload',
          workspaceId: 'ws-2',
          size: 900,
          status: 'uploaded',
        },
      ],
    }),
  };
  const admin = {
    db(namespace: string, instanceId?: string) {
      return namespace === 'app' || !instanceId ? central : shards[instanceId];
    },
  };
  return { admin, central, shards };
}

describe('atomic organization storage reservations', () => {
  it('initializes from every sibling shard and settles exactly once', async () => {
    const { admin, central } = quotaFixture();
    const reservation = await reserveOrganizationStorage(
      admin,
      { id: 'ws-1', organizationId: 'org-1' },
      'upload-1',
      50,
    );
    expect(reservation).not.toBeNull();
    expect(central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 950, version: 1 });

    await releaseOrganizationStorage(admin, reservation);
    await releaseOrganizationStorage(admin, reservation);
    expect(central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 900, version: 2 });
    expect(central.tables.organization_storage_reservations[0]).toMatchObject({
      id: 'upload-1',
      status: 'released',
      bytes: 50,
    });
  });

  it('keeps deleting legacy bytes counted until irreversible cleanup releases them', async () => {
    const { admin, central, shards } = quotaFixture();
    shards['ws-2'].tables.file_uploads[0].status = 'deleting';

    await reserveOrganizationStorage(
      admin,
      { id: 'ws-1', organizationId: 'org-1' },
      'upload-after-detach',
      50,
    );

    expect(central.tables.organization_storage_usage[0]).toMatchObject({
      reservedBytes: 950,
      version: 1,
    });
  });

  it('serializes concurrent reservations at the quota boundary', async () => {
    const { admin, central } = quotaFixture();
    const workspace = { id: 'ws-1', organizationId: 'org-1' };
    const results = await Promise.allSettled([
      reserveOrganizationStorage(admin, workspace, 'upload-a', 100),
      reserveOrganizationStorage(admin, workspace, 'upload-b', 100),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejected?.reason)).toContain('Organization storage limit exceeded.');
    expect(central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 1000 });
    expect(central.tables.organization_storage_reservations).toHaveLength(1);
  });

  it('rebuilds a missing usage aggregate and releases an active ledger entry', async () => {
    const { admin, central } = quotaFixture();
    const reservation = await reserveOrganizationStorage(
      admin,
      { id: 'ws-1', organizationId: 'org-1' },
      'upload-rebuild',
      50,
    );
    central.tables.organization_storage_usage = [];

    await releaseOrganizationStorage(admin, reservation);

    expect(central.tables.organization_storage_usage).toHaveLength(1);
    expect(central.tables.organization_storage_usage[0]).toMatchObject({
      id: 'org-1',
      reservedBytes: 900,
      version: 1,
    });
    expect(central.tables.organization_storage_reservations[0]).toMatchObject({
      id: 'upload-rebuild',
      status: 'released',
    });
  });

  it('subtracts a still-active target exactly once while rebuilding a missing aggregate', async () => {
    const { admin, central, shards } = quotaFixture();
    shards['ws-1'].tables.file_uploads.push({
      id: 'legacy-active',
      workspaceId: 'ws-1',
      size: 50,
      status: 'uploaded',
    });

    await releaseOrganizationStorage(admin, {
      id: 'legacy-active',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      bytes: 50,
    });

    expect(central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 900, version: 1 });
    expect(central.tables.organization_storage_reservations[0]).toMatchObject({
      id: 'legacy-active',
      status: 'released',
    });
  });
});
