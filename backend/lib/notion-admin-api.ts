import type { DbRef } from './app-types';
import { escapeHtml } from './html-escape';
import {
  NOTION_ADMIN_VERSION,
  NotionAdminApiError,
  authenticateNotionAdminToken,
  notionAdminCanAccessLegalHold,
  notionAdminCanAccessWorkspace,
  notionAdminCanCreateLegalHolds,
  notionAdminHasOrganizationWorkspaceAccess,
  requireNotionAdminCapability,
  sha256Hex,
  type NotionAdminCapability,
  type NotionAdminIdentity,
} from './notion-admin-auth';
import { recordOrganizationAudit } from './org-audit';
import { getExisting, listAll, nowIso, type TransactOperation } from './table-utils';
import { workspaceDb, type AdminDbAccessor } from './workspace-db';

const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const interactionTypes = new Set(['page.created', 'page.edited', 'page.viewed']);

export const NOTION_ADMIN_ROUTE_REGISTRY = [
  { method: 'POST', path: '/v1/legal_holds/{legal_hold_id}/export', scope: 'legal-hold:export' },
  { method: 'GET', path: '/v1/legal_holds/{legal_hold_id}', scope: 'legal-hold:read' },
  { method: 'PATCH', path: '/v1/legal_holds/{legal_hold_id}', scope: 'legal-hold:write' },
  { method: 'GET', path: '/v1/legal_holds/{legal_hold_id}/users', scope: 'legal-hold:read' },
  { method: 'POST', path: '/v1/legal_holds/{legal_hold_id}/users', scope: 'legal-hold:write' },
  { method: 'GET', path: '/v1/legal_holds', scope: 'legal-hold:read' },
  { method: 'POST', path: '/v1/legal_holds', scope: 'legal-hold:write' },
  { method: 'GET', path: '/v1/legal_holds/{legal_hold_id}/workspaces', scope: 'legal-hold:read' },
  { method: 'POST', path: '/v1/legal_holds/{legal_hold_id}/release', scope: 'legal-hold:write-high-impact' },
  { method: 'DELETE', path: '/v1/legal_holds/{legal_hold_id}/users/{user_id}', scope: 'legal-hold:write' },
  { method: 'POST', path: '/v1/exports', scope: 'workspace:export' },
  { method: 'GET', path: '/v1/legal_holds/{legal_hold_id}/spaces/{space_id}/pages', scope: 'legal-hold:read' },
  { method: 'POST', path: '/v1/managed_users/revoke_session', scope: 'managed-user-session:write' },
] as const satisfies ReadonlyArray<{ method: string; path: string; scope: NotionAdminCapability }>;

interface TableRow {
  id: string;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationMember extends TableRow {
  organizationId: string;
  userId: string;
  email?: string | null;
  status?: string | null;
}

interface OrganizationGovernanceAnchor extends TableRow {
  governanceVersion?: number | null;
}

interface Workspace extends TableRow {
  organizationId?: string | null;
  name?: string;
}

interface Page extends TableRow {
  workspaceId: string;
  createdBy?: string | null;
  lastEditedBy?: string | null;
}

interface OrganizationLegalHold extends TableRow {
  organizationId: string;
  name: string;
  status?: string | null;
  reason?: string | null;
  scope?: unknown;
  createdBy?: string | null;
  releasedAt?: string | null;
  releasedBy?: string | null;
}

interface OrganizationPolicyVersion extends TableRow {
  organizationId: string;
  version?: number | null;
}

interface OrganizationAdminExportTask extends TableRow {
  organizationId: string;
  kind: 'workspace' | 'legal_hold';
  workspaceId?: string | null;
  legalHoldId?: string | null;
  requestingUserId: string;
  exportType: string;
  requestedFormat: string;
  status?: string | null;
  request?: unknown;
  requestHash: string;
  idempotencyKeyHash?: string | null;
  taskId: string;
  tokenId: string;
  result?: unknown;
  error?: unknown;
  createdBy?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface AuthAdmin {
  revokeAllSessions(userId: string): Promise<void>;
}

export interface NotionAdminFunctionContext {
  request?: Request;
  params?: { slug?: string } | Record<string, string>;
  waitUntil?: (promise: Promise<unknown>) => void;
  admin: AdminDbAccessor & { auth?: AuthAdmin };
}

export interface NotionAdminCanonicalOperations {
  executeWorkspaceExport?(input: {
    organizationId: string;
    workspaceId: string;
    actorId: string;
    actorEmail: string;
    request: Record<string, unknown>;
  }): Promise<unknown>;
  executeLegalHoldExport?(input: {
    organizationId: string;
    legalHoldId: string;
    workspaceId: string;
    requestingUserId: string;
    actorId: string;
    userIds: string[];
  }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function notionAdminArtifactFromMarkdown(markdown: string, format: 'markdown' | 'html') {
  const content = format === 'html'
    ? `<!doctype html>\n<html><head><meta charset="utf-8"><title>Workspace export</title></head><body><pre>${escapeHtml(markdown)}</pre></body></html>\n`
    : markdown;
  return {
    format,
    mediaType: format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    content,
    byteLength: new TextEncoder().encode(content).byteLength,
    generatedFrom: 'canonical_markdown',
  };
}

function apiJson(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function notionAdminErrorResponse(error: unknown) {
  const rawStatus = error && typeof error === 'object'
    ? Number((error as { status?: unknown; code?: unknown }).status
      ?? (error as { status?: unknown; code?: unknown }).code)
    : NaN;
  const known = error instanceof NotionAdminApiError
    ? error
    : rawStatus === 429
      ? new NotionAdminApiError(429, 'rate_limited', 'Rate limited.')
      : new NotionAdminApiError(500, 'internal_server_error', 'An unexpected error occurred.');
  return apiJson({
    type: 'error',
    code: known.code,
    status: known.status,
    message: known.message,
  }, known.status, {
    ...(known.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Hanji Notion Admin API"' } : {}),
    ...(known.status === 429 && known.retryAfterSeconds !== undefined
      ? { 'Retry-After': String(known.retryAfterSeconds) }
      : {}),
  });
}

function validation(message: string): never {
  throw new NotionAdminApiError(400, 'validation_error', message);
}

function boundedString(value: unknown, label: string, maxLength = 1_000) {
  if (typeof value !== 'string' || value.trim().length === 0) validation(`${label} is required.`);
  const text = (value as string).trim();
  if (text.length > maxLength) validation(`${label} is too long.`);
  return text;
}

function optionalString(value: unknown, label: string, maxLength: number) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) validation(`${label} must be a string of at most ${maxLength} characters.`);
  return value;
}

function uuid(value: unknown, label: string) {
  const text = boundedString(value, label, 100);
  if (!UUID_RE.test(text)) validation(`${label} must be a UUID.`);
  return text;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) validation(`${label} must be a finite number.`);
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    validation(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function uuidList(value: unknown, label: string, allowEmpty = true) {
  if (!Array.isArray(value) || value.length > 500 || (!allowEmpty && value.length === 0)) {
    validation(`${label} must be an array with ${allowEmpty ? 'at most' : 'between 1 and'} 500 UUIDs.`);
  }
  return Array.from(new Set((value as unknown[]).map((entry) => uuid(entry, label))));
}

function stringList(value: unknown, label: string, limit = 500) {
  if (!Array.isArray(value) || value.length > limit) validation(`${label} must be an array with at most ${limit} strings.`);
  return Array.from(new Set(value.map((entry) => boundedString(entry, label, 200))));
}

function normalizedEmail(value: unknown, label = 'email') {
  const email = boundedString(value, label, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) validation(`${label} must be a valid email address.`);
  return email;
}

async function requestBody(request: Request) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    validation('The request body must be valid JSON.');
  }
  if (!isRecord(value)) validation('The request body must be a JSON object.');
  return value as Record<string, unknown>;
}

function assertVersion(request: Request) {
  if (request.headers.get('Notion-Version')?.trim() !== NOTION_ADMIN_VERSION) {
    validation(`Notion-Version must be '${NOTION_ADMIN_VERSION}'.`);
  }
}

function assertQueryKeys(request: Request, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  for (const key of new URL(request.url).searchParams.keys()) {
    if (!allowedSet.has(key)) validation(`Unsupported query parameter: ${key}.`);
  }
}

function pathParts(context: NotionAdminFunctionContext, request: Request) {
  const slug = context.params && typeof context.params.slug === 'string'
    ? context.params.slug
    : '';
  if (slug) return slug.split('?', 1)[0].split('/').filter(Boolean).map(decodeURIComponent);
  const marker = '/notion/admin/v1/';
  const path = new URL(request.url).pathname;
  const index = path.indexOf(marker);
  return (index >= 0 ? path.slice(index + marker.length) : '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
}

function scopeObject(hold: OrganizationLegalHold) {
  return isRecord(hold.scope) ? hold.scope : {};
}

function adminHoldMetadata(hold: OrganizationLegalHold) {
  const scope = scopeObject(hold);
  return isRecord(scope.adminApi) ? scope.adminApi : {};
}

function holdUserIds(hold: OrganizationLegalHold) {
  const users = scopeObject(hold).userIds;
  if (!Array.isArray(users)) return [];
  return Array.from(new Set(users.filter((value): value is string => typeof value === 'string'))).sort();
}

async function organizationWorkspaces(db: DbRef, organizationId: string) {
  return (await listAll(db.table<Workspace>('workspaces').where('organizationId', '==', organizationId)))
    .filter((workspace) => workspace.organizationId === organizationId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function holdWorkspaceIds(
  hold: OrganizationLegalHold,
  workspaces: Workspace[],
  identity: NotionAdminIdentity,
) {
  const scope = scopeObject(hold);
  const explicit = Array.isArray(scope.workspaceIds)
    ? scope.workspaceIds.filter((value): value is string => typeof value === 'string')
    : [];
  const organizationWide = scope.all === true || holdUserIds(hold).length > 0 || isRecord(scope.adminApi);
  const candidates = organizationWide
    ? workspaces.map((workspace) => workspace.id)
    : explicit.filter((id) => workspaces.some((workspace) => workspace.id === id));
  return Array.from(new Set(candidates))
    .filter((workspaceId) => notionAdminCanAccessWorkspace(identity, workspaceId))
    .sort();
}

async function legalHoldResponse(
  db: DbRef,
  hold: OrganizationLegalHold,
  identity: NotionAdminIdentity,
) {
  const metadata = adminHoldMetadata(hold);
  const createdTime = hold.createdAt && Number.isFinite(Date.parse(hold.createdAt))
    ? Date.parse(hold.createdAt)
    : 0;
  const users = holdUserIds(hold);
  const workspaceIds = holdWorkspaceIds(
    hold,
    await organizationWorkspaces(db, identity.organizationId),
    identity,
  );
  const interactions = Array.isArray(metadata.userInteractionType)
    ? metadata.userInteractionType.filter((entry): entry is string =>
      typeof entry === 'string' && interactionTypes.has(entry))
    : ['page.created', 'page.edited', 'page.viewed'];
  const startDate = typeof metadata.startDate === 'number' && Number.isFinite(metadata.startDate)
    ? metadata.startDate
    : createdTime;
  return {
    created_by: hold.createdBy ?? identity.token.createdBy,
    created_time: createdTime,
    id: hold.id,
    start_date: startDate,
    status: hold.status === 'released' ? 'released' : 'active',
    user_interaction_type: interactions,
    users: { ids: users, total: users.length },
    workspaces: { ids: workspaceIds, total: workspaceIds.length },
    ...(typeof hold.reason === 'string' ? { description: hold.reason } : {}),
    ...(typeof metadata.endDate === 'number' && Number.isFinite(metadata.endDate)
      ? { end_date: metadata.endDate }
      : {}),
    ...(typeof metadata.icon === 'string' ? { icon: metadata.icon } : {}),
    ...(typeof hold.name === 'string' ? { name: hold.name } : {}),
  };
}

async function requireLegalHold(
  db: DbRef,
  identity: NotionAdminIdentity,
  legalHoldId: string,
) {
  const hold = await getExisting(db.table<OrganizationLegalHold>('organization_legal_holds'), legalHoldId);
  if (!hold || hold.organizationId !== identity.organizationId) {
    throw new NotionAdminApiError(404, 'not_found', 'The legal hold was not found.');
  }
  if (!notionAdminCanAccessLegalHold(identity, hold.id)) {
    throw new NotionAdminApiError(403, 'forbidden', 'The token cannot access this legal hold.');
  }
  return hold;
}

async function requireOrganizationUsers(db: DbRef, organizationId: string, userIds: string[]) {
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
  );
  const active = members.filter((member) =>
    member.organizationId === organizationId && (member.status ?? 'active') === 'active');
  for (const userId of userIds) {
    if (!active.some((member) => member.userId === userId)) {
      throw new NotionAdminApiError(404, 'not_found', 'A managed user was not found.');
    }
  }
  return active;
}

function pageByCursor<T>(items: T[], cursor: string | null, idOf: (item: T) => string) {
  let start = 0;
  if (cursor) {
    const index = items.findIndex((item) => idOf(item) === cursor);
    if (index < 0) validation('start_cursor is invalid.');
    start = index + 1;
  }
  const page = items.slice(start, start + PAGE_SIZE);
  const hasMore = start + page.length < items.length;
  return {
    page,
    ...(hasMore && page.length ? { nextCursor: idOf(page[page.length - 1]) } : {}),
  };
}

function startCursor(request: Request) {
  const value = new URL(request.url).searchParams.get('start_cursor');
  return value && value.trim() ? value.trim() : null;
}

async function audit(
  db: DbRef,
  identity: NotionAdminIdentity,
  action: string,
  targetType: string,
  targetId: string,
  metadata?: Record<string, unknown>,
) {
  await recordOrganizationAudit(db, {
    organizationId: identity.organizationId,
    workspaceId: null,
    actorId: identity.token.createdBy ?? null,
    action,
    targetType,
    targetId,
    metadata: { tokenId: identity.token.id, ...metadata },
    occurredAt: nowIso(),
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

async function deterministicUuid(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idempotencyKey(request: Request) {
  const value = request.headers.get('Idempotency-Key');
  if (value == null) return null;
  const key = value.trim();
  if (!key || key.length > 200) validation('Idempotency-Key must contain between 1 and 200 characters.');
  return key;
}

function conflictError(error: unknown) {
  const status = error && typeof error === 'object'
    ? Number((error as { status?: unknown; code?: unknown }).status
      ?? (error as { status?: unknown; code?: unknown }).code)
    : NaN;
  return status === 409 || (error instanceof Error && /expectation failed|already exists|conflict|unique/i.test(error.message));
}

type ExpectOperation = Extract<TransactOperation, { op: 'expect' }>;

interface GovernanceRequirement {
  capability: NotionAdminCapability;
  legalHoldId?: string;
  organizationWide?: boolean;
}

interface GovernanceAuthoritySnapshot {
  tokenId: string;
  tokenHash: string | null;
  updatedAt: string | null;
  scopesFingerprint: string;
  guard: ExpectOperation;
  requirement: GovernanceRequirement;
}

interface GovernancePolicyPlan {
  operations: TransactOperation[];
  nextVersion: number;
}

interface GovernanceOrganizationPlan {
  operations: [ExpectOperation, TransactOperation];
  nextVersion: number;
}

async function governanceOrganizationPlan(
  db: DbRef,
  organizationId: string,
): Promise<GovernanceOrganizationPlan> {
  const organization = await getExisting(
    db.table<OrganizationGovernanceAnchor>('organizations'),
    organizationId,
  );
  if (!organization) {
    throw new NotionAdminApiError(
      409,
      'validation_error',
      'The organization governance state changed concurrently. Retry the request.',
    );
  }
  const hasVersion = Number.isSafeInteger(organization.governanceVersion)
    && Number(organization.governanceVersion) >= 0;
  if (
    !hasVersion
    && organization.governanceVersion !== null
    && organization.governanceVersion !== undefined
  ) {
    throw new NotionAdminApiError(
      409,
      'validation_error',
      'The organization governance version is malformed.',
    );
  }
  const version = hasVersion ? Number(organization.governanceVersion) : 0;
  return {
    nextVersion: version + 1,
    operations: [
      {
        table: 'organizations',
        op: 'expect',
        id: organizationId,
        where: [['governanceVersion', '==', hasVersion ? version : null]],
        exists: true,
      },
      {
        table: 'organizations',
        op: 'update',
        id: organizationId,
        data: { governanceVersion: version + 1 },
      },
    ],
  };
}

function rawScopeAuthorization(
  value: unknown,
  organizationId: string,
  requirement: GovernanceRequirement,
) {
  if (!isRecord(value) || !isRecord(value.resources)) return 'invalid' as const;
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (!capabilities.includes(requirement.capability)) return 'missing_scope' as const;
  const resources = value.resources;
  if (resources.organizationId !== organizationId) return 'forbidden' as const;
  const workspaceIds = Array.isArray(resources.workspaceIds)
    ? resources.workspaceIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const legalHoldIds = Array.isArray(resources.legalHoldIds)
    ? resources.legalHoldIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (requirement.organizationWide) {
    return workspaceIds.length === 1 && workspaceIds[0] === '*'
      && legalHoldIds.length === 1 && legalHoldIds[0] === '*'
      ? 'allowed' as const
      : 'forbidden' as const;
  }
  if (
    requirement.legalHoldId
    && !legalHoldIds.includes('*')
    && !legalHoldIds.includes(requirement.legalHoldId)
  ) {
    return 'forbidden' as const;
  }
  return 'allowed' as const;
}

function authorityAccessError(
  identity: NotionAdminIdentity,
  requirement: GovernanceRequirement,
  reason: 'missing_scope' | 'forbidden' | 'invalid' = 'forbidden',
) {
  if (reason === 'missing_scope') {
    return new NotionAdminApiError(
      403,
      'missing_scope',
      `The token is missing the '${requirement.capability}' scope.`,
    );
  }
  return new NotionAdminApiError(
    403,
    'forbidden',
    reason === 'invalid'
      ? 'The token authority is no longer valid.'
      : `The token no longer has authority for organization ${identity.organizationId}.`,
  );
}

async function governanceAuthoritySnapshot(
  db: DbRef,
  identity: NotionAdminIdentity,
  requirement: GovernanceRequirement,
): Promise<GovernanceAuthoritySnapshot> {
  const token = await getExisting(
    db.table<NotionAdminIdentity['token']>('organization_admin_tokens'),
    identity.token.id,
  );
  if (
    !token
    || token.organizationId !== identity.organizationId
    || (token.status ?? 'active') !== 'active'
    || typeof token.tokenHash !== 'string'
    || token.tokenHash !== identity.token.tokenHash
    || !token.createdBy
    || (token.expiresAt !== null
      && token.expiresAt !== undefined
      && Date.parse(token.expiresAt) <= Date.now())
  ) {
    throw authorityAccessError(identity, requirement);
  }
  const scopesFingerprint = stableJson(identity.scopes);
  if (stableJson(token.scopes) !== scopesFingerprint) {
    const authorization = rawScopeAuthorization(token.scopes, identity.organizationId, requirement);
    if (authorization !== 'allowed') {
      throw authorityAccessError(identity, requirement, authorization);
    }
    throw new NotionAdminApiError(
      409,
      'validation_error',
      'The token authority changed concurrently. Retry the request.',
    );
  }
  return {
    tokenId: token.id,
    tokenHash: token.tokenHash ?? null,
    updatedAt: token.updatedAt ?? null,
    scopesFingerprint,
    requirement,
    guard: {
      table: 'organization_admin_tokens',
      op: 'expect',
      id: token.id,
      // transact expect rejects JSON objects; the schema-managed updatedAt is
      // the strongest scalar revision available for scopes in the current row.
      where: [
        ['organizationId', '==', identity.organizationId],
        ['label', '==', token.label],
        ['status', '==', token.status ?? null],
        ['tokenPrefix', '==', token.tokenPrefix ?? null],
        ['tokenHash', '==', token.tokenHash ?? null],
        ['createdBy', '==', token.createdBy ?? null],
        ['expiresAt', '==', token.expiresAt ?? null],
        ['revokedAt', '==', token.revokedAt ?? null],
        ['revokedBy', '==', token.revokedBy ?? null],
        ['createdAt', '==', token.createdAt ?? null],
        ['updatedAt', '==', token.updatedAt ?? null],
      ],
      exists: true,
    },
  };
}

async function assertGovernanceAuthorityUnchanged(
  db: DbRef,
  identity: NotionAdminIdentity,
  snapshot: GovernanceAuthoritySnapshot,
) {
  const token = await getExisting(
    db.table<NotionAdminIdentity['token']>('organization_admin_tokens'),
    snapshot.tokenId,
  );
  if (
    !token
    || token.organizationId !== identity.organizationId
    || (token.status ?? 'active') !== 'active'
    || token.tokenHash !== snapshot.tokenHash
    || !token.createdBy
    || (token.expiresAt !== null
      && token.expiresAt !== undefined
      && Date.parse(token.expiresAt) <= Date.now())
  ) {
    throw authorityAccessError(identity, snapshot.requirement);
  }
  const scopesFingerprint = stableJson(token.scopes);
  if (scopesFingerprint !== snapshot.scopesFingerprint) {
    const authorization = rawScopeAuthorization(
      token.scopes,
      identity.organizationId,
      snapshot.requirement,
    );
    if (authorization !== 'allowed') {
      throw authorityAccessError(identity, snapshot.requirement, authorization);
    }
  }
  if ((token.updatedAt ?? null) !== snapshot.updatedAt || scopesFingerprint !== snapshot.scopesFingerprint) {
    throw new NotionAdminApiError(
      409,
      'validation_error',
      'The token authority changed concurrently. Retry the request.',
    );
  }
}

async function governancePolicyPlan(db: DbRef, organizationId: string): Promise<GovernancePolicyPlan> {
  const rows = await listAll(
    db.table<OrganizationPolicyVersion>('organization_policy_versions')
      .where('organizationId', '==', organizationId),
  );
  if (rows.length > 1) {
    throw new NotionAdminApiError(
      409,
      'validation_error',
      'The organization policy version is not uniquely configured.',
    );
  }
  const current = rows[0] ?? null;
  if (current) {
    const hasVersion = Number.isSafeInteger(current.version) && Number(current.version) >= 0;
    if (!hasVersion && current.version !== null && current.version !== undefined) {
      throw new NotionAdminApiError(
        409,
        'validation_error',
        'The organization policy version is malformed.',
      );
    }
    const version = hasVersion ? Number(current.version) : 0;
    return {
      nextVersion: version + 1,
      operations: [
        {
          table: 'organization_policy_versions',
          op: 'expect',
          id: current.id,
          where: [
            ['organizationId', '==', organizationId],
            ['version', '==', hasVersion ? version : null],
          ],
          exists: true,
        },
        {
          table: 'organization_policy_versions',
          op: 'update',
          id: current.id,
          data: { version: version + 1 },
        },
      ],
    };
  }
  return {
    nextVersion: 1,
    operations: [
      {
        table: 'organization_policy_versions',
        op: 'expect',
        where: [['organizationId', '==', organizationId]],
        exists: false,
      },
      {
        table: 'organization_policy_versions',
        op: 'insert',
        data: { id: organizationId, organizationId, version: 1 },
      },
    ],
  };
}

function legalHoldTargetGuard(hold: OrganizationLegalHold): ExpectOperation {
  return {
    table: 'organization_legal_holds',
    op: 'expect',
    id: hold.id,
    // scope is JSON, so updatedAt carries its commit-time revision while all
    // independently comparable preservation fields are guarded explicitly.
    where: [
      ['organizationId', '==', hold.organizationId],
      ['name', '==', hold.name],
      ['status', '==', hold.status ?? null],
      ['reason', '==', hold.reason ?? null],
      ['createdBy', '==', hold.createdBy ?? null],
      ['releasedAt', '==', hold.releasedAt ?? null],
      ['releasedBy', '==', hold.releasedBy ?? null],
      ['createdAt', '==', hold.createdAt ?? null],
      ['updatedAt', '==', hold.updatedAt ?? null],
    ],
    exists: true,
  };
}

function governanceAuditOperation(
  identity: NotionAdminIdentity,
  action: string,
  targetId: string,
  occurredAt: string,
  metadata?: Record<string, unknown>,
): TransactOperation {
  return {
    table: 'organization_audit_events',
    op: 'insert',
    data: {
      id: crypto.randomUUID(),
      organizationId: identity.organizationId,
      workspaceId: null,
      actorId: identity.token.createdBy ?? null,
      action,
      targetType: 'organization_legal_hold',
      targetId,
      metadata: { tokenId: identity.token.id, ...metadata },
      occurredAt,
    },
  };
}

async function transactLegalHoldGovernance(
  db: DbRef,
  identity: NotionAdminIdentity,
  authority: GovernanceAuthoritySnapshot,
  targetGuard: ExpectOperation,
  mutation: TransactOperation,
  auditOperation: TransactOperation,
) {
  const organization = await governanceOrganizationPlan(db, identity.organizationId);
  const policy = await governancePolicyPlan(db, identity.organizationId);
  try {
    await db.transact([
      ...organization.operations,
      authority.guard,
      targetGuard,
      mutation,
      ...policy.operations,
      auditOperation,
    ]);
  } catch (error) {
    if (!conflictError(error)) throw error;
    await assertGovernanceAuthorityUnchanged(db, identity, authority);
    throw new NotionAdminApiError(
      409,
      'validation_error',
      'The legal hold or organization policy changed concurrently. Retry the request.',
    );
  }
  return {
    governanceVersion: organization.nextVersion,
    policyVersion: policy.nextVersion,
  };
}

async function exportTask(
  db: DbRef,
  identity: NotionAdminIdentity,
  input: {
    kind: 'workspace' | 'legal_hold';
    workspaceId?: string;
    legalHoldId?: string;
    requestingUserId: string;
    exportType: string;
    request: Record<string, unknown>;
    idempotencyKey: string | null;
  },
) {
  const requestHash = await sha256Hex(stableJson(input.request));
  const operation = input.kind === 'workspace'
    ? `workspace:${input.workspaceId}`
    : `legal-hold:${input.legalHoldId}:${input.workspaceId}`;
  const id = input.idempotencyKey
    ? await deterministicUuid(`${identity.organizationId}|${identity.token.id}|${operation}|${input.idempotencyKey}`)
    : crypto.randomUUID();
  const taskId = await deterministicUuid(`${id}|task`);
  const now = nowIso();
  try {
    const task = await db.table<OrganizationAdminExportTask>('organization_admin_export_tasks').insert({
      id,
      organizationId: identity.organizationId,
      kind: input.kind,
      workspaceId: input.workspaceId ?? null,
      legalHoldId: input.legalHoldId ?? null,
      requestingUserId: input.requestingUserId,
      exportType: input.exportType,
      requestedFormat: input.exportType,
      status: 'queued',
      request: input.request,
      requestHash,
      idempotencyKeyHash: input.idempotencyKey ? await sha256Hex(input.idempotencyKey) : null,
      taskId,
      tokenId: identity.token.id,
      createdBy: identity.token.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { task, created: true };
  } catch (error) {
    if (!input.idempotencyKey || !conflictError(error)) throw error;
    const existing = await getExisting(
      db.table<OrganizationAdminExportTask>('organization_admin_export_tasks'),
      id,
    );
    if (
      !existing
      || existing.organizationId !== identity.organizationId
      || existing.tokenId !== identity.token.id
      || existing.requestHash !== requestHash
      || existing.kind !== input.kind
    ) {
      validation('Idempotency-Key was already used with a different request.');
    }
    return { task: existing, created: false };
  }
}

function scheduleExportTask(
  context: NotionAdminFunctionContext,
  db: DbRef,
  task: OrganizationAdminExportTask,
  execute: () => Promise<unknown>,
) {
  const work = (async () => {
    const startedAt = nowIso();
    await db.table<OrganizationAdminExportTask>('organization_admin_export_tasks').update(task.id, {
      status: 'running',
      startedAt,
      updatedAt: startedAt,
    });
    try {
      const result = await execute();
      const completedAt = nowIso();
      await db.table<OrganizationAdminExportTask>('organization_admin_export_tasks').update(task.id, {
        status: 'completed',
        result,
        error: null,
        completedAt,
        updatedAt: completedAt,
      });
    } catch (error) {
      const completedAt = nowIso();
      const message = error instanceof Error ? error.message.slice(0, 500) : 'The export failed.';
      await db.table<OrganizationAdminExportTask>('organization_admin_export_tasks').update(task.id, {
        status: 'failed',
        error: { type: 'error', code: 'internal_server_error', status: 500, message },
        completedAt,
        updatedAt: completedAt,
      });
    }
  })();
  if (context.waitUntil) context.waitUntil(work);
  else void work.catch(() => {});
}

async function createLegalHold(
  context: NotionAdminFunctionContext,
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
) {
  requireNotionAdminCapability(identity, 'legal-hold:write');
  if (!notionAdminCanCreateLegalHolds(identity) || !notionAdminHasOrganizationWorkspaceAccess(identity)) {
    throw new NotionAdminApiError(
      403,
      'forbidden',
      'Creating an organization-wide legal hold requires organization-wide resource access.',
    );
  }
  const body = await requestBody(request);
  const name = boundedString(body.name, 'name', 200);
  const startDate = finiteNumber(body.start_date, 'start_date');
  const userIds = uuidList(body.user_ids, 'user_ids', false);
  const requestedInteractions = body.user_interaction_type;
  if (!Array.isArray(requestedInteractions) || requestedInteractions.length === 0) {
    validation('user_interaction_type must be a non-empty array.');
  }
  const userInteractionType = Array.from(new Set(requestedInteractions.map((entry) => {
    if (typeof entry !== 'string' || !interactionTypes.has(entry)) {
      validation('user_interaction_type contains an unsupported interaction.');
    }
    return entry as string;
  })));
  const description = optionalString(body.description, 'description', 2_000);
  const icon = optionalString(body.icon, 'icon', 500);
  const endDate = body.end_date === undefined ? undefined : finiteNumber(body.end_date, 'end_date');
  if (endDate !== undefined && endDate < startDate) validation('end_date must not be earlier than start_date.');
  await requireOrganizationUsers(db, identity.organizationId, userIds);

  const normalized = {
    name,
    start_date: startDate,
    user_ids: userIds,
    user_interaction_type: userInteractionType,
    ...(description !== undefined ? { description } : {}),
    ...(endDate !== undefined ? { end_date: endDate } : {}),
    ...(icon !== undefined ? { icon } : {}),
  };
  const key = idempotencyKey(request);
  if (!key) {
    validation('Idempotency-Key is required when creating a legal hold.');
  }
  const requestHash = await sha256Hex(stableJson(normalized));
  const legalHoldId = await deterministicUuid(
    `${identity.organizationId}|${identity.token.id}|legal-hold:create|${key}`,
  );
  const keyHash = await sha256Hex(key);
  const now = nowIso();
  const hold: OrganizationLegalHold = {
    id: legalHoldId,
    organizationId: identity.organizationId,
    name,
    status: 'active',
    reason: description,
    // The current preservation engine has no durable view-event history.
    // Conservatively holding all organization pages prevents an API-created
    // user interaction hold from claiming narrower enforcement than exists.
    scope: {
      all: true,
      workspaceIds: [],
      pageIds: [],
      userIds,
      adminApi: {
        startDate,
        ...(endDate !== undefined ? { endDate } : {}),
        ...(icon !== undefined ? { icon } : {}),
        userInteractionType,
        idempotency: { keyHash, requestHash, tokenId: identity.token.id },
      },
    },
    createdBy: identity.token.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const authority = await governanceAuthoritySnapshot(db, identity, {
    capability: 'legal-hold:write',
    organizationWide: true,
  });
  try {
    await transactLegalHoldGovernance(
      db,
      identity,
      authority,
      {
        table: 'organization_legal_holds',
        op: 'expect',
        id: legalHoldId,
        exists: false,
      },
      {
        table: 'organization_legal_holds',
        op: 'insert',
        data: hold as unknown as Record<string, unknown>,
      },
      governanceAuditOperation(
        identity,
        'notion_admin.legal_hold.create',
        legalHoldId,
        now,
        { userCount: userIds.length, userInteractionType },
      ),
    );
  } catch (error) {
    if (!(error instanceof NotionAdminApiError) || error.status !== 409) throw error;
    const existing = await getExisting(db.table<OrganizationLegalHold>('organization_legal_holds'), legalHoldId);
    if (!existing) throw error;
    const idempotency = existing ? adminHoldMetadata(existing).idempotency : null;
    if (
      existing.organizationId !== identity.organizationId
      || !isRecord(idempotency)
      || idempotency.keyHash !== keyHash
      || idempotency.requestHash !== requestHash
      || idempotency.tokenId !== identity.token.id
    ) {
      validation('Idempotency-Key was already used with a different request.');
    }
    return legalHoldResponse(db, existing, identity);
  }
  return legalHoldResponse(db, hold, identity);
}

async function listLegalHolds(
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
) {
  requireNotionAdminCapability(identity, 'legal-hold:read');
  assertQueryKeys(request, ['start_cursor', 'user_id']);
  const userFilterValue = new URL(request.url).searchParams.get('user_id');
  const userFilter = userFilterValue ? uuid(userFilterValue, 'user_id') : null;
  const holds = (await listAll(
    db.table<OrganizationLegalHold>('organization_legal_holds').where('organizationId', '==', identity.organizationId),
  ))
    .filter((hold) => hold.organizationId === identity.organizationId)
    .filter((hold) => notionAdminCanAccessLegalHold(identity, hold.id))
    .filter((hold) => !userFilter || holdUserIds(hold).includes(userFilter))
    .sort((left, right) =>
      (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.id.localeCompare(right.id));
  const window = pageByCursor(holds, startCursor(request), (hold) => hold.id);
  return {
    legal_holds: await Promise.all(window.page.map((hold) => legalHoldResponse(db, hold, identity))),
    ...(window.nextCursor ? { next_cursor: window.nextCursor } : {}),
  };
}

async function updateLegalHold(
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
  legalHoldId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:write');
  const hold = await requireLegalHold(db, identity, legalHoldId);
  const body = await requestBody(request);
  const patch: Partial<OrganizationLegalHold> = {};
  const fields: string[] = [];
  if ('name' in body) {
    const name = optionalString(body.name, 'name', 200) as string;
    if (name !== hold.name) {
      patch.name = name;
      fields.push('name');
    }
  }
  if ('description' in body) {
    const reason = optionalString(body.description, 'description', 2_000) as string;
    if (reason !== hold.reason) {
      patch.reason = reason;
      fields.push('description');
    }
  }
  if ('icon' in body) {
    const icon = optionalString(body.icon, 'icon', 500) as string;
    if (icon !== adminHoldMetadata(hold).icon) {
      patch.scope = {
        ...scopeObject(hold),
        adminApi: { ...adminHoldMetadata(hold), icon },
      };
      fields.push('icon');
    }
  }
  if (Object.keys(patch).length === 0) return legalHoldResponse(db, hold, identity);
  const now = nowIso();
  patch.updatedAt = now;
  const authority = await governanceAuthoritySnapshot(db, identity, {
    capability: 'legal-hold:write',
    legalHoldId: hold.id,
  });
  await transactLegalHoldGovernance(
    db,
    identity,
    authority,
    legalHoldTargetGuard(hold),
    {
      table: 'organization_legal_holds',
      op: 'update',
      id: hold.id,
      data: { ...patch },
    },
    governanceAuditOperation(
      identity,
      'notion_admin.legal_hold.update',
      hold.id,
      now,
      { fields },
    ),
  );
  const updated = { ...hold, ...patch };
  return legalHoldResponse(db, updated, identity);
}

async function addLegalHoldUsers(
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
  legalHoldId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:write');
  const hold = await requireLegalHold(db, identity, legalHoldId);
  if ((hold.status ?? 'active') !== 'active') validation('Users cannot be added to a released legal hold.');
  const body = await requestBody(request);
  const added = uuidList(body.user_ids, 'user_ids');
  await requireOrganizationUsers(db, identity.organizationId, added);
  const users = Array.from(new Set([...holdUserIds(hold), ...added])).sort();
  if (users.length === holdUserIds(hold).length) return legalHoldResponse(db, hold, identity);
  const now = nowIso();
  const patch = {
    scope: { ...scopeObject(hold), all: users.length > 0, userIds: users },
    updatedAt: now,
  };
  const authority = await governanceAuthoritySnapshot(db, identity, {
    capability: 'legal-hold:write',
    legalHoldId: hold.id,
  });
  await transactLegalHoldGovernance(
    db,
    identity,
    authority,
    legalHoldTargetGuard(hold),
    {
      table: 'organization_legal_holds',
      op: 'update',
      id: hold.id,
      data: patch,
    },
    governanceAuditOperation(
      identity,
      'notion_admin.legal_hold.users_add',
      hold.id,
      now,
      { userIds: added },
    ),
  );
  const updated = { ...hold, ...patch };
  return legalHoldResponse(db, updated, identity);
}

async function removeLegalHoldUser(
  db: DbRef,
  identity: NotionAdminIdentity,
  legalHoldId: string,
  userId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:write');
  const hold = await requireLegalHold(db, identity, legalHoldId);
  const current = holdUserIds(hold);
  if (!current.includes(userId)) return legalHoldResponse(db, hold, identity);
  if ((hold.status ?? 'active') !== 'active') validation('Users cannot be removed from a released legal hold.');
  const users = current.filter((id) => id !== userId);
  const now = nowIso();
  const patch = {
    scope: { ...scopeObject(hold), all: users.length > 0, userIds: users },
    updatedAt: now,
  };
  const authority = await governanceAuthoritySnapshot(db, identity, {
    capability: 'legal-hold:write',
    legalHoldId: hold.id,
  });
  await transactLegalHoldGovernance(
    db,
    identity,
    authority,
    legalHoldTargetGuard(hold),
    {
      table: 'organization_legal_holds',
      op: 'update',
      id: hold.id,
      data: patch,
    },
    governanceAuditOperation(
      identity,
      'notion_admin.legal_hold.user_remove',
      hold.id,
      now,
      { userId },
    ),
  );
  const updated = { ...hold, ...patch };
  return legalHoldResponse(db, updated, identity);
}

async function listLegalHoldUsers(
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
  legalHoldId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:read');
  assertQueryKeys(request, ['start_cursor']);
  const hold = await requireLegalHold(db, identity, legalHoldId);
  const window = pageByCursor(holdUserIds(hold), startCursor(request), (id) => id);
  return {
    user_ids: window.page,
    ...(window.nextCursor ? { next_cursor: window.nextCursor } : {}),
  };
}

async function listLegalHoldWorkspaces(
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
  legalHoldId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:read');
  assertQueryKeys(request, ['start_cursor']);
  const hold = await requireLegalHold(db, identity, legalHoldId);
  const ids = holdWorkspaceIds(
    hold,
    await organizationWorkspaces(db, identity.organizationId),
    identity,
  );
  const window = pageByCursor(ids, startCursor(request), (id) => id);
  return {
    workspace_ids: window.page,
    ...(window.nextCursor ? { next_cursor: window.nextCursor } : {}),
  };
}

async function listLegalHoldPages(
  context: NotionAdminFunctionContext,
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
  legalHoldId: string,
  workspaceId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:read');
  assertQueryKeys(request, ['start_cursor']);
  const hold = await requireLegalHold(db, identity, legalHoldId);
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace || workspace.organizationId !== identity.organizationId) {
    throw new NotionAdminApiError(404, 'not_found', 'The workspace was not found.');
  }
  if (!notionAdminCanAccessWorkspace(identity, workspace.id)) {
    throw new NotionAdminApiError(403, 'forbidden', 'The token cannot access this workspace.');
  }
  const heldWorkspaceIds = holdWorkspaceIds(
    hold,
    await organizationWorkspaces(db, identity.organizationId),
    identity,
  );
  if (!heldWorkspaceIds.includes(workspace.id)) return { page_ids: [] };
  const pages = await listAll(
    workspaceDb(context.admin, workspace.id).table<Page>('pages').where('workspaceId', '==', workspace.id),
  );
  const scope = scopeObject(hold);
  const pageIds = Array.isArray(scope.pageIds)
    ? new Set(scope.pageIds.filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  const userIds = new Set(holdUserIds(hold));
  const includeAll = scope.all === true
    || (Array.isArray(scope.workspaceIds) && scope.workspaceIds.includes(workspace.id));
  const heldPages = pages
    .filter((page) => includeAll
      || pageIds.has(page.id)
      || (!!page.createdBy && userIds.has(page.createdBy))
      || (!!page.lastEditedBy && userIds.has(page.lastEditedBy)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const window = pageByCursor(heldPages, startCursor(request), (page) => page.id);
  return {
    page_ids: window.page.map((page) => page.id),
    ...(window.nextCursor ? { next_cursor: window.nextCursor } : {}),
  };
}

async function releaseLegalHold(
  db: DbRef,
  identity: NotionAdminIdentity,
  legalHoldId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:write-high-impact');
  const hold = await requireLegalHold(db, identity, legalHoldId);
  if ((hold.status ?? 'active') === 'released') return legalHoldResponse(db, hold, identity);
  const now = nowIso();
  const patch = {
    status: 'released',
    releasedAt: now,
    releasedBy: identity.token.createdBy ?? null,
    updatedAt: now,
  };
  const authority = await governanceAuthoritySnapshot(db, identity, {
    capability: 'legal-hold:write-high-impact',
    legalHoldId: hold.id,
  });
  await transactLegalHoldGovernance(
    db,
    identity,
    authority,
    legalHoldTargetGuard(hold),
    {
      table: 'organization_legal_holds',
      op: 'update',
      id: hold.id,
      data: patch,
    },
    governanceAuditOperation(
      identity,
      'notion_admin.legal_hold.release',
      hold.id,
      now,
    ),
  );
  const updated = { ...hold, ...patch };
  return legalHoldResponse(db, updated, identity);
}

function assertExactKeys(body: Record<string, unknown>, keys: readonly string[], label = 'request body') {
  const allowed = new Set(keys);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) validation(`${label} contains an unsupported property: ${key}.`);
  }
}

async function exportLegalHold(
  context: NotionAdminFunctionContext,
  operations: NotionAdminCanonicalOperations,
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
  legalHoldId: string,
) {
  requireNotionAdminCapability(identity, 'legal-hold:export');
  const hold = await requireLegalHold(db, identity, legalHoldId);
  const body = await requestBody(request);
  const hasExistingId = body.legal_hold_export_id !== undefined;
  const hasWorkspaceId = body.space_id !== undefined;
  if (hasExistingId === hasWorkspaceId) {
    validation('The request must contain exactly one of legal_hold_export_id or space_id.');
  }
  assertExactKeys(
    body,
    hasExistingId
      ? ['legal_hold_export_id', 'requesting_user_id']
      : ['requesting_user_id', 'space_id'],
  );
  const requestingUserId = uuid(body.requesting_user_id, 'requesting_user_id');
  await requireOrganizationUsers(db, identity.organizationId, [requestingUserId]);

  if (hasExistingId) {
    const taskId = uuid(body.legal_hold_export_id, 'legal_hold_export_id');
    const task = await getExisting(
      db.table<OrganizationAdminExportTask>('organization_admin_export_tasks'),
      taskId,
    );
    if (
      !task
      || task.organizationId !== identity.organizationId
      || task.kind !== 'legal_hold'
      || task.legalHoldId !== hold.id
      || task.requestingUserId !== requestingUserId
    ) {
      throw new NotionAdminApiError(404, 'not_found', 'The legal hold export was not found.');
    }
    return { legal_hold_export_id: task.id };
  }

  const workspaceId = uuid(body.space_id, 'space_id');
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace || workspace.organizationId !== identity.organizationId) {
    throw new NotionAdminApiError(404, 'not_found', 'The workspace was not found.');
  }
  if (!notionAdminCanAccessWorkspace(identity, workspace.id)) {
    throw new NotionAdminApiError(403, 'forbidden', 'The token cannot access this workspace.');
  }
  const heldWorkspaceIds = holdWorkspaceIds(
    hold,
    await organizationWorkspaces(db, identity.organizationId),
    identity,
  );
  if (!heldWorkspaceIds.includes(workspace.id)) {
    throw new NotionAdminApiError(403, 'forbidden', 'The workspace is not covered by this legal hold.');
  }
  const queued = await exportTask(db, identity, {
    kind: 'legal_hold',
    workspaceId: workspace.id,
    legalHoldId: hold.id,
    requestingUserId,
    exportType: 'jsonl',
    request: { requesting_user_id: requestingUserId, space_id: workspace.id },
    idempotencyKey: idempotencyKey(request),
  });
  if (queued.created) {
    await audit(db, identity, 'notion_admin.legal_hold.export_enqueue', 'organization_admin_export_task', queued.task.id, {
      legalHoldId: hold.id,
      workspaceId: workspace.id,
      requestingUserId,
    });
    scheduleExportTask(context, db, queued.task, async () => {
      if (!operations.executeLegalHoldExport) {
        throw new Error('The canonical legal hold export executor is unavailable.');
      }
      return operations.executeLegalHoldExport({
        organizationId: identity.organizationId,
        legalHoldId: hold.id,
        workspaceId: workspace.id,
        requestingUserId,
        actorId: identity.token.createdBy as string,
        userIds: holdUserIds(hold),
      });
    });
  }
  return { legal_hold_export_id: queued.task.id };
}

function workspaceExportBody(body: Record<string, unknown>) {
  const exportType = enumValue(body.export_type, ['html', 'markdown', 'pdf'] as const, 'export_type');
  const onBehalfOfUserEmail = normalizedEmail(body.on_behalf_of_user_email, 'on_behalf_of_user_email');
  const workspaceId = boundedString(body.space_id, 'space_id', 200);
  const normalized: Record<string, unknown> = {
    export_type: exportType,
    on_behalf_of_user_email: onBehalfOfUserEmail,
    space_id: workspaceId,
  };
  if (body.collection_view_export_type !== undefined) {
    normalized.collection_view_export_type = enumValue(
      body.collection_view_export_type,
      ['all', 'currentView'] as const,
      'collection_view_export_type',
    );
  }
  for (const key of ['flatten_export_filetree', 'include_comments'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') validation(`${key} must be a boolean.`);
      normalized[key] = body[key];
    }
  }
  if (body.include_contents !== undefined) {
    normalized.include_contents = enumValue(
      body.include_contents,
      ['everything', 'no_files'] as const,
      'include_contents',
    );
  }
  if (body.locale !== undefined) normalized.locale = boundedString(body.locale, 'locale', 100);
  if (body.pdf_format !== undefined) {
    normalized.pdf_format = enumValue(
      body.pdf_format,
      ['A3', 'A4', 'Legal', 'Letter', 'Tabloid'] as const,
      'pdf_format',
    );
  }
  if (body.teamspace_ids !== undefined) normalized.teamspace_ids = stringList(body.teamspace_ids, 'teamspace_ids', 200);
  if (body.time_zone !== undefined) normalized.time_zone = boundedString(body.time_zone, 'time_zone', 100);
  return { normalized, exportType, onBehalfOfUserEmail, workspaceId };
}

async function enqueueWorkspaceExport(
  context: NotionAdminFunctionContext,
  operations: NotionAdminCanonicalOperations,
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
) {
  requireNotionAdminCapability(identity, 'workspace:export');
  const body = await requestBody(request);
  const { normalized, exportType, onBehalfOfUserEmail, workspaceId } = workspaceExportBody(body);
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace || workspace.organizationId !== identity.organizationId) {
    throw new NotionAdminApiError(404, 'not_found', 'The workspace was not found.');
  }
  if (!notionAdminCanAccessWorkspace(identity, workspace.id)) {
    throw new NotionAdminApiError(403, 'forbidden', 'The token cannot access this workspace.');
  }
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', identity.organizationId),
  );
  const matches = members.filter((member) =>
    member.organizationId === identity.organizationId
    && (member.status ?? 'active') === 'active'
    && member.email?.trim().toLowerCase() === onBehalfOfUserEmail);
  if (matches.length !== 1) {
    throw new NotionAdminApiError(404, 'not_found', 'The managed user was not found.');
  }
  const actor = matches[0];
  const queued = await exportTask(db, identity, {
    kind: 'workspace',
    workspaceId: workspace.id,
    requestingUserId: actor.userId,
    exportType,
    request: normalized,
    idempotencyKey: idempotencyKey(request),
  });
  if (queued.created) {
    await audit(db, identity, 'notion_admin.workspace_export.enqueue', 'organization_admin_export_task', queued.task.id, {
      workspaceId: workspace.id,
      requestingUserId: actor.userId,
      exportType,
    });
    scheduleExportTask(context, db, queued.task, async () => {
      if (!operations.executeWorkspaceExport) {
        throw new Error('The canonical workspace export executor is unavailable.');
      }
      return operations.executeWorkspaceExport({
        organizationId: identity.organizationId,
        workspaceId: workspace.id,
        actorId: actor.userId,
        actorEmail: onBehalfOfUserEmail,
        request: normalized,
      });
    });
  }
  return {
    export_job_id: queued.task.id,
    status: queued.task.status ?? 'queued',
    task_id: queued.task.taskId,
  };
}

async function revokeManagedUserSession(
  context: NotionAdminFunctionContext,
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
) {
  requireNotionAdminCapability(identity, 'managed-user-session:write');
  const body = await requestBody(request);
  assertExactKeys(body, ['user']);
  if (!isRecord(body.user)) validation('user must be an object.');
  const user = body.user;
  let memberMatches: OrganizationMember[];
  const members = (await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', identity.organizationId),
  )).filter((member) =>
    member.organizationId === identity.organizationId && (member.status ?? 'active') === 'active');
  if (user.type === 'email') {
    assertExactKeys(user, ['type', 'email'], 'user');
    const email = normalizedEmail(user.email);
    memberMatches = members.filter((member) => member.email?.trim().toLowerCase() === email);
  } else if (user.type === 'id') {
    assertExactKeys(user, ['type', 'id'], 'user');
    const id = boundedString(user.id, 'user.id', 200);
    memberMatches = members.filter((member) => member.userId === id || member.id === id);
  } else {
    validation("user.type must be either 'email' or 'id'.");
  }
  if (memberMatches.length !== 1) {
    throw new NotionAdminApiError(404, 'not_found', 'The managed user was not found.');
  }
  const auth = context.admin.auth;
  if (!auth?.revokeAllSessions) {
    throw new NotionAdminApiError(500, 'internal_server_error', 'The session revocation service is unavailable.');
  }
  const member = memberMatches[0];
  await auth.revokeAllSessions(member.userId);
  await audit(db, identity, 'notion_admin.managed_user.session_revoke', 'organization_member', member.id, {
    userId: member.userId,
  });
  return { status: 'revoked' as const };
}

async function dispatch(
  context: NotionAdminFunctionContext,
  operations: NotionAdminCanonicalOperations,
  db: DbRef,
  identity: NotionAdminIdentity,
  request: Request,
) {
  const method = request.method.toUpperCase();
  const parts = pathParts(context, request);

  if (parts.length === 1 && parts[0] === 'legal_holds') {
    if (method === 'GET') return listLegalHolds(db, identity, request);
    if (method === 'POST') return createLegalHold(context, db, identity, request);
  }
  if (parts.length >= 2 && parts[0] === 'legal_holds') {
    const legalHoldId = uuid(parts[1], 'legal_hold_id');
    if (parts.length === 2) {
      if (method === 'GET') {
        requireNotionAdminCapability(identity, 'legal-hold:read');
        assertQueryKeys(request, []);
        return legalHoldResponse(db, await requireLegalHold(db, identity, legalHoldId), identity);
      }
      if (method === 'PATCH') {
        assertQueryKeys(request, []);
        return updateLegalHold(db, identity, request, legalHoldId);
      }
    }
    if (parts.length === 3 && parts[2] === 'users') {
      if (method === 'GET') return listLegalHoldUsers(db, identity, request, legalHoldId);
      if (method === 'POST') {
        assertQueryKeys(request, []);
        return addLegalHoldUsers(db, identity, request, legalHoldId);
      }
    }
    if (parts.length === 3 && parts[2] === 'workspaces' && method === 'GET') {
      return listLegalHoldWorkspaces(db, identity, request, legalHoldId);
    }
    if (parts.length === 3 && parts[2] === 'release' && method === 'POST') {
      assertQueryKeys(request, []);
      return releaseLegalHold(db, identity, legalHoldId);
    }
    if (parts.length === 3 && parts[2] === 'export' && method === 'POST') {
      assertQueryKeys(request, []);
      return exportLegalHold(context, operations, db, identity, request, legalHoldId);
    }
    if (parts.length === 4 && parts[2] === 'users' && method === 'DELETE') {
      assertQueryKeys(request, []);
      return removeLegalHoldUser(db, identity, legalHoldId, uuid(parts[3], 'user_id'));
    }
    if (
      parts.length === 5
      && parts[2] === 'spaces'
      && parts[4] === 'pages'
      && method === 'GET'
    ) {
      return listLegalHoldPages(
        context,
        db,
        identity,
        request,
        legalHoldId,
        uuid(parts[3], 'space_id'),
      );
    }
  }
  if (parts.length === 1 && parts[0] === 'exports' && method === 'POST') {
    assertQueryKeys(request, []);
    return enqueueWorkspaceExport(context, operations, db, identity, request);
  }
  if (
    parts.length === 2
    && parts[0] === 'managed_users'
    && parts[1] === 'revoke_session'
    && method === 'POST'
  ) {
    assertQueryKeys(request, []);
    return revokeManagedUserSession(context, db, identity, request);
  }
  throw new NotionAdminApiError(404, 'not_found', 'The Admin API endpoint was not found.');
}

export async function handleNotionAdminRequest(
  context: NotionAdminFunctionContext,
  operations: NotionAdminCanonicalOperations = {},
) {
  const request = context.request;
  if (!request) return notionAdminErrorResponse(new NotionAdminApiError(400, 'validation_error', 'Request context is missing.'));
  try {
    assertVersion(request);
    const db = context.admin.db('app');
    const identity = await authenticateNotionAdminToken(request, db);
    return apiJson(await dispatch(context, operations, db, identity, request));
  } catch (error) {
    return notionAdminErrorResponse(error);
  }
}
