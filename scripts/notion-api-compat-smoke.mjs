import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const backendDir = join(repoRoot, 'backend');
const outputDir = join(backendDir, '.edgebase', `tmp-notion-api-compat-smoke-${process.pid}`);

class Query {
  constructor(items) {
    this.items = items;
    this.pageNumber = 1;
    this.pageLimit = 50;
  }

  page(n) {
    this.pageNumber = n;
    return this;
  }

  limit(n) {
    this.pageLimit = n;
    return this;
  }

  async getList() {
    const start = (this.pageNumber - 1) * this.pageLimit;
    const items = this.items.slice(start, start + this.pageLimit);
    return { items, hasMore: start + this.pageLimit < this.items.length };
  }
}

class Table {
  constructor(rows) {
    this.rows = rows;
  }

  page(n) {
    return new Query(Array.from(this.rows.values())).page(n);
  }

  limit(n) {
    return new Query(Array.from(this.rows.values())).limit(n);
  }

  async getList() {
    return new Query(Array.from(this.rows.values())).getList();
  }

  async getOne(id) {
    const row = this.rows.get(id);
    // Match the EdgeBase not-found shape that isNotFoundError duck-types.
    if (!row) throw Object.assign(new Error(`Record '${id}' not found`), { code: 404 });
    return row;
  }

  async insert(data) {
    const row = { ...data, id: data.id || crypto.randomUUID() };
    this.rows.set(row.id, row);
    return row;
  }

  async update(id, data) {
    const row = { ...(await this.getOne(id)), ...data };
    this.rows.set(id, row);
    return row;
  }

  async delete(id) {
    this.rows.delete(id);
  }

  where(field, op, value) {
    if (op !== '==') throw new Error(`Unsupported smoke query operator: ${op}`);
    return new Query(Array.from(this.rows.values()).filter((row) => row[field] === value));
  }
}

function createTableDb(initial = {}) {
  const store = Object.fromEntries(
    Object.entries(initial).map(([name, rows]) => [name, new Map(rows)]),
  );
  return {
    table(name) {
      if (!store[name]) store[name] = new Map();
      return new Table(store[name]);
    },
  };
}

function createSmokeAdmin() {
  const app = createTableDb({
    workspaces: [['ws1', { id: 'ws1', ownerId: 'user-1' }]],
    workspace_members: [],
    page_workspace_index: [
      ['db1', { id: 'db1', workspaceId: 'ws1' }],
      ['row1', { id: 'row1', workspaceId: 'ws1' }],
    ],
    page_permission_index: [],
    share_link_index: [],
    organization_members: [],
    organization_group_members: [],
  });
  const now = '2026-01-01T00:00:00.000Z';
  const workspaces = new Map([['ws1', createTableDb({
    pages: [
      ['db1', {
        id: 'db1', workspaceId: 'ws1', parentId: null, parentType: 'workspace', kind: 'database',
        title: 'Tasks', position: 0, inTrash: false, createdBy: 'user-1', lastEditedBy: 'user-1',
        createdAt: now, updatedAt: now,
      }],
      ['row1', {
        id: 'row1', workspaceId: 'ws1', parentId: 'db1', parentType: 'database', kind: 'page',
        title: 'First task', properties: { title1: 'First task', status1: 'Todo' }, position: 0,
        inTrash: false, createdBy: 'user-1', lastEditedBy: 'user-1', createdAt: now, updatedAt: now,
      }],
    ],
    db_properties: [
      ['title1', { id: 'title1', databaseId: 'db1', name: 'Name', type: 'title', position: 0 }],
      ['status1', {
        id: 'status1', databaseId: 'db1', name: 'Status', type: 'status', position: 1,
        config: { options: [{ id: 'todo', name: 'Todo', color: 'gray' }] },
      }],
    ],
    db_views: [],
    db_templates: [],
    blocks: [[
      'block1',
      {
        id: 'block1', pageId: 'row1', parentId: null, type: 'paragraph',
        content: { rich: [{ text: 'Hello block' }] }, plainText: 'Hello block', position: 0,
        createdBy: 'user-1', createdAt: now, updatedAt: now,
      },
    ]],
    comments: [],
    file_uploads: [],
    page_permissions: [],
  })]]);
  return {
    db(namespace, instanceId) {
      if (namespace === 'app') return app;
      if (namespace === 'workspace') {
        const key = instanceId || 'default';
        if (!workspaces.has(key)) {
          workspaces.set(key, createTableDb({
            pages: [],
            db_properties: [],
            db_views: [],
            db_templates: [],
            blocks: [],
            comments: [],
            file_uploads: [],
            page_permissions: [],
          }));
        }
        return workspaces.get(key);
      }
      throw new Error(`Unexpected smoke db namespace: ${namespace}`);
    },
  };
}

async function callRaw(mod, admin, method, slug, body, auth = { id: 'user-1', email: 'a@example.com' }) {
  const definition = mod[method];
  if (!definition?.handler) throw new Error(`Missing ${method} handler`);
  const routeSlug = slug.split('?')[0];
  const response = await definition.handler({
    auth,
    request: new Request(`http://local/api/functions/v1/${slug}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { 'content-type': 'application/json' } : undefined,
    }),
    params: { slug: routeSlug },
    admin,
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function call(mod, admin, method, slug, body, auth) {
  const { status, data } = await callRaw(mod, admin, method, slug, body, auth);
  if (status >= 300) {
    throw new Error(`${method} /v1/${slug} failed: ${status} ${JSON.stringify(data)}`);
  }
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  if (existsSync(outputDir)) await rm(outputDir, { recursive: true, force: true });
  const build = spawnSync(
    'npm',
    ['exec', 'edgebase', 'build-app', '--', '--output', outputDir],
    { cwd: backendDir, encoding: 'utf8' },
  );
  if (build.status !== 0) {
    process.stderr.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    throw new Error('EdgeBase app build failed for Notion API compatibility smoke.');
  }

  const modulePath = join(
    outputDir,
    '.edgebase',
    'runtime',
    'server',
    'bundle',
    'functions',
    'v1',
    '[...slug].js',
  );
  const mod = await import(pathToFileURL(modulePath).href);
  const admin = createSmokeAdmin();
  const workspaceDb = admin.db('workspace', 'ws1');

  const me = await call(mod, admin, 'GET', 'users/me');
  assert(me.object === 'user' && me.id === 'user-1', 'users/me did not return a Notion user.');
  const retrievedUser = await call(mod, admin, 'GET', 'users/user-1');
  assert(retrievedUser.object === 'user' && retrievedUser.id === 'user-1', 'users/{id} did not return a Notion user.');
  const emojis = await call(mod, admin, 'GET', 'custom_emojis');
  assert(emojis.object === 'list' && emojis.type === 'custom_emoji', 'custom emoji list shape mismatch.');

  const database = await call(mod, admin, 'GET', 'databases/db1');
  assert(database.object === 'database' && database.id === 'db1', 'database retrieve shape mismatch.');
  const dataSource = await call(mod, admin, 'GET', 'data_sources/db1');
  assert(dataSource.object === 'data_source' && dataSource.id === 'db1', 'data source retrieve shape mismatch.');

  const databaseList = await call(mod, admin, 'GET', 'databases?workspace_id=ws1');
  assert(databaseList.results.length >= 1, 'database list did not include created database.');
  const dataSourceList = await call(mod, admin, 'GET', `data_sources?database_id=${database.id}`);
  assert(dataSourceList.results.some((item) => item.id === database.id), 'data source list did not include base data source.');
  const calendarView = await call(mod, admin, 'POST', `data_sources/${database.id}/views`, {
    name: 'Calendar',
    type: 'calendar',
  });
  assert(calendarView.object === 'view' && calendarView.type === 'calendar', 'supported view type create failed.');
  const fetchedView = await call(mod, admin, 'GET', `views/${calendarView.id}?workspace_id=ws1`);
  assert(fetchedView.id === calendarView.id, 'view retrieve did not route through workspace_id.');
  const patchedView = await call(mod, admin, 'PATCH', `views/${calendarView.id}?workspace_id=ws1`, {
    name: 'Calendar updated',
  });
  assert(patchedView.name === 'Calendar updated', 'view patch did not route through workspace_id.');
  const deletedView = await call(mod, admin, 'DELETE', `views/${calendarView.id}?workspace_id=ws1`);
  assert(deletedView.deleted === true, 'view delete did not route through workspace_id.');
  const unsupportedView = await callRaw(mod, admin, 'POST', `data_sources/${database.id}/views`, {
    name: 'Form',
    type: 'form',
  });
  assert(
    unsupportedView.status === 400 && unsupportedView.data.message.includes('does not support the Notion form view type'),
    'unsupported official view type should return a clear validation error.',
  );
  const invalidView = await callRaw(mod, admin, 'POST', `data_sources/${database.id}/views`, {
    name: 'Nope',
    type: 'spaceship',
  });
  assert(invalidView.status === 400 && invalidView.data.message.includes('Unsupported view type'), 'invalid view type should fail.');

  const row = await call(mod, admin, 'GET', 'pages/row1');
  assert(row.object === 'page' && row.properties.Name.title[0].plain_text === 'First task', 'page retrieve shape mismatch.');
  const titleProperty = await call(mod, admin, 'GET', `pages/${row.id}/properties/Name`);
  assert(titleProperty.object === 'list' && titleProperty.type === 'property_item', 'page property item list shape mismatch.');

  const queried = await call(mod, admin, 'POST', `data_sources/${database.id}/query`, {
    filter: { property: 'Status', status: { equals: 'Todo' } },
  });
  assert(queried.object === 'list' && queried.results.length === 1, 'data source query did not return the inserted row.');
  const children = await call(mod, admin, 'GET', `blocks/${row.id}/children`);
  assert(children.results?.[0]?.paragraph?.rich_text?.[0]?.plain_text === 'Hello block', 'block children round trip failed.');

  // DO-2 regression: a real nested block id is NOT in page_workspace_index, so
  // /v1/blocks/* endpoints must route on the workspace hint, not the block id.
  // Before the fix these 404'd ("Page was not found") even with workspace_id.
  const nestedBlockId = children.results[0].id;
  assert(
    typeof nestedBlockId === 'string' && nestedBlockId !== row.id,
    'expected a real nested block id distinct from the page id.',
  );
  const nestedChildren = await call(mod, admin, 'GET', `blocks/${nestedBlockId}/children?workspace_id=ws1`);
  assert(nestedChildren.object === 'list', 'nested block children did not route through workspace_id.');
  const contentMutationProbes = [
    await callRaw(mod, admin, 'POST', 'pages', {
      parent: { data_source_id: database.id },
      properties: { Name: { title: [{ type: 'text', text: { content: 'Blocked' } }] } },
    }),
    await callRaw(mod, admin, 'PATCH', `pages/${row.id}`, { erase_content: true }),
    await callRaw(mod, admin, 'PATCH', `blocks/${row.id}/children`, {
      children: [{ type: 'paragraph', paragraph: { rich_text: [] } }],
    }),
    await callRaw(mod, admin, 'PATCH', `blocks/${nestedBlockId}?workspace_id=ws1`, {
      type: 'paragraph',
      paragraph: { rich_text: [] },
    }),
    await callRaw(mod, admin, 'DELETE', `blocks/${nestedBlockId}?workspace_id=ws1`),
    await callRaw(mod, admin, 'POST', 'databases', {
      parent: { workspace_id: 'ws1' },
      title: [{ type: 'text', text: { content: 'Blocked' } }],
    }),
    await callRaw(mod, admin, 'PATCH', `databases/${database.id}`, { title: [] }),
    await callRaw(mod, admin, 'POST', 'data_sources', {
      parent: { database_id: database.id },
      title: [{ type: 'text', text: { content: 'Blocked' } }],
    }),
    await callRaw(mod, admin, 'PATCH', `data_sources/${database.id}`, { properties: { Status: null } }),
    await callRaw(mod, admin, 'DELETE', `data_sources/${database.id}`),
  ];
  for (const probe of contentMutationProbes) {
    assert(probe.status === 501, 'Notion-compatible primary-content mutations must return 501.');
    assert(
      probe.data?.message?.includes('not available'),
      'Notion-compatible content mutation denial must explain the unavailable surface.',
    );
  }
  const childrenAfterDeniedMutations = await call(mod, admin, 'GET', `blocks/${row.id}/children`);
  assert(
    childrenAfterDeniedMutations.results.length === 1,
    'denied primary-content mutations must not change stored blocks.',
  );

  const comment = await call(mod, admin, 'POST', 'comments', {
    parent: { page_id: row.id },
    rich_text: [{ type: 'text', text: { content: 'Looks good' } }],
  });
  const patchedComment = await call(mod, admin, 'PATCH', `comments/${comment.id}`, {
    workspace_id: 'ws1',
    resolved: true,
    rich_text: [{ type: 'text', text: { content: 'Resolved' } }],
  });
  assert(patchedComment.resolved === true, 'comment patch did not update resolved state.');
  const deletedComment = await call(mod, admin, 'DELETE', `comments/${comment.id}?workspace_id=ws1`);
  assert(deletedComment.deleted === true, 'comment delete shape mismatch.');
  const commentsAfterDelete = await call(mod, admin, 'GET', `comments?page_id=${row.id}`);
  assert(
    !commentsAfterDelete.results.some((item) => item.id === comment.id),
    'comment delete returned success but did not remove the comment.',
  );

  // The legacy facade used to report success while changing only metadata —
  // no bytes, quota, integrity validation, or object deletion. Mutations stay
  // fail-closed until the compatibility API has a storage-backed lifecycle.
  for (const probe of [
    await callRaw(mod, admin, 'POST', 'file_uploads', {
      workspace_id: 'ws1',
      filename: 'document.pdf',
      content_type: 'application/pdf',
      content_length: 12,
    }),
    await callRaw(mod, admin, 'POST', 'file_uploads/blocked/send?workspace_id=ws1'),
    await callRaw(mod, admin, 'POST', 'file_uploads/blocked/complete?workspace_id=ws1'),
    await callRaw(mod, admin, 'DELETE', 'file_uploads/blocked?workspace_id=ws1'),
  ]) {
    assert(probe.status === 501, 'Notion-compatible file mutations must return 501.');
    assert(
      probe.data?.message?.includes('not available'),
      'Notion-compatible file mutation denial must explain the unavailable surface.',
    );
  }
  const listedUploads = await call(mod, admin, 'GET', 'file_uploads?workspace_id=ws1');
  assert(listedUploads.object === 'list', 'read-only file upload listing shape mismatch.');

  console.log('Notion API compatibility smoke ok');
}

try {
  await run();
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
