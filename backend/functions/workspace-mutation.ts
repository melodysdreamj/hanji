import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { hanjiEnvValue, hanjiHeader } from '../lib/hanji-compat';
import {
  assertNoActiveLegalHoldForPermanentDelete,
  assertValidMcpGovernancePolicy,
  auditRetentionScalarPatch,
} from '../lib/enterprise-controls';
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
import {
  handleTeamspaceMutation,
  TEAMSPACE_MUTATION_ACTIONS,
} from '../lib/teamspace-mutation';
import { defaultWorkspaceLocale, seedDefaultWorkspacePages } from '../lib/default-workspace-pages';
import { deleteStoredUploadsBeforeMetadata } from '../lib/permanent-file-delete';
import { upsertNotification as upsertBoundedNotification } from '../lib/notifications';
import { domainVerificationRecord, verifyDomainTxtRecord } from '../lib/domain-verification';
import {
  fileOperationConflict,
  markFileDeletionPending,
  withFileWorkspaceLease,
  type FileWorkspaceLeaseGuard,
} from '../lib/file-operation-lock';
import {
  getInstanceSettings,
  parseMemberAddPolicy,
  parseSignupPolicy,
  upsertInstanceSettings,
  type InstanceSettings,
} from '../lib/instance-settings';

import {
  bestEffort,
  listAll,
  requireString,
  getExisting,
  isTransactionConflictError,
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
  governanceVersion?: number | null;
  ssoEnforcementEpoch?: number | null;
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
  ssoEnforcementEpoch?: number | null;
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
  verificationMethod?: string | null;
  verificationToken?: string | null;
  verificationCheckedAt?: string | null;
  verificationError?: string | null;
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
  auditRetentionDays?: number | null;
  auditRetentionPolicyValid?: boolean | null;
  auditRetentionPolicyError?: string | null;
  dataResidencyPolicy?: Record<string, unknown> | null;
  dlpPolicy?: Record<string, unknown> | null;
  legalPolicy?: Record<string, unknown> | null;
  billingProfile?: Record<string, unknown> | null;
  mcpGovernancePolicy?: Record<string, unknown> | null;
  version?: number | null;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationSsoTransition {
  id: string;
  organizationId: string;
  pendingOrganizationId?: string | null;
  actorId: string;
  controlsId: string;
  controlsVersion: number;
  controlsVersionWasMissing: boolean;
  requestHash: string;
  mutationId: string;
  desiredPatch: Partial<OrganizationEnterpriseControls>;
  desiredMetadata: Record<string, unknown>;
  previousEpoch: number;
  previousEpochWasMissing: boolean;
  desiredEpoch: number;
  status: 'pending' | 'active' | 'superseded';
  version: number;
  scanGeneration: number;
  scanPage: number;
  passDiscovered: number;
  passIncomplete: number;
  stablePasses: number;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  activatedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationSsoRevocationReceipt {
  id: string;
  organizationId: string;
  transitionId: string;
  organizationMemberId: string;
  userId: string;
  scanGeneration: number;
  status: 'pending' | 'complete' | 'superseded';
  attemptCount: number;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationPolicyVersion {
  id: string;
  organizationId: string;
  version?: number | null;
}

interface OrganizationApprovedMcpClient {
  clientId: string;
  name: string;
  approvedAt: string;
  approvedBy: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

interface OrganizationMcpWorkspacePolicy {
  workspaceId: string;
  enabled: boolean;
  approvedClients: OrganizationApprovedMcpClient[];
  updatedAt?: string | null;
  updatedBy?: string | null;
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

interface OrganizationDiscoveryExport {
  id: string;
  organizationId: string;
  status?: string;
  format?: string;
  filter?: Record<string, unknown> | null;
  itemCount?: number;
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

interface WorkspaceOnboarding {
  id: string;
  workspaceId: string;
  notionImportState?: string;
  notionImportPresentedAt?: string | null;
  notionImportPresentedBy?: string | null;
  notionImportSuppressedAt?: string | null;
  notionImportSuppressedBy?: string | null;
}

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  kind?: string;
  title?: string | null;
  icon?: string | null;
  iconType?: string | null;
  inTrash?: boolean;
  createdBy?: string | null;
  lastEditedBy?: string | null;
  properties?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

interface Block {
  id: string;
  pageId: string;
  createdBy?: string | null;
  content?: Record<string, unknown> | null;
  plainText?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface Comment {
  id: string;
  pageId: string;
  authorId: string;
  body?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface FileUpload {
  id: string;
  workspaceId: string;
  bucket?: string | null;
  key?: string | null;
  status?: string | null;
  createdBy?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  pageId?: string | null;
  databaseId?: string | null;
  createdAt?: string;
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

interface FormLink {
  id: string;
  databaseId: string;
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
  status?: string;
  progress?: { currentStatus?: unknown } | null;
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
  revokeAllSessions?(userId: string): Promise<void>;
}

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  email?: EmailSender;
  storage?: FunctionStorageProxy;
  env?: Record<string, unknown>;
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
  const providerType = parseEnum(input.providerType, ['saml', 'oidc'], 'saml', 'ssoConfig.providerType');
  const providerName = boundedText(input.providerName, 'ssoConfig.providerName', 120)
    ?? (providerType === 'oidc' ? 'oidc:enterprise' : null);
  const issuer = boundedText(input.issuer, 'ssoConfig.issuer', 500);
  const enabled = optionalBoolean(input.enabled);
  if (enabled === true) {
    if (providerType !== 'oidc') {
      throw new Error('Live SSO enforcement currently requires an OIDC provider.');
    }
    if (!providerName || !/^oidc:[A-Za-z0-9._-]+$/.test(providerName)) {
      throw new Error('ssoConfig.providerName must use the oidc:name format.');
    }
    if (!issuer || !/^https:\/\//i.test(issuer)) {
      throw new Error('ssoConfig.issuer must be an HTTPS URL before enabling SSO.');
    }
  }
  return stripNullish({
    enabled,
    providerType,
    providerName,
    enforcement: parseEnum(
      input.enforcement,
      ['optional', 'required_for_verified_domains', 'required_for_all_members'],
      'optional',
      'ssoConfig.enforcement',
    ),
    loginUrl: boundedText(input.loginUrl, 'ssoConfig.loginUrl', 500),
    entityId: boundedText(input.entityId, 'ssoConfig.entityId', 500),
    issuer,
    metadataUrl: boundedText(input.metadataUrl, 'ssoConfig.metadataUrl', 500),
    certificateFingerprint: boundedText(input.certificateFingerprint, 'ssoConfig.certificateFingerprint', 200),
    clientId: boundedText(input.clientId, 'ssoConfig.clientId', 300),
    jwksUrl: boundedText(input.jwksUrl, 'ssoConfig.jwksUrl', 500),
    scopes: stringList(input.scopes, 'ssoConfig.scopes', 20, 80),
    attributeMapping: optionalRecord(input.attributeMapping, 'ssoConfig.attributeMapping'),
  });
}

function assertSsoRuntimeConfigured(
  config: Record<string, unknown>,
  env?: Record<string, unknown>,
) {
  if (config.enabled !== true) return;
  const providerName = typeof config.providerName === 'string' ? config.providerName : '';
  const prefix = providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const configuredProviders = (
    hanjiEnvValue(env, 'HANJI_AUTH_OAUTH_PROVIDERS', 'EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS') ?? ''
  ).split(',').map((provider) => provider.trim()).filter(Boolean);
  const clientId = hanjiEnvValue(
    env,
    `HANJI_OAUTH_${prefix}_CLIENT_ID`,
    `EDGEBASE_OAUTH_${prefix}_CLIENT_ID`,
    `${prefix}_CLIENT_ID`,
  );
  const clientSecret = hanjiEnvValue(
    env,
    `HANJI_OAUTH_${prefix}_CLIENT_SECRET`,
    `EDGEBASE_OAUTH_${prefix}_CLIENT_SECRET`,
    `${prefix}_CLIENT_SECRET`,
  );
  const issuer = hanjiEnvValue(
    env,
    `HANJI_OAUTH_${prefix}_ISSUER`,
    `EDGEBASE_OAUTH_${prefix}_ISSUER`,
    `${prefix}_ISSUER`,
  );
  if (!configuredProviders.includes(providerName) || !clientId || !clientSecret || !issuer) {
    throw new Error(
      `SSO runtime provider ${providerName} is not configured. Add it to HANJI_AUTH_OAUTH_PROVIDERS and configure its client ID, client secret, and issuer environment values.`,
    );
  }
  if (typeof config.issuer === 'string' && config.issuer !== issuer) {
    throw new Error('The saved SSO issuer must match the runtime OIDC issuer.');
  }
  if (typeof config.clientId === 'string' && config.clientId && config.clientId !== clientId) {
    throw new Error('The saved SSO client ID must match the runtime OIDC client ID.');
  }
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

function sanitizeDataResidencyPolicy(
  value: unknown,
  env?: Record<string, unknown>,
) {
  const input = optionalRecord(value, 'dataResidencyPolicy');
  const primaryRegion = parseEnum(
    input.primaryRegion,
    ['global', 'us', 'eu', 'kr', 'apac'],
    'global',
    'dataResidencyPolicy.primaryRegion',
  );
  const enforcementMode = parseEnum(
    input.enforcementMode,
    ['metadata_only', 'strict'],
    'metadata_only',
    'dataResidencyPolicy.enforcementMode',
  );
  const databaseRegion = hanjiEnvValue(env, 'HANJI_DATA_REGION', 'EDGEBASE_DATA_REGION')?.toLowerCase();
  const storageRegion = hanjiEnvValue(env, 'HANJI_STORAGE_REGION', 'EDGEBASE_STORAGE_REGION')?.toLowerCase();
  if (enforcementMode === 'strict') {
    if (primaryRegion === 'global') {
      throw new Error('Strict data residency requires a non-global primary region.');
    }
    if (databaseRegion !== primaryRegion || storageRegion !== primaryRegion) {
      throw new Error(
        `Strict data residency requires HANJI_DATA_REGION and HANJI_STORAGE_REGION to both be ${primaryRegion}.`,
      );
    }
  }
  return stripNullish({
    primaryRegion,
    allowedRegions: stringList(input.allowedRegions, 'dataResidencyPolicy.allowedRegions', 10, 40),
    enforcementMode,
    attestationStatus: enforcementMode === 'strict' ? 'operator_attested' : 'not_required',
    attestedDatabaseRegion: databaseRegion ?? null,
    attestedStorageRegion: storageRegion ?? null,
    attestedAt: enforcementMode === 'strict' ? nowIso() : null,
    notes: boundedText(input.notes, 'dataResidencyPolicy.notes', 500),
  });
}

function sanitizeDlpPolicy(value: unknown) {
  const input = optionalRecord(value, 'dlpPolicy');
  return stripNullish({
    enabled: optionalBoolean(input.enabled),
    contentScanMode: parseEnum(
      input.contentScanMode,
      ['off', 'block'],
      'block',
      'dlpPolicy.contentScanMode',
    ),
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
  await db.table<OrganizationAuditEvent>('organization_audit_events').insert(event);
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
    id: organizationId,
    organizationId,
    ssoConfig: { enabled: false, providerType: 'saml', enforcement: 'optional' },
    scimConfig: { enabled: false, provisioningMode: 'manual', deprovisionAction: 'deactivate' },
    auditPolicy: { retentionDays: 365, exportFormat: 'jsonl' },
    auditRetentionDays: 365,
    auditRetentionPolicyValid: true,
    dataResidencyPolicy: { primaryRegion: 'global', allowedRegions: ['global'], enforcementMode: 'metadata_only' },
    dlpPolicy: {
      enabled: false,
      contentScanMode: 'block',
      blockPublicSharing: false,
      blockExternalSharing: false,
      blockFileDownloads: false,
      blockExports: false,
      sensitiveTerms: [],
    },
    legalPolicy: { defaultHoldScope: 'organization', requireReason: true },
    billingProfile: { contractStatus: 'draft' },
    mcpGovernancePolicy: { workspacePolicies: [] },
    version: 0,
  };
}

function uniqueEnterpriseControls(records: OrganizationEnterpriseControls[]) {
  if (records.length > 1) {
    throw Object.assign(
      new Error('Organization enterprise controls are not uniquely configured.'),
      { status: 409 },
    );
  }
  return records[0] ?? null;
}

async function enterpriseControlsForOrganization(db: DbRef, organizationId: string) {
  const table = db.table<OrganizationEnterpriseControls>('organization_enterprise_controls');
  const existing = uniqueEnterpriseControls(await listAll(
    table.where(
      'organizationId',
      '==',
      organizationId,
    ),
  ));
  if (existing) return existing;

  try {
    await db.transact([
      {
        table: 'organization_enterprise_controls',
        op: 'expect',
        where: [['organizationId', '==', organizationId]],
        exists: false,
      },
      {
        table: 'organization_enterprise_controls',
        op: 'insert',
        data: defaultEnterpriseControls(organizationId) as Record<string, unknown>,
      },
    ]);
  } catch (error) {
    if (!isTransactionConflictError(error)) throw error;
  }

  const created = uniqueEnterpriseControls(await listAll(
    table.where('organizationId', '==', organizationId),
  ));
  if (!created) throw new Error('Organization enterprise controls could not be initialized.');
  return created;
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
    enterpriseSsoTransition,
    scimTokens,
    legalHolds,
    auditExports,
    discoveryExports,
    billingRecords,
  ] = await Promise.all([
    enterpriseControlsForOrganization(db, organizationId),
    canSecurity
      ? latestSsoTransition(db, organizationId)
      : Promise.resolve(null),
    canSecurity
      ? listAll(db.table<OrganizationScimToken>('organization_scim_tokens').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
    canSecurity
      ? listAll(db.table<OrganizationLegalHold>('organization_legal_holds').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
    canAudit
      ? listAll(db.table<OrganizationAuditExport>('organization_audit_exports').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
    canSecurity
      ? listAll(db.table<OrganizationDiscoveryExport>('organization_discovery_exports').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
    canBilling
      ? listAll(db.table<OrganizationBillingRecord>('organization_billing_records').where('organizationId', '==', organizationId))
      : Promise.resolve([]),
  ]);
  return {
    enterpriseControls,
    enterpriseSsoTransition: transitionPublicState(enterpriseSsoTransition),
    organizationScimTokens: sortOrganizationScimTokens(scimTokens).map(redactScimToken),
    organizationLegalHolds: sortOrganizationLegalHolds(legalHolds),
    organizationAuditExports: sortOrganizationAuditExports(auditExports).slice(0, 20),
    organizationDiscoveryExports: discoveryExports
      .slice()
      .sort((a, b) => String(b.completedAt ?? b.createdAt ?? '').localeCompare(String(a.completedAt ?? a.createdAt ?? '')))
      .slice(0, 20)
      .map(redactDiscoveryExport),
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
  ).map((domain) => domain.verificationToken
    ? { ...domain, ...domainVerificationRecord(domain.domain, domain.verificationToken) }
    : domain);
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
  assertSsoEpochAuthorized(
    organization,
    currentOrganizationMember,
    enterpriseDirectory.enterpriseControls,
    new Set(
      organizationDomains
        .filter((domain) => (domain.status ?? 'pending') === 'verified')
        .map((domain) => normalizeOrganizationDomain(domain.domain))
        .filter((domain): domain is string => !!domain),
    ),
  );
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

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableJsonValue((value as Record<string, unknown>)[key])]),
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(stableJsonValue(value));
}

function sameStableValue(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

async function deterministicUuid(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function organizationApprovedMcpClients(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((value): OrganizationApprovedMcpClient[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.clientId !== 'string' || !record.clientId) return [];
    return [{
      ...record,
      clientId: record.clientId,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : record.clientId,
      approvedAt: typeof record.approvedAt === 'string' ? record.approvedAt : '',
      approvedBy: typeof record.approvedBy === 'string' ? record.approvedBy : '',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : null,
    }];
  });
}

function organizationMcpWorkspacePolicies(controls: OrganizationEnterpriseControls) {
  const policy = controls.mcpGovernancePolicy;
  if (!policy || !Array.isArray(policy.workspacePolicies)) return [];
  return policy.workspacePolicies.flatMap((value): OrganizationMcpWorkspacePolicy[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.workspaceId !== 'string' || !record.workspaceId) return [];
    return [{
      ...record,
      workspaceId: record.workspaceId,
      enabled: record.enabled === true,
      approvedClients: organizationApprovedMcpClients(record.approvedClients),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : null,
    }];
  });
}

function requiredMcpClientId(body: Record<string, unknown>) {
  const clientId = requireString(body.clientId ?? body.client_id, 'clientId').trim();
  if (clientId.length > 500) throw new Error('clientId must be at most 500 characters.');
  if (/\s/.test(clientId)) throw new Error('clientId must not contain whitespace.');
  return clientId;
}

async function organizationPolicyVersionForGovernance(db: DbRef, organizationId: string) {
  const rows = await listAll(
    db.table<OrganizationPolicyVersion>('organization_policy_versions')
      .where('organizationId', '==', organizationId),
  );
  if (rows.length > 1) {
    throw Object.assign(
      new Error('Organization policy version is not uniquely configured.'),
      { status: 409 },
    );
  }
  const current = rows[0] ?? null;
  if (
    current?.version !== null
    && current?.version !== undefined
    && (!Number.isSafeInteger(current.version) || current.version < 0)
  ) {
    throw Object.assign(new Error('Organization policy version is malformed.'), { status: 409 });
  }
  return current;
}

async function governancePolicyVersionPlan(db: DbRef, organizationId: string) {
  const current = await organizationPolicyVersionForGovernance(db, organizationId);
  const currentVersion = current?.version ?? 0;
  return {
    guard: current
      ? {
          table: 'organization_policy_versions',
          op: 'expect',
          id: current.id,
          where: [
            ['organizationId', '==', organizationId],
            ['version', '==', current.version ?? null],
          ],
          exists: true,
        } satisfies TransactOperation
      : {
          table: 'organization_policy_versions',
          op: 'expect',
          id: organizationId,
          where: [['organizationId', '==', organizationId]],
          exists: false,
        } satisfies TransactOperation,
    write: current
      ? {
          table: 'organization_policy_versions',
          op: 'update',
          id: current.id,
          data: { version: currentVersion + 1 },
        } satisfies TransactOperation
      : {
          table: 'organization_policy_versions',
          op: 'insert',
          data: { id: organizationId, organizationId, version: 1 },
        } satisfies TransactOperation,
    nextVersion: currentVersion + 1,
  };
}

function governanceControlsVersion(controls: OrganizationEnterpriseControls) {
  if (controls.version === null || controls.version === undefined) {
    return { expected: null, value: 0 } as const;
  }
  if (!Number.isSafeInteger(controls.version) || controls.version < 0) {
    throw Object.assign(new Error('Organization enterprise controls version is malformed.'), { status: 409 });
  }
  return { expected: controls.version, value: controls.version } as const;
}

function governanceOrganizationFence(organization: Organization) {
  const hasVersion = Number.isSafeInteger(organization.governanceVersion)
    && Number(organization.governanceVersion) >= 0;
  if (
    !hasVersion
    && organization.governanceVersion !== null
    && organization.governanceVersion !== undefined
  ) {
    throw Object.assign(new Error('Organization governance version is malformed.'), { status: 409 });
  }
  const version = hasVersion ? Number(organization.governanceVersion) : 0;
  return {
    guard: {
      table: 'organizations',
      op: 'expect',
      id: organization.id,
      where: [['governanceVersion', '==', hasVersion ? version : null]],
      exists: true,
    } satisfies TransactOperation,
    write: {
      table: 'organizations',
      op: 'update',
      id: organization.id,
      data: { governanceVersion: version + 1 },
    } satisfies TransactOperation,
    nextVersion: version + 1,
  };
}

type GovernanceActorGuard = Extract<TransactOperation, { op: 'expect' }>;

interface GovernanceMutationReceipt {
  id: string;
  requestHash: string;
  mutationId: string;
  existing: OrganizationAuditEvent | null;
}

async function governanceMutationReceipt(
  db: DbRef,
  body: Record<string, unknown>,
  organizationId: string,
  actorId: string,
  action: string,
  request: unknown,
): Promise<GovernanceMutationReceipt> {
  const requestHash = await sha256Hex(stableJson(request));
  const supplied = optionalString(body.mutationId, 'mutationId');
  if (supplied && supplied.length > 200) throw new Error('mutationId must be at most 200 characters.');
  const mutationId = supplied ?? `content:${requestHash}`;
  const id = await deterministicUuid(
    `${organizationId}|${actorId}|${action}|${mutationId}`,
  );
  const existing = await getExisting(
    db.table<OrganizationAuditEvent>('organization_audit_events'),
    id,
  );
  if (existing) {
    const metadata = existing.metadata ?? {};
    if (
      existing.organizationId !== organizationId
      || existing.actorId !== actorId
      || existing.action !== action
      || metadata.governanceMutationId !== mutationId
      || metadata.requestHash !== requestHash
    ) {
      throw Object.assign(new Error('mutationId was already used with a different governance request.'), { status: 409 });
    }
  }
  return { id, requestHash, mutationId, existing };
}

function governanceReceiptMetadata(
  receipt: GovernanceMutationReceipt,
  metadata: Record<string, unknown>,
) {
  return {
    ...metadata,
    governanceMutationId: receipt.mutationId,
    requestHash: receipt.requestHash,
  };
}

function governanceActorGuard(
  ctx: Awaited<ReturnType<typeof organizationAdminContext>>,
  organizationId: string,
  actorId: string,
): GovernanceActorGuard {
  if (ctx.organization.ownerId === actorId) {
    return {
      table: 'organizations',
      op: 'expect',
      id: organizationId,
      where: [['ownerId', '==', actorId]],
      exists: true,
    };
  }
  const member = ctx.currentOrganizationMember;
  if (!member) throw new Error('Organization security admin access required.');
  return {
    table: 'organization_members',
    op: 'expect',
    id: member.id,
    where: [
      ['organizationId', '==', organizationId],
      ['userId', '==', actorId],
      ['role', '==', ctx.actorRole],
      ['status', '==', member.status ?? null],
    ],
    exists: true,
  };
}

async function governanceActorGuardIsCurrent(db: DbRef, guard: GovernanceActorGuard) {
  if (!guard.id) return false;
  const row = await getExisting(db.table<Record<string, unknown>>(guard.table), guard.id);
  if (!row) return false;
  return (guard.where ?? []).every(([field, , expected]) => {
    const actual = row[field];
    return expected === null
      ? actual === null || actual === undefined
      : actual === expected;
  });
}

async function throwGovernanceTransactionConflict(
  db: DbRef,
  error: unknown,
  actorGuard: GovernanceActorGuard,
  actorAccessMessage: string,
  targetConflictMessage: string,
): Promise<never> {
  if (!isTransactionConflictError(error)) throw error;
  if (!(await governanceActorGuardIsCurrent(db, actorGuard))) {
    throw Object.assign(new Error(actorAccessMessage), { status: 403 });
  }
  throw Object.assign(new Error(targetConflictMessage), { status: 409 });
}

const SSO_REQUIRED_MESSAGE =
  'Your organization requires single sign-on. Continue with the organization SSO provider.';
const SSO_REVOCATION_PAGE_SIZE = 100;
const SSO_REVOCATION_CONCURRENCY = 6;
const SSO_TRANSITION_LEASE_MS = 15 * 60 * 1_000;

function requiredSsoConfig(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  if (config.enabled !== true || config.enforcement === 'optional') return null;
  return config;
}

function ssoEpoch(value: unknown, field: string) {
  if (value === null || value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw Object.assign(new Error(`${field} is malformed.`), { status: 409 });
  }
  return Number(value);
}

function memberMatchesRequiredSso(
  config: Record<string, unknown>,
  member: OrganizationMember,
  verifiedDomains: Set<string>,
) {
  if ((member.status ?? 'active') !== 'active' || member.role === 'guest' || !member.userId) {
    return false;
  }
  if (config.enforcement === 'required_for_all_members') return true;
  if (config.enforcement !== 'required_for_verified_domains') return false;
  const email = normalizeEmail(member.email);
  return !!email && verifiedDomains.has(email.slice(email.lastIndexOf('@') + 1));
}

async function verifiedSsoDomains(db: DbRef, organizationId: string) {
  const domains = await listAll(
    db.table<OrganizationDomain>('organization_domains').where('organizationId', '==', organizationId),
  );
  return new Set(
    domains
      .filter((domain) => (domain.status ?? 'pending') === 'verified')
      .map((domain) => normalizeOrganizationDomain(domain.domain))
      .filter((domain): domain is string => !!domain),
  );
}

function transitionPublicState(transition: OrganizationSsoTransition | null) {
  if (!transition) return null;
  return {
    id: transition.id,
    status: transition.status,
    desiredEpoch: transition.desiredEpoch,
    scanGeneration: transition.scanGeneration,
    scanPage: transition.scanPage,
    passDiscovered: transition.passDiscovered,
    passIncomplete: transition.passIncomplete,
    stablePasses: transition.stablePasses,
    lastError: transition.lastError ?? null,
    lastErrorAt: transition.lastErrorAt ?? null,
    activatedAt: transition.activatedAt ?? null,
  };
}

async function latestSsoTransition(db: DbRef, organizationId: string) {
  const rows = await listAll(
    db.table<OrganizationSsoTransition>('organization_sso_transitions')
      .where('organizationId', '==', organizationId),
    { maxItems: 1_000, pageSize: 100, label: 'Organization SSO transitions' },
  );
  return rows
    .slice()
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0]
    ?? null;
}

function assertSsoEpochAuthorized(
  organization: Organization,
  member: OrganizationMember,
  controls: OrganizationEnterpriseControls,
  verifiedDomains: Set<string>,
) {
  const config = requiredSsoConfig(controls.ssoConfig);
  if (!config || !memberMatchesRequiredSso(config, member, verifiedDomains)) return;
  const effectiveEpoch = ssoEpoch(
    organization.ssoEnforcementEpoch,
    'Organization SSO enforcement epoch',
  );
  if (
    effectiveEpoch > 0
    && ssoEpoch(member.ssoEnforcementEpoch, 'Organization member SSO enforcement epoch')
      === effectiveEpoch
  ) return;
  throw Object.assign(new Error(SSO_REQUIRED_MESSAGE), { status: 403 });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index]);
    }
  });
  await Promise.all(lanes);
  return output;
}

async function createOrReadSsoReceipt(
  db: DbRef,
  transition: OrganizationSsoTransition,
  member: OrganizationMember,
) {
  const id = await deterministicUuid(`${transition.id}|member|${member.id}`);
  let existing = await getExisting(
    db.table<OrganizationSsoRevocationReceipt>('organization_sso_revocation_receipts'),
    id,
  );
  let created = false;
  if (!existing) {
    const now = nowIso();
    try {
      await db.transact([
        {
          table: 'organization_sso_revocation_receipts',
          op: 'expect',
          id,
          exists: false,
        },
        {
          table: 'organization_sso_revocation_receipts',
          op: 'insert',
          data: {
            id,
            organizationId: transition.organizationId,
            transitionId: transition.id,
            organizationMemberId: member.id,
            userId: member.userId,
            scanGeneration: transition.scanGeneration,
            status: 'pending',
            attemptCount: 0,
            lastAttemptAt: null,
            lastError: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ]);
      created = true;
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
    }
    existing = await getExisting(
      db.table<OrganizationSsoRevocationReceipt>('organization_sso_revocation_receipts'),
      id,
    );
  }
  if (
    !existing
    || existing.organizationId !== transition.organizationId
    || existing.transitionId !== transition.id
    || existing.organizationMemberId !== member.id
    || existing.userId !== member.userId
  ) {
    throw Object.assign(new Error('Organization SSO revocation receipt is inconsistent.'), { status: 409 });
  }
  return { receipt: existing, created };
}

async function revokeMemberForSsoTransition(
  db: DbRef,
  authAdmin: AuthAdminRef,
  transition: OrganizationSsoTransition,
  member: OrganizationMember,
) {
  const initialReceipt = await createOrReadSsoReceipt(db, transition, member);
  let receipt = initialReceipt.receipt;
  const { created } = initialReceipt;
  if (
    receipt.status === 'complete'
    && ssoEpoch(member.ssoEnforcementEpoch, 'Organization member SSO enforcement epoch')
      === transition.desiredEpoch
  ) {
    return { created, incomplete: false, error: null as string | null };
  }
  const attemptedAt = nowIso();
  const attemptCount = Math.max(0, Number(receipt.attemptCount) || 0) + 1;
  try {
    await db.transact([
      {
        table: 'organization_sso_revocation_receipts',
        op: 'expect',
        id: receipt.id,
        where: [
          ['transitionId', '==', transition.id],
          ['organizationMemberId', '==', member.id],
          ['userId', '==', member.userId],
          ['status', '==', receipt.status],
          ['attemptCount', '==', receipt.attemptCount],
        ],
        exists: true,
      },
      {
        table: 'organization_sso_revocation_receipts',
        op: 'update',
        id: receipt.id,
        data: {
          status: 'pending',
          scanGeneration: transition.scanGeneration,
          attemptCount,
          lastAttemptAt: attemptedAt,
          lastError: null,
          updatedAt: attemptedAt,
        },
      },
    ]);
  } catch (error) {
    if (!isTransactionConflictError(error)) throw error;
    receipt = await getExisting(
      db.table<OrganizationSsoRevocationReceipt>('organization_sso_revocation_receipts'),
      receipt.id,
    ) ?? receipt;
    if (receipt.status === 'complete') {
      return { created, incomplete: false, error: null as string | null };
    }
    return { created, incomplete: true, error: 'The revocation receipt changed concurrently.' };
  }

  try {
    await authAdmin.revokeAllSessions!(member.userId);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Session revocation failed.';
    await db.table<OrganizationSsoRevocationReceipt>('organization_sso_revocation_receipts')
      .update(receipt.id, { lastError: message, updatedAt: nowIso() });
    return { created, incomplete: true, error: message };
  }

  const completedAt = nowIso();
  try {
    await db.transact([
      {
        table: 'organization_sso_revocation_receipts',
        op: 'expect',
        id: receipt.id,
        where: [
          ['transitionId', '==', transition.id],
          ['status', '==', 'pending'],
          ['attemptCount', '==', attemptCount],
        ],
        exists: true,
      },
      {
        table: 'organization_members',
        op: 'expect',
        id: member.id,
        where: [
          ['organizationId', '==', transition.organizationId],
          ['userId', '==', member.userId],
          ['role', '==', member.role],
          ['status', '==', member.status ?? null],
        ],
        exists: true,
      },
      {
        table: 'organization_members',
        op: 'update',
        id: member.id,
        data: { ssoEnforcementEpoch: transition.desiredEpoch, updatedAt: completedAt },
      },
      {
        table: 'organization_sso_revocation_receipts',
        op: 'update',
        id: receipt.id,
        data: {
          status: 'complete',
          scanGeneration: transition.scanGeneration,
          lastError: null,
          completedAt,
          updatedAt: completedAt,
        },
      },
    ]);
    return { created, incomplete: false, error: null as string | null };
  } catch (error) {
    if (!isTransactionConflictError(error)) throw error;
    const current = await getExisting(
      db.table<OrganizationMember>('organization_members'),
      member.id,
    );
    if (
      !current
      || current.organizationId !== transition.organizationId
      || (current.status ?? 'active') !== 'active'
      || current.role === 'guest'
      || current.userId !== member.userId
    ) {
      await db.table<OrganizationSsoRevocationReceipt>('organization_sso_revocation_receipts')
        .update(receipt.id, {
          status: 'superseded',
          lastError: null,
          completedAt,
          updatedAt: completedAt,
        });
      return { created, incomplete: false, error: null as string | null };
    }
    const message = 'Organization membership changed while its SSO revocation settled.';
    await db.table<OrganizationSsoRevocationReceipt>('organization_sso_revocation_receipts')
      .update(receipt.id, { lastError: message, updatedAt: completedAt });
    return { created, incomplete: true, error: message };
  }
}

function assertMatchingSsoTransition(
  transition: OrganizationSsoTransition,
  organizationId: string,
  actorId: string,
  controls: OrganizationEnterpriseControls,
  receipt: GovernanceMutationReceipt,
  patch: Partial<OrganizationEnterpriseControls>,
) {
  if (
    transition.organizationId !== organizationId
    || transition.actorId !== actorId
    || transition.controlsId !== controls.id
    || transition.requestHash !== receipt.requestHash
    || transition.mutationId !== receipt.mutationId
    || !sameStableValue(transition.desiredPatch, patch)
  ) {
    throw Object.assign(
      new Error('mutationId was already used with a different organization SSO transition.'),
      { status: 409 },
    );
  }
}

async function createOrReadRequiredSsoTransition(
  db: DbRef,
  ctx: Awaited<ReturnType<typeof organizationAdminContext>>,
  controls: OrganizationEnterpriseControls,
  controlsVersion: ReturnType<typeof governanceControlsVersion>,
  actorId: string,
  receipt: GovernanceMutationReceipt,
  patch: Partial<OrganizationEnterpriseControls>,
  metadata: Record<string, unknown>,
) {
  const organizationId = ctx.organization.id;
  const id = await deterministicUuid(`${receipt.id}|required-sso-transition`);
  let transition = await getExisting(
    db.table<OrganizationSsoTransition>('organization_sso_transitions'),
    id,
  );
  if (transition) {
    assertMatchingSsoTransition(transition, organizationId, actorId, controls, receipt, patch);
    return transition;
  }
  const otherPending = (await listAll(
    db.table<OrganizationSsoTransition>('organization_sso_transitions')
      .where('pendingOrganizationId', '==', organizationId),
    { maxItems: 2, pageSize: 2, label: 'Pending organization SSO transition' },
  )).find((candidate) => candidate.status === 'pending');
  if (otherPending) {
    throw Object.assign(
      new Error('Another required SSO transition is already pending for this organization.'),
      { status: 409 },
    );
  }

  const organizationFence = governanceOrganizationFence(ctx.organization);
  const actorGuard = governanceActorGuard(ctx, organizationId, actorId);
  const previousEpochWasMissing = ctx.organization.ssoEnforcementEpoch == null;
  const previousEpoch = ssoEpoch(
    ctx.organization.ssoEnforcementEpoch,
    'Organization SSO enforcement epoch',
  );
  const now = nowIso();
  const data: OrganizationSsoTransition = {
    id,
    organizationId,
    pendingOrganizationId: organizationId,
    actorId,
    controlsId: controls.id,
    controlsVersion: controlsVersion.value,
    controlsVersionWasMissing: controls.version == null,
    requestHash: receipt.requestHash,
    mutationId: receipt.mutationId,
    desiredPatch: stableJsonValue(patch) as Partial<OrganizationEnterpriseControls>,
    desiredMetadata: stableJsonValue(metadata) as Record<string, unknown>,
    previousEpoch,
    previousEpochWasMissing,
    desiredEpoch: previousEpoch + 1,
    status: 'pending',
    version: 0,
    scanGeneration: 1,
    scanPage: 1,
    passDiscovered: 0,
    passIncomplete: 0,
    stablePasses: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: null,
    lastErrorAt: null,
    activatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.transact([
      organizationFence.guard,
      actorGuard,
      {
        table: 'organization_enterprise_controls',
        op: 'expect',
        id: controls.id,
        where: [
          ['organizationId', '==', organizationId],
          ['version', '==', controlsVersion.expected],
        ],
        exists: true,
      },
      {
        table: 'organization_sso_transitions',
        op: 'expect',
        id,
        exists: false,
      },
      {
        table: 'organization_sso_transitions',
        op: 'insert',
        data: data as unknown as Record<string, unknown>,
      },
    ]);
  } catch (error) {
    if (!isTransactionConflictError(error)) throw error;
  }
  transition = await getExisting(
    db.table<OrganizationSsoTransition>('organization_sso_transitions'),
    id,
  );
  if (!transition) {
    const pending = (await listAll(
      db.table<OrganizationSsoTransition>('organization_sso_transitions')
        .where('pendingOrganizationId', '==', organizationId),
      { maxItems: 2, pageSize: 2, label: 'Pending organization SSO transition' },
    )).find((candidate) => candidate.status === 'pending');
    if (pending) {
      throw Object.assign(
        new Error('Another required SSO transition is already pending for this organization.'),
        { status: 409 },
      );
    }
    await throwGovernanceTransactionConflict(
      db,
      Object.assign(new Error('Organization SSO transition changed concurrently.'), { status: 409 }),
      actorGuard,
      'Organization security admin access required.',
      'Organization enterprise controls changed concurrently. Retry the request.',
    );
  }
  assertMatchingSsoTransition(transition!, organizationId, actorId, controls, receipt, patch);
  return transition!;
}

async function claimSsoTransition(
  db: DbRef,
  transition: OrganizationSsoTransition,
) {
  if (transition.status !== 'pending') return transition;
  const leaseExpiry = transition.leaseExpiresAt ? Date.parse(transition.leaseExpiresAt) : 0;
  if (Number.isFinite(leaseExpiry) && leaseExpiry > Date.now()) return null;
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + SSO_TRANSITION_LEASE_MS).toISOString();
  const now = nowIso();
  try {
    await db.transact([
      {
        table: 'organization_sso_transitions',
        op: 'expect',
        id: transition.id,
        where: [
          ['organizationId', '==', transition.organizationId],
          ['status', '==', 'pending'],
          ['version', '==', transition.version],
          ['leaseToken', '==', transition.leaseToken ?? null],
          ['leaseExpiresAt', '==', transition.leaseExpiresAt ?? null],
        ],
        exists: true,
      },
      {
        table: 'organization_sso_transitions',
        op: 'update',
        id: transition.id,
        data: {
          leaseToken,
          leaseExpiresAt,
          version: transition.version + 1,
          updatedAt: now,
        },
      },
    ]);
    return {
      ...transition,
      leaseToken,
      leaseExpiresAt,
      version: transition.version + 1,
      updatedAt: now,
    };
  } catch (error) {
    if (!isTransactionConflictError(error)) throw error;
    return null;
  }
}

async function checkpointSsoTransition(
  db: DbRef,
  transition: OrganizationSsoTransition,
  patch: Partial<OrganizationSsoTransition>,
  releaseLease = false,
) {
  const now = nowIso();
  const next = {
    ...patch,
    ...(releaseLease
      ? { leaseToken: null, leaseExpiresAt: null }
      : { leaseExpiresAt: new Date(Date.now() + SSO_TRANSITION_LEASE_MS).toISOString() }),
    version: transition.version + 1,
    updatedAt: now,
  };
  await db.transact([
    {
      table: 'organization_sso_transitions',
      op: 'expect',
      id: transition.id,
      where: [
        ['organizationId', '==', transition.organizationId],
        ['status', '==', 'pending'],
        ['version', '==', transition.version],
        ['leaseToken', '==', transition.leaseToken ?? null],
      ],
      exists: true,
    },
    {
      table: 'organization_sso_transitions',
      op: 'update',
      id: transition.id,
      data: next as Record<string, unknown>,
    },
  ]);
  return { ...transition, ...next } as OrganizationSsoTransition;
}

async function markSsoTransitionSuperseded(
  db: DbRef,
  transition: OrganizationSsoTransition,
  message: string,
) {
  const now = nowIso();
  try {
    await db.transact([
      {
        table: 'organization_sso_transitions',
        op: 'expect',
        id: transition.id,
        where: [
          ['organizationId', '==', transition.organizationId],
          ['status', '==', 'pending'],
          ['version', '==', transition.version],
        ],
        exists: true,
      },
      {
        table: 'organization_sso_transitions',
        op: 'update',
        id: transition.id,
        data: {
          pendingOrganizationId: null,
          status: 'superseded',
          version: transition.version + 1,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: message,
          lastErrorAt: now,
          updatedAt: now,
        },
      },
    ]);
  } catch {
    // A competing finalizer owns the terminal state. Its row is re-read by
    // the caller; never overwrite it with an unguarded diagnostic update.
  }
}

async function activateRequiredSsoTransition(
  db: DbRef,
  body: Record<string, unknown>,
  transitionInput: OrganizationSsoTransition,
  receipt: GovernanceMutationReceipt,
) {
  let transition = transitionInput;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existingAudit = await getExisting(
      db.table<OrganizationAuditEvent>('organization_audit_events'),
      receipt.id,
    );
    if (existingAudit) return transition;
    const ctx = await organizationAdminContext(db, transition.organizationId, transition.actorId);
    assertOrganizationSecurityAdmin(ctx.actorRole);
    const controls = await enterpriseControlsForOrganization(db, transition.organizationId);
    const currentControlsVersion = governanceControlsVersion(controls);
    const expectedControlsVersion = transition.controlsVersionWasMissing
      ? null
      : transition.controlsVersion;
    if (
      controls.id !== transition.controlsId
      || currentControlsVersion.expected !== expectedControlsVersion
    ) {
      const message = 'Organization enterprise controls changed before required SSO activation.';
      await markSsoTransitionSuperseded(db, transition, message);
      throw Object.assign(new Error(`${message} Retry the request.`), { status: 409 });
    }
    const currentEpoch = ssoEpoch(
      ctx.organization.ssoEnforcementEpoch,
      'Organization SSO enforcement epoch',
    );
    const expectedEpoch = transition.previousEpochWasMissing ? null : transition.previousEpoch;
    if (
      currentEpoch !== transition.previousEpoch
      || (ctx.organization.ssoEnforcementEpoch ?? null) !== expectedEpoch
    ) {
      const message = 'Organization SSO enforcement epoch changed before activation.';
      await markSsoTransitionSuperseded(db, transition, message);
      throw Object.assign(new Error(`${message} Retry the request.`), { status: 409 });
    }
    const organizationFence = governanceOrganizationFence(ctx.organization);
    const organizationGuard = {
      ...organizationFence.guard,
      where: [
        ...(organizationFence.guard.where ?? []),
        ['ssoEnforcementEpoch', '==', expectedEpoch],
      ],
    } satisfies TransactOperation;
    const organizationWrite = {
      ...organizationFence.write,
      data: {
        ...organizationFence.write.data,
        ssoEnforcementEpoch: transition.desiredEpoch,
      },
    } satisfies TransactOperation;
    const actorGuard = governanceActorGuard(
      ctx,
      transition.organizationId,
      transition.actorId,
    );
    const policyVersion = await governancePolicyVersionPlan(db, transition.organizationId);
    const now = nowIso();
    try {
      await db.transact([
        organizationGuard,
        organizationWrite,
        actorGuard,
        {
          table: 'organization_enterprise_controls',
          op: 'expect',
          id: controls.id,
          where: [
            ['organizationId', '==', transition.organizationId],
            ['version', '==', expectedControlsVersion],
          ],
          exists: true,
        },
        {
          table: 'organization_sso_transitions',
          op: 'expect',
          id: transition.id,
          where: [
            ['organizationId', '==', transition.organizationId],
            ['status', '==', 'pending'],
            ['version', '==', transition.version],
            ['leaseToken', '==', transition.leaseToken ?? null],
            ['requestHash', '==', transition.requestHash],
          ],
          exists: true,
        },
        policyVersion.guard,
        {
          table: 'organization_enterprise_controls',
          op: 'update',
          id: controls.id,
          data: {
            ...transition.desiredPatch,
            version: transition.controlsVersion + 1,
            updatedBy: transition.actorId,
            updatedAt: now,
          },
        },
        policyVersion.write,
        {
          table: 'organization_sso_transitions',
          op: 'update',
          id: transition.id,
          data: {
            pendingOrganizationId: null,
            status: 'active',
            version: transition.version + 1,
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
            lastErrorAt: null,
            activatedAt: now,
            updatedAt: now,
          },
        },
        {
          table: 'organization_audit_events',
          op: 'insert',
          data: {
            id: receipt.id,
            organizationId: transition.organizationId,
            workspaceId: null,
            actorId: transition.actorId,
            action: 'organization_enterprise_controls.update',
            targetType: 'organization_enterprise_controls',
            targetId: controls.id,
            metadata: governanceReceiptMetadata(receipt, {
              ...transition.desiredMetadata,
              ssoTransitionId: transition.id,
              ssoEnforcementEpoch: transition.desiredEpoch,
            }),
            occurredAt: now,
          },
        },
      ]);
      return {
        ...transition,
        pendingOrganizationId: null,
        status: 'active',
        version: transition.version + 1,
        leaseToken: null,
        leaseExpiresAt: null,
        activatedAt: now,
        updatedAt: now,
      } as OrganizationSsoTransition;
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
      const recovered = await governanceMutationReceipt(
        db,
        body,
        transition.organizationId,
        transition.actorId,
        'organization_enterprise_controls.update',
        stableJsonValue(transition.desiredPatch),
      );
      if (recovered.existing) {
        return await getExisting(
          db.table<OrganizationSsoTransition>('organization_sso_transitions'),
          transition.id,
        ) ?? transition;
      }
      if (!(await governanceActorGuardIsCurrent(db, actorGuard))) {
        throw Object.assign(new Error('Organization security admin access required.'), { status: 403 });
      }
      const latest = await getExisting(
        db.table<OrganizationSsoTransition>('organization_sso_transitions'),
        transition.id,
      );
      if (!latest) throw Object.assign(new Error('Organization SSO transition was removed.'), { status: 409 });
      if (latest.status === 'active') return latest;
      if (latest.status !== 'pending') {
        throw Object.assign(new Error('Organization SSO transition is no longer pending.'), { status: 409 });
      }
      transition = latest;
    }
  }
  throw Object.assign(
    new Error('Organization SSO activation changed concurrently. Retry the request.'),
    { status: 409 },
  );
}

async function drainRequiredSsoTransition(
  db: DbRef,
  authAdmin: AuthAdminRef,
  body: Record<string, unknown>,
  transitionInput: OrganizationSsoTransition,
  receipt: GovernanceMutationReceipt,
) {
  const claimed = await claimSsoTransition(db, transitionInput);
  if (!claimed) {
    return await getExisting(
      db.table<OrganizationSsoTransition>('organization_sso_transitions'),
      transitionInput.id,
    ) ?? transitionInput;
  }
  let transition = claimed;
  const desiredConfig = requiredSsoConfig(transition.desiredPatch.ssoConfig);
  if (!desiredConfig) {
    throw Object.assign(new Error('Required SSO transition has no required SSO policy.'), { status: 409 });
  }
  try {
    for (;;) {
      const verifiedDomains = await verifiedSsoDomains(db, transition.organizationId);
      const page = await db.table<OrganizationMember>('organization_members')
        .where('organizationId', '==', transition.organizationId)
        .page(transition.scanPage)
        .limit(SSO_REVOCATION_PAGE_SIZE)
        .getList();
      const members = (page.items ?? []).filter((member) => (
        memberMatchesRequiredSso(desiredConfig, member, verifiedDomains)
      ));
      const results = await mapWithConcurrency(
        members,
        SSO_REVOCATION_CONCURRENCY,
        (member) => revokeMemberForSsoTransition(db, authAdmin, transition, member),
      );
      const discovered = transition.passDiscovered
        + results.filter((result) => result.created).length;
      const incomplete = transition.passIncomplete
        + results.filter((result) => result.incomplete).length;
      const lastError = results.find((result) => result.error)?.error ?? null;

      if (page.hasMore === true) {
        transition = await checkpointSsoTransition(db, transition, {
          scanPage: transition.scanPage + 1,
          passDiscovered: discovered,
          passIncomplete: incomplete,
          ...(lastError ? { lastError, lastErrorAt: nowIso() } : {}),
        });
        continue;
      }

      if (incomplete > 0) {
        return await checkpointSsoTransition(db, transition, {
          scanGeneration: transition.scanGeneration + 1,
          scanPage: 1,
          passDiscovered: 0,
          passIncomplete: 0,
          stablePasses: 0,
          lastError: lastError ?? `${incomplete} member session revocation(s) remain pending.`,
          lastErrorAt: nowIso(),
        }, true);
      }

      if (discovered > 0) {
        transition = await checkpointSsoTransition(db, transition, {
          scanGeneration: transition.scanGeneration + 1,
          scanPage: 1,
          passDiscovered: 0,
          passIncomplete: 0,
          stablePasses: 0,
          lastError: null,
          lastErrorAt: null,
        });
        continue;
      }

      transition = await checkpointSsoTransition(db, transition, {
        stablePasses: transition.stablePasses + 1,
        passDiscovered: 0,
        passIncomplete: 0,
        lastError: null,
        lastErrorAt: null,
      });
      return activateRequiredSsoTransition(db, body, transition, receipt);
    }
  } catch (error) {
    if (isTransactionConflictError(error)) {
      return await getExisting(
        db.table<OrganizationSsoTransition>('organization_sso_transitions'),
        transition.id,
      ) ?? transition;
    }
    try {
      await checkpointSsoTransition(db, transition, {
        lastError: error instanceof Error ? error.message.slice(0, 500) : 'SSO transition failed.',
        lastErrorAt: nowIso(),
      }, true);
    } catch {
      // The durable cursor/receipts already contain the last settled boundary.
    }
    throw error;
  }
}

async function mutateOrganizationMcpGovernance(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  operation: 'set_enabled' | 'approve' | 'remove' | 'rename',
) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const workspaceId = requireString(body.workspaceId, 'workspaceId');
  let ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const workspace = await getExisting(db.table<Workspace>('workspaces'), workspaceId);
  if (!workspace || workspace.organizationId !== organizationId) {
    throw new Error('Workspace does not belong to this organization.');
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) {
      ctx = await organizationAdminContext(db, organizationId, actorId);
      assertOrganizationSecurityAdmin(ctx.actorRole);
    }
    const controls = await enterpriseControlsForOrganization(db, organizationId);
    const currentPolicy = controls.mcpGovernancePolicy ?? { workspacePolicies: [] };
    assertValidMcpGovernancePolicy(currentPolicy);
    const workspacePolicies = organizationMcpWorkspacePolicies(controls);
    const currentWorkspacePolicy = workspacePolicies.find((policy) => policy.workspaceId === workspaceId);
    let enabled = currentWorkspacePolicy?.enabled === true;
    let approvedClients = currentWorkspacePolicy?.approvedClients ?? [];
    let clientId: string | null = null;
    let clientName: string | null = null;
    let auditAction = '';
    let idempotentNoop = false;
    const now = nowIso();

    if (operation === 'set_enabled') {
      const nextEnabled = parseOptionalBoolean(body.enabled, 'enabled');
      if (nextEnabled === undefined) throw new Error('enabled must be a boolean.');
      idempotentNoop = enabled === nextEnabled;
      enabled = nextEnabled;
      auditAction = enabled
        ? 'organization_mcp_governance.enable'
        : 'organization_mcp_governance.disable';
    } else {
      clientId = requiredMcpClientId(body);
      const index = approvedClients.findIndex((client) => client.clientId === clientId);
      if (operation === 'approve') {
        clientName = boundedText(body.name ?? body.clientName, 'name', 200) ?? clientId;
        if (index >= 0) {
          if (approvedClients[index].name !== clientName) {
            throw new Error('MCP client is already approved. Rename it explicitly.');
          }
          idempotentNoop = true;
        } else {
          approvedClients = [...approvedClients, {
            clientId,
            name: clientName,
            approvedAt: now,
            approvedBy: actorId,
            updatedAt: now,
            updatedBy: actorId,
          }];
        }
        auditAction = 'organization_mcp_governance.approve';
      } else if (operation === 'remove') {
        if (index < 0) {
          idempotentNoop = true;
        } else {
          clientName = approvedClients[index].name;
          approvedClients = approvedClients.filter((client) => client.clientId !== clientId);
        }
        auditAction = 'organization_mcp_governance.remove';
      } else {
        if (index < 0) throw new Error('Approved MCP client was not found.');
        clientName = boundedText(body.name ?? body.clientName, 'name', 200);
        if (!clientName) throw new Error('name is required.');
        if (approvedClients[index].name === clientName) {
          idempotentNoop = true;
        } else {
          approvedClients = approvedClients.map((client) => client.clientId === clientId
            ? { ...client, name: clientName!, updatedAt: now, updatedBy: actorId }
            : client);
        }
        auditAction = 'organization_mcp_governance.rename';
      }
    }

    const controlsVersion = governanceControlsVersion(controls);
    const organizationFence = governanceOrganizationFence(ctx.organization);
    const actorGuard = governanceActorGuard(ctx, organizationId, actorId);
    const controlsGuard: TransactOperation = {
      table: 'organization_enterprise_controls',
      op: 'expect',
      id: controls.id,
      where: [
        ['organizationId', '==', organizationId],
        ['version', '==', controlsVersion.expected],
      ],
      exists: true,
    };

    if (idempotentNoop) {
      try {
        await db.transact([organizationFence.guard, actorGuard, controlsGuard]);
        return organizationDirectory(db, organizationId, actorId);
      } catch (error) {
        if (!isTransactionConflictError(error)) throw error;
        continue;
      }
    }

    const nextWorkspacePolicy: OrganizationMcpWorkspacePolicy = {
      ...(currentWorkspacePolicy ?? {}),
      workspaceId,
      enabled,
      approvedClients,
      updatedAt: now,
      updatedBy: actorId,
    };
    const nextWorkspacePolicies = currentWorkspacePolicy
      ? workspacePolicies.map((policy) => policy.workspaceId === workspaceId ? nextWorkspacePolicy : policy)
      : [...workspacePolicies, nextWorkspacePolicy];
    const mcpGovernancePolicy = { ...currentPolicy, workspacePolicies: nextWorkspacePolicies };
    const policyVersion = await governancePolicyVersionPlan(db, organizationId);
    const auditId = crypto.randomUUID();
    try {
      await db.transact([
        organizationFence.guard,
        organizationFence.write,
        actorGuard,
        controlsGuard,
        policyVersion.guard,
        {
          table: 'organization_enterprise_controls',
          op: 'update',
          id: controls.id,
          data: {
            mcpGovernancePolicy,
            ...auditRetentionScalarPatch(controls.auditPolicy),
            version: controlsVersion.value + 1,
            updatedBy: actorId,
            updatedAt: now,
          },
        },
        policyVersion.write,
        {
          table: 'organization_audit_events',
          op: 'insert',
          data: {
            id: auditId,
            organizationId,
            workspaceId,
            actorId,
            action: auditAction,
            targetType: clientId ? 'mcp_oauth_client' : 'workspace',
            targetId: clientId ?? workspaceId,
            metadata: {
              workspaceId,
              enabled,
              clientId,
              clientName,
              approvedClientCount: approvedClients.length,
            },
            occurredAt: now,
          },
        },
      ]);
      return organizationDirectory(db, organizationId, actorId);
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
    }
  }

  throw Object.assign(
    new Error('Organization MCP governance changed concurrently. Retry the request.'),
    { status: 409 },
  );
}

async function updateOrganizationEnterpriseControls(
  db: DbRef,
  authAdmin: AuthAdminRef | undefined,
  env: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
  actorId: string,
) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  const controls = await enterpriseControlsForOrganization(db, organizationId);
  const patch: Partial<OrganizationEnterpriseControls> = {};
  const metadata: Record<string, unknown> = {};
  let requiresSecurityAdmin = false;
  let requiresBillingAdmin = false;

  if ('ssoConfig' in body) {
    requiresSecurityAdmin = true;
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.ssoConfig = sanitizeSsoConfig(body.ssoConfig);
    assertSsoRuntimeConfigured(patch.ssoConfig, env);
    metadata.ssoConfig = patch.ssoConfig;
  }
  if ('scimConfig' in body) {
    requiresSecurityAdmin = true;
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.scimConfig = sanitizeScimConfig(body.scimConfig);
    metadata.scimConfig = patch.scimConfig;
  }
  if ('auditPolicy' in body) {
    requiresSecurityAdmin = true;
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.auditPolicy = sanitizeAuditPolicy(body.auditPolicy);
    metadata.auditPolicy = patch.auditPolicy;
  }
  if ('dataResidencyPolicy' in body) {
    requiresSecurityAdmin = true;
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.dataResidencyPolicy = sanitizeDataResidencyPolicy(body.dataResidencyPolicy, env);
    metadata.dataResidencyPolicy = patch.dataResidencyPolicy;
  }
  if ('dlpPolicy' in body) {
    requiresSecurityAdmin = true;
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.dlpPolicy = sanitizeDlpPolicy(body.dlpPolicy);
    metadata.dlpPolicy = patch.dlpPolicy;
  }
  if ('legalPolicy' in body) {
    requiresSecurityAdmin = true;
    assertOrganizationSecurityAdmin(ctx.actorRole);
    patch.legalPolicy = sanitizeLegalPolicy(body.legalPolicy);
    metadata.legalPolicy = patch.legalPolicy;
  }
  if ('billingProfile' in body) {
    requiresBillingAdmin = true;
    assertOrganizationBillingAdmin(ctx.actorRole);
    patch.billingProfile = sanitizeBillingProfile(body.billingProfile);
    metadata.billingProfile = patch.billingProfile;
  }

  if (!Object.keys(patch).length) return organizationDirectory(db, organizationId, actorId);
  // Normalize the destructive-retention authority into bounded scalars on
  // every controls write. This also safely backfills a legacy row when an
  // administrator next changes any controls surface; malformed legacy data is
  // marked invalid so maintenance fails closed without loading the JSON.
  Object.assign(patch, auditRetentionScalarPatch(patch.auditPolicy ?? controls.auditPolicy));
  const nextSsoConfig = patch.ssoConfig ?? controls.ssoConfig ?? {};
  const shouldRevokeSessions = 'ssoConfig' in body
    && nextSsoConfig.enabled === true
    && nextSsoConfig.enforcement !== 'optional'
    && !sameStableValue(controls.ssoConfig ?? null, nextSsoConfig);
  if (shouldRevokeSessions && !authAdmin?.revokeAllSessions) {
    throw new Error('Session revocation is required before enforcing organization SSO.');
  }
  const controlsVersion = governanceControlsVersion(controls);
  const organizationFence = governanceOrganizationFence(ctx.organization);
  const actorGuard = governanceActorGuard(ctx, organizationId, actorId);
  const controlsGuard: TransactOperation = {
    table: 'organization_enterprise_controls',
    op: 'expect',
    id: controls.id,
    where: [
      ['organizationId', '==', organizationId],
      ['version', '==', controlsVersion.expected],
    ],
    exists: true,
  };
  const receiptRequest = stableJsonValue(patch);
  const receipt = await governanceMutationReceipt(
    db,
    body,
    organizationId,
    actorId,
    'organization_enterprise_controls.update',
    receiptRequest,
  );
  if (receipt.existing) return organizationDirectory(db, organizationId, actorId);
  const exactNoop = Object.entries(patch).every(([key, value]) => (
    sameStableValue(controls[key as keyof OrganizationEnterpriseControls], value)
  ));
  if (exactNoop) {
    try {
      await db.transact([organizationFence.guard, actorGuard, controlsGuard]);
      return organizationDirectory(db, organizationId, actorId);
    } catch (error) {
      const actorAccessMessage = requiresSecurityAdmin && !requiresBillingAdmin
        ? 'Organization security admin access required.'
        : requiresBillingAdmin && !requiresSecurityAdmin
          ? 'Organization billing admin access required.'
          : 'Organization admin access required.';
      await throwGovernanceTransactionConflict(
        db,
        error,
        actorGuard,
        actorAccessMessage,
        'Organization enterprise controls changed concurrently. Retry the request.',
      );
    }
  }
  if (shouldRevokeSessions) {
    const transition = await createOrReadRequiredSsoTransition(
      db,
      ctx,
      controls,
      controlsVersion,
      actorId,
      receipt,
      patch,
      metadata,
    );
    if (transition.status === 'pending') {
      await drainRequiredSsoTransition(db, authAdmin!, body, transition, receipt);
    }
    return organizationDirectory(db, organizationId, actorId);
  }
  const now = nowIso();
  patch.updatedBy = actorId;
  patch.updatedAt = now;
  const policyVersion = await governancePolicyVersionPlan(db, organizationId);
  try {
    await db.transact([
      organizationFence.guard,
      organizationFence.write,
      actorGuard,
      controlsGuard,
      policyVersion.guard,
      {
        table: 'organization_enterprise_controls',
        op: 'update',
        id: controls.id,
        data: { ...patch, version: controlsVersion.value + 1 },
      },
      policyVersion.write,
      {
        table: 'organization_audit_events',
        op: 'insert',
        data: {
          id: receipt.id,
          organizationId,
          workspaceId: null,
          actorId,
          action: 'organization_enterprise_controls.update',
          targetType: 'organization_enterprise_controls',
          targetId: controls.id,
          metadata: governanceReceiptMetadata(receipt, metadata),
          occurredAt: now,
        },
      },
    ]);
  } catch (error) {
    if (isTransactionConflictError(error)) {
      const recovered = await governanceMutationReceipt(
        db,
        body,
        organizationId,
        actorId,
        'organization_enterprise_controls.update',
        receiptRequest,
      );
      if (recovered.existing) return organizationDirectory(db, organizationId, actorId);
    }
    const actorAccessMessage = requiresSecurityAdmin && !requiresBillingAdmin
      ? 'Organization security admin access required.'
      : requiresBillingAdmin && !requiresSecurityAdmin
        ? 'Organization billing admin access required.'
        : 'Organization admin access required.';
    await throwGovernanceTransactionConflict(
      db,
      error,
      actorGuard,
      actorAccessMessage,
      'Organization enterprise controls changed concurrently. Retry the request.',
    );
  }
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
  const scope = sanitizeLegalHoldScope(body.scope);
  const receiptRequest = { name, reason, scope };
  const receipt = await governanceMutationReceipt(
    db,
    body,
    organizationId,
    actorId,
    'organization_legal_hold.create',
    receiptRequest,
  );
  const holdId = await deterministicUuid(`${receipt.id}|legal-hold`);
  if (receipt.existing) {
    const existing = await getExisting(
      db.table<OrganizationLegalHold>('organization_legal_holds'),
      holdId,
    );
    if (existing?.organizationId === organizationId) {
      return organizationDirectory(db, organizationId, actorId);
    }
    throw Object.assign(new Error('Legal-hold mutation receipt is missing its target.'), { status: 409 });
  }
  const now = nowIso();
  const organizationFence = governanceOrganizationFence(ctx.organization);
  const actorGuard = governanceActorGuard(ctx, organizationId, actorId);
  const controlsVersion = governanceControlsVersion(controls);
  const policyVersion = await governancePolicyVersionPlan(db, organizationId);
  try {
    await db.transact([
      organizationFence.guard,
      organizationFence.write,
      actorGuard,
      {
        table: 'organization_enterprise_controls',
        op: 'expect',
        id: controls.id,
        where: [
          ['organizationId', '==', organizationId],
          ['version', '==', controlsVersion.expected],
        ],
        exists: true,
      },
      {
        table: 'organization_legal_holds',
        op: 'expect',
        id: holdId,
        exists: false,
      },
      policyVersion.guard,
      {
        table: 'organization_legal_holds',
        op: 'insert',
        data: {
          id: holdId,
          organizationId,
          name,
          status: 'active',
          reason,
          scope,
          createdBy: actorId,
          createdAt: now,
          updatedAt: now,
        },
      },
      policyVersion.write,
      {
        table: 'organization_audit_events',
        op: 'insert',
        data: {
          id: receipt.id,
          organizationId,
          workspaceId: null,
          actorId,
          action: 'organization_legal_hold.create',
          targetType: 'organization_legal_hold',
          targetId: holdId,
          metadata: governanceReceiptMetadata(receipt, { name, scope }),
          occurredAt: now,
        },
      },
    ]);
  } catch (error) {
    if (isTransactionConflictError(error)) {
      const recovered = await governanceMutationReceipt(
        db,
        body,
        organizationId,
        actorId,
        'organization_legal_hold.create',
        receiptRequest,
      );
      const recoveredHold = recovered.existing
        ? await getExisting(db.table<OrganizationLegalHold>('organization_legal_holds'), holdId)
        : null;
      if (recovered.existing && recoveredHold?.organizationId === organizationId) {
        return organizationDirectory(db, organizationId, actorId);
      }
    }
    await throwGovernanceTransactionConflict(
      db,
      error,
      actorGuard,
      'Organization security admin access required.',
      'Organization legal policy changed concurrently. Retry the request.',
    );
  }
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
  const receiptRequest = { legalHoldId: hold.id };
  const receipt = await governanceMutationReceipt(
    db,
    body,
    organizationId,
    actorId,
    'organization_legal_hold.release',
    receiptRequest,
  );
  if (receipt.existing && (hold.status ?? 'active') === 'released') {
    return organizationDirectory(db, organizationId, actorId);
  }
  if ((hold.status ?? 'active') !== 'active') {
    throw Object.assign(new Error('Legal hold is not active.'), { status: 409 });
  }
  const now = nowIso();
  const organizationFence = governanceOrganizationFence(ctx.organization);
  const actorGuard = governanceActorGuard(ctx, organizationId, actorId);
  const policyVersion = await governancePolicyVersionPlan(db, organizationId);
  try {
    await db.transact([
      organizationFence.guard,
      organizationFence.write,
      actorGuard,
      {
        table: 'organization_legal_holds',
        op: 'expect',
        id: hold.id,
        where: [
          ['organizationId', '==', organizationId],
          ['status', '==', hold.status ?? null],
        ],
        exists: true,
      },
      policyVersion.guard,
      {
        table: 'organization_legal_holds',
        op: 'update',
        id: hold.id,
        data: {
          status: 'released',
          releasedAt: now,
          releasedBy: actorId,
          updatedAt: now,
        },
      },
      policyVersion.write,
      {
        table: 'organization_audit_events',
        op: 'insert',
        data: {
          id: receipt.id,
          organizationId,
          workspaceId: null,
          actorId,
          action: 'organization_legal_hold.release',
          targetType: 'organization_legal_hold',
          targetId: hold.id,
          metadata: governanceReceiptMetadata(receipt, { name: hold.name }),
          occurredAt: now,
        },
      },
    ]);
  } catch (error) {
    if (isTransactionConflictError(error)) {
      const recovered = await governanceMutationReceipt(
        db,
        body,
        organizationId,
        actorId,
        'organization_legal_hold.release',
        receiptRequest,
      );
      const latest = await getExisting(
        db.table<OrganizationLegalHold>('organization_legal_holds'),
        hold.id,
      );
      if (recovered.existing && latest?.status === 'released') {
        return organizationDirectory(db, organizationId, actorId);
      }
    }
    await throwGovernanceTransactionConflict(
      db,
      error,
      actorGuard,
      'Organization security admin access required.',
      'Legal hold changed concurrently. Retry the request.',
    );
  }
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

function redactDiscoveryExport(discoveryExport: OrganizationDiscoveryExport) {
  return { ...discoveryExport, content: undefined };
}

interface DiscoveryItem {
  type: 'page' | 'block' | 'comment' | 'file';
  id: string;
  organizationId: string;
  workspaceId: string;
  workspaceName: string;
  pageId?: string | null;
  custodianUserIds: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  content: Record<string, unknown>;
}

function discoveryItemMatches(
  item: DiscoveryItem,
  query: string | null,
  userIds: Set<string>,
  since: string | null,
  until: string | null,
) {
  if (userIds.size > 0 && !item.custodianUserIds.some((userId) => userIds.has(userId))) return false;
  const occurredAt = item.updatedAt ?? item.createdAt ?? null;
  if (since && (!occurredAt || occurredAt < since)) return false;
  if (until && (!occurredAt || occurredAt > until)) return false;
  if (!query) return true;
  return JSON.stringify(item.content).normalize('NFKC').toLocaleLowerCase('en-US').includes(query);
}

function discoveryExportRows(items: DiscoveryItem[], format: string) {
  if (format === 'json') return JSON.stringify(items, null, 2);
  return items.map((item) => JSON.stringify(item)).join('\n');
}

async function exportOrganizationDiscovery(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationSecurityAdmin(ctx.actorRole);
  const queryValue = boundedText(body.query, 'query', 300);
  const query = queryValue?.normalize('NFKC').toLocaleLowerCase('en-US') ?? null;
  const userIds = new Set(stringList(body.userIds, 'userIds', 500, 200));
  const requestedWorkspaceIds = new Set(stringList(body.workspaceIds, 'workspaceIds', 200, 200));
  const since = optionalIsoDateString(body.since, 'since');
  const until = optionalIsoDateString(body.until, 'until');
  const includeTrashed = body.includeTrashed !== false;
  const format = parseEnum(body.format, ['jsonl', 'json'], 'jsonl', 'format');
  const workspaces = ctx.workspaces.filter((workspace) =>
    requestedWorkspaceIds.size === 0 || requestedWorkspaceIds.has(workspace.id));
  if (requestedWorkspaceIds.size > 0 && workspaces.length !== requestedWorkspaceIds.size) {
    throw new Error('Every discovery workspace must belong to the organization.');
  }

  const items: DiscoveryItem[] = [];
  const push = (item: DiscoveryItem) => {
    if (!discoveryItemMatches(item, query, userIds, since, until)) return;
    if (items.length >= 20_000) {
      throw Object.assign(new Error('Discovery export limit exceeded (20000 items).'), { status: 413 });
    }
    items.push(item);
  };

  for (const workspace of workspaces) {
    const contentDb = boundedDb(admin, workspace.id);
    const [pages, blocks, comments, uploads] = await Promise.all([
      listAll(contentDb.table<Page>('pages').where('workspaceId', '==', workspace.id), {
        maxItems: 20_000,
        allowLargeMaterialization: true,
        label: `Discovery pages for ${workspace.id}`,
      }),
      listAll(contentDb.table<Block>('blocks'), {
        maxItems: 20_000,
        allowLargeMaterialization: true,
        label: `Discovery blocks for ${workspace.id}`,
      }),
      listAll(contentDb.table<Comment>('comments'), {
        maxItems: 20_000,
        allowLargeMaterialization: true,
        label: `Discovery comments for ${workspace.id}`,
      }),
      listAll(contentDb.table<FileUpload>('file_uploads').where('workspaceId', '==', workspace.id), {
        maxItems: 20_000,
        allowLargeMaterialization: true,
        label: `Discovery files for ${workspace.id}`,
      }),
    ]);
    const pagesById = new Map(pages.map((page) => [page.id, page]));
    for (const page of pages) {
      if (!includeTrashed && page.inTrash) continue;
      push({
        type: 'page',
        id: page.id,
        organizationId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        pageId: page.id,
        custodianUserIds: [page.createdBy, page.lastEditedBy].filter((id): id is string => Boolean(id)),
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        content: {
          title: page.title ?? '',
          kind: page.kind ?? 'page',
          inTrash: page.inTrash === true,
          properties: page.properties ?? {},
        },
      });
    }
    for (const block of blocks) {
      const page = pagesById.get(block.pageId);
      if (!page || (!includeTrashed && page.inTrash)) continue;
      push({
        type: 'block',
        id: block.id,
        organizationId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        pageId: block.pageId,
        custodianUserIds: [block.createdBy].filter((id): id is string => Boolean(id)),
        createdAt: block.createdAt,
        updatedAt: block.updatedAt,
        content: { plainText: block.plainText ?? '', block: block.content ?? {} },
      });
    }
    for (const comment of comments) {
      const page = pagesById.get(comment.pageId);
      if (!page || (!includeTrashed && page.inTrash)) continue;
      push({
        type: 'comment',
        id: comment.id,
        organizationId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        pageId: comment.pageId,
        custodianUserIds: [comment.authorId].filter(Boolean),
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        content: { body: comment.body ?? '' },
      });
    }
    for (const upload of uploads) {
      push({
        type: 'file',
        id: upload.id,
        organizationId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        pageId: upload.pageId ?? upload.databaseId ?? null,
        custodianUserIds: [upload.createdBy].filter((id): id is string => Boolean(id)),
        createdAt: upload.createdAt,
        updatedAt: upload.updatedAt,
        content: {
          name: upload.name ?? '',
          contentType: upload.contentType ?? null,
          size: upload.size ?? null,
          status: upload.status ?? null,
        },
      });
    }
  }

  const content = discoveryExportRows(items, format);
  if (new TextEncoder().encode(content).byteLength > 8 * 1024 * 1024) {
    throw Object.assign(new Error('Discovery export content limit exceeded (8 MiB).'), { status: 413 });
  }
  const now = nowIso();
  const discoveryExport = await db.table<OrganizationDiscoveryExport>('organization_discovery_exports').insert({
    organizationId,
    status: 'completed',
    format,
    filter: {
      query: queryValue,
      userIds: [...userIds],
      workspaceIds: workspaces.map((workspace) => workspace.id),
      since,
      until,
      includeTrashed,
    },
    itemCount: items.length,
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
    action: 'organization_discovery.export',
    targetType: 'organization_discovery_export',
    targetId: discoveryExport.id,
    metadata: { itemCount: items.length, format, workspaceCount: workspaces.length },
    occurredAt: now,
  });
  return {
    ...(await organizationDirectory(db, organizationId, actorId)),
    discoveryExport,
  };
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

async function deleteOrganizationGroup(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  const ctx = await organizationAdminContext(db, organizationId, actorId);
  assertOrganizationPeopleAdmin(ctx.actorRole);
  const group = findOrganizationGroup(ctx.organizationGroups, body);
  if (!group) throw new Error('Organization group was not found.');
  const groupMembersTable = db.table<OrganizationGroupMember>('organization_group_members');
  const groupMembers = await listAll(groupMembersTable.where('groupId', '==', group.id));
  for (const workspace of ctx.workspaces) {
    const workspaceContentDb = boundedDb(admin, workspace.id);
    const permissions = await listAll(
      workspaceContentDb
        .table<PagePermission>('page_permissions')
        .where('workspaceId', '==', workspace.id),
    );
    const permissionOps = permissions
      .filter((permission) => (
        permission.principalType === 'group' &&
        (
          permission.principalId === group.id ||
          (!permission.principalId && permission.label?.trim().toLowerCase() === group.name.trim().toLowerCase())
        )
      ))
      .map((permission): TransactOperation => ({
        table: 'page_permissions',
        op: 'delete',
        id: permission.id,
      }));
    for (let index = 0; index < permissionOps.length; index += MAX_RAW_TRANSACT_OPS) {
      await runOrganizationTransact(
        workspaceContentDb,
        permissionOps.slice(index, index + MAX_RAW_TRANSACT_OPS),
      );
    }
  }
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
  let membership: OrganizationGroupMember | null = null;
  let groupName = '';
  for (let attempt = 0; attempt < 12; attempt += 1) {
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
    const id = crypto.randomUUID();
    const policyVersion = await governancePolicyVersionPlan(db, organizationId);
    const data = {
      id,
      organizationId,
      groupId: group.id,
      organizationMemberId: target.id,
      userId: target.userId,
      role: 'member',
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.transact([
        governanceActorGuard(ctx, organizationId, actorId),
        policyVersion.guard,
        {
          table: 'organization_group_members',
          op: 'expect',
          where: [
            ['groupId', '==', group.id],
            ['organizationMemberId', '==', target.id],
          ],
          exists: false,
        },
        { table: 'organization_group_members', op: 'insert', data },
        policyVersion.write,
      ]);
      membership = data;
      groupName = group.name;
      break;
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
    }
  }
  if (!membership) {
    throw Object.assign(
      new Error('Organization group membership changed concurrently. Retry the request.'),
      { status: 409 },
    );
  }
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_group_member.add',
    targetType: 'organization_group_member',
    targetId: membership.id,
    metadata: {
      groupId: membership.groupId,
      groupName,
      userId: membership.userId,
    },
    occurredAt: membership.createdAt ?? nowIso(),
  });
  return organizationDirectory(db, organizationId, actorId);
}

async function removeOrganizationGroupMember(db: DbRef, body: Record<string, unknown>, actorId: string) {
  const organizationId = requireString(body.organizationId, 'organizationId');
  let removed: OrganizationGroupDirectoryMember | null = null;
  let removedGroup: OrganizationGroupDirectory | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ctx = await organizationAdminContext(db, organizationId, actorId);
    assertOrganizationPeopleAdmin(ctx.actorRole);
    const group = findOrganizationGroup(ctx.organizationGroups, body);
    if (!group) throw new Error('Organization group was not found.');
    const target = findOrganizationGroupMember(group, body);
    if (!target) {
      if (attempt === 0) throw new Error('Organization group member was not found.');
      return organizationDirectory(db, organizationId, actorId);
    }
    const policyVersion = await governancePolicyVersionPlan(db, organizationId);
    try {
      await db.transact([
        governanceActorGuard(ctx, organizationId, actorId),
        policyVersion.guard,
        {
          table: 'organization_group_members',
          op: 'expect',
          id: target.id,
          where: [
            ['organizationId', '==', organizationId],
            ['groupId', '==', group.id],
            ['organizationMemberId', '==', target.organizationMemberId],
            ['userId', '==', target.userId],
          ],
          exists: true,
        },
        { table: 'organization_group_members', op: 'delete', id: target.id },
        policyVersion.write,
      ]);
      removed = target;
      removedGroup = group;
      break;
    } catch (error) {
      if (!isTransactionConflictError(error)) throw error;
    }
  }
  if (!removed || !removedGroup) {
    throw Object.assign(
      new Error('Organization group membership changed concurrently. Retry the request.'),
      { status: 409 },
    );
  }
  await recordOrganizationAudit(db, {
    organizationId,
    workspaceId: null,
    actorId,
    action: 'organization_group_member.remove',
    targetType: 'organization_group_member',
    targetId: removed.id,
    metadata: {
      groupId: removedGroup.id,
      groupName: removedGroup.name,
      userId: removed.userId,
    },
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
    verificationMethod: 'dns_txt',
    verificationToken: `verify_${newToken()}${newToken().slice(0, 8)}`,
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
  if (!target.verificationToken) {
    throw new Error('This domain predates DNS verification. Remove it and add it again to issue a TXT challenge.');
  }
  const now = nowIso();
  const verification = await verifyDomainTxtRecord(target.domain, target.verificationToken);
  if (!verification.verified) {
    await db.table<OrganizationDomain>('organization_domains').update(target.id, {
      verificationCheckedAt: now,
      verificationError: verification.reason ?? 'The expected TXT value was not found.',
      updatedAt: now,
    });
    throw new Error(
      `${verification.reason ?? 'Domain verification failed'} Add ${verification.recordName} with value ${verification.recordValue}.`,
    );
  }
  const domain = await db.table<OrganizationDomain>('organization_domains').update(target.id, {
    status: 'verified',
    verificationCheckedAt: now,
    verificationError: null,
    verifiedAt: now,
    verifiedBy: actorId,
    updatedAt: now,
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
  // The client cannot safely follow workspace creation with a fire-and-forget
  // suppression request: on a slow runtime the newly selected workspace can
  // claim the prompt first. Persist the explicit start choice before exposing
  // the new workspace to the client.
  if (body.suppressNotionImportOnboarding === true) {
    await recordNotionImportOnboardingSuppression(db, workspace.id, actorId, now);
  }
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

function isStarterOnlyWorkspacePage(page: Page) {
  return (
    page.parentType === 'workspace' &&
    page.kind === 'page' &&
    (page.title === 'Welcome to Hanji!' || page.title === 'Hanji에 오신 것을 환영합니다!') &&
    page.icon === '👋' &&
    page.iconType === 'emoji'
  );
}

function isInstanceAdministrator(settings: InstanceSettings, actorId: string) {
  return (
    settings.masterUserId === actorId ||
    (Array.isArray(settings.instanceAdminUserIds) && settings.instanceAdminUserIds.includes(actorId))
  );
}

async function claimNotionImportOnboarding(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
) {
  const workspaceId = requireString(body.workspaceId ?? body.id, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  assertWorkspaceAdmin(ctx.currentRole);
  if (!isInstanceAdministrator(await getInstanceSettings(db), actorId)) {
    return { show: false };
  }

  const onboarding = db.table<WorkspaceOnboarding>('workspace_onboarding');
  if (await getExisting(onboarding, workspaceId)) return { show: false };

  const contentDb = boundedDb(admin, workspaceId);
  const [pages, jobs, connections] = await Promise.all([
    listAll(contentDb.table<Page>('pages').where('workspaceId', '==', workspaceId)),
    listAll(contentDb.table<{ id: string }>('notion_import_jobs').where('workspaceId', '==', workspaceId)),
    listAll(contentDb.table<{ id: string }>('notion_import_connections').where('workspaceId', '==', workspaceId)),
  ]);
  const activePages = pages.filter((page) => !page.inTrash);
  const starterOnly =
    activePages.length === 0 ||
    (activePages.length === 1 && isStarterOnlyWorkspacePage(activePages[0]));
  if (!starterOnly || jobs.length > 0 || connections.length > 0) {
    return { show: false };
  }

  const now = nowIso();
  try {
    await db.transact([
      { table: 'workspace_onboarding', op: 'expect', id: workspaceId, exists: false },
      {
        table: 'workspace_onboarding',
        op: 'insert',
        data: {
          id: workspaceId,
          workspaceId,
          notionImportState: 'presented',
          notionImportPresentedAt: now,
          notionImportPresentedBy: actorId,
        },
      },
    ]);
    return { show: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Transaction expectation failed')) {
      return { show: false };
    }
    throw error;
  }
}

async function suppressNotionImportOnboarding(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
) {
  const workspaceId = requireString(body.workspaceId ?? body.id, 'workspaceId');
  const ctx = await workspaceContext(db, workspaceId, actorId);
  assertWorkspaceAdmin(ctx.currentRole);
  await recordNotionImportOnboardingSuppression(db, workspaceId, actorId);
  return { suppressed: true };
}

async function recordNotionImportOnboardingSuppression(
  db: DbRef,
  workspaceId: string,
  actorId: string,
  suppressedAt = nowIso(),
) {
  const onboarding = db.table<WorkspaceOnboarding>('workspace_onboarding');
  if (await getExisting(onboarding, workspaceId)) return;
  try {
    await db.transact([
      { table: 'workspace_onboarding', op: 'expect', id: workspaceId, exists: false },
      {
        table: 'workspace_onboarding',
        op: 'insert',
        data: {
          id: workspaceId,
          workspaceId,
          notionImportState: 'suppressed',
          notionImportSuppressedAt: suppressedAt,
          notionImportSuppressedBy: actorId,
        },
      },
    ]);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('Transaction expectation failed'))) {
      throw error;
    }
  }
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
  const teamspacesTable = contentReadDb.table<{ id: string; workspaceId: string }>('teamspaces');
  const teamspaceMembersTable = contentReadDb.table<{ id: string; workspaceId: string }>('teamspace_members');
  const teamspaceJoinRequestsTable = contentReadDb.table<{ id: string; workspaceId: string }>('teamspace_join_requests');
  const teamspaceSettingsTable = contentReadDb.table<{ id: string; workspaceId: string }>('teamspace_settings');
  const organizationAuditOutboxTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'organization_audit_outbox',
  );
  const pagesTable = contentReadDb.table<Page>('pages');
  const blocksTable = contentReadDb.table<Block>('blocks');
  const commentsTable = contentReadDb.table<Comment>('comments');
  const permissionsTable = contentReadDb.table<PagePermission>('page_permissions');
  const searchGroupAuthoritiesTable = contentReadDb.table<{ id: string; workspaceId: string }>('search_group_authorities');
  const searchGroupMembershipsTable = contentReadDb.table<{ id: string; workspaceId: string }>('search_group_memberships');
  const searchGroupMembershipSnapshotsTable = contentReadDb.table<{ id: string; workspaceId: string }>('search_group_membership_snapshots');
  const shareLinksTable = contentReadDb.table<ShareLink>('share_links');
  const formLinksTable = contentReadDb.table<FormLink>('form_links');
  const propertiesTable = contentReadDb.table<DbProperty>('db_properties');
  const viewsTable = contentReadDb.table<DbView>('db_views');
  const templatesTable = contentReadDb.table<DbTemplate>('db_templates');
  const operationsTable = contentReadDb.table<CollaborationOperation>('collaboration_operations');
  const collaborationDocumentsTable = contentReadDb.table<CollaborationDocument>('collaboration_documents');
  const indexTable = contentReadDb.table<DbPropertyIndex>('db_property_indexes');
  const databaseAutomationsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_automations',
  );
  const databaseAutomationEventsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_automation_events',
  );
  const databaseAutomationEventWorkersTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_automation_event_workers',
  );
  const databaseAutomationScheduleWorkersTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_automation_schedule_workers',
  );
  const databaseAutomationDeliveriesTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_automation_deliveries',
  );
  const databaseAutomationDeliveryWorkersTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_automation_delivery_workers',
  );
  const dependencyEdgesTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_dependency_edges',
  );
  const taskFeatureConfigReceiptsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_task_feature_config_receipts',
  );
  const taskFeatureDisableJobsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_task_feature_disable_jobs',
  );
  const dependencyValidationJobsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_dependency_validation_jobs',
  );
  const dependencyValidationItemsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_dependency_validation_items',
  );
  const dependencyMutationReceiptsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_dependency_mutation_receipts',
  );
  const dependencyDateShiftJobsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_dependency_date_shift_jobs',
  );
  const dependencyDateShiftItemsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_dependency_date_shift_items',
  );
  const dependencyDateShiftReceiptsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_dependency_date_shift_receipts',
  );
  const hierarchyMovesTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_hierarchy_moves',
  );
  const hierarchyMoveReceiptsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_hierarchy_move_receipts',
  );
  const hierarchyLifecycleJobsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_hierarchy_lifecycle_jobs',
  );
  const hierarchyLifecycleItemsTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_hierarchy_lifecycle_items',
  );
  const hierarchyRelationUpdatesTable = contentReadDb.table<{ id: string; workspaceId: string }>(
    'database_hierarchy_relation_updates',
  );
  const uploadsTable = contentReadDb.table<FileUpload>('file_uploads');
  const nativeArchiveImportsTable = contentReadDb.table<{ id: string; workspaceId: string }>('native_archive_imports');
  const notificationsTable = db.table<NotificationRecord>('notifications');
  const fileMaintenanceRunsTable = db.table<FileMaintenanceRun>('file_maintenance_runs');
  const fileMaintenanceQueueTable = db.table<{ id: string; workspaceId: string }>('file_maintenance_queue');
  const pageWorkspaceIndexesTable = db.table<{ id: string; workspaceId: string }>('page_workspace_index');
  const formLinkIndexesTable = db.table<{ id: string; workspaceId: string }>('form_link_index');
  const workspace = ctx.workspace;
  const pages = await listAll(pagesTable.where('workspaceId', '==', id));
  const pageIds = pages.map((page) => page.id);
  const databaseIds = pages.filter((page) => page.kind === 'database').map((page) => page.id);
  if (pages.length > 0) {
    const confirmedName = typeof body.confirmWorkspaceName === 'string' ? body.confirmWorkspaceName.trim() : '';
    if (confirmedName !== workspace.name) {
      throw new Error('Type the workspace name to delete this workspace.');
    }
    const custodianUserIds = Array.from(new Set(pages.flatMap((page) =>
      [page.createdBy, page.lastEditedBy].filter((userId): userId is string => Boolean(userId)),
    )));
    await assertNoActiveLegalHoldForPermanentDelete(db, id, pageIds, custodianUserIds);
  }
  const notionImportArtifacts = await collectWorkspaceNotionImportArtifacts(contentReadDb, id);
  const activeNotionImportJobs = notionImportArtifacts.jobs.filter((job) =>
    job.status === 'queued' ||
    job.status === 'discovering' ||
    job.progress?.currentStatus === 'running'
  );
  if (activeNotionImportJobs.length > 0) {
    throw fileOperationConflict('Cancel active Notion imports before deleting this workspace.');
  }
  await markFileDeletionPending(db, id);

  const [
    teamspaces,
    teamspaceMembers,
    teamspaceJoinRequests,
    teamspaceSettings,
    organizationAuditOutbox,
    blocks,
    comments,
    operations,
    collaborationDocuments,
    permissions,
    searchGroupAuthorities,
    searchGroupMemberships,
    searchGroupMembershipSnapshots,
    shareLinks,
    formLinks,
    properties,
    views,
    templates,
    indexRows,
    databaseAutomations,
    databaseAutomationEvents,
    databaseAutomationEventWorkers,
    databaseAutomationScheduleWorkers,
    databaseAutomationDeliveries,
    databaseAutomationDeliveryWorkers,
    dependencyEdges,
    taskFeatureConfigReceipts,
    taskFeatureDisableJobs,
    dependencyValidationJobs,
    dependencyValidationItems,
    dependencyMutationReceipts,
    dependencyDateShiftJobs,
    dependencyDateShiftItems,
    dependencyDateShiftReceipts,
    hierarchyMoves,
    hierarchyMoveReceipts,
    hierarchyLifecycleJobs,
    hierarchyLifecycleItems,
    hierarchyRelationUpdates,
    uploads,
    nativeArchiveImports,
    notifications,
    fileMaintenanceRuns,
    fileMaintenanceQueue,
    pageWorkspaceIndexes,
    formLinkIndexes,
  ] = await Promise.all([
    listAll(teamspacesTable.where('workspaceId', '==', id)),
    listAll(teamspaceMembersTable.where('workspaceId', '==', id)),
    listAll(teamspaceJoinRequestsTable.where('workspaceId', '==', id)),
    listAll(teamspaceSettingsTable.where('workspaceId', '==', id)),
    listAll(organizationAuditOutboxTable.where('workspaceId', '==', id)),
    listByIds(blocksTable, 'pageId', pageIds),
    listByIds(commentsTable, 'pageId', pageIds),
    listByIds(operationsTable, 'pageId', pageIds),
    listByIds(collaborationDocumentsTable, 'pageId', pageIds),
    listAll(permissionsTable.where('workspaceId', '==', id)),
    listAll(searchGroupAuthoritiesTable.where('workspaceId', '==', id)),
    listAll(searchGroupMembershipsTable.where('workspaceId', '==', id)),
    listAll(searchGroupMembershipSnapshotsTable.where('workspaceId', '==', id)),
    listAll(shareLinksTable.where('workspaceId', '==', id)),
    listAll(formLinksTable.where('workspaceId', '==', id)),
    listByIds(propertiesTable, 'databaseId', databaseIds),
    listByIds(viewsTable, 'databaseId', databaseIds),
    listByIds(templatesTable, 'databaseId', databaseIds),
    listAll(indexTable.where('workspaceId', '==', id)),
    listAll(databaseAutomationsTable.where('workspaceId', '==', id)),
    listAll(databaseAutomationEventsTable.where('workspaceId', '==', id)),
    listAll(databaseAutomationEventWorkersTable.where('workspaceId', '==', id)),
    listAll(databaseAutomationScheduleWorkersTable.where('workspaceId', '==', id)),
    listAll(databaseAutomationDeliveriesTable.where('workspaceId', '==', id)),
    listAll(databaseAutomationDeliveryWorkersTable.where('workspaceId', '==', id)),
    listAll(dependencyEdgesTable.where('workspaceId', '==', id)),
    listAll(taskFeatureConfigReceiptsTable.where('workspaceId', '==', id)),
    listAll(taskFeatureDisableJobsTable.where('workspaceId', '==', id)),
    listAll(dependencyValidationJobsTable.where('workspaceId', '==', id)),
    listAll(dependencyValidationItemsTable.where('workspaceId', '==', id)),
    listAll(dependencyMutationReceiptsTable.where('workspaceId', '==', id)),
    listAll(dependencyDateShiftJobsTable.where('workspaceId', '==', id)),
    listAll(dependencyDateShiftItemsTable.where('workspaceId', '==', id)),
    listAll(dependencyDateShiftReceiptsTable.where('workspaceId', '==', id)),
    listAll(hierarchyMovesTable.where('workspaceId', '==', id)),
    listAll(hierarchyMoveReceiptsTable.where('workspaceId', '==', id)),
    listAll(hierarchyLifecycleJobsTable.where('workspaceId', '==', id)),
    listAll(hierarchyLifecycleItemsTable.where('workspaceId', '==', id)),
    listAll(hierarchyRelationUpdatesTable.where('workspaceId', '==', id)),
    listAll(uploadsTable.where('workspaceId', '==', id)),
    listAll(nativeArchiveImportsTable.where('workspaceId', '==', id)),
    listAll(notificationsTable.where('workspaceId', '==', id)),
    listAll(fileMaintenanceRunsTable.where('workspaceId', '==', id)),
    getExisting(fileMaintenanceQueueTable, id),
    listAll(pageWorkspaceIndexesTable.where('workspaceId', '==', id)),
    listAll(formLinkIndexesTable.where('workspaceId', '==', id)),
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
    ...teamspaceJoinRequests.map((item): TransactOperation => ({
      table: 'teamspace_join_requests', op: 'delete', id: item.id,
    })),
    ...teamspaceMembers.map((item): TransactOperation => ({
      table: 'teamspace_members', op: 'delete', id: item.id,
    })),
    ...teamspaceSettings.map((item): TransactOperation => ({
      table: 'teamspace_settings', op: 'delete', id: item.id,
    })),
    ...organizationAuditOutbox.map((item): TransactOperation => ({
      table: 'organization_audit_outbox', op: 'delete', id: item.id,
    })),
    ...indexRows.map((item): TransactOperation => ({ table: 'db_property_indexes', op: 'delete', id: item.id })),
    ...databaseAutomationDeliveries.map((item): TransactOperation => ({
      table: 'database_automation_deliveries', op: 'delete', id: item.id,
    })),
    ...databaseAutomations.map((item): TransactOperation => ({
      table: 'database_automations', op: 'delete', id: item.id,
    })),
    ...databaseAutomationEvents.map((item): TransactOperation => ({
      table: 'database_automation_events', op: 'delete', id: item.id,
    })),
    ...databaseAutomationEventWorkers.map((item): TransactOperation => ({
      table: 'database_automation_event_workers', op: 'delete', id: item.id,
    })),
    ...databaseAutomationScheduleWorkers.map((item): TransactOperation => ({
      table: 'database_automation_schedule_workers', op: 'delete', id: item.id,
    })),
    ...databaseAutomationDeliveryWorkers.map((item): TransactOperation => ({
      table: 'database_automation_delivery_workers', op: 'delete', id: item.id,
    })),
    ...dependencyEdges.map((item): TransactOperation => ({
      table: 'database_dependency_edges', op: 'delete', id: item.id,
    })),
    ...taskFeatureDisableJobs.map((item): TransactOperation => ({
      table: 'database_task_feature_disable_jobs', op: 'delete', id: item.id,
    })),
    ...taskFeatureConfigReceipts.map((item): TransactOperation => ({
      table: 'database_task_feature_config_receipts', op: 'delete', id: item.id,
    })),
    ...dependencyValidationItems.map((item): TransactOperation => ({
      table: 'database_dependency_validation_items', op: 'delete', id: item.id,
    })),
    ...dependencyValidationJobs.map((item): TransactOperation => ({
      table: 'database_dependency_validation_jobs', op: 'delete', id: item.id,
    })),
    ...dependencyMutationReceipts.map((item): TransactOperation => ({
      table: 'database_dependency_mutation_receipts', op: 'delete', id: item.id,
    })),
    ...dependencyDateShiftItems.map((item): TransactOperation => ({
      table: 'database_dependency_date_shift_items', op: 'delete', id: item.id,
    })),
    ...dependencyDateShiftJobs.map((item): TransactOperation => ({
      table: 'database_dependency_date_shift_jobs', op: 'delete', id: item.id,
    })),
    ...dependencyDateShiftReceipts.map((item): TransactOperation => ({
      table: 'database_dependency_date_shift_receipts', op: 'delete', id: item.id,
    })),
    ...hierarchyMoves.map((item): TransactOperation => ({
      table: 'database_hierarchy_moves', op: 'delete', id: item.id,
    })),
    ...hierarchyMoveReceipts.map((item): TransactOperation => ({
      table: 'database_hierarchy_move_receipts', op: 'delete', id: item.id,
    })),
    ...hierarchyLifecycleItems.map((item): TransactOperation => ({
      table: 'database_hierarchy_lifecycle_items', op: 'delete', id: item.id,
    })),
    ...hierarchyRelationUpdates.map((item): TransactOperation => ({
      table: 'database_hierarchy_relation_updates', op: 'delete', id: item.id,
    })),
    ...hierarchyLifecycleJobs.map((item): TransactOperation => ({
      table: 'database_hierarchy_lifecycle_jobs', op: 'delete', id: item.id,
    })),
    ...collaborationDocuments.map((item): TransactOperation => ({ table: 'collaboration_documents', op: 'delete', id: item.id })),
    ...operations.map((item): TransactOperation => ({ table: 'collaboration_operations', op: 'delete', id: item.id })),
    ...blocks.map((item): TransactOperation => ({ table: 'blocks', op: 'delete', id: item.id })),
    ...comments.map((item): TransactOperation => ({ table: 'comments', op: 'delete', id: item.id })),
    ...permissions.map((item): TransactOperation => ({ table: 'page_permissions', op: 'delete', id: item.id })),
    ...searchGroupMemberships.map((item): TransactOperation => ({ table: 'search_group_memberships', op: 'delete', id: item.id })),
    ...searchGroupMembershipSnapshots.map((item): TransactOperation => ({ table: 'search_group_membership_snapshots', op: 'delete', id: item.id })),
    ...searchGroupAuthorities.map((item): TransactOperation => ({ table: 'search_group_authorities', op: 'delete', id: item.id })),
    ...shareLinks.map((item): TransactOperation => ({ table: 'share_links', op: 'delete', id: item.id })),
    ...formLinks.map((item): TransactOperation => ({ table: 'form_links', op: 'delete', id: item.id })),
    ...templates.map((item): TransactOperation => ({ table: 'db_templates', op: 'delete', id: item.id })),
    ...views.map((item): TransactOperation => ({ table: 'db_views', op: 'delete', id: item.id })),
    ...properties.map((item): TransactOperation => ({ table: 'db_properties', op: 'delete', id: item.id })),
    ...uploads.map((item): TransactOperation => ({ table: 'file_uploads', op: 'delete', id: item.id })),
    ...nativeArchiveImports.map((item): TransactOperation => ({ table: 'native_archive_imports', op: 'delete', id: item.id })),
    ...notionImportArtifacts.items.map((item): TransactOperation => ({ table: 'notion_import_items', op: 'delete', id: item.id })),
    ...notionImportArtifacts.mappings.map((item): TransactOperation => ({ table: 'notion_import_mappings', op: 'delete', id: item.id })),
    ...notionImportArtifacts.locks.map((item): TransactOperation => ({ table: 'notion_import_apply_locks', op: 'delete', id: item.id })),
    ...notionImportArtifacts.jobs.map((item): TransactOperation => ({ table: 'notion_import_jobs', op: 'delete', id: item.id })),
    ...notionImportArtifacts.connections.map((item): TransactOperation => ({ table: 'notion_import_connections', op: 'delete', id: item.id })),
    ...pageIds.map((pageId): TransactOperation => ({ table: 'pages', op: 'delete', id: pageId })),
    ...teamspaces.map((item): TransactOperation => ({ table: 'teamspaces', op: 'delete', id: item.id })),
  ];
  const retryPrincipal = ctx.members.find((member) => member.userId === actorId) ?? null;
  const centralCleanupOps: TransactOperation[] = [
    ...pageWorkspaceIndexes.map((item): TransactOperation => ({
      table: 'page_workspace_index', op: 'delete', id: item.id,
    })),
    ...formLinkIndexes.map((item): TransactOperation => ({
      table: 'form_link_index', op: 'delete', id: item.id,
    })),
    ...notifications.map((item): TransactOperation => ({ table: 'notifications', op: 'delete', id: item.id })),
    ...fileMaintenanceRuns.map((item): TransactOperation => ({ table: 'file_maintenance_runs', op: 'delete', id: item.id })),
    ...(fileMaintenanceQueue
      ? [{ table: 'file_maintenance_queue', op: 'delete' as const, id: fileMaintenanceQueue.id }]
      : []),
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
        deletedNativeArchiveImports: nativeArchiveImports.length,
        deletedShareLinks: shareLinks.length,
        deletedFormLinks: formLinks.length,
        deletedFormLinkIndexes: formLinkIndexes.length,
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
      nativeArchiveImports: nativeArchiveImports.length,
      shareLinks: shareLinks.length,
      formLinks: formLinks.length,
      formLinkIndexes: formLinkIndexes.length,
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

  if (!existing) {
    const settings = await getInstanceSettings(db);
    if (parseMemberAddPolicy(settings.memberAddPolicy, 'enabled') !== 'enabled') {
      throw new Error('Workspace member additions are disabled by instance policy.');
    }
  }

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
  const { auth, admin, request, storage, env } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const db = admin.db('app');

  try {
    if (TEAMSPACE_MUTATION_ACTIONS.has(action)) {
      const workspaceId = requireString(body.workspaceId, 'workspaceId');
      return await handleTeamspaceMutation({
        db: boundedDb(admin, workspaceId),
        actorId: auth.id,
        body,
      });
    }
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
        return await updateOrganizationEnterpriseControls(db, admin.auth, env, body, auth.id);
      case 'setOrganizationMcpGovernanceEnabled':
        return await mutateOrganizationMcpGovernance(db, body, auth.id, 'set_enabled');
      case 'approveOrganizationMcpClient':
        return await mutateOrganizationMcpGovernance(db, body, auth.id, 'approve');
      case 'removeOrganizationMcpClient':
        return await mutateOrganizationMcpGovernance(db, body, auth.id, 'remove');
      case 'renameOrganizationMcpClient':
        return await mutateOrganizationMcpGovernance(db, body, auth.id, 'rename');
      case 'createOrganizationScimToken':
        return await createOrganizationScimToken(db, body, auth.id);
      case 'revokeOrganizationScimToken':
        return await revokeOrganizationScimToken(db, body, auth.id);
      case 'createOrganizationLegalHold':
        return await createOrganizationLegalHold(db, body, auth.id);
      case 'releaseOrganizationLegalHold':
        return await releaseOrganizationLegalHold(db, body, auth.id);
      case 'exportOrganizationAuditEvents':
        return await exportOrganizationAuditEvents(db, body, auth.id);
      case 'exportOrganizationDiscovery':
        return await exportOrganizationDiscovery(db, admin, body, auth.id);
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
        return await deleteOrganizationGroup(db, admin, body, auth.id);
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
      case 'claimNotionImportOnboarding':
        return await claimNotionImportOnboarding(db, admin, body, auth.id);
      case 'suppressNotionImportOnboarding':
        return await suppressNotionImportOnboarding(db, body, auth.id);
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
      {
        status: 400,
        needles: [
          'Disable domain-restricted signup',
          'DNS verification',
          'DNS resolver',
          'TXT value',
          'TXT challenge',
          'Verify an organization domain',
          'SSO runtime provider',
          'Strict data residency',
          'HANJI_DATA_REGION',
        ],
      },
      {
        status: 403,
        needles: [
          'access required',
          'Forbidden',
          'can create workspaces',
          'disabled by organization policy',
          'disabled by instance policy',
        ],
      },
    ]);
    return jsonError(status, message);
  }
});
