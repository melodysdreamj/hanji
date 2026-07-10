import { assertNotDeactivatedWorkspaceAccess } from './org-access';

import { listAll, getExisting, narrowWhere, type TableQuery } from './table-utils';

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
}

export type ShareRole = 'view' | 'comment' | 'edit' | 'full_access';

export interface PageLike {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: 'workspace' | 'page' | 'database' | string;
  createdBy?: string | null;
}

export interface WorkspaceLike {
  id: string;
  ownerId?: string | null;
  organizationId?: string | null;
}

export interface WorkspaceMemberLike {
  id: string;
  workspaceId: string;
  userId: string;
  role?: string | null;
}

export interface PagePermissionLike {
  id: string;
  pageId: string;
  workspaceId: string;
  principalType: string;
  principalId?: string | null;
  label?: string | null;
  role?: ShareRole | string | null;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  status?: string | null;
}

interface OrganizationGroupMember {
  id: string;
  organizationId: string;
  groupId: string;
  organizationMemberId: string;
  userId: string;
}

export const pageAccessRoleRanks: Record<ShareRole, number> = {
  view: 1,
  comment: 2,
  edit: 3,
  full_access: 4,
};

export function isPageShareRole(value: unknown): value is ShareRole {
  return value === 'view' || value === 'comment' || value === 'edit' || value === 'full_access';
}

export function maxPageShareRole(a: ShareRole | undefined, b: ShareRole | undefined): ShareRole | undefined {
  if (!a) return b;
  if (!b) return a;
  return pageAccessRoleRanks[a] >= pageAccessRoleRanks[b] ? a : b;
}

export function workspaceMemberShareRole(role: string | null | undefined): ShareRole | undefined {
  if (role === 'owner' || role === 'admin') return 'full_access';
  if (role === 'member') return 'edit';
  if (role === 'guest') return 'view';
  return undefined;
}

export function normalizeAccessEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function activeOrganizationMemberForUser(db: DbRef, organizationId: string, actorId: string) {
  const members = await listAll(
    narrowWhere(
      db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
      'userId',
      actorId,
    ),
  );
  return members.find(
    (member) => member.userId === actorId && (member.status ?? 'active') === 'active',
  ) ?? null;
}

export async function actorGroupIdsForOrganization(
  db: DbRef,
  organizationId: string | null | undefined,
  actorId: string,
) {
  if (!organizationId) return new Set<string>();
  const organizationMember = await activeOrganizationMemberForUser(db, organizationId, actorId);
  if (!organizationMember) return new Set<string>();
  const groupMembers = await listAll(
    db.table<OrganizationGroupMember>('organization_group_members').where('userId', '==', actorId),
  );
  return new Set(
    groupMembers
      .filter(
        (member) =>
          member.organizationId === organizationId &&
          member.organizationMemberId === organizationMember.id,
      )
      .map((member) => member.groupId),
  );
}

export async function actorGroupIdsForWorkspace(db: DbRef, workspaceId: string | null | undefined, actorId: string) {
  if (!workspaceId) return new Set<string>();
  const workspace = await getExisting(db.table<WorkspaceLike>('workspaces'), workspaceId);
  return actorGroupIdsForOrganization(db, workspace?.organizationId, actorId);
}

export function permissionAppliesToActor(
  permission: PagePermissionLike,
  actorId: string,
  groupIds: Set<string>,
  actorEmail?: string | null,
) {
  if (permission.principalType === 'user' && permission.principalId === actorId) return true;
  if (permission.principalType === 'integration' && permission.principalId === actorId) return true;
  if (permission.principalType === 'group' && permission.principalId) {
    return groupIds.has(permission.principalId);
  }
  const email = normalizeAccessEmail(actorEmail);
  if (permission.principalType === 'email' && email) {
    const permissionEmail = normalizeAccessEmail(permission.principalId || permission.label);
    return permissionEmail === email;
  }
  return false;
}

export function permissionRoleForActor(
  permissions: PagePermissionLike[],
  actorId: string,
  groupIds: Set<string>,
  actorEmail?: string | null,
) {
  let role: ShareRole | undefined;
  for (const permission of permissions) {
    if (!permissionAppliesToActor(permission, actorId, groupIds, actorEmail)) continue;
    if (isPageShareRole(permission.role)) role = maxPageShareRole(role, permission.role);
  }
  return role;
}

export async function directPagePermissionRole(
  db: DbRef,
  pageId: string,
  actorId: string,
  workspaceId?: string | null,
  actorEmail?: string | null,
) {
  let resolvedWorkspaceId = workspaceId;
  if (!resolvedWorkspaceId) {
    const page = await getExisting(db.table<PageLike>('pages'), pageId);
    resolvedWorkspaceId = page?.workspaceId;
  }
  const [permissions, groupIds] = await Promise.all([
    listAll(db.table<PagePermissionLike>('page_permissions').where('pageId', '==', pageId)),
    actorGroupIdsForWorkspace(db, resolvedWorkspaceId, actorId),
  ]);
  return permissionRoleForActor(permissions, actorId, groupIds, actorEmail);
}

export async function actorPagePermissions(
  db: DbRef,
  actorId: string,
  workspaceId?: string | null,
  actorEmail?: string | null,
) {
  const out = new Map<string, PagePermissionLike>();
  const userPermissions = await listAll(
    db.table<PagePermissionLike>('page_permissions').where('principalId', '==', actorId),
  );
  for (const permission of userPermissions) {
    if (permission.principalType !== 'user' && permission.principalType !== 'integration') continue;
    if (workspaceId && permission.workspaceId !== workspaceId) continue;
    if (isPageShareRole(permission.role)) out.set(permission.id, permission);
  }

  const groupMemberships = await listAll(
    db.table<OrganizationGroupMember>('organization_group_members').where('userId', '==', actorId),
  );
  const groupPermissionGroups = await Promise.all(
    groupMemberships.map((membership) =>
      listAll(db.table<PagePermissionLike>('page_permissions').where('principalId', '==', membership.groupId))
    ),
  );
  for (const groupPermissions of groupPermissionGroups) {
    for (const permission of groupPermissions) {
      if (permission.principalType !== 'group') continue;
      if (workspaceId && permission.workspaceId !== workspaceId) continue;
      if (isPageShareRole(permission.role)) out.set(permission.id, permission);
    }
  }
  const email = normalizeAccessEmail(actorEmail);
  if (email) {
    const emailPermissions = await listAll(
      db.table<PagePermissionLike>('page_permissions').where('principalId', '==', email),
    );
    for (const permission of emailPermissions) {
      if (permission.principalType !== 'email') continue;
      if (workspaceId && permission.workspaceId !== workspaceId) continue;
      if (isPageShareRole(permission.role)) out.set(permission.id, permission);
    }
  }
  return Array.from(out.values());
}

// A page creator keeps creator-derived rights only while they remain an active
// member of the workspace. Removed members (no workspace_members row and not
// the owner) and deactivated org members lose the creator shortcut, so a
// remembered pageId can never resurrect edit/manage access on a page they once
// created. The workspace owner is inherently an active member.
async function actorIsActiveWorkspaceMember(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  workspace?: WorkspaceLike | null,
): Promise<boolean> {
  try {
    await assertNotDeactivatedWorkspaceAccess(db, workspaceId, actorId);
  } catch {
    return false;
  }
  const resolvedWorkspace =
    workspace ?? (await getExisting(db.table<WorkspaceLike>('workspaces'), workspaceId));
  if (resolvedWorkspace?.ownerId === actorId) return true;
  return (await workspaceMemberRoleForActor(db, workspaceId, actorId)) !== undefined;
}

export async function pageHasDirectAccess(
  db: DbRef,
  page: PageLike,
  actorId: string,
  actorEmail?: string | null,
) {
  if (page.createdBy === actorId && (await actorIsActiveWorkspaceMember(db, page.workspaceId, actorId))) {
    return true;
  }

  const pages = db.table<PageLike>('pages');
  const groupIds = await actorGroupIdsForWorkspace(db, page.workspaceId, actorId);
  const visited = new Set<string>();
  let current: PageLike | null = page;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const permissions = await listAll(
      db.table<PagePermissionLike>('page_permissions').where('pageId', '==', current.id),
    );
    if (permissionRoleForActor(permissions, actorId, groupIds, actorEmail)) return true;
    if (!current.parentId || current.parentType === 'workspace') break;
    current = await getExisting(pages, current.parentId);
  }

  return false;
}

export interface PageAccessOptions {
  // Mutation paths that need the workspace row treat a missing workspace
  // record as an error ("Workspace was not found." → 404) instead of
  // silently computing "no access" from an absent owner/member list.
  requireWorkspace?: boolean;
}

async function workspaceMemberRoleForActor(db: DbRef, workspaceId: string, actorId: string) {
  const members = await listAll(
    narrowWhere(
      db.table<WorkspaceMemberLike>('workspace_members').where('workspaceId', '==', workspaceId),
      'userId',
      actorId,
    ),
  );
  return workspaceMemberShareRole(members.find((member) => member.userId === actorId)?.role);
}

// Workspace-level role only (owner shortcut + workspace membership), without
// the page-permission walk. The canonical body behind the per-function
// `workspaceRole` helpers.
export async function workspaceAccessRole(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  options?: PageAccessOptions,
): Promise<ShareRole | undefined> {
  const workspace = await getExisting(db.table<WorkspaceLike>('workspaces'), workspaceId);
  if (!workspace && options?.requireWorkspace) throw new Error('Workspace was not found.');
  await assertNotDeactivatedWorkspaceAccess(db, workspaceId, actorId);
  if (workspace?.ownerId === actorId) return 'full_access';
  return workspaceMemberRoleForActor(db, workspaceId, actorId);
}

export async function pageAccessRole(
  db: DbRef,
  page: PageLike,
  actorId: string,
  workspace?: WorkspaceLike | null,
  actorEmail?: string | null,
  options?: PageAccessOptions,
) {
  const resolvedWorkspace = workspace ?? (await getExisting(db.table<WorkspaceLike>('workspaces'), page.workspaceId));
  if (!resolvedWorkspace && options?.requireWorkspace) throw new Error('Workspace was not found.');
  await assertNotDeactivatedWorkspaceAccess(db, page.workspaceId, actorId);

  let role: ShareRole | undefined;
  const isOwner = resolvedWorkspace?.ownerId === actorId;
  if (isOwner) {
    role = 'full_access';
  }
  const memberRole = await workspaceMemberRoleForActor(db, page.workspaceId, actorId);
  role = maxPageShareRole(role, memberRole);
  // Creator shortcut applies only while the creator is still an active member
  // (owner or a current workspace_members row). A removed member keeps no
  // creator-derived edit right on pages they once created. (Deactivated org
  // members already threw above via assertNotDeactivatedWorkspaceAccess.)
  if (page.createdBy === actorId && (isOwner || memberRole !== undefined)) {
    role = maxPageShareRole(role, 'edit');
  }

  const pages = db.table<PageLike>('pages');
  const groupIds = await actorGroupIdsForWorkspace(db, page.workspaceId, actorId);
  const visited = new Set<string>();
  let current: PageLike | null = page;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const permissions = await listAll(
      db.table<PagePermissionLike>('page_permissions').where('pageId', '==', current.id),
    );
    role = maxPageShareRole(role, permissionRoleForActor(permissions, actorId, groupIds, actorEmail));
    if (!current.parentId || current.parentType === 'workspace') break;
    current = await getExisting(pages, current.parentId);
  }

  return role;
}

// Role at or above `minimum` or throws the canonical "Page access required."
// (mapped to 403 by lib/error-status). The canonical body behind the
// per-function `assertCanEditPage`-style helpers.
export async function assertMinimumPageAccessRole(
  db: DbRef,
  page: PageLike,
  actorId: string,
  minimum: ShareRole,
  actorEmail?: string | null,
  options?: PageAccessOptions,
) {
  const role = await pageAccessRole(db, page, actorId, undefined, actorEmail, options);
  if (role && pageAccessRoleRanks[role] >= pageAccessRoleRanks[minimum]) return role;
  throw new Error('Page access required.');
}

export async function canManagePageAccess(
  db: DbRef,
  page: PageLike,
  workspace: WorkspaceLike,
  actorId: string,
  actorEmail?: string | null,
) {
  await assertNotDeactivatedWorkspaceAccess(db, page.workspaceId, actorId);
  const members = await listAll(
    narrowWhere(
      db.table<WorkspaceMemberLike>('workspace_members').where('workspaceId', '==', page.workspaceId),
      'userId',
      actorId,
    ),
  );
  const membership = members.find((member) => member.userId === actorId) ?? null;
  // Owner can always manage. The creator shortcut is gated on the actor still
  // being an active member: a removed creator must not retain share-management
  // rights on a page they once created.
  if (workspace.ownerId === actorId || (page.createdBy === actorId && !!membership)) return true;
  const memberRole = membership?.role;
  if (memberRole === 'owner' || memberRole === 'admin') return true;
  return (await pageAccessRole(db, page, actorId, workspace, actorEmail)) === 'full_access';
}
