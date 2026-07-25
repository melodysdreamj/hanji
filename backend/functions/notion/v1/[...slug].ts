import { defineFunction } from '@edge-base/shared';
import {
  accessibleWorkspaceIdsForActor,
  boundedDbForPage,
  boundedDbFromPageHint,
  boundedDbFromWorkspaceHint,
  ensurePageWorkspaceIndex,
  MAX_RAW_TRANSACT_OPS,
} from '../../../lib/workspace-db';
import { errorStatus } from '../../../lib/error-status';
import {
  invokeProductFunction,
  type ProductFunctionDefinition as FunctionDefinition,
} from '../../../lib/product-function-bridge';
import {
  isNotFoundError,
  type TransactDb,
  type TransactOperation,
} from '../../../lib/table-utils';
import {
  pageAccessRole,
  pageAccessRoleRanks as roleRanks,
  normalizeAccessEmail,
  workspaceAccessRole,
} from '../../../lib/page-access';
import { POST as pageMutationPOST } from '../../page-mutation';
import { POST as pageQueryPOST } from '../../page-query';
import { POST as databaseRowMutationPOST } from '../../database-row-mutation';
import { POST as blockMutationPOST } from '../../block-mutation';
import { POST as databaseMutationPOST } from '../../database-mutation';
import { POST as importExportPOST } from '../../import-export';
import {
  POST as fileMutationPOST,
  completeNotionFileUpload,
  createNotionFileUpload,
  deleteNotionFileUpload,
  sendNotionFileUpload,
} from '../../file-mutation';
import {
  handleNotionCompatOAuthRequest,
  resolveNotionCompatBearer,
  type NotionCompatBearerIdentity,
} from '../../../lib/notion-compat-oauth';
import { queryMeetingNotes } from '../../../lib/notion-meeting-notes';
import {
  normalizeDatabaseViewStorageRecord,
  parseDatabaseViewType,
} from '../../../lib/database-view-types';
import {
  isReadOnlyDatabasePropertyType,
  normalizeDatabasePropertyWriteValue,
} from '../../../lib/database-property-types';
import {
  HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES,
  isHanjiBoardMainGroupPropertyType,
  notionBoardMainGroupPropertyType,
} from '../../../../shared/board-group-types.mjs';
import {
  formatFormulaValue,
  type FormulaValue,
} from '../../../../shared/database/formula-core';

type PageParentType = 'workspace' | 'page' | 'database';
type PageKind = 'page' | 'database';
type ShareRole = 'view' | 'comment' | 'edit' | 'full_access';

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType;
  kind?: PageKind;
  title?: string;
  icon?: string;
  iconType?: 'none' | 'emoji' | 'image';
  cover?: string;
  notionIcon?: Record<string, unknown> | null;
  notionCover?: Record<string, unknown> | null;
  coverPosition?: number;
  font?: 'default' | 'serif' | 'mono';
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: 'default' | 'expanded' | 'off';
  pageCommentsDisplay?: 'default' | 'expanded' | 'off';
  properties?: Record<string, unknown>;
  __computed?: Record<string, { value: unknown; formatted?: string }>;
  isFavorite?: boolean;
  inTrash?: boolean;
  trashedAt?: string | null;
  position?: number;
  createdBy?: string;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Block {
  id: string;
  pageId: string;
  parentId?: string | null;
  type: string;
  content?: Record<string, unknown>;
  plainText?: string;
  position?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface DbProperty {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  description?: string;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface DbView {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface DbViewQuery {
  id: string;
  viewId: string;
  databaseId: string;
  workspaceId: string;
  rowIds?: string[];
  sourceCursor?: string;
  hasMore?: boolean;
  filter?: unknown;
  sorts?: unknown;
  pageSize?: number;
  createdBy?: string;
  expiresAt?: string;
  createdAt?: string;
}

interface AsyncTask {
  id: string;
  userId?: string;
  grantId?: string;
  clientId?: string;
  status?: string;
  operation?: unknown;
  result?: unknown;
  error?: unknown;
  pollAfterSeconds?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

interface DbTemplate {
  id: string;
  databaseId: string;
  name: string;
  icon?: string;
  title?: string;
  properties?: Record<string, unknown>;
  blocks?: unknown[];
  isDefault?: boolean;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface Comment {
  id: string;
  pageId: string;
  blockId?: string | null;
  parentId?: string | null;
  authorId?: string;
  body?: unknown;
  resolved?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket?: string;
  key?: string;
  scope?: string;
  pageId?: string;
  blockId?: string;
  commentId?: string;
  databaseId?: string;
  propertyId?: string;
  templateId?: string;
  name?: string;
  contentType?: string;
  size?: number;
  status?: 'preparing' | 'pending' | 'uploaded' | 'deleting' | 'deleted' | 'expired' | 'failed';
  url?: string;
  etag?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
  numberOfPartsTotal?: number;
  numberOfPartsSent?: number;
  mode?: 'single_part' | 'multi_part' | 'external_url';
  multipartUploadId?: string | null;
  multipartParts?: Array<{ partNumber: number; etag: string; size: number }>;
  externalUrl?: string | null;
  fileImportResult?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
}

interface ListResult<T> {
  items?: T[];
  hasMore?: boolean;
}

interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  getList(): Promise<ListResult<T>>;
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FunctionContext {
  auth: { id: string; email?: string | null } | null;
  request: Request;
  params?: Record<string, string>;
  env?: Record<string, unknown>;
  compatWorkspaceId?: string;
  compatBearer?: NotionCompatBearerIdentity;
  waitUntil?: (promise: Promise<unknown>) => void;
  admin: {
    db(namespace: string, instanceId?: string): DbRef;
  };
}

interface RichTextSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: string;
  link?: string;
  mention?: 'page' | 'date' | 'person' | 'external';
  pageId?: string;
  date?: string;
  userId?: string;
  iconUrl?: string;
  equation?: string;
}

interface SelectOption {
  id: string;
  name: string;
  color?: string;
  description?: string | null;
  group?: string;
}

const knownBlockTypes = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'toggle_heading_1',
  'toggle_heading_2',
  'toggle_heading_3',
  'toggle_heading_4',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'divider',
  'code',
  'equation',
  'simple_table',
  'image',
  'video',
  'audio',
  'bookmark',
  'embed',
  'file',
  'breadcrumb',
  'table_of_contents',
  'synced_block',
  'button',
  'tab',
  'inline_database',
  'column_list',
  'column',
  'child_page',
  'link_to_page',
  'child_database',
  // These official compatibility types are stored only when there is no
  // product-native equivalent. Most official-only types are normalized to an
  // existing Hanji block and retain their official type/payload in content.
  'table_row',
  'meeting_notes',
  'link_preview',
  'unsupported',
]);

const officialWritableBlockTypes = new Set([
  'embed',
  'bookmark',
  'image',
  'video',
  'pdf',
  'file',
  'audio',
  'code',
  'equation',
  'divider',
  'breadcrumb',
  'tab',
  'table_of_contents',
  'link_to_page',
  'table_row',
  'table',
  'column_list',
  'column',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'paragraph',
  'bulleted_list_item',
  'numbered_list_item',
  'quote',
  'to_do',
  'toggle',
  'template',
  'callout',
  'synced_block',
]);

const officialResponseBlockTypes = new Set([
  ...officialWritableBlockTypes,
  'child_page',
  'child_database',
  'meeting_notes',
  'link_preview',
  'unsupported',
]);

const notionBlockPayloadKeys: Record<string, readonly string[]> = {
  embed: ['url', 'caption', 'file_upload', 'type'],
  bookmark: ['url', 'caption'],
  image: ['external', 'file_upload', 'type', 'caption'],
  video: ['external', 'file_upload', 'type', 'caption'],
  pdf: ['external', 'file_upload', 'type', 'caption'],
  file: ['external', 'file_upload', 'type', 'caption', 'name'],
  audio: ['external', 'file_upload', 'type', 'caption'],
  code: ['rich_text', 'language', 'caption'],
  equation: ['expression'],
  divider: [],
  breadcrumb: [],
  tab: ['children'],
  table_of_contents: ['color'],
  link_to_page: ['page_id', 'database_id', 'comment_id', 'type'],
  table_row: ['cells'],
  table: ['table_width', 'children', 'has_column_header', 'has_row_header'],
  column_list: ['children'],
  column: ['children', 'width_ratio'],
  heading_1: ['rich_text', 'color', 'is_toggleable', 'children'],
  heading_2: ['rich_text', 'color', 'is_toggleable', 'children'],
  heading_3: ['rich_text', 'color', 'is_toggleable', 'children'],
  heading_4: ['rich_text', 'color', 'is_toggleable', 'children'],
  paragraph: ['rich_text', 'color', 'icon', 'children'],
  bulleted_list_item: ['rich_text', 'color', 'children'],
  numbered_list_item: ['rich_text', 'color', 'children'],
  quote: ['rich_text', 'color', 'children'],
  to_do: ['rich_text', 'color', 'children', 'checked'],
  toggle: ['rich_text', 'color', 'children'],
  template: ['rich_text', 'children'],
  callout: ['rich_text', 'color', 'children', 'icon'],
  synced_block: ['synced_from', 'children'],
};

const notionBlockUpdatePayloadKeys: Record<string, readonly string[]> = {
  ...notionBlockPayloadKeys,
  embed: ['url', 'caption', 'file_upload'],
  image: ['external', 'file_upload', 'caption'],
  video: ['external', 'file_upload', 'caption'],
  pdf: ['external', 'file_upload', 'caption'],
  file: ['external', 'file_upload', 'caption', 'name'],
  audio: ['external', 'file_upload', 'caption'],
  tab: [],
  table: ['has_column_header', 'has_row_header'],
  column: ['width_ratio'],
  heading_1: ['rich_text', 'color', 'is_toggleable'],
  heading_2: ['rich_text', 'color', 'is_toggleable'],
  heading_3: ['rich_text', 'color', 'is_toggleable'],
  heading_4: ['rich_text', 'color', 'is_toggleable'],
  paragraph: ['rich_text', 'color', 'icon'],
  bulleted_list_item: ['rich_text', 'color'],
  numbered_list_item: ['rich_text', 'color'],
  quote: ['rich_text', 'color'],
  to_do: ['rich_text', 'color', 'checked'],
  toggle: ['rich_text', 'color'],
  template: ['rich_text'],
  callout: ['rich_text', 'color', 'icon'],
  synced_block: ['synced_from'],
};

const notionApiColors = new Set([
  'default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red',
  'default_background', 'gray_background', 'brown_background', 'orange_background',
  'yellow_background', 'green_background', 'blue_background', 'purple_background',
  'pink_background', 'red_background',
]);

const textBlockTypes = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'toggle_heading_1',
  'toggle_heading_2',
  'toggle_heading_3',
  'toggle_heading_4',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
]);

const optionColors = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const notionSelectColors = new Set(['default', ...optionColors]);
const notionStatusGroupNames = ['To-do', 'In progress', 'Complete'] as const;
type NotionStatusGroupName = (typeof notionStatusGroupNames)[number];
const notionStatusGroupDefaults: Record<NotionStatusGroupName, { color: string; suffix: string }> = {
  'To-do': { color: 'gray', suffix: 'to-do' },
  'In progress': { color: 'blue', suffix: 'in-progress' },
  Complete: { color: 'green', suffix: 'complete' },
};
const latestNotionVersion = '2026-03-11';
const supportedNotionVersions = new Set(['2022-06-28', '2025-09-03', latestNotionVersion]);

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function notionError(status: number, code: string, message: string) {
  return json({ object: 'error', status, code, message }, status);
}

function notionVersion(request: Request) {
  const requested = request.headers.get('Notion-Version')?.trim() || latestNotionVersion;
  if (!supportedNotionVersions.has(requested)) {
    throw Object.assign(
      new Error(`Unsupported Notion-Version: ${requested}. Supported versions: ${Array.from(supportedNotionVersions).join(', ')}.`),
      { status: 400 },
    );
  }
  return requested;
}

function legacyArchivedField(request: Request, inTrash: boolean) {
  return notionVersion(request) === latestNotionVersion ? {} : { archived: inTrash };
}

function pageArchivedField(request: Request, inTrash: boolean) {
  return notionVersion(request) === latestNotionVersion
    ? { is_archived: inTrash }
    : { archived: inTrash };
}

export async function callProductMutation(
  definition: FunctionDefinition,
  context: FunctionContext,
  body: Record<string, unknown>,
) {
  return invokeProductFunction<Record<string, unknown>, FunctionContext>(definition, context, body, {
    url: context.request.url,
    headers: context.request.headers,
    unavailableMessage: 'Canonical mutation handler is unavailable.',
  });
}

function errorCodeForStatus(status: number) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'restricted_resource';
  if (status === 404) return 'object_not_found';
  if (status === 409 || status === 423) return 'conflict_error';
  if (status >= 500) return 'internal_server_error';
  return 'validation_error';
}

function notionCompatErrorStatus(error: unknown) {
  return errorStatus(error, [
    { status: 401, needles: ['Authentication required.'] },
  ], 400);
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw Object.assign(new Error('The request body contains invalid JSON.'), {
      status: 400,
      notionCode: 'invalid_json',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('The JSON request body must be an object.'), {
      status: 400,
      notionCode: 'invalid_json',
    });
  }
  return parsed as Record<string, unknown>;
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function pageSize(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function cursorOffset(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function notionPageSize(value: unknown, field = 'page_size') {
  if (value === undefined || value === null) return 100;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(`${field} must be an integer between 1 and 100.`);
  }
  return n;
}

function notionOffsetCursor(value: unknown, field = 'start_cursor') {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${field} is invalid.`);
  }
  return Number(value);
}

function notionStringCursor(value: unknown, field = 'start_cursor') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is invalid.`);
  }
  return value.trim();
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Iterable<string>, field: string) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${field} contains unsupported field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}.`);
  }
}

function workspaceIdFromRequest(
  request: Request,
  body?: Record<string, unknown>,
): string | null {
  const bodyWorkspaceId = body
    ? optionalString(body.workspace_id) || optionalString(body.workspaceId)
    : null;
  if (bodyWorkspaceId) return bodyWorkspaceId;
  const url = new URL(request.url);
  return url.searchParams.get('workspace_id') || url.searchParams.get('workspaceId');
}

const NOTION_COMPAT_MAX_FANOUT_WORKSPACES = 200;
const NOTION_COMPAT_MAX_MATERIALIZED_ROWS = 50_000;

async function accessibleWorkspaceDbs(context: FunctionContext): Promise<Array<{ workspaceId: string; db: DbRef }>> {
  const auth = context.auth;
  if (!auth?.id) throw new Error('Authentication required.');
  if (context.compatWorkspaceId) {
    return [{
      workspaceId: context.compatWorkspaceId,
      db: boundedDbFromWorkspaceHint(context.admin, context.compatWorkspaceId),
    }];
  }
  const workspaceIds = await accessibleWorkspaceIdsForActor(
    context.admin,
    auth.id,
    normalizeAccessEmail(auth.email) || null,
  );
  if (workspaceIds.length > NOTION_COMPAT_MAX_FANOUT_WORKSPACES) {
    throw new Error(
      `Notion-compatible request spans too many workspaces (maximum ${NOTION_COMPAT_MAX_FANOUT_WORKSPACES}).`,
    );
  }
  return workspaceIds
    .sort((a, b) => a.localeCompare(b))
    .map((workspaceId) => ({ workspaceId, db: boundedDbFromWorkspaceHint(context.admin, workspaceId) }));
}

async function workspaceDbsForOptionalHint(
  context: FunctionContext,
  workspaceId: string | null | undefined,
): Promise<Array<{ workspaceId: string; db: DbRef }>> {
  if (context.compatWorkspaceId) {
    if (workspaceId && workspaceId !== context.compatWorkspaceId) {
      throw Object.assign(new Error('The token is not authorized for this workspace.'), { status: 403 });
    }
    return [{
      workspaceId: context.compatWorkspaceId,
      db: boundedDbFromWorkspaceHint(context.admin, context.compatWorkspaceId),
    }];
  }
  return workspaceId
    ? [{ workspaceId, db: boundedDbFromWorkspaceHint(context.admin, workspaceId) }]
    : accessibleWorkspaceDbs(context);
}

async function findAccessibleRecord<T>(
  context: FunctionContext,
  table: string,
  id: string,
  body?: Record<string, unknown>,
): Promise<{ db: DbRef; record: T } | null> {
  const workspaceId = workspaceIdFromRequest(context.request, body);
  const entries = await workspaceDbsForOptionalHint(context, workspaceId);
  for (const entry of entries) {
    const record = await getExisting(entry.db.table<T>(table), id);
    if (record) return { db: entry.db, record };
  }
  return null;
}

function workspaceQuery(upload: FileUpload) {
  return upload.workspaceId
    ? `?workspace_id=${encodeURIComponent(upload.workspaceId)}`
    : '';
}

function listObject<T>(
  results: T[],
  type: string,
  extra: Record<string, unknown> = {},
  start = 0,
  size = results.length,
) {
  const windowed = results.slice(start, start + size);
  const hasMore = start + size < results.length;
  return {
    object: 'list',
    results: windowed,
    next_cursor: hasMore ? String(start + size) : null,
    has_more: hasMore,
    type,
    [type]: extra,
  };
}

function listObjectByIdCursor<T>(
  results: T[],
  type: string,
  request: Request,
  idOf: (item: T) => string,
  extra: Record<string, unknown> = {},
) {
  const url = new URL(request.url);
  const cursor = notionStringCursor(url.searchParams.get('start_cursor'));
  const size = notionPageSize(url.searchParams.get('page_size'));
  let start = 0;
  if (cursor) {
    const index = results.findIndex((item) => idOf(item) === cursor);
    if (index < 0) throw new Error('start_cursor is invalid.');
    start = index + 1;
  }
  const windowed = results.slice(start, start + size);
  const hasMore = start + windowed.length < results.length;
  return {
    object: 'list',
    results: windowed,
    next_cursor: hasMore && windowed.length > 0 ? idOf(windowed[windowed.length - 1]) : null,
    has_more: hasMore,
    type,
    [type]: extra,
  };
}

async function listAll<T>(query: TableQuery<T>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await query.page(page).limit(1000).getList();
    const items = result.items ?? [];
    out.push(...items);
    if (!result.hasMore || items.length === 0) break;
  }
  return out;
}

interface MaterializationBudget {
  remaining: number;
}

function materializationBudget(): MaterializationBudget {
  return { remaining: NOTION_COMPAT_MAX_MATERIALIZED_ROWS };
}

async function listAllBounded<T>(
  query: TableQuery<T>,
  budget: MaterializationBudget,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await query.page(page).limit(1000).getList();
    const items = result.items ?? [];
    if (items.length > budget.remaining) {
      throw new Error(
        `${label} exceeds the Notion-compatible materialization limit of ${NOTION_COMPAT_MAX_MATERIALIZED_ROWS} rows.`,
      );
    }
    budget.remaining -= items.length;
    out.push(...items);
    if (!result.hasMore || items.length === 0) return out;
  }
  throw new Error(`${label} exceeded the Notion-compatible pagination limit.`);
}

async function getExisting<T>(table: TableRef<T>, id: string): Promise<T | null> {
  try {
    return await table.getOne(id);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function roleAtLeast(role: ShareRole | undefined, minimum: ShareRole) {
  return !!role && roleRanks[role] >= roleRanks[minimum];
}

// Role resolution is canonical in lib/page-access; this wrapper only pins the
// "missing workspace is an error" contract.
async function workspaceRole(db: DbRef, workspaceId: string, actorId: string): Promise<ShareRole | undefined> {
  return workspaceAccessRole(db, workspaceId, actorId, { requireWorkspace: true });
}

async function requireWorkspaceRole(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  minimum: ShareRole,
) {
  const role = await workspaceRole(db, workspaceId, actorId);
  if (!roleAtLeast(role, minimum)) throw new Error('Workspace access required.');
  return role;
}

function notionBearerResourceAllowlist(bearer?: NotionCompatBearerIdentity | null) {
  if (!bearer) return null;
  const ids = [...(bearer.grant.pageIds ?? []), ...(bearer.grant.databaseIds ?? [])]
    .map((id) => String(id).trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

async function assertNotionBearerPageAllowed(
  db: DbRef,
  page: Page,
  bearer?: NotionCompatBearerIdentity | null,
) {
  const allowlist = notionBearerResourceAllowlist(bearer);
  if (!allowlist) return;
  const visited = new Set<string>();
  let current: Page | null = page;
  while (current && !visited.has(current.id)) {
    if (current.workspaceId !== bearer!.workspaceId) break;
    if (allowlist.has(current.id)) return;
    visited.add(current.id);
    const logicalDatabaseParent: string = current.kind === 'database'
      ? dataSourceParentDatabaseId(current)
      : current.id;
    const parentId: string | undefined = logicalDatabaseParent !== current.id
      ? logicalDatabaseParent
      : optionalString(current.parentId);
    if (!parentId) break;
    current = await getExisting(db.table<Page>('pages'), parentId);
  }
  // Match Notion's restricted-resource behavior without turning a scoped
  // integration token into an existence oracle for unshared pages.
  throw Object.assign(new Error('Page was not found.'), { status: 404 });
}

async function requirePageRole(
  db: DbRef,
  pageId: string,
  actorId: string,
  minimum: ShareRole,
  actorEmail?: string | null,
  bearer?: NotionCompatBearerIdentity | null,
) {
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (!page) throw new Error('Page was not found.');
  await assertNotionBearerPageAllowed(db, page, bearer);
  const role = await pageAccessRole(db, page, actorId, undefined, actorEmail);
  if (!roleAtLeast(role, minimum)) throw new Error('Page access required.');
  return page;
}

async function requireReadablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null, bearer?: NotionCompatBearerIdentity | null) {
  return requirePageRole(db, pageId, actorId, 'view', actorEmail, bearer);
}

async function requireWritablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null, bearer?: NotionCompatBearerIdentity | null) {
  const page = await requirePageRole(db, pageId, actorId, 'edit', actorEmail, bearer);
  if (page.inTrash) throw new Error('Page is in trash.');
  if (page.isLocked) throw new Error('Page is locked.');
  return page;
}

async function requireCommentablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null, bearer?: NotionCompatBearerIdentity | null) {
  const page = await requirePageRole(db, pageId, actorId, 'comment', actorEmail, bearer);
  if (page.inTrash) throw new Error('Page is in trash.');
  return page;
}

function originOf(request: Request) {
  return new URL(request.url).origin;
}

function pageUrl(page: Page, request: Request) {
  return `${originOf(request)}/p/${encodeURIComponent(page.id)}`;
}

function richTextFromPlainText(text: unknown) {
  const content = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!content) return [];
  return [
    {
      type: 'text',
      text: { content, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
      plain_text: content,
      href: null,
    },
  ];
}

function richTextToPlainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (!isRecord(item)) return '';
      if (typeof item.plain_text === 'string') return item.plain_text;
      if (isRecord(item.text) && typeof item.text.content === 'string') return item.text.content;
      if (isRecord(item.mention)) {
        if (isRecord(item.mention.page) && typeof item.mention.page.id === 'string') return item.mention.page.id;
        if (isRecord(item.mention.user) && typeof item.mention.user.id === 'string') return item.mention.user.id;
        if (isRecord(item.mention.date) && typeof item.mention.date.start === 'string') return item.mention.date.start;
      }
      return '';
    })
    .join('');
}

function spanToNotionRichText(span: RichTextSpan) {
  const annotations = {
    bold: span.bold === true,
    italic: span.italic === true,
    strikethrough: span.strikethrough === true,
    underline: span.underline === true,
    code: span.code === true,
    color: span.color || 'default',
  };
  if (span.mention === 'page' && span.pageId) {
    return {
      type: 'mention',
      mention: { type: 'page', page: { id: span.pageId } },
      annotations,
      plain_text: span.text || span.pageId,
      href: null,
    };
  }
  if (span.mention === 'person' && span.userId) {
    return {
      type: 'mention',
      mention: { type: 'user', user: notionUser(span.userId) },
      annotations,
      plain_text: span.text || span.userId,
      href: null,
    };
  }
  if (span.mention === 'date' && span.date) {
    return {
      type: 'mention',
      mention: { type: 'date', date: { start: span.date, end: null, time_zone: null } },
      annotations,
      plain_text: span.text || span.date,
      href: null,
    };
  }
  if (span.equation) {
    return {
      type: 'equation',
      equation: { expression: span.equation },
      annotations,
      plain_text: span.equation,
      href: null,
    };
  }
  return {
    type: 'text',
    text: {
      content: span.text || '',
      link: span.link ? { url: span.link } : null,
    },
    annotations,
    plain_text: span.text || '',
    href: span.link || null,
  };
}

function spansToNotionRichText(value: unknown) {
  if (!Array.isArray(value)) return richTextFromPlainText('');
  return value
    .filter((item): item is RichTextSpan => isRecord(item))
    .map((item) => spanToNotionRichText(item));
}

function notionRichTextToSpans(value: unknown): RichTextSpan[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) return { text: '' };
    const annotations = isRecord(item.annotations) ? item.annotations : {};
    const base: RichTextSpan = {
      text: typeof item.plain_text === 'string' ? item.plain_text : richTextToPlainText([item]),
      bold: annotations.bold === true,
      italic: annotations.italic === true,
      underline: annotations.underline === true,
      strikethrough: annotations.strikethrough === true,
      code: annotations.code === true,
      color: typeof annotations.color === 'string' ? annotations.color : undefined,
    };
    if (isRecord(item.text) && isRecord(item.text.link) && typeof item.text.link.url === 'string') {
      base.link = item.text.link.url;
    }
    if (isRecord(item.mention)) {
      if (isRecord(item.mention.page) && typeof item.mention.page.id === 'string') {
        return { ...base, mention: 'page' as const, pageId: item.mention.page.id };
      }
      if (isRecord(item.mention.user) && typeof item.mention.user.id === 'string') {
        return { ...base, mention: 'person' as const, userId: item.mention.user.id };
      }
      if (isRecord(item.mention.date) && typeof item.mention.date.start === 'string') {
        return { ...base, mention: 'date' as const, date: item.mention.date.start };
      }
    }
    if (isRecord(item.equation) && typeof item.equation.expression === 'string') {
      return { ...base, equation: item.equation.expression };
    }
    return base;
  });
}

function inlineCommentMarkdownToSpans(value: unknown): RichTextSpan[] {
  const markdown = typeof value === 'string' ? value : '';
  const spans: RichTextSpan[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*[^*\n]+\*|\$[^$\n]+\$)/g;
  let offset = 0;
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index ?? offset;
    if (index > offset) spans.push({ text: markdown.slice(offset, index) });
    const token = match[0];
    if (token.startsWith('**')) spans.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('~~')) spans.push({ text: token.slice(2, -2), strikethrough: true });
    else if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('*')) spans.push({ text: token.slice(1, -1), italic: true });
    else if (token.startsWith('$')) spans.push({ text: token.slice(1, -1), equation: token.slice(1, -1) });
    else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      spans.push(link ? { text: link[1], link: link[2] } : { text: token });
    }
    offset = index + token.length;
    if (spans.length > 100) throw new Error('Comment Markdown expands to more than 100 rich-text items.');
  }
  if (offset < markdown.length) spans.push({ text: markdown.slice(offset) });
  if (spans.length > 100) throw new Error('Comment Markdown expands to more than 100 rich-text items.');
  return spans;
}

function optionList(prop: DbProperty): SelectOption[] {
  const options = prop.config?.options;
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is SelectOption => isRecord(item) && typeof item.name === 'string');
}

function notionOption(option: SelectOption | string | null | undefined) {
  if (!option) return null;
  if (typeof option === 'string') {
    return { id: option, name: option, color: 'default', description: null };
  }
  return {
    id: option.id,
    name: option.name,
    color: notionSelectColors.has(option.color || '') ? option.color : 'default',
    description: option.description ?? null,
  };
}

interface StoredStatusGroup {
  id: string;
  name: string;
  color: string;
  optionIds?: string[];
}

function storedStatusGroups(prop: DbProperty): StoredStatusGroup[] {
  const notionConfig = isRecord(prop.config?.notion) && isRecord(prop.config.notion.status)
    ? prop.config.notion.status
    : null;
  const raw = Array.isArray(prop.config?.statusGroups)
    ? prop.config.statusGroups
    : notionConfig?.groups;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = optionalString(value.id);
    const name = optionalString(value.name);
    const color = optionalString(value.color);
    if (!id || !name || !color || !notionSelectColors.has(color)) return [];
    const optionIds = Array.isArray(value.optionIds)
      ? value.optionIds.filter((item): item is string => typeof item === 'string')
      : Array.isArray(value.option_ids)
        ? value.option_ids.filter((item): item is string => typeof item === 'string')
        : undefined;
    return [{ id, name, color, optionIds }];
  });
}

function statusGroupForOption(prop: DbProperty, option: SelectOption | null | undefined) {
  if (!option) return undefined;
  const explicit = optionalString(option.group);
  if (explicit) return explicit;
  const stored = storedStatusGroups(prop);
  return stored.find((group) => group.optionIds?.includes(option.id))?.name
    || stored[0]?.name
    || 'To-do';
}

function notionStatusGroups(prop: DbProperty, options: SelectOption[]) {
  const stored = storedStatusGroups(prop);
  const byName = new Map(stored.map((group) => [group.name, group]));
  const orderedNames = stored.length > 0
    ? stored.map((group) => group.name)
    : [...notionStatusGroupNames];
  return orderedNames.slice(0, 100).map((name) => {
    const storedGroup = byName.get(name);
    const canonical = notionStatusGroupNames.includes(name as NotionStatusGroupName)
      ? notionStatusGroupDefaults[name as NotionStatusGroupName]
      : { color: 'default', suffix: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'group' };
    const optionIds = options
      .filter((option) => statusGroupForOption(prop, option) === name)
      .map((option) => option.id)
      .slice(0, 100);
    return {
      id: storedGroup?.id || `${prop.id}:${canonical.suffix}`,
      name,
      color: storedGroup?.color || canonical.color,
      option_ids: optionIds,
    };
  });
}

function findOption(prop: DbProperty, value: unknown) {
  const options = optionList(prop);
  if (isRecord(value)) {
    const id = optionalString(value.id);
    const name = optionalString(value.name);
    return options.find((item) => item.id === id || item.name === name) ?? (name ? { id: name, name } : null);
  }
  if (typeof value === 'string') {
    return options.find((item) => item.id === value || item.name === value) ?? { id: value, name: value };
  }
  return null;
}

async function ensureOptionValue(db: DbRef, prop: DbProperty, input: unknown, index = 0) {
  const options = optionList(prop);
  const found = findOption(prop, input);
  if (found && options.some((item) => item.id === found.id || item.name === found.name)) return found.id;
  if (!found?.name) return null;
  const option = {
    id: found.id || newId(),
    name: found.name,
    color: found.color || optionColors[index % optionColors.length],
  };
  const config = {
    ...(prop.config ?? {}),
    options: [...options, option],
  };
  const updated = await db.table<DbProperty>('db_properties').update(prop.id, { config });
  prop.config = updated.config;
  return option.id;
}

function notionDateFromLocal(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const [start, end] = value.split('/');
  return { start, end: end || null, time_zone: null };
}

function localDateFromNotion(value: unknown) {
  if (!isRecord(value)) return null;
  const start = optionalString(value.start);
  if (!start) return null;
  const end = optionalString(value.end);
  return end ? `${start}/${end}` : start;
}

function normalizeIdArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (isRecord(item) && typeof item.id === 'string') return item.id;
      return '';
    })
    .filter(Boolean);
}

function fileFromLocal(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((file) => {
      const name = optionalString(file.name) || optionalString(file.url) || 'Untitled';
      const url = optionalString(file.url) || optionalString(file.sourceUrl) || '';
      if (file.notionFileSource === 'file' && url) {
        return {
          name,
          type: 'file',
          file: {
            url,
            expiry_time: optionalString(file.expiryTime) || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        };
      }
      return {
        name,
        type: 'external',
        external: { url },
      };
    });
}

async function localFileFromNotion(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  value: unknown,
) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('files must be an array with at most 100 items.');
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [index, rawFile] of value.entries()) {
    if (!isRecord(rawFile)) throw new Error(`files[${index}] must be an object.`);
    assertOnlyKeys(rawFile, ['name', 'type', 'external', 'file_upload'], `files[${index}]`);
    const name = rawFile.name === undefined
      ? undefined
      : requireString(rawFile.name, `files[${index}].name`);
    const hasExternal = rawFile.external !== undefined;
    const hasUpload = rawFile.file_upload !== undefined;
    if (hasExternal === hasUpload) {
      throw new Error(`files[${index}] must contain exactly one of external or file_upload.`);
    }
    const inferredType = hasUpload ? 'file_upload' : 'external';
    if (rawFile.type !== undefined && rawFile.type !== inferredType) {
      throw new Error(`files[${index}].type must be ${inferredType}.`);
    }
    if (hasExternal) {
      if (!isRecord(rawFile.external)) throw new Error(`files[${index}].external must be an object.`);
      assertOnlyKeys(rawFile.external, ['url'], `files[${index}].external`);
      const url = notionExternalAssetUrl(rawFile.external.url, `files[${index}].external.url`);
      out.push({
        id: newId(),
        name: name || url,
        url,
        sourceUrl: url,
        notionFileSource: 'external',
      });
      continue;
    }
    const upload = await consumableNotionFileUpload(
      context,
      db,
      workspaceId,
      rawFile.file_upload,
      `files[${index}]`,
    );
    out.push({
      id: newId(),
      name: name || upload.name || 'Untitled',
      notionFileUploadId: upload.id,
      notionFileSource: 'file',
    });
  }
  return out;
}

function notionUser(id: string, email?: string | null, name?: string | null) {
  return {
    object: 'user',
    id,
    name: name || email || id,
    avatar_url: null,
    type: 'person',
    person: email ? { email } : {},
  };
}

function selectedUserRosterWorkspaceId(context: FunctionContext) {
  return context.compatWorkspaceId || workspaceIdFromRequest(context.request);
}

function narrowerWorkspaceRole(initial: ShareRole, final: ShareRole) {
  return roleRanks[initial] <= roleRanks[final] ? initial : final;
}

function workspaceRosterAccessError() {
  return Object.assign(new Error('Workspace access required.'), { status: 403 });
}

async function canonicalUserRoster(context: FunctionContext) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const workspaceId = selectedUserRosterWorkspaceId(context);
  if (!workspaceId) return [notionUser(auth.id, auth.email ?? null)];

  const db = context.admin.db('app');
  const initialRole = await workspaceAccessRole(db, workspaceId, auth.id, { requireWorkspace: true });
  if (!initialRole) throw workspaceRosterAccessError();

  // Materialize the selected workspace roster once. Authority is a shared
  // request decision, not one role lookup per returned member.
  const memberships = await listAll(
    db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
  );

  // A removal or downgrade while the roster read was settling must affect the
  // whole response. Build the public projection only after this fresh fence so
  // no broader prefix can escape.
  const finalRole = await workspaceAccessRole(db, workspaceId, auth.id, { requireWorkspace: true });
  if (!finalRole) throw workspaceRosterAccessError();
  const effectiveRole = narrowerWorkspaceRole(initialRole, finalRole);
  const manager = effectiveRole === 'full_access';
  const guest = roleRanks[effectiveRole] < roleRanks.edit;

  const byUser = new Map<string, WorkspaceMember>();
  for (const member of memberships) {
    if (!member.userId || byUser.has(member.userId)) continue;
    byUser.set(member.userId, member);
  }
  const existingSelf = byUser.get(auth.id);
  byUser.set(auth.id, {
    ...(existingSelf ?? {}),
    id: existingSelf?.id || auth.id,
    workspaceId,
    userId: auth.id,
    email: auth.email || existingSelf?.email || null,
    displayName: existingSelf?.displayName || auth.email || auth.id,
  });

  const members = guest
    ? [byUser.get(auth.id)!]
    : Array.from(byUser.values());
  return members
    .map((member) => notionUser(
      member.userId,
      manager || member.userId === auth.id ? member.email ?? null : null,
      member.displayName ?? null,
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function getUserEndpoint(context: FunctionContext, userId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const targetId = userId === 'me' ? auth.id : userId;
  const user = (await canonicalUserRoster(context)).find((candidate) => candidate.id === targetId);
  if (user) return user;
  throw new Error('User was not found.');
}

function propertyNotionType(type: string) {
  if (type === 'person') return 'people';
  if (type === 'phone') return 'phone_number';
  if (type === 'unique_id') return 'unique_id';
  return type;
}

function propertyLocalType(type: string) {
  if (type === 'people') return 'person';
  if (type === 'phone_number') return 'phone';
  return type;
}

const NOTION_RICH_TEXT_METADATA_KEY = '__notionCompatRichText';

function localValueForProperty(page: Page, prop: DbProperty) {
  const richTextMetadata = isRecord(page.properties?.[NOTION_RICH_TEXT_METADATA_KEY])
    ? page.properties?.[NOTION_RICH_TEXT_METADATA_KEY] as Record<string, unknown>
    : null;
  if ((prop.type === 'title' || prop.type === 'rich_text') && Array.isArray(richTextMetadata?.[prop.id])) {
    return richTextMetadata[prop.id];
  }
  if (prop.type === 'title') return page.title ?? '';
  if (prop.type === 'created_time') return page.createdAt ?? null;
  if (prop.type === 'last_edited_time') return page.updatedAt ?? null;
  if (prop.type === 'created_by') return page.createdBy ?? null;
  if (prop.type === 'last_edited_by') return page.lastEditedBy ?? null;
  if (prop.type === 'formula' || prop.type === 'rollup') {
    return page.__computed?.[prop.id]?.value ?? page.__computed?.[prop.id]?.formatted ?? null;
  }
  return page.properties?.[prop.id] ?? null;
}

function notionFormulaValue(value: unknown) {
  if (typeof value === 'number') return { type: 'number', number: value };
  if (typeof value === 'boolean') return { type: 'boolean', boolean: value };
  if (isRecord(value) && typeof value.start === 'string') {
    return {
      type: 'date',
      date: {
        start: value.start,
        end: typeof value.end === 'string' ? value.end : null,
        time_zone: typeof value.time_zone === 'string' ? value.time_zone : null,
      },
    };
  }
  if (typeof value === 'string') return { type: 'string', string: value };
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return { type: 'string', string: formatFormulaValue(value as FormulaValue) };
  }
  return { type: 'string', string: value == null ? null : String(value) };
}

const notionRollupFunctions = new Set([
  'count', 'count_values', 'empty', 'not_empty', 'unique', 'show_unique',
  'percent_empty', 'percent_not_empty', 'sum', 'average', 'median', 'min',
  'max', 'range', 'earliest_date', 'latest_date', 'date_range', 'checked',
  'unchecked', 'percent_checked', 'percent_unchecked', 'count_per_group',
  'percent_per_group', 'show_original',
]);

const notionNumberRollupFunctions = new Set([
  'count', 'count_values', 'empty', 'not_empty', 'unique', 'percent_empty',
  'percent_not_empty', 'sum', 'average', 'median', 'min', 'max', 'range',
  'checked', 'unchecked', 'percent_checked', 'percent_unchecked',
  'count_per_group', 'percent_per_group',
]);

function notionRollupArrayItem(value: unknown): Record<string, unknown> {
  if (isRecord(value) && typeof value.type === 'string' && value.type in value) {
    const propertyValue = { ...value };
    delete propertyValue.id;
    delete propertyValue.object;
    return propertyValue;
  }
  if (typeof value === 'number') return { type: 'number', number: value };
  if (typeof value === 'boolean') return { type: 'checkbox', checkbox: value };
  if (isRecord(value) && typeof value.start === 'string') {
    return { type: 'date', date: { start: value.start, end: value.end ?? null, time_zone: value.time_zone ?? null } };
  }
  return { type: 'rich_text', rich_text: richTextFromPlainText(value == null ? '' : String(value)) };
}

function notionRollupValue(value: unknown, rawFunction?: unknown) {
  const rollupFunction = officialRollupFunction(rawFunction);
  if (notionNumberRollupFunctions.has(rollupFunction)) {
    const trimmedValue = typeof value === 'string' ? value.trim() : value;
    const formattedPercentMatch = rollupFunction.startsWith('percent_')
      && typeof trimmedValue === 'string'
      // rollupPercent emits 0..100 without leading or decimal trailing zeros.
      ? /^((?:0|[1-9]\d?|100|(?:0|[1-9]\d?)\.(?:[1-9]|\d[1-9])))%$/.exec(trimmedValue)
      : null;
    const numericValue = formattedPercentMatch ? formattedPercentMatch[1] : trimmedValue;
    let number = numericValue == null || numericValue === ''
      ? Number.NaN
      : typeof numericValue === 'number'
        ? numericValue
        : Number(numericValue);
    if (formattedPercentMatch && Number.isFinite(number)) number /= 100;
    return { type: 'number', number: Number.isFinite(number) ? number : null, function: rollupFunction };
  }
  if (rollupFunction === 'earliest_date' || rollupFunction === 'latest_date' || rollupFunction === 'date_range') {
    const normalized = typeof value === 'string' ? value.replace(/\s+→\s+/, '/') : value;
    return { type: 'date', date: notionDateFromLocal(normalized), function: rollupFunction };
  }
  if (Array.isArray(value)) {
    return { type: 'array', array: value.slice(0, 100).map(notionRollupArrayItem), function: rollupFunction };
  }
  if (typeof value === 'string' && value) {
    return { type: 'array', array: [notionRollupArrayItem(value)], function: rollupFunction };
  }
  if (value && typeof value === 'object') {
    return { type: 'unsupported', unsupported: {}, function: rollupFunction };
  }
  return { type: 'array', array: [], function: rollupFunction };
}

function notionVerificationValue(page: Page, value: unknown) {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  if (value.state === 'unverified') {
    return { state: 'unverified', date: null, verified_by: null };
  }
  if (value.state !== 'verified' && value.state !== 'expired') return null;
  const verifiedBy = isRecord(value.verified_by)
    ? value.verified_by
    : notionUser(optionalString(value.verified_by) || page.lastEditedBy || page.createdBy || '');
  return {
    state: value.state,
    date: isRecord(value.date) ? value.date : null,
    verified_by: verifiedBy,
  };
}

function notionPropertyValue(page: Page, prop: DbProperty) {
  const type = propertyNotionType(prop.type);
  const value = localValueForProperty(page, prop);
  if (prop.type === 'title') {
    return { id: prop.id, type, title: Array.isArray(value) ? spansToNotionRichText(value) : richTextFromPlainText(value) };
  }
  if (prop.type === 'rich_text') {
    return { id: prop.id, type, rich_text: Array.isArray(value) ? spansToNotionRichText(value) : richTextFromPlainText(value) };
  }
  if (prop.type === 'number') return { id: prop.id, type, number: typeof value === 'number' ? value : value == null || value === '' ? null : Number(value) };
  if (prop.type === 'select' || prop.type === 'status') return { id: prop.id, type, [type]: notionOption(findOption(prop, value)) };
  if (prop.type === 'multi_select') {
    const options = Array.isArray(value) ? value.map((item) => notionOption(findOption(prop, item))).filter(Boolean) : [];
    return { id: prop.id, type, multi_select: options };
  }
  if (prop.type === 'date') return { id: prop.id, type, date: notionDateFromLocal(value) };
  if (prop.type === 'checkbox') return { id: prop.id, type, checkbox: value === true };
  if (prop.type === 'url') return { id: prop.id, type, url: value == null ? null : String(value) };
  if (prop.type === 'email') return { id: prop.id, type, email: value == null ? null : String(value) };
  if (prop.type === 'phone') return { id: prop.id, type, phone_number: value == null ? null : String(value) };
  if (prop.type === 'relation') {
    const relatedIds = normalizeIdArray(value);
    return {
      id: prop.id,
      type,
      relation: relatedIds.slice(0, 25).map((id) => ({ id })),
      has_more: relatedIds.length > 25,
    };
  }
  if (prop.type === 'person') return { id: prop.id, type, people: normalizeIdArray(value).map((id) => notionUser(id)) };
  if (prop.type === 'files') return { id: prop.id, type, files: fileFromLocal(value) };
  if (prop.type === 'created_time') return { id: prop.id, type, created_time: page.createdAt ?? null };
  if (prop.type === 'last_edited_time') return { id: prop.id, type, last_edited_time: page.updatedAt ?? null };
  if (prop.type === 'created_by') return { id: prop.id, type, created_by: notionUser(page.createdBy || '') };
  if (prop.type === 'last_edited_by') return { id: prop.id, type, last_edited_by: notionUser(page.lastEditedBy || '') };
  if (prop.type === 'formula') return { id: prop.id, type, formula: notionFormulaValue(value) };
  if (prop.type === 'rollup') {
    const relationPropertyId = optionalString(prop.config?.rollupRelationPropertyId);
    const relatedIds = relationPropertyId ? normalizeIdArray(page.properties?.[relationPropertyId]) : [];
    return {
      id: prop.id,
      type,
      rollup: relatedIds.length > 25
        ? {
            type: 'incomplete',
            incomplete: {},
            function: officialRollupFunction(
              prop.config?.rollupFunction ?? prop.config?.function ?? prop.config?.aggregation,
            ),
          }
        : notionRollupValue(
            value,
            prop.config?.rollupFunction ?? prop.config?.function ?? prop.config?.aggregation,
          ),
    };
  }
  if (prop.type === 'unique_id') {
    const prefix = optionalString(prop.config?.idPrefix) || null;
    return { id: prop.id, type, unique_id: { prefix, number: typeof value === 'number' ? value : value == null ? null : Number(value) } };
  }
  if (prop.type === 'button') return { id: prop.id, type, button: {} };
  if (prop.type === 'place') {
    return { id: prop.id, type, place: isRecord(value) ? { ...value } : null };
  }
  if (prop.type === 'verification') {
    return { id: prop.id, type, verification: notionVerificationValue(page, value) };
  }
  return { id: prop.id, type: 'rich_text', rich_text: richTextFromPlainText(value) };
}

function propertyItemBase(prop: DbProperty) {
  return {
    object: 'property_item',
    id: prop.id,
    type: propertyNotionType(prop.type),
  };
}

function propertyItemsForPage(page: Page, prop: DbProperty) {
  const value = notionPropertyValue(page, prop) as Record<string, unknown>;
  const type = String(value.type || propertyNotionType(prop.type));
  if (type === 'title' || type === 'rich_text') {
    const items = Array.isArray(value[type]) ? value[type] : [];
    return items.map((item) => ({
      ...propertyItemBase(prop),
      [type]: item,
    }));
  }
  if (type === 'people' || type === 'relation') {
    const raw = localValueForProperty(page, prop);
    const items = normalizeIdArray(raw).map((id) => (
      type === 'people' ? notionUser(id) : { id }
    ));
    return items.map((item) => ({
      ...propertyItemBase(prop),
      [type]: item,
    }));
  }
  return [{ ...propertyItemBase(prop), [type]: value[type] ?? null }];
}

async function rollupPropertyItemResponse(
  context: FunctionContext,
  db: DbRef,
  page: Page,
  prop: DbProperty,
  request: Request,
) {
  const relationPropertyId = optionalString(prop.config?.rollupRelationPropertyId);
  const targetPropertyId = optionalString(prop.config?.rollupTargetPropertyId);
  const relatedIds = relationPropertyId
    ? normalizeIdArray(page.properties?.[relationPropertyId])
    : [];
  const targetProp = targetPropertyId
    ? await getExisting(db.table<DbProperty>('db_properties'), targetPropertyId)
    : null;
  const entries: Array<{ cursor: string; item: Record<string, unknown> }> = [];
  for (const relatedId of relatedIds) {
    const related = await requireReadablePage(
      db,
      relatedId,
      context.auth!.id,
      context.auth?.email,
      context.compatBearer,
    );
    const items = targetProp
      ? propertyItemsForPage(related, targetProp)
      : [{ ...propertyItemBase(prop), type: 'relation', relation: { id: related.id } }];
    items.forEach((item, index) => entries.push({
      cursor: `${related.id}:${index}`,
      item: item as Record<string, unknown>,
    }));
  }
  const url = new URL(request.url);
  const cursor = notionStringCursor(url.searchParams.get('start_cursor'));
  let start = 0;
  if (cursor) {
    const index = entries.findIndex((entry) => entry.cursor === cursor);
    if (index < 0) throw new Error('start_cursor is invalid.');
    start = index + 1;
  }
  const size = notionPageSize(url.searchParams.get('page_size'));
  const windowed = entries.slice(start, start + size);
  const hasMore = start + windowed.length < entries.length;
  const nextCursor = hasMore && windowed.length > 0
    ? windowed[windowed.length - 1].cursor
    : null;
  let nextUrl: string | null = null;
  if (nextCursor) {
    const next = new URL(request.url);
    next.searchParams.set('start_cursor', nextCursor);
    nextUrl = next.toString();
  }
  const rollupFunction = officialRollupFunction(prop.config?.rollupFunction);
  const unsupported = rollupFunction === 'show_unique'
    || rollupFunction === 'unique'
    || rollupFunction === 'median';
  const rollup = hasMore
    ? { type: 'incomplete', incomplete: {}, function: rollupFunction }
    : unsupported
      ? { type: 'unsupported', unsupported: {}, function: rollupFunction }
      : notionRollupValue(localValueForProperty(page, prop), rollupFunction);
  return {
    object: 'list',
    results: windowed.map((entry) => entry.item),
    next_cursor: nextCursor,
    has_more: hasMore,
    type: 'property_item',
    property_item: {
      id: prop.id,
      type: 'rollup',
      rollup,
      next_url: nextUrl,
    },
  };
}

async function propertyItemResponse(
  context: FunctionContext,
  db: DbRef,
  page: Page,
  prop: DbProperty,
  request: Request,
) {
  if (prop.type === 'rollup') return rollupPropertyItemResponse(context, db, page, prop, request);
  const url = new URL(request.url);
  const start = notionOffsetCursor(url.searchParams.get('start_cursor'));
  const size = notionPageSize(url.searchParams.get('page_size'));
  const items = propertyItemsForPage(page, prop);
  const type = propertyNotionType(prop.type);
  if (type === 'title' || type === 'rich_text' || type === 'people' || type === 'relation') {
    if (start > items.length) throw new Error('start_cursor is invalid.');
    const results = items.slice(start, start + size);
    const hasMore = start + results.length < items.length;
    const nextCursor = hasMore ? String(start + results.length) : null;
    let nextUrl: string | null = null;
    if (nextCursor) {
      const next = new URL(request.url);
      next.searchParams.set('start_cursor', nextCursor);
      nextUrl = next.toString();
    }
    return {
      object: 'list',
      results,
      next_cursor: nextCursor,
      has_more: hasMore,
      type: 'property_item',
      property_item: {
        id: prop.id,
        type,
        [type]: {},
        next_url: nextUrl,
      },
    };
  }
  return items[0] ?? { ...propertyItemBase(prop), [type]: null };
}

function notionPropertiesForPage(page: Page, props: DbProperty[]) {
  const out: Record<string, unknown> = {};
  for (const prop of props.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    // The current public OpenAPI permits these two schema configurations but
    // defines no page-value or property-item response shape for them.
    if (prop.type === 'location' || prop.type === 'last_visited_time') continue;
    out[prop.name || prop.id] = notionPropertyValue(page, prop);
  }
  if (props.length === 0) {
    out.title = { id: 'title', type: 'title', title: richTextFromPlainText(page.title ?? '') };
  }
  return out;
}

function notionParent(page: Page) {
  if (page.parentType === 'database' && page.parentId) {
    return { type: 'data_source_id', data_source_id: page.parentId };
  }
  if (page.parentType === 'page' && page.parentId) return { type: 'page_id', page_id: page.parentId };
  return { type: 'workspace', workspace: true };
}

function notionDatabaseParent(page: Page) {
  if (page.parentType === 'database' && page.parentId) {
    return { type: 'database_id', database_id: page.parentId };
  }
  if (page.parentType === 'page' && page.parentId) return { type: 'page_id', page_id: page.parentId };
  return { type: 'workspace', workspace: true };
}

function notionIcon(page: Page) {
  if ((!page.icon || page.iconType === 'none') && isRecord(page.notionIcon)) {
    const icon = { ...page.notionIcon };
    delete icon.fileUploadId;
    return icon;
  }
  if (!page.icon || page.iconType === 'none') return null;
  if (page.iconType === 'emoji') return { type: 'emoji', emoji: page.icon };
  return { type: 'external', external: { url: page.icon } };
}

function notionCover(page: Page) {
  if (!page.cover && isRecord(page.notionCover)) {
    const cover = { ...page.notionCover };
    delete cover.fileUploadId;
    return cover;
  }
  if (!page.cover) return null;
  return { type: 'external', external: { url: page.cover } };
}

function notionPage(page: Page, props: DbProperty[], request: Request) {
  const inTrash = page.inTrash === true;
  const createdTime = page.createdAt ?? new Date(0).toISOString();
  return {
    object: 'page',
    id: page.id,
    created_time: createdTime,
    last_edited_time: page.updatedAt ?? createdTime,
    created_by: notionPartialUser(page.createdBy),
    last_edited_by: notionPartialUser(page.lastEditedBy || page.createdBy),
    cover: notionCover(page),
    icon: notionIcon(page),
    parent: notionParent(page),
    ...pageArchivedField(request, inTrash),
    in_trash: inTrash,
    is_locked: page.isLocked === true,
    properties: notionPropertiesForPage(page, props),
    url: pageUrl(page, request),
    public_url: page.isPublic ? pageUrl(page, request) : null,
  };
}

function officialRollupFunction(value: unknown) {
  const candidate = optionalString(value) || 'show_original';
  const legacyAliases: Record<string, string> = {
    count_all: 'count',
    count_empty: 'empty',
    count_not_empty: 'not_empty',
    count_unique: 'unique',
    count_unique_values: 'unique',
  };
  const normalized = legacyAliases[candidate] || candidate;
  return notionRollupFunctions.has(normalized) ? normalized : 'show_original';
}

function notionPropertySchema(prop: DbProperty, namesById: Map<string, string>) {
  const type = propertyNotionType(prop.type);
  const config = prop.config ?? {};
  const base: Record<string, unknown> = {
    id: prop.id,
    name: prop.name,
    type,
    description: prop.description ?? null,
  };
  if (type === 'select' || type === 'multi_select') {
    base[type] = { options: optionList(prop).map((option) => notionOption(option)) };
  } else if (type === 'status') {
    const options = optionList(prop);
    base.status = {
      options: options.map((option) => notionOption(option)),
      groups: notionStatusGroups(prop, options),
    };
  } else if (type === 'number') {
    base.number = { format: config.numberFormat || 'number' };
  } else if (type === 'relation') {
    const relatedPropertyId = optionalString(config.relatedPropertyId);
    base.relation = {
      data_source_id: config.relationDatabaseId || prop.databaseId,
      database_id: config.relationDatabaseId || prop.databaseId,
      ...(relatedPropertyId
        ? {
            type: 'dual_property',
            dual_property: {
              synced_property_id: relatedPropertyId,
              synced_property_name:
                optionalString(config.relatedPropertyName) || namesById.get(relatedPropertyId) || '',
            },
          }
        : { type: 'single_property', single_property: {} }),
    };
  } else if (type === 'formula') {
    base.formula = { expression: config.formula || '' };
  } else if (type === 'rollup') {
    base.rollup = {
      relation_property_id: config.rollupRelationPropertyId || null,
      relation_property_name:
        optionalString(config.rollupRelationPropertyName)
        || namesById.get(String(config.rollupRelationPropertyId || ''))
        || '',
      rollup_property_id: config.rollupTargetPropertyId || null,
      rollup_property_name:
        optionalString(config.rollupTargetPropertyName)
        || namesById.get(String(config.rollupTargetPropertyId || ''))
        || '',
      function: officialRollupFunction(config.rollupFunction),
    };
  } else if (type === 'unique_id') {
    base.unique_id = { prefix: config.idPrefix || null };
  } else {
    base[type] = {};
  }
  return base;
}

async function notionPropertySchemaMap(db: DbRef, props: DbProperty[]) {
  const resolvedProps = props.map((prop) => ({
    ...prop,
    ...(prop.config ? { config: { ...prop.config } } : {}),
  }));
  await resolveNotionRollupSchemaReferences(db, resolvedProps[0]?.databaseId || '', resolvedProps, false);
  const namesById = new Map(resolvedProps.map((prop) => [prop.id, prop.name]));
  const referencedIds = new Set<string>();
  for (const prop of resolvedProps) {
    for (const value of [
      prop.config?.relatedPropertyId,
      prop.config?.rollupRelationPropertyId,
      prop.config?.rollupTargetPropertyId,
    ]) {
      if (typeof value === 'string' && value && !namesById.has(value)) referencedIds.add(value);
    }
  }
  await Promise.all(Array.from(referencedIds).map(async (id) => {
    const referenced = await getExisting(db.table<DbProperty>('db_properties'), id);
    if (referenced) namesById.set(id, referenced.name);
  }));
  const out: Record<string, unknown> = {};
  for (const prop of resolvedProps.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    out[prop.name || prop.id] = notionPropertySchema(prop, namesById);
  }
  return out;
}

function pageTitleRichText(page: Page) {
  return richTextFromPlainText(page.title ?? '');
}

function notionCompatDescription(page: Page) {
  const description = page.properties?.notionDescription;
  return richTextFromPlainText(typeof description === 'string' ? description : '');
}

function notionCompatInline(page: Page, fallback: boolean) {
  const value = page.properties?.notionIsInline;
  return typeof value === 'boolean' ? value : fallback;
}

function notionCompatDatabaseType(page: Page) {
  const value = page.properties?.notionDatabaseType;
  return value === 'tasks' || value === 'projects' || value === 'skills' ? value : undefined;
}

function notionPartialUser(id: string | undefined) {
  return { object: 'user', id: id || '' };
}

async function notionDatabase(context: FunctionContext, db: DbRef, page: Page, request: Request) {
  page = await refreshNotionPageFiles(context, db, page, []);
  const inTrash = page.inTrash === true;
  const childDataSources = (await listAll(db.table<Page>('pages').where('workspaceId', '==', page.workspaceId)))
    .filter((candidate) => (
      candidate.kind === 'database'
      && candidate.id !== page.id
      && dataSourceParentDatabaseId(candidate) === page.id
      && !candidate.inTrash
    ));
  const createdTime = page.createdAt ?? new Date(0).toISOString();
  const lastEditedTime = page.updatedAt ?? createdTime;
  return {
    object: 'database',
    id: page.id,
    created_time: createdTime,
    last_edited_time: lastEditedTime,
    title: pageTitleRichText(page),
    description: notionCompatDescription(page),
    icon: notionIcon(page),
    cover: notionCover(page),
    parent: notionDatabaseParent(page),
    ...legacyArchivedField(request, inTrash),
    in_trash: inTrash,
    is_inline: notionCompatInline(page, false),
    ...(notionCompatDatabaseType(page) ? { database_type: notionCompatDatabaseType(page) } : {}),
    is_locked: page.isLocked === true,
    data_sources: [page, ...childDataSources].map((source) => ({
      id: source.id,
      name: source.title || 'Untitled',
    })),
    url: pageUrl(page, request),
    public_url: page.isPublic ? pageUrl(page, request) : null,
  };
}

function dataSourceParentDatabaseId(page: Page) {
  const marker = page.properties?.notionParentDatabaseId;
  return typeof marker === 'string' && marker.trim() ? marker.trim() : page.id;
}

async function notionDataSource(
  context: FunctionContext,
  db: DbRef,
  page: Page,
  props: DbProperty[],
  request: Request,
) {
  page = await refreshNotionPageFiles(context, db, page, props);
  const inTrash = page.inTrash === true;
  const parentDatabaseId = dataSourceParentDatabaseId(page);
  const parentDatabase = parentDatabaseId === page.id
    ? page
    : await getExisting(db.table<Page>('pages'), parentDatabaseId);
  const createdTime = page.createdAt ?? new Date(0).toISOString();
  const lastEditedTime = page.updatedAt ?? createdTime;
  return {
    object: 'data_source',
    id: page.id,
    title: pageTitleRichText(page),
    description: notionCompatDescription(page),
    created_time: createdTime,
    last_edited_time: lastEditedTime,
    created_by: notionPartialUser(page.createdBy),
    last_edited_by: notionPartialUser(page.lastEditedBy || page.createdBy),
    parent: { type: 'database_id', database_id: parentDatabaseId },
    database_parent: notionDatabaseParent(parentDatabase ?? page),
    ...legacyArchivedField(request, inTrash),
    in_trash: inTrash,
    is_inline: notionCompatInline(page, notionCompatInline(parentDatabase ?? page, false)),
    ...(notionCompatDatabaseType(page) ? { database_type: notionCompatDatabaseType(page) } : {}),
    properties: await notionPropertySchemaMap(db, props),
    icon: notionIcon(page),
    cover: notionCover(page),
    url: pageUrl(page, request),
    public_url: page.isPublic ? pageUrl(page, request) : null,
  };
}

async function databaseProperties(db: DbRef, databaseId: string) {
  return listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId));
}

function propByNameOrId(props: DbProperty[], nameOrId: string) {
  return props.find((prop) => prop.id === nameOrId || prop.name === nameOrId);
}

function validatePagePropertyRichText(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} must be an array with at most 100 rich text items.`);
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object.`);
    assertOnlyKeys(
      item,
      ['type', 'text', 'mention', 'equation', 'annotations', 'plain_text', 'href'],
      `${label}[${index}]`,
    );
    if (item.plain_text !== undefined && typeof item.plain_text !== 'string') {
      throw new Error(`${label}[${index}].plain_text must be a string.`);
    }
    if (item.href !== undefined && item.href !== null && typeof item.href !== 'string') {
      throw new Error(`${label}[${index}].href must be a string or null.`);
    }
    const payloadKeys = ['text', 'mention', 'equation'].filter((key) => item[key] !== undefined);
    if (payloadKeys.length !== 1) {
      throw new Error(`${label}[${index}] must contain exactly one rich text payload.`);
    }
    const type = payloadKeys[0];
    if (item.type !== undefined && item.type !== type) {
      throw new Error(`${label}[${index}].type must be ${type}.`);
    }
    if (type === 'text') {
      if (!isRecord(item.text)) throw new Error(`${label}[${index}].text must be an object.`);
      assertOnlyKeys(item.text, ['content', 'link'], `${label}[${index}].text`);
      if (typeof item.text.content !== 'string') {
        throw new Error(`${label}[${index}].text.content must be a string.`);
      }
      if (item.text.link !== undefined && item.text.link !== null) {
        if (!isRecord(item.text.link)) throw new Error(`${label}[${index}].text.link must be an object or null.`);
        assertOnlyKeys(item.text.link, ['url'], `${label}[${index}].text.link`);
        notionExternalAssetUrl(item.text.link.url, `${label}[${index}].text.link.url`);
      }
    } else if (type === 'equation') {
      if (!isRecord(item.equation)) throw new Error(`${label}[${index}].equation must be an object.`);
      assertOnlyKeys(item.equation, ['expression'], `${label}[${index}].equation`);
      requireString(item.equation.expression, `${label}[${index}].equation.expression`);
    } else if (!isRecord(item.mention)) {
      throw new Error(`${label}[${index}].mention must be an object.`);
    }
    if (item.annotations !== undefined) {
      if (!isRecord(item.annotations)) throw new Error(`${label}[${index}].annotations must be an object.`);
      assertOnlyKeys(
        item.annotations,
        ['bold', 'italic', 'strikethrough', 'underline', 'code', 'color'],
        `${label}[${index}].annotations`,
      );
      for (const field of ['bold', 'italic', 'strikethrough', 'underline', 'code']) {
        if (item.annotations[field] !== undefined && typeof item.annotations[field] !== 'boolean') {
          throw new Error(`${label}[${index}].annotations.${field} must be a boolean.`);
        }
      }
      if (item.annotations.color !== undefined && !notionApiColors.has(String(item.annotations.color))) {
        throw new Error(`${label}[${index}].annotations.color is invalid.`);
      }
    }
  }
}

function validatePagePropertyOption(value: unknown, label: string, nullable = true) {
  if (value === null && nullable) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object${nullable ? ' or null' : ''}.`);
  assertOnlyKeys(value, ['id', 'name'], label);
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  if (!id && !name) throw new Error(`${label} must contain id or name.`);
}

function validatePagePropertyDate(value: unknown, label: string) {
  if (value === null) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null.`);
  assertOnlyKeys(value, ['start', 'end', 'time_zone'], label);
  const start = requireString(value.start, `${label}.start`);
  if (Number.isNaN(Date.parse(start))) throw new Error(`${label}.start must be an ISO date or date-time.`);
  for (const field of ['end', 'time_zone']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
      throw new Error(`${label}.${field} must be a string or null.`);
    }
  }
  if (typeof value.end === 'string' && Number.isNaN(Date.parse(value.end))) {
    throw new Error(`${label}.end must be an ISO date or date-time.`);
  }
}

function validatePagePropertyIds(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} must be an array with at most 100 items.`);
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object.`);
    assertOnlyKeys(item, ['id'], `${label}[${index}]`);
    requireString(item.id, `${label}[${index}].id`);
  }
}

function validatePagePropertyFilesShape(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} must be an array with at most 100 items.`);
  }
  for (const [index, file] of value.entries()) {
    if (!isRecord(file)) throw new Error(`${label}[${index}] must be an object.`);
    assertOnlyKeys(file, ['name', 'type', 'external', 'file_upload'], `${label}[${index}]`);
    if (file.name !== undefined) requireString(file.name, `${label}[${index}].name`);
    const hasExternal = file.external !== undefined;
    const hasUpload = file.file_upload !== undefined;
    if (hasExternal === hasUpload) {
      throw new Error(`${label}[${index}] must contain exactly one of external or file_upload.`);
    }
    const inferred = hasUpload ? 'file_upload' : 'external';
    if (file.type !== undefined && file.type !== inferred) {
      throw new Error(`${label}[${index}].type must be ${inferred}.`);
    }
    const payload = file[inferred];
    if (!isRecord(payload)) throw new Error(`${label}[${index}].${inferred} must be an object.`);
    assertOnlyKeys(payload, [inferred === 'external' ? 'url' : 'id'], `${label}[${index}].${inferred}`);
    if (inferred === 'external') notionExternalAssetUrl(payload.url, `${label}[${index}].external.url`);
    else requireString(payload.id, `${label}[${index}].file_upload.id`);
  }
}

async function localPropertyPatchFromNotion(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  props: DbProperty[],
  properties: unknown,
) {
  const out: {
    title?: string;
    properties: Record<string, unknown>;
    richTextMetadata: Record<string, RichTextSpan[]>;
  } = { properties: {}, richTextMetadata: {} };
  if (properties === undefined) return out;
  if (!isRecord(properties)) throw new Error('properties must be an object.');
  const entries = Object.entries(properties);
  if (entries.length > 100) throw new Error('properties may contain at most 100 values.');

  // Validate the complete property patch before adding select options or
  // consuming uploads, so a later malformed property cannot leave partial
  // schema/file side effects behind.
  for (const [key, value] of entries) {
    const prop = propByNameOrId(props, key);
    if (!prop) throw new Error(`Unknown database property: ${key}.`);
    if (!isRecord(value)) throw new Error(`Property ${key} must be an object.`);
    const officialType = propertyNotionType(prop.type);
    assertOnlyKeys(value, ['type', officialType], `Property ${key}`);
    if (value.type !== undefined) {
      if (typeof value.type !== 'string' || propertyLocalType(value.type) !== prop.type) {
        throw new Error(`Property ${key}.type must be ${officialType}.`);
      }
    }
    if (!(officialType in value)) throw new Error(`Property ${key}.${officialType} is required.`);
    const rawValue = value[officialType];
    if (prop.type !== 'title' && isReadOnlyDatabasePropertyType(prop.type)) {
      throw new Error(`Cannot write read-only database property type: ${prop.type}.`);
    }
    if (prop.type === 'title') {
      validatePagePropertyRichText(rawValue, `Property ${key}.title`);
    } else if (prop.type === 'rich_text') {
      validatePagePropertyRichText(rawValue, `Property ${key}.rich_text`);
    } else if (prop.type === 'number') {
      if (rawValue !== null && (typeof rawValue !== 'number' || !Number.isFinite(rawValue))) {
        throw new Error(`Property ${key}.number must be a finite number or null.`);
      }
    } else if (prop.type === 'select' || prop.type === 'status') {
      validatePagePropertyOption(rawValue, `Property ${key}.${officialType}`);
    } else if (prop.type === 'multi_select') {
      if (!Array.isArray(rawValue) || rawValue.length > 100) {
        throw new Error(`Property ${key}.multi_select must be an array with at most 100 items.`);
      }
      rawValue.forEach((item, index) => validatePagePropertyOption(
        item,
        `Property ${key}.multi_select[${index}]`,
        false,
      ));
    } else if (prop.type === 'date') {
      validatePagePropertyDate(rawValue, `Property ${key}.date`);
    } else if (prop.type === 'checkbox') {
      if (typeof rawValue !== 'boolean') throw new Error(`Property ${key}.checkbox must be a boolean.`);
    } else if (prop.type === 'url' || prop.type === 'email' || prop.type === 'phone') {
      if (rawValue !== null && typeof rawValue !== 'string') {
        throw new Error(`Property ${key}.${officialType} must be a string or null.`);
      }
    } else if (prop.type === 'relation' || prop.type === 'person') {
      validatePagePropertyIds(rawValue, `Property ${key}.${officialType}`);
    } else if (prop.type === 'files') {
      // Validate shape without resolving uploads; the conversion pass below
      // performs authorization only after every property shape is known-good.
      validatePagePropertyFilesShape(rawValue, `Property ${key}.files`);
    } else if (prop.type === 'place' || prop.type === 'verification') {
      normalizeDatabasePropertyWriteValue(prop.type, rawValue);
    }
  }

  for (const [key, value] of entries) {
    const prop = propByNameOrId(props, key)!;
    const officialType = propertyNotionType(prop.type);
    const rawValue = (value as Record<string, unknown>)[officialType];
    if (prop.type === 'title') {
      // title is read-only to the generic canonical property normalizer but is
      // writable through the row title field in this compatibility adapter.
      validatePagePropertyRichText(rawValue, `Property ${key}.title`);
      out.title = richTextToPlainText(rawValue);
      out.richTextMetadata[prop.id] = notionRichTextToSpans(rawValue);
    } else if (prop.type === 'rich_text') {
      out.properties[prop.id] = richTextToPlainText(rawValue);
      out.richTextMetadata[prop.id] = notionRichTextToSpans(rawValue);
    } else if (prop.type === 'number') {
      out.properties[prop.id] = rawValue;
    } else if (prop.type === 'select' || prop.type === 'status') {
      out.properties[prop.id] = rawValue ? await ensureOptionValue(db, prop, rawValue) : null;
    } else if (prop.type === 'multi_select') {
      const items = rawValue as unknown[];
      out.properties[prop.id] = (
        await Promise.all(items.map((item, index) => ensureOptionValue(db, prop, item, index)))
      ).filter(Boolean);
    } else if (prop.type === 'date') {
      out.properties[prop.id] = localDateFromNotion(rawValue);
    } else if (prop.type === 'checkbox') {
      out.properties[prop.id] = rawValue;
    } else if (prop.type === 'url') {
      out.properties[prop.id] = rawValue;
    } else if (prop.type === 'email') {
      out.properties[prop.id] = rawValue;
    } else if (prop.type === 'phone') {
      out.properties[prop.id] = rawValue;
    } else if (prop.type === 'relation') {
      out.properties[prop.id] = normalizeIdArray(rawValue);
    } else if (prop.type === 'person') {
      out.properties[prop.id] = normalizeIdArray(rawValue);
    } else if (prop.type === 'files') {
      out.properties[prop.id] = await localFileFromNotion(context, db, workspaceId, rawValue);
    } else if (prop.type === 'place' || prop.type === 'verification') {
      out.properties[prop.id] = normalizeDatabasePropertyWriteValue(prop.type, rawValue);
    }
  }
  return out;
}

function titleFromNotionProperties(properties: unknown) {
  if (!isRecord(properties)) return '';
  for (const value of Object.values(properties)) {
    if (isRecord(value) && (value.type === 'title' || Array.isArray(value.title))) {
      const title = richTextToPlainText(value.title);
      if (title.trim()) return title;
    }
  }
  return '';
}

const NOTION_NATIVE_ICON_COLORS = new Set([
  'gray', 'lightgray', 'brown', 'yellow', 'orange', 'green', 'blue', 'purple', 'pink', 'red',
]);

function notionExternalAssetUrl(value: unknown, label: string) {
  const url = requireString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must be a valid HTTPS URL.`);
  return url;
}

async function consumableNotionFileUpload(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  value: unknown,
  label: string,
  imageOnly = false,
) {
  if (!context.auth?.id) throw new Error('Authentication required.');
  if (!isRecord(value)) throw new Error(`${label}.file_upload must be an object.`);
  assertOnlyKeys(value, ['id'], `${label}.file_upload`);
  const id = requireString(value.id, `${label}.file_upload.id`);
  const upload = await getExisting(db.table<FileUpload>('file_uploads'), id);
  if (
    !upload
    || upload.workspaceId !== workspaceId
    || (upload.createdBy && upload.createdBy !== context.auth.id)
  ) {
    throw new Error('File upload was not found.');
  }
  await requireFileUploadAccess(
    db,
    upload,
    context.auth.id,
    'edit',
    context.auth.email,
    context.compatBearer,
  );
  if (upload.status !== 'uploaded') throw new Error('File upload must have status uploaded.');
  if (imageOnly && upload.contentType && !upload.contentType.toLowerCase().startsWith('image/')) {
    throw new Error('Page icons and covers require an image file upload.');
  }
  return upload;
}

async function freshNotionUploadedFile(
  context: FunctionContext,
  upload: FileUpload,
) {
  let rawUrl: string;
  let expiryTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  if (upload.etag) {
    const signed = await callProductMutation(fileMutationPOST as FunctionDefinition, context, {
      action: 'signedUrl',
      workspaceId: upload.workspaceId,
      uploadId: upload.id,
      expiresIn: '1h',
    }) as { url?: unknown; expiresAt?: unknown };
    rawUrl = requireString(signed.url, 'Signed uploaded file URL');
    expiryTime = requireString(signed.expiresAt, 'Signed uploaded file expiry time');
  } else {
    rawUrl = requireString(upload.url, 'Uploaded file URL');
  }
  let url: URL;
  try {
    url = new URL(rawUrl, originOf(context.request));
  } catch {
    throw new Error('Uploaded file URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Uploaded file URL is invalid.');
  }
  return {
    type: 'file',
    file: {
      url: url.toString(),
      expiry_time: expiryTime,
    },
  };
}

async function notionUploadedImage(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  value: unknown,
  label: string,
) {
  const upload = await consumableNotionFileUpload(context, db, workspaceId, value, label, true);
  return {
    ...await freshNotionUploadedFile(context, upload),
    // Keep the durable upload identity for cleanup/reference scans, but strip
    // it from official responses in notionIcon/notionCover.
    fileUploadId: upload.id,
  };
}

async function notionIconToLocal(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  value: unknown,
): Promise<Pick<Page, 'icon' | 'iconType' | 'notionIcon'>> {
  if (value === null) return { icon: '', iconType: 'none', notionIcon: null };
  if (!isRecord(value)) throw new Error('icon must be null or an object.');
  const type = requireString(value.type, 'icon.type');
  if (type === 'emoji') {
    const emoji = requireString(value.emoji, 'icon.emoji');
    return { icon: emoji, iconType: 'emoji', notionIcon: null };
  }
  if (type === 'external') {
    if (!isRecord(value.external)) throw new Error('icon.external must be an object.');
    const url = notionExternalAssetUrl(value.external.url, 'icon.external.url');
    return { icon: url, iconType: 'image', notionIcon: null };
  }
  if (type === 'file_upload') {
    return {
      icon: '',
      iconType: 'none',
      notionIcon: await notionUploadedImage(context, db, workspaceId, value.file_upload, 'icon'),
    };
  }
  if (type === 'custom_emoji') {
    if (!isRecord(value.custom_emoji)) throw new Error('icon.custom_emoji must be an object.');
    const custom: Record<string, unknown> = {
      id: requireString(value.custom_emoji.id, 'icon.custom_emoji.id'),
    };
    if (value.custom_emoji.name !== undefined) {
      custom.name = requireString(value.custom_emoji.name, 'icon.custom_emoji.name');
    }
    if (value.custom_emoji.url !== undefined) {
      custom.url = notionExternalAssetUrl(value.custom_emoji.url, 'icon.custom_emoji.url');
    }
    return { icon: '', iconType: 'none', notionIcon: { type: 'custom_emoji', custom_emoji: custom } };
  }
  if (type === 'icon') {
    if (!isRecord(value.icon)) throw new Error('icon.icon must be an object.');
    const rawName = requireString(value.icon.name, 'icon.icon.name');
    const name = rawName.toLowerCase().replace(/[\s-]+/g, '_');
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('icon.icon.name is invalid.');
    const color = value.icon.color === undefined ? 'gray' : requireString(value.icon.color, 'icon.icon.color');
    if (!NOTION_NATIVE_ICON_COLORS.has(color)) throw new Error(`Unsupported native icon color: ${color}.`);
    return { icon: '', iconType: 'none', notionIcon: { type: 'icon', icon: { name, color } } };
  }
  throw new Error('icon.type must be emoji, external, file_upload, custom_emoji, or icon.');
}

async function notionCoverToLocal(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  value: unknown,
): Promise<Pick<Page, 'cover' | 'notionCover'>> {
  if (value === null) return { cover: '', notionCover: null };
  if (!isRecord(value)) throw new Error('cover must be null or an object.');
  const type = requireString(value.type, 'cover.type');
  if (type === 'external') {
    if (!isRecord(value.external)) throw new Error('cover.external must be an object.');
    return {
      cover: notionExternalAssetUrl(value.external.url, 'cover.external.url'),
      notionCover: null,
    };
  }
  if (type === 'file_upload') {
    return {
      cover: '',
      notionCover: await notionUploadedImage(context, db, workspaceId, value.file_upload, 'cover'),
    };
  }
  throw new Error('cover.type must be external or file_upload.');
}

async function positionForChild(db: DbRef, workspaceId: string, parentId: string | null, parentType: PageParentType) {
  const siblings = (await listAll(db.table<Page>('pages').where('workspaceId', '==', workspaceId)))
    .filter((page) => (page.parentId ?? null) === parentId && (page.parentType ?? 'workspace') === parentType)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return (siblings.at(-1)?.position ?? 0) + 1;
}

async function notionCreatePagePosition(
  db: DbRef,
  workspaceId: string,
  parentId: string | null,
  parentType: PageParentType,
  input: unknown,
) {
  if (input === undefined) return positionForChild(db, workspaceId, parentId, parentType);
  if (!isRecord(input)) throw new Error('position must be an object.');
  const type = requireString(input.type, 'position.type');
  const siblings = (await listAll(db.table<Page>('pages').where('workspaceId', '==', workspaceId)))
    .filter((page) => (page.parentId ?? null) === parentId && (page.parentType ?? 'workspace') === parentType)
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  if (type === 'page_start') return (siblings[0]?.position ?? 0) - 1;
  if (type === 'page_end') return (siblings.at(-1)?.position ?? 0) + 1;
  if (type !== 'after_block') {
    throw new Error('position.type must be after_block, page_start, or page_end.');
  }
  if (!isRecord(input.after_block)) throw new Error('position.after_block is required.');
  const afterId = requireString(input.after_block.id, 'position.after_block.id');
  const targetIndex = siblings.findIndex((sibling) => sibling.id === afterId);
  if (targetIndex < 0) throw new Error('position.after_block.id must identify a sibling page.');
  const targetPosition = siblings[targetIndex].position ?? 0;
  const nextPosition = siblings[targetIndex + 1]?.position;
  return typeof nextPosition === 'number' && nextPosition > targetPosition
    ? targetPosition + (nextPosition - targetPosition) / 2
    : targetPosition + 1;
}

async function resolveCreateParent(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  bearer?: NotionCompatBearerIdentity | null,
) {
  const parent = isRecord(body.parent) ? body.parent : {};
  const workspaceIdInput = optionalString(body.workspace_id) || optionalString(parent.workspace_id) || optionalString(parent.teamspace_id);
  const pageId = optionalString(parent.page_id);
  const dataSourceId = optionalString(parent.data_source_id) || optionalString(parent.database_id);
  const workspaceParent = parent.workspace !== undefined;
  if (workspaceParent && parent.workspace !== true) throw new Error('parent.workspace must be true.');
  if ([!!pageId, !!dataSourceId, workspaceParent].filter(Boolean).length > 1) {
    throw new Error('parent must identify exactly one page, data source, database, or workspace.');
  }
  const declaredType = optionalString(parent.type);
  const expectedType = pageId
    ? 'page_id'
    : optionalString(parent.data_source_id)
      ? 'data_source_id'
      : optionalString(parent.database_id)
        ? 'database_id'
        : workspaceParent
          ? 'workspace'
          : undefined;
  if (declaredType && expectedType && declaredType !== expectedType) {
    throw new Error(`parent.type must be ${expectedType}.`);
  }
  if (pageId) {
    const parentPage = await requireWritablePage(db, pageId, actorId, actorEmail, bearer);
    if ((parentPage.kind ?? 'page') !== 'page') throw new Error('Parent page is not a page.');
    return {
      workspaceId: parentPage.workspaceId,
      parentId: parentPage.id,
      parentType: 'page' as PageParentType,
    };
  }
  if (dataSourceId) {
    const database = await requireWritablePage(db, dataSourceId, actorId, actorEmail, bearer);
    if (database.kind !== 'database') throw new Error('Parent database was not found.');
    return {
      workspaceId: database.workspaceId,
      parentId: database.id,
      parentType: 'database' as PageParentType,
    };
  }
  if (!workspaceIdInput) throw new Error('workspace_id is required for workspace parent pages.');
  await requireWorkspaceRole(db, workspaceIdInput, actorId, 'edit');
  return {
    workspaceId: workspaceIdInput,
    parentId: null,
    parentType: 'workspace' as PageParentType,
  };
}

async function resolveDatabaseParent(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  bearer?: NotionCompatBearerIdentity | null,
) {
  const parent = isRecord(body.parent) ? body.parent : {};
  const workspaceIdInput = optionalString(body.workspace_id) || optionalString(parent.workspace_id) || optionalString(parent.teamspace_id);
  const pageId = optionalString(parent.page_id);
  const workspaceParent = parent.workspace !== undefined;
  if (workspaceParent && parent.workspace !== true) throw new Error('parent.workspace must be true.');
  if (pageId && workspaceParent) throw new Error('parent must identify exactly one page or workspace.');
  const declaredType = optionalString(parent.type);
  const expectedType = pageId ? 'page_id' : workspaceParent ? 'workspace' : undefined;
  if (declaredType && expectedType && declaredType !== expectedType) {
    throw new Error(`parent.type must be ${expectedType}.`);
  }
  if (pageId) {
    const parentPage = await requireWritablePage(db, pageId, actorId, actorEmail, bearer);
    if ((parentPage.kind ?? 'page') !== 'page') throw new Error('Parent page is not a page.');
    return {
      workspaceId: parentPage.workspaceId,
      parentId: parentPage.id,
      parentType: 'page' as PageParentType,
    };
  }
  if (!workspaceIdInput) throw new Error('workspace_id is required for workspace database parents.');
  await requireWorkspaceRole(db, workspaceIdInput, actorId, 'edit');
  return {
    workspaceId: workspaceIdInput,
    parentId: null,
    parentType: 'workspace' as PageParentType,
  };
}

const notionCreatePropertyTypes = new Set([
  'number', 'formula', 'select', 'multi_select', 'status', 'relation', 'rollup', 'unique_id',
  'title', 'rich_text', 'url', 'people', 'files', 'email', 'phone_number', 'date', 'checkbox',
  'created_by', 'created_time', 'last_edited_by', 'last_edited_time', 'button', 'location',
  'verification', 'last_visited_time', 'place',
]);

const notionUpdatePropertyTypes = new Set([
  'number', 'formula', 'select', 'multi_select', 'status', 'relation', 'rollup', 'unique_id',
  'title', 'rich_text', 'url', 'people', 'files', 'email', 'phone_number', 'date', 'checkbox',
  'created_by', 'created_time', 'last_edited_by', 'last_edited_time', 'place',
]);

const notionEmptyPropertyConfigTypes = new Set([
  'title', 'rich_text', 'url', 'people', 'files', 'email', 'phone_number', 'date', 'checkbox',
  'created_by', 'created_time', 'last_edited_by', 'last_edited_time', 'button', 'location',
  'verification', 'last_visited_time', 'place',
]);

interface NotionPropertySchemaOptions {
  mode: 'create' | 'update';
  existing?: DbProperty;
  legacy?: boolean;
}

function notionPropertyDescription(
  input: Record<string, unknown>,
  existing: DbProperty | undefined,
) {
  if (!('description' in input)) return existing?.description;
  const value = input.description;
  if (value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 280) {
    throw new Error('Property description must be null or a string between 1 and 280 characters.');
  }
  return value;
}

function notionPropertyName(input: Record<string, unknown>, fallback: string, mode: 'create' | 'update') {
  if (!('name' in input)) return fallback;
  if (mode === 'create') throw new Error('Property name must be provided as the properties object key.');
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new Error('Property name must be a non-empty string.');
  }
  return input.name.trim();
}

function notionStringField(
  input: Record<string, unknown>,
  key: string,
  field: string,
  required = false,
) {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function notionNullableStringField(input: Record<string, unknown>, key: string, field: string) {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${field} must be a string or null.`);
  }
  return value as string | null;
}

function defaultStatusOptions(): SelectOption[] {
  return [
    { id: newId(), name: 'Not started', color: 'gray', description: null, group: 'To-do' },
    { id: newId(), name: 'In progress', color: 'blue', description: null, group: 'In progress' },
    { id: newId(), name: 'Done', color: 'green', description: null, group: 'Complete' },
  ];
}

function normalizedNotionOptions(
  rawType: 'select' | 'multi_select' | 'status',
  typedConfig: Record<string, unknown>,
  propertyId: string,
  mode: 'create' | 'update',
  existing?: DbProperty,
) {
  assertOnlyKeys(typedConfig, ['options'], `${rawType} property configuration`);
  const current = existing ? optionList(existing).map((option) => ({ ...option })) : [];
  if (!('options' in typedConfig)) {
    const options = mode === 'update'
      ? current
      : rawType === 'status'
        ? defaultStatusOptions()
        : [];
    return {
      options,
      ...(rawType === 'status' ? { statusGroups: statusGroupStorage(propertyId, options, existing) } : {}),
    };
  }
  if (!Array.isArray(typedConfig.options) || typedConfig.options.length > 100) {
    throw new Error(`${rawType}.options must be an array with at most 100 options.`);
  }
  const options = mode === 'update' ? current : [];
  for (const [index, value] of typedConfig.options.entries()) {
    if (!isRecord(value)) throw new Error(`${rawType}.options[${index}] must be an object.`);
    const allowed = mode === 'update'
      ? ['id', 'name', 'color', 'description', ...(rawType === 'status' ? ['group'] : [])]
      : ['name', 'color', 'description', ...(rawType === 'status' ? ['group'] : [])];
    assertOnlyKeys(value, allowed, `${rawType}.options[${index}]`);
    const id = mode === 'update'
      ? notionStringField(value, 'id', `${rawType}.options[${index}].id`)
      : undefined;
    const suppliedName = notionStringField(value, 'name', `${rawType}.options[${index}].name`);
    if (mode === 'create' && !suppliedName) {
      throw new Error(`${rawType}.options[${index}].name is required.`);
    }
    if (mode === 'update' && !id && !suppliedName) {
      throw new Error(`${rawType}.options[${index}] requires id or name.`);
    }
    const existingIndex = id
      ? options.findIndex((option) => option.id === id)
      : suppliedName
        ? options.findIndex((option) => option.name === suppliedName)
        : -1;
    if (id && existingIndex < 0) {
      throw new Error(`${rawType}.options[${index}].id does not identify an existing option.`);
    }
    const previous = existingIndex >= 0 ? options[existingIndex] : undefined;
    const color = notionStringField(value, 'color', `${rawType}.options[${index}].color`)
      ?? previous?.color
      ?? optionColors[index % optionColors.length];
    if (!notionSelectColors.has(color)) {
      throw new Error(`${rawType}.options[${index}].color is not a supported Notion color.`);
    }
    const description = notionNullableStringField(
      value,
      'description',
      `${rawType}.options[${index}].description`,
    );
    const group = rawType === 'status'
      ? notionStringField(value, 'group', `${rawType}.options[${index}].group`)
        ?? previous?.group
        ?? 'To-do'
      : undefined;
    if (group && !notionStatusGroupNames.includes(group as NotionStatusGroupName)) {
      throw new Error(`${rawType}.options[${index}].group must be To-do, In progress, or Complete.`);
    }
    const normalized: SelectOption = {
      id: previous?.id || newId(),
      name: suppliedName ?? previous!.name,
      color,
      description: description === undefined ? previous?.description ?? null : description,
      ...(group ? { group } : {}),
    };
    if (existingIndex >= 0) options[existingIndex] = normalized;
    else options.push(normalized);
  }
  if (options.length > 100) throw new Error(`${rawType} properties support at most 100 options.`);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const option of options) {
    if (ids.has(option.id)) throw new Error(`${rawType} option ids must be unique.`);
    if (names.has(option.name)) throw new Error(`${rawType} option names must be unique.`);
    ids.add(option.id);
    names.add(option.name);
  }
  return {
    options,
    ...(rawType === 'status' ? { statusGroups: statusGroupStorage(propertyId, options, existing) } : {}),
  };
}

function statusGroupStorage(propertyId: string, options: SelectOption[], existing?: DbProperty) {
  const stored = existing ? storedStatusGroups(existing) : [];
  return notionStatusGroupNames.map((name) => {
    const prior = stored.find((group) => group.name === name);
    const defaults = notionStatusGroupDefaults[name];
    return {
      id: prior?.id || `${propertyId}:${defaults.suffix}`,
      name,
      color: prior?.color || defaults.color,
      optionIds: options
        .filter((option) => (option.group || (existing ? statusGroupForOption(existing, option) : 'To-do')) === name)
        .map((option) => option.id),
    };
  });
}

function notionPropertySchemaType(
  input: Record<string, unknown>,
  mode: 'create' | 'update',
  legacy = false,
) {
  if ('type' in input && typeof input.type !== 'string') {
    throw new Error('Property type must be a string.');
  }
  const permitted = mode === 'create' ? notionCreatePropertyTypes : notionUpdatePropertyTypes;
  const configuredTypes = Array.from(notionCreatePropertyTypes).filter((type) => type in input);
  const explicitType = typeof input.type === 'string' ? input.type : undefined;
  if (explicitType && !permitted.has(explicitType)) {
    if (!(legacy && notionCreatePropertyTypes.has(explicitType))) {
      throw new Error(`Unsupported ${mode} property type: ${explicitType}.`);
    }
  }
  const rawType = explicitType || (configuredTypes.length === 1 ? configuredTypes[0] : undefined);
  if (!rawType) throw new Error('A property configuration must contain exactly one supported type payload.');
  if (!permitted.has(rawType) && !(legacy && notionCreatePropertyTypes.has(rawType))) {
    throw new Error(`Unsupported ${mode} property type: ${rawType}.`);
  }
  if (configuredTypes.length !== 1 || configuredTypes[0] !== rawType) {
    throw new Error(`Property type ${rawType} must have exactly one matching ${rawType} configuration.`);
  }
  assertOnlyKeys(
    input,
    ['type', 'description', rawType, ...(mode === 'update' ? ['name'] : []), ...(legacy ? ['id'] : [])],
    'property configuration',
  );
  return rawType;
}

function schemaPropertyFromNotion(
  databaseId: string,
  name: string,
  schema: unknown,
  position: number,
  options: NotionPropertySchemaOptions,
): DbProperty {
  if (!isRecord(schema)) throw new Error(`Property ${name} configuration must be an object.`);
  const input = schema;
  const rawType = notionPropertySchemaType(input, options.mode, options.legacy);
  const typedConfig = input[rawType];
  if (!isRecord(typedConfig)) throw new Error(`${rawType} property configuration must be an object.`);
  const type = propertyLocalType(rawType);
  const propertyId = options.existing?.id || (options.legacy ? optionalString(input.id) : undefined) || newId();
  const config: Record<string, unknown> = options.mode === 'update' && options.existing?.type === type
    ? { ...(options.existing.config ?? {}) }
    : {};

  if (rawType === 'select' || rawType === 'multi_select' || rawType === 'status') {
    Object.assign(config, normalizedNotionOptions(rawType, typedConfig, propertyId, options.mode, options.existing));
  } else if (rawType === 'number') {
    assertOnlyKeys(typedConfig, ['format'], 'number property configuration');
    const format = notionStringField(typedConfig, 'format', 'number.format')
      ?? optionalString(options.existing?.config?.numberFormat)
      ?? 'number';
    config.numberFormat = format;
  } else if (rawType === 'relation') {
    assertOnlyKeys(
      typedConfig,
      ['data_source_id', ...(options.legacy ? ['database_id'] : []), 'type', 'single_property', 'dual_property'],
      'relation property configuration',
    );
    const targetId = notionStringField(typedConfig, 'data_source_id', 'relation.data_source_id')
      ?? (options.legacy ? notionStringField(typedConfig, 'database_id', 'relation.database_id') : undefined);
    if (!targetId) throw new Error('relation.data_source_id is required.');
    const variants = ['single_property', 'dual_property'].filter((key) => key in typedConfig);
    if (variants.length !== 1) {
      throw new Error('relation must contain exactly one of single_property or dual_property.');
    }
    const relationType = variants[0];
    if ('type' in typedConfig && typedConfig.type !== relationType) {
      throw new Error(`relation.type must be ${relationType}.`);
    }
    const variantConfig = typedConfig[relationType];
    if (!isRecord(variantConfig)) throw new Error(`relation.${relationType} must be an object.`);
    config.relationDatabaseId = targetId;
    if (relationType === 'single_property') {
      assertOnlyKeys(variantConfig, [], 'relation.single_property');
      delete config.relatedPropertyId;
      delete config.relatedPropertyName;
    } else {
      assertOnlyKeys(
        variantConfig,
        ['synced_property_id', 'synced_property_name'],
        'relation.dual_property',
      );
      const syncedId = notionStringField(
        variantConfig,
        'synced_property_id',
        'relation.dual_property.synced_property_id',
      );
      const syncedName = notionStringField(
        variantConfig,
        'synced_property_name',
        'relation.dual_property.synced_property_name',
      );
      config.relatedPropertyId = syncedId
        ?? optionalString(options.existing?.config?.relatedPropertyId)
        ?? newId();
      const previousName = optionalString(options.existing?.config?.relatedPropertyName);
      if (syncedName ?? previousName) config.relatedPropertyName = syncedName ?? previousName;
    }
  } else if (rawType === 'formula') {
    assertOnlyKeys(typedConfig, ['expression'], 'formula property configuration');
    if ('expression' in typedConfig && typeof typedConfig.expression !== 'string') {
      throw new Error('formula.expression must be a string.');
    }
    config.formula = typeof typedConfig.expression === 'string'
      ? typedConfig.expression
      : optionalString(options.existing?.config?.formula) ?? '';
  } else if (rawType === 'rollup') {
    assertOnlyKeys(
      typedConfig,
      ['relation_property_id', 'relation_property_name', 'rollup_property_id', 'rollup_property_name', 'function'],
      'rollup property configuration',
    );
    const relationId = notionStringField(typedConfig, 'relation_property_id', 'rollup.relation_property_id');
    const relationName = notionStringField(typedConfig, 'relation_property_name', 'rollup.relation_property_name');
    const targetId = notionStringField(typedConfig, 'rollup_property_id', 'rollup.rollup_property_id');
    const targetName = notionStringField(typedConfig, 'rollup_property_name', 'rollup.rollup_property_name');
    if (!!relationId === !!relationName) {
      throw new Error('rollup requires exactly one of relation_property_id or relation_property_name.');
    }
    if (!!targetId === !!targetName) {
      throw new Error('rollup requires exactly one of rollup_property_id or rollup_property_name.');
    }
    const rollupFunction = notionStringField(typedConfig, 'function', 'rollup.function', true)!;
    if (!notionRollupFunctions.has(rollupFunction)) {
      throw new Error(`Unsupported rollup.function: ${rollupFunction}.`);
    }
    delete config.rollupRelationPropertyId;
    delete config.rollupRelationPropertyName;
    delete config.rollupTargetPropertyId;
    delete config.rollupTargetPropertyName;
    if (relationId) config.rollupRelationPropertyId = relationId;
    if (relationName) config.rollupRelationPropertyName = relationName;
    if (targetId) config.rollupTargetPropertyId = targetId;
    if (targetName) config.rollupTargetPropertyName = targetName;
    config.rollupFunction = rollupFunction;
  } else if (rawType === 'unique_id') {
    assertOnlyKeys(typedConfig, ['prefix'], 'unique_id property configuration');
    const prefix = notionNullableStringField(typedConfig, 'prefix', 'unique_id.prefix');
    config.idPrefix = prefix === null ? '' : prefix ?? optionalString(options.existing?.config?.idPrefix) ?? '';
  } else if (notionEmptyPropertyConfigTypes.has(rawType)) {
    assertOnlyKeys(typedConfig, [], `${rawType} property configuration`);
  }

  return {
    id: propertyId,
    databaseId,
    name: notionPropertyName(input, options.existing?.name || name, options.mode),
    type,
    description: notionPropertyDescription(input, options.existing),
    config: Object.keys(config).length ? config : undefined,
    position,
  };
}

function notionRelationReciprocalName(schema: unknown) {
  if (!isRecord(schema)) return undefined;
  const rawType = typeof schema.type === 'string'
    ? schema.type
    : Object.keys(schema).find((key) => !['id', 'name', 'description'].includes(key));
  if (rawType !== 'relation' || !isRecord(schema.relation)) return undefined;
  const dual = isRecord(schema.relation.dual_property) ? schema.relation.dual_property : null;
  return optionalString(dual?.synced_property_name);
}

async function resolveNotionRollupSchemaReferences(
  db: DbRef,
  databaseId: string,
  properties: DbProperty[],
  strict = true,
) {
  const propertyCache = new Map<string, Promise<DbProperty[]>>();
  const propertiesForDatabase = (targetDatabaseId: string) => {
    if (targetDatabaseId === databaseId) return Promise.resolve(properties);
    let pending = propertyCache.get(targetDatabaseId);
    if (!pending) {
      pending = databaseProperties(db, targetDatabaseId);
      propertyCache.set(targetDatabaseId, pending);
    }
    return pending;
  };
  for (const property of properties) {
    if (property.type !== 'rollup') continue;
    const config = property.config ?? {};
    const relationId = optionalString(config.rollupRelationPropertyId);
    const relationName = optionalString(config.rollupRelationPropertyName);
    const relation = (relationId
      ? properties.find((candidate) => candidate.id === relationId)
      : undefined)
      ?? (relationName
        ? properties.find((candidate) => candidate.name === relationName)
        : undefined);
    if (!relation || relation.type !== 'relation') {
      if (strict) {
        throw new Error(`Rollup ${property.name} must reference a relation property in the same data source.`);
      }
      continue;
    }
    const targetDatabaseId = optionalString(relation.config?.relationDatabaseId) || databaseId;
    const targetProperties = await propertiesForDatabase(targetDatabaseId);
    const targetId = optionalString(config.rollupTargetPropertyId);
    const targetName = optionalString(config.rollupTargetPropertyName);
    const target = (targetId
      ? targetProperties.find((candidate) => candidate.id === targetId)
      : undefined)
      ?? (targetName
        ? targetProperties.find((candidate) => candidate.name === targetName)
        : undefined);
    if (!target) {
      if (strict) {
        throw new Error(`Rollup ${property.name} must reference a property in relation target ${targetDatabaseId}.`);
      }
      continue;
    }
    property.config = {
      ...config,
      rollupRelationPropertyId: relation.id,
      rollupRelationPropertyName: relation.name,
      rollupTargetPropertyId: target.id,
      rollupTargetPropertyName: target.name,
    };
  }
  return properties;
}

async function schemaFromNotionProperties(
  databaseId: string,
  properties: unknown,
  db: DbRef,
  options: Pick<NotionPropertySchemaOptions, 'legacy'> = {},
) {
  const out: DbProperty[] = [];
  if (properties !== undefined && !isRecord(properties)) {
    throw new Error('properties must be an object.');
  }
  if (isRecord(properties)) {
    const entries = Object.entries(properties);
    if (entries.length > 100) throw new Error('A data source can contain at most 100 properties.');
    for (const [index, [name, schema]] of entries.entries()) {
      if (!name.trim()) throw new Error('Property names must be non-empty.');
      out.push(schemaPropertyFromNotion(databaseId, name, schema, index + 1, {
        mode: 'create',
        legacy: options.legacy,
      }));
    }
  }
  if (out.filter((prop) => prop.type === 'title').length > 1) {
    throw new Error('A data source can contain only one title property.');
  }
  if (!out.some((prop) => prop.type === 'title')) {
    out.unshift({ id: newId(), databaseId, name: 'Name', type: 'title', position: 1 });
    out.forEach((prop, index) => {
      prop.position = index + 1;
    });
  }
  return resolveNotionRollupSchemaReferences(db, databaseId, out);
}

function starterView(databaseId: string): DbView {
  return {
    id: newId(),
    databaseId,
    name: 'Table',
    type: 'table',
    position: 1,
    config: {},
  };
}

function transactUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('transact is not a function') || message.includes('transact is not supported');
}

async function deletePrimaryContentRecord<T>(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  tableName: string,
  id: string,
) {
  try {
    await db.table<T>(tableName).delete(id);
  } catch (error) {
    // Older embedded/test runtimes can expose the routed facade without a
    // transact-capable content DB. Production uses the first path; this narrow
    // fallback still performs the authoritative delete and never reports a
    // best-effort success for a failed primary mutation.
    if (!transactUnavailable(error)) throw error;
    await context.admin.db('workspace', workspaceId).table<T>(tableName).delete(id);
  }
}

async function insertDatabaseBundle(
  db: DbRef,
  database: Page,
  properties: DbProperty[],
  view: DbView,
): Promise<Page> {
  if (typeof db.transact === 'function') {
    try {
      const operations: TransactOperation[] = [
        { table: 'pages', op: 'insert', data: database as unknown as Record<string, unknown> },
        ...properties.map((property): TransactOperation => ({
          table: 'db_properties',
          op: 'insert',
          data: property as unknown as Record<string, unknown>,
        })),
        { table: 'db_views', op: 'insert', data: view as unknown as Record<string, unknown> },
      ];
      await db.transact(operations);
      return database;
    } catch (error) {
      if (!transactUnavailable(error)) throw error;
    }
  }

  const pages = db.table<Page>('pages');
  const props = db.table<DbProperty>('db_properties');
  const views = db.table<DbView>('db_views');
  let insertedPage: Page | null = null;
  const insertedPropertyIds: string[] = [];
  let insertedViewId: string | null = null;
  try {
    insertedPage = await pages.insert(database);
    for (const property of properties) {
      const inserted = await props.insert(property);
      insertedPropertyIds.push(inserted.id);
    }
    insertedViewId = (await views.insert(view)).id;
    return insertedPage;
  } catch (error) {
    if (insertedViewId) await views.delete(insertedViewId).catch(() => {});
    for (const id of insertedPropertyIds.slice().reverse()) await props.delete(id).catch(() => {});
    if (insertedPage) await pages.delete(insertedPage.id).catch(() => {});
    throw error;
  }
}

const NOTION_COMPAT_MAX_CHILDREN_PER_ARRAY = 100;
const NOTION_COMPAT_MAX_BLOCKS_PER_REQUEST = 1_000;
const NOTION_COMPAT_MAX_BLOCK_DEPTH = 100;
// createMany needs one page expectation, one external-parent expectation, and
// an expect+insert pair for every materialized/requested row.
const NOTION_COMPAT_SIMPLE_TABLE_MATERIALIZATION_LIMIT = Math.floor(
  (MAX_RAW_TRANSACT_OPS - 2) / 2,
);

async function prepareBlocksUnder(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  pageId: string,
  parentId: string | null,
  children: unknown,
  actorId: string,
  startPosition?: number,
): Promise<Block[]> {
  if (!Array.isArray(children) || children.length === 0) return [];
  const existing = await listAll(db.table<Block>('blocks').where('pageId', '==', pageId));
  const reservedIds = new Set(existing.map((block) => block.id));
  const position =
    startPosition ??
    existing
      .filter((block) => (block.parentId ?? null) === parentId)
      .reduce((max, block) => Math.max(max, block.position ?? 0), 0);
  const prepared: Block[] = [];
  const visit = async (
    rawChildren: unknown[],
    currentParentId: string | null,
    start: number,
    depth: number,
  ) => {
    if (rawChildren.length > NOTION_COMPAT_MAX_CHILDREN_PER_ARRAY) {
      throw new Error(
        `children must contain at most ${NOTION_COMPAT_MAX_CHILDREN_PER_ARRAY} blocks per level.`,
      );
    }
    if (depth > NOTION_COMPAT_MAX_BLOCK_DEPTH) {
      throw new Error(`children must be at most ${NOTION_COMPAT_MAX_BLOCK_DEPTH} levels deep.`);
    }
    let nextPosition = start;
    for (const rawChild of rawChildren) {
      if (prepared.length >= NOTION_COMPAT_MAX_BLOCKS_PER_REQUEST) {
        throw new Error(
          `children must contain at most ${NOTION_COMPAT_MAX_BLOCKS_PER_REQUEST} blocks in one request.`,
        );
      }
      const blockInput = isRecord(rawChild) ? rawChild : {};
      const block = await localBlockFromNotion(
        context,
        db,
        workspaceId,
        blockInput,
        pageId,
        currentParentId,
        actorId,
        nextPosition + 1,
      );
      if (reservedIds.has(block.id)) throw new Error(`Block id "${block.id}" is duplicated or already exists.`);
      reservedIds.add(block.id);
      nextPosition = block.position ?? nextPosition + 1;
      prepared.push(block);
      const notionType = notionInputBlockType(blockInput);
      const typeContent = contentForType(blockInput, notionType);
      if (Array.isArray(typeContent.children) && typeContent.children.length > 0) {
        await visit(typeContent.children, block.id, 0, depth + 1);
      }
    }
  };
  await visit(children, parentId, position, 1);
  return prepared;
}

async function insertPreparedBlocks(db: DbRef, prepared: Block[]): Promise<Block[]> {
  if (prepared.length === 0) return [];
  if (typeof db.transact === 'function') {
    try {
      await db.transact(prepared.map((block): TransactOperation => ({
        table: 'blocks',
        op: 'insert',
        data: block as unknown as Record<string, unknown>,
      })));
      return prepared;
    } catch (error) {
      if (!transactUnavailable(error)) throw error;
    }
  }
  const table = db.table<Block>('blocks');
  const inserted: Block[] = [];
  try {
    for (const block of prepared) inserted.push(await table.insert(block));
    return inserted;
  } catch (error) {
    for (const block of inserted.slice().reverse()) {
      await table.delete(block.id).catch(() => {});
    }
    throw error;
  }
}

async function createBlocksUnder(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  pageId: string,
  parentId: string | null,
  children: unknown,
  actorId: string,
  startPosition?: number,
) {
  const prepared = await prepareBlocksUnder(
    context,
    db,
    workspaceId,
    pageId,
    parentId,
    children,
    actorId,
    startPosition,
  );
  return insertPreparedBlocks(db, prepared);
}

async function erasePageContent(context: FunctionContext, db: DbRef, page: Page) {
  const blocks = db.table<Block>('blocks');
  const pageBlocks = await listAll(blocks.where('pageId', '==', page.id));
  for (const block of pageBlocks) {
    await deletePrimaryContentRecord<Block>(context, db, page.workspaceId, 'blocks', block.id);
  }
}

function plainTextFromSpans(value: unknown) {
  return Array.isArray(value)
    ? value.map((span) => (isRecord(span) && typeof span.text === 'string' ? span.text : '')).join('')
    : '';
}

async function createTemplateBlocksUnder(
  db: DbRef,
  pageId: string,
  parentId: string | null,
  children: unknown,
  actorId: string,
  startPosition = 0,
) {
  if (!Array.isArray(children) || children.length === 0) return [];
  const blocks = db.table<Block>('blocks');
  let position = startPosition;
  const created: Block[] = [];
  for (const child of children) {
    if (!isRecord(child)) continue;
    const type = typeof child.type === 'string' && knownBlockTypes.has(child.type) ? child.type : 'paragraph';
    const content = isRecord(child.content) ? child.content : undefined;
    const block = await blocks.insert({
      id: optionalString(child.id) || newId(),
      pageId,
      parentId,
      type,
      content,
      plainText: typeof child.plainText === 'string' ? child.plainText : plainTextFromSpans(content?.rich),
      position: position + 1,
      createdBy: actorId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    created.push(block);
    position = block.position ?? position + 1;
    await createTemplateBlocksUnder(db, pageId, block.id, child.children, actorId);
  }
  return created;
}

async function resolvePageTemplate(
  db: DbRef,
  page: Page,
  templateInput: unknown,
) {
  if (!isRecord(templateInput)) throw new Error('template must be an object.');
  if (page.parentType !== 'database' || !page.parentId) {
    throw new Error('Templates can only be applied to pages in a data source.');
  }
  assertOnlyKeys(templateInput, ['type', 'template_id', 'timezone'], 'template');
  const type = requireString(templateInput.type, 'template.type');
  if (type !== 'default' && type !== 'template_id') {
    throw new Error('template.type must be default or template_id.');
  }
  const templateId = type === 'template_id'
    ? requireString(templateInput.template_id, 'template.template_id')
    : undefined;
  if (templateInput.timezone !== undefined) {
    const timezone = requireString(templateInput.timezone, 'template.timezone');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    } catch {
      throw new Error('template.timezone must be a valid IANA timezone.');
    }
  }
  const templates = await listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', page.parentId));
  const template =
    type === 'template_id' && templateId
      ? templates.find((item) => item.id === templateId)
      : templates.find((item) => item.isDefault) ?? templates[0];
  if (!template) throw new Error('Template was not found.');
  return template;
}

function pagePatchFromTemplate(page: Page, template: DbTemplate | null) {
  const patch: Partial<Page> = {};
  if (!template) return patch;
  if (typeof template.title === 'string') patch.title = template.title;
  if (isRecord(template.properties)) {
    patch.properties = { ...(page.properties ?? {}), ...template.properties };
  }
  return patch;
}

async function instantiatePageTemplate(
  db: DbRef,
  page: Page,
  template: DbTemplate,
  actorId: string,
) {
  const existingRoot = await listAll(db.table<Block>('blocks').where('pageId', '==', page.id));
  const start = existingRoot
    .filter((block) => !block.parentId)
    .reduce((max, block) => Math.max(max, block.position ?? 0), 0);
  await createTemplateBlocksUnder(db, page.id, null, template.blocks, actorId, start);
}

async function persistNotionRichTextMetadata(
  db: DbRef,
  page: Page,
  metadata: Record<string, unknown>,
) {
  const entries = Object.entries(metadata).filter(([, value]) => Array.isArray(value));
  if (entries.length === 0) return page;
  const existing = isRecord(page.properties?.[NOTION_RICH_TEXT_METADATA_KEY])
    ? page.properties?.[NOTION_RICH_TEXT_METADATA_KEY] as Record<string, unknown>
    : {};
  const properties = {
    ...(page.properties ?? {}),
    [NOTION_RICH_TEXT_METADATA_KEY]: {
      ...existing,
      ...Object.fromEntries(entries),
    },
  };
  // The canonical row normalizer intentionally ignores private `__*`
  // metadata. Persist this adapter-only sidecar after the canonical mutation;
  // product-visible property values remain the canonical plain values.
  const stored = await db.table<Page>('pages').update(page.id, { properties });
  return { ...page, ...stored, properties };
}

function compatWorkspaceHint(body: Record<string, unknown>) {
  const parent = (body.parent ?? {}) as Record<string, unknown>;
  const hint = body.workspace_id ?? parent.workspace_id ?? parent.teamspace_id;
  return typeof hint === 'string' && hint ? hint : undefined;
}

async function createPageEndpoint(
  context: FunctionContext,
  body: Record<string, unknown>,
  validateOnly = false,
) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const contentKeys = ['content', 'children', 'markdown'].filter(
    (key) => body[key] !== undefined,
  );
  if (contentKeys.length > 1) {
    throw new Error('content, children, and markdown are mutually exclusive.');
  }
  const structuredContent = body.content ?? body.children;
  if (structuredContent !== undefined && !Array.isArray(structuredContent)) {
    throw new Error(`${body.content !== undefined ? 'content' : 'children'} must be an array.`);
  }
  if (Array.isArray(structuredContent) && structuredContent.length > 100) {
    throw new Error('Page content must contain at most 100 blocks.');
  }
  if (body.markdown !== undefined && typeof body.markdown !== 'string') {
    throw new Error('markdown must be a string.');
  }
  if (body.allow_async !== undefined && typeof body.allow_async !== 'boolean') {
    throw new Error('allow_async must be a boolean.');
  }
  if (body.allow_async === true && typeof body.markdown !== 'string') {
    throw new Error('allow_async is only supported when markdown is provided.');
  }
  const templateInput = body.template;
  if (templateInput !== undefined && !isRecord(templateInput)) {
    throw new Error('template must be an object.');
  }
  const template = isRecord(templateInput) ? templateInput : { type: 'none' };
  const templateType = optionalString(template.type) || 'none';
  if (!['none', 'default', 'template_id'].includes(templateType)) {
    throw new Error('template.type must be none, default, or template_id.');
  }
  const templateId = templateType === 'template_id'
    ? requireString(template.template_id, 'template.template_id')
    : undefined;
  if (template.timezone !== undefined) {
    const timezone = requireString(template.timezone, 'template.timezone');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    } catch {
      throw new Error('template.timezone must be a valid IANA timezone.');
    }
  }
  if (templateType !== 'none' && contentKeys.length > 0) {
    throw new Error('Page content cannot be provided when applying a template.');
  }
  const parentHints = body.parent as { page_id?: unknown; database_id?: unknown; data_source_id?: unknown } | undefined;
  const workspaceHint = compatWorkspaceHint(body);
  // Workspace-parent pages carry no page-shaped hint; route via workspace_id.
  const db =
    !parentHints?.page_id && !parentHints?.database_id && !parentHints?.data_source_id && workspaceHint
      ? boundedDbFromWorkspaceHint(context.admin, workspaceHint)
      : await boundedDbFromPageHint(context.admin, parentHints?.page_id, parentHints?.database_id, parentHints?.data_source_id);
  const parent = await resolveCreateParent(db, body, auth.id, auth.email, context.compatBearer);
  const isDatabaseRow = parent.parentType === 'database' && !!parent.parentId;
  const props = isDatabaseRow ? await databaseProperties(db, parent.parentId as string) : [];
  const propertyPatch = isDatabaseRow
    ? await localPropertyPatchFromNotion(context, db, parent.workspaceId, props, body.properties)
    : { title: titleFromNotionProperties(body.properties), properties: {}, richTextMetadata: {} };
  if (!isDatabaseRow && templateType !== 'none') {
    throw new Error('Templates can only be applied to pages created in a data source.');
  }
  const icon = body.icon === undefined
    ? { icon: '', iconType: 'none' as const, notionIcon: null }
    : await notionIconToLocal(context, db, parent.workspaceId, body.icon);
  const cover = body.cover === undefined
    ? { cover: '', notionCover: null }
    : await notionCoverToLocal(context, db, parent.workspaceId, body.cover);
  const pageId = optionalString(body.id) || newId();
  const position = await notionCreatePagePosition(
    db,
    parent.workspaceId,
    parent.parentId,
    parent.parentType,
    body.position,
  );
  const preparedBlocks = await prepareBlocksUnder(
    context,
    db,
    parent.workspaceId,
    pageId,
    null,
    structuredContent,
    auth.id,
  );
  if (validateOnly) return { object: 'validated_page_create' };
  let inserted: Page;
  if (isDatabaseRow) {
    const result = await callProductMutation(databaseRowMutationPOST as FunctionDefinition, context, {
      action: 'create',
      id: pageId,
      workspaceId: parent.workspaceId,
      databaseId: parent.parentId,
      title: propertyPatch.title ?? '',
      icon: icon.icon,
      notionIcon: icon.notionIcon,
      cover: cover.cover,
      notionCover: cover.notionCover,
      properties: propertyPatch.properties,
      position,
      ...(templateId ? { templateId } : {}),
      ...(templateType === 'none' ? { empty: true } : {}),
    });
    inserted = result.row as Page;
  } else {
    const result = await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: 'create',
      id: pageId,
      workspaceId: parent.workspaceId,
      parentId: parent.parentId,
      parentType: parent.parentType,
      kind: 'page',
      title: propertyPatch.title ?? titleFromNotionProperties(body.properties) ?? '',
      icon: icon.icon,
      iconType: icon.iconType,
      notionIcon: icon.notionIcon,
      cover: cover.cover,
      notionCover: cover.notionCover,
      font: 'default',
      smallText: false,
      fullWidth: false,
      properties: propertyPatch.properties,
      position,
    });
    inserted = result.page as Page;
  }
  if (!inserted?.id) throw Object.assign(new Error('Canonical page creation returned no page.'), { status: 500 });
  inserted = await persistNotionRichTextMetadata(db, inserted, propertyPatch.richTextMetadata);
  if (preparedBlocks.length > 0 || typeof body.markdown === 'string') {
    try {
      if (preparedBlocks.length > 0) {
        await callProductMutation(blockMutationPOST as FunctionDefinition, context, {
          action: 'createMany',
          blocks: preparedBlocks,
        });
      } else {
        await callProductMutation(importExportPOST as FunctionDefinition, context, {
          action: 'appendMarkdownToPage',
          pageId: inserted.id,
          workspaceId: inserted.workspaceId,
          markdown: body.markdown,
        });
      }
    } catch (error) {
      // Creation is the only point where compensation is safe: the new page
      // cannot have pre-existing user content. Do not acknowledge a partial
      // page when its requested children failed to commit.
      const rollback = isDatabaseRow ? databaseRowMutationPOST : pageMutationPOST;
      await callProductMutation(rollback as FunctionDefinition, context, {
        action: 'delete', id: inserted.id, workspaceId: inserted.workspaceId,
      }).catch(() => {});
      throw error;
    }
  }
  return notionPage(await pageWithComputedProperties(context, inserted, props), props, request);
}

async function updatePageEndpoint(context: FunctionContext, pageId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, pageId);
  const page = await requireWritablePage(db, pageId, auth.id, auth.email, context.compatBearer);
  const props = page.parentType === 'database' && page.parentId ? await databaseProperties(db, page.parentId) : [];
  assertOnlyKeys(
    body,
    [
      'properties', 'icon', 'cover', 'is_locked', 'erase_content', 'template',
      'in_trash', 'is_archived', 'archived', ...(context.compatBearer ? ['workspace_id'] : []),
    ],
    'page update',
  );

  // Everything below this point is preflight until the canonical page/row
  // mutation. In particular, erase_content and template block insertion must
  // never run before a malformed trailing field has been rejected.
  if (body.erase_content !== undefined && typeof body.erase_content !== 'boolean') {
    throw new Error('erase_content must be a boolean.');
  }
  const template = 'template' in body ? await resolvePageTemplate(db, page, body.template) : null;
  const patch: Partial<Page> = pagePatchFromTemplate(page, template);
  if ('icon' in body) {
    Object.assign(patch, await notionIconToLocal(context, db, page.workspaceId, body.icon));
  }
  if ('cover' in body) {
    Object.assign(patch, await notionCoverToLocal(context, db, page.workspaceId, body.cover));
  }
  if ('is_locked' in body) {
    if (typeof body.is_locked !== 'boolean') throw new Error('is_locked must be a boolean.');
    patch.isLocked = body.is_locked;
  }
  const trashFields = ['in_trash', 'is_archived', 'archived']
    .filter((field) => body[field] !== undefined);
  for (const field of trashFields) {
    if (typeof body[field] !== 'boolean') throw new Error(`${field} must be a boolean.`);
  }
  const trashValues = new Set(trashFields.map((field) => body[field] as boolean));
  if (trashValues.size > 1) throw new Error('Trash/archive fields must not conflict.');
  const trashRequested = trashFields.length > 0 ? body[trashFields[0]] as boolean : undefined;

  if ('properties' in body) {
    const propPatch = page.parentType === 'database'
      ? await localPropertyPatchFromNotion(context, db, page.workspaceId, props, body.properties)
      : { title: titleFromNotionProperties(body.properties), properties: {}, richTextMetadata: {} };
    if (propPatch.title !== undefined) patch.title = propPatch.title;
    if (Object.keys(propPatch.properties).length > 0) {
      patch.properties = { ...(page.properties ?? {}), ...(patch.properties ?? {}), ...propPatch.properties };
    }
    if (Object.keys(propPatch.richTextMetadata).length > 0) {
      const existingMetadata = isRecord(page.properties?.[NOTION_RICH_TEXT_METADATA_KEY])
        ? page.properties?.[NOTION_RICH_TEXT_METADATA_KEY] as Record<string, unknown>
        : {};
      patch.properties = {
        ...(page.properties ?? {}),
        ...(patch.properties ?? {}),
        [NOTION_RICH_TEXT_METADATA_KEY]: { ...existingMetadata, ...propPatch.richTextMetadata },
      };
    }
  }

  const mutation = page.parentType === 'database' ? databaseRowMutationPOST : pageMutationPOST;
  let updated = page;
  if (Object.keys(patch).length > 0) {
    const result = await callProductMutation(mutation as FunctionDefinition, context, {
      action: 'update', id: page.id, workspaceId: page.workspaceId, patch,
    });
    updated = (page.parentType === 'database' ? result.row : result.page) as Page;
    if (page.parentType === 'database' && isRecord(patch.properties?.[NOTION_RICH_TEXT_METADATA_KEY])) {
      updated = await persistNotionRichTextMetadata(
        db,
        updated,
        patch.properties[NOTION_RICH_TEXT_METADATA_KEY] as Record<string, RichTextSpan[]>,
      );
    }
  }
  if (body.erase_content === true) {
    const blocks = await listAll(db.table<Block>('blocks').where('pageId', '==', page.id));
    const rootIds = blocks.filter((block) => !block.parentId).map((block) => block.id);
    if (rootIds.length > 0) {
      await callProductMutation(blockMutationPOST as FunctionDefinition, context, {
        action: 'deleteMany', ids: rootIds,
      });
    }
  }
  if (template) await instantiatePageTemplate(db, updated, template, auth.id);
  if (trashRequested !== undefined && trashRequested !== updated.inTrash) {
    const result = await callProductMutation(mutation as FunctionDefinition, context, {
      action: trashRequested ? 'trash' : 'restore', id: page.id, workspaceId: page.workspaceId,
    });
    const candidate = (page.parentType === 'database' ? result.row : result.page) as Page | undefined;
    updated = candidate?.id
      ? candidate
      : await getExisting(db.table<Page>('pages'), page.id) ?? { ...updated, inTrash: trashRequested };
  }
  return notionPage(await pageWithComputedProperties(context, updated, props), props, request);
}

function notionInputBlockType(input: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(input, 'type') && typeof input.type !== 'string') {
    throw new Error('block.type must be a string.');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'object') && input.object !== 'block') {
    throw new Error('block.object must be block when provided.');
  }
  const explicit = typeof input.type === 'string' ? input.type : undefined;
  if (explicit) {
    if (!officialWritableBlockTypes.has(explicit)) {
      throw new Error(`Unsupported or read-only Notion block type: ${explicit}.`);
    }
    if (!isRecord(input[explicit])) throw new Error(`${explicit} block content is required.`);
    assertOnlyKeys(input, ['type', 'object', explicit], 'block');
    return explicit;
  }
  const inferred = Array.from(officialWritableBlockTypes).filter((type) => isRecord(input[type]));
  if (inferred.length !== 1) {
    throw new Error('A block must contain exactly one supported Notion block payload.');
  }
  assertOnlyKeys(input, ['object', inferred[0]], 'block');
  return inferred[0];
}

function contentForType(input: Record<string, unknown>, type: string) {
  return isRecord(input[type]) ? (input[type] as Record<string, unknown>) : {};
}

function richContentFromNotion(typeContent: Record<string, unknown>) {
  return notionRichTextToSpans(typeContent.rich_text);
}

function validateNotionRichTextArray(value: unknown, field: string, required = false) {
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${field} must be an array with at most 100 rich text items.`);
  }
}

function validateNotionFileReference(value: unknown, field: string, key: 'url' | 'id') {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  assertOnlyKeys(value, [key], field);
  requireString(value[key], `${field}.${key}`);
}

function validateNotionBlockFieldTypes(type: string, payload: Record<string, unknown>) {
  if (payload.color !== undefined && !notionApiColors.has(String(payload.color))) {
    throw new Error(`${type}.color is invalid.`);
  }
  for (const field of ['checked', 'is_toggleable', 'has_column_header', 'has_row_header']) {
    if (payload[field] !== undefined && typeof payload[field] !== 'boolean') {
      throw new Error(`${type}.${field} must be a boolean.`);
    }
  }
  if (payload.name !== undefined && typeof payload.name !== 'string') {
    throw new Error(`${type}.name must be a string.`);
  }
  if (payload.language !== undefined && !optionalString(payload.language)) {
    throw new Error(`${type}.language must be a non-empty string.`);
  }
  if (payload.expression !== undefined && typeof payload.expression !== 'string') {
    throw new Error(`${type}.expression must be a string.`);
  }
  if (payload.children !== undefined && !Array.isArray(payload.children)) {
    throw new Error(`${type}.children must be an array.`);
  }
  validateNotionRichTextArray(payload.caption, `${type}.caption`);
  validateNotionRichTextArray(payload.rich_text, `${type}.rich_text`);
  if (payload.external !== undefined) {
    validateNotionFileReference(payload.external, `${type}.external`, 'url');
  }
  if (payload.file_upload !== undefined) {
    validateNotionFileReference(payload.file_upload, `${type}.file_upload`, 'id');
  }
}

type NotionBlockRequestContext =
  | 'root'
  | 'single_level'
  | 'childless'
  | 'column'
  | 'tab_single_level'
  | 'tab_childless'
  | 'table_row';

// PATCH schemas deliberately omit creation-only container children. The
// stored-update mode is used only after the request delta has passed its exact
// update schema, so it may trust the stored child state without weakening
// create/append validation.
type NotionBlockPayloadValidationMode = 'create' | 'stored_update';

const notionChildlessBlockPayloadKeys: Record<string, readonly string[]> = {
  ...notionBlockPayloadKeys,
  tab: [],
  heading_1: ['rich_text', 'color', 'is_toggleable'],
  heading_2: ['rich_text', 'color', 'is_toggleable'],
  heading_3: ['rich_text', 'color', 'is_toggleable'],
  heading_4: ['rich_text', 'color', 'is_toggleable'],
  paragraph: ['rich_text', 'color', 'icon'],
  bulleted_list_item: ['rich_text', 'color'],
  numbered_list_item: ['rich_text', 'color'],
  quote: ['rich_text', 'color'],
  to_do: ['rich_text', 'color', 'checked'],
  toggle: ['rich_text', 'color'],
  template: ['rich_text'],
  callout: ['rich_text', 'color', 'icon'],
  synced_block: ['synced_from'],
};

const notionSingleLevelBlockTypes = new Set(
  Array.from(officialWritableBlockTypes).filter((type) => type !== 'column_list' && type !== 'column'),
);
const notionChildlessBlockTypes = new Set(
  Array.from(notionSingleLevelBlockTypes).filter((type) => type !== 'table'),
);
const notionBlockTypesByRequestContext: Record<NotionBlockRequestContext, ReadonlySet<string>> = {
  root: officialWritableBlockTypes,
  single_level: notionSingleLevelBlockTypes,
  childless: notionChildlessBlockTypes,
  column: new Set(['column']),
  tab_single_level: new Set(['paragraph']),
  tab_childless: new Set(['paragraph']),
  table_row: new Set(['table_row']),
};
const notionBlockRequestContexts = new WeakMap<Record<string, unknown>, NotionBlockRequestContext>();

function notionBlockPayloadKeysForContext(context: NotionBlockRequestContext, type: string) {
  if (context === 'childless' || context === 'tab_childless') {
    return notionChildlessBlockPayloadKeys[type] ?? [];
  }
  return notionBlockPayloadKeys[type] ?? [];
}

function notionChildBlockContext(
  context: NotionBlockRequestContext,
  type: string,
): NotionBlockRequestContext | null {
  if (type === 'column_list') return context === 'root' ? 'column' : null;
  if (type === 'column') return context === 'root' || context === 'column' ? 'single_level' : null;
  if (type === 'table') return context === 'root' || context === 'single_level' ? 'table_row' : null;
  if (type === 'tab') {
    if (context === 'root') return 'tab_single_level';
    if (context === 'single_level') return 'tab_childless';
    return null;
  }
  if (context === 'root') return 'single_level';
  if (context === 'single_level' || context === 'tab_single_level') return 'childless';
  return null;
}

function validateNotionBlockPayload(
  type: string,
  payload: Record<string, unknown>,
  context: NotionBlockRequestContext = 'root',
  mode: NotionBlockPayloadValidationMode = 'create',
) {
  assertOnlyKeys(payload, notionBlockPayloadKeysForContext(context, type), `${type} block`);
  validateNotionBlockFieldTypes(type, payload);
  if (Array.isArray(payload.children) && payload.children.length > NOTION_COMPAT_MAX_CHILDREN_PER_ARRAY) {
    throw new Error(`children must contain at most ${NOTION_COMPAT_MAX_CHILDREN_PER_ARRAY} blocks per level.`);
  }
  if (textBlockTypes.has(type) || type === 'template') {
    validateNotionRichTextArray(payload.rich_text, `${type}.rich_text`, true);
  }
  if (type === 'code') {
    if (!optionalString(payload.language)) throw new Error('code.language is required.');
    validateNotionRichTextArray(payload.caption, 'code.caption');
  }
  if (type === 'equation' && typeof payload.expression !== 'string') {
    throw new Error('equation.expression is required.');
  }
  if (type === 'bookmark' && !optionalString(payload.url)) {
    throw new Error('bookmark.url is required.');
  }
  if (type === 'embed') {
    const hasUrl = !!optionalString(payload.url);
    const hasUpload = isRecord(payload.file_upload) && !!optionalString(payload.file_upload.id);
    if (hasUrl === hasUpload) throw new Error('embed requires exactly one of url or file_upload.');
    if (payload.type !== undefined && (!hasUpload || payload.type !== 'file_upload')) {
      throw new Error('embed.type must be file_upload when provided.');
    }
  }
  if (['image', 'video', 'pdf', 'file', 'audio'].includes(type)) {
    const hasExternal = isRecord(payload.external) && !!optionalString(payload.external.url);
    const hasUpload = isRecord(payload.file_upload) && !!optionalString(payload.file_upload.id);
    if (hasExternal === hasUpload) {
      throw new Error(`${type} requires exactly one of external or file_upload.`);
    }
    if (payload.type !== undefined && payload.type !== (hasExternal ? 'external' : 'file_upload')) {
      throw new Error(`${type}.type does not match its file source.`);
    }
    validateNotionRichTextArray(payload.caption, `${type}.caption`);
  }
  if (type === 'link_to_page') {
    const targets = ['page_id', 'database_id', 'comment_id'].filter((key) => !!optionalString(payload[key]));
    if (targets.length !== 1) throw new Error('link_to_page requires exactly one target id.');
    if (payload.type !== undefined && payload.type !== targets[0]) {
      throw new Error('link_to_page.type does not match its target id.');
    }
  }
  if (type === 'table') {
    if (!Number.isInteger(payload.table_width) || Number(payload.table_width) < 1) {
      throw new Error('table.table_width must be an integer greater than or equal to 1.');
    }
    const tableChildren = Array.isArray(payload.children) ? payload.children : [];
    if (tableChildren.length > 100) {
      throw new Error('table.children must contain between 1 and 100 table rows.');
    }
    if (tableChildren.length === 0 && (payload.children !== undefined || mode === 'create')) {
      throw new Error('table.children must contain between 1 and 100 table rows.');
    }
    for (const [index, child] of tableChildren.entries()) {
      const row = isRecord(child) && isRecord(child.table_row) ? child.table_row : null;
      if (!row || !Array.isArray(row.cells) || row.cells.length !== payload.table_width) {
        throw new Error(`table.children[${index}] must be a table_row with exactly ${payload.table_width} cells.`);
      }
    }
  }
  if (type === 'table_row') {
    if (!Array.isArray(payload.cells) || payload.cells.length > 100) {
      throw new Error('table_row.cells must be an array with at most 100 cells.');
    }
    for (const [index, cell] of payload.cells.entries()) {
      validateNotionRichTextArray(cell, `table_row.cells[${index}]`, true);
    }
  }
  if (type === 'column_list') {
    if (!Array.isArray(payload.children) || payload.children.length < 2 || payload.children.length > 100) {
      throw new Error('column_list.children must contain between 2 and 100 columns.');
    }
    if (!payload.children.every((child) => isRecord(child) && isRecord(child.column))) {
      throw new Error('column_list.children may contain only column blocks.');
    }
  }
  if (type === 'column') {
    if (!Array.isArray(payload.children) && mode === 'create') {
      throw new Error('column.children is required.');
    }
    if (payload.width_ratio !== undefined) {
      const width = payload.width_ratio;
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width >= 1) {
        throw new Error('column.width_ratio must be greater than 0 and less than 1.');
      }
    }
  }
  if (type === 'tab' && context !== 'childless'
    && ((Array.isArray(payload.children) && payload.children.length < 1)
      || (!Array.isArray(payload.children) && mode === 'create'))) {
    throw new Error('tab.children must contain at least one tab item.');
  }
  if (type === 'synced_block' && !Object.prototype.hasOwnProperty.call(payload, 'synced_from')) {
    throw new Error('synced_block.synced_from is required and may be null.');
  }
  if (type === 'synced_block' && payload.synced_from !== null) {
    if (!isRecord(payload.synced_from)) throw new Error('synced_block.synced_from must be an object or null.');
    assertOnlyKeys(payload.synced_from, ['block_id', 'type'], 'synced_block.synced_from');
    requireString(payload.synced_from.block_id, 'synced_block.synced_from.block_id');
    if (payload.synced_from.type !== undefined && payload.synced_from.type !== 'block_id') {
      throw new Error('synced_block.synced_from.type must be block_id.');
    }
  }
}

function validateNotionBlockRequestTree(
  input: Record<string, unknown>,
  context: NotionBlockRequestContext,
  field: string,
) {
  const type = notionInputBlockType(input);
  if (!notionBlockTypesByRequestContext[context].has(type)) {
    throw new Error(`${field} cannot contain a ${type} block in the ${context} context.`);
  }
  const payload = contentForType(input, type);
  notionBlockRequestContexts.set(payload, context);
  validateNotionBlockPayload(type, payload, context);
  if (!Array.isArray(payload.children)) return;
  const childContext = notionChildBlockContext(context, type);
  if (!childContext) throw new Error(`${field}.${type}.children is not allowed in this nesting context.`);
  for (const [index, child] of payload.children.entries()) {
    if (!isRecord(child)) throw new Error(`${field}.${type}.children[${index}] must be a block object.`);
    validateNotionBlockRequestTree(child, childContext, `${field}.${type}.children[${index}]`);
  }
}

function validateNotionBlockUpdatePayload(type: string, payload: Record<string, unknown>) {
  // Three update payload schemas in the current OpenAPI omit
  // additionalProperties:false; preserve that published behavior while
  // validating every field the schema does define.
  if (!['paragraph', 'to_do', 'callout'].includes(type)) {
    assertOnlyKeys(payload, notionBlockUpdatePayloadKeys[type] ?? [], `${type} block update`);
  }
  validateNotionBlockFieldTypes(type, payload);
  if (type === 'embed' && payload.url !== undefined && payload.file_upload !== undefined) {
    throw new Error('embed updates cannot include both url and file_upload.');
  }
  if (
    ['image', 'video', 'pdf', 'file', 'audio'].includes(type)
    && payload.external !== undefined
    && payload.file_upload !== undefined
  ) {
    throw new Error(`${type} updates cannot include both external and file_upload.`);
  }
  if (type === 'link_to_page') {
    const targets = ['page_id', 'database_id', 'comment_id'].filter((key) => !!optionalString(payload[key]));
    if (targets.length !== 1) throw new Error('link_to_page requires exactly one target id.');
    if (payload.type !== undefined && payload.type !== targets[0]) {
      throw new Error('link_to_page.type does not match its target id.');
    }
  }
  if (type === 'table_row') {
    if (!Array.isArray(payload.cells) || payload.cells.length > 100) {
      throw new Error('table_row.cells must be an array with at most 100 cells.');
    }
    for (const [index, cell] of payload.cells.entries()) {
      validateNotionRichTextArray(cell, `table_row.cells[${index}]`, true);
    }
  }
  if (['heading_1', 'heading_2', 'heading_3', 'heading_4', 'bulleted_list_item',
    'numbered_list_item', 'quote', 'toggle', 'template'].includes(type)) {
    validateNotionRichTextArray(payload.rich_text, `${type}.rich_text`, true);
  }
  if (type === 'equation' && typeof payload.expression !== 'string') {
    throw new Error('equation.expression is required.');
  }
  if (type === 'synced_block') {
    if (!Object.prototype.hasOwnProperty.call(payload, 'synced_from')) {
      throw new Error('synced_block.synced_from is required and may be null.');
    }
    if (payload.synced_from !== null) {
      if (!isRecord(payload.synced_from)) throw new Error('synced_block.synced_from must be an object or null.');
      assertOnlyKeys(payload.synced_from, ['block_id', 'type'], 'synced_block.synced_from');
      requireString(payload.synced_from.block_id, 'synced_block.synced_from.block_id');
      if (payload.synced_from.type !== undefined && payload.synced_from.type !== 'block_id') {
        throw new Error('synced_block.synced_from.type must be block_id.');
      }
    }
  }
  if (type === 'column' && payload.width_ratio !== undefined) {
    if (typeof payload.width_ratio !== 'number' || payload.width_ratio <= 0 || payload.width_ratio >= 1) {
      throw new Error('column.width_ratio must be greater than 0 and less than 1.');
    }
  }
}

function mergeNotionBlockUpdatePayload(
  type: string,
  current: Record<string, unknown>,
  requested: Record<string, unknown>,
) {
  const merged = { ...current, ...requested };
  if (type === 'embed') {
    if (Object.prototype.hasOwnProperty.call(requested, 'url')) {
      delete merged.file_upload;
      delete merged.type;
    } else if (Object.prototype.hasOwnProperty.call(requested, 'file_upload')) {
      delete merged.url;
      merged.type = 'file_upload';
    }
    return merged;
  }
  if (!['image', 'video', 'pdf', 'file', 'audio'].includes(type)) return merged;
  if (Object.prototype.hasOwnProperty.call(requested, 'external')) {
    delete merged.file_upload;
    delete merged.file;
    merged.type = 'external';
  } else if (Object.prototype.hasOwnProperty.call(requested, 'file_upload')) {
    delete merged.external;
    delete merged.file;
    merged.type = 'file_upload';
  }
  return merged;
}

function localBlockTypeFromNotion(type: string, typeContent: Record<string, unknown>) {
  if (type.startsWith('heading_') && typeContent.is_toggleable === true) {
    return `toggle_${type}`;
  }
  if (type === 'table') return 'simple_table';
  if (type === 'template') return 'button';
  if (type === 'pdf') return 'file';
  return type;
}

function notionPayloadWithoutChildren(typeContent: Record<string, unknown>) {
  const payload = { ...typeContent };
  delete payload.children;
  return payload;
}

function tableCellsFromNotionChildren(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((child) => child.type === 'table_row' || isRecord(child.table_row))
    .map((child) => {
      const row = isRecord(child.table_row) ? child.table_row : {};
      const cells = Array.isArray(row.cells) ? row.cells : [];
      return cells.map((cell) => richTextToPlainText(cell));
    });
}

async function localBlockFromNotion(
  context: FunctionContext,
  db: DbRef,
  workspaceId: string,
  input: Record<string, unknown>,
  pageId: string,
  parentId: string | null,
  actorId: string,
  position: number,
  options: {
    validationMode?: NotionBlockPayloadValidationMode;
    baseBlock?: Block;
  } = {},
): Promise<Block> {
  const notionType = notionInputBlockType(input);
  const typeContent = contentForType(input, notionType);
  const validationMode = options.validationMode ?? 'create';
  if (validationMode === 'create'
    && !notionBlockRequestContexts.has(typeContent)
    && Array.isArray(typeContent.children)) {
    validateNotionBlockRequestTree(input, 'root', 'block');
  }
  validateNotionBlockPayload(
    notionType,
    typeContent,
    notionBlockRequestContexts.get(typeContent) ?? 'root',
    validationMode,
  );
  const type = localBlockTypeFromNotion(notionType, typeContent);
  const content: Record<string, unknown> = {
    ...(options.baseBlock?.content ?? {}),
    notionCompatType: notionType,
    notionCompatPayload: notionPayloadWithoutChildren(typeContent),
  };
  if (textBlockTypes.has(type) || notionType === 'template') {
    content.rich = richContentFromNotion(typeContent);
  }
  if (notionType === 'to_do') content.checked = typeContent.checked === true;
  if (notionType === 'callout') {
    content.icon = isRecord(typeContent.icon) && typeContent.icon.type === 'emoji' ? typeContent.icon.emoji : undefined;
    content.color = optionalString(typeContent.color);
  }
  if (notionType === 'paragraph') {
    content.icon = isRecord(typeContent.icon) && typeContent.icon.type === 'emoji' ? typeContent.icon.emoji : undefined;
    content.color = optionalString(typeContent.color);
  }
  if (type.startsWith('toggle')) content.collapsed = false;
  if (notionType === 'code') {
    content.language = optionalString(typeContent.language) || 'plain text';
    content.caption = notionRichTextToSpans(typeContent.caption);
  }
  if (notionType === 'equation') content.expression = optionalString(typeContent.expression) || '';
  if (['image', 'video', 'audio', 'file', 'pdf'].includes(notionType)) {
    const url =
      isRecord(typeContent.external)
        ? optionalString(typeContent.external.url)
        : isRecord(typeContent.file)
          ? optionalString(typeContent.file.url)
          : undefined;
    content.url = url;
    content.fileName = optionalString(typeContent.name);
    content.caption = notionRichTextToSpans(typeContent.caption);
  }
  if (
    ['image', 'video', 'audio', 'file', 'pdf', 'embed'].includes(notionType)
    && typeContent.file_upload !== undefined
  ) {
    const upload = await consumableNotionFileUpload(
      context,
      db,
      workspaceId,
      typeContent.file_upload,
      notionType,
    );
    content.notionFileUploadId = upload.id;
    if (notionType === 'file' && !content.fileName) content.fileName = upload.name;
  }
  if (notionType === 'bookmark' || notionType === 'embed') content.url = optionalString(typeContent.url);
  if (notionType === 'link_to_page') {
    content.childPageId = optionalString(typeContent.page_id || typeContent.database_id || typeContent.comment_id);
    content.notionLinkToPage = { ...typeContent };
  }
  if (notionType === 'synced_block') {
    const syncedFrom = isRecord(typeContent.synced_from) ? typeContent.synced_from : null;
    content.syncedBlockId = syncedFrom ? optionalString(syncedFrom.block_id) : undefined;
  }
  if (notionType === 'column' && typeof typeContent.width_ratio === 'number') {
    content.width = typeContent.width_ratio;
  }
  if (notionType === 'table') {
    if (Array.isArray(typeContent.children)) {
      content.table = tableCellsFromNotionChildren(typeContent.children);
    } else if (!Array.isArray(content.table)) {
      content.table = [];
    }
    content.headerRow = typeContent.has_column_header === true;
    content.headerColumn = typeContent.has_row_header === true;
    content.tableWidth = typeof typeContent.table_width === 'number'
      ? Math.max(1, Math.floor(typeContent.table_width))
      : undefined;
  }
  if (notionType === 'table_row') {
    const cells = Array.isArray(typeContent.cells) ? typeContent.cells : [];
    content.cells = cells.map((cell) => notionRichTextToSpans(cell));
  }
  if (notionType === 'template') {
    content.buttonLabel = richTextToPlainText(typeContent.rich_text) || 'Template';
  }
  const plainText =
    notionType === 'equation'
      ? optionalString(content.expression) || ''
      : notionType === 'table'
        ? (content.table as string[][]).map((row) => row.join('\t')).join('\n')
        : notionType === 'table_row'
          ? (content.cells as RichTextSpan[][]).map((cell) => cell.map((span) => span.text).join('')).join('\t')
          : Array.isArray(content.rich)
            ? (content.rich as RichTextSpan[]).map((span) => span.text || '').join('')
            : optionalString(content.url) || '';
  return {
    id: optionalString(input.id) || newId(),
    pageId,
    parentId,
    type,
    content: Object.keys(content).length ? content : undefined,
    plainText,
    position,
    createdBy: actorId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function storedNotionBlockPayload(block: Block, type: string) {
  const content = block.content ?? {};
  const compatPayload = isRecord(content.notionCompatPayload) ? content.notionCompatPayload : null;
  const notionBlock = isRecord(content.notionBlock) ? content.notionBlock : null;
  const rawPayload = notionBlock?.type === type && isRecord(notionBlock[type])
    ? notionBlock[type] as Record<string, unknown>
    : null;
  const payload = { ...(rawPayload ?? compatPayload ?? {}) };
  delete payload.children;
  return payload;
}

function notionBlockResponseType(block: Block) {
  const content = block.content ?? {};
  const compatType = optionalString(content.notionCompatType);
  if (compatType && officialResponseBlockTypes.has(compatType)) return compatType;
  const raw = isRecord(content.notionBlock) ? content.notionBlock : null;
  const rawType = optionalString(raw?.type);
  if (rawType && officialResponseBlockTypes.has(rawType)) return rawType;
  if (block.type.startsWith('toggle_heading_')) return block.type.replace(/^toggle_/, '');
  if (block.type === 'simple_table') return 'table';
  if (block.type === 'inline_database') return 'child_database';
  if (block.type === 'button') return 'unsupported';
  return officialResponseBlockTypes.has(block.type) ? block.type : 'unsupported';
}

function notionBlockTextPayload(block: Block, type: string) {
  const content = block.content ?? {};
  const payload = storedNotionBlockPayload(block, type);
  const localTextType = type.startsWith('heading_') && block.type.startsWith('toggle_heading_')
    ? block.type
    : type;
  if (textBlockTypes.has(localTextType) || type === 'template') {
    payload.rich_text = spansToNotionRichText(content.rich);
  }
  if (type === 'to_do') payload.checked = content.checked === true;
  if (type.startsWith('heading_')) {
    payload.color = content.color || 'default';
    payload.is_toggleable = block.type.startsWith('toggle_heading_');
  }
  if (['paragraph', 'bulleted_list_item', 'numbered_list_item', 'quote', 'to_do', 'toggle'].includes(type)) {
    payload.color = content.color || payload.color || 'default';
  }
  if (type === 'paragraph' && content.icon) payload.icon = { type: 'emoji', emoji: content.icon };
  if (type === 'callout') {
    if (content.icon) payload.icon = { type: 'emoji', emoji: content.icon };
    else if (!('icon' in payload)) payload.icon = null;
    payload.color = content.color || 'default';
  }
  if (type === 'code') {
    payload.language = content.language || 'plain text';
    payload.caption = spansToNotionRichText(content.caption);
  }
  if (type === 'equation') payload.expression = content.expression || block.plainText || '';
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'file' || type === 'pdf') {
    const url = optionalString(content.url) || '';
    if (url) {
      payload.type = 'external';
      payload.external = { url };
      delete payload.file;
      delete payload.file_upload;
    }
    payload.caption = spansToNotionRichText(content.caption);
    if (type === 'file') payload.name = optionalString(content.fileName) || url || 'Untitled';
  }
  if (type === 'bookmark' || type === 'embed') {
    const url = optionalString(content.url);
    if (url) payload.url = url;
    else if (type === 'bookmark' && !('url' in payload)) payload.url = '';
  }
  if (type === 'link_to_page') {
    const storedTarget = isRecord(content.notionLinkToPage) ? content.notionLinkToPage : null;
    if (storedTarget) Object.assign(payload, storedTarget);
    else payload.page_id = optionalString(content.childPageId) || null;
  }
  if (type === 'synced_block') {
    const sourceId = optionalString(content.syncedBlockId);
    payload.synced_from = sourceId ? { type: 'block_id', block_id: sourceId } : null;
  }
  if (type === 'column' && typeof content.width === 'number') payload.width_ratio = content.width;
  if (type === 'table') {
    const table = Array.isArray(content.table) ? content.table.filter(Array.isArray) as unknown[][] : [];
    const inferredWidth = table.reduce((max, row) => Math.max(max, row.length), 0);
    payload.table_width = typeof content.tableWidth === 'number'
      ? content.tableWidth
      : typeof payload.table_width === 'number'
        ? payload.table_width
        : Math.max(1, inferredWidth);
    payload.has_column_header = content.headerRow === true;
    payload.has_row_header = content.headerColumn === true;
  }
  if (type === 'table_row') {
    if (Array.isArray(content.cells)) {
      payload.cells = content.cells.map((cell) => spansToNotionRichText(cell));
    }
  }
  if (type === 'table_of_contents') payload.color = content.color || payload.color || 'default';
  if (type === 'child_page') payload.title = optionalString(content.childPageTitle) || block.plainText || 'Untitled';
  if (type === 'child_database') payload.title = optionalString(content.childPageTitle) || block.plainText || 'Untitled';
  if (type === 'unsupported') {
    payload.block_type = optionalString(payload.block_type)
      || optionalString(content.notionCompatType)
      || (block.type === 'button' ? 'button' : block.type);
  }
  return payload;
}

function tableRowPlainCells(block: Block) {
  const content = block.content ?? {};
  if (Array.isArray(content.cells)) {
    return content.cells.map((cell) => plainTextFromSpans(cell));
  }
  const payload = storedNotionBlockPayload(block, 'table_row');
  return Array.isArray(payload.cells) ? payload.cells.map((cell) => richTextToPlainText(cell)) : [];
}

function materializedSimpleTableRows(parent: Block, actorId: string, rows: unknown[][]): Block[] {
  return rows.map((row, index) => {
    const cells = row.map((cell) => [{ text: String(cell ?? '') }]);
    return {
      id: newId(),
      pageId: parent.pageId,
      parentId: parent.id,
      type: 'table_row',
      content: { notionCompatType: 'table_row', cells },
      plainText: row.map((cell) => String(cell ?? '')).join('\t'),
      position: index + 1,
      createdBy: parent.createdBy || actorId,
      createdAt: parent.createdAt,
      updatedAt: parent.updatedAt,
    };
  });
}

async function syncSimpleTableFromRows(
  context: FunctionContext,
  db: DbRef,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  const parent = await getExisting(db.table<Block>('blocks'), parentId);
  if (!parent || parent.type !== 'simple_table') return;
  const page = await getExisting(db.table<Page>('pages'), parent.pageId);
  if (!page) throw new Error('Table parent page was not found.');
  const rows = (await listAll(db.table<Block>('blocks').where('pageId', '==', parent.pageId)))
    .filter((candidate) => candidate.parentId === parent.id && notionBlockResponseType(candidate) === 'table_row')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const table = rows.map(tableRowPlainCells);
  if (JSON.stringify(parent.content?.table ?? []) === JSON.stringify(table)) return;
  await callProductMutation(blockMutationPOST as FunctionDefinition, context, {
    action: 'update',
    id: parent.id,
    pageId: parent.pageId,
    workspaceId: page.workspaceId,
    expectedUpdatedAt: parent.updatedAt,
    patch: {
      content: { ...(parent.content ?? {}), table },
      plainText: table.map((row) => row.join('\t')).join('\n'),
    },
  });
}

async function notionBlockFromLocal(
  context: FunctionContext,
  db: DbRef,
  block: Block,
  request: Request,
) {
  const pageBlocks = await listAll(db.table<Block>('blocks').where('pageId', '==', block.pageId));
  const hasChildren = pageBlocks.some((item) => item.parentId === block.id)
    || (block.type === 'simple_table' && Array.isArray(block.content?.table) && block.content.table.length > 0);
  const type = notionBlockResponseType(block);
  const createdTime = block.createdAt ?? new Date(0).toISOString();
  let payload = notionBlockTextPayload(block, type);
  const uploadId = optionalString(block.content?.notionFileUploadId);
  if (uploadId) {
    const [ownerPage, upload] = await Promise.all([
      getExisting(db.table<Page>('pages'), block.pageId),
      getExisting(db.table<FileUpload>('file_uploads'), uploadId),
    ]);
    if (!ownerPage || !upload || upload.workspaceId !== ownerPage.workspaceId || upload.status !== 'uploaded') {
      throw new Error('Stored block file upload was not found or is no longer available.');
    }
    const signed = await freshNotionUploadedFile(context, upload);
    if (type === 'embed') {
      payload = { ...payload, url: (signed.file as { url: string }).url };
      delete payload.file_upload;
      delete payload.type;
    } else if (['image', 'video', 'audio', 'file', 'pdf'].includes(type)) {
      payload = { ...payload, type: 'file', file: signed.file };
      delete payload.file_upload;
      delete payload.external;
    }
  }
  return {
    object: 'block',
    id: block.id,
    parent: block.parentId
      ? { type: 'block_id', block_id: block.parentId }
      : { type: 'page_id', page_id: block.pageId },
    created_time: createdTime,
    last_edited_time: block.updatedAt ?? createdTime,
    created_by: notionPartialUser(block.createdBy),
    last_edited_by: notionPartialUser(block.createdBy),
    has_children: hasChildren,
    ...legacyArchivedField(request, false),
    in_trash: false,
    type,
    [type]: payload,
    url: `${pageUrl({ id: block.pageId } as Page, request)}#block-${encodeURIComponent(block.id)}`,
  };
}

async function notionChildPageBlock(db: DbRef, page: Page, request: Request) {
  const type = page.kind === 'database' ? 'child_database' : 'child_page';
  const inTrash = page.inTrash === true;
  const createdTime = page.createdAt ?? new Date(0).toISOString();
  const [blocks, childPages] = await Promise.all([
    listAll(db.table<Block>('blocks').where('pageId', '==', page.id)),
    listAll(db.table<Page>('pages').where('parentId', '==', page.id)),
  ]);
  const hasChildren = blocks.some((block) => !block.parentId)
    || childPages.some((child) => child.parentType === 'page' && !child.inTrash);
  return {
    object: 'block',
    id: page.id,
    parent: { type: 'page_id', page_id: page.parentId },
    created_time: createdTime,
    last_edited_time: page.updatedAt ?? createdTime,
    created_by: notionPartialUser(page.createdBy),
    last_edited_by: notionPartialUser(page.lastEditedBy || page.createdBy),
    has_children: hasChildren,
    ...legacyArchivedField(request, inTrash),
    in_trash: inTrash,
    type,
    [type]: { title: page.title || 'Untitled' },
    url: pageUrl(page, request),
  };
}

async function blockParentPage(
  db: DbRef,
  blockId: string,
  actorId: string,
  actorEmail?: string | null,
  bearer?: NotionCompatBearerIdentity | null,
) {
  const block = await getExisting(db.table<Block>('blocks'), blockId);
  if (!block) return null;
  const page = await requireReadablePage(db, block.pageId, actorId, actorEmail, bearer);
  return { block, page };
}

// Official Notion block routes carry only a block id. Page-shaped child blocks
// can use page_workspace_index; raw block ids fan out only across workspaces
// the actor can access, then the endpoint still authorizes the owning page.
async function blockRoutedDb(
  context: FunctionContext,
  blockId: string,
  body?: Record<string, unknown>,
): Promise<DbRef> {
  const workspaceHint = workspaceIdFromRequest(context.request, body);
  if (workspaceHint) return boundedDbFromWorkspaceHint(context.admin, workspaceHint);
  const routed = await findAccessibleRecord<Block>(context, 'blocks', blockId, body);
  if (routed) return routed.db;
  const pageDb = await boundedDbForPage(context.admin, blockId);
  if (pageDb) return pageDb;
  throw new Error('Block was not found.');
}

async function listBlockChildren(context: FunctionContext, blockId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await blockRoutedDb(context, blockId);
  const page = await getExisting(db.table<Page>('pages'), blockId);
  if (page) {
    await requireReadablePage(db, page.id, auth.id, auth.email, context.compatBearer);
    const [blocks, childPages] = await Promise.all([
      listAll(db.table<Block>('blocks').where('pageId', '==', page.id)),
      listAll(db.table<Page>('pages').where('parentId', '==', page.id)),
    ]);
    const ordered = [
      ...blocks
        .filter((block) => !block.parentId)
        .map((block) => ({ kind: 'block' as const, id: block.id, position: block.position ?? 0, block })),
      ...childPages
        .filter((child) => child.parentType === 'page' && !child.inTrash)
        .map((child) => ({ kind: 'page' as const, id: child.id, position: child.position ?? 0, child })),
    ].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const results = await Promise.all(ordered.map((item) => item.kind === 'block'
      ? notionBlockFromLocal(context, db, item.block, request)
      : notionChildPageBlock(db, item.child, request)));
    return listObjectByIdCursor(results, 'block', request, (item) => String(item.id));
  }
  const parent = await blockParentPage(db, blockId, auth.id, auth.email, context.compatBearer);
  if (!parent) throw new Error('Block was not found.');
  let blocks = (await listAll(db.table<Block>('blocks').where('pageId', '==', parent.block.pageId)))
    .filter((block) => block.parentId === blockId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (blocks.length === 0 && parent.block.type === 'simple_table' && Array.isArray(parent.block.content?.table)) {
    blocks = parent.block.content.table.filter(Array.isArray).map((row, index): Block => ({
      id: `${parent.block.id}:row:${index + 1}`,
      pageId: parent.block.pageId,
      parentId: parent.block.id,
      type: 'table_row',
      content: {
        notionCompatType: 'table_row',
        cells: row.map((cell) => [{ text: String(cell ?? '') }]),
      },
      plainText: row.map((cell) => String(cell ?? '')).join('\t'),
      position: index + 1,
      createdBy: parent.block.createdBy,
      createdAt: parent.block.createdAt,
      updatedAt: parent.block.updatedAt,
    }));
  }
  const results = await Promise.all(blocks.map((block) => notionBlockFromLocal(context, db, block, request)));
  return listObjectByIdCursor(results, 'block', request, (item) => String(item.id));
}

function blockAppendPositions(
  siblings: Block[],
  input: unknown,
  count: number,
) {
  const ordered = siblings
    .slice()
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id));
  if (input === undefined) {
    const last = ordered.at(-1)?.position ?? 0;
    return Array.from({ length: count }, (_, index) => last + index + 1);
  }
  if (!isRecord(input)) throw new Error('position must be an object.');
  const type = requireString(input.type, 'position.type');
  if (type === 'start') {
    const first = ordered[0]?.position ?? 0;
    return Array.from({ length: count }, (_, index) => first - count + index);
  }
  if (type === 'end') {
    const last = ordered.at(-1)?.position ?? 0;
    return Array.from({ length: count }, (_, index) => last + index + 1);
  }
  if (type !== 'after_block') {
    throw new Error('position.type must be after_block, start, or end.');
  }
  if (!isRecord(input.after_block)) throw new Error('position.after_block is required.');
  const afterId = requireString(input.after_block.id, 'position.after_block.id');
  const targetIndex = ordered.findIndex((block) => block.id === afterId);
  if (targetIndex < 0) throw new Error('position.after_block.id must identify a sibling block.');
  const left = ordered[targetIndex].position ?? 0;
  const right = ordered[targetIndex + 1]?.position;
  if (right !== undefined && right <= left) {
    throw new Error('Sibling block positions are ambiguous; the requested insertion cannot be ordered safely.');
  }
  const step = right === undefined ? 1 : (right - left) / (count + 1);
  return Array.from({ length: count }, (_, index) => left + step * (index + 1));
}

async function appendBlockChildren(context: FunctionContext, blockId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  assertOnlyKeys(body, context.compatBearer ? ['children', 'position', 'workspace_id'] : ['children', 'position'], 'append block children');
  if (!Array.isArray(body.children)) throw new Error('children is required and must be an array.');
  if (body.children.length > NOTION_COMPAT_MAX_CHILDREN_PER_ARRAY) {
    throw new Error(`children must contain at most ${NOTION_COMPAT_MAX_CHILDREN_PER_ARRAY} blocks.`);
  }
  const db = await blockRoutedDb(context, blockId, body);
  const page = await getExisting(db.table<Page>('pages'), blockId);
  let pageId = blockId;
  let parentId: string | null = null;
  let parentBlock: Block | null = null;
  if (page) {
    await requireWritablePage(db, page.id, auth.id, auth.email, context.compatBearer);
  } else {
    const parent = await blockParentPage(db, blockId, auth.id, auth.email, context.compatBearer);
    if (!parent) throw new Error('Block was not found.');
    await requireWritablePage(db, parent.block.pageId, auth.id, auth.email, context.compatBearer);
    pageId = parent.block.pageId;
    parentId = parent.block.id;
    parentBlock = parent.block;
  }
  if (body.children.length === 0) return listObject([], 'block');
  const existing = await listAll(db.table<Block>('blocks').where('pageId', '==', pageId));
  const siblings = existing.filter((block) => (block.parentId ?? null) === parentId);
  const hasRealTableRows = siblings.some((block) => notionBlockResponseType(block) === 'table_row');
  const storedTableRows = parentBlock?.type === 'simple_table'
    && !hasRealTableRows
    && Array.isArray(parentBlock.content?.table)
    ? parentBlock.content.table.filter(Array.isArray) as unknown[][]
    : [];
  if (
    storedTableRows.length + body.children.length
    > NOTION_COMPAT_SIMPLE_TABLE_MATERIALIZATION_LIMIT
  ) {
    throw Object.assign(
      new Error('The existing simple table is too large to materialize in one atomic append.'),
      { status: 413 },
    );
  }
  const materializedRows = parentBlock
    ? materializedSimpleTableRows(parentBlock, auth.id, storedTableRows)
    : [];
  const positions = blockAppendPositions(
    [...siblings, ...materializedRows],
    body.position,
    body.children.length,
  );
  const ownerPage = await getExisting(db.table<Page>('pages'), pageId);
  if (!ownerPage) throw new Error('Page was not found.');
  const prepared = await prepareBlocksUnder(
    context,
    db,
    ownerPage.workspaceId,
    pageId,
    parentId,
    body.children,
    auth.id,
    0,
  );
  if (
    materializedRows.length + prepared.length
    > NOTION_COMPAT_SIMPLE_TABLE_MATERIALIZATION_LIMIT
  ) {
    throw Object.assign(
      new Error('The existing simple table is too large to materialize in one atomic append.'),
      { status: 413 },
    );
  }
  let topLevelIndex = 0;
  for (const block of prepared) {
    if ((block.parentId ?? null) !== parentId) continue;
    block.position = positions[topLevelIndex] ?? block.position;
    topLevelIndex += 1;
  }
  const allCreatedBlocks = [...materializedRows, ...prepared];
  const requestedIds = new Set(prepared.map((block) => block.id));
  const result = allCreatedBlocks.length > 0
    ? await callProductMutation(blockMutationPOST as FunctionDefinition, context, {
        action: 'createMany', blocks: allCreatedBlocks,
      })
    : { blocks: [] };
  const created = (result.blocks ?? []) as Block[];
  await syncSimpleTableFromRows(context, db, parentId);
  const results = await Promise.all(
    created
      .filter((block) => (block.parentId ?? null) === parentId)
      .filter((block) => requestedIds.has(block.id))
      .map((block) => notionBlockFromLocal(context, db, block, request)),
  );
  return listObject(results, 'block');
}

async function updateBlockEndpoint(context: FunctionContext, blockId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await blockRoutedDb(context, blockId, body);
  const current = await getExisting(db.table<Block>('blocks'), blockId);
  if (!current) {
    const childPage = await getExisting(db.table<Page>('pages'), blockId);
    if (!childPage || childPage.parentType !== 'page') throw new Error('Block was not found.');
    assertOnlyKeys(body, context.compatBearer ? ['in_trash', 'workspace_id'] : ['in_trash'], 'child page block update');
    if (typeof body.in_trash !== 'boolean') {
      throw new Error('Child page block updates require in_trash as a boolean.');
    }
    await requirePageRole(db, childPage.id, auth.id, 'edit', auth.email, context.compatBearer);
    if (body.in_trash === (childPage.inTrash === true)) {
      return notionChildPageBlock(db, childPage, request);
    }
    if (body.in_trash) return deleteBlockEndpoint(context, blockId);
    await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: 'restore', id: childPage.id, workspaceId: childPage.workspaceId,
    });
    const restored = await getExisting(db.table<Page>('pages'), childPage.id) ?? { ...childPage, inTrash: false };
    return notionChildPageBlock(db, restored, request);
  }
  const page = await requireWritablePage(db, current.pageId, auth.id, auth.email, context.compatBearer);
  const currentType = notionBlockResponseType(current);
  if (body.in_trash !== undefined && typeof body.in_trash !== 'boolean') {
    throw new Error('in_trash must be a boolean.');
  }
  if (body.type !== undefined && typeof body.type !== 'string') {
    throw new Error('type must be a string.');
  }
  const payloadTypes = Array.from(officialWritableBlockTypes).filter((type) => isRecord(body[type]));
  const explicitType = typeof body.type === 'string' ? body.type : null;
  if (payloadTypes.length > 1) throw new Error('A block update must contain exactly one block payload.');
  const type = explicitType || payloadTypes[0] || currentType;
  const hasRequestedPayload = payloadTypes.length === 1 || explicitType !== null;
  const routingKeys = context.compatBearer ? ['workspace_id'] : [];
  assertOnlyKeys(
    body,
    hasRequestedPayload ? ['type', 'in_trash', type, ...routingKeys] : ['in_trash', ...routingKeys],
    'block update',
  );
  if (!hasRequestedPayload && body.in_trash === undefined) {
    throw new Error('A block update must contain a block payload or in_trash.');
  }
  if (hasRequestedPayload) {
    if (!officialWritableBlockTypes.has(type) || type === 'column_list') {
      throw new Error(`Notion block type ${type} is read-only and cannot be updated.`);
    }
    if (!isRecord(body[type])) throw new Error(`${type} block content is required.`);
    if (type !== currentType) throw new Error('A block update cannot change the block type.');
    validateNotionBlockUpdatePayload(type, body[type] as Record<string, unknown>);
  } else if (body.in_trash === true) {
    return deleteBlockEndpoint(context, blockId);
  } else {
    return notionBlockFromLocal(context, db, current, request);
  }
  const currentPayload = notionBlockTextPayload(current, currentType);
  const requestedPayload = Object.fromEntries(
    Object.entries(body[type] as Record<string, unknown>)
      .filter(([key]) => (notionBlockUpdatePayloadKeys[type] ?? []).includes(key)),
  );
  const mergedInput: Record<string, unknown> = {
    type,
    [type]: mergeNotionBlockUpdatePayload(type, currentPayload, requestedPayload),
  };
  const isStoredContainerUpdate = type === 'table' || type === 'column' || type === 'tab';
  const next = await localBlockFromNotion(
    context,
    db,
    page.workspaceId,
    mergedInput,
    current.pageId,
    current.parentId ?? null,
    current.createdBy || auth.id,
    current.position ?? 1,
    isStoredContainerUpdate
      ? { validationMode: 'stored_update', baseBlock: current }
      : undefined,
  );
  const result = await callProductMutation(blockMutationPOST as FunctionDefinition, context, {
    action: 'update',
    id: current.id,
    pageId: current.pageId,
    workspaceId: page.workspaceId,
    expectedUpdatedAt: current.updatedAt,
    patch: {
      type: next.type,
      content: next.content,
      plainText: next.plainText,
    },
  });
  const updated = result.block as Block;
  await syncSimpleTableFromRows(context, db, updated.parentId);
  if (body.in_trash === true) return deleteBlockEndpoint(context, blockId);
  return notionBlockFromLocal(context, db, updated, request);
}

async function deleteBlockEndpoint(context: FunctionContext, blockId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await blockRoutedDb(context, blockId);
  const page = await getExisting(db.table<Page>('pages'), blockId);
  if (page && page.parentType === 'page') {
    await requireWritablePage(db, page.id, auth.id, auth.email, context.compatBearer);
    await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: 'trash', id: page.id, workspaceId: page.workspaceId,
    });
    const updated = await getExisting(db.table<Page>('pages'), page.id) ?? { ...page, inTrash: true };
    return { ...await notionChildPageBlock(db, updated, request), in_trash: true };
  }
  const block = await getExisting(db.table<Block>('blocks'), blockId);
  if (!block) throw new Error('Block was not found.');
  const ownerPage = await requireWritablePage(db, block.pageId, auth.id, auth.email, context.compatBearer);
  await callProductMutation(blockMutationPOST as FunctionDefinition, context, {
    action: 'delete',
    id: block.id,
    pageId: block.pageId,
    workspaceId: ownerPage.workspaceId,
    expectedUpdatedAt: block.updatedAt,
  });
  await syncSimpleTableFromRows(context, db, block.parentId);
  const deleted = await notionBlockFromLocal(context, db, block, request);
  return { ...deleted, ...legacyArchivedField(request, true), in_trash: true };
}

async function createDatabaseEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const dbParentHints = body.parent as { page_id?: unknown } | undefined;
  const dbWorkspaceHint = compatWorkspaceHint(body);
  // Workspace-parent databases carry no page-shaped hint; route via workspace_id.
  const db =
    !dbParentHints?.page_id && dbWorkspaceHint
      ? boundedDbFromWorkspaceHint(context.admin, dbWorkspaceHint)
      : await boundedDbFromPageHint(context.admin, dbParentHints?.page_id);
  const parent = await resolveDatabaseParent(db, body, auth.id, auth.email, context.compatBearer);
  const id = optionalString(body.id) || newId();
  const title = richTextToPlainText(body.title).trim();
  const icon = body.icon === undefined
    ? { icon: '', iconType: 'none' as const, notionIcon: null }
    : await notionIconToLocal(context, db, parent.workspaceId, body.icon);
  const cover = body.cover === undefined
    ? { cover: '', notionCover: null }
    : await notionCoverToLocal(context, db, parent.workspaceId, body.cover);
  if (body.title !== undefined) validatePagePropertyRichText(body.title, 'title');
  if (body.description !== undefined) validatePagePropertyRichText(body.description, 'description');
  if (body.is_inline !== undefined && typeof body.is_inline !== 'boolean') {
    throw new Error('is_inline must be a boolean.');
  }
  if (body.database_type !== undefined && !['tasks', 'projects', 'skills'].includes(String(body.database_type))) {
    throw new Error('database_type must be tasks, projects, or skills.');
  }
  if (body.initial_data_source !== undefined && !isRecord(body.initial_data_source)) {
    throw new Error('initial_data_source must be an object.');
  }
  const initialDataSource = isRecord(body.initial_data_source) ? body.initial_data_source : {};
  const props = await schemaFromNotionProperties(
    id,
    'properties' in initialDataSource ? initialDataSource.properties : body.properties,
    db,
    { legacy: notionVersion(request) !== latestNotionVersion },
  );
  const result = await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
    action: 'createDatabase',
    id,
    workspaceId: parent.workspaceId,
    parentId: parent.parentId,
    parentType: parent.parentType,
    title,
    icon: icon.icon,
    iconType: icon.iconType,
    notionIcon: icon.notionIcon,
    properties: props,
    viewType: 'table',
    seedRows: false,
    position: await positionForChild(db, parent.workspaceId, parent.parentId, parent.parentType),
  });
  let inserted = result.page as Page;
  const pagePatch: Partial<Page> = {
    properties: {
      ...(inserted.properties ?? {}),
      notionDescription: richTextToPlainText(body.description),
      notionIsInline: body.is_inline === true,
      ...(
        body.database_type === 'tasks' || body.database_type === 'projects' || body.database_type === 'skills'
          ? { notionDatabaseType: body.database_type }
          : {}
      ),
    },
  };
  pagePatch.cover = cover.cover;
  pagePatch.notionCover = cover.notionCover;
  if (Object.keys(pagePatch).length > 0) {
    const updated = await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: 'update', id, workspaceId: parent.workspaceId, patch: pagePatch,
    });
    inserted = updated.page as Page;
  }
  return notionDatabase(context, db, inserted, request);
}

async function createDataSourceEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, (body.parent as { page_id?: unknown; database_id?: unknown } | undefined)?.page_id, (body.parent as { database_id?: unknown } | undefined)?.database_id);
  const parent = isRecord(body.parent) ? body.parent : {};
  const parentDatabaseId = requireString(parent.database_id, 'parent.database_id');
  if (!isRecord(body.properties)) throw new Error('properties is required.');
  const parentDatabase = await requireWritablePage(db, parentDatabaseId, auth.id, auth.email, context.compatBearer);
  if (parentDatabase.kind !== 'database') throw new Error('Parent database was not found.');
  const id = optionalString(body.id) || newId();
  const icon = body.icon === undefined
    ? { icon: '', iconType: 'none' as const, notionIcon: null }
    : await notionIconToLocal(context, db, parentDatabase.workspaceId, body.icon);
  const cover = body.cover === undefined
    ? { cover: '', notionCover: null }
    : await notionCoverToLocal(context, db, parentDatabase.workspaceId, body.cover);
  if (body.title !== undefined) validatePagePropertyRichText(body.title, 'title');
  if (body.description !== undefined) validatePagePropertyRichText(body.description, 'description');
  if (body.is_inline !== undefined && typeof body.is_inline !== 'boolean') {
    throw new Error('is_inline must be a boolean.');
  }
  if (body.database_type !== undefined && !['tasks', 'projects', 'skills'].includes(String(body.database_type))) {
    throw new Error('database_type must be tasks, projects, or skills.');
  }
  const props = await schemaFromNotionProperties(
    id,
    body.properties,
    db,
    { legacy: notionVersion(request) !== latestNotionVersion },
  );
  const result = await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
    action: 'createDatabase',
    id,
    workspaceId: parentDatabase.workspaceId,
    parentId: parentDatabase.parentId ?? null,
    parentType: parentDatabase.parentType ?? 'workspace',
    title: richTextToPlainText(body.title).trim(),
    icon: icon.icon,
    iconType: icon.iconType,
    notionIcon: icon.notionIcon,
    properties: props,
    viewType: 'table',
    seedRows: false,
    position: await positionForChild(
      db,
      parentDatabase.workspaceId,
      parentDatabase.parentId ?? null,
      parentDatabase.parentType ?? 'workspace',
    ),
  });
  let inserted = result.page as Page;
  const pagePatch: Partial<Page> = {
    properties: {
      notionParentDatabaseId: parentDatabase.id,
      notionDescription: richTextToPlainText(body.description),
      notionIsInline: body.is_inline === true,
      ...(
        body.database_type === 'tasks' || body.database_type === 'projects' || body.database_type === 'skills'
          ? { notionDatabaseType: body.database_type }
          : {}
      ),
    },
  };
  pagePatch.cover = cover.cover;
  pagePatch.notionCover = cover.notionCover;
  const updated = await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
    action: 'update', id, workspaceId: parentDatabase.workspaceId, patch: pagePatch,
  });
  inserted = updated.page as Page;
  return notionDataSource(context, db, inserted, (result.properties ?? props) as DbProperty[], request);
}

async function listDatabasesEndpoint(context: FunctionContext) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id');
  const entries = await workspaceDbsForOptionalHint(context, workspaceId);
  const budget = materializationBudget();
  const results: unknown[] = [];
  for (const entry of entries) {
    const pages = await listAllBounded(
      entry.db.table<Page>('pages').where('workspaceId', '==', entry.workspaceId),
      budget,
      'Database listing',
    );
    for (const page of pages) {
      if (page.kind !== 'database' || page.inTrash) continue;
      if (dataSourceParentDatabaseId(page) !== page.id) continue;
      try {
        await requireReadablePage(entry.db, page.id, auth.id, auth.email, context.compatBearer);
        results.push(await notionDatabase(context, entry.db, page, request));
      } catch {
        // Omit databases the caller cannot view.
      }
    }
  }
  return listObject(results, 'database', {}, cursorOffset(url.searchParams.get('start_cursor')), pageSize(url.searchParams.get('page_size')));
}

async function listDataSourcesEndpoint(context: FunctionContext) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const url = new URL(request.url);
  const parentDatabaseId = url.searchParams.get('database_id');
  const dataSourceWorkspaceId = url.searchParams.get('workspace_id');
  const entries = parentDatabaseId
    ? [{
        workspaceId: '',
        db: await boundedDbFromPageHint(context.admin, parentDatabaseId),
      }]
    : await workspaceDbsForOptionalHint(context, dataSourceWorkspaceId);
  const budget = materializationBudget();
  const results: unknown[] = [];
  for (const entry of entries) {
    const pages = await listAllBounded(
      parentDatabaseId
        ? entry.db.table<Page>('pages')
        : entry.db.table<Page>('pages').where('workspaceId', '==', entry.workspaceId),
      budget,
      'Data source listing',
    );
    for (const page of pages) {
      if (page.kind !== 'database' || page.inTrash) continue;
      if (parentDatabaseId && dataSourceParentDatabaseId(page) !== parentDatabaseId) continue;
      try {
        await requireReadablePage(entry.db, page.id, auth.id, auth.email, context.compatBearer);
        results.push(await notionDataSource(context, entry.db, page, await databaseProperties(entry.db, page.id), request));
      } catch {
        // Omit data sources the caller cannot view.
      }
    }
  }
  return listObject(results, 'data_source', {}, cursorOffset(url.searchParams.get('start_cursor')), pageSize(url.searchParams.get('page_size')));
}

async function updateDatabaseSchema(
  context: FunctionContext,
  db: DbRef,
  database: Page,
  body: Record<string, unknown>,
  legacy = false,
) {
  if (body.properties === undefined) return databaseProperties(db, database.id);
  if (!isRecord(body.properties)) throw new Error('properties must be an object.');
  const entries = Object.entries(body.properties);
  if (entries.length > 100) throw new Error('A data-source update can contain at most 100 properties.');
  const props = await databaseProperties(db, database.id);
  const prospective: DbProperty[] = props.map((prop) => ({
    ...prop,
    ...(prop.config ? { config: { ...prop.config } } : {}),
  }));
  let nextPosition = props.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1;
  type SchemaPlan =
    | { kind: 'delete'; existing: DbProperty }
    | { kind: 'upsert'; existing?: DbProperty; next: DbProperty; schema: Record<string, unknown> };
  const plans: SchemaPlan[] = [];
  const targetedIds = new Set<string>();

  // Validate the complete request before the first canonical mutation so a
  // malformed later entry cannot leave an earlier schema edit committed.
  for (const [name, schema] of entries) {
    const existing = propByNameOrId(props, name);
    if (existing && targetedIds.has(existing.id)) {
      throw new Error(`Property ${existing.name} is targeted more than once.`);
    }
    if (existing) targetedIds.add(existing.id);
    if (schema === null) {
      if (!existing) throw new Error(`Property ${name} was not found.`);
      if (existing.type === 'title') throw new Error('The title property cannot be deleted.');
      const index = prospective.findIndex((item) => item.id === existing.id);
      if (index >= 0) prospective.splice(index, 1);
      plans.push({ kind: 'delete', existing });
      continue;
    }
    if (!isRecord(schema)) throw new Error(`Property ${name} update must be an object or null.`);
    let next: DbProperty;
    if (Object.keys(schema).length === 1 && 'name' in schema) {
      if (!existing) throw new Error(`Property ${name} was not found.`);
      next = {
        ...existing,
        name: notionPropertyName(schema, existing.name, 'update'),
      };
    } else {
      next = schemaPropertyFromNotion(
        database.id,
        name,
        schema,
        existing?.position ?? nextPosition,
        { mode: 'update', existing, legacy },
      );
    }
    if (existing?.type === 'title' && next.type !== 'title') {
      throw new Error('The title property type cannot be changed.');
    }
    const index = existing ? prospective.findIndex((item) => item.id === existing.id) : -1;
    if (index >= 0) prospective[index] = next;
    else prospective.push(next);
    plans.push({ kind: 'upsert', existing, next, schema });
    if (!existing) nextPosition += 1;
  }

  if (prospective.length > 100) throw new Error('A data source can contain at most 100 properties.');
  if (prospective.filter((prop) => prop.type === 'title').length !== 1) {
    throw new Error('A data source must contain exactly one title property.');
  }
  const propertyNames = new Set<string>();
  for (const prop of prospective) {
    const normalized = prop.name.trim().toLowerCase();
    if (!normalized) throw new Error('Property names must be non-empty.');
    if (propertyNames.has(normalized)) throw new Error(`Duplicate data-source property name: ${prop.name}.`);
    propertyNames.add(normalized);
  }
  await resolveNotionRollupSchemaReferences(db, database.id, prospective);

  const updated: DbProperty[] = [...props];
  for (const plan of plans) {
    if (plan.kind === 'delete') {
      await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
        action: 'delete',
        table: 'db_properties',
        id: plan.existing.id,
        databaseId: database.id,
        workspaceId: database.workspaceId,
      });
      const index = updated.findIndex((item) => item.id === plan.existing.id);
      if (index >= 0) updated.splice(index, 1);
      continue;
    }
    const { existing, next, schema } = plan;
    if (existing) {
      const result = await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
        action: 'update',
        table: 'db_properties',
        id: existing.id,
        databaseId: database.id,
        workspaceId: database.workspaceId,
        patch: { name: next.name, type: next.type, description: next.description, config: next.config },
        reciprocalName: notionRelationReciprocalName(schema),
      });
      const patched = result.record as DbProperty;
      const index = updated.findIndex((item) => item.id === existing.id);
      if (index >= 0) updated[index] = patched;
    } else {
      const result = await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
        action: 'insert',
        table: 'db_properties',
        databaseId: database.id,
        workspaceId: database.workspaceId,
        record: next,
        reciprocalName: notionRelationReciprocalName(schema),
      });
      const inserted = result.record as DbProperty;
      updated.push(inserted);
    }
  }
  return updated;
}

async function updateDatabaseEndpoint(context: FunctionContext, databaseId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, databaseId);
  const database = await requireWritablePage(db, databaseId, auth.id, auth.email, context.compatBearer);
  if (database.kind !== 'database') throw new Error('Database was not found.');
  if (dataSourceParentDatabaseId(database) !== database.id) throw new Error('Database was not found.');
  const patch: Partial<Page> = {};
  if ('title' in body) patch.title = richTextToPlainText(body.title) || database.title || 'Untitled';
  if ('icon' in body) {
    Object.assign(patch, await notionIconToLocal(context, db, database.workspaceId, body.icon));
  }
  if ('cover' in body) {
    Object.assign(patch, await notionCoverToLocal(context, db, database.workspaceId, body.cover));
  }
  if ('is_locked' in body) {
    if (typeof body.is_locked !== 'boolean') throw new Error('is_locked must be a boolean.');
    patch.isLocked = body.is_locked;
  }
  if ('description' in body || 'is_inline' in body) {
    if ('is_inline' in body && typeof body.is_inline !== 'boolean') {
      throw new Error('is_inline must be a boolean.');
    }
    patch.properties = {
      ...(database.properties ?? {}),
      ...('description' in body ? { notionDescription: richTextToPlainText(body.description) } : {}),
      ...('is_inline' in body ? { notionIsInline: body.is_inline } : {}),
    };
  }
  let updated = database;
  if (Object.keys(patch).length > 0) {
    const result = await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: 'update', id: database.id, workspaceId: database.workspaceId, patch,
    });
    updated = result.page as Page;
  }
  if (isRecord(body.parent)) {
    const destination = await resolveDatabaseParent(db, body, auth.id, auth.email, context.compatBearer);
    if (destination.workspaceId !== database.workspaceId) {
      throw new Error('Databases cannot be moved across workspaces.');
    }
    if (
      destination.parentId !== (updated.parentId ?? null)
      || destination.parentType !== (updated.parentType ?? 'workspace')
    ) {
      const moved = await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
        action: 'move',
        id: updated.id,
        workspaceId: updated.workspaceId,
        patch: { parentId: destination.parentId, parentType: destination.parentType },
      });
      updated = moved.page as Page;
    }
  }
  const trashRequested = 'in_trash' in body ? body.in_trash : undefined;
  if (trashRequested !== undefined && typeof trashRequested !== 'boolean') {
    throw new Error('in_trash must be a boolean.');
  }
  if (typeof trashRequested === 'boolean' && trashRequested !== updated.inTrash) {
    await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: trashRequested ? 'trash' : 'restore', id: updated.id, workspaceId: updated.workspaceId,
    });
    updated = await getExisting(db.table<Page>('pages'), updated.id) ?? { ...updated, inTrash: trashRequested };
  }
  // Legacy callers may still send a database-level property patch; current
  // Notion clients update schemas through /data_sources instead.
  await updateDatabaseSchema(
    context,
    db,
    updated,
    body,
    notionVersion(request) !== latestNotionVersion,
  );
  return notionDatabase(context, db, updated, request);
}

async function updateDataSourceEndpoint(context: FunctionContext, dataSourceId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const dataSource = await requireWritablePage(db, dataSourceId, auth.id, auth.email, context.compatBearer);
  if (dataSource.kind !== 'database') throw new Error('Data source was not found.');
  const patch: Partial<Page> = {};
  if ('title' in body) patch.title = richTextToPlainText(body.title) || dataSource.title || 'Untitled';
  if ('name' in body) patch.title = optionalString(body.name) || dataSource.title || 'Untitled';
  if ('icon' in body) {
    Object.assign(patch, await notionIconToLocal(context, db, dataSource.workspaceId, body.icon));
  }
  if ('cover' in body) {
    Object.assign(patch, await notionCoverToLocal(context, db, dataSource.workspaceId, body.cover));
  }
  if ('description' in body || 'is_inline' in body || isRecord(body.parent)) {
    if ('is_inline' in body && typeof body.is_inline !== 'boolean') {
      throw new Error('is_inline must be a boolean.');
    }
    let parentDatabaseId = dataSourceParentDatabaseId(dataSource);
    if (isRecord(body.parent)) {
      parentDatabaseId = requireString(
        body.parent.database_id ?? body.parent.data_source_id,
        'parent.database_id or parent.data_source_id',
      );
      const target = await requireWritablePage(
        db, parentDatabaseId, auth.id, auth.email, context.compatBearer,
      );
      if (target.kind !== 'database') throw new Error('Parent database was not found.');
      if (target.workspaceId !== dataSource.workspaceId) {
        throw new Error('Data sources cannot be moved across workspaces.');
      }
    }
    patch.properties = {
      ...(dataSource.properties ?? {}),
      notionParentDatabaseId: parentDatabaseId,
      ...('description' in body ? { notionDescription: richTextToPlainText(body.description) } : {}),
      ...('is_inline' in body ? { notionIsInline: body.is_inline } : {}),
    };
  }
  let updated = dataSource;
  if (Object.keys(patch).length > 0) {
    const result = await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: 'update', id: dataSource.id, workspaceId: dataSource.workspaceId, patch,
    });
    updated = result.page as Page;
  }
  const trashRequested = body.in_trash;
  if (trashRequested !== undefined && typeof trashRequested !== 'boolean') {
    throw new Error('in_trash must be a boolean.');
  }
  if (trashRequested !== undefined && trashRequested !== updated.inTrash) {
    await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
      action: trashRequested ? 'trash' : 'restore', id: dataSource.id, workspaceId: dataSource.workspaceId,
    });
    updated = await getExisting(db.table<Page>('pages'), dataSource.id) ?? { ...updated, inTrash: trashRequested };
  }
  const props = await updateDatabaseSchema(
    context,
    db,
    updated,
    body,
    notionVersion(request) !== latestNotionVersion,
  );
  return notionDataSource(context, db, updated, props, request);
}

async function trashDataSourceEndpoint(context: FunctionContext, dataSourceId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const dataSource = await requireWritablePage(db, dataSourceId, auth.id, auth.email, context.compatBearer);
  if (dataSource.kind !== 'database') throw new Error('Data source was not found.');
  await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
    action: 'trash', id: dataSource.id, workspaceId: dataSource.workspaceId,
  });
  const updated = await getExisting(db.table<Page>('pages'), dataSource.id) ?? { ...dataSource, inTrash: true };
  return notionDataSource(context, db, updated, await databaseProperties(db, updated.id), request);
}

function comparablePropertyValue(row: Page, prop: DbProperty) {
  const value = localValueForProperty(row, prop);
  const option = prop.type === 'select' || prop.type === 'status' ? findOption(prop, value) : null;
  if (option) return option.name;
  if (prop.type === 'multi_select' && Array.isArray(value)) {
    return value.map((item) => findOption(prop, item)?.name || item).join(' ');
  }
  if (Array.isArray(value)) return value.join(' ');
  if (value == null) return '';
  return value;
}

function comparableSortValue(row: Page, prop: DbProperty): string | number | boolean | null {
  const value = localValueForProperty(row, prop);
  if (value == null || value === '') return null;
  if (prop.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (prop.type === 'checkbox') return value === true;
  if (prop.type === 'date') return dateFilterValue(value) || null;
  if (prop.type === 'select' || prop.type === 'status') return findOption(prop, value)?.name ?? null;
  if (prop.type === 'multi_select' && Array.isArray(value)) {
    return value.map((item) => findOption(prop, item)?.name || String(item ?? '')).join(' ');
  }
  if (Array.isArray(value)) return value.join(' ');
  if (isRecord(value)) {
    const start = optionalString(value.start);
    if (start) return start;
    const name = optionalString(value.name);
    if (name) return name;
  }
  return typeof value === 'boolean' || typeof value === 'number' ? value : String(value);
}

const queryFilterOperators: Record<string, Set<string>> = {
  string: new Set(['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']),
  title: new Set(['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']),
  rich_text: new Set(['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']),
  url: new Set(['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']),
  email: new Set(['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']),
  phone_number: new Set(['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']),
  number: new Set(['equals', 'does_not_equal', 'greater_than', 'less_than', 'greater_than_or_equal_to', 'less_than_or_equal_to', 'is_empty', 'is_not_empty']),
  checkbox: new Set(['equals', 'does_not_equal']),
  select: new Set(['equals', 'does_not_equal', 'is_empty', 'is_not_empty']),
  status: new Set(['equals', 'does_not_equal', 'is_empty', 'is_not_empty']),
  multi_select: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  date: new Set(['equals', 'before', 'after', 'on_or_before', 'on_or_after', 'this_week', 'past_week', 'past_month', 'past_year', 'next_week', 'next_month', 'next_year', 'is_empty', 'is_not_empty']),
  created_time: new Set(['equals', 'before', 'after', 'on_or_before', 'on_or_after', 'this_week', 'past_week', 'past_month', 'past_year', 'next_week', 'next_month', 'next_year', 'is_empty', 'is_not_empty']),
  last_edited_time: new Set(['equals', 'before', 'after', 'on_or_before', 'on_or_after', 'this_week', 'past_week', 'past_month', 'past_year', 'next_week', 'next_month', 'next_year', 'is_empty', 'is_not_empty']),
  people: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  created_by: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  last_edited_by: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  relation: new Set(['contains', 'does_not_contain', 'is_empty', 'is_not_empty']),
  files: new Set(['is_empty', 'is_not_empty']),
  unique_id: new Set(['equals', 'does_not_equal', 'greater_than', 'less_than', 'greater_than_or_equal_to', 'less_than_or_equal_to', 'is_empty', 'is_not_empty']),
};

const relativeDateValues = new Set([
  'today', 'tomorrow', 'yesterday', 'one_week_ago', 'one_week_from_now',
  'one_month_ago', 'one_month_from_now',
]);

const rollupSubfilterTypes = new Set([
  'rich_text', 'number', 'checkbox', 'select', 'multi_select', 'relation',
  'date', 'people', 'files', 'status',
]);

function validateQueryCondition(type: string, condition: unknown) {
  if (!isRecord(condition)) throw new Error(`${type} filter must be an object.`);
  const operators = Object.keys(condition);
  if (operators.length !== 1) throw new Error(`${type} filter must contain exactly one operator.`);
  const operator = operators[0];
  if (!queryFilterOperators[type]?.has(operator)) {
    throw new Error(`Unsupported ${type} filter operator: ${operator}.`);
  }
  const expected = condition[operator];
  if (operator === 'is_empty' || operator === 'is_not_empty') {
    if (expected !== true) throw new Error(`${operator} must be true.`);
  } else if (['this_week', 'past_week', 'past_month', 'past_year', 'next_week', 'next_month', 'next_year'].includes(operator)) {
    if (!isRecord(expected) || Object.keys(expected).length > 0) {
      throw new Error(`${operator} must be an empty object.`);
    }
  } else if (type === 'number' || type === 'unique_id') {
    if (typeof expected !== 'number' || !Number.isFinite(expected)) throw new Error(`${operator} must be a number.`);
  } else if (type === 'checkbox') {
    if (typeof expected !== 'boolean') throw new Error(`${operator} must be a boolean.`);
  } else if (type === 'select' || type === 'status' || type === 'multi_select') {
    if (!(typeof expected === 'string' || (Array.isArray(expected) && expected.every((item) => typeof item === 'string')))) {
      throw new Error(`${operator} must be a string or string array.`);
    }
  } else if (type === 'date' || type === 'created_time' || type === 'last_edited_time') {
    if (typeof expected !== 'string'
      || (!relativeDateValues.has(expected) && !/^\d{4}-\d{2}-\d{2}$/.test(expected))) {
      throw new Error(`${operator} must be an ISO date or supported relative date.`);
    }
  } else if (typeof expected !== 'string') {
    throw new Error(`${operator} must be a string.`);
  }
}

function validateFormulaFilter(condition: unknown) {
  if (!isRecord(condition) || Object.keys(condition).length !== 1) {
    throw new Error('formula filter must contain exactly one result type.');
  }
  const type = Object.keys(condition)[0];
  if (!['string', 'checkbox', 'number', 'date'].includes(type)) {
    throw new Error(`Unsupported formula filter result type: ${type}.`);
  }
  validateQueryCondition(type, condition[type]);
}

function validateRollupFilter(condition: unknown) {
  if (!isRecord(condition) || Object.keys(condition).length !== 1) {
    throw new Error('rollup filter must contain exactly one operator.');
  }
  const operator = Object.keys(condition)[0];
  if (operator === 'date' || operator === 'number') {
    validateQueryCondition(operator, condition[operator]);
    return;
  }
  if (!['any', 'none', 'every'].includes(operator)) {
    throw new Error(`Unsupported rollup filter operator: ${operator}.`);
  }
  const subfilter = condition[operator];
  if (!isRecord(subfilter) || Object.keys(subfilter).length !== 1) {
    throw new Error(`rollup.${operator} must contain exactly one property type.`);
  }
  const type = Object.keys(subfilter)[0];
  if (!rollupSubfilterTypes.has(type)) {
    throw new Error(`Unsupported rollup subfilter type: ${type}.`);
  }
  validateQueryCondition(type, subfilter[type]);
}

function validateVerificationFilter(condition: unknown) {
  if (!isRecord(condition)) throw new Error('verification filter must be an object.');
  assertOnlyKeys(condition, ['status'], 'verification filter');
  if (condition.status !== 'verified' && condition.status !== 'expired' && condition.status !== 'none') {
    throw new Error('verification.status must be verified, expired, or none.');
  }
}

function validateDataSourceFilter(filter: unknown, props: DbProperty[], depth = 0): void {
  if (filter === undefined) return;
  if (!isRecord(filter)) throw new Error('filter must be an object.');
  const groups = ['and', 'or'].filter((key) => filter[key] !== undefined);
  if (groups.length > 0) {
    if (groups.length !== 1 || Object.keys(filter).length !== 1) {
      throw new Error('A compound filter must contain exactly one of and or or.');
    }
    if (depth >= 2) throw new Error('Compound filters may be nested at most two levels.');
    const children = filter[groups[0]];
    if (!Array.isArray(children) || children.length > 100) {
      throw new Error(`${groups[0]} must be an array with at most 100 filters.`);
    }
    for (const child of children) validateDataSourceFilter(child, props, depth + 1);
    return;
  }
  const timestamp = optionalString(filter.timestamp);
  if (timestamp) {
    if (timestamp !== 'created_time' && timestamp !== 'last_edited_time') {
      throw new Error('timestamp must be created_time or last_edited_time.');
    }
    if (filter.type !== undefined && filter.type !== timestamp) {
      throw new Error(`filter.type must be ${timestamp}.`);
    }
    assertOnlyKeys(filter, ['timestamp', 'type', timestamp], 'timestamp filter');
    validateQueryCondition(timestamp, filter[timestamp]);
    return;
  }
  const propertyName = requireString(filter.property, 'filter.property');
  const prop = propByNameOrId(props, propertyName);
  if (!prop) throw new Error(`Unknown filter property: ${propertyName}.`);
  const type = propertyNotionType(prop.type);
  if (!queryFilterOperators[type] && type !== 'formula' && type !== 'rollup' && type !== 'verification') {
    throw new Error(`Filtering property type ${type} is not supported.`);
  }
  if (filter.type !== undefined && filter.type !== type) {
    throw new Error(`filter.type must be ${type}.`);
  }
  assertOnlyKeys(filter, ['property', 'type', type], 'property filter');
  if (type === 'formula') validateFormulaFilter(filter.formula);
  else if (type === 'rollup') validateRollupFilter(filter.rollup);
  else if (type === 'verification') validateVerificationFilter(filter.verification);
  else validateQueryCondition(type, filter[type]);
}

function storedViewFilterIsUsable(filter: unknown, props: DbProperty[]) {
  if (filter == null) return true;
  try {
    validateDataSourceFilter(filter, props);
    return true;
  } catch {
    return false;
  }
}

function emptyFilterValue(value: unknown) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function dateFilterValue(value: unknown) {
  if (isRecord(value)) return optionalString(value.start) || '';
  return typeof value === 'string' ? value : '';
}

function expectedList(value: unknown, actorId: string) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item === 'me' ? actorId : String(item ?? ''));
}

function utcDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftedUtcDate(days = 0, months = 0, years = 0) {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  if (years) value.setUTCFullYear(value.getUTCFullYear() + years);
  if (months) value.setUTCMonth(value.getUTCMonth() + months);
  if (days) value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function resolvedRelativeDate(value: string) {
  if (value === 'today') return utcDateKey(shiftedUtcDate());
  if (value === 'tomorrow') return utcDateKey(shiftedUtcDate(1));
  if (value === 'yesterday') return utcDateKey(shiftedUtcDate(-1));
  if (value === 'one_week_ago') return utcDateKey(shiftedUtcDate(-7));
  if (value === 'one_week_from_now') return utcDateKey(shiftedUtcDate(7));
  if (value === 'one_month_ago') return utcDateKey(shiftedUtcDate(0, -1));
  if (value === 'one_month_from_now') return utcDateKey(shiftedUtcDate(0, 1));
  return value;
}

function relativeCalendarMatch(actualDate: string, operator: string) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(actualDate)) return false;
  const actual = new Date(`${actualDate.slice(0, 10)}T00:00:00.000Z`).getTime();
  const today = shiftedUtcDate();
  const start = new Date(today);
  let end = new Date(today);
  if (operator === 'this_week') {
    const mondayOffset = (today.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
  } else if (operator === 'past_week' || operator === 'next_week') {
    if (operator === 'past_week') start.setUTCDate(start.getUTCDate() - 7);
    else end.setUTCDate(end.getUTCDate() + 7);
  } else if (operator === 'past_month' || operator === 'next_month') {
    if (operator === 'past_month') start.setUTCMonth(start.getUTCMonth() - 1);
    else end.setUTCMonth(end.getUTCMonth() + 1);
  } else if (operator === 'past_year' || operator === 'next_year') {
    if (operator === 'past_year') start.setUTCFullYear(start.getUTCFullYear() - 1);
    else end.setUTCFullYear(end.getUTCFullYear() + 1);
  }
  return actual >= start.getTime() && actual < end.getTime();
}

function filterValueMatches(actual: unknown, type: string, condition: Record<string, unknown>, actorId: string) {
  const [operator, expected] = Object.entries(condition)[0];
  if (operator === 'is_empty') return emptyFilterValue(actual);
  if (operator === 'is_not_empty') return !emptyFilterValue(actual);
  const actualItems = Array.isArray(actual) ? actual.map((item) => String(isRecord(item) ? item.id ?? item.name ?? '' : item)) : [];
  const actualText = type === 'date' || type.endsWith('_time')
    ? dateFilterValue(actual)
    : actual == null
      ? ''
      : String(actual);
  const expectedItems = expectedList(expected, actorId);
  if (['this_week', 'past_week', 'past_month', 'past_year', 'next_week', 'next_month', 'next_year'].includes(operator)) {
    return relativeCalendarMatch(actualText, operator);
  }
  const expectedText = type === 'date' || type.endsWith('_time')
    ? resolvedRelativeDate(expectedItems[0])
    : expectedItems[0];
  if (operator === 'contains' || operator === 'does_not_contain') {
    const contains = expectedItems.length > 0 && (
      actualItems.length > 0
        ? expectedItems.some((item) => actualItems.includes(item))
        : actualText.toLowerCase().includes(expectedText.toLowerCase())
    );
    return operator === 'contains' ? contains : !contains;
  }
  if (operator === 'equals' || operator === 'does_not_equal') {
    const equals = type === 'checkbox'
      ? actual === expected
      : type === 'number'
        ? Number(actual) === Number(expected)
        : type === 'date' || type.endsWith('_time')
          ? actualText.slice(0, 10) === expectedText
          : expectedItems.includes(actualText);
    return operator === 'equals' ? equals : !equals;
  }
  if (operator === 'starts_with') return actualText.toLowerCase().startsWith(expectedText.toLowerCase());
  if (operator === 'ends_with') return actualText.toLowerCase().endsWith(expectedText.toLowerCase());
  if (operator === 'greater_than') return Number(actual) > Number(expected);
  if (operator === 'less_than') return Number(actual) < Number(expected);
  if (operator === 'greater_than_or_equal_to') return Number(actual) >= Number(expected);
  if (operator === 'less_than_or_equal_to') return Number(actual) <= Number(expected);
  if (operator === 'before') return actualText.slice(0, 10) < expectedText;
  if (operator === 'after') return actualText.slice(0, 10) > expectedText;
  if (operator === 'on_or_before') return actualText.slice(0, 10) <= expectedText;
  if (operator === 'on_or_after') return actualText.slice(0, 10) >= expectedText;
  return false;
}

function rollupItemValue(item: unknown, type: string) {
  if (!isRecord(item)) return item;
  if (type in item) return item[type];
  if (type === 'rich_text') {
    return optionalString(item.plain_text) ?? optionalString(item.text) ?? item;
  }
  if (type === 'people' || type === 'relation') return optionalString(item.id) ?? item;
  if (type === 'select' || type === 'status' || type === 'multi_select') {
    return optionalString(item.name) ?? item;
  }
  return item;
}

function structuredFilterMatches(
  actual: unknown,
  type: string,
  condition: Record<string, unknown>,
  actorId: string,
) {
  if (type === 'formula') {
    const resultType = Object.keys(condition)[0];
    return filterValueMatches(
      actual,
      resultType === 'string' ? 'rich_text' : resultType,
      condition[resultType] as Record<string, unknown>,
      actorId,
    );
  }
  if (type === 'rollup') {
    const operator = Object.keys(condition)[0];
    if (operator === 'date' || operator === 'number') {
      return filterValueMatches(
        actual,
        operator,
        condition[operator] as Record<string, unknown>,
        actorId,
      );
    }
    const subfilter = condition[operator] as Record<string, unknown>;
    const resultType = Object.keys(subfilter)[0];
    const items = Array.isArray(actual) ? actual : [];
    const matches = (item: unknown) => filterValueMatches(
      rollupItemValue(item, resultType),
      resultType,
      subfilter[resultType] as Record<string, unknown>,
      actorId,
    );
    if (operator === 'any') return items.some(matches);
    if (operator === 'none') return items.every((item) => !matches(item));
    return items.every(matches);
  }
  if (type === 'verification') {
    const state = isRecord(actual) ? optionalString(actual.state) : null;
    const normalized = state === 'verified' || state === 'expired' ? state : 'none';
    return normalized === condition.status;
  }
  return filterValueMatches(actual, type, condition, actorId);
}

function statusFilterMatches(
  row: Page,
  prop: DbProperty,
  condition: Record<string, unknown>,
  actorId: string,
) {
  const [operator, expected] = Object.entries(condition)[0];
  const option = findOption(prop, localValueForProperty(row, prop));
  const optionName = option?.name ?? '';
  if (operator === 'is_empty' || operator === 'is_not_empty') {
    return filterValueMatches(optionName, 'status', condition, actorId);
  }
  const expectedValues = expectedList(expected, actorId);
  const groupName = statusGroupForOption(prop, option);
  const equals = expectedValues.includes(optionName)
    || (groupName !== undefined && expectedValues.includes(groupName));
  return operator === 'equals' ? equals : !equals;
}

function rowMatchesFilter(row: Page, props: DbProperty[], filter: unknown, actorId: string): boolean {
  if (!isRecord(filter)) return true;
  if (Array.isArray(filter.and)) return filter.and.every((item) => rowMatchesFilter(row, props, item, actorId));
  if (Array.isArray(filter.or)) return filter.or.some((item) => rowMatchesFilter(row, props, item, actorId));
  const timestamp = optionalString(filter.timestamp);
  if (timestamp === 'created_time' || timestamp === 'last_edited_time') {
    return filterValueMatches(
      timestamp === 'created_time' ? row.createdAt : row.updatedAt,
      timestamp,
      filter[timestamp] as Record<string, unknown>,
      actorId,
    );
  }
  const propertyName = optionalString(filter.property)!;
  const prop = propByNameOrId(props, propertyName)!;
  const type = propertyNotionType(prop.type);
  if (type === 'status') {
    return statusFilterMatches(row, prop, filter.status as Record<string, unknown>, actorId);
  }
  let actual: unknown = comparablePropertyValue(row, prop);
  if (
    type === 'checkbox' || type === 'number' || type === 'date' || type === 'relation'
    || type === 'people' || type === 'files' || type === 'formula' || type === 'rollup'
    || type === 'unique_id' || type === 'verification'
  ) {
    actual = localValueForProperty(row, prop);
  } else if (type === 'multi_select') {
    const raw = localValueForProperty(row, prop);
    actual = Array.isArray(raw)
      ? raw.map((item) => findOption(prop, item)?.name || String(item ?? ''))
      : [];
  }
  return structuredFilterMatches(actual, type, filter[type] as Record<string, unknown>, actorId);
}

function validateDataSourceSorts(sorts: unknown, props: DbProperty[]) {
  if (sorts === undefined) return;
  if (!Array.isArray(sorts) || sorts.length > 100) {
    throw new Error('sorts must be an array with at most 100 items.');
  }
  for (const sort of sorts) {
    if (!isRecord(sort)) throw new Error('Each sort must be an object.');
    if (sort.direction !== 'ascending' && sort.direction !== 'descending') {
      throw new Error('sort.direction must be ascending or descending.');
    }
    const propertyName = optionalString(sort.property);
    const timestamp = optionalString(sort.timestamp);
    if (!!propertyName === !!timestamp) throw new Error('Each sort requires exactly one of property or timestamp.');
    if (propertyName && !propByNameOrId(props, propertyName)) {
      throw new Error(`Unknown sort property: ${propertyName}.`);
    }
    if (timestamp && timestamp !== 'created_time' && timestamp !== 'last_edited_time') {
      throw new Error('sort.timestamp must be created_time or last_edited_time.');
    }
    assertOnlyKeys(sort, propertyName ? ['property', 'direction'] : ['timestamp', 'direction'], 'sort');
  }
}

const CANONICAL_CREATED_TIME_SORT_ID = '__hanji_database_rows_created_time';
const CANONICAL_LAST_EDITED_TIME_SORT_ID = '__hanji_database_rows_last_edited_time';

function canonicalDatabaseRowSorts(
  sorts: unknown,
  props: DbProperty[],
): Array<{ propertyId: string; direction: 'asc' | 'desc' }> | undefined {
  if (!Array.isArray(sorts) || sorts.length === 0) return undefined;
  return sorts.map((sort) => {
    const record = sort as Record<string, unknown>;
    const direction = record.direction === 'descending' || record.direction === 'desc' ? 'desc' : 'asc';
    const timestamp = optionalString(record.timestamp);
    if (timestamp === 'created_time') {
      return { propertyId: CANONICAL_CREATED_TIME_SORT_ID, direction };
    }
    if (timestamp === 'last_edited_time') {
      return { propertyId: CANONICAL_LAST_EDITED_TIME_SORT_ID, direction };
    }
    const propertyId = optionalString(record.propertyId);
    if (propertyId && props.some((property) => property.id === propertyId)) {
      return { propertyId, direction };
    }
    const propertyName = optionalString(record.property)!;
    return { propertyId: propByNameOrId(props, propertyName)!.id, direction };
  });
}

function sortRows(rows: Page[], props: DbProperty[], sorts: unknown) {
  if (!Array.isArray(sorts) || sorts.length === 0) return rows;
  return rows.slice().sort((a, b) => {
    for (const sort of sorts) {
      if (!isRecord(sort)) continue;
      const direction = sort.direction === 'descending' ? -1 : 1;
      if (typeof sort.timestamp === 'string') {
        const left = sort.timestamp === 'created_time' ? a.createdAt ?? '' : a.updatedAt ?? '';
        const right = sort.timestamp === 'created_time' ? b.createdAt ?? '' : b.updatedAt ?? '';
        if (left !== right) return left < right ? -direction : direction;
      }
      const propertyName = optionalString(sort.property);
      const prop = propertyName ? propByNameOrId(props, propertyName) : undefined;
      if (!prop) continue;
      const left = comparableSortValue(a, prop);
      const right = comparableSortValue(b, prop);
      if (left == null || right == null) {
        if (left !== right) return left == null ? direction : -direction;
        continue;
      }
      if (left !== right) {
        if (typeof left === 'number' && typeof right === 'number') {
          return left < right ? -direction : direction;
        }
        if (typeof left === 'boolean' && typeof right === 'boolean') {
          return Number(left) < Number(right) ? -direction : direction;
        }
        const compared = String(left).localeCompare(String(right));
        if (compared !== 0) return compared * direction;
      }
    }
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

async function dataSourceRowsPageForQuery(
  context: FunctionContext,
  databaseId: string,
  props: DbProperty[],
  options: {
    cursor?: string;
    limit: number;
    sorts?: Array<{ propertyId: string; direction: 'asc' | 'desc' }>;
    cursorScope?: string;
    rowId?: string;
  },
) {
  const includeComputed = props.some((prop) => prop.type === 'formula' || prop.type === 'rollup');
  const payload = await callProductMutation(pageQueryPOST as FunctionDefinition, context, {
    action: 'databaseRows',
    databaseId,
    includeTrash: true,
    includeComputed,
    limit: options.limit,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.sorts ? { databaseRowsSorts: options.sorts } : {}),
    ...(options.cursorScope ? { databaseRowsCursorScope: options.cursorScope } : {}),
    ...(options.rowId ? { rowId: options.rowId } : {}),
  });
  const batch = Array.isArray(payload.rows) ? payload.rows as Page[] : [];
  const computed = isRecord(payload.computed) ? payload.computed : {};
  const rows = batch.map((row) => ({
    ...row,
    ...(isRecord(computed[row.id])
      ? { __computed: computed[row.id] as Page['__computed'] }
      : {}),
  }));
  const hasMore = payload.hasMore === true;
  const nextCursor = optionalString(payload.nextCursor);
  if (hasMore && !nextCursor) {
    throw Object.assign(new Error('Canonical database query returned an invalid cursor.'), { status: 500 });
  }
  return {
    rows: await enrichNotionRollupArrayValues(context, rows, props, databaseId),
    hasMore,
    nextCursor,
  };
}

async function enrichNotionRollupArrayValues(
  context: FunctionContext,
  rows: Page[],
  props: DbProperty[],
  databaseId: string,
) {
  const arrayRollups = props.filter((prop) => {
    if (prop.type !== 'rollup') return false;
    const fn = officialRollupFunction(prop.config?.rollupFunction);
    return fn === 'show_original' || fn === 'show_unique';
  });
  if (arrayRollups.length === 0 || rows.length === 0) return rows;
  const db = await boundedDbFromPageHint(context.admin, databaseId);
  const targetProps = new Map<string, DbProperty | null>();
  const relatedPages = new Map<string, Page>();
  for (const prop of arrayRollups) {
    const targetId = optionalString(prop.config?.rollupTargetPropertyId);
    if (targetId && !targetProps.has(targetId)) {
      targetProps.set(targetId, await getExisting(db.table<DbProperty>('db_properties'), targetId));
    }
    const relationId = optionalString(prop.config?.rollupRelationPropertyId);
    for (const row of rows) {
      for (const relatedId of relationId ? normalizeIdArray(row.properties?.[relationId]) : []) {
        if (!relatedPages.has(relatedId)) {
          relatedPages.set(relatedId, await requireReadablePage(
            db,
            relatedId,
            context.auth!.id,
            context.auth?.email,
            context.compatBearer,
          ));
        }
      }
    }
  }
  return rows.map((row) => {
    const computed = { ...(row.__computed ?? {}) };
    for (const prop of arrayRollups) {
      const relationId = optionalString(prop.config?.rollupRelationPropertyId);
      const targetId = optionalString(prop.config?.rollupTargetPropertyId);
      const targetProp = targetId ? targetProps.get(targetId) : null;
      if (!relationId || !targetProp) continue;
      let values = normalizeIdArray(row.properties?.[relationId])
        .map((id) => relatedPages.get(id))
        .filter((page): page is Page => !!page)
        .map((page) => {
          const value = { ...notionPropertyValue(page, targetProp) } as Record<string, unknown>;
          delete value.id;
          delete value.has_more;
          return value;
        });
      if (officialRollupFunction(prop.config?.rollupFunction) === 'show_unique') {
        values = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
      }
      computed[prop.id] = {
        ...(computed[prop.id] ?? { formatted: '' }),
        value: values,
      };
    }
    return { ...row, __computed: computed };
  });
}

async function pageWithComputedProperties(
  context: FunctionContext,
  page: Page,
  props: DbProperty[],
) {
  let enriched = page;
  if (page.parentType === 'database' && page.parentId
    && props.some((prop) => prop.type === 'formula' || prop.type === 'rollup')) {
    enriched = (await dataSourceRowsPageForQuery(context, page.parentId, props, {
      rowId: page.id,
      limit: 1,
    })).rows[0] ?? page;
  }
  return refreshNotionPageFiles(
    context,
    context.admin.db('workspace', enriched.workspaceId),
    enriched,
    props,
  );
}

async function refreshNotionPageFiles(
  context: FunctionContext,
  db: DbRef,
  page: Page,
  props: DbProperty[],
) {
  let changed = false;
  let properties = page.properties;
  for (const prop of props.filter((candidate) => candidate.type === 'files')) {
    const files = page.properties?.[prop.id];
    if (!Array.isArray(files)) continue;
    const refreshed: unknown[] = [];
    for (const file of files) {
      if (!isRecord(file) || file.notionFileSource !== 'file') {
        refreshed.push(file);
        continue;
      }
      const uploadId = optionalString(file.notionFileUploadId)
        || requireString(file.fileUploadId, `Stored file property ${prop.name}.fileUploadId`);
      const upload = await getExisting(db.table<FileUpload>('file_uploads'), uploadId);
      if (!upload || upload.workspaceId !== page.workspaceId || upload.status !== 'uploaded') {
        throw new Error('Stored file upload was not found or is no longer available.');
      }
      const signed = await freshNotionUploadedFile(context, upload);
      refreshed.push({
        ...file,
        name: optionalString(file.name) || upload.name || 'Untitled',
        url: (signed.file as { url: string }).url,
        expiryTime: (signed.file as { expiry_time: string }).expiry_time,
      });
      changed = true;
    }
    if (changed) properties = { ...(properties ?? {}), [prop.id]: refreshed };
  }

  let notionIcon = page.notionIcon;
  let notionCover = page.notionCover;
  for (const field of ['notionIcon', 'notionCover'] as const) {
    const asset = field === 'notionIcon' ? notionIcon : notionCover;
    const uploadId = isRecord(asset) ? optionalString(asset.fileUploadId) : undefined;
    if (!uploadId) continue;
    const upload = await getExisting(db.table<FileUpload>('file_uploads'), uploadId);
    if (!upload || upload.workspaceId !== page.workspaceId || upload.status !== 'uploaded') {
      throw new Error('Stored page asset upload was not found or is no longer available.');
    }
    const refreshed = { ...await freshNotionUploadedFile(context, upload), fileUploadId: upload.id };
    if (field === 'notionIcon') notionIcon = refreshed;
    else notionCover = refreshed;
    changed = true;
  }
  return changed ? { ...page, properties, notionIcon, notionCover } : page;
}

async function queryDataSourceEndpoint(context: FunctionContext, dataSourceId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  assertOnlyKeys(
    body,
    ['sorts', 'filter', 'start_cursor', 'page_size', 'is_archived', 'result_type'],
    'data source query',
  );
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireReadablePage(db, dataSourceId, auth.id, auth.email, context.compatBearer);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const props = await databaseProperties(db, database.id);
  validateDataSourceFilter(body.filter, props);
  validateDataSourceSorts(body.sorts, props);
  if (body.is_archived !== undefined && typeof body.is_archived !== 'boolean') {
    throw new Error('is_archived must be a boolean.');
  }
  if (body.result_type !== undefined && body.result_type !== 'page' && body.result_type !== 'data_source') {
    throw new Error('result_type must be page or data_source.');
  }
  if (body.start_cursor !== undefined && typeof body.start_cursor !== 'string') {
    throw new Error('start_cursor must be a string.');
  }
  if (body.page_size !== undefined && (
    typeof body.page_size !== 'number'
    || !Number.isInteger(body.page_size)
    || body.page_size < 1
    || body.page_size > 100
  )) {
    throw new Error('page_size must be an integer between 1 and 100.');
  }
  if (body.result_type === 'data_source') return listObject([], 'page_or_data_source', {});
  const archivedPartition = body.is_archived === true;
  const size = notionPageSize(body.page_size);
  const cursor = notionStringCursor(body.start_cursor);
  const page = await dataSourceRowsPageForQuery(context, database.id, props, {
    ...(cursor ? { cursor } : {}),
    limit: size,
    sorts: canonicalDatabaseRowSorts(body.sorts, props),
    cursorScope: JSON.stringify({
      v: 1,
      filter: body.filter ?? null,
      isArchived: archivedPartition,
    }),
  });
  const windowed = page.rows
    .filter((row) => (row.inTrash === true) === archivedPartition
      && rowMatchesFilter(row, props, body.filter, auth.id));
  const filterProperties = new URL(request.url).searchParams.getAll('filter_properties');
  const selectedProps = filterProperties.length > 0
    ? props.filter((prop) => filterProperties.includes(prop.id))
    : props;
  const results = await Promise.all(windowed.map(async (row) => notionPage(
    await refreshNotionPageFiles(context, db, row, selectedProps),
    selectedProps,
    request,
  )));
  return {
    object: 'list',
    results,
    next_cursor: page.hasMore ? page.nextCursor : null,
    has_more: page.hasMore,
    type: 'page_or_data_source',
    page_or_data_source: {},
  };
}

async function listTemplatesEndpoint(context: FunctionContext, dataSourceId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireReadablePage(db, dataSourceId, auth.id, auth.email, context.compatBearer);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const url = new URL(request.url);
  const cursor = notionStringCursor(url.searchParams.get('start_cursor'));
  const size = notionPageSize(url.searchParams.get('page_size'));
  const templates = (await listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', database.id)))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))
    .map((template) => ({
      id: template.id,
      name: template.name,
      is_default: template.isDefault === true,
    }));
  let start = 0;
  if (cursor) {
    const index = templates.findIndex((template) => template.id === cursor);
    if (index < 0) throw new Error('start_cursor is invalid.');
    start = index + 1;
  }
  const windowed = templates.slice(start, start + size);
  const hasMore = start + windowed.length < templates.length;
  return {
    templates: windowed,
    has_more: hasMore,
    next_cursor: hasMore && windowed.length > 0 ? windowed[windowed.length - 1].id : null,
  };
}

const notionViewMetadataKey = '__notionCompat';

const notionViewConfigRequiredFields: Partial<Record<string, readonly string[]>> = {
  board: ['group_by'],
  calendar: ['date_property_id'],
  timeline: ['date_property_id'],
  chart: ['chart_type'],
};

function validateNotionViewConfiguration(value: unknown, type: string) {
  if (!isRecord(value)) throw new Error('configuration must be an object.');
  if (value.type !== type) throw new Error(`configuration.type must match view type ${type}.`);
  if (type === 'dashboard') {
    throw new Error('Dashboard views do not accept a presentation configuration.');
  }
  for (const key of notionViewConfigRequiredFields[type] ?? []) {
    if (value[key] === undefined || value[key] === null || value[key] === '') {
      throw new Error(`configuration.${key} is required for a ${type} view.`);
    }
  }
  for (const key of ['properties', 'table_properties', 'reference_lines']) {
    const field = value[key];
    if (field !== undefined && field !== null && (!Array.isArray(field) || field.length > 100)) {
      throw new Error(`configuration.${key} must be an array with at most 100 items or null.`);
    }
  }
  const enums: Record<string, readonly string[]> = {
    cover_size: ['small', 'medium', 'large'],
    cover_aspect: ['contain', 'cover'],
    card_layout: ['list', 'compact'],
    view_range: ['week', 'month'],
    height: ['small', 'medium', 'large', 'extra_large'],
    submission_permissions: ['none', 'comment_only', 'reader', 'read_and_write', 'editor'],
    chart_type: ['column', 'bar', 'line', 'donut', 'number'],
    sort: ['manual', 'x_ascending', 'x_descending', 'y_ascending', 'y_descending'],
    color_theme: ['gray', 'blue', 'yellow', 'green', 'purple', 'teal', 'orange', 'pink', 'red', 'auto', 'colorful'],
    legend_position: ['off', 'bottom', 'side'],
    axis_labels: ['none', 'x_axis', 'y_axis', 'both'],
    grid_lines: ['none', 'horizontal', 'vertical', 'both'],
    group_style: ['normal', 'percent', 'side_by_side'],
    donut_labels: ['none', 'value', 'name', 'name_and_value'],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    const field = value[key];
    if (field !== undefined && field !== null && !allowed.includes(String(field))) {
      throw new Error(`configuration.${key} must be one of: ${allowed.join(', ')}.`);
    }
  }
  return { ...value };
}

function boardMainGroupPropertyId(
  configuration: Record<string, unknown>,
  properties: DbProperty[],
) {
  const group = configuration.group_by;
  if (!isRecord(group)) throw new Error('configuration.group_by must be an object.');
  const propertyId = requireString(group.property_id, 'configuration.group_by.property_id');
  const property = properties.find((candidate) => candidate.id === propertyId);
  if (!property) throw new Error('configuration.group_by.property_id was not found in the data source.');
  if (!isHanjiBoardMainGroupPropertyType(property.type)) {
    const allowed = HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES;
    throw new Error(
      `configuration.group_by must use ${allowed.slice(0, -1).join(', ')}, or ${allowed.at(-1)} properties.`,
    );
  }
  const officialType = notionBoardMainGroupPropertyType(property.type);
  if (group.type !== officialType) {
    throw new Error(`configuration.group_by.type must be ${officialType} for property ${propertyId}.`);
  }
  return propertyId;
}

function notionViewMetadata(config: Record<string, unknown> | undefined) {
  return isRecord(config?.[notionViewMetadataKey])
    ? config![notionViewMetadataKey] as Record<string, unknown>
    : {};
}

function applyNotionViewUpdate(
  currentConfig: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
  type: string,
  creating = false,
  properties: DbProperty[] = [],
) {
  const config = { ...(currentConfig ?? {}) };
  const metadata = { ...notionViewMetadata(currentConfig) };
  if ('configuration' in body) {
    if (body.configuration == null) throw new Error('configuration must be an object.');
    const requested = validateNotionViewConfiguration(body.configuration, type);
    {
      const previous = isRecord(metadata.configuration) ? metadata.configuration : {};
      metadata.configuration = creating ? requested : { ...previous, ...requested };
      Object.assign(config, requested);
      if (type === 'board') config.groupBy = boardMainGroupPropertyId(requested, properties);
    }
  } else if (creating) {
    metadata.configuration = type === 'dashboard' ? { type: 'dashboard', rows: [] } : null;
  }
  if ('filter' in body) {
    if (body.filter !== null && !isRecord(body.filter)) {
      throw new Error('filter must be an object or null.');
    }
    metadata.filter = body.filter ?? null;
  } else if (creating) {
    metadata.filter = null;
  }
  if ('sorts' in body) {
    if (body.sorts !== null && (!Array.isArray(body.sorts) || body.sorts.length > 100)) {
      throw new Error('sorts must be an array with at most 100 items or null.');
    }
    metadata.sorts = body.sorts ?? null;
  } else if (creating) {
    metadata.sorts = null;
  }
  if ('quick_filters' in body) {
    if (body.quick_filters == null) {
      metadata.quick_filters = null;
    } else {
      if (!isRecord(body.quick_filters)) throw new Error('quick_filters must be an object or null.');
      const previous = isRecord(metadata.quick_filters) ? metadata.quick_filters : {};
      const next = creating ? {} as Record<string, unknown> : { ...previous };
      for (const [propertyId, condition] of Object.entries(body.quick_filters)) {
        if (condition == null) delete next[propertyId];
        else next[propertyId] = condition;
      }
      metadata.quick_filters = next;
    }
  } else if (creating) {
    metadata.quick_filters = null;
  }
  config[notionViewMetadataKey] = metadata;
  return normalizeDatabaseViewStorageRecord({ type, config }).config as Record<string, unknown>;
}

function notionView(view: DbView, request: Request, parentDatabaseId = view.databaseId) {
  const metadata = notionViewMetadata(view.config);
  const origin = new URL(request.url).origin;
  const createdTime = view.createdAt ?? view.updatedAt ?? new Date(0).toISOString();
  const lastEditedTime = view.updatedAt ?? createdTime;
  return {
    object: 'view',
    id: view.id,
    parent: { type: 'database_id', database_id: parentDatabaseId },
    data_source_id: view.type === 'dashboard' ? null : view.databaseId,
    name: view.name,
    type: view.type,
    created_time: createdTime,
    last_edited_time: lastEditedTime,
    url: `${origin}/?database=${encodeURIComponent(view.databaseId)}&view=${encodeURIComponent(view.id)}`,
    created_by: null,
    last_edited_by: null,
    filter: metadata.filter ?? null,
    sorts: metadata.sorts ?? null,
    quick_filters: metadata.quick_filters ?? null,
    configuration: metadata.configuration ?? null,
    ...(typeof metadata.dashboard_view_id === 'string'
      ? { dashboard_view_id: metadata.dashboard_view_id }
      : {}),
  };
}

async function listViewsEndpoint(context: FunctionContext, dataSourceId: string, referencesOnly = false) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireReadablePage(db, dataSourceId, auth.id, auth.email, context.compatBearer);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const url = new URL(request.url);
  const start = cursorOffset(url.searchParams.get('start_cursor'));
  const size = pageSize(url.searchParams.get('page_size'));
  const views = (await listAll(db.table<DbView>('db_views').where('databaseId', '==', database.id)))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((view) => referencesOnly
      ? { object: 'view', id: view.id }
      : notionView(view, request, dataSourceParentDatabaseId(database)));
  return listObject(views, 'view', {}, start, size);
}

async function getViewEndpoint(context: FunctionContext, viewId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbView>(context, 'db_views', viewId);
  if (!routed) throw new Error('View was not found.');
  await requireReadablePage(routed.db, routed.record.databaseId, auth.id, auth.email, context.compatBearer);
  const dataSource = await getExisting(routed.db.table<Page>('pages'), routed.record.databaseId);
  return notionView(
    routed.record,
    request,
    dataSource ? dataSourceParentDatabaseId(dataSource) : routed.record.databaseId,
  );
}

function nextViewPosition(views: DbView[], requested: unknown) {
  const sorted = [...views].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  const position = isRecord(requested) ? requested : {};
  const type = optionalString(position.type) || 'end';
  if (type === 'start') return (sorted[0]?.position ?? 0) - 1;
  if (type === 'end') return (sorted[sorted.length - 1]?.position ?? 0) + 1;
  if (type !== 'after_view') throw new Error('position.type must be start, end, or after_view.');
  const afterId = requireString(position.view_id, 'position.view_id');
  const index = sorted.findIndex((view) => view.id === afterId);
  if (index < 0) throw new Error('position.view_id was not found in the target database.');
  const left = sorted[index].position ?? index;
  const right = sorted[index + 1]?.position;
  return right === undefined ? left + 1 : (left + right) / 2;
}

function notionViewConfigWithMetadata(
  config: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  return {
    ...config,
    [notionViewMetadataKey]: { ...notionViewMetadata(config), ...patch },
  };
}

function dashboardConfigurationWithWidget(
  dashboard: DbView,
  widgetViewId: string,
  placementValue: unknown,
) {
  const metadata = notionViewMetadata(dashboard.config);
  const current = isRecord(metadata.configuration) && metadata.configuration.type === 'dashboard'
    ? metadata.configuration
    : { type: 'dashboard', rows: [] };
  const rows: Array<Record<string, unknown> & { widgets: Array<Record<string, unknown>> }> = (
    Array.isArray(current.rows) ? current.rows : []
  )
    .filter(isRecord)
    .map((row) => ({
      ...row,
      widgets: (Array.isArray(row.widgets) ? row.widgets : []).filter(isRecord).map((widget) => ({ ...widget })),
    }));
  const placement = placementValue === undefined ? { type: 'new_row' } : placementValue;
  if (!isRecord(placement)) throw new Error('placement must be an object.');
  const type = requireString(placement.type, 'placement.type');
  const widgetId = newId();
  if (type === 'new_row') {
    if (rows.length >= 100) throw new Error('A dashboard may contain at most 100 rows.');
    const requestedIndex = placement.row_index;
    if (requestedIndex !== undefined && (!Number.isInteger(requestedIndex) || Number(requestedIndex) < 0)) {
      throw new Error('placement.row_index must be a non-negative integer.');
    }
    const rowIndex = requestedIndex === undefined ? rows.length : Number(requestedIndex);
    if (rowIndex > rows.length) throw new Error('placement.row_index is outside the dashboard.');
    rows.splice(rowIndex, 0, {
      id: newId(),
      widgets: [{ id: widgetId, view_id: widgetViewId, width: 12, row_index: rowIndex }],
    });
  } else if (type === 'existing_row') {
    if (!Number.isInteger(placement.row_index) || Number(placement.row_index) < 0) {
      throw new Error('placement.row_index is required for existing_row.');
    }
    const rowIndex = Number(placement.row_index);
    const row = rows[rowIndex];
    if (!row) throw new Error('placement.row_index is outside the dashboard.');
    const widgets = row.widgets as Array<Record<string, unknown>>;
    if (widgets.length >= 100) throw new Error('A dashboard row may contain at most 100 widgets.');
    widgets.push({ id: widgetId, view_id: widgetViewId, width: 12, row_index: rowIndex });
  } else {
    throw new Error('placement.type must be new_row or existing_row.');
  }
  rows.forEach((row, rowIndex) => {
    (row.widgets as Array<Record<string, unknown>>).forEach((widget) => {
      widget.row_index = rowIndex;
    });
  });
  return {
    dashboardConfig: { type: 'dashboard', rows },
    widgetId,
  };
}

function dashboardConfigWithoutWidget(dashboard: DbView, widgetViewId: string) {
  const metadata = notionViewMetadata(dashboard.config);
  if (!isRecord(metadata.configuration) || metadata.configuration.type !== 'dashboard') return null;
  let removed = false;
  const rows = (Array.isArray(metadata.configuration.rows) ? metadata.configuration.rows : [])
    .filter(isRecord)
    .map((row) => {
      const widgets = (Array.isArray(row.widgets) ? row.widgets : [])
        .filter(isRecord)
        .filter((widget) => {
          const keep = widget.view_id !== widgetViewId;
          if (!keep) removed = true;
          return keep;
        })
        .map((widget) => ({ ...widget }));
      return { ...row, widgets };
    })
    .filter((row) => row.widgets.length > 0);
  if (!removed) return null;
  rows.forEach((row, rowIndex) => {
    row.widgets.forEach((widget) => {
      widget.row_index = rowIndex;
    });
  });
  return notionViewConfigWithMetadata(dashboard.config ?? {}, {
    configuration: { type: 'dashboard', rows },
  });
}

async function linkedDatabaseBlockPlacement(
  db: DbRef,
  page: Page,
  createDatabase: Record<string, unknown>,
) {
  const position = createDatabase.position;
  const blocks = await listAll(db.table<Block>('blocks').where('pageId', '==', page.id));
  if (position === undefined) {
    const roots = blocks.filter((block) => !block.parentId);
    return {
      parentId: null as string | null,
      position: roots.reduce((max, block) => Math.max(max, block.position ?? 0), 0) + 1,
    };
  }
  if (!isRecord(position) || position.type !== 'after_block') {
    throw new Error('create_database.position.type must be after_block.');
  }
  const afterId = requireString(position.block_id, 'create_database.position.block_id');
  const after = blocks.find((block) => block.id === afterId);
  if (!after) throw new Error('create_database.position.block_id was not found in the parent page.');
  const parentId = after.parentId ?? null;
  const siblings = blocks
    .filter((block) => (block.parentId ?? null) === parentId)
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  const index = siblings.findIndex((block) => block.id === after.id);
  const left = after.position ?? index;
  const right = siblings[index + 1]?.position;
  return { parentId, position: right === undefined ? left + 1 : (left + right) / 2 };
}

async function createViewEndpoint(
  context: FunctionContext,
  dataSourceId: string,
  body: Record<string, unknown>,
  strictOfficial = false,
) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireWritablePage(db, dataSourceId, auth.id, auth.email, context.compatBearer);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const type = parseDatabaseViewType(optionalString(body.type) || 'table');
  const [views, properties] = await Promise.all([
    listAll(db.table<DbView>('db_views').where('databaseId', '==', database.id)),
    type === 'board' && 'configuration' in body
      ? listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', database.id))
      : Promise.resolve([] as DbProperty[]),
  ]);
  let dashboardTarget: { db: DbRef; view: DbView; database: Page; config: Record<string, unknown> } | null = null;
  let linkedTarget: { page: Page; blockId: string; parentId: string | null; position: number } | null = null;
  const parentDatabaseId = dataSourceParentDatabaseId(database);
  if (strictOfficial) {
    requireString(body.data_source_id, 'data_source_id');
    requireString(body.name, 'name');
    requireString(body.type, 'type');
    const destinations = ['database_id', 'view_id', 'create_database']
      .filter((key) => body[key] !== undefined && body[key] !== null);
    if (destinations.length > 1) {
      throw new Error('database_id, view_id, and create_database are mutually exclusive.');
    }
    if (destinations[0] !== 'database_id' && body.position !== undefined) {
      throw new Error('position is only valid with database_id.');
    }
    if (destinations[0] !== 'view_id' && body.placement !== undefined) {
      throw new Error('placement is only valid with view_id.');
    }
    if (destinations[0] === 'database_id') {
      const requestedDatabaseId = requireString(body.database_id, 'database_id');
      if (requestedDatabaseId !== parentDatabaseId) {
        throw new Error('database_id must be the parent database of data_source_id.');
      }
      if (requestedDatabaseId !== database.id) {
        const parentDatabase = await requireWritablePage(
          db, requestedDatabaseId, auth.id, auth.email, context.compatBearer,
        );
        if (parentDatabase.kind !== 'database') throw new Error('Database was not found.');
      }
    } else if (destinations[0] === 'view_id') {
      const dashboardViewId = requireString(body.view_id, 'view_id');
      const routed = await findAccessibleRecord<DbView>(context, 'db_views', dashboardViewId, body);
      if (!routed || routed.record.type !== 'dashboard') throw new Error('Dashboard view was not found.');
      const dashboardDatabase = await requireWritablePage(
        routed.db, routed.record.databaseId, auth.id, auth.email, context.compatBearer,
      );
      if (dashboardDatabase.workspaceId !== database.workspaceId) {
        throw new Error('Dashboard widgets and their data source must belong to the same workspace.');
      }
      const pendingViewId = optionalString(body.id) || newId();
      body.id = pendingViewId;
      const dashboard = dashboardConfigurationWithWidget(routed.record, pendingViewId, body.placement);
      dashboardTarget = {
        db: routed.db,
        view: routed.record,
        database: dashboardDatabase,
        config: notionViewConfigWithMetadata(routed.record.config ?? {}, {
          configuration: dashboard.dashboardConfig,
        }),
      };
      body.__dashboard_widget_id = dashboard.widgetId;
    } else if (destinations[0] === 'create_database') {
      if (!isRecord(body.create_database)) throw new Error('create_database must be an object.');
      const parent = isRecord(body.create_database.parent) ? body.create_database.parent : {};
      if (parent.type !== 'page_id') throw new Error('create_database.parent.type must be page_id.');
      const pageId = requireString(parent.page_id, 'create_database.parent.page_id');
      const linkedPageDb = await boundedDbFromPageHint(context.admin, pageId);
      const linkedPage = await requireWritablePage(
        linkedPageDb, pageId, auth.id, auth.email, context.compatBearer,
      );
      if (linkedPage.workspaceId !== database.workspaceId) {
        throw new Error('Linked database blocks and their data source must belong to the same workspace.');
      }
      const placement = await linkedDatabaseBlockPlacement(linkedPageDb, linkedPage, body.create_database);
      linkedTarget = { page: linkedPage, blockId: newId(), ...placement };
    }
  }
  let config = applyNotionViewUpdate(undefined, body, type, true, properties);
  if (dashboardTarget) {
    config = notionViewConfigWithMetadata(config, {
      dashboard_view_id: dashboardTarget.view.id,
      dashboard_widget_id: body.__dashboard_widget_id,
    });
  }
  if (linkedTarget) {
    config = notionViewConfigWithMetadata(config, { linked_block_id: linkedTarget.blockId });
  }
  const record = normalizeDatabaseViewStorageRecord({
    id: optionalString(body.id) || newId(),
    databaseId: database.id,
    name: optionalString(body.name) || type[0].toUpperCase() + type.slice(1),
    type,
    position: nextViewPosition(views, strictOfficial && !body.database_id ? undefined : body.position),
    config,
  });
  const result = await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
    action: 'insert',
    table: 'db_views',
    databaseId: database.id,
    workspaceId: database.workspaceId,
    record,
  });
  const created = result.record as DbView;
  try {
    if (dashboardTarget) {
      await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
        action: 'update',
        table: 'db_views',
        id: dashboardTarget.view.id,
        databaseId: dashboardTarget.view.databaseId,
        workspaceId: dashboardTarget.database.workspaceId,
        patch: { config: dashboardTarget.config },
      });
    }
    if (linkedTarget) {
      await callProductMutation(blockMutationPOST as FunctionDefinition, context, {
        action: 'create',
        id: linkedTarget.blockId,
        pageId: linkedTarget.page.id,
        parentId: linkedTarget.parentId,
        type: 'inline_database',
        position: linkedTarget.position,
        plainText: database.title || 'Untitled',
        content: {
          childPageId: database.id,
          childPageTitle: database.title || 'Untitled',
          childPageKind: 'database',
          databaseViewId: created.id,
          databaseViewIds: [created.id],
          linkedDatabaseSource: true,
        },
      });
    }
  } catch (error) {
    await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
      action: 'delete',
      table: 'db_views',
      id: created.id,
      databaseId: database.id,
      workspaceId: database.workspaceId,
    }).catch(() => undefined);
    throw error;
  }
  return notionView(created, request, parentDatabaseId);
}

async function updateViewEndpoint(context: FunctionContext, viewId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbView>(context, 'db_views', viewId, body);
  if (!routed) throw new Error('View was not found.');
  const { db, record: current } = routed;
  const database = await requireWritablePage(
    db,
    current.databaseId,
    auth.id,
    auth.email,
    context.compatBearer,
  );
  const type = parseDatabaseViewType(current.type || 'table');
  if (body.type !== undefined && parseDatabaseViewType(body.type) !== type) {
    throw new Error('A view type cannot be changed after creation.');
  }
  const properties = type === 'board' && 'configuration' in body
    ? await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', current.databaseId))
    : [];
  const result = await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
    action: 'update',
    table: 'db_views',
    id: current.id,
    databaseId: current.databaseId,
    workspaceId: database.workspaceId,
    patch: {
      name: optionalString(body.name) || current.name,
      config: applyNotionViewUpdate(current.config, body, type, false, properties),
    },
  });
  return notionView(
    result.record as DbView,
    request,
    dataSourceParentDatabaseId(database),
  );
}

async function deleteViewEndpoint(context: FunctionContext, viewId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbView>(context, 'db_views', viewId);
  if (!routed) throw new Error('View was not found.');
  const { db, record: current } = routed;
  const database = await requireWritablePage(db, current.databaseId, auth.id, auth.email, context.compatBearer);
  const metadata = notionViewMetadata(current.config);
  const dashboardViewId = optionalString(metadata.dashboard_view_id);
  const dashboard = dashboardViewId
    ? await getExisting(db.table<DbView>('db_views'), dashboardViewId)
    : null;
  const dashboardConfig = dashboard ? dashboardConfigWithoutWidget(dashboard, current.id) : null;
  if (dashboard && dashboardConfig) {
    const dashboardDatabase = await requireWritablePage(
      db, dashboard.databaseId, auth.id, auth.email, context.compatBearer,
    );
    if (dashboardDatabase.workspaceId !== database.workspaceId) {
      throw new Error('Dashboard widget moved to another workspace.');
    }
    try {
      await db.transact([
        { table: 'db_views', op: 'expect', id: current.id, exists: true },
        { table: 'db_views', op: 'expect', id: dashboard.id, exists: true },
        { table: 'db_views', op: 'update', id: dashboard.id, data: { config: dashboardConfig } },
        { table: 'db_views', op: 'delete', id: current.id },
      ]);
    } catch (error) {
      if (!transactUnavailable(error)) throw error;
      await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
        action: 'update',
        table: 'db_views',
        id: dashboard.id,
        databaseId: dashboard.databaseId,
        workspaceId: dashboardDatabase.workspaceId,
        patch: { config: dashboardConfig },
      });
      try {
        await deletePrimaryContentRecord<DbView>(context, db, database.workspaceId, 'db_views', viewId);
      } catch (deleteError) {
        await callProductMutation(databaseMutationPOST as FunctionDefinition, context, {
          action: 'update',
          table: 'db_views',
          id: dashboard.id,
          databaseId: dashboard.databaseId,
          workspaceId: dashboardDatabase.workspaceId,
          patch: { config: dashboard.config ?? {} },
        }).catch(() => undefined);
        throw deleteError;
      }
    }
  } else {
    await deletePrimaryContentRecord<DbView>(context, db, database.workspaceId, 'db_views', viewId);
  }
  return {
    object: 'view',
    id: current.id,
    parent: { type: 'database_id', database_id: dataSourceParentDatabaseId(database) },
    type: current.type,
  };
}

function viewQueryResponse(
  query: DbViewQuery,
) {
  const rowIds = Array.isArray(query.rowIds) ? query.rowIds : [];
  const results = rowIds.map((id) => ({ object: 'page', id }));
  const hasMore = query.hasMore === true;
  return {
    object: 'view_query',
    id: query.id,
    view_id: query.viewId,
    expires_at: query.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    results,
    next_cursor: hasMore ? query.sourceCursor ?? null : null,
    has_more: hasMore,
    request_status: { type: 'complete' },
  };
}

async function createViewQueryEndpoint(
  context: FunctionContext,
  viewId: string,
  body: Record<string, unknown>,
) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  assertOnlyKeys(body, ['page_size', 'filter', 'sorts'], 'view query');
  const requestedPageSize = notionPageSize(body.page_size);
  const routed = await findAccessibleRecord<DbView>(context, 'db_views', viewId, body);
  if (!routed) throw new Error('View was not found.');
  const { db, record: view } = routed;
  const database = await requireReadablePage(db, view.databaseId, auth.id, auth.email, context.compatBearer);
  if (database.kind !== 'database') throw new Error('View data source was not found.');
  const props = await databaseProperties(db, database.id);
  const config = view.config ?? {};
  const metadata = notionViewMetadata(config);
  const requestHasFilter = Object.prototype.hasOwnProperty.call(body, 'filter');
  const requestHasSorts = Object.prototype.hasOwnProperty.call(body, 'sorts');
  if (requestHasFilter && body.filter !== null) validateDataSourceFilter(body.filter, props);
  if (requestHasSorts && body.sorts !== null) validateDataSourceSorts(body.sorts, props);
  const filter = requestHasFilter
    ? body.filter
    : Object.prototype.hasOwnProperty.call(metadata, 'filter')
      ? metadata.filter
      : config.filter ?? config.filters;
  const sorts = requestHasSorts
    ? body.sorts
    : Object.prototype.hasOwnProperty.call(metadata, 'sorts')
      ? metadata.sorts
      : config.sorts ?? config.sort;
  const filterIsUsable = storedViewFilterIsUsable(filter, props);
  const queryId = newId();
  const page = filterIsUsable
    ? await dataSourceRowsPageForQuery(context, database.id, props, {
      limit: requestedPageSize,
      sorts: canonicalDatabaseRowSorts(sorts, props),
      cursorScope: queryId,
    })
    : { rows: [] as Page[], hasMore: false, nextCursor: undefined };
  const rowIds = page.rows
    .filter((row) => (
      row.parentType === 'database'
      && !row.inTrash
      && rowMatchesFilter(row, props, filter, auth.id)
    ))
    .map((row) => row.id);
  const now = nowIso();
  const query = await db.table<DbViewQuery>('db_view_queries').insert({
    id: queryId,
    viewId: view.id,
    databaseId: database.id,
    workspaceId: database.workspaceId,
    rowIds,
    sourceCursor: page.nextCursor,
    hasMore: page.hasMore,
    filter,
    sorts,
    pageSize: requestedPageSize,
    createdBy: auth.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    createdAt: now,
  });
  return viewQueryResponse(query);
}

async function getViewQueryEndpoint(context: FunctionContext, viewId: string, queryId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbViewQuery>(context, 'db_view_queries', queryId);
  if (!routed || routed.record.viewId !== viewId) throw new Error('View query was not found.');
  const { db, record: query } = routed;
  await requireReadablePage(db, query.databaseId, auth.id, auth.email, context.compatBearer);
  if (query.expiresAt && Date.parse(query.expiresAt) <= Date.now()) {
    await db.table<DbViewQuery>('db_view_queries').delete(query.id).catch(() => {});
    throw new Error('View query was not found.');
  }
  const url = new URL(request.url);
  const cursor = notionStringCursor(url.searchParams.get('start_cursor'));
  if (!cursor) return viewQueryResponse(query);
  if (!query.hasMore || !query.sourceCursor || cursor !== query.sourceCursor) {
    throw new Error('start_cursor is invalid.');
  }
  const size = url.searchParams.has('page_size')
    ? notionPageSize(url.searchParams.get('page_size'))
    : notionPageSize(query.pageSize);
  const props = await databaseProperties(db, query.databaseId);
  const page = await dataSourceRowsPageForQuery(context, query.databaseId, props, {
    cursor,
    limit: size,
    sorts: canonicalDatabaseRowSorts(query.sorts, props),
    cursorScope: query.id,
  });
  const rowIds = page.rows
    .filter((row) => (
      row.parentType === 'database'
      && !row.inTrash
      && rowMatchesFilter(row, props, query.filter, auth.id)
    ))
    .map((row) => row.id);
  const updated = await db.table<DbViewQuery>('db_view_queries').update(query.id, {
    rowIds,
    sourceCursor: page.nextCursor,
    hasMore: page.hasMore,
    pageSize: size,
  });
  return viewQueryResponse(updated);
}

async function deleteViewQueryEndpoint(context: FunctionContext, viewId: string, queryId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbViewQuery>(context, 'db_view_queries', queryId);
  if (!routed || routed.record.viewId !== viewId) throw new Error('View query was not found.');
  const { db, record: query } = routed;
  await requireReadablePage(db, query.databaseId, auth.id, auth.email, context.compatBearer);
  await db.table<DbViewQuery>('db_view_queries').delete(query.id);
  return { object: 'view_query', id: query.id, deleted: true };
}

function commentDisplayName(value: unknown, actorName?: string | null) {
  if (value === undefined) return { type: 'user', resolvedName: actorName ?? null };
  if (!isRecord(value)) throw new Error('display_name must be an object.');
  const type = requireString(value.type, 'display_name.type');
  if (!['custom', 'user', 'integration'].includes(type)) {
    throw new Error('display_name.type must be custom, user, or integration.');
  }
  if (type === 'custom') {
    const custom = isRecord(value.custom) ? value.custom : {};
    return { type, resolvedName: requireString(custom.name, 'display_name.custom.name') };
  }
  return { type, resolvedName: actorName ?? null };
}

type NotionCommentAttachment = {
  category: 'audio' | 'image' | 'pdf' | 'video' | 'productivity';
  file: { url: string; expiry_time: string };
};

function commentAttachmentCategory(contentType: string | undefined): NotionCommentAttachment['category'] {
  if (contentType?.startsWith('audio/')) return 'audio';
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType?.startsWith('video/')) return 'video';
  return 'productivity';
}

async function notionCommentAttachment(
  context: FunctionContext,
  upload: FileUpload,
): Promise<NotionCommentAttachment | null> {
  if (upload.status !== 'uploaded') return null;
  const signed = await callProductMutation(fileMutationPOST as FunctionDefinition, context, {
    action: 'signedUrl',
    workspaceId: upload.workspaceId,
    uploadId: upload.id,
    expiresIn: '1h',
  }) as { url?: unknown; expiresAt?: unknown };
  const url = optionalString(signed.url);
  const expiryTime = optionalString(signed.expiresAt);
  if (!url || !expiryTime) return null;
  return {
    category: commentAttachmentCategory(upload.contentType),
    file: { url, expiry_time: expiryTime },
  };
}

async function notionCommentAttachments(
  context: FunctionContext,
  db: DbRef,
  attachmentIds: string[],
) {
  const attachments: NotionCommentAttachment[] = [];
  const seen = new Set<string>();
  for (const uploadId of attachmentIds) {
    if (seen.has(uploadId)) continue;
    seen.add(uploadId);
    const upload = await getExisting(db.table<FileUpload>('file_uploads'), uploadId);
    if (!upload) continue;
    const attachment = await notionCommentAttachment(context, upload);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

async function notionCommentAttachmentsFromUploads(
  context: FunctionContext,
  uploads: FileUpload[],
) {
  const attachments: NotionCommentAttachment[] = [];
  for (const upload of uploads) {
    const attachment = await notionCommentAttachment(context, upload);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

async function notionComment(
  context: FunctionContext,
  db: DbRef,
  comment: Comment,
  preparedAttachments?: NotionCommentAttachment[],
) {
  const body = isRecord(comment.body) ? comment.body : {};
  const attachments = preparedAttachments
    ?? await notionCommentAttachments(context, db, normalizeIdArray(body.attachmentIds));
  const displayName = isRecord(body.displayName) ? body.displayName : {};
  const createdTime = comment.createdAt ?? new Date(0).toISOString();
  return {
    object: 'comment',
    id: comment.id,
    parent: comment.blockId
      ? { type: 'block_id', block_id: comment.blockId }
      : { type: 'page_id', page_id: comment.pageId },
    discussion_id: comment.parentId || comment.id,
    created_time: createdTime,
    last_edited_time: comment.updatedAt ?? createdTime,
    created_by: notionPartialUser(comment.authorId),
    rich_text: spansToNotionRichText(body.rich),
    display_name: {
      type: optionalString(displayName.type) || 'user',
      resolved_name: typeof displayName.resolvedName === 'string' ? displayName.resolvedName : null,
    },
    ...(attachments.length ? { attachments } : {}),
  };
}

async function listCommentsEndpoint(context: FunctionContext) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const url = new URL(request.url);
  const pageId = url.searchParams.get('page_id');
  const blockId = url.searchParams.get('block_id');
  if (!pageId && !blockId) throw new Error('page_id or block_id is required.');
  const db = pageId
    ? await boundedDbFromPageHint(context.admin, pageId)
    : await blockRoutedDb(context, blockId!);
  let resolvedPageId = pageId || '';
  let blockIdIsPage = false;
  if (!resolvedPageId && blockId) {
    const page = await getExisting(db.table<Page>('pages'), blockId);
    if (page) {
      resolvedPageId = page.id;
      blockIdIsPage = true;
    } else {
      const block = await getExisting(db.table<Block>('blocks'), blockId);
      if (!block) throw new Error('Block was not found.');
      resolvedPageId = block.pageId;
    }
  }
  if (!resolvedPageId) throw new Error('page_id or block_id is required.');
  await requireReadablePage(db, resolvedPageId, auth.id, auth.email, context.compatBearer);
  const start = cursorOffset(url.searchParams.get('start_cursor'));
  const size = pageSize(url.searchParams.get('page_size'));
  const comments = (await listAll(db.table<Comment>('comments').where('pageId', '==', resolvedPageId)))
    .filter((comment) => !blockId || blockIdIsPage || comment.blockId === blockId)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const results = await Promise.all(comments.map((comment) => notionComment(context, db, comment)));
  return listObject(results, 'comment', {}, start, size);
}

async function createCommentEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const parent = isRecord(body.parent) ? body.parent : {};
  const parentWorkspaceId =
    optionalString(body.workspace_id) ||
    optionalString(body.workspaceId) ||
    optionalString(parent.workspace_id) ||
    optionalString(parent.workspaceId);
  let pageId = optionalString(parent.page_id) || '';
  const blockId = optionalString(parent.block_id) || null;
  const discussionId = optionalString(body.discussion_id);
  let discussionAnchor: Comment | null = null;
  let db: DbRef;
  if (!pageId && !blockId && discussionId) {
    const routed = await findAccessibleRecord<Comment>(context, 'comments', discussionId, body);
    if (!routed) throw new Error('Discussion was not found.');
    db = routed.db;
    discussionAnchor = routed.record;
    pageId = routed.record.pageId;
  } else {
    db = parentWorkspaceId
      ? boundedDbFromWorkspaceHint(context.admin, parentWorkspaceId)
      : pageId
        ? await boundedDbFromPageHint(context.admin, pageId, (body as { page_id?: unknown }).page_id)
        : blockId
          ? await blockRoutedDb(context, blockId, body)
          : await boundedDbFromPageHint(context.admin, (body as { page_id?: unknown }).page_id);
  }
  if (!pageId && blockId) {
    const block = await getExisting(db.table<Block>('blocks'), blockId);
    if (!block) throw new Error('Block was not found.');
    pageId = block.pageId;
  }
  if (!pageId) throw new Error('comment parent page_id or block_id is required.');
  await requireCommentablePage(db, pageId, auth.id, auth.email, context.compatBearer);
  const hasRichText = body.rich_text !== undefined;
  const hasMarkdown = body.markdown !== undefined;
  if (hasRichText === hasMarkdown) throw new Error('Exactly one of rich_text or markdown is required.');
  const rich = hasRichText
    ? notionRichTextToSpans(body.rich_text)
    : inlineCommentMarkdownToSpans(body.markdown);
  if (rich.length > 100) throw new Error('rich_text must contain at most 100 items.');
  const rawAttachments = body.attachments === undefined ? [] : body.attachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 3) {
    throw new Error('attachments must be an array with at most 3 items.');
  }
  const uploads: FileUpload[] = [];
  const uploadIds = new Set<string>();
  for (const attachment of rawAttachments) {
    if (!isRecord(attachment)) throw new Error('Every attachment must be an object.');
    if (attachment.type !== undefined && attachment.type !== 'file_upload') {
      throw new Error('attachment.type must be file_upload.');
    }
    const uploadId = requireString(attachment.file_upload_id, 'attachment.file_upload_id');
    if (uploadIds.has(uploadId)) continue;
    uploadIds.add(uploadId);
    const upload = await getExisting(db.table<FileUpload>('file_uploads'), uploadId);
    if (!upload || upload.status !== 'uploaded') throw new Error('File upload was not found.');
    await requireFileUploadAccess(db, upload, auth.id, 'edit', auth.email, context.compatBearer);
    uploads.push(upload);
  }
  const now = nowIso();
  const displayName = commentDisplayName(body.display_name, auth.email);
  const comment: Comment = {
    id: optionalString(body.id) || newId(),
    pageId,
    blockId: blockId || discussionAnchor?.blockId || null,
    parentId: discussionId || optionalString(body.parent_id) || null,
    authorId: auth.id,
    body: {
      rich,
      displayName,
      attachmentIds: uploads.map((upload) => upload.id),
      ...(typeof body.selection_with_ellipsis === 'string' && body.selection_with_ellipsis.trim()
        ? { quote: body.selection_with_ellipsis.trim() }
        : {}),
    },
    resolved: false,
    createdAt: now,
    updatedAt: now,
  };
  const projectedAttachments = await notionCommentAttachmentsFromUploads(context, uploads);
  if (uploads.length) {
    await db.transact([
      { table: 'comments', op: 'expect', id: comment.id, exists: false },
      ...uploads.map((upload): TransactOperation => ({
        table: 'file_uploads', op: 'expect', id: upload.id,
        where: [['status', '==', 'uploaded']], exists: true,
      })),
      { table: 'comments', op: 'insert', data: comment as unknown as Record<string, unknown> },
      ...uploads.map((upload): TransactOperation => ({
        table: 'file_uploads', op: 'update', id: upload.id,
        data: { commentId: comment.id, updatedAt: now },
      })),
    ]);
  } else {
    await db.table<Comment>('comments').insert(comment);
  }
  return notionComment(context, db, comment, projectedAttachments);
}

async function getCommentEndpoint(context: FunctionContext, commentId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<Comment>(context, 'comments', commentId);
  if (!routed) throw new Error('Comment was not found.');
  const { db, record: comment } = routed;
  await requireReadablePage(db, comment.pageId, auth.id, auth.email, context.compatBearer);
  return notionComment(context, db, comment);
}

async function updateCommentEndpoint(context: FunctionContext, commentId: string, body: Record<string, unknown>) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<Comment>(context, 'comments', commentId, body);
  if (!routed) throw new Error('Comment was not found.');
  const { db, record: comment } = routed;
  const page = await requirePageRole(db, comment.pageId, auth.id, 'comment', auth.email, context.compatBearer);
  const role = await pageAccessRole(db, page, auth.id, undefined, auth.email);
  if (comment.authorId !== auth.id && !roleAtLeast(role, 'edit')) throw new Error('Page access required.');
  const hasRichText = body.rich_text !== undefined;
  const hasMarkdown = body.markdown !== undefined;
  if (hasRichText === hasMarkdown) throw new Error('Exactly one of rich_text or markdown is required.');
  const currentBody = isRecord(comment.body) ? comment.body : {};
  const rich = hasRichText
    ? notionRichTextToSpans(body.rich_text)
    : inlineCommentMarkdownToSpans(body.markdown);
  const projectedAttachments = await notionCommentAttachments(
    context,
    db,
    normalizeIdArray(currentBody.attachmentIds),
  );
  const patch: Partial<Comment> = {
    updatedAt: nowIso(),
    body: {
      ...currentBody,
      rich,
    },
  };
  const updated = await db.table<Comment>('comments').update(comment.id, patch);
  return notionComment(context, db, updated, projectedAttachments);
}

async function deleteCommentEndpoint(context: FunctionContext, commentId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<Comment>(context, 'comments', commentId);
  if (!routed) throw new Error('Comment was not found.');
  const { db, record: comment } = routed;
  const page = await requirePageRole(db, comment.pageId, auth.id, 'comment', auth.email, context.compatBearer);
  const role = await pageAccessRole(db, page, auth.id, undefined, auth.email);
  if (comment.authorId !== auth.id && !roleAtLeast(role, 'edit')) throw new Error('Page access required.');
  await deletePrimaryContentRecord<Comment>(context, db, page.workspaceId, 'comments', comment.id);
  return { object: 'comment', id: comment.id };
}

function cleanFileSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
}

function publicNotionFileImportResult(upload: FileUpload) {
  const value = isRecord(upload.fileImportResult) ? upload.fileImportResult : null;
  if (value?.type === 'error') {
    const error = isRecord(value.error) ? value.error : {};
    return {
      imported_time: optionalString(value.imported_time)
        || upload.updatedAt
        || upload.createdAt
        || new Date(0).toISOString(),
      type: 'error',
      error: {
        type: ['validation_error', 'internal_system_error', 'download_error', 'upload_error']
          .includes(String(error.type)) ? error.type : 'upload_error',
        code: optionalString(error.code) || 'upload_failed',
        message: optionalString(error.message) || 'File upload failed.',
        parameter: optionalString(error.parameter) || null,
        status_code: Number.isInteger(error.status_code) ? error.status_code : null,
      },
    };
  }
  if (value?.type === 'success' || upload.status === 'uploaded') {
    return {
      imported_time: optionalString(value?.imported_time)
        || upload.completedAt
        || upload.updatedAt
        || upload.createdAt
        || new Date(0).toISOString(),
      type: 'success',
      success: {},
    };
  }
  return null;
}

function notionFileUpload(upload: FileUpload, request: Request) {
  const totalParts = Math.max(1, Math.floor(upload.numberOfPartsTotal ?? 1));
  const sentParts =
    typeof upload.numberOfPartsSent === 'number'
      ? Math.max(0, Math.min(totalParts, Math.floor(upload.numberOfPartsSent)))
      : upload.status === 'uploaded'
        ? totalParts
        : 0;
  const createdTime = upload.createdAt ?? new Date(0).toISOString();
  const status = upload.status === 'uploaded' || upload.status === 'expired' || upload.status === 'failed'
    ? upload.status
    : upload.status === 'deleted' || upload.status === 'deleting'
      ? 'expired'
      : 'pending';
  const fileImportResult = publicNotionFileImportResult(upload);
  return {
    object: 'file_upload',
    id: upload.id,
    created_time: createdTime,
    created_by: { id: upload.createdBy || '', type: 'person' },
    last_edited_time: upload.updatedAt ?? upload.completedAt ?? createdTime,
    in_trash: status === 'expired',
    expiry_time: upload.expiresAt ?? null,
    status,
    filename: upload.name ?? null,
    content_type: upload.contentType ?? null,
    content_length: typeof upload.size === 'number' ? upload.size : null,
    upload_url: `${originOf(request)}/api/functions/v1/file_uploads/${encodeURIComponent(upload.id)}/send${workspaceQuery(upload)}`,
    complete_url: `${originOf(request)}/api/functions/v1/file_uploads/${encodeURIComponent(upload.id)}/complete${workspaceQuery(upload)}`,
    ...(fileImportResult ? { file_import_result: fileImportResult } : {}),
    number_of_parts: { total: totalParts, sent: sentParts },
  };
}

async function fileUploadDbForBody(
  context: FunctionContext,
  body: Record<string, unknown>,
): Promise<DbRef> {
  const parent = isRecord(body.parent) ? body.parent : {};
  const workspaceId =
    optionalString(body.workspace_id) ||
    optionalString(body.workspaceId) ||
    optionalString(parent.workspace_id) ||
    optionalString(parent.workspaceId);
  if (workspaceId) return boundedDbFromWorkspaceHint(context.admin, workspaceId);
  const pageId =
    optionalString(body.page_id) ||
    optionalString(body.pageId) ||
    optionalString(parent.page_id);
  const dataSourceId =
    optionalString(body.data_source_id) ||
    optionalString(body.database_id) ||
    optionalString(body.databaseId) ||
    optionalString(parent.data_source_id) ||
    optionalString(parent.database_id);
  const blockId =
    optionalString(body.block_id) ||
    optionalString(body.blockId) ||
    optionalString(parent.block_id);
  if (!pageId && !dataSourceId && blockId) {
    throw new Error('file_upload block targets require page_id or workspace_id for workspace routing.');
  }
  return boundedDbFromPageHint(context.admin, pageId, dataSourceId);
}

async function fileUploadTarget(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  minimum: ShareRole,
  actorEmail?: string | null,
) {
  const parent = isRecord(body.parent) ? body.parent : {};
  const workspaceId = optionalString(body.workspace_id) || optionalString(body.workspaceId) || optionalString(parent.workspace_id);
  const pageId = optionalString(body.page_id) || optionalString(body.pageId) || optionalString(parent.page_id);
  const dataSourceId =
    optionalString(body.data_source_id) ||
    optionalString(body.database_id) ||
    optionalString(body.databaseId) ||
    optionalString(parent.data_source_id) ||
    optionalString(parent.database_id);
  const blockId = optionalString(body.block_id) || optionalString(body.blockId) || optionalString(parent.block_id);
  const propertyId = optionalString(body.property_id) || optionalString(body.propertyId);
  if (blockId) {
    const block = await getExisting(db.table<Block>('blocks'), blockId);
    if (!block) throw new Error('Block was not found.');
    const page = await requirePageRole(db, block.pageId, actorId, minimum, actorEmail);
    return { workspaceId: page.workspaceId, pageId: page.id, blockId, propertyId };
  }
  if (pageId) {
    const page = await requirePageRole(db, pageId, actorId, minimum, actorEmail);
    return {
      workspaceId: page.workspaceId,
      pageId: page.id,
      databaseId: page.parentType === 'database' ? page.parentId ?? undefined : undefined,
      propertyId,
    };
  }
  if (dataSourceId) {
    const dataSource = await requirePageRole(db, dataSourceId, actorId, minimum, actorEmail);
    if (dataSource.kind !== 'database') throw new Error('Data source was not found.');
    return { workspaceId: dataSource.workspaceId, databaseId: dataSource.id, propertyId };
  }
  if (!workspaceId) throw new Error('workspace_id is required for file uploads.');
  await requireWorkspaceRole(db, workspaceId, actorId, minimum);
  return { workspaceId, propertyId };
}

async function requireFileUploadAccess(
  db: DbRef,
  upload: FileUpload,
  actorId: string,
  minimum: ShareRole,
  actorEmail?: string | null,
  bearer?: NotionCompatBearerIdentity | null,
) {
  const target = await fileUploadTarget(
    db,
    upload as unknown as Record<string, unknown>,
    actorId,
    minimum,
    actorEmail,
  );
  if (target.workspaceId !== upload.workspaceId) throw new Error('File upload target is outside the upload workspace.');
  const targetPageId = target.pageId ?? target.databaseId;
  if (targetPageId) {
    const targetPage = await getExisting(db.table<Page>('pages'), targetPageId);
    if (!targetPage) throw new Error('File upload target was not found.');
    await assertNotionBearerPageAllowed(db, targetPage, bearer);
  }
}

async function assertFileUploadBodyAllowed(
  context: FunctionContext,
  body: Record<string, unknown>,
  minimum: ShareRole,
) {
  if (!context.compatBearer) return;
  const parent = isRecord(body.parent) ? body.parent : {};
  const blockId = optionalString(body.block_id) || optionalString(body.blockId) || optionalString(parent.block_id);
  const resourceId =
    optionalString(body.page_id)
    || optionalString(body.pageId)
    || optionalString(parent.page_id)
    || optionalString(body.data_source_id)
    || optionalString(body.database_id)
    || optionalString(body.databaseId)
    || optionalString(parent.data_source_id)
    || optionalString(parent.database_id);
  if (!blockId && !resourceId) return;
  const db = blockId
    ? await blockRoutedDb(context, blockId, body)
    : await boundedDbFromPageHint(context.admin, resourceId!);
  const target = await fileUploadTarget(
    db,
    body,
    context.auth!.id,
    minimum,
    context.auth?.email,
  );
  const targetPageId = target.pageId ?? target.databaseId;
  if (!targetPageId) return;
  const targetPage = await getExisting(db.table<Page>('pages'), targetPageId);
  if (!targetPage) throw new Error('File upload target was not found.');
  await assertNotionBearerPageAllowed(db, targetPage, context.compatBearer);
}

async function createFileUploadEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  if (body.mode !== undefined && !['single_part', 'multi_part', 'external_url'].includes(String(body.mode))) {
    throw new Error('mode must be single_part, multi_part, or external_url.');
  }
  if (body.mode !== undefined && typeof body.mode !== 'string') throw new Error('mode must be a string.');
  for (const field of ['filename', 'content_type', 'external_url']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      throw new Error(`${field} must be a string.`);
    }
  }
  if (body.number_of_parts !== undefined) {
    if (typeof body.number_of_parts !== 'number'
      || !Number.isInteger(body.number_of_parts)
      || body.number_of_parts < 1
      || body.number_of_parts > 10_000) {
      throw new Error('number_of_parts must be an integer between 1 and 10000.');
    }
  }
  await assertFileUploadBodyAllowed(context, body, 'edit');
  const result = await createNotionFileUpload(context, {
    ...body,
    workspaceId:
      optionalString(body.workspace_id)
      || optionalString(body.workspaceId)
      || workspaceIdFromRequest(request),
  }) as { upload: FileUpload };
  return notionFileUpload(result.upload, request);
}

async function getFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  await requireFileUploadAccess(db, upload, auth.id, 'view', auth.email, context.compatBearer);
  return notionFileUpload(upload, request);
}

async function listFileUploadsEndpoint(context: FunctionContext) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const url = new URL(request.url);
  const requestedStatus = url.searchParams.get('status');
  if (requestedStatus !== null && !['pending', 'uploaded', 'expired', 'failed'].includes(requestedStatus)) {
    throw new Error('status must be pending, uploaded, expired, or failed.');
  }
  const workspaceId = workspaceIdFromRequest(request);
  const entries = await workspaceDbsForOptionalHint(context, workspaceId);
  const budget = materializationBudget();
  const visible: FileUpload[] = [];
  for (const entry of entries) {
    const uploads = await listAllBounded(
      entry.db.table<FileUpload>('file_uploads').where('workspaceId', '==', entry.workspaceId),
      budget,
      'File upload listing',
    );
    for (const upload of uploads) {
      try {
        await requireFileUploadAccess(entry.db, upload, auth.id, 'view', auth.email, context.compatBearer);
        const publicStatus = notionFileUpload(upload, request).status;
        if (!requestedStatus || publicStatus === requestedStatus) visible.push(upload);
      } catch {
        // Omit uploads outside the caller's workspaces.
      }
    }
  }
  visible.sort((a, b) => (
    String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''))
    || a.id.localeCompare(b.id)
  ));
  return listObjectByIdCursor(
    visible.map((upload) => notionFileUpload(upload, request)),
    'file_upload',
    request,
    (upload) => upload.id,
    {},
  );
}

async function sendFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  await requireFileUploadAccess(db, upload, auth.id, 'edit', auth.email, context.compatBearer);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new Error('file is required.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
    throw new Error('file is required.');
  }
  const candidate = file as {
    arrayBuffer(): Promise<ArrayBuffer>;
    name?: string;
    type?: string;
  };
  const rawPart = form.get('part_number');
  let partNumber: number | undefined;
  if (rawPart !== null) {
    if (typeof rawPart !== 'string' || !/^\d+$/.test(rawPart.trim())) {
      throw new Error('part_number must be an integer between 1 and 1000.');
    }
    partNumber = Number(rawPart);
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 1000) {
      throw new Error('part_number must be an integer between 1 and 1000.');
    }
  }
  const result = await sendNotionFileUpload(context, fileUploadId, {
    workspaceId: upload.workspaceId,
    bytes: await candidate.arrayBuffer(),
    filename: optionalString(candidate.name),
    contentType: optionalString(candidate.type),
    partNumber,
  }) as { upload: FileUpload };
  return notionFileUpload(result.upload, request);
}

async function completeFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  await requireFileUploadAccess(db, upload, auth.id, 'edit', auth.email, context.compatBearer);
  const result = await completeNotionFileUpload(context, fileUploadId, upload.workspaceId) as {
    upload: FileUpload;
  };
  return notionFileUpload(result.upload, request);
}

async function deleteFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  await requireFileUploadAccess(db, upload, auth.id, 'edit', auth.email, context.compatBearer);
  const result = await deleteNotionFileUpload(context, fileUploadId, upload.workspaceId) as {
    upload: FileUpload;
  };
  return { ...notionFileUpload(result.upload, request), deleted: true };
}

async function movePageEndpoint(
  context: FunctionContext,
  pageId: string,
  body: Record<string, unknown>,
) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, pageId);
  const page = await requireWritablePage(db, pageId, auth.id, auth.email, context.compatBearer);
  if (page.kind === 'database') throw new Error('Only regular pages can be moved.');
  const parent = isRecord(body.parent) ? body.parent : {};
  const parentPageId = optionalString(parent.page_id);
  const dataSourceId = optionalString(parent.data_source_id);
  const parentType = optionalString(parent.type);
  if (!parentPageId && !dataSourceId) throw new Error('parent.page_id or parent.data_source_id is required.');
  if (parentPageId && dataSourceId) {
    throw new Error('parent must include exactly one of page_id or data_source_id.');
  }
  if (parentType && parentType !== (dataSourceId ? 'data_source_id' : 'page_id')) {
    throw new Error('parent.type does not match the provided parent id.');
  }

  const moveIntoDataSource = async (database: Page) => {
    if (database.kind !== 'database') throw new Error('Target data source was not found.');
    if (page.parentType === 'database' && page.parentId === database.id) {
      const props = await databaseProperties(db, database.id);
      return notionPage(await pageWithComputedProperties(context, page, props), props, request);
    }
    const result = await callProductMutation(databaseRowMutationPOST as FunctionDefinition, context, {
      action: page.parentType === 'database' ? 'moveToDatabase' : 'movePageToDatabase',
      id: page.id,
      targetDatabaseId: database.id,
      workspaceId: page.workspaceId,
    });
    const props = await databaseProperties(db, database.id);
    return notionPage(
      await pageWithComputedProperties(context, result.row as Page, props),
      props,
      request,
    );
  };

  if (dataSourceId) {
    const database = await requireWritablePage(db, dataSourceId, auth.id, auth.email, context.compatBearer);
    return moveIntoDataSource(database);
  }
  const target = await requireWritablePage(db, parentPageId!, auth.id, auth.email, context.compatBearer);
  // Notion documents a compatibility exception that permits a single-data-
  // source database id in parent.page_id. Hanji databases currently have one
  // canonical data source, so route that shape through the same conversion.
  if (target.kind === 'database') return moveIntoDataSource(target);
  if (page.parentType === 'database') {
    const result = await callProductMutation(databaseRowMutationPOST as FunctionDefinition, context, {
      action: 'moveToPage',
      id: page.id,
      targetPageId: target.id,
      workspaceId: page.workspaceId,
    });
    return notionPage(result.page as Page, [], request);
  }
  const result = await callProductMutation(pageMutationPOST as FunctionDefinition, context, {
    action: 'move',
    id: page.id,
    workspaceId: page.workspaceId,
    patch: { parentId: target.id, parentType: 'page' },
  });
  return notionPage(result.page as Page, [], request);
}

function includeTranscriptForMarkdown(request: Request) {
  const values = new URL(request.url).searchParams.getAll('include_transcript');
  if (values.length === 0) return false;
  if (values.length !== 1 || (values[0] !== 'true' && values[0] !== 'false')) {
    throw new Error('include_transcript must be a boolean.');
  }
  return values[0] === 'true';
}

async function pageMarkdownEndpoint(
  context: FunctionContext,
  pageOrBlockId: string,
  includeTranscript = false,
) {
  let pageDb = await boundedDbForPage(context.admin, pageOrBlockId);
  const directPage = pageDb
    ? await getExisting(pageDb.table<Page>('pages'), pageOrBlockId)
    : null;
  let page: Page;
  if (directPage) {
    page = await requireReadablePage(
      pageDb!,
      directPage.id,
      context.auth!.id,
      context.auth?.email,
      context.compatBearer,
    );
  } else {
    pageDb = await blockRoutedDb(context, pageOrBlockId);
    const owner = await blockParentPage(
      pageDb,
      pageOrBlockId,
      context.auth!.id,
      context.auth?.email,
      context.compatBearer,
    );
    if (!owner) throw new Error('Page or block was not found.');
    page = owner.page;
  }
  const exported = await callProductMutation(importExportPOST as FunctionDefinition, context, {
    action: 'exportNotionPageMarkdown',
    pageOrBlockId,
    workspaceId: page.workspaceId,
    includeTranscript,
  });
  const unknownBlockIds = Array.isArray(exported.unknownBlockIds)
    ? Array.from(new Set(
      exported.unknownBlockIds
        .filter((id): id is string => typeof id === 'string' && !!id.trim())
        .map((id) => id.trim()),
    )).slice(0, 100)
    : [];
  return {
    object: 'page_markdown',
    id: pageOrBlockId,
    markdown: typeof exported.markdown === 'string' ? exported.markdown : '',
    truncated: exported.truncated === true,
    unknown_block_ids: unknownBlockIds,
  };
}

function selectedMarkdownRange(markdown: string, selector: string) {
  const marker = selector.indexOf('...');
  if (marker < 0) {
    const start = markdown.indexOf(selector);
    return start < 0 ? null : { start, end: start + selector.length };
  }
  const prefix = selector.slice(0, marker);
  const suffix = selector.slice(marker + 3);
  const start = markdown.indexOf(prefix);
  if (start < 0) return null;
  const suffixStart = markdown.indexOf(suffix, start + prefix.length);
  if (suffixStart < 0) return null;
  return { start, end: suffixStart + suffix.length };
}

async function assertMarkdownDeletionAllowed(
  db: DbRef,
  pageId: string,
  allowDeletingContent: boolean,
) {
  if (allowDeletingContent) return;
  const [childPages, blocks] = await Promise.all([
    listAll(db.table<Page>('pages').where('parentId', '==', pageId)),
    listAll(db.table<Block>('blocks').where('pageId', '==', pageId)),
  ]);
  const protectedIds = new Set(
    childPages
      .filter((child) => child.parentType === 'page' && !child.inTrash)
      .map((child) => child.id),
  );
  for (const block of blocks) {
    if (!['child_page', 'child_database', 'inline_database'].includes(block.type)) continue;
    protectedIds.add(optionalString(block.content?.childPageId) || block.id);
  }
  if (protectedIds.size === 0) return;
  throw new Error(
    `The update would delete child pages or databases (${[...protectedIds].slice(0, 10).join(', ')}). `
      + 'Set allow_deleting_content to true to permit this operation.',
  );
}

interface PreparedPageMarkdownUpdate {
  db: DbRef;
  page: Page;
  markdown: string;
}

async function preparePageMarkdownUpdate(
  context: FunctionContext,
  pageId: string,
  body: Record<string, unknown>,
): Promise<PreparedPageMarkdownUpdate> {
  if (body.allow_async !== undefined && typeof body.allow_async !== 'boolean') {
    throw new Error('allow_async must be a boolean.');
  }
  const current = await pageMarkdownEndpoint(context, pageId);
  let markdown = current.markdown;
  const type = requireString(body.type, 'type');
  let allowDeletingContent = false;
  if (type === 'replace_content') {
    const input = isRecord(body.replace_content) ? body.replace_content : {};
    if (input.allow_deleting_content !== undefined && typeof input.allow_deleting_content !== 'boolean') {
      throw new Error('replace_content.allow_deleting_content must be a boolean.');
    }
    allowDeletingContent = input.allow_deleting_content === true;
    markdown = typeof input.new_str === 'string' ? input.new_str : requireString(input.new_str, 'replace_content.new_str');
  } else if (type === 'insert_content') {
    const input = isRecord(body.insert_content) ? body.insert_content : {};
    const content = typeof input.content === 'string' ? input.content : requireString(input.content, 'insert_content.content');
    if (input.after !== undefined && input.position !== undefined) {
      throw new Error('insert_content.after and insert_content.position cannot both be provided.');
    }
    const after = input.after === undefined
      ? undefined
      : requireString(input.after, 'insert_content.after');
    let position: 'start' | 'end' | undefined;
    if (input.position !== undefined) {
      if (!isRecord(input.position)) throw new Error('insert_content.position must be an object.');
      const positionType = requireString(input.position.type, 'insert_content.position.type');
      if (positionType !== 'start' && positionType !== 'end') {
        throw new Error('insert_content.position.type must be start or end.');
      }
      position = positionType;
    }
    if (position === 'start') markdown = `${content}\n${markdown}`;
    else if (after) {
      const range = selectedMarkdownRange(markdown, after);
      if (!range) throw new Error('insert_content.after did not match page content.');
      markdown = `${markdown.slice(0, range.end)}\n${content}${markdown.slice(range.end)}`;
    } else markdown = `${markdown}${markdown.endsWith('\n') ? '' : '\n'}${content}`;
  } else if (type === 'replace_content_range') {
    const input = isRecord(body.replace_content_range) ? body.replace_content_range : {};
    if (input.allow_deleting_content !== undefined && typeof input.allow_deleting_content !== 'boolean') {
      throw new Error('replace_content_range.allow_deleting_content must be a boolean.');
    }
    allowDeletingContent = input.allow_deleting_content === true;
    const selector = requireString(input.content_range, 'replace_content_range.content_range');
    const content = typeof input.content === 'string' ? input.content : requireString(input.content, 'replace_content_range.content');
    const range = selectedMarkdownRange(markdown, selector);
    if (!range) throw new Error('replace_content_range.content_range did not match page content.');
    markdown = `${markdown.slice(0, range.start)}${content}${markdown.slice(range.end)}`;
  } else if (type === 'update_content') {
    const input = isRecord(body.update_content) ? body.update_content : {};
    if (!Array.isArray(input.content_updates)) throw new Error('update_content.content_updates is required.');
    if (input.content_updates.length > 100) {
      throw new Error('update_content.content_updates must contain at most 100 entries.');
    }
    if (input.allow_deleting_content !== undefined && typeof input.allow_deleting_content !== 'boolean') {
      throw new Error('update_content.allow_deleting_content must be a boolean.');
    }
    allowDeletingContent = input.allow_deleting_content === true;
    for (const raw of input.content_updates) {
      if (!isRecord(raw)) throw new Error('Each content update must be an object.');
      const oldText = requireString(raw.old_str, 'old_str');
      const newText = typeof raw.new_str === 'string' ? raw.new_str : requireString(raw.new_str, 'new_str');
      if (raw.replace_all_matches !== undefined && typeof raw.replace_all_matches !== 'boolean') {
        throw new Error('replace_all_matches must be a boolean.');
      }
      const first = markdown.indexOf(oldText);
      if (first < 0) throw new Error('update_content.old_str did not match page content.');
      const second = markdown.indexOf(oldText, first + oldText.length);
      if (second >= 0 && raw.replace_all_matches !== true) {
        throw new Error('update_content.old_str matched more than once; set replace_all_matches to true.');
      }
      markdown = raw.replace_all_matches === true
        ? markdown.split(oldText).join(newText)
        : `${markdown.slice(0, first)}${newText}${markdown.slice(first + oldText.length)}`;
    }
  } else {
    throw new Error(`Unsupported page markdown update type: ${type}.`);
  }
  const db = await boundedDbFromPageHint(context.admin, pageId);
  const page = await requireWritablePage(db, pageId, context.auth!.id, context.auth?.email, context.compatBearer);
  if (type !== 'insert_content') {
    await assertMarkdownDeletionAllowed(db, pageId, allowDeletingContent);
  }
  return { db, page, markdown };
}

async function applyPreparedPageMarkdownUpdate(
  context: FunctionContext,
  prepared: PreparedPageMarkdownUpdate,
) {
  await callProductMutation(importExportPOST as FunctionDefinition, context, {
    action: 'replaceMarkdownPage',
    pageId: prepared.page.id,
    workspaceId: prepared.page.workspaceId,
    markdown: prepared.markdown,
  });
  return pageMarkdownEndpoint(context, prepared.page.id);
}

async function updatePageMarkdownEndpoint(
  context: FunctionContext,
  pageId: string,
  body: Record<string, unknown>,
) {
  return applyPreparedPageMarkdownUpdate(
    context,
    await preparePageMarkdownUpdate(context, pageId, body),
  );
}

function asyncTaskError(error: unknown) {
  const mapped = notionCompatErrorStatus(error);
  return {
    object: 'error',
    status: mapped.status,
    code: errorCodeForStatus(mapped.status),
    message: mapped.message,
  };
}

async function queueRestAsyncTask(
  context: FunctionContext,
  operationName: 'POST /v1/pages' | 'PATCH /v1/pages/:page_id/markdown',
  run: () => Promise<unknown>,
) {
  if (!context.auth?.id) throw new Error('Authentication required.');
  const table = context.admin.db('app').table<AsyncTask>('mcp_async_tasks');
  const createdAt = nowIso();
  const task = await table.insert({
    userId: context.auth.id,
    ...(context.compatBearer?.grant.id ? { grantId: context.compatBearer.grant.id } : {}),
    ...(context.compatBearer?.grant.clientId ? { clientId: context.compatBearer.grant.clientId } : {}),
    status: 'queued',
    operation: { surface: 'rest', name: operationName },
    pollAfterSeconds: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const work = (async () => {
    const startedAt = nowIso();
    await table.update(task.id, { status: 'running', updatedAt: startedAt });
    try {
      const result = await run();
      const completedAt = nowIso();
      await table.update(task.id, {
        status: 'succeeded',
        result,
        completedAt,
        updatedAt: completedAt,
      });
    } catch (error) {
      const completedAt = nowIso();
      await table.update(task.id, {
        status: 'failed',
        error: asyncTaskError(error),
        completedAt,
        updatedAt: completedAt,
      });
    }
  })();
  if (context.waitUntil) context.waitUntil(work);
  else void work.catch(() => {});
  return {
    object: 'async_task',
    id: task.id,
    status: 'queued',
    status_url: `${originOf(context.request)}/api/functions/v1/async_tasks/${encodeURIComponent(task.id)}`,
    created_time: createdAt,
    poll_after_seconds: 1,
    operation: { surface: 'rest', name: operationName },
  };
}

async function getAsyncTaskEndpoint(context: FunctionContext, taskId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const task = await getExisting(context.admin.db('app').table<AsyncTask>('mcp_async_tasks'), taskId);
  const bearerGrantId = context.compatBearer?.grant.id;
  if (
    !task
    || task.userId !== auth.id
    || (task.grantId !== undefined && task.grantId !== bearerGrantId)
  ) {
    throw new Error('Async task was not found.');
  }
  const status = task.status === 'completed' || task.status === 'succeeded'
    ? 'succeeded'
    : task.status === 'error' || task.status === 'failed'
      ? 'failed'
      : task.status === 'running' || task.status === 'retrying'
        ? task.status
        : 'queued';
  const operationValue = isRecord(task.operation) ? task.operation : {};
  const operationSurface = operationValue.surface === 'rest' ? 'rest' : 'mcp';
  const operationName = optionalString(operationValue.name) || 'unknown';
  return {
    object: 'async_task',
    id: task.id,
    status,
    status_url: `${originOf(request)}/api/functions/v1/async_tasks/${encodeURIComponent(task.id)}`,
    created_time: task.createdAt ?? new Date(0).toISOString(),
    operation: { surface: operationSurface, name: operationName },
    ...(status === 'succeeded' ? { result: task.result ?? null } : {}),
    ...(status === 'failed' ? { error: isRecord(task.error) ? task.error : { object: 'error', status: 500, code: 'internal_server_error', message: String(task.error ?? 'Async task failed.') } } : {}),
    ...(!['succeeded', 'failed'].includes(status) ? { poll_after_seconds: task.pollAfterSeconds ?? 1 } : {}),
  };
}

async function usersEndpoint(context: FunctionContext) {
  const { request } = context;
  const url = new URL(request.url);
  const needle = (url.searchParams.get('query') ?? '').trim().toLowerCase();
  const users = (await canonicalUserRoster(context)).filter((user) => {
    if (!needle) return true;
    const email = user.person.email ?? '';
    return `${user.name}\n${user.id}\n${email}`.toLowerCase().includes(needle);
  });
  return listObjectByIdCursor(users, 'user', request, (user) => user.id);
}

function customEmojisEndpoint(request: Request) {
  const url = new URL(request.url);
  notionPageSize(url.searchParams.get('page_size'));
  const cursor = notionStringCursor(url.searchParams.get('start_cursor'));
  if (cursor) throw new Error('start_cursor is invalid.');
  const name = url.searchParams.get('name');
  if (name !== null && typeof name !== 'string') throw new Error('name must be a string.');
  // Hanji currently has no workspace custom-emoji store. An empty, exact
  // official list shape is preferable to fabricating emoji objects or leaking
  // the typed-list metadata field that this endpoint's schema forbids.
  return {
    object: 'list',
    type: 'custom_emoji',
    results: [],
    has_more: false,
    next_cursor: null,
  };
}

async function searchEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const query = optionalString(body.query)?.toLowerCase() || '';
  const workspaceId = optionalString(body.workspace_id) || optionalString(body.workspaceId);
  if (body.filter !== undefined && !isRecord(body.filter)) throw new Error('filter must be an object.');
  if (body.sort !== undefined && !isRecord(body.sort)) throw new Error('sort must be an object.');
  const filter = isRecord(body.filter) ? body.filter : {};
  const value = optionalString(filter.value);
  if (value && !['page', 'data_source'].includes(value)) {
    throw new Error('filter.value must be page or data_source.');
  }
  if (value && filter.property !== 'object') {
    throw new Error('filter.property must be object when filter.value is provided.');
  }
  if (filter.in_trash !== undefined && typeof filter.in_trash !== 'boolean') {
    throw new Error('filter.in_trash must be a boolean.');
  }
  const inTrash = filter.in_trash === true;
  const sort = isRecord(body.sort) ? body.sort : null;
  if (sort) {
    const relevanceSort = sort.property === 'relevance';
    const timestampSort = sort.timestamp === 'last_edited_time'
      && ['ascending', 'descending'].includes(String(sort.direction));
    if (!relevanceSort && !timestampSort) {
      throw new Error('sort must select relevance or last_edited_time with an ascending/descending direction.');
    }
  }
  const start = cursorOffset(body.start_cursor);
  const size = pageSize(body.page_size);
  const entries = await workspaceDbsForOptionalHint(context, workspaceId);
  const budget = materializationBudget();
  const matches: Array<{ db: DbRef; page: Page }> = [];
  for (const entry of entries) {
    const pages = await listAllBounded(
      entry.db.table<Page>('pages').where('workspaceId', '==', entry.workspaceId),
      budget,
      'Search',
    );
    pages.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
    for (const page of pages) {
      if (page.inTrash === true !== inTrash) continue;
      if (query && !(page.title || '').toLowerCase().includes(query)) continue;
      if (value === 'page' && page.kind === 'database') continue;
      if (value === 'data_source' && page.kind !== 'database') continue;
      try {
        await requireReadablePage(entry.db, page.id, auth.id, auth.email, context.compatBearer);
      } catch {
        continue;
      }
      matches.push({ db: entry.db, page });
    }
  }
  if (sort?.timestamp === 'last_edited_time') {
    const direction = sort.direction === 'descending' ? -1 : 1;
    matches.sort((left, right) => {
      const leftTime = left.page.updatedAt ?? left.page.createdAt ?? '';
      const rightTime = right.page.updatedAt ?? right.page.createdAt ?? '';
      return leftTime === rightTime ? left.page.id.localeCompare(right.page.id) : leftTime < rightTime ? -direction : direction;
    });
  } else if (sort?.property === 'relevance' && query) {
    matches.sort((left, right) => {
      const leftTitle = (left.page.title || '').toLowerCase();
      const rightTitle = (right.page.title || '').toLowerCase();
      const leftIndex = leftTitle.indexOf(query);
      const rightIndex = rightTitle.indexOf(query);
      return leftIndex - rightIndex || leftTitle.length - rightTitle.length || left.page.id.localeCompare(right.page.id);
    });
  }
  const windowed = matches.slice(start, start + size);
  const results: unknown[] = [];
  for (const { db, page } of windowed) {
    if (page.kind === 'database') {
      results.push(await notionDataSource(context, db, page, await databaseProperties(db, page.id), request));
    } else {
      const props = page.parentType === 'database' && page.parentId
        ? await databaseProperties(db, page.parentId)
        : [];
      results.push(notionPage(await pageWithComputedProperties(context, page, props), props, request));
    }
  }
  const hasMore = start + results.length < matches.length;
  return {
    object: 'list',
    results,
    next_cursor: hasMore ? String(start + results.length) : null,
    has_more: hasMore,
    type: 'page_or_data_source',
    page_or_data_source: {},
  };
}

function routeParts(context: FunctionContext) {
  const slug = context.params?.slug || '';
  return slug.split('/').map((part) => part.trim()).filter(Boolean);
}

function notionOAuthTokenEndpoint(context: FunctionContext) {
  return handleNotionCompatOAuthRequest(context, 'token');
}

function notionOAuthRevokeEndpoint(context: FunctionContext) {
  return handleNotionCompatOAuthRequest(context, 'revoke');
}

function notionOAuthIntrospectEndpoint(context: FunctionContext) {
  return handleNotionCompatOAuthRequest(context, 'introspect');
}

export function notionScopesForRoute(method: string, parts: string[]) {
  // Several current Notion read operations use POST because they carry a
  // structured query body. Classify those by operation semantics rather than
  // by HTTP verb so a read-only OAuth grant is not incorrectly forced to ask
  // for write access.
  if (method === 'POST' && parts[0] === 'search') {
    return ['pages:read', 'databases:read'];
  }
  if (
    method === 'POST'
    && (parts[0] === 'databases' || parts[0] === 'data_sources')
    && parts[2] === 'query'
  ) {
    return ['databases:read'];
  }
  if (method === 'POST' && parts[0] === 'views' && parts[2] === 'queries') {
    return ['databases:read'];
  }
  if (
    method === 'POST'
    && parts[0] === 'blocks'
    && parts[1] === 'meeting_notes'
    && parts[2] === 'query'
  ) {
    return ['pages:read', 'databases:read'];
  }
  const write = method !== 'GET';
  if (parts[0] === 'comments') return [`comments:${write ? 'write' : 'read'}`];
  if (parts[0] === 'file_uploads') return [`files:${write ? 'write' : 'read'}`];
  if (parts[0] === 'databases' || parts[0] === 'data_sources' || parts[0] === 'views') {
    return [`databases:${write ? 'write' : 'read'}`];
  }
  if (parts[0] === 'pages' || parts[0] === 'blocks' || parts[0] === 'search') {
    return [`pages:${write ? 'write' : 'read'}`];
  }
  return ['workspace:read'];
}

function notionBearerContext(
  context: FunctionContext,
  bearer: NotionCompatBearerIdentity,
): FunctionContext {
  const originalAdmin = context.admin;
  return {
    ...context,
    auth: { id: bearer.id, email: bearer.email },
    compatWorkspaceId: bearer.workspaceId,
    compatBearer: bearer,
    admin: {
      db(namespace: string, instanceId?: string) {
        if (namespace === 'workspace' && instanceId && instanceId !== bearer.workspaceId) {
          throw Object.assign(new Error('The token is not authorized for this workspace.'), { status: 403 });
        }
        return originalAdmin.db(namespace, instanceId);
      },
    },
  };
}

async function queryMeetingNotesEndpoint(
  context: FunctionContext,
  body: Record<string, unknown>,
) {
  const auth = context.auth;
  if (!auth?.id) throw new Error('Authentication required.');
  const workspaceId = context.compatWorkspaceId || workspaceIdFromRequest(context.request, body);
  if (!workspaceId) throw new Error('workspace_id is required for meeting note queries.');
  const db = boundedDbFromWorkspaceHint(context.admin, workspaceId);
  await requireWorkspaceRole(db, workspaceId, auth.id, 'view');
  return queryMeetingNotes({
    db,
    workspaceId,
    actorId: auth.id,
    actorEmail: auth.email,
    allowedPageIds: context.compatBearer
      ? context.compatBearer.grant.pageIds ?? []
      : normalizeIdArray(body.allowed_page_ids),
    allowedDatabaseIds: context.compatBearer
      ? context.compatBearer.grant.databaseIds ?? []
      : normalizeIdArray(body.allowed_database_ids),
  }, body);
}

async function dispatch(rawContext: FunctionContext) {
  const request = rawContext.request;
  const method = request.method.toUpperCase();
  const parts = routeParts(rawContext);
  if (method === 'POST' && parts[0] === 'oauth' && parts[1] === 'token' && parts.length === 2) {
    return notionOAuthTokenEndpoint(rawContext);
  }
  if (method === 'POST' && parts[0] === 'oauth' && parts[1] === 'revoke' && parts.length === 2) {
    return notionOAuthRevokeEndpoint(rawContext);
  }
  if (method === 'POST' && parts[0] === 'oauth' && parts[1] === 'introspect' && parts.length === 2) {
    return notionOAuthIntrospectEndpoint(rawContext);
  }
  let bearer: NotionCompatBearerIdentity | null = null;
  if (!rawContext.auth?.id) {
    try {
      bearer = await resolveNotionCompatBearer(rawContext);
    } catch (error) {
      console.error('[notion-compat] bearer resolution failed:', error);
      return notionError(500, 'internal_server_error', 'Authentication could not be completed.');
    }
  }
  const context = bearer ? notionBearerContext(rawContext, bearer) : rawContext;
  const { auth } = context;
  if (!auth?.id) return notionError(401, 'unauthorized', 'Authentication required.');
  if (bearer) {
    const requiredScopes = notionScopesForRoute(method, parts);
    const missingScopes = requiredScopes.filter((scope) => !bearer.scopes.includes(scope));
    if (missingScopes.length) {
      return notionError(
        403,
        'restricted_resource',
        `The token requires ${missingScopes.join(' and ')}.`,
      );
    }
  }
  const parsesJsonBody = method !== 'GET' && method !== 'DELETE' && !(parts[0] === 'file_uploads' && parts[2] === 'send');
  let body: Record<string, unknown> = {};
  if (parsesJsonBody) {
    try {
      body = await requestJson(request);
    } catch (error) {
      const status = 400;
      const code = error && typeof error === 'object' && typeof (error as { notionCode?: unknown }).notionCode === 'string'
        ? String((error as { notionCode: string }).notionCode)
        : 'invalid_json';
      return notionError(status, code, error instanceof Error ? error.message : 'The request body contains invalid JSON.');
    }
  }
  if (bearer) {
    const parent = isRecord(body.parent) ? body.parent : {};
    const requestedWorkspaceId = workspaceIdFromRequest(request, body)
      || optionalString(parent.workspace_id)
      || optionalString(parent.teamspace_id);
    if (requestedWorkspaceId && requestedWorkspaceId !== bearer.workspaceId) {
      return notionError(403, 'restricted_resource', 'The token is not authorized for this workspace.');
    }
    body = { workspace_id: bearer.workspaceId, ...body };
  }
  const url = new URL(request.url);

  try {
    notionVersion(request);
    if (method === 'GET' && parts[0] === 'users' && parts[1] === 'me' && parts.length === 2) {
      return json(await getUserEndpoint(context, 'me'));
    }
    if (method === 'GET' && parts[0] === 'users' && parts.length === 1) {
      return json(await usersEndpoint(context));
    }
    if (method === 'GET' && parts[0] === 'users' && parts[1] && parts.length === 2) {
      return json(await getUserEndpoint(context, parts[1]));
    }
    if (method === 'GET' && parts[0] === 'custom_emojis' && parts.length === 1) {
      return json(customEmojisEndpoint(request));
    }
    if (method === 'POST' && parts[0] === 'search' && parts.length === 1) {
      return json(await searchEndpoint(context, body));
    }
    if (method === 'POST' && parts[0] === 'pages' && parts.length === 1) {
      if (body.allow_async === true) {
        await createPageEndpoint(context, body, true);
        const queuedBody = { ...body, id: optionalString(body.id) || newId() };
        return json(await queueRestAsyncTask(
          context,
          'POST /v1/pages',
          () => createPageEndpoint(context, queuedBody),
        ), 202);
      }
      return json(await createPageEndpoint(context, body));
    }
    if (method === 'POST' && parts[0] === 'pages' && parts[1] && parts[2] === 'move' && parts.length === 3) {
      return json(await movePageEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'pages' && parts[1] && parts[2] === 'markdown' && parts.length === 3) {
      return json(await pageMarkdownEndpoint(
        context,
        parts[1],
        includeTranscriptForMarkdown(request),
      ));
    }
    if (method === 'PATCH' && parts[0] === 'pages' && parts[1] && parts[2] === 'markdown' && parts.length === 3) {
      if (body.allow_async === true) {
        const prepared = await preparePageMarkdownUpdate(context, parts[1], body);
        return json(await queueRestAsyncTask(
          context,
          'PATCH /v1/pages/:page_id/markdown',
          () => applyPreparedPageMarkdownUpdate(context, prepared),
        ), 202);
      }
      return json(await updatePageMarkdownEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'pages' && parts[1] && parts.length === 2) {
      const pageDb = await boundedDbFromPageHint(context.admin, parts[1]);
      const page = await requireReadablePage(pageDb, parts[1], auth.id, auth.email, context.compatBearer);
      const props = page.parentType === 'database' && page.parentId ? await databaseProperties(pageDb, page.parentId) : [];
      return json(notionPage(await pageWithComputedProperties(context, page, props), props, request));
    }
    if (method === 'PATCH' && parts[0] === 'pages' && parts[1] && parts.length === 2) {
      return json(await updatePageEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'pages' && parts[1] && parts[2] === 'properties' && parts[3] && parts.length === 4) {
      const pageDb = await boundedDbFromPageHint(context.admin, parts[1]);
      const page = await requireReadablePage(pageDb, parts[1], auth.id, auth.email, context.compatBearer);
      const props = page.parentType === 'database' && page.parentId ? await databaseProperties(pageDb, page.parentId) : [];
      const prop = propByNameOrId(props, parts[3]) ?? (props.length === 0 && parts[3] === 'title'
        ? { id: 'title', databaseId: page.id, name: 'title', type: 'title', position: 1 }
        : undefined);
      if (!prop) throw new Error('Property was not found.');
      if (prop.type === 'location' || prop.type === 'last_visited_time') {
        throw new Error(`Notion defines no page property-item response for ${prop.type}.`);
      }
      return json(await propertyItemResponse(
        context,
        pageDb,
        await pageWithComputedProperties(context, page, props),
        prop,
        request,
      ));
    }
    if (method === 'GET' && parts[0] === 'blocks' && parts[1] && parts.length === 2) {
      const pageDb = await blockRoutedDb(context, parts[1]);
      const block = await getExisting(pageDb.table<Block>('blocks'), parts[1]);
      if (block) {
        await requireReadablePage(pageDb, block.pageId, auth.id, auth.email, context.compatBearer);
        return json(await notionBlockFromLocal(context, pageDb, block, request));
      }
      const page = await requireReadablePage(pageDb, parts[1], auth.id, auth.email, context.compatBearer);
      return json(await notionChildPageBlock(pageDb, page, request));
    }
    if (method === 'POST' && parts[0] === 'blocks' && parts[1] === 'meeting_notes' && parts[2] === 'query' && parts.length === 3) {
      return json(await queryMeetingNotesEndpoint(context, body));
    }
    if (method === 'GET' && parts[0] === 'blocks' && parts[1] && parts[2] === 'children' && parts.length === 3) {
      return json(await listBlockChildren(context, parts[1]));
    }
    if (method === 'PATCH' && parts[0] === 'blocks' && parts[1] && parts[2] === 'children' && parts.length === 3) {
      return json(await appendBlockChildren(context, parts[1], body));
    }
    if (method === 'PATCH' && parts[0] === 'blocks' && parts[1] && parts.length === 2) {
      return json(await updateBlockEndpoint(context, parts[1], body));
    }
    if (method === 'DELETE' && parts[0] === 'blocks' && parts[1] && parts.length === 2) {
      return json(await deleteBlockEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'databases' && parts.length === 1) {
      return json(await createDatabaseEndpoint(context, body));
    }
    if (method === 'GET' && parts[0] === 'databases' && parts.length === 1) {
      return json(await listDatabasesEndpoint(context));
    }
    if (method === 'GET' && parts[0] === 'databases' && parts[1] && parts.length === 2) {
      const dbRouted = await boundedDbFromPageHint(context.admin, parts[1]);
      const database = await requireReadablePage(dbRouted, parts[1], auth.id, auth.email, context.compatBearer);
      if (database.kind !== 'database' || dataSourceParentDatabaseId(database) !== database.id) {
        throw new Error('Database was not found.');
      }
      return json(await notionDatabase(context, dbRouted, database, request));
    }
    if (method === 'PATCH' && parts[0] === 'databases' && parts[1] && parts.length === 2) {
      return json(await updateDatabaseEndpoint(context, parts[1], body));
    }
    if (method === 'POST' && parts[0] === 'databases' && parts[1] && parts[2] === 'query' && parts.length === 3) {
      return json(await queryDataSourceEndpoint(context, parts[1], body));
    }
    if (method === 'POST' && parts[0] === 'data_sources' && parts.length === 1) {
      return json(await createDataSourceEndpoint(context, body));
    }
    if (method === 'GET' && parts[0] === 'data_sources' && parts.length === 1) {
      return json(await listDataSourcesEndpoint(context));
    }
    if (method === 'GET' && parts[0] === 'data_sources' && parts[1] && parts.length === 2) {
      const dsRouted = await boundedDbFromPageHint(context.admin, parts[1]);
      const dataSource = await requireReadablePage(dsRouted, parts[1], auth.id, auth.email, context.compatBearer);
      if (dataSource.kind !== 'database') throw new Error('Data source was not found.');
      return json(await notionDataSource(context, dsRouted, dataSource, await databaseProperties(dsRouted, dataSource.id), request));
    }
    if (method === 'PATCH' && parts[0] === 'data_sources' && parts[1] && parts.length === 2) {
      return json(await updateDataSourceEndpoint(context, parts[1], body));
    }
    if (method === 'DELETE' && parts[0] === 'data_sources' && parts[1] && parts.length === 2) {
      return json(await trashDataSourceEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'query' && parts.length === 3) {
      return json(await queryDataSourceEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'templates' && parts.length === 3) {
      return json(await listTemplatesEndpoint(context, parts[1]));
    }
    if (method === 'GET' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'views' && parts.length === 3) {
      return json(await listViewsEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'views' && parts.length === 3) {
      return json(await createViewEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'views' && parts.length === 1) {
      const dataSourceId = requireString(
        url.searchParams.get('data_source_id') || url.searchParams.get('database_id'),
        'database_id or data_source_id',
      );
      return json(await listViewsEndpoint(context, dataSourceId, true));
    }
    if (method === 'POST' && parts[0] === 'views' && parts.length === 1) {
      const dataSourceId = requireString(body.data_source_id, 'data_source_id');
      return json(await createViewEndpoint(context, dataSourceId, body, true));
    }
    if (method === 'POST' && parts[0] === 'views' && parts[1] && parts[2] === 'queries' && parts.length === 3) {
      return json(await createViewQueryEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'views' && parts[1] && parts[2] === 'queries' && parts[3] && parts.length === 4) {
      return json(await getViewQueryEndpoint(context, parts[1], parts[3]));
    }
    if (method === 'DELETE' && parts[0] === 'views' && parts[1] && parts[2] === 'queries' && parts[3] && parts.length === 4) {
      return json(await deleteViewQueryEndpoint(context, parts[1], parts[3]));
    }
    if (method === 'GET' && parts[0] === 'views' && parts[1] && parts.length === 2) {
      return json(await getViewEndpoint(context, parts[1]));
    }
    if (method === 'PATCH' && parts[0] === 'views' && parts[1] && parts.length === 2) {
      return json(await updateViewEndpoint(context, parts[1], body));
    }
    if (method === 'DELETE' && parts[0] === 'views' && parts[1] && parts.length === 2) {
      return json(await deleteViewEndpoint(context, parts[1]));
    }
    if (method === 'GET' && parts[0] === 'async_tasks' && parts[1] && parts.length === 2) {
      return json(await getAsyncTaskEndpoint(context, parts[1]));
    }
    if (method === 'GET' && parts[0] === 'comments' && parts.length === 1) {
      return json(await listCommentsEndpoint(context));
    }
    if (method === 'POST' && parts[0] === 'comments' && parts.length === 1) {
      return json(await createCommentEndpoint(context, body));
    }
    if (method === 'GET' && parts[0] === 'comments' && parts[1] && parts.length === 2) {
      return json(await getCommentEndpoint(context, parts[1]));
    }
    if (method === 'PATCH' && parts[0] === 'comments' && parts[1] && parts.length === 2) {
      return json(await updateCommentEndpoint(context, parts[1], body));
    }
    if (method === 'DELETE' && parts[0] === 'comments' && parts[1] && parts.length === 2) {
      return json(await deleteCommentEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'file_uploads' && parts.length === 1) {
      return json(await createFileUploadEndpoint(context, body));
    }
    if (method === 'GET' && parts[0] === 'file_uploads' && parts.length === 1) {
      return json(await listFileUploadsEndpoint(context));
    }
    if (method === 'GET' && parts[0] === 'file_uploads' && parts[1] && parts.length === 2) {
      return json(await getFileUploadEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'file_uploads' && parts[1] && parts[2] === 'send' && parts.length === 3) {
      return json(await sendFileUploadEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'file_uploads' && parts[1] && parts[2] === 'complete' && parts.length === 3) {
      return json(await completeFileUploadEndpoint(context, parts[1]));
    }
    return notionError(404, 'object_not_found', `Unsupported Notion-compatible endpoint: ${method} /v1/${parts.join('/')}`);
  } catch (error) {
    const mapped = notionCompatErrorStatus(error);
    const explicitCode = error && typeof error === 'object'
      && typeof (error as { notionCode?: unknown }).notionCode === 'string'
      ? String((error as { notionCode: string }).notionCode)
      : null;
    return notionError(mapped.status, explicitCode || errorCodeForStatus(mapped.status), mapped.message);
  }
}

export const notionCompatHandler = (context: unknown) => dispatch(context as FunctionContext);

export const GET = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: notionCompatHandler,
});
export const POST = defineFunction({
  trigger: { type: 'http' },
  // EdgeBase deliberately caps buffered function requests at 16 MiB. Larger
  // file parts must use a direct/streaming storage path instead of preventing
  // every product function from registering at worker startup.
  maxRequestBodyBytes: 16 * 1024 * 1024,
  handler: notionCompatHandler,
});
export const PATCH = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: notionCompatHandler,
});
export const DELETE = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: notionCompatHandler,
});
