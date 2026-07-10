import { describe, expect, it } from 'vitest';

import {
  DELETE,
  GET,
  PATCH,
  POST,
} from '../../functions/notion/v1/[...slug]';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const USER = 'user-1';

function page(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: id,
    position: 0,
    inTrash: false,
    createdBy: USER,
    ...extra,
  };
}

function splitAdmin() {
  const central = fakeDb({
    workspaces: [
      { id: 'ws1', name: 'Owned', ownerId: USER },
      { id: 'ws-private', name: 'Private', ownerId: 'other-user' },
    ],
    workspace_members: [],
    page_workspace_index: [
      { id: 'page1', workspaceId: 'ws1' },
      { id: 'db1', workspaceId: 'ws1' },
      { id: 'private-page', workspaceId: 'ws-private' },
    ],
    page_permission_index: [],
    share_link_index: [],
    organization_members: [],
    organization_group_members: [],
  });
  const ws1 = fakeDb({
    pages: [
      page('page1', { title: 'Official shape page' }),
      page('db1', { kind: 'database', title: 'Tasks', position: 1 }),
      page('db-row1', {
        parentId: 'db1',
        parentType: 'database',
        title: 'Task row',
        position: 0,
        properties: { title1: 'Task row', status1: 'Open' },
      }),
    ],
    blocks: [{
      id: 'block1',
      pageId: 'page1',
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: 'Hello block' }] },
      plainText: 'Hello block',
      position: 0,
      createdBy: USER,
    }],
    db_properties: [
      { id: 'title1', databaseId: 'db1', name: 'Name', type: 'title', position: 0 },
      { id: 'status1', databaseId: 'db1', name: 'Status', type: 'select', position: 1 },
    ],
    db_views: [
      { id: 'view1', databaseId: 'db1', name: 'Table', type: 'table', config: {}, position: 0 },
      { id: 'view-delete', databaseId: 'db1', name: 'Delete me', type: 'table', config: {}, position: 1 },
    ],
    comments: [{
      id: 'comment1',
      pageId: 'page1',
      blockId: 'block1',
      parentId: null,
      authorId: USER,
      body: { rich: [{ text: 'Block comment' }] },
      resolved: false,
    }],
    page_permissions: [],
    db_templates: [],
    file_uploads: [{
      id: 'upload1',
      workspaceId: 'ws1',
      pageId: 'page1',
      key: 'workspaces/ws1/uploads/upload1-file.txt',
      name: 'file.txt',
      contentType: 'text/plain',
      size: 4,
      status: 'pending',
      numberOfPartsTotal: 1,
      numberOfPartsSent: 0,
      createdBy: USER,
    }],
    change_log: [],
  });
  const privateDb = fakeDb({
    pages: [page('private-page', { workspaceId: 'ws-private', title: 'Do not leak' })],
    blocks: [],
    db_properties: [],
    db_views: [],
    comments: [],
    page_permissions: [],
  });
  const admin = {
    db(namespace: string, instanceId?: string): FakeDb {
      if (namespace === 'app') return central;
      if (namespace === 'workspace' && instanceId === 'ws1') return ws1;
      if (namespace === 'workspace' && instanceId === 'ws-private') return privateDb;
      throw new Error(`Unexpected database route: ${namespace}/${instanceId ?? ''}`);
    },
  };
  return { admin, central, ws1, privateDb };
}

async function callRaw(
  definition: unknown,
  admin: ReturnType<typeof splitAdmin>['admin'],
  method: string,
  slug: string,
  body?: Record<string, unknown>,
) {
  const routeSlug = slug.split('?')[0];
  const response = await handlerOf(definition)({
    auth: { id: USER, email: 'user@example.com' },
    admin,
    params: { slug: routeSlug },
    request: new Request(`http://localhost/api/functions/v1/${slug}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  });
  expect(response).toBeInstanceOf(Response);
  const res = response as Response;
  const payload = await res.json();
  return { status: res.status, payload: payload as Record<string, unknown> };
}

async function call(
  definition: unknown,
  admin: ReturnType<typeof splitAdmin>['admin'],
  method: string,
  slug: string,
  body?: Record<string, unknown>,
) {
  const { status, payload } = await callRaw(definition, admin, method, slug, body);
  if (status >= 400) throw new Error(`${method} ${slug}: ${status} ${JSON.stringify(payload)}`);
  return payload;
}

describe('Notion-compatible official-shape routing', () => {
  it('fans global search/database/data-source lists across only accessible workspace blocks', async () => {
    const { admin } = splitAdmin();
    const search = await call(POST, admin, 'POST', 'search', { query: 'Official' });
    expect((search.results as Array<{ id: string }>).map((item) => item.id)).toContain('page1');
    expect(JSON.stringify(search)).not.toContain('private-page');

    const databases = await call(GET, admin, 'GET', 'databases');
    expect((databases.results as Array<{ id: string }>).map((item) => item.id)).toContain('db1');

    const dataSources = await call(GET, admin, 'GET', 'data_sources');
    expect((dataSources.results as Array<{ id: string }>).map((item) => item.id)).toContain('db1');
  });

  it('retrieves, updates, and deletes view ids without proprietary workspace_id hints', async () => {
    const { admin, ws1 } = splitAdmin();
    const view = await call(GET, admin, 'GET', 'views/view1');
    expect(view.id).toBe('view1');

    const updated = await call(PATCH, admin, 'PATCH', 'views/view1', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');

    const deleted = await call(DELETE, admin, 'DELETE', 'views/view-delete');
    expect(deleted.deleted).toBe(true);
    expect(ws1.tables.db_views.some((candidate) => candidate.id === 'view-delete')).toBe(false);
  });

  it('routes raw block ids and block-only comment lists without page/workspace hints', async () => {
    const { admin } = splitAdmin();
    const block = await call(GET, admin, 'GET', 'blocks/block1');
    expect(block.id).toBe('block1');

    const comments = await call(GET, admin, 'GET', 'comments?block_id=block1');
    expect((comments.results as Array<{ id: string }>).map((comment) => comment.id)).toEqual(['comment1']);

    const comment = await call(GET, admin, 'GET', 'comments/comment1');
    expect(comment.id).toBe('comment1');

    const uploads = await call(GET, admin, 'GET', 'file_uploads');
    expect((uploads.results as Array<{ id: string }>).map((upload) => upload.id)).toEqual(['upload1']);
    const upload = await call(GET, admin, 'GET', 'file_uploads/upload1');
    expect(upload.id).toBe('upload1');
  });

  it('prevalidates an append block batch before writing any child', async () => {
    const { admin, ws1 } = splitAdmin();
    const { status, payload } = await callRaw(PATCH, admin, 'PATCH', 'blocks/page1/children', {
      children: [
        { id: 'duplicate', type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'First' } }] } },
        { id: 'duplicate', type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'Second' } }] } },
      ],
    });
    expect(status).toBe(400);
    expect(String(payload.message)).toContain('duplicated or already exists');
    expect(ws1.tables.blocks.map((block) => block.id)).toEqual(['block1']);

    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      id: `bulk-${index}`,
      type: 'paragraph',
      paragraph: { rich_text: [] },
    }));
    const bounded = await callRaw(PATCH, admin, 'PATCH', 'blocks/page1/children', { children: tooMany });
    expect(bounded.status).toBe(400);
    expect(String(bounded.payload.message)).toContain('at most 100 blocks per level');
    expect(ws1.tables.blocks.map((block) => block.id)).toEqual(['block1']);
  });

  it('rolls back row cleanup when a schema property delete fails', async () => {
    const { admin, ws1 } = splitAdmin();
    const transact = ws1.transact.bind(ws1);
    ws1.transact = async (operations) => {
      if (operations.some((operation) => (
        operation.table === 'db_properties'
        && operation.op === 'delete'
        && operation.id === 'status1'
      ))) {
        throw Object.assign(new Error('simulated schema storage failure'), { code: 500 });
      }
      return transact(operations);
    };

    const { status, payload } = await callRaw(PATCH, admin, 'PATCH', 'databases/db1', {
      properties: { Status: null },
    });

    expect(status).toBe(500);
    expect(payload.message).toBe('Internal server error.');
    expect(ws1.tables.db_properties.some((property) => property.id === 'status1')).toBe(true);
    expect(ws1.tables.pages.find((candidate) => candidate.id === 'db-row1')?.properties).toEqual({
      title1: 'Task row',
      status1: 'Open',
    });
  });
});
