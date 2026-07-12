import { describe, expect, it } from 'vitest';

import {
  assertMcpMarkdownBounds,
  assertMcpRequestJsonShape,
  boundedMcpCommentRichText,
  MAX_MCP_COMMENT_RICH_TEXT_ITEMS,
  MAX_MCP_COMMENT_TEXT_BYTES,
  MAX_MCP_CREATE_PAGES,
  MAX_MCP_JSON_RPC_BATCH_ITEMS,
  MAX_MCP_MARKDOWN_BLOCKS,
  MAX_MCP_MARKDOWN_BYTES,
  MAX_MCP_MOVE_PAGE_IDS,
  MAX_MCP_REQUEST_JSON_NODES,
  moveIds,
  POST,
} from '../../functions/mcp';
import { issueAccessToken, type McpOAuthGrant } from '../../lib/mcp-oauth';
import { fakeDb, type Row } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const ORIGIN = 'https://app.example.com';
const RESOURCE = `${ORIGIN}/api/functions/mcp`;
const ENV = { HANJI_MCP_OAUTH_SECRET: 'synthetic-secret', HANJI_APP_ORIGIN: ORIGIN };

function grantRow(overrides: Partial<McpOAuthGrant> = {}): McpOAuthGrant & Row {
  return {
    id: 'grant-1',
    userId: 'user-1',
    clientId: 'client-1',
    resource: RESOURCE,
    scopes: ['workspace:read'],
    status: 'active',
    workspaceAccess: 'all_accessible',
    workspaceIds: [],
    pageIds: [],
    databaseIds: [],
    readOnly: true,
    ...overrides,
  };
}

async function authenticatedRequest(
  body: unknown,
  rawBody?: string,
  grantOverrides: Partial<McpOAuthGrant> = {},
) {
  const grant = grantRow(grantOverrides);
  const central = fakeDb({
    mcp_oauth_grants: [grant],
    workspaces: [{ id: 'workspace-1', ownerId: grant.userId, name: 'Synthetic workspace' }],
    workspace_members: [],
    organization_members: [],
  });
  let dbCalls = 0;
  const admin = {
    db(namespace: string) {
      expect(namespace).toBe('app');
      dbCalls += 1;
      return central;
    },
  };
  const { accessToken } = await issueAccessToken(ENV, undefined, grant, grant.scopes ?? []);
  const response = await handlerOf(POST)({
    request: new Request(RESOURCE, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: rawBody ?? JSON.stringify(body),
    }),
    admin,
    env: ENV,
  });
  expect(response).toBeInstanceOf(Response);
  return { response: response as Response, dbCalls };
}

describe('hosted MCP JSON-RPC batch boundary', () => {
  it('executes a batch at the exact 50-request limit', async () => {
    const body = Array.from({ length: MAX_MCP_JSON_RPC_BATCH_ITEMS }, (_, id) => ({
      jsonrpc: '2.0',
      id,
      method: 'ping',
    }));
    const { response } = await authenticatedRequest(body);

    expect(response.status).toBe(200);
    const payload = await response.json() as Array<{ id: number; result: unknown }>;
    expect(payload).toHaveLength(MAX_MCP_JSON_RPC_BATCH_ITEMS);
    expect(payload.map((item) => item.id)).toEqual(body.map((item) => item.id));
  });

  it('rejects 51 requests before handleRpc performs tool work', async () => {
    const body = Array.from({ length: MAX_MCP_JSON_RPC_BATCH_ITEMS + 1 }, (_, id) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'list_workspaces', arguments: {} },
    }));
    const { response, dbCalls } = await authenticatedRequest(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: -32600, message: expect.stringContaining('at most 50') },
    });
    // Authentication uses the central DB three times. A single tools/call
    // would make at least one additional admin.db call from handleRpc.
    expect(dbCalls).toBe(3);
  });

  it('rejects an empty batch and malformed members without partial execution', async () => {
    const empty = await authenticatedRequest([]);
    expect(empty.response.status).toBe(400);
    expect(await empty.response.json()).toMatchObject({ error: { code: -32600 } });

    const malformed = await authenticatedRequest([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_workspaces', arguments: {} },
      },
      { jsonrpc: '1.0', id: 2, method: 'ping' },
    ]);
    expect(malformed.response.status).toBe(400);
    expect(await malformed.response.json()).toMatchObject({ error: { code: -32600 } });
    expect(malformed.dbCalls).toBe(3);
  });

  it.each([
    null,
    [],
    { jsonrpc: '2.0' },
    { jsonrpc: '2.0', id: true, method: 'ping' },
    { jsonrpc: '2.0', method: 'ping', params: 'invalid' },
  ])('rejects invalid request shape %#', async (body) => {
    const { response } = await authenticatedRequest(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('distinguishes malformed JSON from a structurally invalid request', async () => {
    const { response } = await authenticatedRequest(undefined, '{');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  it('treats only an absent id as a notification', async () => {
    const notification = await authenticatedRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notification.response.status).toBe(202);
    expect(await notification.response.text()).toBe('');

    for (const id of [0, '']) {
      const request = await authenticatedRequest({
        jsonrpc: '2.0',
        id,
        method: 'notifications/initialized',
      });
      expect(request.response.status).toBe(200);
      expect(await request.response.json()).toMatchObject({
        id,
        error: { code: -32601 },
      });
    }
  });

  it('suppresses responses for notifications regardless of method name', async () => {
    const notification = await authenticatedRequest({
      jsonrpc: '2.0',
      method: 'ping',
    });
    expect(notification.response.status).toBe(202);
    expect(await notification.response.text()).toBe('');

    const batch = await authenticatedRequest([
      { jsonrpc: '2.0', method: 'ping' },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ]);
    expect(batch.response.status).toBe(200);
    expect(await batch.response.json()).toEqual([
      { jsonrpc: '2.0', id: 7, result: {} },
    ]);
  });

  it('describes primary compatibility writes as fail-closed in tools and resources', async () => {
    const listed = await authenticatedRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const listPayload = await listed.response.json() as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const primaryWriteNames = new Set([
      '_notion_create_pages',
      'notion-create-pages',
      '_notion_update_page',
      'notion-update-page',
      '_notion_create_database',
      'notion-create-database',
      '_notion_update_data_source',
      'notion-update-data-source',
    ]);
    const primaryWrites = listPayload.result.tools.filter((tool) => primaryWriteNames.has(tool.name));
    expect(primaryWrites).toHaveLength(primaryWriteNames.size);
    for (const tool of primaryWrites) {
      expect(tool.description).toMatch(/unsupported/);
      expect(tool.description).toMatch(/fail-closed/);
      expect(tool.description).not.toMatch(/then (?:creates|updates).*REST facade/i);
    }

    for (const uri of [
      'notion://docs/mcp-compatibility-report',
      'notion://docs/enhanced-markdown-spec',
    ]) {
      const read = await authenticatedRequest({
        jsonrpc: '2.0',
        id: uri,
        method: 'resources/read',
        params: { uri },
      });
      const resourcePayload = await read.response.json() as {
        result: { contents: Array<{ text: string }> };
      };
      const text = resourcePayload.result.contents[0]?.text ?? '';
      expect(text).toMatch(/fail closed|unsupported result/i);
      expect(text).not.toMatch(/primary .*writes .*execute through/i);
    }
  });
});

describe('hosted MCP move-operation boundary', () => {
  it('accepts exactly 50 raw ids and normalizes duplicates', () => {
    const exact = Array.from({ length: MAX_MCP_MOVE_PAGE_IDS }, (_, index) => `page-${index}`);
    expect(moveIds({ page_ids: exact })).toEqual(exact);
    expect(moveIds({
      page_or_database_ids: ['page-1', 'page-1', '', null, 'page-2', 'page-2'],
    })).toEqual(['page-1', 'page-2']);
  });

  it('rejects the 51st raw id before normalization reads any entry', () => {
    const oversized = new Array(MAX_MCP_MOVE_PAGE_IDS + 1);
    Object.defineProperty(oversized, 0, {
      get() {
        throw new Error('normalization must not start');
      },
    });

    expect(() => moveIds({ page_ids: oversized })).toThrow(/at most 50/);
  });

  it('rejects an oversized move tools/call before workspace lookup', async () => {
    const { response, dbCalls } = await authenticatedRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: '_notion_move_pages',
        arguments: {
          workspace_id: 'workspace-1',
          page_ids: Array.from({ length: MAX_MCP_MOVE_PAGE_IDS + 1 }, (_, index) => `page-${index}`),
        },
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining('at most 50') }],
      },
    });
    expect(dbCalls).toBe(3);
  });
});

describe('hosted MCP request work budgets', () => {
  it('rejects excessive whole-body depth and nodes before RPC dispatch', async () => {
    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
    expect(() => assertMcpRequestJsonShape(nested)).toThrow(/at most 32 levels deep/);

    const { response, dbCalls } = await authenticatedRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { junk: new Array(MAX_MCP_REQUEST_JSON_NODES).fill(null) },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: -32600, message: expect.stringContaining('at most 100000 JSON nodes') },
    });
    expect(dbCalls).toBe(3);
  });

  it('bounds Markdown bytes and block count before split/map', () => {
    expect(() => assertMcpMarkdownBounds({ text: 'not Markdown' }))
      .toThrow(/must be a string/);
    expect(() => assertMcpMarkdownBounds('x'.repeat(MAX_MCP_MARKDOWN_BYTES))).not.toThrow();
    expect(() => assertMcpMarkdownBounds('x'.repeat(MAX_MCP_MARKDOWN_BYTES + 1)))
      .toThrow(/at most 262144 UTF-8 bytes/);
    expect(() => assertMcpMarkdownBounds(
      Array.from({ length: MAX_MCP_MARKDOWN_BLOCKS }, () => 'x').join('\n\n'),
    )).not.toThrow();
    expect(() => assertMcpMarkdownBounds(
      Array.from({ length: MAX_MCP_MARKDOWN_BLOCKS + 1 }, () => 'x').join('\n\n'),
    )).toThrow(/at most 1000 blocks/);
  });

  it('rejects create-page count and Markdown overflow before workspace lookup', async () => {
    const oversizedPages = await authenticatedRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: '_notion_create_pages',
        arguments: {
          workspace_id: 'workspace-1',
          pages: Array.from({ length: MAX_MCP_CREATE_PAGES + 1 }, () => ({})),
        },
      },
    });
    expect(oversizedPages.response.status).toBe(200);
    expect(await oversizedPages.response.json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('at most 25') }] },
    });
    expect(oversizedPages.dbCalls).toBe(3);

    const oversizedMarkdown = await authenticatedRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: '_notion_create_pages',
        arguments: {
          workspace_id: 'workspace-1',
          pages: [{ content: 'x'.repeat(MAX_MCP_MARKDOWN_BYTES + 1) }],
        },
      },
    });
    expect(oversizedMarkdown.response.status).toBe(200);
    expect(await oversizedMarkdown.response.json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('at most 262144') }] },
    });
    expect(oversizedMarkdown.dbCalls).toBe(3);

    const malformedPages = await authenticatedRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: '_notion_create_pages',
        arguments: {
          workspace_id: 'workspace-1',
          pages: [{ content: 'valid' }, null],
        },
      },
    });
    expect(malformedPages.response.status).toBe(200);
    expect(await malformedPages.response.json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('must be an object') }] },
    });
    expect(malformedPages.dbCalls).toBe(3);
  });

  it('bounds comment rich-text items, visible text, and estimated JSON', () => {
    const exact = Array.from({ length: MAX_MCP_COMMENT_RICH_TEXT_ITEMS }, (_, index) => ({
      type: 'text',
      text: { content: `item-${index}` },
    }));
    expect(boundedMcpCommentRichText({ rich_text: exact })).toHaveLength(
      MAX_MCP_COMMENT_RICH_TEXT_ITEMS,
    );
    expect(() => boundedMcpCommentRichText({ rich_text: [...exact, {}] }))
      .toThrow(/at most 100 items/);
    expect(() => boundedMcpCommentRichText({
      rich_text: [{ type: 'text', text: { content: 'x'.repeat(MAX_MCP_COMMENT_TEXT_BYTES + 1) } }],
    })).toThrow(/MCP comment text must be at most/);
    expect(() => boundedMcpCommentRichText({
      rich_text: Array.from({ length: 100 }, () => ({ junk: 'x'.repeat(8 * 1024) })),
    })).toThrow(/rich_text JSON must be at most/);
  });

  it('rejects oversized comment arrays before workspace lookup', async () => {
    const { response, dbCalls } = await authenticatedRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: '_notion_create_comment',
        arguments: {
          workspace_id: 'workspace-1',
          page_id: 'page-1',
          rich_text: new Array(MAX_MCP_COMMENT_RICH_TEXT_ITEMS + 1).fill({}),
        },
      },
    }, undefined, { scopes: ['comments:write'], readOnly: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('at most 100') }] },
    });
    expect(dbCalls).toBe(3);
  });
});
