import { defineFunction } from '@edge-base/shared';
import { getInstanceSettings, parseSignupPolicy } from '../lib/instance-settings';
import { hanjiEnvFlag, hanjiEnvValue } from '../lib/hanji-compat';

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
}

interface DbRef {
  table<T>(name: string): TableRef<T>;
}

interface FunctionContext {
  data?: {
    after?: Record<string, unknown>;
  };
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): DbRef;
    auth?: {
      listUsers(options?: { limit?: number; cursor?: string }): Promise<{
        users: Record<string, unknown>[];
        cursor?: string;
      }>;
    };
  };
}

const SETUP_BLOCKED_MESSAGE =
  'Instance is not initialized. Restart the server with HANJI_MASTER_EMAIL and HANJI_MASTER_PASSWORD to provision the master account.';
const MASTER_PROVISIONING_MESSAGE =
  'Master account provisioning must complete before signup. Check the server logs and configured master email.';
const SIGNUP_CLOSED_MESSAGE =
  'Self-service signup is disabled on this instance. Ask an instance admin to create your account.';

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// A fresh instance (zero auth users) without master credentials must refuse
// account creation entirely; the operator has to restart with master env.
// Fail open on lookup errors — this guard must never brick sign-up on a
// running instance because the user listing was momentarily unavailable.
async function assertInstanceInitialized(context: FunctionContext) {
  const configuredMasterEmail = normalizeEmail(
    hanjiEnvValue(context.env, 'HANJI_MASTER_EMAIL', 'EDGEBASE_MASTER_EMAIL'),
  );
  const masterConfigured = Boolean(
    configuredMasterEmail &&
      hanjiEnvValue(context.env, 'HANJI_MASTER_PASSWORD', 'EDGEBASE_MASTER_PASSWORD'),
  );
  if (masterConfigured) {
    const settings = await getInstanceSettings(context.admin.db('app'));
    if (settings.masterUserId && settings.masterEmail === configuredMasterEmail) return;
    // Client signups must not race the trusted admin.createUser bootstrap for
    // the configured address. The admin path does not pass through beforeSignUp.
    throw new Error(MASTER_PROVISIONING_MESSAGE);
  }
  if (hanjiEnvFlag(context.env, 'HANJI_ALLOW_DEV_GUEST_LOGIN')) {
    return;
  }
  const authAdmin = context.admin.auth;
  if (!authAdmin?.listUsers) return;
  let usersExist = true;
  try {
    const probe = await authAdmin.listUsers({ limit: 1 });
    usersExist = (probe.users ?? []).length > 0;
  } catch {
    return;
  }
  if (!usersExist) throw new Error(SETUP_BLOCKED_MESSAGE);
}

// Instance accounts are managed at the server level: an admin either allows
// open self-service signup ('public') or provisions every account by hand
// ('closed'). There is no workspace-invitation path — sharing a workspace with
// someone is done by adding an existing server account, not by inviting an
// email that then self-registers. See docs/work-ledger.md (server-level
// accounts + blind email share).
export default defineFunction({
  trigger: { type: 'auth', event: 'beforeSignUp' },
  async handler(rawContext: unknown) {
    const context = rawContext as FunctionContext;
    await assertInstanceInitialized(context);
    const settings = await getInstanceSettings(context.admin.db('app'));
    const policy = parseSignupPolicy(settings.signupPolicy, 'public');
    if (policy === 'public') return;
    // 'closed': admin.createUser bypasses beforeSignUp, so this only rejects
    // public self-registration; admin-provisioned accounts are unaffected.
    throw new Error(SIGNUP_CLOSED_MESSAGE);
  },
});
