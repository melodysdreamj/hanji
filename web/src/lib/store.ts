"use client";

import { create } from "zustand";
import {
  bootstrapWorkspace,
  createBlockRemote,
  createBlocksRemote,
  createWorkspaceRemote,
  createCommentRemote,
  createDatabaseRemote,
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
  getDatabaseRowsRemote,
  getDatabaseSnapshotRemote,
  getPageBlocksRemote,
  getPageCommentsRemote,
  moveDatabaseRowRemote,
  recordCollaborationOperationRemote,
  rememberWorkspaceCache,
  restorePageRemote,
  restoreDatabaseRowRemote,
  trashPageRemote,
  trashDatabaseRowRemote,
  updateBlockRemote,
  updateBlocksRemote,
  updateCommentRemote,
  deleteCommentsRemote,
  updateCommentsRemote,
  updateDatabaseRowRemote,
  updatePageRemote,
  updatePropertyRemote,
  updateTemplateRemote,
  updateViewRemote,
  updateWorkspaceRemote,
} from "./edgebase";
import type {
  CreateWorkspaceInput,
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
import { pickLabels } from "./i18n";
import { newId, positionBetween } from "./ids";
import {
  localBoxIfSettled,
  lockBoxName,
  primeUnlockedGate,
  resetGateToDevice,
  setLocalEncryptionMode,
} from "./localLock";
import {
  outboxAck,
  outboxAllEntries,
  outboxClaimAbandoned,
  outboxClear,
  outboxRekey,
  outboxSet,
  resetOutboxForTests,
  type OutboxEntry,
  type OutboxOp,
} from "./outbox";
import {
  cacheGetMeta,
  cacheListTable,
  cacheReplaceTable,
  cacheSetMeta,
  getOfflinePins,
  hashCacheKey,
  recordCacheClear,
  registerRowsCacheKey,
  resetRecordCacheForTests,
  stampBlocksCached,
  stampDatabaseCached,
} from "./recordCache";
import { remapPageHref } from "./pageLinks";
import {
  pageMetaMutationPatch,
  publishLocalDatabaseMutation,
  publishPageRoomMutation,
} from "./pageRoomEvents";
import { linkedDatabaseResolvedTitle, pageDisplayTitle } from "./pageTitle";
import { canCommentPage, canCreateWorkspacePage, canEditPage } from "./permissions";
import { setWorkspacePeople } from "./peopleDirectory";
import { spansToPlainText } from "./types";
import type {
  Block,
  BlockContent,
  BlockType,
  ButtonTemplateBlock,
  CollaborationBlockStructureAction,
  CollaborationBlockStructureBlock,
  CollaborationBlockStructureOperation,
  Comment,
  DbProperty,
  DbTemplate,
  DbView,
  FilterGroup,
  Organization,
  OrganizationAuditEvent,
  OrganizationAuditExport,
  OrganizationBillingRecord,
  OrganizationDomain,
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
  return title.toLowerCase() === "untitled" ? "" : (template?.title ?? "");
}

const TEMPLATE_EDITOR_PAGE_PREFIX = "template:";

function isTemplateEditorPageId(pageId?: string | null) {
  return typeof pageId === "string" && pageId.startsWith(TEMPLATE_EDITOR_PAGE_PREFIX);
}

function nowIso() {
  return new Date().toISOString();
}

function persistablePagePatch(patch: Partial<Page>, page?: Page): Partial<Page> {
  const next = { ...patch };
  delete next.__computed;
  delete next.__databaseRowOrder;
  delete next.createdAt;
  delete next.updatedAt;
  if (page?.parentType === "database" && isPlainObject(next.properties)) {
    // Imported rows keep raw Notion snapshots under internal "__" keys; those
    // are not database schema properties and make row mutations fail.
    next.properties = persistableDatabaseRowProperties(next.properties as Record<string, unknown>);
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function persistableDatabaseRowProperties(properties?: Record<string, unknown> | null): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties ?? {}).filter(([key]) => !key.startsWith("__"))
  );
}

function persistableRowProperties(row: { properties?: Record<string, unknown> | null }): Record<string, unknown> {
  return persistableDatabaseRowProperties(row.properties);
}

function persistableWorkspacePatch(patch: Partial<Workspace>): Partial<Workspace> {
  const next = { ...patch };
  delete next.id;
  delete next.createdAt;
  delete next.updatedAt;
  return next;
}

function persistableBlockPatch(patch: Partial<Block>): Partial<Block> {
  const next = { ...patch };
  delete next.id;
  delete next.createdAt;
  delete next.updatedAt;
  return next;
}

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stripComputedFromPages(pagesById: Record<string, Page>) {
  let changed = false;
  const next: Record<string, Page> = {};
  for (const [id, page] of Object.entries(pagesById)) {
    if (!page.__computed) {
      next[id] = page;
      continue;
    }
    const pageWithoutComputed = { ...page };
    delete pageWithoutComputed.__computed;
    next[id] = pageWithoutComputed;
    changed = true;
  }
  return changed ? next : pagesById;
}

const LOCKED_PAGE_PATCH_KEYS = new Set<keyof Page>([
  "isLocked",
  "isFavorite",
  "isPublic",
  "backlinksDisplay",
  "pageCommentsDisplay",
  "verifiedAt",
  "verifiedBy",
  "verificationExpiresAt",
  "parentId",
  "parentType",
  "position",
  "inTrash",
  "trashedAt",
  "updatedAt",
  "lastEditedBy",
]);

function lockedPageAllowsPatch(patch: Partial<Page>) {
  return Object.keys(patch).every((key) =>
    LOCKED_PAGE_PATCH_KEYS.has(key as keyof Page)
  );
}

function isDatabaseLocked(pagesById: Record<string, Page>, dbId: string | null | undefined) {
  return !!(dbId && pagesById[dbId]?.isLocked);
}

function isPageParentLocked(pagesById: Record<string, Page>, parentId: string | null | undefined) {
  return !!(parentId && pagesById[parentId]?.isLocked);
}

function assertDatabaseUnlocked(pagesById: Record<string, Page>, dbId: string) {
  if (isDatabaseLocked(pagesById, dbId)) {
    throw new Error("Database is locked.");
  }
}

function iconTypeForValue(icon?: string): Page["iconType"] {
  if (!icon) return "none";
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(icon.trim()) ? "image" : "emoji";
}

function omitRecordKey<T>(record: Record<string, T> | undefined, key: string) {
  if (!record || !(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return Object.keys(next).length ? next : undefined;
}

function remapRecordKeys<T>(record: Record<string, T> | undefined, ids: Map<string, string>) {
  if (!record) return record;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    next[ids.get(key) ?? key] = value;
  }
  return next;
}

function remapFilterGroup(group: FilterGroup, ids: Map<string, string>): FilterGroup {
  return {
    ...group,
    filters: group.filters.map((filter) => ({
      ...filter,
      propertyId: ids.get(filter.propertyId) ?? filter.propertyId,
    })),
    groups: group.groups?.map((sub) => remapFilterGroup(sub, ids)),
  };
}

function filterGroupHasTerms(group: FilterGroup) {
  return group.filters.length > 0 || (group.groups ?? []).some(filterGroupHasTerms);
}

function filterGroupWithoutProperty(group: FilterGroup, propId: string): FilterGroup | undefined {
  const next: FilterGroup = {
    ...group,
    filters: group.filters.filter((filter) => filter.propertyId !== propId),
    groups: group.groups
      ?.map((sub) => filterGroupWithoutProperty(sub, propId))
      .filter((sub): sub is FilterGroup => !!sub && filterGroupHasTerms(sub)),
  };
  return filterGroupHasTerms(next) ? next : undefined;
}

function viewConfigWithoutProperty(config: ViewConfig | undefined, propId: string) {
  const next: ViewConfig = { ...(config ?? {}) };
  if (next.visibleProperties) {
    next.visibleProperties = next.visibleProperties.filter((id) => id !== propId);
  }
  if (next.propertyOrder) {
    next.propertyOrder = next.propertyOrder.filter((id) => id !== propId);
  }
  next.propertyWidths = omitRecordKey(next.propertyWidths, propId);
  next.tableCalculations = omitRecordKey(next.tableCalculations, propId);
  if (next.filters) next.filters = next.filters.filter((filter) => filter.propertyId !== propId);
  if (next.filterGroup) next.filterGroup = filterGroupWithoutProperty(next.filterGroup, propId);
  if (next.sorts) next.sorts = next.sorts.filter((sort) => sort.propertyId !== propId);
  if (next.wrappedColumns) next.wrappedColumns = next.wrappedColumns.filter((id) => id !== propId);
  if (next.groupBy === propId) next.groupBy = undefined;
  if (next.calendarBy === propId) next.calendarBy = undefined;
  if (next.timelineBy === propId) next.timelineBy = undefined;
  if (next.timelineEndBy === propId) next.timelineEndBy = undefined;
  if (next.dependencyProperty === propId) next.dependencyProperty = undefined;
  if (next.coverProperty === propId) next.coverProperty = undefined;
  if (next.subGroupBy === propId) next.subGroupBy = undefined;
  return next;
}

function viewConfigWithoutFilterProperty(config: ViewConfig | undefined, propId: string) {
  const next: ViewConfig = { ...(config ?? {}) };
  if (next.filters) next.filters = next.filters.filter((filter) => filter.propertyId !== propId);
  if (next.filterGroup) next.filterGroup = filterGroupWithoutProperty(next.filterGroup, propId);
  return next;
}

function remapViewConfigPropertyIds(config: ViewConfig | undefined, ids: Map<string, string>) {
  const next: ViewConfig = cloneValue(config ?? {});
  if (next.visibleProperties) next.visibleProperties = next.visibleProperties.map((id) => ids.get(id) ?? id);
  if (next.propertyOrder) next.propertyOrder = next.propertyOrder.map((id) => ids.get(id) ?? id);
  next.propertyWidths = remapRecordKeys(next.propertyWidths, ids);
  next.tableCalculations = remapRecordKeys(next.tableCalculations, ids);
  if (next.filters) {
    next.filters = next.filters.map((filter) => ({
      ...filter,
      propertyId: ids.get(filter.propertyId) ?? filter.propertyId,
    }));
  }
  if (next.filterGroup) next.filterGroup = remapFilterGroup(next.filterGroup, ids);
  if (next.sorts) {
    next.sorts = next.sorts.map((sort) => ({
      ...sort,
      propertyId: ids.get(sort.propertyId) ?? sort.propertyId,
    }));
  }
  if (next.wrappedColumns) next.wrappedColumns = next.wrappedColumns.map((id) => ids.get(id) ?? id);
  if (next.groupBy) next.groupBy = ids.get(next.groupBy) ?? next.groupBy;
  if (next.calendarBy) next.calendarBy = ids.get(next.calendarBy) ?? next.calendarBy;
  if (next.timelineBy) next.timelineBy = ids.get(next.timelineBy) ?? next.timelineBy;
  if (next.timelineEndBy) next.timelineEndBy = ids.get(next.timelineEndBy) ?? next.timelineEndBy;
  if (next.dependencyProperty) {
    next.dependencyProperty = ids.get(next.dependencyProperty) ?? next.dependencyProperty;
  }
  if (next.coverProperty) next.coverProperty = ids.get(next.coverProperty) ?? next.coverProperty;
  if (next.subGroupBy) next.subGroupBy = ids.get(next.subGroupBy) ?? next.subGroupBy;
  return next;
}

function configChanged(a: unknown, b: unknown) {
  return JSON.stringify(a ?? {}) !== JSON.stringify(b ?? {});
}

function collectPageSubtree(pagesById: Record<string, Page>, rootId: string) {
  const out = new Set<string>();
  const collect = (pid: string) => {
    if (out.has(pid)) return;
    out.add(pid);
    for (const page of Object.values(pagesById)) {
      if (page.parentId === pid) collect(page.id);
    }
  };
  collect(rootId);
  return out;
}

function hasTrashedAncestor(pagesById: Record<string, Page>, page: Page) {
  let current = page.parentId ? pagesById[page.parentId] : undefined;
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    if (current.inTrash) return true;
    current = current.parentId ? pagesById[current.parentId] : undefined;
  }
  return false;
}

type BlockHistoryMode = "push" | "merge";
type FocusPageTarget = "title" | "body";
interface BlockStructureHistoryOperation {
  action: CollaborationBlockStructureAction;
  pageId: string;
  blockIds: string[];
  before: Block[];
  after: Block[];
  occurredAt: string;
}
interface BlockHistoryEntry {
  blocks: Block[];
  operations?: BlockStructureHistoryOperation[];
  at: number;
  mode: BlockHistoryMode;
  /** Cross-page moves are ONE logical undo unit: twin entries (same link id)
   *  sit on both pages' stacks, undo/redo from either page applies the shared
   *  operation to both pages and consumes the twin on the other stack. */
  link?: { id: string; pageId: string };
}
interface BlockHistory {
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
  return `notionlike.recentPageIds.${workspaceId || "default"}`;
}

function treeExpandedKey(workspaceId?: string) {
  return `notionlike.treeExpandedPageIds.v2.${workspaceId || "default"}`;
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

function structurePayloadBlock(block: Block): CollaborationBlockStructureBlock {
  return {
    id: block.id,
    pageId: block.pageId,
    parentId: block.parentId ?? null,
    type: block.type,
    content: cloneValue(block.content) as Record<string, unknown> | undefined,
    plainText: block.plainText,
    position: block.position,
    createdBy: block.createdBy,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
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

function blockStructureOperationPayload(
  operation: BlockStructureHistoryOperation,
  direction: "forward" | "inverse" = "forward"
): CollaborationBlockStructureOperation {
  const before = direction === "forward" ? operation.before : operation.after;
  const after = direction === "forward" ? operation.after : operation.before;
  const action: CollaborationBlockStructureAction =
    direction === "forward"
      ? operation.action
      : operation.action === "create"
        ? "delete"
        : operation.action === "delete"
          ? "restore"
          : operation.action === "restore"
            ? "delete"
            : inferStructureAction(before, after);
  return {
    engine: "block_structure",
    schemaVersion: 1,
    action,
    blockIds: operation.blockIds,
    before: before.map(structurePayloadBlock),
    after: after.map(structurePayloadBlock),
  };
}

function recordBlockStructureOperation(
  operation: BlockStructureHistoryOperation,
  direction: "forward" | "inverse" = "forward"
) {
  const payload = blockStructureOperationPayload(operation, direction);
  void recordCollaborationOperationRemote({
    pageId: operation.pageId,
    blockId:
      payload.action === "create" || payload.action === "delete" || payload.action === "restore"
        ? null
        : operation.blockIds[0] ?? null,
    kind: "block_structure",
    operation: payload,
    revision: Date.parse(operation.occurredAt) || Date.now(),
    occurredAt: operation.occurredAt,
  }).catch(() => {});
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

async function persistBlockStructureOperation(
  operation: BlockStructureHistoryOperation,
  direction: "undo" | "redo"
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
  // Durable one-shots: transient failures queue + retry instead of silently
  // dropping the structural undo/redo (they never reject).
  await Promise.all([
    removals.length
      ? durableRemoteCall("deleteBlocksRemote", [removals, hintPageId])
      : Promise.resolve(),
    updates.length
      ? durableRemoteCall("updateBlocksRemote", [
          updates.map((block) => ({
            id: block.id,
            patch: blockStructurePatch(block),
          })),
          hintPageId,
        ])
      : Promise.resolve(),
    creates.length ? durableRemoteCall("createBlocksRemote", [creates]) : Promise.resolve(),
  ]);
}

async function persistBlockSnapshot(pageId: string, before: Block[], after: Block[]) {
  const beforeById = new Map(before.map((block) => [block.id, block]));
  const afterById = new Map(after.map((block) => [block.id, block]));
  for (const block of before) cancelPendingBlock(block.id);
  for (const block of after) cancelPendingBlock(block.id);

  await Promise.all([
    ...after.map((block) => {
      const previous = beforeById.get(block.id);
      if (!previous) return durableRemoteCall("createBlockRemote", [block]);
      if (JSON.stringify(previous) === JSON.stringify(block)) return Promise.resolve();
      return durableRemoteCall("updateBlockRemote", [
        block.id,
        persistableBlockPatch(block),
        pageId,
      ]);
    }),
    ...before
      .filter((block) => !afterById.has(block.id))
      .map((block) => durableRemoteCall("deleteBlockRemote", [block.id, pageId])),
  ]);
}

// Debounced persistence. Pending patches are *accumulated and merged* per id so
// that (a) an immediate write flushes and cancels any pending debounced write
// (no stale-closure clobber), and (b) edits to different fields of the same row
// within the debounce window are not lost (e.g. title vs properties).
const blockTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pageTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pageFlushes = new Map<string, Promise<void>>();
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
// Derived block lists memoized on the source array's identity — see
// topLevelBlocks/childBlocks. Bounded by page/parent count; entries for
// deleted pages are tiny and harmless.
const EMPTY_BLOCK_LIST: Block[] = [];
const topLevelBlocksCache = new Map<string, { source: Block[]; result: Block[] }>();
const childBlocksCache = new Map<string, { source: Block[]; result: Block[] }>();

// Comments load SWR-style: a repeat loadComments call refreshes in the
// background (deduped + rate-limited) instead of early-returning forever, so
// a collaborator's new comment shows up without a full reload.
const commentLoadPromises = new Map<string, Promise<void>>();
const commentFetchedAt = new Map<string, number>();
const COMMENT_REFRESH_MIN_GAP_MS = 1500;
const pendingBlock = new Map<string, Partial<Block>>();
// Owning page per pending block — routing hint for the workspace-DO split.
const pendingBlockPage = new Map<string, string>();
// Server stamp of the block when its pending patch was FIRST enqueued.
// Mirrored into the durable outbox so a crash/offline replay can send the
// optimistic-concurrency guard (expectedUpdatedAt) — a replayed full-field
// patch must not silently clobber what another device wrote meanwhile.
const pendingBlockBase = new Map<string, string>();
const pendingPage = new Map<string, Partial<Page>>();
const PERSIST_RETRY_MS = 2000;

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
// resolved with pickLabels at call time (locale cannot change mid-session).
const STORE_MESSAGES = {
  en: {
    databaseLockedSave: "This database is locked, so your changes couldn't be saved.",
    databaseRowsLoadFailed: "Couldn't load database rows. Please try again in a moment.",
    editAccessDeniedSave: "You don't have edit access, so your changes couldn't be saved.",
    lockedSave: "The page or database is locked, so your changes couldn't be saved.",
    pageLockedSave: "This page is locked, so your changes couldn't be saved.",
    pageMissingSave: "The page couldn't be found, so your changes couldn't be saved.",
    saveFailed: "Your changes couldn't be saved.",
    sessionExpired: "Your session expired or the request couldn't be authenticated. Please try again.",
    blockConflictSave:
      "This block was edited on another device, so your offline change wasn't applied.",
    blockConflictKeepMine: "Apply my version",
    blockMoveCommentsSkipped: "The block moved, but its comments couldn't be moved with it.",
  },
  ko: {
    databaseLockedSave: "데이터베이스가 잠겨 있어 변경 사항을 저장하지 못했어요.",
    databaseRowsLoadFailed: "데이터베이스 행을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    editAccessDeniedSave: "편집 권한이 없어 변경 사항을 저장하지 못했어요.",
    lockedSave: "페이지나 데이터베이스가 잠겨 있어 변경 사항을 저장하지 못했어요.",
    pageLockedSave: "페이지가 잠겨 있어 변경 사항을 저장하지 못했어요.",
    pageMissingSave: "페이지를 찾을 수 없어 변경 사항을 저장하지 못했어요.",
    saveFailed: "변경 사항을 저장하지 못했어요.",
    sessionExpired: "세션이 만료되었거나 인증 요청이 실패했습니다. 다시 시도해 주세요.",
    blockConflictSave: "다른 기기에서 이 블록이 수정되어 오프라인 변경을 적용하지 못했어요.",
    blockConflictKeepMine: "내 변경 적용",
    blockMoveCommentsSkipped: "블록은 이동했지만 댓글은 함께 옮기지 못했어요.",
  },
} as const;

function storeMessages() {
  return pickLabels(STORE_MESSAGES);
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
  if (status === 403) return storeMessages().editAccessDeniedSave;
  if (status === 409 || status === 423) return storeMessages().lockedSave;
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

function mirrorPendingPage(id: string) {
  const patch = pendingPage.get(id);
  if (!patch || !Object.keys(patch).length) return;
  const page = useStore.getState().pagesById[id];
  outboxSet(outboxUserId(), `page:${id}`, {
    id,
    kind: "page_update",
    patch: persistablePagePatch(patch, page),
    target: page?.parentType === "database" ? "database_row" : "page",
  });
}

function mirrorPendingBlock(id: string) {
  const patch = pendingBlock.get(id);
  if (!patch || !Object.keys(patch).length) return;
  outboxSet(outboxUserId(), `block:${id}`, {
    expectedUpdatedAt: pendingBlockBase.get(id),
    hintPageId: pendingBlockPage.get(id),
    id,
    kind: "block_update",
    patch: persistableBlockPatch(patch),
  });
}

function retryPage(id: string) {
  if (pageTimers.has(id)) return;
  pageTimers.set(id, setTimeout(() => void flushPage(id), PERSIST_RETRY_MS));
}

function retryBlock(id: string) {
  if (blockTimers.has(id)) return;
  blockTimers.set(id, setTimeout(() => void flushBlock(id), PERSIST_RETRY_MS));
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
  const patch = pendingPage.get(id);
  pendingPage.delete(id);
  if (patch && Object.keys(patch).length) {
    try {
      const page = useStore.getState().pagesById[id];
      const persistablePatch = persistablePagePatch(patch, page);
      if (page?.parentType === "database") {
        await updateDatabaseRowRemote(id, persistablePatch);
      } else {
        await updatePageRemote(id, persistablePatch);
      }
      publishPersistedPageMutation(id, patch, page);
      outboxAck(outboxUserId(), `page:${id}`);
      if (pendingPage.has(id)) mirrorPendingPage(id);
      noteSyncSuccess();
    } catch (error) {
      if (shouldDropPersistError(error)) {
        notifyPersistDrop(error);
        outboxAck(outboxUserId(), `page:${id}`);
        if (pendingPage.has(id)) mirrorPendingPage(id);
        return;
      }
      noteSyncFailure();
      pendingPage.set(id, { ...patch, ...(pendingPage.get(id) ?? {}) });
      mirrorPendingPage(id);
      retryPage(id);
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
  publishLocalDatabaseMutation({
    databaseId,
    kind: "database_templates_changed",
    reason,
    revision: Date.now(),
    updatedAt: nowIso(),
  });
}

async function flushBlock(id: string) {
  const t = blockTimers.get(id);
  if (t) {
    clearTimeout(t);
    blockTimers.delete(id);
  }
  const patch = pendingBlock.get(id);
  const hintPageId = pendingBlockPage.get(id);
  pendingBlock.delete(id);
  if (patch && Object.keys(patch).length) {
    try {
      await updateBlockRemote(id, persistableBlockPatch(patch), hintPageId);
      // The server stored this patch's stamp; edits enqueued after this flush
      // conflict-check against it, not the pre-flush base.
      if (pendingBlock.has(id)) {
        if (typeof patch.updatedAt === "string") pendingBlockBase.set(id, patch.updatedAt);
        mirrorPendingBlock(id);
      } else {
        pendingBlockBase.delete(id);
        pendingBlockPage.delete(id);
      }
      outboxAck(outboxUserId(), `block:${id}`);
      noteSyncSuccess();
    } catch (error) {
      if (shouldDropPersistError(error)) {
        notifyPersistDrop(error);
        pendingBlockBase.delete(id);
        outboxAck(outboxUserId(), `block:${id}`);
        if (pendingBlock.has(id)) mirrorPendingBlock(id);
        return;
      }
      noteSyncFailure();
      pendingBlock.set(id, { ...patch, ...(pendingBlock.get(id) ?? {}) });
      mirrorPendingBlock(id);
      retryBlock(id);
    }
  } else {
    pendingBlockPage.delete(id);
    pendingBlockBase.delete(id);
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
  outboxAck(outboxUserId(), `block:${id}`);
}

// One-shot block create/delete persistence with the same transient-vs-terminal
// retry policy as flushBlock/flushPage. addBlockLocal and deleteBlock used to be
// fire-and-forget (`.catch(() => {})`), so a transient network/auth blip
// silently lost a just-created block (or an unpersisted delete) with no retry
// and no toast — the block reappeared/vanished on the next reload.
const pendingBlockCreate = new Map<string, Block>();
const blockCreateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const blockCreateInFlight = new Map<string, Promise<void>>();

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
      await createBlockRemote(block);
      pendingBlockCreate.delete(id);
      outboxAck(outboxUserId(), `create:${id}`);
      noteSyncSuccess();
    } catch (error) {
      if (shouldDropPersistError(error)) {
        pendingBlockCreate.delete(id);
        outboxAck(outboxUserId(), `create:${id}`);
        // 409 on create means the id already exists server-side — a retried or
        // replayed create whose earlier attempt landed. That is idempotent
        // success (client UUIDs), not a user-facing drop.
        if (persistErrorStatus(error) !== 409) notifyPersistDrop(error);
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

function persistBlockCreate(block: Block) {
  pendingBlockCreate.set(block.id, block);
  outboxSet(outboxUserId(), `create:${block.id}`, { block, kind: "block_create" });
  void flushBlockCreate(block.id);
}

function cancelPendingBlockCreate(id: string) {
  const t = blockCreateTimers.get(id);
  if (t) {
    clearTimeout(t);
    blockCreateTimers.delete(id);
  }
  pendingBlockCreate.delete(id);
  outboxAck(outboxUserId(), `create:${id}`);
}

async function runBlockDelete(ids: string[], hintPageId?: string, opKey?: string) {
  try {
    await deleteBlocksRemote(ids, hintPageId);
    if (opKey) outboxAck(outboxUserId(), opKey);
    noteSyncSuccess();
  } catch (error) {
    if (shouldDropPersistError(error)) {
      if (opKey) outboxAck(outboxUserId(), opKey);
      // 404 is expected when the blocks were never persisted or already gone;
      // only surface genuine permission/lock drops to the user.
      if (persistErrorStatus(error) !== 404) notifyPersistDrop(error);
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
  opts?: { debounce?: boolean }
) {
  updatePage(pageId, {}, { debounce: opts?.debounce ?? true });
}

/** Flush every pending debounced write immediately (e.g. before unload). */
export async function flushAllPending() {
  await Promise.allSettled([
    ...Array.from(pageFlushes.values()),
    ...Array.from(blockCreateInFlight.values()),
    ...Array.from(pendingPage.keys()).map((id) => flushPage(id)),
    ...Array.from(pendingBlock.keys()).map((id) => flushBlock(id)),
    ...Array.from(pendingBlockCreate.keys()).map((id) => flushBlockCreate(id)),
  ]);
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
  await Promise.allSettled([outboxClear(userId), recordCacheClear(userId)]);
  try {
    window.localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // Local storage is optional.
  }
}

/** Test hook: allow a fresh bootstrap after resetStore (bootPromise is module state). */
export function resetBootstrapForTests() {
  bootPromise = null;
  bootKey = "";
}

// ── offline scope warmer (local-first Phase 3 v2) ───────────────────────────
// After an online boot, eagerly cache the pages the user is most likely to
// need offline: pinned pages, favorites, and recents — plus the databases
// they embed. Sequential and capped; delta-sync-lite makes repeat warms
// nearly free (unchanged pages skip their refetch).

const WARM_MAX_PAGES = 30;
const WARM_MAX_DATABASES = 10;

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
      // Warmers are best-effort; the outbox/caches cover the rest.
    }
    for (const block of useStore.getState().blocksByPage[pageId] ?? []) {
      const childId = block.content?.childPageId;
      if (childId && useStore.getState().pagesById[childId]?.kind === "database") {
        dbIds.add(childId);
      }
    }
  }
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
  if (page.kind === "database") {
    dbIds.push(pageId);
  } else {
    const stamp = await cacheGetMeta<string>(userId, `blocksStamp:${pageId}`);
    if (!stamp) return false;
    const records = await cacheListTable<Block>(userId, `blocks:${pageId}`);
    for (const record of records) {
      const childId = record.value.content?.childPageId;
      if (childId && useStore.getState().pagesById[childId]?.kind === "database") {
        dbIds.push(childId);
      }
    }
  }
  for (const dbId of dbIds) {
    const [propsRecords, keys] = await Promise.all([
      cacheListTable(userId, `props:${dbId}`),
      cacheGetMeta<Array<{ h: string }>>(userId, `rowsKeys:${dbId}`),
    ]);
    if (!propsRecords.length || !keys?.length) return false;
  }
  return true;
}

async function warmOfflineScope(userId: string) {
  try {
    const pins = await getOfflinePins(userId);
    const state = useStore.getState();
    const favorites = Object.values(state.pagesById)
      .filter((page) => page.isFavorite && !page.inTrash)
      .map((page) => page.id);
    const targets = [
      ...new Set([...Object.keys(pins), ...favorites, ...state.recentPageIds.slice(0, 10)]),
    ]
      .filter((id) => {
        const page = state.pagesById[id];
        return !!page && !page.inTrash;
      })
      .slice(0, WARM_MAX_PAGES);
    const dbIds = new Set<string>();
    for (const pageId of targets) {
      for (const dbId of await warmPageOfflineScope(pageId)) dbIds.add(dbId);
    }
    for (const dbId of [...dbIds].slice(0, WARM_MAX_DATABASES)) {
      try {
        await useStore.getState().loadDatabase(dbId, {});
      } catch {
        // Best-effort.
      }
    }
  } catch {
    // Warming must never break boot.
  }
}

export async function replayDurableOutbox(userId: string) {
  const entries = await outboxClaimAbandoned(userId);
  for (const entry of entries) {
    // Sequential on purpose: enqueue order is the causality order (a create
    // replays before a later update or delete that references it).
    await replayOutboxOp(userId, entry.entryKey, entry.value).catch(() => {});
  }
}

async function replayOutboxOp(userId: string, entryKey: string, op: OutboxOp) {
  switch (op.kind) {
    case "page_update": {
      if (pendingPage.has(op.id) || useStore.getState().pagesById[op.id]) {
        pendingPage.set(op.id, { ...op.patch, ...(pendingPage.get(op.id) ?? {}) });
        mirrorPendingPage(op.id);
        await flushPage(op.id);
        return;
      }
      await replayRemote(userId, entryKey, op, async () => {
        if (op.target === "database_row") await updateDatabaseRowRemote(op.id, op.patch);
        else await updatePageRemote(op.id, op.patch);
      });
      return;
    }
    case "block_update": {
      if (pendingBlock.has(op.id)) {
        pendingBlock.set(op.id, { ...op.patch, ...(pendingBlock.get(op.id) ?? {}) });
        if (op.hintPageId && !pendingBlockPage.has(op.id)) {
          pendingBlockPage.set(op.id, op.hintPageId);
        }
        mirrorPendingBlock(op.id);
        await flushBlock(op.id);
        return;
      }
      await replayRemote(userId, entryKey, op, async () => {
        // Replayed offline edits carry the optimistic-concurrency guard: if the
        // block changed on another device meanwhile, the server 409s and the
        // conflict path below keeps the server version + offers "apply mine".
        await updateBlockRemote(op.id, op.patch, op.hintPageId, op.expectedUpdatedAt);
      });
      return;
    }
    case "block_create":
      await replayRemote(userId, entryKey, op, async () => {
        await createBlockRemote(op.block);
      });
      return;
    case "block_delete":
      await replayRemote(userId, entryKey, op, async () => {
        await deleteBlocksRemote(op.ids, op.hintPageId);
      });
      return;
    case "remote_call": {
      const entry = DURABLE_REMOTE_CALLS[op.fn];
      if (!entry) {
        // Unknown fn (schema drift across app versions) — drop rather than
        // wedge the replay loop on an op we can no longer execute.
        outboxAck(userId, entryKey);
        return;
      }
      await replayRemote(userId, entryKey, op, async () => {
        await entry.fn(...op.args);
      });
      return;
    }
  }
}

function replayDropIsBenign(op: OutboxOp, status: number | undefined) {
  // A replayed create that 409s already landed before the crash; a replayed
  // delete that 404s is already gone. Neither is a user-facing failure.
  if (op.kind === "block_create" && status === 409) return true;
  if (op.kind === "block_delete" && status === 404) return true;
  if (op.kind === "remote_call" && status !== undefined) {
    return DURABLE_REMOTE_CALLS[op.fn]?.benign.includes(status) ?? false;
  }
  return false;
}

async function replayRemote(
  userId: string,
  entryKey: string,
  op: OutboxOp,
  run: () => Promise<void>
) {
  try {
    await run();
    outboxAck(userId, entryKey);
    noteSyncSuccess();
  } catch (error) {
    if (shouldDropPersistError(error)) {
      outboxAck(userId, entryKey);
      if (
        op.kind === "block_update" &&
        op.expectedUpdatedAt &&
        persistErrorStatus(error) === 409
      ) {
        handleBlockReplayConflict(op);
        return;
      }
      if (!replayDropIsBenign(op, persistErrorStatus(error))) notifyPersistDrop(error);
      return;
    }
    noteSyncFailure();
    // Transient: the claimed entry stays durable under this tab; retry like the
    // live queues do.
    setTimeout(() => void replayRemote(userId, entryKey, op, run), PERSIST_RETRY_MS);
  }
}

/**
 * A replayed offline block edit lost the optimistic-concurrency race: another
 * device changed the block after this patch was queued. Default to the server
 * version (refetch so the user sees current truth) and offer a one-click
 * "apply my version" that re-sends the local patch without the guard.
 */
function handleBlockReplayConflict(op: Extract<OutboxOp, { kind: "block_update" }>) {
  const pageId = op.hintPageId;
  if (pageId) void reloadBlocksFromServer(pageId);
  const messages = storeMessages();
  useStore.getState().notify(messages.blockConflictSave, "error", {
    label: messages.blockConflictKeepMine,
    onClick: async () => {
      try {
        await updateBlockRemote(op.id, op.patch, pageId);
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
  await useStore.getState().loadBlocks(pageId, { force: true }).catch(() => {});
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
// `benign` lists terminal statuses that mean "already applied" when an op is
// retried or replayed: 409 for creates (duplicate client UUID), 404 for
// deletes/trash/restore (target already gone).

type DurableRemoteFn = (...args: never[]) => Promise<unknown>;
type DurableRemoteEntry = { benign: number[]; fn: (...args: unknown[]) => Promise<unknown> };

function durableEntry(fn: DurableRemoteFn, benign: number[]): DurableRemoteEntry {
  return { benign, fn: fn as unknown as (...args: unknown[]) => Promise<unknown> };
}

const DURABLE_REMOTE_CALLS: Record<string, DurableRemoteEntry> = {
  createBlockRemote: durableEntry(createBlockRemote, [409]),
  createBlocksRemote: durableEntry(createBlocksRemote, [404, 409]),
  createCommentRemote: durableEntry(createCommentRemote, [409]),
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
  restoreDatabaseRowRemote: durableEntry(restoreDatabaseRowRemote, [404]),
  restorePageRemote: durableEntry(restorePageRemote, [404]),
  trashDatabaseRowRemote: durableEntry(trashDatabaseRowRemote, [404]),
  trashPageRemote: durableEntry(trashPageRemote, [404]),
  updateBlockRemote: durableEntry(updateBlockRemote, [404, 409]),
  updateBlocksRemote: durableEntry(updateBlocksRemote, [404, 409]),
  deleteCommentsRemote: durableEntry(deleteCommentsRemote, [404]),
  updateCommentRemote: durableEntry(updateCommentRemote, [404]),
  updateCommentsRemote: durableEntry(updateCommentsRemote, [404]),
  updatePageRemote: durableEntry(updatePageRemote, [404]),
  updatePropertyRemote: durableEntry(updatePropertyRemote, [404]),
  updateTemplateRemote: durableEntry(updateTemplateRemote, [404]),
  updateViewRemote: durableEntry(updateViewRemote, [404]),
};

type DurableCallResult =
  | { result: unknown; status: "ok" }
  | { status: "queued" }
  | { error: unknown; status: "dropped" };

/**
 * Run a whitelisted remote mutation with durable-outbox backing.
 * - ok: the call landed; `result` is the remote return value.
 * - queued: transient failure; the op is durable and retries in the background
 *   (background completions apply no local merge — the next refetch reconciles).
 * - dropped: terminal failure; the op was removed and (unless benign) toasted.
 */
async function durableRemoteCall(
  fnKey: keyof typeof DURABLE_REMOTE_CALLS & string,
  args: unknown[]
): Promise<DurableCallResult> {
  const entry = DURABLE_REMOTE_CALLS[fnKey];
  const opKey = `call:${newId()}`;
  outboxSet(outboxUserId(), opKey, { args, fn: fnKey, kind: "remote_call" });
  try {
    const result = await entry.fn(...args);
    outboxAck(outboxUserId(), opKey);
    noteSyncSuccess();
    return { result, status: "ok" };
  } catch (error) {
    if (shouldDropPersistError(error)) {
      outboxAck(outboxUserId(), opKey);
      if (!entry.benign.includes(persistErrorStatus(error) ?? -1)) notifyPersistDrop(error);
      return { error, status: "dropped" };
    }
    noteSyncFailure();
    setTimeout(() => void retryDurableRemoteCall(opKey, fnKey, args), PERSIST_RETRY_MS);
    return { status: "queued" };
  }
}

async function retryDurableRemoteCall(opKey: string, fnKey: string, args: unknown[]) {
  const entry = DURABLE_REMOTE_CALLS[fnKey];
  if (!entry) return;
  try {
    await entry.fn(...args);
    outboxAck(outboxUserId(), opKey);
    noteSyncSuccess();
  } catch (error) {
    if (shouldDropPersistError(error)) {
      outboxAck(outboxUserId(), opKey);
      if (!entry.benign.includes(persistErrorStatus(error) ?? -1)) notifyPersistDrop(error);
      return;
    }
    noteSyncFailure();
    setTimeout(() => void retryDurableRemoteCall(opKey, fnKey, args), PERSIST_RETRY_MS);
  }
}

// ── record-cache hydration (local-first Phase 1) ────────────────────────────
// Server-fetched record sets mirror into the per-user record cache; cold boots
// hydrate from it instantly and refetch in the background. Cached reads are
// overlaid with still-queued outbox mutations so offline reads reflect offline
// writes (the cache itself is only rewritten from server responses).

type WorkspaceBootstrapResult = Awaited<ReturnType<typeof bootstrapWorkspace>>;

const LAST_USER_KEY = "notionlike.lastUserId";

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
    setLocalEncryptionMode("passphrase");
    primeUnlockedGate(userId, result.box);
    resetOutboxForTests();
    resetRecordCacheForTests();
    await recordCacheClear(userId);
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
    await recordCacheClear(userId);
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
  if (!useStore.getState().ready) {
    resetBootstrapForTests();
    await useStore.getState().bootstrap(input);
    return;
  }
  if (userId) {
    void replayDurableOutbox(userId).catch(() => {});
    void warmOfflineScope(userId);
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
  previousServerPageIds?: Set<string>
) {
  const {
    userId,
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
    pages = [],
    pageRoles = {},
    sharedPageIds = [],
  } = result;
  setWorkspacePeople(members, organizationProfiles);
  const pagesById: Record<string, Page> = {};
  for (const p of pages) pagesById[p.id] = p;

  if (mode === "reconcile") {
    // The app is already live (rendered from cache): refresh workspace-level
    // state without resetting per-page caches. Server wins per page id, but
    // local-only pages (queued offline creates) and still-pending debounced
    // patches survive the refresh. Pages the server KNEW before but no longer
    // returns were deleted or un-shared remotely — drop them.
    useStore.setState((s) => {
      const merged = { ...s.pagesById };
      if (previousServerPageIds) {
        for (const id of Object.keys(merged)) {
          if (!pagesById[id] && previousServerPageIds.has(id) && !pendingPage.has(id)) {
            delete merged[id];
          }
        }
      }
      for (const [id, page] of Object.entries(pagesById)) {
        const pending = pendingPage.get(id);
        merged[id] =
          pending && Object.keys(pending).length ? { ...page, ...pending } : page;
      }
      return {
        ready: true,
        workspace: ws,
        activeDataScope: { kind: "workspace" as const, workspaceId: ws.id },
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
        pagesById: merged,
        pageRolesById: { ...s.pageRolesById, ...pageRoles },
        sharedPageIds: new Set(sharedPageIds),
      };
    });
    return;
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
  useStore.setState({
    ready: true,
    workspace: ws,
    activeDataScope: { kind: "workspace", workspaceId: ws.id },
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
    hydratedRelationTargetIds: new Set(),
    commentPanel: undefined,
  });
}

/** Merge still-queued outbox page patches over a cached page list. */
function overlayOutboxOnPages(entries: OutboxEntry[], pages: Page[]): Page[] {
  if (!entries.length) return pages;
  const patches = new Map<string, Partial<Page>>();
  for (const entry of entries) {
    const op = entry.value;
    if (op.kind !== "page_update") continue;
    patches.set(op.id, { ...(patches.get(op.id) ?? {}), ...op.patch });
  }
  if (!patches.size) return pages;
  return pages.map((page) => {
    const patch = patches.get(page.id);
    return patch ? { ...page, ...patch } : page;
  });
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
  const cached = await cacheGetMeta<WorkspaceBootstrapResult>(userId, `bootstrap:${key}`);
  return cached?.workspace && Array.isArray(cached.pages) ? cached : null;
}

/**
 * Un-render a cache-hydrated boot that the server refuted with a definitive
 * denial (401/403/404): reset everything `applyBootstrapResult` set so the
 * denial screen is not backed by cached data the server just refused —
 * possibly a previous account's on a shared browser.
 */
function discardHydratedBoot() {
  setWorkspacePeople([], []);
  useStore.setState({
    ready: false,
    userId: "",
    workspace: undefined,
    activeDataScope: undefined,
    workspaces: [],
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
    hydratedRelationTargetIds: new Set(),
    commentPanel: undefined,
  });
}

async function hydrateBootstrapFromCache(
  key: string,
  blob: WorkspaceBootstrapResult | null
): Promise<boolean> {
  if (!blob || useStore.getState().ready) return false;
  const userId = useStore.getState().userId || readLastUserId();
  if (!userId) return false;
  const entries = await outboxAllEntries(userId);
  applyBootstrapResult(
    { ...blob, pages: overlayOutboxOnPages(entries, blob.pages ?? []) },
    "initial"
  );
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
let workspaceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let workspaceRefreshInFlight = false;
let workspaceRefreshedAt = 0;
let bootInputForRefresh: WorkspaceBootstrapInput = {};

async function refreshWorkspaceDelta() {
  if (workspaceRefreshInFlight) return;
  const activeState = useStore.getState();
  if (
    !activeState.ready ||
    activeState.activeDataScope?.kind === "public_share" ||
    !bootKey
  ) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  workspaceRefreshInFlight = true;
  try {
    const key = bootKey;
    const blob = await readBootstrapBlob(key);
    const watermark = blob?.pagesSyncedAt;
    // No cached baseline to delta against — leave full fetches to the boot path.
    if (!blob || !watermark) return;
    const changesCursor = blob.changesSyncedAt ?? "";
    let result = await bootstrapWorkspace({
      ...bootInputForRefresh,
      pagesSince: watermark,
      ...(changesCursor ? { changesSince: changesCursor } : {}),
    });
    // Workspace switched while the fetch was in flight: discard.
    if (bootKey !== key || !useStore.getState().ready) return;
    // Nothing changed since the cursor: advance the cursor cache but do NOT
    // touch store state — replacing workspaceMembers/pagesById with fresh
    // identities every poll would re-render subscribers and (worse) bounce
    // the presence room, which re-joins when the member array changes.
    const state = useStore.getState();
    const quietDelta =
      result.pagesDelta &&
      (result.changedPages?.length ?? 0) === 0 &&
      (result.deletedPageIds?.length ?? 0) === 0 &&
      JSON.stringify(result.members ?? []) === JSON.stringify(state.workspaceMembers) &&
      JSON.stringify(result.pageRoles ?? {}) === JSON.stringify(state.pageRolesById) &&
      JSON.stringify((result.sharedPageIds ?? []).slice().sort()) ===
        JSON.stringify(Array.from(state.sharedPageIds).sort());
    if (result.pagesDelta) {
      const resolved = resolveBootstrapDelta(blob, result);
      if (!resolved) return; // unresolvable (new visible page) → next boot refetches fully
      result = resolved;
    }
    applyBootFeedHints(result, changesCursor);
    if (!quietDelta) {
      applyBootstrapResult(
        result,
        "reconcile",
        new Set((blob.pages ?? []).map((page) => page.id))
      );
    }
    cacheSetMeta(result.userId, `bootstrap:${key}`, bootstrapBlobForCache(result));
    workspaceRefreshedAt = Date.now();
  } catch {
    // Transient (offline, auth refresh): the next tick retries.
  } finally {
    workspaceRefreshInFlight = false;
  }
}

function startWorkspaceRefreshLoop() {
  if (workspaceRefreshTimer !== null || typeof window === "undefined") return;
  const tick = () => {
    workspaceRefreshTimer = setTimeout(() => {
      void refreshWorkspaceDelta().finally(tick);
    }, WORKSPACE_REFRESH_MS);
  };
  tick();
  const refreshIfStale = () => {
    if (Date.now() - workspaceRefreshedAt < WORKSPACE_REFRESH_MIN_GAP_MS) return;
    void refreshWorkspaceDelta();
  };
  window.addEventListener("focus", refreshIfStale);
  window.addEventListener("online", refreshIfStale);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshIfStale();
  });
}

function overlayOutboxOnBlocks(entries: OutboxEntry[], pageId: string, blocks: Block[]): Block[] {
  if (!entries.length) return blocks;
  let next = blocks;
  for (const entry of entries) {
    const op = entry.value;
    if (op.kind === "block_update") {
      next = next.map((block) => (block.id === op.id ? { ...block, ...op.patch } : block));
    } else if (op.kind === "block_create" && op.block.pageId === pageId) {
      if (!next.some((block) => block.id === op.block.id)) next = [...next, op.block];
    } else if (op.kind === "block_delete") {
      const ids = new Set(op.ids);
      next = next.filter((block) => !ids.has(block.id));
    } else if (op.kind === "remote_call" && op.fn === "createBlocksRemote") {
      // Composite paste/replace/column/tab creation is queued as one durable
      // batch. Overlay that batch during an offline reload just like individual
      // block_create entries; otherwise the data is safe on disk but appears
      // to vanish until reconnect, violating the local-first no-loss contract.
      const batch = Array.isArray(op.args[0]) ? op.args[0] : [];
      for (const candidate of batch) {
        if (!candidate || typeof candidate !== "object") continue;
        const block = candidate as Block;
        if (block.pageId !== pageId || typeof block.id !== "string") continue;
        const index = next.findIndex((current) => current.id === block.id);
        if (index >= 0) {
          next = next.map((current, currentIndex) => (currentIndex === index ? block : current));
        } else {
          next = [...next, block];
        }
      }
    }
  }
  return next.slice().sort(bySortPos);
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
  const stamp = await cacheGetMeta<string>(userId, `blocksStamp:${pageId}`);
  if (!stamp) return false;
  const page = useStore.getState().pagesById[pageId];
  return !!page?.updatedAt && page.updatedAt === stamp;
}

async function hydrateBlocksFromCache(pageId: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId) return false;
  const records = await cacheListTable<Block>(userId, `blocks:${pageId}`);
  if (!records.length) return false;
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

async function hydrateDatabaseMetaFromCache(dbId: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId) return false;
  const [props, views, templates, metaStamp] = await Promise.all([
    cacheListTable<DbProperty>(userId, `props:${dbId}`),
    cacheListTable<DbView>(userId, `views:${dbId}`),
    cacheListTable<DbTemplate>(userId, `templates:${dbId}`),
    cacheGetMeta<string>(userId, `dbMetaStamp:${dbId}`),
  ]);
  lastHydratedDbMetaFeedStamp.set(dbId, metaStamp ?? "");
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

interface CachedRowsMeta {
  hasMore: boolean;
  nextOffset?: number;
  queryKey: string;
  rowIds: string[];
  totalCount?: number;
  /** Session change-feed cursor at write time (skip-hint eligibility, §7 v2). */
  feedStamp?: string;
}

// Per-db stamps observed while hydrating this boot (consumed by feed skips).
const lastHydratedRowsFeedStamp = new Map<string, string>();
const lastHydratedDbMetaFeedStamp = new Map<string, string>();

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
  normalized: { currentPageId: string; search: string; viewId: string }
): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId) return false;
  const baseKey = databaseRowsQueryKey({});
  if (queryKey === baseKey) return false;
  const suffix = hashCacheKey(baseKey);
  const meta = await cacheGetMeta<CachedRowsMeta>(userId, `rows:${dbId}:${suffix}`);
  if (!meta || meta.queryKey !== baseKey || meta.hasMore) return false;
  const [rowRecords, relatedRecords, entries] = await Promise.all([
    cacheListTable<Page>(userId, `rowsdata:${dbId}:${suffix}`),
    cacheListTable<Page>(userId, `rowsrelated:${dbId}:${suffix}`),
    outboxAllEntries(userId),
  ]);
  const rows = overlayOutboxOnPages(entries, rowRecords.map((record) => record.value));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  if (meta.rowIds.some((id) => !rowsById.has(id))) return false;

  const state = useStore.getState();
  const props = state.propsByDb[dbId] ?? [];
  const view = normalized.viewId
    ? (state.viewsByDb[dbId] ?? []).find((item) => item.id === normalized.viewId)
    : undefined;
  if (normalized.viewId && !view) return false;
  if (!props.length) return false;

  const related = overlayOutboxOnPages(entries, relatedRecords.map((record) => record.value));
  const baseRows = meta.rowIds
    .map((id) => rowsById.get(id))
    .filter((row): row is Page => !!row);
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
      const pending = pendingPage.get(row.id);
      pagesById[row.id] = {
        ...row,
        __databaseRowOrder: index + 1,
        ...(pending && Object.keys(pending).length ? pending : {}),
      };
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

async function hydrateDatabaseRowsFromCache(dbId: string, queryKey: string): Promise<boolean> {
  const userId = outboxUserId();
  if (!userId) return false;
  // Per-view caches (Phase 3 v2): each first-page query caches under its own
  // key hash so offline view switching works beyond the last-used view.
  const suffix = hashCacheKey(queryKey);
  const meta = await cacheGetMeta<CachedRowsMeta>(userId, `rows:${dbId}:${suffix}`);
  if (!meta || meta.queryKey !== queryKey) return false;
  lastHydratedRowsFeedStamp.set(dbId, meta.feedStamp ?? "");
  const [rowRecords, relatedRecords, entries] = await Promise.all([
    cacheListTable<Page>(userId, `rowsdata:${dbId}:${suffix}`),
    cacheListTable<Page>(userId, `rowsrelated:${dbId}:${suffix}`),
    outboxAllEntries(userId),
  ]);
  const rows = overlayOutboxOnPages(entries, rowRecords.map((record) => record.value));
  const related = overlayOutboxOnPages(entries, relatedRecords.map((record) => record.value));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  // Never-show-partial: a cache that lost any listed row is not renderable —
  // fall through to the network (or the offline error state) instead of
  // silently showing a subset.
  if (meta.rowIds.some((id) => !rowsById.has(id))) return false;
  const rowIds = meta.rowIds;
  useStore.setState((s) => {
    const current = s.databaseRowPagesByDb[dbId];
    if (current?.queryKey !== queryKey) return {};
    if ((s.databaseRowIdsByDb[dbId] ?? []).length) return {};
    const pagesById = { ...s.pagesById };
    for (const page of related) {
      pagesById[page.id] = pagesById[page.id] ?? page;
    }
    rowIds.forEach((id, index) => {
      const row = rowsById.get(id);
      if (!row) return;
      const pending = pendingPage.get(id);
      pagesById[id] = {
        ...row,
        __databaseRowOrder: index + 1,
        ...(pending && Object.keys(pending).length ? pending : {}),
      };
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
const databaseRowLoadMorePromises = new Map<string, Promise<void>>();
const databaseRowsQueryPromises = new Map<string, Promise<void>>();
const DATABASE_INITIAL_ROW_LIMIT = 50;
const DATABASE_ROW_LOAD_MORE_LIMIT = 50;

export type DatabaseRowsQuery = {
  viewId?: string;
  search?: string;
  currentPageId?: string;
  force?: boolean;
  limit?: number;
  offset?: number;
  reset?: boolean;
};

export type LoadDatabaseOptions = {
  force?: boolean;
  rows?: boolean;
  viewIds?: string[];
};

type DatabaseRowPageState = {
  queryKey?: string;
  loadedCount: number;
  totalCount?: number;
  hasMore: boolean;
  nextOffset?: number;
  loading?: boolean;
  loadingMore?: boolean;
  error?: string;
};

function databaseRowPageSatisfiesInitialLoad(
  current: DatabaseRowPageState | undefined,
  queryKey: string,
  limit: number
) {
  if (!current || current.queryKey !== queryKey || current.error) return false;
  if (current.loading || current.loadingMore) return true;
  if (current.totalCount !== undefined) {
    return current.loadedCount >= Math.min(limit, current.totalCount);
  }
  if (current.loadedCount === 0 && current.hasMore === false) return true;
  return current.loadedCount > 0 && (current.loadedCount >= limit || current.hasMore === false);
}

function normalizeDatabaseRowsQuery(query: DatabaseRowsQuery = {}) {
  return {
    viewId: query.viewId?.trim() || "",
    search: query.search?.trim() || "",
    currentPageId: query.currentPageId?.trim() || "",
  };
}

export function databaseRowsQueryKey(query: DatabaseRowsQuery = {}) {
  return JSON.stringify(normalizeDatabaseRowsQuery(query));
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

interface AppState {
  ready: boolean;
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
  /** Small global status toasts for Notion-like action feedback. */
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
    | { kind: "workspace"; workspaceId: string }
    | { kind: "public_share"; shareKey: string; workspaceId: string };
  workspaces: Workspace[];
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
    title?: string;
    kind?: PageKind;
    afterPosition?: number;
    beforePosition?: number;
    focusTarget?: FocusPageTarget;
    focusTitle?: boolean;
  }) => Promise<Page>;
  applyRemotePage: (page: Page) => void;
  applyRemotePagePatch: (id: string, patch: Partial<Page>) => void;
  refreshWorkspacePages: () => Promise<void>;
  refreshPageAccess: (pageId: string) => Promise<void>;
  applySharedPageSnapshot: (snapshot: SharedPageResult, shareKey: string) => void;
  updatePage: (id: string, patch: Partial<Page>, opts?: { debounce?: boolean }) => void;
  trashPage: (id: string) => Promise<void>;
  restorePage: (id: string) => Promise<void>;
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
    opts?: { debounce?: boolean; history?: BlockHistoryMode | false }
  ) => void;
  applyRemoteBlockText: (
    id: string,
    patch: Pick<Partial<Block>, "content" | "plainText" | "updatedAt">
  ) => void;
  applyRemoteBlockStructure: (
    pageId: string,
    operation: CollaborationBlockStructureOperation
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

  // comments ------------------------------------------------------------
  loadComments: (pageId: string, opts?: { force?: boolean }) => Promise<void>;
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
  hydratedRelationTargetIds: Set<string>;
  loadDatabase: (dbId: string, options?: LoadDatabaseOptions) => Promise<void>;
  loadDatabaseRows: (dbId: string, query?: DatabaseRowsQuery) => Promise<void>;
  loadMoreDatabaseRows: (dbId: string, query?: DatabaseRowsQuery) => Promise<void>;
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
    seedRows?: boolean;
    properties?: Parameters<typeof createDatabaseRemote>[0]["properties"];
  }) => Promise<Page>;
  addProperty: (dbId: string, type: PropertyType, name: string, config?: PropertyConfig) => Promise<DbProperty>;
  updateProperty: (id: string, patch: Partial<DbProperty>) => void;
  deleteProperty: (id: string) => Promise<DeletedPropertySnapshot | null>;
  restoreDeletedProperty: (snapshot: DeletedPropertySnapshot) => Promise<boolean>;
  deletePropertyOption: (propertyId: string, optionId: string) => Promise<DeletedPropertyOptionSnapshot | null>;
  restoreDeletedPropertyOption: (snapshot: DeletedPropertyOptionSnapshot) => Promise<boolean>;
  addView: (
    dbId: string,
    type: ViewType,
    name?: string,
    opts?: { config?: ViewConfig; position?: number }
  ) => Promise<DbView>;
  updateView: (id: string, patch: Partial<DbView>) => void;
  deleteView: (id: string) => Promise<DbView | null>;
  restoreDeletedView: (view: DbView) => Promise<boolean>;
  addTemplate: (dbId: string, name?: string) => Promise<DbTemplate>;
  duplicateTemplate: (id: string) => Promise<DbTemplate | null>;
  updateTemplate: (id: string, patch: Partial<DbTemplate>) => void;
  deleteTemplate: (id: string) => Promise<DbTemplate | null>;
  restoreDeletedTemplate: (template: DbTemplate) => Promise<boolean>;
  addRow: (
    dbId: string,
    atEnd?: boolean,
    templateId?: string,
    opts?: { focusTitle?: boolean }
  ) => Promise<Page>;
  moveDatabaseRow: (rowId: string, targetId: string, side: "before" | "after") => Promise<Page | undefined>;
  setRowProperty: (
    rowId: string,
    propId: string,
    value: unknown,
    opts?: { debounce?: boolean }
  ) => void;
  setRelation: (rowId: string, prop: DbProperty, nextIds: string[]) => void;
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

function canCreatePageInState(
  state: AppState,
  parentId: string | null | undefined,
  userId = state.userId
) {
  if (state.activeDataScope?.kind === "public_share") return false;
  if (parentId) {
    return canEditPageInState(state, state.pagesById[parentId], userId);
  }
  return canCreateWorkspacePage({
    workspace: state.workspace,
    currentMember: state.currentMember,
    userId,
  });
}

export const useStore = create<AppState>((set, get) => ({
  ready: false,
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
        set({
          ready: false,
          workspace: next,
          currentMember: undefined,
          workspaceMembers: [],
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
          hydratedRelationTargetIds: new Set(),
          commentPanel: undefined,
        });
        return next;
      }
    }
    rememberWorkspaceCache(undefined);
    set({
      ready: false,
      workspace: undefined,
      currentMember: undefined,
      workspaceMembers: [],
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
      const hydrated = await hydrateBootstrapFromCache(key, blob);
      try {
        let result = await resultPromise;
        if (result.pagesDelta) {
          // Materialize the delta over the cached blob; anything unresolvable
          // (newly visible page we never cached) falls back to a full fetch.
          result = resolveBootstrapDelta(blob, result) ?? (await bootstrapWorkspace(input));
        }
        applyBootFeedHints(result, changesCursor);
        applyBootstrapResult(
          result,
          hydrated ? "reconcile" : "initial",
          blob ? new Set((blob.pages ?? []).map((page) => page.id)) : undefined
        );
        rememberLastUserId(result.userId);
        cacheSetMeta(result.userId, `bootstrap:${key}`, bootstrapBlobForCache(result));
        bootInputForRefresh = input;
        workspaceRefreshedAt = Date.now();
        startWorkspaceRefreshLoop();
        // Local-first Phase 0: replay mutations left durably queued by tabs
        // that died before flushing. Fire-and-forget: never blocks boot.
        void replayDurableOutbox(result.userId).catch(() => {});
        // Phase 3 v2: eagerly cache pins/favorites/recents for offline use.
        void warmOfflineScope(result.userId);
      } catch (error) {
        if (!hydrated) throw error;
        // Hydrated render + failed fetch: only a transient/offline failure
        // lets the cache stand (Phase 2 offline boot). A definitive server
        // denial means this actor cannot see the requested workspace/page —
        // un-render the cached data (a revoked share, or a previous account
        // on this browser), drop the refuted blob so the next boot fails
        // fast, and surface the denial to the caller.
        const status = persistErrorStatus(error);
        if (status === 401 || status === 403 || status === 404) {
          const cacheOwnerId = blob?.userId || useStore.getState().userId || "";
          if (cacheOwnerId) cacheSetMeta(cacheOwnerId, `bootstrap:${key}`, null);
          discardHydratedBoot();
          throw error;
        }
        const cachedUserId = useStore.getState().userId;
        if (cachedUserId) void replayDurableOutbox(cachedUserId).catch(() => {});
      }
    })().catch((e) => {
      bootPromise = null; // allow retry after a failed bootstrap
      bootKey = "";
      throw e;
    });
    return bootPromise;
  },

  // ── pages ───────────────────────────────────────────────────────────
  childPages(parentId) {
    const all = Object.values(get().pagesById);
    return all
      .filter(
        (p) =>
          !p.inTrash &&
          (parentId === null
            ? p.parentType === "workspace" || p.parentId == null
            : p.parentId === parentId && p.parentType === "page")
      )
      .sort(bySortPos);
  },

  recentPages() {
    const pagesById = get().pagesById;
    return get()
      .recentPageIds.map((id) => pagesById[id])
      .filter((page): page is Page => !!page && !page.inTrash);
  },

  recordPageVisit(id) {
    const page = get().pagesById[id];
    if (!page || page.inTrash) return;
    set((s) => {
      const recentPageIds = [id, ...s.recentPageIds.filter((item) => item !== id)].slice(0, RECENT_LIMIT);
      writeRecentPageIds(s.workspace?.id, recentPageIds);
      return { recentPageIds };
    });
  },

  favoritePages() {
    return Object.values(get().pagesById)
      .filter((p) => p.isFavorite && !p.inTrash)
      .sort(bySortPos);
  },

  trashedPages() {
    const pagesById = get().pagesById;
    return Object.values(pagesById)
      .filter((p) => p.inTrash)
      .filter((p) => !hasTrashedAncestor(pagesById, p))
      .sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""));
  },

  async createPage(opts) {
    const ws = get().workspace;
    if (!ws) throw new Error("no workspace");
    const userId = get().userId || (await ensureAuth());
    if (userId && userId !== get().userId) set({ userId });
    if (!canCreatePageInState(get(), opts.parentId, userId)) {
      throw new Error("Page access required.");
    }
    if (opts.parentId && get().pagesById[opts.parentId]?.isLocked) {
      throw new Error("Page is locked.");
    }
    const id = newId();
    const now = nowIso();
    const position = positionBetween(opts.afterPosition, opts.beforePosition);
    const page: Page = {
      id,
      createdAt: now,
      updatedAt: now,
      workspaceId: ws.id,
      parentId: opts.parentId,
      parentType: opts.parentType,
      kind: opts.kind ?? "page",
      title: opts.title ?? "",
      iconType: "none",
      font: "default",
      smallText: false,
      fullWidth: false,
      isLocked: false,
      backlinksDisplay: "default",
      pageCommentsDisplay: "default",
      position,
      isFavorite: false,
      isPublic: false,
      inTrash: false,
      createdBy: userId || undefined,
      lastEditedBy: userId || undefined,
    };
    const focusTarget = opts.focusTarget ?? (opts.focusTitle === false ? undefined : "title");
    set((s) => ({
      pagesById: { ...s.pagesById, [id]: page },
      pageRolesById: { ...s.pageRolesById, [id]: "edit" },
      ...(focusTarget ? { focusPageId: id, focusPageTarget: focusTarget } : {}),
      ...(page.kind === "page"
        ? {
            blocksByPage: { ...s.blocksByPage, [id]: [] },
            loadedBlockPages: new Set(s.loadedBlockPages).add(id),
          }
        : {}),
    }));
    const call = await durableRemoteCall("createPageRemote", [page]);
    if (call.status === "dropped") {
      // Terminal server rejection: roll the optimistic page back and surface
      // the original error to the caller like the previous plain await did.
      set((s) => {
        const pagesById = { ...s.pagesById };
        delete pagesById[id];
        return { pagesById };
      });
      throw call.error;
    }
    // queued: the create is durable and retrying; the local page is usable now.
    const persisted = call.status === "ok" ? (call.result as Page) : undefined;
    set((s) => ({
      pagesById: { ...s.pagesById, [id]: { ...page, ...(persisted ?? {}) } },
      pageRolesById: { ...s.pageRolesById, [id]: "edit" },
    }));
    return { ...page, ...(persisted ?? {}) };
  },

  applyRemotePage(page) {
    set((s) => ({ pagesById: { ...s.pagesById, [page.id]: page } }));
  },

  applyRemotePagePatch(id, patch) {
    set((s) => {
      const current = s.pagesById[id];
      if (!current) return {};
      return { pagesById: { ...s.pagesById, [id]: { ...current, ...patch } } };
    });
  },

  // Re-fetch the workspace page list and merge it into the tree. Needed after
  // server-side bulk writes (e.g. a Notion import) that bypass local actions.
  async refreshWorkspacePages() {
    if (get().activeDataScope?.kind === "public_share") return;
    const ws = get().workspace;
    if (!ws) return;
    const { pages = [], pageRoles = {}, sharedPageIds = [] } = await bootstrapWorkspace({ workspaceId: ws.id });
    set((s) => {
      const pagesById = { ...s.pagesById };
      for (const page of pages) pagesById[page.id] = page;
      return {
        activeDataScope: { kind: "workspace" as const, workspaceId: ws.id },
        pagesById,
        pageRolesById: { ...s.pageRolesById, ...pageRoles },
        sharedPageIds: new Set(sharedPageIds),
      };
    });
  },

  async refreshPageAccess(pageId) {
    if (get().activeDataScope?.kind === "public_share") return;
    const targetPageId = pageId.trim();
    if (!targetPageId) return;
    const {
      workspace: ws,
      currentMember,
      members = [],
      pages = [],
      pageRoles = {},
      sharedPageIds = [],
      workspaces = [],
      organizationProfiles = [],
    } = await bootstrapWorkspace({ pageId: targetPageId });
    setWorkspacePeople(members, organizationProfiles);
    set((s) => {
      const pagesById = { ...s.pagesById };
      for (const page of pages) pagesById[page.id] = page;
      return {
        workspace: ws,
        activeDataScope: { kind: "workspace" as const, workspaceId: ws.id },
        currentMember,
        workspaceMembers: members,
        workspaces: workspaces.length ? workspaces : s.workspaces,
        pagesById,
        pageRolesById: { ...s.pageRolesById, ...pageRoles },
        sharedPageIds: new Set(sharedPageIds),
      };
    });
  },

  applySharedPageSnapshot(snapshot, shareKey) {
    const blocksByPage = new Map<string, Block[]>();
    for (const block of snapshot.blocks ?? []) {
      const list = blocksByPage.get(block.pageId) ?? [];
      list.push(block);
      blocksByPage.set(block.pageId, list);
    }
    const propsByDb = new Map<string, DbProperty[]>();
    for (const prop of snapshot.properties ?? []) {
      const list = propsByDb.get(prop.databaseId) ?? [];
      list.push(prop);
      propsByDb.set(prop.databaseId, list);
    }
    const viewsByDb = new Map<string, DbView[]>();
    for (const view of snapshot.views ?? []) {
      const list = viewsByDb.get(view.databaseId) ?? [];
      list.push(view);
      viewsByDb.set(view.databaseId, list);
    }
    const templatesByDb = new Map<string, DbTemplate[]>();
    for (const template of snapshot.templates ?? []) {
      const list = templatesByDb.get(template.databaseId) ?? [];
      list.push(template);
      templatesByDb.set(template.databaseId, list);
    }

    set(() => {
      const workspaceId = snapshot.page.workspaceId;
      // Public data is a separate mounted scope, not a merge into the signed-in
      // workspace cache. Filter defensively to the root workspace and replace
      // every page-derived map so a prior private page/role/database cannot
      // leak into the public tree or influence rendering.
      const scopedPages = [snapshot.page, ...(snapshot.pages ?? [])].filter(
        (page, index, all) =>
          page.workspaceId === workspaceId && all.findIndex((candidate) => candidate.id === page.id) === index
      );
      const pagesById = Object.fromEntries(scopedPages.map((page) => [page.id, page]));
      const scopedPageIds = new Set(Object.keys(pagesById));

      const nextBlocksByPage: Record<string, Block[]> = {};
      const loadedBlockPages = new Set<string>();
      for (const page of scopedPages) {
        nextBlocksByPage[page.id] = (blocksByPage.get(page.id) ?? []).sort(bySortPos);
        loadedBlockPages.add(page.id);
      }

      const nextPropsByDb: Record<string, DbProperty[]> = {};
      const nextViewsByDb: Record<string, DbView[]> = {};
      const nextTemplatesByDb: Record<string, DbTemplate[]> = {};
      const databaseRowIdsByDb: Record<string, string[]> = {};
      const databaseRowPagesByDb: Record<string, DatabaseRowPageState> = {};
      const loadedDbs = new Set<string>();
      const metadataDbIds = new Set<string>([
        ...Array.from(propsByDb.keys()).filter((id) => scopedPageIds.has(id)),
        ...Array.from(viewsByDb.keys()).filter((id) => scopedPageIds.has(id)),
        ...Array.from(templatesByDb.keys()).filter((id) => scopedPageIds.has(id)),
        ...scopedPages
          .filter((page) => page.kind === "database")
          .map((page) => page.id),
      ]);
      for (const dbId of metadataDbIds) {
        nextPropsByDb[dbId] = (propsByDb.get(dbId) ?? []).sort(bySortPos);
        nextViewsByDb[dbId] = (viewsByDb.get(dbId) ?? []).sort(bySortPos);
        nextTemplatesByDb[dbId] = (templatesByDb.get(dbId) ?? []).sort(bySortPos);
        const rowIds = scopedPages
          .filter((row) => row.parentType === "database" && row.parentId === dbId && !row.inTrash)
          .sort(bySortPos)
          .map((row) => row.id);
        databaseRowIdsByDb[dbId] = rowIds;
        databaseRowPagesByDb[dbId] = {
          loadedCount: rowIds.length,
          totalCount: rowIds.length,
          hasMore: false,
        };
        loadedDbs.add(dbId);
      }

      return {
        activeDataScope: { kind: "public_share" as const, shareKey, workspaceId },
        pagesById,
        pageRolesById: {},
        sharedPageIds: new Set<string>(),
        recentPageIds: [],
        treeExpandedPageIds: new Set<string>(),
        blocksByPage: nextBlocksByPage,
        loadedBlockPages,
        blockHistoryByPage: {},
        commentsByPage: {},
        loadedCommentPages: new Set<string>(),
        commentPanel: undefined,
        propsByDb: nextPropsByDb,
        viewsByDb: nextViewsByDb,
        templatesByDb: nextTemplatesByDb,
        databaseRowIdsByDb,
        databaseRowPagesByDb,
        loadedDbs,
        hydratedRelationTargetIds: new Set<string>(),
      };
    });
  },

  updatePage(id, patch, opts) {
    const cur = get().pagesById[id];
    if (!cur) return;
    if (!canEditPageInState(get(), cur)) {
      get().notify(storeMessages().editAccessDeniedSave, "default");
      return;
    }
    if (cur.isLocked && !lockedPageAllowsPatch(patch)) {
      get().notify(storeMessages().pageLockedSave, "default");
      return;
    }
    const userId = get().userId;
    const nextPatch: Partial<Page> = { ...patch };
    if (!("updatedAt" in nextPatch)) nextPatch.updatedAt = nowIso();
    if (userId && !("lastEditedBy" in nextPatch)) nextPatch.lastEditedBy = userId;
    const invalidatesComputed = "properties" in nextPatch;
    const localPatch = invalidatesComputed ? { ...nextPatch, __computed: undefined } : nextPatch;
    set((s) => {
      const pagesById = invalidatesComputed ? stripComputedFromPages(s.pagesById) : s.pagesById;
      return { pagesById: { ...pagesById, [id]: { ...cur, ...localPatch } } };
    });
    if (isTemplateEditorPageId(id)) return;
    pendingPage.set(id, { ...(pendingPage.get(id) ?? {}), ...nextPatch });
    mirrorPendingPage(id);
    if (opts?.debounce) {
      const t = pageTimers.get(id);
      if (t) clearTimeout(t);
      pageTimers.set(id, setTimeout(() => void flushPage(id), 500));
    } else {
      void flushPage(id);
    }
  },

  async trashPage(id) {
    const pagesById = get().pagesById;
    const root = pagesById[id];
    if (!root) return;
    if (!canEditPageInState(get(), root)) throw new Error("Page access required.");
    const ts = nowIso();
    const userId = get().userId;
    const patches: Array<{ id: string; patch: Partial<Page> }> = [];

    for (const pageId of collectPageSubtree(pagesById, id)) {
      const page = pagesById[pageId];
      if (!page || (page.inTrash && pageId !== id)) continue;
      await flushPage(pageId);
      const patch: Partial<Page> = {
        inTrash: true,
        trashedAt: ts,
        updatedAt: ts,
        ...(userId ? { lastEditedBy: userId } : {}),
      };
      patches.push({ id: pageId, patch });
    }

    if (patches.length === 0) return;
    set((s) => {
      const next = { ...s.pagesById };
      for (const item of patches) {
        const page = next[item.id];
        if (page) next[item.id] = { ...page, ...item.patch };
      }
      return { pagesById: next };
    });
    const trashCall = await durableRemoteCall(
      root.parentType === "database" ? "trashDatabaseRowRemote" : "trashPageRemote",
      [id]
    );
    const persisted = trashCall.status === "ok" ? (trashCall.result as Page[]) : [];
    if (persisted.length) {
      set((s) => {
        const next = { ...s.pagesById };
        for (const page of persisted) next[page.id] = { ...(next[page.id] ?? page), ...page };
        return { pagesById: next };
      });
    }
  },

  async restorePage(id) {
    const pagesById = get().pagesById;
    const root = pagesById[id];
    if (!root) return;
    const restoreStamp = root.trashedAt;
    const now = nowIso();
    const userId = get().userId;
    const patches: Array<{ id: string; patch: Partial<Page> }> = [];

    for (const pageId of collectPageSubtree(pagesById, id)) {
      const page = pagesById[pageId];
      if (!page?.inTrash) continue;
      if (pageId !== id && restoreStamp && page.trashedAt !== restoreStamp) continue;
      await flushPage(pageId);
      const patch: Partial<Page> = {
        inTrash: false,
        trashedAt: null,
        updatedAt: now,
        ...(userId ? { lastEditedBy: userId } : {}),
      };
      patches.push({ id: pageId, patch });
    }

    if (patches.length === 0) return;
    set((s) => {
      const next = { ...s.pagesById };
      for (const item of patches) {
        const page = next[item.id];
        if (page) next[item.id] = { ...page, ...item.patch };
      }
      return { pagesById: next };
    });
    const restoreCall = await durableRemoteCall(
      root.parentType === "database" ? "restoreDatabaseRowRemote" : "restorePageRemote",
      [id]
    );
    const persisted = restoreCall.status === "ok" ? (restoreCall.result as Page[]) : [];
    if (persisted.length) {
      set((s) => {
        const next = { ...s.pagesById };
        for (const page of persisted) next[page.id] = { ...(next[page.id] ?? page), ...page };
        return { pagesById: next };
      });
    }
  },

  async deletePage(id) {
    // also clears descendants via FK CASCADE on blocks; pages are flat so we
    // remove the subtree client-side too.
    const root = get().pagesById[id];
    const toRemove = new Set<string>();
    const collect = (pid: string) => {
      toRemove.add(pid);
      for (const c of Object.values(get().pagesById))
        if (c.parentId === pid) collect(c.id);
    };
    collect(id);
    for (const pid of toRemove) cancelPendingPage(pid);
    set((s) => {
      const pagesById = { ...s.pagesById };
      for (const pid of toRemove) delete pagesById[pid];
      return { pagesById };
    });
    await durableRemoteCall(
      root?.parentType === "database" ? "deleteDatabaseRowRemote" : "deletePageRemote",
      [id]
    );
  },

  async emptyTrash() {
    // Permanently delete every top-level trashed page; deletePage removes each
    // subtree, so nested trashed pages are covered by their trashed root.
    const roots = get().trashedPages();
    for (const page of roots) {
      await get().deletePage(page.id);
    }
  },

  async duplicatePage(id) {
    const source = get().pagesById[id];
    if (!source) return null;
    if (!canEditPageInState(get(), source)) return null;
    if (isPageParentLocked(get().pagesById, source.parentId)) return null;
    const useRemoteDuplicate = true;
    if (useRemoteDuplicate) {
      const result = await duplicatePageRemote(id);
      if (!result.page) return null;
      const duplicatedPage = result.page;
      const blocksByNewPage = new Map<string, Block[]>();
      for (const block of result.blocks ?? []) {
        const list = blocksByNewPage.get(block.pageId) ?? [];
        list.push(block);
        blocksByNewPage.set(block.pageId, list);
      }
      const propsByDb = new Map<string, DbProperty[]>();
      for (const prop of result.properties ?? []) {
        const list = propsByDb.get(prop.databaseId) ?? [];
        list.push(prop);
        propsByDb.set(prop.databaseId, list);
      }
      const viewsByDb = new Map<string, DbView[]>();
      for (const view of result.views ?? []) {
        const list = viewsByDb.get(view.databaseId) ?? [];
        list.push(view);
        viewsByDb.set(view.databaseId, list);
      }
      const templatesByDb = new Map<string, DbTemplate[]>();
      for (const template of result.templates ?? []) {
        const list = templatesByDb.get(template.databaseId) ?? [];
        list.push(template);
        templatesByDb.set(template.databaseId, list);
      }

      set((s) => {
        const pagesById = { ...s.pagesById };
        for (const page of result.pages ?? []) pagesById[page.id] = page;
        pagesById[duplicatedPage.id] = duplicatedPage;

        const blocksByPage = { ...s.blocksByPage };
        const loadedBlockPages = new Set(s.loadedBlockPages);
        for (const [pageId, blocks] of blocksByNewPage) {
          blocksByPage[pageId] = blocks.sort(bySortPos);
          loadedBlockPages.add(pageId);
        }

        const nextPropsByDb = { ...s.propsByDb };
        const nextViewsByDb = { ...s.viewsByDb };
        const nextTemplatesByDb = { ...s.templatesByDb };
        let databaseRowIdsByDb = s.databaseRowIdsByDb;
        const loadedDbs = new Set(s.loadedDbs);
        for (const [dbId, props] of propsByDb) {
          nextPropsByDb[dbId] = props.sort(bySortPos);
          loadedDbs.add(dbId);
        }
        for (const [dbId, views] of viewsByDb) {
          nextViewsByDb[dbId] = views.sort(bySortPos);
          loadedDbs.add(dbId);
        }
        for (const [dbId, templates] of templatesByDb) {
          nextTemplatesByDb[dbId] = templates.sort(bySortPos);
          loadedDbs.add(dbId);
        }
        const sourceDatabaseId =
          source.parentType === "database" &&
          typeof source.parentId === "string" &&
          source.parentId === duplicatedPage.parentId
            ? source.parentId
            : undefined;
        if (sourceDatabaseId) {
          const ids = s.databaseRowIdsByDb[sourceDatabaseId] ?? [];
          const sourceIndex = ids.indexOf(source.id);
          const nextIds = ids.filter((id) => id !== duplicatedPage.id);
          nextIds.splice(sourceIndex >= 0 ? sourceIndex + 1 : nextIds.length, 0, duplicatedPage.id);
          databaseRowIdsByDb = { ...s.databaseRowIdsByDb, [sourceDatabaseId]: nextIds };
        }

        return {
          pagesById,
          blocksByPage,
          loadedBlockPages,
          propsByDb: nextPropsByDb,
          viewsByDb: nextViewsByDb,
          templatesByDb: nextTemplatesByDb,
          databaseRowIdsByDb,
          loadedDbs,
        };
      });
      return duplicatedPage;
    }
    const actorId = get().userId || (await ensureAuth());
    if (actorId && actorId !== get().userId) set({ userId: actorId });

    const sameParent = Object.values(get().pagesById)
      .filter(
        (p) =>
          !p.inTrash &&
          p.id !== id &&
          p.parentId === source.parentId &&
          p.parentType === source.parentType
      )
      .sort(bySortPos);
    const after = source.position;
    const before = sameParent.find((p) => p.position > source.position)?.position;
    const dbSnapshotCache = new Map<string, ReturnType<typeof getDatabaseSnapshotRemote>>();

    function loadDatabaseSnapshot(dbId: string) {
      const cached = dbSnapshotCache.get(dbId);
      if (cached) return cached;
      const promise = getDatabaseSnapshotRemote(dbId);
      dbSnapshotCache.set(dbId, promise);
      return promise;
    }

    async function loadPageBlocks(pageId: string) {
      const cached = get().blocksByPage[pageId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await getPageBlocksRemote(pageId)).blocks.sort(bySortPos);
    }

    async function loadDbProps(dbId: string) {
      const cached = get().propsByDb[dbId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await loadDatabaseSnapshot(dbId)).properties.sort(bySortPos);
    }

    async function loadDbViews(dbId: string) {
      const cached = get().viewsByDb[dbId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await loadDatabaseSnapshot(dbId)).views.sort(bySortPos);
    }

    async function loadDbTemplates(dbId: string) {
      const cached = get().templatesByDb[dbId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await loadDatabaseSnapshot(dbId)).templates.sort(bySortPos);
    }

    function cloneValue<T>(value: T): T {
      if (value == null) return value;
      if (typeof structuredClone === "function") return structuredClone(value);
      return JSON.parse(JSON.stringify(value)) as T;
    }

    function remapRelationValue(value: unknown, pageMap?: Map<string, string>) {
      if (!pageMap) return value;
      if (Array.isArray(value)) {
        return value.map((id) => pageMap.get(String(id)) ?? id);
      }
      if (value == null || value === "") return value;
      return pageMap.get(String(value)) ?? value;
    }

    function remapProperties(
      properties: Record<string, unknown> | undefined,
      propMap?: Map<string, string>,
      pageMap?: Map<string, string>,
      propsById?: Map<string, DbProperty>
    ) {
      const cloned = cloneValue(properties ?? {});
      if (!propMap) return cloned;
      const remapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(cloned)) {
        const prop = propsById?.get(key);
        remapped[propMap.get(key) ?? key] =
          prop?.type === "relation" ? remapRelationValue(value, pageMap) : value;
      }
      return remapped;
    }

    function remapTemplateBlocks(
      blocks: ButtonTemplateBlock[] | undefined,
      pageMap?: Map<string, string>
    ): ButtonTemplateBlock[] | undefined {
      if (!blocks) return blocks;
      return cloneValue(blocks).map((block) => ({
        ...block,
        content: remapBlockContent(block.content, pageMap),
        children: remapTemplateBlocks(block.children, pageMap),
      }));
    }

    function remapViewConfig(config: ViewConfig | undefined, propMap: Map<string, string>) {
      return remapViewConfigPropertyIds(config, propMap);
    }

    function remapPropertyConfig(
      config: PropertyConfig | undefined,
      propMap: Map<string, string>,
      sourceDbId: string,
      targetDbId: string
    ): PropertyConfig | undefined {
      if (!config) return config;
      const next = cloneValue(config);
      if (next.relationDatabaseId === sourceDbId) next.relationDatabaseId = targetDbId;
      if (next.rollupRelationPropertyId) {
        next.rollupRelationPropertyId =
          propMap.get(next.rollupRelationPropertyId) ?? next.rollupRelationPropertyId;
      }
      if (next.rollupTargetPropertyId) {
        next.rollupTargetPropertyId =
          propMap.get(next.rollupTargetPropertyId) ?? next.rollupTargetPropertyId;
      }
      if (next.rollupVia) next.rollupVia = propMap.get(next.rollupVia) ?? next.rollupVia;
      return next;
    }

    async function duplicateTree(
      sourceId: string,
      parentId: string | null,
      parentType: PageParentType,
      position: number,
      title?: string,
      propMap?: Map<string, string>,
      pageMap?: Map<string, string>,
      propsById?: Map<string, DbProperty>
    ): Promise<Page> {
      const cur = get().pagesById[sourceId];
      if (!cur) throw new Error("page not found");
      const now = nowIso();
      const newPageId = pageMap?.get(sourceId) ?? newId();
      pageMap?.set(sourceId, newPageId);
      const childPages = Object.values(get().pagesById)
        .filter((p) => p.parentType === "page" && p.parentId === cur.id && !p.inTrash)
        .sort(bySortPos);
      const sourceRows =
        cur.kind === "database"
          ? Object.values(get().pagesById)
              .filter((p) => p.parentType === "database" && p.parentId === cur.id && !p.inTrash)
              .sort(bySortPos)
          : [];
      for (const child of childPages) {
        if (!pageMap?.has(child.id)) pageMap?.set(child.id, newId());
      }
      for (const row of sourceRows) {
        if (!pageMap?.has(row.id)) pageMap?.set(row.id, newId());
      }

      const newPage: Page = {
        id: newPageId,
        createdAt: now,
        updatedAt: now,
        workspaceId: cur.workspaceId,
        parentId,
        parentType,
        kind: cur.kind,
        title: title ?? cur.title,
        icon: cur.icon,
        iconType: cur.iconType,
        cover: cur.cover,
        coverPosition: cur.coverPosition,
        font: cur.font ?? "default",
        smallText: !!cur.smallText,
        fullWidth: !!cur.fullWidth,
        isLocked: false,
        backlinksDisplay: cur.backlinksDisplay ?? "default",
        pageCommentsDisplay: cur.pageCommentsDisplay ?? "default",
        properties: remapProperties(cur.properties, propMap, pageMap, propsById),
        isFavorite: false,
        isPublic: false,
        inTrash: false,
        position,
        createdBy: actorId || undefined,
        lastEditedBy: actorId || undefined,
      };

      set((s) => ({ pagesById: { ...s.pagesById, [newPage.id]: newPage } }));
      const persistedPage = await createPageRemote(newPage);
      set((s) => ({
        pagesById: { ...s.pagesById, [newPage.id]: { ...newPage, ...persistedPage } },
      }));

      const blocks = await loadPageBlocks(cur.id);
      const blockIdMap = new Map<string, string>();
      for (const block of blocks) blockIdMap.set(block.id, newId());
      const newBlocks: Block[] = blocks.map((block) => ({
        id: blockIdMap.get(block.id) as string,
        createdAt: now,
        updatedAt: now,
        pageId: newPage.id,
        parentId: block.parentId ? blockIdMap.get(block.parentId) ?? null : null,
        type: block.type,
        content: remapBlockContent(block.content, pageMap, blockIdMap),
        plainText: block.plainText,
        position: block.position,
        createdBy: actorId || undefined,
      }));
      if (newBlocks.length) {
        set((s) => ({
          blocksByPage: { ...s.blocksByPage, [newPage.id]: newBlocks },
          loadedBlockPages: new Set(s.loadedBlockPages).add(newPage.id),
        }));
        await createBlocksRemote(newBlocks);
      }

      let dbPropMap: Map<string, string> | undefined;
      if (cur.kind === "database") {
        const props = await loadDbProps(cur.id);
        dbPropMap = new Map(props.map((prop) => [prop.id, newId()]));
        const newProps = props.map((prop) => ({
          ...prop,
          id: dbPropMap?.get(prop.id) as string,
          databaseId: newPage.id,
          config: remapPropertyConfig(prop.config, dbPropMap as Map<string, string>, cur.id, newPage.id),
        }));
        const views = await loadDbViews(cur.id);
        const newViews = views.map((view) => ({
          ...view,
          id: newId(),
          databaseId: newPage.id,
          config: remapViewConfig(view.config, dbPropMap as Map<string, string>),
        }));
        const templates = await loadDbTemplates(cur.id);
        const newTemplates = templates.map((template) => ({
          ...template,
          id: newId(),
          databaseId: newPage.id,
          properties: remapProperties(template.properties, dbPropMap, pageMap, new Map(props.map((prop) => [prop.id, prop]))),
          blocks: remapTemplateBlocks(template.blocks, pageMap),
        }));
        set((s) => ({
          propsByDb: { ...s.propsByDb, [newPage.id]: newProps },
          viewsByDb: { ...s.viewsByDb, [newPage.id]: newViews },
          templatesByDb: { ...s.templatesByDb, [newPage.id]: newTemplates },
          loadedDbs: new Set(s.loadedDbs).add(newPage.id),
        }));
        await Promise.all([
          ...newProps.map((prop) => createPropertyRemote(prop as Partial<DbProperty>)),
          ...newViews.map((view) => createViewRemote(view as Partial<DbView>)),
          ...newTemplates.map((template) => createTemplateRemote(template as Partial<DbTemplate>)),
        ]);

        const originalPropsById = new Map(props.map((prop) => [prop.id, prop]));
        for (const row of sourceRows) {
          await duplicateTree(
            row.id,
            newPage.id,
            "database",
            row.position,
            row.title,
            dbPropMap,
            pageMap,
            originalPropsById
          );
        }
      }

      for (const child of childPages) {
        await duplicateTree(child.id, newPage.id, "page", child.position, undefined, undefined, pageMap);
      }

      return newPage;
    }

    return duplicateTree(
      id,
      source.parentId ?? null,
      source.parentType,
      positionBetween(after, before),
      `${pageDisplayTitle(source)} copy`,
      undefined,
      new Map()
    );
  },

  async toggleFavorite(id) {
    const cur = get().pagesById[id];
    if (!cur) return;
    get().updatePage(id, { isFavorite: !cur.isFavorite });
  },

  async movePage(id, newParentId, newParentType, position) {
    const pagesById = get().pagesById;
    const cur = pagesById[id];
    if (!cur) return;
    if (!canEditPageInState(get(), cur)) return;
    if (!canCreatePageInState(get(), newParentId, get().userId)) return;
    if (isPageParentLocked(pagesById, cur.parentId)) return;
    if (isPageParentLocked(pagesById, newParentId)) return;
    const patch = {
      parentId: newParentId,
      parentType: newParentType,
      position,
    };
    get().updatePage(id, patch);
  },

  // ── blocks ──────────────────────────────────────────────────────────
  async loadBlocks(pageId, opts) {
    const force = opts?.force === true;
    if (!force && get().loadedBlockPages.has(pageId)) return;
    // Dedup is keyed by force-ness (like loadDatabase): a forced reload
    // (conflict recovery) must hit the network even when a plain load is in
    // flight, instead of being satisfied by its possibly-stale response.
    const promiseKey = `${pageId}:${force ? "force" : "cached"}`;
    const existing = blockLoadPromises.get(promiseKey);
    if (existing) return existing;
    const promise = (async () => {
      // SWR: render cached blocks (with queued outbox edits overlaid) right
      // away, then refresh from the server and reconcile. A forced reload
      // (conflict recovery) skips both the cache render and the fresh-skip.
      const hydrated = force ? false : await hydrateBlocksFromCache(pageId);
      if (hydrated && (await blocksCacheFresh(pageId))) return;
      try {
        const blocks = (await getPageBlocksRemote(pageId)).blocks.sort(bySortPos);
        set((s) => {
          const fetchedIds = new Set(blocks.map((block) => block.id));
          const optimisticBlocks = (s.blocksByPage[pageId] ?? []).filter(
            (block) => !fetchedIds.has(block.id)
          );
          // Overlay still-pending debounced edits so a patch typed between the
          // cache render and this refresh isn't visually reverted.
          const withPending = blocks.map((block) => {
            const pending = pendingBlock.get(block.id);
            return pending && Object.keys(pending).length ? { ...block, ...pending } : block;
          });
          return {
            blocksByPage: {
              ...s.blocksByPage,
              [pageId]: [...withPending, ...optimisticBlocks].sort(bySortPos),
            },
            loadedBlockPages: new Set(s.loadedBlockPages).add(pageId),
          };
        });
        cacheReplaceTable(
          outboxUserId(),
          `blocks:${pageId}`,
          blocks.map((block) => ({ id: block.id, value: block }))
        );
        stampBlocksCached(outboxUserId(), pageId);
        cacheSetMeta(
          outboxUserId(),
          `blocksStamp:${pageId}`,
          get().pagesById[pageId]?.updatedAt ?? ""
        );
      } catch (error) {
        // Offline with a cached render: the cache stands and queued edits
        // keep retrying; without a cache the caller sees the failure.
        if (!hydrated) throw error;
      }
    })().finally(() => {
      blockLoadPromises.delete(promiseKey);
    });
    blockLoadPromises.set(promiseKey, promise);
    return promise;
  },

  topLevelBlocks(pageId) {
    // Memoized on the page's block-array identity: repeated calls between
    // store writes return the SAME array, so useShallow subscribers don't
    // re-render the whole editor for unrelated store changes.
    const source = get().blocksByPage[pageId] ?? EMPTY_BLOCK_LIST;
    const cached = topLevelBlocksCache.get(pageId);
    if (cached && cached.source === source) return cached.result;
    const result = source.filter((b) => b.parentId == null).sort(bySortPos);
    topLevelBlocksCache.set(pageId, { source, result });
    return result;
  },

  childBlocks(pageId, parentId) {
    const source = get().blocksByPage[pageId] ?? EMPTY_BLOCK_LIST;
    const key = `${pageId}:${parentId}`;
    const cached = childBlocksCache.get(key);
    if (cached && cached.source === source) return cached.result;
    const result = source.filter((b) => b.parentId === parentId).sort(bySortPos);
    childBlocksCache.set(key, { source, result });
    return result;
  },

  addBlockLocal(opts) {
    const id = newId();
    const content = opts.content ?? { rich: [] };
    const now = nowIso();
    const block: Block = {
      id,
      createdAt: now,
      updatedAt: now,
      pageId: opts.pageId,
      parentId: opts.parentId ?? null,
      type: opts.type ?? "paragraph",
      content,
      plainText: opts.plainText ?? spansToPlainText(content.rich),
      position: opts.position,
      createdBy: get().userId,
    };
    if (opts.history !== false) {
      get().captureBlockStructureHistory(opts.pageId, {
        action: "create",
        blockIds: [block.id],
        before: [],
        after: [structureBlockSnapshot(block)],
      });
    }
    set((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        [opts.pageId]: [...(s.blocksByPage[opts.pageId] ?? []), block].sort(
          bySortPos
        ),
      },
    }));
    if (!isTemplateEditorPageId(opts.pageId)) {
      touchPageForBlockChange(get().updatePage, opts.pageId);
      if (opts.persist !== false) persistBlockCreate(block);
    }
    return block;
  },

  async createBlock(opts) {
    if (get().pagesById[opts.pageId]?.isLocked) {
      throw new Error("Page is locked.");
    }
    return get().addBlockLocal(opts);
  },

  async persistBlockCreateBatch(blocks) {
    if (blocks.length === 0) return;
    const persistable = blocks.filter((block) => !isTemplateEditorPageId(block.pageId));
    if (persistable.length === 0) return;
    // `durableRemoteCall` mirrors the full batch (including generated ids and
    // parent ids) before attempting the network call. A transient failure can
    // therefore replay the same graph after a crash/reload without losing a
    // child or racing it ahead of its parent.
    await durableRemoteCall("createBlocksRemote", [persistable]);
  },

  updateBlock(id, patch, opts) {
    let pageId = "";
    const current = get().blocksByPage;
    for (const pid of Object.keys(current)) {
      if (current[pid].some((b) => b.id === id)) {
        pageId = pid;
        break;
      }
    }
    if (!pageId) return;
    if (get().pagesById[pageId]?.isLocked) return;
    if (opts?.history !== false) {
      const currentBlock = current[pageId]?.find((b) => b.id === id);
      if (currentBlock && isStructureOnlyPatch(patch)) {
        const nextBlock = structureBlockSnapshot({
          ...currentBlock,
          ...patch,
          parentId: "parentId" in patch ? patch.parentId ?? null : currentBlock.parentId ?? null,
          updatedAt: "updatedAt" in patch ? patch.updatedAt : nowIso(),
        });
        get().captureBlockStructureHistory(pageId, {
          action: inferStructureAction([structureBlockSnapshot(currentBlock)], [nextBlock]),
          blockIds: [id],
          before: [structureBlockSnapshot(currentBlock)],
          after: [nextBlock],
        }, opts?.history ?? "push");
      } else {
        get().captureBlockHistory(pageId, opts?.history ?? "push");
      }
    }
    const nextPatch: Partial<Block> = { ...patch };
    if (!("updatedAt" in nextPatch)) nextPatch.updatedAt = nowIso();
    set((s) => {
      const next = { ...s.blocksByPage };
      const idx = next[pageId].findIndex((b) => b.id === id);
      const arr = next[pageId].slice();
      arr[idx] = { ...arr[idx], ...nextPatch };
      next[pageId] = arr.sort(bySortPos);
      return { blocksByPage: next };
    });
    if (isTemplateEditorPageId(pageId)) return;
    if (!pendingBlock.has(id)) {
      // First patch of this burst: remember the last server-known stamp so an
      // offline replay can detect that another device changed the block since.
      const base = current[pageId]?.find((b) => b.id === id)?.updatedAt;
      if (base) pendingBlockBase.set(id, base);
      else pendingBlockBase.delete(id);
    }
    pendingBlock.set(id, { ...(pendingBlock.get(id) ?? {}), ...nextPatch });
    if (pageId) pendingBlockPage.set(id, pageId);
    mirrorPendingBlock(id);
    touchPageForBlockChange(get().updatePage, pageId, opts);
    if (opts?.debounce) {
      const t = blockTimers.get(id);
      if (t) clearTimeout(t);
      blockTimers.set(id, setTimeout(() => void flushBlock(id), 400));
    } else {
      void flushBlock(id);
    }
  },

  applyRemoteBlockText(id, patch) {
    let pageId = "";
    const current = get().blocksByPage;
    for (const pid of Object.keys(current)) {
      if (current[pid].some((b) => b.id === id)) {
        pageId = pid;
        break;
      }
    }
    if (!pageId) return;
    if (get().pagesById[pageId]?.isLocked) return;
    cancelPendingBlock(id);

    set((s) => {
      const list = s.blocksByPage[pageId] ?? [];
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) return {};
      const arr = list.slice();
      arr[idx] = { ...arr[idx], ...patch };
      return {
        blocksByPage: {
          ...s.blocksByPage,
          [pageId]: arr.sort(bySortPos),
        },
      };
    });
  },

  // Forward-apply a collaborator's structure operation (indent/move/create/
  // delete/restore) from the op log. Same target semantics as a local redo of
  // the operation; never captures local history and never persists — the
  // origin client already did.
  applyRemoteBlockStructure(pageId, operation) {
    if (get().pagesById[pageId]?.isLocked) return;
    const loaded = get().blocksByPage[pageId];
    // Blocks not loaded yet: loadBlocks will fetch server truth including this
    // change, so applying a partial snapshot here would only fight it.
    if (!loaded) return;

    const toBlock = (payload: CollaborationBlockStructureBlock): Block =>
      structureBlockSnapshot({
        id: payload.id,
        pageId: payload.pageId,
        parentId: payload.parentId ?? null,
        type: (payload.type ?? "paragraph") as Block["type"],
        content: (payload.content ?? {}) as Block["content"],
        plainText: payload.plainText ?? "",
        position: payload.position,
        createdBy: payload.createdBy,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      } as Block);

    const target = historyOperationTarget(
      {
        action: operation.action,
        pageId,
        blockIds: operation.blockIds,
        before: (operation.before ?? []).map(toBlock),
        after: (operation.after ?? []).map(toBlock),
        occurredAt: "",
      },
      "redo"
    );

    const byId = new Map(loaded.map((block) => [block.id, block]));
    const removeIds = new Set(
      target.remove.filter((block) => block.pageId === pageId).map((block) => block.id)
    );
    const upsert = target.upsert.filter((block) => {
      // Op-log records are scoped to this page; ignore anything else.
      if (block.pageId !== pageId) return false;
      const current = byId.get(block.id);
      // A structural patch (move/indent) for a block we don't have would
      // resurrect it from a stale snapshot — skip; create/restore may insert.
      if (target.structuralOnly && !current) return false;
      // Don't let an older remote snapshot undo a newer local change.
      const localAt = Date.parse(current?.updatedAt ?? "");
      const remoteAt = Date.parse(block.updatedAt ?? "");
      if (Number.isFinite(localAt) && Number.isFinite(remoteAt) && remoteAt < localAt) {
        return false;
      }
      return true;
    });
    if (removeIds.size === 0 && upsert.length === 0) return;

    for (const id of removeIds) cancelPendingBlock(id);
    set((s) => {
      const removed = removeBlocksFromPages(s.blocksByPage, removeIds);
      return {
        blocksByPage: upsertBlocksIntoPages(removed, upsert, {
          structuralOnly: target.structuralOnly,
        }),
      };
    });
  },

  async deleteBlock(id, opts) {
    let pageId = "";
    const blocks = get().blocksByPage;
    const toRemove = new Set<string>();
    for (const [pid, list] of Object.entries(blocks)) {
      if (!list.some((b) => b.id === id)) continue;
      pageId = pid;
      const collect = (blockId: string) => {
        toRemove.add(blockId);
        for (const child of list) {
          if (child.parentId === blockId) collect(child.id);
        }
      };
      collect(id);
      break;
    }
    if (pageId && get().pagesById[pageId]?.isLocked) return;
    if (pageId && opts?.history !== false) {
      const removedBlocks = (blocks[pageId] ?? [])
        .filter((block) => toRemove.has(block.id))
        .map(structureBlockSnapshot);
      get().captureBlockStructureHistory(pageId, {
        action: "delete",
        blockIds: Array.from(toRemove),
        before: removedBlocks,
        after: [],
      }, opts?.history ?? "push");
    }
    for (const blockId of toRemove) cancelPendingBlock(blockId);
    if (pageId) {
      set((s) => ({
        blocksByPage: {
          ...s.blocksByPage,
          [pageId]: (s.blocksByPage[pageId] ?? []).filter((b) => !toRemove.has(b.id)),
        },
      }));
      if (!isTemplateEditorPageId(pageId)) touchPageForBlockChange(get().updatePage, pageId);
    }
    if (pageId && !isTemplateEditorPageId(pageId)) {
      await persistBlockDelete(Array.from(toRemove), pageId);
    }
  },

  async moveBlockToPage(id, targetPageId) {
    const targetPage = get().pagesById[targetPageId];
    if (!targetPage || targetPage.kind !== "page") return;

    let sourcePageId = "";
    for (const [pid, list] of Object.entries(get().blocksByPage)) {
      if (list.some((block) => block.id === id)) {
        sourcePageId = pid;
        break;
      }
    }
    if (!sourcePageId || sourcePageId === targetPageId) return;
    if (get().pagesById[sourcePageId]?.isLocked || targetPage.isLocked) return;

    await get().loadBlocks(targetPageId);
    const sourceBlocks = get().blocksByPage[sourcePageId] ?? [];
    const targetBlocks = get().blocksByPage[targetPageId] ?? [];
    const root = sourceBlocks.find((block) => block.id === id);
    if (!root) return;

    const movingIds = new Set<string>();
    const collect = (blockId: string) => {
      movingIds.add(blockId);
      for (const child of sourceBlocks) {
        if (child.parentId === blockId) collect(child.id);
      }
    };
    collect(id);
    const movedBlocks = sourceBlocks.filter((block) => movingIds.has(block.id));
    if (movedBlocks.length === 0) return;

    await Promise.all(Array.from(movingIds, (blockId) => flushBlock(blockId)));

    const lastTargetTop = targetBlocks
      .filter((block) => block.parentId == null)
      .sort(bySortPos)
      .at(-1);
    const rootPosition = positionBetween(lastTargetTop?.position, undefined);
    const updatedBlocks = movedBlocks.map((block) => ({
      ...block,
      pageId: targetPageId,
      parentId: block.id === id ? null : block.parentId,
      position: block.id === id ? rootPosition : block.position,
    }));

    // ONE logical undo unit: twin operation entries (shared link id) go onto
    // BOTH pages' stacks. Undo/redo from either page replays the shared move
    // operation (a structural update on both pages — never a delete or a
    // re-create) and consumes the twin, so per-page snapshot undo can no
    // longer split-brain the move.
    const moveOperation: BlockStructureHistoryOperation = {
      action: "move",
      pageId: sourcePageId,
      blockIds: Array.from(movingIds),
      before: movedBlocks.map(structureBlockSnapshot),
      after: updatedBlocks.map(structureBlockSnapshot),
      occurredAt: nowIso(),
    };
    const linkId = newId();
    const linkedAt = Date.now();
    set((s) => {
      const entryFor = (pageId: string, otherPageId: string): BlockHistoryEntry => ({
        blocks: cloneBlocks(s.blocksByPage[pageId] ?? []),
        operations: [moveOperation],
        at: linkedAt,
        mode: "push",
        link: { id: linkId, pageId: otherPageId },
      });
      const pushEntry = (pageId: string, entry: BlockHistoryEntry): BlockHistory => {
        const existing = s.blockHistoryByPage[pageId] ?? { past: [], future: [] };
        return { past: existing.past.concat(entry).slice(-HISTORY_LIMIT), future: [] };
      };
      return {
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [sourcePageId]: pushEntry(sourcePageId, entryFor(sourcePageId, targetPageId)),
          [targetPageId]: pushEntry(targetPageId, entryFor(targetPageId, sourcePageId)),
        },
      };
    });

    // Apply the move locally BEFORE any network round-trip so an offline move
    // still lands (and the history entries above never dangle unapplied).
    set((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        [sourcePageId]: (s.blocksByPage[sourcePageId] ?? []).filter(
          (block) => !movingIds.has(block.id)
        ),
        [targetPageId]: [
          ...(s.blocksByPage[targetPageId] ?? []).filter((block) => !movingIds.has(block.id)),
          ...updatedBlocks,
        ].sort(bySortPos),
      },
      loadedBlockPages: new Set(s.loadedBlockPages).add(targetPageId),
    }));
    touchPageForBlockChange(get().updatePage, sourcePageId);
    touchPageForBlockChange(get().updatePage, targetPageId);

    const blocksPersist = durableRemoteCall("updateBlocksRemote", [
      updatedBlocks.map((block) => ({
        id: block.id,
        patch: {
          pageId: block.pageId,
          parentId: block.parentId,
          position: block.position,
        } as Partial<Block>,
      })),
      targetPageId,
    ]);

    // Comment migration is best-effort AFTER the move: a failed fetch (e.g.
    // offline) skips it with a toast instead of blocking the move or leaving
    // a stray history entry for a move that never applied.
    let movedComments: Comment[] = [];
    try {
      movedComments = (await getPageCommentsRemote(sourcePageId)).comments
        .filter((comment) => comment.blockId && movingIds.has(comment.blockId))
        .map((comment) => ({ ...comment, pageId: targetPageId }));
    } catch {
      get().notify(storeMessages().blockMoveCommentsSkipped, "error");
      await blocksPersist;
      return;
    }
    set((s) => {
      const commentsByPage = { ...s.commentsByPage };
      if (commentsByPage[sourcePageId]) {
        commentsByPage[sourcePageId] = commentsByPage[sourcePageId].filter(
          (comment) => !comment.blockId || !movingIds.has(comment.blockId)
        );
      }
      if (commentsByPage[targetPageId] && movedComments.length > 0) {
        commentsByPage[targetPageId] = [...commentsByPage[targetPageId], ...movedComments].sort(
          byCreated
        );
      }
      return { commentsByPage };
    });

    await Promise.all([
      blocksPersist,
      // No comments on the moved blocks → nothing to update; an empty
      // updateMany has no pageId to route by and the backend rejects it.
      movedComments.length === 0
        ? Promise.resolve()
        : durableRemoteCall("updateCommentsRemote", [
            movedComments.map((comment) => ({
              id: comment.id,
              patch: { pageId: targetPageId } as Partial<Comment>,
            })),
            targetPageId,
          ]).then((call) => {
            if (call.status === "ok") {
              publishCommentsMutation(sourcePageId);
              publishCommentsMutation(targetPageId);
            }
            return call;
          }),
    ]);
  },

  async copyBlockToPage(id, targetPageId) {
    const targetPage = get().pagesById[targetPageId];
    if (!targetPage || targetPage.kind !== "page" || targetPage.isLocked) return undefined;

    let sourcePageId = "";
    for (const [pid, list] of Object.entries(get().blocksByPage)) {
      if (list.some((block) => block.id === id)) {
        sourcePageId = pid;
        break;
      }
    }
    if (!sourcePageId) return undefined;

    await get().loadBlocks(targetPageId);
    const sourceBlocks = get().blocksByPage[sourcePageId] ?? [];
    const targetBlocks = get().blocksByPage[targetPageId] ?? [];
    const root = sourceBlocks.find((block) => block.id === id);
    if (!root) return undefined;

    const copyIds = new Set<string>();
    const collect = (blockId: string) => {
      copyIds.add(blockId);
      for (const child of sourceBlocks) {
        if (child.parentId === blockId) collect(child.id);
      }
    };
    collect(id);
    const copiedSourceBlocks = sourceBlocks.filter((block) => copyIds.has(block.id));
    if (copiedSourceBlocks.length === 0) return undefined;

    const now = nowIso();
    const actorId = get().userId;
    const blockIdMap = new Map(copiedSourceBlocks.map((block) => [block.id, newId()]));
    const lastTargetTop = targetBlocks
      .filter((block) => block.parentId == null)
      .sort(bySortPos)
      .at(-1);
    const rootPosition = positionBetween(lastTargetTop?.position, undefined);
    const newBlocks: Block[] = copiedSourceBlocks.map((block) => ({
      id: blockIdMap.get(block.id) as string,
      createdAt: now,
      updatedAt: now,
      pageId: targetPageId,
      parentId: block.id === id ? null : blockIdMap.get(block.parentId ?? "") ?? null,
      type: block.type,
      content: remapBlockContent(block.content, undefined, blockIdMap),
      plainText: block.plainText,
      position: block.id === id ? rootPosition : block.position,
      createdBy: actorId || undefined,
    }));

    get().captureBlockHistory(targetPageId);
	    set((s) => ({
	      blocksByPage: {
	        ...s.blocksByPage,
	        [targetPageId]: [...(s.blocksByPage[targetPageId] ?? []), ...newBlocks].sort(bySortPos),
	      },
	      loadedBlockPages: new Set(s.loadedBlockPages).add(targetPageId),
	    }));
	    touchPageForBlockChange(get().updatePage, targetPageId);

	    await durableRemoteCall("createBlocksRemote", [newBlocks]);
    return newBlocks.find((block) => block.parentId == null);
  },

  captureBlockStructureHistory(pageId, operation, mode = "push") {
    const before = operation.before.map(structureBlockSnapshot);
    const after = operation.after.map(structureBlockSnapshot);
    if (before.length === 0 && after.length === 0) return;
    const occurredAt = operation.occurredAt ?? nowIso();
    const entryOperation: BlockStructureHistoryOperation = {
      action: operation.action,
      pageId: operation.pageId ?? pageId,
      blockIds: Array.from(new Set(operation.blockIds.length ? operation.blockIds : [
        ...before.map((block) => block.id),
        ...after.map((block) => block.id),
      ])),
      before,
      after,
      occurredAt,
    };
    const existing = get().blockHistoryByPage[pageId] ?? { past: [], future: [] };
    const last = existing.past[existing.past.length - 1];
    const now = Date.now();
    const snapshot = cloneBlocks(get().blocksByPage[pageId] ?? []);
    const canMerge =
      mode === "merge" &&
      last?.mode === "merge" &&
      last.operations?.length === 1 &&
      now - last.at < MERGE_WINDOW_MS &&
      last.operations[0].action === entryOperation.action &&
      JSON.stringify(last.operations[0].blockIds) === JSON.stringify(entryOperation.blockIds);
    const past = canMerge
      ? existing.past.slice(0, -1).concat({
          ...last,
          operations: [{
            ...entryOperation,
            before: last.operations?.[0]?.before ?? entryOperation.before,
          }],
          at: now,
        })
      : existing.past
          .concat({ blocks: snapshot, operations: [entryOperation], at: now, mode })
          .slice(-HISTORY_LIMIT);
    set((s) => ({
      blockHistoryByPage: {
        ...s.blockHistoryByPage,
        [pageId]: { past, future: [] },
      },
    }));
    if (!isTemplateEditorPageId(entryOperation.pageId)) {
      recordBlockStructureOperation(entryOperation);
    }
  },

  captureBlockHistory(pageId, mode = "push") {
    const snapshot = cloneBlocks(get().blocksByPage[pageId] ?? []);
    const existing = get().blockHistoryByPage[pageId] ?? { past: [], future: [] };
    const last = existing.past[existing.past.length - 1];
    const now = Date.now();
    if (last && snapshotsEqual(last.blocks, snapshot)) return;

    if (mode === "merge" && last?.mode === "merge" && now - last.at < MERGE_WINDOW_MS) {
      const past = existing.past.slice(0, -1).concat({ ...last, at: now });
      set((s) => ({
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [pageId]: { past, future: [] },
        },
      }));
      return;
    }

    const past = existing.past
      .concat({ blocks: snapshot, at: now, mode })
      .slice(-HISTORY_LIMIT);
    set((s) => ({
      blockHistoryByPage: {
        ...s.blockHistoryByPage,
        [pageId]: { past, future: [] },
      },
    }));
  },

  async undoBlockChange(pageId) {
    // Serialized per page: a re-entrant Cmd+Z during the awaited persist
    // below would read the same stacks and collapse two undos into one.
    // Queueing (not ignoring) preserves user intent — N keystrokes, N undos.
    return serializeBlockHistory(pageId, async () => {
      if (get().pagesById[pageId]?.isLocked) return false;
      const history = get().blockHistoryByPage[pageId];
      const entry = history?.past.at(-1);
      if (!entry) return false;
      if (entry.operations?.length) {
        for (const operation of [...entry.operations].reverse()) {
          const target = historyOperationTarget(operation, "undo");
          const removeIds = new Set(target.remove.map((block) => block.id));
          for (const blockId of removeIds) cancelPendingBlock(blockId);
          for (const block of target.upsert) cancelPendingBlock(block.id);
          set((s) => {
            const removed = removeBlocksFromPages(s.blocksByPage, removeIds);
            return {
              blocksByPage: upsertBlocksIntoPages(removed, target.upsert, {
                structuralOnly: target.structuralOnly,
              }),
            };
          });
          if (!isTemplateEditorPageId(operation.pageId)) {
            touchPageForBlockChange(get().updatePage, operation.pageId);
            recordBlockStructureOperation(operation, "inverse");
            await persistBlockStructureOperation(operation, "undo");
          }
        }
        set((s) => ({
          blockHistoryByPage: consumeLinkedTwin(
            {
              ...s.blockHistoryByPage,
              [pageId]: {
                past: history.past.slice(0, -1),
                future: history.future.concat(entry).slice(-HISTORY_LIMIT),
              },
            },
            entry.link,
            "undo"
          ),
        }));
        if (entry.link) {
          // A linked (cross-page move) undo changed both pages; the loop
          // above only touched the operation's own pageId.
          for (const touchId of [pageId, entry.link.pageId]) {
            if (!isTemplateEditorPageId(touchId)) touchPageForBlockChange(get().updatePage, touchId);
          }
        }
        return true;
      }
      if (!entry.blocks) return false;
      const current = cloneBlocks(get().blocksByPage[pageId] ?? []);
      const restored = cloneBlocks(entry.blocks);
      set((s) => ({
        blocksByPage: { ...s.blocksByPage, [pageId]: restored },
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [pageId]: {
            past: history.past.slice(0, -1),
            future: history.future
              .concat({ blocks: current, at: Date.now(), mode: "push" })
              .slice(-HISTORY_LIMIT),
          },
        },
      }));
      if (!isTemplateEditorPageId(pageId)) {
        touchPageForBlockChange(get().updatePage, pageId);
        await persistBlockSnapshot(pageId, current, restored);
      }
      return true;
    });
  },

  async redoBlockChange(pageId) {
    // Same serialization as undoBlockChange (shared per-page gate, so undo
    // and redo cannot interleave against the same stacks either).
    return serializeBlockHistory(pageId, async () => {
      if (get().pagesById[pageId]?.isLocked) return false;
      const history = get().blockHistoryByPage[pageId];
      const entry = history?.future.at(-1);
      if (!entry) return false;
      if (entry.operations?.length) {
        for (const operation of entry.operations) {
          const target = historyOperationTarget(operation, "redo");
          const removeIds = new Set(target.remove.map((block) => block.id));
          for (const blockId of removeIds) cancelPendingBlock(blockId);
          for (const block of target.upsert) cancelPendingBlock(block.id);
          set((s) => {
            const removed = removeBlocksFromPages(s.blocksByPage, removeIds);
            return {
              blocksByPage: upsertBlocksIntoPages(removed, target.upsert, {
                structuralOnly: target.structuralOnly,
              }),
            };
          });
          if (!isTemplateEditorPageId(operation.pageId)) {
            touchPageForBlockChange(get().updatePage, operation.pageId);
            recordBlockStructureOperation(operation);
            await persistBlockStructureOperation(operation, "redo");
          }
        }
        set((s) => ({
          blockHistoryByPage: consumeLinkedTwin(
            {
              ...s.blockHistoryByPage,
              [pageId]: {
                past: history.past.concat(entry).slice(-HISTORY_LIMIT),
                future: history.future.slice(0, -1),
              },
            },
            entry.link,
            "redo"
          ),
        }));
        if (entry.link) {
          // See undoBlockChange: a linked redo changed both pages.
          for (const touchId of [pageId, entry.link.pageId]) {
            if (!isTemplateEditorPageId(touchId)) touchPageForBlockChange(get().updatePage, touchId);
          }
        }
        return true;
      }
      if (!entry.blocks) return false;
      const current = cloneBlocks(get().blocksByPage[pageId] ?? []);
      const restored = cloneBlocks(entry.blocks);
      set((s) => ({
        blocksByPage: { ...s.blocksByPage, [pageId]: restored },
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [pageId]: {
            past: history.past
              .concat({ blocks: current, at: Date.now(), mode: "push" })
              .slice(-HISTORY_LIMIT),
            future: history.future.slice(0, -1),
          },
        },
      }));
      if (!isTemplateEditorPageId(pageId)) {
        touchPageForBlockChange(get().updatePage, pageId);
        await persistBlockSnapshot(pageId, current, restored);
      }
      return true;
    });
  },

  // ── comments ───────────────────────────────────────────────────────
  async loadComments(pageId, opts) {
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
    const promise = (async () => {
      try {
        const comments = (await getPageCommentsRemote(pageId)).comments.sort(byCreated);
        commentFetchedAt.set(pageId, Date.now());
        set((s) => ({
          commentsByPage: { ...s.commentsByPage, [pageId]: comments },
          loadedCommentPages: new Set(s.loadedCommentPages).add(pageId),
        }));
      } catch (error) {
        // Background refresh of an already-rendered list may fail offline —
        // the rendered comments stand. A first load still surfaces the error.
        if (!alreadyLoaded) throw error;
      }
    })().finally(() => {
      commentLoadPromises.delete(promiseKey);
    });
    commentLoadPromises.set(promiseKey, promise);
    return promise;
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
    const call = await durableRemoteCall("createCommentRemote", [comment]);
    if (call.status === "dropped") {
      // Terminal server rejection: remove the phantom optimistic comment
      // (mirror createPage/addRow) and surface the original error. The toast
      // already fired inside durableRemoteCall's drop policy.
      set((s) => ({
        commentsByPage: {
          ...s.commentsByPage,
          [pageId]: (s.commentsByPage[pageId] ?? []).filter((item) => item.id !== comment.id),
        },
      }));
      throw call.error;
    }
    if (call.status === "ok") publishCommentsMutation(pageId);
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
        const next = comments.slice();
        next[idx] = { ...next[idx], ...localPatch };
        commentsByPage[pageId] = next.sort(byCreated);
        break;
      }
      return { commentsByPage };
    });
    if (foundPageId) {
      const pageId = foundPageId;
      void durableRemoteCall("updateCommentRemote", [id, patch as Partial<Comment>, pageId]).then(
        (call) => {
          if (call.status === "ok") publishCommentsMutation(pageId);
          // Terminal rejection (e.g. resolving someone else's thread without
          // edit access): un-apply the optimistic flip so the UI matches the
          // server instead of silently reverting on the next reload.
          if (call.status === "dropped") void get().loadComments(pageId, { force: true });
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
    set((s) => ({
      commentsByPage: {
        ...s.commentsByPage,
        [pageId]: (s.commentsByPage[pageId] ?? []).filter((comment) => !doomed.has(comment.id)),
      },
    }));
    void durableRemoteCall("deleteCommentsRemote", [doomedIds, pageId]).then((call) => {
      if (call.status === "ok") publishCommentsMutation(pageId);
      if (call.status === "dropped") void get().loadComments(pageId, { force: true });
    });
  },

  // ── databases ───────────────────────────────────────────────────────
  async loadDatabase(dbId, options = {}) {
    const force = options.force === true;
    const includeRows = options.rows !== false;
    const requestedViewIds = cleanUniqueIds(options.viewIds);
    const databasePage = get().pagesById[dbId];
    const needsLinkedDatabaseResolution =
      databasePage?.kind === "database" &&
      databasePage.properties?.notionLinkedDatabaseSourceUnavailable === true &&
      !linkedDatabaseResolvedTitle(databasePage);
    const currentViews = get().viewsByDb[dbId] ?? [];
    const needsRequestedViews = requestedViewIds.some(
      (viewId) => !currentViews.some((view) => view.id === viewId)
    );
    const hasMetadata =
      !!get().propsByDb[dbId] ||
      !!get().viewsByDb[dbId] ||
      !!get().templatesByDb[dbId];
    if (!force && includeRows && get().loadedDbs.has(dbId) && !needsLinkedDatabaseResolution && !needsRequestedViews) return;
    if (!force && !includeRows && hasMetadata && !needsLinkedDatabaseResolution && !needsRequestedViews) return;
    const promiseKey = `${dbId}:${includeRows ? "rows" : "metadata"}:${requestedViewIds.join(",")}:${force ? "force" : "cached"}`;
    const pending = databaseLoadPromises.get(promiseKey);
    if (pending) return pending;
    const loadPromise = (async () => {
      // SWR: surface cached schema/views/templates immediately; the snapshot
      // fetch below still runs and reconciles.
      const hydratedMeta =
        !force && !hasMetadata ? await hydrateDatabaseMetaFromCache(dbId) : false;
      // §7 v2: feed-proven-fresh schema hydration replaces the snapshot fetch.
      const metaFresh =
        hydratedMeta && feedSaysUnchanged(dbId, lastHydratedDbMetaFeedStamp.get(dbId));
      const needsSnapshot =
        force ||
        needsLinkedDatabaseResolution ||
        needsRequestedViews ||
        (!hasMetadata && !metaFresh);
      if (needsSnapshot) {
        let snapshot: Awaited<ReturnType<typeof getDatabaseSnapshotRemote>>;
        try {
          snapshot = await getDatabaseSnapshotRemote(dbId, { viewIds: requestedViewIds });
        } catch (error) {
          // Offline with cached metadata: keep serving it; rows below get the
          // same treatment via their own cache.
          if (!hydratedMeta) throw error;
          if (includeRows && !get().loadedDbs.has(dbId)) {
            await get().loadDatabaseRows(dbId, {
              force,
              limit: DATABASE_INITIAL_ROW_LIMIT,
              offset: 0,
              reset: true,
            });
          }
          return;
        }
        const props = snapshot.properties.sort(bySortPos);
        const views = snapshot.views.sort(bySortPos);
        const templates = snapshot.templates.sort(bySortPos);
        const resolvedDatabaseTitle =
          typeof snapshot.resolvedDatabaseTitle === "string" && snapshot.resolvedDatabaseTitle.trim()
            ? snapshot.resolvedDatabaseTitle.trim()
            : undefined;
        set((s) => {
          const pagesById = { ...s.pagesById };
          if (resolvedDatabaseTitle && pagesById[dbId]) {
            const page = pagesById[dbId];
            pagesById[dbId] = {
              ...page,
              properties: {
                ...(page.properties ?? {}),
                notionLinkedDatabaseResolvedTitle: resolvedDatabaseTitle,
                notionLinkedDatabaseResolvedId: snapshot.resolvedDatabaseId,
                notionLinkedDatabaseResolvedFromNotionId: snapshot.resolvedFromNotionDatabaseId,
              },
            };
          }
          return {
            pagesById,
            propsByDb: { ...s.propsByDb, [dbId]: props },
            viewsByDb: { ...s.viewsByDb, [dbId]: mergeById(s.viewsByDb[dbId], views) },
            templatesByDb: { ...s.templatesByDb, [dbId]: mergeById(s.templatesByDb[dbId], templates) },
          };
        });
        const cacheUserId = outboxUserId();
        cacheReplaceTable(cacheUserId, `props:${dbId}`, props.map((p) => ({ id: p.id, value: p })));
        cacheReplaceTable(cacheUserId, `views:${dbId}`, views.map((v) => ({ id: v.id, value: v })));
        cacheReplaceTable(
          cacheUserId,
          `templates:${dbId}`,
          templates.map((t) => ({ id: t.id, value: t }))
        );
        cacheSetMeta(cacheUserId, `dbMetaStamp:${dbId}`, currentChangesSyncedAt || "");
        stampDatabaseCached(cacheUserId, dbId);
      }

      if (includeRows && (force || !get().loadedDbs.has(dbId))) {
        await get().loadDatabaseRows(dbId, {
          force,
          limit: DATABASE_INITIAL_ROW_LIMIT,
          offset: 0,
          reset: true,
        });
      }
    })();
    databaseLoadPromises.set(promiseKey, loadPromise);
    try {
      await loadPromise;
    } finally {
      if (databaseLoadPromises.get(promiseKey) === loadPromise) {
        databaseLoadPromises.delete(promiseKey);
      }
    }
  },

  async loadDatabaseRows(dbId, query = {}) {
    const force = query.force === true;
    const normalized = normalizeDatabaseRowsQuery(query);
    const queryKey = databaseRowsQueryKey(query);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? DATABASE_INITIAL_ROW_LIMIT;
    const reset = query.reset !== false;
    const promiseKey = `${dbId}:${queryKey}:${offset}:${limit}:${reset ? "reset" : "append"}:${force ? "force" : "cached"}`;
    const pending = databaseRowsQueryPromises.get(promiseKey);
    if (pending) return pending;
    if (
      !force &&
      reset &&
      offset === 0 &&
      databaseRowPageSatisfiesInitialLoad(get().databaseRowPagesByDb[dbId], queryKey, limit)
    ) {
      return;
    }

    const loadPromise = (async () => {
      set((s) => {
        const current = s.databaseRowPagesByDb[dbId];
        return {
          ...(reset
            ? { databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [dbId]: [] } }
            : {}),
          databaseRowPagesByDb: {
            ...s.databaseRowPagesByDb,
            [dbId]: {
              ...(current?.queryKey === queryKey
                ? current
                : { loadedCount: 0, hasMore: false }),
              queryKey,
              loading: reset,
              loadingMore: !reset,
              error: undefined,
            },
          },
        };
      });

      // SWR: if this exact query's first page is cached, render it now (with
      // queued outbox row edits overlaid); the fetch below reconciles.
      const hydratedRows =
        reset && offset === 0 && !force && !(get().databaseRowIdsByDb[dbId] ?? []).length
          ? await hydrateDatabaseRowsFromCache(dbId, queryKey)
          : false;
      // §7 v2: this boot's change feed proves the db untouched since the
      // cache was written — the hydrated render IS current; skip the refetch.
      if (hydratedRows && feedSaysUnchanged(dbId, lastHydratedRowsFeedStamp.get(dbId))) {
        set((s) => {
          const current = s.databaseRowPagesByDb[dbId];
          if (current?.queryKey !== queryKey) return {};
          return {
            databaseRowPagesByDb: {
              ...s.databaseRowPagesByDb,
              [dbId]: { ...current, loading: false, loadingMore: false, error: undefined },
            },
          };
        });
        return;
      }
      try {
        const props = get().dbProperties(dbId);
        const rowsResult = await getDatabaseRowsRemote(dbId, {
          includeComputed: databaseNeedsComputedValues(props),
          includeRelationTargets: true,
          limit,
          offset,
          viewId: normalized.viewId || undefined,
          search: normalized.search || undefined,
          currentPageId: normalized.currentPageId || undefined,
        });
        const rowOffset = rowsResult.offset ?? offset;
        const incomingRowIds = (rowsResult.rows ?? []).map((row) => row.id);
        const rowsById = Object.fromEntries(
          (rowsResult.rows ?? []).map((row, index) => [
            row.id,
            { ...row, __databaseRowOrder: rowOffset + index + 1 },
          ])
        );
        const relatedPagesById = Object.fromEntries(
          (rowsResult.relatedPages ?? []).map((page) => [page.id, page])
        );
        set((s) => {
          const current = s.databaseRowPagesByDb[dbId];
          if (current?.queryKey !== queryKey) return {};
          // Overlay still-pending optimistic edits on top of the server snapshot
          // so a row edit that is mid-debounce isn't visually reverted by a
          // concurrent refetch/view-switch. The pending write still flushes.
          const withPendingEdits = (byId: Record<string, Page>) => {
            let merged: Record<string, Page> | null = null;
            for (const id of Object.keys(byId)) {
              const pending = pendingPage.get(id);
              if (pending && Object.keys(pending).length) {
                merged ??= { ...byId };
                merged[id] = { ...byId[id], ...pending };
              }
            }
            return merged ?? byId;
          };
          const existingIds = reset || rowOffset === 0 ? [] : s.databaseRowIdsByDb[dbId] ?? [];
          const rowIds = appendUniqueIds(existingIds, incomingRowIds);
          const hydratedRelationTargetIds = new Set(s.hydratedRelationTargetIds);
          for (const id of rowsResult.relationTargetIds ?? []) {
            hydratedRelationTargetIds.add(id);
          }
          if (!rowsResult.relationTargetIds) {
            for (const page of rowsResult.relatedPages ?? []) {
              hydratedRelationTargetIds.add(page.id);
            }
          }
          return {
            pagesById: { ...s.pagesById, ...withPendingEdits(relatedPagesById), ...withPendingEdits(rowsById) },
            hydratedRelationTargetIds,
            databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [dbId]: rowIds },
            databaseRowPagesByDb: {
              ...s.databaseRowPagesByDb,
              [dbId]: {
                queryKey,
                loadedCount: rowOffset + incomingRowIds.length,
                totalCount: rowsResult.totalCount,
                hasMore: rowsResult.hasMore === true,
                nextOffset: rowsResult.nextOffset,
                loading: false,
                loadingMore: false,
                error: undefined,
              },
            },
            loadedDbs: new Set(s.loadedDbs).add(dbId),
          };
        });
        if (reset && rowOffset === 0) {
          const cacheUserId = outboxUserId();
          const suffix = hashCacheKey(queryKey);
          cacheReplaceTable(
            cacheUserId,
            `rowsdata:${dbId}:${suffix}`,
            (rowsResult.rows ?? []).map((row) => ({ id: row.id, value: row }))
          );
          cacheReplaceTable(
            cacheUserId,
            `rowsrelated:${dbId}:${suffix}`,
            (rowsResult.relatedPages ?? []).map((page) => ({ id: page.id, value: page }))
          );
          cacheSetMeta(cacheUserId, `rows:${dbId}:${suffix}`, {
            hasMore: rowsResult.hasMore === true,
            nextOffset: rowsResult.nextOffset,
            queryKey,
            rowIds: incomingRowIds,
            totalCount: rowsResult.totalCount,
            feedStamp: currentChangesSyncedAt || undefined,
          } satisfies CachedRowsMeta);
          registerRowsCacheKey(cacheUserId, dbId, suffix);
          stampDatabaseCached(cacheUserId, dbId);
        }
      } catch (error) {
        if (hydratedRows) {
          // Offline refresh behind a cached render: keep the rows visible and
          // skip the failure toast; queued edits keep retrying.
          set((s) => {
            const current = s.databaseRowPagesByDb[dbId];
            if (current?.queryKey !== queryKey) return {};
            return {
              databaseRowPagesByDb: {
                ...s.databaseRowPagesByDb,
                [dbId]: { ...current, loading: false, loadingMore: false, error: undefined },
              },
            };
          });
          return;
        }
        // No cache for this exact query: try computing the view locally from
        // a complete cached base set before surfacing an error.
        if (
          reset &&
          offset === 0 &&
          (await hydrateRowsViaLocalEngine(dbId, queryKey, normalized).catch(() => false))
        ) {
          return;
        }
        const message = databaseRowsLoadErrorMessage(error);
        set((s) => {
          const current = s.databaseRowPagesByDb[dbId];
          if (current?.queryKey !== queryKey) return {};
          return {
            databaseRowPagesByDb: {
              ...s.databaseRowPagesByDb,
              [dbId]: { ...current, loading: false, loadingMore: false, error: message },
            },
          };
        });
        get().notify(message, "error");
      }
    })();
    databaseRowsQueryPromises.set(promiseKey, loadPromise);
    try {
      await loadPromise;
    } finally {
      if (databaseRowsQueryPromises.get(promiseKey) === loadPromise) {
        databaseRowsQueryPromises.delete(promiseKey);
      }
    }
  },

  async loadMoreDatabaseRows(dbId, query) {
    const current = get().databaseRowPagesByDb[dbId];
    const queryKey = query ? databaseRowsQueryKey(query) : current?.queryKey ?? databaseRowsQueryKey();
    if (!current?.hasMore || current.loading || current.loadingMore || current.queryKey !== queryKey) return;
    const pending = databaseRowLoadMorePromises.get(dbId);
    if (pending) return pending;
    const loadPromise = get().loadDatabaseRows(dbId, {
      ...(query ?? {}),
      limit: query?.limit ?? DATABASE_ROW_LOAD_MORE_LIMIT,
      offset: current.nextOffset ?? current.loadedCount,
      reset: false,
    });
    databaseRowLoadMorePromises.set(dbId, loadPromise);
    try {
      await loadPromise;
    } finally {
      if (databaseRowLoadMorePromises.get(dbId) === loadPromise) {
        databaseRowLoadMorePromises.delete(dbId);
      }
    }
  },

  warmDatabaseRowDetail(dbId, rowId) {
    const state = get();
    const row = state.pagesById[rowId];
    if (!row || row.inTrash) return;
    void state.loadBlocks(rowId).catch(() => {});

    const relationTargetDbIds = new Set<string>();
    for (const prop of state.dbProperties(dbId)) {
      if (prop.type !== "relation") continue;
      const configuredTarget = prop.config?.relationDatabaseId;
      const targetDbId =
        typeof configuredTarget === "string" && configuredTarget.trim()
          ? configuredTarget.trim()
          : prop.databaseId;
      if (targetDbId) relationTargetDbIds.add(targetDbId);
    }
    for (const targetDbId of relationTargetDbIds) {
      void state.loadDatabase(targetDbId, { rows: false }).catch(() => {});
    }
  },

  dbProperties(dbId) {
    return (get().propsByDb[dbId] ?? []).slice().sort(bySortPos);
  },
  dbViews(dbId) {
    return (get().viewsByDb[dbId] ?? []).slice().sort(bySortPos);
  },
  dbTemplates(dbId) {
    return (get().templatesByDb[dbId] ?? []).slice().sort(bySortPos);
  },
  dbRows(dbId) {
    const state = get();
    const loadedRowIds = state.databaseRowIdsByDb[dbId];
    if (loadedRowIds) {
      return loadedRowIds
        .map((id) => state.pagesById[id])
        .filter((page): page is Page => !!page && !page.inTrash);
    }
    if (!state.loadedDbs.has(dbId) && state.pagesById[dbId]?.kind === "database") return [];
    return Object.values(state.pagesById)
      .filter((p) => p.parentType === "database" && p.parentId === dbId && !p.inTrash)
      .sort(bySortPos);
  },

  async createDatabase(opts) {
    const ws = get().workspace;
    if (!ws) throw new Error("no workspace");
    if (opts.parentId && get().pagesById[opts.parentId]?.isLocked) {
      throw new Error("Page is locked.");
    }
    const userId = get().userId || (await ensureAuth());
    if (userId && userId !== get().userId) set({ userId });
    const id = newId();
    const result = await createDatabaseRemote({
      id,
      workspaceId: ws.id,
      parentId: opts.parentId,
      parentType: opts.parentType,
      title: typeof opts.title === "string" ? opts.title.trim() : "",
      afterPosition: opts.afterPosition,
      viewType: opts.viewType,
      seedRows: opts.seedRows,
      properties: opts.properties,
    });
    const props = (result.properties ?? []).slice().sort(bySortPos);
    const views = (result.views ?? []).slice().sort(bySortPos);
    const templates = (result.templates ?? []).slice().sort(bySortPos);
    const rowsById = Object.fromEntries((result.rows ?? []).map((row) => [row.id, row]));
    const rowIds = (result.rows ?? []).slice().sort(bySortPos).map((row) => row.id);
    set((s) => ({
      pagesById: { ...s.pagesById, [result.page.id]: result.page, ...rowsById },
      propsByDb: { ...s.propsByDb, [result.page.id]: props },
      viewsByDb: { ...s.viewsByDb, [result.page.id]: views },
      templatesByDb: { ...s.templatesByDb, [result.page.id]: templates },
      databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [result.page.id]: rowIds },
      databaseRowPagesByDb: {
        ...s.databaseRowPagesByDb,
        [result.page.id]: {
          loadedCount: rowIds.length,
          totalCount: rowIds.length,
          hasMore: false,
        },
      },
      loadedDbs: new Set(s.loadedDbs).add(id),
    }));
    return result.page;
  },

  async addProperty(dbId, type, name, config) {
    assertDatabaseUnlocked(get().pagesById, dbId);
    const existing = get().dbProperties(dbId);
    const views = get().dbViews(dbId);
    const prop: DbProperty = {
      id: newId(),
      databaseId: dbId,
      name,
      type,
      config,
      position: positionBetween(existing[existing.length - 1]?.position, undefined),
    };
    const updatedViews: DbView[] = [];
    for (const view of views) {
      let changed = false;
      const nextConfig: ViewConfig = { ...(view.config ?? {}) };
      if (nextConfig.propertyOrder && !nextConfig.propertyOrder.includes(prop.id)) {
        nextConfig.propertyOrder = [...nextConfig.propertyOrder, prop.id];
        changed = true;
      }
      if (nextConfig.visibleProperties && !nextConfig.visibleProperties.includes(prop.id)) {
        nextConfig.visibleProperties = [...nextConfig.visibleProperties, prop.id];
        changed = true;
      }
      if (changed) updatedViews.push({ ...view, config: nextConfig });
    }
    set((s) => ({
      propsByDb: { ...s.propsByDb, [dbId]: [...(s.propsByDb[dbId] ?? []), prop] },
      viewsByDb:
        updatedViews.length > 0
          ? {
              ...s.viewsByDb,
              [dbId]: (s.viewsByDb[dbId] ?? []).map(
                (view) => updatedViews.find((updated) => updated.id === view.id) ?? view
              ),
            }
          : s.viewsByDb,
    }));
    const createCalls = await Promise.all([
      durableRemoteCall("createPropertyRemote", [prop as Partial<DbProperty>]),
      ...updatedViews.map((view) =>
        durableRemoteCall("updateViewRemote", [
          view.id,
          { config: view.config } as Partial<DbView>,
          view.databaseId,
        ])
      ),
    ]);
    if (createCalls.every((call) => call.status === "ok")) {
      publishDatabaseSchemaMutation(dbId, "property_created", [prop.id]);
      if (updatedViews.length > 0) {
        publishDatabaseViewsMutation(dbId, "view_property_visibility_updated", updatedViews.map((view) => view.id));
      }
    }
    // Back-fill sequential ids for a new unique_id property so existing rows aren't blank.
    if (type === "unique_id") {
      const existing = get().dbRows(dbId);
      existing.forEach((row, index) => {
        get().setRowProperty(row.id, prop.id, index + 1, { debounce: false });
      });
    }
    return prop;
  },

  updateProperty(id, patch) {
    const dbId = Object.keys(get().propsByDb).find((key) =>
      (get().propsByDb[key] ?? []).some((p) => p.id === id)
    );
    if (isDatabaseLocked(get().pagesById, dbId)) return;
    const prevType = dbId
      ? get().propsByDb[dbId]?.find((p) => p.id === id)?.type
      : undefined;
    const typeChanged = patch.type !== undefined && patch.type !== prevType;

    set((s) => {
      const next = { ...s.propsByDb };
      for (const db of Object.keys(next)) {
        const idx = next[db].findIndex((p) => p.id === id);
        if (idx >= 0) {
          const arr = next[db].slice();
          arr[idx] = { ...arr[idx], ...patch };
          next[db] = arr;
          break;
        }
      }
      return { propsByDb: next };
    });
    // dbId is the routing hint (workspace-per-DO). It is derived from the same
    // cache the optimistic set above walked, so an unresolved dbId means the
    // edit already no-op'd locally — firing a hint-less remote mutation would
    // only 404. Persist only when we can route.
    if (dbId) {
      void durableRemoteCall("updatePropertyRemote", [id, patch as Partial<DbProperty>, dbId]).then(
        (call) => {
          if (call.status === "ok") publishDatabaseSchemaMutation(dbId, "property_updated", [id]);
          // Terminal rejection: reconcile the optimistic schema edit from the
          // server (refresh loops don't cover DB schema).
          if (call.status === "dropped") void get().loadDatabase(dbId, { force: true, rows: false });
        }
      );
    }

    if (typeChanged && dbId) {
      // A filter built for the old type has an operator/value that no longer
      // applies and would silently drop every row — remove those filters.
      const updatedViews: DbView[] = [];
      for (const view of get().dbViews(dbId)) {
        const config = viewConfigWithoutFilterProperty(view.config, id);
        if (configChanged(view.config, config)) updatedViews.push({ ...view, config });
      }
      if (updatedViews.length) {
        set((s) => ({
          viewsByDb: {
            ...s.viewsByDb,
            [dbId]: (s.viewsByDb[dbId] ?? []).map(
              (view) => updatedViews.find((u) => u.id === view.id) ?? view
            ),
          },
        }));
        for (const view of updatedViews) {
          void durableRemoteCall("updateViewRemote", [
            view.id,
            { config: view.config } as Partial<DbView>,
            view.databaseId,
          ]).then((call) => {
            if (call.status === "ok") {
              publishDatabaseViewsMutation(view.databaseId, "view_filter_type_guard_updated", [view.id]);
            }
          });
        }
      }
    }
  },

  async deleteProperty(id) {
    const dbId = Object.keys(get().propsByDb).find((key) =>
      (get().propsByDb[key] ?? []).some((prop) => prop.id === id)
    );
    if (!dbId) return null;
    assertDatabaseUnlocked(get().pagesById, dbId);
    const prop = get().dbProperties(dbId).find((item) => item.id === id);
    if (!prop || prop.type === "title") return null;

    const updatedRows: Page[] = [];
    const snapshotRows: DeletedPropertySnapshot["rows"] = [];
    for (const row of get().dbRows(dbId)) {
      if (!row.properties || !(id in row.properties)) continue;
      snapshotRows.push({ id: row.id, properties: cloneJson(row.properties) });
      const properties = { ...row.properties };
      delete properties[id];
      updatedRows.push({ ...row, properties });
    }

    const updatedViews: DbView[] = [];
    const snapshotViews: DeletedPropertySnapshot["views"] = [];
    for (const view of get().dbViews(dbId)) {
      const config = viewConfigWithoutProperty(view.config, id);
      if (configChanged(view.config, config)) {
        snapshotViews.push({ id: view.id, config: cloneJson(view.config) });
        updatedViews.push({ ...view, config });
      }
    }

    const updatedTemplates: DbTemplate[] = [];
    const snapshotTemplates: DeletedPropertySnapshot["templates"] = [];
    for (const template of get().dbTemplates(dbId)) {
      if (!template.properties || !(id in template.properties)) continue;
      snapshotTemplates.push({ id: template.id, properties: cloneJson(template.properties) });
      const properties = { ...template.properties };
      delete properties[id];
      updatedTemplates.push({ ...template, properties });
    }

    const originalProps = get().dbProperties(dbId);
    const updatedProps = originalProps
      .filter((item) => item.id !== id)
      .map((item) => {
        const config = { ...(item.config ?? {}) };
        let changed = false;
        if (config.rollupRelationPropertyId === id) {
          config.rollupRelationPropertyId = undefined;
          config.rollupTargetPropertyId = undefined;
          changed = true;
        }
        if (config.rollupTargetPropertyId === id) {
          config.rollupTargetPropertyId = undefined;
          changed = true;
        }
        return changed ? { ...item, config } : item;
      });
    const affectedPropUpdates = updatedProps.filter((item) =>
      configChanged(
        originalProps.find((existing) => existing.id === item.id)?.config,
        item.config
      )
    );
    const snapshotRelatedProperties: DeletedPropertySnapshot["relatedProperties"] =
      affectedPropUpdates.map((item) => ({
        id: item.id,
        config: cloneJson(originalProps.find((existing) => existing.id === item.id)?.config),
      }));

    for (const row of updatedRows) {
      const pending = pendingPage.get(row.id);
      if (pending?.properties && id in pending.properties) {
        const properties = { ...pending.properties };
        delete properties[id];
        pendingPage.set(row.id, { ...pending, properties });
        mirrorPendingPage(row.id);
      }
    }

    set((s) => {
      const propsByDb = { ...s.propsByDb, [dbId]: updatedProps };
      const viewsByDb =
        updatedViews.length > 0
          ? {
              ...s.viewsByDb,
              [dbId]: (s.viewsByDb[dbId] ?? []).map(
                (view) => updatedViews.find((updated) => updated.id === view.id) ?? view
              ),
            }
          : s.viewsByDb;
      const templatesByDb =
        updatedTemplates.length > 0
          ? {
              ...s.templatesByDb,
              [dbId]: (s.templatesByDb[dbId] ?? []).map(
                (template) =>
                  updatedTemplates.find((updated) => updated.id === template.id) ?? template
              ),
            }
          : s.templatesByDb;
      const pagesById = { ...s.pagesById };
      for (const row of updatedRows) pagesById[row.id] = row;
      return { propsByDb, viewsByDb, templatesByDb, pagesById };
    });

    const deleteCalls = await Promise.all([
      durableRemoteCall("deletePropertyRemote", [id, dbId]),
      ...updatedRows.map((row) =>
        durableRemoteCall("updatePageRemote", [
          row.id,
          { properties: persistableRowProperties(row) } as Partial<Page>,
        ])
      ),
      ...updatedViews.map((view) =>
        durableRemoteCall("updateViewRemote", [
          view.id,
          { config: view.config } as Partial<DbView>,
          view.databaseId,
        ])
      ),
      ...updatedTemplates.map((template) =>
        durableRemoteCall("updateTemplateRemote", [
          template.id,
          { properties: template.properties } as Partial<DbTemplate>,
          template.databaseId,
        ])
      ),
      ...affectedPropUpdates.map((item) =>
        durableRemoteCall("updatePropertyRemote", [
          item.id,
          { config: item.config } as Partial<DbProperty>,
          item.databaseId,
        ])
      ),
    ]);
    if (deleteCalls.every((call) => call.status === "ok")) {
      publishDatabaseSchemaMutation(dbId, "property_deleted", [
        id,
        ...affectedPropUpdates.map((item) => item.id),
      ]);
      if (updatedRows.length > 0) publishDatabaseRowsMutation(dbId, "property_deleted_rows_updated", updatedRows.map((row) => row.id));
      if (updatedViews.length > 0) publishDatabaseViewsMutation(dbId, "property_deleted_views_updated", updatedViews.map((view) => view.id));
      if (updatedTemplates.length > 0) publishDatabaseTemplatesMutation(dbId, "property_deleted_templates_updated");
    }
    return {
      dbId,
      property: cloneJson(prop),
      rows: snapshotRows,
      views: snapshotViews,
      templates: snapshotTemplates,
      relatedProperties: snapshotRelatedProperties,
    };
  },

  async restoreDeletedProperty(snapshot) {
    const { dbId } = snapshot;
    if (isDatabaseLocked(get().pagesById, dbId)) return false;
    if (get().dbProperties(dbId).some((prop) => prop.id === snapshot.property.id)) return false;

    const existingRows = snapshot.rows.filter((row) => !!get().pagesById[row.id]);
    const existingViewIds = new Set(get().dbViews(dbId).map((view) => view.id));
    const existingTemplateIds = new Set(get().dbTemplates(dbId).map((template) => template.id));
    const existingPropIds = new Set(get().dbProperties(dbId).map((prop) => prop.id));
    const restoredViews = snapshot.views.filter((view) => existingViewIds.has(view.id));
    const restoredTemplates = snapshot.templates.filter((template) => existingTemplateIds.has(template.id));
    const restoredRelatedProperties = snapshot.relatedProperties.filter((prop) => existingPropIds.has(prop.id));

    for (const row of existingRows) {
      const pending = pendingPage.get(row.id);
      if (pending) {
        pendingPage.set(row.id, { ...pending, properties: cloneJson(row.properties) });
        mirrorPendingPage(row.id);
      }
    }

    set((s) => {
      const propsByDb = {
        ...s.propsByDb,
        [dbId]: [...(s.propsByDb[dbId] ?? []), cloneJson(snapshot.property)].sort(bySortPos),
      };
      for (const related of restoredRelatedProperties) {
        propsByDb[dbId] = propsByDb[dbId].map((prop) =>
          prop.id === related.id ? { ...prop, config: cloneJson(related.config) } : prop
        );
      }
      const pagesById = { ...s.pagesById };
      for (const row of existingRows) {
        const page = pagesById[row.id];
        if (page) pagesById[row.id] = { ...page, properties: cloneJson(row.properties) };
      }
      const viewsByDb =
        restoredViews.length > 0
          ? {
              ...s.viewsByDb,
              [dbId]: (s.viewsByDb[dbId] ?? []).map((view) => {
                const restored = restoredViews.find((item) => item.id === view.id);
                return restored ? { ...view, config: cloneJson(restored.config) } : view;
              }),
            }
          : s.viewsByDb;
      const templatesByDb =
        restoredTemplates.length > 0
          ? {
              ...s.templatesByDb,
              [dbId]: (s.templatesByDb[dbId] ?? []).map((template) => {
                const restored = restoredTemplates.find((item) => item.id === template.id);
                return restored ? { ...template, properties: cloneJson(restored.properties) } : template;
              }),
            }
          : s.templatesByDb;
      return { propsByDb, pagesById, viewsByDb, templatesByDb };
    });

    const restoreCalls = await Promise.all([
      durableRemoteCall("createPropertyRemote", [snapshot.property as Partial<DbProperty>]),
      ...existingRows.map((row) =>
        durableRemoteCall("updatePageRemote", [
          row.id,
          { properties: persistableRowProperties(row) } as Partial<Page>,
        ])
      ),
      ...restoredViews.map((view) =>
        durableRemoteCall("updateViewRemote", [
          view.id,
          { config: view.config } as Partial<DbView>,
          dbId,
        ])
      ),
      ...restoredTemplates.map((template) =>
        durableRemoteCall("updateTemplateRemote", [
          template.id,
          { properties: template.properties } as Partial<DbTemplate>,
          dbId,
        ])
      ),
      ...restoredRelatedProperties.map((prop) =>
        durableRemoteCall("updatePropertyRemote", [
          prop.id,
          { config: prop.config } as Partial<DbProperty>,
          dbId,
        ])
      ),
    ]);
    if (restoreCalls.every((call) => call.status === "ok")) {
      publishDatabaseSchemaMutation(dbId, "property_restored", [
        snapshot.property.id,
        ...restoredRelatedProperties.map((prop) => prop.id),
      ]);
      if (existingRows.length > 0) publishDatabaseRowsMutation(dbId, "property_restored_rows_updated", existingRows.map((row) => row.id));
      if (restoredViews.length > 0) publishDatabaseViewsMutation(dbId, "property_restored_views_updated", restoredViews.map((view) => view.id));
      if (restoredTemplates.length > 0) publishDatabaseTemplatesMutation(dbId, "property_restored_templates_updated");
    }
    return true;
  },

  async deletePropertyOption(propertyId, optionId) {
    const dbId = Object.keys(get().propsByDb).find((key) =>
      (get().propsByDb[key] ?? []).some((prop) => prop.id === propertyId)
    );
    if (!dbId || isDatabaseLocked(get().pagesById, dbId)) return null;
    const prop = get().dbProperties(dbId).find((item) => item.id === propertyId);
    const options = prop?.config?.options ?? [];
    const optionIndex = options.findIndex((option) => option.id === optionId);
    if (!prop || optionIndex < 0) return null;

    const option = options[optionIndex];
    const config: PropertyConfig = {
      ...(prop.config ?? {}),
      options: options.filter((item) => item.id !== optionId),
    };
    const updatedProp = { ...prop, config };
    const updatedRows: Page[] = [];
    const snapshotRows: DeletedPropertyOptionSnapshot["rows"] = [];
    const isMulti = prop.type === "multi_select";

    for (const row of get().dbRows(dbId)) {
      const raw = row.properties?.[propertyId];
      if (isMulti) {
        const ids = Array.isArray(raw) ? raw.map(String) : [];
        if (!ids.includes(optionId)) continue;
        snapshotRows.push({ id: row.id, value: cloneJson(raw) });
        updatedRows.push({
          ...row,
          properties: { ...(row.properties ?? {}), [propertyId]: ids.filter((id) => id !== optionId) },
        });
      } else if (String(raw ?? "") === optionId) {
        snapshotRows.push({ id: row.id, value: cloneJson(raw) });
        updatedRows.push({ ...row, properties: { ...(row.properties ?? {}), [propertyId]: null } });
      }
    }

    for (const row of updatedRows) {
      const pending = pendingPage.get(row.id);
      if (pending) {
        pendingPage.set(row.id, { ...pending, properties: cloneJson(row.properties) });
        mirrorPendingPage(row.id);
      }
    }

    set((s) => {
      const propsByDb = {
        ...s.propsByDb,
        [dbId]: (s.propsByDb[dbId] ?? []).map((item) => (item.id === propertyId ? updatedProp : item)),
      };
      const pagesById = { ...s.pagesById };
      for (const row of updatedRows) pagesById[row.id] = row;
      return { propsByDb, pagesById };
    });

    const optionDeleteCalls = await Promise.all([
      durableRemoteCall("updatePropertyRemote", [propertyId, { config } as Partial<DbProperty>, dbId]),
      ...updatedRows.map((row) =>
        durableRemoteCall("updatePageRemote", [
          row.id,
          { properties: persistableRowProperties(row) } as Partial<Page>,
        ])
      ),
    ]);
    if (optionDeleteCalls.every((call) => call.status === "ok")) {
      publishDatabaseSchemaMutation(dbId, "property_option_deleted", [propertyId]);
      if (updatedRows.length > 0) publishDatabaseRowsMutation(dbId, "property_option_deleted_rows_updated", updatedRows.map((row) => row.id));
    }
    return { dbId, propertyId, option: cloneJson(option), optionIndex, rows: snapshotRows };
  },

  async restoreDeletedPropertyOption(snapshot) {
    const { dbId, propertyId } = snapshot;
    if (isDatabaseLocked(get().pagesById, dbId)) return false;
    const prop = get().dbProperties(dbId).find((item) => item.id === propertyId);
    if (!prop) return false;
    const options = prop.config?.options ?? [];
    if (options.some((option) => option.id === snapshot.option.id)) return false;
    const optionIndex = Math.max(0, Math.min(snapshot.optionIndex, options.length));
    const restoredOption = cloneJson(snapshot.option);
    const config: PropertyConfig = {
      ...(prop.config ?? {}),
      options: [
        ...options.slice(0, optionIndex),
        restoredOption,
        ...options.slice(optionIndex),
      ],
    };
    const updatedProp = { ...prop, config };
    const existingRows = snapshot.rows.filter((row) => !!get().pagesById[row.id]);

    for (const row of existingRows) {
      const pending = pendingPage.get(row.id);
      if (pending) {
        pendingPage.set(row.id, {
          ...pending,
          properties: { ...(pending.properties ?? get().pagesById[row.id]?.properties ?? {}), [propertyId]: cloneJson(row.value) },
        });
        mirrorPendingPage(row.id);
      }
    }

    set((s) => {
      const propsByDb = {
        ...s.propsByDb,
        [dbId]: (s.propsByDb[dbId] ?? []).map((item) => (item.id === propertyId ? updatedProp : item)),
      };
      const pagesById = { ...s.pagesById };
      for (const row of existingRows) {
        const page = pagesById[row.id];
        if (!page) continue;
        pagesById[row.id] = {
          ...page,
          properties: { ...(page.properties ?? {}), [propertyId]: cloneJson(row.value) },
        };
      }
      return { propsByDb, pagesById };
    });

    const optionRestoreCalls = await Promise.all([
      durableRemoteCall("updatePropertyRemote", [propertyId, { config } as Partial<DbProperty>, dbId]),
      ...existingRows.map((row) => {
        const page = get().pagesById[row.id];
        return durableRemoteCall("updatePageRemote", [
          row.id,
          { properties: page ? persistableRowProperties(page) : {} } as Partial<Page>,
        ]);
      }),
    ]);
    if (optionRestoreCalls.every((call) => call.status === "ok")) {
      publishDatabaseSchemaMutation(dbId, "property_option_restored", [propertyId]);
      if (existingRows.length > 0) publishDatabaseRowsMutation(dbId, "property_option_restored_rows_updated", existingRows.map((row) => row.id));
    }
    return true;
  },

  async addView(dbId, type, name, opts) {
    assertDatabaseUnlocked(get().pagesById, dbId);
    const existing = get().dbViews(dbId);
    const view: DbView = {
      id: newId(),
      databaseId: dbId,
      name: name ?? type[0].toUpperCase() + type.slice(1),
      type,
      position: opts?.position ?? positionBetween(existing[existing.length - 1]?.position, undefined),
      config: opts?.config ?? {},
    };
    set((s) => ({
      viewsByDb: { ...s.viewsByDb, [dbId]: [...(s.viewsByDb[dbId] ?? []), view] },
    }));
    const call = await durableRemoteCall("createViewRemote", [view as Partial<DbView>]);
    if (call.status === "dropped") {
      set((s) => ({
        viewsByDb: {
          ...s.viewsByDb,
          [dbId]: (s.viewsByDb[dbId] ?? []).filter((item) => item.id !== view.id),
        },
      }));
    } else if (call.status === "ok") {
      publishDatabaseViewsMutation(dbId, "view_created", [view.id]);
    }
    return view;
  },

  updateView(id, patch) {
    const dbId = Object.keys(get().viewsByDb).find((key) =>
      (get().viewsByDb[key] ?? []).some((view) => view.id === id)
    );
    if (isDatabaseLocked(get().pagesById, dbId)) return;
    set((s) => {
      const next = { ...s.viewsByDb };
      for (const db of Object.keys(next)) {
        const idx = next[db].findIndex((v) => v.id === id);
        if (idx >= 0) {
          const arr = next[db].slice();
          arr[idx] = { ...arr[idx], ...patch };
          next[db] = arr;
          break;
        }
      }
      return { viewsByDb: next };
    });
    // Routing hint derived from viewsByDb (see updateProperty): only persist
    // when the view resolves to a database, else the mutation can't be routed.
    if (dbId) {
      void durableRemoteCall("updateViewRemote", [id, patch as Partial<DbView>, dbId]).then(
        (call) => {
          if (call.status === "ok") publishDatabaseViewsMutation(dbId, "view_updated", [id]);
          // Terminal rejection: reconcile the optimistic view edit from the
          // server (refresh loops don't cover DB schema).
          if (call.status === "dropped") void get().loadDatabase(dbId, { force: true, rows: false });
        }
      );
    }
  },

  async deleteView(id) {
    const dbId = Object.keys(get().viewsByDb).find((key) =>
      (get().viewsByDb[key] ?? []).some((view) => view.id === id)
    );
    if (!dbId || isDatabaseLocked(get().pagesById, dbId)) return null;
    const snapshot = get().viewsByDb[dbId]?.find((view) => view.id === id);
    if (!snapshot) return null;
    set((s) => {
      const next = { ...s.viewsByDb, [dbId]: (s.viewsByDb[dbId] ?? []).filter((v) => v.id !== id) };
      return { viewsByDb: next };
    });
    const call = await durableRemoteCall("deleteViewRemote", [id, dbId]);
    if (call.status === "ok") publishDatabaseViewsMutation(dbId, "view_deleted", [id]);
    return cloneJson(snapshot);
  },

  async restoreDeletedView(view) {
    const dbId = view.databaseId;
    if (!get().pagesById[dbId] || isDatabaseLocked(get().pagesById, dbId)) return false;
    if (get().dbViews(dbId).some((existing) => existing.id === view.id)) return false;
    const restored = cloneJson(view);
    set((s) => ({
      viewsByDb: {
        ...s.viewsByDb,
        [dbId]: [...(s.viewsByDb[dbId] ?? []), restored].sort(bySortPos),
      },
    }));
    const call = await durableRemoteCall("createViewRemote", [restored as Partial<DbView>]);
    if (call.status === "ok") publishDatabaseViewsMutation(dbId, "view_restored", [restored.id]);
    return true;
  },

  async addTemplate(dbId, name = "") {
    assertDatabaseUnlocked(get().pagesById, dbId);
    const templates = get().dbTemplates(dbId);
    const template: DbTemplate = {
      id: newId(),
      databaseId: dbId,
      name,
      title: "",
      properties: {},
      blocks: [{ type: "paragraph", content: { rich: [] } }],
      isDefault: false,
      position: positionBetween(templates[templates.length - 1]?.position, undefined),
    };
    set((s) => ({
      templatesByDb: {
        ...s.templatesByDb,
        [dbId]: [...(s.templatesByDb[dbId] ?? []), template].sort(bySortPos),
      },
    }));
    const createCall = await durableRemoteCall("createTemplateRemote", [template as Partial<DbTemplate>]);
    if (createCall.status === "dropped") {
      set((s) => ({
        templatesByDb: {
          ...s.templatesByDb,
          [dbId]: (s.templatesByDb[dbId] ?? []).filter((item) => item.id !== template.id),
        },
      }));
    } else if (createCall.status === "ok") {
      publishDatabaseTemplatesMutation(dbId, "template_created");
    }
    return template;
  },

  async duplicateTemplate(id) {
    let dbId = "";
    let source: DbTemplate | undefined;
    for (const [candidateDbId, templates] of Object.entries(get().templatesByDb)) {
      source = templates.find((template) => template.id === id);
      if (!source) continue;
      dbId = candidateDbId;
      break;
    }
    if (!dbId || !source) return null;
    assertDatabaseUnlocked(get().pagesById, dbId);

    const templates = get().dbTemplates(dbId);
    const index = templates.findIndex((template) => template.id === id);
    const nextPosition = templates[index + 1]?.position;
    const sourceName = source.name.trim().toLowerCase() === "untitled template" ? "" : source.name.trim();
    const copy: DbTemplate = {
      id: newId(),
      databaseId: source.databaseId,
      name: `${sourceName || "Untitled template"} copy`,
      icon: source.icon,
      title: templateTitleValue(source),
      properties: cloneJson(source.properties ?? {}),
      blocks: cloneJson(source.blocks ?? [{ type: "paragraph", content: { rich: [] } }]),
      isDefault: false,
      position: positionBetween(source.position, nextPosition),
    };

    set((s) => ({
      templatesByDb: {
        ...s.templatesByDb,
        [dbId]: [...(s.templatesByDb[dbId] ?? []), copy].sort(bySortPos),
      },
    }));
    const duplicateCall = await durableRemoteCall("createTemplateRemote", [copy as Partial<DbTemplate>]);
    if (duplicateCall.status === "dropped") {
      set((s) => ({
        templatesByDb: {
          ...s.templatesByDb,
          [dbId]: (s.templatesByDb[dbId] ?? []).filter((item) => item.id !== copy.id),
        },
      }));
    } else if (duplicateCall.status === "ok") {
      publishDatabaseTemplatesMutation(dbId, "template_duplicated");
    }
    return copy;
  },

  updateTemplate(id, patch) {
    const targetDbId = Object.keys(get().templatesByDb).find((key) =>
      (get().templatesByDb[key] ?? []).some((template) => template.id === id)
    );
    if (isDatabaseLocked(get().pagesById, targetDbId)) return;
    let dbId = "";
    let previousDefaults: string[] = [];
    set((s) => {
      const templatesByDb = { ...s.templatesByDb };
      for (const [candidateDbId, templates] of Object.entries(templatesByDb)) {
        const index = templates.findIndex((template) => template.id === id);
        if (index < 0) continue;
        dbId = candidateDbId;
        const next = templates.map((template, itemIndex) => {
          if (patch.isDefault && template.id !== id && template.isDefault) {
            previousDefaults = [...previousDefaults, template.id];
            return { ...template, isDefault: false };
          }
          if (itemIndex !== index) return template;
          return { ...template, ...patch };
        });
        templatesByDb[candidateDbId] = next.sort(bySortPos);
        break;
      }
      return { templatesByDb };
    });
    if (dbId) {
      void durableRemoteCall("updateTemplateRemote", [id, patch as Partial<DbTemplate>, dbId]).then(
        (call) => {
          if (call.status === "ok") publishDatabaseTemplatesMutation(dbId, "template_updated");
          // Terminal rejection: reconcile the optimistic template edit from
          // the server (refresh loops don't cover DB schema).
          if (call.status === "dropped") void get().loadDatabase(dbId, { force: true, rows: false });
        }
      );
      if (patch.isDefault) {
        for (const previousId of previousDefaults) {
          void durableRemoteCall("updateTemplateRemote", [previousId, { isDefault: false }, dbId]).then(
            (call) => {
              if (call.status === "ok") publishDatabaseTemplatesMutation(dbId, "template_default_updated");
            }
          );
        }
      }
    }
  },

  async deleteTemplate(id) {
    const dbId = Object.keys(get().templatesByDb).find((key) =>
      (get().templatesByDb[key] ?? []).some((template) => template.id === id)
    );
    if (!dbId || isDatabaseLocked(get().pagesById, dbId)) return null;
    const snapshot = get().templatesByDb[dbId]?.find((template) => template.id === id);
    if (!snapshot) return null;
    set((s) => {
      const templatesByDb = { ...s.templatesByDb };
      templatesByDb[dbId] = (templatesByDb[dbId] ?? []).filter((template) => template.id !== id);
      return { templatesByDb };
    });
    try {
      const call = await durableRemoteCall("deleteTemplateRemote", [id, dbId]);
      if (call.status === "ok") publishDatabaseTemplatesMutation(dbId, "template_deleted");
    } catch {
      /* ignore */
    }
    return cloneJson(snapshot);
  },

  async restoreDeletedTemplate(template) {
    const dbId = template.databaseId;
    if (!get().pagesById[dbId] || isDatabaseLocked(get().pagesById, dbId)) return false;
    if (get().dbTemplates(dbId).some((existing) => existing.id === template.id)) return false;
    const restored = cloneJson(template);
    let previousDefaults: string[] = [];
    set((s) => {
      const current = s.templatesByDb[dbId] ?? [];
      const next = restored.isDefault
        ? current.map((item) => {
            if (item.isDefault) previousDefaults = [...previousDefaults, item.id];
            return item.isDefault ? { ...item, isDefault: false } : item;
          })
        : current;
      return {
        templatesByDb: {
          ...s.templatesByDb,
          [dbId]: [...next, restored].sort(bySortPos),
        },
      };
    });
    try {
      const calls = await Promise.all([
        durableRemoteCall("createTemplateRemote", [restored as Partial<DbTemplate>]),
        ...previousDefaults.map((id) =>
          durableRemoteCall("updateTemplateRemote", [id, { isDefault: false }, dbId])
        ),
      ]);
      if (calls.every((call) => call.status === "ok")) {
        publishDatabaseTemplatesMutation(dbId, "template_restored");
      }
    } catch {
      /* ignore */
    }
    return true;
  },

  async addRow(dbId, atEnd = true, templateId, opts) {
    assertDatabaseUnlocked(get().pagesById, dbId);
    const ws = get().workspace;
    if (!ws) throw new Error("no workspace");
    const userId = get().userId || (await ensureAuth());
    if (userId && userId !== get().userId) set({ userId });
    if (!canCreatePageInState(get(), dbId, userId)) {
      throw new Error("Page access required.");
    }
    const rows = get().dbRows(dbId);
    const templates = get().dbTemplates(dbId);
    const template =
      templateId === ""
        ? undefined
        : templateId
          ? templates.find((item) => item.id === templateId)
          : templates.find((item) => item.isDefault);
    const id = newId();
    const now = nowIso();
    // Auto-assign values for any unique_id properties (max existing + 1).
    const properties: Record<string, unknown> = cloneJson(template?.properties ?? {});
    for (const p of get().dbProperties(dbId)) {
      if (p.type !== "unique_id") continue;
      let max = 0;
      for (const r of rows) {
        const v = Number(r.properties?.[p.id]);
        if (Number.isFinite(v) && v > max) max = v;
      }
      properties[p.id] = max + 1;
    }
    const row: Page = {
      id,
      createdAt: now,
      updatedAt: now,
      workspaceId: ws.id,
      parentId: dbId,
      parentType: "database",
      kind: "page",
      title: templateTitleValue(template),
      icon: template?.icon,
      iconType: iconTypeForValue(template?.icon),
      font: "default",
      smallText: false,
      fullWidth: false,
      isLocked: false,
      backlinksDisplay: "default",
      pageCommentsDisplay: "default",
      properties,
      position: positionBetween(atEnd ? rows[rows.length - 1]?.position : undefined, undefined),
      isFavorite: false,
      isPublic: false,
      inTrash: false,
      createdBy: userId || undefined,
      lastEditedBy: userId || undefined,
    };
    set((s) => ({
      pagesById: { ...s.pagesById, [id]: row },
      databaseRowIdsByDb: {
        ...s.databaseRowIdsByDb,
        [dbId]: appendUniqueIds(s.databaseRowIdsByDb[dbId] ?? [], [id]),
      },
      databaseRowPagesByDb: {
        ...s.databaseRowPagesByDb,
        [dbId]: {
          ...(s.databaseRowPagesByDb[dbId] ?? { loadedCount: rows.length, hasMore: false }),
          loadedCount: (s.databaseRowPagesByDb[dbId]?.loadedCount ?? rows.length) + 1,
          totalCount:
            typeof s.databaseRowPagesByDb[dbId]?.totalCount === "number"
              ? (s.databaseRowPagesByDb[dbId]?.totalCount ?? 0) + 1
              : s.databaseRowPagesByDb[dbId]?.totalCount,
        },
      },
      ...(opts?.focusTitle ? { focusPageId: id } : {}),
    }));
    const call = await durableRemoteCall("createDatabaseRowRemote", [
      {
        id,
        databaseId: dbId,
        title: row.title,
        templateId,
        empty: templateId === "",
        position: row.position,
      },
    ]);
    if (call.status === "dropped") {
      // Terminal server rejection: roll the optimistic row back (mirror
      // createPage) so it does not linger as a phantom, then surface the error.
      set((s) => {
        const pagesById = { ...s.pagesById };
        delete pagesById[id];
        const pageState = s.databaseRowPagesByDb[dbId];
        return {
          pagesById,
          databaseRowIdsByDb: {
            ...s.databaseRowIdsByDb,
            [dbId]: (s.databaseRowIdsByDb[dbId] ?? []).filter((rid) => rid !== id),
          },
          ...(pageState
            ? {
                databaseRowPagesByDb: {
                  ...s.databaseRowPagesByDb,
                  [dbId]: {
                    ...pageState,
                    loadedCount: Math.max(0, pageState.loadedCount - 1),
                    totalCount:
                      typeof pageState.totalCount === "number"
                        ? Math.max(0, pageState.totalCount - 1)
                        : pageState.totalCount,
                  },
                },
              }
            : {}),
        };
      });
      throw call.error;
    }
    const created =
      call.status === "ok"
        ? (call.result as Awaited<ReturnType<typeof createDatabaseRowRemote>>)
        : undefined;
    if (created) {
      set((s) => ({
        pagesById: { ...s.pagesById, [id]: { ...row, ...created.row } },
      }));
      if (created.blocks.length > 0) {
        set((s) => ({
          blocksByPage: { ...s.blocksByPage, [id]: created.blocks.sort(bySortPos) },
          loadedBlockPages: new Set(s.loadedBlockPages).add(id),
        }));
      }
      publishDatabaseRowsMutation(dbId, "row_created", [id]);
    }
    // queued: the optimistic row is durable in the outbox and usable now.
    return { ...row, ...(created?.row ?? {}) };
  },

  async moveDatabaseRow(rowId, targetId, side) {
    const pagesById = get().pagesById;
    const row = pagesById[rowId];
    const target = pagesById[targetId];
    if (!row || !target) return undefined;
    if (row.isLocked) return undefined;
    if (row.parentType !== "database" || target.parentType !== "database") return undefined;
    if (!row.parentId || row.parentId !== target.parentId) return undefined;
    if (isDatabaseLocked(pagesById, row.parentId)) return undefined;
    if (row.id === target.id) return undefined;

    const siblings = Object.values(pagesById)
      .filter((page) =>
        page.parentType === "database" &&
        page.parentId === row.parentId &&
        !page.inTrash &&
        page.id !== row.id
      )
      .sort(bySortPos);
    const targetIndex = siblings.findIndex((page) => page.id === target.id);
    if (targetIndex < 0) return undefined;

    const insertionIndex = targetIndex + (side === "after" ? 1 : 0);
    const previous = siblings[insertionIndex - 1];
    const next = siblings[insertionIndex];
    const position = positionBetween(previous?.position, next?.position);
    const userId = get().userId;
    const optimistic: Partial<Page> = {
      position,
      updatedAt: nowIso(),
      ...(userId ? { lastEditedBy: userId } : {}),
    };
    const before = row;
    // Capture the pre-move row order so a terminal rejection can restore it;
    // dbRows() orders strictly by databaseRowIdsByDb, so rolling back only the
    // row's position would leave the visible order wrong.
    const beforeOrder = row.parentId ? get().databaseRowIdsByDb[row.parentId] : undefined;
    set((s) => ({
      pagesById: {
        ...s.pagesById,
        [rowId]: { ...row, ...optimistic },
      },
      databaseRowIdsByDb: row.parentId
        ? {
            ...s.databaseRowIdsByDb,
            [row.parentId]: moveIdRelative(s.databaseRowIdsByDb[row.parentId] ?? [], rowId, targetId, side),
          }
        : s.databaseRowIdsByDb,
    }));

    const moveCall = await durableRemoteCall("moveDatabaseRowRemote", [rowId, targetId, side]);
    if (moveCall.status === "dropped") {
      // Terminal rejection: undo the optimistic reorder (the durable layer
      // already toasted unless the row was simply gone).
      set((s) => {
        const current = s.pagesById[rowId];
        if (!current) return {};
        return {
          pagesById: {
            ...s.pagesById,
            [rowId]: { ...current, position: before.position, updatedAt: before.updatedAt },
          },
          ...(row.parentId && beforeOrder
            ? {
                databaseRowIdsByDb: {
                  ...s.databaseRowIdsByDb,
                  [row.parentId]: beforeOrder,
                },
              }
            : {}),
        };
      });
      return undefined;
    }
    if (moveCall.status === "queued") {
      // Offline/transient: keep the optimistic order; the durable op lands later.
      return undefined;
    }
    const persisted = moveCall.result as Awaited<ReturnType<typeof moveDatabaseRowRemote>>;
    set((s) => {
      const current = s.pagesById[rowId];
      if (!current) return {};
      return {
        pagesById: {
          ...s.pagesById,
          [rowId]: { ...current, ...persisted },
        },
      };
    });
    publishDatabaseRowsMutation(row.parentId, "row_moved", [rowId]);
    return persisted;
  },

  setRowProperty(rowId, propId, value, opts) {
    const cur = get().pagesById[rowId];
    if (!cur) return;
    if (cur.isLocked) {
      get().notify(storeMessages().pageLockedSave, "default");
      return;
    }
    if (cur.parentType === "database" && isDatabaseLocked(get().pagesById, cur.parentId)) {
      get().notify(storeMessages().databaseLockedSave, "default");
      return;
    }
    const properties = { ...(cur.properties ?? {}), [propId]: value };
    get().updatePage(rowId, { properties }, { debounce: opts?.debounce ?? true });
  },

  setRelation(rowId, prop, nextIds) {
    const cur = get().pagesById[rowId];
    if (!cur) return;
    const prevIds = asIdArray(cur.properties?.[prop.id]);
    get().setRowProperty(rowId, prop.id, nextIds.length ? nextIds : null, { debounce: false });
    if (isTemplateEditorPageId(rowId)) return;

    // Keep a reciprocal relation in sync: if the target database has a relation
    // property pointing back at this row's database, mirror the link there.
    const sourceDbId = prop.databaseId;
    const targetDbId = prop.config?.relationDatabaseId;
    if (!targetDbId) return;
    const reciprocal = (get().propsByDb[targetDbId] ?? []).find(
      (p) =>
        p.type === "relation" &&
        p.id !== prop.id &&
        (p.config?.relationDatabaseId ?? p.databaseId) === sourceDbId
    );
    if (!reciprocal) return;

    const added = nextIds.filter((id) => !prevIds.includes(id));
    const removed = prevIds.filter((id) => !nextIds.includes(id));
    for (const targetId of added) {
      const target = get().pagesById[targetId];
      if (!target) continue;
      const ids = asIdArray(target.properties?.[reciprocal.id]);
      if (!ids.includes(rowId)) {
        get().setRowProperty(targetId, reciprocal.id, [...ids, rowId], { debounce: false });
      }
    }
    for (const targetId of removed) {
      const target = get().pagesById[targetId];
      if (!target) continue;
      const ids = asIdArray(target.properties?.[reciprocal.id]);
      if (ids.includes(rowId)) {
        const next = ids.filter((id) => id !== rowId);
        get().setRowProperty(targetId, reciprocal.id, next.length ? next : null, { debounce: false });
      }
    }
  },
}));

function asIdArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}
