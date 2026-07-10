import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { MAX_RAW_TRANSACT_OPS, boundedDbFromPageHint } from '../lib/workspace-db';
import { upsertNotification } from '../lib/notifications';
import {
  pageAccessRole as sharedPageAccessRole,
  pageHasDirectAccess as sharedPageHasDirectAccess,
} from '../lib/page-access';

import {
  bestEffort,
  isNotFoundError,
  listAll,
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
  FunctionContext,
  Page,
  TableRef,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

type BlockPatch = Partial<Block>;

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
  expectedUpdatedAt: v.nullish(v.shortText()),
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

const blockDeleteManySchema = v.object({
  ids: v.optional(v.array(v.id())),
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
  await assertCanEditPage(db, page, actorId, actorEmail);
  return page;
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
  const members = await listAll(
    db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', page.workspaceId),
  );
  if (members.some((member) => member.userId === userId)) return true;
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

// Chunked content transact: the boundedDb facade appends one change_log insert
// per block op, so raw batches must stay under MAX_RAW_TRANSACT_OPS to fit the
// 500-op server cap (workspace-db.ts). Callers order ops so a partial failure
// stays retryable (descendants first, root last).
async function transactChunked(db: DbRef, operations: TransactOperation[]) {
  for (let i = 0; i < operations.length; i += MAX_RAW_TRANSACT_OPS) {
    await db.transact(operations.slice(i, i + MAX_RAW_TRANSACT_OPS));
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
  const page = await getWritablePage(db, block.pageId, actorId, actorEmail);
  await assertParentBlockOnPage(blocks, block.parentId, block.pageId);
  const inserted = await blocks.insert(block);
  await emitBlockMentionNotifications(db, page, inserted, actorId);
  return inserted;
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
  const candidateIds = new Set<string>();
  for (const block of candidates) {
    if (candidateIds.has(block.id)) throw new Error(`Block ${block.id} appears more than once in createMany.`);
    candidateIds.add(block.id);
  }

  const pages = new Map<string, Page>();
  const knownBlocks = new Map<string, Block>();
  for (const pageId of new Set(candidates.map((block) => block.pageId))) {
    pages.set(pageId, await getWritablePage(db, pageId, actorId, actorEmail));
    const existing = await listAll(blocks.where('pageId', '==', pageId));
    for (const block of existing) knownBlocks.set(block.id, block);
  }
  for (const block of candidates) {
    if (knownBlocks.has(block.id)) throw Object.assign(new Error(`Block ${block.id} already exists.`), { status: 409 });
    knownBlocks.set(block.id, block);
  }
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

  await transactChunked(db, candidates.map((block): TransactOperation => ({
    table: 'blocks',
    op: 'insert',
    data: block as unknown as Record<string, unknown>,
  })));
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
  const expectedUpdatedAt = optionalExpectedUpdatedAt(body.expectedUpdatedAt);
  if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
    throw new Error('Block changed since it was loaded.');
  }
  const currentPage = await getWritablePage(db, current.pageId, actorId, actorEmail);

  const patch = cleanPatch(
    body.patch && typeof body.patch === 'object' ? (body.patch as Record<string, unknown>) : {},
  );
  const targetPageId = patch.pageId && patch.pageId !== current.pageId ? patch.pageId : current.pageId;
  const targetPage = targetPageId !== current.pageId
    ? await getWritablePage(db, targetPageId, actorId, actorEmail)
    : currentPage;
  if ('parentId' in patch) patch.parentId = patch.parentId ?? null;
  // `'parentId' in patch` distinguishes an explicit null (move to top level)
  // from an absent field (keep the current parent); `??` would conflate them
  // and assert the OLD parent against the NEW page.
  const effectiveParentId = 'parentId' in patch ? patch.parentId : current.parentId;
  await assertParentBlockOnPage(blocks, effectiveParentId, targetPageId, id);

  // A cross-page move must carry the block's whole descendant subtree; moving
  // the block alone would leave its children on the source page pointing at a
  // parent that no longer lives there (orphaned). Re-stamp every descendant's
  // pageId to the target page in the same operation.
  const descendantIds: string[] = [];
  if (targetPageId !== current.pageId) {
    // Parent links are traversed across BOTH pages so a retry after a partial
    // chunked move still discovers descendants that already crossed over.
    const candidateBlocks = [
      ...(await listAll(blocks.where('pageId', '==', current.pageId))),
      ...(await listAll(blocks.where('pageId', '==', targetPageId))),
    ];
    const collect = (blockId: string) => {
      for (const block of candidateBlocks) {
        if (block.parentId === blockId && !descendantIds.includes(block.id)) {
          descendantIds.push(block.id);
          collect(block.id);
        }
      }
    };
    collect(id);
  }

  const rootPatch = { ...patch, updatedAt: patch.updatedAt ?? nowIso() };
  let updated: Block;
  if (descendantIds.length === 0) {
    updated = await blocks.update(id, rootPatch);
  } else {
    // Root + subtree re-stamps commit in one transact so a crash cannot orphan
    // descendants on the source page. Oversized subtrees are chunked with the
    // root in the LAST chunk: a partial failure leaves the root on the source
    // page, so retrying the same update re-enters this branch and re-stamps
    // the remaining descendants (re-stamping moved ones is idempotent).
    const moveStamp = nowIso();
    await transactChunked(db, [
      ...descendantIds.map((descendantId): TransactOperation => ({
        table: 'blocks',
        op: 'update',
        id: descendantId,
        data: { pageId: targetPageId, updatedAt: moveStamp },
      })),
      { table: 'blocks', op: 'update', id, data: rootPatch as Record<string, unknown> },
    ]);
    updated = { ...current, ...rootPatch } as Block;
  }
  await emitBlockMentionNotifications(db, targetPage, updated, actorId);
  return updated;
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

  const seen = new Set<string>();
  const prepared: Array<{ block: Block; page: Page; patch: BlockPatch }> = [];
  for (const body of bodies) {
    const id = requireString(body.id, 'id');
    if (seen.has(id)) throw new Error(`Block ${id} appears more than once in updateMany.`);
    seen.add(id);
    const current = await getExisting(blocks, id);
    if (!current) throw new Error('Block was not found.');
    const expectedUpdatedAt = optionalExpectedUpdatedAt(body.expectedUpdatedAt);
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      throw new Error('Block changed since it was loaded.');
    }
    const page = await getWritablePage(db, current.pageId, actorId, actorEmail);
    const patch = cleanPatch(
      body.patch && typeof body.patch === 'object' ? body.patch as Record<string, unknown> : {},
    );
    if ('pageId' in patch || 'parentId' in patch) {
      throw new Error('updateMany cannot combine structural block moves; send them as individual updates.');
    }
    patch.updatedAt = patch.updatedAt ?? nowIso();
    prepared.push({ block: { ...current, ...patch }, page, patch });
  }

  await transactChunked(db, prepared.map(({ block, patch }): TransactOperation => ({
    table: 'blocks',
    op: 'update',
    id: block.id,
    data: patch as Record<string, unknown>,
  })));
  for (const { block, page } of prepared) {
    await emitBlockMentionNotifications(db, page, block, actorId);
  }
  return prepared.map(({ block }) => block);
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
    return [];
  }
  if (!root) return [];
  const expectedUpdatedAt = optionalExpectedUpdatedAt(body.expectedUpdatedAt);
  if (expectedUpdatedAt && root.updatedAt !== expectedUpdatedAt) {
    throw new Error('Block changed since it was loaded.');
  }
  await getWritablePage(db, root.pageId, actorId, actorEmail);

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
  return ids;
}

async function deleteBlock(
  db: DbRef,
  blocks: TableRef<Block>,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const deletedIds = await collectBlockDeletion(db, blocks, body, actorId, actorEmail);
  if (deletedIds.length > 0) {
    // collectBlockDeletion returns the subtree in preorder (root first);
    // deleting in REVERSE puts descendants before ancestors and the root in
    // the last chunk, so a partial chunked failure keeps the subtree
    // reachable from the root and the delete retryable.
    await transactChunked(
      db,
      [...deletedIds].reverse().map((id): TransactOperation => ({ table: 'blocks', op: 'delete', id })),
    );
  }
  return { deletedIds };
}

export const POST = defineFunction(async (context) => {
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
    const blocks = db.table<Block>('blocks');
    const actorEmail = auth.email ?? null;
    switch (action) {
      case 'create':
        return { block: await createBlock(db, blocks, blockCreateSchema.parse(body), auth.id, actorEmail) };
      case 'createMany': {
        const items = blockCreateManySchema.parse(body).blocks ?? [];
        return { blocks: await createBlocksAtomically(db, blocks, items, auth.id, actorEmail) };
      }
      case 'update':
        return { block: await updateBlock(db, blocks, blockUpdateSchema.parse(body), auth.id, actorEmail) };
      case 'updateMany': {
        const updates = blockUpdateManySchema.parse(body).updates ?? [];
        return { blocks: await updateBlocksAtomically(db, blocks, updates, auth.id, actorEmail) };
      }
      case 'delete':
        return await deleteBlock(db, blocks, blockDeleteSchema.parse(body), auth.id, actorEmail);
      case 'deleteMany': {
        const ids = blockDeleteManySchema.parse(body).ids ?? [];
        const deletedIds = new Set<string>();
        for (const id of ids) {
          const collected = await collectBlockDeletion(db, blocks, { id }, auth.id, actorEmail);
          for (const deletedId of collected) deletedIds.add(deletedId);
        }
        if (deletedIds.size > 0) {
          // Reverse preorder: descendants before their roots (see deleteBlock).
          await transactChunked(db, Array.from(deletedIds).reverse().map((id): TransactOperation => ({
            table: 'blocks',
            op: 'delete',
            id,
          })));
        }
        return { deletedIds: Array.from(deletedIds) };
      }
      default:
        return jsonError(400, 'Unknown block mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['access required'] },
      { status: 423, needles: ['locked'] },
      { status: 409, needles: ['changed since'] },
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
});
