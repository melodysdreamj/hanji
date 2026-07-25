// Central policy-cache invalidation stamp (docs/workspace-do-migration.md).
// Bumped by every organization policy / member-status / legal-hold mutation.
// Post-split, workspace DOs validate their cached policy snapshot against
// this row with one point read; pre-split there are no consumers, but the
// bumps land now so the cache can be trusted from day one of the flip.
import {
  isTransactionConflictError,
  listAll,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from './table-utils';

interface OrganizationPolicyVersion {
  id: string;
  organizationId: string;
  version: number;
}

interface TableRef<T> {
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

async function currentPolicyVersion(db: DbRef, organizationId: string) {
  const rows = await listAll(
    db.table<OrganizationPolicyVersion>('organization_policy_versions')
      .where('organizationId', '==', organizationId),
  );
  if (rows.length > 1) {
    throw new Error('Organization policy version is not uniquely configured.');
  }
  return rows[0] ?? null;
}

export interface OrganizationPolicyVersionPlan {
  guard: TransactOperation;
  write: TransactOperation;
  nextVersion: number;
}

// Exposed for mutations that must change authority-bearing rows and the
// invalidation stamp in one transaction. Callers still own their row-specific
// guards and must retry the complete read/plan/transaction sequence on a
// conflict so an already-applied retry can settle as a no-op.
export async function prepareOrganizationPolicyVersionBump(
  db: DbRef,
  organizationId: string,
): Promise<OrganizationPolicyVersionPlan> {
  const current = await currentPolicyVersion(db, organizationId);
  if (
    current
    && (
      typeof current.version !== 'number'
      || !Number.isSafeInteger(current.version)
      || current.version < 0
    )
  ) {
    throw Object.assign(
      new Error('Organization policy version is malformed.'),
      { status: 500 },
    );
  }
  const version = current?.version ?? 0;
  return {
    guard: current
      ? {
          table: 'organization_policy_versions',
          op: 'expect',
          id: current.id,
          where: [
            ['organizationId', '==', organizationId],
            ['version', '==', version],
          ],
          exists: true,
        }
      : {
          table: 'organization_policy_versions',
          op: 'expect',
          where: [['organizationId', '==', organizationId]],
          exists: false,
        },
    write: current
      ? {
          table: 'organization_policy_versions',
          op: 'update',
          id: current.id,
          data: { version: version + 1 },
        }
      : {
          table: 'organization_policy_versions',
          op: 'insert',
          data: { id: organizationId, organizationId, version: 1 },
        },
    nextVersion: version + 1,
  };
}

export async function bumpOrganizationPolicyVersion(
  db: DbRef,
  organizationId: string | null | undefined,
) {
  if (!organizationId || typeof organizationId !== 'string') return;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const plan = await prepareOrganizationPolicyVersionBump(db, organizationId);
    try {
      await db.transact([plan.guard, plan.write]);
      return;
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
    }
  }
  throw Object.assign(
    new Error('Organization policy version changed concurrently. Retry the request.'),
    { status: 409 },
  );
}
