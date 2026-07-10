import type { Page, ShareRole, Workspace, WorkspaceMember } from "./types";

const SHARE_ROLE_RANKS: Record<ShareRole, number> = {
  view: 1,
  comment: 2,
  edit: 3,
  full_access: 4,
};

export function maxShareRole(
  a: ShareRole | undefined,
  b: ShareRole | undefined
): ShareRole | undefined {
  if (!a) return b;
  if (!b) return a;
  return SHARE_ROLE_RANKS[a] >= SHARE_ROLE_RANKS[b] ? a : b;
}

export function workspaceMemberShareRole({
  workspace,
  currentMember,
  userId,
}: {
  workspace?: Workspace;
  currentMember?: WorkspaceMember;
  userId?: string;
}): ShareRole | undefined {
  if (!workspace) return undefined;
  // Missing ownership metadata is not proof that the current actor owns the
  // workspace. Public snapshots and old imports can be ownerless; granting
  // full access in that state turns an incomplete payload into edit authority.
  if (workspace.ownerId && workspace.ownerId === userId) return "full_access";
  if (currentMember?.workspaceId !== workspace.id) return undefined;
  if (currentMember?.role === "owner" || currentMember?.role === "admin") return "full_access";
  if (currentMember?.role === "member") return "edit";
  if (currentMember?.role === "guest") return "view";
  return undefined;
}

export function effectivePageRole({
  page,
  pagesById,
  pageRoles,
  workspace,
  currentMember,
  userId,
}: {
  page?: Page;
  pagesById?: Record<string, Page>;
  pageRoles?: Record<string, ShareRole>;
  workspace?: Workspace;
  currentMember?: WorkspaceMember;
  userId?: string;
}): ShareRole | undefined {
  if (!page) return undefined;
  let role: ShareRole | undefined;
  const workspaceMatchesPage = !!workspace && workspace.id === page.workspaceId;
  if (workspaceMatchesPage) {
    role = maxShareRole(role, workspaceMemberShareRole({ workspace, currentMember, userId }));
  }
  // A page creator remains editable during the short pre-bootstrap/local test
  // state where no workspace object exists. Once a workspace is mounted, the
  // ids must match so a public/foreign page cannot borrow that authority.
  if ((!workspace || workspaceMatchesPage) && page.createdBy && page.createdBy === userId) {
    role = maxShareRole(role, "edit");
  }

  const visited = new Set<string>();
  let current: Page | undefined = page;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    // Never inherit a role through a malformed cross-workspace parent chain.
    if (current.workspaceId !== page.workspaceId) break;
    role = maxShareRole(role, pageRoles?.[current.id]);
    if (!current.parentId || current.parentType === "workspace") break;
    current = pagesById?.[current.parentId];
  }
  return role;
}

export function shareRoleCanEdit(role: ShareRole | undefined) {
  return !!role && SHARE_ROLE_RANKS[role] >= SHARE_ROLE_RANKS.edit;
}

// The backend accepts comment mutations from anyone with at least comment-level
// access (comment, edit, full_access); a plain `view` role is rejected. Mirror
// that rank here so the UI only offers commenting when the server will accept
// it — avoids the optimistic-then-403 flicker for view-only users.
export function shareRoleCanComment(role: ShareRole | undefined) {
  return !!role && SHARE_ROLE_RANKS[role] >= SHARE_ROLE_RANKS.comment;
}

export function canEditPage(input: Parameters<typeof effectivePageRole>[0]) {
  return shareRoleCanEdit(effectivePageRole(input));
}

export function canCommentPage(input: Parameters<typeof effectivePageRole>[0]) {
  return shareRoleCanComment(effectivePageRole(input));
}

export function canCreateWorkspacePage(input: {
  workspace?: Workspace;
  currentMember?: WorkspaceMember;
  userId?: string;
}) {
  return shareRoleCanEdit(workspaceMemberShareRole(input));
}
