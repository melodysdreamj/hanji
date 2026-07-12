import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/duplicate-page';
import { POST as pageMutationPOST } from '../../functions/page-mutation';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import {
  callFunction,
  expectErrorResponse,
  functionContext,
  handlerOf,
} from './helpers/function-context';

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const GUEST = 'guest-1';
const STRANGER = 'stranger-1';

function pageRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Page ${id}`,
    position: 0,
    inTrash: false,
    isLocked: false,
    isPublic: false,
    createdBy: OWNER,
    ...extra,
  };
}

function uploadRow(
  id: string,
  key: string,
  body: string,
  extra: Partial<Row> = {},
): Row {
  return {
    id,
    workspaceId: 'ws1',
    bucket: 'files',
    key,
    scope: 'uploads',
    name: `${id}.bin`,
    contentType: 'application/octet-stream',
    size: new TextEncoder().encode(body).byteLength,
    etag: `etag-${id}`,
    status: 'uploaded',
    completedAt: '2026-01-01T00:00:00.000Z',
    url: `http://localhost:8787/api/storage/files/${key}`,
    createdBy: OWNER,
    expiresAt: null,
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    workspace_members: [
      { id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' },
      { id: 'm2', workspaceId: 'ws1', userId: GUEST, role: 'guest' },
    ],
    pages: [pageRow('p1')],
    ...tables,
  });
}

interface StoredObject {
  body: Uint8Array;
  contentType: string;
  etag: string;
  customMetadata: Record<string, string>;
}

function trustedStorage(
  initial: Record<string, { body: string; contentType?: string; etag: string }>,
  options: { failTargetPutAt?: number; corruptTargetPutAt?: number } = {},
) {
  const objects = new Map<string, StoredObject>(Object.entries(initial).map(([key, value]) => [
    key,
    {
      body: new TextEncoder().encode(value.body),
      contentType: value.contentType ?? 'application/octet-stream',
      etag: value.etag,
      customMetadata: {},
    },
  ]));
  let targetPuts = 0;
  const api = {
    objects,
    bucket: () => api,
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Blob([object.body]).stream(),
        contentType: object.contentType,
        size: object.body.byteLength,
        etag: object.etag,
        customMetadata: { ...object.customMetadata },
      };
    },
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | string,
      putOptions?: { contentType?: string; customMetadata?: Record<string, string> },
    ) {
      if (key.includes('/duplicate-page/')) {
        targetPuts += 1;
        if (targetPuts === options.failTargetPutAt) throw new Error('Simulated copied-object write failure.');
      }
      let body = typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(await new Response(value).arrayBuffer());
      if (key.includes('/duplicate-page/') && targetPuts === options.corruptTargetPutAt && body.byteLength > 0) {
        body = body.slice();
        body[0] ^= 0xff;
      }
      objects.set(key, {
        body,
        contentType: putOptions?.contentType ?? 'application/octet-stream',
        etag: `copied-${targetPuts}-${body.byteLength}`,
        customMetadata: { ...(putOptions?.customMetadata ?? {}) },
      });
    },
    async head(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        key,
        contentType: object.contentType,
        size: object.body.byteLength,
        etag: object.etag,
        customMetadata: { ...object.customMetadata },
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return api;
}

function duplicate(
  database: FakeDb,
  userId: string | null,
  extra: Record<string, unknown> = {},
  storage?: ReturnType<typeof trustedStorage>,
) {
  const body = { action: 'duplicate', pageId: 'p1', ...extra };
  if (!storage) return callFunction(POST, database, userId, body);
  return handlerOf(POST)({ ...functionContext(database, userId, body), storage });
}

describe('duplicate-page POST', () => {
  it('requires authentication', async () => {
    const res = await duplicate(db(), null);
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  it('rejects an unknown action', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'bogus', pageId: 'p1' });
    await expectErrorResponse(res, 400, 'Unknown duplicate page action.');
  });

  it('rejects a body without a pageId routing hint', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'duplicate' });
    await expectErrorResponse(res, 400, 'pageId is required.');
  });

  describe('authorization', () => {
    it('denies strangers with no relation to the workspace', async () => {
      const res = await duplicate(db(), STRANGER);
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('denies a view-role workspace guest', async () => {
      const res = await duplicate(db(), GUEST);
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('allows an edit-role workspace member', async () => {
      const database = db();
      const res = (await duplicate(database, MEMBER)) as { page: Row };
      expect(res.page.createdBy).toBe(MEMBER);
    });

    it('allows a stranger holding a direct edit grant on the source page', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'edit',
          },
        ],
      });
      const res = (await duplicate(database, STRANGER)) as { page: Row };
      expect(res.page.title).toBe('Page p1 copy');
    });

    it('denies a stranger whose only grant is view', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'view',
          },
        ],
      });
      const res = await duplicate(database, STRANGER);
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('honors an edit grant inherited from an ancestor page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('child', { parentId: 'p1', parentType: 'page' })],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'edit',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, {
        action: 'duplicate',
        pageId: 'child',
      })) as { page: Row };
      expect(res.page.parentId).toBe('p1');
    });

    it('requires edit access at a different destination, not just on the source', async () => {
      // STRANGER can edit p1 through a direct grant but has no access to p2.
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'edit',
          },
        ],
      });
      const res = await duplicate(database, STRANGER, { parentId: 'p2', parentType: 'page' });
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('rejects deactivated organization members', async () => {
      const database = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_members: [
          { id: 'om1', organizationId: 'org1', userId: MEMBER, status: 'deactivated' },
        ],
        workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' }],
        pages: [pageRow('p1')],
      });
      const res = await duplicate(database, MEMBER);
      await expectErrorResponse(res, 403, 'Organization active access required.');
    });
  });

  describe('source and destination guards', () => {
    it('rejects a source page in trash', async () => {
      const database = db({ pages: [pageRow('p1', { inTrash: true })] });
      const res = await duplicate(database, OWNER);
      await expectErrorResponse(res, 400, 'Page is in trash.');
    });

    it('duplicates a locked source but the copy is unlocked and private', async () => {
      const database = db({ pages: [pageRow('p1', { isLocked: true, isPublic: true })] });
      const res = (await duplicate(database, OWNER)) as { page: Row };
      expect(res.page.isLocked).toBe(false);
      expect(res.page.isPublic).toBe(false);
    });

    it('rejects duplication under a locked parent with 423', async () => {
      const database = db({
        pages: [
          pageRow('parent', { isLocked: true }),
          pageRow('p1', { parentId: 'parent', parentType: 'page' }),
        ],
      });
      const res = await duplicate(database, OWNER);
      await expectErrorResponse(res, 423, 'Parent page "Page parent" is locked.');
    });

    it('rejects a destination parent in trash', async () => {
      const database = db({ pages: [pageRow('p1'), pageRow('p2', { inTrash: true })] });
      const res = await duplicate(database, OWNER, { parentId: 'p2', parentType: 'page' });
      await expectErrorResponse(res, 404, 'Destination parent was not found.');
    });

    it('rejects explicit workspace destinations that carry a parentId', async () => {
      const database = db({ pages: [pageRow('p1'), pageRow('p2')] });
      const res = await duplicate(database, OWNER, { parentId: 'p2', parentType: 'workspace' });
      await expectErrorResponse(res, 400, 'workspace duplicates should omit parentId.');
    });

    it('rejects duplicating a database into a database', async () => {
      const database = db({
        pages: [pageRow('p1', { kind: 'database' }), pageRow('target', { kind: 'database' })],
      });
      const res = await duplicate(database, OWNER, { parentId: 'target', parentType: 'database' });
      await expectErrorResponse(res, 400, 'Only regular pages can be duplicated into a database.');
    });

    it('rejects a database destination whose parent is a plain page', async () => {
      const database = db({ pages: [pageRow('p1'), pageRow('target')] });
      const res = await duplicate(database, OWNER, { parentId: 'target', parentType: 'database' });
      await expectErrorResponse(res, 400, 'Destination parent is not a database.');
    });

    it('rejects duplicating a page inside its own subtree', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('child', { parentId: 'p1', parentType: 'page' })],
      });
      const res = await duplicate(database, OWNER, { parentId: 'child', parentType: 'page' });
      await expectErrorResponse(res, 400, 'Cannot duplicate a page inside itself or one of its descendants.');
    });
  });

  describe('copy semantics', () => {
    it('copies the subtree with fresh ids, remapped block links, and sibling position', async () => {
      const database = db({
        pages: [
          pageRow('p1', { position: 1 }),
          pageRow('sibling', { position: 2 }),
          pageRow('child', { parentId: 'p1', parentType: 'page', position: 1 }),
        ],
        blocks: [
          { id: 'b1', pageId: 'p1', parentId: null, type: 'paragraph', plainText: 'root', position: 1 },
          { id: 'b2', pageId: 'p1', parentId: 'b1', type: 'paragraph', plainText: 'nested', position: 2 },
          {
            id: 'b3',
            pageId: 'p1',
            parentId: null,
            type: 'child_page',
            content: { childPageId: 'child' },
            position: 3,
          },
        ],
      });

      const res = (await duplicate(database, OWNER)) as {
        page: Row;
        pages: Row[];
        blocks: Row[];
        counts: Record<string, number>;
      };

      expect(res.page.title).toBe('Page p1 copy');
      expect(res.page.id).not.toBe('p1');
      // In-place copies land between the source and its next sibling.
      expect(res.page.position).toBe(1.5);
      expect(res.counts).toEqual({
        pages: 2,
        blocks: 3,
        properties: 0,
        views: 0,
        templates: 0,
        fileUploads: 0,
      });

      const copiedChild = res.pages.find((page) => page.id !== res.page.id);
      expect(copiedChild?.parentId).toBe(res.page.id);
      expect(copiedChild?.title).toBe('Page child');

      const byText = Object.fromEntries(res.blocks.map((block) => [block.plainText, block]));
      // Nested block parent links are remapped onto the new block ids.
      expect(byText.nested.parentId).toBe(byText.root.id);
      expect(byText.root.id).not.toBe('b1');
      // child_page block content points at the copied child page.
      const childPageBlock = res.blocks.find((block) => block.type === 'child_page');
      expect((childPageBlock?.content as Record<string, unknown>).childPageId).toBe(copiedChild?.id);
      // The source tree is untouched.
      expect(database.tables.pages.filter((page) => page.id === 'p1')).toHaveLength(1);
      expect(database.tables.blocks.filter((block) => block.pageId === 'p1')).toHaveLength(3);
    });

    it('honors a title override', async () => {
      const res = (await duplicate(db(), OWNER, { title: 'Renamed copy' })) as { page: Row };
      expect(res.page.title).toBe('Renamed copy');
    });

    it('persists a Korean duplicate title only when the product locale is explicit', async () => {
      const titled = (await duplicate(db(), OWNER, { locale: 'ko' })) as { page: Row };
      expect(titled.page.title).toBe('Page p1 사본');

      const untitledDatabase = db({ pages: [pageRow('p1', { title: '' })] });
      const untitled = (await duplicate(untitledDatabase, OWNER, { locale: 'ko' })) as { page: Row };
      expect(untitled.page.title).toBe('제목 없음 사본');
    });

    it('keeps omitted API/MCP locale in English and rejects unsupported locale values', async () => {
      const untitledDatabase = db({ pages: [pageRow('p1', { title: '' })] });
      const untitled = (await duplicate(untitledDatabase, OWNER)) as { page: Row };
      expect(untitled.page.title).toBe('Untitled copy');

      const invalid = await duplicate(db(), OWNER, { locale: 'ko-KR' });
      await expectErrorResponse(invalid, 400, 'locale must be "en" or "ko".');
    });

    it('copies database schema with remapped property ids and view configs', async () => {
      const database = db({
        pages: [
          pageRow('p1', { kind: 'database' }),
          pageRow('row1', {
            parentId: 'p1',
            parentType: 'database',
            properties: { prop1: 'todo', prop2: ['row1'] },
          }),
        ],
        db_properties: [
          { id: 'prop1', databaseId: 'p1', name: 'Status', type: 'select', position: 1 },
          {
            id: 'prop2',
            databaseId: 'p1',
            name: 'Self link',
            type: 'relation',
            config: { relationDatabaseId: 'p1' },
            position: 2,
          },
        ],
        db_views: [
          {
            id: 'view1',
            databaseId: 'p1',
            name: 'Board',
            type: 'board',
            config: { groupBy: 'prop1', visibleProperties: ['prop1', 'prop2'] },
            position: 1,
          },
        ],
        db_templates: [
          { id: 'tpl1', databaseId: 'p1', name: 'Task', title: 'New task', properties: { prop1: 'todo' }, position: 1 },
        ],
      });

      const res = (await duplicate(database, OWNER)) as {
        page: Row;
        pages: Row[];
        properties: Row[];
        views: Row[];
        templates: Row[];
        counts: Record<string, number>;
      };

      expect(res.counts).toEqual({
        pages: 2,
        blocks: 0,
        properties: 2,
        views: 1,
        templates: 1,
        fileUploads: 0,
      });
      const statusCopy = res.properties.find((property) => property.name === 'Status');
      const relationCopy = res.properties.find((property) => property.name === 'Self link');
      expect(statusCopy?.id).not.toBe('prop1');
      expect(statusCopy?.databaseId).toBe(res.page.id);
      // Self-referential relations retarget the copied database.
      expect((relationCopy?.config as Record<string, unknown>).relationDatabaseId).toBe(res.page.id);

      const viewConfig = res.views[0].config as Record<string, unknown>;
      expect(viewConfig.groupBy).toBe(statusCopy?.id);
      expect(viewConfig.visibleProperties).toEqual([statusCopy?.id, relationCopy?.id]);

      // Row property keys and relation values are remapped too.
      const rowCopy = res.pages.find((page) => page.parentType === 'database');
      const rowProperties = rowCopy?.properties as Record<string, unknown>;
      expect(rowProperties[statusCopy?.id as string]).toBe('todo');
      expect(rowProperties[relationCopy?.id as string]).toEqual([rowCopy?.id]);

      const templateCopy = res.templates[0];
      expect(templateCopy.databaseId).toBe(res.page.id);
      expect((templateCopy.properties as Record<string, unknown>)[statusCopy?.id as string]).toBe('todo');
    });

    it('copies every local page, block, row-property, and template file into an independent object and upload row', async () => {
      const coverKey = 'workspaces/ws1/covers/upload-cover-cover.bin';
      const iconKey = 'workspaces/ws1/icons/upload-icon-icon.bin';
      const blockKey = 'workspaces/ws1/blocks/files/upload-block-block.bin';
      const rowKey = 'workspaces/ws1/database/files/upload-row-row.bin';
      const templateKey = 'workspaces/ws1/blocks/files/upload-template-template.bin';
      const bodies = {
        [coverKey]: 'cover-bytes',
        [iconKey]: 'icon-bytes',
        [blockKey]: 'block-bytes',
        [rowKey]: 'row-bytes',
        [templateKey]: 'template-bytes',
      };
      const uploads = [
        uploadRow('upload-cover', coverKey, bodies[coverKey], { pageId: 'p1', scope: 'covers' }),
        uploadRow('upload-icon', iconKey, bodies[iconKey], { pageId: 'p1', scope: 'icons' }),
        uploadRow('upload-block', blockKey, bodies[blockKey], {
          pageId: 'p1',
          blockId: 'b1',
          scope: 'blocks/files',
        }),
        uploadRow('upload-row', rowKey, bodies[rowKey], {
          pageId: 'row1',
          databaseId: 'db1',
          propertyId: 'prop-files',
          scope: 'database/files',
        }),
        uploadRow('upload-template', templateKey, bodies[templateKey], {
          databaseId: 'db1',
          scope: 'blocks/files',
        }),
      ];
      const sourceKeys = uploads.map((upload) => upload.key as string);
      const sourceBytes = uploads.reduce((total, upload) => total + Number(upload.size), 0);
      const database = db({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Organization', ownerId: OWNER, storageLimitBytes: 1_000_000 }],
        pages: [
          pageRow('p1', {
            cover: uploads[0].url,
            icon: uploads[1].url,
            iconType: 'image',
          }),
          pageRow('db1', { parentId: 'p1', parentType: 'page', kind: 'database' }),
          pageRow('row1', {
            parentId: 'db1',
            parentType: 'database',
            properties: {
              'prop-files': [{
                id: rowKey,
                uploadId: 'upload-row',
                key: rowKey,
                bucket: 'files',
                url: uploads[3].url,
                name: 'row.bin',
              }],
            },
          }),
        ],
        blocks: [{
          id: 'b1',
          pageId: 'p1',
          parentId: null,
          type: 'file',
          content: {
            url: uploads[2].url,
            fileUploadId: 'upload-block',
            fileKey: blockKey,
            fileBucket: 'files',
            fileName: 'block.bin',
            caption: [{ text: blockKey }, { text: uploads[2].url }],
          },
          plainText: 'block.bin',
          position: 1,
        }],
        db_properties: [{
          id: 'prop-files',
          databaseId: 'db1',
          name: 'Files',
          type: 'files',
          position: 1,
        }],
        db_templates: [{
          id: 'template1',
          databaseId: 'db1',
          name: 'Template',
          icon: uploads[4].url,
          properties: {},
          blocks: [{
            type: 'file',
            content: {
              url: uploads[4].url,
              uploadId: 'upload-template',
              key: templateKey,
              name: 'template.bin',
            },
          }],
          position: 1,
        }],
        file_uploads: uploads,
      });
      const storage = trustedStorage(Object.fromEntries(uploads.map((upload) => [
        upload.key as string,
        {
          body: bodies[upload.key as keyof typeof bodies],
          contentType: upload.contentType as string,
          etag: upload.etag as string,
        },
      ])));

      const result = (await duplicate(database, OWNER, {}, storage)) as {
        page: Row;
        pages: Row[];
        blocks: Row[];
        properties: Row[];
        templates: Row[];
        fileUploads: Row[];
        counts: Record<string, number>;
      };

      expect(result.counts.fileUploads).toBe(5);
      expect(result.fileUploads).toHaveLength(5);
      expect(result.fileUploads.every((upload) => upload.status === 'uploaded' && upload.expiresAt === null)).toBe(true);
      expect(result.fileUploads.map((upload) => upload.key)).toEqual(
        result.fileUploads.map((_upload) => expect.stringContaining('/duplicate-page/')),
      );

      const copiedDatabase = result.pages.find((page) => page.kind === 'database');
      const copiedRow = result.pages.find((page) => page.parentType === 'database');
      const copiedBlock = result.blocks[0];
      const copiedProperty = result.properties[0];
      const byName = Object.fromEntries(result.fileUploads.map((upload) => [upload.name, upload]));
      expect(byName['upload-cover.bin']).toMatchObject({ pageId: result.page.id, databaseId: undefined });
      expect(byName['upload-icon.bin']).toMatchObject({ pageId: result.page.id });
      expect(byName['upload-block.bin']).toMatchObject({ pageId: result.page.id, blockId: copiedBlock.id });
      expect(byName['upload-row.bin']).toMatchObject({
        pageId: copiedRow?.id,
        databaseId: copiedDatabase?.id,
        propertyId: copiedProperty.id,
      });
      expect(byName['upload-template.bin']).toMatchObject({
        databaseId: copiedDatabase?.id,
        templateId: result.templates[0].id,
      });

      expect(result.page.cover).toBe(byName['upload-cover.bin'].url);
      expect(result.page.icon).toBe(byName['upload-icon.bin'].url);
      expect(copiedBlock.content).toMatchObject({
        url: byName['upload-block.bin'].url,
        fileUploadId: byName['upload-block.bin'].id,
        fileKey: byName['upload-block.bin'].key,
        caption: [{ text: blockKey }, { text: uploads[2].url }],
      });
      const copiedRowFiles = (copiedRow?.properties as Record<string, unknown>)[copiedProperty.id] as Row[];
      expect(copiedRowFiles[0]).toMatchObject({
        id: byName['upload-row.bin'].key,
        uploadId: byName['upload-row.bin'].id,
        key: byName['upload-row.bin'].key,
        url: byName['upload-row.bin'].url,
      });
      const copiedTemplateBlock = (result.templates[0].blocks as Row[])[0];
      expect(result.templates[0].icon).toBe(byName['upload-template.bin'].url);
      expect(copiedTemplateBlock.content).toMatchObject({
        url: byName['upload-template.bin'].url,
        uploadId: byName['upload-template.bin'].id,
        key: byName['upload-template.bin'].key,
      });

      for (const upload of result.fileUploads) {
        const copiedObject = storage.objects.get(upload.key as string);
        expect(copiedObject).toBeDefined();
        expect(new TextDecoder().decode(copiedObject?.body)).toBe(
          bodies[uploads.find((source) => source.name === upload.name)?.key as keyof typeof bodies],
        );
        expect(copiedObject?.customMetadata).toMatchObject({
          uploadId: upload.id,
          workspaceId: 'ws1',
          ...(upload.templateId ? { templateId: upload.templateId } : {}),
        });
      }

      // Removing every original byte leaves the duplicate's independently
      // owned bytes and metadata intact.
      for (const key of sourceKeys) await storage.delete(key);
      expect(result.fileUploads.every((upload) => storage.objects.has(upload.key as string))).toBe(true);
      expect(database.tables.file_uploads.filter((upload) =>
        result.fileUploads.some((copy) => copy.id === upload.id))).toHaveLength(5);

      const targetReservations = database.tables.organization_storage_reservations.filter((reservation) =>
        result.fileUploads.some((upload) => upload.id === reservation.id));
      expect(targetReservations).toHaveLength(5);
      expect(targetReservations.every((reservation) => reservation.status === 'active')).toBe(true);
      expect(database.tables.organization_storage_usage).toEqual([
        expect.objectContaining({ id: 'org1', reservedBytes: sourceBytes * 2 }),
      ]);
    });

    it('preserves literal storage paths and URLs in paragraph text, captions, and template prose', async () => {
      const blockKey = 'workspaces/ws1/blocks/files/literal-block.bin';
      const templateKey = 'workspaces/ws1/blocks/files/literal-template.bin';
      const blockUpload = uploadRow('upload-literal-block', blockKey, 'block', {
        pageId: 'p1',
        blockId: 'b1',
      });
      const templateUpload = uploadRow('upload-literal-template', templateKey, 'template', {
        databaseId: 'p1',
        templateId: 'template1',
      });
      const blockContent = {
        rich: [{ text: blockKey }, { text: blockUpload.url }],
        plainText: `${blockKey} ${blockUpload.url}`,
        caption: [{ text: blockUpload.url }],
      };
      const templateBlocks = [{
        type: 'paragraph',
        content: {
          rich: [{ text: templateKey }, { text: templateUpload.url }],
          caption: [{ text: templateKey }],
        },
      }];
      const database = db({
        pages: [pageRow('p1', { kind: 'database' })],
        blocks: [{
          id: 'b1',
          pageId: 'p1',
          parentId: null,
          type: 'paragraph',
          content: blockContent,
          plainText: `${blockKey} ${blockUpload.url}`,
          position: 1,
        }],
        db_templates: [{
          id: 'template1',
          databaseId: 'p1',
          name: 'Literal prose',
          properties: {},
          blocks: templateBlocks,
          position: 1,
        }],
        file_uploads: [blockUpload, templateUpload],
      });

      const result = (await duplicate(database, OWNER)) as {
        blocks: Row[];
        templates: Row[];
        fileUploads: Row[];
      };

      expect(result.fileUploads).toEqual([]);
      expect(result.blocks[0].content).toEqual(blockContent);
      expect(result.blocks[0].plainText).toBe(`${blockKey} ${blockUpload.url}`);
      expect(result.templates[0].blocks).toEqual(templateBlocks);
      expect(database.tables.file_uploads).toEqual([blockUpload, templateUpload]);
    });

    it('copies legacy raw string files values only for schema-declared row and template files properties', async () => {
      const rowFileKey = 'workspaces/ws1/database/row-legacy.bin';
      const rowLiteralKey = 'workspaces/ws1/database/row-prose.bin';
      const templateFileKey = 'workspaces/ws1/templates/template-legacy-a.bin';
      const templateRelativeKey = 'workspaces/ws1/templates/template-legacy-b.bin';
      const templateLiteralKey = 'workspaces/ws1/templates/template-prose.bin';
      const templateRelativeUrl = `/api/storage/files/${templateRelativeKey}`;
      const rowLiteralUrl = `/api/storage/files/${rowLiteralKey}`;
      const uploads = [
        uploadRow('upload-row-legacy', rowFileKey, 'row-file', {
          pageId: 'row1',
          databaseId: 'p1',
          propertyId: 'prop-files',
        }),
        uploadRow('upload-row-prose', rowLiteralKey, 'row-prose', {
          pageId: 'row1',
          databaseId: 'p1',
          propertyId: 'prop-notes',
        }),
        uploadRow('upload-template-legacy-a', templateFileKey, 'template-file-a', {
          databaseId: 'p1',
          templateId: 'template1',
        }),
        uploadRow('upload-template-legacy-b', templateRelativeKey, 'template-file-b', {
          databaseId: 'p1',
          templateId: 'template1',
        }),
        uploadRow('upload-template-prose', templateLiteralKey, 'template-prose', {
          databaseId: 'p1',
          templateId: 'template1',
        }),
      ];
      const database = db({
        pages: [
          pageRow('p1', { kind: 'database' }),
          pageRow('row1', {
            parentId: 'p1',
            parentType: 'database',
            properties: {
              'prop-files': rowFileKey,
              'prop-notes': rowLiteralUrl,
            },
          }),
        ],
        db_properties: [
          { id: 'prop-files', databaseId: 'p1', name: 'Files', type: 'files', position: 1 },
          { id: 'prop-notes', databaseId: 'p1', name: 'Notes', type: 'rich_text', position: 2 },
        ],
        db_templates: [{
          id: 'template1',
          databaseId: 'p1',
          name: 'Legacy files',
          properties: {
            'prop-files': [templateFileKey, templateRelativeUrl],
            'prop-notes': templateLiteralKey,
          },
          blocks: [],
          position: 1,
        }],
        file_uploads: uploads,
      });
      const storage = trustedStorage(Object.fromEntries(uploads.map((upload, index) => [
        upload.key as string,
        {
          body: ['row-file', 'row-prose', 'template-file-a', 'template-file-b', 'template-prose'][index],
          contentType: upload.contentType as string,
          etag: upload.etag as string,
        },
      ])));

      const result = (await duplicate(database, OWNER, {}, storage)) as {
        pages: Row[];
        properties: Row[];
        templates: Row[];
        fileUploads: Row[];
      };

      expect(result.fileUploads).toHaveLength(3);
      expect(result.fileUploads.map((upload) => upload.name).sort()).toEqual([
        'upload-row-legacy.bin',
        'upload-template-legacy-a.bin',
        'upload-template-legacy-b.bin',
      ]);
      const copiedFilesProp = result.properties.find((property) => property.name === 'Files')!;
      const copiedNotesProp = result.properties.find((property) => property.name === 'Notes')!;
      const copiedRow = result.pages.find((page) => page.parentType === 'database')!;
      const copiedTemplate = result.templates[0];
      const copiedByName = Object.fromEntries(result.fileUploads.map((upload) => [upload.name, upload]));
      expect((copiedRow.properties as Record<string, unknown>)[copiedFilesProp.id]).toBe(
        copiedByName['upload-row-legacy.bin'].url,
      );
      expect((copiedRow.properties as Record<string, unknown>)[copiedNotesProp.id]).toBe(rowLiteralUrl);
      expect((copiedTemplate.properties as Record<string, unknown>)[copiedFilesProp.id]).toEqual([
        copiedByName['upload-template-legacy-a.bin'].url,
        copiedByName['upload-template-legacy-b.bin'].url,
      ]);
      expect((copiedTemplate.properties as Record<string, unknown>)[copiedNotesProp.id]).toBe(
        templateLiteralKey,
      );
      expect(result.fileUploads.every((upload) =>
        String(upload.key).includes('/duplicate-page/') && storage.objects.has(upload.key as string))).toBe(true);
      expect(database.tables.file_uploads.filter((upload) =>
        upload.name === 'upload-row-prose.bin' || upload.name === 'upload-template-prose.bin')).toHaveLength(2);
    });

    it('reads workspace ownership from the central control plane in a real split fixture', async () => {
      const key = 'workspaces/ws1/covers/split.bin';
      const upload = uploadRow('upload-split', key, 'split-bytes', { pageId: 'p1', scope: 'covers' });
      const central = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
        workspace_members: [],
        page_workspace_index: [{ id: 'p1', workspaceId: 'ws1' }],
      });
      const content = fakeDb({
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });
      const storage = trustedStorage({
        [key]: {
          body: 'split-bytes',
          contentType: upload.contentType as string,
          etag: upload.etag as string,
        },
      });
      const body = { action: 'duplicate', pageId: 'p1' };
      const admin = {
        db(namespace: string, instanceId?: string) {
          if (namespace === 'app') return central;
          if (namespace === 'workspace' && instanceId === 'ws1') return content;
          throw new Error(`Unexpected database route: ${namespace}/${instanceId ?? ''}`);
        },
      };

      const result = await handlerOf(POST)({
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin,
        request: new Request('http://localhost:8787/functions/duplicate-page', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        storage,
      }) as { page: Row; fileUploads: Row[] };

      expect(result.page.workspaceId).toBe('ws1');
      expect(result.fileUploads).toHaveLength(1);
      expect(content.tables.workspaces ?? []).toEqual([]);
      expect(content.tables.pages.some((page) => page.id === result.page.id)).toBe(true);
      expect(content.tables.file_uploads.find((item) => item.id === result.fileUploads[0].id)).toMatchObject({
        pageId: result.page.id,
        status: 'uploaded',
      });
      expect(central.tables.page_workspace_index).toContainEqual({
        id: result.page.id,
        workspaceId: 'ws1',
      });
    });

    it('fails closed before writing when a local file reference has no upload owner', async () => {
      const untracked = 'workspaces/ws1/covers/untracked.bin';
      const database = db({
        pages: [pageRow('p1', {
          cover: `/api/storage/files/${untracked}`,
        })],
        file_uploads: [],
      });

      const response = await duplicate(database, OWNER);
      await expectErrorResponse(response, 409, 'untracked local file');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([]);
    });

    it.each([
      'https://evil.example/api/storage/files/workspaces/ws1/covers/source.bin',
      'http://localhost:8787/proxy/api/storage/files/workspaces/ws1/covers/source.bin',
    ])('does not substitute a private object for an external or nested storage-like URL: %s', async (url) => {
      const key = 'workspaces/ws1/covers/source.bin';
      const upload = uploadRow('upload-private', key, 'private', { pageId: 'p1' });
      const database = db({
        pages: [pageRow('p1', { cover: url })],
        file_uploads: [upload],
      });

      const result = (await duplicate(database, OWNER)) as { page: Row; fileUploads: Row[] };

      expect(result.page.cover).toBe(url);
      expect(result.fileUploads).toEqual([]);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('rejects an explicit upload id paired with a lookalike URL from another origin', async () => {
      const key = 'workspaces/ws1/covers/source.bin';
      const upload = uploadRow('upload-private', key, 'private', { pageId: 'p1' });
      const database = db({
        pages: [pageRow('p1', {
          properties: {
            file: {
              uploadId: upload.id,
              url: `https://evil.example/api/storage/files/${key}`,
            },
          },
        })],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);

      await expectErrorResponse(response, 409, 'non-matching key or URL');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('rejects an explicit upload id paired with another tracked file key', async () => {
      const firstKey = 'workspaces/ws1/uploads/first-owner.bin';
      const secondKey = 'workspaces/ws1/uploads/second-owner.bin';
      const first = uploadRow('upload-first-owner', firstKey, 'first', { pageId: 'p1' });
      const second = uploadRow('upload-second-owner', secondKey, 'second', { pageId: 'p1' });
      const database = db({
        pages: [pageRow('p1', {
          properties: {
            files: [{ uploadId: first.id, key: second.key, url: second.url }],
          },
        })],
        file_uploads: [first, second],
      });

      const response = await duplicate(database, OWNER);

      await expectErrorResponse(response, 409, 'id, key, or URL do not match');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([first, second]);
    });

    it('does not duplicate a reference backed by an incomplete upload grant', async () => {
      const key = 'workspaces/ws1/covers/pending.bin';
      const upload = uploadRow('upload-pending', key, 'pending', {
        pageId: 'p1',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const database = db({
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);
      await expectErrorResponse(response, 409, 'not complete');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('bounds synchronous file copying before any duplicate rows are created', async () => {
      const uploads = Array.from({ length: 101 }, (_, index) => {
        const key = `workspaces/ws1/uploads/file-${index}.bin`;
        return uploadRow(`upload-${index}`, key, 'x', { pageId: 'p1' });
      });
      const database = db({
        pages: [pageRow('p1', {
          properties: {
            files: uploads.map((upload) => ({
              uploadId: upload.id,
              key: upload.key,
              url: upload.url,
            })),
          },
        })],
        file_uploads: uploads,
      });

      const response = await duplicate(database, OWNER);
      await expectErrorResponse(response, 413, 'limited to 100 stored files');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.page_workspace_index.map((index) => index.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toHaveLength(101);
    });

    it('accepts the exact 100-file count boundary before requiring storage access', async () => {
      const uploads = Array.from({ length: 100 }, (_, index) => {
        const key = `workspaces/ws1/uploads/boundary-${index}.bin`;
        return uploadRow(`upload-boundary-${index}`, key, 'x', { pageId: 'p1' });
      });
      const database = db({
        pages: [pageRow('p1', {
          properties: {
            files: uploads.map((upload) => ({ uploadId: upload.id, url: upload.url })),
          },
        })],
        file_uploads: uploads,
      });

      const response = await duplicate(database, OWNER);

      await expectErrorResponse(response, 400, 'requires trusted storage access');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toHaveLength(100);
    });

    it('rejects more than 512 MiB of copied bytes before creating duplicate rows', async () => {
      const key = 'workspaces/ws1/uploads/too-large-total.bin';
      const upload = uploadRow('upload-too-large-total', key, 'x', {
        pageId: 'p1',
        size: 512 * 1024 * 1024 + 1,
      });
      const database = db({
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);

      await expectErrorResponse(response, 413, 'limited to 512 MiB');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.page_workspace_index.map((index) => index.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('accepts the exact 512 MiB byte boundary before requiring storage access', async () => {
      const key = 'workspaces/ws1/uploads/byte-boundary.bin';
      const upload = uploadRow('upload-byte-boundary', key, 'x', {
        pageId: 'p1',
        size: 512 * 1024 * 1024,
      });
      const database = db({
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);

      await expectErrorResponse(response, 400, 'requires trusted storage access');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('keeps the duplicated file readable after the original page is permanently deleted', async () => {
      const key = 'workspaces/ws1/covers/original.bin';
      const sourceUpload = uploadRow('upload-original', key, 'original-bytes', {
        pageId: 'p1',
        scope: 'covers',
      });
      const database = db({
        pages: [pageRow('p1', { cover: sourceUpload.url })],
        file_uploads: [sourceUpload],
      });
      const storage = trustedStorage({
        [key]: {
          body: 'original-bytes',
          contentType: sourceUpload.contentType as string,
          etag: sourceUpload.etag as string,
        },
      });
      const duplicated = (await duplicate(database, OWNER, {}, storage)) as {
        page: Row;
        fileUploads: Row[];
      };
      const copiedUpload = duplicated.fileUploads[0];
      expect(storage.objects.has(copiedUpload.key as string)).toBe(true);

      await database.table('pages').update('p1', { inTrash: true, trashedAt: new Date().toISOString() });
      const deleteBody = { action: 'delete', id: 'p1' };
      const deleted = await handlerOf(pageMutationPOST)({
        ...functionContext(database, OWNER, deleteBody),
        storage,
      });
      expect(deleted).not.toBeInstanceOf(Response);
      expect(database.tables.pages.some((page) => page.id === 'p1')).toBe(false);
      expect(database.tables.pages.some((page) => page.id === duplicated.page.id)).toBe(true);
      expect(storage.objects.has(key)).toBe(false);
      expect(storage.objects.has(copiedUpload.key as string)).toBe(true);
      expect(database.tables.file_uploads.find((upload) => upload.id === copiedUpload.id)).toMatchObject({
        status: 'uploaded',
        pageId: duplicated.page.id,
      });
    });

    it('does not copy a local file owned by a page outside the source subtree', async () => {
      const key = 'workspaces/ws1/covers/outside.bin';
      const upload = uploadRow('upload-outside', key, 'outside', { pageId: 'outside' });
      const database = db({
        pages: [
          pageRow('p1', { cover: upload.url }),
          pageRow('outside'),
        ],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);
      await expectErrorResponse(response, 409, 'outside the duplicated subtree');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1', 'outside']);
    });

    it('does not perpetuate a legacy upload shared by multiple content records', async () => {
      const key = 'workspaces/ws1/blocks/files/shared.bin';
      const upload = uploadRow('upload-shared', key, 'shared', {
        pageId: 'p1',
        blockId: 'block-a',
      });
      const fileContent = { uploadId: upload.id, key, url: upload.url };
      const database = db({
        pages: [pageRow('p1')],
        blocks: [
          { id: 'block-a', pageId: 'p1', parentId: null, type: 'file', content: fileContent, position: 1 },
          { id: 'block-b', pageId: 'p1', parentId: null, type: 'file', content: fileContent, position: 2 },
        ],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);

      await expectErrorResponse(response, 409, 'shared by multiple content records');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('rejects a template reference whose upload metadata names another template', async () => {
      const key = 'workspaces/ws1/blocks/files/template-owner.bin';
      const upload = uploadRow('upload-template-owner', key, 'template', {
        databaseId: 'p1',
        templateId: 'template-b',
      });
      const database = db({
        pages: [pageRow('p1', { kind: 'database' })],
        db_templates: [
          {
            id: 'template-a',
            databaseId: 'p1',
            name: 'A',
            blocks: [{ type: 'file', content: { uploadId: upload.id, key, url: upload.url } }],
            position: 1,
          },
          { id: 'template-b', databaseId: 'p1', name: 'B', blocks: [], position: 2 },
        ],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);

      await expectErrorResponse(response, 409, 'different template owner');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('rejects source-object replacement when the stored ETag no longer matches metadata', async () => {
      const key = 'workspaces/ws1/covers/replaced.bin';
      const upload = uploadRow('upload-replaced', key, 'source', { pageId: 'p1' });
      const database = db({
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });
      const storage = trustedStorage({
        [key]: { body: 'source', etag: 'different-object-version' },
      });

      const response = await duplicate(database, OWNER, {}, storage);
      await expectErrorResponse(response, 409, 'failed its integrity check');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.page_workspace_index.map((index) => index.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
      expect(Array.from(storage.objects.keys())).toEqual([key]);
    });

    it('rolls back a same-length target object that is not byte-equivalent to its source', async () => {
      const key = 'workspaces/ws1/covers/source-integrity.bin';
      const upload = uploadRow('upload-integrity', key, 'source-bytes', { pageId: 'p1' });
      const database = db({
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });
      const storage = trustedStorage({
        [key]: { body: 'source-bytes', etag: upload.etag as string },
      }, { corruptTargetPutAt: 1 });

      const response = await duplicate(database, OWNER, {}, storage);

      await expectErrorResponse(response, 500, 'Internal server error.');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
      expect(Array.from(storage.objects.keys())).toEqual([key]);
    });

    it('rolls back copied objects, metadata, quota, and page rows when a later file copy fails', async () => {
      const firstKey = 'workspaces/ws1/covers/first.bin';
      const secondKey = 'workspaces/ws1/icons/second.bin';
      const first = uploadRow('upload-first', firstKey, 'first', { pageId: 'p1', scope: 'covers' });
      const second = uploadRow('upload-second', secondKey, 'second', { pageId: 'p1', scope: 'icons' });
      const database = db({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Organization', ownerId: OWNER, storageLimitBytes: 1000 }],
        pages: [pageRow('p1', { cover: first.url, icon: second.url, iconType: 'image' })],
        file_uploads: [first, second],
      });
      const storage = trustedStorage({
        [firstKey]: { body: 'first', etag: first.etag as string },
        [secondKey]: { body: 'second', etag: second.etag as string },
      }, { failTargetPutAt: 2 });

      const response = await duplicate(database, OWNER, {}, storage);
      await expectErrorResponse(response, 500, 'Internal server error.');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.page_workspace_index.map((index) => index.id)).toEqual(['p1']);
      expect(database.tables.file_uploads.map((upload) => upload.id)).toEqual(['upload-first', 'upload-second']);
      expect(Array.from(storage.objects.keys()).sort()).toEqual([firstKey, secondKey].sort());
      const rollbackReservations = database.tables.organization_storage_reservations.filter((reservation) =>
        reservation.id !== 'upload-first' && reservation.id !== 'upload-second');
      expect(rollbackReservations).toHaveLength(2);
      expect(rollbackReservations.every((reservation) => reservation.status === 'released')).toBe(true);
      expect(database.tables.organization_storage_usage).toEqual([
        expect.objectContaining({ id: 'org1', reservedBytes: 11 }),
      ]);
    });

    it('rolls back page rows without sharing the source key when trusted storage is unavailable', async () => {
      const key = 'workspaces/ws1/covers/source.bin';
      const upload = uploadRow('upload-source', key, 'source', { pageId: 'p1' });
      const database = db({
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });

      const response = await duplicate(database, OWNER);
      await expectErrorResponse(response, 400, 'requires trusted storage access');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.page_workspace_index.map((index) => index.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
    });

    it('fails closed and rolls back when the independent copy would exceed organization quota', async () => {
      const key = 'workspaces/ws1/covers/quota.bin';
      const upload = uploadRow('upload-quota', key, 'source', { pageId: 'p1' });
      const database = db({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{
          id: 'org1',
          name: 'Organization',
          ownerId: OWNER,
          storageLimitBytes: upload.size,
        }],
        pages: [pageRow('p1', { cover: upload.url })],
        file_uploads: [upload],
      });
      const storage = trustedStorage({
        [key]: { body: 'source', etag: upload.etag as string },
      });

      const response = await duplicate(database, OWNER, {}, storage);
      await expectErrorResponse(response, 403, 'storage limit exceeded');
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.page_workspace_index.map((index) => index.id)).toEqual(['p1']);
      expect(database.tables.file_uploads).toEqual([upload]);
      expect(Array.from(storage.objects.keys())).toEqual([key]);
      expect(database.tables.organization_storage_reservations ?? []).toEqual([]);
    });

    it('appends to the end when relocating to a different destination', async () => {
      const database = db({
        pages: [
          pageRow('p1', { position: 1 }),
          pageRow('target', { position: 2 }),
          pageRow('existing-child', { parentId: 'target', parentType: 'page', position: 7 }),
        ],
      });
      const res = (await duplicate(database, OWNER, { parentId: 'target', parentType: 'page' })) as {
        page: Row;
      };
      expect(res.page.parentId).toBe('target');
      expect(res.page.parentType).toBe('page');
      expect(res.page.position).toBe(8);
    });

    it('rolls back created rows when a later insert fails', async () => {
      const database = db({
        pages: [pageRow('p1', { kind: 'database' })],
        db_properties: [{ id: 'prop1', databaseId: 'p1', name: 'Status', type: 'select', position: 1 }],
        db_views: [
          { id: 'view1', databaseId: 'p1', name: 'Table', type: 'table', config: {}, position: 1 },
        ],
      });
      const originalTable = database.table.bind(database);
      database.table = ((name: string) => {
        const ref = originalTable(name);
        if (name !== 'db_views') return ref;
        return {
          ...ref,
          insert: async () => {
            throw new Error('Simulated storage failure.');
          },
        };
      }) as typeof database.table;

      const res = await duplicate(database, OWNER);
      await expectErrorResponse(res, 500, 'Internal server error.');
      // Everything created before the failure was rolled back.
      expect(database.tables.pages.map((page) => page.id)).toEqual(['p1']);
      expect(database.tables.db_properties.map((property) => property.id)).toEqual(['prop1']);
      expect(database.tables.db_views.map((view) => view.id)).toEqual(['view1']);
    });
  });
});
