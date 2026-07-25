import type {
  DbRef,
  OrganizationGroupMember,
  WorkspaceMember,
} from './app-types';
import {
  listAll,
  listAllTruncated,
  narrowWhere,
  projectFields,
} from './table-utils';

const GROUP_ID_QUERY_CHUNK_SIZE = 100;
const GROUP_MEMBERSHIP_WIRE_MAX_ITEMS = 1_000;
const WORKSPACE_MEMBERSHIP_FIELDS = ['id', 'workspaceId', 'userId', 'role'] as const;
const GROUP_MEMBERSHIP_FIELDS = [
  'id',
  'organizationId',
  'organizationMemberId',
  'groupId',
  'userId',
] as const;

function uniqueNonemptyStrings(values: Iterable<string>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Resolve one fresh workspace membership without returning the whole roster.
 * The exact in-memory predicate remains authoritative for older adapters whose
 * first where() query cannot chain another server-side condition.
 */
export async function workspaceMembershipForUser(
  db: DbRef,
  workspaceId: string,
  userId: string,
) {
  const workspaceQuery = db
    .table<WorkspaceMember>('workspace_members')
    .where('workspaceId', '==', workspaceId);
  const supportsTargetedUserQuery = typeof workspaceQuery.where === 'function';
  const query = projectFields(
    narrowWhere(
      workspaceQuery,
      'userId',
      userId,
    ),
    WORKSPACE_MEMBERSHIP_FIELDS,
  );
  const members = await listAll(query, {
    // Preserve the former complete-workspace fallback for narrow/legacy
    // adapters while keeping the normal targeted wire response much smaller.
    maxItems: supportsTargetedUserQuery ? 1_000 : 25_000,
    pageSize: supportsTargetedUserQuery ? 100 : 1_000,
    label: 'Targeted workspace membership',
  });
  return members.find(
    (member) => member.workspaceId === workspaceId && member.userId === userId,
  ) ?? null;
}

function appendMembersInGroupOrder(
  out: OrganizationGroupMember[],
  members: OrganizationGroupMember[],
  groupIds: string[],
) {
  const groupIdSet = new Set(groupIds);
  const byGroup = new Map<string, OrganizationGroupMember[]>();
  for (const member of members) {
    if (!groupIdSet.has(member.groupId)) continue;
    const group = byGroup.get(member.groupId);
    if (group) group.push(member);
    else byGroup.set(member.groupId, [member]);
  }
  for (const groupId of groupIds) out.push(...(byGroup.get(groupId) ?? []));
}

/**
 * Expand group principals as bounded mixed-key reads. Group discovery is only
 * candidate collection; callers still perform a fresh per-recipient access
 * decision immediately before delivering any notification payload.
 */
export async function organizationGroupMembersForGroupIds(
  db: DbRef,
  groupIds: Iterable<string>,
) {
  const orderedGroupIds = uniqueNonemptyStrings(groupIds);
  const out: OrganizationGroupMember[] = [];
  const table = db.table<OrganizationGroupMember>('organization_group_members');

  for (let offset = 0; offset < orderedGroupIds.length; offset += GROUP_ID_QUERY_CHUNK_SIZE) {
    const chunk = orderedGroupIds.slice(offset, offset + GROUP_ID_QUERY_CHUNK_SIZE);
    const aggregate = await listAllTruncated(
      projectFields(
        table.where('groupId', 'in', chunk),
        GROUP_MEMBERSHIP_FIELDS,
      ),
      {
        maxItems: GROUP_MEMBERSHIP_WIRE_MAX_ITEMS,
        pageSize: 1_000,
        label: 'Notification group membership chunk',
      },
    );
    if (aggregate.complete) {
      appendMembersInGroupOrder(out, aggregate.items, chunk);
      continue;
    }

    // A mixed-key response crossed its bounded wire budget. Re-read each
    // group separately so no candidate is silently truncated and the former
    // per-group 25k materialization contract remains intact.
    for (const groupId of chunk) {
      const members = await listAll(
        projectFields(
          table.where('groupId', '==', groupId),
          GROUP_MEMBERSHIP_FIELDS,
        ),
        {
          maxItems: 25_000,
          pageSize: 1_000,
          label: 'Notification group membership fallback',
        },
      );
      appendMembersInGroupOrder(out, members, [groupId]);
    }
  }

  return out;
}
