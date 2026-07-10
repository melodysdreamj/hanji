import { isNotFoundError } from './table-utils';

export type SignupPolicy = 'public' | 'invite_only' | 'verified_domains';

export interface InstanceSettings {
  id: string;
  signupPolicy?: SignupPolicy | string;
  instanceAdminUserIds?: string[] | unknown;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
}

export interface DbRef {
  table<T>(name: string): TableRef<T>;
}

export const INSTANCE_SETTINGS_ID = 'global';

export const signupPolicyLabels: Record<SignupPolicy, string> = {
  public: 'anyone',
  invite_only: 'invited users',
  verified_domains: 'verified domains or invitations',
};

export function parseSignupPolicy(value: unknown, fallback: SignupPolicy = 'public'): SignupPolicy {
  if (typeof value !== 'string') return fallback;
  const policy = value.trim().toLowerCase();
  if (policy === 'public' || policy === 'invite_only' || policy === 'verified_domains') return policy;
  throw new Error('Signup policy is invalid.');
}

function normalizeInstanceSettings(row: InstanceSettings | null | undefined): InstanceSettings {
  let signupPolicy: SignupPolicy;
  try {
    signupPolicy = parseSignupPolicy(row?.signupPolicy, 'public');
  } catch {
    // An invalid stored policy falls back alone; the rest of the row survives.
    signupPolicy = 'public';
  }
  const instanceAdminUserIds = Array.isArray(row?.instanceAdminUserIds)
    ? Array.from(
        new Set(
          row.instanceAdminUserIds
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim()),
        ),
      )
    : [];
  return {
    id: row?.id ?? INSTANCE_SETTINGS_ID,
    signupPolicy,
    instanceAdminUserIds,
    updatedBy: row?.updatedBy ?? null,
    createdAt: row?.createdAt,
    updatedAt: row?.updatedAt,
  };
}

export async function getInstanceSettings(db: DbRef): Promise<InstanceSettings> {
  const table = db.table<InstanceSettings>('instance_settings');
  let row: InstanceSettings | null = null;
  try {
    row = await table.getOne(INSTANCE_SETTINGS_ID);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    row = null;
  }
  return normalizeInstanceSettings(row);
}

export async function upsertInstanceSettings(
  db: DbRef,
  patch: Partial<InstanceSettings>,
): Promise<InstanceSettings> {
  const table = db.table<InstanceSettings>('instance_settings');
  const normalizedPatch: Partial<InstanceSettings> = { ...patch };
  if (patch.signupPolicy !== undefined) {
    normalizedPatch.signupPolicy = parseSignupPolicy(patch.signupPolicy);
  } else {
    // A patch that omits signupPolicy must not reset the stored policy.
    delete normalizedPatch.signupPolicy;
  }
  if (patch.instanceAdminUserIds !== undefined) {
    normalizedPatch.instanceAdminUserIds = Array.isArray(patch.instanceAdminUserIds)
      ? Array.from(
          new Set(
            patch.instanceAdminUserIds
              .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              .map((item) => item.trim()),
          ),
        )
      : [];
  } else {
    delete normalizedPatch.instanceAdminUserIds;
  }
  try {
    return normalizeInstanceSettings(await table.update(INSTANCE_SETTINGS_ID, normalizedPatch));
  } catch (error) {
    // Only the not-found case is an expected "row absent, create it below".
    // A real failure (network/5xx/validation) must propagate rather than be
    // masked by an insert attempt that would report a misleading error.
    if (!isNotFoundError(error)) throw error;
  }
  // The row is absent — create it. A concurrent creator can win this race, so
  // on insert failure fall back to updating the now-existing row.
  try {
    return normalizeInstanceSettings(
      await table.insert({
        id: INSTANCE_SETTINGS_ID,
        signupPolicy: 'public',
        ...normalizedPatch,
      }),
    );
  } catch {
    return normalizeInstanceSettings(await table.update(INSTANCE_SETTINGS_ID, normalizedPatch));
  }
}
