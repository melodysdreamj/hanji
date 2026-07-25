import type { DbRef } from './app-types';
import { INSTANCE_SETTINGS_ID } from './instance-settings';
import { normalizeAccessEmail } from './page-access';
import type { TableQuery } from './table-utils';
import {
  CHANGE_LOG_PRUNE_SENTINEL,
  CHANGE_LOG_TABLE,
  type ChangeLogEntry,
} from './workspace-db';

const WORKSPACE_REFRESH_TOKEN_VERSION = 1;
const SAME_MILLISECOND_BOUNDARY_CAP = 500;
const ACTOR_GROUP_MEMBERSHIP_CAP = 500;

interface PageHeadRow {
  id: string;
  updatedAt?: string;
}

interface RefreshHead {
  ambiguous: boolean;
  page: { id: string; updatedAt: string } | null;
  change: {
    latestAt: string | null;
    boundaryCount: number;
    boundaryFingerprint: string;
    pruneAt: string | null;
  };
}

interface RefreshTokenPayload {
  version: typeof WORKSPACE_REFRESH_TOKEN_VERSION;
  workspaceId: string;
  actorId: string;
  authority: Record<string, unknown>;
  head: RefreshHead;
}

export interface WorkspaceRefreshTokenInput {
  workspaceId: string;
  actorId: string;
  authority: Record<string, unknown>;
  ambiguous?: boolean;
}

interface ActorGroupMembershipRow {
  id: string;
  organizationId?: string;
  groupId?: string;
  organizationMemberId?: string;
  userId?: string;
  role?: string;
  updatedAt?: string;
}

interface InstanceSettingsHeadRow {
  id: string;
  authorityVersion?: string;
}

export type BoundedActorAccessAuthority =
  | { supported: false }
  | {
      supported: true;
      ambiguous: boolean;
      authority: {
        normalizedEmail: string | null;
        groupMembershipCount: number;
        groupMembershipFingerprint: string;
      };
    };

export type BoundedInstanceSettingsAuthority =
  | { supported: false }
  | {
      supported: true;
      ambiguous: boolean;
      authority: {
        authorityVersion: string;
      };
    };

interface WorkspaceAuthoritySource {
  id: string;
  organizationId?: string | null;
  name?: string;
  icon?: string | null;
  domain?: string | null;
  ownerId?: string;
  deletionPendingAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationAuthoritySource {
  id: string;
  name?: string;
  icon?: string | null;
  ownerId?: string;
  workspaceCreationPolicy?: string;
  domainSignupPolicy?: string;
  sharingPolicy?: Record<string, unknown> | null;
  storageLimitBytes?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface WorkspaceMemberAuthoritySource {
  id: string;
  workspaceId?: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  role?: string;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface OrganizationMemberAuthoritySource {
  id: string;
  organizationId?: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  role?: string;
  status?: string;
  externalId?: string | null;
  provisionedBy?: string | null;
  createdBy?: string | null;
  deactivatedAt?: string | null;
  deactivatedBy?: string | null;
  ssoEnforcementEpoch?: number;
  createdAt?: string;
  updatedAt?: string;
}

export async function workspaceRefreshWorkspaceAuthority(workspace: WorkspaceAuthoritySource) {
  return {
    fingerprint: await fingerprintValues([JSON.stringify([
      workspace.id,
      workspace.organizationId ?? null,
      workspace.name ?? null,
      workspace.icon ?? null,
      workspace.domain ?? null,
      workspace.ownerId ?? null,
      workspace.deletionPendingAt ?? null,
      workspace.createdAt ?? null,
      workspace.updatedAt ?? null,
    ])]),
  };
}

export async function workspaceRefreshOrganizationAuthority(
  organization: OrganizationAuthoritySource | null,
) {
  if (!organization) return null;
  const sharingPolicy = organization.sharingPolicy;
  return {
    fingerprint: await fingerprintValues([JSON.stringify([
      organization.id,
      organization.name ?? null,
      organization.icon ?? null,
      organization.ownerId ?? null,
      organization.workspaceCreationPolicy ?? null,
      organization.domainSignupPolicy ?? null,
      sharingPolicy?.publicWebSharing ?? null,
      sharingPolicy?.externalEmailSharing ?? null,
      sharingPolicy?.guestAccess ?? null,
      sharingPolicy?.fileDownloads ?? null,
      sharingPolicy?.fullAccessGrants ?? null,
      organization.storageLimitBytes ?? null,
      organization.createdAt ?? null,
      organization.updatedAt ?? null,
    ])]),
  };
}

export async function workspaceRefreshWorkspaceMemberAuthority(
  member: WorkspaceMemberAuthoritySource | null | undefined,
) {
  if (!member) return null;
  return {
    fingerprint: await fingerprintValues([JSON.stringify([
      member.id,
      member.workspaceId ?? null,
      member.userId,
      member.displayName ?? null,
      member.email ?? null,
      member.avatar ?? null,
      member.role ?? null,
      member.createdBy ?? null,
      member.createdAt ?? null,
      member.updatedAt ?? null,
    ])]),
  };
}

export async function workspaceRefreshOrganizationMemberAuthority(
  member: OrganizationMemberAuthoritySource | null | undefined,
) {
  if (!member) return null;
  return {
    fingerprint: await fingerprintValues([JSON.stringify([
      member.id,
      member.organizationId ?? null,
      member.userId,
      member.displayName ?? null,
      member.email ?? null,
      member.avatar ?? null,
      member.role ?? null,
      member.status ?? 'active',
      member.externalId ?? null,
      member.provisionedBy ?? null,
      member.createdBy ?? null,
      member.deactivatedAt ?? null,
      member.deactivatedBy ?? null,
      member.ssoEnforcementEpoch ?? 0,
      member.createdAt ?? null,
      member.updatedAt ?? null,
    ])]),
  };
}

export type WorkspaceRefreshProbeDecision =
  | { decision: 'unchanged' }
  | { decision: 'bootstrap_required'; reason: string };

type CapableQuery<T> = TableQuery<T> & {
  where(field: string, op: string, value: unknown): TableQuery<T>;
  orderBy(field: string, direction: 'asc' | 'desc'): TableQuery<T>;
  select(...fields: string[]): TableQuery<T>;
  includeTotal(include: boolean): TableQuery<T>;
};

function capableQuery<T>(query: TableQuery<T>): query is CapableQuery<T> {
  return typeof query.where === 'function'
    && typeof query.orderBy === 'function'
    && typeof query.select === 'function'
    && typeof query.includeTotal === 'function';
}

function rowsFrom<T>(value: { items?: T[] }): T[] | null {
  return Array.isArray(value.items) ? value.items : null;
}

async function projectedRows<T>(
  query: TableQuery<T>,
  fields: string[],
  limit: number,
): Promise<T[] | null> {
  if (!capableQuery(query)) return null;
  const projected = query.select(...fields);
  if (typeof projected.includeTotal !== 'function') return null;
  return rowsFrom(await projected.includeTotal(false).limit(limit).getList());
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function fingerprintIds(ids: string[]): Promise<string> {
  const encoded = new TextEncoder().encode(ids.slice().sort().join('\n'));
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)));
}

async function fingerprintValues(values: string[]): Promise<string> {
  const encoded = new TextEncoder().encode(values.join('\n'));
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)));
}

export async function readBoundedActorAccessAuthority(
  db: DbRef,
  input: {
    organizationId?: string | null;
    actorId: string;
    actorEmail?: string | null;
  },
): Promise<BoundedActorAccessAuthority> {
  const normalizedEmail = normalizeAccessEmail(input.actorEmail);
  if (!input.organizationId) {
    return {
      supported: true,
      ambiguous: false,
      authority: {
        normalizedEmail,
        groupMembershipCount: 0,
        groupMembershipFingerprint: await fingerprintValues([]),
      },
    };
  }
  const organizationBase = db
    .table<ActorGroupMembershipRow>('organization_group_members')
    .where('organizationId', '==', input.organizationId);
  if (!capableQuery(organizationBase)) return { supported: false };
  const actorGroups = organizationBase.where('userId', '==', input.actorId);
  if (!capableQuery(actorGroups)) return { supported: false };
  const ordered = actorGroups.orderBy('id', 'asc');
  if (!capableQuery(ordered)) return { supported: false };
  const rows = await projectedRows(
    ordered,
    ['id', 'groupId', 'organizationMemberId', 'userId', 'role', 'updatedAt'],
    ACTOR_GROUP_MEMBERSHIP_CAP + 1,
  );
  if (!rows) return { supported: false };
  let ambiguous = rows.length > ACTOR_GROUP_MEMBERSHIP_CAP;
  const values = rows.slice(0, ACTOR_GROUP_MEMBERSHIP_CAP).map((row) => {
    if (
      typeof row.id !== 'string'
      || typeof row.groupId !== 'string'
      || typeof row.userId !== 'string'
      || row.userId !== input.actorId
    ) ambiguous = true;
    return JSON.stringify([
      typeof row.id === 'string' ? row.id : null,
      typeof row.groupId === 'string' ? row.groupId : null,
      typeof row.organizationMemberId === 'string' ? row.organizationMemberId : null,
      typeof row.userId === 'string' ? row.userId : null,
      typeof row.role === 'string' ? row.role : null,
      typeof row.updatedAt === 'string' ? row.updatedAt : null,
    ]);
  });
  return {
    supported: true,
    ambiguous,
    authority: {
      normalizedEmail,
      groupMembershipCount: values.length,
      groupMembershipFingerprint: await fingerprintValues(values),
    },
  };
}

export async function readBoundedInstanceSettingsAuthority(
  db: DbRef,
): Promise<BoundedInstanceSettingsAuthority> {
  const base = db
    .table<InstanceSettingsHeadRow>('instance_settings')
    .where('id', '==', INSTANCE_SETTINGS_ID);
  const rows = await projectedRows(base, ['id', 'authorityVersion'], 2);
  if (!rows) return { supported: false };
  const row = rows[0];
  const authorityVersion = typeof row?.authorityVersion === 'string'
    ? row.authorityVersion.trim()
    : '';
  return {
    supported: true,
    ambiguous: rows.length > 1
      || rows.length !== 1
      || row?.id !== INSTANCE_SETTINGS_ID
      || authorityVersion.length === 0,
    authority: { authorityVersion },
  };
}

function encodeToken(payload: RefreshTokenPayload): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decodeToken(value: unknown): RefreshTokenPayload | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) return null;
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;
  try {
    const raw = recordValue(JSON.parse(new TextDecoder().decode(bytes)));
    const head = recordValue(raw?.head);
    const change = recordValue(head?.change);
    if (
      raw?.version !== WORKSPACE_REFRESH_TOKEN_VERSION
      || typeof raw.workspaceId !== 'string'
      || typeof raw.actorId !== 'string'
      || !recordValue(raw.authority)
      || typeof head?.ambiguous !== 'boolean'
      || !(head.page === null || recordValue(head.page))
      || !change
      || !(change.latestAt === null || typeof change.latestAt === 'string')
      || typeof change.boundaryCount !== 'number'
      || typeof change.boundaryFingerprint !== 'string'
      || !(change.pruneAt === null || typeof change.pruneAt === 'string')
    ) {
      return null;
    }
    return raw as unknown as RefreshTokenPayload;
  } catch {
    return null;
  }
}

async function readRefreshHead(
  db: DbRef,
  workspaceId: string,
): Promise<{ supported: true; head: RefreshHead } | { supported: false }> {
  const pageBase = db.table<PageHeadRow>('pages').where('workspaceId', '==', workspaceId);
  if (!capableQuery(pageBase)) return { supported: false };
  const legacyPages = pageBase.where('notionImportStaging', '==', null);
  if (!capableQuery(legacyPages)) return { supported: false };
  const legacyRows = await projectedRows(legacyPages, ['id'], 1);
  if (!legacyRows) return { supported: false };
  const nonStagingPages = pageBase.where('notionImportStaging', '==', false);
  if (!capableQuery(nonStagingPages)) return { supported: false };
  const pagesByUpdatedAt = nonStagingPages.orderBy('updatedAt', 'desc');
  if (!capableQuery(pagesByUpdatedAt)) return { supported: false };
  const orderedPages = pagesByUpdatedAt.orderBy('id', 'desc');
  if (!capableQuery(orderedPages)) return { supported: false };
  const pageRows = await projectedRows(orderedPages, ['id', 'updatedAt'], 1);
  if (!pageRows) return { supported: false };
  const pageRow = pageRows[0];
  const pageAmbiguous = !!pageRow
    && (typeof pageRow.id !== 'string' || typeof pageRow.updatedAt !== 'string');
  const page = pageRow && typeof pageRow.id === 'string' && typeof pageRow.updatedAt === 'string'
    ? { id: pageRow.id, updatedAt: pageRow.updatedAt }
    : null;

  const changeTable = db.table<ChangeLogEntry>(CHANGE_LOG_TABLE);
  const changeBase = changeTable.where('workspaceId', '==', workspaceId);
  if (!capableQuery(changeBase)) return { supported: false };
  const orderedChanges = changeBase.orderBy('createdAt', 'desc');
  if (!capableQuery(orderedChanges)) return { supported: false };
  const latestRows = await projectedRows(orderedChanges, ['id', 'createdAt'], 1);
  if (!latestRows) return { supported: false };
  const latest = latestRows[0];
  const latestAt = typeof latest?.createdAt === 'string' ? latest.createdAt : null;

  let ambiguous = legacyRows.length > 0
    || pageAmbiguous
    || (latestRows.length > 0 && latestAt === null);
  let boundaryIds: string[] = [];
  if (latestAt) {
    const boundaryBase = changeTable.where('workspaceId', '==', workspaceId);
    if (!capableQuery(boundaryBase)) return { supported: false };
    const exactBoundary = boundaryBase.where('createdAt', '==', latestAt);
    if (!capableQuery(exactBoundary)) return { supported: false };
    const orderedBoundary = exactBoundary.orderBy('id', 'asc');
    if (!capableQuery(orderedBoundary)) return { supported: false };
    const boundaryRows = await projectedRows(
      orderedBoundary,
      ['id'],
      SAME_MILLISECOND_BOUNDARY_CAP + 1,
    );
    if (!boundaryRows) return { supported: false };
    ambiguous ||= boundaryRows.length > SAME_MILLISECOND_BOUNDARY_CAP;
    boundaryIds = boundaryRows
      .slice(0, SAME_MILLISECOND_BOUNDARY_CAP)
      .map((row) => row.id)
      .filter((id): id is string => typeof id === 'string');
    ambiguous ||= boundaryIds.length !== Math.min(boundaryRows.length, SAME_MILLISECOND_BOUNDARY_CAP);
  }

  const sentinelBase = changeTable.where('workspaceId', '==', workspaceId);
  if (!capableQuery(sentinelBase)) return { supported: false };
  const sentinelQuery = sentinelBase.where('tbl', '==', CHANGE_LOG_PRUNE_SENTINEL);
  if (!capableQuery(sentinelQuery)) return { supported: false };
  const sentinelRows = await projectedRows(sentinelQuery, ['id', 'at'], 2);
  if (!sentinelRows) return { supported: false };
  ambiguous ||= sentinelRows.length > 1;
  ambiguous ||= sentinelRows.length === 1 && typeof sentinelRows[0]?.at !== 'string';
  const pruneAt = typeof sentinelRows[0]?.at === 'string' ? sentinelRows[0].at : null;

  return {
    supported: true,
    head: {
      ambiguous,
      page,
      change: {
        latestAt,
        boundaryCount: boundaryIds.length,
        boundaryFingerprint: await fingerprintIds(boundaryIds),
        pruneAt,
      },
    },
  };
}

export async function createWorkspaceRefreshToken(
  db: DbRef,
  input: WorkspaceRefreshTokenInput,
): Promise<string | undefined> {
  const current = await readRefreshHead(db, input.workspaceId);
  if (!current.supported) return undefined;
  return encodeToken({
    version: WORKSPACE_REFRESH_TOKEN_VERSION,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    authority: input.authority,
    head: {
      ...current.head,
      ambiguous: current.head.ambiguous || input.ambiguous === true,
    },
  });
}

export async function probeWorkspaceRefreshToken(
  db: DbRef,
  input: WorkspaceRefreshTokenInput,
  token: unknown,
): Promise<WorkspaceRefreshProbeDecision> {
  const baseline = decodeToken(token);
  if (
    !baseline
    || baseline.workspaceId !== input.workspaceId
    || baseline.actorId !== input.actorId
  ) {
    return { decision: 'bootstrap_required', reason: 'refresh_token_invalid' };
  }
  if (JSON.stringify(baseline.authority) !== JSON.stringify(input.authority)) {
    return { decision: 'bootstrap_required', reason: 'authority_changed' };
  }
  if (baseline.head.ambiguous || input.ambiguous === true) {
    return { decision: 'bootstrap_required', reason: 'refresh_baseline_ambiguous' };
  }
  const current = await readRefreshHead(db, input.workspaceId);
  if (!current.supported) {
    return { decision: 'bootstrap_required', reason: 'bounded_query_unavailable' };
  }
  if (current.head.ambiguous || JSON.stringify(current.head) !== JSON.stringify(baseline.head)) {
    return { decision: 'bootstrap_required', reason: 'workspace_changed' };
  }
  return { decision: 'unchanged' };
}
