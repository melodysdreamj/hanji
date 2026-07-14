export const NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX = 500;
export const NOTION_IMPORT_MCP_FETCH_PAYLOADS_PER_REQUEST_MAX = 32;
export const NOTION_IMPORT_MCP_TEXT_MAX_BYTES = 4 * 1024 * 1024;
export const NOTION_IMPORT_MCP_EMBEDDED_JSON_MAX_BYTES = 256 * 1024;
export const NOTION_IMPORT_MCP_EMBEDDED_JSON_AGGREGATE_MAX_BYTES = 4 * 1024 * 1024;
export const NOTION_IMPORT_MCP_VIEW_ASSIGNMENT_WORK_MAX = 5_000;
export const NOTION_IMPORT_SNAPSHOT_ITEM_MAX_BYTES = 256 * 1024;
export const NOTION_IMPORT_SNAPSHOT_AGGREGATE_MAX_BYTES = 6 * 1024 * 1024;
export const NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH = 32;
export const NOTION_IMPORT_REQUEST_JSON_MAX_NODES = 100_000;

export interface DiscoveredNotionItem {
  notionId: string;
  notionObject: string;
  parentNotionId?: string | null;
  title?: string;
  status?: string;
  phase?: string;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface NotionImportRequestJsonBudget {
  bytes: number;
  nodes: number;
}

export interface NotionImportJsonShapeBudget {
  nodes: number;
}

const notionImportUtf8Encoder = new TextEncoder();

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizedNotionId(value: unknown) {
  return typeof value === 'string'
    ? value.trim().replace(/-/g, '').toLowerCase()
    : '';
}

export function missingRequestedRootIds(
  requestedRootIds: string[],
  items: DiscoveredNotionItem[],
) {
  if (!requestedRootIds.length) return [];
  const discoveredIds = new Set(
    items.map((item) => normalizedNotionId(item.notionId)).filter(Boolean),
  );
  return requestedRootIds.filter((id) => {
    const normalized = normalizedNotionId(id);
    return normalized && !discoveredIds.has(normalized);
  });
}

export function notionImportPayloadTooLarge(reason: string): never {
  throw new Error(`Notion import request payload is too large: ${reason}.`);
}

export function assertNotionImportJsonShape(
  value: unknown,
  budget: NotionImportJsonShapeBudget,
  baseDepth: number,
  label: string,
) {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: baseDepth, value }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH) {
      notionImportPayloadTooLarge(
        `${label} exceeds JSON depth ${NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH}`,
      );
    }
    budget.nodes += 1;
    if (budget.nodes > NOTION_IMPORT_REQUEST_JSON_MAX_NODES) {
      notionImportPayloadTooLarge(
        `${label} exceeds ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
      );
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      if (
        current.value.length
          > NOTION_IMPORT_REQUEST_JSON_MAX_NODES - budget.nodes - stack.length
      ) {
        notionImportPayloadTooLarge(
          `${label} exceeds ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
        );
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ depth: current.depth + 1, value: current.value[index] });
      }
      continue;
    }
    const record = current.value as Record<string, unknown>;
    let childCount = 0;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      childCount += 1;
      if (
        childCount
          > NOTION_IMPORT_REQUEST_JSON_MAX_NODES - budget.nodes - stack.length
      ) {
        notionImportPayloadTooLarge(
          `${label} exceeds ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
        );
      }
      stack.push({ depth: current.depth + 1, value: record[key] });
    }
  }
}

export function assertNotionImportRequestJsonShape(value: unknown) {
  assertNotionImportJsonShape(value, { nodes: 0 }, 0, 'request');
}

export function boundedUtf8Bytes(value: string, maxBytes: number, label: string) {
  // Every UTF-16 code unit needs at least one UTF-8 byte. Avoid allocating an
  // encoded copy when the inexpensive lower bound already exceeds the cap.
  if (value.length > maxBytes) notionImportPayloadTooLarge(`${label} exceeds ${maxBytes} bytes`);
  const bytes = notionImportUtf8Encoder.encode(value).byteLength;
  if (bytes > maxBytes) notionImportPayloadTooLarge(`${label} exceeds ${maxBytes} bytes`);
  return bytes;
}

export function assertBoundedSnapshotJsonValue(
  value: unknown,
  budget: NotionImportRequestJsonBudget,
  label: string,
) {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  const seen = new Set<object>();
  let itemBytes = 0;
  const charge = (bytes: number) => {
    itemBytes += bytes;
    budget.bytes += bytes;
    if (itemBytes > NOTION_IMPORT_SNAPSHOT_ITEM_MAX_BYTES) {
      notionImportPayloadTooLarge(
        `${label} exceeds ${NOTION_IMPORT_SNAPSHOT_ITEM_MAX_BYTES} estimated JSON bytes`,
      );
    }
    if (budget.bytes > NOTION_IMPORT_SNAPSHOT_AGGREGATE_MAX_BYTES) {
      notionImportPayloadTooLarge(
        `snapshotItems exceed ${NOTION_IMPORT_SNAPSHOT_AGGREGATE_MAX_BYTES} estimated JSON bytes`,
      );
    }
  };
  const chargeString = (text: string, overhead: number) => {
    const itemRemaining = NOTION_IMPORT_SNAPSHOT_ITEM_MAX_BYTES - itemBytes - overhead;
    const aggregateRemaining =
      NOTION_IMPORT_SNAPSHOT_AGGREGATE_MAX_BYTES - budget.bytes - overhead;
    if (text.length > itemRemaining) {
      notionImportPayloadTooLarge(
        `${label} exceeds ${NOTION_IMPORT_SNAPSHOT_ITEM_MAX_BYTES} estimated JSON bytes`,
      );
    }
    if (text.length > aggregateRemaining) {
      notionImportPayloadTooLarge(
        `snapshotItems exceed ${NOTION_IMPORT_SNAPSHOT_AGGREGATE_MAX_BYTES} estimated JSON bytes`,
      );
    }
    const bytes = notionImportUtf8Encoder.encode(text).byteLength;
    if (bytes > itemRemaining) {
      notionImportPayloadTooLarge(
        `${label} exceeds ${NOTION_IMPORT_SNAPSHOT_ITEM_MAX_BYTES} estimated JSON bytes`,
      );
    }
    if (bytes > aggregateRemaining) {
      notionImportPayloadTooLarge(
        `snapshotItems exceed ${NOTION_IMPORT_SNAPSHOT_AGGREGATE_MAX_BYTES} estimated JSON bytes`,
      );
    }
    charge(bytes + overhead);
  };

  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH) {
      notionImportPayloadTooLarge(
        `${label} exceeds JSON depth ${NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH}`,
      );
    }
    budget.nodes += 1;
    if (budget.nodes > NOTION_IMPORT_REQUEST_JSON_MAX_NODES) {
      notionImportPayloadTooLarge(
        `snapshotItems exceed ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
      );
    }

    const candidate = current.value;
    if (candidate === null) {
      charge(4);
      continue;
    }
    if (typeof candidate === 'string') {
      chargeString(candidate, 2);
      continue;
    }
    if (typeof candidate === 'number') {
      charge(Number.isFinite(candidate) ? String(candidate).length : 4);
      continue;
    }
    if (typeof candidate === 'boolean') {
      charge(candidate ? 4 : 5);
      continue;
    }
    if (typeof candidate !== 'object') {
      charge(4);
      continue;
    }
    if (seen.has(candidate)) {
      notionImportPayloadTooLarge(`${label} contains a cyclic or aliased object graph`);
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      charge(2 + Math.max(0, candidate.length - 1));
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        stack.push({ depth: current.depth + 1, value: candidate[index] });
      }
      continue;
    }
    const entries = Object.entries(candidate as Record<string, unknown>);
    charge(2 + Math.max(0, entries.length - 1));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      chargeString(key, 3);
      stack.push({ depth: current.depth + 1, value: child });
    }
  }
}

function assertOptionalSnapshotString(value: unknown, maxBytes: number, label: string) {
  if (typeof value === 'string') boundedUtf8Bytes(value, maxBytes, label);
}

export function parseSnapshotItems(value: unknown): DiscoveredNotionItem[] {
  if (!Array.isArray(value)) return [];
  if (value.length > NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX) {
    notionImportPayloadTooLarge(
      `snapshotItems has more than ${NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX} entries`,
    );
  }
  const budget: NotionImportRequestJsonBudget = { bytes: 0, nodes: 0 };
  return value
    .map((item, index): DiscoveredNotionItem | null => {
      assertBoundedSnapshotJsonValue(item, budget, `snapshotItems[${index}]`);
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      assertOptionalSnapshotString(record.notionId ?? record.id, 512, `snapshotItems[${index}].notionId`);
      assertOptionalSnapshotString(record.notionObject ?? record.object, 128, `snapshotItems[${index}].notionObject`);
      assertOptionalSnapshotString(record.parentNotionId, 512, `snapshotItems[${index}].parentNotionId`);
      assertOptionalSnapshotString(record.title, 64 * 1024, `snapshotItems[${index}].title`);
      assertOptionalSnapshotString(record.status, 128, `snapshotItems[${index}].status`);
      assertOptionalSnapshotString(record.phase, 128, `snapshotItems[${index}].phase`);
      assertOptionalSnapshotString(record.error, 64 * 1024, `snapshotItems[${index}].error`);
      const notionId = optionalString(record.notionId ?? record.id);
      const notionObject = optionalString(record.notionObject ?? record.object);
      if (!notionId || !notionObject) return null;
      const metadata = record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : {};
      return {
        notionId,
        notionObject,
        parentNotionId: optionalString(record.parentNotionId),
        title: optionalString(record.title),
        status: optionalString(record.status) ?? 'discovered',
        phase: optionalString(record.phase) ?? 'snapshot',
        metadata,
        error: optionalString(record.error),
      };
    })
    .filter((item): item is DiscoveredNotionItem => !!item);
}
