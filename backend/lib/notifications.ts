// Bounded notification upsert shared by the notification emitters
// (block-mutation, comment-mutation, workspace-bootstrap share notices).
//
// The previous per-file copies listed EVERY notification in the workspace per
// recipient per event, so a busy workspace crossed the listAll 413 ceiling and
// bricked notification delivery. The dedupe lookup is now an equality query on
// (workspaceId, userId, activityKey), and inserts prune the recipient's oldest
// READ notifications beyond a per-user retention cap so the table stays
// bounded by construction.
import type { DbRef, NotificationRecord, Page, Workspace } from './app-types';
import { getExisting, listAll, listAllTruncated, narrowWhere } from './table-utils';

/** Per-recipient retention cap; unread rows are never pruned. */
export const NOTIFICATION_RETENTION_PER_USER = 500;
// Retention scan bound: covers legacy over-cap recipients without a 413 (a
// truncated scan just prunes less aggressively this round).
const NOTIFICATION_RETENTION_SCAN_MAX_ITEMS = 2_000;
// At most this many rows are pruned per insert, keeping the write amortized.
const NOTIFICATION_PRUNE_BATCH = 50;

type NotificationTarget = Pick<NotificationRecord, 'workspaceId' | 'pageId' | 'target'>;

function unavailableNotificationTarget(): Error & { code: number; status: number } {
  return Object.assign(new Error('Notification target page is unavailable.'), {
    code: 409,
    status: 409,
  });
}

function pageIdFromNotificationTarget(target: string | undefined): string | null {
  if (!target) return null;
  try {
    const parsed = new URL(target, 'https://notification.invalid');
    const match = parsed.pathname.match(/^\/p\/([^/]+)\/?$/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  } catch {
    return null;
  }
}

/**
 * Re-read the durable deletion fences around a notification write. Permanent
 * deletion fences content before purging notifications; checking both before
 * and after the write makes the write/purge race linearizable. Callers remove
 * the just-delivered row when the post-write check fails.
 */
export async function assertNotificationTargetAvailable(
  db: DbRef,
  record: NotificationTarget,
): Promise<void> {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), record.workspaceId);
  if (!workspace || workspace.deletionPendingAt) throw unavailableNotificationTarget();

  const pageId = record.pageId ?? pageIdFromNotificationTarget(record.target);
  if (!pageId) return;
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (
    !page
    || page.workspaceId !== record.workspaceId
    || page.inTrash
    || page.deletionPendingAt
  ) {
    throw unavailableNotificationTarget();
  }
}

async function compensateUnavailableNotification(
  db: DbRef,
  deliveredId: string,
  error: unknown,
): Promise<never> {
  try {
    await db.table<NotificationRecord>('notifications').delete(deliveredId);
  } catch (compensationError) {
    console.error('[notifications] fenced delivery rollback failed:', compensationError);
    throw Object.assign(
      new Error('Notification target became unavailable and rollback failed.'),
      { status: 500, code: 500, cause: error },
    );
  }
  throw error;
}

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
  await assertNotificationTargetAvailable(db, record);
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
    const updated = await notifications.update(current.id, {
      ...record,
      readAt: current.readAt ?? null,
    });
    try {
      await assertNotificationTargetAvailable(db, record);
    } catch (error) {
      return compensateUnavailableNotification(db, updated.id, error);
    }
    return updated;
  }
  const inserted = await notifications.insert(record);
  try {
    await assertNotificationTargetAvailable(db, record);
  } catch (error) {
    return compensateUnavailableNotification(db, inserted.id, error);
  }
  try {
    await pruneReadNotificationsOverCap(db, record.workspaceId, record.userId);
  } catch (error) {
    // Retention is housekeeping; a prune failure must not report the already
    // delivered notification as failed.
    console.error('[notifications] retention prune failed:', error);
  }
  return inserted;
}
