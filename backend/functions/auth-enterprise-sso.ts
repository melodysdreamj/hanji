import { defineFunction } from '@edge-base/shared';
import {
  listAll,
  getExisting,
  nowIso,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
}

interface DbRef {
  table<T>(name: string): TableRef<T>;
  transact(operations: TransactOperation[]): Promise<unknown>;
}

interface Organization {
  id: string;
  ssoEnforcementEpoch?: number | null;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  email?: string | null;
  role?: string | null;
  status?: string | null;
  ssoEnforcementEpoch?: number | null;
}

interface OrganizationDomain {
  id: string;
  organizationId: string;
  domain: string;
  status?: string | null;
}

interface OrganizationEnterpriseControls {
  id: string;
  organizationId: string;
  ssoConfig?: Record<string, unknown> | null;
}

interface OrganizationAuditEvent {
  id: string;
  organizationId: string;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

interface FunctionContext {
  data?: {
    after?: Record<string, unknown>;
    authMethod?: unknown;
    authProvider?: unknown;
  };
  admin: {
    db(namespace: string): DbRef;
    auth?: {
      revokeAllSessions(userId: string): Promise<void>;
    };
  };
}

const SSO_REQUIRED_MESSAGE =
  'Your organization requires single sign-on. Continue with the organization SSO provider.';

function normalizedEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function emailDomain(email: string | null) {
  if (!email) return null;
  return email.slice(email.lastIndexOf('@') + 1) || null;
}

function configuredProvider(ssoConfig: Record<string, unknown>) {
  if (ssoConfig.providerType !== 'oidc') return null;
  const provider = typeof ssoConfig.providerName === 'string'
    ? ssoConfig.providerName.trim()
    : 'oidc:enterprise';
  return /^oidc:[A-Za-z0-9._-]+$/.test(provider) ? provider : null;
}

function epoch(value: unknown, field: string) {
  if (value === null || value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} is malformed.`);
  }
  return Number(value);
}

async function advanceMemberSsoEpoch(
  context: FunctionContext,
  db: DbRef,
  member: OrganizationMember,
) {
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    member.organizationId,
  );
  if (!organization) throw new Error('Organization was not found during SSO authorization.');
  const desiredEpoch = epoch(
    organization.ssoEnforcementEpoch,
    'Organization SSO enforcement epoch',
  );
  if (desiredEpoch <= 0) {
    throw new Error('Required organization SSO is not fully activated.');
  }
  if (
    epoch(member.ssoEnforcementEpoch, 'Organization member SSO enforcement epoch')
      === desiredEpoch
  ) return;
  if (!context.admin.auth?.revokeAllSessions) {
    throw new Error('Session revocation is required before authorizing this organization SSO epoch.');
  }
  // A user can already have a password session before SCIM or an admin adds
  // them to an SSO-enforced organization. Revoke that old session first; only
  // then stamp the membership so organization endpoints may authorize the new
  // SSO session. A failed/held provider therefore never advances authority.
  await context.admin.auth.revokeAllSessions(member.userId);
  const now = nowIso();
  await db.transact([
    {
      table: 'organization_members',
      op: 'expect',
      id: member.id,
      where: [
        ['organizationId', '==', member.organizationId],
        ['userId', '==', member.userId],
        ['role', '==', member.role ?? null],
        ['status', '==', member.status ?? null],
        ['ssoEnforcementEpoch', '==', member.ssoEnforcementEpoch ?? null],
      ],
      exists: true,
    },
    {
      table: 'organization_members',
      op: 'update',
      id: member.id,
      data: { ssoEnforcementEpoch: desiredEpoch, updatedAt: now },
    },
  ]);
}

async function verifiedDomainApplies(
  db: DbRef,
  organizationId: string,
  email: string | null,
) {
  const domain = emailDomain(email);
  if (!domain) return false;
  const domains = await listAll(
    db.table<OrganizationDomain>('organization_domains').where(
      'organizationId',
      '==',
      organizationId,
    ),
  );
  return domains.some(
    (entry) => (entry.status ?? 'pending') === 'verified' && entry.domain === domain,
  );
}

async function auditRejectedSignIn(
  db: DbRef,
  member: OrganizationMember,
  authMethod: string | null,
  authProvider: string | null,
) {
  await db.table<OrganizationAuditEvent>('organization_audit_events').insert({
    organizationId: member.organizationId,
    actorId: member.userId,
    action: 'organization_sso.sign_in_rejected',
    targetType: 'organization_member',
    targetId: member.id,
    metadata: {
      authMethod: authMethod ?? 'unknown',
      authProvider: authProvider ?? null,
    },
    occurredAt: nowIso(),
  });
}

export async function enforceEnterpriseSso(rawContext: unknown) {
    const context = rawContext as FunctionContext;
    const user = context.data?.after ?? {};
    const userId = typeof user.id === 'string' ? user.id : null;
    if (!userId) return;

    const db = context.admin.db('app');
    const memberships = await listAll(
      db.table<OrganizationMember>('organization_members').where('userId', '==', userId),
    );
    const activeMemberships = memberships.filter(
      (member) => (member.status ?? 'active') === 'active' && member.role !== 'guest',
    );
    if (!activeMemberships.length) return;

    const authMethod = typeof context.data?.authMethod === 'string'
      ? context.data.authMethod
      : null;
    const authProvider = typeof context.data?.authProvider === 'string'
      ? context.data.authProvider
      : null;
    const userEmail = normalizedEmail(user.email);

    for (const member of activeMemberships) {
      const controls = await listAll(
        db.table<OrganizationEnterpriseControls>('organization_enterprise_controls').where(
          'organizationId',
          '==',
          member.organizationId,
        ),
      );
      const config = controls[0]?.ssoConfig;
      if (!config || config.enabled !== true) continue;
      const provider = configuredProvider(config);
      if (!provider) continue;

      const enforcement = typeof config.enforcement === 'string'
        ? config.enforcement
        : 'optional';
      const applies = enforcement === 'required_for_all_members'
        || (enforcement === 'required_for_verified_domains'
          && await verifiedDomainApplies(
            db,
            member.organizationId,
            userEmail ?? normalizedEmail(member.email),
          ));
      if (!applies) continue;
      if (authMethod === 'oauth' && authProvider === provider) {
        await advanceMemberSsoEpoch(context, db, member);
        continue;
      }

      await auditRejectedSignIn(db, member, authMethod, authProvider);
      throw new Error(SSO_REQUIRED_MESSAGE);
    }
}

export default defineFunction({
  trigger: { type: 'auth', event: 'beforeSignIn' },
  handler: enforceEnterpriseSso,
});
