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
  FileUpload,
  FunctionContext,
  Page,
  TableRef,
  Workspace,
  WorkspaceMember,
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
  if (page.deletionPendingAt) {
    throw Object.assign(new Error('Page deletion is already in progress.'), { status: 409 });
  }
  await assertCanEditPage(db, page, actorId, actorEmail);
  return page;
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
        { table: 'blocks', op: 'insert', data: block as unknown as Record<string, unknown> },
      ];
      if (operations.length > MAX_RAW_TRANSACT_OPS) {
        throw Object.assign(new Error('Block contains too many stored files.'), { status: 413 });
      }
      await lease.renew();
      await db.transact(operations);
      committedPage = page;
      return block;
    },
  );
  await emitBlockMentionNotifications(db, committedPage, inserted, actorId);
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
      const knownBlocks = new Map<string, Block>();
      for (const pageId of new Set(candidates.map((block) => block.pageId))) {
        const page = await getWritablePage(db, pageId, actorId, actorEmail);
        if (page.workspaceId !== workspaceId) {
          throw Object.assign(new Error('Page changed workspaces while blocks were being created.'), { status: 409 });
        }
        await assertFileTargetsNotDeleting(db, workspaceId, [pageId]);
        freshPages.set(pageId, page);
        const existing = await listAll(blocks.where('pageId', '==', pageId));
        for (const existingBlock of existing) knownBlocks.set(existingBlock.id, existingBlock);
      }
      for (const block of candidates) {
        if (knownBlocks.has(block.id)) {
          throw Object.assign(new Error(`Block ${block.id} already exists.`), { status: 409 });
        }
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
  if (targetPage.workspaceId !== currentPage.workspaceId) {
    throw Object.assign(new Error('Blocks cannot move across workspaces.'), { status: 409 });
  }
  if ('parentId' in patch) patch.parentId = patch.parentId ?? null;
  // `'parentId' in patch` distinguishes an explicit null (move to top level)
  // from an absent field (keep the current parent); `??` would conflate them
  // and assert the OLD parent against the NEW page.
  const effectiveParentId = 'parentId' in patch ? patch.parentId : current.parentId;
  await assertParentBlockOnPage(blocks, effectiveParentId, targetPageId, id);

  const rootPatch = { ...patch, updatedAt: patch.updatedAt ?? nowIso() };
  const storedFilesChanged = storedFileReferencesChanged(
    current.content,
    { ...current, ...rootPatch }.content,
  );
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
        const operations = groups.flat();
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
          await db.transact([
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
            { table: 'blocks', op: 'update', id: current.id, data: rootPatch as Record<string, unknown> },
          ]);
          return { ...current, ...rootPatch } as Block;
        })();
  }
  await emitBlockMentionNotifications(db, notificationPage, updated, actorId);
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
  if (bodies.length > MAX_RAW_TRANSACT_OPS) {
    throw Object.assign(
      new Error('Too many blocks for one atomic update.'),
      { status: 413 },
    );
  }

  const seen = new Set<string>();
  const prepared: Array<{ current: Block; block: Block; page: Page; patch: BlockPatch }> = [];
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
    prepared.push({ current, block: { ...current, ...patch }, page, patch });
  }

  const hasStoredFileChanges = prepared.some(({ current, block }) =>
    storedFileReferencesChanged(current.content, block.content),
  );
  const preparedPages = new Map(prepared.map(({ page }) => [page.id, page]));
  const baseOperationCount = preparedPages.size + (prepared.length * 2);
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
        for (const item of prepared) {
          const fresh = await getExisting(blocks, item.current.id);
          if (!fresh) throw new Error('Block was not found.');
          if (fresh.updatedAt !== item.current.updatedAt) {
            throw new Error('Block changed since it was loaded.');
          }
          const page = await getWritablePage(db, fresh.pageId, actorId, actorEmail);
          if (page.workspaceId !== prepared[0]!.page.workspaceId) {
            throw Object.assign(new Error('updateMany blocks must belong to one workspace.'), { status: 409 });
          }
          await assertFileTargetsNotDeleting(db, page.workspaceId, [page.id]);
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
          freshPrepared.push({ current: fresh, block: next, page, patch: item.patch });
        }
        operations.unshift(...Array.from(freshPages.values(), writablePageExpectation));
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
    const operations: TransactOperation[] = [
      ...Array.from(preparedPages.values(), writablePageExpectation),
      ...prepared.flatMap(({ current, patch }): TransactOperation[] => [
        blockSnapshotExpectation(current),
        {
          table: 'blocks',
          op: 'update',
          id: current.id,
          data: patch as Record<string, unknown>,
        },
      ]),
    ];
    await db.transact(operations);
  }
  for (const { block, page } of committed) {
    await emitBlockMentionNotifications(db, page, block, actorId);
  }
  return committed.map(({ block }) => block);
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
        const initialPlans: Array<NonNullable<Awaited<ReturnType<typeof collectBlockDeletion>>>> = [];
        for (const id of ids) {
          const plan = await collectBlockDeletion(db, blocks, { id }, auth.id, actorEmail);
          if (plan) initialPlans.push(plan);
        }
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
            const freshPlans: typeof initialPlans = [];
            for (const id of ids) {
              const plan = await collectBlockDeletion(db, blocks, { id }, auth.id, actorEmail);
              if (!plan) continue;
              if (plan.page.workspaceId !== workspaceId) {
                throw Object.assign(new Error('Block moved while deletion was starting.'), { status: 409 });
              }
              await assertFileTargetsNotDeleting(db, workspaceId, [plan.page.id]);
              freshPlans.push(plan);
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
