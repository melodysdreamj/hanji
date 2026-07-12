import { listAll, getExisting, narrowWhere, type TableQuery } from './table-utils';

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
}

interface Workspace {
  id: string;
  organizationId?: string | null;
}

interface Organization {
  id: string;
  ownerId?: string | null;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  status?: string | null;
}

export async function assertActiveWorkspaceAccess(
  db: DbRef,
  workspaceId: string | null | undefined,
  actorId: string,
) {
  if (!workspaceId || !actorId) return;
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace?.organizationId) return;
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    workspace.organizationId,
  );
  if (!organization) return;
  if (organization.ownerId === actorId) return;
  const organizationMembers = await listAll(
    narrowWhere(
      db.table<OrganizationMember>('organization_members').where(
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
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace?.organizationId) return;
  const organizationMembers = await listAll(
    narrowWhere(
      db.table<OrganizationMember>('organization_members').where(
        'organizationId',
        '==',
        workspace.organizationId,
      ),
      'userId',
      actorId,
    ),
  );
  const member = organizationMembers.find((item) => item.userId === actorId) ?? null;
  if ((member?.status ?? 'active') !== 'deactivated') return;
  throw new Error('Organization active access required.');
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
