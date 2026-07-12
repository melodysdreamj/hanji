import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { hanjiHeader } from '../lib/hanji-compat';
import { assertNoActiveLegalHoldForPermanentDelete } from '../lib/enterprise-controls';
import { bumpOrganizationPolicyVersion } from '../lib/org-policy-version';
import {
  MAX_RAW_TRANSACT_OPS,
  WORKSPACE_CONTENT_TABLES,
  boundedDb,
  discoverPermissionWorkspaceIds,
  ensurePageWorkspaceIndex,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import { actorPagePermissions, pageAccessRole } from '../lib/page-access';
import { defaultWorkspaceLocale, seedDefaultWorkspacePages } from '../lib/default-workspace-pages';
import { deleteStoredUploadsBeforeMetadata } from '../lib/permanent-file-delete';
import { upsertNotification as upsertBoundedNotification } from '../lib/notifications';
import {
  markFileDeletionPending,
  withFileWorkspaceLease,
  type FileWorkspaceLeaseGuard,
} from '../lib/file-operation-lock';
import {
  getInstanceSettings,
  parseSignupPolicy,
  upsertInstanceSettings,
  type InstanceSettings,
} from '../lib/instance-settings';

import {
  bestEffort,
  listAll,
  requireString,
  getExisting,
  nowIso,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from '../lib/table-utils';
type NotificationKind = 'comment' | 'mention' | 'link' | 'page_edit' | 'system';
type WorkspaceMemberRole = 'owner' | 'admin' | 'member' | 'guest';
type OrganizationMemberRole = 'owner' | 'admin' | 'security_admin' | 'billing_admin' | 'member' | 'guest';
type WorkspaceCreationPolicy = 'owners_admins' | 'members';
type DomainSignupPolicy = 'invite_only' | 'verified_domains';
type SharingPolicyKey =
  | 'publicWebSharing'
  | 'externalEmailSharing'
  | 'guestAccess'
  | 'fileDownloads'
  | 'fullAccessGrants';
type MembershipNotificationAction = 'invite' | 'role_update';

interface Organization {
  id: string;
  name: string;
  icon?: string | null;
  ownerId?: string;
  workspaceCreationPolicy?: string;
  domainSignupPolicy?: string;
  sharingPolicy?: Record<string, unknown> | null;
  storageLimitBytes?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  role: string;
  status?: string;
  createdBy?: string;
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
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationGroupMember {
  id: string;
  organizationId: string;
  groupId: string;
  organizationMemberId: string;
  userId: string;
  role?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationGroupDirectoryMember {
  id: string;
  organizationMemberId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  role: string;
  status: string;
}

interface OrganizationGroupDirectory extends OrganizationGroup {
  members: OrganizationGroupDirectoryMember[];
}

interface OrganizationDomain {
  id: string;
  organizationId: string;
  domain: string;
  status?: string;
  createdBy?: string;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationAuditEvent {
  id: string;
  organizationId: string;
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

interface OrganizationEnterpriseControls {
  id: string;
  organizationId: string;
  ssoConfig?: Record<string, unknown> | null;
  scimConfig?: Record<string, unknown> | null;
  auditPolicy?: Record<string, unknown> | null;
  dataResidencyPolicy?: Record<string, unknown> | null;
  dlpPolicy?: Record<string, unknown> | null;
  legalPolicy?: Record<string, unknown> | null;
  billingProfile?: Record<string, unknown> | null;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationScimToken {
  id: string;
  organizationId: string;
  label: string;
  status?: string;
  tokenPrefix?: string | null;
  tokenHash?: string | null;
  scopes?: Record<string, unknown> | null;
  createdBy?: string | null;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationLegalHold {
  id: string;
  organizationId: string;
  name: string;
  status?: string;
  reason?: string | null;
  scope?: Record<string, unknown> | null;
  createdBy?: string | null;
  releasedAt?: string | null;
  releasedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationAuditExport {
  id: string;
  organizationId: string;
  status?: string;
  format?: string;
  filter?: Record<string, unknown> | null;
  eventCount?: number;
  content?: string | null;
  createdBy?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationBillingRecord {
  id: string;
  organizationId: string;
  kind?: string;
  status?: string;
  title: string;
  amountCents?: number | null;
  currency?: string | null;
  billingEmail?: string | null;
  contractOwnerEmail?: string | null;
  renewalAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  metadata?: Record<string, unknown> | null;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface Workspace {
  id: string;
  organizationId?: string | null;
  name: string;
  icon?: string | null;
  domain?: string | null;
  ownerId?: string;
  deletionPendingAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  role: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  displayName?: string | null;
  role: string;
  token: string;
  status?: string;
  emailDeliveryStatus?: string;
  emailMessageId?: string | null;
  emailDeliveredAt?: string | null;
  emailDeliveryError?: string | null;
  createdBy?: string;
  acceptedBy?: string;
  acceptedAt?: string;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Page {
  id: string;
  workspaceId: string;
  kind?: string;
  createdBy?: string | null;
  lastEditedBy?: string | null;
}

interface Block {
  id: string;
  pageId: string;
  createdBy?: string | null;
  updatedAt?: string;
}

interface Comment {
  id: string;
  pageId: string;
  authorId: string;
  updatedAt?: string;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket?: string | null;
  key?: string | null;
  status?: string | null;
  createdBy?: string | null;
  updatedAt?: string;
}

interface DbProperty {
  id: string;
  databaseId: string;
}

interface DbView {
  id: string;
  databaseId: string;
}

interface DbTemplate {
  id: string;
  databaseId: string;
}

interface ShareLink {
  id: string;
  pageId: string;
  workspaceId: string;
}

interface CollaborationOperation {
  id: string;
  pageId: string;
  workspaceId: string;
}

interface CollaborationDocument {
  id: string;
  pageId: string;
  workspaceId: string;
}

interface DbPropertyIndex {
  id: string;
  workspaceId: string;
}

interface FileMaintenanceRun {
  id: string;
  workspaceId: string;
}

interface NotionImportConnectionRecord {
  id: string;
  workspaceId: string;
}

interface NotionImportJobRecord {
  id: string;
  workspaceId: string;
}

interface NotionImportItemRecord {
  id: string;
  workspaceId: string;
  jobId: string;
}

interface NotionImportMappingRecord {
  id: string;
  workspaceId: string;
  jobId: string;
}

interface PagePermission {
  id: string;
  pageId: string;
  workspaceId: string;
  principalType: string;
  principalId?: string | null;
  label?: string | null;
}

interface OrganizationProfileWorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  workspaceDomain?: string | null;
  workspaceMemberId: string;
  role: string;
}

interface OrganizationProfilePendingInvitation {
  workspaceId: string;
  workspaceName: string;
  workspaceDomain?: string | null;
  invitationId: string;
  email: string;
  role: string;
  status: string;
}

interface OrganizationProfile {
  organizationMemberId?: string | null;
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  organizationRole: string;
  status: string;
  workspaceMemberships: OrganizationProfileWorkspaceMembership[];
  pendingInvitations: OrganizationProfilePendingInvitation[];
}

interface NotificationRecord {
  id: string;
  workspaceId: string;
  userId: string;
  activityKey: string;
  kind: NotificationKind;
  pageId?: string | null;
  blockId?: string | null;
  commentId?: string | null;
  actorId?: string | null;
  title?: string;
  preview?: string;
  target?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
  readAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

interface EmailSender {
  send(options: {
    to: string;
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ success: boolean; messageId?: string }>;
}

interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  delete(key: string): Promise<void>;
}

interface AuthAdminRef {
  listUsers(options?: { limit?: number; cursor?: string }): Promise<{
    users: Record<string, unknown>[];
    cursor?: string;
  }>;
}

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  email?: EmailSender;
  storage?: FunctionStorageProxy;
  admin: {
    db(namespace: string): DbRef;
    auth?: AuthAdminRef;
  };
}

// Resolve an email to an existing server account id via a bounded scan of the
// auth directory. Returns null when the address has no account (or the auth
// admin surface is unavailable), which the member-add path treats as a blind
// no-op. Runs server-side only; the address is never echoed back to the caller,
// so this cannot be used to enumerate accounts.
async function resolveServerUserIdByEmail(
  authAdmin: AuthAdminRef | undefined,
  email: string,
): Promise<string | null> {
  if (!authAdmin?.listUsers) return null;
  const target = normalizeEmail(email);
  if (!target) return null;
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    let result: { users: Record<string, unknown>[]; cursor?: string };
    try {
      result = await authAdmin.listUsers({ limit: 200, cursor });
    } catch {
      return null;
    }
    const users = result.users ?? [];
    const match = users.find((user) => normalizeEmail(user.email) === target);
    if (match) {
      const id =
        typeof match.id === 'string' && match.id.trim()
          ? match.id.trim()
          : typeof match.userId === 'string' && match.userId.trim()
            ? match.userId.trim()
            : null;
      if (id) return id;
    }
    if (!result.cursor || users.length === 0) return null;
    cursor = result.cursor;
  }
  return null;
}

const patchKeys = new Set<keyof Workspace>(['name', 'icon', 'domain']);
const manageableRoles = new Set<WorkspaceMemberRole>(['admin', 'member', 'guest']);
const roleRank: Record<WorkspaceMemberRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  guest: 1,
};
const organizationRoleRank: Record<OrganizationMemberRole, number> = {
  owner: 5,
  admin: 4,
  security_admin: 3,
  billing_admin: 3,
  member: 2,
  guest: 1,
};
const organizationAdminRoles = new Set<OrganizationMemberRole>([
  'owner',
  'admin',
  'security_admin',
  'billing_admin',
]);
const organizationPeopleAdminRoles = new Set<OrganizationMemberRole>(['owner', 'admin']);

function decodedStoragePath(pathname: string) {
  try {
    const segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    return segments[0] === 'api' && segments[1] === 'storage' && segments.length > 3;
  } catch {
    return false;
  }
}

function isLocalMetadataFileLocator(value: string, request?: Request) {
  const raw = value.trim();
  if (!raw) return false;
  if (raw.startsWith('workspaces/')) return true;
  if (raw.startsWith('//')) {
    try {
      return decodedStoragePath(new URL(`https:${raw}`).pathname);
    } catch {
      return false;
    }
  }
  if (raw.startsWith('/')) {
    try {
      return decodedStoragePath(new URL(raw, 'https://hanji.invalid').pathname);
    } catch {
      return false;
    }
  }
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (!decodedStoragePath(parsed.pathname)) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return true;
    return request ? parsed.origin === new URL(request.url).origin : false;
  } catch {
    return false;
  }
}

function assertMetadataDoesNotAttachStoredFile(
  value: string | null | undefined,
  field: 'avatar' | 'icon',
  request?: Request,
) {
  if (value && isLocalMetadataFileLocator(value, request)) {
    throw Object.assign(
      new Error(
        `Stored file references are not allowed in workspace ${field}; use an emoji or external HTTPS image.`,
      ),
      { status: 400 },
    );
  }
}
const organizationSecurityAdminRoles = new Set<OrganizationMemberRole>(['owner', 'security_admin']);
const organizationBillingAdminRoles = new Set<OrganizationMemberRole>(['owner', 'billing_admin']);
const workspaceCreationPolicyLabels: Record<WorkspaceCreationPolicy, string> = {
  owners_admins: 'owners and admins',
  members: 'members',
};
const domainSignupPolicyLabels: Record<DomainSignupPolicy, string> = {
  invite_only: 'invited users',
  verified_domains: 'verified domains',
};
const sharingPolicyKeys: SharingPolicyKey[] = [
  'publicWebSharing',
  'externalEmailSharing',
  'guestAccess',
  'fileDownloads',
  'fullAccessGrants',
];

function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request) return {};
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function newToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

function optionalString(value: unknown, name: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null.`);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toLowerCase();
}

function normalizeWorkspaceSlug(value: unknown) {
  if (typeof value !== 'string') return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || null;
}

function normalizeOrganizationDomain(value: unknown) {
  if (typeof value !== 'string') return null;
  let domain = value.trim().toLowerCase();
  if (!domain) return null;
  if (domain.includes('@')) domain = domain.split('@').pop() ?? '';
  domain = domain
    .replace(/^https?:\/\//, '')
    .replace(/^@+/, '')
    .split(/[/?#]/)[0]
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.+/g, '.');
  if (!/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(domain)) return null;
  if (domain.split('.').some((part) => part.startsWith('-') || part.endsWith('-'))) return null;
  return domain;
}

function requireOrganizationDomain(value: unknown) {
  const domain = normalizeOrganizationDomain(value);
  if (!domain) throw new Error('Organization domain is invalid.');
  return domain;
}

function parseMemberRole(value: unknown, fallback: WorkspaceMemberRole = 'member'): WorkspaceMemberRole {
  if (typeof value !== 'string') return fallback;
  const role = value.trim().toLowerCase();
  if (role === 'owner' || role === 'admin' || role === 'member' || role === 'guest') return role;
  throw new Error('Workspace member role is invalid.');
}

function parseOrganizationRole(
  value: unknown,
  fallback: OrganizationMemberRole = 'member',
): OrganizationMemberRole {
  if (typeof value !== 'string') return fallback;
  const role = value.trim().toLowerCase();
  if (
    role === 'owner' ||
    role === 'admin' ||
    role === 'security_admin' ||
    role === 'billing_admin' ||
    role === 'member' ||
    role === 'guest'
  ) return role;
  throw new Error('Organization member role is invalid.');
}

function parseWorkspaceCreationPolicy(
  value: unknown,
  fallback: WorkspaceCreationPolicy = 'owners_admins',
): WorkspaceCreationPolicy {
  if (typeof value !== 'string') return fallback;
  const policy = value.trim().toLowerCase();
  if (policy === 'owners_admins' || policy === 'members') return policy;
  throw new Error('Workspace creation policy is invalid.');
}

function parseDomainSignupPolicy(
  value: unknown,
  fallback: DomainSignupPolicy = 'invite_only',
): DomainSignupPolicy {
  if (typeof value !== 'string') return fallback;
  const policy = value.trim().toLowerCase();
  if (policy === 'invite_only' || policy === 'verified_domains') return policy;
  throw new Error('Domain signup policy is invalid.');
}

function parseOptionalBoolean(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${name} must be a boolean.`);
}

function parseOptionalStorageLimitBytes(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('storageLimitBytes must be a non-negative number or null.');
  }
  const bytes = Math.floor(value);
  return bytes > 0 ? bytes : null;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalNumber(value: unknown, name: string) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number.`);
  }
  return value;
}

function optionalIntegerInRange(value: unknown, name: string, min: number, max: number) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function optionalIsoDateString(value: unknown, name: string) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${name} must be an ISO date string or null.`);
  const trimmed = value.trim();
  const time = Date.parse(trimmed);
  if (!Number.isFinite(time)) throw new Error(`${name} must be an ISO date string or null.`);
  return new Date(time).toISOString();
}

function boundedText(value: unknown, name: string, max = 300) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null.`);
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function stringList(value: unknown, name: string, maxItems = 50, maxLength = 120) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be a string array.`);
  return Array.from(new Set(value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${name} must be a string array.`);
    return item.trim().slice(0, maxLength);
  }).filter(Boolean))).slice(0, maxItems);
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') throw new Error(`${name} is invalid.`);
  const normalized = value.trim().toLowerCase();
  if (allowed.includes(normalized as T)) return normalized as T;
  throw new Error(`${name} is invalid.`);
}

function stripNullish(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function sanitizeSsoConfig(value: unknown) {
  const input = optionalRecord(value, 'ssoConfig');
  return stripNullish({
    enabled: optionalBoolean(input.enabled),
    providerType: parseEnum(input.providerType, ['saml', 'oidc'], 'saml', 'ssoConfig.providerType'),
    enforcement: parseEnum(
      input.enforcement,
      ['optional', 'required_for_verified_domains', 'required_for_all_members'],
      'optional',
      'ssoConfig.enforcement',
    ),
    loginUrl: boundedText(input.loginUrl, 'ssoConfig.loginUrl', 500),
    entityId: boundedText(input.entityId, 'ssoConfig.entityId', 500),
    issuer: boundedText(input.issuer, 'ssoConfig.issuer', 500),
    metadataUrl: boundedText(input.metadataUrl, 'ssoConfig.metadataUrl', 500),
    certificateFingerprint: boundedText(input.certificateFingerprint, 'ssoConfig.certificateFingerprint', 200),
    clientId: boundedText(input.clientId, 'ssoConfig.clientId', 300),
    jwksUrl: boundedText(input.jwksUrl, 'ssoConfig.jwksUrl', 500),
    scopes: stringList(input.scopes, 'ssoConfig.scopes', 20, 80),
    attributeMapping: optionalRecord(input.attributeMapping, 'ssoConfig.attributeMapping'),
  });
}

function sanitizeScimConfig(value: unknown) {
  const input = optionalRecord(value, 'scimConfig');
  return stripNullish({
    enabled: optionalBoolean(input.enabled),
    provisioningMode: parseEnum(
      input.provisioningMode,
      ['manual', 'scim_v2'],
      'manual',
      'scimConfig.provisioningMode',
    ),
    requireVerifiedDomain: optionalBoolean(input.requireVerifiedDomain, true),
    deprovisionAction: parseEnum(
      input.deprovisionAction,
      ['deactivate', 'remove'],
      'deactivate',
      'scimConfig.deprovisionAction',
    ),
    attributeMapping: optionalRecord(input.attributeMapping, 'scimConfig.attributeMapping'),
  });
}

function sanitizeAuditPolicy(value: unknown) {
  const input = optionalRecord(value, 'auditPolicy');
  return stripNullish({
    retentionDays: optionalIntegerInRange(input.retentionDays, 'auditPolicy.retentionDays', 30, 3650),
    exportFormat: parseEnum(input.exportFormat, ['jsonl', 'csv', 'json'], 'jsonl', 'auditPolicy.exportFormat'),
  });
}

function sanitizeDataResidencyPolicy(value: unknown) {
  const input = optionalRecord(value, 'dataResidencyPolicy');
  return stripNullish({
    primaryRegion: parseEnum(
      input.primaryRegion,
      ['global', 'us', 'eu', 'kr', 'apac'],
      'global',
      'dataResidencyPolicy.primaryRegion',
    ),
    allowedRegions: stringList(input.allowedRegions, 'dataResidencyPolicy.allowedRegions', 10, 40),
    enforcementMode: parseEnum(
      input.enforcementMode,
      ['metadata_only', 'strict'],
      'metadata_only',
      'dataResidencyPolicy.enforcementMode',
    ),
    notes: boundedText(input.notes, 'dataResidencyPolicy.notes', 500),
  });
}

function sanitizeDlpPolicy(value: unknown) {
  const input = optionalRecord(value, 'dlpPolicy');
  return stripNullish({
    enabled: optionalBoolean(input.enabled),
    blockPublicSharing: optionalBoolean(input.blockPublicSharing),
    blockExternalSharing: optionalBoolean(input.blockExternalSharing),
    blockFileDownloads: optionalBoolean(input.blockFileDownloads),
    blockExports: optionalBoolean(input.blockExports),
    sensitiveTerms: stringList(input.sensitiveTerms, 'dlpPolicy.sensitiveTerms', 100, 120),
  });
}

function sanitizeLegalPolicy(value: unknown) {
  const input = optionalRecord(value, 'legalPolicy');
  return stripNullish({
    defaultHoldScope: parseEnum(
      input.defaultHoldScope,
      ['organization', 'workspace', 'custodian'],
      'organization',
      'legalPolicy.defaultHoldScope',
    ),
    requireReason: optionalBoolean(input.requireReason, true),
  });
}

function sanitizeBillingProfile(value: unknown) {
  const input = optionalRecord(value, 'billingProfile');
  return stripNullish({
    planName: boundedText(input.planName, 'billingProfile.planName', 120),
    contractStatus: parseEnum(
      input.contractStatus,
      ['draft', 'active', 'renewal_due', 'cancelled'],
      'draft',
      'billingProfile.contractStatus',
    ),
    billingEmail: normalizeEmail(input.billingEmail),
    contractOwnerEmail: normalizeEmail(input.contractOwnerEmail),
    renewalAt: optionalIsoDateString(input.renewalAt, 'billingProfile.renewalAt'),
    poNumber: boundedText(input.poNumber, 'billingProfile.poNumber', 120),
    notes: boundedText(input.notes, 'billingProfile.notes', 500),
  });
}

function assertOrganizationRoleAllowed(
  actorRole: OrganizationMemberRole,
  allowedRoles: Set<OrganizationMemberRole>,
  message: string,
) {
  if (!allowedRoles.has(actorRole)) throw new Error(message);
}

function assertOrganizationPeopleAdmin(actorRole: OrganizationMemberRole) {
  assertOrganizationRoleAllowed(actorRole, organizationPeopleAdminRoles, 'Organization people admin access required.');
}

function assertOrganizationSecurityAdmin(actorRole: OrganizationMemberRole) {
  assertOrganizationRoleAllowed(actorRole, organizationSecurityAdminRoles, 'Organization security admin access required.');
}

function assertOrganizationBillingAdmin(actorRole: OrganizationMemberRole) {
  assertOrganizationRoleAllowed(actorRole, organizationBillingAdminRoles, 'Organization billing admin access required.');
}

function organizationRoleForWorkspaceMember(
  _workspace: Workspace,
  member: WorkspaceMember,
): OrganizationMemberRole {
  return parseMemberRole(member.role, 'member') === 'guest' ? 'guest' : 'member';
}

function organizationActorRole(
  organization: Organization,
  currentOrganizationMember: OrganizationMember | null | undefined,
  actorId: string,
): OrganizationMemberRole {
  return organization.ownerId === actorId
    ? 'owner'
    : parseOrganizationRole(currentOrganizationMember?.role, 'member');
}

function uniqueById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

async function listByIds<T>(tableRef: TableRef<T>, field: string, ids: string[]): Promise<T[]> {
  const CONCURRENT = 20;
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += CONCURRENT) {
    const chunk = ids.slice(i, i + CONCURRENT);
    out.push(...(await Promise.all(chunk.map((id) => listAll(tableRef.where(field, '==', id))))));
  }
  return out.flat();
}

function cleanPatch(patch: Record<string, unknown>, request?: Request): Partial<Workspace> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!patchKeys.has(key as keyof Workspace) || value === undefined) continue;
    if (key === 'name') {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name) throw new Error('Workspace name is required.');
      out.name = name;
      continue;
    }
    if (key === 'icon') {
      if (value === null || value === '') out.icon = null;
      else if (typeof value === 'string') {
        assertMetadataDoesNotAttachStoredFile(value, 'icon', request);
        out.icon = value;
      }
      continue;
    }
    if (key === 'domain') {
      if (value === null || value === '') out.domain = null;
      else if (typeof value === 'string') out.domain = normalizeWorkspaceSlug(value);
    }
  }
  return out as Partial<Workspace>;
}

function roleLabel(role: string | undefined) {
  const clean = parseMemberRole(role, 'member');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function sortMembers(items: WorkspaceMember[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        roleRank[parseMemberRole(b.role, 'member')] - roleRank[parseMemberRole(a.role, 'member')] ||
        String(a.displayName ?? a.email ?? a.userId).localeCompare(
          String(b.displayName ?? b.email ?? b.userId),
        ) ||
        a.id.localeCompare(b.id),
    );
}

function invitationIsPending(invitation: WorkspaceInvitation, now = Date.now()) {
  const status = invitation.status ?? 'pending';
  if (status !== 'pending') return false;
  if (!invitation.expiresAt) return true;
  const expiresAt = Date.parse(invitation.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function sortInvitations(items: WorkspaceInvitation[]) {
  return items
    .filter((invitation) => invitationIsPending(invitation))
    .slice()
    .sort(
      (a, b) =>
        String(a.email).localeCompare(String(b.email)) ||
        a.id.localeCompare(b.id),
    );
}

function urlOrigin(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function sortWorkspaces(items: Workspace[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizations(items: Organization[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationMembers(items: OrganizationMember[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.status ?? 'active').localeCompare(String(b.status ?? 'active')) ||
        organizationRoleRank[parseOrganizationRole(b.role, 'member')] -
          organizationRoleRank[parseOrganizationRole(a.role, 'member')] ||
        String(a.displayName ?? a.email ?? a.userId).localeCompare(
          String(b.displayName ?? b.email ?? b.userId),
        ) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationGroups(items: OrganizationGroupDirectory[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationGroupMembers(items: OrganizationGroupDirectoryMember[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.status ?? 'active').localeCompare(String(b.status ?? 'active')) ||
        String(a.displayName ?? a.email ?? a.userId).localeCompare(
          String(b.displayName ?? b.email ?? b.userId),
        ) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationDomains(items: OrganizationDomain[]) {
  const statusRank: Record<string, number> = { verified: 0, pending: 1, rejected: 2 };
  return items
    .slice()
    .sort(
      (a, b) =>
        (statusRank[a.status ?? 'pending'] ?? 9) - (statusRank[b.status ?? 'pending'] ?? 9) ||
        String(a.domain ?? '').localeCompare(String(b.domain ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationAuditEvents(items: OrganizationAuditEvent[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(b.occurredAt ?? '').localeCompare(String(a.occurredAt ?? '')) ||
        b.id.localeCompare(a.id),
    );
}

function sortOrganizationScimTokens(items: OrganizationScimToken[]) {
  const statusRank: Record<string, number> = { active: 0, revoked: 1, expired: 2 };
  return items
    .slice()
    .sort(
      (a, b) =>
        (statusRank[a.status ?? 'active'] ?? 9) - (statusRank[b.status ?? 'active'] ?? 9) ||
        String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationLegalHolds(items: OrganizationLegalHold[]) {
  const statusRank: Record<string, number> = { active: 0, released: 1 };
  return items
    .slice()
    .sort(
      (a, b) =>
        (statusRank[a.status ?? 'active'] ?? 9) - (statusRank[b.status ?? 'active'] ?? 9) ||
        String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

function sortOrganizationAuditExports(items: OrganizationAuditExport[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(b.completedAt ?? b.createdAt ?? '').localeCompare(String(a.completedAt ?? a.createdAt ?? '')) ||
        b.id.localeCompare(a.id),
    );
}

function sortOrganizationBillingRecords(items: OrganizationBillingRecord[]) {
  return items
    .slice()
    .sort(
      (a, b) =>
        String(a.renewalAt ?? '').localeCompare(String(b.renewalAt ?? '')) ||
        String(a.title ?? '').localeCompare(String(b.title ?? '')) ||
        a.id.localeCompare(b.id),
    );
}

function organizationProfileSortKey(profile: OrganizationProfile) {
  return String(profile.displayName ?? profile.email ?? profile.userId ?? '').toLowerCase();
}

function sortOrganizationProfiles(items: OrganizationProfile[]) {
  const statusRank: Record<string, number> = { active: 0, invited: 1, deactivated: 2 };
  return items
    .slice()
    .sort(
      (a, b) =>
        (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
        organizationRoleRank[parseOrganizationRole(b.organizationRole, 'member')] -
          organizationRoleRank[parseOrganizationRole(a.organizationRole, 'member')] ||
        organizationProfileSortKey(a).localeCompare(organizationProfileSortKey(b)) ||
        String(a.userId ?? a.email ?? '').localeCompare(String(b.userId ?? b.email ?? '')),
    );
}

async function organizationGroupsForDirectory(
  db: DbRef,
  organizationId: string,
  organizationMembers: OrganizationMember[],
) {
  const groups = await listAll(
    db.table<OrganizationGroup>('organization_groups').where('organizationId', '==', organizationId),
  );
  const groupMembers = await listAll(
    db.table<OrganizationGroupMember>('organization_group_members').where('organizationId', '==', organizationId),
  );
  const membersById = new Map(organizationMembers.map((member) => [member.id, member]));
  return sortOrganizationGroups(
    groups.map((group) => ({
      ...group,
      members: sortOrganizationGroupMembers(
        groupMembers
          .filter((membership) => membership.groupId === group.id)
          .map((membership) => {
            const member = membersById.get(membership.organizationMemberId);
            return {
              id: membership.id,
              organizationMemberId: membership.organizationMemberId,
              userId: membership.userId,
              displayName: member?.displayName ?? null,
              email: normalizeEmail(member?.email),
              role: parseOrganizationRole(member?.role ?? membership.role, 'member'),
              status: member?.status ?? 'active',
            };
          }),
      ),
    })),
  );
}

async function organizationProfilesForDirectory(
  db: DbRef,
  organizationMembers: OrganizationMember[],
  workspaces: Workspace[],
) {
  const profilesByUserId = new Map<string, OrganizationProfile>();
  const profilesByEmail = new Map<string, OrganizationProfile>();
  const profilesBySyntheticKey = new Map<string, OrganizationProfile>();

  const rememberProfile = (profile: OrganizationProfile) => {
    if (profile.userId) profilesByUserId.set(profile.userId, profile);
    const email = normalizeEmail(profile.email);
    if (email) profilesByEmail.set(email, profile);
    return profile;
  };

  for (const member of organizationMembers) {
    rememberProfile({
      organizationMemberId: member.id,
      userId: member.userId,
      displayName: member.displayName ?? null,
      email: normalizeEmail(member.email),
      avatar: member.avatar ?? null,
      organizationRole: parseOrganizationRole(member.role, 'member'),
      status: member.status ?? 'active',
      workspaceMemberships: [],
      pendingInvitations: [],
    });
  }

  const workspaceMembersTable = db.table<WorkspaceMember>('workspace_members');
  const invitationsTable = db.table<WorkspaceInvitation>('workspace_invitations');
  for (const workspace of workspaces) {
    const workspaceMembers = await listAll(workspaceMembersTable.where('workspaceId', '==', workspace.id));
    for (const member of workspaceMembers) {
      const email = normalizeEmail(member.email);
      const syntheticKey = member.userId ? `user:${member.userId}` : `email:${email ?? member.id}`;
      let profile =
        profilesByUserId.get(member.userId) ??
        (email ? profilesByEmail.get(email) : undefined) ??
        profilesBySyntheticKey.get(syntheticKey);
      if (!profile) {
        profile = rememberProfile({
          organizationMemberId: null,
          userId: member.userId,
          displayName: member.displayName ?? null,
          email,
          avatar: member.avatar ?? null,
          organizationRole: organizationRoleForWorkspaceMember(workspace, member),
          status: 'active',
          workspaceMemberships: [],
          pendingInvitations: [],
        });
        profilesBySyntheticKey.set(syntheticKey, profile);
      }
      if (!profile.displayName && member.displayName) profile.displayName = member.displayName;
      if (!profile.avatar && member.avatar) profile.avatar = member.avatar;
      if (!profile.email && email) {
        profile.email = email;
        profilesByEmail.set(email, profile);
      }
      profile.workspaceMemberships.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceDomain: workspace.domain ?? null,
        workspaceMemberId: member.id,
        role: parseMemberRole(member.role, 'member'),
      });
    }

    const invitations = await listAll(invitationsTable.where('workspaceId', '==', workspace.id));
    for (const invitation of invitations.filter((item) => invitationIsPending(item))) {
      const email = normalizeEmail(invitation.email);
      if (!email) continue;
      const syntheticKey = `invite:${workspace.id}:${email}`;
      let profile = profilesByEmail.get(email) ?? profilesBySyntheticKey.get(syntheticKey);
      if (!profile) {
        profile = rememberProfile({
          organizationMemberId: null,
          userId: null,
          displayName: invitation.displayName ?? null,
          email,
          avatar: null,
          organizationRole: parseMemberRole(invitation.role, 'guest') === 'guest' ? 'guest' : 'member',
          status: 'invited',
          workspaceMemberships: [],
          pendingInvitations: [],
        });
        profilesBySyntheticKey.set(syntheticKey, profile);
      }
      if (!profile.displayName && invitation.displayName) profile.displayName = invitation.displayName;
      profile.pendingInvitations.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceDomain: workspace.domain ?? null,
        invitationId: invitation.id,
        email,
        role: parseMemberRole(invitation.role, 'member'),
        status: invitation.status ?? 'pending',
      });
    }
  }

  const uniqueProfiles = new Set<OrganizationProfile>([
    ...profilesByUserId.values(),
    ...profilesByEmail.values(),
    ...profilesBySyntheticKey.values(),
  ]);

  for (const profile of uniqueProfiles) {
    profile.workspaceMemberships = profile.workspaceMemberships.sort(
      (a, b) =>
        roleRank[parseMemberRole(b.role, 'member')] - roleRank[parseMemberRole(a.role, 'member')] ||
        a.workspaceName.localeCompare(b.workspaceName) ||
        a.workspaceId.localeCompare(b.workspaceId),
    );
    profile.pendingInvitations = profile.pendingInvitations.sort(
      (a, b) =>
        a.workspaceName.localeCompare(b.workspaceName) ||
        a.invitationId.localeCompare(b.invitationId),
    );
  }
  return sortOrganizationProfiles(Array.from(uniqueProfiles));
}

function parseAuditLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function optionalAuditFilter(value: unknown, name: string) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function optionalClientAuditString(value: unknown, name: string, max = 160) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length ? trimmed.slice(0, max) : undefined;
}

function clientSourceFromRequest(request?: Request) {
  const source = hanjiHeader(request?.headers, 'X-Hanji-Client-Source')?.trim().toLowerCase();
  return source === 'mcp' ? 'mcp' : undefined;
}

function parseMcpClientMetadata(body: Record<string, unknown>, request?: Request) {
  const client = body.client && typeof body.client === 'object'
    ? body.client as Record<string, unknown>
    : {};
  const source = clientSourceFromRequest(request) ?? optionalClientAuditString(client.source, 'client.source', 40);
  if (source !== 'mcp') throw new Error('MCP client audit requires MCP client headers.');
  const readOnly = hanjiHeader(request?.headers, 'X-Hanji-MCP-Read-Only') === 'true' || client.readOnly === true;
  return {
    source,
    clientId:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Client-ID'), 'clientId') ??
      optionalClientAuditString(client.clientId, 'client.clientId'),
    clientName:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Client-Name'), 'clientName') ??
      optionalClientAuditString(client.clientName, 'client.clientName'),
    readOnly,
    subjectType:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Subject-Type'), 'subjectType', 80) ??
      optionalClientAuditString(client.subjectType, 'client.subjectType', 80),
    subjectId:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Subject-ID'), 'subjectId') ??
      optionalClientAuditString(client.subjectId, 'client.subjectId'),
    policyIssuer:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Policy-Issuer'), 'policyIssuer') ??
      optionalClientAuditString(client.issuer, 'client.issuer'),
    policyAudience:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Policy-Audience'), 'policyAudience') ??
      optionalClientAuditString(client.audience, 'client.audience'),
    transport:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Transport'), 'transport', 80) ??
      optionalClientAuditString(client.transport, 'client.transport', 80),
    provisioningId:
      optionalClientAuditString(hanjiHeader(request?.headers, 'X-Hanji-MCP-Provisioning-ID'), 'provisioningId') ??
      optionalClientAuditString(client.provisioningId, 'client.provisioningId'),
  };
}

function parsePeopleSearchLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function organizationProfileMatchesQuery(profile: OrganizationProfile, query: string) {
  if (!query) return true;
  const haystack = [
    profile.displayName,
    profile.email,
    profile.userId,
    profile.organizationMemberId,
    profile.organizationRole,
    profile.status,
    ...(profile.workspaceMemberships ?? []).flatMap((membership) => [
      membership.workspaceName,
      membership.workspaceDomain,
      membership.role,
    ]),
    ...(profile.pendingInvitations ?? []).flatMap((invitation) => [
      invitation.email,
      invitation.workspaceName,
      invitation.workspaceDomain,
      invitation.role,
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function organizationNameFor(authEmail: string | null) {
  if (!authEmail) return 'Personal Organization';
  const local = authEmail.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  if (!local) return 'Personal Organization';
  return `${local.charAt(0).toUpperCase()}${local.slice(1)} Organization`;
}

async function recordOrganizationAudit(
  db: DbRef,
  event: Omit<OrganizationAuditEvent, 'id'>,
) {
  await bestEffort('workspace-mutation db.table<OrganizationAuditEven', db.table<OrganizationAuditEvent>('organization_audit_events').insert(event));
}

async function recordWorkspaceAudit(
  db: DbRef,
  workspace: Workspace,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown>,
  occurredAt = nowIso(),
) {
  if (!workspace.organizationId) return;
  await recordOrganizationAudit(db, {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    actorId,
    action,
    targetType,
    targetId,
    metadata,
    occurredAt,
  });
}

async function listAccessibleOrganizations(db: DbRef, actorId: string) {
  const organizations = db.table<Organization>('organizations');
  const members = db.table<OrganizationMember>('organization_members');
  const owned = await listAll(organizations.where('ownerId', '==', actorId));
  const memberships = await listAll(members.where('userId', '==', actorId));
  const byId = new Map<string, Organization>();
  for (const organization of owned) byId.set(organization.id, organization);
  for (const membership of memberships) {
    if ((membership.status ?? 'active') !== 'active') continue;
    const organization = await getExisting(organizations, membership.organizationId);
    if (organization) byId.set(organization.id, organization);
  }
  return sortOrganizations(Array.from(byId.values()));
}

async function ensureOrganizationMember(
  db: DbRef,
  organization: Organization,
  actorId: string,
  authEmail: string | null,
  role: OrganizationMemberRole = 'owner',
) {
  const members = db.table<OrganizationMember>('organization_members');
  const existing = (await listAll(members.where('organizationId', '==', organization.id))).find(
    (member) => member.userId === actorId,
  );
  const patch: Partial<OrganizationMember> = {
    email: authEmail,
    status: existing?.status ?? 'active',
  };
  if (existing) {
    if (
      normalizeEmail(existing.email) !== authEmail ||
      (existing.status ?? 'active') !== 'active'
    ) {
      return members.update(existing.id, patch);
    }
    return existing;
  }
  return members.insert({
    organizationId: organization.id,
    userId: actorId,
    role,
    email: authEmail,
    status: 'active',
    createdBy: actorId,
  });
}

async function upsertOrganizationMemberForWorkspaceMember(
  db: DbRef,
  workspace: Workspace,
  member: WorkspaceMember,
  actorId: string,
) {
  if (!workspace.organizationId || !member.userId) return null;
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    workspace.organizationId,
  );
  if (!organization) return null;
  const members = db.table<OrganizationMember>('organization_members');
  const organizationMembers = await listAll(members.where('organizationId', '==', workspace.organizationId));
  const existing = organizationMembers.find((item) => item.userId === member.userId) ?? null;
  const candidateRole = organizationRoleForWorkspaceMember(workspace, member);
  if (existing && (existing.status ?? 'active') === 'deactivated') {
    throw new Error('Organization membership is deactivated.');
  }
  const role = existing
    ? organizationRoleRank[parseOrganizationRole(existing.role, 'member')] >=
        organizationRoleRank[candidateRole]
      ? parseOrganizationRole(existing.role, 'member')
      : candidateRole
    : candidateRole;
  const email = normalizeEmail(member.email) ?? normalizeEmail(existing?.email);
  await assertOrganizationDomainSignupAllowed(db, organization, email, role);
  const patch: Partial<OrganizationMember> = {
    displayName: member.displayName ?? existing?.displayName ?? null,
    email,
    avatar: member.avatar ?? existing?.avatar ?? null,
    role,
    status: 'active',
  };
  return existing
    ? members.update(existing.id, patch)
    : members.insert({
        organizationId: workspace.organizationId,
        userId: member.userId,
        createdBy: actorId,
        ...patch,
    });
}

async function assertOrganizationMemberCanJoinWorkspace(
  db: DbRef,
  workspace: Workspace,
  userId: string,
) {
  if (!workspace.organizationId || !userId) return;
  const organizationMembers = await listAll(
    db.table<OrganizationMember>('organization_members').where(
      'organizationId',
      '==',
      workspace.organizationId,
    ),
  );
  const existing = organizationMembers.find((member) => member.userId === userId) ?? null;
  if (existing && (existing.status ?? 'active') === 'deactivated') {
    throw new Error('Organization membership is deactivated.');
  }
}

function sharingPolicyAllows(
  organization: Organization,
  key: string,
  fallback: boolean,
) {
  const value = organization.sharingPolicy?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

async function verifiedOrganizationDomainsForWorkspace(
  db: DbRef,
  workspace: Workspace,
) {
  if (!workspace.organizationId) return [];
  return verifiedOrganizationDomainsForOrganization(db, workspace.organizationId);
}

async function verifiedOrganizationDomainsForOrganization(
  db: DbRef,
  organizationId: string,
) {
  const domains = await listAll(
    db.table<OrganizationDomain>('organization_domains').where(
      'organizationId',
      '==',
      organizationId,
    ),
  );
  return domains.filter((domain) => (domain.status ?? 'pending') === 'verified');
}

function emailMatchesVerifiedOrganizationDomain(
  email: string | null,
  domains: OrganizationDomain[],
) {
  if (!email) return false;
  const emailDomain = normalizeOrganizationDomain(email);
  if (!emailDomain) return false;
  return domains.some((domain) => domain.domain === emailDomain);
}

async function assertOrganizationDomainSignupAllowed(
  db: DbRef,
  organization: Organization,
  email: string | null,
  role: OrganizationMemberRole,
) {
  const policy = parseDomainSignupPolicy(organization.domainSignupPolicy, 'invite_only');
  if (policy !== 'verified_domains') return;
  if (role === 'owner' || role === 'guest') return;

  const verifiedDomains = await verifiedOrganizationDomainsForOrganization(db, organization.id);
  if (!verifiedDomains.length) {
    throw new Error(
      `Verify an organization domain before limiting signup to ${domainSignupPolicyLabels[policy]}.`,
    );
  }
  if (emailMatchesVerifiedOrganizationDomain(email, verifiedDomains)) return;
  throw new Error('Verified organization domain is required for organization members.');
}

async function assertOrganizationInviteAllowed(
  db: DbRef,
  workspace: Workspace,
  email: string | null,
  role: WorkspaceMemberRole,
) {
  if (!workspace.organizationId) return;
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    workspace.organizationId,
  );
  if (!organization) return;
  if (role === 'guest' && !sharingPolicyAllows(organization, 'guestAccess', true)) {
    throw new Error('External guest invitations are disabled by organization policy.');
  }
  await assertOrganizationDomainSignupAllowed(db, organization, email, parseOrganizationRole(role, 'member'));
  if (!email) return;
  const verifiedDomains = await verifiedOrganizationDomainsForWorkspace(db, workspace);
  if (!verifiedDomains.length) return;
  const emailDomain = normalizeOrganizationDomain(email);
  if (!emailDomain) throw new Error('Email is invalid.');
  if (verifiedDomains.some((domain) => domain.domain === emailDomain)) return;
  if (
    role === 'guest' &&
    sharingPolicyAllows(organization, 'externalEmailSharing', true)
  ) {
    return;
  }
  if (role === 'guest') {
    throw new Error('External guest invitations are disabled by organization policy.');
  }
  throw new Error(
    'Verified organization domain is required for admin/member invitations. Invite external people as guests.',
  );
}

async function ensureDefaultOrganization(db: DbRef, actorId: string, authEmail: string | null) {
  const organizations = db.table<Organization>('organizations');
  const owned = await listAll(organizations.where('ownerId', '==', actorId));
  const existing = sortOrganizations(owned)[0] ?? null;
  if (existing) {
    const member = await ensureOrganizationMember(db, existing, actorId, authEmail, 'owner');
    return { organization: existing, currentOrganizationMember: member };
  }

  const now = nowIso();
  const organization = await organizations.insert({
    name: organizationNameFor(authEmail),
    icon: '🏢',
    ownerId: actorId,
    workspaceCreationPolicy: 'owners_admins',
    domainSignupPolicy: 'invite_only',
    sharingPolicy: {
      publicWebSharing: true,
      externalEmailSharing: true,
      guestAccess: true,
      fileDownloads: true,
      fullAccessGrants: true,
    },
    createdAt: now,
    updatedAt: now,
  });
  const member = await ensureOrganizationMember(db, organization, actorId, authEmail, 'owner');
  await recordOrganizationAudit(db, {
    organizationId: organization.id,
    workspaceId: null,
    actorId,
    action: 'organization.create',
    targetType: 'organization',
    targetId: organization.id,
    metadata: { source: 'workspace-bootstrap' },
    occurredAt: now,
  });
  return { organization, currentOrganizationMember: member };
}

async function actorOrganizationMembership(
  db: DbRef,
  organizationId: string,
  actorId: string,
) {
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId),
  );
  return members.find(
    (member) => member.userId === actorId && (member.status ?? 'active') === 'active',
  ) ?? null;
}

async function assertActiveOrganizationMembership(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
) {
  if (!workspace.organizationId) return;
  const organization = await getExisting(
    db.table<Organization>('organizations'),
    workspace.organizationId,
  );
  if (!organization) return;
  if (organization.ownerId === actorId) return;
  const currentOrganizationMember = await actorOrganizationMembership(db, organization.id, actorId);
  if (!currentOrganizationMember) {
    throw new Error('Organization active membership required.');
  }
}

async function hasActiveOrganizationMembership(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
) {
  try {
    await assertActiveOrganizationMembership(db, workspace, actorId);
    return true;
  } catch {
    return false;
  }
}

async function isNotDeactivatedInWorkspaceOrganization(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
) {
  if (!workspace.organizationId) return true;
  const members = await listAll(
    db.table<OrganizationMember>('organization_members').where(
      'organizationId',
      '==',
      workspace.organizationId,
    ),
  );
  const member = members.find((item) => item.userId === actorId) ?? null;
  return (member?.status ?? 'active') !== 'deactivated';
}

async function organizationForWorkspace(
  db: DbRef,
  workspace: Workspace,
  actorId: string,
  authEmail: string | null,
) {
  const organizations = db.table<Organization>('organizations');
  const workspaces = db.table<Workspace>('workspaces');
  if (workspace.organizationId) {
    const organization = await getExisting(organizations, workspace.organizationId);
    if (organization) {
      const currentOrganizationMember =
        await actorOrganizationMembership(db, organization.id, actorId) ??
        (organization.ownerId === actorId
          ? await ensureOrganizationMember(db, organization, actorId, authEmail, 'owner')
          : null);
      return { organization, currentOrganizationMember };
    }
  }

  if (workspace.ownerId && workspace.ownerId !== actorId) {
    return { organization: null, currentOrganizationMember: null };
  }

  const ensured = await ensureDefaultOrganization(db, actorId, authEmail);
  const updated = await workspaces.update(workspace.id, {
    organizationId: ensured.organization.id,
  });
  workspace.organizationId = updated.organizationId;
  await recordOrganizationAudit(db, {
    organizationId: ensured.organization.id,
    workspaceId: workspace.id,
    actorId,
    action: 'workspace.link_organization',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: { source: 'lazy-backfill' },
    occurredAt: nowIso(),
  });
  return ensured;
}

function defaultEnterpriseControls(organizationId: string): Partial<OrganizationEnterpriseControls> {
  return {
    organizationId,
    ssoConfig: { enabled: false, providerType: 'saml', enforcement: 'optional' },
    scimConfig: { enabled: false, provisioningMode: 'manual', deprovisionAction: 'deactivate' },
    auditPolicy: { retentionDays: 365, exportFormat: 'jsonl' },
    dataResidencyPolicy: { primaryRegion: 'global', allowedRegions: ['global'], enforcementMode: 'metadata_only' },
    dlpPolicy: {
      enabled: false,
      blockPublicSharing: false,
      blockExternalSharing: false,
      blockFileDownloads: false,
      blockExports: false,
      sensitiveTerms: [],
    },
    legalPolicy: { defaultHoldScope: 'organization', requireReason: true },
    billingProfile: { contractStatus: 'draft' },
  };
}

async function enterpriseControlsForOrganization(db: DbRef, organizationId: string) {
  const controls = await listAll(
    db.table<OrganizationEnterpriseControls>('organization_enterprise_controls').where(
      'organizationId',
      '==',
      organizationId,
    ),
  );
  if (controls[0]) return controls[0];
  return await db.table<OrganizationEnterpriseControls>('organization_enterprise_controls').insert(
    defaultEnterpriseControls(organizationId),
  );
}

function redactScimToken(token: OrganizationScimToken): OrganizationScimToken {
  return {
    ...token,
    tokenHash: undefined,
    tokenPrefix: token.tokenPrefix ? `${token.tokenPrefix}...` : null,
  };
}

async function organizationEnterpriseDirectory(
  db: DbRef,
  organizationId: string,
  actorRole: OrganizationMemberRole,
) {
  const canSecurity = organizationSecurityAdminRoles.has(actorRole);
  const canBilling = organizationBillingAdminRoles.has(actorRole);
  const canAudit = organizationAdminRoles.has(actorRole);
  const [
    enterpriseControls,
    scimTokens,
    legalHolds,
    auditExports,
    billingRecords,
  ] = await Promise.all([
    enterpriseControlsForOrganization(db, organizationId),
    canSecurity
      ? listAll(db.table<OrganizationScimToken>('organization_scim_tokens').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
    canSecurity
      ? listAll(db.table<OrganizationLegalHold>('organization_legal_holds').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
    canAudit
      ? listAll(db.table<OrganizationAuditExport>('organization_audit_exports').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
    canBilling
      ? listAll(db.table<OrganizationBillingRecord>('organization_billing_records').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
  ]);
  return {
    enterpriseControls,
    organizationScimTokens: sortOrganizationScimTokens(scimTokens).map(redactScimToken),
    organizationLegalHolds: sortOrganizationLegalHolds(legalHolds),
    organizationAuditExports: sortOrganizationAuditExports(auditExports).slice(0, 20),
    organizationBillingRecords: sortOrganizationBillingRecords(billingRecords),
  };
}

async function organizationDirectory(
  db: DbRef,
  organizationId: string,
  actorId: string,
  options: Record<string, unknown> = {},
) {
  const organizations = db.table<Organization>('organizations');
  const organization = await getExisting(organizations, organizationId);
  if (!organization) throw new Error('Organization was not found.');
  const currentOrganizationMember =
    await actorOrganizationMembership(db, organizationId, actorId) ??
    (organization.ownerId === actorId
      ? await ensureOrganizationMember(db, organization, actorId, null, 'owner')
      : null);
  if (!currentOrganizationMember) throw new Error('Organization access required.');
  const actorRole = organizationActorRole(organization, currentOrganizationMember, actorId);
  if (!organizationAdminRoles.has(actorRole)) {
    throw new Error('Organization admin access required.');
  }
  const organizationMembers = sortOrganizationMembers(
    await listAll(db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId)),
  );
  const workspaces = sortWorkspaces(
    await listAll(db.table<Workspace>('workspaces').where('organizationId', '==', organizationId)),
  );
  const organizationGroups = await organizationGroupsForDirectory(db, organizationId, organizationMembers);
  const organizationDomains = sortOrganizationDomains(
    await listAll(db.table<OrganizationDomain>('organization_domains').where('organizationId', '==', organizationId)),
  );
  const organizationProfiles = await organizationProfilesForDirectory(db, organizationMembers, workspaces);
  let organizationAuditEvents: OrganizationAuditEvent[] = [];
  let organizationAuditFilter: Record<string, unknown> | null = null;
  if (organizationAdminRoles.has(actorRole)) {
    const auditAction = optionalAuditFilter(options.auditAction, 'auditAction');
    const auditTargetType = optionalAuditFilter(options.auditTargetType, 'auditTargetType');
    const auditLimit = parseAuditLimit(options.auditLimit);
    organizationAuditFilter = {
      action: auditAction,
      targetType: auditTargetType,
      limit: auditLimit,
    };
    organizationAuditEvents = sortOrganizationAuditEvents(
      await listAll(
        db.table<OrganizationAuditEvent>('organization_audit_events').where('organizationId', '==', organizationId),
      ),
    );
    if (auditAction) {
      organizationAuditEvents = organizationAuditEvents.filter((event) => event.action === auditAction);
    }
    if (auditTargetType) {
      organizationAuditEvents = organizationAuditEvents.filter((event) => event.targetType === auditTargetType);
    }
    organizationAuditEvents = organizationAuditEvents.slice(0, auditLimit);
  }
  const enterpriseDirectory = await organizationEnterpriseDirectory(db, organizationId, actorRole);
  return {
    organization,
    instanceSettings: await getInstanceSettings(db),
    currentOrganizationMember,
    organizationMembers,
    organizationGroups,
    organizationProfiles,
    organizationDomains,
    organizationAuditEvents,
    organizationAuditFilter,
    workspaces,
    ...enterpriseDirectory,
  };
}

async function searchOrganizationPeople(
  db: DbRef,
  organizationId: string,
  actorId: string,
  options: Record<string, unknown> = {},
) {
  const organizations = db.table<Organization>('organizations');
  const organization = await getExisting(organizations, organizationId);
  if (!organization) throw new Error('Organization was not found.');
  const currentOrganizationMember =
    await actorOrganizationMembership(db, organizationId, actorId) ??
    (organization.ownerId === actorId
      ? await ensureOrganizationMember(db, organization, actorId, null, 'owner')
      : null);
  if (!currentOrganizationMember) throw new Error('Organization access required.');
  const actorRole = organizationActorRole(organization, currentOrganizationMember, actorId);
  const canReadAdminDirectory = organizationAdminRoles.has(actorRole);
  const query = optionalAuditFilter(options.query, 'query')?.toLowerCase() ?? '';
  const limit = parsePeopleSearchLimit(options.limit);
  const includeInvited = canReadAdminDirectory && options.includeInvited === true;
  const includeDeactivated = canReadAdminDirectory && options.includeDeactivated === true;
  const organizationMembers = sortOrganizationMembers(
    await listAll(db.table<OrganizationMember>('organization_members').where('organizationId', '==', organizationId)),
  );
  const profiles = canReadAdminDirectory
    ? await organizationProfilesForDirectory(
        db,
        organizationMembers,
        sortWorkspaces(
          await listAll(db.table<Workspace>('workspaces').where('organizationId', '==', organizationId)),
        ),
      )
    : sortOrganizationProfiles(
        organizationMembers.map((member) => ({
          organizationMemberId: null,
          userId: member.userId,
          displayName: member.displayName ?? null,
          email: normalizeEmail(member.email),
          organizationRole: member.userId === actorId ? parseOrganizationRole(member.role, 'member') : 'member',
          status: member.status ?? 'active',
          workspaceMemberships: [],
          pendingInvitations: [],
        })),
      );
  const people = sortOrganizationProfiles(profiles)
    .filter((profile) => {
      if (!organizationProfileMatchesQuery(profile, query)) return false;
      if (!includeDeactivated && profile.status === 'deactivated') return false;
      if (!includeInvited && profile.status === 'invited') return false;
      if (!includeInvited && !profile.userId) return false;
      return true;
    })
    .slice(0, limit);
  return {
    organization: canReadAdminDirectory ? organization : undefined,
    currentOrganizationMember,
    query,
    limit,
    people,
  };
}

async function organizationAdminContext(db: DbRef, organizationId: string, actorId: string) {
  const directory = await organizationDirectory(db, organizationId, actorId);
  const actorRole =
    directory.organization.ownerId === actorId
      ? 'owner'
      : parseOrganizationRole(directory.currentOrganizationMember?.role, 'member');
  if (!organizationAdminRoles.has(actorRole)) {
    throw new Error('Organization admin access required.');
  }
  return { ...directory, actorRole };
}

function findOrganizationMember(
  members: OrganizationMember[],
  body: Record<string, unknown>,
) {
  const memberId = optionalString(body.organizationMemberId ?? body.memberId, 'organizationMemberId');
  const userId = optionalString(body.userId, 'userId');
  if (!memberId && !userId) throw new Error('Organization member id or user id is required.');
  return memberId
    ? members.find((member) => member.id === memberId) ?? null
    : members.find((member) => member.userId === userId) ?? null;
}

function findOrganizationGroup(
  groups: OrganizationGroupDirectory[],
  body: Record<string, unknown>,
) {
  const groupId = optionalString(body.organizationGroupId ?? body.groupId, 'organizationGroupId');
  const name = optionalString(
    body.organizationGroupName ?? body.currentName ?? body.name,
    'organizationGroupName',
  );
  if (!groupId && !name) throw new Error('Organization group id or name is required.');
  return groupId
    ? groups.find((group) => group.id === groupId) ?? null
    : groups.find((group) => group.name.toLowerCase() === String(name).toLowerCase()) ?? null;
}

function findOrganizationGroupMember(
  group: OrganizationGroupDirectory,
  body: Record<string, unknown>,
) {
  const groupMemberId = optionalString(body.organizationGroupMemberId ?? body.groupMemberId, 'organizationGroupMemberId');
  const organizationMemberId = optionalString(body.organizationMemberId ?? body.memberId, 'organizationMemberId');
  const userId = optionalString(body.userId, 'userId');
  if (!groupMemberId && !organizationMemberId && !userId) {
    throw new Error('Organization group member id, organization member id, or user id is required.');
  }
  if (groupMemberId) return group.members.find((member) => member.id === groupMemberId) ?? null;
  if (organizationMemberId) return group.members.find((member) => member.organizationMemberId === organizationMemberId) ?? null;
  return group.members.find((member) => member.userId === userId) ?? null;
}

function findWorkspaceMember(
  members: WorkspaceMember[],
  body: Record<string, unknown>,
) {
  const memberId = optionalString(body.workspaceMemberId ?? body.memberId, 'workspaceMemberId');
  const userId = optionalString(body.userId, 'userId');
  if (!memberId && !userId) throw new Error('Workspace member id or user id is required.');
  return memberId
    ? members.find((member) => member.id === memberId) ?? null
    : members.find((member) => member.userId === userId) ?? null;
}

function findOrganizationDomain(
  domains: OrganizationDomain[],
  body: Record<string, unknown>,
) {
  const domainId = optionalString(body.organizationDomainId ?? body.domainId, 'organizationDomainId');
  const domain = normalizeOrganizationDomain(body.domain);
  if (!domainId && !domain) throw new Error('Organization domain id or domain is required.');
  return domainId
    ? domains.find((item) => item.id === domainId) ?? null
    : domains.find((item) => item.domain === domain) ?? null;
}

function assertCanMutateOrganizationMember(
  organization: Organization,
  target: OrganizationMember,
  actorId: string,
  actorRole: OrganizationMemberRole = 'member',
) {
  const targetRole = parseOrganizationRole(target.role, 'member');
  if (target.userId === actorId) {
    throw new Error('You cannot change your own organization membership.');
  }
  if (target.userId === organization.ownerId || targetRole === 'owner') {
    throw new Error('Organization owners cannot be changed from member lifecycle actions.');
  }
  if (organizationAdminRoles.has(targetRole) && actorRole !== 'owner') {
    throw new Error('Organization owner access required to change admin roles.');
  }
}

function findContentReassignmentTarget(
  members: OrganizationMember[],
  body: Record<string, unknown>,
  target: OrganizationMember,
  actorId: string,
) {
  const memberId = optionalString(
    body.reassignToOrganizationMemberId ?? body.reassignmentOrganizationMemberId,
    'reassignToOrganizationMemberId',
  );
  const userId = optionalString(
    body.reassignToUserId ?? body.reassignmentUserId,
    'reassignToUserId',
  );
  const member =
    (memberId
      ? members.find((item) => item.id === memberId)
      : userId
        ? members.find((item) => item.userId === userId)
        : members.find((item) => item.userId === actorId)) ?? null;

  if (!member) throw new Error('Content reassignment target organization member was not found.');
  if (member.id === target.id || member.userId === target.userId) {
    throw new Error('Content reassignment target must be a different organization member.');
  }
  if ((member.status ?? 'active') !== 'active') {
    throw new Error('Content reassignment target must be an active organization member.');
  }
  if (parseOrganizationRole(member.role, 'member') === 'guest') {
    throw new Error('Content reassignment target must not be a guest.');
  }
  return member;
}

async function reassignOrganizationMemberContent(
  admin: AdminDbAccessor,
  workspaces: Workspace[],
  targetUserId: string,
  replacementUserId: string,
  now: string,
) {
  // Content ownership metadata lives in each workspace's block after the
  // split; iterate with a per-workspace facade instead of one central handle.
  const summary = {
    pagesCreatedBy: 0,
    pagesLastEditedBy: 0,
    blocksCreatedBy: 0,
    commentsAuthorId: 0,
    fileUploadsCreatedBy: 0,
  };

  for (const workspace of workspaces) {
    const workspaceContentDb = boundedDb(admin, workspace.id);
    const pagesTable = workspaceContentDb.table<Page>('pages');
    const blocksTable = workspaceContentDb.table<Block>('blocks');
    const commentsTable = workspaceContentDb.table<Comment>('comments');
    const fileUploadsTable = workspaceContentDb.table<FileUpload>('file_uploads');
    const pages = await listAll(pagesTable.where('workspaceId', '==', workspace.id));
    for (const page of pages) {
      const pagePatch: Record<string, unknown> = {};
      if (page.createdBy === targetUserId) {
        pagePatch.createdBy = replacementUserId;
        summary.pagesCreatedBy += 1;
      }
      if (page.lastEditedBy === targetUserId) {
        pagePatch.lastEditedBy = replacementUserId;
        summary.pagesLastEditedBy += 1;
      }
      if (Object.keys(pagePatch).length) {
        pagePatch.updatedAt = now;
        await pagesTable.update(page.id, pagePatch);
      }

      const blocks = await listAll(blocksTable.where('pageId', '==', page.id));
      for (const block of blocks) {
        if (block.createdBy !== targetUserId) continue;
        await blocksTable.update(block.id, {
          createdBy: replacementUserId,
          updatedAt: now,
        });
        summary.blocksCreatedBy += 1;
      }

      const comments = await listAll(commentsTable.where('pageId', '==', page.id));
      for (const comment of comments) {
        if (comment.authorId !== targetUserId) continue;
        await commentsTable.update(comment.id, {
          authorId: replacementUserId,
          updatedAt: now,
        });
        summary.commentsAuthorId += 1;
      }
    }

    const fileUploads = await listAll(fileUploadsTable.where('workspaceId', '==', workspace.id));
    for (const fileUpload of fileUploads) {
      if (fileUpload.createdBy !== targetUserId) continue;
      await fileUploadsTable.update(fileUpload.id, {
        createdBy: replacementUserId,
        updatedAt: now,
      });
      summary.fileUploadsCreatedBy += 1;
    }
  }

  return summary;
}

function assertCanCreateWorkspaceForOrganization(
  organization: Organization,
  member: OrganizationMember,
) {
  const role = parseOrganizationRole(member.role, 'member');
  if ((member.status ?? 'active') !== 'active') {
    throw new Error('Organization active membership required.');
  }
  if (organization.ownerId === member.userId || organizationPeopleAdminRoles.has(role)) return;
  const policy = parseWorkspaceCreationPolicy(organization.workspaceCreationPolicy, 'owners_admins');
  if (policy === 'members' && role === 'member') return;
  throw new Error(`Only organization ${workspaceCreationPolicyLabels[policy]} can create workspaces.`);
}

async function updateOrganizationSettings(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  const patch: Partial<Organization> = {};
  const instancePatch: Partial<InstanceSettings> = {};
  const metadata: Record<string, unknown> = {};
  if ('workspaceCreationPolicy' in body) {
    assertOrganizationPeopleAdmin(ctx.actorRole);
    patch.workspaceCreationPolicy = parseWorkspaceCreationPolicy(
      body.workspaceCreationPolicy,
      'owners_admins',
    );
    metadata.workspaceCreationPolicy = patch.workspaceCreationPolicy;
  }
  if ('domainSignupPolicy' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.domainSignupPolicy = parseDomainSignupPolicy(body.domainSignupPolicy, 'invite_only');
    if (
      patch.domainSignupPolicy === 'verified_domains' &&
      !(ctx.organizationDomains ?? []).some((domain) => (domain.status ?? 'pending') === 'verified')
    ) {
      throw new Error('Verify an organization domain before enabling domain-restricted signup.');
    }
    metadata.domainSignupPolicy = patch.domainSignupPolicy;
  }
  if ('signupPolicy' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    instancePatch.signupPolicy = parseSignupPolicy(body.signupPolicy, 'public');
    instancePatch.updatedBy = actorId;
    metadata.signupPolicy = instancePatch.signupPolicy;
  }
  const rawSharingPolicy =
    body.sharingPolicy && typeof body.sharingPolicy === 'object'
      ? (body.sharingPolicy as Record<string, unknown>)
      : {};
  const sharingPolicy: Record<string, unknown> = {
    ...(ctx.organization.sharingPolicy ?? {}),
  };
  for (const key of sharingPolicyKeys) {
    const value = parseOptionalBoolean(
      Object.prototype.hasOwnProperty.call(body, key) ? body[key] : rawSharingPolicy[key],
      key,
    );
    if (value === undefined) continue;
    assertOrganizationSecurityAdmin(ctx.actorRole);
    sharingPolicy[key] = value;
    metadata[key] = value;
  }
  if (sharingPolicyKeys.some((key) => Object.prototype.hasOwnProperty.call(metadata, key))) {
    patch.sharingPolicy = sharingPolicy;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'storageLimitBytes')) {
    assertOrganizationBillingAdmin(ctx.actorRole);
    const storageLimitBytes = parseOptionalStorageLimitBytes(body.storageLimitBytes);
    patch.storageLimitBytes = storageLimitBytes;
    metadata.storageLimitBytes = storageLimitBytes;
  }
  const hasOrganizationPatch = Object.keys(patch).length > 0;
  const hasInstancePatch = Object.keys(instancePatch).length > 0;
  if (!hasOrganizationPatch && !hasInstancePatch) return organizationDirectory(db, organizationId, actorId);
  const now = nowIso();
  let organization = ctx.organization;
  if (hasOrganizationPatch) {
    patch.updatedAt = now;
    organization = await db.table<Organization>('organizations').update(organizationId, patch);
  }
  if (hasInstancePatch) {
    instancePatch.updatedAt = now;
    await upsertInstanceSettings(db, instancePatch);
  }
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_settings.update',
    targetType: 'organization',
    targetId: organization.id,
    metadata,
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function findScimToken(tokens: OrganizationScimToken[], body: Record<string, unknown>) {
  const id = optionalString(body.scimTokenId ?? body.tokenId ?? body.id, 'scimTokenId');
  if (!id) return null;
  return tokens.find((token) => token.id === id) ?? null;
}

function findLegalHold(holds: OrganizationLegalHold[], body: Record<string, unknown>) {
  const id = optionalString(body.legalHoldId ?? body.holdId ?? body.id, 'legalHoldId');
  if (!id) return null;
  return holds.find((hold) => hold.id === id) ?? null;
}

function findBillingRecord(records: OrganizationBillingRecord[], body: Record<string, unknown>) {
  const id = optionalString(body.billingRecordId ?? body.recordId ?? body.id, 'billingRecordId');
  if (!id) return null;
  return records.find((record) => record.id === id) ?? null;
}

function sanitizeLegalHoldScope(value: unknown) {
  const input = optionalRecord(value, 'scope');
  const workspaceIds = stringList(input.workspaceIds, 'scope.workspaceIds', 100, 120);
  const pageIds = stringList(input.pageIds, 'scope.pageIds', 500, 120);
  const userIds = stringList(input.userIds, 'scope.userIds', 500, 120);
  const all = input.all === true || (!workspaceIds.length && !pageIds.length && !userIds.length);
  return stripNullish({
    all,
    workspaceIds,
    pageIds,
    userIds,
  });
}

function sanitizeBillingRecordInput(body: Record<string, unknown>, actorId: string) {
  const amountCents = optionalNumber(body.amountCents, 'amountCents');
  const currency = boundedText(body.currency, 'currency', 12)?.toUpperCase() ?? 'USD';
  return stripNullish({
    kind: parseEnum(body.kind, ['contract', 'subscription', 'invoice', 'credit'], 'contract', 'kind'),
    status: parseEnum(body.status, ['draft', 'active', 'paid', 'past_due', 'cancelled'], 'draft', 'status'),
    title: requireString(body.title, 'title').slice(0, 200),
    amountCents: amountCents === null ? null : Math.round(amountCents),
    currency,
    billingEmail: normalizeEmail(body.billingEmail),
    contractOwnerEmail: normalizeEmail(body.contractOwnerEmail),
    renewalAt: optionalIsoDateString(body.renewalAt, 'renewalAt'),
    periodStart: optionalIsoDateString(body.periodStart, 'periodStart'),
    periodEnd: optionalIsoDateString(body.periodEnd, 'periodEnd'),
    metadata: optionalRecord(body.metadata, 'metadata'),
    createdBy: actorId,
  });
}

async function updateOrganizationEnterpriseControls(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  const controls = await enterpriseControlsForOrganization(db, organizationId);
  const patch: Partial<OrganizationEnterpriseControls> = {};
  const metadata: Record<string, unknown> = {};

  if ('ssoConfig' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.ssoConfig = sanitizeSsoConfig(body.ssoConfig);
    metadata.ssoConfig = patch.ssoConfig;
  }
  if ('scimConfig' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.scimConfig = sanitizeScimConfig(body.scimConfig);
    metadata.scimConfig = patch.scimConfig;
  }
  if ('auditPolicy' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.auditPolicy = sanitizeAuditPolicy(body.auditPolicy);
    metadata.auditPolicy = patch.auditPolicy;
  }
  if ('dataResidencyPolicy' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.dataResidencyPolicy = sanitizeDataResidencyPolicy(body.dataResidencyPolicy);
    metadata.dataResidencyPolicy = patch.dataResidencyPolicy;
  }
  if ('dlpPolicy' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.dlpPolicy = sanitizeDlpPolicy(body.dlpPolicy);
    metadata.dlpPolicy = patch.dlpPolicy;
  }
  if ('legalPolicy' in body) {
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.legalPolicy = sanitizeLegalPolicy(body.legalPolicy);
    metadata.legalPolicy = patch.legalPolicy;
  }
  if ('billingProfile' in body) {
    assertOrganizationBillingAdmin(ctx.actorRole);
    patch.billingProfile = sanitizeBillingProfile(body.billingProfile);
    metadata.billingProfile = patch.billingProfile;
  }

  if (!Object.keys(patch).length) return organizationDirectory(db, organizationId, actorId);
  const now = nowIso();
  patch.updatedBy = actorId;
  patch.updatedAt = now;
  await db.table<OrganizationEnterpriseControls>('organization_enterprise_controls').update(controls.id, patch);
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_enterprise_controls.update',
    targetType: 'organization_enterprise_controls',
    targetId: controls.id,
    metadata,
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function createOrganizationScimToken(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const label = boundedText(body.label, 'label', 120) ?? 'SCIM token';
  const tokenSecret = `scim_${newToken()}${newToken().slice(0, 12)}`;
  const now = nowIso();
  const token = await db.table<OrganizationScimToken>('organization_scim_tokens').insert({
    organizationId,
    label,
    status: 'active',
    tokenPrefix: tokenSecret.slice(0, 14),
    tokenHash: await sha256Hex(tokenSecret),
    scopes: {
      users: true,
      groups: true,
      deprovision: true,
    },
    createdBy: actorId,
    expiresAt: optionalIsoDateString(body.expiresAt, 'expiresAt'),
    createdAt: now,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_scim_token.create',
    targetType: 'organization_scim_token',
    targetId: token.id,
    metadata: { label: token.label, tokenPrefix: token.tokenPrefix },
    occurredAt: now,
  });
  return {
    ...(await organizationDirectory(db, organizationId, actorId)),
    scimToken: redactScimToken(token),
    scimTokenSecret: tokenSecret,
  };
}

async function revokeOrganizationScimToken(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const tokens = await listAll(
    db.table<OrganizationScimToken>('organization_scim_tokens').where('organizationId', '==', organizationId),
  );
  const token = findScimToken(tokens, body);
  if (!token) throw new Error('SCIM token was not found.');
  const now = nowIso();
  await db.table<OrganizationScimToken>('organization_scim_tokens').update(token.id, {
    status: 'revoked',
    revokedAt: now,
    revokedBy: actorId,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_scim_token.revoke',
    targetType: 'organization_scim_token',
    targetId: token.id,
    metadata: { label: token.label },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function createOrganizationLegalHold(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const name = requireString(body.name, 'name').slice(0, 200);
  const reason = boundedText(body.reason, 'reason', 1000);
  const controls = await enterpriseControlsForOrganization(db, organizationId);
  if ((controls.legalPolicy?.requireReason ?? true) && !reason) {
    throw new Error('Legal hold reason is required.');
  }
  const now = nowIso();
  const hold = await db.table<OrganizationLegalHold>('organization_legal_holds').insert({
    organizationId,
    name,
    status: 'active',
    reason,
    scope: sanitizeLegalHoldScope(body.scope),
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_legal_hold.create',
    targetType: 'organization_legal_hold',
    targetId: hold.id,
    metadata: { name: hold.name, scope: hold.scope },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function releaseOrganizationLegalHold(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const holds = await listAll(
    db.table<OrganizationLegalHold>('organization_legal_holds').where('organizationId', '==', organizationId),
  );
  const hold = findLegalHold(holds, body);
  if (!hold) throw new Error('Legal hold was not found.');
  const now = nowIso();
  await db.table<OrganizationLegalHold>('organization_legal_holds').update(hold.id, {
    status: 'released',
    releasedAt: now,
    releasedBy: actorId,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_legal_hold.release',
    targetType: 'organization_legal_hold',
    targetId: hold.id,
    metadata: { name: hold.name },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

function auditExportRows(events: OrganizationAuditEvent[], format: string) {
  if (format === 'json') return JSON.stringify(events, null, 2);
  if (format === 'csv') {
    const header = ['occurredAt', 'actorId', 'action', 'targetType', 'targetId', 'metadata'];
    const rows = events.map((event) => [
      event.occurredAt,
      event.actorId ?? '',
      event.action,
      event.targetType ?? '',
      event.targetId ?? '',
      JSON.stringify(event.metadata ?? {}),
    ]);
    return [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
  }
  return events.map((event) => JSON.stringify(event)).join('\n');
}

async function exportOrganizationAuditEvents(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  await organizationAdminContext(db, organizationId, actorId);
  const controls = await enterpriseControlsForOrganization(db, organizationId);
  const format = parseEnum(
    body.format ?? controls.auditPolicy?.exportFormat,
    ['jsonl', 'csv', 'json'],
    'jsonl',
    'format',
  );
  const limit = parseAuditLimit(body.auditLimit ?? body.limit);
  const auditAction = optionalAuditFilter(body.auditAction, 'auditAction');
  const auditTargetType = optionalAuditFilter(body.auditTargetType, 'auditTargetType');
  const since = optionalIsoDateString(body.since, 'since');
  const until = optionalIsoDateString(body.until, 'until');
  const retentionDays = optionalIntegerInRange(
    controls.auditPolicy?.retentionDays,
    'auditPolicy.retentionDays',
    30,
    3650,
  );
  const retentionCutoff = retentionDays
    ? new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  let events = sortOrganizationAuditEvents(
    await listAll(
      db.table<OrganizationAuditEvent>('organization_audit_events').where('organizationId', '==', organizationId),
    ),
  );
  if (auditAction) events = events.filter((event) => event.action === auditAction);
  if (auditTargetType) events = events.filter((event) => event.targetType === auditTargetType);
  if (since) events = events.filter((event) => event.occurredAt >= since);
  if (until) events = events.filter((event) => event.occurredAt <= until);
  if (retentionCutoff) events = events.filter((event) => event.occurredAt >= retentionCutoff);
  events = events.slice(0, limit);
  const content = auditExportRows(events, format);
  const now = nowIso();
  const auditExport = await db.table<OrganizationAuditExport>('organization_audit_exports').insert({
    organizationId,
    status: 'completed',
    format,
    filter: {
      auditAction,
      auditTargetType,
      since,
      until,
      limit,
      retentionDays,
    },
    eventCount: events.length,
    content,
    createdBy: actorId,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_audit.export',
    targetType: 'organization_audit_export',
    targetId: auditExport.id,
    metadata: { format, eventCount: events.length, auditAction, auditTargetType },
    occurredAt: now,
  });
  return {
    ...(await organizationDirectory(db, organizationId, actorId)),
    auditExport,
    auditExportContent: content,
  };
}

async function upsertOrganizationBillingRecord(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationBillingAdmin(ctx.actorRole);
  const table = db.table<OrganizationBillingRecord>('organization_billing_records');
  const records = await listAll(table.where('organizationId', '==', organizationId));
  const existing = findBillingRecord(records, body);
  const now = nowIso();
  const patch = {
    organizationId,
    ...sanitizeBillingRecordInput(body, actorId),
    updatedAt: now,
  };
  const record = existing
    ? await table.update(existing.id, patch)
    : await table.insert({ ...patch, createdAt: now });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: existing ? 'organization_billing_record.update' : 'organization_billing_record.create',
    targetType: 'organization_billing_record',
    targetId: record.id,
    metadata: { kind: record.kind, status: record.status, title: record.title },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function deleteOrganizationBillingRecord(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationBillingAdmin(ctx.actorRole);
  const table = db.table<OrganizationBillingRecord>('organization_billing_records');
  const records = await listAll(table.where('organizationId', '==', organizationId));
  const record = findBillingRecord(records, body);
  if (!record) throw new Error('Billing record was not found.');
  await table.delete(record.id);
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_billing_record.delete',
    targetType: 'organization_billing_record',
    targetId: record.id,
    metadata: { kind: record.kind, status: record.status, title: record.title },
    occurredAt: nowIso(),
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function transferOrganizationOwner(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  if (ctx.organization.ownerId !== actorId) throw new Error('Organization owner access required.');
  const target = findOrganizationMember(ctx.organizationMembers, body);
  if (!target) throw new Error('Organization member was not found.');
  if (target.userId === actorId) {
    throw new Error('Organization owner transfer target must be another member.');
  }
  if ((target.status ?? 'active') !== 'active') {
    throw new Error('Organization owner transfer target must be active.');
  }

  const now = nowIso();
  const members = db.table<OrganizationMember>('organization_members');
  const currentOwnerMember = ctx.organizationMembers.find((member) => member.userId === actorId) ?? null;
  await db.table<Organization>('organizations').update(organizationId, {
    ownerId: target.userId,
    updatedAt: now,
  });
  if (currentOwnerMember) {
    await members.update(currentOwnerMember.id, {
      role: 'admin',
      status: 'active',
      deactivatedAt: null,
      deactivatedBy: null,
      updatedAt: now,
    });
  }
  const newOwnerMember = await members.update(target.id, {
    role: 'owner',
    status: 'active',
    deactivatedAt: null,
    deactivatedBy: null,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_owner.transfer',
    targetType: 'organization_member',
    targetId: newOwnerMember.id,
    metadata: { fromUserId: actorId, toUserId: newOwnerMember.userId },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function updateOrganizationMemberRole(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  if (ctx.organization.ownerId !== actorId) throw new Error('Organization owner access required.');
  const target = findOrganizationMember(ctx.organizationMembers, body);
  if (!target) throw new Error('Organization member was not found.');
  assertCanMutateOrganizationMember(ctx.organization, target, actorId, ctx.actorRole);
  const nextRole = parseOrganizationRole(body.role, 'member');
  if (nextRole === 'owner') {
    throw new Error('Use organization owner transfer to assign owner role.');
  }
  if ((target.status ?? 'active') !== 'active') {
    throw new Error('Only active organization members can change organization roles.');
  }
  const previousRole = parseOrganizationRole(target.role, 'member');
  if (previousRole === nextRole) return organizationDirectory(db, organizationId, actorId);
  await assertOrganizationDomainSignupAllowed(
    db,
    ctx.organization,
    normalizeEmail(target.email),
    nextRole,
  );
  const now = nowIso();
  const member = await db.table<OrganizationMember>('organization_members').update(target.id, {
    role: nextRole,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_member.role_update',
    targetType: 'organization_member',
    targetId: member.id,
    metadata: { userId: member.userId, fromRole: previousRole, toRole: nextRole },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function deactivateOrganizationMember(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const target = findOrganizationMember(ctx.organizationMembers, body);
  if (!target) throw new Error('Organization member was not found.');
  assertCanMutateOrganizationMember(ctx.organization, target, actorId, ctx.actorRole);
  if ((target.status ?? 'active') === 'deactivated') {
    return ctx;
  }
  const now = nowIso();
  const member = await db.table<OrganizationMember>('organization_members').update(target.id, {
    status: 'deactivated',
    deactivatedAt: now,
    deactivatedBy: actorId,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_member.deactivate',
    targetType: 'organization_member',
    targetId: member.id,
    metadata: { userId: member.userId },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function reactivateOrganizationMember(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const target = findOrganizationMember(ctx.organizationMembers, body);
  if (!target) throw new Error('Organization member was not found.');
  assertCanMutateOrganizationMember(ctx.organization, target, actorId, ctx.actorRole);
  if ((target.status ?? 'active') === 'active') {
    return ctx;
  }
  const now = nowIso();
  const member = await db.table<OrganizationMember>('organization_members').update(target.id, {
    status: 'active',
    deactivatedAt: null,
    deactivatedBy: null,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_member.reactivate',
    targetType: 'organization_member',
    targetId: member.id,
    metadata: { userId: member.userId },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function removeOrganizationMember(db: DbRef, admin: AdminDbAccessor, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const target = findOrganizationMember(ctx.organizationMembers, body);
  if (!target) throw new Error('Organization member was not found.');
  assertCanMutateOrganizationMember(ctx.organization, target, actorId, ctx.actorRole);
  const contentReassignmentTarget = findContentReassignmentTarget(
    ctx.organizationMembers,
    body,
    target,
    actorId,
  );

  const workspaceMembersTable = db.table<WorkspaceMember>('workspace_members');
  const invitationsTable = db.table<WorkspaceInvitation>('workspace_invitations');
  const groupMembersTable = db.table<OrganizationGroupMember>('organization_group_members');
  const targetEmail = normalizeEmail(target.email);
  const now = nowIso();
  const ownedWorkspaces = new Map<string, Workspace>();
  const membershipsToDelete: WorkspaceMember[] = [];
  const invitationsToRevoke: WorkspaceInvitation[] = [];
  const permissionsToDelete: PagePermission[] = [];
  const groupMembershipsToDelete = await listAll(
    groupMembersTable.where('organizationMemberId', '==', target.id),
  );

  for (const workspace of ctx.workspaces) {
    const workspaceMembers = await listAll(workspaceMembersTable.where('workspaceId', '==', workspace.id));
    if (workspace.ownerId === target.userId) {
      ownedWorkspaces.set(workspace.id, workspace);
    }
    for (const member of workspaceMembers) {
      if (member.userId !== target.userId) continue;
      if (parseMemberRole(member.role, 'member') === 'owner') {
        ownedWorkspaces.set(workspace.id, workspace);
      }
      membershipsToDelete.push(member);
    }

    if (targetEmail) {
      const invitations = await listAll(invitationsTable.where('workspaceId', '==', workspace.id));
      invitationsToRevoke.push(
        ...invitations.filter(
          (invitation) =>
            normalizeEmail(invitation.email) === targetEmail &&
            (invitation.status ?? 'pending') === 'pending',
        ),
      );
    }

    // page_permissions lives in the workspace block after the split; the
    // discovery read routes per workspace like the deletes below.
    const permissions = await listAll(
      boundedDb(admin, workspace.id)
        .table<PagePermission>('page_permissions')
        .where('workspaceId', '==', workspace.id),
    );
    permissionsToDelete.push(
      ...permissions.filter((permission) => {
        if (permission.principalType === 'user' && permission.principalId === target.userId) return true;
        if (permission.principalType !== 'email' || !targetEmail) return false;
        return normalizeEmail(permission.principalId ?? permission.label) === targetEmail;
      }),
    );
  }

  if (ownedWorkspaces.size > 0) {
    throw new Error('Transfer workspace ownership before removing this organization member.');
  }

  const contentReassignment = await reassignOrganizationMemberContent(
    admin,
    ctx.workspaces,
    target.userId,
    contentReassignmentTarget.userId,
    now,
  );

  // Access-revoking writes run in atomic transact batches guarded by the
  // actor's admin role, and the organization member row is deleted only in the
  // LAST batch (with the audit event). A partial failure therefore leaves the
  // member visibly present and the removal retryable, instead of a
  // half-removed member that still holds page permissions.
  // Owners are recognized by organizations.ownerId (a member row is not
  // guaranteed), so the guard follows the same basis the check used.
  const actorRoleGuard: TransactOperation =
    ctx.organization.ownerId === actorId
      ? {
          table: 'organizations',
          op: 'expect',
          id: organizationId,
          where: [['ownerId', '==', actorId]],
          exists: true,
        }
      : {
          table: 'organization_members',
          op: 'expect',
          where: [
            ['organizationId', '==', organizationId],
            ['userId', '==', actorId],
            ['role', '==', ctx.actorRole],
          ],
          exists: true,
        };
  // Two boundary-shaped stages (docs/workspace-do-migration.md):
  //
  // Stage 1 — page-permission revocations grouped PER WORKSPACE (each group
  // becomes that workspace DO's transact after the split). No guard here:
  // over-revoking the departing member's access is the safe direction, and a
  // central expect cannot ride a workspace-DO transact across the boundary.
  //
  // Stage 2 — ONE central batch: invitation revocations, workspace
  // memberships, group memberships, then the guarded organization-member
  // delete + audit event LAST. A failure anywhere leaves the member visibly
  // present and the removal retryable.
  // Central batches carry the guard, so they may fill the 500-op server cap
  // minus one; workspace-content batches route through boundedDb, which
  // appends one change_log insert per page_permissions op, so their RAW chunk
  // must stay at MAX_RAW_TRANSACT_OPS (2n <= 500, workspace-db.ts).
  const TRANSACT_CHUNK = 499;
  const permissionsByWorkspace = new Map<string, PagePermission[]>();
  for (const permission of permissionsToDelete) {
    const list = permissionsByWorkspace.get(permission.workspaceId) ?? [];
    list.push(permission);
    permissionsByWorkspace.set(permission.workspaceId, list);
  }
  for (const [workspaceId, workspacePermissions] of permissionsByWorkspace) {
    const workspaceContentDb = boundedDb(admin, workspaceId);
    const ops = workspacePermissions.map((permission): TransactOperation => ({
      table: 'page_permissions',
      op: 'delete',
      id: permission.id,
    }));
    for (let i = 0; i < ops.length; i += MAX_RAW_TRANSACT_OPS) {
      await runOrganizationTransact(workspaceContentDb, ops.slice(i, i + MAX_RAW_TRANSACT_OPS));
    }
  }

  const centralOps: TransactOperation[] = [
    ...invitationsToRevoke.map((invitation): TransactOperation => ({
      table: 'workspace_invitations',
      op: 'update',
      id: invitation.id,
      data: { status: 'revoked', updatedAt: now },
    })),
    ...membershipsToDelete.map((member): TransactOperation => ({
      table: 'workspace_members',
      op: 'delete',
      id: member.id,
    })),
    ...groupMembershipsToDelete.map((membership): TransactOperation => ({
      table: 'organization_group_members',
      op: 'delete',
      id: membership.id,
    })),
  ];
  const finalOps: TransactOperation[] = [
    actorRoleGuard,
    { table: 'organization_members', op: 'delete', id: target.id },
    {
      table: 'organization_audit_events',
      op: 'insert',
      data: {
        organizationId,
        workspaceId: null,
        actorId,
        action: 'organization_member.remove',
        targetType: 'organization_member',
        targetId: target.id,
        metadata: {
          userId: target.userId,
          email: targetEmail,
          contentReassignedToOrganizationMemberId: contentReassignmentTarget.id,
          contentReassignedToUserId: contentReassignmentTarget.userId,
          contentReassignment,
          removedWorkspaceMemberships: membershipsToDelete.length,
          removedGroupMemberships: groupMembershipsToDelete.length,
          revokedInvitations: invitationsToRevoke.length,
          removedPagePermissions: permissionsToDelete.length,
        },
        occurredAt: now,
      },
    },
  ];

  if (centralOps.length + finalOps.length <= TRANSACT_CHUNK + 1) {
    await runOrganizationTransact(db, [actorRoleGuard, ...centralOps, ...finalOps.slice(1)]);
  } else {
    for (let i = 0; i < centralOps.length; i += TRANSACT_CHUNK) {
      await runOrganizationTransact(db, [actorRoleGuard, ...centralOps.slice(i, i + TRANSACT_CHUNK)]);
    }
    await runOrganizationTransact(db, finalOps);
  }
  return organizationDirectory(db, organizationId, actorId);
}

// Policy-affecting mutations invalidate workspace-DO policy snapshots via the
// central version stamp (docs/workspace-do-migration.md). Bumped after the
// mutation succeeds; the bump itself is reliable (a failed bump fails the
// request) because a silently stale version would defeat the cache contract.
async function withPolicyVersionBump<T>(
  db: DbRef,
  body: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const result = await run();
  const organizationId = typeof body.organizationId === 'string' ? body.organizationId : null;
  await bumpOrganizationPolicyVersion(db, organizationId);
  return result;
}

async function runOrganizationTransact(db: DbRef, operations: TransactOperation[]) {
  try {
    return await db.transact(operations);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An unmet admin-role guard means the actor lost the right mid-flight.
    if (message.includes('Transaction expectation failed')) {
      throw new Error('Organization people admin access required.');
    }
    throw error;
  }
}

async function createOrganizationGroup(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const name = requireString(body.name, 'name');
  const description = optionalString(body.description, 'description');
  if (ctx.organizationGroups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('Organization group already exists.');
  }
  const now = nowIso();
  const group = await db.table<OrganizationGroup>('organization_groups').insert({
    organizationId,
    name,
    description,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_group.create',
    targetType: 'organization_group',
    targetId: group.id,
    metadata: { name },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function updateOrganizationGroup(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const group = findOrganizationGroup(ctx.organizationGroups, body);
  if (!group) throw new Error('Organization group was not found.');
  const patch: Partial<OrganizationGroup> = {};
  const metadata: Record<string, unknown> = {};
  if ('name' in body) {
    const name = requireString(body.name, 'name');
    if (
      ctx.organizationGroups.some(
        (item) => item.id !== group.id && item.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error('Organization group already exists.');
    }
    patch.name = name;
    metadata.name = name;
  }
  if ('description' in body) {
    patch.description = optionalString(body.description, 'description');
    metadata.description = patch.description;
  }
  if (!Object.keys(patch).length) return organizationDirectory(db, organizationId, actorId);
  patch.updatedAt = nowIso();
  const updated = await db.table<OrganizationGroup>('organization_groups').update(group.id, patch);
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_group.update',
    targetType: 'organization_group',
    targetId: updated.id,
    metadata,
    occurredAt: patch.updatedAt,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function deleteOrganizationGroup(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const group = findOrganizationGroup(ctx.organizationGroups, body);
  if (!group) throw new Error('Organization group was not found.');
  const groupMembersTable = db.table<OrganizationGroupMember>('organization_group_members');
  const groupMembers = await listAll(groupMembersTable.where('groupId', '==', group.id));
  for (const member of groupMembers) await bestEffort('workspace-mutation groupMembersTable.delete', groupMembersTable.delete(member.id));
  await db.table<OrganizationGroup>('organization_groups').delete(group.id);
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_group.delete',
    targetType: 'organization_group',
    targetId: group.id,
    metadata: { name: group.name, removedMembers: groupMembers.length },
    occurredAt: nowIso(),
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function addOrganizationGroupMember(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const group = findOrganizationGroup(ctx.organizationGroups, body);
  if (!group) throw new Error('Organization group was not found.');
  const target = findOrganizationMember(ctx.organizationMembers, body);
  if (!target) throw new Error('Organization member was not found.');
  if ((target.status ?? 'active') !== 'active') {
    throw new Error('Only active organization members can be added to groups.');
  }
  const existing = group.members.find((member) => member.organizationMemberId === target.id);
  if (existing) return organizationDirectory(db, organizationId, actorId);
  const now = nowIso();
  const membership = await db.table<OrganizationGroupMember>('organization_group_members').insert({
    organizationId,
    groupId: group.id,
    organizationMemberId: target.id,
    userId: target.userId,
    role: 'member',
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_group_member.add',
    targetType: 'organization_group_member',
    targetId: membership.id,
    metadata: { groupId: group.id, groupName: group.name, userId: target.userId },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function removeOrganizationGroupMember(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const group = findOrganizationGroup(ctx.organizationGroups, body);
  if (!group) throw new Error('Organization group was not found.');
  const target = findOrganizationGroupMember(group, body);
  if (!target) throw new Error('Organization group member was not found.');
  await db.table<OrganizationGroupMember>('organization_group_members').delete(target.id);
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_group_member.remove',
    targetType: 'organization_group_member',
    targetId: target.id,
    metadata: { groupId: group.id, groupName: group.name, userId: target.userId },
    occurredAt: nowIso(),
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function addOrganizationDomain(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const domain = requireOrganizationDomain(body.domain);
  const domains = db.table<OrganizationDomain>('organization_domains');
  const matches = await listAll(domains.where('domain', '==', domain));
  if (matches.some((item) => item.organizationId !== organizationId)) {
    throw new Error('Organization domain is already in use.');
  }
  if (matches.some((item) => item.organizationId === organizationId)) {
    throw new Error('Organization domain already exists.');
  }
  const now = nowIso();
  const record = await domains.insert({
    organizationId,
    domain,
    status: 'pending',
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_domain.create',
    targetType: 'organization_domain',
    targetId: record.id,
    metadata: { domain },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function verifyOrganizationDomain(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const target = findOrganizationDomain(ctx.organizationDomains ?? [], body);
  if (!target) throw new Error('Organization domain was not found.');
  if ((target.status ?? 'pending') === 'verified') return ctx;
  const now = nowIso();
  const domain = await db.table<OrganizationDomain>('organization_domains').update(target.id, {
    status: 'verified',
    verifiedAt: now,
    verifiedBy: actorId,
  });
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_domain.verify',
    targetType: 'organization_domain',
    targetId: domain.id,
    metadata: { domain: domain.domain },
    occurredAt: now,
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function removeOrganizationDomain(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const target = findOrganizationDomain(ctx.organizationDomains ?? [], body);
  if (!target) throw new Error('Organization domain was not found.');
  if (
    parseDomainSignupPolicy(ctx.organization.domainSignupPolicy, 'invite_only') === 'verified_domains' &&
    (target.status ?? 'pending') === 'verified' &&
    !(ctx.organizationDomains ?? []).some(
      (domain) =>
        domain.id !== target.id &&
        (domain.status ?? 'pending') === 'verified',
    )
  ) {
    throw new Error('Disable domain-restricted signup before removing the last verified domain.');
  }
  await db.table<OrganizationDomain>('organization_domains').delete(target.id);
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_domain.remove',
    targetType: 'organization_domain',
    targetId: target.id,
    metadata: { domain: target.domain, status: target.status ?? 'pending' },
    occurredAt: nowIso(),
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function accessibleWorkspaces(
  db: DbRef,
  admin: AdminDbAccessor,
  actorId: string,
  authEmail: string | null = null,
) {
  const workspaces = db.table<Workspace>('workspaces');
  const membersTable = db.table<WorkspaceMember>('workspace_members');
  const owned = await listAll(workspaces.where('ownerId', '==', actorId));
  const memberships = await listAll(membersTable.where('userId', '==', actorId));
  const byId = new Map<string, Workspace>();
  for (const workspace of owned) byId.set(workspace.id, workspace);
  for (const membership of memberships) {
    const workspace = await getExisting(workspaces, membership.workspaceId);
    if (workspace && (await hasActiveOrganizationMembership(db, workspace, actorId))) {
      byId.set(workspace.id, workspace);
    }
  }
  // Grant discovery reads the central index; page_permissions is workspace-side.
  const grantWorkspaceIds = await discoverPermissionWorkspaceIds(admin, actorId, authEmail);
  for (const grantWorkspaceId of grantWorkspaceIds) {
    if (!grantWorkspaceId || byId.has(grantWorkspaceId)) continue;
    const workspace = await getExisting(workspaces, grantWorkspaceId);
    if (
      workspace &&
      (await workspaceHasCurrentDirectPageAccess(db, admin, workspace, actorId, authEmail))
    ) {
      byId.set(workspace.id, workspace);
    }
  }
  return sortWorkspaces(Array.from(byId.values()));
}

async function workspaceHasCurrentDirectPageAccess(
  db: DbRef,
  admin: AdminDbAccessor,
  workspace: Workspace,
  actorId: string,
  authEmail: string | null,
) {
  if (!(await isNotDeactivatedInWorkspaceOrganization(db, workspace, actorId))) return false;
  // Authoritative grant + page reads run against the workspace block.
  const contentDb = boundedDb(admin, workspace.id) as unknown as DbRef;
  const directPermissions = await actorPagePermissions(contentDb, actorId, workspace.id, authEmail);
  if (!directPermissions.length) return false;
  const pages = contentDb.table<Page>('pages');
  const visited = new Set<string>();
  for (const permission of directPermissions) {
    if (!permission.pageId || visited.has(permission.pageId)) continue;
    visited.add(permission.pageId);
    const page = await getExisting(pages, permission.pageId);
    if (!page || page.workspaceId !== workspace.id) continue;
    if (await pageAccessRole(contentDb, page, actorId, workspace, authEmail)) return true;
  }
  return false;
}

async function organizationForNewWorkspace(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  authEmail: string | null,
) {
  const requestedOrganizationId = optionalString(body.organizationId, 'organizationId');
  if (!requestedOrganizationId) {
    const ensured = await ensureDefaultOrganization(db, actorId, authEmail);
    assertCanCreateWorkspaceForOrganization(ensured.organization, ensured.currentOrganizationMember);
    await assertOrganizationDomainSignupAllowed(
      db,
      ensured.organization,
      authEmail ?? normalizeEmail(ensured.currentOrganizationMember.email),
      parseOrganizationRole(ensured.currentOrganizationMember.role, 'member'),
    );
    return ensured;
  }

  const organization = await getExisting(
    db.table<Organization>('organizations'),
    requestedOrganizationId,
  );
  if (!organization) throw new Error('Organization was not found.');
  const currentOrganizationMember =
    await actorOrganizationMembership(db, organization.id, actorId) ??
    (organization.ownerId === actorId
      ? await ensureOrganizationMember(db, organization, actorId, authEmail, 'owner')
      : null);
  if (!currentOrganizationMember) throw new Error('Organization access required.');
  assertCanCreateWorkspaceForOrganization(organization, currentOrganizationMember);
  await assertOrganizationDomainSignupAllowed(
    db,
    organization,
    authEmail ?? normalizeEmail(currentOrganizationMember.email),
    parseOrganizationRole(currentOrganizationMember.role, 'member'),
  );
  return { organization, currentOrganizationMember };
}

async function workspaceContext(db: DbRef, workspaceId: string, actorId: string) {
  const workspaces = db.table<Workspace>('workspaces');
  const membersTable = db.table<WorkspaceMember>('workspace_members');
  const invitationsTable = db.table<WorkspaceInvitation>('workspace_invitations');
  const workspace = await getExisting(workspaces, workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  const members = await listAll(membersTable.where('workspaceId', '==', workspace.id));
  const invitations = await listAll(invitationsTable.where('workspaceId', '==', workspace.id));
  const currentMember = members.find((member) => member.userId === actorId);
  const currentRole =
    workspace.ownerId === actorId || (!workspace.ownerId && currentMember?.role === 'owner')
      ? 'owner'
      : currentMember
        ? parseMemberRole(currentMember.role, 'member')
        : null;
  if (!currentRole) throw new Error('Workspace access required.');
  await assertActiveOrganizationMembership(db, workspace, actorId);
  return {
    workspaces,
    membersTable,
    invitationsTable,
    workspace,
    members: sortMembers(members),
    invitations: sortInvitations(invitations),
    currentMember,
    currentRole,
  };
}

function assertWorkspaceAdmin(role: WorkspaceMemberRole | null) {
  if (role === 'owner' || role === 'admin') return;
  throw new Error('Workspace admin access required.');
}

function assertCanManageRole(
  actorRole: WorkspaceMemberRole,
  target: WorkspaceMember | null,
  nextRole: WorkspaceMemberRole,
  actorId: string,
  workspace: Workspace,
) {
  assertWorkspaceAdmin(actorRole);
  if (!manageableRoles.has(nextRole)) throw new Error('Only admin, member, and guest roles can be assigned.');
  if (nextRole === 'admin' && actorRole !== 'owner') throw new Error('Only workspace owners can assign admin.');
  if (!target) return;
  const targetRole = parseMemberRole(target.role, 'member');
  if (target.userId === workspace.ownerId || targetRole === 'owner') {
    throw new Error('Workspace owners cannot be changed from member management.');
  }
  if (target.userId === actorId) throw new Error('You cannot change your own workspace role.');
  if (actorRole !== 'owner' && roleRank[targetRole] >= roleRank[actorRole]) {
    throw new Error('Only workspace owners can manage admins.');
  }
}

function assertCanRemoveMember(
  actorRole: WorkspaceMemberRole,
  target: WorkspaceMember,
  actorId: string,
  workspace: Workspace,
) {
  assertWorkspaceAdmin(actorRole);
  const targetRole = parseMemberRole(target.role, 'member');
  if (target.userId === workspace.ownerId || targetRole === 'owner') {
    throw new Error('Workspace owners cannot be removed.');
  }
  if (target.userId === actorId) throw new Error('You cannot remove yourself from the workspace.');
  if (actorRole !== 'owner' && roleRank[targetRole] >= roleRank[actorRole]) {
    throw new Error('Only workspace owners can remove admins.');
  }
}

async function emitMembershipNotification(
  db: DbRef,
  workspace: Workspace,
  member: WorkspaceMember,
  actorId: string,
  action: MembershipNotificationAction,
) {
  if (!member.userId || member.userId === actorId) return;
  const occurredAt = member.updatedAt ?? member.createdAt ?? nowIso();
  const atKey = Date.parse(occurredAt) || occurredAt;
  const role = parseMemberRole(member.role, 'member');
  await bestEffort('workspace-mutation membership notification', upsertBoundedNotification(db, {
    workspaceId: workspace.id,
    userId: member.userId,
    activityKey: `membership:${member.id}:${atKey}`,
    kind: 'system',
    pageId: null,
    blockId: null,
    commentId: null,
    actorId,
    title: workspace.name,
    preview:
      action === 'invite'
        ? `You were added to ${workspace.name} as ${roleLabel(role)}.`
        : `Your role in ${workspace.name} is now ${roleLabel(role)}.`,
    target: '/settings',
    metadata: {
      source: 'membership',
      action,
      memberId: member.id,
      role,
    },
    occurredAt,
  }));
}

async function getMembers(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  authEmail: string | null,
) {
  const workspaceId = requireString(body.workspaceId ?? body.id, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  const organizationContext = await organizationForWorkspace(
    db,
    ctx.workspace,
    actorId,
    authEmail,
  );
  const canReadWorkspaceDirectory = ctx.currentRole === 'owner' || ctx.currentRole === 'admin';
  const currentOrganizationRole =
    organizationContext.organization && organizationContext.currentOrganizationMember
      ? organizationActorRole(organizationContext.organization, organizationContext.currentOrganizationMember, actorId)
      : null;
  const canReadOrganizationDirectory =
    !!currentOrganizationRole && organizationAdminRoles.has(currentOrganizationRole);
  const result: Record<string, unknown> = {
    workspace: ctx.workspace,
    organization: organizationContext.organization,
    currentOrganizationMember: organizationContext.currentOrganizationMember,
    currentMember: ctx.currentMember,
    members: canReadWorkspaceDirectory
      ? ctx.members
      : ctx.currentMember
        ? [ctx.currentMember]
        : [],
    invitations: canReadWorkspaceDirectory ? ctx.invitations : [],
  };
  if (canReadOrganizationDirectory && organizationContext.organization) {
    result.organizationMembers = sortOrganizationMembers(
      await listAll(
        db.table<OrganizationMember>('organization_members').where(
          'organizationId',
          '==',
          organizationContext.organization.id,
        ),
      ),
    );
    result.organizationDomains = sortOrganizationDomains(
      await listAll(
        db.table<OrganizationDomain>('organization_domains').where(
          'organizationId',
          '==',
          organizationContext.organization.id,
        ),
      ),
    );
    result.workspaces = sortWorkspaces(
      await listAll(
        db.table<Workspace>('workspaces').where(
          'organizationId',
          '==',
          organizationContext.organization.id,
        ),
      ),
    );
    result.instanceSettings = await getInstanceSettings(db);
  }
  return result;
}

async function listWorkspaces(db: DbRef, admin: AdminDbAccessor, actorId: string, authEmail: string | null) {
  return {
    workspaces: await accessibleWorkspaces(db, admin, actorId, authEmail),
    organizations: await listAccessibleOrganizations(db, actorId),
  };
}

async function createWorkspace(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  authEmail: string | null,
  starterLocale: ReturnType<typeof defaultWorkspaceLocale>,
  request?: Request,
) {
  const workspaces = db.table<Workspace>('workspaces');
  const membersTable = db.table<WorkspaceMember>('workspace_members');
  const now = nowIso();
  const name = optionalString(body.name, 'name') ?? 'Untitled Workspace';
  const icon = optionalString(body.icon, 'icon') ?? '📓';
  assertMetadataDoesNotAttachStoredFile(icon, 'icon', request);
  const domain = normalizeWorkspaceSlug(body.domain);
  const { organization, currentOrganizationMember } = await organizationForNewWorkspace(
    db,
    body,
    actorId,
    authEmail,
  );
  if (domain) {
    const matches = await listAll(workspaces.where('domain', '==', domain));
    if (matches.length) throw new Error('Workspace URL is already in use.');
  }
  const workspace = await workspaces.insert({
    organizationId: organization.id,
    name,
    icon,
    domain: domain ?? null,
    ownerId: actorId,
    createdAt: now,
    updatedAt: now,
  });
  const member = await membersTable.insert({
    workspaceId: workspace.id,
    userId: actorId,
    role: 'owner',
    email: authEmail,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  // Content seeding writes to the workspace block; index rows are written
  // synchronously so the fresh workspace's pages route immediately. Creation
  // flows that immediately import (Notion/Hanji) skip the starter pages so
  // the imported tree is not interleaved with seeded samples.
  if (body.skipDefaultPages !== true) {
    const seededPages = await seedDefaultWorkspacePages(
      boundedDb(admin, workspace.id) as Parameters<typeof seedDefaultWorkspacePages>[0],
      workspace,
      actorId,
      starterLocale,
    );
    for (const seeded of seededPages) {
      await ensurePageWorkspaceIndex(admin, seeded.id, workspace.id);
    }
  }
  await recordOrganizationAudit(db, {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actorId,
    action: 'workspace.create',
    targetType: 'workspace',
    targetId: workspace.id,
    metadata: { name, domain },
    occurredAt: now,
  });
  return {
    workspace,
    organization,
    currentOrganizationMember,
    currentMember: member,
    member,
    members: [member],
    invitations: [],
    workspaces: await accessibleWorkspaces(db, admin, actorId, authEmail),
    organizations: await listAccessibleOrganizations(db, actorId),
  };
}

async function updateWorkspace(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  request?: Request,
) {
  const id = requireString(body.id ?? body.workspaceId, 'id');
  const ctx = await workspaceContext(db, id, actorId);
  assertWorkspaceAdmin(ctx.currentRole);
  const patch = cleanPatch(
    body.patch && typeof body.patch === 'object' ? (body.patch as Record<string, unknown>) : {},
    request,
  );
  if ('domain' in patch && patch.domain) {
    const matches = await listAll(ctx.workspaces.where('domain', '==', patch.domain));
    const taken = matches.find((workspace) => workspace.id !== ctx.workspace.id);
    if (taken) throw new Error('Workspace URL is already in use.');
  }
  if (Object.keys(patch).length === 0) return { workspace: ctx.workspace };
  return { workspace: await ctx.workspaces.update(id, patch) };
}

async function transferWorkspaceOwner(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const id = requireString(body.id ?? body.workspaceId, 'workspaceId');
  const ctx = await workspaceContext(db, id, actorId);
  if (ctx.currentRole !== 'owner') throw new Error('Workspace owner access required.');
  const target = findWorkspaceMember(ctx.members, body);
  if (!target) throw new Error('Workspace member was not found.');
  if (!target.userId || target.userId === actorId) {
    throw new Error('Workspace owner transfer target must be another member.');
  }
  await assertOrganizationMemberCanJoinWorkspace(db, ctx.workspace, target.userId);

  const now = nowIso();
  const previousOwnerMember = ctx.members.find((member) => member.userId === actorId) ?? null;
  const workspace = await ctx.workspaces.update(id, {
    ownerId: target.userId,
    updatedAt: now,
  });
  if (previousOwnerMember) {
    await ctx.membersTable.update(previousOwnerMember.id, {
      role: 'admin',
      updatedAt: now,
    });
  }
  const ownerMember = await ctx.membersTable.update(target.id, {
    role: 'owner',
    updatedAt: now,
  });
  await emitMembershipNotification(db, workspace, ownerMember, actorId, 'role_update');
  if (workspace.organizationId) {
    await recordOrganizationAudit(db, {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      actorId,
      action: 'workspace_owner.transfer',
      targetType: 'workspace_member',
      targetId: ownerMember.id,
      metadata: { fromUserId: actorId, toUserId: ownerMember.userId },
      occurredAt: now,
    });
  }

  const members = sortMembers(
    (await listAll(ctx.membersTable.where('workspaceId', '==', workspace.id))),
  );
  const currentMember = members.find((member) => member.userId === actorId) ?? null;
  return {
    workspace,
    currentMember,
    member: ownerMember,
    members,
    invitations: ctx.invitations,
  };
}

async function collectWorkspaceNotionImportArtifacts(db: DbRef, workspaceId: string) {
  const connectionsTable = db.table<NotionImportConnectionRecord>('notion_import_connections');
  const jobsTable = db.table<NotionImportJobRecord>('notion_import_jobs');
  const itemsTable = db.table<NotionImportItemRecord>('notion_import_items');
  const mappingsTable = db.table<NotionImportMappingRecord>('notion_import_mappings');
  const locksTable = db.table<{ id: string; workspaceId?: string; jobId?: string }>('notion_import_apply_locks');

  const jobs = await listAll(jobsTable.where('workspaceId', '==', workspaceId));
  const [
    connections,
    workspaceItems,
    workspaceMappings,
    jobScopedItems,
    jobScopedMappings,
    workspaceLocks,
    jobScopedLocks,
  ] = await Promise.all([
    listAll(connectionsTable.where('workspaceId', '==', workspaceId)),
    listAll(itemsTable.where('workspaceId', '==', workspaceId)),
    listAll(mappingsTable.where('workspaceId', '==', workspaceId)),
    Promise.all(jobs.map((job) => listAll(itemsTable.where('jobId', '==', job.id)))),
    Promise.all(jobs.map((job) => listAll(mappingsTable.where('jobId', '==', job.id)))),
    listAll(locksTable.where('workspaceId', '==', workspaceId)),
    Promise.all(jobs.map((job) => listAll(locksTable.where('jobId', '==', job.id)))),
  ]);
  const items = uniqueById([...workspaceItems, ...jobScopedItems.flat()]);
  const mappings = uniqueById([...workspaceMappings, ...jobScopedMappings.flat()]);
  const locks = uniqueById([...workspaceLocks, ...jobScopedLocks.flat()]);

  return {
    connections,
    jobs,
    items,
    mappings,
    locks,
  };
}

async function deleteWorkspace(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  authEmail: string | null,
  storage?: FunctionStorageProxy,
  request?: Request,
) {
  const id = requireString(body.id ?? body.workspaceId, 'workspaceId');
  const ctx = await workspaceContext(db, id, actorId);
  assertWorkspaceAdmin(ctx.currentRole);
  const contentDb = boundedDb(admin, id, { allowWorkspaceDeletion: true });
  return withFileWorkspaceLease(contentDb, id, actorId, 'permanent-workspace-delete', (lease) =>
    deleteWorkspaceUnderLease(db, admin, body, actorId, authEmail, storage, request, lease));
}

async function deleteWorkspaceUnderLease(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  authEmail: string | null,
  storage: FunctionStorageProxy | undefined,
  request: Request | undefined,
  lease: FileWorkspaceLeaseGuard,
) {
  await lease.assertOwned();
  const id = requireString(body.id ?? body.workspaceId, 'workspaceId');
  const ctx = await workspaceContext(db, id, actorId);
  assertWorkspaceAdmin(ctx.currentRole);
  const contentReadDb = boundedDb(admin, id);
  const pagesTable = contentReadDb.table<Page>('pages');
  const blocksTable = contentReadDb.table<Block>('blocks');
  const commentsTable = contentReadDb.table<Comment>('comments');
  const permissionsTable = contentReadDb.table<PagePermission>('page_permissions');
  const shareLinksTable = contentReadDb.table<ShareLink>('share_links');
  const propertiesTable = contentReadDb.table<DbProperty>('db_properties');
  const viewsTable = contentReadDb.table<DbView>('db_views');
  const templatesTable = contentReadDb.table<DbTemplate>('db_templates');
  const operationsTable = contentReadDb.table<CollaborationOperation>('collaboration_operations');
  const collaborationDocumentsTable = contentReadDb.table<CollaborationDocument>('collaboration_documents');
  const indexTable = contentReadDb.table<DbPropertyIndex>('db_property_indexes');
  const uploadsTable = contentReadDb.table<FileUpload>('file_uploads');
  const notificationsTable = db.table<NotificationRecord>('notifications');
  const fileMaintenanceRunsTable = db.table<FileMaintenanceRun>('file_maintenance_runs');
  const pageWorkspaceIndexesTable = db.table<{ id: string; workspaceId: string }>('page_workspace_index');
  const workspace = ctx.workspace;
  const pages = await listAll(pagesTable.where('workspaceId', '==', id));
  const pageIds = pages.map((page) => page.id);
  const databaseIds = pages.filter((page) => page.kind === 'database').map((page) => page.id);
  if (pages.length > 0) {
    const confirmedName = typeof body.confirmWorkspaceName === 'string' ? body.confirmWorkspaceName.trim() : '';
    if (confirmedName !== workspace.name) {
      throw new Error('Type the workspace name to delete this workspace.');
    }
    await assertNoActiveLegalHoldForPermanentDelete(db, id, pageIds);
  }
  await markFileDeletionPending(db, id);

  const [
    blocks,
    comments,
    operations,
    collaborationDocuments,
    permissions,
    shareLinks,
    properties,
    views,
    templates,
    indexRows,
    uploads,
    notifications,
    fileMaintenanceRuns,
    pageWorkspaceIndexes,
  ] = await Promise.all([
    listByIds(blocksTable, 'pageId', pageIds),
    listByIds(commentsTable, 'pageId', pageIds),
    listByIds(operationsTable, 'pageId', pageIds),
    listByIds(collaborationDocumentsTable, 'pageId', pageIds),
    listAll(permissionsTable.where('workspaceId', '==', id)),
    listAll(shareLinksTable.where('workspaceId', '==', id)),
    listByIds(propertiesTable, 'databaseId', databaseIds),
    listByIds(viewsTable, 'databaseId', databaseIds),
    listByIds(templatesTable, 'databaseId', databaseIds),
    listAll(indexTable.where('workspaceId', '==', id)),
    listAll(uploadsTable.where('workspaceId', '==', id)),
    listAll(notificationsTable.where('workspaceId', '==', id)),
    listAll(fileMaintenanceRunsTable.where('workspaceId', '==', id)),
    listAll(pageWorkspaceIndexesTable.where('workspaceId', '==', id)),
  ]);
  await deleteStoredUploadsBeforeMetadata({
    admin,
    workspace,
    uploads,
    storage,
    request,
    leaseGuard: lease,
    excludePageIds: pageIds,
    excludeWorkspaceMetadata: true,
  });
  const notionImportArtifacts = await collectWorkspaceNotionImportArtifacts(contentReadDb, id);
  const notionImportCleanup = {
    connections: notionImportArtifacts.connections.length,
    jobs: notionImportArtifacts.jobs.length,
    items: notionImportArtifacts.items.length,
    mappings: notionImportArtifacts.mappings.length,
    locks: notionImportArtifacts.locks.length,
  };

  // Two boundary-shaped stages (docs/workspace-do-migration.md): stage 1 is
  // workspace-content cleanup (the future workspace-DO transact), stage 2 is
  // the central control plane (memberships, invitations, notifications,
  // maintenance runs, and the workspaces row LAST). A crash between stages
  // leaves the workspace row and memberships intact, so the delete stays
  // visible and retryable; stage 1 re-lists and is idempotent. At the DO
  // split, stage 2 additionally gains a leading `deleting` tombstone update.
  const contentOps: TransactOperation[] = [
    ...indexRows.map((item): TransactOperation => ({ table: 'db_property_indexes', op: 'delete', id: item.id })),
    ...collaborationDocuments.map((item): TransactOperation => ({ table: 'collaboration_documents', op: 'delete', id: item.id })),
    ...operations.map((item): TransactOperation => ({ table: 'collaboration_operations', op: 'delete', id: item.id })),
    ...blocks.map((item): TransactOperation => ({ table: 'blocks', op: 'delete', id: item.id })),
    ...comments.map((item): TransactOperation => ({ table: 'comments', op: 'delete', id: item.id })),
    ...permissions.map((item): TransactOperation => ({ table: 'page_permissions', op: 'delete', id: item.id })),
    ...shareLinks.map((item): TransactOperation => ({ table: 'share_links', op: 'delete', id: item.id })),
    ...templates.map((item): TransactOperation => ({ table: 'db_templates', op: 'delete', id: item.id })),
    ...views.map((item): TransactOperation => ({ table: 'db_views', op: 'delete', id: item.id })),
    ...properties.map((item): TransactOperation => ({ table: 'db_properties', op: 'delete', id: item.id })),
    ...uploads.map((item): TransactOperation => ({ table: 'file_uploads', op: 'delete', id: item.id })),
    ...notionImportArtifacts.items.map((item): TransactOperation => ({ table: 'notion_import_items', op: 'delete', id: item.id })),
    ...notionImportArtifacts.mappings.map((item): TransactOperation => ({ table: 'notion_import_mappings', op: 'delete', id: item.id })),
    ...notionImportArtifacts.locks.map((item): TransactOperation => ({ table: 'notion_import_apply_locks', op: 'delete', id: item.id })),
    ...notionImportArtifacts.jobs.map((item): TransactOperation => ({ table: 'notion_import_jobs', op: 'delete', id: item.id })),
    ...notionImportArtifacts.connections.map((item): TransactOperation => ({ table: 'notion_import_connections', op: 'delete', id: item.id })),
    ...pageIds.map((pageId): TransactOperation => ({ table: 'pages', op: 'delete', id: pageId })),
  ];
  const retryPrincipal = ctx.members.find((member) => member.userId === actorId) ?? null;
  const centralCleanupOps: TransactOperation[] = [
    ...pageWorkspaceIndexes.map((item): TransactOperation => ({
      table: 'page_workspace_index', op: 'delete', id: item.id,
    })),
    ...notifications.map((item): TransactOperation => ({ table: 'notifications', op: 'delete', id: item.id })),
    ...fileMaintenanceRuns.map((item): TransactOperation => ({ table: 'file_maintenance_runs', op: 'delete', id: item.id })),
    ...ctx.invitations.map((invitation): TransactOperation => ({ table: 'workspace_invitations', op: 'delete', id: invitation.id })),
    ...ctx.members
      .filter((member) => member.id !== retryPrincipal?.id)
      .map((member): TransactOperation => ({ table: 'workspace_members', op: 'delete', id: member.id })),
  ];
  // Preserve the requesting admin's membership until the same final atomic
  // batch that removes the workspace row. A crash between central chunks then
  // remains retryable instead of deleting the only principal authorized to
  // finish cleanup.
  const finalCentralOps: TransactOperation[] = [
    ...(retryPrincipal
      ? [{ table: 'workspace_members', op: 'delete' as const, id: retryPrincipal.id }]
      : []),
    { table: 'workspaces', op: 'delete', id },
  ];
  // Content chunks stay under MAX_RAW_TRANSACT_OPS because the boundedDb
  // facade appends one change_log insert per op on change-logged tables; a
  // 500-op raw chunk would double past the server's 500-op transact cap.
  // Central batches are never augmented and may fill the cap.
  const TRANSACT_CHUNK = 500;
  const contentDb = boundedDb(admin, id, { allowWorkspaceDeletion: true });
  for (let i = 0; i < contentOps.length; i += MAX_RAW_TRANSACT_OPS) {
    await lease.renew();
    await contentDb.transact(contentOps.slice(i, i + MAX_RAW_TRANSACT_OPS));
  }
  const assertNoResidualWorkspaceContent = async () => {
    for (const tableName of WORKSPACE_CONTENT_TABLES) {
      if (tableName === 'change_log' || tableName === 'file_workspace_locks') continue;
      const residual = await contentDb.table<{ id: string }>(tableName).limit(1).getList();
      if ((residual.items ?? []).length > 0) {
        throw Object.assign(
          new Error(`Workspace deletion detected a concurrent ${tableName} mutation; retry cleanup.`),
          { code: 409 },
        );
      }
    }
  };
  await assertNoResidualWorkspaceContent();
  // The workspace DO is not physically FK-cascaded by the central workspace
  // row. Re-list after content cleanup because bounded writes themselves append
  // tombstones, then remove every change-log identifier before central delete.
  const changeLog = await listAll(contentDb.table<{ id: string }>('change_log'));
  for (let i = 0; i < changeLog.length; i += MAX_RAW_TRANSACT_OPS) {
    await lease.renew();
    await contentDb.transact(
      changeLog.slice(i, i + MAX_RAW_TRANSACT_OPS).map((item) => ({
        table: 'change_log',
        op: 'delete' as const,
        id: item.id,
      })),
    );
  }
  await assertNoResidualWorkspaceContent();
  for (let i = 0; i < centralCleanupOps.length; i += TRANSACT_CHUNK) {
    await lease.renew();
    await db.transact(centralCleanupOps.slice(i, i + TRANSACT_CHUNK));
  }
  await lease.renew();
  await db.transact(finalCentralOps);
  if (workspace.organizationId) {
    await recordOrganizationAudit(db, {
      organizationId: workspace.organizationId,
      workspaceId: id,
      actorId,
      action: 'workspace.delete',
      targetType: 'workspace',
      targetId: id,
      metadata: {
        deletedPages: pages.length,
        deletedBlocks: blocks.length,
        deletedMembers: ctx.members.length,
        deletedInvitations: ctx.invitations.length,
        deletedFileUploads: uploads.length,
        deletedShareLinks: shareLinks.length,
        deletedPageWorkspaceIndexes: pageWorkspaceIndexes.length,
        notionImportCleanup,
      },
      occurredAt: nowIso(),
    });
  }
  return {
    deletedId: id,
    deletedPages: pages.length,
    deletedBlocks: blocks.length,
    deletedMembers: ctx.members.length,
    deletedInvitations: ctx.invitations.length,
    cleanup: {
      notionImport: notionImportCleanup,
      fileUploads: uploads.length,
      shareLinks: shareLinks.length,
      pageWorkspaceIndexes: pageWorkspaceIndexes.length,
      databaseProperties: properties.length,
      databaseViews: views.length,
      databaseTemplates: templates.length,
      collaborationOperations: operations.length,
      collaborationDocuments: collaborationDocuments.length,
      notifications: notifications.length,
    },
    workspaces: await accessibleWorkspaces(db, admin, actorId, authEmail),
    organizations: await listAccessibleOrganizations(db, actorId),
  };
}

async function updateMyProfile(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  request?: Request,
) {
  const workspaceId = requireString(body.workspaceId ?? body.id, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  const displayName = optionalString(body.displayName, 'displayName');
  const email = normalizeEmail(body.email);
  const avatar = optionalString(body.avatar, 'avatar') ?? null;
  assertMetadataDoesNotAttachStoredFile(avatar, 'avatar', request);
  if (ctx.workspace.organizationId) {
    const organization = await getExisting(
      db.table<Organization>('organizations'),
      ctx.workspace.organizationId,
    );
    if (organization) {
      const organizationMember =
        await actorOrganizationMembership(db, organization.id, actorId) ??
        (organization.ownerId === actorId
          ? await ensureOrganizationMember(db, organization, actorId, email, 'owner')
          : null);
      const organizationRole =
        organization.ownerId === actorId
          ? 'owner'
          : parseOrganizationRole(organizationMember?.role, 'member');
      await assertOrganizationDomainSignupAllowed(
        db,
        organization,
        email ?? normalizeEmail(ctx.currentMember?.email) ?? normalizeEmail(organizationMember?.email),
        organizationRole,
      );
    }
  }
  const patch: Partial<WorkspaceMember> = { displayName, email, avatar };
  const member = ctx.currentMember
    ? await ctx.membersTable.update(ctx.currentMember.id, patch)
    : await ctx.membersTable.insert({
        workspaceId: ctx.workspace.id,
        userId: actorId,
        role: ctx.currentRole,
        createdBy: actorId,
        ...patch,
      });
  await upsertOrganizationMemberForWorkspaceMember(db, ctx.workspace, member, actorId);
  const members = sortMembers([
    ...ctx.members.filter((item) => item.id !== member.id),
    member,
  ]);
  return {
    workspace: ctx.workspace,
    currentMember: member,
    member,
    members,
    invitations: ctx.currentRole === 'owner' || ctx.currentRole === 'admin' ? ctx.invitations : [],
  };
}

async function inviteMember(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  authAdmin?: AuthAdminRef,
) {
  const workspaceId = requireString(body.workspaceId ?? body.id, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  let userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null;
  const email = normalizeEmail(body.email);
  const role = parseMemberRole(body.role, 'member');
  // Member already in this workspace matching the requested email (email-only
  // requests): their role is updated in place below.
  const emailMember = !userId && email
    ? ctx.members.find((member) => normalizeEmail(member.email) === email) ?? null
    : null;
  // Server-level account model: workspace invitations/emails are gone. An email
  // that is not already a member is resolved to an EXISTING server account. An
  // email with no account falls through to a blind no-op below so the caller
  // cannot probe which addresses exist. To share with someone who has no
  // account yet, an admin provisions the account first, then adds them here.
  if (!userId && email && !emailMember) {
    userId = await resolveServerUserIdByEmail(authAdmin, email);
  }
  const existing = userId
    ? ctx.members.find((member) => member.userId === userId) ?? null
    : emailMember;
  assertCanManageRole(ctx.currentRole, existing, role, actorId, ctx.workspace);

  if (!userId && existing) {
    await assertOrganizationInviteAllowed(db, ctx.workspace, email, role);
    const previousRole = parseMemberRole(existing.role, 'member');
    const patch: Partial<WorkspaceMember> = {
      displayName: optionalString(body.displayName, 'displayName') ?? existing.displayName ?? null,
      email,
      role,
    };
    const member = await ctx.membersTable.update(existing.id, patch);
    await recordWorkspaceAudit(
      db,
      ctx.workspace,
      actorId,
      previousRole === role ? 'workspace_member.update' : 'workspace_member.role_update',
      'workspace_member',
      member.id,
      {
        userId: member.userId,
        email: normalizeEmail(member.email),
        fromRole: previousRole,
        toRole: member.role,
        source: 'inviteMember',
      },
    );
    await emitMembershipNotification(db, ctx.workspace, member, actorId, 'role_update');
    const members = sortMembers([
      ...ctx.members.filter((item) => item.id !== member.id),
      member,
    ]);
    return {
      workspace: ctx.workspace,
      currentMember: ctx.currentMember,
      member,
      members,
      invitations: ctx.invitations,
    };
  }

  if (!userId) {
    if (!email) throw new Error('Email is required.');
    // The email matched no existing member and no existing server account.
    // Report success without creating anything, so the caller cannot tell a
    // real account apart from a typo (blind share).
    return {
      workspace: ctx.workspace,
      currentMember: ctx.currentMember,
      members: ctx.members,
      invitations: ctx.invitations,
    };
  }

  const patch: Partial<WorkspaceMember> = {
    displayName: optionalString(body.displayName, 'displayName'),
    email,
    role,
  };
  await assertOrganizationMemberCanJoinWorkspace(db, ctx.workspace, userId);
  await assertOrganizationInviteAllowed(
    db,
    ctx.workspace,
    email ?? normalizeEmail(existing?.email),
    role,
  );
  const previousRole = existing ? parseMemberRole(existing.role, 'member') : null;
  const member = existing
    ? await ctx.membersTable.update(existing.id, patch)
    : await ctx.membersTable.insert({
        workspaceId: ctx.workspace.id,
        userId,
        createdBy: actorId,
        ...patch,
      });
  await upsertOrganizationMemberForWorkspaceMember(db, ctx.workspace, member, actorId);
  await recordWorkspaceAudit(
    db,
    ctx.workspace,
    actorId,
    existing
      ? previousRole === role
        ? 'workspace_member.update'
        : 'workspace_member.role_update'
      : 'workspace_member.add',
    'workspace_member',
    member.id,
    {
      userId: member.userId,
      email: normalizeEmail(member.email),
      fromRole: previousRole,
      toRole: member.role,
      source: 'inviteMember',
    },
  );
  await emitMembershipNotification(db, ctx.workspace, member, actorId, existing ? 'role_update' : 'invite');
  const members = sortMembers([
    ...ctx.members.filter((item) => item.id !== member.id),
    member,
  ]);
  return {
    workspace: ctx.workspace,
    currentMember: ctx.currentMember,
    member,
    members,
    invitations: ctx.invitations,
  };
}

async function updateMemberRole(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const workspaceId = requireString(body.workspaceId ?? body.id, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  const memberId = typeof body.memberId === 'string' && body.memberId.trim() ? body.memberId.trim() : null;
  const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null;
  const current = memberId
    ? ctx.members.find((member) => member.id === memberId)
    : ctx.members.find((member) => member.userId === userId);
  if (!current) throw new Error('Workspace member was not found.');
  const role = parseMemberRole(body.role, parseMemberRole(current.role, 'member'));
  assertCanManageRole(ctx.currentRole, current, role, actorId, ctx.workspace);
  await assertOrganizationMemberCanJoinWorkspace(db, ctx.workspace, current.userId);
  const previousRole = parseMemberRole(current.role, 'member');
  if (previousRole === role) {
    return {
      workspace: ctx.workspace,
      currentMember: ctx.currentMember,
      member: current,
      members: ctx.members,
      invitations: ctx.invitations,
    };
  }
  await assertOrganizationInviteAllowed(
    db,
    ctx.workspace,
    normalizeEmail(current.email),
    role,
  );
  const member = await ctx.membersTable.update(current.id, { role });
  await upsertOrganizationMemberForWorkspaceMember(db, ctx.workspace, member, actorId);
  await recordWorkspaceAudit(
    db,
    ctx.workspace,
    actorId,
    'workspace_member.role_update',
    'workspace_member',
    member.id,
    {
      userId: member.userId,
      email: normalizeEmail(member.email),
      fromRole: previousRole,
      toRole: member.role,
    },
  );
  await emitMembershipNotification(db, ctx.workspace, member, actorId, 'role_update');
  const members = sortMembers([
    ...ctx.members.filter((item) => item.id !== member.id),
    member,
  ]);
  return {
    workspace: ctx.workspace,
    currentMember: ctx.currentMember,
    member,
    members,
    invitations: ctx.invitations,
  };
}

async function removeMember(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const workspaceId = requireString(body.workspaceId ?? body.id, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  const memberId = typeof body.memberId === 'string' && body.memberId.trim() ? body.memberId.trim() : null;
  const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null;
  const current = memberId
    ? ctx.members.find((member) => member.id === memberId)
    : ctx.members.find((member) => member.userId === userId);
  if (!current) throw new Error('Workspace member was not found.');
  assertCanRemoveMember(ctx.currentRole, current, actorId, ctx.workspace);
  // Revocation must fail loudly (cf. share-mutation removePermission): a
  // swallowed delete would return 200 with the member filtered out of the
  // response while the workspace_members row — and thus their access — survives.
  await ctx.membersTable.delete(current.id);
  await recordWorkspaceAudit(
    db,
    ctx.workspace,
    actorId,
    'workspace_member.remove',
    'workspace_member',
    current.id,
    {
      userId: current.userId,
      email: normalizeEmail(current.email),
      role: parseMemberRole(current.role, 'member'),
    },
  );
  return {
    workspace: ctx.workspace,
    currentMember: ctx.currentMember,
    deletedId: current.id,
    members: ctx.members.filter((member) => member.id !== current.id),
    invitations: ctx.invitations,
  };
}

async function recordMcpClientAction(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  request?: Request,
) {
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  const client = parseMcpClientMetadata(body, request);
  const backendPath = optionalClientAuditString(body.backendPath, 'backendPath', 120);
  const backendAction = optionalClientAuditString(body.backendAction, 'backendAction', 120);
  const method = optionalClientAuditString(body.method, 'method', 12);
  const targetType = optionalClientAuditString(body.targetType, 'targetType', 80) ?? 'backend_request';
  const targetId = optionalClientAuditString(body.targetId, 'targetId', 160) ?? backendAction ?? backendPath ?? 'request';
  const occurredAt = nowIso();

  await recordWorkspaceAudit(
    db,
    ctx.workspace,
    actorId,
    'mcp.client_action',
    targetType,
    targetId,
    {
      clientSource: client.source,
      clientId: client.clientId,
      clientName: client.clientName,
      readOnly: client.readOnly,
      subjectType: client.subjectType,
      subjectId: client.subjectId,
      policyIssuer: client.policyIssuer,
      policyAudience: client.policyAudience,
      transport: client.transport,
      provisioningId: client.provisioningId,
      backendPath,
      backendAction,
      method,
    },
    occurredAt,
  );

  return {
    ok: true,
    workspaceId: ctx.workspace.id,
    action: 'mcp.client_action',
    occurredAt,
  };
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request, storage } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const db = admin.db('app');

  try {
    switch (action) {
      case 'list':
      case 'workspaces':
        return await listWorkspaces(db, admin, auth.id, normalizeEmail(auth.email));
      case 'listOrganizations':
      case 'organizations':
        return { organizations: await listAccessibleOrganizations(db, auth.id) };
      case 'organizationDirectory':
      case 'getOrganization':
        return await organizationDirectory(
          db,
          requireString(body.organizationId, 'organizationId'),
          auth.id,
          body,
        );
      case 'searchOrganizationPeople':
      case 'searchPeople':
        return await searchOrganizationPeople(
          db,
          requireString(body.organizationId, 'organizationId'),
          auth.id,
          body,
        );
      case 'updateOrganizationSettings':
        return await withPolicyVersionBump(db, body, () => updateOrganizationSettings(db, body, auth.id));
      case 'updateOrganizationEnterpriseControls':
        return await withPolicyVersionBump(db, body, () => updateOrganizationEnterpriseControls(db, body, auth.id));
      case 'createOrganizationScimToken':
        return await createOrganizationScimToken(db, body, auth.id);
      case 'revokeOrganizationScimToken':
        return await revokeOrganizationScimToken(db, body, auth.id);
      case 'createOrganizationLegalHold':
        return await withPolicyVersionBump(db, body, () => createOrganizationLegalHold(db, body, auth.id));
      case 'releaseOrganizationLegalHold':
        return await withPolicyVersionBump(db, body, () => releaseOrganizationLegalHold(db, body, auth.id));
      case 'exportOrganizationAuditEvents':
        return await exportOrganizationAuditEvents(db, body, auth.id);
      case 'upsertOrganizationBillingRecord':
        return await upsertOrganizationBillingRecord(db, body, auth.id);
      case 'deleteOrganizationBillingRecord':
        return await deleteOrganizationBillingRecord(db, body, auth.id);
      case 'transferOrganizationOwner':
        return await transferOrganizationOwner(db, body, auth.id);
      case 'updateOrganizationMemberRole':
        return await updateOrganizationMemberRole(db, body, auth.id);
      case 'deactivateOrganizationMember':
        return await withPolicyVersionBump(db, body, () => deactivateOrganizationMember(db, body, auth.id));
      case 'reactivateOrganizationMember':
        return await withPolicyVersionBump(db, body, () => reactivateOrganizationMember(db, body, auth.id));
      case 'removeOrganizationMember':
        return await withPolicyVersionBump(db, body, () => removeOrganizationMember(db, admin, body, auth.id));
      case 'createOrganizationGroup':
        return await createOrganizationGroup(db, body, auth.id);
      case 'updateOrganizationGroup':
        return await updateOrganizationGroup(db, body, auth.id);
      case 'deleteOrganizationGroup':
        return await deleteOrganizationGroup(db, body, auth.id);
      case 'addOrganizationGroupMember':
        return await addOrganizationGroupMember(db, body, auth.id);
      case 'removeOrganizationGroupMember':
        return await removeOrganizationGroupMember(db, body, auth.id);
      case 'addOrganizationDomain':
        return await addOrganizationDomain(db, body, auth.id);
      case 'verifyOrganizationDomain':
        return await verifyOrganizationDomain(db, body, auth.id);
      case 'removeOrganizationDomain':
        return await removeOrganizationDomain(db, body, auth.id);
      case 'create':
      case 'createWorkspace':
        return await createWorkspace(
          db,
          admin,
          body,
          auth.id,
          normalizeEmail(auth.email),
          defaultWorkspaceLocale(request?.headers.get('Accept-Language')),
          request,
        );
      case 'get':
      case 'members':
        return await getMembers(db, body, auth.id, normalizeEmail(auth.email));
      case 'update':
        return await updateWorkspace(db, body, auth.id, request);
      case 'transferWorkspaceOwner':
        return await transferWorkspaceOwner(db, body, auth.id);
      case 'delete':
      case 'deleteWorkspace':
        return await deleteWorkspace(db, admin, body, auth.id, normalizeEmail(auth.email), storage, request);
      case 'updateMyProfile':
        return await updateMyProfile(db, body, auth.id, request);
      case 'inviteMember':
      case 'addMember':
        return await inviteMember(db, body, auth.id, admin.auth);
      case 'updateMemberRole':
        return await updateMemberRole(db, body, auth.id);
      case 'removeMember':
        return await removeMember(db, body, auth.id);
      case 'recordMcpClientAction':
        return await recordMcpClientAction(db, body, auth.id, request);
      default:
        return jsonError(400, 'Unknown workspace mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 409, needles: ['already in use'] },
      { status: 404, needles: ['not found'] },
      { status: 400, needles: ['Disable domain-restricted signup'] },
      {
        status: 403,
        needles: ['access required', 'Forbidden', 'can create workspaces', 'disabled by organization policy'],
      },
    ]);
    return jsonError(status, message);
  }
});
