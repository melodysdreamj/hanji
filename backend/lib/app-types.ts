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

export type { ShareRole };

export type PageParentType = 'workspace' | 'page' | 'database';
export type PageKind = 'page' | 'database';
export type PrincipalType = 'user' | 'email' | 'group' | 'integration';
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
export type NotificationKind = 'comment' | 'mention' | 'link' | 'page_edit' | 'system';
export type FileUploadStatus = 'pending' | 'uploaded' | 'deleted' | 'expired';

export interface Workspace {
  id: string;
  organizationId?: string | null;
  name?: string;
  icon?: string;
  domain?: string;
  ownerId?: string;
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
  joinedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationGroup {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
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

export interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType: PageParentType;
  kind: PageKind;
  title?: string;
  icon?: string;
  iconType?: 'none' | 'emoji' | 'image';
  cover?: string;
  coverPosition?: number;
  font?: 'default' | 'serif' | 'mono';
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: 'default' | 'expanded' | 'off';
  pageCommentsDisplay?: 'default' | 'expanded' | 'off';
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verificationExpiresAt?: string | null;
  properties?: Record<string, unknown>;
  isFavorite?: boolean;
  inTrash?: boolean;
  trashedAt?: string | null;
  position: number;
  createdBy?: string;
  lastEditedBy?: string;
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
  createdAt?: string;
  updatedAt?: string;
}

export interface DbProperty {
  id: string;
  databaseId: string;
  name: string;
  description?: string;
  type: string;
  config?: Record<string, unknown>;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbView {
  id: string;
  databaseId: string;
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
  databaseId?: string | null;
  propertyId?: string | null;
  name?: string;
  contentType?: string;
  size?: number;
  status?: FileUploadStatus;
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
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

export interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  getList(): Promise<ListResult<T>>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
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
  delete(key: string): Promise<void>;
}

export interface FunctionContext {
  auth: FunctionAuth | null;
  request?: Request;
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
