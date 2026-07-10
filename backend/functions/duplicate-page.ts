import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { boundedDbFromPageHint, ensurePageWorkspaceIndex, type AdminDbAccessor } from '../lib/workspace-db';
import {
  pageAccessRole as sharedPageAccessRole,
  workspaceAccessRole as sharedWorkspaceAccessRole,
  pageAccessRoleRanks as roleRanks,
  type ShareRole,
} from '../lib/page-access';

import { bestEffort, listAll, nowIso, newId } from '../lib/table-utils';
import type {
  Block,
  DbProperty,
  DbRef,
  DbTemplate,
  DbView,
  FunctionContext,
  Page,
  PageParentType,
} from '../lib/app-types';

interface TemplateBlock {
  type: string;
  content?: Record<string, unknown>;
  children?: TemplateBlock[];
  [key: string]: unknown;
}

const parentTypes = new Set<PageParentType>(['workspace', 'page', 'database']);

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

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pageTitle(page: Page) {
  return page.title || 'Untitled';
}

function positionBetween(a?: number, b?: number): number {
  if (a == null && b == null) return 1;
  if (a == null) return b! / 2;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

function parseParentInput(parentId: unknown, parentType: unknown) {
  const cleanParentId = typeof parentId === 'string' && parentId.trim() ? parentId.trim() : null;
  const cleanParentType =
    typeof parentType === 'string' && parentTypes.has(parentType as PageParentType)
      ? (parentType as PageParentType)
      : cleanParentId
        ? 'page'
        : 'workspace';
  if (cleanParentType === 'workspace') {
    if (cleanParentId) throw new Error('workspace duplicates should omit parentId.');
    return { parentId: null, parentType: 'workspace' as const };
  }
  if (!cleanParentId) throw new Error(`${cleanParentType} duplicates require parentId.`);
  return { parentId: cleanParentId, parentType: cleanParentType };
}

function collectSubtree(pages: Page[], rootId: string) {
  const childrenByParent = new Map<string, Page[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = childrenByParent.get(page.parentId) ?? [];
    list.push(page);
    childrenByParent.set(page.parentId, list);
  }

  const out = new Set<string>();
  const collect = (pageId: string) => {
    if (out.has(pageId)) return;
    out.add(pageId);
    for (const child of childrenByParent.get(pageId) ?? []) collect(child.id);
  };
  collect(rootId);
  return out;
}

function siblingPages(pages: Page[], parentId: string | null, parentType: PageParentType, excludeId: string) {
  return pages
    .filter((page) => {
      if (page.inTrash || page.id === excludeId) return false;
      if (parentType === 'workspace') return page.parentId == null || page.parentType === 'workspace';
      return page.parentId === parentId && page.parentType === parentType;
    })
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function assertParentAllowsDuplicate(pagesById: Record<string, Page>, parentId?: string | null) {
  const parent = parentId ? pagesById[parentId] : undefined;
  if (parent?.isLocked) throw new Error(`Parent page "${pageTitle(parent)}" is locked.`);
}

function remapRecordKeys(record: Record<string, unknown> | undefined, ids: Map<string, string>) {
  if (!record) return record;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) next[ids.get(key) ?? key] = value;
  return next;
}

function remapFilterGroup(group: Record<string, unknown>, ids: Map<string, string>): Record<string, unknown> {
  return {
    ...group,
    filters: Array.isArray(group.filters)
      ? group.filters.map((filter) =>
          filter && typeof filter === 'object'
            ? {
                ...(filter as Record<string, unknown>),
                propertyId:
                  typeof (filter as Record<string, unknown>).propertyId === 'string'
                    ? ids.get((filter as Record<string, unknown>).propertyId as string) ??
                      (filter as Record<string, unknown>).propertyId
                    : (filter as Record<string, unknown>).propertyId,
              }
            : filter,
        )
      : group.filters,
    groups: Array.isArray(group.groups)
      ? group.groups.map((sub) =>
          sub && typeof sub === 'object' ? remapFilterGroup(sub as Record<string, unknown>, ids) : sub,
        )
      : group.groups,
  };
}

function remapViewConfig(config: Record<string, unknown> | undefined, ids: Map<string, string>) {
  const next = cloneJson(config ?? {});
  const mapList = (value: unknown) => (Array.isArray(value) ? value.map((id) => ids.get(String(id)) ?? id) : value);
  next.visibleProperties = mapList(next.visibleProperties);
  next.propertyOrder = mapList(next.propertyOrder);
  next.wrappedColumns = mapList(next.wrappedColumns);
  next.propertyWidths = remapRecordKeys(next.propertyWidths as Record<string, unknown> | undefined, ids);
  next.tableCalculations = remapRecordKeys(next.tableCalculations as Record<string, unknown> | undefined, ids);
  if (Array.isArray(next.filters)) {
    next.filters = next.filters.map((filter) =>
      filter && typeof filter === 'object'
        ? {
            ...(filter as Record<string, unknown>),
            propertyId:
              typeof (filter as Record<string, unknown>).propertyId === 'string'
                ? ids.get((filter as Record<string, unknown>).propertyId as string) ??
                  (filter as Record<string, unknown>).propertyId
                : (filter as Record<string, unknown>).propertyId,
          }
        : filter,
    );
  }
  if (next.filterGroup && typeof next.filterGroup === 'object') {
    next.filterGroup = remapFilterGroup(next.filterGroup as Record<string, unknown>, ids);
  }
  if (Array.isArray(next.sorts)) {
    next.sorts = next.sorts.map((sort) =>
      sort && typeof sort === 'object'
        ? {
            ...(sort as Record<string, unknown>),
            propertyId:
              typeof (sort as Record<string, unknown>).propertyId === 'string'
                ? ids.get((sort as Record<string, unknown>).propertyId as string) ??
                  (sort as Record<string, unknown>).propertyId
                : (sort as Record<string, unknown>).propertyId,
          }
        : sort,
    );
  }
  for (const key of [
    'groupBy',
    'calendarBy',
    'timelineBy',
    'timelineEndBy',
    'dependencyProperty',
    'coverProperty',
    'subGroupBy',
  ]) {
    if (typeof next[key] === 'string') next[key] = ids.get(next[key] as string) ?? next[key];
  }
  return next;
}

function remapPageMentions(spans: unknown, pageMap: Map<string, string>) {
  return Array.isArray(spans)
    ? spans.map((span) =>
        span && typeof span === 'object' && typeof (span as Record<string, unknown>).pageId === 'string'
          ? {
              ...(span as Record<string, unknown>),
              pageId: pageMap.get((span as Record<string, unknown>).pageId as string) ??
                (span as Record<string, unknown>).pageId,
            }
          : span,
      )
    : spans;
}

function remapTemplateBlocks(
  blocks: unknown,
  pageMap: Map<string, string>,
  blockMap = new Map<string, string>(),
): unknown {
  return Array.isArray(blocks)
    ? blocks.map((block) =>
        block && typeof block === 'object'
          ? {
              ...cloneJson(block as Record<string, unknown>),
              content: remapBlockContent((block as Record<string, unknown>).content, pageMap, blockMap),
              children: remapTemplateBlocks((block as Record<string, unknown>).children, pageMap, blockMap),
            }
          : block,
      )
    : blocks;
}

function remapBlockContent(content: unknown, pageMap: Map<string, string>, blockMap = new Map<string, string>()) {
  const next = cloneJson(content) as Record<string, unknown> | undefined;
  if (!next) return next;
  if (typeof next.childPageId === 'string') next.childPageId = pageMap.get(next.childPageId) ?? next.childPageId;
  if (typeof next.syncedBlockId === 'string') {
    const nextBlockId = blockMap.get(next.syncedBlockId);
    if (nextBlockId) {
      next.syncedBlockId = nextBlockId;
      if (typeof next.syncedPageId === 'string') {
        next.syncedPageId = pageMap.get(next.syncedPageId) ?? next.syncedPageId;
      }
    }
  } else if (typeof next.syncedPageId === 'string') {
    next.syncedPageId = pageMap.get(next.syncedPageId) ?? next.syncedPageId;
  }
  next.rich = remapPageMentions(next.rich, pageMap);
  next.caption = remapPageMentions(next.caption, pageMap);
  next.buttonTemplate = remapTemplateBlocks(next.buttonTemplate, pageMap, blockMap);
  return next;
}

function remapRelationValue(value: unknown, pageMap: Map<string, string>) {
  if (Array.isArray(value)) return value.map((id) => pageMap.get(String(id)) ?? id);
  if (value == null || value === '') return value;
  return pageMap.get(String(value)) ?? value;
}

function remapProperties(
  properties: Record<string, unknown> | undefined,
  propMap: Map<string, string> | undefined,
  pageMap: Map<string, string>,
  propsById = new Map<string, DbProperty>(),
) {
  const cloned = cloneJson(properties ?? {});
  if (!propMap) return cloned;
  const remapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cloned)) {
    const prop = propsById.get(key);
    remapped[propMap.get(key) ?? key] = prop?.type === 'relation' ? remapRelationValue(value, pageMap) : value;
  }
  return remapped;
}

function remapPropertyConfig(
  config: Record<string, unknown> | undefined,
  propMap: Map<string, string>,
  pageMap: Map<string, string>,
  sourceDbId: string,
  targetDbId: string,
) {
  if (!config) return config;
  const next = cloneJson(config);
  if (next.relationDatabaseId === sourceDbId) next.relationDatabaseId = targetDbId;
  else if (typeof next.relationDatabaseId === 'string') {
    next.relationDatabaseId = pageMap.get(next.relationDatabaseId) ?? next.relationDatabaseId;
  }
  for (const key of ['rollupRelationPropertyId', 'rollupTargetPropertyId', 'rollupVia']) {
    if (typeof next[key] === 'string') next[key] = propMap.get(next[key] as string) ?? next[key];
  }
  return next;
}

// Role resolution is canonical in lib/page-access; these wrappers only pin
// this function's "missing workspace is an error" contract.
async function workspaceRole(db: DbRef, workspaceId: string, actorId: string): Promise<ShareRole | undefined> {
  return sharedWorkspaceAccessRole(db, workspaceId, actorId, { requireWorkspace: true });
}

async function assertWorkspaceEdit(db: DbRef, workspaceId: string, actorId: string) {
  const role = await workspaceRole(db, workspaceId, actorId);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Workspace access required.');
}

async function pageRole(
  db: DbRef,
  page: Page,
  actorId: string,
  actorEmail?: string | null,
): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail, { requireWorkspace: true });
}

async function assertCanEditPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Page access required.');
}

async function duplicatePage(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const pagesTable = db.table<Page>('pages');
  const blocksTable = db.table<Block>('blocks');
  const propertiesTable = db.table<DbProperty>('db_properties');
  const viewsTable = db.table<DbView>('db_views');
  const templatesTable = db.table<DbTemplate>('db_templates');

  const pageId = typeof body.pageId === 'string' ? body.pageId : typeof body.id === 'string' ? body.id : '';
  if (!pageId) throw new Error('pageId is required.');
  const source = await pagesTable.getOne(pageId);
  if (!source) throw new Error('Page was not found.');
  if (source.inTrash) throw new Error('Page is in trash.');
  // Any authenticated caller can name an arbitrary pageId here, so gate on the
  // source: Notion lets you duplicate a page you can edit. Requiring edit (not
  // just view) also means an in-place copy needs no separate destination check.
  // Without this, duplicate was an arbitrary-page read + cross-workspace write.
  await assertCanEditPage(db, source, actorId, actorEmail);

  const workspacePages = await listAll(pagesTable.where('workspaceId', '==', source.workspaceId));
  const pagesById = Object.fromEntries(workspacePages.map((page) => [page.id, page]));
  assertParentAllowsDuplicate(pagesById, source.parentId);

  const destination =
    'parentId' in body || 'parentType' in body
      ? parseParentInput(body.parentId, body.parentType)
      : { parentId: source.parentId ?? null, parentType: source.parentType ?? 'workspace' };
  assertParentAllowsDuplicate(pagesById, destination.parentId);

  const sameDestination =
    (source.parentId ?? null) === destination.parentId &&
    (source.parentType ?? 'workspace') === destination.parentType;

  if (destination.parentType !== 'workspace') {
    const parent = pagesById[destination.parentId as string];
    if (!parent || parent.inTrash) throw new Error('Destination parent was not found.');
    if (destination.parentType === 'database' && source.kind !== 'page') {
      throw new Error('Only regular pages can be duplicated into a database.');
    }
    if (destination.parentType === 'database' && parent.kind !== 'database') {
      throw new Error('Destination parent is not a database.');
    }
    if (destination.parentType === 'page' && parent.kind !== 'page') {
      throw new Error('Destination parent is not a page.');
    }
  }

  // Editing the source authorizes an in-place copy. Relocating the copy to a
  // different container additionally requires edit access at that destination.
  if (!sameDestination) {
    if (destination.parentType === 'workspace') {
      await assertWorkspaceEdit(db, source.workspaceId, actorId);
    } else {
      await assertCanEditPage(db, pagesById[destination.parentId as string], actorId, actorEmail);
    }
  }

  const sourceIds = collectSubtree(workspacePages, pageId);
  if (destination.parentId && sourceIds.has(destination.parentId)) {
    throw new Error('Cannot duplicate a page inside itself or one of its descendants.');
  }
  const sourceTreePages = workspacePages.filter((page) => sourceIds.has(page.id) && !page.inTrash);
  const pageMap = new Map(sourceTreePages.map((page) => [page.id, newId()]));
  const siblings = siblingPages(workspacePages, destination.parentId, destination.parentType, pageId);
  const nextSibling = sameDestination
    ? siblings.find((page) => (page.position ?? 0) > (source.position ?? 0))
    : undefined;
  const rootPosition = sameDestination
    ? positionBetween(source.position, nextSibling?.position)
    : positionBetween(siblings[siblings.length - 1]?.position, undefined);

  const blocksByPage = new Map<string, Block[]>();
  const globalBlockMap = new Map<string, string>();
  for (const page of sourceTreePages) {
    const blocks = await listAll(blocksTable.where('pageId', '==', page.id));
    blocksByPage.set(page.id, blocks.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    for (const block of blocks) globalBlockMap.set(block.id, newId());
  }

  const propsByDb = new Map<string, DbProperty[]>();
  const propsByIdByDb = new Map<string, Map<string, DbProperty>>();
  const propMapsByDb = new Map<string, Map<string, string>>();
  const viewsByDb = new Map<string, DbView[]>();
  const templatesByDb = new Map<string, DbTemplate[]>();
  for (const page of sourceTreePages.filter((item) => item.kind === 'database')) {
    const [props, views, templates] = await Promise.all([
      listAll(propertiesTable.where('databaseId', '==', page.id)),
      listAll(viewsTable.where('databaseId', '==', page.id)),
      listAll(templatesTable.where('databaseId', '==', page.id)),
    ]);
    propsByDb.set(page.id, props.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    propsByIdByDb.set(page.id, new Map(props.map((prop) => [prop.id, prop])));
    propMapsByDb.set(page.id, new Map(props.map((prop) => [prop.id, newId()])));
    viewsByDb.set(page.id, views.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    templatesByDb.set(page.id, templates.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
  }

  const created = {
    pages: [] as Page[],
    blocks: [] as Block[],
    properties: [] as DbProperty[],
    views: [] as DbView[],
    templates: [] as DbTemplate[],
  };

  async function duplicateNode(
    sourceId: string,
    newParentId: string | null,
    newParentType: PageParentType,
    position: number,
    titleOverride?: string,
  ): Promise<Page | null> {
    const cur = pagesById[sourceId];
    if (!cur || cur.inTrash) return null;
    const now = nowIso();
    const newPageId = pageMap.get(sourceId) ?? newId();
    pageMap.set(sourceId, newPageId);
    const rowPropMap = cur.parentType === 'database' && cur.parentId ? propMapsByDb.get(cur.parentId) : undefined;
    const rowPropsById = cur.parentType === 'database' && cur.parentId ? propsByIdByDb.get(cur.parentId) : undefined;
    const page = await pagesTable.insert({
      id: newPageId,
      workspaceId: cur.workspaceId,
      parentId: newParentId,
      parentType: newParentType,
      kind: cur.kind,
      title: titleOverride ?? cur.title,
      icon: cur.icon,
      iconType: cur.iconType ?? 'none',
      cover: cur.cover,
      coverPosition: cur.coverPosition,
      font: cur.font ?? 'default',
      smallText: !!cur.smallText,
      fullWidth: !!cur.fullWidth,
      isLocked: false,
      isPublic: false,
      backlinksDisplay: cur.backlinksDisplay ?? 'default',
      pageCommentsDisplay: cur.pageCommentsDisplay ?? 'default',
      properties: remapProperties(cur.properties, rowPropMap, pageMap, rowPropsById),
      isFavorite: false,
      inTrash: false,
      position,
      createdBy: actorId,
      lastEditedBy: actorId,
      createdAt: now,
      updatedAt: now,
    });
    // Copies are page rows; index them synchronously for immediate follow-ups.
    await ensurePageWorkspaceIndex(admin, page.id, page.workspaceId);
    created.pages.push(page);

    for (const block of blocksByPage.get(cur.id) ?? []) {
      const blockId = globalBlockMap.get(block.id) ?? newId();
      const newBlock = await blocksTable.insert({
        id: blockId,
        pageId: page.id,
        parentId: block.parentId ? globalBlockMap.get(block.parentId) ?? null : null,
        type: block.type,
        content: remapBlockContent(block.content, pageMap, globalBlockMap),
        plainText: block.plainText,
        position: block.position,
        createdBy: actorId,
      });
      created.blocks.push(newBlock);
    }

    if (cur.kind === 'database') {
      const props = propsByDb.get(cur.id) ?? [];
      const propMap = propMapsByDb.get(cur.id) ?? new Map<string, string>();
      const propsById = propsByIdByDb.get(cur.id) ?? new Map<string, DbProperty>();
      for (const prop of props) {
        created.properties.push(
          await propertiesTable.insert({
            id: propMap.get(prop.id),
            databaseId: page.id,
            name: prop.name,
            description: prop.description,
            type: prop.type,
            config: remapPropertyConfig(prop.config, propMap, pageMap, cur.id, page.id),
            position: prop.position,
          }),
        );
      }
      for (const view of viewsByDb.get(cur.id) ?? []) {
        created.views.push(
          await viewsTable.insert({
            id: newId(),
            databaseId: page.id,
            name: view.name,
            type: view.type,
            config: remapViewConfig(view.config, propMap),
            position: view.position,
          }),
        );
      }
      for (const template of templatesByDb.get(cur.id) ?? []) {
        created.templates.push(
          await templatesTable.insert({
            id: newId(),
            databaseId: page.id,
            name: template.name,
            icon: template.icon,
            title: template.title ?? '',
            properties: remapProperties(template.properties, propMap, pageMap, propsById),
            blocks: remapTemplateBlocks(template.blocks, pageMap) as TemplateBlock[],
            isDefault: !!template.isDefault,
            position: template.position,
          }),
        );
      }
    }

    const rows = sourceTreePages
      .filter((item) => item.parentType === 'database' && item.parentId === cur.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const row of rows) await duplicateNode(row.id, page.id, 'database', row.position);

    const children = sourceTreePages
      .filter((item) => item.parentType === 'page' && item.parentId === cur.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const child of children) await duplicateNode(child.id, page.id, 'page', child.position);

    return page;
  }

  try {
    const page = await duplicateNode(
      pageId,
      destination.parentId,
      destination.parentType,
      rootPosition,
      typeof body.title === 'string' ? body.title : `${pageTitle(source)} copy`,
    );
    return {
      page,
      source,
      parentId: destination.parentId,
      parentType: destination.parentType,
      ...created,
      counts: {
        pages: created.pages.length,
        blocks: created.blocks.length,
        properties: created.properties.length,
        views: created.views.length,
        templates: created.templates.length,
      },
    };
  } catch (error) {
    await Promise.all(created.templates.map((item) => bestEffort('duplicate-page templatesTable.delete', templatesTable.delete(item.id))));
    await Promise.all(created.views.map((item) => bestEffort('duplicate-page viewsTable.delete', viewsTable.delete(item.id))));
    await Promise.all(created.properties.map((item) => bestEffort('duplicate-page propertiesTable.delete', propertiesTable.delete(item.id))));
    await Promise.all(created.blocks.map((item) => bestEffort('duplicate-page blocksTable.delete', blocksTable.delete(item.id))));
    for (const page of created.pages.slice().reverse()) {
      await bestEffort('duplicate-page pagesTable.delete', pagesTable.delete(page.id));
    }
    throw error;
  }
}

export const POST = defineFunction(async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    switch (action) {
      case 'duplicate':
        return await duplicatePage(
          await boundedDbFromPageHint(admin, body.pageId, body.id),
          admin,
          body,
          auth.id,
          auth.email ?? null,
        );
      default:
        return jsonError(400, 'Unknown duplicate page action.');
    }
  } catch (error) {
    // STANDARD rules map "access required" -> 403, "locked" -> 423,
    // "not found" -> 404 (everything else 400).
    const { status, message } = errorStatus(error);
    return jsonError(status, message);
  }
});
