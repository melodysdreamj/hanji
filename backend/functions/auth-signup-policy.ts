import { defineFunction } from '@edge-base/shared';
import {
  getInstanceSettings,
  parseSignupPolicy,
  type SignupPolicy,
} from '../lib/instance-settings';

import { type TableQuery, type ListResult } from '../lib/table-utils';
interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  getList(): Promise<ListResult<T>>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef {
  table<T>(name: string): TableRef<T>;
}

interface Organization {
  id: string;
}

interface OrganizationDomain {
  id: string;
  domain: string;
  status?: string;
}

interface WorkspaceInvitation {
  id: string;
  email: string;
  status?: string;
  expiresAt?: string | null;
}

interface FunctionContext {
  data?: {
    after?: Record<string, unknown>;
  };
  admin: {
    db(namespace: string): DbRef;
  };
}

async function listAll<T>(query: TableQuery<T>, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await query.page(page).limit(1000).getList();
    const items = res.items ?? [];
    out.push(...items);
    if (!res.hasMore || items.length === 0) break;
  }
  return out;
}

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function emailDomain(email: string) {
  return email.split('@').pop()?.trim().toLowerCase() ?? '';
}

function inviteIsPending(invitation: WorkspaceInvitation) {
  if ((invitation.status ?? 'pending') !== 'pending') return false;
  if (!invitation.expiresAt) return true;
  const expiry = Date.parse(invitation.expiresAt);
  return Number.isNaN(expiry) || expiry > Date.now();
}

async function hasAnyOrganization(db: DbRef) {
  const organizations = await db.table<Organization>('organizations').getList();
  return (organizations.items ?? []).length > 0;
}

async function hasPendingInvitation(db: DbRef, email: string) {
  const invitations = await listAll(
    db.table<WorkspaceInvitation>('workspace_invitations').where('email', '==', email),
    5,
  );
  return invitations.some(inviteIsPending);
}

async function matchesVerifiedDomain(db: DbRef, email: string) {
  const domain = emailDomain(email);
  if (!domain) return false;
  const domains = await listAll(
    db.table<OrganizationDomain>('organization_domains').where('domain', '==', domain),
    5,
  );
  return domains.some((item) => (item.status ?? 'pending') === 'verified');
}

function rejectionMessage(policy: SignupPolicy) {
  if (policy === 'invite_only') {
    return 'Signup is restricted to invited email addresses.';
  }
  return 'Signup requires an invitation or a verified organization email domain.';
}

export default defineFunction({
  trigger: { type: 'auth', event: 'beforeSignUp' },
  async handler(rawContext: unknown) {
    const context = rawContext as FunctionContext;
    const db = context.admin.db('app');
    const settings = await getInstanceSettings(db);
    const policy = parseSignupPolicy(settings.signupPolicy, 'public');
    if (policy === 'public') return;

    if (!(await hasAnyOrganization(db))) return;

    const email = normalizeEmail(context.data?.after?.email);
    if (!email) {
      throw new Error(rejectionMessage(policy));
    }

    if (await hasPendingInvitation(db, email)) return;
    if (policy === 'verified_domains' && await matchesVerifiedDomain(db, email)) return;

    throw new Error(rejectionMessage(policy));
  },
});
