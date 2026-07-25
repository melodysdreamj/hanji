import { defineFunction } from '@edge-base/shared';
import { databasePropertyIndexRecord } from '../lib/database-index';
import { errorStatus } from '../lib/error-status';
import {
  FORM_VIEW_MAX_QUESTIONS,
  FORM_VIEW_MAX_REFERENCE_SELECTIONS,
  normalizeFormSubmission,
  parseFormViewConfig,
  type FormViewConfig,
} from '../lib/form-view';
import { assertMinimumPageAccessRole } from '../lib/page-access';
import {
  getExisting,
  isTransactionConflictError,
  nowIso,
  projectFields,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';
import type {
  DbProperty,
  DbRef,
  DbView,
  FormAudience,
  FormLink,
  FunctionContext,
  OrganizationMember,
  Page,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';
import {
  boundedDbFromFormToken,
  boundedDbFromPageHint,
  ensureFormLinkIndex,
  ensurePageWorkspaceIndex,
  type AdminDbAccessor,
  type FormTokenRoute,
} from '../lib/workspace-db';

const FORM_REQUEST_MAX_BYTES = 64 * 1024;
const FORM_REQUEST_ID_MAX_BYTES = 512;
const FORM_OPTION_WINDOW_SIZE = 20;
const FORM_RELATION_TARGET_PROPERTIES_MAX_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const choiceTypes = new Set(['select', 'multi_select', 'status']);
const referenceTypes = new Set(['person', 'relation']);
const formHits = new Map<string, { count: number; resetAt: number }>();

function formError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw formError(`${label} must be an object.`, 400);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw formError(`${label} is required.`, 400);
  }
  const normalized = value.trim();
  if (encoder.encode(normalized).byteLength > maxBytes) {
    throw formError(`${label} is too large.`, 400);
  }
  return normalized;
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request?.body) return {};
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > FORM_REQUEST_MAX_BYTES) {
    throw formError('Form requests must be at most 64 KiB.', 413);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > FORM_REQUEST_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw formError('Form requests must be at most 64 KiB.', 413);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(decoder.decode(bytes));
    return recordValue(parsed, 'request body');
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw formError('request body must be valid JSON.', 400);
  }
}

function publicRateLimitKey(request: Request | undefined, action: string, token: string) {
  const cloudflareRequest = request as (Request & { cf?: unknown }) | undefined;
  const isCloudflare = !!cloudflareRequest?.cf && typeof cloudflareRequest.cf === 'object';
  const address = isCloudflare
    ? request?.headers.get('CF-Connecting-IP')?.trim().slice(0, 128) || 'unknown'
    : 'direct';
  return `${action}:${address}:${token}`;
}

function publicRateLimited(request: Request | undefined, action: string, token: string) {
  const now = Date.now();
  if (formHits.size > 5_000) {
    for (const [key, entry] of formHits) {
      if (now >= entry.resetAt) formHits.delete(key);
    }
  }
  const key = publicRateLimitKey(request, action, token);
  const max = action === 'submit' ? 30 : 180;
  const entry = formHits.get(key);
  if (!entry || now >= entry.resetAt) {
    formHits.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

function parseAudience(value: unknown, fallback: FormAudience): FormAudience {
  if (value === undefined) return fallback;
  if (value === 'none' || value === 'workspace' || value === 'web') return value;
  throw formError('audience must be none, workspace, or web.', 400);
}

function optionalCursor(value: unknown) {
  if (value === undefined || value === null) return undefined;
  return boundedString(value, 'after', 512);
}

function requiredWhere<T>(
  query: TableQuery<T>,
  field: string,
  op: string,
  value: unknown,
  label: string,
) {
  if (typeof query.where !== 'function') {
    throw formError(`${label} requires chained database filters.`, 500);
  }
  return query.where(field, op, value);
}

async function keysetWindow<T extends { id: string }>(
  query: TableQuery<T>,
  after: string | undefined,
  label: string,
) {
  if (
    typeof query.orderBy !== 'function'
    || typeof query.after !== 'function'
    || typeof query.includeTotal !== 'function'
  ) {
    throw formError(`${label} requires bounded id-keyset queries.`, 500);
  }
  let window: TableQuery<T> = query.orderBy('id', 'asc');
  if (typeof window.after !== 'function' || typeof window.includeTotal !== 'function') {
    throw formError(`${label} requires bounded id-keyset queries.`, 500);
  }
  window = window.includeTotal(false);
  if (after) {
    if (typeof window.after !== 'function') {
      throw formError(`${label} requires bounded id-keyset queries.`, 500);
    }
    window = window.after(after);
  }
  const result = await window.limit(FORM_OPTION_WINDOW_SIZE + 1).getList();
  const raw = result.items ?? [];
  let prior = after;
  for (const row of raw) {
    if (!row.id || (prior !== undefined && row.id.localeCompare(prior) <= 0)) {
      throw formError(`${label} returned a non-advancing cursor.`, 500);
    }
    prior = row.id;
  }
  if (raw.length === 0 && result.hasMore) {
    throw formError(`${label} returned an empty page with continuation.`, 500);
  }
  const rows = raw.slice(0, FORM_OPTION_WINDOW_SIZE);
  const hasMore = raw.length > FORM_OPTION_WINDOW_SIZE || result.hasMore === true;
  return {
    rows,
    hasMore,
    after: hasMore ? rows.at(-1)?.id ?? null : null,
  };
}

function questionPropertyIds(formValue: unknown) {
  const form = recordValue(formValue, 'form');
  if (!Array.isArray(form.questions)) throw formError('form.questions must be an array.', 400);
  if (form.questions.length > FORM_VIEW_MAX_QUESTIONS) {
    throw formError(`A form may contain at most ${FORM_VIEW_MAX_QUESTIONS} questions.`, 400);
  }
  const ids: string[] = [];
  for (let index = 0; index < form.questions.length; index += 1) {
    const question = recordValue(form.questions[index], `form.questions[${index}]`);
    ids.push(boundedString(
      question.propertyId,
      `form.questions[${index}].propertyId`,
      512,
    ));
  }
  return Array.from(new Set(ids));
}

async function namedFormProperties(
  db: DbRef,
  databaseId: string,
  ids: string[],
  staleStatus: 400 | 409,
) {
  if (ids.length === 0) return [];
  const result = await db.table<DbProperty>('db_properties')
    .where('id', 'in', ids)
    .page(1)
    .limit(ids.length + 1)
    .getList();
  const rows = (result.items ?? []).filter((property) => (
    ids.includes(property.id) && property.databaseId === databaseId
  ));
  const byId = new Map(rows.map((property) => [property.id, property]));
  const missing = ids.find((id) => !byId.has(id));
  if (missing || result.hasMore || rows.length !== ids.length) {
    throw formError(
      staleStatus === 409
        ? `Form question property ${missing ?? 'set'} is no longer writable.`
        : `Form question references an unknown property: ${missing ?? 'set'}.`,
      staleStatus,
    );
  }
  return ids.map((id) => byId.get(id)!);
}

function formFromView(view: DbView) {
  const config = view.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw formError('Form was not found.', 404);
  }
  const form = (config as Record<string, unknown>).hanjiForm;
  if (!form) throw formError('Form was not found.', 404);
  return form;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function definitionRevision(
  link: FormLink,
  view: DbView,
  properties: DbProperty[],
  rawForm: unknown,
) {
  return sha256Hex(JSON.stringify({
    link: [link.id, link.token, link.audience, link.enabled, link.updatedAt ?? null],
    view: [view.id, view.databaseId, view.type, view.updatedAt ?? null, rawForm],
    properties: properties.map((property) => [
      property.id,
      property.databaseId,
      property.type,
      property.updatedAt ?? null,
    ]),
  }));
}

function formConfigOrConflict(rawForm: unknown, properties: DbProperty[]) {
  try {
    return parseFormViewConfig(rawForm, properties);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw formError(`Form definition is no longer writable: ${message}`, 409);
  }
}

function formHasReferenceQuestions(form: FormViewConfig, properties: DbProperty[]) {
  const byId = new Map(properties.map((property) => [property.id, property]));
  return form.questions.some((question) => referenceTypes.has(byId.get(question.propertyId)?.type ?? ''));
}

function assertAudienceSupportsForm(
  audience: FormAudience,
  form: FormViewConfig,
  properties: DbProperty[],
) {
  if (audience === 'web' && formHasReferenceQuestions(form, properties)) {
    throw formError('Person and relation form questions are workspace-only.', 400);
  }
}

function publicOption(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const option = value as Record<string, unknown>;
  if (typeof option.id !== 'string' || typeof option.name !== 'string') return null;
  return {
    id: option.id,
    name: option.name,
    ...(typeof option.color === 'string' ? { color: option.color } : {}),
  };
}

function publicProperty(property: DbProperty) {
  const options = choiceTypes.has(property.type) && Array.isArray(property.config?.options)
    ? property.config.options.map(publicOption).filter((option) => option !== null)
    : null;
  return {
    id: property.id,
    name: property.name,
    type: property.type,
    ...(property.description ? { description: property.description } : {}),
    ...(options ? { config: { options } } : {}),
  };
}

function exactRouteLink(link: FormLink | null, route: FormTokenRoute): link is FormLink {
  return !!link
    && link.id === route.linkId
    && link.token === route.token
    && link.workspaceId === route.workspaceId
    && link.databaseId === route.databaseId
    && link.viewId === route.viewId
    && link.enabled === true
    && link.audience !== 'none';
}

interface LoadedForm {
  db: DbRef;
  link: FormLink;
  view: DbView;
  database: Page;
  properties: DbProperty[];
  form: FormViewConfig;
  revision: string;
}

async function loadForm(
  route: FormTokenRoute,
  auth: FunctionContext['auth'],
  expectedRevision?: string,
): Promise<LoadedForm> {
  const { db } = route;
  const link = await getExisting(db.table<FormLink>('form_links'), route.linkId);
  if (!exactRouteLink(link, route)) throw formError('Form was not found.', 404);
  if (link.audience === 'workspace' && !auth?.id) {
    throw formError('Authentication required.', 401);
  }

  const [view, database] = await Promise.all([
    getExisting(db.table<DbView>('db_views'), route.viewId),
    getExisting(db.table<Page>('pages'), route.databaseId),
  ]);
  if (
    !view
    || view.databaseId !== route.databaseId
    || view.type !== 'form'
    || !database
    || database.id !== route.databaseId
    || database.workspaceId !== route.workspaceId
    || database.kind !== 'database'
    || database.inTrash === true
    || database.deletionPendingAt
  ) {
    throw formError('Form was not found.', 404);
  }
  if (link.audience === 'workspace') {
    await assertMinimumPageAccessRole(db, database, auth!.id, 'view', auth?.email);
  }

  const rawForm = formFromView(view);
  const propertyIds = questionPropertyIds(rawForm);
  const properties = await namedFormProperties(db, database.id, propertyIds, 409);
  const revision = await definitionRevision(link, view, properties, rawForm);
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw formError('Form definition changed. Reload and try again.', 409);
  }
  const form = formConfigOrConflict(rawForm, properties);
  if (link.audience === 'web' && formHasReferenceQuestions(form, properties)) {
    throw formError('Form was not found.', 404);
  }
  return {
    db,
    link,
    view,
    database,
    properties,
    form,
    revision,
  };
}

function scalarExpectations(row: Record<string, unknown>, fields: string[]) {
  return fields.map((field): [string, '==', unknown] => [field, '==', row[field] ?? null]);
}

async function configure(
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const databaseId = boundedString(body.databaseId, 'databaseId', 512);
  const viewId = boundedString(body.viewId, 'viewId', 512);
  const db = await boundedDbFromPageHint(admin, databaseId);
  const [database, view, linkResult] = await Promise.all([
    getExisting(db.table<Page>('pages'), databaseId),
    getExisting(db.table<DbView>('db_views'), viewId),
    db.table<FormLink>('form_links').where('viewId', '==', viewId).page(1).limit(2).getList(),
  ]);
  if (!database || database.kind !== 'database' || database.inTrash) {
    throw formError('Database was not found.', 404);
  }
  if (database.isLocked) throw formError('Database is locked.', 423);
  if (!view || view.databaseId !== databaseId || view.type !== 'form') {
    throw formError('Form view was not found.', 404);
  }
  await assertMinimumPageAccessRole(db, database, actorId, 'full_access', actorEmail);

  const rawForm = body.form;
  const properties = await namedFormProperties(
    db,
    databaseId,
    questionPropertyIds(rawForm),
    400,
  );
  const form = parseFormViewConfig(rawForm, properties);
  const existingLinks = (linkResult.items ?? []).filter((link) => link.viewId === viewId);
  if (linkResult.hasMore || existingLinks.length > 1) {
    throw formError('Form view has conflicting links.', 409);
  }
  const existingLink = existingLinks[0];
  const audience = parseAudience(body.audience, existingLink?.audience ?? 'none');
  assertAudienceSupportsForm(audience, form, properties);
  const enabled = audience !== 'none';
  const timestamp = nowIso();
  const link: FormLink = existingLink
    ? { ...existingLink, audience, enabled, updatedAt: timestamp }
    : {
        id: crypto.randomUUID(),
        workspaceId: database.workspaceId,
        databaseId,
        viewId,
        token: crypto.randomUUID().replace(/-/g, ''),
        audience,
        enabled,
        createdBy: actorId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  const currentConfig = view.config && typeof view.config === 'object' && !Array.isArray(view.config)
    ? view.config
    : {};
  const nextConfig = {
    ...currentConfig,
    type: 'form',
    hanjiForm: form,
    // A non-authoritative display snapshot lets the builder restore its last
    // selected share state without exposing the bearer token in view data.
    hanjiFormAudience: audience,
  };
  const operations: TransactOperation[] = [
    {
      table: 'pages', op: 'expect', id: database.id,
      where: scalarExpectations(database as unknown as Record<string, unknown>, [
        'workspaceId', 'kind', 'inTrash', 'deletionPendingAt', 'isLocked', 'updatedAt',
      ]),
      exists: true,
    },
    {
      table: 'db_views', op: 'expect', id: view.id,
      where: scalarExpectations(view as unknown as Record<string, unknown>, [
        'databaseId', 'type', 'updatedAt',
      ]),
      exists: true,
    },
    ...properties.map((property): TransactOperation => ({
      table: 'db_properties', op: 'expect', id: property.id,
      where: scalarExpectations(property as unknown as Record<string, unknown>, [
        'databaseId', 'type', 'updatedAt',
      ]),
      exists: true,
    })),
    ...(existingLink ? [{
      table: 'form_links', op: 'expect' as const, id: existingLink.id,
      where: scalarExpectations(existingLink as unknown as Record<string, unknown>, [
        'workspaceId', 'databaseId', 'viewId', 'token', 'audience', 'enabled', 'updatedAt',
      ]),
      exists: true,
    }] : [{
      table: 'form_links', op: 'expect' as const,
      where: [['viewId', '==', viewId] as [string, '==', unknown]],
      exists: false,
    }]),
    { table: 'db_views', op: 'update', id: view.id, data: { config: nextConfig, updatedAt: timestamp } },
    existingLink
      ? {
          table: 'form_links', op: 'update', id: link.id,
          data: { audience, enabled, updatedAt: timestamp },
        }
      : { table: 'form_links', op: 'insert', data: link as unknown as Record<string, unknown> },
  ];
  await db.transact(operations);
  await ensureFormLinkIndex(admin, link);
  return {
    form,
    formLink: link,
    view: { ...view, config: nextConfig, updatedAt: timestamp },
  };
}

async function definition(route: FormTokenRoute, auth: FunctionContext['auth']) {
  const loaded = await loadForm(route, auth);
  return {
    form: loaded.form,
    properties: loaded.properties.map(publicProperty),
    revision: loaded.revision,
  };
}

async function activeOrganizationUserIds(
  db: DbRef,
  workspace: Workspace,
  userIds: string[],
) {
  if (!workspace.organizationId || userIds.length === 0) return new Set(userIds);
  let query: TableQuery<OrganizationMember> = db
    .table<OrganizationMember>('organization_members')
    .where('organizationId', '==', workspace.organizationId);
  query = requiredWhere(
    query,
    'userId',
    'in',
    userIds,
    'Form person authority',
  );
  const result = await projectFields(query, ['id', 'organizationId', 'userId', 'status'])
    .page(1)
    .limit(userIds.length + 1)
    .getList();
  if (result.hasMore || (result.items ?? []).length > userIds.length) {
    throw formError('Form person authority has conflicting organization memberships.', 409);
  }
  const deactivated = new Set(
    (result.items ?? [])
      .filter((member) => (
        member.organizationId === workspace.organizationId
        && member.status === 'deactivated'
      ))
      .map((member) => member.userId),
  );
  return new Set(userIds.filter((userId) => !deactivated.has(userId)));
}

async function personOptions(
  loaded: LoadedForm,
  after: string | undefined,
) {
  const workspace = await getExisting(
    loaded.db.table<Workspace>('workspaces'),
    loaded.link.workspaceId,
  );
  if (!workspace) throw formError('Workspace was not found.', 404);
  let query: TableQuery<WorkspaceMember> = loaded.db
    .table<WorkspaceMember>('workspace_members')
    .where('workspaceId', '==', loaded.link.workspaceId);
  query = projectFields(query, [
    'id', 'workspaceId', 'userId', 'displayName', 'email', 'avatar',
  ]);
  const page = await keysetWindow(query, after, 'Form person options');
  const userIds = Array.from(new Set(page.rows.map((member) => member.userId).filter(Boolean)));
  const activeUserIds = await activeOrganizationUserIds(loaded.db, workspace, userIds);
  const seen = new Set<string>();
  const options = page.rows.flatMap((member) => {
    if (
      member.workspaceId !== loaded.link.workspaceId
      || !member.userId
      || !activeUserIds.has(member.userId)
      || seen.has(member.userId)
    ) return [];
    seen.add(member.userId);
    return [{
      id: member.userId,
      name: member.displayName?.trim() || member.email?.trim() || member.userId,
      avatar: member.avatar ?? null,
    }];
  });
  return { options, hasMore: page.hasMore, after: page.after };
}

function relationTargetDatabaseId(property: DbProperty) {
  const configured = property.config?.relationDatabaseId;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : property.databaseId;
}

async function relationOptions(
  loaded: LoadedForm,
  property: DbProperty,
  auth: NonNullable<FunctionContext['auth']>,
  after: string | undefined,
) {
  const targetDatabaseId = relationTargetDatabaseId(property);
  const targetDatabase = await getExisting(loaded.db.table<Page>('pages'), targetDatabaseId);
  if (
    !targetDatabase
    || targetDatabase.workspaceId !== loaded.link.workspaceId
    || targetDatabase.kind !== 'database'
    || targetDatabase.inTrash === true
    || targetDatabase.deletionPendingAt
  ) {
    throw formError(`Relation target database was not found for property ${property.name}.`, 409);
  }
  await assertMinimumPageAccessRole(
    loaded.db,
    targetDatabase,
    auth.id,
    'view',
    auth.email,
  );
  let query: TableQuery<Page> = loaded.db.table<Page>('pages').where(
    'parentId',
    '==',
    targetDatabaseId,
  );
  query = requiredWhere(query, 'parentType', '==', 'database', 'Form relation options');
  query = requiredWhere(query, 'inTrash', '==', false, 'Form relation options');
  query = projectFields(query, [
    'id', 'workspaceId', 'parentId', 'parentType', 'kind', 'title', 'inTrash',
    'deletionPendingAt',
  ]);
  const page = await keysetWindow(query, after, 'Form relation options');
  for (const row of page.rows) {
    if (
      row.workspaceId !== loaded.link.workspaceId
      || row.parentId !== targetDatabaseId
      || row.parentType !== 'database'
      || row.kind !== 'page'
      || row.inTrash === true
    ) {
      throw formError('Form relation options returned an invalid target row.', 500);
    }
  }
  return {
    options: page.rows
      .filter((row) => !row.deletionPendingAt)
      .map((row) => ({ id: row.id, name: row.title?.trim() || 'Untitled' })),
    hasMore: page.hasMore,
    after: page.after,
  };
}

async function options(
  route: FormTokenRoute,
  auth: NonNullable<FunctionContext['auth']>,
  body: Record<string, unknown>,
) {
  const loaded = await loadForm(route, auth);
  if (loaded.link.audience !== 'workspace') {
    throw formError('Form options require a workspace-only form.', 403);
  }
  const propertyId = boundedString(body.propertyId, 'propertyId', 512);
  const question = loaded.form.questions.find((candidate) => (
    candidate.propertyId === propertyId && !candidate.hidden
  ));
  const property = loaded.properties.find((candidate) => candidate.id === propertyId);
  if (!question || !property || !referenceTypes.has(property.type)) {
    throw formError('Form question options were not found.', 404);
  }
  const after = optionalCursor(body.after);
  const result = property.type === 'person'
    ? await personOptions(loaded, after)
    : await relationOptions(loaded, property, auth, after);
  return { propertyId, type: property.type, ...result };
}

function stripUndefined(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function replayedSubmission(
  admin: AdminDbAccessor,
  loaded: LoadedForm,
  rowId: string,
  mutationId: string,
) {
  const row = await getExisting(loaded.db.table<Page>('pages'), rowId);
  if (!row) return null;
  if (
    row.workspaceId !== loaded.link.workspaceId
    || row.parentId !== loaded.database.id
    || row.parentType !== 'database'
    || row.kind !== 'page'
    || row.lastMutationId !== mutationId
  ) {
    throw formError('Form request id is already in use.', 409);
  }
  await ensurePageWorkspaceIndex(admin, row.id, row.workspaceId);
  return {
    rowId: row.id,
    replayed: true,
    confirmation: loaded.form.submit,
  };
}

function selectedIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item)
    : [];
}

async function validateSelectedPeople(
  loaded: LoadedForm,
  userIds: string[],
) {
  if (userIds.length === 0) return;
  const workspace = await getExisting(
    loaded.db.table<Workspace>('workspaces'),
    loaded.link.workspaceId,
  );
  if (!workspace) throw formError('Workspace was not found.', 404);
  let query: TableQuery<WorkspaceMember> = loaded.db
    .table<WorkspaceMember>('workspace_members')
    .where('workspaceId', '==', loaded.link.workspaceId);
  query = requiredWhere(query, 'userId', 'in', userIds, 'Form person authority');
  const result = await projectFields(query, ['id', 'workspaceId', 'userId'])
    .page(1)
    .limit(userIds.length + 1)
    .getList();
  if (result.hasMore || (result.items ?? []).length > userIds.length) {
    throw formError('Form person authority has conflicting workspace memberships.', 409);
  }
  const members = new Set(
    (result.items ?? [])
      .filter((member) => member.workspaceId === loaded.link.workspaceId)
      .map((member) => member.userId),
  );
  if (workspace.ownerId) members.add(workspace.ownerId);
  const activeOrganizationUsers = await activeOrganizationUserIds(loaded.db, workspace, userIds);
  const invalid = userIds.find((userId) => (
    !members.has(userId) || !activeOrganizationUsers.has(userId)
  ));
  if (invalid) {
    throw formError(`Selected person is not a current workspace member: ${invalid}.`, 400);
  }
}

function reciprocalPropertyId(property: DbProperty) {
  const configured = property.config?.relatedPropertyId;
  return typeof configured === 'string' && configured.trim() ? configured.trim() : null;
}

async function batchedRowsById<T extends { id: string }>(
  db: DbRef,
  table: string,
  ids: string[],
  label: string,
) {
  if (ids.length === 0) return new Map<string, T>();
  const wanted = new Set(ids);
  const result = await db.table<T>(table)
    .where('id', 'in', ids)
    .page(1)
    .limit(ids.length + 1)
    .getList();
  const rows = (result.items ?? []).filter((row) => wanted.has(row.id));
  if (result.hasMore || rows.length > ids.length || new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw formError(`${label} returned a conflicting row set.`, 409);
  }
  return new Map(rows.map((row) => [row.id, row]));
}

interface RelationSubmissionPlan {
  expectations: TransactOperation[];
  updates: TransactOperation[];
}

async function planRelationSubmission(
  loaded: LoadedForm,
  auth: NonNullable<FunctionContext['auth']>,
  properties: Record<string, unknown>,
  rowId: string,
  timestamp: string,
): Promise<RelationSubmissionPlan> {
  const relationSelections = loaded.properties.flatMap((property) => {
    if (property.type !== 'relation') return [];
    const ids = selectedIds(properties[property.id]);
    return ids.length > 0 ? [{ property, ids }] : [];
  });
  if (relationSelections.length === 0) return { expectations: [], updates: [] };

  const targetDatabaseIds = Array.from(new Set(
    relationSelections.map(({ property }) => relationTargetDatabaseId(property)),
  ));
  const targetRowIds = Array.from(new Set(relationSelections.flatMap(({ ids }) => ids)));
  const pageIdsToRead = Array.from(new Set([...targetDatabaseIds, ...targetRowIds]))
    .filter((id) => id !== loaded.database.id);
  const pagesById = await batchedRowsById<Page>(
    loaded.db,
    'pages',
    pageIdsToRead,
    'Form relation authority',
  );
  pagesById.set(loaded.database.id, loaded.database);

  const targetDatabases = targetDatabaseIds.map((databaseId) => {
    const database = pagesById.get(databaseId);
    if (
      !database
      || database.workspaceId !== loaded.link.workspaceId
      || database.kind !== 'database'
      || database.inTrash === true
      || database.deletionPendingAt
    ) {
      throw formError(`Relation target database was not found: ${databaseId}.`, 409);
    }
    return database;
  });
  await Promise.all(targetDatabases.map((database) => assertMinimumPageAccessRole(
    loaded.db,
    database,
    auth.id,
    'view',
    auth.email,
  )));

  for (const { property, ids } of relationSelections) {
    const targetDatabaseId = relationTargetDatabaseId(property);
    for (const id of ids) {
      const target = pagesById.get(id);
      if (
        !target
        || target.workspaceId !== loaded.link.workspaceId
        || target.parentId !== targetDatabaseId
        || target.parentType !== 'database'
        || target.kind !== 'page'
        || target.inTrash === true
        || target.deletionPendingAt
      ) {
        throw formError(`Invalid relation target for property ${property.name}: ${id}.`, 400);
      }
    }
  }

  const sourcePropertiesById = new Map(loaded.properties.map((property) => [property.id, property]));
  const reciprocalIds = Array.from(new Set(
    relationSelections.flatMap(({ property }) => reciprocalPropertyId(property) ?? []),
  ));
  const reciprocalIdsToRead = reciprocalIds.filter((id) => !sourcePropertiesById.has(id));
  const reciprocalPropertiesById = await batchedRowsById<DbProperty>(
    loaded.db,
    'db_properties',
    reciprocalIdsToRead,
    'Form reciprocal relation authority',
  );
  for (const [id, property] of sourcePropertiesById) reciprocalPropertiesById.set(id, property);

  const reciprocalProperties = new Map<string, DbProperty>();
  for (const { property } of relationSelections) {
    const reciprocalId = reciprocalPropertyId(property);
    if (!reciprocalId) continue;
    const reciprocal = reciprocalPropertiesById.get(reciprocalId);
    const targetDatabaseId = relationTargetDatabaseId(property);
    if (
      !reciprocal
      || reciprocal.type !== 'relation'
      || reciprocal.databaseId !== targetDatabaseId
      || relationTargetDatabaseId(reciprocal) !== loaded.database.id
    ) {
      throw formError(`Form relation property ${property.id} is no longer writable.`, 409);
    }
    reciprocalProperties.set(reciprocal.id, reciprocal);
  }

  let propertyBytes = 0;
  const targetUpdates = new Map<string, { row: Page; properties: Record<string, unknown> }>();
  for (const { property, ids } of relationSelections) {
    const reciprocalId = reciprocalPropertyId(property);
    if (!reciprocalId) continue;
    for (const id of ids) {
      const target = pagesById.get(id)!;
      let planned = targetUpdates.get(id);
      if (!planned) {
        const existingProperties = target.properties ?? {};
        propertyBytes += encoder.encode(JSON.stringify(existingProperties)).byteLength;
        if (propertyBytes > FORM_RELATION_TARGET_PROPERTIES_MAX_BYTES) {
          throw formError('Relation target properties exceed the 512 KiB form processing limit.', 413);
        }
        planned = { row: target, properties: { ...existingProperties } };
        targetUpdates.set(id, planned);
      }
      const current = selectedIds(planned.properties[reciprocalId]);
      if (!current.includes(rowId)) planned.properties[reciprocalId] = [...current, rowId];
    }
  }

  const expectations: TransactOperation[] = [];
  for (const database of targetDatabases) {
    if (database.id === loaded.database.id) continue;
    expectations.push({
      table: 'pages', op: 'expect', id: database.id,
      where: scalarExpectations(database as unknown as Record<string, unknown>, [
        'workspaceId', 'kind', 'inTrash', 'deletionPendingAt', 'isLocked', 'updatedAt',
      ]),
      exists: true,
    });
  }
  for (const reciprocal of reciprocalProperties.values()) {
    if (sourcePropertiesById.has(reciprocal.id)) continue;
    expectations.push({
      table: 'db_properties', op: 'expect', id: reciprocal.id,
      where: scalarExpectations(reciprocal as unknown as Record<string, unknown>, [
        'databaseId', 'type', 'updatedAt',
      ]),
      exists: true,
    });
  }
  const updates: TransactOperation[] = [];
  for (const { row, properties: nextProperties } of targetUpdates.values()) {
    expectations.push({
      table: 'pages', op: 'expect', id: row.id,
      where: scalarExpectations(row as unknown as Record<string, unknown>, [
        'workspaceId', 'parentId', 'parentType', 'kind', 'inTrash',
        // EdgeBase transact expectations are scalar-only on every provider.
        // updatedAt is the row revision fence for the reciprocal JSON update.
        'deletionPendingAt', 'updatedAt',
      ]),
      exists: true,
    });
    updates.push({
      table: 'pages', op: 'update', id: row.id,
      data: { properties: nextProperties, updatedAt: timestamp, lastEditedBy: auth.id },
    });
  }
  return { expectations, updates };
}

async function submit(
  admin: AdminDbAccessor,
  route: FormTokenRoute,
  auth: FunctionContext['auth'],
  body: Record<string, unknown>,
) {
  const revision = boundedString(body.revision, 'revision', 128);
  const requestId = boundedString(body.requestId, 'requestId', FORM_REQUEST_ID_MAX_BYTES);
  const loaded = await loadForm(route, auth, revision);
  if (loaded.database.isLocked) throw formError('Database is locked.', 423);
  const digest = await sha256Hex(`${loaded.link.id}\u0000${requestId}`);
  const rowId = `form-${digest}`;
  const mutationId = `form:${loaded.link.id}:${digest}`;
  const replay = await replayedSubmission(admin, loaded, rowId, mutationId);
  if (replay) return replay;

  const projection = normalizeFormSubmission(loaded.form, loaded.properties, body.answers);
  const timestamp = nowIso();
  const positionSeed = Number.parseInt(digest.slice(0, 6), 16) / 0xffffff;
  const actorId = loaded.link.audience === 'workspace' ? auth?.id : undefined;
  const row: Page = {
    id: rowId,
    workspaceId: loaded.database.workspaceId,
    parentId: loaded.database.id,
    parentType: 'database',
    kind: 'page',
    title: projection.title,
    iconType: 'none',
    notionIcon: null,
    notionCover: null,
    font: 'default',
    smallText: false,
    fullWidth: false,
    isLocked: false,
    isPublic: false,
    backlinksDisplay: 'default',
    pageCommentsDisplay: 'default',
    properties: projection.properties,
    isFavorite: false,
    inTrash: false,
    position: Date.now() + positionSeed,
    ...(actorId ? { createdBy: actorId, lastEditedBy: actorId } : {}),
    lastMutationId: mutationId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const personIds = Array.from(new Set(
    loaded.properties.flatMap((property) => (
      property.type === 'person' ? selectedIds(projection.properties[property.id]) : []
    )),
  ));
  const relationIds = loaded.properties.flatMap((property) => (
    property.type === 'relation' ? selectedIds(projection.properties[property.id]) : []
  ));
  if (personIds.length + relationIds.length > FORM_VIEW_MAX_REFERENCE_SELECTIONS) {
    throw formError(
      `A form response may contain at most ${FORM_VIEW_MAX_REFERENCE_SELECTIONS} person and relation selections.`,
      400,
    );
  }
  if ((personIds.length > 0 || relationIds.length > 0) && (!actorId || loaded.link.audience !== 'workspace')) {
    throw formError('Person and relation form answers require a workspace-only form.', 403);
  }
  const [, relationPlan] = await Promise.all([
    validateSelectedPeople(loaded, personIds),
    actorId
      ? planRelationSubmission(loaded, auth!, projection.properties, row.id, timestamp)
      : Promise.resolve({ expectations: [], updates: [] } as RelationSubmissionPlan),
  ]);
  const propertyIndexOperations = await Promise.all(
    loaded.properties.map(async (property): Promise<TransactOperation> => ({
      table: 'db_property_indexes',
      op: 'insert',
      data: stripUndefined(databasePropertyIndexRecord(
        row,
        property,
        `idx-${await sha256Hex(`${row.id}\u0000${property.id}`)}`,
      ) as Record<string, unknown>),
    })),
  );
  const operations: TransactOperation[] = [
    {
      table: 'form_links', op: 'expect', id: loaded.link.id,
      where: scalarExpectations(loaded.link as unknown as Record<string, unknown>, [
        'workspaceId', 'databaseId', 'viewId', 'token', 'audience', 'enabled', 'updatedAt',
      ]),
      exists: true,
    },
    {
      table: 'db_views', op: 'expect', id: loaded.view.id,
      where: scalarExpectations(loaded.view as unknown as Record<string, unknown>, [
        'databaseId', 'type', 'updatedAt',
      ]),
      exists: true,
    },
    {
      table: 'pages', op: 'expect', id: loaded.database.id,
      where: scalarExpectations(loaded.database as unknown as Record<string, unknown>, [
        'workspaceId', 'kind', 'inTrash', 'deletionPendingAt', 'isLocked', 'updatedAt',
      ]),
      exists: true,
    },
    ...loaded.properties.map((property): TransactOperation => ({
      table: 'db_properties', op: 'expect', id: property.id,
      where: scalarExpectations(property as unknown as Record<string, unknown>, [
        'databaseId', 'type', 'updatedAt',
      ]),
      exists: true,
    })),
    ...relationPlan.expectations,
    { table: 'pages', op: 'expect', id: row.id, exists: false },
    { table: 'pages', op: 'insert', data: row as unknown as Record<string, unknown> },
    ...propertyIndexOperations,
    ...relationPlan.updates,
  ];
  const augmentedOperationEstimate = operations.length
    + operations.filter((operation) => (
      operation.table === 'pages'
      && (operation.op === 'insert' || operation.op === 'update' || operation.op === 'delete')
    )).length;
  if (augmentedOperationEstimate > 500) {
    throw formError('Form response exceeds the bounded transaction operation limit.', 400);
  }
  try {
    await loaded.db.transact(operations);
  } catch (error) {
    if (isTransactionConflictError(error)) {
      const concurrentReplay = await replayedSubmission(admin, loaded, rowId, mutationId);
      if (concurrentReplay) return concurrentReplay;
    }
    throw error;
  }
  await ensurePageWorkspaceIndex(admin, row.id, row.workspaceId);
  return {
    rowId: row.id,
    replayed: false,
    confirmation: loaded.form.submit,
  };
}

export const POST = defineFunction(async (rawContext) => {
  const context = rawContext as FunctionContext;
  try {
    const body = await requestJson(context.request);
    const action = typeof body.action === 'string' ? body.action : '';
    if (action !== 'definition' && action !== 'submit' && !context.auth?.id) {
      throw formError('Authentication required.', 401);
    }
    if (action === 'configure') {
      return await configure(
        context.admin,
        body,
        context.auth!.id,
        context.auth?.email,
      );
    }
    if (action === 'definition' || action === 'options' || action === 'submit') {
      const token = boundedString(body.token, 'token', 512);
      if (publicRateLimited(context.request, action, token)) {
        throw formError('Too many form requests. Please retry later.', 429);
      }
      const route = await boundedDbFromFormToken(context.admin, token);
      if (action === 'definition') return await definition(route, context.auth);
      if (action === 'options') return await options(route, context.auth!, body);
      return await submit(context.admin, route, context.auth, body);
    }
    throw formError('Unknown form mutation action.', 400);
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 409, needles: ['definition changed', 'no longer writable', 'conflicting'] },
      { status: 404, needles: ['not found'] },
    ]);
    return jsonError(status, message);
  }
});
