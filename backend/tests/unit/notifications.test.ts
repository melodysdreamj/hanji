import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_RETENTION_PER_USER,
  upsertNotification,
} from '../../lib/notifications';
import { notificationReferencesDeletedContent } from '../../lib/permanent-notification-delete';
import type { DbRef, NotificationRecord } from '../../lib/app-types';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';

const USER = 'user-1';

function notificationRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    userId: USER,
    activityKey: `activity-${id}`,
    kind: 'comment',
    occurredAt: '2026-01-01T00:00:00.000Z',
    readAt: null,
    ...extra,
  };
}

function record(activityKey: string): Omit<NotificationRecord, 'id'> {
  return {
    workspaceId: 'ws1',
    userId: USER,
    activityKey,
    kind: 'comment',
    occurredAt: '2026-06-01T00:00:00.000Z',
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', ownerId: USER, name: 'Workspace' }],
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
        if (page) page.deletionPendingAt = '2026-06-01T00:00:00.000Z';
        return inserted;
      },
    };
  }) as FakeDb['table'];
}

function occurredAtFor(index: number) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

describe('lib/notifications upsertNotification', () => {
  it('updates an existing activityKey in place and preserves readAt', async () => {
    const database = db({
      notifications: [notificationRow('n1', { activityKey: 'a1', readAt: '2026-02-01T00:00:00.000Z' })],
    });
    const result = await upsertNotification(database as unknown as DbRef, record('a1'));
    expect(result.id).toBe('n1');
    expect(result.readAt).toBe('2026-02-01T00:00:00.000Z');
    expect(database.tables.notifications).toHaveLength(1);
  });

  it('prunes the oldest READ notifications beyond the per-user retention cap on insert', async () => {
    const seeded = Array.from({ length: NOTIFICATION_RETENTION_PER_USER + 5 }, (_, index) =>
      notificationRow(`n${index}`, {
        activityKey: `a${index}`,
        occurredAt: occurredAtFor(index),
        readAt: '2026-02-01T00:00:00.000Z',
      }),
    );
    const database = db({ notifications: seeded });
    await upsertNotification(database as unknown as DbRef, record('a-new'));
    const remaining = database.tables.notifications;
    expect(remaining).toHaveLength(NOTIFICATION_RETENTION_PER_USER);
    // The oldest read rows were the victims; the fresh insert survives.
    const ids = new Set(remaining.map((row) => row.id));
    for (let index = 0; index < 6; index += 1) {
      expect(ids.has(`n${index}`)).toBe(false);
    }
    expect(remaining.some((row) => row.activityKey === 'a-new')).toBe(true);
  });

  it('never prunes unread notifications', async () => {
    const seeded = Array.from({ length: NOTIFICATION_RETENTION_PER_USER + 5 }, (_, index) =>
      notificationRow(`n${index}`, { activityKey: `a${index}`, occurredAt: occurredAtFor(index) }),
    );
    const database = db({ notifications: seeded });
    await upsertNotification(database as unknown as DbRef, record('a-new'));
    expect(database.tables.notifications).toHaveLength(NOTIFICATION_RETENTION_PER_USER + 6);
  });

  it("does not touch other recipients' rows when pruning", async () => {
    const seeded = [
      ...Array.from({ length: NOTIFICATION_RETENTION_PER_USER + 2 }, (_, index) =>
        notificationRow(`n${index}`, {
          activityKey: `a${index}`,
          occurredAt: occurredAtFor(index),
          readAt: '2026-02-01T00:00:00.000Z',
        }),
      ),
      notificationRow('other-1', {
        userId: 'user-2',
        activityKey: 'b1',
        occurredAt: occurredAtFor(0),
        readAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const database = db({ notifications: seeded });
    await upsertNotification(database as unknown as DbRef, record('a-new'));
    expect(database.tables.notifications.some((row) => row.id === 'other-1')).toBe(true);
  });

  it('compensates an insert that loses the race with a permanent-delete fence', async () => {
    const database = db({
      pages: [{
        id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page',
        position: 0, inTrash: false, createdBy: USER,
      }],
    });
    fencePageAfterNotificationInsert(database, 'p1');

    await expect(upsertNotification(database as unknown as DbRef, {
      ...record('page-race'),
      pageId: 'p1',
      target: '/p/p1',
      title: 'Private page title',
      preview: 'Private notification preview',
    })).rejects.toMatchObject({ status: 409 });
    expect(database.tables.notifications).toEqual([]);
  });
});

describe('permanent notification cleanup matching', () => {
  it('fails closed for metadata deeper than the supported inspection depth', () => {
    let metadata: Record<string, unknown> = { sourcePageId: 'p1' };
    for (let depth = 0; depth < 14; depth += 1) metadata = { nested: metadata };
    expect(notificationReferencesDeletedContent(
      notificationRow('deep', { metadata }) as unknown as NotificationRecord,
      { workspaceId: 'ws1', pageIds: ['p1'] },
    )).toBe(true);
  });
});
