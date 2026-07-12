import { getExisting } from './table-utils';

interface ListResult<T> {
  items?: T[];
  hasMore?: boolean;
}

interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  getList(): Promise<ListResult<T>>;
}

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
  sharingPolicy?: Record<string, unknown> | null;
}

export async function organizationSharingPolicyAllows(
  db: DbRef,
  workspaceId: string | null | undefined,
  key: string,
  fallback = true,
) {
  if (!workspaceId) return fallback;
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace?.organizationId) return fallback;
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    workspace.organizationId,
  );
  const value = organization?.sharingPolicy?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

export async function assertOrganizationSharingPolicy(
  db: DbRef,
  workspaceId: string | null | undefined,
  key: string,
  message: string,
  fallback = true,
) {
  if (await organizationSharingPolicyAllows(db, workspaceId, key, fallback)) return;
  throw new Error(message);
}
