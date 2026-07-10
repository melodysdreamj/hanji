import { describe, expect, it } from 'vitest';

import { POST } from '../../functions/mcp';
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
const ENV = { NOTIONLIKE_MCP_OAUTH_SECRET: 'topsecret', NOTIONLIKE_APP_ORIGIN: ORIGIN };
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
    scopes: ['pages:read', 'pages:write', 'databases:read', 'databases:write', 'workspace:read'],
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
    workspaces: [
      { id: 'ws1', name: 'Mine', ownerId: USER },
      { id: 'ws2', name: 'Foreign', ownerId: 'stranger' },
    ],
    workspace_members: [],
    page_workspace_index: [
      { id: 'root-allowed', workspaceId: 'ws1' },
      { id: 'child-of-allowed', workspaceId: 'ws1' },
      { id: 'other-page', workspaceId: 'ws1' },
      { id: 'db1', workspaceId: 'ws1' },
      { id: 'row1', workspaceId: 'ws1' },
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
    ],
    blocks: [],
    db_properties: [
      { id: 'title1', databaseId: 'db1', name: 'Name', type: 'title', position: 0 },
    ],
    db_views: [],
    db_templates: [],
    comments: [],
    page_permissions: [],
    change_log: [],
  });
  const ws2 = fakeDb({
    pages: [
      page('foreign-db', { workspaceId: 'ws2', kind: 'database', title: 'Do not leak' }),
      page('ws2-page', { workspaceId: 'ws2', title: 'Also private' }),
    ],
    blocks: [],
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
): Promise<ToolResult> {
  const admin = splitAdmin(grant);
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
