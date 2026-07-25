import {
  assertNotDeactivatedWorkspaceAccess,
  organizationMemberForNotDeactivatedWorkspace,
  type OrganizationAccessMemberLike,
} from './org-access';

import {
  listAll,
  listAllTruncated,
  getExisting,
  narrowWhere,
  projectFields,
  type TableQuery,
} from './table-utils';
import { teamspaceAccessDecision } from './teamspace-access';

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
  teamspaceId?: string | null;
  teamspacePermissionMode?: 'inherit' | 'restricted' | string | null;
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
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
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

const PAGE_ACCESS_ANCESTOR_LIMIT = 256;
const PAGE_ACCESS_BATCH_MAX_PAGES = 100;
const PAGE_ACCESS_DRAIN_MAX_PAGES = 500;
const PAGE_ACCESS_KNOWN_MAX_PAGES = 100;
const PAGE_ACCESS_PERMISSION_CHUNK_SIZE = 100;
const PAGE_ACCESS_PERMISSION_WIRE_MAX_ITEMS = 1_000;
const PAGE_ACCESS_MAX_IN_FLIGHT_KEYS = 256;
const PAGE_ACCESS_PAGE_FIELDS = [
  'id',
  'workspaceId',
  'parentId',
  'parentType',
  'teamspaceId',
  'teamspacePermissionMode',
  'createdBy',
] as const;
const PAGE_PERMISSION_ACCESS_FIELDS = [
  'id',
  'pageId',
  'workspaceId',
  'principalType',
  'principalId',
  'label',
  'role',
] as const;
const PAGE_PERMISSION_ACCESS_PAYLOAD_FIELDS = [
  ...PAGE_PERMISSION_ACCESS_FIELDS,
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;
const ORGANIZATION_GROUP_ACCESS_FIELDS = [
  'id',
  'organizationId',
  'groupId',
  'organizationMemberId',
  'userId',
] as const;
const WORKSPACE_MEMBER_ACCESS_FIELDS = [
  'id',
  'workspaceId',
  'userId',
  'role',
] as const;

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
    projectFields(
      narrowWhere(
        db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
        'userId',
        actorId,
      ),
      ['id', 'organizationId', 'userId', 'status'],
    ),
  );
  return members.find(
    (member) => member.userId === actorId && (member.status ?? 'active') === 'active',
  ) ?? null;
}

async function actorGroupIdsForOrganizationMember(
  db: DbRef,
  organizationId: string | null | undefined,
  actorId: string,
  organizationMember: Pick<
    OrganizationAccessMemberLike,
    'id' | 'organizationId' | 'userId' | 'status'
  > | null,
) {
  if (
    !organizationId
    || !organizationMember
    || organizationMember.organizationId !== organizationId
    || organizationMember.userId !== actorId
    || (organizationMember.status ?? 'active') !== 'active'
  ) {
    return new Set<string>();
  }
  const groupMembershipResult = await listAllTruncated(
    projectFields(
      narrowWhere(
        db.table<OrganizationGroupMember>('organization_group_members').where(
          'organizationId',
          '==',
          organizationId,
        ),
        'organizationMemberId',
        organizationMember.id,
      ),
      ORGANIZATION_GROUP_ACCESS_FIELDS,
    ),
    {
      maxItems: 101,
      pageSize: 101,
      label: 'Actor organization group authority',
    },
  );
  if (!groupMembershipResult.complete || groupMembershipResult.items.length > 100) {
    return new Set<string>();
  }
  const groupMembers = groupMembershipResult.items;
  return new Set(
    groupMembers
      .filter(
        (member) =>
          member.organizationId === organizationId
          && member.organizationMemberId === organizationMember.id
          && member.userId === actorId,
      )
      .map((member) => member.groupId),
  );
}

export async function actorGroupIdsForOrganization(
  db: DbRef,
  organizationId: string | null | undefined,
  actorId: string,
) {
  if (!organizationId) return new Set<string>();
  const organizationMember = await activeOrganizationMemberForUser(db, organizationId, actorId);
  return actorGroupIdsForOrganizationMember(db, organizationId, actorId, organizationMember);
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
  // Share-panel payloads reuse the direct-page permissions already read by
  // the role decision. Ask that one ancestry query for the response metadata
  // too instead of issuing a second direct-page list.
  includeDirectPermissionMetadata?: boolean;
}

export interface PageAccessBatchOptions extends PageAccessOptions {
  // Callers that already hold canonical parent rows can avoid rebilling those
  // rows while retaining the exact ancestry and Teamspace authority walk.
  knownPages?: PageLike[];
}

async function workspaceMemberRoleForActor(db: DbRef, workspaceId: string, actorId: string) {
  return (await workspaceMemberAccessForActor(db, workspaceId, actorId)).role;
}

async function workspaceMemberAccessForActor(db: DbRef, workspaceId: string, actorId: string) {
  const members = await listAll(
    projectFields(
      narrowWhere(
        db.table<WorkspaceMemberLike>('workspace_members').where('workspaceId', '==', workspaceId),
        'userId',
        actorId,
      ),
      WORKSPACE_MEMBER_ACCESS_FIELDS,
    ),
  );
  const membership = members.find(
    (member) => member.workspaceId === workspaceId && member.userId === actorId,
  );
  return {
    hasMembership: membership !== undefined,
    membershipId: membership?.id,
    membershipRole: membership?.role,
    role: workspaceMemberShareRole(membership?.role),
  };
}

// Exact page reads need the membership-row existence signal without mapping a
// legacy role value. Keep the query shape and authoritative in-memory filter in
// this shared owner so page-query does not duplicate the access predicate.
export async function workspaceHasMembershipForActor(
  db: DbRef,
  workspaceId: string,
  actorId: string,
) {
  return (await workspaceMemberAccessForActor(db, workspaceId, actorId)).hasMembership;
}

interface PageAccessAuthoritySnapshot {
  freshWorkspace: WorkspaceLike | null;
  memberRole: ShareRole | undefined;
  hasWorkspaceMembership: boolean;
  workspaceMemberId: string | undefined;
  workspaceMemberRole: string | null | undefined;
  groupIds: Set<string>;
}

export interface PageAccessDecision {
  role: ShareRole | undefined;
  canManage: boolean;
  directPermissions: PagePermissionLike[];
}

interface LeasedAuthorityFlight {
  promise: Promise<PageAccessAuthoritySnapshot>;
  consumers: number;
}

const pageAccessAuthorityFlights = new WeakMap<DbRef, Map<string, LeasedAuthorityFlight>>();
const pageAccessDecisionFlights = new WeakMap<DbRef, Map<string, Promise<PageAccessDecision>>>();

function authorityFlightKey(workspaceId: string, actorId: string, requireWorkspace: boolean) {
  return JSON.stringify([workspaceId, actorId, requireWorkspace]);
}

function decisionFlightKey(
  page: PageLike,
  actorId: string,
  workspace: WorkspaceLike | null | undefined,
  actorEmail: string | null | undefined,
  options: PageAccessOptions | undefined,
) {
  return JSON.stringify([
    page.id,
    page.workspaceId,
    page.parentId ?? null,
    page.parentType ?? null,
    page.teamspaceId ?? null,
    page.teamspacePermissionMode ?? null,
    page.createdBy ?? null,
    actorId,
    normalizeAccessEmail(actorEmail),
    workspace
      ? [workspace.id, workspace.ownerId ?? null, workspace.organizationId ?? null]
      : null,
    options?.requireWorkspace === true,
    options?.includeDirectPermissionMetadata === true,
  ]);
}

function acquirePageAccessAuthority(
  db: DbRef,
  key: string,
  work: () => Promise<PageAccessAuthoritySnapshot>,
) {
  let flights = pageAccessAuthorityFlights.get(db);
  if (!flights) {
    flights = new Map();
    pageAccessAuthorityFlights.set(db, flights);
  }
  const existing = flights.get(key);
  if (existing) {
    existing.consumers += 1;
    let released = false;
    return {
      promise: existing.promise,
      release() {
        if (released) return;
        released = true;
        existing.consumers -= 1;
        if (existing.consumers === 0 && flights?.get(key) === existing) {
          flights.delete(key);
          if (flights.size === 0) pageAccessAuthorityFlights.delete(db);
        }
      },
    };
  }

  // Bound only the coalescing metadata. At capacity, a new distinct authority
  // decision executes normally rather than waiting behind or displacing an
  // existing fresh decision.
  if (flights.size >= PAGE_ACCESS_MAX_IN_FLIGHT_KEYS) {
    return { promise: work(), release() {} };
  }

  const created: LeasedAuthorityFlight = { promise: work(), consumers: 1 };
  flights.set(key, created);
  let released = false;
  return {
    promise: created.promise,
    release() {
      if (released) return;
      released = true;
      created.consumers -= 1;
      if (created.consumers === 0 && flights?.get(key) === created) {
        flights.delete(key);
        if (flights.size === 0) pageAccessAuthorityFlights.delete(db);
      }
    },
  };
}

function pageAccessDecisionSingleFlight(
  db: DbRef,
  key: string,
  work: () => Promise<PageAccessDecision>,
) {
  let flights = pageAccessDecisionFlights.get(db);
  if (!flights) {
    flights = new Map();
    pageAccessDecisionFlights.set(db, flights);
  }
  const existing = flights.get(key);
  if (existing) return existing;
  if (flights.size >= PAGE_ACCESS_MAX_IN_FLIGHT_KEYS) return work();

  const pending = work();
  flights.set(key, pending);
  const cleanup = () => {
    if (flights?.get(key) !== pending) return;
    flights.delete(key);
    if (flights.size === 0) pageAccessDecisionFlights.delete(db);
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

async function freshPageAccessAuthority(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  requireWorkspace: boolean,
): Promise<PageAccessAuthoritySnapshot> {
  const freshWorkspace = await getExisting(db.table<WorkspaceLike>('workspaces'), workspaceId);
  if (!freshWorkspace && requireWorkspace) throw new Error('Workspace was not found.');
  const organizationMember = await organizationMemberForNotDeactivatedWorkspace(
    db,
    workspaceId,
    actorId,
    freshWorkspace,
  );
  const [memberAccess, groupIds] = await Promise.all([
    workspaceMemberAccessForActor(db, workspaceId, actorId),
    actorGroupIdsForOrganizationMember(
      db,
      freshWorkspace?.organizationId,
      actorId,
      organizationMember,
    ),
  ]);
  return {
    freshWorkspace,
    memberRole: memberAccess.role,
    hasWorkspaceMembership: memberAccess.hasMembership,
    workspaceMemberId: memberAccess.membershipId,
    workspaceMemberRole: memberAccess.membershipRole,
    groupIds,
  };
}

async function pageAccessAncestry(db: DbRef, page: PageLike) {
  const pages = db.table<PageLike>('pages');
  const visited = new Set<string>();
  const ancestry: PageLike[] = [];
  let current: PageLike | null = page;

  while (current && !visited.has(current.id)) {
    // The starting page is not its own ancestor. Preserve the established
    // product boundary of 256 distinct parents beyond that starting page.
    if (visited.size > PAGE_ACCESS_ANCESTOR_LIMIT) {
      throw new Error(`Page ancestry exceeds ${PAGE_ACCESS_ANCESTOR_LIMIT} ancestors.`);
    }
    visited.add(current.id);
    ancestry.push(current);
    if (!current.parentId || current.parentType === 'workspace') break;
    current = await getExisting(pages, current.parentId);
  }
  return ancestry;
}

async function pageAccessAncestries(
  db: DbRef,
  startingPages: PageLike[],
  knownPages: PageLike[] = [],
) {
  if (startingPages.length > PAGE_ACCESS_BATCH_MAX_PAGES) {
    throw new Error(`Page access batches support at most ${PAGE_ACCESS_BATCH_MAX_PAGES} pages.`);
  }
  if (knownPages.length > PAGE_ACCESS_KNOWN_MAX_PAGES) {
    throw new Error(`Page access batches support at most ${PAGE_ACCESS_KNOWN_MAX_PAGES} known pages.`);
  }
  const pagesById = new Map(
    [...knownPages, ...startingPages].map((page) => [page.id, page]),
  );
  const missingParentsFor = (pages: PageLike[]) => {
    const missing = new Set<string>();
    for (const page of pages) {
      const visited = new Set<string>();
      let current: PageLike | undefined = page;
      while (
        current
        && current.parentType !== 'workspace'
        && current.parentId
        && !visited.has(current.id)
      ) {
        if (visited.size > PAGE_ACCESS_ANCESTOR_LIMIT) {
          throw new Error(`Page ancestry exceeds ${PAGE_ACCESS_ANCESTOR_LIMIT} ancestors.`);
        }
        visited.add(current.id);
        const parent = pagesById.get(current.parentId);
        if (!parent) {
          missing.add(current.parentId);
          break;
        }
        current = parent;
      }
    }
    return Array.from(missing);
  };
  let frontier = missingParentsFor(startingPages);

  for (let depth = 0; frontier.length > 0 && depth < PAGE_ACCESS_ANCESTOR_LIMIT; depth += 1) {
    const loaded: PageLike[] = [];
    for (let offset = 0; offset < frontier.length; offset += PAGE_ACCESS_PERMISSION_CHUNK_SIZE) {
      const ids = frontier.slice(offset, offset + PAGE_ACCESS_PERMISSION_CHUNK_SIZE);
      const idSet = new Set(ids);
      const pages = await listAll(
        projectFields(
          db.table<PageLike>('pages').where('id', 'in', ids),
          PAGE_ACCESS_PAGE_FIELDS,
        ),
        {
          maxItems: ids.length,
          pageSize: ids.length,
          label: 'Batched page access ancestors',
        },
      );
      loaded.push(...pages.filter((page) => idSet.has(page.id)));
    }
    for (const page of loaded) pagesById.set(page.id, page);
    frontier = missingParentsFor(loaded);
  }
  if (frontier.length > 0) {
    throw new Error(`Page ancestry exceeds ${PAGE_ACCESS_ANCESTOR_LIMIT} ancestors.`);
  }

  return new Map(startingPages.map((page) => {
    const ancestry: PageLike[] = [];
    const visited = new Set<string>();
    let current: PageLike | undefined = page;
    while (current && !visited.has(current.id)) {
      if (visited.size > PAGE_ACCESS_ANCESTOR_LIMIT) {
        throw new Error(`Page ancestry exceeds ${PAGE_ACCESS_ANCESTOR_LIMIT} ancestors.`);
      }
      visited.add(current.id);
      ancestry.push(current);
      if (!current.parentId || current.parentType === 'workspace') break;
      current = pagesById.get(current.parentId);
    }
    return [page.id, ancestry];
  }));
}

async function pagePermissionChunk(
  db: DbRef,
  pageIds: string[],
  fields: readonly string[],
) {
  const table = db.table<PagePermissionLike>('page_permissions');
  const pageIdSet = new Set(pageIds);
  const aggregate = await listAllTruncated(
    projectFields(
      table.where('pageId', 'in', pageIds),
      fields,
    ),
    {
      maxItems: PAGE_ACCESS_PERMISSION_WIRE_MAX_ITEMS,
      pageSize: PAGE_ACCESS_PERMISSION_WIRE_MAX_ITEMS,
      label: 'Page access permission chunk',
    },
  );
  if (aggregate.complete) {
    return aggregate.items.filter((permission) => pageIdSet.has(permission.pageId));
  }

  // The aggregate response exceeded its wire budget. Preserve the previous
  // complete per-page semantics instead of dropping a grant beyond the prefix.
  const permissions: PagePermissionLike[] = [];
  for (const pageId of pageIds) {
    const perPage = await listAll(
      projectFields(
        table.where('pageId', '==', pageId),
        fields,
      ),
      { label: 'Page access permission fallback' },
    );
    permissions.push(...perPage.filter((permission) => permission.pageId === pageId));
  }
  return permissions;
}

async function permissionsForPageAccessAncestry(
  db: DbRef,
  ancestry: PageLike[],
  includeDirectPermissionMetadata: boolean,
) {
  const fields = includeDirectPermissionMetadata
    ? PAGE_PERMISSION_ACCESS_PAYLOAD_FIELDS
    : PAGE_PERMISSION_ACCESS_FIELDS;
  const chunks: string[][] = [];
  for (let offset = 0; offset < ancestry.length; offset += PAGE_ACCESS_PERMISSION_CHUNK_SIZE) {
    chunks.push(
      ancestry.slice(offset, offset + PAGE_ACCESS_PERMISSION_CHUNK_SIZE).map((page) => page.id),
    );
  }
  return (await Promise.all(chunks.map((chunk) => pagePermissionChunk(db, chunk, fields)))).flat();
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
  await organizationMemberForNotDeactivatedWorkspace(db, workspaceId, actorId, workspace);
  if (workspace?.ownerId === actorId) return 'full_access';
  return workspaceMemberRoleForActor(db, workspaceId, actorId);
}

export async function assertMinimumWorkspaceAccessRole(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  minimum: ShareRole,
  options?: PageAccessOptions,
) {
  const role = await workspaceAccessRole(db, workspaceId, actorId, options);
  if (role && pageAccessRoleRanks[role] >= pageAccessRoleRanks[minimum]) return role;
  throw new Error('Workspace access required.');
}

async function resolvePageAccessDecision(
  db: DbRef,
  page: PageLike,
  actorId: string,
  workspace?: WorkspaceLike | null,
  actorEmail?: string | null,
  options?: PageAccessOptions,
) {
  const requireFreshWorkspace = options?.requireWorkspace === true && !workspace;
  const authority = acquirePageAccessAuthority(
    db,
    authorityFlightKey(page.workspaceId, actorId, requireFreshWorkspace),
    () => freshPageAccessAuthority(db, page.workspaceId, actorId, requireFreshWorkspace),
  );
  try {
    const authoritySnapshot = await authority.promise;
    const { freshWorkspace } = authoritySnapshot;
    const resolvedWorkspace = workspace ?? freshWorkspace;
    if (!resolvedWorkspace && options?.requireWorkspace) throw new Error('Workspace was not found.');

    const ancestry = await pageAccessAncestry(db, page);
    const permissions = await permissionsForPageAccessAncestry(
      db,
      ancestry,
      options?.includeDirectPermissionMetadata === true,
    );
    const permissionsByPageId = new Map<string, PagePermissionLike[]>();
    for (const permission of permissions) {
      const pagePermissions = permissionsByPageId.get(permission.pageId);
      if (pagePermissions) pagePermissions.push(permission);
      else permissionsByPageId.set(permission.pageId, [permission]);
    }
    return resolvePageAccessDecisionFromMaterialized(
      db,
      page,
      ancestry,
      actorId,
      actorEmail,
      resolvedWorkspace,
      authoritySnapshot,
      permissionsByPageId,
    );
  } finally {
    authority.release();
  }
}

type TeamspaceAccessDecision = Awaited<ReturnType<typeof teamspaceAccessDecision>>;

async function resolvePageAccessDecisionFromMaterialized(
  db: DbRef,
  page: PageLike,
  ancestry: PageLike[],
  actorId: string,
  actorEmail: string | null | undefined,
  resolvedWorkspace: WorkspaceLike | null | undefined,
  authority: PageAccessAuthoritySnapshot,
  permissionsByPageId: Map<string, PagePermissionLike[]>,
  teamspaceDecisions?: Map<string, TeamspaceAccessDecision>,
): Promise<PageAccessDecision> {
  const {
    memberRole,
    hasWorkspaceMembership,
    workspaceMemberId,
    workspaceMemberRole,
    groupIds,
  } = authority;
  const teamspaceRoot = ancestry.find((candidate) => (
    candidate.parentType === 'workspace'
    && typeof candidate.teamspaceId === 'string'
    && candidate.teamspaceId.length > 0
  ));
  const restrictedByTeamspacePage = !!teamspaceRoot && ancestry.some(
    (candidate) => candidate.teamspacePermissionMode === 'restricted',
  );

  let role: ShareRole | undefined;
  const isOwner = resolvedWorkspace?.ownerId === actorId;
  let teamspaceOwner = false;
  if (teamspaceRoot?.teamspaceId) {
    const teamspaceDecision = teamspaceDecisions?.get(teamspaceRoot.teamspaceId)
      ?? await teamspaceAccessDecision(db, teamspaceRoot.teamspaceId, {
        actorId,
        workspaceMemberId,
        workspaceMemberRole,
        groupIds,
      });
    const exactWorkspaceTeamspace = teamspaceDecision.teamspace?.workspaceId === page.workspaceId;
    teamspaceOwner = exactWorkspaceTeamspace
      && teamspaceDecision.membershipRole === 'owner'
      && !teamspaceDecision.teamspace?.archivedAt;
    if (teamspaceOwner) role = 'full_access';
    else if (exactWorkspaceTeamspace && !restrictedByTeamspacePage) {
      role = teamspaceDecision.pageRole;
    }
  } else {
    if (isOwner) role = 'full_access';
    role = maxPageShareRole(role, memberRole);
    // The legacy creator shortcut remains scoped to non-Teamspace roots.
    // Teamspace restriction explicitly removes inherited/creator defaults;
    // only Teamspace owners and direct page grants survive that boundary.
    if (page.createdBy === actorId && (isOwner || memberRole !== undefined)) {
      role = maxPageShareRole(role, 'edit');
    }
  }

  const directPermissions: PagePermissionLike[] = [];
  for (const current of ancestry) {
    const currentPermissions = permissionsByPageId.get(current.id) ?? [];
    role = maxPageShareRole(
      role,
      permissionRoleForActor(currentPermissions, actorId, groupIds, actorEmail),
    );
    if (current.id === page.id) directPermissions.push(...currentPermissions);
  }
  return {
    role,
    canManage:
      role === 'full_access'
      || teamspaceOwner
      || (!teamspaceRoot && page.createdBy === actorId && (isOwner || hasWorkspaceMembership)),
    directPermissions,
  };
}

export async function pageAccessDecisions(
  db: DbRef,
  pages: PageLike[],
  actorId: string,
  workspace?: WorkspaceLike | null,
  actorEmail?: string | null,
  options?: PageAccessBatchOptions,
) {
  if (pages.length === 0) return new Map<string, PageAccessDecision>();
  if (pages.length > PAGE_ACCESS_DRAIN_MAX_PAGES) {
    throw new Error(`Page access drains support at most ${PAGE_ACCESS_DRAIN_MAX_PAGES} pages.`);
  }
  const workspaceId = pages[0]!.workspaceId;
  if (pages.some((page) => page.workspaceId !== workspaceId)) {
    throw new Error('Page access batches require one workspace.');
  }
  if ((options?.knownPages?.length ?? 0) > PAGE_ACCESS_KNOWN_MAX_PAGES) {
    throw new Error(`Page access batches support at most ${PAGE_ACCESS_KNOWN_MAX_PAGES} known pages.`);
  }
  if (options?.knownPages?.some((page) => page.workspaceId !== workspaceId)) {
    throw new Error('Known page access ancestors require the same workspace.');
  }
  const requireFreshWorkspace = options?.requireWorkspace === true && !workspace;
  const authority = acquirePageAccessAuthority(
    db,
    authorityFlightKey(workspaceId, actorId, requireFreshWorkspace),
    () => freshPageAccessAuthority(db, workspaceId, actorId, requireFreshWorkspace),
  );
  try {
    const authoritySnapshot = await authority.promise;
    const resolvedWorkspace = workspace ?? authoritySnapshot.freshWorkspace;
    if (!resolvedWorkspace && options?.requireWorkspace) throw new Error('Workspace was not found.');

    const teamspaceDecisions = new Map<string, TeamspaceAccessDecision>();
    const decisions = new Map<string, PageAccessDecision>();
    for (let offset = 0; offset < pages.length; offset += PAGE_ACCESS_BATCH_MAX_PAGES) {
      const batch = pages.slice(offset, offset + PAGE_ACCESS_BATCH_MAX_PAGES);
      const ancestries = await pageAccessAncestries(db, batch, options?.knownPages);
      const uniqueAncestryById = new Map<string, PageLike>();
      for (const ancestry of ancestries.values()) {
        for (const page of ancestry) uniqueAncestryById.set(page.id, page);
      }
      const permissions = await permissionsForPageAccessAncestry(
        db,
        Array.from(uniqueAncestryById.values()),
        options?.includeDirectPermissionMetadata === true,
      );
      const permissionsByPageId = new Map<string, PagePermissionLike[]>();
      for (const permission of permissions) {
        const current = permissionsByPageId.get(permission.pageId);
        if (current) current.push(permission);
        else permissionsByPageId.set(permission.pageId, [permission]);
      }
      const missingTeamspaceIds = new Set<string>();
      for (const ancestry of ancestries.values()) {
        const teamspaceRoot = ancestry.find((candidate) => (
          candidate.parentType === 'workspace'
          && typeof candidate.teamspaceId === 'string'
          && candidate.teamspaceId.length > 0
        ));
        if (
          teamspaceRoot?.teamspaceId
          && !teamspaceDecisions.has(teamspaceRoot.teamspaceId)
        ) {
          missingTeamspaceIds.add(teamspaceRoot.teamspaceId);
        }
      }
      const loadedTeamspaceDecisions = await Promise.all(
        Array.from(missingTeamspaceIds, async (teamspaceId) => [
          teamspaceId,
          await teamspaceAccessDecision(db, teamspaceId, {
            actorId,
            workspaceMemberId: authoritySnapshot.workspaceMemberId,
            workspaceMemberRole: authoritySnapshot.workspaceMemberRole,
            groupIds: authoritySnapshot.groupIds,
          }),
        ] as const),
      );
      for (const [teamspaceId, decision] of loadedTeamspaceDecisions) {
        teamspaceDecisions.set(teamspaceId, decision);
      }
      for (const page of batch) {
        decisions.set(
          page.id,
          await resolvePageAccessDecisionFromMaterialized(
            db,
            page,
            ancestries.get(page.id) ?? [page],
            actorId,
            actorEmail,
            resolvedWorkspace,
            authoritySnapshot,
            permissionsByPageId,
            teamspaceDecisions,
          ),
        );
      }
    }
    return decisions;
  } finally {
    authority.release();
  }
}

export function pageAccessDecision(
  db: DbRef,
  page: PageLike,
  actorId: string,
  workspace?: WorkspaceLike | null,
  actorEmail?: string | null,
  options?: PageAccessOptions,
) {
  return pageAccessDecisionSingleFlight(
    db,
    decisionFlightKey(page, actorId, workspace, actorEmail, options),
    () => resolvePageAccessDecision(db, page, actorId, workspace, actorEmail, options),
  );
}

export async function pageAccessRole(
  db: DbRef,
  page: PageLike,
  actorId: string,
  workspace?: WorkspaceLike | null,
  actorEmail?: string | null,
  options?: PageAccessOptions,
) {
  return (await pageAccessDecision(db, page, actorId, workspace, actorEmail, options)).role;
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
  return (await pageAccessDecision(db, page, actorId, workspace, actorEmail)).canManage;
}
