import { defineFunction } from '@edge-base/shared';
import { boundedDb, boundedDbForPage } from '../lib/workspace-db';
import { bestEffort, isNotFoundError } from '../lib/table-utils';
import { decodeSearchSourceCursor, encodeSearchSourceCursor } from '../lib/search-source-cursor';
import {
  invokeProductFunction,
  type ProductFunctionDefinition as InternalFunctionHandler,
} from '../lib/product-function-bridge';
import { assertMinimumPageAccessRole } from '../lib/page-access';
import {
  assertMcpClientApprovedForWorkspaces,
  filterMcpClientApprovedWorkspaces,
} from '../lib/enterprise-controls';
import {
  NOTION_DATABASE_VIEW_TYPES,
  parseDatabaseViewType,
  type NotionDatabaseViewType,
} from '../lib/database-view-types';
import {
  assertRequiredNotionViewConfigure,
  notionViewConfigurePlan,
  parseNotionViewConfigDsl,
  type NotionViewDslProperty,
} from '../lib/notion-view-config-dsl';
import {
  normalizeNotionMoveDestination,
  normalizeNotionMovePageIds,
  notionMoveBatchPositions,
  NOTION_MOVE_PAGES_MAX_IDS,
  type NotionMovePagesDestination,
} from '../lib/notion-move-pages-contract';
import {
  notionMcpDdlPatch,
  notionMcpPropertySchema,
  notionMcpPropertySchemaMap,
  notionMcpTypedDatabaseProperties,
  parseNotionMcpCreateTable,
  parseNotionMcpDdl,
  type NotionMcpDatabaseType,
} from '../lib/notion-mcp-database';
import {
  executeStreamableNotionMcpSqlChunk,
  notionMcpSqlStreamPlan,
  NOTION_MCP_SQL_CROSS_WINDOW_ERROR,
  parseNotionMcpSqlUnion,
} from '../lib/notion-mcp-query';
import { POST as blockMutationHandler } from './block-mutation';
import { POST as databaseMutationHandler } from './database-mutation';
import { POST as databaseRowMutationHandler } from './database-row-mutation';
import { POST as duplicatePageHandler } from './duplicate-page';
import {
  createNotionFileUpload,
  deleteNotionFileUpload,
  sendNotionFileUpload,
  POST as fileMutationHandler,
} from './file-mutation';
import { notionCompatHandler } from './notion/v1/[...slug]';
import { POST as pageMutationHandler } from './page-mutation';
import { POST as pageQueryHandler } from './page-query';
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
  revokeLegacyBroadMcpGrant,
  revokeMcpGrantFamily,
  verifyAccessToken,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  storage?: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
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
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  properties?: Record<string, unknown> | null;
}

interface BlockRecord {
  id: string;
  pageId: string;
  parentId?: string | null;
  type?: string | null;
  plainText?: string | null;
  content?: Record<string, unknown> | null;
  position?: number | null;
}

interface CommentRecord {
  id: string;
  pageId: string;
  blockId?: string | null;
  parentId?: string | null;
  authorId?: string | null;
  body?: Record<string, unknown> | null;
  resolved?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface AttachmentUploadRecord {
  id: string;
  workspaceId: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  status?: string | null;
  pageId?: string | null;
  blockId?: string | null;
  databaseId?: string | null;
  propertyId?: string | null;
  templateId?: string | null;
  expiresAt?: string | null;
  fileImportResult?: unknown;
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

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const MAX_MCP_JSON_RPC_BATCH_ITEMS = 50;
export const MAX_MCP_MOVE_PAGE_IDS = NOTION_MOVE_PAGES_MAX_IDS;
export const MAX_MCP_CREATE_PAGES = 25;
export const MAX_MCP_REQUEST_JSON_DEPTH = 32;
export const MAX_MCP_REQUEST_JSON_NODES = 100_000;
export const MAX_MCP_MARKDOWN_BYTES = 256 * 1024;
export const MAX_MCP_MARKDOWN_BLOCKS = 1_000;
export const MAX_MCP_COMMENT_RICH_TEXT_ITEMS = 100;
export const MAX_MCP_COMMENT_TEXT_BYTES = 256 * 1024;
export const MAX_MCP_COMMENT_RICH_TEXT_JSON_BYTES = 768 * 1024;
export const MAX_MCP_INLINE_ATTACHMENT_BYTES = 200 * 1024;
export const MAX_MCP_URL_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_MCP_MEETING_NOTE_RESULTS = 50;
const MAX_MCP_MEETING_NOTE_AUTHORITY_PAGES = 2_500;
export const MCP_ATTACHMENT_TTL_MS = 60 * 60 * 1000;

const MCP_TEXT_ATTACHMENT_TYPES = new Map([
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
  ['tsv', 'text/tab-separated-values'],
  ['ics', 'text/calendar'],
]);

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
    if (pageMatch) return notionUuid(pageMatch[1]);
    const trailingId = decodeURIComponent(url.pathname)
      .match(/(?:^|[-/])([0-9a-f]{32}|[0-9a-f-]{36})\/?$/i)?.[1];
    if (trailingId) return notionUuid(trailingId);
    const blockMatch = url.hash.match(/block-([0-9a-f-]{32,36})/i);
    if (blockMatch) return notionUuid(blockMatch[1]);
    const view = url.searchParams.get('v');
    if (view) return notionUuid(view);
  } catch {
    // fall through
  }
  return raw;
}

function notionUuid(value: string) {
  const compact = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) return value;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function notionViewId(value: unknown) {
  const raw = textValue(value);
  if (!raw) return '';
  const viewUri = raw.match(/^view:\/\/(.+)$/i)?.[1];
  if (viewUri) return notionUuid(viewUri.trim());
  try {
    const queryView = new URL(raw).searchParams.get('v');
    if (queryView) return notionUuid(queryView);
  } catch {
    // Fall back to a bare id or another supported Hanji id form.
  }
  return stripHanjiId(raw);
}

function selectedWorkspaceId(input: Record<string, unknown>) {
  return stripHanjiId(input.workspace_id ?? input.workspaceId ?? input.teamspace_id);
}

function pageSize(value: unknown, fallback = 25, max = 100) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
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

function toolTextWithStructured(text: string, structuredContent: Record<string, unknown>) {
  return {
    isError: false,
    content: [{ type: 'text', text }],
    structuredContent,
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

class McpAuthenticationError extends Error {
  override name = 'McpAuthenticationError';
}

function asyncTaskHttpError(
  context: FunctionContext,
  status: number,
  code: string,
  message: string,
) {
  const headers = mcpHeaders(context.request);
  headers.set('Cache-Control', 'no-store');
  return json({ object: 'error', code, message }, { status, headers });
}

function asyncTaskInternalError(context: FunctionContext, error: unknown) {
  const candidate = error && typeof error === 'object'
    ? Number((error as { status?: unknown; code?: unknown }).status
      ?? (error as { status?: unknown; code?: unknown }).code)
    : NaN;
  const status = Number.isInteger(candidate) && candidate >= 500 && candidate <= 599
    ? candidate
    : 500;
  return asyncTaskHttpError(
    context,
    status,
    'internal_server_error',
    'Async task status is temporarily unavailable.',
  );
}

function isMcpClientGovernanceDenial(error: unknown): error is Error {
  return error instanceof Error
    && error.message === 'This MCP client is not approved for the selected workspace.';
}

async function authenticatedGrant(context: FunctionContext) {
  const raw = bearerToken(context.request);
  if (!raw) return null;
  const db = context.admin.db('app');
  let token: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    token = await verifyAccessToken(raw, context.env, context.request);
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'HANJI_MCP_OAUTH_SECRET is required for hosted MCP OAuth.'
    ) {
      throw error;
    }
    throw new McpAuthenticationError('MCP access token is invalid.');
  }
  let grant: McpOAuthGrant | null;
  try {
    grant = await db.table<McpOAuthGrant>('mcp_oauth_grants').getOne(token.grant_id);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new McpAuthenticationError('MCP grant is revoked or expired.');
    }
    throw error;
  }
  if (!grant || !grantIsActive(grant)) {
    throw new McpAuthenticationError('MCP grant is revoked or expired.');
  }
  if (grant.userId !== token.sub || grant.clientId !== token.client_id) {
    throw new McpAuthenticationError('MCP grant does not match the access token.');
  }
  if (await revokeLegacyBroadMcpGrant(db, grant)) {
    throw new McpAuthenticationError(
      'MCP grant requires reauthorization with an explicit workspace selection.',
    );
  }
  const accessible = await grantAccessibleWorkspaces(db, grant);
  if (accessible.length === 0) {
    await revokeMcpGrantFamily(
      db,
      grant.id,
      'system:workspace-access-lost',
    ).catch((error) => {
      console.error('[mcp] failed to revoke inaccessible grant:', error);
    });
    throw new McpAuthenticationError('MCP grant no longer has workspace access.');
  }
  await bestEffort(
    'mcp grant lastUsedAt update',
    db.table<McpOAuthGrant>('mcp_oauth_grants').update(grant.id, { lastUsedAt: new Date().toISOString() }),
  );
  return { token, grant };
}

const notionSearchSchema = objectSchema({
  query: stringSchema('Search query.'),
  query_type: { type: 'string', enum: ['internal', 'user'], description: 'Use user to search workspace members.' },
  content_search_mode: { type: 'string', enum: ['workspace_search', 'ai_search'] },
  data_source_url: stringSchema('Optional collection://<database-id> to search/query a data source.'),
  page_url: stringSchema('Optional page URL/id for clients that provide it.'),
  workspace_id: stringSchema('Required Hanji workspace id. Call list_workspaces or _notion_get_teams first.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  page_size: { type: 'integer', minimum: 1, maximum: 25, description: '1-25 results.' },
  max_highlight_length: { type: 'integer', minimum: 0, maximum: 1000, description: 'Maximum highlight characters; 0 omits highlights.' },
  start_cursor: stringSchema('Pagination cursor.'),
  filters: jsonObjectSchema,
});

const notionFetchSchema = objectSchema({
  id: stringSchema('Page URL/id, database URL/id, block id, or collection://<database-id>.'),
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  include_discussions: booleanSchema('Include page comments summary where supported.'),
  include_transcript: booleanSchema('Include attendee-authorized AI meeting-note transcript content for the fetched page.'),
});

const notionCreateAttachmentSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  filename: stringSchema('Filename with a supported extension.'),
  content_type: stringSchema('Optional MIME type matching filename.'),
  content: stringSchema('Small UTF-8 text content, at most 200 KiB. Exactly one of content or source_url is required.'),
  source_url: stringSchema('Direct public HTTPS URL with no redirects or private-network target. Exactly one source is required.'),
}, ['filename']);

const notionDownloadAttachmentSchema = objectSchema({
  file_upload_id: stringSchema('FileUpload id returned by notion-create-attachment.'),
}, ['file_upload_id']);

const notionQueryDataSourcesSchema = {
  type: 'object',
  properties: {
    data: {
      oneOf: [
        {
          type: 'object',
          properties: {
            workspace_id: stringSchema('Required Hanji workspace id.'),
            teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
            mode: { type: 'string', enum: ['sql'] },
            data_source_urls: { ...arrayOf(stringSchema('collection:// data source URL.')), minItems: 1 },
            query: stringSchema('Read-only SELECT SQL.'),
            start_cursor: stringSchema('Opaque continuation cursor for bounded SQL source scanning.'),
            params: {
              type: 'array',
              maxItems: 256,
              items: {
                oneOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'null' },
                ],
              },
              description: 'Bind values. Strings, finite numbers, booleans, and null are accepted without interpolation.',
            },
          },
          required: ['data_source_urls', 'query'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            workspace_id: stringSchema('Required Hanji workspace id.'),
            teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
            mode: { type: 'string', enum: ['view'] },
            view_url: stringSchema('Database view URL or view:// id.'),
            is_archived: booleanSchema('Query archived rows instead of active rows.'),
            page_size: numberSchema('1-100 rows.'),
            start_cursor: stringSchema('Pagination cursor.'),
          },
          required: ['mode', 'view_url'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['data'],
  additionalProperties: false,
};

const notionQueryDatabaseViewSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  view_id: stringSchema('View id, view:// URI, or Notion URL with ?v=.'),
  view_url: stringSchema('View URL, view:// URI, or Notion URL with ?v=.'),
  is_archived: booleanSchema('Query archived rows instead of active rows.'),
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

const notionUpdatePageSchema = {
  ...objectSchema({
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
    content: stringSchema('Markdown-ish content. For replace_content, content or new_str is required.'),
    new_str: stringSchema('Replacement or inserted Markdown-ish content. May be empty only when explicitly supplied.'),
    content_updates: {
      ...arrayOf(objectSchema({
        old_str: stringSchema('Existing content to replace.'),
        new_str: stringSchema('Replacement content.'),
        replace_all_matches: booleanSchema('Replace every match instead of requiring one unambiguous match.'),
      }, ['old_str', 'new_str'])),
      minItems: 1,
      maxItems: 100,
    },
    position: objectSchema({
      type: { type: 'string', enum: ['start', 'end'] },
    }, ['type']),
    after: stringSchema('Ellipsis selection after which insert_content adds content.'),
    allow_deleting_content: booleanSchema(
      'For replace_content and update_content, permit deletion of child pages or databases.',
    ),
    icon: stringSchema(),
    cover: stringSchema(),
    locked: booleanSchema(),
    verification_status: { type: 'string', enum: ['verified', 'unverified'] },
    verification_expiry_days: numberSchema('Optional positive number of days before verification expires.'),
    allow_async: booleanSchema('Return a Notion-style async task handle.'),
  }),
  allOf: [{
    if: {
      properties: { command: { const: 'replace_content' } },
      required: ['command'],
    },
    then: {
      anyOf: [{ required: ['new_str'] }, { required: ['content'] }],
    },
  }],
};

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
  page_or_database_ids: {
    ...arrayOf(stringSchema('Page or database id/URL to move.')),
    minItems: 1,
    maxItems: NOTION_MOVE_PAGES_MAX_IDS,
  },
  page_ids: {
    ...arrayOf(stringSchema('Alternative page id list.')),
    minItems: 1,
    maxItems: NOTION_MOVE_PAGES_MAX_IDS,
  },
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

const notionGetCommentsSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  page_id: stringSchema('Page id.'),
  include_all_blocks: booleanSchema('Include discussions anchored to child blocks.'),
  include_resolved: booleanSchema('Include resolved discussions.'),
  discussion_id: stringSchema('Specific discussion id or discussion:// URL.'),
}, ['page_id']);

const notionCreateCommentSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  page_id: stringSchema('Page id.'),
  selection_with_ellipsis: stringSchema('A unique page-content selection, using ... between its beginning and end.'),
  discussion_id: stringSchema('Existing discussion id or discussion:// URL to reply to.'),
  markdown: stringSchema('Notion-flavored inline Markdown comment body.'),
  rich_text: arrayOf(jsonObjectSchema),
}, ['page_id']);

const notionCreateDatabaseSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  title: stringSchema('Database title.'),
  description: stringSchema('Database description.'),
  parent: {
    type: 'object',
    properties: { type: { type: 'string', enum: ['page_id'] }, page_id: stringSchema('Parent page id.') },
    required: ['page_id'],
    additionalProperties: false,
  },
  schema: stringSchema('CREATE TABLE statement defining the data-source schema.'),
  database_type: { type: 'string', enum: ['tasks', 'projects', 'skills'] },
});

const notionUpdateDataSourceSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  data_source_id: stringSchema('collection:// URI, data source id, or single-source database id.'),
  title: stringSchema('New data-source title.'),
  description: stringSchema('New data-source description.'),
  is_inline: booleanSchema('Display a single-source database inline or as a full page.'),
  in_trash: booleanSchema('Move the data source to or from trash.'),
  statements: stringSchema('Semicolon-separated ADD/DROP/RENAME/ALTER COLUMN statements.'),
}, ['data_source_id']);

const notionCreateViewSchema = {
  ...objectSchema({
    workspace_id: stringSchema('Required Hanji workspace id.'),
    teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
    database_id: stringSchema('Database that receives a view tab. Exactly one of database_id or parent_page_id is required.'),
    parent_page_id: stringSchema('Page that receives an inline linked database view. Exactly one of parent_page_id or database_id is required.'),
    data_source_id: stringSchema('Data source referenced by the new view. Accepts a collection:// URI or bare id.'),
    name: stringSchema('Name of the view.'),
    type: {
      type: 'string',
      enum: [...NOTION_DATABASE_VIEW_TYPES],
    },
    configure: stringSchema('View DSL. Supports FILTER, SORT BY, GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, HIDE, COVER, WRAP CELLS, and FREEZE COLUMNS.'),
  }, ['data_source_id', 'name', 'type']),
  oneOf: [
    { required: ['database_id'], not: { required: ['parent_page_id'] } },
    { required: ['parent_page_id'], not: { required: ['database_id'] } },
  ],
};

const notionUpdateViewSchema = objectSchema({
  workspace_id: stringSchema('Required Hanji workspace id.'),
  teamspace_id: stringSchema('Notion-compatible alias for workspace_id.'),
  view_id: stringSchema('View id, view:// URI, or Notion URL with ?v=.'),
  name: stringSchema('New name for the view.'),
  configure: stringSchema('View DSL. Supports FILTER, SORT BY, GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, HIDE, COVER, WRAP CELLS, FREEZE COLUMNS, and CLEAR directives.'),
}, ['view_id']);

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
    description: 'Fetch a Hanji page, block, database, or collection:// data source using its semantic read scope. Set include_transcript for real attendee-authorized meeting-note transcripts. Database pages and rows use databases:read; normal pages use pages:read; self uses workspace:read.',
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
    description: 'Official Notion MCP-compatible fetch. Supports attendee-authorized meeting-note transcripts with include_transcript, self (workspace:read), normal pages (pages:read), and database pages/rows or collection:// ids (databases:read).',
    inputSchema: notionFetchSchema,
  },
  {
    name: 'notion-create-attachment',
    title: 'Create attachment',
    description: 'Create a real temporary Hanji file upload from small UTF-8 content or a direct public HTTPS source. Requires files:write and an explicit workspace_id. Inline content supports safe Markdown, text, CSV, JSON, YAML, TSV, and calendar files up to 200 KiB; URL imports are capped at 5 MiB.',
    inputSchema: notionCreateAttachmentSchema,
  },
  {
    name: 'notion-download-attachment',
    title: 'Download attachment',
    description: 'Download a small UTF-8 text attachment created by this MCP grant. Requires files:read and returns complete content up to 200 KiB.',
    inputSchema: notionDownloadAttachmentSchema,
  },
  {
    name: '_notion_query_data_sources',
    title: 'Query data sources',
    description: 'Notion-compatible data source query for Hanji databases. Requires databases:read. SQL mode streams one collection:// source with bind-safe filters, projections, direct-property multi-key ordering, LIMIT/OFFSET, and opaque continuation; cross-window joins, CTEs/subqueries, DISTINCT, grouping/aggregates, unions, and computed ordering fail before row reads. View mode queries saved database views.',
    inputSchema: notionQueryDataSourcesSchema,
  },
  {
    name: 'notion-query-data-sources',
    title: 'Query data sources',
    description: 'Official Notion MCP-compatible data source query for Hanji databases. SQL mode streams one collection:// source with bind-safe filters, projections, direct-property multi-key ordering, LIMIT/OFFSET, and opaque continuation; cross-window SQL shapes fail before row reads.',
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
    description: 'Notion-compatible page/row creation through Hanji\'s canonical mutation facade, with output/destination write scopes, template reads, and partial-failure retry metadata.',
    inputSchema: notionCreatePagesSchema,
  },
  {
    name: 'notion-create-pages',
    title: 'Create pages',
    description: 'Official Notion MCP-compatible page/row creation through Hanji\'s canonical mutation facade. Semantic scopes are validated before synchronous execution or a persisted async result.',
    inputSchema: notionCreatePagesSchema,
  },
  {
    name: '_notion_update_page',
    title: 'Update page',
    description: 'Notion-compatible page update through Hanji\'s canonical page, row, block, template, and verification mutation paths.',
    inputSchema: notionUpdatePageSchema,
  },
  {
    name: 'notion-update-page',
    title: 'Update page',
    description: 'Official Notion MCP-compatible page update. Target and template scopes are validated before canonical synchronous execution or a persisted async result.',
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
    description: 'Notion-compatible database creation through Hanji\'s canonical database mutation facade with destination and database write-scope enforcement.',
    inputSchema: notionCreateDatabaseSchema,
  },
  {
    name: 'notion-create-database',
    title: 'Create database',
    description: 'Official Notion MCP-compatible database creation through Hanji\'s canonical mutation facade, including schema and destination validation.',
    inputSchema: notionCreateDatabaseSchema,
  },
  {
    name: '_notion_update_data_source',
    title: 'Update data source',
    description: 'Notion-compatible data-source update through Hanji\'s canonical database schema mutation facade.',
    inputSchema: notionUpdateDataSourceSchema,
  },
  {
    name: 'notion-update-data-source',
    title: 'Update data source',
    description: 'Official Notion MCP-compatible data-source update through Hanji\'s canonical schema mutation facade with database write-scope enforcement.',
    inputSchema: notionUpdateDataSourceSchema,
  },
  {
    name: '_notion_get_comments',
    title: 'Get comments',
    description: 'List comments on a page or block.',
    inputSchema: notionGetCommentsSchema,
  },
  {
    name: 'notion-get-comments',
    title: 'Get comments',
    description: 'Official Notion MCP-compatible comment listing.',
    inputSchema: notionGetCommentsSchema,
  },
  {
    name: '_notion_create_comment',
    title: 'Create comment',
    description: 'Create a page or block comment. Requires comments write scope.',
    inputSchema: notionCreateCommentSchema,
  },
  {
    name: 'notion-create-comment',
    title: 'Create comment',
    description: 'Official Notion MCP-compatible comment creation.',
    inputSchema: notionCreateCommentSchema,
  },
  {
    name: '_notion_create_view',
    title: 'Create view',
    description: 'Create a database view tab or inline linked view through the Notion-compatible REST facade. Database view creation requires databases:write; parent_page_id additionally requires pages:write. Supports all ten official view types and the official configure DSL.',
    inputSchema: notionCreateViewSchema,
  },
  {
    name: 'notion-create-view',
    title: 'Create view',
    description: 'Official Notion MCP-compatible view creation. Exactly one of database_id or parent_page_id is required. Database view creation requires databases:write; parent_page_id additionally requires pages:write. All ten official view types and configure directives are supported.',
    inputSchema: notionCreateViewSchema,
  },
  {
    name: '_notion_update_view',
    title: 'Update view',
    description: 'Update a database view name or configuration through the Notion-compatible REST facade.',
    inputSchema: notionUpdateViewSchema,
  },
  {
    name: 'notion-update-view',
    title: 'Update view',
    description: 'Official Notion MCP-compatible view update. Only name and the configure DSL are mutable after creation.',
    inputSchema: notionUpdateViewSchema,
  },
  {
    name: '_notion_query_meeting_notes',
    title: 'Query meeting notes',
    description: 'Query native or preserved imported meeting-note blocks with attendee and page-access enforcement.',
    inputSchema: objectSchema({
      workspace_id: stringSchema('Required Hanji workspace id.'),
      teamspace_id: stringSchema('Alias for workspace_id.'),
      filter: jsonObjectSchema,
      sort: arrayOf(jsonObjectSchema),
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum meeting notes to return.' },
    }),
  },
  {
    name: 'notion-query-meeting-notes',
    title: 'Query meeting notes',
    description: 'Official Notion MCP-compatible meeting-notes query over native and preserved imported artifacts.',
    inputSchema: objectSchema({
      workspace_id: stringSchema('Required Hanji workspace id.'),
      teamspace_id: stringSchema('Alias for workspace_id.'),
      filter: jsonObjectSchema,
      sort: arrayOf(jsonObjectSchema),
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum meeting notes to return.' },
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
  const db = context.admin.db('app');
  const accessible = await grantAccessibleWorkspaces(db, grant);
  return filterMcpClientApprovedWorkspaces(db, accessible, grant.clientId);
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
    const db = context.admin.db('app');
    const accessible = await grantAccessibleWorkspaces(db, grant);
    const selected = accessible.find((workspace) => workspace.id === workspaceId);
    if (selected) {
      await assertMcpClientApprovedForWorkspaces(db, [selected], {
        actorId: grant.userId,
        clientId: grant.clientId,
        clientName: grant.clientName,
        grantId: grant.id,
        stage: 'hosted_call',
      });
      return { workspaceId };
    }
    const allowed = await filterMcpClientApprovedWorkspaces(db, accessible, grant.clientId);
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

class NotionCompatHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'NotionCompatHttpError';
  }
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
    storage: context.storage,
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
    const code = isRecord(payload) ? textValue(payload.code) || null : null;
    throw new NotionCompatHttpError(response.status, code, message);
  }
  return payload;
}

export async function callProductFunction(
  context: FunctionContext,
  grant: McpOAuthGrant,
  slug: string,
  body: Record<string, unknown>,
  handler: InternalFunctionHandler,
) {
  const urls = endpointUrls(context);
  return invokeProductFunction(handler, context, body, {
    url: `${urls.origin}/api/functions/${slug.replace(/^\/+/, '')}`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    auth: { id: grant.userId, email: null },
  });
}

async function pageRecord(context: FunctionContext, id: string) {
  if (!id) return null;
  const db = await boundedDbForPage(context.admin, id);
  if (!db) return null;
  try {
    const page = await db.table<PageRecord>('pages').getOne(id);
    if (!isRecord(page)) throw new Error('Page record response was malformed.');
    const parentId = page.parentId;
    const parentType = page.parentType;
    const hasParent = typeof parentId === 'string' && !!textValue(parentId);
    const parentIdValid = parentId === undefined || parentId === null || hasParent;
    const parentTypeValid = parentType === undefined
      || parentType === null
      || parentType === 'workspace'
      || parentType === 'page'
      || parentType === 'database';
    const parentPairValid = parentType === undefined
      || parentType === null
      || (hasParent ? parentType !== 'workspace' : parentType === 'workspace');
    if (textValue(page.id) !== id
      || !textValue(page.workspaceId)
      || !parentIdValid
      || !parentTypeValid
      || !parentPairValid) {
      throw new Error('Page record response was malformed.');
    }
    return page as unknown as PageRecord;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

type PageRecordLookup = (id: string) => Promise<PageRecord | null>;

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

async function pageWithinGrantAllowlist(
  context: FunctionContext,
  grant: McpOAuthGrant,
  page: PageRecord,
  lookup: PageRecordLookup = (id) => pageRecord(context, id),
) {
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
    current = await lookup(parentId);
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
  let task: McpAsyncTask | null;
  try {
    task = await context.admin.db('app').table<McpAsyncTask>('mcp_async_tasks').getOne(taskId);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  if (!task || task.grantId !== grant.id || task.userId !== grant.userId || task.clientId !== grant.clientId) {
    return null;
  }
  return task;
}

async function recordAsyncTask(
  context: FunctionContext,
  grant: McpOAuthGrant,
  operationName: string,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  const task = await context.admin.db('app').table<McpAsyncTask>('mcp_async_tasks').insert({
    grantId: grant.id,
    userId: grant.userId,
    clientId: grant.clientId,
    status: 'queued',
    operation: { surface: 'mcp', name: operationName, workspace_id: workspaceId },
    pollAfterSeconds: 1,
    createdAt: now,
    updatedAt: now,
  });
  return task;
}

type AsyncTaskTerminal =
  | { status: 'succeeded'; payload: unknown }
  | { status: 'failed'; payload: unknown };

function asyncTaskFailure(error: unknown) {
  return {
    object: 'error',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function queueAsyncTask(
  context: FunctionContext,
  grant: McpOAuthGrant,
  operationName: string,
  workspaceId: string,
  run: () => Promise<AsyncTaskTerminal>,
) {
  const table = context.admin.db('app').table<McpAsyncTask>('mcp_async_tasks');
  const task = await recordAsyncTask(context, grant, operationName, workspaceId);
  const work = (async () => {
    const startedAt = new Date().toISOString();
    await table.update(task.id, { status: 'running', updatedAt: startedAt });
    let terminal: AsyncTaskTerminal;
    try {
      terminal = await run();
    } catch (error) {
      terminal = { status: 'failed', payload: asyncTaskFailure(error) };
    }
    const completedAt = new Date().toISOString();
    await table.update(task.id, {
      status: terminal.status,
      // EdgeBase's D1 adapter cannot bind `undefined`. Clear the inactive
      // terminal field explicitly so queued/running tasks always reach a
      // durable terminal state in the real runtime, not only in fake DB tests.
      result: terminal.status === 'succeeded' ? terminal.payload : null,
      error: terminal.status === 'failed' ? terminal.payload : null,
      completedAt,
      updatedAt: completedAt,
    });
  })();
  if (context.waitUntil) context.waitUntil(work);
  else void work.catch((error) => console.error('[mcp] async task runner failed:', error));
  return toolJson({ async_task: publicAsyncTask(context, task) });
}

async function runAsyncTask(
  context: FunctionContext,
  grant: McpOAuthGrant,
  operationName: string,
  workspaceId: string,
  run: () => Promise<unknown>,
) {
  return queueAsyncTask(context, grant, operationName, workspaceId, async () => ({
    status: 'succeeded',
    payload: await run(),
  }));
}

async function getAsyncTask(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const taskId = textValue(args.task_id);
  if (!taskId) return toolError('task_id is required.');
  const task = await asyncTaskForGrant(context, grant, taskId);
  if (!task) {
    return toolError('async_task_not_found', { task_id: taskId });
  }
  const workspaceId = textValue(task.operation?.workspace_id);
  if (workspaceId) {
    const selected = await requireWorkspaceArgument(
      context,
      grant,
      { workspace_id: workspaceId },
      '_notion_get_async_task',
    );
    if ('error' in selected) return selected.error;
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

function requireMcpReplaceContent(args: Record<string, unknown>) {
  const markdown = args.new_str ?? args.content;
  if (typeof markdown !== 'string') {
    throw new Error('replace_content requires new_str or content to be a string.');
  }
  assertMcpMarkdownBounds(markdown);
  return markdown;
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

function directNotionUserMatchesQuery(user: unknown, query: unknown) {
  const needle = textValue(query).toLowerCase();
  if (!needle || !isRecord(user)) return true;
  const person = isRecord(user.person) ? user.person : null;
  return `${textValue(user.name)}\n${textValue(user.id)}\n${textValue(person?.email)}`
    .toLowerCase()
    .includes(needle);
}

async function getUsers(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  requireGrantScope(grant, ['workspace:read']);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_get_users');
  if ('error' in selected) return selected.error;
  const userId = textValue(args.user_id);
  if (userId === 'self') {
    const user = await callNotionCompat(context, grant, 'GET', 'users/me', undefined, {
      workspace_id: selected.workspaceId,
    });
    return toolJson({
      object: 'list',
      type: 'user',
      user: {},
      results: directNotionUserMatchesQuery(user, args.query) ? [user] : [],
      has_more: false,
      next_cursor: null,
    });
  }
  if (userId) {
    const user = await callNotionCompat(
      context,
      grant,
      'GET',
      `users/${encodeURIComponent(userId)}`,
      undefined,
      { workspace_id: selected.workspaceId },
    );
    return toolJson({
      object: 'list',
      type: 'user',
      user: {},
      results: directNotionUserMatchesQuery(user, args.query) ? [user] : [],
      has_more: false,
      next_cursor: null,
    });
  }
  const payload = await callNotionCompat(context, grant, 'GET', 'users', undefined, {
    workspace_id: selected.workspaceId,
    query: args.query,
    start_cursor: args.start_cursor,
    page_size: args.page_size,
  });
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error('User list response was malformed.');
  }
  return toolJson(payload);
}

function notionSearchDateKey(value: unknown) {
  const raw = textValue(value);
  if (!raw) return '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : raw.slice(0, 10);
}

function notionSearchCreatorId(entity: Record<string, unknown>) {
  const createdBy = isRecord(entity.created_by) ? entity.created_by : null;
  return textValue(createdBy?.id ?? entity.createdBy ?? entity.createdById ?? entity.authorId);
}

function matchesNotionSearchFilters(entity: Record<string, unknown>, filters: unknown) {
  if (filters === undefined) return true;
  if (!isRecord(filters)) throw new Error('filters must be an object.');
  if (filters.created_date_range !== undefined) {
    if (!isRecord(filters.created_date_range)) throw new Error('filters.created_date_range must be an object.');
    const start = textValue(filters.created_date_range.start_date);
    const end = textValue(filters.created_date_range.end_date);
    const created = notionSearchDateKey(entity.created_time ?? entity.createdAt ?? entity.createdTime);
    if (!created || (start && created < start.slice(0, 10)) || (end && created > end.slice(0, 10))) return false;
  }
  if (filters.created_by_user_ids !== undefined) {
    if (!Array.isArray(filters.created_by_user_ids)) {
      throw new Error('filters.created_by_user_ids must be an array.');
    }
    const ids = filters.created_by_user_ids.map((value) => textValue(value)).filter(Boolean);
    if (ids.length && !ids.includes(notionSearchCreatorId(entity))) return false;
  }
  const objectType = textValue(filters.value).toLowerCase();
  const type = entity.kind === 'database' || entity.object === 'database' || entity.object === 'data_source'
    ? 'database'
    : 'page';
  return !objectType || objectType === type;
}

function notionSearchPropertyTexts(entity: Record<string, unknown>) {
  if (!isRecord(entity.properties)) return [];
  return Object.values(entity.properties).flatMap((property) => {
    if (!isRecord(property)) return [];
    const value = notionSqlPropertyValue(property);
    if (Array.isArray(value)) return [value.join(', ')];
    if (value == null || typeof value === 'object') return [];
    return [String(value)];
  }).filter(Boolean);
}

function compactNotionSearchResult(
  context: FunctionContext,
  entity: Record<string, unknown>,
  query: string,
  maxHighlightLength: number,
  workspaceId: string,
) {
  const titleProperty = isRecord(entity.properties)
    ? Object.values(entity.properties).find((property) => isRecord(property) && property.type === 'title')
    : null;
  const title = textValue(entity.title)
    || notionRichTextPlain(entity.title)
    || (isRecord(titleProperty) ? notionRichTextPlain(titleProperty.title) : '')
    || 'Untitled';
  const values = [title, ...notionSearchPropertyTexts(entity)];
  const needle = query.toLowerCase();
  const matchedSource = needle
    ? values.find((value) => value.toLowerCase().includes(needle))
    : title;
  if (matchedSource === undefined) return null;
  const source = matchedSource;
  const id = textValue(entity.id);
  const type = entity.kind === 'database' || entity.object === 'database' || entity.object === 'data_source'
    ? 'database'
    : 'page';
  return {
    id,
    title,
    url: textValue(entity.url) || new URL(`/p/${encodeURIComponent(id)}`, endpointUrls(context).origin).toString(),
    type,
    workspace_id: workspaceId,
    highlight: maxHighlightLength === 0 ? '' : source.slice(0, maxHighlightLength),
    timestamp: entity.last_edited_time ?? entity.updatedAt ?? entity.created_time ?? entity.createdAt ?? null,
  };
}

const HOSTED_DATA_SOURCE_SEARCH_MAX_PAGES = 50;
const HOSTED_WORKSPACE_SEARCH_MAX_WINDOWS = 10;
const HOSTED_WORKSPACE_SEARCH_CURSOR_MAX_BYTES = 16 * 1024;

type HostedWorkspaceSearchPhase = 'metadata' | 'body';

type HostedWorkspaceSearchCursor = {
  v: 1;
  kind: 'mcpWorkspaceSearch';
  fingerprint: string;
  phase: HostedWorkspaceSearchPhase;
  sourceCursor?: string;
  revision?: string;
};

function nativeSearchValueTexts(value: unknown) {
  const texts: string[] = [];
  const seen = new Set<object>();
  let remainingValues = 512;
  let remainingCharacters = 64 * 1024;
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 8 || remainingValues <= 0 || remainingCharacters <= 0 || candidate == null) return;
    if (
      typeof candidate === 'string'
      || typeof candidate === 'number'
      || typeof candidate === 'boolean'
    ) {
      const text = String(candidate).trim().slice(0, remainingCharacters);
      if (!text) return;
      texts.push(text);
      remainingValues -= 1;
      remainingCharacters -= text.length;
      return;
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    const values = Array.isArray(candidate)
      ? candidate
      : Object.values(candidate as Record<string, unknown>);
    for (const item of values) visit(item, depth + 1);
  };
  visit(value, 0);
  return texts;
}

function nativePageSearchTexts(page: PageRecord) {
  return [textValue(page.title, 'Untitled'), ...nativeSearchValueTexts(page.properties)];
}

function nativeBlockSearchText(block: BlockRecord) {
  const content = isRecord(block.content) ? block.content : {};
  return [
    textValue(block.plainText),
    notionRichTextPlain(content.rich),
    notionRichTextPlain(content.caption),
    textValue(content.expression),
    textValue(content.fileName),
  ].filter(Boolean).join(' ');
}

function compactNativeSearchResult(
  context: FunctionContext,
  page: PageRecord,
  query: string,
  maxHighlightLength: number,
  workspaceId: string,
  bodyText?: string,
) {
  const title = textValue(page.title, 'Untitled');
  const needle = query.toLowerCase();
  const source = bodyText
    ?? nativePageSearchTexts(page).find((value) => value.toLowerCase().includes(needle))
    ?? title;
  return {
    id: page.id,
    title,
    url: new URL(`/p/${encodeURIComponent(page.id)}`, endpointUrls(context).origin).toString(),
    type: page.kind === 'database' ? 'database' : 'page',
    workspace_id: workspaceId,
    highlight: maxHighlightLength === 0 ? '' : source.slice(0, maxHighlightLength),
    timestamp: page.updatedAt ?? page.createdAt ?? null,
  };
}

function parseHostedWorkspaceSearchCursor(
  value: unknown,
  fingerprint: string,
): HostedWorkspaceSearchCursor {
  if (
    !isRecord(value)
    || value.v !== 1
    || value.kind !== 'mcpWorkspaceSearch'
    || value.fingerprint !== fingerprint
    || (value.phase !== 'metadata' && value.phase !== 'body')
  ) {
    throw Object.assign(
      new Error('Workspace search cursor does not match this request.'),
      { status: 400 },
    );
  }
  const sourceCursor = value.sourceCursor === undefined
    ? undefined
    : textValue(value.sourceCursor);
  const revision = value.revision === undefined ? undefined : textValue(value.revision);
  if (
    (value.sourceCursor !== undefined
      && (!sourceCursor || new TextEncoder().encode(sourceCursor).byteLength > HOSTED_WORKSPACE_SEARCH_CURSOR_MAX_BYTES))
    || (value.revision !== undefined && !revision)
  ) {
    throw Object.assign(new Error('Workspace search cursor is malformed.'), { status: 400 });
  }
  return {
    v: 1,
    kind: 'mcpWorkspaceSearch',
    fingerprint,
    phase: value.phase,
    ...(sourceCursor ? { sourceCursor } : {}),
    ...(revision ? { revision } : {}),
  };
}

async function hostedWorkspaceSearchFingerprint(
  grant: McpOAuthGrant,
  args: Record<string, unknown>,
  workspaceId: string,
  query: string,
  size: number,
  maxHighlightLength: number,
  requiredAncestorIds: string[],
) {
  return await mcpSqlStreamFingerprint({
    v: 1,
    kind: 'mcpWorkspaceSearch',
    grantId: grant.id,
    grantUserId: grant.userId,
    grantScopes: [...(grant.scopes ?? [])].sort(),
    workspaceId,
    query,
    size,
    maxHighlightLength,
    filters: args.filters ?? null,
    pageUrl: textValue(args.page_url) || null,
    contentSearchMode: textValue(args.content_search_mode) || 'workspace_search',
    requiredAncestorIds,
  });
}

async function hostedWorkspaceSearch(
  context: FunctionContext,
  grant: McpOAuthGrant,
  args: Record<string, unknown>,
  workspaceId: string,
  query: string,
  size: number,
  maxHighlightLength: number,
  requiredAncestorIds: string[],
) {
  const fingerprint = await hostedWorkspaceSearchFingerprint(
    grant,
    args,
    workspaceId,
    query,
    size,
    maxHighlightLength,
    requiredAncestorIds,
  );
  const cursor = args.start_cursor === undefined
    ? undefined
    : parseHostedWorkspaceSearchCursor(
        await decodeSearchSourceCursor(args.start_cursor, context.env),
        fingerprint,
      );
  let phase: HostedWorkspaceSearchPhase = cursor?.phase ?? 'metadata';
  let sourceCursor = cursor?.sourceCursor;
  let expectedRevision = cursor?.revision;
  const results: Record<string, unknown>[] = [];
  const seenCursors = new Set(sourceCursor ? [`${phase}:${sourceCursor}`] : []);
  let nextState: HostedWorkspaceSearchCursor | undefined;

  for (let window = 0; window < HOSTED_WORKSPACE_SEARCH_MAX_WINDOWS; window += 1) {
    const remaining = Math.max(0, size - results.length);
    const sourceLimit = Math.max(1, remaining);
    const requestedCursor = sourceCursor;
    const payload = await callProductFunction(
      context,
      grant,
      'page-query',
      phase === 'metadata'
        ? {
            action: 'searchPages',
            workspaceId,
            query,
            limit: sourceLimit,
            includePaginationMeta: true,
            ...(requiredAncestorIds.length ? { requiredAncestorIds } : {}),
            ...(requestedCursor ? { sourceCursor: requestedCursor } : {}),
          }
        : {
            action: 'searchBlocks',
            workspaceId,
            query,
            limit: sourceLimit,
            includePaginationMeta: true,
            dedupePages: true,
            excludeMetadataMatches: true,
            includePages: true,
            ...(requiredAncestorIds.length ? { requiredAncestorIds } : {}),
            ...(requestedCursor ? { sourceCursor: requestedCursor } : {}),
          },
      pageQueryHandler,
    );
    if (!isRecord(payload)) throw new Error('Workspace search source response was malformed.');
    const revision = textValue(payload.revision);
    if (!revision || (expectedRevision && revision !== expectedRevision)) {
      throw Object.assign(
        new Error('Workspace search source changed while the cursor was in use. Restart the search.'),
        { status: 409 },
      );
    }
    expectedRevision = undefined;
    const items = phase === 'metadata' ? payload.pages : payload.blocks;
    if (!Array.isArray(items) || items.length > sourceLimit || typeof payload.hasMore !== 'boolean') {
      throw new Error('Workspace search source response was malformed.');
    }
    const pagesById = phase === 'body'
      ? new Map(
          (Array.isArray(payload.pages) ? payload.pages : [])
            .filter((page): page is PageRecord => isRecord(page) && !!textValue(page.id))
            .map((page) => [page.id, page]),
        )
      : null;

    for (const item of items) {
      const page = phase === 'metadata'
        ? (isRecord(item) ? item as unknown as PageRecord : null)
        : (
            isRecord(item)
              ? pagesById?.get(textValue(item.pageId)) ?? null
              : null
          );
      if (!page || !textValue(page.id)) {
        throw new Error('Workspace search source response was malformed.');
      }
      if (!matchesNotionSearchFilters(page as unknown as Record<string, unknown>, args.filters)) continue;
      if (results.length >= size) {
        nextState = {
          v: 1,
          kind: 'mcpWorkspaceSearch',
          fingerprint,
          phase,
          ...(requestedCursor ? { sourceCursor: requestedCursor } : {}),
          revision,
        };
        break;
      }
      const bodyText = phase === 'body' && isRecord(item)
        ? nativeBlockSearchText(item as unknown as BlockRecord)
        : undefined;
      results.push(compactNativeSearchResult(
        context,
        page,
        query,
        maxHighlightLength,
        workspaceId,
        bodyText,
      ));
    }
    if (nextState) break;

    if (payload.hasMore === true) {
      const nextCursor = textValue(payload.nextCursor);
      const cursorKey = `${phase}:${nextCursor}`;
      if (
        !nextCursor
        || new TextEncoder().encode(nextCursor).byteLength > HOSTED_WORKSPACE_SEARCH_CURSOR_MAX_BYTES
        || seenCursors.has(cursorKey)
      ) {
        throw new Error('Workspace search source pagination did not advance.');
      }
      seenCursors.add(cursorKey);
      sourceCursor = nextCursor;
      if (results.length >= size || window + 1 >= HOSTED_WORKSPACE_SEARCH_MAX_WINDOWS) {
        nextState = {
          v: 1,
          kind: 'mcpWorkspaceSearch',
          fingerprint,
          phase,
          sourceCursor,
        };
      }
      if (nextState) break;
      continue;
    }
    if (payload.nextCursor !== undefined) {
      throw new Error('Workspace search source pagination was malformed.');
    }
    if (phase === 'metadata') {
      phase = 'body';
      sourceCursor = undefined;
      if (window + 1 >= HOSTED_WORKSPACE_SEARCH_MAX_WINDOWS) {
        nextState = {
          v: 1,
          kind: 'mcpWorkspaceSearch',
          fingerprint,
          phase,
        };
      }
      if (nextState) break;
      continue;
    }
    break;
  }

  return {
    results,
    hasMore: nextState !== undefined,
    nextCursor: nextState
      ? await encodeSearchSourceCursor(nextState, context.env)
      : null,
  };
}

async function searchNotion(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const selected = await requireWorkspaceArgument(context, grant, args, '_search');
  if ('error' in selected) return selected.error;
  const query = textValue(args.query);
  const size = pageSize(args.page_size, 10, 25);
  const requestedHighlight = typeof args.max_highlight_length === 'number'
    ? Math.floor(args.max_highlight_length)
    : 200;
  const maxHighlightLength = Math.max(0, Math.min(1000, requestedHighlight));
  // User search is directory metadata, not content search. Conversely,
  // workspace:read must never satisfy any page/database search branch.
  if (args.query_type === 'user') {
    requireGrantScope(grant, ['workspace:read']);
    const payload = await callNotionCompat(context, grant, 'GET', 'users', undefined, {
      workspace_id: selected.workspaceId,
      query,
      start_cursor: args.start_cursor,
      page_size: size,
    });
    if (!isRecord(payload)
      || payload.object !== 'list'
      || payload.type !== 'user'
      || !isRecord(payload.user)
      || !Array.isArray(payload.results)
      || payload.results.length > size
      || payload.results.some((user) => {
        if (!isRecord(user)
          || user.object !== 'user'
          || user.type !== 'person'
          || !textValue(user.id)
          || !textValue(user.name)
          || !isRecord(user.person)) {
          return true;
        }
        return user.person.email !== undefined && !textValue(user.person.email);
      })) {
      throw new Error('User search response was malformed.');
    }
    const userResults = payload.results as Record<string, unknown>[];
    const hasMore = payload.has_more;
    const nextCursor = payload.next_cursor;
    if (typeof hasMore !== 'boolean'
      || (hasMore
        ? userResults.length === 0
          || textValue(nextCursor) !== textValue(userResults[userResults.length - 1].id)
        : nextCursor !== null)) {
      throw new Error('User search pagination response was malformed.');
    }
    const users = userResults.map((user) => {
      const person = isRecord(user.person) ? user.person : {};
      return {
        id: textValue(user.id),
        title: textValue(user.name, textValue(user.id, 'Hanji user')),
        type: 'user',
        email: textValue(person.email) || undefined,
        workspace_id: selected.workspaceId,
      };
    });
    return toolJson({
      type: 'user',
      results: users,
      has_more: hasMore,
      next_cursor: hasMore ? textValue(nextCursor) : null,
    });
  }
  const start = cursorOffset(args.start_cursor);
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
    const matches: Record<string, unknown>[] = [];
    let cursor: unknown;
    let requestStatus: Record<string, unknown> | null = null;
    const seenUpstreamCursors = new Set<string>();
    for (
      let page = 0;
      page < HOSTED_DATA_SOURCE_SEARCH_MAX_PAGES && matches.length <= start + size;
      page += 1
    ) {
      const payload = await callNotionCompat(context, grant, 'POST', `data_sources/${dataSourceId}/query`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      if (!isRecord(payload)
        || !Array.isArray(payload.results)
        || payload.results.some((row) => !isRecord(row)
          || row.object !== 'page'
          || !textValue(row.id))) {
        throw new Error('Data source search response was malformed.');
      }
      const rows = payload.results as Record<string, unknown>[];
      if (isRecord(payload.request_status) && payload.request_status.type === 'incomplete') {
        requestStatus = payload.request_status;
      }
      for (const row of rows) {
        if (!matchesNotionSearchFilters(row, args.filters)) continue;
        const compact = compactNotionSearchResult(context, row, query, maxHighlightLength, selected.workspaceId);
        if (!compact) continue;
        matches.push(compact);
      }
      if (payload.has_more !== true) break;
      const nextCursor = textValue(payload.next_cursor);
      if (!nextCursor || seenUpstreamCursors.has(nextCursor)) {
        throw new Error('Data source search pagination was malformed.');
      }
      if (matches.length > start + size) break;
      if (page + 1 >= HOSTED_DATA_SOURCE_SEARCH_MAX_PAGES) {
        requestStatus = {
          type: 'incomplete',
          incomplete_reason: 'search_scan_limit_reached',
        };
        break;
      }
      seenUpstreamCursors.add(nextCursor);
      cursor = nextCursor;
    }
    const windowed = matches.slice(start, start + size);
    const hasMore = start + size < matches.length;
    return toolJson({
      type: 'workspace_search',
      results: windowed,
      has_more: hasMore,
      next_cursor: hasMore ? String(start + size) : null,
      data_source_id: dataSourceId,
      ...(requestStatus ? { request_status: requestStatus } : {}),
      scope: { provider: 'hanji', workspace_id: selected.workspaceId },
    });
  }

  // This endpoint returns a mixed page/database collection. Requiring both
  // read scopes is intentionally stricter than an OR guard: neither scope may
  // reveal the other content family. Resource-scoped grants use a local
  // allowlist projection so the compatibility search cannot leak sibling
  // resources or pagination metadata outside the grant.
  requireAllGrantScopes(grant, ['pages:read', 'databases:read']);
  const pageScopeId = stripHanjiId(args.page_url);
  if (pageScopeId) {
    await requirePageInWorkspace(context, grant, selected.workspaceId, pageScopeId, 'Page');
  }
  if (args.filters !== undefined) matchesNotionSearchFilters({}, args.filters);
  const grantAllowlist = grantResourceAllowlist(grant);
  const requiredAncestorIds = pageScopeId
    ? [pageScopeId]
    : grantAllowlist
      ? Array.from(grantAllowlist).sort()
      : [];
  const window = await hostedWorkspaceSearch(
    context,
    grant,
    args,
    selected.workspaceId,
    query,
    size,
    maxHighlightLength,
    requiredAncestorIds,
  );
  return toolJson({
    object: 'list',
    type: 'workspace_search',
    results: window.results,
    has_more: window.hasMore,
    next_cursor: window.nextCursor,
    scope: {
      provider: 'hanji',
      access_model: grantResourceAllowlist(grant) ? 'resource_allowlist' : 'account_accessible_workspaces',
      workspace_id: selected.workspaceId,
      page_url: pageScopeId ? args.page_url : undefined,
      requested_content_search_mode: args.content_search_mode ?? 'workspace_search',
      effective_content_search_mode: 'workspace_search',
      note: args.content_search_mode === 'ai_search'
        ? 'Hanji does not provide a separate Notion AI or connected-source search layer; searched Hanji workspace data.'
        : undefined,
    },
  });
}

async function fetchMeetingTranscriptsForPage(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  pageId: string,
) {
  const payload = await callNotionCompat(context, grant, 'POST', 'blocks/meeting_notes/query', {
    workspace_id: workspaceId,
    page_id: pageId,
    include_transcript: true,
    limit: 50,
  });
  if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
  const results: Record<string, unknown>[] = [];
  for (const candidate of payload.results) {
    if (!isRecord(candidate)) continue;
    const blockId = textValue(candidate.id);
    if (!blockId) continue;
    const note = await requireBlockInWorkspace(
      context,
      grant,
      workspaceId,
      blockId,
      'Meeting note',
    );
    if (note.page.id !== pageId) throw new Error('Meeting note was not found.');
    requireContentScope(grant, note.page, 'read');
    const transcript = isRecord(candidate.transcript) ? candidate.transcript : null;
    const transcriptBlockId = textValue(transcript?.block_id);
    if (transcriptBlockId) {
      const transcriptBlock = await requireBlockInWorkspace(
        context,
        grant,
        workspaceId,
        transcriptBlockId,
        'Meeting transcript',
      );
      if (transcriptBlock.page.id !== pageId) throw new Error('Meeting transcript was not found.');
      requireContentScope(grant, transcriptBlock.page, 'read');
    }
    results.push(candidate);
  }
  return results;
}

function hostedMeetingNoteLimit(value: unknown) {
  if (value === undefined) return MAX_MCP_MEETING_NOTE_RESULTS;
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > MAX_MCP_MEETING_NOTE_RESULTS
  ) {
    throw new Error(`limit must be an integer between 1 and ${MAX_MCP_MEETING_NOTE_RESULTS}.`);
  }
  return value;
}

async function meetingNoteAuthorityGraph(
  context: FunctionContext,
  workspaceId: string,
  blockIds: string[],
) {
  const db = boundedDb(context.admin, workspaceId);
  const blocks = blockIds.length === 0
    ? []
    : await listAll(
      db.table<BlockRecord>('blocks').where('id', 'in', blockIds),
      { label: 'Hosted MCP meeting-note authority blocks' },
    );
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const pagesById = new Map<string, PageRecord | null>();
  const pendingPageIds = new Set(
    blocks.map((block) => textValue(block.pageId)).filter(Boolean),
  );

  while (pendingPageIds.size > 0) {
    if (pagesById.size + pendingPageIds.size > MAX_MCP_MEETING_NOTE_AUTHORITY_PAGES) {
      throw new Error(
        `Meeting-note authority graph exceeds ${MAX_MCP_MEETING_NOTE_AUTHORITY_PAGES} pages.`,
      );
    }
    const batch = Array.from(pendingPageIds).slice(0, MAX_MCP_MEETING_NOTE_RESULTS);
    for (const id of batch) pendingPageIds.delete(id);
    const pages = await listAll(
      db.table<PageRecord>('pages').where('id', 'in', batch),
      { label: 'Hosted MCP meeting-note authority pages' },
    );
    const batchById = new Map(pages.map((page) => [page.id, page]));
    for (const id of batch) pagesById.set(id, batchById.get(id) ?? null);
    for (const page of pages) {
      const parentId = textValue(page.parentId);
      if (parentId && !pagesById.has(parentId)) pendingPageIds.add(parentId);
    }
  }
  return { blocksById, pagesById };
}

function meetingNotePageWithinLoadedAllowlist(
  grant: McpOAuthGrant,
  workspaceId: string,
  page: PageRecord,
  pagesById: Map<string, PageRecord | null>,
) {
  const allowlist = grantResourceAllowlist(grant);
  if (!allowlist) return true;
  const visited = new Set<string>();
  let current: PageRecord | null = page;
  while (current && !visited.has(current.id)) {
    if (current.workspaceId !== workspaceId) return false;
    if (allowlist.has(current.id)) return true;
    visited.add(current.id);
    const parentId = textValue(current.parentId);
    if (!parentId) break;
    current = pagesById.get(parentId) ?? null;
  }
  return false;
}

async function filterHostedMeetingNotes(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  payload: unknown,
  limit: number,
) {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return payload;
  if (payload.results.length > MAX_MCP_MEETING_NOTE_RESULTS) {
    throw new Error(
      `Meeting-note query returned more than ${MAX_MCP_MEETING_NOTE_RESULTS} results.`,
    );
  }
  const candidates = payload.results.filter(isRecord);
  const blockIds = Array.from(new Set(
    candidates.map((candidate) => textValue(candidate.id)).filter(Boolean),
  ));
  const { blocksById, pagesById } = await meetingNoteAuthorityGraph(
    context,
    workspaceId,
    blockIds,
  );
  const authorized = candidates.filter((candidate) => {
    const block = blocksById.get(textValue(candidate.id));
    const page = block ? pagesById.get(block.pageId) : null;
    if (!block || !page || page.workspaceId !== workspaceId) return false;
    const scope = contentScopeName(contentScopeFamily(page), 'read');
    if (!hasScope(grant, [scope])) return false;
    return meetingNotePageWithinLoadedAllowlist(grant, workspaceId, page, pagesById);
  });
  const unrestricted = !grantResourceAllowlist(grant)
    && hasAllScopes(grant, ['pages:read', 'databases:read']);
  return {
    results: authorized.slice(0, limit),
    has_more: authorized.length > limit || (unrestricted && payload.has_more === true),
  };
}

function attachmentExtension(filename: string) {
  const match = filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

function inlineAttachmentContentType(filename: string, requested: unknown) {
  const inferred = MCP_TEXT_ATTACHMENT_TYPES.get(attachmentExtension(filename));
  if (!inferred) {
    throw new Error('Inline attachments support .md, .markdown, .txt, .csv, .json, .yaml, .yml, .tsv, and .ics files. Use source_url for other safe file types.');
  }
  const explicit = textValue(requested).split(';', 1)[0]?.trim().toLowerCase();
  if (explicit && explicit !== inferred) {
    throw new Error(`content_type must match ${filename} (${inferred}).`);
  }
  return inferred;
}

function attachmentToolPayload(upload: AttachmentUploadRecord, originalName: string) {
  const marker = attachmentGrantMarker(upload);
  return {
    object: 'file_upload',
    id: upload.id,
    file_upload_id: upload.id,
    filename: originalName,
    content_type: upload.contentType ?? null,
    content_length: upload.size ?? null,
    status: upload.status ?? null,
    expiry_time: marker?.expires_at ?? upload.expiresAt ?? null,
    markdown_source: `<file src="file-upload://${upload.id}">`,
  };
}

async function markAttachmentGrant(
  context: FunctionContext,
  workspaceId: string,
  uploadId: string,
  grant: McpOAuthGrant,
  originalName: string,
) {
  const table = boundedDb(context.admin, workspaceId).table<AttachmentUploadRecord>('file_uploads');
  const current = await table.getOne(uploadId);
  if (!current) throw new Error('Attachment upload was not found after creation.');
  const priorResult = isRecord(current.fileImportResult) ? current.fileImportResult : {};
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + MCP_ATTACHMENT_TTL_MS).toISOString();
  return await table.update(uploadId, {
    expiresAt,
    fileImportResult: {
      ...priorResult,
      mcp_attachment: {
        grant_id: grant.id,
        original_name: originalName,
        created_at: createdAt,
        expires_at: expiresAt,
      },
    },
  });
}

function attachmentGrantMarker(upload: AttachmentUploadRecord | null | undefined) {
  const result = isRecord(upload?.fileImportResult) ? upload.fileImportResult : null;
  return isRecord(result?.mcp_attachment) ? result.mcp_attachment : null;
}

async function createAttachment(
  context: FunctionContext,
  grant: McpOAuthGrant,
  args: Record<string, unknown>,
) {
  requireGrantWrite(grant, ['files:write']);
  const selected = await requireWorkspaceArgument(context, grant, args, 'notion-create-attachment');
  if ('error' in selected) return selected.error;
  const filename = textValue(args.filename);
  if (!filename) return toolError('filename is required.');
  const hasContent = typeof args.content === 'string';
  const sourceUrl = textValue(args.source_url);
  if (hasContent === !!sourceUrl) {
    return toolError('Provide exactly one of content or source_url.');
  }
  const internalContext = {
    ...context,
    auth: { id: grant.userId, email: null },
  };
  let upload: AttachmentUploadRecord | null = null;
  try {
    if (hasContent) {
      const bytes = mcpUtf8Encoder.encode(args.content as string);
      if (bytes.byteLength === 0) throw new Error('content must not be empty.');
      if (bytes.byteLength > MAX_MCP_INLINE_ATTACHMENT_BYTES) {
        throw new Error('Inline attachment content must be at most 200 KiB after UTF-8 encoding.');
      }
      const contentType = inlineAttachmentContentType(filename, args.content_type);
      const created = await createNotionFileUpload(internalContext, {
        workspaceId: selected.workspaceId,
        filename,
        contentType,
        mode: 'single_part',
        scope: 'uploads',
      }) as { upload: AttachmentUploadRecord };
      upload = created.upload;
      const sent = await sendNotionFileUpload(internalContext, upload.id, {
        workspaceId: selected.workspaceId,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        filename,
        contentType,
      }) as { upload: AttachmentUploadRecord };
      upload = await markAttachmentGrant(context, selected.workspaceId, sent.upload.id, grant, filename);
    } else {
      if (!/^https:\/\//i.test(sourceUrl)) throw new Error('source_url must be a public HTTPS URL.');
      const created = await createNotionFileUpload(internalContext, {
        workspaceId: selected.workspaceId,
        filename,
        contentType: textValue(args.content_type) || 'application/octet-stream',
        mode: 'external_url',
        externalUrl: sourceUrl,
        scope: 'uploads',
      }) as { upload: AttachmentUploadRecord };
      upload = created.upload;
      if (typeof upload.size !== 'number' || upload.size <= 0 || upload.size > MAX_MCP_URL_ATTACHMENT_BYTES) {
        throw new Error('URL attachment downloads must be non-empty and at most 5 MiB.');
      }
      upload = await markAttachmentGrant(context, selected.workspaceId, upload.id, grant, filename);
    }
    return toolJson(attachmentToolPayload(upload, filename));
  } catch (error) {
    if (upload?.id) {
      await deleteNotionFileUpload(internalContext, upload.id, selected.workspaceId).catch(() => {});
    }
    throw error;
  }
}

async function attachmentForGrant(
  context: FunctionContext,
  grant: McpOAuthGrant,
  uploadId: string,
) {
  const db = context.admin.db('app');
  for (const workspace of await grantAccessibleWorkspaces(db, grant)) {
    const upload = await boundedDb(context.admin, workspace.id)
      .table<AttachmentUploadRecord>('file_uploads')
      .getOne(uploadId)
      .catch(() => null);
    const marker = attachmentGrantMarker(upload);
    if (textValue(marker?.grant_id) !== grant.id) continue;
    await assertMcpClientApprovedForWorkspaces(db, [workspace], {
      actorId: grant.userId,
      clientId: grant.clientId,
      clientName: grant.clientName,
      grantId: grant.id,
      stage: 'hosted_call',
    });
    const attached = !!(upload?.pageId || upload?.blockId || upload?.databaseId || upload?.propertyId || upload?.templateId);
    const expiry = Date.parse(textValue(marker?.expires_at, textValue(upload?.expiresAt)));
    if (!attached && Number.isFinite(expiry) && Date.now() >= expiry) continue;
    return upload;
  }
  return null;
}

async function downloadAttachment(
  context: FunctionContext,
  grant: McpOAuthGrant,
  args: Record<string, unknown>,
) {
  requireGrantScope(grant, ['files:read']);
  const uploadId = textValue(args.file_upload_id);
  if (!uploadId) return toolError('file_upload_id is required.');
  const upload = await attachmentForGrant(context, grant, uploadId);
  if (!upload || upload.status !== 'uploaded') return toolError('Attachment was not found.');
  const marker = attachmentGrantMarker(upload);
  const filename = textValue(marker?.original_name) || upload.name || 'attachment.txt';
  if (!MCP_TEXT_ATTACHMENT_TYPES.has(attachmentExtension(filename))) {
    return toolError('Only supported UTF-8 text attachments can be downloaded through this tool.');
  }
  if (typeof upload.size !== 'number' || upload.size < 0 || upload.size > MAX_MCP_INLINE_ATTACHMENT_BYTES) {
    return toolError('Attachment is larger than the 200 KiB text download limit.');
  }
  const signed = await callProductFunction(context, grant, 'file-mutation', {
    action: 'signedUrl',
    workspaceId: upload.workspaceId,
    uploadId: upload.id,
    expiresIn: '5m',
  }, fileMutationHandler) as { url?: unknown };
  const url = textValue(signed.url);
  if (!url) throw new Error('Attachment download URL was not available.');
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Attachment download URL unexpectedly redirected.');
  }
  if (!response.ok) throw new Error(`Attachment download returned HTTP ${response.status}.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_MCP_INLINE_ATTACHMENT_BYTES || bytes.byteLength !== upload.size) {
    throw new Error('Attachment download failed its size verification.');
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Attachment is not valid UTF-8 text.');
  }
  return toolJson({
    file_upload_id: upload.id,
    filename,
    content_type: upload.contentType ?? null,
    content,
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
    const transcripts = args.include_transcript === true
      ? await fetchMeetingTranscriptsForPage(context, grant, selected.workspaceId, id)
      : undefined;
    return toolJson({
      metadata: { type: isRecord(page) ? page.object : 'page', workspace_id: selected.workspaceId },
      page,
      blocks,
      ...(transcripts ? { transcripts } : {}),
    });
  }
  const ownedBlock = await requireBlockInWorkspace(context, grant, selected.workspaceId, id, 'Page');
  requireContentScope(grant, ownedBlock.page, 'read');
  const block = await callNotionCompat(context, grant, 'GET', `blocks/${id}`);
  const children = await callNotionCompat(context, grant, 'GET', `blocks/${id}/children`, undefined, { page_size: 100 }).catch(() => null);
  const transcripts = args.include_transcript === true
    ? await fetchMeetingTranscriptsForPage(context, grant, selected.workspaceId, ownedBlock.page.id)
    : undefined;
  return toolJson({
    metadata: { type: 'block', workspace_id: selected.workspaceId },
    block,
    children,
    ...(transcripts ? { transcripts } : {}),
  });
}

function notionRichTextPlain(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    if (!isRecord(item)) return '';
    if (typeof item.plain_text === 'string') return item.plain_text;
    if (isRecord(item.text) && typeof item.text.content === 'string') return item.text.content;
    if (isRecord(item.equation) && typeof item.equation.expression === 'string') return item.equation.expression;
    return '';
  }).join('');
}

function notionSqlPropertyValue(property: Record<string, unknown>) {
  const type = textValue(property.type);
  const value = property[type];
  if (type === 'title' || type === 'rich_text') return notionRichTextPlain(value);
  if (type === 'number') return value ?? null;
  if (type === 'checkbox') return value === true ? '__YES__' : '__NO__';
  if (type === 'select' || type === 'status') return isRecord(value) ? value.name ?? null : null;
  if (type === 'multi_select') return Array.isArray(value)
    ? value.map((option) => isRecord(option) ? option.name : null).filter(Boolean).join(', ')
    : null;
  if (type === 'date') return isRecord(value) ? value.start ?? null : null;
  if (type === 'people') return Array.isArray(value)
    ? value.map((person) => isRecord(person) ? person.id : null).filter(Boolean)
    : [];
  if (type === 'relation') return Array.isArray(value)
    ? value.map((relation) => isRecord(relation) ? relation.id : null).filter(Boolean)
    : [];
  if (type === 'files') return Array.isArray(value)
    ? value.map((file) => {
        if (!isRecord(file)) return null;
        if (isRecord(file.external)) return file.external.url;
        if (isRecord(file.file)) return file.file.url;
        if (isRecord(file.file_upload)) return file.file_upload.id;
        return null;
      }).filter(Boolean)
    : [];
  if (type === 'formula' && isRecord(value)) return value[value.type as string] ?? null;
  if (type === 'rollup' && isRecord(value)) return value[value.type as string] ?? null;
  if (type === 'unique_id' && isRecord(value)) {
    return `${textValue(value.prefix)}${value.number ?? ''}`;
  }
  return value ?? null;
}

function notionSqlRow(page: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    url: textValue(page.url),
    id: textValue(page.id),
    createdTime: page.created_time ?? null,
  };
  if (isRecord(page.properties)) {
    for (const [name, property] of Object.entries(page.properties)) {
      if (isRecord(property)) row[name] = notionSqlPropertyValue(property);
    }
  }
  return row;
}

type McpSqlStreamCursor = {
  v: 1;
  kind: 'mcpSqlStream';
  fingerprint: string;
  sourceCursor?: string;
  projectedOffset: number;
  remainingOffset: number;
};

const MCP_SQL_STREAM_SOURCE_WINDOWS = 10;

type McpSqlSourceSort = {
  direction: 'ascending' | 'descending';
} & ({ property: string } | { timestamp: 'created_time' });

function notionMcpSqlSourceSorts(
  orderBy: Array<{ property: string; direction: 'asc' | 'desc' }>,
  properties: DbPropertyRecord[],
): McpSqlSourceSort[] {
  return orderBy.map((order) => {
    const property = properties.find((candidate) =>
      candidate.name.toLowerCase() === order.property.toLowerCase()
    );
    const direction: McpSqlSourceSort['direction'] = order.direction === 'desc' ? 'descending' : 'ascending';
    if (property) return { property: property.name, direction };
    if (order.property === 'createdTime') return { timestamp: 'created_time', direction };
    throw new Error(`SQL ORDER BY requires a data-source property: ${order.property}.`);
  });
}

function canonicalMcpSqlFingerprintValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalMcpSqlFingerprintValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalMcpSqlFingerprintValue(item)]));
}

async function mcpSqlStreamFingerprint(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonicalMcpSqlFingerprintValue(value))),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseMcpSqlStreamCursor(value: unknown, fingerprint: string): McpSqlStreamCursor {
  if (!isRecord(value) || value.v !== 1 || value.kind !== 'mcpSqlStream' || value.fingerprint !== fingerprint) {
    throw Object.assign(new Error('SQL continuation cursor does not match this query.'), { status: 400 });
  }
  const sourceCursor = value.sourceCursor === undefined ? undefined : textValue(value.sourceCursor);
  const projectedOffset = Number(value.projectedOffset);
  const remainingOffset = Number(value.remainingOffset);
  if (
    (value.sourceCursor !== undefined && !sourceCursor)
    || !Number.isSafeInteger(projectedOffset)
    || projectedOffset < 0
    || projectedOffset > 100
    || !Number.isSafeInteger(remainingOffset)
    || remainingOffset < 0
  ) {
    throw Object.assign(new Error('SQL continuation cursor is malformed.'), { status: 400 });
  }
  return {
    v: 1,
    kind: 'mcpSqlStream',
    fingerprint,
    ...(sourceCursor ? { sourceCursor } : {}),
    projectedOffset,
    remainingOffset,
  };
}

async function streamNotionDataSourceSql(
  context: FunctionContext,
  grant: McpOAuthGrant,
  dataSourceId: string,
  sourceUrl: string,
  parsed: ReturnType<typeof parseNotionMcpSqlUnion>,
  params: unknown[],
  sourceSorts: McpSqlSourceSort[],
  fingerprint: string,
  startCursor: string | undefined,
) {
  const limit = Math.max(0, Math.min(500, parsed.cursor.limit ?? 100));
  if (limit === 0) return { results: [], hasMore: false, nextCursor: undefined };
  const resumed = startCursor
    ? parseMcpSqlStreamCursor(
        await decodeSearchSourceCursor(startCursor, context.env),
        fingerprint,
      )
    : undefined;
  let remainingOffset = resumed?.remainingOffset ?? Math.max(0, parsed.cursor.offset ?? 0);
  const results: Array<Record<string, unknown>> = [];
  let sourceCursor = resumed?.sourceCursor;
  let projectedOffset = resumed?.projectedOffset ?? 0;

  const continuation = async (next: {
    sourceCursor?: string;
    projectedOffset: number;
    remainingOffset: number;
  }) => ({
    results,
    hasMore: true,
    nextCursor: await encodeSearchSourceCursor({
      v: 1,
      kind: 'mcpSqlStream',
      fingerprint,
      ...next,
    } satisfies McpSqlStreamCursor, context.env),
  });

  for (let window = 0; window < MCP_SQL_STREAM_SOURCE_WINDOWS; window += 1) {
    const payload = await callNotionCompat(context, grant, 'POST', `data_sources/${dataSourceId}/query`, {
      page_size: 100,
      ...(sourceSorts.length ? { sorts: sourceSorts } : {}),
      ...(sourceCursor ? { start_cursor: sourceCursor } : {}),
    });
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new Error('Data source query response was malformed.');
    }
    const sourceRows = payload.results.filter(isRecord).map(notionSqlRow);
    const projected = executeStreamableNotionMcpSqlChunk(parsed, params, sourceUrl, sourceRows);
    if (projectedOffset > projected.length) {
      throw Object.assign(new Error('SQL continuation source changed before resume.'), { status: 409 });
    }
    for (let index = projectedOffset; index < projected.length; index += 1) {
      const row = projected[index]!;
      if (remainingOffset > 0) {
        remainingOffset -= 1;
        continue;
      }
      if (results.length >= limit) {
        return await continuation({ sourceCursor, projectedOffset: index, remainingOffset });
      }
      results.push(row);
    }
    projectedOffset = 0;
    if (payload.has_more !== true) return { results, hasMore: false, nextCursor: undefined };
    const nextCursor = textValue(payload.next_cursor);
    if (!nextCursor || nextCursor === sourceCursor) {
      throw new Error('Data source query response returned a non-advancing cursor.');
    }
    sourceCursor = nextCursor;
  }
  return await continuation({ sourceCursor, projectedOffset: 0, remainingOffset });
}

async function queryDataSources(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const data = isRecord(args.data) ? args.data : {};
  const selected = await requireWorkspaceArgument(context, grant, data, '_notion_query_data_sources');
  if ('error' in selected) return selected.error;
  if (data.mode === 'view') {
    return queryDatabaseView(context, grant, { ...data, workspace_id: selected.workspaceId });
  }
  const urls = Array.isArray(data.data_source_urls) ? data.data_source_urls.map((url) => textValue(url)).filter(Boolean) : [];
  if (!urls.length) return toolError('data.data_source_urls must contain at least one collection:// URL.');
  if (urls.length > 10) return toolError('data.data_source_urls may contain at most 10 data sources.');
  if (!Array.isArray(data.params) && data.params !== undefined) return toolError('data.params must be an array.');
  if (data.start_cursor !== undefined && (
    typeof data.start_cursor !== 'string'
    || !data.start_cursor.trim()
  )) return toolError('data.start_cursor must be a non-empty opaque string.');
  const parsed = parseNotionMcpSqlUnion(data.query);
  const declaredIds = new Set(urls.map(collectionIdFromInput).filter(Boolean));
  const references = parsed.dataSourceUrls;
  const sourcesByReference = new Map<string, string>();
  for (const reference of references) {
    const id = collectionIdFromInput(reference);
    if (!id || !declaredIds.has(id)) return toolError(`SQL references an undeclared data source: ${reference}.`);
  }
  const authorityReads = await Promise.allSettled(references.map(async (reference) => {
    const id = collectionIdFromInput(reference)!;
    const source = await requireDatabaseInWorkspace(context, grant, selected.workspaceId, id, 'Data source');
    requireContentScope(grant, source, 'read');
    return { reference, id };
  }));
  for (const authority of authorityReads) {
    if (authority.status === 'rejected') throw authority.reason;
    sourcesByReference.set(authority.value.reference, authority.value.id);
  }
  const params = Array.isArray(data.params) ? data.params : [];
  const streamPlan = notionMcpSqlStreamPlan(parsed);
  if (!streamPlan || references.length !== 1) return toolError(NOTION_MCP_SQL_CROSS_WINDOW_ERROR);
  const reference = references[0]!;
  executeStreamableNotionMcpSqlChunk(parsed, params, reference, []);
  const dataSourceId = sourcesByReference.get(reference)!;
  const sourceSorts = streamPlan.orderBy.length
    ? notionMcpSqlSourceSorts(
        streamPlan.orderBy,
        await databaseProperties(context, dataSourceId),
      )
    : [];
  const fingerprint = await mcpSqlStreamFingerprint({
    v: 1,
    grantId: grant.id,
    userId: grant.userId,
    workspaceId: selected.workspaceId,
    references,
    query: data.query,
    params,
  });
  const execution = await streamNotionDataSourceSql(
    context,
    grant,
    dataSourceId,
    reference,
    parsed,
    params,
    sourceSorts,
    fingerprint,
    textValue(data.start_cursor) || undefined,
  );
  if (execution.hasMore && !execution.nextCursor) {
    throw new Error('SQL source stream returned has_more without a continuation cursor.');
  }
  const nextCursor = execution.nextCursor ?? null;
  return toolJson({
    mode: 'sql',
    data_source_urls: references,
    ...(references.length === 1 ? { data_source_url: references[0] } : {}),
    results: execution.results,
    rows: execution.results,
    returned: execution.results.length,
    has_more: execution.hasMore,
    next_cursor: nextCursor,
  });
}

function localFilterToNotionFilter(props: DbPropertyRecord[], filter: unknown): Record<string, unknown> | null {
  if (!isRecord(filter)) return null;
  const propertyId = textValue(filter.propertyId ?? filter.property);
  const prop = props.find((item) => item.id === propertyId || item.name === propertyId);
  if (!prop) return null;
  const operator = textValue(filter.operator, 'equals');
  const condition: Record<string, unknown> = {};
  let value = filter.value ?? true;
  if (prop.type === 'number' || prop.type === 'unique_id') {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    value = number;
  } else if (prop.type === 'checkbox') {
    if (typeof value !== 'boolean') {
      const normalized = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'checked'].includes(normalized)) value = true;
      else if (['false', '0', 'no', 'unchecked'].includes(normalized)) value = false;
      else return null;
    }
  } else if (prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select') {
    const options = Array.isArray(prop.config?.options) ? prop.config.options : [];
    const option = options.find((candidate) => isRecord(candidate)
      && (candidate.id === value || textValue(candidate.name).toLowerCase() === String(value).trim().toLowerCase()));
    if (isRecord(option) && typeof option.name === 'string') value = option.name;
  }
  condition[operator] = operator === 'is_empty' || operator === 'is_not_empty' ? true : value;
  if (prop.type === 'created_time' || prop.type === 'last_edited_time') {
    return { timestamp: prop.type, [prop.type]: condition };
  }
  const filterType = prop.type === 'person'
    ? 'people'
    : prop.type === 'phone'
      ? 'phone_number'
      : prop.type;
  if (![
    'title', 'rich_text', 'url', 'email', 'phone_number', 'number', 'checkbox',
    'select', 'status', 'multi_select', 'date', 'people', 'created_by',
    'last_edited_by', 'relation', 'files', 'unique_id',
  ].includes(filterType)) return null;
  return {
    property: prop.name,
    [filterType]: condition,
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
  const viewId = notionViewId(data.view_id ?? data.view_url ?? data.database_view_url);
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
  const notionMetadata = isRecord(config.__notionCompat) ? config.__notionCompat : {};
  const savedFilter = isRecord(notionMetadata.filter)
    ? notionMetadata.filter
    : isRecord(config.filter)
      ? config.filter
      : localViewFiltersToNotion(props, config);
  const savedSorts = Array.isArray(notionMetadata.sorts)
    ? notionMetadata.sorts
    : localViewSortsToNotion(props, config);
  const payload = await callNotionCompat(context, grant, 'POST', `data_sources/${database.id}/query`, {
    filter: savedFilter,
    sorts: savedSorts,
    is_archived: data.is_archived === true,
    start_cursor: data.start_cursor,
    page_size: pageSize(data.page_size, 100),
  });
  return toolJson({
    mode: 'view',
    is_archived: data.is_archived === true,
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
          ...(pageInput.content !== undefined
            ? { children: markdownishBlocks(pageInput.content) }
            : {}),
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
  if (args.allow_async === true) {
    return queueAsyncTask(context, grant, 'create_pages', selected.workspaceId, async () => {
      const outcome = await run();
      return { status: outcome.ok ? 'succeeded' : 'failed', payload: outcome.payload };
    });
  }
  const outcome = await run();
  return outcome.ok
    ? toolJson(outcome.payload)
    : toolError('create_pages_failed', outcome.payload);
}

async function updatePage(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const command = textValue(args.command, args.content || args.new_str ? 'insert_content' : 'update_properties');
  if (args.allow_deleting_content !== undefined && typeof args.allow_deleting_content !== 'boolean') {
    throw new Error('allow_deleting_content must be a boolean.');
  }
  const replacementMarkdown = command === 'replace_content'
    ? requireMcpReplaceContent(args)
    : undefined;
  let insertAfter: string | undefined;
  let insertPosition: { type: 'start' | 'end' } | undefined;
  if (command === 'insert_content') {
    assertMcpMarkdownBounds(args.content ?? args.new_str);
    if (args.after !== undefined && args.position !== undefined) {
      throw new Error('insert_content.after and insert_content.position cannot both be provided.');
    }
    if (args.after !== undefined) {
      if (typeof args.after !== 'string' || args.after.length === 0) {
        throw new Error('insert_content.after must be a non-empty string.');
      }
      insertAfter = args.after;
    }
    if (args.position !== undefined) {
      if (!isRecord(args.position)) throw new Error('insert_content.position must be an object.');
      if (args.position.type !== 'start' && args.position.type !== 'end') {
        throw new Error('insert_content.position.type must be start or end.');
      }
      insertPosition = { type: args.position.type };
    }
  }
  if (command === 'update_content') {
    const updates = Array.isArray(args.content_updates) ? args.content_updates : [];
    if (!updates.length) throw new Error('update_content requires content_updates.');
    if (updates.length > 100) throw new Error('content_updates must contain at most 100 entries.');
    for (const update of updates) {
      if (!isRecord(update) || typeof update.old_str !== 'string' || typeof update.new_str !== 'string') {
        throw new Error('Each content update requires old_str and new_str strings.');
      }
      if (!update.old_str) throw new Error('content_updates.old_str must not be empty.');
      if (update.replace_all_matches !== undefined && typeof update.replace_all_matches !== 'boolean') {
        throw new Error('content_updates.replace_all_matches must be a boolean.');
      }
      boundedMcpUtf8Bytes(update.old_str, MAX_MCP_MARKDOWN_BYTES, 'content_updates.old_str');
      assertMcpMarkdownBounds(update.new_str);
    }
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
  const run = async () => {
    if (command === 'insert_content' || command === 'replace_content' || command === 'update_content') {
      const payload = command === 'insert_content'
        ? {
            type: 'insert_content',
            insert_content: {
              content: args.content ?? args.new_str ?? '',
              ...(insertAfter === undefined ? {} : { after: insertAfter }),
              ...(insertPosition === undefined ? {} : { position: insertPosition }),
            },
          }
        : command === 'replace_content'
          ? {
              type: 'replace_content',
              replace_content: {
                new_str: replacementMarkdown,
                ...(args.allow_deleting_content === undefined
                  ? {}
                  : { allow_deleting_content: args.allow_deleting_content }),
              },
            }
          : {
              type: 'update_content',
              update_content: {
                content_updates: args.content_updates,
                ...(args.allow_deleting_content === undefined
                  ? {}
                  : { allow_deleting_content: args.allow_deleting_content }),
              },
            };
      return await callNotionCompat(context, grant, 'PATCH', `pages/${pageId}/markdown`, payload);
    }
    if (command === 'update_verification') {
      const verified = args.verification_status === 'verified';
      const expiryDays = Number(args.verification_expiry_days);
      if (args.verification_status !== 'verified' && args.verification_status !== 'unverified') {
        throw new Error('update_verification requires verification_status.');
      }
      if (args.verification_expiry_days !== undefined && (!Number.isFinite(expiryDays) || expiryDays <= 0)) {
        throw new Error('verification_expiry_days must be a positive number.');
      }
      const verifiedAt = verified ? new Date().toISOString() : null;
      const verificationExpiresAt = verified && Number.isFinite(expiryDays) && expiryDays > 0
        ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const result = await callProductFunction(
        context,
        grant,
        'page-mutation',
        {
          action: 'update',
          id: pageId,
          workspaceId: selected.workspaceId,
          patch: {
            verifiedAt,
            verifiedBy: verified ? grant.userId : null,
            verificationExpiresAt,
          },
        },
        pageMutationHandler as InternalFunctionHandler,
      );
      return {
        ...(isRecord(result) ? result : { result }),
        verification_status: verified ? 'verified' : 'unverified',
      };
    }
    const patch: Record<string, unknown> = {};
    if (command === 'apply_template') {
      patch.template = { type: 'template_id', template_id: args.template_id };
    } else if (command === 'update_properties') {
      if (args.properties !== undefined || args.title !== undefined) {
        patch.properties = args.properties !== undefined
          ? simpleProperties(args.properties, textValue(args.title, 'Untitled'))
          : simpleProperties({ title: args.title }, textValue(args.title, 'Untitled'));
      }
      if (args.icon !== undefined) patch.icon = textValue(args.icon) ? { type: 'emoji', emoji: textValue(args.icon) } : null;
      if (args.cover !== undefined) patch.cover = textValue(args.cover) ? { external: { url: textValue(args.cover) } } : null;
      if (args.locked !== undefined) patch.is_locked = args.locked === true;
    } else {
      throw new Error(`Unsupported update-page command: ${command}.`);
    }
    return await callNotionCompat(context, grant, 'PATCH', `pages/${pageId}`, patch);
  };
  if (args.allow_async === true) {
    return await runAsyncTask(context, grant, 'update_page', selected.workspaceId, run);
  }
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
  if (forceAsync || args.allow_async === true) {
    return await runAsyncTask(context, grant, 'duplicate_page', selected.workspaceId, run);
  }
  return toolJson(await run());
}

export function moveIds(args: Record<string, unknown>) {
  return normalizeNotionMovePageIds(args, stripHanjiId);
}

function moveDestination(args: Record<string, unknown>) {
  return normalizeNotionMoveDestination(args, stripHanjiId);
}

async function callCanonicalMove(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  page: PageRecord,
  destination: Pick<NotionMovePagesDestination, 'parentId' | 'parentType'>,
  position: number,
  dryRun: boolean,
) {
  const common = { id: page.id, workspaceId, position, dryRun };
  const isDatabaseRow = page.parentType === 'database' && Boolean(page.parentId);
  let payload: unknown;

  if (isDatabaseRow) {
    if (destination.parentType === 'database') {
      payload = await callProductFunction(
        context,
        grant,
        'database-row-mutation',
        page.parentId === destination.parentId
          ? { ...common, action: 'update', patch: { position } }
          : { ...common, action: 'moveToDatabase', targetDatabaseId: destination.parentId },
        databaseRowMutationHandler as InternalFunctionHandler,
      );
    } else {
      payload = await callProductFunction(
        context,
        grant,
        'database-row-mutation',
        destination.parentType === 'workspace'
          ? { ...common, action: 'moveToWorkspace', targetParentType: 'workspace' }
          : {
              ...common,
              action: 'moveToPage',
              targetParentType: 'page',
              targetPageId: destination.parentId,
            },
        databaseRowMutationHandler as InternalFunctionHandler,
      );
    }
  } else if (destination.parentType === 'database') {
    if (page.kind === 'database') throw new Error('Only regular pages can be moved into a data source.');
    payload = await callProductFunction(
      context,
      grant,
      'database-row-mutation',
      { ...common, action: 'movePageToDatabase', targetDatabaseId: destination.parentId },
      databaseRowMutationHandler as InternalFunctionHandler,
    );
  } else {
    payload = await callProductFunction(
      context,
      grant,
      'page-mutation',
      {
        ...common,
        action: 'move',
        patch: {
          parentId: destination.parentId,
          parentType: destination.parentType,
          position,
        },
      },
      pageMutationHandler as InternalFunctionHandler,
    );
  }

  if (isRecord(payload) && isRecord(payload.page)) return payload.page as unknown as PageRecord;
  if (isRecord(payload) && isRecord(payload.row)) return payload.row as unknown as PageRecord;
  return page;
}

async function movePages(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  // Bound and normalize the operation fan-out before workspace selection or
  // any database lookup. The HTTP/JSON-RPC body caps do not otherwise stop one
  // tools/call from amplifying into thousands of permission checks and moves.
  const ids = moveIds(args);
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_move_pages');
  if ('error' in selected) return selected.error;

  let destination = moveDestination(args);
  // The official REST compatibility exception is intentionally narrower than
  // a generic `type: page`: only an explicit page_id discriminator may carry
  // the id of a single-data-source database.
  if (destination.parentId && destination.requestedType === 'page_id') {
    const actual = await requirePageInWorkspace(
      context,
      grant,
      selected.workspaceId,
      destination.parentId,
      'Destination parent',
    );
    if (actual.kind === 'database') {
      destination = {
        ...destination,
        parentType: 'database',
        notionParent: { type: 'data_source_id', data_source_id: destination.parentId },
      };
    }
  }
  const { parentId, parentType } = destination;
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

  const positions = notionMoveBatchPositions(
    pages,
    candidates.map((page) => page.id),
    destination,
    afterPageId || undefined,
    beforePageId || undefined,
  );

  // Run the exact canonical planners for every candidate before the first
  // write. ACL, lock, cycle, schema, relation, file-owner, and transaction
  // budget failures therefore cannot leave an earlier item moved.
  for (const page of candidates) {
    await callCanonicalMove(
      context,
      grant,
      selected.workspaceId,
      page,
      destination,
      positions[page.id]!,
      true,
    );
  }

  for (const page of candidates) {
    const position = positions[page.id]!;
    const updated = await callCanonicalMove(
      context,
      grant,
      selected.workspaceId,
      page,
      destination,
      position,
      false,
    );
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
  const hasSchema = typeof args.schema === 'string' && args.schema.trim().length > 0;
  const databaseType = textValue(args.database_type) as NotionMcpDatabaseType;
  const hasDatabaseType = ['tasks', 'projects', 'skills'].includes(databaseType);
  if (Number(hasSchema) + Number(hasDatabaseType) !== 1) {
    return toolError('Provide exactly one of schema or database_type.');
  }
  const title = textValue(args.title);
  const createParent = isRecord(args.parent) ? args.parent : undefined;
  if (createParent && textValue(createParent.type) && textValue(createParent.type) !== 'page_id') {
    return toolError('parent.type must be page_id.');
  }
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
  const parsedProperties = hasSchema
    ? parseNotionMcpCreateTable(args.schema)
    : notionMcpTypedDatabaseProperties(databaseType);
  const dualRelations = parsedProperties.filter((property) => property.type === 'relation' && property.relationDual);
  for (const relation of dualRelations) {
    const targetId = collectionIdFromInput(relation.relationDataSourceId);
    if (!targetId) return toolError(`Relation "${relation.name}" requires a data source id.`);
    const target = await requireDatabaseInWorkspace(
      context,
      grant,
      selected.workspaceId,
      targetId,
      `Relation target for ${relation.name}`,
    );
    requireContentScope(grant, target, 'write');
  }
  // Canonical creation commits the new source atomically. DUAL reciprocity is
  // then reconciled through the ordinary schema mutation path so the target
  // property is created and cross-linked by the same backend invariant used by
  // the product UI and REST API.
  const properties = notionMcpPropertySchemaMap(parsedProperties.map((property) => (
    property.relationDual ? { ...property, relationDual: undefined } : property
  )));
  const payload = await callNotionCompat(context, grant, 'POST', 'databases', {
    workspace_id: selected.workspaceId,
    parent: isRecord(args.parent) ? { workspace_id: selected.workspaceId, ...args.parent } : { workspace_id: selected.workspaceId },
    title: richText(title),
    description: typeof args.description === 'string' ? richText(args.description) : undefined,
    database_type: hasDatabaseType ? databaseType : undefined,
    initial_data_source: { properties },
  });
  const dataSourceId = isRecord(payload) ? stripHanjiId(payload.id) : '';
  if (!dataSourceId) throw new Error('Created database response did not include a data source id.');
  const dataSource = dualRelations.length
    ? await callNotionCompat(context, grant, 'PATCH', `data_sources/${dataSourceId}`, {
        properties: Object.fromEntries(dualRelations.map((property) => [
          property.name,
          notionMcpPropertySchema(property),
        ])),
      })
    : await callNotionCompat(context, grant, 'GET', `data_sources/${dataSourceId}`);
  const schemaSummary = isRecord(dataSource) && isRecord(dataSource.properties)
    ? Object.keys(dataSource.properties).join(', ')
    : Object.keys(properties).join(', ');
  const text = [
    `<data-source url="collection://${dataSourceId}">`,
    `Title: ${title || (hasDatabaseType ? databaseType : 'Untitled')}`,
    `Properties: ${schemaSummary || 'Name'}`,
    hasDatabaseType ? `Database type: ${databaseType}` : '',
    `Data source ID: ${dataSourceId}`,
    '</data-source>',
  ].filter(Boolean).join('\n');
  return toolTextWithStructured(text, {
    database: payload,
    data_source: dataSource,
    data_source_id: dataSourceId,
    data_source_url: `collection://${dataSourceId}`,
    ...(hasDatabaseType ? { database_type: databaseType } : {}),
  });
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
  const mutationFields = ['title', 'description', 'is_inline', 'in_trash', 'statements'];
  if (!mutationFields.some((field) => Object.prototype.hasOwnProperty.call(args, field))) {
    return toolError('Provide at least one of statements, title, description, is_inline, or in_trash.');
  }
  if ('is_inline' in args && typeof args.is_inline !== 'boolean') return toolError('is_inline must be a boolean.');
  if ('in_trash' in args && typeof args.in_trash !== 'boolean') return toolError('in_trash must be a boolean.');
  if ('title' in args && typeof args.title !== 'string') return toolError('title must be a string.');
  if ('description' in args && typeof args.description !== 'string') return toolError('description must be a string.');
  const current = await callNotionCompat(context, grant, 'GET', `data_sources/${dataSourceId}`);
  if (!isRecord(current)) throw new Error('Data source response was malformed.');
  const currentParent = isRecord(current.parent) ? current.parent : {};
  if (args.is_inline !== undefined && stripHanjiId(currentParent.database_id) !== dataSourceId) {
    return toolError('is_inline is only supported for single-source databases.');
  }
  const operations = typeof args.statements === 'string' && args.statements.trim()
    ? parseNotionMcpDdl(args.statements)
    : [];
  const properties = operations.length
    ? notionMcpDdlPatch(isRecord(current.properties) ? current.properties : {}, operations)
    : undefined;
  const payload = await callNotionCompat(context, grant, 'PATCH', `data_sources/${dataSourceId}`, {
    ...('title' in args ? { title: args.title } : {}),
    ...('description' in args ? { description: args.description } : {}),
    ...('is_inline' in args ? { is_inline: args.is_inline } : {}),
    ...('in_trash' in args ? { in_trash: args.in_trash } : {}),
    ...(properties ? { properties } : {}),
  });
  const schemaSummary = isRecord(payload) && isRecord(payload.properties)
    ? Object.keys(payload.properties).join(', ')
    : '';
  const text = [
    `<data-source url="collection://${dataSourceId}">`,
    `Updated data source: ${dataSourceId}`,
    schemaSummary ? `Properties: ${schemaSummary}` : '',
    operations.length ? `Applied ${operations.length} DDL statement(s).` : '',
    '</data-source>',
  ].filter(Boolean).join('\n');
  return toolTextWithStructured(text, {
    data_source: payload,
    data_source_id: dataSourceId,
    data_source_url: `collection://${dataSourceId}`,
    applied_statements: operations.map((operation) => operation.raw),
  });
}

function xmlEscape(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function markdownCommentRichText(markdown: string) {
  boundedMcpUtf8Bytes(markdown, MAX_MCP_COMMENT_TEXT_BYTES, 'MCP comment markdown');
  const result: Array<Record<string, unknown>> = [];
  const token = /(\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\$([^$\n]+)\$|<mention-date\s+start="([^"]+)"(?:\s+end="([^"]+)")?(?:\s+time_zone="([^"]+)")?\s*\/?>)/g;
  let cursor = 0;
  const pushText = (content: string, annotations: Record<string, unknown> = {}, link?: string) => {
    if (!content) return;
    result.push({
      type: 'text',
      text: { content, ...(link ? { link: { url: link } } : {}) },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
        ...annotations,
      },
    });
  };
  for (const match of markdown.matchAll(token)) {
    const index = match.index ?? 0;
    pushText(markdown.slice(cursor, index));
    if (match[2] !== undefined) pushText(match[2], { bold: true });
    else if (match[3] !== undefined) pushText(match[3], { strikethrough: true });
    else if (match[4] !== undefined) pushText(match[4], { code: true });
    else if (match[5] !== undefined) pushText(match[5], {}, match[6]);
    else if (match[7] !== undefined) result.push({ type: 'equation', equation: { expression: match[7] } });
    else if (match[8] !== undefined) {
      result.push({
        type: 'mention',
        mention: {
          type: 'date',
          date: {
            start: match[8],
            ...(match[9] ? { end: match[9] } : {}),
            ...(match[10] ? { time_zone: match[10] } : {}),
          },
        },
      });
    }
    cursor = index + match[0].length;
  }
  pushText(markdown.slice(cursor));
  if (result.length > MAX_MCP_COMMENT_RICH_TEXT_ITEMS) {
    throw new Error(`MCP comment rich_text must contain at most ${MAX_MCP_COMMENT_RICH_TEXT_ITEMS} items.`);
  }
  return result;
}

function notionMcpCommentContent(args: Record<string, unknown>) {
  const hasMarkdown = typeof args.markdown === 'string';
  const hasRichText = Array.isArray(args.rich_text);
  if (Number(hasMarkdown) + Number(hasRichText) !== 1) {
    throw new Error('Provide exactly one of markdown or rich_text.');
  }
  const rich = hasMarkdown
    ? markdownCommentRichText(String(args.markdown))
    : args.rich_text as unknown[];
  const bounded = boundedMcpCommentRichText({ rich_text: rich });
  if (!bounded.some((item) => commentRichTextItemText(item).trim())) {
    throw new Error('Comment content cannot be empty.');
  }
  return bounded;
}

function blockCommentText(block: BlockRecord) {
  if (typeof block.plainText === 'string' && block.plainText) return block.plainText;
  const rich = isRecord(block.content) && Array.isArray(block.content.rich) ? block.content.rich : [];
  return rich.map((span) => isRecord(span) && typeof span.text === 'string' ? span.text : '').join('');
}

function selectionMatchesBlock(selection: string, block: BlockRecord) {
  const text = blockCommentText(block).replace(/\s+/g, ' ').trim();
  const normalized = selection.replace(/\s+/g, ' ').trim();
  if (!text || !normalized) return false;
  const ellipsis = normalized.match(/^(.*?)(?:\.\.\.|…)(.*?)$/s);
  if (!ellipsis) return text.includes(normalized);
  const start = ellipsis[1].trim();
  const end = ellipsis[2].trim();
  const startIndex = start ? text.indexOf(start) : 0;
  if (startIndex < 0) return false;
  const endIndex = end ? text.indexOf(end, startIndex + start.length) : text.length;
  return endIndex >= startIndex + start.length;
}

function discussionCommentId(value: unknown) {
  const raw = textValue(value);
  if (!raw) return '';
  return raw.split('/').filter(Boolean).at(-1) ?? raw;
}

function storedCommentText(comment: CommentRecord) {
  const body = isRecord(comment.body) ? comment.body : {};
  const rich = Array.isArray(body.rich) ? body.rich : [];
  return rich.map((span) => {
    if (!isRecord(span)) return '';
    if (typeof span.text === 'string') return span.text;
    if (typeof span.expression === 'string') return span.expression;
    return '';
  }).join('');
}

function storedCommentRichText(comment: CommentRecord) {
  const body = isRecord(comment.body) ? comment.body : {};
  const rich = Array.isArray(body.rich) ? body.rich : [];
  return rich.filter(isRecord).map((span) => {
    const annotations = {
      bold: span.bold === true,
      italic: span.italic === true,
      strikethrough: span.strikethrough === true,
      underline: span.underline === true,
      code: span.code === true,
      color: typeof span.color === 'string' ? span.color : 'default',
    };
    const text = typeof span.text === 'string' ? span.text : '';
    if (span.mention === 'page' && typeof span.pageId === 'string') {
      return {
        type: 'mention', mention: { type: 'page', page: { id: span.pageId } },
        annotations, plain_text: text || span.pageId, href: null,
      };
    }
    if (span.mention === 'person' && typeof span.userId === 'string') {
      return {
        type: 'mention', mention: { type: 'user', user: { object: 'user', id: span.userId } },
        annotations, plain_text: text || span.userId, href: null,
      };
    }
    if (span.mention === 'date' && typeof span.date === 'string') {
      return {
        type: 'mention',
        mention: {
          type: 'date',
          date: {
            start: span.date,
            end: typeof span.dateEnd === 'string' ? span.dateEnd : null,
            time_zone: typeof span.dateTimeZone === 'string' ? span.dateTimeZone : null,
          },
        },
        annotations, plain_text: text || span.date, href: null,
      };
    }
    if (typeof span.equation === 'string') {
      return {
        type: 'equation', equation: { expression: span.equation },
        annotations, plain_text: span.equation, href: null,
      };
    }
    const link = typeof span.link === 'string' ? span.link : null;
    return {
      type: 'text', text: { content: text, link: link ? { url: link } : null },
      annotations, plain_text: text, href: link,
    };
  });
}

async function commentsTool(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>, mode: 'list' | 'create') {
  requireGrantScope(grant, mode === 'create' ? ['comments:write'] : ['comments:read']);
  if (mode === 'create') requireGrantWrite(grant, ['comments:write']);
  const createRich = mode === 'create' ? notionMcpCommentContent(args) : [];
  const selected = await requireWorkspaceArgument(context, grant, args, mode === 'create' ? '_notion_create_comment' : '_notion_get_comments');
  if ('error' in selected) return selected.error;
  const pageId = stripHanjiId(args.page_id);
  if (!pageId) return toolError('page_id is required.');
  const page = await requirePageInWorkspace(context, grant, selected.workspaceId, pageId, 'Page');
  const db = boundedDb(context.admin, selected.workspaceId);
  await assertMinimumPageAccessRole(
    db,
    { ...page, parentType: page.parentType ?? undefined },
    grant.userId,
    mode === 'create' ? 'comment' : 'view',
  );
  const comments = await listAll(db.table<CommentRecord>('comments').where('pageId', '==', pageId));
  if (mode === 'list') {
    const wantedId = discussionCommentId(args.discussion_id);
    const includeAllBlocks = args.include_all_blocks === true;
    const includeResolved = args.include_resolved === true;
    const roots = comments
      .filter((comment) => !comment.parentId)
      .filter((comment) => includeResolved || comment.resolved !== true)
      .filter((comment) => !wantedId || comment.id === wantedId)
      .filter((comment) => wantedId || includeAllBlocks || !comment.blockId)
      .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
    if (!roots.length) return toolJson({});
    const replies = new Map<string, CommentRecord[]>();
    for (const comment of comments) {
      if (!comment.parentId) continue;
      const list = replies.get(comment.parentId) ?? [];
      list.push(comment);
      replies.set(comment.parentId, list);
    }
    const lines = ['<discussions>'];
    const structured: Array<Record<string, unknown>> = [];
    for (const root of roots) {
      const discussionId = `discussion://${pageId}/${root.blockId || 'page'}/${root.id}`;
      lines.push(`  <discussion id="${xmlEscape(discussionId)}" ${root.blockId ? `block="${xmlEscape(root.blockId)}"` : 'target="page"'} resolved="${root.resolved ? 'true' : 'false'}">`);
      const thread = [root, ...(replies.get(root.id) ?? []).sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))];
      const items = thread.map((comment) => {
        const text = storedCommentText(comment);
        const richText = storedCommentRichText(comment);
        lines.push(`    <comment id="${xmlEscape(comment.id)}" author="${xmlEscape(comment.authorId || 'unknown')}" created="${xmlEscape(comment.createdAt || '')}">${xmlEscape(text)}</comment>`);
        return {
          id: comment.id,
          author_id: comment.authorId ?? null,
          created_time: comment.createdAt ?? null,
          updated_time: comment.updatedAt ?? comment.createdAt ?? null,
          rich_text: richText,
          text,
        };
      });
      const quote = isRecord(root.body) && typeof root.body.quote === 'string' ? root.body.quote : '';
      if (quote) lines.push(`    <quote>${xmlEscape(quote)}</quote>`);
      lines.push('  </discussion>');
      structured.push({ discussion_id: discussionId, block_id: root.blockId ?? null, resolved: root.resolved === true, comments: items });
    }
    lines.push('</discussions>');
    return toolTextWithStructured(lines.join('\n'), { text: lines.join('\n'), discussions: structured });
  }
  const rich = createRich;
  const selection = typeof args.selection_with_ellipsis === 'string' ? args.selection_with_ellipsis.trim() : '';
  const requestedDiscussionId = discussionCommentId(args.discussion_id);
  if (selection && requestedDiscussionId) return toolError('selection_with_ellipsis cannot be combined with discussion_id.');
  let blockId = '';
  let parentDiscussionId = '';
  if (requestedDiscussionId) {
    const requested = comments.find((comment) => comment.id === requestedDiscussionId);
    if (!requested) return toolError('Discussion was not found.');
    const root = requested.parentId
      ? comments.find((comment) => comment.id === requested.parentId)
      : requested;
    if (!root) return toolError('Discussion was not found.');
    blockId = textValue(root.blockId);
    parentDiscussionId = root.id;
  } else if (selection) {
    const blocks = (await listAll(db.table<BlockRecord>('blocks').where('pageId', '==', pageId)))
      .filter((block) => selectionMatchesBlock(selection, block));
    if (blocks.length !== 1) {
      return toolError(blocks.length ? 'selection_with_ellipsis matched more than one block.' : 'selection_with_ellipsis did not match page content.');
    }
    blockId = blocks[0].id;
  }
  const parent = blockId
    ? { block_id: blockId, workspace_id: selected.workspaceId }
    : { page_id: pageId, workspace_id: selected.workspaceId };
  const payload = await callNotionCompat(context, grant, 'POST', 'comments', {
    workspace_id: selected.workspaceId,
    parent,
    rich_text: rich,
    ...(parentDiscussionId ? { discussion_id: parentDiscussionId } : {}),
    ...(selection ? { selection_with_ellipsis: selection } : {}),
  });
  const commentId = isRecord(payload) ? textValue(payload.id) : '';
  const discussionId = `discussion://${pageId}/${blockId || 'page'}/${parentDiscussionId || commentId}`;
  return toolTextWithStructured(
    `Created comment ${commentId || ''} in ${discussionId}.`,
    { comment: payload, discussion_id: discussionId, page_id: pageId, block_id: blockId || null },
  );
}

async function createView(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const dataSourceId = collectionIdFromInput(args.data_source_id);
  if (!dataSourceId) return toolError('data_source_id is required.');
  const databaseId = stripHanjiId(args.database_id);
  const parentPageId = stripHanjiId(args.parent_page_id);
  if (Number(!!databaseId) + Number(!!parentPageId) !== 1) {
    return toolError('Exactly one of database_id or parent_page_id is required.');
  }
  const name = textValue(args.name);
  if (!name) return toolError('name is required.');
  const type = parseDatabaseViewType(args.type);
  const parsed = parseNotionViewConfigDsl(args.configure);
  assertRequiredNotionViewConfigure(type, parsed);
  requireContentFamilies(
    grant,
    new Set<ContentScopeFamily>(parentPageId ? ['databases', 'pages'] : ['databases']),
    'write',
  );
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_create_view');
  if ('error' in selected) return selected.error;
  let dataSource: PageRecord;
  if (databaseId) {
    let database: PageRecord;
    if (databaseId === dataSourceId) {
      dataSource = await requireDatabaseInWorkspace(
        context, grant, selected.workspaceId, dataSourceId, 'Data source',
      );
      database = dataSource;
    } else {
      [dataSource, database] = await Promise.all([
        requireDatabaseInWorkspace(
          context, grant, selected.workspaceId, dataSourceId, 'Data source',
        ),
        requireDatabaseInWorkspace(
          context, grant, selected.workspaceId, databaseId, 'Database',
        ),
      ]);
    }
    requireContentScope(grant, database, 'write');
    requireContentScope(grant, dataSource, 'write');
  } else {
    let parent: PageRecord;
    [dataSource, parent] = await Promise.all([
      requireDatabaseInWorkspace(
        context, grant, selected.workspaceId, dataSourceId, 'Data source',
      ),
      requirePageInWorkspace(
        context, grant, selected.workspaceId, parentPageId, 'Parent page',
      ),
    ]);
    if (parent.kind === 'database') return toolError('Parent page was not found.');
    requireContentScope(grant, dataSource, 'write');
    requireContentScope(grant, parent, 'write');
  }
  const properties = await databaseProperties(context, dataSource.id);
  const initialPlan = notionViewConfigurePlan(type, parsed, properties);
  const payload = await callNotionCompat(context, grant, 'POST', 'views', {
    workspace_id: selected.workspaceId,
    database_id: databaseId || undefined,
    create_database: parentPageId
      ? { parent: { type: 'page_id', page_id: parentPageId } }
      : undefined,
    data_source_id: dataSource.id,
    name,
    type,
    ...initialPlan.body,
  });
  const viewId = isRecord(payload) ? stripHanjiId(payload.id) : '';
  if (!viewId) throw new Error('Created view response did not include an id.');
  if (initialPlan.changed) {
    try {
      await persistHostedViewConfigure(
        context,
        grant,
        selected.workspaceId,
        viewId,
        dataSource.id,
        type,
        parsed,
        properties,
      );
    } catch (error) {
      const created = await viewRecord(context, viewId, selected.workspaceId);
      const metadata = isRecord(created?.config?.__notionCompat)
        ? created.config.__notionCompat
        : {};
      const linkedBlockId = textValue(metadata.linked_block_id);
      if (linkedBlockId && parentPageId) {
        await callProductFunction(context, grant, 'block-mutation', {
          action: 'delete',
          id: linkedBlockId,
          pageId: parentPageId,
        }, blockMutationHandler).catch(() => undefined);
      }
      await callNotionCompat(context, grant, 'DELETE', `views/${viewId}`).catch(() => undefined);
      throw error;
    }
  }
  return toolJson(payload);
}

async function persistHostedViewConfigure(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  viewId: string,
  dataSourceId: string,
  type: NotionDatabaseViewType,
  configure: Record<string, unknown>,
  properties: NotionViewDslProperty[],
) {
  const current = await viewRecord(context, viewId, workspaceId);
  if (!current || current.databaseId !== dataSourceId) throw new Error('View was not found after mutation.');
  const plan = notionViewConfigurePlan(type, configure, properties, current.config ?? {});
  if (!plan.changed) return current;
  const result = await callProductFunction(context, grant, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: current.id,
    databaseId: dataSourceId,
    workspaceId,
    patch: { config: plan.config },
  }, databaseMutationHandler);
  return isRecord(result) && isRecord(result.record) ? result.record : current;
}

function hostedViewConfigWithCompatMetadata(
  currentConfig: Record<string, unknown>,
  body: Record<string, unknown>,
) {
  const config = { ...currentConfig };
  const metadata = isRecord(currentConfig.__notionCompat)
    ? { ...currentConfig.__notionCompat }
    : {};
  if ('filter' in body) metadata.filter = body.filter ?? null;
  if ('sorts' in body) metadata.sorts = body.sorts ?? null;
  if ('configuration' in body && isRecord(body.configuration)) {
    const prior = isRecord(metadata.configuration) ? metadata.configuration : {};
    metadata.configuration = { ...prior, ...body.configuration };
  }
  config.__notionCompat = metadata;
  return config;
}

async function updateView(context: FunctionContext, grant: McpOAuthGrant, args: Record<string, unknown>) {
  const selected = await requireWorkspaceArgument(context, grant, args, '_notion_update_view');
  if ('error' in selected) return selected.error;
  const viewId = notionViewId(args.view_id);
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
  const type = parseDatabaseViewType(view.type ?? 'table');
  const hasConfigure = args.configure !== undefined;
  const parsed = hasConfigure ? parseNotionViewConfigDsl(args.configure) : {};
  const properties = hasConfigure ? await databaseProperties(context, dataSource.id) : [];
  const initialPlan = hasConfigure
    ? notionViewConfigurePlan(type, parsed, properties, view.config ?? {})
    : { body: {}, config: view.config ?? {}, changed: false };
  if (initialPlan.changed) {
    const finalPlan = notionViewConfigurePlan(
      type,
      parsed,
      properties,
      hostedViewConfigWithCompatMetadata(view.config ?? {}, initialPlan.body),
    );
    await callProductFunction(context, grant, 'database-mutation', {
      action: 'update',
      table: 'db_views',
      id: view.id,
      databaseId: dataSource.id,
      workspaceId: selected.workspaceId,
      patch: {
        name: textValue(args.name) || view.name,
        config: finalPlan.config,
      },
    }, databaseMutationHandler);
    // The mutation above is the only write. A later response-projection read
    // can fail, but the durable state is already the exact requested state;
    // there is no intermediate compat/local config split to roll back.
    const payload = await callNotionCompat(
      context,
      grant,
      'GET',
      `views/${viewId}`,
      undefined,
      { workspace_id: selected.workspaceId },
    );
    return toolJson(payload);
  }
  const payload = await callNotionCompat(context, grant, 'PATCH', `views/${viewId}`, {
    workspace_id: selected.workspaceId,
    name: args.name,
    ...initialPlan.body,
  });
  return toolJson(payload);
}

function normalizedToolName(name: string | undefined) {
  const raw = textValue(name);
  const aliases: Record<string, string> = {
    'notion-search': '_search',
    'notion-fetch': '_fetch',
    'notion-create-attachment': '_notion_create_attachment',
    'notion-download-attachment': '_notion_download_attachment',
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
    if (toolName === '_notion_create_attachment') return await createAttachment(context, grant, args);
    if (toolName === '_notion_download_attachment') return await downloadAttachment(context, grant, args);
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
      requireGrantScope(grant, ['pages:read', 'databases:read']);
      const selected = await requireWorkspaceArgument(context, grant, args, '_notion_query_meeting_notes');
      if ('error' in selected) return selected.error;
      const limit = hostedMeetingNoteLimit(args.limit);
      const payload = await callNotionCompat(context, grant, 'POST', 'blocks/meeting_notes/query', {
        workspace_id: selected.workspaceId,
        filter: args.filter,
        sort: args.sort,
        // Collect one bounded compatibility window, then apply the grant's
        // current semantic/resource authority before honoring the caller's
        // requested result limit. This avoids per-result round trips and lets
        // an allowed result survive a forbidden sibling in the same window.
        limit: MAX_MCP_MEETING_NOTE_RESULTS,
      });
      return toolJson(await filterHostedMeetingNotes(
        context,
        grant,
        selected.workspaceId,
        payload,
        limit,
      ));
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
    'Hosted tool coverage includes all 20 current Notion connector names: notion-search/fetch/create-attachment/download-attachment/create-pages/update-page/move-pages/duplicate-page/create-database/update-data-source/create-view/update-view/query-data-sources/query-database-view/query-meeting-notes/create-comment/get-comments/get-teams/get-users/get-async-task, plus OpenAI-compatible search/fetch aliases and legacy underscore aliases.',
    '',
    'Hanji differs from Notion in one important way: this OAuth connection can be account-scoped, so workspace-bound tools require an explicit `workspace_id`. Notion-compatible `teamspace_id` is accepted as an alias for the Hanji workspace id. Native and preserved imported meeting notes and transcripts enforce attendee, page ACL, content-scope, and grant-resource checks; connected-source and AI-search layers remain explicit fallbacks.',
    '',
    'Scope separation: `workspace:read` covers workspace/team/user/self metadata only and never content. Normal pages use `pages:*`; database pages and database rows use `databases:*`. Mixed search requires both read scopes, data-source search/query/view requires `databases:read`, and write scopes never substitute for read scopes. Duplicate and move authorize source/result/destination semantic families independently.',
    '',
    'Primary writes: create-pages, update-page, create-database, update-data-source, and create-attachment execute through canonical product mutation/file-lifecycle handlers after scope validation. Async-enabled calls persist a pollable result instead of reporting completion before the mutation outcome is known. Inline attachments intentionally accept only safe UTF-8 formats; active HTML/XML/SVG/CSS files are rejected by this surface under Hanji stored-file security policy.',
  ].join('\n');
}

function enhancedMarkdownSpec() {
  return [
    '# Hanji Notion-Compatible Markdown',
    '',
    'Hosted MCP page-body writes use the same Notion-compatible Markdown facade as the REST surface. Headings, paragraphs, bullet lines, and to-do lines are converted to canonical block mutations, while replace/update content commands use the page Markdown endpoint.',
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
    'Hosted MCP view tools route through the Notion-compatible REST facade. All ten official view types and their exact configuration fields are retained.',
    '',
    'Separate directives with semicolons or newlines:',
    '- `FILTER "Property" = "value"`, `!=`, `CONTAINS`, `IS EMPTY`, or `IS NOT EMPTY`',
    '- `SORT BY "Property" ASC|DESC`',
    '- `GROUP BY "Property"` (required for board)',
    '- `CALENDAR BY "Property"` (required for calendar)',
    '- `TIMELINE BY "Start" TO "End"` (required for timeline)',
    '- `MAP BY "Property"` (required for map)',
    '- `CHART column|bar|line|donut|number` with optional `AGGREGATE`, `COLOR`, `HEIGHT`, `SORT`, `STACK BY`, and `CAPTION`',
    '- `FORM CLOSE|OPEN`, `FORM ANONYMOUS true|false`, and `FORM PERMISSIONS none|comment_only|reader|read_and_write|editor`',
    '- `SHOW`, `HIDE`, `COVER`, `WRAP CELLS`, `NO WRAP`, and `FREEZE COLUMNS [count|THROUGH "Property"]`',
    '- On update, `CLEAR FILTER`, `CLEAR SORT`, and `CLEAR GROUP BY` remove those settings.',
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
    let auth: Awaited<ReturnType<typeof authenticatedGrant>> = null;
    try {
      auth = await authenticatedGrant(context);
    } catch (error) {
      if (error instanceof McpAuthenticationError) return unauthorized(context);
      return asyncTaskInternalError(context, error);
    }
    if (!auth) return unauthorized(context);
    try {
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
        const workspaceId = textValue(task.operation?.workspace_id);
        if (workspaceId) {
          const db = context.admin.db('app');
          const workspace = (await grantAccessibleWorkspaces(db, auth.grant))
            .find((candidate) => candidate.id === workspaceId);
          if (!workspace) {
            return json(
              {
                object: 'error',
                code: 'async_task_not_found',
                message: 'Async task was not found.',
              },
              { status: 404, headers },
            );
          }
          try {
            await assertMcpClientApprovedForWorkspaces(db, [workspace], {
              actorId: auth.grant.userId,
              clientId: auth.grant.clientId,
              clientName: auth.grant.clientName,
              grantId: auth.grant.id,
              stage: 'hosted_call',
            });
          } catch (error) {
            if (isMcpClientGovernanceDenial(error)) {
              return asyncTaskHttpError(
                context,
                403,
                'restricted_resource',
                error.message,
              );
            }
            throw error;
          }
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
    } catch (error) {
      return asyncTaskInternalError(context, error);
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
