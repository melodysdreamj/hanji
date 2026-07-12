import { defineFunction } from '@edge-base/shared';

import { listAll, type TableQuery } from '../lib/table-utils';
interface Organization {
  id: string;
  ownerId?: string | null;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  email?: string | null;
  status?: string | null;
}

interface Workspace {
  id: string;
  organizationId?: string | null;
}

interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  status?: string | null;
}

interface OrganizationAuditEvent {
  id: string;
  organizationId: string;
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef {
  table<T>(name: string): TableRef<T>;
}

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  admin: {
    db(namespace: string): DbRef;
  };
}

type AuthAuditMethod =
  | 'email_otp'
  | 'magic_link'
  | 'password_signin'
  | 'password_signup'
  | 'passkey_signin'
  | 'oauth_signin'
  | 'mfa_totp'
  | 'mfa_recovery'
  | 'anonymous_bootstrap';
type AuthAuditPhase = 'request' | 'verify';
type AuthAuditOutcome = 'success' | 'failure';

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

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toLowerCase();
}

function parseMethod(value: unknown): AuthAuditMethod {
  if (
    value === 'email_otp' ||
    value === 'magic_link' ||
    value === 'password_signin' ||
    value === 'password_signup' ||
    value === 'passkey_signin' ||
    value === 'oauth_signin' ||
    value === 'mfa_totp' ||
    value === 'mfa_recovery' ||
    value === 'anonymous_bootstrap'
  ) {
    return value;
  }
  throw new Error('method is invalid.');
}

function parsePhase(value: unknown): AuthAuditPhase {
  if (value === 'request' || value === 'verify') return value;
  throw new Error('phase is invalid.');
}

function parseOutcome(value: unknown): AuthAuditOutcome {
  if (value === 'success' || value === 'failure') return value;
  throw new Error('outcome is invalid.');
}

function optionalString(value: unknown, name: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null.`);
  // Neutralize control chars (incl. newlines/tabs) so attacker-controlled free
  // text can't forge extra lines if this metadata is later rendered as text.
  const trimmed = value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return trimmed.length ? trimmed.slice(0, 240) : null;
}

async function organizationIdsForAuthAttempt(
  db: DbRef,
  actorId: string | null,
  email: string | null,
) {
  const organizationIds = new Set<string>();
  const organizations = db.table<Organization>('organizations');
  const organizationMembers = db.table<OrganizationMember>('organization_members');
  const workspaces = db.table<Workspace>('workspaces');
  const invitations = db.table<WorkspaceInvitation>('workspace_invitations');

  if (actorId) {
    for (const organization of await listAll(organizations.where('ownerId', '==', actorId))) {
      organizationIds.add(organization.id);
    }
    for (const member of await listAll(organizationMembers.where('userId', '==', actorId))) {
      organizationIds.add(member.organizationId);
    }
  }

  if (email) {
    for (const member of await listAll(organizationMembers.where('email', '==', email))) {
      organizationIds.add(member.organizationId);
    }
    const matchingInvitations = await listAll(invitations.where('email', '==', email));
    for (const invitation of matchingInvitations) {
      if ((invitation.status ?? 'pending') !== 'pending') continue;
      const workspace = await workspaces.getOne(invitation.workspaceId).catch(() => null);
      if (workspace?.organizationId) organizationIds.add(workspace.organizationId);
    }
  }

  return Array.from(organizationIds);
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : 'record';
  if (action !== 'record') return jsonError(400, 'Unknown action.');

  try {
    const db = admin.db('app');
    const method = parseMethod(body.method);
    const phase = parsePhase(body.phase);
    const outcome = parseOutcome(body.outcome);
    const email = normalizeEmail(body.email) ?? normalizeEmail(auth?.email);
    const reason = optionalString(body.reason, 'reason');
    const occurredAt = new Date().toISOString();
    const organizationIds = await organizationIdsForAuthAttempt(db, auth?.id ?? null, email);
    const userAgent = request?.headers.get('user-agent')?.slice(0, 240) ?? null;

    // An unauthenticated caller must not be able to forge 'success' events for
    // an organization resolved purely from an attacker-supplied email. The only
    // legitimate pre-auth path (AuthGate) records FAILUREs, so reject
    // unauthenticated 'success' writes while preserving that failure path and
    // full behavior for authenticated callers.
    const mayRecord = Boolean(auth?.id) || outcome !== 'success';

    for (const organizationId of mayRecord ? organizationIds : []) {
      await db.table<OrganizationAuditEvent>('organization_audit_events').insert({
        organizationId,
        workspaceId: null,
        actorId: auth?.id ?? null,
        action: 'auth.login_attempt',
        targetType: 'auth',
        targetId: auth?.id ?? email ?? null,
        metadata: {
          method,
          phase,
          outcome,
          email,
          reason,
          userAgent,
        },
        occurredAt,
      });
    }

    // The matched-organization count reveals whether an email belongs to this
    // instance. Never disclose it to an unauthenticated caller — that turns this
    // login-attempt recorder into an account-enumeration oracle. Events are
    // still written; only the numeric response is withheld.
    if (!auth?.id) return { recorded: true };
    return { recorded: organizationIds.length };
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : 'Auth audit failed.');
  }
});
