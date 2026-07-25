import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import {
  assertMinimumPageAccessRole,
  canManagePageAccess,
  pageAccessRole,
  pageAccessRoleRanks,
} from '../lib/page-access';
import {
  getExisting,
  listAll,
  narrowWhere,
  nowIso,
  type TableQuery,
  type TransactOperation,
} from '../lib/table-utils';
import type {
  DbRef,
  FunctionContext,
  Page,
  PageOwner,
  WikiVerificationQueue,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';
import {
  boundedDbFromPageHint,
  MAX_RAW_TRANSACT_OPS,
  type AdminDbAccessor,
} from '../lib/workspace-db';
import { wikiExpiryQueueId, wikiOwnerRecordId } from '../lib/wiki';

const WIKI_SUBTREE_MAX_PAGES = 1_000;
const WIKI_PARENT_QUERY_CHUNK = 100;
const WIKI_LIST_DEFAULT = 50;
const WIKI_LIST_MAX = 50;
const WIKI_OWNER_MAX = 20;
const WIKI_REQUEST_MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function wikiError(message: string, status: number) {
  return Object.assign(new Error(message), { status, code: status });
}

function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request) return {};
  const text = await request.text();
  if (encoder.encode(text).byteLength > WIKI_REQUEST_MAX_BYTES) {
    throw wikiError('Wiki requests must be at most 64 KiB.', 413);
  }
  try {
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw wikiError('request body must be valid JSON.', 400);
  }
}

function requiredId(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw wikiError(`${label} is required.`, 400);
  }
  return value.trim();
}

function optionalCursor(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredId(value, 'after');
}

function listLimit(value: unknown) {
  if (value === undefined) return WIKI_LIST_DEFAULT;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > WIKI_LIST_MAX) {
    throw wikiError(`limit must be an integer from 1 to ${WIKI_LIST_MAX}.`, 400);
  }
  return Number(value);
}

async function pageAndWorkspace(db: DbRef, pageId: string) {
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (!page || page.inTrash) throw wikiError('Page was not found.', 404);
  const workspace = await getExisting(db.table<Workspace>('workspaces'), page.workspaceId);
  if (!workspace) throw wikiError('Workspace was not found.', 404);
  return { page, workspace };
}

async function assertCanManage(
  db: DbRef,
  page: Page,
  workspace: Workspace,
  actorId: string,
  actorEmail?: string | null,
) {
  if (!(await canManagePageAccess(db, page, workspace, actorId, actorEmail))) {
    throw wikiError('Page access required.', 403);
  }
}

async function collectWikiSubtree(db: DbRef, root: Page) {
  const pages = db.table<Page>('pages');
  const ordered: Page[] = [root];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (let offset = 0; offset < frontier.length; offset += WIKI_PARENT_QUERY_CHUNK) {
      const parentIds = frontier.slice(offset, offset + WIKI_PARENT_QUERY_CHUNK);
      const children = await listAll(
        narrowWhere(
          narrowWhere(pages.where('parentId', 'in', parentIds), 'parentType', 'page'),
          'inTrash',
          false,
        ),
        {
          maxItems: WIKI_SUBTREE_MAX_PAGES + 1,
          pageSize: 200,
          label: 'Wiki subtree child batch',
        },
      );
      for (const child of children.sort((left, right) => left.id.localeCompare(right.id))) {
        if (seen.has(child.id)) continue;
        if (child.isWiki && child.id !== root.id) {
          throw wikiError('A wiki cannot contain another wiki root.', 409);
        }
        seen.add(child.id);
        ordered.push(child);
        next.push(child.id);
        if (ordered.length > WIKI_SUBTREE_MAX_PAGES) {
          throw wikiError(`Wiki conversion is limited to ${WIKI_SUBTREE_MAX_PAGES} pages per request.`, 413);
        }
      }
    }
    frontier = next;
  }
  return ordered;
}

async function currentWorkspaceUserIds(
  central: DbRef,
  workspaceId: string,
  candidateIds: string[],
) {
  const unique = Array.from(new Set(candidateIds.filter(Boolean)));
  if (unique.length === 0) return new Set<string>();
  const workspaceQuery = central
    .table<WorkspaceMember>('workspace_members')
    .where('workspaceId', '==', workspaceId);
  if (typeof workspaceQuery.where !== 'function') {
    throw wikiError('Wiki owner membership requires chained database filters.', 500);
  }
  const members = await listAll(
    workspaceQuery.where('userId', 'in', unique),
    { maxItems: unique.length + 1, label: 'Wiki owner membership batch' },
  );
  return new Set(
    members
      .filter((member) => member.workspaceId === workspaceId && unique.includes(member.userId))
      .map((member) => member.userId),
  );
}

async function commitPageGroups(db: DbRef, groups: TransactOperation[][]) {
  let chunk: TransactOperation[] = [];
  for (const group of groups) {
    if (group.length > MAX_RAW_TRANSACT_OPS) throw wikiError('Wiki transaction group is too large.', 500);
    if (chunk.length + group.length > MAX_RAW_TRANSACT_OPS) {
      await db.transact(chunk);
      chunk = [];
    }
    chunk.push(...group);
  }
  if (chunk.length > 0) await db.transact(chunk);
}

async function convert(
  admin: AdminDbAccessor,
  db: DbRef,
  pageId: string,
  actorId: string,
  actorEmail?: string | null,
) {
  const { page: root, workspace } = await pageAndWorkspace(db, pageId);
  await assertCanManage(db, root, workspace, actorId, actorEmail);
  if (root.kind !== 'page' || root.parentType === 'database') {
    throw wikiError('Only regular pages can be converted into a wiki.', 409);
  }
  const subtree = await collectWikiSubtree(db, root);
  if (root.isWiki && root.wikiRootId === root.id) {
    const owners = await listAll(
      db.table<PageOwner>('page_owners').where('wikiRootId', '==', root.id),
      { maxItems: WIKI_SUBTREE_MAX_PAGES * WIKI_OWNER_MAX, label: 'Existing wiki owners' },
    );
    return { root, pages: subtree, owners };
  }

  const central = admin.db('app');
  const validCreators = await currentWorkspaceUserIds(
    central,
    root.workspaceId,
    [...subtree.map((item) => item.createdBy ?? ''), actorId],
  );
  const existingOwners = await listAll(
    db.table<PageOwner>('page_owners').where('wikiRootId', '==', root.id),
    { maxItems: WIKI_SUBTREE_MAX_PAGES * WIKI_OWNER_MAX, label: 'Wiki conversion existing owners' },
  );
  const existingOwnerIds = new Set(existingOwners.map((owner) => owner.id));
  const now = nowIso();

  const plan = async (target: Page, publishRoot: boolean) => {
    const userId = target.createdBy && validCreators.has(target.createdBy) ? target.createdBy : actorId;
    const id = await wikiOwnerRecordId(target.id, userId);
    const owner: PageOwner = {
      id,
      workspaceId: target.workspaceId,
      pageId: target.id,
      wikiRootId: root.id,
      userId,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    const where: Array<[string, '==', unknown]> = typeof target.updatedAt === 'string'
      ? [['updatedAt', '==', target.updatedAt]]
      : [];
    return {
      owner,
      operations: [
        { table: 'pages', op: 'expect' as const, id: target.id, where, exists: true },
        {
          table: 'pages', op: 'update' as const, id: target.id,
          data: {
            wikiRootId: root.id,
            ...(publishRoot ? { isWiki: true } : {}),
            updatedAt: now,
            lastEditedBy: actorId,
          },
        },
        ...(!existingOwnerIds.has(id)
          ? [{ table: 'page_owners', op: 'insert' as const, data: { ...owner } }]
          : []),
      ] satisfies TransactOperation[],
    };
  };

  const descendantPlans = await Promise.all(subtree.slice(1).map((target) => plan(target, false)));
  const rootPlan = await plan(root, true);
  await commitPageGroups(db, [
    ...descendantPlans.map((item) => item.operations),
    rootPlan.operations,
  ]);

  const updatedPages = await Promise.all(subtree.map((item) => getExisting(db.table<Page>('pages'), item.id)));
  const owners = [...descendantPlans.map((item) => item.owner), rootPlan.owner];
  const ownersByPageId = new Map(owners.map((owner) => [owner.pageId, owner]));
  return {
    root: updatedPages.find((item) => item?.id === root.id),
    pages: updatedPages.filter((item): item is Page => !!item),
    owners: subtree.map((item) => ownersByPageId.get(item.id)!).filter(Boolean),
  };
}

function requiredKeysetQuery<T>(query: TableQuery<T>, after: string | undefined, limit: number) {
  if (
    typeof query.orderBy !== 'function'
    || typeof query.includeTotal !== 'function'
    || typeof query.after !== 'function'
  ) {
    throw wikiError('Wiki collection views require bounded id-keyset queries.', 500);
  }
  const ordered = query.orderBy('id', 'asc');
  if (typeof ordered.includeTotal !== 'function') {
    throw wikiError('Wiki collection views require bounded id-keyset queries.', 500);
  }
  let window = ordered.includeTotal(false).limit(limit + 1);
  if (after) {
    if (typeof window.after !== 'function') {
      throw wikiError('Wiki collection views require bounded id-keyset queries.', 500);
    }
    window = window.after(after);
  }
  return window;
}

async function canViewPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
  return !!role && pageAccessRoleRanks[role] >= pageAccessRoleRanks.view;
}

async function listWiki(
  db: DbRef,
  root: Page,
  actorId: string,
  actorEmail: string | null | undefined,
  body: Record<string, unknown>,
) {
  if (!root.isWiki || root.wikiRootId !== root.id) throw wikiError('Wiki was not found.', 404);
  await assertMinimumPageAccessRole(db, root, actorId, 'view', actorEmail, { requireWorkspace: true });
  const view = body.view === 'owned' ? 'owned' : body.view === 'all' ? 'all' : null;
  if (!view) throw wikiError('view must be all or owned.', 400);
  const after = optionalCursor(body.after);
  const limit = listLimit(body.limit);
  let candidates: Page[] = [];

  if (view === 'all') {
    const result = await requiredKeysetQuery(
      narrowWhere(
        db.table<Page>('pages').where('wikiRootId', '==', root.id),
        'inTrash',
        false,
      ),
      after,
      limit,
    ).getList();
    candidates = result.items ?? [];
  } else {
    const owners = await requiredKeysetQuery(
      narrowWhere(
        db.table<PageOwner>('page_owners').where('wikiRootId', '==', root.id),
        'userId',
        actorId,
      ),
      after,
      limit,
    ).getList();
    const loaded = await Promise.all(
      (owners.items ?? []).map((owner) => getExisting(db.table<Page>('pages'), owner.pageId)),
    );
    candidates = loaded.filter((page): page is Page => !!page && !page.inTrash && page.wikiRootId === root.id);
  }

  const visible: Page[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    if (await canViewPage(db, candidate, actorId, actorEmail)) visible.push(candidate);
  }
  const visibleIds = visible.map((page) => page.id);
  const ownerRows = visibleIds.length > 0
    ? await listAll(
        db.table<PageOwner>('page_owners').where('pageId', 'in', visibleIds),
        {
          maxItems: visibleIds.length * WIKI_OWNER_MAX + 1,
          label: 'Visible wiki collection owners',
        },
      )
    : [];
  const pageOrder = new Map(visibleIds.map((id, index) => [id, index]));
  const owners = ownerRows
    .filter((owner) => pageOrder.has(owner.pageId) && owner.wikiRootId === root.id)
    .sort((left, right) =>
      (pageOrder.get(left.pageId) ?? Number.MAX_SAFE_INTEGER)
      - (pageOrder.get(right.pageId) ?? Number.MAX_SAFE_INTEGER)
      || left.userId.localeCompare(right.userId));
  const hasMore = candidates.length > limit;
  return {
    view,
    pages: visible,
    owners,
    nextCursor: hasMore ? candidates[limit - 1]?.id ?? null : null,
  };
}

async function pageOwners(db: DbRef, pageId: string) {
  return listAll(
    db.table<PageOwner>('page_owners').where('pageId', '==', pageId),
    { maxItems: WIKI_OWNER_MAX + 1, label: 'Wiki page owners' },
  );
}

async function visiblePageOwners(
  db: DbRef,
  page: Page,
  actorId: string,
  actorEmail?: string | null,
) {
  if (!page.wikiRootId) throw wikiError('Wiki page was not found.', 404);
  await assertMinimumPageAccessRole(
    db,
    page,
    actorId,
    'view',
    actorEmail,
    { requireWorkspace: true },
  );
  return { page, owners: await pageOwners(db, page.id) };
}

async function ownerOrManager(
  db: DbRef,
  page: Page,
  workspace: Workspace,
  actorId: string,
  actorEmail?: string | null,
) {
  const owners = await pageOwners(db, page.id);
  if (owners.some((owner) => owner.userId === actorId)) return owners;
  await assertCanManage(db, page, workspace, actorId, actorEmail);
  return owners;
}

async function ownerCandidates(
  db: DbRef,
  page: Page,
  workspace: Workspace,
  actorId: string,
  actorEmail: string | null | undefined,
  body: Record<string, unknown>,
) {
  if (!page.wikiRootId) throw wikiError('Wiki page was not found.', 404);
  await ownerOrManager(db, page, workspace, actorId, actorEmail);
  const after = optionalCursor(body.after);
  const limit = listLimit(body.limit);
  const result = await requiredKeysetQuery(
    db.table<WorkspaceMember>('workspace_members').where(
      'workspaceId',
      '==',
      page.workspaceId,
    ),
    after,
    limit,
  ).getList();
  const members = (result.items ?? [])
    .filter((member) => member.workspaceId === page.workspaceId)
    .slice(0, limit);
  return {
    members,
    nextCursor: (result.items ?? []).length > limit
      ? members.at(-1)?.id ?? null
      : null,
  };
}

function ownerIds(value: unknown) {
  if (!Array.isArray(value) || value.length > WIKI_OWNER_MAX) {
    throw wikiError(`ownerIds must contain at most ${WIKI_OWNER_MAX} users.`, 400);
  }
  return Array.from(new Set(value.map((item) => requiredId(item, 'ownerId'))));
}

async function setOwners(
  admin: AdminDbAccessor,
  db: DbRef,
  page: Page,
  workspace: Workspace,
  actorId: string,
  actorEmail: string | null | undefined,
  body: Record<string, unknown>,
) {
  if (!page.wikiRootId) throw wikiError('Wiki page was not found.', 404);
  const current = await ownerOrManager(db, page, workspace, actorId, actorEmail);
  const nextOwnerIds = ownerIds(body.ownerIds);
  if (nextOwnerIds.length === 0) {
    throw wikiError(
      page.verifiedAt ? 'A verified page must have at least one owner.' : 'A wiki page must have at least one owner.',
      409,
    );
  }
  const valid = await currentWorkspaceUserIds(admin.db('app'), page.workspaceId, nextOwnerIds);
  if (valid.size !== nextOwnerIds.length) throw wikiError('Every page owner must be a current workspace member.', 400);
  const currentByUser = new Map(current.map((owner) => [owner.userId, owner]));
  const now = nowIso();
  const inserts = await Promise.all(nextOwnerIds.filter((id) => !currentByUser.has(id)).map(async (userId) => ({
    table: 'page_owners',
    op: 'insert' as const,
    data: {
      id: await wikiOwnerRecordId(page.id, userId),
      workspaceId: page.workspaceId,
      pageId: page.id,
      wikiRootId: page.wikiRootId!,
      userId,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    },
  })));
  const operations: TransactOperation[] = [
    {
      table: 'pages', op: 'expect', id: page.id,
      where: typeof page.updatedAt === 'string' ? [['updatedAt', '==', page.updatedAt]] : [],
      exists: true,
    },
    ...current.filter((owner) => !nextOwnerIds.includes(owner.userId)).map((owner) => ({
      table: 'page_owners', op: 'delete' as const, id: owner.id,
    })),
    ...inserts,
    { table: 'pages', op: 'update', id: page.id, data: { updatedAt: now, lastEditedBy: actorId } },
  ];
  await db.transact(operations);
  return {
    page: await getExisting(db.table<Page>('pages'), page.id),
    owners: await pageOwners(db, page.id),
  };
}

function verificationExpiry(value: unknown, now: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw wikiError('expiresAt must be a future ISO timestamp or null.', 400);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now) {
    throw wikiError('expiresAt must be a future ISO timestamp or null.', 400);
  }
  return new Date(parsed).toISOString();
}

async function routeExpiry(
  central: DbRef,
  page: Page,
  expiresAt: string,
) {
  const id = await wikiExpiryQueueId(page.id);
  const queue = central.table<WikiVerificationQueue>('wiki_verification_queue');
  const existing = await getExisting(queue, id);
  const data: WikiVerificationQueue = {
    id,
    workspaceId: page.workspaceId,
    pageId: page.id,
    expiresAt,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: expiresAt,
    lastError: null,
    updatedAt: nowIso(),
  };
  if (existing) return queue.update(id, data);
  return queue.insert(data);
}

async function retireExpiryRoute(central: DbRef, pageId: string) {
  const id = await wikiExpiryQueueId(pageId);
  const queue = central.table<WikiVerificationQueue>('wiki_verification_queue');
  if (await getExisting(queue, id)) await queue.delete(id);
}

async function verify(
  admin: AdminDbAccessor,
  db: DbRef,
  page: Page,
  actorId: string,
  body: Record<string, unknown>,
) {
  if (!page.wikiRootId) throw wikiError('Wiki page was not found.', 404);
  const owners = await pageOwners(db, page.id);
  if (!owners.some((owner) => owner.userId === actorId)) throw wikiError('Page owner access required.', 403);
  const now = Date.now();
  const expiresAt = verificationExpiry(body.expiresAt, now);
  if (expiresAt) await routeExpiry(admin.db('app'), page, expiresAt);
  const verifiedAt = new Date(now).toISOString();
  await db.transact([
    {
      table: 'pages', op: 'expect', id: page.id,
      where: typeof page.updatedAt === 'string' ? [['updatedAt', '==', page.updatedAt]] : [],
      exists: true,
    },
    {
      table: 'pages', op: 'update', id: page.id,
      data: {
        verifiedAt,
        verifiedBy: actorId,
        verificationExpiresAt: expiresAt,
        updatedAt: verifiedAt,
        lastEditedBy: actorId,
      },
    },
  ]);
  if (!expiresAt) await retireExpiryRoute(admin.db('app'), page.id);
  return { page: await getExisting(db.table<Page>('pages'), page.id), owners };
}

async function unverify(
  admin: AdminDbAccessor,
  db: DbRef,
  page: Page,
  actorId: string,
) {
  if (!page.wikiRootId) throw wikiError('Wiki page was not found.', 404);
  const owners = await pageOwners(db, page.id);
  if (!owners.some((owner) => owner.userId === actorId)) {
    throw wikiError('Page owner access required.', 403);
  }
  if (page.verifiedAt || page.verifiedBy || page.verificationExpiresAt) {
    const now = nowIso();
    await db.transact([
      {
        table: 'pages', op: 'expect', id: page.id,
        where: typeof page.updatedAt === 'string' ? [['updatedAt', '==', page.updatedAt]] : [],
        exists: true,
      },
      {
        table: 'pages', op: 'update', id: page.id,
        data: {
          verifiedAt: null,
          verifiedBy: null,
          verificationExpiresAt: null,
          updatedAt: now,
          lastEditedBy: actorId,
        },
      },
    ]);
  }
  await retireExpiryRoute(admin.db('app'), page.id);
  return { page: await getExisting(db.table<Page>('pages'), page.id), owners };
}

async function retireWikiExpiryRoutes(central: DbRef, pageIds: string[]) {
  const queue = central.table<WikiVerificationQueue>('wiki_verification_queue');
  for (let offset = 0; offset < pageIds.length; offset += 50) {
    const ids = await Promise.all(
      pageIds.slice(offset, offset + 50).map((pageId) => wikiExpiryQueueId(pageId)),
    );
    const existing = await Promise.all(ids.map((id) => getExisting(queue, id)));
    const deletes = existing
      .filter((item): item is WikiVerificationQueue => !!item)
      .map((item) => ({ table: 'wiki_verification_queue', op: 'delete' as const, id: item.id }));
    if (deletes.length > 0) await central.transact(deletes);
  }
}

async function undoWiki(
  admin: AdminDbAccessor,
  db: DbRef,
  root: Page,
  workspace: Workspace,
  actorId: string,
  actorEmail?: string | null,
) {
  if (root.wikiRootId !== root.id) throw wikiError('Wiki was not found.', 404);
  await assertCanManage(db, root, workspace, actorId, actorEmail);

  if (root.isWiki) {
    const unpublishedAt = nowIso();
    await db.transact([
      {
        table: 'pages', op: 'expect', id: root.id,
        where: typeof root.updatedAt === 'string' ? [['updatedAt', '==', root.updatedAt]] : [],
        exists: true,
      },
      {
        table: 'pages', op: 'update', id: root.id,
        data: { isWiki: false, updatedAt: unpublishedAt, lastEditedBy: actorId },
      },
    ]);
  }

  const pages = await listAll(
    db.table<Page>('pages').where('wikiRootId', '==', root.id),
    { maxItems: WIKI_SUBTREE_MAX_PAGES + 1, label: 'Wiki undo membership' },
  );
  if (pages.length > WIKI_SUBTREE_MAX_PAGES) {
    throw wikiError(`Wiki undo is limited to ${WIKI_SUBTREE_MAX_PAGES} pages per request.`, 413);
  }
  const owners = await listAll(
    db.table<PageOwner>('page_owners').where('wikiRootId', '==', root.id),
    { maxItems: WIKI_SUBTREE_MAX_PAGES * WIKI_OWNER_MAX, label: 'Wiki undo owners' },
  );
  const ownersByPage = new Map<string, PageOwner[]>();
  for (const owner of owners) {
    const items = ownersByPage.get(owner.pageId) ?? [];
    items.push(owner);
    ownersByPage.set(owner.pageId, items);
  }
  const clearedAt = nowIso();
  await commitPageGroups(db, pages.map((page) => [
    {
      table: 'pages', op: 'expect' as const, id: page.id,
      where: typeof page.updatedAt === 'string' ? [['updatedAt', '==', page.updatedAt]] : [],
      exists: true,
    },
    ...(ownersByPage.get(page.id) ?? []).map((owner) => ({
      table: 'page_owners', op: 'delete' as const, id: owner.id,
    })),
    {
      table: 'pages', op: 'update' as const, id: page.id,
      data: {
        isWiki: false,
        wikiRootId: null,
        verifiedAt: null,
        verifiedBy: null,
        verificationExpiresAt: null,
        updatedAt: clearedAt,
        lastEditedBy: actorId,
      },
    },
  ]));
  await retireWikiExpiryRoutes(admin.db('app'), pages.map((page) => page.id));
  const updated = await Promise.all(
    pages.map((page) => getExisting(db.table<Page>('pages'), page.id)),
  );
  const present = updated.filter((page): page is Page => !!page);
  return {
    root: present.find((page) => page.id === root.id),
    pages: present,
  };
}

export const POST = defineFunction(async (rawContext) => {
  const context = rawContext as FunctionContext;
  try {
    if (!context.auth?.id) throw wikiError('Authentication required.', 401);
    const body = await requestJson(context.request);
    const action = typeof body.action === 'string' ? body.action : '';
    if (![
      'convert',
      'list',
      'owners',
      'ownerCandidates',
      'setOwners',
      'verify',
      'unverify',
      'undo',
    ].includes(action)) {
      throw wikiError('Unknown wiki mutation action.', 400);
    }
    const pageId = requiredId(body.pageId ?? body.id, 'pageId');
    const db = await boundedDbFromPageHint(context.admin, pageId);
    if (action === 'convert') {
      return await convert(context.admin, db, pageId, context.auth.id, context.auth.email);
    }
    const { page, workspace } = await pageAndWorkspace(db, pageId);
    if (action === 'undo') {
      return await undoWiki(
        context.admin,
        db,
        page,
        workspace,
        context.auth.id,
        context.auth.email,
      );
    }
    if (action === 'list') {
      return await listWiki(db, page, context.auth.id, context.auth.email, body);
    }
    if (action === 'owners') {
      return await visiblePageOwners(
        db,
        page,
        context.auth.id,
        context.auth.email,
      );
    }
    if (action === 'ownerCandidates') {
      return await ownerCandidates(
        db,
        page,
        workspace,
        context.auth.id,
        context.auth.email,
        body,
      );
    }
    if (action === 'setOwners') {
      return await setOwners(
        context.admin,
        db,
        page,
        workspace,
        context.auth.id,
        context.auth.email,
        body,
      );
    }
    if (action === 'unverify') {
      return await unverify(context.admin, db, page, context.auth.id);
    }
    return await verify(context.admin, db, page, context.auth.id, body);
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['access required'] },
      { status: 404, needles: ['not found'] },
      { status: 409, needles: ['cannot contain', 'must have at least one owner'] },
    ]);
    return jsonError(status, message);
  }
});
