import { automationRequestHash } from './automation-actions';
import type { AutomationDeliveryRecord } from './automation-delivery-planning';
import type {
  DatabaseAutomationDefinition,
  DbRef,
  NotificationRecord,
  Workspace,
  WorkspaceMember,
} from './app-types';
import {
  getExisting,
  newId,
  nowIso,
  type TableQuery,
  type TransactOperation,
} from './table-utils';
import { hanjiCanonicalEnvValue } from './hanji-compat';
import {
  fetchPublicResource,
  normalizePublicUrl,
  readResponseBytesWithLimit,
} from './ssrf-guard';

export const MAX_DATABASE_AUTOMATION_DELIVERIES_PER_PASS = 8;

const DELIVERY_WORKER_ID = 'database-automation-deliveries';
const DELIVERY_LEASE_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_CENTRAL_NOTIFICATION_OPS = 490;
const MAX_DELIVERY_SETTLEMENT_OPS = 80;
const MAX_EXTERNAL_RESPONSE_BYTES = 64 * 1024;
const MAX_EXTERNAL_PAYLOAD_BYTES = 64 * 1024;
const MAX_SLACK_CONNECTION_CONFIG_BYTES = 64 * 1024;
const MAX_SLACK_CONNECTIONS = 100;
const EXTERNAL_REQUEST_TIMEOUT_MS = 10_000;
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const INVALID_RECIPIENT_REASON = 'Automation notification recipient is no longer a workspace member.';
const EMAIL_RETRY_REASON = 'Automation email provider did not accept the delivery.';
const WEBHOOK_RETRY_REASON = 'Automation webhook provider returned a retryable response.';
const WEBHOOK_REJECTED_REASON = 'Automation webhook provider rejected the delivery.';
const WEBHOOK_TARGET_REASON = 'Automation webhook target is not allowed.';
const SLACK_RETRY_REASON = 'Automation Slack provider returned a retryable response.';
const SLACK_REJECTED_REASON = 'Automation Slack provider rejected the delivery.';

interface DatabaseAutomationDeliveryWorker {
  id: string;
  workspaceId: string;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  cursorNextAttemptAt?: string | null;
  cursorDeliveryId?: string | null;
}

interface NotificationPayload {
  recipientIds: string[];
  message: string;
}

interface EmailPayload {
  recipientEmail: string;
  subject: string;
  message: string;
}

interface WebhookPayload {
  url: string;
  body: Record<string, unknown>;
}

interface SlackPayload {
  connectionId: string;
  channelId: string;
  message: string;
}

interface DeliveryPlan {
  delivery: AutomationDeliveryRecord;
  notificationPayload?: NotificationPayload;
  emailPayload?: EmailPayload;
  webhookPayload?: WebhookPayload;
  slackPayload?: SlackPayload;
  reason?: string;
}

interface NotificationPlan {
  delivery: AutomationDeliveryRecord;
  record: NotificationRecord;
}

export interface DatabaseAutomationDeliveryPassResult {
  processedDeliveries: number;
  notifications: number;
  externalDeliveries?: number;
  retried: number;
  failed: number;
  pausedAutomations?: number;
  hasMore: boolean;
  busy?: boolean;
}

export interface DatabaseAutomationDeliveryProviders {
  email?: {
    readonly supportsIdempotency: boolean;
    send(options: {
      to: string;
      subject: string;
      text: string;
      idempotencyKey: string;
    }): Promise<{ success: boolean; messageId?: string }>;
  };
  env?: Record<string, unknown>;
}

interface ExternalDeliveryOutcome {
  delivery: AutomationDeliveryRecord;
  status: 'succeeded' | 'retryable' | 'failed';
  reason?: string;
}

function deliveryError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function transactionConflict(error: unknown) {
  return error instanceof Error && error.message.includes('Transaction expectation failed');
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message || 'Automation notification delivery failed.').slice(0, 1_000);
}

function timestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw deliveryError(409, `${label} has an invalid timestamp.`);
  return parsed;
}

function requiredComposableQuery<T>(query: TableQuery<T>, label: string) {
  if (typeof query.where !== 'function' || typeof query.orderBy !== 'function') {
    throw deliveryError(500, `${label} requires bounded filtered keyset queries.`);
  }
  return query as TableQuery<T> & {
    where(field: string, op: string, value: unknown): TableQuery<T>;
    orderBy(field: string, direction: 'asc' | 'desc'): TableQuery<T>;
  };
}

function deliveryOrder(left: AutomationDeliveryRecord, right: AutomationDeliveryRecord) {
  return left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.id.localeCompare(right.id);
}

function notificationPayload(value: unknown): NotificationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as { recipientIds?: unknown; message?: unknown };
  if (
    !Array.isArray(input.recipientIds)
    || input.recipientIds.length === 0
    || input.recipientIds.length > 20
    || input.recipientIds.some((recipientId) => typeof recipientId !== 'string' || !recipientId)
    || new Set(input.recipientIds).size !== input.recipientIds.length
    || typeof input.message !== 'string'
    || !input.message
    || input.message.length > 2_000
  ) return null;
  return { recipientIds: [...input.recipientIds] as string[], message: input.message };
}

function emailPayload(value: unknown): EmailPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<EmailPayload>;
  if (
    typeof input.recipientEmail !== 'string'
    || input.recipientEmail.length > 320
    || input.recipientEmail !== input.recipientEmail.trim().toLowerCase()
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipientEmail)
    || typeof input.subject !== 'string'
    || !input.subject
    || input.subject.length > 200
    || typeof input.message !== 'string'
    || !input.message
    || input.message.length > 2_000
  ) return null;
  return {
    recipientEmail: input.recipientEmail,
    subject: input.subject,
    message: input.message,
  };
}

function webhookPayload(value: unknown): WebhookPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as { url?: unknown; body?: unknown };
  const url = normalizePublicUrl(input.url);
  if (!url || !input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return null;
  try {
    const serialized = JSON.stringify(input.body);
    if (
      serialized === undefined
      || new TextEncoder().encode(serialized).byteLength > MAX_EXTERNAL_PAYLOAD_BYTES
    ) return null;
  } catch {
    return null;
  }
  return { url, body: structuredClone(input.body as Record<string, unknown>) };
}

function slackPayload(value: unknown): SlackPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<SlackPayload>;
  if (
    typeof input.connectionId !== 'string'
    || !input.connectionId
    || input.connectionId.length > 160
    || typeof input.channelId !== 'string'
    || !input.channelId
    || input.channelId.length > 160
    || typeof input.message !== 'string'
    || !input.message
    || input.message.length > 2_000
  ) return null;
  return {
    connectionId: input.connectionId,
    channelId: input.channelId,
    message: input.message,
  };
}

function deliveryPlan(delivery: AutomationDeliveryRecord): DeliveryPlan {
  if (delivery.channel === 'notification') {
    const payload = notificationPayload(delivery.payload);
    return payload
      ? { delivery, notificationPayload: payload }
      : { delivery, reason: 'Automation notification delivery payload is invalid.' };
  }
  if (delivery.channel === 'email') {
    const payload = emailPayload(delivery.payload);
    return payload
      ? { delivery, emailPayload: payload }
      : { delivery, reason: 'Automation email delivery payload is invalid.' };
  }
  if (delivery.channel === 'webhook') {
    const payload = webhookPayload(delivery.payload);
    return payload
      ? { delivery, webhookPayload: payload }
      : { delivery, reason: 'Automation webhook delivery payload is invalid.' };
  }
  const payload = slackPayload(delivery.payload);
  return payload
    ? { delivery, slackPayload: payload }
    : { delivery, reason: 'Automation Slack delivery payload is invalid.' };
}

async function claimDeliveryWorker(db: DbRef, workspaceId: string) {
  const workers = db.table<DatabaseAutomationDeliveryWorker>('database_automation_delivery_workers');
  const current = await getExisting(workers, DELIVERY_WORKER_ID);
  const claimedAt = Date.now();
  if (current?.leaseUntil && timestamp(current.leaseUntil, 'Automation delivery worker lease') > claimedAt) {
    return null;
  }
  const leaseToken = newId();
  const leaseUntil = new Date(claimedAt + DELIVERY_LEASE_MS).toISOString();
  const operations: TransactOperation[] = current
    ? [
        {
          table: 'database_automation_delivery_workers',
          op: 'expect',
          id: DELIVERY_WORKER_ID,
          where: [
            ['workspaceId', '==', workspaceId],
            ['leaseToken', '==', current.leaseToken ?? null],
            ['leaseUntil', '==', current.leaseUntil ?? null],
          ],
          exists: true,
        },
        {
          table: 'database_automation_delivery_workers',
          op: 'update',
          id: DELIVERY_WORKER_ID,
          data: { leaseToken, leaseUntil },
        },
      ]
    : [
        { table: 'database_automation_delivery_workers', op: 'expect', id: DELIVERY_WORKER_ID, exists: false },
        {
          table: 'database_automation_delivery_workers',
          op: 'insert',
          data: {
            id: DELIVERY_WORKER_ID,
            workspaceId,
            leaseToken,
            leaseUntil,
            cursorNextAttemptAt: null,
            cursorDeliveryId: null,
          },
        },
      ];
  try {
    await db.transact(operations);
    return { leaseToken };
  } catch (error) {
    if (transactionConflict(error)) return null;
    throw error;
  }
}

async function releaseDeliveryWorker(db: DbRef, leaseToken: string) {
  try {
    await db.transact([
      {
        table: 'database_automation_delivery_workers',
        op: 'expect',
        id: DELIVERY_WORKER_ID,
        where: [['leaseToken', '==', leaseToken]],
        exists: true,
      },
      {
        table: 'database_automation_delivery_workers',
        op: 'update',
        id: DELIVERY_WORKER_ID,
        data: { leaseToken: null, leaseUntil: null },
      },
    ]);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
  }
}

async function dueDeliveries(db: DbRef, workspaceId: string, dueAt: string) {
  let query = requiredComposableQuery(
    db.table<AutomationDeliveryRecord>('database_automation_deliveries')
      .where('state', 'in', ['pending', 'retrying']),
    'Database automation due-delivery lookup',
  ).where('nextAttemptAt', '<=', dueAt);
  query = requiredComposableQuery(query, 'Database automation due-delivery lookup')
    .orderBy('nextAttemptAt', 'asc');
  query = requiredComposableQuery(query, 'Database automation due-delivery lookup')
    .orderBy('id', 'asc');
  const page = await query.limit(MAX_DATABASE_AUTOMATION_DELIVERIES_PER_PASS + 1).getList();
  const items = page.items ?? [];
  if (items.some((delivery) => (
    delivery.workspaceId !== workspaceId
    || typeof delivery.ownerPageId !== 'string'
    || !delivery.ownerPageId
    || !['database_automation', 'database_button', 'page_button'].includes(delivery.sourceType)
    || typeof delivery.sourceId !== 'string'
    || !delivery.sourceId
    || (delivery.sourceType === 'database_automation' && (
      !delivery.databaseId
      || !delivery.automationId
      || !Number.isSafeInteger(delivery.automationRevision)
    ))
    || (delivery.sourceType !== 'database_automation' && !delivery.executionId)
    || (delivery.state !== 'pending' && delivery.state !== 'retrying')
    || !['notification', 'email', 'webhook', 'slack'].includes(delivery.channel)
    || typeof delivery.nextAttemptAt !== 'string'
    || delivery.nextAttemptAt > dueAt
    || !Number.isSafeInteger(delivery.attempts)
    || delivery.attempts < 0
  ))) throw deliveryError(409, 'Database automation due-delivery query returned invalid data.');
  items.sort(deliveryOrder);
  return {
    deliveries: items.slice(0, MAX_DATABASE_AUTOMATION_DELIVERIES_PER_PASS),
    hasMore: Boolean(page.hasMore) || items.length > MAX_DATABASE_AUTOMATION_DELIVERIES_PER_PASS,
  };
}

async function memberAuthority(
  db: DbRef,
  workspaceId: string,
  recipientIds: string[],
) {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace) throw deliveryError(409, 'Automation delivery workspace was not found.');
  const memberRecipientIds = recipientIds.filter((recipientId) => recipientId !== workspace.ownerId);
  if (memberRecipientIds.length === 0) {
    return { workspace, members: [] as WorkspaceMember[], validIds: new Set([workspace.ownerId]) };
  }
  let query = db.table<WorkspaceMember>('workspace_members')
    .where('workspaceId', '==', workspaceId);
  if (typeof query.where !== 'function') {
    throw deliveryError(500, 'Automation notification recipient lookup requires a bounded query.');
  }
  query = query.where('userId', 'in', memberRecipientIds);
  const page = await query.limit(memberRecipientIds.length + 1).getList();
  const members = page.items ?? [];
  if (
    page.hasMore
    || members.length > memberRecipientIds.length
    || members.some((member) => member.workspaceId !== workspaceId || !memberRecipientIds.includes(member.userId))
    || new Set(members.map((member) => member.userId)).size !== members.length
  ) throw deliveryError(409, 'Automation notification recipient lookup returned invalid data.');
  return {
    workspace,
    members,
    validIds: new Set([workspace.ownerId, ...members.map((member) => member.userId)]),
  };
}

function notificationMatches(current: NotificationRecord, expected: NotificationRecord) {
  return current.id === expected.id
    && current.workspaceId === expected.workspaceId
    && current.userId === expected.userId
    && current.activityKey === expected.activityKey
    && current.kind === expected.kind
    && current.preview === expected.preview
    && current.target === expected.target
    && current.occurredAt === expected.occurredAt
    && JSON.stringify(current.metadata) === JSON.stringify(expected.metadata);
}

function notificationPresentation(delivery: AutomationDeliveryRecord) {
  if (delivery.sourceType === 'database_automation') {
    return {
      activityKey: `database-automation:${delivery.id}`,
      title: 'Database automation',
      target: `/database/${delivery.ownerPageId}`,
      metadata: {
        automationId: delivery.automationId,
        automationRevision: delivery.automationRevision,
        deliveryId: delivery.id,
        actionId: delivery.actionId,
        scheduledFor: delivery.scheduledFor,
      },
    };
  }
  return {
    activityKey: `button-action:${delivery.id}`,
    title: 'Button action',
    target: delivery.sourceType === 'database_button'
      ? `/database/${delivery.ownerPageId}`
      : `/p/${delivery.ownerPageId}`,
    metadata: {
      sourceType: delivery.sourceType,
      sourceId: delivery.sourceId,
      executionId: delivery.executionId,
      deliveryId: delivery.id,
      actionId: delivery.actionId,
      scheduledFor: delivery.scheduledFor,
    },
  };
}

async function existingNotifications(db: DbRef, plans: NotificationPlan[]) {
  if (plans.length === 0) return new Map<string, NotificationRecord>();
  const ids = plans.map((plan) => plan.record.id);
  const page = await db.table<NotificationRecord>('notifications')
    .where('id', 'in', ids)
    .limit(ids.length + 1)
    .getList();
  const items = page.items ?? [];
  if (page.hasMore || items.length > ids.length || items.some((item) => !ids.includes(item.id))) {
    throw deliveryError(409, 'Automation notification replay lookup exceeded its bound.');
  }
  return new Map(items.map((item) => [item.id, item]));
}

function slackConnections(env?: Record<string, unknown>) {
  const serialized = hanjiCanonicalEnvValue(env, 'HANJI_AUTOMATION_SLACK_CONNECTIONS');
  if (!serialized) return new Map<string, string>();
  if (new TextEncoder().encode(serialized).byteLength > MAX_SLACK_CONNECTION_CONFIG_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_SLACK_CONNECTIONS) return null;
  const connections = new Map<string, string>();
  for (const [connectionId, value] of entries) {
    if (
      !connectionId
      || connectionId.length > 160
      || !value
      || typeof value !== 'object'
      || Array.isArray(value)
    ) return null;
    const botToken = (value as { botToken?: unknown }).botToken;
    if (typeof botToken !== 'string' || !botToken.trim() || botToken.length > 2_048) return null;
    connections.set(connectionId, botToken.trim());
  }
  return connections;
}

function externalResponseIsRetryable(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function webhookTargetWasRejected(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message === 'source host is not allowed'
    || error.message === 'too many redirects';
}

async function deliverEmail(
  plan: DeliveryPlan & { emailPayload: EmailPayload },
  providers: DatabaseAutomationDeliveryProviders,
): Promise<ExternalDeliveryOutcome> {
  if (!providers.email?.supportsIdempotency) {
    return {
      delivery: plan.delivery,
      status: 'failed',
      reason: 'Automation email provider does not support stable delivery.',
    };
  }
  try {
    const result = await providers.email.send({
      to: plan.emailPayload.recipientEmail,
      subject: plan.emailPayload.subject,
      text: plan.emailPayload.message,
      idempotencyKey: plan.delivery.id,
    });
    return result.success
      ? { delivery: plan.delivery, status: 'succeeded' }
      : { delivery: plan.delivery, status: 'retryable', reason: EMAIL_RETRY_REASON };
  } catch {
    return { delivery: plan.delivery, status: 'retryable', reason: EMAIL_RETRY_REASON };
  }
}

async function deliverWebhook(
  plan: DeliveryPlan & { webhookPayload: WebhookPayload },
): Promise<ExternalDeliveryOutcome> {
  try {
    const response = await fetchPublicResource(plan.webhookPayload.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': plan.delivery.id,
        'X-Hanji-Automation-Delivery': plan.delivery.id,
      },
      body: JSON.stringify(plan.webhookPayload.body),
      signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
    });
    await readResponseBytesWithLimit(response, MAX_EXTERNAL_RESPONSE_BYTES);
    if (response.ok) return { delivery: plan.delivery, status: 'succeeded' };
    return externalResponseIsRetryable(response.status)
      ? { delivery: plan.delivery, status: 'retryable', reason: WEBHOOK_RETRY_REASON }
      : { delivery: plan.delivery, status: 'failed', reason: WEBHOOK_REJECTED_REASON };
  } catch (error) {
    return webhookTargetWasRejected(error)
      ? { delivery: plan.delivery, status: 'failed', reason: WEBHOOK_TARGET_REASON }
      : { delivery: plan.delivery, status: 'retryable', reason: WEBHOOK_RETRY_REASON };
  }
}

async function slackClientMessageId(deliveryId: string) {
  const hash = await automationRequestHash({
    type: 'database_automation_slack_message',
    deliveryId,
  });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

const RETRYABLE_SLACK_ERRORS = new Set([
  'fatal_error',
  'internal_error',
  'ratelimited',
  'request_timeout',
  'service_unavailable',
  'temporarily_unavailable',
]);

async function deliverSlack(
  plan: DeliveryPlan & { slackPayload: SlackPayload },
  connections: Map<string, string> | null,
): Promise<ExternalDeliveryOutcome> {
  const botToken = connections?.get(plan.slackPayload.connectionId);
  if (!botToken) {
    return {
      delivery: plan.delivery,
      status: 'failed',
      reason: 'Automation Slack connection is not configured.',
    };
  }
  try {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: plan.slackPayload.channelId,
        text: plan.slackPayload.message,
        client_msg_id: await slackClientMessageId(plan.delivery.id),
      }),
      signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
    });
    const bytes = await readResponseBytesWithLimit(response, MAX_EXTERNAL_RESPONSE_BYTES);
    if (!response.ok) {
      return externalResponseIsRetryable(response.status)
        ? { delivery: plan.delivery, status: 'retryable', reason: SLACK_RETRY_REASON }
        : { delivery: plan.delivery, status: 'failed', reason: SLACK_REJECTED_REASON };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { delivery: plan.delivery, status: 'retryable', reason: SLACK_RETRY_REASON };
    }
    if (payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok === true) {
      return { delivery: plan.delivery, status: 'succeeded' };
    }
    const providerError = payload && typeof payload === 'object'
      ? (payload as { error?: unknown }).error
      : undefined;
    return typeof providerError === 'string' && RETRYABLE_SLACK_ERRORS.has(providerError)
      ? { delivery: plan.delivery, status: 'retryable', reason: SLACK_RETRY_REASON }
      : { delivery: plan.delivery, status: 'failed', reason: SLACK_REJECTED_REASON };
  } catch {
    return { delivery: plan.delivery, status: 'retryable', reason: SLACK_RETRY_REASON };
  }
}

async function deliverExternal(
  plan: DeliveryPlan,
  providers: DatabaseAutomationDeliveryProviders,
  connections: Map<string, string> | null,
): Promise<ExternalDeliveryOutcome> {
  if (plan.emailPayload) return deliverEmail(plan as DeliveryPlan & { emailPayload: EmailPayload }, providers);
  if (plan.webhookPayload) return deliverWebhook(plan as DeliveryPlan & { webhookPayload: WebhookPayload });
  if (plan.slackPayload) return deliverSlack(plan as DeliveryPlan & { slackPayload: SlackPayload }, connections);
  return {
    delivery: plan.delivery,
    status: 'failed',
    reason: 'Automation external delivery payload is invalid.',
  };
}

function retryAt(processedAt: string, attempt: number) {
  const delay = Math.min(30 * 60_000, 30_000 * (2 ** Math.max(0, attempt - 1)));
  return new Date(Date.parse(processedAt) + delay).toISOString();
}

export async function processDatabaseAutomationDeliveryPass(
  db: DbRef,
  workspaceId: string,
  providers: DatabaseAutomationDeliveryProviders = {},
): Promise<DatabaseAutomationDeliveryPassResult> {
  const claim = await claimDeliveryWorker(db, workspaceId);
  if (!claim) {
    return {
      processedDeliveries: 0,
      notifications: 0,
      externalDeliveries: 0,
      retried: 0,
      failed: 0,
      hasMore: true,
      busy: true,
    };
  }
  let released = false;
  try {
    const processedAt = nowIso();
    const due = await dueDeliveries(db, workspaceId, processedAt);
    if (due.deliveries.length === 0) {
      await releaseDeliveryWorker(db, claim.leaseToken);
      released = true;
      return {
        processedDeliveries: 0,
        notifications: 0,
        externalDeliveries: 0,
        retried: 0,
        failed: 0,
        hasMore: false,
      };
    }

    const plans = due.deliveries.map(deliveryPlan);
    const notificationDeliveryPlans = plans.filter((plan) => (
      !plan.reason && plan.notificationPayload
    )) as Array<DeliveryPlan & { notificationPayload: NotificationPayload }>;
    let authority: Awaited<ReturnType<typeof memberAuthority>> | undefined;
    if (notificationDeliveryPlans.length > 0) {
      const recipientIds = Array.from(new Set(notificationDeliveryPlans.flatMap((plan) => (
        plan.notificationPayload.recipientIds
      ))));
      authority = await memberAuthority(db, workspaceId, recipientIds);
      for (const plan of notificationDeliveryPlans) {
        if (plan.notificationPayload.recipientIds.some((recipientId) => !authority!.validIds.has(recipientId))) {
          plan.reason = INVALID_RECIPIENT_REASON;
        }
      }
    }

    const validNotificationPlans = notificationDeliveryPlans.filter((plan) => !plan.reason);
    const notificationPlans = (await Promise.all(validNotificationPlans.flatMap((plan) => (
      plan.notificationPayload.recipientIds.map(async (recipientId): Promise<NotificationPlan> => {
        const id = await automationRequestHash({
          type: 'database_automation_notification',
          deliveryId: plan.delivery.id,
          recipientId,
        });
        const presentation = notificationPresentation(plan.delivery);
        return {
          delivery: plan.delivery,
          record: {
            id,
            workspaceId,
            userId: recipientId,
            activityKey: presentation.activityKey,
            kind: 'system',
            actorId: null,
            title: presentation.title,
            preview: plan.notificationPayload.message,
            target: presentation.target,
            metadata: presentation.metadata,
            occurredAt: plan.delivery.scheduledFor,
            readAt: null,
          },
        };
      })
    )))).flat();
    let centralFailure: string | null = null;
    if (notificationPlans.length > 0 && authority) {
      let existing = await existingNotifications(db, notificationPlans);
      for (const plan of notificationPlans) {
        const current = existing.get(plan.record.id);
        if (current && !notificationMatches(current, plan.record)) {
          throw deliveryError(409, 'Stable automation notification id is bound to another delivery.');
        }
      }
      const missing = notificationPlans.filter((plan) => !existing.has(plan.record.id));
      const centralOperations: TransactOperation[] = [
        {
          table: 'workspaces',
          op: 'expect',
          id: workspaceId,
          where: [
            ['ownerId', '==', authority.workspace.ownerId],
            ['updatedAt', '==', authority.workspace.updatedAt ?? null],
          ],
          exists: true,
        },
        ...authority.members.map((member): TransactOperation => ({
          table: 'workspace_members',
          op: 'expect',
          id: member.id,
          where: [
            ['workspaceId', '==', workspaceId],
            ['userId', '==', member.userId],
            ['role', '==', member.role],
          ],
          exists: true,
        })),
        ...missing.flatMap((plan): TransactOperation[] => [
          { table: 'notifications', op: 'expect', id: plan.record.id, exists: false },
          {
            table: 'notifications',
            op: 'insert',
            data: plan.record as unknown as Record<string, unknown>,
          },
        ]),
      ];
      if (centralOperations.length > MAX_CENTRAL_NOTIFICATION_OPS) {
        throw deliveryError(413, 'Automation notification delivery exceeds its central transaction bound.');
      }
      try {
        await db.transact(centralOperations);
      } catch (error) {
        existing = await existingNotifications(db, notificationPlans);
        const complete = notificationPlans.every((plan) => {
          const current = existing.get(plan.record.id);
          return current && notificationMatches(current, plan.record);
        });
        if (!complete) centralFailure = errorMessage(error);
      }
    }

    const externalPlans = plans.filter((plan) => (
      !plan.reason && plan.delivery.channel !== 'notification'
    ));
    const connections = externalPlans.some((plan) => plan.slackPayload)
      ? slackConnections(providers.env)
      : new Map<string, string>();
    // Provider calls have distinct remote authorities and failure domains, so
    // all bounded due calls run concurrently; every outcome is then collected
    // into the single workspace settlement transaction below.
    const externalOutcomes = await Promise.all(externalPlans.map((plan) => (
      deliverExternal(plan, providers, connections)
    )));
    const failurePlans: Array<{ delivery: AutomationDeliveryRecord; reason: string }> = plans
      .flatMap((plan) => plan.reason ? [{ delivery: plan.delivery, reason: plan.reason }] : []);
    const retryPlans: Array<{ delivery: AutomationDeliveryRecord; reason: string; nextAttemptAt: string }> = [];
    const successfulDeliveries = new Set<string>();
    if (centralFailure) {
      for (const plan of validNotificationPlans) {
        const attempt = plan.delivery.attempts + 1;
        if (attempt >= MAX_DELIVERY_ATTEMPTS) {
          failurePlans.push({ delivery: plan.delivery, reason: centralFailure });
        } else {
          retryPlans.push({
            delivery: plan.delivery,
            reason: centralFailure,
            nextAttemptAt: retryAt(processedAt, attempt),
          });
        }
      }
    } else {
      for (const plan of validNotificationPlans) successfulDeliveries.add(plan.delivery.id);
    }
    for (const outcome of externalOutcomes) {
      if (outcome.status === 'succeeded') {
        successfulDeliveries.add(outcome.delivery.id);
        continue;
      }
      const reason = outcome.reason ?? 'Automation external delivery failed.';
      const attempt = outcome.delivery.attempts + 1;
      if (outcome.status === 'retryable' && attempt < MAX_DELIVERY_ATTEMPTS) {
        retryPlans.push({
          delivery: outcome.delivery,
          reason,
          nextAttemptAt: retryAt(processedAt, attempt),
        });
      } else {
        failurePlans.push({ delivery: outcome.delivery, reason });
      }
    }

    const failedAutomationIds = Array.from(new Set(failurePlans.flatMap((plan) => (
      plan.delivery.sourceType === 'database_automation' && plan.delivery.automationId
        ? [plan.delivery.automationId]
        : []
    ))));
    const definitionPage = failedAutomationIds.length > 0
      ? await db.table<DatabaseAutomationDefinition>('database_automations')
          .where('id', 'in', failedAutomationIds)
          .limit(failedAutomationIds.length + 1)
          .getList()
      : { items: [] as DatabaseAutomationDefinition[], hasMore: false };
    if (definitionPage.hasMore || (definitionPage.items ?? []).length > failedAutomationIds.length) {
      throw deliveryError(409, 'Automation failure definition lookup exceeded its bound.');
    }
    const definitions = new Map((definitionPage.items ?? []).map((definition) => [definition.id, definition]));
    const pausePlans = failurePlans.flatMap((failure) => {
      if (failure.delivery.sourceType !== 'database_automation' || !failure.delivery.automationId) return [];
      const definition = definitions.get(failure.delivery.automationId);
      if (
        !definition
        || definition.workspaceId !== workspaceId
        || definition.databaseId !== failure.delivery.databaseId
        || definition.revision !== failure.delivery.automationRevision
        || definition.enabled !== true
        || definition.status !== 'active'
      ) return [];
      return [{ definition, reason: failure.reason }];
    }).filter((plan, index, all) => (
      all.findIndex((candidate) => candidate.definition.id === plan.definition.id) === index
    ));

    const retryById = new Map(retryPlans.map((plan) => [plan.delivery.id, plan]));
    const failureById = new Map(failurePlans.map((plan) => [plan.delivery.id, plan]));
    const deliveryOperations = due.deliveries.flatMap((delivery): TransactOperation[] => {
      const attempt = delivery.attempts + 1;
      const retry = retryById.get(delivery.id);
      const failure = failureById.get(delivery.id);
      const data: Record<string, unknown> = successfulDeliveries.has(delivery.id)
        ? {
            state: 'succeeded',
            attempts: attempt,
            deliveredAt: processedAt,
            failedAt: null,
            lastError: null,
          }
        : retry
          ? {
              state: 'retrying',
              attempts: attempt,
              nextAttemptAt: retry.nextAttemptAt,
              deliveredAt: null,
              failedAt: null,
              lastError: retry.reason,
            }
          : {
              state: 'failed',
              attempts: attempt,
              deliveredAt: null,
              failedAt: processedAt,
              lastError: failure?.reason ?? 'Automation delivery failed.',
            };
      return [
        {
          table: 'database_automation_deliveries',
          op: 'expect',
          id: delivery.id,
          where: [
            ['workspaceId', '==', workspaceId],
            ['ownerPageId', '==', delivery.ownerPageId],
            ['sourceType', '==', delivery.sourceType],
            ['sourceId', '==', delivery.sourceId],
            ['state', '==', delivery.state],
            ['attempts', '==', delivery.attempts],
            ['nextAttemptAt', '==', delivery.nextAttemptAt],
          ],
          exists: true,
        },
        { table: 'database_automation_deliveries', op: 'update', id: delivery.id, data },
      ];
    });
    const last = due.deliveries.at(-1)!;
    const settlementOperations: TransactOperation[] = [
      {
        table: 'database_automation_delivery_workers',
        op: 'expect',
        id: DELIVERY_WORKER_ID,
        where: [['leaseToken', '==', claim.leaseToken]],
        exists: true,
      },
      ...deliveryOperations,
      ...pausePlans.flatMap(({ definition, reason }): TransactOperation[] => [
        {
          table: 'database_automations',
          op: 'expect',
          id: definition.id,
          where: [
            ['workspaceId', '==', workspaceId],
            ['databaseId', '==', definition.databaseId],
            ['revision', '==', definition.revision],
            ['enabled', '==', true],
            ['status', '==', 'active'],
            ['updatedAt', '==', definition.updatedAt ?? null],
          ],
          exists: true,
        },
        {
          table: 'database_automations',
          op: 'update',
          id: definition.id,
          data: {
            status: 'paused',
            pausedAt: processedAt,
            pausedReason: reason,
            updatedAt: processedAt,
          },
        },
      ]),
      {
        table: 'database_automation_delivery_workers',
        op: 'update',
        id: DELIVERY_WORKER_ID,
        data: {
          leaseToken: null,
          leaseUntil: null,
          cursorNextAttemptAt: last.nextAttemptAt,
          cursorDeliveryId: last.id,
        },
      },
    ];
    if (settlementOperations.length > MAX_DELIVERY_SETTLEMENT_OPS) {
      throw deliveryError(413, 'Automation notification settlement exceeds its transaction bound.');
    }
    try {
      await db.transact(settlementOperations);
    } catch (error) {
      if (!transactionConflict(error)) throw error;
      throw deliveryError(409, 'Automation delivery changed while it was being settled.');
    }
    released = true;
    return {
      processedDeliveries: due.deliveries.length,
      notifications: centralFailure ? 0 : notificationPlans.length,
      externalDeliveries: externalOutcomes.filter((outcome) => outcome.status === 'succeeded').length,
      retried: retryPlans.length,
      failed: failurePlans.length,
      ...(pausePlans.length ? { pausedAutomations: pausePlans.length } : {}),
      hasMore: due.hasMore,
    };
  } finally {
    if (!released) await releaseDeliveryWorker(db, claim.leaseToken);
  }
}
