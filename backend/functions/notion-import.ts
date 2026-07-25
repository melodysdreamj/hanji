import { defineFunction } from '@edge-base/shared';
import { isHanjiBoardMainGroupPropertyType } from '../../shared/board-group-types.mjs';
import { errorStatus } from '../lib/error-status';
import {
  HANJI_CURRENT_PAGE_FILTER_KIND,
  hasHanjiImportedRowContextFilterMarker,
  withoutHanjiImportedRowContextFilterMarkers,
  isHanjiCurrentPageFilterValue,
} from '../lib/hanji-compat';
import { envString, notionApiBase } from '../lib/notion-import-credentials';
import {
  NotionApiError,
  notionIsoTimestamp,
  notionRequest,
  safeNotionRequest,
  type NotionRequestRetryInfo,
} from '../lib/notion-api-client';
export {
  pruneNotionRequestSchedule,
  reserveNotionRequestSlot,
} from '../lib/notion-api-client';
export {
  notionConnectionStorageAvailable,
  notionOAuthEnabled,
  notionOAuthRedirectUri,
} from '../lib/notion-import-credentials';
import {
  isCredentialBearingNotionUrl,
  sanitizeNotionCredentialMetadata,
} from '../lib/notion-import-metadata';
export { sanitizeNotionCredentialMetadata } from '../lib/notion-import-metadata';
import {
  NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
  assertBoundedSnapshotJsonValue,
  assertNotionImportRequestJsonShape,
  missingRequestedRootIds,
  normalizedNotionId,
  notionImportPayloadTooLarge,
  parseSnapshotItems,
  type DiscoveredNotionItem,
} from '../lib/notion-import-request-limits';
import {
  assertBoundedRequestDiscoveredItems,
  expandSnapshotItems,
  parseMcpFetchItems,
} from '../lib/notion-import-mcp-snapshot';
import {
  discoverNotionGraphWithRuntime,
  preflightNotionImportGraphWithRuntime,
  type NotionImportDiscoveryRuntime,
} from '../lib/notion-import-discovery';
export { type NotionImportDiscoveryRuntime } from '../lib/notion-import-discovery';
import {
  discoveryProgressPercent,
  importActivityRingOf,
  notionDiscoveryItemNeedsEnrichment,
  pushImportActivity,
} from '../lib/notion-import-discovery-progress';
export {
  discoveryProgressPercent,
  notionDiscoveryEnrichmentCandidates,
  notionDiscoveryItemNeedsEnrichment,
  notionEnrichmentShouldStop,
  notionEnrichmentWaveSize,
  pushImportActivity,
  type DiscoveryProgressSnapshot,
  type NotionImportActivityEntry,
} from '../lib/notion-import-discovery-progress';
import {
  applyJobCoreWithRuntime,
  clearNotionImportApplySnapshotCache,
  type Block,
  type DbProperty,
  type DbRef,
  type DbTemplate,
  type DbView,
  type FunctionStorageProxy,
  type ImportedBlockMapping,
  type ImportedPageBlockContext,
  type ImportedPropertyContext,
  type ImportedRowContext,
  type ImportedTemplateContext,
  type NotionFileCopyContext,
  type NotionImportApplyRuntime,
  type NotionImportFileCopySlot,
  type Page,
} from '../lib/notion-import-apply';
import { createNotionImportBlockApplyRuntime } from '../lib/notion-import-block-apply';
export {
  type Block,
  type DbProperty,
  type DbRef,
  type DbTemplate,
  type DbView,
  type FunctionStorageProxy,
  type ImportedBlockMapping,
  type ImportedPageBlockContext,
  type ImportedPropertyContext,
  type ImportedRowContext,
  type ImportedTemplateContext,
  type NotionFileCopyContext,
  type NotionImportApplyRuntime,
  type NotionImportFileCopySlot,
  type Page,
} from '../lib/notion-import-apply';
import {
  createNotionImportPlanner,
  type HiddenLinkedDatabaseDataSourceInference,
  type NotionImportPlanRuntime,
} from '../lib/notion-import-plan';
export { type NotionImportPlanRuntime } from '../lib/notion-import-plan';
import {
  createNotionImportConnectionHandlers,
  type NotionImportConnectionKind,
  type NotionTokenSource,
} from '../lib/notion-import-connections';
import {
  baseReport,
  cleanItem,
  cleanJob,
  createNotionImportJobCreateHandlers,
  createNotionImportJobLifecycleHandlers,
  createNotionImportJobListingHandlers,
  createNotionImportJobReaderHandlers,
  progressObject,
  withImportProgress,
} from '../lib/notion-import-job-lifecycle';
import {
  createNotionImportJobDiscoveryHandlers,
  createNotionImportJobReviewHandlers,
} from '../lib/notion-import-job-discovery';
import {
  createNotionImportJobApplyHandlers,
  createNotionImportJobRepairHandlers,
} from '../lib/notion-import-job-apply';
import {
  SUPPORTED_NOTION_VIEW_TYPES,
  emptyConversionReport,
  finalizeConversionReport,
  incrementReport,
  mergeImportReportEntries,
  pushReportIssue,
  reportUnsupportedFormulaFunctions,
  reportUnsupportedProperty,
  reportUnsupportedView,
  reportUnresolvedFormulaPropertyReference,
} from '../lib/notion-import-report';
import type {
  DiscoveryWarningBag,
  ImportConversionReport,
  NotionImportItem,
  NotionImportJob,
  NotionImportMapping,
  NotionImportStatus,
} from '../lib/notion-import-contracts';
export {
  type DiscoveryWarningBag,
  type ImportConversionReport,
  type NotionImportItem,
  type NotionImportJob,
  type NotionImportMapping,
  type NotionImportPlan,
  type NotionImportWarning,
} from '../lib/notion-import-contracts';
import { createNotionImportServerRunner } from '../lib/notion-import-server-runner';
export type {
  NotionImportRootCandidate,
  NotionImportRootScanItem,
} from '../lib/notion-import-connections';
export {
  assertBoundedRequestDiscoveredItems,
  dashedUuid,
  expandSnapshotItems,
  mcpFetchPayloads,
  parseMcpFetchItems,
} from '../lib/notion-import-mcp-snapshot';
export {
  NOTION_IMPORT_MCP_FETCH_PAYLOADS_PER_REQUEST_MAX,
  NOTION_IMPORT_MCP_TEXT_MAX_BYTES,
  NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH,
  NOTION_IMPORT_REQUEST_JSON_MAX_NODES,
  NOTION_IMPORT_SNAPSHOT_AGGREGATE_MAX_BYTES,
  NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
  NOTION_IMPORT_SNAPSHOT_ITEM_MAX_BYTES,
  assertNotionImportRequestJsonShape,
  missingRequestedRootIds,
  normalizedNotionId,
  parseSnapshotItems,
  type DiscoveredNotionItem,
} from '../lib/notion-import-request-limits';
import {
  boundedDbFromWorkspaceHint,
  ensurePageWorkspaceIndex,
  MAX_RAW_TRANSACT_OPS,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import {
  deleteNotionImportRun,
  enqueueNotionImportRun,
} from '../lib/notion-import-run-queue';
import {
  pageAccessRole as sharedPageAccessRole,
  workspaceAccessRole as sharedWorkspaceAccessRole,
} from '../lib/page-access';
import {
  fetchFileForImport,
  fileCopyFailureMessage,
  normalizedImportedContentType,
} from '../lib/notion-import-file-fetch';
export {
  MAX_UNKNOWN_LENGTH_IMPORTED_FILE_SIZE,
  readResponseBodyWithByteCap,
  responseBodyWithExactByteCount,
} from '../lib/notion-import-file-fetch';
import { assertFileTargetsNotDeleting, withFileWorkspaceLease } from '../lib/file-operation-lock';
import {
  assertNoUnownedStoredFileReferences,
} from '../lib/file-reference-lifecycle';
import {
  releaseOrganizationStorage,
  reserveOrganizationStorage,
} from '../lib/storage-quota';
import {
  collectPermanentRoutingIndexPlan,
  deletePermanentRoutingIndexes,
} from '../lib/permanent-routing-index-delete';
import {
  OMIT_DATABASE_PROPERTY_IMPORT_VALUE,
  isDatabasePropertyType,
  normalizeDatabasePropertyImportValue,
  type DatabasePropertyType,
} from '../lib/database-property-types';
import {
  normalizeDatabaseViewStorageRecord,
  parseDatabaseViewType,
  type NotionDatabaseViewType,
} from '../lib/database-view-types';

import {
  DEFAULT_LIST_ALL_MAX_ITEMS,
  bestEffort,
  requireString,
  getExisting,
  listAll as listAllComplete,
  nowIso,
  newId,
  projectFields,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';
import { isTransientInfrastructureError } from '../lib/transient-error';
import type { ShareRole } from '../lib/page-access';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';
import {
  parsePersistentGeneratedLocale,
  persistentGeneratedLabels,
  type PersistentGeneratedLocale,
} from '../lib/persistent-generated-labels';

const NOTION_API_VERSION = '2026-03-11';
const NOTION_PAGINATION_SAFETY_PAGE_LIMIT = 10_000;
const NOTION_FILE_COPY_RECOVERY_TTL_MS = 2 * 60 * 60 * 1000;
const NOTION_FILE_CHECKPOINT_RECOVERY_TTL_MS = 3 * 60 * 1000;
// Signed PUTs expire after 30 minutes. A terminal checkpoint schedules one
// extra deterministic-key delete a full hour later, covering a worker whose
// object write completed after the first delete without retaining an eternal
// maintenance tombstone.
const NOTION_FILE_TERMINAL_RESWEEP_DELAY_MS = 60 * 60 * 1000;
// Sane per-fetch pagination defaults. The hard clamp stays
// NOTION_PAGINATION_SAFETY_PAGE_LIMIT (still overridable up to it), but the
// default budgets below keep a single discover call from grinding through a
// whole huge workspace. /search is resumable via cursor so its default is
// generous; enrichment work is bounded per incremental call by ENRICH_BUDGET.
const NOTION_CHILDREN_PAGES_DEFAULT = 40;      // page block children: 4,000 blocks
const NOTION_ROW_PAGES_DEFAULT = 60;           // data-source rows: 6,000 rows
const NOTION_VIEW_PAGES_DEFAULT = 10;
const NOTION_TEMPLATE_PAGES_DEFAULT = 5;
const NOTION_SEARCH_PAGES_DEFAULT = 200;       // /search: 20,000 items (resumable via cursor anyway)
const NOTION_ENRICH_BUDGET_DEFAULT = 25;       // items enriched per incremental discover call
// Wall-clock cap on a single incremental discover call. Item-count alone does
// not bound a call's duration: one item can fan out to dozens of throttled
// (350ms) Notion subrequests, so a 25-item budget could still hold the Durable
// Object request open for minutes and overload it (observed 40-197s calls →
// 503 Service Unavailable). Stop starting new item enrichment once this passes
// so each call returns quickly and the client just loops another short chunk.
const NOTION_DISCOVER_CALL_DEADLINE_MS = 12_000;
const NOTION_ROOT_SCAN_DEFAULT_PAGE_LIMIT = 10;
const NOTION_ROOT_SCAN_MAX_PAGE_LIMIT = 50;
const NOTION_IMPORT_ITEM_SAFETY_LIMIT = 100_000;
const NOTION_APPLY_LEASE_TTL_MS = 30 * 60 * 1000;
// Apply can legitimately run for many minutes, so its lease remains long and
// is renewed at every durable progress checkpoint. If the owning request dies
// (for example SQLITE_FULL resets the DO before the finally block can delete
// the lock), let the same actor reclaim it after the heartbeat has been silent
// for five minutes instead of blocking recovery for the full 30-minute TTL.
const NOTION_APPLY_LEASE_STALE_MS = 5 * 60 * 1000;
// Incremental discovery calls are bounded to a small wall-clock slice. Keep a
// crashed worker from blocking resume for the apply lease's full 30 minutes.
const NOTION_DISCOVER_LEASE_TTL_MS = 90 * 1000;
// A single Notion item can remain inside transport retry/backoff longer than
// the nominal 90-second discovery lease. Renew well inside that window so a
// client reconnect cannot replace a still-running request's lock.
const NOTION_DISCOVER_LEASE_HEARTBEAT_MS = 30 * 1000;
const NOTION_APPLY_LEASE_CAS_ATTEMPTS = 8;
const NOTION_APPLY_FAILURE_RENEW_ATTEMPTS = 3;
const NOTION_APPLY_FAILURE_RENEW_BASE_DELAY_MS = 25;
// Failure cleanup reserves three raw transaction slots for the exact ready-job
// fence, the freshly observed apply-lock fence, and the lock heartbeat update.
// The remaining slots form the declared bounded mutation chunk; overflow keeps
// draining immediately instead of waiting for another collection window.
const NOTION_APPLY_FAILURE_CLEANUP_FIXED_TRANSACT_OPS = 3;
const NOTION_APPLY_FAILURE_CLEANUP_MUTATION_CHUNK_SIZE =
  MAX_RAW_TRANSACT_OPS - NOTION_APPLY_FAILURE_CLEANUP_FIXED_TRANSACT_OPS;
const NOTION_ENRICHMENT_BATCH_SIZE = 500;
const NOTION_ENRICHMENT_BATCH_SIZE_MAX = 5_000;
const NOTION_DISCOVERY_CONCURRENCY_DEFAULT = 4;
const NOTION_DISCOVERY_CONCURRENCY_MAX = 8;
const NOTION_PREFLIGHT_SAMPLE_LIMIT = 20;
const MAX_MARKDOWN_CHARS = 60_000;
const FILE_BUCKET = 'files';
const NOTION_PAGE_ICON_REFERENCE_KEY = '__notionPageIconReference';
const NOTION_PAGE_COVER_REFERENCE_KEY = '__notionPageCoverReference';
const NOTION_CREATED_TIME_KEY = '__notionCreatedTime';
const NOTION_LAST_EDITED_TIME_KEY = '__notionLastEditedTime';
const NOTION_IMPORT_BLOCKS_COMPLETE_KEY = '__notionImportBlocksComplete';
const NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY = '__notionImportBlockBoundaryRepairVersion';
const NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION = 5;
const NOTION_IMPORT_BLOCK_RECOVERY_KEY = '__notionImportBlockRecovery';
const NOTION_IMPORT_PUBLICATION_BOUNDARY_VERSION = 1;
const GENERATED_NOTION_TITLE_PROPERTY_ID = '__hanji_generated_title__';
const NOTION_BLOCK_CHILD_DEPTH_LIMIT = 32;
const NOTION_BLOCK_CHILD_TOTAL_LIMIT = 100_000;
const NOTION_DISCOVERY_PASS_SAFETY_LIMIT = 1_000;
// Discovery runs as one long inline pass; persist a throttled live progress
// snapshot (~1/sec) so the polled step-3 panel advances instead of sitting at
// the initial "25% · Discovering workspace graph" until the whole pass ends.
const NOTION_DISCOVERY_PROGRESS_INTERVAL_MS = 1_000;

interface Workspace {
  id: string;
  organizationId?: string | null;
  name?: string;
  ownerId?: string;
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
  templateId?: string;
  name: string;
  contentType?: string;
  size: number;
  etag?: string;
  status: 'preparing' | 'pending' | 'uploaded' | 'deleting' | 'deleted' | 'expired';
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
  deletionPreviousStatus?: 'preparing' | 'pending' | 'uploaded' | null;
  /** Durable Notion pre-copy locator. These fields deliberately remain on the
   * upload row so a crash between object write and owner attachment is still
   * recoverable without worker memory or product mappings. */
  notionImportJobId?: string;
  notionImportSnapshotRevision?: string;
  notionImportSlotKey?: string;
  notionImportTerminalSweepAfter?: string | null;
  notionImportTerminalSweepCompletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}





interface NotionImportApplyLock {
  id: string;
  workspaceId: string;
  jobId: string;
  leaseId: string;
  actorId: string;
  purpose?: 'apply' | 'discover';
  expiresAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export function notionAppliedCountsFromMappings(
  mappings: Pick<NotionImportMapping, 'localId' | 'localType' | 'relationKind'>[],
) {
  const productMappings = mappings.filter((mapping) => mapping.relationKind !== 'import_root');
  const placeholderDatabases = productMappings.filter(
    (mapping) => mapping.relationKind === 'database_placeholder',
  ).length;
  return {
    pages: productMappings.filter((mapping) => mapping.relationKind === 'page').length,
    databases: new Set(
      productMappings
        .filter((mapping) => mapping.localType === 'database')
        .map((mapping) => mapping.localId),
    ).size,
    // A placeholder database mapping durably represents the fallback title
    // property and table view created with that database. Include those
    // implicit writes when a chunked apply reconstructs its counters.
    properties:
      productMappings.filter((mapping) => mapping.relationKind === 'database_property').length +
      placeholderDatabases,
    views:
      productMappings.filter((mapping) => mapping.relationKind === 'database_view').length +
      placeholderDatabases,
    templates: productMappings.filter((mapping) => mapping.relationKind === 'database_template').length,
    rows: productMappings.filter((mapping) => mapping.relationKind === 'database_row').length,
    mappings: productMappings.length,
  };
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
  notionFile?: Record<string, unknown>;
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

interface NotionFileCopyTarget {
  notionId?: string;
  notionObject: string;
  label: string;
  scope: 'icons' | 'covers' | 'blocks/images' | 'blocks/videos' | 'blocks/audio' | 'blocks/files' | 'database/files';
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  templateId?: string;
  notionPageId?: string;
  notionBlockId?: string;
  notionPropertyId?: string;
  notionPropertyName?: string;
  notionFileIndex?: number;
  notionFileName?: string;
  notionPageFileKind?: 'icon' | 'cover';
  /** Stable raw-snapshot coordinates. Local page/template/block ids are
   * intentionally excluded so a worker restart can reuse the same slot. */
  notionFileRole?: string;
  notionFileStructuralPath?: string;
  notionFileOrdinal?: number;
}

interface FunctionContext {
  auth: { id: string } | null;
  request?: Request;
  env?: Record<string, unknown>;
  admin: AdminDbAccessor;
  storage?: FunctionStorageProxy;
}


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


function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 100);
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


async function listAll<T>(query: TableQuery<T>, maxItems = 1000): Promise<T[]> {
  const boundedMaxItems = Math.max(1, Math.floor(maxItems));
  return listAllComplete(query, {
    maxItems: boundedMaxItems,
    pageSize: Math.min(1_000, boundedMaxItems),
    label: 'Notion import query',
    ...(boundedMaxItems > DEFAULT_LIST_ALL_MAX_ITEMS
      ? { allowLargeMaterialization: true }
      : {}),
  });
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









const NOTION_IMPORT_FILE_STRING_FIELDS = new Set([
  'url',
  'src',
  'href',
  'link',
  'sourceUrl',
  'icon',
  'cover',
  'image',
  'video',
  'audio',
  'file',
  'poster',
  'thumbnail',
]);

function absoluteStorageRoute(value: string) {
  try {
    const parsed = new URL(value, 'https://notion-import.invalid');
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'api' || segments[1] !== 'storage' || segments.length <= 3) return undefined;
    return parsed.pathname;
  } catch {
    return undefined;
  }
}

function notionImportStoredFileGuardProjection(
  value: unknown,
  out: Array<Record<string, string>> = [],
  seen = new Set<object>(),
  depth = 0,
) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 32) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) notionImportStoredFileGuardProjection(item, out, seen, depth + 1);
    seen.delete(value);
    return out;
  }
  for (const [field, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && child.trim()) {
      const raw = child.trim();
      const route = absoluteStorageRoute(raw);
      if (NOTION_IMPORT_FILE_STRING_FIELDS.has(field)) {
        // `sourceUrl` is a legacy/MCP attachment field consumed by the web
        // client but intentionally ignored by the generic dynamic-property
        // walker. Project it onto the canonical URL field for exact known-URL
        // checks. Absolute/protocol-relative storage routes are projected onto
        // their root-relative path so host aliases cannot disguise a local
        // object locator.
        out.push({ url: route ?? raw });
      } else if (field === 'id' && (raw.startsWith('workspaces/') || route)) {
        // Notion object UUIDs remain ordinary ids. Only key-shaped attachment
        // ids are file identities and must be rejected at this source boundary.
        out.push(route ? { url: route } : { key: raw });
      }
    }
    notionImportStoredFileGuardProjection(child, out, seen, depth + 1);
  }
  seen.delete(value);
  return out;
}

export async function assertSafeNotionImportSourceReferences(db: DbRef, value: unknown) {
  await assertNoUnownedStoredFileReferences(db, [
    value,
    notionImportStoredFileGuardProjection(value),
  ]);
}

function countImportItemsByObject(
  items: Iterable<Pick<NotionImportItem | DiscoveredNotionItem, 'notionObject'>>,
) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.notionObject] = (counts[item.notionObject] ?? 0) + 1;
  }
  return counts;
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







function parseServerRunRequestId(value: unknown) {
  const requestId = optionalString(value);
  if (!requestId || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
    throw new Error('serverRunRequestId must be a 16-128 character opaque identifier.');
  }
  return requestId;
}

async function serverOwnedNotionImportJobId(
  workspaceId: string,
  actorId: string,
  requestId: string,
) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${workspaceId}\u0000${actorId}\u0000${requestId}`),
  );
  const suffix = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `notion-run-${suffix}`;
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

function withGeneratedTitleProperty(
  properties: Record<string, unknown>,
  locale: PersistentGeneratedLocale,
) {
  const entries = Object.entries(properties);
  const hasTitle = entries.some(([, rawProperty]) => {
    const property = asRecord(rawProperty);
    return optionalString(property?.type)?.toLowerCase() === 'title';
  });
  if (hasTitle) return properties;

  const base = persistentGeneratedLabels(locale).propertyNames.name;
  const used = new Set(entries.map(([nameOrId, rawProperty]) => {
    const property = asRecord(rawProperty);
    return (optionalString(property?.name) ?? nameOrId).trim().toLowerCase();
  }));
  let name = base;
  for (let number = 2; used.has(name.toLowerCase()); number += 1) {
    name = `${base} ${number}`;
  }
  const notionPropertyId = GENERATED_NOTION_TITLE_PROPERTY_ID;
  const key = Object.prototype.hasOwnProperty.call(properties, name)
    ? notionPropertyId
    : name;
  return {
    ...properties,
    [key]: {
      id: notionPropertyId,
      name,
      type: 'title',
      generatedForMissingNotionTitle: true,
      title: {},
    },
  };
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
  _chrome: ImportedPageChrome,
) {
  // File-backed page chrome is copied before its local reference is committed.
  // Keeping the temporary Notion URL in a page property made a failed copy a
  // durable credential-bearing product owner. The source remains only in the
  // import staging item until copyImportedPageChromeFiles succeeds.
  if (!properties) return undefined;
  const next = { ...properties };
  delete next[NOTION_PAGE_ICON_REFERENCE_KEY];
  delete next[NOTION_PAGE_COVER_REFERENCE_KEY];
  return next;
}

function initialImportedPageChrome(chrome: ImportedPageChrome) {
  const emoji = chrome.iconType === 'emoji' ? chrome.icon : undefined;
  return {
    icon: emoji,
    iconType: emoji ? 'emoji' as const : 'none' as const,
    cover: undefined,
    coverPosition: undefined,
  };
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
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const path = `/api/storage/${encodeURIComponent(bucket)}/${encodedKey}`;
  if (!request) return path;
  const origin = new URL(request.url).origin;
  return `${origin}${path}`;
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

function relationTargetNotionId(config: Record<string, unknown> | undefined) {
  if (!config) return undefined;
  if (typeof config.data_source_id === 'string' && config.data_source_id.trim()) return config.data_source_id.trim();
  if (typeof config.database_id === 'string' && config.database_id.trim()) return config.database_id.trim();
  return undefined;
}

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

function fileCopyScopeForBlockType(type: string): NotionFileCopyTarget['scope'] {
  if (type === 'image') return 'blocks/images';
  if (type === 'video') return 'blocks/videos';
  if (type === 'audio') return 'blocks/audio';
  return 'blocks/files';
}

export function localStoredFileReference(reference: NotionFileReference, upload: FileUpload) {
  return {
    id: upload.id,
    uploadId: upload.id,
    bucket: upload.bucket,
    key: upload.key,
    name: upload.name,
    url: upload.url ?? reference.url,
    type: upload.contentType ?? reference.type,
    size: upload.size,
    notionFileSource: reference.notionFileSource,
    notionFileCopied: true,
    notionFileCopiedAt: upload.completedAt,
  };
}

function contentWithStoredNotionFile(
  content: Record<string, unknown> | undefined,
  copied: NotionFileReference,
) {
  const rawNotionBlockId = notionObjectId(asRecord(content?.notionBlock) ?? {});
  const next: Record<string, unknown> = {
    ...(content ?? {}),
    ...(rawNotionBlockId ? { notionBlockId: rawNotionBlockId } : {}),
    url: copied.url,
    fileName: copied.name,
    fileUploadId: copied.uploadId,
    fileKey: copied.key,
    fileBucket: copied.bucket,
    notionFileReference: copied,
    notionFileCopied: true,
  };
  delete next.sourceUrl;
  delete next.notionFileExpiryTime;
  // The raw file block is redundant once the native stored-file fields exist,
  // and may contain a second unsigned/signed source URL under a Notion-specific
  // nested shape. Never retain that shadow locator in a durable owner.
  delete next.notionBlock;
  return next;
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
  // Durable pre-copy slots use the exact property coordinate plus ordinal.
  // Filenames are not identifiers (duplicates are common), so never silently
  // move an indexed slot to a same-name sibling after a signed URL refresh.
  if (targetIndex >= 0) return byIndex;
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
  slotKey?: string,
) {
  const proxy = storageBucket(context.storage, FILE_BUCKET);
  if (!proxy?.put) throw new Error('EdgeBase storage is not available in this runtime');

  const workspace = await getExisting(context.db.table<Workspace>('workspaces'), context.job.workspaceId);
  if (!workspace) throw new Error('workspace was not found');
  const file = await fetchFileForImport(reference);

  const id = newId();
  const name = normalizeFileName(reference.name);
  const base = cleanFileSegment(name);
  const ext = extensionFromName(name);
  const key = `workspaces/${context.job.workspaceId}/notion-import/${context.job.id}/${target.scope}/${id}-${base}${ext}`;
  const now = nowIso();
  const url = storageUrl(context.request, FILE_BUCKET, key);
  const recoveryExpiresAt = new Date(
    Date.now() + (slotKey ? NOTION_FILE_CHECKPOINT_RECOVERY_TTL_MS : NOTION_FILE_COPY_RECOVERY_TTL_MS),
  ).toISOString();
  const uploads = context.db.table<FileUpload>('file_uploads');
  const ownerTarget = context.checkpointOnly
    ? {} as Pick<NotionFileCopyTarget, 'pageId' | 'blockId' | 'databaseId' | 'propertyId' | 'templateId'>
    : target;

  let rowCreated = false;
  let upload: FileUpload | null = null;
  try {
    await withFileWorkspaceLease(
      context.db,
      context.job.workspaceId,
      context.actorId,
      'notion-file-register',
      async (lease) => {
        await lease.assertOwned();
        await assertFileTargetsNotDeleting(
          context.db,
          context.job.workspaceId,
          [target.pageId, target.databaseId],
        );
        const uploadRow: FileUpload = {
          id,
          workspaceId: context.job.workspaceId,
          bucket: FILE_BUCKET,
          key,
          scope: target.scope,
          pageId: ownerTarget.pageId,
          blockId: ownerTarget.blockId,
          databaseId: ownerTarget.databaseId,
          propertyId: ownerTarget.propertyId,
          templateId: ownerTarget.templateId,
          name,
          contentType: file.contentType,
          size: file.size,
          status: 'preparing',
          url,
          createdBy: context.actorId,
          expiresAt: recoveryExpiresAt,
          ...(slotKey && context.itemSnapshotRevision
            ? {
                notionImportJobId: context.job.id,
                notionImportSnapshotRevision: context.itemSnapshotRevision,
                notionImportSlotKey: slotKey,
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        };
        if (slotKey && context.applyLease && context.itemSnapshotRevision) {
          await context.db.transact([
            {
              table: 'notion_import_jobs',
              op: 'expect',
              id: context.job.id,
              where: [
                ['status', '==', context.job.status],
                ['itemSnapshotRevision', '==', context.itemSnapshotRevision],
              ],
              exists: true,
            },
            {
              table: 'notion_import_apply_locks',
              op: 'expect',
              id: context.applyLease.id,
              where: [
                ['leaseId', '==', context.applyLease.leaseId],
                ['purpose', '==', 'apply'],
              ],
              exists: true,
            },
            {
              table: 'file_uploads',
              op: 'expect',
              id,
              exists: false,
            },
            { table: 'file_uploads', op: 'insert', data: uploadRow as unknown as Record<string, unknown> },
          ]);
        } else {
          await uploads.insert(uploadRow);
        }
        rowCreated = true;
      },
    );
    await reserveOrganizationStorage(context.admin, workspace, id, file.size);
    await withFileWorkspaceLease(
      context.db,
      context.job.workspaceId,
      context.actorId,
      'notion-file-activate',
      async (lease) => {
        await lease.assertOwned();
        await assertFileTargetsNotDeleting(
          context.db,
          context.job.workspaceId,
          [target.pageId, target.databaseId],
        );
        const activatedAt = nowIso();
        if (slotKey && context.applyLease && context.itemSnapshotRevision) {
          await context.db.transact([
            {
              table: 'notion_import_jobs', op: 'expect', id: context.job.id,
              where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
              exists: true,
            },
            {
              table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
              where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
              exists: true,
            },
            {
              table: 'file_uploads', op: 'expect', id,
              where: [['status', '==', 'preparing'], ['notionImportSlotKey', '==', slotKey]],
              exists: true,
            },
            { table: 'file_uploads', op: 'update', id, data: { status: 'pending', updatedAt: activatedAt } },
          ]);
        } else {
          await uploads.update(id, { status: 'pending', updatedAt: activatedAt });
        }
      },
    );

    await proxy.put(key, file.body, {
      contentType: file.contentType,
      customMetadata: {
        notionImportJobId: context.job.id,
        notionFileSource: reference.notionFileSource,
      },
    });
    const stored = await proxy.head(key);
    if (!stored) throw new Error('stored file was not found after copy');
    if (stored.size !== file.size) throw new Error('stored file size did not match the source');
    if (typeof stored.etag !== 'string' || !stored.etag) {
      throw new Error('stored file integrity metadata was not available after copy');
    }
    const storedContentType = normalizedImportedContentType(stored.contentType);
    if (storedContentType !== file.contentType) {
      throw new Error('stored file content type did not match the source');
    }

    upload = await withFileWorkspaceLease(
      context.db,
      context.job.workspaceId,
      context.actorId,
      'notion-file-finalize',
      async (lease) => {
        await lease.assertOwned();
        await assertFileTargetsNotDeleting(
          context.db,
          context.job.workspaceId,
          [target.pageId, target.databaseId],
        );
        const current = await getExisting(uploads, id);
        if (!current || (current.status !== 'pending' && current.status !== 'preparing')) {
          throw new Error('Notion file copy state is no longer active.');
        }
        const finalizedAt = nowIso();
        const patch = {
          status: 'uploaded',
          etag: stored.etag,
          expiresAt: null,
          completedAt: finalizedAt,
          updatedAt: finalizedAt,
        } as const;
        if (slotKey && context.applyLease && context.itemSnapshotRevision) {
          await context.db.transact([
            {
              table: 'notion_import_jobs', op: 'expect', id: context.job.id,
              where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
              exists: true,
            },
            {
              table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
              where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
              exists: true,
            },
            {
              table: 'file_uploads', op: 'expect', id,
              where: [['status', '==', current.status], ['notionImportSlotKey', '==', slotKey]],
              exists: true,
            },
            { table: 'file_uploads', op: 'update', id, data: patch },
          ]);
          return await getExisting(uploads, id) as FileUpload;
        }
        return uploads.update(id, patch);
      },
    );
  } catch (error) {
    let cleanupCompleted = false;
    if (rowCreated) {
      await bestEffort(
        'notion-import preserve fenced failed file-copy cleanup state',
        withFileWorkspaceLease(
          context.db,
          context.job.workspaceId,
          context.actorId,
          'notion-file-failed-copy-cleanup',
          async (lease) => {
            await lease.assertOwned();
            const current = await getExisting(uploads, id);
            if (!current) return;
            // A recovery request may have completed this exact checkpoint
            // while the failed worker was unwinding. Never let the stale
            // catch path delete or expire a newly-published object.
            if (current.status === 'uploaded') {
              return;
            }
            if (current.status === 'expired' || current.status === 'deleted') {
              // The terminal cleanup may have observed HEAD-miss and retired
              // the row while this old put was still in flight. Its unique key
              // can appear afterwards; re-delete it idempotently, but do not
              // mutate terminal metadata or quota under the stale apply lease.
              await proxy.delete(key);
              return;
            }
            if (!['preparing', 'pending', 'deleting'].includes(current.status)) return;

            const claimedAt = nowIso();
            const claimOperations: TransactOperation[] = [];
            if (slotKey && context.applyLease && context.itemSnapshotRevision) {
              claimOperations.push(
                {
                  table: 'notion_import_jobs', op: 'expect', id: context.job.id,
                  where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
                  exists: true,
                },
                {
                  table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
                  where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
                  exists: true,
                },
              );
            }
            claimOperations.push(
              {
                table: 'file_uploads', op: 'expect', id,
                where: [
                  ['status', '==', current.status],
                  ['updatedAt', '==', current.updatedAt ?? null],
                  ['notionImportSlotKey', '==', current.notionImportSlotKey ?? null],
                ],
                exists: true,
              },
              {
                table: 'file_uploads', op: 'update', id,
                data: {
                  status: 'deleting',
                  deletionPreviousStatus: current.status,
                  expiresAt: claimedAt,
                  deletedBy: context.actorId,
                  updatedAt: claimedAt,
                },
              },
            );
            await context.db.transact(claimOperations);

            // Object deletion must complete before quota release, and quota
            // release must complete before the row becomes terminal. Leaving
            // `deleting` at either failure point makes recovery resumable.
            // A storage driver may durably write the object and then fail the
            // response/stream. Delete by the deterministic key even when the
            // awaited put never returned; object deletion is idempotent.
            await proxy.delete(key);
            await lease.assertOwned();
            if (workspace.organizationId) {
              await releaseOrganizationStorage(context.admin, {
                id,
                organizationId: workspace.organizationId,
                workspaceId: workspace.id,
                bytes: current.size,
              });
            }
            await lease.assertOwned();

            const cleanupAt = nowIso();
            const finishOperations: TransactOperation[] = [];
            if (slotKey && context.applyLease && context.itemSnapshotRevision) {
              finishOperations.push(
                {
                  table: 'notion_import_jobs', op: 'expect', id: context.job.id,
                  where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
                  exists: true,
                },
                {
                  table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
                  where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
                  exists: true,
                },
              );
            }
            finishOperations.push(
              {
                table: 'file_uploads', op: 'expect', id,
                where: [
                  ['status', '==', 'deleting'],
                  ['updatedAt', '==', claimedAt],
                  ['notionImportSlotKey', '==', current.notionImportSlotKey ?? null],
                ],
                exists: true,
              },
              {
                table: 'file_uploads', op: 'update', id,
                data: {
                  status: 'expired',
                  ...(slotKey ? { notionImportSlotKey: null as unknown as string } : {}),
                  expiresAt: cleanupAt,
                  expiredAt: cleanupAt,
                  deletedAt: cleanupAt,
                  deletedBy: context.actorId,
                  ...(slotKey ? {
                    notionImportTerminalSweepAfter: new Date(
                      Date.now() + NOTION_FILE_TERMINAL_RESWEEP_DELAY_MS,
                    ).toISOString(),
                    notionImportTerminalSweepCompletedAt: null,
                  } : {}),
                  updatedAt: cleanupAt,
                },
              },
            );
            await context.db.transact(finishOperations);
            cleanupCompleted = true;
          },
        ),
      );
    }
    if (slotKey && cleanupCompleted) {
      context.checkpointUploadsBySlotKey?.delete(slotKey);
    }
    throw error;
  }

  if (!upload) throw new Error('Notion file copy did not reach an uploaded state.');
  context.createdUploadIds?.push(upload.id);
  if (slotKey) context.checkpointUploadsBySlotKey?.set(slotKey, upload);
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

async function retireIncompleteNotionFileCheckpoint(
  context: NotionFileCopyContext,
  upload: FileUpload,
) {
  if (upload.pageId || upload.blockId || upload.databaseId || upload.propertyId || upload.templateId) {
    throw Object.assign(new Error('Notion import cannot retire a checkpoint that already has a product owner.'), { code: 409 });
  }
  const proxy = storageBucket(context.storage, upload.bucket || FILE_BUCKET);
  if (!proxy) throw Object.assign(new Error('EdgeBase storage is unavailable for checkpoint recovery.'), { code: 409 });
  const workspace = await getExisting(context.db.table<Workspace>('workspaces'), context.job.workspaceId);
  if (!workspace) throw new Error('workspace was not found');
  await withFileWorkspaceLease(
    context.db,
    context.job.workspaceId,
    context.actorId,
    'notion-file-checkpoint-retire',
    async (lease) => {
      await lease.assertOwned();
      const uploads = context.db.table<FileUpload>('file_uploads');
      const current = await getExisting(uploads, upload.id);
      if (!current) return;
      if (current.pageId || current.blockId || current.databaseId || current.propertyId || current.templateId) {
        throw Object.assign(new Error('Notion import cannot retire a checkpoint that gained a product owner.'), { code: 409 });
      }
      if (current.status === 'expired' || current.status === 'deleted') return;
      if (!['uploaded', 'preparing', 'pending', 'deleting'].includes(current.status)) {
        throw Object.assign(new Error('Notion import checkpoint is not in a recoverable cleanup state.'), { code: 409 });
      }
      const recoveryExpiry = typeof current.expiresAt === 'string' ? Date.parse(current.expiresAt) : NaN;
      if (
        current.status !== 'uploaded'
        && current.status !== 'deleting'
        && (!Number.isFinite(recoveryExpiry) || recoveryExpiry > Date.now())
      ) {
        throw Object.assign(
          new Error('Notion import checkpoint cleanup is waiting for the lost object write to expire.'),
          { code: 503, notionImportFileRetryable: true },
        );
      }

      let deleting = current;
      if (current.status !== 'deleting') {
        const deletingAt = nowIso();
        const operations: TransactOperation[] = [];
        if (context.applyLease && context.itemSnapshotRevision) {
          operations.push(
            {
              table: 'notion_import_jobs', op: 'expect', id: context.job.id,
              where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
              exists: true,
            },
            {
              table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
              where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
              exists: true,
            },
          );
        }
        operations.push(
          {
            table: 'file_uploads', op: 'expect', id: current.id,
            where: [
              ['status', '==', current.status],
              ['updatedAt', '==', current.updatedAt ?? null],
              ['notionImportSlotKey', '==', current.notionImportSlotKey ?? null],
            ],
            exists: true,
          },
          {
            table: 'file_uploads', op: 'update', id: current.id,
            data: {
              status: 'deleting',
              deletionPreviousStatus: current.status,
              expiresAt: deletingAt,
              deletedBy: context.actorId,
              updatedAt: deletingAt,
            },
          },
        );
        await context.db.transact(operations);
        deleting = await getExisting(uploads, current.id) as FileUpload;
      }

      const objectCleanupSucceeded = await bestEffort(
        'notion-import retire incomplete checkpoint object',
        proxy.delete(deleting.key),
      );
      if (!objectCleanupSucceeded) {
        throw Object.assign(
          new Error('Notion import checkpoint cleanup is pending because its object could not be deleted.'),
          { code: 409, notionImportRecoveryPending: true },
        );
      }
      await lease.assertOwned();
      if (context.applyLease) await renewNotionApplyLease(context.db, context.applyLease);
      if (workspace.organizationId) {
        await releaseOrganizationStorage(context.admin, {
          id: deleting.id,
          organizationId: workspace.organizationId,
          workspaceId: workspace.id,
          bytes: deleting.size,
        });
      }
      await lease.assertOwned();
      const cleanupAt = nowIso();
      const operations: TransactOperation[] = [];
      if (context.applyLease && context.itemSnapshotRevision) {
        operations.push(
          {
            table: 'notion_import_jobs', op: 'expect', id: context.job.id,
            where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
            exists: true,
          },
          {
            table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
            where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
            exists: true,
          },
        );
      }
      operations.push(
        {
          table: 'file_uploads', op: 'expect', id: deleting.id,
          where: [['status', '==', 'deleting'], ['updatedAt', '==', deleting.updatedAt ?? null]],
          exists: true,
        },
        {
          table: 'file_uploads', op: 'update', id: deleting.id,
          data: {
            status: 'expired',
            notionImportSlotKey: null as unknown as string,
            expiresAt: cleanupAt,
            expiredAt: cleanupAt,
            deletedAt: cleanupAt,
            deletedBy: context.actorId,
            notionImportTerminalSweepAfter: new Date(
              Date.now() + NOTION_FILE_TERMINAL_RESWEEP_DELAY_MS,
            ).toISOString(),
            notionImportTerminalSweepCompletedAt: null,
            updatedAt: cleanupAt,
          },
        },
      );
      await context.db.transact(operations);
    },
  );
  if (upload.notionImportSlotKey) context.checkpointUploadsBySlotKey?.delete(upload.notionImportSlotKey);
}

async function recoverIncompleteNotionFileCheckpoint(
  context: NotionFileCopyContext,
  upload: FileUpload,
) {
  const expiresAt = typeof upload.expiresAt === 'string' ? Date.parse(upload.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
    throw Object.assign(
      new Error('Notion import file checkpoint is still being copied by the active or recently lost request.'),
      { code: 503, notionImportFileRetryable: true },
    );
  }
  const proxy = storageBucket(context.storage, upload.bucket || FILE_BUCKET);
  const recovered = await withFileWorkspaceLease(
    context.db,
    context.job.workspaceId,
    context.actorId,
    'notion-file-checkpoint-recover',
    async (lease) => {
      await lease.assertOwned();
      const uploads = context.db.table<FileUpload>('file_uploads');
      const current = await getExisting(uploads, upload.id);
      if (!current) return undefined;
      if (current.status === 'uploaded') return current;
      if (current.status === 'deleting') return undefined;
      if (current.status !== 'preparing' && current.status !== 'pending') {
        throw Object.assign(new Error('Notion import checkpoint is no longer recoverable.'), { code: 409 });
      }
      const currentExpiry = typeof current.expiresAt === 'string' ? Date.parse(current.expiresAt) : NaN;
      if (!Number.isFinite(currentExpiry) || currentExpiry > Date.now()) {
        throw Object.assign(
          new Error('Notion import file checkpoint is still being copied by the active or recently lost request.'),
          { code: 503, notionImportFileRetryable: true },
        );
      }
      const stored = proxy?.head ? await proxy.head(current.key) : null;
      if (
        !stored
        || stored.size !== current.size
        || typeof stored.etag !== 'string'
        || !stored.etag
        || normalizedImportedContentType(stored.contentType) !== normalizedImportedContentType(current.contentType)
      ) {
        return undefined;
      }
      const workspace = await getExisting(context.db.table<Workspace>('workspaces'), context.job.workspaceId);
      if (!workspace) throw new Error('workspace was not found');

      // First claim recovery under all three ownership fences. Cancellation or
      // apply takeover after this point can make publication fail, but cannot
      // let a second recovery mutate the same upload while this file lease is
      // held. The reservation id is the upload id, so crash retries are
      // idempotent in the central quota ledger.
      const recoveryAt = nowIso();
      const recoveryExpiresAt = new Date(Date.now() + NOTION_FILE_CHECKPOINT_RECOVERY_TTL_MS).toISOString();
      const claimOperations: TransactOperation[] = [];
      if (context.applyLease && context.itemSnapshotRevision) {
        claimOperations.push(
          {
            table: 'notion_import_jobs', op: 'expect', id: context.job.id,
            where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
            exists: true,
          },
          {
            table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
            where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
            exists: true,
          },
        );
      }
      claimOperations.push(
        {
          table: 'file_uploads', op: 'expect', id: current.id,
          where: [['status', '==', current.status], ['updatedAt', '==', current.updatedAt ?? null]],
          exists: true,
        },
        {
          table: 'file_uploads', op: 'update', id: current.id,
          data: { status: 'pending', expiresAt: recoveryExpiresAt, updatedAt: recoveryAt },
        },
      );
      await context.db.transact(claimOperations);
      await reserveOrganizationStorage(context.admin, workspace, current.id, current.size);
      await lease.assertOwned();
      const completedAt = nowIso();
      const publishOperations: TransactOperation[] = [];
      if (context.applyLease && context.itemSnapshotRevision) {
        publishOperations.push(
          {
            table: 'notion_import_jobs', op: 'expect', id: context.job.id,
            where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
            exists: true,
          },
          {
            table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
            where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
            exists: true,
          },
        );
      }
      publishOperations.push(
        {
          table: 'file_uploads', op: 'expect', id: current.id,
          where: [['status', '==', 'pending'], ['updatedAt', '==', recoveryAt]],
          exists: true,
        },
        {
          table: 'file_uploads', op: 'update', id: current.id,
          data: {
            status: 'uploaded', etag: stored.etag, expiresAt: null,
            completedAt, updatedAt: completedAt,
          },
        },
      );
      await context.db.transact(publishOperations);
      return await getExisting(uploads, current.id) ?? undefined;
    },
  );
  if (recovered) {
    const expectedSlotKey = optionalString(upload.notionImportSlotKey);
    const recoveredSlotKey = optionalString(recovered.notionImportSlotKey);
    if (!expectedSlotKey || recoveredSlotKey !== expectedSlotKey) {
      throw Object.assign(
        new Error('Notion import file checkpoint slot identity changed during recovery.'),
        { code: 409, notionImportRecoveryPending: true },
      );
    }
    context.checkpointUploadsBySlotKey?.set(recoveredSlotKey, recovered);
    context.verifiedCheckpointUploadIds?.add(recovered.id);
    return recovered;
  }
  await retireIncompleteNotionFileCheckpoint(context, upload);
  return undefined;
}

async function copyNotionFileReference(
  context: NotionFileCopyContext,
  target: NotionFileCopyTarget,
  reference: NotionFileReference,
  precomputedSlotKey?: string,
) {
  const slotCoordinates = context.itemSnapshotRevision && target.notionFileRole && target.notionFileStructuralPath
    ? notionImportFileSlotCoordinates(context.itemSnapshotRevision, target)
    : undefined;
  const slotKey = precomputedSlotKey
    ?? (slotCoordinates ? context.checkpointSlotKeysByCoordinates?.get(slotCoordinates) : undefined)
    ?? (context.itemSnapshotRevision && slotCoordinates
      ? await notionImportFileSlotKey(context.itemSnapshotRevision, target)
      : undefined);
  let checkpoint = slotKey ? context.checkpointUploadsBySlotKey?.get(slotKey) : undefined;
  if (slotKey && context.requireFileCopyCheckpoint && checkpoint) {
    // The in-process inventory is only a hint. Maintenance/cancellation can
    // CAS the durable row after cache hydration; re-read the exact id before
    // consuming it so a stale `uploaded` object cannot reach the owner
    // transaction and fail after product writes have begun.
    const current = await getExisting(context.db.table<FileUpload>('file_uploads'), checkpoint.id);
    if (
      current
      && current.workspaceId === context.job.workspaceId
      && current.notionImportJobId === context.job.id
      && current.notionImportSnapshotRevision === context.itemSnapshotRevision
      && current.notionImportSlotKey === slotKey
    ) {
      checkpoint = current;
      context.checkpointUploadsBySlotKey?.set(slotKey, current);
    } else {
      checkpoint = undefined;
      context.checkpointUploadsBySlotKey?.delete(slotKey);
    }
  }
  if (
    slotKey
    && context.requireFileCopyCheckpoint
    && (!checkpoint || checkpoint.status !== 'uploaded')
  ) {
    if (context.onRequiredCheckpointUnavailable) {
      return await context.onRequiredCheckpointUnavailable(
        slotKey,
        target,
        checkpoint ? 'not_uploaded' : 'missing',
      );
    }
    throw Object.assign(
      new Error(
        `Notion import required file checkpoint was ${checkpoint ? 'not uploaded' : 'missing'} for ` +
        `"${target.notionFileRole ?? 'unknown'}" at ` +
        `"${target.notionFileStructuralPath ?? 'unknown'}".`,
      ),
      { code: 503, notionImportRecoveryPending: true },
    );
  }
  if (checkpoint) {
    if (
      checkpoint.workspaceId !== context.job.workspaceId
      || checkpoint.notionImportJobId !== context.job.id
      || checkpoint.notionImportSnapshotRevision !== context.itemSnapshotRevision
      || checkpoint.notionImportSlotKey !== slotKey
    ) {
      throw Object.assign(new Error('Notion import file checkpoint identity did not match the active job.'), { code: 409 });
    }
    if (checkpoint.status !== 'uploaded') {
      checkpoint = await recoverIncompleteNotionFileCheckpoint(context, checkpoint);
    }
    if (checkpoint?.status === 'uploaded') {
      if (!optionalString(checkpoint.completedAt)) {
        throw Object.assign(new Error('Notion import file checkpoint was uploaded without a completion marker.'), { code: 409 });
      }
      if (!context.verifiedCheckpointUploadIds?.has(checkpoint.id)) {
        const proxy = storageBucket(context.storage, checkpoint.bucket || FILE_BUCKET);
        const stored = proxy?.head ? await proxy.head(checkpoint.key) : null;
        if (
          !stored
          || stored.size !== checkpoint.size
          || typeof stored.etag !== 'string'
          || !stored.etag
          || (checkpoint.etag && stored.etag !== checkpoint.etag)
          || normalizedImportedContentType(stored.contentType) !== normalizedImportedContentType(checkpoint.contentType)
        ) {
          throw Object.assign(new Error('Notion import file checkpoint object failed integrity verification.'), { code: 409 });
        }
        context.verifiedCheckpointUploadIds?.add(checkpoint.id);
      }
      context.pendingCheckpointTargets?.set(checkpoint.id, target);
      if (context.checkpointOnly) {
        // A worker can publish the durable upload and die before the file
        // cursor/report transaction. `created.fileCopies` is reconstructed
        // from uploaded checkpoints when the request starts, so incrementing
        // stats here would double count. The conversion report is not
        // reconstructible from the row, however: replay it only while the
        // pre-copy cursor still owns this slot. A successful progress commit
        // advances past the slot and makes this exact-once across restarts.
        reportNotionFileCopy(
          context.conversionReport,
          target.notionId,
          target.notionObject,
          target.label,
          reference,
          checkpoint,
        );
      }
      return localStoredFileReference(reference, checkpoint);
    }
  }
  if (slotKey && context.requireFileCopyCheckpoint) {
    throw Object.assign(
      new Error(
        `Notion import file pre-copy inventory did not contain required slot ` +
        `"${target.notionFileRole ?? 'unknown'}" at "${target.notionFileStructuralPath ?? 'unknown'}".`,
      ),
      { code: 409 },
    );
  }
  try {
    const copied = await storeNotionFileReference(context, target, reference, slotKey);
    if (copied.uploadId) context.pendingCheckpointTargets?.set(copied.uploadId, target);
    return copied;
  } catch (firstError) {
    if (
      firstError
      && typeof firstError === 'object'
      && ((firstError as { notionImportFileRetryable?: unknown }).notionImportFileRetryable === true
        || (firstError as { notionImportRecoveryPending?: unknown }).notionImportRecoveryPending === true)
    ) {
      throw firstError;
    }
    if (isTransientInfrastructureError(firstError)) {
      throw Object.assign(
        new Error(firstError instanceof Error ? firstError.message : String(firstError)),
        { code: 503, notionImportFileRetryable: true },
      );
    }
    const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
    const refreshed = await refreshNotionFileReference(context, target, reference);
    if (refreshed && refreshed.url && refreshed.url !== reference.url) {
      try {
        const copied = await storeNotionFileReference(context, target, refreshed, slotKey);
        if (copied.uploadId) context.pendingCheckpointTargets?.set(copied.uploadId, target);
        return copied;
      } catch (secondError) {
        if (isTransientInfrastructureError(secondError)) {
          throw Object.assign(
            new Error(secondError instanceof Error ? secondError.message : String(secondError)),
            { code: 503, notionImportFileRetryable: true },
          );
        }
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

function localPropertyType(notionType: string): DatabasePropertyType {
  const normalized = notionType.trim().toLowerCase();
  if (normalized === 'phone_number') return 'phone';
  if (normalized === 'people') return 'person';
  if (isDatabasePropertyType(normalized)) return normalized;
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

function localViewType(value: unknown): NotionDatabaseViewType {
  try {
    return parseDatabaseViewType(value);
  } catch {
    return 'table';
  }
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
      // A parenthetical suffix is often an annotation rather than part of the
      // view label (for example, "Synthetic expense (test)" -> "Synthetic
      // expense"). The caller still requires exactly one matching option, so
      // options that share the same outer label remain ambiguous and fail
      // closed instead of guessing.
      aliases.add(outerLabel);
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

export function inferredViewNameSelectFilter(viewName: string, properties: DbProperty[]) {
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

export function dbViewFromNotion(
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
  const typedView: Record<string, unknown> = unsupportedNotionViewType ? {} : view;
  const officialConfiguration = !unsupportedNotionViewType
    ? asRecord(view.configuration)
    : undefined;
  const collector = createViewPropertyReferenceCollector();
  const filterSource = firstDefinedViewValue(typedView, VIEW_FILTER_KEYS);
  const sortsSource = firstDefinedViewValue(typedView, VIEW_SORT_KEYS);
  const visiblePropertiesSource = firstDefinedViewValue(typedView, VIEW_VISIBLE_PROPERTY_KEYS);
  const hiddenPropertiesSource = firstDefinedViewValue(typedView, VIEW_HIDDEN_PROPERTY_KEYS);
  const propertyOrderSource = firstDefinedViewValue(typedView, VIEW_PROPERTY_ORDER_KEYS);
  const propertySettingsSource = firstDefinedViewValue(typedView, VIEW_PROPERTY_SETTING_KEYS);
  const propertyWidthsSource = firstDefinedViewValue(typedView, VIEW_PROPERTY_WIDTH_KEYS);
  const tableCalculationsSource = firstDefinedViewValue(typedView, VIEW_TABLE_CALCULATION_KEYS);
  const wrappedColumnsSource = firstDefinedViewValue(typedView, VIEW_WRAPPED_COLUMN_KEYS);
  const quickFiltersSource = firstDefinedViewValue(typedView, VIEW_QUICK_FILTER_KEYS);
  const groupBySource = firstDefinedViewValue(typedView, VIEW_GROUP_BY_KEYS);
  const subGroupBySource = firstDefinedViewValue(typedView, VIEW_SUBGROUP_BY_KEYS);
  const calendarBySource = firstDefinedViewValue(typedView, VIEW_CALENDAR_BY_KEYS);
  const timelineBySource = firstDefinedViewValue(typedView, VIEW_TIMELINE_BY_KEYS);
  const timelineEndBySource = firstDefinedViewValue(typedView, VIEW_TIMELINE_END_BY_KEYS);
  const coverPropertySource = firstDefinedViewValue(typedView, VIEW_COVER_PROPERTY_KEYS);
  const dependencyPropertySource = firstDefinedViewValue(typedView, VIEW_DEPENDENCY_PROPERTY_KEYS);
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
  const fallbackPropertyOrder = unsupportedNotionViewType
    ? undefined
    : fallbackNotionViewPropertyOrder(localProperties, type);
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
  const remappedGroupBy = remappedViewPropertyId(propertyMappings, groupBySource, collector, 'group');
  const remappedSubGroupBy = remappedViewPropertyId(
    propertyMappings,
    subGroupBySource,
    collector,
    'subgroup',
  );
  const groupBy = type === 'board'
    ? remappedGroupBy && isHanjiBoardMainGroupPropertyType(localPropertiesById.get(remappedGroupBy)?.type)
      ? remappedGroupBy
      : undefined
    : remappedGroupBy;
  const subGroupBy = type === 'board'
    ? remappedSubGroupBy && ['select', 'status'].includes(localPropertiesById.get(remappedSubGroupBy)?.type ?? '')
      ? remappedSubGroupBy
      : undefined
    : remappedSubGroupBy;
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
  const rowHeight = normalizedViewRowHeight(firstDefinedViewValue(typedView, VIEW_ROW_HEIGHT_KEYS));
  const cardSize = normalizedViewCardSize(firstDefinedViewValue(typedView, VIEW_CARD_SIZE_KEYS));
  const openPageIn = normalizedViewOpenPageIn(firstDefinedViewValue(typedView, VIEW_OPEN_PAGE_IN_KEYS));
  const timelineZoom = normalizedTimelineZoom(firstDefinedViewValue(typedView, VIEW_TIMELINE_ZOOM_KEYS));
  const wrap = normalizedViewBoolean(firstDefinedViewValue(typedView, VIEW_WRAP_KEYS));
  const quickFilters = remappedViewFilterList(
    propertyMappings,
    quickFiltersSource,
    collector,
    localPropertiesById,
  );
  const quickFilterGroup = quickFilters ? importedFilterGroupFromTerms(quickFilters) : undefined;
  const effectiveFilterGroup = mergeImportedFilterGroups(filterGroup, quickFilterGroup);
  const inferredFilter = !unsupportedNotionViewType && !effectiveFilterGroup
    ? inferredViewNameSelectFilter(typeof view.name === 'string' ? view.name : '', localProperties)
    : undefined;
  if (inferredFilter && report) incrementReport(report, 'inferredViewNameFilters');
  reportUnresolvedViewPropertyReferences(report, dataSourceId, view, collector);
  return normalizeDatabaseViewStorageRecord({
    id: newId(),
    databaseId,
    name: typeof view.name === 'string' && view.name.trim() ? view.name.trim() : `View ${position + 1}`,
    type,
    config: {
      ...(officialConfiguration ? structuredClone(officialConfiguration) : {}),
      type: officialConfiguration?.type ?? type,
      notionViewId: typeof view.id === 'string' ? view.id : undefined,
      notionType,
      unsupportedNotionViewType,
      notion: structuredClone(view),
      ...('configuration' in view
        ? { notionConfiguration: structuredClone(view.configuration) }
        : {}),
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
  });
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
    // Child pages/databases own their descendants. Apply keeps the boundary
    // block in the current page, then imports the child object's body from its
    // own page snapshot instead of duplicating that body under the parent.
    if (block.type === 'template' || block.type === 'child_page' || block.type === 'child_database') return;
    const children = block.type === 'tab'
      ? notionBlockChildren(block).map((child, index) => wrappedTabChildBlock(child, index))
      : notionBlockChildren(block);
    for (const child of children) {
      if (block.type === 'table' && child.type === 'table_row') continue;
      visit(child);
    }
  };
  const nestedBlockIds = nestedNotionBlockIds(blocks);
  for (const block of blocks) {
    const blockId = notionObjectId(block);
    if (blockId && nestedBlockIds.has(blockId)) continue;
    if (block.type === 'column' && notionBlockChildren(block).length === 0) continue;
    visit(block);
  }
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

interface PendingNotionImportFileCopySlot {
  reference: NotionFileReference;
  target: NotionFileCopyTarget;
}

function notionImportFileSlotCoordinates(
  revision: string,
  target: NotionFileCopyTarget,
) {
  return [
    'notion-file-slot-v1',
    revision,
    target.notionObject,
    target.notionId ?? '',
    target.notionPageId ?? '',
    target.notionBlockId ?? '',
    target.notionPropertyId ?? '',
    target.notionPageFileKind ?? '',
    target.notionFileRole ?? '',
    target.notionFileStructuralPath ?? '',
    String(target.notionFileOrdinal ?? 0),
  ].join('\u001f');
}

async function notionImportFileSlotKey(
  revision: string,
  target: NotionFileCopyTarget,
) {
  const canonical = notionImportFileSlotCoordinates(revision, target);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `notion-file-slot:v1:${hex}`;
}

function importedTemplateBlockFileSlotCandidates(
  rawBlocks: Record<string, unknown>[],
  base: Pick<NotionFileCopyTarget, 'notionId' | 'notionObject' | 'notionPageId'>,
  path: string,
  role: string,
  out: PendingNotionImportFileCopySlot[],
) {
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const rawBlock = rawBlocks[index]!;
    const blockPath = `${path}/${index}`;
    const reference = fileReferenceFromNotionBlock(rawBlock);
    if (reference) {
      const notionBlockId = notionObjectId(rawBlock);
      out.push({
        reference,
        target: {
          ...base,
          notionId: notionBlockId ?? base.notionId,
          scope: fileCopyScopeForBlockType(localBlockTypeFromNotion(optionalString(rawBlock.type) ?? '', rawBlock)),
          notionBlockId,
          notionFileRole: role,
          notionFileStructuralPath: blockPath,
          notionFileOrdinal: 0,
          label: role,
        },
      });
    }
    importedTemplateBlockFileSlotCandidates(
      templateBlockChildren(rawBlock),
      base,
      `${blockPath}/children`,
      role,
      out,
    );
  }
}

function importedPageBlockFileSlotCandidates(
  item: NotionImportItem,
  blocks: Record<string, unknown>[],
  out: PendingNotionImportFileCopySlot[],
) {
  const nestedIds = nestedNotionBlockIds(blocks);
  const visit = (rawBlock: Record<string, unknown>, path: string) => {
    const ownerSlotStart = out.length;
    const reference = fileReferenceFromNotionBlock(rawBlock);
    const notionBlockId = notionObjectId(rawBlock);
    if (reference) {
      out.push({
        reference,
        target: {
          notionId: notionBlockId ?? item.notionId,
          notionObject: 'block',
          label: 'page block',
          scope: fileCopyScopeForBlockType(localBlockTypeFromNotion(optionalString(rawBlock.type) ?? '', rawBlock)),
          notionPageId: item.notionId,
          notionBlockId,
          notionFileRole: 'page_block_file',
          notionFileStructuralPath: path,
          notionFileOrdinal: 0,
        },
      });
    }
    if (rawBlock.type === 'template') {
      importedTemplateBlockFileSlotCandidates(
        templateBlockChildren(rawBlock),
        {
          notionId: notionBlockId ?? item.notionId,
          notionObject: 'button_template_block',
          notionPageId: item.notionId,
        },
        `${path}/button`,
        'page_button_block_file',
        out,
      );
      assertImportedFileOwnerTransactionCapacity(
        out.length - ownerSlotStart,
        'Imported template-button block',
      );
      return;
    }
    assertImportedFileOwnerTransactionCapacity(
      out.length - ownerSlotStart,
      'Imported page block',
    );
    let childIndex = 0;
    for (const child of tabBlockChildrenForImport(rawBlock, undefined, item)) {
      if (rawBlock.type === 'table' && child.type === 'table_row') continue;
      if (rawBlock.type === 'child_page' || rawBlock.type === 'child_database') continue;
      visit(child, `${path}/children/${childIndex}`);
      childIndex += 1;
    }
  };
  for (let index = 0; index < blocks.length; index += 1) {
    const rawBlock = blocks[index]!;
    const notionBlockId = notionObjectId(rawBlock);
    if (notionBlockId && nestedIds.has(notionBlockId)) continue;
    if (rawBlock.type === 'column' && notionBlockChildren(rawBlock).length === 0) continue;
    visit(rawBlock, `page-blocks/${index}`);
  }
}

/** Enumerate exactly the file owners represented by the immutable apply
 * snapshot. Callers may pass only the unprocessed suffix for a legacy cursor. */
async function collectNotionImportFileCopySlots(
  allItems: NotionImportItem[],
  revision: string,
  includedItemIds?: Set<string>,
) {
  const pending: PendingNotionImportFileCopySlot[] = [];
  const dataSourceItems = allItems.filter((item) => item.notionObject === 'data_source');
  const dataSourceIds = new Set(
    dataSourceItems.map((item) => item.notionId),
  );
  for (const item of allItems) {
    if (includedItemIds && !includedItemIds.has(item.id)) continue;
    const databaseHasNativeSource = item.notionObject === 'database' && (() => {
      const metadata = itemMetadata(item);
      const sources = Array.isArray(metadata.dataSources) ? metadata.dataSources : [];
      const direct = sources.some((source) => {
        const id = asRecord(source) ? notionObjectId(source as Record<string, unknown>) : undefined;
        return !!id && dataSourceIds.has(id);
      });
      return direct || !!inferDataSourceForHiddenLinkedDatabase(item, allItems, dataSourceItems);
    })();
    if (
      item.notionObject === 'page'
      || item.notionObject === 'data_source'
      || (item.notionObject === 'database' && !databaseHasNativeSource)
    ) {
      const chrome = importedPageChromeFromItem(item);
      if (chrome.iconReference) {
        pending.push({
          reference: chrome.iconReference,
          target: {
            notionId: item.notionId,
            notionObject: 'page',
            label: 'page icon',
            scope: 'icons',
            notionPageId: item.notionId,
            notionPageFileKind: 'icon',
            notionFileRole: 'page_chrome_icon',
            notionFileStructuralPath: `${item.notionObject}:${item.notionId}/chrome`,
            notionFileOrdinal: 0,
          },
        });
      }
      if (chrome.coverReference) {
        pending.push({
          reference: chrome.coverReference,
          target: {
            notionId: item.notionId,
            notionObject: 'page',
            label: 'page cover',
            scope: 'covers',
            notionPageId: item.notionId,
            notionPageFileKind: 'cover',
            notionFileRole: 'page_chrome_cover',
            notionFileStructuralPath: `${item.notionObject}:${item.notionId}/chrome`,
            notionFileOrdinal: 0,
          },
        });
      }
    }

    if (item.notionObject === 'page') {
      const metadata = itemMetadata(item);
      if (rowDataSourceId(item, dataSourceIds)) {
        let rowFileCount = 0;
        for (const [nameOrId, rawValue] of Object.entries(asRecord(metadata.properties) ?? {})) {
          const prop = asRecord(rawValue) ?? {};
          const notionPropertyId = optionalString(prop.id) ?? nameOrId;
          const references = notionFilePropertyReferences(rawValue);
          rowFileCount += references.length;
          for (let index = 0; index < references.length; index += 1) {
            pending.push({
              reference: references[index]!,
              target: {
                notionId: notionPropertyId,
                notionObject: 'property',
                label: 'row file property',
                scope: 'database/files',
                notionPageId: item.notionId,
                notionPropertyId,
                notionPropertyName: nameOrId,
                notionFileIndex: index,
                notionFileName: references[index]!.name,
                notionFileRole: 'row_property_file',
                notionFileStructuralPath: `page:${item.notionId}/property:${notionPropertyId}`,
                notionFileOrdinal: index,
              },
            });
          }
        }
        assertImportedFileOwnerTransactionCapacity(rowFileCount, 'Imported database row');
      }
      const snapshot = pageSnapshot(item);
      const childBlocks = Array.isArray(snapshot?.childBlocks)
        ? snapshot.childBlocks.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
        : [];
      importedPageBlockFileSlotCandidates(item, childBlocks, pending);
    }

    if (item.notionObject === 'data_source') {
      const templates = rawTemplatesFromSnapshot(dataSourceSnapshot(item));
      for (let templateIndex = 0; templateIndex < templates.length; templateIndex += 1) {
        const templateSlotStart = pending.length;
        const template = templates[templateIndex]!;
        const templateId = notionObjectId(template) ?? item.notionId;
        const templatePath = `data-source:${item.notionId}/templates/${templateIndex}`;
        const icon = notionTemplateIconReference(template, 'template icon');
        if (icon) {
          pending.push({
            reference: icon,
            target: {
              notionId: templateId,
              notionObject: 'template',
              label: 'template icon',
              scope: 'icons',
              notionPageId: notionObjectId(template),
              notionPageFileKind: 'icon',
              notionFileRole: 'template_icon',
              notionFileStructuralPath: templatePath,
              notionFileOrdinal: 0,
            },
          });
        }
        for (const [nameOrId, rawValue] of Object.entries(templatePropertiesFromNotion(template) ?? {})) {
          const property = asRecord(rawValue) ?? {};
          const notionPropertyId = optionalString(property.id) ?? nameOrId;
          const references = notionFilePropertyReferences(rawValue);
          for (let index = 0; index < references.length; index += 1) {
            pending.push({
              reference: references[index]!,
              target: {
                notionId: templateId,
                notionObject: 'template',
                label: 'template file property',
                scope: 'database/files',
                notionPageId: notionObjectId(template),
                notionPropertyId,
                notionPropertyName: nameOrId,
                notionFileIndex: index,
                notionFileName: references[index]!.name,
                notionFileRole: 'template_property_file',
                notionFileStructuralPath: `${templatePath}/property:${notionPropertyId}`,
                notionFileOrdinal: index,
              },
            });
          }
        }
        importedTemplateBlockFileSlotCandidates(
          rawTemplateBlocks(template),
          { notionId: templateId, notionObject: 'template_block', notionPageId: notionObjectId(template) },
          `${templatePath}/blocks`,
          'template_block_file',
          pending,
        );
        assertImportedFileOwnerTransactionCapacity(
          pending.length - templateSlotStart,
          'Imported database template',
          3,
        );
      }
    }
  }

  const slots = await Promise.all(pending.map(async ({ reference, target }) => ({
    slotKey: await notionImportFileSlotKey(revision, target),
    reference,
    target,
  })));
  slots.sort((left, right) => left.slotKey.localeCompare(right.slotKey));
  for (let index = 1; index < slots.length; index += 1) {
    if (slots[index - 1]!.slotKey === slots[index]!.slotKey) {
      throw Object.assign(new Error('Notion import file slot coordinates were not unique.'), { code: 409 });
    }
  }
  return slots;
}

async function loadNotionImportFileCheckpoints(
  db: DbRef,
  jobId: string,
  revision: string,
) {
  const rows = await listAll(
    db.table<FileUpload>('file_uploads').where('notionImportJobId', '==', jobId),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  const bySlot = new Map<string, FileUpload>();
  for (const row of rows) {
    if (row.notionImportSnapshotRevision !== revision) continue;
    const key = optionalString(row.notionImportSlotKey);
    if (!key) continue;
    if (bySlot.has(key)) {
      throw Object.assign(new Error('Duplicate Notion import file checkpoint slot detected.'), { code: 409 });
    }
    bySlot.set(key, row);
  }
  return bySlot;
}

async function loadNotionImportFileCheckpointBySlotKey(
  db: DbRef,
  jobId: string,
  revision: string,
  slotKey: string,
) {
  const rows = await listAll(
    db.table<FileUpload>('file_uploads').where('notionImportSlotKey', '==', slotKey),
    2,
  );
  const matching = rows.filter((row) => (
    row.notionImportJobId === jobId
    && row.notionImportSnapshotRevision === revision
    && row.notionImportSlotKey === slotKey
  ));
  if (matching.length > 1) {
    throw Object.assign(new Error('Duplicate Notion import file checkpoint slot detected.'), { code: 409 });
  }
  return matching[0];
}

async function cleanupUnownedNotionImportFileCheckpoints(
  context: NotionFileCopyContext,
) {
  const revision = optionalString(context.itemSnapshotRevision);
  if (!revision) return;
  const checkpoints = await loadNotionImportFileCheckpoints(context.db, context.job.id, revision);
  for (const upload of checkpoints.values()) {
    if (upload.status === 'deleted' || upload.status === 'expired') continue;
    if (upload.pageId || upload.blockId || upload.databaseId || upload.propertyId || upload.templateId) continue;
    await retireIncompleteNotionFileCheckpoint(context, upload);
  }
  const remaining = await loadNotionImportFileCheckpoints(context.db, context.job.id, revision);
  const ownerless = Array.from(remaining.values()).filter((upload) => (
    upload.status !== 'deleted'
    && upload.status !== 'expired'
    && !upload.pageId
    && !upload.blockId
    && !upload.databaseId
    && !upload.propertyId
    && !upload.templateId
  ));
  if (ownerless.length > 0) {
    throw Object.assign(
      new Error('Notion import cannot complete while durable file checkpoints are still ownerless.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
}

async function copyNotionImportFileSlot(
  context: NotionFileCopyContext,
  slot: NotionImportFileCopySlot,
) {
  if (!context.itemSnapshotRevision) throw new Error('Notion import file slot requires an immutable revision.');
  const coordinates = notionImportFileSlotCoordinates(context.itemSnapshotRevision, slot.target);
  const expected = context.checkpointSlotKeysByCoordinates?.get(coordinates);
  if (expected && expected !== slot.slotKey) {
    throw Object.assign(new Error('Notion import file slot key changed before copy.'), { code: 409 });
  }
  return copyNotionFileReference(context, slot.target, slot.reference, slot.slotKey);
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

function reportImportedBlockLinkedViewResolutionFromRaw(
  report: ImportConversionReport | undefined,
  item: NotionImportItem,
  rawBlock: Record<string, unknown>,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  itemsByNotionId?: Map<string, NotionImportItem>,
) {
  if (!report) return;
  let localType = localBlockTypeFromNotion(
    typeof rawBlock.type === 'string' ? rawBlock.type : 'paragraph',
    rawBlock,
  );
  if (localType === 'inline_database' && rawBlock.type === 'child_database') {
    const targetItem = linkedNotionTargetIdsFromBlock(rawBlock)
      .map((targetId) => itemsByNotionId?.get(targetId))
      .find((candidate) => candidate?.notionObject === 'database');
    if (importedNotionDatabaseIsInline(targetItem) === false) localType = 'child_database';
  }
  if (localType !== 'inline_database') return;
  const linkedViewIds = linkedNotionViewIdsFromBlock(rawBlock);
  if (linkedViewIds.length === 0) return;
  const linkedView = linkedViewIds
    .map((viewId) => mappingsByNotionId.get(viewId))
    .find((mapping) => mapping?.localType === 'db_view');
  if (linkedView) return;
  incrementReport(report, 'unresolvedLinkedViews');
  pushReportIssue(report.unresolvedReferences, {
    code: 'linked_view_unresolved',
    notionId: linkedViewIds[0],
    notionObject: 'view',
    message: `Linked database view on "${item.title || item.notionId}" could not be mapped locally.`,
  });
}

function reportImportedPageMarkdownFallback(
  report: ImportConversionReport | undefined,
  item: NotionImportItem,
  markdownValue: unknown,
) {
  if (!report) return;
  const markdown = asRecord(markdownValue);
  const unknownBlockIds = Array.isArray(markdown?.unknownBlockIds)
    ? markdown.unknownBlockIds
    : [];
  if (unknownBlockIds.length > 0) {
    incrementReport(report, 'unknownMarkdownBlocks', unknownBlockIds.length);
    pushReportIssue(report.unsupported, {
      code: 'markdown_unknown_blocks',
      notionId: item.notionId,
      notionObject: 'page',
      message: `${unknownBlockIds.length} Notion block(s) on "${item.title || item.notionId}" were unknown in the markdown fallback.`,
    });
  }
  if (markdown?.truncated === true) {
    incrementReport(report, 'truncatedMarkdownPages');
    pushReportIssue(report.warnings, {
      code: 'markdown_truncated',
      notionId: item.notionId,
      notionObject: 'page',
      message: `Markdown fallback for "${item.title || item.notionId}" was truncated before import.`,
    });
  }
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
      notionBlockId: notionObjectId(block),
      buttonLabel: localType === 'button'
        ? isPartialNotionButtonBlock
          ? 'Notion button'
          : text || 'Button'
        : undefined,
      buttonTemplate: isPartialNotionButtonBlock ? [] : buttonTemplate,
      notionButtonPartial: isPartialNotionButtonBlock ? true : undefined,
      notionBlock: sanitizeNotionCredentialMetadata(block),
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

function hasFallbackNotionViewName(view: Record<string, unknown>) {
  const label = normalizedNotionImportLabel(view.name);
  return !label || label === 'untitled';
}

function importableNotionViews(rawViews: Record<string, unknown>[]) {
  const views = rawViews.filter((view): view is Record<string, unknown> => !!view && typeof view === 'object');
  const hasMeaningfulView = views.some((view) => !hasFallbackNotionViewName(view));
  return hasMeaningfulView ? views.filter((view) => !hasFallbackNotionViewName(view)) : views;
}

function localizedImportableNotionViews(
  rawViews: Record<string, unknown>[],
  locale: PersistentGeneratedLocale,
) {
  const views = importableNotionViews(rawViews);
  const table = persistentGeneratedLabels(locale).viewNames.table;
  if (views.length === 0) return [{ name: table, type: 'table' }];
  return views.map((view, index) =>
    hasFallbackNotionViewName(view)
      ? { ...view, name: index === 0 ? table : `${table} ${index + 1}` }
      : view,
  );
}

function normalizedNotionImportLabel(value: unknown) {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s_\-()[\]{}.,:;'"`~!@#$%^&*+=\\/|<>?]+/g, '')
    : '';
}

export function linkedDatabaseHeadingMatchesLabel(heading: string, label: string) {
  const normalizedHeading = normalizedNotionImportLabel(heading);
  const normalizedLabel = normalizedNotionImportLabel(label);
  if (!normalizedHeading || !normalizedLabel) return false;
  // Generic generated view names must never become evidence for linking a
  // hidden database to a data source. `Table` is the protocol default and
  // `표` is its product-locale counterpart; both are intentionally ambiguous.
  if (normalizedLabel === 'untitled' || normalizedLabel === 'table' || normalizedLabel === '표') {
    return false;
  }
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
  locale: PersistentGeneratedLocale = 'en',
) {
  return (
    meaningfulImportedTitle(item.title) ||
    meaningfulImportedTitle(notionTitle(database ?? {})) ||
    meaningfulImportedTitle(headingBeforeNotionBlockInImportItems(items, item.notionId)) ||
    parentImportItemTitle(item, items) ||
    persistentGeneratedLabels(locale).linkedDatabase
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

export async function collectNestedBlockChildren(
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
    // A child page/database owns a separate Notion resource boundary. Keep the
    // block so discovery can register that resource, but do not descend into
    // its body while snapshotting the parent. The child item will fetch its own
    // body once; descending here would read the same subtree twice.
    if (next.type === 'child_page' || next.type === 'child_database') continue;
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
    if (allChildren.hasMore && bag.warnings.length < 200) {
      bag.warnings.push({
        code: 'page_children_truncated',
        notionId: item.notionId,
        notionObject: item.notionObject,
        message:
          `Page "${item.notionId}" has more child blocks than this discovery pass fetched; ` +
          `they were truncated at the page limit.` +
          (childrenNextCursor ? ` Next children cursor: ${childrenNextCursor}.` : ''),
      });
    }
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
    const reportEntry = {
      code: response.retryable
        ? 'database_retrieve_retryable_error'
        : 'database_unavailable',
      notionId: databaseId,
      notionObject: 'database',
      message: response.error,
    };
    if (response.retryable) {
      bag.warnings.push(reportEntry);
    } else {
      bag.missingPermissions.push(reportEntry);
    }
    return {
      database: undefined,
      error: response.error,
      fetchStatus: response.retryable ? 'retryable_error' as const : 'unavailable' as const,
    };
  }
  return { database: response.data, error: undefined, fetchStatus: 'retrieved' as const };
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
    if (allTemplates.hasMore && bag.warnings.length < 200) {
      bag.warnings.push({
        code: 'data_source_templates_truncated',
        notionId: dataSourceId,
        notionObject: 'data_source',
        message:
          `Data source "${dataSourceId}" has more templates than this discovery pass fetched; ` +
          `they were truncated at the page limit.` +
          (templatesNextCursor ? ` Next templates cursor: ${templatesNextCursor}.` : ''),
      });
    }
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
    if (allRows.hasMore && bag.warnings.length < 200) {
      bag.warnings.push({
        code: 'data_source_rows_truncated',
        notionId: item.notionId,
        notionObject: item.notionObject,
        message:
          `Data source "${item.notionId}" has more rows than this discovery pass fetched; ` +
          `they were truncated at the page limit.` +
          (rowsNextCursor ? ` Next rows cursor: ${rowsNextCursor}.` : ''),
      });
    }
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
    if (allViews.hasMore && bag.warnings.length < 200) {
      bag.warnings.push({
        code: 'data_source_views_truncated',
        notionId: item.notionId,
        notionObject: item.notionObject,
        message:
          `Data source "${item.notionId}" has more views than this discovery pass fetched; ` +
          `they were truncated at the page limit.` +
          (viewsNextCursor ? ` Next views cursor: ${viewsNextCursor}.` : ''),
      });
    }
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
    snapshot: {
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
    },
    // Data-source query results are full page objects. Keep them only as an
    // in-memory side channel for this discovery call so row enrichment can
    // reuse the authorized response without duplicating every page inside the
    // persisted data-source snapshot. Partial/mock responses deliberately do
    // not qualify and retain the normal /pages/{id} fallback.
    reusableRowPagesById: new Map(
      queryResults.flatMap((record) => {
        const id = notionObjectId(record);
        return id && record.object === 'page' && asRecord(record.parent) && asRecord(record.properties)
          ? [[id, record] as const]
          : [];
      }),
    ),
  };
}

function notionImportDiscoveryRuntime() {
  return {
    NOTION_PREFLIGHT_SAMPLE_LIMIT,
    NOTION_DISCOVERY_PASS_SAFETY_LIMIT,
    optionalString,
    mapWithConcurrency,
    notionTitle,
    notionParentId,
    compactNotionMetadata,
    notionWorkspaceInfo,
    putDiscoveredItem,
    hasDiscoveredNotionId,
    notionObjectId,
    itemMetadata,
    notionPropertiesFromSnapshot,
    asRecord,
    notionPageIdsFromViewFilters,
    rawTemplatesFromSnapshot,
    flattenNotionBlocks,
    rawTemplateBlocks,
    linkedNotionTargetReferencesFromBlock,
    collectPageSnapshot,
    collectDatabaseSnapshot,
    collectDataSourceSnapshot,
    uniqueStrings,
  } satisfies NotionImportDiscoveryRuntime;
}

export async function discoverNotionGraph(
  token: Parameters<typeof discoverNotionGraphWithRuntime>[0],
  options: Parameters<typeof discoverNotionGraphWithRuntime>[1],
) {
  return discoverNotionGraphWithRuntime(token, options, notionImportDiscoveryRuntime);
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => !!value)));
}
async function preflightNotionImportGraph(
  token: Parameters<typeof preflightNotionImportGraphWithRuntime>[0],
  options: Parameters<typeof preflightNotionImportGraphWithRuntime>[1],
) {
  return preflightNotionImportGraphWithRuntime(token, options, notionImportDiscoveryRuntime);
}

function importItemGeneration(job: NotionImportJob) {
  return job.activeItemGeneration ?? null;
}

function notionImportSnapshotEnrichmentComplete(item: Pick<
  NotionImportItem,
  'notionId' | 'notionObject' | 'phase' | 'metadata'
>) {
  return !notionDiscoveryItemNeedsEnrichment({
    notionId: item.notionId,
    notionObject: item.notionObject,
    phase: item.phase,
    metadata: item.metadata,
  });
}

function notionImportItemEnrichmentComplete(item: Pick<
  NotionImportItem,
  'notionId' | 'notionObject' | 'phase' | 'metadata' | 'enrichmentComplete'
>) {
  if (typeof item.enrichmentComplete === 'boolean') return item.enrichmentComplete;
  // Legacy rows predate the scalar. A projected row intentionally has no
  // metadata, so recognize the unambiguous terminal snapshot phases without
  // hydrating their potentially huge block/view trees. The ambiguous
  // database_reference phase is left pending and gets one targeted getOne;
  // its metadata distinguishes terminal "unavailable" from retryable work.
  if (item.metadata === undefined) {
    if (item.notionObject === 'page') return item.phase === 'page_snapshot';
    if (item.notionObject === 'data_source') return item.phase === 'data_source_snapshot';
    if (item.notionObject === 'database') return item.phase === 'database_snapshot';
    return true;
  }
  return notionImportSnapshotEnrichmentComplete(item);
}

/**
 * Reads only the generation selected by the job's durable pointer. Rows from a
 * failed copy-on-write attempt are intentionally invisible. Legacy jobs and
 * rows both use SQL NULL, so they keep working without a destructive migration.
 */
export async function listActiveNotionImportItems(
  db: DbRef,
  job: NotionImportJob,
) {
  const generation = importItemGeneration(job);
  const byJob = db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id);
  // Legacy/first incremental jobs use SQL NULL for their generation. Keep the
  // indexed generation filter for concrete generations, but materialize the
  // bounded job rows before matching NULL: some SDK/runtime query adapters
  // omit a nullable optional field from the serialized filter and otherwise
  // return an empty set even though the durable rows are present.
  const narrowed = generation !== null && typeof byJob.where === 'function'
    ? byJob.where('itemGeneration', '==', generation)
    : byJob;
  const rows = await listAll(narrowed, NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  // The in-memory predicate is authoritative for narrow test/adapter
  // implementations that do not expose chained where().
  return rows.filter((item) => (item.itemGeneration ?? null) === generation);
}

const NOTION_IMPORT_DISCOVERY_SEED_FIELDS = [
  'id',
  'workspaceId',
  'jobId',
  'itemGeneration',
  'notionId',
  'notionObject',
  'parentNotionId',
  'title',
  'status',
  'phase',
  'enrichmentComplete',
  'error',
] as const;

/**
 * Materialize the active graph without its heavy metadata JSON. This is the
 * hot incremental-discovery path: completed page block trees, data-source
 * rows/views/templates, and markdown stay in SQLite until plan/apply needs
 * them. Older linked EdgeBase runtimes fall back to the full read rather than
 * silently returning an incomplete graph.
 */
export async function listActiveNotionImportDiscoverySeeds(
  db: DbRef,
  job: NotionImportJob,
) {
  const generation = importItemGeneration(job);
  const byJob = db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id);
  const narrowed = generation !== null && typeof byJob.where === 'function'
    ? byJob.where('itemGeneration', '==', generation)
    : byJob;
  const projected = projectFields(narrowed, NOTION_IMPORT_DISCOVERY_SEED_FIELDS);
  const rows = await listAll(projected, NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  return rows.filter((item) => (item.itemGeneration ?? null) === generation);
}

async function hydrateNotionImportDiscoverySeeds(
  db: DbRef,
  job: NotionImportJob,
  seeds: NotionImportItem[],
  limit: number,
) {
  const pending = seeds
    .filter((item) => !notionImportItemEnrichmentComplete(item))
    .slice(0, Math.max(0, limit));
  const hydrated = new Map<string, NotionImportItem>();
  const table = db.table<NotionImportItem>('notion_import_items');
  await mapWithConcurrency(pending, Math.min(10, Math.max(1, pending.length)), async (seed) => {
    const full = await getExisting(table, seed.id);
    if (
      !full
      || full.jobId !== job.id
      || (full.itemGeneration ?? null) !== importItemGeneration(job)
      || full.notionId !== seed.notionId
    ) {
      throw new Error('Notion import discovery seed changed while it was being hydrated.');
    }
    hydrated.set(full.notionId, full);
  });
  return hydrated;
}

export async function backfillNotionImportDiscoveryEnrichmentState(
  db: DbRef,
  job: NotionImportJob,
  rows: Array<Pick<NotionImportItem, 'id' | 'enrichmentComplete'>>,
  options: {
    expectedJobStatus?: NotionImportStatus;
    extraExpectations?: TransactOperation[];
    assertOwned?: () => Promise<void>;
  } = {},
) {
  const updates = rows.filter(
    (row): row is Pick<NotionImportItem, 'id'> & { enrichmentComplete: boolean } =>
      typeof row.enrichmentComplete === 'boolean',
  );
  if (updates.length === 0) return;
  const fenceOperations: TransactOperation[] = [
    ...(options.expectedJobStatus
      ? [{
          table: 'notion_import_jobs',
          op: 'expect' as const,
          id: job.id,
          where: [
            ['status', '==', options.expectedJobStatus],
            ['activeItemGeneration', '==', importItemGeneration(job)],
          ] as Array<[string, '==', unknown]>,
          exists: true,
        }]
      : []),
    ...(options.extraExpectations ?? []),
  ];
  const batchSize = Math.max(1, MAX_RAW_TRANSACT_OPS - fenceOperations.length);
  for (let index = 0; index < updates.length; index += batchSize) {
    await options.assertOwned?.();
    try {
      await db.transact([
        ...fenceOperations,
        ...updates.slice(index, index + batchSize).map((row): TransactOperation => ({
          table: 'notion_import_items',
          op: 'update',
          id: row.id,
          data: { enrichmentComplete: row.enrichmentComplete },
        })),
      ]);
    } catch (error) {
      if ((options.extraExpectations?.length ?? 0) > 0 && isApplyLeaseConflict(error)) {
        throw new NotionDiscoveryLeaseLostError(error);
      }
      throw error;
    }
  }
}

async function deleteImportItemRowsBestEffort(
  db: DbRef,
  rows: Array<Pick<NotionImportItem, 'id'>>,
  context: string,
) {
  let deletedAll = true;
  for (let index = 0; index < rows.length; index += MAX_RAW_TRANSACT_OPS) {
    const deleted = await bestEffort(
      context,
      db.transact(
        rows.slice(index, index + MAX_RAW_TRANSACT_OPS).map((row): TransactOperation => ({
          table: 'notion_import_items',
          op: 'delete',
          id: row.id,
        })),
      ),
    );
    if (!deleted) deletedAll = false;
  }
  return deletedAll;
}

interface ReplacedDiscoveredItems {
  items: NotionImportItem[];
  activeItemGeneration: string;
}

interface ReplaceDiscoveredItemsOptions {
  extraActivationExpectations?: TransactOperation[];
  assertOwned?: () => Promise<void>;
}

async function replaceDiscoveredItemsWithGeneration(
  db: DbRef,
  job: NotionImportJob,
  items: DiscoveredNotionItem[],
  options: ReplaceDiscoveredItemsOptions = {},
): Promise<ReplacedDiscoveredItems> {
  // Snapshot/MCP/API staging is an untrusted import boundary. A source may
  // contain an app-local key, upload id, canonical storage route, or the exact
  // URL of another Hanji upload. Reject it before deleting the previous
  // staging set so a failed refresh is non-destructive.
  await assertSafeNotionImportSourceReferences(
    db,
    items.map((item) => item.metadata),
  );
  if (items.length > NOTION_IMPORT_ITEM_SAFETY_LIMIT) {
    notionImportPayloadTooLarge(
      `discovery replacement exceeds ${NOTION_IMPORT_ITEM_SAFETY_LIMIT} items`,
    );
  }

  const previousGeneration = importItemGeneration(job);
  const previousRows = await listActiveNotionImportItems(db, job);
  const nextGeneration = newId();
  const stagedRows: NotionImportItem[] = items.map((item) => {
    const row: NotionImportItem = {
      id: newId(),
      workspaceId: job.workspaceId,
      jobId: job.id,
      itemGeneration: nextGeneration,
      notionId: item.notionId,
      notionObject: item.notionObject,
      parentNotionId: item.parentNotionId,
      title: item.title,
      status: item.status ?? 'discovered',
      phase: item.phase ?? 'discovery',
      metadata: item.metadata,
      error: item.error,
    };
    row.enrichmentComplete = notionImportSnapshotEnrichmentComplete(row);
    return row;
  });

  try {
    // EdgeBase accepts at most 500 operations per transaction. Each completed
    // batch is atomic, while the generation pointer keeps every partial batch
    // invisible until the entire replacement is durable.
    for (let index = 0; index < stagedRows.length; index += MAX_RAW_TRANSACT_OPS) {
      await db.transact(
        stagedRows.slice(index, index + MAX_RAW_TRANSACT_OPS).map((row): TransactOperation => ({
          table: 'notion_import_items',
          op: 'insert',
          data: row as unknown as Record<string, unknown>,
        })),
      );
    }
  } catch (error) {
    // Roll back completed batches when possible. A failed cleanup is still
    // safe: without the pointer flip, these rows are unreachable by all read,
    // plan, and apply paths.
    await deleteImportItemRowsBestEffort(
      db,
      stagedRows,
      'notion-import failed generation cleanup',
    );
    throw error;
  }

  let activated = false;
  try {
    await options.assertOwned?.();
    await db.transact([
      {
        table: 'notion_import_jobs',
        op: 'expect',
        id: job.id,
        where: [
          ['status', '==', job.status],
          ['activeItemGeneration', '==', previousGeneration],
        ],
        exists: true,
      },
      ...(options.extraActivationExpectations ?? []),
      {
        table: 'notion_import_jobs',
        op: 'update',
        id: job.id,
        data: { activeItemGeneration: nextGeneration },
      },
    ]);
    activated = true;
  } catch (error) {
    // A transport can theoretically throw after the transaction committed.
    // Re-read before deleting staged rows so an ambiguous response can never
    // remove the now-active generation.
    let current: NotionImportJob | null | undefined;
    try {
      current = await getExisting(db.table<NotionImportJob>('notion_import_jobs'), job.id);
    } catch {
      current = undefined;
    }
    activated = current?.activeItemGeneration === nextGeneration;
    if (!activated && current !== undefined) {
      await deleteImportItemRowsBestEffort(
        db,
        stagedRows,
        'notion-import uncommitted generation cleanup',
      );
    }
    if (!activated) throw error;
  }

  // Cleanup is deliberately after the one atomic visibility switch. Even a
  // complete deletion outage leaves only unreachable old rows, never a mixed
  // stale/new graph. Job FK cascade remains the eventual hard cleanup.
  await deleteImportItemRowsBestEffort(
    db,
    previousRows,
    'notion-import inactive generation cleanup',
  );
  return {
    items: stagedRows,
    activeItemGeneration: nextGeneration,
  };
}

export async function replaceDiscoveredItems(
  db: DbRef,
  job: NotionImportJob,
  items: DiscoveredNotionItem[],
  options: ReplaceDiscoveredItemsOptions = {},
) {
  const replacement = await replaceDiscoveredItemsWithGeneration(db, job, items, options);
  return replacement.items;
}

export async function mergeDiscoveredItems(
  db: DbRef,
  job: NotionImportJob,
  items: DiscoveredNotionItem[],
  options: {
    existingItems?: NotionImportItem[];
    projectedExistingItems?: boolean;
    hydratedExistingNotionIds?: Set<string>;
    includeItems?: boolean;
    expectedJobStatus?: NotionImportStatus;
    extraExpectations?: TransactOperation[];
    assertOwned?: () => Promise<void>;
  } = {},
) {
  await assertSafeNotionImportSourceReferences(
    db,
    items.map((item) => item.metadata),
  );
  if (items.length > NOTION_IMPORT_ITEM_SAFETY_LIMIT) {
    notionImportPayloadTooLarge(
      `discovery merge exceeds ${NOTION_IMPORT_ITEM_SAFETY_LIMIT} items`,
    );
  }

  // Incremental discovery already needs the active graph as its in-memory
  // seed. Accept that exact snapshot here so the durable merge never performs
  // a second full read of metadata/block trees after the Notion requests end.
  const existing = options.existingItems ?? await listActiveNotionImportItems(db, job);
  const existingByNotionId = new Map(existing.map((item) => [item.notionId, item]));
  const touchedNotionIds = new Set(items.map((item) => item.notionId));
  if (options.projectedExistingItems) {
    const hydratedIds = options.hydratedExistingNotionIds ?? new Set<string>();
    const itemTable = db.table<NotionImportItem>('notion_import_items');
    const toHydrate = Array.from(touchedNotionIds).filter((notionId) => (
      existingByNotionId.has(notionId) && !hydratedIds.has(notionId)
    ));
    await mapWithConcurrency(toHydrate, Math.min(10, Math.max(1, toHydrate.length)), async (notionId) => {
      const seed = existingByNotionId.get(notionId)!;
      const full = await getExisting(itemTable, seed.id);
      if (
        !full
        || full.jobId !== job.id
        || (full.itemGeneration ?? null) !== importItemGeneration(job)
        || full.notionId !== notionId
      ) {
        throw new Error('Notion import discovery item changed before its metadata merge.');
      }
      existingByNotionId.set(notionId, full);
      hydratedIds.add(notionId);
    });
  }
  const mergedByNotionId = new Map(existingByNotionId);

  for (const item of items) {
    const current = mergedByNotionId.get(item.notionId);
    if (current) {
      const nextStatus = current.status === 'discovered' && item.status === 'referenced'
        ? current.status
        : item.status ?? current.status ?? 'discovered';
      const next: NotionImportItem = {
        ...current,
        notionObject: item.notionObject,
        parentNotionId: item.parentNotionId ?? current.parentNotionId,
        title: item.title ?? current.title,
        status: nextStatus,
        phase: item.phase ?? current.phase ?? 'discovery',
        metadata: item.metadata === undefined
          ? current.metadata
          : {
              ...(current.metadata ?? {}),
              ...item.metadata,
            },
        error: item.error === undefined ? current.error ?? null : item.error,
      };
      next.enrichmentComplete = notionImportSnapshotEnrichmentComplete(next);
      mergedByNotionId.set(item.notionId, next);
      continue;
    }

    const next: NotionImportItem = {
      id: newId(),
      workspaceId: job.workspaceId,
      jobId: job.id,
      itemGeneration: importItemGeneration(job),
      notionId: item.notionId,
      notionObject: item.notionObject,
      parentNotionId: item.parentNotionId,
      title: item.title,
      status: item.status ?? 'discovered',
      phase: item.phase ?? 'discovery',
      metadata: item.metadata,
      error: item.error,
    };
    next.enrichmentComplete = notionImportSnapshotEnrichmentComplete(next);
    mergedByNotionId.set(item.notionId, next);
  }

  // Build at most one durable operation per touched Notion object. The
  // discovery graph contains every seed item on every incremental pass, but
  // unchanged seeds must not generate writes or keep a constrained NAS runtime
  // busy serializing identical metadata.
  const operations: TransactOperation[] = [];
  let inserted = 0;
  let updated = 0;
  for (const notionId of touchedNotionIds) {
    const current = existingByNotionId.get(notionId);
    const next = mergedByNotionId.get(notionId)!;
    if (!current) {
      operations.push({
        table: 'notion_import_items',
        op: 'insert',
        data: next as unknown as Record<string, unknown>,
      });
      inserted += 1;
      continue;
    }
    const patch = {
      notionObject: next.notionObject,
      parentNotionId: next.parentNotionId,
      title: next.title,
      status: next.status,
      phase: next.phase,
      enrichmentComplete: next.enrichmentComplete,
      metadata: next.metadata,
      error: next.error,
    };
    if (
      current.notionObject === patch.notionObject
      && current.parentNotionId === patch.parentNotionId
      && current.title === patch.title
      && current.status === patch.status
      && current.phase === patch.phase
      && current.enrichmentComplete === patch.enrichmentComplete
      && jsonEquivalent(current.metadata, patch.metadata)
      && (current.error ?? null) === (patch.error ?? null)
    ) {
      continue;
    }
    operations.push({
      table: 'notion_import_items',
      op: 'update',
      id: current.id,
      data: patch,
    });
    updated += 1;
  }

  // Keep each raw batch below both EdgeBase's 500-op hard ceiling and Hanji's
  // lower change-log-aware ceiling. When a status fence is present it occupies
  // one slot, and atomically prevents cancellation or a generation switch from
  // being followed by stale item writes.
  const fenceOperations: TransactOperation[] = [
    ...(options.expectedJobStatus
      ? [{
          table: 'notion_import_jobs',
          op: 'expect' as const,
          id: job.id,
          where: [
            ['status', '==', options.expectedJobStatus],
            ['activeItemGeneration', '==', importItemGeneration(job)],
          ] as Array<[string, '==', unknown]>,
          exists: true,
        }]
      : []),
    ...(options.extraExpectations ?? []),
  ];
  const itemBatchSize = Math.max(1, MAX_RAW_TRANSACT_OPS - fenceOperations.length);
  for (let index = 0; index < operations.length; index += itemBatchSize) {
    await options.assertOwned?.();
    const batch = operations.slice(index, index + itemBatchSize);
    try {
      await db.transact([
        ...fenceOperations,
        ...batch,
      ]);
    } catch (error) {
      if ((options.extraExpectations?.length ?? 0) > 0 && isApplyLeaseConflict(error)) {
        throw new NotionDiscoveryLeaseLostError(error);
      }
      throw error;
    }
  }

  const counts = countImportItemsByObject(mergedByNotionId.values());
  return {
    totalKnown: mergedByNotionId.size,
    counts,
    inserted,
    updated,
    ...(options.includeItems ? { items: Array.from(mergedByNotionId.values()) } : {}),
  };
}

type NotionImportCredentialScrubMutationCollector = (
  operation: TransactOperation,
) => Promise<void>;

async function scrubAppliedImportCredentialMetadata(
  db: DbRef,
  items: NotionImportItem[],
  collectMutation?: NotionImportCredentialScrubMutationCollector,
) {
  const table = db.table<NotionImportItem>('notion_import_items');
  if (collectMutation) {
    for (const item of items) {
      const sanitized = sanitizeNotionCredentialMetadata(item.metadata);
      const next = sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
        ? sanitized as Record<string, unknown>
        : {};
      if (jsonEquivalent(next, item.metadata ?? {})) continue;
      await collectMutation({
        table: 'notion_import_items',
        op: 'update',
        id: item.id,
        data: { metadata: next },
      });
    }
    return;
  }
  const concurrency = 20;
  for (let index = 0; index < items.length; index += concurrency) {
    await Promise.all(items.slice(index, index + concurrency).map(async (item) => {
      const sanitized = sanitizeNotionCredentialMetadata(item.metadata);
      const next = sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
        ? sanitized as Record<string, unknown>
        : {};
      if (jsonEquivalent(next, item.metadata ?? {})) return;
      await table.update(item.id, { metadata: next });
    }));
  }
}

async function scrubMappedImportProductCredentials(
  db: DbRef,
  jobId: string,
  collectMutation?: NotionImportCredentialScrubMutationCollector,
) {
  const mappings = await listAll(
    db.table<NotionImportMapping>('notion_import_mappings').where('jobId', '==', jobId),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  const pageIds = new Set(
    mappings
      .filter((mapping) => mapping.localType === 'page' || mapping.localType === 'database')
      .map((mapping) => mapping.localId),
  );
  for (const pageId of pageIds) {
    const page = await getExisting(db.table<Page>('pages'), pageId);
    if (!page) continue;
    const patch: Partial<Page> = {};
    if (page.icon && isCredentialBearingNotionUrl(page.icon)) {
      patch.icon = null as unknown as string;
      patch.iconType = 'none';
    }
    if (page.cover && isCredentialBearingNotionUrl(page.cover)) {
      patch.cover = null as unknown as string;
      patch.coverPosition = null as unknown as number;
    }
    const sanitizedProperties = sanitizeNotionCredentialMetadata(page.properties);
    if (!jsonEquivalent(sanitizedProperties, page.properties)) {
      patch.properties = asRecord(sanitizedProperties) ?? {};
    }
    if (Object.keys(patch).length > 0) {
      if (collectMutation) {
        await collectMutation({
          table: 'pages',
          op: 'update',
          id: page.id,
          data: patch as Record<string, unknown>,
        });
      } else {
        await db.table<Page>('pages').update(page.id, patch);
      }
    }

    const blocks = await listAll(
      db.table<Block>('blocks').where('pageId', '==', page.id),
      NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    );
    for (const block of blocks) {
      const content = sanitizeNotionCredentialMetadata(block.content);
      if (!jsonEquivalent(content, block.content)) {
        const patch = { content: asRecord(content) ?? {} };
        if (collectMutation) {
          await collectMutation({
            table: 'blocks',
            op: 'update',
            id: block.id,
            data: patch,
          });
        } else {
          await db.table<Block>('blocks').update(block.id, patch);
        }
      }
    }
  }

  for (const mapping of mappings.filter((candidate) => candidate.localType === 'db_template')) {
    const template = await getExisting(db.table<DbTemplate>('db_templates'), mapping.localId);
    if (!template) continue;
    const patch: Partial<DbTemplate> = {};
    if (template.icon && isCredentialBearingNotionUrl(template.icon)) {
      patch.icon = null as unknown as string;
    }
    const properties = sanitizeNotionCredentialMetadata(template.properties);
    if (!jsonEquivalent(properties, template.properties)) patch.properties = asRecord(properties) ?? {};
    const blocks = sanitizeNotionCredentialMetadata(template.blocks);
    if (!jsonEquivalent(blocks, template.blocks)) {
      patch.blocks = Array.isArray(blocks) ? blocks as TemplateBlock[] : [];
    }
    if (Object.keys(patch).length > 0) {
      if (collectMutation) {
        await collectMutation({
          table: 'db_templates',
          op: 'update',
          id: template.id,
          data: patch as Record<string, unknown>,
        });
      } else {
        await db.table<DbTemplate>('db_templates').update(template.id, patch);
      }
    }
  }
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
  const notionImportJobId = optionalString(properties.notionImportJobId);
  const notionImportSource = (
    [
      ['page', optionalString(properties.notionPageId)],
      ['data_source', optionalString(properties.notionDataSourceId)],
      ['database', optionalString(properties.notionDatabaseId)],
    ] as const
  ).find((entry) => !!entry[1]);
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
    notionImportJobId,
    notionImportSourceKind: notionImportSource?.[0],
    notionImportSourceId: notionImportSource?.[1],
    notionImportStaging: !!notionImportJobId,
    isFavorite: input.isFavorite ?? false,
    inTrash: !!notionImportJobId,
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

type ImportedPatchOwnerTable = 'pages' | 'blocks' | 'db_properties' | 'db_views' | 'db_templates';

const IMPORTED_PATCH_OWNER_FIELDS: Record<ImportedPatchOwnerTable, readonly string[]> = {
  pages: [
    'workspaceId', 'parentId', 'parentType', 'kind', 'title', 'icon', 'iconType', 'cover',
    'coverPosition', 'font', 'smallText', 'fullWidth', 'isLocked', 'isPublic',
    'backlinksDisplay', 'pageCommentsDisplay', 'properties', 'notionImportJobId',
    'notionImportSourceId', 'notionImportSourceKind', 'notionImportStaging',
    'isFavorite', 'inTrash', 'trashedAt',
    'position', 'createdBy', 'lastEditedBy', 'createdAt', 'updatedAt',
  ],
  blocks: [
    'pageId', 'parentId', 'type', 'content', 'plainText', 'position', 'createdBy',
    'lastEditedBy', 'lastMutationId', 'createdAt', 'updatedAt',
  ],
  db_properties: [
    'databaseId', 'notionImportJobId', 'notionDataSourceId', 'notionPropertyId',
    'name', 'description', 'type', 'config', 'position', 'createdAt', 'updatedAt',
  ],
  db_views: [
    'databaseId', 'notionImportJobId', 'notionDataSourceId', 'notionViewId',
    'notionViewStructuralIndex', 'notionImportSnapshotRevision', 'notionViewFingerprint',
    'notionRowContextJobId', 'notionRowContextSnapshotRevision', 'notionRowContextBlockId',
    'notionRowContextSourceViewId', 'notionRowContextFingerprint', 'name', 'type', 'config',
    'position', 'createdAt', 'updatedAt',
  ],
  db_templates: [
    'databaseId', 'notionImportJobId', 'notionTemplateId', 'notionDataSourceId', 'name',
    'icon', 'title', 'properties', 'blocks', 'isDefault', 'position', 'createdAt', 'updatedAt',
  ],
};

function importedPatchOwnerSnapshotWhere(
  owner: { id: string },
  table: ImportedPatchOwnerTable,
): Array<[string, '==', unknown]> {
  const record = owner as unknown as Record<string, unknown>;
  return IMPORTED_PATCH_OWNER_FIELDS[table].map((field) => [field, '==', record[field] ?? null]);
}

function importedPatchOwnerTransactionWhere(
  owner: { id: string },
  table: ImportedPatchOwnerTable,
): Array<[string, '==', unknown]> {
  // EdgeBase deliberately keeps transact expectations portable across D1,
  // Postgres, and Durable Objects by rejecting object/array equality. The
  // complete snapshot is still compared in memory before this helper is
  // called and again when classifying a conflict; the atomic fence must use
  // only scalar columns (most importantly the EdgeBase-managed updatedAt).
  return importedPatchOwnerSnapshotWhere(owner, table).filter(([, , value]) => (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ));
}

function importedPatchOwnerSnapshotMatches(
  expected: { id: string },
  current: { id: string } | null | undefined,
  table: ImportedPatchOwnerTable,
) {
  if (!current || current.id !== expected.id) return false;
  const expectedRecord = expected as unknown as Record<string, unknown>;
  const record = current as unknown as Record<string, unknown>;
  return importedPatchOwnerSnapshotWhere(expected, table).every(([field, , value]) => (
    // EdgeBase adds these fields after an insert. A raw owner retained by the
    // same apply request legitimately lacks them; every product field still
    // has to match, and the fresh durable timestamps fence the transaction.
    ((field === 'createdAt' || field === 'updatedAt') && expectedRecord[field] == null)
    ||
    jsonEquivalent(record[field] ?? null, value)
  ));
}

function notionImportMappingSnapshotMatches(
  expected: NotionImportMapping,
  current: NotionImportMapping | null | undefined,
) {
  return !!current
    && current.id === expected.id
    && current.workspaceId === expected.workspaceId
    && current.jobId === expected.jobId
    && (current.mappingKey ?? null) === (expected.mappingKey ?? null)
    && current.notionId === expected.notionId
    && current.notionType === expected.notionType
    && current.localId === expected.localId
    && current.localType === expected.localType
    && current.relationKind === expected.relationKind
    && jsonEquivalent(current.metadata ?? null, expected.metadata ?? null);
}

export async function transactImportedOwnerPatch<T extends { id: string }>(
  context: NotionFileCopyContext,
  input: {
    table: ImportedPatchOwnerTable;
    owner: T;
    patch: Partial<T>;
    requiredWhere: Array<[string, '==', unknown]>;
    extraExpectations?: TransactOperation[];
    label: string;
  },
): Promise<T> {
  if (!context.applyLease || !context.itemSnapshotRevision) {
    throw Object.assign(
      new Error(`Notion import ${input.label} requires the active apply lease and immutable snapshot revision.`),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
  const patch = input.patch as Record<string, unknown>;
  const snapshotFields = new Set(IMPORTED_PATCH_OWNER_FIELDS[input.table]);
  for (const field of Object.keys(patch)) {
    if (!snapshotFields.has(field)) {
      throw new Error(`Notion import ${input.label} patch field "${field}" is not covered by owner CAS.`);
    }
  }
  // Revalidate the complete JSON-bearing snapshot immediately before the
  // portable scalar transaction fence. This catches an edit that landed
  // after the caller loaded the owner, while updatedAt below closes the race
  // between this read and the atomic update without asking D1 to compare JSON.
  const currentOwner = await getExisting(context.db.table<T>(input.table), input.owner.id);
  if (!currentOwner || !importedPatchOwnerSnapshotMatches(input.owner, currentOwner, input.table)) {
    throw Object.assign(
      new Error(`Notion import ${input.label} owner changed concurrently; retry from the durable apply cursor.`),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
  const operations: TransactOperation[] = [
    {
      table: 'notion_import_jobs', op: 'expect', id: context.job.id,
      where: [['status', '==', 'ready'], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
      exists: true,
    },
    {
      table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
      where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
      exists: true,
    },
    ...(input.extraExpectations ?? []),
    {
      table: input.table,
      op: 'expect',
      id: input.owner.id,
      where: [
        ...input.requiredWhere,
        ...importedPatchOwnerTransactionWhere(currentOwner, input.table),
      ],
      exists: true,
    },
    {
      table: input.table,
      op: 'update',
      id: input.owner.id,
      data: patch,
    },
  ];
  try {
    await context.db.transact(operations);
  } catch (error) {
    if (!isApplyLeaseConflict(error)) throw error;
    const [currentJob, currentLease] = await Promise.all([
      getExisting(context.db.table<NotionImportJob>('notion_import_jobs'), context.job.id).catch(() => null),
      getExisting(
        context.db.table<NotionImportApplyLock>('notion_import_apply_locks'),
        context.applyLease.id,
      ).catch(() => null),
    ]);
    if (
      currentJob?.status === 'ready'
      && currentJob.itemSnapshotRevision === context.itemSnapshotRevision
      && currentLease?.leaseId === context.applyLease.leaseId
      && currentLease.purpose === 'apply'
    ) {
      throw Object.assign(
        new Error(`Notion import ${input.label} owner changed concurrently; retry from the durable apply cursor.`),
        { code: 409, notionImportRecoveryPending: true, cause: error },
      );
    }
    throw error;
  }
  return await getExisting(context.db.table<T>(input.table), input.owner.id)
    ?? ({ ...input.owner, ...input.patch } as T);
}

async function preserveImportedPageTimestamps(
  context: NotionFileCopyContext,
  page: Page,
  item: NotionImportItem,
) {
  const { db } = context;
  const timestamps = importedItemTimestamps(item);
  const patch: Partial<Page> = {};
  if (timestamps.createdAt && page.createdAt !== timestamps.createdAt) patch.createdAt = timestamps.createdAt;
  if (timestamps.updatedAt && page.updatedAt !== timestamps.updatedAt) patch.updatedAt = timestamps.updatedAt;
  if (Object.keys(patch).length === 0) return page;
  if (context?.blockRecoveryPage?.id === page.id) {
    await transactImportedPageBlockRecovery(db, [
      ...importedPageBlockRecoveryFence(context),
      importedPageBlockRecoveryPageExpectation(page),
      { table: 'pages', op: 'update', id: page.id, data: patch as Record<string, unknown> },
    ], page, context, 'timestamp preservation');
    const updated = await getExisting(db.table<Page>('pages'), page.id) ?? { ...page, ...patch };
    context.blockRecoveryPage = updated;
    return updated;
  }
  return transactImportedOwnerPatch(context, {
    table: 'pages',
    owner: page,
    patch,
    requiredWhere: [
      ['workspaceId', '==', context.job.workspaceId],
      ['notionImportJobId', '==', context.job.id],
      ['notionImportSourceId', '==', item.notionId],
      ['notionImportSourceKind', '==', item.notionObject === 'data_source' ? 'data_source' : item.notionObject],
    ],
    label: 'page timestamp preservation',
  });
}

async function loadMappings(db: DbRef, jobId: string) {
  const mappings = await listAll(db.table<NotionImportMapping>('notion_import_mappings').where('jobId', '==', jobId), NOTION_IMPORT_ITEM_SAFETY_LIMIT);
  const byNotionId = new Map<string, NotionImportMapping>();
  const canonicalKeys = new Set<string>();
  for (const mapping of mappings) {
    const canonical = mappingKeyForJob(jobId, mapping.notionId);
    if (canonicalKeys.has(canonical)) {
      throw new Error(`Duplicate Notion import mapping detected for source ${mapping.notionId}.`);
    }
    canonicalKeys.add(canonical);
    byNotionId.set(mapping.notionId, mapping);
  }
  return byNotionId;
}

function mappingKeyForJob(jobId: string, notionId: string) {
  return `${jobId}:${normalizedNotionId(notionId) || notionId.trim().toLowerCase()}`;
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
  context: NotionFileCopyContext,
  page: Page,
  resolvedParent: { parentId?: string; position?: number },
) {
  const { db } = context;
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
  if (context?.blockRecoveryPage?.id === page.id) {
    await transactImportedPageBlockRecovery(db, [
      ...importedPageBlockRecoveryFence(context),
      importedPageBlockRecoveryPageExpectation(page),
      { table: 'pages', op: 'update', id: page.id, data: patch as Record<string, unknown> },
    ], page, context, 'parent repair');
    const updated = await getExisting(db.table<Page>('pages'), page.id) ?? { ...page, ...patch };
    context.blockRecoveryPage = updated;
    return updated;
  }
  const notionSourceId = optionalString(page.notionImportSourceId);
  if (!notionSourceId) {
    throw Object.assign(
      new Error('Notion import page parent remap owner has no durable source provenance.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
  return transactImportedOwnerPatch(context, {
    table: 'pages',
    owner: page,
    patch,
    requiredWhere: [
      ['workspaceId', '==', context.job.workspaceId],
      ['notionImportJobId', '==', context.job.id],
      ['notionImportSourceId', '==', notionSourceId],
      ['notionImportSourceKind', '==', 'page'],
    ],
    label: 'page parent remap',
  });
}

interface NotionImportMappingInput {
  notionId: string;
  notionType: string;
  localId: string;
  localType: string;
  relationKind?: string;
  metadata?: Record<string, unknown>;
}

function notionImportMappingRow(
  job: NotionImportJob,
  input: NotionImportMappingInput,
): NotionImportMapping {
  return {
    id: newId(),
    workspaceId: job.workspaceId,
    jobId: job.id,
    mappingKey: mappingKeyForJob(job.id, input.notionId),
    notionId: input.notionId,
    notionType: input.notionType,
    localId: input.localId,
    localType: input.localType,
    relationKind: input.relationKind ?? 'canonical',
    metadata: input.metadata,
  };
}

async function createMapping(
  db: DbRef,
  admin: AdminDbAccessor,
  job: NotionImportJob,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  input: NotionImportMappingInput,
) {
  const existing = mappingForNotionId(mappingsByNotionId, input.notionId);
  if (existing) return existing;
  const mapping = await db.table<NotionImportMapping>('notion_import_mappings').insert(
    notionImportMappingRow(job, input),
  );
  mappingsByNotionId.set(mapping.notionId, mapping);
  // Route index must be written the moment a page/database is created, not only
  // in the end-of-apply batch — otherwise an interrupted apply leaves the page
  // unreachable by pageId (/p/:id deep links resolve via page_workspace_index).
  if (input.localType === 'page' || input.localType === 'database') {
    await ensurePageWorkspaceIndex(admin, input.localId, job.workspaceId);
  }
  return mapping;
}

async function publishRecoveredImportedOwnerMapping(
  context: NotionFileCopyContext,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  input: NotionImportMappingInput,
  ownerExpectation: {
    table: 'pages' | 'db_templates' | 'db_properties' | 'db_views';
    id: string;
    where: Array<[string, '==', unknown]>;
    patch?: Record<string, unknown>;
    uniqueWhere?: Array<[string, '==', unknown]>;
  },
) {
  const existing = mappingForNotionId(mappingsByNotionId, input.notionId);
  if (existing) {
    if (existing.localId !== input.localId || existing.localType !== input.localType) {
      throw Object.assign(new Error('Notion import recovery mapping changed before publication.'), { code: 409 });
    }
    return existing;
  }
  if (!context.applyLease || !context.itemSnapshotRevision) {
    throw Object.assign(
      new Error('Notion import owner recovery requires the active apply lease and immutable snapshot revision.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
  const mapping = notionImportMappingRow(context.job, input);
  await context.db.transact([
    {
      table: 'notion_import_jobs',
      op: 'expect',
      id: context.job.id,
      where: [
        ['status', '==', 'ready'],
        ['itemSnapshotRevision', '==', context.itemSnapshotRevision],
      ],
      exists: true,
    },
    {
      table: 'notion_import_apply_locks',
      op: 'expect',
      id: context.applyLease.id,
      where: [
        ['leaseId', '==', context.applyLease.leaseId],
        ['purpose', '==', 'apply'],
      ],
      exists: true,
    },
    {
      table: ownerExpectation.table,
      op: 'expect',
      id: ownerExpectation.id,
      where: ownerExpectation.where,
      exists: true,
    },
    {
      table: 'notion_import_mappings',
      op: 'expect',
      where: [['mappingKey', '==', mapping.mappingKey]],
      exists: false,
    },
    ...(ownerExpectation.uniqueWhere?.length
      ? [{
          table: ownerExpectation.table,
          op: 'expect' as const,
          where: ownerExpectation.uniqueWhere,
          exists: false,
        }]
      : []),
    ...(ownerExpectation.patch
      ? [{
          table: ownerExpectation.table,
          op: 'update' as const,
          id: ownerExpectation.id,
          data: ownerExpectation.patch,
        }]
      : []),
    {
      table: 'notion_import_mappings',
      op: 'insert',
      data: mapping as unknown as Record<string, unknown>,
    },
  ]);
  mappingsByNotionId.set(mapping.notionId, mapping);
  if (input.localType === 'page' || input.localType === 'database') {
    await ensurePageWorkspaceIndex(context.admin, input.localId, context.job.workspaceId);
  }
  return mapping;
}

async function publishImportedDatabaseAliasMapping(
  context: NotionFileCopyContext,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  input: NotionImportMappingInput,
  owner: Page,
  canonicalDataSourceId: string,
  patchCanonicalProperties = false,
) {
  const mappingKey = mappingKeyForJob(context.job.id, input.notionId);
  const existing = mappingForNotionId(mappingsByNotionId, input.notionId);
  if (existing) {
    if (
      existing.workspaceId !== context.job.workspaceId
      || existing.jobId !== context.job.id
      || existing.mappingKey !== mappingKey
      || normalizedNotionId(existing.notionId) !== normalizedNotionId(input.notionId)
      || existing.notionType !== input.notionType
      || existing.localId !== input.localId
      || existing.localType !== input.localType
      || (existing.relationKind ?? 'canonical') !== (input.relationKind ?? 'canonical')
      || !jsonEquivalent(existing.metadata, input.metadata)
    ) {
      throw Object.assign(new Error('Notion database alias mapping contradicted its canonical owner.'), { code: 409 });
    }
  }

  const properties = owner.properties ?? {};
  const propertyJobId = optionalString(properties.notionImportJobId);
  const propertyDataSourceId = optionalString(properties.notionDataSourceId);
  if (
    owner.id !== input.localId
    || owner.workspaceId !== context.job.workspaceId
    || owner.kind !== 'database'
    || propertyJobId !== context.job.id
    || propertyDataSourceId !== canonicalDataSourceId
    || (owner.notionImportJobId != null && owner.notionImportJobId !== context.job.id)
    || (owner.notionImportSourceId != null && owner.notionImportSourceId !== canonicalDataSourceId)
    || (owner.notionImportSourceKind != null && owner.notionImportSourceKind !== 'data_source')
  ) {
    throw Object.assign(new Error('Notion database alias owner provenance changed before publication.'), { code: 409 });
  }

  const currentDatabaseId = optionalString(properties.notionDatabaseId);
  const propertiesPatch = patchCanonicalProperties && !currentDatabaseId
    ? {
        properties: {
          ...properties,
          notionDatabaseId: input.notionId,
          notionDataSourceId: canonicalDataSourceId,
        },
      }
    : undefined;
  if (existing) {
    // The canonical page patch and alias mapping have been atomic since this
    // helper was introduced. An existing mapping with a still-missing patch
    // is therefore contradictory state, not a reason to perform a split
    // repair behind the active worker's fence.
    if (propertiesPatch) {
      throw Object.assign(new Error('Notion database alias mapping exists without its canonical page patch.'), { code: 409 });
    }
    await ensurePageWorkspaceIndex(context.admin, owner.id, context.job.workspaceId);
    return { mapping: existing, created: false };
  }
  if (!context.applyLease || !context.itemSnapshotRevision) {
    throw Object.assign(
      new Error('Notion database alias publication requires the active apply lease and immutable snapshot revision.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }

  const mapping = notionImportMappingRow(context.job, input);
  try {
    await context.db.transact([
      {
        table: 'notion_import_jobs',
        op: 'expect',
        id: context.job.id,
        where: [
          ['status', '==', 'ready'],
          ['itemSnapshotRevision', '==', context.itemSnapshotRevision],
        ],
        exists: true,
      },
      {
        table: 'notion_import_apply_locks',
        op: 'expect',
        id: context.applyLease.id,
        where: [
          ['leaseId', '==', context.applyLease.leaseId],
          ['purpose', '==', 'apply'],
        ],
        exists: true,
      },
      {
        table: 'pages',
        op: 'expect',
        id: owner.id,
        where: [
          ['workspaceId', '==', owner.workspaceId],
          ['parentId', '==', owner.parentId ?? null],
          ['parentType', '==', owner.parentType ?? null],
          ['kind', '==', owner.kind ?? null],
          ['notionImportJobId', '==', owner.notionImportJobId ?? null],
          ['notionImportSourceId', '==', owner.notionImportSourceId ?? null],
          ['notionImportSourceKind', '==', owner.notionImportSourceKind ?? null],
          ['inTrash', '==', owner.inTrash ?? null],
          ['trashedAt', '==', owner.trashedAt ?? null],
          ['position', '==', owner.position ?? null],
          ['isLocked', '==', owner.isLocked ?? null],
          ['updatedAt', '==', owner.updatedAt ?? null],
        ],
        exists: true,
      },
      {
        table: 'notion_import_mappings',
        op: 'expect',
        where: [['mappingKey', '==', mapping.mappingKey]],
        exists: false,
      },
      ...(propertiesPatch
        ? [{ table: 'pages', op: 'update' as const, id: owner.id, data: propertiesPatch }]
        : []),
      {
        table: 'notion_import_mappings',
        op: 'insert',
        data: mapping as unknown as Record<string, unknown>,
      },
    ]);
  } catch (error) {
    throw Object.assign(
      new Error('Notion database alias owner changed concurrently before publication.'),
      { code: 409, notionImportRecoveryPending: true, cause: error },
    );
  }
  mappingsByNotionId.set(mapping.notionId, mapping);
  await ensurePageWorkspaceIndex(context.admin, owner.id, context.job.workspaceId);
  return { mapping, created: true };
}

async function insertImportedDatabaseChildWithMapping<T extends DbProperty | DbView>(
  context: NotionFileCopyContext,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  table: 'db_properties' | 'db_views',
  owner: T,
  input?: Omit<NotionImportMappingInput, 'localId'>,
  uniqueWhere?: Array<[string, '==', unknown]>,
) {
  if (!context.applyLease || !context.itemSnapshotRevision) {
    throw Object.assign(
      new Error('Notion import database child publication requires the active apply lease and immutable revision.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
  const existing = input ? mappingForNotionId(mappingsByNotionId, input.notionId) : undefined;
  if (existing) {
    throw Object.assign(new Error('Notion import database child mapping changed before publication.'), { code: 409 });
  }
  const mapping = input
    ? notionImportMappingRow(context.job, { ...input, localId: owner.id })
    : undefined;
  const operations: TransactOperation[] = [
    {
      table: 'notion_import_jobs', op: 'expect', id: context.job.id,
      where: [['status', '==', 'ready'], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
      exists: true,
    },
    {
      table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
      where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
      exists: true,
    },
    { table, op: 'expect', id: owner.id, exists: false },
  ];
  if (uniqueWhere?.length) {
    operations.push({ table, op: 'expect', where: uniqueWhere, exists: false });
  }
  if (mapping) {
    operations.push({
      table: 'notion_import_mappings', op: 'expect',
      where: [['mappingKey', '==', mapping.mappingKey]], exists: false,
    });
  }
  operations.push({ table, op: 'insert', data: owner as unknown as Record<string, unknown> });
  if (mapping) {
    operations.push({
      table: 'notion_import_mappings', op: 'insert',
      data: mapping as unknown as Record<string, unknown>,
    });
  }
  try {
    await context.db.transact(operations);
  } catch (error) {
    if (isRetryableNotionTemplateCleanupError(error)) throw error;
    if (!isApplyLeaseConflict(error)) throw error;
    throw Object.assign(
      new Error('Notion import database child changed concurrently before publication.'),
      { code: 409, notionImportRecoveryPending: true, cause: error },
    );
  }
  if (mapping) mappingsByNotionId.set(mapping.notionId, mapping);
  return { owner, mapping };
}

async function claimRecoveredImportedDatabaseChild(
  context: NotionFileCopyContext,
  table: 'db_properties' | 'db_views' | 'db_templates',
  ownerId: string,
  where: Array<[string, '==', unknown]>,
  patch: Record<string, unknown>,
  uniqueWhere?: Array<[string, '==', unknown]>,
  extraExpectations: TransactOperation[] = [],
) {
  if (!context.applyLease || !context.itemSnapshotRevision) {
    throw Object.assign(
      new Error('Notion import database child recovery requires the active apply lease and immutable revision.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
  await context.db.transact([
    {
      table: 'notion_import_jobs', op: 'expect', id: context.job.id,
      where: [['status', '==', 'ready'], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
      exists: true,
    },
    {
      table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
      where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
      exists: true,
    },
    { table, op: 'expect', id: ownerId, where, exists: true },
    ...extraExpectations,
    ...(uniqueWhere?.length
      ? [{ table, op: 'expect' as const, where: uniqueWhere, exists: false }]
      : []),
    { table, op: 'update', id: ownerId, data: patch },
  ]);
}

async function insertImportedPageWithMapping(
  context: NotionFileCopyContext,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  page: Page,
  input: Omit<NotionImportMappingInput, 'localId'>,
  stageBlockRecovery = false,
) {
  const existing = mappingForNotionId(mappingsByNotionId, input.notionId);
  if (existing) {
    const existingPage = await getExisting(context.db.table<Page>('pages'), existing.localId);
    if (!existingPage) {
      throw Object.assign(new Error('Notion import mapping owner page was missing.'), { code: 409 });
    }
    await ensurePageWorkspaceIndex(context.admin, existingPage.id, context.job.workspaceId);
    return { page: existingPage, mapping: existing };
  }
  if (stageBlockRecovery && (!context.applyLease || !context.itemSnapshotRevision)) {
    throw Object.assign(
      new Error('Notion import block staging requires the active apply lease and immutable snapshot revision.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
  const pageForInsert = stageBlockRecovery
    ? {
        ...page,
        isLocked: true,
        properties: {
          ...(page.properties ?? {}),
          [NOTION_IMPORT_BLOCK_RECOVERY_KEY]: {
            jobId: context.job.id,
            itemSnapshotRevision: context.itemSnapshotRevision,
          },
        },
      }
    : page;
  const mapping = notionImportMappingRow(context.job, { ...input, localId: pageForInsert.id });
  const operations: TransactOperation[] = [];
  if (context.applyLease && context.itemSnapshotRevision) {
    operations.push(
      {
        table: 'notion_import_jobs', op: 'expect', id: context.job.id,
        where: [['status', '==', 'ready'], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
        exists: true,
      },
      {
        table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
        where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
        exists: true,
      },
    );
  }
  operations.push(
    { table: 'pages', op: 'expect', id: pageForInsert.id, exists: false },
    { table: 'pages', op: 'insert', data: pageForInsert as unknown as Record<string, unknown> },
    { table: 'notion_import_mappings', op: 'insert', data: mapping as unknown as Record<string, unknown> },
  );
  await context.db.transact(operations);
  mappingsByNotionId.set(mapping.notionId, mapping);
  await ensurePageWorkspaceIndex(context.admin, pageForInsert.id, context.job.workspaceId);
  return {
    page: await getExisting(context.db.table<Page>('pages'), pageForInsert.id) ?? pageForInsert,
    mapping,
  };
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
  applyLease?: { id: string; leaseId: string },
) {
  const generatedLabels = persistentGeneratedLabels(
    parsePersistentGeneratedLocale(asRecord(job.options)?.locale),
  );
  const rootNotionId = importRootNotionId(job.id);
  const existing = mappingForNotionId(mappingsByNotionId, rootNotionId);
  if (existing) {
    const existingPage = await getExisting(db.table<Page>('pages'), existing.localId);
    if (!existingPage) {
      throw Object.assign(new Error('Notion import root mapping owner was missing.'), { code: 409 });
    }
    await ensurePageWorkspaceIndex(admin, existingPage.id, job.workspaceId);
    return existing.localId;
  }
  const title = job.notionWorkspaceName
    ? `${generatedLabels.importedFromNotion} - ${job.notionWorkspaceName}`
    : generatedLabels.importedFromNotion;
  const parentId = job.parentPageId || null;
  const pageId = newId();
  const mappingId = newId();
  const page = {
    ...basePage({
      workspaceId: job.workspaceId,
      parentId,
      parentType: parentId ? 'page' : 'workspace',
      kind: 'page',
      title,
      position: 1,
      actorId,
      properties: {
        notionImportJobId: job.id,
        notionImportRoot: true,
        notionWorkspaceId: job.notionWorkspaceId,
      },
    }),
    id: pageId,
  } as Page;
  const mapping: NotionImportMapping = {
    id: mappingId,
    workspaceId: job.workspaceId,
    jobId: job.id,
    mappingKey: mappingKeyForJob(job.id, rootNotionId),
    notionId: rootNotionId,
    notionType: 'import_root',
    localId: pageId,
    localType: 'page',
    relationKind: 'import_root',
  };
  // The root page and its idempotency mapping must commit together. A worker
  // interruption between two independent inserts used to leave an orphan root
  // that the next apply duplicated.
  await db.transact([
    {
      table: 'notion_import_jobs',
      op: 'expect',
      id: job.id,
      where: [
        ['status', '==', 'ready'],
        ['itemSnapshotRevision', '==', job.itemSnapshotRevision ?? null],
      ],
      exists: true,
    },
    ...(applyLease ? [{
      table: 'notion_import_apply_locks',
      op: 'expect' as const,
      id: applyLease.id,
      where: [
        ['leaseId', '==', applyLease.leaseId] as [string, '==', unknown],
        ['purpose', '==', 'apply'] as [string, '==', unknown],
      ],
      exists: true,
    }] : []),
    {
      table: 'notion_import_mappings',
      op: 'expect',
      where: [['mappingKey', '==', mapping.mappingKey]],
      exists: false,
    },
    { table: 'pages', op: 'insert', data: page as unknown as Record<string, unknown> },
    { table: 'notion_import_mappings', op: 'insert', data: mapping as unknown as Record<string, unknown> },
  ]);
  mappingsByNotionId.set(rootNotionId, mapping);
  await ensurePageWorkspaceIndex(admin, pageId, job.workspaceId);
  return pageId;
}

/**
 * The import root is staging scaffolding, not a user page. Once apply is
 * complete, expose the selected Notion roots at the requested Hanji parent and
 * remove the wrapper. Supporting database pages discovered alongside a
 * selected page stay grouped beneath the first selected root instead of
 * leaking into the workspace root as unrelated sidebar entries.
 */
function notionImportCompletionFence(
  job: Pick<NotionImportJob, 'id' | 'itemSnapshotRevision'>,
  applyLease?: { id: string; leaseId: string },
  expectedJobStatus: NotionImportStatus = 'ready',
): TransactOperation[] {
  return [
    {
      table: 'notion_import_jobs',
      op: 'expect',
      id: job.id,
      where: [
        ['status', '==', expectedJobStatus],
        ['itemSnapshotRevision', '==', job.itemSnapshotRevision ?? null],
      ],
      exists: true,
    },
    ...(applyLease
      ? [{
          table: 'notion_import_apply_locks',
          op: 'expect' as const,
          id: applyLease.id,
          where: [
            ['leaseId', '==', applyLease.leaseId] as [string, '==', unknown],
            ['purpose', '==', 'apply'] as [string, '==', unknown],
          ],
          exists: true,
        }]
      : []),
  ];
}

export function notionImportMappingExpectation(mapping: NotionImportMapping): TransactOperation {
  const where: Array<[string, '==', unknown]> = [
    ['workspaceId', '==', mapping.workspaceId],
    ['jobId', '==', mapping.jobId],
    ['mappingKey', '==', mapping.mappingKey ?? null],
    ['notionId', '==', mapping.notionId],
    ['notionType', '==', mapping.notionType],
    ['localId', '==', mapping.localId],
    ['localType', '==', mapping.localType],
    ['relationKind', '==', mapping.relationKind],
  ];
  // Mapping rows are append-only. A mapping inserted transactionally in this
  // request is cached before EdgeBase returns its auto timestamp, so only use
  // updatedAt as an extra fence when the durable value is actually known.
  if (typeof mapping.updatedAt === 'string' && mapping.updatedAt) {
    where.push(['updatedAt', '==', mapping.updatedAt]);
  }
  return {
    table: 'notion_import_mappings',
    op: 'expect',
    id: mapping.id,
    where,
    exists: true,
  };
}

function notionImportUnwrapPageExpectation(page: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: page.id,
    where: [
      ['workspaceId', '==', page.workspaceId],
      ['parentId', '==', page.parentId ?? null],
      ['parentType', '==', page.parentType ?? null],
      ['kind', '==', page.kind ?? null],
      ['notionImportJobId', '==', page.notionImportJobId ?? null],
      ['notionImportSourceId', '==', page.notionImportSourceId ?? null],
      ['notionImportSourceKind', '==', page.notionImportSourceKind ?? null],
      ['notionImportStaging', '==', page.notionImportStaging ?? null],
      ['inTrash', '==', page.inTrash ?? null],
      ['trashedAt', '==', page.trashedAt ?? null],
      ['position', '==', page.position ?? null],
      ['isFavorite', '==', page.isFavorite ?? null],
      ['isLocked', '==', page.isLocked ?? null],
      ['updatedAt', '==', page.updatedAt ?? null],
    ],
    exists: true,
  };
}

async function stageIncompleteImportPages(
  db: DbRef,
  job: NotionImportJob,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  applyLease?: { id: string; leaseId: string },
) {
  if (!applyLease || !job.itemSnapshotRevision) {
    throw notionImportUnwrapRecoveryPendingError(
      'Notion import staging requires an active apply lease and immutable revision.',
    );
  }
  const mappingsByLocalId = new Map<string, NotionImportMapping[]>();
  for (const mapping of mappingsByNotionId.values()) {
    if (
      (mapping.localType !== 'page' && mapping.localType !== 'database')
      || !['import_root', 'page', 'data_source', 'database'].includes(mapping.notionType)
    ) continue;
    assertNotionImportUnwrapMapping(mapping, job);
    const ownerMappings = mappingsByLocalId.get(mapping.localId) ?? [];
    ownerMappings.push(mapping);
    mappingsByLocalId.set(mapping.localId, ownerMappings);
  }
  const localIds = Array.from(mappingsByLocalId.keys())
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const pages = db.table<Page>('pages');
  const fixedOperations = notionImportCompletionFence(job, applyLease);
  const ownerChunkSize = Math.min(
    100,
    Math.max(1, Math.floor((MAX_RAW_TRANSACT_OPS - fixedOperations.length) / 2)),
  );
  const ownersById = new Map<string, Page>();
  let staged = 0;

  for (let offset = 0; offset < localIds.length; offset += ownerChunkSize) {
    const ids = localIds.slice(offset, offset + ownerChunkSize);
    const expectedIds = new Set(ids);
    for (const owner of await listAll(pages.where('id', 'in', ids), ids.length)) {
      if (!expectedIds.has(owner.id) || ownersById.has(owner.id)) {
        throw notionImportUnwrapRecoveryPendingError(
          'Notion import staging returned an unexpected page owner.',
        );
      }
      ownersById.set(owner.id, owner);
    }
  }

  // Finish the bounded read/validation pass before the first write. A broken
  // legacy mapping must retain the established phase-specific error and must
  // not partially hide unrelated owners before that error is produced.
  for (const id of localIds) {
    const owner = ownersById.get(id);
    const ownerMappings = mappingsByLocalId.get(id) ?? [];
    if (
      !owner
      || owner.workspaceId !== job.workspaceId
      || !ownerMappings.some((mapping) => mapping.localType === owner.kind)
      || !notionImportPageHasMappingProvenance(owner, ownerMappings, job)
    ) {
      return { complete: false, staged: 0 };
    }
  }

  for (let offset = 0; offset < localIds.length; offset += ownerChunkSize) {
    const ids = localIds.slice(offset, offset + ownerChunkSize);
    const operations: TransactOperation[] = [];
    for (const id of ids) {
      const owner = ownersById.get(id)!;
      if (owner.inTrash === true && owner.notionImportStaging === true) continue;
      operations.push(
        notionImportUnwrapPageExpectation(owner),
        {
          table: 'pages',
          op: 'update',
          id: owner.id,
          data: { inTrash: true, notionImportStaging: true },
        },
      );
      staged += 1;
    }
    if (operations.length > 0) await db.transact([...fixedOperations, ...operations]);
  }
  return { complete: true, staged };
}

function notionImportUnwrapRecoveryPendingError(message: string) {
  return Object.assign(new Error(message), {
    code: 409,
    notionImportRecoveryPending: true,
  });
}

function assertNotionImportUnwrapMapping(mapping: NotionImportMapping, job: NotionImportJob) {
  if (
    mapping.workspaceId !== job.workspaceId
    || mapping.jobId !== job.id
    || !normalizedNotionId(mapping.notionId)
    || !mapping.localId
  ) {
    throw notionImportUnwrapRecoveryPendingError(
      'Notion import unwrap mapping provenance changed.',
    );
  }
}

function notionImportPageHasMappingProvenance(
  page: Page,
  mappings: NotionImportMapping[],
  job: NotionImportJob,
) {
  const properties = page.properties ?? {};
  const jobMarkers = [
    optionalString(page.notionImportJobId),
    optionalString(properties.notionImportJobId),
  ].filter((value): value is string => !!value);
  if (jobMarkers.some((value) => value !== job.id)) return false;
  const sourceMarkers = [
    optionalString(page.notionImportSourceId),
    optionalString(properties.notionPageId),
    optionalString(properties.notionDataSourceId),
    optionalString(properties.notionDatabaseId),
  ]
    .map(normalizedNotionId)
    .filter(Boolean);
  if (sourceMarkers.length === 0) return true;
  return mappings.some((mapping) => sourceMarkers.includes(normalizedNotionId(mapping.notionId)));
}

async function unwrapImportRoot(
  db: DbRef,
  admin: AdminDbAccessor,
  job: NotionImportJob,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  applyLease?: { id: string; leaseId: string },
  expectedJobStatus: NotionImportStatus = 'ready',
) {
  const rootNotionId = importRootNotionId(job.id);
  const rootMapping = mappingForNotionId(mappingsByNotionId, rootNotionId);
  if (!rootMapping || rootMapping.relationKind !== 'import_root') {
    return { unwrapped: 0, moved: 0 };
  }
  assertNotionImportUnwrapMapping(rootMapping, job);
  if (
    normalizedNotionId(rootMapping.notionId) !== normalizedNotionId(rootNotionId)
    || rootMapping.notionType !== 'import_root'
    || rootMapping.localType !== 'page'
  ) {
    throw notionImportUnwrapRecoveryPendingError(
      'Notion import root mapping changed before unwrap.',
    );
  }
  const pages = db.table<Page>('pages');
  const rootPage = await getExisting(pages, rootMapping.localId);
  if (!rootPage) {
    await db.transact([
      ...notionImportCompletionFence(job, applyLease, expectedJobStatus),
      notionImportMappingExpectation(rootMapping),
      { table: 'notion_import_mappings', op: 'delete', id: rootMapping.id },
    ]);
    mappingsByNotionId.delete(rootMapping.notionId);
    return { unwrapped: 0, moved: 0 };
  }

  const targetParentId = job.parentPageId || null;
  const targetParentType = targetParentId ? 'page' : 'workspace';
  const targetPage = targetParentId ? await getExisting(pages, targetParentId) : undefined;
  if (
    (targetParentId && !targetPage)
    || (targetPage && (
      targetPage.workspaceId !== job.workspaceId
      || targetPage.inTrash === true
      || targetPage.id === rootPage.id
      || targetPage.parentId === rootPage.id
    ))
  ) {
    throw notionImportUnwrapRecoveryPendingError(
      'Notion import unwrap target changed or left the workspace.',
    );
  }
  if (
    rootPage.workspaceId !== job.workspaceId
    || rootPage.kind !== 'page'
    || (rootPage.parentId ?? null) !== targetParentId
    || (rootPage.parentType ?? null) !== targetParentType
    || !notionImportPageHasMappingProvenance(rootPage, [rootMapping], job)
  ) {
    throw notionImportUnwrapRecoveryPendingError(
      'Notion import staging root provenance changed before unwrap.',
    );
  }

  const jobPageMappings = Array.from(mappingsByNotionId.values())
    .filter((mapping) => mapping.localType === 'page' || mapping.localType === 'database');
  for (const mapping of jobPageMappings) assertNotionImportUnwrapMapping(mapping, job);
  const mappingsByLocalId = new Map<string, NotionImportMapping[]>();
  for (const mapping of jobPageMappings) {
    const localMappings = mappingsByLocalId.get(mapping.localId) ?? [];
    localMappings.push(mapping);
    mappingsByLocalId.set(mapping.localId, localMappings);
  }

  const requestedRootIds = Array.from(new Set(
    [
      ...(job.rootNotionPageIds ?? []),
      ...(job.rootNotionDataSourceIds ?? []),
    ]
      .map(normalizedNotionId)
      .filter(Boolean),
  ));
  const orderedSelectedMappings = requestedRootIds
    .map((notionId) => mappingForNotionId(mappingsByNotionId, notionId))
    .filter((mapping): mapping is NotionImportMapping => !!mapping)
    .map((mapping) => {
      if (mapping.localType !== 'page' && mapping.localType !== 'database') {
        throw notionImportUnwrapRecoveryPendingError(
          'Notion import selected root mapping has an incompatible owner.',
        );
      }
      return mapping;
    });
  const selectedOwnerIds = Array.from(new Set(
    orderedSelectedMappings.map((mapping) => mapping.localId),
  )).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const selectedOwnerRowsById = new Map<string, Page>();
  const selectedOwnerReadChunkSize = 100;
  for (let offset = 0; offset < selectedOwnerIds.length; offset += selectedOwnerReadChunkSize) {
    const ids = selectedOwnerIds.slice(offset, offset + selectedOwnerReadChunkSize);
    const expectedIds = new Set(ids);
    for (const owner of await listAll(pages.where('id', 'in', ids), ids.length)) {
      if (!expectedIds.has(owner.id) || selectedOwnerRowsById.has(owner.id)) {
        throw notionImportUnwrapRecoveryPendingError(
          'Notion import selected root lookup returned an unexpected owner.',
        );
      }
      selectedOwnerRowsById.set(owner.id, owner);
    }
  }
  const selectedOwnersById = new Map<string, Page>();
  for (const mapping of orderedSelectedMappings) {
    if (selectedOwnersById.has(mapping.localId)) continue;
    const owner = selectedOwnerRowsById.get(mapping.localId);
    const ownerMappings = mappingsByLocalId.get(mapping.localId) ?? [];
    if (
      !owner
      || owner.workspaceId !== job.workspaceId
      || owner.kind !== mapping.localType
      || !notionImportPageHasMappingProvenance(owner, ownerMappings, job)
    ) {
      throw notionImportUnwrapRecoveryPendingError(
        'Notion import selected root owner provenance changed.',
      );
    }
    const isStillStaged = owner.parentId === rootPage.id && owner.parentType === 'page';
    const isAlreadyAtTarget = (owner.parentId ?? null) === targetParentId
      && (owner.parentType ?? null) === targetParentType;
    if (!isStillStaged && !isAlreadyAtTarget) {
      throw notionImportUnwrapRecoveryPendingError(
        'Notion import selected root moved outside its expected unwrap target.',
      );
    }
    if (targetPage && owner.id === targetPage.id) {
      throw notionImportUnwrapRecoveryPendingError(
        'Notion import selected root cannot be its own unwrap target.',
      );
    }
    selectedOwnersById.set(owner.id, owner);
  }
  const primarySelectedRoot = orderedSelectedMappings
    .map((mapping) => selectedOwnersById.get(mapping.localId))
    .find((page): page is Page => !!page);
  const selectedLocalIds = new Set(selectedOwnersById.keys());

  const directChildren = await listAll(
    pages.where('parentId', '==', rootPage.id),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  for (const page of directChildren) {
    const ownerMappings = mappingsByLocalId.get(page.id) ?? [];
    if (
      ownerMappings.length === 0
      || page.workspaceId !== job.workspaceId
      || !ownerMappings.some((mapping) => mapping.localType === page.kind)
      || !notionImportPageHasMappingProvenance(page, ownerMappings, job)
    ) {
      throw notionImportUnwrapRecoveryPendingError(
        'Notion import staging child provenance changed before unwrap.',
      );
    }
  }

  // Resolve every compatible page owner through bounded mixed-key reads. The
  // mapping graph is already loaded by apply; publication must not add a
  // whole-workspace scan or one independent read per owner.
  const pageOwnersById = new Map<string, Page>([
    [rootPage.id, rootPage],
    ...Array.from(selectedOwnersById.entries()),
    ...directChildren.map((page): [string, Page] => [page.id, page]),
  ]);
  const missingOwnerIds = Array.from(mappingsByLocalId.keys())
    .filter((localId) => !pageOwnersById.has(localId))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const ownerReadChunkSize = 100;
  for (let offset = 0; offset < missingOwnerIds.length; offset += ownerReadChunkSize) {
    const ids = missingOwnerIds.slice(offset, offset + ownerReadChunkSize);
    const expectedIds = new Set(ids);
    const rows = await listAll(pages.where('id', 'in', ids), ids.length);
    for (const page of rows) {
      if (!expectedIds.has(page.id) || pageOwnersById.has(page.id)) {
        throw notionImportUnwrapRecoveryPendingError(
          'Notion import publication returned an unexpected page owner.',
        );
      }
      pageOwnersById.set(page.id, page);
    }
  }
  for (const [localId, ownerMappings] of mappingsByLocalId) {
    const owner = pageOwnersById.get(localId);
    if (
      !owner
      || owner.workspaceId !== job.workspaceId
      || !ownerMappings.some((mapping) => mapping.localType === owner.kind)
      || !notionImportPageHasMappingProvenance(owner, ownerMappings, job)
    ) {
      throw notionImportUnwrapRecoveryPendingError(
        'Notion import publication owner provenance changed.',
      );
    }
  }

  // A concrete target is workspace content and can share the unwrap CAS. The
  // workspace row itself lives in the central block, so the root/job/page
  // workspace IDs are the same-transaction fence for a workspace-root target.
  const targetFenceOperations: TransactOperation[] = targetPage
    ? [notionImportUnwrapPageExpectation(targetPage)]
    : [];
  const fixedMoveOperations = [
    ...notionImportCompletionFence(job, applyLease, expectedJobStatus),
    ...targetFenceOperations,
    notionImportUnwrapPageExpectation(rootPage),
  ];
  const publishBatchSize = Math.floor((MAX_RAW_TRANSACT_OPS - fixedMoveOperations.length) / 2);
  const directChildrenById = new Map(directChildren.map((page) => [page.id, page]));
  const publicationPages = Array.from(pageOwnersById.values())
    .filter((page) => page.id !== rootPage.id)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (publishBatchSize < 1 && publicationPages.length > 0) {
    throw Object.assign(new Error('Notion import unwrap transaction budget is too small.'), { code: 500 });
  }
  for (let offset = 0; offset < publicationPages.length; offset += publishBatchSize) {
    const batch = publicationPages.slice(offset, offset + publishBatchSize);
    const publishOperations = batch.flatMap((page): TransactOperation[] => {
      const isDirectChild = directChildrenById.has(page.id);
      const isSelectedRoot = isDirectChild && selectedLocalIds.has(page.id);
      const keepWithSelectedRoot = isDirectChild && !isSelectedRoot && primarySelectedRoot;
      return [
        notionImportUnwrapPageExpectation(page),
        {
          table: 'pages',
          op: 'update',
          id: page.id,
          data: {
            ...(isDirectChild
              ? {
                  parentId: keepWithSelectedRoot ? primarySelectedRoot.id : targetParentId,
                  parentType: keepWithSelectedRoot ? 'page' : targetParentType,
                }
              : {}),
            // Legacy users often trashed the visibly-generated wrapper to get
            // it out of Pages; restore only the exactly-fenced import owner.
            inTrash: false,
            trashedAt: null,
            notionImportStaging: false,
            ...(isSelectedRoot ? { isFavorite: false } : {}),
          },
        },
      ];
    });
    await db.transact([...fixedMoveOperations, ...publishOperations]);
  }

  const routingPlan = await collectPermanentRoutingIndexPlan(admin, job.workspaceId, [rootPage.id]);
  await deletePermanentRoutingIndexes(routingPlan);
  await db.transact([
    ...notionImportCompletionFence(job, applyLease, expectedJobStatus),
    ...targetFenceOperations,
    notionImportUnwrapPageExpectation(rootPage),
    notionImportMappingExpectation(rootMapping),
    {
      table: 'pages',
      op: 'expect',
      where: [['parentId', '==', rootPage.id]],
      exists: false,
    },
    { table: 'notion_import_mappings', op: 'delete', id: rootMapping.id },
    { table: 'pages', op: 'delete', id: rootPage.id },
  ]);
  mappingsByNotionId.delete(rootMapping.notionId);
  return { unwrapped: 1, moved: directChildren.length };
}

// Failed/cancelled apply output is incomplete product state. Move every mapped
// page to Trash (reversible) so neither a localized staging wrapper nor partial
// children leak into Pages, Favorites, or search after a retry.
function pageHasExactNotionImportRecoveryLock(page: Page, job: NotionImportJob) {
  const marker = asRecord(asRecord(page.properties)?.[NOTION_IMPORT_BLOCK_RECOVERY_KEY]);
  if (!marker || marker.jobId !== job.id) return false;
  const revision = optionalString(job.itemSnapshotRevision);
  return !revision || marker.itemSnapshotRevision === revision;
}

const NOTION_IMPORT_TERMINAL_PAGE_CLEANUP_ATTEMPTS = 3;

interface NotionImportTerminalPageCandidate {
  id: string;
  mappings: NotionImportMapping[];
  checkpointOwner: boolean;
  locatorOwner: boolean;
}

interface NotionImportTerminalPageSnapshot {
  signature: string;
  importerRecoveryLock: boolean;
}

function notionImportTerminalPageCandidate(
  candidates: Map<string, NotionImportTerminalPageCandidate>,
  pageId: string | null | undefined,
) {
  if (!pageId) return undefined;
  const existing = candidates.get(pageId);
  if (existing) return existing;
  const candidate: NotionImportTerminalPageCandidate = {
    id: pageId,
    mappings: [],
    checkpointOwner: false,
    locatorOwner: false,
  };
  candidates.set(pageId, candidate);
  return candidate;
}

function notionImportTerminalPageIsOwned(
  page: Page,
  candidate: NotionImportTerminalPageCandidate,
  job: NotionImportJob,
) {
  if (page.workspaceId !== job.workspaceId) return false;
  const properties = asRecord(page.properties) ?? {};
  const jobMarkers = [
    optionalString(page.notionImportJobId),
    optionalString(properties.notionImportJobId),
  ].filter((value): value is string => !!value);
  if (jobMarkers.some((value) => value !== job.id)) return false;

  const matchingMappings = candidate.mappings.filter((mapping) => (
    mapping.workspaceId === job.workspaceId
    && mapping.jobId === job.id
    && mapping.localId === page.id
    && (mapping.localType === 'page' || mapping.localType === 'database')
    && mapping.localType === page.kind
  ));
  if (
    matchingMappings.length > 0
    && notionImportPageHasMappingProvenance(page, matchingMappings, job)
  ) {
    return true;
  }
  if (candidate.locatorOwner && page.notionImportJobId === job.id) return true;
  return candidate.checkpointOwner && jobMarkers.includes(job.id);
}

function notionImportTerminalPageSignature(page: Page) {
  const properties = asRecord(page.properties) ?? {};
  const marker = asRecord(properties[NOTION_IMPORT_BLOCK_RECOVERY_KEY]);
  // This signature is only compared in worker memory after a failed CAS. The
  // database expectation below deliberately contains scalars only because the
  // cross-backend transaction contract does not compare JSON object values.
  return JSON.stringify([
    page.workspaceId,
    page.parentId ?? null,
    page.parentType ?? null,
    page.kind ?? null,
    page.notionImportJobId ?? null,
    page.notionImportSourceId ?? null,
    page.notionImportSourceKind ?? null,
    page.notionImportStaging ?? null,
    optionalString(properties.notionImportJobId) ?? null,
    optionalString(properties.notionPageId) ?? null,
    optionalString(properties.notionDataSourceId) ?? null,
    optionalString(properties.notionDatabaseId) ?? null,
    optionalString(marker?.jobId) ?? null,
    optionalString(marker?.itemSnapshotRevision) ?? null,
    page.inTrash ?? null,
    page.trashedAt ?? null,
    page.position ?? null,
    page.isFavorite ?? null,
    page.isLocked ?? null,
    page.updatedAt ?? null,
  ]);
}

function notionImportTerminalPageWasEditedAfterJob(page: Page, job: NotionImportJob) {
  const terminalAt = Date.parse(job.finishedAt ?? job.cancelledAt ?? job.updatedAt ?? '');
  const pageUpdatedAt = Date.parse(page.updatedAt ?? '');
  // A terminal status is the last importer-owned write fence. A page revision
  // at or after that instant may be a user adoption, so a later cleanup request
  // must not reconstruct ownership from a stale mapping and trash it.
  return Number.isFinite(terminalAt)
    && Number.isFinite(pageUpdatedAt)
    && pageUpdatedAt >= terminalAt;
}

function notionImportTerminalPageCleanupExpectation(page: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: page.id,
    where: [
      ['workspaceId', '==', page.workspaceId],
      ['parentId', '==', page.parentId ?? null],
      ['parentType', '==', page.parentType ?? null],
      ['kind', '==', page.kind ?? null],
      ['notionImportJobId', '==', page.notionImportJobId ?? null],
      ['notionImportSourceId', '==', page.notionImportSourceId ?? null],
      ['notionImportSourceKind', '==', page.notionImportSourceKind ?? null],
      ['notionImportStaging', '==', page.notionImportStaging ?? null],
      ['inTrash', '==', page.inTrash ?? null],
      ['trashedAt', '==', page.trashedAt ?? null],
      ['position', '==', page.position ?? null],
      ['isFavorite', '==', page.isFavorite ?? null],
      ['isLocked', '==', page.isLocked ?? null],
      ['updatedAt', '==', page.updatedAt ?? null],
    ],
    exists: true,
  };
}

function notionImportTerminalPageCleanupSatisfied(
  page: Page,
  snapshot: NotionImportTerminalPageSnapshot,
  job: NotionImportJob,
) {
  return page.inTrash === true
    && page.notionImportStaging !== true
    && page.isFavorite !== true
    && !pageHasExactNotionImportRecoveryLock(page, job)
    && (!snapshot.importerRecoveryLock || page.isLocked !== true);
}

function isRetryableNotionImportTerminalPageCleanupError(error: unknown) {
  if (isApplyLeaseConflict(error)) return true;
  return isTransientInfrastructureError(error);
}

function notionImportTerminalPageCleanupPendingError() {
  return Object.assign(
    new Error('Notion import terminal page cleanup observed a newer page revision.'),
    { code: 409, notionImportRecoveryPending: true },
  );
}

async function trashIncompleteImportPageBatch(
  db: DbRef,
  job: NotionImportJob,
  candidates: NotionImportTerminalPageCandidate[],
  trashedAt: string,
) {
  const pages = db.table<Page>('pages');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const snapshots = new Map<string, NotionImportTerminalPageSnapshot>();
  const lastAttemptedIds = new Set<string>();
  const confirmedIds = new Set<string>();
  const changedIds = new Set<string>();

  for (let attempt = 0; attempt < NOTION_IMPORT_TERMINAL_PAGE_CLEANUP_ATTEMPTS; attempt += 1) {
    const currentJob = await getExisting(jobs, job.id);
    if (
      !currentJob
      || currentJob.workspaceId !== job.workspaceId
      || currentJob.status !== job.status
      || (currentJob.itemSnapshotRevision ?? null) !== (job.itemSnapshotRevision ?? null)
      || (currentJob.status !== 'failed' && currentJob.status !== 'cancelled')
    ) {
      throw notionImportTerminalPageCleanupPendingError();
    }

    const rows = await Promise.all(
      candidates.map((candidate) => getExisting(pages, candidate.id)),
    );
    const operations: TransactOperation[] = [];
    const attemptedIds = new Set<string>();
    rows.forEach((page, index) => {
      if (!page) return;
      const candidate = candidates[index];
      if (!notionImportTerminalPageIsOwned(page, candidate, job)) return;
      const signature = notionImportTerminalPageSignature(page);
      const snapshot = snapshots.get(page.id);
      if (!snapshot) {
        if (notionImportTerminalPageWasEditedAfterJob(page, job)) return;
        snapshots.set(page.id, {
          signature,
          importerRecoveryLock: pageHasExactNotionImportRecoveryLock(page, job),
        });
      } else if (signature !== snapshot.signature) {
        if (lastAttemptedIds.has(page.id) && notionImportTerminalPageCleanupSatisfied(page, snapshot, job)) {
          confirmedIds.add(page.id);
        } else {
          // A changed-but-active page is a possible user takeover. Exclude it
          // from every retry rather than applying a newly-read snapshot.
          changedIds.add(page.id);
        }
        return;
      }

      const stableSnapshot = snapshots.get(page.id)!;
      if (notionImportTerminalPageCleanupSatisfied(page, stableSnapshot, job)) return;
      const hasImporterRecoveryLock = stableSnapshot.importerRecoveryLock;
      const data: Record<string, unknown> = {
        isFavorite: false,
        ...(!page.inTrash ? { inTrash: true } : {}),
        ...(!page.trashedAt ? { trashedAt } : {}),
        ...(page.notionImportStaging === true ? { notionImportStaging: false } : {}),
      };
      if (hasImporterRecoveryLock) {
        const properties = { ...(page.properties ?? {}) };
        delete properties[NOTION_IMPORT_BLOCK_RECOVERY_KEY];
        data.properties = properties;
        if (page.isLocked === true) data.isLocked = false;
      }
      attemptedIds.add(page.id);
      operations.push(
        notionImportTerminalPageCleanupExpectation(page),
        { table: 'pages', op: 'update', id: page.id, data },
      );
    });

    if (operations.length === 0) break;
    lastAttemptedIds.clear();
    attemptedIds.forEach((id) => lastAttemptedIds.add(id));
    try {
      await db.transact([
        ...notionImportCompletionFence(job, undefined, job.status),
        ...operations,
      ]);
      attemptedIds.forEach((id) => confirmedIds.add(id));
      break;
    } catch (error) {
      if (
        !isRetryableNotionImportTerminalPageCleanupError(error)
        || attempt === NOTION_IMPORT_TERMINAL_PAGE_CLEANUP_ATTEMPTS - 1
      ) {
        throw error;
      }
    }
  }

  if (changedIds.size > 0) throw notionImportTerminalPageCleanupPendingError();
  return confirmedIds.size;
}

async function trashIncompleteImportPages(
  db: DbRef,
  job: NotionImportJob,
  mappings?: NotionImportMapping[],
  options: { includeCheckpointOwners?: boolean } = {},
) {
  if (job.status !== 'failed' && job.status !== 'cancelled') return 0;
  const jobMappings = mappings ?? await listAll(
    db.table<NotionImportMapping>('notion_import_mappings').where('jobId', '==', job.id),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  // A legacy worker may have committed a page/file-owner transaction and died
  // before its mapping insert. Durable repair may use checkpoint FKs as exact
  // owner locators, but terminal request paths explicitly skip that backlog;
  // their file/object work is owned by the bounded maintenance continuation.
  const checkpointOwners = options.includeCheckpointOwners === false
    ? []
    : await listAll(
        db.table<FileUpload>('file_uploads').where('notionImportJobId', '==', job.id),
        NOTION_IMPORT_ITEM_SAFETY_LIMIT,
      );
  const locatorOwners = await listAll(
    db.table<Page>('pages').where('notionImportJobId', '==', job.id),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  const candidates = new Map<string, NotionImportTerminalPageCandidate>();
  for (const mapping of jobMappings) {
    if (
      mapping.workspaceId !== job.workspaceId
      || mapping.jobId !== job.id
      || (mapping.localType !== 'page' && mapping.localType !== 'database')
    ) continue;
    const candidate = notionImportTerminalPageCandidate(candidates, mapping.localId);
    candidate?.mappings.push(mapping);
  }
  for (const upload of checkpointOwners) {
    if (upload.workspaceId !== job.workspaceId) continue;
    for (const pageId of [upload.pageId, upload.databaseId]) {
      const candidate = notionImportTerminalPageCandidate(candidates, pageId);
      if (candidate) candidate.checkpointOwner = true;
    }
  }
  for (const page of locatorOwners) {
    if (page.workspaceId !== job.workspaceId || page.notionImportJobId !== job.id) continue;
    const candidate = notionImportTerminalPageCandidate(candidates, page.id);
    if (candidate) candidate.locatorOwner = true;
  }
  const trashedAt = nowIso();
  let trashed = 0;
  const completionFenceSize = notionImportCompletionFence(job, undefined, job.status).length;
  const cleanupPageBatchSize = Math.max(
    1,
    Math.floor((MAX_RAW_TRANSACT_OPS - completionFenceSize) / 2),
  );
  const pageCandidates = Array.from(candidates.values());
  for (let offset = 0; offset < pageCandidates.length; offset += cleanupPageBatchSize) {
    trashed += await trashIncompleteImportPageBatch(
      db,
      job,
      pageCandidates.slice(offset, offset + cleanupPageBatchSize),
      trashedAt,
    );
  }
  return trashed;
}

function rowDataSourceId(item: NotionImportItem, dataSourceIds: Set<string>) {
  const metadata = itemMetadata(item);
  const value = metadata.dataSourceId;
  if (typeof value === 'string' && dataSourceIds.has(value.trim())) return value.trim();
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
  if (
    type === 'button' ||
    type === 'location' ||
    type === 'verification' ||
    type === 'last_visited_time' ||
    type === 'place'
  ) {
    const normalized = normalizeDatabasePropertyImportValue(type, prop[type]);
    return normalized === OMIT_DATABASE_PROPERTY_IMPORT_VALUE
      ? normalized
      : structuredClone(normalized);
  }
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
    const notionPropId = optionalString(prop.id) ?? nameOrId;
    const localPropId = propertyMappings.get(notionPropId) ?? propertyMappings.get(nameOrId);
    if (!localPropId) continue;
    const converted = options.omitFileValuesNeedingStorage && prop.type === 'files'
      ? []
      : convertNotionPropertyValue(rawValue);
    if (converted !== OMIT_DATABASE_PROPERTY_IMPORT_VALUE) {
      out[localPropId] = converted;
    }
    reportNotionUserReferences(
      reportContext?.report,
      reportContext?.notionId ?? notionPropId,
      reportContext?.notionObject ?? 'property',
      `property "${nameOrId}"`,
      notionUserReferencesFromPropertyValue(rawValue),
    );
  }
  out.__notion = sanitizeNotionCredentialMetadata(rawProperties);
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
  const uploadIds = new Set<string>();

  for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
    const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
    const notionPropId = optionalString(prop.id) ?? nameOrId;
    const localPropId = propertyMappings.get(notionPropId) ?? propertyMappings.get(nameOrId);
    if (!localPropId) continue;
    const references = notionFilePropertyReferences(rawValue);
    if (references.length === 0) continue;
    const copied: unknown[] = [];
    for (const [index, reference] of references.entries()) {
      const stored = await copyNotionFileReference(context, {
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
        notionFileRole: 'row_property_file',
        notionFileStructuralPath: `page:${item.notionId}/property:${notionPropId}`,
        notionFileOrdinal: index,
      }, reference);
      copied.push(stored);
      storedUploadIds(stored, uploadIds);
    }
    properties[localPropId] = copied;
    changed = true;
  }

  if (!changed) return page;
  await transactImportedFileOwner(
    context,
    { table: 'pages', op: 'update', id: page.id, data: { properties } },
    Array.from(uploadIds),
    { pageId: page.id },
  );
  const updated = await getExisting(context.db.table<Page>('pages'), page.id) ?? { ...page, properties };
  if (context.blockRecoveryPage?.id === page.id) context.blockRecoveryPage = updated;
  return updated;
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
    const notionPropId = optionalString(prop.id) ?? nameOrId;
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
  const uploadIds = new Set<string>();
  const chrome = importedPageChromeFromItem(item);

  const iconReference = chrome.iconReference;
  if (iconReference) {
    const copied = await copyNotionFileReference(context, {
      notionId: item.notionId,
      notionObject: 'page',
      label: `page icon on "${item.title || item.notionId}"`,
      scope: 'icons',
      pageId: page.id,
      notionPageId: item.notionId,
      notionPageFileKind: 'icon',
      notionFileRole: 'page_chrome_icon',
      notionFileStructuralPath: `${item.notionObject}:${item.notionId}/chrome`,
      notionFileOrdinal: 0,
    }, iconReference);
    if (copied !== iconReference) {
      storedUploadIds(copied, uploadIds);
      patch.icon = copied.url;
      patch.iconType = 'image';
      properties[NOTION_PAGE_ICON_REFERENCE_KEY] = copied;
      propertiesChanged = true;
    }
  }

  const coverReference = chrome.coverReference;
  if (coverReference) {
    const copied = await copyNotionFileReference(context, {
      notionId: item.notionId,
      notionObject: 'page',
      label: `page cover on "${item.title || item.notionId}"`,
      scope: 'covers',
      pageId: page.id,
      notionPageId: item.notionId,
      notionPageFileKind: 'cover',
      notionFileRole: 'page_chrome_cover',
      notionFileStructuralPath: `${item.notionObject}:${item.notionId}/chrome`,
      notionFileOrdinal: 0,
    }, coverReference);
    if (copied !== coverReference) {
      storedUploadIds(copied, uploadIds);
      patch.cover = copied.url;
      patch.coverPosition = chrome.coverPosition ?? 50;
      properties[NOTION_PAGE_COVER_REFERENCE_KEY] = copied;
      propertiesChanged = true;
    }
  }

  if (!propertiesChanged && Object.keys(patch).length === 0) return page;
  const data = { ...patch, ...(propertiesChanged ? { properties } : {}) };
  await transactImportedFileOwner(
    context,
    { table: 'pages', op: 'update', id: page.id, data },
    Array.from(uploadIds),
    { pageId: page.id },
  );
  const updated = await getExisting(context.db.table<Page>('pages'), page.id) ?? { ...page, ...data };
  if (context.blockRecoveryPage?.id === page.id) context.blockRecoveryPage = updated;
  return updated;
}

function notionTemplateIconReference(template: Record<string, unknown>, fallbackName: string) {
  const raw = template.icon;
  const record = asRecord(raw);
  if (record) return notionFileReference(record, fallbackName);
  const url = optionalString(raw);
  if (!url || !/^https?:\/\//i.test(url) && !/^data:/i.test(url)) return undefined;
  return notionFileReference({ url, name: fallbackName }, fallbackName);
}

interface ImportedTemplateFileSlot {
  label: string;
  owner: unknown;
  scope: NotionFileCopyTarget['scope'];
  propertyId?: string;
}

interface ImportedTemplateOwnerLocator {
  uploadId?: string;
  bucket?: string;
  key?: string;
  url?: string;
  hasStoredMarker: boolean;
}

function importedTemplateOwnerLocator(value: unknown, allowUrlOnly = false): ImportedTemplateOwnerLocator {
  if (typeof value === 'string') {
    const url = value.trim();
    return {
      url: url || undefined,
      hasStoredMarker: !!url && !!absoluteStorageRoute(url),
    };
  }
  const record = asRecord(value);
  if (!record) return { hasStoredMarker: false };
  const uploadId = optionalString(record.uploadId) ?? optionalString(record.fileUploadId);
  const key = optionalString(record.key) ?? optionalString(record.fileKey);
  const url = optionalString(record.url);
  const bucket = optionalString(record.bucket) ?? optionalString(record.fileBucket);
  return {
    uploadId,
    bucket,
    key,
    url: allowUrlOnly || uploadId || key ? url : undefined,
    hasStoredMarker:
      !!uploadId
      || !!key?.startsWith('workspaces/')
      || record.notionFileCopied === true
      || (!!url && !!absoluteStorageRoute(url)),
  };
}

function collectImportedTemplateOwnerLocators(
  value: unknown,
  out = new Map<string, ImportedTemplateOwnerLocator>(),
  seen = new Set<object>(),
  depth = 0,
): Map<string, ImportedTemplateOwnerLocator> {
  if (value === null || value === undefined || depth > 32) return out;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && (trimmed.startsWith('workspaces/') || absoluteStorageRoute(trimmed))) {
      out.set(`url:${trimmed}`, { url: trimmed, hasStoredMarker: true });
    }
    return out;
  }
  if (typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectImportedTemplateOwnerLocators(item, out, seen, depth + 1);
    seen.delete(value);
    return out;
  }
  const record = value as Record<string, unknown>;
  const locator = importedTemplateOwnerLocator(record, true);
  if (locator.hasStoredMarker) {
    const signature = locator.uploadId
      ? `id:${locator.uploadId}`
      : locator.key
        ? `key:${locator.key}`
        : `url:${locator.url ?? ''}`;
    out.set(signature, locator);
    seen.delete(value);
    return out;
  }
  for (const item of Object.values(record)) {
    collectImportedTemplateOwnerLocators(item, out, seen, depth + 1);
  }
  seen.delete(value);
  return out;
}

function collectImportedTemplateBlockFileSlots(
  rawBlocks: Record<string, unknown>[],
  localBlocks: TemplateBlock[],
  label: string,
  out: ImportedTemplateFileSlot[],
) {
  if (rawBlocks.length !== localBlocks.length) {
    throw Object.assign(
      new Error(`Notion import cannot safely align stored file blocks in ${label}.`),
      { code: 409 },
    );
  }
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const rawBlock = rawBlocks[index]!;
    const localBlock = localBlocks[index]!;
    if (fileReferenceFromNotionBlock(rawBlock)) {
      out.push({
        label: `${label} block ${index + 1}`,
        owner: localBlock.content,
        scope: fileCopyScopeForBlockType(localBlock.type),
      });
    }
    const rawChildren = templateBlockChildren(rawBlock);
    const localChildren = localBlock.children ?? [];
    collectImportedTemplateBlockFileSlots(
      rawChildren,
      localChildren,
      `${label} block ${index + 1}`,
      out,
    );
    if (rawBlock.type === 'template') {
      const buttonTemplate = localBlock.content?.buttonTemplate;
      if (!Array.isArray(buttonTemplate) || !jsonEquivalent(buttonTemplate, localChildren)) {
        throw Object.assign(
          new Error(`Notion import found inconsistent template-button file owners in ${label}.`),
          { code: 409 },
        );
      }
    }
  }
}

function importedTemplateFileSlots(
  template: DbTemplate,
  rawTemplate: Record<string, unknown>,
  propertyMappings: Map<string, string>,
) {
  const slots: ImportedTemplateFileSlot[] = [];
  const iconReference = notionTemplateIconReference(rawTemplate, `${template.name} icon`);
  if (iconReference) {
    slots.push({
      label: `icon on database template "${template.name}"`,
      owner: template.icon,
      scope: 'icons',
    });
  }
  const rawProperties = templatePropertiesFromNotion(rawTemplate);
  for (const [nameOrId, rawValue] of Object.entries(rawProperties ?? {})) {
    const property = asRecord(rawValue) ?? {};
    const notionPropertyId = optionalString(property.id) ?? nameOrId;
    const references = notionFilePropertyReferences(rawValue);
    if (references.length === 0) continue;
    const localPropertyId = propertyMappings.get(notionPropertyId) ?? propertyMappings.get(nameOrId);
    if (!localPropertyId) {
      throw Object.assign(
        new Error(
          `Notion import cannot validate files from template property "${nameOrId}" because its local property mapping is missing.`,
        ),
        { code: 409 },
      );
    }
    const owners = template.properties?.[localPropertyId];
    if (!Array.isArray(owners) || owners.length !== references.length) {
      throw Object.assign(
        new Error(`Notion import found inconsistent file values in template property "${nameOrId}".`),
        { code: 409 },
      );
    }
    for (let index = 0; index < references.length; index += 1) {
      slots.push({
        label: `file ${index + 1} in template property "${nameOrId}"`,
        owner: owners[index],
        scope: 'database/files',
        propertyId: localPropertyId,
      });
    }
  }
  collectImportedTemplateBlockFileSlots(
    rawTemplateBlocks(rawTemplate),
    template.blocks ?? [],
    `database template "${template.name}"`,
    slots,
  );
  return slots;
}

function importedTemplateUploadIsComplete(upload: FileUpload) {
  return upload.status === 'uploaded'
    && typeof upload.completedAt === 'string'
    && Number.isFinite(Date.parse(upload.completedAt));
}

async function uploadsMatchingImportedTemplateLocator(
  db: DbRef,
  locator: ImportedTemplateOwnerLocator,
) {
  const uploads = db.table<FileUpload>('file_uploads');
  if (locator.uploadId) {
    const upload = await getExisting(uploads, locator.uploadId);
    return upload ? [upload] : [];
  }
  if (locator.key) {
    return listAll(uploads.where('key', '==', locator.key), 2);
  }
  if (locator.url) {
    return listAll(uploads.where('url', '==', locator.url), 2);
  }
  return [];
}

function importedTemplateUploadMatchesSlot(
  context: NotionFileCopyContext,
  template: DbTemplate,
  slot: ImportedTemplateFileSlot,
  locator: ImportedTemplateOwnerLocator,
  upload: FileUpload,
) {
  return importedTemplateUploadIsComplete(upload)
    && upload.workspaceId === context.job.workspaceId
    && upload.templateId === template.id
    && upload.databaseId === template.databaseId
    && upload.scope === slot.scope
    && !upload.pageId
    && !upload.blockId
    && (slot.propertyId ? upload.propertyId === slot.propertyId : !upload.propertyId)
    && (!locator.uploadId || upload.id === locator.uploadId)
    && (!locator.bucket || upload.bucket === locator.bucket)
    && (!locator.key || upload.key === locator.key)
    && (!locator.url || upload.url === locator.url);
}

function retryableNotionTemplateCleanupError(message: string) {
  return Object.assign(new Error(message), {
    code: 409,
    notionImportRecoveryPending: true,
  });
}

function isRetryableNotionTemplateCleanupError(error: unknown) {
  return !!error
    && typeof error === 'object'
    && (error as { notionImportRecoveryPending?: unknown }).notionImportRecoveryPending === true;
}

async function cleanupUnownedImportedTemplateUploads(
  context: NotionFileCopyContext,
  uploads: FileUpload[],
) {
  if (uploads.length === 0) return;
  const workspace = await getExisting(context.db.table<Workspace>('workspaces'), context.job.workspaceId);
  if (!workspace) throw new Error('workspace was not found');
  for (const upload of uploads) {
    if (upload.status === 'deleted' || upload.status === 'expired') continue;
    try {
      let cleanupCompleted = false;
      await withFileWorkspaceLease(
        context.db,
        context.job.workspaceId,
        context.actorId,
        'notion-template-unowned-upload-cleanup',
        async (lease) => {
          await lease.assertOwned();
          const uploadTable = context.db.table<FileUpload>('file_uploads');
          const current = await getExisting(uploadTable, upload.id);
          if (!current || current.status === 'deleted' || current.status === 'expired') return;
          if (!['uploaded', 'pending', 'preparing', 'deleting'].includes(current.status)) return;

          const template = current.templateId
            ? await getExisting(context.db.table<DbTemplate>('db_templates'), current.templateId)
            : undefined;
          if (template) {
            const locators = collectImportedTemplateOwnerLocators({
              icon: template.icon,
              properties: template.properties,
              blocks: template.blocks,
            });
            const stillOwned = Array.from(locators.values()).some((locator) => (
              (!!locator.uploadId && locator.uploadId === current.id)
              || (!!locator.key && locator.key === current.key)
              || (!!locator.url && locator.url === current.url)
            ));
            // The template may have gained this file after the stale snapshot
            // classified it as unowned. The file lease serializes normal owner
            // commits; re-reading here prevents cleanup from deleting it.
            if (stillOwned) return;
          }

          const claimedAt = nowIso();
          const previousStatus = current.status === 'deleting'
            ? current.deletionPreviousStatus ?? (current.completedAt ? 'uploaded' : 'pending')
            : current.status;
          const claimOperations: TransactOperation[] = [];
          if (context.applyLease && context.itemSnapshotRevision) {
            claimOperations.push(
              {
                table: 'notion_import_jobs', op: 'expect', id: context.job.id,
                where: [['status', '==', 'ready'], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
                exists: true,
              },
              {
                table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
                where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
                exists: true,
              },
            );
          }
          claimOperations.push(
            {
              table: 'file_uploads', op: 'expect', id: current.id,
              where: [
                ['status', '==', current.status],
                ['updatedAt', '==', current.updatedAt ?? null],
                ['pageId', '==', current.pageId ?? null],
                ['blockId', '==', current.blockId ?? null],
                ['databaseId', '==', current.databaseId ?? null],
                ['propertyId', '==', current.propertyId ?? null],
                ['templateId', '==', current.templateId ?? null],
                ['notionImportSlotKey', '==', current.notionImportSlotKey ?? null],
              ],
              exists: true,
            },
            {
              table: 'file_uploads', op: 'update', id: current.id,
              data: {
                status: 'deleting',
                deletionPreviousStatus: previousStatus,
                expiresAt: claimedAt,
                deletedBy: context.actorId,
                updatedAt: claimedAt,
              },
            },
          );
          await context.db.transact(claimOperations);

          const proxy = storageBucket(context.storage, current.bucket || FILE_BUCKET);
          if (!proxy) {
            throw new Error('EdgeBase storage is unavailable.');
          }
          await proxy.delete(current.key);
          await lease.assertOwned();
          if (workspace.organizationId) {
            await releaseOrganizationStorage(context.admin, {
              id: current.id,
              organizationId: workspace.organizationId,
              workspaceId: workspace.id,
              bytes: current.size,
            });
          }
          await lease.assertOwned();

          const cleanupAt = nowIso();
          const finishOperations: TransactOperation[] = [];
          if (context.applyLease && context.itemSnapshotRevision) {
            finishOperations.push(
              {
                table: 'notion_import_jobs', op: 'expect', id: context.job.id,
                where: [['status', '==', 'ready'], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
                exists: true,
              },
              {
                table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
                where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
                exists: true,
              },
            );
          }
          finishOperations.push(
            {
              table: 'file_uploads', op: 'expect', id: current.id,
              where: [
                ['status', '==', 'deleting'],
                ['updatedAt', '==', claimedAt],
                ['pageId', '==', current.pageId ?? null],
                ['blockId', '==', current.blockId ?? null],
                ['databaseId', '==', current.databaseId ?? null],
                ['propertyId', '==', current.propertyId ?? null],
                ['templateId', '==', current.templateId ?? null],
                ['notionImportSlotKey', '==', current.notionImportSlotKey ?? null],
              ],
              exists: true,
            },
            {
              table: 'file_uploads', op: 'update', id: current.id,
              data: {
                status: 'expired',
                ...(current.notionImportSlotKey
                  ? { notionImportSlotKey: null as unknown as string }
                  : {}),
                expiresAt: cleanupAt,
                expiredAt: cleanupAt,
                deletedAt: cleanupAt,
                deletedBy: context.actorId,
                ...(current.notionImportSlotKey ? {
                  notionImportTerminalSweepAfter: new Date(
                    Date.now() + NOTION_FILE_TERMINAL_RESWEEP_DELAY_MS,
                  ).toISOString(),
                  notionImportTerminalSweepCompletedAt: null,
                } : {}),
                updatedAt: cleanupAt,
              },
            },
          );
          await context.db.transact(finishOperations);
          cleanupCompleted = true;
        },
      );
      if (cleanupCompleted && upload.notionImportSlotKey) {
        context.checkpointUploadsBySlotKey?.delete(upload.notionImportSlotKey);
      }
    } catch (error) {
      throw retryableNotionTemplateCleanupError(
        `Notion template file cleanup is pending for upload ${upload.id}. Retry apply after maintenance completes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function existingImportedTemplateFileState(
  context: NotionFileCopyContext,
  template: DbTemplate,
  rawTemplate: Record<string, unknown>,
  propertyMappings: Map<string, string>,
) {
  const slots = importedTemplateFileSlots(template, rawTemplate, propertyMappings);
  const associatedUploads = await listAll(
    context.db.table<FileUpload>('file_uploads').where('templateId', '==', template.id),
    NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  );
  const activeAssociatedUploads = associatedUploads.filter((upload) =>
    upload.status !== 'deleted' && upload.status !== 'expired');
  const matchedUploadIds = new Set<string>();
  let allSlotsComplete = true;
  const ownerLocators = collectImportedTemplateOwnerLocators({
    icon: template.icon,
    properties: template.properties,
    blocks: template.blocks,
  });

  for (const slot of slots) {
    const locator = importedTemplateOwnerLocator(slot.owner, slot.scope === 'icons');
    const candidates = await uploadsMatchingImportedTemplateLocator(context.db, locator);
    const matching = candidates.filter((upload) =>
      importedTemplateUploadMatchesSlot(context, template, slot, locator, upload));
    if (matching.length !== 1 || matchedUploadIds.has(matching[0]!.id)) {
      allSlotsComplete = false;
      continue;
    }
    matchedUploadIds.add(matching[0]!.id);
  }

  const durableOwnerUploadIds = new Set<string>();
  let durableOwnerLocatorsValid = true;
  for (const locator of ownerLocators.values()) {
    const candidates = await uploadsMatchingImportedTemplateLocator(context.db, locator);
    const matching = candidates.filter((upload) =>
      importedTemplateUploadIsComplete(upload)
      && upload.workspaceId === context.job.workspaceId
      && upload.templateId === template.id
      && upload.databaseId === template.databaseId
      && (!locator.uploadId || upload.id === locator.uploadId)
      && (!locator.bucket || upload.bucket === locator.bucket)
      && (!locator.key || upload.key === locator.key)
      && (!locator.url || upload.url === locator.url));
    if (matching.length !== 1) {
      durableOwnerLocatorsValid = false;
      continue;
    }
    durableOwnerUploadIds.add(matching[0]!.id);
  }

  const unownedActiveUploads = activeAssociatedUploads.filter((upload) => (
    !matchedUploadIds.has(upload.id) && !durableOwnerUploadIds.has(upload.id)
  ));
  const ownerSetMatchesSlots = durableOwnerLocatorsValid
    && Array.from(matchedUploadIds).every((id) => durableOwnerUploadIds.has(id));
  if (allSlotsComplete && matchedUploadIds.size === slots.length && ownerSetMatchesSlots) {
    await cleanupUnownedImportedTemplateUploads(context, unownedActiveUploads);
    return 'complete' as const;
  }

  // The supported interruption state leaves the old source-only owner intact:
  // all copies happen before the single template update. Retire any unowned
  // partial uploads, then perform one clean migration. A mixture of durable
  // stored markers and missing/mismatched rows is corruption and must not be
  // papered over with another full copy that would orphan valid objects.
  if (ownerLocators.size === 0 && matchedUploadIds.size === 0) {
    const durableCheckpoints = activeAssociatedUploads.filter((upload) => (
      upload.notionImportJobId === context.job.id
      && upload.notionImportSnapshotRevision === context.itemSnapshotRevision
      && !!upload.notionImportSlotKey
    ));
    // The pre-copy phase intentionally leaves the source-only template owner
    // unchanged until its single owner transaction. Let the slot recovery path
    // HEAD/finalize or safely retire these rows; the legacy cleanup routine
    // cannot distinguish a still-running put from an abandoned upload.
    if (context.requireFileCopyCheckpoint && durableCheckpoints.length > 0) {
      return 'source_only' as const;
    }
    await cleanupUnownedImportedTemplateUploads(context, activeAssociatedUploads);
    return 'source_only' as const;
  }

  throw Object.assign(
    new Error(
      `Notion import found a partial or contradictory stored-file owner graph for database template "${template.name}". ` +
        'No files were recopied; repair or remove the inconsistent template owner before retrying.',
    ),
    { code: 409 },
  );
}

async function copyImportedEmbeddedTemplateBlockFiles(
  context: NotionFileCopyContext,
  rawBlocks: Record<string, unknown>[],
  localBlocks: TemplateBlock[],
  target: Pick<NotionFileCopyTarget, 'pageId' | 'blockId' | 'databaseId' | 'templateId' | 'notionPageId'> & {
    notionId: string;
    notionObject: string;
    label: string;
  },
  deferredBlockUploadIds?: string[],
  structuralPath = 'blocks',
  fileRole = 'template_block_file',
): Promise<TemplateBlock[]> {
  if (rawBlocks.length !== localBlocks.length) {
    throw new Error(`Notion import cannot safely align file blocks in ${target.label}.`);
  }
  const out: TemplateBlock[] = [];
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const rawBlock = rawBlocks[index]!;
    const localBlock = { ...localBlocks[index]! };
    const blockPath = `${structuralPath}/${index}`;
    const reference = fileReferenceFromNotionBlock(rawBlock);
    if (reference) {
      const notionBlockId = notionObjectId(rawBlock);
      const copied = await copyNotionFileReference(context, {
        ...target,
        notionId: notionBlockId ?? target.notionId,
        label: `file block in ${target.label}`,
        scope: fileCopyScopeForBlockType(localBlock.type),
        notionBlockId,
        notionFileRole: fileRole,
        notionFileStructuralPath: blockPath,
        notionFileOrdinal: 0,
      }, reference);
      localBlock.content = contentWithStoredNotionFile(localBlock.content, copied);
      if (deferredBlockUploadIds && copied.uploadId) {
        deferredBlockUploadIds.push(copied.uploadId);
      }
    }
    const rawChildren = templateBlockChildren(rawBlock);
    const localChildren = localBlock.children ?? [];
    let copiedChildren = localChildren;
    if (rawChildren.length > 0 || localChildren.length > 0) {
      copiedChildren = await copyImportedEmbeddedTemplateBlockFiles(
        context,
        rawChildren,
        localChildren,
        target,
        deferredBlockUploadIds,
        `${blockPath}/children`,
        fileRole,
      );
      localBlock.children = copiedChildren;
    }
    if (Array.isArray(localBlock.content?.buttonTemplate)) {
      // localBlockFromNotion represents Notion template-button children both
      // structurally and in buttonTemplate. Point both views at the copied
      // graph so the shadow source URLs are not retained or copied twice.
      localBlock.content = {
        ...localBlock.content,
        buttonTemplate: copiedChildren,
      };
    }
    out.push(localBlock);
  }
  return out;
}

function countImportedEmbeddedTemplateBlockFiles(
  rawBlocks: Record<string, unknown>[],
  localBlocks: TemplateBlock[],
  label: string,
): number {
  if (rawBlocks.length !== localBlocks.length) {
    throw new Error(`Notion import cannot safely align file blocks in ${label}.`);
  }
  let count = 0;
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const rawBlock = rawBlocks[index]!;
    const localBlock = localBlocks[index]!;
    if (fileReferenceFromNotionBlock(rawBlock)) count += 1;
    const rawChildren = templateBlockChildren(rawBlock);
    const localChildren = localBlock.children ?? [];
    if (rawChildren.length > 0 || localChildren.length > 0) {
      count += countImportedEmbeddedTemplateBlockFiles(rawChildren, localChildren, label);
    }
  }
  return count;
}

function assertImportedFileOwnerTransactionCapacity(
  fileCount: number,
  ownerLabel: string,
  companionOperationCount = 0,
) {
  // Each copied upload needs one ownership expectation plus one association
  // update, the owner block itself needs one insert, and pre-copied files add
  // immutable job-revision plus apply-lease fences. Check the complete raw
  // graph before the first network fetch/object write/quota reservation so a
  // request that can never fit one atomic commit has zero storage side effects.
  if (fileCount * 2 + 3 + companionOperationCount > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(new Error(`${ownerLabel} contains too many stored files.`), { code: 413 });
  }
}

function assertImportedBlockFileTransactionCapacity(fileCount: number) {
  assertImportedFileOwnerTransactionCapacity(fileCount, 'Imported block');
}

async function copyImportedTemplateFiles(
  context: NotionFileCopyContext,
  template: DbTemplate,
  rawTemplate: Record<string, unknown>,
  propertyMappings: Map<string, string>,
  item: NotionImportItem,
  templateStructuralPath: string,
) {
  const notionTemplateId = notionObjectId(rawTemplate) ?? item.notionId;
  let icon = template.icon;
  const iconReference = notionTemplateIconReference(rawTemplate, `${template.name} icon`);
  if (iconReference) {
    const copied = await copyNotionFileReference(context, {
      notionId: notionTemplateId,
      notionObject: 'template',
      label: `icon on database template "${template.name}"`,
      scope: 'icons',
      databaseId: template.databaseId,
      templateId: template.id,
      notionPageId: notionObjectId(rawTemplate),
      notionPageFileKind: 'icon',
      notionFileRole: 'template_icon',
      notionFileStructuralPath: templateStructuralPath,
      notionFileOrdinal: 0,
    }, iconReference);
    icon = copied.url;
  }

  const properties = template.properties ? { ...template.properties } : {};
  const rawProperties = templatePropertiesFromNotion(rawTemplate);
  for (const [nameOrId, rawValue] of Object.entries(rawProperties ?? {})) {
    const property = asRecord(rawValue) ?? {};
    const notionPropertyId = optionalString(property.id) ?? nameOrId;
    const references = notionFilePropertyReferences(rawValue);
    if (references.length === 0) continue;
    const localPropertyId = propertyMappings.get(notionPropertyId) ?? propertyMappings.get(nameOrId);
    if (!localPropertyId) {
      throw new Error(
        `Notion import cannot safely attach files from template property "${nameOrId}" because its local property mapping is missing.`,
      );
    }
    const copied: NotionFileReference[] = [];
    for (const [index, reference] of references.entries()) {
      copied.push(await copyNotionFileReference(context, {
        notionId: notionTemplateId,
        notionObject: 'template',
        label: `file property "${nameOrId}" on database template "${template.name}"`,
        scope: 'database/files',
        databaseId: template.databaseId,
        propertyId: localPropertyId,
        templateId: template.id,
        notionPropertyId,
        notionPropertyName: nameOrId,
        notionFileIndex: index,
        notionFileName: reference.name,
        notionPageId: notionObjectId(rawTemplate),
        notionFileRole: 'template_property_file',
        notionFileStructuralPath: `${templateStructuralPath}/property:${notionPropertyId}`,
        notionFileOrdinal: index,
      }, reference));
    }
    properties[localPropertyId] = copied;
  }

  const blocks = await copyImportedEmbeddedTemplateBlockFiles(
    context,
    rawTemplateBlocks(rawTemplate),
    template.blocks ?? [],
    {
      notionId: notionTemplateId,
      notionObject: 'template_block',
      label: `database template "${template.name}"`,
      databaseId: template.databaseId,
      templateId: template.id,
      notionPageId: notionObjectId(rawTemplate),
    },
    undefined,
    `${templateStructuralPath}/blocks`,
    'template_block_file',
  );
  return {
    ...template,
    icon,
    properties: Object.keys(properties).length ? properties : undefined,
    blocks,
  };
}

async function insertImportedTemplateWithFiles(
  context: NotionFileCopyContext,
  template: DbTemplate,
  mappingCommit?: {
    mappingsByNotionId: Map<string, NotionImportMapping>;
      input: Omit<NotionImportMappingInput, 'localId'>;
    },
  uniqueWhere?: Array<[string, '==', unknown]>,
) {
  const uploadIds = storedUploadIds({
    icon: template.icon,
    properties: template.properties,
    blocks: template.blocks,
  });
  for (const [uploadId, target] of context.pendingCheckpointTargets ?? []) {
    if (target.templateId === template.id && target.databaseId === template.databaseId) {
      uploadIds.add(uploadId);
    }
  }
  const mapping = mappingCommit
    ? notionImportMappingRow(context.job, { ...mappingCommit.input, localId: template.id })
    : undefined;
  const preOwnerOperations: TransactOperation[] = [
    ...(uniqueWhere?.length
      ? [{ table: 'db_templates', op: 'expect' as const, where: uniqueWhere, exists: false }]
      : []),
    ...(mapping
      ? [
          {
            table: 'notion_import_mappings',
            op: 'expect' as const,
            where: [['mappingKey', '==', mapping.mappingKey]] as Array<[string, '==', unknown]>,
            exists: false,
          },
        ]
      : []),
  ];
  const companionOperations: TransactOperation[] = mapping
    ? [{
        table: 'notion_import_mappings',
        op: 'insert',
        data: mapping as unknown as Record<string, unknown>,
      }]
    : [];
  try {
    await transactImportedFileOwner(
      context,
      { table: 'db_templates', op: 'insert', data: template as unknown as Record<string, unknown> },
      Array.from(uploadIds),
      { databaseId: template.databaseId, templateId: template.id },
      companionOperations,
      preOwnerOperations,
    );
  } catch (error) {
    if (isRetryableNotionTemplateCleanupError(error)) throw error;
    if (!isApplyLeaseConflict(error)) throw error;
    throw Object.assign(
      new Error('Notion import template owner changed concurrently before publication.'),
      { code: 409, notionImportRecoveryPending: true, cause: error },
    );
  }
  if (mapping && mappingCommit) {
    mappingCommit.mappingsByNotionId.set(mapping.notionId, mapping);
  }
  return await getExisting(context.db.table<DbTemplate>('db_templates'), template.id) ?? template;
}

async function updateImportedTemplateWithFiles(
  context: NotionFileCopyContext,
  template: DbTemplate,
  patch: Partial<DbTemplate>,
) {
  const next = { ...template, ...patch };
  const uploadIds = storedUploadIds({
    icon: next.icon,
    properties: next.properties,
    blocks: next.blocks,
  });
  for (const [uploadId, target] of context.pendingCheckpointTargets ?? []) {
    if (target.templateId === template.id && target.databaseId === template.databaseId) {
      uploadIds.add(uploadId);
    }
  }
  await transactImportedFileOwner(
    context,
    { table: 'db_templates', op: 'update', id: template.id, data: patch as Record<string, unknown> },
    Array.from(uploadIds),
    { databaseId: template.databaseId, templateId: template.id },
  );
  return await getExisting(context.db.table<DbTemplate>('db_templates'), template.id) ?? next;
}

interface ImportedBlockOwnerContext {
  pageNotionId: string;
  blockNotionId: string;
  blockType?: string;
  parentBlockNotionId?: string | null;
  position?: number;
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
  applyContext: NotionFileCopyContext,
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
    const updated = await transactImportedOwnerPatch(applyContext, {
      table: 'db_properties',
      owner: context.property,
      patch: { config },
      requiredWhere: [
        ['databaseId', '==', context.property.databaseId],
        ['notionImportJobId', '==', applyContext.job.id],
        ['notionDataSourceId', '==', context.dataSourceId],
        ['notionPropertyId', '==', context.notionPropertyId],
      ],
      extraExpectations: [{
        table: 'pages', op: 'expect', id: context.property.databaseId,
        where: [
          ['workspaceId', '==', applyContext.job.workspaceId],
          ['kind', '==', 'database'],
          ['notionImportJobId', '==', applyContext.job.id],
          ['notionImportSourceId', '==', context.dataSourceId],
          ['notionImportSourceKind', '==', 'data_source'],
        ],
        exists: true,
      }],
      label: 'database property remap',
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
    return { value, changed: false, remapped: 0, observedRemapped: 0, unresolved: [] as string[] };
  }

  let changed = false;
  let remapped = 0;
  let observedRemapped = 0;
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
    // Keep immutable Notion target ids on the span and observe their durable
    // local mapping even after the product patch already committed. This lets
    // a retry rebuild conversion counts when only the commit response was
    // lost, while `remapped` continues to describe actual content changes.
    observedRemapped += 1;
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
    observedRemapped,
    unresolved: Array.from(new Set(unresolved)),
  };
}

function remapImportedRichTextMentionsInContent(
  content: Record<string, unknown> | undefined,
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  if (!content) {
    return {
      content,
      changed: false,
      remapped: 0,
      observedRemapped: 0,
      unresolved: [] as string[],
    };
  }
  const next = { ...content };
  let changed = false;
  let remapped = 0;
  let observedRemapped = 0;
  const unresolved: string[] = [];
  for (const key of ['rich', 'caption']) {
    const result = remapImportedRichTextMentionSpans(next[key], mappingsByNotionId);
    if (result.changed) {
      next[key] = result.value;
      changed = true;
    }
    remapped += result.remapped;
    observedRemapped += result.observedRemapped;
    unresolved.push(...result.unresolved);
  }
  return {
    content: changed ? next : content,
    changed,
    remapped,
    observedRemapped,
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
  observedRemapped: number;
  unresolved: string[];
} {
  if (!Array.isArray(blocks)) {
    return {
      blocks,
      changed: false,
      remapped: 0,
      observedRemapped: 0,
      unresolved: [] as string[],
    };
  }
  let changed = false;
  let remapped = 0;
  let observedRemapped = 0;
  const unresolved: string[] = [];
  const nextBlocks = blocks.map((block) => {
    const contentResult = remapImportedRichTextMentionsInContent(block.content, mappingsByNotionId);
    const childResult = remapImportedTemplateBlocksRichTextMentions(block.children, mappingsByNotionId);
    remapped += contentResult.remapped + childResult.remapped;
    observedRemapped += contentResult.observedRemapped + childResult.observedRemapped;
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
    observedRemapped,
    unresolved: Array.from(new Set(unresolved)),
  };
}

function reportRichTextMentionRemap(
  report: ImportConversionReport | undefined,
  notionId: string | undefined,
  notionObject: string,
  label: string,
  result: { remapped: number; observedRemapped?: number; unresolved: string[] },
  options: { reportUnresolved?: boolean } = {},
) {
  if (!report) return;
  const observedRemapped = result.observedRemapped ?? result.remapped;
  if (observedRemapped > 0) incrementReport(report, 'remappedRichTextMentions', observedRemapped);
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
  applyContext: NotionFileCopyContext,
  pages: ImportedPageBlockContext[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
) {
  const { db } = applyContext;
  let updatedBlocks = 0;

  for (const context of pages) {
    const blocks = await listAll(
      db.table<Block>('blocks').where('pageId', '==', context.page.id),
      NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    );
    for (const block of blocks) {
      const result = remapImportedRichTextMentionsInContent(block.content, mappingsByNotionId);
      const buttonTemplateRemap = remapImportedTemplateBlocksRichTextMentions(
        block.content?.buttonTemplate as TemplateBlock[] | undefined,
        mappingsByNotionId,
      );
      if (result.changed || buttonTemplateRemap.changed) {
        await transactImportedOwnerPatch(applyContext, {
          table: 'blocks',
          owner: block,
          patch: { content: {
            ...((result.content ?? block.content) ?? {}),
            ...(buttonTemplateRemap.changed ? { buttonTemplate: buttonTemplateRemap.blocks } : {}),
          } },
          requiredWhere: [['pageId', '==', context.page.id]],
          extraExpectations: [{
            table: 'pages', op: 'expect', id: context.page.id,
            where: [
              ['workspaceId', '==', applyContext.job.workspaceId],
              ['kind', '==', 'page'],
              ['notionImportJobId', '==', applyContext.job.id],
              ['notionImportSourceId', '==', context.notionId],
              ['notionImportSourceKind', '==', 'page'],
            ],
            exists: true,
          }],
          label: 'block rich-text remap',
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
  applyContext: NotionFileCopyContext,
  pages: ImportedPageBlockContext[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
) {
  const { db } = applyContext;
  const linkBlockTypes = new Set(['inline_database', 'child_database', 'child_page', 'link_to_page']);
  const pageTable = db.table<Page>('pages');
  const pageCache = new Map<string, Page | null>();
  let updatedBlocks = 0;
  let remappedTargets = 0;
  let mappedBlocks = 0;
  let unresolvedTargets = 0;

  const linkedPageSnapshot = async (localPageId: string) => {
    if (!pageCache.has(localPageId)) {
      pageCache.set(localPageId, await getExisting(pageTable, localPageId));
    }
    return pageCache.get(localPageId) ?? null;
  };

  for (const context of pages) {
    const blocks = await listAll(
      db.table<Block>('blocks').where('pageId', '==', context.page.id),
      NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    );
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

      mappedBlocks += 1;
      remappedTargets += 1;
      if (jsonEquivalent(nextContent, block.content)) continue;
      await transactImportedOwnerPatch(applyContext, {
        table: 'blocks',
        owner: block,
        patch: { content: nextContent },
        requiredWhere: [['pageId', '==', context.page.id]],
        extraExpectations: [{
          table: 'pages', op: 'expect', id: context.page.id,
          where: [
            ['workspaceId', '==', applyContext.job.workspaceId],
            ['kind', '==', 'page'],
            ['notionImportJobId', '==', applyContext.job.id],
            ['notionImportSourceId', '==', context.notionId],
            ['notionImportSourceKind', '==', 'page'],
          ],
          exists: true,
        }],
        label: 'linked block remap',
      });
      updatedBlocks += 1;
    }
  }

  if (conversionReport) {
    if (remappedTargets > 0) incrementReport(conversionReport, 'remappedLinkedTargets', remappedTargets);
    if (unresolvedTargets > 0) incrementReport(conversionReport, 'unresolvedLinkedTargets', unresolvedTargets);
  }

  return { updatedBlocks, mappedBlocks, remappedTargets, unresolvedTargets };
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
  applyContext: NotionFileCopyContext,
  pages: ImportedPageBlockContext[],
  blockMappingsByNotionId: Map<string, ImportedBlockMapping>,
  conversionReport?: ImportConversionReport,
  resolveMissingSource?: (notionBlockId: string) => Promise<ImportedBlockMapping | undefined>,
) {
  const { db } = applyContext;
  let remapped = 0;
  let observedRemapped = 0;
  let unresolved = 0;

  for (const context of pages) {
    const blocks = await listAll(
      db.table<Block>('blocks').where('pageId', '==', context.page.id),
      NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    );
    for (const block of blocks) {
      if (block.type !== 'synced_block') continue;
      const sourceNotionId = syncedBlockSourceNotionId(block);
      if (!sourceNotionId) continue;
      const source = blockMappingsByNotionId.get(sourceNotionId) ??
        await resolveMissingSource?.(sourceNotionId);
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

      const content = asRecord(block.content) ?? {};
      observedRemapped += 1;
      if (content.syncedBlockId === source.localId && content.syncedPageId === source.pageId) continue;
      await transactImportedOwnerPatch(applyContext, {
        table: 'blocks',
        owner: block,
        patch: { content: {
          ...content,
          syncedBlockId: source.localId,
          syncedPageId: source.pageId,
        } },
        requiredWhere: [['pageId', '==', context.page.id]],
        extraExpectations: [{
          table: 'pages', op: 'expect', id: context.page.id,
          where: [
            ['workspaceId', '==', applyContext.job.workspaceId],
            ['kind', '==', 'page'],
            ['notionImportJobId', '==', applyContext.job.id],
            ['notionImportSourceId', '==', context.notionId],
            ['notionImportSourceKind', '==', 'page'],
          ],
          exists: true,
        }],
        label: 'synced block remap',
      });
      remapped += 1;
    }
  }

  if (conversionReport) {
    if (observedRemapped > 0) {
      incrementReport(conversionReport, 'remappedSyncedBlocks', observedRemapped);
    }
    if (unresolved > 0) incrementReport(conversionReport, 'unresolvedSyncedBlocks', unresolved);
  }

  return { remapped, observedRemapped, unresolved };
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
  const localPageIds = new Set(
    Array.from(mappingsByNotionId.values())
      .filter((mapping) => mapping.localType === 'page')
      .map((mapping) => mapping.localId),
  );

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
      else if (localPageIds.has(notionId)) localIds.push(notionId);
      else unresolvedIds.push(notionId);
    }
    if (
      localIds.length !== notionIds.length ||
      localIds.some((localId, index) => localId !== notionIds[index])
    ) {
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

export function remapImportedTemplateRelationProperties(
  template: DbTemplate,
  relationProps: DbProperty[],
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  const properties = template.properties && typeof template.properties === 'object'
    ? { ...template.properties }
    : {};
  let changed = false;
  const unresolved: Record<string, string[]> = {};
  const localPageIds = new Set(
    Array.from(mappingsByNotionId.values())
      .filter((mapping) => mapping.localType === 'page')
      .map((mapping) => mapping.localId),
  );

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
      else if (localPageIds.has(notionId)) localIds.push(notionId);
      else unresolvedIds.push(notionId);
    }
    if (
      localIds.length !== notionIds.length ||
      localIds.some((localId, index) => localId !== notionIds[index])
    ) {
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
  return { kind: HANJI_CURRENT_PAGE_FILTER_KIND };
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
  context: NotionFileCopyContext,
  dataSourceItems: NotionImportItem[],
  propertyRecordsByDataSource: Map<string, DbProperty[]>,
  mappingsByNotionId: Map<string, NotionImportMapping>,
  conversionReport?: ImportConversionReport,
) {
  const { db } = context;
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
      if (view.notionImportJobId !== context.job.id || view.notionDataSourceId !== item.notionId) continue;
      const result = remapImportedViewRelationFilterConfig(
        view.config,
        relationPropsById,
        mappingsByNotionId,
        localPageIds,
      );
      remapped += result.remapped;
      unresolved += result.unresolved.length;

      if (result.changed) {
        await transactImportedOwnerPatch(context, {
          table: 'db_views',
          owner: view,
          patch: { config: result.config as Record<string, unknown> },
          requiredWhere: [
            ['databaseId', '==', databaseMapping.localId],
            ['notionImportJobId', '==', context.job.id],
            ['notionDataSourceId', '==', item.notionId],
          ],
          extraExpectations: [{
            table: 'pages', op: 'expect', id: databaseMapping.localId,
            where: [
              ['workspaceId', '==', context.job.workspaceId],
              ['kind', '==', 'database'],
              ['notionImportJobId', '==', context.job.id],
              ['notionImportSourceId', '==', item.notionId],
              ['notionImportSourceKind', '==', 'data_source'],
            ],
            exists: true,
          }],
          label: 'database view relation-filter remap',
        });
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
  return isHanjiCurrentPageFilterValue(value);
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

function notionImportPageAvailableDuringApply(
  page: Page,
  job: Pick<NotionImportJob, 'id' | 'status'>,
) {
  return !page.inTrash || (
    job.status === 'ready'
    && page.notionImportStaging === true
    && page.notionImportJobId === job.id
  );
}

async function importedRowsRelatedToParentRow(
  db: DbRef,
  intermediateDatabase: Page,
  parentRow: Page,
  intermediateRelationProps: DbProperty[],
  job: Pick<NotionImportJob, 'id' | 'status'>,
) {
  if (intermediateRelationProps.length === 0) return [];
  const rows = await listAll(db.table<Page>('pages').where('parentId', '==', intermediateDatabase.id), 5000);
  return rows
    .filter((row) =>
      row.parentType === 'database' &&
      notionImportPageAvailableDuringApply(row, job) &&
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
  job: Pick<NotionImportJob, 'id' | 'status'>,
) {
  if (sourceDatabase.workspaceId !== parentRow.workspaceId || parentDatabase.workspaceId !== parentRow.workspaceId) {
    return undefined;
  }

  const directFilters = sourceProperties
    .filter((prop) => importedRelationTargetsDatabase(prop, parentDatabase))
    .map((prop) => importedRelationContainsFilter(prop.id, { kind: HANJI_CURRENT_PAGE_FILTER_KIND }));
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
      !notionImportPageAvailableDuringApply(intermediateDatabase, job) ||
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
      job,
    );
    if (targets.length > 0) {
      indirectFilters.push(importedRelationContainsFilter(sourceProp.id, targets.length === 1 ? targets[0] : targets));
    }
  }

  return importedRelationFilterGroup(indirectFilters);
}

function canonicalRowContextFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRowContextFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalRowContextFingerprintValue(item)]),
  );
}

function importedRowContextFingerprint(value: Record<string, unknown>) {
  const canonical = JSON.stringify(canonicalRowContextFingerprintValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isKnownLegacyImportedRowContextGroup(
  term: unknown,
  relationPropsById: Map<string, DbProperty>,
) {
  const group = asRecord(term);
  if (!group || (group.conjunction !== 'and' && group.conjunction !== 'or')) return false;
  const filters = Array.isArray(group.filters) ? group.filters : [];
  const groups = Array.isArray(group.groups) ? group.groups : [];
  if (filters.length === 0 || groups.length !== 0) return false;
  if (Object.keys(group).some((key) => !['conjunction', 'filters', 'groups'].includes(key))) return false;
  return filters.every((filter) => {
    const record = asRecord(filter);
    if (!record || record.operator !== 'contains') return false;
    if (Object.keys(record).some((key) => !['propertyId', 'operator', 'value'].includes(key))) return false;
    const propertyId = optionalString(record.propertyId);
    const prop = propertyId ? relationPropsById.get(propertyId) : undefined;
    if (!prop || prop.type !== 'relation') return false;
    return importedFilterValueHasCurrentPage(record.value)
      || importedRelationValueIds(record.value).length > 0;
  });
}

function repairLegacyCanonicalRowContextConfig(
  config: Record<string, unknown>,
  sourceProperties: DbProperty[],
) {
  if (!hasHanjiImportedRowContextFilterMarker(config)) {
    return { config, changed: false };
  }
  const relationPropsById = new Map(
    sourceProperties
      .filter((prop) => prop.type === 'relation' || prop.type === 'rollup')
      .map((prop) => [prop.id, prop]),
  );
  const injected = asRecord(config.filterGroup);
  if (!injected || !importedViewFilterTermHasRelationValue(injected, relationPropsById)) {
    throw Object.assign(new Error('Imported canonical view has a contradictory legacy row-context marker.'), { code: 409 });
  }
  let restored: Record<string, unknown> | undefined;
  const groups = Array.isArray(injected.groups) ? injected.groups : [];
  const filters = Array.isArray(injected.filters) ? injected.filters : [];
  if (
    injected.conjunction === 'and'
    && filters.length === 0
    && groups.length === 2
    && isKnownLegacyImportedRowContextGroup(groups[0], relationPropsById)
  ) {
    restored = importedKnownFilterTerm(groups[1]);
    if (!restored) {
      throw Object.assign(new Error('Imported canonical view legacy row-context wrapper was malformed.'), { code: 409 });
    }
  } else if (!isKnownLegacyImportedRowContextGroup(injected, relationPropsById)) {
    throw Object.assign(new Error('Imported canonical view legacy row-context filter was malformed.'), { code: 409 });
  }
  const repaired = withoutHanjiImportedRowContextFilterMarkers(config);
  delete repaired.filters;
  delete repaired.filterConjunction;
  if (restored) repaired.filterGroup = restored;
  else delete repaired.filterGroup;
  return { config: repaired, changed: true };
}

function scopedImportedRowContextViewConfig(
  canonicalConfig: Record<string, unknown>,
  contextFilter: FilterGroupTerm,
  blockId: string,
  sourceViewId: string,
) {
  const next = withoutHanjiImportedRowContextFilterMarkers(canonicalConfig);
  const existing = existingImportedViewFilterGroupForContext(next);
  next.filterGroup = existing
    ? { conjunction: 'and', filters: [], groups: [contextFilter, existing] }
    : contextFilter;
  delete next.filters;
  delete next.filterConjunction;
  next.inlineDatabaseBlockId = blockId;
  next.inlineDatabaseSourceViewId = sourceViewId;
  return next;
}

async function addImportedLinkedDatabaseRowContextFilters(
  context: NotionFileCopyContext,
  pages: ImportedPageBlockContext[],
  conversionReport?: ImportConversionReport,
) {
  const { db } = context;
  if (!context.applyLease || !context.itemSnapshotRevision) {
    throw Object.assign(
      new Error('Imported linked-database row scoping requires an active apply lease and immutable revision.'),
      { code: 409, notionImportRecoveryPending: true },
    );
  }
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

  for (const pageContext of pages) {
    const parentRow = await pageSnapshot(pageContext.page.id);
    if (
      !parentRow
      || !notionImportPageAvailableDuringApply(parentRow, context.job)
      || parentRow.parentType !== 'database'
      || !parentRow.parentId
    ) continue;
    const parentDatabase = await pageSnapshot(parentRow.parentId);
    if (
      !parentDatabase
      || !notionImportPageAvailableDuringApply(parentDatabase, context.job)
      || parentDatabase.kind !== 'database'
    ) continue;

    const blocks = await listAll(
      blocksTable.where('pageId', '==', parentRow.id),
      NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    );
    for (const block of blocks) {
      if (block.type !== 'inline_database') continue;
      const content = asRecord(block.content);
      if (content?.linkedDatabaseSource !== true) continue;
      const sourceDatabaseId = optionalString(content.childPageId);
      if (!sourceDatabaseId) continue;
      const referencedViewIds = uniqueNonEmptyStrings([
        optionalString(content.databaseViewId),
        ...(Array.isArray(content.databaseViewIds)
          ? content.databaseViewIds.map((id) => optionalString(id))
          : []),
      ]);
      if (referencedViewIds.length === 0) continue;

      const sourceDatabase = await pageSnapshot(sourceDatabaseId);
      if (
        !sourceDatabase
        || !notionImportPageAvailableDuringApply(sourceDatabase, context.job)
        || sourceDatabase.kind !== 'database'
      ) continue;
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
        context.job,
      );
      if (!contextFilter) continue;

      const sourceViews = new Map<string, DbView>();
      for (const referencedViewId of referencedViewIds) {
        const referencedView = await getExisting(viewsTable, referencedViewId);
        if (!referencedView) continue;
        const sourceViewId = optionalString(asRecord(referencedView.config)?.inlineDatabaseSourceViewId)
          ?? referencedView.id;
        const sourceView = sourceViewId === referencedView.id
          ? referencedView
          : await getExisting(viewsTable, sourceViewId);
        if (!sourceView || sourceView.databaseId !== sourceDatabase.id) continue;
        sourceViews.set(sourceView.id, sourceView);
      }
      if (sourceViews.size === 0) continue;

      const plans: Array<{
        source: DbView;
        canonicalConfig: Record<string, unknown>;
        repairCanonical: boolean;
        clone: DbView;
        existingClone?: DbView;
      }> = [];
      const canonicalRepairOnlyPlans: Array<{
        source: DbView;
        canonicalConfig: Record<string, unknown>;
      }> = [];
      const targetViewIds = new Map<string, string>();
      for (const sourceView of sourceViews.values()) {
        const sourceConfig = asRecord(sourceView.config) ?? {};
        const canonical = repairLegacyCanonicalRowContextConfig(sourceConfig, sourceProperties);
        if (importedViewConfigHasRelationValueFilter(canonical.config, sourceProperties)) {
          targetViewIds.set(sourceView.id, sourceView.id);
          if (canonical.changed) {
            canonicalRepairOnlyPlans.push({
              source: sourceView,
              canonicalConfig: canonical.config,
            });
          }
          continue;
        }
        const fingerprint = importedRowContextFingerprint({
          parentRowId: parentRow.id,
          blockId: block.id,
          sourceViewId: sourceView.id,
          contextFilter,
        });
        let locator = viewsTable.where('notionRowContextJobId', '==', context.job.id);
        for (const [field, value] of [
          ['notionRowContextSnapshotRevision', context.itemSnapshotRevision],
          ['notionRowContextBlockId', block.id],
          ['notionRowContextSourceViewId', sourceView.id],
        ] as const) {
          if (typeof locator.where !== 'function') {
            throw Object.assign(new Error('Imported row-context view locator requires compound equality queries.'), { code: 503 });
          }
          locator = locator.where(field, '==', value);
        }
        const matches = await listAll(locator, NOTION_IMPORT_ITEM_SAFETY_LIMIT);
        if (matches.length > 1) {
          throw Object.assign(new Error('Imported row-context view locator resolved to duplicate clones.'), { code: 409 });
        }
        const existingClone = matches[0];
        if (
          existingClone
          && (
            existingClone.databaseId !== sourceDatabase.id
            || existingClone.notionRowContextFingerprint !== fingerprint
            || optionalString(asRecord(existingClone.config)?.inlineDatabaseBlockId) !== block.id
            || optionalString(asRecord(existingClone.config)?.inlineDatabaseSourceViewId) !== sourceView.id
          )
        ) {
          throw Object.assign(new Error('Imported row-context view clone provenance was contradictory.'), { code: 409 });
        }
        const cloneConfig = scopedImportedRowContextViewConfig(
          canonical.config,
          contextFilter,
          block.id,
          sourceView.id,
        );
        const clone: DbView = existingClone ?? {
          id: newId(),
          databaseId: sourceView.databaseId,
          name: sourceView.name,
          type: sourceView.type,
          config: cloneConfig,
          position: sourceView.position,
          notionRowContextJobId: context.job.id,
          notionRowContextSnapshotRevision: context.itemSnapshotRevision,
          notionRowContextBlockId: block.id,
          notionRowContextSourceViewId: sourceView.id,
          notionRowContextFingerprint: fingerprint,
        };
        plans.push({
          source: sourceView,
          canonicalConfig: canonical.config,
          repairCanonical: canonical.changed,
          clone,
          existingClone,
        });
        targetViewIds.set(sourceView.id, clone.id);
      }
      if (plans.length === 0 && canonicalRepairOnlyPlans.length === 0) continue;

      const cloneIds = Array.from(sourceViews.keys())
        .map((sourceViewId) => targetViewIds.get(sourceViewId))
        .filter((viewId): viewId is string => !!viewId);
      const nextContent = {
        ...content,
        databaseViewId: cloneIds[0],
        databaseViewIds: cloneIds,
      };
      const blockChanged = !jsonEquivalent(nextContent, content);
      const operations: TransactOperation[] = [
        {
          table: 'notion_import_jobs', op: 'expect', id: context.job.id,
          where: [
            ['status', '==', context.job.status],
            ['itemSnapshotRevision', '==', context.itemSnapshotRevision],
          ],
          exists: true,
        },
        {
          table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
          where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
          exists: true,
        },
        {
          table: 'pages', op: 'expect', id: parentRow.id,
          where: [
            ['workspaceId', '==', parentRow.workspaceId],
            ['parentId', '==', parentRow.parentId],
            ['parentType', '==', 'database'],
          ],
          exists: true,
        },
        {
          table: 'blocks', op: 'expect', id: block.id,
          where: [
            ['pageId', '==', parentRow.id],
            ['type', '==', 'inline_database'],
            ['updatedAt', '==', block.updatedAt ?? null],
          ],
          exists: true,
        },
      ];
      for (const plan of plans) {
        operations.push({
          table: 'db_views', op: 'expect', id: plan.source.id,
          where: [
            ['databaseId', '==', sourceDatabase.id],
            ['updatedAt', '==', plan.source.updatedAt ?? null],
          ],
          exists: true,
        });
        if (plan.repairCanonical) {
          operations.push({
            table: 'db_views', op: 'update', id: plan.source.id,
            data: { config: plan.canonicalConfig },
          });
        }
        if (plan.existingClone) {
          operations.push({
            table: 'db_views', op: 'expect', id: plan.existingClone.id,
            where: [
              ['databaseId', '==', sourceDatabase.id],
              ['notionRowContextJobId', '==', context.job.id],
              ['notionRowContextSnapshotRevision', '==', context.itemSnapshotRevision],
              ['notionRowContextBlockId', '==', block.id],
              ['notionRowContextSourceViewId', '==', plan.source.id],
              ['notionRowContextFingerprint', '==', plan.clone.notionRowContextFingerprint],
              ['updatedAt', '==', plan.existingClone.updatedAt ?? null],
            ],
            exists: true,
          });
        } else {
          operations.push(
            { table: 'db_views', op: 'expect', id: plan.clone.id, exists: false },
            { table: 'db_views', op: 'insert', data: plan.clone as unknown as Record<string, unknown> },
          );
        }
      }
      for (const plan of canonicalRepairOnlyPlans) {
        operations.push(
          {
            table: 'db_views', op: 'expect', id: plan.source.id,
            where: [
              ['databaseId', '==', sourceDatabase.id],
              ['updatedAt', '==', plan.source.updatedAt ?? null],
            ],
            exists: true,
          },
          {
            table: 'db_views', op: 'update', id: plan.source.id,
            data: { config: plan.canonicalConfig },
          },
        );
      }
      if (blockChanged) {
        operations.push({ table: 'blocks', op: 'update', id: block.id, data: { content: nextContent } });
      }
      if (operations.length > MAX_RAW_TRANSACT_OPS) {
        throw Object.assign(new Error('Imported inline database contains too many scoped views.'), { code: 413 });
      }
      if (
        plans.some((plan) => !plan.existingClone || plan.repairCanonical)
        || canonicalRepairOnlyPlans.length > 0
        || blockChanged
      ) {
        await db.transact(operations);
      }
      updatedViews += plans.length;
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
  context: NotionFileCopyContext,
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
  await transactImportedOwnerPatch(context, {
    table: 'db_views',
    owner: view,
    patch: { config: nextConfig },
    requiredWhere: [
      ['databaseId', '==', view.databaseId],
      ['notionImportJobId', '==', context.job.id],
      ['notionDataSourceId', '==', view.notionDataSourceId ?? null],
    ],
    extraExpectations: [{
      table: 'pages', op: 'expect', id: view.databaseId,
      where: [
        ['workspaceId', '==', context.job.workspaceId],
        ['kind', '==', 'database'],
        ['notionImportJobId', '==', context.job.id],
        ['notionImportSourceId', '==', view.notionDataSourceId ?? null],
        ['notionImportSourceKind', '==', 'data_source'],
      ],
      exists: true,
    }],
    label: 'template-linked database view remap',
  });
}

async function remapImportedTemplateLinkedDatabaseBlocks(
  context: NotionFileCopyContext,
  templateContext: ImportedTemplateContext,
  mappingsByNotionId: Map<string, NotionImportMapping>,
) {
  const { db } = context;
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
            await markImportedTemplateLinkedView(context, view, selfFilter);
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

const {
  ensureImportedPageWorkspaceIndexes,
  importedBlockBoundaryRepairComplete,
  importedBlocksComplete,
  importedPageBlockRecoveryFence,
  importedPageBlockRecoveryPageExpectation,
  insertPageBlocksFromSnapshot,
  itemHasImportablePageBody,
  markImportedBlocksComplete,
  recoverIncompleteImportedPageBlocks,
  replayImportedPageBlockMetrics,
  replaceImportedBlocksForPage,
  retryImportedPageFileCopies,
  storedUploadIds,
  transactImportedFileOwner,
  transactImportedPageBlockRecovery,
} = createNotionImportBlockApplyRuntime({
  NOTION_BLOCK_CHILD_TOTAL_LIMIT,
  NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION,
  NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY,
  NOTION_IMPORT_BLOCK_RECOVERY_KEY,
  NOTION_IMPORT_BLOCKS_COMPLETE_KEY,
  NOTION_PAGE_COVER_REFERENCE_KEY,
  NOTION_PAGE_ICON_REFERENCE_KEY,
  asRecord,
  assertImportedBlockFileTransactionCapacity,
  contentWithStoredNotionFile,
  copyImportedEmbeddedTemplateBlockFiles,
  copyNotionFileReference,
  countImportedEmbeddedTemplateBlockFiles,
  databaseViewMatchingImportedSection,
  fileCopyScopeForBlockType,
  fileReferenceFromNotionBlock,
  flattenImportablePageBlocksForPlan,
  importedDatabaseMappingSourceUnavailable,
  importedNotionDatabaseIsInline,
  importedPatchOwnerSnapshotMatches,
  importedPatchOwnerTransactionWhere,
  importRootNotionId,
  inferredLinkedDatabaseViewMapping,
  isApplyLeaseConflict,
  isRetryableNotionTemplateCleanupError,
  jsonEquivalent,
  linkedDatabaseHeadingMatchesLabel,
  linkedNotionTargetIdsFromBlock,
  linkedNotionViewIdsFromBlock,
  listAll,
  localBlockFromNotion,
  mappedLocalDatabaseViewIds,
  nestedNotionBlockIds,
  normalizeFileName,
  notionBlockChildren,
  notionBlockHeadingText,
  notionImportMappingExpectation,
  notionImportMappingSnapshotMatches,
  notionObjectId,
  optionalString,
  pageSnapshot,
  preserveImportedBlockTimestamps,
  remapImportedRichTextMentionsInContent,
  remapImportedTemplateBlocksRichTextMentions,
  renewNotionApplyLease,
  reportBlockConversion,
  reportBlockFileReference,
  reportBlockRichTextUserReferences,
  reportImportedBlockLinkedViewResolutionFromRaw,
  reportImportedPageMarkdownFallback,
  rich,
  storedNotionFileReference,
  tabBlockChildrenForImport,
  templateBlockChildren,
  withNativeHanjiLinkedDatabaseFields,
});

const notionImportPlanRuntime = {
  asRecord,
  augmentNotionPropertiesFromRowSnapshots,
  compareNotionImportViewItems,
  dataSourceSnapshot,
  emptyConversionReport,
  finalizeConversionReport,
  flattenImportablePageBlocksForPlan,
  formulaPropertyReferences,
  incrementReport,
  inferDataSourceForHiddenLinkedDatabase,
  inspectViewPropertyReferences,
  itemMetadata,
  linkedNotionTargetIdsFromBlock,
  linkedNotionViewIdsFromBlock,
  localBlockTypeFromNotion,
  localizedImportableNotionViews,
  notionFilePropertyReferences,
  notionObjectId,
  notionPropertiesFromSnapshot,
  notionPropertyConfig,
  notionPropertyReferenceVariants,
  notionUserReferencesFromPropertyValue,
  nowIso,
  optionalString,
  pageSnapshot,
  parsePersistentGeneratedLocale,
  progressObject,
  pushReportIssue,
  rawTemplateBlocks,
  rawTemplatesFromSnapshot,
  relationTargetNotionId,
  reportBlockConversion,
  reportBlockFileReference,
  reportBlockRichTextUserReferences,
  reportNotionFileReferences,
  reportNotionUserReferences,
  reportPageChromeFileReferences,
  reportTemplateBlockRichTextUserReferences,
  reportUnresolvedFormulaPropertyReference,
  reportUnsupportedFormulaFunctions,
  reportUnsupportedProperty,
  reportUnsupportedView,
  rowDataSourceId,
  templatePropertiesFromNotion,
  unsupportedFormulaFunctions,
  viewPropertyMappingsFromRawProperties,
  viewSnapshot,
  withGeneratedTitleProperty,
} satisfies NotionImportPlanRuntime;
const {
  rawViewsForPlan,
  buildImportPlan,
  inspectDiscoveryCompletenessForReport,
  notionPropertyFromRawProperties,
} = createNotionImportPlanner(notionImportPlanRuntime);
export { rawViewsForPlan, buildImportPlan };

function applyLeaseExpiresAt(purpose: 'apply' | 'discover' = 'apply') {
  const ttl = purpose === 'discover' ? NOTION_DISCOVER_LEASE_TTL_MS : NOTION_APPLY_LEASE_TTL_MS;
  return new Date(Date.now() + ttl).toISOString();
}

function isApplyLeaseConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status
    : undefined;
  return code === 409 || /expectation failed|already exists|conflict/i.test(message);
}

export function notionApplyLeaseCanBeRecovered(params: {
  requestedPurpose: 'apply' | 'discover';
  existingPurpose?: 'apply' | 'discover';
  actorId: string;
  existingActorId: string;
  updatedAt?: string;
  createdAt?: string;
  nowMs?: number;
}) {
  if (params.requestedPurpose !== 'apply') return false;
  if (params.existingPurpose === 'discover') return false;
  if (params.actorId !== params.existingActorId) return false;
  // Apply-lock tables have always retained EdgeBase's managed updatedAt field.
  // A row without it is malformed, so createdAt must never become a mutable
  // heartbeat substitute outside the transaction fence.
  const heartbeatMs = Date.parse(params.updatedAt ?? '');
  if (!Number.isFinite(heartbeatMs)) return false;
  return (params.nowMs ?? Date.now()) - heartbeatMs >= NOTION_APPLY_LEASE_STALE_MS;
}

export function activeNotionImportOperation(
  lock: Pick<NotionImportApplyLock, 'purpose' | 'expiresAt'> | null | undefined,
  nowMs = Date.now(),
): 'apply' | 'discover' | null {
  if (!lock) return null;
  const expiresAtMs = Date.parse(lock.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
  return lock.purpose === 'discover' ? 'discover' : 'apply';
}

async function acquireNotionApplyLease(
  db: DbRef,
  job: NotionImportJob,
  actorId: string,
  purpose: 'apply' | 'discover' = 'apply',
) {
  const locks = db.table<NotionImportApplyLock>('notion_import_apply_locks');
  const leaseId = newId();
  for (let attempt = 0; attempt < NOTION_APPLY_LEASE_CAS_ATTEMPTS; attempt += 1) {
    const existing = await getExisting(locks, job.id);
    const now = Date.now();
    const recoverableApplyLease = existing
      ? notionApplyLeaseCanBeRecovered({
          requestedPurpose: purpose,
          existingPurpose: existing.purpose,
          actorId,
          existingActorId: existing.actorId,
          updatedAt: existing.updatedAt,
          createdAt: existing.createdAt,
          nowMs: now,
        })
      : false;
    if (existing && new Date(existing.expiresAt).getTime() > now && !recoverableApplyLease) {
      throw new Error(
        existing.purpose === 'discover' || purpose === 'discover'
          ? 'Notion import job is already being discovered.'
          : 'Notion import job is already being applied.',
      );
    }
    const expiresAt = applyLeaseExpiresAt(purpose);
    try {
      if (existing) {
        await db.transact([
          {
            table: 'notion_import_apply_locks',
            op: 'expect',
            id: existing.id,
            // An expired-lease takeover must lose its CAS if the incumbent
            // heartbeat refreshed the same leaseId after this row was read.
            where: [
              ['leaseId', '==', existing.leaseId],
              ['expiresAt', '==', existing.expiresAt],
            ],
            exists: true,
          },
          {
            table: 'notion_import_apply_locks',
            op: 'update',
            id: existing.id,
            data: { leaseId, actorId, purpose, expiresAt, updatedAt: nowIso() },
          },
        ]);
      } else {
        await db.transact([
          { table: 'notion_import_apply_locks', op: 'expect', id: job.id, exists: false },
          {
            table: 'notion_import_apply_locks',
            op: 'insert',
            data: {
              id: job.id,
              workspaceId: job.workspaceId,
              jobId: job.id,
              leaseId,
              actorId,
              purpose,
              expiresAt,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            },
          },
        ]);
      }
      return { id: job.id, leaseId };
    } catch (error) {
      if (!isApplyLeaseConflict(error) || attempt === NOTION_APPLY_LEASE_CAS_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw new Error(
    purpose === 'discover'
      ? 'Notion import job is already being discovered.'
      : 'Notion import job is already being applied.',
  );
}

async function renewNotionApplyLease(
  db: DbRef,
  lease: { id: string; leaseId: string },
  purpose: 'apply' | 'discover' = 'apply',
) {
  await db.transact([
    {
      table: 'notion_import_apply_locks',
      op: 'expect',
      id: lease.id,
      where: [
        ['leaseId', '==', lease.leaseId],
        ['purpose', '==', purpose],
      ],
      exists: true,
    },
    {
      table: 'notion_import_apply_locks',
      op: 'update',
      id: lease.id,
      data: { expiresAt: applyLeaseExpiresAt(purpose), updatedAt: nowIso() },
    },
  ]);
}

function notionApplyFailureLockProvesOwnership(
  lock: NotionImportApplyLock | null,
  job: NotionImportJob,
  lease: { id: string; leaseId: string },
  actorId: string,
  nowMs = Date.now(),
) {
  if (
    !lock
    || lock.id !== lease.id
    || lock.jobId !== job.id
    || lock.workspaceId !== job.workspaceId
    || lock.leaseId !== lease.leaseId
    || lock.actorId !== actorId
    || lock.purpose !== 'apply'
  ) return false;
  const expiresAtMs = Date.parse(lock.expiresAt);
  // Cleanup transactions fence the exact managed heartbeat. Fail malformed
  // updatedAt-less rows closed instead of proving ownership from createdAt,
  // which is not part of the cleanup lock expectation.
  const heartbeatMs = Date.parse(lock.updatedAt ?? '');
  return Number.isFinite(expiresAtMs)
    && expiresAtMs > nowMs
    && Number.isFinite(heartbeatMs)
    && nowMs - heartbeatMs < NOTION_APPLY_LEASE_STALE_MS;
}

async function recoverNotionApplyFailureCleanupAuthority(
  db: DbRef,
  job: NotionImportJob,
  lease: { id: string; leaseId: string },
  actorId: string,
) {
  for (let attempt = 0; attempt < NOTION_APPLY_FAILURE_RENEW_ATTEMPTS; attempt += 1) {
    try {
      await renewNotionApplyLease(db, lease);
      break;
    } catch (error) {
      if (
        !isTransientInfrastructureError(error)
        || attempt === NOTION_APPLY_FAILURE_RENEW_ATTEMPTS - 1
      ) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, NOTION_APPLY_FAILURE_RENEW_BASE_DELAY_MS * (2 ** attempt));
      });
    }
  }
  const freshLock = await getExisting(
    db.table<NotionImportApplyLock>('notion_import_apply_locks'),
    lease.id,
  ).catch(() => null);
  return notionApplyFailureLockProvesOwnership(freshLock, job, lease, actorId);
}

class NotionApplyFailureCleanupAuthorityLostError extends Error {
  constructor(cause?: unknown) {
    super('Notion import apply failure cleanup authority was lost.');
    this.name = 'NotionApplyFailureCleanupAuthorityLostError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

async function transactNotionApplyFailureCleanupChunk(
  db: DbRef,
  job: NotionImportJob,
  lease: { id: string; leaseId: string },
  actorId: string,
  mutations: TransactOperation[],
) {
  if (mutations.length === 0) return;
  if (mutations.length > NOTION_APPLY_FAILURE_CLEANUP_MUTATION_CHUNK_SIZE) {
    throw new Error(
      `Notion import apply failure cleanup mutation chunks cannot exceed ${NOTION_APPLY_FAILURE_CLEANUP_MUTATION_CHUNK_SIZE} operations.`,
    );
  }

  let freshLock: NotionImportApplyLock | null;
  try {
    freshLock = await getExisting(
      db.table<NotionImportApplyLock>('notion_import_apply_locks'),
      lease.id,
    );
  } catch (error) {
    throw new NotionApplyFailureCleanupAuthorityLostError(error);
  }
  if (!freshLock || !notionApplyFailureLockProvesOwnership(freshLock, job, lease, actorId)) {
    throw new NotionApplyFailureCleanupAuthorityLostError();
  }

  const renewedAt = nowIso();
  try {
    await db.transact([
      {
        table: 'notion_import_jobs',
        op: 'expect',
        id: job.id,
        where: [
          ['workspaceId', '==', job.workspaceId],
          ['status', '==', 'ready'],
          ['itemSnapshotRevision', '==', job.itemSnapshotRevision ?? null],
        ],
        exists: true,
      },
      {
        table: 'notion_import_apply_locks',
        op: 'expect',
        id: lease.id,
        where: [
          ['workspaceId', '==', job.workspaceId],
          ['jobId', '==', job.id],
          ['leaseId', '==', lease.leaseId],
          ['actorId', '==', actorId],
          ['purpose', '==', 'apply'],
          ['expiresAt', '==', freshLock.expiresAt],
          ['updatedAt', '==', freshLock.updatedAt ?? null],
        ],
        exists: true,
      },
      {
        table: 'notion_import_apply_locks',
        op: 'update',
        id: lease.id,
        data: {
          expiresAt: applyLeaseExpiresAt('apply'),
          updatedAt: renewedAt,
        },
      },
      ...mutations,
    ]);
  } catch (error) {
    throw new NotionApplyFailureCleanupAuthorityLostError(error);
  }
}

function createNotionApplyFailureCleanupMutationCollector(
  db: DbRef,
  job: NotionImportJob,
  lease: { id: string; leaseId: string },
  actorId: string,
) {
  const pending: TransactOperation[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const chunk = pending.splice(0, pending.length);
    await transactNotionApplyFailureCleanupChunk(db, job, lease, actorId, chunk);
  };
  return {
    async collect(operation: TransactOperation) {
      pending.push(operation);
      if (pending.length === NOTION_APPLY_FAILURE_CLEANUP_MUTATION_CHUNK_SIZE) {
        await flush();
      }
    },
    flush,
  };
}

class NotionDiscoveryLeaseLostError extends Error {
  constructor(cause?: unknown) {
    super('Notion import discovery lease ownership was lost.');
    this.name = 'NotionDiscoveryLeaseLostError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function notionDiscoveryLeaseExpectation(
  lease: { id: string; leaseId: string },
): TransactOperation {
  return {
    table: 'notion_import_apply_locks',
    op: 'expect',
    id: lease.id,
    where: [
      ['leaseId', '==', lease.leaseId],
      ['purpose', '==', 'discover'],
    ],
    exists: true,
  };
}

function startNotionDiscoveryLeaseHeartbeat(
  db: DbRef,
  lease: { id: string; leaseId: string },
) {
  let stopped = false;
  let ownershipFailure: unknown;
  let renewalInFlight: Promise<void> | null = null;

  const renewSingleFlight = () => {
    if (stopped) return Promise.resolve();
    if (renewalInFlight) return renewalInFlight;
    const renewal = renewNotionApplyLease(db, lease, 'discover')
      .then(() => {
        // A timer renewal can fail for transient infrastructure reasons while
        // the durable lease remains ours. A later successful CAS is fresh
        // ownership proof and must clear that stale observation.
        ownershipFailure = undefined;
      })
      .catch((error) => {
        ownershipFailure = error;
        throw error;
      })
      .finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null;
      });
    renewalInFlight = renewal;
    return renewal;
  };

  const timer = setInterval(() => {
    void renewSingleFlight().catch(() => {});
  }, NOTION_DISCOVER_LEASE_HEARTBEAT_MS);

  return {
    expectOwnedOperation() {
      return notionDiscoveryLeaseExpectation(lease);
    },
    async assertOwned() {
      try {
        await renewSingleFlight();
      } catch (error) {
        throw new NotionDiscoveryLeaseLostError(error);
      }
      if (ownershipFailure) throw new NotionDiscoveryLeaseLostError(ownershipFailure);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (renewalInFlight) await renewalInFlight.catch(() => {});
    },
  };
}

async function releaseNotionApplyLease(
  db: DbRef,
  lease: { id: string; leaseId: string },
) {
  await db.transact([
    {
      table: 'notion_import_apply_locks',
      op: 'expect',
      id: lease.id,
      where: [['leaseId', '==', lease.leaseId]],
      exists: true,
    },
    { table: 'notion_import_apply_locks', op: 'delete', id: lease.id },
  ]);
}

function applyJobFailureMutation(
  job: NotionImportJob,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  // SQLite/JS timestamps have millisecond precision. A just-inserted importer
  // page and the terminal job CAS can otherwise share the same timestamp and
  // be mistaken for a user takeover (`page.updatedAt >= finishedAt`). Fence
  // one millisecond past the request's last importer write; any real takeover
  // after the candidate read is still protected by the page CAS below.
  const failedAt = new Date(Date.now() + 1).toISOString();
  const patch: Partial<NotionImportJob> = {
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
      fileCleanupPending: {
        requestedAt: failedAt,
        reason: 'apply_failed',
      },
    },
    finishedAt: failedAt,
    fileCleanupStatus: 'pending',
    fileCleanupRequestedAt: failedAt,
    fileCleanupCompletedAt: null,
  };
  return {
    message,
    failedJob: { ...job, ...patch } as NotionImportJob,
    operation: {
      table: 'notion_import_jobs',
      op: 'update',
      id: job.id,
      data: patch as Record<string, unknown>,
    } as TransactOperation,
  };
}

const { applyJob } = createNotionImportJobApplyHandlers<
  NotionImportJob,
  NotionImportItem,
  DbRef,
  FunctionStorageProxy,
  Awaited<ReturnType<typeof applyJobCore>>
>({
  requireString,
  assertWritableJob,
  acquireNotionApplyLease,
  applyJobCore,
  clearNotionImportApplySnapshotCache,
  isRetryableNotionTemplateCleanupError,
  recoverNotionApplyFailureCleanupAuthority,
  createNotionApplyFailureCleanupMutationCollector,
  scrubMappedImportProductCredentials,
  listActiveNotionImportItems,
  scrubAppliedImportCredentialMetadata,
  applyJobFailureMutation,
  trashIncompleteImportPages,
  releaseNotionApplyLease,
});

function notionImportApplyRuntime() {
  return {
    NOTION_API_VERSION,
    NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    NOTION_IMPORT_PUBLICATION_BOUNDARY_VERSION,
    GENERATED_NOTION_TITLE_PROPERTY_ID,
    notionAppliedCountsFromMappings,
    withImportProgress,
    optionalString,
    parsePositiveInt,
    listAll,
    assertWritableJob,
    notionTokenForJob,
    cleanJob,
    assertSafeNotionImportSourceReferences,
    notionObjectId,
    itemMetadata,
    dataSourceSnapshot,
    viewSnapshot,
    notionPropertiesFromSnapshot,
    augmentNotionPropertiesFromRowSnapshots,
    withGeneratedTitleProperty,
    notionPropertyMappingId,
    asRecord,
    importedPageChromeFromItem,
    importedPageShouldUseFullWidth,
    pagePropertiesWithChromeReferences,
    initialImportedPageChrome,
    emptyConversionReport,
    incrementReport,
    pushReportIssue,
    reportUnsupportedProperty,
    reportUnsupportedView,
    parseOptionalBoolean,
    assertNotionFileCopyNotDisabled,
    dbPropertyFromNotion,
    setViewPropertyMapping,
    dbViewFromNotion,
    rawTemplatesFromSnapshot,
    rawTemplateBlocks,
    dbTemplateFromNotion,
    reportTemplateBlockRichTextUserReferences,
    compareNotionImportViewItems,
    localizedImportableNotionViews,
    inferCanonicalDataSourceForHiddenLinkedDatabase,
    meaningfulImportedTitle,
    hiddenLinkedDatabaseFallbackTitle,
    pushImportActivity,
    importActivityRingOf,
    listActiveNotionImportDiscoverySeeds,
    listActiveNotionImportItems,
    collectNotionImportFileCopySlots,
    notionImportFileSlotCoordinates,
    loadNotionImportFileCheckpoints,
    loadNotionImportFileCheckpointBySlotKey,
    cleanupUnownedNotionImportFileCheckpoints,
    copyNotionImportFileSlot,
    scrubAppliedImportCredentialMetadata,
    finalizeConversionReport,
    basePage,
    importedItemTimestamps,
    transactImportedOwnerPatch,
    preserveImportedPageTimestamps,
    loadMappings,
    buildImportedBlockOwnerContexts,
    resolveImportedPageParentFromNotionBlocks,
    moveImportedPageToResolvedParent,
    createMapping,
    publishRecoveredImportedOwnerMapping,
    publishImportedDatabaseAliasMapping,
    insertImportedDatabaseChildWithMapping,
    claimRecoveredImportedDatabaseChild,
    insertImportedPageWithMapping,
    ensureImportRoot,
    stageIncompleteImportPages,
    unwrapImportRoot,
    rowDataSourceId,
    rowPropertiesForDataSource,
    copyImportedRowFileProperties,
    importedRowFilePropertiesNeedCopy,
    copyImportedPageChromeFiles,
    existingImportedTemplateFileState,
    copyImportedTemplateFiles,
    insertImportedTemplateWithFiles,
    updateImportedTemplateWithFiles,
    remapImportedDatabaseProperties,
    remapImportedTemplateBlocksRichTextMentions,
    reportRichTextMentionRemap,
    remapImportedPageBlockRichTextMentions,
    remapImportedPageLinkBlocks,
    remapImportedSyncedBlocks,
    remapImportedRowRelationProperties,
    remapImportedTemplateRelationProperties,
    remapImportedDatabaseViewRelationFilters,
    addImportedLinkedDatabaseRowContextFilters,
    remapImportedTemplateLinkedDatabaseBlocks,
    insertPageBlocksFromSnapshot,
    inspectDiscoveryCompletenessForReport,
    itemHasImportablePageBody,
    replayImportedPageBlockMetrics,
    importedBlocksComplete,
    markImportedBlocksComplete,
    replaceImportedBlocksForPage,
    ensureImportedPageWorkspaceIndexes,
    renewNotionApplyLease,
    updateNotionJobIfStatus,
  } satisfies NotionImportApplyRuntime;
}

async function applyJobCore(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  storage?: FunctionStorageProxy,
  request?: Request,
  env?: Record<string, unknown>,
  applyLease?: { id: string; leaseId: string },
  createdUploadIds: string[] = [],
) {
  return applyJobCoreWithRuntime(
    db,
    admin,
    body,
    actorId,
    notionImportApplyRuntime,
    storage,
    request,
    env,
    applyLease,
    createdUploadIds,
  );
}


const {
  beginOAuthConnection,
  completeOAuthConnection,
  createConnection,
  listConnections,
  revokeConnection,
  listAccessibleRoots,
  parseConnectionKind,
  notionTokenForJob,
  notionWorkspaceInfo,
  cachedNotionWorkspaceForDiscovery,
  notionAccessibleRootCandidates,
} = createNotionImportConnectionHandlers({
  NOTION_API_VERSION,
  NOTION_ROOT_SCAN_DEFAULT_PAGE_LIMIT,
  NOTION_ROOT_SCAN_MAX_PAGE_LIMIT,
  optionalString,
  parsePositiveInt,
  listAll,
  assertWorkspaceRole,
  assertWritableImportTarget,
  asRecord,
  notionObjectId,
  notionParentResourceId,
  notionParentType,
  notionTitle,
});

export { cachedNotionWorkspaceForDiscovery, notionAccessibleRootCandidates };


const {
  isLiveImportJob,
  importJobRetentionMs,
  pruneStaleImportJobs,
  listJobs,
} = createNotionImportJobListingHandlers<
  NotionImportJob,
  NotionImportItem,
  DbRef,
  ShareRole,
  ReturnType<typeof cleanJob>
>({
  envString,
  listAll,
  bestEffort,
  requireString,
  parsePositiveInt,
  assertWorkspaceRole,
  workspaceRole,
  roleRanks,
  cleanJob,
  notionImportItemSafetyLimit: NOTION_IMPORT_ITEM_SAFETY_LIMIT,
});
export {
  isLiveImportJob,
  importJobRetentionMs,
  pruneStaleImportJobs,
};

const {
  repairImportPageIndexes,
  repairImportedPageBlocks,
  retryFileCopies,
} = createNotionImportJobRepairHandlers<
  NotionImportJob,
  NotionImportItem,
  NotionImportMapping,
  Page,
  ImportedBlockMapping,
  DbRef,
  FunctionStorageProxy,
  NotionFileCopyContext,
  ImportConversionReport,
  ReturnType<typeof finalizeConversionReport>,
  ReturnType<typeof cleanJob>
>({
  notionApiVersion: NOTION_API_VERSION,
  notionImportItemSafetyLimit: NOTION_IMPORT_ITEM_SAFETY_LIMIT,
  assertNotionFileCopyNotDisabled,
  requireString,
  assertWritableJob,
  loadMappings,
  emptyConversionReport,
  notionTokenForJob,
  notionApiBase,
  retryImportedPageFileCopies,
  finalizeConversionReport,
  withImportProgress,
  cleanJob,
  optionalString,
  acquireNotionApplyLease,
  parsePositiveInt,
  parseBoolean,
  listActiveNotionImportItems,
  assertSafeNotionImportSourceReferences,
  itemHasImportablePageBody,
  importedBlocksComplete,
  importedBlockBoundaryRepairComplete,
  replaceImportedBlocksForPage,
  addImportedLinkedDatabaseRowContextFilters,
  releaseNotionApplyLease,
  assertWorkspaceRole,
  listAll,
  unwrapImportRoot,
  trashIncompleteImportPages,
});

const { getJob } = createNotionImportJobReaderHandlers<
  NotionImportJob,
  NotionImportItem,
  NotionImportApplyLock,
  DbRef,
  ReturnType<typeof cleanJob>,
  ReturnType<typeof cleanItem>,
  ReturnType<typeof activeNotionImportOperation>
>({
  requireString,
  assertReadableJob,
  parseBoolean,
  listActiveNotionImportItems,
  cleanJob,
  cleanItem,
  activeNotionImportOperation,
});

const {
  appendSnapshotItemsJob,
  planJob,
} = createNotionImportJobReviewHandlers<
  NotionImportJob,
  NotionImportItem,
  DiscoveredNotionItem,
  DbRef,
  ReturnType<typeof cleanJob>,
  ReturnType<typeof emptyConversionReport>,
  ReturnType<typeof finalizeConversionReport>,
  ReturnType<typeof buildImportPlan>
>({
  requireString,
  assertWritableJob,
  expandSnapshotItems,
  parseSnapshotItems,
  snapshotItemsPerRequestMax: NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
  assertBoundedRequestDiscoveredItems,
  parseBoolean,
  optionalString,
  asRecord,
  assertBoundedSnapshotJsonValue,
  acquireNotionApplyLease,
  startNotionDiscoveryLeaseHeartbeat,
  importItemGeneration,
  listActiveNotionImportItems,
  mergeDiscoveredItems,
  countImportItemsByObject,
  withImportProgress,
  baseReport,
  parseStringArray,
  updateNotionJobIfStatus,
  cleanJob,
  NotionDiscoveryLeaseLostError,
  releaseNotionApplyLease,
  isApplyLeaseConflict,
  emptyConversionReport,
  finalizeConversionReport,
  buildImportPlan,
});

async function updateNotionJobIfStatus(
  db: DbRef,
  jobId: string,
  expectedStatus: NotionImportStatus,
  data: Partial<NotionImportJob>,
  options: {
    expectedItemGeneration?: string | null;
    extraExpectations?: TransactOperation[];
  } = {},
) {
  try {
    const jobWhere: Array<[string, '==', unknown]> = [['status', '==', expectedStatus]];
    if ('expectedItemGeneration' in options) {
      jobWhere.push(['activeItemGeneration', '==', options.expectedItemGeneration ?? null]);
    }
    await db.transact([
      {
        table: 'notion_import_jobs',
        op: 'expect',
        id: jobId,
        where: jobWhere,
        exists: true,
      },
      ...(options.extraExpectations ?? []),
      {
        table: 'notion_import_jobs',
        op: 'update',
        id: jobId,
        data: data as Record<string, unknown>,
      },
    ]);
    return await getExisting(db.table<NotionImportJob>('notion_import_jobs'), jobId);
  } catch (error) {
    if (isApplyLeaseConflict(error)) return null;
    throw error;
  }
}

async function currentNotionDiscoveryResult(
  db: DbRef,
  job: NotionImportJob,
  compact = false,
) {
  if (compact) return { job: cleanJob(job) };
  const items = await listActiveNotionImportItems(db, job);
  return { job: cleanJob(job), items: items.map(cleanItem) };
}

const {
  preflightJob,
  discoverJob,
} = createNotionImportJobDiscoveryHandlers<
  NotionImportJob,
  NotionImportItem,
  DiscoveredNotionItem,
  NotionTokenSource,
  DbRef,
  ReturnType<typeof cleanJob>,
  ReturnType<typeof cleanItem>,
  Awaited<ReturnType<typeof preflightNotionImportGraph>>,
  Awaited<ReturnType<typeof currentNotionDiscoveryResult>>
>({
  notionApiVersion: NOTION_API_VERSION,
  notionSearchPagesDefault: NOTION_SEARCH_PAGES_DEFAULT,
  notionPaginationSafetyPageLimit: NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  notionEnrichmentBatchSize: NOTION_ENRICHMENT_BATCH_SIZE,
  notionEnrichmentBatchSizeMax: NOTION_ENRICHMENT_BATCH_SIZE_MAX,
  notionChildrenPagesDefault: NOTION_CHILDREN_PAGES_DEFAULT,
  notionRowPagesDefault: NOTION_ROW_PAGES_DEFAULT,
  notionViewPagesDefault: NOTION_VIEW_PAGES_DEFAULT,
  notionTemplatePagesDefault: NOTION_TEMPLATE_PAGES_DEFAULT,
  notionDiscoveryConcurrencyDefault: NOTION_DISCOVERY_CONCURRENCY_DEFAULT,
  notionDiscoveryConcurrencyMax: NOTION_DISCOVERY_CONCURRENCY_MAX,
  notionEnrichBudgetDefault: NOTION_ENRICH_BUDGET_DEFAULT,
  notionDiscoverCallDeadlineMs: NOTION_DISCOVER_CALL_DEADLINE_MS,
  notionDiscoveryProgressIntervalMs: NOTION_DISCOVERY_PROGRESS_INTERVAL_MS,
  requireString,
  optionalString,
  parseStringArray,
  parseBoolean,
  parsePositiveInt,
  asRecord,
  assertWritableImportTarget,
  assertWritableJob,
  notionTokenForJob,
  preflightNotionImportGraph,
  acquireNotionApplyLease,
  startNotionDiscoveryLeaseHeartbeat,
  releaseNotionApplyLease,
  currentNotionDiscoveryResult,
  importItemGeneration,
  notionImportItemEnrichmentComplete,
  listActiveNotionImportItems,
  listActiveNotionImportDiscoverySeeds,
  hydrateNotionImportDiscoverySeeds,
  backfillNotionImportDiscoveryEnrichmentState,
  withImportProgress,
  updateNotionJobIfStatus: (db, jobId, expectedStatus, data, options) => (
    updateNotionJobIfStatus(
      db,
      jobId,
      expectedStatus,
      data as Partial<NotionImportJob>,
      options,
    )
  ),
  discoveryProgressPercent,
  cachedNotionWorkspaceForDiscovery,
  discoverNotionGraph,
  missingRequestedRootIds,
  expandSnapshotItems,
  mergeDiscoveredItems,
  replaceDiscoveredItemsWithGeneration,
  countImportItemsByObject,
  deleteNotionImportJobItems: async (db, jobId): Promise<number> => (
    await deleteNotionImportJobItems(db, jobId)
  ),
  cleanJob,
  cleanItem,
  baseReport,
  mergeImportReportEntries,
  NotionDiscoveryLeaseLostError,
});

const { createJobRecord } = createNotionImportJobCreateHandlers<
  NotionImportJob,
  NotionImportItem,
  DiscoveredNotionItem,
  NotionTokenSource,
  DbRef,
  NotionImportConnectionKind,
  PersistentGeneratedLocale,
  ReturnType<typeof cleanJob>,
  ReturnType<typeof cleanItem>,
  unknown
>({
  notionApiVersion: NOTION_API_VERSION,
  notionSearchPagesDefault: NOTION_SEARCH_PAGES_DEFAULT,
  notionPaginationSafetyPageLimit: NOTION_PAGINATION_SAFETY_PAGE_LIMIT,
  notionEnrichmentBatchSize: NOTION_ENRICHMENT_BATCH_SIZE,
  notionEnrichmentBatchSizeMax: NOTION_ENRICHMENT_BATCH_SIZE_MAX,
  notionChildrenPagesDefault: NOTION_CHILDREN_PAGES_DEFAULT,
  notionRowPagesDefault: NOTION_ROW_PAGES_DEFAULT,
  notionViewPagesDefault: NOTION_VIEW_PAGES_DEFAULT,
  notionTemplatePagesDefault: NOTION_TEMPLATE_PAGES_DEFAULT,
  notionDiscoveryConcurrencyDefault: NOTION_DISCOVERY_CONCURRENCY_DEFAULT,
  notionDiscoveryConcurrencyMax: NOTION_DISCOVERY_CONCURRENCY_MAX,
  notionImportSnapshotItemsPerRequestMax: NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
  requireString,
  optionalString,
  assertWritableImportTarget,
  parseConnectionKind,
  parseStringArray,
  parseSnapshotItems,
  parseMcpFetchItems,
  expandSnapshotItems,
  assertBoundedRequestDiscoveredItems,
  assertSafeNotionImportSourceReferences,
  notionTokenForJob,
  parseBoolean,
  parseServerRunRequestId,
  parsePositiveInt,
  parseOptionalBoolean,
  parsePersistentGeneratedLocale,
  assertNotionFileCopyNotDisabled,
  serverOwnedNotionImportJobId,
  enqueueNotionImportRun,
  cleanJob,
  withImportProgress,
  baseReport,
  isApplyLeaseConflict,
  replaceDiscoveredItems,
  updateNotionJobIfStatus,
  cleanItem,
  discoverJob,
});

const {
  deleteNotionImportJobItems,
  cancelJob,
  retryJob,
} = createNotionImportJobLifecycleHandlers<
  NotionImportJob,
  NotionImportItem,
  DbRef,
  ReturnType<typeof cleanJob>,
  unknown
>({
  requireString,
  assertWritableJob,
  clearNotionImportApplySnapshotCache,
  isLiveImportJob,
  cleanJob,
  updateNotionJobIfStatus,
  withImportProgress,
  scrubMappedImportProductCredentials,
  listActiveNotionImportItems,
  scrubAppliedImportCredentialMetadata,
  trashIncompleteImportPages,
  createJobRecord,
  parseStringArray,
  optionalString,
  parseOptionalBoolean,
  listAll,
  notionImportItemSafetyLimit: NOTION_IMPORT_ITEM_SAFETY_LIMIT,
});

const { runServerOwnedNotionImportChunk } = createNotionImportServerRunner<
  NotionImportJob,
  ReturnType<typeof cleanJob>,
  DbRef,
  FunctionStorageProxy,
  Awaited<ReturnType<typeof discoverJob>>,
  Awaited<ReturnType<typeof planJob>>,
  Awaited<ReturnType<typeof applyJob>>
>({
  optionalString,
  asRecord,
  updateNotionJobIfStatus: (db, jobId, expectedStatus, data) => (
    updateNotionJobIfStatus(
      db,
      jobId,
      expectedStatus,
      data as Partial<NotionImportJob>,
    )
  ),
  withImportProgress,
  notionTokenForJob,
  discoverJob,
  planJob,
  applyJob,
});

export { runServerOwnedNotionImportChunk };

export const POST = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 8 * 1024 * 1024,
  handler: async (context) => {
  const { auth, admin, request, env, storage } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  try {
    const body = await requestJson(request);
    assertNotionImportRequestJsonShape(body);
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
        return await createJobRecord(db, admin, body, auth.id, env);
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
        return await repairImportedPageBlocks(db, admin, body, auth.id, storage, request, env);
      case 'retryFileCopies':
        return await retryFileCopies(db, admin, body, auth.id, storage, request, env);
      case 'cancel':
        {
          const result = await cancelJob(db, body, auth.id);
          await deleteNotionImportRun(admin.db('app'), result.job.id);
          return result;
        }
      case 'retry':
        return await retryJob(db, admin, body, auth.id, env);
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
      {
        status: 413,
        needles: [
          'Notion import request payload is too large',
          'source file is too large',
          'storage limit exceeded',
        ],
      },
      { status: 429, needles: ['Too many requests', 'rate limit', 'Rate limit'] },
      {
        status: 403,
        needles: ['access required', 'active access required', 'outside the workspace', 'belongs to another workspace'],
      },
      { status: 404, needles: ['not found', 'trash'] },
      { status: 423, needles: ['locked'] },
      {
        status: 409,
        needles: [
          'Cannot append discovery items',
          'must be ready before apply',
          'is cancelled',
          'already being applied',
          'already being discovered',
          'Duplicate Notion import mapping',
        ],
      },
      { status: 422, needles: ['found no items'] },
      {
        status: 400,
        needles: [
          'is required',
          'must be',
          'cannot be disabled',
          'unsupported file URL scheme',
          'Active web content files are not allowed',
          'source file size did not match Content-Length',
          'OAuth state is invalid',
          'has expired',
        ],
      },
    ], 500);
    return jsonError(status, message);
  }
  },
});
