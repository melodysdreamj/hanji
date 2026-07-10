// Bounded notification upsert shared by the notification emitters
// (block-mutation, comment-mutation, workspace-bootstrap share notices).
//
// The previous per-file copies listed EVERY notification in the workspace per
// recipient per event, so a busy workspace crossed the listAll 413 ceiling and
// bricked notification delivery. The dedupe lookup is now an equality query on
// (workspaceId, userId, activityKey), and inserts prune the recipient's oldest
// READ notifications beyond a per-user retention cap so the table stays
// bounded by construction.
import type { DbRef, NotificationRecord } from './app-types';
import { listAll, listAllTruncated, narrowWhere } from './table-utils';

/** Per-recipient retention cap; unread rows are never pruned. */
export const NOTIFICATION_RETENTION_PER_USER = 500;
// Retention scan bound: covers legacy over-cap recipients without a 413 (a
// truncated scan just prunes less aggressively this round).
const NOTIFICATION_RETENTION_SCAN_MAX_ITEMS = 2_000;
// At most this many rows are pruned per insert, keeping the write amortized.
const NOTIFICATION_PRUNE_BATCH = 50;

function byOccurredAtAscending(a: NotificationRecord, b: NotificationRecord) {
  return (
    (Date.parse(a.occurredAt) || 0) - (Date.parse(b.occurredAt) || 0) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The recipient's notifications as a bounded query (never a whole-workspace
 * scan). The in-memory filter stays the source of truth per narrowWhere's
 * contract; the chained where only reduces how many rows come back.
 */
export async function recipientNotifications(
  db: DbRef,
  workspaceId: string,
  userId: string,
  options: { maxItems?: number } = {},
): Promise<{ items: NotificationRecord[]; complete: boolean }> {
  const query = narrowWhere(
    db.table<NotificationRecord>('notifications').where('workspaceId', '==', workspaceId),
    'userId',
    userId,
  );
  const { items, complete } = await listAllTruncated(query, {
    maxItems: options.maxItems ?? NOTIFICATION_RETENTION_SCAN_MAX_ITEMS,
    label: 'Recipient notifications',
  });
  return { items: items.filter((item) => item.userId === userId), complete };
}

async function pruneReadNotificationsOverCap(
  db: DbRef,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const { items } = await recipientNotifications(db, workspaceId, userId);
  const overflow = items.length - NOTIFICATION_RETENTION_PER_USER;
  if (overflow <= 0) return;
  const victims = items
    .filter((item) => item.readAt)
    .sort(byOccurredAtAscending)
    .slice(0, Math.min(overflow, NOTIFICATION_PRUNE_BATCH));
  const notifications = db.table<NotificationRecord>('notifications');
  for (const victim of victims) {
    await notifications.delete(victim.id);
  }
}

export async function upsertNotification(
  db: DbRef,
  record: Omit<NotificationRecord, 'id'>,
): Promise<NotificationRecord> {
  const notifications = db.table<NotificationRecord>('notifications');
  const candidates = await listAll(
    narrowWhere(
      narrowWhere(
        notifications.where('workspaceId', '==', record.workspaceId),
        'userId',
        record.userId,
      ),
      'activityKey',
      record.activityKey,
    ),
    { label: 'Notification dedupe lookup' },
  );
  const current = candidates.find(
    (item) => item.userId === record.userId && item.activityKey === record.activityKey,
  );
  if (current) {
    return notifications.update(current.id, {
      ...record,
      readAt: current.readAt ?? null,
    });
  }
  const inserted = await notifications.insert(record);
  try {
    await pruneReadNotificationsOverCap(db, record.workspaceId, record.userId);
  } catch (error) {
    // Retention is housekeeping; a prune failure must not report the already
    // delivered notification as failed.
    console.error('[notifications] retention prune failed:', error);
  }
  return inserted;
}
