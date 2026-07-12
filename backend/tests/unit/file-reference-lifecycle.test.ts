import { describe, expect, it } from 'vitest';

import {
  fileUploadStillReferenced,
  hasPotentialStoredFileReference,
  updateWithFileReferenceLifecycle,
  workspaceFileReferenceSnapshot,
} from '../../lib/file-reference-lifecycle';
import type { FileUpload, Page } from '../../lib/app-types';
import { fakeDb } from './helpers/fake-db';

const KEY = 'workspaces/ws1/covers/upload-cover.png';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';

function fixture(status: FileUpload['status'] = 'uploaded') {
  return fakeDb({
    workspaces: [{ id: 'ws1', ownerId: 'owner-1' }],
    workspace_members: [],
    pages: [{
      id: 'p1',
      workspaceId: 'ws1',
      parentType: 'workspace',
      kind: 'page',
      position: 0,
      cover: KEY,
      updatedAt: T0,
    }],
    blocks: [],
    db_templates: [],
    file_uploads: [{
      id: 'upload-cover',
      workspaceId: 'ws1',
      pageId: 'p1',
      bucket: 'files',
      key: KEY,
      status,
      completedAt: status === 'uploaded' ? T0 : null,
    }],
  });
}

async function updateCover(
  database: ReturnType<typeof fakeDb>,
  current: Page,
  cover: string | null,
  updatedAt: string,
) {
  return updateWithFileReferenceLifecycle(database, {
    table: 'pages',
    current,
    data: { cover: cover ?? undefined, updatedAt },
    currentReferences: { cover: current.cover },
    nextReferences: { cover },
    association: { field: 'pageId', id: current.id },
    actorId: 'owner-1',
  });
}

describe('stored file reference lifecycle', () => {
  it('does not interpret literal storage-looking prose as a file reference', () => {
    expect(hasPotentialStoredFileReference({
      rich: [{ text: KEY }, { text: 'https://storage.example/api/storage/files/workspaces/ws1/fake' }],
      caption: KEY,
      plainText: KEY,
    })).toBe(false);
    expect(hasPotentialStoredFileReference({ url: KEY })).toBe(true);
    expect(hasPotentialStoredFileReference({ rich: [{ text: 'download', link: KEY }] })).toBe(true);
  });

  it('atomically detaches a page reference and restores it during the grace period', async () => {
    const database = fixture();
    const current = database.tables.pages[0] as unknown as Page;

    const detached = await updateCover(database, current, null, T1);
    expect(detached.cover).toBeUndefined();
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleting',
      deletionPreviousStatus: 'uploaded',
      deletedBy: 'owner-1',
      expiresAt: expect.any(String),
    });
    expect(Date.parse(String(database.tables.file_uploads[0].expiresAt))).toBeGreaterThan(Date.now());

    await updateCover(database, detached, KEY, '2026-01-01T00:02:00.000Z');
    expect(database.tables.pages[0]).toMatchObject({ cover: KEY });
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded',
      expiresAt: null,
      deletionPreviousStatus: null,
      deletedBy: null,
    });
  });

  it('cannot commit only one side when the owner/upload transaction fails', async () => {
    const database = fixture();
    database.transact = async () => {
      throw new Error('Simulated transaction outage.');
    };

    await expect(
      updateCover(database, database.tables.pages[0] as unknown as Page, null, T1),
    ).rejects.toThrow('Simulated transaction outage.');
    expect(database.tables.pages[0]).toMatchObject({ cover: KEY, updatedAt: T0 });
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'uploaded' });
  });

  it.each(['deleted', 'expired'] as const)(
    'rejects reattaching an irreversible %s upload',
    async (status) => {
      const database = fixture(status);
      database.tables.pages[0].cover = undefined;
      await expect(
        updateCover(database, database.tables.pages[0] as unknown as Page, KEY, T1),
      ).rejects.toMatchObject({ code: 409 });
      expect(database.tables.pages[0].cover).toBeUndefined();
    },
  );

  it.each([
    ['unknown', 'quarantined'],
    ['missing', undefined],
  ])('rejects adding a stored upload with %s status', async (_label, status) => {
    const database = fixture();
    database.tables.pages[0].cover = undefined;
    database.tables.file_uploads[0].status = status;

    await expect(updateCover(
      database,
      database.tables.pages[0] as unknown as Page,
      KEY,
      T1,
    )).rejects.toMatchObject({ code: 409 });
    expect(database.tables.pages[0].cover).toBeUndefined();
  });

  it('rejects a stored key whose upload metadata is missing', async () => {
    const database = fixture();
    database.tables.pages[0].cover = undefined;
    database.tables.file_uploads.length = 0;
    await expect(
      updateCover(database, database.tables.pages[0] as unknown as Page, KEY, T1),
    ).rejects.toMatchObject({ code: 409 });
  });

  it.each([
    'https://images.example/cover.png',
    'https://evil.example/api/storage/files/workspaces/ws1/covers/collision.png',
    '//evil.example/api/storage/files/workspaces/ws1/covers/collision.png',
    '/proxy/api/storage/files/workspaces/ws1/covers/collision.png',
  ])('keeps an ordinary external/noncanonical URL outside stored-file ownership: %s', async (url) => {
    const database = fixture();
    database.tables.pages[0].cover = undefined;
    database.tables.file_uploads.length = 0;

    await expect(
      updateCover(database, database.tables.pages[0] as unknown as Page, url, T1),
    ).resolves.toMatchObject({ cover: url });
  });

  it('rejects an exact canonical upload URL owned by another target', async () => {
    const url = 'https://storage.example/api/storage/files/workspaces/ws1/covers/owned.png';
    const database = fixture();
    database.tables.pages.push({
      id: 'p2', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 1,
    });
    database.tables.pages[0].cover = undefined;
    database.tables.file_uploads[0] = {
      ...database.tables.file_uploads[0],
      pageId: 'p2',
      key: 'workspaces/ws1/covers/owned.png',
      url,
      status: 'uploaded',
    };

    await expect(
      updateCover(database, database.tables.pages[0] as unknown as Page, url, T1),
    ).rejects.toMatchObject({ code: 409 });
  });

  it('matches same-host protocol-relative/default-port storage URLs without trusting an evil host', async () => {
    const key = 'workspaces/ws1/covers/space name.png';
    const canonicalUrl = 'http://localhost:80/api/storage/files/workspaces/ws1/covers/space%20name.png';
    const referenceUrl = '//localhost/api/storage/files/workspaces/ws1/covers/space%20name.png';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: 'owner-1' }], workspace_members: [],
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
        cover: referenceUrl, updatedAt: T0,
      }],
      blocks: [], db_properties: [], db_templates: [],
      file_uploads: [{
        id: 'same-host-upload', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key,
        url: canonicalUrl, status: 'uploaded', completedAt: T0,
      }],
    });
    const snapshot = await workspaceFileReferenceSnapshot(database, 'ws1', database);
    await expect(fileUploadStillReferenced(
      database,
      database.tables.file_uploads[0] as unknown as FileUpload,
      snapshot,
    )).resolves.toBe(true);

    await updateCover(database, database.tables.pages[0] as unknown as Page, null, T1);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleting', deletionPreviousStatus: 'uploaded',
    });
  });

  it('allows a structured record containing multiple ordinary external URLs', async () => {
    const database = fixture();
    database.tables.pages[0].cover = undefined;
    const current = database.tables.pages[0] as unknown as Page;

    await expect(updateWithFileReferenceLifecycle(database, {
      table: 'pages',
      current,
      data: {
        properties: {
          preview: {
            url: 'https://images.example/full.png',
            src: 'https://cdn.example/thumb.png',
          },
        },
        updatedAt: T1,
      },
      currentReferences: {},
      nextReferences: {
        properties: {
          preview: {
            url: 'https://images.example/full.png',
            src: 'https://cdn.example/thumb.png',
          },
        },
      },
      association: { field: 'pageId', id: current.id },
      actorId: 'owner-1',
    })).resolves.toMatchObject({
      properties: { preview: { url: 'https://images.example/full.png' } },
    });
  });

  it('rejects identifier recombination even when the overall token set is unchanged', async () => {
    const keyA = 'workspaces/ws1/files/a.pdf';
    const keyB = 'workspaces/ws1/files/b.pdf';
    const currentProperties = {
      files: [
        { uploadId: 'upload-a', key: keyA },
        { uploadId: 'upload-b', key: keyB },
      ],
    };
    const database = fakeDb({
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
        properties: currentProperties, updatedAt: T0,
      }],
      file_uploads: [
        { id: 'upload-a', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: keyA, status: 'uploaded' },
        { id: 'upload-b', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: keyB, status: 'uploaded' },
      ],
    });

    await expect(updateWithFileReferenceLifecycle(database, {
      table: 'pages',
      current: database.tables.pages[0] as unknown as Page,
      data: {
        properties: {
          files: [
            { uploadId: 'upload-a', key: keyB },
            { uploadId: 'upload-b', key: keyA },
          ],
        },
        updatedAt: T1,
      },
      currentReferences: currentProperties,
      nextReferences: {
        files: [
          { uploadId: 'upload-a', key: keyB },
          { uploadId: 'upload-b', key: keyA },
        ],
      },
      association: { field: 'pageId', id: 'p1' },
      actorId: 'owner-1',
    })).rejects.toMatchObject({ code: 409 });
    expect(database.tables.pages[0].properties).toEqual(currentProperties);
  });

  it('validates uploadId against legacy link/file locator aliases too', async () => {
    const keyA = 'workspaces/ws1/files/a.pdf';
    const keyB = 'workspaces/ws1/files/b.pdf';
    const database = fakeDb({
      pages: [{ id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0 }],
      file_uploads: [
        { id: 'upload-a', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: keyA, status: 'uploaded' },
        { id: 'upload-b', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key: keyB, status: 'uploaded' },
      ],
    });

    await expect(updateWithFileReferenceLifecycle(database, {
      table: 'pages', current: database.tables.pages[0] as unknown as Page,
      data: { properties: { file: { uploadId: 'upload-a', link: keyB } }, updatedAt: T1 },
      currentReferences: {},
      nextReferences: { file: { uploadId: 'upload-a', link: keyB } },
      association: { field: 'pageId', id: 'p1' }, actorId: 'owner-1',
    })).rejects.toMatchObject({ code: 409 });
  });

  it('does not restore a deleting row without evidence that its bytes completed upload', async () => {
    const database = fixture('deleting');
    database.tables.pages[0].cover = undefined;
    database.tables.file_uploads[0].deletionPreviousStatus = null;
    database.tables.file_uploads[0].completedAt = null;

    await expect(updateCover(
      database,
      database.tables.pages[0] as unknown as Page,
      KEY,
      T1,
    )).rejects.toMatchObject({ code: 409 });
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleting', deletionPreviousStatus: null, completedAt: null,
    });
  });

  it('finds a legacy shared key outside the upload association, including templates', async () => {
    const database = fixture('deleting');
    database.tables.pages[0].cover = undefined;
    database.tables.db_templates.push({
      id: 'template-1',
      databaseId: 'p1',
      icon: KEY,
    });
    const upload = database.tables.file_uploads[0] as unknown as FileUpload;
    const snapshot = await workspaceFileReferenceSnapshot(database, 'ws1', database);
    await expect(fileUploadStillReferenced(database, upload, snapshot)).resolves.toBe(true);
  });

  it('uses database schema to find raw row/template files without treating text literals as files', async () => {
    const rowKey = 'workspaces/ws1/database/files/raw-row.pdf';
    const templateKey = 'workspaces/ws1/database/files/raw-template.pdf';
    const proseKey = 'workspaces/ws1/database/files/mentioned-in-prose.pdf';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: 'owner-1' }],
      workspace_members: [],
      pages: [
        { id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database', position: 0 },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database',
          kind: 'page', position: 0,
          properties: { files: [rowKey], notes: proseKey },
        },
      ],
      blocks: [],
      db_properties: [
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 0 },
        { id: 'notes', databaseId: 'db1', name: 'Notes', type: 'rich_text', position: 1 },
      ],
      db_templates: [{
        id: 'template-1', databaseId: 'db1', properties: { files: templateKey, notes: proseKey },
      }],
      file_uploads: [
        {
          id: 'row-upload', workspaceId: 'ws1', pageId: 'row1', bucket: 'files',
          key: rowKey, status: 'deleting', deletionPreviousStatus: 'uploaded',
        },
        {
          id: 'template-upload', workspaceId: 'ws1', templateId: 'template-1', bucket: 'files',
          key: templateKey, status: 'deleting', deletionPreviousStatus: 'uploaded',
        },
        {
          id: 'prose-upload', workspaceId: 'ws1', pageId: 'row1', bucket: 'files',
          key: proseKey, status: 'deleting', deletionPreviousStatus: 'uploaded',
        },
      ],
    });

    const snapshot = await workspaceFileReferenceSnapshot(database, 'ws1', database);
    await expect(fileUploadStillReferenced(
      database,
      database.tables.file_uploads[0] as unknown as FileUpload,
      snapshot,
    )).resolves.toBe(true);
    await expect(fileUploadStillReferenced(
      database,
      database.tables.file_uploads[1] as unknown as FileUpload,
      snapshot,
    )).resolves.toBe(true);
    await expect(fileUploadStillReferenced(
      database,
      database.tables.file_uploads[2] as unknown as FileUpload,
      snapshot,
    )).resolves.toBe(false);
  });

  it('keeps raw stored locators in regular page properties visible to irreversible cleanup', async () => {
    const key = 'workspaces/ws1/files/page-property.pdf';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: 'owner-1' }],
      workspace_members: [],
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
        properties: { attachment: [key] },
      }],
      blocks: [], db_properties: [], db_templates: [],
      file_uploads: [{
        id: 'page-property-upload', workspaceId: 'ws1', pageId: 'p1', bucket: 'files',
        key, status: 'deleting', deletionPreviousStatus: 'uploaded',
      }],
    });

    const snapshot = await workspaceFileReferenceSnapshot(database, 'ws1', database);
    await expect(fileUploadStillReferenced(
      database,
      database.tables.file_uploads[0] as unknown as FileUpload,
      snapshot,
    )).resolves.toBe(true);
  });
});
