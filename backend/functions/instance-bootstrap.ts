import { defineFunction } from '@edge-base/shared';
import {
  getInstanceSettings,
  upsertInstanceSettings,
  type DbRef as SettingsDbRef,
} from '../lib/instance-settings';
import { hanjiEnvFlag, hanjiEnvValue } from '../lib/hanji-compat';

// Master-account bootstrap. The deployment command/environment provides
// HANJI_MASTER_EMAIL / HANJI_MASTER_PASSWORD; this endpoint
// idempotently ensures that account exists and is an instance admin, and
// tells the client whether the instance is usable at all:
//  - master env configured  -> ensure account, never blocked
//  - no master env, but the instance already has users -> normal sign-in
//  - no master env, zero users, no dev-guest escape -> setup blocked; the
//    operator must restart the server with master credentials.
// The endpoint never returns the configured credentials. Request URL/Host
// metadata cannot prove that the network peer is loopback (proxies and direct
// clients can supply it), so even development convenience flows must use the
// normal auth endpoint with credentials held by the operator/browser.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AuthAdmin {
  getUser(userId: string): Promise<Record<string, unknown>>;
  listUsers(options?: { limit?: number; cursor?: string }): Promise<{
    users: Record<string, unknown>[];
    cursor?: string;
  }>;
  createUser(data: {
    email: string;
    password: string;
    displayName?: string;
    role?: string;
  }): Promise<Record<string, unknown>>;
}

interface AuditTableRef {
  insert(data: Record<string, unknown>): Promise<unknown>;
}

interface FunctionContext {
  auth?: { id?: string } | null;
  request?: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): SettingsDbRef & { table<_T>(name: string): unknown };
    auth?: AuthAdmin;
  };
}

export function normalizeMasterEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

export interface MasterBootstrapPlan {
  masterConfigured: boolean;
  /** The stored settings do not yet record this master email — resolve/create the account. */
  needsEnsure: boolean;
}

export function planMasterBootstrap(opts: {
  masterEmail: string | null;
  masterPassword: string | null;
  settingsMasterEmail: string | null;
  settingsMasterUserId: string | null;
}): MasterBootstrapPlan {
  const masterConfigured = Boolean(opts.masterEmail && opts.masterPassword);
  if (!masterConfigured) return { masterConfigured: false, needsEnsure: false };
  const alreadyEnsured =
    Boolean(opts.settingsMasterUserId) && opts.settingsMasterEmail === opts.masterEmail;
  return { masterConfigured: true, needsEnsure: !alreadyEnsured };
}

export function isSetupBlocked(opts: {
  masterConfigured: boolean;
  usersExist: boolean;
  devGuestEnabled: boolean;
}): boolean {
  if (opts.masterConfigured) return false;
  if (opts.usersExist) return false;
  // Dev/test runtimes with the loopback guest escape keep their existing
  // anonymous bootstrap path; production instances must restart with master
  // credentials before any account can exist.
  return !opts.devGuestEnabled;
}

function userIdFrom(user: Record<string, unknown>) {
  const value = user.id ?? user.userId ?? user.uid;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function userEmailFrom(user: Record<string, unknown>) {
  return normalizeMasterEmail(user.email);
}

function isMissingAuthSchemaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

async function findUserByEmail(authAdmin: AuthAdmin, email: string) {
  let cursor: string | undefined;
  // Bounded scan: this only runs until the master account is recorded in
  // instance settings (first boot or an env email rotation).
  for (let page = 0; page < 50; page += 1) {
    let result;
    try {
      result = await authAdmin.listUsers({ limit: 200, cursor });
    } catch (error) {
      // Brand-new deployment: the auth schema may not exist until the first
      // auth route (or createUser, which ensures it) runs. No table means no
      // users — proceed straight to creation instead of failing first boot.
      if (isMissingAuthSchemaError(error)) return null;
      throw error;
    }
    const users = result.users ?? [];
    const match = users.find((user) => userEmailFrom(user) === email);
    if (match) return match;
    if (!result.cursor || users.length === 0) return null;
    cursor = result.cursor;
  }
  return null;
}

async function recordBootstrapAudit(
  db: FunctionContext['admin'] extends { db(namespace: string): infer D } ? D : never,
  entry: { userId: string; email: string; created: boolean },
) {
  try {
    await (db.table('instance_audit_events') as AuditTableRef).insert({
      actorId: entry.userId,
      action: 'instance.master.bootstrap',
      targetType: 'user',
      targetId: entry.userId,
      targetLabel: entry.email,
      metadata: { createdAccount: entry.created, source: 'master-env' },
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[instance-bootstrap] failed to record audit event:', error);
  }
}

async function ensureMasterAccount(
  db: SettingsDbRef & { table<_T>(name: string): unknown },
  authAdmin: AuthAdmin,
  email: string,
  password: string,
) {
  const existing = await findUserByEmail(authAdmin, email);
  if (existing) {
    // An email match is not proof that the operator controls this auth account.
    // Reusing it would let a public signup race (or a pre-existing ordinary
    // account) claim the configured master address and become instance admin.
    // A previously-created master never reaches this branch: its confirmed
    // masterUserId/masterEmail pair makes planMasterBootstrap skip the ensure.
    throw new Error('The configured master email already belongs to an unconfirmed account.');
  }
  // Admin creation is the only trusted origin for a new master identity. If a
  // concurrent bootstrap wins this unique-email insert, this request fails
  // closed; after the winner records masterUserId, the next GET converges via
  // planMasterBootstrap without reusing an unconfirmed email match.
  const user = await authAdmin.createUser({ email, password, displayName: 'Master', role: 'user' });
  const userId = userIdFrom(user);
  if (!userId) throw new Error('Master account lookup returned no user id.');
  const settings = await getInstanceSettings(db);
  const adminIds = Array.isArray(settings.instanceAdminUserIds)
    ? (settings.instanceAdminUserIds as string[])
    : [];
  await upsertInstanceSettings(db, {
    instanceAdminUserIds: Array.from(new Set([...adminIds, userId])),
    masterUserId: userId,
    masterEmail: email,
    updatedBy: userId,
  });
  await recordBootstrapAudit(db, { userId, email, created: true });
  return { userId, created: true };
}

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const masterEmail = normalizeMasterEmail(
    hanjiEnvValue(context.env, 'HANJI_MASTER_EMAIL', 'EDGEBASE_MASTER_EMAIL'),
  );
  const masterPassword =
    hanjiEnvValue(context.env, 'HANJI_MASTER_PASSWORD', 'EDGEBASE_MASTER_PASSWORD') ?? null;
  const devGuestEnabled = hanjiEnvFlag(
    context.env,
    'HANJI_ALLOW_DEV_GUEST_LOGIN',
  );
  const db = context.admin.db('app');
  const authAdmin = context.admin.auth;
  const settings = await getInstanceSettings(db);
  const plan = planMasterBootstrap({
    masterEmail,
    masterPassword,
    settingsMasterEmail: settings.masterEmail ?? null,
    settingsMasterUserId: settings.masterUserId ?? null,
  });

  let masterReady = Boolean(settings.masterUserId) && settings.masterEmail === masterEmail;
  let masterError: string | null = null;
  if (plan.needsEnsure && masterEmail && masterPassword) {
    if (!authAdmin) {
      masterError = 'Instance auth admin is not available; master account cannot be provisioned.';
    } else {
      try {
        await ensureMasterAccount(db, authAdmin, masterEmail, masterPassword);
        masterReady = true;
      } catch (error) {
        // This is an unauthenticated status endpoint. Provider/DB exception
        // strings may contain internal schema or configuration details; retain
        // them only in server logs and expose a stable operator-facing state.
        masterError = 'Master account provisioning failed. Check the server logs.';
        console.error('[instance-bootstrap] master ensure failed:', error);
      }
    }
  }

  let usersExist = true;
  if (!plan.masterConfigured && authAdmin) {
    try {
      const probe = await authAdmin.listUsers({ limit: 1 });
      usersExist = (probe.users ?? []).length > 0;
    } catch {
      // If the user listing is unavailable, never lock the instance out.
      usersExist = true;
    }
  }

  const setupBlocked = isSetupBlocked({
    masterConfigured: plan.masterConfigured,
    usersExist,
    devGuestEnabled,
  });

  return Response.json(
    {
      ok: true,
      masterConfigured: plan.masterConfigured,
      masterReady,
      masterError,
      setupBlocked,
      // Kept for older web bundles. The credential-returning flow was removed:
      // URL/Host loopback checks do not authenticate the actual network peer.
      devAutoLoginAvailable: false,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

// Compatibility tombstone for older web bundles. This action deliberately
// never reads or returns the master environment credentials.
export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const body = (await context.request?.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action !== 'claimDevAutoLogin') {
    return Response.json({ ok: false, message: 'Unknown instance bootstrap action.' }, { status: 400 });
  }
  return Response.json(
    {
      ok: false,
      granted: false,
      message: 'Master dev auto-login has been removed. Sign in with the configured account.',
    },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  );
});
