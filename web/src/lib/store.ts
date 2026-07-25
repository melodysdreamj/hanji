"use client";

import { create } from "zustand";
import {
  affectedDatabaseRowsFromMutation,
  applyBlockSnapshotRemote,
  bootstrapWorkspace,
  createBlockRemote,
  createBlocksRemote,
  createWorkspaceRemote,
  createCommentRemote,
  createDatabaseRemote,
  configureDatabaseTaskFeatureRemote,
  executeDatabaseButtonRemote,
  executePageButtonRemote,
  createDatabaseRowRemote,
  createPageRemote,
  createPropertyRemote,
  createTemplateRemote,
  createViewRemote,
  currentUserId,
  deleteBlockRemote,
  deleteBlocksRemote,
  deleteDatabaseRowRemote,
  deletePageRemote,
  deletePropertyRemote,
  deleteTemplateRemote,
  deleteViewRemote,
  deleteWorkspaceRemote,
  duplicatePageRemote,
  ensureAuth,
  getDatabaseDependencyRelationRemote,
  getDatabaseRowsRemote,
  getDatabaseSnapshotRemote,
  getPageBlocksRemote,
  getPageCommentsRemote,
  getPageRemote,
  moveDatabaseRowRemote,
  reparentDatabaseSubitemRemote,
  probeWorkspaceChanges,
  rememberWorkspaceCache,
  restorePageRemote,
  restoreDatabaseRowRemote,
  trashPageRemote,
  trashDatabaseRowRemote,
  touchBlockPageRecencyRemote,
  updateBlockRemote,
  updateBlocksRemote,
  updateCommentRemote,
  deleteCommentsRemote,
  updateCommentsRemote,
  updateDatabaseRowRemote,
  updateDatabaseDependencyRelationRemote,
  updatePageRemote,
  updatePropertyRemote,
  updateTemplateRemote,
  updateViewRemote,
  updateWorkspaceRemote,
} from "./edgebase";
import type {
  BlockBatchUpdateRemoteResult,
  BlockPageRecencyProof,
  BlockUpdateRemoteResult,
  CreateWorkspaceInput,
  DatabaseSnapshotResult,
  DatabaseDependencyDirection,
  DatabaseDependencyRelationResult,
  DeleteWorkspaceInput,
  OrganizationDirectoryResult,
  SharedPageResult,
  WorkspaceBootstrapInput,
  WorkspaceMembersResult,
  WorkspaceMutationPatch,
} from "./edgebase";
import {
  changePassphraseSecretBox,
  createPassphraseSecretBox,
  removePassphraseKey,
} from "@edge-base/web";
import { applyView } from "../components/database/query";
import { i18next } from "@/i18n";
import { isKoreanLocale } from "./i18n";
import { activePersistentGeneratedLabels } from "./persistentGeneratedLabels";
import { newId, positionBetween } from "./ids";
import {
  hasDatabaseTemplateStoredFileReference,
  hasStoredFileReference,
} from "./storedFileReferences";
import {
  localBoxIfSettled,
  lockBoxName,
  primeUnlockedGate,
  resetGateToDevice,
  setLocalEncryptionMode,
} from "./localLock";
import {
  clearLegacyBrowserStorage,
  clearLegacyLocalDataOnSignOut,
} from "./legacyNamespace";
import {
  outboxAck,
  outboxAllEntries,
  outboxClaimAbandoned,
  outboxClear,
  outboxRekey,
  outboxSet,
  resetOutboxForTests,
  type BlockStructureInvalidation,
  type DatabaseCreateEffect,
  type MutationOutboxOp,
  type OutboxEntry,
  type OutboxOp,
  type PageRecencyOutboxOp,
  type RemoteCallEffect,
  type RemoteCallTerminalReconciliation,
  type RowFileRemovalEffect,
  type TerminalReconciliationOutboxOp,
} from "./outbox";
import {
  cacheAppendRowPage,
  cacheClearDatabase,
  cacheGetMeta,
  cacheListTable,
  cacheReplaceTable,
  cacheSetMeta,
  cacheUpdateMeta,
  getOfflinePins,
  recordCacheClear,
  registerRowsCacheKey,
  resetRecordCacheForTests,
  stampBlocksCached,
  stampDatabaseCached,
} from "./recordCache";
import {
  databaseRowCacheKeys,
  databaseRowCacheKeysFromSuffix,
  recordCacheMeta,
  recordCacheTables,
} from "./recordCacheKeys";
import {
  applyDefinitiveReadDenial,
  applyLatestRead,
  beginReadApplication,
  deriveReadApplication,
  invalidateReadApplication,
  readApplicationKey,
  resetReadApplicationGuards,
  type ReadApplicationToken,
} from "./readApplicationGuard";
import { runAcknowledgedMutation } from "./mutationLifecycle";
import {
  overlayOutboxOnBlocks,
  overlayOutboxOnComments,
  overlayOutboxOnPages,
} from "./outboxProjection";
import {
  commitPersistedBlockDeletionToCache,
  commitPersistedBlockToCache,
  commitPersistedPagesToCache,
  commitPersistedRelatedPagesToCache,
} from "./persistedMutationCache";
import {
  remapViewConfigPropertyIds,
  viewConfigChanged as configChanged,
  viewConfigWithoutFilterProperty,
  viewConfigWithoutProperty,
} from "./databaseViewConfigModel";
import {
  assertDatabaseUnlocked,
  cloneJson,
  collectPageSubtree,
  hasTrashedAncestor,
  iconTypeForValue,
  isDatabaseLocked,
  isPageParentLocked,
  lockedPageAllowsPatch,
  nowIso,
  persistableBlockPatch,
  persistablePagePatch,
  persistableRowProperties,
  persistableWorkspacePatch,
  stripComputedFromPages,
} from "./storeEntityPolicy";
import { optimisticStarterDatabaseSchema } from "./starterDatabaseModel";
import { createDatabaseStoreActions } from "./databaseStoreSlice";
import {
  clearDeferredBlockCreatesForPage,
  createBlockStoreActions,
  resetDeferredBlockCreates,
} from "./blockStoreSlice";
import { createPageStoreActions } from "./pageStoreSlice";
import { remapPageHref } from "./pageLinks";
import { replaceRoute, routeInfoFromPath } from "./router";
import {
  permanentDeleteIds,
  permanentDeleteCacheCleanupPending,
  permanentDeleteUserIdFromStorageKey,
  markPermanentDeleteCacheCleanupPending,
  rememberPermanentDeleteIds,
} from "./permanentDeleteTombstones";
import {
  cacheWorkspaceFilesForOffline,
  clearOfflineWorkspaceFileCache,
  evictCachedWorkspaceFiles,
  hasCachedWorkspaceFiles,
} from "./offlineFiles";
import {
  evictSignedWorkspaceFileUrl,
  settleSignedWorkspaceFileUrlRequests,
  storageKeyFromUrl,
} from "./fileUrls";
import {
  pageMetaMutationPatch,
  publishLocalDatabaseMutation,
  publishPageRoomMutation,
} from "./pageRoomEvents";
import { linkedDatabaseResolvedTitle, pageDisplayTitle } from "./pageTitle";
import {
  canCommentPage,
  canCreateWorkspacePage,
  canEditPage,
  canManagePage,
} from "./permissions";
import { setWorkspacePeople } from "./peopleDirectory";
import { spansToPlainText } from "./types";
import type {
  Block,
  BlockContent,
  BlockType,
  ButtonTemplateBlock,
  CollaborationBlockStructureAction,
  Comment,
  DbProperty,
  DbTemplate,
  DbView,
  Organization,
  OrganizationAuditEvent,
  OrganizationAuditExport,
  OrganizationBillingRecord,
  OrganizationDomain,
  OrganizationDiscoveryExport,
  OrganizationEnterpriseControls,
  OrganizationGroup,
  OrganizationLegalHold,
  OrganizationMember,
  OrganizationProfile,
  OrganizationScimToken,
  Page,
  PageKind,
  PageParentType,
  PropertyConfig,
  PropertyType,
  SelectOption,
  ShareRole,
  Teamspace,
  TeamspaceSettings,
  TextSpan,
  ViewConfig,
  ViewType,
  Workspace,
  WorkspaceMember,
} from "./types";

const bySortPos = <T extends { position: number; __databaseRowOrder?: number }>(a: T, b: T) =>
  (a.__databaseRowOrder ?? a.position) - (b.__databaseRowOrder ?? b.position) ||
  a.position - b.position;
const byCreated = (a: { createdAt?: string }, b: { createdAt?: string }) =>
  (a.createdAt ?? "").localeCompare(b.createdAt ?? "");

function databaseNeedsComputedValues(props: DbProperty[]) {
  return props.some((prop) => prop.type === "formula" || prop.type === "rollup");
}

function templateTitleValue(template?: Pick<DbTemplate, "title">) {
  const title = template?.title?.trim() ?? "";
  return title ? (template?.title ?? "") : "";
}

const TEMPLATE_EDITOR_PAGE_PREFIX = "template:";

function isTemplateEditorPageId(pageId?: string | null) {
  return typeof pageId === "string" && pageId.startsWith(TEMPLATE_EDITOR_PAGE_PREFIX);
}

export type BlockHistoryMode = "push" | "merge";
type FocusPageTarget = "title" | "body";
export interface BlockStructureHistoryOperation {
  action: CollaborationBlockStructureAction;
  pageId: string;
  blockIds: string[];
  before: Block[];
  after: Block[];
  occurredAt: string;
}
export interface BlockHistoryEntry {
  /** Authenticated local actor that created this undo/version snapshot. */
  actorId?: string;
  blocks: Block[];
  operations?: BlockStructureHistoryOperation[];
  at: number;
  mode: BlockHistoryMode;
  /** Cross-page moves are ONE logical undo unit: twin entries (same link id)
   *  sit on both pages' stacks, undo/redo from either page applies the shared
   *  operation to both pages and consumes the twin on the other stack. */
  link?: { id: string; pageId: string };
}
export interface BlockHistory {
  past: BlockHistoryEntry[];
  future: BlockHistoryEntry[];
}

export interface ToastMessage {
  id: string;
  message: string;
  tone?: "default" | "success" | "error";
  action?: {
    label: string;
    onClick: () => void | Promise<void>;
  };
}

export interface DeletedPropertySnapshot {
  dbId: string;
  property: DbProperty;
  rows: Array<{ id: string; properties?: Page["properties"] }>;
  views: Array<{ id: string; config?: ViewConfig }>;
  templates: Array<{ id: string; properties?: DbTemplate["properties"] }>;
  relatedProperties: Array<{ id: string; config?: PropertyConfig }>;
}

export interface DeletedPropertyOptionSnapshot {
  dbId: string;
  propertyId: string;
  option: SelectOption;
  optionIndex: number;
  rows: Array<{ id: string; value: unknown }>;
}

// A client snapshot only contains the currently loaded/paginated rows. Until
// the backend owns a complete inverse journal and option cascade, exposing
// these client-side restore/delete paths can silently corrupt unloaded rows.
// Keep the methods fail-closed for persisted outbox compatibility while the
// release UI omits the unsafe actions.
const CLIENT_SCHEMA_RESTORE_ENABLED = false;
const CLIENT_PROPERTY_OPTION_DELETE_ENABLED = false;

const HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 1400;
const RECENT_LIMIT = 24;
const TREE_EXPANDED_LIMIT = 500;

function cloneValue<T>(value: T): T {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function remapRichTextPageReferences(spans: TextSpan[] | undefined, pageMap?: Map<string, string>) {
  return spans?.map((span) => {
    let next: TextSpan = span;
    if (span.pageId) {
      const pageId = pageMap?.get(span.pageId) ?? span.pageId;
      if (pageId !== span.pageId) next = { ...next, pageId };
    }
    const link = remapPageHref(span.link, pageMap);
    if (link !== span.link) next = { ...next, link };
    return next;
  });
}

function remapButtonTemplateBlocks(
  blocks: ButtonTemplateBlock[] | undefined,
  pageMap?: Map<string, string>,
  blockMap?: Map<string, string>
): ButtonTemplateBlock[] | undefined {
  return blocks?.map((block) => ({
    ...block,
    content: remapBlockContent(block.content, pageMap, blockMap),
    children: remapButtonTemplateBlocks(block.children, pageMap, blockMap),
  }));
}

function remapBlockContent(
  content: BlockContent | undefined,
  pageMap?: Map<string, string>,
  blockMap?: Map<string, string>
): BlockContent | undefined {
  const next = cloneValue(content);
  if (!next) return next;

  if (next.childPageId) next.childPageId = pageMap?.get(next.childPageId) ?? next.childPageId;
  if (next.syncedBlockId) {
    const nextBlockId = blockMap?.get(next.syncedBlockId);
    if (nextBlockId) {
      next.syncedBlockId = nextBlockId;
      if (next.syncedPageId) next.syncedPageId = pageMap?.get(next.syncedPageId) ?? next.syncedPageId;
    }
  } else if (next.syncedPageId) {
    next.syncedPageId = pageMap?.get(next.syncedPageId) ?? next.syncedPageId;
  }
  next.rich = remapRichTextPageReferences(next.rich, pageMap);
  next.caption = remapRichTextPageReferences(next.caption, pageMap);
  next.buttonTemplate = remapButtonTemplateBlocks(next.buttonTemplate, pageMap, blockMap);
  return next;
}

function cloneBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => ({
    ...block,
    content: cloneValue(block.content),
  }));
}

function recentKey(workspaceId?: string) {
  return `hanji.recentPageIds.${workspaceId || "default"}`;
}

function treeExpandedKey(workspaceId?: string) {
  return `hanji.treeExpandedPageIds.v2.${workspaceId || "default"}`;
}

function readRecentPageIds(workspaceId?: string) {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(recentKey(workspaceId));
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeRecentPageIds(workspaceId: string | undefined, ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(recentKey(workspaceId), JSON.stringify(ids.slice(0, RECENT_LIMIT)));
  } catch {
    /* localStorage can be unavailable in private or constrained contexts */
  }
}

function readTreeExpandedPageIds(workspaceId?: string) {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(treeExpandedKey(workspaceId));
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeTreeExpandedPageIds(workspaceId: string | undefined, ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(treeExpandedKey(workspaceId), JSON.stringify(ids.slice(0, TREE_EXPANDED_LIMIT)));
  } catch {
    /* localStorage can be unavailable in private or constrained contexts */
  }
}

function snapshotsEqual(a: Block[], b: Block[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function structureBlockSnapshot(block: Block): Block {
  return {
    ...block,
    parentId: block.parentId ?? null,
    content: cloneValue(block.content),
  };
}

function blockStructurePatch(block: Block): Partial<Block> {
  return {
    pageId: block.pageId,
    parentId: block.parentId ?? null,
    position: block.position,
    updatedAt: block.updatedAt ?? nowIso(),
  };
}

function isStructureOnlyPatch(patch: Partial<Block>) {
  const keys = Object.keys(patch).filter((key) => key !== "updatedAt");
  if (!keys.some((key) => key === "pageId" || key === "parentId" || key === "position")) return false;
  return keys.every((key) => key === "pageId" || key === "parentId" || key === "position");
}

function blockPatchChangesStructure(patch: Partial<Block>) {
  return "pageId" in patch || "parentId" in patch || "position" in patch;
}

const MAX_BLOCK_STRUCTURE_INVALIDATION_PAGES = 100;
const MAX_BLOCK_STRUCTURE_INVALIDATION_IDS = 100;

function blockStructureInvalidation(
  pageIds: Iterable<unknown>,
  blockIds?: Iterable<unknown>
): BlockStructureInvalidation | undefined {
  const normalizedPageIds = Array.from(
    new Set(
      Array.from(pageIds)
        .filter((pageId): pageId is string => typeof pageId === "string")
        .map((pageId) => pageId.trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_BLOCK_STRUCTURE_INVALIDATION_PAGES);
  if (normalizedPageIds.length === 0) return undefined;
  const normalizedBlockIds = blockIds
    ? Array.from(
        new Set(
          Array.from(blockIds)
            .filter((blockId): blockId is string => typeof blockId === "string")
            .map((blockId) => blockId.trim())
            .filter(Boolean)
        )
      ).slice(0, MAX_BLOCK_STRUCTURE_INVALIDATION_IDS)
    : [];
  return {
    pageIds: normalizedPageIds,
    ...(normalizedBlockIds.length > 0 ? { blockIds: normalizedBlockIds } : {}),
  };
}

function inferStructureAction(before: Block[], after: Block[]): CollaborationBlockStructureAction {
  if (before.length === 0 && after.length > 0) return "create";
  if (before.length > 0 && after.length === 0) return "delete";
  const firstBefore = before[0];
  const firstAfter = after.find((block) => block.id === firstBefore?.id) ?? after[0];
  if (firstBefore && firstAfter && (firstBefore.parentId ?? null) !== (firstAfter.parentId ?? null)) {
    if (firstAfter.parentId && !firstBefore.parentId) return "indent";
    if (firstBefore.parentId && !firstAfter.parentId) return "outdent";
  }
  return "move";
}

function removeBlocksFromPages(
  blocksByPage: Record<string, Block[]>,
  blockIds: Set<string>
): Record<string, Block[]> {
  const next: Record<string, Block[]> = {};
  for (const [pageId, blocks] of Object.entries(blocksByPage)) {
    next[pageId] = blocks.filter((block) => !blockIds.has(block.id));
  }
  return next;
}

function upsertBlocksIntoPages(
  blocksByPage: Record<string, Block[]>,
  blocks: Block[],
  opts: { structuralOnly?: boolean } = {}
): Record<string, Block[]> {
  const next = removeBlocksFromPages(blocksByPage, new Set(blocks.map((block) => block.id)));
  for (const block of blocks) {
    const current = Object.values(blocksByPage).flat().find((candidate) => candidate.id === block.id);
    const inserted =
      opts.structuralOnly && current
        ? {
            ...current,
            pageId: block.pageId,
            parentId: block.parentId ?? null,
            position: block.position,
            updatedAt: block.updatedAt ?? nowIso(),
          }
        : structureBlockSnapshot(block);
    next[inserted.pageId] = [...(next[inserted.pageId] ?? []), inserted].sort(bySortPos);
  }
  return next;
}

function historyOperationTarget(
  operation: BlockStructureHistoryOperation,
  direction: "undo" | "redo"
) {
  if (operation.action === "create") {
    return direction === "undo"
      ? { remove: operation.after, upsert: [], structuralOnly: false }
      : { remove: [], upsert: operation.after, structuralOnly: false };
  }
  if (operation.action === "delete") {
    return direction === "undo"
      ? { remove: [], upsert: operation.before, structuralOnly: false }
      : { remove: operation.before, upsert: [], structuralOnly: false };
  }
  if (operation.action === "restore") {
    return direction === "undo"
      ? { remove: operation.after, upsert: [], structuralOnly: false }
      : { remove: [], upsert: operation.after, structuralOnly: false };
  }
  return direction === "undo"
    ? { remove: [], upsert: operation.before, structuralOnly: true }
    : { remove: [], upsert: operation.after, structuralOnly: true };
}

/**
 * After undoing/redoing a linked (cross-page move) entry from one page,
 * consume its twin on the other page's stack: the shared operation already
 * restored BOTH pages, so leaving the twin behind would double-apply it. The
 * twin migrates to the opposite stack so redo/undo works from either page.
 */
function consumeLinkedTwin(
  historyByPage: Record<string, BlockHistory>,
  link: BlockHistoryEntry["link"],
  direction: "undo" | "redo"
): Record<string, BlockHistory> {
  if (!link) return historyByPage;
  const other = historyByPage[link.pageId];
  if (!other) return historyByPage;
  const fromStack = direction === "undo" ? other.past : other.future;
  const index = fromStack.findLastIndex((entry) => entry.link?.id === link.id);
  if (index < 0) return historyByPage;
  const twin = fromStack[index];
  const remaining = fromStack.slice(0, index).concat(fromStack.slice(index + 1));
  return {
    ...historyByPage,
    [link.pageId]:
      direction === "undo"
        ? { past: remaining, future: other.future.concat(twin).slice(-HISTORY_LIMIT) }
        : { past: other.past.concat(twin).slice(-HISTORY_LIMIT), future: remaining },
  };
}

function blockHistoryOwnsOperation(
  entry: BlockHistoryEntry | undefined,
  operation: BlockStructureHistoryOperation
) {
  return entry?.operations?.some(
    (candidate) =>
      candidate === operation ||
      (candidate.action === operation.action &&
        candidate.pageId === operation.pageId &&
        candidate.occurredAt === operation.occurredAt &&
        JSON.stringify(candidate.blockIds) === JSON.stringify(operation.blockIds))
  ) ?? false;
}

function blockStructureDropReconciliation(
  operation: BlockStructureHistoryOperation,
  direction: "undo" | "redo",
  pageIds: string[]
): NonNullable<BlockStructureInvalidation["dropReconciliation"]> | undefined {
  const historyByPage = useStore.getState().blockHistoryByPage;
  const histories = pageIds.flatMap((pageId) => {
    const history = historyByPage[pageId];
    const entry = (direction === "undo" ? history?.past : history?.future)?.at(-1);
    if (!blockHistoryOwnsOperation(entry, operation)) return [];
    return [{
      at: entry!.at,
      ...(entry!.link?.id ? { linkId: entry!.link.id } : {}),
      operationOccurredAt: operation.occurredAt,
      pageId,
    }];
  });
  return histories.length > 0 ? { direction, histories } : undefined;
}

async function persistBlockStructureOperation(
  operation: BlockStructureHistoryOperation,
  direction: "undo" | "redo",
  beforeTerminalReconciliation?: BeforeTerminalReconciliation
) {
  const target = historyOperationTarget(operation, direction);
  const removals = target.remove.map((block) => block.id);
  const shouldCreate =
    (operation.action === "create" && direction === "redo") ||
    (operation.action === "delete" && direction === "undo") ||
    (operation.action === "restore" && direction === "redo");
  const creates = shouldCreate ? target.upsert : [];
  const updates = shouldCreate ? [] : target.upsert;
  const hintPageId =
    target.upsert[0]?.pageId ?? target.remove[0]?.pageId ?? undefined;
  const baseInvalidation = blockStructureInvalidation(
    [
      operation.pageId,
      ...operation.before.map((block) => block.pageId),
      ...operation.after.map((block) => block.pageId),
    ],
    operation.blockIds
  );
  const dropReconciliation = baseInvalidation
    ? blockStructureDropReconciliation(operation, direction, baseInvalidation.pageIds)
    : undefined;
  const invalidation = baseInvalidation
    ? {
        ...baseInvalidation,
        ...(dropReconciliation ? { dropReconciliation } : {}),
      }
    : undefined;
  // Durable one-shots: transient failures queue + retry instead of silently
  // dropping the structural undo/redo. Return each first-attempt outcome so
  // the history action can distinguish a durable queued operation from a
  // terminal drop and avoid announcing a version restore that never landed.
  const calls: Array<Promise<DurableCallResult>> = [];
  if (removals.length) {
    calls.push(
      durableRemoteCall(
        "deleteBlocksRemote",
        [removals, hintPageId],
        undefined,
        invalidation,
        undefined,
        beforeTerminalReconciliation
      )
    );
  }
  if (updates.length) {
    if (operation.action === "move") {
      // The backend's single structural update owns subtree restamping. A
      // multi-block structural batch is intentionally rejected, so sending
      // every descendant made cross-page moves with children fail 400.
      const movedIds = new Set(updates.map((block) => block.id));
      const root = updates.find((block) => !block.parentId || !movedIds.has(block.parentId));
      if (root) {
        calls.push(
          durableRemoteCall("updateBlockRemote", [
            root.id,
            blockStructurePatch(root),
            hintPageId,
          ], undefined, invalidation, undefined, beforeTerminalReconciliation)
        );
      }
    } else {
      calls.push(
        durableRemoteCall("updateBlocksRemote", [
          updates.map((block) => ({
            id: block.id,
            patch: blockStructurePatch(block),
          })),
          hintPageId,
        ], undefined, invalidation, undefined, beforeTerminalReconciliation)
      );
    }
  }
  if (creates.length) {
    calls.push(
      durableRemoteCall(
        "createBlocksRemote",
        [creates],
        undefined,
        invalidation,
        undefined,
        beforeTerminalReconciliation
      )
    );
  }
  return Promise.all(calls);
}

async function persistBlockSnapshot(
  pageId: string,
  before: Block[],
  after: Block[],
  beforeTerminalReconciliation?: BeforeTerminalReconciliation
) {
  const beforeById = new Map(before.map((block) => [block.id, block]));
  const afterById = new Map(after.map((block) => [block.id, block]));
  for (const block of before) cancelPendingBlock(block.id);
  for (const block of after) cancelPendingBlock(block.id);

  const creates = after.filter((block) => !beforeById.has(block.id));
  const updates = after.flatMap((block) => {
    const previous = beforeById.get(block.id);
    if (!previous || snapshotsEqual([previous], [block])) return [];
    const previousPatch = persistableBlockPatch(previous);
    const nextPatch = persistableBlockPatch(block);
    const patch = Object.fromEntries(
      Object.entries(nextPatch).filter(
        ([key, value]) => !jsonValuesEqual(previousPatch[key as keyof Block], value)
      )
    ) as Partial<Block>;
    return [{ block, patch, previous }];
  });
  const removals = before.filter((block) => !afterById.has(block.id));
  const classCount = Number(creates.length > 0)
    + Number(updates.length > 0)
    + Number(removals.length > 0);
  const calls: Array<Promise<DurableCallResult>> = [];
  const createChunkById = new Map(
    creates.map((block, index) => [block.id, Math.floor(index / BLOCK_BATCH_CHUNK_SIZE)])
  );
  const createsCanBatch = creates.every((block, index) => {
    if (hasStoredFileReference(block.content)) return false;
    const parentChunk = block.parentId ? createChunkById.get(block.parentId) : undefined;
    return parentChunk === undefined || parentChunk === Math.floor(index / BLOCK_BATCH_CHUNK_SIZE);
  });
  const updatesCanBatch = updates.every(({ patch, previous, block }) =>
    !("pageId" in patch)
    && !("parentId" in patch)
    && !(
      "content" in patch
      && (hasStoredFileReference(previous.content) || hasStoredFileReference(block.content))
    )
  );
  const compatibleMixedSnapshot = classCount > 1
    && creates.length + updates.length + removals.length <= BLOCK_BATCH_CHUNK_SIZE
    && createsCanBatch
    && creates.every((block) => !block.parentId)
    && updatesCanBatch
    && updates.every(({ patch }) => !("position" in patch))
    && removals.every((block) => !block.parentId && !hasStoredFileReference(block.content));

  if (compatibleMixedSnapshot) {
    calls.push(
      durableBlockSnapshotCall(
        {
          creates,
          deleteIds: removals.map(({ id }) => id),
          pageId,
          updates: updates.map(({ block, patch }) => ({ id: block.id, patch })),
        },
        beforeTerminalReconciliation
      )
    );
  } else if (
    classCount === 1
    && creates.length > 1
    && createsCanBatch
  ) {
    for (let index = 0; index < creates.length; index += BLOCK_BATCH_CHUNK_SIZE) {
      calls.push(
        durableRemoteCall(
          "createBlocksRemote",
          [creates.slice(index, index + BLOCK_BATCH_CHUNK_SIZE)],
          undefined,
          undefined,
          undefined,
          beforeTerminalReconciliation
        )
      );
    }
  } else if (
    classCount === 1
    && updates.length > 1
    && updatesCanBatch
  ) {
    for (let index = 0; index < updates.length; index += BLOCK_BATCH_CHUNK_SIZE) {
      calls.push(
        durableRemoteCall(
          "updateBlocksRemote",
          [
            updates
              .slice(index, index + BLOCK_BATCH_CHUNK_SIZE)
              .map(({ block, patch }) => ({ id: block.id, patch })),
            pageId,
          ],
          undefined,
          undefined,
          undefined,
          beforeTerminalReconciliation
        )
      );
    }
  } else if (classCount === 1 && removals.length > 1) {
    for (let index = 0; index < removals.length; index += BLOCK_BATCH_CHUNK_SIZE) {
      calls.push(
        durableRemoteCall(
          "deleteBlocksRemote",
          [
            removals
              .slice(index, index + BLOCK_BATCH_CHUNK_SIZE)
              .map((block) => block.id),
            pageId,
          ],
          undefined,
          undefined,
          undefined,
          beforeTerminalReconciliation
        )
      );
    }
  } else {
    for (const block of creates) {
      calls.push(
        durableRemoteCall(
          "createBlockRemote",
          [block],
          undefined,
          undefined,
          undefined,
          beforeTerminalReconciliation
        )
      );
    }
    for (const { block } of updates) {
      calls.push(
        durableRemoteCall(
          "updateBlockRemote",
          [block.id, persistableBlockPatch(block), pageId],
          undefined,
          undefined,
          undefined,
          beforeTerminalReconciliation
        )
      );
    }
    for (const block of removals) {
      calls.push(
        durableRemoteCall(
          "deleteBlockRemote",
          [block.id, pageId],
          undefined,
          undefined,
          undefined,
          beforeTerminalReconciliation
        )
      );
    }
  }
  return Promise.all(calls);
}

// Debounced persistence. Pending patches are *accumulated and merged* per id so
// that (a) an immediate write flushes and cancels any pending debounced write
// (no stale-closure clobber), and (b) edits to different fields of the same row
// within the debounce window are not lost (e.g. title vs properties).
const blockTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pageTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pageFlushes = new Map<string, Promise<void>>();
const blockFlushes = new Map<string, Promise<void>>();
const blockBatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const blockBatchFlushes = new Map<string, Promise<void>>();
const BLOCK_BATCH_CHUNK_SIZE = 100;
const BLOCK_BATCH_DEBOUNCE_MS = 1000;
const PAGE_RECENCY_WINDOW_MS = 5000;
const PAGE_RECENCY_DRAIN_CHUNK_SIZE = 100;
const PAGE_RECENCY_MAX_IN_FLIGHT = 4;
type LivePageRecencyGeneration = {
  epoch: number;
  operation: PageRecencyOutboxOp;
  userId: string;
};
const pendingPageRecency = new Map<string, LivePageRecencyGeneration>();
const pageRecencyInFlight = new Map<string, Promise<"retry" | "settled">>();
const pageRecencyInFlightGeneration = new Map<string, LivePageRecencyGeneration>();
const pageRecencyRetryAttempts = new Map<string, number>();
let pageRecencyTimer: ReturnType<typeof setTimeout> | undefined;
let pageRecencyTimerDueAt = Number.POSITIVE_INFINITY;
let pageRecencyDrain: Promise<void> | undefined;
let pageRecencyEpoch = 0;
const blockLoadPromises = new Map<string, Promise<void>>();
// Undo/redo serialization: a re-entrant Cmd+Z during the awaited persist would
// read the same stacks and collapse two undos into one. Later calls QUEUE
// behind the in-flight one (not ignored) so N keystrokes mean N undos.
const blockHistoryGates = new Map<string, Promise<unknown>>();

function serializeBlockHistory<T>(pageId: string, run: () => Promise<T>): Promise<T> {
  const previous = blockHistoryGates.get(pageId) ?? Promise.resolve();
  const next = previous.then(run, run);
  blockHistoryGates.set(pageId, next.catch(() => {}));
  return next;
}
// Derived block lists memoized on structural source identity — see
// topLevelBlocks/childBlocks. Content-only immutable replacements retain the
// prior structural source through this weak lineage; actual membership/order
// changes use their new array identity and invalidate every projection.
// Entries are bounded by page/parent count, while obsolete array generations
// remain weakly held and are reclaimed with the canonical state they describe.
const EMPTY_BLOCK_LIST: Block[] = [];
const topLevelBlocksCache = new Map<string, { source: Block[]; result: Block[] }>();
const childBlocksCache = new Map<string, { source: Block[]; result: Block[] }>();
const blockStructureSources = new WeakMap<Block[], Block[]>();

// Comments load SWR-style: a repeat loadComments call refreshes in the
// background (deduped + rate-limited) instead of early-returning forever, so
// a collaborator's new comment shows up without a full reload.
const commentLoadPromises = new Map<string, Promise<void>>();
const commentFetchedAt = new Map<string, number>();
const COMMENT_REFRESH_MIN_GAP_MS = 1500;
type CommentSignalRefreshState = {
  cancelled: boolean;
  drain?: Promise<void>;
  lastStartedAt?: number;
  pending: boolean;
  timer?: ReturnType<typeof setTimeout>;
  wakeTimer?: () => void;
};
const commentSignalRefreshes = new Map<string, CommentSignalRefreshState>();

function waitForCommentSignalRefreshWindow(
  state: CommentSignalRefreshState,
  delayMs: number,
) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const wake = () => {
      if (settled) return;
      settled = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      state.wakeTimer = undefined;
      resolve();
    };
    state.wakeTimer = wake;
    state.timer = setTimeout(wake, delayMs);
  });
}

function resetCommentSignalRefreshes() {
  for (const state of commentSignalRefreshes.values()) {
    state.cancelled = true;
    state.pending = false;
    state.wakeTimer?.();
  }
  commentSignalRefreshes.clear();
}
const pendingBlock = new Map<string, Partial<Block>>();
// Owning page per pending block — routing hint for the workspace-DO split.
const pendingBlockPage = new Map<string, string>();
// Server stamp of the block when its pending patch was FIRST enqueued.
// Mirrored into the durable outbox so a crash/offline replay can send the
// optimistic-concurrency guard (expectedUpdatedAt) — a replayed full-field
// patch must not silently clobber what another device wrote meanwhile.
const pendingBlockBase = new Map<string, string>();
// Stable receipt for one coalesced block generation. If a response is lost,
// replaying the same id is an idempotent acknowledgement, not a self-conflict.
const pendingBlockMutationId = new Map<string, string>();
// While generation N is in flight, generation N+1 can be based on either the
// old server stamp (N did not land) or N's receipt (N landed but the browser
// refreshed before its authoritative timestamp was mirrored).
const pendingBlockExpectedMutationId = new Map<string, string>();
const inFlightBlockMutationId = new Map<string, string>();
const pendingPage = new Map<string, Partial<Page>>();
// Ordinary pages and database rows share one durable generation contract.
// The timestamp protects the first generation; the predecessor receipt keeps
// a newer generation safe whether its in-flight predecessor landed or not.
const pendingPageBase = new Map<string, string>();
const pendingPageMutationId = new Map<string, string>();
const pendingPageExpectedMutationId = new Map<string, string>();
const inFlightPageMutationId = new Map<string, string>();
// A replacement outbox generation must include every still-unacknowledged
// field from its predecessor so a tab close cannot lose a different page key.
const inFlightPagePatch = new Map<string, Partial<Page>>();
// Each page/row generation carries both the state it started from and the
// promise for its local durable mirror. The remote write may start only after
// that exact generation can survive a reload.
const pendingPageBefore = new Map<string, Page>();
const pendingPageDurability = new Map<string, Promise<void>>();
// A row/page patch stays projected over delayed server snapshots until a
// response actually contains it. `pendingPage` deliberately removes a patch
// while its request is in flight, which used to let an older forced database
// query visually resurrect a relation/value and feed that stale state into a
// later cell edit on high-latency appliances.
const optimisticPageOverlays = new Map<string, Partial<Page>>();
// Block loads need the same protection as database rows: pendingBlock removes
// a patch while its request is in flight, and the server/cache may still
// return the older block during that window on a slow appliance.
const optimisticBlockOverlays = new Map<string, Partial<Block>>();
type PendingPageCreate = { originHref: string; page: Page; userId: string };
const pendingPageCreate = new Map<string, PendingPageCreate>();
const pageCreateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pageCreateInFlight = new Map<string, Promise<void>>();
const pendingDatabaseCreate = new Map<string, string>();
const pendingDatabaseRowCreate = new Map<string, string>();
const pendingPropertyCreate = new Map<string, string>();
const pendingViewCreate = new Map<string, string>();
const pendingTemplateCreate = new Map<string, string>();
const pendingCommentCreate = new Map<string, string>();
const PERSIST_RETRY_MS = 2000;
const PERSIST_RETRY_MAX_MS = 30_000;
// Invalidates any network/cache load that began before a permanent-delete
// tombstone or a cross-tab deletion signal landed.
let workspaceDataEpoch = 0;

function advanceWorkspaceDataEpoch() {
  workspaceDataEpoch += 1;
  clearRecentDatabaseRowsQueries();
}

// ── sync health (SyncStatusBadge) ───────────────────────────────────────────
// Consecutive transient persist failures while the browser thinks it's online
// mean the server is unreachable (navigator.onLine can't see that). Expose it
// so the badge can say "can't reach server" instead of an eternal "Syncing".
const SYNC_DEGRADED_AFTER_FAILURES = 3;
let persistFailureStreak = 0;

function noteSyncFailure() {
  persistFailureStreak += 1;
  if (persistFailureStreak >= SYNC_DEGRADED_AFTER_FAILURES && !useStore.getState().syncDegraded) {
    useStore.setState({ syncDegraded: true });
  }
}

function noteSyncSuccess() {
  persistFailureStreak = 0;
  if (useStore.getState().syncDegraded) useStore.setState({ syncDegraded: false });
}

// User-facing toast/error copy. store.ts is not a component, so the labels are
// resolved with i18next.t at call time (locale cannot change mid-session).
function storeMessages() {
  return {
    conflictSave: i18next.t("store:conflictSave"),
    databaseLockedSave: i18next.t("store:databaseLockedSave"),
    databaseRowsLoadFailed: i18next.t("store:databaseRowsLoadFailed"),
    editAccessDeniedSave: i18next.t("store:editAccessDeniedSave"),
    lockedSave: i18next.t("store:lockedSave"),
    pageLockedSave: i18next.t("store:pageLockedSave"),
    pageMissingSave: i18next.t("store:pageMissingSave"),
    saveFailed: i18next.t("store:saveFailed"),
    sessionExpired: i18next.t("store:sessionExpired"),
    blockConflictSave: i18next.t("store:blockConflictSave"),
    blockConflictKeepMine: i18next.t("store:blockConflictKeepMine"),
    blockMoveCommentsSkipped: i18next.t("store:blockMoveCommentsSkipped"),
  };
}

function persistErrorStatus(error: unknown) {
  const record = error as { status?: unknown; code?: unknown } | null;
  const status = record?.status ?? record?.code;
  return typeof status === "number" ? status : undefined;
}

function shouldDropPersistError(error: unknown) {
  const status = persistErrorStatus(error);
  // 404 means the row/block was deleted before the delayed save arrived.
  // 400/403/409/413/422/423 are not transient either (413 is the backend's
  // materialization cap — retrying the same oversized payload can never
  // succeed); keep retrying only for network, auth refresh, rate limit, and
  // server hiccups.
  return (
    status === 400 ||
    status === 403 ||
    status === 404 ||
    status === 409 ||
    status === 413 ||
    status === 422 ||
    status === 423
  );
}

function persistDropMessage(error: unknown) {
  const status = persistErrorStatus(error);
  if (status === 401) return storeMessages().sessionExpired;
  if (status === 403) return storeMessages().editAccessDeniedSave;
  if (status === 409) return storeMessages().conflictSave;
  if (status === 423) return storeMessages().lockedSave;
  if (status === 404) return storeMessages().pageMissingSave;
  if (status === 400 || status === 413 || status === 422) return storeMessages().saveFailed;
  return undefined;
}

function notifyPersistDrop(error: unknown) {
  const message = persistDropMessage(error);
  // Every drop here means an edit the user can still SEE locally was never
  // persisted (it reverts on reload) — surface it as an error, not a whisper.
  if (message) useStore.getState().notify(message, "error");
}

// ── durable outbox mirroring (local-first Phase 0) ──────────────────────────
// The in-memory pending maps stay authoritative; each enqueue/merge mirrors the
// entry into the per-user IndexedDB outbox and each ack/terminal-drop removes
// it, so queued-but-unsent mutations survive tab close/crash/reload. Patches
// are mirrored in persistable form with their DO routing captured at enqueue
// time, because replay may run before (or without) this workspace's records
// being loaded.

function outboxUserId() {
  return useStore.getState().userId || "";
}

function mirrorPendingPage(id: string): Promise<void> {
  const patch = pendingPage.get(id);
  if (!patch || !Object.keys(patch).length) return Promise.resolve();
  const page = useStore.getState().pagesById[id];
  const durability = outboxSet(outboxUserId(), `page:${id}`, {
    expectedMutationId: pendingPageExpectedMutationId.get(id),
    expectedUpdatedAt: pendingPageBase.get(id),
    id,
    kind: "page_update",
    mutationId: pendingPageMutationId.get(id),
    patch: persistablePagePatch(patch, page),
    target: page?.parentType === "database" ? "database_row" : "page",
  });
  pendingPageDurability.set(id, durability);
  return durability;
}

function remotePageWithOptimisticOverlay(page: Page): Page {
  let optimistic = optimisticPageOverlays.get(page.id);
  if (
    optimistic &&
    Object.entries(optimistic).every(([key, value]) =>
      jsonValuesEqual((page as unknown as Record<string, unknown>)[key], value)
    )
  ) {
    optimisticPageOverlays.delete(page.id);
    optimistic = undefined;
  }
  const pending = pendingPage.get(page.id);
  if (!optimistic && (!pending || Object.keys(pending).length === 0)) return page;
  return { ...page, ...(optimistic ?? {}), ...(pending ?? {}) };
}

function remoteBlockWithOptimisticOverlay(block: Block): Block {
  let optimistic = optimisticBlockOverlays.get(block.id);
  if (
    optimistic &&
    Object.entries(optimistic).every(([key, value]) =>
      jsonValuesEqual((block as unknown as Record<string, unknown>)[key], value)
    )
  ) {
    optimisticBlockOverlays.delete(block.id);
    optimistic = undefined;
  }
  const pending = pendingBlock.get(block.id);
  if (!optimistic && (!pending || Object.keys(pending).length === 0)) return block;
  return { ...block, ...(optimistic ?? {}), ...(pending ?? {}) };
}

/**
 * A successful mutation is not fully acknowledged locally until the warm
 * caches can reproduce it. On a slow NAS, otherwise an immediate reload first
 * renders the pre-save IndexedDB value and waits several seconds for network
 * revalidation even though the server already returned the authoritative row.
 */
async function reconcilePersistedPageMutations(
  id: string,
  persisted: Page | undefined,
  affectedRows: Iterable<Page> = []
) {
  const source = persisted ?? useStore.getState().pagesById[id];
  if (!source) return;
  const sourceDatabaseId =
    source.parentType === "database" && source.parentId ? source.parentId : undefined;
  const sourceQueryKeys = new Set<string>([databaseRowsQueryKey({})]);
  if (sourceDatabaseId) {
    const activeQuery =
      useStore.getState().databaseRowPagesByDb[sourceDatabaseId]?.queryKey;
    if (activeQuery) sourceQueryKeys.add(activeQuery);
  }
  const relationPropertyIds = sourceDatabaseId
    ? new Set(
        (useStore.getState().propsByDb[sourceDatabaseId] ?? [])
          .filter((property) => property.type === "relation")
          .map((property) => property.id),
      )
    : new Set<string>();
  const selectedRelationTargetIds = new Set<string>();
  for (const propertyId of relationPropertyIds) {
    const value = source.properties?.[propertyId];
    if (!Array.isArray(value)) continue;
    for (const targetId of value) {
      if (typeof targetId === "string" && targetId && targetId !== source.id) {
        selectedRelationTargetIds.add(targetId);
      }
    }
  }
  const selectedRelationTargetPages: Page[] = [];

  function* authoritativePages() {
    yield source;
    for (const affectedRow of affectedRows) {
      if (selectedRelationTargetIds.has(affectedRow.id)) {
        selectedRelationTargetPages.push(affectedRow);
      }
      if (affectedRow.id !== id) yield affectedRow;
    }
  }

  // Projection and cache-input collection advance lazily with the bounded
  // cache chunks. A resolver runs inside the first queued surface task so a
  // newer optimistic generation created while the cache tail is held wins.
  function* cacheEntries() {
    for (const authoritative of authoritativePages()) {
      const projected = remotePageWithOptimisticOverlay(authoritative);
      useStore.setState((state) => {
        if (!state.pagesById[authoritative.id]) return {};
        return {
          pagesById: {
            ...state.pagesById,
            [authoritative.id]: projected,
          },
        };
      });

      const queryKeys = new Set<string>([databaseRowsQueryKey({})]);
      if (authoritative.parentType === "database" && authoritative.parentId) {
        const activeQuery =
          useStore.getState().databaseRowPagesByDb[authoritative.parentId]?.queryKey;
        if (activeQuery) queryKeys.add(activeQuery);
      }
      yield {
        activeQueryKeys: queryKeys,
        page: projected,
        resolvePage: () => remotePageWithOptimisticOverlay(authoritative),
      };
    }
  }

  const entries = cacheEntries();
  const userId = outboxUserId();
  if (!userId) {
    for (const entry of entries) void entry;
    return;
  }
  await commitPersistedPagesToCache({
    bootstrapKey: bootKey || undefined,
    pages: entries,
    userId,
  });
  if (sourceDatabaseId && selectedRelationTargetPages.length > 0) {
    await commitPersistedRelatedPagesToCache({
      databaseId: sourceDatabaseId,
      pages: selectedRelationTargetPages,
      queryKeys: sourceQueryKeys,
      sourceId: source.id,
      userId,
    });
  }
}

async function reconcilePersistedBlockMutation(
  id: string,
  persisted: Block | undefined,
  pageIdHint?: string
) {
  const state = useStore.getState();
  const pageId = persisted?.pageId ?? pageIdHint;
  if (!pageId) return;
  const live = state.blocksByPage[pageId]?.find((block) => block.id === id);
  const authoritative = persisted ?? live;
  if (!authoritative) return;
  // The acknowledgement is a second write boundary. Reads that began while
  // this generation was on the wire may still contain the pre-write block and
  // must not apply after the optimistic overlay is retired below.
  invalidateReadApplication(
    readApplicationKey.blocks(pageId),
    `block_mutation_ack:${id}`,
  );
  const projected = remoteBlockWithOptimisticOverlay(authoritative);
  useStore.setState((current) => {
    const blocks = current.blocksByPage[pageId];
    if (!blocks?.some((block) => block.id === projected.id)) return {};
    return {
      blocksByPage: {
        ...current.blocksByPage,
        [pageId]: blocks
          .map((block) => (block.id === projected.id ? projected : block))
          .sort(bySortPos),
      },
    };
  });
  const userId = outboxUserId();
  if (!userId) return;
  await commitPersistedBlockToCache(userId, projected);
}

function mirrorPendingBlock(id: string) {
  const patch = pendingBlock.get(id);
  if (!patch || !Object.keys(patch).length) return;
  outboxSet(outboxUserId(), `block:${id}`, {
    expectedMutationId: pendingBlockExpectedMutationId.get(id),
    expectedUpdatedAt: pendingBlockBase.get(id),
    hintPageId: pendingBlockPage.get(id),
    id,
    kind: "block_update",
    mutationId: pendingBlockMutationId.get(id),
    patch: persistableBlockPatch(patch),
  });
}

function validBlockPageRecencyProof(value: unknown): BlockPageRecencyProof | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proof = value as Record<string, unknown>;
  if (
    typeof proof.blockId !== "string" || !proof.blockId
    || typeof proof.blockUpdatedAt !== "string" || !proof.blockUpdatedAt
    || typeof proof.mutationId !== "string" || !proof.mutationId
    || typeof proof.pageId !== "string" || !proof.pageId
  ) return undefined;
  return {
    blockId: proof.blockId,
    blockUpdatedAt: proof.blockUpdatedAt,
    mutationId: proof.mutationId,
    pageId: proof.pageId,
  };
}

function normalizedBlockUpdateResult(value: unknown): BlockUpdateRemoteResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Block mutation response is malformed.");
  }
  const result = value as Record<string, unknown>;
  const block = result.block;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("Block mutation response is missing its committed block.");
  }
  const proof = result.pageRecency === undefined
    ? undefined
    : validBlockPageRecencyProof(result.pageRecency);
  if (result.pageRecency !== undefined && !proof) {
    throw new Error("Block mutation response has a malformed page-recency proof.");
  }
  return { block: block as Block, ...(proof ? { pageRecency: proof } : {}) };
}

function normalizedBlockBatchUpdateResult(value: unknown): BlockBatchUpdateRemoteResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Block batch response is malformed.");
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.blocks) || !Array.isArray(result.pageRecencies)) {
    throw new Error("Block batch response is missing committed rows or page-recency proofs.");
  }
  const pageRecencies = result.pageRecencies.map((value) => validBlockPageRecencyProof(value));
  if (pageRecencies.some((proof) => !proof)) {
    throw new Error("Block batch response has a malformed page-recency proof.");
  }
  return {
    blocks: result.blocks as Block[],
    pageRecencies: pageRecencies as BlockPageRecencyProof[],
  };
}

function pageRecencyKey(pageId: string) {
  return `page-recency:${pageId}`;
}

function clearPageRecencyTimer() {
  if (pageRecencyTimer) clearTimeout(pageRecencyTimer);
  pageRecencyTimer = undefined;
  pageRecencyTimerDueAt = Number.POSITIVE_INFINITY;
}

function resetPageRecencyMemory() {
  pageRecencyEpoch += 1;
  clearPageRecencyTimer();
  pendingPageRecency.clear();
  pageRecencyInFlight.clear();
  pageRecencyInFlightGeneration.clear();
  pageRecencyRetryAttempts.clear();
  pageRecencyDrain = undefined;
}

function schedulePageRecencyDrain() {
  const dueAt = Math.min(
    ...Array.from(pendingPageRecency.values())
      .filter(({ operation }) => !pageRecencyInFlight.has(operation.pageId))
      .map(({ operation }) => operation.dueAt),
  );
  if (!Number.isFinite(dueAt)) {
    clearPageRecencyTimer();
    return;
  }
  if (pageRecencyTimer && pageRecencyTimerDueAt <= dueAt) return;
  clearPageRecencyTimer();
  pageRecencyTimerDueAt = dueAt;
  pageRecencyTimer = setTimeout(() => {
    pageRecencyTimer = undefined;
    pageRecencyTimerDueAt = Number.POSITIVE_INFINITY;
    void flushPageRecencies(false);
  }, Math.max(0, dueAt - Date.now()));
}

async function admitBlockPageRecency(proof: BlockPageRecencyProof) {
  const userId = outboxUserId();
  if (!userId) throw new Error("Page recency requires an authenticated durable owner.");
  const existing = pendingPageRecency.get(proof.pageId);
  if (
    existing
    && (
      existing.operation.blockUpdatedAt > proof.blockUpdatedAt
      || (
        existing.operation.blockUpdatedAt === proof.blockUpdatedAt
        && existing.operation.blockId === proof.blockId
        && existing.operation.mutationId === proof.mutationId
      )
    )
  ) return;
  const inFlight = pageRecencyInFlightGeneration.get(proof.pageId);
  const hasNextWindow = !!inFlight && !!existing && existing !== inFlight;
  const dueAt = hasNextWindow
    ? existing.operation.dueAt
    : inFlight
      ? Date.now() + PAGE_RECENCY_WINDOW_MS
      : existing?.operation.dueAt ?? Date.now() + PAGE_RECENCY_WINDOW_MS;
  const generation: LivePageRecencyGeneration = {
    epoch: pageRecencyEpoch,
    operation: { ...proof, dueAt, kind: "page_recency" },
    userId,
  };
  pendingPageRecency.set(proof.pageId, generation);
  pageRecencyRetryAttempts.delete(proof.pageId);
  // This await is the block-ack barrier: a successful block request remains
  // durably replayable until its companion page generation is also durable.
  await outboxSet(userId, pageRecencyKey(proof.pageId), generation.operation);
  schedulePageRecencyDrain();
}

async function settlePageRecencyGeneration(generation: LivePageRecencyGeneration) {
  const { operation, userId } = generation;
  // A newer same-key generation may already be durable (or still be behind
  // its block-ack barrier). Never delete that key on behalf of an older wire
  // response: deleting then re-mirroring would create a crash-sized loss gap.
  if (pendingPageRecency.get(operation.pageId) !== generation) return;
  pendingPageRecency.delete(operation.pageId);
  pageRecencyRetryAttempts.delete(operation.pageId);
  await outboxAck(userId, pageRecencyKey(operation.pageId));
}

function deliverPageRecency(
  generation: LivePageRecencyGeneration,
): Promise<"retry" | "settled"> {
  const pageId = generation.operation.pageId;
  const active = pageRecencyInFlight.get(pageId);
  if (active) return active;
  const run = (async (): Promise<"retry" | "settled"> => {
    if (generation.epoch !== pageRecencyEpoch) return "settled";
    try {
      const { dueAt: _dueAt, kind: _kind, ...proof } = generation.operation;
      await touchBlockPageRecencyRemote(proof);
      if (generation.epoch !== pageRecencyEpoch) return "settled";
      await settlePageRecencyGeneration(generation);
      noteSyncSuccess();
      return "settled";
    } catch (error) {
      if (generation.epoch !== pageRecencyEpoch) return "settled";
      if (persistErrorStatus(error) === 404) {
        await settlePageRecencyGeneration(generation);
        noteSyncSuccess();
        return "settled";
      }
      noteSyncFailure();
      const current = pendingPageRecency.get(pageId) ?? generation;
      const attempt = (pageRecencyRetryAttempts.get(pageId) ?? 0) + 1;
      pageRecencyRetryAttempts.set(pageId, attempt);
      const retry: LivePageRecencyGeneration = {
        ...current,
        operation: {
          ...current.operation,
          dueAt: Date.now() + persistRetryDelayMs(attempt),
        },
      };
      pendingPageRecency.set(pageId, retry);
      await outboxSet(retry.userId, pageRecencyKey(pageId), retry.operation);
      return "retry";
    }
  })();
  pageRecencyInFlight.set(pageId, run);
  pageRecencyInFlightGeneration.set(pageId, generation);
  void run.finally(() => {
    if (pageRecencyInFlight.get(pageId) === run) pageRecencyInFlight.delete(pageId);
    if (pageRecencyInFlightGeneration.get(pageId) === generation) {
      pageRecencyInFlightGeneration.delete(pageId);
    }
    schedulePageRecencyDrain();
  });
  return run;
}

async function flushPageRecencies(force: boolean) {
  if (force) clearPageRecencyTimer();
  if (pageRecencyDrain) {
    await pageRecencyDrain;
    if (force) await flushPageRecencies(true);
    return;
  }
  const run = (async () => {
    const retryBlockedPages = new Set<string>();
    for (;;) {
      const now = Date.now();
      const eligible = Array.from(pendingPageRecency.values())
        .filter(({ operation }) => (
          !pageRecencyInFlight.has(operation.pageId)
          && !retryBlockedPages.has(operation.pageId)
          && (force || operation.dueAt <= now)
        ))
        .sort((left, right) => (
          left.operation.dueAt - right.operation.dueAt
          || left.operation.pageId.localeCompare(right.operation.pageId)
        ));
      if (eligible.length === 0) break;
      const chunk = eligible.slice(0, PAGE_RECENCY_DRAIN_CHUNK_SIZE);
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(PAGE_RECENCY_MAX_IN_FLIGHT, chunk.length) },
        async () => {
          for (;;) {
            const generation = chunk[cursor];
            cursor += 1;
            if (!generation) return;
            const outcome = await deliverPageRecency(generation);
            if (outcome === "retry") {
              retryBlockedPages.add(generation.operation.pageId);
            }
          }
        },
      );
      await Promise.all(workers);
    }
  })();
  pageRecencyDrain = run;
  try {
    await run;
  } finally {
    if (pageRecencyDrain === run) pageRecencyDrain = undefined;
    schedulePageRecencyDrain();
  }
}

function retryPage(id: string) {
  if (pageTimers.has(id)) return;
  pageTimers.set(id, setTimeout(() => void flushPage(id), PERSIST_RETRY_MS));
}

function retryBlock(id: string) {
  if (blockTimers.has(id)) return;
  blockTimers.set(id, setTimeout(() => void flushBlock(id), PERSIST_RETRY_MS));
}

function pendingBlockIdsForPage(pageId: string) {
  return Array.from(pendingBlockPage.entries())
    .filter(([id, ownerPageId]) => ownerPageId === pageId && pendingBlock.has(id))
    .map(([id]) => id);
}

function scheduleBlockBatch(pageId: string, delay = BLOCK_BATCH_DEBOUNCE_MS) {
  // A fixed collection window (rather than a trailing per-keystroke debounce)
  // guarantees continuous typing still reaches the server every ~1 second.
  // Later blocks on the same page join the already-scheduled batch.
  if (blockBatchTimers.has(pageId)) return;
  blockBatchTimers.set(
    pageId,
    setTimeout(() => void flushBlockBatch(pageId), Math.max(0, delay))
  );
}

function blockPatchCanBatch(patch: Partial<Block>) {
  // Cross-page/reparenting writes carry subtree and file-association semantics
  // that the backend intentionally keeps on the single-update path.
  return !("pageId" in patch) && !("parentId" in patch);
}

function pendingPageLikeCreateHas(id: string | null | undefined) {
  return Boolean(
    id &&
      (pendingPageCreate.has(id) ||
        pendingDatabaseCreate.has(id) ||
        pendingDatabaseRowCreate.has(id))
  );
}

function pendingOptimisticCreateHas(id: string) {
  return (
    pendingPageLikeCreateHas(id) ||
    pendingPropertyCreate.has(id) ||
    pendingViewCreate.has(id) ||
    pendingTemplateCreate.has(id) ||
    pendingCommentCreate.has(id)
  );
}

function valueReferencesMatchingId(
  value: unknown,
  matches: (candidate: string) => boolean,
  seen = new Set<object>()
): boolean {
  if (typeof value === "string") return matches(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => valueReferencesMatchingId(item, matches, seen));
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => matches(key) || valueReferencesMatchingId(item, matches, seen)
  );
}

function valueReferencesPendingCreate(value: unknown, ignoredId?: string) {
  return valueReferencesMatchingId(
    value,
    (candidate) => candidate !== ignoredId && pendingOptimisticCreateHas(candidate)
  );
}

function valueReferencesId(value: unknown, id: string) {
  return valueReferencesMatchingId(value, (candidate) => candidate === id);
}

async function flushPage(id: string) {
  const active = pageFlushes.get(id);
  if (active) {
    await active.catch(() => {});
    if (pendingPage.has(id)) await flushPage(id);
    return;
  }
  const run = flushPageOnce(id);
  pageFlushes.set(id, run);
  try {
    await run;
  } finally {
    if (pageFlushes.get(id) === run) pageFlushes.delete(id);
  }
}

async function flushPageOnce(id: string) {
  const t = pageTimers.get(id);
  if (t) {
    clearTimeout(t);
    pageTimers.delete(id);
  }
  const queuedPatch = pendingPage.get(id);
  const currentPage = useStore.getState().pagesById[id];
  const targetParentId =
    queuedPatch && Object.prototype.hasOwnProperty.call(queuedPatch, "parentId")
      ? queuedPatch.parentId
      : currentPage?.parentId;
  // The local page and its title/metadata are usable immediately, but the
  // backend must see the client-id create before an update or move that
  // references it (or its just-created parent). Keep the durable patch queued;
  // page-create completion releases this lane.
  if (
    pendingPageLikeCreateHas(id) ||
    (typeof targetParentId === "string" && pendingPageLikeCreateHas(targetParentId)) ||
    valueReferencesPendingCreate(queuedPatch)
  ) {
    return;
  }
  const patch = pendingPage.get(id);
  const before = pendingPageBefore.get(id);
  const durability = pendingPageDurability.get(id) ?? Promise.resolve();
  const expectedUpdatedAt = pendingPageBase.get(id);
  const expectedMutationId = pendingPageExpectedMutationId.get(id);
  const mutationId = pendingPageMutationId.get(id) ?? newId();
  pendingPage.delete(id);
  pendingPageMutationId.delete(id);
  pendingPageBefore.delete(id);
  if (pendingPageDurability.get(id) === durability) pendingPageDurability.delete(id);
  if (patch) {
    inFlightPageMutationId.set(id, mutationId);
    inFlightPagePatch.set(id, patch);
  }
  if (patch && Object.keys(patch).length) {
    try {
      const page = useStore.getState().pagesById[id];
      const persistablePatch = persistablePagePatch(patch, page);
      const filePropertyIds =
        page?.parentType === "database"
          ? databaseRowFilePropertyIds(page, persistablePatch)
          : [];
      // Closing/reloading after the remote request starts must never lose the
      // accepted edit. Wait for the exact captured outbox generation first;
      // a later edit gets its own pending generation and drains afterwards.
      const persist = async () => {
        await durability;
        await runAcknowledgedMutation({
          send: () =>
            page?.parentType === "database"
              ? updateDatabaseRowRemote(
                  id,
                  persistablePatch,
                  expectedUpdatedAt,
                  mutationId,
                  expectedMutationId,
                )
              : updatePageRemote(
                  id,
                  persistablePatch,
                  expectedUpdatedAt,
                  mutationId,
                  expectedMutationId,
                ),
          commit: async (persisted) => {
            if (pendingPage.has(id)) {
              if (persisted?.updatedAt) pendingPageBase.set(id, persisted.updatedAt);
              pendingPageExpectedMutationId.set(id, mutationId);
            } else {
              pendingPageBase.delete(id);
              pendingPageExpectedMutationId.delete(id);
              pendingPageMutationId.delete(id);
            }
            await reconcilePersistedPageMutations(
              id,
              persisted,
              affectedDatabaseRowsFromMutation(persisted)
            );
            publishPersistedPageMutation(id, patch, page);
          },
          acknowledge: () => {
            outboxAck(outboxUserId(), `page:${id}`);
            if (pendingPage.has(id)) mirrorPendingPage(id);
          },
        });
      };
      // Whole-value file patches share a per-row/property causal lane with
      // detach effects. Claim the lane before waiting on IndexedDB so a later
      // removal cannot overtake this already-accepted generation.
      if (filePropertyIds.length > 0) {
        await runSerializedRowFilePropertyPatch(id, filePropertyIds, persist);
      } else {
        await persist();
      }
      noteSyncSuccess();
    } catch (error) {
      if (shouldDropPersistError(error)) {
        const userId = outboxUserId();
        const hasNewerGeneration = pendingPage.has(id);
        const originalKey = `page:${id}`;
        const markerKey = hasNewerGeneration
          ? `terminal:${originalKey}:${newId()}`
          : originalKey;
        const target = currentPage?.parentType === "database" ? "database_row" : "page";
        const operation: MutationOutboxOp = {
          expectedMutationId,
          expectedUpdatedAt,
          id,
          kind: "page_update",
          mutationId,
          patch: persistablePagePatch(patch, currentPage),
          target,
        };
        const entry = target === "database_row"
          ? DURABLE_REMOTE_CALLS.updateDatabaseRowRemote
          : DURABLE_REMOTE_CALLS.updatePageRemote;
        const disposition = durableTerminalDisposition(entry, persistErrorStatus(error));
        if (disposition === "drop") notifyPersistDrop(error);
        if (!hasNewerGeneration) {
          pendingPageBase.delete(id);
          pendingPageExpectedMutationId.delete(id);
          pendingPageMutationId.delete(id);
        }
        await transitionToTerminalReconciliation(
          userId,
          markerKey,
          operation,
          disposition === "confirmed" ? "drop" : disposition,
          error,
          () => {
            if (hasNewerGeneration) {
              // The newer generation still contains the desired combined state.
              // Keep the oldest baseline so a later terminal rejection can roll
              // the whole uncommitted chain back without erasing concurrent work.
              if (before) pendingPageBefore.set(id, before);
            } else {
              rollbackTerminalPageMutation(id, patch, before);
            }
          }
        );
        return;
      }
      noteSyncFailure();
      if (!pendingPage.has(id)) {
        pendingPageMutationId.set(id, mutationId);
        if (expectedUpdatedAt) pendingPageBase.set(id, expectedUpdatedAt);
        else pendingPageBase.delete(id);
        if (expectedMutationId) pendingPageExpectedMutationId.set(id, expectedMutationId);
        else pendingPageExpectedMutationId.delete(id);
      }
      pendingPage.set(id, { ...patch, ...(pendingPage.get(id) ?? {}) });
      if (before) pendingPageBefore.set(id, before);
      mirrorPendingPage(id);
      retryPage(id);
    } finally {
      if (inFlightPageMutationId.get(id) === mutationId) {
        inFlightPageMutationId.delete(id);
        inFlightPagePatch.delete(id);
      }
    }
  }
}

function publishPersistedPageMutation(id: string, patch: Partial<Page>, page?: Page) {
  const revision = Date.now();
  const updatedAt = typeof patch.updatedAt === "string" ? patch.updatedAt : nowIso();
  const metaPatch = pageMetaMutationPatch(patch);
  if (metaPatch) {
    publishPageRoomMutation({
      kind: "page_meta_changed",
      pageId: id,
      patch: metaPatch,
      reason: "page_update",
      revision,
      targetPageId: id,
      updatedAt,
    });
    if (page?.kind === "database") {
      publishLocalDatabaseMutation({
        databaseId: id,
        kind: "database_schema_changed",
        patch: metaPatch,
        reason: "database_meta_changed",
        revision,
        targetPageId: id,
        updatedAt,
      });
    }
  }

  if (page?.parentType === "database" && page.parentId) {
    publishLocalDatabaseMutation({
      databaseId: page.parentId,
      kind: "database_rows_changed",
      patch: metaPatch,
      reason: "row_updated",
      revision,
      rowIds: [id],
      targetPageId: id,
      updatedAt,
    });
  }
}

/** Tell collaborators viewing this page that its comments changed (they refetch). */
function publishCommentsMutation(pageId: string) {
  publishPageRoomMutation({
    kind: "comments_changed",
    pageId,
    reason: "comments_changed",
    revision: Date.now(),
    updatedAt: nowIso(),
  });
}

/**
 * Announce only that canonical block structure changed. The signal is emitted
 * after the server mutation commits; peers always reload canonical blocks and
 * never treat this payload as a durable operation or state snapshot.
 */
function publishBlockStructureMutation(
  pageId: string,
  reason: string,
  blockIds?: Iterable<string>
) {
  if (!pageId || isTemplateEditorPageId(pageId)) return;
  const ids = blockIds
    ? Array.from(new Set(Array.from(blockIds).filter(Boolean))).slice(0, 100)
    : undefined;
  publishPageRoomMutation({
    blockIds: ids?.length ? ids : undefined,
    kind: "block_structure_changed",
    pageId,
    reason,
    revision: Date.now(),
    updatedAt: nowIso(),
  });
}

function publishDatabaseRowsMutation(databaseId: string, reason: string, rowIds?: string[]) {
  publishLocalDatabaseMutation({
    databaseId,
    kind: "database_rows_changed",
    reason,
    revision: Date.now(),
    rowIds,
    updatedAt: nowIso(),
  });
}

function publishDatabaseSchemaMutation(databaseId: string, reason: string, propertyIds?: string[]) {
  cacheCurrentDatabaseMetadata(databaseId);
  publishLocalDatabaseMutation({
    databaseId,
    kind: "database_schema_changed",
    propertyIds,
    reason,
    revision: Date.now(),
    updatedAt: nowIso(),
  });
}

function publishDatabaseViewsMutation(databaseId: string, reason: string, viewIds?: string[]) {
  cacheCurrentDatabaseMetadata(databaseId);
  publishLocalDatabaseMutation({
    databaseId,
    kind: "database_views_changed",
    reason,
    revision: Date.now(),
    updatedAt: nowIso(),
    viewIds,
  });
}

function publishDatabaseTemplatesMutation(databaseId: string, reason: string) {
  cacheCurrentDatabaseMetadata(databaseId);
  publishLocalDatabaseMutation({
    databaseId,
    kind: "database_templates_changed",
    reason,
    revision: Date.now(),
    updatedAt: nowIso(),
  });
}

async function flushBlock(id: string) {
  const active = blockFlushes.get(id);
  if (active) {
    await active.catch(() => {});
    if (pendingBlock.has(id)) await flushBlock(id);
    return;
  }
  const run = flushBlockOnce(id);
  blockFlushes.set(id, run);
  try {
    await run;
  } finally {
    if (blockFlushes.get(id) === run) blockFlushes.delete(id);
  }
}

type PendingBlockBatchItem = {
  expectedMutationId?: string;
  expectedUpdatedAt?: string;
  id: string;
  mutationId: string;
  pageId: string;
  patch: Partial<Block>;
};

function restorePendingBlockBatchItems(items: readonly PendingBlockBatchItem[]) {
  for (const { expectedMutationId, expectedUpdatedAt, id, mutationId, patch } of items) {
    if (!pendingBlock.has(id)) {
      pendingBlockMutationId.set(id, mutationId);
      if (expectedMutationId) pendingBlockExpectedMutationId.set(id, expectedMutationId);
      else pendingBlockExpectedMutationId.delete(id);
      if (expectedUpdatedAt) pendingBlockBase.set(id, expectedUpdatedAt);
      else pendingBlockBase.delete(id);
    }
    pendingBlock.set(id, { ...patch, ...(pendingBlock.get(id) ?? {}) });
    mirrorPendingBlock(id);
  }
}

async function flushBlockBatch(pageId: string) {
  const timer = blockBatchTimers.get(pageId);
  if (timer) clearTimeout(timer);
  blockBatchTimers.delete(pageId);

  const active = blockBatchFlushes.get(pageId);
  if (active) {
    await active.catch(() => {});
    // An explicit caller (notably flushAllPending) that joins an in-flight
    // batch must also join work accepted while that batch was on the wire.
    // Starting a fresh collection timer here lets the caller resolve while
    // those durable generations remain unsent. Re-enter after the active run
    // releases its lane; the normal timer-driven path still keeps its fixed
    // collection window when nobody is explicitly awaiting a full drain.
    if (pendingBlockIdsForPage(pageId).length > 0) await flushBlockBatch(pageId);
    return;
  }

  const candidates = pendingBlockIdsForPage(pageId)
    .filter((id) => !blockFlushes.has(id) && !pendingBlockCreate.has(id));
  const batchIds = candidates.filter((id) => {
    const patch = pendingBlock.get(id);
    return !!patch && blockPatchCanBatch(patch) && !valueReferencesPendingCreate(patch);
  });
  const individualIds = candidates.filter((id) => !batchIds.includes(id));

  // A singleton still uses the mature single-write path. updateMany becomes a
  // real network win only when at least two blocks share the collection window.
  if (batchIds.length < 2) {
    individualIds.push(...batchIds);
    await Promise.all(individualIds.map((id) => flushBlock(id)));
    if (pendingBlockIdsForPage(pageId).length > 0) scheduleBlockBatch(pageId);
    return;
  }

  const items: PendingBlockBatchItem[] = [];
  for (const id of batchIds) {
    const patch = pendingBlock.get(id);
    const ownerPageId = pendingBlockPage.get(id);
    if (!patch || ownerPageId !== pageId) continue;
    const itemTimer = blockTimers.get(id);
    if (itemTimer) clearTimeout(itemTimer);
    blockTimers.delete(id);
    const mutationId = pendingBlockMutationId.get(id) ?? newId();
    const expectedMutationId = pendingBlockExpectedMutationId.get(id);
    const expectedUpdatedAt = pendingBlockBase.get(id);
    pendingBlock.delete(id);
    pendingBlockMutationId.delete(id);
    inFlightBlockMutationId.set(id, mutationId);
    items.push({ expectedMutationId, expectedUpdatedAt, id, mutationId, pageId, patch });
  }

  const run = (async () => {
    let remaining = items.slice();
    try {
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, BLOCK_BATCH_CHUNK_SIZE);
        const response = await updateBlocksRemote(
          chunk.map(({ expectedMutationId, expectedUpdatedAt, id, mutationId, patch }) => ({
            expectedMutationId,
            expectedUpdatedAt,
            id,
            mutationId,
            patch: persistableBlockPatch(patch),
          })),
          pageId
        );
        const { blocks: persisted, pageRecencies } = normalizedBlockBatchUpdateResult(response);
        const persistedById = new Map(persisted.map((block) => [block.id, block]));
        await Promise.all(
          chunk.map(async ({ id, mutationId, patch: sentPatch }) => {
            const persistedBlock = persistedById.get(id);
            await reconcilePersistedBlockMutation(id, persistedBlock, pageId);
            if (pendingBlock.has(id)) {
              const authoritativeStamp = persistedBlock?.updatedAt ?? sentPatch.updatedAt;
              if (typeof authoritativeStamp === "string") {
                pendingBlockBase.set(id, authoritativeStamp);
              }
              pendingBlockExpectedMutationId.set(id, mutationId);
            } else {
              pendingBlockBase.delete(id);
              pendingBlockExpectedMutationId.delete(id);
              pendingBlockMutationId.delete(id);
              pendingBlockPage.delete(id);
            }
          })
        );
        await Promise.all(pageRecencies.map(admitBlockPageRecency));
        for (const { id } of chunk) {
          outboxAck(outboxUserId(), `block:${id}`);
          if (pendingBlock.has(id)) mirrorPendingBlock(id);
        }
        const structureIds = chunk
          .filter(({ patch }) => blockPatchChangesStructure(patch))
          .map(({ id }) => id);
        if (structureIds.length > 0) {
          publishBlockStructureMutation(pageId, "block_structure_batch_committed", structureIds);
        }
        // The local queue may contain thousands of touched blocks. Drain every
        // safe transaction chunk in this SAME flush cycle; never impose a new
        // one-second collection delay between chunks.
        remaining = remaining.slice(chunk.length);
        noteSyncSuccess();
      }
    } catch (error) {
      const status = persistErrorStatus(error);
      if (status === 400 || status === 404 || status === 409 || status === 413) {
        // A batch-wide validation/CAS failure does not identify which member
        // lost. A 404 can likewise name just one remotely-deleted block. Restore
        // every generation and fall back to the established per-block path so
        // one unusual block cannot discard its neighbours.
        restorePendingBlockBatchItems(remaining);
        setTimeout(() => {
          for (const { id } of remaining) void flushBlock(id);
        }, 0);
        return;
      }
      if (shouldDropPersistError(error)) {
        notifyPersistDrop(error);
        const userId = outboxUserId();
        const markerKey = `terminal:block-batch:${newId()}`;
        const invalidation = blockStructureInvalidation(
          [pageId],
          remaining.map(({ id }) => id)
        );
        const operation: MutationOutboxOp = {
          args: [[], pageId],
          ...(invalidation ? { blockStructureInvalidation: invalidation } : {}),
          fn: "updateBlocksRemote",
          kind: "remote_call",
        };
        await transitionToTerminalReconciliation(
          userId,
          markerKey,
          operation,
          "drop",
          error,
          () => {
            for (const { id } of remaining) {
              if (pendingBlock.has(id)) continue;
              pendingBlockBase.delete(id);
              pendingBlockExpectedMutationId.delete(id);
              pendingBlockMutationId.delete(id);
            }
          },
          async () => {
            await Promise.all(
              remaining
                .filter(({ id }) => !pendingBlock.has(id))
                .map(({ id }) => outboxAck(userId, `block:${id}`))
            );
          }
        );
        return;
      }
      noteSyncFailure();
      restorePendingBlockBatchItems(remaining);
      scheduleBlockBatch(pageId);
    }
  })();

  blockBatchFlushes.set(pageId, run);
  for (const { id } of items) blockFlushes.set(id, run);
  try {
    await Promise.all([run, ...individualIds.map((id) => flushBlock(id))]);
  } finally {
    if (blockBatchFlushes.get(pageId) === run) blockBatchFlushes.delete(pageId);
    for (const { id, mutationId } of items) {
      if (blockFlushes.get(id) === run) blockFlushes.delete(id);
      if (inFlightBlockMutationId.get(id) === mutationId) {
        inFlightBlockMutationId.delete(id);
      }
    }
    if (pendingBlockIdsForPage(pageId).length > 0 && !blockBatchTimers.has(pageId)) {
      scheduleBlockBatch(pageId);
    }
  }
}

async function flushBlockOnce(id: string) {
  const t = blockTimers.get(id);
  if (t) {
    clearTimeout(t);
    blockTimers.delete(id);
  }
  const createRun = blockCreateInFlight.get(id);
  if (createRun) await createRun.catch(() => {});
  // A fast edit can be queued in the same tick as an optimistic block create.
  // Sending updateBlock first turns a healthy slow server into a terminal 404.
  if (pendingBlockCreate.has(id)) return;
  const owningPageId = pendingBlockPage.get(id);
  const queuedBlockPatch = pendingBlock.get(id);
  if (valueReferencesPendingCreate(queuedBlockPatch)) return;
  if (
    owningPageId &&
    !(useStore.getState().blocksByPage[owningPageId] ?? []).some((block) => block.id === id)
  ) {
    cancelPendingBlock(id);
    return;
  }
  const patch = pendingBlock.get(id);
  const hintPageId = pendingBlockPage.get(id);
  const mutationId = pendingBlockMutationId.get(id) ?? newId();
  const expectedMutationId = pendingBlockExpectedMutationId.get(id);
  const expectedUpdatedAt = pendingBlockBase.get(id);
  pendingBlock.delete(id);
  pendingBlockMutationId.delete(id);
  inFlightBlockMutationId.set(id, mutationId);
  if (patch && Object.keys(patch).length) {
    try {
      await runAcknowledgedMutation({
        send: () => updateBlockRemote(
          id,
          persistableBlockPatch(patch),
          hintPageId,
          expectedUpdatedAt,
          mutationId,
          expectedMutationId,
        ),
        commit: async (response) => {
          const { block: persisted, pageRecency } = normalizedBlockUpdateResult(response);
          await reconcilePersistedBlockMutation(id, persisted, hintPageId);
          // The server stored this patch's stamp; edits enqueued after this
          // flush conflict-check against it, not the pre-flush base.
          if (pendingBlock.has(id)) {
            const authoritativeStamp = persisted?.updatedAt ?? patch.updatedAt;
            if (typeof authoritativeStamp === "string") {
              pendingBlockBase.set(id, authoritativeStamp);
            }
            pendingBlockExpectedMutationId.set(id, mutationId);
          } else {
            pendingBlockBase.delete(id);
            pendingBlockExpectedMutationId.delete(id);
            pendingBlockMutationId.delete(id);
            pendingBlockPage.delete(id);
          }
          if (pageRecency) await admitBlockPageRecency(pageRecency);
        },
        acknowledge: () => {
          // A newer patch may already occupy the same durable outbox key. Ack
          // the completed generation first, then re-mirror the newer one.
          outboxAck(outboxUserId(), `block:${id}`);
          if (pendingBlock.has(id)) mirrorPendingBlock(id);
        },
      });
      if (blockPatchChangesStructure(patch)) {
        const committedPageId =
          typeof patch.pageId === "string" && patch.pageId ? patch.pageId : hintPageId;
        if (committedPageId) {
          publishBlockStructureMutation(
            committedPageId,
            "block_structure_update_committed",
            [id]
          );
        }
      }
      noteSyncSuccess();
    } catch (error) {
      if (shouldDropPersistError(error)) {
        const userId = outboxUserId();
        const hasNewerGeneration = pendingBlock.has(id);
        const originalKey = `block:${id}`;
        const markerKey = hasNewerGeneration
          ? `terminal:${originalKey}:${newId()}`
          : originalKey;
        const operation: MutationOutboxOp = {
          expectedMutationId,
          expectedUpdatedAt,
          hintPageId,
          id,
          kind: "block_update",
          mutationId,
          patch: persistableBlockPatch(patch),
        };
        notifyPersistDrop(error);
        await transitionToTerminalReconciliation(
          userId,
          markerKey,
          operation,
          "drop",
          error,
          () => {
            // This generation is terminal. A forced canonical reload must not
            // reapply its optimistic fields, but an edit accepted while the
            // request was in flight still owns its own partial overlay.
            const newerPatch = pendingBlock.get(id);
            if (newerPatch && Object.keys(newerPatch).length > 0) {
              optimisticBlockOverlays.set(id, { ...newerPatch });
            } else {
              optimisticBlockOverlays.delete(id);
            }
            if (!hasNewerGeneration) {
              pendingBlockBase.delete(id);
              pendingBlockExpectedMutationId.delete(id);
              pendingBlockMutationId.delete(id);
            }
          }
        );
        return;
      }
      noteSyncFailure();
      if (!pendingBlock.has(id)) {
        pendingBlockMutationId.set(id, mutationId);
        if (expectedMutationId) pendingBlockExpectedMutationId.set(id, expectedMutationId);
        else pendingBlockExpectedMutationId.delete(id);
      }
      pendingBlock.set(id, { ...patch, ...(pendingBlock.get(id) ?? {}) });
      mirrorPendingBlock(id);
      retryBlock(id);
    } finally {
      if (inFlightBlockMutationId.get(id) === mutationId) {
        inFlightBlockMutationId.delete(id);
      }
    }
  } else {
    pendingBlockPage.delete(id);
    pendingBlockBase.delete(id);
    pendingBlockExpectedMutationId.delete(id);
    pendingBlockMutationId.delete(id);
    if (inFlightBlockMutationId.get(id) === mutationId) inFlightBlockMutationId.delete(id);
  }
}

/** Drop any pending debounced write for an entity that's being deleted. */
function cancelPendingPage(id: string) {
  const t = pageTimers.get(id);
  if (t) {
    clearTimeout(t);
    pageTimers.delete(id);
  }
  pendingPage.delete(id);
  pendingPageBase.delete(id);
  pendingPageExpectedMutationId.delete(id);
  pendingPageMutationId.delete(id);
  pendingPageBefore.delete(id);
  pendingPageDurability.delete(id);
  inFlightPageMutationId.delete(id);
  inFlightPagePatch.delete(id);
  optimisticPageOverlays.delete(id);
  outboxAck(outboxUserId(), `page:${id}`);
}

function cancelPendingBlock(id: string) {
  const t = blockTimers.get(id);
  if (t) {
    clearTimeout(t);
    blockTimers.delete(id);
  }
  pendingBlock.delete(id);
  pendingBlockBase.delete(id);
  pendingBlockExpectedMutationId.delete(id);
  pendingBlockMutationId.delete(id);
  inFlightBlockMutationId.delete(id);
  optimisticBlockOverlays.delete(id);
  outboxAck(outboxUserId(), `block:${id}`);
}

function currentRelativeRouteHref() {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function retryPageCreate(id: string, delay = PERSIST_RETRY_MS) {
  if (pageCreateTimers.has(id)) return;
  pageCreateTimers.set(id, setTimeout(() => void flushPageCreate(id), delay));
}

function pendingPageCreateSubtree(rootId: string) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, entry] of pendingPageCreate) {
      if (ids.has(id) || !entry.page.parentId || !ids.has(entry.page.parentId)) continue;
      ids.add(id);
      changed = true;
    }
  }
  return ids;
}

function rollbackDependentWritesForFailedCreate(id: string) {
  cancelDurableCallsReferencing(id);
  const state = useStore.getState();
  const reloadBlockPages = new Set<string>();
  const reloadDatabases = new Set<string>();
  const reloadPages = new Set<string>();
  const removeLocalBlockIds = new Set<string>();

  // Relation reciprocals and rollups are reflected optimistically before
  // their dependent create is acknowledged. If that create is rejected,
  // reload every schema that still points at the failed id so a phantom
  // relatedPropertyId/rollup dependency cannot survive in local state.
  for (const [databaseId, properties] of Object.entries(state.propsByDb)) {
    if (properties.some((property) => valueReferencesId(property, id))) {
      reloadDatabases.add(databaseId);
    }
  }
  for (const [databaseId, views] of Object.entries(state.viewsByDb)) {
    if (views.some((view) => valueReferencesId(view, id))) {
      reloadDatabases.add(databaseId);
    }
  }
  for (const [databaseId, templates] of Object.entries(state.templatesByDb)) {
    if (templates.some((template) => valueReferencesId(template, id))) {
      reloadDatabases.add(databaseId);
    }
  }

  for (const [blockId, patch] of pendingBlock) {
    if (!valueReferencesId(patch, id)) continue;
    const pageId = pendingBlockPage.get(blockId);
    if (pageId) reloadBlockPages.add(pageId);
    cancelPendingBlock(blockId);
  }
  for (const block of pendingBlockCreate.values()) {
    if (!valueReferencesId(block, id)) continue;
    removeLocalBlockIds.add(block.id);
    reloadBlockPages.add(block.pageId);
    cancelPendingBlockCreate(block.id);
  }
  for (const [pageId, patch] of pendingPage) {
    if (!valueReferencesId(patch, id)) continue;
    const page = state.pagesById[pageId];
    cancelPendingPage(pageId);
    if (page?.parentType === "database" && page.parentId) reloadDatabases.add(page.parentId);
    else reloadPages.add(pageId);
  }

  if (removeLocalBlockIds.size > 0) {
    useStore.setState((current) => ({
      blocksByPage: Object.fromEntries(
        Object.entries(current.blocksByPage).map(([pageId, blocks]) => [
          pageId,
          blocks.filter((block) => !removeLocalBlockIds.has(block.id)),
        ])
      ),
    }));
  }
  for (const pageId of reloadBlockPages) void reloadBlocksFromServer(pageId);
  for (const dbId of reloadDatabases) {
    void useStore.getState().loadDatabase(dbId, { force: true, rows: true }).catch(() => {});
  }
  for (const pageId of reloadPages) {
    void getPageRemote(pageId)
      .then((page) => useStore.getState().applyRemotePage(page))
      .catch(() => {});
  }
}

function rollbackPendingPageCreate(rootId: string, originHref: string) {
  const ids = pendingPageCreateSubtree(rootId);
  for (const id of ids) rollbackDependentWritesForFailedCreate(id);
  const state = useStore.getState();
  const blockIds = new Set<string>();
  for (const pageId of ids) {
    for (const block of state.blocksByPage[pageId] ?? []) blockIds.add(block.id);
    for (const [blockId, hintPageId] of pendingBlockPage) {
      if (hintPageId === pageId) blockIds.add(blockId);
    }
    for (const block of pendingBlockCreate.values()) {
      if (block.pageId === pageId) blockIds.add(block.id);
    }
  }

  for (const pageId of ids) {
    const entry = pendingPageCreate.get(pageId);
    const timer = pageCreateTimers.get(pageId);
    if (timer) clearTimeout(timer);
    pageCreateTimers.delete(pageId);
    pendingPageCreate.delete(pageId);
    if (entry) outboxAck(entry.userId, `create-page:${pageId}`);
    cancelPendingPage(pageId);
  }
  for (const blockId of blockIds) {
    cancelPendingBlock(blockId);
    cancelPendingBlockCreate(blockId);
  }

  useStore.setState((current) => {
    const pagesById = { ...current.pagesById };
    const pageRolesById = { ...current.pageRolesById };
    const blocksByPage = { ...current.blocksByPage };
    const blockHistoryByPage = { ...current.blockHistoryByPage };
    const commentsByPage = { ...current.commentsByPage };
    const propsByDb = { ...current.propsByDb };
    const viewsByDb = { ...current.viewsByDb };
    const templatesByDb = { ...current.templatesByDb };
    const databaseRowIdsByDb = { ...current.databaseRowIdsByDb };
    const databaseRowPagesByDb = { ...current.databaseRowPagesByDb };
    const loadedBlockPages = new Set(current.loadedBlockPages);
    const loadedCommentPages = new Set(current.loadedCommentPages);
    const loadedDbs = new Set(current.loadedDbs);
    const sharedPageIds = new Set(current.sharedPageIds);
    const treeExpandedPageIds = new Set(current.treeExpandedPageIds);

    for (const pageId of ids) {
      delete pagesById[pageId];
      delete pageRolesById[pageId];
      delete blocksByPage[pageId];
      delete blockHistoryByPage[pageId];
      delete commentsByPage[pageId];
      delete propsByDb[pageId];
      delete viewsByDb[pageId];
      delete templatesByDb[pageId];
      delete databaseRowPagesByDb[pageId];
      loadedBlockPages.delete(pageId);
      loadedCommentPages.delete(pageId);
      loadedDbs.delete(pageId);
      sharedPageIds.delete(pageId);
      treeExpandedPageIds.delete(pageId);
    }
    for (const [databaseId, rowIds] of Object.entries(databaseRowIdsByDb)) {
      databaseRowIdsByDb[databaseId] = rowIds.filter((id) => !ids.has(id));
    }

    return {
      pagesById,
      pageRolesById,
      blocksByPage,
      blockHistoryByPage,
      commentsByPage,
      propsByDb,
      viewsByDb,
      templatesByDb,
      databaseRowIdsByDb,
      databaseRowPagesByDb,
      databaseSubitemRowWindowsByDb: pruneDatabaseSubitemRowWindows(
        current.databaseSubitemRowWindowsByDb,
        ids
      ),
      databaseDependencyRelations: pruneDatabaseDependencyRelations(
        current.databaseDependencyRelations,
        ids
      ),
      loadedBlockPages,
      loadedCommentPages,
      loadedDbs,
      sharedPageIds,
      treeExpandedPageIds,
      recentPageIds: current.recentPageIds.filter((id) => !ids.has(id)),
      ...(current.focusPageId && ids.has(current.focusPageId)
        ? { focusPageId: undefined, focusPageTarget: undefined }
        : {}),
    };
  });

  if (typeof window === "undefined" || !originHref.startsWith("/")) return;
  const route = routeInfoFromPath(window.location.pathname);
  const activeId =
    route.kind === "page"
      ? route.pageId
      : route.kind === "database"
        ? route.databaseId
        : undefined;
  if (activeId && ids.has(activeId)) replaceRoute(originHref);
}

function releaseOptimisticCreateDependents(id: string) {
  for (const [childId, entry] of pendingPageCreate) {
    if (entry.page.parentId === id) retryPageCreate(childId, 0);
  }
  const pagesById = useStore.getState().pagesById;
  for (const [pageId, patch] of pendingPage) {
    const targetParentId = Object.prototype.hasOwnProperty.call(patch, "parentId")
      ? patch.parentId
      : pagesById[pageId]?.parentId;
    if (pageId === id || targetParentId === id || valueReferencesId(patch, id)) {
      void flushPage(pageId);
    }
  }
  for (const [blockId, block] of pendingBlockCreate) {
    if (block.pageId === id || valueReferencesId(block, id)) void flushBlockCreate(blockId);
  }
  for (const [blockId, pageId] of pendingBlockPage) {
    if (pageId === id || valueReferencesId(pendingBlock.get(blockId), id)) void flushBlock(blockId);
  }
  wakeBackgroundDurableCalls();
  wakeDeferredDurableCalls();
}

function mergePersistedPageCreateAuthority(persisted: Page, current: Page): Page {
  const merged = { ...persisted, ...current };
  // User content may have advanced while create was in flight, but these
  // fields are the server's committed concurrency identity. Letting the
  // provisional local timestamps win makes the first queued edit compare
  // against a revision that never existed on the server.
  if (persisted.createdAt !== undefined) merged.createdAt = persisted.createdAt;
  if (persisted.updatedAt !== undefined) merged.updatedAt = persisted.updatedAt;
  if (persisted.lastMutationId !== undefined) {
    merged.lastMutationId = persisted.lastMutationId;
  }
  return merged;
}

function adoptPersistedPageCreateAuthority(id: string, persisted: Page) {
  if (!pendingPage.has(id)) return;
  if (persisted.updatedAt) pendingPageBase.set(id, persisted.updatedAt);
  else pendingPageBase.delete(id);
  if (persisted.lastMutationId) {
    pendingPageExpectedMutationId.set(id, persisted.lastMutationId);
  } else {
    pendingPageExpectedMutationId.delete(id);
  }
  // Replace the same durable generation before releasing it, so a crash after
  // create acknowledgement cannot replay the provisional timestamp either.
  void mirrorPendingPage(id);
}

function finishPendingPageCreate(id: string, persisted?: Page) {
  const entry = pendingPageCreate.get(id);
  if (!entry) return;
  pendingPageCreate.delete(id);
  const timer = pageCreateTimers.get(id);
  if (timer) clearTimeout(timer);
  pageCreateTimers.delete(id);
  outboxAck(entry.userId, `create-page:${id}`);
  if (persisted) {
    // The user may already have typed a title while the create request was in
    // flight. Server-only fields fill gaps, but fresher local values win.
    useStore.setState((state) => {
      const current = state.pagesById[id];
      if (!current) return {};
      return {
        pagesById: {
          ...state.pagesById,
          [id]: mergePersistedPageCreateAuthority(persisted, current),
        },
      };
    });
    adoptPersistedPageCreateAuthority(id, persisted);
  }
  noteSyncSuccess();
  releaseOptimisticCreateDependents(id);
}

async function flushPageCreate(id: string) {
  const timer = pageCreateTimers.get(id);
  if (timer) clearTimeout(timer);
  pageCreateTimers.delete(id);
  const entry = pendingPageCreate.get(id);
  if (!entry) return;
  const active = pageCreateInFlight.get(id);
  if (active) {
    await active.catch(() => {});
    return;
  }
  if (entry.page.parentId && pendingPageLikeCreateHas(entry.page.parentId)) return;

  const run = (async () => {
    try {
      const persisted = await createPageRemote(entry.page);
      finishPendingPageCreate(id, persisted);
    } catch (error) {
      if (shouldDropPersistError(error)) {
        // Exact stable-id replays return 2xx. A raw 409 can also be a foreign
        // id/route/parent conflict, so it is a silent terminal drop rather than
        // commit proof.
        if (persistErrorStatus(error) !== 409) notifyPersistDrop(error);
        rollbackPendingPageCreate(id, entry.originHref);
        return;
      }
      noteSyncFailure();
      retryPageCreate(id);
    }
  })();
  pageCreateInFlight.set(id, run);
  try {
    await run;
  } finally {
    if (pageCreateInFlight.get(id) === run) pageCreateInFlight.delete(id);
  }
}

function persistPageCreate(page: Page, originHref: string, userId: string) {
  pendingPageCreate.set(page.id, { originHref, page, userId });
  outboxSet(userId, `create-page:${page.id}`, {
    args: [page],
    fn: "createPageRemote",
    kind: "remote_call",
  });
  // Let the click handler finish its local route change before starting I/O.
  // This also makes an immediate terminal response recover the already-opened
  // optimistic route instead of racing just ahead of router.push().
  retryPageCreate(page.id, 0);
}

// One-shot block create/delete persistence with the same transient-vs-terminal
// retry policy as flushBlock/flushPage. addBlockLocal and deleteBlock used to be
// fire-and-forget (`.catch(() => {})`), so a transient network/auth blip
// silently lost a just-created block (or an unpersisted delete) with no retry
// and no toast — the block reappeared/vanished on the next reload.
const pendingBlockCreate = new Map<string, Block>();
const pendingBlockCreateTouchPage = new Set<string>();
const blockCreateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const blockCreateInFlight = new Map<string, Promise<void>>();

function semanticPageMutationPending(id: string) {
  return [inFlightPagePatch.get(id), pendingPage.get(id)].some((patch) =>
    patch && Object.keys(patch).some((key) => key !== "updatedAt" && key !== "lastEditedBy")
  );
}

function retryBlockCreate(id: string) {
  if (blockCreateTimers.has(id)) return;
  blockCreateTimers.set(id, setTimeout(() => void flushBlockCreate(id), PERSIST_RETRY_MS));
}

async function flushBlockCreate(id: string) {
  const t = blockCreateTimers.get(id);
  if (t) {
    clearTimeout(t);
    blockCreateTimers.delete(id);
  }
  const block = pendingBlockCreate.get(id);
  if (!block) return;
  const active = blockCreateInFlight.get(id);
  if (active) {
    await active.catch(() => {});
    return;
  }
  const run = (async () => {
    if (pendingPageLikeCreateHas(block.pageId) || valueReferencesPendingCreate(block)) return;
    // A page patch and a new block both advance the page's remote revision.
    // Drain an already-admitted title/metadata generation before the block
    // create so an immediate title -> Enter -> body sequence cannot let the
    // block invalidate the page patch's compare-and-swap baseline. Local block
    // insertion and focus stay synchronous; only the remote deliveries queue.
    if (semanticPageMutationPending(block.pageId)) {
      await flushPage(block.pageId);
      if (semanticPageMutationPending(block.pageId)) {
        retryBlockCreate(id);
        return;
      }
    }
    // A child's create must not reach the backend before its parent's create:
    // block-mutation validates parentId and 404s ("Parent block was not
    // found"), which the drop policy treats as terminal — the child would be
    // lost server-side. Bursts like template application create a parent and
    // its children in the same tick, so serialize child behind parent here.
    const parentId = block.parentId;
    if (parentId) {
      const parentRun = blockCreateInFlight.get(parentId);
      if (parentRun) await parentRun.catch(() => {});
      else if (pendingBlockCreate.has(parentId)) await flushBlockCreate(parentId);
      if (pendingBlockCreate.has(parentId)) {
        // Parent create hit a transient failure and is queued for retry —
        // retry the child after it instead of racing into a terminal 404.
        retryBlockCreate(id);
        return;
      }
    }
    try {
      await runAcknowledgedMutation({
        send: () => pendingBlockCreateTouchPage.has(id)
          ? createBlockRemote(block, { touchPage: true })
          : createBlockRemote(block),
        commit: async (persisted) => {
          await reconcilePersistedBlockMutation(id, persisted, block.pageId);
          if (pendingBlock.has(id) && persisted) {
            if (persisted.updatedAt) pendingBlockBase.set(id, persisted.updatedAt);
            else pendingBlockBase.delete(id);
            if (persisted.lastMutationId) {
              pendingBlockExpectedMutationId.set(id, persisted.lastMutationId);
            } else {
              pendingBlockExpectedMutationId.delete(id);
            }
            // The queued edit was accepted while the create was in flight.
            // Replace its provisional local base in the same durable outbox
            // generation before the create acknowledgement releases it.
            mirrorPendingBlock(id);
          }
          pendingBlockCreate.delete(id);
          pendingBlockCreateTouchPage.delete(id);
        },
        acknowledge: () => outboxAck(outboxUserId(), `create:${id}`),
      });
      publishBlockStructureMutation(block.pageId, "block_create_committed", [id]);
      noteSyncSuccess();
      if (pendingBlock.has(id)) void flushBlock(id);
    } catch (error) {
      if (shouldDropPersistError(error)) {
        const disposition = persistErrorStatus(error) === 409 ? "silent_drop" : "drop";
        if (disposition === "drop") notifyPersistDrop(error);
        await transitionToTerminalReconciliation(
          outboxUserId(),
          `create:${id}`,
          {
            block,
            kind: "block_create",
            ...(pendingBlockCreateTouchPage.has(id) ? { touchPage: true } : {}),
          },
          disposition,
          error,
          () => {
            cancelPendingBlock(id);
            useStore.setState((state) => ({
              blocksByPage: {
                ...state.blocksByPage,
                [block.pageId]: (state.blocksByPage[block.pageId] ?? []).filter(
                  (current) => current.id !== id
                ),
              },
            }));
          },
          () => {
            pendingBlockCreate.delete(id);
            pendingBlockCreateTouchPage.delete(id);
          }
        );
        return;
      }
      noteSyncFailure();
      retryBlockCreate(id);
    }
  })();
  blockCreateInFlight.set(id, run);
  try {
    await run;
  } finally {
    if (blockCreateInFlight.get(id) === run) blockCreateInFlight.delete(id);
  }
}

function persistBlockCreate(block: Block, options: { touchPage?: boolean } = {}) {
  pendingBlockCreate.set(block.id, block);
  if (options.touchPage === true) pendingBlockCreateTouchPage.add(block.id);
  else pendingBlockCreateTouchPage.delete(block.id);
  outboxSet(outboxUserId(), `create:${block.id}`, {
    block,
    kind: "block_create",
    ...(options.touchPage === true ? { touchPage: true } : {}),
  });
  void flushBlockCreate(block.id);
}

function cancelPendingBlockCreate(id: string) {
  const t = blockCreateTimers.get(id);
  if (t) {
    clearTimeout(t);
    blockCreateTimers.delete(id);
  }
  pendingBlockCreate.delete(id);
  pendingBlockCreateTouchPage.delete(id);
  outboxAck(outboxUserId(), `create:${id}`);
}

async function runBlockDelete(ids: string[], hintPageId?: string, opKey?: string) {
  try {
    const userId = outboxUserId();
    await runAcknowledgedMutation({
      send: () => deleteBlocksRemote(ids, hintPageId),
      commit: async () => {
        if (userId && hintPageId) {
          await commitPersistedBlockDeletionToCache(userId, hintPageId, ids);
        }
        for (const id of ids) optimisticBlockOverlays.delete(id);
      },
      acknowledge: () => {
        if (opKey) outboxAck(userId, opKey);
      },
    });
    if (hintPageId) {
      publishBlockStructureMutation(hintPageId, "block_delete_committed", ids);
    }
    noteSyncSuccess();
  } catch (error) {
    if (shouldDropPersistError(error)) {
      // A raw 404 can be a routing/authority miss, so reload canonical blocks
      // instead of publishing a false deletion confirmation.
      const disposition = persistErrorStatus(error) === 404 ? "silent_drop" : "drop";
      if (disposition === "drop") notifyPersistDrop(error);
      if (opKey) {
        await transitionToTerminalReconciliation(
          outboxUserId(),
          opKey,
          { hintPageId, ids, kind: "block_delete" },
          disposition,
          error
        );
      } else if (hintPageId) {
        await reloadBlocksFromServer(hintPageId).catch(() => {});
      }
      return;
    }
    noteSyncFailure();
    setTimeout(() => void runBlockDelete(ids, hintPageId, opKey), PERSIST_RETRY_MS);
  }
}

async function persistBlockDelete(ids: string[], hintPageId?: string) {
  // Let any in-flight create for these ids settle, then cancel pending
  // creates/updates so a queued retry can't resurrect a block we're deleting.
  const inflight = ids
    .map((id) => blockCreateInFlight.get(id))
    .filter((p): p is Promise<void> => Boolean(p));
  if (inflight.length) await Promise.all(inflight.map((p) => p.catch(() => {})));
  for (const id of ids) {
    cancelPendingBlockCreate(id);
    cancelPendingBlock(id);
  }
  const opKey = `delete:${newId()}`;
  outboxSet(outboxUserId(), opKey, { hintPageId, ids, kind: "block_delete" });
  await runBlockDelete(ids, hintPageId, opKey);
}

function touchPageForBlockChange(
  updatePage: AppState["updatePage"],
  pageId: string,
  opts?: { debounce?: boolean; debounceMs?: number }
) {
  updatePage(pageId, {}, {
    debounce: opts?.debounce ?? true,
    debounceMs: opts?.debounce ? opts.debounceMs : undefined,
  });
}

/** Flush every pending debounced write immediately (e.g. before unload). */
export async function flushAllPending() {
  // Creation is the causal root for every title/block/child write on a new
  // page, so give that lane the first chance to settle before flushing its
  // dependents in parallel.
  await Promise.allSettled([
    ...Array.from(pageCreateInFlight.values()),
    ...Array.from(pendingPageCreate.keys()).map((id) => flushPageCreate(id)),
  ]);
  await Promise.allSettled([
    ...Array.from(backgroundDurableInFlight.values()),
    ...Array.from(backgroundDurableCalls.keys()).map((opKey) =>
      runBackgroundDurableCall(opKey)
    ),
  ]);
  await Promise.allSettled([
    ...Array.from(deferredDurableInFlight.values()),
    ...Array.from(deferredDurableCalls.keys()).map(runDeferredDurableCall),
  ]);
  await Promise.allSettled([
    ...Array.from(pageFlushes.values()),
    ...Array.from(blockBatchFlushes.values()),
    ...Array.from(blockCreateInFlight.values()),
    ...Array.from(pendingPage.keys()).map((id) => flushPage(id)),
    ...Array.from(new Set(pendingBlockPage.values())).map((pageId) =>
      flushBlockBatch(pageId)
    ),
    ...Array.from(pendingBlockCreate.keys()).map((id) => flushBlockCreate(id)),
  ]);
  // Block acknowledgements can admit page-recency generations while the
  // block lanes above are settling. Force the complete bounded page drain only
  // after those admissions exist; transient failures remain durable for their
  // scheduled backoff instead of making lifecycle flush spin forever.
  await flushPageRecencies(true);
  // A newer same-key page generation can start while the captured generation
  // is settling. Join those already-running continuations without spinning on
  // retryable work that was deliberately re-queued for the bounded backoff.
  // Four stabilization passes cover the create/update/ack/remirror chain while
  // keeping this explicit flush bounded if edits continue concurrently.
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
    const activePageRuns = Array.from(pageFlushes.values());
    if (activePageRuns.length === 0) break;
    await Promise.allSettled(activePageRuns);
  }
}

// ── durable outbox replay (local-first Phase 0) ─────────────────────────────
// After boot, mutations left durably queued by tabs that died before flushing
// replay in enqueue order under the same transient/terminal policy as the live
// queues. An entity that is live in this session merges the replayed patch
// UNDER any fresher local edit and reuses the normal flush path; everything
// else replays directly with the routing captured at enqueue time, so entries
// from another workspace still reach the right mutation function.

/**
 * Privacy guard for shared devices: unsynced queue data and cached records
 * must not outlive the session that produced them (roadmap §6.8).
 */
export async function clearDurableOutboxOnSignOut() {
  const userId = outboxUserId();
  clearRecentDatabaseRowsQueries();
  resetPageRecencyMemory();
  resetCommentSignalRefreshes();
  cancelScheduledWarmOfflineScope();
  resetReadApplicationGuards();
  resetDeferredBlockCreates();
  await Promise.allSettled([
    outboxClear(userId),
    recordCacheClear(userId),
    clearOfflineWorkspaceFileCache(),
  ]);
  await clearLegacyLocalDataOnSignOut(userId).catch(() => {});
  clearLegacyBrowserStorage();
  try {
    window.localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // Local storage is optional.
  }
}

/** Test hook: allow a fresh bootstrap after resetStore (bootPromise is module state). */
export function resetBootstrapForTests() {
  cancelScheduledWarmOfflineScope();
  resetWorkspaceRefreshLoop();
  bootPromise = null;
  bootKey = "";
  databaseMetadataRevalidated.clear();
  resetReadApplicationGuards();
}

/** Test-only isolation for module-level persistence lanes. */
export function resetPendingPersistenceForTests() {
  cancelScheduledWarmOfflineScope();
  resetReadApplicationGuards();
  resetPageRecencyMemory();
  resetCommentSignalRefreshes();
  for (const timer of pageTimers.values()) clearTimeout(timer);
  for (const timer of blockTimers.values()) clearTimeout(timer);
  for (const timer of blockBatchTimers.values()) clearTimeout(timer);
  for (const timer of blockCreateTimers.values()) clearTimeout(timer);
  for (const timer of pageCreateTimers.values()) clearTimeout(timer);
  for (const timer of backgroundDurableTimers.values()) clearTimeout(timer);
  for (const timer of deferredDurableTimers.values()) clearTimeout(timer);
  for (const timer of replayQueueTimers.values()) clearTimeout(timer);
  pageTimers.clear();
  blockTimers.clear();
  blockBatchTimers.clear();
  blockCreateTimers.clear();
  pageCreateTimers.clear();
  backgroundDurableTimers.clear();
  deferredDurableTimers.clear();
  replayQueueTimers.clear();
  replayQueues.clear();
  replayQueueRuns.clear();
  pendingPage.clear();
  pendingPageBase.clear();
  pendingPageExpectedMutationId.clear();
  pendingPageMutationId.clear();
  pendingPageBefore.clear();
  pendingPageDurability.clear();
  inFlightPageMutationId.clear();
  inFlightPagePatch.clear();
  optimisticPageOverlays.clear();
  optimisticBlockOverlays.clear();
  pendingBlock.clear();
  pendingBlockPage.clear();
  pendingBlockBase.clear();
  pendingBlockExpectedMutationId.clear();
  pendingBlockMutationId.clear();
  inFlightBlockMutationId.clear();
  pendingBlockCreate.clear();
  pendingBlockCreateTouchPage.clear();
  resetDeferredBlockCreates();
  pendingPageCreate.clear();
  pendingDatabaseCreate.clear();
  pendingDatabaseRowCreate.clear();
  pendingPropertyCreate.clear();
  pendingViewCreate.clear();
  pendingTemplateCreate.clear();
  pendingCommentCreate.clear();
  backgroundDurableCalls.clear();
  deferredDurableCalls.clear();
  pageFlushes.clear();
  blockFlushes.clear();
  blockBatchFlushes.clear();
  blockCreateInFlight.clear();
  pageCreateInFlight.clear();
  backgroundDurableInFlight.clear();
  deferredDurableInFlight.clear();
  blockSnapshotRuns.clear();
  pageTerminalReconciliationPromises.clear();
  databaseMetadataRevalidated.clear();
  databaseRowsForcedAgain.clear();
  resetRecentDatabaseRowsQueries();
}

// ── offline scope warmer (local-first Phase 3 v2) ───────────────────────────
// After an online boot, finish only incomplete explicit offline pins. Ordinary
// visits already write every accepted page/block/schema/exact-row response to
// IndexedDB, so favorites and recents need no second server walk. Pin recovery
// is delayed until the current surface has been quiet for ten seconds and the
// browser is idle, keeping it out of the first page-read window.

const WARM_MAX_PAGES = 30;
const WARM_MAX_DATABASES = 10;
const OFFLINE_SCOPE_WARM_QUIET_MS = 10_000;
let offlineScopeWarmTimer: ReturnType<typeof setTimeout> | undefined;
let offlineScopeWarmIdleId: number | undefined;

function cancelScheduledWarmOfflineScope() {
  if (offlineScopeWarmTimer !== undefined) {
    clearTimeout(offlineScopeWarmTimer);
    offlineScopeWarmTimer = undefined;
  }
  if (offlineScopeWarmIdleId !== undefined && typeof window !== "undefined") {
    const idleWindow = window as Window & { cancelIdleCallback?: (handle: number) => void };
    idleWindow.cancelIdleCallback?.(offlineScopeWarmIdleId);
    offlineScopeWarmIdleId = undefined;
  }
}

export function scheduleWarmOfflineScope(userId: string) {
  if (!userId || typeof window === "undefined") return;
  cancelScheduledWarmOfflineScope();
  const run = () => {
    offlineScopeWarmIdleId = undefined;
    if (outboxUserId() !== userId || !useStore.getState().ready) return;
    void warmOfflineScope(userId);
  };
  offlineScopeWarmTimer = setTimeout(() => {
    offlineScopeWarmTimer = undefined;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    };
    if (idleWindow.requestIdleCallback) {
      offlineScopeWarmIdleId = idleWindow.requestIdleCallback(run, { timeout: 10_000 });
    } else {
      run();
    }
  }, OFFLINE_SCOPE_WARM_QUIET_MS);
}

const NON_FILE_TEXT_FIELDS = new Set([
  "caption",
  "description",
  "fileName",
  "label",
  "name",
  "plainText",
  "text",
  "title",
]);

function collectStorageKeys(
  value: unknown,
  keys: Set<string>,
  seen: Set<object>,
  field = ""
) {
  if (typeof value === "string") {
    if (NON_FILE_TEXT_FIELDS.has(field)) return;
    const key = value.startsWith("workspaces/") ? value : storageKeyFromUrl(value);
    if (key) keys.add(key);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStorageKeys(item, keys, seen, field);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    collectStorageKeys(nested, keys, seen, key);
  }
}

function pageOfflineFileKeys(pageId: string, databaseIds: Iterable<string> = []) {
  const state = useStore.getState();
  const keys = new Set<string>();
  const seen = new Set<object>();
  collectStorageKeys(state.pagesById[pageId], keys, seen);
  collectStorageKeys(state.blocksByPage[pageId], keys, seen);
  for (const databaseId of databaseIds) {
    for (const rowId of state.databaseRowIdsByDb[databaseId] ?? []) {
      collectStorageKeys(state.pagesById[rowId], keys, seen);
    }
  }
  return keys;
}

async function completeCachedDatabaseRows(
  userId: string,
  databaseId: string
): Promise<Page[] | null> {
  const entries = await cacheGetMeta<Array<{ h: string }>>(
    userId,
    recordCacheMeta.databaseRowQueryRegistry(databaseId)
  );
  if (!entries?.length) return null;
  // A complete cached query is sufficient for the currently defined offline
  // scope. Partial first pages never qualify: their attachments and row set
  // are demonstrably incomplete.
  for (const entry of [...entries].reverse()) {
    const keys = databaseRowCacheKeysFromSuffix(databaseId, entry.h);
    const meta = await cacheGetMeta<CachedRowsMeta>(userId, keys.meta);
    if (!meta || meta.hasMore) continue;
    const records = await cacheListTable<Page>(userId, keys.dataTable);
    const rowsById = new Map(records.map((record) => [record.id, record.value]));
    if (meta.rowIds.some((id) => !rowsById.has(id))) continue;
    return meta.rowIds.map((id) => rowsById.get(id)!).filter(Boolean);
  }
  return null;
}

export async function warmPageOfflineFiles(pageId: string, databaseIds: Iterable<string> = []) {
  return cacheWorkspaceFilesForOffline(pageOfflineFileKeys(pageId, databaseIds));
}

/** Cache one page's blocks and its embedded/linked databases (pin scope). */
export async function warmPageOfflineScope(pageId: string): Promise<string[]> {
  const state = useStore.getState();
  const page = state.pagesById[pageId];
  if (!page || page.inTrash) return [];
  const dbIds = new Set<string>();
  if (page.kind === "database") {
    dbIds.add(pageId);
  } else {
    try {
      await state.loadBlocks(pageId);
    } catch {
      // Explicit pin warming is best-effort; readiness remains truthful.
    }
    for (const block of useStore.getState().blocksByPage[pageId] ?? []) {
      const childId = block.content?.childPageId;
      if (childId && useStore.getState().pagesById[childId]?.kind === "database") {
        dbIds.add(childId);
      }
    }
  }
  await warmPageOfflineFiles(pageId, dbIds);
  return [...dbIds];
}

/**
 * Completeness check for the offline pin (never-show-partial, §6.6): blocks
 * are stamped AND every embedded database has schema + at least one complete
 * row query cached. Used to tell the user whether a pin is fully offline-ready.
 */
export async function isPageOfflineReady(pageId: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId) return false;
  const page = useStore.getState().pagesById[pageId];
  if (!page) return false;
  const dbIds: string[] = [];
  const requiredFileKeys = pageOfflineFileKeys(pageId);
  if (page.kind === "database") {
    dbIds.push(pageId);
  } else {
    const stamp = await cacheGetMeta<string>(userId, recordCacheMeta.blocksStamp(pageId));
    if (!stamp) return false;
    const records = await cacheListTable<Block>(userId, recordCacheTables.blocks(pageId));
    collectStorageKeys(records.map((record) => record.value), requiredFileKeys, new Set<object>());
    for (const record of records) {
      const childId = record.value.content?.childPageId;
      if (childId && useStore.getState().pagesById[childId]?.kind === "database") {
        dbIds.push(childId);
      }
    }
  }
  for (const dbId of dbIds) {
    const [propsRecords, rows] = await Promise.all([
      cacheListTable(userId, recordCacheTables.databaseProperties(dbId)),
      completeCachedDatabaseRows(userId, dbId),
    ]);
    if (!propsRecords.length || rows === null) return false;
    collectStorageKeys(rows, requiredFileKeys, new Set<object>());
  }
  for (const key of pageOfflineFileKeys(pageId, dbIds)) requiredFileKeys.add(key);
  if (!(await hasCachedWorkspaceFiles(requiredFileKeys))) return false;
  return true;
}

export async function warmOfflineScope(userId: string) {
  try {
    const pins = await getOfflinePins(userId);
    const state = useStore.getState();
    const targets = Object.keys(pins)
      .filter((id) => {
        const page = state.pagesById[id];
        return !!page && !page.inTrash;
      })
      .slice(0, WARM_MAX_PAGES);
    for (const pageId of targets) {
      if (await isPageOfflineReady(pageId)) continue;
      const databaseIds = (await warmPageOfflineScope(pageId)).slice(0, WARM_MAX_DATABASES);
      const loadedDatabaseIds: string[] = [];
      for (const databaseId of databaseIds) {
        try {
          await useStore.getState().loadDatabase(databaseId, {});
          loadedDatabaseIds.push(databaseId);
        } catch {
          // Best-effort; the next idle online visit can retry the incomplete pin.
        }
      }
      if (loadedDatabaseIds.length) {
        await warmPageOfflineFiles(pageId, loadedDatabaseIds);
      }
    }
  } catch {
    // Warming must never break boot.
  }
}

type ReplayOutcome = "complete" | "retry";

type ReplayQueue = {
  entries: OutboxEntry[];
  index: number;
};

const replayQueues = new Map<string, ReplayQueue>();
const replayQueueTimers = new Map<string, ReturnType<typeof setTimeout>>();
const replayQueueRuns = new Map<string, Promise<void>>();

function scheduleReplayQueue(userId: string) {
  if (replayQueueTimers.has(userId)) return;
  replayQueueTimers.set(
    userId,
    setTimeout(() => {
      replayQueueTimers.delete(userId);
      void runReplayQueue(userId);
    }, PERSIST_RETRY_MS)
  );
}

async function runReplayQueue(userId: string) {
  const active = replayQueueRuns.get(userId);
  if (active) return active;
  const run = (async () => {
    const queue = replayQueues.get(userId);
    if (!queue) return;
    while (queue.index < queue.entries.length) {
      const entry = queue.entries[queue.index]!;
      // Sequential on purpose: enqueue order is the causality order (a create
      // replays before a later update or delete that references it). A transient
      // create failure pauses the whole claimed lane instead of allowing its
      // dependent block/schema writes to race into terminal 404s.
      const outcome = await replayOutboxOp(userId, entry.entryKey, entry.value).catch(
        () => "retry" as const
      );
      if (outcome === "retry") {
        scheduleReplayQueue(userId);
        return;
      }
      queue.index += 1;
    }
    replayQueues.delete(userId);
  })();
  replayQueueRuns.set(userId, run);
  try {
    await run;
  } finally {
    if (replayQueueRuns.get(userId) === run) replayQueueRuns.delete(userId);
  }
}

export async function replayDurableOutbox(userId: string) {
  const existing = replayQueues.get(userId);
  if (existing) {
    const timer = replayQueueTimers.get(userId);
    if (timer) clearTimeout(timer);
    replayQueueTimers.delete(userId);
    await runReplayQueue(userId);
    return;
  }
  const entries = await outboxClaimAbandoned(userId);
  if (!entries.length) return;
  replayQueues.set(userId, { entries, index: 0 });
  await runReplayQueue(userId);
}

async function replayOutboxOp(
  userId: string,
  entryKey: string,
  op: OutboxOp
): Promise<ReplayOutcome> {
  switch (op.kind) {
    case "terminal_reconciliation": {
      const error = terminalReconciliationError(op);
      const settled = await finishTerminalReconciliation(
        userId,
        entryKey,
        op,
        error
      );
      return settled ? "complete" : "retry";
    }
    case "page_update": {
      if (pendingPage.has(op.id) || useStore.getState().pagesById[op.id]) {
        if (!pendingPage.has(op.id)) {
          if (op.expectedUpdatedAt) pendingPageBase.set(op.id, op.expectedUpdatedAt);
          else pendingPageBase.delete(op.id);
          if (op.expectedMutationId) {
            pendingPageExpectedMutationId.set(op.id, op.expectedMutationId);
          } else {
            pendingPageExpectedMutationId.delete(op.id);
          }
          if (op.mutationId) pendingPageMutationId.set(op.id, op.mutationId);
          else pendingPageMutationId.delete(op.id);
        }
        pendingPage.set(op.id, { ...op.patch, ...(pendingPage.get(op.id) ?? {}) });
        mirrorPendingPage(op.id);
        await flushPage(op.id);
        return "complete";
      }
      return replayRemote(userId, entryKey, op, async () => {
        if (op.expectedUpdatedAt || op.mutationId || op.expectedMutationId) {
          if (op.target === "database_row") {
            await updateDatabaseRowRemote(
              op.id,
              op.patch,
              op.expectedUpdatedAt,
              op.mutationId,
              op.expectedMutationId,
            );
          } else {
            await updatePageRemote(
              op.id,
              op.patch,
              op.expectedUpdatedAt,
              op.mutationId,
              op.expectedMutationId,
            );
          }
        } else if (op.target === "database_row") {
          await updateDatabaseRowRemote(op.id, op.patch);
        } else {
          await updatePageRemote(op.id, op.patch);
        }
      });
    }
    case "block_update": {
      if (pendingBlock.has(op.id)) {
        pendingBlock.set(op.id, { ...op.patch, ...(pendingBlock.get(op.id) ?? {}) });
        if (op.hintPageId && !pendingBlockPage.has(op.id)) {
          pendingBlockPage.set(op.id, op.hintPageId);
        }
        mirrorPendingBlock(op.id);
        await flushBlock(op.id);
        return "complete";
      }
      return replayRemote(userId, entryKey, op, async () => {
        // Replayed offline edits carry the optimistic-concurrency guard: if the
        // block changed on another device meanwhile, the server 409s and the
        // conflict path below keeps the server version + offers "apply mine".
        return updateBlockRemote(
          op.id,
          op.patch,
          op.hintPageId,
          op.expectedUpdatedAt,
          op.mutationId,
          op.expectedMutationId,
        );
      });
    }
    case "block_create":
      return replayRemote(userId, entryKey, op, async () => {
        await (op.touchPage
          ? createBlockRemote(op.block, { touchPage: true })
          : createBlockRemote(op.block));
      });
    case "block_delete":
      return replayRemote(userId, entryKey, op, async () => {
        await deleteBlocksRemote(op.ids, op.hintPageId);
      });
    case "page_recency":
      return replayPageRecency(userId, entryKey, op);
    case "remote_call": {
      const entry = DURABLE_REMOTE_CALLS[op.fn];
      if (!entry) {
        // Unknown fn (schema drift across app versions) — drop rather than
        // wedge the replay loop on an op we can no longer execute.
        outboxAck(userId, entryKey);
        return "complete";
      }
      if (op.effect?.kind === "row_file_remove") {
        await startSerializedRowFileRemovalCall(
          userId,
          entryKey,
          op.fn,
          op.effect
        );
        return "complete";
      }
      return replayRemote(userId, entryKey, op, () => entry.fn(...op.args));
    }
  }
}

async function replayPageRecency(
  userId: string,
  entryKey: string,
  op: PageRecencyOutboxOp,
): Promise<ReplayOutcome> {
  try {
    const { dueAt: _dueAt, kind: _kind, ...proof } = op;
    await touchBlockPageRecencyRemote(proof);
    await outboxAck(userId, entryKey);
    noteSyncSuccess();
    return "complete";
  } catch (error) {
    if (persistErrorStatus(error) === 404) {
      await outboxAck(userId, entryKey);
      noteSyncSuccess();
      return "complete";
    }
    noteSyncFailure();
    return "retry";
  }
}

function replayTerminalDisposition(
  op: MutationOutboxOp,
  status: number | undefined
): DurableTerminalDisposition {
  // Legacy block ops predate the shared registry, but raw status has the same
  // semantics: exact idempotent replay is 2xx; ambiguous 404/409 drops silently.
  if (op.kind === "block_create" && status === 409) return "silent_drop";
  if (op.kind === "block_delete" && status === 404) return "silent_drop";
  if (op.kind === "remote_call") {
    return durableTerminalDisposition(DURABLE_REMOTE_CALLS[op.fn], status);
  }
  return "drop";
}

async function reconcileDroppedLegacyOutboxOp(op: MutationOutboxOp) {
  if (op.kind === "page_update") {
    const databaseId = op.target === "database_row" ? databaseIdForPageLike(op.id) : undefined;
    if (databaseId) {
      await useStore
        .getState()
        .loadDatabaseRows(databaseId, { force: true, reset: true });
    } else {
      await reconcilePageAfterTerminalDrop(op.id);
    }
    return;
  }
  if (op.kind === "block_update" && op.hintPageId) {
    await reconcileDroppedBlockStructure({
      blockIds: [op.id],
      pageIds: [op.hintPageId],
    });
    return;
  }
  if (op.kind === "block_create") {
    await reconcileDroppedBlockStructure({
      blockIds: [op.block.id],
      pageIds: [op.block.pageId],
    });
    return;
  }
  if (op.kind === "block_delete" && op.hintPageId) {
    await reconcileDroppedBlockStructure({ blockIds: op.ids, pageIds: [op.hintPageId] });
  }
}

function legacyReplayRemoteCallDropEffect(
  op: Extract<OutboxOp, { kind: "remote_call" }>
): RemoteCallEffect | undefined {
  if (op.effect) return op.effect;
  // Compatibility with durable entries written before property reconciliation
  // effects existed. The whitelisted call captured its database routing hint
  // at args[2], so no schema/content inference or additional authority read is
  // needed to recover the metadata-only refresh after an upgrade.
  const databaseId = op.fn === "updatePropertyRemote" ? op.args[2] : undefined;
  if (typeof databaseId !== "string" || !databaseId.trim()) return undefined;
  return { databaseId: databaseId.trim(), kind: "database_metadata_reconcile" };
}

function blockHistoryMatchesDropMarker(
  entry: BlockHistoryEntry,
  marker: NonNullable<
    BlockStructureInvalidation["dropReconciliation"]
  >["histories"][number]
) {
  if (entry.at !== marker.at) return false;
  if (marker.linkId && entry.link?.id !== marker.linkId) return false;
  return entry.operations?.some(
    (operation) => operation.occurredAt === marker.operationOccurredAt
  ) ?? false;
}

function restoreDroppedBlockStructureHistory(invalidation: BlockStructureInvalidation) {
  const reconciliation = invalidation.dropReconciliation;
  if (!reconciliation) return;
  useStore.setState((state) => {
    let blockHistoryByPage = state.blockHistoryByPage;
    let changed = false;
    for (const marker of reconciliation.histories.slice(
      0,
      MAX_BLOCK_STRUCTURE_INVALIDATION_PAGES
    )) {
      const history = blockHistoryByPage[marker.pageId];
      if (!history) continue;
      const destination = reconciliation.direction === "undo" ? history.past : history.future;
      if (destination.some((entry) => blockHistoryMatchesDropMarker(entry, marker))) continue;
      const source = reconciliation.direction === "undo" ? history.future : history.past;
      const index = source.findLastIndex((entry) => blockHistoryMatchesDropMarker(entry, marker));
      if (index < 0) continue;
      const entry = source[index];
      const remaining = source.slice(0, index).concat(source.slice(index + 1));
      blockHistoryByPage = {
        ...blockHistoryByPage,
        [marker.pageId]: reconciliation.direction === "undo"
          ? {
              past: destination.concat(entry).slice(-HISTORY_LIMIT),
              future: remaining,
            }
          : {
              past: remaining,
              future: destination.concat(entry).slice(-HISTORY_LIMIT),
            },
      };
      changed = true;
    }
    return changed ? { blockHistoryByPage } : {};
  });
}

async function reconcileDroppedBlockStructure(invalidation: BlockStructureInvalidation) {
  restoreDroppedBlockStructureHistory(invalidation);
  const bounded = blockStructureInvalidation(invalidation.pageIds);
  if (!bounded) return;
  await Promise.all(bounded.pageIds.map((pageId) => reloadBlocksFromServer(pageId)));
}

function publishCommittedRemoteCallBlockStructure(
  fnKey: string,
  args: unknown[],
  invalidation?: BlockStructureInvalidation
) {
  const byPage = new Map<string, Set<string>>();
  const add = (pageId: unknown, blockId: unknown) => {
    if (typeof pageId !== "string" || !pageId) return;
    const ids = byPage.get(pageId) ?? new Set<string>();
    if (typeof blockId === "string" && blockId) ids.add(blockId);
    byPage.set(pageId, ids);
  };
  const asRecord = (value: unknown) =>
    value && typeof value === "object" ? value as Record<string, unknown> : undefined;

  if (fnKey === "createBlockRemote") {
    const block = asRecord(args[0]);
    add(block?.pageId, block?.id);
  } else if (fnKey === "createBlocksRemote") {
    for (const value of Array.isArray(args[0]) ? args[0] : []) {
      const block = asRecord(value);
      add(block?.pageId, block?.id);
    }
  } else if (fnKey === "deleteBlockRemote") {
    add(args[1], args[0]);
  } else if (fnKey === "deleteBlocksRemote") {
    for (const id of Array.isArray(args[0]) ? args[0] : []) add(args[1], id);
  } else if (fnKey === "updateBlockRemote") {
    const patch = asRecord(args[1]);
    if (patch && blockPatchChangesStructure(patch as Partial<Block>)) {
      add(typeof patch.pageId === "string" ? patch.pageId : args[2], args[0]);
    }
  } else if (fnKey === "updateBlocksRemote") {
    for (const value of Array.isArray(args[0]) ? args[0] : []) {
      const update = asRecord(value);
      const patch = asRecord(update?.patch);
      if (!patch || !blockPatchChangesStructure(patch as Partial<Block>)) continue;
      add(typeof patch.pageId === "string" ? patch.pageId : args[1], update?.id);
    }
  }

  const explicit = invalidation
    ? blockStructureInvalidation(invalidation.pageIds, invalidation.blockIds)
    : undefined;
  for (const pageId of explicit?.pageIds ?? []) {
    if (explicit?.blockIds?.length) {
      for (const blockId of explicit.blockIds) add(pageId, blockId);
    } else {
      add(pageId, undefined);
    }
  }

  for (const [pageId, blockIds] of byPage) {
    publishBlockStructureMutation(pageId, `committed_${fnKey}`, blockIds);
  }
}

function publishReplayedBlockStructureMutation(op: MutationOutboxOp) {
  if (op.kind === "block_create") {
    publishBlockStructureMutation(op.block.pageId, "replayed_block_create", [op.block.id]);
    return;
  }
  if (op.kind === "block_delete") {
    if (op.hintPageId) {
      publishBlockStructureMutation(op.hintPageId, "replayed_block_delete", op.ids);
    }
    return;
  }
  if (op.kind === "block_update") {
    if (op.hintPageId && blockPatchChangesStructure(op.patch)) {
      publishBlockStructureMutation(op.hintPageId, "replayed_block_structure_update", [op.id]);
    }
    return;
  }
  if (op.kind === "remote_call") {
    publishCommittedRemoteCallBlockStructure(
      op.fn,
      op.args,
      op.blockStructureInvalidation
    );
  }
}

function shouldDropRemoteCallEffectError(op: MutationOutboxOp, error: unknown) {
  // The SDK already attempted its session refresh before surfacing a 401.
  // A file detach must not remain optimistically hidden forever after that
  // definitive denial, while unrelated mutation queues keep their existing
  // auth-refresh/retry policy.
  if (
    op.kind === "remote_call" &&
    op.effect?.kind === "row_file_remove" &&
    persistErrorStatus(error) === 401
  ) {
    return true;
  }
  return shouldDropPersistError(error);
}

async function replayRemote(
  userId: string,
  entryKey: string,
  op: MutationOutboxOp,
  run: () => Promise<unknown>
): Promise<ReplayOutcome> {
  try {
    const result = await run();
    if (op.kind === "block_update") {
      const normalized = normalizedBlockUpdateResult(result);
      await reconcileReplayedBlockUpdate(userId, op, normalized);
      if (normalized.pageRecency) {
        await admitBlockPageRecency(normalized.pageRecency);
      }
    }
    if (op.kind === "remote_call" && op.effect) {
      await applyRemoteCallEffectSuccess(op.effect, result);
    }
    publishReplayedBlockStructureMutation(op);
    await outboxAck(userId, entryKey);
    noteSyncSuccess();
    return "complete";
  } catch (error) {
    if (shouldDropRemoteCallEffectError(op, error)) {
      if (
        op.kind === "block_update" &&
        op.expectedUpdatedAt &&
        persistErrorStatus(error) === 409
      ) {
        await transitionToTerminalReconciliation(
          userId,
          entryKey,
          op,
          "drop",
          error,
          () => handleBlockReplayConflict(op)
        );
        return "complete";
      }
      const disposition = replayTerminalDisposition(op, persistErrorStatus(error));
      if (disposition === "confirmed") {
        if (op.kind === "remote_call" && op.effect) {
          await applyRemoteCallEffectSuccess(op.effect, undefined);
        }
        publishReplayedBlockStructureMutation(op);
        await outboxAck(userId, entryKey);
        noteSyncSuccess();
        return "complete";
      }
      if (disposition === "drop") notifyPersistDrop(error);
      await transitionToTerminalReconciliation(
        userId,
        entryKey,
        op,
        disposition,
        error
      );
      return "complete";
    }
    noteSyncFailure();
    // The queue owns the retry so later claimed operations cannot overtake
    // this one while the durable create/update is still unavailable.
    return "retry";
  }
}

async function reconcileReplayedBlockUpdate(
  userId: string,
  op: Extract<OutboxOp, { kind: "block_update" }>,
  result: unknown
) {
  const direct = recordValue(result);
  const nested = recordValue(direct?.block);
  let authoritative = (
    typeof nested?.id === "string"
      ? nested
      : typeof direct?.id === "string"
        ? direct
        : undefined
  ) as Block | undefined;
  const pageId = op.hintPageId ?? authoritative?.pageId;
  if (!pageId) return;
  if (!authoritative) {
    const live = useStore
      .getState()
      .blocksByPage[pageId]
      ?.find((block) => block.id === op.id);
    const cached = live
      ? undefined
      : (await cacheListTable<Block>(userId, recordCacheTables.blocks(pageId))).find(
          (record) => record.id === op.id
        )?.value;
    const baseline = live ?? cached;
    if (!baseline) return;
    authoritative = { ...baseline, ...op.patch, id: op.id, pageId };
  }

  useStore.setState((state) => {
    const blocks = state.blocksByPage[pageId];
    if (!blocks?.some((block) => block.id === authoritative.id)) return {};
    return {
      blocksByPage: {
        ...state.blocksByPage,
        [pageId]: blocks.map((block) =>
          block.id === authoritative.id ? authoritative : block
        ),
      },
    };
  });
  await commitPersistedBlockToCache(userId, authoritative);
}

/**
 * A replayed offline block edit lost the optimistic-concurrency race: another
 * device changed the block after this patch was queued. Default to the server
 * version (refetch so the user sees current truth) and offer a one-click
 * "apply my version" that re-sends the local patch without the guard.
 */
function handleBlockReplayConflict(op: Extract<OutboxOp, { kind: "block_update" }>) {
  const pageId = op.hintPageId;
  const messages = storeMessages();
  useStore.getState().notify(messages.blockConflictSave, "error", {
    label: messages.blockConflictKeepMine,
    onClick: async () => {
      try {
        const result = normalizedBlockUpdateResult(
          await updateBlockRemote(op.id, op.patch, pageId, undefined, op.mutationId)
        );
        if (result.pageRecency) await admitBlockPageRecency(result.pageRecency);
        if (pageId) await reloadBlocksFromServer(pageId);
      } catch (error) {
        notifyPersistDrop(error);
      }
    },
  });
}

/** Force-refetch a page's blocks past the loaded/cache-fresh shortcuts. */
async function reloadBlocksFromServer(pageId: string) {
  useStore.setState((s) => {
    if (!s.loadedBlockPages.has(pageId)) return {};
    const loadedBlockPages = new Set(s.loadedBlockPages);
    loadedBlockPages.delete(pageId);
    return { loadedBlockPages };
  });
  await useStore.getState().loadBlocks(pageId, { force: true });
}

// ── durable one-shot remote calls (local-first Phase 0 completion) ──────────
// For every mutation where optimistic local state precedes the network but no
// debounced queue exists: page/row/property/view/template/comment creates and
// deletes, trash/restore, moves, and the undo/redo block batch paths. The call
// is mirrored durably before the attempt, retried on transient errors, and
// dropped (with a toast unless benign) on terminal ones — the same policy as
// the flush queues. Result-driven flows with no optimistic state (duplicate,
// import, workspace create) stay plain awaits on purpose: they fail loudly and
// lose nothing.
//
// `benign` preserves the historical user-notification policy for statuses that
// should not produce a second failure toast. `confirmed` is narrower: only it
// may turn a terminal response into idempotent success. Raw legacy 404/409
// responses prove no commit in this registry; exact idempotent replays return
// an ordinary 2xx response from the handler.

type DurableRemoteFn = (...args: never[]) => Promise<unknown>;
type DurableRemoteEntry = {
  benign: number[];
  confirmed: number[];
  fn: (...args: unknown[]) => Promise<unknown>;
};
type DurableTerminalDisposition = "confirmed" | "silent_drop" | "drop";

function durableEntry(
  fn: DurableRemoteFn,
  benign: number[],
  confirmed: number[] = []
): DurableRemoteEntry {
  return {
    benign,
    confirmed,
    fn: fn as unknown as (...args: unknown[]) => Promise<unknown>,
  };
}

function durableTerminalDisposition(
  entry: DurableRemoteEntry | undefined,
  status: number | undefined
): DurableTerminalDisposition {
  if (status !== undefined && entry?.confirmed.includes(status)) return "confirmed";
  if (status !== undefined && entry?.benign.includes(status)) return "silent_drop";
  return "drop";
}

const DURABLE_REMOTE_CALLS: Record<string, DurableRemoteEntry> = {
  applyBlockSnapshotRemote: durableEntry(applyBlockSnapshotRemote, []),
  createBlockRemote: durableEntry(createBlockRemote, [409]),
  createBlocksRemote: durableEntry(createBlocksRemote, [404, 409]),
  createCommentRemote: durableEntry(createCommentRemote, [409]),
  createDatabaseRemote: durableEntry(createDatabaseRemote, [409]),
  configureDatabaseTaskFeatureRemote: durableEntry(configureDatabaseTaskFeatureRemote, []),
  createDatabaseRowRemote: durableEntry(createDatabaseRowRemote, [404, 409]),
  createPageRemote: durableEntry(createPageRemote, [409]),
  createPropertyRemote: durableEntry(createPropertyRemote, [409]),
  createTemplateRemote: durableEntry(createTemplateRemote, [409]),
  createViewRemote: durableEntry(createViewRemote, [409]),
  deleteBlockRemote: durableEntry(deleteBlockRemote, [404]),
  deleteBlocksRemote: durableEntry(deleteBlocksRemote, [404]),
  deleteDatabaseRowRemote: durableEntry(deleteDatabaseRowRemote, [404]),
  deletePageRemote: durableEntry(deletePageRemote, [404]),
  deletePropertyRemote: durableEntry(deletePropertyRemote, [404]),
  deleteTemplateRemote: durableEntry(deleteTemplateRemote, [404]),
  deleteViewRemote: durableEntry(deleteViewRemote, [404]),
  moveDatabaseRowRemote: durableEntry(moveDatabaseRowRemote, [404]),
  reparentDatabaseSubitemRemote: durableEntry(reparentDatabaseSubitemRemote, [404]),
  restoreDatabaseRowRemote: durableEntry(restoreDatabaseRowRemote, [404]),
  restorePageRemote: durableEntry(restorePageRemote, [404]),
  trashDatabaseRowRemote: durableEntry(trashDatabaseRowRemote, [404]),
  trashPageRemote: durableEntry(trashPageRemote, [404]),
  updateBlockRemote: durableEntry(updateBlockRemote, [404, 409]),
  updateBlocksRemote: durableEntry(updateBlocksRemote, [404, 409]),
  deleteCommentsRemote: durableEntry(deleteCommentsRemote, [404]),
  updateCommentRemote: durableEntry(updateCommentRemote, [404]),
  updateCommentsRemote: durableEntry(updateCommentsRemote, [404]),
  updateDatabaseRowRemote: durableEntry(updateDatabaseRowRemote, []),
  updateDatabaseDependencyRelationRemote: durableEntry(updateDatabaseDependencyRelationRemote, [404]),
  updatePageRemote: durableEntry(updatePageRemote, [404]),
  updatePropertyRemote: durableEntry(updatePropertyRemote, [404]),
  updateTemplateRemote: durableEntry(updateTemplateRemote, [404]),
  updateViewRemote: durableEntry(updateViewRemote, [404]),
};

export function durableRemotePolicyForTests() {
  return Object.entries(DURABLE_REMOTE_CALLS).map(([fn, entry]) => ({
    benign: entry.benign.slice(),
    confirmed: entry.confirmed.slice(),
    fn,
  }));
}

export function durableRemoteStatusOutcomeForTests(
  fnKey: string,
  status: number | undefined,
  hasError = true
): DurableTerminalDisposition | "success" {
  if (!hasError && status !== undefined && status >= 200 && status < 300) return "success";
  return durableTerminalDisposition(DURABLE_REMOTE_CALLS[fnKey], status);
}

const MAX_REMOTE_CALL_RECONCILIATION_KEYS = 100;
const pageTerminalReconciliationPromises = new Map<string, Promise<void>>();

function boundedReconciliationKeys(values: Iterable<unknown>) {
  return Array.from(
    new Set(
      Array.from(values)
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_REMOTE_CALL_RECONCILIATION_KEYS);
}

function mergeRemoteCallTerminalReconciliation(
  ...values: Array<RemoteCallTerminalReconciliation | undefined>
): RemoteCallTerminalReconciliation | undefined {
  const merged: RemoteCallTerminalReconciliation = {};
  for (const key of [
    "commentPageIds",
    "databaseMetadataIds",
    "databaseRowIds",
    "pageIds",
  ] as const) {
    const ids = boundedReconciliationKeys(values.flatMap((value) => value?.[key] ?? []));
    if (ids.length) merged[key] = ids;
  }
  return Object.keys(merged).length ? merged : undefined;
}

function remoteCallBlockInvalidation(
  fnKey: string,
  args: unknown[]
): BlockStructureInvalidation | undefined {
  const records = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter(
      (item): item is Record<string, unknown> => !!item && typeof item === "object"
    );
  if (fnKey === "createBlockRemote") {
    const block = recordValue(args[0]);
    return blockStructureInvalidation([block?.pageId], [block?.id]);
  }
  if (fnKey === "createBlocksRemote") {
    const blocks = records(args[0]);
    return blockStructureInvalidation(
      blocks.map((block) => block.pageId),
      blocks.map((block) => block.id)
    );
  }
  if (fnKey === "deleteBlockRemote") {
    return blockStructureInvalidation([args[1]], [args[0]]);
  }
  if (fnKey === "deleteBlocksRemote") {
    return blockStructureInvalidation([args[1]], Array.isArray(args[0]) ? args[0] : []);
  }
  if (fnKey === "updateBlockRemote") {
    const patch = recordValue(args[1]);
    return blockStructureInvalidation([patch?.pageId, args[2]], [args[0]]);
  }
  if (fnKey === "updateBlocksRemote") {
    const updates = records(args[0]);
    return blockStructureInvalidation(
      [args[1], ...updates.map((update) => recordValue(update.patch)?.pageId)],
      updates.map((update) => update.id)
    );
  }
  if (fnKey === "applyBlockSnapshotRemote") {
    const input = recordValue(args[0]);
    const creates = records(input?.creates);
    const updates = records(input?.updates);
    return blockStructureInvalidation(
      [input?.pageId, ...creates.map((block) => block.pageId)],
      [
        ...creates.map((block) => block.id),
        ...updates.map((update) => update.id),
        ...(Array.isArray(input?.deleteIds) ? input.deleteIds : []),
      ]
    );
  }
  return undefined;
}

function databaseIdForPageLike(value: unknown) {
  if (typeof value !== "string") return undefined;
  const page = useStore.getState().pagesById[value];
  return page?.parentType === "database" ? page.parentId : undefined;
}

function inferRemoteCallTerminalReconciliation(
  fnKey: string,
  args: unknown[],
  effect?: RemoteCallEffect
): RemoteCallTerminalReconciliation | undefined {
  const first = recordValue(args[0]);
  const metadataId =
    fnKey === "createPropertyRemote" || fnKey === "createTemplateRemote" || fnKey === "createViewRemote"
      ? first?.databaseId
      : fnKey === "updatePropertyRemote" || fnKey === "updateTemplateRemote" || fnKey === "updateViewRemote"
        ? args[2]
        : fnKey === "deletePropertyRemote" || fnKey === "deleteTemplateRemote" || fnKey === "deleteViewRemote"
          ? args[1]
          : undefined;

  const rowDatabaseIds: unknown[] = [];
  if (fnKey === "createDatabaseRowRemote") rowDatabaseIds.push(first?.databaseId);
  if (
    fnKey === "deleteDatabaseRowRemote" ||
    fnKey === "restoreDatabaseRowRemote" ||
    fnKey === "trashDatabaseRowRemote" ||
    fnKey === "moveDatabaseRowRemote"
  ) {
    rowDatabaseIds.push(databaseIdForPageLike(args[0]), databaseIdForPageLike(args[1]));
  }
  if (fnKey === "updatePageRemote") rowDatabaseIds.push(databaseIdForPageLike(args[0]));

  const commentPageIds: unknown[] = [];
  if (fnKey === "createCommentRemote") commentPageIds.push(first?.pageId);
  if (fnKey === "updateCommentRemote") commentPageIds.push(args[2]);
  if (fnKey === "deleteCommentsRemote" || fnKey === "updateCommentsRemote") {
    commentPageIds.push(args[1]);
    for (const value of Array.isArray(args[0]) ? args[0] : []) {
      const update = recordValue(value);
      commentPageIds.push(recordValue(update?.patch)?.pageId);
    }
  }

  const pageIds: unknown[] = [];
  if (fnKey === "createPageRemote") pageIds.push(first?.id);
  if (
    fnKey === "deletePageRemote" ||
    fnKey === "restorePageRemote" ||
    fnKey === "trashPageRemote"
  ) {
    pageIds.push(args[0]);
  }
  if (fnKey === "updatePageRemote" && rowDatabaseIds.every((value) => !value)) {
    pageIds.push(args[0]);
  }

  return mergeRemoteCallTerminalReconciliation({
    ...(commentPageIds.length ? { commentPageIds: boundedReconciliationKeys(commentPageIds) } : {}),
    ...(metadataId && effect?.kind !== "database_metadata_reconcile"
      ? { databaseMetadataIds: boundedReconciliationKeys([metadataId]) }
      : {}),
    ...(rowDatabaseIds.length
      ? { databaseRowIds: boundedReconciliationKeys(rowDatabaseIds) }
      : {}),
    ...(pageIds.length ? { pageIds: boundedReconciliationKeys(pageIds) } : {}),
  });
}

function pruneRemoteCallOptimism(fnKey: string, args: unknown[]) {
  const first = recordValue(args[0]);
  if (fnKey === "createBlockRemote" || fnKey === "createBlocksRemote") {
    const blocks = fnKey === "createBlockRemote"
      ? [first]
      : (Array.isArray(args[0]) ? args[0] : []).map(recordValue);
    const ids = new Set(
      blocks.flatMap((block) => typeof block?.id === "string" ? [block.id] : [])
    );
    for (const id of ids) rollbackDependentWritesForFailedCreate(id);
    useStore.setState((state) => ({
      blocksByPage: Object.fromEntries(
        Object.entries(state.blocksByPage).map(([pageId, values]) => [
          pageId,
          values.filter((value) => !ids.has(value.id)),
        ])
      ),
    }));
    return;
  }
  const targetId =
    typeof first?.id === "string"
      ? first.id
      : typeof args[0] === "string"
        ? args[0]
        : undefined;
  if (!targetId) return;
  if (fnKey === "createPageRemote") {
    rollbackPendingPageCreate(targetId, "/");
    return;
  }
  if (fnKey === "createDatabaseRowRemote") {
    rollbackDependentWritesForFailedCreate(targetId);
    useStore.setState((state) => {
      const pagesById = { ...state.pagesById };
      const blocksByPage = { ...state.blocksByPage };
      delete pagesById[targetId];
      delete blocksByPage[targetId];
      return {
        pagesById,
        blocksByPage,
        databaseRowIdsByDb: Object.fromEntries(
          Object.entries(state.databaseRowIdsByDb).map(([databaseId, ids]) => [
            databaseId,
            ids.filter((id) => id !== targetId),
          ])
        ),
        ...(state.focusPageId === targetId
          ? { focusPageId: undefined, focusPageTarget: undefined }
          : {}),
      };
    });
    return;
  }
  const collection =
    fnKey === "createPropertyRemote"
      ? "propsByDb"
      : fnKey === "createViewRemote"
        ? "viewsByDb"
        : fnKey === "createTemplateRemote"
          ? "templatesByDb"
          : undefined;
  if (!collection) return;
  useStore.setState((state) => ({
    [collection]: Object.fromEntries(
      Object.entries(
        state[collection] as Record<string, Array<{ id: string }>>
      ).map(([databaseId, values]) => [
        databaseId,
        values.filter((value) => value.id !== targetId),
      ])
    ),
  }));
}

function reconcilePageAfterTerminalDrop(pageId: string) {
  const existing = pageTerminalReconciliationPromises.get(pageId);
  if (existing) return existing;
  const run = useStore
    .getState()
    .refreshPageAccess(pageId)
    .finally(() => {
      if (pageTerminalReconciliationPromises.get(pageId) === run) {
        pageTerminalReconciliationPromises.delete(pageId);
      }
    });
  pageTerminalReconciliationPromises.set(pageId, run);
  return run;
}

async function reconcileRemoteCallTerminalDrop(
  fnKey: string,
  args: unknown[],
  effect?: RemoteCallEffect,
  explicit?: RemoteCallTerminalReconciliation
) {
  const mergedReconciliation = mergeRemoteCallTerminalReconciliation(
    explicit,
    inferRemoteCallTerminalReconciliation(fnKey, args, effect)
  );
  const reconciliation = effect?.kind === "database_metadata_reconcile"
    ? mergeRemoteCallTerminalReconciliation({
        ...mergedReconciliation,
        databaseMetadataIds: mergedReconciliation?.databaseMetadataIds?.filter(
          (databaseId) => databaseId !== effect.databaseId
        ),
      })
    : effect?.kind === "database_rows_reconcile"
      ? mergeRemoteCallTerminalReconciliation({
          ...mergedReconciliation,
          databaseRowIds: mergedReconciliation?.databaseRowIds?.filter(
            (databaseId) => databaseId !== effect.databaseId
          ),
        })
      : mergedReconciliation;
  pruneRemoteCallOptimism(fnKey, args);
  if (!reconciliation) return;
  await Promise.all([
    ...(reconciliation.pageIds ?? []).map(reconcilePageAfterTerminalDrop),
    ...(reconciliation.databaseMetadataIds ?? []).map((databaseId) =>
      useStore.getState().loadDatabase(databaseId, { force: true, rows: false })
    ),
    ...(reconciliation.databaseRowIds ?? []).map((databaseId) =>
      useStore
        .getState()
        .loadDatabaseRows(databaseId, { force: true, reset: true })
    ),
    ...(reconciliation.commentPageIds ?? []).map((pageId) =>
      useStore.getState().loadComments(pageId, { force: true })
    ),
  ]);
}

function terminalReconciliationMarker(
  operation: MutationOutboxOp,
  disposition: Exclude<DurableTerminalDisposition, "confirmed">,
  status: number | undefined
): TerminalReconciliationOutboxOp {
  return {
    disposition,
    kind: "terminal_reconciliation",
    operation,
    ...(status === undefined ? {} : { status }),
  };
}

function terminalReconciliationError(marker: TerminalReconciliationOutboxOp) {
  return Object.assign(
    new Error(
      marker.status === undefined
        ? "Terminal mutation requires reconciliation."
        : `HTTP ${marker.status}`
    ),
    marker.status === undefined ? {} : { status: marker.status }
  );
}

async function reconcileTerminalOperation(
  operation: MutationOutboxOp,
  error: unknown
) {
  if (operation.kind !== "remote_call") {
    await reconcileDroppedLegacyOutboxOp(operation);
    return;
  }
  const effect = legacyReplayRemoteCallDropEffect(operation);
  if (effect) await applyRemoteCallEffectDrop(effect, error);
  await reconcileRemoteCallTerminalDrop(
    operation.fn,
    operation.args,
    effect,
    operation.terminalReconciliation
  );
  if (operation.blockStructureInvalidation) {
    await reconcileDroppedBlockStructure(operation.blockStructureInvalidation);
  }
}

async function finishTerminalReconciliation(
  userId: string,
  entryKey: string,
  marker: TerminalReconciliationOutboxOp,
  error: unknown,
  beforeReconciliation?: BeforeTerminalReconciliation
) {
  try {
    await beforeReconciliation?.(error);
    await reconcileTerminalOperation(marker.operation, error);
    await outboxAck(userId, entryKey);
    return true;
  } catch {
    // The mutation outcome is already terminal. Keep the reconciliation-only
    // marker and pending hint intact so a later eligible session can resume
    // canonical settlement without ever resending the mutation.
    noteSyncFailure();
    return false;
  }
}

async function transitionToTerminalReconciliation(
  userId: string,
  entryKey: string,
  operation: MutationOutboxOp,
  disposition: Exclude<DurableTerminalDisposition, "confirmed">,
  error: unknown,
  beforeReconciliation?: BeforeTerminalReconciliation,
  afterDurableTransition?: () => void | Promise<void>
) {
  const marker = terminalReconciliationMarker(
    operation,
    disposition,
    persistErrorStatus(error)
  );
  await outboxSet(userId, entryKey, marker);
  // Only now may the live mutation lane discard its retry/timer state.
  await afterDurableTransition?.();
  return finishTerminalReconciliation(
    userId,
    entryKey,
    marker,
    error,
    beforeReconciliation
  );
}

type DurableCallResult =
  | { result: unknown; status: "ok" }
  | { status: "queued" }
  | { error: unknown; status: "dropped" };

type BeforeTerminalReconciliation = (
  error: unknown
) => void | Promise<void>;

function remoteCallWaitsForOptimisticCreate(args: unknown[]) {
  return valueReferencesPendingCreate(args);
}

type DeferredDurableCall = {
  args: unknown[];
  beforeTerminalReconciliation?: BeforeTerminalReconciliation;
  blockStructureInvalidation?: BlockStructureInvalidation;
  effect?: RemoteCallEffect;
  fnKey: string;
  terminalReconciliation?: RemoteCallTerminalReconciliation;
  userId: string;
};

const deferredDurableCalls = new Map<string, DeferredDurableCall>();
const deferredDurableTimers = new Map<string, ReturnType<typeof setTimeout>>();
const deferredDurableInFlight = new Map<string, Promise<void>>();
const deferredDurableRetryAttempts = new Map<string, number>();

function persistRetryDelayMs(attempt: number) {
  return Math.min(PERSIST_RETRY_MAX_MS, PERSIST_RETRY_MS * 2 ** Math.max(0, attempt - 1));
}

function scheduleDeferredDurableCall(
  opKey: string,
  fnKey: string,
  args: unknown[],
  effect: RemoteCallEffect | undefined,
  invalidation: BlockStructureInvalidation | undefined,
  terminalReconciliation: RemoteCallTerminalReconciliation | undefined,
  beforeTerminalReconciliation: BeforeTerminalReconciliation | undefined,
  userId: string,
  delay = PERSIST_RETRY_MS
) {
  deferredDurableCalls.set(opKey, {
    args,
    beforeTerminalReconciliation,
    blockStructureInvalidation: invalidation,
    effect,
    fnKey,
    terminalReconciliation,
    userId,
  });
  if (deferredDurableTimers.has(opKey)) return;
  const timer = setTimeout(() => {
    if (deferredDurableTimers.get(opKey) === timer) {
      deferredDurableTimers.delete(opKey);
    }
    void runDeferredDurableCall(opKey).catch(() => {});
  }, delay);
  deferredDurableTimers.set(opKey, timer);
}

function finishDeferredDurableCall(opKey: string) {
  const timer = deferredDurableTimers.get(opKey);
  if (timer) clearTimeout(timer);
  deferredDurableTimers.delete(opKey);
  deferredDurableCalls.delete(opKey);
  deferredDurableRetryAttempts.delete(opKey);
}

function scheduleDeferredDurableRetry(
  opKey: string,
  fnKey: string,
  args: unknown[],
  effect: RemoteCallEffect | undefined,
  invalidation: BlockStructureInvalidation | undefined,
  terminalReconciliation: RemoteCallTerminalReconciliation | undefined,
  beforeTerminalReconciliation: BeforeTerminalReconciliation | undefined,
  userId: string
) {
  const attempt = (deferredDurableRetryAttempts.get(opKey) ?? 0) + 1;
  deferredDurableRetryAttempts.set(opKey, attempt);
  scheduleDeferredDurableCall(
    opKey,
    fnKey,
    args,
    effect,
    invalidation,
    terminalReconciliation,
    beforeTerminalReconciliation,
    userId,
    persistRetryDelayMs(attempt)
  );
}

function wakeDeferredDurableCalls() {
  for (const [opKey, call] of deferredDurableCalls) {
    if (remoteCallWaitsForOptimisticCreate(call.args)) continue;
    const timer = deferredDurableTimers.get(opKey);
    if (timer) clearTimeout(timer);
    deferredDurableTimers.delete(opKey);
    deferredDurableRetryAttempts.delete(opKey);
    scheduleDeferredDurableCall(
      opKey,
      call.fnKey,
      call.args,
      call.effect,
      call.blockStructureInvalidation,
      call.terminalReconciliation,
      call.beforeTerminalReconciliation,
      call.userId,
      0
    );
  }
}

function cancelDurableCallsReferencing(id: string) {
  for (const [opKey, call] of deferredDurableCalls) {
    if (!valueReferencesId(call.args, id)) continue;
    finishDeferredDurableCall(opKey);
    outboxAck(call.userId, opKey);
  }
}

function firstDroppedDurableCall(calls: DurableCallResult[]) {
  return calls.find(
    (call): call is Extract<DurableCallResult, { status: "dropped" }> =>
      call.status === "dropped"
  );
}

// File detach payloads are whole-property snapshots. Two removals for the same
// row/property therefore cannot be allowed to race: A->[B] completing after
// B->null would resurrect B. Each operation is persisted first, then occupies
// this causal lane through transient retries until it either commits or drops.
// Later removals can still render optimistically and return `queued`, but their
// network attempt cannot overtake the earlier effect.
const rowFilePropertyRuns = new Map<string, Promise<void>>();
const rowFileRemovalCommittedValues = new Map<string, unknown>();

function rowFileRemovalRunKey(effect: RowFileRemovalEffect) {
  return `${effect.rowId}:${effect.propertyId}`;
}

function persistRetryDelay() {
  return new Promise<void>((resolve) => setTimeout(resolve, PERSIST_RETRY_MS));
}

function databaseRowFilePropertyIds(page: Page | undefined, patch: Partial<Page>) {
  if (page?.parentType !== "database" || !page.parentId) return [];
  const properties = recordValue(patch.properties);
  if (!properties) return [];
  const filePropertyIds = new Set(
    (useStore.getState().propsByDb[page.parentId] ?? [])
      .filter((property) => property.type === "files")
      .map((property) => property.id)
  );
  return Object.keys(properties).filter((propertyId) => filePropertyIds.has(propertyId));
}

async function runSerializedRowFilePropertyPatch<T>(
  rowId: string,
  propertyIds: string[],
  run: () => Promise<T>
): Promise<T> {
  const keys = Array.from(new Set(propertyIds.map((propertyId) => `${rowId}:${propertyId}`)));
  if (!keys.length) return run();
  const predecessors = Array.from(
    new Set(keys.map((key) => rowFilePropertyRuns.get(key)).filter(Boolean))
  ) as Promise<void>[];
  const operation = Promise.all(predecessors).then(run);
  const completion = operation.then(
    () => undefined,
    () => undefined
  );
  for (const key of keys) rowFilePropertyRuns.set(key, completion);
  try {
    return await operation;
  } finally {
    for (const key of keys) {
      if (rowFilePropertyRuns.get(key) !== completion) continue;
      rowFilePropertyRuns.delete(key);
      rowFileRemovalCommittedValues.delete(key);
    }
  }
}

function startSerializedRowFileRemovalCall(
  userId: string,
  opKey: string,
  fnKey: string,
  effect: RowFileRemovalEffect,
  durability: Promise<void> = Promise.resolve()
): Promise<DurableCallResult> {
  const entry = DURABLE_REMOTE_CALLS[fnKey];
  if (!entry) {
    outboxAck(userId, opKey);
    return Promise.resolve({
      error: new Error(`Unknown durable remote call: ${fnKey}`),
      status: "dropped",
    });
  }

  let reported = false;
  let resolveFirst!: (result: DurableCallResult) => void;
  const firstResult = new Promise<DurableCallResult>((resolve) => {
    resolveFirst = resolve;
  });
  const report = (result: DurableCallResult) => {
    if (reported) return;
    reported = true;
    resolveFirst(result);
  };

  const run = async () => {
    const effectiveEffect = rebaseRowFileRemovalEffect(effect);
    supersedePendingRowFileValue(effectiveEffect);
    const effectiveArgs = [
      effectiveEffect.rowId,
      { properties: { [effectiveEffect.propertyId]: effectiveEffect.nextValue } },
    ];
    // A predecessor may have committed or rolled back after this operation
    // was first persisted. Rewrite the durable snapshot before attempting it
    // so a crash/reload preserves the rebased causal payload too.
    const rebasedDurability = outboxSet(userId, opKey, {
      args: effectiveArgs,
      effect: effectiveEffect,
      fn: fnKey,
      kind: "remote_call",
    });
    // Boot reconciliation can replace the cached outbox overlay with a fresh
    // server snapshot before replay starts. Re-apply this operation's intent
    // when its causal lane reaches the front; remove only its own item so
    // earlier rollbacks and later additions remain intact.
    applyRowFileRemovalIntent(effectiveEffect);
    await Promise.all([durability, rebasedDurability]);
    if (effectiveEffect.cacheKey) {
      // The mounted file chip may already be resolving this exact file. Keep
      // the optimistic/outbox detach immediate, but let that bounded read
      // settle before the server write can retire its upload underneath it.
      await settleSignedWorkspaceFileUrlRequests(effectiveEffect.cacheKey);
    }
    for (;;) {
      let result: unknown;
      try {
        result = await entry.fn(...effectiveArgs);
      } catch (error) {
        if (
          shouldDropRemoteCallEffectError(
            { args: effectiveArgs, effect: effectiveEffect, fn: fnKey, kind: "remote_call" },
            error
          )
        ) {
          const disposition = durableTerminalDisposition(entry, persistErrorStatus(error));
          const operation: MutationOutboxOp = {
            args: effectiveArgs,
            effect: effectiveEffect,
            fn: fnKey,
            kind: "remote_call",
          };
          const marker = terminalReconciliationMarker(
            operation,
            disposition === "confirmed" ? "drop" : disposition,
            persistErrorStatus(error)
          );
          await outboxSet(userId, opKey, marker);
          let drop: RemoteCallEffectDropResult | undefined;
          let reconciled = false;
          try {
            drop = await applyRemoteCallEffectDrop(effectiveEffect, error);
            await outboxAck(userId, opKey);
            reconciled = true;
          } catch {
            noteSyncFailure();
          }
          if (drop?.unavailable) rowFileRemovalCommittedValues.delete(key);
          else {
            rowFileRemovalCommittedValues.set(
              key,
              drop ? drop.authoritativeValue : effectiveEffect.previousValue
            );
          }
          if (disposition === "drop") {
            notifyPersistDrop(error);
          }
          report({ error, status: "dropped" });
          if (!reconciled) return;
          return;
        }
        noteSyncFailure();
        report({ status: "queued" });
        await persistRetryDelay();
        continue;
      }

      // The server commit is authoritative even if a local cache/browser
      // side-effect later fails, so acknowledge the durable operation and do
      // not re-send the mutation in that case.
      await applyRemoteCallEffectSuccess(effectiveEffect, result).catch(() => {});
      const remote = remotePageResult(result);
      rowFileRemovalCommittedValues.set(
        key,
        remote
          ? (remote.properties?.[effectiveEffect.propertyId] ?? null)
          : effectiveEffect.nextValue
      );
      await outboxAck(userId, opKey);
      noteSyncSuccess();
      report({ result, status: "ok" });
      return;
    }
  };

  const key = rowFileRemovalRunKey(effect);
  const predecessor = rowFilePropertyRuns.get(key);
  const operation = predecessor ? predecessor.then(run) : run();
  const completion = operation.catch(() => {
    // `run` handles expected failures internally; this guard keeps an
    // unexpected exception from wedging every later removal in the lane.
    report({ status: "queued" });
  });
  rowFilePropertyRuns.set(key, completion);
  void completion.then(() => {
    if (rowFilePropertyRuns.get(key) === completion) {
      rowFilePropertyRuns.delete(key);
      rowFileRemovalCommittedValues.delete(key);
    }
  });
  if (predecessor) report({ status: "queued" });
  return firstResult;
}

/**
 * Run a whitelisted remote mutation with durable-outbox backing.
 * - ok: the call landed; `result` is the remote return value.
 * - queued: transient failure; the op is durable and retries in the background
 *   (effect-backed calls apply their commit/reconcile side effect on completion).
 * - dropped: terminal failure; the op was removed and (unless benign) toasted.
 */
async function durableRemoteCall(
  fnKey: keyof typeof DURABLE_REMOTE_CALLS & string,
  args: unknown[],
  effect?: RemoteCallEffect,
  invalidation?: BlockStructureInvalidation,
  explicitReconciliation?: RemoteCallTerminalReconciliation,
  beforeTerminalReconciliation?: BeforeTerminalReconciliation
): Promise<DurableCallResult> {
  const entry = DURABLE_REMOTE_CALLS[fnKey];
  const opKey = `call:${newId()}`;
  const userId = outboxUserId();
  const effectiveInvalidation = invalidation ?? remoteCallBlockInvalidation(fnKey, args);
  const terminalReconciliation = mergeRemoteCallTerminalReconciliation(
    explicitReconciliation,
    inferRemoteCallTerminalReconciliation(fnKey, args, effect)
  );
  const operation: MutationOutboxOp = {
    args,
    ...(effectiveInvalidation ? { blockStructureInvalidation: effectiveInvalidation } : {}),
    effect,
    fn: fnKey,
    kind: "remote_call",
    ...(terminalReconciliation ? { terminalReconciliation } : {}),
  };
  const durability = outboxSet(userId, opKey, operation);
  if (remoteCallWaitsForOptimisticCreate(args)) {
    scheduleDeferredDurableCall(
      opKey,
      fnKey,
      args,
      effect,
      effectiveInvalidation,
      terminalReconciliation,
      beforeTerminalReconciliation,
      userId
    );
    return { status: "queued" };
  }
  if (effect?.kind === "row_file_remove") {
    return startSerializedRowFileRemovalCall(userId, opKey, fnKey, effect, durability);
  }
  try {
    await durability;
    const result = await entry.fn(...args);
    if (effect) await applyRemoteCallEffectSuccess(effect, result);
    publishCommittedRemoteCallBlockStructure(fnKey, args, effectiveInvalidation);
    finishDeferredDurableCall(opKey);
    await outboxAck(userId, opKey);
    noteSyncSuccess();
    return { result, status: "ok" };
  } catch (error) {
    if (shouldDropRemoteCallEffectError({ args, effect, fn: fnKey, kind: "remote_call" }, error)) {
      const disposition = durableTerminalDisposition(entry, persistErrorStatus(error));
      if (disposition === "confirmed") {
        if (effect) await applyRemoteCallEffectSuccess(effect, undefined);
        publishCommittedRemoteCallBlockStructure(fnKey, args, effectiveInvalidation);
        finishDeferredDurableCall(opKey);
        await outboxAck(userId, opKey);
        noteSyncSuccess();
        return { result: undefined, status: "ok" };
      }
      if (disposition === "drop") notifyPersistDrop(error);
      await transitionToTerminalReconciliation(
        userId,
        opKey,
        operation,
        disposition,
        error,
        beforeTerminalReconciliation,
        () => finishDeferredDurableCall(opKey)
      );
      return { error, status: "dropped" };
    }
    noteSyncFailure();
    scheduleDeferredDurableRetry(
      opKey,
      fnKey,
      args,
      effect,
      effectiveInvalidation,
      terminalReconciliation,
      beforeTerminalReconciliation,
      userId
    );
    return { status: "queued" };
  }
}

const blockSnapshotRuns = new Map<string, Promise<void>>();

function durableBlockSnapshotCall(
  input: Parameters<typeof applyBlockSnapshotRemote>[0],
  beforeTerminalReconciliation?: BeforeTerminalReconciliation,
): Promise<DurableCallResult> {
  const fnKey = "applyBlockSnapshotRemote";
  const args = [input];
  const opKey = `call:${newId()}`;
  const userId = outboxUserId();
  const invalidation = remoteCallBlockInvalidation(fnKey, args);
  const operation: MutationOutboxOp = {
    args,
    ...(invalidation ? { blockStructureInvalidation: invalidation } : {}),
    fn: fnKey,
    kind: "remote_call",
  };
  const durability = outboxSet(userId, opKey, operation);
  const predecessor = blockSnapshotRuns.get(input.pageId);
  let reported = false;
  let resolveFirst!: (result: DurableCallResult) => void;
  const firstResult = new Promise<DurableCallResult>((resolve) => {
    resolveFirst = resolve;
  });
  const report = (result: DurableCallResult) => {
    if (reported) return;
    reported = true;
    resolveFirst(result);
  };

  const run = async () => {
    await predecessor;
    await durability;
    for (;;) {
      try {
        const result = await applyBlockSnapshotRemote(input);
        publishCommittedRemoteCallBlockStructure(fnKey, args, invalidation);
        await outboxAck(userId, opKey);
        noteSyncSuccess();
        report({ result, status: "ok" });
        return;
      } catch (error) {
        if (shouldDropRemoteCallEffectError(operation, error)) {
          const disposition = durableTerminalDisposition(
            DURABLE_REMOTE_CALLS[fnKey],
            persistErrorStatus(error),
          );
          if (disposition === "confirmed") {
            publishCommittedRemoteCallBlockStructure(fnKey, args, invalidation);
            await outboxAck(userId, opKey);
            noteSyncSuccess();
            report({ result: undefined, status: "ok" });
            return;
          }
          if (disposition === "drop") notifyPersistDrop(error);
          await transitionToTerminalReconciliation(
            userId,
            opKey,
            operation,
            disposition,
            error,
            beforeTerminalReconciliation,
          );
          report({ error, status: "dropped" });
          return;
        }
        noteSyncFailure();
        report({ status: "queued" });
        await persistRetryDelay();
      }
    }
  };
  const completion = run().catch(() => {
    noteSyncFailure();
    report({ status: "queued" });
  });
  blockSnapshotRuns.set(input.pageId, completion);
  void completion.finally(() => {
    if (blockSnapshotRuns.get(input.pageId) === completion) {
      blockSnapshotRuns.delete(input.pageId);
    }
  });
  if (predecessor) report({ status: "queued" });
  return firstResult;
}

function runDeferredDurableCall(opKey: string): Promise<void> {
  const active = deferredDurableInFlight.get(opKey);
  if (active) return active;
  const call = deferredDurableCalls.get(opKey);
  if (!call) return Promise.resolve();

  let resolveOwner!: () => void;
  let rejectOwner!: (error: unknown) => void;
  const owner = new Promise<void>((resolve, reject) => {
    resolveOwner = resolve;
    rejectOwner = reject;
  });
  // Publish ownership before invoking the attempt body. A synchronous flush
  // from a caller callback must join this exact promise rather than starting a
  // second request in the small pre-await window.
  deferredDurableInFlight.set(opKey, owner);
  void retryDurableRemoteCallOnce(opKey, call).then(resolveOwner, rejectOwner);
  void owner.then(
    () => {
      if (deferredDurableInFlight.get(opKey) === owner) {
        deferredDurableInFlight.delete(opKey);
      }
    },
    () => {
      if (deferredDurableInFlight.get(opKey) === owner) {
        deferredDurableInFlight.delete(opKey);
      }
    }
  );
  return owner;
}

async function retryDurableRemoteCallOnce(
  opKey: string,
  call: DeferredDurableCall
) {
  const {
    args,
    beforeTerminalReconciliation,
    blockStructureInvalidation: invalidation,
    effect,
    fnKey,
    terminalReconciliation,
    userId,
  } = call;
  const timer = deferredDurableTimers.get(opKey);
  if (timer) clearTimeout(timer);
  deferredDurableTimers.delete(opKey);
  const entry = DURABLE_REMOTE_CALLS[fnKey];
  if (!entry) {
    finishDeferredDurableCall(opKey);
    return;
  }
  if (remoteCallWaitsForOptimisticCreate(args)) {
    scheduleDeferredDurableCall(
      opKey,
      fnKey,
      args,
      effect,
      invalidation,
      terminalReconciliation,
      beforeTerminalReconciliation,
      userId
    );
    return;
  }
  if (effect?.kind === "row_file_remove") {
    const firstResult = startSerializedRowFileRemovalCall(
      outboxUserId(),
      opKey,
      fnKey,
      effect
    );
    // startSerializedRowFileRemovalCall installs the row/property completion
    // synchronously before returning. Transfer this exact durable op to that
    // owner now: keeping it in the deferred map until the serializer's first
    // `queued` result would let a later forced flush enqueue the same op again
    // behind its still-running retry loop.
    finishDeferredDurableCall(opKey);
    await firstResult;
    return;
  }
  try {
    const result = await entry.fn(...args);
    if (effect) await applyRemoteCallEffectSuccess(effect, result);
    publishCommittedRemoteCallBlockStructure(fnKey, args, invalidation);
    finishDeferredDurableCall(opKey);
    await outboxAck(userId, opKey);
    noteSyncSuccess();
  } catch (error) {
    if (shouldDropRemoteCallEffectError({ args, effect, fn: fnKey, kind: "remote_call" }, error)) {
      const disposition = durableTerminalDisposition(entry, persistErrorStatus(error));
      if (disposition === "confirmed") {
        if (effect) await applyRemoteCallEffectSuccess(effect, undefined);
        publishCommittedRemoteCallBlockStructure(fnKey, args, invalidation);
        finishDeferredDurableCall(opKey);
        await outboxAck(userId, opKey);
        noteSyncSuccess();
        return;
      }
      if (disposition === "drop") notifyPersistDrop(error);
      const operation: MutationOutboxOp = {
        args,
        ...(invalidation ? { blockStructureInvalidation: invalidation } : {}),
        effect,
        fn: fnKey,
        kind: "remote_call",
        ...(terminalReconciliation ? { terminalReconciliation } : {}),
      };
      await transitionToTerminalReconciliation(
        userId,
        opKey,
        operation,
        disposition,
        error,
        beforeTerminalReconciliation,
        () => finishDeferredDurableCall(opKey)
      );
      return;
    }
    noteSyncFailure();
    // Reset/sign-out/cancellation may have removed this exact pending call
    // while its unabortable request was in flight. Do not resurrect stale work.
    if (deferredDurableCalls.get(opKey) === call) {
      scheduleDeferredDurableRetry(
        opKey,
        fnKey,
        args,
        effect,
        invalidation,
        terminalReconciliation,
        beforeTerminalReconciliation,
        userId
      );
    }
  }
}

type BackgroundDurableCallSpec = {
  args: unknown[];
  effect?: RemoteCallEffect;
  fnKey: keyof typeof DURABLE_REMOTE_CALLS & string;
  onDrop: (error: unknown) => void | Promise<void>;
  onSuccess: (result: unknown | undefined) => void | Promise<void>;
  opKey: string;
  terminalReconciliation?: RemoteCallTerminalReconciliation;
  userId: string;
  waitsFor?: () => boolean;
};

const backgroundDurableCalls = new Map<string, BackgroundDurableCallSpec>();
const backgroundDurableTimers = new Map<string, ReturnType<typeof setTimeout>>();
const backgroundDurableInFlight = new Map<string, Promise<void>>();
const backgroundDurableRetryAttempts = new Map<string, number>();

function scheduleBackgroundDurableCall(opKey: string, delay = PERSIST_RETRY_MS) {
  if (backgroundDurableTimers.has(opKey)) return;
  backgroundDurableTimers.set(
    opKey,
    setTimeout(() => void runBackgroundDurableCall(opKey), delay)
  );
}

function scheduleBackgroundDurableRetry(opKey: string) {
  const attempt = (backgroundDurableRetryAttempts.get(opKey) ?? 0) + 1;
  backgroundDurableRetryAttempts.set(opKey, attempt);
  scheduleBackgroundDurableCall(opKey, persistRetryDelayMs(attempt));
}

function wakeBackgroundDurableCalls() {
  for (const [opKey, spec] of backgroundDurableCalls) {
    if (spec.waitsFor?.()) continue;
    const timer = backgroundDurableTimers.get(opKey);
    if (timer) clearTimeout(timer);
    backgroundDurableTimers.delete(opKey);
    backgroundDurableRetryAttempts.delete(opKey);
    scheduleBackgroundDurableCall(opKey, 0);
  }
}

async function runBackgroundDurableCall(opKey: string) {
  const timer = backgroundDurableTimers.get(opKey);
  if (timer) clearTimeout(timer);
  backgroundDurableTimers.delete(opKey);
  const spec = backgroundDurableCalls.get(opKey);
  if (!spec) return;
  const active = backgroundDurableInFlight.get(opKey);
  if (active) {
    await active.catch(() => {});
    return;
  }
  if (spec.waitsFor?.()) {
    scheduleBackgroundDurableCall(opKey);
    return;
  }
  const entry = DURABLE_REMOTE_CALLS[spec.fnKey];
  const run = (async () => {
    try {
      const result = await entry.fn(...spec.args);
      backgroundDurableCalls.delete(opKey);
      backgroundDurableRetryAttempts.delete(opKey);
      await outboxAck(spec.userId, opKey);
      noteSyncSuccess();
      await spec.onSuccess(result);
    } catch (error) {
      if (shouldDropPersistError(error)) {
        const disposition = durableTerminalDisposition(entry, persistErrorStatus(error));
        if (disposition === "confirmed") {
          await spec.onSuccess(undefined);
          backgroundDurableCalls.delete(opKey);
          backgroundDurableRetryAttempts.delete(opKey);
          await outboxAck(spec.userId, opKey);
          noteSyncSuccess();
        } else {
          if (disposition === "drop") notifyPersistDrop(error);
          const operation: MutationOutboxOp = {
            args: spec.args,
            effect: spec.effect,
            fn: spec.fnKey,
            kind: "remote_call",
            ...(spec.terminalReconciliation
              ? { terminalReconciliation: spec.terminalReconciliation }
              : {}),
          };
          await transitionToTerminalReconciliation(
            spec.userId,
            opKey,
            operation,
            disposition,
            error,
            spec.onDrop,
            () => {
              backgroundDurableCalls.delete(opKey);
              backgroundDurableRetryAttempts.delete(opKey);
            }
          );
        }
        return;
      }
      noteSyncFailure();
      scheduleBackgroundDurableRetry(opKey);
    }
  })().catch(() => {
    // The server outcome is already classified above. A reconciliation
    // callback must not cause the mutation itself to be sent twice.
    noteSyncFailure();
  });
  backgroundDurableInFlight.set(opKey, run);
  try {
    await run;
  } finally {
    if (backgroundDurableInFlight.get(opKey) === run) {
      backgroundDurableInFlight.delete(opKey);
    }
  }
}

function startBackgroundDurableCall(spec: BackgroundDurableCallSpec) {
  const terminalReconciliation = mergeRemoteCallTerminalReconciliation(
    spec.terminalReconciliation,
    inferRemoteCallTerminalReconciliation(spec.fnKey, spec.args, spec.effect)
  );
  const persistedSpec = { ...spec, terminalReconciliation };
  backgroundDurableRetryAttempts.delete(spec.opKey);
  backgroundDurableCalls.set(spec.opKey, persistedSpec);
  outboxSet(spec.userId, spec.opKey, {
    args: spec.args,
    effect: spec.effect,
    fn: spec.fnKey,
    kind: "remote_call",
    ...(terminalReconciliation ? { terminalReconciliation } : {}),
  });
  scheduleBackgroundDurableCall(spec.opKey, 0);
}

function cancelBackgroundDurableCall(opKey: string, userId = outboxUserId()) {
  const timer = backgroundDurableTimers.get(opKey);
  if (timer) clearTimeout(timer);
  backgroundDurableTimers.delete(opKey);
  backgroundDurableCalls.delete(opKey);
  backgroundDurableRetryAttempts.delete(opKey);
  outboxAck(userId, opKey);
}

function persistOptimisticTemplateCreate(template: DbTemplate, reason: string) {
  const dbId = template.databaseId;
  pendingTemplateCreate.set(template.id, dbId);
  startBackgroundDurableCall({
    args: [template as Partial<DbTemplate>],
    fnKey: "createTemplateRemote",
    opKey: `create-template:${template.id}`,
    userId: outboxUserId(),
    waitsFor: () => pendingDatabaseCreate.has(dbId),
    onSuccess: (result) => {
      pendingTemplateCreate.delete(template.id);
      const persisted = result as DbTemplate | undefined;
      if (persisted) {
        useStore.setState((state) => ({
          templatesByDb: {
            ...state.templatesByDb,
            [dbId]: (state.templatesByDb[dbId] ?? []).map((current) =>
              current.id === template.id ? { ...persisted, ...current } : current
            ),
          },
        }));
      }
      publishDatabaseTemplatesMutation(dbId, reason);
      releaseOptimisticCreateDependents(template.id);
    },
    onDrop: () => {
      pendingTemplateCreate.delete(template.id);
      useStore.setState((state) => ({
        templatesByDb: {
          ...state.templatesByDb,
          [dbId]: (state.templatesByDb[dbId] ?? []).filter(
            (item) => item.id !== template.id
          ),
        },
      }));
      cacheCurrentDatabaseMetadata(dbId);
    },
  });
}

function cancelPendingCreatesUnderDatabase(dbId: string) {
  const dependentIds = new Set<string>();
  const cancelMapped = (
    map: Map<string, string>,
    prefix: string,
    matches: (ownerId: string) => boolean = (ownerId) => ownerId === dbId
  ) => {
    for (const [id, ownerId] of map) {
      if (!matches(ownerId)) continue;
      dependentIds.add(id);
      map.delete(id);
      cancelBackgroundDurableCall(`${prefix}:${id}`);
    }
  };
  cancelMapped(pendingDatabaseRowCreate, "create-row");
  cancelMapped(pendingPropertyCreate, "create-property");
  cancelMapped(pendingViewCreate, "create-view");
  cancelMapped(pendingTemplateCreate, "create-template");
  cancelMapped(
    pendingCommentCreate,
    "create-comment",
    (ownerId) => ownerId === dbId || dependentIds.has(ownerId)
  );
  for (const [id, entry] of Array.from(pendingPageCreate.entries())) {
    if (entry.page.parentId !== dbId) continue;
    dependentIds.add(id);
    rollbackPendingPageCreate(id, entry.originHref);
  }
  for (const id of dependentIds) rollbackDependentWritesForFailedCreate(id);
  return dependentIds;
}

function jsonValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : cloneJson(value);
}

function rollbackMatchingFields<T extends object>(
  current: T,
  optimistic: T,
  before: T,
  fields: Iterable<keyof T>
): T {
  const next = { ...current } as T;
  const nextRecord = next as Record<PropertyKey, unknown>;
  const currentRecord = current as Record<PropertyKey, unknown>;
  const optimisticRecord = optimistic as Record<PropertyKey, unknown>;
  const beforeRecord = before as Record<PropertyKey, unknown>;
  for (const field of fields) {
    if (!jsonValuesEqual(currentRecord[field], optimisticRecord[field])) continue;
    if (Object.prototype.hasOwnProperty.call(before, field)) {
      nextRecord[field] = cloneJsonValue(beforeRecord[field]);
    } else {
      delete nextRecord[field];
    }
  }
  return next;
}

function rollbackTerminalPageMutation(
  id: string,
  patch: Partial<Page>,
  before: Page | undefined
) {
  optimisticPageOverlays.delete(id);
  if (!before) return;
  useStore.setState((state) => {
    const current = state.pagesById[id];
    if (!current) return {};
    const patchFields = Object.keys(patch).filter(
      (field) => field !== "properties"
    ) as Array<keyof Page>;
    if (Object.prototype.hasOwnProperty.call(patch, "properties")) {
      patchFields.push("__computed");
    }
    const optimistic = {
      ...before,
      ...patch,
      ...(Object.prototype.hasOwnProperty.call(patch, "properties")
        ? { __computed: undefined }
        : {}),
    };
    const next = rollbackMatchingFields(current, optimistic, before, patchFields);

    if (patch.properties && typeof patch.properties === "object") {
      const currentProperties = current.properties ?? {};
      const beforeProperties = before.properties ?? {};
      const optimisticProperties = patch.properties;
      const nextProperties = { ...currentProperties };
      const propertyIds = new Set([
        ...Object.keys(beforeProperties),
        ...Object.keys(optimisticProperties),
      ]);
      for (const propertyId of propertyIds) {
        const currentHas = Object.prototype.hasOwnProperty.call(
          currentProperties,
          propertyId
        );
        const optimisticHas = Object.prototype.hasOwnProperty.call(
          optimisticProperties,
          propertyId
        );
        if (currentHas !== optimisticHas) continue;
        if (
          currentHas &&
          !jsonValuesEqual(currentProperties[propertyId], optimisticProperties[propertyId])
        ) {
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(beforeProperties, propertyId)) {
          nextProperties[propertyId] = cloneJsonValue(beforeProperties[propertyId]);
        } else {
          delete nextProperties[propertyId];
        }
      }
      next.properties = nextProperties;
    }

    return {
      pagesById: {
        ...state.pagesById,
        [id]: next,
      },
    };
  });
}

/**
 * Roll back one optimistic database-row property without replacing the rest
 * of the row or a newer pending patch. The compare guards are important for
 * menu actions that stay open long enough for another cell edit to happen
 * while the durable request is in flight.
 */
function rollbackOptimisticRowProperty(
  rowId: string,
  propertyId: string,
  optimisticValue: unknown,
  previousProperties: Record<string, unknown>
) {
  const hadPrevious = Object.prototype.hasOwnProperty.call(previousProperties, propertyId);
  const previousValue = previousProperties[propertyId];
  useStore.setState((state) => {
    const current = state.pagesById[rowId];
    if (!current || !jsonValuesEqual(current.properties?.[propertyId], optimisticValue)) return {};
    const properties = { ...(current.properties ?? {}) };
    if (hadPrevious) properties[propertyId] = cloneJsonValue(previousValue);
    else delete properties[propertyId];
    return {
      pagesById: {
        ...state.pagesById,
        [rowId]: { ...current, properties },
      },
    };
  });

  const pending = pendingPage.get(rowId);
  const pendingProperties = recordValue(pending?.properties);
  if (!pending || !pendingProperties) return;
  if (!jsonValuesEqual(pendingProperties[propertyId], optimisticValue)) return;
  const properties = { ...pendingProperties };
  if (hadPrevious) properties[propertyId] = cloneJsonValue(previousValue);
  else delete properties[propertyId];
  pendingPage.set(rowId, { ...pending, properties });
  mirrorPendingPage(rowId);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rowFileStorageKey(value: unknown) {
  const file = recordValue(value);
  if (!file) return "";
  for (const candidate of [file.key, file.id]) {
    if (typeof candidate === "string" && candidate.startsWith("workspaces/")) return candidate;
  }
  return typeof file.url === "string" ? storageKeyFromUrl(file.url) : "";
}

function rowFileIdentity(value: unknown) {
  const file = recordValue(value);
  if (!file) return JSON.stringify(value);
  for (const candidate of [file.id, file.key, file.url]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return JSON.stringify(value);
}

function rowFileValueContainsKey(value: unknown, key: string) {
  return Array.isArray(value) && value.some((item) => rowFileStorageKey(item) === key);
}

function rebaseRowFileRemovalEffect(effect: RowFileRemovalEffect): RowFileRemovalEffect {
  const key = rowFileRemovalRunKey(effect);
  const baseline = rowFileRemovalCommittedValues.has(key)
    ? rowFileRemovalCommittedValues.get(key)
    : effect.previousValue;
  const previous = Array.isArray(baseline) ? baseline.slice() : [];
  const current = useStore.getState().pagesById[effect.rowId]?.properties?.[effect.propertyId];
  const identities = new Set(previous.map(rowFileIdentity));

  // Include additions made while earlier effects occupied the lane, but do not
  // infer removals from the optimistic current value: later queued operations
  // own those removals and will apply them in order.
  if (Array.isArray(current)) {
    for (const item of current) {
      const identity = rowFileIdentity(item);
      if (identities.has(identity)) continue;
      identities.add(identity);
      previous.push(item);
    }
  }

  const removedIdentity = rowFileIdentity(effect.removedItem);
  const removedIndex = previous.findIndex(
    (item) => rowFileIdentity(item) === removedIdentity
  );
  const next = previous.filter((item) => rowFileIdentity(item) !== removedIdentity);
  return {
    ...effect,
    nextValue: next.length ? next : null,
    previousValue: previous.length ? previous : null,
    removedIndex: removedIndex >= 0 ? removedIndex : effect.removedIndex,
  };
}

function supersedePendingRowFileValue(effect: RowFileRemovalEffect) {
  const pending = pendingPage.get(effect.rowId);
  if (!pending) return;
  const properties = recordValue(pending.properties);
  if (!properties || !Object.prototype.hasOwnProperty.call(properties, effect.propertyId)) return;
  pendingPage.set(effect.rowId, {
    ...pending,
    properties: { ...properties, [effect.propertyId]: effect.nextValue },
  });
  mirrorPendingPage(effect.rowId);
}

function applyRowFileRemovalIntent(effect: RowFileRemovalEffect) {
  const removedIdentity = rowFileIdentity(effect.removedItem);
  useStore.setState((state) => {
    const current = state.pagesById[effect.rowId];
    const currentValue = current?.properties?.[effect.propertyId];
    if (!current || !Array.isArray(currentValue)) return {};
    const next = currentValue.filter((item) => rowFileIdentity(item) !== removedIdentity);
    if (next.length === currentValue.length) return {};
    return {
      pagesById: {
        ...state.pagesById,
        [effect.rowId]: {
          ...current,
          properties: {
            ...(current.properties ?? {}),
            [effect.propertyId]: next.length ? next : null,
          },
        },
      },
    };
  });
  projectOptimisticRowFileValue(
    effect.rowId,
    effect.propertyId,
    effect.nextValue
  );
}

function projectOptimisticRowFileValue(
  rowId: string,
  propertyId: string,
  value: unknown
) {
  const page = useStore.getState().pagesById[rowId];
  if (!page) return;
  optimisticPageOverlays.set(rowId, {
    ...(optimisticPageOverlays.get(rowId) ?? {}),
    properties: {
      ...(page.properties ?? {}),
      [propertyId]: value,
    },
  });
}

function projectOptimisticDatabaseSubitem(
  rowId: string,
  targetParentId: string,
  mutationId: string
) {
  optimisticPageOverlays.set(rowId, {
    ...(optimisticPageOverlays.get(rowId) ?? {}),
    lastMutationId: mutationId,
    subitemParentId: targetParentId,
  });
}

function clearOptimisticDatabaseSubitem(
  rowId: string,
  targetParentId: string,
  mutationId: string
) {
  const current = optimisticPageOverlays.get(rowId);
  if (
    !current
    || current.subitemParentId !== targetParentId
    || current.lastMutationId !== mutationId
  ) return;
  const {
    lastMutationId: _lastMutationId,
    subitemParentId: _subitemParentId,
    ...remaining
  } = current;
  if (Object.keys(remaining).length > 0) optimisticPageOverlays.set(rowId, remaining);
  else optimisticPageOverlays.delete(rowId);
}

function rollbackRowFileValue(effect: RowFileRemovalEffect, currentValue: unknown) {
  if (jsonValuesEqual(currentValue, effect.nextValue)) return effect.previousValue;
  if (currentValue !== null && currentValue !== undefined && !Array.isArray(currentValue)) {
    return effect.previousValue;
  }
  const current = Array.isArray(currentValue) ? currentValue : [];
  const removedIdentity = rowFileIdentity(effect.removedItem);
  if (current.some((item) => rowFileIdentity(item) === removedIdentity)) return currentValue;
  const next = current.slice();
  next.splice(Math.max(0, Math.min(effect.removedIndex, next.length)), 0, effect.removedItem);
  return next;
}

function mergeAuthoritativeRowFileValue(
  effect: RowFileRemovalEffect,
  authoritativeValue: unknown,
  currentValue: unknown
) {
  if (jsonValuesEqual(currentValue, effect.nextValue)) return authoritativeValue;
  const supported = (value: unknown) =>
    value === null || value === undefined || Array.isArray(value);
  if (!supported(authoritativeValue) || !supported(currentValue) || !supported(effect.nextValue)) {
    return rollbackRowFileValue(effect, currentValue);
  }

  // Overlay edits made after this effect's optimistic snapshot onto the fresh
  // server value. This preserves both later additions and later removals (for
  // example, A fails while a queued B removal is already represented by an
  // empty current value).
  const baseline = Array.isArray(effect.nextValue) ? effect.nextValue : [];
  const current = Array.isArray(currentValue) ? currentValue : [];
  const currentByIdentity = new Map(current.map((item) => [rowFileIdentity(item), item]));
  const baselineIdentities = new Set(baseline.map(rowFileIdentity));
  const concurrentlyRemoved = new Set(
    baseline
      .map(rowFileIdentity)
      .filter((identity) => !currentByIdentity.has(identity))
  );
  const merged = (Array.isArray(authoritativeValue) ? authoritativeValue : [])
    .filter((item) => !concurrentlyRemoved.has(rowFileIdentity(item)))
    .map((item) => currentByIdentity.get(rowFileIdentity(item)) ?? item);
  const identities = new Set(merged.map(rowFileIdentity));
  for (const item of current) {
    const identity = rowFileIdentity(item);
    if (identities.has(identity)) continue;
    // Current items missing from the baseline are post-effect additions. Items
    // that were already in the baseline but are absent from the authoritative
    // value were removed by the server and must not be resurrected here.
    if (baselineIdentities.has(identity)) continue;
    identities.add(identity);
    merged.push(item);
  }
  return merged.length ? merged : null;
}

function preserveNewerPendingRowFileValue(effect: RowFileRemovalEffect, value: unknown) {
  const pending = pendingPage.get(effect.rowId);
  const hasInFlight = pageFlushes.has(effect.rowId);
  if (!pending && !hasInFlight) return;
  const current = useStore.getState().pagesById[effect.rowId];
  if (!current) return;
  const pendingProperties = recordValue(pending?.properties) ?? current.properties ?? {};
  pendingPage.set(effect.rowId, {
    ...(pending ?? {}),
    properties: { ...pendingProperties, [effect.propertyId]: value },
    updatedAt: nowIso(),
  });
  mirrorPendingPage(effect.rowId);
  if (hasInFlight) void flushPage(effect.rowId);
}

function remotePageResult(result: unknown): Page | null {
  const record = recordValue(result);
  return record && typeof record.id === "string" ? (record as unknown as Page) : null;
}

function databaseCreateRowsQueryKey(effect: DatabaseCreateEffect) {
  const viewId = effect.views[0]?.id;
  if (!viewId) return undefined;
  return databaseRowsQueryKey({
    viewId,
    ...(effect.page.parentType === "page" && effect.page.parentId
      ? { currentPageId: effect.page.parentId }
      : {}),
  });
}

function mergeOptimisticRecords<T extends { id: string }>(snapshot: T[], current: T[]) {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const snapshotIds = new Set(snapshot.map((item) => item.id));
  return [
    ...snapshot.map((item) => ({ ...item, ...(currentById.get(item.id) ?? {}) })),
    ...current.filter((item) => !snapshotIds.has(item.id)),
  ];
}

/** Rebuild a queued atomic database create before exposing a booted route. */
function materializeDatabaseCreateEffect(effect: DatabaseCreateEffect) {
  const id = effect.databaseId;
  pendingDatabaseCreate.set(id, effect.page.parentId ?? "");
  useStore.setState((state) => {
    const rows = mergeOptimisticRecords(
      effect.rows,
      (state.databaseRowIdsByDb[id] ?? [])
        .map((rowId) => state.pagesById[rowId])
        .filter((row): row is Page => !!row)
    ).sort(bySortPos);
    const currentRowPage = state.databaseRowPagesByDb[id];
    return {
      pagesById: {
        ...state.pagesById,
        [id]: { ...effect.page, ...(state.pagesById[id] ?? {}) },
        ...Object.fromEntries(rows.map((row) => [row.id, row])),
      },
      pageRolesById: { ...state.pageRolesById, [id]: state.pageRolesById[id] ?? "edit" },
      propsByDb: {
        ...state.propsByDb,
        [id]: mergeOptimisticRecords(effect.properties, state.propsByDb[id] ?? []).sort(bySortPos),
      },
      viewsByDb: {
        ...state.viewsByDb,
        [id]: mergeOptimisticRecords(effect.views, state.viewsByDb[id] ?? []).sort(bySortPos),
      },
      templatesByDb: {
        ...state.templatesByDb,
        [id]: mergeOptimisticRecords(effect.templates, state.templatesByDb[id] ?? []).sort(bySortPos),
      },
      databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [id]: rows.map((row) => row.id) },
      databaseRowPagesByDb: {
        ...state.databaseRowPagesByDb,
        [id]: currentRowPage ?? {
          queryKey: databaseCreateRowsQueryKey(effect),
          loadedCount: rows.length,
          totalCount: rows.length,
          hasMore: false,
          loading: false,
          loadingMore: false,
        },
      },
      loadedDbs: new Set(state.loadedDbs).add(id),
    };
  });
}

function finishOptimisticDatabaseCreate(
  effect: DatabaseCreateEffect,
  rawResult: unknown | undefined
) {
  const id = effect.databaseId;
  pendingDatabaseCreate.delete(id);
  const result = rawResult as Awaited<ReturnType<typeof createDatabaseRemote>> | undefined;
  if (result) {
    useStore.setState((state) => {
      const currentPage = state.pagesById[id];
      const rows = (result.rows ?? []).slice().sort(bySortPos);
      const currentRowPage = state.databaseRowPagesByDb[id];
      return {
        pagesById: {
          ...state.pagesById,
          [id]: currentPage
            ? mergePersistedPageCreateAuthority(result.page, currentPage)
            : result.page,
          ...Object.fromEntries(rows.map((row) => [row.id, row])),
        },
        propsByDb: {
          ...state.propsByDb,
          [id]: mergeOptimisticRecords(result.properties ?? [], state.propsByDb[id] ?? []).sort(bySortPos),
        },
        viewsByDb: {
          ...state.viewsByDb,
          [id]: mergeOptimisticRecords(result.views ?? [], state.viewsByDb[id] ?? []).sort(bySortPos),
        },
        templatesByDb: {
          ...state.templatesByDb,
          [id]: mergeOptimisticRecords(result.templates ?? [], state.templatesByDb[id] ?? []).sort(bySortPos),
        },
        databaseRowIdsByDb: {
          ...state.databaseRowIdsByDb,
          [id]: rows.map((row) => row.id),
        },
        databaseRowPagesByDb: {
          ...state.databaseRowPagesByDb,
          [id]: {
            queryKey: currentRowPage?.queryKey ?? databaseCreateRowsQueryKey(effect),
            loadedCount: rows.length,
            totalCount: rows.length,
            hasMore: false,
            loading: false,
            loadingMore: false,
          },
        },
        loadedDbs: new Set(state.loadedDbs).add(id),
      };
    });
    adoptPersistedPageCreateAuthority(id, result.page);
  } else {
    void useStore.getState().loadDatabase(id, { force: true, rows: true });
  }
  releaseOptimisticCreateDependents(id);
}

function rollbackOptimisticDatabaseCreate(effect: DatabaseCreateEffect) {
  const id = effect.databaseId;
  pendingDatabaseCreate.delete(id);
  const dependentIds = cancelPendingCreatesUnderDatabase(id);
  rollbackDependentWritesForFailedCreate(id);
  useStore.setState((state) => {
    const failedPageIds = new Set([id, ...dependentIds]);
    let foundChild = true;
    while (foundChild) {
      foundChild = false;
      for (const page of Object.values(state.pagesById)) {
        if (failedPageIds.has(page.id) || !page.parentId || !failedPageIds.has(page.parentId)) {
          continue;
        }
        failedPageIds.add(page.id);
        foundChild = true;
      }
    }
    const pagesById = { ...state.pagesById };
    const pageRolesById = { ...state.pageRolesById };
    const blocksByPage = { ...state.blocksByPage };
    const blockHistoryByPage = { ...state.blockHistoryByPage };
    const commentsByPage = { ...state.commentsByPage };
    const propsByDb = { ...state.propsByDb };
    const viewsByDb = { ...state.viewsByDb };
    const templatesByDb = { ...state.templatesByDb };
    const databaseRowIdsByDb = { ...state.databaseRowIdsByDb };
    const databaseRowPagesByDb = { ...state.databaseRowPagesByDb };
    const loadedBlockPages = new Set(state.loadedBlockPages);
    const loadedCommentPages = new Set(state.loadedCommentPages);
    for (const pageId of failedPageIds) {
      delete pagesById[pageId];
      delete pageRolesById[pageId];
      delete blocksByPage[pageId];
      delete blockHistoryByPage[pageId];
      delete commentsByPage[pageId];
      loadedBlockPages.delete(pageId);
      loadedCommentPages.delete(pageId);
    }
    for (const [pageId, blocks] of Object.entries(blocksByPage)) {
      blocksByPage[pageId] = blocks.filter(
        (block) => !Array.from(failedPageIds).some((failedId) => valueReferencesId(block, failedId))
      );
    }
    delete propsByDb[id];
    delete viewsByDb[id];
    delete templatesByDb[id];
    delete databaseRowIdsByDb[id];
    delete databaseRowPagesByDb[id];
    const loadedDbs = new Set(state.loadedDbs);
    loadedDbs.delete(id);
    return {
      pagesById,
      pageRolesById,
      blocksByPage,
      blockHistoryByPage,
      commentsByPage,
      propsByDb,
      viewsByDb,
      templatesByDb,
      databaseRowIdsByDb,
      databaseRowPagesByDb,
      databaseSubitemRowWindowsByDb: pruneDatabaseSubitemRowWindows(
        state.databaseSubitemRowWindowsByDb,
        failedPageIds
      ),
      databaseDependencyRelations: pruneDatabaseDependencyRelations(
        state.databaseDependencyRelations,
        failedPageIds
      ),
      loadedBlockPages,
      loadedCommentPages,
      loadedDbs,
      recentPageIds: state.recentPageIds.filter((pageId) => !failedPageIds.has(pageId)),
      ...(state.focusPageId && failedPageIds.has(state.focusPageId)
        ? { focusPageId: undefined, focusPageTarget: undefined }
        : {}),
    };
  });
  if (typeof window === "undefined") return;
  const route = routeInfoFromPath(window.location.pathname);
  if (
    (route.kind === "page" && route.pageId === id) ||
    (route.kind === "database" && route.databaseId === id)
  ) {
    replaceRoute(effect.originHref);
  }
}

function taskFeatureCommitAuthority(
  effect: Extract<RemoteCallEffect, { kind: "database_task_feature_commit" }>,
  result: unknown
) {
  const response = recordValue(result);
  const database = recordValue(response?.database) as Page | null;
  const properties = Array.isArray(response?.properties)
    ? response.properties.filter((value): value is DbProperty => !!recordValue(value))
    : [];
  const binding = database?.databaseFeatures?.[effect.feature];
  const remoteRevision = Number(database?.databaseFeaturesRevision ?? 0);
  const bindingRevision = Number(binding?.revision ?? 0);
  const expectedIds = [effect.primaryPropertyId, effect.secondaryPropertyId];
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const primary = propertiesById.get(effect.primaryPropertyId);
  const secondary = propertiesById.get(effect.secondaryPropertyId);
  const primaryConfig = recordValue(primary?.config);
  const secondaryConfig = recordValue(secondary?.config);
  const expectedRoles = effect.feature === "subitems"
    ? ["subitem_parent", "subitem_children"]
    : ["dependency_predecessor", "dependency_successor"];
  const dependencyBinding = database?.databaseFeatures?.dependencies;
  const subitemsBinding = database?.databaseFeatures?.subitems;
  const dependencyDateBindingMatches = effect.dateMode === "separate"
    ? dependencyBinding?.dateMode === "separate"
      && dependencyBinding.startDatePropertyId === effect.startDatePropertyId
      && dependencyBinding.endDatePropertyId === effect.endDatePropertyId
    : dependencyBinding?.dateMode !== "separate"
      && dependencyBinding?.datePropertyId === effect.datePropertyId;
  const bindingMatches = effect.feature === "subitems"
    ? subitemsBinding?.parentPropertyId === effect.primaryPropertyId
      && subitemsBinding.childrenPropertyId === effect.secondaryPropertyId
      && subitemsBinding.nestedPropertyId === (effect.nestedPropertyId ?? effect.secondaryPropertyId)
      && subitemsBinding.showToggleOnTitle === (effect.showToggleOnTitle ?? true)
    : dependencyBinding?.predecessorPropertyId === effect.primaryPropertyId
      && dependencyBinding.successorPropertyId === effect.secondaryPropertyId
      && dependencyDateBindingMatches
      && dependencyBinding.shiftMode === effect.shiftMode
      && dependencyBinding.avoidWeekends === effect.avoidWeekends;
  const exactProperty = (
    property: DbProperty | undefined,
    config: Record<string, unknown> | null,
    id: string,
    relatedId: string,
    role: string
  ) => property?.id === id
    && property.databaseId === effect.databaseId
    && property.type === "relation"
    && config?.relationDatabaseId === effect.databaseId
    && config?.relatedPropertyId === relatedId
    && config?.databaseFeatureRole === role;

  if (
    database?.id !== effect.databaseId
    || database.kind !== "database"
    || properties.length !== 2
    || new Set(properties.map((property) => property.id)).size !== 2
    || !expectedIds.every((id) => propertiesById.has(id))
    || binding?.enabled !== true
    || !bindingMatches
    || !Number.isSafeInteger(remoteRevision)
    || remoteRevision < 1
    || !Number.isSafeInteger(bindingRevision)
    || bindingRevision < 1
    || !exactProperty(
      primary,
      primaryConfig,
      effect.primaryPropertyId,
      effect.secondaryPropertyId,
      expectedRoles[0]!
    )
    || !exactProperty(
      secondary,
      secondaryConfig,
      effect.secondaryPropertyId,
      effect.primaryPropertyId,
      expectedRoles[1]!
    )
  ) {
    throw new Error("Database task-feature response authority is malformed.");
  }
  return { database, properties: [primary!, secondary!], remoteRevision };
}

function taskFeatureTurnOffAuthority(
  effect: Extract<RemoteCallEffect, { kind: "database_task_feature_turn_off" }>,
  result: unknown
) {
  const response = recordValue(result);
  const database = recordValue(response?.database) as Page | null;
  const properties = Array.isArray(response?.properties)
    ? response.properties.filter((value): value is DbProperty => !!recordValue(value))
    : [];
  const removedPropertyIds = Array.isArray(response?.removedPropertyIds)
    ? response.removedPropertyIds.filter((value): value is string => typeof value === "string")
    : [];
  const remoteRevision = Number(database?.databaseFeaturesRevision ?? 0);
  const expectedIds = [effect.primaryPropertyId, effect.secondaryPropertyId];
  const expectedRemovedIds = effect.propertyDisposition === "remove" ? expectedIds : [];
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const primary = propertiesById.get(effect.primaryPropertyId);
  const secondary = propertiesById.get(effect.secondaryPropertyId);
  const primaryConfig = recordValue(primary?.config);
  const secondaryConfig = recordValue(secondary?.config);
  const expectedRoles = effect.feature === "subitems"
    ? ["preserved_subitem_parent", "preserved_subitem_children"]
    : ["preserved_dependency_predecessor", "preserved_dependency_successor"];
  const preservedBindings = database?.databaseFeatures?.preservedTaskFeatures?.[effect.feature] ?? [];
  const preservedBindingMatches = preservedBindings.some((binding) => {
    if (binding.enabled !== false || binding.revision !== effect.expectedBindingRevision) return false;
    return effect.feature === "subitems"
      ? "parentPropertyId" in binding
        && binding.parentPropertyId === effect.primaryPropertyId
        && binding.childrenPropertyId === effect.secondaryPropertyId
      : "predecessorPropertyId" in binding
        && binding.predecessorPropertyId === effect.primaryPropertyId
        && binding.successorPropertyId === effect.secondaryPropertyId;
  });
  const exactProperty = (
    property: DbProperty | undefined,
    config: Record<string, unknown> | null,
    id: string,
    relatedId: string,
    role: string
  ) => property?.id === id
    && property.databaseId === effect.databaseId
    && property.type === "relation"
    && config?.relationDatabaseId === effect.databaseId
    && config?.relatedPropertyId === relatedId
    && config?.databaseFeatureRole === role;
  const exactRemovedIds = removedPropertyIds.length === expectedRemovedIds.length
    && removedPropertyIds.every((id, index) => id === expectedRemovedIds[index]);
  const propertyAuthorityMatches = effect.propertyDisposition === "keep"
    ? properties.length === 2
      && propertiesById.size === 2
      && preservedBindingMatches
      && exactProperty(
        primary,
        primaryConfig,
        effect.primaryPropertyId,
        effect.secondaryPropertyId,
        expectedRoles[0]!
      )
      && exactProperty(
        secondary,
        secondaryConfig,
        effect.secondaryPropertyId,
        effect.primaryPropertyId,
        expectedRoles[1]!
      )
    : properties.length === 0;

  if (
    response?.operationId !== effect.operationId
    || response?.status !== "completed"
    || typeof response?.replayed !== "boolean"
    || database?.id !== effect.databaseId
    || database.kind !== "database"
    || database.databaseFeatures?.[effect.feature] !== undefined
    || remoteRevision !== effect.expectedDatabaseFeaturesRevision + 1
    || !exactRemovedIds
    || !propertyAuthorityMatches
  ) {
    throw new Error("Database task-feature turn-off response authority is malformed.");
  }
  return { database, properties, remoteRevision };
}

async function applyRemoteCallEffectSuccess(effect: RemoteCallEffect, result: unknown) {
  if (effect.kind === "database_create") {
    finishOptimisticDatabaseCreate(effect, result);
    return;
  }
  if (effect.kind === "database_metadata_reconcile") return;
  if (effect.kind === "database_dependency_commit") {
    const response = recordValue(result);
    const relation = recordValue(response?.relation);
    const relatedRowIds = Array.isArray(relation?.relatedRowIds)
      ? relation.relatedRowIds.filter((value): value is string => typeof value === "string")
      : [];
    const dependencyRevision = Number(relation?.dependencyRevision ?? 0);
    const nextCursor = typeof relation?.nextCursor === "string"
      ? relation.nextCursor.trim()
      : undefined;
    if (
      response?.mutationId !== effect.mutationId
      || relation?.databaseId !== effect.databaseId
      || relation.rowId !== effect.rowId
      || relation.propertyId !== effect.propertyId
      || relation.direction !== effect.direction
      || !Array.isArray(relation.relatedRowIds)
      || relatedRowIds.length !== relation.relatedRowIds.length
      || new Set(relatedRowIds).size !== relatedRowIds.length
      || relatedRowIds.length > 50
      || relatedRowIds.some((id) => !id || id.trim() !== id || id.length > 256)
      || typeof relation.hasMore !== "boolean"
      || !Number.isSafeInteger(dependencyRevision)
      || dependencyRevision < 1
      || (relation.hasMore === true && !nextCursor)
      || (relation.hasMore === false && relation.nextCursor !== undefined)
    ) {
      throw new Error("Database dependency relation response authority is malformed.");
    }
    mergeDatabaseDependencyRelationAuthority({
      databaseId: effect.databaseId,
      dependencyRevision,
      direction: effect.direction,
      hasMore: relation.hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      propertyId: effect.propertyId,
      relatedRowIds,
      rowId: effect.rowId,
    }, { settledMutationId: effect.mutationId });
    publishDatabaseRowsMutation(
      effect.databaseId,
      "dependency_relation_changed",
      [effect.rowId, ...effect.addRelatedRowIds, ...effect.removeRelatedRowIds],
    );
    return;
  }
  if (effect.kind === "database_task_feature_commit") {
    const authority = taskFeatureCommitAuthority(effect, result);
    useStore.setState((state) => {
      const currentDatabase = state.pagesById[effect.databaseId];
      const currentRevision = Number(currentDatabase?.databaseFeaturesRevision ?? 0);
      const incomingById = new Map(authority.properties.map((property) => [property.id, property]));
      const currentProperties = state.propsByDb[effect.databaseId] ?? [];
      const mergedProperties = currentProperties.map((property) => {
        const incoming = incomingById.get(property.id);
        if (!incoming) return property;
        incomingById.delete(property.id);
        return (property.updatedAt ?? "") > (incoming.updatedAt ?? "") ? property : incoming;
      });
      mergedProperties.push(...incomingById.values());
      return {
        pagesById: {
          ...state.pagesById,
          [effect.databaseId]: currentDatabase && currentRevision > authority.remoteRevision
            ? currentDatabase
            : { ...(currentDatabase ?? {}), ...authority.database },
        },
        propsByDb: {
          ...state.propsByDb,
          [effect.databaseId]: mergedProperties.sort(bySortPos),
        },
      };
    });
    await reconcilePersistedPageMutations(
      effect.databaseId,
      useStore.getState().pagesById[effect.databaseId]
    );
    publishDatabaseSchemaMutation(
      effect.databaseId,
      "task_feature_configured",
      [effect.primaryPropertyId, effect.secondaryPropertyId]
    );
    return;
  }
  if (effect.kind === "database_task_feature_turn_off") {
    const authority = taskFeatureTurnOffAuthority(effect, result);
    useStore.setState((state) => {
      const removedIds = effect.propertyDisposition === "remove"
        ? new Set([effect.primaryPropertyId, effect.secondaryPropertyId])
        : new Set<string>();
      let metadataState = state;
      for (const propertyId of removedIds) {
        metadataState = {
          ...metadataState,
          ...withoutLoadedDatabaseProperty(metadataState, effect.databaseId, propertyId),
        };
      }
      const currentDatabase = metadataState.pagesById[effect.databaseId];
      const currentRevision = Number(currentDatabase?.databaseFeaturesRevision ?? 0);
      const incomingById = new Map(authority.properties.map((property) => [property.id, property]));
      const currentProperties = metadataState.propsByDb[effect.databaseId] ?? [];
      const mergedProperties = currentProperties.map((property) => {
        const incoming = incomingById.get(property.id);
        if (!incoming) return property;
        incomingById.delete(property.id);
        return incoming;
      });
      mergedProperties.push(...incomingById.values());
      return {
        databaseDependencyRelations: removedIds.size > 0
          ? pruneDatabaseDependencyRelations(metadataState.databaseDependencyRelations, removedIds)
          : metadataState.databaseDependencyRelations,
        pagesById: {
          ...metadataState.pagesById,
          [effect.databaseId]: currentDatabase && currentRevision > authority.remoteRevision
            ? currentDatabase
            : { ...(currentDatabase ?? {}), ...authority.database },
        },
        propsByDb: {
          ...metadataState.propsByDb,
          [effect.databaseId]: mergedProperties.sort(bySortPos),
        },
        templatesByDb: metadataState.templatesByDb,
        viewsByDb: metadataState.viewsByDb,
      };
    });
    await reconcilePersistedPageMutations(
      effect.databaseId,
      useStore.getState().pagesById[effect.databaseId]
    );
    publishDatabaseSchemaMutation(
      effect.databaseId,
      "task_feature_configured",
      [effect.primaryPropertyId, effect.secondaryPropertyId]
    );
    return;
  }
  if (effect.kind === "database_rows_reconcile") {
    const response = recordValue(result);
    const remoteDatabase = response?.database as Page | undefined;
    const remoteRow = response?.row as Page | undefined;
    const completedMutationId = response?.completedMutationId;
    const completedTargetParentId = response?.completedTargetParentId;
    const completedRevision = Number(response?.databaseFeaturesRevision ?? 0);
    const remoteDatabaseRevision = Number(remoteDatabase?.databaseFeaturesRevision ?? 0);
    if (
      remoteDatabase?.id !== effect.databaseId
      || remoteRow?.id !== effect.rowId
      || remoteRow.parentId !== effect.databaseId
      || remoteRow.parentType !== "database"
      || completedMutationId !== effect.mutationId
      || completedTargetParentId !== effect.targetParentId
      || !Number.isSafeInteger(completedRevision)
      || completedRevision < 1
      || !Number.isSafeInteger(remoteDatabaseRevision)
      || remoteDatabaseRevision < completedRevision
    ) {
      throw new Error("Sub-item reparent response authority is malformed.");
    }
    const state = useStore.getState();
    const currentDatabaseRevision = Number(
      state.pagesById[effect.databaseId]?.databaseFeaturesRevision ?? 0
    );
    const currentRowMutationId = state.pagesById[effect.rowId]?.lastMutationId;
    const staleSameRowResponse =
      !!currentRowMutationId
      && currentRowMutationId !== effect.mutationId
      && completedRevision < currentDatabaseRevision;
    clearOptimisticDatabaseSubitem(
      effect.rowId,
      effect.targetParentId,
      effect.mutationId
    );
    clearRecentDatabaseRowsQueries(effect.databaseId);
    if (staleSameRowResponse) return;
    await reconcilePersistedPageMutations(
      effect.rowId,
      remoteRow,
      remoteDatabaseRevision >= currentDatabaseRevision ? [remoteDatabase] : []
    );
    publishDatabaseRowsMutation(effect.databaseId, "subitem_reparented", [effect.rowId]);
    return;
  }
  const remote = remotePageResult(result);
  if (remote) {
    useStore.setState((state) => {
      const current = state.pagesById[effect.rowId];
      if (!current) return {};
      const currentValue = current.properties?.[effect.propertyId];
      const hasNewerValue =
        !jsonValuesEqual(currentValue, effect.nextValue) &&
        !jsonValuesEqual(currentValue, effect.previousValue);
      return {
        pagesById: {
          ...state.pagesById,
          [effect.rowId]: hasNewerValue
            ? {
                ...current,
                ...remote,
                properties: {
                  ...(remote.properties ?? {}),
                  ...(current.properties ?? {}),
                  [effect.propertyId]: currentValue,
                },
              }
            : { ...current, ...remote },
        },
      };
    });
  }
  const page = useStore.getState().pagesById[effect.rowId];
  const committedValue = remote
    ? (remote.properties?.[effect.propertyId] ?? null)
    : effect.nextValue;
  // This direct durable effect bypasses the ordinary pending-page flush, so it
  // must explicitly advance every already-warm row cache before its outbox
  // entry is acknowledged. Otherwise a reload can briefly hydrate the removed
  // file and start a doomed signed-URL request before the server row arrives.
  await reconcilePersistedPageMutations(effect.rowId, remote ?? undefined);
  publishPersistedPageMutation(
    effect.rowId,
    {
      properties: { [effect.propertyId]: effect.nextValue },
      updatedAt: remote?.updatedAt ?? nowIso(),
    },
    page
  );
  if (
    effect.cacheKey &&
    !rowFileValueContainsKey(committedValue, effect.cacheKey) &&
    !rowFileValueContainsKey(page?.properties?.[effect.propertyId], effect.cacheKey)
  ) {
    evictSignedWorkspaceFileUrl(effect.cacheKey);
    await evictCachedWorkspaceFiles([effect.cacheKey]).catch(() => {});
  }
}

function hideUnavailableDatabaseRow(effect: RowFileRemovalEffect, status: number | undefined) {
  cancelPendingPage(effect.rowId);
  const userId = outboxUserId();
  useStore.setState((state) => {
    if (!state.pagesById[effect.rowId]) return {};
    const pagesById = { ...state.pagesById };
    const pageRolesById = { ...state.pageRolesById };
    const blocksByPage = { ...state.blocksByPage };
    const commentsByPage = { ...state.commentsByPage };
    delete pagesById[effect.rowId];
    delete pageRolesById[effect.rowId];
    delete blocksByPage[effect.rowId];
    delete commentsByPage[effect.rowId];
    const rowIds = state.databaseRowIdsByDb[effect.databaseId] ?? [];
    const nextRowIds = rowIds.filter((rowId) => rowId !== effect.rowId);
    const pageState = state.databaseRowPagesByDb[effect.databaseId];
    const loadedBlockPages = new Set(state.loadedBlockPages);
    const loadedCommentPages = new Set(state.loadedCommentPages);
    loadedBlockPages.delete(effect.rowId);
    loadedCommentPages.delete(effect.rowId);
    return {
      pagesById,
      pageRolesById,
      blocksByPage,
      commentsByPage,
      loadedBlockPages,
      loadedCommentPages,
      databaseRowIdsByDb: {
        ...state.databaseRowIdsByDb,
        [effect.databaseId]: nextRowIds,
      },
      databaseSubitemRowWindowsByDb: pruneDatabaseSubitemRowWindows(
        state.databaseSubitemRowWindowsByDb,
        new Set([effect.rowId])
      ),
      databaseDependencyRelations: pruneDatabaseDependencyRelations(
        state.databaseDependencyRelations,
        new Set([effect.rowId])
      ),
      ...(pageState
        ? {
            databaseRowPagesByDb: {
              ...state.databaseRowPagesByDb,
              [effect.databaseId]: {
                ...pageState,
                loadedCount: Math.max(
                  0,
                  pageState.loadedCount - (rowIds.length - nextRowIds.length)
                ),
                ...(typeof pageState.totalCount === "number"
                  ? {
                      totalCount: Math.max(
                        0,
                        pageState.totalCount - (rowIds.length - nextRowIds.length)
                      ),
                    }
                  : {}),
              },
            },
          }
        : {}),
    };
  });

  // Prevent a cached private row or cached attachment bytes from reappearing
  // while access is being re-established. A successful authoritative refresh
  // below can safely repopulate the visible state.
  if (userId) void recordCacheClear(userId);
  void clearOfflineWorkspaceFileCache();
  if (status === 404) {
    void useStore
      .getState()
      .loadDatabaseRows(effect.databaseId, { force: true, reset: true })
      .catch(() => {});
  } else {
    void useStore.getState().refreshPageAccess(effect.rowId).catch(() => {});
  }
}

interface RemoteCallEffectDropResult {
  authoritativeValue?: unknown;
  unavailable: boolean;
}

async function applyRemoteCallEffectDrop(
  effect: RemoteCallEffect,
  error: unknown
): Promise<RemoteCallEffectDropResult | undefined> {
  if (effect.kind === "database_create") {
    rollbackOptimisticDatabaseCreate(effect);
    return { unavailable: false };
  }
  if (effect.kind === "database_metadata_reconcile") {
    await useStore
      .getState()
      .loadDatabase(effect.databaseId, { force: true, rows: false });
    return { unavailable: false };
  }
  if (
    effect.kind === "database_task_feature_commit"
    || effect.kind === "database_task_feature_turn_off"
  ) {
    await useStore
      .getState()
      .loadDatabase(effect.databaseId, { force: true, rows: false });
    return { unavailable: false };
  }
  if (effect.kind === "database_dependency_commit") {
    try {
      const relation = await getDatabaseDependencyRelationRemote(
        effect.databaseId,
        effect.rowId,
        effect.direction,
        { force: true, propertyId: effect.propertyId },
      );
      if (relation.propertyId !== effect.propertyId) {
        throw new Error("Dependency relation property authority changed.");
      }
      mergeDatabaseDependencyRelationAuthority(
        relation,
        { settledMutationId: effect.mutationId },
      );
    } catch {
      dropDatabaseDependencyPendingMutation(
        effect.rowId,
        effect.propertyId,
        effect.mutationId,
      );
    }
    return { unavailable: false };
  }
  if (effect.kind === "database_rows_reconcile") {
    clearOptimisticDatabaseSubitem(
      effect.rowId,
      effect.targetParentId,
      effect.mutationId
    );
    clearRecentDatabaseRowsQueries(effect.databaseId);
    await useStore
      .getState()
      .loadDatabaseRows(effect.databaseId, { force: true, reset: true });
    return { unavailable: false };
  }
  let authoritative: Page | null = null;
  let authoritativeError: unknown;
  try {
    authoritative = await getPageRemote(effect.rowId);
  } catch (loadError) {
    authoritativeError = loadError;
    // Permission loss, deletion, or a second network failure can make the
    // authoritative read unavailable. The conditional rollback below changes
    // only this file value and preserves any additions made while the request
    // was in flight.
  }

  if (!authoritative) {
    const status = persistErrorStatus(authoritativeError) ?? persistErrorStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      hideUnavailableDatabaseRow(effect, status);
      return { unavailable: true };
    }
  }

  let hadNewerValue = false;
  let reconciledValue: unknown = effect.previousValue;
  useStore.setState((state) => {
    const current = state.pagesById[effect.rowId];
    if (!current) return {};
    const currentValue = current.properties?.[effect.propertyId];
    hadNewerValue = !jsonValuesEqual(currentValue, effect.nextValue);
    const authoritativeValue = authoritative?.properties?.[effect.propertyId];
    reconciledValue = authoritative
      ? mergeAuthoritativeRowFileValue(effect, authoritativeValue, currentValue)
      : rollbackRowFileValue(effect, currentValue);
    return {
      pagesById: {
        ...state.pagesById,
        [effect.rowId]: {
          ...current,
          ...(authoritative ?? {}),
          properties: {
            ...(authoritative?.properties ?? current.properties ?? {}),
            [effect.propertyId]: reconciledValue,
          },
        },
      },
    };
  });
  projectOptimisticRowFileValue(effect.rowId, effect.propertyId, reconciledValue);
  if (hadNewerValue) preserveNewerPendingRowFileValue(effect, reconciledValue);
  return {
    authoritativeValue: authoritative
      ? (authoritative.properties?.[effect.propertyId] ?? null)
      : effect.previousValue,
    unavailable: false,
  };
}

// ── record-cache hydration (local-first Phase 1) ────────────────────────────
// Server-fetched record sets mirror into the per-user record cache; cold boots
// hydrate from it instantly and refetch in the background. Cached reads are
// overlaid with still-queued outbox mutations so offline reads reflect offline
// writes (the cache itself is only rewritten from server responses).

type WorkspaceBootstrapResult = Awaited<ReturnType<typeof bootstrapWorkspace>>;

const LAST_USER_KEY = "hanji.lastUserId";

function rememberLastUserId(userId: string) {
  try {
    window.localStorage.setItem(LAST_USER_KEY, userId);
  } catch {
    // Local storage is optional; hydration just won't work next boot.
  }
}

export function readLastUserId(): string {
  try {
    return window.localStorage.getItem(LAST_USER_KEY) ?? "";
  } catch {
    return "";
  }
}

// ── local data lock orchestration (key custody, roadmap §10) ────────────────
// Mode changes clear the durable local state (caches are caches; the outbox
// must be drained first) and reinitialize the storage layers under the new
// gate. The lock lib itself stays leaf-level — this is the only place that
// touches lock + outbox + record cache together.

export type LocalLockChangeResult =
  | "ok"
  | "pending-changes"
  | "unavailable"
  | "wrong-passphrase";

export async function enableLocalPassphraseLock(
  passphrase: string
): Promise<LocalLockChangeResult> {
  const userId = outboxUserId();
  if (!userId || !passphrase) return "unavailable";
  await flushAllPending();
  if ((await outboxAllEntries(userId)).length > 0) return "pending-changes";
  const result = await createPassphraseSecretBox(lockBoxName(userId), passphrase);
  if ("error" in result) return result.error;
  // MIGRATE rather than blind-clear, all under the cross-tab outbox lock so a
  // write racing the switch can't slip in under the old key. An entry another
  // tab enqueued after the emptiness check above (the old TOCTOU) is captured
  // by the snapshot inside outboxRekey and re-sealed under the new passphrase
  // box; the mode/gate flip happens between the snapshot and the re-seal.
  await outboxRekey(userId, async () => {
    await clearOfflineWorkspaceFileCache();
    setLocalEncryptionMode("passphrase");
    primeUnlockedGate(userId, result.box);
    resetOutboxForTests();
    resetRecordCacheForTests();
    await recordCacheClear(userId, true);
  });
  return "ok";
}

export async function disableLocalPassphraseLock(
  passphrase: string
): Promise<LocalLockChangeResult> {
  const userId = outboxUserId();
  if (!userId) return "unavailable";
  const verify = await createPassphraseSecretBox(lockBoxName(userId), passphrase);
  if ("error" in verify) return verify.error;
  await flushAllPending();
  if ((await outboxAllEntries(userId)).length > 0) return "pending-changes";
  // Migrate stragglers (same TOCTOU fix as enable) under the cross-tab outbox
  // lock: snapshot under the live passphrase box, switch to device, then re-seal
  // under the device box — with no window for a concurrent write to interleave.
  await outboxRekey(userId, async () => {
    await removePassphraseKey(lockBoxName(userId));
    setLocalEncryptionMode("device");
    resetGateToDevice(userId);
    resetOutboxForTests();
    resetRecordCacheForTests();
    await recordCacheClear(userId, true);
  });
  return "ok";
}

/**
 * Resume the local-first machinery after a mid-session unlock: when boot ran
 * locked (hydration skipped / claim deferred), restart it; when the app is
 * already live, just claim+replay queued ops and warm the offline scope.
 */
export async function handleLocalUnlock(input: WorkspaceBootstrapInput) {
  const userId = outboxUserId() || readLastUserId();
  if (userId && permanentDeleteCacheCleanupPending(userId)) {
    const cleared = await recordCacheClear(userId);
    if (cleared) markPermanentDeleteCacheCleanupPending(userId, false);
  }
  if (!useStore.getState().ready) {
    resetBootstrapForTests();
    await useStore.getState().bootstrap(input);
    return;
  }
  if (userId) {
    void replayDurableOutbox(userId).catch(() => {});
    scheduleWarmOfflineScope(userId);
  }
}

export async function changeLocalPassphrase(
  currentPassphrase: string,
  nextPassphrase: string
): Promise<LocalLockChangeResult> {
  const userId = outboxUserId();
  if (!userId || !nextPassphrase) return "unavailable";
  const result = await changePassphraseSecretBox(
    lockBoxName(userId),
    currentPassphrase,
    nextPassphrase
  );
  if ("error" in result) return result.error;
  // Sealed data stays readable under the re-wrapped DEK; swap the live box in.
  primeUnlockedGate(userId, result.box);
  resetOutboxForTests();
  resetRecordCacheForTests();
  return "ok";
}

function applyBootstrapResult(
  result: WorkspaceBootstrapResult,
  mode: "initial" | "reconcile",
  previousServerPageIds?: Set<string>,
  exposeReady = true,
  membershipAuthority: "cached" | "fresh" = "fresh"
) {
  clearRecentDatabaseRowsQueries();
  const {
    userId,
    isInstanceAdmin = false,
    workspace: ws,
    organization,
    organizations = [],
    currentOrganizationMember,
    organizationMembers = [],
    organizationGroups = [],
    organizationProfiles = [],
    organizationDomains = [],
    organizationAuditEvents = [],
    workspaces = [],
    currentMember,
    members = [],
    teamspaces = [],
    discoverableTeamspaces = [],
    teamspaceSettings,
    pages: unfilteredPages = [],
    pageRoles: unfilteredPageRoles = {},
    sharedPageIds: unfilteredSharedPageIds = [],
  } = result;
  const permanentDeletes = permanentDeleteIds(userId);
  const pages = unfilteredPages.filter((page) => !permanentDeletes.has(page.id));
  const pageRoles = Object.fromEntries(
    Object.entries(unfilteredPageRoles).filter(([pageId]) => !permanentDeletes.has(pageId))
  );
  const sharedPageIds = unfilteredSharedPageIds.filter(
    (pageId) => !permanentDeletes.has(pageId)
  );
  setWorkspacePeople(members, organizationProfiles);
  const pagesById: Record<string, Page> = {};
  for (const p of pages) pagesById[p.id] = p;

  if (mode === "reconcile") {
    // The app is already live (rendered from cache): refresh workspace-level
    // state without resetting per-page caches. Server wins per page id, but
    // local-only pages (queued offline creates) and still-pending debounced
    // patches survive the refresh. Pages the server KNEW before but no longer
    // returns were deleted or un-shared remotely — drop them.
    const currentState = useStore.getState();
    const removedPageIds = new Set<string>();
    if (previousServerPageIds) {
      for (const id of previousServerPageIds) {
        if (!pagesById[id] && currentState.pagesById[id] && !pendingPage.has(id)) {
          removedPageIds.add(id);
        }
      }
      for (const page of Object.values(currentState.pagesById)) {
        if (
          page.parentType !== "workspace"
          || !page.teamspaceId
          || pagesById[page.id]
          || !previousServerPageIds.has(page.id)
        ) {
          continue;
        }
        for (const pageId of collectPageSubtree(currentState.pagesById, page.id)) {
          removedPageIds.add(pageId);
        }
      }
    }
    if (removedPageIds.size) {
      const pendingBlockIds = new Set<string>();
      for (const pageId of removedPageIds) {
        cancelPendingPage(pageId);
        for (const block of currentState.blocksByPage[pageId] ?? []) pendingBlockIds.add(block.id);
      }
      for (const [blockId, pageId] of pendingBlockPage) {
        if (removedPageIds.has(pageId)) pendingBlockIds.add(blockId);
      }
      for (const block of pendingBlockCreate.values()) {
        if (removedPageIds.has(block.pageId)) pendingBlockIds.add(block.id);
      }
      for (const blockId of pendingBlockIds) {
        cancelPendingBlock(blockId);
        cancelPendingBlockCreate(blockId);
      }
    }
    useStore.setState((s) => {
      const merged = { ...s.pagesById };
      const pageRolesById = { ...s.pageRolesById };
      const blocksByPage = { ...s.blocksByPage };
      const blockHistoryByPage = { ...s.blockHistoryByPage };
      const commentsByPage = { ...s.commentsByPage };
      const propsByDb = { ...s.propsByDb };
      const viewsByDb = { ...s.viewsByDb };
      const templatesByDb = { ...s.templatesByDb };
      const databaseRowIdsByDb = { ...s.databaseRowIdsByDb };
      const databaseRowPagesByDb = { ...s.databaseRowPagesByDb };
      const loadedBlockPages = new Set(s.loadedBlockPages);
      const loadedCommentPages = new Set(s.loadedCommentPages);
      const loadedDbs = new Set(s.loadedDbs);
      const treeExpandedPageIds = new Set(s.treeExpandedPageIds);
      const hydratedRelationTargetIds = new Set(s.hydratedRelationTargetIds);
      for (const id of removedPageIds) {
        delete merged[id];
        delete pageRolesById[id];
        delete blocksByPage[id];
        delete blockHistoryByPage[id];
        delete commentsByPage[id];
        delete propsByDb[id];
        delete viewsByDb[id];
        delete templatesByDb[id];
        delete databaseRowIdsByDb[id];
        delete databaseRowPagesByDb[id];
        loadedBlockPages.delete(id);
        loadedCommentPages.delete(id);
        loadedDbs.delete(id);
        treeExpandedPageIds.delete(id);
        hydratedRelationTargetIds.delete(id);
      }
      for (const [databaseId, rowIds] of Object.entries(databaseRowIdsByDb)) {
        databaseRowIdsByDb[databaseId] = rowIds.filter((id) => !removedPageIds.has(id));
      }
      for (const [id, page] of Object.entries(pagesById)) {
        merged[id] = remotePageWithOptimisticOverlay(page);
      }
      Object.assign(pageRolesById, pageRoles);
      const recentPageIds = s.recentPageIds.filter((id) => !removedPageIds.has(id));
      writeRecentPageIds(ws.id, recentPageIds);
      writeTreeExpandedPageIds(ws.id, Array.from(treeExpandedPageIds));
      return {
        ready: true,
        bootstrapFailure: undefined,
        workspace: ws,
        activeDataScope: {
          kind: "workspace" as const,
          membershipAuthority,
          workspaceId: ws.id,
        },
        isInstanceAdmin,
        organization,
        organizations,
        currentOrganizationMember,
        organizationMembers,
        organizationGroups,
        organizationProfiles,
        organizationDomains,
        organizationAuditEvents,
        workspaces: workspaces.length ? workspaces : [ws],
        userId,
        currentMember,
        workspaceMembers: members,
        teamspaces,
        discoverableTeamspaces,
        teamspaceSettings,
        pagesById: merged,
        pageRolesById,
        blocksByPage,
        blockHistoryByPage,
        commentsByPage,
        propsByDb,
        viewsByDb,
        templatesByDb,
        databaseRowIdsByDb,
        databaseRowPagesByDb,
        databaseSubitemRowWindowsByDb: pruneDatabaseSubitemRowWindows(
          s.databaseSubitemRowWindowsByDb,
          removedPageIds,
        ),
        databaseDependencyRelations: pruneDatabaseDependencyRelations(
          s.databaseDependencyRelations,
          removedPageIds,
        ),
        loadedBlockPages,
        loadedCommentPages,
        loadedDbs,
        treeExpandedPageIds,
        hydratedRelationTargetIds,
        recentPageIds,
        sharedPageIds: new Set(sharedPageIds),
        ...(s.commentPanel && removedPageIds.has(s.commentPanel.pageId)
          ? { commentPanel: undefined }
          : {}),
        ...(s.focusPageId && removedPageIds.has(s.focusPageId)
          ? { focusPageId: undefined, focusPageTarget: undefined }
          : {}),
      };
    });
    return removedPageIds;
  }

  const recentPageIds = readRecentPageIds(ws.id).filter((id) => {
    const page = pagesById[id];
    return page && !page.inTrash;
  });
  const treeExpandedPageIds = new Set(
    readTreeExpandedPageIds(ws.id).filter((id) => {
      const page = pagesById[id];
      return page && !page.inTrash;
    })
  );
  resetDeferredBlockCreates();
  useStore.setState({
    ready: exposeReady,
    bootstrapFailure: undefined,
    workspace: ws,
    activeDataScope: { kind: "workspace", membershipAuthority, workspaceId: ws.id },
    isInstanceAdmin,
    organization,
    organizations,
    currentOrganizationMember,
    organizationMembers,
    organizationGroups,
    organizationProfiles,
    organizationDomains,
    organizationAuditEvents,
    workspaces: workspaces.length ? workspaces : [ws],
    userId,
    currentMember,
    workspaceMembers: members,
    teamspaces,
    discoverableTeamspaces,
    teamspaceSettings,
    pagesById,
    pageRolesById: pageRoles,
    sharedPageIds: new Set(sharedPageIds),
    recentPageIds,
    treeExpandedPageIds,
    blocksByPage: {},
    loadedBlockPages: new Set(),
    blockHistoryByPage: {},
    commentsByPage: {},
    loadedCommentPages: new Set(),
    propsByDb: {},
    viewsByDb: {},
    templatesByDb: {},
    loadedDbs: new Set(),
    databaseRowIdsByDb: {},
    databaseRowPagesByDb: {},
    databaseSubitemRowWindowsByDb: {},
    databaseDependencyRelations: {},
    hydratedRelationTargetIds: new Set(),
    commentPanel: undefined,
  });
  return new Set<string>();
}

function cachedBootTargetPageId(input: WorkspaceBootstrapInput): string | undefined {
  const explicit = input.pageId?.trim();
  if (explicit) return explicit;
  if (typeof window !== "undefined") {
    const route = routeInfoFromPath(window.location.pathname);
    if (route.kind === "page") return route.pageId;
    if (route.kind === "database") return route.databaseId;
  }
  const state = useStore.getState();
  const recent = state.recentPageIds.find((id) => {
    const page = state.pagesById[id];
    return !!page && !page.inTrash;
  });
  if (recent) return recent;
  return Object.values(state.pagesById)
    .filter((page) => page.parentType === "workspace" && !page.inTrash)
    .sort(bySortPos)[0]?.id;
}

async function hydrateCachedDatabaseForBoot(
  databaseId: string,
  options: { contextPageId?: string; preferredViewId?: string; rows?: boolean } = {}
) {
  const metadataHydrated = await hydrateDatabaseMetaFromCache(databaseId).catch(() => false);
  if (!metadataHydrated || options.rows === false) return;
  const views = useStore.getState().viewsByDb[databaseId] ?? [];
  const preferredViewId = options.preferredViewId?.trim();
  const view =
    (preferredViewId ? views.find((candidate) => candidate.id === preferredViewId) : undefined) ??
    views[0];
  if (!view) return;
  const query: DatabaseRowsQuery = {
    viewId: view.id,
    ...(options.contextPageId ? { currentPageId: options.contextPageId } : {}),
  };
  const queryKey = databaseRowsQueryKey(query);
  useStore.setState((state) => ({
    databaseRowPagesByDb: {
      ...state.databaseRowPagesByDb,
      [databaseId]: {
        queryKey,
        loadedCount: 0,
        hasMore: false,
        loading: true,
        loadingMore: false,
      },
    },
  }));
  const hydrated =
    (await hydrateDatabaseRowsFromCache(databaseId, queryKey).catch(() => false)) ||
    (await hydrateRowsViaLocalEngine(
      databaseId,
      queryKey,
      normalizeDatabaseRowsQuery(query)
    ).catch(() => false));
  if (hydrated) return;
  useStore.setState((state) => {
    if (state.databaseRowPagesByDb[databaseId]?.queryKey !== queryKey) return {};
    const databaseRowPagesByDb = { ...state.databaseRowPagesByDb };
    delete databaseRowPagesByDb[databaseId];
    return { databaseRowPagesByDb };
  });
}

async function hydrateCurrentRouteFromCache(input: WorkspaceBootstrapInput) {
  const pageId = cachedBootTargetPageId(input);
  if (!pageId) return;
  await hydrateBlocksFromCache(pageId).catch(() => false);
  const page = useStore.getState().pagesById[pageId];
  if (!page || page.inTrash) return;

  if (page.kind === "database") {
    const preferredViewId = typeof window === "undefined"
      ? undefined
      : new URL(window.location.href).searchParams.get("v") ?? undefined;
    await hydrateCachedDatabaseForBoot(page.id, { preferredViewId });
    return;
  }

  // A database row needs its parent schema for the property header even
  // though the row list itself is not rendered on this route.
  if (page.parentType === "database" && page.parentId) {
    await hydrateCachedDatabaseForBoot(page.parentId, { rows: false });
  }

  const blocks = useStore.getState().blocksByPage[pageId] ?? [];
  const embedded = new Map<string, { contextPageId: string; preferredViewId?: string }>();
  for (const block of blocks) {
    const databaseId = block.content?.childPageId;
    if (!databaseId || useStore.getState().pagesById[databaseId]?.kind !== "database") continue;
    const preferredViewId =
      typeof block.content?.databaseViewId === "string"
        ? block.content.databaseViewId
        : undefined;
    embedded.set(databaseId, { contextPageId: pageId, preferredViewId });
  }
  await Promise.all(
    Array.from(embedded, ([databaseId, options]) =>
      hydrateCachedDatabaseForBoot(databaseId, options)
    )
  );
}

async function revalidateHydratedCurrentRouteBlocks(input: WorkspaceBootstrapInput) {
  const pageId = cachedBootTargetPageId(input);
  if (!pageId || !useStore.getState().loadedBlockPages.has(pageId)) return;
  if (await blocksCacheFresh(pageId)) return;
  await useStore.getState().loadBlocks(pageId, { force: true });
}


function materializeOutboxEffects(entries: OutboxEntry[]) {
  for (const entry of entries) {
    const effect = entry.value.kind === "remote_call" ? entry.value.effect : undefined;
    if (effect?.kind === "database_create") materializeDatabaseCreateEffect(effect);
  }
}

function applyBootstrapResultWithOutbox(
  result: WorkspaceBootstrapResult,
  entries: OutboxEntry[],
  mode: "initial" | "reconcile",
  previousServerPageIds?: Set<string>,
  exposeReady = true,
  membershipAuthority: "cached" | "fresh" = "fresh"
) {
  const removedPageIds = applyBootstrapResult(
    { ...result, pages: overlayOutboxOnPages(entries, result.pages ?? []) },
    mode,
    previousServerPageIds,
    exposeReady,
    membershipAuthority
  );
  materializeOutboxEffects(entries);
  if (removedPageIds.size) {
    // A server visibility decision is authoritative. Reset every persistent
    // page/container cache generation before the caller stores the new
    // bootstrap blob, so a warm reload cannot revive revoked Teamspace data.
    void recordCacheClear(result.userId);
    void clearOfflineWorkspaceFileCache();
  }
  return removedPageIds;
}

/**
 * The signed-in account id when the SDK already knows it, "" otherwise
 * (cold boot before the async session restore, or offline).
 */
function knownAuthUserId(): string {
  try {
    return currentUserId();
  } catch {
    return "";
  }
}

/** Read the cached bootstrap payload for a boot key (server truth as stored). */
async function readBootstrapBlob(key: string): Promise<WorkspaceBootstrapResult | null> {
  const userId = useStore.getState().userId || readLastUserId();
  if (!userId) return null;
  // Shared-browser guard: when the session already belongs to a DIFFERENT
  // account than the cache owner (previous account's session expired without
  // the sign-out cleanup, then someone else signed in), the previous
  // account's cached workspace must not render for this one. Offline cold
  // boots keep hydrating: no session is resolvable there, so authUserId is "".
  const authUserId = knownAuthUserId();
  if (authUserId && authUserId !== userId) return null;
  // Passphrase lock still pending: do NOT block boot on the unlock dialog —
  // the network path proceeds; hydration resumes once unlocked (offline boots
  // surface the retry button, which re-runs bootstrap after unlock).
  if (localBoxIfSettled(userId) === "pending") return null;
  const cached = await cacheGetMeta<WorkspaceBootstrapResult>(
    userId,
    recordCacheMeta.bootstrap(key)
  );
  if (!cached?.workspace || !Array.isArray(cached.pages)) return null;
  const deleted = permanentDeleteIds(userId);
  if (deleted.size === 0) return cached;
  return {
    ...cached,
    pages: cached.pages.filter((page) => !deleted.has(page.id)),
    pageRoles: Object.fromEntries(
      Object.entries(cached.pageRoles ?? {}).filter(([pageId]) => !deleted.has(pageId))
    ),
    sharedPageIds: (cached.sharedPageIds ?? []).filter((pageId) => !deleted.has(pageId)),
  };
}

/**
 * Un-render a cache-hydrated boot that the server refuted with a definitive
 * denial (401/403/404): reset everything `applyBootstrapResult` set so the
 * denial screen is not backed by cached data the server just refused —
 * possibly a previous account's on a shared browser.
 */
function discardHydratedBoot() {
  clearRecentDatabaseRowsQueries();
  resetReadApplicationGuards();
  resetDeferredBlockCreates();
  setWorkspacePeople([], []);
  useStore.setState({
    ready: false,
    userId: "",
    workspace: undefined,
    activeDataScope: undefined,
    workspaces: [],
    isInstanceAdmin: false,
    organization: undefined,
    organizations: [],
    currentOrganizationMember: undefined,
    organizationMembers: [],
    organizationGroups: [],
    organizationProfiles: [],
    organizationDomains: [],
    organizationAuditEvents: [],
    currentMember: undefined,
    workspaceMembers: [],
    teamspaces: [],
    discoverableTeamspaces: [],
    teamspaceSettings: undefined,
    pagesById: {},
    pageRolesById: {},
    sharedPageIds: new Set(),
    recentPageIds: [],
    treeExpandedPageIds: new Set(),
    blocksByPage: {},
    loadedBlockPages: new Set(),
    blockHistoryByPage: {},
    commentsByPage: {},
    loadedCommentPages: new Set(),
    propsByDb: {},
    viewsByDb: {},
    templatesByDb: {},
    loadedDbs: new Set(),
    databaseRowIdsByDb: {},
    databaseRowPagesByDb: {},
    databaseSubitemRowWindowsByDb: {},
    databaseDependencyRelations: {},
    hydratedRelationTargetIds: new Set(),
    commentPanel: undefined,
  });
}

async function hydrateBootstrapFromCache(
  key: string,
  blob: WorkspaceBootstrapResult | null,
  input: WorkspaceBootstrapInput
): Promise<boolean> {
  if (!blob || useStore.getState().ready) return false;
  const userId = useStore.getState().userId || readLastUserId();
  if (!userId) return false;
  const entries = await outboxAllEntries(userId);
  // A warm reload already has enough identity + durable mutation data to
  // recover immediately. Do not wait for the network bootstrap and route
  // revalidation before starting the claimed outbox lane; those reads can run
  // in parallel while the canonical write is acknowledged.
  void replayDurableOutbox(userId).catch(() => {});
  applyBootstrapResultWithOutbox(
    blob,
    entries,
    "initial",
    undefined,
    false,
    "cached"
  );
  // Keep the boot surface hidden until the current page's cached blocks and
  // database state have joined the workspace snapshot. This prevents a warm
  // reload from exposing a page-shaped skeleton between separate cache reads.
  await hydrateCurrentRouteFromCache(input).catch(() => {});
  useStore.setState({ ready: true });
  return true;
}

/**
 * Materialize a delta bootstrap response over the cached blob: server ids
 * prune deletions/revocations, changed pages overwrite, everything else comes
 * from the cache. Returns null (→ caller does a full fetch) when a visible id
 * is missing locally, e.g. a page newly shared since the cache was written.
 */
function resolveBootstrapDelta(
  blob: WorkspaceBootstrapResult | null,
  delta: WorkspaceBootstrapResult
): WorkspaceBootstrapResult | null {
  if (!blob || !Array.isArray(delta.changedPages)) return null;
  // O(changes) tombstone mode (§7 v2): the change feed guarantees no
  // visibility shifts, so deletions-first + changed-upsert over the blob is
  // the complete new truth — no id list, no fallback needed.
  if (delta.deltaMode === "changes" && Array.isArray(delta.deletedPageIds)) {
    const deleted = new Set(delta.deletedPageIds);
    const byId = new Map(
      (blob.pages ?? []).filter((page) => !deleted.has(page.id)).map((page) => [page.id, page])
    );
    // Deletions first, then every changed record upserts — a page deleted and
    // recreated arrives as tombstone + fresh record and lands present.
    for (const page of delta.changedPages) byId.set(page.id, page);
    return {
      ...delta,
      changedPages: undefined,
      pagesDelta: undefined,
      deletedPageIds: undefined,
      pages: [...byId.values()],
    };
  }
  if (!Array.isArray(delta.visiblePageIds)) return null;
  const byId = new Map((blob.pages ?? []).map((page) => [page.id, page]));
  for (const page of delta.changedPages) byId.set(page.id, page);
  const pages: Page[] = [];
  for (const id of delta.visiblePageIds) {
    const page = byId.get(id);
    if (!page) return null;
    pages.push(page);
  }
  return { ...delta, changedPages: undefined, pagesDelta: undefined, visiblePageIds: undefined, pages };
}

/** Strip transient delta fields before persisting the blob. */
function bootstrapBlobForCache(result: WorkspaceBootstrapResult): WorkspaceBootstrapResult {
  const blob = { ...result };
  delete blob.changedPages;
  delete blob.pagesDelta;
  delete blob.visiblePageIds;
  delete blob.deletedPageIds;
  delete blob.deltaMode;
  delete blob.changedDatabaseIds;
  delete blob.changedBlockPageIds;
  const deleted = permanentDeleteIds(blob.userId);
  if (deleted.size > 0) {
    blob.pages = (blob.pages ?? []).filter((page) => !deleted.has(page.id));
    blob.pageRoles = Object.fromEntries(
      Object.entries(blob.pageRoles ?? {}).filter(([pageId]) => !deleted.has(pageId))
    );
    blob.sharedPageIds = (blob.sharedPageIds ?? []).filter((pageId) => !deleted.has(pageId));
  }
  if (!blob.pagesSyncedAt) {
    blob.pagesSyncedAt = (blob.pages ?? []).reduce(
      (max, page) => (page.updatedAt && page.updatedAt > max ? page.updatedAt : max),
      ""
    );
  }
  return blob;
}

// Skip hints from this boot's change feed (§7 v2). `null` sets = unknown →
// never skip. `feedSince` is the cursor the feed covered FROM; a cache is
// skippable only when it was written at/after that cursor's era (its
// feedStamp) AND its container has no entries in the feed.
let bootFeed: {
  changedDatabaseIds: Set<string> | null;
  feedSince: string;
} = { changedDatabaseIds: null, feedSince: "" };
let currentChangesSyncedAt = "";

function applyBootFeedHints(result: WorkspaceBootstrapResult, previousChangesSyncedAt: string) {
  currentChangesSyncedAt = result.changesSyncedAt ?? "";
  if (result.deltaMode === "changes" && Array.isArray(result.changedDatabaseIds)) {
    bootFeed = {
      changedDatabaseIds: new Set(result.changedDatabaseIds),
      feedSince: previousChangesSyncedAt,
    };
  } else {
    bootFeed = { changedDatabaseIds: null, feedSince: "" };
  }
}

// ── live workspace delta refresh ────────────────────────────────────────────
// The boot path syncs once; without this loop another user's new/renamed/
// deleted pages never reach an open tab until a manual reload. Re-run the
// pages-delta fetch periodically while the tab is visible and on focus/
// visibility regains, reconciling through the same SWR machinery as boot.
const WORKSPACE_REFRESH_MS = 60_000;
const WORKSPACE_REFRESH_MIN_GAP_MS = 15_000;
const WORKSPACE_REFRESH_ACTIVITY_WINDOW_MS = 5 * 60_000;
const WORKSPACE_REFRESH_ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "wheel"] as const;
let workspaceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let workspaceRefreshInFlight: Promise<void> | null = null;
let workspaceRefreshInFlightGeneration = -1;
let workspaceRefreshInFlightKey = "";
let workspaceRefreshGeneration = 0;
let workspaceRefreshedAt = 0;
let workspaceRefreshLastActivityAt = 0;
let workspaceRefreshListenersInstalled = false;
let bootInputForRefresh: WorkspaceBootstrapInput = {};
let bootInputKeyForRefresh = "";

function workspaceRefreshIsCurrent(generation: number, key: string, dataEpoch: number) {
  return (
    generation === workspaceRefreshGeneration &&
    bootKey === key &&
    bootInputKeyForRefresh === key &&
    useStore.getState().ready &&
    dataEpoch === workspaceDataEpoch
  );
}

async function runWorkspaceRefreshDelta(generation: number) {
  const dataEpoch = workspaceDataEpoch;
  try {
    const key = bootKey;
    const refreshInput = { ...bootInputForRefresh };
    const blob = await readBootstrapBlob(key);
    const watermark = blob?.pagesSyncedAt;
    // No cached baseline to delta against — leave full fetches to the boot path.
    if (!blob || !watermark) return;
    // A reset or workspace switch while the cache read was pending must not
    // issue a stale authenticated request for the former owner.
    if (!workspaceRefreshIsCurrent(generation, key, dataEpoch)) return;
    const changesCursor = blob.changesSyncedAt ?? "";
    if (blob.workspaceRefreshToken) {
      try {
        const probe = await probeWorkspaceChanges({
          workspaceId: blob.workspace.id,
          workspaceRefreshToken: blob.workspaceRefreshToken,
        });
        // A reset or workspace switch while the lean request was in flight
        // must neither mark the former workspace fresh nor start its fallback.
        if (!workspaceRefreshIsCurrent(generation, key, dataEpoch)) return;
        if (probe.decision === "unchanged") {
          // The opaque token already represents the authoritative cursor and
          // authority snapshot. A quiet probe deliberately mutates no cache,
          // feed cursor, store identity, or outbox state.
          workspaceRefreshedAt = Date.now();
          return;
        }
      } catch (error) {
        if (!workspaceRefreshIsCurrent(generation, key, dataEpoch)) return;
        const status = persistErrorStatus(error);
        // A definitive endpoint denial/miss may reflect a scoped actor or an
        // older deployment. Let the existing visibility-filtered bootstrap
        // make the authoritative decision exactly once. Network/5xx failures
        // abort this tick and retry on the next scheduled boundary.
        if (status !== 401 && status !== 403 && status !== 404) throw error;
      }
      // Explicit fence between the probe and the authoritative fallback.
      if (!workspaceRefreshIsCurrent(generation, key, dataEpoch)) return;
    }
    let result = await bootstrapWorkspace({
      ...refreshInput,
      pagesSince: watermark,
      ...(changesCursor ? { changesSince: changesCursor } : {}),
    });
    // Workspace switched while the fetch was in flight: discard.
    if (!workspaceRefreshIsCurrent(generation, key, dataEpoch)) return;
    // Nothing changed since the cursor: advance the cursor cache but do NOT
    // touch store state — replacing workspaceMembers/pagesById with fresh
    // identities every poll would re-render subscribers and (worse) bounce
    // the presence room, which re-joins when the member array changes.
    const state = useStore.getState();
    const resultWorkspaces = result.workspaces?.length
      ? result.workspaces
      : [result.workspace];
    const sameJson = (left: unknown, right: unknown) =>
      JSON.stringify(left) === JSON.stringify(right);
    let quietDelta =
      result.pagesDelta &&
      (result.changedPages?.length ?? 0) === 0 &&
      (result.deletedPageIds?.length ?? 0) === 0 &&
      result.userId === state.userId &&
      (result.isInstanceAdmin ?? false) === state.isInstanceAdmin &&
      sameJson(result.workspace, state.workspace) &&
      sameJson(result.organization, state.organization) &&
      sameJson(result.organizations ?? [], state.organizations) &&
      sameJson(result.currentOrganizationMember, state.currentOrganizationMember) &&
      sameJson(result.organizationMembers ?? [], state.organizationMembers) &&
      sameJson(result.organizationGroups ?? [], state.organizationGroups) &&
      sameJson(result.organizationProfiles ?? [], state.organizationProfiles) &&
      sameJson(result.organizationDomains ?? [], state.organizationDomains) &&
      sameJson(result.organizationAuditEvents ?? [], state.organizationAuditEvents) &&
      sameJson(resultWorkspaces, state.workspaces) &&
      sameJson(result.currentMember, state.currentMember) &&
      sameJson(result.members ?? [], state.workspaceMembers) &&
      sameJson(result.teamspaces ?? [], state.teamspaces) &&
      sameJson(result.discoverableTeamspaces ?? [], state.discoverableTeamspaces) &&
      sameJson(result.teamspaceSettings, state.teamspaceSettings) &&
      sameJson(result.pageRoles ?? {}, state.pageRolesById) &&
      JSON.stringify((result.sharedPageIds ?? []).slice().sort()) ===
        JSON.stringify(Array.from(state.sharedPageIds).sort());
    if (result.pagesDelta) {
      const resolved = resolveBootstrapDelta(blob, result);
      if (resolved) {
        result = resolved;
      } else {
        // A delta can be impossible to materialize when a newly visible page
        // is absent from the local blob. Finish this one refresh chain with a
        // single authoritative full response instead of repeating the same
        // probe+delta on every tick.
        result = await bootstrapWorkspace(refreshInput);
        if (!workspaceRefreshIsCurrent(generation, key, dataEpoch)) return;
        quietDelta = false;
      }
    }
    if (!quietDelta) {
      const entries = await outboxAllEntries(result.userId);
      // Reading the durable overlay is asynchronous. Re-check every owner
      // fence before applying either it or the server result.
      if (!workspaceRefreshIsCurrent(generation, key, dataEpoch)) return;
      applyBootFeedHints(result, changesCursor);
      applyBootstrapResultWithOutbox(
        result,
        entries,
        "reconcile",
        new Set((blob.pages ?? []).map((page) => page.id))
      );
    } else {
      applyBootFeedHints(result, changesCursor);
    }
    cacheSetMeta(result.userId, recordCacheMeta.bootstrap(key), bootstrapBlobForCache(result));
    workspaceRefreshedAt = Date.now();
  } catch {
    // Transient (offline, auth refresh): the next tick retries.
  }
}

function refreshWorkspaceDelta() {
  const activeState = useStore.getState();
  if (
    !activeState.ready ||
    activeState.activeDataScope?.kind === "public_share" ||
    !bootKey ||
    (typeof document !== "undefined" && document.visibilityState === "hidden") ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  ) return Promise.resolve();
  const generation = workspaceRefreshGeneration;
  const key = bootKey;
  if (
    workspaceRefreshInFlight &&
    workspaceRefreshInFlightGeneration === generation &&
    workspaceRefreshInFlightKey === key
  ) return workspaceRefreshInFlight;
  const refresh = runWorkspaceRefreshDelta(generation).finally(() => {
    if (workspaceRefreshInFlight === refresh) {
      workspaceRefreshInFlight = null;
      workspaceRefreshInFlightGeneration = -1;
      workspaceRefreshInFlightKey = "";
    }
  });
  workspaceRefreshInFlight = refresh;
  workspaceRefreshInFlightGeneration = generation;
  workspaceRefreshInFlightKey = key;
  return refresh;
}

function workspaceRefreshActivityRecent(now = Date.now()) {
  return (
    workspaceRefreshLastActivityAt > 0 &&
    now - workspaceRefreshLastActivityAt < WORKSPACE_REFRESH_ACTIVITY_WINDOW_MS
  );
}

function scheduleWorkspaceRefreshTick() {
  if (
    workspaceRefreshTimer !== null ||
    typeof window === "undefined" ||
    !workspaceRefreshActivityRecent()
  ) return;
  const activityRemaining =
    workspaceRefreshLastActivityAt + WORKSPACE_REFRESH_ACTIVITY_WINDOW_MS - Date.now();
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = null;
    if (!workspaceRefreshActivityRecent()) return;
    void refreshWorkspaceDelta().finally(scheduleWorkspaceRefreshTick);
  }, Math.min(WORKSPACE_REFRESH_MS, activityRemaining));
}

function markWorkspaceRefreshActivity(forceStaleRefresh: boolean) {
  const now = Date.now();
  const resumedFromIdle = !workspaceRefreshActivityRecent(now);
  workspaceRefreshLastActivityAt = now;
  scheduleWorkspaceRefreshTick();
  if (
    (forceStaleRefresh || resumedFromIdle) &&
    now - workspaceRefreshedAt >= WORKSPACE_REFRESH_MIN_GAP_MS
  ) {
    void refreshWorkspaceDelta();
  }
}

function handleWorkspaceRefreshInputActivity() {
  markWorkspaceRefreshActivity(false);
}

function handleWorkspaceRefreshBoundary() {
  markWorkspaceRefreshActivity(true);
}

function handleWorkspaceRefreshVisibility() {
  if (document.visibilityState === "visible") handleWorkspaceRefreshBoundary();
}

function installWorkspaceRefreshListeners() {
  if (workspaceRefreshListenersInstalled || typeof window === "undefined") return;
  workspaceRefreshListenersInstalled = true;
  for (const eventName of WORKSPACE_REFRESH_ACTIVITY_EVENTS) {
    window.addEventListener(eventName, handleWorkspaceRefreshInputActivity, {
      capture: true,
      passive: true,
    });
  }
  window.addEventListener("focus", handleWorkspaceRefreshBoundary);
  window.addEventListener("online", handleWorkspaceRefreshBoundary);
  document.addEventListener("visibilitychange", handleWorkspaceRefreshVisibility);
}

function resetWorkspaceRefreshLoop() {
  if (workspaceRefreshTimer !== null) clearTimeout(workspaceRefreshTimer);
  workspaceRefreshTimer = null;
  workspaceRefreshGeneration += 1;
  workspaceRefreshLastActivityAt = 0;
  workspaceRefreshedAt = 0;
  bootInputForRefresh = {};
  bootInputKeyForRefresh = "";
  if (!workspaceRefreshListenersInstalled || typeof window === "undefined") return;
  for (const eventName of WORKSPACE_REFRESH_ACTIVITY_EVENTS) {
    window.removeEventListener(eventName, handleWorkspaceRefreshInputActivity, true);
  }
  window.removeEventListener("focus", handleWorkspaceRefreshBoundary);
  window.removeEventListener("online", handleWorkspaceRefreshBoundary);
  document.removeEventListener("visibilitychange", handleWorkspaceRefreshVisibility);
  workspaceRefreshListenersInstalled = false;
}

export function workspaceRefreshScheduleForTests() {
  return {
    activityWindowMs: WORKSPACE_REFRESH_ACTIVITY_WINDOW_MS,
    inFlight: workspaceRefreshInFlight !== null,
    lastActivityAt: workspaceRefreshLastActivityAt,
    timerArmed: workspaceRefreshTimer !== null,
  };
}

export async function workspaceRefreshIdleForTests() {
  while (workspaceRefreshInFlight) await workspaceRefreshInFlight;
}

function startWorkspaceRefreshLoop() {
  if (typeof window === "undefined") return;
  installWorkspaceRefreshListeners();
  workspaceRefreshLastActivityAt = Date.now();
  scheduleWorkspaceRefreshTick();
}


/**
 * Delta-sync-lite (roadmap §7): the blocks cache stamps the page's
 * `updatedAt` at fetch time. Every block mutation touches its page, so a
 * matching stamp means nothing changed server-side since the cache was
 * written and the refetch can be skipped (live edits arrive via page-room
 * signals while the page is open).
 */
async function blocksCacheFresh(pageId: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId) return false;
  const stamp = await cacheGetMeta<string>(userId, recordCacheMeta.blocksStamp(pageId));
  if (!stamp) return false;
  const page = useStore.getState().pagesById[pageId];
  return !!page?.updatedAt && page.updatedAt === stamp;
}

async function hydrateBlocksFromCache(pageId: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId || permanentDeleteIds(userId).has(pageId)) return false;
  const records = await cacheListTable<Block>(userId, recordCacheTables.blocks(pageId));
  if (!records.length || permanentDeleteIds(userId).has(pageId)) return false;
  const entries = await outboxAllEntries(userId);
  const blocks = overlayOutboxOnBlocks(entries, pageId, records.map((record) => record.value));
  useStore.setState((s) => {
    if (s.loadedBlockPages.has(pageId)) return {};
    const cachedIds = new Set(blocks.map((block) => block.id));
    const optimistic = (s.blocksByPage[pageId] ?? []).filter((block) => !cachedIds.has(block.id));
    return {
      blocksByPage: {
        ...s.blocksByPage,
        [pageId]: [...blocks, ...optimistic].sort(bySortPos),
      },
      loadedBlockPages: new Set(s.loadedBlockPages).add(pageId),
    };
  });
  return true;
}

async function cacheCurrentComments(pageId: string) {
  const userId = outboxUserId();
  if (!userId) return;
  const comments = useStore.getState().commentsByPage[pageId] ?? [];
  await Promise.all([
    cacheReplaceTable(
      userId,
      recordCacheTables.comments(pageId),
      comments.map((comment) => ({ id: comment.id, value: comment }))
    ),
    cacheSetMeta(userId, recordCacheMeta.commentsCachedAt(pageId), Date.now()),
    // Comments can be loaded from UpdatesPanel without loading page blocks.
    // Share the page-surface LRU so those comment-only tables stay bounded.
    stampBlocksCached(userId, pageId),
  ]);
}

async function hydrateCommentsFromCache(pageId: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId || permanentDeleteIds(userId).has(pageId)) return false;
  const cachedAt = await cacheGetMeta<number>(
    userId,
    recordCacheMeta.commentsCachedAt(pageId)
  );
  if (!cachedAt) return false;
  const [records, entries] = await Promise.all([
    cacheListTable<Comment>(userId, recordCacheTables.comments(pageId)),
    outboxAllEntries(userId),
  ]);
  const comments = overlayOutboxOnComments(
    entries,
    pageId,
    records.map((record) => record.value)
  );
  useStore.setState((state) => {
    if (state.loadedCommentPages.has(pageId)) return {};
    return {
      commentsByPage: { ...state.commentsByPage, [pageId]: comments },
      loadedCommentPages: new Set(state.loadedCommentPages).add(pageId),
    };
  });
  return true;
}

async function hydrateDatabaseMetaFromCache(dbId: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId || permanentDeleteIds(userId).has(dbId)) return false;
  const [props, views, templates] = await Promise.all([
    cacheListTable<DbProperty>(userId, recordCacheTables.databaseProperties(dbId)),
    cacheListTable<DbView>(userId, recordCacheTables.databaseViews(dbId)),
    cacheListTable<DbTemplate>(userId, recordCacheTables.databaseTemplates(dbId)),
  ]);
  if (!props.length && !views.length) return false;
  useStore.setState((s) => {
    if (s.propsByDb[dbId] || s.viewsByDb[dbId] || s.templatesByDb[dbId]) return {};
    return {
      propsByDb: { ...s.propsByDb, [dbId]: props.map((r) => r.value).sort(bySortPos) },
      viewsByDb: { ...s.viewsByDb, [dbId]: views.map((r) => r.value).sort(bySortPos) },
      templatesByDb: {
        ...s.templatesByDb,
        [dbId]: templates.map((r) => r.value).sort(bySortPos),
      },
    };
  });
  return true;
}

function cacheCurrentDatabaseMetadata(dbId: string) {
  const userId = outboxUserId();
  if (!userId) return Promise.resolve();
  const properties = useStore.getState().propsByDb[dbId] ?? [];
  const views = useStore.getState().viewsByDb[dbId] ?? [];
  const templates = useStore.getState().templatesByDb[dbId] ?? [];
  return Promise.all([
    cacheReplaceTable(
      userId,
      recordCacheTables.databaseProperties(dbId),
      properties.map((property) => ({ id: property.id, value: property }))
    ),
    cacheReplaceTable(
      userId,
      recordCacheTables.databaseViews(dbId),
      views.map((view) => ({ id: view.id, value: view }))
    ),
    cacheReplaceTable(
      userId,
      recordCacheTables.databaseTemplates(dbId),
      templates.map((template) => ({ id: template.id, value: template }))
    ),
  ]).then(() => undefined);
}

async function applyEmbeddedDatabaseSnapshots(
  snapshots: DatabaseSnapshotResult[],
  sourceToken: ReadApplicationToken
) {
  if (snapshots.length === 0) return;
  const deleted = permanentDeleteIds(outboxUserId());
  const accepted = snapshots.filter(
    (snapshot, index, all) =>
      !deleted.has(snapshot.databaseId) &&
      all.findIndex((candidate) => candidate.databaseId === snapshot.databaseId) === index
  );
  if (accepted.length === 0) return;

  await Promise.all(
    accepted.map((snapshot) => {
      const dbId = snapshot.databaseId;
      const metadataToken = deriveReadApplication(
        sourceToken,
        readApplicationKey.databaseMetadata(dbId),
        readApplicationKey.databaseScope(dbId)
      );
      return applyLatestRead(metadataToken, async () => {
        // Publish each schema received with the blocks response immediately.
        // A direct metadata request that started later owns a newer token and
        // prevents this embedded snapshot from replacing it.
        useStore.setState((state) => {
          const pagesById = { ...state.pagesById };
          const resolvedTitle = snapshot.resolvedDatabaseTitle?.trim();
          if (resolvedTitle && pagesById[dbId]) {
            const page = pagesById[dbId];
            pagesById[dbId] = {
              ...page,
              properties: {
                ...(page.properties ?? {}),
                notionLinkedDatabaseResolvedTitle: resolvedTitle,
                notionLinkedDatabaseResolvedId: snapshot.resolvedDatabaseId,
                notionLinkedDatabaseResolvedFromNotionId: snapshot.resolvedFromNotionDatabaseId,
              },
            };
          }
          databaseMetadataRevalidated.add(dbId);
          return {
            pagesById,
            propsByDb: {
              ...state.propsByDb,
              [dbId]: snapshot.properties.slice().sort(bySortPos),
            },
            viewsByDb: {
              ...state.viewsByDb,
              [dbId]: mergeById(state.viewsByDb[dbId], snapshot.views),
            },
            templatesByDb: {
              ...state.templatesByDb,
              [dbId]: mergeById(state.templatesByDb[dbId], snapshot.templates),
            },
          };
        });

        const cacheUserId = outboxUserId();
        if (!cacheUserId) return;
        await Promise.all([
          cacheCurrentDatabaseMetadata(dbId),
          cacheSetMeta(
            cacheUserId,
            recordCacheMeta.databaseMetadataStamp(dbId),
            currentChangesSyncedAt || ""
          ),
          stampDatabaseCached(cacheUserId, dbId),
        ]);
      });
    })
  );
}

function purgePagesFromBootstrapCache(userId: string, pageIds: Iterable<string>) {
  if (!userId || !bootKey) return Promise.resolve();
  const doomed = new Set(pageIds);
  return cacheUpdateMeta<WorkspaceBootstrapResult>(
    userId,
    recordCacheMeta.bootstrap(bootKey),
    (current) => {
      if (!current) return undefined;
      const pageRoles = { ...(current.pageRoles ?? {}) };
      for (const pageId of doomed) delete pageRoles[pageId];
      return {
        ...current,
        pages: (current.pages ?? []).filter((page) => !doomed.has(page.id)),
        pageRoles,
        sharedPageIds: (current.sharedPageIds ?? []).filter((pageId) => !doomed.has(pageId)),
      };
    }
  );
}

export interface CachedRowsMeta {
  hasMore: boolean;
  nextOffset?: number;
  nextCursor?: string;
  queryKey: string;
  rowIds: string[];
  totalCount?: number;
  /** Session change-feed cursor at write time (skip-hint eligibility, §7 v2). */
  feedStamp?: string;
}

// Per-db stamps observed while hydrating this boot (consumed by feed skips).
const lastHydratedRowsFeedStamp = new Map<string, string>();

/**
 * A cached container is provably fresh when this boot's feed is complete,
 * carries no entries for it, and the cache was written no earlier than the
 * feed's starting cursor (so the feed covers the entire unsynced window).
 */
function feedSaysUnchanged(dbId: string, cacheStamp: string | undefined): boolean {
  return (
    !!bootFeed.changedDatabaseIds &&
    !bootFeed.changedDatabaseIds.has(dbId) &&
    !!bootFeed.feedSince &&
    !!cacheStamp &&
    cacheStamp >= bootFeed.feedSince
  );
}

/**
 * Offline any-view fallback (Phase 3 v2): when the requested row query has no
 * cache of its own but the db's DEFAULT query is cached COMPLETELY
 * (hasMore=false, every row present), compute the requested view locally with
 * the app's own engine (`applyView` → shared query-core) — identical filter/
 * sort/search semantics to a server round-trip over the same rows. Partial
 * base sets never qualify (never-show-partial).
 */
async function hydrateRowsViaLocalEngine(
  dbId: string,
  queryKey: string,
  normalized: {
    currentPageId: string;
    search: string;
    subitemParentId: string | null;
    viewId: string;
  }
): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId) return false;
  const baseKey = databaseRowsQueryKey({});
  if (queryKey === baseKey) return false;
  const keys = databaseRowCacheKeys(dbId, baseKey);
  const meta = await cacheGetMeta<CachedRowsMeta>(userId, keys.meta);
  if (!meta || meta.queryKey !== baseKey || meta.hasMore) return false;
  const [rowRecords, relatedRecords, entries] = await Promise.all([
    cacheListTable<Page>(userId, keys.dataTable),
    cacheListTable<Page>(userId, keys.relatedPagesTable),
    outboxAllEntries(userId),
  ]);
  const deleted = permanentDeleteIds(userId);
  const rows = overlayOutboxOnPages(entries, rowRecords.map((record) => record.value)).filter(
    (page) => !deleted.has(page.id)
  );
  const effectiveRowIds = meta.rowIds.filter((id) => !deleted.has(id));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  if (effectiveRowIds.some((id) => !rowsById.has(id))) return false;

  const state = useStore.getState();
  const props = state.propsByDb[dbId] ?? [];
  const view = normalized.viewId
    ? (state.viewsByDb[dbId] ?? []).find((item) => item.id === normalized.viewId)
    : undefined;
  if (normalized.viewId && !view) return false;
  if (!props.length) return false;

  const related = overlayOutboxOnPages(entries, relatedRecords.map((record) => record.value)).filter(
    (page) => !deleted.has(page.id)
  );
  const baseRows = effectiveRowIds
    .map((id) => rowsById.get(id))
    .filter((row): row is Page => !!row)
    .filter((row) => (
      normalized.subitemParentId === null
      || (row.subitemParentId ?? "") === normalized.subitemParentId
    ));
  const pagesForContext: Record<string, Page> = { ...state.pagesById };
  for (const page of related) pagesForContext[page.id] = pagesForContext[page.id] ?? page;
  for (const row of baseRows) pagesForContext[row.id] = row;

  const effectiveView: DbView =
    view ?? ({ config: {}, databaseId: dbId, id: "", name: "", position: 0, type: "table" } as DbView);
  let filtered: Page[];
  try {
    filtered = applyView(baseRows, props, effectiveView, pagesForContext, {
      currentPageId: normalized.currentPageId || undefined,
      search: normalized.search || undefined,
    });
  } catch {
    return false;
  }

  useStore.setState((s) => {
    const current = s.databaseRowPagesByDb[dbId];
    if (current?.queryKey !== queryKey) return {};
    const pagesById = { ...s.pagesById };
    for (const page of related) pagesById[page.id] = pagesById[page.id] ?? page;
    filtered.forEach((row, index) => {
      pagesById[row.id] = remotePageWithOptimisticOverlay({
        ...row,
        __databaseRowOrder: index + 1,
      });
    });
    return {
      pagesById,
      databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [dbId]: filtered.map((row) => row.id) },
      databaseRowPagesByDb: {
        ...s.databaseRowPagesByDb,
        [dbId]: {
          queryKey,
          loadedCount: filtered.length,
          totalCount: filtered.length,
          hasMore: false,
          nextOffset: undefined,
          nextCursor: undefined,
          loading: false,
          loadingMore: false,
          error: undefined,
        },
      },
      loadedDbs: new Set(s.loadedDbs).add(dbId),
    };
  });
  return true;
}

async function hydrateDatabaseRowsFromCache(
  dbId: string,
  queryKey: string,
  options: { replaceVisibleRows?: boolean; signal?: AbortSignal } = {}
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const userId = outboxUserId();
  if (!userId || permanentDeleteIds(userId).has(dbId)) return false;
  // Per-view caches (Phase 3 v2): each first-page query caches under its own
  // key hash so offline view switching works beyond the last-used view.
  const keys = databaseRowCacheKeys(dbId, queryKey);
  const meta = await cacheGetMeta<CachedRowsMeta>(userId, keys.meta);
  if (!meta || meta.queryKey !== queryKey) return false;
  if (options.signal?.aborted) return false;
  const [rowRecords, relatedRecords, entries] = await Promise.all([
    cacheListTable<Page>(userId, keys.dataTable),
    cacheListTable<Page>(userId, keys.relatedPagesTable),
    outboxAllEntries(userId),
  ]);
  const deleted = permanentDeleteIds(userId);
  if (options.signal?.aborted) return false;
  lastHydratedRowsFeedStamp.set(dbId, meta.feedStamp ?? "");
  const rows = overlayOutboxOnPages(entries, rowRecords.map((record) => record.value)).filter(
    (page) => !deleted.has(page.id)
  );
  const related = overlayOutboxOnPages(entries, relatedRecords.map((record) => record.value)).filter(
    (page) => !deleted.has(page.id)
  );
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  // Never-show-partial: a cache that lost any listed row is not renderable —
  // fall through to the network (or the offline error state) instead of
  // silently showing a subset.
  const rowIds = meta.rowIds.filter((id) => !deleted.has(id));
  if (rowIds.some((id) => !rowsById.has(id))) return false;
  useStore.setState((s) => {
    if (options.signal?.aborted) return {};
    const current = s.databaseRowPagesByDb[dbId];
    if (current?.queryKey !== queryKey) return {};
    if (!options.replaceVisibleRows && (s.databaseRowIdsByDb[dbId] ?? []).length) return {};
    const pagesById = { ...s.pagesById };
    for (const page of related) {
      pagesById[page.id] = pagesById[page.id] ?? page;
    }
    rowIds.forEach((id, index) => {
      const row = rowsById.get(id);
      if (!row) return;
      pagesById[id] = remotePageWithOptimisticOverlay({
        ...row,
        __databaseRowOrder: index + 1,
      });
    });
    return {
      pagesById,
      databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [dbId]: rowIds },
      databaseRowPagesByDb: {
        ...s.databaseRowPagesByDb,
        [dbId]: {
          queryKey,
          loadedCount: rowIds.length,
          totalCount: meta.totalCount,
          hasMore: meta.hasMore,
          nextOffset: meta.nextOffset,
          nextCursor: meta.nextCursor,
          // The background refresh is still running; keep the loading flag so
          // consumers can show a refresh affordance without hiding rows.
          loading: true,
          loadingMore: false,
          error: undefined,
        },
      },
      loadedDbs: new Set(s.loadedDbs).add(dbId),
    };
  });
  return true;
}

// In-flight bootstrap promise so concurrent callers (StrictMode double-mount,
// multiple consumers) share one run instead of racing.
let bootPromise: Promise<void> | null = null;
let bootKey = "";
const databaseLoadPromises = new Map<string, Promise<void>>();
const databaseMetadataRevalidated = new Set<string>();
const databaseRowLoadMorePromises = new Map<string, Promise<void>>();
const databaseRowsQueryPromises = new Map<string, Promise<void>>();
// Multiple mutation events for the same forced row query share the active
// request, but at least one trailing request must run after it. Otherwise the
// shared response may predate the last mutation and become permanent state.
const databaseRowsForcedAgain = new Set<string>();
const DATABASE_INITIAL_ROW_LIMIT = 50;
const DATABASE_ROW_LOAD_MORE_LIMIT = 50;

export type DatabaseRowsQuery = {
  viewId?: string;
  search?: string;
  currentPageId?: string;
  /** Exact hierarchy window: "" selects roots, an id selects that parent's children. */
  subitemParentId?: string;
  force?: boolean;
  limit?: number;
  offset?: number;
  /** Opaque backend continuation; excluded from the durable query key. */
  cursor?: string;
  reset?: boolean;
  /** Ephemeral caller cancellation; excluded from the durable query key. */
  signal?: AbortSignal;
};

export type ConfigureDatabaseTaskFeatureOptions =
  | {
      databaseId: string;
      enabled: false;
      feature: "dependencies" | "subitems";
      propertyDisposition: "keep" | "remove";
    }
  | {
      childrenPropertyName: string;
      databaseId: string;
      enabled?: true;
      feature: "subitems";
      nestedPropertyId?: string;
      parentPropertyName: string;
      showToggleOnTitle?: boolean;
    }
  | ({
      avoidWeekends: boolean;
      databaseId: string;
      enabled?: true;
      feature: "dependencies";
      predecessorPropertyName: string;
      shiftMode: "overlap" | "maintain_spacing" | "none";
      successorPropertyName: string;
    } & (
      | {
          dateMode?: "range";
          datePropertyId: string;
        }
      | {
          dateMode: "separate";
          endDatePropertyId: string;
          startDatePropertyId: string;
        }
    ));

export type LoadDatabaseOptions = {
  force?: boolean;
  rows?: boolean;
  viewIds?: string[];
};

export type DatabaseRowPageState = {
  queryKey?: string;
  loadedCount: number;
  totalCount?: number;
  hasMore: boolean;
  nextOffset?: number;
  nextCursor?: string;
  loading?: boolean;
  loadingMore?: boolean;
  error?: string;
};

export type DatabaseSubitemRowWindow = DatabaseRowPageState & {
  rowIds: string[];
};

export type DatabaseDependencyPendingMutation = {
  addRelatedRowIds: string[];
  mutationId: string;
  removeRelatedRowIds: string[];
};

export type DatabaseDependencyRelationState = {
  canonicalRelatedRowIds: string[];
  databaseId: string;
  dependencyRevision: number;
  direction: DatabaseDependencyDirection;
  error?: string;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  nextCursor?: string;
  pendingMutations: DatabaseDependencyPendingMutation[];
  propertyId: string;
  relatedRowIds: string[];
  rowId: string;
};

function databaseDependencyRelationKey(rowId: string, propertyId: string) {
  return `${rowId}\u001f${propertyId}`;
}

function applyDependencyRelationPending(
  canonicalIds: string[],
  pendingMutations: DatabaseDependencyPendingMutation[],
) {
  const ids = canonicalIds.slice();
  const present = new Set(ids);
  for (const pending of pendingMutations) {
    for (const id of pending.removeRelatedRowIds) {
      present.delete(id);
    }
    for (const id of pending.addRelatedRowIds) {
      if (!present.has(id)) ids.push(id);
      present.add(id);
    }
  }
  return ids.filter((id) => present.has(id));
}

function mergeDatabaseDependencyRelationAuthority(
  result: DatabaseDependencyRelationResult,
  options: { append?: boolean; settledMutationId?: string } = {},
) {
  useStore.setState((state) => {
    const key = databaseDependencyRelationKey(result.rowId, result.propertyId);
    const current = state.databaseDependencyRelations[key];
    const pendingMutations = (current?.pendingMutations ?? []).filter(
      (pending) => pending.mutationId !== options.settledMutationId
    );
    const canAppend = options.append === true
      && current?.dependencyRevision === result.dependencyRevision;
    const incomingCanonical = canAppend
      ? Array.from(new Set([
          ...(current?.canonicalRelatedRowIds ?? []),
          ...result.relatedRowIds,
        ]))
      : result.relatedRowIds;
    const keepNewer = !!current
      && current.dependencyRevision > result.dependencyRevision;
    const canonicalRelatedRowIds = keepNewer
      ? current.canonicalRelatedRowIds
      : incomingCanonical;
    const hydratedRelationTargetIds = new Set(state.hydratedRelationTargetIds);
    for (const id of result.relatedRowIds) hydratedRelationTargetIds.add(id);
    return {
      databaseDependencyRelations: {
        ...state.databaseDependencyRelations,
        [key]: {
          canonicalRelatedRowIds,
          databaseId: result.databaseId,
          dependencyRevision: keepNewer
            ? current.dependencyRevision
            : result.dependencyRevision,
          direction: result.direction,
          hasMore: keepNewer ? current.hasMore : result.hasMore,
          loaded: true,
          loading: false,
          loadingMore: false,
          ...(keepNewer
            ? (current.nextCursor ? { nextCursor: current.nextCursor } : {})
            : (result.nextCursor ? { nextCursor: result.nextCursor } : {})),
          pendingMutations,
          propertyId: result.propertyId,
          relatedRowIds: applyDependencyRelationPending(
            canonicalRelatedRowIds,
            pendingMutations,
          ),
          rowId: result.rowId,
        },
      },
      hydratedRelationTargetIds,
    };
  });
}

function dropDatabaseDependencyPendingMutation(
  rowId: string,
  propertyId: string,
  mutationId: string,
) {
  useStore.setState((state) => {
    const key = databaseDependencyRelationKey(rowId, propertyId);
    const current = state.databaseDependencyRelations[key];
    if (!current) return {};
    const pendingMutations = current.pendingMutations.filter(
      (pending) => pending.mutationId !== mutationId
    );
    return {
      databaseDependencyRelations: {
        ...state.databaseDependencyRelations,
        [key]: {
          ...current,
          loading: false,
          loadingMore: false,
          pendingMutations,
          relatedRowIds: applyDependencyRelationPending(
            current.canonicalRelatedRowIds,
            pendingMutations,
          ),
        },
      },
    };
  });
}

function pruneDatabaseDependencyRelations(
  current: Record<string, DatabaseDependencyRelationState>,
  deletedIds: Set<string>,
) {
  return Object.fromEntries(Object.entries(current).filter(([, relation]) => (
    !deletedIds.has(relation.databaseId)
    && !deletedIds.has(relation.rowId)
    && !deletedIds.has(relation.propertyId)
  )));
}

function pruneDatabaseSubitemRowWindows(
  current: Record<string, Record<string, DatabaseSubitemRowWindow>>,
  deletedIds: Set<string>
) {
  const next: Record<string, Record<string, DatabaseSubitemRowWindow>> = {};
  for (const [databaseId, byParent] of Object.entries(current)) {
    if (deletedIds.has(databaseId)) continue;
    const retained: Record<string, DatabaseSubitemRowWindow> = {};
    for (const [parentId, window] of Object.entries(byParent)) {
      if (deletedIds.has(parentId)) continue;
      const rowIds = window.rowIds.filter((rowId) => !deletedIds.has(rowId));
      const removedCount = window.rowIds.length - rowIds.length;
      retained[parentId] = {
        ...window,
        rowIds,
        loadedCount: Math.max(0, window.loadedCount - removedCount),
        ...(typeof window.totalCount === "number"
          ? { totalCount: Math.max(0, window.totalCount - removedCount) }
          : {}),
      };
    }
    if (Object.keys(retained).length > 0) next[databaseId] = retained;
  }
  return next;
}

function databaseRowPageSatisfiesInitialLoad(
  current: DatabaseRowPageState | undefined,
  queryKey: string,
  limit: number
) {
  if (!current || current.queryKey !== queryKey || current.error) return false;
  // An actual duplicate request is returned from databaseRowsQueryPromises
  // before this helper runs. A loading flag without that matching promise is
  // orphaned state (for example after competing base/view queries supersede
  // one another) and must be retried instead of leaving the table permanently
  // aria-busy.
  if (current.loading || current.loadingMore) return false;
  if (current.totalCount !== undefined) {
    return current.loadedCount >= Math.min(limit, current.totalCount);
  }
  if (current.loadedCount === 0) {
    return current.hasMore === false || typeof current.nextCursor === "string";
  }
  return current.loadedCount > 0 && (current.loadedCount >= limit || current.hasMore === false);
}

function normalizeDatabaseRowsQuery(query: DatabaseRowsQuery = {}) {
  return {
    viewId: query.viewId?.trim() || "",
    search: query.search?.trim() || "",
    currentPageId: query.currentPageId?.trim() || "",
    subitemParentId:
      typeof query.subitemParentId === "string"
        ? query.subitemParentId.trim()
        : null,
  };
}

export function databaseRowsQueryKey(query: DatabaseRowsQuery = {}) {
  return JSON.stringify(normalizeDatabaseRowsQuery(query));
}

type RecentDatabaseRowsQuery = {
  authorityGeneration: number;
  databaseId: string;
  dataEpoch: number;
  page: DatabaseRowPageState;
  propsSource: DbProperty[] | undefined;
  queryKey: string;
  rowIds: string[];
  scopeKey: string;
  viewsSource: DbView[] | undefined;
};

const MAX_RECENT_DATABASE_ROW_QUERIES_PER_DB = 3;
const MAX_RECENT_DATABASE_ROW_QUERY_COUNT = 256;
const MAX_RECENT_DATABASE_ROW_IDS = 50_000;
const recentDatabaseRowsQueries = new Map<string, RecentDatabaseRowsQuery>();
const recentDatabaseRowsAuthority = new Map<string, number>();
let recentDatabaseRowsQueryIdCount = 0;
let recentDatabaseRowsAuthorityClock = 0;
let recentDatabaseRowsAuthorityBase = 0;

function recentDatabaseRowsQueryMapKey(databaseId: string, queryKey: string) {
  return JSON.stringify([databaseId, queryKey]);
}

function recentDatabaseRowsScopeKey(
  state: Pick<AppState, "activeDataScope" | "userId" | "workspace">
) {
  const scope = state.activeDataScope;
  const mountedScope = scope
    ? scope.kind === "public_share"
      ? `public:${scope.workspaceId}:${scope.shareKey}`
      : `workspace:${scope.workspaceId}`
    : `workspace:${state.workspace?.id ?? ""}`;
  return `${state.userId ?? ""}:${mountedScope}`;
}

function deleteRecentDatabaseRowsQuery(mapKey: string) {
  const snapshot = recentDatabaseRowsQueries.get(mapKey);
  if (!snapshot) return;
  recentDatabaseRowsQueryIdCount -= snapshot.rowIds.length;
  recentDatabaseRowsQueries.delete(mapKey);
}

function resetRecentDatabaseRowsQueries() {
  recentDatabaseRowsQueries.clear();
  recentDatabaseRowsAuthority.clear();
  recentDatabaseRowsQueryIdCount = 0;
  recentDatabaseRowsAuthorityClock = 0;
  recentDatabaseRowsAuthorityBase = 0;
}

function clearRecentDatabaseRowsQueries(databaseId?: string) {
  if (databaseId === undefined) {
    recentDatabaseRowsQueries.clear();
    recentDatabaseRowsQueryIdCount = 0;
    recentDatabaseRowsAuthorityClock += 1;
    recentDatabaseRowsAuthorityBase = recentDatabaseRowsAuthorityClock;
    recentDatabaseRowsAuthority.clear();
    return;
  }
  recentDatabaseRowsAuthorityClock += 1;
  recentDatabaseRowsAuthority.set(databaseId, recentDatabaseRowsAuthorityClock);
  for (const [mapKey, snapshot] of recentDatabaseRowsQueries) {
    if (snapshot.databaseId === databaseId) deleteRecentDatabaseRowsQuery(mapKey);
  }
}

function currentDatabaseRowsAuthority(databaseId: string) {
  return recentDatabaseRowsAuthority.get(databaseId) ?? recentDatabaseRowsAuthorityBase;
}

function cacheRecentDatabaseRowsQuery(
  databaseId: string,
  queryKey: string,
  state: Pick<
    AppState,
    | "activeDataScope"
    | "databaseRowIdsByDb"
    | "databaseRowPagesByDb"
    | "pagesById"
    | "propsByDb"
    | "userId"
    | "viewsByDb"
    | "workspace"
  >,
  expectedAuthorityGeneration: number,
  expectedPropsSource: DbProperty[] | undefined,
  expectedViewsSource: DbView[] | undefined
) {
  const page = state.databaseRowPagesByDb[databaseId];
  const rowIds = state.databaseRowIdsByDb[databaseId] ?? [];
  if (
    !page ||
    page.queryKey !== queryKey ||
    page.loading ||
    page.loadingMore ||
    page.error ||
    currentDatabaseRowsAuthority(databaseId) !== expectedAuthorityGeneration ||
    state.propsByDb[databaseId] !== expectedPropsSource ||
    state.viewsByDb[databaseId] !== expectedViewsSource ||
    rowIds.length > MAX_RECENT_DATABASE_ROW_IDS ||
    rowIds.some((rowId) => {
      const row = state.pagesById[rowId];
      return !row || row.parentType !== "database" || row.parentId !== databaseId;
    })
  ) {
    return;
  }

  const mapKey = recentDatabaseRowsQueryMapKey(databaseId, queryKey);
  deleteRecentDatabaseRowsQuery(mapKey);
  const snapshot: RecentDatabaseRowsQuery = {
    authorityGeneration: expectedAuthorityGeneration,
    databaseId,
    dataEpoch: workspaceDataEpoch,
    page: { ...page, loading: false, loadingMore: false, error: undefined },
    propsSource: expectedPropsSource,
    queryKey,
    rowIds: rowIds.slice(),
    scopeKey: recentDatabaseRowsScopeKey(state),
    viewsSource: expectedViewsSource,
  };
  recentDatabaseRowsQueries.set(mapKey, snapshot);
  recentDatabaseRowsQueryIdCount += snapshot.rowIds.length;

  const databaseSnapshotKeys = Array.from(recentDatabaseRowsQueries)
    .filter(([, candidate]) => candidate.databaseId === databaseId)
    .map(([candidateKey]) => candidateKey);
  while (databaseSnapshotKeys.length > MAX_RECENT_DATABASE_ROW_QUERIES_PER_DB) {
    const oldestDatabaseKey = databaseSnapshotKeys.shift();
    if (oldestDatabaseKey !== undefined) deleteRecentDatabaseRowsQuery(oldestDatabaseKey);
  }
  while (
    recentDatabaseRowsQueries.size > MAX_RECENT_DATABASE_ROW_QUERY_COUNT ||
    recentDatabaseRowsQueryIdCount > MAX_RECENT_DATABASE_ROW_IDS
  ) {
    const oldestKey = recentDatabaseRowsQueries.keys().next().value;
    if (oldestKey === undefined) break;
    deleteRecentDatabaseRowsQuery(oldestKey);
  }
}

function readRecentDatabaseRowsQuery(
  databaseId: string,
  queryKey: string,
  limit: number,
  state: Pick<
    AppState,
    | "activeDataScope"
    | "pagesById"
    | "propsByDb"
    | "userId"
    | "viewsByDb"
    | "workspace"
  >
) {
  const mapKey = recentDatabaseRowsQueryMapKey(databaseId, queryKey);
  const snapshot = recentDatabaseRowsQueries.get(mapKey);
  if (!snapshot) return undefined;
  if (
    snapshot.dataEpoch !== workspaceDataEpoch ||
    snapshot.scopeKey !== recentDatabaseRowsScopeKey(state) ||
    snapshot.authorityGeneration !== currentDatabaseRowsAuthority(databaseId) ||
    snapshot.propsSource !== state.propsByDb[databaseId] ||
    snapshot.viewsSource !== state.viewsByDb[databaseId] ||
    !databaseRowPageSatisfiesInitialLoad(snapshot.page, queryKey, limit) ||
    snapshot.rowIds.some((rowId) => {
      const row = state.pagesById[rowId];
      return !row || row.parentType !== "database" || row.parentId !== databaseId;
    })
  ) {
    deleteRecentDatabaseRowsQuery(mapKey);
    return undefined;
  }
  recentDatabaseRowsQueries.delete(mapKey);
  recentDatabaseRowsQueries.set(mapKey, snapshot);
  return { page: { ...snapshot.page }, rowIds: snapshot.rowIds.slice() };
}

function appendUniqueIds(current: string[], additions: string[]) {
  const seen = new Set(current);
  const next = current.slice();
  for (const id of additions) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

function cleanUniqueIds(ids: string[] | undefined) {
  if (!ids?.length) return [];
  return ids.filter((id, index) => id.trim().length > 0 && ids.indexOf(id) === index);
}

function mergeById<T extends { id: string; position: number }>(current: T[] | undefined, incoming: T[]) {
  const byId = new Map<string, T>();
  for (const item of current ?? []) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values()).sort(bySortPos);
}

function databaseRowsLoadErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (/401|unauthorized|authentication|required|not authenticated|session/i.test(message)) {
    return storeMessages().sessionExpired;
  }
  return storeMessages().databaseRowsLoadFailed;
}

function moveIdRelative(ids: string[], rowId: string, targetId: string, side: "before" | "after") {
  if (rowId === targetId) return ids;
  const next = ids.filter((id) => id !== rowId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return ids;
  next.splice(targetIndex + (side === "after" ? 1 : 0), 0, rowId);
  return next;
}

function normalizeWorkspaceSlug(value: string | undefined | null) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function bootstrapInputKey(input: WorkspaceBootstrapInput = {}) {
  const workspaceId = input.workspaceId?.trim();
  const slug = normalizeWorkspaceSlug(input.workspaceSlug);
  const pageId = input.pageId?.trim();
  const workspaceKey = workspaceId ? `workspace-id:${workspaceId}` : slug ? `workspace:${slug}` : "";
  if (pageId) return `${workspaceKey ? `${workspaceKey}:` : ""}page:${pageId}`;
  if (workspaceKey) return workspaceKey;
  return slug ? `workspace:${slug}` : "default";
}

type OrganizationStateResult = (OrganizationDirectoryResult | WorkspaceMembersResult) & {
  organizations?: Organization[];
};

export type RowFileRemovalStatus = "dropped" | "ignored" | "ok" | "queued";

export interface AppState {
  ready: boolean;
  /** Definitive server denial for the route whose bootstrap was rejected.
   *  Kept in the store so a cache discard/remount cannot fall back to an
   *  indefinite loading screen before AppShell receives the rejected promise. */
  bootstrapFailure?: {
    message: string;
    status?: number;
    pageId?: string;
    workspaceSlug?: string;
  };
  /** True when mutations keep failing while the browser reports online —
   *  i.e. the server is unreachable (dead wifi, server down). */
  syncDegraded: boolean;
  /** Mobile drawer open state (overlay sidebar). */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  /** Desktop sidebar collapsed state. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Global quick-find modal state. */
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  /** Global updates inbox state. */
  updatesOpen: boolean;
  setUpdatesOpen: (open: boolean) => void;
  /** Small global status toasts for Notion-inspired action feedback. */
  toasts: ToastMessage[];
  notify: (message: string, tone?: ToastMessage["tone"], action?: ToastMessage["action"]) => string;
  dismissToast: (id: string) => void;
  /** Just-created page focus target, matching Notion's title/body handoff. */
  focusPageId?: string;
  focusPageTarget?: FocusPageTarget;
  setFocusPageId: (id?: string, target?: FocusPageTarget) => void;
  workspace?: Workspace;
  /** Which authority produced the records currently mounted in the shared maps. */
  activeDataScope?:
    | {
        kind: "workspace";
        membershipAuthority: "cached" | "fresh";
        workspaceId: string;
      }
    | { kind: "public_share"; shareKey: string; workspaceId: string };
  workspaces: Workspace[];
  /** Whether the signed-in account is an instance administrator (server console). */
  isInstanceAdmin: boolean;
  organization?: Organization | null;
  organizations: Organization[];
  currentOrganizationMember?: OrganizationMember | null;
  organizationMembers: OrganizationMember[];
  organizationGroups: OrganizationGroup[];
  organizationProfiles: OrganizationProfile[];
  organizationDomains: OrganizationDomain[];
  organizationAuditEvents: OrganizationAuditEvent[];
  enterpriseControls?: OrganizationEnterpriseControls;
  organizationScimTokens: OrganizationScimToken[];
  organizationLegalHolds: OrganizationLegalHold[];
  organizationAuditExports: OrganizationAuditExport[];
  organizationDiscoveryExports: OrganizationDiscoveryExport[];
  organizationBillingRecords: OrganizationBillingRecord[];
  applyOrganizationDirectory: (directory: OrganizationStateResult) => void;
  updateWorkspace: (patch: Partial<Workspace>) => Promise<Workspace | undefined>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;
  deleteWorkspace: (workspaceId: string, input?: DeleteWorkspaceInput) => Promise<Workspace | undefined>;
  switchWorkspace: (workspaceId: string) => Promise<Workspace | undefined>;
  userId?: string;
  currentMember?: WorkspaceMember;
  workspaceMembers: WorkspaceMember[];
  applyWorkspaceMembers: (members: WorkspaceMember[], currentMember?: WorkspaceMember) => void;
  teamspaces: Teamspace[];
  discoverableTeamspaces: Teamspace[];
  teamspaceSettings?: TeamspaceSettings;
  pagesById: Record<string, Page>;
  pageRolesById: Record<string, ShareRole>;
  sharedPageIds: Set<string>;
  recentPageIds: string[];
  treeExpandedPageIds: Set<string>;
  setTreePageExpanded: (pageId: string, expanded: boolean) => void;
  blocksByPage: Record<string, Block[]>;
  loadedBlockPages: Set<string>;
  blockHistoryByPage: Record<string, BlockHistory>;
  commentsByPage: Record<string, Comment[]>;
  loadedCommentPages: Set<string>;
  commentPanel?: {
    pageId: string;
    blockId?: string | null;
    activeCommentId?: string;
    quote?: string;
    quoteStart?: number;
    quoteEnd?: number;
  };
  openComments: (
    pageId: string,
    blockId?: string | null,
    opts?: { activeCommentId?: string; quote?: string; quoteStart?: number; quoteEnd?: number }
  ) => void;
  closeComments: () => void;

  bootstrap: (input?: WorkspaceBootstrapInput) => Promise<void>;

  // pages ---------------------------------------------------------------
  childPages: (parentId: string | null) => Page[];
  recentPages: () => Page[];
  recordPageVisit: (id: string) => void;
  favoritePages: () => Page[];
  trashedPages: () => Page[];
  createPage: (opts: {
    parentId: string | null;
    parentType: PageParentType;
    teamspaceId?: string | null;
    title?: string;
    kind?: PageKind;
    afterPosition?: number;
    beforePosition?: number;
    focusTarget?: FocusPageTarget;
    focusTitle?: boolean;
  }) => Promise<Page>;
  applyRemotePage: (page: Page) => Promise<void>;
  applyRemotePagePatch: (id: string, patch: Partial<Page>) => void;
  refreshWorkspacePages: () => Promise<void>;
  refreshPageAccess: (pageId: string) => Promise<void>;
  applySharedPageSnapshot: (snapshot: SharedPageResult, shareKey: string) => void;
  updatePage: (
    id: string,
    patch: Partial<Page>,
    opts?: { debounce?: boolean; debounceMs?: number }
  ) => void;
  trashPage: (id: string) => Promise<void>;
  restorePage: (id: string) => Promise<void>;
  canPermanentlyDeletePage: (id: string) => boolean;
  deletePage: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  duplicatePage: (id: string) => Promise<Page | null>;
  toggleFavorite: (id: string) => Promise<void>;
  movePage: (
    id: string,
    newParentId: string | null,
    newParentType: PageParentType,
    position: number
  ) => Promise<void>;

  // blocks --------------------------------------------------------------
  loadBlocks: (pageId: string, opts?: { force?: boolean }) => Promise<void>;
  topLevelBlocks: (pageId: string) => Block[];
  childBlocks: (pageId: string, parentId: string) => Block[];
  createBlock: (opts: {
    pageId: string;
    parentId?: string | null;
    type?: BlockType;
    content?: BlockContent;
    position: number;
    history?: BlockHistoryMode | false;
  }) => Promise<Block>;
  /** Synchronous optimistic block insert (persists in the background). Returns
   *  the block immediately so callers can flushSync + focus it without waiting
   *  on the network. */
  addBlockLocal: (opts: {
    pageId: string;
    parentId?: string | null;
    type?: BlockType;
    content?: BlockContent;
    plainText?: string;
    position: number;
    history?: BlockHistoryMode | false;
    deferPersistUntilMutation?: boolean;
    persist?: boolean;
  }) => Block;
  /**
   * Persist a group of already-inserted optimistic blocks as one causally
   * ordered, durable outbox operation. Batch-building UI paths use
   * `addBlockLocal({ persist: false })` only while assembling the complete
   * parent/child graph, then hand the graph to this action before returning
   * control to the browser.
   */
  persistBlockCreateBatch: (blocks: Block[]) => Promise<void>;
  updateBlock: (
    id: string,
    patch: Partial<Block>,
    opts?: {
      debounce?: boolean;
      debounceMs?: number;
      history?: BlockHistoryMode | false;
      pageId?: string;
    }
  ) => void;
  applyRemoteBlockText: (
    id: string,
    patch: Pick<Partial<Block>, "content" | "plainText" | "updatedAt">
  ) => void;
  deleteBlock: (id: string, opts?: { history?: BlockHistoryMode | false }) => Promise<void>;
  moveBlockToPage: (id: string, targetPageId: string) => Promise<void>;
  copyBlockToPage: (id: string, targetPageId: string) => Promise<Block | undefined>;
  captureBlockHistory: (pageId: string, mode?: BlockHistoryMode) => void;
  captureBlockStructureHistory: (
    pageId: string,
    operation: Omit<BlockStructureHistoryOperation, "pageId" | "occurredAt"> & {
      pageId?: string;
      occurredAt?: string;
    },
    mode?: BlockHistoryMode
  ) => void;
  undoBlockChange: (pageId: string) => Promise<boolean>;
  redoBlockChange: (pageId: string) => Promise<boolean>;
  runPageButton: (
    pageId: string,
    blockId: string,
    confirmationToken?: string,
  ) => Promise<import("./edgebase").ExecutePageButtonResult | undefined>;
  discardPageButtonExecution: (pageId: string, blockId: string) => void;

  // comments ------------------------------------------------------------
  loadComments: (pageId: string, opts?: { force?: boolean }) => Promise<void>;
  refreshCommentsFromSignal: (pageId: string) => Promise<void>;
  pageComments: (pageId: string) => Comment[];
  addComment: (
    pageId: string,
    text: string,
    blockId?: string | null,
    parentId?: string | null,
    opts?: { quote?: string; quoteStart?: number; quoteEnd?: number; rich?: TextSpan[] }
  ) => Promise<Comment>;
  updateComment: (id: string, patch: Partial<Comment>) => void;
  /** Delete a comment (and its replies when it's a thread root). */
  deleteComment: (id: string) => void;

  // databases ----------------------------------------------------------
  propsByDb: Record<string, DbProperty[]>;
  viewsByDb: Record<string, DbView[]>;
  templatesByDb: Record<string, DbTemplate[]>;
  loadedDbs: Set<string>;
  databaseRowIdsByDb: Record<string, string[]>;
  databaseRowPagesByDb: Record<string, DatabaseRowPageState>;
  databaseSubitemRowWindowsByDb: Record<
    string,
    Record<string, DatabaseSubitemRowWindow>
  >;
  databaseDependencyRelations: Record<string, DatabaseDependencyRelationState>;
  hydratedRelationTargetIds: Set<string>;
  databaseDependencyRelation: (
    rowId: string,
    propertyId: string
  ) => DatabaseDependencyRelationState | undefined;
  loadDatabaseDependencyRelation: (
    rowId: string,
    propertyId: string,
    options?: { append?: boolean; force?: boolean }
  ) => Promise<void>;
  loadDatabase: (dbId: string, options?: LoadDatabaseOptions) => Promise<void>;
  loadDatabaseRows: (dbId: string, query?: DatabaseRowsQuery) => Promise<void>;
  loadMoreDatabaseRows: (dbId: string, query?: DatabaseRowsQuery) => Promise<void>;
  loadDatabaseSubitemRows: (
    dbId: string,
    parentId: string,
    query?: DatabaseRowsQuery
  ) => Promise<void>;
  loadMoreDatabaseSubitemRows: (
    dbId: string,
    parentId: string,
    query?: DatabaseRowsQuery
  ) => Promise<void>;
  warmDatabaseRowDetail: (dbId: string, rowId: string) => void;
  dbProperties: (dbId: string) => DbProperty[];
  dbViews: (dbId: string) => DbView[];
  dbTemplates: (dbId: string) => DbTemplate[];
  dbRows: (dbId: string) => Page[];
  createDatabase: (opts: {
    parentId: string | null;
    parentType: PageParentType;
    title?: string;
    afterPosition?: number;
    viewType?: Extract<ViewType, "table" | "board" | "list" | "gallery" | "calendar" | "timeline">;
    /** Explicitly opt in to three durable starter rows. Omission creates none. */
    seedRows?: boolean;
    properties?: Parameters<typeof createDatabaseRemote>[0]["properties"];
  }) => Promise<Page>;
  configureDatabaseTaskFeature: (
    input: ConfigureDatabaseTaskFeatureOptions
  ) => Promise<"dropped" | "ok" | "queued">;
  runDatabaseButton: (
    rowId: string,
    propertyId: string,
    confirmationToken?: string,
  ) => Promise<import("./edgebase").ExecuteDatabaseButtonResult | undefined>;
  discardDatabaseButtonExecution: (rowId: string, propertyId: string) => void;
  addProperty: (
    dbId: string,
    type: PropertyType,
    name: string,
    config?: PropertyConfig
  ) => Promise<DbProperty | null>;
  updateProperty: (id: string, patch: Partial<DbProperty>) => void;
  // Change a relation property's target database. Tears down an existing
  // two-way pair (→ one-way) before repointing, then updates the target.
  setRelationDatabase: (id: string, targetDatabaseId: string) => Promise<void>;
  // Toggle Notion-style two-way ("Show on …") relations: create/link a
  // reciprocal relation property on the target database, or delete + unlink it.
  setRelationTwoWay: (id: string, enabled: boolean, reciprocalName?: string) => Promise<void>;
  deleteProperty: (
    id: string,
    opts?: { skipReciprocal?: boolean }
  ) => Promise<DeletedPropertySnapshot | null>;
  restoreDeletedProperty: (snapshot: DeletedPropertySnapshot) => Promise<boolean>;
  deletePropertyOption: (propertyId: string, optionId: string) => Promise<DeletedPropertyOptionSnapshot | null>;
  restoreDeletedPropertyOption: (snapshot: DeletedPropertyOptionSnapshot) => Promise<boolean>;
  addView: (
    dbId: string,
    type: ViewType,
    name?: string,
    opts?: { config?: ViewConfig; position?: number }
  ) => Promise<DbView | null>;
  updateView: (id: string, patch: Partial<DbView>) => void;
  /** Apply a server-owned compound mutation result without issuing a second write. */
  applyConfiguredView: (view: DbView) => void;
  deleteView: (id: string) => Promise<DbView | null>;
  restoreDeletedView: (view: DbView) => Promise<boolean>;
  addTemplate: (dbId: string, name?: string) => Promise<DbTemplate | null>;
  duplicateTemplate: (id: string) => Promise<DbTemplate | null>;
  updateTemplate: (id: string, patch: Partial<DbTemplate>) => Promise<boolean>;
  deleteTemplate: (id: string) => Promise<DbTemplate | null>;
  restoreDeletedTemplate: (template: DbTemplate) => Promise<boolean>;
  addRow: (
    dbId: string,
    atEnd?: boolean,
    templateId?: string,
    opts?: { focusTitle?: boolean }
  ) => Promise<Page>;
  moveDatabaseRow: (rowId: string, targetId: string, side: "before" | "after") => Promise<Page | undefined>;
  reparentDatabaseSubitem: (rowId: string, targetParentId: string) => Promise<Page | undefined>;
  setRowProperty: (
    rowId: string,
    propId: string,
    value: unknown,
    opts?: { debounce?: boolean }
  ) => void;
  removeRowFilePropertyItem: (input: {
    expectedStorageKey?: string;
    fileId: string;
    propertyId: string;
    rowId: string;
  }) => Promise<RowFileRemovalStatus>;
  addDatabaseDependency: (
    rowId: string,
    predecessorRowId: string
  ) => Promise<"dropped" | "ok" | "queued" | undefined>;
  setRelation: (
    rowId: string,
    prop: DbProperty,
    nextIds: string[]
  ) => Promise<"dropped" | "ok" | "queued" | undefined>;
}

function canEditPageInState(state: AppState, page: Page | undefined, userId = state.userId) {
  if (state.activeDataScope?.kind === "public_share") return false;
  return canEditPage({
    page,
    pagesById: state.pagesById,
    pageRoles: state.pageRolesById,
    workspace: state.workspace,
    currentMember: state.currentMember,
    userId,
  });
}

function withoutLoadedDatabaseProperty(state: AppState, databaseId: string, propertyId: string) {
  const properties = (state.propsByDb[databaseId] ?? [])
    .filter((property) => property.id !== propertyId)
    .map((property) => {
      const config = { ...(property.config ?? {}) };
      let changed = false;
      if (config.rollupRelationPropertyId === propertyId) {
        config.rollupRelationPropertyId = undefined;
        config.rollupTargetPropertyId = undefined;
        changed = true;
      }
      if (config.rollupTargetPropertyId === propertyId) {
        config.rollupTargetPropertyId = undefined;
        changed = true;
      }
      return changed ? { ...property, config } : property;
    });
  const pagesById = { ...state.pagesById };
  for (const rowId of state.databaseRowIdsByDb[databaseId] ?? []) {
    const row = pagesById[rowId];
    if (!row?.properties || !(propertyId in row.properties)) continue;
    const rowProperties = { ...row.properties };
    delete rowProperties[propertyId];
    pagesById[rowId] = { ...row, properties: rowProperties };
  }
  return {
    pagesById,
    propsByDb: { ...state.propsByDb, [databaseId]: properties },
    templatesByDb: {
      ...state.templatesByDb,
      [databaseId]: (state.templatesByDb[databaseId] ?? []).map((template) => {
        if (!template.properties || !(propertyId in template.properties)) return template;
        const templateProperties = { ...template.properties };
        delete templateProperties[propertyId];
        return { ...template, properties: templateProperties };
      }),
    },
    viewsByDb: {
      ...state.viewsByDb,
      [databaseId]: (state.viewsByDb[databaseId] ?? []).map((view) => ({
        ...view,
        config: viewConfigWithoutProperty(view.config, propertyId),
      })),
    },
  };
}

function canCommentPageInState(state: AppState, page: Page | undefined, userId = state.userId) {
  if (state.activeDataScope?.kind === "public_share") return false;
  return canCommentPage({
    page,
    pagesById: state.pagesById,
    pageRoles: state.pageRolesById,
    workspace: state.workspace,
    currentMember: state.currentMember,
    userId,
  });
}

function canPermanentlyDeletePageInState(
  state: AppState,
  page: Page | undefined,
  userId = state.userId
) {
  if (state.activeDataScope?.kind === "public_share" || !page?.inTrash) return false;
  return canManagePage({
    page,
    pagesById: state.pagesById,
    pageRoles: state.pageRolesById,
    workspace: state.workspace,
    currentMember: state.currentMember,
    userId,
  });
}

function canCreatePageInState(
  state: AppState,
  parentId: string | null | undefined,
  userId = state.userId,
  teamspaceId?: string | null
) {
  if (state.activeDataScope?.kind === "public_share") return false;
  if (parentId) {
    return canEditPageInState(state, state.pagesById[parentId], userId);
  }
  if (teamspaceId) {
    const teamspace = [...state.teamspaces, ...state.discoverableTeamspaces]
      .find((candidate) => candidate.id === teamspaceId);
    if (teamspace?.role === "owner") return true;
    if (teamspace?.role !== "member" || teamspace.membersCanEditSidebar === false) return false;
    const role = teamspace.memberPageRole;
    return role === "edit" || role === "full_access";
  }
  return canCreateWorkspacePage({
    workspace: state.workspace,
    currentMember: state.currentMember,
    userId,
  });
}

const pageStoreRuntime = {
  RECENT_LIMIT,
  activePersistentGeneratedLabels,
  bootstrapWorkspace,
  bySortPos,
  canCreatePageInState,
  canEditPageInState,
  canPermanentlyDeletePageInState,
  cancelPendingBlock,
  cancelPendingBlockCreate,
  cancelPendingPage,
  clearOfflineWorkspaceFileCache,
  collectPageSubtree,
  createBlocksRemote,
  createPageRemote,
  createPropertyRemote,
  createTemplateRemote,
  createViewRemote,
  currentRelativeRouteHref,
  deleteDatabaseRowRemote,
  deletePageRemote,
  duplicatePageRemote,
  durableRemoteCall,
  ensureAuth,
  flushPage,
  getDatabaseSnapshotRemote,
  getPageBlocksRemote,
  hasTrashedAncestor,
  isKoreanLocale,
  isPageParentLocked,
  isTemplateEditorPageId,
  lockedPageAllowsPatch,
  markPermanentDeleteCacheCleanupPending,
  materializeOutboxEffects,
  mirrorPendingPage,
  newId,
  nowIso,
  optimisticPageOverlays,
  outboxAllEntries,
  overlayOutboxOnPages,
  pageDisplayTitle,
  pageTimers,
  pendingBlockCreate,
  pendingBlockPage,
  pendingPage,
  pendingPageBase,
  pendingPageBefore,
  pendingPageExpectedMutationId,
  pendingPageMutationId,
  inFlightPageMutationId,
  inFlightPagePatch,
  persistPageCreate,
  persistablePagePatch,
  positionBetween,
  reconcilePersistedPageMutation: reconcilePersistedPageMutations,
  recordCacheClear,
  remapBlockContent,
  remapViewConfigPropertyIds,
  rememberPermanentDeleteIds,
  remotePageWithOptimisticOverlay,
  setWorkspacePeople,
  storeMessages,
  stripComputedFromPages,
  advanceWorkspaceDataEpoch,
  clearRecentDatabaseRowsQueries,
  writeRecentPageIds,
  writeTreeExpandedPageIds,
};
export type PageStoreRuntime = typeof pageStoreRuntime;

const blockStoreRuntime = {
  EMPTY_BLOCK_LIST,
  HISTORY_LIMIT,
  MERGE_WINDOW_MS,
  blockStructureInvalidation,
  blockLoadPromises,
  blockStructureSources,
  blocksCacheFresh,
  byCreated,
  bySortPos,
  applyEmbeddedDatabaseSnapshots,
  cacheCurrentComments,
  cacheReplaceTable,
  cacheSetMeta,
  cancelPendingBlock,
  childBlocksCache,
  cloneBlocks,
  consumeLinkedTwin,
  canEditPageInState,
  durableRemoteCall,
  ensureAuth,
  executePageButtonRemote,
  firstDroppedDurableCall,
  flushBlock,
  getPageBlocksRemote,
  getPageCommentsRemote,
  historyOperationTarget,
  hydrateBlocksFromCache,
  inferStructureAction,
  isStructureOnlyPatch,
  isTemplateEditorPageId,
  mirrorPendingBlock,
  newId,
  nowIso,
  optimisticBlockOverlays,
  outboxAllEntries,
  outboxUserId,
  overlayOutboxOnBlocks,
  pendingBlock,
  pendingBlockBase,
  pendingBlockCreate,
  pendingBlockExpectedMutationId,
  pendingBlockMutationId,
  pendingBlockPage,
  inFlightBlockMutationId,
  pendingPageLikeCreateHas,
  permanentDeleteIds,
  persistErrorStatus,
  persistBlockCreate,
  persistBlockDelete,
  persistBlockSnapshot,
  persistBlockStructureOperation,
  positionBetween,
  publishBlockStructureMutation,
  publishDatabaseRowsMutation,
  publishCommentsMutation,
  reconcilePersistedBlockMutation,
  recordCacheMeta,
  recordCacheTables,
  reloadBlocksFromServer,
  remapBlockContent,
  remoteBlockWithOptimisticOverlay,
  remotePageWithOptimisticOverlay,
  removeBlocksFromPages,
  scheduleBlockBatch,
  serializeBlockHistory,
  snapshotsEqual,
  spansToPlainText,
  stampBlocksCached,
  storeMessages,
  structureBlockSnapshot,
  topLevelBlocksCache,
  touchPageForBlockChange,
  upsertBlocksIntoPages,
};
export type BlockStoreRuntime = typeof blockStoreRuntime;
const databaseStoreRuntime = {
  CLIENT_PROPERTY_OPTION_DELETE_ENABLED,
  CLIENT_SCHEMA_RESTORE_ENABLED,
  DATABASE_INITIAL_ROW_LIMIT,
  DATABASE_ROW_LOAD_MORE_LIMIT,
  appendUniqueIds,
  applyEmbeddedDatabaseSnapshots,
  assertDatabaseUnlocked,
  bySortPos,
  cacheAppendRowPage,
  cacheClearDatabase,
  cacheCurrentDatabaseMetadata,
  cacheReplaceTable,
  cacheSetMeta,
  cacheRecentDatabaseRowsQuery,
  canCreatePageInState,
  canEditPageInState,
  cleanUniqueIds,
  cloneJson,
  configChanged,
  createDatabaseRowRemote,
  configureDatabaseTaskFeatureRemote,
  executeDatabaseButtonRemote,
  flushPage,
  currentChangesSyncedAt,
  currentDatabaseRowsAuthority,
  currentRelativeRouteHref,
  databaseDependencyRelationKey,
  databaseCreateRowsQueryKey,
  databaseLoadPromises,
  databaseMetadataRevalidated,
  databaseNeedsComputedValues,
  databaseRowCacheKeys,
  databaseRowLoadMorePromises,
  databaseRowPageSatisfiesInitialLoad,
  databaseRowsForcedAgain,
  databaseRowsLoadErrorMessage,
  databaseRowsQueryKey,
  databaseRowsQueryPromises,
  clearRecentDatabaseRowsQueries,
  durableRemoteCall,
  ensureAuth,
  feedSaysUnchanged,
  finishOptimisticDatabaseCreate,
  getDatabaseDependencyRelationRemote,
  getDatabaseRowsRemote,
  getDatabaseSnapshotRemote,
  hasDatabaseTemplateStoredFileReference,
  hydrateDatabaseMetaFromCache,
  hydrateDatabaseRowsFromCache,
  hydrateRowsViaLocalEngine,
  i18next,
  iconTypeForValue,
  isDatabaseLocked,
  isKoreanLocale,
  lastHydratedRowsFeedStamp,
  linkedDatabaseResolvedTitle,
  mergeById,
  mergePersistedPageCreateAuthority,
  mergeDatabaseDependencyRelationAuthority,
  mirrorPendingPage,
  moveDatabaseRowRemote,
  reparentDatabaseSubitemRemote,
  moveIdRelative,
  newId,
  normalizeDatabaseRowsQuery,
  nowIso,
  optimisticStarterDatabaseSchema,
  projectOptimisticDatabaseSubitem,
  projectOptimisticRowFileValue,
  outboxUserId,
  pageDisplayTitle,
  pendingDatabaseCreate,
  pendingDatabaseRowCreate,
  pendingPage,
  pendingPageLikeCreateHas,
  pendingPropertyCreate,
  pendingViewCreate,
  permanentDeleteIds,
  persistErrorStatus,
  purgePagesFromBootstrapCache,
  persistOptimisticTemplateCreate,
  persistableRowProperties,
  positionBetween,
  publishDatabaseRowsMutation,
  publishDatabaseSchemaMutation,
  publishDatabaseTemplatesMutation,
  publishDatabaseViewsMutation,
  recordCacheMeta,
  recordValue,
  readRecentDatabaseRowsQuery,
  registerRowsCacheKey,
  releaseOptimisticCreateDependents,
  adoptPersistedPageCreateAuthority,
  reloadBlocksFromServer,
  remotePageWithOptimisticOverlay,
  replaceRoute,
  rollbackDependentWritesForFailedCreate,
  rollbackMatchingFields,
  rollbackOptimisticDatabaseCreate,
  rollbackOptimisticRowProperty,
  routeInfoFromPath,
  rowFileStorageKey,
  stampDatabaseCached,
  startBackgroundDurableCall,
  storeMessages,
  templateTitleValue,
  updateDatabaseDependencyRelationRemote,
  valueReferencesPendingCreate,
  viewConfigWithoutFilterProperty,
  viewConfigWithoutProperty,
  withoutLoadedDatabaseProperty,
};
export type DatabaseStoreRuntime = typeof databaseStoreRuntime;

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  bootstrapFailure: undefined,
  syncDegraded: false,
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
  updatesOpen: false,
  setUpdatesOpen: (open) => set({ updatesOpen: open }),
  toasts: [],
  notify: (message, tone = "default", action) => {
    const id = newId();
    set((s) => ({
      toasts: [
        ...s.toasts.filter((toast) => toast.message !== message),
        { id, message, tone, action },
      ].slice(-4),
    }));
    // A toast with an action is a small recovery/update surface, not transient
    // decoration. Keep it until the user performs the action or explicitly
    // dismisses it so conflict recovery and "reload update" controls cannot
    // disappear while the user is reading them.
    if (!action) {
      window.setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }));
      }, 2600);
    }
    return id;
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) })),
  setFocusPageId: (id, target = "title") =>
    set({
      focusPageId: id,
      focusPageTarget: id ? target : undefined,
    }),
  workspaces: [],
  activeDataScope: undefined,
  isInstanceAdmin: false,
  organizations: [],
  organization: undefined,
  currentOrganizationMember: undefined,
  organizationMembers: [],
  organizationGroups: [],
  organizationProfiles: [],
  organizationDomains: [],
  organizationAuditEvents: [],
  enterpriseControls: undefined,
  organizationScimTokens: [],
  organizationLegalHolds: [],
  organizationAuditExports: [],
  organizationDiscoveryExports: [],
  organizationBillingRecords: [],
  applyOrganizationDirectory: (directory) => {
    const organizationProfiles = directory.organizationProfiles ?? get().organizationProfiles;
    setWorkspacePeople(get().workspaceMembers, organizationProfiles);
    set((s) => ({
      organization: "organization" in directory ? directory.organization : s.organization,
      organizations: directory.organizations ?? s.organizations,
      currentOrganizationMember:
        "currentOrganizationMember" in directory
          ? directory.currentOrganizationMember
          : s.currentOrganizationMember,
      organizationMembers: directory.organizationMembers ?? s.organizationMembers,
      organizationGroups: directory.organizationGroups ?? s.organizationGroups,
      organizationProfiles: directory.organizationProfiles ?? s.organizationProfiles,
      organizationDomains: directory.organizationDomains ?? s.organizationDomains,
      organizationAuditEvents: directory.organizationAuditEvents ?? s.organizationAuditEvents,
      enterpriseControls: directory.enterpriseControls ?? s.enterpriseControls,
      organizationScimTokens: directory.organizationScimTokens ?? s.organizationScimTokens,
      organizationLegalHolds: directory.organizationLegalHolds ?? s.organizationLegalHolds,
      organizationAuditExports: directory.organizationAuditExports ?? s.organizationAuditExports,
      organizationDiscoveryExports: directory.organizationDiscoveryExports ?? s.organizationDiscoveryExports,
      organizationBillingRecords: directory.organizationBillingRecords ?? s.organizationBillingRecords,
      workspaces: directory.workspaces ?? s.workspaces,
    }));
  },
  updateWorkspace: async (patch) => {
    const cur = get().workspace;
    if (!cur) return undefined;
    const nextPatch = persistableWorkspacePatch(patch);
    if (!Object.keys(nextPatch).length) return cur;
    set({ workspace: { ...cur, ...nextPatch } });
    const remotePatch: WorkspaceMutationPatch = {
      ...nextPatch,
    };
    if ("icon" in patch && patch.icon === undefined) remotePatch.icon = null;
    if ("domain" in patch && patch.domain === undefined) remotePatch.domain = null;
    try {
      const workspace = await updateWorkspaceRemote(cur.id, remotePatch);
      set({ workspace });
      return workspace;
    } catch (error) {
      set((s) => (s.workspace?.id === cur.id ? { workspace: cur } : {}));
      throw error;
    }
  },
  createWorkspace: async (input) => {
    const organizationId = input.organizationId ?? get().organization?.id ?? null;
    const result = await createWorkspaceRemote({ ...input, organizationId });
    if (result.workspaces) {
      set({ workspaces: result.workspaces });
    }
    if (result.organizations) {
      set({ organizations: result.organizations });
    }
    if (result.organization || result.currentOrganizationMember || result.organizationMembers) {
      get().applyOrganizationDirectory(result);
    }
    if (result.workspace?.id) {
      await get().bootstrap({ workspaceId: result.workspace.id });
      return result.workspace;
    }
    throw new Error("Couldn't create workspace");
  },
  deleteWorkspace: async (workspaceId, input = {}) => {
    const id = workspaceId.trim();
    if (!id) return undefined;
    const current = get().workspace;
    const result = await deleteWorkspaceRemote(id, input);
    const nextWorkspaces = result.workspaces ?? get().workspaces.filter((item) => item.id !== id);
    set({ workspaces: nextWorkspaces });
    if (result.organizations) {
      set({ organizations: result.organizations });
    }
    if (current?.id !== id) return current;
    const next = nextWorkspaces.find((item) => item.id !== id) ?? nextWorkspaces[0];
    if (next?.id) {
      rememberWorkspaceCache(next.id);
      try {
        await get().bootstrap({ workspaceId: next.id });
        return get().workspace ?? next;
      } catch {
        resetDeferredBlockCreates();
        set({
          ready: false,
          workspace: next,
          currentMember: undefined,
          workspaceMembers: [],
          teamspaces: [],
          discoverableTeamspaces: [],
          teamspaceSettings: undefined,
          pagesById: {},
          pageRolesById: {},
          sharedPageIds: new Set(),
          recentPageIds: [],
          treeExpandedPageIds: new Set(),
          blocksByPage: {},
          loadedBlockPages: new Set(),
          blockHistoryByPage: {},
          commentsByPage: {},
          loadedCommentPages: new Set(),
          propsByDb: {},
          viewsByDb: {},
          templatesByDb: {},
          loadedDbs: new Set(),
          databaseRowIdsByDb: {},
          databaseRowPagesByDb: {},
          databaseSubitemRowWindowsByDb: {},
          databaseDependencyRelations: {},
          hydratedRelationTargetIds: new Set(),
          commentPanel: undefined,
        });
        return next;
      }
    }
    rememberWorkspaceCache(undefined);
    resetDeferredBlockCreates();
    set({
      ready: false,
      workspace: undefined,
      currentMember: undefined,
      workspaceMembers: [],
      teamspaces: [],
      discoverableTeamspaces: [],
      teamspaceSettings: undefined,
      pagesById: {},
      pageRolesById: {},
      sharedPageIds: new Set(),
      recentPageIds: [],
      treeExpandedPageIds: new Set(),
      blocksByPage: {},
      loadedBlockPages: new Set(),
      blockHistoryByPage: {},
      commentsByPage: {},
      loadedCommentPages: new Set(),
      propsByDb: {},
      viewsByDb: {},
      templatesByDb: {},
      loadedDbs: new Set(),
      databaseRowIdsByDb: {},
      databaseRowPagesByDb: {},
      databaseSubitemRowWindowsByDb: {},
      databaseDependencyRelations: {},
      hydratedRelationTargetIds: new Set(),
      commentPanel: undefined,
    });
    return get().workspace;
  },
  switchWorkspace: async (workspaceId) => {
    const id = workspaceId.trim();
    if (!id) return undefined;
    if (get().workspace?.id === id && get().activeDataScope?.kind !== "public_share") {
      return get().workspace;
    }
    await get().bootstrap({ workspaceId: id });
    return get().workspace;
  },
  workspaceMembers: [],
  teamspaces: [],
  discoverableTeamspaces: [],
  teamspaceSettings: undefined,
  applyWorkspaceMembers: (members, currentMember) => {
    setWorkspacePeople(members, get().organizationProfiles);
    set((s) => ({
      workspaceMembers: members,
      currentMember:
        currentMember ??
        members.find((member) => member.userId === s.userId) ??
        s.currentMember,
    }));
  },
  pagesById: {},
  pageRolesById: {},
  sharedPageIds: new Set(),
  recentPageIds: [],
  treeExpandedPageIds: new Set(),
  setTreePageExpanded: (pageId, expanded) =>
    set((s) => {
      const treeExpandedPageIds = new Set(s.treeExpandedPageIds);
      if (expanded) treeExpandedPageIds.add(pageId);
      else treeExpandedPageIds.delete(pageId);
      writeTreeExpandedPageIds(s.workspace?.id, Array.from(treeExpandedPageIds));
      return { treeExpandedPageIds };
    }),
  blocksByPage: {},
  loadedBlockPages: new Set(),
  blockHistoryByPage: {},
  commentsByPage: {},
  loadedCommentPages: new Set(),
  commentPanel: undefined,
  openComments: (pageId, blockId = null, opts) =>
    set({ commentPanel: { pageId, blockId, ...opts } }),
  closeComments: () => set({ commentPanel: undefined }),
  propsByDb: {},
  viewsByDb: {},
  templatesByDb: {},
  loadedDbs: new Set(),
  databaseRowIdsByDb: {},
  databaseRowPagesByDb: {},
  databaseSubitemRowWindowsByDb: {},
  databaseDependencyRelations: {},
  hydratedRelationTargetIds: new Set(),

  async bootstrap(input = {}) {
    const key = bootstrapInputKey(input);
    const current = get();
    const requestedWorkspaceId = input.workspaceId?.trim();
    const requestedSlug = normalizeWorkspaceSlug(input.workspaceSlug);
    const requestedPageId = input.pageId?.trim();
    if (
      current.ready &&
      current.activeDataScope?.kind !== "public_share" &&
      (!requestedWorkspaceId || current.workspace?.id === requestedWorkspaceId) &&
      (!requestedSlug || normalizeWorkspaceSlug(current.workspace?.domain) === requestedSlug) &&
      (!requestedPageId || !!current.pagesById[requestedPageId])
    ) {
      return;
    }
    if (bootPromise && bootKey === key) return bootPromise;
    set({ bootstrapFailure: undefined });
    const previousRefreshLane = bootKey !== key
      && current.ready
      && !!current.workspace
      && bootInputKeyForRefresh === bootKey
      ? {
          key: bootKey,
          input: { ...bootInputForRefresh },
          workspaceId: current.workspace.id,
          refreshedAt: workspaceRefreshedAt,
        }
      : null;
    if (bootKey !== key) resetWorkspaceRefreshLoop();
    bootKey = key;
    bootPromise = (async () => {
      // Stale-while-revalidate boot (local-first Phase 1): read the cached
      // payload, kick the network fetch off — as a pages DELTA when we hold a
      // watermark (§7) — render the cache while it runs, then reconcile. When
      // the fetch fails but the cache rendered, this is the offline boot path
      // (Phase 2): queued mutations replay/retry until the network returns.
      const blob = await readBootstrapBlob(key);
      const watermark = blob?.pagesSyncedAt;
      const changesCursor = blob?.changesSyncedAt ?? "";
      const resultPromise = bootstrapWorkspace(
        watermark
          ? {
              ...input,
              pagesSince: watermark,
              ...(changesCursor ? { changesSince: changesCursor } : {}),
            }
          : input
      );
      resultPromise.catch(() => {}); // handled below; avoid unhandled rejection
      const hydrated = await hydrateBootstrapFromCache(key, blob, input);
      try {
        let result = await resultPromise;
        if (result.pagesDelta) {
          // Materialize the delta over the cached blob; anything unresolvable
          // (newly visible page we never cached) falls back to a full fetch.
          result = resolveBootstrapDelta(blob, result) ?? (await bootstrapWorkspace(input));
        }
        applyBootFeedHints(result, changesCursor);
        const entries = await outboxAllEntries(result.userId);
        applyBootstrapResultWithOutbox(
          result,
          entries,
          hydrated ? "reconcile" : "initial",
          blob ? new Set((blob.pages ?? []).map((page) => page.id)) : undefined
        );
        // Cache hydration marks the current page's blocks loaded before the
        // network bootstrap resolves. If the fresh page stamp moved, the
        // editor's normal load effect would otherwise hit the loaded shortcut
        // and leave stale blocks visible until a later refresh. Revalidate in
        // the already-visible background boot and keep queued outbox edits
        // projected by the forced network load.
        if (hydrated) {
          // The warm-cache path started durable replay as soon as local state
          // was available. Let that authoritative write finish before route
          // revalidation starts page/block reads; on a small NAS those reads
          // otherwise contend with recovery and can both slow the save and
          // exhaust the worker into transient 503s.
          await replayDurableOutbox(result.userId).catch(() => {});
          await revalidateHydratedCurrentRouteBlocks(input);
        }
        rememberLastUserId(result.userId);
        cacheSetMeta(
          result.userId,
          recordCacheMeta.bootstrap(key),
          bootstrapBlobForCache(result)
        );
        bootInputForRefresh = { ...input };
        bootInputKeyForRefresh = key;
        workspaceRefreshedAt = Date.now();
        startWorkspaceRefreshLoop();
        // Local-first Phase 0: replay mutations left durably queued by tabs
        // that died before flushing. Fire-and-forget: never blocks boot.
        if (!hydrated) void replayDurableOutbox(result.userId).catch(() => {});
        // Phase 3 v2: eagerly cache pins/favorites/recents for offline use.
        scheduleWarmOfflineScope(result.userId);
      } catch (error) {
        const status = persistErrorStatus(error);
        if (status === 401 || status === 403 || status === 404) {
          useStore.setState({
            bootstrapFailure: {
              message: error instanceof Error ? error.message : String(error),
              status,
              ...(input.pageId?.trim() ? { pageId: input.pageId.trim() } : {}),
              ...(normalizeWorkspaceSlug(input.workspaceSlug)
                ? { workspaceSlug: normalizeWorkspaceSlug(input.workspaceSlug) }
                : {}),
            },
          });
        }
        if (!hydrated) throw error;
        // Hydrated render + failed fetch: only a transient/offline failure
        // lets the cache stand (Phase 2 offline boot). A definitive server
        // denial means this actor cannot see the requested workspace/page —
        // un-render the cached data (a revoked share, or a previous account
        // on this browser), drop the refuted blob so the next boot fails
        // fast, and surface the denial to the caller.
        if (status === 401 || status === 403 || status === 404) {
          const cacheOwnerId = blob?.userId || useStore.getState().userId || "";
          if (cacheOwnerId) cacheSetMeta(cacheOwnerId, recordCacheMeta.bootstrap(key), null);
          discardHydratedBoot();
          throw error;
        }
        const cachedUserId = useStore.getState().userId;
        if (cachedUserId) void replayDurableOutbox(cachedUserId).catch(() => {});
      }
    })().catch((e) => {
      // A different-key bootstrap may already own the global lane. Never let
      // this older rejection clear it. When a cold switch failed before
      // changing live state, restore the successful workspace's poll lane;
      // otherwise the still-visible workspace would stop refreshing forever.
      if (bootKey === key) {
        bootPromise = null; // allow retry after a failed bootstrap
        const live = useStore.getState();
        if (
          previousRefreshLane
          && live.ready
          && live.workspace?.id === previousRefreshLane.workspaceId
        ) {
          bootKey = previousRefreshLane.key;
          bootInputForRefresh = { ...previousRefreshLane.input };
          bootInputKeyForRefresh = previousRefreshLane.key;
          workspaceRefreshedAt = previousRefreshLane.refreshedAt;
          startWorkspaceRefreshLoop();
        } else {
          bootKey = "";
        }
      }
      throw e;
    });
    return bootPromise;
  },

...createPageStoreActions(set, get, pageStoreRuntime),




















...createBlockStoreActions(set, get, blockStoreRuntime),
















  // ── comments ───────────────────────────────────────────────────────
  async loadComments(pageId, opts) {
    const loadUserId = outboxUserId();
    if (loadUserId && permanentDeleteIds(loadUserId).has(pageId)) return;
    if (pendingPageLikeCreateHas(pageId)) return;
    // Same force-aware dedup as loadBlocks: a forced refresh (terminal-drop
    // reconciliation) must not be swallowed by a plain load already in flight.
    const force = opts?.force === true;
    const promiseKey = `${pageId}:${force ? "force" : "cached"}`;
    const inFlight = commentLoadPromises.get(promiseKey);
    if (inFlight) return inFlight;
    const alreadyLoaded = get().loadedCommentPages.has(pageId);
    if (
      alreadyLoaded &&
      !force &&
      Date.now() - (commentFetchedAt.get(pageId) ?? 0) < COMMENT_REFRESH_MIN_GAP_MS
    ) {
      return;
    }
    const readToken = beginReadApplication(readApplicationKey.comments(pageId));
    const promise = (async () => {
      const hydrated = !force && !alreadyLoaded
        ? await hydrateCommentsFromCache(pageId)
        : false;
      const hasRenderableComments = alreadyLoaded || hydrated;
      try {
        const remoteComments = (await getPageCommentsRemote(pageId)).comments.sort(byCreated);
        await applyLatestRead(readToken, async () => {
          if (
            loadUserId && permanentDeleteIds(loadUserId).has(pageId)
          ) return;
          const entries = loadUserId ? await outboxAllEntries(loadUserId) : [];
          if (
            loadUserId && permanentDeleteIds(loadUserId).has(pageId)
          ) return;
          const comments = overlayOutboxOnComments(entries, pageId, remoteComments);
          commentFetchedAt.set(pageId, Date.now());
          set((s) => ({
            commentsByPage: { ...s.commentsByPage, [pageId]: comments },
            loadedCommentPages: new Set(s.loadedCommentPages).add(pageId),
          }));
          // Paint first, but do not resolve the load until IndexedDB owns the
          // response. A reload immediately after the server reply must still be
          // able to render these comments locally.
          await cacheCurrentComments(pageId);
        });
      } catch (error) {
        const status = persistErrorStatus(error);
        if (status === 401 || status === 403 || status === 404) {
          await applyDefinitiveReadDenial(readToken, async () => {
            commentFetchedAt.delete(pageId);
            if (loadUserId) {
              await Promise.all([
                cacheReplaceTable(loadUserId, recordCacheTables.comments(pageId), []),
                cacheSetMeta(loadUserId, recordCacheMeta.commentsCachedAt(pageId), null),
              ]);
            }
            set((state) => {
              const commentsByPage = { ...state.commentsByPage };
              delete commentsByPage[pageId];
              const loadedCommentPages = new Set(state.loadedCommentPages);
              loadedCommentPages.delete(pageId);
              return { commentsByPage, loadedCommentPages };
            });
          });
          throw error;
        }
        // Background refresh of an already-rendered list may fail offline —
        // the rendered comments stand. A first load still surfaces the error.
        if (!hasRenderableComments) throw error;
      }
    })().finally(() => {
      commentLoadPromises.delete(promiseKey);
    });
    commentLoadPromises.set(promiseKey, promise);
    return promise;
  },

  refreshCommentsFromSignal(pageId) {
    let state = commentSignalRefreshes.get(pageId);
    if (!state) {
      state = {
        cancelled: false,
        pending: false,
      };
      commentSignalRefreshes.set(pageId, state);
    }
    state.pending = true;
    if (state.drain) return state.drain;
    state.cancelled = false;

    const drain = (async () => {
      while (!state.cancelled && state.pending) {
        // A force read that was already active can predate this invalidation.
        // Let its own authority settle, then keep the pending signal so the
        // next read is guaranteed to start after the signal.
        const preexistingForce = commentLoadPromises.get(`${pageId}:force`);
        if (preexistingForce) {
          await preexistingForce.catch(() => {});
          continue;
        }

        const remainingMs = state.lastStartedAt === undefined
          ? 0
          : Math.max(
              0,
              state.lastStartedAt + COMMENT_REFRESH_MIN_GAP_MS - Date.now(),
            );
        if (remainingMs > 0) {
          await waitForCommentSignalRefreshWindow(state, remainingMs);
        }
        if (state.cancelled) break;

        // No await separates this check from loadComments, so an older force
        // lane cannot race in and consume the pending generation.
        const forceAfterWindow = commentLoadPromises.get(`${pageId}:force`);
        if (forceAfterWindow) {
          await forceAfterWindow.catch(() => {});
          continue;
        }

        // Every signal received before this exact request start is covered by
        // the upcoming canonical read. A signal received while it is in flight
        // flips pending back to true and therefore owns one trailing read.
        state.pending = false;
        state.lastStartedAt = Date.now();
        try {
          await get().loadComments(pageId, { force: true });
        } catch (error) {
          // A newer signal received during the failed read still owns one
          // bounded post-signal attempt. Without one, the older failure would
          // consume that later invalidation. Stop once an attempt fails with
          // no newer pending signal; the caller retains rejection ownership.
          if (!state.pending) throw error;
        }
      }
    })().finally(() => {
      state.drain = undefined;
      state.wakeTimer?.();
    });
    state.drain = drain;
    return drain;
  },

  pageComments(pageId) {
    return (get().commentsByPage[pageId] ?? []).slice().sort(byCreated);
  },

  async addComment(pageId, text, blockId = null, parentId = null, opts) {
    // Backstop for the UI gate: the backend rejects comment mutations from
    // view-only roles, so refuse before the optimistic insert to avoid an
    // optimistic-then-403 flicker.
    if (!canCommentPageInState(get(), get().pagesById[pageId])) {
      throw new Error("Comment access required.");
    }
    const authorId = get().userId || (await ensureAuth()) || "local-user";
    const quote = opts?.quote?.trim();
    const hasQuoteRange =
      typeof opts?.quoteStart === "number" &&
      typeof opts?.quoteEnd === "number" &&
      opts.quoteEnd > opts.quoteStart;
    const now = nowIso();
    const rich = opts?.rich?.length ? opts.rich : [{ text }];
    const comment: Comment = {
      id: newId(),
      pageId,
      blockId,
      parentId,
      authorId,
      body: quote
        ? {
            rich,
            quote,
            ...(hasQuoteRange ? { quoteStart: opts.quoteStart, quoteEnd: opts.quoteEnd } : {}),
          }
        : { rich },
      resolved: false,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({
      userId: authorId,
      commentsByPage: {
        ...s.commentsByPage,
        [pageId]: [...(s.commentsByPage[pageId] ?? []), comment].sort(byCreated),
      },
      loadedCommentPages: new Set(s.loadedCommentPages).add(pageId),
    }));
    pendingCommentCreate.set(comment.id, pageId);
    const opKey = `create-comment:${comment.id}`;
    startBackgroundDurableCall({
      args: [comment],
      fnKey: "createCommentRemote",
      opKey,
      userId: authorId,
      waitsFor: () =>
        pendingPageLikeCreateHas(pageId) ||
        Boolean(parentId && pendingCommentCreate.has(parentId)),
      onSuccess: async (result) => {
        pendingCommentCreate.delete(comment.id);
        const persisted = result as Comment | undefined;
        if (persisted) {
          useStore.setState((state) => ({
            commentsByPage: {
              ...state.commentsByPage,
              [pageId]: (state.commentsByPage[pageId] ?? []).map((current) =>
                current.id === comment.id ? { ...persisted, ...current } : current
              ),
            },
          }));
        }
        await cacheCurrentComments(pageId);
        publishCommentsMutation(pageId);
        releaseOptimisticCreateDependents(comment.id);
      },
      onDrop: async () => {
        const failed = new Set([comment.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const current of useStore.getState().commentsByPage[pageId] ?? []) {
            if (failed.has(current.id) || !current.parentId || !failed.has(current.parentId)) continue;
            failed.add(current.id);
            changed = true;
          }
        }
        for (const id of failed) {
          pendingCommentCreate.delete(id);
          // The current root was already acknowledged by the background
          // settlement branch before onDrop ran. Only queued descendants need
          // their own cancellation/ack so each durable key settles once.
          if (id !== comment.id) {
            cancelBackgroundDurableCall(`create-comment:${id}`, authorId);
          }
          rollbackDependentWritesForFailedCreate(id);
        }
        useStore.setState((state) => ({
          commentsByPage: {
            ...state.commentsByPage,
            [pageId]: (state.commentsByPage[pageId] ?? []).filter(
              (item) => !failed.has(item.id)
            ),
          },
        }));
        await cacheCurrentComments(pageId);
      },
    });
    void cacheCurrentComments(pageId);
    return comment;
  },

  updateComment(id, patch) {
    // Same backstop as addComment: locate the comment's page and refuse the
    // mutation if the current role can't comment (the backend would 403).
    const state = get();
    for (const [pageId, comments] of Object.entries(state.commentsByPage)) {
      if (comments.some((comment) => comment.id === id)) {
        if (!canCommentPageInState(state, state.pagesById[pageId])) return;
        break;
      }
    }
    let foundPageId = "";
    let previousComment: Comment | undefined;
    const localPatch: Partial<Comment> = {
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso(),
    };
    set((s) => {
      const commentsByPage = { ...s.commentsByPage };
      for (const [pageId, comments] of Object.entries(commentsByPage)) {
        const idx = comments.findIndex((comment) => comment.id === id);
        if (idx < 0) continue;
        foundPageId = pageId;
        previousComment = comments[idx];
        const next = comments.slice();
        next[idx] = { ...next[idx], ...localPatch };
        commentsByPage[pageId] = next.sort(byCreated);
        break;
      }
      return { commentsByPage };
    });
    if (foundPageId) {
      const pageId = foundPageId;
      const before = previousComment;
      void cacheCurrentComments(pageId);
      void durableRemoteCall(
        "updateCommentRemote",
        [id, patch as Partial<Comment>, pageId],
        undefined,
        undefined,
        { commentPageIds: [pageId] },
        async () => {
          if (before) {
            useStore.setState((current) => ({
              commentsByPage: {
                ...current.commentsByPage,
                [pageId]: (current.commentsByPage[pageId] ?? []).map((comment) =>
                  comment.id === id
                    ? rollbackMatchingFields(
                        comment,
                        { ...before, ...localPatch },
                        before,
                        Object.keys(localPatch) as Array<keyof Comment>
                      )
                    : comment
                ),
              },
            }));
          }
          await cacheCurrentComments(pageId);
        }
      ).then(
        (call) => {
          if (call.status === "ok") publishCommentsMutation(pageId);
        }
      );
    }
  },

  deleteComment(id) {
    // Author-or-editor gate lives on the backend (assertCanChangeComment);
    // the UI only offers delete on own comments, so mirror addComment's
    // comment-access backstop here.
    const state = get();
    let foundPageId = "";
    for (const [pageId, comments] of Object.entries(state.commentsByPage)) {
      if (comments.some((comment) => comment.id === id || comment.parentId === id)) {
        foundPageId = pageId;
        break;
      }
    }
    if (!foundPageId) return;
    if (!canCommentPageInState(state, state.pagesById[foundPageId])) return;
    const pageId = foundPageId;
    // Deleting a thread root orphans its replies — delete them with it, both
    // locally and remotely (the backend has no cascade).
    const doomedIds = [
      id,
      ...(state.commentsByPage[pageId] ?? [])
        .filter((comment) => comment.parentId === id)
        .map((comment) => comment.id),
    ];
    const doomed = new Set(doomedIds);
    const removedComments = (state.commentsByPage[pageId] ?? []).filter((comment) =>
      doomed.has(comment.id)
    );
    set((s) => ({
      commentsByPage: {
        ...s.commentsByPage,
        [pageId]: (s.commentsByPage[pageId] ?? []).filter((comment) => !doomed.has(comment.id)),
      },
    }));
    void cacheCurrentComments(pageId);
    void durableRemoteCall(
      "deleteCommentsRemote",
      [doomedIds, pageId],
      undefined,
      undefined,
      { commentPageIds: [pageId] },
      async () => {
        useStore.setState((current) => {
          const byId = new Map(
            (current.commentsByPage[pageId] ?? []).map((comment) => [comment.id, comment])
          );
          for (const comment of removedComments) {
            if (!byId.has(comment.id)) byId.set(comment.id, comment);
          }
          return {
            commentsByPage: {
              ...current.commentsByPage,
              [pageId]: Array.from(byId.values()).sort(byCreated),
            },
          };
        });
        await cacheCurrentComments(pageId);
      }
    ).then((call) => {
      if (call.status === "ok") publishCommentsMutation(pageId);
    });
  },

  ...createDatabaseStoreActions(set, get, databaseStoreRuntime),
}));

function applyCrossTabPermanentDeleteFence(userId: string) {
  const state = useStore.getState();
  if (!userId || state.userId !== userId) return;
  const deleted = permanentDeleteIds(userId);
  if (deleted.size === 0) return;
  advanceWorkspaceDataEpoch();
  for (const pageId of deleted) cancelPendingPage(pageId);
  for (const pageId of deleted) {
    clearDeferredBlockCreatesForPage(pageId, state.blocksByPage[pageId] ?? []);
  }
  for (const [blockId, pageId] of pendingBlockPage) {
    if (deleted.has(pageId)) cancelPendingBlock(blockId);
  }
  useStore.setState((current) => {
    const pagesById = Object.fromEntries(
      Object.entries(current.pagesById).filter(([pageId]) => !deleted.has(pageId))
    );
    const deletedDatabaseIds = new Set(
      Object.values(current.pagesById)
        .filter((page) => deleted.has(page.id) && page.kind === "database")
        .map((page) => page.id)
    );
    const withoutDeletedKeys = <T>(record: Record<string, T>) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => !deleted.has(id)));
    const databaseRowIdsByDb = Object.fromEntries(
      Object.entries(current.databaseRowIdsByDb)
        .filter(([databaseId]) => !deletedDatabaseIds.has(databaseId))
        .map(([databaseId, rowIds]) => [
          databaseId,
          rowIds.filter((rowId) => !deleted.has(rowId)),
        ])
    );
    const recentPageIds = current.recentPageIds.filter((pageId) => !deleted.has(pageId));
    const treeExpandedPageIds = new Set(
      [...current.treeExpandedPageIds].filter((pageId) => !deleted.has(pageId))
    );
    writeRecentPageIds(current.workspace?.id, recentPageIds);
    writeTreeExpandedPageIds(current.workspace?.id, [...treeExpandedPageIds]);
    return {
      pagesById,
      pageRolesById: withoutDeletedKeys(current.pageRolesById),
      blocksByPage: withoutDeletedKeys(current.blocksByPage),
      blockHistoryByPage: withoutDeletedKeys(current.blockHistoryByPage),
      commentsByPage: withoutDeletedKeys(current.commentsByPage),
      propsByDb: withoutDeletedKeys(current.propsByDb),
      viewsByDb: withoutDeletedKeys(current.viewsByDb),
      templatesByDb: withoutDeletedKeys(current.templatesByDb),
      databaseRowIdsByDb,
      databaseRowPagesByDb: Object.fromEntries(
        Object.entries(current.databaseRowPagesByDb).filter(
          ([databaseId]) => !deletedDatabaseIds.has(databaseId)
        )
      ),
      databaseSubitemRowWindowsByDb: pruneDatabaseSubitemRowWindows(
        current.databaseSubitemRowWindowsByDb,
        deleted
      ),
      databaseDependencyRelations: pruneDatabaseDependencyRelations(
        current.databaseDependencyRelations,
        deleted
      ),
      loadedBlockPages: new Set(
        [...current.loadedBlockPages].filter((pageId) => !deleted.has(pageId))
      ),
      loadedCommentPages: new Set(
        [...current.loadedCommentPages].filter((pageId) => !deleted.has(pageId))
      ),
      loadedDbs: new Set(
        [...current.loadedDbs].filter((databaseId) => !deletedDatabaseIds.has(databaseId))
      ),
      hydratedRelationTargetIds: new Set(
        [...current.hydratedRelationTargetIds].filter((pageId) => !deleted.has(pageId))
      ),
      sharedPageIds: new Set(
        [...current.sharedPageIds].filter((pageId) => !deleted.has(pageId))
      ),
      recentPageIds,
      treeExpandedPageIds,
      ...(current.commentPanel && deleted.has(current.commentPanel.pageId)
        ? { commentPanel: undefined }
        : {}),
      ...(current.focusPageId && deleted.has(current.focusPageId)
        ? { focusPageId: undefined, focusPageTarget: undefined }
        : {}),
    };
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    const userId = permanentDeleteUserIdFromStorageKey(event.key);
    if (!userId) return;
    applyCrossTabPermanentDeleteFence(userId);
    void recordCacheClear(userId).then((cleared) => {
      markPermanentDeleteCacheCleanupPending(userId, !cleared);
    });
    void clearOfflineWorkspaceFileCache();
  });
}
