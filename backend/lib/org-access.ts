import {
  listAll,
  getExisting,
  narrowWhere,
  projectFields,
  type TableQuery,
} from './table-utils';

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
}

export interface WorkspaceOrganizationLike {
  id: string;
  organizationId?: string | null;
}

interface Organization {
  id: string;
  ownerId?: string | null;
}

export interface OrganizationAccessMemberLike {
  id: string;
  organizationId: string;
  userId: string;
  status?: string | null;
}

const ORGANIZATION_ACCESS_MEMBER_FIELDS = [
  'id',
  'organizationId',
  'userId',
  'status',
] as const;

export async function organizationMemberForNotDeactivatedWorkspace(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  workspace?: WorkspaceOrganizationLike | null,
) {
  const resolvedWorkspace = workspace === undefined
    ? await getExisting(db.table<WorkspaceOrganizationLike>('workspaces'), workspaceId)
    : workspace;
  if (!resolvedWorkspace?.organizationId) return null;
  const organizationMembers = await listAll(
    projectFields(
      narrowWhere(
        db.table<OrganizationAccessMemberLike>('organization_members').where(
          'organizationId',
          '==',
          resolvedWorkspace.organizationId,
        ),
        'userId',
        actorId,
      ),
      ORGANIZATION_ACCESS_MEMBER_FIELDS,
    ),
  );
  const member = organizationMembers.find(
    (item) => item.organizationId === resolvedWorkspace.organizationId && item.userId === actorId,
  ) ?? null;
  if ((member?.status ?? 'active') === 'deactivated') {
    throw new Error('Organization active access required.');
  }
  return member;
}

export async function assertActiveWorkspaceAccess(
  db: DbRef,
  workspaceId: string | null | undefined,
  actorId: string,
) {
  if (!workspaceId || !actorId) return;
  const workspace = await getExisting(db.table<WorkspaceOrganizationLike>('workspaces'), workspaceId);
  if (!workspace?.organizationId) return;
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    workspace.organizationId,
  );
  if (!organization) return;
  if (organization.ownerId === actorId) return;
  const organizationMembers = await listAll(
    narrowWhere(
      db.table<OrganizationAccessMemberLike>('organization_members').where(
        'organizationId',
        '==',
        organization.id,
      ),
      'userId',
      actorId,
    ),
  );
  const member = organizationMembers.find((item) => item.userId === actorId) ?? null;
  if (member && (member.status ?? 'active') === 'active') return;
  throw new Error('Organization active access required.');
}

export async function assertNotDeactivatedWorkspaceAccess(
  db: DbRef,
  workspaceId: string | null | undefined,
  actorId: string,
) {
  if (!workspaceId || !actorId) return;
  await organizationMemberForNotDeactivatedWorkspace(db, workspaceId, actorId);
}

export async function assertActivePageWorkspaceAccess(
  db: DbRef,
  pageLike: { workspaceId?: string | null },
  actorId: string,
) {
  await assertActiveWorkspaceAccess(db, pageLike.workspaceId, actorId);
}

export async function assertNotDeactivatedPageWorkspaceAccess(
  db: DbRef,
  pageLike: { workspaceId?: string | null },
  actorId: string,
) {
  await assertNotDeactivatedWorkspaceAccess(db, pageLike.workspaceId, actorId);
}
