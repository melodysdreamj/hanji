import type {
  CollaborationBlockStructureAction,
  CollaborationBlockStructureBlock,
  CollaborationBlockStructureOperation,
} from "./types";

const STRUCTURE_ACTIONS = new Set<CollaborationBlockStructureAction>([
  "create",
  "move",
  "indent",
  "outdent",
  "delete",
  "restore",
]);

// Structure payloads carry full block snapshots; cap them so a malformed or
// hostile op-log record can't allocate unbounded state on replay.
const MAX_STRUCTURE_BLOCKS = 500;

function sanitizeStructureBlock(value: unknown): CollaborationBlockStructureBlock | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || !source.id) return undefined;
  if (typeof source.pageId !== "string" || !source.pageId) return undefined;
  if (typeof source.position !== "number" || !Number.isFinite(source.position)) return undefined;
  const block: CollaborationBlockStructureBlock = {
    id: source.id,
    pageId: source.pageId,
    position: source.position,
  };
  if (source.parentId === null || typeof source.parentId === "string") {
    block.parentId = (source.parentId as string | null) ?? null;
  }
  if (typeof source.type === "string" && source.type) block.type = source.type;
  if (source.content && typeof source.content === "object" && !Array.isArray(source.content)) {
    block.content = source.content as Record<string, unknown>;
  }
  if (typeof source.plainText === "string") block.plainText = source.plainText;
  if (typeof source.createdBy === "string") block.createdBy = source.createdBy;
  if (typeof source.createdAt === "string") block.createdAt = source.createdAt;
  if (typeof source.updatedAt === "string") block.updatedAt = source.updatedAt;
  return block;
}

function sanitizeStructureBlocks(value: unknown): CollaborationBlockStructureBlock[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_STRUCTURE_BLOCKS) return undefined;
  const out: CollaborationBlockStructureBlock[] = [];
  for (const item of value) {
    const block = sanitizeStructureBlock(item);
    if (!block) return undefined;
    out.push(block);
  }
  return out;
}

/**
 * Validate a `block_structure` operation payload from the collaboration op
 * log (untrusted JSON) into a typed operation, or undefined when malformed.
 * Mirrors sanitizeTextSpanOperation's role for text records.
 */
export function sanitizeBlockStructureOperation(
  value: unknown
): CollaborationBlockStructureOperation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.engine !== "block_structure") return undefined;
  if (
    typeof source.action !== "string" ||
    !STRUCTURE_ACTIONS.has(source.action as CollaborationBlockStructureAction)
  ) {
    return undefined;
  }
  const before = sanitizeStructureBlocks(source.before);
  const after = sanitizeStructureBlocks(source.after);
  if (!before || !after) return undefined;
  if (before.length === 0 && after.length === 0) return undefined;
  const blockIds = Array.isArray(source.blockIds)
    ? source.blockIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return {
    engine: "block_structure",
    schemaVersion: typeof source.schemaVersion === "number" ? source.schemaVersion : 1,
    action: source.action as CollaborationBlockStructureAction,
    blockIds,
    before,
    after,
    ...(typeof source.originClientId === "string" && source.originClientId
      ? { originClientId: source.originClientId }
      : {}),
  };
}
