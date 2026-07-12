import { defineFunction } from '@edge-base/shared';
import { boundedDb, boundedDbForPage } from '../lib/workspace-db';
import { bestEffort } from '../lib/table-utils';
import { POST as duplicatePageHandler } from './duplicate-page';
import { notionCompatHandler } from './notion/v1/[...slug]';
import { POST as pageMutationHandler } from './page-mutation';
import {
  type DbRef,
  type McpOAuthGrant,
  authorizationChallenge,
  bearerToken,
  corsHeaders,
  endpointUrls,
  grantAccessibleWorkspaces,
  grantIsActive,
  json,
  listAll,
  optionsResponse,
  publicGrant,
  revokeMcpGrantFamily,
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
type ContentScopeFamily = 'pages' | 'databases';
type ContentScopeAccess = 'read' | 'write';

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

interface BlockRecord {
  id: string;
  pageId: string;
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

interface DbTemplateRecord {
  id: string;
  databaseId: string;
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

export const MAX_MCP_JSON_RPC_BATCH_ITEMS = 50;
export const MAX_MCP_MOVE_PAGE_IDS = 50;
export const MAX_MCP_CREATE_PAGES = 25;
export const MAX_MCP_REQUEST_JSON_DEPTH = 32;
export const MAX_MCP_REQUEST_JSON_NODES = 100_000;
export const MAX_MCP_MARKDOWN_BYTES = 256 * 1024;
export const MAX_MCP_MARKDOWN_BLOCKS = 1_000;
export const MAX_MCP_COMMENT_RICH_TEXT_ITEMS = 100;
export const MAX_MCP_COMMENT_TEXT_BYTES = 256 * 1024;
export const MAX_MCP_COMMENT_RICH_TEXT_JSON_BYTES = 768 * 1024;

const COMPATIBILITY_REPORT_URI = 'notion://docs/mcp-compatibility-report';
const ENHANCED_MARKDOWN_URI = 'notion://docs/enhanced-markdown-spec';
const VIEW_DSL_URI = 'notion://docs/view-dsl-spec';
const HOSTED_SCOPE_POLICY = {
  directory: {
    scope: 'workspace:read',
    operations: ['workspace listing', 'team listing', 'user search', 'fetch self'],
    authorizes_content: false,
  },
  semantic_content: {
    normal_page: { read: 'pages:read', write: 'pages:write' },
    database_page: { read: 'databases:read', write: 'databases:write' },
    database_row: { read: 'databases:read', write: 'databases:write' },
  },
  mixed_search: { required: ['pages:read', 'databases:read'] },
  data_source_search_query_view: { required: ['databases:read'] },
  duplicate: {
    source: 'read scopes for every semantic family in the source subtree',
    destination: 'write scopes for every output and destination semantic family',
  },
  move: {
    required: 'write scopes for every source, resulting, and destination semantic family',
    write_only_response_includes_title: false,
  },
  write_implies_read: false,
} as const;

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

const mcpUtf8Encoder = new TextEncoder();

function boundedMcpUtf8Bytes(value: string, maxBytes: number, label: string) {
  if (value.length > maxBytes) throw new Error(`${label} must be at most ${maxBytes} UTF-8 bytes.`);
  const bytes = mcpUtf8Encoder.encode(value).byteLength;
  if (bytes > maxBytes) throw new Error(`${label} must be at most ${maxBytes} UTF-8 bytes.`);
  return bytes;
}

export function assertMcpRequestJsonShape(value: unknown) {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > MAX_MCP_REQUEST_JSON_DEPTH) {
      throw new Error(`JSON-RPC request must be at most ${MAX_MCP_REQUEST_JSON_DEPTH} levels deep.`);
    }
    nodes += 1;
    if (nodes > MAX_MCP_REQUEST_JSON_NODES) {
      throw new Error(`JSON-RPC request must contain at most ${MAX_MCP_REQUEST_JSON_NODES} JSON nodes.`);
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) throw new Error('JSON-RPC request must be an acyclic JSON value.');
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_MCP_REQUEST_JSON_NODES - nodes - stack.length) {
        throw new Error(`JSON-RPC request must contain at most ${MAX_MCP_REQUEST_JSON_NODES} JSON nodes.`);
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ depth: current.depth + 1, value: current.value[index] });
      }
      continue;
    }
    let childCount = 0;
    const record = current.value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      childCount += 1;
      if (childCount > MAX_MCP_REQUEST_JSON_NODES - nodes - stack.length) {
        throw new Error(`JSON-RPC request must contain at most ${MAX_MCP_REQUEST_JSON_NODES} JSON nodes.`);
      }
      stack.push({ depth: current.depth + 1, value: record[key] });
    }
  }
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

function hasAllScopes(grant: McpOAuthGrant, scopes: string[]) {
  const current = grantScopes(grant);
  return scopes.every((scope) => current.has(scope));
}

function requireGrantScope(grant: McpOAuthGrant, scopes: string[]) {
  if (!hasScope(grant, scopes)) {
    throw new Error(`This MCP grant does not include the required scope (${scopes.join(' or ')}).`);
  }
}

function requireAllGrantScopes(grant: McpOAuthGrant, scopes: string[]) {
  const unique = Array.from(new Set(scopes));
  if (!hasAllScopes(grant, unique)) {
    throw new Error(`This MCP grant does not include all required scopes (${unique.join(' and ')}).`);
  }
}

function requireGrantWrite(grant: McpOAuthGrant, scopes: string[]) {
  if (grant.readOnly === true) throw new Error('This MCP grant is read-only.');
  requireGrantScope(grant, scopes);
}

function requireAllGrantWriteScopes(grant: McpOAuthGrant, scopes: string[]) {
  if (grant.readOnly === true) throw new Error('This MCP grant is read-only.');
  requireAllGrantScopes(grant, scopes);
}

// A database page and every direct database row are database content even
// though rows are represented by page records. All other page records use the
// page scope family. Keep this decision in one place so a caller cannot choose
// its scope by changing an argument alias or parent_type string.
function contentScopeFamily(page: PageRecord): ContentScopeFamily {
  return page.kind === 'database' || page.parentType === 'database'
    ? 'databases'
    : 'pages';
}

function contentScopeName(family: ContentScopeFamily, access: ContentScopeAccess) {
  return `${family}:${access}`;
}

function requireContentScope(
  grant: McpOAuthGrant,
  page: PageRecord,
  access: ContentScopeAccess,
) {
  const scope = contentScopeName(contentScopeFamily(page), access);
  if (access === 'write') requireGrantWrite(grant, [scope]);
  else requireGrantScope(grant, [scope]);
}

function requireContentFamilies(
  grant: McpOAuthGrant,
  families: Iterable<ContentScopeFamily>,
  access: ContentScopeAccess,
) {
  const scopes = Array.from(new Set(families), (family) => contentScopeName(family, access));
  if (access === 'write') requireAllGrantWriteScopes(grant, scopes);
  else requireAllGrantScopes(grant, scopes);
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

function validJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'id')
    && value.id !== null
    && typeof value.id !== 'string'
    && !(typeof value.id === 'number' && Number.isFinite(value.id))
  ) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'params')
    && value.params !== null
    && typeof value.params !== 'object'
  ) return false;
  return true;
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
  if ((await grantAccessibleWorkspaces(context.admin.db('app'), grant!)).length === 0) {
    await revokeMcpGrantFamily(
      context.admin.db('app'),
      grant!.id,
      'system:workspace-access-lost',
    ).catch((error) => {
      console.error('[mcp] failed to revoke inaccessible grant:', error);
    });
    throw new Error('MCP grant no longer has workspace access.');
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
  template_id: stringSchema('Database template id used by apply_template.'),
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
  workspaceId: stringSchema('Hanji workspace id alias for workspace_id.'),
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
    description: 'Search Hanji content using the Notion-compatible hosted MCP shape. Mixed content requires pages:read and databases:read; user search uses workspace:read; data-source search uses databases:read.',
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
    description: 'Official Notion MCP-compatible search. Requires workspace_id; mixed content requires pages:read plus databases:read, user search workspace:read, and data-source search databases:read.',
    inputSchema: notionSearchSchema,
  },
  {
    name: 'fetch',
    title: 'Fetch',
    description: 'Fetch a Hanji page, block, database, or collection:// data source using its semantic read scope. Database pages and rows use databases:read; normal pages use pages:read; self uses workspace:read.',
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
    description: 'Official Notion MCP-compatible fetch. Supports self (workspace:read), normal pages (pages:read), and database pages/rows or collection:// ids (databases:read).',
    inputSchema: notionFetchSchema,
  },
  {
    name: '_notion_query_data_sources',
    title: 'Query data sources',
    description: 'Notion-compatible data source query for Hanji databases. Requires databases:read.',
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
    description: 'Official Notion MCP-compatible saved database view query. Requires databases:read; Hanji applies supported saved search/filter/sort settings.',
    inputSchema: notionQueryDatabaseViewSchema,
  },
  {
    name: '_notion_create_pages',
    title: 'Create pages',
    description: 'Notion-compatible page/row creation name and schema. Hanji validates output/destination write scopes (and template databases:read), then returns an explicit unsupported error because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
    inputSchema: notionCreatePagesSchema,
  },
  {
    name: 'notion-create-pages',
    title: 'Create pages',
    description: 'Official Notion MCP-compatible page/row creation name and schema. Hanji validates semantic scopes before allow_async, then records/returns an explicit unsupported result because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
    inputSchema: notionCreatePagesSchema,
  },
  {
    name: '_notion_update_page',
    title: 'Update page',
    description: 'Notion-compatible page update name and schema. Hanji validates pages:write or databases:write (plus template databases:read), then returns an explicit unsupported error because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
    inputSchema: notionUpdatePageSchema,
  },
  {
    name: 'notion-update-page',
    title: 'Update page',
    description: 'Official Notion MCP-compatible page update name and schema. Hanji validates target/template scopes before allow_async, then records/returns an explicit unsupported result because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
    inputSchema: notionUpdatePageSchema,
  },
  {
    name: '_notion_duplicate_page',
    title: 'Duplicate page',
    description: 'Duplicate a Hanji page subtree using the same product copy rules as the app. Requires every source-subtree semantic read scope plus every output/destination semantic write scope.',
    inputSchema: notionDuplicatePageSchema,
  },
  {
    name: 'notion-duplicate-page',
    title: 'Duplicate page',
    description: 'Official Notion MCP-compatible page duplication. Requires source-subtree semantic reads and output/destination semantic writes before returning an async task handle.',
    inputSchema: notionDuplicatePageSchema,
  },
  {
    name: '_notion_move_pages',
    title: 'Move pages',
    description: 'Move pages/databases to workspace root, under a page, or into a data source/database. Requires source, resulting-content, and destination semantic write scopes.',
    inputSchema: notionMovePagesSchema,
  },
  {
    name: 'notion-move-pages',
    title: 'Move pages',
    description: 'Official Notion MCP-compatible multi-page move with source/result/destination semantic write-scope enforcement.',
    inputSchema: notionMovePagesSchema,
  },
  {
    name: '_notion_create_database',
    title: 'Create database',
    description: 'Notion-compatible database creation name and schema. Hanji validates databases:write and the destination page scope, then returns an explicit unsupported error because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: 'notion-create-database',
    title: 'Create database',
    description: 'Official Notion MCP-compatible database creation name and schema. Hanji validates databases:write plus any destination page scope, then returns an explicit unsupported result because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: '_notion_update_data_source',
    title: 'Update data source',
    description: 'Notion-compatible data-source update name and schema. Hanji validates databases:write, then returns an explicit unsupported error because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
    inputSchema: jsonObjectSchema,
  },
  {
    name: 'notion-update-data-source',
    title: 'Update data source',
    description: 'Official Notion MCP-compatible data-source update name and schema. Hanji validates databases:write, then returns an explicit unsupported result because primary compatibility writes remain fail-closed until they use the canonical file lifecycle.',
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
  return grantAccessibleWorkspaces(context.admin.db('app'), grant);
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
  const workspaceId = page.workspaceId;
  const visited = new Set<string>();
  let current: PageRecord | null = page;
  while (current && !visited.has(current.id)) {
    if (current.workspaceId !== workspaceId) return false;
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

async function requireDatabaseInWorkspace(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  databaseId: string,
  label = 'Data source',
) {
  const page = await requirePageInWorkspace(context, grant, workspaceId, databaseId, label);
  if (page.kind !== 'database') throw new Error(`${label} was not found.`);
  return page;
}

function assertParentRecordKind(
  parent: PageRecord,
  parentType: Exclude<PageParentType, 'workspace'>,
  label: string,
) {
  const matches = parentType === 'database'
    ? parent.kind === 'database'
    : parent.kind !== 'database';
  if (!matches) throw new Error(`${label} was not found.`);
}

function requireCreationDestinationInsideAllowlist(
  grant: McpOAuthGrant,
  parent: PageRecord | null,
  label: string,
) {
  if (!grantResourceAllowlist(grant)) return;
  // New ids cannot already be present in a resource allowlist. They are safe
  // only when their parent is inside an allowlisted subtree, so the new
  // resource inherits the same narrowing after creation.
  if (!parent) throw new Error(`${label} was not found.`);
}

async function moveDestinationInsideAllowlist(
  context: FunctionContext,
  grant: McpOAuthGrant,
  source: PageRecord,
  parent: PageRecord | null,
) {
  const allowlist = grantResourceAllowlist(grant);
  if (!allowlist || allowlist.has(source.id)) return true;
  return !!parent && await pageWithinGrantAllowlist(context, grant, parent);
}

// Page/database ids are routed through the global page index. Missing ids are
// left to the compatibility endpoint so its normal not-found shape is kept.
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

// Block ids have no global index. Resolve them only in the caller-selected
// workspace and then authorize the owning page against the grant. Never fall
// back to the compatibility layer's all-accessible-workspace fan-out: a grant
// narrowed to one workspace must not reach a block in another accessible one.
async function requireBlockInWorkspace(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  blockId: string,
  label: string,
) {
  const block = await boundedDb(context.admin, workspaceId)
    .table<BlockRecord>('blocks')
    .getOne(blockId)
    .catch(() => null);
  if (!block?.pageId) throw new Error(`${label} was not found.`);
  const page = await requirePageInWorkspace(context, grant, workspaceId, block.pageId, label);
  return { block, page };
}

async function workspacePages(context: FunctionContext, workspaceId: string) {
  return await listAll(
    boundedDb(context.admin, workspaceId).table<PageRecord>('pages').where('workspaceId', '==', workspaceId),
  );
}

function pageSubtree(pages: PageRecord[], rootId: string) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const page of pages) {
      if (!page.parentId || !ids.has(page.parentId) || ids.has(page.id)) continue;
      ids.add(page.id);
      changed = true;
    }
  }
  return pages.filter((page) => ids.has(page.id) && !page.inTrash);
}

function cursorOffset(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
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

async function requireTemplateSource(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  templateId: string,
) {
  const template = await boundedDb(context.admin, workspaceId)
    .table<DbTemplateRecord>('db_templates')
    .getOne(templateId)
    .catch(() => null);
  if (!template?.databaseId) throw new Error('Template was not found.');
  const database = await requireDatabaseInWorkspace(
    context,
    grant,
    workspaceId,
    template.databaseId,
    'Template',
  );
  requireContentScope(grant, database, 'read');
  return template;
}

function publicAsyncTask(context: FunctionContext, task: McpAsyncTask) {
  const statusUrl = new URL(endpointUrls(context).resource);
  statusUrl.searchParams.set('async_task_id', task.id);
  const payload: Record<string, unknown> = {
    object: 'async_task',
    id: task.id,
    status: task.status ?? 'queued',
    status_url: statusUrl.toString(),
    created_time: task.createdAt ?? null,
    last_edited_time: task.updatedAt ?? task.completedAt ?? task.createdAt ?? null,
    poll_after_seconds: task.pollAfterSeconds ?? 1,
    operation: task.operation ?? { surface: 'mcp' },
  };
  if ((task.status ?? '') === 'succeeded') payload.result = task.result ?? null;
  if ((task.status ?? '') === 'failed') payload.error = task.error ?? { message: 'Async task failed.' };
  return payload;
}

async function asyncTaskForGrant(
  context: FunctionContext,
  grant: McpOAuthGrant,
  taskId: string,
) {
  const task = await context.admin.db('app').table<McpAsyncTask>('mcp_async_tasks').getOne(taskId).catch(() => null);
  if (!task || task.grantId !== grant.id || task.userId !== grant.userId || task.clientId !== grant.clientId) {
    return null;
  }
  return task;
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
  const task = await asyncTaskForGrant(context, grant, taskId);
  if (!task) {
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

export function assertMcpMarkdownBounds(markdown: unknown) {
  if (markdown !== undefined && markdown !== null && typeof markdown !== 'string') {
    throw new Error('MCP Markdown content must be a string.');
  }
  const raw = String(markdown ?? '');
  boundedMcpUtf8Bytes(raw, MAX_MCP_MARKDOWN_BYTES, 'MCP Markdown content');
  const text = raw.trim();
  if (!text) return;
  let blocks = 1;
  const separators = /\n{2,}/g;
  while (separators.exec(text)) {
    blocks += 1;
    if (blocks > MAX_MCP_MARKDOWN_BLOCKS) {
      throw new Error(`MCP Markdown content must contain at most ${MAX_MCP_MARKDOWN_BLOCKS} blocks.`);
    }
  }
}

export function markdownishBlocks(markdown: unknown) {
  assertMcpMarkdownBounds(markdown);
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

function commentRichTextItemText(value: unknown) {
  if (!isRecord(value)) return '';
  const text = isRecord(value.text) ? value.text.content : undefined;
  if (typeof text === 'string') return text;
  if (typeof value.plain_text === 'string') return value.plain_text;
  const equation = isRecord(value.equation) ? value.equation.expression : undefined;
  return typeof equation === 'string' ? equation : '';
}

export function boundedMcpCommentRichText(args: Record<string, unknown>) {
  const rich = Array.isArray(args.rich_text) ? args.rich_text : richText(args.text ?? '');
  if (rich.length > MAX_MCP_COMMENT_RICH_TEXT_ITEMS) {
    throw new Error(
      `MCP comment rich_text must contain at most ${MAX_MCP_COMMENT_RICH_TEXT_ITEMS} items.`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(rich);
  } catch {
    throw new Error('MCP comment rich_text must be serializable JSON.');
  }
  boundedMcpUtf8Bytes(
    serialized,
    MAX_MCP_COMMENT_RICH_TEXT_JSON_BYTES,
    'MCP comment rich_text JSON',
  );
  let textBytes = 0;
  for (const item of rich) {
    const text = commentRichTextItemText(item);
    const remaining = MAX_MCP_COMMENT_TEXT_BYTES - textBytes;
    textBytes += boundedMcpUtf8Bytes(text, Math.max(0, remaining), 'MCP comment text');
  }
  return rich;
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
  const selected = await requireWorkspaceArgument(context, grant, args, '_search');
  if ('error' in selected) return selected.error;
  // User search is directory metadata, not content search. Conversely,
  // workspace:read must never satisfy any page/database search branch.
  if (args.query_type === 'user') {
    requireGrantScope(grant, ['workspace:read']);
    return getUsers(context, grant, { ...args, workspace_id: selected.workspaceId });
  }
  const dataSourceId = collectionIdFromInput(args.data_source_url);
  if (dataSourceId) {
    // Same narrowing as queryDataSources: the caller-supplied data source must
    // live in the grant's selected workspace before the compat query runs.
    const dataSource = await requireDatabaseInWorkspace(
      context,
      grant,
      selected.workspaceId,
      dataSourceId,
      'Data source',
    );
    requireContentScope(grant, dataSource, 'read');
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

  // This endpoint returns a mixed page/database collection. Requiring both
  // read scopes is intentionally stricter than an OR guard: neither scope may
  // reveal the other content family. Resource-scoped grants use a local
  // allowlist projection so the compatibility search cannot leak sibling
  // resources or pagination metadata outside the grant.
  requireAllGrantScopes(grant, ['pages:read', 'databases:read']);
  if (grantResourceAllowlist(grant)) {
    const query = textValue(args.query).toLowerCase();
    const filter = isRecord(args.filters) ? args.filters : {};
    const objectFilter = textValue(filter.value).toLowerCase();
    const start = cursorOffset(args.start_cursor);
    const size = pageSize(args.page_size, 10);
    const candidates = (await workspacePages(context, selected.workspaceId))
      .filter((page) => !page.inTrash)
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id));
    const results: unknown[] = [];
    for (const page of candidates) {
      if (!(await pageWithinGrantAllowlist(context, grant, page))) continue;
      if (query && !String(page.title ?? '').toLowerCase().includes(query)) continue;
      if (objectFilter === 'page' && page.kind === 'database') continue;
      if (objectFilter === 'database' && page.kind !== 'database') continue;
      try {
        const payload = page.kind === 'database'
          ? await callNotionCompat(context, grant, 'GET', `databases/${page.id}`)
          : await callNotionCompat(context, grant, 'GET', `pages/${page.id}`);
        results.push(payload);
      } catch {
        // Keep the compatibility endpoint's user-level access check
        // authoritative; inaccessible candidates are omitted indistinguishably.
      }
    }
    const windowed = results.slice(start, start + size);
    const hasMore = start + size < results.length;
    return toolJson({
      object: 'list',
      type: 'workspace_search',
      results: windowed,
      has_more: hasMore,
      next_cursor: hasMore ? String(start + size) : null,
      scope: {
        provider: 'hanji',
        access_model: 'resource_allowlist',
        workspace_id: selected.workspaceId,
      },
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
  if (textValue(args.id).toLowerCase() === 'self') {
    requireGrantScope(grant, ['workspace:read']);
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
    const dataSourceRecord = await requireDatabaseInWorkspace(
      context,
      grant,
      selected.workspaceId,
      id,
      'Data source',
    );
    requireContentScope(grant, dataSourceRecord, 'read');
    const dataSource = await callNotionCompat(context, grant, 'GET', `data_sources/${id}`);
    const views = await callNotionCompat(context, grant, 'GET', `data_sources/${id}/views`).catch(() => null);
    return toolJson({ metadata: { type: 'data_source', workspace_id: selected.workspaceId }, data_source: dataSource, views });
  }
  await assertResourceInSelectedWorkspace(context, grant, selected.workspaceId, id, 'Page');
  const indexedPage = await pageRecord(context, id);
  if (indexedPage) {
    const pageRecordInWorkspace = await requirePageInWorkspace(
      context,
      grant,
      selected.workspaceId,
      id,
      'Page',
    );
    requireContentScope(grant, pageRecordInWorkspace, 'read');
    const page = await callNotionCompat(context, grant, 'GET', `pages/${id}`);
    const blocks = await callNotionCompat(context, grant, 'GET', `blocks/${id}/children`, undefined, { page_size: 100 }).catch(() => null);
    return toolJson({ metadata: { type: isRecord(page) ? page.object : 'page', workspace_id: selected.workspaceId }, page, blocks });
  }
  const ownedBlock = await requireBlockInWorkspace(context, grant, selected.workspaceId, id, 'Page');
  requireContentScope(grant, ownedBlock.page, 'read');
  const block = await callNotionCompat(context, grant, 'GET', `blocks/${id}`);
  const children = await callNotionCompat(context, grant, 'GET', `blocks/${id}/children`, undefined, { page_size: 100 }).catch(() => null);
  return toolJson({ metadata: { type: 'block', workspace_id: selected.workspaceId }, block, children });
}

async function queryDataSources(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
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
  const dataSource = await requireDatabaseInWorkspace(
    context,
    grant,
    selected.workspaceId,
    dataSourceId,
    'Data source',
  );
  requireContentScope(grant, dataSource, 'read');
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
  const data = isRecord(args.data) ? args.data : args;
  const selected = await requireWorkspaceArgument(context, grant, data, 'notion-query-database-view');
  if ('error' in selected) return selected.error;
  const viewId = stripHanjiId(data.view_id ?? data.view_url ?? data.database_view_url);
  if (!viewId) return toolError('view_id or view_url is required.');
  const view = await viewRecord(context, viewId, selected.workspaceId);
  if (!view) return toolError('view_not_found', { view_id: viewId });
  const database = await requireDatabaseInWorkspace(
    context,
    grant,
    selected.workspaceId,
    view.databaseId,
    'Data source',
  );
  requireContentScope(grant, database, 'read');
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

function createParentTarget(parent: Record<string, unknown>) {
  const databaseId = stripHanjiId(
    parent.data_source_id ?? parent.database_id ?? parent.dataSourceId ?? parent.databaseId,
  );
  const pageId = stripHanjiId(parent.page_id ?? parent.pageId);
  if (databaseId && pageId) throw new Error('Parent must identify exactly one page or data source.');
  if (databaseId) return { id: databaseId, type: 'database' as const };
  if (pageId) return { id: pageId, type: 'page' as const };
  return { id: '', type: 'workspace' as const };
}

async function resolveDestinationParent(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  parentId: string | null,
  parentType: PageParentType,
  label: string,
) {
  if (parentType === 'workspace') {
    if (parentId) throw new Error(`${label} was not found.`);
    return null;
  }
  if (!parentId) throw new Error(`${label} was not found.`);
  const parent = await requirePageInWorkspace(context, grant, workspaceId, parentId, label);
  assertParentRecordKind(parent, parentType, label);
  return parent;
}

async function createPages(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const rawPages = Array.isArray(args.pages) ? args.pages : [];
  if (rawPages.length > MAX_MCP_CREATE_PAGES) {
    throw new Error(`pages must contain at most ${MAX_MCP_CREATE_PAGES} entries.`);
  }
  if (!rawPages.every(isRecord)) {
    throw new Error('Every pages entry must be an object.');
  }
  const pages = rawPages;
  if (!pages.length) throw new Error('pages must contain at least one page.');
  for (const pageInput of pages) assertMcpMarkdownBounds(pageInput.content);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_create_pages');
  if ('error' in selected) return selected.error;
  const parent = isRecord(args.parent) ? args.parent : { workspace_id: selected.workspaceId };
  // A caller-supplied parent page/database must live in the selected workspace,
  // else pages get written outside the grant's narrowed scope.
  const parentRecord = isRecord(args.parent) ? args.parent : {};
  const parentTarget = createParentTarget(parentRecord);
  const destinationParent = await resolveDestinationParent(
    context,
    grant,
    selected.workspaceId,
    parentTarget.id || null,
    parentTarget.type,
    'Parent',
  );
  requireCreationDestinationInsideAllowlist(grant, destinationParent, 'Parent');
  const writeFamilies = new Set<ContentScopeFamily>([
    parentTarget.type === 'database' ? 'databases' : 'pages',
  ]);
  if (destinationParent) writeFamilies.add(contentScopeFamily(destinationParent));
  requireContentFamilies(grant, writeFamilies, 'write');
  for (const pageInput of pages) {
    const templateId = stripHanjiId(pageInput.template_id);
    if (templateId) {
      await requireTemplateSource(context, grant, selected.workspaceId, templateId);
    }
  }
  const run = async () => {
    const created: unknown[] = [];
    for (let index = 0; index < pages.length; index += 1) {
      const pageInput = pages[index]!;
      try {
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
      } catch (error) {
        const failedMessage = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          payload: {
            object: 'create_pages_result',
            status: created.length ? 'partial' : 'failed',
            pages: created,
            succeeded_count: created.length,
            failed_index: index,
            failed_message: failedMessage,
            retry_guidance: {
              strategy: 'retry_remaining_pages_only',
              start_index: index,
              remaining_count: pages.length - index,
              message: created.length
                ? 'Do not resubmit pages before failed_index; they were already created. Fix the failure and retry only pages from failed_index onward.'
                : 'Fix the failure and retry pages from failed_index onward.',
            },
          },
        };
      }
    }
    return { ok: true as const, payload: { pages: created } };
  };
  const outcome = await run();
  if (args.allow_async === true) {
    return toolJson({
      async_task: await recordAsyncTask(
        context,
        grant,
        'create_pages',
        outcome.ok ? 'succeeded' : 'failed',
        outcome.payload,
      ),
    });
  }
  return outcome.ok
    ? toolJson(outcome.payload)
    : toolError('create_pages_failed', outcome.payload);
}

async function updatePage(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const command = textValue(args.command, args.content || args.new_str ? 'insert_content' : 'update_properties');
  if (command === 'insert_content' || command === 'replace_content') {
    const markdown = command === 'replace_content'
      ? args.new_str ?? args.content
      : args.content ?? args.new_str;
    assertMcpMarkdownBounds(markdown);
  }
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_update_page');
  if ('error' in selected) return selected.error;
  const pageId = stripHanjiId(args.page_id ?? args.pageId);
  if (!pageId) throw new Error('page_id is required.');
  // The target page must belong to the grant's selected workspace; the
  // workspace_id argument alone does not scope the page id.
  const target = await requirePageInWorkspace(context, grant, selected.workspaceId, pageId, 'Page');
  requireContentScope(grant, target, 'write');
  if (command === 'apply_template') {
    const templateId = stripHanjiId(args.template_id);
    if (!templateId) throw new Error('template_id is required for apply_template.');
    await requireTemplateSource(context, grant, selected.workspaceId, templateId);
  }
  if (command === 'replace_content') {
    return toolError('replace_content_not_available', {
      message:
        'replace_content is disabled until Hanji has an atomic canonical replacement path. ' +
        'Use insert_content only when append-only behavior is acceptable.',
      supported_alternative: 'insert_content',
    });
  }
  const run = async () => {
    if (command === 'insert_content') {
      const content = args.content ?? args.new_str;
      return await callNotionCompat(context, grant, 'PATCH', `blocks/${pageId}/children`, {
        children: markdownishBlocks(content),
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
  const parentId = hasDestination
    ? stripHanjiId(args.parentId ?? args.parent_id) || null
    : source.parentId ?? null;
  const parentType = hasDestination
    ? normalizeParentType(args.parentType ?? args.parent_type, parentId)
    : normalizeParentType(source.parentType, parentId);
  const destinationParent = await resolveDestinationParent(
    context,
    grant,
    selected.workspaceId,
    parentId,
    parentType,
    'Destination parent',
  );
  requireCreationDestinationInsideAllowlist(grant, destinationParent, 'Destination parent');

  // Duplication reads every record in the source subtree and creates a new
  // subtree at the destination. Authorize those independently: a write scope
  // never substitutes for source read, and a root moved across the page/row
  // boundary requires the output family's write scope.
  const sourceTree = pageSubtree(await workspacePages(context, selected.workspaceId), source.id);
  const readFamilies = new Set(sourceTree.map(contentScopeFamily));
  const writeFamilies = new Set(
    sourceTree.filter((page) => page.id !== source.id).map(contentScopeFamily),
  );
  writeFamilies.add(source.kind === 'database' || parentType === 'database' ? 'databases' : 'pages');
  if (destinationParent) writeFamilies.add(contentScopeFamily(destinationParent));
  requireContentFamilies(grant, readFamilies, 'read');
  requireContentFamilies(grant, writeFamilies, 'write');

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

export function moveIds(args: Record<string, unknown>) {
  const raw = Array.isArray(args.page_or_database_ids)
    ? args.page_or_database_ids
    : Array.isArray(args.page_ids)
      ? args.page_ids
      : args.page_id
        ? [args.page_id]
        : [];
  if (raw.length > MAX_MCP_MOVE_PAGE_IDS) {
    throw new Error(`Move requests may contain at most ${MAX_MCP_MOVE_PAGE_IDS} page or database ids.`);
  }
  return Array.from(new Set(raw.map(stripHanjiId).filter(Boolean)));
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
  // Bound and normalize the operation fan-out before workspace selection or
  // any database lookup. The HTTP/JSON-RPC body caps do not otherwise stop one
  // tools/call from amplifying into thousands of permission checks and moves.
  const ids = moveIds(args);
  if (!ids.length) return toolError('Provide page_or_database_ids, page_ids, or page_id.');
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_move_pages');
  if ('error' in selected) return selected.error;

  const { parentId, parentType } = moveDestination(args);
  const destinationParent = await resolveDestinationParent(
    context,
    grant,
    selected.workspaceId,
    parentId,
    parentType,
    'Destination parent',
  );
  const pages = await workspacePages(context, selected.workspaceId);
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const afterPageId = stripHanjiId(args.after_page_id);
  const beforePageId = stripHanjiId(args.before_page_id);
  if (afterPageId) {
    await requirePageInWorkspace(context, grant, selected.workspaceId, afterPageId, 'Destination sibling');
  }
  if (beforePageId) {
    await requirePageInWorkspace(context, grant, selected.workspaceId, beforePageId, 'Destination sibling');
  }
  const moved = [];
  const notFound = [];
  const candidates: PageRecord[] = [];

  for (const id of ids) {
    const page = pagesById.get(id);
    // A page living in another workspace, or outside the grant's page/database
    // allowlist, must be indistinguishable from a missing one (no existence
    // oracle), so all three cases land in not_found.
    if (!page || !(await pageWithinGrantAllowlist(context, grant, page))) {
      notFound.push(id);
      continue;
    }
    if (!(await moveDestinationInsideAllowlist(context, grant, page, destinationParent))) {
      throw new Error('Destination parent was not found.');
    }
    const writeFamilies = new Set<ContentScopeFamily>([contentScopeFamily(page)]);
    writeFamilies.add(page.kind === 'database' || parentType === 'database' ? 'databases' : 'pages');
    if (destinationParent) writeFamilies.add(contentScopeFamily(destinationParent));
    requireContentFamilies(grant, writeFamilies, 'write');
    candidates.push(page);
  }

  // Validate the complete mixed batch before the first mutation so a missing
  // database/page scope cannot leave a partially moved result.
  for (const page of candidates) {
    const id = page.id;
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
    const result: Record<string, unknown> = {
      id: updated.id,
      parent: parentType === 'workspace' ? { type: 'workspace' } : { type: parentType, id: parentId },
      position,
    };
    // A write-only grant may move a caller-known id, but it must not receive
    // the page/database title as an implicit read side effect.
    if (hasScope(grant, [contentScopeName(contentScopeFamily(updated), 'read')])) {
      result.title = titleOf(updated);
    }
    moved.push(result);
  }

  return toolJson({
    moved,
    not_found: notFound,
    workspace_id: selected.workspaceId,
  });
}

async function createDatabase(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_create_database');
  if ('error' in selected) return selected.error;
  const title = textValue(args.title ?? args.name);
  const createParent = isRecord(args.parent) ? args.parent : undefined;
  const parentTarget = createParentTarget(createParent ?? {});
  // Hanji databases can be rooted in a workspace or nested under a page; a
  // data-source parent would be a different operation and fails closed here.
  if (parentTarget.type === 'database') throw new Error('Parent was not found.');
  const destinationParent = await resolveDestinationParent(
    context,
    grant,
    selected.workspaceId,
    parentTarget.id || null,
    parentTarget.type,
    'Parent',
  );
  requireCreationDestinationInsideAllowlist(grant, destinationParent, 'Parent');
  const writeFamilies = new Set<ContentScopeFamily>(['databases']);
  if (destinationParent) writeFamilies.add(contentScopeFamily(destinationParent));
  requireContentFamilies(grant, writeFamilies, 'write');
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
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_update_data_source');
  if ('error' in selected) return selected.error;
  const dataSourceId = collectionIdFromInput(args.data_source_id ?? args.database_id ?? args.data_source_url);
  if (!dataSourceId) return toolError('data_source_id is required.');
  const dataSource = await requireDatabaseInWorkspace(
    context,
    grant,
    selected.workspaceId,
    dataSourceId,
    'Data source',
  );
  requireContentScope(grant, dataSource, 'write');
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
  const rich = mode === 'create' ? boundedMcpCommentRichText(args) : undefined;
  const selected = await requireWorkspaceArgument(context, grant, args, mode === 'create' ? '_notion_create_comment' : '_notion_get_comments');
  if ('error' in selected) return selected.error;
  const pageId = stripHanjiId(args.page_id);
  const blockId = stripHanjiId(args.block_id);
  if (pageId) await requirePageInWorkspace(context, grant, selected.workspaceId, pageId, 'Page');
  if (blockId) await requireBlockInWorkspace(context, grant, selected.workspaceId, blockId, 'Block');
  if (mode === 'list') {
    const payload = await callNotionCompat(context, grant, 'GET', 'comments', undefined, {
      workspace_id: selected.workspaceId,
      page_id: pageId,
      block_id: blockId,
      start_cursor: args.start_cursor,
      page_size: args.page_size,
    });
    return toolJson(payload);
  }
  const parent = blockId
    ? { block_id: blockId, workspace_id: selected.workspaceId }
    : { page_id: pageId, workspace_id: selected.workspaceId };
  const payload = await callNotionCompat(context, grant, 'POST', 'comments', {
    workspace_id: selected.workspaceId,
    parent,
    rich_text: rich!,
  });
  return toolJson(payload);
}

async function createView(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_create_view');
  if ('error' in selected) return selected.error;
  const dataSourceId = collectionIdFromInput(args.data_source_id ?? args.database_id ?? args.data_source_url);
  if (!dataSourceId) return toolError('data_source_id is required.');
  const dataSource = await requireDatabaseInWorkspace(
    context,
    grant,
    selected.workspaceId,
    dataSourceId,
    'Data source',
  );
  requireContentScope(grant, dataSource, 'write');
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
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_update_view');
  if ('error' in selected) return selected.error;
  const viewId = stripHanjiId(args.view_id);
  if (!viewId) return toolError('view_id is required.');
  // Resolve the view within the selected workspace (the lookup is workspace-
  // scoped) and confirm its data source belongs there before mutating it.
  const view = await viewRecord(context, viewId, selected.workspaceId);
  if (!view) return toolError('view_not_found', { view_id: viewId });
  const dataSource = await requireDatabaseInWorkspace(
    context,
    grant,
    selected.workspaceId,
    view.databaseId,
    'Data source',
  );
  requireContentScope(grant, dataSource, 'write');
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
            scope_policy: HOSTED_SCOPE_POLICY,
            serverUrl: endpointUrls(context).resource,
          }, null, 2),
        },
      ],
      structuredContent: {
        hosted: true,
        grant: publicGrant(grant),
        scope_policy: HOSTED_SCOPE_POLICY,
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
      requireGrantScope(grant, ['databases:read']);
      const selected = await requireWorkspaceArgument(context, grant, args, '_notion_query_meeting_notes');
      if ('error' in selected) return selected.error;
      return toolJson({
        results: [],
        has_more: false,
        next_cursor: null,
        is_unsupported: true,
        unsupported_feature: 'notion_ai_meeting_notes',
        workspace_id: selected.workspaceId,
        message: 'Hanji does not provide a separate Notion AI meeting-notes data source. Use normal page/database search or a Hanji database dedicated to meetings.',
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
    '',
    'Scope separation: `workspace:read` covers workspace/team/user/self metadata only and never content. Normal pages use `pages:*`; database pages and database rows use `databases:*`. Mixed search requires both read scopes, data-source search/query/view requires `databases:read`, and write scopes never substitute for read scopes. Duplicate and move authorize source/result/destination semantic families independently.',
    '',
    'Current write boundary: create-pages, update-page, create-database, and update-data-source preserve the official names/schemas and validate scopes, but return an explicit unsupported result until the Notion-compatible primary write facade delegates to Hanji\'s canonical stored-file ownership, quota, and permanent-delete lifecycle. Async calls expose the same boundary as a completed failed task rather than claiming success.',
  ].join('\n');
}

function enhancedMarkdownSpec() {
  return [
    '# Hanji Notion-Compatible Markdown',
    '',
    'Hosted MCP exposes the page-body tool names and a practical Markdown-ish input schema, but primary create/update content writes fail closed in this release until they use Hanji\'s canonical stored-file lifecycle. A future enabled path will convert headings, paragraphs, bullet lines, and to-do lines to Notion-compatible block payloads before reaching the product API.',
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
  if (
    !Object.prototype.hasOwnProperty.call(request, 'id')
    && method.startsWith('notifications/')
  ) return null;
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
      const taskId = new URL(context.request.url).searchParams.get('async_task_id')?.trim();
      if (taskId) {
        const task = await asyncTaskForGrant(context, auth.grant, taskId);
        const headers = mcpHeaders(context.request);
        headers.set('Cache-Control', 'no-store');
        if (!task) {
          return json(
            {
              object: 'error',
              code: 'async_task_not_found',
              message: 'Async task was not found.',
            },
            { status: 404, headers },
          );
        }
        return json({ async_task: publicAsyncTask(context, task) }, { headers });
      }
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
  maxRequestBodyBytes: 4 * 1024 * 1024,
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
    let body: unknown;
    try {
      body = await context.request.json();
    } catch {
      return json(rpcError(null, -32700, 'Invalid JSON.'), {
        status: 400,
        headers: mcpHeaders(context.request),
      });
    }
    try {
      assertMcpRequestJsonShape(body);
    } catch (error) {
      return json(
        rpcError(null, -32600, error instanceof Error ? error.message : 'Invalid JSON-RPC request.'),
        { status: 400, headers: mcpHeaders(context.request) },
      );
    }
    const isBatch = Array.isArray(body);
    const requests: unknown[] = Array.isArray(body) ? body : [body];
    if (requests.length === 0) {
      return json(rpcError(null, -32600, 'JSON-RPC batch must not be empty.'), {
        status: 400,
        headers: mcpHeaders(context.request),
      });
    }
    if (requests.length > MAX_MCP_JSON_RPC_BATCH_ITEMS) {
      return json(
        rpcError(
          null,
          -32600,
          `JSON-RPC batch must contain at most ${MAX_MCP_JSON_RPC_BATCH_ITEMS} requests.`,
        ),
        { status: 400, headers: mcpHeaders(context.request) },
      );
    }
    if (!requests.every(validJsonRpcRequest)) {
      return json(rpcError(null, -32600, 'Invalid JSON-RPC request.'), {
        status: 400,
        headers: mcpHeaders(context.request),
      });
    }
    const responses = [];
    for (const item of requests) {
      const response = await handleRpc(context, item, auth.grant);
      // JSON-RPC notifications are identified solely by the absence of an
      // `id`, regardless of the method name. Still dispatch them so a valid
      // notification can perform its intended work, but never emit a reply.
      if (response && Object.prototype.hasOwnProperty.call(item, 'id')) {
        responses.push(response);
      }
    }
    if (!responses.length) {
      return new Response(null, { status: 202, headers: mcpHeaders(context.request) });
    }
    return json(isBatch ? responses : responses[0], {
      headers: mcpHeaders(context.request),
    });
  },
});
