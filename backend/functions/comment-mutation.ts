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
  listAll,
  requireStringRaw as requireString,
  getExisting,
  nowIso,
  type TransactOperation,
} from '../lib/table-utils';
import type { ShareRole } from '../lib/page-access';
import type {
  Block,
  Comment,
  DbRef,
  FunctionContext,
  OrganizationGroupMember,
  Page,
  PagePermission,
  TableRef,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

const patchKeys = new Set<keyof Comment>([
  'pageId',
  'blockId',
  'parentId',
  'body',
  'resolved',
  'updatedAt',
  'editedAt',
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

function optionalString(value: unknown, name: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null.`);
  return value;
}

async function assertPageActive(pages: TableRef<Page>, pageId: string) {
  const page = await getExisting(pages, pageId);
  if (!page) throw new Error('Page was not found.');
  if (page.inTrash) throw new Error('Page is in trash.');
  return page;
}

function pageTitle(page: Page) {
  return page.title?.trim() || 'Untitled';
}

function commentTarget(pageId: string, commentId: string) {
  return `/p/${encodeURIComponent(pageId)}#comment-${encodeURIComponent(commentId)}`;
}

function richTextPreview(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const rich = (value as { rich?: unknown }).rich;
  if (!Array.isArray(rich)) return '';
  return rich
    .map((span) =>
      span && typeof span === 'object' && typeof (span as { text?: unknown }).text === 'string'
        ? (span as { text: string }).text
        : '',
    )
    .join('')
    .trim()
    .slice(0, 500);
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

function maxPreview(value: string) {
  return value.length > 500 ? value.slice(0, 500) : value;
}

async function pageNotificationRecipientSet(
  db: DbRef,
  page: Page,
  actorId: string,
  extras: Array<string | undefined | null> = [],
) {
  const recipients = new Set<string>();
  const workspace = await getExisting(db.table<Workspace>('workspaces'), page.workspaceId);
  if (workspace?.ownerId) recipients.add(workspace.ownerId);
  if (page.createdBy) recipients.add(page.createdBy);
  if (page.lastEditedBy) recipients.add(page.lastEditedBy);
  for (const extra of extras) {
    if (extra) recipients.add(extra);
  }

  const permissions = await listAll(
    db.table<PagePermission>('page_permissions').where('pageId', '==', page.id),
  );
  for (const permission of permissions) {
    if (permission.principalType === 'user' && permission.principalId) {
      recipients.add(permission.principalId);
    }
    if (permission.principalType === 'group' && permission.principalId) {
      const groupMembers = await listAll(
        db.table<OrganizationGroupMember>('organization_group_members').where(
          'groupId',
          '==',
          permission.principalId,
        ),
      );
      for (const member of groupMembers) recipients.add(member.userId);
    }
  }

  recipients.delete(actorId);
  return recipients;
}

async function canUserSeePage(db: DbRef, page: Page, userId: string) {
  // NB: no createdBy/lastEditedBy shortcut. A user removed from the workspace
  // must not be treated as able to see a page they once created — otherwise they
  // keep receiving comment notifications (with content previews) for pages they
  // can no longer open. Current access is decided by owner / active membership /
  // direct share below, matching lib/page-access's active-member gating.
  const workspace = await getExisting(db.table<Workspace>('workspaces'), page.workspaceId);
  if (workspace?.ownerId === userId) return true;
  const members = await listAll(
    db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', page.workspaceId),
  );
  if (members.some((member) => member.userId === userId)) return true;
  return sharedPageHasDirectAccess(db, page, userId);
}

async function emitCommentNotifications(
  db: DbRef,
  page: Page,
  comment: Comment,
  parent: Comment | null,
  actorId: string,
) {
  const mentionedIds = new Set(mentionedPersonIds(comment.body));
  const baseRecipients = await pageNotificationRecipientSet(db, page, actorId, [
    parent?.authorId,
  ]);
  const preview = maxPreview(richTextPreview(comment.body) || 'New comment');
  const occurredAt = comment.updatedAt ?? comment.createdAt ?? nowIso();

  for (const userId of mentionedIds) {
    if (userId === actorId || !(await canUserSeePage(db, page, userId))) continue;
    baseRecipients.delete(userId);
    await bestEffort('comment-mutation mention notification', upsertNotification(db, {
      workspaceId: page.workspaceId,
      userId,
      activityKey: `mention:comment:${comment.id}:${userId}:${Date.parse(occurredAt) || occurredAt}`,
      kind: 'mention',
      pageId: page.id,
      blockId: comment.blockId ?? null,
      commentId: comment.id,
      actorId,
      title: pageTitle(page),
      preview,
      target: commentTarget(page.id, comment.id),
      metadata: parent ? { source: 'reply', parentId: parent.id } : { source: 'comment' },
      occurredAt,
    }));
  }

  for (const userId of baseRecipients) {
    // Same visibility gate as the mention loop: page.createdBy/lastEditedBy and
    // group members may no longer be able to open the page; they must not keep
    // receiving comment previews for it.
    if (!(await canUserSeePage(db, page, userId))) continue;
    await bestEffort('comment-mutation comment notification', upsertNotification(db, {
      workspaceId: page.workspaceId,
      userId,
      activityKey: `comment:${comment.id}:${Date.parse(occurredAt) || occurredAt}`,
      kind: 'comment',
      pageId: page.id,
      blockId: comment.blockId ?? null,
      commentId: comment.id,
      actorId,
      title: pageTitle(page),
      preview,
      target: commentTarget(page.id, comment.id),
      metadata: parent ? { source: 'reply', parentId: parent.id } : { source: 'comment' },
      occurredAt,
    }));
  }
}

// Role resolution is canonical in lib/page-access.
async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail);
}

async function assertPageRole(
  db: DbRef,
  page: Page,
  actorId: string,
  minimum: ShareRole,
  actorEmail?: string | null,
) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks[minimum]) return role;
  throw new Error('Page access required.');
}

async function assertCanComment(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  return assertPageRole(db, page, actorId, 'comment', actorEmail);
}

async function assertCanEditComments(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  return assertPageRole(db, page, actorId, 'edit', actorEmail);
}

async function assertCanChangeComment(
  db: DbRef,
  page: Page,
  comment: Comment,
  actorId: string,
  actorEmail?: string | null,
) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return;
  if (comment.authorId === actorId && role && roleRanks[role] >= roleRanks.comment) return;
  throw new Error('Page access required.');
}

async function assertBlockOnPage(blocks: TableRef<Block>, blockId: string | null, pageId: string) {
  if (!blockId) return;
  const block = await getExisting(blocks, blockId);
  if (!block || block.pageId !== pageId) {
    throw new Error('Block was not found on the target page.');
  }
}

async function assertParentOnPage(
  comments: TableRef<Comment>,
  parentId: string | null,
  pageId: string,
  currentId?: string,
) {
  if (!parentId) return null;
  if (parentId === currentId) throw new Error('Comment cannot be its own parent.');
  const parent = await getExisting(comments, parentId);
  if (!parent || parent.pageId !== pageId) {
    throw new Error('Parent comment was not found on the target page.');
  }
  return parent;
}

function cleanPatch(patch: Record<string, unknown>): Partial<Comment> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (patchKeys.has(key as keyof Comment) && value !== undefined) out[key] = value;
  }
  delete out.id;
  delete out.authorId;
  delete out.createdAt;
  return out as Partial<Comment>;
}

async function createComment(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const comments = db.table<Comment>('comments');
  const pages = db.table<Page>('pages');
  const blocks = db.table<Block>('blocks');

  const id = requireString(body.id, 'id');
  const pageId = requireString(body.pageId, 'pageId');
  const page = await assertPageActive(pages, pageId);
  await assertCanComment(db, page, actorId, actorEmail);

  const parentId = optionalString(body.parentId, 'parentId');
  const parent = await assertParentOnPage(comments, parentId, pageId, id);
  const blockId = optionalString(body.blockId, 'blockId') ?? parent?.blockId ?? null;
  await assertBlockOnPage(blocks, blockId, pageId);

  const now = nowIso();
  const comment: Comment = {
    id,
    pageId,
    blockId,
    parentId,
    authorId: actorId,
    body: body.body,
    resolved: body.resolved === true,
    createdAt: now,
    updatedAt: now,
  };

  const inserted = await comments.insert(comment);
  await emitCommentNotifications(db, page, inserted, parent, actorId);
  return inserted;
}

async function updateComment(
  db: DbRef,
  id: string,
  patchBody: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const comments = db.table<Comment>('comments');
  const pages = db.table<Page>('pages');
  const blocks = db.table<Block>('blocks');

  const current = await getExisting(comments, id);
  if (!current) throw new Error('Comment was not found.');
  const currentPage = await assertPageActive(pages, current.pageId);

  const patch = cleanPatch(patchBody);
  const pageId =
    typeof patch.pageId === 'string' && patch.pageId.trim().length > 0
      ? patch.pageId
      : current.pageId;
  const page = pageId === current.pageId ? currentPage : await assertPageActive(pages, pageId);
  if (pageId !== current.pageId) {
    await assertCanEditComments(db, currentPage, actorId, actorEmail);
    await assertCanEditComments(db, page, actorId, actorEmail);
  } else {
    await assertCanChangeComment(db, page, current, actorId, actorEmail);
  }

  if ('blockId' in patch) {
    patch.blockId = optionalString(patch.blockId, 'blockId');
    await assertBlockOnPage(blocks, patch.blockId ?? null, pageId);
  } else if (pageId !== current.pageId) {
    // A cross-page move must not keep an anchor pointing into the OLD page:
    // the kept blockId is validated against the target page like create does
    // (callers clear it explicitly with blockId:null to detach).
    await assertBlockOnPage(blocks, current.blockId ?? null, pageId);
  }

  if ('parentId' in patch) {
    patch.parentId = optionalString(patch.parentId, 'parentId');
    await assertParentOnPage(comments, patch.parentId ?? null, pageId, id);
  } else if (pageId !== current.pageId) {
    // Same for the thread anchor: a kept parent must live on the target page.
    await assertParentOnPage(comments, current.parentId ?? null, pageId, id);
  }

  return comments.update(id, {
    ...patch,
    updatedAt: patch.updatedAt ?? nowIso(),
  });
}

async function deleteComment(
  db: DbRef,
  id: string,
  hintedPageId: unknown,
  actorId: string,
  actorEmail?: string | null,
) {
  const comments = db.table<Comment>('comments');
  const pages = db.table<Page>('pages');
  const current = await getExisting(comments, id);
  if (!current) {
    // Idempotent delete-of-unknown-id is only reported as success to callers
    // who could comment on the routed page — otherwise any authenticated user
    // could probe arbitrary ids for a success response.
    const page = await assertPageActive(pages, requireString(hintedPageId, 'pageId'));
    await assertCanComment(db, page, actorId, actorEmail);
    return { deletedId: id };
  }
  const page = await assertPageActive(pages, current.pageId);
  await assertCanChangeComment(db, page, current, actorId, actorEmail);
  // Deleting a comment deletes its thread: replies (recursively) go in the
  // SAME transact so a crash cannot leave replies pointing at a missing
  // parent. This is the primary mutation, not optional cleanup — a failure
  // must reach the caller so the UI cannot report success while rows remain.
  const pageComments = await listAll(comments.where('pageId', '==', current.pageId));
  const deletedIds: string[] = [];
  const collectReplies = (parentId: string) => {
    for (const reply of pageComments) {
      if (reply.parentId === parentId && !deletedIds.includes(reply.id)) {
        deletedIds.push(reply.id);
        collectReplies(reply.id);
      }
    }
  };
  collectReplies(id);
  deletedIds.push(id);
  const operations = deletedIds.map(
    (deletedId): TransactOperation => ({ table: 'comments', op: 'delete', id: deletedId }),
  );
  // Oversized threads chunk under the server transact cap; replies precede
  // the root, so a partial failure leaves the thread reachable and retryable.
  for (let i = 0; i < operations.length; i += MAX_RAW_TRANSACT_OPS) {
    await db.transact(operations.slice(i, i + MAX_RAW_TRANSACT_OPS));
  }
  return { deletedId: id };
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const actorEmail = auth.email ?? null;

  try {
    // Inside the try so routing misses map to 400/404 via the catch below.
    const db = await boundedDbFromPageHint(admin, body.pageId);
    switch (action) {
      case 'create':
        return { comment: await createComment(db, body, auth.id, actorEmail) };
      case 'update':
        return {
          comment: await updateComment(
            db,
            requireString(body.id, 'id'),
            body.patch && typeof body.patch === 'object'
              ? (body.patch as Record<string, unknown>)
              : {},
            auth.id,
            actorEmail,
          ),
        };
      case 'updateMany': {
        const updates = Array.isArray(body.updates) ? body.updates : [];
        const updated: Comment[] = [];
        for (const item of updates) {
          const update = item as { id?: unknown; patch?: unknown };
          updated.push(
            await updateComment(
              db,
              requireString(update.id, 'id'),
              update.patch && typeof update.patch === 'object'
                ? (update.patch as Record<string, unknown>)
                : {},
              auth.id,
              actorEmail,
            ),
          );
        }
        return { comments: updated };
      }
      case 'delete':
        return await deleteComment(db, requireString(body.id, 'id'), body.pageId, auth.id, actorEmail);
      case 'deleteMany': {
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
        const deletedIds: string[] = [];
        for (const id of ids) {
          const result = await deleteComment(db, id, body.pageId, auth.id, actorEmail);
          deletedIds.push(result.deletedId);
        }
        return { deletedIds };
      }
      default:
        return jsonError(400, 'Unknown comment mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error);
    return jsonError(status, message);
  }
});
