import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { boundedDbFromWorkspaceHint, ensurePageWorkspaceIndex, type AdminDbAccessor } from '../lib/workspace-db';
import { recordWorkspaceAudit } from '../lib/org-audit';
import {
  pageAccessRole as sharedPageAccessRole,
  workspaceAccessRole as sharedWorkspaceAccessRole,
} from '../lib/page-access';
import { fetchPublicResource } from '../lib/ssrf-guard';

import {
  bestEffort,
  requireString,
  getExisting,
  nowIso,
  newId,
  type TableQuery,
  type TransactDb,
} from '../lib/table-utils';
import type { ShareRole } from '../lib/page-access';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

type NotionImportStatus = 'queued' | 'discovering' | 'ready' | 'completed' | 'failed' | 'cancelled';
type NotionImportConnectionKind = 'oauth' | 'personal_access_token' | 'internal_integration' | 'manual_token';
type NotionImportConnectionStatus = 'active' | 'revoked' | 'error';

const NOTION_API_VERSION = '2026-03-11';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_BASE_ENV = 'NOTIONLIKE_NOTION_API_BASE';
const NOTION_OAUTH_CLIENT_ID_ENV = 'NOTIONLIKE_NOTION_OAUTH_CLIENT_ID';
const NOTION_OAUTH_CLIENT_SECRET_ENV = 'NOTIONLIKE_NOTION_OAUTH_CLIENT_SECRET';
const NOTION_OAUTH_AUTH_URL_ENV = 'NOTIONLIKE_NOTION_OAUTH_AUTH_URL';
const NOTION_OAUTH_REDIRECT_URI_ENV = 'NOTIONLIKE_NOTION_OAUTH_REDIRECT_URI';
const NOTION_OAUTH_STATE_SECRET_ENV = 'NOTIONLIKE_NOTION_OAUTH_STATE_SECRET';
const NOTION_CONNECTION_SECRET_ENV = 'NOTIONLIKE_NOTION_IMPORT_SECRET';
const LEGACY_NOTION_CONNECTION_SECRET_ENV = 'NOTION_IMPORT_SECRET';
const NOTION_CREDENTIAL_ALGORITHM = 'AES-GCM-SHA256';
const NOTION_CREDENTIAL_KEY_ID = 'notion-import-v1';
const NOTION_OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const NOTION_PAGINATION_SAFETY_PAGE_LIMIT = 10_000;
const NOTION_ROOT_SCAN_DEFAULT_PAGE_LIMIT = 10;
const NOTION_ROOT_SCAN_MAX_PAGE_LIMIT = 50;
const NOTION_IMPORT_ITEM_SAFETY_LIMIT = 100_000;
// Housekeeping for the persisted job engine: there is no user-facing recent-jobs
// list anymore, so finished/stale job records (and their discovered items) are
// pruned opportunistically when a workspace lists its jobs. Live jobs (queued /
// discovering / apply-in-progress) are NEVER pruned. Retention is by age with a
// per-workspace keep cap; deletes are batched per call to bound request cost.
const NOTION_IMPORT_JOB_RETENTION_DAYS_ENV = 'NOTIONLIKE_NOTION_IMPORT_JOB_RETENTION_DAYS';
const NOTION_IMPORT_JOB_RETENTION_MS_DEFAULT = 14 * 24 * 60 * 60 * 1000;
const NOTION_IMPORT_JOB_KEEP_MAX = 25;
const NOTION_IMPORT_JOB_PRUNE_BATCH_MAX = 12;
const NOTION_ENRICHMENT_BATCH_SIZE = 500;
const NOTION_ENRICHMENT_BATCH_SIZE_MAX = 5_000;
const NOTION_DISCOVERY_CONCURRENCY_DEFAULT = 4;
const NOTION_DISCOVERY_CONCURRENCY_MAX = 8;
const NOTION_PREFLIGHT_SAMPLE_LIMIT = 20;
const MAX_MARKDOWN_CHARS = 60_000;
const FILE_BUCKET = 'files';
const MAX_IMPORTED_FILE_SIZE = 5 * 1024 * 1024 * 1024;
const NOTION_PAGE_ICON_REFERENCE_KEY = '__notionPageIconReference';
const NOTION_PAGE_COVER_REFERENCE_KEY = '__notionPageCoverReference';
const NOTION_CREATED_TIME_KEY = '__notionCreatedTime';
const NOTION_LAST_EDITED_TIME_KEY = '__notionLastEditedTime';
const NOTION_IMPORT_BLOCKS_COMPLETE_KEY = '__notionImportBlocksComplete';
const NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY = '__notionImportBlockBoundaryRepairVersion';
const NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION = 5;
const NOTION_REQUEST_MAX_ATTEMPTS = 8;
const NOTION_REQUEST_RETRY_BASE_DELAY_MS = 1_000;
const NOTION_REQUEST_RETRY_MAX_DELAY_MS = 30_000;
// Per-attempt ceiling so a socket that connects but never responds is aborted
// and retried (via the generic non-NotionApiError retry path) instead of
// hanging on the request's whole subrequest/wall-clock budget. Notion data-API
// responses are small JSON, so 30s is generous.
const NOTION_REQUEST_TIMEOUT_MS = 30_000;
const NOTION_BLOCK_CHILD_DEPTH_LIMIT = 32;
const NOTION_BLOCK_CHILD_TOTAL_LIMIT = 100_000;
const NOTION_DISCOVERY_PASS_SAFETY_LIMIT = 1_000;
// Discovery runs as one long inline pass; persist a throttled live progress
// snapshot (~1/sec) so the polled step-3 panel advances instead of sitting at
// the initial "25% · Discovering workspace graph" until the whole pass ends.
const NOTION_DISCOVERY_PROGRESS_INTERVAL_MS = 1_000;

type NotionImportWarning = {
  code: string;
  message: string;
  notionId?: string;
  notionObject?: string;
};

class NotionApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;

  constructor(message: string, options: { status: number; code?: string; retryAfterMs?: number }) {
    super(message);
    this.name = 'NotionApiError';
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

type NotionRequestRetryInfo = {
  path: string;
  method: 'GET' | 'POST';
  status?: number;
  code?: string;
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  message: string;
};

type NotionRequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
  apiBase?: string;
  onRetry?: (info: NotionRequestRetryInfo) => void;
};

interface Workspace {
  id: string;
  organizationId?: string | null;
  name?: string;
  ownerId?: string;
}

interface Organization {
  id: string;
  name?: string;
  ownerId?: string;
  storageLimitBytes?: number | null;
}

export interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  kind?: string;
  title?: string;
  icon?: string;
  iconType?: string;
  cover?: string;
  coverPosition?: number;
  font?: string;
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: string;
  pageCommentsDisplay?: string;
  properties?: Record<string, unknown>;
  isFavorite?: boolean;
  inTrash?: boolean;
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
  position: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbProperty {
  id: string;
  databaseId: string;
  name: string;
  description?: string;
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

type ViewFilterTerm = {
  propertyId?: unknown;
  operator?: unknown;
  value?: unknown;
};

type FilterGroupTerm = {
  conjunction?: unknown;
  filters?: unknown;
  groups?: unknown;
};

interface TemplateBlock {
  type: string;
  content?: Record<string, unknown>;
  plainText?: string;
  children?: TemplateBlock[];
}

interface DbTemplate {
  id: string;
  databaseId: string;
  name: string;
  icon?: string;
  title?: string;
  properties?: Record<string, unknown>;
  blocks?: TemplateBlock[];
  isDefault?: boolean;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket: string;
  key: string;
  scope: string;
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  name: string;
  contentType?: string;
  size: number;
  status: 'pending' | 'uploaded' | 'deleted' | 'expired';
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface NotionImportConnection {
  id: string;
  workspaceId: string;
  actorId?: string;
  name?: string;
  connectionKind: NotionImportConnectionKind;
  status: NotionImportConnectionStatus;
  apiVersion: string;
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  tokenFingerprint?: string | null;
  credentialAlgorithm?: string | null;
  credentialKeyId?: string | null;
  credentialCiphertext?: string | null;
  metadata?: Record<string, unknown>;
  lastValidatedAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

type SafeNotionImportConnection = Omit<NotionImportConnection, 'credentialCiphertext'> & {
  metadata: Record<string, unknown>;
  hasStoredCredential: boolean;
};

interface NotionTokenSource {
  token: string;
  tokenStored: false;
  credentialSource: 'request' | 'connection';
  connectionId?: string;
  connection?: SafeNotionImportConnection;
  tokenFingerprint?: string | null;
}

interface NotionOAuthStatePayload {
  workspaceId: string;
  actorId: string;
  redirectUri: string;
  name?: string;
  nonce: string;
  createdAt: string;
}

interface NotionStoredOAuthCredential {
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  issuedAt: string;
  refreshedAt?: string | null;
}

type DecryptedNotionCredential =
  | { kind: 'token'; token: string }
  | { kind: 'oauth'; accessToken: string; refreshToken?: string | null; tokenType?: string | null };

export interface NotionImportJob {
  id: string;
  workspaceId: string;
  source: 'notion_api';
  connectionKind: NotionImportConnectionKind;
  connectionId?: string | null;
  status: NotionImportStatus;
  phase: string;
  actorId?: string;
  parentPageId?: string | null;
  rootNotionPageIds?: string[];
  rootNotionDataSourceIds?: string[];
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  apiVersion: string;
  options?: Record<string, unknown>;
  counts?: Record<string, number>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string | null;
  retryOfJobId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotionImportItem {
  id: string;
  workspaceId: string;
  jobId: string;
  notionId: string;
  notionObject: string;
  parentNotionId?: string | null;
  title?: string;
  status: string;
  phase: string;
  localId?: string | null;
  localType?: string | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface NotionImportRootCandidate {
  id: string;
  notionObject: 'page' | 'data_source';
  title: string;
  parentNotionId?: string | null;
  parentType?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  url?: string | null;
  icon?: unknown;
  reason: 'workspace_parent' | 'accessible_parent_missing';
}

export interface NotionImportRootScanItem {
  id: string;
  notionObject: 'page' | 'data_source';
  title: string;
  parentNotionId?: string | null;
  parentType?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  url?: string | null;
  icon?: unknown;
  archived?: boolean;
  inTrash?: boolean;
}

export interface NotionImportMapping {
  id: string;
  workspaceId: string;
  jobId: string;
  notionId: string;
  notionType: string;
  localId: string;
  localType: string;
  relationKind: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoveredNotionItem {
  notionId: string;
  notionObject: string;
  parentNotionId?: string | null;
  title?: string;
  status?: string;
  phase?: string;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

interface DiscoveryWarningBag {
  warnings: NotionImportWarning[];
  missingPermissions: NotionImportWarning[];
  unsupported: NotionImportWarning[];
}

interface ImportConversionReport {
  summary: Record<string, number>;
  warnings: NotionImportWarning[];
  unsupported: NotionImportWarning[];
  missingPermissions: NotionImportWarning[];
  unresolvedReferences: NotionImportWarning[];
}

interface ViewPropertyReferenceIssue {
  source: string;
  property: string;
}

interface ViewPropertyReferenceCollector {
  unresolved: ViewPropertyReferenceIssue[];
  seen: Set<string>;
}

interface RemappedViewPropertySettings {
  visibleProperties?: string[];
  hiddenProperties?: string[];
  propertyOrder?: string[];
  propertyWidths?: Record<string, number>;
  tableCalculations?: Record<string, string>;
  wrappedColumns?: string[];
}

interface NotionFileReference {
  id: string;
  name: string;
  url: string;
  type?: string;
  size?: number;
  notionFileSource: 'external' | 'notion_file' | 'direct_url' | 'unknown';
  notionFileExpiryTime?: string;
  notionFile: Record<string, unknown>;
  uploadId?: string;
  bucket?: string;
  key?: string;
  sourceUrl?: string;
  notionFileCopied?: boolean;
  notionFileCopiedAt?: string | null;
}

interface NotionFileCopyStats {
  fileCopies: number;
  fileCopySkipped: number;
}

interface NotionFileCopyContext {
  db: DbRef;
  job: NotionImportJob;
  actorId: string;
  storage?: FunctionStorageProxy;
  request?: Request;
  conversionReport?: ImportConversionReport;
  requireStoredFileCopies: boolean;
  notionToken?: string;
  apiVersion: string;
  apiBase?: string;
  stats: NotionFileCopyStats;
}

interface NotionFileCopyTarget {
  notionId?: string;
  notionObject: string;
  label: string;
  scope: 'icons' | 'covers' | 'blocks/images' | 'blocks/videos' | 'blocks/audio' | 'blocks/files' | 'database/files';
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  notionPageId?: string;
  notionBlockId?: string;
  notionPropertyId?: string;
  notionPropertyName?: string;
  notionFileIndex?: number;
  notionFileName?: string;
  notionPageFileKind?: 'icon' | 'cover';
}

interface NotionImportPlan {
  status: 'ready' | 'blocked';
  generatedAt: string;
  counts: Record<string, number>;
  estimatedWrites: Record<string, number>;
  conversion: ImportConversionReport;
  canApply: boolean;
}

type NotionImportProgressStepKey = 'connect' | 'discover' | 'review' | 'apply' | 'file_copy_retry' | 'cancel';
type NotionImportProgressStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface NotionImportProgressEvent {
  key: NotionImportProgressStepKey;
  status: NotionImportProgressStatus;
  legacyStep: string;
  at?: string;
  percent?: number;
  message?: string;
  counts?: Record<string, unknown>;
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
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: { contentType?: string; customMetadata?: Record<string, string> },
  ): Promise<void>;
  head?(key: string): Promise<unknown | null>;
  getSignedUrl?(key: string, options?: { expiresIn?: number }): Promise<string>;
}

interface FunctionContext {
  auth: { id: string } | null;
  request?: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): DbRef;
  };
  storage?: FunctionStorageProxy;
}

const connectionKinds = new Set<NotionImportConnectionKind>([
  'oauth',
  'personal_access_token',
  'internal_integration',
  'manual_token',
]);

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

const importProgressOrder: NotionImportProgressStepKey[] = ['connect', 'discover', 'review', 'apply', 'file_copy_retry', 'cancel'];

const importProgressLabels: Record<NotionImportProgressStepKey, string> = {
  connect: 'Waiting for Notion connection',
  discover: 'Discovering workspace graph',
  review: 'Reviewing import plan',
  apply: 'Applying to local workspace',
  file_copy_retry: 'Retrying file copies',
  cancel: 'Cancelled',
};

function progressObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
}

function progressSteps(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
}

function progressPercent(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;
}

function progressCounts(counts: Record<string, unknown> | undefined) {
  if (!counts) return undefined;
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = value;
  }
  return Object.keys(next).length ? next : undefined;
}

function defaultProgressPercent(
  previous: Record<string, unknown>,
  event: NotionImportProgressEvent,
) {
  if (event.percent !== undefined) return progressPercent(event.percent);
  if (event.status === 'failed' || event.status === 'cancelled') return progressPercent(previous.percent) ?? 100;
  if (event.key === 'connect') return event.status === 'completed' ? 10 : 5;
  if (event.key === 'discover') return event.status === 'completed' ? 50 : 25;
  if (event.key === 'review') return event.status === 'completed' ? 60 : 55;
  if (event.key === 'apply') return event.status === 'completed' ? 100 : 75;
  if (event.key === 'file_copy_retry') return event.status === 'completed' ? 100 : 90;
  return progressPercent(previous.percent) ?? 0;
}

function withImportProgress(
  previousProgress: Record<string, unknown> | undefined,
  event: NotionImportProgressEvent,
) {
  const previous = progressObject(previousProgress);
  const at = event.at ?? nowIso();
  const existingSteps = progressSteps(previous.steps);
  const byKey = new Map<string, Record<string, unknown>>();
  for (const step of existingSteps) {
    const key = typeof step.key === 'string' ? step.key : undefined;
    if (key) byKey.set(key, step);
  }
  const existing = byKey.get(event.key) ?? {};
  const counts = progressCounts(event.counts);
  const isTerminal = event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled';
  byKey.set(event.key, {
    ...existing,
    key: event.key,
    label: importProgressLabels[event.key],
    status: event.status,
    startedAt: event.status === 'running' ? optionalString(existing.startedAt) ?? at : optionalString(existing.startedAt) ?? at,
    finishedAt: isTerminal ? at : optionalString(existing.finishedAt),
    ...(event.message ? { message: event.message } : {}),
    ...(counts ? { counts } : {}),
  });

  const steps = Array.from(byKey.values()).sort((a, b) => {
    const aIndex = importProgressOrder.indexOf(a.key as NotionImportProgressStepKey);
    const bIndex = importProgressOrder.indexOf(b.key as NotionImportProgressStepKey);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });
  const percent = defaultProgressPercent(previous, event);
  return {
    ...previous,
    step: event.legacyStep,
    currentStep: event.key,
    currentLabel: importProgressLabels[event.key],
    currentStatus: event.status,
    percent,
    lastUpdatedAt: at,
    steps,
  };
}

export type ImportedTextSpan = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: string;
  link?: string;
  mention?: 'page' | 'date' | 'person';
  pageId?: string;
  date?: string;
  userId?: string;
  notionPageId?: string;
  notionDatabaseId?: string;
  notionDataSourceId?: string;
  notionMention?: Record<string, unknown>;
  notionMentionLocalId?: string;
  notionMentionLocalType?: string;
  notionUser?: ReturnType<typeof notionUserReference>;
};

function rich(text: string): ImportedTextSpan[] {
  return text ? [{ text }] : [];
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseConnectionKind(value: unknown): NotionImportConnectionKind {
  if (typeof value === 'string' && connectionKinds.has(value as NotionImportConnectionKind)) {
    return value as NotionImportConnectionKind;
  }
  return 'personal_access_token';
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 100);
}

export function normalizedNotionId(value: unknown) {
  return typeof value === 'string'
    ? value.trim().replace(/-/g, '').toLowerCase()
    : '';
}

export function missingRequestedRootIds(requestedRootIds: string[], items: DiscoveredNotionItem[]) {
  if (!requestedRootIds.length) return [];
  const discoveredIds = new Set(items.map((item) => normalizedNotionId(item.notionId)).filter(Boolean));
  return requestedRootIds.filter((id) => {
    const normalized = normalizedNotionId(id);
    return normalized && !discoveredIds.has(normalized);
  });
}

export function parseSnapshotItems(value: unknown): DiscoveredNotionItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): DiscoveredNotionItem | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const notionId = optionalString(record.notionId ?? record.id);
      const notionObject = optionalString(record.notionObject ?? record.object);
      if (!notionId || !notionObject) return null;
      const metadata = record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : {};
      return {
        notionId,
        notionObject,
        parentNotionId: optionalString(record.parentNotionId),
        title: optionalString(record.title),
        status: optionalString(record.status) ?? 'discovered',
        phase: optionalString(record.phase) ?? 'snapshot',
        metadata,
        error: optionalString(record.error),
      };
    })
    .filter((item): item is DiscoveredNotionItem => !!item)
    .slice(0, NOTION_IMPORT_ITEM_SAFETY_LIMIT);
}

interface McpFetchPayload {
  text: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

interface HtmlTagBlock {
  attributes: string;
  content: string;
  raw: string;
}

function parseJsonLike(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function unwrapMcpReference(value: string) {
  let next = value.trim();
  if (next.startsWith('{{') && next.endsWith('}}')) next = next.slice(2, -2).trim();
  return next;
}

export function dashedUuid(value: string) {
  const compact = value.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return value.trim();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

function mcpReferenceId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const cleaned = unwrapMcpReference(value);
  const schemeMatch = /^(?:collection|view|block|page|database|dataSource):\/\/([0-9a-f-]{32,36})/i.exec(cleaned);
  if (schemeMatch?.[1]) return dashedUuid(schemeMatch[1]);
  const collectionPropertyMatch = /^collectionProperty:\/\/([0-9a-f-]{32,36})\//i.exec(cleaned);
  if (collectionPropertyMatch?.[1]) return dashedUuid(collectionPropertyMatch[1]);
  const compactMatches = cleaned.match(/[0-9a-f]{32}/gi);
  if (compactMatches?.length) return dashedUuid(compactMatches[compactMatches.length - 1]);
  const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(cleaned);
  if (uuidMatch?.[0]) return dashedUuid(uuidMatch[0]);
  const trimmed = cleaned.trim();
  return trimmed || undefined;
}

function mcpCollectionPropertyId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const cleaned = unwrapMcpReference(value);
  const match = /^collectionProperty:\/\/[^/]+\/([^/?#]+)/i.exec(cleaned);
  return match?.[1] ? safeDecode(match[1]).trim() : undefined;
}

function mcpCollectionPropertyDataSourceId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const cleaned = unwrapMcpReference(value);
  const match = /^collectionProperty:\/\/([0-9a-f-]{32,36})\//i.exec(cleaned);
  return match?.[1] ? dashedUuid(match[1]) : undefined;
}

function extractTagBlocks(text: string, tag: string): HtmlTagBlock[] {
  const blocks: HtmlTagBlock[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    blocks.push({
      attributes: match[1] ?? '',
      content: match[2] ?? '',
      raw: match[0] ?? '',
    });
  }
  return blocks;
}

function extractSelfClosingTagAttributes(text: string, tag: string) {
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)\\/?>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

function tagAttribute(attributes: string, name: string) {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return typeof value === 'string' && value.trim() ? unwrapMcpReference(value) : undefined;
}

function firstTagJson(content: string, tag: string) {
  const block = extractTagBlocks(content, tag)[0];
  if (!block) return undefined;
  return parseJsonLike(block.content);
}

function mcpTitleFromText(text: string, label: string) {
  const pattern = new RegExp(`The title of this ${label} is:\\s*([^\\n<]+)`, 'i');
  const match = pattern.exec(text);
  return match?.[1]?.trim();
}

function mcpRichTextTitle(title: string | undefined) {
  const text = title?.trim() || 'Untitled';
  return [
    {
      type: 'text',
      plain_text: text,
      text: { content: text, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
    },
  ];
}

function mcpFetchPayloads(value: unknown): McpFetchPayload[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const payloads: McpFetchPayload[] = [];

  const visit = (candidate: unknown) => {
    if (candidate === undefined || candidate === null) return;
    if (typeof candidate === 'string') {
      const parsed = parseJsonLike(candidate);
      if (parsed !== undefined) {
        visit(parsed);
        return;
      }
      if (candidate.trim()) payloads.push({ text: candidate });
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    const metadata = asRecord(record.metadata);
    const title = optionalString(record.title ?? metadata?.title);
    const url = optionalString(record.url ?? metadata?.url);
    const text =
      optionalString(record.text) ??
      optionalString(record.markdown) ??
      optionalString(record.contentText);
    if (text) {
      payloads.push({ text, title, url, metadata });
      return;
    }
    if (Array.isArray(record.content)) {
      for (const item of record.content) visit(item);
      return;
    }
    if (record.result) visit(record.result);
  };

  for (const candidate of values) visit(candidate);
  return payloads.slice(0, NOTION_IMPORT_ITEM_SAFETY_LIMIT);
}

function mcpSchemaNotionType(value: unknown) {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (type === 'text') return 'rich_text';
  if (type === 'file') return 'files';
  if (type === 'person') return 'people';
  if (type === 'phone') return 'phone_number';
  if (SUPPORTED_NOTION_PROPERTY_TYPES.has(type)) return type;
  return 'rich_text';
}

function mcpSchemaOptions(prop: Record<string, unknown>) {
  const source =
    Array.isArray(prop.options) ? prop.options :
      Array.isArray(prop.select_options) ? prop.select_options :
        Array.isArray(prop.selectOptions) ? prop.selectOptions :
          [];
  return source
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((option) => ({
      id:
        optionalString(option.id) ??
        mcpReferenceId(option.url) ??
        mcpReferenceId(option.valueUrl) ??
        newId(),
      name: optionalString(option.name ?? option.value ?? option.label) ?? 'Option',
      color: optionColor(option.color),
    }));
}

function mcpSchemaPropertyId(prop: Record<string, unknown>, fallback: string) {
  return (
    optionalString(prop.id) ??
    mcpCollectionPropertyId(prop.propertyUrl) ??
    mcpCollectionPropertyId(prop.url) ??
    optionalString(prop.code) ??
    optionalString(prop.key) ??
    fallback
  );
}

function mcpSchemaRelationTarget(prop: Record<string, unknown>) {
  return (
    mcpReferenceId(prop.dataSourceUrl) ??
    mcpReferenceId(prop.data_source_url) ??
    mcpReferenceId(prop.collectionUrl) ??
    mcpReferenceId(prop.databaseUrl) ??
    mcpReferenceId(prop.targetDataSourceUrl) ??
    mcpReferenceId(prop.target_data_source_url)
  );
}

function mcpSchemaPropertyConfig(prop: Record<string, unknown>, notionType: string) {
  if (notionType === 'number') {
    return {
      format: optionalString(prop.number_format ?? prop.numberFormat ?? prop.format) ?? 'number',
    };
  }
  if (notionType === 'select' || notionType === 'multi_select' || notionType === 'status') {
    return { options: mcpSchemaOptions(prop) };
  }
  if (notionType === 'relation') {
    const target = mcpSchemaRelationTarget(prop);
    return target ? { data_source_id: target } : {};
  }
  if (notionType === 'rollup') {
    return {
      relation_property_id:
        optionalString(prop.relation_property_id) ??
        mcpCollectionPropertyId(prop.relationPropertyUrl ?? prop.relation_property_url),
      rollup_property_id:
        optionalString(prop.rollup_property_id) ??
        mcpCollectionPropertyId(prop.targetPropertyUrl ?? prop.rollupPropertyUrl ?? prop.rollup_property_url),
      function: optionalString(prop.function ?? prop.rollupFunction ?? prop.aggregation) ?? 'show_original',
    };
  }
  if (notionType === 'formula') {
    return {
      expression: optionalString(prop.expression ?? prop.formula) ?? '',
      formula_code_url: optionalString(prop.codeUrl ?? prop.formulaCodeUrl),
    };
  }
  return {};
}

function mcpSchemaProperties(state: Record<string, unknown> | undefined) {
  const schema = asRecord(state?.schema ?? state?.properties);
  if (!schema) return {};
  const properties: Record<string, unknown> = {};
  for (const [key, rawProp] of Object.entries(schema)) {
    const prop = asRecord(rawProp);
    if (!prop) continue;
    const name = optionalString(prop.name) ?? key;
    const notionType = mcpSchemaNotionType(prop.type);
    const id = mcpSchemaPropertyId(prop, name);
    properties[name] = {
      id,
      name,
      type: notionType,
      [notionType]: mcpSchemaPropertyConfig(prop, notionType),
    };
  }
  return properties;
}

function mcpRelationTargetReferencesFromProperties(properties: Record<string, unknown>) {
  const refs = new Map<string, { id: string; notionObject: 'data_source' }>();
  for (const property of Object.values(properties)) {
    const prop = asRecord(property);
    if (!prop) continue;
    const notionType = optionalString(prop.type);
    const config = notionType ? notionPropertyConfig(prop, notionType) : {};
    const target = notionType === 'relation' ? optionalString(config.data_source_id) : undefined;
    if (target) refs.set(target, { id: target, notionObject: 'data_source' });
    const rollupTarget = notionType === 'rollup'
      ? mcpCollectionPropertyDataSourceId(config.rollup_property_id) ??
        mcpCollectionPropertyDataSourceId((config.notion as Record<string, unknown> | undefined)?.targetPropertyUrl)
      : undefined;
    if (rollupTarget) refs.set(rollupTarget, { id: rollupTarget, notionObject: 'data_source' });
  }
  return Array.from(refs.values());
}

function mcpStringList(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return items.length ? items : undefined;
}

function mcpViewRecord(rawView: Record<string, unknown>, viewId: string | undefined, dataSourceId: string) {
  const displayProperties =
    mcpStringList(rawView.displayProperties) ??
    mcpStringList(rawView.visibleProperties) ??
    mcpStringList(rawView.visible_properties);
  const rawSorts = Array.isArray(rawView.sorts) ? rawView.sorts : [];
  return {
    ...rawView,
    id: viewId ?? optionalString(rawView.id) ?? newId(),
    name: optionalString(rawView.name) ?? 'Default view',
    type: optionalString(rawView.type) ?? 'table',
    data_source_id: dataSourceId,
    visible_properties: displayProperties,
    property_order: displayProperties,
    sorts: rawSorts
      .filter((sort): sort is Record<string, unknown> => !!sort && typeof sort === 'object')
      .map((sort) => ({
        property: optionalString(sort.property ?? sort.property_id ?? sort.id ?? sort.name),
        direction: optionalString(sort.direction) ?? 'ascending',
      }))
      .filter((sort) => sort.property),
  };
}

function mcpViewsFromDatabaseBlock(content: string, dataSourceId: string) {
  const views: Record<string, unknown>[] = [];
  for (const viewBlock of extractTagBlocks(content, 'view')) {
    const parsed = parseJsonLike(viewBlock.content);
    const rawView = asRecord(parsed);
    if (!rawView) continue;
    const viewSourceId = mcpReferenceId(rawView.dataSourceUrl ?? rawView.data_source_url);
    if (viewSourceId && normalizedNotionId(viewSourceId) !== normalizedNotionId(dataSourceId)) continue;
    views.push(mcpViewRecord(rawView, mcpReferenceId(tagAttribute(viewBlock.attributes, 'url')), dataSourceId));
  }
  return views;
}

function mcpTextSpans(value: unknown) {
  const text = value === undefined || value === null ? '' : String(value);
  return mcpRichTextTitle(text);
}

function mcpRowPageDateParts(rawProperties: Record<string, unknown>, name: string) {
  const start = optionalString(rawProperties[`date:${name}:start`]);
  const end = optionalString(rawProperties[`date:${name}:end`]);
  const isDatetime = rawProperties[`date:${name}:is_datetime`];
  if (!start && !end && isDatetime === undefined) return undefined;
  return {
    start: start ?? end ?? '',
    end,
    time_zone: null,
  };
}

function mcpRowPageFileValues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .map((url) => ({
      type: 'external',
      name: fileNameFromUrl(url),
      external: { url },
    }));
}

function mcpRowPagePropertyValue(
  name: string,
  value: unknown,
  sourceProperty: Record<string, unknown> | undefined,
  rawProperties: Record<string, unknown>,
) {
  const notionType = optionalString(sourceProperty?.type) ?? (typeof value === 'number' ? 'number' : 'rich_text');
  const id = optionalString(sourceProperty?.id) ?? name;
  if (notionType === 'title' || notionType === 'rich_text') {
    return { id, type: notionType, [notionType]: mcpTextSpans(value) };
  }
  if (notionType === 'number') return { id, type: notionType, number: typeof value === 'number' ? value : Number(value) };
  if (notionType === 'select' || notionType === 'status') {
    return {
      id,
      type: notionType,
      [notionType]: value === undefined || value === null || value === '' ? null : { name: String(value) },
    };
  }
  if (notionType === 'multi_select') {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return {
      id,
      type: notionType,
      multi_select: values
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .map((item) => ({ name: item })),
    };
  }
  if (notionType === 'date') {
    return { id, type: notionType, date: mcpRowPageDateParts(rawProperties, name) ?? null };
  }
  if (notionType === 'relation') {
    const values = Array.isArray(value) ? value : [];
    return {
      id,
      type: notionType,
      relation: values
        .map((item) => mcpReferenceId(item))
        .filter((item): item is string => !!item)
        .map((item) => ({ id: item })),
    };
  }
  if (notionType === 'files') return { id, type: notionType, files: mcpRowPageFileValues(value) };
  if (notionType === 'checkbox') return { id, type: notionType, checkbox: value === true || value === '__YES__' };
  if (notionType === 'formula') {
    return {
      id,
      type: notionType,
      formula: { type: 'string', string: value === undefined || value === null ? '' : String(value) },
    };
  }
  if (notionType === 'rollup') {
    return {
      id,
      type: notionType,
      rollup: { type: 'array', array: [] },
    };
  }
  if (notionType === 'url' || notionType === 'email' || notionType === 'phone_number') {
    return { id, type: notionType, [notionType]: value === undefined || value === null ? null : String(value) };
  }
  return { id, type: 'rich_text', rich_text: mcpTextSpans(value) };
}

function mcpRowPageProperties(rawProperties: Record<string, unknown>, sourceProperties: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const sourceNames = new Set(Object.keys(sourceProperties));
  for (const name of sourceNames) {
    const sourceProperty = asRecord(sourceProperties[name]);
    if (!sourceProperty) continue;
    const hasDirectValue = Object.prototype.hasOwnProperty.call(rawProperties, name);
    const hasDateValue =
      optionalString(rawProperties[`date:${name}:start`]) ||
      optionalString(rawProperties[`date:${name}:end`]) ||
      rawProperties[`date:${name}:is_datetime`] !== undefined;
    if (!hasDirectValue && !hasDateValue) continue;
    out[name] = mcpRowPagePropertyValue(name, rawProperties[name], sourceProperty, rawProperties);
  }
  for (const [name, value] of Object.entries(rawProperties)) {
    if (name === 'url' || name.startsWith('date:') || sourceNames.has(name)) continue;
    out[name] = mcpRowPagePropertyValue(name, value, undefined, rawProperties);
  }
  return out;
}

function putMcpDataSourceSnapshot(
  items: Map<string, DiscoveredNotionItem>,
  dataSourceBlock: HtmlTagBlock,
  viewSourceContent: string,
  payload: McpFetchPayload,
  databaseId: string | undefined,
  fallbackTitle: string | undefined,
) {
  const state = asRecord(firstTagJson(dataSourceBlock.content, 'data-source-state'));
  const dataSourceId =
    mcpReferenceId(tagAttribute(dataSourceBlock.attributes, 'url')) ??
    mcpReferenceId(state?.url) ??
    mcpReferenceId(state?.dataSourceUrl);
  if (!dataSourceId) return undefined;
  const title =
    mcpTitleFromText(dataSourceBlock.content, 'Data Source') ??
    optionalString(state?.name ?? state?.title) ??
    fallbackTitle ??
    payload.title ??
    'Untitled data source';
  const properties = mcpSchemaProperties(state);
  const views = mcpViewsFromDatabaseBlock(viewSourceContent, dataSourceId);
  const dataSourceRef = {
    id: dataSourceId,
    object: 'data_source',
    name: title,
    title: mcpRichTextTitle(title),
  };
  putDiscoveredItem(items, {
    notionId: dataSourceId,
    notionObject: 'data_source',
    parentNotionId: databaseId,
    title,
    status: 'discovered',
    phase: 'mcp_data_source_snapshot',
    metadata: {
      discoveredFrom: 'mcp_fetch',
      ...(databaseId ? { databaseId } : {}),
      dataSourceSnapshot: {
        dataSource: {
          id: dataSourceId,
          object: 'data_source',
          ...(databaseId ? { parent: { type: 'database_id', database_id: databaseId } } : {}),
          title: mcpRichTextTitle(title),
          name: title,
          properties,
        },
        rowReferences: [],
        relationTargetReferences: mcpRelationTargetReferencesFromProperties(properties),
        views,
        templates: [],
        mcpSource: {
          title: payload.title,
          url: payload.url,
          metadata: payload.metadata,
        },
      },
    },
  });
  return dataSourceRef;
}

function putMcpPageSnapshot(items: Map<string, DiscoveredNotionItem>, pageBlock: HtmlTagBlock, payload: McpFetchPayload) {
  const pageUrl = tagAttribute(pageBlock.attributes, 'url') ?? payload.url;
  const pageId = mcpReferenceId(pageUrl);
  if (!pageId) return;
  const parentDataSourceAttributes = extractSelfClosingTagAttributes(pageBlock.content, 'parent-data-source')[0];
  const dataSourceId = parentDataSourceAttributes
    ? mcpReferenceId(tagAttribute(parentDataSourceAttributes, 'url'))
    : undefined;
  const sourceItem = dataSourceId ? items.get(dataSourceId) : undefined;
  const sourceProperties = sourceItem ? notionPropertiesFromSnapshot(dataSourceSnapshot(sourceItem)) : {};
  const rawProperties = asRecord(firstTagJson(pageBlock.content, 'properties')) ?? {};
  const properties = dataSourceId ? mcpRowPageProperties(rawProperties, sourceProperties) : rawProperties;
  putDiscoveredItem(items, {
    notionId: pageId,
    notionObject: 'page',
    parentNotionId: dataSourceId,
    title: payload.title ?? optionalString(rawProperties.title) ?? optionalString(rawProperties.Name),
    status: 'discovered',
    phase: dataSourceId ? 'mcp_data_source_row_snapshot' : 'mcp_page_snapshot',
    metadata: {
      discoveredFrom: 'mcp_fetch',
      ...(dataSourceId ? { dataSourceId } : {}),
      properties,
      rawMcpProperties: rawProperties,
      icon: tagAttribute(pageBlock.attributes, 'icon')
        ? { type: 'emoji', emoji: tagAttribute(pageBlock.attributes, 'icon') }
        : undefined,
      pageSnapshot: { childBlocks: [] },
      mcpSource: {
        title: payload.title,
        url: payload.url,
        metadata: payload.metadata,
      },
    },
  });
}

function parseMcpFetchItems(value: unknown): DiscoveredNotionItem[] {
  const items = new Map<string, DiscoveredNotionItem>();
  const payloads = mcpFetchPayloads(value);
  for (const payload of payloads) {
    const databaseBlocks = extractTagBlocks(payload.text, 'database');
    for (const databaseBlock of databaseBlocks) {
      const databaseUrl = tagAttribute(databaseBlock.attributes, 'url') ?? payload.url;
      const databaseId = mcpReferenceId(databaseUrl);
      if (!databaseId) continue;
      const databaseTitle =
        mcpTitleFromText(databaseBlock.content, 'Database') ??
        payload.title ??
        'Untitled database';
      const dataSourceRefs: Record<string, unknown>[] = [];

      for (const dataSourceBlock of extractTagBlocks(databaseBlock.content, 'data-source')) {
        const dataSourceRef = putMcpDataSourceSnapshot(
          items,
          dataSourceBlock,
          databaseBlock.content,
          payload,
          databaseId,
          databaseTitle,
        );
        if (dataSourceRef) dataSourceRefs.push(dataSourceRef);
      }

      putDiscoveredItem(items, {
        notionId: databaseId,
        notionObject: 'database',
        title: databaseTitle,
        status: 'discovered',
        phase: 'mcp_database_snapshot',
        metadata: {
          discoveredFrom: 'mcp_fetch',
          database: {
            id: databaseId,
            object: 'database',
            title: mcpRichTextTitle(databaseTitle),
            data_sources: dataSourceRefs,
          },
          dataSources: dataSourceRefs,
          mcpSource: {
            title: payload.title,
            url: payload.url,
            metadata: payload.metadata,
          },
        },
      });
    }
    if (databaseBlocks.length === 0) {
      for (const dataSourceBlock of extractTagBlocks(payload.text, 'data-source')) {
        putMcpDataSourceSnapshot(
          items,
          dataSourceBlock,
          payload.text,
          payload,
          undefined,
          payload.title,
        );
      }
    }
  }
  for (const payload of payloads) {
    for (const pageBlock of extractTagBlocks(payload.text, 'page')) {
      putMcpPageSnapshot(items, pageBlock, payload);
    }
  }
  return Array.from(items.values()).slice(0, NOTION_IMPORT_ITEM_SAFETY_LIMIT);
}

export function expandSnapshotItems(items: DiscoveredNotionItem[]) {
  const byId = new Map<string, DiscoveredNotionItem>();
  for (const item of items) putDiscoveredItem(byId, item);

  for (const item of items) {
    if (item.notionObject !== 'data_source') continue;
    const snapshot = dataSourceSnapshot(item);
    const rowReferences = Array.isArray(snapshot?.rowReferences) ? snapshot.rowReferences : [];
    for (let rowIndex = 0; rowIndex < rowReferences.length; rowIndex += 1) {
      const row = rowReferences[rowIndex];
      if (!row || typeof row !== 'object') continue;
      const rowRecord = row as Record<string, unknown>;
      const id = optionalString(rowRecord.id);
      if (!id) continue;
      putDiscoveredItem(byId, {
        notionId: id,
        notionObject: optionalString(rowRecord.object) ?? 'page',
        parentNotionId: item.notionId,
        title: optionalString(rowRecord.title),
        status: 'referenced',
        phase: 'data_source_row_reference',
        metadata: {
          discoveredFrom: 'snapshot_data_source_query',
          dataSourceId: item.notionId,
          notionQueryOrder: rowIndex,
          ...(optionalString(rowRecord.createdTime) ?? optionalString(rowRecord.created_time)
            ? { createdTime: optionalString(rowRecord.createdTime) ?? optionalString(rowRecord.created_time) }
            : {}),
          ...(optionalString(rowRecord.lastEditedTime) ?? optionalString(rowRecord.last_edited_time)
            ? { lastEditedTime: optionalString(rowRecord.lastEditedTime) ?? optionalString(rowRecord.last_edited_time) }
            : {}),
          properties: rowRecord.properties,
          icon: rowRecord.icon,
          cover: rowRecord.cover,
        },
      });
    }

    const views = Array.isArray(snapshot?.views) ? snapshot.views : [];
    for (const view of views) {
      if (!view || typeof view !== 'object') continue;
      const viewRecord = view as Record<string, unknown>;
      const id = notionObjectId(viewRecord);
      if (!id) continue;
      putDiscoveredItem(byId, {
        notionId: id,
        notionObject: 'view',
        parentNotionId: item.notionId,
        title: optionalString(viewRecord.name),
        status: 'discovered',
        phase: 'view_snapshot',
        metadata: {
          discoveredFrom: 'snapshot_views',
          dataSourceId: item.notionId,
          view: viewRecord,
        },
      });
    }
  }

  return Array.from(byId.values()).slice(0, NOTION_IMPORT_ITEM_SAFETY_LIMIT);
}

function parsePositiveInt(value: unknown, fallback: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<void>,
) {
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await callback(items[index], index);
    }
  }));
}

function envString(env: Record<string, unknown> | undefined, key: string) {
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[key] ?? processEnv?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function notionApiBase(env: Record<string, unknown> | undefined) {
  return (envString(env, NOTION_API_BASE_ENV) ?? NOTION_API_BASE).replace(/\/+$/, '');
}

function notionOAuthAuthorizeUrl(env: Record<string, unknown> | undefined) {
  return (
    envString(env, NOTION_OAUTH_AUTH_URL_ENV) ??
    `${notionApiBase(env)}/oauth/authorize`
  ).trim();
}

function notionOAuthClientId(env: Record<string, unknown> | undefined) {
  const clientId = envString(env, NOTION_OAUTH_CLIENT_ID_ENV);
  if (!clientId) throw new Error(`${NOTION_OAUTH_CLIENT_ID_ENV} is required for Notion OAuth.`);
  return clientId;
}

function notionOAuthClientSecret(env: Record<string, unknown> | undefined) {
  const clientSecret = envString(env, NOTION_OAUTH_CLIENT_SECRET_ENV);
  if (!clientSecret) throw new Error(`${NOTION_OAUTH_CLIENT_SECRET_ENV} is required for Notion OAuth.`);
  return clientSecret;
}

function notionOAuthRedirectUri(env: Record<string, unknown> | undefined, body: Record<string, unknown>) {
  const redirectUri = optionalString(body.redirectUri) ?? envString(env, NOTION_OAUTH_REDIRECT_URI_ENV);
  if (!redirectUri) throw new Error('redirectUri is required for Notion OAuth.');
  return redirectUri;
}

function notionCredentialSecret(env: Record<string, unknown> | undefined) {
  return (
    envString(env, NOTION_CONNECTION_SECRET_ENV) ??
    envString(env, LEGACY_NOTION_CONNECTION_SECRET_ENV)
  );
}

export function notionConnectionStorageAvailable(env: Record<string, unknown> | undefined) {
  return notionCredentialSecret(env) !== undefined;
}

function notionOAuthStateSecret(env: Record<string, unknown> | undefined) {
  return (
    envString(env, NOTION_OAUTH_STATE_SECRET_ENV) ??
    notionCredentialSecret(env) ??
    notionOAuthClientSecret(env)
  );
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function base64EncodeText(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha256(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function encodeNotionOAuthState(
  payload: NotionOAuthStatePayload,
  env: Record<string, unknown> | undefined,
) {
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmacSha256(notionOAuthStateSecret(env), encodedPayload));
  return `${encodedPayload}.${signature}`;
}

async function decodeNotionOAuthState(
  state: string,
  env: Record<string, unknown> | undefined,
): Promise<NotionOAuthStatePayload> {
  const [encodedPayload, encodedSignature, extra] = state.split('.');
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new Error('Notion OAuth state is invalid.');
  }
  const expected = await hmacSha256(notionOAuthStateSecret(env), encodedPayload);
  const actual = base64UrlDecode(encodedSignature);
  if (!bytesEqual(expected, actual)) throw new Error('Notion OAuth state is invalid.');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as Record<string, unknown>;
  } catch {
    throw new Error('Notion OAuth state is invalid.');
  }
  const workspaceId = requireString(payload.workspaceId, 'workspaceId');
  const actorId = requireString(payload.actorId, 'actorId');
  const redirectUri = requireString(payload.redirectUri, 'redirectUri');
  const nonce = requireString(payload.nonce, 'nonce');
  const createdAt = requireString(payload.createdAt, 'createdAt');
  const createdTime = new Date(createdAt).getTime();
  if (!Number.isFinite(createdTime) || Date.now() - createdTime > NOTION_OAUTH_STATE_MAX_AGE_MS) {
    throw new Error('Notion OAuth state has expired.');
  }
  return {
    workspaceId,
    actorId,
    redirectUri,
    name: optionalString(payload.name),
    nonce,
    createdAt,
  };
}

async function credentialCryptoKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptNotionCredential(token: string, env: Record<string, unknown> | undefined) {
  const secret = notionCredentialSecret(env);
  if (!secret) {
    throw new Error(`${NOTION_CONNECTION_SECRET_ENV} is required to store Notion import connections.`);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await credentialCryptoKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  );
  return JSON.stringify({
    v: 1,
    alg: NOTION_CREDENTIAL_ALGORITHM,
    kid: NOTION_CREDENTIAL_KEY_ID,
    iv: base64UrlEncode(iv),
    data: base64UrlEncode(new Uint8Array(encrypted)),
  });
}

async function encryptNotionOAuthCredential(
  input: {
    accessToken: string;
    refreshToken?: string | null;
    tokenType?: string | null;
    refreshedAt?: string | null;
  },
  env: Record<string, unknown> | undefined,
) {
  const payload: NotionStoredOAuthCredential = {
    kind: 'oauth',
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? null,
    tokenType: input.tokenType ?? 'bearer',
    issuedAt: nowIso(),
    refreshedAt: input.refreshedAt ?? null,
  };
  return encryptNotionCredential(JSON.stringify(payload), env);
}

async function decryptNotionCredential(
  connection: NotionImportConnection,
  env: Record<string, unknown> | undefined,
): Promise<DecryptedNotionCredential> {
  const secret = notionCredentialSecret(env);
  if (!secret) {
    throw new Error(`${NOTION_CONNECTION_SECRET_ENV} is required to use stored Notion import connections.`);
  }
  if (!connection.credentialCiphertext) {
    throw new Error('Notion import connection has no stored credential.');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(connection.credentialCiphertext) as Record<string, unknown>;
  } catch {
    throw new Error('Notion import connection credential is invalid.');
  }
  if (payload.alg !== NOTION_CREDENTIAL_ALGORITHM || payload.kid !== NOTION_CREDENTIAL_KEY_ID) {
    throw new Error('Notion import connection credential uses an unsupported format.');
  }
  const iv = typeof payload.iv === 'string' ? base64UrlDecode(payload.iv) : undefined;
  const data = typeof payload.data === 'string' ? base64UrlDecode(payload.data) : undefined;
  if (!iv || !data) throw new Error('Notion import connection credential is incomplete.');
  const key = await credentialCryptoKey(secret);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    const plaintext = new TextDecoder().decode(decrypted);
    try {
      const parsed = JSON.parse(plaintext) as Partial<NotionStoredOAuthCredential>;
      if (parsed?.kind === 'oauth' && typeof parsed.accessToken === 'string' && parsed.accessToken.trim()) {
        return {
          kind: 'oauth',
          accessToken: parsed.accessToken.trim(),
          refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken.trim()
            ? parsed.refreshToken.trim()
            : null,
          tokenType: typeof parsed.tokenType === 'string' && parsed.tokenType.trim()
            ? parsed.tokenType.trim()
            : 'bearer',
        };
      }
    } catch {
      // Existing stored connections encrypted the raw token directly.
    }
    return { kind: 'token', token: plaintext };
  } catch {
    throw new Error('Notion import connection credential could not be decrypted.');
  }
}

async function listAll<T>(query: TableQuery<T>, maxItems = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200 && out.length < maxItems; page += 1) {
    const res = await query.page(page).limit(Math.min(1000, maxItems - out.length)).getList();
    const items = res.items ?? [];
    out.push(...items);
    if (!res.hasMore || items.length === 0) break;
  }
  return out;
}

// Role resolution is canonical in lib/page-access; these wrappers only pin
// this function's "missing workspace is an error" contract. Note: this
// function never resolves an actor email, so email-principal page permissions
// intentionally do not apply here.
async function workspaceRole(db: DbRef, workspaceId: string, actorId: string): Promise<ShareRole | undefined> {
  return sharedWorkspaceAccessRole(db, workspaceId, actorId, { requireWorkspace: true });
}

async function pageRole(db: DbRef, page: Page, actorId: string): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, undefined, { requireWorkspace: true });
}

async function assertWorkspaceRole(db: DbRef, workspaceId: string, actorId: string, minimum: ShareRole) {
  const role = await workspaceRole(db, workspaceId, actorId);
  if (role && roleRanks[role] >= roleRanks[minimum]) return;
  throw new Error('Workspace access required.');
}

async function assertWritableImportTarget(
  db: DbRef,
  workspaceId: string,
  parentPageId: string | undefined,
  actorId: string,
) {
  await assertWorkspaceRole(db, workspaceId, actorId, 'edit');
  if (!parentPageId) return;
  const parent = await getExisting(db.table<Page>('pages'), parentPageId);
  if (!parent) throw new Error('Parent page was not found.');
  if (parent.workspaceId !== workspaceId) throw new Error('Parent page is outside the workspace.');
  if (parent.inTrash) throw new Error('Parent page is in trash.');
  if (parent.isLocked) throw new Error('Parent page is locked.');
  const role = await pageRole(db, parent, actorId);
  if (role && roleRanks[role] >= roleRanks.edit) return;
  throw new Error('Page access required.');
}

async function assertReadableJob(db: DbRef, job: NotionImportJob, actorId: string) {
  await assertWorkspaceRole(db, job.workspaceId, actorId, 'view');
}

async function assertWritableJob(db: DbRef, job: NotionImportJob, actorId: string) {
  await assertWorkspaceRole(db, job.workspaceId, actorId, 'edit');
}

async function beginOAuthConnection(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertWorkspaceRole(db, workspaceId, actorId, 'edit');
  const redirectUri = notionOAuthRedirectUri(env, body);
  const name = optionalString(body.name);
  const now = nowIso();
  const payload: NotionOAuthStatePayload = {
    workspaceId,
    actorId,
    redirectUri,
    name,
    nonce: newId(),
    createdAt: now,
  };
  const state = await encodeNotionOAuthState(payload, env);
  const authorizationUrl = new URL(notionOAuthAuthorizeUrl(env));
  authorizationUrl.searchParams.set('client_id', notionOAuthClientId(env));
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('owner', 'user');
  authorizationUrl.searchParams.set('state', state);
  const expiresAt = new Date(new Date(now).getTime() + NOTION_OAUTH_STATE_MAX_AGE_MS).toISOString();

  await recordWorkspaceAudit(db, {
    workspaceId,
    actorId,
    action: 'notion_import.oauth.begin',
    targetType: 'notion_import_connection',
    targetId: workspaceId,
    metadata: {
      redirectUri,
      connectionKind: 'oauth',
    },
    occurredAt: now,
  });

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    redirectUri,
    expiresAt,
  };
}

async function completeOAuthConnection(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const oauthError = optionalString(body.error);
  if (oauthError) throw new Error(`Notion OAuth failed: ${oauthError}`);
  const code = requireString(body.code, 'code');
  const state = requireString(body.state, 'state');
  const payload = await decodeNotionOAuthState(state, env);
  if (payload.actorId !== actorId) throw new Error('Notion OAuth state belongs to another user.');
  await assertWorkspaceRole(db, payload.workspaceId, actorId, 'edit');
  const redirectUri = optionalString(body.redirectUri) ?? payload.redirectUri;
  if (redirectUri !== payload.redirectUri) throw new Error('Notion OAuth redirect URI does not match the signed state.');

  const apiVersion = optionalString(body.apiVersion) ?? NOTION_API_VERSION;
  const apiBase = notionApiBase(env);
  const tokenResponse = await notionOAuthTokenRequest({ code, redirectUri, apiVersion }, env);
  const accessToken = requireString(tokenResponse.access_token, 'access_token');
  const refreshToken = optionalString(tokenResponse.refresh_token);
  const tokenType = optionalString(tokenResponse.token_type) ?? 'bearer';
  const me = await notionRequest(accessToken, '/users/me', apiVersion, { apiBase });
  const notionWorkspace = notionOAuthWorkspaceInfo(tokenResponse, me);
  const name =
    optionalString(body.name) ??
    payload.name ??
    notionWorkspace.name ??
    optionalString(tokenResponse.workspace_name) ??
    'Notion OAuth connection';
  const now = nowIso();
  const credentialCiphertext = await encryptNotionOAuthCredential({
    accessToken,
    refreshToken,
    tokenType,
  }, env);
  const connection = await db.table<NotionImportConnection>('notion_import_connections').insert({
    id: newId(),
    workspaceId: payload.workspaceId,
    actorId,
    name,
    connectionKind: 'oauth',
    status: 'active',
    apiVersion,
    notionWorkspaceId: notionWorkspace.id,
    notionWorkspaceName: notionWorkspace.name,
    tokenFingerprint: await tokenFingerprint(accessToken),
    credentialAlgorithm: NOTION_CREDENTIAL_ALGORITHM,
    credentialKeyId: NOTION_CREDENTIAL_KEY_ID,
    credentialCiphertext,
    metadata: {
      oauth: {
        tokenType,
        botId: optionalString(tokenResponse.bot_id),
        workspaceIcon: optionalString(tokenResponse.workspace_icon),
        duplicatedTemplateId: optionalString(tokenResponse.duplicated_template_id),
        requestId: optionalString(tokenResponse.request_id),
        hasRefreshToken: !!refreshToken,
        owner: safeNotionOAuthOwner(tokenResponse.owner),
      },
      notionBot: {
        id: typeof me.id === 'string' ? me.id : undefined,
        type: typeof me.type === 'string' ? me.type : undefined,
      },
    },
    lastValidatedAt: now,
  });

  await recordWorkspaceAudit(db, {
    workspaceId: payload.workspaceId,
    actorId,
    action: 'notion_import.oauth.complete',
    targetType: 'notion_import_connection',
    targetId: connection.id,
    metadata: {
      connectionKind: 'oauth',
      notionWorkspaceId: notionWorkspace.id,
      notionWorkspaceName: notionWorkspace.name,
      hasRefreshToken: !!refreshToken,
    },
    occurredAt: now,
  });

  return { connection: cleanConnection(connection) };
}

async function createConnection(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertWorkspaceRole(db, workspaceId, actorId, 'edit');
  const token = requireString(body.notionToken, 'notionToken');
  const connectionKind = parseConnectionKind(body.connectionKind ?? 'internal_integration');
  const name = optionalString(body.name) ?? 'Notion connection';
  const apiVersion = optionalString(body.apiVersion) ?? NOTION_API_VERSION;
  const apiBase = notionApiBase(env);
  const now = nowIso();
  const me = await notionRequest(token, '/users/me', apiVersion, { apiBase });
  const notionWorkspace = notionWorkspaceInfo(me);
  const credentialCiphertext = await encryptNotionCredential(token, env);
  const connection = await db.table<NotionImportConnection>('notion_import_connections').insert({
    id: newId(),
    workspaceId,
    actorId,
    name,
    connectionKind,
    status: 'active',
    apiVersion,
    notionWorkspaceId: notionWorkspace.id,
    notionWorkspaceName: notionWorkspace.name,
    tokenFingerprint: await tokenFingerprint(token),
    credentialAlgorithm: NOTION_CREDENTIAL_ALGORITHM,
    credentialKeyId: NOTION_CREDENTIAL_KEY_ID,
    credentialCiphertext,
    metadata: {
      notionBot: {
        id: typeof me.id === 'string' ? me.id : undefined,
        type: typeof me.type === 'string' ? me.type : undefined,
      },
    },
    lastValidatedAt: now,
  });

  await recordWorkspaceAudit(db, {
    workspaceId,
    actorId,
    action: 'notion_import.connection.create',
    targetType: 'notion_import_connection',
    targetId: connection.id,
    metadata: {
      connectionKind,
      notionWorkspaceId: notionWorkspace.id,
      notionWorkspaceName: notionWorkspace.name,
    },
    occurredAt: now,
  });

  return { connection: cleanConnection(connection) };
}

async function listConnections(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertWorkspaceRole(db, workspaceId, actorId, 'view');
  const limit = parsePositiveInt(body.limit, 20, 100);
  const connections = await listAll(
    db.table<NotionImportConnection>('notion_import_connections').where('workspaceId', '==', workspaceId),
    500,
  );
  return {
    connectionStorageAvailable: notionConnectionStorageAvailable(env),
    connections: connections
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, limit)
      .map(cleanConnection),
  };
}

async function getActiveConnection(db: DbRef, connectionId: string, actorId: string) {
  const connection = await getExisting(db.table<NotionImportConnection>('notion_import_connections'), connectionId);
  if (!connection) throw new Error('Notion import connection was not found.');
  await assertWorkspaceRole(db, connection.workspaceId, actorId, 'edit');
  if (connection.status !== 'active') throw new Error('Notion import connection is not active.');
  return connection;
}

async function revokeConnection(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const connectionId = requireString(body.connectionId, 'connectionId');
  const connections = db.table<NotionImportConnection>('notion_import_connections');
  const connection = await getActiveConnection(db, connectionId, actorId);
  const now = nowIso();
  const updated = await connections.update(connection.id, {
    status: 'revoked',
    credentialCiphertext: null,
    revokedAt: now,
    revokedBy: actorId,
  });
  await recordWorkspaceAudit(db, {
    workspaceId: connection.workspaceId,
    actorId,
    action: 'notion_import.connection.revoke',
    targetType: 'notion_import_connection',
    targetId: connection.id,
    occurredAt: now,
  });
  return { connection: cleanConnection(updated) };
}

async function tokenFromStoredConnection(
  db: DbRef,
  connection: NotionImportConnection,
  env: Record<string, unknown> | undefined,
) {
  const credential = await decryptNotionCredential(connection, env);
  if (credential.kind === 'token') {
    const now = nowIso();
    const updated = await db.table<NotionImportConnection>('notion_import_connections').update(connection.id, {
      lastUsedAt: now,
      error: null,
    });
    return {
      token: credential.token,
      connection: updated,
      tokenFingerprint: connection.tokenFingerprint ?? await tokenFingerprint(credential.token),
      refreshed: false,
    };
  }

  const refreshToken = optionalString(credential.refreshToken);
  if (!refreshToken) {
    const now = nowIso();
    const updated = await db.table<NotionImportConnection>('notion_import_connections').update(connection.id, {
      lastUsedAt: now,
      error: null,
    });
    return {
      token: credential.accessToken,
      connection: updated,
      tokenFingerprint: connection.tokenFingerprint ?? await tokenFingerprint(credential.accessToken),
      refreshed: false,
    };
  }

  const apiVersion = connection.apiVersion || NOTION_API_VERSION;
  const refreshed = await notionOAuthRefreshTokenRequest({ refreshToken, apiVersion }, env);
  const accessToken = requireString(refreshed.access_token, 'access_token');
  const nextRefreshToken = optionalString(refreshed.refresh_token) ?? refreshToken;
  const tokenType = optionalString(refreshed.token_type) ?? credential.tokenType ?? 'bearer';
  const now = nowIso();
  const credentialCiphertext = await encryptNotionOAuthCredential({
    accessToken,
    refreshToken: nextRefreshToken,
    tokenType,
    refreshedAt: now,
  }, env);
  const fingerprint = await tokenFingerprint(accessToken);
  const existingMetadata = connection.metadata ?? {};
  const existingOAuthMetadata = existingMetadata.oauth && typeof existingMetadata.oauth === 'object'
    ? existingMetadata.oauth as Record<string, unknown>
    : {};
  const refreshedOwner = safeNotionOAuthOwner(refreshed.owner);
  const updated = await db.table<NotionImportConnection>('notion_import_connections').update(connection.id, {
    credentialCiphertext,
    tokenFingerprint: fingerprint,
    notionWorkspaceId: optionalString(refreshed.workspace_id) ?? connection.notionWorkspaceId,
    notionWorkspaceName: optionalString(refreshed.workspace_name) ?? connection.notionWorkspaceName,
    metadata: {
      ...existingMetadata,
      oauth: {
        ...existingOAuthMetadata,
        tokenType,
        botId: optionalString(refreshed.bot_id) ?? optionalString(existingOAuthMetadata.botId),
        workspaceIcon: optionalString(refreshed.workspace_icon) ?? optionalString(existingOAuthMetadata.workspaceIcon),
        duplicatedTemplateId: optionalString(refreshed.duplicated_template_id) ??
          optionalString(existingOAuthMetadata.duplicatedTemplateId),
        requestId: optionalString(refreshed.request_id) ?? optionalString(existingOAuthMetadata.requestId),
        hasRefreshToken: !!nextRefreshToken,
        owner: refreshedOwner ?? existingOAuthMetadata.owner,
        refreshedAt: now,
      },
    },
    lastUsedAt: now,
    lastValidatedAt: now,
    error: null,
  });
  return {
    token: accessToken,
    connection: updated,
    tokenFingerprint: fingerprint,
    refreshed: true,
  };
}

async function notionTokenForJob(
  db: DbRef,
  body: Record<string, unknown>,
  job: Pick<NotionImportJob, 'connectionId' | 'options'>,
  actorId: string,
  env: Record<string, unknown> | undefined,
): Promise<NotionTokenSource> {
  const directToken = optionalString(body.notionToken);
  if (directToken) {
    return {
      token: directToken,
      tokenStored: false,
      credentialSource: 'request',
      connectionId: optionalString(body.connectionId) ?? job.connectionId ?? undefined,
      tokenFingerprint: await tokenFingerprint(directToken),
    };
  }

  const options = job.options as { connectionId?: unknown } | undefined;
  const connectionId = optionalString(body.connectionId) ?? optionalString(options?.connectionId) ?? job.connectionId ?? undefined;
  if (!connectionId) throw new Error('notionToken or connectionId is required.');
  const connection = await getActiveConnection(db, connectionId, actorId);
  const tokenSource = await tokenFromStoredConnection(db, connection, env);
  return {
    token: tokenSource.token,
    tokenStored: false,
    credentialSource: 'connection',
    connectionId: connection.id,
    connection: cleanConnection(tokenSource.connection),
    tokenFingerprint: tokenSource.tokenFingerprint,
  };
}

function cleanJob(job: NotionImportJob) {
  return {
    ...job,
    options: job.options ?? {},
    counts: job.counts ?? {},
    progress: job.progress ?? {},
    report: job.report ?? {},
  };
}

function cleanConnection(connection: NotionImportConnection): SafeNotionImportConnection {
  const safeConnection = { ...connection };
  delete safeConnection.credentialCiphertext;
  return {
    ...safeConnection,
    metadata: connection.metadata ?? {},
    hasStoredCredential: !!connection.credentialCiphertext,
  } as SafeNotionImportConnection;
}

function cleanItem(item: NotionImportItem) {
  return {
    ...item,
    metadata: item.metadata ?? {},
  };
}

function countImportItemsByObject(items: Array<Pick<NotionImportItem | DiscoveredNotionItem, 'notionObject'>>) {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
    return acc;
  }, {});
}

function textFromRich(value: unknown): string {
  return richTextPlainText(notionRichTextSpans(value)).trim();
}

function richTextPlainText(spans: ImportedTextSpan[]) {
  return spans.map((span) => span.text).join('');
}

function notionRichTextPartText(record: Record<string, unknown>) {
  if (typeof record.plain_text === 'string') return record.plain_text;
  const text = asRecord(record.text);
  if (typeof text?.content === 'string') return text.content;
  const equation = asRecord(record.equation);
  if (typeof equation?.expression === 'string') return equation.expression;
  return '';
}

function notionRichTextLink(record: Record<string, unknown>) {
  if (typeof record.href === 'string' && record.href.trim()) return record.href.trim();
  const text = asRecord(record.text);
  const link = asRecord(text?.link);
  return optionalString(link?.url);
}

export function notionRichTextSpans(value: unknown): ImportedTextSpan[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((part) => {
      const record = asRecord(part);
      if (!record) return null;
      const text = notionRichTextPartText(record);
      if (!text) return null;
      const span: ImportedTextSpan = { text };
      const annotations = asRecord(record.annotations);
      if (annotations?.bold === true) span.bold = true;
      if (annotations?.italic === true) span.italic = true;
      if (annotations?.underline === true) span.underline = true;
      if (annotations?.strikethrough === true) span.strikethrough = true;
      if (annotations?.code === true) span.code = true;
      if (typeof annotations?.color === 'string' && annotations.color !== 'default') {
        span.color = annotations.color;
      }
      const link = notionRichTextLink(record);
      if (link) span.link = link;

      const mention = asRecord(record.mention);
      const mentionType = optionalString(mention?.type);
      if (mention && mentionType) {
        span.notionMention = mention;
      }
      if (mentionType === 'user') {
        const user = notionUserReference(mention?.user);
        if (user) {
          span.mention = 'person';
          span.userId = user.userId;
          span.notionUser = user;
        }
      } else if (mentionType === 'date') {
        const date = asRecord(mention?.date);
        const start = optionalString(date?.start);
        if (start) {
          span.mention = 'date';
          span.date = start;
        }
      } else if (mentionType === 'page') {
        const page = asRecord(mention?.page);
        const id = optionalString(page?.id);
        if (id) span.notionPageId = id;
      } else if (mentionType === 'database') {
        const database = asRecord(mention?.database);
        const id = optionalString(database?.id);
        if (id) span.notionDatabaseId = id;
      } else if (mentionType === 'data_source') {
        const dataSource = asRecord(mention?.data_source);
        const id = optionalString(dataSource?.id);
        if (id) span.notionDataSourceId = id;
      }
      return span;
    })
    .filter((span): span is ImportedTextSpan => !!span);
}

function notionBlockRichTextSources(block: Record<string, unknown>) {
  const type = typeof block.type === 'string' ? block.type : '';
  const payload = type && block[type] && typeof block[type] === 'object'
    ? block[type] as Record<string, unknown>
    : {};
  return [
    payload.rich_text,
    payload.text,
    payload.caption,
    payload.title,
  ].filter(Array.isArray);
}

function notionBlockRichTextSpans(block: Record<string, unknown>) {
  for (const source of notionBlockRichTextSources(block)) {
    const spans = notionRichTextSpans(source);
    if (spans.length > 0) return spans;
  }
  return [];
}

export function notionTitle(record: Record<string, unknown>) {
  const directTitle = textFromRich(record.title);
  if (directTitle) return directTitle;

  const properties = record.properties;
  if (properties && typeof properties === 'object') {
    for (const prop of Object.values(properties as Record<string, unknown>)) {
      if (!prop || typeof prop !== 'object') continue;
      const propRecord = prop as Record<string, unknown>;
      if (propRecord.type === 'title') {
        const title = textFromRich(propRecord.title);
        if (title) return title;
      }
    }
  }

  const name = record.name;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Untitled';
}

function notionParentType(record: Record<string, unknown>) {
  const parent = record.parent;
  if (!parent || typeof parent !== 'object') return undefined;
  const parentRecord = parent as Record<string, unknown>;
  return typeof parentRecord.type === 'string' ? parentRecord.type : undefined;
}

function notionParentResourceId(record: Record<string, unknown>) {
  const parent = record.parent;
  if (!parent || typeof parent !== 'object') return undefined;
  const parentRecord = parent as Record<string, unknown>;
  for (const key of ['page_id', 'database_id', 'block_id', 'data_source_id']) {
    if (typeof parentRecord[key] === 'string') return parentRecord[key] as string;
  }
  return undefined;
}

function notionParentId(record: Record<string, unknown>) {
  return notionParentResourceId(record) ?? notionParentType(record);
}

function compactNotionMetadata(record: Record<string, unknown>) {
  const parent = record.parent;
  return {
    url: typeof record.url === 'string' ? record.url : undefined,
    publicUrl: typeof record.public_url === 'string' ? record.public_url : undefined,
    archived: typeof record.archived === 'boolean' ? record.archived : undefined,
    inTrash: typeof record.in_trash === 'boolean' ? record.in_trash : undefined,
    createdTime: typeof record.created_time === 'string' ? record.created_time : undefined,
    lastEditedTime: typeof record.last_edited_time === 'string' ? record.last_edited_time : undefined,
    parent: parent && typeof parent === 'object' ? parent : undefined,
    icon: record.icon && typeof record.icon === 'object' ? record.icon : undefined,
    cover: record.cover && typeof record.cover === 'object' ? record.cover : undefined,
    dataSources: Array.isArray(record.data_sources) ? record.data_sources : undefined,
  };
}

function notionRootCandidateObject(record: Record<string, unknown>) {
  const object = optionalString(record.object);
  return object === 'page' || object === 'data_source' ? object : undefined;
}

function compactNotionRootScanItem(record: Record<string, unknown>): NotionImportRootScanItem | null {
  const notionObject = notionRootCandidateObject(record);
  const id = notionObjectId(record);
  if (!notionObject || !id) return null;
  return {
    id,
    notionObject,
    title: notionTitle(record),
    parentNotionId: notionParentResourceId(record) ?? null,
    parentType: notionParentType(record) ?? null,
    createdTime: optionalString(record.created_time) ?? null,
    lastEditedTime: optionalString(record.last_edited_time) ?? null,
    url: optionalString(record.url) ?? null,
    icon: asRecord(record.icon) ?? null,
    archived: record.archived === true || record.is_archived === true,
    inTrash: record.in_trash === true,
  };
}

export function notionAccessibleRootCandidates(records: Record<string, unknown>[]): NotionImportRootCandidate[] {
  const knownIds = new Set(
    records
      .map((record) => normalizedNotionId(notionObjectId(record)))
      .filter(Boolean),
  );
  const byId = new Map<string, NotionImportRootCandidate>();

  for (const record of records) {
    const notionObject = notionRootCandidateObject(record);
    if (!notionObject) continue;
    if (record.archived === true || record.in_trash === true || record.is_archived === true) continue;

    const id = notionObjectId(record);
    const normalizedId = normalizedNotionId(id);
    if (!id || !normalizedId || byId.has(normalizedId)) continue;

    const parentType = notionParentType(record);
    const parentNotionId = notionParentResourceId(record);
    const normalizedParentId = normalizedNotionId(parentNotionId);
    const isWorkspaceParent = parentType === 'workspace';
    const isAccessibleParentMissing = !!normalizedParentId && !knownIds.has(normalizedParentId);
    if (!isWorkspaceParent && !isAccessibleParentMissing) continue;

    byId.set(normalizedId, {
      id,
      notionObject,
      title: notionTitle(record),
      parentNotionId: parentNotionId ?? null,
      parentType: parentType ?? null,
      createdTime: optionalString(record.created_time) ?? null,
      lastEditedTime: optionalString(record.last_edited_time) ?? null,
      url: optionalString(record.url) ?? null,
      icon: asRecord(record.icon) ?? null,
      reason: isWorkspaceParent ? 'workspace_parent' : 'accessible_parent_missing',
    });
  }

  return Array.from(byId.values()).sort((a, b) => {
    const reasonScore = (root: NotionImportRootCandidate) => root.reason === 'workspace_parent' ? 0 : 1;
    const scoreDelta = reasonScore(a) - reasonScore(b);
    if (scoreDelta !== 0) return scoreDelta;
    const editedDelta = String(b.lastEditedTime ?? '').localeCompare(String(a.lastEditedTime ?? ''));
    if (editedDelta !== 0) return editedDelta;
    return a.title.localeCompare(b.title);
  });
}

function wait(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, NOTION_REQUEST_RETRY_MAX_DELAY_MS)));
}

function notionIsoTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function retryAfterMs(value: string | null) {
  if (!value || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function isRetryableNotionStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function notionRetryDelay(error: NotionApiError, attempt: number) {
  if (error.status === 429) {
    return error.retryAfterMs ?? Math.min(2_000 * (2 ** attempt), NOTION_REQUEST_RETRY_MAX_DELAY_MS);
  }
  return error.retryAfterMs ?? Math.min(
    NOTION_REQUEST_RETRY_BASE_DELAY_MS * (2 ** attempt),
    NOTION_REQUEST_RETRY_MAX_DELAY_MS,
  );
}

function reportNotionRequestRetry(
  options: NotionRequestOptions,
  input: {
    path: string;
    method: 'GET' | 'POST';
    attempt: number;
    delayMs: number;
    error: unknown;
  },
) {
  if (!options.onRetry) return;
  const error = input.error;
  options.onRetry({
    path: input.path,
    method: input.method,
    status: error instanceof NotionApiError ? error.status : undefined,
    code: error instanceof NotionApiError ? error.code : undefined,
    attempt: input.attempt + 1,
    nextAttempt: input.attempt + 2,
    delayMs: input.delayMs,
    message: error instanceof Error ? error.message : String(error),
  });
}

async function notionErrorFromResponse(response: Response) {
  let message = `Notion API request failed with ${response.status}.`;
  let code: string | undefined;
  try {
    const error = (await response.json()) as { message?: string; code?: string };
    if (typeof error.message === 'string' && error.message.trim()) message = error.message.trim();
    if (typeof error.code === 'string' && error.code.trim()) code = error.code.trim();
  } catch {
    try {
      const text = await response.text();
      if (text.trim()) message = text.trim();
    } catch {
      // ignore body parsing failures
    }
  }
  return new NotionApiError(message, {
    status: response.status,
    code,
    retryAfterMs: retryAfterMs(response.headers.get('Retry-After')),
  });
}

async function notionRequest(
  token: string,
  path: string,
  apiVersion: string,
  options: NotionRequestOptions = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${(options.apiBase ?? NOTION_API_BASE).replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const method = options.method ?? (options.body ? 'POST' : 'GET');
  const body = options.body ? JSON.stringify(options.body) : undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < NOTION_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Notion-Version': apiVersion,
        },
        body,
        signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = await response.json();
        return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      }

      const error = await notionErrorFromResponse(response);
      lastError = error;
      if (!isRetryableNotionStatus(error.status) || attempt >= NOTION_REQUEST_MAX_ATTEMPTS - 1) throw error;
      const delayMs = notionRetryDelay(error, attempt);
      reportNotionRequestRetry(options, { path, method, attempt, delayMs, error });
      await wait(delayMs);
    } catch (error) {
      lastError = error;
      if (error instanceof NotionApiError) {
        if (!isRetryableNotionStatus(error.status) || attempt >= NOTION_REQUEST_MAX_ATTEMPTS - 1) throw error;
        const delayMs = notionRetryDelay(error, attempt);
        reportNotionRequestRetry(options, { path, method, attempt, delayMs, error });
        await wait(delayMs);
        continue;
      }
      if (attempt >= NOTION_REQUEST_MAX_ATTEMPTS - 1) throw error;
      const delayMs = Math.min(
        NOTION_REQUEST_RETRY_BASE_DELAY_MS * (2 ** attempt),
        NOTION_REQUEST_RETRY_MAX_DELAY_MS,
      );
      reportNotionRequestRetry(options, { path, method, attempt, delayMs, error });
      await wait(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Notion API request failed.'));
}

async function safeNotionRequest(
  token: string,
  path: string,
  apiVersion: string,
  options: Parameters<typeof notionRequest>[3] = {},
) {
  try {
    return { ok: true as const, data: await notionRequest(token, path, apiVersion, options) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function notionOAuthTokenRequest(
  input: {
    code: string;
    redirectUri: string;
    apiVersion: string;
  },
  env: Record<string, unknown> | undefined,
) {
  const url = `${notionApiBase(env)}/oauth/token`;
  const clientId = notionOAuthClientId(env);
  const clientSecret = notionOAuthClientSecret(env);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${base64EncodeText(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/json',
      'Notion-Version': input.apiVersion,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) throw await notionErrorFromResponse(response);
  const data = await response.json().catch(() => ({}));
  if (!data || typeof data !== 'object') throw new Error('Notion OAuth token response was invalid.');
  const record = data as Record<string, unknown>;
  if (!optionalString(record.access_token)) throw new Error('Notion OAuth token response did not include an access token.');
  return record;
}

async function notionOAuthRefreshTokenRequest(
  input: {
    refreshToken: string;
    apiVersion: string;
  },
  env: Record<string, unknown> | undefined,
) {
  const url = `${notionApiBase(env)}/oauth/token`;
  const clientId = notionOAuthClientId(env);
  const clientSecret = notionOAuthClientSecret(env);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${base64EncodeText(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/json',
      'Notion-Version': input.apiVersion,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }),
  });
  if (!response.ok) throw await notionErrorFromResponse(response);
  const data = await response.json().catch(() => ({}));
  if (!data || typeof data !== 'object') throw new Error('Notion OAuth refresh response was invalid.');
  const record = data as Record<string, unknown>;
  if (!optionalString(record.access_token)) throw new Error('Notion OAuth refresh response did not include an access token.');
  return record;
}

async function tokenFingerprint(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function notionWorkspaceInfo(me: Record<string, unknown>) {
  const bot = me.bot;
  const botRecord = bot && typeof bot === 'object' ? (bot as Record<string, unknown>) : {};
  return {
    id: typeof botRecord.workspace_id === 'string' ? botRecord.workspace_id : undefined,
    name: typeof botRecord.workspace_name === 'string' ? botRecord.workspace_name : undefined,
  };
}

function notionOAuthWorkspaceInfo(tokenResponse: Record<string, unknown>, me: Record<string, unknown>) {
  const fromMe = notionWorkspaceInfo(me);
  return {
    id: fromMe.id ?? optionalString(tokenResponse.workspace_id),
    name: fromMe.name ?? optionalString(tokenResponse.workspace_name),
  };
}

function safeNotionOAuthOwner(owner: unknown) {
  if (!owner || typeof owner !== 'object') return undefined;
  const ownerRecord = owner as Record<string, unknown>;
  const user = ownerRecord.user && typeof ownerRecord.user === 'object'
    ? ownerRecord.user as Record<string, unknown>
    : undefined;
  return {
    type: optionalString(ownerRecord.type),
    user: user
      ? {
          id: optionalString(user.id),
          object: optionalString(user.object),
          type: optionalString(user.type),
          name: optionalString(user.name),
          avatarUrl: optionalString(user.avatar_url),
        }
      : undefined,
  };
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) {
  return {
    ...(current ?? {}),
    ...(next ?? {}),
  };
}

function putDiscoveredItem(items: Map<string, DiscoveredNotionItem>, item: DiscoveredNotionItem) {
  const existing = items.get(item.notionId);
  if (!existing) {
    items.set(item.notionId, item);
    return;
  }
  const keepExistingSnapshotPhase =
    typeof existing.phase === 'string' &&
    existing.phase.includes('snapshot') &&
    !(typeof item.phase === 'string' && item.phase.includes('snapshot'));
  items.set(item.notionId, {
    ...existing,
    ...item,
    title: item.title || existing.title,
    status: existing.status === 'discovered' && item.status === 'referenced'
      ? existing.status
      : item.status ?? existing.status,
    phase: keepExistingSnapshotPhase ? existing.phase : item.phase ?? existing.phase,
    parentNotionId: item.parentNotionId ?? existing.parentNotionId,
    metadata: mergeMetadata(existing.metadata, item.metadata),
    error: item.error ?? existing.error,
  });
}

function hasDiscoveredNotionId(items: Map<string, DiscoveredNotionItem>, notionId: string) {
  const normalized = normalizedNotionId(notionId);
  if (!normalized) return false;
  for (const id of items.keys()) {
    if (normalizedNotionId(id) === normalized) return true;
  }
  return false;
}

function notionObjectId(record: Record<string, unknown>) {
  return typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
}

export function relationTargetIds(properties: unknown) {
  const ids = new Set<string>();
  if (!properties || typeof properties !== 'object') return [];
  for (const prop of Object.values(properties as Record<string, unknown>)) {
    if (!prop || typeof prop !== 'object') continue;
    const record = prop as Record<string, unknown>;
    const relation = record.relation;
    const rollup = record.rollup;
    const propertyConfig = record.type && typeof record[record.type as string] === 'object'
      ? (record[record.type as string] as Record<string, unknown>)
      : undefined;

    if (Array.isArray(relation)) {
      for (const target of relation) {
        if (target && typeof target === 'object' && typeof (target as Record<string, unknown>).id === 'string') {
          ids.add((target as Record<string, unknown>).id as string);
        }
      }
    }
    if (propertyConfig?.data_source_id && typeof propertyConfig.data_source_id === 'string') {
      ids.add(propertyConfig.data_source_id);
    }
    if (propertyConfig?.database_id && typeof propertyConfig.database_id === 'string') {
      ids.add(propertyConfig.database_id);
    }
    if (rollup && typeof rollup === 'object') {
      const rollupRecord = rollup as Record<string, unknown>;
      for (const key of ['data_source_id', 'database_id', 'relation_property_id', 'rollup_property_id']) {
        if (typeof rollupRecord[key] === 'string') ids.add(rollupRecord[key] as string);
      }
    }
  }
  return Array.from(ids);
}

export function relationTargetReferences(properties: unknown) {
  const refs = new Map<string, { id: string; notionObject: 'data_source' | 'database' }>();
  if (!properties || typeof properties !== 'object') return [];

  for (const prop of Object.values(properties as Record<string, unknown>)) {
    if (!prop || typeof prop !== 'object') continue;
    const record = prop as Record<string, unknown>;
    const notionType = typeof record.type === 'string' ? record.type : '';
    if (notionType !== 'relation') continue;
    const config = notionPropertyConfig(record, notionType);
    const dataSourceId = optionalString(config.data_source_id);
    if (dataSourceId) {
      refs.set(`data_source:${dataSourceId}`, { id: dataSourceId, notionObject: 'data_source' });
      continue;
    }
    const databaseId = optionalString(config.database_id);
    if (databaseId) refs.set(`database:${databaseId}`, { id: databaseId, notionObject: 'database' });
  }

  return Array.from(refs.values());
}

function itemMetadata(item: NotionImportItem | DiscoveredNotionItem) {
  return item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
}

function dataSourceSnapshot(item: NotionImportItem | DiscoveredNotionItem) {
  const metadata = itemMetadata(item);
  const snapshot = metadata.dataSourceSnapshot;
  return snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : undefined;
}

function pageSnapshot(item: NotionImportItem | DiscoveredNotionItem) {
  const metadata = itemMetadata(item);
  const snapshot = metadata.pageSnapshot;
  return snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : undefined;
}

function viewSnapshot(item: NotionImportItem | DiscoveredNotionItem) {
  const metadata = itemMetadata(item);
  const view = metadata.view;
  return view && typeof view === 'object' ? view as Record<string, unknown> : undefined;
}

function notionPropertiesFromSnapshot(snapshot: Record<string, unknown> | undefined) {
  const dataSource = snapshot?.dataSource;
  if (!dataSource || typeof dataSource !== 'object') return {};
  const properties = (dataSource as Record<string, unknown>).properties;
  return properties && typeof properties === 'object' ? properties as Record<string, unknown> : {};
}

function addNotionPropertySeenKeys(seen: Set<string>, nameOrId: string, rawProperty: unknown) {
  const property = asRecord(rawProperty) ?? {};
  for (const candidate of [
    nameOrId,
    property.id,
    property.name,
    property.property_id,
    property.propertyId,
  ]) {
    for (const variant of notionPropertyReferenceVariants(candidate)) seen.add(variant);
  }
}

function inferredSelectOptionsFromRowPropertyValue(rawValue: Record<string, unknown>, type: string) {
  const options: Record<string, unknown>[] = [];
  const pushOption = (value: unknown) => {
    const option = asRecord(value);
    const id = optionalString(option?.id);
    const name = optionalString(option?.name);
    if (!id && !name) return;
    if (options.some((existing) => existing.id === id || existing.name === name)) return;
    options.push({
      id: id ?? name,
      name: name ?? id,
      color: optionColor(option?.color),
    });
  };

  if (type === 'select') pushOption(rawValue.select);
  else if (type === 'status') pushOption(rawValue.status);
  else if (type === 'multi_select' && Array.isArray(rawValue.multi_select)) {
    for (const option of rawValue.multi_select) pushOption(option);
  }

  return options.length ? { options } : {};
}

export function inferredNotionPropertyFromRowValue(nameOrId: string, rawValue: unknown) {
  const value = asRecord(rawValue);
  if (!value) return undefined;
  const type = optionalString(value.type);
  const id = optionalString(value.id) ?? nameOrId;
  if (!type || !id) return undefined;
  return {
    id,
    name: nameOrId,
    type,
    inferredFromRowPropertySnapshot: true,
    [type]: inferredSelectOptionsFromRowPropertyValue(value, type),
  };
}

function augmentNotionPropertiesFromRowSnapshots(
  sourceProperties: Record<string, unknown>,
  dataSourceId: string,
  items: NotionImportItem[],
) {
  const merged = { ...sourceProperties };
  const seen = new Set<string>();
  for (const [nameOrId, rawProperty] of Object.entries(sourceProperties)) {
    addNotionPropertySeenKeys(seen, nameOrId, rawProperty);
  }

  let inferred = 0;
  for (const item of items) {
    if (item.notionObject !== 'page') continue;
    if (optionalString(itemMetadata(item).dataSourceId) !== dataSourceId) continue;
    const rawProperties = asRecord(itemMetadata(item).properties);
    if (!rawProperties) continue;
    for (const [nameOrId, rawValue] of Object.entries(rawProperties)) {
      const property = inferredNotionPropertyFromRowValue(nameOrId, rawValue);
      if (!property) continue;
      const propertySeen = notionPropertyReferenceVariants(property.id).some((variant) => seen.has(variant)) ||
        notionPropertyReferenceVariants(property.name).some((variant) => seen.has(variant));
      if (propertySeen) continue;
      const key = Object.prototype.hasOwnProperty.call(merged, nameOrId) ? property.id : nameOrId;
      merged[key] = property;
      addNotionPropertySeenKeys(seen, key, property);
      inferred += 1;
    }
  }

  return { properties: merged, inferred };
}

function notionPropertyMappingId(dataSourceId: string, propertyId: string) {
  return `notion-property:${dataSourceId}:${propertyId}`;
}

function notionPropertyConfig(prop: Record<string, unknown>, notionType: string) {
  return prop[notionType] && typeof prop[notionType] === 'object'
    ? prop[notionType] as Record<string, unknown>
    : {};
}

function localNumberFormat(format: unknown) {
  if (format === 'number_with_commas') return 'comma';
  return (
    format === 'number' ||
    format === 'comma' ||
    format === 'percent' ||
    format === 'dollar' ||
    format === 'won' ||
    format === 'euro'
  )
    ? format
    : undefined;
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function notionPropertyReferenceVariants(value: unknown) {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  const decoded = safeDecode(trimmed).trim();
  if (decoded) variants.add(decoded);
  return Array.from(variants);
}

function fileNameFromUrl(url: string) {
  const value = url.trim();
  if (!value) return 'Untitled';
  if (value.startsWith('data:')) {
    const match = /^data:([^;,]+)/.exec(value);
    if (match?.[1]) return match[1].split('/').at(-1) || 'file';
    return 'file';
  }
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return safeDecode(pathname) || parsed.hostname || 'Untitled';
  } catch {
    return safeDecode(value.split(/[/?#]/).filter(Boolean).at(-1) ?? '') || 'Untitled';
  }
}

function nestedFileRecord(record: Record<string, unknown>, key: string) {
  return asRecord(record[key]);
}

function notionFileUrl(fileLike: unknown) {
  const record = asRecord(fileLike);
  if (!record) return undefined;
  const direct = optionalString(record.url);
  if (direct) return direct;
  const external = nestedFileRecord(record, 'external');
  const externalUrl = optionalString(external?.url);
  if (externalUrl) return externalUrl;
  const file = nestedFileRecord(record, 'file');
  const fileUrl = optionalString(file?.url);
  if (fileUrl) return fileUrl;
  const customEmoji = nestedFileRecord(record, 'custom_emoji');
  return optionalString(customEmoji?.url);
}

function notionFileExpiryTime(fileLike: unknown) {
  const record = asRecord(fileLike);
  if (!record) return undefined;
  return optionalString(record.expiry_time) ?? optionalString(nestedFileRecord(record, 'file')?.expiry_time);
}

function notionFileSource(fileLike: unknown): NotionFileReference['notionFileSource'] {
  const record = asRecord(fileLike);
  if (!record) return 'unknown';
  const type = optionalString(record.type);
  if (type === 'external' || nestedFileRecord(record, 'external')) return 'external';
  if (type === 'file' || nestedFileRecord(record, 'file')) return 'notion_file';
  if (type === 'custom_emoji' || nestedFileRecord(record, 'custom_emoji')) return 'external';
  if (optionalString(record.url)) return 'direct_url';
  return 'unknown';
}

function notionFileReference(fileLike: unknown, fallbackName?: string): NotionFileReference | undefined {
  const record = asRecord(fileLike);
  if (!record) return undefined;
  const url = notionFileUrl(record);
  if (!url) return undefined;
  const mimeType =
    optionalString(record.mime_type) ??
    optionalString(record.mimeType) ??
    optionalString(nestedFileRecord(record, 'file')?.mime_type) ??
    optionalString(nestedFileRecord(record, 'file')?.mimeType);
  const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined;
  return {
    id: optionalString(record.id) ?? url,
    name:
      optionalString(record.name) ??
      optionalString(record.fileName) ??
      optionalString(record.filename) ??
      optionalString(fallbackName) ??
      fileNameFromUrl(url),
    url,
    type: mimeType,
    size,
    notionFileSource: notionFileSource(record),
    notionFileExpiryTime: notionFileExpiryTime(record),
    notionFile: record,
  };
}

type ImportedPageIconType = 'none' | 'emoji' | 'image';

interface ImportedPageChrome {
  icon?: string;
  iconType: ImportedPageIconType;
  cover?: string;
  coverPosition?: number;
  iconReference?: NotionFileReference;
  coverReference?: NotionFileReference;
}

function pageChromeSourceRecords(item: NotionImportItem | DiscoveredNotionItem) {
  const metadata = itemMetadata(item);
  const snapshot = pageSnapshot(item);
  return [
    asRecord(metadata.page),
    metadata,
    asRecord(snapshot?.page),
    snapshot,
  ].filter((record): record is Record<string, unknown> => !!record);
}

function notionPageIconRecord(item: NotionImportItem | DiscoveredNotionItem) {
  for (const source of pageChromeSourceRecords(item)) {
    const icon = asRecord(source.icon);
    if (icon) return icon;
  }
  return undefined;
}

function notionPageCoverRecord(item: NotionImportItem | DiscoveredNotionItem) {
  for (const source of pageChromeSourceRecords(item)) {
    const cover = asRecord(source.cover);
    if (cover) return cover;
  }
  return undefined;
}

function importedPageChromeFromItem(item: NotionImportItem | DiscoveredNotionItem): ImportedPageChrome {
  const title = item.title || item.notionId || 'Notion page';
  const icon = notionPageIconRecord(item);
  let iconValue: string | undefined;
  let iconType: ImportedPageIconType = 'none';
  let iconReference: NotionFileReference | undefined;

  if (icon) {
    const emoji = optionalString(icon.emoji);
    if (optionalString(icon.type) === 'emoji' && emoji) {
      iconValue = emoji;
      iconType = 'emoji';
    } else {
      iconReference = notionFileReference(icon, `${title} icon`);
      if (iconReference) {
        iconValue = iconReference.url;
        iconType = 'image';
      }
    }
  }

  const coverReference = notionFileReference(notionPageCoverRecord(item), `${title} cover`);
  return {
    icon: iconValue,
    iconType,
    cover: coverReference?.url,
    coverPosition: coverReference ? 50 : undefined,
    iconReference,
    coverReference,
  };
}

export function importedPageShouldUseFullWidth(
  item: NotionImportItem | DiscoveredNotionItem,
  importPagesFullWidth?: boolean,
) {
  if (importPagesFullWidth !== undefined) return importPagesFullWidth;
  const snapshot = pageSnapshot(item);
  const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
  return childBlocks.some((block) => asRecord(block)?.type === 'column_list');
}

function pagePropertiesWithChromeReferences(
  properties: Record<string, unknown> | undefined,
  chrome: ImportedPageChrome,
) {
  const next = properties ? { ...properties } : {};
  let changed = false;
  if (chrome.iconReference) {
    next[NOTION_PAGE_ICON_REFERENCE_KEY] = chrome.iconReference;
    changed = true;
  }
  if (chrome.coverReference) {
    next[NOTION_PAGE_COVER_REFERENCE_KEY] = chrome.coverReference;
    changed = true;
  }
  return properties || changed ? next : undefined;
}

function cleanFileSegment(value: string) {
  return (
    value
      .trim()
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'file'
  );
}

function extensionFromName(name: string) {
  const match = name.match(/\.([a-z0-9]{1,12})$/i);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function normalizeFileName(value: unknown) {
  const name = typeof value === 'string' && value.trim() ? value.trim() : 'Untitled';
  return name.slice(0, 180);
}

function storageUrl(request: Request | undefined, bucket: string, key: string) {
  if (!request) return undefined;
  const origin = new URL(request.url).origin;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${origin}/api/storage/${encodeURIComponent(bucket)}/${encodedKey}`;
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

function fileSize(upload: FileUpload) {
  return typeof upload.size === 'number' && Number.isFinite(upload.size)
    ? Math.max(0, Math.floor(upload.size))
    : 0;
}

function activeStorageReservationBytes(upload: FileUpload, now: number) {
  if (upload.status === 'uploaded') return fileSize(upload);
  if (upload.status === 'pending' && upload.expiresAt && new Date(upload.expiresAt).getTime() > now) {
    return fileSize(upload);
  }
  if (upload.status === 'pending' && !upload.expiresAt) return fileSize(upload);
  return 0;
}

async function assertImportStorageLimit(
  db: DbRef,
  workspace: Workspace,
  requestedBytes: number,
) {
  if (!workspace.organizationId) return;
  const organization = await getExisting(db.table<Organization>('organizations'), workspace.organizationId);
  const limit = organization?.storageLimitBytes;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return;

  const workspaces = await listAll(
    db.table<Workspace>('workspaces').where('organizationId', '==', workspace.organizationId),
  );
  const now = Date.now();
  let reservedBytes = 0;
  for (const organizationWorkspace of workspaces) {
    const uploads = await listAll(
      db.table<FileUpload>('file_uploads').where('workspaceId', '==', organizationWorkspace.id),
    );
    for (const upload of uploads) {
      reservedBytes += activeStorageReservationBytes(upload, now);
    }
  }

  if (reservedBytes + requestedBytes > limit) {
    throw new Error('Organization storage limit exceeded.');
  }
}

function relationTargetNotionId(config: Record<string, unknown> | undefined) {
  if (!config) return undefined;
  if (typeof config.data_source_id === 'string' && config.data_source_id.trim()) return config.data_source_id.trim();
  if (typeof config.database_id === 'string' && config.database_id.trim()) return config.database_id.trim();
  return undefined;
}

const SUPPORTED_NOTION_PROPERTY_TYPES = new Set([
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'people',
  'person',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'phone',
  'files',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'relation',
  'rollup',
  'formula',
  'unique_id',
]);

const SUPPORTED_NOTION_VIEW_TYPES = new Set(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']);

const LOCAL_TABLE_CALCULATIONS = new Set([
  'count_all',
  'count_values',
  'count_unique',
  'count_empty',
  'percent_empty',
  'percent_not_empty',
  'checked',
  'unchecked',
  'percent_checked',
  'percent_unchecked',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest_date',
  'latest_date',
  'date_range',
]);

const NOTION_TABLE_CALCULATION_ALIASES = new Map([
  ['count', 'count_all'],
  ['count_all', 'count_all'],
  ['all', 'count_all'],
  ['values', 'count_values'],
  ['count_values', 'count_values'],
  ['count_not_empty', 'count_values'],
  ['not_empty', 'count_values'],
  ['count_unique', 'count_unique'],
  ['count_unique_values', 'count_unique'],
  ['unique', 'count_unique'],
  ['unique_values', 'count_unique'],
  ['empty', 'count_empty'],
  ['count_empty', 'count_empty'],
  ['percent_empty', 'percent_empty'],
  ['percent_not_empty', 'percent_not_empty'],
  ['checked', 'checked'],
  ['unchecked', 'unchecked'],
  ['percent_checked', 'percent_checked'],
  ['percent_unchecked', 'percent_unchecked'],
  ['sum', 'sum'],
  ['average', 'average'],
  ['avg', 'average'],
  ['mean', 'average'],
  ['median', 'median'],
  ['min', 'min'],
  ['minimum', 'min'],
  ['max', 'max'],
  ['maximum', 'max'],
  ['range', 'range'],
  ['earliest', 'earliest_date'],
  ['earliest_date', 'earliest_date'],
  ['latest', 'latest_date'],
  ['latest_date', 'latest_date'],
  ['date_range', 'date_range'],
]);

const VIEW_VISIBLE_PROPERTY_KEYS = ['visible_properties', 'visibleProperties'];
const VIEW_HIDDEN_PROPERTY_KEYS = ['hidden_properties', 'hiddenProperties'];
const VIEW_PROPERTY_ORDER_KEYS = ['property_order', 'propertyOrder'];
const VIEW_FILTER_KEYS = ['filter', 'filters', 'filter_group', 'filterGroup', 'where'];
const VIEW_SORT_KEYS = ['sorts', 'sort', 'property_sorts', 'propertySorts'];
const VIEW_PROPERTY_SETTING_KEYS = [
  'property_settings',
  'propertySettings',
  'properties',
  'columns',
  'table_properties',
  'tableProperties',
  'board_properties',
  'boardProperties',
  'list_properties',
  'listProperties',
  'gallery_properties',
  'galleryProperties',
  'calendar_properties',
  'calendarProperties',
  'timeline_properties',
  'timelineProperties',
];
const VIEW_PROPERTY_WIDTH_KEYS = [
  'property_widths',
  'propertyWidths',
  'column_widths',
  'columnWidths',
  'table_column_widths',
  'tableColumnWidths',
];
const VIEW_TABLE_CALCULATION_KEYS = [
  'table_calculations',
  'tableCalculations',
  'table_summaries',
  'tableSummaries',
  'property_calculations',
  'propertyCalculations',
  'summaries',
  'summary',
  'aggregations',
  'aggregates',
];
const VIEW_WRAPPED_COLUMN_KEYS = [
  'wrapped_columns',
  'wrappedColumns',
  'wrapped_properties',
  'wrappedProperties',
  'wrap_properties',
  'wrapProperties',
];
const VIEW_QUICK_FILTER_KEYS = ['quick_filters', 'quickFilters', 'quick_filter', 'quickFilter', 'filter_chips', 'filterChips'];
const VIEW_GROUP_BY_KEYS = ['group_by', 'groupBy', 'group', 'group_property', 'groupProperty'];
const VIEW_SUBGROUP_BY_KEYS = ['sub_group_by', 'subGroupBy', 'subgroup_by', 'subgroupBy', 'subgroup'];
const VIEW_CALENDAR_BY_KEYS = [
  'calendar_by',
  'calendarBy',
  'calendar_property',
  'calendarProperty',
  'date_property',
  'dateProperty',
  'date_property_id',
  'datePropertyId',
  'date_property_name',
  'datePropertyName',
];
const VIEW_TIMELINE_BY_KEYS = ['timeline_by', 'timelineBy', 'timeline_start', 'timelineStart', 'start_property', 'startProperty'];
const VIEW_TIMELINE_END_BY_KEYS = [
  'timeline_end_by',
  'timelineEndBy',
  'timeline_end',
  'timelineEnd',
  'end_property',
  'endProperty',
];
const VIEW_COVER_PROPERTY_KEYS = ['cover_property', 'coverProperty', 'cover', 'card_cover', 'cardCover'];
const VIEW_DEPENDENCY_PROPERTY_KEYS = [
  'dependency_property',
  'dependencyProperty',
  'dependency',
  'dependency_by',
  'dependencyBy',
  'depends_on',
  'dependsOn',
  'timeline_dependency',
  'timelineDependency',
];
const VIEW_ROW_HEIGHT_KEYS = ['row_height', 'rowHeight', 'table_row_height', 'tableRowHeight'];
const VIEW_CARD_SIZE_KEYS = ['card_size', 'cardSize', 'board_card_size', 'boardCardSize', 'gallery_card_size', 'galleryCardSize'];
const VIEW_OPEN_PAGE_IN_KEYS = ['open_page_in', 'openPageIn', 'page_open', 'pageOpen', 'open_pages_in', 'openPagesIn'];
const VIEW_TIMELINE_ZOOM_KEYS = ['timeline_zoom', 'timelineZoom', 'zoom'];
const VIEW_WRAP_KEYS = ['wrap', 'wrap_cells', 'wrapCells', 'table_wrap', 'tableWrap', 'wrap_table_cells', 'wrapTableCells'];

const SUPPORTED_NOTION_BLOCK_TYPES = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'divider',
  'code',
  'equation',
  'callout',
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'bookmark',
  'embed',
  'link_preview',
  'meeting_notes',
  'transcription',
  'child_page',
  'child_database',
  'link_to_page',
  'synced_block',
  'table_of_contents',
  'breadcrumb',
  'tab',
  'button',
  'template',
  'column_list',
  'column',
  'table',
  'table_row',
  'unsupported',
]);

function emptyConversionReport(): ImportConversionReport {
  return {
    summary: {},
    warnings: [],
    unsupported: [],
    missingPermissions: [],
    unresolvedReferences: [],
  };
}

function incrementReport(report: ImportConversionReport, key: string, by = 1) {
  report.summary[key] = (report.summary[key] ?? 0) + by;
}

function pushReportIssue(
  list: NotionImportWarning[],
  issue: NotionImportWarning,
  maxItems = 200,
) {
  if (list.length < maxItems) list.push(issue);
}

function reportUnresolvedFormulaPropertyReference(
  report: ImportConversionReport,
  dataSourceId: string,
  notionPropertyId: string | undefined,
  formulaPropertyName: string,
  referencedProperty: string,
) {
  incrementReport(report, 'unresolvedFormulaPropertyReferences');
  pushReportIssue(report.unresolvedReferences, {
    code: 'formula_property_unresolved',
    notionId: notionPropertyId ?? dataSourceId,
    notionObject: 'property',
    message:
      `Formula property "${formulaPropertyName}" references unknown Notion property "${referencedProperty}" ` +
      `in data source ${dataSourceId}. The original formula was preserved, but that property reference could not be remapped.`,
  });
}

function reportUnsupportedFormulaFunctions(
  report: ImportConversionReport,
  dataSourceId: string,
  notionPropertyId: string | undefined,
  formulaPropertyName: string,
  unsupportedFunctions: string[],
) {
  if (unsupportedFunctions.length === 0) return;
  incrementReport(report, 'unsupportedFormulaFunctions', unsupportedFunctions.length);
  pushReportIssue(report.unsupported, {
    code: 'formula_function_unsupported',
    notionId: notionPropertyId ?? dataSourceId,
    notionObject: 'property',
    message:
      `Formula property "${formulaPropertyName}" uses unsupported function(s): ${unsupportedFunctions.join(', ')}. ` +
      'The original formula and Notion-computed cell values were preserved for fallback.',
  });
}

function reportUnsupportedProperty(
  report: ImportConversionReport,
  dataSourceId: string,
  propertyId: string,
  propertyName: string,
  notionType: string,
) {
  if (SUPPORTED_NOTION_PROPERTY_TYPES.has(notionType.trim().toLowerCase())) return;
  incrementReport(report, 'unsupportedProperties');
  pushReportIssue(report.unsupported, {
    code: 'unsupported_property_type',
    notionId: propertyId,
    notionObject: 'property',
    message: `Property "${propertyName}" from data source ${dataSourceId} uses unsupported Notion type "${notionType}" and was imported as rich text fallback.`,
  });
}

function reportUnsupportedView(
  report: ImportConversionReport,
  dataSourceId: string,
  view: Record<string, unknown>,
) {
  const type = typeof view.type === 'string' ? view.type.trim().toLowerCase() : '';
  if (SUPPORTED_NOTION_VIEW_TYPES.has(type)) return;
  incrementReport(report, 'unsupportedViews');
  pushReportIssue(report.unsupported, {
    code: 'unsupported_view_type',
    notionId: notionObjectId(view) ?? dataSourceId,
    notionObject: 'view',
    message: `View "${typeof view.name === 'string' ? view.name : 'Untitled'}" uses unsupported Notion type "${type || 'unknown'}" and was imported with a fallback renderer.`,
  });
}

function reportUnresolvedViewPropertyReferences(
  report: ImportConversionReport | undefined,
  dataSourceId: string | undefined,
  view: Record<string, unknown>,
  collector: ViewPropertyReferenceCollector,
) {
  if (!report || collector.unresolved.length === 0) return;
  incrementReport(report, 'unresolvedViewPropertyReferences', collector.unresolved.length);
  const viewName = typeof view.name === 'string' && view.name.trim() ? view.name.trim() : 'Untitled';
  for (const issue of collector.unresolved) {
    pushReportIssue(report.unresolvedReferences, {
      code: 'view_property_unresolved',
      notionId: notionObjectId(view) ?? dataSourceId,
      notionObject: 'view',
      message:
        `View "${viewName}" references unknown Notion property "${issue.property}" in ${issue.source}. ` +
        'The raw Notion view setting was preserved, but that setting could not be remapped to a local property.',
    });
  }
}

function reportNotionFileReferences(
  report: ImportConversionReport | undefined,
  notionId: string | undefined,
  notionObject: string,
  label: string,
  references: Array<NotionFileReference | undefined>,
  options: { needsCopy?: boolean } = {},
) {
  if (!report) return;
  const files = references.filter((item): item is NotionFileReference => !!item);
  if (files.length === 0) return;
  incrementReport(report, 'fileReferences', files.length);
  if (options.needsCopy !== false) incrementReport(report, 'filesNeedCopy', files.length);
  const temporaryFiles = files.filter((item) => item.notionFileSource === 'notion_file').length;
  const externalFiles = files.filter((item) => item.notionFileSource === 'external').length;
  if (temporaryFiles > 0) incrementReport(report, 'temporaryFileReferences', temporaryFiles);
  if (externalFiles > 0) incrementReport(report, 'externalFileReferences', externalFiles);
  pushReportIssue(report.warnings, {
    code: 'file_reference_preserved',
    notionId,
    notionObject,
    message:
      `${files.length} file reference(s) from ${label} were preserved as source URLs. ` +
      (options.needsCopy === false
        ? 'They were copied into EdgeBase storage during apply.'
        : 'They still need EdgeBase storage copy for a permanent migration.'),
  });
}

function reportNotionFileCopy(
  report: ImportConversionReport | undefined,
  notionId: string | undefined,
  notionObject: string,
  label: string,
  reference: NotionFileReference,
  upload: FileUpload,
) {
  if (!report) return;
  incrementReport(report, 'fileReferences');
  incrementReport(report, 'fileCopies');
  if (reference.notionFileSource === 'notion_file') incrementReport(report, 'temporaryFileCopies');
  if (reference.notionFileSource === 'external') incrementReport(report, 'externalFileCopies');
  pushReportIssue(report.warnings, {
    code: 'file_reference_copied',
    notionId,
    notionObject,
    message: `File "${upload.name}" from ${label} was copied into EdgeBase storage.`,
  });
}

function reportNotionFileCopySkipped(
  report: ImportConversionReport | undefined,
  notionId: string | undefined,
  notionObject: string,
  label: string,
  reference: NotionFileReference,
  reason: string,
) {
  if (!report) return;
  reportNotionFileReferences(report, notionId, notionObject, label, [reference], { needsCopy: true });
  incrementReport(report, 'fileCopySkipped');
  pushReportIssue(report.warnings, {
    code: 'file_copy_skipped',
    notionId,
    notionObject,
    message: `File "${reference.name}" from ${label} was left as its source URL: ${reason}`,
  });
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parseOptionalBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

function assertNotionFileCopyNotDisabled(body?: Record<string, unknown>) {
  if (body && Object.prototype.hasOwnProperty.call(body, 'copyFilesToStorage') && parseBoolean(body.copyFilesToStorage, true) === false) {
    throw new Error('copyFilesToStorage cannot be disabled. Notion imports always copy files into EdgeBase storage.');
  }
}

function normalizedImportedContentType(contentType: string | null | undefined, fallback?: string) {
  const value = (contentType || fallback || '').trim().toLowerCase();
  if (
    value &&
    value.length <= 128 &&
    /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(value)
  ) {
    return value;
  }
  return 'application/octet-stream';
}

function fileCopyScopeForBlockType(type: string): NotionFileCopyTarget['scope'] {
  if (type === 'image') return 'blocks/images';
  if (type === 'video') return 'blocks/videos';
  if (type === 'audio') return 'blocks/audio';
  return 'blocks/files';
}

function localStoredFileReference(reference: NotionFileReference, upload: FileUpload) {
  return {
    ...reference,
    id: upload.id,
    uploadId: upload.id,
    bucket: upload.bucket,
    key: upload.key,
    name: upload.name,
    url: upload.url ?? reference.url,
    type: upload.contentType ?? reference.type,
    size: upload.size,
    sourceUrl: reference.url,
    notionFileCopied: true,
    notionFileCopiedAt: upload.completedAt,
  };
}

function storedNotionFileReference(value: unknown): NotionFileReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.notionFileCopied === true || record.fileUploadId || record.key) return undefined;
  const url = optionalString(record.sourceUrl) ?? optionalString(record.url);
  if (!url) return undefined;
  const notionFile = asRecord(record.notionFile) ?? record;
  return {
    id: optionalString(record.id) ?? url,
    name: normalizeFileName(record.name ?? record.fileName ?? fileNameFromUrl(url)),
    url,
    type: optionalString(record.type) ?? optionalString(record.mimeType),
    size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined,
    notionFileSource:
      record.notionFileSource === 'external' ||
      record.notionFileSource === 'notion_file' ||
      record.notionFileSource === 'direct_url' ||
      record.notionFileSource === 'unknown'
        ? record.notionFileSource
        : notionFileSource(notionFile),
    notionFileExpiryTime: optionalString(record.notionFileExpiryTime),
    notionFile,
  };
}

function sourceUrlCanBeCopied(url: string) {
  return /^https?:\/\//i.test(url) || /^data:/i.test(url);
}

function responseContentLength(response: Response) {
  const raw = response.headers.get('content-length');
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// No Content-Length: accumulate the body with a running byte cap and abort the
// read as soon as the cap is crossed, instead of buffering the whole response
// first — an attacker-controlled chunked response must not be able to exhaust
// worker memory before the size check runs. Exported for the unit cap test.
export async function readResponseBodyWithByteCap(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Runtimes that expose no readable stream (e.g. data: URL fetches) still
    // get the post-hoc check.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('source file is too large');
    return buffer;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('source file is too large').catch(() => {});
      throw new Error('source file is too large');
    }
    parts.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined.buffer;
}

async function fetchFileForImport(reference: NotionFileReference) {
  if (!sourceUrlCanBeCopied(reference.url)) {
    throw new Error('unsupported file URL scheme');
  }
  // SSRF guard: `data:` URLs are inline payloads (no network fetch), but any
  // http(s) source must resolve to a public host on every redirect hop.
  // fetchPublicResource follows redirects manually and re-validates each one.
  const isHttp = /^https?:\/\//i.test(reference.url);
  const response = isHttp ? await fetchPublicResource(reference.url) : await fetch(reference.url);
  if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
  const contentLength = responseContentLength(response);
  if (contentLength && contentLength > MAX_IMPORTED_FILE_SIZE) {
    throw new Error('source file is too large');
  }
  const contentType = normalizedImportedContentType(response.headers.get('content-type'), reference.type);
  if (response.body && contentLength) {
    return {
      body: response.body,
      size: contentLength,
      contentType,
    };
  }
  const buffer = await readResponseBodyWithByteCap(response, MAX_IMPORTED_FILE_SIZE);
  if (buffer.byteLength <= 0) throw new Error('source file was empty');
  return {
    body: buffer,
    size: buffer.byteLength,
    contentType,
  };
}

function fileCopyFailureMessage(label: string, reference: NotionFileReference, reason: string) {
  return `Notion import could not copy file "${reference.name}" from ${label} into EdgeBase storage: ${reason}`;
}

function reportOrThrowNotionFileCopySkipped(
  context: NotionFileCopyContext,
  target: NotionFileCopyTarget,
  reference: NotionFileReference,
  reason: string,
) {
  context.stats.fileCopySkipped += 1;
  reportNotionFileCopySkipped(
    context.conversionReport,
    target.notionId,
    target.notionObject,
    target.label,
    reference,
    reason,
  );
  if (context.requireStoredFileCopies) {
    throw new Error(fileCopyFailureMessage(target.label, reference, reason));
  }
}

function pagePropertyRecordForFileRefresh(page: Record<string, unknown>, target: NotionFileCopyTarget) {
  const properties = asRecord(page.properties);
  if (!properties) return undefined;
  const targetPropertyId = optionalString(target.notionPropertyId);
  const targetPropertyName = optionalString(target.notionPropertyName);
  for (const [nameOrId, rawValue] of Object.entries(properties)) {
    const prop = asRecord(rawValue);
    if (!prop) continue;
    const notionPropId = optionalString(prop.id) ?? nameOrId;
    if (targetPropertyId && notionPropId === targetPropertyId) return rawValue;
    if (targetPropertyName && nameOrId === targetPropertyName) return rawValue;
  }
  return undefined;
}

function refreshedPagePropertyFileReference(
  page: Record<string, unknown>,
  target: NotionFileCopyTarget,
  staleReference: NotionFileReference,
) {
  const prop = pagePropertyRecordForFileRefresh(page, target);
  const references = notionFilePropertyReferences(prop);
  if (references.length === 0) return undefined;
  const targetName = optionalString(target.notionFileName) || staleReference.name;
  const targetIndex = typeof target.notionFileIndex === 'number' ? target.notionFileIndex : -1;
  const byIndex = targetIndex >= 0 ? references[targetIndex] : undefined;
  if (byIndex && (!targetName || byIndex.name === targetName)) return byIndex;
  return references.find((item) => item.name === targetName) ?? byIndex ?? references[0];
}

function refreshedPageChromeFileReference(
  page: Record<string, unknown>,
  target: NotionFileCopyTarget,
  staleReference: NotionFileReference,
) {
  const raw = target.notionPageFileKind === 'icon'
    ? notionPageIconRecord({ notionId: target.notionPageId ?? '', notionObject: 'page', metadata: { page } })
    : target.notionPageFileKind === 'cover'
      ? notionPageCoverRecord({ notionId: target.notionPageId ?? '', notionObject: 'page', metadata: { page } })
      : undefined;
  return notionFileReference(raw, staleReference.name);
}

async function refreshNotionFileReference(
  context: NotionFileCopyContext,
  target: NotionFileCopyTarget,
  staleReference: NotionFileReference,
) {
  if (!context.notionToken || staleReference.notionFileSource !== 'notion_file') return undefined;
  const apiVersion = context.apiVersion || context.job.apiVersion || NOTION_API_VERSION;

  try {
    if (target.notionBlockId) {
      const block = await notionRequest(
        context.notionToken,
        `/blocks/${encodeURIComponent(target.notionBlockId)}`,
        apiVersion,
        { apiBase: context.apiBase },
      );
      return fileReferenceFromNotionBlock(block);
    }

    if (target.notionPageId) {
      const page = await notionRequest(
        context.notionToken,
        `/pages/${encodeURIComponent(target.notionPageId)}`,
        apiVersion,
        { apiBase: context.apiBase },
      );
      return (
        refreshedPagePropertyFileReference(page, target, staleReference) ??
        refreshedPageChromeFileReference(page, target, staleReference)
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    pushReportIssue(context.conversionReport?.warnings ?? [], {
      code: 'file_reference_refresh_failed',
      notionId: target.notionId,
      notionObject: target.notionObject,
      message: `Could not refresh Notion file URL for "${staleReference.name}" from ${target.label}: ${reason}`,
    });
  }

  return undefined;
}

async function storeNotionFileReference(
  context: NotionFileCopyContext,
  target: NotionFileCopyTarget,
  reference: NotionFileReference,
) {
  const proxy = storageBucket(context.storage, FILE_BUCKET);
  if (!proxy?.put) throw new Error('EdgeBase storage is not available in this runtime');

  const workspace = await getExisting(context.db.table<Workspace>('workspaces'), context.job.workspaceId);
  if (!workspace) throw new Error('workspace was not found');
  const file = await fetchFileForImport(reference);
  await assertImportStorageLimit(context.db, workspace, file.size);

  const id = newId();
  const name = normalizeFileName(reference.name);
  const base = cleanFileSegment(name);
  const ext = extensionFromName(name);
  const key = `workspaces/${context.job.workspaceId}/notion-import/${context.job.id}/${target.scope}/${id}-${base}${ext}`;
  const now = nowIso();
  const url = storageUrl(context.request, FILE_BUCKET, key) ?? reference.url;

  await proxy.put(key, file.body, {
    contentType: file.contentType,
    customMetadata: {
      notionImportJobId: context.job.id,
      notionFileSource: reference.notionFileSource,
      notionSourceUrl: reference.url.slice(0, 1024),
    },
  });

  const upload = await context.db.table<FileUpload>('file_uploads').insert({
    id,
    workspaceId: context.job.workspaceId,
    bucket: FILE_BUCKET,
    key,
    scope: target.scope,
    pageId: target.pageId,
    blockId: target.blockId,
    databaseId: target.databaseId,
    propertyId: target.propertyId,
    name,
    contentType: file.contentType,
    size: file.size,
    status: 'uploaded',
    url,
    createdBy: context.actorId,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  context.stats.fileCopies += 1;
  reportNotionFileCopy(
    context.conversionReport,
    target.notionId,
    target.notionObject,
    target.label,
    reference,
    upload,
  );
  return localStoredFileReference(reference, upload);
}

async function copyNotionFileReference(
  context: NotionFileCopyContext,
  target: NotionFileCopyTarget,
  reference: NotionFileReference,
) {
  try {
    return await storeNotionFileReference(context, target, reference);
  } catch (firstError) {
    const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
    const refreshed = await refreshNotionFileReference(context, target, reference);
    if (refreshed && refreshed.url && refreshed.url !== reference.url) {
      try {
        return await storeNotionFileReference(context, target, refreshed);
      } catch (secondError) {
        const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
        reportOrThrowNotionFileCopySkipped(
          context,
          target,
          refreshed,
          `fresh Notion file URL retry failed after initial error "${firstMessage}": ${secondMessage}`,
        );
        return refreshed;
      }
    }

    reportOrThrowNotionFileCopySkipped(context, target, reference, firstMessage);
    return reference;
  }
}

function localPropertyType(notionType: string) {
  const normalized = notionType.trim().toLowerCase();
  if (normalized === 'phone_number') return 'phone';
  if (normalized === 'people') return 'person';
  if (normalized === 'created_by' || normalized === 'last_edited_by') return normalized;
  if (
    [
      'title',
      'rich_text',
      'number',
      'select',
      'multi_select',
      'status',
      'date',
      'person',
      'checkbox',
      'url',
      'email',
      'phone',
      'files',
      'created_time',
      'last_edited_time',
      'relation',
      'rollup',
      'formula',
      'unique_id',
    ].includes(normalized)
  ) {
    return normalized;
  }
  return 'rich_text';
}

function optionColor(color: unknown) {
  return typeof color === 'string' && color.trim() ? color.trim() : 'default';
}

function mapSelectOptions(config: unknown) {
  if (!config || typeof config !== 'object') return undefined;
  const options = (config as Record<string, unknown>).options;
  if (!Array.isArray(options)) return undefined;
  return options
    .filter((option): option is Record<string, unknown> => !!option && typeof option === 'object')
    .map((option) => ({
      id: typeof option.id === 'string' ? option.id : newId(),
      name: typeof option.name === 'string' ? option.name : 'Option',
      color: optionColor(option.color),
    }));
}

function dbPropertyFromNotion(
  databaseId: string,
  notionPropertyId: string,
  notionProperty: unknown,
  position: number,
): DbProperty {
  const prop = notionProperty && typeof notionProperty === 'object'
    ? notionProperty as Record<string, unknown>
    : {};
  const notionType = typeof prop.type === 'string' ? prop.type : 'rich_text';
  const localType = localPropertyType(notionType);
  const notionConfig = notionPropertyConfig(prop, notionType);
  const formulaExpression = typeof notionConfig.expression === 'string' ? notionConfig.expression : '';
  return {
    id: newId(),
    databaseId,
    name: typeof prop.name === 'string' && prop.name.trim() ? prop.name.trim() : `Property ${position + 1}`,
    description: typeof prop.description === 'string' ? prop.description : undefined,
    type: localType,
    config: {
      notionPropertyId,
      notionType,
      notion: prop,
      options: mapSelectOptions(notionConfig),
      numberFormat: localType === 'number' ? localNumberFormat(notionConfig.format) : undefined,
      relationTargetNotionId: relationTargetNotionId(notionConfig),
      rollupRelationPropertyNotionId:
        localType === 'rollup' && typeof notionConfig.relation_property_id === 'string'
          ? notionConfig.relation_property_id
          : undefined,
      rollupTargetPropertyNotionId:
        localType === 'rollup' && typeof notionConfig.rollup_property_id === 'string'
          ? notionConfig.rollup_property_id
          : undefined,
      rollupFunction:
        localType === 'rollup' && typeof notionConfig.function === 'string'
          ? notionConfig.function
          : undefined,
      formula: localType === 'formula' ? formulaExpression : undefined,
      notionFormula: localType === 'formula' ? notionConfig : undefined,
      idPrefix: localType === 'unique_id' ? optionalString(notionConfig.prefix) ?? '' : undefined,
    },
    position: position + 1,
  };
}

function viewPropertyMappingsFromRawProperties(sourceProperties: Record<string, unknown>) {
  const propertyMappings = new Map<string, string>();
  for (const [nameOrId, rawProperty] of Object.entries(sourceProperties)) {
    const notionProperty = rawProperty && typeof rawProperty === 'object'
      ? rawProperty as Record<string, unknown>
      : {};
    const notionPropertyId = typeof notionProperty.id === 'string' && notionProperty.id.trim()
      ? notionProperty.id.trim()
      : nameOrId;
    setViewPropertyMapping(propertyMappings, notionPropertyId, notionPropertyId);
    setViewPropertyMapping(propertyMappings, nameOrId, notionPropertyId);
    if (typeof notionProperty.name === 'string' && notionProperty.name.trim()) {
      setViewPropertyMapping(propertyMappings, notionProperty.name.trim(), notionPropertyId);
    }
  }
  return propertyMappings;
}

function rawNotionPropertiesHaveTitle(sourceProperties: Record<string, unknown>) {
  return Object.values(sourceProperties).some((rawProperty) => {
    const notionProperty = asRecord(rawProperty);
    return typeof notionProperty?.type === 'string' && notionProperty.type.trim().toLowerCase() === 'title';
  });
}

function localViewType(value: unknown) {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (type === 'chart') return 'chart';
  if (['table', 'board', 'list', 'gallery', 'calendar', 'timeline'].includes(type)) return type;
  return 'table';
}

function createViewPropertyReferenceCollector(): ViewPropertyReferenceCollector {
  return {
    unresolved: [],
    seen: new Set(),
  };
}

function viewPropertyReference(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['property_id', 'propertyId', 'id', 'name', 'property_name', 'propertyName']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const key of ['property', 'property_ref', 'propertyRef']) {
    const nested = viewPropertyReference(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function decodedNotionPropertyReference(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && decoded !== value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function recordUnresolvedViewPropertyReference(
  collector: ViewPropertyReferenceCollector | undefined,
  source: string,
  value: unknown,
) {
  const property = viewPropertyReference(value);
  if (!collector || !property) return;
  const key = `${source}:${property}`;
  if (collector.seen.has(key)) return;
  collector.seen.add(key);
  collector.unresolved.push({ source, property });
}

function localViewPropertyId(propertyMappings: Map<string, string>, value: unknown) {
  const reference = viewPropertyReference(value);
  if (!reference) return undefined;
  return propertyMappings.get(reference) ?? propertyMappings.get(decodedNotionPropertyReference(reference) ?? '');
}

function setViewPropertyMapping(propertyMappings: Map<string, string>, key: unknown, localId: string) {
  if (typeof key !== 'string' || !key.trim()) return;
  const trimmed = key.trim();
  propertyMappings.set(trimmed, localId);
  const decoded = decodedNotionPropertyReference(trimmed);
  if (decoded) propertyMappings.set(decoded, localId);
}

function remappedViewPropertyId(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  source = 'view',
) {
  const localId = localViewPropertyId(propertyMappings, value);
  if (!localId) recordUnresolvedViewPropertyReference(collector, source, value);
  return localId;
}

function remappedViewPropertyCandidate(
  propertyMappings: Map<string, string>,
  candidates: unknown[],
  collector: ViewPropertyReferenceCollector | undefined,
  source: string,
) {
  let firstReference: unknown;
  for (const candidate of candidates) {
    if (viewPropertyReference(candidate) && firstReference === undefined) firstReference = candidate;
    const localId = localViewPropertyId(propertyMappings, candidate);
    if (localId) return localId;
  }
  recordUnresolvedViewPropertyReference(collector, source, firstReference);
  return undefined;
}

function remappedViewPropertyList(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  source = 'view property list',
) {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map((item) => remappedViewPropertyId(propertyMappings, item, collector, source))
    .filter((item): item is string => !!item);
  return ids.length ? ids : undefined;
}

function normalizedViewPropertyWidth(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['width', 'pixelWidth', 'pixel_width', 'size', 'value']) {
    const width = normalizedViewPropertyWidth(record[key]);
    if (width !== undefined) return width;
  }
  return undefined;
}

function reportUnsupportedPropertyWidth(
  report: ImportConversionReport | undefined,
  dataSourceId: string | undefined,
  view: Record<string, unknown>,
  property: string,
) {
  if (!report) return;
  const viewName = typeof view.name === 'string' && view.name.trim() ? view.name.trim() : 'Untitled';
  incrementReport(report, 'unsupportedViewSettings');
  pushReportIssue(report.warnings, {
    code: 'view_property_width_unsupported',
    notionId: notionObjectId(view) ?? dataSourceId,
    notionObject: 'view',
    message:
      `View "${viewName}" has a non-numeric property width for Notion property "${property}". ` +
      'The raw Notion view setting was preserved, but the local table width was left unset.',
  });
}

function remappedViewPropertyWidths(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  report?: ImportConversionReport,
  dataSourceId?: string,
  view?: Record<string, unknown>,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const localId = remappedViewPropertyId(propertyMappings, key, collector, 'property widths');
    if (!localId) continue;
    const width = normalizedViewPropertyWidth(item);
    if (width !== undefined) out[localId] = width;
    else if (view) reportUnsupportedPropertyWidth(report, dataSourceId, view, key);
  }
  return Object.keys(out).length ? out : undefined;
}

function tableCalculationToken(value: unknown) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['calculation', 'type', 'function', 'aggregate', 'aggregation', 'value', 'name']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

function normalizedTableCalculation(value: unknown) {
  const raw = tableCalculationToken(value);
  if (!raw) return undefined;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key || key === 'none') return undefined;
  const mapped = NOTION_TABLE_CALCULATION_ALIASES.get(key) ?? key;
  return LOCAL_TABLE_CALCULATIONS.has(mapped) ? mapped : undefined;
}

function reportUnsupportedTableCalculation(
  report: ImportConversionReport | undefined,
  dataSourceId: string | undefined,
  view: Record<string, unknown>,
  property: string,
  value: unknown,
) {
  if (!report) return;
  const raw = tableCalculationToken(value) ?? JSON.stringify(value);
  const viewName = typeof view.name === 'string' && view.name.trim() ? view.name.trim() : 'Untitled';
  incrementReport(report, 'unsupportedViewSettings');
  pushReportIssue(report.warnings, {
    code: 'view_table_calculation_unsupported',
    notionId: notionObjectId(view) ?? dataSourceId,
    notionObject: 'view',
    message:
      `View "${viewName}" uses unsupported table calculation "${raw}" for Notion property "${property}". ` +
      'The raw Notion view setting was preserved, but the local table summary was left unset.',
  });
}

function reportUnavailableViewPropertyLayout(
  report: ImportConversionReport | undefined,
  dataSourceId: string | undefined,
  view: Record<string, unknown>,
) {
  if (!report) return;
  const viewName = typeof view.name === 'string' && view.name.trim() ? view.name.trim() : 'Untitled';
  incrementReport(report, 'viewPropertyLayoutUnavailable');
  pushReportIssue(report.warnings, {
    code: 'view_property_layout_unavailable',
    notionId: notionObjectId(view) ?? dataSourceId,
    notionObject: 'view',
    message:
      `Notion API did not expose table property layout for view "${viewName}"` +
      `${dataSourceId ? ` in data source ${dataSourceId}` : ''}. ` +
      'Hanji imported the view with a title-first schema fallback and preserved the raw Notion view payload; ' +
      'column-order fidelity remains unconfirmed until Notion exposes this metadata or a reference capture supplies it.',
  });
}

function remappedViewTableCalculations(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  report?: ImportConversionReport,
  dataSourceId?: string,
  view?: Record<string, unknown>,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const localId = remappedViewPropertyId(propertyMappings, key, collector, 'table calculations');
    if (!localId) continue;
    const calculation = normalizedTableCalculation(item);
    if (calculation) out[localId] = calculation;
    else if (view) reportUnsupportedTableCalculation(report, dataSourceId, view, key, item);
  }
  return Object.keys(out).length ? out : undefined;
}

function firstDefinedSettingValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function pushUniqueId(list: string[], id: string) {
  if (!list.includes(id)) list.push(id);
}

function mergedViewPropertyRecord<T>(
  base: Record<string, T> | undefined,
  override: Record<string, T> | undefined,
) {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function viewPropertySettingEntries(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((setting) => ({ setting, fallback: undefined as string | undefined }));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).map(([fallback, setting]) => ({ setting, fallback }));
}

function viewPropertySettingCandidates(setting: unknown, fallback: string | undefined) {
  const record = asRecord(setting);
  if (!record) return [setting, fallback];
  return [
    record.propertyId,
    record.property_id,
    record.property,
    record.property_ref,
    record.propertyRef,
    record.id,
    record.name,
    record.property_name,
    record.propertyName,
    fallback,
  ];
}

function firstViewPropertyReferenceCandidate(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (viewPropertyReference(candidate)) return candidate;
  }
  return undefined;
}

function localViewPropertyIdFromCandidates(propertyMappings: Map<string, string>, candidates: unknown[]) {
  for (const candidate of candidates) {
    const localId = localViewPropertyId(propertyMappings, candidate);
    if (localId) return localId;
  }
  return undefined;
}

function isIgnoredStaleHiddenViewPropertySetting(setting: unknown) {
  const record = asRecord(setting);
  if (!record) return false;
  const visible = normalizedViewBoolean(
    firstDefinedSettingValue(record, ['visible', 'isVisible', 'is_visible', 'shown', 'show']),
  );
  const hidden = normalizedViewBoolean(
    firstDefinedSettingValue(record, ['hidden', 'isHidden', 'is_hidden']),
  );
  if (hidden !== true && visible !== false) return false;
  return !optionalString(record.property_name) && !optionalString(record.propertyName) && !optionalString(record.name);
}

function reportIgnoredStaleHiddenViewPropertySetting(
  report: ImportConversionReport | undefined,
  dataSourceId: string | undefined,
  view: Record<string, unknown> | undefined,
  reference: unknown,
) {
  if (!report) return;
  incrementReport(report, 'ignoredStaleHiddenViewPropertySettings');
  const property = viewPropertyReference(reference);
  if (!property) return;
  pushReportIssue(report.warnings, {
    code: 'stale_hidden_view_property_setting_ignored',
    notionId: view ? notionObjectId(view) ?? dataSourceId : dataSourceId,
    notionObject: 'view',
    message:
      `Notion view "${view && typeof view.name === 'string' ? view.name : 'Untitled'}" includes a hidden property setting ` +
      `for "${property}", but that property is not present in the data source schema or row snapshots. ` +
      'The raw Notion view payload was preserved and the stale hidden column setting was ignored.',
  }, 20);
}

export function remappedViewPropertySettings(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  report?: ImportConversionReport,
  dataSourceId?: string,
  view?: Record<string, unknown>,
): RemappedViewPropertySettings | undefined {
  const entries = viewPropertySettingEntries(value);
  if (!entries.length) return undefined;

  const visibleProperties: string[] = [];
  const hiddenProperties: string[] = [];
  const propertyOrder: string[] = [];
  const wrappedColumns: string[] = [];
  const propertyWidths: Record<string, number> = {};
  const tableCalculations: Record<string, string> = {};

  for (const { setting, fallback } of entries) {
    const candidates = viewPropertySettingCandidates(setting, fallback);
    const reference = firstViewPropertyReferenceCandidate(candidates);
    const localId = localViewPropertyIdFromCandidates(propertyMappings, candidates);
    if (!localId) {
      if (isIgnoredStaleHiddenViewPropertySetting(setting)) {
        reportIgnoredStaleHiddenViewPropertySetting(report, dataSourceId, view, reference);
        continue;
      }
      recordUnresolvedViewPropertyReference(collector, 'property settings', reference);
      continue;
    }
    pushUniqueId(propertyOrder, localId);

    const record = asRecord(setting);
    if (!record) continue;

    const hidden = normalizedViewBoolean(
      firstDefinedSettingValue(record, ['hidden', 'isHidden', 'is_hidden']),
    );
    const visible = normalizedViewBoolean(
      firstDefinedSettingValue(record, ['visible', 'isVisible', 'is_visible', 'shown', 'show']),
    );
    if (hidden === true || visible === false) pushUniqueId(hiddenProperties, localId);
    else if (visible === true || hidden === false) pushUniqueId(visibleProperties, localId);

    const widthSource = firstDefinedSettingValue(record, [
      'width',
      'pixelWidth',
      'pixel_width',
      'columnWidth',
      'column_width',
      'size',
    ]);
    if (widthSource !== undefined) {
      const width = normalizedViewPropertyWidth(widthSource);
      if (width !== undefined) propertyWidths[localId] = width;
      else if (view) {
        reportUnsupportedPropertyWidth(
          report,
          dataSourceId,
          view,
          viewPropertyReference(reference) ?? localId,
        );
      }
    }

    const calculationSource = firstDefinedSettingValue(record, [
      'calculation',
      'table_calculation',
      'tableCalculation',
      'summary',
      'aggregate',
      'aggregation',
    ]);
    if (calculationSource !== undefined) {
      const calculation = normalizedTableCalculation(calculationSource);
      if (calculation) tableCalculations[localId] = calculation;
      else if (view) {
        reportUnsupportedTableCalculation(
          report,
          dataSourceId,
          view,
          viewPropertyReference(reference) ?? localId,
          calculationSource,
        );
      }
    }

    const wrapped = normalizedViewBoolean(
      firstDefinedSettingValue(record, ['wrap', 'wrapped', 'wrap_cells', 'wrapCells']),
    );
    if (wrapped === true) pushUniqueId(wrappedColumns, localId);
  }

  return {
    visibleProperties: visibleProperties.length ? visibleProperties : undefined,
    hiddenProperties: hiddenProperties.length ? hiddenProperties : undefined,
    propertyOrder: propertyOrder.length ? propertyOrder : undefined,
    propertyWidths: Object.keys(propertyWidths).length ? propertyWidths : undefined,
    tableCalculations: Object.keys(tableCalculations).length ? tableCalculations : undefined,
    wrappedColumns: wrappedColumns.length ? wrappedColumns : undefined,
  };
}

function nestedViewConfigSources(source: Record<string, unknown>, viewType?: string) {
  const out: Record<string, unknown>[] = [source];
  const push = (value: unknown) => {
    const record = asRecord(value);
    if (record && !out.includes(record)) out.push(record);
  };
  const pushViewTypeWrappers = (record: Record<string, unknown> | undefined) => {
    if (!record || !viewType) return;
    push(record[viewType]);
    push(record[`${viewType}_layout`]);
    push(record[`${viewType}Layout`]);
    push(record[`${viewType}_format`]);
    push(record[`${viewType}Format`]);
    push(record[`${viewType}_view`]);
    push(record[`${viewType}View`]);
  };

  pushViewTypeWrappers(source);
  push(source.settings);
  push(source.options);
  push(source.config);
  push(source.configuration);
  push(source.query);
  push(source.format);
  if (viewType) {
    const configuration = asRecord(source.configuration);
    pushViewTypeWrappers(configuration);
    const query = asRecord(source.query);
    pushViewTypeWrappers(query);
    const format = asRecord(source.format);
    pushViewTypeWrappers(format);
  }
  return out;
}

function viewConfigSources(view: Record<string, unknown>) {
  const type = typeof view.type === 'string' ? view.type.trim().toLowerCase() : undefined;
  const sources: Record<string, unknown>[] = [];
  const pushAll = (records: Record<string, unknown>[]) => {
    for (const record of records) {
      if (!sources.includes(record)) sources.push(record);
    }
  };

  pushAll(nestedViewConfigSources(view, type));
  const query = asRecord(view.query);
  if (query) pushAll(nestedViewConfigSources(query, type));
  const configuration = asRecord(view.configuration);
  if (configuration) pushAll(nestedViewConfigSources(configuration, type));
  const layout = asRecord(view.layout);
  if (layout) pushAll(nestedViewConfigSources(layout, type));
  const format = asRecord(view.format);
  if (format) pushAll(nestedViewConfigSources(format, type));
  return sources;
}

function firstDefinedViewValue(view: Record<string, unknown>, keys: string[]) {
  for (const source of viewConfigSources(view)) {
    for (const key of keys) {
      if (source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

function normalizedViewRowHeight(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['short', 'compact', 'small'].includes(normalized)) return 'short';
  if (['medium', 'normal', 'default'].includes(normalized)) return 'medium';
  if (['tall', 'large'].includes(normalized)) return 'tall';
  return undefined;
}

function normalizedViewCardSize(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['small', 'medium', 'large'].includes(normalized)) return normalized;
  return undefined;
}

function normalizedViewOpenPageIn(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['side', 'side_peek', 'side peek', 'peek_side'].includes(normalized)) return 'side';
  if (['center', 'center_peek', 'center peek', 'modal', 'peek_center'].includes(normalized)) return 'center';
  if (['full', 'full_page', 'full page', 'page'].includes(normalized)) return 'full';
  return undefined;
}

function normalizedTimelineZoom(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['day', 'week', 'month'].includes(normalized)) return normalized;
  return undefined;
}

function normalizedViewBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function viewSortItems(value: unknown) {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  if (Array.isArray(record.sorts)) return record.sorts;
  if (Array.isArray(record.sort)) return record.sort;
  if (viewPropertyReference(record)) return [record];
  return Object.entries(record).map(([property, sort]) => {
    const sortRecord = asRecord(sort);
    if (sortRecord && viewPropertyReference(sortRecord)) return sortRecord;
    const direction = sortRecord
      ? sortRecord.direction ?? sortRecord.sort ?? sortRecord.order ?? sortRecord.value
      : sort;
    return { property, direction };
  });
}

export function remappedViewSorts(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
) {
  const source = viewSortItems(value);
  if (!source) return undefined;
  const sorts = source
    .map((item) => {
      const record = asRecord(item);
      if (!record) return undefined;
      const localId = remappedViewPropertyCandidate(
        propertyMappings,
        [record.propertyId, record.property_id, record.property, record.property_ref, record.propertyRef, record.id, record.name],
        collector,
        'sort',
      );
      if (!localId) return undefined;
      const direction = String(record.direction ?? record.sort ?? '').toLowerCase().includes('desc') ? 'desc' : 'asc';
      return { propertyId: localId, direction };
    })
    .filter((item): item is { propertyId: string; direction: 'asc' | 'desc' } => !!item);
  return sorts.length ? sorts : undefined;
}

function localFilterOperator(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const map: Record<string, string> = {
    equals: 'equals',
    does_not_equal: 'does_not_equal',
    does_not_contain: 'does_not_contain',
    contains: 'contains',
    is_empty: 'is_empty',
    is_not_empty: 'is_not_empty',
    greater_than: 'greater_than',
    less_than: 'less_than',
    greater_than_or_equal_to: 'greater_than',
    less_than_or_equal_to: 'less_than',
    on_or_before: 'on_or_before',
    on_or_after: 'on_or_after',
    before: 'on_or_before',
    after: 'on_or_after',
    on_or_before_date: 'on_or_before',
    on_or_after_date: 'on_or_after',
  };
  return map[normalized];
}

function notionFilterCondition(
  record: Record<string, unknown>,
): { operator?: string; value?: unknown } {
  if (typeof record.operator === 'string') {
    return {
      operator: localFilterOperator(record.operator),
      value: record.value,
    };
  }
  for (const [key, value] of Object.entries(record)) {
    if (['property', 'property_id', 'propertyId', 'id', 'name', 'type'].includes(key)) continue;
    const directOperator = localFilterOperator(key);
    if (directOperator) {
      return {
        operator: directOperator,
        value,
      };
    }
    const condition = asRecord(value);
    if (!condition) continue;
    const nested = notionFilterCondition(condition);
    if (nested.operator) return nested;
    for (const [operator, conditionValue] of Object.entries(condition)) {
      return {
        operator: localFilterOperator(operator),
        value: conditionValue,
      };
    }
  }
  return {};
}

function notionPageIdFromFilterValue(value: unknown) {
  const pageId = optionalString(value);
  if (!pageId) return undefined;
  const normalized = normalizedNotionId(pageId);
  return /^[0-9a-f]{32}$/.test(normalized) ? pageId : undefined;
}

function collectNotionPageIdsFromFilterValue(value: unknown, pageIds: Set<string>) {
  const pageId = notionPageIdFromFilterValue(value);
  if (pageId) {
    pageIds.add(pageId);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectNotionPageIdsFromFilterValue(item, pageIds);
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  for (const candidate of Object.values(record)) {
    collectNotionPageIdsFromFilterValue(candidate, pageIds);
  }
}

function collectNotionPageIdsFromViewFilterLeaf(
  leaf: unknown,
  sourceProperties: Record<string, unknown>,
  pageIds: Set<string>,
) {
  const record = asRecord(leaf);
  if (!record) return;
  const propertyReference = viewPropertyReference(record);
  if (!propertyReference) return;
  const sourceProperty = asRecord(notionPropertyFromRawProperties(sourceProperties, propertyReference));
  const sourceType = optionalString(sourceProperty?.type)?.toLowerCase();
  if (sourceType !== 'relation' && sourceType !== 'rollup') return;

  const condition = notionFilterCondition(record);
  if (!condition.operator || condition.value === undefined) return;
  collectNotionPageIdsFromFilterValue(condition.value, pageIds);
}

function collectNotionPageIdsFromPropertyKeyedViewFilters(
  value: unknown,
  sourceProperties: Record<string, unknown>,
  pageIds: Set<string>,
) {
  const record = asRecord(value);
  if (!record) return;
  for (const [property, condition] of Object.entries(record)) {
    if (['filter', 'filters', 'and', 'or', 'type', 'operator', 'value'].includes(property)) continue;
    const conditionRecord = asRecord(condition);
    const leaf = conditionRecord
      ? { property, ...conditionRecord }
      : { property, operator: 'equals', value: condition };
    collectNotionPageIdsFromViewFilterLeaf(leaf, sourceProperties, pageIds);
  }
}

function collectNotionPageIdsFromViewFilterTerm(
  term: unknown,
  sourceProperties: Record<string, unknown>,
  pageIds: Set<string>,
) {
  const record = asRecord(term);
  if (!record) return;

  const andItems = Array.isArray(record.and) ? record.and : undefined;
  const orItems = Array.isArray(record.or) ? record.or : undefined;
  const children = andItems ?? orItems;
  if (children) {
    for (const child of children) {
      collectNotionPageIdsFromViewFilterTerm(child, sourceProperties, pageIds);
    }
    return;
  }

  collectNotionPageIdsFromViewFilterLeaf(record, sourceProperties, pageIds);
  collectNotionPageIdsFromPropertyKeyedViewFilters(record, sourceProperties, pageIds);
}

function notionPageIdsFromViewFilters(
  view: Record<string, unknown>,
  sourceProperties: Record<string, unknown>,
) {
  const pageIds = new Set<string>();
  const filterSource = firstDefinedViewValue(view, VIEW_FILTER_KEYS);
  const quickFiltersSource = firstDefinedViewValue(view, VIEW_QUICK_FILTER_KEYS);
  const sources = [filterSource, quickFiltersSource].filter((source) => source !== undefined);

  for (const source of sources) {
    const record = asRecord(source);
    const list = Array.isArray(source)
      ? source
      : Array.isArray(record?.filters)
        ? record.filters
        : Array.isArray(record?.filter)
          ? record.filter
          : undefined;
    if (list) {
      for (const term of list) collectNotionPageIdsFromViewFilterTerm(term, sourceProperties, pageIds);
      continue;
    }
    collectNotionPageIdsFromViewFilterTerm(source, sourceProperties, pageIds);
  }

  return Array.from(pageIds);
}

function remappedPropertyKeyedFilterList(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  localPropertiesById?: Map<string, DbProperty>,
) {
  const record = asRecord(value);
  if (!record) return undefined;
  const filters: Record<string, unknown>[] = [];
  for (const [property, condition] of Object.entries(record)) {
    if (['filter', 'filters', 'and', 'or', 'type', 'operator', 'value'].includes(property)) continue;
    if (!localViewPropertyId(propertyMappings, property)) {
      recordUnresolvedViewPropertyReference(collector, 'filter', property);
      continue;
    }
    const conditionRecord = asRecord(condition);
    const leafInput = conditionRecord
      ? { property, ...conditionRecord }
      : { property, operator: 'equals', value: condition };
    const leaf = remappedViewFilterLeaf(propertyMappings, leafInput, collector, localPropertiesById);
    if (leaf) filters.push(leaf);
  }
  return filters.length ? filters : undefined;
}

function localSelectFilterValue(property: DbProperty | undefined, value: unknown) {
  if (!property || !['select', 'status', 'multi_select'].includes(property.type)) return value;
  const normalizeOne = (item: unknown) => {
    const raw = optionalString(item);
    if (!raw) return item;
    const lower = raw.toLowerCase();
    const options = Array.isArray(property.config?.options) ? property.config.options : [];
    for (const option of options) {
      const record = asRecord(option);
      const id = optionalString(record?.id);
      const name = optionalString(record?.name);
      if (id?.toLowerCase() === lower || name?.toLowerCase() === lower) return id ?? raw;
    }
    return item;
  };
  return Array.isArray(value) ? value.map(normalizeOne) : normalizeOne(value);
}

const VIEW_NAME_FILTER_EXCLUDED_LABELS = new Set([
  'all',
  'allitems',
  'allpages',
  'allprojects',
  'alltasks',
  'default',
  'defaultview',
  'table',
  '전체',
  '전체보기',
  '전체테이블',
]);

function normalizedViewFilterLabel(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value
      .trim()
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s()[\]{}.,:;'"`~!@#$%^&*+=|\\/?<>_\-·•]+/g, '')
    : '';
}

function optionViewNameAliases(name: string) {
  const aliases = new Set<string>();
  const full = normalizedViewFilterLabel(name);
  if (full) aliases.add(full);

  const parenthetical = name.trim().match(/^(.+?)\s*[\(（]\s*(.+?)\s*[\)）]\s*$/);
  if (parenthetical) {
    const outer = parenthetical[1].trim();
    const inner = parenthetical[2].trim();
    const outerLabel = normalizedViewFilterLabel(outer);
    const innerLabel = normalizedViewFilterLabel(inner);
    if (outerLabel && innerLabel) {
      aliases.add(`${innerLabel}${outerLabel}`);
      aliases.add(`${outerLabel}${innerLabel}`);
      const outerWithoutTaxPrefix = normalizedViewFilterLabel(
        outer
          .replace(/^세금\s*/u, '')
          .replace(/^tax\s+/iu, ''),
      );
      if (outerWithoutTaxPrefix) aliases.add(`${innerLabel}${outerWithoutTaxPrefix}`);
    }
  }

  return aliases;
}

function inferredViewNameSelectFilter(viewName: string, properties: DbProperty[]) {
  const viewLabel = normalizedViewFilterLabel(viewName);
  if (!viewLabel || VIEW_NAME_FILTER_EXCLUDED_LABELS.has(viewLabel)) return undefined;

  const matches: Array<{ property: DbProperty; optionId: string; optionName: string; exact: boolean }> = [];
  for (const property of properties) {
    if (!['select', 'status', 'multi_select'].includes(property.type)) continue;
    const options = Array.isArray(property.config?.options) ? property.config.options : [];
    for (const option of options) {
      const record = asRecord(option);
      const optionId = optionalString(record?.id);
      const optionName = optionalString(record?.name);
      if (!optionId || !optionName) continue;
      const exact = normalizedViewFilterLabel(optionName) === viewLabel;
      if (exact || optionViewNameAliases(optionName).has(viewLabel)) {
        matches.push({ property, optionId, optionName, exact });
      }
    }
  }

  const exactMatches = matches.filter((match) => match.exact);
  const candidates = exactMatches.length ? exactMatches : matches;
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  return {
    filterGroup: {
      conjunction: 'and',
      filters: [
        {
          propertyId: candidate.property.id,
          operator: 'equals',
          value: candidate.optionId,
        },
      ],
      groups: [],
    },
    metadata: {
      inferredFrom: 'view_name_select_option',
      propertyId: candidate.property.id,
      propertyName: candidate.property.name,
      optionName: candidate.optionName,
    },
  };
}

function remappedViewFilterLeaf(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  localPropertiesById?: Map<string, DbProperty>,
) {
  const record = asRecord(value);
  if (!record) return undefined;
  const localId = remappedViewPropertyCandidate(
    propertyMappings,
    [record.propertyId, record.property_id, record.property, record.property_ref, record.propertyRef, record.id, record.name],
    collector,
    'filter',
  );
  if (!localId) return undefined;
  const condition = notionFilterCondition(record);
  if (!condition.operator) return undefined;
  return condition.operator === 'is_empty' || condition.operator === 'is_not_empty'
    ? { propertyId: localId, operator: condition.operator }
    : {
      propertyId: localId,
      operator: condition.operator,
      value: localSelectFilterValue(localPropertiesById?.get(localId), condition.value),
    };
}

export function remappedViewFilterGroup(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  localPropertiesById?: Map<string, DbProperty>,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const children = Array.isArray(record.and)
    ? { conjunction: 'and' as const, items: record.and }
    : Array.isArray(record.or)
      ? { conjunction: 'or' as const, items: record.or }
      : undefined;

  if (!children) {
    const leaf = remappedViewFilterLeaf(propertyMappings, record, collector, localPropertiesById);
    if (leaf) return { conjunction: 'and', filters: [leaf], groups: [] };
    const filters = remappedPropertyKeyedFilterList(propertyMappings, record, collector, localPropertiesById);
    return filters ? { conjunction: 'and', filters, groups: [] } : undefined;
  }

  const filters: Record<string, unknown>[] = [];
  const groups: Record<string, unknown>[] = [];
  for (const child of children.items) {
    const childRecord = asRecord(child);
    if (!childRecord) continue;
    if (Array.isArray(childRecord.and) || Array.isArray(childRecord.or)) {
      const group = remappedViewFilterGroup(propertyMappings, childRecord, collector, localPropertiesById);
      if (group) groups.push(group);
      continue;
    }
    const leaf = remappedViewFilterLeaf(propertyMappings, childRecord, collector, localPropertiesById);
    if (leaf) filters.push(leaf);
  }

  if (filters.length === 0 && groups.length === 0) return undefined;
  return { conjunction: children.conjunction, filters, groups };
}

export function remappedViewFilterList(
  propertyMappings: Map<string, string>,
  value: unknown,
  collector?: ViewPropertyReferenceCollector,
  localPropertiesById?: Map<string, DbProperty>,
) {
  const record = asRecord(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record?.filters)
      ? record.filters
      : Array.isArray(record?.filter)
        ? record.filter
      : undefined;
  if (source) {
    const filters = source
      .map((item) => {
        const record = asRecord(item);
        if (!record) return undefined;
        if (Array.isArray(record.and) || Array.isArray(record.or)) {
          return remappedViewFilterGroup(propertyMappings, record, collector, localPropertiesById);
        }
        return remappedViewFilterLeaf(propertyMappings, record, collector, localPropertiesById);
      })
      .filter((item): item is Record<string, unknown> => !!item);
    return filters.length ? filters : undefined;
  }
  return remappedPropertyKeyedFilterList(propertyMappings, value, collector, localPropertiesById);
}

function dbViewFromNotion(
  databaseId: string,
  view: Record<string, unknown>,
  position: number,
  propertyMappings: Map<string, string> = new Map(),
  report?: ImportConversionReport,
  dataSourceId?: string,
  localProperties: DbProperty[] = [],
): DbView {
  const notionType = typeof view.type === 'string' ? view.type.trim().toLowerCase() : undefined;
  const type = localViewType(notionType);
  const unsupportedNotionViewType =
    notionType && !SUPPORTED_NOTION_VIEW_TYPES.has(notionType) ? notionType : undefined;
  const collector = createViewPropertyReferenceCollector();
  const filterSource = firstDefinedViewValue(view, VIEW_FILTER_KEYS);
  const sortsSource = firstDefinedViewValue(view, VIEW_SORT_KEYS);
  const visiblePropertiesSource = firstDefinedViewValue(view, VIEW_VISIBLE_PROPERTY_KEYS);
  const hiddenPropertiesSource = firstDefinedViewValue(view, VIEW_HIDDEN_PROPERTY_KEYS);
  const propertyOrderSource = firstDefinedViewValue(view, VIEW_PROPERTY_ORDER_KEYS);
  const propertySettingsSource = firstDefinedViewValue(view, VIEW_PROPERTY_SETTING_KEYS);
  const propertyWidthsSource = firstDefinedViewValue(view, VIEW_PROPERTY_WIDTH_KEYS);
  const tableCalculationsSource = firstDefinedViewValue(view, VIEW_TABLE_CALCULATION_KEYS);
  const wrappedColumnsSource = firstDefinedViewValue(view, VIEW_WRAPPED_COLUMN_KEYS);
  const quickFiltersSource = firstDefinedViewValue(view, VIEW_QUICK_FILTER_KEYS);
  const groupBySource = firstDefinedViewValue(view, VIEW_GROUP_BY_KEYS);
  const subGroupBySource = firstDefinedViewValue(view, VIEW_SUBGROUP_BY_KEYS);
  const calendarBySource = firstDefinedViewValue(view, VIEW_CALENDAR_BY_KEYS);
  const timelineBySource = firstDefinedViewValue(view, VIEW_TIMELINE_BY_KEYS);
  const timelineEndBySource = firstDefinedViewValue(view, VIEW_TIMELINE_END_BY_KEYS);
  const coverPropertySource = firstDefinedViewValue(view, VIEW_COVER_PROPERTY_KEYS);
  const dependencyPropertySource = firstDefinedViewValue(view, VIEW_DEPENDENCY_PROPERTY_KEYS);
  const localPropertiesById = new Map(localProperties.map((property) => [property.id, property]));
  const filterGroup = remappedViewFilterGroup(propertyMappings, filterSource, collector, localPropertiesById);
  const sorts = remappedViewSorts(propertyMappings, sortsSource, collector);
  const propertySettings = remappedViewPropertySettings(
    propertyMappings,
    propertySettingsSource,
    collector,
    report,
    dataSourceId,
    view,
  );
  const visibleProperties = remappedViewPropertyList(
    propertyMappings,
    visiblePropertiesSource,
    collector,
    'visible properties',
  ) ?? propertySettings?.visibleProperties;
  const hiddenProperties = remappedViewPropertyList(
    propertyMappings,
    hiddenPropertiesSource,
    collector,
    'hidden properties',
  ) ?? propertySettings?.hiddenProperties;
  const remappedPropertyOrder = remappedViewPropertyList(
    propertyMappings,
    propertyOrderSource,
    collector,
    'property order',
  );
  const fallbackPropertyOrder = fallbackNotionViewPropertyOrder(localProperties, type);
  const propertyOrder = remappedPropertyOrder ?? propertySettings?.propertyOrder ?? fallbackPropertyOrder;
  if (!remappedPropertyOrder && !propertySettings?.propertyOrder && fallbackPropertyOrder) {
    reportUnavailableViewPropertyLayout(report, dataSourceId, view);
  }
  const propertyWidths = mergedViewPropertyRecord(
    propertySettings?.propertyWidths,
    remappedViewPropertyWidths(
      propertyMappings,
      propertyWidthsSource,
      collector,
      report,
      dataSourceId,
      view,
    ),
  );
  const tableCalculations = mergedViewPropertyRecord(
    propertySettings?.tableCalculations,
    remappedViewTableCalculations(
      propertyMappings,
      tableCalculationsSource,
      collector,
      report,
      dataSourceId,
      view,
    ),
  );
  const wrappedColumns = remappedViewPropertyList(
    propertyMappings,
    wrappedColumnsSource,
    collector,
    'wrapped columns',
  ) ?? propertySettings?.wrappedColumns;
  const groupBy = remappedViewPropertyId(propertyMappings, groupBySource, collector, 'group');
  const subGroupBy = remappedViewPropertyId(propertyMappings, subGroupBySource, collector, 'subgroup');
  const calendarBy = remappedViewPropertyId(propertyMappings, calendarBySource, collector, 'calendar');
  const timelineBy = remappedViewPropertyId(propertyMappings, timelineBySource, collector, 'timeline');
  const timelineEndBy = remappedViewPropertyId(propertyMappings, timelineEndBySource, collector, 'timeline end');
  const coverProperty = remappedViewPropertyId(propertyMappings, coverPropertySource, collector, 'cover');
  const dependencyProperty = remappedViewPropertyId(
    propertyMappings,
    dependencyPropertySource,
    collector,
    'dependency',
  );
  const rowHeight = normalizedViewRowHeight(firstDefinedViewValue(view, VIEW_ROW_HEIGHT_KEYS));
  const cardSize = normalizedViewCardSize(firstDefinedViewValue(view, VIEW_CARD_SIZE_KEYS));
  const openPageIn = normalizedViewOpenPageIn(firstDefinedViewValue(view, VIEW_OPEN_PAGE_IN_KEYS));
  const timelineZoom = normalizedTimelineZoom(firstDefinedViewValue(view, VIEW_TIMELINE_ZOOM_KEYS));
  const wrap = normalizedViewBoolean(firstDefinedViewValue(view, VIEW_WRAP_KEYS));
  const quickFilters = remappedViewFilterList(
    propertyMappings,
    quickFiltersSource,
    collector,
    localPropertiesById,
  );
  const quickFilterGroup = quickFilters ? importedFilterGroupFromTerms(quickFilters) : undefined;
  const effectiveFilterGroup = mergeImportedFilterGroups(filterGroup, quickFilterGroup);
  const inferredFilter = !effectiveFilterGroup
    ? inferredViewNameSelectFilter(typeof view.name === 'string' ? view.name : '', localProperties)
    : undefined;
  if (inferredFilter && report) incrementReport(report, 'inferredViewNameFilters');
  reportUnresolvedViewPropertyReferences(report, dataSourceId, view, collector);
  return {
    id: newId(),
    databaseId,
    name: typeof view.name === 'string' && view.name.trim() ? view.name.trim() : `View ${position + 1}`,
    type,
    config: {
      notionViewId: typeof view.id === 'string' ? view.id : undefined,
      notionType,
      unsupportedNotionViewType,
      notion: view,
      notionFilter: filterSource,
      notionSorts: sortsSource,
      notionVisibleProperties: visiblePropertiesSource,
      notionHiddenProperties: hiddenPropertiesSource,
      notionPropertyOrder: propertyOrderSource,
      notionPropertySettings: propertySettingsSource,
      notionQuickFilters: quickFiltersSource,
      filterGroup: effectiveFilterGroup ?? inferredFilter?.filterGroup,
      inferredFilter: inferredFilter?.metadata,
      sorts,
      visibleProperties,
      hiddenProperties,
      propertyOrder,
      propertyWidths,
      tableCalculations,
      wrappedColumns,
      groupBy,
      subGroupBy,
      calendarBy,
      timelineBy,
      timelineEndBy,
      coverProperty,
      dependencyProperty,
      rowHeight,
      cardSize,
      openPageIn,
      timelineZoom,
      wrap,
      unresolvedPropertyReferences: collector.unresolved.length ? collector.unresolved : undefined,
    },
    position: position + 1,
  };
}

function fallbackNotionViewPropertyOrder(properties: DbProperty[], viewType: string) {
  if (viewType !== 'table' || properties.length === 0) return undefined;
  const title = properties.find((property) => property.type === 'title');
  if (!title) return undefined;
  return [title.id, ...properties.filter((property) => property.id !== title.id).map((property) => property.id)];
}

function inspectViewPropertyReferences(
  report: ImportConversionReport,
  dataSourceId: string,
  view: Record<string, unknown>,
  propertyMappings: Map<string, string>,
  sourceProperties: Record<string, unknown> = {},
) {
  const collector = createViewPropertyReferenceCollector();
  const propertyOrderSource = firstDefinedViewValue(view, VIEW_PROPERTY_ORDER_KEYS);
  const propertySettingsSource = firstDefinedViewValue(view, VIEW_PROPERTY_SETTING_KEYS);
  remappedViewFilterGroup(propertyMappings, firstDefinedViewValue(view, VIEW_FILTER_KEYS), collector);
  remappedViewFilterList(propertyMappings, firstDefinedViewValue(view, VIEW_QUICK_FILTER_KEYS), collector);
  remappedViewSorts(propertyMappings, firstDefinedViewValue(view, VIEW_SORT_KEYS), collector);
  remappedViewPropertyList(
    propertyMappings,
    firstDefinedViewValue(view, VIEW_VISIBLE_PROPERTY_KEYS),
    collector,
    'visible properties',
  );
  remappedViewPropertyList(
    propertyMappings,
    firstDefinedViewValue(view, VIEW_HIDDEN_PROPERTY_KEYS),
    collector,
    'hidden properties',
  );
  const remappedPropertyOrder = remappedViewPropertyList(
    propertyMappings,
    propertyOrderSource,
    collector,
    'property order',
  );
  const propertySettings = remappedViewPropertySettings(
    propertyMappings,
    propertySettingsSource,
    collector,
    report,
    dataSourceId,
    view,
  );
  if (
    localViewType(view.type) === 'table' &&
    !remappedPropertyOrder &&
    !propertySettings?.propertyOrder &&
    rawNotionPropertiesHaveTitle(sourceProperties)
  ) {
    reportUnavailableViewPropertyLayout(report, dataSourceId, view);
  }
  remappedViewPropertyWidths(
    propertyMappings,
    firstDefinedViewValue(view, VIEW_PROPERTY_WIDTH_KEYS),
    collector,
    report,
    dataSourceId,
    view,
  );
  remappedViewTableCalculations(
    propertyMappings,
    firstDefinedViewValue(view, VIEW_TABLE_CALCULATION_KEYS),
    collector,
    report,
    dataSourceId,
    view,
  );
  remappedViewPropertyList(
    propertyMappings,
    firstDefinedViewValue(view, VIEW_WRAPPED_COLUMN_KEYS),
    collector,
    'wrapped columns',
  );
  remappedViewPropertyId(propertyMappings, firstDefinedViewValue(view, VIEW_GROUP_BY_KEYS), collector, 'group');
  remappedViewPropertyId(propertyMappings, firstDefinedViewValue(view, VIEW_SUBGROUP_BY_KEYS), collector, 'subgroup');
  remappedViewPropertyId(propertyMappings, firstDefinedViewValue(view, VIEW_CALENDAR_BY_KEYS), collector, 'calendar');
  remappedViewPropertyId(propertyMappings, firstDefinedViewValue(view, VIEW_TIMELINE_BY_KEYS), collector, 'timeline');
  remappedViewPropertyId(propertyMappings, firstDefinedViewValue(view, VIEW_TIMELINE_END_BY_KEYS), collector, 'timeline end');
  remappedViewPropertyId(propertyMappings, firstDefinedViewValue(view, VIEW_COVER_PROPERTY_KEYS), collector, 'cover');
  remappedViewPropertyId(
    propertyMappings,
    firstDefinedViewValue(view, VIEW_DEPENDENCY_PROPERTY_KEYS),
    collector,
    'dependency',
  );
  reportUnresolvedViewPropertyReferences(report, dataSourceId, view, collector);
}

function rawTemplatesFromSnapshot(snapshot: Record<string, unknown> | undefined) {
  const sources = [
    snapshot,
    asRecord(snapshot?.dataSource),
    asRecord(snapshot?.database),
  ];
  const templates: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source) continue;
    for (const key of ['templates', 'database_templates', 'databaseTemplates', 'template_pages', 'templatePages']) {
      const value = source[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const record = asRecord(item);
        if (!record) continue;
        const id = notionObjectId(record);
        const dedupeKey = id ?? `${templates.length}:${JSON.stringify(record).slice(0, 128)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        templates.push(record);
      }
    }
  }

  return templates;
}

function templateTitleFromNotion(template: Record<string, unknown>) {
  const explicit = optionalString(template.title) ?? optionalString(template.default_title) ?? optionalString(template.defaultTitle);
  if (explicit) return explicit;
  const richTitle = textFromRich(template.title);
  if (richTitle) return richTitle;
  const pageTitle = notionTitle(template);
  return pageTitle && pageTitle !== 'Untitled' ? pageTitle : optionalString(template.name);
}

function templateNameFromNotion(template: Record<string, unknown>, position: number) {
  return (
    optionalString(template.name) ??
    textFromRich(template.name) ??
    templateTitleFromNotion(template) ??
    `Imported template ${position + 1}`
  );
}

function templateIconFromNotion(template: Record<string, unknown>) {
  const icon = asRecord(template.icon);
  if (!icon) return optionalString(template.icon);
  const emoji = optionalString(icon.emoji);
  if (optionalString(icon.type) === 'emoji' && emoji) return emoji;
  return notionFileUrl(icon);
}

function notionBlockChildren(block: Record<string, unknown>) {
  const type = optionalString(block.type) ?? '';
  const payload = type ? asRecord(block[type]) : undefined;
  for (const value of [block.children, block.childBlocks, payload?.children, payload?.childBlocks]) {
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
    }
  }
  return [];
}

function wrappedTabChildBlock(child: Record<string, unknown>, index: number): Record<string, unknown> {
  if (child.type === 'paragraph') return child;
  const childId = notionObjectId(child);
  return {
    id: childId ? `${childId}-tab-label` : undefined,
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ plain_text: `Imported tab ${index + 1}` }],
      children: [child],
    },
    children: [child],
  };
}

function tabBlockChildrenForImport(
  block: Record<string, unknown>,
  report: ImportConversionReport | undefined,
  item: NotionImportItem,
) {
  const children = notionBlockChildren(block);
  if (block.type !== 'tab') return children;
  return children.map((child, index) => {
    if (child.type === 'paragraph') return child;
    if (report) {
      incrementReport(report, 'wrappedTabChildren');
      pushReportIssue(report.warnings, {
        code: 'tab_child_wrapped',
        notionId: notionObjectId(child) ?? item.notionId,
        notionObject: 'block',
        message: `A direct child of Notion tab "${item.title || item.notionId}" was "${child.type || 'unknown'}" instead of paragraph, so it was wrapped in an imported tab label to preserve visible content.`,
      });
    }
    return wrappedTabChildBlock(child, index);
  });
}

function templateBlockChildren(block: Record<string, unknown>) {
  return notionBlockChildren(block);
}

function flattenNotionBlocks(blocks: Record<string, unknown>[]) {
  const out: Record<string, unknown>[] = [];
  const visit = (block: Record<string, unknown>) => {
    out.push(block);
    for (const child of notionBlockChildren(block)) visit(child);
  };
  for (const block of blocks) visit(block);
  return out;
}

function flattenImportablePageBlocksForPlan(blocks: Record<string, unknown>[]) {
  const out: Record<string, unknown>[] = [];
  const visit = (block: Record<string, unknown>) => {
    out.push(block);
    if (block.type === 'template') return;
    for (const child of notionBlockChildren(block)) {
      if (block.type === 'table' && child.type === 'table_row') continue;
      visit(child);
    }
  };
  for (const block of blocks) visit(block);
  return out;
}

function nestedNotionBlockIds(blocks: Record<string, unknown>[]) {
  const ids = new Set<string>();
  const visit = (block: Record<string, unknown>) => {
    for (const child of notionBlockChildren(block)) {
      const id = notionObjectId(child);
      if (id) ids.add(id);
      visit(child);
    }
  };
  for (const block of blocks) visit(block);
  return ids;
}

function templateBlockFromNotion(block: Record<string, unknown>, position: number): TemplateBlock {
  const local = localBlockFromNotion(block, '', '', position);
  const children = templateBlockChildren(block).map((child, index) => templateBlockFromNotion(child, index));
  return {
    type: local.type,
    content: local.content,
    plainText: local.plainText,
    ...(children.length ? { children } : {}),
  };
}

function rawTemplateBlocks(template: Record<string, unknown>) {
  for (const value of [template.blocks, template.childBlocks, template.children, asRecord(template.template)?.blocks]) {
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
    }
  }
  return [];
}

function templatePropertiesFromNotion(template: Record<string, unknown>) {
  return (
    asRecord(template.properties) ??
    asRecord(template.default_properties) ??
    asRecord(template.defaultProperties) ??
    asRecord(asRecord(template.template)?.properties)
  );
}

function mappedTemplateProperties(
  rawProperties: Record<string, unknown> | undefined,
  propertyMappings: Map<string, string>,
  reportContext?: {
    report?: ImportConversionReport;
    notionId?: string;
    notionObject?: string;
  },
) {
  if (!rawProperties) return undefined;
  const mapped = rowPropertiesForDataSource(rawProperties, propertyMappings, reportContext);
  delete mapped.__notion;
  return Object.keys(mapped).length ? mapped : undefined;
}

function dbTemplateFromNotion(
  databaseId: string,
  template: Record<string, unknown>,
  propertyMappings: Map<string, string>,
  position: number,
  report?: ImportConversionReport,
  dataSourceId?: string,
): DbTemplate {
  const now = nowIso();
  const rawProperties = templatePropertiesFromNotion(template);
  const notionTemplateId = notionObjectId(template);
  return {
    id: newId(),
    databaseId,
    name: templateNameFromNotion(template, position),
    icon: templateIconFromNotion(template),
    title: templateTitleFromNotion(template),
    properties: mappedTemplateProperties(rawProperties, propertyMappings, {
      report,
      notionId: notionTemplateId ?? dataSourceId,
      notionObject: 'template',
    }),
    blocks: rawTemplateBlocks(template).map((block, index) => templateBlockFromNotion(block, index)),
    isDefault:
      template.isDefault === true ||
      template.is_default === true ||
      template.default === true ||
      template.default_template === true,
    position: position + 1,
    createdAt: now,
    updatedAt: now,
  };
}

function plainTextFromNotionBlock(block: Record<string, unknown>) {
  const type = typeof block.type === 'string' ? block.type : '';
  const payload = type && block[type] && typeof block[type] === 'object'
    ? block[type] as Record<string, unknown>
    : {};
  if (type === 'equation') return optionalString(payload.expression) ?? '';
  if (type === 'bookmark' || type === 'embed' || type === 'link_preview') return optionalString(payload.url) ?? '';
  if (type === 'child_page' || type === 'child_database') return optionalString(payload.title) ?? '';
  if (type === 'table_of_contents') return 'Table of contents';
  if (type === 'breadcrumb') return 'Breadcrumb';
  if (type === 'unsupported') {
    const unsupportedType = notionUnsupportedBlockType(block);
    return unsupportedType ? `Unsupported Notion block: ${unsupportedType}` : 'Unsupported Notion block';
  }
  return textFromRich(payload.rich_text ?? payload.text ?? payload.caption ?? payload.title);
}

const LINKED_TARGET_WRAPPER_KEYS = [
  'target',
  'source',
  'parent',
  'page',
  'database',
  'data_source',
  'dataSource',
  'block',
  'linked_database',
  'linkedDatabase',
  'linked_data_source',
  'linkedDataSource',
  'link',
];
const LINKED_VIEW_KEYS = [
  'view_id',
  'viewId',
  'database_view_id',
  'databaseViewId',
  'data_source_view_id',
  'dataSourceViewId',
  'collection_view_id',
  'collectionViewId',
  'current_view_id',
  'currentViewId',
  'default_view_id',
  'defaultViewId',
];
const LINKED_VIEW_WRAPPER_KEYS = [
  'view',
  'current_view',
  'currentView',
  'default_view',
  'defaultView',
  'database_view',
  'databaseView',
  'data_source_view',
  'dataSourceView',
  'source_view',
  'sourceView',
  'collection_view',
  'collectionView',
];
const LINKED_VIEW_LIST_KEYS = ['views', 'view_ids', 'viewIds', 'database_views', 'databaseViews', 'collection_views', 'collectionViews'];

function notionBlockTypedPayload(block: Record<string, unknown>) {
  const type = typeof block.type === 'string' ? block.type : '';
  return type && block[type] && typeof block[type] === 'object'
    ? block[type] as Record<string, unknown>
    : {};
}

function linkedNotionTargetIdsFromBlock(block: Record<string, unknown>) {
  const ids = new Set<string>();
  if (typeof block.id === 'string' && block.type === 'child_database') ids.add(block.id);
  if (typeof block.id === 'string' && block.type === 'child_page') ids.add(block.id);
  for (const ref of linkedNotionTargetReferencesFromBlockPayload(block)) ids.add(ref.id);
  return Array.from(ids);
}

interface LinkedNotionTargetReference {
  id: string;
  notionObject: 'page' | 'database' | 'data_source' | 'block';
  source?: 'block_payload' | 'rich_text_mention';
}

interface LinkedNotionViewReference {
  id: string;
  source: 'block_payload';
  name?: string;
  type?: string;
  layout?: string;
  role?: 'selected' | 'candidate';
}

function pushLinkedNotionTargetReference(
  refs: Map<string, LinkedNotionTargetReference>,
  notionObject: LinkedNotionTargetReference['notionObject'],
  value: unknown,
  source: LinkedNotionTargetReference['source'] = 'block_payload',
) {
  const id = optionalString(value);
  if (!id) return;
  refs.set(`${notionObject}:${id}`, { id, notionObject, source });
}

function addTypedNotionTargetReference(
  refs: Map<string, LinkedNotionTargetReference>,
  source: Record<string, unknown>,
) {
  const type = optionalString(source.type) ?? optionalString(source.object) ?? '';
  const id = optionalString(source.id);
  if (!id) return;
  if (type === 'page' || type === 'page_id') pushLinkedNotionTargetReference(refs, 'page', id);
  if (type === 'database' || type === 'database_id') pushLinkedNotionTargetReference(refs, 'database', id);
  if (type === 'data_source' || type === 'data_source_id') pushLinkedNotionTargetReference(refs, 'data_source', id);
  if (type === 'block' || type === 'block_id') pushLinkedNotionTargetReference(refs, 'block', id);
}

function pushLinkedNotionTargetReferencesFromSource(
  refs: Map<string, LinkedNotionTargetReference>,
  source: Record<string, unknown> | undefined,
) {
  if (!source) return;
  pushLinkedNotionTargetReference(refs, 'page', source.page_id ?? source.pageId);
  pushLinkedNotionTargetReference(refs, 'database', source.database_id ?? source.databaseId);
  pushLinkedNotionTargetReference(refs, 'data_source', source.data_source_id ?? source.dataSourceId);
  pushLinkedNotionTargetReference(refs, 'block', source.block_id ?? source.blockId);
  addTypedNotionTargetReference(refs, source);
  for (const key of LINKED_TARGET_WRAPPER_KEYS) {
    pushLinkedNotionTargetReferencesFromSource(refs, asRecord(source[key]));
  }
}

function richTextMentionTargetReferencesFromBlock(block: Record<string, unknown>) {
  const refs = new Map<string, LinkedNotionTargetReference>();
  for (const source of notionBlockRichTextSources(block)) {
    for (const span of notionRichTextSpans(source)) {
      pushLinkedNotionTargetReference(refs, 'page', span.notionPageId, 'rich_text_mention');
      pushLinkedNotionTargetReference(refs, 'database', span.notionDatabaseId, 'rich_text_mention');
      pushLinkedNotionTargetReference(refs, 'data_source', span.notionDataSourceId, 'rich_text_mention');
    }
  }
  return Array.from(refs.values());
}

function linkedNotionTargetReferencesFromBlockPayload(block: Record<string, unknown>) {
  const refs = new Map<string, LinkedNotionTargetReference>();
  if (block.type === 'child_database') pushLinkedNotionTargetReference(refs, 'database', block.id);
  if (block.type === 'child_page') pushLinkedNotionTargetReference(refs, 'page', block.id);

  pushLinkedNotionTargetReferencesFromSource(refs, notionBlockTypedPayload(block));
  return Array.from(refs.values());
}

function linkedNotionTargetReferencesFromBlock(block: Record<string, unknown>) {
  const refs = new Map<string, LinkedNotionTargetReference>();
  for (const target of linkedNotionTargetReferencesFromBlockPayload(block)) {
    refs.set(`${target.notionObject}:${target.id}`, target);
  }
  for (const target of richTextMentionTargetReferencesFromBlock(block)) {
    refs.set(`${target.notionObject}:${target.id}`, target);
  }

  return Array.from(refs.values());
}

function linkedNotionViewReferenceFromValue(
  value: unknown,
  role: LinkedNotionViewReference['role'] = 'candidate',
): LinkedNotionViewReference | undefined {
  const record = asRecord(value);
  if (!record) {
    const id = optionalString(value);
    return id ? { id, source: 'block_payload', role } : undefined;
  }
  const id =
    notionObjectId(record) ??
    optionalString(record.view_id) ??
    optionalString(record.viewId) ??
    optionalString(record.database_view_id) ??
    optionalString(record.databaseViewId) ??
    optionalString(record.data_source_view_id) ??
    optionalString(record.dataSourceViewId) ??
    optionalString(record.collection_view_id) ??
    optionalString(record.collectionViewId);
  if (!id) return undefined;
  const layout = asRecord(record.layout);
  return {
    id,
    source: 'block_payload',
    role,
    name: optionalString(record.name),
    type:
      optionalString(record.type) ??
      optionalString(record.view_type) ??
      optionalString(record.viewType) ??
      optionalString(record.layout_type) ??
      optionalString(record.layoutType),
    layout:
      optionalString(record.layout) ??
      optionalString(layout?.type) ??
      optionalString(layout?.layout_type) ??
      optionalString(layout?.layoutType),
  };
}

function linkedNotionViewReferencesFromBlock(block: Record<string, unknown>) {
  const refs = new Map<string, LinkedNotionViewReference>();
  const addViewReference = (
    value: unknown,
    role: LinkedNotionViewReference['role'] = 'candidate',
  ) => {
    const ref = linkedNotionViewReferenceFromValue(value, role);
    if (!ref) return;
    const previous = refs.get(ref.id);
    refs.set(ref.id, {
      ...previous,
      ...ref,
      role: previous?.role === 'selected' || ref.role === 'selected' ? 'selected' : ref.role,
    });
  };
  const addViewReferencesFromSource = (source: Record<string, unknown> | undefined) => {
    if (!source) return;
    for (const key of LINKED_VIEW_KEYS) {
      addViewReference(source[key], 'selected');
    }
    for (const key of LINKED_VIEW_WRAPPER_KEYS) {
      const view = asRecord(source[key]);
      addViewReference(view, 'selected');
      addViewReferencesFromSource(view);
    }
    for (const key of LINKED_VIEW_LIST_KEYS) {
      const value = source[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        addViewReference(item, 'candidate');
      }
    }
  };
  const payload = notionBlockTypedPayload(block);
  addViewReferencesFromSource(payload);
  for (const key of LINKED_TARGET_WRAPPER_KEYS) {
    addViewReferencesFromSource(asRecord(payload[key]));
  }
  return Array.from(refs.values());
}

function linkedNotionViewIdsFromBlock(block: Record<string, unknown>) {
  return linkedNotionViewReferencesFromBlock(block).map((ref) => ref.id);
}

function notionLinkedDatabaseMetadataFromBlock(block: Record<string, unknown>) {
  const targetReferences = linkedNotionTargetReferencesFromBlockPayload(block).filter(
    (target) => target.notionObject === 'database' || target.notionObject === 'data_source',
  );
  const viewReferences = linkedNotionViewReferencesFromBlock(block);
  if (targetReferences.length === 0 && viewReferences.length === 0) return undefined;
  const targetIds = Array.from(new Set(targetReferences.map((target) => target.id)));
  const viewIds = Array.from(new Set(viewReferences.map((view) => view.id)));
  return {
    rawBlockType: optionalString(block.type),
    targetReferences,
    targetIds,
    viewReferences,
    viewIds,
    selectedViewId: viewReferences.find((view) => view.role === 'selected')?.id ?? viewIds[0],
  };
}

function withLinkedDatabaseLocalMapping(
  content: Record<string, unknown> | undefined,
  mapping: { localTargetId?: string; localTargetType?: string; localViewId?: string },
) {
  const metadata = asRecord(content?.notionLinkedDatabase);
  if (!metadata) return content;
  return {
    ...(content ?? {}),
    notionLinkedDatabase: {
      ...metadata,
      ...mapping,
    },
  };
}

function uniqueNonEmptyStrings(values: Array<string | undefined>) {
  const out: string[] = [];
  for (const value of values) {
    const clean = optionalString(value);
    if (!clean || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}

function mappedLocalDatabaseViewIds(
  notionViewIds: string[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  return uniqueNonEmptyStrings(
    notionViewIds.map((viewId) => {
      const mapping = mappingForNotionId(mappingsByNotionId, viewId);
      return mapping?.localType === 'db_view' ? mapping.localId : undefined;
    }),
  );
}

function withNativeHanjiLinkedDatabaseFields(
  content: Record<string, unknown> | undefined,
  mapping: {
    localTargetId?: string;
    localTargetType?: string;
    localViewId?: string;
    localViewIds?: string[];
    linkedDatabaseSource?: boolean;
  },
) {
  const next: Record<string, unknown> = {
    ...(withLinkedDatabaseLocalMapping(content, mapping) ?? content ?? {}),
  };
  if (mapping.linkedDatabaseSource && mapping.localTargetType === 'database') {
    next.linkedDatabaseSource = true;
  }
  if (mapping.localViewId) {
    next.databaseViewId = mapping.localViewId;
  }
  const localViewIds = uniqueNonEmptyStrings([
    mapping.localViewId,
    ...(mapping.localViewIds ?? []),
  ]);
  if (localViewIds.length > 0) {
    next.databaseViewIds = localViewIds;
  }
  return next;
}

function importedDatabaseMappingSourceUnavailable(mapping: NotionImportMapping | undefined) {
  const metadata = asRecord(mapping?.metadata);
  return metadata?.sourceUnavailable === true;
}

function inferredLinkedDatabaseViewMapping(
  mapping: NotionImportMapping | undefined,
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  const metadata = asRecord(mapping?.metadata);
  if (!metadata) return undefined;
  const viewIds = [
    optionalString(metadata.selectedViewId),
    optionalString(metadata.viewId),
    ...(Array.isArray(metadata.viewIds)
      ? metadata.viewIds.map((id) => optionalString(id)).filter((id): id is string => !!id)
      : []),
  ].filter((id): id is string => !!id);
  for (const viewId of viewIds) {
    const viewMapping = mappingsByNotionId.get(viewId);
    if (viewMapping?.localType === 'db_view') return viewMapping;
  }
  return undefined;
}

function hasLinkedDatabaseTarget(block: Record<string, unknown>) {
  if (block.type === 'child_database') return true;
  return linkedNotionTargetReferencesFromBlockPayload(block).some(
    (target) => target.notionObject === 'database' || target.notionObject === 'data_source',
  );
}

function notionHeadingIsToggleable(notionType: string, block: Record<string, unknown>) {
  if (
    notionType !== 'heading_1' &&
    notionType !== 'heading_2' &&
    notionType !== 'heading_3' &&
    notionType !== 'heading_4'
  ) return false;
  const payload = asRecord(block[notionType]);
  return payload?.is_toggleable === true || payload?.isToggleable === true;
}

function localBlockTypeFromNotion(notionType: string, block: Record<string, unknown>) {
  if (notionType === 'paragraph') return 'paragraph';
  if (
    notionType === 'heading_1' ||
    notionType === 'heading_2' ||
    notionType === 'heading_3' ||
    notionType === 'heading_4'
  ) {
    return notionHeadingIsToggleable(notionType, block)
      ? `toggle_${notionType}`
      : notionType;
  }
  if (notionType === 'bulleted_list_item' || notionType === 'numbered_list_item') return notionType;
  if (notionType === 'to_do') return 'to_do';
  if (notionType === 'toggle') return 'toggle';
  if (notionType === 'quote') return 'quote';
  if (notionType === 'divider') return 'divider';
  if (notionType === 'code') return 'code';
  if (notionType === 'equation') return 'equation';
  if (notionType === 'callout') return 'callout';
  if (notionType === 'image' || notionType === 'video' || notionType === 'audio' || notionType === 'file') return notionType;
  if (notionType === 'pdf') return 'file';
  if (notionType === 'bookmark' || notionType === 'embed') return notionType;
  if (notionType === 'link_preview') return 'bookmark';
  if (notionType === 'meeting_notes' || notionType === 'transcription') return 'toggle';
  if (notionType === 'child_page') return 'child_page';
  if (notionType === 'child_database') return 'inline_database';
  if (notionType === 'link_to_page') return hasLinkedDatabaseTarget(block) ? 'inline_database' : 'link_to_page';
  if (notionType === 'synced_block') return 'synced_block';
  if (notionType === 'table_of_contents') return 'table_of_contents';
  if (notionType === 'breadcrumb') return 'breadcrumb';
  if (notionType === 'tab') return 'tab';
  if (notionType === 'button') return 'button';
  if (notionType === 'unsupported' && notionUnsupportedBlockType(block) === 'button') return 'button';
  if (notionType === 'template') return 'button';
  if (notionType === 'column_list') return 'column_list';
  if (notionType === 'column') return 'column';
  if (notionType === 'table') return 'simple_table';
  return 'paragraph';
}

function importedNotionDatabaseIsInline(item: NotionImportItem | undefined) {
  if (!item) return undefined;
  const metadata = itemMetadata(item);
  const database = asRecord(metadata.database);
  if (database?.is_inline === true || database?.isInline === true) return true;
  if (database?.is_inline === false || database?.isInline === false) return false;
  return undefined;
}

function notionBlockEquationExpression(notionType: string, payload: Record<string, unknown>) {
  if (notionType !== 'equation') return undefined;
  return optionalString(payload.expression);
}

function notionColumnWidth(notionType: string, payload: Record<string, unknown>) {
  if (notionType !== 'column') return undefined;
  const value = typeof payload.width_ratio === 'number'
    ? payload.width_ratio
    : typeof payload.widthRatio === 'number'
      ? payload.widthRatio
      : undefined;
  return value && Number.isFinite(value) && value > 0 ? value : undefined;
}

function notionBlockColor(payload: Record<string, unknown>) {
  const color = optionalString(payload.color);
  return color && color !== 'default' && color !== 'default_background' ? color : undefined;
}

function notionBlockIcon(payload: Record<string, unknown>) {
  const icon = asRecord(payload.icon);
  if (!icon) return undefined;
  const emoji = optionalString(icon.emoji);
  return optionalString(icon.type) === 'emoji' && emoji ? emoji : undefined;
}

function notionSyncedBlockSourceId(notionType: string, payload: Record<string, unknown>) {
  if (notionType !== 'synced_block') return undefined;
  const syncedFrom = asRecord(payload.synced_from) ?? asRecord(payload.syncedFrom);
  return optionalString(syncedFrom?.block_id) ?? optionalString(syncedFrom?.blockId);
}

function notionUnsupportedBlockType(block: Record<string, unknown>) {
  const payload = asRecord(block.unsupported);
  return optionalString(payload?.block_type) ?? optionalString(payload?.blockType);
}

function notionTableRows(block: Record<string, unknown>) {
  return notionBlockChildren(block)
    .filter((child) => child.type === 'table_row')
    .map((child) => {
      const row = asRecord(child.table_row);
      const cells = Array.isArray(row?.cells) ? row.cells : [];
      return cells.map((cell) => textFromRich(cell));
    })
    .filter((row) => row.length > 0);
}

function simpleTablePlainText(table: string[][]) {
  return table.map((row) => row.join('\t')).join('\n');
}

function reportBlockConversion(
  report: ImportConversionReport | undefined,
  block: Record<string, unknown>,
  item: NotionImportItem,
) {
  if (!report) return;
  const notionType = typeof block.type === 'string' ? block.type : 'unknown';
  if (notionType === 'unsupported') {
    const unsupportedType = notionUnsupportedBlockType(block);
    if (unsupportedType === 'button') {
      incrementReport(report, 'partialButtonBlocks');
      pushReportIssue(report.warnings, {
        code: 'button_block_partial',
        notionId: notionObjectId(block) ?? item.notionId,
        notionObject: 'block',
        message:
          `Notion API returned button block details as unsupported on "${item.title || item.notionId}", ` +
          'so it was imported as a disabled partial Hanji button placeholder.',
      });
      return;
    }
    incrementReport(report, 'unsupportedBlocks');
    pushReportIssue(report.unsupported, {
      code: 'unsupported_block_type',
      notionId: notionObjectId(block) ?? item.notionId,
      notionObject: 'block',
      message: unsupportedType
        ? `Notion API returned unsupported internal block type "${unsupportedType}" on "${item.title || item.notionId}" and it was imported as a paragraph placeholder.`
        : `Notion API returned an unsupported block on "${item.title || item.notionId}" and it was imported as a paragraph placeholder.`,
    });
    return;
  }
  if (SUPPORTED_NOTION_BLOCK_TYPES.has(notionType)) return;
  incrementReport(report, 'unsupportedBlocks');
  pushReportIssue(report.unsupported, {
    code: 'unsupported_block_type',
    notionId: notionObjectId(block) ?? item.notionId,
    notionObject: 'block',
    message: `Block type "${notionType}" on "${item.title || item.notionId}" was imported as a paragraph fallback.`,
  });
}

function fileReferenceFromNotionBlock(block: Record<string, unknown>) {
  const notionType = typeof block.type === 'string' ? block.type : '';
  if (!['image', 'video', 'audio', 'file', 'pdf'].includes(notionType)) return undefined;
  const payload = notionType && block[notionType] && typeof block[notionType] === 'object'
    ? block[notionType] as Record<string, unknown>
    : {};
  const text = plainTextFromNotionBlock(block);
  const fallbackName = text || (notionType === 'pdf' ? 'PDF' : notionType);
  return notionFileReference(payload, fallbackName);
}

function reportBlockFileReference(
  report: ImportConversionReport | undefined,
  item: NotionImportItem,
  block: Record<string, unknown>,
) {
  const reference = fileReferenceFromNotionBlock(block);
  if (!reference) return;
  reportNotionFileReferences(
    report,
    notionObjectId(block) ?? item.notionId,
    'block',
    `block on "${item.title || item.notionId}"`,
    [reference],
  );
}

function reportBlockRichTextUserReferences(
  report: ImportConversionReport | undefined,
  item: NotionImportItem,
  block: Record<string, unknown>,
) {
  const references = notionBlockRichTextSources(block).flatMap((source) => notionUserReferencesFromRichText(source));
  reportNotionUserReferences(
    report,
    notionObjectId(block) ?? item.notionId,
    'block',
    `rich text block on "${item.title || item.notionId}"`,
    references,
  );
}

function reportTemplateBlockRichTextUserReferences(
  report: ImportConversionReport | undefined,
  item: NotionImportItem,
  block: Record<string, unknown>,
) {
  reportBlockRichTextUserReferences(report, item, block);
  for (const child of templateBlockChildren(block)) {
    reportTemplateBlockRichTextUserReferences(report, item, child);
  }
}

function reportPageChromeFileReferences(
  report: ImportConversionReport | undefined,
  item: NotionImportItem,
) {
  const chrome = importedPageChromeFromItem(item);
  const notionObject = item.notionObject === 'data_source' ? 'data_source' : 'page';
  reportNotionFileReferences(
    report,
    item.notionId,
    notionObject,
    `page icon on "${item.title || item.notionId}"`,
    [chrome.iconReference],
  );
  reportNotionFileReferences(
    report,
    item.notionId,
    notionObject,
    `page cover on "${item.title || item.notionId}"`,
    [chrome.coverReference],
  );
}

function localBlockFromNotion(block: Record<string, unknown>, pageId: string, actorId: string, position: number): Block {
  const now = nowIso();
  const notionCreatedAt = notionIsoTimestamp(block.created_time);
  const notionUpdatedAt = notionIsoTimestamp(block.last_edited_time);
  const createdAt = notionCreatedAt ?? now;
  const updatedAt = notionUpdatedAt ?? createdAt;
  const notionType = typeof block.type === 'string' ? block.type : 'paragraph';
  const unsupportedType = notionUnsupportedBlockType(block);
  const isNotionButtonBlock = notionType === 'button' || (notionType === 'unsupported' && unsupportedType === 'button');
  const isPartialNotionButtonBlock = notionType === 'unsupported' && unsupportedType === 'button';
  const richSpans = notionBlockRichTextSpans(block);
  const table = notionType === 'table' ? notionTableRows(block) : [];
  const rawText = table.length > 0
    ? simpleTablePlainText(table)
    : richTextPlainText(richSpans).trim() || plainTextFromNotionBlock(block);
  const text = isNotionButtonBlock && (!rawText || rawText.startsWith('Unsupported Notion block'))
    ? 'Button'
    : rawText;
  const localType = localBlockTypeFromNotion(notionType, block);
  const payload = notionType && block[notionType] && typeof block[notionType] === 'object'
    ? block[notionType] as Record<string, unknown>
    : {};
  const fileReference = fileReferenceFromNotionBlock(block);
  const caption = notionRichTextSpans(payload.caption);
  const expression = notionBlockEquationExpression(notionType, payload);
  const columnWidth = notionColumnWidth(notionType, payload);
  const color = notionBlockColor(payload);
  const icon = notionType === 'callout' || notionType === 'paragraph'
    ? notionBlockIcon(payload)
    : undefined;
  const syncedBlockSourceId = notionSyncedBlockSourceId(notionType, payload);
  const buttonTemplate = notionType === 'template'
    ? templateBlockChildren(block).map((child, index) => templateBlockFromNotion(child, index))
    : undefined;
  const notionLinkedDatabase = localType === 'inline_database'
    ? notionLinkedDatabaseMetadataFromBlock(block)
    : undefined;
  const shouldCollapseImportedToggle =
    (localType === 'toggle' || localType.startsWith('toggle_heading_')) &&
    (block.has_children === true || notionBlockChildren(block).length > 0);
  return {
    id: newId(),
    pageId,
    parentId: null,
    type: localType,
    content: {
      rich: richSpans.length > 0 ? richSpans : rich(text),
      notionLinkedTargetIds: linkedNotionTargetIdsFromBlock(block),
      notionLinkedViewIds: linkedNotionViewIdsFromBlock(block),
      ...(notionLinkedDatabase ? { notionLinkedDatabase } : {}),
      checked: typeof payload.checked === 'boolean' ? payload.checked : undefined,
      collapsed: shouldCollapseImportedToggle ? true : undefined,
      language: typeof payload.language === 'string' ? payload.language : undefined,
      expression,
      color,
      icon,
      url:
        fileReference?.url ??
        (typeof payload.url === 'string'
          ? payload.url
          : typeof (payload.external as Record<string, unknown> | undefined)?.url === 'string'
            ? (payload.external as Record<string, unknown>).url
            : undefined),
      fileName: fileReference?.name,
      notionFileReference: fileReference,
      notionFileSource: fileReference?.notionFileSource,
      notionFileExpiryTime: fileReference?.notionFileExpiryTime,
      caption: caption.length > 0 ? caption : undefined,
      table: table.length > 0 ? table : undefined,
      headerRow: notionType === 'table' ? payload.has_column_header === true : undefined,
      headerColumn: notionType === 'table' ? payload.has_row_header === true : undefined,
      width: columnWidth,
      notionSyncedBlockSourceId: syncedBlockSourceId,
      buttonLabel: localType === 'button'
        ? isPartialNotionButtonBlock
          ? 'Notion button'
          : text || 'Button'
        : undefined,
      buttonTemplate: isPartialNotionButtonBlock ? [] : buttonTemplate,
      notionButtonPartial: isPartialNotionButtonBlock ? true : undefined,
      notionBlock: block,
      notionCreatedAt,
      notionUpdatedAt,
    },
    plainText: text,
    position: position + 1,
    createdBy: actorId,
    createdAt,
    updatedAt,
  };
}

async function preserveImportedBlockTimestamps(db: DbRef, block: Block, rawBlock: Record<string, unknown>) {
  const createdAt = notionIsoTimestamp(rawBlock.created_time);
  const updatedAt = notionIsoTimestamp(rawBlock.last_edited_time);
  const patch: Partial<Block> = {};
  if (createdAt) patch.createdAt = createdAt;
  if (updatedAt) patch.updatedAt = updatedAt;
  if (Object.keys(patch).length === 0) return block;
  return await db.table<Block>('blocks').update(block.id, patch);
}

async function listPaginatedNotion(
  token: string,
  path: string,
  apiVersion: string,
  options: {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    query?: Record<string, string | number | boolean | undefined>;
    resultKey?: string;
    maxPages: number;
    apiBase?: string;
    onRetry?: (info: NotionRequestRetryInfo) => void;
  },
) {
  const results: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  let hasMore = false;
  let nextCursor: string | undefined;

  for (let page = 0; page < options.maxPages; page += 1) {
    const body = options.body
      ? {
          ...options.body,
          ...(cursor ? { start_cursor: cursor } : {}),
        }
      : undefined;
    const query = options.body
      ? options.query
      : {
          ...options.query,
          ...(cursor ? { start_cursor: cursor } : {}),
        };
    const response = await notionRequest(token, path, apiVersion, {
      method: options.method,
      body,
      query,
      apiBase: options.apiBase,
      onRetry: options.onRetry,
    });
    const resultKey = options.resultKey ?? 'results';
    const pageResults = Array.isArray(response[resultKey]) ? response[resultKey] : [];
    results.push(...pageResults.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object'));
    hasMore = response.has_more === true;
    nextCursor = typeof response.next_cursor === 'string' ? response.next_cursor : undefined;
    cursor = nextCursor;
    if (!hasMore || !cursor) break;
  }

  return { results, hasMore, nextCursor };
}

function notionViewFallbackNameRank(view: Record<string, unknown>) {
  const name = optionalString(view.name)?.trim().toLowerCase() ?? '';
  return !name || name === 'untitled' ? 1 : 0;
}

function notionViewFallbackTypeRank(view: Record<string, unknown>) {
  const type = optionalString(view.type)?.trim().toLowerCase() ?? '';
  if (type === 'table') return 0;
  if (type === 'board') return 1;
  if (type === 'list') return 2;
  if (type === 'gallery') return 3;
  if (type === 'calendar') return 4;
  if (type === 'timeline') return 5;
  return 6;
}

function compareNotionViewFallbackOrder(a: Record<string, unknown>, b: Record<string, unknown>) {
  return (
    notionViewFallbackNameRank(a) - notionViewFallbackNameRank(b) ||
    notionViewFallbackTypeRank(a) - notionViewFallbackTypeRank(b)
  );
}

function notionImportViewOrder(item: NotionImportItem) {
  const order = itemMetadata(item).viewOrder;
  return typeof order === 'number' && Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

function compareNotionImportViewItems(a: NotionImportItem, b: NotionImportItem) {
  const byOrder = notionImportViewOrder(a) - notionImportViewOrder(b);
  if (byOrder !== 0) return byOrder;
  return compareNotionViewFallbackOrder(viewSnapshot(a) ?? {}, viewSnapshot(b) ?? {});
}

function notionViewParentDatabaseId(view: Record<string, unknown>) {
  const parent = asRecord(view.parent);
  const id = parent?.database_id ?? parent?.databaseId ?? view.parent_database_id ?? view.parentDatabaseId;
  return optionalString(id);
}

function notionViewDataSourceId(view: Record<string, unknown>) {
  return optionalString(view.data_source_id ?? view.dataSourceId);
}

function apiLinkedViewsForHiddenDatabase(
  databaseItem: NotionImportItem,
  items: NotionImportItem[],
  dataSourceItems: NotionImportItem[],
) {
  const targetDatabaseId = normalizedNotionId(databaseItem.notionId);
  if (!targetDatabaseId) return [];
  const matches: {
    dataSourceItem: NotionImportItem;
    view: Record<string, unknown>;
    viewId?: string;
    viewIndex: number;
  }[] = [];

  for (const dataSourceItem of dataSourceItems) {
    const views = rawViewsForPlan(items, dataSourceItem);
    for (let viewIndex = 0; viewIndex < views.length; viewIndex += 1) {
      const view = views[viewIndex];
      const parentDatabaseId = notionViewParentDatabaseId(view);
      if (normalizedNotionId(parentDatabaseId) !== targetDatabaseId) continue;
      const viewDataSourceId = notionViewDataSourceId(view);
      if (viewDataSourceId && normalizedNotionId(viewDataSourceId) !== normalizedNotionId(dataSourceItem.notionId)) continue;
      matches.push({
        dataSourceItem,
        view,
        viewId: notionObjectId(view),
        viewIndex,
      });
    }
  }

  return matches;
}

function inferDataSourceForApiLinkedDatabase(
  databaseItem: NotionImportItem,
  items: NotionImportItem[],
  dataSourceItems: NotionImportItem[],
) {
  const matches = apiLinkedViewsForHiddenDatabase(databaseItem, items, dataSourceItems);
  if (matches.length === 0) return undefined;
  const dataSourceIds = new Set(matches.map((match) => match.dataSourceItem.notionId));
  if (dataSourceIds.size !== 1) return undefined;
  const ordered = matches.slice().sort((a, b) =>
    a.viewIndex - b.viewIndex || compareNotionViewFallbackOrder(a.view, b.view)
  );
  const selected = ordered[0];
  const heading = headingBeforeNotionBlockInImportItems(items, databaseItem.notionId);
  return {
    dataSourceItem: selected.dataSourceItem,
    heading,
    matchedLabel:
      optionalString(selected.view.name) ??
      optionalString(selected.dataSourceItem.title) ??
      selected.dataSourceItem.notionId,
    matchedView: selected.view,
    matchedViewId: selected.viewId,
    matchedViewIds: Array.from(new Set(ordered.map((match) => match.viewId).filter((id): id is string => !!id))),
    inferredFrom: 'view_parent_database_id' as const,
  };
}

interface HiddenLinkedDatabaseDataSourceInference {
  dataSourceItem: NotionImportItem;
  heading?: string;
  matchedLabel: string;
  matchedView?: Record<string, unknown>;
  matchedViewId?: string;
  matchedViewIds?: string[];
  inferredFrom: 'view_parent_database_id' | 'sibling_heading_view_name';
}

function hasFallbackNotionViewName(view: Record<string, unknown>) {
  const label = normalizedNotionImportLabel(view.name);
  return !label || label === 'untitled';
}

function importableNotionViews(rawViews: Record<string, unknown>[]) {
  const views = rawViews.filter((view): view is Record<string, unknown> => !!view && typeof view === 'object');
  const hasMeaningfulView = views.some((view) => !hasFallbackNotionViewName(view));
  return hasMeaningfulView ? views.filter((view) => !hasFallbackNotionViewName(view)) : views;
}

function normalizedNotionImportLabel(value: unknown) {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s_\-()[\]{}.,:;'"`~!@#$%^&*+=\\/|<>?]+/g, '')
    : '';
}

function linkedDatabaseHeadingMatchesLabel(heading: string, label: string) {
  const normalizedHeading = normalizedNotionImportLabel(heading);
  const normalizedLabel = normalizedNotionImportLabel(label);
  if (!normalizedHeading || !normalizedLabel) return false;
  if (normalizedLabel === 'untitled' || normalizedLabel === 'table') return false;
  if (normalizedHeading === normalizedLabel) return true;
  if (normalizedHeading.includes(normalizedLabel) && normalizedLabel.length >= 2) return true;
  return normalizedLabel.includes(normalizedHeading) && normalizedHeading.length >= 2;
}

function databaseViewMatchingHeading(views: DbView[], heading: string | undefined) {
  if (!heading) return undefined;
  return views
    .slice()
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .find((view) => linkedDatabaseHeadingMatchesLabel(heading, view.name));
}

function normalizedViewHint(value: string | undefined) {
  return (value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function headingSuggestsCalendarView(heading: string | undefined) {
  const normalized = normalizedViewHint(heading);
  return (
    normalized.includes('calendar') ||
    normalized.includes('calander') ||
    normalized.includes('캘린더') ||
    normalized.includes('일정') ||
    normalized.includes('schedule')
  );
}

function importedSectionViewPenalty(view: DbView) {
  const name = normalizedViewHint(view.name);
  let penalty = view.position / 1000;
  if (!name || name === 'untitled') penalty += 50;
  if (name.includes('efficiency') || name.includes('analytics') || name.includes('summary')) penalty += 10;
  if (name.includes('진행률') || name.includes('비교') || name.includes('분류')) penalty += 10;
  if (name === 'all' || name.includes('전체 보기') || name.includes('all view')) penalty += 6;
  if (name.includes('quest') || name.includes('목록') || name.includes('list')) penalty -= 2;
  return penalty;
}

function databaseViewMatchingImportedSection(views: DbView[], heading: string | undefined) {
  const exact = databaseViewMatchingHeading(views, heading);
  if (exact) return exact;
  const ordered = views.slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  if (headingSuggestsCalendarView(heading)) {
    const calendar = ordered.find((view) => view.type === 'calendar');
    if (calendar) return calendar;
  }
  return ordered
    .slice()
    .sort((a, b) => importedSectionViewPenalty(a) - importedSectionViewPenalty(b) || a.position - b.position)
    .at(0);
}

function notionBlockHeadingText(block: Record<string, unknown>) {
  const type = optionalString(block.type) ?? '';
  if (!type.startsWith('heading_')) return '';
  return notionBlockRichTextSpans(block).map((span) => span.text).join('').trim();
}

function siblingHeadingBeforeNotionBlock(
  blocks: Record<string, unknown>[],
  targetNotionId: string,
): string | undefined {
  const normalizedTargetId = normalizedNotionId(targetNotionId);
  if (!normalizedTargetId) return undefined;
  let lastHeading = '';
  for (const block of blocks) {
    if (normalizedNotionId(notionObjectId(block)) === normalizedTargetId) return lastHeading || undefined;
    const heading = notionBlockHeadingText(block);
    if (heading) lastHeading = heading;
    const nested = notionBlockChildren(block);
    if (nested.length > 0) {
      const found = siblingHeadingBeforeNotionBlock(nested, targetNotionId);
      if (found) return found;
    }
  }
  return undefined;
}

function headingBeforeNotionBlockInImportItems(items: NotionImportItem[], targetNotionId: string) {
  for (const item of items) {
    if (item.notionObject !== 'page') continue;
    const blocks = Array.isArray(pageSnapshot(item)?.childBlocks)
      ? pageSnapshot(item)?.childBlocks as Record<string, unknown>[]
      : [];
    const heading = siblingHeadingBeforeNotionBlock(blocks, targetNotionId);
    if (heading) return heading;
  }
  return undefined;
}

function inferDataSourceForHiddenLinkedDatabase(
  databaseItem: NotionImportItem,
  items: NotionImportItem[],
  dataSourceItems: NotionImportItem[],
): HiddenLinkedDatabaseDataSourceInference | undefined {
  const apiInferred = inferDataSourceForApiLinkedDatabase(databaseItem, items, dataSourceItems);
  if (apiInferred) return apiInferred;

  const heading = headingBeforeNotionBlockInImportItems(items, databaseItem.notionId);
  if (!heading) return undefined;

  const matches = dataSourceItems
    .map((dataSourceItem) => {
      const viewNames = rawViewsForPlan(items, dataSourceItem)
        .map((view) => optionalString(view.name))
        .filter((name): name is string => !!name);
      const labels = [dataSourceItem.title, ...viewNames].filter((label): label is string => !!label);
      const matchedLabel = labels.find((label) => linkedDatabaseHeadingMatchesLabel(heading, label));
      return matchedLabel ? { dataSourceItem, heading, matchedLabel } : undefined;
    })
    .filter((match): match is {
      dataSourceItem: NotionImportItem;
      heading: string;
      matchedLabel: string;
    } => !!match);

  return matches.length === 1 ? { ...matches[0], inferredFrom: 'sibling_heading_view_name' as const } : undefined;
}

function inferCanonicalDataSourceForHiddenLinkedDatabase(
  databaseItem: NotionImportItem,
  items: NotionImportItem[],
  dataSourceItems: NotionImportItem[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  const inferred = inferDataSourceForHiddenLinkedDatabase(databaseItem, items, dataSourceItems);
  if (!inferred) return undefined;
  const mapping = mappingsByNotionId.get(inferred.dataSourceItem.notionId);
  if (!mapping || mapping.localType !== 'database') return undefined;
  return { ...inferred, mapping };
}

function meaningfulImportedTitle(value: unknown) {
  const title = optionalString(value)?.trim() ?? '';
  if (!title) return '';
  return normalizedNotionImportLabel(title) === 'untitled' ? '' : title;
}

function parentImportItemTitle(item: NotionImportItem, items: NotionImportItem[]) {
  let parentId = item.parentNotionId ?? undefined;
  const seen = new Set<string>();
  while (parentId) {
    const normalized = normalizedNotionId(parentId);
    if (!normalized || seen.has(normalized)) return '';
    seen.add(normalized);
    const parent = items.find((candidate) => normalizedNotionId(candidate.notionId) === normalized);
    const title = meaningfulImportedTitle(parent?.title);
    if (title) return title;
    parentId = parent?.parentNotionId ?? undefined;
  }
  return '';
}

function hiddenLinkedDatabaseFallbackTitle(
  item: NotionImportItem,
  items: NotionImportItem[],
  database: Record<string, unknown> | undefined,
) {
  return (
    meaningfulImportedTitle(item.title) ||
    meaningfulImportedTitle(notionTitle(database ?? {})) ||
    meaningfulImportedTitle(headingBeforeNotionBlockInImportItems(items, item.notionId)) ||
    parentImportItemTitle(item, items) ||
    'Linked database'
  );
}

async function enrichNotionViewDetails(
  token: string,
  views: Record<string, unknown>[],
  apiVersion: string,
  dataSourceId: string,
  bag: DiscoveryWarningBag,
  apiBase?: string,
  onRetry?: (info: NotionRequestRetryInfo) => void,
) {
  const enriched: { view: Record<string, unknown>; index: number }[] = [];

  for (let index = 0; index < views.length; index += 1) {
    const view = views[index];
    const viewId = notionObjectId(view);
    if (!viewId) {
      enriched.push({ view, index });
      continue;
    }
    const detail = await safeNotionRequest(token, `/views/${encodeURIComponent(viewId)}`, apiVersion, {
      apiBase,
      onRetry,
    });
    if (!detail.ok) {
      bag.warnings.push({
        code: 'view_details_unavailable',
        notionId: viewId,
        notionObject: 'view',
        message:
          `Notion view details for "${viewId}" could not be read, so Hanji kept the list-level view data. ` +
          detail.error,
      });
      enriched.push({ view, index });
      continue;
    }
    enriched.push({
      view: {
        ...view,
        ...detail.data,
        listEntry: view,
      },
      index,
    });
  }

  return enriched
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.view);
}

async function collectNestedBlockChildren(
  token: string,
  blocks: Record<string, unknown>[],
  apiVersion: string,
  maxChildrenPages: number,
  options: {
    pageId: string;
    bag: DiscoveryWarningBag;
    apiBase?: string;
    onRetry?: (info: NotionRequestRetryInfo) => void;
    depth?: number;
    budget?: { remaining: number };
  },
): Promise<Record<string, unknown>[]> {
  const depth = options.depth ?? 1;
  const budget = options.budget ?? { remaining: NOTION_BLOCK_CHILD_TOTAL_LIMIT };
  const out: Record<string, unknown>[] = [];

  for (const block of blocks) {
    const next = { ...block };
    out.push(next);
    if (next.has_children !== true) continue;
    const blockId = notionObjectId(next);
    if (!blockId) continue;
    if (depth > NOTION_BLOCK_CHILD_DEPTH_LIMIT || budget.remaining <= 0) {
      options.bag.warnings.push({
        code: 'block_children_depth_limited',
        notionId: blockId,
        notionObject: 'block',
        message: `Nested children under block "${blockId}" were not fully fetched because the import depth or block budget was reached.`,
      });
      continue;
    }

    try {
      const childResult = await listPaginatedNotion(token, `/blocks/${encodeURIComponent(blockId)}/children`, apiVersion, {
        query: { page_size: 100 },
        maxPages: maxChildrenPages,
        apiBase: options.apiBase,
        onRetry: options.onRetry,
      });
      const limitedChildren = childResult.results.slice(0, Math.max(0, budget.remaining));
      budget.remaining -= limitedChildren.length;
      const children = await collectNestedBlockChildren(token, limitedChildren, apiVersion, maxChildrenPages, {
        ...options,
        depth: depth + 1,
        budget,
      });
      next.children = children;
      next.childrenHasMore = childResult.hasMore;
      next.childrenNextCursor = childResult.nextCursor;
      if (childResult.hasMore) {
        options.bag.warnings.push({
          code: 'block_children_truncated',
          notionId: blockId,
          notionObject: 'block',
          message:
            `Nested children under block "${blockId}" have more results than this discovery pass fetched.` +
            (childResult.nextCursor ? ` Next children cursor: ${childResult.nextCursor}.` : ''),
        });
      }
    } catch (error) {
      options.bag.missingPermissions.push({
        code: 'block_children_unavailable',
        notionId: blockId,
        notionObject: 'block',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return out;
}

async function collectPageSnapshot(
  token: string,
  item: DiscoveredNotionItem,
  apiVersion: string,
  maxChildrenPages: number,
  bag: DiscoveryWarningBag,
  apiBase?: string,
  onRetry?: (info: NotionRequestRetryInfo) => void,
  includeMarkdownFallback = true,
) {
  let childBlocks: Record<string, unknown>[] = [];
  let childrenHasMore = false;
  let childrenNextCursor: string | undefined;
  try {
    const allChildren = await listPaginatedNotion(token, `/blocks/${encodeURIComponent(item.notionId)}/children`, apiVersion, {
      query: { page_size: 100 },
      maxPages: maxChildrenPages,
      apiBase,
      onRetry,
    });
    childBlocks = await collectNestedBlockChildren(token, allChildren.results, apiVersion, maxChildrenPages, {
      pageId: item.notionId,
      bag,
      apiBase,
      onRetry,
    });
    childrenHasMore = allChildren.hasMore;
    childrenNextCursor = allChildren.nextCursor;
  } catch (error) {
    bag.missingPermissions.push({
      code: 'page_children_unavailable',
      notionId: item.notionId,
      notionObject: item.notionObject,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let markdownData: Record<string, unknown> | undefined;
  if (includeMarkdownFallback) {
    const markdown = await safeNotionRequest(token, `/pages/${encodeURIComponent(item.notionId)}/markdown`, apiVersion, { apiBase, onRetry });
    markdownData = markdown.ok ? markdown.data : undefined;
    if (!markdown.ok) {
      bag.warnings.push({
        code: 'page_markdown_unavailable',
        notionId: item.notionId,
        notionObject: item.notionObject,
        message: markdown.error,
      });
    }
  }

  return {
    childBlocks,
    childBlockCount: flattenNotionBlocks(childBlocks).length,
    childBlockTypes: flattenNotionBlocks(childBlocks).reduce<Record<string, number>>((counts, block) => {
      const type = typeof block.type === 'string' ? block.type : 'unknown';
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {}),
    childPages: flattenNotionBlocks(childBlocks)
      .filter((block) => block.type === 'child_page')
      .map((block) => {
        const payload = asRecord(block.child_page);
        return {
          id: notionObjectId(block),
          title: optionalString(payload?.title) ?? plainTextFromNotionBlock(block),
        };
      })
      .filter((entry): entry is { id: string; title: string } => !!entry.id),
    childPageIds: flattenNotionBlocks(childBlocks)
      .filter((block) => block.type === 'child_page')
      .map((block) => notionObjectId(block))
      .filter((id): id is string => !!id),
    childDatabaseIds: flattenNotionBlocks(childBlocks)
      .filter((block) => block.type === 'child_database')
      .map((block) => notionObjectId(block))
      .filter((id): id is string => !!id),
    linkedDataSourceBlocks: flattenNotionBlocks(childBlocks)
      .filter((block) => block.type === 'link_to_page' || block.type === 'synced_block' || block.type === 'child_database')
      .map((block) => ({
        id: block.id,
        type: block.type,
        hasChildren: block.has_children,
        payload: typeof block.type === 'string' ? block[block.type] : undefined,
      })),
    childrenHasMore,
    childrenNextCursor,
    markdown: markdownData
      ? {
          text: typeof markdownData.markdown === 'string'
            ? markdownData.markdown.slice(0, MAX_MARKDOWN_CHARS)
            : '',
          truncated:
            markdownData.truncated === true ||
            (typeof markdownData.markdown === 'string' && markdownData.markdown.length > MAX_MARKDOWN_CHARS),
          unknownBlockIds: Array.isArray(markdownData.unknown_block_ids) ? markdownData.unknown_block_ids : [],
        }
      : undefined,
    markdownSkipped: includeMarkdownFallback ? undefined : true,
  };
}

async function collectDatabaseSnapshot(
  token: string,
  databaseId: string,
  apiVersion: string,
  bag: DiscoveryWarningBag,
  apiBase?: string,
  onRetry?: (info: NotionRequestRetryInfo) => void,
) {
  const response = await safeNotionRequest(token, `/databases/${encodeURIComponent(databaseId)}`, apiVersion, { apiBase, onRetry });
  if (!response.ok) {
    bag.missingPermissions.push({
      code: 'database_unavailable',
      notionId: databaseId,
      notionObject: 'database',
      message: response.error,
    });
    return undefined;
  }
  return response.data;
}

async function collectDataSourceTemplates(
  token: string,
  dataSourceId: string,
  apiVersion: string,
  maxTemplatePages: number,
  maxChildrenPages: number,
  bag: DiscoveryWarningBag,
  apiBase?: string,
  onRetry?: (info: NotionRequestRetryInfo) => void,
) {
  let templateEntries: Record<string, unknown>[] = [];
  let templatesHasMore = false;
  let templatesNextCursor: string | undefined;

  try {
    const allTemplates = await listPaginatedNotion(
      token,
      `/data_sources/${encodeURIComponent(dataSourceId)}/templates`,
      apiVersion,
      {
        query: { page_size: 100 },
        resultKey: 'templates',
        maxPages: maxTemplatePages,
        apiBase,
        onRetry,
      },
    );
    templateEntries = allTemplates.results;
    templatesHasMore = allTemplates.hasMore;
    templatesNextCursor = allTemplates.nextCursor;
  } catch (error) {
    bag.warnings.push({
      code: 'data_source_templates_unavailable',
      notionId: dataSourceId,
      notionObject: 'data_source',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const templates: Record<string, unknown>[] = [];
  for (const entry of templateEntries) {
    const templateId = notionObjectId(entry);
    if (!templateId) {
      templates.push(entry);
      continue;
    }

    const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(templateId)}`, apiVersion, {
      apiBase,
      onRetry,
    });
    if (!page.ok) {
      bag.warnings.push({
        code: 'data_source_template_page_unavailable',
        notionId: templateId,
        notionObject: 'template',
        message: page.error,
      });
    }

    let blocks: Record<string, unknown>[] = [];
    let childrenHasMore = false;
    let childrenNextCursor: string | undefined;
    try {
      const allChildren = await listPaginatedNotion(token, `/blocks/${encodeURIComponent(templateId)}/children`, apiVersion, {
        query: { page_size: 100 },
        maxPages: maxChildrenPages,
        apiBase,
        onRetry,
      });
      blocks = await collectNestedBlockChildren(token, allChildren.results, apiVersion, maxChildrenPages, {
        pageId: templateId,
        bag,
        apiBase,
        onRetry,
      });
      childrenHasMore = allChildren.hasMore;
      childrenNextCursor = allChildren.nextCursor;
    } catch (error) {
      bag.warnings.push({
        code: 'data_source_template_children_unavailable',
        notionId: templateId,
        notionObject: 'template',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    templates.push({
      ...(page.ok ? page.data : {}),
      ...entry,
      notionTemplateListEntry: entry,
      notionTemplatePage: page.ok ? page.data : undefined,
      properties: page.ok ? page.data.properties : entry.properties,
      blocks,
      childBlocks: blocks,
      childrenHasMore,
      childrenNextCursor,
    });
  }

  return {
    templates,
    templatesHasMore,
    templatesNextCursor,
  };
}

async function collectDataSourceSnapshot(
  token: string,
  item: DiscoveredNotionItem,
  apiVersion: string,
  maxRowsPages: number,
  maxViewPages: number,
  maxTemplatePages: number,
  maxChildrenPages: number,
  bag: DiscoveryWarningBag,
  apiBase?: string,
  onRetry?: (info: NotionRequestRetryInfo) => void,
) {
  const dataSource = await safeNotionRequest(token, `/data_sources/${encodeURIComponent(item.notionId)}`, apiVersion, { apiBase, onRetry });
  const dataSourceData = dataSource.ok ? dataSource.data : undefined;
  if (!dataSource.ok) {
    bag.missingPermissions.push({
      code: 'data_source_unavailable',
      notionId: item.notionId,
      notionObject: item.notionObject,
      message: dataSource.error,
    });
  }

  let queryResults: Record<string, unknown>[] = [];
  let rowsHasMore = false;
  let rowsNextCursor: string | undefined;
  try {
    const allRows = await listPaginatedNotion(token, `/data_sources/${encodeURIComponent(item.notionId)}/query`, apiVersion, {
      method: 'POST',
      body: { page_size: 100 },
      maxPages: maxRowsPages,
      apiBase,
      onRetry,
    });
    queryResults = allRows.results;
    rowsHasMore = allRows.hasMore;
    rowsNextCursor = allRows.nextCursor;
  } catch (error) {
    bag.missingPermissions.push({
      code: 'data_source_rows_unavailable',
      notionId: item.notionId,
      notionObject: item.notionObject,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let viewResults: Record<string, unknown>[] = [];
  let viewsHasMore = false;
  let viewsNextCursor: string | undefined;
  try {
    const allViews = await listPaginatedNotion(token, '/views', apiVersion, {
      query: { data_source_id: item.notionId, page_size: 100 },
      maxPages: maxViewPages,
      apiBase,
      onRetry,
    });
    viewResults = await enrichNotionViewDetails(
      token,
      allViews.results,
      apiVersion,
      item.notionId,
      bag,
      apiBase,
      onRetry,
    );
    viewsHasMore = allViews.hasMore;
    viewsNextCursor = allViews.nextCursor;
  } catch (error) {
    bag.warnings.push({
      code: 'views_unavailable',
      notionId: item.notionId,
      notionObject: item.notionObject,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const templateSnapshot = await collectDataSourceTemplates(
    token,
    item.notionId,
    apiVersion,
    maxTemplatePages,
    maxChildrenPages,
    bag,
    apiBase,
    onRetry,
  );

  return {
    dataSource: dataSourceData,
    propertyCount:
      dataSourceData?.properties && typeof dataSourceData.properties === 'object'
        ? Object.keys(dataSourceData.properties as Record<string, unknown>).length
        : 0,
    relationTargetIds: relationTargetIds(dataSourceData?.properties),
    relationTargetReferences: relationTargetReferences(dataSourceData?.properties),
    rowReferences: queryResults.map((record, queryIndex) => ({
      id: notionObjectId(record),
      object: record.object,
      title: notionTitle(record),
      parentId: notionParentId(record),
      notionQueryOrder: queryIndex,
      createdTime: typeof record.created_time === 'string' ? record.created_time : undefined,
      lastEditedTime: typeof record.last_edited_time === 'string' ? record.last_edited_time : undefined,
      properties: record.properties,
      icon: record.icon,
      cover: record.cover,
    })),
    rowsHasMore,
    rowsNextCursor,
    views: viewResults,
    viewCount: viewResults.length,
    viewsHasMore,
    viewsNextCursor,
    templates: templateSnapshot.templates,
    templateCount: templateSnapshot.templates.length,
    templatesHasMore: templateSnapshot.templatesHasMore,
    templatesNextCursor: templateSnapshot.templatesNextCursor,
  };
}

type DiscoveryProgressSnapshot = {
  phase: 'search' | 'enrich';
  discovered: number;
  enrichedPages: number;
  enrichedDataSources: number;
  enrichableTotal: number;
  searchPagesFetched: number;
};

// Live discovery occupies the 25→48% band of the overall bar (apply owns
// 50→100). Search sits at 27; enrichment rises monotonically toward 48 with the
// fraction of enrichable items processed. Pure so it can be unit-guarded.
export function discoveryProgressPercent(
  snapshot: Pick<DiscoveryProgressSnapshot, 'phase' | 'enrichedPages' | 'enrichedDataSources' | 'enrichableTotal'>,
): number {
  if (snapshot.phase === 'search') return 27;
  const fraction = snapshot.enrichableTotal > 0
    ? Math.min(1, (snapshot.enrichedPages + snapshot.enrichedDataSources) / snapshot.enrichableTotal)
    : 0;
  return Math.min(48, 30 + Math.round(fraction * 18));
}

async function discoverNotionGraph(
  token: string,
  options: {
    apiVersion: string;
    maxPages: number;
    maxEnrichedItems: number;
    maxChildrenPages: number;
    maxDataSourceQueryPages: number;
    maxViewPages: number;
    maxTemplatePages: number;
    includeMarkdownFallback: boolean;
    discoveryConcurrency: number;
    rootNotionPageIds: string[];
    rootNotionDataSourceIds: string[];
    startCursor?: string;
    apiBase?: string;
    // Fired synchronously at search completion and after each item is enriched
    // so the caller can throttle-persist a live progress snapshot.
    onProgress?: (snapshot: DiscoveryProgressSnapshot) => void;
  },
) {
  const bag: DiscoveryWarningBag = {
    warnings: [],
    missingPermissions: [],
    unsupported: [],
  };
  const retryWarningsSeen = new Set<string>();
  const onRetry = (retry: NotionRequestRetryInfo) => {
    const retryLabel = retry.status ? `HTTP ${retry.status}` : 'network error';
    const key = `${retry.method}:${retry.path}:${retryLabel}:${retry.nextAttempt}`;
    if (retryWarningsSeen.has(key)) return;
    retryWarningsSeen.add(key);
    if (bag.warnings.length >= 200) return;
    bag.warnings.push({
      code: 'notion_api_retry',
      notionObject: 'api_request',
      message:
        `Notion API ${retry.method} ${retry.path} returned ${retryLabel}; ` +
        `retrying attempt ${retry.nextAttempt}/${NOTION_REQUEST_MAX_ATTEMPTS}.`,
    });
  };
  const me = await notionRequest(token, '/users/me', options.apiVersion, { apiBase: options.apiBase, onRetry });
  const notionWorkspace = notionWorkspaceInfo(me);
  const results: Record<string, unknown>[] = [];
  const searchStartCursor = options.startCursor;
  let cursor: string | undefined = searchStartCursor;
  let hasMore = false;
  let searchPagesFetched = 0;
  const rootScopedDiscovery =
    (options.rootNotionPageIds.length > 0 || options.rootNotionDataSourceIds.length > 0) &&
    !searchStartCursor;

  for (let page = 0; !rootScopedDiscovery && page < options.maxPages; page += 1) {
    let response: Record<string, unknown>;
    try {
      response = await notionRequest(token, '/search', options.apiVersion, {
        method: 'POST',
        body: {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        apiBase: options.apiBase,
        onRetry,
      });
    } catch (error) {
      bag.missingPermissions.push({
        code: 'search_unavailable',
        notionObject: 'workspace',
        message: error instanceof Error ? error.message : String(error),
      });
      hasMore = false;
      cursor = undefined;
      break;
    }
    searchPagesFetched += 1;
    const pageResults = Array.isArray(response.results) ? response.results : [];
    results.push(...pageResults.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object'));
    hasMore = response.has_more === true;
    cursor = typeof response.next_cursor === 'string' ? response.next_cursor : undefined;
    if (!hasMore || !cursor) break;
  }

  const counts: Record<string, number> = {};
  const itemsById = new Map<string, DiscoveredNotionItem>();

  for (const record of results) {
    const notionObject = typeof record.object === 'string' ? record.object : 'unknown';
    counts[notionObject] = (counts[notionObject] ?? 0) + 1;
    const notionId = typeof record.id === 'string' ? record.id : newId();
    putDiscoveredItem(itemsById, {
      notionId,
      notionObject,
      parentNotionId: notionParentId(record),
      title: notionTitle(record),
      status: 'discovered',
      phase: 'search',
      metadata: {
        discoveredFrom: 'search',
        searchObject: record,
        ...compactNotionMetadata(record),
      },
    });
  }

  for (const rootPageId of options.rootNotionPageIds) {
    if (hasDiscoveredNotionId(itemsById, rootPageId)) continue;
    const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(rootPageId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    if (page.ok) {
      const pageNotionId = notionObjectId(page.data) ?? rootPageId;
      putDiscoveredItem(itemsById, {
        notionId: pageNotionId,
        notionObject: typeof page.data.object === 'string' ? page.data.object : 'page',
        parentNotionId: notionParentId(page.data),
        title: notionTitle(page.data),
        status: 'discovered',
        phase: 'root_page',
        metadata: {
          discoveredFrom: 'rootNotionPageIds',
          page: page.data,
          ...compactNotionMetadata(page.data),
        },
      });
      counts.root_page = (counts.root_page ?? 0) + 1;
    } else {
      bag.missingPermissions.push({
        code: 'root_page_unavailable',
        notionId: rootPageId,
        notionObject: 'page',
        message: page.error,
      });
    }
  }

  for (const rootDataSourceId of options.rootNotionDataSourceIds) {
    if (hasDiscoveredNotionId(itemsById, rootDataSourceId)) continue;
    const dataSource = await safeNotionRequest(
      token,
      `/data_sources/${encodeURIComponent(rootDataSourceId)}`,
      options.apiVersion,
      {
        apiBase: options.apiBase,
        onRetry,
      },
    );
    if (dataSource.ok) {
      const dataSourceNotionId = notionObjectId(dataSource.data) ?? rootDataSourceId;
      putDiscoveredItem(itemsById, {
        notionId: dataSourceNotionId,
        notionObject: typeof dataSource.data.object === 'string' ? dataSource.data.object : 'data_source',
        parentNotionId: notionParentId(dataSource.data),
        title: notionTitle(dataSource.data),
        status: 'discovered',
        phase: 'root_data_source',
        metadata: {
          discoveredFrom: 'rootNotionDataSourceIds',
          dataSource: dataSource.data,
          ...compactNotionMetadata(dataSource.data),
        },
      });
      counts.root_data_source = (counts.root_data_source ?? 0) + 1;
    } else {
      bag.missingPermissions.push({
        code: 'root_data_source_unavailable',
        notionId: rootDataSourceId,
        notionObject: 'data_source',
        message: dataSource.error,
      });
    }
  }

  const databaseIds = new Set<string>();
  const retrievedDatabaseIds = new Set<string>();
  const enrichable = Array.from(itemsById.values()).slice(0, options.maxEnrichedItems);
  const enrichedPageIds = new Set<string>();
  const putLinkedTargetReferences = (
    sourcePageId: string,
    blocks: Record<string, unknown>[],
  ) => {
    for (const block of blocks) {
      for (const target of linkedNotionTargetReferencesFromBlock(block)) {
        if (target.notionObject === 'database') {
          databaseIds.add(target.id);
        }
        if (target.notionObject === 'block') continue;
        putDiscoveredItem(itemsById, {
          notionId: target.id,
          notionObject: target.notionObject,
          parentNotionId: sourcePageId,
          status: 'referenced',
          phase: target.source === 'rich_text_mention' ? 'rich_text_mention_reference' : 'linked_block_reference',
          metadata: {
            discoveredFrom: target.source === 'rich_text_mention' ? 'rich_text_mention' : 'linked_block',
            sourcePageId,
            sourceBlockId: notionObjectId(block),
          },
        });
      }
    }
  };
  const enrichPageItem = async (item: DiscoveredNotionItem) => {
    if (enrichedPageIds.has(item.notionId)) return;
    enrichedPageIds.add(item.notionId);
    let enrichedItem = item;
    if (!asRecord(item.metadata?.page)) {
      const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(item.notionId)}`, options.apiVersion, {
        apiBase: options.apiBase,
        onRetry,
      });
      if (page.ok) {
        const pageParent = asRecord(page.data.parent);
        const pageParentId = notionParentId(page.data);
        const pageDataSourceId = pageParent?.type === 'data_source_id'
          ? optionalString(pageParent.data_source_id)
          : undefined;
        const pageProperties = asRecord(page.data.properties);
        enrichedItem = {
          ...item,
          parentNotionId: pageParentId ?? item.parentNotionId,
          title: item.title || notionTitle(page.data),
          status: 'discovered',
          metadata: {
            ...item.metadata,
            discoveredFrom: item.metadata?.discoveredFrom ?? 'page_reference',
            page: page.data,
            ...(pageDataSourceId ? { dataSourceId: pageDataSourceId } : {}),
            ...(pageProperties ? { properties: pageProperties } : {}),
            ...compactNotionMetadata(page.data),
          },
        };
      } else {
        bag.missingPermissions.push({
          code: 'referenced_page_unavailable',
          notionId: item.notionId,
          notionObject: 'page',
          message: page.error,
        });
      }
    }
    const pageSnapshot = await collectPageSnapshot(
      token,
      enrichedItem,
      options.apiVersion,
      options.maxChildrenPages,
      bag,
      options.apiBase,
      onRetry,
      options.includeMarkdownFallback,
    );
    putDiscoveredItem(itemsById, {
      ...enrichedItem,
      phase: 'page_snapshot',
      metadata: {
        ...enrichedItem.metadata,
        pageSnapshot,
      },
    });

    const childPages = Array.isArray(pageSnapshot.childPages)
      ? pageSnapshot.childPages as Array<{ id?: unknown; title?: unknown }>
      : [];
    const childPageEntries: Array<{ id?: unknown; title?: unknown }> = childPages.length
      ? childPages
      : pageSnapshot.childPageIds.map((id: string) => ({ id }));
    for (const childPage of childPageEntries) {
      const childPageId = optionalString(childPage.id);
      if (!childPageId) continue;
      putDiscoveredItem(itemsById, {
        notionId: childPageId,
        notionObject: 'page',
        parentNotionId: enrichedItem.notionId,
        title: optionalString(childPage.title),
        status: 'referenced',
        phase: 'page_child_reference',
        metadata: { discoveredFrom: 'page_children', sourcePageId: enrichedItem.notionId },
      });
    }
    for (const childDatabaseId of pageSnapshot.childDatabaseIds) {
      databaseIds.add(childDatabaseId);
    }
    putLinkedTargetReferences(item.notionId, flattenNotionBlocks(pageSnapshot.childBlocks));
    reportProgress('enrich');
  };
  const enrichedDataSourceIds = new Set<string>();
  const enrichDataSourceItem = async (item: DiscoveredNotionItem) => {
    if (enrichedDataSourceIds.has(item.notionId)) return;
    enrichedDataSourceIds.add(item.notionId);
    const dataSourceSnapshot = await collectDataSourceSnapshot(
      token,
      item,
      options.apiVersion,
      options.maxDataSourceQueryPages,
      options.maxViewPages,
      options.maxTemplatePages,
      options.maxChildrenPages,
      bag,
      options.apiBase,
      onRetry,
    );
    putDiscoveredItem(itemsById, {
      ...item,
      phase: 'data_source_snapshot',
      metadata: {
        ...item.metadata,
        dataSourceSnapshot,
      },
    });

    const parent = dataSourceSnapshot.dataSource?.parent;
    if (parent && typeof parent === 'object') {
      const databaseId = (parent as Record<string, unknown>).database_id;
      if (typeof databaseId === 'string') databaseIds.add(databaseId);
    }
    for (let rowIndex = 0; rowIndex < dataSourceSnapshot.rowReferences.length; rowIndex += 1) {
      const row = dataSourceSnapshot.rowReferences[rowIndex];
      if (!row.id) continue;
      putDiscoveredItem(itemsById, {
        notionId: row.id,
        notionObject: String(row.object || 'page'),
        parentNotionId: item.notionId,
        title: row.title,
        status: 'referenced',
        phase: 'data_source_row_reference',
        metadata: {
          discoveredFrom: 'data_source_query',
          dataSourceId: item.notionId,
          notionQueryOrder: typeof row.notionQueryOrder === 'number' ? row.notionQueryOrder : rowIndex,
          ...(row.createdTime ? { createdTime: row.createdTime } : {}),
          ...(row.lastEditedTime ? { lastEditedTime: row.lastEditedTime } : {}),
          properties: row.properties,
          icon: row.icon,
          cover: row.cover,
        },
      });
    }
    for (const target of dataSourceSnapshot.relationTargetReferences) {
      if (target.notionObject === 'database') databaseIds.add(target.id);
      putDiscoveredItem(itemsById, {
        notionId: target.id,
        notionObject: target.notionObject,
        parentNotionId: item.notionId,
        status: 'referenced',
        phase: 'relation_target_reference',
        metadata: {
          discoveredFrom: 'data_source_schema',
          dataSourceId: item.notionId,
        },
      });
    }
    const sourceProperties = notionPropertiesFromSnapshot(dataSourceSnapshot as Record<string, unknown>);
    for (let viewOrder = 0; viewOrder < dataSourceSnapshot.views.length; viewOrder += 1) {
      const view = dataSourceSnapshot.views[viewOrder];
      const viewId = notionObjectId(view);
      if (!viewId) continue;
      putDiscoveredItem(itemsById, {
        notionId: viewId,
        notionObject: 'view',
        parentNotionId: item.notionId,
        title: typeof view.name === 'string' ? view.name : notionTitle(view),
        status: 'discovered',
        phase: 'view_snapshot',
        metadata: {
          discoveredFrom: 'views',
          dataSourceId: item.notionId,
          viewOrder,
          view,
        },
      });
      for (const pageId of notionPageIdsFromViewFilters(view, sourceProperties)) {
        putDiscoveredItem(itemsById, {
          notionId: pageId,
          notionObject: 'page',
          status: 'referenced',
          phase: 'view_filter_row_reference',
          metadata: {
            discoveredFrom: 'view_filter',
            sourceDataSourceId: item.notionId,
            sourceViewId: viewId,
          },
        });
      }
    }
    for (const template of rawTemplatesFromSnapshot(dataSourceSnapshot as Record<string, unknown>)) {
      const templateId = notionObjectId(template) ?? item.notionId;
      putLinkedTargetReferences(templateId, flattenNotionBlocks(rawTemplateBlocks(template)));
    }
    reportProgress('enrich');
  };
  const collectDatabaseReferences = async () => {
    const pendingDatabaseIds = Array.from(databaseIds)
      .filter((databaseId) => !retrievedDatabaseIds.has(databaseId))
      .slice(0, options.maxEnrichedItems);
    await mapWithConcurrency(pendingDatabaseIds, options.discoveryConcurrency, async (databaseId) => {
      retrievedDatabaseIds.add(databaseId);
      const database = await collectDatabaseSnapshot(token, databaseId, options.apiVersion, bag, options.apiBase, onRetry);
      putDiscoveredItem(itemsById, {
        notionId: databaseId,
        notionObject: 'database',
        title: database ? notionTitle(database) : undefined,
        status: database ? 'discovered' : 'referenced',
        phase: database ? 'database_snapshot' : 'database_reference',
        metadata: {
          discoveredFrom: database ? 'database_retrieve' : 'reference',
          database,
          dataSources: Array.isArray(database?.data_sources) ? database.data_sources : undefined,
        },
        error: database ? null : 'Database details unavailable.',
      });
      if (Array.isArray(database?.data_sources)) {
        for (const dataSource of database.data_sources) {
          if (!dataSource || typeof dataSource !== 'object') continue;
          const dataSourceId = notionObjectId(dataSource as Record<string, unknown>);
          if (!dataSourceId) continue;
          putDiscoveredItem(itemsById, {
            notionId: dataSourceId,
            notionObject: 'data_source',
            parentNotionId: databaseId,
            title: notionTitle(dataSource as Record<string, unknown>),
            status: 'referenced',
            phase: 'database_data_source_reference',
            metadata: {
              discoveredFrom: 'database_data_sources',
              databaseId,
              dataSource,
            },
          });
        }
      }
    });
  };
  const enrichPendingDataSources = async () => {
    const dataSourceItems = Array.from(itemsById.values())
      .filter((item) => item.notionObject === 'data_source' && !enrichedDataSourceIds.has(item.notionId))
      .slice(0, options.maxEnrichedItems);
    await mapWithConcurrency(dataSourceItems, options.discoveryConcurrency, async (item) => {
      await enrichDataSourceItem(item);
    });
  };
  const enrichPendingRowPages = async () => {
    const rowPageItems = Array.from(itemsById.values())
      .filter((item) => {
        if (item.notionObject !== 'page' || enrichedPageIds.has(item.notionId)) return false;
        const metadata = itemMetadata(item);
        return item.phase === 'data_source_row_reference' || typeof metadata.dataSourceId === 'string';
      })
      .slice(0, options.maxEnrichedItems);
    await mapWithConcurrency(rowPageItems, options.discoveryConcurrency, async (item) => {
      await enrichPageItem(item);
    });
  };
  const enrichPendingReferencedPages = async () => {
    const pageItems = Array.from(itemsById.values())
      .filter((item) => {
        if (item.notionObject !== 'page' || enrichedPageIds.has(item.notionId)) return false;
        if (item.phase === 'data_source_row_reference') return false;
        const metadata = itemMetadata(item);
        return (
          item.status === 'referenced' ||
          item.phase === 'page_child_reference' ||
          item.phase === 'linked_block_reference' ||
          item.phase === 'rich_text_mention_reference' ||
          item.phase === 'relation_target_reference' ||
          typeof metadata.sourcePageId === 'string'
        );
      })
      .slice(0, options.maxEnrichedItems);
    await mapWithConcurrency(pageItems, options.discoveryConcurrency, async (item) => {
      await enrichPageItem(item);
    });
  };
  const discoveryStateKey = () =>
    [
      itemsById.size,
      enrichedPageIds.size,
      enrichedDataSourceIds.size,
      retrievedDatabaseIds.size,
    ].join(':');

  // All enrich* state is declared above; safe to close over now. Fires the
  // caller's throttled progress writer as each item is enriched.
  const enrichableTotal = enrichable.length;
  const reportProgress = (phase: DiscoveryProgressSnapshot['phase']) => {
    options.onProgress?.({
      phase,
      discovered: itemsById.size,
      enrichedPages: enrichedPageIds.size,
      enrichedDataSources: enrichedDataSourceIds.size,
      enrichableTotal,
      searchPagesFetched,
    });
  };
  reportProgress('search');

  for (const item of enrichable) {
    if (item.notionObject === 'database') databaseIds.add(item.notionId);
  }
  await mapWithConcurrency(
    enrichable.filter((item) => item.notionObject === 'page'),
    options.discoveryConcurrency,
    async (item) => {
      await enrichPageItem(item);
    },
  );
  await mapWithConcurrency(
    enrichable.filter((item) => item.notionObject === 'data_source'),
    options.discoveryConcurrency,
    async (item) => {
      await enrichDataSourceItem(item);
    },
  );

  let discoveryPasses = 0;
  for (let pass = 0; pass < NOTION_DISCOVERY_PASS_SAFETY_LIMIT; pass += 1) {
    discoveryPasses = pass + 1;
    const before = discoveryStateKey();
    await collectDatabaseReferences();
    await enrichPendingDataSources();
    await enrichPendingRowPages();
    await enrichPendingReferencedPages();
    const after = discoveryStateKey();
    if (after === before) break;
  }
  if (discoveryPasses >= NOTION_DISCOVERY_PASS_SAFETY_LIMIT) {
    bag.warnings.push({
      code: 'discovery_pass_safety_limit_reached',
      notionObject: 'workspace_graph',
      message:
        'Notion import reached the internal discovery pass safety limit before the graph stopped changing. ' +
        'The import may still be incomplete; rerun discovery or narrow the root if needed.',
    });
  }

  const items = Array.from(itemsById.values());
  const graphCounts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
    return acc;
  }, {});

  return {
    items,
    counts,
    graphCounts,
    warnings: bag.warnings,
    missingPermissions: bag.missingPermissions,
    unsupported: bag.unsupported,
    hasMore,
    nextCursor: cursor,
    searchStartCursor,
    searchPagesFetched,
    discoveryPasses,
    notionWorkspace,
  };
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => !!value)));
}

async function preflightNotionImportGraph(
  token: string,
  options: {
    apiVersion: string;
    rootNotionPageIds: string[];
    rootNotionDataSourceIds: string[];
    apiBase?: string;
  },
) {
  const bag: DiscoveryWarningBag = {
    warnings: [],
    missingPermissions: [],
    unsupported: [],
  };
  const retryWarningsSeen = new Set<string>();
  const onRetry = (retry: NotionRequestRetryInfo) => {
    const retryLabel = retry.status ? `HTTP ${retry.status}` : 'network error';
    const key = `${retry.method}:${retry.path}:${retryLabel}:${retry.nextAttempt}`;
    if (retryWarningsSeen.has(key)) return;
    retryWarningsSeen.add(key);
    bag.warnings.push({
      code: 'notion_api_retry',
      notionObject: 'api_request',
      message:
        `Notion API ${retry.method} ${retry.path} returned ${retryLabel}; ` +
        `retrying attempt ${retry.nextAttempt}/${NOTION_REQUEST_MAX_ATTEMPTS}.`,
    });
  };
  const me = await notionRequest(token, '/users/me', options.apiVersion, { apiBase: options.apiBase, onRetry });
  const notionWorkspace = notionWorkspaceInfo(me);
  const roots: Record<string, unknown>[] = [];
  const directChildPages = new Set<string>();
  const directDatabaseIds = new Set<string>();
  const directDataSourceIds = new Set<string>();
  const rootNotionDataSourceIdSet = new Set(
    options.rootNotionDataSourceIds.map((id) => normalizedNotionId(id)).filter(Boolean),
  );
  for (const dataSourceId of options.rootNotionDataSourceIds) {
    directDataSourceIds.add(dataSourceId);
  }

  for (const rootPageId of options.rootNotionPageIds) {
    const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(rootPageId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    const rootReport: Record<string, unknown> = {
      notionId: rootPageId,
      notionObject: 'page',
      readable: page.ok,
    };
    if (!page.ok) {
      bag.missingPermissions.push({
        code: 'root_page_unavailable',
        notionId: rootPageId,
        notionObject: 'page',
        message: page.error,
      });
      roots.push({ ...rootReport, error: page.error });
      continue;
    }

    const pageId = notionObjectId(page.data) ?? rootPageId;
    const children = await safeNotionRequest(
      token,
      `/blocks/${encodeURIComponent(pageId)}/children`,
      options.apiVersion,
      {
        query: { page_size: 100 },
        apiBase: options.apiBase,
        onRetry,
      },
    );
    let childBlocks: Record<string, unknown>[] = [];
    if (children.ok) {
      childBlocks = Array.isArray(children.data.results)
        ? children.data.results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        : [];
    } else {
      bag.missingPermissions.push({
        code: 'page_children_unavailable',
        notionId: pageId,
        notionObject: 'page',
        message: children.error,
      });
    }

    const childPageIds = uniqueStrings(
      childBlocks
        .filter((block) => block.type === 'child_page')
        .map((block) => notionObjectId(block)),
    );
    const childDatabaseIds = uniqueStrings(
      childBlocks
        .filter((block) => block.type === 'child_database')
        .map((block) => notionObjectId(block)),
    );
    const linkedTargets = childBlocks.flatMap((block) => linkedNotionTargetReferencesFromBlock(block));
    for (const id of childPageIds) directChildPages.add(id);
    for (const id of childDatabaseIds) directDatabaseIds.add(id);
    for (const target of linkedTargets) {
      if (target.notionObject === 'page') directChildPages.add(target.id);
      if (target.notionObject === 'database') directDatabaseIds.add(target.id);
      if (target.notionObject === 'data_source') directDataSourceIds.add(target.id);
    }

    roots.push({
      ...rootReport,
      notionId: pageId,
      title: notionTitle(page.data),
      parentNotionId: notionParentId(page.data),
      childBlockSampleCount: childBlocks.length,
      childrenHasMore: children.ok ? children.data.has_more === true : undefined,
      directChildPages: childPageIds.slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT),
      directChildDatabases: childDatabaseIds.slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT),
      directLinkedTargets: linkedTargets.slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT),
    });
  }

  const sampledPages: Record<string, unknown>[] = [];
  for (const pageId of Array.from(directChildPages).slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT)) {
    const page = await safeNotionRequest(token, `/pages/${encodeURIComponent(pageId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    sampledPages.push({
      notionId: pageId,
      readable: page.ok,
      title: page.ok ? notionTitle(page.data) : undefined,
      parentNotionId: page.ok ? notionParentId(page.data) : undefined,
      error: page.ok ? undefined : page.error,
    });
    if (!page.ok) {
      bag.missingPermissions.push({
        code: 'direct_child_page_unavailable',
        notionId: pageId,
        notionObject: 'page',
        message: page.error,
      });
    }
  }

  const sampledDatabases: Record<string, unknown>[] = [];
  for (const databaseId of Array.from(directDatabaseIds).slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT)) {
    const database = await safeNotionRequest(token, `/databases/${encodeURIComponent(databaseId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    const dataSources = database.ok && Array.isArray(database.data.data_sources)
      ? database.data.data_sources.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      : [];
    for (const dataSource of dataSources) {
      const dataSourceId = notionObjectId(dataSource);
      if (dataSourceId) directDataSourceIds.add(dataSourceId);
    }
    sampledDatabases.push({
      notionId: databaseId,
      readable: database.ok,
      title: database.ok ? notionTitle(database.data) : undefined,
      dataSourceIds: dataSources.map((item) => notionObjectId(item)).filter(Boolean),
      error: database.ok ? undefined : database.error,
    });
    if (!database.ok) {
      bag.missingPermissions.push({
        code: 'direct_database_unavailable',
        notionId: databaseId,
        notionObject: 'database',
        message: database.error,
      });
    }
  }

  const sampledDataSources: Record<string, unknown>[] = [];
  for (const dataSourceId of Array.from(directDataSourceIds).slice(0, NOTION_PREFLIGHT_SAMPLE_LIMIT)) {
    const isRootDataSource = rootNotionDataSourceIdSet.has(normalizedNotionId(dataSourceId));
    const dataSource = await safeNotionRequest(token, `/data_sources/${encodeURIComponent(dataSourceId)}`, options.apiVersion, {
      apiBase: options.apiBase,
      onRetry,
    });
    let queryable = false;
    let rowSampleCount = 0;
    let rowsHasMore = false;
    let queryError: string | undefined;
    if (dataSource.ok) {
      const rows = await safeNotionRequest(
        token,
        `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
        options.apiVersion,
        {
          method: 'POST',
          body: { page_size: 10 },
          apiBase: options.apiBase,
          onRetry,
        },
      );
      queryable = rows.ok;
      rowSampleCount = rows.ok && Array.isArray(rows.data.results) ? rows.data.results.length : 0;
      rowsHasMore = rows.ok ? rows.data.has_more === true : false;
      queryError = rows.ok ? undefined : rows.error;
      if (!rows.ok) {
        bag.missingPermissions.push({
          code: 'direct_data_source_rows_unavailable',
          notionId: dataSourceId,
          notionObject: 'data_source',
          message: rows.error,
        });
      }
    }
    sampledDataSources.push({
      notionId: dataSourceId,
      root: isRootDataSource,
      readable: dataSource.ok,
      title: dataSource.ok ? notionTitle(dataSource.data) : undefined,
      queryable,
      rowSampleCount,
      rowsHasMore,
      error: dataSource.ok ? queryError : dataSource.error,
    });
    if (!dataSource.ok) {
      bag.missingPermissions.push({
        code: 'direct_data_source_unavailable',
        notionId: dataSourceId,
        notionObject: 'data_source',
        message: dataSource.error,
      });
    }
  }
  const sampledRootDataSources = sampledDataSources.filter((dataSource) =>
    dataSource.root === true,
  );

  return {
    notionWorkspace,
    apiVersion: options.apiVersion,
    rootNotionPageIds: options.rootNotionPageIds,
    rootNotionDataSourceIds: options.rootNotionDataSourceIds,
    roots,
    sampledPages,
    sampledDatabases,
    sampledDataSources,
    summary: {
      roots: roots.length,
      readableRoots: roots.filter((root) => root.readable === true).length,
      rootDataSources: options.rootNotionDataSourceIds.length,
      sampledRootDataSources: sampledRootDataSources.length,
      readableRootDataSources: sampledRootDataSources.filter((dataSource) => dataSource.readable === true).length,
      queryableRootDataSources: sampledRootDataSources.filter((dataSource) => dataSource.queryable === true).length,
      sampledPages: sampledPages.length,
      readableSampledPages: sampledPages.filter((page) => page.readable === true).length,
      sampledDatabases: sampledDatabases.length,
      readableSampledDatabases: sampledDatabases.filter((database) => database.readable === true).length,
      sampledDataSources: sampledDataSources.length,
      readableSampledDataSources: sampledDataSources.filter((dataSource) => dataSource.readable === true).length,
      queryableSampledDataSources: sampledDataSources.filter((dataSource) => dataSource.queryable === true).length,
      warnings: bag.warnings.length,
      missingPermissions: bag.missingPermissions.length,
    },
    warnings: bag.warnings,
    missingPermissions: bag.missingPermissions,
    unsupported: bag.unsupported,
  };
}

async function replaceDiscoveredItems(
  db: DbRef,
  job: NotionImportJob,
  items: DiscoveredNotionItem[],
) {
  const table = db.table<NotionImportItem>('notion_import_items');
  const existing = await listAll(table.where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  await Promise.all(existing.map((item) => bestEffort('notion-import table.delete(item.id)', table.delete(item.id))));

  const inserted: NotionImportItem[] = [];
  for (const item of items) {
    inserted.push(
      await table.insert({
        id: newId(),
        workspaceId: job.workspaceId,
        jobId: job.id,
        notionId: item.notionId,
        notionObject: item.notionObject,
        parentNotionId: item.parentNotionId,
        title: item.title,
        status: item.status ?? 'discovered',
        phase: item.phase ?? 'discovery',
        metadata: item.metadata,
        error: item.error,
      }),
    );
  }
  return inserted;
}

async function mergeDiscoveredItems(
  db: DbRef,
  job: NotionImportJob,
  items: DiscoveredNotionItem[],
) {
  const table = db.table<NotionImportItem>('notion_import_items');
  const existing = await listAll(table.where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  const existingByNotionId = new Map(existing.map((item) => [item.notionId, item]));

  for (const item of items) {
    const current = existingByNotionId.get(item.notionId);
    if (current) {
      const nextStatus = current.status === 'discovered' && item.status === 'referenced'
        ? current.status
        : item.status ?? current.status ?? 'discovered';
      await table.update(current.id, {
        notionObject: item.notionObject,
        parentNotionId: item.parentNotionId ?? current.parentNotionId,
        title: item.title ?? current.title,
        status: nextStatus,
        phase: item.phase ?? current.phase ?? 'discovery',
        metadata: {
          ...(current.metadata ?? {}),
          ...(item.metadata ?? {}),
        },
        error: item.error === undefined ? current.error ?? null : item.error,
      });
      continue;
    }

    await table.insert({
      id: newId(),
      workspaceId: job.workspaceId,
      jobId: job.id,
      notionId: item.notionId,
      notionObject: item.notionObject,
      parentNotionId: item.parentNotionId,
      title: item.title,
      status: item.status ?? 'discovered',
      phase: item.phase ?? 'discovery',
      metadata: item.metadata,
      error: item.error,
    });
  }

  return listAll(table.where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
}

function baseReport(extra: Record<string, unknown> = {}) {
  return {
    warnings: [
      'This implementation performs Notion API graph discovery and a first-pass converter for local pages, databases, views, row pages, relation IDs, rollup/formula config metadata, file copies, templates, resumable search discovery, and ID mappings. High-fidelity linked view rendering, advanced formula translation, and real-workspace validation still need deeper work.',
    ],
    unsupported: [],
    missingPermissions: [],
    ...extra,
  };
}

function finalizeConversionReport(report: ImportConversionReport) {
  return {
    ...report,
    summary: {
      ...report.summary,
      warnings: report.warnings.length,
      unsupported: report.unsupported.length,
      missingPermissions: report.missingPermissions.length,
      unresolvedReferences: report.unresolvedReferences.length,
    },
  };
}

function basePage(input: {
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  kind: 'page' | 'database';
  title: string;
  icon?: string;
  iconType?: ImportedPageIconType;
  cover?: string;
  coverPosition?: number;
  fullWidth?: boolean;
  isFavorite?: boolean;
  position: number;
  actorId: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}): Page {
  const now = nowIso();
  const createdAt = notionIsoTimestamp(input.createdAt) ?? now;
  const updatedAt = notionIsoTimestamp(input.updatedAt) ?? createdAt;
  const properties = input.properties ? { ...input.properties } : {};
  if (input.createdAt) properties[NOTION_CREATED_TIME_KEY] = createdAt;
  if (input.updatedAt) properties[NOTION_LAST_EDITED_TIME_KEY] = updatedAt;
  return {
    id: newId(),
    workspaceId: input.workspaceId,
    parentId: input.parentId ?? null,
    parentType: input.parentType ?? 'workspace',
    kind: input.kind,
    title: input.title || (input.parentType === 'database' ? '' : 'Untitled'),
    icon: input.icon ?? '',
    iconType: input.iconType ?? 'none',
    cover: input.cover,
    coverPosition: input.coverPosition ?? 50,
    font: 'default',
    smallText: false,
    fullWidth: input.fullWidth ?? false,
    isLocked: false,
    isPublic: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    isFavorite: input.isFavorite ?? false,
    inTrash: false,
    position: input.position,
    createdBy: input.actorId,
    lastEditedBy: input.actorId,
    createdAt,
    updatedAt,
  };
}

function importedItemTimestamps(item: NotionImportItem) {
  const metadata = itemMetadata(item);
  return {
    createdAt: notionIsoTimestamp(metadata.createdTime),
    updatedAt: notionIsoTimestamp(metadata.lastEditedTime),
  };
}

async function preserveImportedPageTimestamps(db: DbRef, page: Page, item: NotionImportItem) {
  const timestamps = importedItemTimestamps(item);
  const patch: Partial<Page> = {};
  if (timestamps.createdAt) patch.createdAt = timestamps.createdAt;
  if (timestamps.updatedAt) patch.updatedAt = timestamps.updatedAt;
  if (Object.keys(patch).length === 0) return page;
  return await db.table<Page>('pages').update(page.id, patch);
}

async function loadMappings(db: DbRef, jobId: string) {
  const mappings = await listAll(db.table<NotionImportMapping>('notion_import_mappings').where('jobId', '==', jobId), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  return new Map(mappings.map((mapping) => [mapping.notionId, mapping]));
}

function notionBlockParentId(record: Record<string, unknown>) {
  const parent = asRecord(record.parent);
  return optionalString(parent?.block_id);
}

function buildImportedBlockOwnerContexts(items: NotionImportItem[]) {
  const contexts = new Map<string, ImportedBlockOwnerContext>();
  const setContext = (context: ImportedBlockOwnerContext) => {
    const key = normalizedNotionId(context.blockNotionId);
    if (key && !contexts.has(key)) contexts.set(key, context);
  };

  for (const item of items) {
    if (item.notionObject !== 'page') continue;
    const snapshot = pageSnapshot(item);
    const childBlocks = Array.isArray(snapshot?.childBlocks)
      ? snapshot.childBlocks.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
      : [];

    const visit = (block: Record<string, unknown>, parentBlockNotionId: string | null, position: number) => {
      const blockNotionId = notionObjectId(block);
      const nextParentBlockNotionId = blockNotionId ?? parentBlockNotionId;
      if (blockNotionId) {
        setContext({
          pageNotionId: item.notionId,
          blockNotionId,
          blockType: optionalString(block.type),
          parentBlockNotionId: notionBlockParentId(block) ?? parentBlockNotionId,
          position,
        });
      }

      let childPosition = 1;
      for (const child of notionBlockChildren(block)) {
        visit(child, nextParentBlockNotionId, childPosition);
        childPosition += 1;
      }
    };

    let position = 1;
    for (const block of childBlocks) {
      visit(block, null, position);
      position += 1;
    }
  }

  return contexts;
}

function localPageIdForNotionId(
  mappingsByNotionId: Map<string, NotionImportMapping>,
  notionId: string | null | undefined,
) {
  if (!notionId) return undefined;
  const direct = mappingForNotionId(mappingsByNotionId, notionId);
  if (direct?.localType === 'page') return direct.localId;
  return undefined;
}

// Secondary lookup index for mappingForNotionId: normalizedNotionId -> raw map
// key, built lazily once per map generation instead of an O(n) scan on every
// dashless-id miss (which made 100k-item imports quadratic). The maps only
// ever gain entries or replace a value under the same key, so a size change is
// the rebuild signal; storing the raw key and re-reading the live map means an
// in-place replacement can never serve a stale mapping object.
const normalizedMappingIndexes = new WeakMap<
  Map<string, NotionImportMapping>,
  { size: number; index: Map<string, string> }
>();

function mappingForNotionId(
  mappingsByNotionId: Map<string, NotionImportMapping>,
  notionId: string | null | undefined,
) {
  if (!notionId) return undefined;
  const direct = mappingsByNotionId.get(notionId);
  if (direct) return direct;
  const normalized = normalizedNotionId(notionId);
  if (!normalized) return undefined;
  let cached = normalizedMappingIndexes.get(mappingsByNotionId);
  if (!cached || cached.size !== mappingsByNotionId.size) {
    const index = new Map<string, string>();
    for (const [key, mapping] of mappingsByNotionId) {
      const normalizedKey = normalizedNotionId(mapping.notionId);
      // Keep the first occurrence, matching the original scan's iteration order.
      if (normalizedKey && !index.has(normalizedKey)) index.set(normalizedKey, key);
    }
    cached = { size: mappingsByNotionId.size, index };
    normalizedMappingIndexes.set(mappingsByNotionId, cached);
  }
  const rawKey = cached.index.get(normalized);
  return rawKey !== undefined ? mappingsByNotionId.get(rawKey) : undefined;
}

function resolveImportedPageParentFromNotionBlocks(
  item: NotionImportItem,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  blockOwnerContextsByNotionId: Map<string, ImportedBlockOwnerContext>,
) {
  const directParentId = localPageIdForNotionId(mappingsByNotionId, item.parentNotionId);
  if (directParentId) return { parentId: directParentId };

  const selfBlockContext = blockOwnerContextsByNotionId.get(normalizedNotionId(item.notionId));
  const selfOwnerPageId = selfBlockContext && selfBlockContext.pageNotionId !== item.notionId
    ? localPageIdForNotionId(mappingsByNotionId, selfBlockContext.pageNotionId)
    : undefined;
  if (selfOwnerPageId && selfBlockContext) {
    return {
      parentId: selfOwnerPageId,
      position: selfBlockContext.position,
    };
  }

  const parentBlockContext = item.parentNotionId
    ? blockOwnerContextsByNotionId.get(normalizedNotionId(item.parentNotionId))
    : undefined;
  const parentBlockOwnerPageId = parentBlockContext && parentBlockContext.pageNotionId !== item.notionId
    ? localPageIdForNotionId(mappingsByNotionId, parentBlockContext.pageNotionId)
    : undefined;
  if (parentBlockOwnerPageId && parentBlockContext) {
    return {
      parentId: parentBlockOwnerPageId,
      position: parentBlockContext.position,
    };
  }

  return {};
}

async function moveImportedPageToResolvedParent(
  db: DbRef,
  page: Page,
  resolvedParent: { parentId?: string; position?: number },
) {
  if (!resolvedParent.parentId || resolvedParent.parentId === page.id) return page;
  const patch: Partial<Page> = {};
  if (page.parentId !== resolvedParent.parentId || page.parentType !== 'page') {
    patch.parentId = resolvedParent.parentId;
    patch.parentType = 'page';
  }
  if (typeof resolvedParent.position === 'number' && page.position !== resolvedParent.position) {
    patch.position = resolvedParent.position;
  }
  if (Object.keys(patch).length === 0) return page;
  return await db.table<Page>('pages').update(page.id, patch);
}

async function createMapping(
  db: DbRef,
  admin: AdminDbAccessor,
  job: NotionImportJob,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  input: {
    notionId: string;
    notionType: string;
    localId: string;
    localType: string;
    relationKind?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const existing = mappingsByNotionId.get(input.notionId);
  if (existing) return existing;
  const mapping = await db.table<NotionImportMapping>('notion_import_mappings').insert({
    id: newId(),
    workspaceId: job.workspaceId,
    jobId: job.id,
    notionId: input.notionId,
    notionType: input.notionType,
    localId: input.localId,
    localType: input.localType,
    relationKind: input.relationKind ?? 'canonical',
    metadata: input.metadata,
  });
  mappingsByNotionId.set(mapping.notionId, mapping);
  // Route index must be written the moment a page/database is created, not only
  // in the end-of-apply batch — otherwise an interrupted apply leaves the page
  // unreachable by pageId (/p/:id deep links resolve via page_workspace_index).
  if (input.localType === 'page' || input.localType === 'database') {
    await ensurePageWorkspaceIndex(admin, input.localId, job.workspaceId);
  }
  return mapping;
}

function importRootNotionId(jobId: string) {
  return `notion-import-root:${jobId}`;
}

async function ensureImportRoot(
  db: DbRef,
  admin: AdminDbAccessor,
  job: NotionImportJob,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  actorId: string,
) {
  const rootNotionId = importRootNotionId(job.id);
  const existing = mappingsByNotionId.get(rootNotionId);
  if (existing) return existing.localId;
  const title = job.notionWorkspaceName
    ? `Imported from Notion - ${job.notionWorkspaceName}`
    : 'Imported from Notion';
  const parentId = job.parentPageId || null;
  const page = await db.table<Page>('pages').insert(
    basePage({
      workspaceId: job.workspaceId,
      parentId,
      parentType: parentId ? 'page' : 'workspace',
      kind: 'page',
      title,
      position: 1,
      actorId,
      properties: {
        notionImportJobId: job.id,
        notionWorkspaceId: job.notionWorkspaceId,
      },
    }),
  );
  await createMapping(db, admin, job, mappingsByNotionId, {
    notionId: rootNotionId,
    notionType: 'import_root',
    localId: page.id,
    localType: 'page',
    relationKind: 'import_root',
  });
  return page.id;
}

function rowDataSourceId(item: NotionImportItem, dataSourceIds: Set<string>) {
  const metadata = itemMetadata(item);
  const value = metadata.dataSourceId;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (item.parentNotionId && dataSourceIds.has(item.parentNotionId)) return item.parentNotionId;
  return undefined;
}

function notionFilePropertyReferences(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const prop = value as Record<string, unknown>;
  if (prop.type !== 'files' || !Array.isArray(prop.files)) return [];
  return prop.files
    .map((file, index) => notionFileReference(file, `File ${index + 1}`))
    .filter((file): file is NotionFileReference => !!file);
}

function notionUserReferenceId(notionUserId: string) {
  return `notion-user:${notionUserId}`;
}

function notionUserReference(value: unknown) {
  const record = asRecord(value);
  if (!record) return undefined;
  const notionUserId = optionalString(record.id);
  if (!notionUserId) return undefined;
  const person = asRecord(record.person);
  const bot = asRecord(record.bot);
  return {
    id: notionUserReferenceId(notionUserId),
    userId: notionUserReferenceId(notionUserId),
    notionUserId,
    displayName: optionalString(record.name) ?? optionalString(person?.email) ?? optionalString(bot?.workspace_name),
    email: optionalString(person?.email),
    avatarUrl: optionalString(record.avatar_url),
    notionUserType: optionalString(record.type),
    notion: record,
  };
}

function notionUserReferencesFromPropertyValue(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const prop = value as Record<string, unknown>;
  const type = typeof prop.type === 'string' ? prop.type : '';
  if ((type === 'people' || type === 'person') && Array.isArray(prop.people)) {
    return prop.people.map(notionUserReference).filter((item): item is NonNullable<ReturnType<typeof notionUserReference>> => !!item);
  }
  if (type === 'person') {
    const reference = notionUserReference(prop.person);
    return reference ? [reference] : [];
  }
  if (type === 'created_by' || type === 'last_edited_by') {
    const reference = notionUserReference(prop[type]);
    return reference ? [reference] : [];
  }
  return [];
}

function notionUserReferencesFromRichText(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((part) => {
      const record = asRecord(part);
      const mention = asRecord(record?.mention);
      if (optionalString(mention?.type) !== 'user') return undefined;
      return notionUserReference(mention?.user);
    })
    .filter((item): item is NonNullable<ReturnType<typeof notionUserReference>> => !!item);
}

function notionUniqueIdNumber(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const prop = value as Record<string, unknown>;
  const uniqueId = asRecord(prop.unique_id);
  const rawNumber = uniqueId?.number;
  if (typeof rawNumber === 'number' && Number.isFinite(rawNumber)) return rawNumber;
  if (typeof rawNumber === 'string' && rawNumber.trim()) {
    const number = Number(rawNumber);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function notionTypedComputedValue(value: unknown): string | number | boolean | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = optionalString(record.type);
  if (type === 'string') return optionalString(record.string) ?? '';
  if (type === 'number') return typeof record.number === 'number' && Number.isFinite(record.number) ? record.number : null;
  if (type === 'boolean') return record.boolean === true;
  if (type === 'date') {
    const date = asRecord(record.date);
    const start = optionalString(date?.start);
    const end = optionalString(date?.end);
    return start && end && end !== start ? `${start} → ${end}` : start ?? '';
  }
  if (type === 'title') return textFromRich(record.title);
  if (type === 'rich_text') return textFromRich(record.rich_text);
  if (type === 'checkbox') return record.checkbox === true;
  if (type === 'url' || type === 'email' || type === 'phone_number') return optionalString(record[type]) ?? '';
  if (type === 'select' || type === 'status') {
    const option = asRecord(record[type]);
    return optionalString(option?.name) ?? optionalString(option?.id) ?? '';
  }
  if (type === 'multi_select' && Array.isArray(record.multi_select)) {
    return record.multi_select
      .map((option) => optionalString(asRecord(option)?.name) ?? optionalString(asRecord(option)?.id))
      .filter(Boolean)
      .join(', ');
  }
  if (type === 'people' || type === 'person') {
    return notionUserReferencesFromPropertyValue(record)
      .map((person) => person.displayName ?? person.email ?? person.notionUserId)
      .filter(Boolean)
      .join(', ');
  }
  if (type === 'relation' && Array.isArray(record.relation)) {
    return record.relation
      .map((target) => optionalString(asRecord(target)?.id))
      .filter(Boolean)
      .join(', ');
  }
  if (type === 'formula') return notionTypedComputedValue(record.formula);
  return null;
}

function notionFormulaComputedValue(value: unknown) {
  const prop = asRecord(value);
  return notionTypedComputedValue(prop?.formula);
}

function notionRollupComputedValue(value: unknown) {
  const prop = asRecord(value);
  const rollup = asRecord(prop?.rollup);
  if (!rollup) return null;
  if (Array.isArray(rollup.array)) {
    return rollup.array
      .map(notionTypedComputedValue)
      .filter((item) => item !== null && item !== '')
      .map(String)
      .join(', ');
  }
  return notionTypedComputedValue(rollup);
}

function reportNotionUserReferences(
  report: ImportConversionReport | undefined,
  notionId: string | undefined,
  notionObject: string,
  label: string,
  references: ReturnType<typeof notionUserReferencesFromPropertyValue>,
) {
  if (!report || references.length === 0) return;
  incrementReport(report, 'notionUserReferences', references.length);
  pushReportIssue(report.warnings, {
    code: 'notion_user_reference_preserved',
    notionId,
    notionObject,
    message:
      `${references.length} Notion user reference(s) from ${label} were preserved as imported Notion user ids. ` +
      'They can be mapped to local organization users later.',
  });
}

function convertNotionPropertyValue(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const prop = value as Record<string, unknown>;
  const type = typeof prop.type === 'string' ? prop.type : '';
  if (type === 'title') return textFromRich(prop.title);
  if (type === 'rich_text') return textFromRich(prop.rich_text);
  if (type === 'number') return typeof prop.number === 'number' ? prop.number : null;
  if (type === 'checkbox') return prop.checkbox === true;
  if (type === 'select') {
    const select = prop.select;
    if (select && typeof select === 'object') {
      const record = select as Record<string, unknown>;
      return typeof record.id === 'string' ? record.id : record.name ?? null;
    }
    return null;
  }
  if (type === 'multi_select' && Array.isArray(prop.multi_select)) {
    return prop.multi_select
      .map((option) => {
        if (!option || typeof option !== 'object') return null;
        const record = option as Record<string, unknown>;
        return typeof record.id === 'string' ? record.id : record.name ?? null;
      })
      .filter(Boolean);
  }
  if (type === 'status') {
    const status = prop.status;
    if (status && typeof status === 'object') {
      const record = status as Record<string, unknown>;
      return typeof record.id === 'string' ? record.id : record.name ?? null;
    }
    return null;
  }
  if (type === 'date') return prop.date ?? null;
  if (type === 'url' || type === 'email' || type === 'phone_number') return prop[type] ?? null;
  if (type === 'people' || type === 'person') return notionUserReferencesFromPropertyValue(prop);
  if (type === 'created_by' || type === 'last_edited_by') {
    return notionUserReferencesFromPropertyValue(prop)[0] ?? null;
  }
  if (type === 'unique_id') return notionUniqueIdNumber(prop);
  if (type === 'formula') return notionFormulaComputedValue(prop);
  if (type === 'rollup') return notionRollupComputedValue(prop);
  if (type === 'relation' && Array.isArray(prop.relation)) {
    return prop.relation
      .map((target) => target && typeof target === 'object' ? (target as Record<string, unknown>).id : null)
      .filter(Boolean);
  }
  if (type === 'files') return notionFilePropertyReferences(prop);
  return {
    notion: prop,
  };
}

function rowPropertiesForDataSource(
  rawProperties: unknown,
  propertyMappings: Map<string, string>,
  reportContext?: {
    report?: ImportConversionReport;
    notionId?: string;
    notionObject?: string;
  },
  options: { omitFileValuesNeedingStorage?: boolean } = {},
) {
  const out: Record<string, unknown> = {};
  if (!rawProperties || typeof rawProperties !== 'object') return out;
  for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
    const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
    const notionPropId = typeof prop.id === 'string' ? prop.id : nameOrId;
    const localPropId = propertyMappings.get(notionPropId) ?? propertyMappings.get(nameOrId);
    if (!localPropId) continue;
    out[localPropId] = options.omitFileValuesNeedingStorage && prop.type === 'files'
      ? []
      : convertNotionPropertyValue(rawValue);
    reportNotionUserReferences(
      reportContext?.report,
      reportContext?.notionId ?? notionPropId,
      reportContext?.notionObject ?? 'property',
      `property "${nameOrId}"`,
      notionUserReferencesFromPropertyValue(rawValue),
    );
  }
  out.__notion = rawProperties;
  return out;
}

async function copyImportedRowFileProperties(
  context: NotionFileCopyContext,
  page: Page,
  databaseId: string,
  rawProperties: unknown,
  propertyMappings: Map<string, string>,
  item: NotionImportItem,
) {
  if (!rawProperties || typeof rawProperties !== 'object') return page;
  const properties = page.properties && typeof page.properties === 'object'
    ? { ...page.properties }
    : {};
  let changed = false;

  for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
    const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
    const notionPropId = typeof prop.id === 'string' ? prop.id : nameOrId;
    const localPropId = propertyMappings.get(notionPropId) ?? propertyMappings.get(nameOrId);
    if (!localPropId) continue;
    const references = notionFilePropertyReferences(rawValue);
    if (references.length === 0) continue;
    const copied: unknown[] = [];
    for (const [index, reference] of references.entries()) {
      copied.push(await copyNotionFileReference(context, {
        notionId: notionPropId,
        notionObject: 'property',
        label: `file property "${nameOrId}" on "${item.title || item.notionId}"`,
        scope: 'database/files',
        pageId: page.id,
        databaseId,
        propertyId: localPropId,
        notionPageId: item.notionId,
        notionPropertyId: notionPropId,
        notionPropertyName: nameOrId,
        notionFileIndex: index,
        notionFileName: reference.name,
      }, reference));
    }
    properties[localPropId] = copied;
    changed = true;
  }

  if (!changed) return page;
  return context.db.table<Page>('pages').update(page.id, { properties });
}

function importedRowFilePropertiesNeedCopy(
  pageProperties: Record<string, unknown> | undefined,
  rawProperties: unknown,
  propertyMappings: Map<string, string>,
) {
  if (!rawProperties || typeof rawProperties !== 'object') return false;
  const properties = pageProperties && typeof pageProperties === 'object' ? pageProperties : {};
  for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
    const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
    const notionPropId = typeof prop.id === 'string' ? prop.id : nameOrId;
    const localPropId = propertyMappings.get(notionPropId) ?? propertyMappings.get(nameOrId);
    if (!localPropId) continue;
    const references = notionFilePropertyReferences(rawValue);
    if (references.length === 0) continue;
    const current = properties[localPropId];
    if (!Array.isArray(current) || current.length !== references.length) return true;
    const allStored = current.every((item) => {
      const record = asRecord(item);
      return !!record && (record.notionFileCopied === true || !!record.fileUploadId || !!record.uploadId || !!record.key);
    });
    if (!allStored) return true;
  }
  return false;
}

async function copyImportedPageChromeFiles(
  context: NotionFileCopyContext,
  page: Page,
  item: NotionImportItem,
) {
  const properties = asRecord(page.properties) ? { ...(page.properties as Record<string, unknown>) } : {};
  const patch: Partial<Page> = {};
  let propertiesChanged = false;

  const iconReference = storedNotionFileReference(properties[NOTION_PAGE_ICON_REFERENCE_KEY]);
  if (iconReference && page.iconType === 'image') {
    const copied = await copyNotionFileReference(context, {
      notionId: item.notionId,
      notionObject: 'page',
      label: `page icon on "${item.title || item.notionId}"`,
      scope: 'icons',
      pageId: page.id,
      notionPageId: item.notionId,
      notionPageFileKind: 'icon',
    }, iconReference);
    if (copied !== iconReference) {
      patch.icon = copied.url;
      properties[NOTION_PAGE_ICON_REFERENCE_KEY] = copied;
      propertiesChanged = true;
    }
  }

  const coverReference = storedNotionFileReference(properties[NOTION_PAGE_COVER_REFERENCE_KEY]);
  if (coverReference && page.cover) {
    const copied = await copyNotionFileReference(context, {
      notionId: item.notionId,
      notionObject: 'page',
      label: `page cover on "${item.title || item.notionId}"`,
      scope: 'covers',
      pageId: page.id,
      notionPageId: item.notionId,
      notionPageFileKind: 'cover',
    }, coverReference);
    if (copied !== coverReference) {
      patch.cover = copied.url;
      properties[NOTION_PAGE_COVER_REFERENCE_KEY] = copied;
      propertiesChanged = true;
    }
  }

  if (!propertiesChanged && Object.keys(patch).length === 0) return page;
  return context.db.table<Page>('pages').update(page.id, {
    ...patch,
    ...(propertiesChanged ? { properties } : {}),
  });
}

export interface ImportedPropertyContext {
  dataSourceId: string;
  notionPropertyId: string;
  notionPropertyName: string;
  notionProperty: Record<string, unknown>;
  property: DbProperty;
}

interface ImportedRowContext {
  page: Page;
  dataSourceId: string;
  notionId: string;
}

interface ImportedPageBlockContext {
  page: Page;
  notionId: string;
}

interface ImportedBlockMapping {
  localId: string;
  pageId: string;
}

interface ImportedBlockOwnerContext {
  pageNotionId: string;
  blockNotionId: string;
  blockType?: string;
  parentBlockNotionId?: string | null;
  position?: number;
}

interface ImportedTemplateContext {
  template: DbTemplate;
  dataSourceId: string;
  notionId?: string;
}

function contextKey(dataSourceId: string, propertyId: string) {
  return `${dataSourceId}\n${propertyId}`;
}

function remappedPropertyId(
  propertyMappingsByDataSource: Map<string, Map<string, string>>,
  dataSourceId: string | undefined,
  notionPropertyId: unknown,
) {
  if (!dataSourceId || typeof notionPropertyId !== 'string' || !notionPropertyId.trim()) return undefined;
  const propertyMappings = propertyMappingsByDataSource.get(dataSourceId);
  if (!propertyMappings) return undefined;
  for (const candidate of notionPropertyReferenceVariants(notionPropertyId)) {
    const localId = propertyMappings.get(candidate);
    if (localId) return localId;
  }
  return undefined;
}

function readFormulaStringLiteral(expression: string, index: number) {
  const quote = expression[index];
  if (quote !== '"' && quote !== "'") return undefined;
  let i = index + 1;
  let value = '';
  while (i < expression.length) {
    if (expression[i] === '\\') {
      if (i + 1 < expression.length) value += expression[i + 1];
      i += 2;
      continue;
    }
    if (expression[i] === quote) return { value, end: i + 1, quote };
    value += expression[i];
    i += 1;
  }
  return undefined;
}

function escapeFormulaStringLiteral(value: string, quote: string) {
  const escaped = value.replace(/\\/g, '\\\\');
  return quote === '"' ? escaped.replace(/"/g, '\\"') : escaped.replace(/'/g, "\\'");
}

const supportedFormulaFunctions = new Set([
  'prop',
  'if',
  'ifs',
  'let',
  'lets',
  'concat',
  'repeat',
  'format',
  'toNumber',
  'add',
  'subtract',
  'multiply',
  'divide',
  'mod',
  'pow',
  'min',
  'max',
  'sum',
  'mean',
  'median',
  'sqrt',
  'cbrt',
  'exp',
  'ln',
  'log10',
  'log2',
  'sign',
  'pi',
  'e',
  'lower',
  'upper',
  'trim',
  'startsWith',
  'endsWith',
  'substring',
  'replace',
  'replaceAll',
  'test',
  'now',
  'today',
  'dateAdd',
  'dateSubtract',
  'dateBetween',
  'dateRange',
  'parseDate',
  'dateStart',
  'dateEnd',
  'timestamp',
  'fromTimestamp',
  'formatDate',
  'year',
  'month',
  'day',
  'date',
  'week',
  'hour',
  'minute',
  'round',
  'floor',
  'ceil',
  'abs',
  'empty',
  'contains',
  'length',
  'not',
  'and',
  'or',
]);

function formulaFunctionReferences(expression: string) {
  const functions: string[] = [];
  const seen = new Set<string>();
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];
    if (ch === '"' || ch === "'") {
      const parsed = readFormulaStringLiteral(expression, i);
      i = parsed?.end ?? expression.length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < expression.length && /[A-Za-z0-9_]/.test(expression[i])) i += 1;
      const name = expression.slice(start, i);
      let next = i;
      while (next < expression.length && /\s/.test(expression[next])) next += 1;
      if (expression[next] === '(' && !seen.has(name)) {
        seen.add(name);
        functions.push(name);
      }
      continue;
    }

    i += 1;
  }

  return functions;
}

function unsupportedFormulaFunctions(expression: string) {
  return formulaFunctionReferences(expression).filter((name) => !supportedFormulaFunctions.has(name));
}

function formulaPropertyReferences(expression: string) {
  const references: string[] = [];
  const seen = new Set<string>();
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];
    if (ch === '"' || ch === "'") {
      const parsed = readFormulaStringLiteral(expression, i);
      i = parsed?.end ?? expression.length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < expression.length && /[A-Za-z0-9_]/.test(expression[i])) i += 1;
      const name = expression.slice(start, i);
      let next = i;
      while (next < expression.length && /\s/.test(expression[next])) next += 1;
      if (name !== 'prop' || expression[next] !== '(') continue;

      let argStart = next + 1;
      while (argStart < expression.length && /\s/.test(expression[argStart])) argStart += 1;
      const parsed = readFormulaStringLiteral(expression, argStart);
      if (!parsed) continue;
      let close = parsed.end;
      while (close < expression.length && /\s/.test(expression[close])) close += 1;
      if (expression[close] !== ')') continue;
      if (!seen.has(parsed.value)) {
        seen.add(parsed.value);
        references.push(parsed.value);
      }
      i = close + 1;
      continue;
    }

    i += 1;
  }

  return references;
}

function formulaContextByReference(
  contextsBySourceAndProperty: Map<string, ImportedPropertyContext>,
  dataSourceId: string,
  reference: string,
) {
  for (const candidate of notionPropertyReferenceVariants(reference)) {
    const context = contextsBySourceAndProperty.get(contextKey(dataSourceId, candidate));
    if (context) return context;
  }
  return undefined;
}

function readNotionBlockPropertyReference(expression: string, index: number) {
  const prefix = '{{notion:block_property:';
  if (!expression.startsWith(prefix, index)) return undefined;
  const end = expression.indexOf('}}', index + prefix.length);
  if (end === -1) return undefined;
  const body = expression.slice(index + prefix.length, end);
  const [propertyId, dataSourceId] = body.split(':');
  const reference = safeDecode(propertyId ?? '').trim();
  if (!reference) return undefined;
  return {
    reference,
    dataSourceId: safeDecode(dataSourceId ?? '').trim() || undefined,
    end: end + 2,
  };
}

export function remapFormulaExpressionPropertyReferences(
  expression: string,
  context: ImportedPropertyContext,
  contextsBySourceAndProperty: Map<string, ImportedPropertyContext>,
) {
  let remapped = 0;
  const unresolved: string[] = [];
  const unresolvedSeen = new Set<string>();
  let output = '';
  let i = 0;

  while (i < expression.length) {
    const notionBlockProperty = readNotionBlockPropertyReference(expression, i);
    if (notionBlockProperty) {
      const targetContext = formulaContextByReference(
        contextsBySourceAndProperty,
        notionBlockProperty.dataSourceId ?? context.dataSourceId,
        notionBlockProperty.reference,
      );
      const replacement = targetContext?.property.name;
      if (replacement) {
        output += `prop("${escapeFormulaStringLiteral(replacement, '"')}")`;
        remapped += 1;
      } else {
        output += expression.slice(i, notionBlockProperty.end);
        if (!unresolvedSeen.has(notionBlockProperty.reference)) {
          unresolvedSeen.add(notionBlockProperty.reference);
          unresolved.push(notionBlockProperty.reference);
        }
      }
      i = notionBlockProperty.end;
      continue;
    }

    const ch = expression[i];
    if (ch === '"' || ch === "'") {
      const parsed = readFormulaStringLiteral(expression, i);
      const end = parsed?.end ?? expression.length;
      output += expression.slice(i, end);
      i = end;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < expression.length && /[A-Za-z0-9_]/.test(expression[i])) i += 1;
      const name = expression.slice(start, i);
      let next = i;
      while (next < expression.length && /\s/.test(expression[next])) next += 1;

      if (name === 'prop' && expression[next] === '(') {
        let argStart = next + 1;
        while (argStart < expression.length && /\s/.test(expression[argStart])) argStart += 1;
        const parsed = readFormulaStringLiteral(expression, argStart);
        if (parsed) {
          let close = parsed.end;
          while (close < expression.length && /\s/.test(expression[close])) close += 1;
          if (expression[close] === ')') {
            const targetContext = formulaContextByReference(
              contextsBySourceAndProperty,
              context.dataSourceId,
              parsed.value,
            );
            const replacement = targetContext?.property.name;
            if (replacement && replacement !== parsed.value) {
              output += expression.slice(start, argStart);
              output += `${parsed.quote}${escapeFormulaStringLiteral(replacement, parsed.quote)}${parsed.quote}`;
              output += expression.slice(parsed.end, close + 1);
              remapped += 1;
              i = close + 1;
              continue;
            }
            if (!targetContext && !unresolvedSeen.has(parsed.value)) {
              unresolvedSeen.add(parsed.value);
              unresolved.push(parsed.value);
            }
          }
        }
      }

      output += expression.slice(start, i);
      continue;
    }

    output += ch;
    i += 1;
  }

  return { expression: output, remapped, unresolved };
}

function relationTargetDataSourceFromPropertyContext(context: ImportedPropertyContext | undefined) {
  if (!context) return undefined;
  const notionType = typeof context.notionProperty.type === 'string' ? context.notionProperty.type : '';
  return relationTargetNotionId(notionPropertyConfig(context.notionProperty, notionType));
}

async function remapImportedDatabaseProperties(
  db: DbRef,
  contexts: ImportedPropertyContext[],
  propertyMappingsByDataSource: Map<string, Map<string, string>>,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
) {
  const contextsBySourceAndProperty = new Map<string, ImportedPropertyContext>();
  for (const context of contexts) {
    for (const key of notionPropertyReferenceVariants(context.notionPropertyId)) {
      contextsBySourceAndProperty.set(contextKey(context.dataSourceId, key), context);
    }
    for (const key of notionPropertyReferenceVariants(context.notionPropertyName)) {
      contextsBySourceAndProperty.set(contextKey(context.dataSourceId, key), context);
    }
    for (const key of notionPropertyReferenceVariants(context.property.name)) {
      contextsBySourceAndProperty.set(contextKey(context.dataSourceId, key), context);
    }
    const notionName = typeof context.notionProperty.name === 'string' ? context.notionProperty.name.trim() : '';
    for (const key of notionPropertyReferenceVariants(notionName)) {
      contextsBySourceAndProperty.set(contextKey(context.dataSourceId, key), context);
    }
  }

  let remapped = 0;
  let unresolved = 0;
  for (const context of contexts) {
    const notionType = typeof context.notionProperty.type === 'string' ? context.notionProperty.type : '';
    const notionConfig = notionPropertyConfig(context.notionProperty, notionType);
    const config = { ...(context.property.config ?? {}) };
    let changed = false;

    if (context.property.type === 'relation') {
      const targetNotionId = relationTargetNotionId(notionConfig);
      const targetMapping = targetNotionId ? mappingsByNotionId.get(targetNotionId) : undefined;
      if (targetNotionId) {
        config.relationTargetNotionId = targetNotionId;
        if (targetMapping?.localType === 'database') {
          config.relationDatabaseId = targetMapping.localId;
          delete config.unresolvedRelationTargetNotionId;
          remapped += 1;
        } else {
          config.unresolvedRelationTargetNotionId = targetNotionId;
          unresolved += 1;
        }
        changed = true;
      }
    }

    if (context.property.type === 'rollup') {
      const relationPropertyNotionId = typeof notionConfig.relation_property_id === 'string'
        ? notionConfig.relation_property_id
        : undefined;
      const targetPropertyNotionId = typeof notionConfig.rollup_property_id === 'string'
        ? notionConfig.rollup_property_id
        : undefined;
      const relationPropertyLocalId = remappedPropertyId(
        propertyMappingsByDataSource,
        context.dataSourceId,
        relationPropertyNotionId,
      );
      const relationContext = relationPropertyNotionId
        ? contextsBySourceAndProperty.get(contextKey(context.dataSourceId, relationPropertyNotionId))
        : undefined;
      const targetDataSourceId = relationTargetDataSourceFromPropertyContext(relationContext);
      const targetPropertyLocalId =
        remappedPropertyId(propertyMappingsByDataSource, targetDataSourceId, targetPropertyNotionId) ??
        remappedPropertyId(propertyMappingsByDataSource, context.dataSourceId, targetPropertyNotionId);

      if (relationPropertyNotionId) {
        config.rollupRelationPropertyNotionId = relationPropertyNotionId;
        if (relationPropertyLocalId) config.rollupRelationPropertyId = relationPropertyLocalId;
        else {
          config.unresolvedRollupRelationPropertyNotionId = relationPropertyNotionId;
          unresolved += 1;
        }
      }
      if (targetPropertyNotionId) {
        config.rollupTargetPropertyNotionId = targetPropertyNotionId;
        if (targetPropertyLocalId) config.rollupTargetPropertyId = targetPropertyLocalId;
        else {
          config.unresolvedRollupTargetPropertyNotionId = targetPropertyNotionId;
          unresolved += 1;
        }
      }
      if (targetDataSourceId) config.rollupTargetDataSourceNotionId = targetDataSourceId;
      if (typeof notionConfig.function === 'string') config.rollupFunction = notionConfig.function;
      changed = true;
      if (relationPropertyLocalId || targetPropertyLocalId) remapped += 1;
    }

    if (context.property.type === 'formula') {
      const expression = typeof notionConfig.expression === 'string' ? notionConfig.expression : '';
      const formulaRemap = remapFormulaExpressionPropertyReferences(expression, context, contextsBySourceAndProperty);
      const unsupportedFunctions = unsupportedFormulaFunctions(expression);
      config.formula = formulaRemap.expression;
      config.notionFormula = notionConfig;
      if (formulaRemap.expression !== expression) config.notionFormulaExpression = expression;
      if (unsupportedFunctions.length > 0) {
        config.unsupportedFormulaFunctions = unsupportedFunctions;
        if (conversionReport) {
          reportUnsupportedFormulaFunctions(
            conversionReport,
            context.dataSourceId,
            context.notionPropertyId,
            context.property.name,
            unsupportedFunctions,
          );
        }
      } else {
        delete config.unsupportedFormulaFunctions;
      }
      if (formulaRemap.unresolved.length > 0) {
        config.unresolvedFormulaPropertyReferences = formulaRemap.unresolved;
        unresolved += formulaRemap.unresolved.length;
        for (const referencedProperty of formulaRemap.unresolved) {
          if (conversionReport) {
            reportUnresolvedFormulaPropertyReference(
              conversionReport,
              context.dataSourceId,
              context.notionPropertyId,
              context.property.name,
              referencedProperty,
            );
          }
        }
      } else {
        delete config.unresolvedFormulaPropertyReferences;
      }
      remapped += formulaRemap.remapped;
      changed = true;
    }

    if (!changed) continue;
    const updated = await db.table<DbProperty>('db_properties').update(context.property.id, {
      config,
    });
    context.property = updated;
  }

  return { remapped, unresolved };
}

function richTextMentionTargetIds(span: Record<string, unknown>) {
  const ids = [
    optionalString(span.notionPageId),
    optionalString(span.notionDatabaseId),
    optionalString(span.notionDataSourceId),
  ];
  const mention = asRecord(span.notionMention);
  for (const key of ['page', 'database', 'data_source']) {
    const target = asRecord(mention?.[key]);
    ids.push(optionalString(target?.id));
  }
  return Array.from(new Set(ids.filter((id): id is string => !!id)));
}

export function remapImportedRichTextMentionSpans(
  value: unknown,
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  if (!Array.isArray(value)) {
    return { value, changed: false, remapped: 0, unresolved: [] as string[] };
  }

  let changed = false;
  let remapped = 0;
  const unresolved: string[] = [];
  const spans = value.map((item) => {
    const span = asRecord(item);
    if (!span || typeof span.text !== 'string') return item;
    const targetIds = richTextMentionTargetIds(span);
    if (targetIds.length === 0) return item;
    const mapping = targetIds
      .map((targetId) => mappingsByNotionId.get(targetId))
      .find((candidate) => candidate?.localType === 'page' || candidate?.localType === 'database');
    if (!mapping) {
      unresolved.push(...targetIds);
      return item;
    }
    if (
      span.mention === 'page' &&
      span.pageId === mapping.localId &&
      span.notionMentionLocalId === mapping.localId
    ) {
      return item;
    }
    changed = true;
    remapped += 1;
    return {
      ...span,
      mention: 'page',
      pageId: mapping.localId,
      notionMentionLocalId: mapping.localId,
      notionMentionLocalType: mapping.localType,
    };
  });

  return {
    value: spans,
    changed,
    remapped,
    unresolved: Array.from(new Set(unresolved)),
  };
}

function remapImportedRichTextMentionsInContent(
  content: Record<string, unknown> | undefined,
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  if (!content) {
    return { content, changed: false, remapped: 0, unresolved: [] as string[] };
  }
  const next = { ...content };
  let changed = false;
  let remapped = 0;
  const unresolved: string[] = [];
  for (const key of ['rich', 'caption']) {
    const result = remapImportedRichTextMentionSpans(next[key], mappingsByNotionId);
    if (result.changed) {
      next[key] = result.value;
      changed = true;
    }
    remapped += result.remapped;
    unresolved.push(...result.unresolved);
  }
  return {
    content: changed ? next : content,
    changed,
    remapped,
    unresolved: Array.from(new Set(unresolved)),
  };
}

function remapImportedTemplateBlocksRichTextMentions(
  blocks: TemplateBlock[] | undefined,
  mappingsByNotionId: Map<string, NotionImportMapping>,
): {
  blocks: TemplateBlock[] | undefined;
  changed: boolean;
  remapped: number;
  unresolved: string[];
} {
  if (!Array.isArray(blocks)) {
    return { blocks, changed: false, remapped: 0, unresolved: [] as string[] };
  }
  let changed = false;
  let remapped = 0;
  const unresolved: string[] = [];
  const nextBlocks = blocks.map((block) => {
    const contentResult = remapImportedRichTextMentionsInContent(block.content, mappingsByNotionId);
    const childResult = remapImportedTemplateBlocksRichTextMentions(block.children, mappingsByNotionId);
    remapped += contentResult.remapped + childResult.remapped;
    unresolved.push(...contentResult.unresolved, ...childResult.unresolved);
    if (!contentResult.changed && !childResult.changed) return block;
    changed = true;
    return {
      ...block,
      ...(contentResult.changed ? { content: contentResult.content } : {}),
      ...(childResult.changed ? { children: childResult.blocks } : {}),
    };
  });
  return {
    blocks: changed ? nextBlocks : blocks,
    changed,
    remapped,
    unresolved: Array.from(new Set(unresolved)),
  };
}

function reportRichTextMentionRemap(
  report: ImportConversionReport | undefined,
  notionId: string | undefined,
  notionObject: string,
  label: string,
  result: { remapped: number; unresolved: string[] },
  options: { reportUnresolved?: boolean } = {},
) {
  if (!report) return;
  if (result.remapped > 0) incrementReport(report, 'remappedRichTextMentions', result.remapped);
  if (options.reportUnresolved === false) return;
  if (result.unresolved.length === 0) return;
  incrementReport(report, 'unresolvedRichTextMentions', result.unresolved.length);
  pushReportIssue(report.unresolvedReferences, {
    code: 'rich_text_mention_unresolved',
    notionId,
    notionObject,
    message:
      `${result.unresolved.length} rich text page/database mention(s) from ${label} ` +
      'could not be mapped to local pages or databases.',
  });
}

async function remapImportedPageBlockRichTextMentions(
  db: DbRef,
  pages: ImportedPageBlockContext[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
) {
  let updatedBlocks = 0;

  for (const context of pages) {
    const blocks = await listAll(db.table<Block>('blocks').where('pageId', '==', context.page.id), 1000);
    for (const block of blocks) {
      const result = remapImportedRichTextMentionsInContent(block.content, mappingsByNotionId);
      const buttonTemplateRemap = remapImportedTemplateBlocksRichTextMentions(
        block.content?.buttonTemplate as TemplateBlock[] | undefined,
        mappingsByNotionId,
      );
      if (result.changed || buttonTemplateRemap.changed) {
        await db.table<Block>('blocks').update(block.id, {
          content: {
            ...((result.content ?? block.content) ?? {}),
            ...(buttonTemplateRemap.changed ? { buttonTemplate: buttonTemplateRemap.blocks } : {}),
          },
        });
        updatedBlocks += 1;
      }
      const notionBlock = asRecord(block.content?.notionBlock);
      reportRichTextMentionRemap(
        conversionReport,
        notionObjectId(notionBlock ?? {}) ?? context.notionId,
        'block',
        `block on "${context.page.title || context.notionId}"`,
        result,
      );
      reportRichTextMentionRemap(
        conversionReport,
        notionObjectId(notionBlock ?? {}) ?? context.notionId,
        'block',
        `button template block on "${context.page.title || context.notionId}"`,
        buttonTemplateRemap,
      );
    }
  }

  return updatedBlocks;
}

function importLinkedTargetIdsFromBlockContent(block: Block) {
  const content = asRecord(block.content);
  const linked = asRecord(content?.notionLinkedDatabase);
  return Array.from(new Set([
    ...stringArray(content?.notionLinkedTargetIds),
    ...stringArray(linked?.targetIds),
    ...idsFromRecordArray(linked?.targetReferences),
  ]));
}

async function remapImportedPageLinkBlocks(
  db: DbRef,
  pages: ImportedPageBlockContext[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
) {
  const linkBlockTypes = new Set(['inline_database', 'child_database', 'child_page', 'link_to_page']);
  const pageTable = db.table<Page>('pages');
  const pageCache = new Map<string, Page | null>();
  let updatedBlocks = 0;
  let remappedTargets = 0;
  let unresolvedTargets = 0;

  const linkedPageSnapshot = async (localPageId: string) => {
    if (!pageCache.has(localPageId)) {
      pageCache.set(localPageId, await getExisting(pageTable, localPageId));
    }
    return pageCache.get(localPageId) ?? null;
  };

  for (const context of pages) {
    const blocks = await listAll(db.table<Block>('blocks').where('pageId', '==', context.page.id), 1000);
    for (const block of blocks) {
      if (!linkBlockTypes.has(block.type)) continue;
      const targetIds = importLinkedTargetIdsFromBlockContent(block);
      if (targetIds.length === 0) continue;
      const wantsDatabaseTarget = block.type === 'inline_database' || block.type === 'child_database';
      const linked = targetIds
        .map((targetId) => mappingForNotionId(mappingsByNotionId, targetId))
        .find((mapping) =>
          wantsDatabaseTarget
            ? mapping?.localType === 'database'
            : mapping?.localType === 'page',
        );
      if (!linked) {
        unresolvedTargets += 1;
        if (conversionReport) {
          pushReportIssue(conversionReport.unresolvedReferences, {
            code: 'linked_target_unresolved',
            notionId: targetIds[0],
            notionObject: 'block',
            message: `Linked ${wantsDatabaseTarget ? 'database' : 'page'} target on "${context.page.title || context.notionId}" could not be mapped locally.`,
          });
        }
        continue;
      }

      const linkedPage = await linkedPageSnapshot(linked.localId);
      const mappedContent = withLinkedDatabaseLocalMapping(block.content, {
        localTargetId: linked.localId,
        localTargetType: linked.localType,
      }) ?? block.content ?? {};
      const nextContent: Record<string, unknown> = {
        ...mappedContent,
        childPageId: linked.localId,
      };
      if (linkedPage?.title !== undefined) nextContent.childPageTitle = linkedPage.title;
      if (linkedPage?.kind !== undefined) nextContent.childPageKind = linkedPage.kind;
      if (linkedPage?.icon) nextContent.childPageIcon = linkedPage.icon;
      else delete nextContent.childPageIcon;
      if (linkedPage?.iconType) nextContent.childPageIconType = linkedPage.iconType;
      else delete nextContent.childPageIconType;

      if (jsonEquivalent(nextContent, block.content)) continue;
      await db.table<Block>('blocks').update(block.id, { content: nextContent });
      updatedBlocks += 1;
      remappedTargets += 1;
    }
  }

  if (conversionReport) {
    if (remappedTargets > 0) incrementReport(conversionReport, 'remappedLinkedTargets', remappedTargets);
    if (unresolvedTargets > 0) incrementReport(conversionReport, 'unresolvedLinkedTargets', unresolvedTargets);
  }

  return { updatedBlocks, remappedTargets, unresolvedTargets };
}

function syncedBlockSourceNotionId(block: Block) {
  const content = asRecord(block.content) ?? {};
  const stored = optionalString(content.notionSyncedBlockSourceId);
  if (stored) return stored;
  const notionBlock = asRecord(content.notionBlock);
  const payload = asRecord(notionBlock?.synced_block) ?? asRecord(notionBlock?.syncedBlock);
  return notionSyncedBlockSourceId('synced_block', payload ?? {});
}

async function remapImportedSyncedBlocks(
  db: DbRef,
  pages: ImportedPageBlockContext[],
  blockMappingsByNotionId: Map<string, ImportedBlockMapping>,
  conversionReport?: ImportConversionReport,
) {
  let remapped = 0;
  let unresolved = 0;

  for (const context of pages) {
    const blocks = await listAll(db.table<Block>('blocks').where('pageId', '==', context.page.id), 1000);
    for (const block of blocks) {
      if (block.type !== 'synced_block') continue;
      const sourceNotionId = syncedBlockSourceNotionId(block);
      if (!sourceNotionId) continue;
      const source = blockMappingsByNotionId.get(sourceNotionId);
      if (!source) {
        unresolved += 1;
        if (conversionReport) {
          pushReportIssue(conversionReport.unresolvedReferences, {
            code: 'synced_block_source_unresolved',
            notionId: sourceNotionId,
            notionObject: 'block',
            message: `Synced block source on "${context.page.title || context.notionId}" could not be mapped locally.`,
          });
        }
        continue;
      }

      await db.table<Block>('blocks').update(block.id, {
        content: {
          ...(block.content ?? {}),
          syncedBlockId: source.localId,
          syncedPageId: source.pageId,
        },
      });
      remapped += 1;
    }
  }

  if (conversionReport) {
    if (remapped > 0) incrementReport(conversionReport, 'remappedSyncedBlocks', remapped);
    if (unresolved > 0) incrementReport(conversionReport, 'unresolvedSyncedBlocks', unresolved);
  }

  return { remapped, unresolved };
}

export function remapImportedRowRelationProperties(
  row: Page,
  relationProps: DbProperty[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  const properties = row.properties && typeof row.properties === 'object'
    ? { ...row.properties }
    : {};
  let changed = false;
  const unresolved: Record<string, string[]> = {};

  for (const prop of relationProps) {
    const value = properties[prop.id];
    const notionIds = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (notionIds.length === 0) continue;

    const localIds: string[] = [];
    const unresolvedIds: string[] = [];
    for (const notionId of notionIds) {
      const mapping = mappingsByNotionId.get(notionId);
      if (mapping?.localType === 'page') localIds.push(mapping.localId);
      else unresolvedIds.push(notionId);
    }
    if (localIds.length > 0 || unresolvedIds.length > 0) {
      properties[prop.id] = localIds;
      changed = true;
    }
    if (unresolvedIds.length > 0) unresolved[prop.id] = unresolvedIds;
  }

  if (Object.keys(unresolved).length > 0) {
    properties.__notionRelationUnresolved = unresolved;
    changed = true;
  }

  return changed ? properties : undefined;
}

function remapImportedTemplateRelationProperties(
  template: DbTemplate,
  relationProps: DbProperty[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  const properties = template.properties && typeof template.properties === 'object'
    ? { ...template.properties }
    : {};
  let changed = false;
  const unresolved: Record<string, string[]> = {};

  for (const prop of relationProps) {
    const value = properties[prop.id];
    const notionIds = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (notionIds.length === 0) continue;

    const localIds: string[] = [];
    const unresolvedIds: string[] = [];
    for (const notionId of notionIds) {
      const mapping = mappingsByNotionId.get(notionId);
      if (mapping?.localType === 'page') localIds.push(mapping.localId);
      else unresolvedIds.push(notionId);
    }
    if (localIds.length > 0 || unresolvedIds.length > 0) {
      properties[prop.id] = localIds;
      changed = true;
    }
    if (unresolvedIds.length > 0) unresolved[prop.id] = unresolvedIds;
  }

  return {
    properties: changed ? properties : undefined,
    unresolved,
  };
}

function isLocalImportedPageId(value: string, localPageIds: Set<string>) {
  return localPageIds.has(value);
}

function currentPageFilterValue() {
  return { kind: 'notionlike.current_page' };
}

function remapImportedViewRelationFilterValue(
  value: unknown,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  localPageIds: Set<string>,
): { value: unknown; changed: boolean; remapped: number; unresolved: string[] } {
  if (Array.isArray(value)) {
    let changed = false;
    let remapped = 0;
    const unresolved: string[] = [];
    const next = value.map((item) => {
      const result = remapImportedViewRelationFilterValue(item, mappingsByNotionId, localPageIds);
      if (result.changed) changed = true;
      remapped += result.remapped;
      unresolved.push(...result.unresolved);
      return result.value;
    });
    return { value: changed ? next : value, changed, remapped, unresolved };
  }

  const notionId = optionalString(value);
  if (!notionId) return { value, changed: false, remapped: 0, unresolved: [] as string[] };
  if (isLocalImportedPageId(notionId, localPageIds)) {
    return { value, changed: false, remapped: 0, unresolved: [] as string[] };
  }

  const mapping = mappingForNotionId(mappingsByNotionId, notionId);
  if (mapping?.localType === 'db_template') {
    return {
      value: currentPageFilterValue(),
      changed: true,
      remapped: 1,
      unresolved: [] as string[],
    };
  }

  const localId = mapping?.localType === 'page' ? mapping.localId : undefined;
  if (!localId) return { value, changed: false, remapped: 0, unresolved: [notionId] };
  return {
    value: localId,
    changed: localId !== value,
    remapped: localId !== value ? 1 : 0,
    unresolved: [] as string[],
  };
}

function importedViewFilterValueHasLocalPageMapping(
  value: unknown,
  mappingsByNotionId: Map<string, NotionImportMapping>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => importedViewFilterValueHasLocalPageMapping(item, mappingsByNotionId));
  }
  const notionId = optionalString(value);
  return !!notionId && !!localPageIdForNotionId(mappingsByNotionId, notionId);
}

function importedViewFilterValueLooksLikeNotionId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => importedViewFilterValueLooksLikeNotionId(item));
  const normalized = normalizedNotionId(value);
  return normalized.length === 32;
}

function remapImportedViewRelationFilterTerm(
  term: unknown,
  relationPropsById: Map<string, DbProperty>,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  localPageIds: Set<string>,
): { term: unknown; changed: boolean; remapped: number; unresolved: string[] } {
  const record = asRecord(term);
  if (!record) return { term, changed: false, remapped: 0, unresolved: [] };

  if (typeof record.conjunction === 'string') {
    let changed = false;
    let remapped = 0;
    const unresolved: string[] = [];
    const next: Record<string, unknown> = { ...record };

    if (Array.isArray(record.filters)) {
      const filters = record.filters.map((filter) => {
        const result = remapImportedViewRelationFilterTerm(
          filter,
          relationPropsById,
          mappingsByNotionId,
          localPageIds,
        );
        if (result.changed) changed = true;
        remapped += result.remapped;
        unresolved.push(...result.unresolved);
        return result.term;
      });
      if (changed) next.filters = filters;
    }

    if (Array.isArray(record.groups)) {
      const groupResults = record.groups.map((group) =>
        remapImportedViewRelationFilterTerm(group, relationPropsById, mappingsByNotionId, localPageIds)
      );
      const groupsChanged = groupResults.some((result) => result.changed);
      if (groupsChanged) changed = true;
      for (const result of groupResults) {
        remapped += result.remapped;
        unresolved.push(...result.unresolved);
      }
      if (groupsChanged) next.groups = groupResults.map((result) => result.term);
    }

    return {
      term: changed ? next : term,
      changed,
      remapped,
      unresolved: Array.from(new Set(unresolved)),
    };
  }

  const propertyId = optionalString(record.propertyId);
  const prop = propertyId ? relationPropsById.get(propertyId) : undefined;
  if (!propertyId || !prop || !Object.prototype.hasOwnProperty.call(record, 'value')) {
    return { term, changed: false, remapped: 0, unresolved: [] };
  }
  if (
    prop.type === 'rollup' &&
    !importedViewFilterValueHasLocalPageMapping(record.value, mappingsByNotionId) &&
    !importedViewFilterValueLooksLikeNotionId(record.value)
  ) {
    return { term, changed: false, remapped: 0, unresolved: [] };
  }

  const valueResult = remapImportedViewRelationFilterValue(record.value, mappingsByNotionId, localPageIds);
  return {
    term: valueResult.changed ? { ...record, value: valueResult.value } : term,
    changed: valueResult.changed,
    remapped: valueResult.remapped,
    unresolved: Array.from(new Set(valueResult.unresolved)),
  };
}

export function remapImportedViewRelationFilterConfig(
  config: unknown,
  relationPropsById: Map<string, DbProperty>,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  localPageIds: Set<string>,
) {
  const record = asRecord(config);
  if (!record || relationPropsById.size === 0) {
    return { config, changed: false, remapped: 0, unresolved: [] as string[] };
  }

  let changed = false;
  let remapped = 0;
  const unresolved: string[] = [];
  const next: Record<string, unknown> = { ...record };

  if (record.filterGroup !== undefined) {
    const result = remapImportedViewRelationFilterTerm(
      record.filterGroup,
      relationPropsById,
      mappingsByNotionId,
      localPageIds,
    );
    if (result.changed) {
      next.filterGroup = result.term;
      changed = true;
    }
    remapped += result.remapped;
    unresolved.push(...result.unresolved);
  }

  if (Array.isArray(record.filters)) {
    const filterResults = record.filters.map((term) =>
      remapImportedViewRelationFilterTerm(term, relationPropsById, mappingsByNotionId, localPageIds)
    );
    if (filterResults.some((result) => result.changed)) {
      next.filters = filterResults.map((result) => result.term);
      changed = true;
    }
    for (const result of filterResults) {
      remapped += result.remapped;
      unresolved.push(...result.unresolved);
    }
  }

  if (Array.isArray(record.quickFilters)) {
    const quickFilterResults = record.quickFilters.map((term) =>
      remapImportedViewRelationFilterTerm(term, relationPropsById, mappingsByNotionId, localPageIds)
    );
    if (quickFilterResults.some((result) => result.changed)) {
      next.quickFilters = quickFilterResults.map((result) => result.term);
      changed = true;
    }
    for (const result of quickFilterResults) {
      remapped += result.remapped;
      unresolved.push(...result.unresolved);
    }
  }

  if (
    next.filterGroup !== undefined ||
    Array.isArray(next.filters) ||
    Array.isArray(next.quickFilters)
  ) {
    const mergedFilterGroup = existingImportedViewFilterGroupForContext(next);
    if (mergedFilterGroup) {
      next.filterGroup = mergedFilterGroup;
      delete next.filters;
      delete next.filterConjunction;
      delete next.quickFilters;
      changed = true;
    }
  }

  return {
    config: changed ? next : config,
    changed,
    remapped,
    unresolved: Array.from(new Set(unresolved)),
  };
}

async function remapImportedDatabaseViewRelationFilters(
  db: DbRef,
  dataSourceItems: NotionImportItem[],
  propertyRecordsByDataSource: Map<string, DbProperty[]>,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
) {
  const localPageIds = new Set(
    Array.from(mappingsByNotionId.values())
      .filter((mapping) => mapping.localType === 'page')
      .map((mapping) => mapping.localId),
  );
  let updatedViews = 0;
  let remapped = 0;
  let unresolved = 0;

  for (const item of dataSourceItems) {
    const databaseMapping = mappingsByNotionId.get(item.notionId);
    if (databaseMapping?.localType !== 'database') continue;
    const relationProps = (propertyRecordsByDataSource.get(item.notionId) ?? [])
      .filter((prop) => prop.type === 'relation' || prop.type === 'rollup');
    if (relationProps.length === 0) continue;
    const relationPropsById = new Map(relationProps.map((prop) => [prop.id, prop]));
    const views = await listAll(db.table<DbView>('db_views').where('databaseId', '==', databaseMapping.localId), 1000);

    for (const view of views) {
      const result = remapImportedViewRelationFilterConfig(
        view.config,
        relationPropsById,
        mappingsByNotionId,
        localPageIds,
      );
      remapped += result.remapped;
      unresolved += result.unresolved.length;

      if (result.changed) {
        await db.table<DbView>('db_views').update(view.id, { config: result.config as Record<string, unknown> });
        updatedViews += 1;
      }

      if (conversionReport && result.unresolved.length > 0) {
        pushReportIssue(conversionReport.unresolvedReferences, {
          code: 'view_relation_filter_values_unresolved',
          notionId: optionalString(asRecord(view.config)?.notionViewId) ?? item.notionId,
          notionObject: 'view',
          message:
            `${result.unresolved.length} relation filter value(s) on imported view "${view.name || view.id}" ` +
            'could not be mapped to local row pages.',
        });
      }
    }
  }

  if (conversionReport) {
    if (remapped > 0) incrementReport(conversionReport, 'remappedViewRelationFilterValues', remapped);
    if (unresolved > 0) incrementReport(conversionReport, 'unresolvedViewRelationFilterValues', unresolved);
  }

  return { updatedViews, remapped, unresolved };
}

const IMPORTED_ROW_CONTEXT_FILTER_MARKER = 'notionlikeImportedRowContextFilter';

function importedRelationTargetLocalDatabaseId(prop: DbProperty) {
  const value = prop.config?.relationDatabaseId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function importedRelationTargetNotionId(prop: DbProperty) {
  const value = prop.config?.relationTargetNotionId ?? prop.config?.unresolvedRelationTargetNotionId;
  return normalizedNotionId(value);
}

function importedPageNotionDatabaseId(page: Page) {
  return optionalString(page.properties?.notionDatabaseId);
}

function importedPageNotionDataSourceId(page: Page) {
  return optionalString(page.properties?.notionDataSourceId);
}

function importedRelationTargetsDatabase(prop: DbProperty, database: Page) {
  if (prop.type !== 'relation') return false;
  const localTargetId = importedRelationTargetLocalDatabaseId(prop);
  if (localTargetId && localTargetId === database.id) return true;
  const targetNotionId = importedRelationTargetNotionId(prop);
  const databaseNotionId = normalizedNotionId(
    importedPageNotionDataSourceId(database) ?? importedPageNotionDatabaseId(database),
  );
  return !!targetNotionId && !!databaseNotionId && targetNotionId === databaseNotionId;
}

function importedRelationContainsFilter(propertyId: string, value: unknown): ViewFilterTerm {
  return {
    propertyId,
    operator: 'contains',
    value,
  };
}

function importedRelationFilterGroup(filters: ViewFilterTerm[]): FilterGroupTerm | undefined {
  if (filters.length === 0) return undefined;
  return {
    conjunction: filters.length > 1 ? 'or' : 'and',
    filters,
    groups: [],
  };
}

function importedRelationValueIds(value: unknown): string[] {
  const out: string[] = [];
  const push = (item: unknown) => {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
      return;
    }
    const id = optionalString(asRecord(item)?.id);
    if (id) out.push(id);
  };
  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else {
    push(value);
  }
  return Array.from(new Set(out));
}

function importedFilterValueHasCurrentPage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => importedFilterValueHasCurrentPage(item));
  return asRecord(value)?.kind === 'notionlike.current_page';
}

function importedKnownFilterTerm(term: unknown) {
  const record = asRecord(term);
  if (!record) return undefined;
  if (typeof record.conjunction === 'string') return record;
  return typeof record.propertyId === 'string' && typeof record.operator === 'string'
    ? record
    : undefined;
}

function importedFilterGroupFromTerms(terms: unknown[]) {
  const filters: Record<string, unknown>[] = [];
  const groups: Record<string, unknown>[] = [];
  for (const term of terms) {
    const known = importedKnownFilterTerm(term);
    if (!known) continue;
    if (typeof known.conjunction === 'string') groups.push(known);
    else filters.push(known);
  }
  if (filters.length === 0 && groups.length === 0) return undefined;
  return {
    conjunction: 'and',
    filters,
    groups,
  };
}

function mergeImportedFilterGroups(...groups: Array<unknown | undefined>) {
  const knownGroups = groups
    .map((group) => importedKnownFilterTerm(group))
    .filter((group): group is Record<string, unknown> => !!group)
    .map((group) =>
      typeof group.conjunction === 'string'
        ? group
        : { conjunction: 'and', filters: [group], groups: [] },
    );
  if (knownGroups.length === 0) return undefined;
  if (knownGroups.length === 1) return knownGroups[0];
  return {
    conjunction: 'and',
    filters: [],
    groups: knownGroups,
  };
}

function existingImportedViewFilterGroupForContext(config: Record<string, unknown>) {
  const groups: unknown[] = [];
  const filterGroup = importedKnownFilterTerm(config.filterGroup);
  const hasStoredFilterGroup = !!filterGroup;
  if (filterGroup) groups.push(filterGroup);

  const filters = !hasStoredFilterGroup && Array.isArray(config.filters)
    ? config.filters
        .map((filter) => importedKnownFilterTerm(filter))
        .filter((filter): filter is Record<string, unknown> => !!filter && typeof filter.conjunction !== 'string')
    : [];
  if (filters.length) {
    groups.push({
      conjunction: config.filterConjunction === 'or' ? 'or' : 'and',
      filters,
      groups: [],
    });
  }

  if (Array.isArray(config.quickFilters)) {
    const quickGroup = importedFilterGroupFromTerms(config.quickFilters);
    if (quickGroup) groups.push(quickGroup);
  }
  return mergeImportedFilterGroups(...groups);
}

function importedViewFilterTermHasRelationValue(
  term: unknown,
  relationPropsById: Map<string, DbProperty>,
): boolean {
  const record = asRecord(term);
  if (!record) return false;
  if (typeof record.conjunction === 'string') {
    return [
      ...(Array.isArray(record.filters) ? record.filters : []),
      ...(Array.isArray(record.groups) ? record.groups : []),
    ].some((child) => importedViewFilterTermHasRelationValue(child, relationPropsById));
  }

  const propertyId = optionalString(record.propertyId);
  const prop = propertyId ? relationPropsById.get(propertyId) : undefined;
  if (!prop || (prop.type !== 'relation' && prop.type !== 'rollup')) return false;
  if (importedFilterValueHasCurrentPage(record.value)) return true;
  return importedRelationValueIds(record.value).length > 0;
}

function importedViewConfigHasRelationValueFilter(config: unknown, sourceProperties: DbProperty[]) {
  const record = asRecord(config);
  if (!record) return false;
  const relationPropsById = new Map(
    sourceProperties
      .filter((prop) => prop.type === 'relation' || prop.type === 'rollup')
      .map((prop) => [prop.id, prop]),
  );
  if (relationPropsById.size === 0) return false;
  return importedViewFilterTermHasRelationValue(
    existingImportedViewFilterGroupForContext(record),
    relationPropsById,
  );
}

function addImportedContextFilterToViewConfig(config: unknown, contextFilter: FilterGroupTerm) {
  const record = asRecord(config) ?? {};
  if (record[IMPORTED_ROW_CONTEXT_FILTER_MARKER] === true) return config;
  const existing = existingImportedViewFilterGroupForContext(record);
  const filterGroup = existing
    ? {
        conjunction: 'and',
        filters: [],
        groups: [contextFilter, existing],
      }
    : contextFilter;

  return {
    ...record,
    filterGroup,
    filters: undefined,
    filterConjunction: undefined,
    [IMPORTED_ROW_CONTEXT_FILTER_MARKER]: true,
  };
}

async function importedRowsRelatedToParentRow(
  db: DbRef,
  intermediateDatabase: Page,
  parentRow: Page,
  intermediateRelationProps: DbProperty[],
) {
  if (intermediateRelationProps.length === 0) return [];
  const rows = await listAll(db.table<Page>('pages').where('parentId', '==', intermediateDatabase.id), 5000);
  return rows
    .filter((row) =>
      row.parentType === 'database' &&
      !row.inTrash &&
      intermediateRelationProps.some((prop) =>
        importedRelationValueIds(row.properties?.[prop.id]).includes(parentRow.id)
      )
    )
    .map((row) => row.id);
}

async function importedLinkedDatabaseRowContextFilterForApply(
  db: DbRef,
  parentRow: Page,
  parentDatabase: Page,
  sourceDatabase: Page,
  sourceProperties: DbProperty[],
  propertyCache: Map<string, DbProperty[]>,
  pageCache: Map<string, Page | null>,
) {
  if (sourceDatabase.workspaceId !== parentRow.workspaceId || parentDatabase.workspaceId !== parentRow.workspaceId) {
    return undefined;
  }

  const directFilters = sourceProperties
    .filter((prop) => importedRelationTargetsDatabase(prop, parentDatabase))
    .map((prop) => importedRelationContainsFilter(prop.id, parentRow.id));
  const directGroup = importedRelationFilterGroup(directFilters);
  if (directGroup) return directGroup;

  const indirectFilters: ViewFilterTerm[] = [];
  for (const sourceProp of sourceProperties.filter((prop) => prop.type === 'relation')) {
    const intermediateDatabaseId = importedRelationTargetLocalDatabaseId(sourceProp);
    if (!intermediateDatabaseId) continue;
    if (!pageCache.has(intermediateDatabaseId)) {
      pageCache.set(intermediateDatabaseId, await getExisting(db.table<Page>('pages'), intermediateDatabaseId));
    }
    const intermediateDatabase = pageCache.get(intermediateDatabaseId);
    if (
      !intermediateDatabase ||
      intermediateDatabase.inTrash ||
      intermediateDatabase.kind !== 'database' ||
      intermediateDatabase.workspaceId !== parentRow.workspaceId
    ) {
      continue;
    }
    if (!propertyCache.has(intermediateDatabase.id)) {
      propertyCache.set(
        intermediateDatabase.id,
        await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', intermediateDatabase.id)),
      );
    }
    const intermediateRelationProps = (propertyCache.get(intermediateDatabase.id) ?? [])
      .filter((prop) => importedRelationTargetsDatabase(prop, parentDatabase));
    const targets = await importedRowsRelatedToParentRow(
      db,
      intermediateDatabase,
      parentRow,
      intermediateRelationProps,
    );
    if (targets.length > 0) {
      indirectFilters.push(importedRelationContainsFilter(sourceProp.id, targets.length === 1 ? targets[0] : targets));
    }
  }

  return importedRelationFilterGroup(indirectFilters);
}

async function addImportedLinkedDatabaseRowContextFilters(
  db: DbRef,
  pages: ImportedPageBlockContext[],
  conversionReport?: ImportConversionReport,
) {
  const pagesTable = db.table<Page>('pages');
  const viewsTable = db.table<DbView>('db_views');
  const blocksTable = db.table<Block>('blocks');
  const propertyCache = new Map<string, DbProperty[]>();
  const pageCache = new Map<string, Page | null>();
  let updatedViews = 0;

  const propertiesForDatabase = async (databaseId: string) => {
    if (!propertyCache.has(databaseId)) {
      propertyCache.set(
        databaseId,
        await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId)),
      );
    }
    return propertyCache.get(databaseId) ?? [];
  };

  const pageSnapshot = async (pageId: string) => {
    if (!pageCache.has(pageId)) {
      pageCache.set(pageId, await getExisting(pagesTable, pageId));
    }
    return pageCache.get(pageId) ?? null;
  };

  for (const context of pages) {
    const parentRow = await pageSnapshot(context.page.id);
    if (!parentRow || parentRow.inTrash || parentRow.parentType !== 'database' || !parentRow.parentId) continue;
    const parentDatabase = await pageSnapshot(parentRow.parentId);
    if (!parentDatabase || parentDatabase.inTrash || parentDatabase.kind !== 'database') continue;

    const blocks = await listAll(blocksTable.where('pageId', '==', parentRow.id), 1000);
    for (const block of blocks) {
      if (block.type !== 'inline_database') continue;
      const content = asRecord(block.content);
      if (content?.linkedDatabaseSource !== true) continue;
      const sourceDatabaseId = optionalString(content.childPageId);
      if (!sourceDatabaseId) continue;
      const viewIds = uniqueNonEmptyStrings([
        optionalString(content.databaseViewId),
        ...(Array.isArray(content.databaseViewIds)
          ? content.databaseViewIds.map((id) => optionalString(id))
          : []),
      ]);
      if (viewIds.length === 0) continue;

      const sourceDatabase = await pageSnapshot(sourceDatabaseId);
      if (!sourceDatabase || sourceDatabase.inTrash || sourceDatabase.kind !== 'database') continue;
      const sourceProperties = await propertiesForDatabase(sourceDatabase.id);
      if (sourceProperties.length === 0) continue;

      const contextFilter = await importedLinkedDatabaseRowContextFilterForApply(
        db,
        parentRow,
        parentDatabase,
        sourceDatabase,
        sourceProperties,
        propertyCache,
        pageCache,
      );
      if (!contextFilter) continue;

      for (const viewId of viewIds) {
        const view = await getExisting(viewsTable, viewId);
        if (!view || view.databaseId !== sourceDatabase.id) continue;
        if (asRecord(view.config)?.[IMPORTED_ROW_CONTEXT_FILTER_MARKER] === true) continue;
        if (importedViewConfigHasRelationValueFilter(view.config, sourceProperties)) continue;
        const nextConfig = addImportedContextFilterToViewConfig(view.config, contextFilter);
        if (jsonEquivalent(nextConfig, view.config)) continue;
        await viewsTable.update(view.id, { config: nextConfig as Record<string, unknown> });
        updatedViews += 1;
      }
    }
  }

  if (conversionReport && updatedViews > 0) {
    incrementReport(conversionReport, 'importedLinkedDatabaseRowContextFilters', updatedViews);
  }

  return { updatedViews };
}

function jsonEquivalent(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => optionalString(item)).filter((item): item is string => !!item)
    : [];
}

function idsFromRecordArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => notionObjectId(asRecord(item) ?? {}) ?? optionalString(asRecord(item)?.id))
    .filter((item): item is string => !!item);
}

function templateBlockLinkedNotionTargetIds(block: TemplateBlock) {
  const content = asRecord(block.content);
  const linked = asRecord(content?.notionLinkedDatabase);
  return Array.from(new Set([
    ...stringArray(content?.notionLinkedTargetIds),
    ...stringArray(linked?.targetIds),
    ...idsFromRecordArray(linked?.targetReferences),
  ]));
}

function templateBlockLinkedNotionViewIds(block: TemplateBlock) {
  const content = asRecord(block.content);
  const linked = asRecord(content?.notionLinkedDatabase);
  return Array.from(new Set([
    ...stringArray(content?.notionLinkedViewIds),
    ...stringArray(linked?.viewIds),
    ...idsFromRecordArray(linked?.viewReferences),
    ...stringArray([linked?.selectedViewId]),
  ]));
}

interface TemplateSelfFilterDetection {
  hasCurrentPage: boolean;
  relationPropertyId?: string;
}

function mergeTemplateSelfFilterDetection(
  current: TemplateSelfFilterDetection,
  next: TemplateSelfFilterDetection,
): TemplateSelfFilterDetection {
  return {
    hasCurrentPage: current.hasCurrentPage || next.hasCurrentPage,
    relationPropertyId: current.relationPropertyId ?? next.relationPropertyId,
  };
}

function templateSelfFilterFromViewTerm(
  term: unknown,
  propsById: Map<string, DbProperty>,
  sourceDatabaseId: string,
): TemplateSelfFilterDetection {
  const record = asRecord(term);
  if (!record) return { hasCurrentPage: false };

  if (typeof record.conjunction === 'string') {
    let result: TemplateSelfFilterDetection = { hasCurrentPage: false };
    for (const filter of Array.isArray(record.filters) ? record.filters : []) {
      result = mergeTemplateSelfFilterDetection(
        result,
        templateSelfFilterFromViewTerm(filter, propsById, sourceDatabaseId),
      );
    }
    for (const group of Array.isArray(record.groups) ? record.groups : []) {
      result = mergeTemplateSelfFilterDetection(
        result,
        templateSelfFilterFromViewTerm(group, propsById, sourceDatabaseId),
      );
    }
    return result;
  }

  if (!importedFilterValueHasCurrentPage(record.value)) return { hasCurrentPage: false };
  const propertyId = optionalString(record.propertyId);
  const prop = propertyId ? propsById.get(propertyId) : undefined;
  if (!prop) return { hasCurrentPage: true };

  if (prop.type === 'relation' && prop.config?.relationDatabaseId === sourceDatabaseId) {
    return { hasCurrentPage: true, relationPropertyId: prop.id };
  }

  if (prop.type === 'rollup') {
    const relationPropertyId = optionalString(prop.config?.rollupRelationPropertyId);
    const relationProp = relationPropertyId ? propsById.get(relationPropertyId) : undefined;
    if (relationProp?.type === 'relation' && relationProp.config?.relationDatabaseId === sourceDatabaseId) {
      return { hasCurrentPage: true, relationPropertyId: relationProp.id };
    }
  }

  return { hasCurrentPage: true };
}

function templateSelfFilterFromImportedViewConfig(
  config: Record<string, unknown> | undefined,
  properties: DbProperty[],
  sourceDatabaseId: string,
) {
  const propsById = new Map(properties.map((property) => [property.id, property]));
  let result: TemplateSelfFilterDetection = { hasCurrentPage: false };
  const filterGroup = existingImportedViewFilterGroupForContext(config ?? {});
  if (filterGroup) {
    result = mergeTemplateSelfFilterDetection(
      result,
      templateSelfFilterFromViewTerm(filterGroup, propsById, sourceDatabaseId),
    );
  }
  if (!result.hasCurrentPage) return undefined;
  return {
    sourceDatabaseId,
    ...(result.relationPropertyId ? { relationPropertyId: result.relationPropertyId } : {}),
  };
}

async function markImportedTemplateLinkedView(
  db: DbRef,
  view: DbView,
  selfFilter: { sourceDatabaseId: string; relationPropertyId?: string },
) {
  const nextConfig: Record<string, unknown> = {
    ...(view.config ?? {}),
    templateLinkedView: true,
    templateLinkedSourceDatabaseId: selfFilter.sourceDatabaseId,
  };
  if (selfFilter.relationPropertyId) {
    nextConfig.templateLinkedRelationPropertyId = selfFilter.relationPropertyId;
  } else {
    delete nextConfig.templateLinkedRelationPropertyId;
  }
  if (jsonEquivalent(nextConfig, view.config)) return;
  await db.table<DbView>('db_views').update(view.id, { config: nextConfig });
}

async function remapImportedTemplateLinkedDatabaseBlocks(
  db: DbRef,
  templateContext: ImportedTemplateContext,
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  const sourceDatabaseId = templateContext.template.databaseId;
  const blocks = templateContext.template.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { blocks, changed: false };
  }

  const pages = db.table<Page>('pages');
  const views = db.table<DbView>('db_views');
  const pageCache = new Map<string, Page | null>();
  const propertyCache = new Map<string, DbProperty[]>();

  const linkedPageSnapshot = async (pageId: string) => {
    if (!pageCache.has(pageId)) {
      pageCache.set(pageId, await getExisting(pages, pageId));
    }
    return pageCache.get(pageId) ?? null;
  };

  const propertiesForDatabase = async (databaseId: string) => {
    if (!propertyCache.has(databaseId)) {
      propertyCache.set(
        databaseId,
        await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId)),
      );
    }
    return propertyCache.get(databaseId) ?? [];
  };

  const remapBlock = async (block: TemplateBlock): Promise<{ block: TemplateBlock; changed: boolean }> => {
    let changed = false;
    let nextBlock = block;
    let nextContent = asRecord(block.content) ? { ...(block.content ?? {}) } : undefined;

    if (block.type === 'inline_database') {
      const targetIds = templateBlockLinkedNotionTargetIds(block);
      const targetMapping = targetIds
        .map((targetId) => mappingForNotionId(mappingsByNotionId, targetId))
        .find((mapping) => mapping?.localType === 'database');
      if (targetMapping) {
        const linkedPage = await linkedPageSnapshot(targetMapping.localId);
        nextContent = {
          ...withNativeHanjiLinkedDatabaseFields(nextContent, {
            localTargetId: targetMapping.localId,
            localTargetType: targetMapping.localType,
            linkedDatabaseSource: targetMapping.localType === 'database',
          }),
          childPageId: targetMapping.localId,
          ...(linkedPage?.title ? { childPageTitle: linkedPage.title } : {}),
          ...(linkedPage?.icon ? { childPageIcon: linkedPage.icon } : {}),
          ...(linkedPage?.iconType ? { childPageIconType: linkedPage.iconType } : {}),
          ...(linkedPage?.kind ? { childPageKind: linkedPage.kind } : {}),
        };
        changed = true;
      }

      const viewIds = templateBlockLinkedNotionViewIds(block);
      const viewMapping =
        viewIds
          .map((viewId) => mappingForNotionId(mappingsByNotionId, viewId))
          .find((mapping) => mapping?.localType === 'db_view') ??
        inferredLinkedDatabaseViewMapping(targetMapping, mappingsByNotionId);
      if (viewMapping?.localType === 'db_view') {
        const localViewIds = mappedLocalDatabaseViewIds(viewIds, mappingsByNotionId);
        const view = await getExisting(views, viewMapping.localId);
        nextContent = withNativeHanjiLinkedDatabaseFields(nextContent, {
          localViewId: viewMapping.localId,
          localViewIds,
        });
        changed = true;

        if (view) {
          const properties = await propertiesForDatabase(view.databaseId);
          const selfFilter = templateSelfFilterFromImportedViewConfig(
            view.config,
            properties,
            sourceDatabaseId,
          );
          if (selfFilter) {
            nextContent = {
              ...(nextContent ?? {}),
              templateSelfFilter: selfFilter,
            };
            await markImportedTemplateLinkedView(db, view, selfFilter);
            changed = true;
          }
        }
      }
    }

    if (nextContent && !jsonEquivalent(nextContent, block.content)) {
      nextBlock = { ...nextBlock, content: nextContent };
      changed = true;
    }

    if (Array.isArray(block.children) && block.children.length > 0) {
      const remappedChildren: TemplateBlock[] = [];
      let childrenChanged = false;
      for (const child of block.children) {
        const result = await remapBlock(child);
        remappedChildren.push(result.block);
        if (result.changed) childrenChanged = true;
      }
      if (childrenChanged) {
        nextBlock = { ...nextBlock, children: remappedChildren };
        changed = true;
      }
    }

    return { block: nextBlock, changed };
  };

  const remappedBlocks: TemplateBlock[] = [];
  let changed = false;
  for (const block of blocks) {
    const result = await remapBlock(block);
    remappedBlocks.push(result.block);
    if (result.changed) changed = true;
  }

  return { blocks: changed ? remappedBlocks : blocks, changed };
}

async function insertPageBlocksFromSnapshot(
  db: DbRef,
  pageId: string,
  item: NotionImportItem,
  actorId: string,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
  fileCopyContext?: NotionFileCopyContext,
  blockMappingsByNotionId?: Map<string, ImportedBlockMapping>,
  itemsByNotionId?: Map<string, NotionImportItem>,
) {
  const snapshot = pageSnapshot(item);
  const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
  const nestedBlockIds = nestedNotionBlockIds(childBlocks);
  const blocks: Block[] = [];
  const linkedPageSnapshotCache = new Map<string, Page | null>();

  const linkedPageSnapshot = async (localPageId: string) => {
    if (!linkedPageSnapshotCache.has(localPageId)) {
      linkedPageSnapshotCache.set(localPageId, await getExisting(db.table<Page>('pages'), localPageId));
    }
    return linkedPageSnapshotCache.get(localPageId) ?? null;
  };

  const shouldImportChildrenInsideCurrentPage = (rawBlock: Record<string, unknown>) => {
    const notionType = typeof rawBlock.type === 'string' ? rawBlock.type : '';
    return notionType !== 'child_page' && notionType !== 'child_database';
  };

  const insertBlockTree = async (
    rawBlock: Record<string, unknown>,
    parentId: string | null,
    position: number,
    siblingHeadingBefore?: string,
  ): Promise<Block[]> => {
    const rawBlockRecord = rawBlock as Record<string, unknown>;
    reportBlockConversion(conversionReport, rawBlockRecord, item);
    reportBlockRichTextUserReferences(conversionReport, item, rawBlockRecord);
    const block = localBlockFromNotion(rawBlockRecord, pageId, actorId, position);
    block.parentId = parentId;
    const richTextMentionRemap = remapImportedRichTextMentionsInContent(block.content, mappingsByNotionId);
    if (richTextMentionRemap.changed) {
      block.content = richTextMentionRemap.content;
    }
    reportRichTextMentionRemap(
      conversionReport,
      notionObjectId(rawBlockRecord) ?? item.notionId,
      'block',
      `block on "${item.title || item.notionId}"`,
      richTextMentionRemap,
      { reportUnresolved: false },
    );
    const buttonTemplateRemap = remapImportedTemplateBlocksRichTextMentions(
      block.content?.buttonTemplate as TemplateBlock[] | undefined,
      mappingsByNotionId,
    );
    if (buttonTemplateRemap.changed) {
      block.content = {
        ...(block.content ?? {}),
        buttonTemplate: buttonTemplateRemap.blocks,
      };
    }
    reportRichTextMentionRemap(
      conversionReport,
      notionObjectId(rawBlockRecord) ?? item.notionId,
      'block',
      `button template block on "${item.title || item.notionId}"`,
      buttonTemplateRemap,
      { reportUnresolved: false },
    );
    if (block.type === 'inline_database' && rawBlockRecord.type === 'child_database') {
      const targetIds = linkedNotionTargetIdsFromBlock(rawBlockRecord);
      const targetItem = targetIds
        .map((targetId) => itemsByNotionId?.get(targetId))
        .find((candidate) => candidate?.notionObject === 'database');
      if (importedNotionDatabaseIsInline(targetItem) === false) {
        const restContent = { ...(block.content ?? {}) };
        delete restContent.notionLinkedDatabase;
        delete restContent.notionLinkedViewIds;
        block.type = 'child_database';
        block.content = restContent;
      }
    }

    if (block.type === 'inline_database' || block.type === 'child_database' || block.type === 'child_page' || block.type === 'link_to_page') {
      const linkedTargetIds = linkedNotionTargetIdsFromBlock(rawBlockRecord);
      const wantsDatabaseTarget = block.type === 'inline_database' || block.type === 'child_database';
      const linked = linkedTargetIds
        .map((targetId) => mappingsByNotionId.get(targetId))
        .find((mapping) =>
          wantsDatabaseTarget
            ? mapping?.localType === 'database'
            : mapping?.localType === 'page',
      );
      if (linked) {
        const linkedPage = await linkedPageSnapshot(linked.localId);
        const sourceUnavailableLinkedDatabase = importedDatabaseMappingSourceUnavailable(linked);
        block.content = {
          ...withNativeHanjiLinkedDatabaseFields(block.content, {
            localTargetId: linked.localId,
            localTargetType: linked.localType,
            linkedDatabaseSource: block.type === 'inline_database' && linked.localType === 'database',
          }),
          childPageId: linked.localId,
          ...(linkedPage?.title ? { childPageTitle: linkedPage.title } : {}),
          ...(linkedPage?.icon ? { childPageIcon: linkedPage.icon } : {}),
          ...(linkedPage?.iconType ? { childPageIconType: linkedPage.iconType } : {}),
          ...(linkedPage?.kind ? { childPageKind: linkedPage.kind } : {}),
        };
        if (linked.localType === 'database' && rawBlockRecord.type === 'child_database' && !sourceUnavailableLinkedDatabase) {
          await db.table<Page>('pages').update(linked.localId, {
            parentId: pageId,
            parentType: 'page',
            position,
          });
        }
        if (linked.localType === 'page' && rawBlockRecord.type === 'child_page') {
          await db.table<Page>('pages').update(linked.localId, {
            parentId: pageId,
            parentType: 'page',
            position,
          });
        }
        if (block.type === 'inline_database' && linked.localType === 'database') {
          const inferredLinkedView = inferredLinkedDatabaseViewMapping(linked, mappingsByNotionId);
          if (inferredLinkedView) {
            const localViewIds = mappedLocalDatabaseViewIds(
              linkedNotionViewIdsFromBlock(rawBlockRecord),
              mappingsByNotionId,
            );
            block.content = {
              ...withNativeHanjiLinkedDatabaseFields(block.content, {
                localViewId: inferredLinkedView.localId,
                localViewIds,
              }),
              notionHiddenDatabaseTitleContext: {
                inferredFrom: asRecord(linked.metadata)?.inferredFrom ?? 'view_parent_database_id',
                heading: siblingHeadingBefore,
                matchedViewId: inferredLinkedView.notionId,
              },
            };
          }
        }
        if (block.type === 'inline_database' && linked.localType === 'database' && !block.content?.databaseViewId && siblingHeadingBefore) {
          const linkedViews = await listAll(db.table<DbView>('db_views').where('databaseId', '==', linked.localId), 100);
          const inferredView = databaseViewMatchingImportedSection(linkedViews, siblingHeadingBefore);
          if (inferredView) {
            const inferredFrom = linkedDatabaseHeadingMatchesLabel(siblingHeadingBefore, inferredView.name)
              ? 'sibling_heading_view_name'
              : 'sibling_heading_view_context';
            block.content = {
              ...withNativeHanjiLinkedDatabaseFields(block.content, {
                localViewId: inferredView.id,
              }),
              ...(inferredFrom === 'sibling_heading_view_name' ? { hideDatabaseTitle: true } : {}),
              notionHiddenDatabaseTitleContext: {
                inferredFrom,
                heading: siblingHeadingBefore,
                matchedViewName: inferredView.name,
              },
            };
          }
        }
      }
      if (block.type === 'inline_database') {
        const linkedViewIds = linkedNotionViewIdsFromBlock(rawBlockRecord);
        const localViewIds = mappedLocalDatabaseViewIds(linkedViewIds, mappingsByNotionId);
        const linkedView = linkedViewIds
          .map((viewId) => mappingsByNotionId.get(viewId))
          .find((mapping) => mapping?.localType === 'db_view');
        if (linkedView) {
          block.content = withNativeHanjiLinkedDatabaseFields(block.content, {
            localViewId: linkedView.localId,
            localViewIds,
          });
        } else if (linkedViewIds.length && conversionReport) {
          incrementReport(conversionReport, 'unresolvedLinkedViews');
          pushReportIssue(conversionReport.unresolvedReferences, {
            code: 'linked_view_unresolved',
            notionId: linkedViewIds[0],
            notionObject: 'view',
            message: `Linked database view on "${item.title || item.notionId}" could not be mapped locally.`,
          });
        }
      }
    }
    let inserted = await db.table<Block>('blocks').insert(block);
    const fileReference = fileReferenceFromNotionBlock(rawBlockRecord);
    if (fileReference && fileCopyContext) {
      const notionBlockId = notionObjectId(rawBlockRecord);
      const copied = await copyNotionFileReference(fileCopyContext, {
        notionId: notionBlockId ?? item.notionId,
        notionObject: 'block',
        label: `block on "${item.title || item.notionId}"`,
        scope: fileCopyScopeForBlockType(block.type),
        pageId,
        blockId: inserted.id,
        notionBlockId,
      }, fileReference);
      if (copied !== fileReference) {
        inserted = await db.table<Block>('blocks').update(inserted.id, {
          content: {
            ...(inserted.content ?? {}),
            url: copied.url,
            fileName: copied.name,
            fileUploadId: copied.uploadId,
            fileKey: copied.key,
            fileBucket: copied.bucket,
            sourceUrl: copied.sourceUrl,
            notionFileReference: copied,
            notionFileCopied: true,
          },
        });
      }
    } else if (fileReference) {
      reportBlockFileReference(conversionReport, item, rawBlockRecord);
    }
    inserted = await preserveImportedBlockTimestamps(db, inserted, rawBlockRecord);
    const notionBlockId = notionObjectId(rawBlockRecord);
    if (notionBlockId && blockMappingsByNotionId) {
      blockMappingsByNotionId.set(notionBlockId, {
        localId: inserted.id,
        pageId: inserted.pageId,
      });
    }
    const insertedBlocks = [inserted];
    const children = shouldImportChildrenInsideCurrentPage(rawBlockRecord)
      ? tabBlockChildrenForImport(rawBlockRecord, conversionReport, item)
      : [];
    let childPosition = 1;
    let childSiblingHeading = '';
    for (const child of children) {
      if (rawBlockRecord.type === 'table' && child.type === 'table_row') continue;
      if (rawBlockRecord.type === 'template') continue;
      insertedBlocks.push(...await insertBlockTree(child, inserted.id, childPosition, childSiblingHeading || undefined));
      const heading = notionBlockHeadingText(child);
      if (heading) childSiblingHeading = heading;
      childPosition += 1;
    }
    return insertedBlocks;
  };

  let position = 1;
  let siblingHeading = '';
  for (const rawBlock of childBlocks) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    const rawBlockRecord = rawBlock as Record<string, unknown>;
    const rawBlockId = notionObjectId(rawBlockRecord);
    if (rawBlockId && nestedBlockIds.has(rawBlockId)) continue;
    if (rawBlockRecord.type === 'column' && notionBlockChildren(rawBlockRecord).length === 0) continue;
    blocks.push(...await insertBlockTree(rawBlockRecord, null, position, siblingHeading || undefined));
    const heading = notionBlockHeadingText(rawBlockRecord);
    if (heading) siblingHeading = heading;
    position += 1;
  }
  const markdown = snapshot?.markdown;
  const markdownText = markdown && typeof markdown === 'object'
    ? (markdown as Record<string, unknown>).text
    : undefined;
  const unknownBlockIds = markdown && typeof markdown === 'object' && Array.isArray((markdown as Record<string, unknown>).unknownBlockIds)
    ? (markdown as Record<string, unknown>).unknownBlockIds as unknown[]
    : [];
  if (conversionReport && unknownBlockIds.length > 0) {
    incrementReport(conversionReport, 'unknownMarkdownBlocks', unknownBlockIds.length);
    pushReportIssue(conversionReport.unsupported, {
      code: 'markdown_unknown_blocks',
      notionId: item.notionId,
      notionObject: 'page',
      message: `${unknownBlockIds.length} Notion block(s) on "${item.title || item.notionId}" were unknown in the markdown fallback.`,
    });
  }
  if (conversionReport && markdown && typeof markdown === 'object' && (markdown as Record<string, unknown>).truncated === true) {
    incrementReport(conversionReport, 'truncatedMarkdownPages');
    pushReportIssue(conversionReport.warnings, {
      code: 'markdown_truncated',
      notionId: item.notionId,
      notionObject: 'page',
      message: `Markdown fallback for "${item.title || item.notionId}" was truncated before import.`,
    });
  }
  if (blocks.length === 0 && typeof markdownText === 'string' && markdownText.trim()) {
    const block = await db.table<Block>('blocks').insert({
      id: newId(),
      pageId,
      parentId: null,
      type: 'paragraph',
      content: {
        rich: rich(markdownText.slice(0, 10_000)),
        notionMarkdown: markdown,
      },
      plainText: markdownText.slice(0, 10_000),
      position: 1,
      createdBy: actorId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    blocks.push(block);
  }
  return blocks;
}

async function retryImportedPageFileCopies(
  context: NotionFileCopyContext,
  page: Page,
) {
  const blocks = await listAll(context.db.table<Block>('blocks').where('pageId', '==', page.id), 1000);
  let scanned = 0;

  for (const block of blocks) {
    const content = asRecord(block.content) ?? {};
    const reference = storedNotionFileReference(content.notionFileReference);
    if (!reference) continue;
    scanned += 1;
    const copied = await copyNotionFileReference(context, {
      notionId: optionalString(content.notionBlockId) ?? block.id,
      notionObject: 'block',
      label: `block on "${page.title || page.id}"`,
      scope: fileCopyScopeForBlockType(block.type),
      pageId: page.id,
      blockId: block.id,
    }, reference);
    if (copied === reference) continue;
    await context.db.table<Block>('blocks').update(block.id, {
      content: {
        ...content,
        url: copied.url,
        fileName: copied.name,
        fileUploadId: copied.uploadId,
        fileKey: copied.key,
        fileBucket: copied.bucket,
        sourceUrl: copied.sourceUrl,
        notionFileReference: copied,
        notionFileCopied: true,
      },
    });
  }

  const properties = asRecord(page.properties);
  if (!properties) return scanned;

  let propertiesChanged = false;
  const nextProperties = { ...properties };
  const pagePatch: Partial<Page> = {};

  const iconReference = storedNotionFileReference(nextProperties[NOTION_PAGE_ICON_REFERENCE_KEY]);
  if (iconReference && page.iconType === 'image') {
    scanned += 1;
    const copied = await copyNotionFileReference(context, {
      notionId: page.id,
      notionObject: 'page',
      label: `page icon on "${page.title || page.id}"`,
      scope: 'icons',
      pageId: page.id,
    }, iconReference);
    if (copied !== iconReference) {
      nextProperties[NOTION_PAGE_ICON_REFERENCE_KEY] = copied;
      pagePatch.icon = copied.url;
      propertiesChanged = true;
    }
  }

  const coverReference = storedNotionFileReference(nextProperties[NOTION_PAGE_COVER_REFERENCE_KEY]);
  if (coverReference && page.cover) {
    scanned += 1;
    const copied = await copyNotionFileReference(context, {
      notionId: page.id,
      notionObject: 'page',
      label: `page cover on "${page.title || page.id}"`,
      scope: 'covers',
      pageId: page.id,
    }, coverReference);
    if (copied !== coverReference) {
      nextProperties[NOTION_PAGE_COVER_REFERENCE_KEY] = copied;
      pagePatch.cover = copied.url;
      propertiesChanged = true;
    }
  }

  for (const [propertyId, value] of Object.entries(properties)) {
    const values = Array.isArray(value) ? value : [];
    if (values.length === 0) continue;
    let changed = false;
    const nextValues: unknown[] = [];
    for (const item of values) {
      const reference = storedNotionFileReference(item);
      if (!reference) {
        nextValues.push(item);
        continue;
      }
      scanned += 1;
      const copied = await copyNotionFileReference(context, {
        notionId: propertyId,
        notionObject: 'property',
        label: `file property "${propertyId}" on "${page.title || page.id}"`,
        scope: 'database/files',
        pageId: page.id,
        databaseId: page.parentType === 'database' ? page.parentId ?? undefined : undefined,
        propertyId,
      }, reference);
      nextValues.push(copied);
      if (copied !== reference) changed = true;
    }
    if (changed) {
      nextProperties[propertyId] = nextValues;
      propertiesChanged = true;
    }
  }

  if (propertiesChanged || Object.keys(pagePatch).length > 0) {
    await context.db.table<Page>('pages').update(page.id, {
      ...pagePatch,
      ...(propertiesChanged ? { properties: nextProperties } : {}),
    });
  }

  return scanned;
}

async function retryFileCopies(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
  request?: Request,
  env?: Record<string, unknown>,
) {
  assertNotionFileCopyNotDisabled(body);
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  if (job.status !== 'completed') {
    throw new Error('Notion import job must be completed before retrying file copies.');
  }

  const mappings = await loadMappings(db, job.id);
  const localPageIds = new Set(
    Array.from(mappings.values())
      .filter((mapping) => mapping.localType === 'page')
      .map((mapping) => mapping.localId),
  );
  const report = emptyConversionReport();
  const stats = {
    fileCopies: 0,
    fileCopySkipped: 0,
  };
  const tokenSource = await notionTokenForJob(db, body, job, actorId, env).catch(() => undefined);
  const context: NotionFileCopyContext = {
    db,
    job,
    actorId,
    storage,
    request,
    conversionReport: report,
    requireStoredFileCopies: true,
    notionToken: tokenSource?.token,
    apiVersion: job.apiVersion || NOTION_API_VERSION,
    apiBase: notionApiBase(env),
    stats,
  };

  let scanned = 0;
  for (const pageId of localPageIds) {
    const page = await getExisting(db.table<Page>('pages'), pageId);
    if (!page || page.workspaceId !== job.workspaceId) continue;
    scanned += await retryImportedPageFileCopies(context, page);
  }

  const finishedAt = nowIso();
  const fileRetry = {
    generatedAt: finishedAt,
    scanned,
    copied: stats.fileCopies,
    skipped: stats.fileCopySkipped,
    conversion: finalizeConversionReport(report),
  };
  const updated = await jobs.update(job.id, {
    progress: {
      ...withImportProgress(job.progress, {
        key: 'file_copy_retry',
        status: 'completed',
        legacyStep: 'file_copy_retry_complete',
        percent: 100,
        at: finishedAt,
        counts: {
          scanned,
          copied: stats.fileCopies,
          skipped: stats.fileCopySkipped,
        },
      }),
      step: 'file_copy_retry_complete',
      fileRetry,
    },
    report: {
      ...(job.report ?? {}),
      fileRetry,
    },
  });

  await recordWorkspaceAudit(db, {
    workspaceId: job.workspaceId,
    actorId,
    action: 'notion_import.retry_file_copies',
    targetType: 'notion_import_job',
    targetId: job.id,
    metadata: fileRetry,
    occurredAt: finishedAt,
  });

  return {
    job: cleanJob(updated),
    fileRetry,
  };
}

function rawViewsForPlan(items: NotionImportItem[], dataSourceItem: NotionImportItem) {
  const directViewItems = items
    .filter((viewItem) => viewItem.notionObject === 'view' && viewItem.parentNotionId === dataSourceItem.notionId)
    .sort(compareNotionImportViewItems);
  const snapshotViews = dataSourceSnapshot(dataSourceItem)?.views;
  const rawViews = directViewItems.length
    ? directViewItems.map((viewItem) => viewSnapshot(viewItem)).filter((view): view is Record<string, unknown> => !!view)
    : Array.isArray(snapshotViews)
      ? snapshotViews.filter((view): view is Record<string, unknown> => !!view && typeof view === 'object')
      : [];
  const views = importableNotionViews(rawViews);
  return views.length ? views : [{ name: 'Table', type: 'table' }];
}

function inspectMarkdownFallbackForPlan(
  report: ImportConversionReport,
  item: NotionImportItem,
  snapshot: Record<string, unknown> | undefined,
) {
  const markdown = snapshot?.markdown;
  const unknownBlockIds = markdown && typeof markdown === 'object' && Array.isArray((markdown as Record<string, unknown>).unknownBlockIds)
    ? (markdown as Record<string, unknown>).unknownBlockIds as unknown[]
    : [];
  if (unknownBlockIds.length > 0) {
    incrementReport(report, 'unknownMarkdownBlocks', unknownBlockIds.length);
    pushReportIssue(report.unsupported, {
      code: 'markdown_unknown_blocks',
      notionId: item.notionId,
      notionObject: 'page',
      message: `${unknownBlockIds.length} Notion block(s) on "${item.title || item.notionId}" are unknown in the markdown fallback.`,
    });
  }
  if (markdown && typeof markdown === 'object' && (markdown as Record<string, unknown>).truncated === true) {
    incrementReport(report, 'truncatedMarkdownPages');
    pushReportIssue(report.warnings, {
      code: 'markdown_truncated',
      notionId: item.notionId,
      notionObject: 'page',
      message: `Markdown fallback for "${item.title || item.notionId}" is truncated.`,
    });
  }
}

function reportDiscoveryIncomplete(
  report: ImportConversionReport,
  issue: NotionImportWarning,
) {
  incrementReport(report, 'discoveryIncomplete');
  pushReportIssue(report.warnings, issue);
}

function inspectDiscoveryCompletenessForReport(
  report: ImportConversionReport,
  job: NotionImportJob,
  items: NotionImportItem[],
) {
  const jobProgress = progressObject(job.progress);
  const jobReport = progressObject(job.report);
  const hasMoreFromSearch = jobProgress.hasMore === true || jobReport.hasMoreFromSearch === true;
  const nextCursor = optionalString(jobProgress.nextCursor) ?? optionalString(jobReport.nextCursor);
  if (hasMoreFromSearch) {
    reportDiscoveryIncomplete(report, {
      code: 'notion_search_has_more',
      notionObject: 'workspace',
      message:
        'Notion workspace search still has more results. Continue discovery before applying if you want a fuller workspace graph.' +
        (nextCursor ? ` Saved cursor: ${nextCursor}.` : ''),
    });
  }

  for (const item of items) {
    if (item.notionObject === 'page') {
      const snapshot = pageSnapshot(item);
      if (snapshot?.childrenHasMore === true) {
        const next = optionalString(snapshot.childrenNextCursor);
        reportDiscoveryIncomplete(report, {
          code: 'page_children_truncated',
          notionId: item.notionId,
          notionObject: 'page',
          message:
            `Page "${item.title || item.notionId}" has more child blocks than this discovery pass fetched.` +
            (next ? ` Next children cursor: ${next}.` : ''),
        });
      }
    }

    if (item.notionObject === 'data_source') {
      const snapshot = dataSourceSnapshot(item);
      if (snapshot?.rowsHasMore === true) {
        const next = optionalString(snapshot.rowsNextCursor);
        reportDiscoveryIncomplete(report, {
          code: 'data_source_rows_truncated',
          notionId: item.notionId,
          notionObject: 'data_source',
          message:
            `Data source "${item.title || item.notionId}" has more rows than this discovery pass fetched.` +
            (next ? ` Next row cursor: ${next}.` : ''),
        });
      }
      if (snapshot?.viewsHasMore === true) {
        const next = optionalString(snapshot.viewsNextCursor);
        reportDiscoveryIncomplete(report, {
          code: 'data_source_views_truncated',
          notionId: item.notionId,
          notionObject: 'data_source',
          message:
            `Data source "${item.title || item.notionId}" has more views than this discovery pass fetched.` +
            (next ? ` Next view cursor: ${next}.` : ''),
        });
      }
      if (snapshot?.templatesHasMore === true) {
        const next = optionalString(snapshot.templatesNextCursor);
        reportDiscoveryIncomplete(report, {
          code: 'data_source_templates_truncated',
          notionId: item.notionId,
          notionObject: 'data_source',
          message:
            `Data source "${item.title || item.notionId}" has more templates than this discovery pass fetched.` +
            (next ? ` Next template cursor: ${next}.` : ''),
        });
      }
    }
  }
}

function inspectLinkedBlockForPlan(
  report: ImportConversionReport,
  item: NotionImportItem,
  rawBlock: Record<string, unknown>,
  knownNotionIds: Set<string>,
) {
  const notionType = typeof rawBlock.type === 'string' ? rawBlock.type : 'paragraph';
  const localType = localBlockTypeFromNotion(notionType, rawBlock);
  if (localType !== 'inline_database' && localType !== 'child_page' && localType !== 'link_to_page') return;

  const targetIds = linkedNotionTargetIdsFromBlock(rawBlock);
  if (targetIds.length && !targetIds.some((targetId) => knownNotionIds.has(targetId))) {
    incrementReport(report, 'unresolvedLinkedTargets');
    pushReportIssue(report.unresolvedReferences, {
      code: 'linked_target_unresolved',
      notionId: targetIds[0],
      notionObject: 'block',
      message: `Linked ${localType === 'inline_database' ? 'database' : 'page'} target on "${item.title || item.notionId}" is not present in the discovered graph.`,
    });
  }

  if (localType !== 'inline_database') return;
  const viewIds = linkedNotionViewIdsFromBlock(rawBlock);
  if (viewIds.length && !viewIds.some((viewId) => knownNotionIds.has(viewId))) {
    incrementReport(report, 'unresolvedLinkedViews');
    pushReportIssue(report.unresolvedReferences, {
      code: 'linked_view_unresolved',
      notionId: viewIds[0],
      notionObject: 'view',
      message: `Linked database view on "${item.title || item.notionId}" is not present in the discovered graph.`,
    });
  }
}

function inspectFilePropertiesForPlan(
  report: ImportConversionReport,
  item: NotionImportItem,
  rawProperties: unknown,
) {
  if (!rawProperties || typeof rawProperties !== 'object') return;
  for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
    const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
    const notionPropId = typeof prop.id === 'string' ? prop.id : nameOrId;
    reportNotionFileReferences(
      report,
      notionPropId,
      'property',
      `file property "${nameOrId}" on "${item.title || item.notionId}"`,
      notionFilePropertyReferences(rawValue),
    );
  }
}

function inspectNotionUserPropertiesForPlan(
  report: ImportConversionReport,
  item: NotionImportItem,
  rawProperties: unknown,
  labelPrefix = 'property',
) {
  if (!rawProperties || typeof rawProperties !== 'object') return;
  for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
    const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
    const notionPropId = typeof prop.id === 'string' ? prop.id : nameOrId;
    reportNotionUserReferences(
      report,
      notionPropId,
      'property',
      `${labelPrefix} "${nameOrId}" on "${item.title || item.notionId}"`,
      notionUserReferencesFromPropertyValue(rawValue),
    );
  }
}

function inspectPropertyReferencesForPlan(
  report: ImportConversionReport,
  dataSourceId: string,
  properties: Record<string, unknown>,
  dataSourceIds: Set<string>,
  propertiesByDataSource: Map<string, Record<string, unknown>>,
) {
  const propertyIds = notionPropertyReferenceIds(properties);

  for (const [nameOrId, rawProperty] of Object.entries(properties)) {
    const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
    const notionType = typeof notionProperty.type === 'string' ? notionProperty.type : 'rich_text';
    const config = notionPropertyConfig(notionProperty, notionType);
    if (notionType === 'relation') {
      const targetId = relationTargetNotionId(config);
      if (targetId && !dataSourceIds.has(targetId)) {
        incrementReport(report, 'unresolvedPropertyReferences');
        pushReportIssue(report.unresolvedReferences, {
          code: 'relation_target_unresolved',
          notionId: targetId,
          notionObject: 'property',
          message: `Relation property "${String(notionProperty.name ?? nameOrId)}" points to a data source that is not present in the discovered graph.`,
        });
      }
    }
    if (notionType === 'rollup') {
      const relationPropertyId = typeof config.relation_property_id === 'string' ? config.relation_property_id : undefined;
      const rollupPropertyId = typeof config.rollup_property_id === 'string' ? config.rollup_property_id : undefined;
      const relationProperty = relationPropertyId
        ? notionPropertyFromRawProperties(properties, relationPropertyId)
        : undefined;
      const relationTargetDataSourceId = relationProperty
        ? relationTargetNotionId(notionPropertyConfig(relationProperty, 'relation'))
        : undefined;

      if (relationPropertyId && !propertyIds.has(relationPropertyId)) {
        incrementReport(report, 'unresolvedPropertyReferences');
        pushReportIssue(report.unresolvedReferences, {
          code: 'rollup_property_unresolved',
          notionId: relationPropertyId,
          notionObject: 'property',
          message: `Rollup property "${String(notionProperty.name ?? nameOrId)}" references relation property "${relationPropertyId}" that is not present in data source ${dataSourceId}.`,
        });
      }

      if (!rollupPropertyId) continue;
      const targetProperties = relationTargetDataSourceId
        ? propertiesByDataSource.get(relationTargetDataSourceId)
        : undefined;
      const targetPropertyIds = targetProperties ? notionPropertyReferenceIds(targetProperties) : undefined;
      const rollupTargetIsKnown = targetPropertyIds
        ? targetPropertyIds.has(rollupPropertyId)
        : propertyIds.has(rollupPropertyId);
      if (rollupTargetIsKnown) continue;
      incrementReport(report, 'unresolvedPropertyReferences');
      pushReportIssue(report.unresolvedReferences, {
        code: 'rollup_property_unresolved',
        notionId: rollupPropertyId,
        notionObject: 'property',
        message:
          `Rollup property "${String(notionProperty.name ?? nameOrId)}" references target property "${rollupPropertyId}" ` +
          `that is not present in ${relationTargetDataSourceId ? `related data source ${relationTargetDataSourceId}` : `data source ${dataSourceId}`}.`,
      });
    }
    if (notionType === 'formula') {
      const expression = typeof config.expression === 'string' ? config.expression : '';
      const formulaPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId;
      reportUnsupportedFormulaFunctions(
        report,
        dataSourceId,
        formulaPropertyId,
        String(notionProperty.name ?? nameOrId),
        unsupportedFormulaFunctions(expression),
      );
      for (const referencedProperty of formulaPropertyReferences(expression)) {
        if (propertyIds.has(referencedProperty)) continue;
        reportUnresolvedFormulaPropertyReference(
          report,
          dataSourceId,
          formulaPropertyId,
          String(notionProperty.name ?? nameOrId),
          referencedProperty,
        );
      }
    }
  }
}

function notionPropertyReferenceIds(properties: Record<string, unknown>) {
  const propertyIds = new Set<string>();
  for (const [nameOrId, rawProperty] of Object.entries(properties)) {
    const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
    const references = [
      typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId,
      nameOrId,
      typeof notionProperty.name === 'string' ? notionProperty.name : undefined,
    ];
    for (const reference of references) {
      for (const candidate of notionPropertyReferenceVariants(reference)) {
        propertyIds.add(candidate);
      }
    }
  }
  return propertyIds;
}

function notionPropertyFromRawProperties(properties: Record<string, unknown>, reference: string) {
  const references = notionPropertyReferenceVariants(reference);
  if (references.length === 0) return undefined;
  for (const [nameOrId, rawProperty] of Object.entries(properties)) {
    const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
    const notionPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id.trim() : '';
    const notionPropertyName = typeof notionProperty.name === 'string' ? notionProperty.name.trim() : '';
    const candidates = [
      ...notionPropertyReferenceVariants(notionPropertyId),
      ...notionPropertyReferenceVariants(nameOrId),
      ...notionPropertyReferenceVariants(notionPropertyName),
    ];
    if (references.some((value) => candidates.includes(value))) return notionProperty;
  }
  return undefined;
}

export function buildImportPlan(job: NotionImportJob, items: NotionImportItem[]): NotionImportPlan {
  const report = emptyConversionReport();
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
    return acc;
  }, {});
  const knownNotionIds = new Set(items.map((item) => item.notionId));
  const databaseItems = items.filter((item) => item.notionObject === 'database');
  const dataSourceItems = items.filter((item) => item.notionObject === 'data_source');
  const dataSourceIds = new Set(dataSourceItems.map((item) => item.notionId));
  const inferredLinkedDatabaseItems = new Map<string, ReturnType<typeof inferDataSourceForHiddenLinkedDatabase>>();
  const placeholderDatabaseItems = databaseItems.filter((item) => {
    const metadata = itemMetadata(item);
    const dataSources = Array.isArray(metadata.dataSources) ? metadata.dataSources : [];
    const hasMappedSource = dataSources.some((source) => {
      const id = source && typeof source === 'object'
        ? notionObjectId(source as Record<string, unknown>)
        : undefined;
      return !!id && dataSourceIds.has(id);
    });
    if (hasMappedSource) return false;
    const inferred = inferDataSourceForHiddenLinkedDatabase(item, items, dataSourceItems);
    if (inferred) {
      inferredLinkedDatabaseItems.set(item.notionId, inferred);
      return false;
    }
    return true;
  });
  const pageItems = items.filter((item) => item.notionObject === 'page');
  const propertiesByDataSource = new Map<string, Record<string, unknown>>();
  for (const item of dataSourceItems) {
    const augmented = augmentNotionPropertiesFromRowSnapshots(
      notionPropertiesFromSnapshot(dataSourceSnapshot(item)),
      item.notionId,
      pageItems,
    );
    if (augmented.inferred > 0) incrementReport(report, 'inferredRowSnapshotProperties', augmented.inferred);
    propertiesByDataSource.set(item.notionId, augmented.properties);
  }
  let properties = 0;
  let views = 0;
  let viewMappings = 0;
  let templates = 0;
  let rows = 0;
  let pages = 0;
  let blocks = 0;

  inspectDiscoveryCompletenessForReport(report, job, items);

  for (const item of dataSourceItems) {
    const sourceProperties = propertiesByDataSource.get(item.notionId) ?? {};
    reportPageChromeFileReferences(report, item);
    inspectPropertyReferencesForPlan(report, item.notionId, sourceProperties, dataSourceIds, propertiesByDataSource);
    for (const [nameOrId, rawProperty] of Object.entries(sourceProperties)) {
      const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
      const notionPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId;
      const notionType = typeof notionProperty.type === 'string' ? notionProperty.type : 'rich_text';
      reportUnsupportedProperty(report, item.notionId, notionPropertyId, String(notionProperty.name ?? nameOrId), notionType);
      properties += 1;
    }
    const propertyMappingsForPlan = viewPropertyMappingsFromRawProperties(sourceProperties);
    const viewsToCreate = rawViewsForPlan(items, item);
    views += viewsToCreate.length;
    for (const view of viewsToCreate) {
      if (typeof view.id === 'string' && view.id.trim()) viewMappings += 1;
      reportUnsupportedView(report, item.notionId, view);
      inspectViewPropertyReferences(report, item.notionId, view, propertyMappingsForPlan, sourceProperties);
    }
    const rawTemplates = rawTemplatesFromSnapshot(dataSourceSnapshot(item));
    templates += rawTemplates.length;
    for (const template of rawTemplates) {
      inspectNotionUserPropertiesForPlan(report, item, templatePropertiesFromNotion(template), 'template property');
      for (const block of rawTemplateBlocks(template)) {
        reportTemplateBlockRichTextUserReferences(report, item, block);
      }
    }
  }

  for (const item of pageItems) {
    if (rowDataSourceId(item, dataSourceIds)) rows += 1;
    else pages += 1;

    const snapshot = pageSnapshot(item);
    reportPageChromeFileReferences(report, item);
    const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
    for (const rawBlock of childBlocks) {
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const rawBlockRecord = rawBlock as Record<string, unknown>;
      reportBlockConversion(report, rawBlockRecord, item);
      reportBlockRichTextUserReferences(report, item, rawBlockRecord);
      inspectLinkedBlockForPlan(report, item, rawBlockRecord, knownNotionIds);
      reportBlockFileReference(report, item, rawBlockRecord);
    }
    inspectFilePropertiesForPlan(report, item, itemMetadata(item).properties);
    inspectNotionUserPropertiesForPlan(report, item, itemMetadata(item).properties);
    inspectMarkdownFallbackForPlan(report, item, snapshot);
    const markdown = snapshot?.markdown;
    const markdownText = markdown && typeof markdown === 'object'
      ? (markdown as Record<string, unknown>).text
      : undefined;
    blocks += flattenImportablePageBlocksForPlan(childBlocks).length || (typeof markdownText === 'string' && markdownText.trim() ? 1 : 0);
  }

  for (const item of placeholderDatabaseItems) {
    incrementReport(report, 'placeholderDatabases');
    pushReportIssue(report.warnings, {
      code: 'database_source_unavailable',
      notionId: item.notionId,
      notionObject: 'database',
      message:
        `Notion database "${item.title || item.notionId}" did not expose data sources through the API, ` +
        'so Hanji will import a placeholder database instead of leaving the linked database broken.',
    });
  }

  for (const [notionId, inferred] of inferredLinkedDatabaseItems) {
    if (!inferred) continue;
    incrementReport(report, 'inferredLinkedDatabases');
    const inferredFrom =
      inferred.inferredFrom === 'view_parent_database_id'
        ? `Notion view "${inferred.matchedViewId || inferred.matchedLabel}" parent.database_id`
        : `sibling heading "${inferred.heading}" and view label "${inferred.matchedLabel}"`;
    pushReportIssue(report.warnings, {
      code: 'linked_database_source_inferred',
      notionId,
      notionObject: 'database',
      message:
        `Notion database "${notionId}" does not expose data sources, ` +
        `so Hanji will link it to imported data source "${inferred.dataSourceItem.title || inferred.dataSourceItem.notionId}" ` +
        `from ${inferredFrom}.`,
    });
  }

  const placeholderDatabases = placeholderDatabaseItems.length;
  const estimatedWrites = {
    pages: pages + rows + 1,
    databases: dataSourceItems.length + placeholderDatabases,
    rows,
    blocks,
    properties: properties + placeholderDatabases,
    views: views + placeholderDatabases,
    templates,
    mappings: dataSourceItems.length + pageItems.length + databaseItems.length + viewMappings + templates + properties,
  };

  return {
    status: items.length > 0 && job.status === 'ready' ? 'ready' : 'blocked',
    generatedAt: nowIso(),
    counts,
    estimatedWrites,
    conversion: finalizeConversionReport(report),
    canApply: items.length > 0 && job.status === 'ready',
  };
}

function itemHasImportablePageBody(item: NotionImportItem) {
  const snapshot = pageSnapshot(item);
  const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
  const markdown = snapshot?.markdown;
  const markdownText = markdown && typeof markdown === 'object'
    ? (markdown as Record<string, unknown>).text
    : undefined;
  return flattenImportablePageBlocksForPlan(childBlocks).length > 0 ||
    (typeof markdownText === 'string' && markdownText.trim().length > 0);
}

function importedBlocksComplete(page: Page) {
  const properties = asRecord(page.properties) ?? {};
  return properties[NOTION_IMPORT_BLOCKS_COMPLETE_KEY] === true;
}

function importedBlockBoundaryRepairComplete(page: Page) {
  const properties = asRecord(page.properties) ?? {};
  return properties[NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY] === NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION;
}

async function markImportedBlocksComplete(db: DbRef, page: Page) {
  const updated = await db.table<Page>('pages').update(page.id, {
    properties: {
      ...(page.properties ?? {}),
      [NOTION_IMPORT_BLOCKS_COMPLETE_KEY]: true,
      [NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY]: NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION,
    },
  });
  return updated;
}

async function replaceImportedBlocksForPage(
  db: DbRef,
  page: Page,
  item: NotionImportItem,
  actorId: string,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport: ImportConversionReport,
  fileCopyContext: NotionFileCopyContext,
  importedBlockMappingsByNotionId: Map<string, ImportedBlockMapping>,
  itemsByNotionId?: Map<string, NotionImportItem>,
) {
  const existingBlocks = await listAll(db.table<Block>('blocks').where('pageId', '==', page.id), NOTION_BLOCK_CHILD_TOTAL_LIMIT);
  await Promise.all(existingBlocks.map((block) => bestEffort('notion-import db.table(blocks).delete(block.id)', db.table<Block>('blocks').delete(block.id))));
  const insertedBlocks = await insertPageBlocksFromSnapshot(
    db,
    page.id,
    item,
    actorId,
    mappingsByNotionId,
    conversionReport,
    fileCopyContext,
    importedBlockMappingsByNotionId,
    itemsByNotionId,
  );
  const updatedPage = await markImportedBlocksComplete(db, page);
  return { page: updatedPage, insertedBlocks };
}

async function repairImportedPageBlocks(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
  request?: Request,
  env?: Record<string, unknown>,
) {
  assertNotionFileCopyNotDisabled(body);
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);

  const localPageId = optionalString(body.localPageId) ?? optionalString(body.pageId);
  const notionPageId = optionalString(body.notionPageId);
  const startAfterNotionPageId = optionalString(body.startAfterNotionPageId) ?? optionalString(body.afterNotionPageId);
  const startAfterLocalPageId = optionalString(body.startAfterLocalPageId) ?? optionalString(body.afterLocalPageId);
  const useStartCursor = !localPageId && !notionPageId && (!!startAfterNotionPageId || !!startAfterLocalPageId);
  const maxPages = parsePositiveInt(body.maxPages, localPageId || notionPageId ? 1 : 25, 250);
  const force = parseBoolean(body.force, !!(localPageId || notionPageId));
  const items = await listAll(db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  if (items.length === 0) throw new Error('Notion import job has no discovered items.');

  const mappingsByNotionId = await loadMappings(db, job.id);
  const itemsByNotionId = new Map(items.map((item) => [item.notionId, item]));
  const conversionReport = emptyConversionReport();
  const repaired = {
    pages: 0,
    blocks: 0,
    fileCopies: 0,
    fileCopySkipped: 0,
    linkedDatabaseContextFilters: 0,
    skippedAlreadyRepaired: 0,
    scannedPages: 0,
  };
  const tokenSource = await notionTokenForJob(db, body, job, actorId, env).catch(() => undefined);
  const fileCopyContext: NotionFileCopyContext = {
    db,
    job,
    actorId,
    storage,
    request,
    conversionReport,
    requireStoredFileCopies: true,
    notionToken: tokenSource?.token,
    apiVersion: job.apiVersion || NOTION_API_VERSION,
    apiBase: notionApiBase(env),
    stats: repaired,
  };
  const importedBlockMappingsByNotionId = new Map<string, ImportedBlockMapping>();
  const importedPageBlockContexts: ImportedPageBlockContext[] = [];
  let startCursorSeen = !useStartCursor;
  let hasMore = false;
  let lastRepairedNotionPageId: string | undefined;
  let lastRepairedLocalPageId: string | undefined;

  for (const item of items) {
    if (item.notionObject !== 'page') continue;
    if (notionPageId && item.notionId !== notionPageId) continue;
    if (!itemHasImportablePageBody(item)) continue;
    const mapping = mappingsByNotionId.get(item.notionId);
    if (!mapping || mapping.localType !== 'page') continue;
    if (localPageId && mapping.localId !== localPageId) continue;
    if (!startCursorSeen) {
      if (
        (startAfterNotionPageId && item.notionId === startAfterNotionPageId) ||
        (startAfterLocalPageId && mapping.localId === startAfterLocalPageId)
      ) {
        startCursorSeen = true;
      }
      continue;
    }
    const page = await getExisting(db.table<Page>('pages'), mapping.localId);
    if (!page) continue;
    importedPageBlockContexts.push({ page, notionId: item.notionId });
    repaired.scannedPages += 1;
    if (!force && importedBlockBoundaryRepairComplete(page)) {
      repaired.skippedAlreadyRepaired += 1;
      continue;
    }
    if (repaired.pages >= maxPages) {
      hasMore = true;
      break;
    }

    const replaced = await replaceImportedBlocksForPage(
      db,
      page,
      item,
      actorId,
      mappingsByNotionId,
      conversionReport,
      fileCopyContext,
      importedBlockMappingsByNotionId,
      itemsByNotionId,
    );
    repaired.pages += 1;
    repaired.blocks += replaced.insertedBlocks.length;
    lastRepairedNotionPageId = item.notionId;
    lastRepairedLocalPageId = mapping.localId;
  }

  const linkedDatabaseContextFilterRemap = await addImportedLinkedDatabaseRowContextFilters(
    db,
    importedPageBlockContexts,
    conversionReport,
  );
  repaired.linkedDatabaseContextFilters = linkedDatabaseContextFilterRemap.updatedViews;

  return {
    job: cleanJob(job),
    repaired,
    partial: hasMore,
    lastRepaired: lastRepairedNotionPageId || lastRepairedLocalPageId
      ? {
          notionPageId: lastRepairedNotionPageId,
          localPageId: lastRepairedLocalPageId,
        }
      : null,
    nextCursor: hasMore && (lastRepairedNotionPageId || lastRepairedLocalPageId)
      ? {
          startAfterNotionPageId: lastRepairedNotionPageId,
          startAfterLocalPageId: lastRepairedLocalPageId,
        }
      : null,
    report: conversionReport,
  };
}

async function ensureImportedPageWorkspaceIndexes(
  admin: AdminDbAccessor,
  mappings: NotionImportMapping[],
  workspaceId: string,
) {
  const localPageIds = new Set<string>();
  for (const mapping of mappings) {
    if (
      (mapping.localType === 'page' || mapping.localType === 'database') &&
      typeof mapping.localId === 'string' &&
      mapping.localId.length > 0
    ) {
      localPageIds.add(mapping.localId);
    }
  }
  for (const pageId of localPageIds) {
    await ensurePageWorkspaceIndex(admin, pageId, workspaceId);
  }
}

async function markApplyJobFailed(
  db: DbRef,
  actorId: string,
  body: Record<string, unknown>,
  error: unknown,
) {
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) return;
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  // Only a job that was actually mid-apply should flip to `failed`: apply runs
  // with the top-level status left at `ready` (updateApplyProgress never
  // changes it), so a precondition throw ('not found', wrong status, already
  // completed) must not clobber the job.
  if (!job || job.status !== 'ready') return;
  const message = error instanceof Error ? error.message : String(error);
  const failedAt = nowIso();
  await jobs
    .update(job.id, {
      status: 'failed',
      phase: 'apply_failed',
      error: message,
      progress: {
        ...withImportProgress(job.progress, {
          key: 'apply',
          status: 'failed',
          legacyStep: 'apply_failed',
          message,
          at: failedAt,
        }),
      },
      report: {
        ...(job.report ?? baseReport()),
        lastError: message,
      },
      finishedAt: failedAt,
    })
    .catch(() => {});
  await recordWorkspaceAudit(db, {
    workspaceId: job.workspaceId,
    actorId,
    action: 'notion_import.apply_failed',
    targetType: 'notion_import_job',
    targetId: job.id,
    metadata: { message },
  }).catch(() => {});
}

async function applyJob(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
  request?: Request,
  env?: Record<string, unknown>,
) {
  // Authorize BEFORE arming the failure marker: markApplyJobFailed itself does
  // no role check, so an unauthorized caller's 403 must not flip a ready job
  // to `failed` (that would let any authenticated stranger who learns a job id
  // sabotage another workspace's import).
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  try {
    return await applyJobCore(db, admin, body, actorId, storage, request, env);
  } catch (error) {
    // Record the failure on the job so apply progress can't stay stuck at
    // `running` forever. discoverJob already does this for its own failures.
    await markApplyJobFailed(db, actorId, body, error);
    throw error;
  }
}

async function applyJobCore(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
  request?: Request,
  env?: Record<string, unknown>,
) {
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  const existingMappings = await loadMappings(db, job.id);
  if (job.status === 'completed') {
    const mappings = Array.from(existingMappings.values());
    await ensureImportedPageWorkspaceIndexes(admin, mappings, job.workspaceId);
    return {
      job: cleanJob(job),
      applied: (job.progress as { applied?: Record<string, number> } | undefined)?.applied ?? {},
      mappings,
    };
  }
  if (job.status !== 'ready') {
    throw new Error('Notion import job must be ready before apply.');
  }

  const items = await listAll(db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  if (items.length === 0) throw new Error('Notion import job has no discovered items.');
  const itemsByNotionId = new Map(items.map((item) => [item.notionId, item]));
  const blockOwnerContextsByNotionId = buildImportedBlockOwnerContexts(items);

  const applyPageBatchSize = parsePositiveInt(body.applyPageBatchSize, 0, 500);
  const applyDatabaseBatchSize = parsePositiveInt(
    body.applyDatabaseBatchSize,
    applyPageBatchSize > 0 ? applyPageBatchSize : 50,
    500,
  );
  const existingApplyCursor =
    asRecord(asRecord(job.progress)?.applyCursor) ??
    asRecord(asRecord(job.report)?.applyCursor);
  const existingApplyPhase = optionalString(existingApplyCursor?.phase);
  const shouldChunkDatabaseContainers =
    !existingApplyPhase ||
    existingApplyPhase === 'apply_data_sources' ||
    existingApplyPhase === 'apply_database_containers';
  const resumeDatabasePass = existingApplyPhase === 'apply_database_containers'
    ? optionalString(existingApplyCursor?.databasePass)
    : undefined;
  const resumeDatabaseIndex = existingApplyPhase === 'apply_database_containers' &&
    typeof existingApplyCursor?.databaseIndex === 'number' &&
    Number.isFinite(existingApplyCursor.databaseIndex)
    ? Math.max(0, Math.floor(existingApplyCursor.databaseIndex))
    : 0;
  const mappingsByNotionId = existingMappings;
  const rootPageId = await ensureImportRoot(db, admin, job, mappingsByNotionId, actorId);
  const rootNotionPageIdSet = new Set(
    (job.rootNotionPageIds ?? []).map((id) => normalizedNotionId(id)).filter(Boolean),
  );
  const dataSourceItems = items.filter((item) => item.notionObject === 'data_source');
  const dataSourceIds = new Set(dataSourceItems.map((item) => item.notionId));
  const propertyMappingsByDataSource = new Map<string, Map<string, string>>();
  const propertyRecordsByDataSource = new Map<string, DbProperty[]>();
  const importedPropertyContexts: ImportedPropertyContext[] = [];
  const importedRowContexts: ImportedRowContext[] = [];
  const importedPageBlockContexts: ImportedPageBlockContext[] = [];
  const importedTemplateContexts: ImportedTemplateContext[] = [];
  const importedBlockMappingsByNotionId = new Map<string, ImportedBlockMapping>();
  const conversionReport = emptyConversionReport();
  inspectDiscoveryCompletenessForReport(conversionReport, job, items);
  assertNotionFileCopyNotDisabled(body);
  const storedImportPagesFullWidth = parseOptionalBoolean(asRecord(job.options)?.importPagesFullWidth);
  const importPagesFullWidth = parseOptionalBoolean(body.importPagesFullWidth) ?? storedImportPagesFullWidth;
  const tokenSource = await notionTokenForJob(db, body, job, actorId, env).catch(() => undefined);
  const created = {
    pages: 0,
    databases: 0,
    blocks: 0,
    properties: 0,
    views: 0,
    templates: 0,
    rows: 0,
    mappings: 0,
    remappedProperties: 0,
    remappedViewRelationFilters: 0,
    remappedLinkedDatabaseContextFilters: 0,
    remappedRowRelations: 0,
    remappedTemplateRelations: 0,
    remappedLinkBlocks: 0,
    unresolvedImportReferences: 0,
    fileCopies: 0,
    fileCopySkipped: 0,
    repairedPageParents: 0,
  };
  const fileCopyContext: NotionFileCopyContext = {
    db,
    job,
    actorId,
    storage,
    request,
    conversionReport,
    requireStoredFileCopies: true,
    notionToken: tokenSource?.token,
    apiVersion: job.apiVersion || NOTION_API_VERSION,
    apiBase: notionApiBase(env),
    stats: created,
  };
  let currentJob = job;
  const updateApplyProgress = async (phase: string, cursor: Record<string, unknown> = {}) => {
    const applyCursor = { phase, ...cursor };
    currentJob = await jobs.update(job.id, {
      phase,
      error: null,
      finishedAt: null,
      progress: {
        ...withImportProgress(currentJob.progress, {
          key: 'apply',
          status: 'running',
          legacyStep: phase,
          percent: 75,
          counts: created,
        }),
        applyCursor,
        partialApplied: created,
      },
      report: {
        ...(currentJob.report ?? {}),
        applyCursor,
        partialApplied: created,
      },
      options: importPagesFullWidth !== undefined
        ? {
            ...(currentJob.options ?? {}),
            importPagesFullWidth,
          }
        : currentJob.options,
    });
  };

  await updateApplyProgress('apply_data_sources', {
    totalDataSources: dataSourceItems.length,
  });

  for (const item of dataSourceItems) {
    const existingMapping = mappingsByNotionId.get(item.notionId);
    let databaseId = existingMapping?.localId;
    if (!databaseId) {
      const chrome = importedPageChromeFromItem(item);
      let page = await db.table<Page>('pages').insert(
        basePage({
          workspaceId: job.workspaceId,
          parentId: rootPageId,
          parentType: 'page',
          kind: 'database',
          title: item.title || 'Imported database',
          icon: chrome.icon,
          iconType: chrome.iconType,
          cover: chrome.cover,
          coverPosition: chrome.coverPosition,
          position: created.databases + 1,
          actorId,
          ...importedItemTimestamps(item),
          properties: pagePropertiesWithChromeReferences({
            notionImportJobId: job.id,
            notionDataSourceId: item.notionId,
          }, chrome),
        }),
      );
      page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
      page = await preserveImportedPageTimestamps(db, page, item);
      databaseId = page.id;
      await createMapping(db, admin, job, mappingsByNotionId, {
        notionId: item.notionId,
        notionType: item.notionObject,
        localId: databaseId,
        localType: 'database',
        relationKind: 'canonical_data_source',
        metadata: { title: item.title },
      });
      created.databases += 1;
      created.mappings += 1;
    }

    const propMap = new Map<string, string>();
    propertyMappingsByDataSource.set(item.notionId, propMap);
    propertyRecordsByDataSource.set(item.notionId, []);
    const augmentedProperties = augmentNotionPropertiesFromRowSnapshots(
      notionPropertiesFromSnapshot(dataSourceSnapshot(item)),
      item.notionId,
      items,
    );
    if (augmentedProperties.inferred > 0) {
      incrementReport(conversionReport, 'inferredRowSnapshotProperties', augmentedProperties.inferred);
    }
    const properties = augmentedProperties.properties;
    const existingDatabaseProperties = databaseId
      ? await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId), 1000)
      : [];
    let propIndex = 0;
    for (const [nameOrId, rawProperty] of Object.entries(properties)) {
      const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
      const notionPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId;
      const notionType = typeof notionProperty.type === 'string' ? notionProperty.type : 'rich_text';
      reportUnsupportedProperty(conversionReport, item.notionId, notionPropertyId, String(notionProperty.name ?? nameOrId), notionType);
      const existingPropertyMapping = mappingsByNotionId.get(notionPropertyMappingId(item.notionId, notionPropertyId));
      const existingProperty = existingPropertyMapping
        ? existingDatabaseProperties.find((property) => property.id === existingPropertyMapping.localId) ??
          await getExisting(db.table<DbProperty>('db_properties'), existingPropertyMapping.localId)
        : undefined;
      if (existingProperty) {
        setViewPropertyMapping(propMap, notionPropertyId, existingProperty.id);
        setViewPropertyMapping(propMap, nameOrId, existingProperty.id);
        setViewPropertyMapping(propMap, existingProperty.name, existingProperty.id);
        propertyRecordsByDataSource.get(item.notionId)?.push(existingProperty);
        importedPropertyContexts.push({
          dataSourceId: item.notionId,
          notionPropertyId,
          notionPropertyName: nameOrId,
          notionProperty: { ...notionProperty, name: notionProperty.name ?? nameOrId },
          property: existingProperty,
        });
        propIndex += 1;
        continue;
      }
      const property = dbPropertyFromNotion(databaseId, notionPropertyId, { ...notionProperty, name: notionProperty.name ?? nameOrId }, propIndex);
      const inserted = await db.table<DbProperty>('db_properties').insert(property);
      setViewPropertyMapping(propMap, notionPropertyId, inserted.id);
      setViewPropertyMapping(propMap, nameOrId, inserted.id);
      setViewPropertyMapping(propMap, inserted.name, inserted.id);
      propertyRecordsByDataSource.get(item.notionId)?.push(inserted);
      importedPropertyContexts.push({
        dataSourceId: item.notionId,
        notionPropertyId,
        notionPropertyName: nameOrId,
        notionProperty: { ...notionProperty, name: notionProperty.name ?? nameOrId },
        property: inserted,
      });
      await createMapping(db, admin, job, mappingsByNotionId, {
        notionId: notionPropertyMappingId(item.notionId, notionPropertyId),
        notionType: 'property',
        localId: inserted.id,
        localType: 'db_property',
        relationKind: 'database_property',
        metadata: {
          dataSourceId: item.notionId,
          databaseId,
          name: inserted.name,
          notionPropertyId,
        },
      });
      created.properties += 1;
      created.mappings += 1;
      propIndex += 1;
    }

    const directViewItems = items
      .filter((viewItem) => viewItem.notionObject === 'view' && viewItem.parentNotionId === item.notionId)
      .sort(compareNotionImportViewItems);
    const snapshotViews = dataSourceSnapshot(item)?.views;
    const rawViews = directViewItems.length
      ? directViewItems.map((viewItem) => viewSnapshot(viewItem)).filter((view): view is Record<string, unknown> => !!view)
      : Array.isArray(snapshotViews)
        ? snapshotViews.filter((view): view is Record<string, unknown> => !!view && typeof view === 'object')
        : [];
    const importableViews = importableNotionViews(rawViews);
    const viewsToCreate: Record<string, unknown>[] = importableViews.length
      ? importableViews
      : [{ name: 'Table', type: 'table' }];
    const existingViews = databaseId
      ? await listAll(db.table<DbView>('db_views').where('databaseId', '==', databaseId), 1000)
      : [];
    for (let index = 0; index < viewsToCreate.length; index += 1) {
      reportUnsupportedView(conversionReport, item.notionId, viewsToCreate[index]);
      const viewToCreate = viewsToCreate[index];
      const notionViewId = typeof viewToCreate.id === 'string' ? viewToCreate.id : undefined;
      const existingViewMapping = notionViewId ? mappingsByNotionId.get(notionViewId) : undefined;
      if (existingViewMapping && existingViews.some((view) => view.id === existingViewMapping.localId)) {
        continue;
      }
      if (!notionViewId && existingViews.some((view) =>
        view.name === (optionalString(viewToCreate.name) ?? 'Table') &&
        view.type === (optionalString(viewToCreate.type) ?? 'table')
      )) {
        continue;
      }
      const inserted = await db.table<DbView>('db_views').insert(
        dbViewFromNotion(
          databaseId,
          viewToCreate,
          index,
          propMap,
          conversionReport,
          item.notionId,
          propertyRecordsByDataSource.get(item.notionId) ?? [],
        ),
      );
      created.views += 1;
      if (notionViewId) {
        await createMapping(db, admin, job, mappingsByNotionId, {
          notionId: notionViewId,
          notionType: 'view',
          localId: inserted.id,
          localType: 'db_view',
          relationKind: 'database_view',
          metadata: { dataSourceId: item.notionId },
        });
        created.mappings += 1;
      }
    }

    const templatesToCreate = rawTemplatesFromSnapshot(dataSourceSnapshot(item));
    const existingTemplates = databaseId
      ? await listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', databaseId), 1000)
      : [];
    for (let index = 0; index < templatesToCreate.length; index += 1) {
      for (const block of rawTemplateBlocks(templatesToCreate[index])) {
        reportTemplateBlockRichTextUserReferences(conversionReport, item, block);
      }
      const notionTemplateId = notionObjectId(templatesToCreate[index]);
      const existingTemplateMapping = notionTemplateId ? mappingsByNotionId.get(notionTemplateId) : undefined;
      const existingTemplate = existingTemplateMapping
        ? existingTemplates.find((template) => template.id === existingTemplateMapping.localId) ??
          await getExisting(db.table<DbTemplate>('db_templates'), existingTemplateMapping.localId)
        : undefined;
      if (existingTemplate) {
        importedTemplateContexts.push({
          template: existingTemplate,
          dataSourceId: item.notionId,
          notionId: notionTemplateId,
        });
        continue;
      }
      const inserted = await db.table<DbTemplate>('db_templates').insert(
        dbTemplateFromNotion(databaseId, templatesToCreate[index], propMap, index, conversionReport, item.notionId),
      );
      importedTemplateContexts.push({
        template: inserted,
        dataSourceId: item.notionId,
        notionId: notionTemplateId,
      });
      created.templates += 1;
      if (notionTemplateId) {
        await createMapping(db, admin, job, mappingsByNotionId, {
          notionId: notionTemplateId,
          notionType: 'template',
          localId: inserted.id,
          localType: 'db_template',
          relationKind: 'database_template',
          metadata: { dataSourceId: item.notionId, databaseId },
        });
        created.mappings += 1;
      }
    }
  }
  await updateApplyProgress('apply_database_containers', {
    totalDataSources: dataSourceItems.length,
  });

  const databaseItems = items.filter((candidate) => candidate.notionObject === 'database');
  let databaseItemsTouchedThisRun = 0;
  let databaseIndex = 0;
  if (resumeDatabasePass !== 'placeholder') {
    for (const item of databaseItems) {
      databaseIndex += 1;
      if (resumeDatabasePass === 'direct' && databaseIndex <= resumeDatabaseIndex) continue;
      const metadata = itemMetadata(item);
      const dataSources = Array.isArray(metadata.dataSources) ? metadata.dataSources : [];
      const firstDataSourceId = dataSources
        .map((source) => source && typeof source === 'object' ? notionObjectId(source as Record<string, unknown>) : undefined)
        .find((id): id is string => !!id && !!mappingsByNotionId.get(id));
      const dataSourceMapping = firstDataSourceId ? mappingsByNotionId.get(firstDataSourceId) : undefined;
      if (dataSourceMapping && !mappingsByNotionId.has(item.notionId)) {
        const localDatabase = await getExisting(db.table<Page>('pages'), dataSourceMapping.localId);
        const existingNotionDatabaseId = optionalString(localDatabase?.properties?.notionDatabaseId);
        if (localDatabase?.kind === 'database' && !existingNotionDatabaseId) {
          await db.table<Page>('pages').update(localDatabase.id, {
            properties: {
              ...(localDatabase.properties ?? {}),
              notionDatabaseId: item.notionId,
              notionDataSourceId: firstDataSourceId,
            },
          });
        }
        await createMapping(db, admin, job, mappingsByNotionId, {
          notionId: item.notionId,
          notionType: 'database',
          localId: dataSourceMapping.localId,
          localType: 'database',
          relationKind: 'database_container',
          metadata: { dataSourceId: firstDataSourceId },
        });
        created.mappings += 1;
      }
      databaseItemsTouchedThisRun += 1;
      if (
        shouldChunkDatabaseContainers &&
        applyDatabaseBatchSize > 0 &&
        databaseItemsTouchedThisRun >= applyDatabaseBatchSize &&
        databaseIndex < databaseItems.length
      ) {
        await updateApplyProgress('apply_database_containers', {
          totalDataSources: dataSourceItems.length,
          totalDatabases: databaseItems.length,
          databasePass: 'direct',
          databaseIndex,
          databaseBatchSize: applyDatabaseBatchSize,
          databasesTouchedThisRun: databaseItemsTouchedThisRun,
          paused: true,
        });
        return {
          job: cleanJob(currentJob),
          applied: created,
          mappings: Array.from(mappingsByNotionId.values()),
          partial: true,
        };
      }
    }
  }

  if (shouldChunkDatabaseContainers) {
    await updateApplyProgress('apply_database_containers', {
      totalDataSources: dataSourceItems.length,
      totalDatabases: databaseItems.length,
      databasePass: 'placeholder',
      databaseIndex: resumeDatabasePass === 'placeholder' ? resumeDatabaseIndex : 0,
      databaseBatchSize: applyDatabaseBatchSize,
    });
  }
  databaseIndex = 0;
  for (const item of databaseItems) {
    databaseIndex += 1;
    if (resumeDatabasePass === 'placeholder' && databaseIndex <= resumeDatabaseIndex) continue;
    if (mappingsByNotionId.has(item.notionId)) continue;
    const inferredSource = inferCanonicalDataSourceForHiddenLinkedDatabase(item, items, dataSourceItems, mappingsByNotionId);
    if (inferredSource) {
      const inferredFrom = inferredSource.inferredFrom ?? 'sibling_heading_view_name';
      await createMapping(db, admin, job, mappingsByNotionId, {
        notionId: item.notionId,
        notionType: 'database',
        localId: inferredSource.mapping.localId,
        localType: 'database',
        relationKind: 'database_container_inferred_from_view_context',
        metadata: {
          dataSourceId: inferredSource.dataSourceItem.notionId,
          inferredFrom,
          heading: inferredSource.heading,
          matchedLabel: inferredSource.matchedLabel,
          ...(inferredSource.matchedViewId ? { selectedViewId: inferredSource.matchedViewId } : {}),
          ...(inferredSource.matchedViewIds?.length ? { viewIds: inferredSource.matchedViewIds } : {}),
          sourceUnavailable: true,
        },
      });
      created.mappings += 1;
      incrementReport(conversionReport, 'inferredLinkedDatabases');
      const inferredFromText =
        inferredFrom === 'view_parent_database_id'
          ? `Notion view "${inferredSource.matchedViewId || inferredSource.matchedLabel}" parent.database_id`
          : `sibling heading "${inferredSource.heading}" and view label "${inferredSource.matchedLabel}"`;
      pushReportIssue(conversionReport.warnings, {
        code: 'linked_database_source_inferred',
        notionId: item.notionId,
        notionObject: 'database',
        message:
          `Notion database "${item.title || item.notionId}" did not expose data sources, ` +
          `so Hanji linked it to imported data source "${inferredSource.dataSourceItem.title || inferredSource.dataSourceItem.notionId}" ` +
          `from ${inferredFromText}.`,
      });
      databaseItemsTouchedThisRun += 1;
      if (
        shouldChunkDatabaseContainers &&
        applyDatabaseBatchSize > 0 &&
        databaseItemsTouchedThisRun >= applyDatabaseBatchSize &&
        databaseIndex < databaseItems.length
      ) {
        await updateApplyProgress('apply_database_containers', {
          totalDataSources: dataSourceItems.length,
          totalDatabases: databaseItems.length,
          databasePass: 'placeholder',
          databaseIndex,
          databaseBatchSize: applyDatabaseBatchSize,
          databasesTouchedThisRun: databaseItemsTouchedThisRun,
          paused: true,
        });
        return {
          job: cleanJob(currentJob),
          applied: created,
          mappings: Array.from(mappingsByNotionId.values()),
          partial: true,
        };
      }
      continue;
    }
    const metadata = itemMetadata(item);
    const database = asRecord(metadata.database);
    const chrome = importedPageChromeFromItem(item);
    const fallbackTitle = hiddenLinkedDatabaseFallbackTitle(item, items, database);
    let page = await db.table<Page>('pages').insert(
      basePage({
        workspaceId: job.workspaceId,
        parentId: rootPageId,
        parentType: 'page',
        kind: 'database',
        title: fallbackTitle,
        icon: chrome.icon,
        iconType: chrome.iconType,
        cover: chrome.cover,
        coverPosition: chrome.coverPosition,
        position: created.databases + 1,
        actorId,
        ...importedItemTimestamps(item),
        properties: pagePropertiesWithChromeReferences({
          notionImportJobId: job.id,
          notionDatabaseId: item.notionId,
          notionLinkedDatabaseSourceUnavailable: true,
        }, chrome),
      }),
    );
    page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
    page = await preserveImportedPageTimestamps(db, page, item);
    const titleProperty = await db.table<DbProperty>('db_properties').insert({
      id: newId(),
      databaseId: page.id,
      name: 'Name',
      type: 'title',
      position: 1,
      config: {
        notionDatabaseId: item.notionId,
        notionSourceUnavailable: true,
      },
    });
    await db.table<DbView>('db_views').insert(
      dbViewFromNotion(
        page.id,
        {
          name: meaningfulImportedTitle(item.title) || 'Table',
          type: 'table',
          sourceUnavailable: true,
          notionDatabaseId: item.notionId,
        },
        0,
        new Map([
          ['Name', titleProperty.id],
          ['title', titleProperty.id],
        ]),
        conversionReport,
        item.notionId,
      ),
    );
    await createMapping(db, admin, job, mappingsByNotionId, {
      notionId: item.notionId,
      notionType: 'database',
      localId: page.id,
      localType: 'database',
      relationKind: 'database_placeholder',
      metadata: {
        title: item.title,
        sourceUnavailable: true,
      },
    });
    created.databases += 1;
    created.properties += 1;
    created.views += 1;
    created.mappings += 1;
    incrementReport(conversionReport, 'placeholderDatabases');
    pushReportIssue(conversionReport.warnings, {
      code: 'database_source_unavailable',
      notionId: item.notionId,
      notionObject: 'database',
      message:
        `Notion database "${item.title || item.notionId}" did not expose data sources through the API, ` +
        'so Hanji imported a placeholder database instead of leaving the linked database broken.',
    });
    databaseItemsTouchedThisRun += 1;
    if (
      shouldChunkDatabaseContainers &&
      applyDatabaseBatchSize > 0 &&
      databaseItemsTouchedThisRun >= applyDatabaseBatchSize &&
      databaseIndex < databaseItems.length
    ) {
      await updateApplyProgress('apply_database_containers', {
        totalDataSources: dataSourceItems.length,
        totalDatabases: databaseItems.length,
        databasePass: 'placeholder',
        databaseIndex,
        databaseBatchSize: applyDatabaseBatchSize,
        databasesTouchedThisRun: databaseItemsTouchedThisRun,
        paused: true,
      });
      return {
        job: cleanJob(currentJob),
        applied: created,
        mappings: Array.from(mappingsByNotionId.values()),
        partial: true,
      };
    }
  }

  const pageItems = items.filter((item) => item.notionObject === 'page');
  let pageIndex = 0;
  let pagesTouchedThisRun = 0;
  let pageBatchPaused = false;
  for (const item of pageItems) {
    pageIndex += 1;
    const sourceId = rowDataSourceId(item, dataSourceIds);
    const sourceMapping = sourceId ? mappingsByNotionId.get(sourceId) : undefined;
    const parentMapping = item.parentNotionId ? mappingsByNotionId.get(item.parentNotionId) : undefined;
    const isRow = !!sourceMapping && sourceMapping.localType === 'database';
    const propMap = sourceId ? propertyMappingsByDataSource.get(sourceId) : undefined;
    const metadata = itemMetadata(item);
    const chrome = importedPageChromeFromItem(item);
    const isExplicitRootPage =
      !isRow && rootNotionPageIdSet.has(normalizedNotionId(item.notionId));
    const resolvedParent = isRow
      ? {}
      : resolveImportedPageParentFromNotionBlocks(item, mappingsByNotionId, blockOwnerContextsByNotionId);
    const existingPageMapping = mappingsByNotionId.get(item.notionId);
    if (existingPageMapping?.localType === 'page') {
      let existingPage = await getExisting(db.table<Page>('pages'), existingPageMapping.localId);
      if (existingPage && !isRow) {
        const movedPage = await moveImportedPageToResolvedParent(db, existingPage, resolvedParent);
        if (movedPage !== existingPage) {
          existingPage = movedPage;
          created.repairedPageParents += 1;
        }
      }
      if (
        existingPage &&
        isRow &&
        sourceId &&
        propMap &&
        sourceMapping?.localId &&
        importedRowFilePropertiesNeedCopy(existingPage.properties, metadata.properties, propMap)
      ) {
        existingPage = await copyImportedRowFileProperties(
          fileCopyContext,
          existingPage,
          sourceMapping.localId,
          metadata.properties,
          propMap,
          item,
        );
      }
      if (
        existingPage &&
        itemHasImportablePageBody(item) &&
        !importedBlocksComplete(existingPage)
      ) {
        const replaced = await replaceImportedBlocksForPage(
          db,
          existingPage,
          item,
          actorId,
          mappingsByNotionId,
          conversionReport,
          fileCopyContext,
          importedBlockMappingsByNotionId,
          itemsByNotionId,
        );
        created.blocks += replaced.insertedBlocks.length;
        importedPageBlockContexts.push({ page: replaced.page, notionId: item.notionId });
        if (isRow && sourceId && propMap && sourceMapping?.localId) {
          importedRowContexts.push({ page: replaced.page, dataSourceId: sourceId, notionId: item.notionId });
        }
        pagesTouchedThisRun += 1;
        if (applyPageBatchSize > 0 && pagesTouchedThisRun >= applyPageBatchSize) {
          pageBatchPaused = true;
        }
      } else if (existingPage) {
        importedPageBlockContexts.push({ page: existingPage, notionId: item.notionId });
        if (isRow && sourceId && propMap && sourceMapping?.localId) {
          importedRowContexts.push({ page: existingPage, dataSourceId: sourceId, notionId: item.notionId });
        }
      }
      if (pageBatchPaused) {
        await updateApplyProgress('apply_pages', {
          pageIndex,
          totalPages: pageItems.length,
          pageBatchSize: applyPageBatchSize,
          pagesTouchedThisRun,
          paused: true,
        });
        return {
          job: cleanJob(currentJob),
          applied: created,
          mappings: Array.from(mappingsByNotionId.values()),
          partial: true,
        };
      }
      continue;
    }
    if (existingPageMapping) continue;
    const pageProperties = isRow && propMap
      ? rowPropertiesForDataSource(metadata.properties, propMap, {
          report: conversionReport,
          notionId: item.notionId,
          notionObject: 'page',
        }, {
          omitFileValuesNeedingStorage: fileCopyContext.requireStoredFileCopies,
        })
      : {
          notionImportJobId: job.id,
          notionPageId: item.notionId,
        };
    let page = await db.table<Page>('pages').insert(
      basePage({
        workspaceId: job.workspaceId,
        parentId: isRow
          ? sourceMapping.localId
          : resolvedParent.parentId
            ? resolvedParent.parentId
            : parentMapping?.localType === 'page'
              ? parentMapping.localId
            : rootPageId,
        parentType: isRow ? 'database' : 'page',
        kind: 'page',
        title: isRow ? (item.title ?? '') : (item.title || 'Untitled'),
        icon: chrome.icon,
        iconType: chrome.iconType,
        cover: chrome.cover,
        coverPosition: chrome.coverPosition,
        fullWidth: !isRow && importedPageShouldUseFullWidth(item, importPagesFullWidth),
        isFavorite: isExplicitRootPage,
        position: resolvedParent.position ?? created.pages + created.rows + 1,
        actorId,
        ...importedItemTimestamps(item),
        properties: pagePropertiesWithChromeReferences(pageProperties, chrome),
      }),
    );
    page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
    await createMapping(db, admin, job, mappingsByNotionId, {
      notionId: item.notionId,
      notionType: 'page',
      localId: page.id,
      localType: 'page',
      relationKind: isRow ? 'database_row' : 'page',
      metadata: { dataSourceId: sourceId },
    });
    created.mappings += 1;
    if (isRow) created.rows += 1;
    else created.pages += 1;
    if (isRow && sourceId && propMap && sourceMapping?.localId) {
      page = await copyImportedRowFileProperties(fileCopyContext, page, sourceMapping.localId, metadata.properties, propMap, item);
    }
    page = await preserveImportedPageTimestamps(db, page, item);
    importedPageBlockContexts.push({ page, notionId: item.notionId });
    if (isRow && sourceId && propMap && sourceMapping?.localId) {
      importedRowContexts.push({ page, dataSourceId: sourceId, notionId: item.notionId });
    }
    const insertedBlocks = await insertPageBlocksFromSnapshot(
      db,
      page.id,
      item,
      actorId,
      mappingsByNotionId,
      conversionReport,
      fileCopyContext,
      importedBlockMappingsByNotionId,
      itemsByNotionId,
    );
    created.blocks += insertedBlocks.length;
    page = await markImportedBlocksComplete(db, page);
    pagesTouchedThisRun += 1;
    if (pageIndex % 50 === 0) {
      await updateApplyProgress('apply_pages', {
        pageIndex,
        totalPages: pageItems.length,
      });
    }
    if (applyPageBatchSize > 0 && pagesTouchedThisRun >= applyPageBatchSize) {
      await updateApplyProgress('apply_pages', {
        pageIndex,
        totalPages: pageItems.length,
        pageBatchSize: applyPageBatchSize,
        pagesTouchedThisRun,
        paused: true,
      });
      return {
        job: cleanJob(currentJob),
        applied: created,
        mappings: Array.from(mappingsByNotionId.values()),
        partial: true,
      };
    }
  }
  await updateApplyProgress('apply_remap', {
    pageIndex,
    totalPages: pageItems.length,
  });

  for (const item of pageItems) {
    const sourceId = rowDataSourceId(item, dataSourceIds);
    const sourceMapping = sourceId ? mappingsByNotionId.get(sourceId) : undefined;
    if (sourceMapping?.localType === 'database') continue;
    const pageMapping = mappingsByNotionId.get(item.notionId);
    if (pageMapping?.localType !== 'page') continue;
    const page = await getExisting(db.table<Page>('pages'), pageMapping.localId);
    if (!page) continue;
    const resolvedParent = resolveImportedPageParentFromNotionBlocks(item, mappingsByNotionId, blockOwnerContextsByNotionId);
    const movedPage = await moveImportedPageToResolvedParent(db, page, resolvedParent);
    if (movedPage !== page) created.repairedPageParents += 1;
  }

  await remapImportedPageBlockRichTextMentions(
    db,
    importedPageBlockContexts,
    mappingsByNotionId,
    conversionReport,
  );

  const pageLinkRemap = await remapImportedPageLinkBlocks(
    db,
    importedPageBlockContexts,
    mappingsByNotionId,
    conversionReport,
  );
  created.remappedLinkBlocks = pageLinkRemap.updatedBlocks;
  created.unresolvedImportReferences += pageLinkRemap.unresolvedTargets;

  await remapImportedSyncedBlocks(
    db,
    importedPageBlockContexts,
    importedBlockMappingsByNotionId,
    conversionReport,
  );

  const propertyRemap = await remapImportedDatabaseProperties(
    db,
    importedPropertyContexts,
    propertyMappingsByDataSource,
    mappingsByNotionId,
    conversionReport,
  );
  created.remappedProperties = propertyRemap.remapped;
  created.unresolvedImportReferences += propertyRemap.unresolved;
  if (propertyRemap.unresolved > 0) {
    incrementReport(conversionReport, 'unresolvedPropertyReferences', propertyRemap.unresolved);
    pushReportIssue(conversionReport.unresolvedReferences, {
      code: 'property_reference_unresolved',
      notionObject: 'property',
      message: `${propertyRemap.unresolved} relation, rollup, or formula property reference(s) could not be mapped to local IDs.`,
    });
  }

  const viewRelationFilterRemap = await remapImportedDatabaseViewRelationFilters(
    db,
    dataSourceItems,
    propertyRecordsByDataSource,
    mappingsByNotionId,
    conversionReport,
  );
  created.remappedViewRelationFilters = viewRelationFilterRemap.updatedViews;
  created.unresolvedImportReferences += viewRelationFilterRemap.unresolved;

  for (const rowContext of importedRowContexts) {
    const relationProps = (propertyRecordsByDataSource.get(rowContext.dataSourceId) ?? [])
      .filter((prop) => prop.type === 'relation');
    if (relationProps.length === 0) continue;
    const properties = remapImportedRowRelationProperties(rowContext.page, relationProps, mappingsByNotionId);
    if (!properties) continue;
    await db.table<Page>('pages').update(rowContext.page.id, { properties });
    created.remappedRowRelations += 1;
    const unresolved = properties.__notionRelationUnresolved;
    if (unresolved && typeof unresolved === 'object') {
      const unresolvedCount = Object.values(unresolved as Record<string, unknown>)
        .reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
      created.unresolvedImportReferences += unresolvedCount;
      if (unresolvedCount > 0) {
        incrementReport(conversionReport, 'unresolvedRowRelationValues', unresolvedCount);
        pushReportIssue(conversionReport.unresolvedReferences, {
          code: 'row_relation_values_unresolved',
          notionId: rowContext.notionId,
          notionObject: 'page',
          message: `${unresolvedCount} relation value(s) on "${rowContext.page.title || rowContext.notionId}" could not be mapped to local row pages.`,
        });
      }
    }
  }

  const linkedDatabaseContextFilterRemap = await addImportedLinkedDatabaseRowContextFilters(
    db,
    importedPageBlockContexts,
    conversionReport,
  );
  created.remappedLinkedDatabaseContextFilters = linkedDatabaseContextFilterRemap.updatedViews;

  for (const templateContext of importedTemplateContexts) {
    const relationProps = (propertyRecordsByDataSource.get(templateContext.dataSourceId) ?? [])
      .filter((prop) => prop.type === 'relation');
    const patch: Partial<DbTemplate> = {};
    const relationRemap = relationProps.length > 0
      ? remapImportedTemplateRelationProperties(templateContext.template, relationProps, mappingsByNotionId)
      : { properties: undefined, unresolved: {} };
    const properties = relationRemap.properties;
    if (properties) {
      patch.properties = properties;
      templateContext.template.properties = properties;
      created.remappedTemplateRelations += 1;
      const unresolved = relationRemap.unresolved;
      if (unresolved && typeof unresolved === 'object') {
        const unresolvedCount = Object.values(unresolved as Record<string, unknown>)
          .reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
        created.unresolvedImportReferences += unresolvedCount;
        if (unresolvedCount > 0) {
          incrementReport(conversionReport, 'unresolvedTemplateRelationValues', unresolvedCount);
          pushReportIssue(conversionReport.unresolvedReferences, {
            code: 'template_relation_values_unresolved',
            notionId: templateContext.notionId,
            notionObject: 'template',
            message: `${unresolvedCount} relation default value(s) on imported template "${templateContext.template.name || templateContext.template.id}" could not be mapped to local row pages.`,
          });
        }
      }
    }

    let templateBlocks = templateContext.template.blocks;
    const blockMentionRemap = remapImportedTemplateBlocksRichTextMentions(templateBlocks, mappingsByNotionId);
    if (blockMentionRemap.changed) {
      templateBlocks = blockMentionRemap.blocks;
    }
    reportRichTextMentionRemap(
      conversionReport,
      templateContext.notionId,
      'template',
      `template "${templateContext.template.name || templateContext.template.id}"`,
      blockMentionRemap,
    );

    if (templateBlocks !== templateContext.template.blocks) {
      templateContext.template.blocks = templateBlocks;
    }
    const linkedBlockRemap = await remapImportedTemplateLinkedDatabaseBlocks(
      db,
      templateContext,
      mappingsByNotionId,
    );
    if (linkedBlockRemap.changed) {
      templateBlocks = linkedBlockRemap.blocks;
      templateContext.template.blocks = linkedBlockRemap.blocks;
    }
    if (templateBlocks !== templateContext.template.blocks || blockMentionRemap.changed || linkedBlockRemap.changed) {
      patch.blocks = templateBlocks;
    }

    if (Object.keys(patch).length === 0) continue;
    await db.table<DbTemplate>('db_templates').update(templateContext.template.id, patch);
  }

  const allMappings = Array.from(mappingsByNotionId.values());
  const finishedAt = nowIso();
  const conversion = finalizeConversionReport(conversionReport);
  const updated = await jobs.update(job.id, {
    status: 'completed',
    phase: 'applied',
    progress: {
      ...withImportProgress(currentJob.progress, {
        key: 'apply',
        status: 'completed',
        legacyStep: 'applied_to_local_workspace',
        percent: 100,
        at: finishedAt,
        counts: created,
      }),
      applied: created,
    },
    report: {
      ...(currentJob.report ?? {}),
      applied: created,
      conversion,
      completedAt: finishedAt,
    },
    options: importPagesFullWidth !== undefined
      ? {
          ...(currentJob.options ?? {}),
          importPagesFullWidth,
        }
      : currentJob.options,
    finishedAt,
  });

  await recordWorkspaceAudit(db, {
    workspaceId: job.workspaceId,
    actorId,
    action: 'notion_import.apply',
    targetType: 'notion_import_job',
    targetId: job.id,
    metadata: created,
    occurredAt: finishedAt,
  });

  // Imported pages/databases are page rows; write their routing index rows
  // synchronously so pageId-only entry points resolve the moment apply
  // returns (the async DB trigger remains the safety net).
  await ensureImportedPageWorkspaceIndexes(admin, allMappings, job.workspaceId);

  return {
    job: cleanJob(updated),
    applied: created,
    mappings: allMappings,
  };
}

async function preflightJob(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const parentPageId = optionalString(body.parentPageId);
  await assertWritableImportTarget(db, workspaceId, parentPageId, actorId);

  const connectionId = optionalString(body.connectionId);
  const tokenSource = await notionTokenForJob(db, body, { connectionId, options: { connectionId } }, actorId, env);
  if (tokenSource.connection?.workspaceId && tokenSource.connection.workspaceId !== workspaceId) {
    throw new Error('Notion import connection belongs to another workspace.');
  }
  const rootNotionPageIds = parseStringArray(body.rootNotionPageIds);
  const rootNotionDataSourceIds = parseStringArray(body.rootNotionDataSourceIds);
  if (!rootNotionPageIds.length && !rootNotionDataSourceIds.length) {
    throw new Error('rootNotionPageIds or rootNotionDataSourceIds is required for Notion import preflight.');
  }

  const preflight = await preflightNotionImportGraph(tokenSource.token, {
    apiVersion: optionalString(body.apiVersion) ?? NOTION_API_VERSION,
    rootNotionPageIds,
    rootNotionDataSourceIds,
    apiBase: notionApiBase(env),
  });
  await recordWorkspaceAudit(db, {
    workspaceId,
    actorId,
    action: 'notion_import.preflight',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: {
      rootNotionPageIds,
      rootNotionDataSourceIds,
      connectionId: tokenSource.connectionId,
      credentialSource: tokenSource.credentialSource,
      summary: preflight.summary,
    },
    occurredAt: nowIso(),
  });
  return { preflight };
}

async function scanAccessibleNotionRoots(
  token: string,
  options: {
    apiVersion: string;
    maxSearchPages: number;
    apiBase?: string;
    startCursor?: string;
    includeWorkspace?: boolean;
  },
) {
  const notionWorkspace = options.includeWorkspace === false
    ? undefined
    : notionWorkspaceInfo(await notionRequest(token, '/users/me', options.apiVersion, { apiBase: options.apiBase }));
  const records: Record<string, unknown>[] = [];
  let cursor: string | undefined = options.startCursor;
  let hasMore = false;
  let nextCursor: string | undefined;
  let searchPagesFetched = 0;
  let incompleteReason: string | undefined;

  for (let page = 0; page < options.maxSearchPages; page += 1) {
    const response = await notionRequest(token, '/search', options.apiVersion, {
      method: 'POST',
      body: {
        page_size: 100,
        sort: {
          direction: 'descending',
          timestamp: 'last_edited_time',
        },
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      apiBase: options.apiBase,
    });
    searchPagesFetched += 1;
    const results = Array.isArray(response.results)
      ? response.results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      : [];
    records.push(...results);
    const requestStatus = asRecord(response.request_status);
    incompleteReason = optionalString(requestStatus?.incomplete_reason) ?? incompleteReason;
    hasMore = response.has_more === true;
    nextCursor = optionalString(response.next_cursor);
    cursor = nextCursor;
    if (!hasMore || !cursor) break;
  }

  return {
    roots: notionAccessibleRootCandidates(records),
    items: records.map(compactNotionRootScanItem).filter((item): item is NotionImportRootScanItem => !!item),
    scanned: records.length,
    searchPagesFetched,
    hasMore,
    nextCursor: nextCursor ?? null,
    incompleteReason: incompleteReason ?? null,
    notionWorkspace,
  };
}

async function listAccessibleRoots(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const parentPageId = optionalString(body.parentPageId);
  await assertWritableImportTarget(db, workspaceId, parentPageId, actorId);

  const connectionId = optionalString(body.connectionId);
  const tokenSource = await notionTokenForJob(db, body, { connectionId, options: { connectionId } }, actorId, env);
  if (tokenSource.connection?.workspaceId && tokenSource.connection.workspaceId !== workspaceId) {
    throw new Error('Notion import connection belongs to another workspace.');
  }

  const scan = await scanAccessibleNotionRoots(tokenSource.token, {
    apiVersion: optionalString(body.apiVersion) ?? NOTION_API_VERSION,
    maxSearchPages: parsePositiveInt(
      body.maxSearchPages,
      NOTION_ROOT_SCAN_DEFAULT_PAGE_LIMIT,
      NOTION_ROOT_SCAN_MAX_PAGE_LIMIT,
    ),
    apiBase: notionApiBase(env),
    startCursor: optionalString(body.startCursor),
    includeWorkspace: body.includeWorkspace !== false,
  });

  if (body.recordAudit !== false) {
    await recordWorkspaceAudit(db, {
      workspaceId,
      actorId,
      action: 'notion_import.root_scan',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: {
        connectionId: tokenSource.connectionId,
        credentialSource: tokenSource.credentialSource,
        tokenFingerprint: tokenSource.tokenFingerprint,
        scanned: scan.scanned,
        roots: scan.roots.length,
        searchPagesFetched: scan.searchPagesFetched,
        hasMore: scan.hasMore,
        incompleteReason: scan.incompleteReason,
        incremental: !!optionalString(body.startCursor),
      },
      occurredAt: nowIso(),
    });
  }

  return scan;
}

async function createJobRecord(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
  retryOfJobId?: string,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const parentPageId = optionalString(body.parentPageId);
  await assertWritableImportTarget(db, workspaceId, parentPageId, actorId);

  const connectionKind = parseConnectionKind(body.connectionKind);
  const connectionId = optionalString(body.connectionId);
  const rootNotionPageIds = parseStringArray(body.rootNotionPageIds);
  const rootNotionDataSourceIds = parseStringArray(body.rootNotionDataSourceIds);
  const providedSnapshotItems = parseSnapshotItems(body.snapshotItems);
  const mcpFetchSnapshotItems = parseMcpFetchItems(body.mcpFetches);
  const snapshotItems = expandSnapshotItems([...providedSnapshotItems, ...mcpFetchSnapshotItems]);
  const token = optionalString(body.notionToken);
  const tokenSource = token || connectionId
    ? await notionTokenForJob(db, body, { connectionId, options: { connectionId } }, actorId, env)
    : undefined;
  if (tokenSource?.connection?.workspaceId && tokenSource.connection.workspaceId !== workspaceId) {
    throw new Error('Notion import connection belongs to another workspace.');
  }
  const now = nowIso();
  const maxDiscoveryPages = parsePositiveInt(
    body.maxDiscoveryPages,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxEnrichedItems = parsePositiveInt(
    body.maxEnrichedItems,
    NOTION_ENRICHMENT_BATCH_SIZE,
    NOTION_ENRICHMENT_BATCH_SIZE_MAX,
  );
  const maxChildrenPages = parsePositiveInt(
    body.maxChildrenPages,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxDataSourceQueryPages = parsePositiveInt(
    body.maxDataSourceQueryPages,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxViewPages = parsePositiveInt(
    body.maxViewPages,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxTemplatePages = parsePositiveInt(
    body.maxTemplatePages,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const discoveryConcurrency = parsePositiveInt(
    body.discoveryConcurrency,
    NOTION_DISCOVERY_CONCURRENCY_DEFAULT,
    NOTION_DISCOVERY_CONCURRENCY_MAX,
  );
  const includeMarkdownFallback = parseBoolean(body.includeMarkdownFallback, true);
  const importPagesFullWidth = parseOptionalBoolean(body.importPagesFullWidth);
  assertNotionFileCopyNotDisabled(body);
  const deferDiscovery = parseBoolean(body.deferDiscovery, false);
  const shouldRunDiscovery = !!tokenSource && !deferDiscovery && providedSnapshotItems.length === 0;
  const readySnapshotItems = shouldRunDiscovery ? [] : snapshotItems;
  const discoverySupplementalSnapshotItems = shouldRunDiscovery ? snapshotItems : [];

  const job = await db.table<NotionImportJob>('notion_import_jobs').insert({
    id: newId(),
    workspaceId,
    source: 'notion_api',
    connectionKind,
    connectionId: tokenSource?.connectionId,
    status: shouldRunDiscovery ? 'discovering' : readySnapshotItems.length ? 'ready' : 'queued',
    phase: shouldRunDiscovery
      ? 'api_search'
      : readySnapshotItems.length
        ? 'snapshot_ready'
        : deferDiscovery && tokenSource
          ? 'discovery_deferred'
          : 'awaiting_connection',
    actorId,
    parentPageId,
    rootNotionPageIds,
    rootNotionDataSourceIds,
    apiVersion: NOTION_API_VERSION,
    options: {
      importMode: 'workspace_graph',
      preserveLinkedDatabases: true,
      preserveViewUi: true,
      preserveFiles: true,
      maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      maxTemplatePages,
      discoveryConcurrency,
      includeMarkdownFallback,
      ...(importPagesFullWidth !== undefined ? { importPagesFullWidth } : {}),
      rootNotionDataSourceIds,
      deferDiscovery,
      connectionId: tokenSource?.connectionId,
      credentialSource: tokenSource?.credentialSource,
      tokenFingerprint: tokenSource?.tokenFingerprint,
      tokenStored: false,
      snapshotItems: providedSnapshotItems.length,
      mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
      discoverySupplementalSnapshotItems: discoverySupplementalSnapshotItems.length,
    },
    counts: {},
    progress: {
      ...withImportProgress(undefined, shouldRunDiscovery
        ? {
            key: 'discover',
            status: 'running',
            legacyStep: 'discovering_accessible_workspace_graph',
            percent: 25,
          }
        : readySnapshotItems.length
          ? {
              key: 'discover',
              status: 'completed',
              legacyStep: 'ready_for_graph_planning',
              percent: 50,
              counts: { discovered: readySnapshotItems.length, totalKnown: readySnapshotItems.length },
            }
          : {
              key: deferDiscovery && tokenSource ? 'discover' : 'connect',
              status: 'pending',
              legacyStep: deferDiscovery && tokenSource ? 'waiting_for_discovery' : 'waiting_for_notion_connection',
              percent: deferDiscovery && tokenSource ? 15 : 5,
            }),
      discovered: readySnapshotItems.length,
      totalKnown: readySnapshotItems.length,
    },
    report: baseReport({
      rootNotionPageIds,
      rootNotionDataSourceIds,
      tokenStored: false,
      connectionId: tokenSource?.connectionId,
      credentialSource: tokenSource?.credentialSource,
      snapshotProvided: snapshotItems.length > 0,
      snapshotItems: providedSnapshotItems.length,
      mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
      discoverySupplementalSnapshotItems: discoverySupplementalSnapshotItems.length,
      deferDiscovery,
      ...(importPagesFullWidth !== undefined ? { importPagesFullWidth } : {}),
    }),
    retryOfJobId,
    startedAt: shouldRunDiscovery ? now : undefined,
  });

  await recordWorkspaceAudit(db, {
    workspaceId,
    actorId,
    action: 'notion_import.create',
    targetType: 'notion_import_job',
    targetId: job.id,
    metadata: {
      connectionKind,
      connectionId: tokenSource?.connectionId,
      credentialSource: tokenSource?.credentialSource,
      hasToken: !!token,
      retryOfJobId,
      rootNotionPageIds,
      rootNotionDataSourceIds,
      snapshotItems: snapshotItems.length,
      mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
      discoverySupplementalSnapshotItems: discoverySupplementalSnapshotItems.length,
      deferDiscovery,
      ...(importPagesFullWidth !== undefined ? { importPagesFullWidth } : {}),
    },
    occurredAt: now,
  });

  if (readySnapshotItems.length) {
    const inserted = await replaceDiscoveredItems(db, job, readySnapshotItems);
    const counts = inserted.reduce<Record<string, number>>((acc, item) => {
      acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
      return acc;
    }, {});
    const updated = await db.table<NotionImportJob>('notion_import_jobs').update(job.id, {
      status: 'ready',
      phase: 'snapshot_ready',
      counts,
      progress: {
        ...withImportProgress(job.progress, {
          key: 'discover',
          status: 'completed',
          legacyStep: 'ready_for_graph_planning',
          percent: 50,
          counts: { discovered: inserted.length, totalKnown: inserted.length },
        }),
        discovered: inserted.length,
        totalKnown: inserted.length,
      },
      report: baseReport({
        rootNotionPageIds,
        rootNotionDataSourceIds,
        tokenStored: false,
        snapshotProvided: true,
        snapshotItems: providedSnapshotItems.length,
        mcpFetchSnapshotItems: mcpFetchSnapshotItems.length,
        discoveredByObject: counts,
      }),
      finishedAt: now,
    });
    return {
      job: cleanJob(updated),
      items: inserted.map(cleanItem),
    };
  }

  if (!tokenSource || deferDiscovery) return { job: cleanJob(job), items: [] };
  return discoverJob(
    db,
    {
      jobId: job.id,
      notionToken: tokenSource.credentialSource === 'request' ? tokenSource.token : undefined,
      connectionId: tokenSource.credentialSource === 'connection' ? tokenSource.connectionId : undefined,
      maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      maxTemplatePages,
      discoveryConcurrency,
      includeMarkdownFallback,
    },
    actorId,
    env,
    tokenSource,
    discoverySupplementalSnapshotItems,
  );
}

// Mirrors the frontend's isLiveNotionJob: a job that is queued, discovering, or
// mid-apply must never be pruned.
export function isLiveImportJob(job: NotionImportJob) {
  if (job.status === 'queued' || job.status === 'discovering') return true;
  return (job.progress as { currentStatus?: unknown } | undefined)?.currentStatus === 'running';
}

function importJobRetentionMs(env: Record<string, unknown> | undefined) {
  const raw = envString(env, NOTION_IMPORT_JOB_RETENTION_DAYS_ENV);
  const days = raw !== undefined ? Number(raw) : NaN;
  if (Number.isFinite(days) && days > 0) return days * 24 * 60 * 60 * 1000;
  return NOTION_IMPORT_JOB_RETENTION_MS_DEFAULT;
}

function importJobTimestampMs(job: NotionImportJob) {
  const stamp = job.updatedAt ?? job.createdAt;
  if (!stamp) return undefined;
  const ms = new Date(stamp).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

// Opportunistic housekeeping: delete finished/stale, non-live job records (and
// their discovered items) that are older than the retention window OR beyond the
// per-workspace keep cap. Returns the set of pruned job ids so the caller omits
// them from the response. Best-effort — a delete failure never breaks listing.
export async function pruneStaleImportJobs(
  db: DbRef,
  jobs: NotionImportJob[],
  env: Record<string, unknown> | undefined,
): Promise<Set<string>> {
  const pruned = new Set<string>();
  const retentionMs = importJobRetentionMs(env);
  const nowMs = Date.now();
  const nonLive = jobs
    .filter((job) => !isLiveImportJob(job))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  const candidates: NotionImportJob[] = [];
  nonLive.forEach((job, index) => {
    const stampMs = importJobTimestampMs(job);
    const tooOld = stampMs !== undefined && nowMs - stampMs > retentionMs;
    const beyondCap = index >= NOTION_IMPORT_JOB_KEEP_MAX;
    if (tooOld || beyondCap) candidates.push(job);
  });
  if (!candidates.length) return pruned;

  // Delete the oldest candidates first, capped per call to bound request cost;
  // repeated listings converge on a clean table.
  const toPrune = candidates
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .slice(0, NOTION_IMPORT_JOB_PRUNE_BATCH_MAX);
  const jobTable = db.table<NotionImportJob>('notion_import_jobs');
  const itemTable = db.table<NotionImportItem>('notion_import_items');
  for (const job of toPrune) {
    const items = await listAll(itemTable.where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
    await Promise.all(items.map((item) => bestEffort('notion-import prune item.delete', itemTable.delete(item.id))));
    const deleted = await bestEffort('notion-import prune job.delete', jobTable.delete(job.id));
    if (deleted) pruned.add(job.id);
  }
  return pruned;
}

async function listJobs(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertWorkspaceRole(db, workspaceId, actorId, 'view');
  const limit = parsePositiveInt(body.limit, 20, 100);
  const jobs = await listAll(db.table<NotionImportJob>('notion_import_jobs').where('workspaceId', '==', workspaceId), 500);
  // Pruning hard-deletes job/item rows, so a view-only member may list but
  // must not trigger destructive housekeeping; editors' listings still
  // converge on a clean table.
  const role = await workspaceRole(db, workspaceId, actorId);
  const canPrune = !!role && roleRanks[role] >= roleRanks.edit;
  const pruned = canPrune ? await pruneStaleImportJobs(db, jobs, env) : new Set<string>();
  return {
    jobs: jobs
      .filter((job) => !pruned.has(job.id))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, limit)
      .map(cleanJob),
  };
}

// Recovery for imports created before per-page index writes (or interrupted
// mid-apply): re-derives the central page_workspace_index from this workspace's
// import mappings so orphaned imported pages become openable by /p/:id again.
// Idempotent — ensurePageWorkspaceIndex no-ops when the row already matches.
async function repairImportPageIndexes(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertWorkspaceRole(db, workspaceId, actorId, 'edit');
  const mappings = await listAll(
    db.table<NotionImportMapping>('notion_import_mappings').where('workspaceId', '==', workspaceId),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  const seen = new Set<string>();
  let repaired = 0;
  for (const mapping of mappings) {
    if (
      (mapping.localType === 'page' || mapping.localType === 'database') &&
      typeof mapping.localId === 'string' &&
      mapping.localId.length > 0 &&
      !seen.has(mapping.localId)
    ) {
      seen.add(mapping.localId);
      await ensurePageWorkspaceIndex(admin, mapping.localId, workspaceId);
      repaired += 1;
    }
  }
  return { repaired };
}

async function getJob(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const jobId = requireString(body.jobId, 'jobId');
  const job = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertReadableJob(db, job, actorId);
  const items = await listAll(db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  return {
    job: cleanJob(job),
    items: items.map(cleanItem),
  };
}

async function appendSnapshotItemsJob(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
) {
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  if (job.status === 'completed' || job.status === 'cancelled') {
    throw new Error(`Cannot append discovery items to a ${job.status} Notion import job.`);
  }

  const snapshotItems = expandSnapshotItems(parseSnapshotItems(body.snapshotItems));
  const markReady = parseBoolean(body.markReady, false);
  const importedBatchId = optionalString(body.batchId);
  const clientDiscoveryState = asRecord(body.clientDiscoveryState);
  const beforeItems = await listAll(
    db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  const merged = snapshotItems.length
    ? await mergeDiscoveredItems(db, job, snapshotItems)
    : beforeItems;
  const counts = countImportItemsByObject(merged);
  const finishedAt = markReady ? nowIso() : undefined;
  const appendCounts = {
    appended: snapshotItems.length,
    totalKnown: merged.length,
    ...(importedBatchId ? { batchId: importedBatchId } : {}),
  };
  const progress = {
    ...withImportProgress(job.progress, {
      key: 'discover',
      status: markReady ? 'completed' : 'running',
      legacyStep: markReady ? 'ready_for_graph_planning' : 'chunked_discovery',
      percent: markReady ? 50 : 35,
      counts: appendCounts,
      at: finishedAt,
    }),
    discovered: merged.length,
    totalKnown: merged.length,
    chunkedDiscovery: true,
    lastBatchSize: snapshotItems.length,
    ...(importedBatchId ? { lastBatchId: importedBatchId } : {}),
    ...(clientDiscoveryState ? { clientDiscoveryState } : {}),
  };
  const patch: Partial<NotionImportJob> = {
    status: markReady ? 'ready' : 'discovering',
    phase: markReady ? 'discovery_complete' : 'chunked_discovery',
    counts,
    progress,
    report: baseReport({
      ...(job.report ?? {}),
      rootNotionPageIds: job.rootNotionPageIds ?? [],
      rootNotionDataSourceIds: job.rootNotionDataSourceIds ??
        parseStringArray((job.options as { rootNotionDataSourceIds?: unknown } | undefined)?.rootNotionDataSourceIds),
      tokenStored: false,
      chunkedDiscovery: true,
      appendedSnapshotItems: ((job.report as { appendedSnapshotItems?: number } | undefined)?.appendedSnapshotItems ?? 0) +
        snapshotItems.length,
      discoveredByObject: counts,
      totalKnownItems: merged.length,
      ...(clientDiscoveryState ? { clientDiscoveryState } : {}),
    }),
    error: null,
    finishedAt: finishedAt ?? null,
  };
  const updated = await jobs.update(job.id, patch);

  await recordWorkspaceAudit(db, {
    workspaceId: job.workspaceId,
    actorId,
    action: markReady ? 'notion_import.discovery_finalize' : 'notion_import.discovery_append',
    targetType: 'notion_import_job',
    targetId: job.id,
    metadata: {
      ...(importedBatchId ? { batchId: importedBatchId } : {}),
      appended: snapshotItems.length,
      totalKnown: merged.length,
      counts,
      markReady,
    },
    occurredAt: nowIso(),
  });

  return {
    job: cleanJob(updated),
    appended: snapshotItems.length,
    totalKnown: merged.length,
    counts,
  };
}

async function planJob(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  if (job.status !== 'ready') {
    const existingPlan = job.report && typeof job.report === 'object'
      ? (job.report as Record<string, unknown>).plan
      : undefined;
    return {
      job: cleanJob(job),
      plan: existingPlan ?? {
        status: 'blocked',
        generatedAt: nowIso(),
        counts: job.counts ?? {},
        estimatedWrites: {},
        conversion: finalizeConversionReport(emptyConversionReport()),
        canApply: false,
      },
    };
  }

  const items = await listAll(db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  if (items.length === 0) throw new Error('Notion import job has no discovered items.');
  const plan = buildImportPlan(job, items);
  const updated = await jobs.update(job.id, {
    progress: {
      ...withImportProgress(job.progress, {
        key: 'review',
        status: 'completed',
        legacyStep: 'ready_for_import_review',
        percent: 60,
        counts: plan.estimatedWrites,
      }),
      plan: plan.estimatedWrites,
    },
    report: {
      ...(job.report ?? {}),
      plan,
    },
  });
  await recordWorkspaceAudit(db, {
    workspaceId: job.workspaceId,
    actorId,
    action: 'notion_import.plan',
    targetType: 'notion_import_job',
    targetId: job.id,
    metadata: {
      estimatedWrites: plan.estimatedWrites,
      conversionSummary: plan.conversion.summary,
    },
    occurredAt: plan.generatedAt,
  });
  return {
    job: cleanJob(updated),
    plan,
  };
}

async function discoverJob(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
  preloadedTokenSource?: NotionTokenSource,
  supplementalSnapshotItems: DiscoveredNotionItem[] = [],
) {
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  if (job.status === 'cancelled') throw new Error('Notion import job is cancelled.');
  const tokenSource = preloadedTokenSource ?? await notionTokenForJob(db, body, job, actorId, env);
  const continueFromCursor = parseBoolean(body.continueFromCursor, false);
  const apiBase = notionApiBase(env);
  const previousNextCursor = optionalString((job.progress as Record<string, unknown> | undefined)?.nextCursor)
    ?? optionalString((job.report as Record<string, unknown> | undefined)?.nextCursor);
  if (continueFromCursor && !previousNextCursor) {
    throw new Error('No Notion search cursor is available to continue discovery.');
  }

  const maxDiscoveryPages = parsePositiveInt(
    body.maxDiscoveryPages,
    Number((job.options as { maxDiscoveryPages?: unknown } | undefined)?.maxDiscoveryPages) || NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const jobOptions = job.options as
    | {
        maxEnrichedItems?: unknown;
        maxChildrenPages?: unknown;
        maxDataSourceQueryPages?: unknown;
        maxViewPages?: unknown;
        maxTemplatePages?: unknown;
        discoveryConcurrency?: unknown;
        includeMarkdownFallback?: unknown;
        rootNotionDataSourceIds?: unknown;
      }
    | undefined;
  const rootNotionDataSourceIds = Array.isArray(job.rootNotionDataSourceIds) && job.rootNotionDataSourceIds.length
    ? job.rootNotionDataSourceIds
    : parseStringArray(jobOptions?.rootNotionDataSourceIds);
  const maxEnrichedItems = parsePositiveInt(
    body.maxEnrichedItems,
    Number(jobOptions?.maxEnrichedItems) || NOTION_ENRICHMENT_BATCH_SIZE,
    NOTION_ENRICHMENT_BATCH_SIZE_MAX,
  );
  const maxChildrenPages = parsePositiveInt(
    body.maxChildrenPages,
    Number(jobOptions?.maxChildrenPages) || NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxDataSourceQueryPages = parsePositiveInt(
    body.maxDataSourceQueryPages,
    Number(jobOptions?.maxDataSourceQueryPages) || NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxViewPages = parsePositiveInt(
    body.maxViewPages,
    Number(jobOptions?.maxViewPages) || NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const maxTemplatePages = parsePositiveInt(
    body.maxTemplatePages,
    Number(jobOptions?.maxTemplatePages) || NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
    NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  );
  const discoveryConcurrency = parsePositiveInt(
    body.discoveryConcurrency,
    Number(jobOptions?.discoveryConcurrency) || NOTION_DISCOVERY_CONCURRENCY_DEFAULT,
    NOTION_DISCOVERY_CONCURRENCY_MAX,
  );
  const includeMarkdownFallback = parseBoolean(
    body.includeMarkdownFallback,
    typeof jobOptions?.includeMarkdownFallback === 'boolean' ? jobOptions.includeMarkdownFallback : true,
  );
  const startedAt = nowIso();
  const discoveryProgress = withImportProgress(job.progress, {
    key: 'discover',
    status: 'running',
    legacyStep: 'discovering_accessible_workspace_graph',
    percent: 25,
    message: continueFromCursor ? 'Continuing from the saved Notion search cursor.' : undefined,
    at: startedAt,
  });
  await jobs.update(job.id, {
    status: 'discovering',
    phase: 'api_search',
    error: null,
    startedAt,
    finishedAt: null,
    progress: {
      ...discoveryProgress,
      continuedFromCursor: continueFromCursor,
      searchStartCursor: continueFromCursor ? previousNextCursor : undefined,
    },
    options: {
      ...(job.options ?? {}),
      maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      maxTemplatePages,
      discoveryConcurrency,
      includeMarkdownFallback,
      connectionId: tokenSource.connectionId,
      credentialSource: tokenSource.credentialSource,
      tokenFingerprint: tokenSource.tokenFingerprint,
      tokenStored: false,
    },
  });

  // Persist a live progress snapshot at most ~once/sec while discovery runs, so
  // the polled step-3 panel shows the discovered count climbing and the bar
  // moving (25→~48%) instead of freezing at the initial 25%. Best-effort +
  // single-in-flight: a dropped write just skips one tick. The authoritative
  // ready/failed write must always land last, so finalizeDiscoveryProgress
  // stops new ticks and awaits the in-flight one before that final update —
  // otherwise a straggling throttled write could overwrite terminal progress
  // with a stale "running" snapshot.
  let lastProgressWriteMs = 0;
  let progressWriteInFlight: Promise<boolean> | null = null;
  let progressFinalized = false;
  const onDiscoveryProgress = (snapshot: DiscoveryProgressSnapshot) => {
    if (progressFinalized || progressWriteInFlight) return;
    const nowMs = Date.now();
    if (nowMs - lastProgressWriteMs < NOTION_DISCOVERY_PROGRESS_INTERVAL_MS) return;
    lastProgressWriteMs = nowMs;
    const percent = discoveryProgressPercent(snapshot);
    progressWriteInFlight = bestEffort(
      'notion-import discovery progress',
      jobs.update(job.id, {
        progress: {
          ...withImportProgress(job.progress, {
            key: 'discover',
            status: 'running',
            legacyStep: 'discovering_accessible_workspace_graph',
            percent,
            counts: { discovered: snapshot.discovered, totalKnown: snapshot.discovered },
          }),
          discovered: snapshot.discovered,
          totalKnown: snapshot.discovered,
        },
      }),
    );
    void progressWriteInFlight.finally(() => {
      progressWriteInFlight = null;
    });
  };
  const finalizeDiscoveryProgress = async () => {
    progressFinalized = true;
    const inFlight = progressWriteInFlight;
    if (inFlight) await inFlight.catch(() => {});
  };

  try {
    const discovery = await discoverNotionGraph(tokenSource.token, {
      apiVersion: job.apiVersion || NOTION_API_VERSION,
      maxPages: maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      maxTemplatePages,
      discoveryConcurrency,
      includeMarkdownFallback,
      rootNotionPageIds: job.rootNotionPageIds ?? [],
      rootNotionDataSourceIds,
      startCursor: continueFromCursor ? previousNextCursor : undefined,
      apiBase,
      onProgress: onDiscoveryProgress,
    });
    const missingRootPageIds = missingRequestedRootIds(job.rootNotionPageIds ?? [], discovery.items);
    if (missingRootPageIds.length) {
      throw new Error(
        `Notion import could not read requested root page(s): ${missingRootPageIds.join(', ')}. ` +
        'Share those page(s) and their linked databases with the configured Notion integration before importing.',
      );
    }
    const missingRootDataSourceIds = missingRequestedRootIds(rootNotionDataSourceIds, discovery.items);
    if (missingRootDataSourceIds.length) {
      throw new Error(
        `Notion import could not read requested root data source(s): ${missingRootDataSourceIds.join(', ')}. ` +
        'Share those data source(s) with the configured Notion integration before importing.',
      );
    }
    const currentDiscoveryItems = supplementalSnapshotItems.length
      ? expandSnapshotItems([...discovery.items, ...supplementalSnapshotItems])
      : discovery.items;
    const discoveredItems = continueFromCursor
      ? await mergeDiscoveredItems(db, job, currentDiscoveryItems)
      : await replaceDiscoveredItems(db, job, currentDiscoveryItems);
    const totalGraphCounts = discoveredItems.reduce<Record<string, number>>((acc, item) => {
      acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
      return acc;
    }, {});
    const finishedAt = nowIso();
    await finalizeDiscoveryProgress();
    const updated = await jobs.update(job.id, {
      status: 'ready',
      phase: 'discovery_complete',
      notionWorkspaceId: discovery.notionWorkspace.id,
      notionWorkspaceName: discovery.notionWorkspace.name,
      counts: totalGraphCounts,
      progress: {
        ...withImportProgress(discoveryProgress, {
          key: 'discover',
          status: 'completed',
          legacyStep: 'ready_for_graph_planning',
          percent: 50,
          at: finishedAt,
          counts: {
            discovered: currentDiscoveryItems.length,
            totalKnown: discoveredItems.length,
            searchPagesFetched: discovery.searchPagesFetched,
          },
        }),
        discovered: currentDiscoveryItems.length,
        totalKnown: discoveredItems.length,
        hasMore: discovery.hasMore,
        nextCursor: discovery.nextCursor,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: discovery.searchStartCursor,
        searchPagesFetched: discovery.searchPagesFetched,
        discoveryPasses: discovery.discoveryPasses,
        searchCounts: discovery.counts,
      },
      report: baseReport({
        rootNotionPageIds: job.rootNotionPageIds ?? [],
        rootNotionDataSourceIds,
        tokenStored: false,
        connectionId: tokenSource.connectionId,
        credentialSource: tokenSource.credentialSource,
        apiVersion: job.apiVersion || NOTION_API_VERSION,
        hasMoreFromSearch: discovery.hasMore,
        nextCursor: discovery.nextCursor,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: discovery.searchStartCursor,
        searchPagesFetched: discovery.searchPagesFetched,
        discoveryPasses: discovery.discoveryPasses,
        discoveryConcurrency,
        includeMarkdownFallback,
        supplementalSnapshotItems: supplementalSnapshotItems.length,
        totalKnownItems: discoveredItems.length,
        discoveredByObject: totalGraphCounts,
        currentDiscoveryByObject: discovery.graphCounts,
        searchDiscoveredByObject: discovery.counts,
        warnings: discovery.warnings,
        missingPermissions: discovery.missingPermissions,
        unsupported: discovery.unsupported,
      }),
      error: null,
      finishedAt,
    });

    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.discover',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: {
        itemCount: discoveredItems.length,
        pageItemCount: currentDiscoveryItems.length,
        counts: totalGraphCounts,
        currentDiscoveryCounts: discovery.graphCounts,
        searchCounts: discovery.counts,
        hasMore: discovery.hasMore,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: discovery.searchStartCursor,
        searchPagesFetched: discovery.searchPagesFetched,
        discoveryPasses: discovery.discoveryPasses,
        discoveryConcurrency,
        includeMarkdownFallback,
        supplementalSnapshotItems: supplementalSnapshotItems.length,
        warnings: discovery.warnings.length,
        missingPermissions: discovery.missingPermissions.length,
      },
      occurredAt: finishedAt,
    });

    return {
      job: cleanJob(updated),
      items: discoveredItems.map(cleanItem),
    };
  } catch (error) {
    await finalizeDiscoveryProgress();
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    const failed = await jobs.update(job.id, {
      status: 'failed',
      phase: 'discovery_failed',
      error: message,
      progress: {
        ...withImportProgress(discoveryProgress, {
          key: 'discover',
          status: 'failed',
          legacyStep: 'discovery_failed',
          message,
          at: failedAt,
        }),
      },
      report: {
        ...(job.report ?? baseReport()),
        lastError: message,
      },
      finishedAt: failedAt,
    });
    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.discover_failed',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: {
        error: message,
        continuedFromCursor: continueFromCursor,
        searchStartCursor: continueFromCursor ? previousNextCursor : undefined,
        connectionId: tokenSource.connectionId,
        credentialSource: tokenSource.credentialSource,
        maxDiscoveryPages,
        maxEnrichedItems,
        maxChildrenPages,
        maxDataSourceQueryPages,
        maxViewPages,
        discoveryConcurrency,
        includeMarkdownFallback,
      },
      occurredAt: failedAt,
    });
    throw new Error(failed.error ?? message);
  }
}

async function cancelJob(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  if (job.status === 'ready' || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return { job: cleanJob(job) };
  }
  const now = nowIso();
  const updated = await jobs.update(job.id, {
    status: 'cancelled',
    phase: 'cancelled',
    cancelledAt: now,
    cancelledBy: actorId,
    finishedAt: now,
    progress: {
      ...withImportProgress(job.progress, {
        key: 'cancel',
        status: 'cancelled',
        legacyStep: 'cancelled',
        at: now,
      }),
    },
  });
  await recordWorkspaceAudit(db, {
    workspaceId: job.workspaceId,
    actorId,
    action: 'notion_import.cancel',
    targetType: 'notion_import_job',
    targetId: job.id,
    occurredAt: now,
  });
  return { job: cleanJob(updated) };
}

async function retryJob(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  env: Record<string, unknown> | undefined,
) {
  const retryOfJobId = requireString(body.jobId, 'jobId');
  const previous = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), retryOfJobId);
  if (!previous) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, previous, actorId);
  return createJobRecord(
    db,
    {
      ...body,
      workspaceId: previous.workspaceId,
      parentPageId: previous.parentPageId,
      rootNotionPageIds: previous.rootNotionPageIds,
      rootNotionDataSourceIds: previous.rootNotionDataSourceIds ??
        parseStringArray((previous.options as { rootNotionDataSourceIds?: unknown } | undefined)?.rootNotionDataSourceIds),
      connectionKind: previous.connectionKind,
      connectionId: optionalString(body.connectionId) ?? previous.connectionId ?? optionalString((previous.options as { connectionId?: unknown } | undefined)?.connectionId),
      maxDiscoveryPages: (previous.options as { maxDiscoveryPages?: unknown } | undefined)?.maxDiscoveryPages,
      maxEnrichedItems: (previous.options as { maxEnrichedItems?: unknown } | undefined)?.maxEnrichedItems,
      maxChildrenPages: (previous.options as { maxChildrenPages?: unknown } | undefined)?.maxChildrenPages,
      maxDataSourceQueryPages: (previous.options as { maxDataSourceQueryPages?: unknown } | undefined)?.maxDataSourceQueryPages,
      maxViewPages: (previous.options as { maxViewPages?: unknown } | undefined)?.maxViewPages,
      maxTemplatePages: (previous.options as { maxTemplatePages?: unknown } | undefined)?.maxTemplatePages,
      discoveryConcurrency: (previous.options as { discoveryConcurrency?: unknown } | undefined)?.discoveryConcurrency,
      includeMarkdownFallback: (previous.options as { includeMarkdownFallback?: unknown } | undefined)?.includeMarkdownFallback,
      importPagesFullWidth: parseOptionalBoolean(body.importPagesFullWidth) ??
        parseOptionalBoolean((previous.options as { importPagesFullWidth?: unknown } | undefined)?.importPagesFullWidth),
    },
    actorId,
    env,
    retryOfJobId,
  );
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request, env, storage } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  try {
    const body = await requestJson(request);
    const action = typeof body.action === 'string' ? body.action : '';
    const db = boundedDbFromWorkspaceHint(admin, body.workspaceId);
    switch (action) {
      case 'beginOAuthConnection':
        return await beginOAuthConnection(db, body, auth.id, env);
      case 'completeOAuthConnection':
        return await completeOAuthConnection(db, body, auth.id, env);
      case 'createConnection':
        return await createConnection(db, body, auth.id, env);
      case 'listConnections':
        return await listConnections(db, body, auth.id, env);
      case 'revokeConnection':
        return await revokeConnection(db, body, auth.id);
      case 'listAccessibleRoots':
        return await listAccessibleRoots(db, body, auth.id, env);
      case 'create':
        return await createJobRecord(db, body, auth.id, env);
      case 'preflight':
        return await preflightJob(db, body, auth.id, env);
      case 'list':
        return await listJobs(db, body, auth.id, env);
      case 'repairPageIndexes':
        return await repairImportPageIndexes(db, admin, body, auth.id);
      case 'get':
        return await getJob(db, body, auth.id);
      case 'appendSnapshotItems':
        return await appendSnapshotItemsJob(db, body, auth.id);
      case 'plan':
        return await planJob(db, body, auth.id);
      case 'discover':
        return await discoverJob(db, body, auth.id, env);
      case 'apply':
        return await applyJob(db, admin, body, auth.id, storage, request, env);
      case 'repairImportedPageBlocks':
        return await repairImportedPageBlocks(db, body, auth.id, storage, request, env);
      case 'retryFileCopies':
        return await retryFileCopies(db, body, auth.id, storage, request, env);
      case 'cancel':
        return await cancelJob(db, body, auth.id);
      case 'retry':
        return await retryJob(db, body, auth.id, env);
      default:
        return jsonError(400, 'Unknown Notion import action.');
    }
  } catch (error) {
    if (error instanceof NotionApiError) {
      const status = error.status === 429
        ? 429
        : error.status === 404
          ? 404
          : error.status >= 400 && error.status < 500
            ? 422
            : 502;
      return jsonError(status, error.message);
    }
    const { status, message } = errorStatus(error, [
      { status: 413, needles: ['source file is too large', 'storage limit exceeded'] },
      { status: 429, needles: ['Too many requests', 'rate limit', 'Rate limit'] },
      {
        status: 403,
        needles: ['access required', 'active access required', 'outside the workspace', 'belongs to another workspace'],
      },
      { status: 404, needles: ['not found', 'trash'] },
      { status: 423, needles: ['locked'] },
      { status: 409, needles: ['Cannot append discovery items', 'must be ready before apply', 'is cancelled'] },
      {
        status: 400,
        needles: ['is required', 'must be', 'cannot be disabled', 'unsupported file URL scheme', 'OAuth state is invalid', 'has expired'],
      },
    ], 500);
    return jsonError(status, message);
  }
});
