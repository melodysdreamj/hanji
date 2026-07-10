import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_RETENTION_PER_USER,
  upsertNotification,
} from '../../lib/notifications';
import type { DbRef, NotificationRecord } from '../../lib/app-types';
import { fakeDb, type Row } from './helpers/fake-db';

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

function occurredAtFor(index: number) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

describe('lib/notifications upsertNotification', () => {
  it('updates an existing activityKey in place and preserves readAt', async () => {
    const database = fakeDb({
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
    const database = fakeDb({ notifications: seeded });
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
    const database = fakeDb({ notifications: seeded });
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
    const database = fakeDb({ notifications: seeded });
    await upsertNotification(database as unknown as DbRef, record('a-new'));
    expect(database.tables.notifications.some((row) => row.id === 'other-1')).toBe(true);
  });
});
