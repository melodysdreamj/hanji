// Central policy-cache invalidation stamp (docs/workspace-do-migration.md).
// Bumped by every organization policy / member-status / legal-hold mutation.
// Post-split, workspace DOs validate their cached policy snapshot against
// this row with one point read; pre-split there are no consumers, but the
// bumps land now so the cache can be trusted from day one of the flip.
import { listAll, type TableQuery } from './table-utils';

interface OrganizationPolicyVersion {
  id: string;
  organizationId: string;
  version: number;
}

interface TableRef<T> {
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
}

export async function bumpOrganizationPolicyVersion(
  db: DbRef,
  organizationId: string | null | undefined,
) {
  if (!organizationId || typeof organizationId !== 'string') return;
  const table = db.table<OrganizationPolicyVersion>('organization_policy_versions');
  const rows = await listAll(table.where('organizationId', '==', organizationId));
  const current = rows[0];
  // Two concurrent bumps can collapse into one increment; that is fine — the
  // cache only needs the version to CHANGE when policy state changed, not to
  // count mutations.
  if (current) {
    await table.update(current.id, { version: (current.version ?? 0) + 1 });
  } else {
    await table.insert({ organizationId, version: 1 });
  }
}
