import { prepareOrganizationPolicyVersionBump } from './org-policy-version';
import {
  isTransactionConflictError,
  listAll,
  nowIso,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from './table-utils';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_POLICY_MUTATION_ATTEMPTS = 12;
// EdgeBase accepts at most 500 operations per transaction. The policy-version
// CAS contributes two operations, leaving a bounded 498-operation mutation
// payload that subsequent transactions keep draining.
const MAX_VERSIONED_MUTATION_OPS = 498;
// Every membership write is paired with an exact expectation and each batch
// also carries the group-existence guard. The policy-version CAS/write is
// accounted for separately by transactWithPolicyVersion.
const MAX_GROUP_MEMBERSHIP_MUTATIONS_PER_TRANSACTION = Math.floor(
  (MAX_VERSIONED_MUTATION_OPS - 1) / 2,
);

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface AuthAdmin {
  listUsers(options?: { limit?: number; cursor?: string }): Promise<{
    users: Record<string, unknown>[];
    cursor?: string;
  }>;
  createUser(data: {
    email: string;
    password: string;
    displayName?: string;
    role?: string;
  }): Promise<Record<string, unknown>>;
  updateUser(userId: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  revokeAllSessions(userId: string): Promise<void>;
}

export interface ScimFunctionContext {
  request?: Request;
  params?: { slug?: string };
  admin: {
    db(namespace: string): DbRef;
    auth?: AuthAdmin;
  };
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  status?: string | null;
  externalId?: string | null;
  provisionedBy?: string | null;
  createdBy?: string | null;
  deactivatedAt?: string | null;
  deactivatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationGroup {
  id: string;
  organizationId: string;
  name: string;
  description?: string | null;
  externalId?: string | null;
  provisionedBy?: string | null;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationGroupMember {
  id: string;
  organizationId: string;
  groupId: string;
  organizationMemberId: string;
  userId: string;
  role?: string | null;
  createdBy?: string | null;
}

interface OrganizationDomain {
  id: string;
  organizationId: string;
  domain: string;
  status?: string | null;
}

interface OrganizationEnterpriseControls {
  id: string;
  organizationId: string;
  scimConfig?: Record<string, unknown> | null;
}

interface OrganizationScimToken {
  id: string;
  organizationId: string;
  status?: string | null;
  tokenPrefix?: string | null;
  tokenHash?: string | null;
  scopes?: Record<string, unknown> | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

interface OrganizationAuditEvent {
  id: string;
  organizationId: string;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

interface ScimIdentity {
  organizationId: string;
  token: OrganizationScimToken;
  config: Record<string, unknown>;
}

function scimJson(body: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/scim+json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function scimError(status: number, detail: string, scimType?: string) {
  return scimJson({
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  }, status, status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Hanji SCIM"' } : undefined);
}

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function boundedString(value: unknown, max: number) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function userDisplayName(body: Record<string, unknown>) {
  const name = body.name && typeof body.name === 'object'
    ? body.name as Record<string, unknown>
    : {};
  return boundedString(body.displayName, 200)
    ?? boundedString(name.formatted, 200)
    ?? [boundedString(name.givenName, 100), boundedString(name.familyName, 100)]
      .filter(Boolean)
      .join(' ')
    ?? null;
}

function userRole(body: Record<string, unknown>) {
  const roles = Array.isArray(body.roles) ? body.roles : [];
  const value = roles[0] && typeof roles[0] === 'object'
    ? boundedString((roles[0] as Record<string, unknown>).value, 40)
    : null;
  return value === 'guest' ? 'guest' : 'member';
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function authenticateScim(request: Request, db: DbRef): Promise<ScimIdentity | Response> {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(scim_[A-Za-z0-9_-]{20,})$/i.exec(authorization.trim());
  if (!match) return scimError(401, 'A valid SCIM bearer token is required.');
  const secret = match[1];
  const candidates = await listAll(
    db.table<OrganizationScimToken>('organization_scim_tokens').where(
      'tokenPrefix',
      '==',
      secret.slice(0, 14),
    ),
  );
  const hash = await sha256Hex(secret);
  const token = candidates.find((candidate) =>
    (candidate.status ?? 'active') === 'active'
    && typeof candidate.tokenHash === 'string'
    && constantTimeEqual(candidate.tokenHash, hash));
  if (!token) return scimError(401, 'The SCIM bearer token is invalid or revoked.');
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
    return scimError(401, 'The SCIM bearer token has expired.');
  }
  const controls = await listAll(
    db.table<OrganizationEnterpriseControls>('organization_enterprise_controls').where(
      'organizationId',
      '==',
      token.organizationId,
    ),
  );
  const config = controls[0]?.scimConfig ?? {};
  if (config.enabled !== true || config.provisioningMode !== 'scim_v2') {
    return scimError(403, 'SCIM provisioning is not enabled for this organization.');
  }
  await db.table<OrganizationScimToken>('organization_scim_tokens').update(token.id, {
    lastUsedAt: nowIso(),
  });
  return { organizationId: token.organizationId, token, config };
}

function scimBaseUrl(request: Request) {
  const url = new URL(request.url);
  const marker = '/scim/v2';
  const index = url.pathname.indexOf(marker);
  return `${url.origin}${index >= 0 ? url.pathname.slice(0, index + marker.length) : marker}`;
}

function scimUser(member: OrganizationMember, request: Request) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: member.id,
    ...(member.externalId ? { externalId: member.externalId } : {}),
    userName: member.email ?? member.userId,
    displayName: member.displayName ?? member.email ?? member.userId,
    name: { formatted: member.displayName ?? member.email ?? member.userId },
    active: (member.status ?? 'active') === 'active',
    roles: [{ value: member.role === 'guest' ? 'guest' : 'member', primary: true }],
    meta: {
      resourceType: 'User',
      created: member.createdAt,
      lastModified: member.updatedAt ?? member.createdAt,
      location: `${scimBaseUrl(request)}/Users/${encodeURIComponent(member.id)}`,
    },
  };
}

function scimGroup(
  group: OrganizationGroup,
  groupMembers: OrganizationGroupMember[],
  membersById: Map<string, OrganizationMember>,
  request: Request,
) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    displayName: group.name,
    members: groupMembers.map((entry) => ({
      value: entry.organizationMemberId,
      $ref: `${scimBaseUrl(request)}/Users/${encodeURIComponent(entry.organizationMemberId)}`,
      display: membersById.get(entry.organizationMemberId)?.displayName
        ?? membersById.get(entry.organizationMemberId)?.email
        ?? entry.userId,
    })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt,
      lastModified: group.updatedAt ?? group.createdAt,
      location: `${scimBaseUrl(request)}/Groups/${encodeURIComponent(group.id)}`,
    },
  };
}

function pageOf<T>(items: T[], request: Request) {
  const url = new URL(request.url);
  const startIndex = Math.max(1, Number.parseInt(url.searchParams.get('startIndex') ?? '1', 10) || 1);
  const count = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('count') ?? '100', 10) || 100));
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: items.length,
    startIndex,
    itemsPerPage: Math.max(0, Math.min(count, items.length - startIndex + 1)),
    Resources: items.slice(startIndex - 1, startIndex - 1 + count),
  };
}

function parseSimpleFilter(request: Request) {
  const filter = new URL(request.url).searchParams.get('filter');
  if (!filter) return null;
  const match = /^([A-Za-z][A-Za-z0-9.]*)\s+eq\s+"([^"\\]{1,300})"$/i.exec(filter.trim());
  return match ? { field: match[1].toLowerCase(), value: match[2] } : null;
}

function applyUserFilter(members: OrganizationMember[], request: Request) {
  const filter = parseSimpleFilter(request);
  if (!filter) return members;
  const value = filter.value.toLowerCase();
  if (filter.field === 'username') return members.filter((member) => member.email?.toLowerCase() === value);
  if (filter.field === 'externalid') return members.filter((member) => member.externalId === filter.value);
  if (filter.field === 'id') return members.filter((member) => member.id === filter.value);
  if (filter.field === 'displayname') return members.filter((member) => member.displayName?.toLowerCase() === value);
  return [];
}

function applyGroupFilter(groups: OrganizationGroup[], request: Request) {
  const filter = parseSimpleFilter(request);
  if (!filter) return groups;
  const value = filter.value.toLowerCase();
  if (filter.field === 'displayname') return groups.filter((group) => group.name.toLowerCase() === value);
  if (filter.field === 'externalid') return groups.filter((group) => group.externalId === filter.value);
  if (filter.field === 'id') return groups.filter((group) => group.id === filter.value);
  return [];
}

async function readJson(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) throw new Error('A SCIM JSON request body is required.');
  const body = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The SCIM request body is invalid.');
  return body as Record<string, unknown>;
}

async function findAuthUserByEmail(auth: AuthAdmin, email: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await auth.listUsers({ limit: 200, cursor });
    const match = (result.users ?? []).find((user) => normalizeEmail(user.email) === email);
    if (match) return match;
    if (!result.cursor || !(result.users ?? []).length) return null;
    cursor = result.cursor;
  }
  return null;
}

function authUserId(user: Record<string, unknown>) {
  return boundedString(user.id, 200) ?? boundedString(user.userId, 200);
}

async function assertVerifiedDomain(
  db: DbRef,
  identity: ScimIdentity,
  email: string,
) {
  if (identity.config.requireVerifiedDomain !== true) return;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const domains = await listAll(
    db.table<OrganizationDomain>('organization_domains').where(
      'organizationId',
      '==',
      identity.organizationId,
    ),
  );
  if (domains.some((entry) => entry.domain === domain && (entry.status ?? 'pending') === 'verified')) return;
  throw new Error('A verified organization domain is required for SCIM users.');
}

async function audit(
  db: DbRef,
  identity: ScimIdentity,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
) {
  await db.table<OrganizationAuditEvent>('organization_audit_events').insert({
    organizationId: identity.organizationId,
    actorId: null,
    action,
    targetType,
    targetId,
    metadata: { ...metadata, scimTokenId: identity.token.id },
    occurredAt: nowIso(),
  });
}

interface PreparedVersionedMutation<T> {
  operations: TransactOperation[];
  value: T;
}

async function transactWithPolicyVersion<T>(
  db: DbRef,
  organizationId: string,
  prepare: () => Promise<PreparedVersionedMutation<T> | null>,
): Promise<{ changed: false } | { changed: true; value: T }> {
  for (let attempt = 0; attempt < SCIM_POLICY_MUTATION_ATTEMPTS; attempt += 1) {
    const prepared = await prepare();
    if (!prepared || prepared.operations.length === 0) return { changed: false };
    if (prepared.operations.length > MAX_VERSIONED_MUTATION_OPS) {
      throw new Error(
        `SCIM policy mutation exceeds ${MAX_VERSIONED_MUTATION_OPS} operations.`,
      );
    }
    const policyVersion = await prepareOrganizationPolicyVersionBump(db, organizationId);
    try {
      await db.transact([
        policyVersion.guard,
        ...prepared.operations,
        policyVersion.write,
      ]);
      return { changed: true, value: prepared.value };
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
    }
  }
  throw Object.assign(
    new Error('SCIM organization authority changed concurrently. Retry the request.'),
    { status: 409 },
  );
}

function organizationMemberIsActive(member: OrganizationMember) {
  return (member.status ?? 'active') === 'active';
}

async function updateOrganizationMember(
  db: DbRef,
  current: OrganizationMember,
  patch: Partial<OrganizationMember>,
  desiredActive: boolean | undefined,
) {
  if (desiredActive === undefined) {
    return db.table<OrganizationMember>('organization_members').update(current.id, patch);
  }

  for (let attempt = 0; attempt < SCIM_POLICY_MUTATION_ATTEMPTS; attempt += 1) {
    const latest = await db.table<OrganizationMember>('organization_members').getOne(current.id);
    if (!latest || latest.organizationId !== current.organizationId) {
      throw new Error('SCIM user was not found.');
    }
    const memberGuard: TransactOperation = {
      table: 'organization_members',
      op: 'expect',
      id: latest.id,
      where: [
        ['organizationId', '==', latest.organizationId],
        ['status', '==', latest.status ?? null],
      ],
      exists: true,
    };
    const memberWrite: TransactOperation = {
      table: 'organization_members',
      op: 'update',
      id: latest.id,
      data: patch as Record<string, unknown>,
    };
    const statusChanged = organizationMemberIsActive(latest) !== desiredActive;
    try {
      let result;
      let updatedIndex: number;
      if (statusChanged) {
        // Keeping the member guard and policy stamp in the same transaction
        // closes a same-status no-op racing a concurrent status transition.
        const policyVersion = await prepareOrganizationPolicyVersionBump(db, latest.organizationId);
        result = await db.transact([
          policyVersion.guard,
          memberGuard,
          memberWrite,
          policyVersion.write,
        ]);
        updatedIndex = 2;
      } else {
        result = await db.transact([memberGuard, memberWrite]);
        updatedIndex = 1;
      }
      const updated = result.results[updatedIndex]?.updated;
      return updated && typeof updated === 'object'
        ? updated as unknown as OrganizationMember
        : { ...latest, ...patch };
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
    }
  }
  throw Object.assign(
    new Error('SCIM organization member changed concurrently. Retry the request.'),
    { status: 409 },
  );
}

async function organizationMembers(db: DbRef, organizationId: string) {
  return listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
  );
}

async function listUsers(db: DbRef, identity: ScimIdentity, request: Request) {
  const members = applyUserFilter(await organizationMembers(db, identity.organizationId), request);
  return scimJson(pageOf(members.map((member) => scimUser(member, request)), request));
}

async function getUser(db: DbRef, identity: ScimIdentity, request: Request, id: string) {
  const member = await db.table<OrganizationMember>('organization_members').getOne(id);
  if (!member || member.organizationId !== identity.organizationId) return scimError(404, 'SCIM user was not found.');
  return scimJson(scimUser(member, request));
}

async function createUser(
  db: DbRef,
  auth: AuthAdmin,
  identity: ScimIdentity,
  request: Request,
) {
  const body = await readJson(request);
  const email = normalizeEmail(body.userName);
  if (!email) return scimError(400, 'userName must be a valid email address.', 'invalidValue');
  await assertVerifiedDomain(db, identity, email);
  const members = await organizationMembers(db, identity.organizationId);
  if (members.some((member) => member.email?.toLowerCase() === email)) {
    return scimError(409, 'A SCIM user with this userName already exists.', 'uniqueness');
  }
  const displayName = userDisplayName(body) ?? email;
  let authUser = await findAuthUserByEmail(auth, email);
  if (!authUser) {
    authUser = await auth.createUser({
      email,
      password: `Scim-${crypto.randomUUID()}-${crypto.randomUUID()}!`,
      displayName,
      role: 'user',
    });
  }
  const userId = authUserId(authUser);
  if (!userId) throw new Error('Provisioned auth user did not return an id.');
  const active = body.active !== false;
  await auth.updateUser(userId, { displayName, disabled: !active });
  const member = await db.table<OrganizationMember>('organization_members').insert({
    organizationId: identity.organizationId,
    userId,
    displayName,
    email,
    role: userRole(body),
    status: active ? 'active' : 'deactivated',
    externalId: boundedString(body.externalId, 300),
    provisionedBy: 'scim',
    createdBy: `scim:${identity.token.id}`,
    ...(active ? {} : { deactivatedAt: nowIso(), deactivatedBy: `scim:${identity.token.id}` }),
  });
  await audit(db, identity, 'organization_scim.user.create', 'organization_member', member.id, {
    userId,
    active,
  });
  return scimJson(scimUser(member, request), 201, {
    Location: `${scimBaseUrl(request)}/Users/${encodeURIComponent(member.id)}`,
  });
}

function patchOperations(body: Record<string, unknown>) {
  if (!Array.isArray(body.Operations) || !body.Operations.length || body.Operations.length > 50) {
    throw new Error('Operations must contain between 1 and 50 patch operations.');
  }
  return body.Operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('A SCIM patch operation is invalid.');
    }
    return operation as Record<string, unknown>;
  });
}

function applyUserPatch(body: Record<string, unknown>, current: OrganizationMember) {
  const patch: Partial<OrganizationMember> = {};
  let active: boolean | undefined;
  const assign = (path: string, value: unknown) => {
    const normalized = path.toLowerCase();
    if (normalized === 'active' && typeof value === 'boolean') active = value;
    else if (normalized === 'displayname' && typeof value === 'string') patch.displayName = value.trim().slice(0, 200);
    else if (normalized === 'name.formatted' && typeof value === 'string') patch.displayName = value.trim().slice(0, 200);
    else if (normalized === 'username') {
      const email = normalizeEmail(value);
      if (!email) throw new Error('userName must be a valid email address.');
      patch.email = email;
    } else if (normalized === 'externalid') patch.externalId = boundedString(value, 300);
    else if (normalized === 'roles' && Array.isArray(value)) patch.role = userRole({ roles: value });
  };
  for (const operation of patchOperations(body)) {
    const op = String(operation.op ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op)) throw new Error('Unsupported SCIM patch operation.');
    const path = boundedString(operation.path, 300);
    if (path) {
      assign(path, op === 'remove' ? null : operation.value);
      continue;
    }
    if (operation.value && typeof operation.value === 'object' && !Array.isArray(operation.value)) {
      for (const [key, value] of Object.entries(operation.value as Record<string, unknown>)) assign(key, value);
    }
  }
  if (active !== undefined) {
    patch.status = active ? 'active' : 'deactivated';
    Object.assign(patch, active
      ? { deactivatedAt: null, deactivatedBy: null }
      : { deactivatedAt: nowIso(), deactivatedBy: 'scim' });
  }
  return { patch, active, current };
}

async function replaceOrPatchUser(
  db: DbRef,
  auth: AuthAdmin,
  identity: ScimIdentity,
  request: Request,
  id: string,
  replace: boolean,
) {
  const current = await db.table<OrganizationMember>('organization_members').getOne(id);
  if (!current || current.organizationId !== identity.organizationId) return scimError(404, 'SCIM user was not found.');
  const body = await readJson(request);
  let patch: Partial<OrganizationMember>;
  let active: boolean | undefined;
  if (replace) {
    const email = normalizeEmail(body.userName);
    if (!email) return scimError(400, 'userName must be a valid email address.', 'invalidValue');
    patch = {
      email,
      displayName: userDisplayName(body) ?? email,
      role: userRole(body),
      externalId: boundedString(body.externalId, 300),
      status: body.active === false ? 'deactivated' : 'active',
    };
    active = body.active !== false;
  } else {
    ({ patch, active } = applyUserPatch(body, current));
  }
  if (patch.email) await assertVerifiedDomain(db, identity, patch.email);
  const nextActive = active ?? (patch.status ? patch.status === 'active' : undefined);
  await auth.updateUser(current.userId, {
    ...(patch.email ? { email: patch.email } : {}),
    ...(patch.displayName ? { displayName: patch.displayName } : {}),
    ...(nextActive !== undefined ? { disabled: !nextActive } : {}),
  });
  if (nextActive === false) await auth.revokeAllSessions(current.userId);
  const updated = await updateOrganizationMember(db, current, {
    ...patch,
    ...(nextActive === false ? {
      deactivatedAt: organizationMemberIsActive(current)
        ? nowIso()
        : current.deactivatedAt ?? nowIso(),
      deactivatedBy: organizationMemberIsActive(current)
        ? `scim:${identity.token.id}`
        : current.deactivatedBy ?? `scim:${identity.token.id}`,
    } : {}),
    ...(nextActive === true ? { deactivatedAt: null, deactivatedBy: null } : {}),
  }, nextActive);
  await audit(db, identity, 'organization_scim.user.update', 'organization_member', updated.id, {
    userId: updated.userId,
    active: (updated.status ?? 'active') === 'active',
  });
  return scimJson(scimUser(updated, request));
}

async function deleteUser(
  db: DbRef,
  auth: AuthAdmin,
  identity: ScimIdentity,
  id: string,
) {
  const current = await db.table<OrganizationMember>('organization_members').getOne(id);
  if (!current || current.organizationId !== identity.organizationId) return scimError(404, 'SCIM user was not found.');
  await auth.updateUser(current.userId, { disabled: true });
  await auth.revokeAllSessions(current.userId);
  await updateOrganizationMember(db, current, {
    status: 'deactivated',
    deactivatedAt: organizationMemberIsActive(current)
      ? nowIso()
      : current.deactivatedAt ?? nowIso(),
    deactivatedBy: organizationMemberIsActive(current)
      ? `scim:${identity.token.id}`
      : current.deactivatedBy ?? `scim:${identity.token.id}`,
  }, false);
  await audit(db, identity, 'organization_scim.user.deactivate', 'organization_member', current.id, {
    userId: current.userId,
  });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

async function groupDirectory(db: DbRef, organizationId: string) {
  const [groups, links, members] = await Promise.all([
    listAll(db.table<OrganizationGroup>('organization_groups').where('organizationId', '==', organizationId)),
    listAll(db.table<OrganizationGroupMember>('organization_group_members').where('organizationId', '==', organizationId)),
    organizationMembers(db, organizationId),
  ]);
  return { groups, links, membersById: new Map(members.map((member) => [member.id, member])) };
}

async function listGroups(db: DbRef, identity: ScimIdentity, request: Request) {
  const directory = await groupDirectory(db, identity.organizationId);
  const groups = applyGroupFilter(directory.groups, request);
  return scimJson(pageOf(groups.map((group) => scimGroup(
    group,
    directory.links.filter((link) => link.groupId === group.id),
    directory.membersById,
    request,
  )), request));
}

async function getGroup(db: DbRef, identity: ScimIdentity, request: Request, id: string) {
  const directory = await groupDirectory(db, identity.organizationId);
  const group = directory.groups.find((entry) => entry.id === id);
  if (!group) return scimError(404, 'SCIM group was not found.');
  return scimJson(scimGroup(
    group,
    directory.links.filter((link) => link.groupId === group.id),
    directory.membersById,
    request,
  ));
}

function requestedMemberIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? boundedString((entry as Record<string, unknown>).value, 200)
      : null,
  ).filter((id): id is string => Boolean(id))));
}

async function replaceGroupMembers(
  db: DbRef,
  identity: ScimIdentity,
  group: OrganizationGroup,
  memberIds: string[],
) {
  const members = await organizationMembers(db, identity.organizationId);
  const byId = new Map(members.map((member) => [member.id, member]));
  if (memberIds.some((id) => !byId.has(id))) throw new Error('A referenced SCIM user was not found.');
  const wanted = new Set(memberIds);
  const table = db.table<OrganizationGroupMember>('organization_group_members');
  let changed = 0;

  type MembershipMutation =
    | { kind: 'delete'; row: OrganizationGroupMember }
    | { kind: 'insert'; id: string; member: OrganizationMember };

  function requireWhere<T>(
    query: TableQuery<T>,
    field: string,
    op: string,
    value: unknown,
  ) {
    if (typeof query.where !== 'function') {
      throw Object.assign(new Error('SCIM group mutation requires chained database filters.'), { status: 500 });
    }
    return query.where(field, op, value);
  }

  async function membershipRowsForField(field: string, values: string[]) {
    if (values.length === 0) return [];
    let query = table.where('groupId', '==', group.id);
    query = requireWhere(query, 'organizationId', '==', identity.organizationId);
    query = requireWhere(query, field, 'in', values);
    return (await listAll(query, {
      maxItems: values.length,
      pageSize: values.length,
      label: 'SCIM group mutation target rows',
    })).filter((row) => (
      row.groupId === group.id && row.organizationId === identity.organizationId
    ));
  }

  async function mutationOperations(chunk: MembershipMutation[]) {
    const deletes = chunk.filter((mutation): mutation is Extract<MembershipMutation, { kind: 'delete' }> => (
      mutation.kind === 'delete'
    ));
    const inserts = chunk.filter((mutation): mutation is Extract<MembershipMutation, { kind: 'insert' }> => (
      mutation.kind === 'insert'
    ));
    const [deleteRows, insertRows] = await Promise.all([
      membershipRowsForField('id', deletes.map((mutation) => mutation.row.id)),
      membershipRowsForField(
        'organizationMemberId',
        inserts.map((mutation) => mutation.member.id),
      ),
    ]);
    const deleteRowsById = new Map(deleteRows.map((row) => [row.id, row]));
    const existingInsertMemberIds = new Set(insertRows.map((row) => row.organizationMemberId));
    const operations: TransactOperation[] = [];
    let applied = 0;
    for (const mutation of deletes) {
      const current = deleteRowsById.get(mutation.row.id);
      if (
        !current
        || current.organizationMemberId !== mutation.row.organizationMemberId
        || current.userId !== mutation.row.userId
      ) continue;
      operations.push(
        {
          table: 'organization_group_members',
          op: 'expect',
          id: current.id,
          where: [
            ['organizationId', '==', identity.organizationId],
            ['groupId', '==', group.id],
            ['organizationMemberId', '==', current.organizationMemberId],
            ['userId', '==', current.userId],
          ],
          exists: true,
        },
        { table: 'organization_group_members', op: 'delete', id: current.id },
      );
      applied += 1;
    }
    for (const mutation of inserts) {
      if (existingInsertMemberIds.has(mutation.member.id)) continue;
      const now = nowIso();
      operations.push(
        {
          table: 'organization_group_members',
          op: 'expect',
          id: mutation.id,
          exists: false,
        },
        {
          table: 'organization_group_members',
          op: 'insert',
          data: {
            id: mutation.id,
            organizationId: identity.organizationId,
            groupId: group.id,
            organizationMemberId: mutation.member.id,
            userId: mutation.member.userId,
            role: 'member',
            createdBy: `scim:${identity.token.id}`,
            createdAt: now,
            updatedAt: now,
          },
        },
      );
      applied += 1;
    }
    if (operations.length === 0) return null;
    return {
      operations: [
        {
          table: 'organization_groups',
          op: 'expect',
          id: group.id,
          where: [['organizationId', '==', identity.organizationId]],
          exists: true,
        } satisfies TransactOperation,
        ...operations,
      ],
      value: applied,
    };
  }

  for (let drainAttempt = 0; drainAttempt < SCIM_POLICY_MUTATION_ATTEMPTS; drainAttempt += 1) {
    const existing = (await listAll(table.where('groupId', '==', group.id)))
      .filter((entry) => entry.organizationId === identity.organizationId);
    const kept = new Set<string>();
    const mutations: MembershipMutation[] = [];
    for (const entry of existing) {
      const member = byId.get(entry.organizationMemberId);
      if (
        !wanted.has(entry.organizationMemberId)
        || kept.has(entry.organizationMemberId)
        || !member
        || member.userId !== entry.userId
      ) {
        mutations.push({ kind: 'delete', row: entry });
      } else {
        kept.add(entry.organizationMemberId);
      }
    }
    for (const memberId of memberIds) {
      if (kept.has(memberId)) continue;
      const member = byId.get(memberId)!;
      mutations.push({
        kind: 'insert',
        id: `scim-group-member-${await sha256Hex(JSON.stringify([
          identity.organizationId,
          group.id,
          member.id,
        ]))}`,
        member,
      });
    }
    if (mutations.length === 0) return changed;

    for (
      let offset = 0;
      offset < mutations.length;
      offset += MAX_GROUP_MEMBERSHIP_MUTATIONS_PER_TRANSACTION
    ) {
      const chunk = mutations.slice(
        offset,
        offset + MAX_GROUP_MEMBERSHIP_MUTATIONS_PER_TRANSACTION,
      );
      const result = await transactWithPolicyVersion(
        db,
        identity.organizationId,
        () => mutationOperations(chunk),
      );
      if (result.changed) changed += result.value;
    }
  }
  throw Object.assign(
    new Error('SCIM group membership replacement changed concurrently. Retry the request.'),
    { status: 409 },
  );
}

async function createGroup(db: DbRef, identity: ScimIdentity, request: Request) {
  const body = await readJson(request);
  const displayName = boundedString(body.displayName, 200);
  if (!displayName) return scimError(400, 'displayName is required.', 'invalidValue');
  const groups = await listAll(
    db.table<OrganizationGroup>('organization_groups').where('organizationId', '==', identity.organizationId),
  );
  if (groups.some((group) => group.name.toLowerCase() === displayName.toLowerCase())) {
    return scimError(409, 'A SCIM group with this displayName already exists.', 'uniqueness');
  }
  const group = await db.table<OrganizationGroup>('organization_groups').insert({
    organizationId: identity.organizationId,
    name: displayName,
    externalId: boundedString(body.externalId, 300),
    provisionedBy: 'scim',
    createdBy: `scim:${identity.token.id}`,
  });
  await replaceGroupMembers(db, identity, group, requestedMemberIds(body.members));
  await audit(db, identity, 'organization_scim.group.create', 'organization_group', group.id, {
    displayName,
  });
  return getGroup(db, identity, request, group.id).then(async (response) => scimJson(
    await response.json(),
    201,
    { Location: `${scimBaseUrl(request)}/Groups/${encodeURIComponent(group.id)}` },
  ));
}

async function replaceOrPatchGroup(
  db: DbRef,
  identity: ScimIdentity,
  request: Request,
  id: string,
  replace: boolean,
) {
  const group = await db.table<OrganizationGroup>('organization_groups').getOne(id);
  if (!group || group.organizationId !== identity.organizationId) return scimError(404, 'SCIM group was not found.');
  const body = await readJson(request);
  let name: string | null = null;
  let externalId: string | null | undefined;
  let memberIds: string[] | undefined;
  if (replace) {
    name = boundedString(body.displayName, 200);
    externalId = boundedString(body.externalId, 300);
    memberIds = requestedMemberIds(body.members);
  } else {
    const currentLinks = await listAll(
      db.table<OrganizationGroupMember>('organization_group_members').where('groupId', '==', group.id),
    );
    let nextMembers = new Set(currentLinks.map((entry) => entry.organizationMemberId));
    for (const operation of patchOperations(body)) {
      const op = String(operation.op ?? '').toLowerCase();
      const path = boundedString(operation.path, 300)?.toLowerCase() ?? '';
      if (path === 'displayname' && op !== 'remove') name = boundedString(operation.value, 200);
      else if (path === 'externalid') externalId = op === 'remove' ? null : boundedString(operation.value, 300);
      else if (path === 'members' || (!path && operation.value && typeof operation.value === 'object')) {
        const value = path
          ? operation.value
          : (operation.value as Record<string, unknown>).members;
        const ids = requestedMemberIds(value);
        if (op === 'replace') nextMembers = new Set(ids);
        else if (op === 'remove') ids.forEach((memberId) => nextMembers.delete(memberId));
        else ids.forEach((memberId) => nextMembers.add(memberId));
      } else {
        const match = /^members\[value eq "([^"\\]+)"\]$/i.exec(path);
        if (match && op === 'remove') nextMembers.delete(match[1]);
      }
    }
    memberIds = [...nextMembers];
  }
  if (replace && !name) return scimError(400, 'displayName is required.', 'invalidValue');
  const updated = await db.table<OrganizationGroup>('organization_groups').update(group.id, {
    ...(name ? { name } : {}),
    ...(externalId !== undefined ? { externalId } : {}),
  });
  if (memberIds) await replaceGroupMembers(db, identity, updated, memberIds);
  await audit(db, identity, 'organization_scim.group.update', 'organization_group', updated.id, {
    displayName: updated.name,
  });
  return getGroup(db, identity, request, updated.id);
}

async function deleteGroup(db: DbRef, identity: ScimIdentity, id: string) {
  const group = await db.table<OrganizationGroup>('organization_groups').getOne(id);
  if (!group || group.organizationId !== identity.organizationId) return scimError(404, 'SCIM group was not found.');
  const removedMembers = await replaceGroupMembers(db, identity, group, []);
  await transactWithPolicyVersion(
    db,
    identity.organizationId,
    async () => {
      const current = await db.table<OrganizationGroup>('organization_groups').getOne(group.id);
      if (!current || current.organizationId !== identity.organizationId) return null;
      return {
        operations: [
          {
            table: 'organization_groups',
            op: 'expect',
            id: group.id,
            where: [['organizationId', '==', identity.organizationId]],
            exists: true,
          },
          { table: 'organization_groups', op: 'delete', id: group.id },
        ],
        value: true,
      };
    },
  );
  await audit(db, identity, 'organization_scim.group.delete', 'organization_group', group.id, {
    displayName: group.name,
    removedMembers,
  });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

function discoveryResponse(resource: string, request: Request) {
  if (resource === 'ServiceProviderConfig') {
    return scimJson({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'Organization-scoped SCIM bearer token',
        specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
        primary: true,
      }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${scimBaseUrl(request)}/ServiceProviderConfig` },
    });
  }
  if (resource === 'ResourceTypes') {
    return scimJson(pageOf([
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA },
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCIM_GROUP_SCHEMA },
    ], request));
  }
  return scimJson(pageOf([
    { id: SCIM_USER_SCHEMA, name: 'User', description: 'Hanji organization member', attributes: [] },
    { id: SCIM_GROUP_SCHEMA, name: 'Group', description: 'Hanji organization group', attributes: [] },
  ], request));
}

function pathParts(context: ScimFunctionContext, request: Request) {
  const parameter = context.params?.slug;
  if (parameter) return parameter.split('/').map(decodeURIComponent).filter(Boolean);
  const marker = '/scim/v2/';
  const path = new URL(request.url).pathname;
  const index = path.indexOf(marker);
  return (index >= 0 ? path.slice(index + marker.length) : '')
    .split('/')
    .map(decodeURIComponent)
    .filter(Boolean);
}

export async function handleScimRequest(context: ScimFunctionContext) {
  const request = context.request;
  if (!request) return scimError(400, 'Request context is missing.');
  const db = context.admin.db('app');
  const identity = await authenticateScim(request, db);
  if (identity instanceof Response) return identity;
  const auth = context.admin.auth;
  const [resource, id] = pathParts(context, request);
  const method = request.method.toUpperCase();

  try {
    if (method === 'GET' && !id && ['ServiceProviderConfig', 'ResourceTypes', 'Schemas'].includes(resource)) {
      return discoveryResponse(resource, request);
    }
    if (resource === 'Users') {
      if (method === 'GET' && !id) return await listUsers(db, identity, request);
      if (method === 'GET' && id) return await getUser(db, identity, request, id);
      if (!auth) return scimError(503, 'The auth administration service is unavailable.');
      if (method === 'POST' && !id) return await createUser(db, auth, identity, request);
      if (method === 'PUT' && id) return await replaceOrPatchUser(db, auth, identity, request, id, true);
      if (method === 'PATCH' && id) return await replaceOrPatchUser(db, auth, identity, request, id, false);
      if (method === 'DELETE' && id) return await deleteUser(db, auth, identity, id);
    }
    if (resource === 'Groups') {
      if (method === 'GET' && !id) return await listGroups(db, identity, request);
      if (method === 'GET' && id) return await getGroup(db, identity, request, id);
      if (method === 'POST' && !id) return await createGroup(db, identity, request);
      if (method === 'PUT' && id) return await replaceOrPatchGroup(db, identity, request, id, true);
      if (method === 'PATCH' && id) return await replaceOrPatchGroup(db, identity, request, id, false);
      if (method === 'DELETE' && id) return await deleteGroup(db, identity, id);
    }
    return scimError(404, 'The SCIM endpoint was not found.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The SCIM request failed.';
    const errorStatus = error && typeof error === 'object'
      ? Number((error as { status?: unknown; code?: unknown }).status
        ?? (error as { code?: unknown }).code)
      : Number.NaN;
    const status = [400, 404, 409, 500].includes(errorStatus) ? errorStatus
      : /not found/i.test(message) ? 404
        : /already exists|uniqueness/i.test(message) ? 409
          : /required|invalid|unsupported|must/i.test(message) ? 400
            : 500;
    const scimType = status === 409 && /already exists|uniqueness/i.test(message)
      ? 'uniqueness'
      : status === 400 ? 'invalidValue' : undefined;
    return scimError(status, message, scimType);
  }
}

export { SCIM_PATCH_SCHEMA };
