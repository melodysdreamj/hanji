import { describe, expect, it } from 'vitest';

import {
  duplicatePageRecoveryData,
  recoverStaleDuplicatePageOperations,
} from '../../lib/duplicate-page-recovery';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';

const STAGING_AT = '2026-07-11T00:00:00.000Z';

function recoveryFixture(status: 'staging' | 'committed') {
  const marker = duplicatePageRecoveryData({
    status,
    rootPageId: 'copy-root',
    uploadIds: ['copy-upload'],
    stagingTrashAt: STAGING_AT,
  });
  const central = fakeDb({
    organizations: [{ id: 'org-1', storageLimitBytes: 1_000 }],
    workspaces: [{ id: 'ws-1', organizationId: 'org-1' }],
    page_workspace_index: [
      { id: 'source-root', workspaceId: 'ws-1' },
      { id: 'copy-root', workspaceId: 'ws-1' },
      { id: 'copy-child', workspaceId: 'ws-1' },
    ],
    organization_storage_usage: [{
      id: 'org-1',
      organizationId: 'org-1',
      reservedBytes: 12,
      version: 1,
    }],
    organization_storage_reservations: [{
      id: 'copy-upload',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      bytes: 6,
      status: 'active',
    }],
  });
  const content = fakeDb({
    pages: [
      {
        id: 'source-root',
        workspaceId: 'ws-1',
        parentId: null,
        parentType: 'workspace',
        kind: 'database',
        inTrash: false,
      },
      {
        id: 'copy-root',
        workspaceId: 'ws-1',
        parentId: null,
        parentType: 'workspace',
        kind: 'database',
        inTrash: true,
        trashedAt: STAGING_AT,
      },
      {
        id: 'copy-child',
        workspaceId: 'ws-1',
        parentId: 'copy-root',
        parentType: 'page',
        inTrash: true,
        trashedAt: STAGING_AT,
      },
    ],
    file_uploads: [
      {
        id: 'source-upload',
        workspaceId: 'ws-1',
        bucket: 'files',
        key: 'workspaces/ws-1/source.bin',
        name: 'source.bin',
        size: 6,
        status: 'uploaded',
      },
      {
        id: 'copy-upload',
        workspaceId: 'ws-1',
        bucket: 'files',
        key: 'workspaces/ws-1/duplicate-page/copy.bin',
        name: 'copy.bin',
        size: 6,
        status: 'uploaded',
      },
    ],
    file_workspace_locks: [{
      id: 'ws-1',
      workspaceId: 'ws-1',
      leaseId: 'crashed-worker',
      actorId: 'actor-1',
      operation: 'duplicate-page',
      recoveryData: marker,
      expiresAt: '2020-01-01T00:00:00.000Z',
    }],
  });
  const admin = {
    db(namespace: string, instanceId?: string) {
      if (namespace === 'app') return central;
      if (namespace === 'workspace' && instanceId === 'ws-1') return content;
      throw new Error(`Unexpected database route: ${namespace}/${instanceId ?? ''}`);
    },
  };
  const objects = new Map<string, string>([
    ['workspaces/ws-1/source.bin', 'source'],
    ['workspaces/ws-1/duplicate-page/copy.bin', 'copy'],
  ]);
  const storage = {
    objects,
    bucket: () => storage,
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return { marker, central, content, admin, storage };
}

function recover(input: {
  admin: { db(namespace: string, instanceId?: string): FakeDb };
  content: FakeDb;
  storage: { bucket(): unknown; delete(key: string): Promise<void> };
}) {
  return recoverStaleDuplicatePageOperations({
    admin: input.admin,
    contentDbs: [{ workspaceId: 'ws-1', db: input.content }],
    storage: input.storage,
    now: Date.now(),
  });
}

function noFileRecoveryFixture(status: 'staging' | 'committed') {
  const marker = duplicatePageRecoveryData({
    status,
    rootPageId: 'copy-root',
    uploadIds: [],
    stagingTrashAt: STAGING_AT,
  });
  const central = fakeDb({
    workspaces: [{ id: 'ws-1' }],
    page_workspace_index: [
      { id: 'source-root', workspaceId: 'ws-1' },
      { id: 'copy-root', workspaceId: 'ws-1' },
      { id: 'copy-child', workspaceId: 'ws-1' },
    ],
  });
  const content = fakeDb({
    pages: [
      {
        id: 'source-root',
        workspaceId: 'ws-1',
        parentId: null,
        parentType: 'workspace',
        kind: 'database',
        inTrash: false,
      },
      {
        id: 'copy-root',
        workspaceId: 'ws-1',
        parentId: null,
        parentType: 'workspace',
        kind: 'database',
        inTrash: true,
        trashedAt: STAGING_AT,
      },
      {
        id: 'copy-child',
        workspaceId: 'ws-1',
        parentId: 'copy-root',
        parentType: 'page',
        kind: 'page',
        inTrash: true,
        trashedAt: STAGING_AT,
      },
    ],
    blocks: [
      { id: 'source-block', pageId: 'source-root', type: 'paragraph' },
      { id: 'copy-root-block', pageId: 'copy-root', type: 'paragraph' },
      { id: 'copy-child-block', pageId: 'copy-child', type: 'paragraph' },
    ],
    db_properties: [
      { id: 'source-property', databaseId: 'source-root', name: 'Source' },
      { id: 'copy-property', databaseId: 'copy-root', name: 'Copy' },
    ],
    db_views: [
      { id: 'source-view', databaseId: 'source-root', name: 'Source' },
      { id: 'copy-view', databaseId: 'copy-root', name: 'Copy' },
    ],
    db_templates: [
      { id: 'source-template', databaseId: 'source-root', name: 'Source' },
      { id: 'copy-template', databaseId: 'copy-root', name: 'Copy' },
    ],
    file_uploads: [],
    file_workspace_locks: [{
      id: 'ws-1',
      workspaceId: 'ws-1',
      leaseId: 'crashed-no-file-worker',
      actorId: 'actor-1',
      operation: 'duplicate-page',
      recoveryData: marker,
      expiresAt: '2020-01-01T00:00:00.000Z',
    }],
  });
  const admin = {
    db(namespace: string, instanceId?: string) {
      if (namespace === 'app') return central;
      if (namespace === 'workspace' && instanceId === 'ws-1') return content;
      throw new Error(`Unexpected database route: ${namespace}/${instanceId ?? ''}`);
    },
  };
  return { marker, central, content, admin };
}

describe('duplicate-page durable crash recovery', () => {
  it('rolls back a crashed no-file staging tree and its central indexes', async () => {
    const fixture = noFileRecoveryFixture('staging');

    const result = await recoverStaleDuplicatePageOperations({
      admin: fixture.admin,
      contentDbs: [{ workspaceId: 'ws-1', db: fixture.content }],
      now: Date.now(),
    });

    expect(result).toEqual({ recovered: ['ws-1'], failures: [] });
    expect(fixture.content.tables.pages.map((page) => page.id)).toEqual(['source-root']);
    expect(fixture.central.tables.page_workspace_index.map((row) => row.id)).toEqual(['source-root']);
    expect(fixture.content.tables.blocks.map((block) => block.id)).toEqual(['source-block']);
    expect(fixture.content.tables.db_properties.map((property) => property.id)).toEqual(['source-property']);
    expect(fixture.content.tables.db_views.map((view) => view.id)).toEqual(['source-view']);
    expect(fixture.content.tables.db_templates.map((template) => template.id)).toEqual(['source-template']);
    expect(fixture.content.tables.file_uploads).toEqual([]);
    expect(fixture.content.tables.file_workspace_locks).toEqual([]);
  });

  it('finishes publishing a committed no-file tree descendants-first', async () => {
    const fixture = noFileRecoveryFixture('committed');

    const result = await recoverStaleDuplicatePageOperations({
      admin: fixture.admin,
      contentDbs: [{ workspaceId: 'ws-1', db: fixture.content }],
      now: Date.now(),
    });

    expect(result).toEqual({ recovered: ['ws-1'], failures: [] });
    expect(fixture.content.tables.pages.find((page) => page.id === 'copy-root')).toMatchObject({
      inTrash: false,
      trashedAt: null,
    });
    expect(fixture.content.tables.pages.find((page) => page.id === 'copy-child')).toMatchObject({
      inTrash: false,
      trashedAt: null,
    });
    expect(fixture.content.tables.blocks.map((block) => block.id)).toContain('copy-root-block');
    expect(fixture.content.tables.db_properties.map((property) => property.id)).toContain('copy-property');
    expect(fixture.content.tables.db_views.map((view) => view.id)).toContain('copy-view');
    expect(fixture.content.tables.db_templates.map((template) => template.id)).toContain('copy-template');
    expect(fixture.content.tables.file_workspace_locks).toEqual([]);
  });

  it('rolls back an expired staging marker without touching the source file or page', async () => {
    const fixture = recoveryFixture('staging');

    const result = await recover(fixture);

    expect(result).toEqual({ recovered: ['ws-1'], failures: [] });
    expect(fixture.content.tables.pages.map((page) => page.id)).toEqual(['source-root']);
    expect(fixture.central.tables.page_workspace_index.map((row) => row.id)).toEqual(['source-root']);
    expect(fixture.content.tables.file_uploads.map((upload) => upload.id)).toEqual(['source-upload']);
    expect(fixture.storage.objects).toEqual(new Map([['workspaces/ws-1/source.bin', 'source']]));
    expect(fixture.content.tables.file_workspace_locks).toEqual([]);
    expect(fixture.central.tables.organization_storage_usage[0]).toMatchObject({
      reservedBytes: 6,
      version: 2,
    });
    expect(fixture.central.tables.organization_storage_reservations[0]).toMatchObject({
      id: 'copy-upload',
      status: 'released',
    });
  });

  it('finishes a committed copy and preserves its independent file', async () => {
    const fixture = recoveryFixture('committed');

    const result = await recover(fixture);

    expect(result).toEqual({ recovered: ['ws-1'], failures: [] });
    expect(fixture.content.tables.pages.find((page) => page.id === 'copy-root')).toMatchObject({
      inTrash: false,
      trashedAt: null,
    });
    expect(fixture.content.tables.pages.find((page) => page.id === 'copy-child')).toMatchObject({
      inTrash: false,
      trashedAt: null,
    });
    expect(fixture.content.tables.file_uploads.map((upload) => upload.id)).toEqual([
      'source-upload',
      'copy-upload',
    ]);
    expect(fixture.storage.objects.has('workspaces/ws-1/duplicate-page/copy.bin')).toBe(true);
    expect(fixture.central.tables.organization_storage_reservations[0]).toMatchObject({ status: 'active' });
    expect(fixture.content.tables.file_workspace_locks).toEqual([]);
  });

  it('preserves a newer user trash event instead of resurfacing the copy', async () => {
    const fixture = recoveryFixture('committed');
    await fixture.content.table<Row>('pages').update('copy-root', {
      trashedAt: '2026-07-11T01:00:00.000Z',
    });

    const result = await recover(fixture);

    expect(result.failures).toEqual([]);
    expect(fixture.content.tables.pages.find((page) => page.id === 'copy-root')).toMatchObject({
      inTrash: true,
      trashedAt: '2026-07-11T01:00:00.000Z',
    });
    expect(fixture.content.tables.pages.find((page) => page.id === 'copy-child')).toMatchObject({
      inTrash: true,
      trashedAt: STAGING_AT,
    });
  });

  it('retains and defers the marker when cleanup fails so maintenance can retry', async () => {
    const fixture = recoveryFixture('staging');
    fixture.storage.delete = async (key: string) => {
      if (key.includes('/duplicate-page/')) throw new Error('simulated object delete failure');
      fixture.storage.objects.delete(key);
    };

    const before = Date.now();
    const result = await recover(fixture);

    expect(result.recovered).toEqual([]);
    expect(result.failures).toEqual([{
      workspaceId: 'ws-1',
      message: 'simulated object delete failure',
    }]);
    expect(fixture.content.tables.pages.some((page) => page.id === 'copy-root')).toBe(true);
    expect(fixture.content.tables.file_uploads.some((upload) => upload.id === 'copy-upload')).toBe(true);
    expect(fixture.storage.objects.has('workspaces/ws-1/duplicate-page/copy.bin')).toBe(true);
    expect(fixture.content.tables.file_workspace_locks[0].recoveryData).toEqual(fixture.marker);
    expect(Date.parse(String(fixture.content.tables.file_workspace_locks[0].expiresAt))).toBeGreaterThan(before);
  });

  it('finishes file and quota cleanup when an earlier rollback already removed the staged root', async () => {
    const fixture = recoveryFixture('staging');
    await fixture.content.table<Row>('pages').delete('copy-child');
    await fixture.content.table<Row>('pages').delete('copy-root');
    await fixture.central.table<Row>('page_workspace_index').delete('copy-child');
    await fixture.central.table<Row>('page_workspace_index').delete('copy-root');

    const result = await recover(fixture);

    expect(result).toEqual({ recovered: ['ws-1'], failures: [] });
    expect(fixture.content.tables.pages.map((page) => page.id)).toEqual(['source-root']);
    expect(fixture.content.tables.file_uploads.map((upload) => upload.id)).toEqual(['source-upload']);
    expect(fixture.storage.objects).toEqual(new Map([['workspaces/ws-1/source.bin', 'source']]));
    expect(fixture.central.tables.organization_storage_reservations[0]).toMatchObject({
      id: 'copy-upload',
      status: 'released',
    });
    expect(fixture.content.tables.file_workspace_locks).toEqual([]);
  });

  it('does not delete an arbitrary upload when a rootless marker is corrupted', async () => {
    const fixture = recoveryFixture('staging');
    await fixture.content.table<Row>('pages').delete('copy-child');
    await fixture.content.table<Row>('pages').delete('copy-root');
    await fixture.content.table<Row>('file_uploads').update('copy-upload', {
      key: 'workspaces/ws-1/uploads/unrelated.bin',
    });

    const result = await recover(fixture);

    expect(result.recovered).toEqual([]);
    expect(result.failures[0]?.message).toContain('unexpected storage key');
    expect(fixture.content.tables.file_uploads.some((upload) => upload.id === 'copy-upload')).toBe(true);
    expect(fixture.content.tables.file_workspace_locks).toHaveLength(1);
  });

  it('fails closed when a staging marker no longer identifies hidden staged pages', async () => {
    const fixture = recoveryFixture('staging');
    await fixture.content.table<Row>('pages').update('copy-root', {
      inTrash: false,
      trashedAt: null,
    });

    const result = await recover(fixture);

    expect(result.recovered).toEqual([]);
    expect(result.failures[0]).toMatchObject({
      workspaceId: 'ws-1',
      message: expect.stringContaining('no longer matches its staging marker'),
    });
    expect(fixture.content.tables.pages.some((page) => page.id === 'copy-root')).toBe(true);
    expect(fixture.content.tables.file_uploads.some((upload) => upload.id === 'copy-upload')).toBe(true);
    expect(fixture.storage.objects.has('workspaces/ws-1/duplicate-page/copy.bin')).toBe(true);
    expect(fixture.content.tables.file_workspace_locks).toHaveLength(1);
  });
});
