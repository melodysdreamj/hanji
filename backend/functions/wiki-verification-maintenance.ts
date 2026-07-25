import { defineFunction } from '@edge-base/shared';
import { hanjiEnvValue } from '../lib/hanji-compat';
import { upsertNotification } from '../lib/notifications';
import { pageAccessRole, pageAccessRoleRanks } from '../lib/page-access';
import {
  getExisting,
  listAll,
  nowIso,
} from '../lib/table-utils';
import type {
  DbRef,
  FunctionContext,
  Page,
  PageOwner,
  WikiVerificationEmailDelivery,
  WikiVerificationQueue,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';
import { boundedDb, type AdminDbAccessor } from '../lib/workspace-db';
import { wikiExpiryEmailDeliveryId } from '../lib/wiki';

const WIKI_EXPIRY_ROUTE_MAX = 100;
const WIKI_OWNER_MAX = 20;
const SYSTEM_ACTOR = 'system:wiki-verification-maintenance';

type ScheduledContext = FunctionContext & { data?: unknown };

function scheduledAtFromData(data: unknown) {
  if (!data || typeof data !== 'object') return nowIso();
  const record = data as Record<string, unknown>;
  const raw = record.scheduledAt ?? record.scheduledTime ?? record.cronTime;
  if (typeof raw !== 'string') return nowIso();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function dueRoutes(central: DbRef, scheduledAt: string) {
  const query = central
    .table<WikiVerificationQueue>('wiki_verification_queue')
    .where('nextAttemptAt', '<=', scheduledAt);
  if (typeof query.orderBy !== 'function' || typeof query.includeTotal !== 'function') {
    throw new Error('Wiki verification maintenance requires a bounded next-attempt index.');
  }
  const ordered = query.orderBy('nextAttemptAt', 'asc');
  if (typeof ordered.includeTotal !== 'function') {
    throw new Error('Wiki verification maintenance requires a bounded next-attempt index.');
  }
  const result = await ordered
    .includeTotal(false)
    .limit(WIKI_EXPIRY_ROUTE_MAX + 1)
    .getList();
  return (result.items ?? [])
    .filter((route) =>
      (route.state === 'pending' || route.state === 'retrying')
      && route.expiresAt <= scheduledAt
      && (!route.nextAttemptAt || route.nextAttemptAt <= scheduledAt))
    .slice(0, WIKI_EXPIRY_ROUTE_MAX);
}

function emailEndpoint(env: Record<string, unknown> | undefined) {
  const raw = hanjiEnvValue(env, 'HANJI_WIKI_VERIFICATION_EMAIL_WEBHOOK_URL');
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Wiki verification email webhook URL is invalid.');
  }
  const localHttp = parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('Wiki verification email webhook must use HTTPS or loopback HTTP.');
  }
  return parsed.toString();
}

async function terminalEmailState(
  table: ReturnType<DbRef['table']>,
  existing: WikiVerificationEmailDelivery | null,
  data: WikiVerificationEmailDelivery,
) {
  if (existing) return table.update(existing.id, data);
  return table.insert(data);
}

async function deliverExpiryEmail(
  central: DbRef,
  env: Record<string, unknown> | undefined,
  member: WorkspaceMember,
  page: Page,
  route: WikiVerificationQueue,
) {
  const id = await wikiExpiryEmailDeliveryId(page.id, member.userId, route.expiresAt);
  const table = central.table<WikiVerificationEmailDelivery>(
    'wiki_verification_email_deliveries',
  );
  const existing = await getExisting(table, id);
  if (existing?.status === 'sent') return existing;
  const updatedAt = nowIso();
  const common: WikiVerificationEmailDelivery = {
    id,
    workspaceId: route.workspaceId,
    pageId: page.id,
    userId: member.userId,
    expiresAt: route.expiresAt,
    email: member.email?.trim() || null,
    status: 'pending',
    attempts: existing?.attempts ?? 0,
    lastError: null,
    sentAt: existing?.sentAt ?? null,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  };
  if (!common.email) {
    return terminalEmailState(table, existing, { ...common, status: 'no_email' });
  }
  const endpoint = emailEndpoint(env);
  if (!endpoint) {
    return terminalEmailState(table, existing, { ...common, status: 'not_configured' });
  }

  const attempt = { ...common, status: 'pending' as const, attempts: common.attempts + 1 };
  await terminalEmailState(table, existing, attempt);
  const token = hanjiEnvValue(env, 'HANJI_WIKI_VERIFICATION_EMAIL_WEBHOOK_TOKEN');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': id,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: 'wiki.verification.expired',
        idempotencyKey: id,
        workspaceId: route.workspaceId,
        pageId: page.id,
        pageTitle: page.title ?? '',
        userId: member.userId,
        email: common.email,
        expiresAt: route.expiresAt,
      }),
    });
    if (!response.ok) {
      throw new Error(`Wiki verification email webhook returned ${response.status}.`);
    }
    return table.update(id, {
      status: 'sent',
      sentAt: nowIso(),
      lastError: null,
      updatedAt: nowIso(),
    });
  } catch (error) {
    await table.update(id, {
      status: 'failed',
      lastError: errorMessage(error).slice(0, 2_000),
      updatedAt: nowIso(),
    });
    throw error;
  }
}

async function currentVisibleOwners(
  db: DbRef,
  central: DbRef,
  page: Page,
  workspace: Workspace,
) {
  const owners = await listAll(
    db.table<PageOwner>('page_owners').where('pageId', '==', page.id),
    { maxItems: WIKI_OWNER_MAX + 1, label: 'Wiki expiry owners' },
  );
  if (owners.length === 0 || owners.length > WIKI_OWNER_MAX) {
    throw new Error('Expiring wiki page has invalid owner state.');
  }
  const ownerIds = Array.from(new Set(owners.map((owner) => owner.userId)));
  const workspaceMembers = central
    .table<WorkspaceMember>('workspace_members')
    .where('workspaceId', '==', page.workspaceId);
  if (typeof workspaceMembers.where !== 'function') {
    throw new Error('Wiki expiry owner lookup requires chained database filters.');
  }
  const members = await listAll(
    workspaceMembers.where('userId', 'in', ownerIds),
    { maxItems: ownerIds.length + 1, label: 'Wiki expiry owner membership' },
  );
  const visible: WorkspaceMember[] = [];
  for (const member of members) {
    if (!ownerIds.includes(member.userId)) continue;
    const role = await pageAccessRole(
      db,
      page,
      member.userId,
      workspace,
      member.email,
      { requireWorkspace: true },
    );
    if (role && pageAccessRoleRanks[role] >= pageAccessRoleRanks.view) visible.push(member);
  }
  if (visible.length === 0) throw new Error('Expiring wiki page has no current visible owner.');
  return visible;
}

async function processRoute(
  admin: AdminDbAccessor,
  central: DbRef,
  route: WikiVerificationQueue,
  scheduledAt: string,
  env: Record<string, unknown> | undefined,
) {
  const db = boundedDb(admin, route.workspaceId);
  const page = await getExisting(db.table<Page>('pages'), route.pageId);
  const stale = !page
    || page.workspaceId !== route.workspaceId
    || page.inTrash
    || !page.wikiRootId
    || page.verificationExpiresAt !== route.expiresAt
    || route.expiresAt > scheduledAt;
  if (stale) {
    await central.table<WikiVerificationQueue>('wiki_verification_queue').delete(route.id);
    return 'stale' as const;
  }

  const workspace = await getExisting(
    central.table<Workspace>('workspaces'),
    route.workspaceId,
  );
  if (!workspace || workspace.deletionPendingAt) {
    await central.table<WikiVerificationQueue>('wiki_verification_queue').delete(route.id);
    return 'stale' as const;
  }
  const owners = await currentVisibleOwners(db, central, page, workspace);
  for (const owner of owners) {
    await upsertNotification(db, {
      workspaceId: route.workspaceId,
      userId: owner.userId,
      activityKey: `wiki-verification-expired:${page.id}:${route.expiresAt}:${owner.userId}`,
      kind: 'system',
      pageId: page.id,
      actorId: null,
      title: 'Wiki verification expired',
      preview: page.title ?? '',
      target: `/p/${encodeURIComponent(page.id)}`,
      metadata: { expiresAt: route.expiresAt, source: 'wiki-verification' },
      occurredAt: route.expiresAt,
      readAt: null,
    });
    await deliverExpiryEmail(central, env, owner, page, route);
  }

  await db.transact([
    {
      table: 'pages', op: 'expect', id: page.id,
      where: typeof page.updatedAt === 'string' ? [['updatedAt', '==', page.updatedAt]] : [],
      exists: true,
    },
    {
      table: 'pages', op: 'update', id: page.id,
      data: {
        verifiedAt: null,
        verifiedBy: null,
        verificationExpiresAt: null,
        updatedAt: scheduledAt,
        lastEditedBy: SYSTEM_ACTOR,
      },
    },
  ]);
  await central.table<WikiVerificationQueue>('wiki_verification_queue').delete(route.id);
  return 'expired' as const;
}

async function deferRoute(
  central: DbRef,
  route: WikiVerificationQueue,
  scheduledAt: string,
  error: unknown,
) {
  const attempts = (route.attempts ?? 0) + 1;
  const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
  await central.table<WikiVerificationQueue>('wiki_verification_queue').update(route.id, {
    state: 'retrying',
    attempts,
    nextAttemptAt: new Date(Date.parse(scheduledAt) + delayMinutes * 60_000).toISOString(),
    lastError: errorMessage(error).slice(0, 2_000),
    updatedAt: nowIso(),
  });
}

export default defineFunction({
  trigger: { type: 'schedule', cron: '* * * * *' },
  handler: async (rawContext) => {
    const context = rawContext as ScheduledContext;
    const scheduledAt = scheduledAtFromData(context.data);
    const central = context.admin.db('app');
    const routes = await dueRoutes(central, scheduledAt);
    let expired = 0;
    let stale = 0;
    const failures: Array<{ id: string; message: string }> = [];
    for (const route of routes) {
      try {
        const result = await processRoute(
          context.admin,
          central,
          route,
          scheduledAt,
          context.env,
        );
        if (result === 'expired') expired += 1;
        else stale += 1;
      } catch (error) {
        failures.push({ id: route.id, message: errorMessage(error) });
        try {
          await deferRoute(central, route, scheduledAt, error);
        } catch (deferError) {
          failures.push({ id: route.id, message: `retry state: ${errorMessage(deferError)}` });
        }
      }
    }
    return {
      expired,
      stale,
      failures,
      selected: routes.length,
      remaining: routes.length === WIKI_EXPIRY_ROUTE_MAX,
    };
  },
});
