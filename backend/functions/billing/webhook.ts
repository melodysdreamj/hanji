import { defineFunction } from '@edge-base/shared';
import { hanjiEnvValue } from '../../lib/hanji-compat';
import { getExisting, listAll, nowIso, type TableQuery } from '../../lib/table-utils';

const MAX_CLOCK_SKEW_SECONDS = 300;

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef {
  table<T>(name: string): TableRef<T>;
}

interface FunctionContext {
  request?: Request;
  env?: Record<string, unknown>;
  admin: { db(namespace: string): DbRef };
}

interface Organization {
  id: string;
}

interface BillingRecord {
  id: string;
  organizationId: string;
  externalId?: string | null;
  title: string;
}

interface BillingWebhookEvent {
  id: string;
  eventId: string;
  organizationId: string;
  eventType: string;
  billingRecordId?: string | null;
  receivedAt: string;
}

interface AuditEvent {
  id: string;
  organizationId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function boundedString(value: unknown, field: string, max: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim().slice(0, max);
}

function optionalString(value: unknown, max: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function optionalAmount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export async function handleBillingWebhook(rawContext: unknown) {
  const context = rawContext as FunctionContext;
  const request = context.request;
  if (!request) return json({ error: 'Request context is missing.' }, 400);
  const secret = hanjiEnvValue(
    context.env,
    'HANJI_BILLING_WEBHOOK_SECRET',
    'EDGEBASE_BILLING_WEBHOOK_SECRET',
  );
  if (!secret) return json({ error: 'Billing webhook is not configured.' }, 503);
  const timestamp = request.headers.get('x-hanji-billing-timestamp') ?? '';
  const signatureHeader = request.headers.get('x-hanji-billing-signature') ?? '';
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > MAX_CLOCK_SKEW_SECONDS) {
    return json({ error: 'Billing webhook timestamp is invalid or expired.' }, 401);
  }
  const rawBody = await request.text();
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  const supplied = /^v1=([a-f0-9]{64})$/i.exec(signatureHeader.trim())?.[1]?.toLowerCase() ?? '';
  if (!constantTimeEqual(expected, supplied)) return json({ error: 'Billing webhook signature is invalid.' }, 401);

  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const eventId = boundedString(body.eventId, 'eventId', 200);
    const organizationId = boundedString(body.organizationId, 'organizationId', 200);
    const eventType = boundedString(body.type, 'type', 100);
    if (!['contract.updated', 'subscription.updated', 'invoice.updated', 'credit.updated'].includes(eventType)) {
      return json({ error: 'Unsupported billing webhook event type.' }, 400);
    }
    const db = context.admin.db('app');
    const duplicates = await listAll(
      db.table<BillingWebhookEvent>('organization_billing_webhook_events').where('eventId', '==', eventId),
    );
    if (duplicates.length > 0) return json({ ok: true, duplicate: true });
    const organization = await getExisting(db.table<Organization>('organizations'), organizationId);
    if (!organization) return json({ error: 'Organization was not found.' }, 404);
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : {};
    const externalId = boundedString(data.externalId, 'data.externalId', 300);
    const title = boundedString(data.title, 'data.title', 200);
    const records = await listAll(
      db.table<BillingRecord>('organization_billing_records').where('organizationId', '==', organizationId),
    );
    const existing = records.find((record) => record.externalId === externalId) ?? null;
    const patch = {
      organizationId,
      externalId,
      kind: eventType.split('.')[0],
      status: optionalString(data.status, 80) ?? 'active',
      title,
      amountCents: optionalAmount(data.amountCents),
      currency: optionalString(data.currency, 12)?.toUpperCase() ?? 'USD',
      billingEmail: optionalString(data.billingEmail, 320),
      contractOwnerEmail: optionalString(data.contractOwnerEmail, 320),
      renewalAt: optionalString(data.renewalAt, 80),
      periodStart: optionalString(data.periodStart, 80),
      periodEnd: optionalString(data.periodEnd, 80),
      metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
      createdBy: 'billing-webhook',
      updatedAt: nowIso(),
    };
    const record = existing
      ? await db.table<BillingRecord>('organization_billing_records').update(existing.id, patch)
      : await db.table<BillingRecord>('organization_billing_records').insert(patch);
    const receivedAt = nowIso();
    await db.table<AuditEvent>('organization_audit_events').insert({
      organizationId,
      action: 'organization_billing.webhook_sync',
      targetType: 'organization_billing_record',
      targetId: record.id,
      metadata: { eventId, eventType, externalId },
      occurredAt: receivedAt,
    });
    await db.table<BillingWebhookEvent>('organization_billing_webhook_events').insert({
      eventId,
      organizationId,
      eventType,
      billingRecordId: record.id,
      receivedAt,
    });
    return json({ ok: true, billingRecordId: record.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Billing webhook failed.';
    return json({ error: message }, /required|unsupported|invalid/i.test(message) ? 400 : 500);
  }
}

export const POST = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 512 * 1024,
  handler: handleBillingWebhook,
});
