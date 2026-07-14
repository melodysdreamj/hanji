import { defineFunction } from '@edge-base/shared';
import {
  getInstanceSettings,
  upsertInstanceSettings,
  type DbRef as SettingsDbRef,
} from '../lib/instance-settings';
import { hanjiEnvFlag, hanjiEnvValue } from '../lib/hanji-compat';
import { getExisting, type TransactDb } from '../lib/table-utils';

// First-administrator bootstrap. The common dev/Docker/hosted path collects
// the administrator identity in the browser; the legacy environment path
// remains available for noninteractive provisioning. This endpoint tells the
// client whether the instance is usable at all:
//  - master env configured  -> ensure account, never blocked
//  - no master env, but the instance already has users -> normal sign-in
//  - no master env, zero users, browser setup enabled -> first-run web setup
//  - no master env/browser setup, zero users, no dev-guest escape -> setup blocked;
//    the operator must provide an initialization mechanism.
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
  updateUser?(userId: string, data: {
    password?: string;
    displayName?: string;
  }): Promise<Record<string, unknown>>;
}

interface AuditTableRef {
  insert(data: Record<string, unknown>): Promise<unknown>;
}

interface SetupRecord {
  id: string;
  state: 'pending' | 'complete' | string;
  email: string;
  userId?: string | null;
  claimedAt: string;
  completedAt?: string | null;
}

interface SetupTableRef {
  getOne(id: string): Promise<SetupRecord | null>;
  update(id: string, data: Partial<SetupRecord>): Promise<SetupRecord>;
}

type BootstrapDb = SettingsDbRef & TransactDb & {
  table(name: string): unknown;
};

interface FunctionContext {
  auth?: { id?: string } | null;
  request?: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): BootstrapDb;
    auth?: AuthAdmin;
  };
}

const SETUP_ID = 'global';
const SETUP_TOKEN_HEADER = 'X-Hanji-Setup-Token';

export function setupTokenAuthorized(expected: string | null, presented: unknown): boolean {
  if (!expected) return true;
  const candidate = typeof presented === 'string' ? presented.trim() : '';
  const expectedBytes = new TextEncoder().encode(expected);
  const candidateBytes = new TextEncoder().encode(candidate);
  let difference = expectedBytes.length ^ candidateBytes.length;
  const comparisonLength = Math.max(expectedBytes.length, candidateBytes.length);
  for (let index = 0; index < comparisonLength; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (candidateBytes[index] ?? 0);
  }
  return difference === 0;
}

function setupTokenFrom(context: FunctionContext) {
  return context.request?.headers.get(SETUP_TOKEN_HEADER) ?? '';
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
  setupAvailable?: boolean;
}): boolean {
  if (opts.masterConfigured) return false;
  if (opts.usersExist) return false;
  if (opts.setupAvailable) return false;
  // Dev/test runtimes with the loopback guest escape keep their existing
  // anonymous bootstrap path; other runtimes need an enabled initialization
  // mechanism before any account can exist.
  return !opts.devGuestEnabled;
}

export function validSetupPassword(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 10 &&
    value.length <= 256 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value) &&
    !/[\s\u0000-\u001f\u007f]/.test(value);
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
  entry: { userId: string; email: string; created: boolean; source?: 'master-env' | 'web-setup' },
) {
  try {
    await (db.table('instance_audit_events') as AuditTableRef).insert({
      actorId: entry.userId,
      action: 'instance.master.bootstrap',
      targetType: 'user',
      targetId: entry.userId,
      targetLabel: entry.email,
      metadata: { createdAccount: entry.created, source: entry.source ?? 'master-env' },
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[instance-bootstrap] failed to record audit event:', error);
  }
}

async function ensureMasterAccount(
  db: BootstrapDb,
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

async function setupRecord(db: BootstrapDb) {
  return getExisting(db.table('instance_setup') as SetupTableRef, SETUP_ID);
}

async function claimWebSetup(db: BootstrapDb, email: string) {
  const existing = await setupRecord(db);
  if (existing) {
    if (existing.state === 'pending' && existing.email === email) return existing;
    throw Object.assign(new Error('This Hanji instance setup has already been claimed.'), { status: 409 });
  }

  const claimedAt = new Date().toISOString();
  try {
    await db.transact([
      { table: 'instance_setup', op: 'expect', id: SETUP_ID, exists: false },
      {
        table: 'instance_setup',
        op: 'insert',
        data: { id: SETUP_ID, state: 'pending', email, claimedAt },
      },
    ]);
    return { id: SETUP_ID, state: 'pending', email, claimedAt } satisfies SetupRecord;
  } catch {
    const winner = await setupRecord(db);
    if (winner?.state === 'pending' && winner.email === email) return winner;
    throw Object.assign(new Error('This Hanji instance setup has already been claimed.'), { status: 409 });
  }
}

async function completeWebSetup(
  db: BootstrapDb,
  authAdmin: AuthAdmin,
  email: string,
  password: string,
  displayName: string | undefined,
) {
  const claim = await claimWebSetup(db, email);
  let user = await findUserByEmail(authAdmin, email);
  let created = false;
  if (!user) {
    try {
      user = await authAdmin.createUser({
        email,
        password,
        displayName: displayName || 'Master',
        role: 'user',
      });
      created = true;
    } catch (error) {
      // A same-email retry can lose the unique auth insert after sharing the
      // same durable setup claim. Only that claimed email is trusted here.
      user = await findUserByEmail(authAdmin, claim.email);
      if (!user) throw error;
    }
  } else if (authAdmin.updateUser) {
    // Recovery after an ambiguous createUser commit: the durable claim proves
    // this exact email won while the instance had no users. Make the password
    // from the retry authoritative before finalizing the master identity.
    user = await authAdmin.updateUser(userIdFrom(user), {
      password,
      ...(displayName ? { displayName } : {}),
    });
  }
  const userId = userIdFrom(user);
  if (!userId) throw new Error('Master account lookup returned no user id.');

  // Ensure the singleton exists before the cross-table final transaction.
  // Auth storage and app storage cannot share one transaction, but every app
  // record below (master/admin settings, completed claim, audit) can.
  await upsertInstanceSettings(db, {});
  const settings = await getInstanceSettings(db);
  const adminIds = Array.isArray(settings.instanceAdminUserIds)
    ? (settings.instanceAdminUserIds as string[])
    : [];
  const completedAt = new Date().toISOString();
  await db.transact([
    {
      table: 'instance_setup',
      op: 'expect',
      id: SETUP_ID,
      where: [['state', '==', 'pending'], ['email', '==', email]],
      exists: true,
    },
    {
      table: 'instance_settings',
      op: 'update',
      id: 'global',
      data: {
        instanceAdminUserIds: Array.from(new Set([...adminIds, userId])),
        masterUserId: userId,
        masterEmail: email,
        updatedBy: userId,
      },
    },
    {
      table: 'instance_setup',
      op: 'update',
      id: SETUP_ID,
      data: { state: 'complete', userId, completedAt },
    },
    {
      table: 'instance_audit_events',
      op: 'insert',
      data: {
        actorId: userId,
        action: 'instance.master.bootstrap',
        targetType: 'user',
        targetId: userId,
        targetLabel: email,
        metadata: { createdAccount: created, source: 'web-setup' },
        occurredAt: completedAt,
      },
    },
  ]);
  return userId;
}

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const masterEmail = normalizeMasterEmail(
    hanjiEnvValue(context.env, 'HANJI_MASTER_EMAIL', 'EDGEBASE_MASTER_EMAIL'),
  );
  const masterPassword =
    hanjiEnvValue(context.env, 'HANJI_MASTER_PASSWORD', 'EDGEBASE_MASTER_PASSWORD') ?? null;
  const browserSetupEnabled = hanjiEnvFlag(context.env, 'HANJI_BROWSER_SETUP');
  const configuredSetupToken =
    hanjiEnvValue(context.env, 'HANJI_BROWSER_SETUP_TOKEN') ?? null;
  const setupAuthorized = setupTokenAuthorized(configuredSetupToken, setupTokenFrom(context));
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

  let pendingSetup = false;
  if (!plan.masterConfigured && browserSetupEnabled && !settings.masterUserId) {
    try {
      pendingSetup = (await setupRecord(db))?.state === 'pending';
    } catch {
      pendingSetup = false;
    }
  }
  const setupAvailableWithoutAuthorization = Boolean(
    !plan.masterConfigured && !settings.masterUserId && browserSetupEnabled &&
      (!usersExist || pendingSetup),
  );
  const setupAvailable = setupAvailableWithoutAuthorization && setupAuthorized;
  const setupBlocked = isSetupBlocked({
    masterConfigured: plan.masterConfigured,
    usersExist,
    devGuestEnabled,
    setupAvailable: setupAvailableWithoutAuthorization,
  });

  return Response.json(
    {
      ok: true,
      masterConfigured: plan.masterConfigured,
      masterReady,
      masterError,
      setupBlocked,
      setupAvailable,
      setupAuthorizationRequired: setupAvailableWithoutAuthorization && !setupAuthorized,
      // Kept for older clients that know this response field. The Docker
      // installer is deliberately browser-only and never requires a log code.
      setupCodeRequired: false,
      setupInProgress: pendingSetup,
      // Kept for older web bundles. The credential-returning flow was removed:
      // URL/Host loopback checks do not authenticate the actual network peer.
      devAutoLoginAvailable: false,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const body = (await context.request?.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action === 'claimDevAutoLogin') {
    return Response.json(
      {
        ok: false,
        granted: false,
        message: 'Master dev auto-login has been removed. Sign in with the configured account.',
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (body.action !== 'completeSetup') {
    return Response.json({ ok: false, message: 'Unknown instance bootstrap action.' }, { status: 400 });
  }

  const configuredMasterEmail = normalizeMasterEmail(
    hanjiEnvValue(context.env, 'HANJI_MASTER_EMAIL', 'EDGEBASE_MASTER_EMAIL'),
  );
  const configuredMasterPassword =
    hanjiEnvValue(context.env, 'HANJI_MASTER_PASSWORD', 'EDGEBASE_MASTER_PASSWORD') ?? null;
  if (configuredMasterEmail && configuredMasterPassword) {
    return Response.json(
      { ok: false, message: 'This instance uses environment-provisioned master setup.' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!hanjiEnvFlag(context.env, 'HANJI_BROWSER_SETUP')) {
    return Response.json(
      { ok: false, message: 'Browser setup is not enabled for this runtime.' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const configuredSetupToken =
    hanjiEnvValue(context.env, 'HANJI_BROWSER_SETUP_TOKEN') ?? null;
  if (!setupTokenAuthorized(configuredSetupToken, setupTokenFrom(context))) {
    return Response.json(
      { ok: false, message: 'Use the private first-administrator setup link from the deploy output.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const email = normalizeMasterEmail(body.email);
  if (!email) {
    return Response.json(
      { ok: false, message: 'Enter a valid administrator email.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!validSetupPassword(body.password)) {
    return Response.json(
      { ok: false, message: 'Password must be 10-256 characters with upper and lower case letters, a number, and a symbol.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const displayName = typeof body.displayName === 'string' && body.displayName.trim()
    ? body.displayName.trim().slice(0, 100)
    : undefined;
  const db = context.admin.db('app');
  const authAdmin = context.admin.auth;
  if (!authAdmin) {
    return Response.json(
      { ok: false, message: 'Instance auth admin is unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const settings = await getInstanceSettings(db);
    if (settings.masterUserId) {
      return Response.json(
        { ok: false, message: 'This Hanji instance is already initialized.' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const existingClaim = await setupRecord(db);
    if (!existingClaim) {
      let usersExist: boolean;
      try {
        const probe = await authAdmin.listUsers({ limit: 1 });
        usersExist = (probe.users ?? []).length > 0;
      } catch (error) {
        usersExist = !isMissingAuthSchemaError(error);
      }
      if (usersExist) {
        return Response.json(
          { ok: false, message: 'This Hanji instance is already initialized.' },
          { status: 409, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }
    await completeWebSetup(db, authAdmin, email, body.password, displayName);
    return Response.json(
      { ok: true },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[instance-bootstrap] web setup failed:', error);
    const status = typeof error === 'object' && error !== null &&
      typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : 500;
    return Response.json(
      {
        ok: false,
        message: status === 409
          ? 'This Hanji instance setup has already been claimed.'
          : 'Instance setup failed. Check the server logs and try again.',
      },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
});
