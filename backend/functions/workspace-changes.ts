// Per-workspace change feed (local-first delta sync, roadmap §7): answers
// "what changed since <at>?" from the change_log maintained by the boundedDb
// facade. Full-workspace-access actors only (owner or active org member);
// everyone else gets a 403 and falls back to a full, visibility-filtered sync
// (no id leakage — the feed carries workspace-wide record ids).

import { defineFunction } from '@edge-base/shared';
import type { DbRef, Workspace, WorkspaceMember } from '../lib/app-types';
import { pruneChangeLog, readChangeFeed } from '../lib/change-log';
import { getExisting, listAll } from '../lib/table-utils';
import { boundedDb, type AdminDbAccessor } from '../lib/workspace-db';

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
  ownerId?: string;
}

interface OrganizationMemberRow {
  id: string;
  organizationId: string;
  userId: string;
  status?: string;
}

// Full workspace access = owner, or an active member of the workspace's
// organization. Mirrors workspace-bootstrap's hasWorkspaceAccess so both the
// bootstrap delta path and this standalone feed gate identically.
async function hasActiveWorkspaceOrgMembership(
  central: DbRef,
  workspace: Workspace,
  actorId: string,
): Promise<boolean> {
  if (workspace.ownerId === actorId) return true;
  const organizationId = workspace.organizationId;
  if (!organizationId) return true;
  const organization = await getExisting(
    central.table<OrganizationRow>('organizations'),
    organizationId,
  );
  // Fail closed on a dangling org reference. The feed returns workspace-wide
  // record ids, so it must be granted only when active org membership can be
  // positively confirmed. A missing org row makes that impossible, so refuse
  // (the caller falls back to a full, visibility-filtered sync — no id leak).
  // This intentionally diverges from workspace-bootstrap's delta gate, which
  // applies its own per-page visibility filter regardless of this decision.
  if (!organization) return false;
  if (organization.ownerId === actorId) return true;
  const orgMembers = await listAll(
    central
      .table<OrganizationMemberRow>('organization_members')
      .where('organizationId', '==', organizationId),
  );
  return orgMembers.some(
    (member) => member.userId === actorId && (member.status ?? 'active') === 'active',
  );
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
  const since = typeof body.since === 'string' && body.since.trim() ? body.since.trim() : undefined;

  const central: DbRef = admin.db('app');
  const workspace = await getExisting(central.table<Workspace>('workspaces'), workspaceId);
  if (!workspace) {
    return Response.json({ code: 404, message: 'Workspace was not found.' }, { status: 404 });
  }
  const members = await listAll(
    central.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
  );
  const isMember =
    workspace.ownerId === auth.id || members.some((member) => member.userId === auth.id);
  // Full workspace access only. The feed returns workspace-wide record ids
  // (deleted/changed pages, databases, block pages), so it is safe only for
  // actors who can already see the whole workspace. Mirror
  // workspace-bootstrap's hasWorkspaceAccess: owner, or a member with an active
  // organization membership. A bare member who is deactivated in the workspace
  // org (or an external guest, who is not a member at all) is refused and falls
  // back to a full, visibility-filtered sync — no id leakage.
  if (!isMember || !(await hasActiveWorkspaceOrgMembership(central, workspace, auth.id))) {
    return Response.json({ code: 403, message: 'Workspace access required.' }, { status: 403 });
  }

  const db = boundedDb(admin, workspaceId);
  const feed = await readChangeFeed(db, workspaceId, since);
  // Opportunistic GC; never blocks the answer.
  try {
    await pruneChangeLog(db, workspaceId);
  } catch (error) {
    console.error('[change-log] prune failed:', error);
  }
  return feed;
});
