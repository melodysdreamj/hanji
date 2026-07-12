import { defineFunction } from '@edge-base/shared';
import { WORKSPACE_CONTENT_TABLES, contentDbsForAllWorkspaces } from '../lib/workspace-db';
import { errorStatus } from '../lib/error-status';
import {
  hanjiEnvFlag,
  hanjiEnvList,
  hanjiEnvListWithOffSentinel,
  hanjiEnvValue,
} from '../lib/hanji-compat';
import {
  getInstanceSettings,
  parseSignupPolicy,
  upsertInstanceSettings,
  type InstanceSettings,
} from '../lib/instance-settings';
import {
  isNotFoundError,
  listAll,
  nowIso,
  requireString,
  type ListAllOptions,
  type TableQuery,
} from '../lib/table-utils';
import type {
  DbRef,
  FileUpload,
  FunctionContext as BaseFunctionContext,
  OrganizationMember,
  Page,
  TableRef,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';

interface FunctionContext extends BaseFunctionContext {
  env?: Record<string, unknown>;
}

interface InstanceAdminUser {
  id: string;
  email?: string | null;
  displayName?: string | null;
  role?: string | null;
  status?: string | null;
  disabled?: boolean;
  verified?: boolean;
  isAnonymous?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastLoginAt?: string | null;
  workspaceCount: number;
  organizationCount: number;
  activeOrganizationCount: number;
  deactivatedOrganizationCount: number;
  isInstanceAdmin: boolean;
}

interface OrganizationRecord {
  id: string;
  name?: string;
  icon?: string | null;
  ownerId?: string;
  workspaceCreationPolicy?: string;
  domainSignupPolicy?: string;
  storageLimitBytes?: number | null;
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
  createdAt?: string;
  updatedAt?: string;
}

interface InstanceAuditEvent {
  id: string;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
  createdAt?: string;
  updatedAt?: string;
}

interface NotionImportJobRecord {
  id: string;
  workspaceId: string;
  source?: string;
  connectionKind?: string;
  connectionId?: string | null;
  status?: string;
  phase?: string;
  actorId?: string;
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  counts?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string | null;
  retryOfJobId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface NotionImportItemRecord {
  id: string;
  workspaceId: string;
  jobId: string;
  status?: string;
  phase?: string;
  localId?: string;
  localType?: string;
  error?: string | null;
}

interface FileMaintenanceRunRecord {
  id: string;
  workspaceId: string;
  kind?: string;
  actorId?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  scanned?: number;
  expired?: number;
  deletedObjects?: number;
  failedObjects?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ServerWorkspaceSummary {
  id: string;
  name?: string | null;
  domain?: string | null;
  ownerId?: string | null;
  organizationId?: string | null;
  memberCount: number;
  pageCount: number;
  databaseCount: number;
  fileCount: number;
  activeStorageBytes: number;
  importJobCount: number;
  failedImportJobCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface ServerAuditSummaryEvent {
  id: string;
  scope: 'instance' | 'organization';
  organizationId?: string | null;
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

interface ServerImportJobSummary {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  status: string;
  phase: string;
  actorId?: string | null;
  notionWorkspaceName?: string | null;
  itemCount: number;
  failedItemCount: number;
  mappedItemCount: number;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

interface ServerUsageSummary {
  totals: {
    files: number;
    activeStorageBytes: number;
    uploadedBytes: number;
    pendingBytes: number;
    deletedBytes: number;
    expiredBytes: number;
  };
  pending: {
    active: number;
    expired: number;
  };
  byWorkspace: Array<{
    workspaceId: string;
    workspaceName?: string | null;
    files: number;
    activeStorageBytes: number;
  }>;
  recentMaintenanceRuns: Array<{
    id: string;
    workspaceId: string;
    workspaceName?: string | null;
    kind?: string | null;
    status?: string | null;
    scanned?: number;
    expired?: number;
    failedObjects?: number;
    startedAt?: string | null;
  }>;
}

interface ServerOverviewSummary {
  generatedAt: string;
  counts: {
    users: number;
    activeUsers: number;
    disabledUsers: number;
    verifiedUsers: number;
    instanceAdmins: number;
    organizations: number;
    workspaces: number;
    pages: number;
    databases: number;
    importJobs: number;
    failedImportJobs: number;
    files: number;
    activeStorageBytes: number;
  };
  health: Array<{
    key: string;
    label: string;
    status: 'ok' | 'attention' | 'missing';
    detail: string;
  }>;
}

interface ServerSecuritySummary {
  sessionRevocationAvailable: boolean;
  mfaResetAvailable: boolean;
  passwordResetAvailable: boolean;
  disabledUsers: number;
  instanceAdmins: number;
  notes: string[];
}

interface ServerBackupSummary {
  generatedAt: string;
  restoreAvailable: boolean;
  downloadableTables: string[];
  tableCounts: Record<string, number>;
  notes: string[];
}

interface ServerSystemSummary {
  generatedAt: string;
  environment: Array<{
    key: string;
    label: string;
    configured: boolean;
    detail: string;
  }>;
}

interface InstanceBackupSnapshot {
  generatedAt: string;
  tableCounts: Record<string, number>;
  tables: Record<string, unknown[]>;
  notes: string[];
}

interface InstanceAdminResult {
  instanceSettings: InstanceSettings;
  instanceAdmins: string[];
  users: InstanceAdminUser[];
  overview: ServerOverviewSummary;
  workspaces: ServerWorkspaceSummary[];
  security: ServerSecuritySummary;
  auditEvents: ServerAuditSummaryEvent[];
  importJobs: ServerImportJobSummary[];
  usage: ServerUsageSummary;
  backup: ServerBackupSummary;
  system: ServerSystemSummary;
  temporaryPassword?: string;
  snapshot?: InstanceBackupSnapshot;
  cursor?: string;
}

function jsonError(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function envList(env: Record<string, unknown> | undefined, ...names: string[]) {
  return hanjiEnvList(env, ...names);
}

function envListWithOffSentinel(
  env: Record<string, unknown> | undefined,
  ...names: string[]
) {
  return hanjiEnvListWithOffSentinel(env, ...names);
}

function envFlag(env: Record<string, unknown> | undefined, ...names: string[]) {
  return hanjiEnvFlag(env, ...names);
}

function envString(env: Record<string, unknown> | undefined, ...names: string[]) {
  return hanjiEnvValue(env, ...names) ?? '';
}

function instanceAdminIds(settings: InstanceSettings) {
  return Array.isArray(settings.instanceAdminUserIds)
    ? Array.from(
        new Set(
          settings.instanceAdminUserIds
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim()),
        ),
      )
    : [];
}

function numericValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function statusValue(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createdOrUpdated(value: { updatedAt?: string | null; createdAt?: string | null }) {
  return value.updatedAt ?? value.createdAt ?? '';
}

function sortRecent<T extends { updatedAt?: string | null; createdAt?: string | null }>(items: T[]) {
  return [...items].sort((a, b) => createdOrUpdated(b).localeCompare(createdOrUpdated(a)));
}

function fileActiveBytes(upload: FileUpload) {
  const status = upload.status ?? 'pending';
  return status === 'uploaded' || status === 'pending' ? numericValue(upload.size) : 0;
}

function fileUploadedBytes(upload: FileUpload) {
  return upload.status === 'uploaded' ? numericValue(upload.size) : 0;
}

function filePendingBytes(upload: FileUpload) {
  return (upload.status ?? 'pending') === 'pending' ? numericValue(upload.size) : 0;
}

function fileDeletedBytes(upload: FileUpload) {
  return upload.status === 'deleted' ? numericValue(upload.size) : 0;
}

function fileExpiredBytes(upload: FileUpload) {
  return upload.status === 'expired' ? numericValue(upload.size) : 0;
}

function mapCounts<T extends Record<string, unknown>>(items: T[], key: keyof T) {
  const map = new Map<string, number>();
  for (const item of items) {
    const value = item[key];
    if (typeof value !== 'string' || !value) continue;
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return map;
}

function mapBytesByWorkspace(files: FileUpload[]) {
  const map = new Map<string, { files: number; activeStorageBytes: number }>();
  for (const upload of files) {
    const workspaceId = upload.workspaceId;
    if (!workspaceId) continue;
    const current = map.get(workspaceId) ?? { files: 0, activeStorageBytes: 0 };
    current.files += 1;
    current.activeStorageBytes += fileActiveBytes(upload);
    map.set(workspaceId, current);
  }
  return map;
}

function temporaryPassword() {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 14)
    : Math.random().toString(36).slice(2, 16);
  return `Temp-${suffix}!9`;
}

// Admin-issued credentials are temporary by policy: the account must set its
// own password on first sign-in (AuthGate blocks on account-state's
// mustChangePassword flag). Best-effort — a flag write failure must not undo
// the account operation that already happened.
async function markMustChangePassword(
  db: DbRef,
  userId: string,
  actorId: string,
  reason: 'admin_created' | 'admin_reset',
) {
  if (!userId) return;
  const table = db.table<{ id: string; mustChangePassword?: boolean; reason?: string | null; updatedBy?: string | null }>('account_flags');
  try {
    await table.update(userId, { mustChangePassword: true, reason, updatedBy: actorId });
  } catch (error) {
    if (!isNotFoundError(error)) {
      console.error('[instance-admin] failed to update mustChangePassword flag:', error);
      return;
    }
    try {
      await table.insert({ id: userId, mustChangePassword: true, reason, updatedBy: actorId });
    } catch (insertError) {
      console.error('[instance-admin] failed to insert mustChangePassword flag:', insertError);
    }
  }
}

const SNAPSHOT_TABLES = [
  'instance_settings',
  'instance_audit_events',
  'organizations',
  'organization_members',
  'organization_groups',
  'organization_group_members',
  'organization_domains',
  'organization_audit_events',
  'organization_enterprise_controls',
  'organization_scim_tokens',
  'organization_legal_holds',
  'organization_audit_exports',
  'organization_billing_records',
  'workspaces',
  'workspace_members',
  'workspace_invitations',
  'pages',
  'blocks',
  'db_properties',
  'db_views',
  'db_templates',
  'comments',
  'page_permissions',
  'share_links',
  'file_uploads',
  'file_maintenance_runs',
  'notifications',
  'notion_import_jobs',
  'notion_import_items',
  'notion_import_mappings',
] as const;

const REDACTED_SNAPSHOT_TABLES = new Set([
  'notion_import_connections',
  'mcp_oauth_clients',
  'mcp_oauth_grants',
  'mcp_oauth_authorization_codes',
  'mcp_oauth_refresh_tokens',
]);

const WORKSPACE_SNAPSHOT_TABLES = new Set<string>(WORKSPACE_CONTENT_TABLES);

async function listTableAll<T>(table: TableRef<T>, options?: ListAllOptions) {
  const query = table as unknown as TableQuery<T>;
  if (typeof query.page === 'function' && typeof query.limit === 'function') {
    return listAll(query, options);
  }
  const result = await table.getList();
  return result.items ?? [];
}

// Content tables span workspace blocks after the split; instance-level
// reporting fans out per workspace (admin-frequency cost accepted in
// docs/workspace-do-migration.md).
async function listContentTableAll<T>(
  context: Pick<BaseFunctionContext, 'admin'>,
  tableName: string,
  options?: ListAllOptions,
): Promise<T[]> {
  const contentDbs = await contentDbsForAllWorkspaces(context.admin);
  const out: T[] = [];
  for (const { db: contentDb } of contentDbs) {
    out.push(...(await listTableAll(contentDb.table<T>(tableName), options)));
    if (options?.maxItems && out.length > options.maxItems) {
      throw Object.assign(
        new Error(`${options.label ?? tableName} materialization limit exceeded (${options.maxItems} rows).`),
        { status: 413 },
      );
    }
  }
  return out;
}

// Instance-admin bootstrap is identity-based, never email-claim-based. Password
// signup sessions can carry an unverified caller-chosen email, so an environment
// email allowlist would let whoever registers that address first self-promote.
// Use the env-provisioned master identity or explicit immutable auth user ids.
export function instanceAdminAuthority(opts: {
  actorId: string;
  configuredAdminIds: readonly string[];
  envAdminIds: readonly string[];
}): 'configured' | 'environment' | null {
  if (opts.configuredAdminIds.includes(opts.actorId)) return 'configured';
  if (opts.envAdminIds.includes(opts.actorId)) return 'environment';
  return null;
}

async function requireInstanceAdmin(context: FunctionContext) {
  const actorId = context.auth?.id;
  if (!actorId) throw new Error('Authentication required.');
  const db = context.admin.db('app');
  const authAdmin = context.admin.auth;
  if (!authAdmin) throw new Error('Instance auth admin is not available.');
  const settings = await getInstanceSettings(db);
  const configuredAdminIds = instanceAdminIds(settings);
  const envAdminIds = envListWithOffSentinel(
    context.env,
    'HANJI_INSTANCE_ADMIN_USER_IDS',
    'EDGEBASE_INSTANCE_ADMIN_USER_IDS',
  );
  const authority = instanceAdminAuthority({
    actorId,
    configuredAdminIds,
    envAdminIds,
  });

  if (authority === 'configured') return { db, authAdmin, settings, actorId };
  if (authority === 'environment') {
    const nextSettings = await upsertInstanceSettings(db, {
      instanceAdminUserIds: Array.from(new Set([...configuredAdminIds, actorId])),
      updatedBy: actorId,
    });
    return { db, authAdmin, settings: nextSettings, actorId };
  }
  const bootstrapHint = configuredAdminIds.length === 0 && envAdminIds.length === 0
    ? ' Configure the master account or HANJI_INSTANCE_ADMIN_USER_IDS to bootstrap the first administrator.'
    : '';
  throw new Error(`Instance administrator permission required.${bootstrapHint}`);
}

function userIdFrom(user: Record<string, unknown>) {
  return normalizeString(user.id || user.userId || user.uid);
}

function boolValue(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

function userEmail(user: Record<string, unknown>) {
  return normalizeEmail(user.email) || null;
}

function userDisplayName(user: Record<string, unknown>) {
  return normalizeString(user.displayName || user.name) || null;
}

async function buildInstanceAdminResult(
  db: DbRef,
  authAdmin: NonNullable<BaseFunctionContext['admin']['auth']>,
  settings: InstanceSettings,
  input: Record<string, unknown>,
  context: FunctionContext,
  extra: Partial<Pick<InstanceAdminResult, 'temporaryPassword' | 'snapshot'>> = {},
): Promise<InstanceAdminResult> {
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 100));
  const cursor = typeof input.cursor === 'string' && input.cursor.trim() ? input.cursor.trim() : undefined;
  const [
    authUsers,
    workspaceMembers,
    organizationMembers,
    workspaces,
    organizations,
    pages,
    files,
    maintenanceRuns,
    importJobs,
    importItems,
    organizationAuditEvents,
    instanceAuditEvents,
  ] = await Promise.all([
    authAdmin.listUsers({ limit, cursor }),
    listTableAll(db.table<WorkspaceMember>('workspace_members')),
    listTableAll(db.table<OrganizationMember>('organization_members')),
    listTableAll(db.table<Workspace>('workspaces')),
    listTableAll(db.table<OrganizationRecord>('organizations')),
    listContentTableAll<Page>(context, 'pages'),
    listContentTableAll<FileUpload>(context, 'file_uploads'),
    listTableAll(db.table<FileMaintenanceRunRecord>('file_maintenance_runs')),
    listContentTableAll<NotionImportJobRecord>(context, 'notion_import_jobs'),
    listContentTableAll<NotionImportItemRecord>(context, 'notion_import_items'),
    listTableAll(db.table<OrganizationAuditEvent>('organization_audit_events')),
    listTableAll(db.table<InstanceAuditEvent>('instance_audit_events')),
  ]);
  const workspaceIdsByUser = new Map<string, Set<string>>();
  for (const member of workspaceMembers) {
    if (!member.userId) continue;
    if (!workspaceIdsByUser.has(member.userId)) workspaceIdsByUser.set(member.userId, new Set());
    workspaceIdsByUser.get(member.userId)!.add(member.workspaceId);
  }
  const organizationIdsByUser = new Map<string, Set<string>>();
  const activeOrganizationIdsByUser = new Map<string, Set<string>>();
  const deactivatedOrganizationIdsByUser = new Map<string, Set<string>>();
  for (const member of organizationMembers) {
    if (!member.userId) continue;
    if (!organizationIdsByUser.has(member.userId)) organizationIdsByUser.set(member.userId, new Set());
    organizationIdsByUser.get(member.userId)!.add(member.organizationId);
    const target = (member.status ?? 'active') === 'deactivated'
      ? deactivatedOrganizationIdsByUser
      : activeOrganizationIdsByUser;
    if (!target.has(member.userId)) target.set(member.userId, new Set());
    target.get(member.userId)!.add(member.organizationId);
  }
  const admins = instanceAdminIds(settings);
  const users = authUsers.users
    .map((user) => {
      const id = userIdFrom(user);
      return {
        id,
        email: userEmail(user),
        displayName: userDisplayName(user),
        role: normalizeString(user.role) || null,
        status: normalizeString(user.status) || null,
        disabled: boolValue(user.disabled),
        verified: boolValue(user.verified),
        isAnonymous: boolValue(user.isAnonymous),
        createdAt: normalizeString(user.createdAt) || null,
        updatedAt: normalizeString(user.updatedAt) || null,
        lastLoginAt: normalizeString(user.lastLoginAt || user.lastSignInAt) || null,
        workspaceCount: workspaceIdsByUser.get(id)?.size ?? 0,
        organizationCount: organizationIdsByUser.get(id)?.size ?? 0,
        activeOrganizationCount: activeOrganizationIdsByUser.get(id)?.size ?? 0,
        deactivatedOrganizationCount: deactivatedOrganizationIdsByUser.get(id)?.size ?? 0,
        isInstanceAdmin: admins.includes(id),
      } satisfies InstanceAdminUser;
    })
    .filter((user) => user.id);

  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const memberCounts = mapCounts(workspaceMembers as unknown as Array<Record<string, unknown>>, 'workspaceId');
  const pageCounts = mapCounts(pages as unknown as Array<Record<string, unknown>>, 'workspaceId');
  const databaseCounts = new Map<string, number>();
  for (const page of pages) {
    if (page.kind !== 'database') continue;
    databaseCounts.set(page.workspaceId, (databaseCounts.get(page.workspaceId) ?? 0) + 1);
  }
  const fileStatsByWorkspace = mapBytesByWorkspace(files);
  const importCounts = mapCounts(importJobs as unknown as Array<Record<string, unknown>>, 'workspaceId');
  const failedImportCounts = new Map<string, number>();
  for (const job of importJobs) {
    if (statusValue(job.status, 'queued') !== 'failed') continue;
    failedImportCounts.set(job.workspaceId, (failedImportCounts.get(job.workspaceId) ?? 0) + 1);
  }

  const workspaceSummaries = workspaces
    .map((workspace): ServerWorkspaceSummary => {
      const fileStats = fileStatsByWorkspace.get(workspace.id);
      return {
        id: workspace.id,
        name: workspace.name ?? null,
        domain: workspace.domain ?? null,
        ownerId: workspace.ownerId ?? null,
        organizationId: workspace.organizationId ?? null,
        memberCount: memberCounts.get(workspace.id) ?? 0,
        pageCount: pageCounts.get(workspace.id) ?? 0,
        databaseCount: databaseCounts.get(workspace.id) ?? 0,
        fileCount: fileStats?.files ?? 0,
        activeStorageBytes: fileStats?.activeStorageBytes ?? 0,
        importJobCount: importCounts.get(workspace.id) ?? 0,
        failedImportJobCount: failedImportCounts.get(workspace.id) ?? 0,
        createdAt: workspace.createdAt ?? null,
        updatedAt: workspace.updatedAt ?? null,
      };
    })
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));

  const itemStatsByJob = new Map<string, { itemCount: number; failedItemCount: number; mappedItemCount: number }>();
  for (const item of importItems) {
    const stats = itemStatsByJob.get(item.jobId) ?? { itemCount: 0, failedItemCount: 0, mappedItemCount: 0 };
    stats.itemCount += 1;
    if (item.error || item.status === 'failed') stats.failedItemCount += 1;
    if (item.localId) stats.mappedItemCount += 1;
    itemStatsByJob.set(item.jobId, stats);
  }

  const importJobSummaries = sortRecent(importJobs)
    .slice(0, 40)
    .map((job): ServerImportJobSummary => {
      const stats = itemStatsByJob.get(job.id) ?? { itemCount: 0, failedItemCount: 0, mappedItemCount: 0 };
      const workspace = workspaceById.get(job.workspaceId);
      return {
        id: job.id,
        workspaceId: job.workspaceId,
        workspaceName: workspace?.name ?? workspace?.domain ?? null,
        status: statusValue(job.status, 'queued'),
        phase: statusValue(job.phase, 'queued'),
        actorId: job.actorId ?? null,
        notionWorkspaceName: job.notionWorkspaceName ?? null,
        itemCount: stats.itemCount,
        failedItemCount: stats.failedItemCount,
        mappedItemCount: stats.mappedItemCount,
        error: job.error ?? null,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
        updatedAt: job.updatedAt ?? null,
        createdAt: job.createdAt ?? null,
      };
    });

  const usageTotals = files.reduce(
    (totals, upload) => ({
      files: totals.files + 1,
      activeStorageBytes: totals.activeStorageBytes + fileActiveBytes(upload),
      uploadedBytes: totals.uploadedBytes + fileUploadedBytes(upload),
      pendingBytes: totals.pendingBytes + filePendingBytes(upload),
      deletedBytes: totals.deletedBytes + fileDeletedBytes(upload),
      expiredBytes: totals.expiredBytes + fileExpiredBytes(upload),
    }),
    { files: 0, activeStorageBytes: 0, uploadedBytes: 0, pendingBytes: 0, deletedBytes: 0, expiredBytes: 0 },
  );
  const usage: ServerUsageSummary = {
    totals: usageTotals,
    pending: {
      active: files.filter((upload) => (upload.status ?? 'pending') === 'pending').length,
      expired: files.filter((upload) => upload.status === 'expired').length,
    },
    byWorkspace: Array.from(fileStatsByWorkspace.entries())
      .map(([workspaceId, stats]) => ({
        workspaceId,
        workspaceName: workspaceById.get(workspaceId)?.name ?? workspaceById.get(workspaceId)?.domain ?? null,
        files: stats.files,
        activeStorageBytes: stats.activeStorageBytes,
      }))
      .sort((a, b) => b.activeStorageBytes - a.activeStorageBytes)
      .slice(0, 12),
    recentMaintenanceRuns: sortRecent(maintenanceRuns)
      .slice(0, 12)
      .map((run) => ({
        id: run.id,
        workspaceId: run.workspaceId,
        workspaceName: workspaceById.get(run.workspaceId)?.name ?? workspaceById.get(run.workspaceId)?.domain ?? null,
        kind: run.kind ?? null,
        status: run.status ?? null,
        scanned: run.scanned,
        expired: run.expired,
        failedObjects: run.failedObjects,
        startedAt: run.startedAt ?? null,
      })),
  };

  const auditEvents: ServerAuditSummaryEvent[] = [
    ...instanceAuditEvents.map((event): ServerAuditSummaryEvent => ({
      id: event.id,
      scope: 'instance',
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      targetLabel: event.targetLabel ?? null,
      metadata: event.metadata ?? null,
      occurredAt: event.occurredAt ?? event.createdAt ?? '',
    })),
    ...organizationAuditEvents.map((event): ServerAuditSummaryEvent => ({
      id: event.id,
      scope: 'organization',
      organizationId: event.organizationId,
      workspaceId: event.workspaceId ?? null,
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? null,
      occurredAt: event.occurredAt ?? event.createdAt ?? '',
    })),
  ]
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))
    .slice(0, 80);

  const disabledUserCount = users.filter((user) => user.disabled).length;
  const verifiedUserCount = users.filter((user) => user.verified).length;
  const failedImportJobCount = importJobs.filter((job) => statusValue(job.status, 'queued') === 'failed').length;
  const env = context.env;
  const emailConfigured = !!envString(
    env,
    'EDGEBASE_EMAIL_PROVIDER',
    'RESEND_API_KEY',
    'MAILGUN_API_KEY',
    'POSTMARK_SERVER_TOKEN',
    'SMTP_HOST',
  );
  const notionConfigured = !!envString(env, 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'NOTION_API_TOKEN');
  const backupTableCounts: Record<string, number> = {
    organizations: organizations.length,
    organization_members: organizationMembers.length,
    organization_audit_events: organizationAuditEvents.length,
    instance_audit_events: instanceAuditEvents.length,
    workspaces: workspaces.length,
    workspace_members: workspaceMembers.length,
    pages: pages.length,
    file_uploads: files.length,
    file_maintenance_runs: maintenanceRuns.length,
    notion_import_jobs: importJobs.length,
    notion_import_items: importItems.length,
  };
  const generatedAt = nowIso();

  return {
    instanceSettings: settings,
    instanceAdmins: admins,
    users,
    overview: {
      generatedAt,
      counts: {
        users: users.length,
        activeUsers: users.length - disabledUserCount,
        disabledUsers: disabledUserCount,
        verifiedUsers: verifiedUserCount,
        instanceAdmins: admins.length,
        organizations: organizations.length,
        workspaces: workspaces.length,
        pages: pages.filter((page) => page.kind !== 'database').length,
        databases: pages.filter((page) => page.kind === 'database').length,
        importJobs: importJobs.length,
        failedImportJobs: failedImportJobCount,
        files: usageTotals.files,
        activeStorageBytes: usageTotals.activeStorageBytes,
      },
      health: [
        {
          key: 'auth',
          label: 'Auth',
          status: authAdmin ? 'ok' : 'missing',
          detail: authAdmin ? `${users.length}개 계정을 읽었습니다.` : 'Auth 관리자 연결이 없습니다.',
        },
        {
          key: 'database',
          label: 'Database',
          status: 'ok',
          detail: `${workspaces.length}개 워크스페이스, ${pages.length}개 페이지/데이터베이스`,
        },
        {
          key: 'storage',
          label: 'Storage',
          status: usageTotals.files > 0 ? 'ok' : 'attention',
          detail: `${usageTotals.files}개 파일, ${usageTotals.activeStorageBytes} bytes 활성 사용량`,
        },
        {
          key: 'notion-import',
          label: 'Notion import',
          status: failedImportJobCount > 0 ? 'attention' : 'ok',
          detail: failedImportJobCount > 0
            ? `${failedImportJobCount}개 실패 작업 확인 필요`
            : `${importJobs.length}개 가져오기 작업`,
        },
        {
          key: 'email',
          label: 'Email',
          status: emailConfigured ? 'ok' : 'missing',
          detail: emailConfigured ? '이메일 발송 환경값이 있습니다.' : '이메일 발송 환경값이 보이지 않습니다.',
        },
      ],
    },
    workspaces: workspaceSummaries,
    security: {
      sessionRevocationAvailable: typeof authAdmin.revokeAllSessions === 'function',
      mfaResetAvailable: false,
      passwordResetAvailable: typeof authAdmin.updateUser === 'function',
      disabledUsers: disabledUserCount,
      instanceAdmins: admins.length,
      notes: [
        '세션 강제 종료와 임시 비밀번호 재설정은 서버 콘솔에서 처리합니다.',
        'MFA 일괄 초기화는 EdgeBase 함수 컨텍스트에 아직 안전 API가 없어 상태만 표시합니다.',
      ],
    },
    auditEvents,
    importJobs: importJobSummaries,
    usage,
    backup: {
      generatedAt,
      restoreAvailable: false,
      downloadableTables: [...SNAPSHOT_TABLES],
      tableCounts: backupTableCounts,
      notes: [
        '서버 콘솔 스냅샷은 제품 데이터 테이블 중심으로 내려받습니다.',
        `인증 비밀, OAuth 토큰, Notion 연결 ciphertext는 브라우저 스냅샷에서 제외합니다: ${Array.from(REDACTED_SNAPSHOT_TABLES).join(', ')}`,
        '전체 auth DB/스토리지 원복은 아직 CLI 또는 배포 운영 절차로 처리해야 합니다.',
      ],
    },
    system: {
      generatedAt,
      environment: [
        {
          key: 'instance-admin-ids',
          label: '관리자 ID allowlist',
          configured: envListWithOffSentinel(
            env,
            'HANJI_INSTANCE_ADMIN_USER_IDS',
            'EDGEBASE_INSTANCE_ADMIN_USER_IDS',
          ).length > 0,
          detail: '환경변수 기반 인스턴스 관리자 ID',
        },
        {
          key: 'instance-admin-emails',
          label: '폐기된 관리자 이메일 allowlist',
          configured: envList(env, 'HANJI_INSTANCE_ADMIN_EMAILS', 'EDGEBASE_INSTANCE_ADMIN_EMAILS').length > 0,
          detail: '보안상 무시됩니다. master 계정 또는 관리자 user ID를 사용하세요.',
        },
        {
          key: 'strict-admins',
          label: 'Strict 관리자 모드',
          configured: envFlag(env, 'HANJI_STRICT_INSTANCE_ADMINS', 'EDGEBASE_STRICT_INSTANCE_ADMINS'),
          detail: '하위 호환용 플래그입니다. 소유자 자동 승격은 항상 꺼져 있고, master/환경변수 user ID만 bootstrap에 사용됩니다.',
        },
        {
          key: 'email',
          label: '이메일 발송',
          configured: emailConfigured,
          detail: emailConfigured ? '메일 발송 환경값 감지됨' : '메일 발송 환경값 미감지',
        },
        {
          key: 'notion',
          label: 'Notion 연결',
          configured: notionConfigured,
          detail: notionConfigured ? 'Notion OAuth/API 환경값 감지됨' : 'Notion 전역 환경값 미감지',
        },
      ],
    },
    ...extra,
    cursor: authUsers.cursor,
  };
}

async function updateSignupPolicy(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, actorId } = await requireInstanceAdmin(context);
  const signupPolicy = parseSignupPolicy(body.signupPolicy, 'public');
  const settings = await upsertInstanceSettings(db, { signupPolicy, updatedBy: actorId });
  await recordInstanceAudit(db, {
    actorId,
    action: 'instance.signup_policy.update',
    targetType: 'instance_settings',
    targetId: 'global',
    metadata: { signupPolicy },
  });
  return buildInstanceAdminResult(db, authAdmin, settings, body, context);
}

async function setUserDisabled(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, settings, actorId } = await requireInstanceAdmin(context);
  const targetUserId = requireString(body.userId, 'userId');
  if (targetUserId === actorId) throw new Error('You cannot disable your own instance account.');
  const disabled = body.disabled === true;
  const target = await authAdmin.getUser(targetUserId).catch(() => null);
  await authAdmin.updateUser(targetUserId, { disabled, status: disabled ? 'disabled' : 'active' });
  if (disabled) await authAdmin.revokeAllSessions(targetUserId);
  await recordInstanceAudit(db, {
    actorId,
    action: disabled ? 'instance.user.disable' : 'instance.user.restore',
    targetType: 'user',
    targetId: targetUserId,
    targetLabel: target ? userEmail(target) ?? userDisplayName(target) ?? targetUserId : targetUserId,
    metadata: { disabled, revokedSessions: disabled },
  });
  return buildInstanceAdminResult(db, authAdmin, settings, body, context);
}

async function deleteUser(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, settings, actorId } = await requireInstanceAdmin(context);
  const targetUserId = requireString(body.userId, 'userId');
  if (targetUserId === actorId) throw new Error('You cannot delete your own instance account.');
  const target = await authAdmin.getUser(targetUserId).catch(() => null);
  await authAdmin.deleteUser(targetUserId);
  const admins = instanceAdminIds(settings).filter((id) => id !== targetUserId);
  const nextSettings = admins.length === instanceAdminIds(settings).length
    ? settings
    : await upsertInstanceSettings(db, { instanceAdminUserIds: admins, updatedBy: actorId });
  await recordInstanceAudit(db, {
    actorId,
    action: 'instance.user.delete',
    targetType: 'user',
    targetId: targetUserId,
    targetLabel: target ? userEmail(target) ?? userDisplayName(target) ?? targetUserId : targetUserId,
    metadata: { removedInstanceAdmin: admins.length !== instanceAdminIds(settings).length },
  });
  return buildInstanceAdminResult(db, authAdmin, nextSettings, body, context);
}

async function setInstanceAdmin(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, settings, actorId } = await requireInstanceAdmin(context);
  const targetUserId = requireString(body.userId, 'userId');
  const enabled = body.enabled === true;
  const target = await authAdmin.getUser(targetUserId).catch(() => null);
  const admins = new Set(instanceAdminIds(settings));
  if (enabled) admins.add(targetUserId);
  else admins.delete(targetUserId);
  if (!enabled && targetUserId === actorId && admins.size === 0) {
    throw new Error('At least one instance administrator is required.');
  }
  const nextSettings = await upsertInstanceSettings(db, {
    instanceAdminUserIds: Array.from(admins),
    updatedBy: actorId,
  });
  await recordInstanceAudit(db, {
    actorId,
    action: enabled ? 'instance.admin.grant' : 'instance.admin.revoke',
    targetType: 'user',
    targetId: targetUserId,
    targetLabel: target ? userEmail(target) ?? userDisplayName(target) ?? targetUserId : targetUserId,
    metadata: { enabled },
  });
  return buildInstanceAdminResult(db, authAdmin, nextSettings, body, context);
}

async function getInstanceAdmin(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, settings } = await requireInstanceAdmin(context);
  return buildInstanceAdminResult(db, authAdmin, settings, body, context);
}

async function recordInstanceAudit(
  db: DbRef,
  event: Omit<Partial<InstanceAuditEvent>, 'id' | 'occurredAt'> & { action: string },
) {
  try {
    await db.table<InstanceAuditEvent>('instance_audit_events').insert({
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      targetLabel: event.targetLabel ?? null,
      metadata: event.metadata ?? null,
      occurredAt: nowIso(),
    });
  } catch (error) {
    console.error('[instance-admin] failed to record instance audit event:', error);
  }
}

async function createUser(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, settings, actorId } = await requireInstanceAdmin(context);
  const email = requireString(body.email, 'email').toLowerCase();
  const displayName = normalizeString(body.displayName) || undefined;
  const providedPassword = normalizeString(body.password);
  const password = providedPassword || temporaryPassword();
  const created = await authAdmin.createUser({
    email,
    password,
    displayName,
    role: normalizeString(body.role) || 'user',
  });
  const targetUserId = userIdFrom(created);
  await markMustChangePassword(db, targetUserId, actorId, 'admin_created');
  await recordInstanceAudit(db, {
    actorId,
    action: 'instance.user.create',
    targetType: 'user',
    targetId: targetUserId || email,
    targetLabel: userEmail(created) ?? userDisplayName(created) ?? email,
    metadata: { displayName: displayName ?? null, generatedTemporaryPassword: !providedPassword },
  });
  return buildInstanceAdminResult(db, authAdmin, settings, body, context, {
    temporaryPassword: providedPassword ? undefined : password,
  });
}

async function resetUserPassword(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, settings, actorId } = await requireInstanceAdmin(context);
  const targetUserId = requireString(body.userId, 'userId');
  if (targetUserId === actorId) throw new Error('Use account security settings to change your own password.');
  const providedPassword = normalizeString(body.password);
  const password = providedPassword || temporaryPassword();
  const target = await authAdmin.updateUser(targetUserId, { password });
  await authAdmin.revokeAllSessions(targetUserId);
  await markMustChangePassword(db, targetUserId, actorId, 'admin_reset');
  await recordInstanceAudit(db, {
    actorId,
    action: 'instance.user.password_reset',
    targetType: 'user',
    targetId: targetUserId,
    targetLabel: userEmail(target) ?? userDisplayName(target) ?? targetUserId,
    metadata: { revokedSessions: true, generatedTemporaryPassword: !providedPassword },
  });
  return buildInstanceAdminResult(db, authAdmin, settings, body, context, {
    temporaryPassword: providedPassword ? undefined : password,
  });
}

async function revokeUserSessions(context: FunctionContext, body: Record<string, unknown>) {
  const { db, authAdmin, settings, actorId } = await requireInstanceAdmin(context);
  const targetUserId = requireString(body.userId, 'userId');
  if (targetUserId === actorId) throw new Error('Use account security settings to revoke your own sessions.');
  const target = await authAdmin.getUser(targetUserId).catch(() => null);
  await authAdmin.revokeAllSessions(targetUserId);
  await recordInstanceAudit(db, {
    actorId,
    action: 'instance.user.sessions_revoke',
    targetType: 'user',
    targetId: targetUserId,
    targetLabel: target ? userEmail(target) ?? userDisplayName(target) ?? targetUserId : targetUserId,
    metadata: { revokedSessions: true },
  });
  return buildInstanceAdminResult(db, authAdmin, settings, body, context);
}

async function createBackupSnapshot(context: FunctionContext) {
  const { db } = await requireInstanceAdmin(context);
  const tables: Record<string, unknown[]> = {};
  const tableCounts: Record<string, number> = {};
  for (const tableName of SNAPSHOT_TABLES) {
    const materialization = {
      maxItems: 100_000,
      allowLargeMaterialization: true,
      label: `Backup table ${tableName}`,
    } satisfies ListAllOptions;
    const rows = WORKSPACE_SNAPSHOT_TABLES.has(tableName)
      ? await listContentTableAll<Record<string, unknown>>(context, tableName, materialization)
      : await listTableAll(db.table<Record<string, unknown>>(tableName), materialization);
    tables[tableName] = rows;
    tableCounts[tableName] = rows.length;
  }
  return {
    snapshot: {
      generatedAt: nowIso(),
      tableCounts,
      tables,
      notes: [
        'Product-data snapshot only. Auth database, raw object storage, service keys, OAuth secrets, and Notion credential ciphertext are not included.',
      ],
    } satisfies InstanceBackupSnapshot,
  };
}

// Admin-only server-user search that powers the workspace member-add picker.
// A non-admin never reaches this (requireInstanceAdmin throws); they add
// members by typing an exact email instead, which the workspace mutation
// resolves blindly. Returning the matching set here is intentional — instance
// admins manage the account roster directly.
async function searchUsers(context: FunctionContext, body: Record<string, unknown>) {
  const { authAdmin } = await requireInstanceAdmin(context);
  const query = normalizeString(body.query || body.q).toLowerCase();
  const limit = Math.min(25, Math.max(1, Number(body.limit) || 10));
  const matches: Array<{ id: string; email: string | null; displayName: string | null }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 25 && matches.length < limit; page += 1) {
    const result = await authAdmin.listUsers({ limit: 200, cursor });
    const users = result.users ?? [];
    for (const user of users) {
      const id = userIdFrom(user);
      if (!id) continue;
      const email = userEmail(user);
      const displayName = userDisplayName(user);
      const haystack = `${email ?? ''} ${displayName ?? ''}`.toLowerCase();
      if (!query || haystack.includes(query)) {
        matches.push({ id, email, displayName });
        if (matches.length >= limit) break;
      }
    }
    if (!result.cursor || users.length === 0) break;
    cursor = result.cursor;
  }
  return { users: matches };
}

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  try {
    if (!context.auth?.id) return jsonError(401, 'Authentication required.');
    const body = await context.request?.json().catch(() => ({})) as Record<string, unknown>;
    const action = normalizeString(body.action || 'get');
    switch (action) {
      case 'get':
      case 'list':
        return await getInstanceAdmin(context, body);
      case 'updateSignupPolicy':
        return await updateSignupPolicy(context, body);
      case 'setUserDisabled':
        return await setUserDisabled(context, body);
      case 'deleteUser':
        return await deleteUser(context, body);
      case 'setInstanceAdmin':
        return await setInstanceAdmin(context, body);
      case 'createUser':
        return await createUser(context, body);
      case 'searchUsers':
        return await searchUsers(context, body);
      case 'resetUserPassword':
        return await resetUserPassword(context, body);
      case 'revokeUserSessions':
        return await revokeUserSessions(context, body);
      case 'createBackupSnapshot':
        return await createBackupSnapshot(context);
      default:
        return jsonError(400, 'Unknown instance admin action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 401, needles: ['Authentication required'] },
      { status: 403, needles: ['administrator permission'] },
    ]);
    return jsonError(status, message);
  }
});
