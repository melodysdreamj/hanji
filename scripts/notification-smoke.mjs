#!/usr/bin/env node

import { permanentlyDeletePage } from './lib/harness.mjs';

const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));

let owner;
let viewer;
let workspaceId = '';
let pageId = '';
let blockId = '';
let permissionId = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL notification smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`WARN cleanup failed: ${message}`);
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Notification smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);
  viewer = await signIn(baseUrl);
  assert(owner.userId !== viewer.userId, 'owner and viewer must be different users');

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');

  pageId = crypto.randomUUID();
  const created = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Notification smoke ${new Date().toISOString()}`,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'owner must be able to create a smoke page');

  blockId = crypto.randomUUID();
  const block = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Notification smoke seed text' }] },
    plainText: 'Notification smoke seed text',
    position: 1,
  });
  assert(block?.block?.id === blockId, 'owner must be able to create a smoke block');

  await expectFunctionStatus(baseUrl, viewer.token, 'notification-mutation', {
    action: 'list',
    workspaceId,
  }, 403);
  console.log('PASS unshared viewer cannot list workspace notifications.');

  const share = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'Notification smoke viewer',
    role: 'comment',
  });
  permissionId = share?.permission?.id;
  assert(permissionId, 'share invite must return a permission id');

  const inviteInbox = await listNotifications(baseUrl, viewer.token, {
    workspaceId,
    includeRead: false,
    kind: 'system',
  });
  const inviteNotification = findNotification(
    inviteInbox.notifications,
    (notification) =>
      notification.kind === 'system' &&
      notification.metadata?.source === 'share' &&
      notification.metadata?.action === 'invite' &&
      notification.metadata?.permissionId === permissionId &&
      notification.pageId === pageId,
    'share invite notification',
  );
  assert(!inviteNotification.readAt, 'share invite notification must start unread');
  console.log('PASS direct page share creates an unread notification for the invited user.');

  await delay(20);
  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'updatePermission',
    permissionId,
    role: 'edit',
  });
  const roleInbox = await listNotifications(baseUrl, viewer.token, {
    workspaceId,
    includeRead: false,
    kind: 'system',
  });
  findNotification(
    roleInbox.notifications,
    (notification) =>
      notification.kind === 'system' &&
      notification.metadata?.source === 'share' &&
      notification.metadata?.action === 'role_update' &&
      notification.metadata?.permissionId === permissionId &&
      notification.metadata?.role === 'edit',
    'share role update notification',
  );
  console.log('PASS page permission role changes create a notification for the affected user.');

  const ownerCommentId = crypto.randomUUID();
  const ownerComment = await callFunction(baseUrl, owner.token, 'comment-mutation', {
    action: 'create',
    id: ownerCommentId,
    pageId,
    blockId,
    body: { rich: [{ text: 'Owner comment visible to the shared viewer.' }] },
  });
  assert(ownerComment?.comment?.id === ownerCommentId, 'owner must be able to create a comment');

  const viewerCommentInbox = await listNotifications(baseUrl, viewer.token, {
    workspaceId,
    includeRead: false,
    kind: 'comment',
  });
  const commentNotification = findNotification(
    viewerCommentInbox.notifications,
    (notification) =>
      notification.kind === 'comment' &&
      notification.commentId === ownerCommentId &&
      notification.pageId === pageId &&
      notification.actorId === owner.userId,
    'comment notification',
  );
  assert(
    commentNotification.target === `/p/${encodeURIComponent(pageId)}#comment-${encodeURIComponent(ownerCommentId)}`,
    'comment notification must target the comment anchor',
  );
  assert(commentNotification.metadata?.source === 'comment', 'comment notification metadata must identify comments');
  console.log('PASS new page comments notify shared page users.');

  const mentionCommentId = crypto.randomUUID();
  const mentionComment = await callFunction(baseUrl, viewer.token, 'comment-mutation', {
    action: 'create',
    id: mentionCommentId,
    pageId,
    blockId,
    body: {
      rich: [
        { text: 'Mentioning ' },
        { text: 'owner', mention: 'person', userId: owner.userId },
        { text: ' from a shared comment.' },
      ],
    },
  });
  assert(mentionComment?.comment?.id === mentionCommentId, 'viewer must be able to create a shared comment');

  const ownerMentionInbox = await listNotifications(baseUrl, owner.token, {
    workspaceId,
    includeRead: false,
    kind: 'mention',
  });
  const mentionNotification = findNotification(
    ownerMentionInbox.notifications,
    (notification) =>
      notification.kind === 'mention' &&
      notification.commentId === mentionCommentId &&
      notification.pageId === pageId &&
      notification.actorId === viewer.userId,
    'comment mention notification',
  );
  assert(
    mentionNotification.target === `/p/${encodeURIComponent(pageId)}#comment-${encodeURIComponent(mentionCommentId)}`,
    'comment mention notification must target the comment anchor',
  );
  assert(mentionNotification.metadata?.source === 'comment', 'comment mention metadata must identify comments');
  console.log('PASS person mentions in comments create mention notifications.');

  const mentionReplyId = crypto.randomUUID();
  const mentionReply = await callFunction(baseUrl, viewer.token, 'comment-mutation', {
    action: 'create',
    id: mentionReplyId,
    pageId,
    blockId,
    parentId: ownerCommentId,
    body: {
      rich: [
        { text: 'Reply mentioning ' },
        { text: 'owner', mention: 'person', userId: owner.userId },
        { text: ' from a shared reply.' },
      ],
    },
  });
  assert(mentionReply?.comment?.id === mentionReplyId, 'viewer must be able to create a shared reply mention');

  const ownerReplyMentionInbox = await listNotifications(baseUrl, owner.token, {
    workspaceId,
    includeRead: false,
    kind: 'mention',
  });
  const replyMentionNotification = findNotification(
    ownerReplyMentionInbox.notifications,
    (notification) =>
      notification.kind === 'mention' &&
      notification.commentId === mentionReplyId &&
      notification.pageId === pageId &&
      notification.actorId === viewer.userId,
    'reply mention notification',
  );
  assert(
    replyMentionNotification.target === `/p/${encodeURIComponent(pageId)}#comment-${encodeURIComponent(mentionReplyId)}`,
    'reply mention notification must target the reply comment anchor',
  );
  assert(replyMentionNotification.metadata?.source === 'reply', 'reply mention metadata must identify replies');
  assert(replyMentionNotification.metadata?.parentId === ownerCommentId, 'reply mention metadata must include parent id');
  console.log('PASS person mentions in replies create mention notifications.');

  const syncKey = `smoke:page_edit:${Date.now()}:${crypto.randomUUID()}`;
  const synced = await callFunction(baseUrl, viewer.token, 'notification-mutation', {
    action: 'sync',
    workspaceId,
    activities: [
      {
        activityKey: syncKey,
        kind: 'page_edit',
        pageId,
        actorId: owner.userId,
        title: 'Notification smoke synced edit',
        preview: 'Synced activity from the updates flow.',
        target: `/p/${pageId}`,
        metadata: { source: 'smoke' },
        occurredAt: new Date().toISOString(),
      },
    ],
  });
  assert(
    Array.isArray(synced?.synced) && synced.synced.some((notification) => notification.activityKey === syncKey),
    'notification sync must upsert the provided activity',
  );
  console.log('PASS notification sync upserts update-panel activities.');

  const sharedReadKey = `smoke:recipient_isolation:${Date.now()}:${crypto.randomUUID()}`;
  const sharedReadOccurredAt = new Date().toISOString();
  await callFunction(baseUrl, owner.token, 'notification-mutation', {
    action: 'sync',
    workspaceId,
    activities: [
      {
        activityKey: sharedReadKey,
        kind: 'system',
        pageId,
        actorId: viewer.userId,
        title: 'Notification smoke owner isolation',
        preview: 'The owner copy of a shared activity key must stay unread.',
        target: `/p/${pageId}`,
        metadata: { source: 'smoke', isolation: 'owner' },
        occurredAt: sharedReadOccurredAt,
      },
    ],
  });
  await callFunction(baseUrl, viewer.token, 'notification-mutation', {
    action: 'sync',
    workspaceId,
    activities: [
      {
        activityKey: sharedReadKey,
        kind: 'system',
        pageId,
        actorId: owner.userId,
        title: 'Notification smoke viewer isolation',
        preview: 'The viewer copy of a shared activity key can be marked read independently.',
        target: `/p/${pageId}`,
        metadata: { source: 'smoke', isolation: 'viewer' },
        occurredAt: sharedReadOccurredAt,
      },
    ],
  });

  const markRead = await callFunction(baseUrl, viewer.token, 'notification-mutation', {
    action: 'markRead',
    workspaceId,
    notificationIds: [mentionNotification.id],
    activityKeys: [
      inviteNotification.activityKey,
      commentNotification.activityKey,
      syncKey,
      sharedReadKey,
      mentionNotification.activityKey,
    ],
  });
  for (const key of [inviteNotification.activityKey, commentNotification.activityKey, syncKey, sharedReadKey]) {
    const updated = markRead?.updated?.find((notification) => notification.activityKey === key);
    assert(updated?.readAt, `notification ${key} must be marked read`);
  }
  assert(
    !markRead?.updated?.some(
      (notification) =>
        notification.id === mentionNotification.id ||
        notification.activityKey === mentionNotification.activityKey,
    ),
    'viewer markRead must not update owner mention notifications by id or activity key',
  );
  console.log('PASS selected notifications can be marked read by activity key.');

  const viewerUnreadAfterPartial = await listNotifications(baseUrl, viewer.token, {
    workspaceId,
    includeRead: false,
    limit: 50,
  });
  for (const key of [inviteNotification.activityKey, commentNotification.activityKey, syncKey]) {
    assert(
      !viewerUnreadAfterPartial.notifications.some((notification) => notification.activityKey === key),
      `read notification ${key} must not appear in unread results`,
    );
  }

  const ownerUnreadAfterViewerRead = await listNotifications(baseUrl, owner.token, {
    workspaceId,
    includeRead: false,
    limit: 100,
  });
  findNotification(
    ownerUnreadAfterViewerRead.notifications,
    (notification) =>
      notification.activityKey === mentionNotification.activityKey &&
      notification.id === mentionNotification.id &&
      !notification.readAt,
    'owner mention notification after viewer cross-recipient markRead attempt',
  );
  findNotification(
    ownerUnreadAfterViewerRead.notifications,
    (notification) =>
      notification.activityKey === sharedReadKey &&
      notification.metadata?.isolation === 'owner' &&
      !notification.readAt,
    'owner notification sharing the viewer-read activity key',
  );
  console.log('PASS notification read-state mutations stay scoped to the authenticated recipient.');

  const viewerAllRead = await callFunction(baseUrl, viewer.token, 'notification-mutation', {
    action: 'markAllRead',
    workspaceId,
  });
  assert(viewerAllRead?.unreadCount === 0, 'markAllRead must clear the viewer unread count');

  const ownerAllRead = await callFunction(baseUrl, owner.token, 'notification-mutation', {
    action: 'markAllRead',
    workspaceId,
  });
  assert(
    ownerAllRead?.updated?.some((notification) => notification.activityKey === mentionNotification.activityKey),
    'markAllRead must include the owner mention notification',
  );
  assert(
    ownerAllRead?.updated?.some(
      (notification) => notification.activityKey === replyMentionNotification.activityKey,
    ),
    'markAllRead must include the owner reply mention notification',
  );
  assert(ownerAllRead?.unreadCount === 0, 'markAllRead must clear the owner unread count');
  console.log('PASS mark-all-read clears unread notification state.');

  const deleted = await permanentlyDeletePage(baseUrl, owner.token, pageId, { call: callFunction });
  assert(deleted?.cleanup?.comments >= 3, 'permanent delete must clean notification smoke comments');
  assert(
    deleted?.cleanup?.notifications >= 8,
    'permanent delete must clean every generated page/comment/mention notification across recipients',
  );
  const ownerAfterDelete = await listNotifications(baseUrl, owner.token, {
    workspaceId,
    includeRead: true,
    limit: 200,
  });
  assert(
    !ownerAfterDelete.notifications.some((notification) => notification.pageId === pageId),
    'notification list must not retain records for the permanently deleted page',
  );
  const deletedCommentIds = new Set([ownerCommentId, mentionCommentId, mentionReplyId]);
  assert(
    !ownerAfterDelete.notifications.some((notification) => deletedCommentIds.has(notification.commentId)),
    'notification list must not retain comment notifications for permanently deleted comments',
  );
  const deletedMentionNotificationIds = new Set([mentionNotification.id, replyMentionNotification.id]);
  assert(
    !ownerAfterDelete.notifications.some((notification) => deletedMentionNotificationIds.has(notification.id)),
    'notification list must not retain mention notifications for permanently deleted content',
  );
  await expectFunctionStatus(baseUrl, viewer.token, 'notification-mutation', {
    action: 'list',
    workspaceId,
    includeRead: true,
  }, 403);
  pageId = '';
  blockId = '';
  permissionId = '';
  console.log('PASS permanent page delete removes page/comment/mention notifications from list results and storage.');

  console.log('\nPASS notification generation, sync, list, and read-state flow works through product APIs.');
}

async function listNotifications(baseUrl, token, input) {
  const result = await callFunction(baseUrl, token, 'notification-mutation', {
    action: 'list',
    limit: 50,
    ...input,
  });
  assert(Array.isArray(result?.notifications), 'notification list must return notifications');
  return result;
}

function findNotification(notifications, predicate, label) {
  assert(Array.isArray(notifications), `${label} search requires a notification array`);
  const notification = notifications.find(predicate);
  assert(notification, `expected ${label}`);
  return notification;
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);

  if (permissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId,
    }).catch(() => {});
    permissionId = '';
  }

  if (pageId) {
    await permanentlyDeletePage(baseUrl, owner.token, pageId, { call: callFunction }).catch(() => {});
    pageId = '';
    blockId = '';
  }
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/notification-smoke.mjs [options]

Checks generated share/comment/reply mention notifications, notification sync,
list filtering, and read-state mutations against a running Hanji
EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  });
  assert(response.ok, `/api/health returned HTTP ${response.status}`);
}

async function signIn(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  const token = body?.accessToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'anonymous sign-in must return an access token');
  assert(typeof userId === 'string' && userId, 'anonymous sign-in must return a user id');
  return { token, userId };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function expectFunctionStatus(baseUrl, token, name, body, status) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(
      `${name} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function postFunction(baseUrl, token, name, body) {
  return fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}: ${text.slice(0, 200)}`);
  }
}

async function fetchWithTimeout(url, init) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
