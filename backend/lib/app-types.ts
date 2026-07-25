// Canonical row/domain types for the `app` database block.
//
// Single source of truth for the record shapes that functions/*.ts previously
// re-declared locally. Field required-ness follows backend/edgebase.config.ts:
// `required: true` columns and columns with a schema default are non-optional
// (EdgeBase fills defaults on insert); everything else is optional. `id`,
// `createdAt`, `updatedAt` are injected by EdgeBase, but `createdAt`/`updatedAt`
// stay optional because fixtures and partial reads may omit them.
import type { ShareRole } from './page-access';
import type { ListResult, TableQuery, TransactDb } from './table-utils';
import type { DatabasePropertyType } from './database-property-types';

export type { ShareRole };

export type PageParentType = 'workspace' | 'page' | 'database';
export type PageKind = 'page' | 'database';
export type PrincipalType = 'user' | 'email' | 'group' | 'integration';
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
export type NotificationKind = 'comment' | 'mention' | 'link' | 'page_edit' | 'system';
export type FileUploadStatus =
  | 'preparing'
  | 'pending'
  | 'uploaded'
  | 'deleting'
  | 'deleted'
  | 'expired'
  | 'failed';

export interface Workspace {
  id: string;
  organizationId?: string | null;
  name?: string;
  icon?: string;
  domain?: string;
  ownerId?: string;
  deletionPendingAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  displayName?: string;
  email?: string;
  avatar?: string | null;
  role: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  displayName?: string;
  email?: string;
  avatar?: string | null;
  role: string;
  status?: string;
  externalId?: string | null;
  provisionedBy?: string | null;
  joinedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationGroup {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  externalId?: string | null;
  provisionedBy?: string | null;
  createdBy?: string;
}

export interface OrganizationGroupMember {
  id: string;
  organizationId?: string;
  groupId: string;
  organizationMemberId?: string;
  userId: string;
  role?: string;
  createdBy?: string;
}

export interface OrganizationPolicyVersion {
  id: string;
  organizationId: string;
  version: number;
}

export interface SearchGroupAuthority {
  id: string;
  workspaceId: string;
  organizationId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SearchGroupMembership {
  id: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
  organizationMemberId: string;
  groupId: string;
  sourceMembershipId: string;
  policyVersion: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface SearchGroupMembershipSnapshot {
  id: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
  organizationMemberId: string;
  policyVersion: number;
  syncAfter?: string | null;
  syncComplete?: boolean;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType: PageParentType;
  teamspaceId?: string | null;
  teamspacePermissionMode?: 'inherit' | 'restricted' | string;
  kind: PageKind;
  title?: string;
  icon?: string;
  iconType?: 'none' | 'emoji' | 'image';
  cover?: string;
  notionIcon?: Record<string, unknown> | null;
  notionCover?: Record<string, unknown> | null;
  databaseFeatures?: Record<string, unknown> | null;
  databaseFeaturesRevision?: number;
  subitemParentId?: string;
  subitemChildCount?: number;
  /** Transient restricted-ancestor projection; never persisted as page content. */
  __structuralPlaceholder?: true;
  coverPosition?: number;
  font?: 'default' | 'serif' | 'mono';
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: 'default' | 'expanded' | 'off';
  pageCommentsDisplay?: 'default' | 'expanded' | 'off';
  isWiki?: boolean;
  wikiRootId?: string | null;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verificationExpiresAt?: string | null;
  properties?: Record<string, unknown>;
  notionImportJobId?: string | null;
  notionImportSourceId?: string | null;
  notionImportSourceKind?: string | null;
  notionImportStaging?: boolean;
  isFavorite?: boolean;
  inTrash?: boolean;
  trashedAt?: string | null;
  deletionPendingAt?: string | null;
  position: number;
  createdBy?: string;
  lastEditedBy?: string;
  lastMutationId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PageOwner {
  id: string;
  workspaceId: string;
  pageId: string;
  wikiRootId: string;
  userId: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WikiVerificationQueue {
  id: string;
  workspaceId: string;
  pageId: string;
  expiresAt: string;
  state: 'pending' | 'retrying';
  attempts: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface WikiVerificationEmailDelivery {
  id: string;
  workspaceId: string;
  pageId: string;
  userId: string;
  expiresAt: string;
  email?: string | null;
  status: 'pending' | 'sent' | 'failed' | 'not_configured' | 'no_email';
  attempts: number;
  lastError?: string | null;
  sentAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Block {
  id: string;
  pageId: string;
  parentId?: string | null;
  type: string;
  content?: Record<string, unknown>;
  plainText?: string;
  position: number;
  createdBy?: string;
  lastEditedBy?: string;
  lastMutationId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbProperty {
  id: string;
  databaseId: string;
  notionImportJobId?: string;
  notionDataSourceId?: string;
  notionPropertyId?: string;
  name: string;
  description?: string;
  type: DatabasePropertyType;
  config?: Record<string, unknown>;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbView {
  id: string;
  databaseId: string;
  notionImportJobId?: string;
  notionDataSourceId?: string;
  notionViewId?: string;
  notionViewStructuralIndex?: number;
  notionImportSnapshotRevision?: string;
  notionViewFingerprint?: string;
  notionRowContextJobId?: string;
  notionRowContextSnapshotRevision?: string;
  notionRowContextBlockId?: string;
  notionRowContextSourceViewId?: string;
  notionRowContextFingerprint?: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbTemplate {
  id: string;
  databaseId: string;
  notionImportJobId?: string;
  notionTemplateId?: string;
  notionDataSourceId?: string;
  notionTemplateStructuralIndex?: number;
  notionImportSnapshotRevision?: string;
  notionTemplateFingerprint?: string;
  name: string;
  icon?: string;
  title?: string;
  properties?: Record<string, unknown>;
  blocks?: unknown[];
  isDefault?: boolean;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AutomationExecutionReceipt {
  id: string;
  workspaceId: string;
  databaseId?: string;
  sourceType: 'database_button' | 'page_button' | 'database_automation';
  sourceId: string;
  triggerPageId: string;
  requestedBy: string;
  requestHash: string;
  status: 'succeeded' | 'failed';
  result?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface DatabaseAutomationDefinition {
  id: string;
  workspaceId: string;
  databaseId: string;
  name: string;
  enabled: boolean;
  scopeType: 'database' | 'view';
  viewId?: string | null;
  triggerType: 'events' | 'schedule';
  trigger: Record<string, unknown>;
  actionDocument: Record<string, unknown>;
  nextRunAt?: string | null;
  status: 'active' | 'disabled' | 'paused';
  revision: number;
  createdBy: string;
  updatedBy: string;
  pausedAt?: string | null;
  pausedReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Comment {
  id: string;
  pageId: string;
  blockId?: string | null;
  parentId?: string | null;
  authorId: string;
  body?: unknown;
  resolved?: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** Set only when the BODY is edited (resolve/move also bump updatedAt). */
  editedAt?: string;
}

export interface PagePermission {
  id: string;
  pageId: string;
  workspaceId: string;
  principalType: PrincipalType;
  principalId?: string;
  label: string;
  role: ShareRole;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ShareLink {
  id: string;
  pageId: string;
  workspaceId: string;
  token: string;
  enabled: boolean;
  role: ShareRole;
  expiresAt?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SiteTheme = 'system' | 'light' | 'dark';
export type SiteDomainStatus = 'none' | 'pending_validation' | 'validated';

export interface SiteConfig {
  id: string;
  pageId: string;
  workspaceId: string;
  slug: string;
  published: boolean;
  title: string;
  description?: string;
  theme: SiteTheme;
  showBreadcrumbs: boolean;
  showSearch: boolean;
  showBranding: boolean;
  navigationPageIds: string[];
  customHostname?: string | null;
  domainStatus: SiteDomainStatus;
  domainVerificationToken?: string | null;
  revision: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SiteRouteStatus = 'provisioning' | 'pending_validation' | 'active' | 'inactive';

export interface SiteRouteIndex {
  id: string;
  routeKey: string;
  routeKind: 'slug' | 'host';
  routeValue: string;
  workspaceId: string;
  siteId: string;
  pageId: string;
  status: SiteRouteStatus;
  revision: number;
  createdAt?: string;
  updatedAt?: string;
}

export type FormAudience = 'none' | 'workspace' | 'web';

export interface FormLink {
  id: string;
  workspaceId: string;
  databaseId: string;
  viewId: string;
  token: string;
  audience: FormAudience;
  enabled: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotificationRecord {
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
}

export interface FileUpload {
  id: string;
  workspaceId: string;
  bucket?: string;
  key: string;
  scope?: string;
  pageId?: string | null;
  blockId?: string | null;
  commentId?: string | null;
  databaseId?: string | null;
  propertyId?: string | null;
  templateId?: string | null;
  name?: string;
  contentType?: string;
  size?: number;
  etag?: string;
  status?: FileUploadStatus;
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  orphanReferenceCheckedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionPreviousStatus?: 'preparing' | 'pending' | 'uploaded' | null;
  mode?: 'single_part' | 'multi_part' | 'external_url';
  numberOfPartsTotal?: number;
  numberOfPartsSent?: number;
  multipartUploadId?: string | null;
  multipartParts?: Array<{ partNumber: number; etag: string; size: number }>;
  externalUrl?: string | null;
  fileImportResult?: unknown;
  notionImportJobId?: string | null;
  notionImportSnapshotRevision?: string | null;
  notionImportSlotKey?: string | null;
  notionImportTerminalSweepAfter?: string | null;
  notionImportTerminalSweepCompletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CollaborationOperation {
  id: string;
  workspaceId?: string;
  pageId: string;
  blockId?: string | null;
  clientId?: string;
  kind?: string;
  operation?: Record<string, unknown>;
  beforeText?: string;
  afterText?: string;
  revision?: number;
  actorId?: string;
  occurredAt?: string;
}

export interface CollaborationDocument {
  id: string;
  workspaceId?: string;
  pageId: string;
  blockId?: string | null;
  documentId?: string;
  engine?: string;
  schemaVersion?: number;
  stateBase64?: string;
  stateVectorBase64?: string;
  updateCount?: number;
  lastOperationId?: string | null;
  lastOperationRevision?: number;
  lastOperationOccurredAt?: string | null;
  checkpointedAt?: string | null;
}

// ─── Function runtime plumbing shared by functions/*.ts ─────────────────────

export type SearchRelatedWhere =
  | [field: string, op: '==' | 'in', value: unknown]
  | [field: string, op: 'is-not-true'];

export type SearchRelatedGroupMembership = {
  table: string;
  grantPrincipalField: string;
  membershipGroupField: string;
  whereAll: SearchRelatedWhere[];
};

export type SearchRelatedPrincipalBranch = {
  whereAll: SearchRelatedWhere[];
  groupMembership?: SearchRelatedGroupMembership;
};

export type SearchRelatedGrantSource = {
  table: string;
  ancestorField: string;
  whereAll: SearchRelatedWhere[];
  principalAny: SearchRelatedPrincipalBranch[];
};

export type SearchRelatedAncestry = {
  parentField: string;
  parentTypeField: string;
  stopParentType: string;
  maxDepth: number;
  whereAll: SearchRelatedWhere[];
  requiredAncestorIds?: string[];
  grantSource?: SearchRelatedGrantSource;
};

export type SearchRelatedRelation = {
  localField: string;
  table: string;
  whereAll: SearchRelatedWhere[];
  ancestry?: SearchRelatedAncestry;
};

export type SearchRelatedInput = {
  query: string;
  queryVariants?: string[];
  order: Array<{ field: string; direction: 'asc' }>;
  after?: { values: string[] };
  limit: number;
  includeTotal: boolean;
  relation: SearchRelatedRelation;
};

export interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  getList(): Promise<ListResult<T>>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  search?(query: string): TableQuery<T>;
  searchRelated?(input: SearchRelatedInput): Promise<ListResult<T>>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

// transact is part of the runtime DbRef surface (EdgeBase core); typed here so
// functions can batch multi-table writes atomically.
export interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

export interface FunctionAuth {
  id: string;
  email?: string;
}

export interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  head?(key: string): Promise<{
    key?: string;
    size?: number;
    contentType?: string;
    etag?: string;
  } | null>;
  delete(key: string): Promise<void>;
}

export interface FunctionContext {
  auth: FunctionAuth | null;
  request?: Request;
  env?: Record<string, unknown>;
  email?: {
    readonly supportsIdempotency: boolean;
    send(options: {
      to: string;
      subject: string;
      text: string;
      idempotencyKey: string;
    }): Promise<{ success: boolean; messageId?: string }>;
  };
  admin: {
    db(namespace: string, instanceId?: string): DbRef;
    auth?: {
      getUser(userId: string): Promise<Record<string, unknown>>;
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
      deleteUser(userId: string): Promise<void>;
      setCustomClaims?(userId: string, claims: Record<string, unknown>): Promise<void>;
      revokeAllSessions(userId: string): Promise<void>;
    };
  };
  storage?: FunctionStorageProxy;
}

export type { ListResult, TableQuery };
