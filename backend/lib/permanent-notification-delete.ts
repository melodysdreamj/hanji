import type { DbRef, NotificationRecord } from './app-types';
import { MAX_RAW_TRANSACT_OPS } from './workspace-db';

export interface DeletedContentNotificationRefs {
  workspaceId: string;
  pageIds: Iterable<string>;
  blockIds?: Iterable<string>;
  commentIds?: Iterable<string>;
}

interface DeletedContentRefSets {
  pages: Set<string>;
  blocks: Set<string>;
  comments: Set<string>;
  all: Set<string>;
}

function nonEmptySet(values: Iterable<string> | undefined) {
  return new Set(Array.from(values ?? []).filter((value) => typeof value === 'string' && value.length > 0));
}

function refSets(refs: DeletedContentNotificationRefs): DeletedContentRefSets {
  const pages = nonEmptySet(refs.pageIds);
  const blocks = nonEmptySet(refs.blockIds);
  const comments = nonEmptySet(refs.commentIds);
  return { pages, blocks, comments, all: new Set([...pages, ...blocks, ...comments]) };
}

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function targetReferencesDeletedContent(target: string | undefined, refs: DeletedContentRefSets) {
  if (!target) return false;
  try {
    const parsed = new URL(target, 'https://notification.invalid');
    const match = parsed.pathname.match(/^\/p\/([^/]+)\/?$/);
    if (match && refs.pages.has(decoded(match[1]))) return true;
    const hash = decoded(parsed.hash.replace(/^#/, ''));
    if (hash.startsWith('block-') && refs.blocks.has(hash.slice('block-'.length))) return true;
    if (hash.startsWith('comment-') && refs.comments.has(hash.slice('comment-'.length))) return true;
  } catch {
    // Malformed targets are not interpreted by substring: title-like text
    // containing an id must never cause an unrelated notification to vanish.
  }
  return false;
}

function metadataReferencesDeletedContent(
  value: unknown,
  refs: DeletedContentRefSets,
  key = '',
  depth = 0,
): boolean {
  if (depth > 12) return true;
  if (value === null || value === undefined) return false;
  const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
  if (typeof value === 'string') {
    if (['target', 'url', 'href'].includes(normalizedKey)) {
      return targetReferencesDeletedContent(value, refs);
    }
    const isContentReferenceKey =
      normalizedKey.endsWith('pageid')
      || normalizedKey.endsWith('pageids')
      || normalizedKey.endsWith('blockid')
      || normalizedKey.endsWith('blockids')
      || normalizedKey.endsWith('commentid')
      || normalizedKey.endsWith('commentids')
      || normalizedKey === 'parentid'
      || normalizedKey === 'parentids';
    return isContentReferenceKey && refs.all.has(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => metadataReferencesDeletedContent(item, refs, key, depth + 1));
  }
  if (typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) =>
    metadataReferencesDeletedContent(childValue, refs, childKey, depth + 1));
}

export function notificationReferencesDeletedContent(
  notification: NotificationRecord,
  refs: DeletedContentNotificationRefs,
) {
  if (notification.workspaceId !== refs.workspaceId) return false;
  return notificationReferencesDeletedContentSets(notification, refSets(refs));
}

function notificationReferencesDeletedContentSets(
  notification: NotificationRecord,
  sets: DeletedContentRefSets,
) {
  return (
    (!!notification.pageId && sets.pages.has(notification.pageId))
    || (!!notification.blockId && sets.blocks.has(notification.blockId))
    || (!!notification.commentId && sets.comments.has(notification.commentId))
    || targetReferencesDeletedContent(notification.target, sets)
    || metadataReferencesDeletedContent(notification.metadata, sets)
  );
}

/**
 * Central notifications cannot rely on database foreign-key cascades after
 * workspace content moved into per-workspace Durable Objects. Scan only the
 * selected workspace and retain just matching ids in memory, then delete in
 * bounded central transactions before content metadata disappears.
 */
export async function deleteNotificationsForDeletedContent(
  db: DbRef,
  refs: DeletedContentNotificationRefs,
): Promise<number> {
  const notifications = db.table<NotificationRecord>('notifications');
  const query = notifications.where('workspaceId', '==', refs.workspaceId);
  const sets = refSets(refs);
  const ids = new Set<string>();
  const pageSize = 1_000;

  for (let page = 1; ; page += 1) {
    const result = await query.page(page).limit(pageSize).getList();
    const rows = result.items ?? [];
    if (rows.length === 0) {
      if (result.hasMore) {
        throw new Error('Workspace notifications pagination returned an empty page with hasMore set.');
      }
      break;
    }
    for (const notification of rows) {
      if (notificationReferencesDeletedContentSets(notification, sets)) ids.add(notification.id);
    }
    if (!result.hasMore) break;
  }

  const operations = Array.from(ids, (id) => ({ table: 'notifications', op: 'delete' as const, id }));
  for (let index = 0; index < operations.length; index += MAX_RAW_TRANSACT_OPS) {
    await db.transact(operations.slice(index, index + MAX_RAW_TRANSACT_OPS));
  }
  return operations.length;
}
