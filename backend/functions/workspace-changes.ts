// Bounded foreground-refresh probe for the local-first workspace cache. It
// compares an opaque bootstrap token with current authority and projected
// page/change-log heads; it never returns workspace-wide record ids or prunes
// the log. Full-workspace-access actors only. Scoped actors get a 403 and fall
// back to the existing visibility-filtered bootstrap.

import { defineFunction } from '@edge-base/shared';
import type { DbRef, Workspace, WorkspaceMember } from '../lib/app-types';
import type { TableQuery } from '../lib/table-utils';
import { boundedDb, type AdminDbAccessor } from '../lib/workspace-db';
import {
  probeWorkspaceRefreshToken,
  readBoundedActorAccessAuthority,
  readBoundedInstanceSettingsAuthority,
  workspaceRefreshOrganizationAuthority,
  workspaceRefreshOrganizationMemberAuthority,
  workspaceRefreshWorkspaceAuthority,
  workspaceRefreshWorkspaceMemberAuthority,
} from '../lib/workspace-refresh-probe';

interface FunctionContext {
  auth?: { id: string; email?: string } | null;
  admin: AdminDbAccessor;
  request: Request;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

interface OrganizationRow {
  id: string;
  name?: string;
  icon?: string | null;
  ownerId?: string;
  workspaceCreationPolicy?: string;
  domainSignupPolicy?: string;
  sharingPolicy?: Record<string, unknown> | null;
  storageLimitBytes?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationMemberRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  role?: string;
  status?: string;
  externalId?: string | null;
  provisionedBy?: string | null;
  createdBy?: string | null;
  deactivatedAt?: string | null;
  deactivatedBy?: string | null;
  ssoEnforcementEpoch?: number;
  createdAt?: string;
  updatedAt?: string;
}

type ProjectableQuery<T> = TableQuery<T> & {
  where(field: string, op: string, value: unknown): TableQuery<T>;
  select(...fields: string[]): TableQuery<T>;
  includeTotal(include: boolean): TableQuery<T>;
};

function projectableQuery<T>(query: TableQuery<T>): query is ProjectableQuery<T> {
  return typeof query.where === 'function'
    && typeof query.select === 'function'
    && typeof query.includeTotal === 'function';
}

async function projectedScopedRow<T>(
  central: DbRef,
  tableName: string,
  field: string,
  value: string,
  fields: string[],
): Promise<T | null | undefined> {
  const scoped = central.table<T>(tableName).where(field, '==', value);
  if (!projectableQuery(scoped)) return undefined;
  const projected = scoped.select(...fields);
  if (typeof projected.includeTotal !== 'function') return undefined;
  const result = await projected.includeTotal(false).limit(1).getList();
  if (!Array.isArray(result.items)) return undefined;
  return result.items[0] ?? null;
}

async function targetedActorRow<T extends { userId: string }>(
  central: DbRef,
  tableName: string,
  scopeField: string,
  scopeId: string,
  actorId: string,
  fields: string[],
): Promise<T | null | undefined> {
  const scoped = central.table<T>(tableName).where(scopeField, '==', scopeId);
  // This route is only lean when the provider can execute the composite
  // predicate and projection. Never substitute an all-members materialization.
  if (!projectableQuery(scoped)) return undefined;
  const actorQuery = scoped.where('userId', '==', actorId);
  if (!projectableQuery(actorQuery)) return undefined;
  const projected = actorQuery.select('id', 'userId', ...fields);
  if (typeof projected.includeTotal !== 'function') return undefined;
  const result = await projected.includeTotal(false).limit(2).getList();
  if (!Array.isArray(result.items) || result.items.length > 1) return undefined;
  return result.items[0] ?? null;
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) {
    return Response.json({ code: 401, message: 'Authentication required.' }, { status: 401 });
  }
  const body = await requestJson(request);
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId) {
    return Response.json({ code: 400, message: 'workspaceId is required.' }, { status: 400 });
  }
  const workspaceRefreshToken = body.workspaceRefreshToken;

  const central: DbRef = admin.db('app');
  const workspace = await projectedScopedRow<Workspace>(
    central,
    'workspaces',
    'id',
    workspaceId,
    [
      'id',
      'organizationId',
      'name',
      'icon',
      'domain',
      'ownerId',
      'deletionPendingAt',
      'createdAt',
      'updatedAt',
    ],
  );
  if (workspace === undefined) {
    return { decision: 'bootstrap_required', reason: 'bounded_query_unavailable' };
  }
  if (!workspace) {
    return Response.json({ code: 404, message: 'Workspace was not found.' }, { status: 404 });
  }
  const isOwner = workspace.ownerId === auth.id;
  const targetedWorkspaceMember = await targetedActorRow<WorkspaceMember>(
    central,
    'workspace_members',
    'workspaceId',
    workspaceId,
    auth.id,
    [
      'workspaceId',
      'displayName',
      'email',
      'avatar',
      'role',
      'createdBy',
      'createdAt',
      'updatedAt',
    ],
  );
  if (targetedWorkspaceMember === undefined) {
    return { decision: 'bootstrap_required', reason: 'bounded_query_unavailable' };
  }
  if (!isOwner && targetedWorkspaceMember === null) {
    return Response.json({ code: 403, message: 'Workspace access required.' }, { status: 403 });
  }
  const currentMember = targetedWorkspaceMember;

  let organization: OrganizationRow | null = null;
  let currentOrganizationMember: OrganizationMemberRow | null = null;
  if (workspace.organizationId) {
    const projectedOrganization = await projectedScopedRow<OrganizationRow>(
      central,
      'organizations',
      'id',
      workspace.organizationId,
      [
        'id',
        'name',
        'icon',
        'ownerId',
        'workspaceCreationPolicy',
        'domainSignupPolicy',
        'sharingPolicy',
        'storageLimitBytes',
        'createdAt',
        'updatedAt',
      ],
    );
    if (projectedOrganization === undefined) {
      return { decision: 'bootstrap_required', reason: 'bounded_query_unavailable' };
    }
    organization = projectedOrganization;
    // Mirror workspace-bootstrap's current dangling-organization behavior for
    // an otherwise valid workspace member. The opaque probe exposes no ids;
    // a null organization also differs from any prior live-org token.
    if (organization) {
      const targeted = await targetedActorRow<OrganizationMemberRow>(
        central,
        'organization_members',
        'organizationId',
        organization.id,
        auth.id,
        [
          'organizationId',
          'displayName',
          'email',
          'avatar',
          'role',
          'status',
          'externalId',
          'provisionedBy',
          'createdBy',
          'deactivatedAt',
          'deactivatedBy',
          'ssoEnforcementEpoch',
          'createdAt',
          'updatedAt',
        ],
      );
      if (targeted === undefined) {
        return { decision: 'bootstrap_required', reason: 'bounded_query_unavailable' };
      }
      if (
        !isOwner
        && organization.ownerId !== auth.id
        && (targeted === null || (targeted.status ?? 'active') !== 'active')
      ) {
        return Response.json({ code: 403, message: 'Workspace access required.' }, { status: 403 });
      }
      currentOrganizationMember = targeted && (targeted.status ?? 'active') === 'active'
        ? targeted
        : null;
    }
  }

  if (!isOwner && !currentMember) {
    return Response.json({ code: 403, message: 'Workspace access required.' }, { status: 403 });
  }

  const [actorAccessAuthority, instanceSettingsAuthority] = await Promise.all([
    readBoundedActorAccessAuthority(central, {
      organizationId: workspace.organizationId ?? null,
      actorId: auth.id,
      actorEmail: auth.email ?? null,
    }),
    readBoundedInstanceSettingsAuthority(central),
  ]);
  if (!actorAccessAuthority.supported || !instanceSettingsAuthority.supported) {
    return { decision: 'bootstrap_required', reason: 'bounded_query_unavailable' };
  }
  const [
    workspaceAuthority,
    organizationAuthority,
    workspaceMemberAuthority,
    organizationMemberAuthority,
  ] = await Promise.all([
    workspaceRefreshWorkspaceAuthority(workspace),
    workspaceRefreshOrganizationAuthority(
      organization && (organization.ownerId === auth.id || currentOrganizationMember)
        ? organization
        : null,
    ),
    workspaceRefreshWorkspaceMemberAuthority(currentMember),
    workspaceRefreshOrganizationMemberAuthority(currentOrganizationMember),
  ]);

  const db = boundedDb(admin, workspaceId);
  return probeWorkspaceRefreshToken(db, {
    workspaceId,
    actorId: auth.id,
    ambiguous: actorAccessAuthority.ambiguous || instanceSettingsAuthority.ambiguous,
    authority: {
      workspace: workspaceAuthority,
      organization: organizationAuthority,
      workspaceMember: workspaceMemberAuthority,
      organizationMember: organizationMemberAuthority,
      actorAccess: actorAccessAuthority.authority,
      instanceSettings: instanceSettingsAuthority.authority,
    },
  }, workspaceRefreshToken);
});
