import { describe, expect, it } from 'vitest';

import { POST, normalizeExpiresIn, secondsFromDuration } from '../../functions/file-mutation';
import { fakeDb, type FakeDb } from './helpers/fake-db';
import { callFunction, expectErrorResponse, handlerOf } from './helpers/function-context';

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const OWNER = 'owner-1';
const PAST = '2020-01-01T00:00:00.000Z';

describe('normalizeExpiresIn signed-URL TTL clamp', () => {
  it('defaults to one hour when absent or blank', () => {
    expect(secondsFromDuration(normalizeExpiresIn(undefined))).toBe(3600);
    expect(secondsFromDuration(normalizeExpiresIn('   '))).toBe(3600);
  });

  it('preserves a reasonable requested TTL', () => {
    expect(secondsFromDuration(normalizeExpiresIn('15m'))).toBe(900);
    expect(secondsFromDuration(normalizeExpiresIn('2h'))).toBe(7200);
  });

  it('clamps an oversized TTL so no caller can mint a permanent URL', () => {
    expect(secondsFromDuration(normalizeExpiresIn('3650d'))).toBe(MAX_TTL_SECONDS);
    expect(secondsFromDuration(normalizeExpiresIn('999999h'))).toBe(MAX_TTL_SECONDS);
    // The 7-day cap itself is allowed through unchanged.
    expect(secondsFromDuration(normalizeExpiresIn('7d'))).toBe(MAX_TTL_SECONDS);
  });

  it('rejects malformed durations', () => {
    expect(() => normalizeExpiresIn('soon')).toThrow('expiresIn is invalid.');
    expect(() => normalizeExpiresIn('10x')).toThrow('expiresIn is invalid.');
  });
});

describe('statusForError target-mismatch family', () => {
  it('maps "outside the …" target mismatches to 400 instead of 500', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [
        { id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', inTrash: false, createdBy: OWNER },
        { id: 'p2', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', inTrash: false, createdBy: OWNER },
      ],
      blocks: [{ id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 }],
    });
    const res = await callFunction(POST, database, OWNER, {
      action: 'prepareUpload',
      pageId: 'p2',
      blockId: 'b1',
      name: 'photo.png',
      size: 100,
    });
    await expectErrorResponse(res, 400, 'Target block is outside the page.');
  });
});

describe('file mutation routing and targetless authorization', () => {
  it('rejects a targetless upload grant for a view-only workspace guest', async () => {
    const guest = 'guest-1';
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      workspace_members: [{ id: 'guest-member', workspaceId: 'ws1', userId: guest, role: 'guest' }],
      file_uploads: [],
    });
    const response = await callFunction(POST, database, guest, {
      action: 'prepareUpload', workspaceId: 'ws1', name: 'quota.bin', size: 4,
      contentType: 'application/octet-stream',
    });
    await expectErrorResponse(response, 403, 'access required.');
    expect(database.tables.file_uploads).toEqual([]);
  });

  it.each(['delete', 'signedUrl'])(
    'returns an explicit route contract error for ID-only %s',
    async (action) => {
      const response = await callFunction(POST, fakeDb(), OWNER, {
        action, id: 'upload-without-shard',
      });
      await expectErrorResponse(response, 400, 'workspaceId or a workspace-qualified storage key is required');
    },
  );
});

describe('upload content and stored-object integrity guards', () => {
  function uploadContext(
    database: FakeDb,
    body: Record<string, unknown>,
    stored: { size: number; contentType: string; etag: string } = {
      size: 4,
      contentType: 'text/plain',
      etag: 'etag-current',
    },
  ) {
    const deleted: string[] = [];
    const storage = {
      bucket() {
        return this;
      },
      async head(key: string) {
        return { key, ...stored, customMetadata: {} };
      },
      async delete(key: string) {
        deleted.push(key);
      },
      async getSignedUrl(key: string) {
        return `http://localhost:8787/storage/${key}`;
      },
      async getSignedUploadUrl(key: string, options?: { maxBytes?: number | null }) {
        return {
          url: `http://localhost:8787/upload/${key}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          maxBytes: options?.maxBytes ?? null,
        };
      },
    };
    return {
      deleted,
      context: {
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: { db: () => database },
        storage,
        request: new Request('http://localhost:8787/functions/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      },
    };
  }

  function ownerDatabase(extra: Record<string, Array<Record<string, unknown> & { id: string }>> = {}) {
    return fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      file_uploads: [],
      ...extra,
    });
  }

  it('prepares uploads with an explicit template owner and validates its database', async () => {
    const database = ownerDatabase({
      pages: [{
        id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database', inTrash: false,
      }],
      db_templates: [{ id: 'template-1', databaseId: 'db1', name: 'Template' }],
    });
    const preparedContext = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', databaseId: 'db1', templateId: 'template-1',
      name: 'template-image.png', size: 4, contentType: 'image/png',
    });
    const prepared = await handlerOf(POST)(preparedContext.context) as {
      upload: { templateId?: string; databaseId?: string };
    };
    expect(prepared.upload).toMatchObject({ templateId: 'template-1', databaseId: 'db1' });

    const mismatchContext = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', databaseId: 'other-db', templateId: 'template-1',
      name: 'template-image.png', size: 4, contentType: 'image/png',
    });
    const mismatch = await handlerOf(POST)(mismatchContext.context);
    await expectErrorResponse(mismatch, 400, 'Target template is outside the database.');
  });

  it('keeps metadata and quota reserved when activation fails after issuing a signed PUT grant', async () => {
    const database = ownerDatabase({
      workspaces: [{
        id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1',
      }],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER, storageLimitBytes: 100 }],
      organization_storage_usage: [{
        id: 'org1', organizationId: 'org1', reservedBytes: 0, version: 0,
      }],
      organization_storage_reservations: [],
    });
    const originalTable = database.table.bind(database);
    let failActivationOnce = true;
    database.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'file_uploads') return table;
      return {
        ...table,
        async update(id: string, patch: Record<string, unknown>) {
          if (failActivationOnce && patch.status === 'pending') {
            failActivationOnce = false;
            throw new Error('Simulated activation outage after grant issuance.');
          }
          return table.update(id, patch);
        },
      };
    }) as typeof database.table;
    const invocation = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', name: 'grant.bin', size: 4,
      contentType: 'application/octet-stream',
    });

    const response = await handlerOf(POST)(invocation.context);

    await expectErrorResponse(response, 500, 'Internal server error.');
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'pending', expiresAt: expect.any(String),
    });
    expect(Date.parse(String(database.tables.file_uploads[0].expiresAt))).toBeGreaterThan(Date.now());
    expect(database.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 4 });
    expect(database.tables.organization_storage_reservations[0]).toMatchObject({
      status: 'active', bytes: 4,
    });
    expect(invocation.deleted).toEqual([]);
  });

  it('rejects contradictory page/database/property/template target combinations', async () => {
    const database = ownerDatabase({
      pages: [
        { id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database', inTrash: false },
        { id: 'db2', workspaceId: 'ws1', parentType: 'workspace', kind: 'database', inTrash: false },
        { id: 'row1', workspaceId: 'ws1', parentType: 'database', parentId: 'db1', kind: 'page', inTrash: false },
      ],
      blocks: [{ id: 'block-row1', pageId: 'row1', type: 'paragraph', position: 0 }],
      db_properties: [
        { id: 'files-db1', databaseId: 'db1', name: 'Files', type: 'files' },
        { id: 'notes-db1', databaseId: 'db1', name: 'Notes', type: 'rich_text' },
        { id: 'files-db2', databaseId: 'db2', name: 'Files', type: 'files' },
      ],
      db_templates: [{ id: 'template-1', databaseId: 'db1', name: 'Template' }],
    });
    const templatePage = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', pageId: 'row1', templateId: 'template-1',
      name: 'bad.png', size: 4, contentType: 'image/png',
    });
    await expectErrorResponse(
      await handlerOf(POST)(templatePage.context),
      400,
      'cannot also target a page or block',
    );

    const wrongProperty = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', pageId: 'row1', propertyId: 'files-db2',
      name: 'bad.png', size: 4, contentType: 'image/png',
    });
    await expectErrorResponse(
      await handlerOf(POST)(wrongProperty.context),
      400,
      'outside the database row',
    );

    const nonFilesProperty = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', pageId: 'row1', propertyId: 'notes-db1',
      name: 'bad.png', size: 4, contentType: 'image/png',
    });
    await expectErrorResponse(
      await handlerOf(POST)(nonFilesProperty.context),
      400,
      'not a files property',
    );

    const blockAndProperty = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', blockId: 'block-row1', propertyId: 'files-db1',
      name: 'bad.png', size: 4, contentType: 'image/png',
    });
    await expectErrorResponse(
      await handlerOf(POST)(blockAndProperty.context),
      400,
      'cannot also target a database property',
    );
    expect(database.tables.file_uploads).toEqual([]);
  });

  it('checks edit access on both a database row and its parent database', async () => {
    const editor = 'editor-1';
    const database = ownerDatabase({
      workspace_members: [{ id: 'guest', workspaceId: 'ws1', userId: editor, role: 'guest' }],
      pages: [
        { id: 'db1', workspaceId: 'ws1', parentType: 'workspace', kind: 'database', inTrash: false },
        { id: 'row1', workspaceId: 'ws1', parentType: 'database', parentId: 'db1', kind: 'page', inTrash: false },
      ],
      db_properties: [{ id: 'files', databaseId: 'db1', name: 'Files', type: 'files' }],
      page_permissions: [{
        id: 'row-edit', workspaceId: 'ws1', pageId: 'row1', principalType: 'user',
        principalId: editor, role: 'edit',
      }],
    });
    const preparedContext = uploadContext(database, {
      action: 'prepareUpload', workspaceId: 'ws1', pageId: 'row1', propertyId: 'files',
      name: 'private.png', size: 4, contentType: 'image/png',
    });
    preparedContext.context.auth = { id: editor, email: `${editor}@example.com` };

    const response = await handlerOf(POST)(preparedContext.context);
    await expectErrorResponse(response, 403, 'access required');
    expect(database.tables.file_uploads).toEqual([]);
  });

  it.each([
    ['page.html', 'text/plain'],
    ['icon.svg', 'image/png'],
    ['payload.bin', 'text/html; charset=utf-8'],
    ['payload.bin', 'application/javascript'],
    ['payload.bin', 'text/css'],
    ['payload.bin', 'application/atom+xml'],
    ['module.cjs', 'application/octet-stream'],
    ['vector.svgz', 'application/gzip'],
    ['transform.xslt', 'text/plain'],
  ])('rejects active web content before issuing a grant (%s, %s)', async (name, contentType) => {
    const database = ownerDatabase();
    const { context } = uploadContext(database, {
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name,
      size: 4,
      contentType,
    });
    const result = await handlerOf(POST)(context);
    await expectErrorResponse(result, 400, 'Active web content files are not allowed.');
    expect(database.tables.file_uploads).toHaveLength(0);
  });

  it('deletes a mismatched object but keeps its still-active grant pending for post-expiry cleanup', async () => {
    const database = ownerDatabase();
    const prepare = uploadContext(database, {
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'note.txt',
      size: 8,
      contentType: 'text/plain',
    });
    const prepared = (await handlerOf(POST)(prepare.context)) as { upload: { id: string; key: string } };
    const complete = uploadContext(
      database,
      {
        action: 'completeUpload',
        workspaceId: 'ws1',
        id: prepared.upload.id,
        key: prepared.upload.key,
      },
      { size: 1, contentType: 'text/plain', etag: 'etag-size-mismatch' },
    );
    const result = await handlerOf(POST)(complete.context);
    await expectErrorResponse(result, 400, 'Uploaded file size does not match the grant.');
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'pending' });
    expect(complete.deleted).toContain(prepared.upload.key);
  });

  it('deletes a content-type-mismatched object while retaining its active grant metadata', async () => {
    const database = ownerDatabase();
    const prepared = (await handlerOf(POST)(uploadContext(database, {
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'note.txt',
      size: 4,
      contentType: 'text/plain',
    }).context)) as { upload: { id: string; key: string } };
    const complete = uploadContext(
      database,
      {
        action: 'completeUpload',
        workspaceId: 'ws1',
        id: prepared.upload.id,
        key: prepared.upload.key,
      },
      { size: 4, contentType: 'application/octet-stream', etag: 'etag-type-mismatch' },
    );
    const result = await handlerOf(POST)(complete.context);
    await expectErrorResponse(result, 400, 'Uploaded file content type does not match the grant.');
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'pending' });
  });

  it('keeps the grant pending and reserved when mismatched-object deletion fails', async () => {
    const database = ownerDatabase();
    const prepared = (await handlerOf(POST)(uploadContext(database, {
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'note.txt',
      size: 4,
      contentType: 'text/plain',
    }).context)) as { upload: { id: string; key: string } };
    const complete = uploadContext(
      database,
      {
        action: 'completeUpload',
        workspaceId: 'ws1',
        id: prepared.upload.id,
        key: prepared.upload.key,
      },
      { size: 1, contentType: 'text/plain', etag: 'etag-delete-failure' },
    );
    complete.context.storage.delete = async () => {
      throw new Error('Simulated storage delete outage.');
    };
    const result = await handlerOf(POST)(complete.context);
    await expectErrorResponse(result, 500, 'Internal server error.');
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'pending' });
  });

  it('persists the verified object etag when an upload completes', async () => {
    const database = ownerDatabase();
    const prepared = (await handlerOf(POST)(uploadContext(database, {
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'note.txt',
      size: 4,
      contentType: 'text/plain',
    }).context)) as { upload: { id: string; key: string } };

    const completed = (await handlerOf(POST)(uploadContext(database, {
      action: 'completeUpload',
      workspaceId: 'ws1',
      id: prepared.upload.id,
      key: prepared.upload.key,
    }).context)) as { upload: { etag?: string; status: string } };

    expect(completed.upload).toMatchObject({
      status: 'uploaded',
      etag: 'etag-current',
      expiresAt: null,
    });
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded',
      etag: 'etag-current',
      expiresAt: null,
    });
  });

  it.each(['pending', 'uploaded'])(
    'blocks direct deletion of a %s row while its signed upload grant is active',
    async (status) => {
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const database = ownerDatabase({
        file_uploads: [{
          id: `active-${status}`,
          workspaceId: 'ws1',
          bucket: 'files',
          key: `workspaces/ws1/uploads/active-${status}.txt`,
          name: `active-${status}.txt`,
          size: 4,
          contentType: 'text/plain',
          status,
          expiresAt,
          createdBy: OWNER,
          ...(status === 'uploaded' ? { etag: 'etag-active' } : {}),
        }],
      });
      const invocation = uploadContext(database, {
        action: 'delete',
        workspaceId: 'ws1',
        id: `active-${status}`,
      });

      const result = await handlerOf(POST)(invocation.context);

      await expectErrorResponse(result, 409, 'active upload grant');
      expect(invocation.deleted).toEqual([]);
      expect(database.tables.file_uploads[0]).toMatchObject({ status, expiresAt });
    },
  );

  it.each([
    ['uploaded', undefined],
    ['deleting', 'uploaded'],
  ])('blocks direct deletion of an unverified %s row with unknown grant expiry', async (
    status,
    deletionPreviousStatus,
  ) => {
    const database = ownerDatabase({
      file_uploads: [{
        id: 'unknown-grant', workspaceId: 'ws1', bucket: 'files',
        key: 'workspaces/ws1/uploads/unknown-grant.txt', name: 'unknown-grant.txt',
        size: 4, contentType: 'text/plain', etag: 'etag-current', status,
        deletionPreviousStatus, completedAt: null, expiresAt: null, createdBy: OWNER,
      }],
    });
    const invocation = uploadContext(database, {
      action: 'delete', workspaceId: 'ws1', id: 'unknown-grant',
    });

    const response = await handlerOf(POST)(invocation.context);

    await expectErrorResponse(response, 409, 'active upload grant');
    expect(invocation.deleted).toEqual([]);
    expect(database.tables.file_uploads[0]).toMatchObject({ status, expiresAt: null });
  });

  it('refuses to mint a signed URL when the stored object etag no longer matches metadata', async () => {
    const database = ownerDatabase({
      file_uploads: [{
        id: 'uploaded-etag-mismatch',
        workspaceId: 'ws1',
        bucket: 'files',
        key: 'workspaces/ws1/uploads/uploaded-etag-mismatch.txt',
        name: 'uploaded-etag-mismatch.txt',
        size: 4,
        contentType: 'text/plain',
        status: 'uploaded',
        etag: 'etag-recorded-at-completion',
        completedAt: PAST,
        createdBy: OWNER,
      }],
    });
    const invocation = uploadContext(database, {
      action: 'signedUrl',
      workspaceId: 'ws1',
      id: 'uploaded-etag-mismatch',
    });

    const result = await handlerOf(POST)(invocation.context);

    await expectErrorResponse(result, 409, 'Stored file integrity verification failed.');
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded',
      etag: 'etag-recorded-at-completion',
    });
  });

  it.each([
    ['uploaded', undefined, new Date(Date.now() + 60_000).toISOString()],
    ['uploaded', undefined, null],
    ['deleting', 'uploaded', new Date(Date.now() + 60_000).toISOString()],
    ['deleting', 'uploaded', null],
  ])('does not sign an unverified %s row while its legacy grant expiry is active/unknown', async (
    status,
    deletionPreviousStatus,
    expiresAt,
  ) => {
    const database = ownerDatabase({
      file_uploads: [{
        id: 'legacy-active', workspaceId: 'ws1', bucket: 'files',
        key: 'workspaces/ws1/uploads/legacy-active.txt', name: 'legacy-active.txt',
        size: 4, contentType: 'text/plain', etag: 'etag-current',
        status, deletionPreviousStatus, completedAt: null, expiresAt, createdBy: OWNER,
      }],
    });
    const invocation = uploadContext(database, {
      action: 'signedUrl', workspaceId: 'ws1', id: 'legacy-active',
    });

    const response = await handlerOf(POST)(invocation.context);

    await expectErrorResponse(response, 409, 'active legacy upload grant');
    expect(database.tables.file_uploads[0]).toMatchObject({ status, expiresAt });
  });

  it('signs an unverified legacy upload only after its known grant expiry and integrity check', async () => {
    const database = ownerDatabase({
      file_uploads: [{
        id: 'legacy-expired-grant', workspaceId: 'ws1', bucket: 'files',
        key: 'workspaces/ws1/uploads/legacy-expired-grant.txt', name: 'legacy-expired-grant.txt',
        size: 4, contentType: 'text/plain', etag: 'etag-current', status: 'uploaded',
        completedAt: null, expiresAt: PAST, createdBy: OWNER,
      }],
    });
    const invocation = uploadContext(database, {
      action: 'signedUrl', workspaceId: 'ws1', id: 'legacy-expired-grant',
    });

    const result = await handlerOf(POST)(invocation.context) as { url?: string };

    expect(result.url).toContain('legacy-expired-grant.txt');
  });

  it('refuses direct byte deletion while a page still advertises the stored key', async () => {
    const key = 'workspaces/ws1/covers/still-live.txt';
    const database = ownerDatabase({
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
        inTrash: false, createdBy: OWNER, cover: key,
      }],
      blocks: [],
      db_templates: [],
      workspace_members: [],
      file_uploads: [{
        id: 'still-live', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key,
        name: 'still-live.txt', size: 4, contentType: 'text/plain', status: 'uploaded',
        etag: 'etag-current', createdBy: OWNER,
      }],
    });
    const invocation = uploadContext(database, {
      action: 'delete', workspaceId: 'ws1', id: 'still-live',
    });

    const result = await handlerOf(POST)(invocation.context);
    await expectErrorResponse(result, 409, 'Detach every stored-file reference');
    expect(invocation.deleted).toEqual([]);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'uploaded' });
  });

  it('restores a legacy shared-key deleting row before minting a signed URL', async () => {
    const key = 'workspaces/ws1/covers/legacy-shared.txt';
    const database = ownerDatabase({
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
        inTrash: false, createdBy: OWNER, cover: key,
      }],
      blocks: [],
      db_templates: [],
      workspace_members: [],
      file_uploads: [{
        id: 'legacy-shared', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key,
        name: 'legacy-shared.txt', size: 4, contentType: 'text/plain', status: 'deleting',
        deletionPreviousStatus: 'uploaded', expiresAt: '2020-01-01T00:00:00.000Z',
        completedAt: '2020-01-01T00:00:00.000Z', etag: 'etag-current', createdBy: OWNER,
      }],
    });
    const invocation = uploadContext(database, {
      action: 'signedUrl', workspaceId: 'ws1', id: 'legacy-shared',
    });

    const result = await handlerOf(POST)(invocation.context) as {
      upload: { status: string };
      url?: string;
    };
    expect(result.upload.status).toBe('uploaded');
    expect(result.url).toContain('legacy-shared.txt');
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded', deletionPreviousStatus: null, expiresAt: null,
    });
  });

  it('does not let a stale source-page grant authorize the surviving private owner', async () => {
    const viewer = 'viewer-a';
    const key = 'workspaces/ws1/covers/private-owner.txt';
    const database = ownerDatabase({
      pages: [
        {
          id: 'page-a', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
          inTrash: false, createdBy: OWNER,
        },
        {
          id: 'page-b', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 1,
          inTrash: false, createdBy: OWNER, cover: key,
        },
      ],
      page_permissions: [{
        id: 'permission-a', workspaceId: 'ws1', pageId: 'page-a',
        principalType: 'user', principalId: viewer, role: 'view',
      }],
      blocks: [],
      db_templates: [],
      workspace_members: [],
      file_uploads: [{
        id: 'private-owner', workspaceId: 'ws1', pageId: 'page-a', bucket: 'files', key,
        name: 'private-owner.txt', size: 4, contentType: 'text/plain', status: 'deleting',
        deletionPreviousStatus: 'uploaded', expiresAt: '2020-01-01T00:00:00.000Z',
        completedAt: '2020-01-01T00:00:00.000Z', etag: 'etag-current', createdBy: OWNER,
      }],
    });
    let signed = 0;
    const invocation = uploadContext(database, {
      action: 'signedUrl', workspaceId: 'ws1', id: 'private-owner',
    });
    invocation.context.auth = { id: viewer, email: `${viewer}@example.com` };
    invocation.context.storage.getSignedUrl = async () => {
      signed += 1;
      return 'https://download.example/private';
    };

    const result = await handlerOf(POST)(invocation.context);
    await expectErrorResponse(result, 400, 'File is not available for download.');
    expect(signed).toBe(0);
    expect(database.tables.file_uploads[0]).toMatchObject({
      status: 'deleting', pageId: 'page-a',
    });
  });

  it.each(['delete', 'signedUrl'])('rejects a mismatched upload id and key for %s', async (action) => {
    const database = ownerDatabase({
      file_uploads: [
        {
          id: 'upload-a', workspaceId: 'ws1', bucket: 'files',
          key: 'workspaces/ws1/uploads/a.txt', name: 'a.txt', size: 4,
          contentType: 'text/plain', etag: 'etag-a', status: 'uploaded',
          completedAt: '2020-01-01T00:00:00.000Z', createdBy: OWNER,
        },
        {
          id: 'upload-b', workspaceId: 'ws1', bucket: 'files',
          key: 'workspaces/ws1/uploads/b.txt', name: 'b.txt', size: 4,
          contentType: 'text/plain', etag: 'etag-b', status: 'uploaded',
          completedAt: '2020-01-01T00:00:00.000Z', createdBy: OWNER,
        },
      ],
    });
    const invocation = uploadContext(database, {
      action,
      workspaceId: 'ws1',
      id: 'upload-a',
      key: 'workspaces/ws1/uploads/b.txt',
    });

    const result = await handlerOf(POST)(invocation.context);

    await expectErrorResponse(result, 409, 'id and storage key do not match');
    expect(invocation.deleted).toEqual([]);
    expect(database.tables.file_uploads.map((upload) => upload.status)).toEqual([
      'uploaded', 'uploaded',
    ]);
  });

  it.each(['delete', 'signedUrl'])('rejects an ambiguous key-only %s lookup', async (action) => {
    const key = 'workspaces/ws1/uploads/legacy-shared.txt';
    const database = ownerDatabase({
      file_uploads: [
        {
          id: 'legacy-a', workspaceId: 'ws1', bucket: 'files', key,
          name: 'legacy-a.txt', size: 4, contentType: 'text/plain', etag: 'etag-a',
          status: 'uploaded', completedAt: '2020-01-01T00:00:00.000Z', createdBy: OWNER,
        },
        {
          id: 'legacy-b', workspaceId: 'ws1', bucket: 'files', key,
          name: 'legacy-b.txt', size: 4, contentType: 'text/plain', etag: 'etag-b',
          status: 'uploaded', completedAt: '2020-01-01T00:00:00.000Z', createdBy: OWNER,
        },
      ],
    });
    const invocation = uploadContext(database, { action, key });

    const result = await handlerOf(POST)(invocation.context);

    await expectErrorResponse(result, 409, 'matches more than one file upload');
    expect(invocation.deleted).toEqual([]);
  });

  it('restores the same legacy live reference before a default file list hides deleting rows', async () => {
    const key = 'workspaces/ws1/icons/legacy-list.txt';
    const database = ownerDatabase({
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', position: 0,
        inTrash: false, createdBy: OWNER, icon: key,
      }],
      blocks: [],
      db_templates: [],
      workspace_members: [],
      file_uploads: [{
        id: 'legacy-list', workspaceId: 'ws1', pageId: 'p1', bucket: 'files', key,
        name: 'legacy-list.txt', size: 4, contentType: 'text/plain', status: 'deleting',
        deletionPreviousStatus: 'uploaded', expiresAt: '2020-01-01T00:00:00.000Z',
        completedAt: '2020-01-01T00:00:00.000Z', etag: 'etag-current', createdBy: OWNER,
      }],
    });
    const result = await handlerOf(POST)(uploadContext(database, {
      action: 'list', workspaceId: 'ws1',
    }).context) as { uploads: Array<{ id: string; status: string }> };

    expect(result.uploads).toEqual([
      expect.objectContaining({ id: 'legacy-list', status: 'uploaded' }),
    ]);
    expect(database.tables.file_uploads[0]).toMatchObject({ status: 'uploaded' });
  });
});

describe('organization storage limit across workspace shards', () => {
  // Post-split, each workspace's file_uploads live in that workspace's own
  // DO. The limit check must read sibling workspaces through their own
  // handles — through the CURRENT workspace's facade they are always empty
  // and the org-wide cap silently never trips.
  function shardedContext(body: Record<string, unknown>) {
    const central = fakeDb({
      workspaces: [
        { id: 'ws1', name: 'One', ownerId: OWNER, organizationId: 'org1' },
        { id: 'ws2', name: 'Two', ownerId: OWNER, organizationId: 'org1' },
      ],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER, storageLimitBytes: 1000 }],
    });
    const shards: Record<string, FakeDb> = {
      ws1: fakeDb({ file_uploads: [] }),
      ws2: fakeDb({
        file_uploads: [
          {
            id: 'u-existing',
            workspaceId: 'ws2',
            bucket: 'files',
            key: 'workspaces/ws2/uploads/u-existing-big.bin',
            scope: 'uploads',
            name: 'big.bin',
            size: 900,
            status: 'uploaded',
            createdBy: OWNER,
          },
        ],
      }),
    };
    return {
      shards,
      context: {
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: {
          db: (namespace: string, instanceId?: string) =>
            namespace === 'app' || !instanceId ? central : shards[instanceId] ?? fakeDb(),
        },
        request: new Request('http://localhost:8787/functions/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      },
    };
  }

  it("counts sibling workspaces' usage toward the organization limit", async () => {
    const { context } = shardedContext({
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'new.bin',
      size: 200,
    });
    const res = await handlerOf(POST)(context);
    // 900 bytes already reserved in ws2 + 200 requested > the 1000-byte cap.
    await expectErrorResponse(res, 403, 'Organization storage limit exceeded.');
  });

  it('allows an upload that fits under the organization-wide usage', async () => {
    const { shards, context } = shardedContext({
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'small.bin',
      size: 50,
    });
    const res = (await handlerOf(POST)(context)) as { upload?: { id: string } };
    expect(res.upload?.id).toBeTruthy();
    expect(shards.ws1.tables.file_uploads).toHaveLength(1);
  });

  it('atomically allows only one concurrent reservation at the remaining quota boundary', async () => {
    const body = {
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'boundary.bin',
      size: 100,
    };
    const { shards, context } = shardedContext(body);
    const secondContext = {
      ...context,
      request: new Request('http://localhost:8787/functions/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    };
    const results = await Promise.all([handlerOf(POST)(context), handlerOf(POST)(secondContext)]);
    const responses = results.filter((result): result is Response => result instanceof Response);
    expect(responses).toHaveLength(1);
    await expectErrorResponse(responses[0], 403, 'Organization storage limit exceeded.');
    expect(results.filter((result) => !(result instanceof Response))).toHaveLength(1);
    expect(shards.ws1.tables.file_uploads).toHaveLength(2);
    expect(shards.ws1.tables.file_uploads.filter((upload) => upload.status === 'pending')).toHaveLength(1);
    expect(shards.ws1.tables.file_uploads.filter((upload) => upload.status === 'expired')).toEqual([
      expect.objectContaining({ expiresAt: null }),
    ]);
    expect((context.admin.db('app') as FakeDb).tables.organization_storage_usage[0]).toMatchObject({
      reservedBytes: 1000,
    });
    expect((context.admin.db('app') as FakeDb).tables.organization_storage_reservations).toHaveLength(1);
  });

  it('keeps the organization reservation active until a mismatched active grant expires', async () => {
    const { shards, context } = shardedContext({
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'mismatch.bin',
      size: 50,
      contentType: 'application/octet-stream',
    });
    const prepared = (await handlerOf(POST)(context)) as { upload: { id: string; key: string } };
    const central = context.admin.db('app') as FakeDb;
    expect(central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 950 });
    const storage = {
      bucket() {
        return this;
      },
      async head(key: string) {
        return {
          key,
          size: 1,
          contentType: 'application/octet-stream',
          etag: 'etag-quota-mismatch',
          customMetadata: {},
        };
      },
      async delete() {},
      async getSignedUrl(key: string) {
        return key;
      },
    };
    const completed = await handlerOf(POST)({
      auth: { id: OWNER, email: `${OWNER}@example.com` },
      admin: context.admin,
      storage,
      request: new Request('http://localhost:8787/functions/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'completeUpload',
          workspaceId: 'ws1',
          id: prepared.upload.id,
          key: prepared.upload.key,
        }),
      }),
    });
    await expectErrorResponse(completed, 400, 'Uploaded file size does not match the grant.');
    expect(shards.ws1.tables.file_uploads[0]).toMatchObject({ status: 'pending' });
    expect(central.tables.organization_storage_usage[0]).toMatchObject({ reservedBytes: 950 });
    expect(central.tables.organization_storage_reservations[0]).toMatchObject({ status: 'active' });
  });
});
