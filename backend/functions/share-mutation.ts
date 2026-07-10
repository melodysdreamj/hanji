import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import {
  evaluateRollup as evaluateRollupCore,
  type RollupContext,
  type RollupPage,
  type RollupProperty,
} from '../../shared/database/rollup-core';
import { evaluateFormulaExpression } from '../../shared/database/formula-core';
import {
  boundedDbFromPageHint,
  boundedDbFromPermissionHint,
  boundedDbFromShareToken,
  ensurePagePermissionIndex,
  ensureShareLinkIndex,
  transactBySideSegments,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import { assertOrganizationDlpPolicy, organizationDlpPolicyAllows } from '../lib/enterprise-controls';
import { assertOrganizationSharingPolicy, organizationSharingPolicyAllows } from '../lib/org-policy';
import {
  canManagePageAccess as sharedCanManagePageAccess,
  pageAccessRole as sharedPageAccessRole,
} from '../lib/page-access';

import {
  bestEffort,
  listAll,
  requireString,
  nowIso,
  newId,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from '../lib/table-utils';
import { v } from '../lib/validate';
import type { ShareRole } from '../lib/page-access';
import type {
  Block,
  DbProperty,
  DbTemplate,
  DbView,
  FileUpload,
  FunctionContext as AppFunctionContext,
  NotificationRecord,
  OrganizationGroup,
  OrganizationGroupMember,
  Page as AppPage,
  PagePermission,
  PrincipalType,
  ShareLink,
  TableRef as AppTableRef,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

const FILE_BUCKET = 'files';
const SHARED_FILE_URL_TTL_SECONDS = 15 * 60;

// File-specific: shared payloads carry evaluated formula/rollup values.
type Page = AppPage & {
  __computed?: Record<string, { value: ComputedValue; formatted: string }>;
};

// File-specific: public share signing needs getSignedUrl, which the shared
// FunctionStorageProxy does not expose.
interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  getSignedUrl(key: string, options?: { expiresIn?: number }): Promise<string>;
}

// share-mutation lists entire tables without a `.where()` filter (e.g.
// db_views), so its table refs must also expose the TableQuery paging surface
// EdgeBase provides at runtime. Type-only extension; no runtime difference.
type TableRef<T> = AppTableRef<T> & TableQuery<T>;

interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

type FunctionContext = Omit<AppFunctionContext, 'admin' | 'storage'> & {
  admin: { db(namespace: string): DbRef };
  storage?: FunctionStorageProxy;
};


type FormulaValue = string | number | boolean | null;
type ComputedValue = FormulaValue;
type ComputedMap = Record<string, Record<string, { value: ComputedValue; formatted: string }>>;

const roles = new Set<ShareRole>(['view', 'comment', 'edit', 'full_access']);
const principalTypes = new Set<PrincipalType>(['user', 'email', 'group', 'integration']);
const roleAliases: Record<string, ShareRole> = {
  view: 'view',
  viewer: 'view',
  'can view': 'view',
  comment: 'comment',
  commenter: 'comment',
  'can comment': 'comment',
  edit: 'edit',
  editor: 'edit',
  'can edit': 'edit',
  full: 'full_access',
  owner: 'full_access',
  full_access: 'full_access',
  'full access': 'full_access',
};

// Entry schemas bound id/token/label sizes; role/principalType/expiry keep
// their existing alias-aware parsers (parseRole, parsePrincipalType,
// parseShareExpiresAt), so those fields only get a length cap here.
const sharePageRefSchema = v.object({
  pageId: v.optional(v.id()),
  id: v.optional(v.id()),
});

const setWebSharingSchema = v.object({
  pageId: v.optional(v.id()),
  id: v.optional(v.id()),
  enabled: v.nullish(v.boolean()),
  public: v.nullish(v.boolean()),
  role: v.nullish(v.string({ max: 64 })),
});

const inviteSchema = v.object({
  pageId: v.optional(v.id()),
  id: v.optional(v.id()),
  label: v.nullish(v.string({ max: 512 })),
  email: v.nullish(v.string({ max: 320 })),
  principalId: v.nullish(v.string({ max: 320 })),
  principalType: v.nullish(v.string({ max: 32 })),
  role: v.nullish(v.string({ max: 64 })),
});

const permissionRefSchema = v.object({
  permissionId: v.optional(v.id()),
  id: v.optional(v.id()),
  role: v.nullish(v.string({ max: 64 })),
});

const publicPageSchema = v.object({
  token: v.optional(v.string({ min: 1, max: 256 })),
  shareId: v.optional(v.string({ min: 1, max: 256 })),
});

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

function parseRole(value: unknown, fallback: ShareRole = 'view'): ShareRole {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const role = roleAliases[normalized] ?? (roles.has(normalized as ShareRole) ? (normalized as ShareRole) : undefined);
  if (!role) throw new Error('role must be view, comment, edit, or full_access.');
  return role;
}

function parsePrincipalType(value: unknown): PrincipalType {
  if (typeof value !== 'string') return 'email';
  const normalized = value.trim().toLowerCase();
  if (!principalTypes.has(normalized as PrincipalType)) {
    throw new Error('principalType must be user, email, group, or integration.');
  }
  return normalized as PrincipalType;
}

function parseShareExpiresAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === false) return null;
  if (typeof value !== 'string') throw new Error('expiresAt must be an ISO date, duration, or null.');
  const raw = value.trim().toLowerCase();
  if (!raw || raw === 'never' || raw === 'none') return null;
  const duration = raw.match(/^(\d+)(m|h|d|w)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2];
    const multipliers: Record<string, number> = {
      m: 60_000,
      h: 60 * 60_000,
      d: 24 * 60 * 60_000,
      w: 7 * 24 * 60 * 60_000,
    };
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('expiresAt duration is invalid.');
    return new Date(Date.now() + amount * multipliers[unit]).toISOString();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('expiresAt must be an ISO date, duration, or null.');
  return new Date(timestamp).toISOString();
}

function cleanLabel(value: unknown) {
  return requireString(value, 'label').replace(/\s+/g, ' ');
}

function normalizePrincipalId(type: PrincipalType, label: string, value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return type === 'email' ? label.toLowerCase() : label;
}

async function normalizeInvitePrincipal(
  db: DbRef,
  workspace: Workspace,
  principalType: PrincipalType,
  label: string,
  value: unknown,
) {
  if (principalType !== 'group') {
    return {
      label,
      principalId: normalizePrincipalId(principalType, label, value),
    };
  }
  if (!workspace.organizationId) {
    throw new Error('Group page access requires an organization workspace.');
  }
  const lookup = typeof value === 'string' && value.trim() ? value.trim() : label;
  const groups = await listAll(
    db.table<OrganizationGroup>('organization_groups').where('organizationId', '==', workspace.organizationId),
  );
  const group = groups.find(
    (item) =>
      item.id === lookup ||
      item.name.trim().toLowerCase() === lookup.trim().toLowerCase(),
  );
  if (!group) throw new Error('Organization group was not found.');
  return {
    label: group.name,
    principalId: group.id,
  };
}

function permissionKey(permission: Pick<PagePermission, 'principalType' | 'principalId' | 'label'>) {
  return `${permission.principalType}:${(permission.principalId || permission.label).trim().toLowerCase()}`;
}

export async function pagePermissionRecordId(
  pageId: string,
  principalType: PrincipalType,
  principalId: string,
) {
  const key = `${pageId}\u0000${principalType}\u0000${principalId.trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `permission_${hex}`;
}

function pageTitle(page: Page) {
  return page.title?.trim() || 'Untitled';
}

function shareRoleLabel(role: ShareRole) {
  if (role === 'full_access') return 'Full access';
  if (role === 'edit') return 'Can edit';
  if (role === 'comment') return 'Can comment';
  return 'Can view';
}

async function upsertNotification(
  db: DbRef,
  record: Omit<NotificationRecord, 'id'>,
) {
  const notifications = db.table<NotificationRecord>('notifications');
  const existing = await listAll(notifications.where('workspaceId', '==', record.workspaceId));
  const current = existing.find(
    (item) => item.userId === record.userId && item.activityKey === record.activityKey,
  );
  if (current) {
    return notifications.update(current.id, {
      ...record,
      readAt: current.readAt ?? null,
    });
  }
  return notifications.insert(record);
}

async function emitShareNotification(
  db: DbRef,
  page: Page,
  permission: PagePermission,
  actorId: string,
  action: 'invite' | 'role_update',
): Promise<number> {
  const userIds = new Set<string>();
  if (permission.principalType === 'user' && permission.principalId) {
    userIds.add(permission.principalId);
  }
  if (permission.principalType === 'group' && permission.principalId) {
    const members = await listAll(
      db.table<OrganizationGroupMember>('organization_group_members').where(
        'groupId',
        '==',
        permission.principalId,
      ),
    );
    for (const member of members) userIds.add(member.userId);
  }
  userIds.delete(actorId);
  if (!userIds.size) return 0;
  const occurredAt = permission.updatedAt ?? permission.createdAt ?? nowIso();
  const atKey = Date.parse(occurredAt) || occurredAt;
  const title = pageTitle(page);
  let failed = 0;
  for (const userId of userIds) {
    const delivered = await bestEffort(`share notification for user ${userId}`, upsertNotification(db, {
      workspaceId: page.workspaceId,
      userId,
      activityKey: `share:${permission.id}:${userId}:${atKey}`,
      kind: 'system',
      pageId: page.id,
      blockId: null,
      commentId: null,
      actorId,
      title,
      preview:
        action === 'invite'
          ? `You were invited to ${title} with ${shareRoleLabel(permission.role)} access.`
          : `Your access to ${title} is now ${shareRoleLabel(permission.role)}.`,
      target: `/p/${encodeURIComponent(page.id)}`,
      metadata: {
        source: 'share',
        action,
        permissionId: permission.id,
        role: permission.role,
        principalType: permission.principalType,
      },
      occurredAt,
    }));
    if (!delivered) failed += 1;
  }
  return failed;
}

function sortPermissions(items: PagePermission[]) {
  return items
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function collectSubtree(pages: Page[], rootId: string) {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const childrenByParent = new Map<string, Page[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = childrenByParent.get(page.parentId) ?? [];
    list.push(page);
    childrenByParent.set(page.parentId, list);
  }

  const out = new Set<string>();
  const visit = (pageId: string) => {
    if (out.has(pageId)) return;
    out.add(pageId);
    for (const child of childrenByParent.get(pageId) ?? []) {
      if (isPublicShareHiddenDatabaseChild(pagesById.get(pageId), child)) continue;
      visit(child.id);
    }
  };
  visit(rootId);
  return out;
}

function isPublicShareDatabaseBlock(block: Block) {
  return block.type === 'child_database' || block.type === 'inline_database';
}

function isPublicShareHiddenDatabaseChild(parent: Page | undefined, child: Page) {
  return !!parent && parent.kind !== 'database' && child.kind === 'database' && child.parentType === 'page';
}

export async function collectPublicSharePageGraph(
  pages: Page[],
  blocksTable: TableRef<Block>,
  rootId: string,
) {
  const livePages = pages.filter((page) => !page.inTrash);
  const pagesById = new Map(livePages.map((page) => [page.id, page]));
  const pageIds = collectSubtree(livePages, rootId);
  const blocksByPageId = new Map<string, Block[]>();
  const scanned = new Set<string>();
  const queue = Array.from(pageIds);

  while (queue.length) {
    const pageId = queue.shift();
    if (!pageId || scanned.has(pageId) || !pagesById.has(pageId)) continue;
    scanned.add(pageId);
    const blocks = await listAll(blocksTable.where('pageId', '==', pageId));
    blocksByPageId.set(pageId, blocks);

    for (const linkedId of publicShareLinkedPageIds(blocks)) {
      if (!pagesById.has(linkedId) || pageIds.has(linkedId)) continue;
      const linkedRoot = pagesById.get(linkedId);
      // A child_page / link_to_page block can reference an ARBITRARY page id
      // (block-mutation stores block.content unvalidated), so following it
      // unconditionally lets any workspace member publish any private workspace
      // page to the internet by embedding its id in a page they then share.
      // Only follow the reference when the target is independently published
      // (its own isPublic). Genuine subpages of the shared root are NOT reached
      // here — they already have parentId chaining into collectSubtree above and
      // keep inheriting the root's public status — so this gate only blocks
      // non-descendant embeds/aliases, which are the leak vector.
      if (!linkedRoot || !linkedRoot.isPublic) continue;
      const linkedSubtree = collectSubtree(livePages, linkedId);
      for (const linkedPageId of linkedSubtree) {
        if (pageIds.has(linkedPageId)) continue;
        pageIds.add(linkedPageId);
        queue.push(linkedPageId);
      }
    }
  }

  return { pageIds, blocksByPageId };
}

// Page ids referenced from a child_page / link_to_page block. Both can carry an
// arbitrary, unvalidated target id, so collectPublicSharePageGraph only follows
// them into the public graph when the target is independently published.
function publicShareLinkedPageIds(blocks: Block[]) {
  const out = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'child_page' && block.type !== 'link_to_page') continue;
    const id = typeof block.content?.childPageId === 'string' ? block.content.childPageId.trim() : '';
    if (id) out.add(id);
  }
  return out;
}

function normalizeNotionScopeId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .replace(/^collection:\/\//i, '')
    .replace(/^data_source:\/\//i, '')
    .replace(/-/g, '')
    .trim()
    .toLowerCase();
  return clean || undefined;
}

function pageNotionDatabaseId(page: Page) {
  const value = page.properties?.notionDatabaseId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isNotionLinkedDatabaseSourceUnavailable(page: Page) {
  return page.properties?.notionLinkedDatabaseSourceUnavailable === true;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function notionParentDatabaseId(view: DbView) {
  const notion = recordObject(view.config?.notion);
  if (!notion) return undefined;
  const parent = recordObject(notion.parent);
  if (parent) {
    const id = parent.database_id ?? parent.databaseId ?? parent.id;
    if (typeof id === 'string') return id;
  }
  const fallback =
    notion.parent_database_id ??
    notion.parentDatabaseId ??
    notion.database_id ??
    notion.databaseId;
  return typeof fallback === 'string' ? fallback : undefined;
}

async function resolvePublicImportedLinkedDatabaseSource(
  db: DbRef,
  requestedDatabase: Page,
) {
  if (!isNotionLinkedDatabaseSourceUnavailable(requestedDatabase)) return null;
  const targetNotionDatabaseId = normalizeNotionScopeId(pageNotionDatabaseId(requestedDatabase));
  if (!targetNotionDatabaseId) return null;

  const views = await listAll(db.table<DbView>('db_views'));
  const scopedViews = views
    .filter((view) => normalizeNotionScopeId(notionParentDatabaseId(view)) === targetNotionDatabaseId)
    .sort(bySortPos);
  const sourceDatabaseIds = Array.from(
    new Set(scopedViews.map((view) => view.databaseId).filter((id) => id !== requestedDatabase.id)),
  );

  for (const sourceDatabaseId of sourceDatabaseIds) {
    const sourceDatabase = await db.table<Page>('pages').getOne(sourceDatabaseId);
    if (
      !sourceDatabase ||
      sourceDatabase.inTrash ||
      sourceDatabase.kind !== 'database' ||
      sourceDatabase.workspaceId !== requestedDatabase.workspaceId
    ) {
      continue;
    }
    const viewsForSource = scopedViews.filter((view) => view.databaseId === sourceDatabase.id);
    if (viewsForSource.length === 0) continue;
    return {
      requestedDatabase,
      sourceDatabase,
      targetNotionDatabaseId,
      views: viewsForSource,
    };
  }

  return null;
}

function bySortPos(a: { position: number }, b: { position: number }) {
  return a.position - b.position;
}

function compactNumber(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function formatNumberValue(value: unknown, format = 'number') {
  if (value == null) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (format === 'number') return compactNumber(n);
  if (format === 'comma') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(n);
  if (format === 'percent') {
    return new Intl.NumberFormat(undefined, {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(n / 100);
  }
  if (format === 'won') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'KRW',
      maximumFractionDigits: 0,
    }).format(n);
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: format === 'euro' ? 'EUR' : 'USD',
    maximumFractionDigits: 2,
  }).format(n);
}

function numberFormatForProperty(prop: DbProperty) {
  const normalize = (format: unknown) => {
    if (format === 'number_with_commas') return 'comma';
    return (
      format === 'number' ||
      format === 'comma' ||
      format === 'percent' ||
      format === 'dollar' ||
      format === 'won' ||
      format === 'euro'
    )
      ? format
      : undefined;
  };
  const config = prop.config ?? {};
  const direct = typeof config.numberFormat === 'string' ? config.numberFormat : undefined;
  const notion = config.notion && typeof config.notion === 'object'
    ? config.notion as { number?: { format?: unknown } }
    : undefined;
  const imported = typeof notion?.number?.format === 'string' ? notion.number.format : undefined;
  return normalize(direct) ?? normalize(imported) ?? 'number';
}

function ids(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)];
}

function personIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => personIds(item)).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value !== 'object') return [];
  const id = (value as { id?: unknown; userId?: unknown }).id ?? (value as { userId?: unknown }).userId;
  return typeof id === 'string' && id.trim() ? [id.trim()] : [];
}

function titleOf(page?: Page) {
  return page?.title || 'Untitled';
}

function formatFormulaValue(value: FormulaValue) {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return compactNumber(value);
  return String(value);
}

function computedValuePresent(value: FormulaValue) {
  return value !== null && value !== '';
}

function importedComputedValue(row: Page, prop: DbProperty): ComputedValue | undefined {
  if (prop.type !== 'formula' && prop.type !== 'rollup') return undefined;
  const value = row.properties?.[prop.id];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function computedWithImportedFallback(row: Page, prop: DbProperty, value: FormulaValue): ComputedValue {
  if (computedValuePresent(value)) return value;
  const imported = importedComputedValue(row, prop);
  return imported === undefined ? value : imported;
}

function selectOptionName(prop: DbProperty, value: unknown) {
  const options = Array.isArray(prop.config?.options) ? prop.config.options : [];
  const match = options.find((option) => {
    if (!option || typeof option !== 'object') return false;
    const item = option as { id?: unknown; name?: unknown };
    return item.id === value || item.name === value;
  }) as { name?: unknown } | undefined;
  return typeof match?.name === 'string' ? match.name : String(value ?? '');
}

function rawPropertyValue(row: Page, prop: DbProperty): unknown {
  if (prop.type === 'title') return row.title;
  if (prop.type === 'created_time') return row.createdAt;
  if (prop.type === 'last_edited_time') return row.updatedAt;
  if (prop.type === 'created_by') return row.createdBy;
  if (prop.type === 'last_edited_by') return row.lastEditedBy;
  return row.properties?.[prop.id];
}

function propertyValue(row: Page, prop: DbProperty): FormulaValue {
  if (prop.type === 'title') return row.title ?? '';
  const value = row.properties?.[prop.id];
  if (value == null) return '';
  if (prop.type === 'number') return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (prop.type === 'checkbox') return value === true;
  if (prop.type === 'select' || prop.type === 'status') return selectOptionName(prop, value);
  if (prop.type === 'multi_select') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => selectOptionName(prop, item)).filter(Boolean).join(', ');
  }
  if (prop.type === 'date') {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const start = (value as { start?: unknown }).start;
      const end = (value as { end?: unknown }).end;
      if (typeof start === 'string' && typeof end === 'string' && end) return `${start}/${end}`;
      return typeof start === 'string' ? start : '';
    }
  }
  if (prop.type === 'formula' || prop.type === 'rollup') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function evaluateFormula(row: Page, prop: DbProperty, props: DbProperty[]): FormulaValue {
  const rawFormula = prop.config?.formula;
  const expression = typeof rawFormula === 'string' ? rawFormula.trim() : '';
  if (!expression) return '';
  // Shared formula engine (formula-core), matching page-query — replaces the
  // ~700-line private tokenizer/parser copy this file used to carry.
  return evaluateFormulaExpression(expression, (name) => {
    const target = props.find((item) => item.name === name || item.id === name);
    if (!target || target.id === prop.id) return '';
    return propertyValue(row, target);
  });
}

function displayPropertyValue(
  row: Page,
  prop: DbProperty,
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
  depth = 0,
): string {
  if (depth > 3) return '';
  const value = rawPropertyValue(row, prop);
  if (prop.type === 'title') return titleOf(row);
  if (prop.type === 'formula') {
    const props = propsByDb.get(prop.databaseId) ?? [];
    return formatFormulaValue(computedWithImportedFallback(row, prop, evaluateFormula(row, prop, props)));
  }
  if (prop.type === 'rollup') {
    return formatFormulaValue(computedWithImportedFallback(row, prop, evaluateRollup(row, prop, propsByDb, pagesById, depth + 1)));
  }
  if (value == null || value === '') return '';
  if (prop.type === 'select' || prop.type === 'status') return selectOptionName(prop, value);
  if (prop.type === 'multi_select') return ids(value).map((id) => selectOptionName(prop, id)).join(', ');
  if (prop.type === 'checkbox') return value ? 'Checked' : 'Unchecked';
  if (prop.type === 'number') return formatNumberValue(value, numberFormatForProperty(prop));
  if (prop.type === 'unique_id') {
    const prefix = typeof prop.config?.idPrefix === 'string' ? prop.config.idPrefix.trim() : '';
    return prefix ? `${prefix}-${value}` : String(value);
  }
  if (prop.type === 'date' || prop.type === 'created_time' || prop.type === 'last_edited_time') {
    return String(value).slice(0, 10);
  }
  if (prop.type === 'relation') {
    return ids(value).map((id) => titleOf(pagesById.get(id))).join(', ');
  }
  if (prop.type === 'person' || prop.type === 'created_by' || prop.type === 'last_edited_by') {
    return personIds(value).map((id) => (id ? 'You' : '')).filter(Boolean).join(', ');
  }
  if (prop.type === 'files') {
    const files = Array.isArray(value) ? value : [value];
    return files
      .map((file) => {
        if (typeof file === 'string') return file;
        if (!file || typeof file !== 'object') return '';
        const item = file as { name?: unknown; fileName?: unknown; url?: unknown };
        return String(item.name ?? item.fileName ?? item.url ?? '');
      })
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

function propsForRelationTarget(relationProp: DbProperty, propsByDb: Map<string, DbProperty[]>) {
  const dbId =
    typeof relationProp.config?.relationDatabaseId === 'string'
      ? relationProp.config.relationDatabaseId
      : relationProp.databaseId;
  return propsByDb.get(dbId) ?? [];
}

function evaluateRollup(
  row: Page,
  prop: DbProperty,
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
  depth = 0,
): ComputedValue {
  if (depth > 3) return '';
  const sourceProps = propsByDb.get(prop.databaseId) ?? [];
  const relationProp = sourceProps.find((item) => item.id === prop.config?.rollupRelationPropertyId);
  if (!relationProp || relationProp.type !== 'relation') return '';

  const targetProps = propsForRelationTarget(relationProp, propsByDb);
  // Thin public-share adapter over the shared rollup engine
  // (shared/database/rollup-core.ts); mirrors page-query so app reads and
  // public-share snapshots compute rollups identically.
  const ctx: RollupContext = {
    pagesById: (id) => pagesById.get(id) as RollupPage | undefined,
    propsByDb: (dbId) => (propsByDb.get(dbId) ?? []) as unknown as RollupProperty[],
    rawValue: (page, coreProp) =>
      rawPropertyValue(page as unknown as Page, coreProp as unknown as DbProperty),
    displayValue: (page, coreProp) =>
      displayPropertyValue(page as unknown as Page, coreProp as unknown as DbProperty, propsByDb, pagesById, depth + 1),
  };
  return evaluateRollupCore(
    row as unknown as RollupPage,
    prop as unknown as RollupProperty,
    sourceProps as unknown as RollupProperty[],
    targetProps as unknown as RollupProperty[],
    ctx,
  );
}

function computedPropertyValues(
  rows: Page[],
  props: DbProperty[],
  propsByDb: Map<string, DbProperty[]>,
  pagesById: Map<string, Page>,
) {
  const computedProps = props.filter((prop) => prop.type === 'formula' || prop.type === 'rollup');
  if (computedProps.length === 0) return undefined;
  const computed: ComputedMap = {};
  for (const row of rows) {
    for (const prop of computedProps) {
      const evaluated =
        prop.type === 'rollup'
          ? evaluateRollup(row, prop, propsByDb, pagesById)
          : evaluateFormula(row, prop, props);
      const value = computedWithImportedFallback(row, prop, evaluated);
      computed[row.id] = computed[row.id] ?? {};
      computed[row.id][prop.id] = { value, formatted: formatFormulaValue(value) };
    }
  }
  return computed;
}

function sharedPagesWithComputedValues(pages: Page[], properties: DbProperty[]) {
  if (!properties.some((prop) => prop.type === 'formula' || prop.type === 'rollup')) return pages;

  const propsByDb = new Map<string, DbProperty[]>();
  for (const prop of properties) {
    const items = propsByDb.get(prop.databaseId) ?? [];
    items.push(prop);
    propsByDb.set(prop.databaseId, items);
  }
  for (const items of propsByDb.values()) items.sort(bySortPos);

  const pagesById = new Map<string, Page>();
  for (const page of pages) pagesById.set(page.id, page);

  const computedByRow = new Map<string, Record<string, { value: ComputedValue; formatted: string }>>();
  const databaseIds = new Set(properties.map((prop) => prop.databaseId));
  for (const databaseId of databaseIds) {
    const rows = pages.filter((page) => page.parentType === 'database' && page.parentId === databaseId && !page.inTrash);
    if (rows.length === 0) continue;
    const computed = computedPropertyValues(rows, propsByDb.get(databaseId) ?? [], propsByDb, pagesById);
    for (const [rowId, values] of Object.entries(computed ?? {})) computedByRow.set(rowId, values);
  }
  if (computedByRow.size === 0) return pages;

  return pages.map((page) => {
    const computed = computedByRow.get(page.id);
    return computed ? { ...page, __computed: computed } : page;
  });
}

function decodeStoragePath(path: string) {
  return path
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

function storageKeyFromUrl(value: string, bucket = FILE_BUCKET) {
  const raw = value.trim();
  if (!raw || !/^(https?:\/\/|\/)/i.test(raw)) return undefined;
  try {
    const parsed = new URL(raw, 'http://notionlike.local');
    if (parsed.searchParams.has('token')) return undefined;
    const marker = `/api/storage/${encodeURIComponent(bucket)}/`;
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return undefined;
    return decodeStoragePath(parsed.pathname.slice(index + marker.length));
  } catch {
    return undefined;
  }
}

function storageBucket(storage: FunctionStorageProxy | undefined, bucket: string) {
  if (!storage) return undefined;
  if (typeof storage.bucket === 'function') return storage.bucket(bucket);
  return bucket === 'default' ? storage : undefined;
}

function uploadIsInsideSharedSubtree(upload: FileUpload, pageIds: Set<string>) {
  return (
    upload.status === 'uploaded' &&
    (upload.bucket || FILE_BUCKET) === FILE_BUCKET &&
    ((upload.pageId && pageIds.has(upload.pageId)) ||
      (upload.databaseId && pageIds.has(upload.databaseId)))
  );
}

async function sharedUploadMap(db: DbRef, workspaceId: string, pageIds: Set<string>) {
  const uploads = await listAll(db.table<FileUpload>('file_uploads').where('workspaceId', '==', workspaceId));
  const allowed = new Map<string, FileUpload>();
  for (const upload of uploads) {
    if (upload.key && uploadIsInsideSharedSubtree(upload, pageIds)) allowed.set(upload.key, upload);
  }
  return allowed;
}

async function signSharedFileUrl(
  value: string,
  allowedUploads: Map<string, FileUpload>,
  storage: FunctionStorageProxy | undefined,
) {
  const key = storageKeyFromUrl(value);
  if (!key || !allowedUploads.has(key)) return value;
  const proxy = storageBucket(storage, FILE_BUCKET);
  if (!proxy) return value;
  try {
    return await proxy.getSignedUrl(key, { expiresIn: SHARED_FILE_URL_TTL_SECONDS });
  } catch {
    return value;
  }
}

async function signSharedFileUrls(
  value: unknown,
  allowedUploads: Map<string, FileUpload>,
  storage: FunctionStorageProxy | undefined,
): Promise<unknown> {
  if (typeof value === 'string') return signSharedFileUrl(value, allowedUploads, storage);
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => signSharedFileUrls(item, allowedUploads, storage)));
  }
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = await signSharedFileUrls(item, allowedUploads, storage);
  }
  return out;
}

async function pageContext(db: DbRef, pageId: string) {
  const pages = db.table<Page>('pages');
  const workspaces = db.table<Workspace>('workspaces');
  const permissionsTable = db.table<PagePermission>('page_permissions');
  const shareLinksTable = db.table<ShareLink>('share_links');

  const page = await pages.getOne(pageId);
  if (!page || page.inTrash) throw new Error('Page was not found.');
  const workspace = await workspaces.getOne(page.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  const [permissions, links] = await Promise.all([
    listAll(permissionsTable.where('pageId', '==', page.id)),
    listAll(shareLinksTable.where('pageId', '==', page.id)),
  ]);

  return {
    pages,
    permissionsTable,
    shareLinksTable,
    page,
    workspace,
    permissions: sortPermissions(permissions),
    shareLink: links.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0] ?? null,
  };
}

async function userWorkspaceRole(db: DbRef, workspaceId: string, actorId: string) {
  const members = await listAll(
    db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
  );
  return members.find((member) => member.userId === actorId)?.role;
}

// Re-asserts the actor's manage-access basis inside the write transaction, so
// a concurrent owner transfer or admin demotion aborts the grant instead of
// applying a stale one. When the basis is page authorship (immutable) or a
// full_access page permission (not cheaply re-expressible as row conditions),
// no guard is added — matching the pre-transact behavior for those paths.
async function manageAccessGuards(
  db: DbRef,
  page: Page,
  workspace: Workspace,
  actorId: string,
): Promise<TransactOperation[]> {
  if (!workspace.ownerId) return [];
  if (workspace.ownerId === actorId) {
    return [{
      table: 'workspaces',
      op: 'expect',
      id: workspace.id,
      where: [['ownerId', '==', actorId]],
      exists: true,
    }];
  }
  if (page.createdBy === actorId) return [];
  const role = await userWorkspaceRole(db, workspace.id, actorId);
  if (role === 'owner' || role === 'admin') {
    return [{
      table: 'workspace_members',
      op: 'expect',
      where: [
        ['workspaceId', '==', workspace.id],
        ['userId', '==', actorId],
        ['role', '==', role],
      ],
      exists: true,
    }];
  }
  return [];
}

function auditInsertOp(
  workspace: Workspace,
  event: {
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
  },
): TransactOperation | null {
  if (!workspace.organizationId) return null;
  return {
    table: 'organization_audit_events',
    op: 'insert',
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      actorId: event.actorId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      metadata: event.metadata,
      occurredAt: nowIso(),
    },
  };
}

async function runShareTransact(
  db: DbRef,
  admin: AdminDbAccessor,
  workspaceId: string,
  operations: TransactOperation[],
) {
  try {
    await transactBySideSegments(admin, workspaceId, operations);
    // Segmented mode returns no per-op results; callers re-read what they
    // need. Provide an empty results shape for compatibility.
    return { results: [] as Array<Record<string, unknown>> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An unmet manage-access guard means the actor lost the right mid-flight.
    if (message.includes('Transaction expectation failed')) {
      throw new Error('Forbidden.');
    }
    throw error;
  }
}

async function canManagePageAccess(
  db: DbRef,
  page: Page,
  workspace: Workspace,
  permissions: PagePermission[],
  actorId: string,
  actorEmail?: string | null,
) {
  void permissions;
  return sharedCanManagePageAccess(db, page, workspace, actorId, actorEmail);
}

async function pageAccessRole(
  db: DbRef,
  page: Page,
  workspace: Workspace,
  permissions: PagePermission[],
  actorId: string,
  actorEmail?: string | null,
) {
  void permissions;
  return sharedPageAccessRole(db, page, actorId, workspace, actorEmail);
}

async function assertCanManagePageAccess(
  db: DbRef,
  page: Page,
  workspace: Workspace,
  permissions: PagePermission[],
  actorId: string,
  actorEmail?: string | null,
) {
  if (await canManagePageAccess(db, page, workspace, permissions, actorId, actorEmail)) return;
  throw new Error('Forbidden.');
}

async function assertPagePermissionPolicy(
  db: DbRef,
  workspaceId: string,
  principalType: PrincipalType,
  role: ShareRole,
) {
  if (principalType === 'email') {
    await assertOrganizationSharingPolicy(
      db,
      workspaceId,
      'externalEmailSharing',
      'External email sharing is disabled by organization policy.',
    );
    await assertOrganizationDlpPolicy(
      db,
      workspaceId,
      'externalSharing',
      'External sharing is blocked by organization DLP policy.',
    );
    await assertOrganizationSharingPolicy(
      db,
      workspaceId,
      'guestAccess',
      'Guest access is disabled by organization policy.',
    );
  }
  if (role === 'full_access') {
    await assertOrganizationSharingPolicy(
      db,
      workspaceId,
      'fullAccessGrants',
      'Full access grants are disabled by organization policy.',
    );
  }
}

async function accessPayload(
  db: DbRef,
  pageId: string,
  actorId: string,
  requireManage = false,
  actorEmail?: string | null,
) {
  const ctx = await pageContext(db, pageId);
  const canManage = await canManagePageAccess(db, ctx.page, ctx.workspace, ctx.permissions, actorId, actorEmail);
  const role = await pageAccessRole(db, ctx.page, ctx.workspace, ctx.permissions, actorId, actorEmail);
  if (!role || roleRanks[role] < roleRanks.view) throw new Error('Forbidden.');
  if (requireManage && !canManage) throw new Error('Forbidden.');
  // Only managers may enumerate the full sharing roster (which includes other
  // principals' ids and external collaborators' email addresses). A view-only
  // actor sees just their own entry, not who else the page is shared with.
  return {
    page: ctx.page,
    shareLink: ctx.shareLink,
    permissions: visiblePermissionsForActor(ctx.permissions, canManage, actorId, actorEmail),
    canManage,
  };
}

// A non-manager must not be able to enumerate who else a page is shared with
// (including external email principals). Managers get the full roster; everyone
// else gets only their own permission entries.
export function visiblePermissionsForActor<
  T extends { principalType: string; principalId?: string | null; label?: string | null },
>(permissions: T[], canManage: boolean, actorId: string, actorEmail?: string | null): T[] {
  if (canManage) return permissions;
  const normalizedActorEmail = actorEmail?.trim().toLowerCase() || '';
  return permissions.filter(
    (perm) =>
      (perm.principalType === 'user' && perm.principalId === actorId) ||
      (perm.principalType === 'email' &&
        !!normalizedActorEmail &&
        (perm.principalId || perm.label || '').trim().toLowerCase() === normalizedActorEmail),
  );
}

async function setWebSharing(db: DbRef, admin: AdminDbAccessor, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pageId = requireString(body.pageId ?? body.id, 'pageId');
  const enabled = body.enabled ?? body.public;
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean.');
  const role = parseRole(body.role, 'view');
  if (role !== 'view') throw new Error('Public share links are view-only for now.');
  const expiresAt = parseShareExpiresAt(
    Object.prototype.hasOwnProperty.call(body, 'expiresAt') ? body.expiresAt : body.expiresIn,
  );

  const ctx = await pageContext(db, pageId);
  await assertCanManagePageAccess(db, ctx.page, ctx.workspace, ctx.permissions, actorId, actorEmail);
  if (enabled) {
    await assertOrganizationSharingPolicy(
      db,
      ctx.workspace.id,
      'publicWebSharing',
      'Public web sharing is disabled by organization policy.',
    );
    await assertOrganizationDlpPolicy(
      db,
      ctx.workspace.id,
      'publicSharing',
      'Public web sharing is blocked by organization DLP policy.',
    );
  }

  const ts = nowIso();
  const linkPatch: Partial<ShareLink> = {
    enabled,
    role,
    updatedAt: ts,
  };
  if (expiresAt !== undefined) linkPatch.expiresAt = expiresAt;
  const shareLinkId = ctx.shareLink?.id ?? newId();
  const insertedToken = ctx.shareLink?.token ?? newToken();
  const shareLinkExpiresAt = expiresAt !== undefined ? expiresAt : ctx.shareLink?.expiresAt ?? null;

  // Share link, page flag, and audit event commit or roll back together;
  // the guards abort if the actor's manage right was revoked concurrently.
  const guards = await manageAccessGuards(db, ctx.page, ctx.workspace, actorId);
  const operations: TransactOperation[] = [
    ...guards,
    ctx.shareLink
      ? { table: 'share_links', op: 'update', id: shareLinkId, data: linkPatch as Record<string, unknown> }
      : {
          table: 'share_links',
          op: 'insert',
          data: {
            id: shareLinkId,
            pageId: ctx.page.id,
            workspaceId: ctx.page.workspaceId,
            token: insertedToken,
            enabled,
            role,
            expiresAt: expiresAt ?? null,
            createdBy: actorId,
            createdAt: ts,
            updatedAt: ts,
          },
        },
    {
      table: 'pages',
      op: 'update',
      id: ctx.page.id,
      data: { isPublic: enabled, lastEditedBy: actorId, updatedAt: ts },
    },
  ];
  const audit = auditInsertOp(ctx.workspace, {
    actorId,
    action: 'share.web_update',
    targetType: 'page',
    targetId: ctx.page.id,
    metadata: {
      enabled,
      role,
      pageId: ctx.page.id,
      shareLinkId,
      expiresAt: shareLinkExpiresAt,
      previousEnabled: ctx.shareLink?.enabled ?? false,
      previousExpiresAt: ctx.shareLink?.expiresAt ?? null,
    },
  });
  if (audit) operations.push(audit);

  await runShareTransact(db, admin, ctx.page.workspaceId, operations);
  const shareLink: ShareLink = ctx.shareLink
    ? ({ ...ctx.shareLink, ...linkPatch } as ShareLink)
    : ({
        id: shareLinkId,
        pageId: ctx.page.id,
        workspaceId: ctx.page.workspaceId,
        token: insertedToken,
        enabled,
        role,
        expiresAt: expiresAt ?? null,
        createdBy: actorId,
        createdAt: ts,
        updatedAt: ts,
      } as ShareLink);
  await ensureShareLinkIndex(admin, shareLink);
  const page: Page = { ...ctx.page, isPublic: enabled, lastEditedBy: actorId, updatedAt: ts };

  return {
    page,
    shareLink,
    permissions: ctx.permissions,
    canManage: true,
  };
}

async function invite(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
  retriedAfterConcurrentInsert = false,
) {
  const pageId = requireString(body.pageId ?? body.id, 'pageId');
  let label = cleanLabel(body.label ?? body.email ?? body.principalId);
  const principalType = parsePrincipalType(body.principalType);
  const role = parseRole(body.role, 'view');

  const ctx = await pageContext(db, pageId);
  await assertCanManagePageAccess(db, ctx.page, ctx.workspace, ctx.permissions, actorId, actorEmail);
  await assertPagePermissionPolicy(db, ctx.workspace.id, principalType, role);
  const principal = await normalizeInvitePrincipal(
    db,
    ctx.workspace,
    principalType,
    label,
    body.principalId ?? body.email,
  );
  label = principal.label;
  const principalId = principal.principalId;

  const key = `${principalType}:${principalId.trim().toLowerCase()}`;
  const matching = ctx.permissions.filter((permission) => permissionKey(permission) === key);
  const existing = matching[0];
  const duplicateIds = matching.slice(1).map((permission) => permission.id);
  const ts = nowIso();
  const permissionId = existing?.id ?? await pagePermissionRecordId(ctx.page.id, principalType, principalId);

  // Permission grant and audit event commit or roll back together; the guards
  // abort if the actor's manage right was revoked concurrently.
  const guards = await manageAccessGuards(db, ctx.page, ctx.workspace, actorId);
  const operations: TransactOperation[] = [
    ...guards,
    existing
      ? {
          table: 'page_permissions',
          op: 'update',
          id: permissionId,
          data: { label, principalType, principalId, role, updatedAt: ts },
        }
      : {
          table: 'page_permissions',
          op: 'insert',
          data: {
            id: permissionId,
            pageId: ctx.page.id,
            workspaceId: ctx.page.workspaceId,
            principalType,
            principalId,
            label,
            role,
            createdBy: actorId,
            createdAt: ts,
            updatedAt: ts,
          },
        },
    ...duplicateIds.map((id): TransactOperation => ({ table: 'page_permissions', op: 'delete', id })),
  ];
  const audit = auditInsertOp(ctx.workspace, {
    actorId,
    action: existing ? 'page_permission.update' : 'page_permission.grant',
    targetType: 'page_permission',
    targetId: permissionId,
    metadata: {
      pageId: ctx.page.id,
      principalType,
      principalId,
      label,
      role,
      previousRole: existing?.role ?? null,
      removedDuplicateIds: duplicateIds,
    },
  });
  if (audit) operations.push(audit);

  try {
    await runShareTransact(db, admin, ctx.page.workspaceId, operations);
  } catch (error) {
    // Fresh concurrent grants derive the same primary key. The database lets
    // exactly one insert win; the loser re-runs once as an update of that
    // winner. Re-read by the normalized principal key so unrelated failures
    // and theoretical digest collisions still propagate.
    if (!existing && !retriedAfterConcurrentInsert) {
      const latest = await listAll(
        db.table<PagePermission>('page_permissions').where('pageId', '==', ctx.page.id),
      );
      if (latest.some((permission) => permissionKey(permission) === key)) {
        return invite(db, admin, body, actorId, actorEmail, true);
      }
    }
    throw error;
  }
  const permission: PagePermission = existing
    ? { ...existing, label, principalType, principalId, role, updatedAt: ts }
    : {
        id: permissionId,
        pageId: ctx.page.id,
        workspaceId: ctx.page.workspaceId,
        principalType,
        principalId,
        label,
        role,
        createdBy: actorId,
        createdAt: ts,
        updatedAt: ts,
      };
  await ensurePagePermissionIndex(admin, permission);

  const permissions = sortPermissions([
    ...ctx.permissions.filter((item) => permissionKey(item) !== key),
    permission,
  ]);
  const failedNotifications = await emitShareNotification(
    db,
    ctx.page,
    permission,
    actorId,
    existing ? 'role_update' : 'invite',
  );

  return {
    page: ctx.page,
    shareLink: ctx.shareLink,
    permission,
    permissions,
    canManage: true,
    ...(failedNotifications > 0
      ? { warnings: ['Access was granted, but the in-app notification could not be delivered.'] }
      : {}),
  };
}

async function updatePermission(db: DbRef, admin: AdminDbAccessor, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const id = requireString(body.permissionId ?? body.id, 'permissionId');
  const permissionsTable = db.table<PagePermission>('page_permissions');
  const current = await permissionsTable.getOne(id);
  if (!current) throw new Error('Page permission was not found.');
  const ctx = await pageContext(db, current.pageId);
  await assertCanManagePageAccess(db, ctx.page, ctx.workspace, ctx.permissions, actorId, actorEmail);

  const role = parseRole(body.role, current.role);
  await assertPagePermissionPolicy(db, ctx.workspace.id, current.principalType, role);

  const guards = await manageAccessGuards(db, ctx.page, ctx.workspace, actorId);
  const updatedAt = nowIso();
  const key = permissionKey(current);
  const duplicateIds = ctx.permissions
    .filter((permission) => permission.id !== id && permissionKey(permission) === key)
    .map((permission) => permission.id);
  const operations: TransactOperation[] = [
    ...guards,
    { table: 'page_permissions', op: 'update', id, data: { role, updatedAt } },
    ...duplicateIds.map((duplicateId): TransactOperation => ({
      table: 'page_permissions',
      op: 'delete',
      id: duplicateId,
    })),
  ];
  const audit = auditInsertOp(ctx.workspace, {
    actorId,
    action: 'page_permission.update',
    targetType: 'page_permission',
    targetId: id,
    metadata: {
      pageId: ctx.page.id,
      principalType: current.principalType,
      principalId: current.principalId ?? null,
      label: current.label,
      role,
      previousRole: current.role,
      removedDuplicateIds: duplicateIds,
    },
  });
  if (audit) operations.push(audit);

  await runShareTransact(db, admin, ctx.page.workspaceId, operations);
  const permission: PagePermission = { ...current, role, updatedAt };

  const permissions = sortPermissions([
    ...ctx.permissions.filter((item) => permissionKey(item) !== key),
    permission,
  ]);
  const failedNotifications = await emitShareNotification(db, ctx.page, permission, actorId, 'role_update');

  return {
    page: ctx.page,
    shareLink: ctx.shareLink,
    permission,
    permissions,
    canManage: true,
    ...(failedNotifications > 0
      ? { warnings: ['The role was updated, but the in-app notification could not be delivered.'] }
      : {}),
  };
}

async function removePermission(db: DbRef, admin: AdminDbAccessor, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const id = requireString(body.permissionId ?? body.id, 'permissionId');
  const permissionsTable = db.table<PagePermission>('page_permissions');
  const current = await permissionsTable.getOne(id);
  if (!current) throw new Error('Page permission was not found.');
  const ctx = await pageContext(db, current.pageId);
  await assertCanManagePageAccess(db, ctx.page, ctx.workspace, ctx.permissions, actorId, actorEmail);

  const key = permissionKey(current);
  const revokedIds = ctx.permissions
    .filter((permission) => permissionKey(permission) === key)
    .map((permission) => permission.id);

  // Revocation must fail loudly: swallowing a failed delete would report
  // success while the principal still has access. Delete and audit commit
  // together; the guards abort on a concurrent manage-right revocation.
  const guards = await manageAccessGuards(db, ctx.page, ctx.workspace, actorId);
  const operations: TransactOperation[] = [
    ...guards,
    ...revokedIds.map((permissionId): TransactOperation => ({
      table: 'page_permissions',
      op: 'delete',
      id: permissionId,
    })),
  ];
  const audit = auditInsertOp(ctx.workspace, {
    actorId,
    action: 'page_permission.revoke',
    targetType: 'page_permission',
    targetId: id,
    metadata: {
      pageId: ctx.page.id,
      principalType: current.principalType,
      principalId: current.principalId ?? null,
      label: current.label,
      role: current.role,
      revokedPermissionIds: revokedIds,
    },
  });
  if (audit) operations.push(audit);
  await runShareTransact(db, admin, ctx.page.workspaceId, operations);
  return {
    page: ctx.page,
    shareLink: ctx.shareLink,
    deletedId: id,
    permissions: ctx.permissions.filter((item) => permissionKey(item) !== key),
    canManage: true,
  };
}

function relationTargetIdsForPage(page: Page, propsByDb: Map<string, DbProperty[]>) {
  if (page.parentType !== 'database' || !page.parentId) return [];
  const props = propsByDb.get(page.parentId) ?? [];
  const out = new Set<string>();
  for (const prop of props) {
    if (prop.type !== 'relation') continue;
    for (const id of ids(page.properties?.[prop.id])) out.add(id);
  }
  return Array.from(out);
}

function publicRelationPreviewPage(page: Page): Page {
  return {
    id: page.id,
    workspaceId: page.workspaceId,
    parentType: page.parentType,
    kind: page.kind,
    title: page.title,
    icon: page.icon,
    iconType: page.iconType,
    inTrash: page.inTrash,
    position: page.position,
    properties: {},
  };
}

async function publicPage(
  db: DbRef,
  body: Record<string, unknown>,
  storage?: FunctionStorageProxy,
) {
  const token = requireString(body.token ?? body.shareId, 'token');
  const pagesTable = db.table<Page>('pages');
  const blocksTable = db.table<Block>('blocks');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const viewsTable = db.table<DbView>('db_views');
  const templatesTable = db.table<DbTemplate>('db_templates');

  const links = await listAll(db.table<ShareLink>('share_links').where('token', '==', token));
  const link = links.find((item) => item.token === token);
  if (!link || !link.enabled) throw new Error('Shared page was not found.');
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    throw new Error('Shared page was not found.');
  }

  const root = await pagesTable.getOne(link.pageId);
  if (!root || root.inTrash || !root.isPublic) throw new Error('Shared page was not found.');
  if (!(await organizationSharingPolicyAllows(db, root.workspaceId, 'publicWebSharing', true))) {
    throw new Error('Shared page was not found.');
  }
  if (!(await organizationDlpPolicyAllows(db, root.workspaceId, 'publicSharing', true))) {
    throw new Error('Shared page was not found.');
  }

  const workspacePages = await listAll(pagesTable.where('workspaceId', '==', root.workspaceId));
  const workspacePagesById = new Map(workspacePages.map((page) => [page.id, page]));
  const { pageIds, blocksByPageId } = await collectPublicSharePageGraph(workspacePages, blocksTable, root.id);
  const navigablePageIds = new Set(pageIds);
  const pagesById = new Map<string, Page>();
  for (const page of workspacePages) {
    if (pageIds.has(page.id) && !page.inTrash) pagesById.set(page.id, page);
  }

  const properties: DbProperty[] = [];
  const views: DbView[] = [];
  const templates: DbTemplate[] = [];
  const propertiesByDb = new Map<string, DbProperty[]>();
  const databaseIdsForUploads = new Set<string>();
  const addProperties = (databaseId: string, items: DbProperty[]) => {
    const existing = new Set(properties.map((item) => `${item.databaseId}:${item.id}`));
    const mapped = items
      .filter((item) => !existing.has(`${databaseId}:${item.id}`))
      .map((item) => ({ ...item, databaseId }));
    properties.push(...mapped);
    propertiesByDb.set(databaseId, [...(propertiesByDb.get(databaseId) ?? []), ...mapped].sort(bySortPos));
  };
  const addViews = (databaseId: string, items: DbView[]) => {
    const existing = new Set(views.map((item) => `${item.databaseId}:${item.id}`));
    views.push(
      ...items
        .filter((item) => !existing.has(`${databaseId}:${item.id}`))
        .map((item) => ({ ...item, databaseId })),
    );
  };
  const addTemplates = (databaseId: string, items: DbTemplate[]) => {
    const existing = new Set(templates.map((item) => `${item.databaseId}:${item.id}`));
    templates.push(
      ...items
        .filter((item) => !existing.has(`${databaseId}:${item.id}`))
        .map((item) => ({ ...item, databaseId })),
    );
  };

  const metadataDatabaseIds = new Set<string>();
  for (const page of pagesById.values()) {
    if (page.kind === 'database') metadataDatabaseIds.add(page.id);
    if (page.parentType === 'database' && page.parentId) metadataDatabaseIds.add(page.parentId);
  }

  for (const databaseId of Array.from(metadataDatabaseIds)) {
    const database = workspacePagesById.get(databaseId);
    if (!database || database.inTrash || database.kind !== 'database') continue;
    databaseIdsForUploads.add(databaseId);
    const linkedSource = await resolvePublicImportedLinkedDatabaseSource(db, database);
    if (linkedSource) {
      const sourceDatabaseId = linkedSource.sourceDatabase.id;
      databaseIdsForUploads.add(sourceDatabaseId);
      const [sourceProperties, sourceTemplates] = await Promise.all([
        listAll(propertiesTable.where('databaseId', '==', sourceDatabaseId)),
        listAll(templatesTable.where('databaseId', '==', sourceDatabaseId)),
      ]);
      addProperties(databaseId, sourceProperties.sort(bySortPos));
      addViews(databaseId, linkedSource.views.sort(bySortPos));
      addTemplates(databaseId, sourceTemplates.sort(bySortPos));

      if (pageIds.has(databaseId)) {
        const sourceRows = workspacePages
          .filter((page) => page.parentType === 'database' && page.parentId === sourceDatabaseId && !page.inTrash)
          .map((page) => ({
            ...page,
            parentId: databaseId,
            parentType: 'database' as const,
          }));
        for (const row of sourceRows) {
          if (!pagesById.has(row.id)) pagesById.set(row.id, row);
        }
      }
      continue;
    }

    const [databaseProperties, databaseViews, databaseTemplates] = await Promise.all([
      listAll(propertiesTable.where('databaseId', '==', databaseId)),
      listAll(viewsTable.where('databaseId', '==', databaseId)),
      listAll(templatesTable.where('databaseId', '==', databaseId)),
    ]);
    addProperties(databaseId, databaseProperties.sort(bySortPos));
    addViews(databaseId, databaseViews.sort(bySortPos));
    addTemplates(databaseId, databaseTemplates.sort(bySortPos));
  }

  for (const page of Array.from(pagesById.values())) {
    if (!navigablePageIds.has(page.id)) continue;
    for (const relatedId of relationTargetIdsForPage(page, propertiesByDb)) {
      if (pagesById.has(relatedId)) continue;
      const related = workspacePagesById.get(relatedId);
      if (!related || related.inTrash || related.workspaceId !== root.workspaceId) continue;
      pagesById.set(related.id, publicRelationPreviewPage(related));
    }
  }

  const pages = Array.from(pagesById.values())
    .filter((page) => !page.inTrash)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const blocks: Block[] = [];
  for (const page of pages) {
    if (!navigablePageIds.has(page.id)) continue;
    const pageBlocks = blocksByPageId.get(page.id) ?? await listAll(blocksTable.where('pageId', '==', page.id));
    blocks.push(...pageBlocks.filter((block) => !isPublicShareDatabaseBlock(block)));
  }

  const pagesWithComputed = sharedPagesWithComputedValues(pages, properties);
  const fileDownloadsAllowed = await organizationSharingPolicyAllows(
    db,
    root.workspaceId,
    'fileDownloads',
    true,
  ) && await organizationDlpPolicyAllows(db, root.workspaceId, 'fileDownloads', true);
  const fileAllowedPageIds = new Set([...navigablePageIds, ...databaseIdsForUploads]);
  const allowedUploads = fileDownloadsAllowed
    ? await sharedUploadMap(db, root.workspaceId, fileAllowedPageIds)
    : new Map<string, FileUpload>();
  const signedPages = await signSharedFileUrls(pagesWithComputed, allowedUploads, storage) as Page[];
  const signedBlocks = await signSharedFileUrls(blocks, allowedUploads, storage) as Block[];
  const signedProperties = await signSharedFileUrls(properties, allowedUploads, storage) as DbProperty[];
  const signedViews = await signSharedFileUrls(views, allowedUploads, storage) as DbView[];
  const signedTemplates = await signSharedFileUrls(templates, allowedUploads, storage) as DbTemplate[];

  return {
    page: signedPages.find((page) => page.id === root.id) ?? root,
    pages: signedPages,
    blocks: signedBlocks,
    properties: signedProperties,
    views: signedViews,
    templates: signedTemplates,
    navigablePageIds: Array.from(navigablePageIds),
    shareLink: link,
  };
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request, storage } = context as FunctionContext;
  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const actorEmail = auth?.email ?? null;
  if (action !== 'publicPage' && !auth?.id) return jsonError(401, 'Authentication required.');

  try {
    // Inside the try so routing misses (unknown token/permission/page) map to
    // 404 through the shared error translation below instead of a 500.
    const db = action === 'publicPage'
      ? await boundedDbFromShareToken(admin, body.token ?? body.shareId)
      : action === 'updatePermission' || action === 'removePermission'
        ? await boundedDbFromPermissionHint(admin, body.permissionId ?? body.id)
        : await boundedDbFromPageHint(admin, body.pageId, body.id);
    switch (action) {
      case 'publicPage':
        return await publicPage(db, publicPageSchema.parse(body), storage);
      case 'get': {
        const ref = sharePageRefSchema.parse(body);
        return await accessPayload(db, requireString(ref.pageId ?? ref.id, 'pageId'), auth!.id, false, actorEmail);
      }
      case 'setWebSharing':
        return await setWebSharing(db, admin, setWebSharingSchema.parse(body), auth!.id, actorEmail);
      case 'invite':
        return await invite(db, admin, inviteSchema.parse(body), auth!.id, actorEmail);
      case 'updatePermission':
        return await updatePermission(db, admin, permissionRefSchema.parse(body), auth!.id, actorEmail);
      case 'removePermission':
        return await removePermission(db, admin, permissionRefSchema.parse(body), auth!.id, actorEmail);
      default:
        return jsonError(400, 'Unknown share mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['Forbidden', 'disabled by organization policy'] },
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
});
