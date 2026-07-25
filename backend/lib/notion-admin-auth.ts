import type { DbRef, OrganizationMember } from './app-types';
import { recordOrganizationAudit } from './org-audit';
import { getExisting, listAll, nowIso } from './table-utils';

export const NOTION_ADMIN_VERSION = '2026-06-01' as const;

export const NOTION_ADMIN_CAPABILITIES = [
  'legal-hold:read',
  'legal-hold:write',
  'legal-hold:write-high-impact',
  'legal-hold:export',
  'workspace:export',
  'managed-user-session:write',
] as const;

export type NotionAdminCapability = (typeof NOTION_ADMIN_CAPABILITIES)[number];
export type NotionAdminErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'missing_scope'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'internal_server_error';

const capabilitySet = new Set<string>(NOTION_ADMIN_CAPABILITIES);
const TOKEN_PREFIX = 'ntn_admin_';
const TOKEN_LOOKUP_PREFIX_LENGTH = 20;

interface Organization {
  id: string;
  ownerId?: string | null;
}

export interface OrganizationAdminToken {
  id: string;
  organizationId: string;
  label: string;
  status?: string | null;
  tokenPrefix?: string | null;
  tokenHash?: string | null;
  scopes?: unknown;
  createdBy?: string | null;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotionAdminResourceScope {
  organizationId: string;
  workspaceIds: string[];
  legalHoldIds: string[];
}

export interface StoredNotionAdminScopes {
  version: 1;
  capabilities: NotionAdminCapability[];
  resources: NotionAdminResourceScope;
}

export interface NotionAdminIdentity {
  organizationId: string;
  token: OrganizationAdminToken;
  scopes: StoredNotionAdminScopes;
}

export class NotionAdminApiError extends Error {
  readonly status: number;
  readonly code: NotionAdminErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: NotionAdminErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'NotionAdminApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new NotionAdminApiError(400, 'validation_error', `${label} is required.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new NotionAdminApiError(400, 'validation_error', `${label} is too long.`);
  }
  return text;
}

function resourceIds(value: unknown, label: string, fallback: string[]) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new NotionAdminApiError(
      400,
      'validation_error',
      `${label} must be a non-empty array with at most 1000 entries.`,
    );
  }
  const out = Array.from(new Set(value.map((entry) => boundedString(entry, label, 200))));
  if (out.includes('*') && out.length !== 1) {
    throw new NotionAdminApiError(400, 'validation_error', `${label} cannot mix '*' with resource ids.`);
  }
  return out;
}

function capabilitiesFrom(value: unknown): NotionAdminCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NotionAdminApiError(400, 'validation_error', 'At least one Admin API capability is required.');
  }
  const capabilities = Array.from(new Set(value.map((entry) => {
    if (typeof entry !== 'string' || !capabilitySet.has(entry)) {
      throw new NotionAdminApiError(400, 'validation_error', `Unsupported Admin API capability: ${String(entry)}.`);
    }
    return entry as NotionAdminCapability;
  })));
  return capabilities;
}

function parsedScopes(value: unknown, organizationId: string): StoredNotionAdminScopes | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.resources)) return null;
  let capabilities: NotionAdminCapability[];
  try {
    capabilities = capabilitiesFrom(value.capabilities);
  } catch {
    return null;
  }
  const resources = value.resources;
  if (resources.organizationId !== organizationId) return null;
  let workspaceIds: string[];
  let legalHoldIds: string[];
  try {
    workspaceIds = resourceIds(resources.workspaceIds, 'resources.workspaceIds', []);
    legalHoldIds = resourceIds(resources.legalHoldIds, 'resources.legalHoldIds', []);
  } catch {
    return null;
  }
  if (workspaceIds.length === 0 || legalHoldIds.length === 0) return null;
  return {
    version: 1,
    capabilities,
    resources: { organizationId, workspaceIds, legalHoldIds },
  };
}

async function requireOrganizationSecurityAdmin(db: DbRef, organizationId: string, actorId: string) {
  const organization = await getExisting(db.table<Organization>('organizations'), organizationId);
  if (!organization) {
    throw new NotionAdminApiError(404, 'not_found', 'The organization was not found.');
  }
  if (organization.ownerId === actorId) return;
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
  );
  const member = members.find((candidate) =>
    candidate.userId === actorId && (candidate.status ?? 'active') === 'active');
  if (member?.role !== 'owner' && member?.role !== 'security_admin') {
    throw new NotionAdminApiError(403, 'forbidden', 'Organization security admin access is required.');
  }
}

function randomTokenPart(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Hex(value: string) {
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

export function redactOrganizationAdminToken(token: OrganizationAdminToken) {
  const { tokenHash: _tokenHash, ...redacted } = token;
  return redacted;
}

export async function issueOrganizationAdminToken(
  db: DbRef,
  input: {
    organizationId: string;
    actorId: string;
    label: string;
    capabilities: unknown;
    workspaceIds?: unknown;
    legalHoldIds?: unknown;
    expiresAt?: string | null;
  },
) {
  const organizationId = boundedString(input.organizationId, 'organizationId', 200);
  const actorId = boundedString(input.actorId, 'actorId', 200);
  await requireOrganizationSecurityAdmin(db, organizationId, actorId);
  const capabilities = capabilitiesFrom(input.capabilities);
  const workspaceIds = resourceIds(input.workspaceIds, 'workspaceIds', ['*']);
  const legalHoldIds = resourceIds(input.legalHoldIds, 'legalHoldIds', ['*']);
  const expiresAt = input.expiresAt == null ? null : boundedString(input.expiresAt, 'expiresAt', 100);
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    throw new NotionAdminApiError(400, 'validation_error', 'expiresAt must be a future ISO 8601 timestamp.');
  }
  const secret = `${TOKEN_PREFIX}${randomTokenPart()}`;
  const now = nowIso();
  const token = await db.table<OrganizationAdminToken>('organization_admin_tokens').insert({
    organizationId,
    label: boundedString(input.label, 'label', 120),
    status: 'active',
    tokenPrefix: secret.slice(0, TOKEN_LOOKUP_PREFIX_LENGTH),
    tokenHash: await sha256Hex(secret),
    scopes: {
      version: 1,
      capabilities,
      resources: { organizationId, workspaceIds, legalHoldIds },
    } satisfies StoredNotionAdminScopes,
    createdBy: actorId,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'notion_admin.token.create',
    targetType: 'organization_admin_token',
    targetId: token.id,
    metadata: {
      label: token.label,
      tokenPrefix: token.tokenPrefix,
      capabilities,
      resources: { workspaceIds, legalHoldIds },
    },
    occurredAt: now,
  });
  return {
    token: redactOrganizationAdminToken(token),
    // The plaintext is deliberately returned only from this creation call.
    tokenSecret: secret,
  };
}

export async function listOrganizationAdminTokens(
  db: DbRef,
  organizationId: string,
  actorId: string,
) {
  await requireOrganizationSecurityAdmin(db, organizationId, actorId);
  const tokens = await listAll(
    db.table<OrganizationAdminToken>('organization_admin_tokens').where('organizationId', '==', organizationId),
  );
  return tokens
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.id.localeCompare(right.id))
    .map(redactOrganizationAdminToken);
}

export async function revokeOrganizationAdminToken(
  db: DbRef,
  input: { organizationId: string; actorId: string; tokenId: string },
) {
  await requireOrganizationSecurityAdmin(db, input.organizationId, input.actorId);
  const token = await getExisting(
    db.table<OrganizationAdminToken>('organization_admin_tokens'),
    input.tokenId,
  );
  if (!token || token.organizationId !== input.organizationId) {
    throw new NotionAdminApiError(404, 'not_found', 'The Admin API token was not found.');
  }
  if ((token.status ?? 'active') === 'revoked') return redactOrganizationAdminToken(token);
  const now = nowIso();
  const updated = await db.table<OrganizationAdminToken>('organization_admin_tokens').update(token.id, {
    status: 'revoked',
    revokedAt: now,
    revokedBy: input.actorId,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId: input.organizationId,
    workspaceId: null,
    actorId: input.actorId,
    action: 'notion_admin.token.revoke',
    targetType: 'organization_admin_token',
    targetId: token.id,
    metadata: { label: token.label, tokenPrefix: token.tokenPrefix },
    occurredAt: now,
  });
  return redactOrganizationAdminToken(updated);
}

export async function authenticateNotionAdminToken(request: Request, db: DbRef): Promise<NotionAdminIdentity> {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(ntn_admin_[A-Za-z0-9_-]{32,})$/.exec(authorization.trim());
  if (!match) {
    throw new NotionAdminApiError(401, 'unauthorized', 'A valid Admin API bearer token is required.');
  }
  const secret = match[1];
  const candidates = await listAll(
    db.table<OrganizationAdminToken>('organization_admin_tokens').where(
      'tokenPrefix',
      '==',
      secret.slice(0, TOKEN_LOOKUP_PREFIX_LENGTH),
    ),
  );
  const hash = await sha256Hex(secret);
  const token = candidates.find((candidate) =>
    (candidate.status ?? 'active') === 'active'
    && typeof candidate.tokenHash === 'string'
    && constantTimeEqual(candidate.tokenHash, hash));
  if (!token) {
    throw new NotionAdminApiError(401, 'unauthorized', 'The Admin API bearer token is invalid or revoked.');
  }
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
    throw new NotionAdminApiError(401, 'unauthorized', 'The Admin API bearer token has expired.');
  }
  const scopes = parsedScopes(token.scopes, token.organizationId);
  if (!scopes || !token.createdBy) {
    throw new NotionAdminApiError(401, 'unauthorized', 'The Admin API bearer token is not valid.');
  }
  await db.table<OrganizationAdminToken>('organization_admin_tokens').update(token.id, {
    lastUsedAt: nowIso(),
  });
  return { organizationId: token.organizationId, token, scopes };
}

export function requireNotionAdminCapability(
  identity: NotionAdminIdentity,
  capability: NotionAdminCapability,
) {
  if (!identity.scopes.capabilities.includes(capability)) {
    throw new NotionAdminApiError(403, 'missing_scope', `The token is missing the '${capability}' scope.`);
  }
}

function resourceAllowed(ids: readonly string[], id: string) {
  return ids.includes('*') || ids.includes(id);
}

export function notionAdminCanAccessWorkspace(identity: NotionAdminIdentity, workspaceId: string) {
  return resourceAllowed(identity.scopes.resources.workspaceIds, workspaceId);
}

export function notionAdminHasOrganizationWorkspaceAccess(identity: NotionAdminIdentity) {
  return identity.scopes.resources.workspaceIds.length === 1
    && identity.scopes.resources.workspaceIds[0] === '*';
}

export function notionAdminCanAccessLegalHold(identity: NotionAdminIdentity, legalHoldId: string) {
  return resourceAllowed(identity.scopes.resources.legalHoldIds, legalHoldId);
}

export function notionAdminCanCreateLegalHolds(identity: NotionAdminIdentity) {
  return identity.scopes.resources.legalHoldIds.length === 1
    && identity.scopes.resources.legalHoldIds[0] === '*';
}
