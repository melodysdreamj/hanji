import { defineFunction } from '@edge-base/shared';
import { errorStatus } from '../lib/error-status';
import { boundedDbFromPageHint } from '../lib/workspace-db';
import * as Y from 'yjs';
import { pageAccessRole as sharedPageAccessRole } from '../lib/page-access';

import {
  listAll,
  listAllTruncated,
  requireString,
  getExisting,
  nowIso,
  newId,
  type TableQuery,
  type TransactDb,
} from '../lib/table-utils';
import type { ShareRole } from '../lib/page-access';
import { pageAccessRoleRanks as roleRanks } from '../lib/page-access';

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: 'workspace' | 'page' | 'database';
  inTrash?: boolean;
  isLocked?: boolean;
  createdBy?: string;
}

interface Block {
  id: string;
  pageId: string;
  parentId?: string | null;
  type?: string;
  content?: Record<string, unknown>;
  plainText?: string;
  position?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface CollaborationOperation {
  id: string;
  workspaceId: string;
  pageId: string;
  blockId?: string | null;
  clientId: string;
  kind: string;
  operation?: Record<string, unknown>;
  beforeText?: string;
  afterText?: string;
  revision?: number;
  actorId?: string;
  occurredAt: string;
  createdAt?: string;
}

interface CollaborationDocument {
  id: string;
  workspaceId: string;
  pageId: string;
  blockId?: string | null;
  documentId: string;
  engine: string;
  schemaVersion?: number;
  stateBase64: string;
  stateVectorBase64?: string;
  updateCount?: number;
  lastOperationId?: string | null;
  lastOperationRevision?: number;
  lastOperationOccurredAt?: string | null;
  checkpointedAt?: string;
  updatedAt: string;
  createdAt?: string;
}

interface RebuiltCrdtDocument {
  workspaceId: string;
  pageId: string;
  blockId: string | null;
  documentId: string;
  engine: 'yjs';
  schemaVersion: number;
  stateBase64: string;
  stateVectorBase64: string;
  updateCount: number;
  lastOperationId: string | null;
  lastOperationRevision: number;
  lastOperationOccurredAt: string | null;
  checkpointedAt: string;
  updatedAt: string;
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

interface FunctionContext {
  auth: { id: string; email?: string } | null;
  request?: Request;
  admin: {
    db(namespace: string): DbRef;
  };
}

const MAX_CRDT_UPDATE_BASE64_CHARS = 750_000;
const MAX_CRDT_DOCUMENT_ID_CHARS = 240;
const MAX_STRUCTURE_BLOCKS = 200;
const blockStructureActions = new Set(['create', 'move', 'indent', 'outdent', 'delete', 'restore']);
// ── operation retention ──────────────────────────────────────────────────────
// The persisted collaboration_documents checkpoint cumulatively merges every
// crdt_update, so ops at-or-before its lastOperation cursor are superseded and
// only serve repair/catch-up. Without retention a busy page accumulates ops
// until the listAll ceiling 413s and bricks collaboration. Each successful
// checkpoint keeps a bounded repair tail per page and deletes older superseded
// ops (rebuilds stay lossless: they seed from the persisted checkpoint state).
const CRDT_SUPERSEDED_OP_RETAIN_PER_PAGE = 500;
// At most this many rows are pruned per checkpoint, keeping the write amortized.
const CRDT_OP_PRUNE_BATCH = 200;
// Read bound for per-page op scans (list/repair/prune). Retention keeps real
// pages far below this; a legacy over-cap page degrades to the newest-known
// window instead of a hard 413.
const COLLAB_OP_SCAN_MAX_ITEMS = 5_000;

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

function optionalString(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function safeNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cleanStringList(value: unknown, max = 500) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function newServerYDoc() {
  const doc = new Y.Doc();
  (doc as unknown as { clientID: number }).clientID = 0x1ead0c;
  return doc;
}

function operationCursor(operation: CollaborationOperation) {
  return {
    revision: operation.revision ?? 0,
    occurredAt: operation.occurredAt ?? '',
    id: operation.id,
  };
}

function isAfterCursor(
  operation: CollaborationOperation,
  cursor: { revision: number; occurredAt: string; id: string },
) {
  const current = operationCursor(operation);
  if (current.revision !== cursor.revision) return current.revision > cursor.revision;
  if (current.occurredAt !== cursor.occurredAt) return current.occurredAt > cursor.occurredAt;
  return current.id > cursor.id;
}

// Role resolution is canonical in lib/page-access.
async function pageRole(db: DbRef, page: Page, actorId: string, actorEmail?: string | null): Promise<ShareRole | undefined> {
  return sharedPageAccessRole(db, page, actorId, undefined, actorEmail);
}

async function assertCanEditPage(db: DbRef, page: Page, actorId: string, actorEmail?: string | null) {
  const role = await pageRole(db, page, actorId, actorEmail);
  if (role && roleRanks[role] >= roleRanks.edit) return role;
  throw new Error('Page access required.');
}

async function getWritablePage(db: DbRef, pageId: string, actorId: string, actorEmail?: string | null): Promise<Page> {
  const page = await getExisting(db.table<Page>('pages'), pageId);
  if (!page) throw new Error('Page was not found.');
  if (page.inTrash) throw new Error('Page is in trash.');
  if (page.isLocked) throw new Error('Page is locked.');
  await assertCanEditPage(db, page, actorId, actorEmail);
  return page;
}

async function assertBlockOnPage(db: DbRef, blockId: string | null, pageId: string) {
  if (!blockId) return;
  const block = await getExisting(db.table<Block>('blocks'), blockId);
  if (!block || block.pageId !== pageId) throw new Error('Block is outside the page.');
}

function cleanOperation(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function normalizedBase64(value: unknown, name: string, required: boolean) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${name} is required for CRDT updates.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${name} must be a base64 string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) throw new Error(`${name} is required for CRDT updates.`);
    return undefined;
  }
  if (trimmed.length > MAX_CRDT_UPDATE_BASE64_CHARS) {
    throw new Error(`${name} is too large.`);
  }
  if (trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
    throw new Error(`${name} must be valid base64.`);
  }
  return trimmed;
}

function cleanCrdtUpdateOperation(
  value: unknown,
  pageId: string,
  blockId: string | null,
  clientId: string,
) {
  const record = cleanOperation(value);
  if (!record) throw new Error('operation is required for CRDT updates.');
  const engine = typeof record.engine === 'string' ? record.engine.trim().toLowerCase() : '';
  if (engine !== 'yjs') throw new Error('CRDT update engine must be "yjs".');
  const documentId =
    typeof record.documentId === 'string' && record.documentId.trim()
      ? record.documentId.trim().slice(0, MAX_CRDT_DOCUMENT_ID_CHARS)
      : blockId
        ? `block:${blockId}`
        : `page:${pageId}`;
  const updateBase64 = normalizedBase64(record.updateBase64, 'updateBase64', true);
  const stateVectorBase64 = normalizedBase64(record.stateVectorBase64, 'stateVectorBase64', false);
  return {
    engine: 'yjs',
    schemaVersion:
      typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
        ? Math.max(1, Math.floor(record.schemaVersion))
        : 1,
    documentId,
    updateBase64,
    ...(stateVectorBase64 ? { stateVectorBase64 } : {}),
    originClientId:
      typeof record.originClientId === 'string' && record.originClientId.trim()
        ? record.originClientId.trim().slice(0, 160)
        : clientId,
  };
}

function cleanStructureBlock(value: unknown, pageId: string): Block | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return undefined;
  const blockPageId =
    typeof record.pageId === 'string' && record.pageId.trim()
      ? record.pageId.trim()
      : pageId;
  if (blockPageId !== pageId) throw new Error('Block structure operation cannot cross pages.');
  const position = safeNumber(record.position, NaN);
  if (!Number.isFinite(position)) throw new Error('Block structure operation block position is required.');
  const parentId =
    record.parentId === null || record.parentId === undefined
      ? null
      : typeof record.parentId === 'string'
        ? record.parentId
        : undefined;
  if (parentId === undefined) throw new Error('Block structure operation parentId must be a string or null.');

  return {
    id: record.id.trim(),
    pageId: blockPageId,
    parentId,
    type: typeof record.type === 'string' && record.type.trim() ? record.type.trim().slice(0, 120) : undefined,
    content:
      record.content && typeof record.content === 'object' && !Array.isArray(record.content)
        ? JSON.parse(JSON.stringify(record.content))
        : undefined,
    plainText: typeof record.plainText === 'string' ? record.plainText.slice(0, 100_000) : undefined,
    position,
    createdBy: typeof record.createdBy === 'string' ? record.createdBy.slice(0, 160) : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  };
}

function cleanStructureBlocks(value: unknown, pageId: string) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_STRUCTURE_BLOCKS)
    .map((item) => cleanStructureBlock(item, pageId))
    .filter((item): item is Block => Boolean(item));
}

function cleanBlockStructureOperation(
  value: unknown,
  pageId: string,
  blockId: string | null,
  clientId: string,
) {
  const record = cleanOperation(value);
  if (!record) throw new Error('operation is required for block structure updates.');
  const action = typeof record.action === 'string' ? record.action.trim() : '';
  if (!blockStructureActions.has(action)) throw new Error('Block structure operation action is invalid.');
  const before = cleanStructureBlocks(record.before, pageId);
  const after = cleanStructureBlocks(record.after, pageId);
  const blockIds = cleanStringList(record.blockIds)
    .concat(blockId ? [blockId] : [])
    .concat(before.map((block) => block.id), after.map((block) => block.id));
  const uniqueBlockIds = Array.from(new Set(blockIds)).slice(0, MAX_STRUCTURE_BLOCKS);
  if (uniqueBlockIds.length === 0) throw new Error('Block structure operation must include a block id.');
  if (before.length === 0 && after.length === 0) {
    throw new Error('Block structure operation must include before or after blocks.');
  }
  return {
    engine: 'block_structure',
    schemaVersion: 1,
    action,
    blockIds: uniqueBlockIds,
    ...(before.length > 0 ? { before } : {}),
    ...(after.length > 0 ? { after } : {}),
    originClientId:
      typeof record.originClientId === 'string' && record.originClientId.trim()
        ? record.originClientId.trim().slice(0, 160)
        : clientId,
  };
}

function cleanOperationForKind(
  kind: string,
  value: unknown,
  pageId: string,
  blockId: string | null,
  clientId: string,
) {
  if (kind === 'crdt_update') return cleanCrdtUpdateOperation(value, pageId, blockId, clientId);
  if (kind === 'block_structure') return cleanBlockStructureOperation(value, pageId, blockId, clientId);
  return cleanOperation(value);
}

type RepairMode = 'none' | 'auto' | 'full';

function repairMode(body: Record<string, unknown>): RepairMode {
  if (body.repair === true || body.repairMode === 'full') return 'full';
  if (body.repair === 'auto' || body.repairMode === 'auto') return 'auto';
  return 'none';
}

function compareOperations(a: CollaborationOperation, b: CollaborationOperation) {
  return (
    (a.revision ?? 0) - (b.revision ?? 0) ||
    (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') ||
    a.id.localeCompare(b.id)
  );
}

function crdtDocumentId(operation: CollaborationOperation) {
  const payload = operation.operation;
  if (!payload || payload.engine !== 'yjs' || typeof payload.updateBase64 !== 'string') return undefined;
  return typeof payload.documentId === 'string' && payload.documentId.trim()
    ? payload.documentId.trim()
    : operation.blockId
      ? `block:${operation.blockId}`
      : `page:${operation.pageId}`;
}

function operationDocumentTail(records: CollaborationOperation[]) {
  return [...records].sort(compareOperations).at(-1);
}

function crdtDocumentNeedsRepair(
  existing: CollaborationDocument | undefined,
  records: CollaborationOperation[],
  mode: RepairMode,
) {
  if (mode === 'none') return false;
  if (mode === 'full') return records.length > 0;
  const tail = operationDocumentTail(records);
  if (!tail) return false;
  if (!existing) return true;
  if (existing.lastOperationId !== tail.id) return true;
  if ((existing.lastOperationRevision ?? 0) !== (tail.revision ?? 0)) return true;
  if ((existing.lastOperationOccurredAt ?? '') !== (tail.occurredAt ?? '')) return true;
  return (existing.updateCount ?? 0) < records.length;
}

function assertMergeableCrdtUpdate(operation: Record<string, unknown> | undefined) {
  if (!operation || operation.engine !== 'yjs' || typeof operation.updateBase64 !== 'string') return;
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base64ToBytes(operation.updateBase64));
  } catch {
    throw new Error('CRDT update payload could not be merged.');
  }
}

function snapshotUpdatedAtMs(snapshot: unknown): number {
  if (!snapshot || typeof snapshot !== 'object') return NaN;
  const value = (snapshot as { updatedAt?: unknown }).updatedAt;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

// True when `incoming` should replace `current` in the merged blocks map.
// Order-safety: a late-arriving OLDER snapshot must not clobber a newer one.
// When either side lacks a comparable `updatedAt`, fall back to last-write-wins
// (the previous behavior).
function incomingSnapshotWins(incoming: unknown, current: unknown): boolean {
  if (current === undefined || current === null) return true;
  const incomingAt = snapshotUpdatedAtMs(incoming);
  const currentAt = snapshotUpdatedAtMs(current);
  if (Number.isNaN(incomingAt) || Number.isNaN(currentAt)) return true;
  return incomingAt >= currentAt;
}

function preserveIncomingBlockSnapshots(doc: Y.Doc, updateBase64: string) {
  const incoming = new Y.Doc();
  Y.applyUpdate(incoming, base64ToBytes(updateBase64));
  const incomingBlocks = incoming.getMap('blocks');
  if (incomingBlocks.size === 0) return;
  const mergedBlocks = doc.getMap('blocks');
  incomingBlocks.forEach((snapshot, blockId) => {
    if (typeof blockId !== 'string') return;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    // The rebuild path pre-sorts operations, so snapshots arrive oldest-first
    // there; the live path applies whatever op arrives, so guard by updatedAt
    // to keep the most recent snapshot in both.
    if (!incomingSnapshotWins(snapshot, mergedBlocks.get(blockId))) return;
    mergedBlocks.set(blockId, JSON.parse(JSON.stringify(snapshot)));
  });
}

function mergedYjsDocumentState(previousStateBase64: string | undefined, updateBase64: string) {
  const doc = newServerYDoc();
  if (previousStateBase64) Y.applyUpdate(doc, base64ToBytes(previousStateBase64));
  Y.applyUpdate(doc, base64ToBytes(updateBase64));
  preserveIncomingBlockSnapshots(doc, updateBase64);
  return {
    stateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    stateVectorBase64: bytesToBase64(Y.encodeStateVector(doc)),
  };
}

function rebuildYjsDocumentState(
  page: Page,
  documentId: string,
  operations: CollaborationOperation[],
  baseStateBase64?: string,
): RebuiltCrdtDocument | undefined {
  const doc = newServerYDoc();
  // Retention makes the op rows a bounded tail, not full history, so a
  // rebuild seeds from the persisted checkpoint and unions the ops on top
  // (Yjs merge) — pruned history can never be regressed away by a repair.
  if (baseStateBase64) {
    try {
      Y.applyUpdate(doc, base64ToBytes(baseStateBase64));
    } catch {
      // A corrupt checkpoint falls back to a from-ops rebuild.
    }
  }
  let applied = 0;
  let lastOperation: CollaborationOperation | undefined;
  let lastSchemaVersion = 1;
  let lastBlockId: string | null = null;

  for (const operation of operations.sort(compareOperations)) {
    const payload = operation.operation;
    if (!payload || payload.engine !== 'yjs' || typeof payload.updateBase64 !== 'string') continue;
    try {
      Y.applyUpdate(doc, base64ToBytes(payload.updateBase64));
      preserveIncomingBlockSnapshots(doc, payload.updateBase64);
    } catch {
      continue;
    }
    applied += 1;
    lastOperation = operation;
    lastBlockId = operation.blockId ?? null;
    lastSchemaVersion = safeNumber(payload.schemaVersion, lastSchemaVersion || 1);
  }

  if (!lastOperation || applied === 0) return undefined;
  return {
    workspaceId: page.workspaceId,
    pageId: page.id,
    blockId: lastBlockId,
    documentId,
    engine: 'yjs',
    schemaVersion: lastSchemaVersion,
    stateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    stateVectorBase64: bytesToBase64(Y.encodeStateVector(doc)),
    updateCount: applied,
    lastOperationId: lastOperation.id,
    lastOperationRevision: lastOperation.revision ?? 0,
    lastOperationOccurredAt: lastOperation.occurredAt ?? null,
    checkpointedAt: nowIso(),
    updatedAt: lastOperation.occurredAt || lastOperation.createdAt || nowIso(),
  };
}

async function repairCrdtDocuments(
  db: DbRef,
  page: Page,
  existingDocuments: CollaborationDocument[],
  mode: RepairMode,
  filter?: { documentIds?: Set<string>; blockIds?: Set<string> },
) {
  if (mode === 'none') return [];
  const { items: operations } = await listAllTruncated(
    db.table<CollaborationOperation>('collaboration_operations').where('pageId', '==', page.id),
    { maxItems: COLLAB_OP_SCAN_MAX_ITEMS, label: 'Collaboration repair operations' },
  );
  const grouped = new Map<string, CollaborationOperation[]>();
  for (const operation of operations) {
    if (operation.kind !== 'crdt_update') continue;
    const documentId = crdtDocumentId(operation);
    if (!documentId) continue;
    if (filter?.documentIds?.size && !filter.documentIds.has(documentId)) continue;
    if (filter?.blockIds?.size && (!operation.blockId || !filter.blockIds.has(operation.blockId))) continue;
    const group = grouped.get(documentId) ?? [];
    group.push(operation);
    grouped.set(documentId, group);
  }

  const rebuilt: RebuiltCrdtDocument[] = [];
  for (const [documentId, records] of grouped) {
    const existing = existingDocuments.find((document) => document.documentId === documentId);
    if (!crdtDocumentNeedsRepair(existing, records, mode)) continue;
    const document = rebuildYjsDocumentState(page, documentId, records, existing?.stateBase64);
    if (document) rebuilt.push(document);
  }
  return rebuilt;
}

async function persistRebuiltCrdtDocument(
  db: DbRef,
  document: RebuiltCrdtDocument,
  existingDocuments?: CollaborationDocument[],
): Promise<CollaborationDocument> {
  const documentsTable = db.table<CollaborationDocument>('collaboration_documents');
  const existing = existingDocuments ?? await listAll(documentsTable.where('pageId', '==', document.pageId));
  const matches = existing.filter((item) => item.documentId === document.documentId);
  const patch: Partial<CollaborationDocument> = {
    workspaceId: document.workspaceId,
    pageId: document.pageId,
    blockId: document.blockId,
    documentId: document.documentId,
    engine: 'yjs',
    schemaVersion: document.schemaVersion,
    stateBase64: document.stateBase64,
    stateVectorBase64: document.stateVectorBase64,
    updateCount: document.updateCount,
    lastOperationId: document.lastOperationId,
    lastOperationRevision: document.lastOperationRevision,
    lastOperationOccurredAt: document.lastOperationOccurredAt,
    checkpointedAt: document.checkpointedAt,
    updatedAt: document.updatedAt,
  };

  if (matches.length === 0) {
    return documentsTable.insert({ ...patch, createdAt: nowIso() });
  }

  const updated = await Promise.all(
    matches.map((match) => documentsTable.update(match.id, patch).catch(() => null)),
  );
  return updated.find((item): item is CollaborationDocument => Boolean(item)) ?? {
    ...matches[0],
    ...patch,
  } as CollaborationDocument;
}

async function upsertCrdtDocument(
  db: DbRef,
  page: Page,
  operation: CollaborationOperation,
) {
  if (operation.kind !== 'crdt_update' || !operation.operation) return undefined;
  const payload = operation.operation;
  if (payload.engine !== 'yjs' || typeof payload.updateBase64 !== 'string') return undefined;
  const documentId = typeof payload.documentId === 'string' && payload.documentId.trim()
    ? payload.documentId.trim()
    : operation.blockId
      ? `block:${operation.blockId}`
      : `page:${operation.pageId}`;
  const table = db.table<CollaborationDocument>('collaboration_documents');

  // The read → merge → write sequence is a check-then-write race. Two concurrent
  // createOperation calls that load the SAME base would each (1) blind-overwrite
  // the other's checkpoint (lost update) and (2) generate server-side Yjs items
  // under the fixed clientID starting from the same base clock, producing
  // identical (clientID, clock) ids that Yjs dedupes — a permanent divergence.
  //
  // Close both by serializing the merge under an atomic guard: read the current
  // row, merge against ITS state, then commit only if the row is still at the
  // version we merged against (updateCount), inserting only if no row exists yet
  // (unique pageId+documentId). On a guard conflict, retry — the retry re-reads
  // the now-committed state so clocks are assigned against the latest checkpoint
  // (no id collision) and no update is lost. The deterministic empty-doc base
  // stays intact: only one first-insert wins, later merges build on it.
  //
  // Attempt budget: each conflict round lets exactly ONE competitor commit, so
  // an N-way burst on the same document needs up to ~N rounds for the last
  // writer (the parallel-write smoke fires 50 at once). Keep the ceiling well
  // above realistic bursts and jitter the retries so competitors don't re-read
  // in lockstep.
  const MAX_ATTEMPTS = 120;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, 5 * attempt) * (0.5 + Math.random())),
      );
    }
    const documents = await listAll(table.where('pageId', '==', operation.pageId));
    const existing = documents.find((document) => document.documentId === documentId);
    let merged: { stateBase64: string; stateVectorBase64: string };
    try {
      merged = mergedYjsDocumentState(existing?.stateBase64, payload.updateBase64);
    } catch {
      throw new Error('CRDT update payload could not be merged.');
    }

    const patch: Partial<CollaborationDocument> = {
      workspaceId: page.workspaceId,
      pageId: operation.pageId,
      blockId: operation.blockId ?? null,
      documentId,
      engine: 'yjs',
      schemaVersion: safeNumber(payload.schemaVersion, 1),
      stateBase64: merged.stateBase64,
      stateVectorBase64: merged.stateVectorBase64,
      updateCount: (existing?.updateCount ?? 0) + 1,
      lastOperationId: operation.id,
      lastOperationRevision: operation.revision ?? 0,
      lastOperationOccurredAt: operation.occurredAt ?? null,
      checkpointedAt: nowIso(),
      updatedAt: nowIso(),
    };

    try {
      if (existing) {
        await db.transact([
          {
            table: 'collaboration_documents',
            op: 'expect',
            where: [
              ['id', '==', existing.id],
              ['updateCount', '==', existing.updateCount ?? 0],
            ],
            exists: true,
          },
          { table: 'collaboration_documents', op: 'update', id: existing.id, data: patch },
        ]);
        return { ...existing, ...patch } as CollaborationDocument;
      }
      const id = newId();
      await db.transact([
        {
          table: 'collaboration_documents',
          op: 'expect',
          where: [
            ['pageId', '==', operation.pageId],
            ['documentId', '==', documentId],
          ],
          exists: false,
        },
        { table: 'collaboration_documents', op: 'insert', data: { id, createdAt: nowIso(), ...patch } },
      ]);
      return { id, ...patch } as CollaborationDocument;
    } catch (error) {
      // Guard conflict (a concurrent merge committed first) — retry against the
      // fresh state. Non-conflict errors also retry a bounded number of times
      // and then surface.
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('CRDT checkpoint could not be committed after concurrent updates.');
}

/**
 * Delete crdt_update ops superseded by a committed checkpoint, keeping the
 * newest CRDT_SUPERSEDED_OP_RETAIN_PER_PAGE per page as the repair/catch-up
 * tail. "Superseded" is conservative: only ops at-or-before the checkpoint's
 * lastOperation cursor qualify, so an op committed after the checkpoint read
 * is never touched. A stranded op (inserted but never merged) stays inside the
 * retained tail until hundreds of newer checkpoints pass it — and rebuilds
 * seed from the checkpoint state, so pruning cannot regress content.
 */
async function pruneSupersededCrdtOperations(
  db: DbRef,
  pageId: string,
  document: CollaborationDocument,
) {
  const cursor = {
    revision: document.lastOperationRevision ?? 0,
    occurredAt: document.lastOperationOccurredAt ?? '',
    id: document.lastOperationId ?? '',
  };
  if (!cursor.id) return;
  const { items } = await listAllTruncated(
    db.table<CollaborationOperation>('collaboration_operations').where('pageId', '==', pageId),
    { maxItems: COLLAB_OP_SCAN_MAX_ITEMS, label: 'Collaboration prune scan' },
  );
  const superseded = items
    .filter((operation) => operation.kind === 'crdt_update' && !isAfterCursor(operation, cursor))
    .sort(compareOperations);
  const overflow = superseded.length - CRDT_SUPERSEDED_OP_RETAIN_PER_PAGE;
  if (overflow <= 0) return;
  const victims = superseded.slice(0, Math.min(overflow, CRDT_OP_PRUNE_BATCH));
  await db.transact(
    victims.map((victim) => ({ table: 'collaboration_operations', op: 'delete' as const, id: victim.id })),
  );
}

async function createOperation(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pageId = requireString(body.pageId, 'pageId');
  const page = await getWritablePage(db, pageId, actorId, actorEmail);
  const blockId = optionalString(body.blockId);
  await assertBlockOnPage(db, blockId, pageId);
  const occurredAt =
    typeof body.occurredAt === 'string' && body.occurredAt.trim()
      ? body.occurredAt.trim()
      : nowIso();

  const clientId = requireString(body.clientId, 'clientId').slice(0, 160);
  const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim().slice(0, 80) : 'text';
  const cleanedOperation = cleanOperationForKind(kind, body.operation, pageId, blockId, clientId);
  if (kind === 'crdt_update') assertMergeableCrdtUpdate(cleanedOperation);

  const operation: Partial<CollaborationOperation> = {
    id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : newId(),
    workspaceId: page.workspaceId,
    pageId,
    blockId,
    clientId,
    kind,
    operation: cleanedOperation,
    beforeText: typeof body.beforeText === 'string' ? body.beforeText.slice(0, 100_000) : undefined,
    afterText: typeof body.afterText === 'string' ? body.afterText.slice(0, 100_000) : undefined,
    revision: safeNumber(body.revision, Date.parse(occurredAt) || Date.now()),
    actorId,
    occurredAt,
  };

  const inserted = await db.table<CollaborationOperation>('collaboration_operations').insert(operation);
  const document = await upsertCrdtDocument(db, page, inserted);
  if (document) {
    // Retention is housekeeping; a prune failure must not fail the accepted op.
    try {
      await pruneSupersededCrdtOperations(db, pageId, document);
    } catch (error) {
      console.error('[collaboration] superseded-op prune failed:', error);
    }
  }
  return { operation: inserted, document };
}

async function listOperations(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pageId = requireString(body.pageId, 'pageId');
  const page = await getWritablePage(db, pageId, actorId, actorEmail);
  const afterRevision = safeNumber(body.afterRevision, -Infinity);
  const hasCursor =
    typeof body.afterOccurredAt === 'string' || typeof body.afterId === 'string';
  const cursor = {
    revision: afterRevision,
    occurredAt: typeof body.afterOccurredAt === 'string' ? body.afterOccurredAt : '',
    id: typeof body.afterId === 'string' ? body.afterId : '',
  };
  const limit = Math.max(1, Math.min(200, Math.floor(safeNumber(body.limit, 100))));
  // Bounded read: retention keeps a page's ops far below the cap; an over-cap
  // legacy page degrades to a partial window (clients recover via the
  // persisted document state) instead of a hard 413.
  const { items: all } = await listAllTruncated(
    db.table<CollaborationOperation>('collaboration_operations').where('pageId', '==', page.id),
    { maxItems: COLLAB_OP_SCAN_MAX_ITEMS, label: 'Collaboration operations' },
  );
  return all
    .filter((operation) =>
      hasCursor ? isAfterCursor(operation, cursor) : (operation.revision ?? 0) > afterRevision,
    )
    .sort(
      (a, b) =>
        (a.revision ?? 0) - (b.revision ?? 0) ||
        a.occurredAt.localeCompare(b.occurredAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

async function getDocumentState(db: DbRef, body: Record<string, unknown>, actorId: string, actorEmail?: string | null) {
  const pageId = requireString(body.pageId, 'pageId');
  const page = await getWritablePage(db, pageId, actorId, actorEmail);
  const blockId = optionalString(body.blockId);
  await assertBlockOnPage(db, blockId, pageId);
  const documentId = optionalString(body.documentId) ?? (blockId ? `block:${blockId}` : `page:${pageId}`);
  const documents = await listAll(
    db.table<CollaborationDocument>('collaboration_documents').where('pageId', '==', page.id),
  );
  const mode = repairMode(body);
  if (mode !== 'none') {
    const rebuilt = await repairCrdtDocuments(db, page, documents, mode, {
      documentIds: new Set([documentId]),
      ...(blockId ? { blockIds: new Set([blockId]) } : {}),
    });
    if (rebuilt[0]) return persistRebuiltCrdtDocument(db, rebuilt[0], documents);
  }
  return documents.find((document) => document.documentId === documentId) ?? null;
}

async function listDocumentStates(
  db: DbRef,
  body: Record<string, unknown>,
  actorId: string,
  actorEmail?: string | null,
) {
  const pageId = requireString(body.pageId, 'pageId');
  const page = await getWritablePage(db, pageId, actorId, actorEmail);
  const blockIds = new Set(cleanStringList(body.blockIds));
  const documentIds = new Set(cleanStringList(body.documentIds));
  const limit = Math.max(1, Math.min(500, Math.floor(safeNumber(body.limit, 200))));
  const documents = await listAll(
    db.table<CollaborationDocument>('collaboration_documents').where('pageId', '==', page.id),
  );
  const byDocumentId = new Map<string, CollaborationDocument>();
  for (const document of documents) byDocumentId.set(document.documentId, document);
  const mode = repairMode(body);
  if (mode !== 'none') {
    const rebuiltDocuments = await repairCrdtDocuments(db, page, documents, mode, {
      ...(blockIds.size > 0 ? { blockIds } : {}),
      ...(documentIds.size > 0 ? { documentIds } : {}),
    });
    const repairedDocuments = await Promise.all(
      rebuiltDocuments.map((document) => persistRebuiltCrdtDocument(db, document, documents)),
    );
    for (const document of repairedDocuments) byDocumentId.set(document.documentId, document);
  }

  return Array.from(byDocumentId.values())
    .filter((document) => {
      if (blockIds.size > 0 && (!document.blockId || !blockIds.has(document.blockId))) return false;
      if (documentIds.size > 0 && !documentIds.has(document.documentId)) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.documentId.localeCompare(a.documentId))
    .slice(0, limit);
}

export const POST = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: async (context) => {
  const { auth, admin, request } = context as FunctionContext;
  if (!auth?.id) return jsonError(401, 'Authentication required.');

  const body = await requestJson(request);
  const action = typeof body.action === 'string' ? body.action : '';
  const actorEmail = auth.email ?? null;

  try {
    // Inside the try so routing misses map to 404 via the catch below.
    const db = await boundedDbFromPageHint(admin, body.pageId);
    switch (action) {
      case 'create': {
        const created = await createOperation(db, body, auth.id, actorEmail);
        return { operation: created.operation, document: created.document };
      }
      case 'list':
        return { operations: await listOperations(db, body, auth.id, actorEmail) };
      case 'document':
        return { document: await getDocumentState(db, body, auth.id, actorEmail) };
      case 'documents':
        return { documents: await listDocumentStates(db, body, auth.id, actorEmail) };
      default:
        return jsonError(400, 'Unknown collaboration mutation action.');
    }
  } catch (error) {
    const { status, message } = errorStatus(error, [
      { status: 403, needles: ['access required'] },
      { status: 423, needles: ['locked'] },
      { status: 404, needles: ['not found', 'outside'] },
    ]);
    return jsonError(status, message);
  }
  },
});
