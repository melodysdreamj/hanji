import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/comment-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const GUEST = 'guest-1';
const STRANGER = 'stranger-1';

function pageRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Page ${id}`,
    position: 0,
    inTrash: false,
    createdBy: OWNER,
    ...extra,
  };
}

function commentRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    pageId: 'p1',
    blockId: null,
    parentId: null,
    authorId: OWNER,
    body: { rich: [{ text: `Comment ${id}` }] },
    resolved: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    workspace_members: [
      { id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' },
      { id: 'm2', workspaceId: 'ws1', userId: GUEST, role: 'guest' },
    ],
    pages: [pageRow('p1')],
    ...tables,
  });
}

function createBody(extra: Record<string, unknown> = {}) {
  return {
    action: 'create',
    id: 'c-new',
    pageId: 'p1',
    body: { rich: [{ text: 'Hello there' }] },
    ...extra,
  };
}

describe('comment-mutation POST', () => {
  it('requires authentication', async () => {
    const res = await callFunction(POST, db(), null, createBody());
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  it('maps a missing pageId routing hint to a 400 response', async () => {
    // Routing now runs inside the try/catch (mirroring collaboration-mutation),
    // so a missing pageId returns a mapped jsonError instead of a raw throw.
    const res = await callFunction(POST, db(), OWNER, { action: 'create', id: 'c-new' });
    await expectErrorResponse(res, 400, 'pageId is required. This action needs a pageId for workspace routing.');
  });

  it('rejects an unknown action', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'bogus', pageId: 'p1' });
    await expectErrorResponse(res, 400, 'Unknown comment mutation action.');
  });

  describe('create authorization', () => {
    it('lets the workspace owner comment', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, createBody())) as { comment: Row };
      expect(res.comment.id).toBe('c-new');
      expect(res.comment.authorId).toBe(OWNER);
      expect(res.comment.resolved).toBe(false);
      expect(database.tables.comments).toHaveLength(1);
    });

    it('lets a comment-role guest comment but not a plain stranger', async () => {
      // Workspace guests map to view, which is below comment.
      const denied = await callFunction(POST, db(), GUEST, createBody());
      await expectErrorResponse(denied, 403, 'Page access required.');

      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'comment',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, createBody())) as { comment: Row };
      expect(res.comment.authorId).toBe(STRANGER);

      const noGrant = await callFunction(POST, db(), STRANGER, createBody());
      await expectErrorResponse(noGrant, 403, 'Page access required.');
    });

    it('matches email-principal grants against the actor email', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'email',
            principalId: `${STRANGER}@example.com`,
            role: 'comment',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, createBody())) as { comment: Row };
      expect(res.comment.authorId).toBe(STRANGER);
    });

    it('honors a comment grant inherited from an ancestor page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('child', { parentId: 'p1', parentType: 'page' })],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'comment',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, createBody({ pageId: 'child' }))) as {
        comment: Row;
      };
      expect(res.comment.pageId).toBe('child');
    });

    it('rejects deactivated organization members', async () => {
      const database = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_members: [
          { id: 'om1', organizationId: 'org1', userId: MEMBER, status: 'deactivated' },
        ],
        workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' }],
        pages: [pageRow('p1')],
      });
      const res = await callFunction(POST, database, MEMBER, createBody());
      await expectErrorResponse(res, 403, 'Organization active access required.');
    });

    it('rejects pages in trash', async () => {
      const database = db({ pages: [pageRow('p1', { inTrash: true })] });
      const res = await callFunction(POST, database, OWNER, createBody());
      await expectErrorResponse(res, 400, 'Page is in trash.');
    });
  });

  describe('create validation', () => {
    it('rejects a parent comment from another page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        comments: [commentRow('c1', { pageId: 'p2' })],
      });
      const res = await callFunction(POST, database, OWNER, createBody({ parentId: 'c1' }));
      await expectErrorResponse(res, 404, 'Parent comment was not found on the target page.');
    });

    it('rejects a comment that is its own parent', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({ parentId: 'c-new' }));
      await expectErrorResponse(res, 400, 'Comment cannot be its own parent.');
    });

    it('rejects a blockId that is not on the page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [{ id: 'b-foreign', pageId: 'p2', type: 'paragraph', position: 0 }],
      });
      const res = await callFunction(POST, database, OWNER, createBody({ blockId: 'b-foreign' }));
      await expectErrorResponse(res, 404, 'Block was not found on the target page.');
    });

    it('inherits the blockId from the parent comment when omitted', async () => {
      const database = db({
        blocks: [{ id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 }],
        comments: [commentRow('c1', { blockId: 'b1' })],
      });
      const res = (await callFunction(POST, database, OWNER, createBody({ parentId: 'c1' }))) as {
        comment: Row;
      };
      expect(res.comment.blockId).toBe('b1');
      expect(res.comment.parentId).toBe('c1');
    });
  });

  describe('create notifications', () => {
    it('notifies page stakeholders and permission holders, never the actor', async () => {
      const database = db({
        pages: [pageRow('p1', { createdBy: OWNER })],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: MEMBER,
            role: 'comment',
          },
        ],
      });
      await callFunction(POST, database, MEMBER, createBody());
      const notifications = database.tables.notifications ?? [];
      const recipients = notifications.map((notification) => notification.userId).sort();
      // Owner (also the page creator) is notified; the acting member is not.
      expect(recipients).toEqual([OWNER]);
      expect(notifications[0].kind).toBe('comment');
      expect(notifications[0].preview).toBe('Hello there');
    });

    it('sends a mention notification instead of a comment one to mentioned users', async () => {
      const database = db();
      await callFunction(POST, database, OWNER, createBody({
        body: { rich: [{ text: 'ping' }, { mention: 'person', userId: MEMBER, text: '@member' }] },
      }));
      const forMember = (database.tables.notifications ?? []).filter(
        (notification) => notification.userId === MEMBER,
      );
      expect(forMember).toHaveLength(1);
      expect(forMember[0].kind).toBe('mention');
    });

    it('does not notify mentioned users who cannot see the page', async () => {
      const database = db();
      await callFunction(POST, database, OWNER, createBody({
        body: { rich: [{ mention: 'person', userId: 'outsider-1', text: '@outsider' }] },
      }));
      const forOutsider = (database.tables.notifications ?? []).filter(
        (notification) => notification.userId === 'outsider-1',
      );
      expect(forOutsider).toHaveLength(0);
    });

    it('does not notify page stakeholders who can no longer see the page', async () => {
      // page.createdBy is a departed user (no membership, no grant): the base
      // recipient loop must apply the same visibility gate as mentions.
      const database = db({
        pages: [pageRow('p1', { createdBy: 'departed-1', lastEditedBy: 'departed-1' })],
      });
      await callFunction(POST, database, OWNER, createBody());
      const forDeparted = (database.tables.notifications ?? []).filter(
        (notification) => notification.userId === 'departed-1',
      );
      expect(forDeparted).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('lets a comment-role author edit their own comment but not others', async () => {
      const database = db({
        comments: [
          commentRow('mine', { authorId: STRANGER }),
          commentRow('theirs', { authorId: OWNER }),
        ],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'comment',
          },
        ],
      });
      const own = (await callFunction(POST, database, STRANGER, {
        action: 'update',
        pageId: 'p1',
        id: 'mine',
        patch: { resolved: true },
      })) as { comment: Row };
      expect(own.comment.resolved).toBe(true);

      const foreign = await callFunction(POST, database, STRANGER, {
        action: 'update',
        pageId: 'p1',
        id: 'theirs',
        patch: { resolved: true },
      });
      await expectErrorResponse(foreign, 403, 'Page access required.');
    });

    it('lets an edit-role member change comments they did not author', async () => {
      const database = db({ comments: [commentRow('c1', { authorId: OWNER })] });
      const res = (await callFunction(POST, database, MEMBER, {
        action: 'update',
        pageId: 'p1',
        id: 'c1',
        patch: { resolved: true },
      })) as { comment: Row };
      expect(res.comment.resolved).toBe(true);
    });

    it('strips protected and unknown keys from the patch', async () => {
      const database = db({ comments: [commentRow('c1', { authorId: OWNER })] });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'update',
        pageId: 'p1',
        id: 'c1',
        patch: {
          body: { rich: [{ text: 'edited' }] },
          authorId: 'usurper-1',
          createdAt: '1999-01-01T00:00:00.000Z',
          somethingElse: true,
        },
      })) as { comment: Row };
      expect(res.comment.authorId).toBe(OWNER);
      expect(res.comment.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(res.comment.somethingElse).toBeUndefined();
      expect((res.comment.body as { rich: Array<{ text: string }> }).rich[0].text).toBe('edited');
    });

    it('requires edit access on both pages when moving a comment', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        comments: [commentRow('c1', { authorId: STRANGER })],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'comment',
          },
        ],
      });
      // A comment-role author cannot relocate their own comment.
      const res = await callFunction(POST, database, STRANGER, {
        action: 'update',
        pageId: 'p1',
        id: 'c1',
        patch: { pageId: 'p2' },
      });
      await expectErrorResponse(res, 403, 'Page access required.');

      const moved = (await callFunction(POST, database, OWNER, {
        action: 'update',
        pageId: 'p1',
        id: 'c1',
        patch: { pageId: 'p2' },
      })) as { comment: Row };
      expect(moved.comment.pageId).toBe('p2');
    });

    it('404s on a missing comment', async () => {
      const res = await callFunction(POST, db(), OWNER, {
        action: 'update',
        pageId: 'p1',
        id: 'ghost',
        patch: { resolved: true },
      });
      await expectErrorResponse(res, 404, 'Comment was not found.');
    });

    it('rejects a cross-page move that keeps a block anchor from the old page', async () => {
      // The kept blockId must be re-validated against the target page, like
      // create — otherwise the moved comment points at the OLD page's block.
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [{ id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 }],
        comments: [commentRow('c1', { blockId: 'b1' })],
      });
      const res = await callFunction(POST, database, OWNER, {
        action: 'update',
        pageId: 'p1',
        id: 'c1',
        patch: { pageId: 'p2' },
      });
      await expectErrorResponse(res, 404, 'Block was not found on the target page.');
      expect(database.tables.comments[0].pageId).toBe('p1');
    });

    it('rejects a cross-page move that keeps a thread parent from the old page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        comments: [commentRow('c1'), commentRow('c2', { parentId: 'c1' })],
      });
      const res = await callFunction(POST, database, OWNER, {
        action: 'update',
        pageId: 'p1',
        id: 'c2',
        patch: { pageId: 'p2' },
      });
      await expectErrorResponse(res, 404, 'Parent comment was not found on the target page.');
    });

    it('updateMany applies each update in order', async () => {
      const database = db({ comments: [commentRow('c1'), commentRow('c2')] });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'updateMany',
        pageId: 'p1',
        updates: [
          { id: 'c1', patch: { resolved: true } },
          { id: 'c2', patch: { resolved: true } },
        ],
      })) as { comments: Row[] };
      expect(res.comments.map((comment) => comment.resolved)).toEqual([true, true]);
    });
  });

  describe('delete', () => {
    it('lets the author delete their own comment', async () => {
      const database = db({
        comments: [commentRow('c1', { authorId: STRANGER })],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'comment',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, {
        action: 'delete',
        pageId: 'p1',
        id: 'c1',
      })) as { deletedId: string };
      expect(res.deletedId).toBe('c1');
      expect(database.tables.comments).toHaveLength(0);
    });

    it('denies strangers and keeps the comment', async () => {
      const database = db({ comments: [commentRow('c1')] });
      const res = await callFunction(POST, database, STRANGER, {
        action: 'delete',
        pageId: 'p1',
        id: 'c1',
      });
      await expectErrorResponse(res, 403, 'Page access required.');
      expect(database.tables.comments).toHaveLength(1);
    });

    it('reports a primary delete failure and keeps the comment row', async () => {
      const database = db({ comments: [commentRow('c1')] });
      // Comment deletes run as a thread-scoped transact; inject the failure
      // at the transact layer.
      const originalTransact = database.transact.bind(database);
      database.transact = (async (operations: Parameters<typeof database.transact>[0]) => {
        if (operations.some((op) => op.op === 'delete' && op.table === 'comments' && op.id === 'c1')) {
          throw new Error('Injected comment delete failure.');
        }
        return originalTransact(operations);
      }) as typeof database.transact;

      const res = await callFunction(POST, database, OWNER, {
        action: 'delete',
        pageId: 'p1',
        id: 'c1',
      });

      await expectErrorResponse(res, 500, 'Internal server error.');
      expect(database.tables.comments).toHaveLength(1);
    });

    it('deletes the whole reply thread with the comment', async () => {
      // Replies (recursively) go in the same transact; deleting a thread root
      // must not orphan replies pointing at a missing parent.
      const database = db({
        comments: [
          commentRow('c1'),
          commentRow('c2', { parentId: 'c1' }),
          commentRow('c3', { parentId: 'c2' }),
          commentRow('other'),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'delete',
        pageId: 'p1',
        id: 'c1',
      })) as { deletedId: string };
      expect(res.deletedId).toBe('c1');
      expect(database.tables.comments.map((comment) => comment.id)).toEqual(['other']);
    });

    it('treats deleting an unknown comment as idempotent success for commenters only', async () => {
      // The not-found branch still reports the id as deleted (idempotent
      // retries), but only after the actor proves comment access on the
      // routed page — strangers can no longer probe ids for a success.
      const res = (await callFunction(POST, db(), OWNER, {
        action: 'delete',
        pageId: 'p1',
        id: 'ghost',
      })) as { deletedId: string };
      expect(res.deletedId).toBe('ghost');

      const denied = await callFunction(POST, db(), STRANGER, {
        action: 'delete',
        pageId: 'p1',
        id: 'ghost',
      });
      await expectErrorResponse(denied, 403, 'Page access required.');
    });

    it('deleteMany ignores non-string ids and reports each deletion', async () => {
      const database = db({ comments: [commentRow('c1'), commentRow('c2')] });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'deleteMany',
        pageId: 'p1',
        ids: ['c1', 42, 'c2'],
      })) as { deletedIds: string[] };
      expect(res.deletedIds).toEqual(['c1', 'c2']);
      expect(database.tables.comments).toHaveLength(0);
    });
  });
});
