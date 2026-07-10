import { defineFunction } from '@edge-base/shared';
import {
  ensurePageWorkspaceIndex,
  boundedDb,
  discoverPermissionWorkspaceIds,
  resolvePageWorkspaceId,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import {
  actorPagePermissions,
  pageHasDirectAccess as sharedPageHasDirectAccess,
} from '../lib/page-access';
import { conservativeChangeCursor, readChangeFeed } from '../lib/change-log';
import { seedDefaultWorkspacePages } from '../lib/default-workspace-pages';
import { upsertNotification } from '../lib/notifications';

import {
  bestEffort,
  listAll,
  getExisting,
  type TableQuery,
  type TransactDb,
} from '../lib/table-utils';
import type { DbRef as AppDbRef } from '../lib/app-types';
import type { ShareRole } from '../lib/page-access';
import {
  maxPageShareRole as maxRole,
  isPageShareRole as isShareRole,
  workspaceMemberShareRole,
} from '../lib/page-access';

interface Workspace {
  id: string;
  organizationId?: string | null;
  name: string;
  icon?: string;
  domain?: string;
  ownerId?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Organization {
  id: string;
  name: string;
  icon?: string | null;
  ownerId?: string;
  workspaceCreationPolicy?: string;
  domainSignupPolicy?: string;
  sharingPolicy?: Record<string, unknown> | null;
  storageLimitBytes?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  role: string;
  status?: string;
  createdBy?: string;
  deactivatedAt?: string | null;
  deactivatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationDomain {
  id: string;
  organizationId: string;
  domain: string;
  status?: string;
  createdBy?: string;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
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

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  kind?: string;
  title?: string;
  isFavorite?: boolean;
  isPublic?: boolean;
  inTrash?: boolean;
  position?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Block {
  id: string;
  pageId: string;
  parentId?: string | null;
  type: string;
  content?: unknown;
  position?: number;
}

interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  displayName?: string;
  email?: string;
  avatar?: string | null;
  role: string;
  createdBy?: string;
}

type OrganizationMemberRole = 'owner' | 'admin' | 'member' | 'guest';

interface PagePermission {
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

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
  limit(n: number): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface FunctionContext {
  auth: { id: string; email?: string; isAnonymous?: boolean } | null;
  request?: Request;
  admin: {
    db(namespace: string): DbRef;
  };
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

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

function normalizeEmail(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function normalizeWorkspaceSlug(value: unknown) {
  if (typeof value !== 'string') return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || null;
}

function parseOrganizationRole(
  value: unknown,
  fallback: OrganizationMemberRole = 'member',
): OrganizationMemberRole {
  if (typeof value !== 'string') return fallback;
  const role = value.trim().toLowerCase();
  if (role === 'owner' || role === 'admin' || role === 'member' || role === 'guest') return role;
  return fallback;
}

const organizationAdminRoles = new Set<OrganizationMemberRole>(['owner', 'admin']);

// Owner shortcut + the shared member-role mapping; the bulk role walk below is
// a deliberate batch variant of lib/page-access (precomputed permission maps),
// but the role vocabulary itself must never drift from the shared lib.
function workspaceMemberRole(
  workspace: Workspace,
  member: WorkspaceMember | undefined,
  actorId: string,
): ShareRole | undefined {
  if (workspace.ownerId === actorId) return 'full_access';
  return workspaceMemberShareRole(member?.role);
}

function sortOrganizations(items: Organization[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationMembers(items: OrganizationMember[]) {
  const roleRank: Record<OrganizationMemberRole, number> = {
    owner: 4,
    admin: 3,
    member: 2,
    guest: 1,
  };
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.status ?? 'active').localeCompare(String(b.status ?? 'active')) ||
        roleRank[parseOrganizationRole(b.role, 'member')] - roleRank[parseOrganizationRole(a.role, 'member')] ||
        String(a.displayName ?? a.email ?? a.userId).localeCompare(
          String(b.displayName ?? b.email ?? b.userId),
        ) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationDomains(items: OrganizationDomain[]) {
  const statusRank: Record<string, number> = { verified: 0, pending: 1, rejected: 2 };
  return items
    .slice()
    .sort(
      (a, b) =>
        (statusRank[a.status ?? 'pending'] ?? 9) - (statusRank[b.status ?? 'pending'] ?? 9) ||
        String(a.domain ?? '').localeCompare(String(b.domain ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

function organizationNameFor(authEmail: string | null) {
  if (!authEmail) return 'Personal Organization';
  const local = authEmail.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  if (!local) return 'Personal Organization';
  return `${local.charAt(0).toUpperCase()}${local.slice(1)} Organization`;
}

async function recordOrganizationAudit(
  db: DbRef,
  event: Omit<OrganizationAuditEvent, 'id'>,
) {
  await bestEffort('workspace-bootstrap db.table<OrganizationAuditEven', db.table<OrganizationAuditEvent>('organization_audit_events').insert(event));
}

// Atomic insert-if-absent for the check-then-insert ensure* helpers below:
// concurrent bootstraps both pass the read and would insert duplicate rows.
// The runtime's transact `expect exists:false` aborts the loser's insert at
// commit time; null tells the caller to re-read the winner's row.
async function insertIfAbsent<T extends { id: string }>(
  db: DbRef,
  table: string,
  where: Array<[string, '==', unknown]>,
  data: Record<string, unknown>,
): Promise<T | null> {
  try {
    const { results } = await db.transact([
      { table, op: 'expect', where, exists: false },
      { table, op: 'insert', data },
    ]);
    return ((results[1] as { inserted?: T } | undefined)?.inserted) ?? null;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Transaction expectation failed')) {
      return null;
    }
    throw error;
  }
}

async function ensureOrganizationMember(
  db: DbRef,
  members: TableRef<OrganizationMember>,
  organization: Organization,
  actorId: string,
  authEmail: string | null,
  role: OrganizationMemberRole = 'owner',
) {
  const existing = (await listAll(members.where('organizationId', '==', organization.id))).find(
    (member) => member.userId === actorId,
  );
  const patch: Partial<OrganizationMember> = {
    email: authEmail,
    status: existing?.status ?? 'active',
  };
  if (existing) {
    if (
      normalizeEmail(existing.email) !== authEmail ||
      (existing.status ?? 'active') !== 'active'
    ) {
      return members.update(existing.id, patch);
    }
    return existing;
  }
  const inserted = await insertIfAbsent<OrganizationMember>(
    db,
    'organization_members',
    [['organizationId', '==', organization.id], ['userId', '==', actorId]],
    {
      organizationId: organization.id,
      userId: actorId,
      role,
      email: authEmail,
      status: 'active',
      createdBy: actorId,
    },
  );
  if (inserted) return inserted;
  const winner = (await listAll(members.where('organizationId', '==', organization.id))).find(
    (member) => member.userId === actorId,
  );
  if (winner) return winner;
  throw new Error('Organization member could not be created.');
}

async function ensureDefaultOrganization(db: DbRef, actorId: string, authEmail: string | null) {
  const organizations = db.table<Organization>('organizations');
  const members = db.table<OrganizationMember>('organization_members');
  const owned = sortOrganizations(await listAll(organizations.where('ownerId', '==', actorId)));
  const existing = owned[0] ?? null;
  if (existing) {
    const member = await ensureOrganizationMember(db, members, existing, actorId, authEmail, 'owner');
    return { organization: existing, currentOrganizationMember: member };
  }

  const now = new Date().toISOString();
  // Guarded on ownerId so two concurrent bootstraps cannot both create a
  // default organization for the same actor (see insertIfAbsent).
  const organization = await insertIfAbsent<Organization>(db, 'organizations', [['ownerId', '==', actorId]], {
    name: organizationNameFor(authEmail),
    icon: '🏢',
    ownerId: actorId,
    workspaceCreationPolicy: 'owners_admins',
    domainSignupPolicy: 'invite_only',
    sharingPolicy: {
      publicWebSharing: true,
      externalEmailSharing: true,
      guestAccess: true,
      fileDownloads: true,
      fullAccessGrants: true,
    },
    createdAt: now,
    updatedAt: now,
  });
  if (!organization) {
    // A concurrent bootstrap created it between the read and the guard.
    const winner = sortOrganizations(await listAll(organizations.where('ownerId', '==', actorId)))[0];
    if (!winner) throw new Error('Organization could not be created.');
    const member = await ensureOrganizationMember(db, members, winner, actorId, authEmail, 'owner');
    return { organization: winner, currentOrganizationMember: member };
  }
  const member = await ensureOrganizationMember(db, members, organization, actorId, authEmail, 'owner');
  await recordOrganizationAudit(db, {
    organizationId: organization.id,
    workspaceId: null,
    actorId,
    action: 'organization.create',
    targetType: 'organization',
    targetId: organization.id,
    metadata: { source: 'workspace-bootstrap' },
    occurredAt: now,
  });
  return { organization, currentOrganizationMember: member };
}

async function actorOrganizationMembership(
  db: DbRef,
  organizationId: string,
  actorId: string,
) {
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
  );
  return members.find(
    (member) => member.userId === actorId && (member.status ?? 'active') === 'active',
  ) ?? null;
}

async function actorDeactivatedOrganizationMembership(
  db: DbRef,
  organizationId: string,
  actorId: string,
) {
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
  );
  return members.find(
    (member) => member.userId === actorId && (member.status ?? 'active') === 'deactivated',
  ) ?? null;
}

async function hasActiveOrganizationMembership(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
) {
  if (!workspace.organizationId) return true;
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    workspace.organizationId,
  );
  if (!organization) return true;
  if (organization.ownerId === actorId) return true;
  return !!(await actorOrganizationMembership(db, organization.id, actorId));
}

async function isDeactivatedInWorkspaceOrganization(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
) {
  if (!workspace.organizationId) return false;
  return !!(await actorDeactivatedOrganizationMembership(db, workspace.organizationId, actorId));
}

async function organizationForWorkspace(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
  authEmail: string | null,
) {
  const organizations = db.table<Organization>('organizations');
  const workspaces = db.table<Workspace>('workspaces');
  if (workspace.organizationId) {
    const organization = await getExisting(organizations, workspace.organizationId);
    if (organization) {
      const currentOrganizationMember =
        await actorOrganizationMembership(db, organization.id, actorId) ??
        (organization.ownerId === actorId
          ? await ensureOrganizationMember(
              db,
              db.table<OrganizationMember>('organization_members'),
              organization,
              actorId,
              authEmail,
              'owner',
            )
          : null);
      return { organization, currentOrganizationMember };
    }
  }

  if (workspace.ownerId && workspace.ownerId !== actorId) {
    return { organization: null, currentOrganizationMember: null };
  }

  const ensured = await ensureDefaultOrganization(db, actorId, authEmail);
  const updated = await workspaces.update(workspace.id, {
    organizationId: ensured.organization.id,
  });
  workspace.organizationId = updated.organizationId;
  await recordOrganizationAudit(db, {
    organizationId: ensured.organization.id,
    workspaceId: workspace.id,
    actorId,
    action: 'workspace.link_organization',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: { source: 'lazy-backfill' },
    occurredAt: new Date().toISOString(),
  });
  return ensured;
}

async function pageHasDirectAccess(
  db: DbRef,
  pages: TableRef<Page>,
  permissions: TableRef<PagePermission>,
  page: Page,
  actorId: string,
  authEmail: string | null,
) {
  void pages;
  void permissions;
  return sharedPageHasDirectAccess(db, page, actorId, authEmail);
}

async function workspaceForSharedPage(
  admin: AdminDbAccessor,
  db: DbRef,
  workspaces: TableRef<Workspace>,
  pageId: string | undefined,
  actorId: string,
  authEmail: string | null,
) {
  if (!pageId) return null;
  const workspaceId = await resolvePageWorkspaceId(db, pageId);
  if (!workspaceId) return null;
  const contentDb = boundedDb(admin, workspaceId);
  const pages = contentDb.table<Page>('pages');
  const permissions = contentDb.table<PagePermission>('page_permissions');
  const page = await getExisting(pages, pageId);
  if (!page || page.inTrash) return null;
  if (!(await pageHasDirectAccess(contentDb, pages, permissions, page, actorId, authEmail))) return null;
  return getExisting(workspaces, page.workspaceId);
}

async function workspaceIsAccessible(
  db: DbRef,
  workspace: Workspace,
  members: TableRef<WorkspaceMember>,
  actorId: string,
) {
  if (workspace.ownerId === actorId) return true;
  const workspaceMembers = await listAll(members.where('workspaceId', '==', workspace.id));
  if (workspaceMembers.some((member) => member.userId === actorId)) {
    return hasActiveOrganizationMembership(db, workspace, actorId);
  }
  return false;
}

async function workspaceHasDirectPageAccess(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
  authEmail: string | null,
) {
  if (await isDeactivatedInWorkspaceOrganization(db, workspace, actorId)) return false;
  return (await actorPagePermissions(db, actorId, workspace.id, authEmail)).length > 0;
}

async function workspaceForPreferredPage(
  admin: AdminDbAccessor,
  db: DbRef,
  workspaces: TableRef<Workspace>,
  members: TableRef<WorkspaceMember>,
  pageId: string | undefined,
  actorId: string,
  authEmail: string | null,
): Promise<{ workspace: Workspace | null; status?: number; message?: string }> {
  if (!pageId) return { workspace: null };
  const pageWorkspaceId = await resolvePageWorkspaceId(db, pageId);
  if (!pageWorkspaceId) {
    return { workspace: null, status: 404, message: 'This page is unavailable.' };
  }
  const contentDb = boundedDb(admin, pageWorkspaceId);
  const pages = contentDb.table<Page>('pages');
  const permissions = contentDb.table<PagePermission>('page_permissions');
  const page = await getExisting(pages, pageId);
  if (!page) {
    return { workspace: null, status: 404, message: 'This page is unavailable.' };
  }
  const workspace = await getExisting(workspaces, page.workspaceId);
  if (!workspace) {
    return { workspace: null, status: 404, message: 'This page is unavailable.' };
  }
  if (await workspaceIsAccessible(db, workspace, members, actorId)) {
    return { workspace };
  }
  if (!page.inTrash && (await pageHasDirectAccess(contentDb, pages, permissions, page, actorId, authEmail))) {
    if (await isDeactivatedInWorkspaceOrganization(db, workspace, actorId)) {
      return {
        workspace: null,
        status: 403,
        message: 'Organization active membership required.',
      };
    }
    return { workspace };
  }
  return {
    workspace: null,
    status: page.inTrash ? 404 : 403,
    message: page.inTrash ? 'This page is unavailable.' : 'You do not have access to this page.',
  };
}

async function findWorkspace(
  admin: AdminDbAccessor,
  db: DbRef,
  workspaces: TableRef<Workspace>,
  members: TableRef<WorkspaceMember>,
  preferredId: string | undefined,
  preferredSlug: string | null,
  preferredPageId: string | undefined,
  actorId: string,
  authEmail: string | null,
): Promise<Workspace | null> {
  const sharedPageWorkspace = await workspaceForSharedPage(
    admin,
    db,
    workspaces,
    preferredPageId,
    actorId,
    authEmail,
  );
  if (sharedPageWorkspace) return sharedPageWorkspace;

  if (preferredSlug) {
    const matches = await listAll(workspaces.where('domain', '==', preferredSlug));
    for (const workspace of matches) {
      if (await workspaceIsAccessible(db, workspace, members, actorId)) {
        return workspace;
      }
    }
  }

  if (preferredId) {
    const preferred = await getExisting(workspaces, preferredId);
    if (
      preferred &&
      ((await workspaceIsAccessible(db, preferred, members, actorId)) ||
        (await workspaceHasDirectPageAccess(boundedDb(admin, preferred.id), preferred, actorId, authEmail)))
    ) {
      return preferred;
    }
  }

  const owned = await listAll(workspaces.where('ownerId', '==', actorId));
  if (owned[0]) return owned[0];

  const membership = (await listAll(members.where('userId', '==', actorId)))[0];
  if (membership) {
    const workspace = await getExisting(workspaces, membership.workspaceId);
    if (
      workspace &&
      (await workspaceIsAccessible(db, workspace, members, actorId))
    ) {
      return workspace;
    }
  }

  const grantWorkspaceIds = await discoverPermissionWorkspaceIds(admin, actorId, authEmail);
  for (const grantWorkspaceId of grantWorkspaceIds) {
    if (!grantWorkspaceId) continue;
    const workspace = await getExisting(workspaces, grantWorkspaceId);
    if (
      workspace &&
      (await workspaceHasDirectPageAccess(boundedDb(admin, workspace.id), workspace, actorId, authEmail))
    ) {
      return workspace;
    }
  }

  return null;
}

function collectSubtreeIds(pages: Page[], rootId: string) {
  const childrenByParent = new Map<string, Page[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const children = childrenByParent.get(page.parentId) ?? [];
    children.push(page);
    childrenByParent.set(page.parentId, children);
  }

  const out = new Set<string>();
  const visit = (pageId: string) => {
    if (out.has(pageId)) return;
    out.add(pageId);
    for (const child of childrenByParent.get(pageId) ?? []) visit(child.id);
  };
  visit(rootId);
  return out;
}

async function visiblePagesForBootstrap(
  workspacePages: Page[],
  directPermissions: PagePermission[],
  workspace: Workspace,
  hasWorkspaceAccess: boolean,
  preferredPageId?: string | null,
) {
  const shouldInclude = (page: Page) => page.parentType !== 'database' || page.id === preferredPageId;

  if (hasWorkspaceAccess) return workspacePages.filter(shouldInclude);

  const visiblePageIds = new Set<string>();
  for (const permission of directPermissions) {
    for (const pageId of collectSubtreeIds(workspacePages, permission.pageId)) {
      visiblePageIds.add(pageId);
    }
  }

  return workspacePages.filter((page) => visiblePageIds.has(page.id) && shouldInclude(page));
}

function pageRolesForBootstrap(
  visiblePages: Page[],
  workspacePages: Page[],
  directPermissions: PagePermission[],
  workspace: Workspace,
  currentMember: WorkspaceMember | undefined,
  actorId: string,
  hasWorkspaceAccess: boolean,
) {
  const pagesById = new Map(workspacePages.map((page) => [page.id, page]));
  const permissionsByPage = new Map<string, PagePermission[]>();
  for (const permission of directPermissions) {
    const list = permissionsByPage.get(permission.pageId) ?? [];
    list.push(permission);
    permissionsByPage.set(permission.pageId, list);
  }

  const baseRole = hasWorkspaceAccess
    ? workspaceMemberRole(workspace, currentMember, actorId)
    : undefined;
  const roles: Record<string, ShareRole> = {};
  for (const page of visiblePages) {
    let role = baseRole;
    if (page.createdBy === actorId) role = maxRole(role, 'edit');

    const visited = new Set<string>();
    let current: Page | undefined = page;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      for (const permission of permissionsByPage.get(current.id) ?? []) {
        const permissionRole = permission.role;
        if (isShareRole(permissionRole)) {
          role = maxRole(role, permissionRole);
        }
      }
      if (!current.parentId || current.parentType === 'workspace') break;
      current = pagesById.get(current.parentId);
    }

    if (role) roles[page.id] = role;
  }
  return roles;
}

function sharedPageIdsForBootstrap(visiblePages: Page[], permissions: PagePermission[]) {
  const visiblePageIds = new Set(visiblePages.map((page) => page.id));
  const ids = new Set<string>();
  for (const permission of permissions) {
    if (!visiblePageIds.has(permission.pageId)) continue;
    if (!isShareRole(permission.role)) continue;
    if (permission.principalType === 'integration') continue;
    ids.add(permission.pageId);
  }
  return Array.from(ids);
}

function pageTitle(page: Page | undefined) {
  return page?.title?.trim() || 'Untitled';
}

function shareRoleLabel(role: ShareRole) {
  if (role === 'full_access') return 'Full access';
  if (role === 'edit') return 'Can edit';
  if (role === 'comment') return 'Can comment';
  return 'Can view';
}

function shareNotificationTime(permission: PagePermission) {
  const raw = permission.updatedAt ?? permission.createdAt;
  if (raw) {
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) {
      return { occurredAt: new Date(timestamp).toISOString(), atKey: String(timestamp) };
    }
    return { occurredAt: raw, atKey: raw };
  }
  return { occurredAt: '1970-01-01T00:00:00.000Z', atKey: 'unknown' };
}

async function upsertActorShareNotifications(
  db: DbRef,
  workspacePages: Page[],
  directPermissions: PagePermission[],
  actorId: string,
) {
  if (!directPermissions.length) return;
  const pagesById = new Map(workspacePages.map((page) => [page.id, page]));
  for (const permission of directPermissions) {
    if (!isShareRole(permission.role)) continue;
    if (permission.principalType === 'integration') continue;
    if (permission.createdBy === actorId) continue;
    const page = pagesById.get(permission.pageId);
    if (!page) continue;
    const role = permission.role;
    const action =
      permission.createdAt && permission.updatedAt && permission.createdAt !== permission.updatedAt
        ? 'role_update'
        : 'invite';
    const { occurredAt, atKey } = shareNotificationTime(permission);
    const title = pageTitle(page);
    await bestEffort(`workspace-bootstrap share notification for ${actorId}`, upsertNotification(db as unknown as AppDbRef, {
      workspaceId: page.workspaceId,
      userId: actorId,
      activityKey: `share:${permission.id}:${actorId}:${atKey}`,
      kind: 'system',
      pageId: page.id,
      blockId: null,
      commentId: null,
      actorId: permission.createdBy ?? null,
      title,
      preview:
        action === 'invite'
          ? `You were invited to ${title} with ${shareRoleLabel(role)} access.`
          : `Your access to ${title} is now ${shareRoleLabel(role)}.`,
      target: `/p/${encodeURIComponent(page.id)}`,
      metadata: {
        source: 'share',
        action,
        permissionId: permission.id,
        role,
        principalType: permission.principalType,
      },
      occurredAt,
    }));
  }
}

async function rootBlockLayoutHintsForPage(blocks: TableRef<Block>, pageId: string) {
  const pageBlocks = await listAll(blocks.where('pageId', '==', pageId));
  const rootBlocks = pageBlocks.filter((block) => !block.parentId);
  return {
    hasRootColumnList: rootBlocks.some((block) => block.type === 'column_list'),
    hasRootInlineDatabase: rootBlocks.some((block) => block.type === 'inline_database'),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function blockContentRecord(block: Block) {
  if (typeof block.content === 'string') {
    try {
      return asRecord(JSON.parse(block.content));
    } catch {
      return null;
    }
  }
  return asRecord(block.content);
}

function blockChildPageId(block: Block) {
  const value = blockContentRecord(block)?.childPageId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function childPageProjectionBlocks(blocks: TableRef<Block>, pages: Page[]) {
  const anchorPages = pages.filter((page) =>
    !page.inTrash &&
    page.parentType !== 'database' &&
    (page.isFavorite || page.isPublic || !page.parentId || page.parentType === 'workspace')
  );
  const groups = await mapLimit(
    anchorPages,
    8,
    (page) => listAll(blocks.where('pageId', '==', page.id)),
  );
  return groups.flat();
}

function projectChildPageParentsForBootstrap(pages: Page[], blocks: Block[]) {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const projectedParents = new Map<string, { parentId: string; position?: number }>();
  for (const block of blocks) {
    if (block.type !== 'child_page' && block.type !== 'child_database') continue;
    const childPageId = blockChildPageId(block);
    if (!childPageId || childPageId === block.pageId) continue;
    const child = pagesById.get(childPageId);
    if (!child || child.parentType === 'database') continue;
    projectedParents.set(childPageId, {
      parentId: block.pageId,
      position: typeof block.position === 'number' ? block.position : undefined,
    });
  }
  if (!projectedParents.size) return pages;
  return pages.map((page) => {
    const parent = projectedParents.get(page.id);
    if (!parent || page.parentId === parent.parentId && page.parentType === 'page') return page;
    return {
      ...page,
      parentId: parent.parentId,
      parentType: 'page',
      position: parent.position ?? page.position,
    };
  });
}

async function ensureWorkspaceMember(
  db: DbRef,
  members: TableRef<WorkspaceMember>,
  workspace: Workspace,
  actorId: string,
  authEmail: string | null,
) {
  const existing = await listAll(members.where('workspaceId', '==', workspace.id));
  const current = existing.find((member) => member.userId === actorId);
  if (current) {
    if (authEmail && normalizeEmail(current.email) !== authEmail) {
      return members.update(current.id, { email: authEmail });
    }
    return current;
  }

  // Only the real owner may self-provision a membership. A workspace with no
  // owner must not let any authenticated caller insert themselves as owner
  // (fail-closed; normal creation always sets ownerId).
  if (!workspace.ownerId || workspace.ownerId !== actorId) {
    throw new Error('Workspace access required.');
  }

  const inserted = await insertIfAbsent<WorkspaceMember>(
    db,
    'workspace_members',
    [['workspaceId', '==', workspace.id], ['userId', '==', actorId]],
    {
      workspaceId: workspace.id,
      userId: actorId,
      role: workspace.ownerId === actorId ? 'owner' : 'member',
      createdBy: actorId,
    },
  );
  if (inserted) return inserted;
  const winner = (await listAll(members.where('workspaceId', '==', workspace.id))).find(
    (member) => member.userId === actorId,
  );
  if (winner) return winner;
  throw new Error('Workspace member could not be created.');
}

function sortMembers(items: WorkspaceMember[]) {
  return items
    .slice()
    .sort((a, b) =>
      String(a.displayName ?? a.email ?? a.userId).localeCompare(
        String(b.displayName ?? b.email ?? b.userId),
      ) || a.id.localeCompare(b.id),
    );
}

function sortWorkspaces(items: Workspace[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

async function accessibleWorkspaces(
  admin: AdminDbAccessor,
  db: DbRef,
  workspaces: TableRef<Workspace>,
  members: TableRef<WorkspaceMember>,
  actorId: string,
  authEmail: string | null,
) {
  const owned = await listAll(workspaces.where('ownerId', '==', actorId));
  const memberships = await listAll(members.where('userId', '==', actorId));
  const byId = new Map<string, Workspace>();
  for (const workspace of owned) byId.set(workspace.id, workspace);
  for (const membership of memberships) {
    const workspace = await getExisting(workspaces, membership.workspaceId);
    if (
      workspace &&
      (await workspaceIsAccessible(db, workspace, members, actorId))
    ) {
      byId.set(workspace.id, workspace);
    }
  }
  const grantWorkspaceIds = await discoverPermissionWorkspaceIds(admin, actorId, authEmail);
  for (const grantWorkspaceId of grantWorkspaceIds) {
    if (!grantWorkspaceId || byId.has(grantWorkspaceId)) continue;
    const workspace = await getExisting(workspaces, grantWorkspaceId);
    if (
      workspace &&
      (await workspaceHasDirectPageAccess(boundedDb(admin, workspace.id), workspace, actorId, authEmail))
    ) {
      byId.set(workspace.id, workspace);
    }
  }
  return sortWorkspaces(Array.from(byId.values()));
}

async function accessibleOrganizations(
  organizations: TableRef<Organization>,
  members: TableRef<OrganizationMember>,
  actorId: string,
) {
  const owned = await listAll(organizations.where('ownerId', '==', actorId));
  const memberships = await listAll(members.where('userId', '==', actorId));
  const byId = new Map<string, Organization>();
  for (const organization of owned) byId.set(organization.id, organization);
  for (const membership of memberships) {
    if ((membership.status ?? 'active') !== 'active') continue;
    const organization = await getExisting(organizations, membership.organizationId);
    if (organization) byId.set(organization.id, organization);
  }
  return sortOrganizations(Array.from(byId.values()));
}

/**
 * O(changes) delta mode ships workspace-wide tombstones/scope ids and omits the
 * visibility-filtered visiblePageIds, so it is safe only for actors with full
 * workspace access. Scoped actors (external guests / direct-permission holders)
 * must fall through to 'ids' mode, which is pruned to their visible set. Also
 * requires a complete feed with no permission writes (visibility may have
 * shifted otherwise).
 */
export function canUseChangesDeltaMode(
  hasWorkspaceAccess: boolean,
  feed: { complete: boolean; permissionsTouched: boolean },
): boolean {
  return hasWorkspaceAccess && feed.complete && !feed.permissionsTouched;
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) {
    return Response.json({ code: 401, message: 'Authentication required.' }, { status: 401 });
  }

  const body = await requestJson(request);
  const preferredWorkspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  const preferredWorkspaceSlug = normalizeWorkspaceSlug(body.workspaceSlug ?? body.domain);
  const preferredPageId = typeof body.pageId === 'string' && body.pageId.trim()
    ? body.pageId.trim()
    : undefined;
  // Delta sync (local-first roadmap §7): a client holding a cached page list
  // sends the `pagesSyncedAt` watermark from its previous bootstrap; the
  // response then ships only pages with updatedAt > watermark plus the full
  // visible-id list (ids are enough to prune deletions AND permission
  // revocations — no tombstone table needed). Anything the client can't
  // resolve locally falls back to a full bootstrap on its side.
  const pagesSince = typeof body.pagesSince === 'string' && body.pagesSince.trim()
    ? body.pagesSince.trim()
    : undefined;
  // Change-feed cursor (roadmap §7 v2): when the feed fully covers the window
  // and no permission rows moved, the response needs NO page-id list at all —
  // deletions come from the log's tombstone entries, so the delta payload is
  // O(changes) instead of O(pages).
  const changesSince = typeof body.changesSince === 'string' && body.changesSince.trim()
    ? body.changesSince.trim()
    : undefined;
  const db = admin.db('app');
  const workspaces = db.table<Workspace>('workspaces');
  const organizations = db.table<Organization>('organizations');
  const organizationMembers = db.table<OrganizationMember>('organization_members');
  const organizationDomains = db.table<OrganizationDomain>('organization_domains');
  const members = db.table<WorkspaceMember>('workspace_members');
  const authEmail = normalizeEmail(auth.email);

  const preferredPageWorkspace = await workspaceForPreferredPage(
    admin,
    db,
    workspaces,
    members,
    preferredPageId,
    auth.id,
    authEmail,
  );
  if (preferredPageWorkspace.status) {
    return Response.json(
      { code: preferredPageWorkspace.status, message: preferredPageWorkspace.message },
      { status: preferredPageWorkspace.status },
    );
  }

  let workspace = preferredPageWorkspace.workspace ??
    (await findWorkspace(
      admin,
      db,
      workspaces,
      members,
      preferredWorkspaceId,
      preferredWorkspaceSlug,
      undefined,
      auth.id,
      authEmail,
    ));

  if (
    preferredWorkspaceId &&
    !preferredPageId &&
    workspace?.id !== preferredWorkspaceId
  ) {
    const preferred = await getExisting(workspaces, preferredWorkspaceId);
    const status = preferred ? 403 : 404;
    return Response.json(
      {
        code: status,
        message: preferred
          ? 'You do not have access to this workspace.'
          : 'This workspace is unavailable.',
      },
      { status },
    );
  }

  if (
    preferredWorkspaceSlug &&
    !preferredPageId &&
    normalizeWorkspaceSlug(workspace?.domain) !== preferredWorkspaceSlug
  ) {
    const matches = await listAll(workspaces.where('domain', '==', preferredWorkspaceSlug));
    const status = matches.length ? 403 : 404;
    return Response.json(
      {
        code: status,
        message: matches.length
          ? 'You do not have access to this workspace URL.'
          : 'This workspace URL is unavailable.',
      },
      { status },
    );
  }

  let createdWorkspace = false;
  if (!workspace) {
    workspace = await workspaces.insert({
      name: 'My Workspace',
      icon: '📓',
      ownerId: auth.id,
    });
    createdWorkspace = true;
  }
  const organizationContext = await organizationForWorkspace(db, workspace, auth.id, authEmail);
  // Workspace is final from here: all content reads/writes route through the
  // per-workspace facade (pass-through pre-flip).
  const contentDb = boundedDb(admin, workspace.id);
  const pages = contentDb.table<Page>('pages');
  const blocks = contentDb.table<Block>('blocks');
  const permissions = contentDb.table<PagePermission>('page_permissions');
  if (createdWorkspace) {
    const seededPages = await seedDefaultWorkspacePages(contentDb, workspace, auth.id);
    for (const seeded of seededPages) {
      await ensurePageWorkspaceIndex(admin, seeded.id, workspace.id);
    }
  }

  const hasWorkspaceAccess = await workspaceIsAccessible(
    db,
    workspace,
    members,
    auth.id,
  );
  const currentMember = hasWorkspaceAccess
    ? await ensureWorkspaceMember(db, members, workspace, auth.id, authEmail)
    : undefined;
  const workspaceMembers = hasWorkspaceAccess
    ? sortMembers(await listAll(members.where('workspaceId', '==', workspace.id)))
    : [];
  const currentWorkspaceRole = workspaceMemberRole(workspace, currentMember, auth.id);
  const canReadWorkspaceDirectory = currentWorkspaceRole === 'full_access';
  const returnedWorkspaceMembers = canReadWorkspaceDirectory
    ? workspaceMembers
    : currentMember
      ? [currentMember]
      : [];
  const storedWorkspacePages = await listAll(pages.where('workspaceId', '==', workspace.id));
  const allWorkspacePages = projectChildPageParentsForBootstrap(
    storedWorkspacePages,
    await childPageProjectionBlocks(blocks, storedWorkspacePages),
  );
  const directPermissions = await actorPagePermissions(contentDb, auth.id, workspace.id, authEmail);
  await upsertActorShareNotifications(contentDb, allWorkspacePages, directPermissions, auth.id);
  const sharedPermissions = hasWorkspaceAccess
    ? await listAll(permissions.where('workspaceId', '==', workspace.id))
    : directPermissions;
  let workspacePages = await visiblePagesForBootstrap(
    allWorkspacePages,
    directPermissions,
    workspace,
    hasWorkspaceAccess,
    preferredPageId,
  );
  if (preferredPageId && workspacePages.some((page) => page.id === preferredPageId)) {
    const layoutHints = await rootBlockLayoutHintsForPage(blocks, preferredPageId);
    workspacePages = workspacePages.map((page) =>
      page.id === preferredPageId ? { ...page, layoutHints } : page,
    );
  }
  const pageRoles = pageRolesForBootstrap(
    workspacePages,
    allWorkspacePages,
    directPermissions,
    workspace,
    currentMember,
    auth.id,
    hasWorkspaceAccess,
  );
  const canReadOrganization = !!organizationContext.currentOrganizationMember;
  const currentOrganizationRole =
    organizationContext.organization && organizationContext.currentOrganizationMember
      ? organizationContext.organization.ownerId === auth.id
        ? 'owner'
        : parseOrganizationRole(organizationContext.currentOrganizationMember.role, 'member')
      : null;
  const canReadOrganizationDirectory =
    !!currentOrganizationRole && organizationAdminRoles.has(currentOrganizationRole);

  // Server-computed watermark: the max updatedAt across the visible set, so
  // client clocks never participate in the comparison. Returned as the true
  // max (not backed off). The same-millisecond race — a page committing at
  // exactly this max AFTER the read, which a strict '>' filter would skip
  // forever — is closed in the 'ids' fallback mode by the boundary-inclusive
  // '>=' filter below, not by walking the watermark backwards (which would
  // re-ship the whole recent window every sync and defeat the O(changes)
  // contract). The commit-ordered 'changes' mode needs no boundary re-scan: a
  // same-ms body its strict '>' filter skips is still surfaced as a changed id
  // through the change feed. Clamped to the client's cursor so an idle
  // workspace cannot walk the watermark backwards sync over sync.
  const rawPagesWatermark = workspacePages.reduce(
    (max, page) => (page.updatedAt && page.updatedAt > max ? page.updatedAt : max),
    pagesSince ?? '',
  );
  const pagesSyncedAt = pagesSince && rawPagesWatermark < pagesSince
    ? pagesSince
    : rawPagesWatermark;
  const changeFeed = await readChangeFeed(contentDb, workspace.id, changesSince);
  // latestAt is a commit-order key (the DO-assigned createdAt), so an entry can
  // never be ordered behind a cursor that a faster, later-stamped commit already
  // advanced. Persist the cursor a safety window behind it anyway, to re-scan the
  // only residual: two distinct commits sharing a wall-clock millisecond (see
  // conservativeChangeCursor). Re-delivering that window is harmless because
  // delta application is idempotent/set-based.
  const changesSyncedAt = conservativeChangeCursor(changeFeed.latestAt);
  const common = {
    userId: auth.id,
    workspace,
    organization: canReadOrganization ? organizationContext.organization : null,
    organizations: await accessibleOrganizations(organizations, organizationMembers, auth.id),
    currentOrganizationMember: canReadOrganization
      ? organizationContext.currentOrganizationMember
      : null,
    organizationMembers: canReadOrganizationDirectory && organizationContext.organization
      ? sortOrganizationMembers(
          await listAll(
            organizationMembers.where('organizationId', '==', organizationContext.organization.id),
          ),
        )
      : [],
    organizationDomains: canReadOrganizationDirectory && organizationContext.organization
      ? sortOrganizationDomains(
          await listAll(
            organizationDomains.where('organizationId', '==', organizationContext.organization.id),
          ),
        )
      : [],
    currentMember,
    members: returnedWorkspaceMembers,
    workspaces: await accessibleWorkspaces(admin, db, workspaces, members, auth.id, authEmail),
    pageRoles,
    sharedPageIds: sharedPageIdsForBootstrap(workspacePages, sharedPermissions),
    pagesSyncedAt,
    changesSyncedAt,
  };
  if (pagesSince) {
    if (canUseChangesDeltaMode(hasWorkspaceAccess, changeFeed)) {
      // O(changes) mode: tombstones convey deletions; visibility could not
      // have shifted (no permission writes), so no id list is needed. Gated on
      // full workspace access — the change feed carries workspace-wide ids and
      // omits visiblePageIds, so an actor scoped to a subtree (external guest /
      // direct-permission holder) would both leak foreign ids and miss pages
      // that left their visible subtree on reparent. Those actors fall through
      // to the visibility-filtered 'ids' mode below. Strict '>' is safe here:
      // a same-ms body it skips is still flagged as a changed id by the feed.
      const changedPages = workspacePages.filter((page) => (page.updatedAt ?? '') > pagesSince);
      return {
        ...common,
        pagesDelta: true,
        deltaMode: 'changes',
        changedPages,
        deletedPageIds: changeFeed.deletedPageIds,
        changedDatabaseIds: changeFeed.changedDatabaseIds,
        changedBlockPageIds: changeFeed.changedBlockPageIds,
      };
    }
    // 'ids' fallback (no change feed): boundary-inclusive '>=' so a page that
    // committed at exactly the previous watermark millisecond is re-delivered
    // once rather than missed forever. Only pages at the boundary ms re-ship
    // (not the full set), and the client merges changedPages by id, so the
    // overlap is idempotent and stays O(changes).
    const changedPages = workspacePages.filter((page) => (page.updatedAt ?? '') >= pagesSince);
    return {
      ...common,
      pagesDelta: true,
      deltaMode: 'ids',
      changedPages,
      visiblePageIds: workspacePages.map((page) => page.id),
    };
  }
  return {
    ...common,
    pages: workspacePages,
  };
});
