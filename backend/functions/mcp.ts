import { defineFunction } from '@edge-base/shared';
import { boundedDb, boundedDbForPage } from '../lib/workspace-db';
import { bestEffort } from '../lib/table-utils';
import { POST as duplicatePageHandler } from './duplicate-page';
import { notionCompatHandler } from './notion/v1/[...slug]';
import { POST as pageMutationHandler } from './page-mutation';
import {
  type DbRef,
  type McpOAuthGrant,
  accessibleWorkspaces,
  authorizationChallenge,
  bearerToken,
  corsHeaders,
  endpointUrls,
  grantIsActive,
  json,
  listAll,
  optionsResponse,
  publicGrant,
  verifyAccessToken,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): DbRef;
  };
}

type PageParentType = 'workspace' | 'page' | 'database';

interface PageRecord {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType | string | null;
  kind?: string | null;
  title?: string | null;
  position?: number | null;
  inTrash?: boolean | null;
}

interface DbPropertyRecord {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config?: Record<string, unknown> | null;
  position?: number | null;
}

interface DbViewRecord {
  id: string;
  databaseId: string;
  name?: string | null;
  type?: string | null;
  config?: Record<string, unknown> | null;
  position?: number | null;
}

interface McpAsyncTask {
  id: string;
  grantId: string;
  userId: string;
  clientId: string;
  status?: string | null;
  operation?: Record<string, unknown> | null;
  result?: unknown;
  error?: unknown;
  pollAfterSeconds?: number | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

type InternalFunctionHandler =
  | ((context: unknown) => Promise<unknown> | unknown)
  | { handler?: (context: unknown) => Promise<unknown> | unknown };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const COMPATIBILITY_REPORT_URI = 'notion://docs/mcp-compatibility-report';
const ENHANCED_MARKDOWN_URI = 'notion://docs/enhanced-markdown-spec';
const VIEW_DSL_URI = 'notion://docs/view-dsl-spec';

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const emptyObjectSchema = { type: 'object', properties: {}, additionalProperties: false };
const jsonObjectSchema = { type: 'object', additionalProperties: true };

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function arrayOf(itemSchema: Record<string, unknown>) {
  return { type: 'array', items: itemSchema };
}

function stringSchema(description?: string) {
  return description ? { type: 'string', description } : { type: 'string' };
}

function numberSchema(description?: string) {
  return description ? { type: 'number', description } : { type: 'number' };
}

function booleanSchema(description?: string) {
  return description ? { type: 'boolean', description } : { type: 'boolean' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function stripHanjiId(value: unknown) {
  const raw = textValue(value);
  if (!raw) return '';
  if (/^collection:\/\//i.test(raw)) return raw.replace(/^collection:\/\//i, '').trim();
  if (/^view:\/\//i.test(raw)) return raw.replace(/^view:\/\//i, '').trim();
  try {
    const url = new URL(raw);
    const pageMatch = url.pathname.match(/\/(?:p|database)\/([0-9a-f-]{32,36})/i);
    if (pageMatch) return pageMatch[1];
    const blockMatch = url.hash.match(/block-([0-9a-f-]{32,36})/i);
    if (blockMatch) return blockMatch[1];
    const view = url.searchParams.get('v');
    if (view) return view;
  } catch {
    // fall through
  }
  return raw;
}

function selectedWorkspaceId(input: Record<string, unknown>) {
  return stripHanjiId(input.workspace_id ?? input.workspaceId ?? input.teamspace_id);
}

function pageSize(value: unknown, fallback = 25, max = 100) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function positionBetween(a?: number | null, b?: number | null) {
  if (a == null && b == null) return 1;
  if (a == null) return (b ?? 1) / 2;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

function titleOf(page: PageRecord | null | undefined) {
  return page?.title || 'Untitled';
}

function normalizeParentType(value: unknown, parentId: string | null): PageParentType {
  const raw = textValue(value).toLowerCase();
  if (raw === 'workspace' || (!raw && !parentId)) return 'workspace';
  if (raw === 'database' || raw === 'data_source' || raw === 'database_id' || raw === 'data_source_id') return 'database';
  return 'page';
}

function siblingPages(pages: PageRecord[], parentId: string | null, parentType: PageParentType, excludeId: string) {
  return pages
    .filter((page) => {
      if (page.inTrash || page.id === excludeId) return false;
      if (parentType === 'workspace') return !page.parentId || page.parentType === 'workspace';
      return page.parentId === parentId && page.parentType === parentType;
    })
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function toolJson(payload: unknown, isError = false) {
  return {
    isError,
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: typeof payload === 'string' ? { text: payload } : payload,
  };
}

function toolError(message: string, extra: Record<string, unknown> = {}) {
  return toolJson({ error: message, ...extra }, true);
}

function grantScopes(grant: McpOAuthGrant) {
  return new Set((grant.scopes ?? []).map((scope) => String(scope)));
}

function hasScope(grant: McpOAuthGrant, scopes: string[]) {
  const current = grantScopes(grant);
  return scopes.some((scope) => current.has(scope));
}

function requireGrantScope(grant: McpOAuthGrant, scopes: string[]) {
  if (!hasScope(grant, scopes)) {
    throw new Error(`This MCP grant does not include the required scope (${scopes.join(' or ')}).`);
  }
}

function requireGrantWrite(grant: McpOAuthGrant, scopes: string[]) {
  if (grant.readOnly === true) throw new Error('This MCP grant is read-only.');
  requireGrantScope(grant, scopes);
}

function mcpHeaders(request: Request, extra?: HeadersInit) {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json');
  headers.set('Mcp-Protocol-Version', request.headers.get('Mcp-Protocol-Version') || '2025-11-25');
  if (extra) {
    const input = new Headers(extra);
    input.forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function unauthorized(context: FunctionContext) {
  return json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Hanji MCP authentication required.',
      },
      id: null,
    },
    {
      status: 401,
      headers: mcpHeaders(context.request, {
        'WWW-Authenticate': authorizationChallenge(context),
      }),
    },
  );
}

async function authenticatedGrant(context: FunctionContext) {
  const raw = bearerToken(context.request);
  if (!raw) return null;
  const token = await verifyAccessToken(raw, context.env, context.request);
  const grant = await context.admin.db('app').table<McpOAuthGrant>('mcp_oauth_grants').getOne(token.grant_id);
  if (!grantIsActive(grant)) throw new Error('MCP grant is revoked or expired.');
  if (grant!.userId !== token.sub || grant!.clientId !== token.client_id) {
    throw new Error('MCP grant does not match the access token.');
  }
  await bestEffort(
    'mcp grant lastUsedAt update',
    context.admin.db('app').table<McpOAuthGrant>('mcp_oauth_grants')
      .update(grant!.id, { lastUsedAt: new Date().toISOString() }),
  );
  return { token, grant: grant! };
}

const notionSearchSchema = objectSchema({
  query: stringSchema('Search query.'),
  query_type: { type: 'string', enum: ['internal', 'user'], description: 'Use user to search workspace members.' },
  content_search_mode: { type: 'string', enum: ['workspace_search', 'ai_search'] },
  data_source_url: stringSchema('Optional collection://<database-id> to search/query a data source.'),
  page_url: stringSchema('Optional page URL/id for clients that provide it.'),
  workspace_id: stringSchema('Required Hanji workspace id. Call list_workspaces or _notion_get_teams first.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  page_size: numberSchema('1-100 results.'),
  start_cursor: stringSchema('Pagination cursor.'),
  filters: jsonObjectSchema,
});

const notionFetchSchema = objectSchema({
  id: stringSchema('Page URL/id, database URL/id, block id, or collection://<database-id>.'),
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  include_discussions: booleanSchema('Include page comments summary where supported.'),
});

const notionQueryDataSourcesSchema = objectSchema({
  data: {
    type: 'object',
    description: 'Use {workspace_id, data_source_id|data_source_url|data_source_urls, query, filter, sorts, page_size, start_cursor}.',
    additionalProperties: true,
  },
}, ['data']);

const notionQueryDatabaseViewSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  view_id: stringSchema('View id, view:// URI, or Notion URL with ?v=.'),
  view_url: stringSchema('View URL, view:// URI, or Notion URL with ?v=.'),
  query: stringSchema('Optional search text applied on top of the saved view.'),
  page_size: numberSchema('1-100 results.'),
  start_cursor: stringSchema('Pagination cursor.'),
});

const notionCreatePagesSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  parent: {
    type: 'object',
    properties: {
      page_id: stringSchema(),
      database_id: stringSchema(),
      data_source_id: stringSchema(),
      workspace_id: stringSchema(),
    },
    additionalProperties: true,
  },
  pages: arrayOf({
    type: 'object',
    properties: {
      properties: jsonObjectSchema,
      content: stringSchema('Markdown-ish content; converted to basic Notion blocks.'),
      icon: stringSchema(),
      cover: stringSchema(),
      template_id: stringSchema(),
    },
    additionalProperties: true,
  }),
  allow_async: booleanSchema('Return a Notion-style async task handle.'),
}, ['pages']);

const notionUpdatePageSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  page_id: stringSchema('Page id or URL.'),
  pageId: stringSchema('Page id or URL.'),
  command: {
    type: 'string',
    enum: ['update_properties', 'insert_content', 'replace_content', 'update_content', 'apply_template', 'update_verification'],
  },
  title: stringSchema(),
  properties: jsonObjectSchema,
  content: stringSchema('Markdown-ish content.'),
  new_str: stringSchema('Replacement or inserted Markdown-ish content.'),
  position: jsonObjectSchema,
  icon: stringSchema(),
  cover: stringSchema(),
  locked: booleanSchema(),
  allow_async: booleanSchema('Return a Notion-style async task handle.'),
});

const notionDuplicatePageSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  workspaceId: stringSchema('Notionlike workspace id alias for workspace_id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  pageId: stringSchema('Page id or URL to duplicate.'),
  page_id: stringSchema('Notion-compatible page id alias.'),
  title: stringSchema('Optional title for the copied root page.'),
  parentId: stringSchema('Optional destination parent page/database id.'),
  parent_id: stringSchema('Notion-compatible destination parent id alias.'),
  parentType: { type: 'string', enum: ['workspace', 'page', 'database'] },
  parent_type: { type: 'string', enum: ['workspace', 'page', 'database'] },
  allow_async: booleanSchema('Return a Notion-style async task handle.'),
});

const notionMovePagesSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  page_or_database_ids: arrayOf(stringSchema('Page or database id/URL to move.')),
  page_ids: arrayOf(stringSchema('Alternative page id list.')),
  page_id: stringSchema('Single page id.'),
  new_parent: {
    type: 'object',
    properties: {
      type: stringSchema(),
      page_id: stringSchema(),
      parent_page_id: stringSchema(),
      database_id: stringSchema(),
      data_source_id: stringSchema(),
    },
    additionalProperties: true,
  },
  parent: {
    type: 'object',
    properties: {
      type: stringSchema(),
      page_id: stringSchema(),
      parent_page_id: stringSchema(),
      database_id: stringSchema(),
      data_source_id: stringSchema(),
    },
    additionalProperties: true,
  },
  after_page_id: stringSchema('Destination sibling to place after.'),
  before_page_id: stringSchema('Destination sibling to place before.'),
});

const notionCommentSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  page_id: stringSchema(),
  block_id: stringSchema(),
  comment_id: stringSchema(),
  discussion_id: stringSchema(),
  rich_text: arrayOf(jsonObjectSchema),
  text: stringSchema('Plain text comment body.'),
  resolved: booleanSchema(),
});

const notionAsyncTaskSchema = objectSchema({
  task_id: stringSchema('Async task id returned by a previous hosted MCP operation.'),
});

const hostedTools: ToolDefinition[] = [
  {
    name: 'get_mcp_access_policy',
    title: 'Get MCP access policy',
    description: 'Show the hosted Hanji MCP grant scopes and resource narrowing for this connection.',
    inputSchema: emptyObjectSchema,
  },
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'List Hanji workspaces accessible to the connected account. Pass one workspace_id to workspace-bound tools.',
    inputSchema: emptyObjectSchema,
  },
  {
    name: '_notion_get_teams',
    title: 'Get teams',
    description: 'Notion-compatible teamspace listing. Hanji maps teamspaces to accessible workspaces.',
    inputSchema: objectSchema({ query: stringSchema() }),
  },
  {
    name: 'notion-get-teams',
    title: 'Get teams',
    description: 'Official Notion MCP-compatible teamspace listing. Hanji maps teamspaces to accessible workspaces.',
    inputSchema: objectSchema({ query: stringSchema() }),
  },
  {
    name: '_notion_get_users',
    title: 'Get users',
    description: 'Notion-compatible user listing for one Hanji workspace.',
    inputSchema: objectSchema({
      workspace_id: stringSchema('Required Hanji workspace id.'),
      teamspace_id: stringSchema('Alias for workspace_id.'),
      user_id: stringSchema('Specific user id, or self.'),
      query: stringSchema(),
      start_cursor: stringSchema(),
      page_size: numberSchema(),
    }),
  },
  {
    name: 'notion-get-users',
    title: 'Get users',
    description: 'Official Notion MCP-compatible user listing for one Hanji workspace.',
    inputSchema: objectSchema({
      workspace_id: stringSchema('Required Hanji workspace id.'),
      teamspace_id: stringSchema('Alias for workspace_id.'),
      user_id: stringSchema('Specific user id, or self.'),
      query: stringSchema(),
      start_cursor: stringSchema(),
      page_size: numberSchema(),
    }),
  },
  {
    name: 'search',
    title: 'Search',
    description: 'Search Hanji pages/databases using the Notion-compatible hosted MCP shape.',
    inputSchema: notionSearchSchema,
  },
  {
    name: '_search',
    title: 'Search',
    description: 'Notion-compatible alias for search. Requires workspace_id or teamspace_id.',
    inputSchema: notionSearchSchema,
  },
  {
    name: 'notion-search',
    title: 'Search',
    description: 'Official Notion MCP-compatible search. Requires workspace_id or teamspace_id in Hanji.',
    inputSchema: notionSearchSchema,
  },
  {
    name: 'fetch',
    title: 'Fetch',
    description: 'Fetch an Hanji page, block, database, or collection:// data source using a Notion-compatible result.',
    inputSchema: notionFetchSchema,
  },
  {
    name: '_fetch',
    title: 'Fetch',
    description: 'Notion-compatible alias for fetch. Requires workspace_id or teamspace_id.',
    inputSchema: notionFetchSchema,
  },
  {
    name: 'notion-fetch',
    title: 'Fetch',
    description: 'Official Notion MCP-compatible fetch. Supports id self, page ids, and collection:// data source ids.',
    inputSchema: notionFetchSchema,
  },
  {
    name: '_notion_query_data_sources',
    title: 'Query data sources',
    description: 'Notion-compatible data source query for Hanji databases.',
    inputSchema: notionQueryDataSourcesSchema,
  },
  {
    name: 'notion-query-data-sources',
    title: 'Query data sources',
    description: 'Official Notion MCP-compatible data source query for Hanji databases.',
    inputSchema: notionQueryDataSourcesSchema,
  },
  {
    name: 'notion-query-database-view',
    title: 'Query database view',
    description: 'Official Notion MCP-compatible saved database view query. Hanji applies supported saved search/filter/sort settings.',
    inputSchema: notionQueryDatabaseViewSchema,
  },
  {
    name: '_notion_create_pages',
    title: 'Create pages',
    description: 'Notion-compatible page/row creation. Requires write scopes.',
    inputSchema: notionCreatePagesSchema,
  },
  {
    name: 'notion-create-pages',
    title: 'Create pages',
    description: 'Official Notion MCP-compatible page/row creation. Supports allow_async.',
    inputSchema: notionCreatePagesSchema,
  },
  {
    name: '_notion_update_page',
    title: 'Update page',
    description: 'Notion-compatible page update and content insertion/replacement. Requires write scopes.',
    inputSchema: notionUpdatePageSchema,
  },
  {
    name: 'notion-update-page',
    title: 'Update page',
    description: 'Official Notion MCP-compatible page update. Supports allow_async.',
    inputSchema: notionUpdatePageSchema,
  },
  {
    name: '_notion_duplicate_page',
    title: 'Duplicate page',
    description: 'Duplicate an Hanji page subtree using the same product copy rules as the app. Requires write scopes.',
    inputSchema: notionDuplicatePageSchema,
  },
  {
    name: 'notion-duplicate-page',
    title: 'Duplicate page',
    description: 'Official Notion MCP-compatible page duplication. Returns an async task handle.',
    inputSchema: notionDuplicatePageSchema,
  },
  {
    name: '_notion_move_pages',
    title: 'Move pages',
    description: 'Move pages/databases to workspace root, under a page, or into a data source/database. Requires write scopes.',
    inputSchema: notionMovePagesSchema,
  },
  {
    name: 'notion-move-pages',
    title: 'Move pages',
    description: 'Official Notion MCP-compatible multi-page move.',
    inputSchema: notionMovePagesSchema,
  },
  {
    name: '_notion_create_database',
    title: 'Create database',
    description: 'Create a database/data source using Notion-compatible database payloads. Requires database write scope.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: 'notion-create-database',
    title: 'Create database',
    description: 'Official Notion MCP-compatible database creation.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: '_notion_update_data_source',
    title: 'Update data source',
    description: 'Update a database/data source schema or metadata. Requires database write scope.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: 'notion-update-data-source',
    title: 'Update data source',
    description: 'Official Notion MCP-compatible data source update.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: '_notion_get_comments',
    title: 'Get comments',
    description: 'List comments on a page or block.',
    inputSchema: notionCommentSchema,
  },
  {
    name: 'notion-get-comments',
    title: 'Get comments',
    description: 'Official Notion MCP-compatible comment listing.',
    inputSchema: notionCommentSchema,
  },
  {
    name: '_notion_create_comment',
    title: 'Create comment',
    description: 'Create a page or block comment. Requires comments write scope.',
    inputSchema: notionCommentSchema,
  },
  {
    name: 'notion-create-comment',
    title: 'Create comment',
    description: 'Official Notion MCP-compatible comment creation.',
    inputSchema: notionCommentSchema,
  },
  {
    name: '_notion_create_view',
    title: 'Create view',
    description: 'Create a database view through the Notion-compatible REST facade.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: 'notion-create-view',
    title: 'Create view',
    description: 'Official Notion MCP-compatible view creation. Hanji supports table, board, list, gallery, calendar, and timeline.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: '_notion_update_view',
    title: 'Update view',
    description: 'Update a database view through the Notion-compatible REST facade.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: 'notion-update-view',
    title: 'Update view',
    description: 'Official Notion MCP-compatible view update.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: '_notion_query_meeting_notes',
    title: 'Query meeting notes',
    description: 'Compatibility response for Notion AI meeting notes; Hanji has no separate meeting-notes source.',
    inputSchema: objectSchema({
      workspace_id: stringSchema('Required Hanji workspace id.'),
      teamspace_id: stringSchema('Alias for workspace_id.'),
    }),
  },
  {
    name: 'notion-query-meeting-notes',
    title: 'Query meeting notes',
    description: 'Official Notion MCP-compatible unsupported response for Notion AI meeting notes.',
    inputSchema: objectSchema({
      workspace_id: stringSchema('Required Hanji workspace id.'),
      teamspace_id: stringSchema('Alias for workspace_id.'),
    }),
  },
  {
    name: 'notion-get-async-task',
    title: 'Get async task',
    description: 'Official Notion MCP-compatible async task status lookup for hosted MCP operations.',
    inputSchema: notionAsyncTaskSchema,
  },
];

async function toolList() {
  return {
    tools: hostedTools,
  };
}

async function grantedAccessibleWorkspaces(context: FunctionContext, grant: McpOAuthGrant) {
  const rows = await accessibleWorkspaces(context.admin.db('app'), grant.userId);
  if ((grant.workspaceAccess ?? 'all_accessible') !== 'selected') return rows;
  const allowed = new Set((grant.workspaceIds ?? []).map((id) => String(id)));
  return rows.filter((workspace) => allowed.has(workspace.id));
}

async function workspaceSelectionError(context: FunctionContext, grant: McpOAuthGrant, tool: string) {
  const rows = await grantedAccessibleWorkspaces(context, grant);
  return toolError('workspace_id_required', {
    tool,
    message:
      'Hanji hosted MCP is account-scoped. Choose one workspace from this list and pass its id as workspace_id. Notion-compatible teamspace_id is accepted as an alias.',
    required_argument: 'workspace_id',
    accepted_aliases: ['teamspace_id', 'workspaceId'],
    workspaces: rows.map((workspace) => ({
      id: workspace.id,
      workspace_id: workspace.id,
      teamspace_id: workspace.id,
      name: workspace.name ?? 'Untitled Workspace',
      domain: workspace.domain ?? null,
      icon: workspace.icon ?? null,
    })),
  });
}

async function requireWorkspaceArgument(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>, tool: string) {
  const workspaceId = selectedWorkspaceId(args);
  if (workspaceId) {
    const allowed = await grantedAccessibleWorkspaces(context, grant);
    if (allowed.some((workspace) => workspace.id === workspaceId)) return { workspaceId };
    return {
      error: toolError('workspace_not_allowed', {
        tool,
        workspace_id: workspaceId,
        message:
          'This MCP grant does not allow that workspace. Call list_workspaces or _notion_get_teams and use one of the returned ids.',
        allowed_workspace_ids: allowed.map((workspace) => workspace.id),
      }),
    };
  }
  return { error: await workspaceSelectionError(context, grant, tool) };
}

async function callNotionCompat(
  context: FunctionContext,
  grant: McpOAuthGrant,
  method: string,
  slug: string,
  body?: unknown,
  query?: Record<string, unknown>,
) {
  const urls = endpointUrls(context);
  const url = new URL(`${urls.origin}/api/functions/v1/${slug.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = new Headers({ Accept: 'application/json' });
  const init: RequestInit = { method };
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }
  init.headers = headers;
  const request = new Request(url.toString(), init);
  const response = await notionCompatHandler({
    request,
    env: context.env,
    auth: { id: grant.userId, email: null },
    params: { slug: slug.replace(/^\/+/, '') },
    admin: context.admin,
  });
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Keep text body for diagnostics.
  }
  if (!response.ok) {
    const message = isRecord(payload)
      ? textValue(payload.message ?? payload.error_description ?? payload.code, `HTTP ${response.status}`)
      : `HTTP ${response.status}: ${String(text).slice(0, 200)}`;
    throw new Error(message);
  }
  return payload;
}

async function callProductFunction(
  context: FunctionContext,
  grant: McpOAuthGrant,
  slug: string,
  body: Record<string, unknown>,
  handler: InternalFunctionHandler,
) {
  const invoke = typeof handler === 'function' ? handler : handler.handler;
  if (typeof invoke !== 'function') throw new Error('Internal product function handler is unavailable.');
  const urls = endpointUrls(context);
  const request = new Request(`${urls.origin}/api/functions/${slug.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await invoke({
    request,
    env: context.env,
    auth: { id: grant.userId, email: null },
    admin: context.admin,
  });
  if (!(result instanceof Response)) return result;
  const text = await result.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text body for diagnostics.
  }
  if (!result.ok) {
    const message = isRecord(payload)
      ? textValue(payload.message ?? payload.error_description ?? payload.code, `HTTP ${result.status}`)
      : `HTTP ${result.status}: ${String(text).slice(0, 200)}`;
    throw new Error(message);
  }
  return payload;
}

async function pageRecord(context: FunctionContext, id: string) {
  if (!id) return null;
  const db = await boundedDbForPage(context.admin, id);
  if (!db) return null;
  return await db.table<PageRecord>('pages').getOne(id).catch(() => null);
}

// Dormant-until-set consent narrowing: when the grant's pageIds/databaseIds
// allowlists are non-empty, every resource-targeted operation must stay inside
// them. A target qualifies when the page itself or any ancestor (parent pages,
// or the database that owns a row) is allowlisted. Empty lists keep the
// historical behavior: the grant is narrowed by workspace only.
function grantResourceAllowlist(grant: McpOAuthGrant): Set<string> | null {
  const ids = [...(grant.pageIds ?? []), ...(grant.databaseIds ?? [])]
    .map((id) => String(id).trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

async function pageWithinGrantAllowlist(context: FunctionContext, grant: McpOAuthGrant, page: PageRecord) {
  const allowlist = grantResourceAllowlist(grant);
  if (!allowlist) return true;
  const visited = new Set<string>();
  let current: PageRecord | null = page;
  while (current && !visited.has(current.id)) {
    if (allowlist.has(current.id)) return true;
    visited.add(current.id);
    const parentId = textValue(current.parentId);
    if (!parentId) break;
    current = await pageRecord(context, parentId);
  }
  return false;
}

async function requirePageInWorkspace(context: FunctionContext, grant: McpOAuthGrant, workspaceId: string, pageId: string, label: string) {
  const page = await pageRecord(context, pageId);
  // A live page in another workspace (or outside the grant's page/database
  // allowlist) must be indistinguishable from a missing one, otherwise this
  // error becomes an instance-wide page-existence oracle for grant holders
  // probing arbitrary UUIDs.
  if (!page || page.workspaceId !== workspaceId) throw new Error(`${label} was not found.`);
  if (!(await pageWithinGrantAllowlist(context, grant, page))) throw new Error(`${label} was not found.`);
  return page;
}

// Lenient scope guard for ids that may not resolve to a page (e.g. block ids):
// if the id DOES resolve to a page/database, it must belong to the grant's
// selected workspace; unresolvable ids fall through to the Notion-compat layer's
// own per-user access checks. This closes the cross-workspace hole for
// page/database targets without rejecting legitimate block-level operations.
async function assertResourceInSelectedWorkspace(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  id: string,
  label: string,
) {
  if (!id) return;
  const page = await pageRecord(context, id);
  if (!page) return;
  if (page.workspaceId !== workspaceId || !(await pageWithinGrantAllowlist(context, grant, page))) {
    // Same not-found shape as requirePageInWorkspace: no existence oracle.
    throw new Error(`${label} was not found.`);
  }
}

async function workspacePages(context: FunctionContext, workspaceId: string) {
  return await listAll(
    boundedDb(context.admin, workspaceId).table<PageRecord>('pages').where('workspaceId', '==', workspaceId),
  );
}

async function databaseProperties(context: FunctionContext, databaseId: string) {
  const db = (await boundedDbForPage(context.admin, databaseId)) ?? context.admin.db('app');
  return (await listAll(db.table<DbPropertyRecord>('db_properties').where('databaseId', '==', databaseId)))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

async function viewRecord(context: FunctionContext, viewId: string, workspaceIdHint?: string) {
  if (!viewId) return null;
  // Views are workspace content; the selected workspace routes the lookup.
  const db = workspaceIdHint
    ? boundedDb(context.admin, workspaceIdHint)
    : context.admin.db('app');
  return await db.table<DbViewRecord>('db_views').getOne(viewId).catch(() => null);
}

function publicAsyncTask(context: FunctionContext, task: McpAsyncTask) {
  const payload: Record<string, unknown> = {
    object: 'async_task',
    id: task.id,
    status: task.status ?? 'queued',
    status_url: `${endpointUrls(context).resource}/async_tasks/${encodeURIComponent(task.id)}`,
    created_time: task.createdAt ?? null,
    last_edited_time: task.updatedAt ?? task.completedAt ?? task.createdAt ?? null,
    poll_after_seconds: task.pollAfterSeconds ?? 1,
    operation: task.operation ?? { surface: 'mcp' },
  };
  if ((task.status ?? '') === 'succeeded') payload.result = task.result ?? null;
  if ((task.status ?? '') === 'failed') payload.error = task.error ?? { message: 'Async task failed.' };
  return payload;
}

async function recordAsyncTask(
  context: FunctionContext,
  grant: McpOAuthGrant,
  operationName: string,
  status: 'succeeded' | 'failed',
  payload: unknown,
) {
  const now = new Date().toISOString();
  const task = await context.admin.db('app').table<McpAsyncTask>('mcp_async_tasks').insert({
    grantId: grant.id,
    userId: grant.userId,
    clientId: grant.clientId,
    status,
    operation: { surface: 'mcp', name: operationName },
    result: status === 'succeeded' ? payload : undefined,
    error: status === 'failed' ? payload : undefined,
    pollAfterSeconds: 1,
    completedAt: now,
  });
  return publicAsyncTask(context, task);
}

async function runAsyncTask(
  context: FunctionContext,
  grant: McpOAuthGrant,
  operationName: string,
  run: () => Promise<unknown>,
) {
  try {
    const result = await run();
    return toolJson({ async_task: await recordAsyncTask(context, grant, operationName, 'succeeded', result) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolJson({
      async_task: await recordAsyncTask(context, grant, operationName, 'failed', {
        object: 'error',
        message,
      }),
    });
  }
}

async function getAsyncTask(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const taskId = textValue(args.task_id);
  if (!taskId) return toolError('task_id is required.');
  const task = await context.admin.db('app').table<McpAsyncTask>('mcp_async_tasks').getOne(taskId).catch(() => null);
  if (!task || task.grantId !== grant.id || task.userId !== grant.userId || task.clientId !== grant.clientId) {
    return toolError('async_task_not_found', { task_id: taskId });
  }
  return toolJson({ async_task: publicAsyncTask(context, task) });
}

function collectionIdFromInput(value: unknown) {
  const raw = textValue(value);
  if (!raw) return '';
  if (raw.startsWith('collection://')) return stripHanjiId(raw);
  return stripHanjiId(raw);
}

function richText(text: unknown) {
  return [{ type: 'text', text: { content: String(text ?? '') }, plain_text: String(text ?? '') }];
}

function simpleProperties(properties: unknown, fallbackTitle = 'Untitled') {
  if (isRecord(properties)) {
    const hasNotionShape = Object.values(properties).some((value) =>
      isRecord(value) && (
        Array.isArray(value.title) ||
        Array.isArray(value.rich_text) ||
        'select' in value ||
        'status' in value ||
        'number' in value ||
        'checkbox' in value
      ),
    );
    if (hasNotionShape) return properties;
    const title = textValue(properties.title ?? properties.Name ?? properties.name, fallbackTitle);
    return { Name: { title: richText(title) }, ...Object.fromEntries(
      Object.entries(properties)
        .filter(([key]) => !['title', 'Name', 'name'].includes(key))
        .map(([key, value]) => [key, { rich_text: richText(value) }]),
    ) };
  }
  return { Name: { title: richText(fallbackTitle) } };
}

function markdownishBlocks(markdown: unknown) {
  const text = String(markdown ?? '').trim();
  if (!text) return [];
  return text.split(/\n{2,}/g).map((chunk) => {
    const line = chunk.trim();
    if (/^###\s+/.test(line)) return { type: 'heading_3', heading_3: { rich_text: richText(line.replace(/^###\s+/, '')) } };
    if (/^##\s+/.test(line)) return { type: 'heading_2', heading_2: { rich_text: richText(line.replace(/^##\s+/, '')) } };
    if (/^#\s+/.test(line)) return { type: 'heading_1', heading_1: { rich_text: richText(line.replace(/^#\s+/, '')) } };
    if (/^- \[[ xX]\]\s+/.test(line)) {
      return {
        type: 'to_do',
        to_do: {
          rich_text: richText(line.replace(/^- \[[ xX]\]\s+/, '')),
          checked: /^- \[[xX]\]/.test(line),
        },
      };
    }
    if (/^[-*]\s+/.test(line)) return { type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(line.replace(/^[-*]\s+/, '')) } };
    return { type: 'paragraph', paragraph: { rich_text: richText(line) } };
  });
}

async function getTeams(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantScope(grant, ['workspace:read']);
  const query = textValue(args.query).toLowerCase();
  const workspaces = (await grantedAccessibleWorkspaces(context, grant))
    .filter((workspace) => !query || String(workspace.name ?? '').toLowerCase().includes(query))
    .map((workspace) => ({
      id: workspace.id,
      teamspace_id: workspace.id,
      workspace_id: workspace.id,
      name: workspace.name ?? workspace.domain ?? 'Untitled Workspace',
      type: 'workspace_as_teamspace',
      scope_model: 'hanji_account_workspace',
      membership_status: 'member',
    }));
  return toolJson({
    results: workspaces,
    joined: workspaces,
    available: [],
    has_more: false,
    provider_scope_model: 'hanji_account_accessible_workspaces',
    teamspace_id_alias: 'Hanji workspace_id',
  });
}

async function getUsers(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantScope(grant, ['workspace:read']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_get_users');
  if ('error' in selected) return selected.error;
  const payload = await callNotionCompat(context, grant, 'GET', 'users', undefined, {
    workspace_id: selected.workspaceId,
    start_cursor: args.start_cursor,
    page_size: args.page_size,
  });
  let results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  const query = textValue(args.query).toLowerCase();
  if (query) {
    results = results.filter((user) => JSON.stringify(user).toLowerCase().includes(query));
  }
  const userId = textValue(args.user_id);
  if (userId && userId !== 'self') results = results.filter((user) => isRecord(user) && user.id === userId);
  if (userId === 'self' && results.length) results = [results[0]];
  return toolJson({ ...(isRecord(payload) ? payload : {}), results });
}

async function searchNotion(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantScope(grant, ['pages:read', 'databases:read', 'workspace:read']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_search');
  if ('error' in selected) return selected.error;
  if (args.query_type === 'user') return getUsers(context, grant, { ...args, workspace_id: selected.workspaceId });
  const dataSourceId = collectionIdFromInput(args.data_source_url);
  if (dataSourceId) {
    // Same narrowing as queryDataSources: the caller-supplied data source must
    // live in the grant's selected workspace before the compat query runs.
    await requirePageInWorkspace(context, grant, selected.workspaceId, dataSourceId, 'Data source');
    const payload = await callNotionCompat(context, grant, 'POST', `data_sources/${dataSourceId}/query`, {
      query: args.query,
      filter: args.filters,
      page_size: pageSize(args.page_size, 10),
      start_cursor: args.start_cursor,
    });
    return toolJson({
      type: 'workspace_search',
      results: isRecord(payload) && Array.isArray(payload.results) ? payload.results : [],
      data_source_id: dataSourceId,
      scope: { provider: 'hanji', workspace_id: selected.workspaceId },
    });
  }
  const payload = await callNotionCompat(context, grant, 'POST', 'search', {
    query: args.query,
    workspace_id: selected.workspaceId,
    page_size: pageSize(args.page_size, 10),
    start_cursor: args.start_cursor,
    filter: isRecord(args.filters) ? args.filters : undefined,
  });
  return toolJson({
    type: 'workspace_search',
    ...(isRecord(payload) ? payload : { results: payload }),
    scope: {
      provider: 'hanji',
      access_model: 'account_accessible_workspaces',
      workspace_id: selected.workspaceId,
      requested_content_search_mode: args.content_search_mode ?? 'workspace_search',
      effective_content_search_mode: 'workspace_search',
      note: args.content_search_mode === 'ai_search'
        ? 'Hanji does not provide a separate Notion AI or connected-source search layer; searched Hanji workspace data.'
        : undefined,
    },
  });
}

async function fetchNotion(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantScope(grant, ['pages:read', 'databases:read']);
  if (textValue(args.id).toLowerCase() === 'self') {
    const explicit = selectedWorkspaceId(args);
    let workspaceId = explicit;
    if (!workspaceId) {
      const workspaces = await grantedAccessibleWorkspaces(context, grant);
      if (workspaces.length === 1) workspaceId = workspaces[0].id;
    }
    if (!workspaceId) return await workspaceSelectionError(context, grant, '_fetch');
    const selected = await requireWorkspaceArgument(context, grant, { workspace_id: workspaceId }, '_fetch');
    if ('error' in selected) return selected.error;
    const workspace = (await grantedAccessibleWorkspaces(context, grant)).find((item) => item.id === selected.workspaceId);
    const user = await callNotionCompat(context, grant, 'GET', 'users/me').catch(() => ({
      object: 'user',
      id: grant.userId,
      type: 'person',
      name: 'Hanji user',
      person: { email: null },
    }));
    return toolJson({
      self: {
        workspace: {
          id: selected.workspaceId,
          name: workspace?.name ?? workspace?.domain ?? 'Untitled Workspace',
        },
        user,
      },
      workspace_id: selected.workspaceId,
    });
  }
  const selected = await requireWorkspaceArgument(context, grant, args, '_fetch');
  if ('error' in selected) return selected.error;
  const id = stripHanjiId(args.id);
  if (!id) return toolError('id is required.');
  const rawId = textValue(args.id);
  if (/^collection:\/\//i.test(rawId)) {
    // The grant's selected workspace must own the data source; otherwise this
    // read escapes the 'selected' narrowing (the caller-supplied workspace_id
    // was validated, but the resource id was not).
    await requirePageInWorkspace(context, grant, selected.workspaceId, id, 'Data source');
    const dataSource = await callNotionCompat(context, grant, 'GET', `data_sources/${id}`);
    const views = await callNotionCompat(context, grant, 'GET', `data_sources/${id}/views`).catch(() => null);
    return toolJson({ metadata: { type: 'data_source', workspace_id: selected.workspaceId }, data_source: dataSource, views });
  }
  await assertResourceInSelectedWorkspace(context, grant, selected.workspaceId, id, 'Page');
  const page = await callNotionCompat(context, grant, 'GET', `pages/${id}`);
  const blocks = await callNotionCompat(context, grant, 'GET', `blocks/${id}/children`, undefined, { page_size: 100 }).catch(() => null);
  return toolJson({ metadata: { type: isRecord(page) ? page.object : 'page', workspace_id: selected.workspaceId }, page, blocks });
}

async function queryDataSources(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantScope(grant, ['databases:read', 'pages:read']);
  const data = isRecord(args.data) ? args.data : {};
  const selected = await requireWorkspaceArgument(context, grant, data, '_notion_query_data_sources');
  if ('error' in selected) return selected.error;
  const dataSourceId = collectionIdFromInput(
    data.data_source_id ??
    data.database_id ??
    data.data_source_url ??
    (Array.isArray(data.data_source_urls) ? data.data_source_urls[0] : undefined),
  );
  if (!dataSourceId && textValue(data.view_url)) {
    return toolError('data_source_id is required for hosted view queries. Pass the collection/data source id along with view_url.');
  }
  if (!dataSourceId) return toolError('data_source_id or data_source_url is required.');
  await requirePageInWorkspace(context, grant, selected.workspaceId, dataSourceId, 'Data source');
  const payload = await callNotionCompat(context, grant, 'POST', `data_sources/${dataSourceId}/query`, {
    query: data.query,
    filter: data.filter,
    sorts: data.sorts,
    start_cursor: data.start_cursor,
    page_size: pageSize(data.page_size, 100),
  });
  return toolJson({
    mode: data.mode ?? 'query',
    data_source_id: dataSourceId,
    data_source_url: `collection://${dataSourceId}`,
    ...(isRecord(payload) ? payload : { results: payload }),
  });
}

function localFilterToNotionFilter(props: DbPropertyRecord[], filter: unknown): Record<string, unknown> | null {
  if (!isRecord(filter)) return null;
  const propertyId = textValue(filter.propertyId ?? filter.property);
  const prop = props.find((item) => item.id === propertyId || item.name === propertyId);
  if (!prop) return null;
  const operator = textValue(filter.operator, 'equals');
  const condition: Record<string, unknown> = {};
  condition[operator] = filter.value ?? true;
  return {
    property: prop.name,
    rich_text: condition,
  };
}

function localFilterGroupToNotionFilter(props: DbPropertyRecord[], group: unknown): Record<string, unknown> | undefined {
  if (!isRecord(group)) return undefined;
  const filters = Array.isArray(group.filters)
    ? group.filters.map((filter) => localFilterToNotionFilter(props, filter)).filter(Boolean)
    : [];
  const groups = Array.isArray(group.groups)
    ? group.groups.map((subgroup) => localFilterGroupToNotionFilter(props, subgroup)).filter(Boolean)
    : [];
  const terms = [...filters, ...groups] as Record<string, unknown>[];
  if (!terms.length) return undefined;
  return group.conjunction === 'or' ? { or: terms } : { and: terms };
}

function localViewFiltersToNotion(props: DbPropertyRecord[], config: Record<string, unknown>) {
  if (config.filterGroup !== undefined) return localFilterGroupToNotionFilter(props, config.filterGroup);
  const filters = Array.isArray(config.filters)
    ? config.filters.map((filter) => localFilterToNotionFilter(props, filter)).filter(Boolean)
    : [];
  if (!filters.length) return undefined;
  return config.filterConjunction === 'or' ? { or: filters } : { and: filters };
}

function localViewSortsToNotion(props: DbPropertyRecord[], config: Record<string, unknown>) {
  if (!Array.isArray(config.sorts)) return undefined;
  const sorts = config.sorts
    .filter(isRecord)
    .map((sort) => {
      const propertyId = textValue(sort.propertyId ?? sort.property);
      const prop = props.find((item) => item.id === propertyId || item.name === propertyId);
      if (!prop) return null;
      const direction = textValue(sort.direction).toLowerCase();
      return {
        property: prop.name,
        direction: direction === 'desc' || direction === 'descending' ? 'descending' : 'ascending',
      };
    })
    .filter(Boolean);
  return sorts.length ? sorts : undefined;
}

async function queryDatabaseView(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantScope(grant, ['databases:read', 'pages:read']);
  const data = isRecord(args.data) ? args.data : args;
  const selected = await requireWorkspaceArgument(context, grant, data, 'notion-query-database-view');
  if ('error' in selected) return selected.error;
  const viewId = stripHanjiId(data.view_id ?? data.view_url ?? data.database_view_url);
  if (!viewId) return toolError('view_id or view_url is required.');
  const view = await viewRecord(context, viewId, selected.workspaceId);
  if (!view) return toolError('view_not_found', { view_id: viewId });
  const database = await requirePageInWorkspace(context, grant, selected.workspaceId, view.databaseId, 'Data source');
  if (database.kind !== 'database') return toolError('view_data_source_not_found', { view_id: viewId });
  const props = await databaseProperties(context, database.id);
  const config = isRecord(view.config) ? view.config : {};
  const payload = await callNotionCompat(context, grant, 'POST', `data_sources/${database.id}/query`, {
    query: data.query ?? config.search,
    filter: data.filter ?? localViewFiltersToNotion(props, config),
    sorts: data.sorts ?? localViewSortsToNotion(props, config),
    start_cursor: data.start_cursor,
    page_size: pageSize(data.page_size, 100),
  });
  return toolJson({
    mode: 'view',
    view_id: view.id,
    view_url: `view://${view.id}`,
    data_source_id: database.id,
    data_source_url: `collection://${database.id}`,
    view: {
      object: 'view',
      id: view.id,
      data_source_id: database.id,
      name: view.name ?? 'Untitled view',
      type: view.type ?? 'table',
      config,
    },
    ...(isRecord(payload) ? payload : { results: payload }),
  });
}

async function createPages(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantWrite(grant, ['pages:write', 'databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_create_pages');
  if ('error' in selected) return selected.error;
  const run = async () => {
    const pages = Array.isArray(args.pages) ? args.pages.filter(isRecord).slice(0, 25) : [];
    if (!pages.length) throw new Error('pages must contain at least one page.');
    const parent = isRecord(args.parent) ? args.parent : { workspace_id: selected.workspaceId };
    // A caller-supplied parent page/database must live in the selected workspace,
    // else pages get written outside the grant's narrowed scope.
    const parentRecord = isRecord(args.parent) ? args.parent : null;
    const parentTargetId = parentRecord
      ? stripHanjiId(parentRecord.page_id ?? parentRecord.database_id ?? parentRecord.pageId ?? parentRecord.databaseId)
      : '';
    if (parentTargetId) {
      await requirePageInWorkspace(context, grant, selected.workspaceId, parentTargetId, 'Parent');
    }
    const created = [];
    for (const pageInput of pages) {
      const title = textValue(
        isRecord(pageInput.properties) ? pageInput.properties.title ?? pageInput.properties.Name ?? pageInput.properties.name : undefined,
        'Untitled',
      );
      const payload = await callNotionCompat(context, grant, 'POST', 'pages', {
        workspace_id: selected.workspaceId,
        parent: { workspace_id: selected.workspaceId, ...parent },
        properties: simpleProperties(pageInput.properties, title),
        icon: textValue(pageInput.icon) ? { type: 'emoji', emoji: textValue(pageInput.icon) } : undefined,
        cover: textValue(pageInput.cover) ? { external: { url: textValue(pageInput.cover) } } : undefined,
        children: markdownishBlocks(pageInput.content),
        template: pageInput.template_id ? { type: 'template_id', template_id: pageInput.template_id } : undefined,
      });
      created.push(payload);
    }
    return { pages: created };
  };
  if (args.allow_async === true) return await runAsyncTask(context, grant, 'create_pages', run);
  return toolJson(await run());
}

async function updatePage(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantWrite(grant, ['pages:write', 'databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_update_page');
  if ('error' in selected) return selected.error;
  const run = async () => {
    const pageId = stripHanjiId(args.page_id ?? args.pageId);
    if (!pageId) throw new Error('page_id is required.');
    // The target page must belong to the grant's selected workspace; the
    // workspace_id argument alone does not scope the page id.
    await requirePageInWorkspace(context, grant, selected.workspaceId, pageId, 'Page');
    const command = textValue(args.command, args.content || args.new_str ? 'insert_content' : 'update_properties');
    if (command === 'insert_content') {
      const content = args.content ?? args.new_str;
      return await callNotionCompat(context, grant, 'PATCH', `blocks/${pageId}/children`, {
        children: markdownishBlocks(content),
      });
    }
    if (command === 'replace_content') {
      await callNotionCompat(context, grant, 'PATCH', `pages/${pageId}`, { erase_content: true });
      return await callNotionCompat(context, grant, 'PATCH', `blocks/${pageId}/children`, {
        children: markdownishBlocks(args.new_str ?? args.content),
      });
    }
    const patch: Record<string, unknown> = {};
    if (args.properties !== undefined || args.title !== undefined) {
      patch.properties = args.properties !== undefined ? simpleProperties(args.properties, textValue(args.title, 'Untitled')) : simpleProperties({ title: args.title }, textValue(args.title, 'Untitled'));
    }
    if (args.icon !== undefined) patch.icon = textValue(args.icon) ? { type: 'emoji', emoji: textValue(args.icon) } : null;
    if (args.cover !== undefined) patch.cover = textValue(args.cover) ? { external: { url: textValue(args.cover) } } : null;
    if (args.locked !== undefined) patch.is_locked = args.locked === true;
    if (command === 'apply_template' && args.template_id) patch.template = { type: 'template_id', template_id: args.template_id };
    return await callNotionCompat(context, grant, 'PATCH', `pages/${pageId}`, patch);
  };
  if (args.allow_async === true) return await runAsyncTask(context, grant, 'update_page', run);
  return toolJson(await run());
}

async function duplicatePage(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>, forceAsync = false) {
  requireGrantWrite(grant, ['pages:write', 'databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_duplicate_page');
  if ('error' in selected) return selected.error;
  const pageId = stripHanjiId(args.pageId ?? args.page_id);
  if (!pageId) return toolError('pageId or page_id is required.');
  const source = await requirePageInWorkspace(context, grant, selected.workspaceId, pageId, 'Source page');

  const hasDestination =
    args.parentId !== undefined ||
    args.parent_id !== undefined ||
    args.parentType !== undefined ||
    args.parent_type !== undefined;
  const parentId = stripHanjiId(args.parentId ?? args.parent_id) || null;
  const parentType = normalizeParentType(args.parentType ?? args.parent_type, parentId);
  if (hasDestination && parentId) {
    await requirePageInWorkspace(context, grant, selected.workspaceId, parentId, 'Destination parent');
  }

  const body: Record<string, unknown> = {
    action: 'duplicate',
    pageId,
  };
  if (args.title !== undefined) body.title = textValue(args.title, `${titleOf(source)} copy`);
  if (hasDestination) {
    body.parentId = parentId;
    body.parentType = parentType;
  }

  const run = async () => {
    const payload = await callProductFunction(
      context,
      grant,
      'duplicate-page',
      body,
      duplicatePageHandler as InternalFunctionHandler,
    );
    return {
      ...(isRecord(payload) ? payload : { result: payload }),
      workspace_id: selected.workspaceId,
    };
  };
  if (forceAsync || args.allow_async === true) return await runAsyncTask(context, grant, 'duplicate_page', run);
  return toolJson(await run());
}

function moveIds(args: Record<string, unknown>) {
  const raw = Array.isArray(args.page_or_database_ids)
    ? args.page_or_database_ids
    : Array.isArray(args.page_ids)
      ? args.page_ids
      : args.page_id
        ? [args.page_id]
        : [];
  return raw.map(stripHanjiId).filter(Boolean);
}

function moveDestination(args: Record<string, unknown>) {
  const destination = isRecord(args.new_parent)
    ? args.new_parent
    : isRecord(args.parent)
      ? args.parent
      : {};
  const databaseId = stripHanjiId(destination.data_source_id ?? destination.database_id);
  const parentPageId = stripHanjiId(destination.page_id ?? destination.parent_page_id);
  const parentId = databaseId || parentPageId || null;
  const parentType = normalizeParentType(destination.type ?? (databaseId ? 'database' : undefined), parentId);
  return { parentId, parentType };
}

async function movePages(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantWrite(grant, ['pages:write', 'databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_move_pages');
  if ('error' in selected) return selected.error;
  const ids = moveIds(args);
  if (!ids.length) return toolError('Provide page_or_database_ids, page_ids, or page_id.');

  const { parentId, parentType } = moveDestination(args);
  if (parentId) await requirePageInWorkspace(context, grant, selected.workspaceId, parentId, 'Destination parent');
  const pages = await workspacePages(context, selected.workspaceId);
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const afterPageId = stripHanjiId(args.after_page_id);
  const beforePageId = stripHanjiId(args.before_page_id);
  const moved = [];
  const notFound = [];

  for (const id of ids) {
    const page = pagesById.get(id);
    // A page living in another workspace, or outside the grant's page/database
    // allowlist, must be indistinguishable from a missing one (no existence
    // oracle), so all three cases land in not_found.
    if (!page || !(await pageWithinGrantAllowlist(context, grant, page))) {
      notFound.push(id);
      continue;
    }
    const siblings = siblingPages(pages, parentId, parentType, id);
    const after = afterPageId ? siblings.find((item) => item.id === afterPageId) : undefined;
    const before = beforePageId ? siblings.find((item) => item.id === beforePageId) : undefined;
    if (afterPageId && !after) throw new Error(`after_page_id ${afterPageId} is not a destination sibling.`);
    if (beforePageId && !before) throw new Error(`before_page_id ${beforePageId} is not a destination sibling.`);
    if (after && before && (after.position ?? 0) >= (before.position ?? 0)) {
      throw new Error('after_page_id must come before before_page_id.');
    }
    const position =
      after || before
        ? positionBetween(after?.position, before?.position)
        : positionBetween(siblings[siblings.length - 1]?.position, undefined);
    const payload = await callProductFunction(
      context,
      grant,
      'page-mutation',
      {
        action: 'move',
        id,
        patch: {
          parentId,
          parentType,
          position,
        },
      },
      pageMutationHandler as InternalFunctionHandler,
    );
    const updated = isRecord(payload) && isRecord(payload.page)
      ? payload.page as unknown as PageRecord
      : page;
    pagesById.set(id, updated);
    const index = pages.findIndex((item) => item.id === id);
    if (index >= 0) pages[index] = updated;
    moved.push({
      id: updated.id,
      title: titleOf(updated),
      parent: parentType === 'workspace' ? { type: 'workspace' } : { type: parentType, id: parentId },
      position,
    });
  }

  return toolJson({
    moved,
    not_found: notFound,
    workspace_id: selected.workspaceId,
  });
}

async function createDatabase(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantWrite(grant, ['databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_create_database');
  if ('error' in selected) return selected.error;
  const title = textValue(args.title ?? args.name);
  const createParent = isRecord(args.parent) ? args.parent : undefined;
  const createParentId = createParent
    ? stripHanjiId(createParent.page_id ?? createParent.database_id ?? createParent.pageId ?? createParent.databaseId)
    : '';
  if (createParentId) {
    await requirePageInWorkspace(context, grant, selected.workspaceId, createParentId, 'Parent');
  }
  const payload = await callNotionCompat(context, grant, 'POST', 'databases', {
    workspace_id: selected.workspaceId,
    parent: isRecord(args.parent) ? { workspace_id: selected.workspaceId, ...args.parent } : { workspace_id: selected.workspaceId },
    title: richText(title),
    properties: isRecord(args.properties) ? args.properties : undefined,
    initial_data_source: isRecord(args.initial_data_source) ? args.initial_data_source : undefined,
  });
  return toolJson(payload);
}

async function updateDataSource(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantWrite(grant, ['databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_update_data_source');
  if ('error' in selected) return selected.error;
  const dataSourceId = collectionIdFromInput(args.data_source_id ?? args.database_id ?? args.data_source_url);
  if (!dataSourceId) return toolError('data_source_id is required.');
  await requirePageInWorkspace(context, grant, selected.workspaceId, dataSourceId, 'Data source');
  const payload = await callNotionCompat(context, grant, 'PATCH', `data_sources/${dataSourceId}`, {
    name: args.name,
    title: args.title ? richText(args.title) : undefined,
    properties: args.properties,
    archived: args.archived,
    in_trash: args.in_trash,
  });
  return toolJson(payload);
}

async function commentsTool(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>, mode: 'list' | 'create') {
  requireGrantScope(grant, mode === 'create' ? ['comments:write'] : ['comments:read']);
  if (mode === 'create') requireGrantWrite(grant, ['comments:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, mode === 'create' ? '_notion_create_comment' : '_notion_get_comments');
  if ('error' in selected) return selected.error;
  // A page target must be inside the selected workspace; block-only targets fall
  // through to the compat layer's per-user access checks.
  await assertResourceInSelectedWorkspace(context, grant, selected.workspaceId, stripHanjiId(args.page_id), 'Page');
  await assertResourceInSelectedWorkspace(context, grant, selected.workspaceId, stripHanjiId(args.block_id), 'Block');
  if (mode === 'list') {
    const payload = await callNotionCompat(context, grant, 'GET', 'comments', undefined, {
      page_id: stripHanjiId(args.page_id),
      block_id: stripHanjiId(args.block_id),
      start_cursor: args.start_cursor,
      page_size: args.page_size,
    });
    return toolJson(payload);
  }
  const parent = stripHanjiId(args.block_id)
    ? { block_id: stripHanjiId(args.block_id) }
    : { page_id: stripHanjiId(args.page_id) };
  const rich = Array.isArray(args.rich_text) ? args.rich_text : richText(args.text ?? '');
  const payload = await callNotionCompat(context, grant, 'POST', 'comments', { parent, rich_text: rich });
  return toolJson(payload);
}

async function createView(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantWrite(grant, ['databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_create_view');
  if ('error' in selected) return selected.error;
  const dataSourceId = collectionIdFromInput(args.data_source_id ?? args.database_id ?? args.data_source_url);
  if (!dataSourceId) return toolError('data_source_id is required.');
  await requirePageInWorkspace(context, grant, selected.workspaceId, dataSourceId, 'Data source');
  const type = textValue(args.type, 'table');
  const payload = await callNotionCompat(context, grant, 'POST', `data_sources/${dataSourceId}/views`, {
    name: textValue(args.name, `${type[0]?.toUpperCase() ?? 'T'}${type.slice(1)}`),
    type,
    config: isRecord(args.config) ? args.config : undefined,
    [type]: isRecord(args[type]) ? args[type] : undefined,
  });
  return toolJson(payload);
}

async function updateView(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantWrite(grant, ['databases:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_update_view');
  if ('error' in selected) return selected.error;
  const viewId = stripHanjiId(args.view_id);
  if (!viewId) return toolError('view_id is required.');
  // Resolve the view within the selected workspace (the lookup is workspace-
  // scoped) and confirm its data source belongs there before mutating it.
  const view = await viewRecord(context, viewId, selected.workspaceId);
  if (!view) return toolError('view_not_found', { view_id: viewId });
  await requirePageInWorkspace(context, grant, selected.workspaceId, view.databaseId, 'Data source');
  const type = textValue(args.type);
  const payload = await callNotionCompat(context, grant, 'PATCH', `views/${viewId}`, {
    workspace_id: selected.workspaceId,
    name: args.name,
    type: type || undefined,
    config: isRecord(args.config) ? args.config : undefined,
    ...(type && isRecord(args[type]) ? { [type]: args[type] } : {}),
  });
  return toolJson(payload);
}

function normalizedToolName(name: string | undefined) {
  const raw = textValue(name);
  const aliases: Record<string, string> = {
    'notion-search': '_search',
    'notion-fetch': '_fetch',
    'notion-query-data-sources': '_notion_query_data_sources',
    'notion-query-database-view': '_notion_query_database_view',
    'notion-create-pages': '_notion_create_pages',
    'notion-update-page': '_notion_update_page',
    'notion-duplicate-page': '_notion_duplicate_page_async',
    'notion-move-pages': '_notion_move_pages',
    'notion-create-database': '_notion_create_database',
    'notion-update-data-source': '_notion_update_data_source',
    'notion-get-comments': '_notion_get_comments',
    'notion-create-comment': '_notion_create_comment',
    'notion-create-view': '_notion_create_view',
    'notion-update-view': '_notion_update_view',
    'notion-query-meeting-notes': '_notion_query_meeting_notes',
    'notion-get-teams': '_notion_get_teams',
    'notion-get-users': '_notion_get_users',
    'notion-get-async-task': '_notion_get_async_task',
  };
  return aliases[raw] ?? raw;
}

async function callTool(context: FunctionContext, grant: McpOAuthGrant, name: string | undefined, args: Record<string, unknown> = {}) {
  const toolName = normalizedToolName(name);
  if (name === 'get_mcp_access_policy') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            hosted: true,
            grant: publicGrant(grant),
            serverUrl: endpointUrls(context).resource,
          }, null, 2),
        },
      ],
      structuredContent: {
        hosted: true,
        grant: publicGrant(grant),
        serverUrl: endpointUrls(context).resource,
      },
    };
  }
  try {
    if (toolName === 'list_workspaces') {
      // Same scope requirement as its _notion_get_teams alias.
      requireGrantScope(grant, ['workspace:read']);
      const workspaces = await grantedAccessibleWorkspaces(context, grant);
      const rows = workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name ?? 'Untitled Workspace',
        domain: workspace.domain ?? null,
        icon: workspace.icon ?? null,
      }));
      return {
        content: [
          {
            type: 'text',
            text: rows.length
              ? rows.map((workspace) => `- ${workspace.name} (${workspace.id})`).join('\n')
              : 'No accessible workspaces.',
          },
        ],
        structuredContent: { workspaces: rows },
      };
    }
    if (toolName === '_notion_get_teams') return await getTeams(context, grant, args);
    if (toolName === '_notion_get_users' || toolName === 'get_users') return await getUsers(context, grant, args);
    if (toolName === 'search' || toolName === '_search') return await searchNotion(context, grant, args);
    if (toolName === 'fetch' || toolName === '_fetch') return await fetchNotion(context, grant, args);
    if (toolName === '_notion_query_data_sources') return await queryDataSources(context, grant, args);
    if (toolName === '_notion_query_database_view') return await queryDatabaseView(context, grant, args);
    if (toolName === '_notion_create_pages' || toolName === 'create_pages') return await createPages(context, grant, args);
    if (toolName === '_notion_update_page' || toolName === 'update_page') return await updatePage(context, grant, args);
    if (toolName === '_notion_duplicate_page_async') return await duplicatePage(context, grant, args, true);
    if (toolName === '_notion_duplicate_page' || toolName === 'duplicate_page') return await duplicatePage(context, grant, args);
    if (toolName === '_notion_move_pages' || toolName === 'move_pages') return await movePages(context, grant, args);
    if (toolName === '_notion_create_database') return await createDatabase(context, grant, args);
    if (toolName === '_notion_update_data_source') return await updateDataSource(context, grant, args);
    if (toolName === '_notion_get_comments') return await commentsTool(context, grant, args, 'list');
    if (toolName === '_notion_create_comment') return await commentsTool(context, grant, args, 'create');
    if (toolName === '_notion_create_view') return await createView(context, grant, args);
    if (toolName === '_notion_update_view') return await updateView(context, grant, args);
    if (toolName === '_notion_get_async_task') return await getAsyncTask(context, grant, args);
    if (toolName === '_notion_query_meeting_notes') {
      const selected = await requireWorkspaceArgument(context, grant, args, '_notion_query_meeting_notes');
      if ('error' in selected) return selected.error;
      return toolJson({
        results: [],
        has_more: false,
        next_cursor: null,
        is_unsupported: true,
        unsupported_feature: 'notion_ai_meeting_notes',
        workspace_id: selected.workspaceId,
        message: 'Hanji does not provide a separate Notion AI meeting-notes data source. Use normal page/database search or an Hanji database dedicated to meetings.',
      });
    }
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Unsupported hosted MCP tool: ${name || '(missing)'}. The stdio MCP server still exposes the full local tool set; hosted OAuth transport is being rolled out incrementally.`,
      },
    ],
  };
}

function compatibilityReport(context: FunctionContext, grant: McpOAuthGrant) {
  return [
    '# Hanji Hosted MCP Compatibility Report',
    '',
    'Transport: Streamable HTTP-compatible JSON-RPC endpoint.',
    'Authorization: OAuth authorization-code + PKCE with scoped Hanji MCP grants.',
    `Resource: ${endpointUrls(context).resource}`,
    `Grant: ${grant.id}`,
    '',
    'Hosted tool coverage now includes the current official Notion MCP-style surface for shared Hanji concepts: notion-search/fetch/create-pages/update-page/move-pages/duplicate-page/create-database/update-data-source/create-view/update-view/query-data-sources/query-database-view/query-meeting-notes/create-comment/get-comments/get-teams/get-users/get-async-task, plus OpenAI-compatible search/fetch aliases and legacy underscore aliases.',
    '',
    'Hanji differs from Notion in one important way: this OAuth connection can be account-scoped, so workspace-bound tools require an explicit `workspace_id`. Notion-compatible `teamspace_id` is accepted as an alias for the Hanji workspace id. Notion AI-only connected-source and meeting-notes behavior returns explicit fallback/unsupported metadata instead of being simulated.',
  ].join('\n');
}

function enhancedMarkdownSpec() {
  return [
    '# Hanji Notion-Compatible Markdown',
    '',
    'Hosted MCP accepts a practical Markdown-ish subset for page body tools. Headings, paragraphs, bullet lines, and to-do lines are converted to Notion-compatible block payloads before reaching the product API.',
    '',
    'Supported reference styles in fetch results include page/database/data-source JSON objects and collection URLs such as `collection://<database-id>`.',
    '',
    'Hanji intentionally does not claim support for Notion AI-only or connected-source syntax. Those calls return explicit fallback or unsupported responses.',
  ].join('\n');
}

function viewDslSpec() {
  return [
    '# Hanji Notion-Compatible View DSL',
    '',
    'Hosted MCP view tools route through the Notion-compatible REST facade. Supported product view types are table, board, list, gallery, calendar, and timeline.',
    '',
    'For exact view configuration, pass the same JSON config fields accepted by Hanji database views through `_notion_create_view` or `_notion_update_view`.',
  ].join('\n');
}

async function handleRpc(context: FunctionContext, request: JsonRpcRequest, grant: McpOAuthGrant) {
  const method = request.method ?? '';
  if (!request.id && method.startsWith('notifications/')) return null;
  if (method === 'initialize') {
    return rpcResult(request.id, {
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: 'hanji-hosted-mcp',
        version: '0.1.0',
      },
      instructions:
        'Hanji hosted MCP is account-scoped. Call list_workspaces or _notion_get_teams first and pass an explicit workspace_id or teamspace_id to workspace-bound Notion-compatible tools.',
    });
  }
  if (method === 'ping') return rpcResult(request.id, {});
  if (method === 'tools/list') return rpcResult(request.id, await toolList());
  if (method === 'tools/call') {
    const name = typeof request.params?.name === 'string' ? request.params.name : undefined;
    const args = isRecord(request.params?.arguments) ? request.params.arguments : {};
    return rpcResult(request.id, await callTool(context, grant, name, args));
  }
  if (method === 'resources/list') {
    return rpcResult(request.id, {
      resources: [
        {
          uri: ENHANCED_MARKDOWN_URI,
          name: 'hanji-enhanced-markdown-spec',
          title: 'Hanji Notion-compatible Markdown',
          mimeType: 'text/markdown',
        },
        {
          uri: VIEW_DSL_URI,
          name: 'hanji-view-dsl-spec',
          title: 'Hanji Notion-compatible View DSL',
          mimeType: 'text/markdown',
        },
        {
          uri: COMPATIBILITY_REPORT_URI,
          name: 'hanji-hosted-mcp-compatibility-report',
          title: 'Hanji hosted MCP compatibility report',
          mimeType: 'text/markdown',
        },
      ],
    });
  }
  if (method === 'resources/read') {
    const uri = typeof request.params?.uri === 'string' ? request.params.uri : '';
    const text =
      uri === COMPATIBILITY_REPORT_URI
        ? compatibilityReport(context, grant)
        : uri === ENHANCED_MARKDOWN_URI
          ? enhancedMarkdownSpec()
          : uri === VIEW_DSL_URI
            ? viewDslSpec()
            : null;
    if (!text) return rpcError(request.id, -32004, 'Resource not found.');
    return rpcResult(request.id, {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text,
        },
      ],
    });
  }
  return rpcError(request.id, -32601, `Unsupported MCP method: ${method}`);
}

export const OPTIONS = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  return optionsResponse(context.request);
});

export const GET = defineFunction({
  trigger: { type: 'http' },
  customBearerAuth: true,
  handler: async (rawContext: unknown) => {
    const context = rawContext as FunctionContext;
    try {
      const auth = await authenticatedGrant(context);
      if (!auth) return unauthorized(context);
      return json(
        {
          ok: true,
          server: 'hanji-hosted-mcp',
          resource: endpointUrls(context).resource,
        },
        { headers: mcpHeaders(context.request) },
      );
    } catch {
      return unauthorized(context);
    }
  },
});

export const POST = defineFunction({
  trigger: { type: 'http' },
  customBearerAuth: true,
  handler: async (rawContext: unknown) => {
    const context = rawContext as FunctionContext;
    let auth: Awaited<ReturnType<typeof authenticatedGrant>> = null;
    try {
      auth = await authenticatedGrant(context);
    } catch {
      return unauthorized(context);
    }
    if (!auth) return unauthorized(context);
    const body = await context.request.json().catch(() => null);
    const requests = Array.isArray(body) ? body : [body];
    if (!requests.length || requests.some((item) => !item || typeof item !== 'object')) {
      return json(rpcError(null, -32700, 'Invalid JSON-RPC request.'), {
        status: 400,
        headers: mcpHeaders(context.request),
      });
    }
    const responses = [];
    for (const item of requests) {
      const response = await handleRpc(context, item as JsonRpcRequest, auth.grant);
      if (response) responses.push(response);
    }
    if (!responses.length) {
      return new Response(null, { status: 202, headers: mcpHeaders(context.request) });
    }
    return json(Array.isArray(body) ? responses : responses[0], {
      headers: mcpHeaders(context.request),
    });
  },
});
