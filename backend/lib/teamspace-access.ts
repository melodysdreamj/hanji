import type { DbRef, ShareRole } from './page-access';
import {
  getExisting,
  listAll,
  narrowWhere,
  projectFields,
} from './table-utils';

export type TeamspaceAccess = 'open' | 'closed' | 'private';
export type TeamspaceMemberRole = 'owner' | 'member';

export interface TeamspaceLike {
  id: string;
  workspaceId: string;
  name?: string;
  icon?: string | null;
  description?: string | null;
  access?: string | null;
  memberPageRole?: string | null;
  openPageRole?: string | null;
  membersCanInvite?: boolean | null;
  membersCanEditSidebar?: boolean | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  writeToken?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TeamspaceMemberLike {
  id: string;
  workspaceId: string;
  teamspaceId: string;
  principalType: string;
  principalId: string;
  workspaceMemberId?: string | null;
  role?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TeamspaceSettingsLike {
  id: string;
  workspaceId: string;
  defaultTeamspaceId?: string | null;
  ownersOnlyCreate?: boolean | null;
  lifecycleToken?: string | null;
  updatedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TeamspaceActorAuthority {
  actorId: string;
  workspaceMemberId?: string | null;
  workspaceMemberRole?: string | null;
  groupIds: Set<string>;
}

export interface TeamspaceAccessDecision {
  teamspace: TeamspaceLike | null;
  settings: TeamspaceSettingsLike | null;
  explicitMembership: TeamspaceMemberLike | null;
  membershipRole: TeamspaceMemberRole | undefined;
  membershipSource: 'explicit' | 'default' | undefined;
  pageRole: ShareRole | undefined;
  joined: boolean;
  visible: boolean;
  canJoin: boolean;
  canRequest: boolean;
}

const TEAMSPACE_ACTOR_GROUP_LIMIT = 100;
const TEAMSPACE_MEMBER_ACCESS_FIELDS = [
  'id',
  'workspaceId',
  'teamspaceId',
  'principalType',
  'principalId',
  'workspaceMemberId',
  'role',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;
export function isTeamspaceAccess(value: unknown): value is TeamspaceAccess {
  return value === 'open' || value === 'closed' || value === 'private';
}

export function isTeamspaceMemberRole(value: unknown): value is TeamspaceMemberRole {
  return value === 'owner' || value === 'member';
}

export function isTeamspacePageRole(value: unknown): value is ShareRole {
  return value === 'view' || value === 'comment' || value === 'edit' || value === 'full_access';
}

export function workspaceRoleCanUseTeamspaces(role: string | null | undefined) {
  return role === 'owner' || role === 'admin' || role === 'member';
}

async function actorMembershipsForTeamspace(
  db: DbRef,
  teamspaceId: string,
  actorId: string,
  groupIds: Set<string>,
) {
  // An incomplete group set can only remove authority. Preserve the exact user
  // lookup and ignore group rows rather than granting from a truncated prefix.
  const groupKeys = groupIds.size <= TEAMSPACE_ACTOR_GROUP_LIMIT
    ? Array.from(groupIds)
    : [];
  const principalIds = [actorId, ...groupKeys];
  const principalIdSet = new Set(principalIds);
  const memberships = await listAll(
    projectFields(
      narrowWhere(
        db.table<TeamspaceMemberLike>('teamspace_members').where('principalId', 'in', principalIds),
        'teamspaceId',
        teamspaceId,
      ),
      TEAMSPACE_MEMBER_ACCESS_FIELDS,
    ),
    { label: 'Teamspace actor memberships' },
  );
  return memberships.filter((membership) => (
    membership.teamspaceId === teamspaceId
    && principalIdSet.has(membership.principalId)
  ));
}

export async function teamspaceAccessDecision(
  db: DbRef,
  teamspaceId: string,
  authority: TeamspaceActorAuthority,
): Promise<TeamspaceAccessDecision> {
  const [teamspace, memberships] = await Promise.all([
    getExisting(db.table<TeamspaceLike>('teamspaces'), teamspaceId),
    actorMembershipsForTeamspace(db, teamspaceId, authority.actorId, authority.groupIds),
  ]);

  if (!teamspace) {
    return {
      teamspace: null,
      settings: null,
      explicitMembership: null,
      membershipRole: undefined,
      membershipSource: undefined,
      pageRole: undefined,
      joined: false,
      visible: false,
      canJoin: false,
      canRequest: false,
    };
  }

  // The deterministic settings point key is the workspace id. Resolve it here
  // after the exact Teamspace point read supplies that id.
  const exactSettings = await getExisting(
    db.table<TeamspaceSettingsLike>('teamspace_settings'),
    teamspace.workspaceId,
  );
  const activeWorkspaceMember = workspaceRoleCanUseTeamspaces(authority.workspaceMemberRole)
    && !!authority.workspaceMemberId;
  const matchingMemberships = memberships.filter((membership) => {
    if (!isTeamspaceMemberRole(membership.role)) return false;
    if (membership.principalType === 'user') {
      return membership.principalId === authority.actorId
        && !!authority.workspaceMemberId
        && membership.workspaceMemberId === authority.workspaceMemberId;
    }
    return membership.principalType === 'group'
      && activeWorkspaceMember
      && authority.groupIds.has(membership.principalId);
  });
  // A user can be present directly and through multiple groups. Authority is
  // the strongest applicable role, independent of provider row order.
  const explicitMembership = matchingMemberships.find((membership) => membership.role === 'owner')
    ?? matchingMemberships.find((membership) => membership.role === 'member')
    ?? null;
  const explicitRole = isTeamspaceMemberRole(explicitMembership?.role)
    ? explicitMembership.role
    : undefined;
  const defaultMembership = activeWorkspaceMember
    && exactSettings?.defaultTeamspaceId === teamspace.id;
  const membershipRole = explicitRole ?? (defaultMembership ? 'member' : undefined);
  const membershipSource = explicitRole
    ? 'explicit'
    : defaultMembership
      ? 'default'
      : undefined;
  const joined = membershipRole !== undefined;
  const access = isTeamspaceAccess(teamspace.access) ? teamspace.access : 'closed';
  const archived = !!teamspace.archivedAt;
  let pageRole: ShareRole | undefined;
  if (!archived && membershipRole === 'owner') pageRole = 'full_access';
  else if (!archived && membershipRole === 'member' && isTeamspacePageRole(teamspace.memberPageRole)) {
    pageRole = teamspace.memberPageRole;
  } else if (!archived && activeWorkspaceMember && access === 'open' && isTeamspacePageRole(teamspace.openPageRole)) {
    pageRole = teamspace.openPageRole;
  }
  const visible = !archived && activeWorkspaceMember && (
    joined || access === 'open' || access === 'closed'
  );
  return {
    teamspace,
    settings: exactSettings,
    explicitMembership,
    membershipRole,
    membershipSource,
    pageRole,
    joined,
    visible,
    canJoin: visible && !joined && access === 'open',
    canRequest: visible && !joined && access === 'closed',
  };
}
