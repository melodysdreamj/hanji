import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/notification-mutation';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const STRANGER = 'stranger-1';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';

function notificationRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    userId: OWNER,
    activityKey: `activity-${id}`,
    kind: 'comment',
    occurredAt: T1,
    readAt: null,
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' }],
    ...tables,
  });
}

function fencePageAfterNotificationInsert(database: FakeDb, pageId: string) {
  const originalTable = database.table.bind(database);
  database.table = ((name: string) => {
    const table = originalTable(name);
    if (name !== 'notifications') return table;
    return {
      ...table,
      async insert(data: Record<string, unknown>) {
        const inserted = await table.insert(data);
        const page = database.tables.pages.find((item) => item.id === pageId);
        if (page) page.deletionPendingAt = T3;
        return inserted;
      },
    };
  }) as FakeDb['table'];
}

describe('notification-mutation POST', () => {
  it('requires authentication', async () => {
    const res = await callFunction(POST, db(), null, { action: 'list', workspaceId: 'ws1' });
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  it('rejects an unknown action', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'bogus', workspaceId: 'ws1' });
    await expectErrorResponse(res, 400, 'Unknown notification mutation action.');
  });

  it('requires a workspaceId', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'list' });
    await expectErrorResponse(res, 400, 'workspaceId is required.');
  });

  it('404s on an unknown workspace', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'list', workspaceId: 'ghost' });
    await expectErrorResponse(res, 404, 'Workspace was not found.');
  });

  describe('scope access', () => {
    it('denies strangers with no membership or grants', async () => {
      const res = await callFunction(POST, db(), STRANGER, { action: 'list', workspaceId: 'ws1' });
      await expectErrorResponse(res, 403, 'Workspace access required.');
    });

    it('allows the workspace owner and members', async () => {
      for (const userId of [OWNER, MEMBER]) {
        const res = (await callFunction(POST, db(), userId, {
          action: 'list',
          workspaceId: 'ws1',
        })) as { workspaceId: string; notifications: Row[] };
        expect(res.workspaceId).toBe('ws1');
        expect(res.notifications).toEqual([]);
      }
    });

    it('allows a non-member holding any direct page grant in the workspace', async () => {
      const database = db({
        pages: [{ id: 'p1', workspaceId: 'ws1', parentType: 'workspace', createdBy: OWNER }],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'view',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, {
        action: 'list',
        workspaceId: 'ws1',
      })) as { notifications: Row[] };
      expect(res.notifications).toEqual([]);
    });

    it('rejects deactivated organization members', async () => {
      const database = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_members: [
          { id: 'om1', organizationId: 'org1', userId: MEMBER, status: 'deactivated' },
        ],
        workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' }],
      });
      const res = await callFunction(POST, database, MEMBER, { action: 'list', workspaceId: 'ws1' });
      await expectErrorResponse(res, 403, 'Organization active access required.');
    });
  });

  describe('list', () => {
    it('returns only the actor rows, newest first, with an unread summary', async () => {
      const database = db({
        notifications: [
          notificationRow('n1', { occurredAt: T1, readAt: T2 }),
          notificationRow('n2', { occurredAt: T3 }),
          notificationRow('n3', { occurredAt: T2 }),
          notificationRow('other', { userId: MEMBER, occurredAt: T3 }),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'list',
        workspaceId: 'ws1',
      })) as { notifications: Row[]; unreadCount: number; total: number };
      expect(res.notifications.map((notification) => notification.id)).toEqual(['n2', 'n3', 'n1']);
      expect(res.unreadCount).toBe(2);
      expect(res.total).toBe(3);
    });

    it('counts unread across the whole window, not just the returned page', async () => {
      // 60 unread with the default limit of 50: the badge must say 60.
      const database = db({
        notifications: Array.from({ length: 60 }, (_, index) =>
          notificationRow(`n${index}`, { activityKey: `a${index}`, occurredAt: T1 }),
        ),
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'list',
        workspaceId: 'ws1',
      })) as { notifications: Row[]; unreadCount: number; total: number };
      expect(res.notifications).toHaveLength(50);
      expect(res.unreadCount).toBe(60);
      expect(res.total).toBe(60);
    });

    it('filters by kind, unread state, and limit', async () => {
      const database = db({
        notifications: [
          notificationRow('n1', { kind: 'mention', occurredAt: T3 }),
          notificationRow('n2', { kind: 'comment', occurredAt: T2 }),
          notificationRow('n3', { kind: 'mention', occurredAt: T1, readAt: T2 }),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'list',
        workspaceId: 'ws1',
        includeRead: false,
        kind: 'mention',
        limit: 1,
      })) as { notifications: Row[] };
      expect(res.notifications.map((notification) => notification.id)).toEqual(['n1']);
    });

    it('hides inaccessible or trashed page activity and purges orphaned page activity', async () => {
      const database = db({
        pages: [
          { id: 'p-live', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', createdBy: OWNER, inTrash: false },
          { id: 'p-private', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', createdBy: OWNER, inTrash: false },
          { id: 'p-trash', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', createdBy: OWNER, inTrash: true },
          { id: 'p-deleting', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', createdBy: OWNER, inTrash: true, deletionPendingAt: T3 },
        ],
        page_permissions: [{
          id: 'perm-live', pageId: 'p-live', workspaceId: 'ws1', principalType: 'user',
          principalId: STRANGER, role: 'view',
        }],
        notifications: [
          notificationRow('live', { userId: STRANGER, pageId: 'p-live', target: '/p/p-live' }),
          notificationRow('private', { userId: STRANGER, pageId: 'p-private', target: '/p/p-private' }),
          notificationRow('trash', { userId: STRANGER, pageId: 'p-trash', target: '/p/p-trash' }),
          notificationRow('deleting', { userId: STRANGER, pageId: 'p-deleting', target: '/p/p-deleting' }),
          notificationRow('missing', { userId: STRANGER, pageId: 'p-missing', target: '/p/p-missing' }),
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, {
        action: 'list',
        workspaceId: 'ws1',
      })) as { notifications: Row[]; unreadCount: number; total: number };
      expect(res.notifications.map((notification) => notification.id)).toEqual(['live']);
      expect(res.unreadCount).toBe(1);
      expect(res.total).toBe(1);
      expect(database.tables.notifications.map((notification) => notification.id).sort()).toEqual([
        'live',
        'private',
        'trash',
      ]);
    });
  });

  describe('sync', () => {
    it('inserts new activities stamped with the actor as recipient', async () => {
      const database = db();
      const res = (await callFunction(POST, database, MEMBER, {
        action: 'sync',
        workspaceId: 'ws1',
        activities: [
          { activityKey: 'a1', kind: 'page_edit', occurredAt: T1, title: 'Edited page' },
        ],
      })) as { synced: Row[]; unreadCount: number };
      expect(res.synced).toHaveLength(1);
      expect(res.synced[0].userId).toBe(MEMBER);
      expect(res.synced[0].activityKey).toBe('a1');
      expect(res.unreadCount).toBe(1);
      expect(database.tables.notifications).toHaveLength(1);
    });

    it('updates an existing activityKey in place and preserves readAt', async () => {
      const database = db({
        notifications: [
          notificationRow('n1', { activityKey: 'a1', title: 'Old', readAt: T2 }),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'sync',
        workspaceId: 'ws1',
        activities: [{ activityKey: 'a1', kind: 'comment', occurredAt: T3, title: 'New' }],
      })) as { synced: Row[] };
      expect(database.tables.notifications).toHaveLength(1);
      expect(res.synced[0].id).toBe('n1');
      expect(res.synced[0].title).toBe('New');
      expect(res.synced[0].readAt).toBe(T2);
    });

    it('rejects an invalid notification kind', async () => {
      const res = await callFunction(POST, db(), OWNER, {
        action: 'sync',
        workspaceId: 'ws1',
        activities: [{ activityKey: 'a1', kind: 'carrier_pigeon', occurredAt: T1 }],
      });
      await expectErrorResponse(res, 400, 'Notification kind is invalid.');
    });

    it('rejects an activity without an activityKey', async () => {
      const res = await callFunction(POST, db(), OWNER, {
        action: 'sync',
        workspaceId: 'ws1',
        activities: [{ kind: 'comment', occurredAt: T1 }],
      });
      await expectErrorResponse(res, 400, 'activityKey is required.');
    });

    it('rejects dangling, mismatched, or deleting content references', async () => {
      const database = db({
        pages: [{
          id: 'p-deleting', workspaceId: 'ws1', parentType: 'workspace', kind: 'page',
          createdBy: OWNER, inTrash: true, deletionPendingAt: T3,
        }],
      });
      const withoutPage = await callFunction(POST, database, OWNER, {
        action: 'sync', workspaceId: 'ws1',
        activities: [{ activityKey: 'a1', kind: 'comment', blockId: 'b1', occurredAt: T1 }],
      });
      await expectErrorResponse(withoutPage, 400, 'pageId is required');

      const mismatched = await callFunction(POST, database, OWNER, {
        action: 'sync', workspaceId: 'ws1',
        activities: [{ activityKey: 'a2', kind: 'comment', pageId: 'p-deleting', target: '/p/other', occurredAt: T1 }],
      });
      await expectErrorResponse(mismatched, 400, 'does not match pageId');

      const deleting = await callFunction(POST, database, OWNER, {
        action: 'sync', workspaceId: 'ws1',
        activities: [{ activityKey: 'a3', kind: 'comment', pageId: 'p-deleting', target: '/p/p-deleting', occurredAt: T1 }],
      });
      await expectErrorResponse(deleting, 409, 'target page is unavailable');
      expect(database.tables.notifications ?? []).toHaveLength(0);
    });

    it('removes a just-written activity when deletion fences the page after validation', async () => {
      const database = db({
        pages: [{
          id: 'p-race', workspaceId: 'ws1', parentType: 'workspace', kind: 'page',
          position: 0, createdBy: OWNER, inTrash: false,
        }],
      });
      fencePageAfterNotificationInsert(database, 'p-race');

      const response = await callFunction(POST, database, OWNER, {
        action: 'sync',
        workspaceId: 'ws1',
        activities: [{
          activityKey: 'delete-race',
          kind: 'comment',
          pageId: 'p-race',
          target: '/p/p-race',
          title: 'Private page title',
          preview: 'Private notification preview',
          occurredAt: T1,
        }],
      });
      await expectErrorResponse(response, 409, 'target page is unavailable');
      expect(database.tables.notifications).toEqual([]);
    });
  });

  describe('markRead / markAllRead', () => {
    it('requires notificationIds or activityKeys', async () => {
      const res = await callFunction(POST, db(), OWNER, { action: 'markRead', workspaceId: 'ws1' });
      await expectErrorResponse(res, 400, 'notificationIds or activityKeys are required.');
    });

    it('marks rows matched by id or activityKey, leaving other users untouched', async () => {
      const database = db({
        notifications: [
          notificationRow('n1'),
          notificationRow('n2', { activityKey: 'a2' }),
          notificationRow('n3'),
          notificationRow('other', { userId: MEMBER, activityKey: 'a2' }),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'markRead',
        workspaceId: 'ws1',
        readAt: T3,
        notificationIds: ['n1'],
        activityKeys: ['a2'],
      })) as { updated: Row[]; unreadCount: number };
      expect(res.updated.map((notification) => notification.id).sort()).toEqual(['n1', 'n2']);
      expect(res.updated.every((notification) => notification.readAt === T3)).toBe(true);
      expect(res.unreadCount).toBe(1);
      const other = database.tables.notifications.find((notification) => notification.id === 'other');
      expect(other?.readAt).toBeNull();
    });

    it('markAllRead stamps unread rows and keeps existing readAt values', async () => {
      const database = db({
        notifications: [
          notificationRow('n1', { readAt: T1 }),
          notificationRow('n2'),
          notificationRow('other', { userId: MEMBER }),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'markAllRead',
        workspaceId: 'ws1',
        readAt: T3,
      })) as { notifications: Row[]; unreadCount: number };
      expect(res.unreadCount).toBe(0);
      const byId = Object.fromEntries(res.notifications.map((notification) => [notification.id, notification]));
      expect(byId.n1.readAt).toBe(T1);
      expect(byId.n2.readAt).toBe(T3);
      // Another user's notification stays unread in storage.
      const other = database.tables.notifications.find((notification) => notification.id === 'other');
      expect(other?.readAt).toBeNull();
    });
  });
});
