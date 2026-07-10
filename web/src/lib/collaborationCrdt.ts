import { spansToPlainText, type CollaborationCrdtUpdateOperation, type TextSpan } from "./types";
import { sanitizeTextSpans } from "./textOperations";

let yjsModulePromise: Promise<typeof import("yjs")> | null = null;
const BLOCK_TEXT_SNAPSHOT_KIND = "block_text_snapshot";
const BLOCK_TEXT_CRDT_SCHEMA_VERSION = 2;
const BLOCK_TEXT_UNDO_CAPTURE_TIMEOUT_MS = 500;

type BlockTextUndoSession = {
  doc: import("yjs").Doc;
  lastRich: TextSpan[];
  localOrigin: object;
  remoteOrigin: object;
  text: import("yjs").Text;
  undoManager: import("yjs").UndoManager;
  updatedAt: string;
  // Whether this session's base is safe to SHARE with peers. See the invariant
  // near `markBlockTextCollaborationPristine`. A session is base-safe when it was
  // hydrated from authoritative durable state, or seeded from empty content, or
  // seeded for a block the server confirmed has no durable document (never
  // collaborated). It is NOT base-safe when we seeded grown, possibly-shared
  // content under the reserved base clientID with no durable state to prove it
  // is the pristine origin — emitting that would re-encode a peer's characters
  // under the base clientID and duplicate them on merge (the H1 bug).
  baseSafe: boolean;
};

export type BlockTextUndoResult = {
  operation: CollaborationCrdtUpdateOperation;
  plainText: string;
  rich: TextSpan[];
  updatedAt: string;
};

type BlockTextUndoSessionState = {
  plainText: string;
  rich: TextSpan[];
  updatedAt: string;
};

const blockTextUndoSessions = new Map<string, BlockTextUndoSession>();
const pendingBlockTextUndoSessionWrites = new Map<string, Promise<void>>();

// Authoritative Yjs document state per block, as last observed from the durable
// collaboration store or a remote peer. When a session is (re)created — by a late
// joiner, a second tab, or after this map's own LRU eviction — we hydrate the doc
// from this state instead of re-seeding a deterministic base from the block's
// *current* plain content. Re-seeding grown content under the reserved base
// clientID re-encodes another client's characters as fresh base items, which Yjs
// then keeps twice on merge (the H1 duplication bug). Hydrating from the real
// state keeps every prior client's characters under their original clientIDs.
const durableBlockTextStateByBlock = new Map<string, Uint8Array>();
const MAX_DURABLE_BLOCK_TEXT_STATES = 600;

// Blocks the server confirmed have NO durable collaboration document. Such a
// block was never collaborated on, so no peer holds any of its characters under
// a private clientID — seeding its current content under the reserved base
// clientID is therefore safe (it cannot collide with a peer's private items).
//
// INVARIANT (H1): the reserved base clientID (BLOCK_TEXT_BASE_CLIENT_ID) may
// only ever carry content that is provably the shared origin — empty content,
// content hydrated from authoritative durable state, or content of a
// confirmed-pristine block. Seeding grown content under the base clientID
// without one of those guarantees is what re-encodes another client's already
// -merged characters as base items and duplicates them on merge. When none of
// the guarantees hold we mark the session `baseSafe: false` and refuse to emit
// its update until the block is primed (durable state fetched, or absence
// confirmed) — see createBlockTextCrdtUpdateFromUndoSession.
const pristineBlockTextBlocks = new Set<string>();
const MAX_PRISTINE_BLOCK_TEXT_BLOCKS = 4000;
export function markBlockTextCollaborationPristine(blockId: string) {
  if (!blockId) return;
  pristineBlockTextBlocks.delete(blockId);
  pristineBlockTextBlocks.add(blockId);
  while (pristineBlockTextBlocks.size > MAX_PRISTINE_BLOCK_TEXT_BLOCKS) {
    const oldest = pristineBlockTextBlocks.keys().next().value;
    if (oldest === undefined) break;
    pristineBlockTextBlocks.delete(oldest);
  }
}

function isEmptyRich(rich: TextSpan[]): boolean {
  return spansToPlainText(normalizeRichText(rich)).length === 0;
}

// True when a new session for `blockId` seeded from `initialRich` may safely
// share its base with peers (see the INVARIANT above). Hydration from durable
// state is handled by the caller and always base-safe.
function isSeedBaseSafe(blockId: string, initialRich: TextSpan[]): boolean {
  return isEmptyRich(initialRich) || pristineBlockTextBlocks.has(blockId);
}
function rememberBlockTextDurableStateBytes(blockId: string, bytes: Uint8Array) {
  if (!bytes.length) return;
  durableBlockTextStateByBlock.delete(blockId);
  durableBlockTextStateByBlock.set(blockId, bytes);
  while (durableBlockTextStateByBlock.size > MAX_DURABLE_BLOCK_TEXT_STATES) {
    const oldest = durableBlockTextStateByBlock.keys().next().value;
    if (oldest === undefined) break;
    durableBlockTextStateByBlock.delete(oldest);
  }
}

// Each session holds a live Y.Doc + UndoManager; the map was never evicted, so
// a long SPA session browsing many pages leaked one per block ever edited or
// synced. Cap it LRU-style (re-insert on touch, drop the oldest over the cap).
const MAX_BLOCK_TEXT_UNDO_SESSIONS = 300;
function rememberBlockTextUndoSession(blockId: string, session: BlockTextUndoSession) {
  blockTextUndoSessions.delete(blockId);
  blockTextUndoSessions.set(blockId, session);
  while (blockTextUndoSessions.size > MAX_BLOCK_TEXT_UNDO_SESSIONS) {
    const oldest = blockTextUndoSessions.keys().next().value;
    if (oldest === undefined) break;
    blockTextUndoSessions.delete(oldest);
  }
}

function loadYjs(): Promise<typeof import("yjs")> {
  if (!yjsModulePromise) yjsModulePromise = import("yjs");
  return yjsModulePromise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Record the authoritative Yjs state for a block (from the durable collaboration
// store) so a later session for the same block hydrates from the real shared base
// instead of re-seeding grown plain content. Safe to call repeatedly; the latest
// state wins.
export function rememberBlockTextDurableState(blockId: string, stateBase64: unknown) {
  if (!blockId || typeof stateBase64 !== "string" || !stateBase64) return;
  try {
    const bytes = base64ToBytes(stateBase64);
    // Authoritative server state just arrived. A session that was provisionally
    // seeded from grown content (baseSafe=false) is now superseded — evict it so
    // the next ensure() rebuilds hydrated from this durable state instead of
    // merging peers' updates onto a corrupt seed.
    const existing = blockTextUndoSessions.get(blockId);
    if (existing && !existing.baseSafe) blockTextUndoSessions.delete(blockId);
    // The block DOES have a durable document, so it is no longer "pristine".
    pristineBlockTextBlocks.delete(blockId);
    rememberBlockTextDurableStateBytes(blockId, bytes);
  } catch {
    // Ignore malformed durable state; the session will fall back to seeding.
  }
}

function cloneRichText(spans: TextSpan[]): TextSpan[] {
  return JSON.parse(JSON.stringify(spans)) as TextSpan[];
}

function normalizeRichText(spans: TextSpan[]): TextSpan[] {
  return sanitizeTextSpans(spans) ?? [];
}

function sameRichText(a: TextSpan[], b: TextSpan[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function spanToYTextAttributes(span: TextSpan): Record<string, string | boolean> | undefined {
  const attributes: Record<string, string | boolean> = {};
  if (span.bold) attributes.bold = true;
  if (span.italic) attributes.italic = true;
  if (span.underline) attributes.underline = true;
  if (span.strikethrough) attributes.strikethrough = true;
  if (span.code) attributes.code = true;
  if (span.color) attributes.color = span.color;
  if (span.link) attributes.link = span.link;
  if (span.commentId) attributes.commentId = span.commentId;
  if (span.mention) attributes.mention = span.mention;
  if (span.pageId) attributes.pageId = span.pageId;
  if (span.date) attributes.date = span.date;
  if (span.userId) attributes.userId = span.userId;
  if (span.iconUrl) attributes.iconUrl = span.iconUrl;
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function yTextToRichText(text: import("yjs").Text): TextSpan[] | undefined {
  const spans: TextSpan[] = [];
  for (const delta of text.toDelta()) {
    if (typeof delta.insert !== "string" || delta.insert.length === 0) continue;
    const attributes =
      delta.attributes && typeof delta.attributes === "object"
        ? (delta.attributes as Record<string, unknown>)
        : {};
    const span: TextSpan = { text: delta.insert };
    if (attributes.bold === true) span.bold = true;
    if (attributes.italic === true) span.italic = true;
    if (attributes.underline === true) span.underline = true;
    if (attributes.strikethrough === true) span.strikethrough = true;
    if (attributes.code === true) span.code = true;
    if (typeof attributes.color === "string") span.color = attributes.color;
    if (typeof attributes.link === "string") span.link = attributes.link;
    if (typeof attributes.commentId === "string") span.commentId = attributes.commentId;
    if (
      attributes.mention === "page" ||
      attributes.mention === "date" ||
      attributes.mention === "person" ||
      attributes.mention === "external"
    ) {
      span.mention = attributes.mention;
    }
    if (typeof attributes.pageId === "string") span.pageId = attributes.pageId;
    if (typeof attributes.date === "string") span.date = attributes.date;
    if (typeof attributes.userId === "string") span.userId = attributes.userId;
    if (typeof attributes.iconUrl === "string") span.iconUrl = attributes.iconUrl;
    spans.push(span);
  }
  return sanitizeTextSpans(spans);
}

function richTextWithinMergedPlainText(rich: TextSpan[], plainText: string): TextSpan[] {
  const snapshotPlainText = spansToPlainText(rich);
  if (snapshotPlainText === plainText) return rich;
  if (!snapshotPlainText) return plainText ? [{ text: plainText }] : [];
  const start = plainText.indexOf(snapshotPlainText);
  if (start < 0 || plainText.indexOf(snapshotPlainText, start + snapshotPlainText.length) >= 0) {
    return plainText ? [{ text: plainText }] : [];
  }

  const out: TextSpan[] = [];
  if (start > 0) out.push({ text: plainText.slice(0, start) });
  out.push(...cloneRichText(rich));
  const end = start + snapshotPlainText.length;
  if (end < plainText.length) out.push({ text: plainText.slice(end) });
  return out;
}

function blockTextCrdtKey(blockId: string) {
  return `block:${blockId}:plainText`;
}

// Reserved deterministic clientID for the shared base insert. Every client that
// starts a block from the same server content seeds byte-identical base items
// under this id, so their concurrent edits merge over one shared base instead
// of each keeping its own copy (the H1 concatenation bug).
const BLOCK_TEXT_BASE_CLIENT_ID = 1;

const BLOCK_TEXT_ATTR_KEYS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "color",
  "link",
  "commentId",
  "mention",
  "pageId",
  "date",
  "userId",
  "iconUrl",
] as const;

// Reconcile a Y.Text to `rich` WITHOUT deleting and re-inserting everything.
// A full replace re-creates every character under the writer's clientID, so two
// clients editing the same block never converge — Yjs keeps both full inserts.
// Instead: (1) a minimal prefix/suffix plain-text diff preserves the identity of
// unchanged text, and (2) each run is formatted to its exact target attributes
// (absent marks explicitly cleared). This makes concurrent edits converge
// character-by-character and keeps payloads proportional to the actual change.
function writeRichTextToYText(text: import("yjs").Text, rich: TextSpan[]) {
  const current = text.toString();
  const next = spansToPlainText(rich);
  if (current !== next) {
    let prefix = 0;
    const maxPrefix = Math.min(current.length, next.length);
    while (prefix < maxPrefix && current[prefix] === next[prefix]) prefix += 1;
    let suffix = 0;
    const maxSuffix = Math.min(current.length - prefix, next.length - prefix);
    while (
      suffix < maxSuffix &&
      current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const deleteCount = current.length - prefix - suffix;
    const insert = next.slice(prefix, next.length - suffix);
    if (deleteCount > 0) text.delete(prefix, deleteCount);
    if (insert) text.insert(prefix, insert);
  }

  let index = 0;
  for (const span of rich) {
    if (!span.text) continue;
    const want = spanToYTextAttributes(span) ?? {};
    const format: Record<string, string | boolean | null> = {};
    for (const key of BLOCK_TEXT_ATTR_KEYS) {
      format[key] = key in want ? want[key] : null;
    }
    text.format(index, span.text.length, format);
    index += span.text.length;
  }
}

// Seed a doc's shared base deterministically (fixed clientID) so every client
// derives identical base items — the precondition for convergent concurrent
// edits. Local edits afterwards use the doc's own (random) clientID.
function seedDeterministicBlockTextBase(
  Y: typeof import("yjs"),
  doc: import("yjs").Doc,
  blockId: string,
  rich: TextSpan[]
) {
  const base = new Y.Doc();
  base.clientID = BLOCK_TEXT_BASE_CLIENT_ID;
  const key = blockTextCrdtKey(blockId);
  base.transact(() => {
    writeRichTextToYText(base.getText(key), rich);
  });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
}

function writeBlockTextSnapshot(
  doc: import("yjs").Doc,
  blockId: string,
  rich: TextSpan[],
  updatedAt: string
) {
  const textKey = blockTextCrdtKey(blockId);
  doc.getMap("blocks").set(blockId, {
    kind: BLOCK_TEXT_SNAPSHOT_KIND,
    schemaVersion: BLOCK_TEXT_CRDT_SCHEMA_VERSION,
    rich: cloneRichText(rich),
    plainText: spansToPlainText(rich),
    crdtTextKey: textKey,
    updatedAt,
  });
}

function encodeBlockTextCrdtUpdate(
  Y: typeof import("yjs"),
  doc: import("yjs").Doc,
  blockId: string
): CollaborationCrdtUpdateOperation {
  return {
    engine: "yjs",
    schemaVersion: BLOCK_TEXT_CRDT_SCHEMA_VERSION,
    documentId: `block:${blockId}`,
    updateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    stateVectorBase64: bytesToBase64(Y.encodeStateVector(doc)),
  };
}

function createBlockTextUndoSession({
  Y,
  blockId,
  doc,
  initialRich,
  initialize,
  updatedAt,
  baseSafe = true,
}: {
  Y: typeof import("yjs");
  blockId: string;
  doc: import("yjs").Doc;
  initialRich: TextSpan[];
  initialize: boolean;
  updatedAt: string;
  // Defaults to true for the stateless encoder and test builders, which seed a
  // self-contained base they own. Session callers pass the computed value.
  baseSafe?: boolean;
}): BlockTextUndoSession {
  const text = doc.getText(blockTextCrdtKey(blockId));
  const localOrigin = { source: "notionlike:block-text-local", blockId };
  const remoteOrigin = { source: "notionlike:block-text-remote", blockId };

  // Seed the base under the reserved deterministic clientID FIRST (outside a
  // local transact — it must not be tracked by undo), so every client sharing
  // this block's content converges on one base rather than duplicating it.
  // Seeding must use initialRich directly: yTextToRichText on the still-empty
  // Y.Text returns [] (not undefined), which would otherwise short-circuit the
  // fallback and seed an empty base.
  if (initialize) {
    seedDeterministicBlockTextBase(Y, doc, blockId, normalizeRichText(initialRich));
  }

  // Read the content back — after seeding, the Y.Text now reflects the base.
  const readback = readSnapshot(doc, blockId)?.rich ?? yTextToRichText(text) ?? [];
  let rich = readback.length > 0 ? readback : normalizeRichText(initialRich);

  if (initialize || readSnapshot(doc, blockId) === undefined) {
    doc.transact(() => {
      writeBlockTextSnapshot(doc, blockId, rich, updatedAt);
    }, remoteOrigin);
    rich = readSnapshot(doc, blockId)?.rich ?? rich;
  }

  const undoManager = new Y.UndoManager(text, {
    captureTimeout: BLOCK_TEXT_UNDO_CAPTURE_TIMEOUT_MS,
    trackedOrigins: new Set([localOrigin]),
  });
  return {
    doc,
    lastRich: cloneRichText(rich),
    localOrigin,
    remoteOrigin,
    text,
    undoManager,
    updatedAt,
    baseSafe,
  };
}

async function ensureBlockTextUndoSession({
  blockId,
  initialRich,
  updatedAt,
}: {
  blockId: string;
  initialRich: TextSpan[];
  updatedAt: string;
}): Promise<BlockTextUndoSession> {
  const existing = blockTextUndoSessions.get(blockId);
  if (existing) return existing;

  const Y = await loadYjs();
  const createdByOtherWrite = blockTextUndoSessions.get(blockId);
  if (createdByOtherWrite) return createdByOtherWrite;

  // If we hold authoritative durable state for this block, hydrate the session
  // from it and skip the deterministic-base seed. Seeding re-encodes the block's
  // current (already collaboratively-grown) content under the reserved base
  // clientID, which duplicates the shared region on merge (H1). Hydrating keeps
  // every prior client's characters under their original clientIDs.
  const doc = new Y.Doc();
  let hydrated = false;
  const durableState = durableBlockTextStateByBlock.get(blockId);
  if (durableState) {
    try {
      Y.applyUpdate(doc, durableState, "notionlike:block-text-remote");
      hydrated = true;
    } catch {
      hydrated = false;
    }
  }

  const session = createBlockTextUndoSession({
    Y,
    blockId,
    doc,
    initialRich,
    initialize: !hydrated,
    updatedAt,
    baseSafe: hydrated || isSeedBaseSafe(blockId, initialRich),
  });
  rememberBlockTextUndoSession(blockId, session);
  return session;
}

function updateBlockTextUndoSession(
  session: BlockTextUndoSession,
  blockId: string,
  rich: TextSpan[],
  updatedAt: string,
  origin: object
) {
  const nextRich = normalizeRichText(rich);
  if (sameRichText(session.lastRich, nextRich) && session.updatedAt === updatedAt) return;
  session.doc.transact(() => {
    writeRichTextToYText(session.text, nextRich);
    writeBlockTextSnapshot(session.doc, blockId, nextRich, updatedAt);
  }, origin);
  session.lastRich = cloneRichText(nextRich);
  session.updatedAt = updatedAt;
}

function queueBlockTextUndoSessionWrite<T>(blockId: string, write: () => Promise<T>) {
  const previous = pendingBlockTextUndoSessionWrites.get(blockId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(write);
  const pending = next
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (pendingBlockTextUndoSessionWrites.get(blockId) === pending) {
        pendingBlockTextUndoSessionWrites.delete(blockId);
      }
    });
  pendingBlockTextUndoSessionWrites.set(blockId, pending);
  return next;
}

async function waitForBlockTextUndoSessionWrites(blockId: string) {
  await pendingBlockTextUndoSessionWrites.get(blockId)?.catch(() => {});
}

function yjsStackLength(undoManager: import("yjs").UndoManager, stackName: "redoStack" | "undoStack") {
  const stack = (undoManager as unknown as Record<string, unknown>)[stackName];
  return Array.isArray(stack) ? stack.length : 0;
}

async function blockTextUndoResult(
  blockId: string,
  session: BlockTextUndoSession,
  updatedAt: string
): Promise<BlockTextUndoResult> {
  const Y = await loadYjs();
  const rich = yTextToRichText(session.text) ?? [];
  session.doc.transact(() => {
    writeBlockTextSnapshot(session.doc, blockId, rich, updatedAt);
  }, session.remoteOrigin);
  session.lastRich = cloneRichText(rich);
  session.updatedAt = updatedAt;
  return {
    operation: encodeBlockTextCrdtUpdate(Y, session.doc, blockId),
    plainText: spansToPlainText(rich),
    rich,
    updatedAt,
  };
}

function yjsUpdateOperationBytes(operation: unknown): Uint8Array | undefined {
  if (!operation || typeof operation !== "object") return undefined;
  const source = operation as Record<string, unknown>;
  if (source.engine !== "yjs" || typeof source.updateBase64 !== "string") return undefined;
  try {
    return base64ToBytes(source.updateBase64);
  } catch {
    return undefined;
  }
}

function blockTextUndoSessionState(
  blockId: string,
  session: BlockTextUndoSession,
  fallbackRich: TextSpan[],
  updatedAt: string
): BlockTextUndoSessionState {
  const rich = yTextToRichText(session.text) ?? readSnapshot(session.doc, blockId)?.rich ?? normalizeRichText(fallbackRich);
  session.doc.transact(() => {
    writeBlockTextSnapshot(session.doc, blockId, rich, updatedAt);
  }, session.remoteOrigin);
  session.lastRich = cloneRichText(rich);
  session.updatedAt = updatedAt;
  return {
    plainText: spansToPlainText(rich),
    rich,
    updatedAt,
  };
}

function readSnapshot(
  doc: import("yjs").Doc,
  blockId: string
): { rich: TextSpan[]; plainText: string; updatedAt?: string; hasCrdtText: boolean } | undefined {
  const snapshot = doc.getMap("blocks").get(blockId);
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const record = snapshot as Record<string, unknown>;
  if (record.kind !== BLOCK_TEXT_SNAPSHOT_KIND) return undefined;
  const rich = sanitizeTextSpans(record.rich);
  if (!rich) return undefined;

  const textKey =
    typeof record.crdtTextKey === "string" && record.crdtTextKey.trim()
      ? record.crdtTextKey.trim()
      : blockTextCrdtKey(blockId);
  const text = doc.getText(textKey);
  const crdtText = text.toString();
  const hasCrdtText =
    typeof record.crdtTextKey === "string" ||
    (typeof record.schemaVersion === "number" && record.schemaVersion >= BLOCK_TEXT_CRDT_SCHEMA_VERSION);
  const snapshotPlainText =
    typeof record.plainText === "string" ? record.plainText : spansToPlainText(rich);
  const plainText = hasCrdtText ? crdtText : snapshotPlainText;
  const crdtRich = hasCrdtText ? yTextToRichText(text) : undefined;
  const finalRich = hasCrdtText
    ? crdtRich && spansToPlainText(crdtRich) === plainText
      ? crdtRich
      : richTextWithinMergedPlainText(rich, plainText)
    : rich;

  return {
    rich: finalRich,
    plainText,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    hasCrdtText,
  };
}

export async function createBlockTextCrdtUpdate({
  blockId,
  rich,
  updatedAt,
}: {
  blockId: string;
  rich: TextSpan[];
  updatedAt: string;
}): Promise<CollaborationCrdtUpdateOperation> {
  const Y = await loadYjs();
  const doc = new Y.Doc();
  const normalizedRich = normalizeRichText(rich);
  // A stateless full-content encoder: represent the content as the shared
  // deterministic base so two identical-content calls are byte-identical
  // (idempotent). Divergent edits must go through the session encoder, which
  // carries the base separately from each client's edits.
  seedDeterministicBlockTextBase(Y, doc, blockId, normalizedRich);
  doc.transact(() => {
    writeBlockTextSnapshot(doc, blockId, normalizedRich, updatedAt);
  }, "notionlike:block-text-crdt");

  return encodeBlockTextCrdtUpdate(Y, doc, blockId);
}

// Testing-only: build an independent client's collaboration update for a block,
// mirroring a real client's path — deterministic shared-base seed then a
// minimal-diff local edit — without touching the process-wide session map. Two
// calls model two clients editing the same block from the same base, so a test
// can merge them and assert convergence rather than concatenation.
export async function __buildBlockTextClientUpdateForTest(
  blockId: string,
  baseRich: TextSpan[],
  editedRich: TextSpan[],
  updatedAt = ""
): Promise<CollaborationCrdtUpdateOperation> {
  const Y = await loadYjs();
  const session = createBlockTextUndoSession({
    Y,
    blockId,
    doc: new Y.Doc(),
    initialRich: baseRich,
    initialize: true,
    updatedAt,
  });
  updateBlockTextUndoSession(session, blockId, editedRich, updatedAt, session.localOrigin);
  return encodeBlockTextCrdtUpdate(Y, session.doc, blockId);
}

export function captureBlockTextLocalEdit({
  blockId,
  beforeRich,
  rich,
  updatedAt,
}: {
  beforeRich: TextSpan[];
  blockId: string;
  rich: TextSpan[];
  updatedAt: string;
}): Promise<void> {
  return queueBlockTextUndoSessionWrite(blockId, async () => {
    const session = await ensureBlockTextUndoSession({ blockId, initialRich: beforeRich, updatedAt });
    updateBlockTextUndoSession(session, blockId, rich, updatedAt, session.localOrigin);
  });
}

export function syncBlockTextRemoteEdit({
  blockId,
  rich,
  updatedAt,
}: {
  blockId: string;
  rich: TextSpan[];
  updatedAt: string;
}): Promise<void> {
  return queueBlockTextUndoSessionWrite(blockId, async () => {
    const session = await ensureBlockTextUndoSession({ blockId, initialRich: rich, updatedAt });
    updateBlockTextUndoSession(session, blockId, rich, updatedAt, session.remoteOrigin);
  });
}

export function applyBlockTextRemoteCrdtUpdatesToUndoSession({
  blockId,
  fallbackRich,
  operations,
  updatedAt,
}: {
  blockId: string;
  fallbackRich: TextSpan[];
  operations: unknown[];
  updatedAt: string;
}): Promise<BlockTextUndoSessionState | undefined> {
  return queueBlockTextUndoSessionWrite(blockId, async () => {
    const Y = await loadYjs();
    let session = blockTextUndoSessions.get(blockId);
    let applied = 0;

    if (!session) {
      const doc = new Y.Doc();
      for (const operation of operations) {
        const update = yjsUpdateOperationBytes(operation);
        if (!update) continue;
        try {
          Y.applyUpdate(doc, update, "notionlike:block-text-remote");
          applied += 1;
        } catch {
          // Ignore malformed remote updates and keep any valid updates in the batch.
        }
      }
      session = createBlockTextUndoSession({
        Y,
        blockId,
        doc,
        initialRich: fallbackRich,
        initialize: applied === 0,
        updatedAt,
        // applied>0 means the doc was hydrated from real remote updates (base-
        // safe). Otherwise we seeded fallbackRich, so apply the same seed rule.
        baseSafe: applied > 0 || isSeedBaseSafe(blockId, fallbackRich),
      });
      rememberBlockTextUndoSession(blockId, session);
      if (applied > 0) rememberBlockTextDurableStateBytes(blockId, Y.encodeStateAsUpdate(session.doc));
      return blockTextUndoSessionState(blockId, session, fallbackRich, updatedAt);
    }

    for (const operation of operations) {
      const update = yjsUpdateOperationBytes(operation);
      if (!update) continue;
      try {
        Y.applyUpdate(session.doc, update, session.remoteOrigin);
        applied += 1;
      } catch {
        // Ignore malformed remote updates and keep any valid updates in the batch.
      }
    }

    if (applied === 0) return undefined;
    // Remember the merged authoritative state so a future session for this block
    // (after LRU eviction) hydrates from it instead of re-seeding grown content.
    rememberBlockTextDurableStateBytes(blockId, Y.encodeStateAsUpdate(session.doc));
    return blockTextUndoSessionState(blockId, session, fallbackRich, updatedAt);
  });
}

export async function createBlockTextCrdtUpdateFromUndoSession({
  blockId,
  rich,
  updatedAt,
}: {
  blockId: string;
  rich: TextSpan[];
  updatedAt: string;
}): Promise<CollaborationCrdtUpdateOperation | undefined> {
  await waitForBlockTextUndoSessionWrites(blockId);
  const Y = await loadYjs();
  const session = await ensureBlockTextUndoSession({ blockId, initialRich: rich, updatedAt });
  // Refuse to emit an update whose base we can't prove is the shared origin.
  // Emitting a base-clientID copy of grown content duplicates a peer's already
  // -merged characters (H1). The edit still propagates via the plain-text
  // operation log; once the block is primed (durable state fetched or its
  // absence confirmed) a later edit encodes cleanly.
  if (!session.baseSafe) return undefined;
  if (!sameRichText(session.lastRich, normalizeRichText(rich)) || session.updatedAt !== updatedAt) {
    updateBlockTextUndoSession(session, blockId, rich, updatedAt, session.remoteOrigin);
  }
  return encodeBlockTextCrdtUpdate(Y, session.doc, blockId);
}

export async function undoBlockTextLocalEdit(
  blockId: string,
  updatedAt = new Date().toISOString()
): Promise<BlockTextUndoResult | undefined> {
  await waitForBlockTextUndoSessionWrites(blockId);
  const session = blockTextUndoSessions.get(blockId);
  if (!session || yjsStackLength(session.undoManager, "undoStack") === 0) return undefined;
  session.undoManager.undo();
  return blockTextUndoResult(blockId, session, updatedAt);
}

export async function redoBlockTextLocalEdit(
  blockId: string,
  updatedAt = new Date().toISOString()
): Promise<BlockTextUndoResult | undefined> {
  await waitForBlockTextUndoSessionWrites(blockId);
  const session = blockTextUndoSessions.get(blockId);
  if (!session || yjsStackLength(session.undoManager, "redoStack") === 0) return undefined;
  session.undoManager.redo();
  return blockTextUndoResult(blockId, session, updatedAt);
}

export async function readBlockTextCrdtUpdate(
  operation: unknown,
  blockId: string
): Promise<{ rich: TextSpan[]; plainText: string; updatedAt?: string } | undefined> {
  if (!operation || typeof operation !== "object") return undefined;
  const source = operation as Record<string, unknown>;
  if (source.engine !== "yjs" || typeof source.updateBase64 !== "string") return undefined;

  const Y = await loadYjs();
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, base64ToBytes(source.updateBase64));
  } catch {
    return undefined;
  }

  const snapshot = readSnapshot(doc, blockId);
  if (!snapshot) return undefined;
  return {
    rich: snapshot.rich,
    plainText: snapshot.plainText,
    updatedAt: snapshot.updatedAt,
  };
}

export async function readBlockTextCrdtDocumentState(
  stateBase64: string,
  blockId: string
): Promise<{ rich: TextSpan[]; plainText: string; updatedAt?: string } | undefined> {
  return readBlockTextCrdtUpdate({ engine: "yjs", updateBase64: stateBase64 }, blockId);
}

export async function mergeBlockTextCrdtUpdates(
  operations: unknown[],
  blockId: string
): Promise<{ rich: TextSpan[]; plainText: string; updatedAt?: string } | undefined> {
  const Y = await loadYjs();
  const doc = new Y.Doc();
  let applied = 0;

  for (const operation of operations) {
    if (!operation || typeof operation !== "object") continue;
    const source = operation as Record<string, unknown>;
    if (source.engine !== "yjs" || typeof source.updateBase64 !== "string") continue;
    try {
      Y.applyUpdate(doc, base64ToBytes(source.updateBase64));
      applied += 1;
    } catch {
      // Ignore malformed remote updates and keep any valid updates in the batch.
    }
  }

  if (applied === 0) return undefined;
  const snapshot = readSnapshot(doc, blockId);
  if (!snapshot) return undefined;
  return {
    rich: snapshot.rich,
    plainText: snapshot.plainText,
    updatedAt: snapshot.updatedAt,
  };
}
