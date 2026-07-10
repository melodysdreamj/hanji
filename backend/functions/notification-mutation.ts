import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { assertNotDeactivatedWorkspaceAccess } from '../lib/org-access';
import { boundedDb, type AdminDbAccessor } from '../lib/workspace-db';
import { recipientNotifications } from '../lib/notifications';
import { actorPagePermissions } from '../lib/page-access';

import {
  listAll,
  requireString,
  getExisting,
  nowIso,
  type TableQuery,
  type TransactDb,
} from '../lib/table-utils';
import type { DbRef as AppDbRef } from '../lib/app-types';
type NotificationKind = 'comment' | 'mention' | 'link' | 'page_edit' | 'system';

interface Workspace {
  id: string;
  ownerId?: string;
}

interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
}

interface NotificationRecord {
  id: string;
  workspaceId: string;
  userId: string;
  activityKey: string;
  kind: NotificationKind;
  pageId?: string | null;
  blockId?: string | null;
  commentId?: string | null;
  actorId?: string | null;
  title?: string;
  preview?: string;
  target?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
  readAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface NotificationInput {
  activityKey: string;
  kind: NotificationKind;
  pageId?: string | null;
  blockId?: string | null;
  commentId?: string | null;
  actorId?: string | null;
  title?: string;
  preview?: string;
  target?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  admin: {
    db(namespace: string): DbRef;
  };
}

const notificationKinds = new Set<NotificationKind>([
  'comment',
  'mention',
  'link',
  'page_edit',
  'system',
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
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function optionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function parseLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return fallback;
}

function parseDateString(value: unknown, fallback = nowIso()) {
  if (typeof value !== 'string') return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function cleanMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function hasWorkspaceAccess(db: DbRef, workspace: Workspace, actorId: string) {
  await assertNotDeactivatedWorkspaceAccess(db, workspace.id, actorId);
  if (workspace.ownerId === actorId) return true;

  const memberships = await listAll(
    db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspace.id),
  );
  return memberships.some((member) => member.userId === actorId);
}

async function hasDirectPageAccess(
  admin: AdminDbAccessor,
  workspaceId: string,
  actorId: string,
  actorEmail?: string | null,
) {
  // page_permissions lives in the workspace block after the split; route the
  // grant lookup through the facade (pass-through to `app` pre-flip).
  const contentDb = boundedDb(admin, workspaceId) as unknown as DbRef;
  const permissions = await actorPagePermissions(contentDb, actorId, workspaceId, actorEmail);
  return permissions.some((permission) => permission.role !== 'none');
}

async function assertNotificationScopeAccess(
  db: DbRef,
  admin: AdminDbAccessor,
  workspaceId: string,
  actorId: string,
  actorEmail?: string | null,
) {
  const workspaces = db.table<Workspace>('workspaces');
  const workspace = await getExisting(workspaces, workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  if (await hasWorkspaceAccess(db, workspace, actorId)) return workspace;
  if (await hasDirectPageAccess(admin, workspaceId, actorId, actorEmail)) return workspace;
  throw new Error('Workspace access required.');
}

function sanitizeNotificationInput(raw: unknown): NotificationInput {
  if (!raw || typeof raw !== 'object') throw new Error('Notification activity is required.');
  const item = raw as Record<string, unknown>;
  const kind = item.kind;
  if (typeof kind !== 'string' || !notificationKinds.has(kind as NotificationKind)) {
    throw new Error('Notification kind is invalid.');
  }
  return {
    activityKey: requireString(item.activityKey, 'activityKey').slice(0, 240),
    kind: kind as NotificationKind,
    pageId: optionalString(item.pageId, 'pageId'),
    blockId: optionalString(item.blockId, 'blockId'),
    commentId: optionalString(item.commentId, 'commentId'),
    actorId: optionalString(item.actorId, 'actorId'),
    title: optionalText(item.title, 500),
    preview: optionalText(item.preview, 1000),
    target: optionalText(item.target, 1000),
    metadata: cleanMetadata(item.metadata),
    occurredAt: parseDateString(item.occurredAt),
  };
}

function sortNotifications(items: NotificationRecord[]) {
  return [...items].sort(
    (a, b) =>
      (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0) ||
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  );
}

// Bounded per-recipient query, never a whole-workspace scan: the retention cap
// (lib/notifications) keeps a recipient's rows bounded, and legacy over-cap
// recipients degrade to a truncated window instead of a hard 413.
async function notificationsForUser(db: DbRef, workspaceId: string, actorId: string) {
  const { items } = await recipientNotifications(db as unknown as AppDbRef, workspaceId, actorId);
  return items;
}

function notificationSummary(records: NotificationRecord[]) {
  return {
    unreadCount: records.filter((record) => !record.readAt).length,
    total: records.length,
  };
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

async function listNotifications(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertNotificationScopeAccess(db, admin, workspaceId, actorId, actorEmail);

  const includeRead = parseBoolean(body.includeRead, true);
  const kind = typeof body.kind === 'string' && notificationKinds.has(body.kind as NotificationKind)
    ? (body.kind as NotificationKind)
    : null;
  const limit = parseLimit(body.limit, 50, 200);
  const all = sortNotifications(await notificationsForUser(db, workspaceId, actorId));
  const records = all
    .filter((record) => includeRead || !record.readAt)
    .filter((record) => !kind || record.kind === kind)
    .slice(0, limit);

  return {
    workspaceId,
    notifications: records,
    // The badge counts the whole retention window, not the returned page —
    // a `limit` of 50 must not cap unreadCount at 50.
    ...notificationSummary(all),
  };
}

async function syncNotifications(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertNotificationScopeAccess(db, admin, workspaceId, actorId, actorEmail);

  const input = Array.isArray(body.activities) ? body.activities.slice(0, 100) : [];
  const activities = input.map(sanitizeNotificationInput);
  const notifications = db.table<NotificationRecord>('notifications');
  const existing = await notificationsForUser(db, workspaceId, actorId);
  const byKey = new Map(existing.map((record) => [record.activityKey, record]));
  const synced: NotificationRecord[] = [];

  for (const activity of activities) {
    const current = byKey.get(activity.activityKey);
    const data = stripUndefined({
      workspaceId,
      userId: actorId,
      ...activity,
    } satisfies Partial<NotificationRecord>);
    if (current) {
      const updated = await notifications.update(current.id, {
        ...data,
        readAt: current.readAt ?? null,
      });
      synced.push(updated);
      byKey.set(activity.activityKey, updated);
    } else {
      const inserted = await notifications.insert(data);
      synced.push(inserted);
      byKey.set(activity.activityKey, inserted);
    }
  }

  const all = sortNotifications(Array.from(byKey.values()));
  return {
    workspaceId,
    notifications: all.slice(0, 200),
    synced,
    // Summary spans the whole retention window, not the returned page.
    ...notificationSummary(all),
  };
}

async function markNotificationsRead(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertNotificationScopeAccess(db, admin, workspaceId, actorId, actorEmail);

  const readAt = parseDateString(body.readAt, nowIso());
  const ids = new Set(
    (Array.isArray(body.notificationIds) ? body.notificationIds : [])
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
  );
  const keys = new Set(
    (Array.isArray(body.activityKeys) ? body.activityKeys : [])
      .filter((key): key is string => typeof key === 'string' && key.trim().length > 0),
  );
  if (ids.size === 0 && keys.size === 0) throw new Error('notificationIds or activityKeys are required.');

  const notifications = db.table<NotificationRecord>('notifications');
  const records = await notificationsForUser(db, workspaceId, actorId);
  const updated: NotificationRecord[] = [];
  for (const record of records) {
    if (!ids.has(record.id) && !keys.has(record.activityKey)) continue;
    updated.push(await notifications.update(record.id, { readAt }));
  }

  const all = sortNotifications(
    records.map((record) =>
      updated.find((item) => item.id === record.id) ?? record,
    ),
  );
  return {
    workspaceId,
    notifications: all.slice(0, 200),
    updated,
    // Summary spans the whole retention window, not the returned page.
    ...notificationSummary(all),
  };
}

async function markAllNotificationsRead(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  await assertNotificationScopeAccess(db, admin, workspaceId, actorId, actorEmail);

  const readAt = parseDateString(body.readAt, nowIso());
  const notifications = db.table<NotificationRecord>('notifications');
  const records = await notificationsForUser(db, workspaceId, actorId);
  const updated: NotificationRecord[] = [];

  for (const record of records) {
    if (record.readAt) {
      updated.push(record);
    } else {
      updated.push(await notifications.update(record.id, { readAt }));
    }
  }

  const all = sortNotifications(updated);
  return {
    workspaceId,
    notifications: all.slice(0, 200),
    updated,
    // Summary spans the whole retention window, not the returned page.
    ...notificationSummary(all),
  };
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const db = admin.db('app');
  const actorEmail = auth.email ?? null;

  try {
    switch (action) {
      case 'list':
        return await listNotifications(db, admin, body, auth.id, actorEmail);
      case 'sync':
        return await syncNotifications(db, admin, body, auth.id, actorEmail);
      case 'markRead':
        return await markNotificationsRead(db, admin, body, auth.id, actorEmail);
      case 'markAllRead':
        return await markAllNotificationsRead(db, admin, body, auth.id, actorEmail);
      default:
        return jsonError(400, 'Unknown notification mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['access required'] },
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
});
