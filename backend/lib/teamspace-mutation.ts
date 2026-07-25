import type {
  DbRef,
  OrganizationGroup,
  Workspace,
  WorkspaceMember,
} from './app-types';
import {
  actorGroupIdsForWorkspace,
} from './page-access';
import {
  isTeamspaceAccess,
  isTeamspaceMemberRole,
  isTeamspacePageRole,
  teamspaceAccessDecision,
  workspaceRoleCanUseTeamspaces,
  type TeamspaceAccess,
  type TeamspaceLike,
  type TeamspaceMemberLike,
  type TeamspaceMemberRole,
  type TeamspaceSettingsLike,
} from './teamspace-access';
import {
  getExisting,
  isTransactionConflictError,
  listAll,
  listAllTruncated,
  narrowWhere,
  nowIso,
  requireString,
  type TableQuery,
  type TransactOperation,
} from './table-utils';

interface TeamspaceJoinRequest {
  id: string;
  workspaceId: string;
  teamspaceId: string;
  userId: string;
  workspaceMemberId: string;
  status: 'pending' | 'approved' | 'denied' | string;
  createdBy: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface TeamspaceContext {
  workspace: Workspace;
  currentMember: WorkspaceMember;
  currentRole: string;
}

export interface TeamspaceMutationInput {
  db: DbRef;
  actorId: string;
  body: Record<string, unknown>;
}

const TEAMSPACE_ACTIVE_LIMIT = 100;
const TEAMSPACE_PAGE_LIMIT = 100;
const TEAMSPACE_NAME_LIMIT = 80;
const TEAMSPACE_DESCRIPTION_LIMIT = 500;
const TEAMSPACE_GROUP_LIMIT = 100;
const TEAMSPACE_CURSOR_LIMIT = 512;

function statusError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function optionalBoundedString(value: unknown, label: string, maxLength: number) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw statusError(400, `${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw statusError(400, `${label} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function requiredTeamspaceName(value: unknown) {
  const name = optionalBoundedString(value, 'name', TEAMSPACE_NAME_LIMIT);
  if (!name) throw statusError(400, 'name is required.');
  return name;
}

function teamspaceAccess(value: unknown): TeamspaceAccess {
  if (value == null || value === '') return 'open';
  if (!isTeamspaceAccess(value)) {
    throw statusError(400, 'access must be open, closed, or private.');
  }
  return value;
}

function teamspacePageRole(
  value: unknown,
  fallback: 'view' | 'comment' | 'edit' | 'full_access',
) {
  if (value == null || value === '') return fallback;
  if (!isTeamspacePageRole(value)) {
    throw statusError(400, 'Teamspace page role must be view, comment, edit, or full_access.');
  }
  return value;
}

function booleanValue(value: unknown, fallback: boolean) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw statusError(400, 'Teamspace policy values must be boolean.');
  return value;
}

function optionalTeamspaceCursor(value: unknown) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw statusError(400, 'after must be a string.');
  const cursor = value.trim();
  if (!cursor || cursor.length > TEAMSPACE_CURSOR_LIMIT) {
    throw statusError(400, `after must be between 1 and ${TEAMSPACE_CURSOR_LIMIT} characters.`);
  }
  return cursor;
}

function requiredTeamspaceWhere<T>(
  query: TableQuery<T>,
  field: string,
  op: string,
  value: unknown,
  label: string,
) {
  if (typeof query.where !== 'function') {
    throw statusError(500, `${label} requires bounded server-side filters.`);
  }
  return query.where(field, op, value);
}

async function teamspaceKeysetWindow<T extends { id: string }>(
  query: TableQuery<T>,
  after: string | undefined,
  limit: number,
  label: string,
) {
  if (
    typeof query.orderBy !== 'function'
    || typeof query.after !== 'function'
    || typeof query.includeTotal !== 'function'
  ) {
    throw statusError(500, `${label} requires bounded id-keyset queries.`);
  }
  let window = query.orderBy('id', 'asc');
  if (typeof window.after !== 'function' || typeof window.includeTotal !== 'function') {
    throw statusError(500, `${label} requires bounded id-keyset queries.`);
  }
  window = window.includeTotal(false);
  if (after) {
    if (typeof window.after !== 'function') {
      throw statusError(500, `${label} requires bounded id-keyset queries.`);
    }
    window = window.after(after);
  }
  const result = await window.limit(limit + 1).getList();
  const raw = result.items ?? [];
  let prior = after;
  for (const row of raw) {
    if (!row.id || (prior !== undefined && row.id.localeCompare(prior) <= 0)) {
      throw statusError(500, `${label} returned a non-advancing cursor.`);
    }
    prior = row.id;
  }
  if (raw.length === 0 && result.hasMore) {
    throw statusError(500, `${label} returned an empty page with continuation.`);
  }
  const rows = raw.slice(0, limit);
  const hasMore = raw.length > limit || result.hasMore === true;
  return {
    rows,
    hasMore,
    nextCursor: hasMore ? rows.at(-1)?.id ?? null : null,
  };
}

async function teamspaceContext(db: DbRef, workspaceId: string, actorId: string): Promise<TeamspaceContext> {
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace) throw statusError(404, 'Workspace was not found.');
  const memberships = await listAll(
    narrowWhere(
      db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
      'userId',
      actorId,
    ),
    { maxItems: 2, pageSize: 2, label: 'Teamspace actor workspace membership' },
  );
  const currentMember = memberships.find((membership) => (
    membership.workspaceId === workspaceId && membership.userId === actorId
  ));
  if (!currentMember) throw statusError(403, 'Workspace member access required.');
  const currentRole = workspace.ownerId === actorId ? 'owner' : currentMember.role;
  return { workspace, currentMember, currentRole };
}

function assertTeamspaceWorkspaceMember(ctx: TeamspaceContext) {
  if (workspaceRoleCanUseTeamspaces(ctx.currentRole)) return;
  throw statusError(403, 'Workspace member access required.');
}

function settingsDefault(workspaceId: string): TeamspaceSettingsLike {
  return {
    id: workspaceId,
    workspaceId,
    defaultTeamspaceId: null,
    ownersOnlyCreate: false,
    lifecycleToken: null,
  };
}

function fencedSettingsWrite(
  existing: TeamspaceSettingsLike | null,
  workspaceId: string,
  actorId: string,
  now: string,
  patch: Partial<Pick<TeamspaceSettingsLike, 'defaultTeamspaceId' | 'ownersOnlyCreate'>> = {},
) {
  const current = existing ?? settingsDefault(workspaceId);
  const settings: TeamspaceSettingsLike = {
    ...current,
    ...patch,
    lifecycleToken: crypto.randomUUID(),
    updatedBy: actorId,
    updatedAt: now,
  };
  const operations: TransactOperation[] = existing
    ? [
        {
          table: 'teamspace_settings',
          op: 'expect',
          id: existing.id,
          where: [['lifecycleToken', '==', existing.lifecycleToken ?? null]],
          exists: true,
        },
        {
          table: 'teamspace_settings',
          op: 'update',
          id: existing.id,
          data: {
            ...patch,
            lifecycleToken: settings.lifecycleToken,
            updatedBy: actorId,
            updatedAt: now,
          },
        },
      ]
    : [
        { table: 'teamspace_settings', op: 'expect', id: workspaceId, exists: false },
        {
          table: 'teamspace_settings',
          op: 'insert',
          data: { ...settings, createdAt: now } as Record<string, unknown>,
        },
      ];
  return { settings, operations };
}

function teamspacePointExpectation(teamspace: TeamspaceLike): TransactOperation {
  return {
    table: 'teamspaces',
    op: 'expect',
    id: teamspace.id,
    where: [
      ['writeToken', '==', teamspace.writeToken ?? null],
      ['archivedAt', '==', teamspace.archivedAt ?? null],
    ],
    exists: true,
  };
}

function teamspaceRevisionFence(teamspace: TeamspaceLike) {
  return { table: 'teamspaces', id: teamspace.id, field: 'writeToken' };
}

function auditOutboxOperation(
  workspace: Workspace,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
  occurredAt: string,
): TransactOperation | null {
  if (!workspace.organizationId) return null;
  return {
    table: 'organization_audit_outbox',
    op: 'insert',
    data: {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      actorId,
      action,
      targetType,
      targetId,
      metadata,
      occurredAt,
      attempts: 0,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  };
}

function withAudit(
  operations: TransactOperation[],
  workspace: Workspace,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
  occurredAt: string,
) {
  const audit = auditOutboxOperation(
    workspace,
    actorId,
    action,
    targetType,
    targetId,
    metadata,
    occurredAt,
  );
  return audit ? [...operations, audit] : operations;
}

async function activeTeamspacePrefix(db: DbRef, workspaceId: string) {
  const result = await requiredTeamspaceWhere(
    db.table<TeamspaceLike>('teamspaces').where('workspaceId', '==', workspaceId),
    'archivedAt',
    '==',
    null,
    'Active Teamspace count',
  )
    .limit(TEAMSPACE_ACTIVE_LIMIT + 1)
    .getList();
  return (result.items ?? []).filter((item) => item.workspaceId === workspaceId && !item.archivedAt);
}

async function createTeamspace(input: TeamspaceMutationInput, retryOnLifecycleRace = true) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const settings = await getExisting(
    input.db.table<TeamspaceSettingsLike>('teamspace_settings'),
    workspaceId,
  );
  const normalizedSettings = settings ?? settingsDefault(workspaceId);
  if (normalizedSettings.ownersOnlyCreate && ctx.currentRole !== 'owner') {
    throw statusError(403, 'Only workspace owners can create Teamspaces.');
  }
  const active = await activeTeamspacePrefix(input.db, workspaceId);
  if (active.length >= TEAMSPACE_ACTIVE_LIMIT) {
    throw statusError(409, `A workspace can have at most ${TEAMSPACE_ACTIVE_LIMIT} active Teamspaces.`);
  }

  const now = nowIso();
  const teamspace: TeamspaceLike = {
    id: crypto.randomUUID(),
    workspaceId,
    name: requiredTeamspaceName(input.body.name),
    icon: optionalBoundedString(input.body.icon, 'icon', 32) || '🧭',
    description: optionalBoundedString(
      input.body.description,
      'description',
      TEAMSPACE_DESCRIPTION_LIMIT,
    ),
    access: teamspaceAccess(input.body.access),
    memberPageRole: teamspacePageRole(input.body.memberPageRole, 'edit'),
    openPageRole: teamspacePageRole(input.body.openPageRole, 'view'),
    membersCanInvite: booleanValue(input.body.membersCanInvite, true),
    membersCanEditSidebar: booleanValue(input.body.membersCanEditSidebar, true),
    archivedAt: null,
    archivedBy: null,
    writeToken: crypto.randomUUID(),
    createdBy: input.actorId,
    updatedBy: input.actorId,
    createdAt: now,
    updatedAt: now,
  };
  const membership: TeamspaceMemberLike = {
    id: crypto.randomUUID(),
    workspaceId,
    teamspaceId: teamspace.id,
    principalType: 'user',
    principalId: input.actorId,
    workspaceMemberId: ctx.currentMember.id,
    role: 'owner',
    createdBy: input.actorId,
    createdAt: now,
    updatedAt: now,
  };
  const first = !normalizedSettings.defaultTeamspaceId && active.length === 0;
  const settingsWrite = fencedSettingsWrite(
    settings,
    workspaceId,
    input.actorId,
    now,
    first ? { defaultTeamspaceId: teamspace.id } : {},
  );
  const nextSettings = settingsWrite.settings;
  const operations = withAudit(
    [
      { table: 'teamspaces', op: 'insert', data: teamspace as unknown as Record<string, unknown> },
      { table: 'teamspace_members', op: 'insert', data: membership as unknown as Record<string, unknown> },
      ...settingsWrite.operations,
    ],
    ctx.workspace,
    input.actorId,
    'teamspace.create',
    'teamspace',
    teamspace.id,
    { access: teamspace.access, first, defaultTeamspaceId: nextSettings.defaultTeamspaceId ?? null },
    now,
  );
  try {
    await input.db.transact(operations);
  } catch (error) {
    if (!retryOnLifecycleRace || !isTransactionConflictError(error)) throw error;
    // Every active-count transition fences the deterministic settings point.
    // The loser is fully rolled back, re-reads the cap/default state, and
    // retries once with a fresh Teamspace id and lifecycle token.
    return createTeamspace(input, false);
  }
  return { teamspace, settings: nextSettings, membership };
}

async function listActorTeamspaceMemberships(
  db: DbRef,
  actorId: string,
  teamspaceIds: Set<string>,
  groupIds: Set<string>,
) {
  if (teamspaceIds.size === 0) return [];
  const userMemberships = await listAll(
    narrowWhere(
      db.table<TeamspaceMemberLike>('teamspace_members').where(
        'teamspaceId',
        'in',
        Array.from(teamspaceIds),
      ),
      'principalId',
      actorId,
    ),
    { maxItems: TEAMSPACE_PAGE_LIMIT + 1, pageSize: TEAMSPACE_PAGE_LIMIT + 1, label: 'Teamspace user memberships' },
  );
  if (groupIds.size === 0 || groupIds.size > TEAMSPACE_GROUP_LIMIT) return userMemberships;
  const groupResult = await listAllTruncated(
    requiredTeamspaceWhere(
      db.table<TeamspaceMemberLike>('teamspace_members').where(
        'teamspaceId',
        'in',
        Array.from(teamspaceIds),
      ),
      'principalId',
      'in',
      Array.from(groupIds),
      'Teamspace group memberships',
    ),
    { maxItems: 10_001, pageSize: 1_000, label: 'Teamspace group memberships' },
  );
  // An incomplete group authority result cannot safely grant. Exact user rows
  // remain valid and default/open access is derived independently.
  return groupResult.complete
    ? [...userMemberships, ...groupResult.items.filter((row) => teamspaceIds.has(row.teamspaceId))]
    : userMemberships;
}

async function listTeamspaces(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  if (!workspaceRoleCanUseTeamspaces(ctx.currentRole)) {
    return { teamspaces: [], settings: settingsDefault(workspaceId), hasMore: false };
  }
  const requestedLimit = typeof input.body.limit === 'number' && Number.isFinite(input.body.limit)
    ? Math.floor(input.body.limit)
    : TEAMSPACE_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(TEAMSPACE_PAGE_LIMIT, requestedLimit));
  const after = optionalTeamspaceCursor(input.body.after);
  const activeQuery = requiredTeamspaceWhere(
    input.db.table<TeamspaceLike>('teamspaces').where('workspaceId', '==', workspaceId),
    'archivedAt',
    '==',
    null,
    'Teamspace browse',
  );
  const listed = await teamspaceKeysetWindow(activeQuery, after, limit, 'Teamspace browse');
  const window = listed.rows;
  if (window.some((teamspace) => teamspace.workspaceId !== workspaceId || !!teamspace.archivedAt)) {
    throw statusError(500, 'Teamspace browse returned an invalid authority row.');
  }
  const settings = await getExisting(
    input.db.table<TeamspaceSettingsLike>('teamspace_settings'),
    workspaceId,
  ) ?? settingsDefault(workspaceId);
  const groupIds = await actorGroupIdsForWorkspace(input.db, workspaceId, input.actorId);
  const memberships = await listActorTeamspaceMemberships(
    input.db,
    input.actorId,
    new Set(window.map((teamspace) => teamspace.id)),
    groupIds,
  );
  const visible = window.flatMap((teamspace) => {
    if (teamspace.archivedAt) return [];
    const matchingMemberships = memberships.filter((membership) => {
      if (membership.teamspaceId !== teamspace.id || !isTeamspaceMemberRole(membership.role)) return false;
      if (membership.principalType === 'user') {
        return membership.principalId === input.actorId
          && membership.workspaceMemberId === ctx.currentMember.id;
      }
      return membership.principalType === 'group'
        && groupIds.has(membership.principalId);
    });
    const explicit = matchingMemberships.find((membership) => membership.role === 'owner')
      ?? matchingMemberships.find((membership) => membership.role === 'member');
    const membershipSource = explicit
      ? 'explicit'
      : settings.defaultTeamspaceId === teamspace.id
        ? 'default'
        : undefined;
    const role: TeamspaceMemberRole | undefined = isTeamspaceMemberRole(explicit?.role)
      ? explicit.role
      : membershipSource === 'default'
        ? 'member'
        : undefined;
    const access = isTeamspaceAccess(teamspace.access) ? teamspace.access : 'closed';
    const joined = role !== undefined;
    if (!joined && access === 'private') return [];
    return [{
      ...teamspace,
      joined,
      membershipSource,
      role,
      canJoin: !joined && access === 'open',
      canRequest: !joined && access === 'closed',
      isDefault: settings.defaultTeamspaceId === teamspace.id,
    }];
  });
  return {
    teamspaces: visible,
    settings,
    hasMore: listed.hasMore,
    nextCursor: listed.nextCursor,
  };
}

async function exactTeamspace(
  db: DbRef,
  workspaceId: string,
  teamspaceId: string,
  hidePrivate = false,
) {
  const teamspace = await getExisting(db.table<TeamspaceLike>('teamspaces'), teamspaceId);
  if (
    !teamspace
    || teamspace.workspaceId !== workspaceId
    || teamspace.archivedAt
    || (hidePrivate && teamspace.access === 'private')
  ) {
    throw statusError(404, 'Teamspace was not found.');
  }
  return teamspace;
}

async function teamspaceActorDecision(db: DbRef, ctx: TeamspaceContext, teamspaceId: string, actorId: string) {
  return teamspaceAccessDecision(db, teamspaceId, {
    actorId,
    workspaceMemberId: ctx.currentMember.id,
    workspaceMemberRole: ctx.currentRole,
    groupIds: await actorGroupIdsForWorkspace(db, ctx.workspace.id, actorId),
  });
}

async function joinTeamspace(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId, true);
  if (teamspace.access !== 'open') throw statusError(403, 'This Teamspace cannot be joined directly.');
  const decision = await teamspaceActorDecision(input.db, ctx, teamspaceId, input.actorId);
  if (decision.explicitMembership) return { teamspace, membership: decision.explicitMembership };
  const now = nowIso();
  const membership: TeamspaceMemberLike = {
    id: crypto.randomUUID(),
    workspaceId,
    teamspaceId,
    principalType: 'user',
    principalId: input.actorId,
    workspaceMemberId: ctx.currentMember.id,
    role: 'member',
    createdBy: input.actorId,
    createdAt: now,
    updatedAt: now,
  };
  const operations = withAudit(
    [
      ...teamspaceWriteFence(teamspace, now),
      {
        table: 'teamspace_members', op: 'expect',
        where: [
          ['teamspaceId', '==', teamspaceId],
          ['principalType', '==', 'user'],
          ['principalId', '==', input.actorId],
        ],
        exists: false,
        fencedBy: teamspaceRevisionFence(teamspace),
      },
      { table: 'teamspace_members', op: 'insert', data: membership as unknown as Record<string, unknown> },
    ],
    ctx.workspace,
    input.actorId,
    'teamspace.join',
    'teamspace',
    teamspaceId,
    {},
    now,
  );
  try {
    await input.db.transact(operations);
  } catch (error) {
    if (!isTransactionConflictError(error)) throw error;
    const afterRace = await teamspaceActorDecision(input.db, ctx, teamspaceId, input.actorId);
    if (afterRace.explicitMembership) return { teamspace, membership: afterRace.explicitMembership };
    throw statusError(409, 'Teamspace membership changed concurrently. Retry the request.');
  }
  return { teamspace, membership };
}

function joinRequestId(teamspaceId: string, userId: string) {
  // EdgeBase custom record IDs deliberately exclude ':' and other URL/SQL
  // punctuation. Teamspace and user IDs already use the same safe alphabet,
  // so this remains deterministic without a separate lookup or hash read.
  return `teamspace-request-${teamspaceId}-${userId}`;
}

async function requestTeamspaceAccess(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId, true);
  if (teamspace.access !== 'closed') {
    throw statusError(403, 'Only Closed Teamspaces accept access requests.');
  }
  const decision = await teamspaceActorDecision(input.db, ctx, teamspaceId, input.actorId);
  if (decision.joined) throw statusError(409, 'You are already a member of this Teamspace.');
  const requests = input.db.table<TeamspaceJoinRequest>('teamspace_join_requests');
  const id = joinRequestId(teamspaceId, input.actorId);
  const existing = await getExisting(requests, id);
  if (existing?.status === 'pending') return { teamspace, request: existing };
  const now = nowIso();
  const request: TeamspaceJoinRequest = {
    id,
    workspaceId,
    teamspaceId,
    userId: input.actorId,
    workspaceMemberId: ctx.currentMember.id,
    status: 'pending',
    createdBy: input.actorId,
    decidedBy: null,
    decidedAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const write: TransactOperation = existing
    ? {
        table: 'teamspace_join_requests', op: 'update', id,
        data: {
          workspaceMemberId: ctx.currentMember.id,
          status: 'pending', decidedBy: null, decidedAt: null, updatedAt: now,
        },
      }
    : { table: 'teamspace_join_requests', op: 'insert', data: request as unknown as Record<string, unknown> };
  await input.db.transact(withAudit(
    [teamspacePointExpectation(teamspace), write],
    ctx.workspace,
    input.actorId,
    'teamspace.access_request',
    'teamspace',
    teamspaceId,
    {},
    now,
  ));
  return { teamspace, request };
}

async function assertTeamspaceOwner(
  db: DbRef,
  ctx: TeamspaceContext,
  teamspaceId: string,
  actorId: string,
) {
  const decision = await teamspaceActorDecision(db, ctx, teamspaceId, actorId);
  if (decision.membershipRole === 'owner') return decision;
  throw statusError(403, 'Teamspace owner access required.');
}

async function respondTeamspaceRequest(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const userId = requireString(input.body.userId, 'userId');
  const decisionValue = input.body.decision;
  if (decisionValue !== 'approve' && decisionValue !== 'deny') {
    throw statusError(400, 'decision must be approve or deny.');
  }
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  if (ctx.currentRole !== 'owner' && ctx.currentRole !== 'admin') {
    await assertTeamspaceOwner(input.db, ctx, teamspaceId, input.actorId);
  }
  const requestId = joinRequestId(teamspaceId, userId);
  const request = await getExisting(
    input.db.table<TeamspaceJoinRequest>('teamspace_join_requests'),
    requestId,
  );
  if (!request || request.workspaceId !== workspaceId || request.status !== 'pending') {
    throw statusError(404, 'Teamspace access request was not found.');
  }
  const targetMemberships = await listAll(
    narrowWhere(
      input.db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
      'userId',
      userId,
    ),
    { maxItems: 2, pageSize: 2, label: 'Teamspace request target membership' },
  );
  const target = targetMemberships.find((membership) => (
    membership.workspaceId === workspaceId && membership.userId === userId
  ));
  if (!target || !workspaceRoleCanUseTeamspaces(target.role) || target.id !== request.workspaceMemberId) {
    throw statusError(409, 'The requester is no longer an eligible workspace member.');
  }
  const now = nowIso();
  const resolvedRequest = {
    ...request,
    status: decisionValue === 'approve' ? 'approved' : 'denied',
    decidedBy: input.actorId,
    decidedAt: now,
    updatedAt: now,
  } satisfies TeamspaceJoinRequest;
  let membership: TeamspaceMemberLike | undefined;
  const operations: TransactOperation[] = [...teamspaceWriteFence(teamspace, now)];
  if (decisionValue === 'approve') {
    membership = {
      id: crypto.randomUUID(),
      workspaceId,
      teamspaceId,
      principalType: 'user',
      principalId: userId,
      workspaceMemberId: target.id,
      role: 'member',
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
    };
    operations.push(
      {
        table: 'teamspace_members', op: 'expect',
        where: [
          ['teamspaceId', '==', teamspaceId],
          ['principalType', '==', 'user'],
          ['principalId', '==', userId],
        ],
        exists: false,
        fencedBy: teamspaceRevisionFence(teamspace),
      },
      { table: 'teamspace_members', op: 'insert', data: membership as unknown as Record<string, unknown> },
    );
  }
  operations.push(
    {
      table: 'teamspace_join_requests', op: 'expect', id: request.id,
      where: [['status', '==', 'pending']], exists: true,
    },
    {
      table: 'teamspace_join_requests', op: 'update', id: request.id,
      data: {
        status: resolvedRequest.status,
        decidedBy: input.actorId,
        decidedAt: now,
        updatedAt: now,
      },
    },
  );
  await input.db.transact(withAudit(
    operations,
    ctx.workspace,
    input.actorId,
    decisionValue === 'approve' ? 'teamspace.access_approve' : 'teamspace.access_deny',
    'teamspace',
    teamspaceId,
    { userId },
    now,
  ));
  return { teamspace, request: resolvedRequest, membership };
}

function workspaceCanAdministerTeamspaces(ctx: TeamspaceContext) {
  return ctx.currentRole === 'owner' || ctx.currentRole === 'admin';
}

async function assertTeamspaceAdministrator(
  db: DbRef,
  ctx: TeamspaceContext,
  teamspaceId: string,
  actorId: string,
) {
  if (workspaceCanAdministerTeamspaces(ctx)) {
    return teamspaceActorDecision(db, ctx, teamspaceId, actorId);
  }
  return assertTeamspaceOwner(db, ctx, teamspaceId, actorId);
}

async function exactTeamspaceMembership(
  db: DbRef,
  workspaceId: string,
  teamspaceId: string,
  membershipId: string,
) {
  const membership = await getExisting(
    db.table<TeamspaceMemberLike>('teamspace_members'),
    membershipId,
  );
  if (
    !membership
    || membership.workspaceId !== workspaceId
    || membership.teamspaceId !== teamspaceId
    || !isTeamspaceMemberRole(membership.role)
  ) {
    throw statusError(404, 'Teamspace membership was not found.');
  }
  return membership;
}

async function membershipsForPrincipal(
  db: DbRef,
  teamspaceId: string,
  principalType: 'user' | 'group',
  principalId: string,
) {
  const byType = narrowWhere(
    db.table<TeamspaceMemberLike>('teamspace_members').where('teamspaceId', '==', teamspaceId),
    'principalType',
    principalType,
  );
  return listAll(narrowWhere(byType, 'principalId', principalId), {
    maxItems: 2,
    pageSize: 2,
    label: 'Exact Teamspace principal membership',
  });
}

async function eligibleWorkspaceMember(
  db: DbRef,
  workspaceId: string,
  userId: string,
) {
  const memberships = await listAll(
    narrowWhere(
      db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
      'userId',
      userId,
    ),
    { maxItems: 2, pageSize: 2, label: 'Teamspace target workspace membership' },
  );
  const membership = memberships.find((candidate) => (
    candidate.workspaceId === workspaceId && candidate.userId === userId
  ));
  if (!membership || !workspaceRoleCanUseTeamspaces(membership.role)) {
    throw statusError(404, 'Eligible workspace member was not found.');
  }
  return membership;
}

async function eligibleOrganizationGroup(
  db: DbRef,
  workspace: Workspace,
  groupId: string,
) {
  if (!workspace.organizationId) {
    throw statusError(400, 'Personal workspaces cannot use group Teamspace membership.');
  }
  const group = await getExisting(db.table<OrganizationGroup>('organization_groups'), groupId);
  if (!group || group.organizationId !== workspace.organizationId) {
    throw statusError(404, 'Organization group was not found.');
  }
  return group;
}

function teamspaceWriteFence(teamspace: TeamspaceLike, now: string): TransactOperation[] {
  const writeToken = crypto.randomUUID();
  return [
    teamspacePointExpectation(teamspace),
    {
      table: 'teamspaces',
      op: 'update',
      id: teamspace.id,
      data: { writeToken, updatedAt: now },
    },
  ];
}

async function updateTeamspace(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  await assertTeamspaceAdministrator(input.db, ctx, teamspaceId, input.actorId);
  const now = nowIso();
  const writeToken = crypto.randomUUID();
  const patch = {
    name: 'name' in input.body
      ? requiredTeamspaceName(input.body.name)
      : requiredTeamspaceName(teamspace.name),
    icon: 'icon' in input.body
      ? optionalBoundedString(input.body.icon, 'icon', 32) || '🧭'
      : optionalBoundedString(teamspace.icon, 'icon', 32) || '🧭',
    description: 'description' in input.body
      ? optionalBoundedString(input.body.description, 'description', TEAMSPACE_DESCRIPTION_LIMIT)
      : optionalBoundedString(teamspace.description, 'description', TEAMSPACE_DESCRIPTION_LIMIT),
    access: 'access' in input.body
      ? teamspaceAccess(input.body.access)
      : teamspaceAccess(teamspace.access),
    memberPageRole: 'memberPageRole' in input.body
      ? teamspacePageRole(input.body.memberPageRole, 'edit')
      : teamspacePageRole(teamspace.memberPageRole, 'edit'),
    openPageRole: 'openPageRole' in input.body
      ? teamspacePageRole(input.body.openPageRole, 'view')
      : teamspacePageRole(teamspace.openPageRole, 'view'),
    membersCanInvite: 'membersCanInvite' in input.body
      ? booleanValue(input.body.membersCanInvite, true)
      : booleanValue(teamspace.membersCanInvite, true),
    membersCanEditSidebar: 'membersCanEditSidebar' in input.body
      ? booleanValue(input.body.membersCanEditSidebar, true)
      : booleanValue(teamspace.membersCanEditSidebar, true),
    updatedBy: input.actorId,
    writeToken,
    updatedAt: now,
  };
  await input.db.transact(withAudit(
    [
      teamspacePointExpectation(teamspace),
      { table: 'teamspaces', op: 'update', id: teamspaceId, data: patch },
    ],
    ctx.workspace,
    input.actorId,
    'teamspace.update',
    'teamspace',
    teamspaceId,
    { access: patch.access },
    now,
  ));
  return { teamspace: { ...teamspace, ...patch } };
}

async function addTeamspaceMember(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const principalId = requireString(input.body.principalId, 'principalId');
  const principalType = input.body.principalType;
  if (principalType !== 'user' && principalType !== 'group') {
    throw statusError(400, 'principalType must be user or group.');
  }
  if (!isTeamspaceMemberRole(input.body.role)) {
    throw statusError(400, 'role must be owner or member.');
  }
  const role = input.body.role;
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  const actorDecision = await teamspaceActorDecision(input.db, ctx, teamspaceId, input.actorId);
  const canAdminister = workspaceCanAdministerTeamspaces(ctx)
    || actorDecision.membershipRole === 'owner';
  const canInviteMember = actorDecision.membershipRole === 'member'
    && teamspace.membersCanInvite === true
    && role === 'member';
  if (!canAdminister && !canInviteMember) {
    throw statusError(403, 'Teamspace owner access required.');
  }
  const workspaceMember = principalType === 'user'
    ? await eligibleWorkspaceMember(input.db, workspaceId, principalId)
    : null;
  if (principalType === 'group') {
    await eligibleOrganizationGroup(input.db, ctx.workspace, principalId);
  }
  const existing = (await membershipsForPrincipal(
    input.db,
    teamspaceId,
    principalType,
    principalId,
  )).find((membership) => (
    membership.workspaceId === workspaceId
    && membership.teamspaceId === teamspaceId
    && membership.principalType === principalType
    && membership.principalId === principalId
  ));
  if (
    existing
    && existing.role === role
    && (principalType === 'group' || existing.workspaceMemberId === workspaceMember?.id)
  ) {
    return { teamspace, membership: existing };
  }
  const now = nowIso();
  const membership: TeamspaceMemberLike = {
    id: existing?.id ?? crypto.randomUUID(),
    workspaceId,
    teamspaceId,
    principalType,
    principalId,
    workspaceMemberId: workspaceMember?.id ?? null,
    role,
    createdBy: existing?.createdBy ?? input.actorId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const membershipWrite: TransactOperation = existing
    ? {
        table: 'teamspace_members',
        op: 'update',
        id: existing.id,
        data: {
          workspaceMemberId: membership.workspaceMemberId,
          role,
          updatedAt: now,
        },
      }
    : {
        table: 'teamspace_members',
        op: 'insert',
        data: membership as unknown as Record<string, unknown>,
      };
  const uniqueness: TransactOperation[] = existing
    ? [{
        table: 'teamspace_members',
        op: 'expect',
        id: existing.id,
        where: [['updatedAt', '==', existing.updatedAt ?? null]],
        exists: true,
      }]
    : [{
        table: 'teamspace_members',
        op: 'expect',
        where: [
          ['teamspaceId', '==', teamspaceId],
          ['principalType', '==', principalType],
          ['principalId', '==', principalId],
        ],
        exists: false,
        fencedBy: teamspaceRevisionFence(teamspace),
      }];
  await input.db.transact(withAudit(
    [...teamspaceWriteFence(teamspace, now), ...uniqueness, membershipWrite],
    ctx.workspace,
    input.actorId,
    'teamspace.member_add',
    'teamspace',
    teamspaceId,
    { principalType, principalId, role },
    now,
  ));
  return { teamspace: { ...teamspace, updatedAt: now }, membership };
}

async function listTeamspaceMembers(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  await assertTeamspaceAdministrator(input.db, ctx, teamspaceId, input.actorId);
  const requestedLimit = typeof input.body.limit === 'number' && Number.isFinite(input.body.limit)
    ? Math.floor(input.body.limit)
    : TEAMSPACE_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(TEAMSPACE_PAGE_LIMIT, requestedLimit));
  const after = optionalTeamspaceCursor(input.body.after);
  const result = await teamspaceKeysetWindow(
    input.db.table<TeamspaceMemberLike>('teamspace_members').where(
      'teamspaceId',
      '==',
      teamspaceId,
    ),
    after,
    limit,
    'Teamspace member list',
  );
  if (result.rows.some((membership) => (
    membership.workspaceId !== workspaceId || membership.teamspaceId !== teamspaceId
  ))) {
    throw statusError(500, 'Teamspace member list returned an invalid authority row.');
  }
  return {
    teamspace,
    members: result.rows,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
  };
}

async function listTeamspaceRequests(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  await assertTeamspaceAdministrator(input.db, ctx, teamspaceId, input.actorId);
  const requestedLimit = typeof input.body.limit === 'number' && Number.isFinite(input.body.limit)
    ? Math.floor(input.body.limit)
    : TEAMSPACE_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(TEAMSPACE_PAGE_LIMIT, requestedLimit));
  const after = optionalTeamspaceCursor(input.body.after);
  const pendingQuery = requiredTeamspaceWhere(
    input.db.table<TeamspaceJoinRequest>('teamspace_join_requests').where(
      'teamspaceId',
      '==',
      teamspaceId,
    ),
    'status',
    '==',
    'pending',
    'Teamspace request list',
  );
  const result = await teamspaceKeysetWindow(
    pendingQuery,
    after,
    limit,
    'Teamspace request list',
  );
  if (result.rows.some((request) => (
    request.workspaceId !== workspaceId
    || request.teamspaceId !== teamspaceId
    || request.status !== 'pending'
  ))) {
    throw statusError(500, 'Teamspace request list returned an invalid authority row.');
  }
  return {
    teamspace,
    requests: result.rows,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
  };
}

async function listArchivedTeamspaces(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  if (!workspaceCanAdministerTeamspaces(ctx)) {
    throw statusError(403, 'Workspace owner or admin access required.');
  }
  const requestedLimit = typeof input.body.limit === 'number' && Number.isFinite(input.body.limit)
    ? Math.floor(input.body.limit)
    : TEAMSPACE_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(TEAMSPACE_PAGE_LIMIT, requestedLimit));
  const after = optionalTeamspaceCursor(input.body.after);
  const archivedQuery = requiredTeamspaceWhere(
    input.db.table<TeamspaceLike>('teamspaces').where('workspaceId', '==', workspaceId),
    'archivedAt',
    '!=',
    null,
    'Archived Teamspace list',
  );
  const result = await teamspaceKeysetWindow(
    archivedQuery,
    after,
    limit,
    'Archived Teamspace list',
  );
  if (result.rows.some((teamspace) => (
    teamspace.workspaceId !== workspaceId || !teamspace.archivedAt
  ))) {
    throw statusError(500, 'Archived Teamspace list returned an invalid authority row.');
  }
  return {
    teamspaces: result.rows,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
  };
}

async function ownerMembershipPrefix(db: DbRef, teamspaceId: string) {
  const result = await narrowWhere(
    db.table<TeamspaceMemberLike>('teamspace_members').where('teamspaceId', '==', teamspaceId),
    'role',
    'owner',
  ).limit(2).getList();
  return (result.items ?? []).filter((membership) => (
    membership.teamspaceId === teamspaceId && membership.role === 'owner'
  ));
}

async function updateTeamspaceMemberRole(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const membershipId = requireString(input.body.membershipId, 'membershipId');
  if (!isTeamspaceMemberRole(input.body.role)) {
    throw statusError(400, 'role must be owner or member.');
  }
  const role = input.body.role;
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  await assertTeamspaceAdministrator(input.db, ctx, teamspaceId, input.actorId);
  const membership = await exactTeamspaceMembership(
    input.db,
    workspaceId,
    teamspaceId,
    membershipId,
  );
  if (membership.role === role) return { teamspace, membership };
  if (membership.role === 'owner' && role !== 'owner') {
    const owners = await ownerMembershipPrefix(input.db, teamspaceId);
    if (owners.length < 2) throw statusError(409, 'A Teamspace must keep at least one owner.');
  }
  const now = nowIso();
  const updated = { ...membership, role, updatedAt: now };
  await input.db.transact(withAudit(
    [
      ...teamspaceWriteFence(teamspace, now),
      {
        table: 'teamspace_members',
        op: 'expect',
        id: membership.id,
        where: [['role', '==', membership.role]],
        exists: true,
      },
      { table: 'teamspace_members', op: 'update', id: membership.id, data: { role, updatedAt: now } },
    ],
    ctx.workspace,
    input.actorId,
    'teamspace.member_role_update',
    'teamspace',
    teamspaceId,
    { membershipId, role },
    now,
  ));
  return { teamspace: { ...teamspace, updatedAt: now }, membership: updated };
}

async function removeTeamspaceMember(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const membershipId = requireString(input.body.membershipId, 'membershipId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  await assertTeamspaceAdministrator(input.db, ctx, teamspaceId, input.actorId);
  const membership = await exactTeamspaceMembership(
    input.db,
    workspaceId,
    teamspaceId,
    membershipId,
  );
  if (membership.role === 'owner') {
    const owners = await ownerMembershipPrefix(input.db, teamspaceId);
    if (owners.length < 2) throw statusError(409, 'A Teamspace must keep at least one owner.');
  }
  const now = nowIso();
  await input.db.transact(withAudit(
    [
      ...teamspaceWriteFence(teamspace, now),
      {
        table: 'teamspace_members',
        op: 'expect',
        id: membership.id,
        where: [['role', '==', membership.role]],
        exists: true,
      },
      { table: 'teamspace_members', op: 'delete', id: membership.id },
    ],
    ctx.workspace,
    input.actorId,
    'teamspace.member_remove',
    'teamspace',
    teamspaceId,
    { membershipId, principalType: membership.principalType, principalId: membership.principalId },
    now,
  ));
  return { teamspace: { ...teamspace, updatedAt: now }, removed: true, membershipId };
}

async function updateTeamspaceSettings(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  if (!workspaceCanAdministerTeamspaces(ctx)) {
    throw statusError(403, 'Workspace owner or admin access required.');
  }
  const existing = await getExisting(
    input.db.table<TeamspaceSettingsLike>('teamspace_settings'),
    workspaceId,
  );
  const now = nowIso();
  const current = existing ?? settingsDefault(workspaceId);
  const settingsWrite = fencedSettingsWrite(existing, workspaceId, input.actorId, now, {
    ownersOnlyCreate: 'ownersOnlyCreate' in input.body
      ? booleanValue(input.body.ownersOnlyCreate, false)
      : booleanValue(current.ownersOnlyCreate, false),
  });
  await input.db.transact(withAudit(
    settingsWrite.operations,
    ctx.workspace,
    input.actorId,
    'teamspace.settings_update',
    'workspace',
    workspaceId,
    { ownersOnlyCreate: settingsWrite.settings.ownersOnlyCreate },
    now,
  ));
  return { settings: settingsWrite.settings };
}

async function restoreTeamspace(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await getExisting(input.db.table<TeamspaceLike>('teamspaces'), teamspaceId);
  if (!teamspace || teamspace.workspaceId !== workspaceId || !teamspace.archivedAt) {
    throw statusError(404, 'Archived Teamspace was not found.');
  }
  await assertTeamspaceAdministrator(input.db, ctx, teamspaceId, input.actorId);
  const active = await activeTeamspacePrefix(input.db, workspaceId);
  if (active.length >= TEAMSPACE_ACTIVE_LIMIT) {
    throw statusError(409, `A workspace can have at most ${TEAMSPACE_ACTIVE_LIMIT} active Teamspaces.`);
  }
  const now = nowIso();
  const existingSettings = await getExisting(
    input.db.table<TeamspaceSettingsLike>('teamspace_settings'),
    workspaceId,
  );
  const settingsWrite = fencedSettingsWrite(
    existingSettings,
    workspaceId,
    input.actorId,
    now,
  );
  const restored = {
    ...teamspace,
    archivedAt: null,
    archivedBy: null,
    updatedBy: input.actorId,
    writeToken: crypto.randomUUID(),
    updatedAt: now,
  };
  await input.db.transact(withAudit(
    [
      teamspacePointExpectation(teamspace),
      {
        table: 'teamspaces',
        op: 'update',
        id: teamspaceId,
        data: {
          archivedAt: null,
          archivedBy: null,
          updatedBy: input.actorId,
          writeToken: restored.writeToken,
          updatedAt: now,
        },
      },
      ...settingsWrite.operations,
    ],
    ctx.workspace,
    input.actorId,
    'teamspace.restore',
    'teamspace',
    teamspaceId,
    {},
    now,
  ));
  return { teamspace: restored };
}

async function setDefaultTeamspace(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  if (!workspaceCanAdministerTeamspaces(ctx)) {
    throw statusError(403, 'Workspace owner or admin access required.');
  }
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  const existing = await getExisting(
    input.db.table<TeamspaceSettingsLike>('teamspace_settings'),
    workspaceId,
  );
  const current = existing ?? settingsDefault(workspaceId);
  if (current.defaultTeamspaceId === teamspaceId) return { teamspace, settings: current };
  const now = nowIso();
  const settingsWrite = fencedSettingsWrite(existing, workspaceId, input.actorId, now, {
    defaultTeamspaceId: teamspaceId,
  });
  await input.db.transact(withAudit(
    [teamspacePointExpectation(teamspace), ...settingsWrite.operations],
    ctx.workspace,
    input.actorId,
    'teamspace.default_update',
    'workspace',
    workspaceId,
    { defaultTeamspaceId: teamspaceId },
    now,
  ));
  return { teamspace, settings: settingsWrite.settings };
}

async function archiveTeamspace(input: TeamspaceMutationInput) {
  const workspaceId = requireString(input.body.workspaceId, 'workspaceId');
  const teamspaceId = requireString(input.body.teamspaceId, 'teamspaceId');
  const ctx = await teamspaceContext(input.db, workspaceId, input.actorId);
  assertTeamspaceWorkspaceMember(ctx);
  const teamspace = await exactTeamspace(input.db, workspaceId, teamspaceId);
  const actorDecision = await teamspaceActorDecision(input.db, ctx, teamspaceId, input.actorId);
  const workspaceAdmin = ctx.currentRole === 'owner' || ctx.currentRole === 'admin';
  if (!workspaceAdmin && actorDecision.membershipRole !== 'owner') {
    throw statusError(403, 'Teamspace owner access required.');
  }
  const existingSettings = await getExisting(
    input.db.table<TeamspaceSettingsLike>('teamspace_settings'),
    workspaceId,
  );
  const settings = existingSettings ?? settingsDefault(workspaceId);
  const replacementId = typeof input.body.replacementDefaultTeamspaceId === 'string'
    ? input.body.replacementDefaultTeamspaceId.trim()
    : '';
  let replacement: TeamspaceLike | null = null;
  if (settings.defaultTeamspaceId === teamspaceId) {
    if (!replacementId) {
      throw statusError(409, 'Choose a replacement default Teamspace before archiving this one.');
    }
    replacement = await exactTeamspace(input.db, workspaceId, replacementId);
    if (replacement.id === teamspaceId) {
      throw statusError(409, 'Choose a different replacement default Teamspace.');
    }
  }
  const now = nowIso();
  const archived = {
    ...teamspace,
    archivedAt: now,
    archivedBy: input.actorId,
    updatedBy: input.actorId,
    writeToken: crypto.randomUUID(),
    updatedAt: now,
  };
  const settingsWrite = fencedSettingsWrite(
    existingSettings,
    workspaceId,
    input.actorId,
    now,
    replacement ? { defaultTeamspaceId: replacement.id } : {},
  );
  const nextSettings = settingsWrite.settings;
  const operations: TransactOperation[] = [
    teamspacePointExpectation(teamspace),
    ...(replacement ? [teamspacePointExpectation(replacement)] : []),
    {
      table: 'teamspaces', op: 'update', id: teamspace.id,
      data: {
        archivedAt: now,
        archivedBy: input.actorId,
        updatedBy: input.actorId,
        writeToken: archived.writeToken,
        updatedAt: now,
      },
    },
    ...settingsWrite.operations,
  ];
  await input.db.transact(withAudit(
    operations,
    ctx.workspace,
    input.actorId,
    'teamspace.archive',
    'teamspace',
    teamspaceId,
    { replacementDefaultTeamspaceId: replacement?.id ?? null },
    now,
  ));
  return { teamspace: archived, settings: nextSettings };
}

export async function handleTeamspaceMutation(input: TeamspaceMutationInput) {
  const action = typeof input.body.action === 'string' ? input.body.action : '';
  switch (action) {
    case 'createTeamspace':
      return createTeamspace(input);
    case 'listTeamspaces':
      return listTeamspaces(input);
    case 'joinTeamspace':
      return joinTeamspace(input);
    case 'requestTeamspaceAccess':
      return requestTeamspaceAccess(input);
    case 'respondTeamspaceRequest':
      return respondTeamspaceRequest(input);
    case 'updateTeamspace':
      return updateTeamspace(input);
    case 'addTeamspaceMember':
      return addTeamspaceMember(input);
    case 'listTeamspaceMembers':
      return listTeamspaceMembers(input);
    case 'listTeamspaceRequests':
      return listTeamspaceRequests(input);
    case 'listArchivedTeamspaces':
      return listArchivedTeamspaces(input);
    case 'updateTeamspaceMemberRole':
      return updateTeamspaceMemberRole(input);
    case 'removeTeamspaceMember':
      return removeTeamspaceMember(input);
    case 'updateTeamspaceSettings':
      return updateTeamspaceSettings(input);
    case 'restoreTeamspace':
      return restoreTeamspace(input);
    case 'setDefaultTeamspace':
      return setDefaultTeamspace(input);
    case 'archiveTeamspace':
      return archiveTeamspace(input);
    default:
      throw statusError(400, 'Unknown Teamspace mutation action.');
  }
}

export const TEAMSPACE_MUTATION_ACTIONS = new Set([
  'createTeamspace',
  'listTeamspaces',
  'joinTeamspace',
  'requestTeamspaceAccess',
  'respondTeamspaceRequest',
  'updateTeamspace',
  'addTeamspaceMember',
  'listTeamspaceMembers',
  'listTeamspaceRequests',
  'listArchivedTeamspaces',
  'updateTeamspaceMemberRole',
  'removeTeamspaceMember',
  'updateTeamspaceSettings',
  'restoreTeamspace',
  'setDefaultTeamspace',
  'archiveTeamspace',
]);
