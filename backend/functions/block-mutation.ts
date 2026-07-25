import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { assertOrganizationDlpContent } from '../lib/enterprise-controls';
import { isServerBlockMutationReceipt } from '../lib/block-mutation-receipt';
import { MAX_RAW_TRANSACT_OPS, boundedDbFromPageHint } from '../lib/workspace-db';
import { upsertNotification } from '../lib/notifications';
import { workspaceMembershipForUser } from '../lib/notification-recipient-access';
import {
  pageAccessRole as sharedPageAccessRole,
  pageHasDirectAccess as sharedPageHasDirectAccess,
} from '../lib/page-access';

import {
  bestEffort,
  isNotFoundError,
  listAll,
  projectFields,
  requireStringRaw as requireString,
  getExisting,
  nowIso,
  type TransactOperation,
} from '../lib/table-utils';
import { v } from '../lib/validate';
import type { ShareRole } from '../lib/page-access';
import type {
  Block,
  DbRef,
  FileUpload,
  FunctionContext,
  Page,
  TableRef,
  Workspace,
} from '../lib/app-types';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';
import {
  assertFileTargetsNotDeleting,
  withFileWorkspaceLease,
} from '../lib/file-operation-lock';
import {
  deletionOperationsForAssociation,
  fileReferenceTransitionOperations,
  hasPotentialStoredFileReference,
  storedFileReferencesChanged,
} from '../lib/file-reference-lifecycle';

type BlockPatch = Partial<Block>;

type PageRecencyProof = {
  blockId: string;
  blockUpdatedAt: string;
  mutationId: string;
  pageId: string;
};

type BlockUpdateResult = {
  block: Block;
  pageRecency?: PageRecencyProof;
};

const patchKeys = new Set<keyof Block>([
  'pageId',
  'parentId',
  'type',
  'content',
  'plainText',
  'position',
  'updatedAt',
]);
// Block types are app-defined short identifiers; content/plainText carry the
// document payload, so they get the long-text ceiling instead.
const blockCreateSchema = v.object({
  id: v.id(),
  pageId: v.id(),
  parentId: v.nullish(v.id()),
  type: v.nullish(v.string({ min: 1, max: 64 })),
  content: v.nullish(v.jsonRecord()),
  plainText: v.nullish(v.longText()),
  position: v.number(),
  touchPage: v.optional(v.boolean()),
});

const blockPatchSchema = v.object({
  pageId: v.optional(v.id()),
  parentId: v.nullish(v.id()),
  type: v.nullish(v.string({ min: 1, max: 64 })),
  content: v.nullish(v.jsonRecord()),
  plainText: v.nullish(v.longText()),
  position: v.nullish(v.number()),
  updatedAt: v.nullish(v.shortText()),
});

const blockUpdateSchema = v.object({
  id: v.id(),
  expectedMutationId: v.nullish(v.string({ min: 1, max: 160 })),
  expectedUpdatedAt: v.nullish(v.shortText()),
  mutationId: v.nullish(v.string({ min: 1, max: 160 })),
  patch: v.optional(blockPatchSchema),
});

const blockDeleteSchema = v.object({
  id: v.id(),
  expectedUpdatedAt: v.nullish(v.shortText()),
});

const blockCreateManySchema = v.object({
  blocks: v.optional(v.array(blockCreateSchema)),
});

const blockUpdateManySchema = v.object({
  updates: v.optional(v.array(blockUpdateSchema)),
});

const blockPageRecencySchema = v.object({
  blockId: v.id(),
  blockUpdatedAt: v.shortText(),
  mutationId: v.string({ min: 1, max: 160 }),
  pageId: v.id(),
});

const blockDeleteManySchema = v.object({
  ids: v.optional(v.array(v.id(), { max: 100 })),
});

const blockSnapshotManySchema = v.object({
  pageId: v.id(),
  creates: v.optional(v.array(blockCreateSchema, { max: 100 })),
  updates: v.optional(v.array(blockUpdateSchema, { max: 100 })),
  deleteIds: v.optional(v.array(v.id(), { max: 100 })),
});

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

function parsePosition(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('position must be a finite number.');
  }
  return value;
}

function optionalParentId(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('parentId must be a string or null.');
  return value;
}

function optionalExpectedUpdatedAt(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('expectedUpdatedAt must be a non-empty string when provided.');
  }
  return value.trim();
}

function optionalMutationId(value: unknown, field: 'mutationId' | 'expectedMutationId') {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 160) {
    throw new Error(`${field} must be a non-empty string of at most 160 characters when provided.`);
  }
  const normalized = value.trim();
  if (field === 'mutationId' && isServerBlockMutationReceipt(normalized)) {
    throw Object.assign(
      new Error('mutationId uses a reserved server receipt prefix.'),
      { status: 400 },
    );
  }
  return normalized;
}

function blockBaseExpectationsMatch(
  current: Block,
  expectedUpdatedAt: string | undefined,
  expectedMutationId: string | undefined,
  actorId: string,
) {
  if (!expectedUpdatedAt && !expectedMutationId) return true;
  // A queued generation has two safe alternate bases while its predecessor is
  // held: the predecessor did not land (the timestamp still matches), or it
  // landed and lost its response (the authenticated actor + receipt match).
  // CRDT checkpoints replace lastMutationId with a reserved server receipt, so
  // an older client receipt cannot authorize overwriting checkpointed text.
  const timestampMatches = !!expectedUpdatedAt && current.updatedAt === expectedUpdatedAt;
  const priorSameActorMutationMatches = !!expectedMutationId
    && current.lastMutationId === expectedMutationId
    && current.lastEditedBy === actorId;
  return timestampMatches || priorSameActorMutationMatches;
}

function cleanPatch(patch: Record<string, unknown>): BlockPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!patchKeys.has(key as keyof Block)) continue;
    if (value !== undefined) out[key] = value;
  }
  delete out.id;
  delete out.createdAt;
  delete out.createdBy;
  return out as BlockPatch;
}

function blockPatchChangesStructure(patch: BlockPatch) {
  return 'pageId' in patch || 'parentId' in patch || 'position' in patch;
}

function pageRecencyProof(block: Block, mutationId: string | undefined): PageRecencyProof | undefined {
  if (
    !mutationId
    || block.lastMutationId !== mutationId
    || typeof block.updatedAt !== 'string'
    || !block.updatedAt
  ) return undefined;
  return {
    blockId: block.id,
    blockUpdatedAt: block.updatedAt,
    mutationId,
    pageId: block.pageId,
  };
}

function blockUpdateResult(
  block: Block,
  mutationId: string | undefined,
  deferPageRecency: boolean,
): BlockUpdateResult {
  const proof = deferPageRecency ? pageRecencyProof(block, mutationId) : undefined;
  return { block, ...(proof ? { pageRecency: proof } : {}) };
}

function committedUpdatedBlock(
  transaction: Awaited<ReturnType<DbRef['transact']>>,
  operations: readonly TransactOperation[],
  updateOperation: TransactOperation,
  expectedId: string,
) {
  const operationIndex = operations.indexOf(updateOperation);
  const updated = operationIndex >= 0
    ? transaction.results[operationIndex]?.updated
    : undefined;
  if (
    !updated
    || typeof updated !== 'object'
    || Array.isArray(updated)
    || (updated as { id?: unknown }).id !== expectedId
  ) {
    throw new Error('Block update transaction did not return the committed row.');
  }
  return updated as unknown as Block;
}

function latestPageRecencyProofs(results: readonly BlockUpdateResult[]) {
  const byPage = new Map<string, PageRecencyProof>();
  for (const result of results) {
    const proof = result.pageRecency;
    if (!proof) continue;
    const current = byPage.get(proof.pageId);
    if (!current || proof.blockUpdatedAt > current.blockUpdatedAt) {
      byPage.set(proof.pageId, proof);
    }
  }
  return Array.from(byPage.values());
}

function textIsOrderedSubsequence(candidate: string, merged: string) {
  if (!candidate) return true;
  let candidateIndex = 0;
  for (let mergedIndex = 0; mergedIndex < merged.length; mergedIndex += 1) {
    if (merged[mergedIndex] !== candidate[candidateIndex]) continue;
    candidateIndex += 1;
    if (candidateIndex === candidate.length) return true;
  }
  return false;
}

function blockTextPatchIsSubsumed(current: Block, patch: BlockPatch) {
  const incomingText = typeof patch.plainText === 'string' ? patch.plainText : undefined;
  const textSnapshotOnly = Object.keys(patch).every((key) => (
    key === 'content' || key === 'plainText' || key === 'updatedAt'
  ));
  return textSnapshotOnly
    && incomingText !== undefined
    && textIsOrderedSubsequence(incomingText, current.plainText ?? '');
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValueEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && jsonValueEqual(leftRecord[key], rightRecord[key])
    ));
}

function blockPatchAlreadyApplied(current: Block, patch: BlockPatch) {
  const entries = Object.entries(patch);
  if (entries.length === 0) return false;
  const currentRecord = current as unknown as Record<string, unknown>;
  return entries.every(([key, value]) => jsonValueEqual(currentRecord[key], value));
}

function isTransactionExpectationFailure(error: unknown) {
  return error instanceof Error && /transaction expectation failed/i.test(error.message);
}

// Role resolution is canonical in lib/page-access.
async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail);
}

async function assertCanEditPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Page access required.');
}

async function getWritablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null): Promise<Page> {
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (!page) throw new Error('Page was not found.');
  if (page.inTrash) throw new Error('Page is in trash.');
  if (page.isLocked) throw new Error('Page is locked.');
  if (page.deletionPendingAt) {
    throw Object.assign(new Error('Page deletion is already in progress.'), { status: 409 });
  }
  await assertCanEditPage(db, page, actorId, actorEmail);
  return page;
}

function writablePageForBatch(
  cache: Map<string, Promise<Page>>,
  db: DbRef,
  pageId: string,
  actorId: string,
  actorEmail?: string | null,
) {
  const cached = cache.get(pageId);
  if (cached) return cached;
  const pending = getWritablePage(db, pageId, actorId, actorEmail);
  cache.set(pageId, pending);
  return pending;
}

function writablePageExpectation(page: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: page.id,
    where: [
      ['workspaceId', '==', page.workspaceId],
      ['inTrash', '==', page.inTrash ?? null],
      ['isLocked', '==', page.isLocked ?? null],
      ['deletionPendingAt', '==', null],
    ],
    exists: true,
  };
}

function pageEditOperation(page: Page, actorId: string, updatedAt: string): TransactOperation {
  return {
    table: 'pages',
    op: 'update',
    id: page.id,
    data: { updatedAt, lastEditedBy: actorId },
  };
}

function pageRecencyExpectation(page: Page): TransactOperation {
  return {
    table: 'pages',
    op: 'expect',
    id: page.id,
    where: [
      ['workspaceId', '==', page.workspaceId],
      ['updatedAt', '==', page.updatedAt ?? null],
      ['lastEditedBy', '==', page.lastEditedBy ?? null],
      ['inTrash', '==', page.inTrash ?? null],
      ['isLocked', '==', page.isLocked ?? null],
      ['deletionPendingAt', '==', page.deletionPendingAt ?? null],
    ],
    exists: true,
  };
}

function blockSnapshotExpectation(block: Block): TransactOperation {
  return {
    table: 'blocks',
    op: 'expect',
    id: block.id,
    where: [
      ['pageId', '==', block.pageId],
      ['parentId', '==', block.parentId ?? null],
      ['updatedAt', '==', block.updatedAt ?? null],
    ],
    exists: true,
  };
}

function pageTitle(page: Page) {
  return page.title?.trim() || 'Untitled';
}

function blockTarget(pageId: string, blockId: string) {
  return `/p/${encodeURIComponent(pageId)}#block-${encodeURIComponent(blockId)}`;
}

function richTextPreview(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const rich = Array.isArray(value) ? value : (value as { rich?: unknown }).rich;
  if (!Array.isArray(rich)) return '';
  return rich
    .map((span) =>
      span && typeof span === 'object' && typeof (span as { text?: unknown }).text === 'string'
        ? (span as { text: string }).text
        : '',
    )
    .join('')
    .trim();
}

function blockPreview(block: Block) {
  const content = block.content ?? {};
  return (
    richTextPreview(content.rich) ||
    richTextPreview(content.caption) ||
    block.plainText?.trim() ||
    'Mentioned you'
  ).slice(0, 500);
}

function mentionedPersonIds(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (item: unknown) => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (record.mention === 'person' && typeof record.userId === 'string' && record.userId.trim()) {
      out.add(record.userId.trim());
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return Array.from(out);
}

async function canUserSeePage(db: DbRef, page: Page, userId: string) {
  if (page.createdBy === userId || page.lastEditedBy === userId) return true;
  const workspace = await getExisting(db.table<Workspace>('workspaces'), page.workspaceId);
  if (workspace?.ownerId === userId) return true;
  if (await workspaceMembershipForUser(db, page.workspaceId, userId)) return true;
  return sharedPageHasDirectAccess(db, page, userId);
}

async function emitBlockMentionNotifications(
  db: DbRef,
  page: Page,
  block: Block,
  actorId: string,
) {
  const mentionedIds = mentionedPersonIds(block.content);
  if (mentionedIds.length === 0) return;
  const occurredAt = block.updatedAt ?? block.createdAt ?? nowIso();
  const atKey = Date.parse(occurredAt) || occurredAt;
  const preview = blockPreview(block);

  for (const userId of mentionedIds) {
    if (userId === actorId || !(await canUserSeePage(db, page, userId))) continue;
    await bestEffort('block-mutation mention notification', upsertNotification(db, {
      workspaceId: page.workspaceId,
      userId,
      activityKey: `mention:block:${block.id}:${userId}:${atKey}`,
      kind: 'mention',
      pageId: page.id,
      blockId: block.id,
      commentId: null,
      actorId,
      title: pageTitle(page),
      preview,
      target: blockTarget(page.id, block.id),
      metadata: { source: 'block' },
      occurredAt,
    }));
  }
}

async function transactGroupsChunked(
  db: DbRef,
  groups: TransactOperation[][],
  beforeChunk?: () => Promise<void>,
) {
  if (groups.some((group) => group.length > MAX_RAW_TRANSACT_OPS)) {
    throw Object.assign(
      new Error('A block has too many stored files to delete safely in one operation.'),
      { status: 413 },
    );
  }
  const chunks: TransactOperation[][] = [];
  let chunk: TransactOperation[] = [];
  for (const group of groups) {
    if (chunk.length > 0 && chunk.length + group.length > MAX_RAW_TRANSACT_OPS) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(...group);
  }
  if (chunk.length > 0) chunks.push(chunk);
  for (const operations of chunks) {
    if (beforeChunk) await beforeChunk();
    await db.transact(operations);
  }
}

async function assertParentBlockOnPage(blocks: TableRef<Block>, parentId: string | null | undefined, pageId: string, currentId?: string) {
  if (!parentId) return;
  if (parentId === currentId) throw new Error('Block cannot be its own parent.');
  let parent = await getExisting(blocks, parentId);
  if (!parent || parent.pageId !== pageId) throw new Error('Parent block was not found on the target page.');

  const visited = new Set<string>();
  while (parent) {
    if (currentId && parent.id === currentId) {
      throw new Error('Block cannot be moved under its own descendant.');
    }
    if (visited.has(parent.id)) throw new Error('Block parent cycle detected.');
    visited.add(parent.id);
    if (!parent.parentId) return;
    parent = await getExisting(blocks, parent.parentId);
    if (!parent || parent.pageId !== pageId) {
      throw new Error('Parent block was not found on the target page.');
    }
  }
}

function blockFromBody(body: Record<string, unknown>, actorId: string): Block {
  const now = nowIso();
  return {
    id: requireString(body.id, 'id'),
    pageId: requireString(body.pageId, 'pageId'),
    parentId: optionalParentId(body.parentId),
    type: typeof body.type === 'string' && body.type ? body.type : 'paragraph',
    content:
      body.content && typeof body.content === 'object'
        ? (body.content as Record<string, unknown>)
        : undefined,
    plainText: typeof body.plainText === 'string' ? body.plainText : undefined,
    position: parsePosition(body.position),
    createdBy: actorId,
    lastEditedBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
}

async function createBlock(
  db: DbRef,
  blocks: TableRef<Block>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const block = blockFromBody(body, actorId);
  const initialPage = await getWritablePage(db, block.pageId, actorId, actorEmail);
  let committedPage = initialPage;
  const inserted = await withFileWorkspaceLease(
    db,
    initialPage.workspaceId,
    actorId,
    'block-structural-create',
    async (lease) => {
      await lease.assertOwned();
      const page = await getWritablePage(db, block.pageId, actorId, actorEmail);
      if (page.workspaceId !== initialPage.workspaceId) {
        throw Object.assign(new Error('Page changed workspaces while the block was being created.'), { status: 409 });
      }
      await assertFileTargetsNotDeleting(db, page.workspaceId, [page.id]);
      await assertParentBlockOnPage(blocks, block.parentId, block.pageId);
      const transitions = hasPotentialStoredFileReference(block.content)
        ? await fileReferenceTransitionOperations(db, {
            table: 'blocks',
            current: { id: block.id },
            data: block as unknown as Record<string, unknown> & Partial<{ id: string }>,
            currentReferences: {},
            nextReferences: block.content,
            association: { field: 'blockId', id: block.id },
            actorId,
          })
        : [];
      const blockInsertOperation: TransactOperation = {
        table: 'blocks',
        op: 'insert',
        data: block as unknown as Record<string, unknown>,
      };
      const operations: TransactOperation[] = [
        writablePageExpectation(page),
        ...(block.parentId ? [{
          table: 'blocks',
          op: 'expect' as const,
          id: block.parentId,
          where: [['pageId', '==', block.pageId] as [string, '==', unknown]],
          exists: true,
        }] : []),
        { table: 'blocks', op: 'expect', id: block.id, exists: false },
        ...transitions,
        blockInsertOperation,
        ...(body.touchPage === true
          ? [pageEditOperation(page, actorId, block.updatedAt ?? nowIso())]
          : []),
      ];
      if (operations.length > MAX_RAW_TRANSACT_OPS) {
        throw Object.assign(new Error('Block contains too many stored files.'), { status: 413 });
      }
      await lease.renew();
      const transaction = await db.transact(operations);
      const inserted = transaction.results[operations.indexOf(blockInsertOperation)]?.inserted;
      if (
        !inserted
        || typeof inserted !== 'object'
        || Array.isArray(inserted)
        || (inserted as { id?: unknown }).id !== block.id
      ) {
        throw new Error('Block create transaction did not return the committed row.');
      }
      committedPage = page;
      return inserted as unknown as Block;
    },
  );
  await emitBlockMentionNotifications(db, committedPage, inserted, actorId);
  return inserted;
}

const CREATE_MANY_VALIDATION_READ_CHUNK_SIZE = 100;
const CREATE_MANY_TARGETED_ANCESTRY_LEVELS = 8;
const CREATE_MANY_FALLBACK_PAGE_CONCURRENCY = 3;
const CREATE_MANY_VALIDATION_FIELDS = ['id', 'pageId', 'parentId'] as const;

interface PendingBlockValidation {
  mustBeAbsent: boolean;
  expectedPageIds: Set<string>;
}

function requireValidationBlock(
  pending: Map<string, PendingBlockValidation>,
  id: string,
  pageId: string,
) {
  const current = pending.get(id);
  if (current) {
    current.expectedPageIds.add(pageId);
    return;
  }
  pending.set(id, { mustBeAbsent: false, expectedPageIds: new Set([pageId]) });
}

async function createManyValidationBlocks(
  blocks: TableRef<Block>,
  candidates: Block[],
  candidateIds: Set<string>,
) {
  let pending = new Map<string, PendingBlockValidation>();
  for (const id of candidateIds) {
    pending.set(id, { mustBeAbsent: true, expectedPageIds: new Set() });
  }
  for (const candidate of candidates) {
    if (candidate.parentId && !candidateIds.has(candidate.parentId)) {
      requireValidationBlock(pending, candidate.parentId, candidate.pageId);
    }
  }

  const knownBlocks = new Map<string, Block>();
  let targetedLevels = 0;
  while (pending.size > 0) {
    const requested = Array.from(pending.entries());
    if (targetedLevels >= CREATE_MANY_TARGETED_ANCESTRY_LEVELS) {
      // EdgeBase's table API has no recursive-ancestor query. Bound the
      // dependency walk rather than issuing one request per level forever;
      // legacy deep graphs retain the former full-page validation semantics.
      // Pages stay separate so each keeps listAll's existing 25k row ceiling.
      const pageIds = Array.from(new Set(candidates.map((candidate) => candidate.pageId)));
      for (let index = 0; index < pageIds.length; index += CREATE_MANY_FALLBACK_PAGE_CONCURRENCY) {
        const pageChunk = pageIds.slice(index, index + CREATE_MANY_FALLBACK_PAGE_CONCURRENCY);
        const pageGroups = await Promise.all(pageChunk.map(async (pageId) => {
          const rows = await listAll(
            projectFields(
              blocks.where('pageId', '==', pageId),
              CREATE_MANY_VALIDATION_FIELDS,
            ),
            { label: `Block createMany fallback graph for page ${pageId}` },
          );
          return rows.filter((row) => row.pageId === pageId);
        }));
        for (const block of pageGroups.flat()) {
          if (candidateIds.has(block.id)) {
            throw Object.assign(new Error(`Block ${block.id} already exists.`), { status: 409 });
          }
          knownBlocks.set(block.id, block);
        }
      }
      for (const [id, validation] of requested) {
        const block = knownBlocks.get(id);
        if (
          validation.mustBeAbsent
            ? !!block
            : !block || !validation.expectedPageIds.has(block.pageId)
        ) {
          if (validation.mustBeAbsent) {
            throw Object.assign(new Error(`Block ${id} already exists.`), { status: 409 });
          }
          throw new Error('Parent block was not found on the target page.');
        }
      }
      return knownBlocks;
    }
    targetedLevels += 1;
    const chunks: Array<typeof requested> = [];
    for (let index = 0; index < requested.length; index += CREATE_MANY_VALIDATION_READ_CHUNK_SIZE) {
      chunks.push(requested.slice(index, index + CREATE_MANY_VALIDATION_READ_CHUNK_SIZE));
    }
    // A createMany transaction can contain at most 119 block inserts after its
    // page/expect overhead. Candidate ids plus direct parents therefore make
    // no more than three chunks; later ancestry levels make no more than two.
    // Start compatible chunks together, then discover the next required level.
    const loadedGroups = await Promise.all(chunks.map(async (chunk) => {
      const ids = chunk.map(([id]) => id);
      const idSet = new Set(ids);
      const rows = await listAll(
        projectFields(blocks.where('id', 'in', ids), CREATE_MANY_VALIDATION_FIELDS),
        {
          maxItems: ids.length,
          pageSize: ids.length,
          label: 'Block createMany validation graph',
        },
      );
      return rows.filter((row) => idSet.has(row.id));
    }));
    const loadedById = new Map(loadedGroups.flat().map((block) => [block.id, block]));

    const nextPending = new Map<string, PendingBlockValidation>();
    for (const [id, validation] of requested) {
      const block = loadedById.get(id);
      if (validation.mustBeAbsent) {
        if (block) {
          throw Object.assign(new Error(`Block ${id} already exists.`), { status: 409 });
        }
        continue;
      }
      if (!block || !validation.expectedPageIds.has(block.pageId)) {
        throw new Error('Parent block was not found on the target page.');
      }
      knownBlocks.set(block.id, block);
    }

    for (const [id, validation] of requested) {
      if (validation.mustBeAbsent) continue;
      const block = knownBlocks.get(id)!;
      const parentId = block.parentId;
      if (!parentId || candidateIds.has(parentId)) continue;
      const knownParent = knownBlocks.get(parentId);
      if (knownParent) {
        if (knownParent.pageId !== block.pageId) {
          throw new Error('Parent block was not found on the target page.');
        }
        continue;
      }
      requireValidationBlock(nextPending, parentId, block.pageId);
    }
    pending = nextPending;
  }
  return knownBlocks;
}

async function createBlocksAtomically(
  db: DbRef,
  blocks: TableRef<Block>,
  bodies: Record<string, unknown>[],
  actorId: string,
  actorEmail?: string | null,
) {
  if (bodies.length === 0) return [];
  const candidates = bodies.map((body) => blockFromBody(body, actorId));
  if (candidates.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Too many blocks for one atomic create.'),
      { status: 413 },
    );
  }
  const candidateIds = new Set<string>();
  for (const block of candidates) {
    if (candidateIds.has(block.id)) throw new Error(`Block ${block.id} appears more than once in createMany.`);
    candidateIds.add(block.id);
  }

  const pages = new Map<string, Page>();
  for (const pageId of new Set(candidates.map((block) => block.pageId))) {
    pages.set(pageId, await getWritablePage(db, pageId, actorId, actorEmail));
  }
  const workspaceIds = new Set(Array.from(pages.values()).map((page) => page.workspaceId));
  if (workspaceIds.size !== 1) throw new Error('createMany blocks must belong to one workspace.');
  const workspaceId = Array.from(workspaceIds)[0]!;
  const externalParentIds = new Set(
    candidates
      .map((block) => block.parentId)
      .filter((id): id is string => !!id && !candidateIds.has(id)),
  );
  const baseOperationCount = pages.size + externalParentIds.size + (candidates.length * 2);
  if (baseOperationCount > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Block batch contains too many records or stored files.'),
      { status: 413 },
    );
  }
  await withFileWorkspaceLease(
    db,
    workspaceId,
    actorId,
    'block-structural-create-many',
    async (lease) => {
      await lease.assertOwned();
      const freshPages = new Map<string, Page>();
      for (const pageId of new Set(candidates.map((block) => block.pageId))) {
        const page = await getWritablePage(db, pageId, actorId, actorEmail);
        if (page.workspaceId !== workspaceId) {
          throw Object.assign(new Error('Page changed workspaces while blocks were being created.'), { status: 409 });
        }
        await assertFileTargetsNotDeleting(db, workspaceId, [pageId]);
        freshPages.set(pageId, page);
      }
      const knownBlocks = await createManyValidationBlocks(blocks, candidates, candidateIds);
      for (const block of candidates) knownBlocks.set(block.id, block);
      for (const block of candidates) {
        const visited = new Set<string>([block.id]);
        let parentId = block.parentId;
        while (parentId) {
          const parent = knownBlocks.get(parentId);
          if (!parent || parent.pageId !== block.pageId) {
            throw new Error('Parent block was not found on the target page.');
          }
          if (visited.has(parent.id)) throw new Error('Block parent cycle detected.');
          visited.add(parent.id);
          parentId = parent.parentId;
        }
      }

      const operations: TransactOperation[] = [];
      for (const page of freshPages.values()) {
        operations.push(writablePageExpectation(page));
      }
      for (const parentId of externalParentIds) {
        const parent = knownBlocks.get(parentId)!;
        operations.push({
          table: 'blocks',
          op: 'expect',
          id: parent.id,
          where: [['pageId', '==', parent.pageId]],
          exists: true,
        });
      }
      for (const block of candidates) {
        const transitions = hasPotentialStoredFileReference(block.content)
          ? await fileReferenceTransitionOperations(db, {
              table: 'blocks',
              current: { id: block.id },
              data: block as unknown as Record<string, unknown> & Partial<{ id: string }>,
              currentReferences: {},
              nextReferences: block.content,
              association: { field: 'blockId', id: block.id },
              actorId,
            })
          : [];
        operations.push(
          { table: 'blocks', op: 'expect', id: block.id, exists: false },
          ...transitions,
          { table: 'blocks', op: 'insert', data: block as unknown as Record<string, unknown> },
        );
      }
      if (operations.length > MAX_RAW_TRANSACT_OPS) {
        throw Object.assign(new Error('Block batch contains too many records or stored files.'), { status: 413 });
      }
      await lease.renew();
      await db.transact(operations);
      pages.clear();
      for (const [pageId, page] of freshPages) pages.set(pageId, page);
    },
  );
  for (const block of candidates) {
    await emitBlockMentionNotifications(db, pages.get(block.pageId)!, block, actorId);
  }
  return candidates;
}

async function updateBlock(
  db: DbRef,
  blocks: TableRef<Block>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const id = requireString(body.id, 'id');
  const current = await getExisting(blocks, id);
  if (!current) throw new Error('Block was not found.');
  const mutationId = optionalMutationId(body.mutationId, 'mutationId');
  const expectedMutationId = optionalMutationId(body.expectedMutationId, 'expectedMutationId');
  const expectedUpdatedAt = optionalExpectedUpdatedAt(body.expectedUpdatedAt);
  const currentPage = await getWritablePage(db, current.pageId, actorId, actorEmail);

  const patch = cleanPatch(
    body.patch && typeof body.patch === 'object' ? (body.patch as Record<string, unknown>) : {},
  );
  // A response can be lost after commit when the user refreshes while the sync
  // badge is still active. The durable outbox then repeats the same generation.
  // Its server receipt is stronger than comparing browser/server wall clocks.
  if (
    mutationId &&
    current.lastMutationId === mutationId &&
    current.lastEditedBy === actorId
  ) {
    return blockUpdateResult(current, mutationId, !blockPatchChangesStructure(patch));
  }
  const expectedBaseMatches = blockBaseExpectationsMatch(
    current,
    expectedUpdatedAt,
    expectedMutationId,
    actorId,
  );
  if ((expectedUpdatedAt || expectedMutationId) && !expectedBaseMatches) {
    // The browser may reload after the server commits this request but before
    // its response reaches the old tab. The new tab then replays the same
    // durable patch with the original CAS stamp. If every persisted field —
    // including the client mutation's updatedAt — already matches, this is an
    // ambiguous-commit retry, not another-device conflict.
    if (blockPatchAlreadyApplied(current, patch)) {
      return blockUpdateResult(current, mutationId, !blockPatchChangesStructure(patch));
    }
    // Offline/outbox replay can race a newer CRDT checkpoint even though its
    // text is already present in the converged row. Acknowledge that exact
    // subsumed case; true stale conflicts still surface normally.
    if (blockTextPatchIsSubsumed(current, patch)) {
      return blockUpdateResult(current, mutationId, !blockPatchChangesStructure(patch));
    }
    throw new Error('Block changed since it was loaded.');
  }
  const targetPageId = patch.pageId && patch.pageId !== current.pageId ? patch.pageId : current.pageId;
  const targetPage = targetPageId !== current.pageId
    ? await getWritablePage(db, targetPageId, actorId, actorEmail)
    : currentPage;
  if (targetPage.workspaceId !== currentPage.workspaceId) {
    throw Object.assign(new Error('Blocks cannot move across workspaces.'), { status: 409 });
  }
  if ('parentId' in patch) patch.parentId = patch.parentId ?? null;
  // `'parentId' in patch` distinguishes an explicit null (move to top level)
  // from an absent field (keep the current parent); `??` would conflate them
  // and assert the OLD parent against the NEW page.
  const effectiveParentId = 'parentId' in patch ? patch.parentId : current.parentId;
  await assertParentBlockOnPage(blocks, effectiveParentId, targetPageId, id);

  const rootPatch: BlockPatch = {
    ...patch,
    updatedAt: patch.updatedAt ?? nowIso(),
    lastEditedBy: actorId,
    ...(mutationId ? { lastMutationId: mutationId } : {}),
  };
  const storedFilesChanged = storedFileReferencesChanged(
    current.content,
    { ...current, ...rootPatch }.content,
  );
  const deferPageRecency = !!mutationId
    && targetPageId === current.pageId
    && !blockPatchChangesStructure(patch)
    && !storedFilesChanged;
  if (storedFilesChanged && targetPageId !== current.pageId) {
    throw Object.assign(
      new Error('Stored-file updates cannot be combined with a cross-page block move.'),
      { status: 409 },
    );
  }
  let updated: Block;
  let notificationPage = targetPage;
  if (targetPageId !== current.pageId) {
    updated = await withFileWorkspaceLease(
      db,
      currentPage.workspaceId,
      actorId,
      'block-subtree-cross-page-move',
      async (lease) => {
        await lease.assertOwned();
        const freshCurrentPage = await getWritablePage(db, current.pageId, actorId, actorEmail);
        const freshTargetPage = await getWritablePage(db, targetPageId, actorId, actorEmail);
        if (
          freshCurrentPage.workspaceId !== currentPage.workspaceId
          || freshTargetPage.workspaceId !== currentPage.workspaceId
        ) {
          throw Object.assign(new Error('Blocks cannot move across workspaces.'), { status: 409 });
        }
        await assertFileTargetsNotDeleting(
          db,
          currentPage.workspaceId,
          [freshCurrentPage.id, freshTargetPage.id],
        );
        const candidateBlocks = [
          ...(await listAll(blocks.where('pageId', '==', current.pageId))),
          ...(await listAll(blocks.where('pageId', '==', targetPageId))),
        ];
        const byId = new Map(candidateBlocks.map((block) => [block.id, block]));
        const freshRoot = byId.get(id);
        if (!freshRoot || freshRoot.updatedAt !== current.updatedAt) {
          throw new Error('Block changed since it was loaded.');
        }
        if (freshRoot.pageId !== current.pageId) {
          throw new Error('Block changed since it was loaded.');
        }
        // The target parent was validated before the lease was acquired. A
        // concurrent subtree delete may have removed it while this move waited,
        // so validate the live graph again under the shared structural lease.
        await assertParentBlockOnPage(blocks, effectiveParentId, targetPageId, id);
        const freshDescendantIds: string[] = [];
        const collect = (blockId: string) => {
          for (const block of candidateBlocks) {
            if (block.parentId === blockId && !freshDescendantIds.includes(block.id)) {
              freshDescendantIds.push(block.id);
              collect(block.id);
            }
          }
        };
        collect(id);
        const moveStamp = nowIso();
        const groups: TransactOperation[][] = [];
        for (const blockId of [...freshDescendantIds].reverse().concat(id)) {
          const block = byId.get(blockId);
          if (!block) throw new Error('Block changed since it was loaded.');
          const uploads = await listAll(
            db.table<FileUpload>('file_uploads').where('blockId', '==', blockId),
          );
          groups.push([
            ...(blockId === id
              ? [
                  writablePageExpectation(freshCurrentPage),
                  writablePageExpectation(freshTargetPage),
                ]
              : []),
            ...(blockId === id && effectiveParentId ? [{
              table: 'blocks',
              op: 'expect' as const,
              id: effectiveParentId,
              where: [['pageId', '==', targetPageId] as [string, '==', unknown]],
              exists: true,
            }] : []),
            {
              table: 'blocks',
              op: 'expect',
              id: blockId,
              where: [
                ['pageId', '==', block.pageId],
                ['parentId', '==', block.parentId ?? null],
                ...(blockId === id ? [['updatedAt', '==', block.updatedAt ?? null] as [string, '==', unknown]] : []),
              ],
              exists: true,
            },
            ...uploads.map((upload): TransactOperation => ({
              table: 'file_uploads',
              op: 'update',
              id: upload.id,
              data: { pageId: targetPageId, updatedAt: moveStamp },
            })),
            {
              table: 'blocks',
              op: 'update',
              id: blockId,
              data: blockId === id
                ? rootPatch as Record<string, unknown>
                : { pageId: targetPageId, updatedAt: moveStamp },
            },
          ]);
        }
        const pageEditedAt = nowIso();
        const operations = [
          ...groups.flat(),
          pageEditOperation(freshCurrentPage, actorId, pageEditedAt),
          pageEditOperation(freshTargetPage, actorId, pageEditedAt),
        ];
        // Cross-page subtree moves are all-or-nothing. Descendant-first chunks
        // left a durable split tree if a later chunk failed (descendants on the
        // target page, root on the source), and a later source-page delete could
        // then orphan those descendants. Reject before the first content write
        // when the complete move cannot fit one transaction.
        if (operations.length > MAX_RAW_TRANSACT_OPS) {
          throw Object.assign(
            new Error('Block subtree is too large to move atomically.'),
            { status: 413 },
          );
        }
        await lease.renew();
        await db.transact(operations);
        notificationPage = freshTargetPage;
        return { ...freshRoot, ...rootPatch } as Block;
      },
    );
  } else if ('parentId' in patch) {
    updated = await withFileWorkspaceLease(
      db,
      currentPage.workspaceId,
      actorId,
      'block-structural-reparent',
      async (lease) => {
        await lease.assertOwned();
        const fresh = await getExisting(blocks, id);
        if (!fresh) throw new Error('Block was not found.');
        if (fresh.updatedAt !== current.updatedAt || fresh.pageId !== current.pageId) {
          throw new Error('Block changed since it was loaded.');
        }
        const page = await getWritablePage(db, fresh.pageId, actorId, actorEmail);
        if (page.workspaceId !== currentPage.workspaceId) {
          throw Object.assign(new Error('Page changed workspaces while the block was moving.'), { status: 409 });
        }
        await assertFileTargetsNotDeleting(db, page.workspaceId, [page.id]);
        await assertParentBlockOnPage(blocks, effectiveParentId, fresh.pageId, id);
        const next = { ...fresh, ...rootPatch } as Block;
        const transitions = storedFilesChanged
          ? await fileReferenceTransitionOperations(db, {
              table: 'blocks',
              current: fresh,
              data: rootPatch,
              currentReferences: fresh.content,
              nextReferences: next.content,
              association: { field: 'blockId', id: fresh.id },
              actorId,
            })
          : [];
        const operations: TransactOperation[] = [
          writablePageExpectation(page),
          ...(effectiveParentId ? [{
            table: 'blocks',
            op: 'expect' as const,
            id: effectiveParentId,
            where: [['pageId', '==', fresh.pageId] as [string, '==', unknown]],
            exists: true,
          }] : []),
          {
            table: 'blocks',
            op: 'expect',
            id: fresh.id,
            where: [
              ['pageId', '==', fresh.pageId],
              ['parentId', '==', fresh.parentId ?? null],
              ['updatedAt', '==', fresh.updatedAt ?? null],
            ],
            exists: true,
          },
          ...transitions,
          { table: 'blocks', op: 'update', id: fresh.id, data: rootPatch as Record<string, unknown> },
          pageEditOperation(page, actorId, nowIso()),
        ];
        if (operations.length > MAX_RAW_TRANSACT_OPS) {
          throw Object.assign(new Error('Block contains too many stored files.'), { status: 413 });
        }
        await lease.renew();
        await db.transact(operations);
        notificationPage = page;
        return next;
      },
    );
  } else {
    updated = storedFilesChanged
      ? await withFileWorkspaceLease(
          db,
          currentPage.workspaceId,
          actorId,
          'block-file-reference-update',
          async (lease) => {
            await lease.assertOwned();
            const fresh = await getExisting(blocks, id);
            if (!fresh) throw new Error('Block was not found.');
            if (fresh.updatedAt !== current.updatedAt) {
              throw new Error('Block changed since it was loaded.');
            }
            const page = await getWritablePage(db, fresh.pageId, actorId, actorEmail);
            await assertFileTargetsNotDeleting(db, page.workspaceId, [page.id]);
            const next = { ...fresh, ...rootPatch } as Block;
            const transitions = await fileReferenceTransitionOperations(db, {
              table: 'blocks',
              current: fresh,
              data: rootPatch,
              currentReferences: fresh.content,
              nextReferences: next.content,
              association: { field: 'blockId', id: fresh.id },
              actorId,
            });
            const operations: TransactOperation[] = [
              writablePageExpectation(page),
              {
                table: 'blocks',
                op: 'expect',
                id: fresh.id,
                where: [
                  ['pageId', '==', fresh.pageId],
                  ['parentId', '==', fresh.parentId ?? null],
                  ['updatedAt', '==', fresh.updatedAt ?? null],
                ],
                exists: true,
              },
              ...transitions,
              { table: 'blocks', op: 'update', id: fresh.id, data: rootPatch as Record<string, unknown> },
              pageEditOperation(page, actorId, nowIso()),
            ];
            if (operations.length > MAX_RAW_TRANSACT_OPS) {
              throw Object.assign(new Error('Block contains too many stored files.'), { status: 413 });
            }
            await lease.renew();
            await db.transact(operations);
            return next;
          },
        )
      : await (async () => {
          try {
            const blockUpdateOperation: TransactOperation = {
              table: 'blocks',
              op: 'update',
              id: current.id,
              data: rootPatch as Record<string, unknown>,
            };
            const operations: TransactOperation[] = [
              writablePageExpectation(currentPage),
              {
                table: 'blocks',
                op: 'expect',
                id: current.id,
                where: [
                  ['pageId', '==', current.pageId],
                  ['parentId', '==', current.parentId ?? null],
                  ['updatedAt', '==', current.updatedAt ?? null],
                ],
                exists: true,
              },
              blockUpdateOperation,
              ...(deferPageRecency ? [] : [pageEditOperation(currentPage, actorId, nowIso())]),
            ];
            const transaction = await db.transact(operations);
            return committedUpdatedBlock(transaction, operations, blockUpdateOperation, current.id);
          } catch (error) {
            // Pre-authority checkpoints could leave a reserved server receipt
            // on a row. Keep that narrow subsumption recovery for such rows,
            // while current checkpoints remain document-only and never enter
            // this race. Page-state and infrastructure failures stay visible.
            if (isTransactionExpectationFailure(error)) {
              const fresh = await getExisting(blocks, current.id);
              if (
                fresh &&
                fresh.pageId === current.pageId &&
                fresh.parentId === current.parentId &&
                fresh.updatedAt !== current.updatedAt &&
                typeof fresh.lastMutationId === 'string' &&
                isServerBlockMutationReceipt(fresh.lastMutationId) &&
                blockTextPatchIsSubsumed(fresh, patch)
              ) {
                const freshPage = await getWritablePage(db, fresh.pageId, actorId, actorEmail);
                if (freshPage.workspaceId !== currentPage.workspaceId) throw error;
                return fresh;
              }
            }
            throw error;
          }
        })();
  }
  await emitBlockMentionNotifications(db, notificationPage, updated, actorId);
  return blockUpdateResult(updated, mutationId, deferPageRecency);
}

async function updateBlocksAtomically(
  db: DbRef,
  blocks: TableRef<Block>,
  bodies: Record<string, unknown>[],
  actorId: string,
  actorEmail?: string | null,
) {
  if (bodies.length === 0) return [];
  if (bodies.length === 1) return [await updateBlock(db, blocks, bodies[0], actorId, actorEmail)];
  if (bodies.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Too many blocks for one atomic update.'),
      { status: 413 },
    );
  }

  const seen = new Set<string>();
  const orderedIds: string[] = [];
  const resultById = new Map<string, BlockUpdateResult>();
  const writablePages = new Map<string, Promise<Page>>();
  const prepared: Array<{
    current: Block;
    block: Block;
    mutationId?: string;
    page: Page;
    patch: BlockPatch;
  }> = [];
  for (const body of bodies) {
    const id = requireString(body.id, 'id');
    if (seen.has(id)) throw new Error(`Block ${id} appears more than once in updateMany.`);
    seen.add(id);
    orderedIds.push(id);
    const current = await getExisting(blocks, id);
    if (!current) throw new Error('Block was not found.');
    const mutationId = optionalMutationId(body.mutationId, 'mutationId');
    const expectedMutationId = optionalMutationId(body.expectedMutationId, 'expectedMutationId');
    const expectedUpdatedAt = optionalExpectedUpdatedAt(body.expectedUpdatedAt);
    const patch = cleanPatch(
      body.patch && typeof body.patch === 'object' ? body.patch as Record<string, unknown> : {},
    );
    const expectedBaseMatches = blockBaseExpectationsMatch(
      current,
      expectedUpdatedAt,
      expectedMutationId,
      actorId,
    );
    const exactMutationReplay = !!mutationId
      && current.lastMutationId === mutationId
      && current.lastEditedBy === actorId;
    if (
      (expectedUpdatedAt || expectedMutationId) &&
      !expectedBaseMatches &&
      !exactMutationReplay &&
      !blockPatchAlreadyApplied(current, patch)
    ) {
      throw new Error('Block changed since it was loaded.');
    }
    const page = await writablePageForBatch(
      writablePages,
      db,
      current.pageId,
      actorId,
      actorEmail,
    );
    if (exactMutationReplay) {
      resultById.set(
        id,
        blockUpdateResult(current, mutationId, !blockPatchChangesStructure(patch)),
      );
      continue;
    }
    if ('pageId' in patch || 'parentId' in patch) {
      throw new Error('updateMany cannot combine structural block moves; send them as individual updates.');
    }
    patch.updatedAt = patch.updatedAt ?? nowIso();
    patch.lastEditedBy = actorId;
    if (mutationId) patch.lastMutationId = mutationId;
    prepared.push({
      current,
      block: { ...current, ...patch },
      mutationId,
      page,
      patch,
    });
  }

  if (prepared.length === 0) {
    return orderedIds.map((id) => resultById.get(id)!);
  }

  const hasStoredFileChanges = prepared.some(({ current, block }) =>
    storedFileReferencesChanged(current.content, block.content),
  );
  const preparedPages = new Map(prepared.map(({ page }) => [page.id, page]));
  const synchronousPageIds = new Set(
    hasStoredFileChanges
      ? preparedPages.keys()
      : prepared
          .filter(({ mutationId, patch }) => !mutationId || blockPatchChangesStructure(patch))
          .map(({ page }) => page.id),
  );
  const baseOperationCount = preparedPages.size
    + synchronousPageIds.size
    + (prepared.length * 2);
  if (baseOperationCount > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Too many blocks for one atomic update.'),
      { status: 413 },
    );
  }
  let committed = prepared;
  if (hasStoredFileChanges) {
    const workspaceIds = new Set(prepared.map(({ page }) => page.workspaceId));
    if (workspaceIds.size !== 1) {
      throw new Error('updateMany blocks must belong to one workspace.');
    }
    committed = await withFileWorkspaceLease(
      db,
      prepared[0]!.page.workspaceId,
      actorId,
      'block-file-reference-update-many',
      async (lease) => {
        await lease.assertOwned();
        const operations: TransactOperation[] = [];
        const freshPrepared: typeof prepared = [];
        const freshPages = new Map<string, Page>();
        const freshWritablePages = new Map<string, Promise<Page>>();
        const checkedFileTargetPages = new Set<string>();
        for (const item of prepared) {
          const fresh = await getExisting(blocks, item.current.id);
          if (!fresh) throw new Error('Block was not found.');
          if (fresh.updatedAt !== item.current.updatedAt) {
            throw new Error('Block changed since it was loaded.');
          }
          const page = await writablePageForBatch(
            freshWritablePages,
            db,
            fresh.pageId,
            actorId,
            actorEmail,
          );
          if (page.workspaceId !== prepared[0]!.page.workspaceId) {
            throw Object.assign(new Error('updateMany blocks must belong to one workspace.'), { status: 409 });
          }
          if (!checkedFileTargetPages.has(page.id)) {
            await assertFileTargetsNotDeleting(db, page.workspaceId, [page.id]);
            checkedFileTargetPages.add(page.id);
          }
          freshPages.set(page.id, page);
          const next = { ...fresh, ...item.patch } as Block;
          const transitions = await fileReferenceTransitionOperations(db, {
            table: 'blocks',
            current: fresh,
            data: item.patch,
            currentReferences: fresh.content,
            nextReferences: next.content,
            association: { field: 'blockId', id: fresh.id },
            actorId,
          });
          operations.push(
            blockSnapshotExpectation(fresh),
            ...transitions,
            {
              table: 'blocks',
              op: 'update',
              id: fresh.id,
              data: item.patch as Record<string, unknown>,
            },
          );
          freshPrepared.push({
            current: fresh,
            block: next,
            mutationId: item.mutationId,
            page,
            patch: item.patch,
          });
        }
        operations.unshift(...Array.from(freshPages.values(), writablePageExpectation));
        const pageEditedAt = nowIso();
        operations.push(
          ...Array.from(freshPages.values(), (page) => pageEditOperation(page, actorId, pageEditedAt)),
        );
        if (operations.length > MAX_RAW_TRANSACT_OPS) {
          throw Object.assign(
            new Error('Too many blocks or stored files changed in one atomic update.'),
            { status: 413 },
          );
        }
        await lease.renew();
        await db.transact(operations);
        return freshPrepared;
      },
    );
  } else {
    const pageEditedAt = nowIso();
    const operations: TransactOperation[] = Array.from(
      preparedPages.values(),
      writablePageExpectation,
    );
    const updateOperations = new Map<string, TransactOperation>();
    for (const { current, patch } of prepared) {
      const updateOperation: TransactOperation = {
        table: 'blocks',
        op: 'update',
        id: current.id,
        data: patch as Record<string, unknown>,
      };
      updateOperations.set(current.id, updateOperation);
      operations.push(blockSnapshotExpectation(current), updateOperation);
    }
    operations.push(
      ...Array.from(preparedPages.values())
        .filter((page) => synchronousPageIds.has(page.id))
        .map((page) => pageEditOperation(page, actorId, pageEditedAt)),
    );
    const transaction = await db.transact(operations);
    committed = prepared.map((item) => ({
      ...item,
      block: committedUpdatedBlock(
        transaction,
        operations,
        updateOperations.get(item.current.id)!,
        item.current.id,
      ),
    }));
  }
  for (const { block, mutationId, page } of committed) {
    resultById.set(
      block.id,
      blockUpdateResult(block, mutationId, !synchronousPageIds.has(page.id)),
    );
    await emitBlockMentionNotifications(db, page, block, actorId);
  }
  return orderedIds.map((id) => {
    const result = resultById.get(id)!;
    if (result.pageRecency && synchronousPageIds.has(result.pageRecency.pageId)) {
      return { block: result.block };
    }
    return result;
  });
}

async function touchBlockPageRecency(
  db: DbRef,
  blocks: TableRef<Block>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const pageId = requireString(body.pageId, 'pageId');
  const blockId = requireString(body.blockId, 'blockId');
  const mutationId = optionalMutationId(body.mutationId, 'mutationId');
  if (!mutationId) throw new Error('mutationId is required.');
  // The committed timestamp travels in the durable browser generation so
  // same-page proofs can be compared without a read. It is deliberately NOT
  // trusted here: only the canonical stored block row is write authority.
  optionalExpectedUpdatedAt(body.blockUpdatedAt);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [page, block] = await Promise.all([
      getExisting(db.table<Page>('pages'), pageId),
      getExisting(blocks, blockId),
    ]);
    if (!page || page.inTrash || page.deletionPendingAt) return { status: 'superseded' as const };
    if (page.isLocked) throw new Error('Page is locked.');
    // A receipt proves who committed the block, not that their access still
    // exists five seconds later. Recheck current edit authority before every
    // CAS attempt so delayed work cannot outlive a revocation.
    await assertCanEditPage(db, page, actorId, actorEmail);
    if (
      !block
      || block.pageId !== pageId
      || block.lastEditedBy !== actorId
      || block.lastMutationId !== mutationId
      || typeof block.updatedAt !== 'string'
      || !block.updatedAt
    ) {
      // A later block generation, structural move, or deletion owns the newer
      // page meaning. The stale proof must not overwrite it.
      return { status: 'superseded' as const };
    }
    if (typeof page.updatedAt === 'string' && page.updatedAt >= block.updatedAt) {
      return { status: 'current' as const };
    }
    try {
      await db.transact([
        pageRecencyExpectation(page),
        pageEditOperation(page, block.lastEditedBy, block.updatedAt),
      ]);
      return { status: 'committed' as const };
    } catch (error) {
      if (isTransactionExpectationFailure(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error('Page recency could not settle after bounded retries.');
}

async function collectBlockDeletion(
  db: DbRef,
  blocks: TableRef<Block>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const id = requireString(body.id, 'id');
  let root: Block | null = null;
  try {
    root = await blocks.getOne(id);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return null;
  }
  if (!root) return null;
  const expectedUpdatedAt = optionalExpectedUpdatedAt(body.expectedUpdatedAt);
  if (expectedUpdatedAt && root.updatedAt !== expectedUpdatedAt) {
    throw new Error('Block changed since it was loaded.');
  }
  const page = await getWritablePage(db, root.pageId, actorId, actorEmail);

  const pageBlocks = await listAll(blocks.where('pageId', '==', root.pageId));
  const ids: string[] = [];
  const visit = (blockId: string) => {
    if (ids.includes(blockId)) return;
    ids.push(blockId);
    for (const block of pageBlocks) {
      if (block.parentId === blockId) visit(block.id);
    }
  };
  visit(id);
  return { ids, root, page };
}

const DELETE_MANY_PARENT_CHUNK_SIZE = 100;
const DELETE_MANY_GRAPH_LIMIT = 25_000;

async function collectBlockDeletionPlans(
  db: DbRef,
  blocks: TableRef<Block>,
  requestedIds: string[],
  actorId: string,
  actorEmail?: string | null,
) {
  const rootIds = Array.from(new Set(requestedIds));
  if (rootIds.length === 0) return [];
  const rootIdSet = new Set(rootIds);
  const roots = (await listAll(
    blocks.where('id', 'in', rootIds),
    {
      maxItems: rootIds.length,
      pageSize: rootIds.length,
      label: 'Block deleteMany roots',
    },
  )).filter((block) => rootIdSet.has(block.id));
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const rootsByPage = new Map<string, Block[]>();
  for (const id of rootIds) {
    const root = rootById.get(id);
    if (!root) continue;
    const pageRoots = rootsByPage.get(root.pageId) ?? [];
    pageRoots.push(root);
    rootsByPage.set(root.pageId, pageRoots);
  }

  const plans: Array<NonNullable<Awaited<ReturnType<typeof collectBlockDeletion>>>> = [];
  let remainingGraphBudget = DELETE_MANY_GRAPH_LIMIT - roots.length;
  for (const [pageId, pageRoots] of rootsByPage) {
    const page = await getWritablePage(db, pageId, actorId, actorEmail);
    const knownIds = new Set(pageRoots.map(({ id }) => id));
    const childrenByParent = new Map<string, Block[]>();
    let frontier = pageRoots.map(({ id }) => id);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (let index = 0; index < frontier.length; index += DELETE_MANY_PARENT_CHUNK_SIZE) {
        const parentIds = frontier.slice(index, index + DELETE_MANY_PARENT_CHUNK_SIZE);
        const children = await listAll(
          blocks.where('parentId', 'in', parentIds),
          {
            maxItems: Math.max(1, remainingGraphBudget),
            pageSize: Math.min(1_000, Math.max(1, remainingGraphBudget)),
            label: `Block deleteMany descendants for page ${pageId}`,
          },
        );
        for (const child of children.filter((candidate) => candidate.pageId === pageId)) {
          if (knownIds.has(child.id)) continue;
          if (remainingGraphBudget <= 0) {
            throw Object.assign(
              new Error(`Block deleteMany graph exceeds ${DELETE_MANY_GRAPH_LIMIT} blocks.`),
              { status: 413 },
            );
          }
          remainingGraphBudget -= 1;
          knownIds.add(child.id);
          next.push(child.id);
          const siblings = childrenByParent.get(child.parentId ?? '') ?? [];
          siblings.push(child);
          childrenByParent.set(child.parentId ?? '', siblings);
        }
      }
      frontier = next;
    }

    for (const root of pageRoots) {
      const ids: string[] = [];
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        ids.push(id);
        for (const child of childrenByParent.get(id) ?? []) visit(child.id);
      };
      visit(root.id);
      plans.push({ ids, root, page });
    }
  }
  return plans;
}

async function deleteBlockPlans(
  db: DbRef,
  plans: Array<NonNullable<Awaited<ReturnType<typeof collectBlockDeletion>>>>,
  actorId: string,
  renewLease: () => Promise<void>,
) {
  const deletedIds = new Set<string>();
  for (const plan of plans) {
    for (const id of plan.ids) deletedIds.add(id);
  }
  const deletionOrder: string[] = [];
  const ordered = new Set<string>();
  for (const plan of plans) {
    for (const id of [...plan.ids].reverse()) {
      if (ordered.has(id)) continue;
      ordered.add(id);
      deletionOrder.push(id);
    }
  }
  const groups: TransactOperation[][] = [];
  // Each block delete and its upload retirement transitions remain in the
  // same transaction group. Reverse preorder keeps descendants first and
  // every subtree root last, preserving retryability after a partial cascade.
  for (const id of deletionOrder) {
    const uploadOperations = await deletionOperationsForAssociation(db, 'blockId', id, actorId);
    groups.push([
      ...uploadOperations,
      // Descendants from the deletion snapshot have already been removed in
      // reverse-preorder. Fail the transaction if a new/reparented child raced
      // into this node through any non-cooperating write path; deleting the
      // parent in that state would create a durable orphan.
      {
        table: 'blocks',
        op: 'expect',
        where: [['parentId', '==', id]],
        exists: false,
      },
      { table: 'blocks', op: 'delete', id },
    ]);
  }
  await transactGroupsChunked(db, groups, renewLease);
  return Array.from(deletedIds);
}

const SNAPSHOT_MANY_CHANGE_LIMIT = 100;

function snapshotCreateReplayMatches(current: Block, candidate: Block) {
  return current.pageId === candidate.pageId
    && (current.parentId ?? null) === (candidate.parentId ?? null)
    && current.type === candidate.type
    && jsonValueEqual(current.content ?? null, candidate.content ?? null)
    && (current.plainText ?? null) === (candidate.plainText ?? null)
    && current.position === candidate.position
    && current.createdBy === candidate.createdBy;
}

async function applyBlockSnapshotMany(
  db: DbRef,
  blocks: TableRef<Block>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const pageId = requireString(body.pageId, 'pageId');
  const createBodies = Array.isArray(body.creates)
    ? body.creates as Record<string, unknown>[]
    : [];
  const updateBodies = Array.isArray(body.updates)
    ? body.updates as Record<string, unknown>[]
    : [];
  const deleteIds = Array.from(new Set(
    Array.isArray(body.deleteIds) ? body.deleteIds.map((id) => requireString(id, 'deleteIds[]')) : [],
  ));
  const changeCount = createBodies.length + updateBodies.length + deleteIds.length;
  if (changeCount === 0) {
    return { blocks: [], deletedIds: [] };
  }
  if (changeCount > SNAPSHOT_MANY_CHANGE_LIMIT) {
    throw Object.assign(
      new Error(`snapshotMany supports at most ${SNAPSHOT_MANY_CHANGE_LIMIT} changes.`),
      { status: 413 },
    );
  }

  const candidates = createBodies.map((candidate) => blockFromBody(candidate, actorId));
  const updates = updateBodies.map((update) => {
    const id = requireString(update.id, 'id');
    const patch = cleanPatch(
      update.patch && typeof update.patch === 'object'
        ? update.patch as Record<string, unknown>
        : {},
    );
    if (blockPatchChangesStructure(patch)) {
      throw new Error('snapshotMany updates cannot change block structure.');
    }
    return { id, patch };
  });
  const allIds = [
    ...candidates.map(({ id }) => id),
    ...updates.map(({ id }) => id),
    ...deleteIds,
  ];
  if (new Set(allIds).size !== allIds.length) {
    throw new Error('snapshotMany change ids must be unique across mutation classes.');
  }
  if (candidates.some((candidate) => candidate.pageId !== pageId || candidate.parentId)) {
    throw new Error('snapshotMany creates must be top-level blocks on the hinted page.');
  }
  if (candidates.some((candidate) => hasPotentialStoredFileReference(candidate.content))) {
    throw new Error('snapshotMany cannot create stored-file references.');
  }

  const initialPage = await getWritablePage(db, pageId, actorId, actorEmail);
  let committedBlocks: Block[] = [];
  const deletedIds = await withFileWorkspaceLease(
    db,
    initialPage.workspaceId,
    actorId,
    'block-compatible-snapshot-many',
    async (lease) => {
      await lease.assertOwned();
      const page = await getWritablePage(db, pageId, actorId, actorEmail);
      if (page.workspaceId !== initialPage.workspaceId) {
        throw Object.assign(new Error('Page changed workspaces while the snapshot was starting.'), { status: 409 });
      }
      await assertFileTargetsNotDeleting(db, page.workspaceId, [page.id]);

      const idSet = new Set(allIds);
      const currentRows = (await listAll(
        blocks.where('id', 'in', allIds),
        {
          maxItems: allIds.length,
          pageSize: allIds.length,
          label: 'Block snapshotMany current rows',
        },
      )).filter((block) => idSet.has(block.id));
      const currentById = new Map(currentRows.map((block) => [block.id, block]));
      const operations: TransactOperation[] = [writablePageExpectation(page)];
      const createOperations = new Map<string, TransactOperation>();
      const updateOperations = new Map<string, TransactOperation>();
      const resultById = new Map<string, Block>();

      for (const candidate of candidates) {
        const current = currentById.get(candidate.id);
        if (current) {
          if (!snapshotCreateReplayMatches(current, candidate)) {
            throw Object.assign(new Error(`Block ${candidate.id} already exists.`), { status: 409 });
          }
          resultById.set(candidate.id, current);
          continue;
        }
        const insertOperation: TransactOperation = {
          table: 'blocks',
          op: 'insert',
          data: candidate as unknown as Record<string, unknown>,
        };
        createOperations.set(candidate.id, insertOperation);
        operations.push(
          { table: 'blocks', op: 'expect', id: candidate.id, exists: false },
          insertOperation,
        );
      }

      for (const update of updates) {
        const current = currentById.get(update.id);
        if (!current || current.pageId !== pageId) throw new Error('Block was not found on the hinted page.');
        const next = { ...current, ...update.patch } as Block;
        if (storedFileReferencesChanged(current.content, next.content)) {
          throw new Error('snapshotMany cannot change stored-file references.');
        }
        if (blockPatchAlreadyApplied(current, update.patch)) {
          resultById.set(current.id, current);
          continue;
        }
        const patch: BlockPatch = {
          ...update.patch,
          updatedAt: update.patch.updatedAt ?? nowIso(),
          lastEditedBy: actorId,
        };
        const updateOperation: TransactOperation = {
          table: 'blocks',
          op: 'update',
          id: current.id,
          data: patch as Record<string, unknown>,
        };
        updateOperations.set(current.id, updateOperation);
        operations.push(blockSnapshotExpectation(current), updateOperation);
      }

      const presentDeleteIds: string[] = [];
      for (const id of deleteIds) {
        const current = currentById.get(id);
        if (!current) continue;
        if (current.pageId !== pageId || current.parentId) {
          throw new Error('snapshotMany deletes must be top-level blocks on the hinted page.');
        }
        if (hasPotentialStoredFileReference(current.content)) {
          throw new Error('snapshotMany cannot delete stored-file references.');
        }
        presentDeleteIds.push(id);
        operations.push(
          {
            table: 'blocks',
            op: 'expect',
            where: [['parentId', '==', id]],
            exists: false,
          },
          { table: 'blocks', op: 'delete', id },
        );
      }
      if (operations.length > MAX_RAW_TRANSACT_OPS) {
        throw Object.assign(new Error('snapshotMany exceeds the atomic transaction bound.'), { status: 413 });
      }

      await lease.renew();
      const transaction = await db.transact(operations);
      for (const candidate of candidates) {
        const insertOperation = createOperations.get(candidate.id);
        if (!insertOperation) continue;
        const inserted = transaction.results[operations.indexOf(insertOperation)]?.inserted;
        if (!inserted || typeof inserted !== 'object' || Array.isArray(inserted)) {
          throw new Error(`Block ${candidate.id} snapshot create did not return the committed row.`);
        }
        resultById.set(candidate.id, inserted as unknown as Block);
      }
      for (const update of updates) {
        const updateOperation = updateOperations.get(update.id);
        if (!updateOperation) continue;
        resultById.set(
          update.id,
          committedUpdatedBlock(transaction, operations, updateOperation, update.id),
        );
      }
      committedBlocks = [
        ...candidates.map(({ id }) => resultById.get(id)!),
        ...updates.map(({ id }) => resultById.get(id)!),
      ];
      return presentDeleteIds;
    },
  );

  for (const block of committedBlocks) {
    await emitBlockMentionNotifications(db, initialPage, block, actorId);
  }
  return { blocks: committedBlocks, deletedIds };
}

async function deleteBlock(
  db: DbRef,
  blocks: TableRef<Block>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const initial = await collectBlockDeletion(db, blocks, body, actorId, actorEmail);
  if (!initial) return { deletedIds: [] };
  const deletedIds = await withFileWorkspaceLease(
    db,
    initial.page.workspaceId,
    actorId,
    'block-subtree-delete',
    async (lease) => {
      await lease.assertOwned();
      const fresh = await collectBlockDeletion(db, blocks, body, actorId, actorEmail);
      if (!fresh) return [];
      if (fresh.page.workspaceId !== initial.page.workspaceId) {
        throw Object.assign(new Error('Block moved while deletion was starting.'), { status: 409 });
      }
      await assertFileTargetsNotDeleting(db, fresh.page.workspaceId, [fresh.page.id]);
      return deleteBlockPlans(db, [fresh], actorId, lease.renew);
    },
  );
  return { deletedIds };
}

export const POST = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    const db = await boundedDbFromPageHint(
      admin,
      body.pageId,
      (body.blocks as Array<{ pageId?: unknown }> | undefined)?.[0]?.pageId,
      (body.updates as Array<{ pageId?: unknown }> | undefined)?.[0]?.pageId,
    );
    if (['create', 'createMany', 'update', 'updateMany', 'snapshotMany'].includes(action)) {
      await assertOrganizationDlpContent(db, body);
    }
    const blocks = db.table<Block>('blocks');
    const actorEmail = auth.email ?? null;
    switch (action) {
      case 'create':
        return { block: await createBlock(db, blocks, blockCreateSchema.parse(body), auth.id, actorEmail) };
      case 'createMany': {
        const items = blockCreateManySchema.parse(body).blocks ?? [];
        return { blocks: await createBlocksAtomically(db, blocks, items, auth.id, actorEmail) };
      }
      case 'update': {
        const result = await updateBlock(db, blocks, blockUpdateSchema.parse(body), auth.id, actorEmail);
        return {
          block: result.block,
          ...(result.pageRecency ? { pageRecency: result.pageRecency } : {}),
        };
      }
      case 'updateMany': {
        const updates = blockUpdateManySchema.parse(body).updates ?? [];
        const results = await updateBlocksAtomically(db, blocks, updates, auth.id, actorEmail);
        return {
          blocks: results.map(({ block }) => block),
          pageRecencies: latestPageRecencyProofs(results),
        };
      }
      case 'snapshotMany':
        return await applyBlockSnapshotMany(
          db,
          blocks,
          blockSnapshotManySchema.parse(body),
          auth.id,
          actorEmail,
        );
      case 'touchPageRecency':
        return await touchBlockPageRecency(
          db,
          blocks,
          blockPageRecencySchema.parse(body),
          auth.id,
          actorEmail,
        );
      case 'delete':
        return await deleteBlock(db, blocks, blockDeleteSchema.parse(body), auth.id, actorEmail);
      case 'deleteMany': {
        const ids = blockDeleteManySchema.parse(body).ids ?? [];
        const initialPlans = await collectBlockDeletionPlans(
          db,
          blocks,
          ids,
          auth.id,
          actorEmail,
        );
        if (initialPlans.length === 0) return { deletedIds: [] };
        const workspaceId = initialPlans[0]!.page.workspaceId;
        if (initialPlans.some((plan) => plan.page.workspaceId !== workspaceId)) {
          throw new Error('deleteMany blocks must belong to one workspace.');
        }
        const deletedIds = await withFileWorkspaceLease(
          db,
          workspaceId,
          auth.id,
          'block-subtree-delete-many',
          async (lease) => {
            await lease.assertOwned();
            const freshPlans = await collectBlockDeletionPlans(
              db,
              blocks,
              ids,
              auth.id,
              actorEmail,
            );
            if (freshPlans.some((plan) => plan.page.workspaceId !== workspaceId)) {
              throw Object.assign(new Error('Block moved while deletion was starting.'), { status: 409 });
            }
            for (const pageId of new Set(freshPlans.map((plan) => plan.page.id))) {
              await assertFileTargetsNotDeleting(db, workspaceId, [pageId]);
            }
            return deleteBlockPlans(db, freshPlans, auth.id, lease.renew);
          },
        );
        return { deletedIds };
      }
      default:
        return jsonError(400, 'Unknown block mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['access required'] },
      { status: 423, needles: ['locked'] },
      { status: 409, needles: ['changed since', 'Transaction expectation failed'] },
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
  },
});
