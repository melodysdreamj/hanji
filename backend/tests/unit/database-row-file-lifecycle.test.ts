import { describe, expect, it } from 'vitest';

import { POST } from '../../functions/database-row-mutation';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const OWNER = 'owner-1';
const KEY = 'workspaces/ws1/database/files/attachment.pdf';

describe('database row stored-file lifecycle', () => {
  it.each([
    ['body icon', { icon: KEY }, undefined],
    ['body raw files string array', { properties: { files: [KEY] } }, undefined],
    ['body legacy id/sourceUrl file', {
      properties: { files: [{ id: KEY, sourceUrl: `/api/storage/files/${KEY}` }] },
    }, undefined],
    ['template raw files string', { templateId: 'template-1' }, { properties: { files: KEY } }],
    ['template block URL', { templateId: 'template-1' }, {
      blocks: [{ type: 'image', content: { url: KEY } }],
    }],
  ])('rejects pre-attached stored files during row create: %s', async (_label, body, template) => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [{
        id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
        title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
      }],
      blocks: [],
      db_properties: [
        { id: 'title', databaseId: 'db1', name: 'Name', type: 'title', position: 0 },
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 1 },
      ],
      db_templates: template ? [{
        id: 'template-1', databaseId: 'db1', name: 'Template', position: 0, ...template,
      }] : [],
      file_uploads: [],
    });

    const response = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', databaseId: 'db1', ...body }),
      }),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(409);
    expect(database.tables.pages).toHaveLength(1);
    expect(database.tables.blocks).toEqual([]);
  });

  it('creates an empty row normally before files are uploaded to its new owner ID', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [{
        id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
        title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
      }],
      db_properties: [
        { id: 'title', databaseId: 'db1', name: 'Name', type: 'title', position: 0 },
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 1 },
      ],
      db_templates: [],
      file_uploads: [],
    });

    const result = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', databaseId: 'db1', empty: true }),
      }),
    }) as { row: { id: string; parentId?: string } };

    expect(result.row.id).toEqual(expect.any(String));
    expect(result.row.parentId).toBe('db1');
    expect(database.tables.pages).toHaveLength(2);
  });

  it('keeps a raw files-property upload attached when only the row icon changes', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: false, createdBy: OWNER,
          icon: KEY,
          properties: { files: KEY },
        },
      ],
      db_properties: [
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 0 },
      ],
      file_uploads: [{
        id: 'attachment-upload', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
        propertyId: 'files', bucket: 'files', key: KEY, status: 'uploaded',
        completedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    const result = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: 'row1', databaseId: 'db1', patch: { icon: '📎' },
        }),
      }),
    }) as { row: { icon?: string; properties?: Record<string, unknown> } };

    expect(result.row).toMatchObject({ icon: '📎', properties: { files: KEY } });
    expect(database.tables.file_uploads[0]).toMatchObject({
      id: 'attachment-upload', status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('retires a removed file property in the same row transaction', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: false, createdBy: OWNER,
          updatedAt: '2026-01-01T00:00:00.000Z',
          properties: { files: [{ name: 'attachment.pdf', url: KEY }] },
        },
      ],
      db_properties: [
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 0 },
      ],
      file_uploads: [{
        id: 'attachment-upload',
        workspaceId: 'ws1',
        pageId: 'row1',
        databaseId: 'db1',
        propertyId: 'files',
        bucket: 'files',
        key: KEY,
        status: 'uploaded',
        completedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    const result = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: 'row1',
          databaseId: 'db1',
          patch: { properties: { files: [] } },
        }),
      }),
    }) as { row: { properties?: Record<string, unknown> } };

    expect(result.row.properties?.files).toEqual([]);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleting',
      deletionPreviousStatus: 'uploaded',
      deletedBy: OWNER,
    });
  });

  it.each([
    ['raw string', KEY],
    ['raw string array', [KEY]],
    ['legacy id/sourceUrl object', {
      id: KEY,
      sourceUrl: `/api/storage/files/${KEY}`,
      name: 'attachment.pdf',
    }],
  ])('retires a removed legacy files-property %s', async (_label, legacyValue) => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: false, createdBy: OWNER,
          updatedAt: '2026-01-01T00:00:00.000Z', properties: { files: legacyValue },
        },
      ],
      db_properties: [
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 0 },
      ],
      file_uploads: [{
        id: 'attachment-upload', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
        propertyId: 'files', bucket: 'files', key: KEY, status: 'uploaded',
        completedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: 'row1', databaseId: 'db1',
          patch: { properties: { files: [] } },
        }),
      }),
    });

    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleting', deletionPreviousStatus: 'uploaded', deletedBy: OWNER,
    });
  });

  it('does not treat a storage-looking string in an ordinary text property as a file', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: false, createdBy: OWNER,
          updatedAt: '2026-01-01T00:00:00.000Z', properties: { notes: KEY },
        },
      ],
      db_properties: [
        { id: 'notes', databaseId: 'db1', name: 'Notes', type: 'rich_text', position: 0 },
      ],
      file_uploads: [{
        id: 'unrelated-upload', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
        bucket: 'files', key: KEY, status: 'uploaded', completedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: 'row1', databaseId: 'db1',
          patch: { properties: { notes: 'updated prose' } },
        }),
      }),
    });

    expect(database.tables.file_uploads[0].status).toBe('uploaded');
  });

  it('rejects a files cell record whose uploadId and URL resolve to different uploads', async () => {
    const keyB = 'workspaces/ws1/database/files/other.pdf';
    const urlB = 'https://storage.example/files/other.pdf';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: false, createdBy: OWNER,
          updatedAt: '2026-01-01T00:00:00.000Z', properties: { files: [] },
        },
      ],
      db_properties: [
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 0 },
      ],
      file_uploads: [
        {
          id: 'upload-a', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
          propertyId: 'files', bucket: 'files', key: KEY, status: 'uploaded',
        },
        {
          id: 'upload-b', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
          propertyId: 'files', bucket: 'files', key: keyB, url: urlB, status: 'uploaded',
        },
      ],
    });

    const response = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: 'row1', databaseId: 'db1',
          patch: { properties: { files: [{ uploadId: 'upload-a', url: urlB }] } },
        }),
      }),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(409);
    expect(database.tables.pages[1].properties).toEqual({ files: [] });
  });

  it('revalidates a shared files-cell object in schema context and rejects mixed legacy id/sourceUrl', async () => {
    const keyB = 'workspaces/ws1/database/files/other.pdf';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', ownerId: OWNER }],
      pages: [
        {
          id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database',
          title: 'Database', position: 0, inTrash: false, createdBy: OWNER,
        },
        {
          id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
          title: 'Row', position: 0, inTrash: false, createdBy: OWNER,
          updatedAt: '2026-01-01T00:00:00.000Z', properties: { files: [] },
        },
      ],
      db_properties: [
        { id: 'files', databaseId: 'db1', name: 'Files', type: 'files', position: 0 },
      ],
      file_uploads: [
        {
          id: 'upload-a', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
          propertyId: 'files', bucket: 'files', key: KEY, status: 'uploaded',
          completedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'upload-b', workspaceId: 'ws1', pageId: 'row1', databaseId: 'db1',
          propertyId: 'files', bucket: 'files', key: keyB, status: 'uploaded',
          completedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const response = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: { db: () => database },
      request: new Request('http://localhost/functions/database-row-mutation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: 'row1', databaseId: 'db1',
          patch: {
            properties: {
              files: [{ id: KEY, sourceUrl: `/api/storage/files/${keyB}` }],
            },
          },
        }),
      }),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(409);
    expect(database.tables.pages[1].properties).toEqual({ files: [] });
  });
});
