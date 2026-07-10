import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { boundedDbFromPageHint, boundedDbFromWorkspaceHint, ensurePageWorkspaceIndex, type AdminDbAccessor } from '../lib/workspace-db';
import { assertOrganizationDlpPolicy } from '../lib/enterprise-controls';
import { recordWorkspaceAudit } from '../lib/org-audit';
import {
  pageAccessRole as sharedPageAccessRole,
  workspaceAccessRole as sharedWorkspaceAccessRole,
} from '../lib/page-access';

import {
  listAll,
  requireString,
  getExisting,
  isNotFoundError,
  nowIso,
  newId,
  type TableQuery,
  type TransactDb,
} from '../lib/table-utils';
import type { ShareRole } from '../lib/page-access';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';
import { ensureDatabasePropertyIndexes, type DbRef as IndexDbRef } from '../lib/database-index';
import {
  NATIVE_FORMAT,
  NATIVE_DOCUMENT_LIMITS,
  NATIVE_FORMAT_VERSION,
  propTypeMap,
  remapNativeDocument,
  sanitizeNativeEntitiesForExport,
  validateNativeEnvelope,
  type NativeEntities,
  type NativeExportEnvelope,
  type NativeWarning,
  type RelationPair,
} from '../lib/native-document';
import type {
  Block as ABlock,
  Comment as AComment,
  DbProperty as ADbProperty,
  DbTemplate as ADbTemplate,
  DbView as ADbView,
  Page as APage,
} from '../lib/app-types';

type PageParentType = 'workspace' | 'page' | 'database';
type PageKind = 'page' | 'database';
type PropertyType = 'title' | 'rich_text' | 'number' | 'checkbox' | 'date';

const FILE_BUCKET = 'files';
const EXPORT_FILE_URL_TTL_SECONDS = 30 * 60;
const NATIVE_EXPORT_QUERY_CONCURRENCY = 8;

// Markdown/CSV imports accept raw client text; bound them like native imports
// (NATIVE_DOCUMENT_LIMITS) so one request cannot exhaust worker memory or
// write an unbounded number of blocks/rows. The "payload is too large"
// phrasing maps to 413 in the handler's errorStatus rules.
const IMPORT_TEXT_MAX_BYTES = NATIVE_DOCUMENT_LIMITS.maxBytes;
const IMPORT_MAX_BLOCKS = NATIVE_DOCUMENT_LIMITS.maxBlocks;
const IMPORT_CSV_MAX_ROWS = 10_000;

function boundedImportText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  // Every UTF-16 code unit encodes to at least one UTF-8 byte, so an
  // over-long string is over the byte cap without paying for an encode.
  const bytes = text.length > IMPORT_TEXT_MAX_BYTES
    ? text.length
    : new TextEncoder().encode(text).length;
  if (bytes > IMPORT_TEXT_MAX_BYTES) {
    throw new Error(`${label} payload is too large. Maximum size is ${IMPORT_TEXT_MAX_BYTES} bytes.`);
  }
  return text;
}

function boundedParsedBlocks(parsed: ParsedBlock[]): ParsedBlock[] {
  if (parsed.length > IMPORT_MAX_BLOCKS) {
    throw new Error(`Markdown payload is too large. Imports are limited to ${IMPORT_MAX_BLOCKS} blocks.`);
  }
  return parsed;
}

type RollbackCleanupFailure = { entity: string; id: string; error: unknown };

class NativeImportRollbackError extends Error {
  readonly originalError: unknown;
  readonly cleanupFailures: RollbackCleanupFailure[];

  constructor(
    originalError: unknown,
    cleanupFailures: RollbackCleanupFailure[],
    context = 'Native import',
  ) {
    super(`${context} failed and rollback was incomplete (${cleanupFailures.length} cleanup operation(s) failed).`);
    this.name = 'NativeImportRollbackError';
    this.originalError = originalError;
    this.cleanupFailures = cleanupFailures;
  }
}

// Best-effort compensation deletes shared by the non-transactional import
// paths (markdown replace, CSV import); a not-found row counts as already
// cleaned, everything else is reported so the caller can surface an
// incomplete rollback loudly instead of silently keeping orphans.
async function deleteImportedRows(
  entity: string,
  table: { delete(id: string): Promise<unknown> },
  ids: string[],
  cleanupFailures: RollbackCleanupFailure[],
) {
  for (const id of ids) {
    try {
      await table.delete(id);
    } catch (error) {
      if (isNotFoundError(error)) continue;
      cleanupFailures.push({ entity, id, error });
    }
  }
}

interface Workspace {
  id: string;
  name?: string;
  icon?: string;
  domain?: string;
  ownerId?: string;
}

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType: PageParentType;
  kind: PageKind;
  title: string;
  icon?: string;
  iconType?: 'none' | 'emoji' | 'image';
  font?: 'default' | 'serif' | 'mono';
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: 'default' | 'expanded' | 'off';
  pageCommentsDisplay?: 'default' | 'expanded' | 'off';
  properties?: Record<string, unknown>;
  isFavorite?: boolean;
  inTrash?: boolean;
  position: number;
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
  position: number;
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
  position: number;
}

interface DbView {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  position: number;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket?: string;
  key: string;
  scope?: string;
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  name?: string;
  contentType?: string;
  size?: number;
  status?: string;
  url?: string;
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

interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  getSignedUrl(key: string, options?: { expiresIn?: number }): Promise<string>;
}

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  admin: {
    db(namespace: string): DbRef;
  };
  storage?: FunctionStorageProxy;
}

interface ExportContext {
  fileUrl(value: string): Promise<string>;
}

interface ParsedBlock {
  type: string;
  plainText: string;
  content: Record<string, unknown>;
  indent: number;
}

interface NativeExportBudget {
  remaining: number;
  consume(count: number, label: string): void;
}

function nativeExportBudget(max: number): NativeExportBudget {
  return {
    remaining: max,
    consume(count, label) {
      if (count > this.remaining) {
        throw new Error(
          `Native Hanji export payload is too large. ${label} exceeds the ${max}-entity limit.`,
        );
      }
      this.remaining -= count;
    },
  };
}

async function listNativeExportRows<T>(
  query: TableQuery<T>,
  budget: NativeExportBudget,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await query.page(page).limit(1000).getList();
    const items = result.items ?? [];
    budget.consume(items.length, label);
    out.push(...items);
    if (!result.hasMore || items.length === 0) return out;
  }
  throw new Error(`Native Hanji export payload is too large. ${label} exceeded the pagination limit.`);
}

export async function mapNativeExportWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const limit = Math.max(1, Math.min(requested, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

const parentTypes = new Set<PageParentType>(['workspace', 'page', 'database']);
function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request) return {};
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseParentType(value: unknown, parentId?: string | null): PageParentType {
  if (typeof value === 'string' && parentTypes.has(value as PageParentType)) return value as PageParentType;
  return parentId ? 'page' : 'workspace';
}

function parsePosition(value: unknown, fallback = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positionBetween(a?: number, b?: number): number {
  if (a == null && b == null) return 1;
  if (a == null) return (b ?? 2) / 2;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

// Role resolution is canonical in lib/page-access; these wrappers only pin
// this function's "missing workspace is an error" contract.
async function workspaceRole(db: DbRef, workspaceId: string, actorId: string): Promise<ShareRole | undefined> {
  return sharedWorkspaceAccessRole(db, workspaceId, actorId, { requireWorkspace: true });
}

async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
}

async function assertWorkspaceEdit(db: DbRef, workspaceId: string, actorId: string) {
  const role = await workspaceRole(db, workspaceId, actorId);
  if (role && roleRanks[role] >= roleRanks.edit) return;
  throw new Error('Workspace access required.');
}

async function getReadableWorkspace(db: DbRef, workspaceId: string, actorId: string) {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  const role = await workspaceRole(db, workspaceId, actorId);
  if (role && roleRanks[role] >= roleRanks.view) return workspace;
  throw new Error('Workspace access required.');
}

async function assertPageRole(db: DbRef, page: Page, actorId: string, minimum: ShareRole, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks[minimum]) return;
  throw new Error('Page access required.');
}

async function getReadablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null) {
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (!page) throw new Error('Page was not found.');
  if (page.inTrash) throw new Error('Page is in trash.');
  await assertPageRole(db, page, actorId, 'view', actorEmail);
  return page;
}

async function assertWritableParent(
  db: DbRef,
  workspaceId: string,
  parentId: string | null,
  parentType: PageParentType,
  kind: PageKind,
  actorId: string,
  actorEmail?: string | null,
) {
  if (!parentId || parentType === 'workspace') {
    await assertWorkspaceEdit(db, workspaceId, actorId);
    return;
  }

  const parent = await getExisting(db.table<Page>('pages'), parentId);
  if (!parent) throw new Error('Parent page was not found.');
  if (parent.workspaceId !== workspaceId) throw new Error('Parent page is outside the workspace.');
  if (parent.inTrash) throw new Error('Parent page is in trash.');
  if (parent.isLocked) throw new Error('Parent page is locked.');
  if (parentType === 'database' && parent.kind !== 'database') throw new Error('Parent page is not a database.');
  if (parentType === 'database' && kind !== 'page') throw new Error('Only regular pages can be placed in a database.');
  if (parentType === 'page' && parent.kind !== 'page') throw new Error('Parent page is not a page.');
  await assertPageRole(db, parent, actorId, 'edit', actorEmail);
}

function rich(text: string) {
  return text ? [{ text }] : [];
}

function pageTitle(page: Page) {
  return page.title?.trim() || 'Untitled';
}

function workspaceTitle(workspace: Workspace) {
  return workspace.name?.trim() || workspace.domain?.trim() || 'Untitled workspace';
}

function markdownTextLiteral(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/([`*_~[\]])/g, '\\$1');
}

function markdownHref(href: string) {
  return href.replace(/\s/g, '%20').replace(/\)/g, '%29');
}

function markdownInlineCode(text: string) {
  const body = text.replace(/\n/g, ' ');
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(1, longest + 1));
  const padded = body.startsWith('`') || body.endsWith('`') ? ` ${body} ` : body;
  return `${fence}${padded}${fence}`;
}

function dateMentionHref(date: string) {
  return `notionlike://date/${encodeURIComponent(date)}`;
}

function personMentionHref(userId: string) {
  return `notionlike://person/${encodeURIComponent(userId)}`;
}

function markdownCell(value: string) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

function markdownRow(cells: string[]) {
  return `| ${cells.map(markdownCell).join(' | ')} |`;
}

// Neutralize spreadsheet formula sigils so Excel/Sheets/LibreOffice treat an
// exported cell as text instead of executing it (CSV formula injection). A cell
// whose raw value begins with = + - @ or a leading TAB/CR is prefixed with a
// single quote before the usual RFC-4180 quoting.
export function neutralizeCsvFormula(text: string) {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: string) {
  const text = neutralizeCsvFormula(String(value ?? ''));
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(cells: string[]) {
  return cells.map(csvCell).join(',');
}

function fenceForCode(text: string) {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function normalizeMarkdown(markdown: unknown) {
  return String(markdown ?? '').replace(/\r\n?/g, '\n');
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function rawString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function safeMentionId(value: unknown) {
  const trimmed = asString(value);
  if (!trimmed || trimmed.length > 200 || !/^[A-Za-z0-9._:@-]+$/.test(trimmed)) return '';
  return trimmed;
}

function safeDateMentionValue(value: unknown) {
  const trimmed = asString(value);
  if (!trimmed || trimmed.length > 80) return '';
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(
      trimmed,
    );
  if (!match) return '';

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText, , zoneHourText, zoneMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return '';
  if (hourText === undefined) return trimmed;

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const millis = millisText === undefined ? 0 : Number(millisText);
  if (hour > 23 || minute > 59 || second > 59 || millis > 999) return '';
  if (zoneHourText !== undefined) {
    const zoneHour = Number(zoneHourText);
    const zoneMinute = Number(zoneMinuteText);
    if (zoneHour > 23 || zoneMinute > 59) return '';
  }
  return trimmed;
}

function fileNameFromUrl(value: string) {
  try {
    const parsed = new URL(value, 'http://notionlike.local');
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '');
    return name || parsed.hostname || 'File';
  } catch {
    return value.split(/[/?#]/).filter(Boolean).at(-1) || 'File';
  }
}

function decodeStoragePath(path: string) {
  return path
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

function storageKeyFromUrl(value: string, bucket = FILE_BUCKET) {
  const raw = value.trim();
  if (!raw || !/^(https?:\/\/|\/)/i.test(raw)) return undefined;
  try {
    const parsed = new URL(raw, 'http://notionlike.local');
    if (parsed.searchParams.has('token')) return undefined;
    const marker = `/api/storage/${encodeURIComponent(bucket)}/`;
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return undefined;
    return decodeStoragePath(parsed.pathname.slice(index + marker.length));
  } catch {
    return undefined;
  }
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

async function fileExportContext(
  db: DbRef,
  workspaceId: string,
  pageIds: Set<string>,
  databaseIds: Set<string>,
  storage?: FunctionStorageProxy,
): Promise<ExportContext> {
  const proxy = storageBucket(storage, FILE_BUCKET);
  const uploads = await listAll(db.table<FileUpload>('file_uploads').where('workspaceId', '==', workspaceId));
  const allowedByKey = new Map<string, FileUpload>();

  for (const upload of uploads) {
    if (
      upload.status === 'uploaded' &&
      upload.key &&
      (upload.bucket || FILE_BUCKET) === FILE_BUCKET &&
      ((upload.pageId && pageIds.has(upload.pageId)) || (upload.databaseId && databaseIds.has(upload.databaseId)))
    ) {
      allowedByKey.set(upload.key, upload);
    }
  }

  return {
    async fileUrl(value: string) {
      const key = storageKeyFromUrl(value);
      if (!key || !allowedByKey.has(key) || !proxy) return value;
      try {
        return await proxy.getSignedUrl(key, { expiresIn: EXPORT_FILE_URL_TTL_SECONDS });
      } catch {
        return value;
      }
    },
  };
}

function parsedBlock(type: string, plainText: string, indent = 0, content?: Record<string, unknown>): ParsedBlock {
  return {
    type,
    plainText,
    indent,
    content: content ?? { rich: rich(plainText) },
  };
}

function safeInlineUrl(raw: unknown) {
  const value = asString(raw);
  if (!value) return '';
  if (/[\r\n\t<>"{}|\\^`]/.test(value)) return '';
  if (/^(https?:|mailto:|tel:|\/)/i.test(value)) return value;
  return '';
}

function pageIdFromHref(raw: string) {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return '';
  try {
    const parsed = new URL(value, 'http://notionlike.local');
    const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (parsed.protocol === 'notionlike:' && parsed.hostname === 'page') return safeMentionId(segments[0]);
    if (segments[0] === 'p') return safeMentionId(segments[1]);
  } catch {
    return '';
  }
  return '';
}

function dateFromHref(raw: string) {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'notionlike:' || parsed.hostname !== 'date') return '';
    return safeDateMentionValue(decodeURIComponent(parsed.pathname.replace(/^\//, '')));
  } catch {
    return '';
  }
}

function personIdFromHref(raw: string) {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'notionlike:' || parsed.hostname !== 'person') return '';
    return safeMentionId(decodeURIComponent(parsed.pathname.replace(/^\//, '')));
  } catch {
    return '';
  }
}

function blockIdFromHref(raw: string) {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'notionlike:' || parsed.hostname !== 'block') return '';
    return safeMentionId(decodeURIComponent(parsed.pathname.replace(/^\//, '')));
  } catch {
    return '';
  }
}

function isEscaped(text: string, index: number) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findUnescaped(text: string, needle: string, from: number) {
  for (let index = text.indexOf(needle, from); index >= 0; index = text.indexOf(needle, index + 1)) {
    if (!isEscaped(text, index)) return index;
  }
  return -1;
}

function escapedMarkdownLiteral(text: string, offset: number) {
  if (text[offset] !== '\\') return '';
  const next = text[offset + 1] ?? '';
  return /[\\`*_~[\]|]/.test(next) ? next : '';
}

function findInlineCodeSpan(text: string, offset: number) {
  if (text[offset] !== '`' || isEscaped(text, offset)) return null;
  const fence = text.slice(offset).match(/^`+/)?.[0] ?? '';
  if (!fence) return null;
  const close = findUnescaped(text, fence, offset + fence.length);
  if (close < 0) return null;
  let inner = text.slice(offset + fence.length, close);
  if (!inner) return null;
  if (
    fence.length > 1 &&
    inner.length >= 2 &&
    inner.startsWith(' ') &&
    inner.endsWith(' ') &&
    (inner[1] === '`' || inner[inner.length - 2] === '`')
  ) {
    inner = inner.slice(1, -1);
  }
  return { text: inner, nextOffset: close + fence.length };
}

function parseInlineMarkdown(text: string): Array<Record<string, unknown>> {
  if (!text) return [];
  const out: Array<Record<string, unknown>> = [];
  let index = 0;
  let plain = '';

  const flushPlain = () => {
    if (plain) {
      out.push({ text: plain });
      plain = '';
    }
  };

  const tryDelim = (open: string, mark: string) => {
    if (isEscaped(text, index) || !text.startsWith(open, index)) return false;
    const close = findUnescaped(text, open, index + open.length);
    if (close < 0) return false;
    const inner = text.slice(index + open.length, close);
    if (!inner || /^\s|\s$/.test(inner)) return false;
    flushPlain();
    for (const span of parseInlineMarkdown(inner)) out.push({ ...span, [mark]: true });
    index = close + open.length;
    return true;
  };

  while (index < text.length) {
    const escaped = escapedMarkdownLiteral(text, index);
    if (escaped) {
      plain += escaped;
      index += 2;
      continue;
    }

    const codeSpan = findInlineCodeSpan(text, index);
    if (codeSpan) {
      flushPlain();
      out.push({ text: codeSpan.text, code: true });
      index = codeSpan.nextOffset;
      continue;
    }

    if (text[index] === '[' && !isEscaped(text, index)) {
      const labelEnd = findUnescaped(text, ']', index + 1);
      if (labelEnd > 0 && text[labelEnd + 1] === '(') {
        const urlEnd = findUnescaped(text, ')', labelEnd + 2);
        if (urlEnd > labelEnd) {
          const label = text.slice(index + 1, labelEnd);
          const rawHref = text.slice(labelEnd + 2, urlEnd).trim();
          const pageId = pageIdFromHref(rawHref);
          const date = dateFromHref(rawHref);
          const userId = personIdFromHref(rawHref);
          const href = safeInlineUrl(rawHref);
          if (label && (pageId || date || userId || href) && !/\s/.test(rawHref)) {
            flushPlain();
            for (const span of parseInlineMarkdown(label)) {
              out.push(
                pageId
                  ? { ...span, mention: 'page', pageId }
                  : date
                    ? { ...span, mention: 'date', date }
                    : userId
                      ? { ...span, mention: 'person', userId }
                      : { ...span, link: href },
              );
            }
            index = urlEnd + 1;
            continue;
          }
        }
      }
    }

    if ((text[index] === '*' || text[index] === '_') && tryDelim(`${text[index]}${text[index]}`, 'bold')) continue;
    if (text[index] === '~' && tryDelim('~~', 'strikethrough')) continue;
    if ((text[index] === '*' || text[index] === '_') && tryDelim(text[index], 'italic')) continue;

    plain += text[index];
    index += 1;
  }

  flushPlain();
  return out;
}

function richMarkdown(text: string) {
  return parseInlineMarkdown(text);
}

function richPlainText(spans: Array<Record<string, unknown>>) {
  return spans.map((span) => (typeof span.text === 'string' ? span.text : '')).join('');
}

function parsedRichBlock(type: string, markdown: string, indent = 0, content?: Record<string, unknown>) {
  const spans = richMarkdown(markdown);
  return parsedBlock(type, richPlainText(spans), indent, { ...(content ?? {}), rich: spans });
}

function isMarkdownTableRow(line: string | undefined) {
  const trimmed = (line ?? '').trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.slice(1, -1).includes('|');
}

function splitMarkdownTableRow(line: string) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(cell.trim().replace(/<br\s*\/?>/gi, '\n'));
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim().replace(/<br\s*\/?>/gi, '\n'));
  return cells;
}

function isMarkdownTableSeparator(line: string | undefined) {
  if (!isMarkdownTableRow(line)) return false;
  const cells = splitMarkdownTableRow(line ?? '');
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownLinkLine(line: string, image = false) {
  const match = image ? line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/) : line.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return null;
  return { label: match[1] ?? '', href: match[2] ?? '' };
}

function parseWikiPageLink(line: string) {
  const match = line.match(/^\[\[(.+)\]\](?:\(([^)]+)\))?$/);
  if (!match) return null;
  return { label: match[1]?.trim() || 'Link to page', href: match[2]?.trim() ?? '' };
}

function parseBracketCommand(line: string, command: string) {
  const pattern = new RegExp(`^\\[${command}(?::\\s*([^\\]]+))?\\]$`, 'i');
  const match = line.match(pattern);
  if (!match) return null;
  return match[1]?.trim() ?? '';
}

function parseTabLabelCommand(line: string) {
  const value = parseBracketCommand(line, 'tab');
  if (value === null) return null;
  const match = value.match(/^(\S+)\s+(.+)$/u);
  if (!match) return { icon: '', label: value || 'Untitled' };
  return {
    icon: match[1],
    label: match[2].trim() || 'Untitled',
  };
}

function parsedMediaBlock(type: string, label: string, href: string, indent = 0) {
  const url = safeInlineUrl(href);
  if (!url) return parsedRichBlock('paragraph', label ? `[${label}](${href})` : href, indent);
  if (type === 'image') return parsedBlock('image', label, indent, { rich: [], url, caption: richMarkdown(label) });
  if (type === 'file') return parsedBlock('file', label, indent, { rich: [], url, fileName: label || fileNameFromUrl(url) });
  return parsedBlock(type, url, indent, { rich: [], url });
}

function parseMarkdownBlocks(markdown: unknown): ParsedBlock[] {
  const lines = normalizeMarkdown(markdown).split('\n');
  const blocks: ParsedBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = Math.floor((rawLine.match(/^\s*/)?.[0].length ?? 0) / 2);

    const fence = trimmed.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        body.push(lines[index]);
        index += 1;
      }
      const text = body.join('\n');
      blocks.push(parsedBlock('code', text, indent, { rich: rich(text), language: fence[1] ?? '' }));
      continue;
    }

    if (trimmed === '$$') {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== '$$') {
        body.push(lines[index]);
        index += 1;
      }
      const expression = body.join('\n').trim();
      blocks.push(parsedBlock('equation', expression, indent, { rich: [], expression }));
      continue;
    }

    const inlineEquation = trimmed.match(/^\$\$(.+)\$\$$/);
    if (inlineEquation) {
      const expression = inlineEquation[1].trim();
      blocks.push(parsedBlock('equation', expression, indent, { rich: [], expression }));
      continue;
    }

    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(lines[index + 1])) {
      const table = [splitMarkdownTableRow(line)];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        table.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(parsedBlock('simple_table', table.flat().join('\n'), indent, {
        rich: [],
        table,
        headerRow: true,
        headerColumn: false,
      }));
      continue;
    }

    const toggleHeading = trimmed.match(/^[▶▸]\s+(#{1,4})\s+(.+)$/) ?? trimmed.match(/^>\s+(#{1,4})\s+(.+)$/);
    if (toggleHeading) {
      blocks.push(parsedRichBlock(`toggle_heading_${toggleHeading[1].length}`, toggleHeading[2].trim(), indent));
      continue;
    }

    const toggle = trimmed.match(/^[▶▸]\s+(.+)$/);
    if (toggle) {
      blocks.push(parsedRichBlock('toggle', toggle[1].trim(), indent));
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push(parsedRichBlock(`heading_${heading[1].length}`, heading[2].trim(), indent));
      continue;
    }

    if (/^(---|\*\*\*|___)$/.test(trimmed)) {
      blocks.push(parsedBlock('divider', '', indent, { rich: [] }));
      continue;
    }

    const image = parseMarkdownLinkLine(trimmed, true);
    if (image) {
      blocks.push(parsedMediaBlock('image', image.label.trim() || 'Image', image.href, indent));
      continue;
    }

    const wikiPageLink = parseWikiPageLink(trimmed);
    if (wikiPageLink) {
      const childPageId = pageIdFromHref(wikiPageLink.href);
      blocks.push(parsedBlock('link_to_page', wikiPageLink.label, indent, {
        rich: [],
        ...(childPageId ? { childPageId } : {}),
      }));
      continue;
    }

    const markdownLink = parseMarkdownLinkLine(trimmed);
    if (markdownLink && /^video$/i.test(markdownLink.label.trim())) {
      blocks.push(parsedMediaBlock('video', markdownLink.label.trim(), markdownLink.href, indent));
      continue;
    }
    if (markdownLink && /^audio$/i.test(markdownLink.label.trim())) {
      blocks.push(parsedMediaBlock('audio', markdownLink.label.trim(), markdownLink.href, indent));
      continue;
    }
    if (markdownLink && /^embed$/i.test(markdownLink.label.trim())) {
      blocks.push(parsedMediaBlock('embed', markdownLink.label.trim(), markdownLink.href, indent));
      continue;
    }
    if (markdownLink && /^file(?::|$)/i.test(markdownLink.label.trim())) {
      const fileName = markdownLink.label.replace(/^file(?::\s*)?/i, '').trim() || fileNameFromUrl(markdownLink.href);
      blocks.push(parsedMediaBlock('file', fileName, markdownLink.href, indent));
      continue;
    }
    if (markdownLink) {
      const pageId = pageIdFromHref(markdownLink.href);
      if (pageId || /^link to page$/i.test(markdownLink.label.trim())) {
        blocks.push(parsedBlock('link_to_page', markdownLink.label.trim() || 'Link to page', indent, {
          rich: [],
          ...(pageId ? { childPageId: pageId } : {}),
        }));
        continue;
      }
    }

    const buttonLabel = parseBracketCommand(trimmed, 'button');
    if (buttonLabel !== null) {
      const label = buttonLabel || 'New button';
      blocks.push(parsedBlock('button', label, indent, {
        rich: [],
        buttonLabel: label,
        buttonTemplate: [{ type: 'to_do', content: { rich: rich('New task'), checked: false } }],
      }));
      continue;
    }

    const tabLabel = parseTabLabelCommand(trimmed);
    if (tabLabel) {
      blocks.push(parsedRichBlock('paragraph', tabLabel.label, indent, {
        ...(tabLabel.icon ? { icon: tabLabel.icon } : {}),
      }));
      continue;
    }

    if (/^\[table of contents\]$/i.test(trimmed)) {
      blocks.push(parsedBlock('table_of_contents', 'Table of contents', indent, { rich: [] }));
      continue;
    }

    if (/^\[breadcrumb\]$/i.test(trimmed)) {
      blocks.push(parsedBlock('breadcrumb', 'Breadcrumb', indent, { rich: [] }));
      continue;
    }

    const synced = trimmed.match(/^\[synced block\](?:\(([^)]+)\))?$/i);
    if (synced) {
      const syncedBlockId = synced[1] ? blockIdFromHref(synced[1]) : '';
      blocks.push(parsedBlock('synced_block', 'Synced block', indent, { rich: [], ...(syncedBlockId ? { syncedBlockId } : {}) }));
      continue;
    }

    if (/^\[tabs\]$/i.test(trimmed)) {
      blocks.push(parsedBlock('tab', '', indent, { rich: [] }));
      continue;
    }

    if (/^\[columns\]$/i.test(trimmed)) {
      blocks.push(parsedBlock('column_list', '', indent, { rich: [] }));
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      const value = quote[1].trim();
      const callout = value.match(/^(!|info|note|tip|warning)\s+(.+)$/i);
      blocks.push(callout ? parsedRichBlock('callout', callout[2].trim(), indent, { icon: callout[1] }) : parsedRichBlock('quote', value, indent));
      continue;
    }

    const todo = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      const indent = Math.floor(todo[1].length / 2);
      const text = todo[3].trim();
      blocks.push(parsedRichBlock('to_do', text, indent, { checked: todo[2].toLowerCase() === 'x' }));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push(parsedRichBlock('bulleted_list_item', bullet[2].trim(), Math.floor(bullet[1].length / 2)));
      continue;
    }

    const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push(parsedRichBlock('numbered_list_item', numbered[2].trim(), Math.floor(numbered[1].length / 2)));
      continue;
    }

    blocks.push(parsedRichBlock('paragraph', trimmed, indent));
  }

  return blocks;
}

function parentForIndent(stack: Map<number, string>, indent: number) {
  for (let depth = indent - 1; depth >= 0; depth -= 1) {
    const parentId = stack.get(depth);
    if (parentId) return parentId;
  }
  return null;
}

async function insertParsedBlocks(
  blocksTable: TableRef<Block>,
  pageId: string,
  parsed: ParsedBlock[],
  actorId: string,
  rootAfterPosition?: number,
  // Filled as each insert lands, so a caller can compensate a mid-loop failure
  // (the returned array is lost when this function throws).
  insertedSink?: Block[],
) {
  const stack = new Map<number, string>();
  const lastPositionByParent = new Map<string, number>();
  if (typeof rootAfterPosition === 'number' && Number.isFinite(rootAfterPosition)) {
    lastPositionByParent.set('__root__', rootAfterPosition);
  }
  const inserted: Block[] = insertedSink ?? [];

  for (const item of parsed) {
    const parentId = parentForIndent(stack, item.indent);
    const parentKey = parentId ?? '__root__';
    const position = positionBetween(lastPositionByParent.get(parentKey), undefined);
    const now = nowIso();
    const block: Block = {
      id: newId(),
      pageId,
      parentId,
      type: item.type,
      content: item.content,
      plainText: item.plainText,
      position,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    const created = await blocksTable.insert(block);
    inserted.push(created);
    lastPositionByParent.set(parentKey, position);
    stack.set(item.indent, created.id);
    for (const depth of Array.from(stack.keys())) {
      if (depth > item.indent) stack.delete(depth);
    }
  }

  return inserted;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((items) => items.some((item) => item.trim().length > 0));
}

function csvHeaders(rawHeaders: string[], width: number) {
  const used = new Map<string, number>();
  return Array.from({ length: width }, (_, index) => {
    const fallback = index === 0 ? 'Name' : `Column ${index + 1}`;
    const base = (rawHeaders[index] ?? '').trim() || fallback;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base} ${count + 1}`;
  });
}

function parseCsvNumber(value: string) {
  const raw = value.trim().replace(/,/g, '');
  if (!/^[-+]?(?:\d+|\d*\.\d+)$/.test(raw)) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function parseCsvBoolean(value: string) {
  const raw = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'checked', 'check', 'x', 'on'].includes(raw)) return true;
  if (['false', 'no', 'n', '0', 'unchecked', 'off'].includes(raw)) return false;
  return null;
}

function dateFromParts(year: number, month: number, day: number) {
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseCsvDate(value: string) {
  const raw = value.trim();
  if (!raw || /^\d+$/.test(raw)) return null;
  // Korean-style "YYYY년 MM월 DD일" (trailing 일 optional).
  const kr = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/.exec(raw);
  if (kr) return dateFromParts(Number(kr[1]), Number(kr[2]), Number(kr[3]));
  // ISO / YMD with -, /, or . separators; tolerate spaces around them so the
  // common Korean "2026. 05. 20" form parses too.
  const iso = /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/.exec(raw);
  if (iso) return dateFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2,4})$/.exec(raw);
  if (us) {
    const year = Number(us[3]) < 100 ? Number(us[3]) + 2000 : Number(us[3]);
    return dateFromParts(year, Number(us[1]), Number(us[2]));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateFromParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

// A column is typed if a strong majority of its non-empty cells match; the few
// outliers (typos, "N/A", stray notes) import empty instead of forcing the
// whole column to plain text. Blanks are ignored entirely (filtered before the
// ratio). Bare integers/years are rejected as dates (see parseCsvDate), so a
// numeric column with junk can never be mistaken for a date column.
const CSV_TYPE_MATCH_RATIO = 0.7;

function csvMatchRatio(sample: string[], matches: (value: string) => boolean) {
  if (sample.length === 0) return 0;
  let matched = 0;
  for (const value of sample) if (matches(value)) matched += 1;
  return matched / sample.length;
}

export function inferCsvPropertyType(values: string[]): PropertyType {
  const sample = values.map((value) => value.trim()).filter(Boolean);
  if (sample.length === 0) return 'rich_text';
  // Booleans must be unanimous — a partial match usually means it isn't a checkbox.
  if (sample.every((value) => parseCsvBoolean(value) !== null)) return 'checkbox';
  if (csvMatchRatio(sample, (value) => parseCsvNumber(value) !== null) >= CSV_TYPE_MATCH_RATIO) return 'number';
  if (csvMatchRatio(sample, (value) => parseCsvDate(value) !== null) >= CSV_TYPE_MATCH_RATIO) return 'date';
  return 'rich_text';
}

function csvValueForType(type: PropertyType, value: string) {
  if (!value.trim()) return null;
  if (type === 'number') return parseCsvNumber(value);
  if (type === 'checkbox') return parseCsvBoolean(value);
  if (type === 'date') return parseCsvDate(value);
  return value;
}

async function createPage(
  db: DbRef,
  admin: AdminDbAccessor,
  body: {
    workspaceId: string;
    parentId: string | null;
    parentType: PageParentType;
    kind: PageKind;
    title: string;
    position: number;
    properties?: Record<string, unknown>;
    // Caller-assigned id so multi-record imports can track rollback intent
    // BEFORE the write (importNativeDocument pattern).
    id?: string;
  },
  actorId: string,
  actorEmail?: string | null,
) {
  await assertWritableParent(db, body.workspaceId, body.parentId, body.parentType, body.kind, actorId, actorEmail);
  const now = nowIso();
  const inserted = await db.table<Page>('pages').insert({
    id: body.id ?? newId(),
    workspaceId: body.workspaceId,
    parentId: body.parentId,
    parentType: body.parentType,
    kind: body.kind,
    title: body.title,
    icon: '',
    iconType: 'none',
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    isPublic: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties: body.properties,
    isFavorite: false,
    inTrash: false,
    position: body.position,
    createdBy: actorId,
    lastEditedBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  // Imported pages are page rows; index them synchronously so immediate
  // exports/opens resolve without waiting for the trigger.
  await ensurePageWorkspaceIndex(admin, inserted.id, inserted.workspaceId);
  return inserted;
}

async function importMarkdownPage(db: DbRef, admin: AdminDbAccessor, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const parentId = optionalString(body.parentId) ?? null;
  const parentType = parseParentType(body.parentType, parentId);
  const title = optionalString(body.title) ?? 'Imported page';
  // Bound and parse BEFORE creating the page so an over-limit payload rejects
  // without leaving an empty imported page behind.
  const parsed = boundedParsedBlocks(parseMarkdownBlocks(boundedImportText(body.markdown, 'Markdown')));
  const page = await createPage(
    db,
    admin,
    {
      workspaceId,
      parentId,
      parentType,
      kind: 'page',
      title,
      position: parsePosition(body.position),
    },
    actorId,
    actorEmail,
  );
  const blocks = await insertParsedBlocks(
    db.table<Block>('blocks'),
    page.id,
    parsed,
    actorId,
  );
  return { page, blocks, count: blocks.length };
}

async function appendMarkdownToPage(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pageId = requireString(body.pageId, 'pageId');
  const page = await getReadablePage(db, pageId, actorId, actorEmail);
  if (page.isLocked) throw new Error('Page is locked.');
  await assertPageRole(db, page, actorId, 'edit', actorEmail);

  const parsed = boundedParsedBlocks(parseMarkdownBlocks(boundedImportText(body.markdown, 'Markdown')));
  const existing = await listAll(db.table<Block>('blocks').where('pageId', '==', page.id));
  const rootAfterPosition = existing
    .filter((block) => (block.parentId ?? null) === null)
    .reduce((max, block) => Math.max(max, block.position ?? 0), 0);
  const blocks = await insertParsedBlocks(
    db.table<Block>('blocks'),
    page.id,
    parsed,
    actorId,
    rootAfterPosition,
  );
  return { page, blocks, count: blocks.length };
}

async function replaceMarkdownPage(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pageId = requireString(body.pageId, 'pageId');
  const page = await getReadablePage(db, pageId, actorId, actorEmail);
  if (page.isLocked) throw new Error('Page is locked.');
  await assertPageRole(db, page, actorId, 'edit', actorEmail);
  const parsed = boundedParsedBlocks(parseMarkdownBlocks(boundedImportText(body.markdown, 'Markdown')));

  const blocksTable = db.table<Block>('blocks');
  const existing = await listAll(blocksTable.where('pageId', '==', page.id));
  const rootAfterPosition =
    existing.reduce((max, block) => Math.max(max, block.position ?? 0), 0) + 1000;

  // Insert-new first (positioned after the old content), then delete-old,
  // compensating each phase (importNativeDocument pattern): a partial failure
  // must never leave the page holding both the old and the new content.
  const inserted: Block[] = [];
  const removeInserted = async (error: unknown, cleanupFailures: RollbackCleanupFailure[] = []): Promise<never> => {
    await deleteImportedRows(
      'block',
      blocksTable,
      inserted.map((block) => block.id).reverse(),
      cleanupFailures,
    );
    if (cleanupFailures.length > 0) {
      throw new NativeImportRollbackError(error, cleanupFailures, 'Markdown replace');
    }
    throw error;
  };

  let blocks: Block[];
  try {
    blocks = await insertParsedBlocks(
      blocksTable,
      page.id,
      parsed,
      actorId,
      rootAfterPosition,
      inserted,
    );
  } catch (error) {
    return await removeInserted(error);
  }

  const deleteResults = await Promise.allSettled(existing.map((block) => blocksTable.delete(block.id)));
  const failedDelete = deleteResults.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' && !isNotFoundError(result.reason),
  );
  if (failedDelete) {
    // The old content stays authoritative: restore the old blocks that were
    // already deleted, then remove the new ones.
    const cleanupFailures: RollbackCleanupFailure[] = [];
    for (let index = 0; index < existing.length; index += 1) {
      if (deleteResults[index].status !== 'fulfilled') continue;
      try {
        await blocksTable.insert(existing[index]);
      } catch (cleanupError) {
        cleanupFailures.push({ entity: 'block', id: existing[index].id, error: cleanupError });
      }
    }
    return await removeInserted(failedDelete.reason, cleanupFailures);
  }
  return { page, blocks, deletedIds: existing.map((block) => block.id), count: blocks.length };
}

async function importCsvDatabase(db: DbRef, admin: AdminDbAccessor, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const parentId = optionalString(body.parentId) ?? null;
  const parentType = parseParentType(body.parentType, parentId);
  const title = optionalString(body.title) ?? 'Imported database';
  const rows = parseCsv(boundedImportText(body.csv, 'CSV'));
  if (rows.length === 0) throw new Error('No CSV rows found.');

  const width = Math.max(...rows.map((row) => row.length), 1);
  const headers = csvHeaders(rows[0], width);
  const dataRows = rows
    .slice(1)
    .map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''))
    .filter((row) => row.some((cell) => cell.trim().length > 0));
  if (dataRows.length > IMPORT_CSV_MAX_ROWS) {
    throw new Error(`CSV payload is too large. Imports are limited to ${IMPORT_CSV_MAX_ROWS} rows.`);
  }
  const types = headers.map((_, index) =>
    index === 0 ? 'title' : inferCsvPropertyType(dataRows.map((row) => row[index] ?? '')),
  );

  const pagesTable = db.table<Page>('pages');
  const propsTable = db.table<DbProperty>('db_properties');
  const viewsTable = db.table<DbView>('db_views');
  const pageWorkspaceIndexTable = admin
    .db('app')
    .table<{ id: string; workspaceId: string }>('page_workspace_index');
  // Track cleanup intent BEFORE each write (importNativeDocument pattern) so a
  // failure anywhere mid-import compensates instead of leaving a half-imported
  // database behind.
  const created = {
    pages: [] as string[],
    pageWorkspaceIndexes: [] as string[],
    props: [] as string[],
    views: [] as string[],
  };
  try {
    const databaseId = newId();
    created.pages.push(databaseId);
    created.pageWorkspaceIndexes.push(databaseId);
    const database = await createPage(
      db,
      admin,
      {
        id: databaseId,
        workspaceId,
        parentId,
        parentType,
        kind: 'database',
        title,
        position: parsePosition(body.position),
      },
      actorId,
      actorEmail,
    );

    const properties: DbProperty[] = [];
    const propertyIds = headers.map(() => newId());
    for (let index = 0; index < headers.length; index += 1) {
      const type = types[index] as PropertyType;
      created.props.push(propertyIds[index]);
      const property = await propsTable.insert({
        id: propertyIds[index],
        databaseId: database.id,
        name: headers[index],
        type,
        config: type === 'number' ? { numberFormat: 'number' } : {},
        position: index + 1,
      });
      properties.push(property);
    }

    const viewId = newId();
    created.views.push(viewId);
    const view = await viewsTable.insert({
      id: viewId,
      databaseId: database.id,
      name: 'Table',
      type: 'table',
      position: 1,
      config: {
        propertyOrder: properties.map((prop) => prop.id),
        visibleProperties: properties.map((prop) => prop.id),
      },
    });

    const pageRows: Page[] = [];
    for (let index = 0; index < dataRows.length; index += 1) {
      const cells = dataRows[index];
      const values: Record<string, unknown> = {};
      for (let col = 1; col < properties.length; col += 1) {
        const prop = properties[col];
        const value = csvValueForType(prop.type as PropertyType, cells[col] ?? '');
        if (value !== null) values[prop.id] = value;
      }
      const rowId = newId();
      created.pages.push(rowId);
      created.pageWorkspaceIndexes.push(rowId);
      pageRows.push(
        await createPage(
          db,
          admin,
          {
            id: rowId,
            workspaceId,
            parentId: database.id,
            parentType: 'database',
            kind: 'page',
            title: cells[0]?.trim() ?? '',
            position: index + 1,
            properties: values,
          },
          actorId,
          actorEmail,
        ),
      );
    }

    return { page: database, properties, view, rows: pageRows, count: pageRows.length };
  } catch (error) {
    const cleanupFailures: RollbackCleanupFailure[] = [];
    await deleteImportedRows('database view', viewsTable, created.views, cleanupFailures);
    await deleteImportedRows('database property', propsTable, created.props, cleanupFailures);
    const failedPageDeletes = new Set<string>();
    for (const id of created.pages.slice().reverse()) {
      try {
        await pagesTable.delete(id);
      } catch (cleanupError) {
        if (isNotFoundError(cleanupError)) continue;
        cleanupFailures.push({ entity: 'page', id, error: cleanupError });
        failedPageDeletes.add(id);
      }
    }
    // Keep an index when its page could not be removed (it is still a valid
    // route); otherwise remove it so rollback leaves no stale page route.
    await deleteImportedRows(
      'page workspace index',
      pageWorkspaceIndexTable,
      created.pageWorkspaceIndexes.filter((id) => !failedPageDeletes.has(id)).reverse(),
      cleanupFailures,
    );
    if (cleanupFailures.length > 0) {
      throw new NativeImportRollbackError(error, cleanupFailures, 'CSV import');
    }
    throw error;
  }
}

function blockText(block: Block) {
  const richValue = block.content?.rich;
  if (Array.isArray(richValue)) {
    return richValue
      .map((span) => (span && typeof span === 'object' && typeof (span as { text?: unknown }).text === 'string'
        ? (span as { text: string }).text
        : ''))
      .join('');
  }
  return block.plainText ?? '';
}

function blockRichSpans(block: Block): Array<Record<string, unknown>> {
  const richValue = block.content?.rich;
  if (!Array.isArray(richValue)) return [];
  return richValue.filter((span): span is Record<string, unknown> => !!span && typeof span === 'object');
}

function spansMarkdown(spans: Array<Record<string, unknown>>) {
  if (spans.length === 0) return '';
  return spans
    .map((span) => {
      const raw = rawString(span.text);
      if (!raw) return '';
      if (span.code === true) return markdownInlineCode(raw);
      if (!raw.trim()) return raw;

      const leading = raw.match(/^\s*/)?.[0] ?? '';
      const trailing = raw.match(/\s*$/)?.[0] ?? '';
      let body = markdownTextLiteral(raw.slice(leading.length, raw.length - trailing.length));
      if (span.bold === true) body = `**${body}**`;
      if (span.italic === true) body = `*${body}*`;
      if (span.strikethrough === true) body = `~~${body}~~`;

      const mention = asString(span.mention);
      if (mention === 'date') {
        const date = safeDateMentionValue(span.date);
        if (date) return `${leading}[${body}](${markdownHref(dateMentionHref(date))})${trailing}`;
      }
      if (mention === 'person') {
        const userId = safeMentionId(span.userId);
        if (userId) return `${leading}[${body}](${markdownHref(personMentionHref(userId))})${trailing}`;
      }

      const pageId = mention === 'page' ? safeMentionId(span.pageId) : '';
      const href = pageId ? `/p/${encodeURIComponent(pageId)}` : safeInlineUrl(span.link);
      if (href) return `${leading}[${body}](${markdownHref(href)})${trailing}`;
      return `${leading}${body}${trailing}`;
    })
    .join('');
}

function blockMarkdownText(block: Block) {
  const markdown = spansMarkdown(blockRichSpans(block));
  return markdown || markdownTextLiteral(block.plainText ?? '');
}

async function attachmentMarkdown(value: unknown, context: ExportContext) {
  if (!value) return '';
  const record = typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const url = typeof value === 'string'
    ? value.trim()
    : asString(record.url) || asString(record.src) || asString(record.href) || '';
  if (!url) return '';
  const name = asString(record.name) || asString(record.fileName) || fileNameFromUrl(url);
  const signedUrl = safeInlineUrl(await context.fileUrl(url));
  return signedUrl ? `[${markdownTextLiteral(name)}](${markdownHref(signedUrl)})` : markdownTextLiteral(name);
}

async function fileListMarkdown(value: unknown, context: ExportContext) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const links = (await Promise.all(items.map((item) => attachmentMarkdown(item, context)))).filter(Boolean);
  return links.join(', ');
}

async function attachmentCsv(value: unknown, context: ExportContext) {
  if (!value) return '';
  const record = typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const url = typeof value === 'string'
    ? value.trim()
    : asString(record.url) || asString(record.src) || asString(record.href) || '';
  if (!url) return '';
  const name = asString(record.name) || asString(record.fileName) || fileNameFromUrl(url);
  return `${name} (${await context.fileUrl(url)})`;
}

async function fileListCsv(value: unknown, context: ExportContext) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const links = (await Promise.all(items.map((item) => attachmentCsv(item, context)))).filter(Boolean);
  return links.join('; ');
}

function markdownTable(table: unknown) {
  const rows =
    Array.isArray(table) && table.length > 0
      ? table.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : ['']))
      : [];
  if (rows.length === 0) return '';
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    Array.from({ length: colCount }, (_, index) =>
      markdownTextLiteral(String(row[index] ?? '')).replace(/\|/g, '\\|').replace(/\n/g, '<br>'),
    ),
  );
  const header = normalized[0] ?? Array.from({ length: colCount }, () => '');
  const body = normalized.slice(1);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function pageLinkMarkdown(block: Block, fallback: string) {
  const title = markdownTextLiteral((block.plainText ?? '').trim() || fallback);
  const pageId = safeMentionId(block.content?.childPageId);
  return pageId ? `[[${title}]](${markdownHref(`/p/${encodeURIComponent(pageId)}`)})` : `[[${title}]]`;
}

async function blockMarkdown(block: Block, context: ExportContext) {
  const text = block.type === 'code' ? blockText(block) : blockMarkdownText(block).trimEnd();
  switch (block.type) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'heading_4':
      return `#### ${text}`;
    case 'toggle_heading_1':
      return `> # ${text}`;
    case 'toggle_heading_2':
      return `> ## ${text}`;
    case 'toggle_heading_3':
      return `> ### ${text}`;
    case 'toggle_heading_4':
      return `> #### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `- [${block.content?.checked ? 'x' : ' '}] ${text}`;
    case 'toggle':
      return `> ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'callout': {
      const icon = asString(block.content?.icon);
      return `> ${icon ? `${markdownTextLiteral(icon)} ` : ''}${text}`;
    }
    case 'code': {
      const fence = fenceForCode(text);
      const language = String(block.content?.language ?? '').replace(/[^\w-]/g, '');
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case 'equation':
      return `$$\n${asString(block.content?.expression) || text}\n$$`;
    case 'divider':
      return '---';
    case 'simple_table':
      return markdownTable(block.content?.table);
    case 'image': {
      const url = asString(block.content?.url);
      if (!url) return '';
      const caption = blockText(block) || asString(block.content?.fileName) || 'Image';
      const signedUrl = safeInlineUrl(await context.fileUrl(url));
      return signedUrl ? `![${markdownTextLiteral(caption)}](${markdownHref(signedUrl)})` : markdownTextLiteral(caption);
    }
    case 'video':
    case 'audio':
    case 'bookmark':
    case 'embed':
    case 'file': {
      const url = asString(block.content?.url);
      const label =
        asString(block.content?.fileName) ||
        block.plainText ||
        (url ? fileNameFromUrl(url) : block.type);
      if (!url) return markdownTextLiteral(label);
      const signedUrl = safeInlineUrl(await context.fileUrl(url));
      return signedUrl
        ? `[${markdownTextLiteral(block.type === 'file' ? `File: ${label}` : label)}](${markdownHref(signedUrl)})`
        : markdownTextLiteral(label);
    }
    case 'child_page':
    case 'link_to_page':
      return pageLinkMarkdown(block, 'Page');
    case 'child_database':
    case 'inline_database':
      return pageLinkMarkdown(block, 'Database');
    case 'button':
      return `[Button: ${markdownTextLiteral(asString(block.content?.buttonLabel) || block.plainText || 'New button')}]`;
    case 'table_of_contents':
      return '[Table of contents]';
    case 'breadcrumb':
      return '[Breadcrumb]';
    case 'synced_block':
      return '[Synced block]';
    case 'tab':
      return '[Tabs]';
    case 'column_list':
      return '[Columns]';
    case 'column':
      return '[Column]';
    default:
      return text;
  }
}

async function tabLabelMarkdown(block: Block, context: ExportContext) {
  const icon = asString(block.content?.icon);
  if (!icon) return '';
  const label = (await blockMarkdown(block, context)).trim() || 'Untitled';
  return `[Tab: ${markdownTextLiteral(icon)} ${label}]`;
}

// Children lookup built once per page (the previous per-block filter made the
// walk O(n²) per page). Exported for the export-cycle regression test.
export function blockChildrenByParent(blocks: Block[]): Map<string, Block[]> {
  const byParent = new Map<string, Block[]>();
  for (const block of blocks) {
    if (!block.parentId) continue;
    const children = byParent.get(block.parentId) ?? [];
    children.push(block);
    byParent.set(block.parentId, children);
  }
  for (const children of byParent.values()) {
    children.sort((a, b) => a.position - b.position);
  }
  return byParent;
}

export async function blockTreeMarkdown(
  root: Block,
  childrenOf: Map<string, Block[]>,
  context: ExportContext,
) {
  const lines: string[] = [];
  // Corrupted parent links must terminate instead of recursing forever — the
  // page walks carry the same visited guard.
  const visited = new Set<string>();
  const collect = async (block: Block, depth: number, parent?: Block) => {
    if (visited.has(block.id)) return;
    visited.add(block.id);
    const markdown =
      parent?.type === 'tab' && block.type === 'paragraph'
        ? (await tabLabelMarkdown(block, context)) || (await blockMarkdown(block, context))
        : await blockMarkdown(block, context);
    if (markdown) {
      const indent = '  '.repeat(depth);
      lines.push(markdown.split('\n').map((line) => `${indent}${line}`).join('\n'));
    }
    for (const child of childrenOf.get(block.id) ?? []) {
      await collect(child, depth + 1, block);
    }
  };
  await collect(root, 0);
  return lines.join('\n');
}

async function propertyValue(row: Page, prop: DbProperty, context: ExportContext) {
  if (prop.type === 'title') return row.title ?? '';
  const value = row.properties?.[prop.id];
  if (prop.type === 'checkbox') return value ? 'checked' : 'unchecked';
  if (prop.type === 'files') return fileListMarkdown(value, context);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
          return (item as { name: string }).name;
        }
        return String(item ?? '');
      })
      .filter(Boolean)
      .join(', ');
  }
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  if (value == null) return '';
  return String(value);
}

async function propertyCsvValue(row: Page, prop: DbProperty, context: ExportContext) {
  if (prop.type === 'title') return row.title ?? '';
  const value = row.properties?.[prop.id];
  if (prop.type === 'checkbox') return value ? 'true' : 'false';
  if (prop.type === 'files') return fileListCsv(value, context);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
          return (item as { name: string }).name;
        }
        return String(item ?? '');
      })
      .filter(Boolean)
      .join('; ');
  }
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  if (value == null) return '';
  return String(value);
}

async function databaseMarkdownLines(
  db: DbRef,
  page: Page,
  context: ExportContext,
  rowHeadingLevel = 2,
  visited = new Set<string>(),
) {
  const lines: string[] = [];

  if (page.kind === 'database') {
    const [properties, rows, workspacePages] = await Promise.all([
      listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', page.id)),
      listAll(db.table<Page>('pages').where('parentId', '==', page.id)),
      listAll(db.table<Page>('pages').where('workspaceId', '==', page.workspaceId)),
    ]);
    const props = properties.sort((a, b) => a.position - b.position);
    const visibleRows = rows
      .filter((row) => row.parentType === 'database' && !row.inTrash)
      .sort((a, b) => a.position - b.position);
    const childPages = childrenByParent(workspacePages.filter((item) => !item.inTrash));
    if (props.length > 0) {
      const rowLines = await Promise.all(
        visibleRows.map(async (row) =>
          markdownRow(await Promise.all(props.map((prop) => propertyValue(row, prop, context)))),
        ),
      );
      lines.push(
        markdownRow(props.map((prop) => prop.name || 'Untitled')),
        markdownRow(props.map(() => '---')),
        ...rowLines,
      );
    }
    for (const row of visibleRows) {
      const rowPageLines = await pageWithDescendantsMarkdownLines(
        db,
        row,
        childPages,
        context,
        rowHeadingLevel,
        visited,
      );
      if (rowPageLines.length > 0) lines.push('', ...rowPageLines);
    }
  }

  return lines;
}

async function pageBodyMarkdownLines(db: DbRef, page: Page, context: ExportContext) {
  const blocks = (await listAll(db.table<Block>('blocks').where('pageId', '==', page.id))).sort(
    (a, b) => a.position - b.position,
  );
  const roots = blocks
    .filter((block) => (block.parentId ?? null) === null)
    .sort((a, b) => a.position - b.position);
  const childrenOf = blockChildrenByParent(blocks);
  return (await Promise.all(roots.map((block) => blockTreeMarkdown(block, childrenOf, context)))).filter(Boolean);
}

async function pageMarkdownLines(
  db: DbRef,
  page: Page,
  context: ExportContext,
  headingLevel = 1,
  visited = new Set<string>(),
) {
  if (visited.has(page.id)) return [];
  visited.add(page.id);
  const safeHeadingLevel = Math.min(Math.max(Math.trunc(headingLevel), 1), 6);
  const lines = [`${'#'.repeat(safeHeadingLevel)} ${pageTitle(page)}`];

  const databaseMarkdown = await databaseMarkdownLines(db, page, context, safeHeadingLevel + 1, visited);
  if (databaseMarkdown.length > 0) lines.push('', ...databaseMarkdown);

  const bodyMarkdown = await pageBodyMarkdownLines(db, page, context);
  if (bodyMarkdown.length > 0) lines.push('', bodyMarkdown.join('\n\n'));

  return lines;
}

async function pageWithDescendantsMarkdownLines(
  db: DbRef,
  page: Page,
  childPages: Map<string, Page[]>,
  context: ExportContext,
  headingLevel: number,
  visited: Set<string>,
) {
  const lines = await pageMarkdownLines(db, page, context, headingLevel, visited);
  if (lines.length === 0) return lines;

  for (const child of childPages.get(page.id) ?? []) {
    const childLines = await pageWithDescendantsMarkdownLines(
      db,
      child,
      childPages,
      context,
      headingLevel + 1,
      visited,
    );
    if (childLines.length > 0) lines.push('', ...childLines);
  }

  return lines;
}

async function pageExportScope(db: DbRef, page: Page) {
  const pageIds = new Set([page.id]);
  const databaseIds = new Set<string>();
  if (page.kind === 'database') {
    databaseIds.add(page.id);
    const [rows, workspacePages] = await Promise.all([
      listAll(db.table<Page>('pages').where('parentId', '==', page.id)),
      listAll(db.table<Page>('pages').where('workspaceId', '==', page.workspaceId)),
    ]);
    const childPages = childrenByParent(workspacePages.filter((item) => !item.inTrash));
    function visit(pageToAdd: Page) {
      if (pageToAdd.inTrash || pageIds.has(pageToAdd.id)) return;
      pageIds.add(pageToAdd.id);
      if (pageToAdd.kind === 'database') databaseIds.add(pageToAdd.id);
      for (const child of childPages.get(pageToAdd.id) ?? []) visit(child);
    }
    for (const row of rows) {
      if (row.parentType === 'database' && !row.inTrash) visit(row);
    }
  }
  return { pageIds, databaseIds };
}

async function exportPageMarkdown(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
) {
  const page = await getReadablePage(db, requireString(body.pageId, 'pageId'), actorId, actorEmail);
  await assertOrganizationDlpPolicy(
    db,
    page.workspaceId,
    'exports',
    'Exports are blocked by organization DLP policy.',
  );
  const scope = await pageExportScope(db, page);
  const context = await fileExportContext(db, page.workspaceId, scope.pageIds, scope.databaseIds, storage);
  const lines = await pageMarkdownLines(db, page, context, 1);
  await recordWorkspaceAudit(db, {
    workspaceId: page.workspaceId,
    actorId,
    action: 'export.page_markdown',
    targetType: page.kind === 'database' ? 'database' : 'page',
    targetId: page.id,
    metadata: {
      pageId: page.id,
      kind: page.kind,
      pageCount: scope.pageIds.size,
      databaseCount: scope.databaseIds.size,
    },
  });
  return { page, markdown: `${lines.join('\n')}\n` };
}

async function exportDatabaseCsv(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  storage?: FunctionStorageProxy,
) {
  const page = await getReadablePage(
    db,
    requireString(body.databaseId ?? body.pageId, 'databaseId'),
    actorId,
    actorEmail,
  );
  if (page.kind !== 'database') throw new Error('Page is not a database.');
  await assertOrganizationDlpPolicy(
    db,
    page.workspaceId,
    'exports',
    'Exports are blocked by organization DLP policy.',
  );

  const [properties, rows] = await Promise.all([
    listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', page.id)),
    listAll(db.table<Page>('pages').where('parentId', '==', page.id)),
  ]);
  const props = properties.sort((a, b) => a.position - b.position);
  const visibleRows = rows
    .filter((row) => row.parentType === 'database' && !row.inTrash)
    .sort((a, b) => a.position - b.position);
  const scope = await pageExportScope(db, page);
  const context = await fileExportContext(db, page.workspaceId, scope.pageIds, scope.databaseIds, storage);
  const dataRows = await Promise.all(
    visibleRows.map(async (row) => Promise.all(props.map((prop) => propertyCsvValue(row, prop, context)))),
  );
  const csv = [csvRow(props.map((prop) => prop.name || 'Untitled')), ...dataRows.map(csvRow)].join('\n');
  await recordWorkspaceAudit(db, {
    workspaceId: page.workspaceId,
    actorId,
    action: 'export.database_csv',
    targetType: 'database',
    targetId: page.id,
    metadata: {
      databaseId: page.id,
      propertyCount: props.length,
      rowCount: visibleRows.length,
    },
  });

  return {
    page,
    properties: props,
    rowCount: visibleRows.length,
    csv: `${csv}\n`,
  };
}

function childrenByParent(pages: Page[]) {
  const byParent = new Map<string, Page[]>();
  for (const page of pages) {
    if (!page.parentId || page.parentType === 'database') continue;
    const children = byParent.get(page.parentId) ?? [];
    children.push(page);
    byParent.set(page.parentId, children);
  }
  for (const children of byParent.values()) {
    children.sort((a, b) => a.position - b.position || pageTitle(a).localeCompare(pageTitle(b)));
  }
  return byParent;
}

async function workspacePageMarkdownLines(
  db: DbRef,
  page: Page,
  childPages: Map<string, Page[]>,
  context: ExportContext,
  headingLevel: number,
  visited: Set<string>,
) {
  if (visited.has(page.id)) return [];

  const lines = await pageMarkdownLines(db, page, context, headingLevel, visited);
  for (const child of childPages.get(page.id) ?? []) {
    lines.push('', ...(await workspacePageMarkdownLines(db, child, childPages, context, headingLevel + 1, visited)));
  }
  return lines;
}

async function exportWorkspaceMarkdown(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
) {
  const workspace = await getReadableWorkspace(db, requireString(body.workspaceId, 'workspaceId'), actorId);
  await assertOrganizationDlpPolicy(
    db,
    workspace.id,
    'exports',
    'Exports are blocked by organization DLP policy.',
  );
  const pages = (await listAll(db.table<Page>('pages').where('workspaceId', '==', workspace.id)))
    .filter((page) => !page.inTrash)
    .sort((a, b) => a.position - b.position || pageTitle(a).localeCompare(pageTitle(b)));
  const childPages = childrenByParent(pages);
  const roots = pages.filter((page) => !page.parentId || page.parentType === 'workspace');
  const visited = new Set<string>();
  const pageIds = new Set(pages.map((page) => page.id));
  const databaseIds = new Set(pages.filter((page) => page.kind === 'database').map((page) => page.id));
  const context = await fileExportContext(db, workspace.id, pageIds, databaseIds, storage);
  const lines = [`# ${workspaceTitle(workspace)}`];

  for (const page of roots) {
    lines.push('', ...(await workspacePageMarkdownLines(db, page, childPages, context, 2, visited)));
  }
  await recordWorkspaceAudit(db, {
    workspaceId: workspace.id,
    actorId,
    action: 'export.workspace_markdown',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: {
      pageCount: visited.size,
      databaseCount: databaseIds.size,
    },
  });

  return {
    workspace,
    pageCount: visited.size,
    markdown: `${lines.join('\n')}\n`,
  };
}

// ─── Native Hanji export/import (.hanji.json) ────────────────────────────
// Full-fidelity round-trip between Hanji instances: relations, rollups,
// formulas, views, templates, comments — everything except file attachments,
// which are stripped to name-only placeholders on export by product decision.
// The remap engine lives in lib/native-document; here we resolve scope, gather
// entities, strip files, then (on import) build one oldId->newId map and insert
// in FK-safe order. See docs/native-export-import-plan.md.

interface NativeScope {
  pageIds: Set<string>;
  databaseIds: Set<string>;
  rootIds: string[];
  kind: 'workspace' | 'subtree';
}

function collectSubtreeScope(pages: APage[], root: APage): NativeScope {
  const childrenByParent = new Map<string, APage[]>();
  for (const page of pages) {
    if (page.inTrash || !page.parentId) continue;
    const list = childrenByParent.get(page.parentId) ?? [];
    list.push(page);
    childrenByParent.set(page.parentId, list);
  }
  const pageIds = new Set<string>();
  const databaseIds = new Set<string>();
  const visit = (page: APage) => {
    if (pageIds.has(page.id) || page.inTrash) return;
    pageIds.add(page.id);
    if (page.kind === 'database') databaseIds.add(page.id);
    for (const child of childrenByParent.get(page.id) ?? []) visit(child);
  };
  visit(root);
  return { pageIds, databaseIds, rootIds: [root.id], kind: 'subtree' };
}

function workspaceScope(pages: APage[]): NativeScope {
  const live = pages.filter((page) => !page.inTrash);
  const pageIds = new Set(live.map((page) => page.id));
  const databaseIds = new Set(live.filter((page) => page.kind === 'database').map((page) => page.id));
  const rootIds = live.filter((page) => !page.parentId || page.parentType === 'workspace').map((page) => page.id);
  return { pageIds, databaseIds, rootIds, kind: 'workspace' };
}

function computeRelationPairs(
  dbProperties: ADbProperty[],
  databaseIds: Set<string>,
  warnings: NativeWarning[],
): RelationPair[] {
  const relations = dbProperties.filter((prop) => prop.type === 'relation');
  const byDb = new Map<string, ADbProperty[]>();
  for (const prop of relations) {
    const list = byDb.get(prop.databaseId) ?? [];
    list.push(prop);
    byDb.set(prop.databaseId, list);
  }
  const pairs: RelationPair[] = [];
  const seen = new Set<string>();
  for (const prop of relations) {
    const target = typeof prop.config?.relationDatabaseId === 'string' ? prop.config.relationDatabaseId : '';
    if (!target || !databaseIds.has(target)) {
      warnings.push({ code: 'out_of_scope_relation', entityId: prop.id, detail: target || 'unknown target' });
      continue;
    }
    const reciprocal = (byDb.get(target) ?? []).find((candidate) => candidate.config?.relationDatabaseId === prop.databaseId);
    if (!reciprocal) continue;
    const key = [prop.id, reciprocal.id].sort().join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      databaseId: prop.databaseId,
      propertyId: prop.id,
      reciprocalDatabaseId: target,
      reciprocalPropertyId: reciprocal.id,
    });
  }
  return pairs;
}

async function buildNativeEnvelope(
  db: DbRef,
  workspace: Workspace,
  allPages: APage[],
  scope: NativeScope,
): Promise<NativeExportEnvelope> {
  const warnings: NativeWarning[] = [];
  const rootIds = new Set(scope.rootIds);
  // A subtree document is self-contained: detach each selected root from its
  // source parent so import never depends on an ancestor omitted from scope.
  const scopedPages = allPages
    .filter((page) => scope.pageIds.has(page.id))
    .map((page) => rootIds.has(page.id)
      ? { ...page, parentId: null, parentType: 'workspace' as const }
      : page);
  const databaseIds = [...scope.databaseIds];
  const propertyBudget = nativeExportBudget(NATIVE_DOCUMENT_LIMITS.maxDbProperties);
  const viewBudget = nativeExportBudget(NATIVE_DOCUMENT_LIMITS.maxDbViews);
  const templateBudget = nativeExportBudget(NATIVE_DOCUMENT_LIMITS.maxDbTemplates);

  const [propertyGroups, viewGroups, templateGroups] = await Promise.all([
    mapNativeExportWithConcurrency(databaseIds, NATIVE_EXPORT_QUERY_CONCURRENCY, (id) =>
      listNativeExportRows(
        db.table<ADbProperty>('db_properties').where('databaseId', '==', id),
        propertyBudget,
        'Database properties',
      )),
    mapNativeExportWithConcurrency(databaseIds, NATIVE_EXPORT_QUERY_CONCURRENCY, (id) =>
      listNativeExportRows(
        db.table<ADbView>('db_views').where('databaseId', '==', id),
        viewBudget,
        'Database views',
      )),
    mapNativeExportWithConcurrency(databaseIds, NATIVE_EXPORT_QUERY_CONCURRENCY, (id) =>
      listNativeExportRows(
        db.table<ADbTemplate>('db_templates').where('databaseId', '==', id),
        templateBudget,
        'Database templates',
      )),
  ]);
  const dbProperties = propertyGroups.flat();
  const dbViews = viewGroups.flat();
  const dbTemplates = templateGroups.flat();

  const blockBudget = nativeExportBudget(NATIVE_DOCUMENT_LIMITS.maxBlocks);
  const commentBudget = nativeExportBudget(NATIVE_DOCUMENT_LIMITS.maxComments);
  const [blockGroups, commentGroups] = await Promise.all([
    mapNativeExportWithConcurrency(scopedPages, NATIVE_EXPORT_QUERY_CONCURRENCY, (page) =>
      listNativeExportRows(
        db.table<ABlock>('blocks').where('pageId', '==', page.id),
        blockBudget,
        'Blocks',
      )),
    mapNativeExportWithConcurrency(scopedPages, NATIVE_EXPORT_QUERY_CONCURRENCY, (page) =>
      listNativeExportRows(
        db.table<AComment>('comments').where('pageId', '==', page.id),
        commentBudget,
        'Comments',
      )),
  ]);

  const relationPairs = computeRelationPairs(dbProperties, scope.databaseIds, warnings);
  const sanitized = sanitizeNativeEntitiesForExport({
    pages: scopedPages,
    blocks: blockGroups.flat(),
    dbProperties,
    dbViews,
    dbTemplates,
    comments: commentGroups.flat(),
  });
  warnings.push(...sanitized.warnings);
  const entities = sanitized.entities;
  const workspaceIcon = typeof workspace.icon === 'string' &&
    workspace.icon.length <= 32 &&
    !/[\/:?&=]/.test(workspace.icon)
    ? workspace.icon
    : undefined;
  const counts: Record<string, number> = {
    pages: entities.pages.filter((page) => page.kind === 'page').length,
    databases: entities.pages.filter((page) => page.kind === 'database').length,
    blocks: entities.blocks.length,
    dbProperties: entities.dbProperties.length,
    dbViews: entities.dbViews.length,
    dbTemplates: entities.dbTemplates.length,
    comments: entities.comments.length,
  };

  return validateNativeEnvelope({
    format: NATIVE_FORMAT,
    formatVersion: NATIVE_FORMAT_VERSION,
    generatedAt: nowIso(),
    app: { name: 'hanji' },
    scope: { kind: scope.kind, rootIds: scope.rootIds },
    source: { workspaceId: workspace.id, workspaceName: workspace.name, workspaceIcon },
    counts,
    files: { included: false, strippedReferences: sanitized.strippedReferences },
    entities,
    relationPairs,
    warnings,
  });
}

async function exportWorkspaceNative(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const workspace = await getReadableWorkspace(db, requireString(body.workspaceId, 'workspaceId'), actorId);
  await assertOrganizationDlpPolicy(db, workspace.id, 'exports', 'Exports are blocked by organization DLP policy.');
  const allPages = await listNativeExportRows(
    db.table<APage>('pages').where('workspaceId', '==', workspace.id),
    nativeExportBudget(NATIVE_DOCUMENT_LIMITS.maxPages),
    'Pages',
  );
  const scope = workspaceScope(allPages);
  const document = await buildNativeEnvelope(db, workspace, allPages, scope);
  await recordWorkspaceAudit(db, {
    workspaceId: workspace.id,
    actorId,
    action: 'export.workspace_native',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: { ...document.counts, warnings: document.warnings.length, strippedReferences: document.files.strippedReferences },
  });
  return { workspace: { id: workspace.id, name: workspace.name }, document, counts: document.counts, warnings: document.warnings };
}

async function exportPageNative(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const page = await getReadablePage(db, requireString(body.pageId, 'pageId'), actorId, actorEmail);
  await assertOrganizationDlpPolicy(db, page.workspaceId, 'exports', 'Exports are blocked by organization DLP policy.');
  const workspace = (await getExisting(db.table<Workspace>('workspaces'), page.workspaceId)) ?? { id: page.workspaceId };
  const allPages = await listNativeExportRows(
    db.table<APage>('pages').where('workspaceId', '==', page.workspaceId),
    nativeExportBudget(NATIVE_DOCUMENT_LIMITS.maxPages),
    'Pages',
  );
  const root = allPages.find((candidate) => candidate.id === page.id);
  if (!root) throw new Error('Page was not found.');
  const scope = collectSubtreeScope(allPages, root);
  const document = await buildNativeEnvelope(db, workspace, allPages, scope);
  await recordWorkspaceAudit(db, {
    workspaceId: page.workspaceId,
    actorId,
    action: 'export.page_native',
    targetType: page.kind === 'database' ? 'database' : 'page',
    targetId: page.id,
    metadata: { ...document.counts, warnings: document.warnings.length, strippedReferences: document.files.strippedReferences },
  });
  return { page: { id: page.id, title: page.title, kind: page.kind }, document, counts: document.counts, warnings: document.warnings };
}

function normalizeNativeEntities(document: NativeExportEnvelope): NativeEntities {
  const entities = document.entities ?? ({} as NativeEntities);
  return {
    pages: Array.isArray(entities.pages) ? entities.pages : [],
    blocks: Array.isArray(entities.blocks) ? entities.blocks : [],
    dbProperties: Array.isArray(entities.dbProperties) ? entities.dbProperties : [],
    dbViews: Array.isArray(entities.dbViews) ? entities.dbViews : [],
    dbTemplates: Array.isArray(entities.dbTemplates) ? entities.dbTemplates : [],
    comments: Array.isArray(entities.comments) ? entities.comments : [],
  };
}

async function importNativeDocument(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const document = validateNativeEnvelope(body.document);
  const parentId = optionalString(body.parentId) ?? null;
  const parentType = parseParentType(body.parentType, parentId);
  if (parentType === 'database') throw new Error('Import destination must be a page or the workspace.');
  await assertWritableParent(db, workspaceId, parentId, parentType, 'page', actorId, actorEmail);

  const sanitized = sanitizeNativeEntitiesForExport(normalizeNativeEntities(document));
  const entities = sanitized.entities;
  const idMap = new Map<string, string>();
  const register = (id: unknown) => {
    if (typeof id === 'string' && id && !idMap.has(id)) idMap.set(id, newId());
  };
  for (const page of entities.pages) register(page.id);
  for (const block of entities.blocks) register(block.id);
  for (const prop of entities.dbProperties) register(prop.id);
  for (const view of entities.dbViews) register(view.id);
  for (const template of entities.dbTemplates) register(template.id);
  for (const comment of entities.comments) register(comment.id);

  const remapped = remapNativeDocument(entities, idMap, {
    propTypeByOldId: propTypeMap(entities.dbProperties),
    keepUserIds: false,
  });

  const now = nowIso();
  const rootPages = remapped.pages.filter((page) => page.parentId === null);
  const destSiblings = await listAll(db.table<APage>('pages').where('workspaceId', '==', workspaceId));
  const siblingPositions = destSiblings
    .filter((page) => {
      if (page.inTrash) return false;
      return parentType === 'workspace'
        ? !page.parentId || page.parentType === 'workspace'
        : page.parentId === parentId && page.parentType === parentType;
    })
    .map((page) => page.position ?? 0);
  let nextPosition = (siblingPositions.length ? Math.max(...siblingPositions) : 0) + 1;
  const rootPositions = new Map<string, number>();
  for (const root of rootPages) rootPositions.set(root.id, nextPosition++);

  const insertedPages: APage[] = [];
  const insertedProps: ADbProperty[] = [];
  const created = {
    pages: [] as string[],
    pageWorkspaceIndexes: [] as string[],
    blocks: [] as string[],
    props: [] as string[],
    views: [] as string[],
    templates: [] as string[],
    comments: [] as string[],
  };
  const pagesTable = db.table<APage>('pages');
  const blocksTable = db.table<ABlock>('blocks');
  const propsTable = db.table<ADbProperty>('db_properties');
  const viewsTable = db.table<ADbView>('db_views');
  const templatesTable = db.table<ADbTemplate>('db_templates');
  const commentsTable = db.table<AComment>('comments');
  const pageWorkspaceIndexTable = admin
    .db('app')
    .table<{ id: string; workspaceId: string }>('page_workspace_index');

  try {
    for (const page of remapped.pages) {
      const isRoot = page.parentId === null;
      const inserted = await pagesTable.insert({
        ...page,
        workspaceId,
        parentId: isRoot ? parentId : page.parentId,
        parentType: isRoot ? parentType : page.parentType,
        position: isRoot ? rootPositions.get(page.id) ?? page.position : page.position,
        isLocked: false,
        isPublic: false,
        isFavorite: false,
        inTrash: false,
        createdBy: actorId,
        lastEditedBy: actorId,
        createdAt: page.createdAt ?? now,
        updatedAt: now,
      });
      insertedPages.push(inserted);
      created.pages.push(inserted.id);
      // Track the index cleanup intent before the write. If index creation
      // partially succeeds and then throws, rollback must still remove it.
      created.pageWorkspaceIndexes.push(inserted.id);
      await ensurePageWorkspaceIndex(admin, inserted.id, workspaceId);
    }
    for (const block of remapped.blocks) {
      const inserted = await blocksTable.insert({
        ...block,
        createdBy: actorId,
        createdAt: block.createdAt ?? now,
        updatedAt: now,
      });
      created.blocks.push(inserted.id);
    }
    for (const prop of remapped.dbProperties) {
      const inserted = await propsTable.insert({ ...prop });
      insertedProps.push(inserted);
      created.props.push(inserted.id);
    }
    for (const view of remapped.dbViews) {
      const inserted = await viewsTable.insert({ ...view });
      created.views.push(inserted.id);
    }
    for (const template of remapped.dbTemplates) {
      const inserted = await templatesTable.insert({ ...template });
      created.templates.push(inserted.id);
    }
    for (const comment of remapped.comments) {
      const inserted = await commentsTable.insert({
        ...comment,
        authorId: actorId,
        createdAt: comment.createdAt ?? now,
        updatedAt: now,
      });
      created.comments.push(inserted.id);
    }

    // Rebuild the derived per-value search/filter index for each database.
    const propsByDb = new Map<string, ADbProperty[]>();
    for (const prop of insertedProps) {
      const list = propsByDb.get(prop.databaseId) ?? [];
      list.push(prop);
      propsByDb.set(prop.databaseId, list);
    }
    const importedDbIds = insertedPages.filter((page) => page.kind === 'database').map((page) => page.id);
    for (const databaseId of importedDbIds) {
      await ensureDatabasePropertyIndexes(
        db as unknown as IndexDbRef,
        { id: databaseId, workspaceId },
        insertedPages,
        propsByDb.get(databaseId) ?? [],
      );
    }
  } catch (error) {
    const cleanupFailures: Array<{ entity: string; id: string; error: unknown }> = [];
    const deleteCreated = async (
      entity: string,
      table: { delete(id: string): Promise<unknown> },
      id: string,
    ): Promise<boolean> => {
      try {
        await table.delete(id);
        return true;
      } catch (cleanupError) {
        // A trigger or concurrent cleanup may already have removed a record.
        if (isNotFoundError(cleanupError)) return true;
        cleanupFailures.push({ entity, id, error: cleanupError });
        return false;
      }
    };

    await Promise.all(created.comments.map((id) => deleteCreated('comment', commentsTable, id)));
    await Promise.all(created.templates.map((id) => deleteCreated('database template', templatesTable, id)));
    await Promise.all(created.views.map((id) => deleteCreated('database view', viewsTable, id)));
    await Promise.all(created.props.map((id) => deleteCreated('database property', propsTable, id)));
    await Promise.all(created.blocks.map((id) => deleteCreated('block', blocksTable, id)));

    const removedPages = new Set<string>();
    for (const id of created.pages.slice().reverse()) {
      if (await deleteCreated('page', pagesTable, id)) removedPages.add(id);
    }
    // Keep an index when its page could not be removed: it is still valid and
    // preserves a route for later repair. Once the page is gone, remove its
    // synchronous routing index so rollback cannot leave a stale page route.
    for (const id of created.pageWorkspaceIndexes.slice().reverse()) {
      if (removedPages.has(id)) {
        await deleteCreated('page workspace index', pageWorkspaceIndexTable, id);
      }
    }

    if (cleanupFailures.length > 0) {
      throw new NativeImportRollbackError(error, cleanupFailures);
    }
    throw error;
  }

  await recordWorkspaceAudit(db, {
    workspaceId,
    actorId,
    action: 'import.native',
    targetType: parentType === 'workspace' ? 'workspace' : 'page',
    targetId: parentId ?? workspaceId,
    metadata: {
      pages: created.pages.length,
      blocks: created.blocks.length,
      dbProperties: created.props.length,
      dbViews: created.views.length,
      dbTemplates: created.templates.length,
      comments: created.comments.length,
      warnings: sanitized.warnings.length + remapped.warnings.length,
    },
  });

  return {
    rootPageIds: rootPages.map((page) => page.id),
    counts: {
      pages: insertedPages.filter((page) => page.kind === 'page').length,
      databases: insertedPages.filter((page) => page.kind === 'database').length,
      blocks: created.blocks.length,
      dbProperties: created.props.length,
      dbViews: created.views.length,
      dbTemplates: created.templates.length,
      comments: created.comments.length,
    },
    warnings: [
      ...(Array.isArray(document.warnings) ? document.warnings : []),
      ...sanitized.warnings,
      ...remapped.warnings,
    ],
  };
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request, storage } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  try {
    const body = await requestJson(request);
    const action = typeof body.action === 'string' ? body.action : '';
    const db = body.workspaceId
      ? boundedDbFromWorkspaceHint(admin, body.workspaceId)
      : await boundedDbFromPageHint(admin, body.pageId, body.id, body.databaseId);
    const actorEmail = auth.email ?? null;
    switch (action) {
      case 'importMarkdownPage':
        return await importMarkdownPage(db, admin, body, auth.id, actorEmail);
      case 'appendMarkdownToPage':
        return await appendMarkdownToPage(db, body, auth.id, actorEmail);
      case 'replaceMarkdownPage':
        return await replaceMarkdownPage(db, body, auth.id, actorEmail);
      case 'importCsvDatabase':
        return await importCsvDatabase(db, admin, body, auth.id, actorEmail);
      case 'exportPageMarkdown':
        return await exportPageMarkdown(db, body, auth.id, actorEmail, storage);
      case 'exportDatabaseCsv':
        return await exportDatabaseCsv(db, body, auth.id, actorEmail, storage);
      case 'exportWorkspaceMarkdown':
        return await exportWorkspaceMarkdown(db, body, auth.id, storage);
      case 'exportWorkspaceNative':
        return await exportWorkspaceNative(db, body, auth.id);
      case 'exportPageNative':
        return await exportPageNative(db, body, auth.id, actorEmail);
      case 'importNative':
        return await importNativeDocument(db, admin, body, auth.id, actorEmail);
      default:
        return jsonError(400, 'Unknown import/export action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 413, needles: ['payload is too large', 'source file is too large'] },
      { status: 422, needles: ['newer version of Hanji'] },
      { status: 429, needles: ['Too many requests', 'rate limit', 'Rate limit'] },
      {
        status: 403,
        needles: ['access required', 'active access required', 'outside the workspace'],
      },
      { status: 404, needles: ['not found', 'trash'] },
      { status: 423, needles: ['locked', 'blocked by organization DLP policy'] },
      { status: 409, needles: ['already exists', 'changed since'] },
      {
        status: 400,
        needles: ['Invalid Hanji export', 'is required', 'must be', 'must have', 'Unsupported', 'Unknown'],
      },
    ], 500);
    return jsonError(status, message);
  }
});
