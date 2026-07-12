import { describe, expect, it } from 'vitest';

import { GET, POST } from '../../functions/mcp';
import { issueAccessToken, type McpOAuthGrant } from '../../lib/mcp-oauth';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

// Behavioral guards for the hosted-MCP grant narrowing fixes:
// - the search tool's data_source_url branch scope-checks the data source
//   against the selected workspace like every sibling tool (#1),
// - list_workspaces requires workspace:read like its _notion_get_teams alias (#2),
// - non-empty grant.pageIds/databaseIds allowlists are enforced, with ancestor
//   matching, and empty lists stay unrestricted (#3),
// - cross-workspace targets are indistinguishable from missing ones, closing
//   the instance-wide page-existence oracle (#4).

const ORIGIN = 'https://app.example.com';
const RESOURCE = `${ORIGIN}/api/functions/mcp`;
const ENV = { HANJI_MCP_OAUTH_SECRET: 'topsecret', HANJI_APP_ORIGIN: ORIGIN };
const USER = 'user1';

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

function grantRow(overrides: Partial<McpOAuthGrant> = {}): McpOAuthGrant & Row {
  return {
    id: 'grant1',
    userId: USER,
    clientId: 'client1',
    resource: RESOURCE,
    scopes: [
      'pages:read',
      'pages:write',
      'databases:read',
      'databases:write',
      'comments:read',
      'comments:write',
      'workspace:read',
    ],
    status: 'active',
    workspaceAccess: 'all_accessible',
    workspaceIds: [],
    pageIds: [],
    databaseIds: [],
    readOnly: false,
    ...overrides,
  };
}

function splitAdmin(grant: McpOAuthGrant & Row) {
  const central = fakeDb({
    mcp_oauth_grants: [grant],
    mcp_async_tasks: [],
    workspaces: [
      { id: 'ws1', name: 'Mine', ownerId: USER },
      { id: 'ws2', name: 'Foreign', ownerId: 'stranger' },
    ],
    workspace_members: grant.workspaceAccess === 'selected'
      ? [{ id: 'ws2-member', workspaceId: 'ws2', userId: USER, role: 'member' }]
      : [],
    page_workspace_index: [
      { id: 'root-allowed', workspaceId: 'ws1' },
      { id: 'child-of-allowed', workspaceId: 'ws1' },
      { id: 'other-page', workspaceId: 'ws1' },
      { id: 'db1', workspaceId: 'ws1' },
      { id: 'row1', workspaceId: 'ws1' },
      { id: 'nested-db', workspaceId: 'ws1' },
      { id: 'nested-row', workspaceId: 'ws1' },
      { id: 'cross-parent-corrupt', workspaceId: 'ws1' },
      { id: 'foreign-db', workspaceId: 'ws2' },
      { id: 'ws2-page', workspaceId: 'ws2' },
    ],
    page_permission_index: [],
    share_link_index: [],
    organization_members: [],
    organization_group_members: [],
  });
  const ws1 = fakeDb({
    pages: [
      page('root-allowed'),
      page('child-of-allowed', { parentId: 'root-allowed', parentType: 'page' }),
      page('other-page', { position: 1 }),
      page('db1', { kind: 'database', title: 'Tasks', position: 2 }),
      page('row1', {
        parentId: 'db1',
        parentType: 'database',
        title: 'Task row',
        properties: { title1: 'Task row' },
      }),
      page('nested-db', {
        kind: 'database',
        parentId: 'root-allowed',
        parentType: 'page',
        title: 'Nested database',
        position: 3,
      }),
      page('nested-row', {
        parentId: 'nested-db',
        parentType: 'database',
        title: 'Nested row',
        position: 0,
      }),
      page('cross-parent-corrupt', {
        parentId: 'ws2-page',
        parentType: 'page',
        title: 'Corrupt cross-workspace parent',
        position: 4,
      }),
    ],
    blocks: [
      { id: 'block1', pageId: 'other-page', type: 'paragraph', position: 0 },
      { id: 'row-block', pageId: 'row1', type: 'paragraph', position: 0 },
    ],
    db_properties: [
      { id: 'title1', databaseId: 'db1', name: 'Name', type: 'title', position: 0 },
      { id: 'nested-title', databaseId: 'nested-db', name: 'Name', type: 'title', position: 0 },
    ],
    db_views: [
      { id: 'view1', databaseId: 'db1', name: 'Table', type: 'table', position: 0, config: {} },
      { id: 'bad-view', databaseId: 'other-page', name: 'Invalid', type: 'table', position: 1, config: {} },
    ],
    db_templates: [
      { id: 'template1', databaseId: 'db1', name: 'Task template', blocks: [] },
    ],
    comments: [],
    page_permissions: [],
    change_log: [],
  });
  const ws2 = fakeDb({
    pages: [
      page('foreign-db', { workspaceId: 'ws2', kind: 'database', title: 'Do not leak' }),
      page('ws2-page', { workspaceId: 'ws2', title: 'Also private' }),
    ],
    blocks: [{ id: 'foreign-block', pageId: 'ws2-page', type: 'paragraph', position: 0 }],
    db_properties: [],
    db_views: [],
    comments: [],
    page_permissions: [],
    change_log: [],
  });
  return {
    db(namespace: string, instanceId?: string): FakeDb {
      if (namespace === 'app') return central;
      if (namespace === 'workspace' && instanceId === 'ws1') return ws1;
      if (namespace === 'workspace' && instanceId === 'ws2') return ws2;
      throw new Error(`Unexpected database route: ${namespace}/${instanceId ?? ''}`);
    },
  };
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

async function callTool(
  grant: McpOAuthGrant & Row,
  name: string,
  args: Record<string, unknown>,
  admin = splitAdmin(grant),
): Promise<ToolResult> {
  const { accessToken } = await issueAccessToken(ENV, undefined, grant, grant.scopes ?? []);
  const response = await handlerOf(POST)({
    request: new Request(`${RESOURCE}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    env: ENV,
    admin,
  });
  expect(response).toBeInstanceOf(Response);
  const payload = (await (response as Response).json()) as { result?: ToolResult; error?: unknown };
  expect(payload.error).toBeUndefined();
  return payload.result ?? {};
}

function errorText(result: ToolResult): string {
  return result.content?.map((item) => item.text).join('\n') ?? '';
}

function scopeGrant(scopes: string[], overrides: Partial<McpOAuthGrant> = {}) {
  return grantRow({ scopes, readOnly: !scopes.some((scope) => scope.endsWith(':write')), ...overrides });
}

function expectScopeDenied(result: ToolResult, ...scopes: string[]) {
  expect(result.isError).toBe(true);
  expect(errorText(result)).toContain('does not include');
  for (const scope of scopes) expect(errorText(result)).toContain(scope);
}

function expectMutationAuthorizationPassed(result: ToolResult) {
  // Primary Notion-compatible content mutations deliberately fail closed at
  // the canonical file-lifecycle boundary in this release. Reaching that
  // error proves the MCP scope gate allowed the path without pretending the
  // unavailable mutation itself succeeded.
  expect(result.isError).toBe(true);
  expect(errorText(result)).toContain('content mutations are not available in this release');
  expect(errorText(result)).not.toContain('does not include');
}

function expectMoveAuthorizationPassed(result: ToolResult) {
  expect(errorText(result)).not.toContain('does not include');
  if (result.isError) {
    expect(errorText(result)).toContain('dedicated database-row mutation endpoint');
  }
}

describe('hosted MCP advertised async task status URL', () => {
  it('polls the bound failed task and hides foreign or missing task ids behind the same 404', async () => {
    const grant = scopeGrant(['pages:write']);
    const admin = splitAdmin(grant);
    const created = await callTool(grant, 'notion-create-pages', {
      workspace_id: 'ws1',
      allow_async: true,
      pages: [{ properties: { title: 'Unsupported write probe' } }],
    }, admin);
    const task = created.structuredContent?.async_task as Record<string, unknown> | undefined;
    expect(task).toMatchObject({ status: 'failed' });
    expect(typeof task?.status_url).toBe('string');
    const statusUrl = new URL(String(task?.status_url));
    expect(statusUrl.origin).toBe(ORIGIN);
    expect(statusUrl.pathname).toBe('/api/functions/mcp');
    expect(statusUrl.searchParams.get('async_task_id')).toBe(task?.id);

    const { accessToken } = await issueAccessToken(ENV, undefined, grant, grant.scopes ?? []);
    const poll = async (url: URL) => handlerOf(GET)({
      request: new Request(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      env: ENV,
      admin,
    });
    const response = await poll(statusUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await response.json() as { async_task?: Record<string, unknown> };
    expect(payload.async_task).toMatchObject({ id: task?.id, status: 'failed' });
    expect(JSON.stringify(payload)).not.toContain(ENV.HANJI_MCP_OAUTH_SECRET);
    expect(JSON.stringify(payload)).not.toContain(accessToken);

    admin.db('app').tables.mcp_async_tasks.push({
      id: 'foreign-task',
      grantId: 'another-grant',
      userId: USER,
      clientId: grant.clientId,
      status: 'failed',
      error: { object: 'error', message: 'private foreign task' },
    });
    const foreignUrl = new URL(statusUrl);
    foreignUrl.searchParams.set('async_task_id', 'foreign-task');
    const missingUrl = new URL(statusUrl);
    missingUrl.searchParams.set('async_task_id', 'missing-task');
    const [foreign, missing] = await Promise.all([poll(foreignUrl), poll(missingUrl)]);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });
});

describe('hosted MCP read scope matrix', () => {
  it('workspace:read authorizes directory/user discovery but no content', async () => {
    const grant = scopeGrant(['workspace:read']);
    const policy = await callTool(grant, 'get_mcp_access_policy', {});
    expect((policy.structuredContent?.scope_policy as Record<string, unknown>)?.write_implies_read).toBe(false);
    const users = await callTool(grant, 'search', {
      workspace_id: 'ws1',
      query_type: 'user',
      query: 'user',
    });
    expect(users.isError).toBeFalsy();
    const self = await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'self' });
    expect(self.isError).toBeFalsy();

    expectScopeDenied(
      await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'other-page' }),
      'pages:read',
    );
    expectScopeDenied(
      await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'db1' }),
      'databases:read',
    );
    expectScopeDenied(
      await callTool(grant, 'search', { workspace_id: 'ws1', query: 'task' }),
      'pages:read',
      'databases:read',
    );
    expectScopeDenied(
      await callTool(grant, 'search', {
        workspace_id: 'ws1',
        data_source_url: 'collection://db1',
      }),
      'databases:read',
    );
  });

  it('user search requires workspace:read, not either content scope', async () => {
    const result = await callTool(scopeGrant(['pages:read', 'databases:read']), 'search', {
      workspace_id: 'ws1',
      query_type: 'user',
    });
    expectScopeDenied(result, 'workspace:read');
  });

  it('pages:read reads only normal pages and their blocks', async () => {
    const grant = scopeGrant(['pages:read']);
    const pageResult = await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'other-page' });
    expect(pageResult.isError).toBeFalsy();
    expect((pageResult.structuredContent?.page as Record<string, unknown>)?.id).toBe('other-page');

    const blockResult = await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'block1' });
    expect(blockResult.isError).toBeFalsy();
    expect((blockResult.structuredContent?.block as Record<string, unknown>)?.id).toBe('block1');

    expectScopeDenied(
      await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'db1' }),
      'databases:read',
    );
    expectScopeDenied(
      await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'row1' }),
      'databases:read',
    );
    expectScopeDenied(
      await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'row-block' }),
      'databases:read',
    );
  });

  it('databases:read reads database pages, rows, row blocks, queries, and saved views only', async () => {
    const grant = scopeGrant(['databases:read']);
    for (const id of ['db1', 'row1']) {
      const result = await callTool(grant, 'fetch', { workspace_id: 'ws1', id });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent?.page as Record<string, unknown>)?.id).toBe(id);
    }
    const rowBlock = await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'row-block' });
    expect(rowBlock.isError).toBeFalsy();

    const query = await callTool(grant, '_notion_query_data_sources', {
      data: { workspace_id: 'ws1', data_source_id: 'db1' },
    });
    expect(query.isError).toBeFalsy();

    const view = await callTool(grant, 'notion-query-database-view', {
      workspace_id: 'ws1',
      view_id: 'view1',
    });
    expect(view.isError).toBeFalsy();

    const scopedSearch = await callTool(grant, 'search', {
      workspace_id: 'ws1',
      data_source_url: 'collection://db1',
    });
    expect(scopedSearch.isError).toBeFalsy();

    expectScopeDenied(
      await callTool(grant, 'fetch', { workspace_id: 'ws1', id: 'other-page' }),
      'pages:read',
    );
  });

  it('data-source operations reject a normal page indistinguishably instead of treating it as a database', async () => {
    const grant = scopeGrant(['databases:read']);
    const wrongKind = await callTool(grant, '_notion_query_data_sources', {
      data: { workspace_id: 'ws1', data_source_id: 'other-page' },
    });
    const missing = await callTool(grant, '_notion_query_data_sources', {
      data: { workspace_id: 'ws1', data_source_id: 'missing-data-source' },
    });
    expect(wrongKind.isError).toBe(true);
    expect(errorText(wrongKind)).toBe(errorText(missing));
    expect(errorText(wrongKind)).toContain('Data source was not found.');

    const invalidView = await callTool(grant, 'notion-query-database-view', {
      workspace_id: 'ws1',
      view_id: 'bad-view',
    });
    expect(invalidView.isError).toBe(true);
    expect(errorText(invalidView)).toContain('Data source was not found.');
  });

  it('generic mixed search requires both read scopes and then returns both semantic families', async () => {
    for (const scopes of [['pages:read'], ['databases:read']]) {
      const denied = await callTool(scopeGrant(scopes), 'search', { workspace_id: 'ws1' });
      expectScopeDenied(denied, 'pages:read', 'databases:read');
    }
    const allowed = await callTool(scopeGrant(['pages:read', 'databases:read']), 'search', {
      workspace_id: 'ws1',
      page_size: 100,
    });
    expect(allowed.isError).toBeFalsy();
    const ids = (allowed.structuredContent?.results as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['other-page', 'db1', 'row1']));
  });

  it('write scopes never satisfy any read path', async () => {
    expectScopeDenied(
      await callTool(scopeGrant(['pages:write']), 'fetch', { workspace_id: 'ws1', id: 'other-page' }),
      'pages:read',
    );
    expectScopeDenied(
      await callTool(scopeGrant(['databases:write']), 'fetch', { workspace_id: 'ws1', id: 'row1' }),
      'databases:read',
    );
  });
});

describe('hosted MCP write, source, and destination scope matrix', () => {
  it('keeps primary create/replace writes fail-closed with retry-safe result shapes', async () => {
    const grant = scopeGrant(['pages:write']);
    const admin = splitAdmin(grant);
    const create = await callTool(grant, '_notion_create_pages', {
      workspace_id: 'ws1',
      pages: [
        { properties: { title: 'First' } },
        { properties: { title: 'Second' } },
      ],
    }, admin);
    expect(create.isError).toBe(true);
    expect(create.structuredContent).toMatchObject({
      error: 'create_pages_failed',
      object: 'create_pages_result',
      status: 'failed',
      pages: [],
      succeeded_count: 0,
      failed_index: 0,
      failed_message: expect.stringContaining('content mutations are not available'),
      retry_guidance: {
        strategy: 'retry_remaining_pages_only',
        start_index: 0,
        remaining_count: 2,
      },
    });

    const asyncCreate = await callTool(grant, '_notion_create_pages', {
      workspace_id: 'ws1',
      pages: [{ properties: { title: 'Async' } }],
      allow_async: true,
    }, admin);
    expect(asyncCreate.isError).toBeFalsy();
    expect(asyncCreate.structuredContent).toMatchObject({
      async_task: {
        status: 'failed',
        error: {
          status: 'failed',
          pages: [],
          succeeded_count: 0,
          failed_index: 0,
          retry_guidance: { strategy: 'retry_remaining_pages_only' },
        },
      },
    });

    const before = await admin.db('workspace', 'ws1').table<Row>('blocks').getOne('block1');
    const replace = await callTool(grant, '_notion_update_page', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      command: 'replace_content',
      new_str: 'Replacement',
    }, admin);
    expect(replace.isError).toBe(true);
    expect(replace.structuredContent).toMatchObject({
      error: 'replace_content_not_available',
      supported_alternative: 'insert_content',
    });
    expect(await admin.db('workspace', 'ws1').table<Row>('blocks').getOne('block1'))
      .toEqual(before);
  });

  it('updates a normal page with pages:write and a database page/row with databases:write', async () => {
    expectMutationAuthorizationPassed(await callTool(scopeGrant(['pages:write']), '_notion_update_page', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      title: 'Updated',
    }));
    expectScopeDenied(await callTool(scopeGrant(['pages:write']), '_notion_update_page', {
      workspace_id: 'ws1',
      page_id: 'row1',
      title: 'Updated',
    }), 'databases:write');

    for (const id of ['db1', 'row1']) {
      expectMutationAuthorizationPassed(await callTool(scopeGrant(['databases:write']), '_notion_update_page', {
        workspace_id: 'ws1',
        page_id: id,
        title: 'Updated',
      }));
    }
    expectScopeDenied(await callTool(scopeGrant(['databases:write']), '_notion_update_page', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      title: 'Updated',
    }), 'pages:write');

    // allow_async must not turn a scope denial into an accepted failed task.
    expectScopeDenied(await callTool(scopeGrant(['databases:write']), '_notion_update_page', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      title: 'No',
      allow_async: true,
    }), 'pages:write');

    expectScopeDenied(await callTool(scopeGrant(['pages:write']), '_notion_update_page', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      command: 'apply_template',
      template_id: 'template1',
    }), 'databases:read');
    expectMutationAuthorizationPassed(await callTool(
      scopeGrant(['pages:write', 'databases:read']),
      '_notion_update_page',
      {
        workspace_id: 'ws1',
        page_id: 'other-page',
        command: 'apply_template',
        template_id: 'template1',
      },
    ));
  });

  it('creates pages/rows using the output kind plus the actual destination kind', async () => {
    expectMutationAuthorizationPassed(await callTool(scopeGrant(['pages:write']), '_notion_create_pages', {
      workspace_id: 'ws1',
      pages: [{ properties: { title: 'Root page' } }],
    }));
    expectScopeDenied(await callTool(scopeGrant(['databases:write']), '_notion_create_pages', {
      workspace_id: 'ws1',
      pages: [{ properties: { title: 'Root page' } }],
    }), 'pages:write');
    expectScopeDenied(await callTool(scopeGrant(['databases:write']), '_notion_create_pages', {
      workspace_id: 'ws1',
      pages: [{ properties: { title: 'Root page' } }],
      allow_async: true,
    }), 'pages:write');

    expectMutationAuthorizationPassed(await callTool(scopeGrant(['pages:write']), '_notion_create_pages', {
      workspace_id: 'ws1',
      parent: { page_id: 'other-page' },
      pages: [{ properties: { title: 'Child page' } }],
    }));
    expectMutationAuthorizationPassed(await callTool(scopeGrant(['databases:write']), '_notion_create_pages', {
      workspace_id: 'ws1',
      parent: { database_id: 'db1' },
      pages: [{ properties: { title: 'Database row' } }],
    }));

    // A page nested under a database row is page output attached to a
    // database-scoped destination record, so neither scope alone is enough.
    for (const scopes of [['pages:write'], ['databases:write']]) {
      const denied = await callTool(scopeGrant(scopes), '_notion_create_pages', {
        workspace_id: 'ws1',
        parent: { page_id: 'row1' },
        pages: [{ properties: { title: 'Nested page' } }],
      });
      expectScopeDenied(denied, 'pages:write', 'databases:write');
    }
    expectMutationAuthorizationPassed(await callTool(
      scopeGrant(['pages:write', 'databases:write']),
      '_notion_create_pages',
      {
        workspace_id: 'ws1',
        parent: { page_id: 'row1' },
        pages: [{ properties: { title: 'Nested page' } }],
      },
    ));

    expectScopeDenied(await callTool(scopeGrant(['pages:write']), '_notion_create_pages', {
      workspace_id: 'ws1',
      pages: [{ properties: { title: 'From template' }, template_id: 'template1' }],
    }), 'databases:read');
    expectMutationAuthorizationPassed(await callTool(
      scopeGrant(['pages:write', 'databases:read']),
      '_notion_create_pages',
      {
        workspace_id: 'ws1',
        pages: [{ properties: { title: 'From template' }, template_id: 'template1' }],
      },
    ));
  });

  it('creates a database with database write plus its page destination scope', async () => {
    expectMutationAuthorizationPassed(await callTool(scopeGrant(['databases:write']), '_notion_create_database', {
      workspace_id: 'ws1',
      title: 'Root database',
    }));
    expectScopeDenied(await callTool(scopeGrant(['databases:write']), '_notion_create_database', {
      workspace_id: 'ws1',
      parent: { page_id: 'other-page' },
      title: 'Nested database',
    }), 'pages:write', 'databases:write');
    expectMutationAuthorizationPassed(await callTool(
      scopeGrant(['pages:write', 'databases:write']),
      '_notion_create_database',
      {
        workspace_id: 'ws1',
        parent: { page_id: 'other-page' },
        title: 'Nested database',
      },
    ));

    // A row is itself database-scoped, so nesting a database under it remains
    // wholly inside databases:write despite the page_id wire shape.
    expectMutationAuthorizationPassed(await callTool(scopeGrant(['databases:write']), '_notion_create_database', {
      workspace_id: 'ws1',
      parent: { page_id: 'row1' },
      title: 'Row child database',
    }));
  });

  it('data-source and view mutations require databases:write and an actual database target', async () => {
    const wrongKind = await callTool(scopeGrant(['databases:write']), '_notion_update_data_source', {
      workspace_id: 'ws1',
      data_source_id: 'other-page',
      name: 'No',
    });
    expect(wrongKind.isError).toBe(true);
    expect(errorText(wrongKind)).toContain('Data source was not found.');

    expectScopeDenied(await callTool(scopeGrant(['pages:write']), '_notion_update_data_source', {
      workspace_id: 'ws1',
      data_source_id: 'db1',
      name: 'No',
    }), 'databases:write');
    expectMutationAuthorizationPassed(await callTool(scopeGrant(['databases:write']), '_notion_update_data_source', {
      workspace_id: 'ws1',
      data_source_id: 'db1',
      name: 'Allowed by MCP scope',
    }));

    const createdView = await callTool(scopeGrant(['databases:write']), '_notion_create_view', {
      workspace_id: 'ws1',
      data_source_id: 'db1',
      name: 'Board',
      type: 'board',
    });
    expect(createdView.isError).toBeFalsy();
    expectScopeDenied(await callTool(scopeGrant(['pages:write']), '_notion_create_view', {
      workspace_id: 'ws1',
      data_source_id: 'db1',
      name: 'No',
    }), 'databases:write');
  });

  it('duplicate requires source-subtree reads and output/destination writes without write-as-read', async () => {
    expectScopeDenied(await callTool(
      scopeGrant(['pages:write']),
      '_notion_duplicate_page',
      { workspace_id: 'ws1', page_id: 'other-page' },
    ), 'pages:read');

    const pageCopy = await callTool(
      scopeGrant(['pages:read', 'pages:write']),
      '_notion_duplicate_page',
      { workspace_id: 'ws1', page_id: 'other-page' },
    );
    expect(pageCopy.isError).toBeFalsy();

    // A normal page copied into a database becomes a database row: source
    // pages:read plus destination databases:write are sufficient and exact.
    expectScopeDenied(await callTool(
      scopeGrant(['pages:write', 'databases:write']),
      '_notion_duplicate_page',
      {
        workspace_id: 'ws1',
        page_id: 'other-page',
        parent_id: 'db1',
        parent_type: 'database',
      },
    ), 'pages:read');
    const rowCopy = await callTool(
      scopeGrant(['pages:read', 'databases:write']),
      '_notion_duplicate_page',
      {
        workspace_id: 'ws1',
        page_id: 'other-page',
        parent_id: 'db1',
        parent_type: 'database',
      },
    );
    expect(rowCopy.isError).toBeFalsy();

    // A database copied below a normal page keeps database output but also
    // mutates a page-scoped destination container.
    expectScopeDenied(await callTool(
      scopeGrant(['databases:read', 'databases:write']),
      '_notion_duplicate_page',
      {
        workspace_id: 'ws1',
        page_id: 'db1',
        parent_id: 'other-page',
        parent_type: 'page',
      },
    ), 'pages:write', 'databases:write');
    const databaseCopy = await callTool(
      scopeGrant(['databases:read', 'databases:write', 'pages:write']),
      '_notion_duplicate_page',
      {
        workspace_id: 'ws1',
        page_id: 'db1',
        parent_id: 'other-page',
        parent_type: 'page',
      },
    );
    expect(databaseCopy.isError).toBeFalsy();
  });

  it('duplicate checks every semantic family in a mixed source subtree', async () => {
    const denied = await callTool(
      scopeGrant(['pages:read', 'pages:write', 'databases:write']),
      '_notion_duplicate_page',
      { workspace_id: 'ws1', page_id: 'root-allowed' },
    );
    expectScopeDenied(denied, 'pages:read', 'databases:read');

    const allowed = await callTool(
      scopeGrant(['pages:read', 'pages:write', 'databases:read', 'databases:write']),
      '_notion_duplicate_page',
      { workspace_id: 'ws1', page_id: 'root-allowed' },
    );
    expect(allowed.isError).toBeFalsy();
  });

  it('move requires both the source and resulting/destination write families', async () => {
    const pageOnly = await callTool(scopeGrant(['pages:write']), '_notion_move_pages', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      new_parent: { type: 'workspace' },
    });
    expect(pageOnly.isError).toBeFalsy();
    const movedPage = (pageOnly.structuredContent?.moved as Array<Record<string, unknown>>)[0];
    expect(movedPage.id).toBe('other-page');
    expect(movedPage).not.toHaveProperty('title');

    expectScopeDenied(await callTool(scopeGrant(['pages:write']), '_notion_move_pages', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      new_parent: { type: 'database', database_id: 'db1' },
    }), 'pages:write', 'databases:write');
    const pageToRow = await callTool(
      scopeGrant(['pages:write', 'databases:write']),
      '_notion_move_pages',
      {
        workspace_id: 'ws1',
        page_id: 'other-page',
        new_parent: { type: 'database', database_id: 'db1' },
      },
    );
    expectMoveAuthorizationPassed(pageToRow);

    expectScopeDenied(await callTool(scopeGrant(['databases:write']), '_notion_move_pages', {
      workspace_id: 'ws1',
      page_id: 'row1',
      new_parent: { type: 'page', page_id: 'other-page' },
    }), 'databases:write', 'pages:write');
    const rowToPage = await callTool(
      scopeGrant(['databases:write', 'pages:write']),
      '_notion_move_pages',
      {
        workspace_id: 'ws1',
        page_id: 'row1',
        new_parent: { type: 'page', page_id: 'other-page' },
      },
    );
    expectMoveAuthorizationPassed(rowToPage);
  });

  it('validates a mixed move batch before mutating its first item', async () => {
    const grant = scopeGrant(['pages:write']);
    const admin = splitAdmin(grant);
    const result = await callTool(grant, '_notion_move_pages', {
      workspace_id: 'ws1',
      page_ids: ['other-page', 'db1'],
      new_parent: { type: 'page', page_id: 'root-allowed' },
    }, admin);
    expectScopeDenied(result, 'databases:write');
    const unchanged = await admin.db('workspace', 'ws1').table<Row>('pages').getOne('other-page');
    expect(unchanged.parentType).toBe('workspace');
    expect(unchanged.parentId).toBeNull();
  });

  it('never lets caller-supplied parent_type relabel the actual destination kind', async () => {
    const create = await callTool(scopeGrant(['pages:write']), '_notion_create_pages', {
      workspace_id: 'ws1',
      parent: { page_id: 'db1' },
      pages: [{ properties: { title: 'No' } }],
    });
    expect(create.isError).toBe(true);
    expect(errorText(create)).toContain('Parent was not found.');

    const duplicate = await callTool(
      scopeGrant(['pages:read', 'pages:write']),
      '_notion_duplicate_page',
      {
        workspace_id: 'ws1',
        page_id: 'other-page',
        parent_id: 'db1',
        parent_type: 'page',
      },
    );
    expect(duplicate.isError).toBe(true);
    expect(errorText(duplicate)).toContain('Destination parent was not found.');

    const move = await callTool(scopeGrant(['pages:write']), '_notion_move_pages', {
      workspace_id: 'ws1',
      page_id: 'other-page',
      new_parent: { type: 'page', page_id: 'db1' },
    });
    expect(move.isError).toBe(true);
    expect(errorText(move)).toContain('Destination parent was not found.');
  });
});

describe('search data_source_url stays inside the selected workspace (#1)', () => {
  it('rejects a data source living in another workspace as not found', async () => {
    const result = await callTool(grantRow(), 'search', {
      workspace_id: 'ws1',
      data_source_url: 'collection://foreign-db',
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('Data source was not found.');
  });

  it('still queries a data source of the selected workspace', async () => {
    const result = await callTool(grantRow(), 'search', {
      workspace_id: 'ws1',
      data_source_url: 'collection://db1',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.data_source_id).toBe('db1');
  });
});

describe('list_workspaces requires workspace:read (#2)', () => {
  it('rejects a grant without the workspace:read scope', async () => {
    const result = await callTool(grantRow({ scopes: ['pages:read'] }), 'list_workspaces', {});
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('does not include the required scope');
  });

  it('lists workspaces when the scope is granted', async () => {
    const result = await callTool(grantRow(), 'list_workspaces', {});
    expect(result.isError).toBeFalsy();
    const workspaces = result.structuredContent?.workspaces as Array<{ id: string }>;
    expect(workspaces.map((workspace) => workspace.id)).toEqual(['ws1']);
  });
});

describe('selected-workspace comment block routing', () => {
  const selectedGrant = () => grantRow({ workspaceAccess: 'selected', workspaceIds: ['ws1'] });

  it('lists comments for a block owned by the selected workspace', async () => {
    const result = await callTool(selectedGrant(), '_notion_get_comments', {
      workspace_id: 'ws1',
      block_id: 'block1',
    });
    expect(result.isError).toBeFalsy();
  });

  it('does not fan out to the same user’s other accessible workspace for a block id', async () => {
    const result = await callTool(selectedGrant(), '_notion_get_comments', {
      workspace_id: 'ws1',
      block_id: 'foreign-block',
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('Block was not found.');
  });
});

describe('grant pageIds/databaseIds allowlists are enforced (#3)', () => {
  it('empty allowlists keep the grant workspace-scoped only', async () => {
    const result = await callTool(grantRow(), 'fetch', { id: 'other-page', workspace_id: 'ws1' });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent?.page as Record<string, unknown>)?.id).toBe('other-page');
  });

  it('a page-scoped grant reads the allowlisted subtree but nothing else', async () => {
    const scoped = grantRow({ pageIds: ['root-allowed'] });
    const child = await callTool(scoped, 'fetch', { id: 'child-of-allowed', workspace_id: 'ws1' });
    expect(child.isError).toBeFalsy();
    expect((child.structuredContent?.page as Record<string, unknown>)?.id).toBe('child-of-allowed');

    const denied = await callTool(scoped, 'fetch', { id: 'other-page', workspace_id: 'ws1' });
    expect(denied.isError).toBe(true);
    expect(errorText(denied)).toContain('Page was not found.');
  });

  it('never inherits an allowlist through a corrupt cross-workspace parent link', async () => {
    const scoped = scopeGrant(['pages:read'], { pageIds: ['ws2-page'] });
    const result = await callTool(scoped, 'fetch', {
      id: 'cross-parent-corrupt',
      workspace_id: 'ws1',
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('Page was not found.');
  });

  it('a database-scoped grant covers the database and its rows but not other pages', async () => {
    const scoped = grantRow({ databaseIds: ['db1'] });
    const query = await callTool(scoped, '_notion_query_data_sources', {
      data: { workspace_id: 'ws1', data_source_id: 'db1' },
    });
    expect(query.isError).toBeFalsy();
    expect(query.structuredContent?.data_source_id).toBe('db1');

    const row = await callTool(scoped, 'fetch', { id: 'row1', workspace_id: 'ws1' });
    expect(row.isError).toBeFalsy();
    expect((row.structuredContent?.page as Record<string, unknown>)?.id).toBe('row1');

    const denied = await callTool(scoped, 'fetch', { id: 'other-page', workspace_id: 'ws1' });
    expect(denied.isError).toBe(true);
    expect(errorText(denied)).toContain('Page was not found.');
  });

  it('generic mixed search projects only the allowlisted subtree', async () => {
    const scoped = scopeGrant(['pages:read', 'databases:read'], { pageIds: ['root-allowed'] });
    const result = await callTool(scoped, 'search', { workspace_id: 'ws1', page_size: 100 });
    expect(result.isError).toBeFalsy();
    const ids = (result.structuredContent?.results as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'root-allowed',
      'child-of-allowed',
      'nested-db',
      'nested-row',
    ]));
    expect(ids).not.toEqual(expect.arrayContaining(['other-page', 'db1', 'row1']));
  });

  it('new resources must inherit an allowlisted destination container', async () => {
    const scoped = scopeGrant(['pages:read', 'pages:write'], { pageIds: ['root-allowed'] });
    const escapedRoot = await callTool(scoped, '_notion_create_pages', {
      workspace_id: 'ws1',
      pages: [{ properties: { title: 'Escaped root' } }],
    });
    expect(escapedRoot.isError).toBe(true);
    expect(errorText(escapedRoot)).toContain('Parent was not found.');

    expectMutationAuthorizationPassed(await callTool(scoped, '_notion_create_pages', {
      workspace_id: 'ws1',
      parent: { page_id: 'root-allowed' },
      pages: [{ properties: { title: 'Allowed child' } }],
    }));

    const escapedCopy = await callTool(scoped, '_notion_duplicate_page', {
      workspace_id: 'ws1',
      page_id: 'root-allowed',
    });
    expect(escapedCopy.isError).toBe(true);
    expect(errorText(escapedCopy)).toContain('Destination parent was not found.');

    const inheritedCopy = await callTool(scoped, '_notion_duplicate_page', {
      workspace_id: 'ws1',
      page_id: 'child-of-allowed',
    });
    expect(inheritedCopy.isError).toBeFalsy();
  });

  it('an inherited child cannot be moved out of its allowlisted ancestor', async () => {
    const scoped = scopeGrant(['pages:write'], { pageIds: ['root-allowed'] });
    const result = await callTool(scoped, '_notion_move_pages', {
      workspace_id: 'ws1',
      page_id: 'child-of-allowed',
      new_parent: { type: 'workspace' },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('Destination parent was not found.');
  });
});

describe('cross-workspace targets are indistinguishable from missing ones (#4)', () => {
  it('queryDataSources returns the identical not-found error for foreign and missing ids', async () => {
    const foreign = await callTool(grantRow(), '_notion_query_data_sources', {
      data: { workspace_id: 'ws1', data_source_id: 'foreign-db' },
    });
    const missing = await callTool(grantRow(), '_notion_query_data_sources', {
      data: { workspace_id: 'ws1', data_source_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(foreign.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(errorText(foreign)).toBe(errorText(missing));
    expect(errorText(foreign)).toContain('Data source was not found.');
  });

  it('move_pages files foreign and missing ids into not_found alike', async () => {
    const result = await callTool(grantRow(), '_notion_move_pages', {
      workspace_id: 'ws1',
      page_ids: ['ws2-page', '11111111-1111-4111-8111-111111111111'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.not_found).toEqual([
      'ws2-page',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(result.structuredContent?.moved).toEqual([]);
  });
});
