import { defineFunction } from '@edge-base/shared';
import {
  accessibleWorkspaceIdsForActor,
  boundedDbForPage,
  boundedDbFromPageHint,
  boundedDbFromWorkspaceHint,
  ensurePageWorkspaceIndex,
} from '../../../lib/workspace-db';
import { errorStatus } from '../../../lib/error-status';
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
  databaseId?: string;
  propertyId?: string;
  name?: string;
  contentType?: string;
  size?: number;
  status?: 'pending' | 'uploaded' | 'deleted' | 'expired' | 'failed';
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
  numberOfPartsTotal?: number;
  numberOfPartsSent?: number;
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
}

interface SelectOption {
  id: string;
  name: string;
  color?: string;
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
const supportedViewTypes = new Set(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']);
const notionViewTypes = new Set([...supportedViewTypes, 'form', 'chart', 'map', 'dashboard']);

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function notionError(status: number, code: string, message: string) {
  return json({ object: 'error', status, code, message }, status);
}

function errorCodeForStatus(status: number) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'restricted_resource';
  if (status === 404) return 'object_not_found';
  if (status === 409 || status === 423) return 'conflict_error';
  if (status >= 500) return 'internal_server_error';
  return 'validation_error';
}

function statusFromMessage(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes('authentication')) return 401;
  if (lower.includes('access required') || lower.includes('restricted')) return 403;
  if (lower.includes('not found')) return 404;
  if (lower.includes('locked')) return 423;
  return 400;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

function requireSupportedViewType(value: unknown, fallback = 'table') {
  if (value !== undefined && value !== null && value !== '' && typeof value !== 'string') {
    throw new Error('View type must be a string.');
  }
  const type = optionalString(value)?.toLowerCase() || fallback;
  if (supportedViewTypes.has(type)) return type;
  if (notionViewTypes.has(type)) {
    throw new Error(
      `Hanji does not support the Notion ${type} view type yet. Supported view types: ${Array.from(supportedViewTypes).join(', ')}.`,
    );
  }
  throw new Error(
    `Unsupported view type "${type}". Supported view types: ${Array.from(supportedViewTypes).join(', ')}.`,
  );
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

async function listTable<T>(table: TableRef<T>): Promise<T[]> {
  return listAll(table);
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

async function requirePageRole(
  db: DbRef,
  pageId: string,
  actorId: string,
  minimum: ShareRole,
  actorEmail?: string | null,
) {
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (!page) throw new Error('Page was not found.');
  const role = await pageAccessRole(db, page, actorId, undefined, actorEmail);
  if (!roleAtLeast(role, minimum)) throw new Error('Page access required.');
  return page;
}

async function requireReadablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  return requirePageRole(db, pageId, actorId, 'view', actorEmail);
}

async function requireWritablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  const page = await requirePageRole(db, pageId, actorId, 'edit', actorEmail);
  if (page.inTrash) throw new Error('Page is in trash.');
  if (page.isLocked) throw new Error('Page is locked.');
  return page;
}

async function requireCommentablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  const page = await requirePageRole(db, pageId, actorId, 'comment', actorEmail);
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
    return base;
  });
}

function optionList(prop: DbProperty): SelectOption[] {
  const options = prop.config?.options;
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is SelectOption => isRecord(item) && typeof item.name === 'string');
}

function notionOption(option: SelectOption | string | null | undefined) {
  if (!option) return null;
  if (typeof option === 'string') {
    return { id: option, name: option, color: 'default' };
  }
  return { id: option.id, name: option.name, color: option.color || 'default' };
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
      return {
        name,
        type: 'external',
        external: { url },
      };
    });
}

function localFileFromNotion(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((file) => {
    const externalUrl = isRecord(file.external) ? optionalString(file.external.url) : undefined;
    const fileUrl = isRecord(file.file) ? optionalString(file.file.url) : undefined;
    const url = externalUrl || fileUrl || '';
    return {
      id: optionalString(file.id) || newId(),
      name: optionalString(file.name) || url || 'Untitled',
      url,
      sourceUrl: externalUrl,
      notionFileSource: file.type === 'file' ? 'file' : 'external',
    };
  });
}

function notionUser(id: string, email?: string | null, name?: string | null) {
  return {
    object: 'user',
    id,
    name: name || email || id,
    avatar_url: null,
    type: 'person',
    person: { email: email || null },
  };
}

async function getUserEndpoint(context: FunctionContext, userId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  if (userId === 'me' || userId === auth.id) return notionUser(auth.id, auth.email ?? null);
  const db = context.admin.db('app');
  const memberships = await listAll(db.table<WorkspaceMember>('workspace_members').where('userId', '==', userId));
  for (const member of memberships) {
    try {
      await requireWorkspaceRole(db, member.workspaceId, auth.id, 'view');
      return notionUser(member.userId, member.email ?? null, member.displayName ?? null);
    } catch {
      // Keep looking in another shared workspace.
    }
  }
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

function localValueForProperty(page: Page, prop: DbProperty) {
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
  if (typeof value === 'string') return { type: 'string', string: value };
  return { type: 'string', string: value == null ? null : String(value) };
}

function notionRollupValue(value: unknown) {
  if (Array.isArray(value)) return { type: 'array', array: value };
  if (typeof value === 'number') return { type: 'number', number: value };
  if (value && typeof value === 'object') return { type: 'unsupported', unsupported: value };
  return { type: 'array', array: [] };
}

function notionPropertyValue(page: Page, prop: DbProperty) {
  const type = propertyNotionType(prop.type);
  const value = localValueForProperty(page, prop);
  if (prop.type === 'title') return { id: prop.id, type, title: richTextFromPlainText(value) };
  if (prop.type === 'rich_text') return { id: prop.id, type, rich_text: richTextFromPlainText(value) };
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
  if (prop.type === 'relation') return { id: prop.id, type, relation: normalizeIdArray(value).map((id) => ({ id })), has_more: false };
  if (prop.type === 'person') return { id: prop.id, type, people: normalizeIdArray(value).map((id) => notionUser(id)) };
  if (prop.type === 'files') return { id: prop.id, type, files: fileFromLocal(value) };
  if (prop.type === 'created_time') return { id: prop.id, type, created_time: page.createdAt ?? null };
  if (prop.type === 'last_edited_time') return { id: prop.id, type, last_edited_time: page.updatedAt ?? null };
  if (prop.type === 'created_by') return { id: prop.id, type, created_by: notionUser(page.createdBy || '') };
  if (prop.type === 'last_edited_by') return { id: prop.id, type, last_edited_by: notionUser(page.lastEditedBy || '') };
  if (prop.type === 'formula') return { id: prop.id, type, formula: notionFormulaValue(value) };
  if (prop.type === 'rollup') return { id: prop.id, type, rollup: notionRollupValue(value) };
  if (prop.type === 'unique_id') {
    const prefix = optionalString(prop.config?.idPrefix) || null;
    return { id: prop.id, type, unique_id: { prefix, number: typeof value === 'number' ? value : value == null ? null : Number(value) } };
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
    return items.map((item, index) => ({
      ...propertyItemBase(prop),
      id: `${prop.id}:${index}`,
      [type]: item,
    }));
  }
  if (type === 'people' || type === 'relation' || type === 'files') {
    const items = Array.isArray(value[type]) ? value[type] : [];
    return items.map((item, index) => ({
      ...propertyItemBase(prop),
      id: `${prop.id}:${index}`,
      [type]: item,
    }));
  }
  return [{ ...propertyItemBase(prop), [type]: value[type] ?? null }];
}

function propertyItemResponse(page: Page, prop: DbProperty, request: Request) {
  const url = new URL(request.url);
  const start = cursorOffset(url.searchParams.get('start_cursor'));
  const size = pageSize(url.searchParams.get('page_size'));
  const items = propertyItemsForPage(page, prop);
  const type = propertyNotionType(prop.type);
  if (type === 'title' || type === 'rich_text' || type === 'people' || type === 'relation' || type === 'files') {
    return listObject(items, 'property_item', { id: prop.id, type }, start, size);
  }
  return items[0] ?? { ...propertyItemBase(prop), [type]: null };
}

function notionPropertiesForPage(page: Page, props: DbProperty[]) {
  const out: Record<string, unknown> = {};
  for (const prop of props.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    out[prop.name || prop.id] = notionPropertyValue(page, prop);
  }
  if (props.length === 0) {
    out.title = { id: 'title', type: 'title', title: richTextFromPlainText(page.title ?? '') };
  }
  return out;
}

function notionParent(page: Page) {
  if (page.parentType === 'database' && page.parentId) {
    return { type: 'data_source_id', data_source_id: page.parentId, database_id: page.parentId };
  }
  if (page.parentType === 'page' && page.parentId) return { type: 'page_id', page_id: page.parentId };
  return { type: 'workspace', workspace: true, workspace_id: page.workspaceId };
}

function notionIcon(page: Page) {
  if (!page.icon || page.iconType === 'none') return null;
  if (page.iconType === 'emoji') return { type: 'emoji', emoji: page.icon };
  return { type: 'external', external: { url: page.icon } };
}

function notionCover(page: Page) {
  if (!page.cover) return null;
  return { type: 'external', external: { url: page.cover } };
}

function notionPage(page: Page, props: DbProperty[], request: Request) {
  return {
    object: 'page',
    id: page.id,
    created_time: page.createdAt ?? null,
    last_edited_time: page.updatedAt ?? page.createdAt ?? null,
    created_by: notionUser(page.createdBy || ''),
    last_edited_by: notionUser(page.lastEditedBy || page.createdBy || ''),
    cover: notionCover(page),
    icon: notionIcon(page),
    parent: notionParent(page),
    archived: page.inTrash === true,
    in_trash: page.inTrash === true,
    is_locked: page.isLocked === true,
    properties: notionPropertiesForPage(page, props),
    url: pageUrl(page, request),
    public_url: page.isPublic ? pageUrl(page, request) : null,
  };
}

function notionPropertySchema(prop: DbProperty) {
  const type = propertyNotionType(prop.type);
  const config = prop.config ?? {};
  const base: Record<string, unknown> = {
    id: prop.id,
    name: prop.name,
    type,
    description: prop.description ?? null,
  };
  if (type === 'select' || type === 'multi_select' || type === 'status') {
    base[type] = { options: optionList(prop).map((option) => notionOption(option)) };
  } else if (type === 'number') {
    base.number = { format: config.numberFormat || 'number' };
  } else if (type === 'relation') {
    base.relation = {
      data_source_id: config.relationDatabaseId || prop.databaseId,
      database_id: config.relationDatabaseId || prop.databaseId,
      type: 'single_property',
      single_property: {},
    };
  } else if (type === 'formula') {
    base.formula = { expression: config.formula || '' };
  } else if (type === 'rollup') {
    base.rollup = {
      relation_property_id: config.rollupRelationPropertyId || null,
      rollup_property_id: config.rollupTargetPropertyId || null,
      function: config.rollupFunction || 'show_original',
    };
  } else if (type === 'unique_id') {
    base.unique_id = { prefix: config.idPrefix || null };
  } else {
    base[type] = {};
  }
  return base;
}

function notionPropertySchemaMap(props: DbProperty[]) {
  const out: Record<string, unknown> = {};
  for (const prop of props.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    out[prop.name || prop.id] = notionPropertySchema(prop);
  }
  return out;
}

function pageTitleRichText(page: Page) {
  return richTextFromPlainText(page.title ?? '');
}

function notionDatabase(page: Page, props: DbProperty[], request: Request) {
  return {
    object: 'database',
    id: page.id,
    created_time: page.createdAt ?? null,
    last_edited_time: page.updatedAt ?? page.createdAt ?? null,
    title: pageTitleRichText(page),
    description: [],
    icon: notionIcon(page),
    cover: notionCover(page),
    parent: notionParent(page),
    archived: page.inTrash === true,
    in_trash: page.inTrash === true,
    is_inline: page.parentType !== 'workspace',
    properties: notionPropertySchemaMap(props),
    data_sources: [
      {
        id: page.id,
        name: page.title || 'Untitled',
      },
    ],
    url: pageUrl(page, request),
    public_url: page.isPublic ? pageUrl(page, request) : null,
  };
}

function dataSourceParentDatabaseId(page: Page) {
  const marker = page.properties?.notionParentDatabaseId;
  return typeof marker === 'string' && marker.trim() ? marker.trim() : page.id;
}

function notionDataSource(page: Page, props: DbProperty[], request: Request) {
  return {
    object: 'data_source',
    id: page.id,
    name: page.title || 'Untitled',
    created_time: page.createdAt ?? null,
    last_edited_time: page.updatedAt ?? page.createdAt ?? null,
    parent: { type: 'database_id', database_id: dataSourceParentDatabaseId(page) },
    archived: page.inTrash === true,
    in_trash: page.inTrash === true,
    properties: notionPropertySchemaMap(props),
    url: pageUrl(page, request),
  };
}

async function databaseProperties(db: DbRef, databaseId: string) {
  return listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId));
}

function propByNameOrId(props: DbProperty[], nameOrId: string) {
  return props.find((prop) => prop.id === nameOrId || prop.name === nameOrId);
}

async function localPropertyPatchFromNotion(
  db: DbRef,
  props: DbProperty[],
  properties: unknown,
) {
  const out: { title?: string; properties: Record<string, unknown> } = { properties: {} };
  if (!isRecord(properties)) return out;
  for (const [key, value] of Object.entries(properties)) {
    const prop = propByNameOrId(props, key);
    if (!prop || !isRecord(value)) continue;
    const type = propertyLocalType(typeof value.type === 'string' ? value.type : prop.type);
    if (prop.type === 'title' || type === 'title') {
      out.title = richTextToPlainText(value.title);
    } else if (prop.type === 'rich_text' || type === 'rich_text') {
      out.properties[prop.id] = richTextToPlainText(value.rich_text);
    } else if (prop.type === 'number') {
      out.properties[prop.id] = typeof value.number === 'number' ? value.number : null;
    } else if (prop.type === 'select' || prop.type === 'status') {
      out.properties[prop.id] = value[prop.type] ? await ensureOptionValue(db, prop, value[prop.type]) : null;
    } else if (prop.type === 'multi_select') {
      const items = Array.isArray(value.multi_select) ? value.multi_select : [];
      out.properties[prop.id] = (
        await Promise.all(items.map((item, index) => ensureOptionValue(db, prop, item, index)))
      ).filter(Boolean);
    } else if (prop.type === 'date') {
      out.properties[prop.id] = localDateFromNotion(value.date);
    } else if (prop.type === 'checkbox') {
      out.properties[prop.id] = value.checkbox === true;
    } else if (prop.type === 'url') {
      out.properties[prop.id] = value.url == null ? null : String(value.url);
    } else if (prop.type === 'email') {
      out.properties[prop.id] = value.email == null ? null : String(value.email);
    } else if (prop.type === 'phone') {
      out.properties[prop.id] = value.phone_number == null ? null : String(value.phone_number);
    } else if (prop.type === 'relation') {
      out.properties[prop.id] = normalizeIdArray(value.relation);
    } else if (prop.type === 'person') {
      out.properties[prop.id] = normalizeIdArray(value.people);
    } else if (prop.type === 'files') {
      out.properties[prop.id] = localFileFromNotion(value.files);
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

function notionIconToLocal(value: unknown): Pick<Page, 'icon' | 'iconType'> {
  if (!isRecord(value)) return { icon: '', iconType: 'none' };
  if (value.type === 'emoji' && typeof value.emoji === 'string') return { icon: value.emoji, iconType: 'emoji' };
  if (value.type === 'external' && isRecord(value.external) && typeof value.external.url === 'string') {
    return { icon: value.external.url, iconType: 'image' };
  }
  if (value.type === 'file' && isRecord(value.file) && typeof value.file.url === 'string') {
    return { icon: value.file.url, iconType: 'image' };
  }
  return { icon: '', iconType: 'none' };
}

function notionCoverToLocal(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.external) && typeof value.external.url === 'string') return value.external.url;
  if (isRecord(value.file) && typeof value.file.url === 'string') return value.file.url;
  return undefined;
}

async function positionForChild(db: DbRef, workspaceId: string, parentId: string | null, parentType: PageParentType) {
  const siblings = (await listAll(db.table<Page>('pages').where('workspaceId', '==', workspaceId)))
    .filter((page) => (page.parentId ?? null) === parentId && (page.parentType ?? 'workspace') === parentType)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return (siblings.at(-1)?.position ?? 0) + 1;
}

async function resolveCreateParent(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const parent = isRecord(body.parent) ? body.parent : {};
  const workspaceIdInput = optionalString(body.workspace_id) || optionalString(parent.workspace_id) || optionalString(parent.teamspace_id);
  const pageId = optionalString(parent.page_id);
  const dataSourceId = optionalString(parent.data_source_id) || optionalString(parent.database_id);
  if (pageId) {
    const parentPage = await requireWritablePage(db, pageId, actorId, actorEmail);
    if ((parentPage.kind ?? 'page') !== 'page') throw new Error('Parent page is not a page.');
    return {
      workspaceId: parentPage.workspaceId,
      parentId: parentPage.id,
      parentType: 'page' as PageParentType,
    };
  }
  if (dataSourceId) {
    const database = await requireWritablePage(db, dataSourceId, actorId, actorEmail);
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
) {
  const parent = isRecord(body.parent) ? body.parent : {};
  const workspaceIdInput = optionalString(body.workspace_id) || optionalString(parent.workspace_id) || optionalString(parent.teamspace_id);
  const pageId = optionalString(parent.page_id);
  if (pageId) {
    const parentPage = await requireWritablePage(db, pageId, actorId, actorEmail);
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

function schemaPropertyFromNotion(databaseId: string, name: string, schema: unknown, position: number): DbProperty {
  const input = isRecord(schema) ? schema : {};
  const rawType =
    typeof input.type === 'string'
      ? input.type
      : Object.keys(input).find((key) => key !== 'id' && key !== 'name' && key !== 'description') || 'rich_text';
  const type = propertyLocalType(rawType);
  const typedConfig = isRecord(input[rawType]) ? (input[rawType] as Record<string, unknown>) : {};
  const config: Record<string, unknown> = {};
  if (type === 'select' || type === 'multi_select' || type === 'status') {
    config.options = Array.isArray(typedConfig.options)
      ? typedConfig.options.map((option, index) => {
          const record = isRecord(option) ? option : {};
          return {
            id: optionalString(record.id) || newId(),
            name: optionalString(record.name) || `Option ${index + 1}`,
            color: optionalString(record.color) || optionColors[index % optionColors.length],
          };
        })
      : [];
  }
  if (type === 'number') config.numberFormat = optionalString(typedConfig.format) || 'number';
  if (type === 'relation') {
    config.relationDatabaseId =
      optionalString(typedConfig.data_source_id) || optionalString(typedConfig.database_id) || databaseId;
  }
  if (type === 'formula') config.formula = optionalString(typedConfig.expression) || '';
  if (type === 'rollup') {
    config.rollupRelationPropertyId = optionalString(typedConfig.relation_property_id);
    config.rollupTargetPropertyId = optionalString(typedConfig.rollup_property_id);
    config.rollupFunction = optionalString(typedConfig.function) || 'show_original';
  }
  if (type === 'unique_id') config.idPrefix = optionalString(typedConfig.prefix) || '';
  return {
    id: optionalString(input.id) || newId(),
    databaseId,
    name: optionalString(input.name) || name,
    type,
    description: optionalString(input.description),
    config: Object.keys(config).length ? config : undefined,
    position,
  };
}

function schemaFromNotionProperties(databaseId: string, properties: unknown) {
  const out: DbProperty[] = [];
  if (isRecord(properties)) {
    let index = 1;
    for (const [name, schema] of Object.entries(properties)) {
      out.push(schemaPropertyFromNotion(databaseId, name, schema, index));
      index += 1;
    }
  }
  if (!out.some((prop) => prop.type === 'title')) {
    out.unshift({ id: newId(), databaseId, name: 'Name', type: 'title', position: 1 });
    out.forEach((prop, index) => {
      prop.position = index + 1;
    });
  }
  return out;
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

async function prepareBlocksUnder(
  db: DbRef,
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
      const typeContent = isRecord(blockInput[blockInput.type as string])
        ? (blockInput[blockInput.type as string] as Record<string, unknown>)
        : {};
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
  db: DbRef,
  pageId: string,
  parentId: string | null,
  children: unknown,
  actorId: string,
  startPosition?: number,
) {
  const prepared = await prepareBlocksUnder(db, pageId, parentId, children, actorId, startPosition);
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

async function applyPageTemplate(
  db: DbRef,
  page: Page,
  templateInput: unknown,
  actorId: string,
) {
  if (!isRecord(templateInput)) return {};
  if (page.parentType !== 'database' || !page.parentId) return {};
  const templates = await listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', page.parentId));
  const type = optionalString(templateInput.type) || (optionalString(templateInput.template_id) ? 'template_id' : 'default');
  const templateId = optionalString(templateInput.template_id);
  const template =
    type === 'template_id' && templateId
      ? templates.find((item) => item.id === templateId)
      : templates.find((item) => item.isDefault) ?? templates[0];
  if (!template) throw new Error('Template was not found.');
  const patch: Partial<Page> = {};
  if (typeof template.title === 'string') patch.title = template.title;
  if (isRecord(template.properties)) {
    patch.properties = { ...(page.properties ?? {}), ...template.properties };
  }
  const existingRoot = await listAll(db.table<Block>('blocks').where('pageId', '==', page.id));
  const start = existingRoot
    .filter((block) => !block.parentId)
    .reduce((max, block) => Math.max(max, block.position ?? 0), 0);
  await createTemplateBlocksUnder(db, page.id, null, template.blocks, actorId, start);
  return patch;
}

function compatWorkspaceHint(body: Record<string, unknown>) {
  const parent = (body.parent ?? {}) as Record<string, unknown>;
  const hint = body.workspace_id ?? parent.workspace_id ?? parent.teamspace_id;
  return typeof hint === 'string' && hint ? hint : undefined;
}

async function createPageEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const parentHints = body.parent as { page_id?: unknown; database_id?: unknown; data_source_id?: unknown } | undefined;
  const workspaceHint = compatWorkspaceHint(body);
  // Workspace-parent pages carry no page-shaped hint; route via workspace_id.
  const db =
    !parentHints?.page_id && !parentHints?.database_id && !parentHints?.data_source_id && workspaceHint
      ? boundedDbFromWorkspaceHint(context.admin, workspaceHint)
      : await boundedDbFromPageHint(context.admin, parentHints?.page_id, parentHints?.database_id, parentHints?.data_source_id);
  const parent = await resolveCreateParent(db, body, auth.id, auth.email);
  const now = nowIso();
  const isDatabaseRow = parent.parentType === 'database' && !!parent.parentId;
  const props = isDatabaseRow ? await databaseProperties(db, parent.parentId as string) : [];
  const propertyPatch = isDatabaseRow
    ? await localPropertyPatchFromNotion(db, props, body.properties)
    : { title: titleFromNotionProperties(body.properties), properties: {} };
  const icon = notionIconToLocal(body.icon);
  const page: Page = {
    id: optionalString(body.id) || newId(),
    workspaceId: parent.workspaceId,
    parentId: parent.parentId,
    parentType: parent.parentType,
    kind: 'page',
    title: propertyPatch.title ?? titleFromNotionProperties(body.properties) ?? '',
    icon: icon.icon,
    iconType: icon.iconType,
    cover: notionCoverToLocal(body.cover),
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties: propertyPatch.properties,
    isFavorite: false,
    isPublic: false,
    inTrash: false,
    position: await positionForChild(db, parent.workspaceId, parent.parentId, parent.parentType),
    createdBy: auth.id,
    lastEditedBy: auth.id,
    createdAt: now,
    updatedAt: now,
  };
  const preparedBlocks = await prepareBlocksUnder(db, page.id, null, body.children, auth.id);
  let inserted: Page | null = null;
  if (typeof db.transact === 'function') {
    try {
      const operations: TransactOperation[] = [
        { table: 'pages', op: 'insert', data: page as unknown as Record<string, unknown> },
        ...preparedBlocks.map((block): TransactOperation => ({
          table: 'blocks',
          op: 'insert',
          data: block as unknown as Record<string, unknown>,
        })),
      ];
      await db.transact(operations);
      inserted = page;
    } catch (error) {
      if (!transactUnavailable(error)) throw error;
    }
  }
  if (!inserted) {
    inserted = await db.table<Page>('pages').insert(page);
    try {
      await insertPreparedBlocks(db, preparedBlocks);
    } catch (error) {
      await db.table<Page>('pages').delete(inserted.id).catch(() => {});
      throw error;
    }
  }
  await ensurePageWorkspaceIndex(context.admin, inserted.id, inserted.workspaceId);
  return notionPage(inserted, props, request);
}

async function updatePageEndpoint(context: FunctionContext, pageId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, pageId);
  const page = await requireWritablePage(db, pageId, auth.id, auth.email);
  const props = page.parentType === 'database' && page.parentId ? await databaseProperties(db, page.parentId) : [];
  const patch: Partial<Page> = {};
  if (body.erase_content === true) await erasePageContent(context, db, page);
  if ('template' in body) {
    Object.assign(patch, await applyPageTemplate(db, page, body.template, auth.id));
  }
  if ('properties' in body) {
    const propPatch = page.parentType === 'database'
      ? await localPropertyPatchFromNotion(db, props, body.properties)
      : { title: titleFromNotionProperties(body.properties), properties: {} };
    if (propPatch.title !== undefined) patch.title = propPatch.title;
    if (Object.keys(propPatch.properties).length > 0) {
      patch.properties = { ...(page.properties ?? {}), ...(patch.properties ?? {}), ...propPatch.properties };
    }
  }
  if ('icon' in body) Object.assign(patch, notionIconToLocal(body.icon));
  if ('cover' in body) patch.cover = notionCoverToLocal(body.cover);
  if ('is_locked' in body) patch.isLocked = body.is_locked === true;
  if ('in_trash' in body || 'archived' in body) {
    const trash = body.in_trash === true || body.archived === true;
    patch.inTrash = trash;
    patch.trashedAt = trash ? nowIso() : null;
  }
  patch.updatedAt = nowIso();
  patch.lastEditedBy = auth.id;
  const updated = await db.table<Page>('pages').update(page.id, patch);
  return notionPage(updated, props, request);
}

function contentForType(input: Record<string, unknown>, type: string) {
  return isRecord(input[type]) ? (input[type] as Record<string, unknown>) : {};
}

function richContentFromNotion(typeContent: Record<string, unknown>) {
  return notionRichTextToSpans(typeContent.rich_text);
}

async function localBlockFromNotion(
  input: Record<string, unknown>,
  pageId: string,
  parentId: string | null,
  actorId: string,
  position: number,
): Promise<Block> {
  const type = typeof input.type === 'string' && knownBlockTypes.has(input.type) ? input.type : 'paragraph';
  const typeContent = contentForType(input, type);
  const content: Record<string, unknown> = {};
  if (textBlockTypes.has(type)) content.rich = richContentFromNotion(typeContent);
  if (type === 'to_do') content.checked = typeContent.checked === true;
  if (type === 'callout') {
    content.icon = isRecord(typeContent.icon) && typeContent.icon.type === 'emoji' ? typeContent.icon.emoji : undefined;
    content.color = optionalString(typeContent.color);
  }
  if (type.startsWith('toggle')) content.collapsed = false;
  if (type === 'code') {
    content.language = optionalString(typeContent.language) || 'plain text';
    content.caption = notionRichTextToSpans(typeContent.caption);
  }
  if (type === 'equation') content.expression = optionalString(typeContent.expression) || '';
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'file') {
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
  if (type === 'bookmark' || type === 'embed') content.url = optionalString(typeContent.url);
  if (type === 'link_to_page') content.childPageId = optionalString(typeContent.page_id || typeContent.database_id);
  const plainText =
    type === 'equation'
      ? optionalString(content.expression) || ''
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

function notionBlockTextPayload(block: Block, type: string, hasChildren: boolean) {
  const content = block.content ?? {};
  const payload: Record<string, unknown> = {};
  if (textBlockTypes.has(type)) payload.rich_text = spansToNotionRichText(content.rich);
  if (type === 'to_do') payload.checked = content.checked === true;
  if (type.startsWith('heading_') || type.startsWith('toggle_heading_')) {
    payload.color = content.color || 'default';
    if (type.startsWith('toggle_heading_')) payload.is_toggleable = true;
  }
  if (type === 'callout') {
    payload.icon = content.icon ? { type: 'emoji', emoji: content.icon } : null;
    payload.color = content.color || 'default';
  }
  if (type === 'code') {
    payload.language = content.language || 'plain text';
    payload.caption = spansToNotionRichText(content.caption);
  }
  if (type === 'equation') payload.expression = content.expression || block.plainText || '';
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'file') {
    const url = optionalString(content.url) || '';
    payload.type = 'external';
    payload.external = { url };
    payload.caption = spansToNotionRichText(content.caption);
    if (type === 'file') payload.name = optionalString(content.fileName) || url || 'Untitled';
  }
  if (type === 'bookmark' || type === 'embed') payload.url = optionalString(content.url) || '';
  if (type === 'link_to_page') payload.page_id = optionalString(content.childPageId) || null;
  if (type === 'child_page') payload.title = optionalString(content.childPageTitle) || block.plainText || 'Untitled';
  if (type === 'child_database') payload.title = optionalString(content.childPageTitle) || block.plainText || 'Untitled';
  if (hasChildren && (textBlockTypes.has(type) || type.startsWith('toggle'))) payload.children = [];
  return payload;
}

async function notionBlockFromLocal(db: DbRef, block: Block, request: Request) {
  const pageBlocks = await listAll(db.table<Block>('blocks').where('pageId', '==', block.pageId));
  const hasChildren = pageBlocks.some((item) => item.parentId === block.id);
  const type = knownBlockTypes.has(block.type) ? block.type : 'unsupported';
  return {
    object: 'block',
    id: block.id,
    parent: block.parentId
      ? { type: 'block_id', block_id: block.parentId }
      : { type: 'page_id', page_id: block.pageId },
    created_time: block.createdAt ?? null,
    last_edited_time: block.updatedAt ?? block.createdAt ?? null,
    created_by: notionUser(block.createdBy || ''),
    last_edited_by: notionUser(block.createdBy || ''),
    has_children: hasChildren,
    archived: false,
    in_trash: false,
    type,
    [type]: notionBlockTextPayload(block, type, hasChildren),
    url: `${pageUrl({ id: block.pageId } as Page, request)}#block-${encodeURIComponent(block.id)}`,
  };
}

function notionChildPageBlock(page: Page, request: Request) {
  const type = page.kind === 'database' ? 'child_database' : 'child_page';
  return {
    object: 'block',
    id: page.id,
    parent: { type: 'page_id', page_id: page.parentId },
    created_time: page.createdAt ?? null,
    last_edited_time: page.updatedAt ?? page.createdAt ?? null,
    created_by: notionUser(page.createdBy || ''),
    last_edited_by: notionUser(page.lastEditedBy || page.createdBy || ''),
    has_children: true,
    archived: page.inTrash === true,
    in_trash: page.inTrash === true,
    type,
    [type]: { title: page.title || 'Untitled' },
    url: pageUrl(page, request),
  };
}

async function blockParentPage(db: DbRef, blockId: string, actorId: string, actorEmail?: string | null) {
  const block = await getExisting(db.table<Block>('blocks'), blockId);
  if (!block) return null;
  const page = await requireReadablePage(db, block.pageId, actorId, actorEmail);
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
  const url = new URL(request.url);
  const size = pageSize(url.searchParams.get('page_size'));
  const start = cursorOffset(url.searchParams.get('start_cursor'));
  const page = await getExisting(db.table<Page>('pages'), blockId);
  if (page) {
    await requireReadablePage(db, page.id, auth.id, auth.email);
    const [blocks, childPages] = await Promise.all([
      listAll(db.table<Block>('blocks').where('pageId', '==', page.id)),
      listAll(db.table<Page>('pages').where('parentId', '==', page.id)),
    ]);
    const topBlocks = await Promise.all(
      blocks
        .filter((block) => !block.parentId)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((block) => notionBlockFromLocal(db, block, request)),
    );
    const pageBlocks = childPages
      .filter((child) => child.parentType === 'page' && !child.inTrash)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((child) => notionChildPageBlock(child, request));
    return listObject([...topBlocks, ...pageBlocks], 'block', {}, start, size);
  }
  const parent = await blockParentPage(db, blockId, auth.id, auth.email);
  if (!parent) throw new Error('Block was not found.');
  const blocks = (await listAll(db.table<Block>('blocks').where('pageId', '==', parent.block.pageId)))
    .filter((block) => block.parentId === blockId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const results = await Promise.all(blocks.map((block) => notionBlockFromLocal(db, block, request)));
  return listObject(results, 'block', {}, start, size);
}

async function appendBlockChildren(context: FunctionContext, blockId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await blockRoutedDb(context, blockId, body);
  const page = await getExisting(db.table<Page>('pages'), blockId);
  let pageId = blockId;
  let parentId: string | null = null;
  if (page) {
    await requireWritablePage(db, page.id, auth.id, auth.email);
  } else {
    const parent = await blockParentPage(db, blockId, auth.id, auth.email);
    if (!parent) throw new Error('Block was not found.');
    await requireWritablePage(db, parent.block.pageId, auth.id, auth.email);
    pageId = parent.block.pageId;
    parentId = parent.block.id;
  }
  const created = await createBlocksUnder(db, pageId, parentId, body.children, auth.id);
  const results = await Promise.all(created.map((block) => notionBlockFromLocal(db, block, request)));
  return listObject(results, 'block');
}

async function updateBlockEndpoint(context: FunctionContext, blockId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await blockRoutedDb(context, blockId, body);
  const current = await getExisting(db.table<Block>('blocks'), blockId);
  if (!current) throw new Error('Block was not found.');
  await requireWritablePage(db, current.pageId, auth.id, auth.email);
  const type = typeof body.type === 'string' && knownBlockTypes.has(body.type) ? body.type : current.type;
  const mergedInput: Record<string, unknown> = {
    ...body,
    type,
    [type]: isRecord(body[type]) ? body[type] : body,
  };
  const next = await localBlockFromNotion(mergedInput, current.pageId, current.parentId ?? null, current.createdBy || auth.id, current.position ?? 1);
  const updated = await db.table<Block>('blocks').update(current.id, {
    type: next.type,
    content: next.content,
    plainText: next.plainText,
    updatedAt: nowIso(),
  });
  return notionBlockFromLocal(db, updated, request);
}

async function deleteBlockEndpoint(context: FunctionContext, blockId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await blockRoutedDb(context, blockId);
  const page = await getExisting(db.table<Page>('pages'), blockId);
  if (page && page.parentType === 'page') {
    await requireWritablePage(db, page.id, auth.id, auth.email);
    const updated = await db.table<Page>('pages').update(page.id, {
      inTrash: true,
      trashedAt: nowIso(),
      updatedAt: nowIso(),
      lastEditedBy: auth.id,
    });
    return { ...notionChildPageBlock(updated, request), archived: true, in_trash: true };
  }
  const block = await getExisting(db.table<Block>('blocks'), blockId);
  if (!block) throw new Error('Block was not found.');
  const owningPage = await requireWritablePage(db, block.pageId, auth.id, auth.email);
  const table = db.table<Block>('blocks');
  const blocks = await listAll(table.where('pageId', '==', block.pageId));
  const ids: string[] = [];
  const visit = (id: string) => {
    if (ids.includes(id)) return;
    ids.push(id);
    for (const child of blocks) {
      if (child.parentId === id) visit(child.id);
    }
  };
  visit(block.id);
  for (const id of ids.reverse()) {
    await deletePrimaryContentRecord<Block>(context, db, owningPage.workspaceId, 'blocks', id);
  }
  const deleted = await notionBlockFromLocal(db, block, request);
  return { ...deleted, archived: true, in_trash: true };
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
  const parent = await resolveDatabaseParent(db, body, auth.id, auth.email);
  const id = optionalString(body.id) || newId();
  const title = richTextToPlainText(body.title).trim();
  const icon = notionIconToLocal(body.icon);
  const now = nowIso();
  const database: Page = {
    id,
    workspaceId: parent.workspaceId,
    parentId: parent.parentId,
    parentType: parent.parentType,
    kind: 'database',
    title,
    icon: icon.icon,
    iconType: icon.iconType,
    cover: notionCoverToLocal(body.cover),
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    isFavorite: false,
    isPublic: false,
    inTrash: false,
    position: await positionForChild(db, parent.workspaceId, parent.parentId, parent.parentType),
    createdBy: auth.id,
    lastEditedBy: auth.id,
    createdAt: now,
    updatedAt: now,
  };
  const initialDataSource = isRecord(body.initial_data_source) ? body.initial_data_source : {};
  const props = schemaFromNotionProperties(id, initialDataSource.properties ?? body.properties);
  const inserted = await insertDatabaseBundle(db, database, props, starterView(id));
  await ensurePageWorkspaceIndex(context.admin, inserted.id, inserted.workspaceId);
  return notionDatabase(inserted, props, request);
}

async function createDataSourceEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, (body.parent as { page_id?: unknown; database_id?: unknown } | undefined)?.page_id, (body.parent as { database_id?: unknown } | undefined)?.database_id);
  const parent = isRecord(body.parent) ? body.parent : {};
  const parentDatabaseId = requireString(parent.database_id, 'parent.database_id');
  const parentDatabase = await requireWritablePage(db, parentDatabaseId, auth.id, auth.email);
  if (parentDatabase.kind !== 'database') throw new Error('Parent database was not found.');
  const id = optionalString(body.id) || newId();
  const icon = notionIconToLocal(body.icon);
  const now = nowIso();
  const dataSource: Page = {
    id,
    workspaceId: parentDatabase.workspaceId,
    parentId: parentDatabase.parentId ?? null,
    parentType: parentDatabase.parentType ?? 'workspace',
    kind: 'database',
    title: richTextToPlainText(body.title).trim(),
    icon: icon.icon,
    iconType: icon.iconType,
    cover: notionCoverToLocal(body.cover),
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties: { notionParentDatabaseId: parentDatabase.id },
    isFavorite: false,
    isPublic: false,
    inTrash: false,
    position: await positionForChild(
      db,
      parentDatabase.workspaceId,
      parentDatabase.parentId ?? null,
      parentDatabase.parentType ?? 'workspace',
    ),
    createdBy: auth.id,
    lastEditedBy: auth.id,
    createdAt: now,
    updatedAt: now,
  };
  const props = schemaFromNotionProperties(id, body.properties);
  const inserted = await insertDatabaseBundle(db, dataSource, props, starterView(id));
  await ensurePageWorkspaceIndex(context.admin, inserted.id, inserted.workspaceId);
  return notionDataSource(inserted, props, request);
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
      try {
        await requireReadablePage(entry.db, page.id, auth.id, auth.email);
        results.push(notionDatabase(page, await databaseProperties(entry.db, page.id), request));
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
        await requireReadablePage(entry.db, page.id, auth.id, auth.email);
        results.push(notionDataSource(page, await databaseProperties(entry.db, page.id), request));
      } catch {
        // Omit data sources the caller cannot view.
      }
    }
  }
  return listObject(results, 'data_source', {}, cursorOffset(url.searchParams.get('start_cursor')), pageSize(url.searchParams.get('page_size')));
}

async function updateDatabaseSchema(db: DbRef, database: Page, body: Record<string, unknown>) {
  if (!isRecord(body.properties)) return databaseProperties(db, database.id);
  const props = await databaseProperties(db, database.id);
  const table = db.table<DbProperty>('db_properties');
  const updated: DbProperty[] = [...props];
  let nextPosition = props.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1;
  for (const [name, schema] of Object.entries(body.properties)) {
    const existing = propByNameOrId(props, name);
    if (schema === null) {
      if (!existing) continue;
      if (existing.type === 'title') throw new Error('The title property cannot be deleted.');
      const rows = await listAll(db.table<Page>('pages').where('parentId', '==', database.id));
      const operations: TransactOperation[] = [];
      for (const row of rows) {
        if (row.parentType !== 'database' || !isRecord(row.properties) || !(existing.id in row.properties)) continue;
        const properties = { ...(row.properties ?? {}) };
        delete properties[existing.id];
        operations.push({ table: 'pages', op: 'update', id: row.id, data: { properties } });
      }
      // Row values and the schema record are one logical mutation. Keeping
      // them in a single transaction prevents a failed primary delete from
      // being reported after row properties were already stripped.
      operations.push({ table: 'db_properties', op: 'delete', id: existing.id });
      await db.transact(operations);
      const index = updated.findIndex((item) => item.id === existing.id);
      if (index >= 0) updated.splice(index, 1);
      continue;
    }
    const next = schemaPropertyFromNotion(database.id, name, schema, existing?.position ?? nextPosition);
    if (existing) {
      const patched = await table.update(existing.id, {
        name: next.name,
        type: next.type,
        description: next.description,
        config: next.config,
      });
      const index = updated.findIndex((item) => item.id === existing.id);
      if (index >= 0) updated[index] = patched;
    } else {
      const inserted = await table.insert(next);
      updated.push(inserted);
      nextPosition += 1;
    }
  }
  return updated;
}

async function updateDatabaseEndpoint(context: FunctionContext, databaseId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, databaseId);
  const database = await requireWritablePage(db, databaseId, auth.id, auth.email);
  if (database.kind !== 'database') throw new Error('Database was not found.');
  const patch: Partial<Page> = {};
  if ('title' in body) patch.title = richTextToPlainText(body.title) || database.title || 'Untitled';
  if ('icon' in body) Object.assign(patch, notionIconToLocal(body.icon));
  if ('cover' in body) patch.cover = notionCoverToLocal(body.cover);
  patch.updatedAt = nowIso();
  patch.lastEditedBy = auth.id;
  const updated = await db.table<Page>('pages').update(database.id, patch);
  const props = await updateDatabaseSchema(db, updated, body);
  return notionDatabase(updated, props, request);
}

async function updateDataSourceEndpoint(context: FunctionContext, dataSourceId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const dataSource = await requireWritablePage(db, dataSourceId, auth.id, auth.email);
  if (dataSource.kind !== 'database') throw new Error('Data source was not found.');
  const patch: Partial<Page> = {};
  if ('title' in body) patch.title = richTextToPlainText(body.title) || dataSource.title || 'Untitled';
  if ('name' in body) patch.title = optionalString(body.name) || dataSource.title || 'Untitled';
  if ('icon' in body) Object.assign(patch, notionIconToLocal(body.icon));
  if ('cover' in body) patch.cover = notionCoverToLocal(body.cover);
  if ('in_trash' in body || 'archived' in body) {
    const trash = body.in_trash === true || body.archived === true;
    patch.inTrash = trash;
    patch.trashedAt = trash ? nowIso() : null;
  }
  patch.updatedAt = nowIso();
  patch.lastEditedBy = auth.id;
  const updated = await db.table<Page>('pages').update(dataSource.id, patch);
  const props = await updateDatabaseSchema(db, updated, body);
  return notionDataSource(updated, props, request);
}

async function trashDataSourceEndpoint(context: FunctionContext, dataSourceId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const dataSource = await requireWritablePage(db, dataSourceId, auth.id, auth.email);
  if (dataSource.kind !== 'database') throw new Error('Data source was not found.');
  const updated = await db.table<Page>('pages').update(dataSource.id, {
    inTrash: true,
    trashedAt: nowIso(),
    updatedAt: nowIso(),
    lastEditedBy: auth.id,
  });
  return notionDataSource(updated, await databaseProperties(db, updated.id), request);
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

function filterValueMatches(actual: unknown, condition: Record<string, unknown>) {
  const text = actual == null ? '' : String(actual);
  for (const [op, expected] of Object.entries(condition)) {
    if (op === 'equals' && text !== String(expected ?? '')) return false;
    if (op === 'does_not_equal' && text === String(expected ?? '')) return false;
    if (op === 'contains' && !text.toLowerCase().includes(String(expected ?? '').toLowerCase())) return false;
    if (op === 'does_not_contain' && text.toLowerCase().includes(String(expected ?? '').toLowerCase())) return false;
    if (op === 'is_empty' && text.trim() !== '') return false;
    if (op === 'is_not_empty' && text.trim() === '') return false;
    if (op === 'greater_than' && !(Number(actual) > Number(expected))) return false;
    if (op === 'less_than' && !(Number(actual) < Number(expected))) return false;
    if (op === 'on_or_before' && !(text <= String(expected ?? ''))) return false;
    if (op === 'on_or_after' && !(text >= String(expected ?? ''))) return false;
    if (op === 'before' && !(text < String(expected ?? ''))) return false;
    if (op === 'after' && !(text > String(expected ?? ''))) return false;
  }
  return true;
}

function rowMatchesFilter(row: Page, props: DbProperty[], filter: unknown): boolean {
  if (!isRecord(filter)) return true;
  if (Array.isArray(filter.and)) return filter.and.every((item) => rowMatchesFilter(row, props, item));
  if (Array.isArray(filter.or)) return filter.or.some((item) => rowMatchesFilter(row, props, item));
  const propertyName = optionalString(filter.property);
  if (!propertyName) return true;
  const prop = propByNameOrId(props, propertyName);
  if (!prop) return true;
  const conditionKey = Object.keys(filter).find((key) => key !== 'property' && key !== 'type');
  const condition = conditionKey && isRecord(filter[conditionKey]) ? (filter[conditionKey] as Record<string, unknown>) : {};
  return filterValueMatches(comparablePropertyValue(row, prop), condition);
}

function sortRows(rows: Page[], props: DbProperty[], sorts: unknown) {
  if (!Array.isArray(sorts) || sorts.length === 0) return rows;
  return rows.slice().sort((a, b) => {
    for (const sort of sorts) {
      if (!isRecord(sort)) continue;
      const direction = sort.direction === 'descending' || sort.direction === 'desc' ? -1 : 1;
      if (typeof sort.timestamp === 'string') {
        const left = sort.timestamp === 'created_time' ? a.createdAt ?? '' : a.updatedAt ?? '';
        const right = sort.timestamp === 'created_time' ? b.createdAt ?? '' : b.updatedAt ?? '';
        if (left !== right) return left < right ? -direction : direction;
      }
      const propertyName = optionalString(sort.property);
      const prop = propertyName ? propByNameOrId(props, propertyName) : undefined;
      if (!prop) continue;
      const left = String(comparablePropertyValue(a, prop));
      const right = String(comparablePropertyValue(b, prop));
      if (left !== right) return left < right ? -direction : direction;
    }
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

async function queryDataSourceEndpoint(context: FunctionContext, dataSourceId: string, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireReadablePage(db, dataSourceId, auth.id, auth.email);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const props = await databaseProperties(db, database.id);
  const rows = (await listAll(db.table<Page>('pages').where('parentId', '==', database.id)))
    .filter((row) => row.parentType === 'database' && !row.inTrash && rowMatchesFilter(row, props, body.filter));
  const query = optionalString(body.query)?.toLowerCase();
  const searched = query
    ? rows.filter((row) => (row.title || '').toLowerCase().includes(query))
    : rows;
  const sorted = sortRows(searched, props, body.sorts);
  const start = cursorOffset(body.start_cursor);
  const size = pageSize(body.page_size);
  const pages = sorted.map((row) => notionPage(row, props, request));
  return listObject(pages, 'page_or_database', {}, start, size);
}

async function listTemplatesEndpoint(context: FunctionContext, dataSourceId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireReadablePage(db, dataSourceId, auth.id, auth.email);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const templates = (await listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', database.id)))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((template) => ({
      object: 'template',
      id: template.id,
      data_source_id: database.id,
      name: template.name,
      icon: template.icon ? { type: 'emoji', emoji: template.icon } : null,
      is_default: template.isDefault === true,
      title: richTextFromPlainText(template.title || template.name),
      properties: template.properties ?? {},
      children: template.blocks ?? [],
      created_time: template.createdAt ?? null,
      last_edited_time: template.updatedAt ?? template.createdAt ?? null,
    }));
  return listObject(templates, 'template');
}

function notionView(view: DbView) {
  return {
    object: 'view',
    id: view.id,
    data_source_id: view.databaseId,
    database_id: view.databaseId,
    name: view.name,
    type: view.type,
    [view.type]: view.config ?? {},
    config: view.config ?? {},
    created_time: view.createdAt ?? null,
    last_edited_time: view.updatedAt ?? view.createdAt ?? null,
  };
}

async function listViewsEndpoint(context: FunctionContext, dataSourceId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireReadablePage(db, dataSourceId, auth.id, auth.email);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const url = new URL(request.url);
  const start = cursorOffset(url.searchParams.get('start_cursor'));
  const size = pageSize(url.searchParams.get('page_size'));
  const views = (await listAll(db.table<DbView>('db_views').where('databaseId', '==', database.id)))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(notionView);
  return listObject(views, 'view', {}, start, size);
}

async function getViewEndpoint(context: FunctionContext, viewId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbView>(context, 'db_views', viewId);
  if (!routed) throw new Error('View was not found.');
  await requireReadablePage(routed.db, routed.record.databaseId, auth.id, auth.email);
  return notionView(routed.record);
}

async function createViewEndpoint(context: FunctionContext, dataSourceId: string, body: Record<string, unknown>) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await boundedDbFromPageHint(context.admin, dataSourceId);
  const database = await requireWritablePage(db, dataSourceId, auth.id, auth.email);
  if (database.kind !== 'database') throw new Error('Data source was not found.');
  const views = await listAll(db.table<DbView>('db_views').where('databaseId', '==', database.id));
  const type = requireSupportedViewType(body.type);
  const config = isRecord(body[type]) ? body[type] : isRecord(body.config) ? body.config : {};
  const view = await db.table<DbView>('db_views').insert({
    id: optionalString(body.id) || newId(),
    databaseId: database.id,
    name: optionalString(body.name) || type[0].toUpperCase() + type.slice(1),
    type,
    position: views.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
    config,
  });
  return notionView(view);
}

async function updateViewEndpoint(context: FunctionContext, viewId: string, body: Record<string, unknown>) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbView>(context, 'db_views', viewId, body);
  if (!routed) throw new Error('View was not found.');
  const { db, record: current } = routed;
  await requireWritablePage(db, current.databaseId, auth.id, auth.email);
  const type = body.type === undefined || body.type === null || body.type === ''
    ? current.type
    : requireSupportedViewType(body.type, current.type);
  const updated = await db.table<DbView>('db_views').update(current.id, {
    name: optionalString(body.name) || current.name,
    type,
    config: isRecord(body[type]) ? body[type] : isRecord(body.config) ? body.config : current.config,
    updatedAt: nowIso(),
  });
  return notionView(updated);
}

async function deleteViewEndpoint(context: FunctionContext, viewId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<DbView>(context, 'db_views', viewId);
  if (!routed) throw new Error('View was not found.');
  const { db, record: current } = routed;
  const database = await requireWritablePage(db, current.databaseId, auth.id, auth.email);
  await deletePrimaryContentRecord<DbView>(context, db, database.workspaceId, 'db_views', viewId);
  return { ...notionView(current), deleted: true };
}

function notionComment(comment: Comment) {
  return {
    object: 'comment',
    id: comment.id,
    parent: comment.blockId
      ? { type: 'block_id', block_id: comment.blockId }
      : { type: 'page_id', page_id: comment.pageId },
    discussion_id: comment.parentId || comment.id,
    created_time: comment.createdAt ?? null,
    last_edited_time: comment.updatedAt ?? comment.createdAt ?? null,
    created_by: notionUser(comment.authorId || ''),
    rich_text: spansToNotionRichText(isRecord(comment.body) ? comment.body.rich : []),
    resolved: comment.resolved === true,
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
  if (!resolvedPageId && blockId) {
    const block = await getExisting(db.table<Block>('blocks'), blockId);
    if (!block) throw new Error('Block was not found.');
    resolvedPageId = block.pageId;
  }
  if (!resolvedPageId) throw new Error('page_id or block_id is required.');
  await requireReadablePage(db, resolvedPageId, auth.id, auth.email);
  const start = cursorOffset(url.searchParams.get('start_cursor'));
  const size = pageSize(url.searchParams.get('page_size'));
  const comments = (await listAll(db.table<Comment>('comments').where('pageId', '==', resolvedPageId)))
    .filter((comment) => !blockId || comment.blockId === blockId)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .map(notionComment);
  return listObject(comments, 'comment', {}, start, size);
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
  const db = parentWorkspaceId
    ? boundedDbFromWorkspaceHint(context.admin, parentWorkspaceId)
    : pageId
      ? await boundedDbFromPageHint(context.admin, pageId, (body as { page_id?: unknown }).page_id)
      : blockId
        ? await blockRoutedDb(context, blockId, body)
        : await boundedDbFromPageHint(context.admin, (body as { page_id?: unknown }).page_id);
  if (!pageId && blockId) {
    const block = await getExisting(db.table<Block>('blocks'), blockId);
    if (!block) throw new Error('Block was not found.');
    pageId = block.pageId;
  }
  if (!pageId) throw new Error('comment parent page_id or block_id is required.');
  await requireCommentablePage(db, pageId, auth.id, auth.email);
  const now = nowIso();
  const comment = await db.table<Comment>('comments').insert({
    id: optionalString(body.id) || newId(),
    pageId,
    blockId,
    parentId: optionalString(body.discussion_id) || optionalString(body.parent_id) || null,
    authorId: auth.id,
    body: { rich: notionRichTextToSpans(body.rich_text) },
    resolved: body.resolved === true,
    createdAt: now,
    updatedAt: now,
  });
  return notionComment(comment);
}

async function getCommentEndpoint(context: FunctionContext, commentId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<Comment>(context, 'comments', commentId);
  if (!routed) throw new Error('Comment was not found.');
  const { db, record: comment } = routed;
  await requireReadablePage(db, comment.pageId, auth.id, auth.email);
  return notionComment(comment);
}

async function updateCommentEndpoint(context: FunctionContext, commentId: string, body: Record<string, unknown>) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<Comment>(context, 'comments', commentId, body);
  if (!routed) throw new Error('Comment was not found.');
  const { db, record: comment } = routed;
  const page = await requirePageRole(db, comment.pageId, auth.id, 'comment', auth.email);
  const role = await pageAccessRole(db, page, auth.id, undefined, auth.email);
  if (comment.authorId !== auth.id && !roleAtLeast(role, 'edit')) throw new Error('Page access required.');
  const patch: Partial<Comment> = { updatedAt: nowIso() };
  if ('rich_text' in body) patch.body = { rich: notionRichTextToSpans(body.rich_text) };
  if ('resolved' in body) patch.resolved = body.resolved === true;
  const updated = await db.table<Comment>('comments').update(comment.id, patch);
  return notionComment(updated);
}

async function deleteCommentEndpoint(context: FunctionContext, commentId: string) {
  const { auth } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<Comment>(context, 'comments', commentId);
  if (!routed) throw new Error('Comment was not found.');
  const { db, record: comment } = routed;
  const page = await requirePageRole(db, comment.pageId, auth.id, 'comment', auth.email);
  const role = await pageAccessRole(db, page, auth.id, undefined, auth.email);
  if (comment.authorId !== auth.id && !roleAtLeast(role, 'edit')) throw new Error('Page access required.');
  await deletePrimaryContentRecord<Comment>(context, db, page.workspaceId, 'comments', comment.id);
  return { ...notionComment(comment), deleted: true };
}

function cleanFileSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
}

function notionFileUpload(upload: FileUpload, request: Request) {
  const totalParts = Math.max(1, Math.floor(upload.numberOfPartsTotal ?? 1));
  const sentParts =
    typeof upload.numberOfPartsSent === 'number'
      ? Math.max(0, Math.min(totalParts, Math.floor(upload.numberOfPartsSent)))
      : upload.status === 'uploaded'
        ? totalParts
        : 0;
  return {
    object: 'file_upload',
    id: upload.id,
    created_time: upload.createdAt ?? null,
    created_by: notionUser(upload.createdBy || ''),
    last_edited_time: upload.updatedAt ?? upload.completedAt ?? upload.createdAt ?? null,
    in_trash: upload.status === 'deleted' || upload.status === 'expired',
    expiry_time: upload.expiresAt ?? null,
    status: upload.status || 'pending',
    filename: upload.name ?? null,
    content_type: upload.contentType ?? null,
    content_length: typeof upload.size === 'number' ? upload.size : null,
    upload_url: `${originOf(request)}/api/functions/v1/file_uploads/${encodeURIComponent(upload.id)}/send${workspaceQuery(upload)}`,
    complete_url: `${originOf(request)}/api/functions/v1/file_uploads/${encodeURIComponent(upload.id)}/complete${workspaceQuery(upload)}`,
    file_import_result:
      upload.fileImportResult ??
      (upload.status === 'uploaded'
        ? { imported_time: upload.completedAt ?? upload.updatedAt ?? upload.createdAt ?? null, type: 'success', success: {} }
        : null),
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
) {
  const target = await fileUploadTarget(
    db,
    upload as unknown as Record<string, unknown>,
    actorId,
    minimum,
    actorEmail,
  );
  if (target.workspaceId !== upload.workspaceId) throw new Error('File upload target is outside the upload workspace.');
}

async function createFileUploadEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = await fileUploadDbForBody(context, body);
  const target = await fileUploadTarget(db, body, auth.id, 'edit', auth.email);
  const id = optionalString(body.id) || newId();
  const filename = optionalString(body.filename) || optionalString(body.name) || 'Untitled';
  const contentType = optionalString(body.content_type) || optionalString(body.contentType) || 'application/octet-stream';
  const contentLength = Number(body.content_length ?? body.contentLength ?? body.size ?? 0);
  const numberOfPartsRaw = isRecord(body.number_of_parts) ? body.number_of_parts.total : body.number_of_parts;
  const numberOfPartsTotal = Math.max(1, Math.min(1000, Math.floor(Number(numberOfPartsRaw || 1))));
  const now = nowIso();
  const upload = await db.table<FileUpload>('file_uploads').insert({
    id,
    workspaceId: target.workspaceId,
    bucket: 'files',
    key: `workspaces/${target.workspaceId}/uploads/${id}-${cleanFileSegment(filename)}`,
    scope: 'uploads',
    pageId: target.pageId,
    blockId: target.blockId,
    databaseId: target.databaseId,
    propertyId: target.propertyId,
    name: filename,
    contentType,
    size: Number.isFinite(contentLength) ? Math.max(0, Math.floor(contentLength)) : 0,
    status: 'pending',
    createdBy: auth.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    numberOfPartsTotal,
    numberOfPartsSent: 0,
    createdAt: now,
    updatedAt: now,
  });
  return notionFileUpload(upload, request);
}

async function getFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  await requireFileUploadAccess(db, upload, auth.id, 'view', auth.email);
  return notionFileUpload(upload, request);
}

async function listFileUploadsEndpoint(context: FunctionContext) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const url = new URL(request.url);
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
        await requireFileUploadAccess(entry.db, upload, auth.id, 'view', auth.email);
        visible.push(upload);
      } catch {
        // Omit uploads outside the caller's workspaces.
      }
    }
  }
  visible.sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
  return listObject(
    visible.map((upload) => notionFileUpload(upload, request)),
    'file_upload',
    {},
    cursorOffset(url.searchParams.get('start_cursor')),
    pageSize(url.searchParams.get('page_size')),
  );
}

async function sendFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  const table = db.table<FileUpload>('file_uploads');
  await requireFileUploadAccess(db, upload, auth.id, 'edit', auth.email);
  let filename = upload.name;
  let contentType = upload.contentType;
  let size = upload.size;
  let partNumber = 1;
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (file && typeof file === 'object') {
      const candidate = file as { name?: unknown; type?: unknown; size?: unknown };
      if (typeof candidate.name === 'string' && candidate.name.trim()) filename = candidate.name.trim();
      if (typeof candidate.type === 'string' && candidate.type.trim()) contentType = candidate.type.trim();
      if (typeof candidate.size === 'number' && Number.isFinite(candidate.size)) size = candidate.size;
    }
    const rawPart = form.get('part_number');
    if (typeof rawPart === 'string' && rawPart.trim()) partNumber = Number(rawPart);
  } catch {
    // JSON-less send requests still mark the file as received.
  }
  const total = Math.max(1, Math.floor(upload.numberOfPartsTotal ?? 1));
  const sent = Math.max(upload.numberOfPartsSent ?? 0, Number.isFinite(partNumber) ? Math.floor(partNumber) : 1);
  const status = sent >= total ? 'uploaded' : 'pending';
  const updated = await table.update(upload.id, {
    name: filename,
    contentType,
    size,
    status,
    url: upload.url || `${originOf(request)}/api/functions/v1/file_uploads/${encodeURIComponent(upload.id)}${workspaceQuery(upload)}`,
    completedAt: status === 'uploaded' ? nowIso() : upload.completedAt,
    numberOfPartsSent: Math.min(total, sent),
    updatedAt: nowIso(),
  });
  return notionFileUpload(updated, request);
}

async function completeFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  const table = db.table<FileUpload>('file_uploads');
  await requireFileUploadAccess(db, upload, auth.id, 'edit', auth.email);
  const total = Math.max(1, Math.floor(upload.numberOfPartsTotal ?? 1));
  const completed = await table.update(upload.id, {
    status: 'uploaded',
    completedAt: upload.completedAt ?? nowIso(),
    numberOfPartsSent: total,
    updatedAt: nowIso(),
  });
  return notionFileUpload(completed, request);
}

async function deleteFileUploadEndpoint(context: FunctionContext, fileUploadId: string) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const routed = await findAccessibleRecord<FileUpload>(context, 'file_uploads', fileUploadId);
  if (!routed) throw new Error('File upload was not found.');
  const { db, record: upload } = routed;
  const table = db.table<FileUpload>('file_uploads');
  await requireFileUploadAccess(db, upload, auth.id, 'edit', auth.email);
  const deleted = await table.update(upload.id, {
    status: 'deleted',
    deletedAt: nowIso(),
    deletedBy: auth.id,
    updatedAt: nowIso(),
  });
  return { ...notionFileUpload(deleted, request), deleted: true };
}

async function usersEndpoint(context: FunctionContext) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const db = context.admin.db('app');
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id');
  const memberships = workspaceId
    ? await listAll(db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId))
    : await listTable(db.table<WorkspaceMember>('workspace_members'));
  const visible: WorkspaceMember[] = [];
  for (const member of memberships) {
    try {
      await requireWorkspaceRole(db, member.workspaceId, auth.id, 'view');
      visible.push(member);
    } catch {
      // Ignore workspaces the caller cannot see.
    }
  }
  const byUser = new Map<string, WorkspaceMember>();
  for (const member of visible) {
    if (!byUser.has(member.userId)) byUser.set(member.userId, member);
  }
  byUser.set(auth.id, {
    id: auth.id,
    workspaceId: workspaceId || '',
    userId: auth.id,
    email: auth.email || null,
    displayName: auth.email || auth.id,
  });
  const users = Array.from(byUser.values()).map((member) =>
    notionUser(member.userId, member.email ?? null, member.displayName ?? null),
  );
  return listObject(users, 'user');
}

async function searchEndpoint(context: FunctionContext, body: Record<string, unknown>) {
  const { auth, request } = context;
  if (!auth?.id) throw new Error('Authentication required.');
  const query = optionalString(body.query)?.toLowerCase() || '';
  const workspaceId = optionalString(body.workspace_id) || optionalString(body.workspaceId);
  const filter = isRecord(body.filter) ? body.filter : {};
  const value = optionalString(filter.value);
  const start = cursorOffset(body.start_cursor);
  const size = pageSize(body.page_size);
  const targetCount = start + size + 1;
  const entries = await workspaceDbsForOptionalHint(context, workspaceId);
  const budget = materializationBudget();
  const results: unknown[] = [];
  searchWorkspaces:
  for (const entry of entries) {
    const pages = await listAllBounded(
      entry.db.table<Page>('pages').where('workspaceId', '==', entry.workspaceId),
      budget,
      'Search',
    );
    pages.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
    for (const page of pages) {
      if (page.inTrash) continue;
      if (query && !(page.title || '').toLowerCase().includes(query)) continue;
      if (value === 'page' && page.kind === 'database') continue;
      if (value === 'database' && page.kind !== 'database') continue;
      try {
        await requireReadablePage(entry.db, page.id, auth.id, auth.email);
      } catch {
        continue;
      }
      if (page.kind === 'database') {
        results.push(notionDatabase(page, await databaseProperties(entry.db, page.id), request));
      } else {
        const props = page.parentType === 'database' && page.parentId
          ? await databaseProperties(entry.db, page.parentId)
          : [];
        results.push(notionPage(page, props, request));
      }
      if (results.length >= targetCount) break searchWorkspaces;
    }
  }
  return listObject(results, 'page_or_database', {}, start, size);
}

function routeParts(context: FunctionContext) {
  const slug = context.params?.slug || '';
  return slug.split('/').map((part) => part.trim()).filter(Boolean);
}

async function dispatch(context: FunctionContext) {
  const { auth, request } = context;
  if (!auth?.id) return notionError(401, 'unauthorized', 'Authentication required.');
  const method = request.method.toUpperCase();
  const parts = routeParts(context);
  const parsesJsonBody = method !== 'GET' && method !== 'DELETE' && !(parts[0] === 'file_uploads' && parts[2] === 'send');
  const body = parsesJsonBody ? await requestJson(request) : {};
  const url = new URL(request.url);

  try {
    if (method === 'GET' && parts[0] === 'users' && parts[1] === 'me') {
      return json(notionUser(auth.id, auth.email ?? null));
    }
    if (method === 'GET' && parts[0] === 'users' && parts.length === 1) {
      return json(await usersEndpoint(context));
    }
    if (method === 'GET' && parts[0] === 'users' && parts[1] && parts.length === 2) {
      return json(await getUserEndpoint(context, parts[1]));
    }
    if (method === 'GET' && parts[0] === 'custom_emojis' && parts.length === 1) {
      return json(listObject([], 'custom_emoji'));
    }
    if (method === 'POST' && parts[0] === 'search' && parts.length === 1) {
      return json(await searchEndpoint(context, body));
    }
    if (method === 'POST' && parts[0] === 'pages' && parts.length === 1) {
      return json(await createPageEndpoint(context, body));
    }
    if (method === 'GET' && parts[0] === 'pages' && parts[1] && parts.length === 2) {
      const pageDb = await boundedDbFromPageHint(context.admin, parts[1]);
      const page = await requireReadablePage(pageDb, parts[1], auth.id, auth.email);
      const props = page.parentType === 'database' && page.parentId ? await databaseProperties(pageDb, page.parentId) : [];
      return json(notionPage(page, props, request));
    }
    if (method === 'PATCH' && parts[0] === 'pages' && parts[1] && parts.length === 2) {
      return json(await updatePageEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'pages' && parts[1] && parts[2] === 'properties' && parts[3]) {
      const pageDb = await boundedDbFromPageHint(context.admin, parts[1]);
      const page = await requireReadablePage(pageDb, parts[1], auth.id, auth.email);
      const props = page.parentType === 'database' && page.parentId ? await databaseProperties(pageDb, page.parentId) : [];
      const prop = propByNameOrId(props, parts[3]) ?? (props.length === 0 && parts[3] === 'title'
        ? { id: 'title', databaseId: page.id, name: 'title', type: 'title', position: 1 }
        : undefined);
      if (!prop) throw new Error('Property was not found.');
      return json(propertyItemResponse(page, prop, request));
    }
    if (method === 'GET' && parts[0] === 'blocks' && parts[1] && parts.length === 2) {
      const pageDb = await blockRoutedDb(context, parts[1]);
      const block = await getExisting(pageDb.table<Block>('blocks'), parts[1]);
      if (block) {
        await requireReadablePage(pageDb, block.pageId, auth.id, auth.email);
        return json(await notionBlockFromLocal(pageDb, block, request));
      }
      const page = await requireReadablePage(pageDb, parts[1], auth.id, auth.email);
      return json(notionChildPageBlock(page, request));
    }
    if (method === 'GET' && parts[0] === 'blocks' && parts[1] && parts[2] === 'children') {
      return json(await listBlockChildren(context, parts[1]));
    }
    if (method === 'PATCH' && parts[0] === 'blocks' && parts[1] && parts[2] === 'children') {
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
      const database = await requireReadablePage(dbRouted, parts[1], auth.id, auth.email);
      if (database.kind !== 'database') throw new Error('Database was not found.');
      return json(notionDatabase(database, await databaseProperties(dbRouted, database.id), request));
    }
    if (method === 'PATCH' && parts[0] === 'databases' && parts[1] && parts.length === 2) {
      return json(await updateDatabaseEndpoint(context, parts[1], body));
    }
    if (method === 'POST' && parts[0] === 'databases' && parts[1] && parts[2] === 'query') {
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
      const dataSource = await requireReadablePage(dsRouted, parts[1], auth.id, auth.email);
      if (dataSource.kind !== 'database') throw new Error('Data source was not found.');
      return json(notionDataSource(dataSource, await databaseProperties(dsRouted, dataSource.id), request));
    }
    if (method === 'PATCH' && parts[0] === 'data_sources' && parts[1] && parts.length === 2) {
      return json(await updateDataSourceEndpoint(context, parts[1], body));
    }
    if (method === 'DELETE' && parts[0] === 'data_sources' && parts[1] && parts.length === 2) {
      return json(await trashDataSourceEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'query') {
      return json(await queryDataSourceEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'templates') {
      return json(await listTemplatesEndpoint(context, parts[1]));
    }
    if (method === 'GET' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'views') {
      return json(await listViewsEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'data_sources' && parts[1] && parts[2] === 'views') {
      return json(await createViewEndpoint(context, parts[1], body));
    }
    if (method === 'GET' && parts[0] === 'views' && parts.length === 1) {
      const dataSourceId = requireString(url.searchParams.get('data_source_id'), 'data_source_id');
      return json(await listViewsEndpoint(context, dataSourceId));
    }
    if (method === 'POST' && parts[0] === 'views' && parts.length === 1) {
      const dataSourceId = requireString(body.data_source_id || body.database_id, 'data_source_id');
      return json(await createViewEndpoint(context, dataSourceId, body));
    }
    if (method === 'GET' && parts[0] === 'views' && parts[1]) {
      return json(await getViewEndpoint(context, parts[1]));
    }
    if (method === 'PATCH' && parts[0] === 'views' && parts[1]) {
      return json(await updateViewEndpoint(context, parts[1], body));
    }
    if (method === 'DELETE' && parts[0] === 'views' && parts[1]) {
      return json(await deleteViewEndpoint(context, parts[1]));
    }
    if (method === 'GET' && parts[0] === 'comments' && parts.length === 1) {
      return json(await listCommentsEndpoint(context));
    }
    if (method === 'POST' && parts[0] === 'comments' && parts.length === 1) {
      return json(await createCommentEndpoint(context, body));
    }
    if (method === 'GET' && parts[0] === 'comments' && parts[1]) {
      return json(await getCommentEndpoint(context, parts[1]));
    }
    if (method === 'PATCH' && parts[0] === 'comments' && parts[1]) {
      return json(await updateCommentEndpoint(context, parts[1], body));
    }
    if (method === 'DELETE' && parts[0] === 'comments' && parts[1]) {
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
    if (method === 'POST' && parts[0] === 'file_uploads' && parts[1] && parts[2] === 'send') {
      return json(await sendFileUploadEndpoint(context, parts[1]));
    }
    if (method === 'POST' && parts[0] === 'file_uploads' && parts[1] && parts[2] === 'complete') {
      return json(await completeFileUploadEndpoint(context, parts[1]));
    }
    if (method === 'DELETE' && parts[0] === 'file_uploads' && parts[1] && parts.length === 2) {
      return json(await deleteFileUploadEndpoint(context, parts[1]));
    }
    return notionError(404, 'object_not_found', `Unsupported Notion-compatible endpoint: ${method} /v1/${parts.join('/')}`);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const explicitStatus = error && typeof error === 'object'
      ? Number((error as { status?: unknown; code?: unknown }).status
        ?? (error as { status?: unknown; code?: unknown }).code)
      : NaN;
    const mapped = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
      ? errorStatus(error)
      : { status: statusFromMessage(rawMessage), message: rawMessage };
    return notionError(mapped.status, errorCodeForStatus(mapped.status), mapped.message);
  }
}

export const notionCompatHandler = (context: unknown) => dispatch(context as FunctionContext);

export const GET = defineFunction(notionCompatHandler);
export const POST = defineFunction(notionCompatHandler);
export const PATCH = defineFunction(notionCompatHandler);
export const DELETE = defineFunction(notionCompatHandler);
