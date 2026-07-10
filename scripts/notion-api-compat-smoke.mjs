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
    page_workspace_index: [],
    page_permission_index: [],
    share_link_index: [],
    organization_members: [],
    organization_group_members: [],
  });
  const workspaces = new Map();
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

  const database = await call(mod, admin, 'POST', 'databases', {
    parent: { workspace_id: 'ws1' },
    title: [{ type: 'text', text: { content: 'Tasks' } }],
    initial_data_source: {
      properties: {
        Name: { title: {} },
        Status: { status: { options: [{ name: 'Todo', color: 'gray' }] } },
      },
    },
  });
  assert(database.object === 'database' && database.data_sources?.[0]?.id === database.id, 'database create shape mismatch.');

  const extraDataSource = await call(mod, admin, 'POST', 'data_sources', {
    parent: { database_id: database.id },
    title: [{ type: 'text', text: { content: 'Archive' } }],
    properties: {
      Name: { title: {} },
      Done: { checkbox: {} },
    },
  });
  assert(extraDataSource.object === 'data_source' && extraDataSource.parent.database_id === database.id, 'data source create shape mismatch.');

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

  const row = await call(mod, admin, 'POST', 'pages', {
    parent: { data_source_id: database.id },
    properties: {
      Name: { title: [{ type: 'text', text: { content: 'First task' } }] },
      Status: { status: { name: 'Todo' } },
    },
  });
  assert(row.object === 'page' && row.properties.Name.title[0].plain_text === 'First task', 'page create shape mismatch.');
  const titleProperty = await call(mod, admin, 'GET', `pages/${row.id}/properties/Name`);
  assert(titleProperty.object === 'list' && titleProperty.type === 'property_item', 'page property item list shape mismatch.');

  const queried = await call(mod, admin, 'POST', `data_sources/${database.id}/query`, {
    filter: { property: 'Status', status: { equals: 'Todo' } },
  });
  assert(queried.object === 'list' && queried.results.length === 1, 'data source query did not return the inserted row.');
  const patchedDataSource = await call(mod, admin, 'PATCH', `data_sources/${database.id}`, {
    properties: { Status: { name: 'State' } },
  });
  assert(patchedDataSource.object === 'data_source' && patchedDataSource.properties.State, 'data source patch did not rename property.');

  await call(mod, admin, 'PATCH', `blocks/${row.id}/children`, {
    children: [
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: 'Hello block' } }],
        },
      },
      {
        type: 'link_to_page',
        link_to_page: {
          type: 'page_id',
          page_id: row.id,
        },
      },
    ],
  });
  const children = await call(mod, admin, 'GET', `blocks/${row.id}/children`);
  assert(children.results?.[0]?.paragraph?.rich_text?.[0]?.plain_text === 'Hello block', 'block children round trip failed.');
  assert(children.results?.[1]?.link_to_page?.page_id === row.id, 'link_to_page page_id round trip failed.');

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
  const patchedBlock = await call(mod, admin, 'PATCH', `blocks/${nestedBlockId}?workspace_id=ws1`, {
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: 'Edited block' } }] },
  });
  assert(
    patchedBlock.paragraph?.rich_text?.[0]?.plain_text === 'Edited block',
    'nested block patch did not route through workspace_id.',
  );

  await call(mod, admin, 'PATCH', `pages/${row.id}`, { erase_content: true });
  const erased = await call(mod, admin, 'GET', `blocks/${row.id}/children`);
  assert(erased.results.length === 0, 'page erase_content did not remove block children.');

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

  const upload = await call(mod, admin, 'POST', 'file_uploads', {
    workspace_id: 'ws1',
    filename: 'document.pdf',
    content_type: 'application/pdf',
    content_length: 12,
  });
  assert(upload.object === 'file_upload' && upload.status === 'pending', 'file upload create shape mismatch.');
  assert(upload.upload_url.includes('workspace_id=ws1'), 'file upload send URL must carry workspace routing.');
  assert(upload.complete_url.includes('workspace_id=ws1'), 'file upload complete URL must carry workspace routing.');
  const sentUpload = await call(mod, admin, 'POST', `file_uploads/${upload.id}/send?workspace_id=ws1`);
  assert(sentUpload.status === 'uploaded', 'file upload send did not mark upload as uploaded.');
  const listedUploads = await call(mod, admin, 'GET', 'file_uploads?workspace_id=ws1');
  assert(listedUploads.results.some((item) => item.id === upload.id), 'file upload list did not include upload.');
  const retrievedUpload = await call(mod, admin, 'GET', `file_uploads/${upload.id}?workspace_id=ws1`);
  assert(retrievedUpload.id === upload.id, 'file upload retrieve failed.');
  const completedUpload = await call(mod, admin, 'POST', `file_uploads/${upload.id}/complete?workspace_id=ws1`);
  assert(completedUpload.status === 'uploaded', 'file upload complete did not return uploaded status.');
  const deletedUpload = await call(mod, admin, 'DELETE', `file_uploads/${upload.id}?workspace_id=ws1`);
  assert(deletedUpload.deleted === true && deletedUpload.in_trash === true, 'file upload delete shape mismatch.');

  const sharedUploadPage = await call(mod, admin, 'POST', 'pages', {
    parent: { workspace_id: 'ws1' },
    properties: {
      title: { title: [{ type: 'text', text: { content: 'Shared upload target' } }] },
    },
  });
  await workspaceDb.table('page_permissions').insert({
    id: 'perm-direct-editor',
    pageId: sharedUploadPage.id,
    workspaceId: 'ws1',
    principalType: 'user',
    principalId: 'user-2',
    role: 'edit',
  });
  const directEditor = { id: 'user-2', email: 'editor@example.com' };
  const directUpload = await call(mod, admin, 'POST', 'file_uploads', {
    page_id: sharedUploadPage.id,
    filename: 'direct.pdf',
    content_type: 'application/pdf',
  }, directEditor);
  const sentDirectUpload = await call(mod, admin, 'POST', `file_uploads/${directUpload.id}/send?workspace_id=ws1`, undefined, directEditor);
  assert(sentDirectUpload.status === 'uploaded', 'direct page editor could not send a page-targeted upload.');
  const listedDirectUploads = await call(mod, admin, 'GET', 'file_uploads?workspace_id=ws1', undefined, directEditor);
  assert(
    listedDirectUploads.results.some((item) => item.id === directUpload.id),
    'direct page editor could not list their page-targeted upload.',
  );
  const completedDirectUpload = await call(mod, admin, 'POST', `file_uploads/${directUpload.id}/complete?workspace_id=ws1`, undefined, directEditor);
  assert(completedDirectUpload.status === 'uploaded', 'direct page editor could not complete a page-targeted upload.');

  console.log('Notion API compatibility smoke ok');
}

try {
  await run();
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
