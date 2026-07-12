import { defineFunction } from '@edge-base/shared';
import { boundedDb } from '../lib/workspace-db';
import { upsertDatabaseIndexesForRows } from '../lib/database-index';
import { listAll } from '../lib/table-utils';
import type {
  Block,
  DbRef,
  FunctionContext as BaseFunctionContext,
  Page,
  Workspace,
  WorkspaceMember,
} from '../lib/app-types';

// Imported-person mapping. Notion imports preserve people as synthetic
// references (`notion-user:<id>` objects carrying displayName/email); this
// function lets a workspace admin list those references and map them onto
// real accounts. Mapping rewrites person property values and person mention
// spans across the workspace and refreshes the affected row indexes.
// `hanji-user:` is reserved for a future native-import person carry.

const IMPORTED_PERSON_ID = /^(?:notion|hanji)-user:/;

interface FunctionContext extends BaseFunctionContext {
  env?: Record<string, unknown>;
}

interface ImportedPersonRef {
  sourceId: string;
  displayName: string | null;
  email: string | null;
  propertyValueCount: number;
  mentionCount: number;
}

function jsonError(status: number, message: string) {
  return Response.json({ ok: false, message }, { status });
}

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function importedRefFromValue(value: unknown): { sourceId: string; displayName: string | null; email: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id =
    typeof record.userId === 'string' && IMPORTED_PERSON_ID.test(record.userId)
      ? record.userId
      : typeof record.id === 'string' && IMPORTED_PERSON_ID.test(record.id)
        ? record.id
        : null;
  if (!id) return null;
  const notion = record.notion && typeof record.notion === 'object' ? (record.notion as Record<string, unknown>) : undefined;
  const notionPerson =
    notion?.person && typeof notion.person === 'object' ? (notion.person as Record<string, unknown>) : undefined;
  return {
    sourceId: id,
    displayName:
      (typeof record.displayName === 'string' && record.displayName.trim()) ||
      (typeof record.name === 'string' && record.name.trim()) ||
      (typeof notion?.name === 'string' && notion.name.trim()) ||
      null,
    email: normalizeEmail(record.email) ?? normalizeEmail(notionPerson?.email),
  };
}

/**
 * Rewrites one stored person property value. Mapped imported refs become
 * plain userId strings (the native person value shape); unmapped refs and
 * native values pass through untouched.
 */
export function remapPersonPropertyValue(
  value: unknown,
  mappings: ReadonlyMap<string, string>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = remapPersonPropertyValue(item, mappings);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  const ref = importedRefFromValue(value);
  if (ref) {
    const mapped = mappings.get(ref.sourceId);
    if (mapped) return { value: mapped, changed: true };
  }
  return { value, changed: false };
}

/**
 * Walks arbitrary block content JSON and rewrites person mention spans whose
 * userId is a mapped imported reference. The `notionUser` provenance object
 * is kept so the original source identity stays inspectable.
 */
export function remapPersonMentions(
  node: unknown,
  mappings: ReadonlyMap<string, string>,
  onHit?: () => void,
): { value: unknown; changed: boolean } {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const result = remapPersonMentions(item, mappings, onHit);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? next : node, changed };
  }
  if (!node || typeof node !== 'object') return { value: node, changed: false };
  const record = node as Record<string, unknown>;
  let changed = false;
  let next: Record<string, unknown> | null = null;
  if (
    record.mention === 'person' &&
    typeof record.userId === 'string' &&
    IMPORTED_PERSON_ID.test(record.userId)
  ) {
    const mapped = mappings.get(record.userId);
    if (mapped) {
      next = { ...record, userId: mapped };
      changed = true;
      onHit?.();
    }
  }
  const target = next ?? record;
  for (const [key, child] of Object.entries(target)) {
    // Provenance objects keep their original ids on purpose.
    if (key === 'notionUser' || key === 'notionMention' || key === 'notion') continue;
    const result = remapPersonMentions(child, mappings, onHit);
    if (result.changed) {
      if (!next) next = { ...record };
      next[key] = result.value;
      changed = true;
    }
  }
  return { value: next ?? record, changed };
}

function collectFromPropertyValue(value: unknown, hit: (ref: NonNullable<ReturnType<typeof importedRefFromValue>>) => void) {
  if (Array.isArray(value)) {
    for (const item of value) collectFromPropertyValue(item, hit);
    return;
  }
  const ref = importedRefFromValue(value);
  if (ref) hit(ref);
}

function collectFromContent(node: unknown, hit: (ref: { sourceId: string; displayName: string | null; email: string | null }) => void) {
  if (Array.isArray(node)) {
    for (const item of node) collectFromContent(item, hit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (
    record.mention === 'person' &&
    typeof record.userId === 'string' &&
    IMPORTED_PERSON_ID.test(record.userId)
  ) {
    const meta = importedRefFromValue(record.notionUser) ?? { sourceId: record.userId, displayName: null, email: null };
    hit({ ...meta, sourceId: record.userId });
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'notionUser' || key === 'notionMention' || key === 'notion') continue;
    collectFromContent(child, hit);
  }
}

async function requireWorkspaceAdmin(context: FunctionContext, workspaceId: string) {
  const actorId = context.auth?.id;
  if (!actorId) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  const appDb = context.admin.db('app');
  const workspace = await appDb.table<Workspace>('workspaces').getOne(workspaceId);
  if (!workspace) throw Object.assign(new Error('Workspace was not found.'), { status: 404 });
  if (workspace.ownerId === actorId) return { appDb, workspace, actorId };
  const members = await listAll(
    appDb.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId),
  );
  const actor = members.find((member) => member.userId === actorId);
  const role = actor?.role ?? null;
  if (role !== 'owner' && role !== 'admin') {
    throw Object.assign(new Error('Workspace admin access required.'), { status: 403 });
  }
  return { appDb, workspace, actorId };
}

async function workspaceMembers(appDb: FunctionContext['admin'] extends { db(ns: string): infer D } ? D : never, workspaceId: string) {
  return listAll(
    (appDb as { table<_T>(name: string): { where(f: string, o: string, v: unknown): unknown } }).table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspaceId) as never,
  ) as Promise<WorkspaceMember[]>;
}

async function scanWorkspace(contentDb: DbRef) {
  const pages = await listAll(contentDb.table<Page & { properties?: Record<string, unknown> }>('pages') as never) as Array<Page & { properties?: Record<string, unknown> }>;
  const blocks = await listAll(contentDb.table<Block>('blocks') as never) as Block[];
  return { pages, blocks };
}

async function listImportedPeople(context: FunctionContext, body: Record<string, unknown>) {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  if (!workspaceId) return jsonError(400, 'workspaceId is required.');
  const { appDb } = await requireWorkspaceAdmin(context, workspaceId);
  const contentDb = boundedDb(context.admin, workspaceId);
  const { pages, blocks } = await scanWorkspace(contentDb);

  const refs = new Map<string, ImportedPersonRef>();
  const upsert = (partial: { sourceId: string; displayName: string | null; email: string | null }, kind: 'value' | 'mention') => {
    const current = refs.get(partial.sourceId) ?? {
      sourceId: partial.sourceId,
      displayName: null,
      email: null,
      propertyValueCount: 0,
      mentionCount: 0,
    };
    current.displayName = current.displayName ?? partial.displayName;
    current.email = current.email ?? partial.email;
    if (kind === 'value') current.propertyValueCount += 1;
    else current.mentionCount += 1;
    refs.set(partial.sourceId, current);
  };

  for (const page of pages) {
    if (!page.properties) continue;
    for (const value of Object.values(page.properties)) {
      collectFromPropertyValue(value, (ref) => upsert(ref, 'value'));
    }
  }
  for (const block of blocks) {
    if (!block.content) continue;
    collectFromContent(block.content, (ref) => upsert(ref, 'mention'));
  }

  const members = await workspaceMembers(appDb as never, workspaceId);
  const membersByEmail = new Map<string, WorkspaceMember>();
  for (const member of members) {
    const email = normalizeEmail(member.email);
    if (email && member.userId && !membersByEmail.has(email)) membersByEmail.set(email, member);
  }

  const people = Array.from(refs.values())
    .map((ref) => {
      const suggested = ref.email ? membersByEmail.get(ref.email) : undefined;
      return {
        ...ref,
        suggestedUserId: suggested?.userId ?? null,
        suggestedDisplayName: suggested?.displayName ?? null,
      };
    })
    .sort((a, b) => (b.propertyValueCount + b.mentionCount) - (a.propertyValueCount + a.mentionCount));

  return {
    people,
    members: members
      .filter((member) => member.userId)
      .map((member) => ({
        userId: member.userId,
        displayName: member.displayName ?? null,
        email: normalizeEmail(member.email),
        role: member.role ?? null,
      })),
  };
}

async function applyPersonMappings(context: FunctionContext, body: Record<string, unknown>) {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  if (!workspaceId) return jsonError(400, 'workspaceId is required.');
  const rawMappings = body.mappings && typeof body.mappings === 'object' ? (body.mappings as Record<string, unknown>) : {};
  const { appDb, actorId } = await requireWorkspaceAdmin(context, workspaceId);

  const members = await workspaceMembers(appDb as never, workspaceId);
  const memberIds = new Set(members.map((member) => member.userId).filter(Boolean));
  const mappings = new Map<string, string>();
  for (const [sourceId, target] of Object.entries(rawMappings)) {
    if (!IMPORTED_PERSON_ID.test(sourceId)) return jsonError(400, `Invalid imported person id: ${sourceId}`);
    if (typeof target !== 'string' || !target.trim()) continue;
    const userId = target.trim();
    // Mapping targets must already belong to the workspace so imported people
    // cannot be pointed at arbitrary accounts.
    if (!memberIds.has(userId)) return jsonError(400, `Mapping target is not a workspace member: ${userId}`);
    mappings.set(sourceId, userId);
  }
  if (mappings.size === 0) return jsonError(400, 'No valid mappings were provided.');

  const contentDb = boundedDb(context.admin, workspaceId);
  const { pages, blocks } = await scanWorkspace(contentDb);
  const pagesTable = contentDb.table<Page & { properties?: Record<string, unknown> }>('pages');
  const blocksTable = contentDb.table<Block>('blocks');

  let changedPages = 0;
  let changedBlocks = 0;
  let mentionHits = 0;
  const changedRowPages: Array<Page & { properties?: Record<string, unknown> }> = [];

  for (const page of pages) {
    if (!page.properties) continue;
    let pageChanged = false;
    const nextProperties: Record<string, unknown> = { ...page.properties };
    for (const [propId, value] of Object.entries(page.properties)) {
      const result = remapPersonPropertyValue(value, mappings);
      if (result.changed) {
        nextProperties[propId] = result.value;
        pageChanged = true;
      }
    }
    if (!pageChanged) continue;
    const updated = await pagesTable.update(page.id, { properties: nextProperties } as never);
    changedPages += 1;
    const merged = { ...page, ...(updated as object), properties: nextProperties };
    if (merged.parentType === 'database' && merged.parentId) changedRowPages.push(merged);
  }

  for (const block of blocks) {
    if (!block.content) continue;
    const result = remapPersonMentions(block.content, mappings, () => {
      mentionHits += 1;
    });
    if (!result.changed) continue;
    await blocksTable.update(block.id, { content: result.value as Record<string, unknown> } as never);
    changedBlocks += 1;
  }

  if (changedRowPages.length) {
    await upsertDatabaseIndexesForRows(contentDb, changedRowPages as never);
  }

  console.log(
    `[person-mapping] workspace=${workspaceId} actor=${actorId} mapped=${mappings.size} pages=${changedPages} blocks=${changedBlocks}`,
  );
  return {
    ok: true,
    mappedPeople: mappings.size,
    changedPages,
    changedBlocks,
    changedMentions: mentionHits,
  };
}

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  try {
    if (!context.auth?.id) return jsonError(401, 'Authentication required.');
    const body = (await context.request?.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : 'list';
    switch (action) {
      case 'list': {
        const result = await listImportedPeople(context, body);
        return result instanceof Response ? result : Response.json({ ok: true, ...result });
      }
      case 'apply': {
        const result = await applyPersonMappings(context, body);
        return result instanceof Response ? result : Response.json(result);
      }
      default:
        return jsonError(400, 'Unknown person mapping action.');
    }
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    return jsonError(status, error instanceof Error ? error.message : 'Person mapping failed.');
  }
});
