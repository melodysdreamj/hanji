import { listAll, getExisting } from './table-utils';

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

interface OrganizationEnterpriseControls {
  id: string;
  organizationId: string;
  dlpPolicy?: Record<string, unknown> | null;
}

interface OrganizationLegalHold {
  id: string;
  organizationId: string;
  name: string;
  status?: string | null;
  scope?: Record<string, unknown> | null;
}

const dlpBlockKeys: Record<string, string> = {
  publicSharing: 'blockPublicSharing',
  externalSharing: 'blockExternalSharing',
  fileDownloads: 'blockFileDownloads',
  exports: 'blockExports',
};

function stringSet(value: unknown) {
  if (!Array.isArray(value)) return new Set<string>();
  return new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0));
}

async function workspaceOrganizationId(db: DbRef, workspaceId: string | null | undefined) {
  if (!workspaceId) return null;
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  return workspace?.organizationId ?? null;
}

async function enterpriseControlsForOrganization(db: DbRef, organizationId: string) {
  const records = await listAll(
    db.table<OrganizationEnterpriseControls>('organization_enterprise_controls').where(
      'organizationId',
      '==',
      organizationId,
    ),
  );
  return records[0] ?? null;
}

export async function organizationDlpPolicyAllows(
  db: DbRef,
  workspaceId: string | null | undefined,
  key: string,
  fallback = true,
) {
  const organizationId = await workspaceOrganizationId(db, workspaceId);
  if (!organizationId) return fallback;
  const controls = await enterpriseControlsForOrganization(db, organizationId);
  const policy = controls?.dlpPolicy;
  if (!policy || policy.enabled !== true) return fallback;
  const blockKey = dlpBlockKeys[key];
  if (!blockKey) return fallback;
  return policy[blockKey] !== true;
}

export async function assertOrganizationDlpPolicy(
  db: DbRef,
  workspaceId: string | null | undefined,
  key: string,
  message: string,
  fallback = true,
) {
  if (await organizationDlpPolicyAllows(db, workspaceId, key, fallback)) return;
  throw new Error(message);
}

function legalHoldAppliesToPages(
  hold: OrganizationLegalHold,
  workspaceId: string,
  pageIds: string[],
) {
  const scope = hold.scope ?? {};
  if (scope.all === true || Object.keys(scope).length === 0) return true;

  const workspaceIds = stringSet(scope.workspaceIds);
  if (workspaceIds.size > 0 && workspaceIds.has(workspaceId)) return true;

  const scopedPageIds = stringSet(scope.pageIds);
  if (scopedPageIds.size > 0 && pageIds.some((pageId) => scopedPageIds.has(pageId))) return true;

  return false;
}

export async function assertNoActiveLegalHoldForPermanentDelete(
  db: DbRef,
  workspaceId: string | null | undefined,
  pageIds: string[],
) {
  if (!workspaceId || pageIds.length === 0) return;
  const organizationId = await workspaceOrganizationId(db, workspaceId);
  if (!organizationId) return;
  const holds = await listAll(
    db.table<OrganizationLegalHold>('organization_legal_holds').where(
      'organizationId',
      '==',
      organizationId,
    ),
  );
  const blockingHold = holds.find(
    (hold) =>
      (hold.status ?? 'active') === 'active' &&
      legalHoldAppliesToPages(hold, workspaceId, pageIds),
  );
  if (!blockingHold) return;
  throw new Error(`Active legal hold prevents permanent deletion: ${blockingHold.name}`);
}
