import type { OutboxEntry } from "./outbox";
import type { Block, Page } from "./types";

/** Deterministic optimistic projection of durable outbox entries over cached entities. */
function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Merge still-queued outbox page patches over a cached page list. */
export function overlayOutboxOnPages(entries: OutboxEntry[], pages: Page[]): Page[] {
  if (!entries.length) return pages;
  const byId = new Map(pages.map((page) => [page.id, page]));
  for (const entry of entries) {
    const op = entry.value;
    if (op.kind === "remote_call") {
      const createdPage =
        op.effect?.kind === "database_create"
          ? op.effect.page
          : op.fn === "createPageRemote" && recordValue(op.args[0])
            ? (op.args[0] as Page)
            : undefined;
      if (createdPage && !byId.has(createdPage.id)) byId.set(createdPage.id, createdPage);
      if (op.effect?.kind === "row_file_remove") {
        const current = byId.get(op.effect.rowId);
        if (current) {
          byId.set(current.id, {
            ...current,
            properties: {
              ...(current.properties ?? {}),
              [op.effect.propertyId]: op.effect.nextValue,
            },
          });
        }
      }
      continue;
    }
    if (op.kind === "page_update") {
      const current = byId.get(op.id);
      if (current) byId.set(op.id, { ...current, ...op.patch });
    }
  }
  return Array.from(byId.values());
}

export function overlayOutboxOnBlocks(entries: OutboxEntry[], pageId: string, blocks: Block[]): Block[] {
  if (!entries.length) return blocks;
  let next = blocks;
  for (const entry of entries) {
    const op = entry.value;
    if (op.kind === "block_update") {
      next = next.map((block) => (block.id === op.id ? { ...block, ...op.patch } : block));
    } else if (op.kind === "block_create" && op.block.pageId === pageId) {
      if (!next.some((block) => block.id === op.block.id)) next = [...next, op.block];
    } else if (op.kind === "block_delete") {
      const ids = new Set(op.ids);
      next = next.filter((block) => !ids.has(block.id));
    } else if (op.kind === "remote_call" && op.fn === "createBlocksRemote") {
      // Composite paste/replace/column/tab creation is queued as one durable
      // batch. Overlay that batch during an offline reload just like individual
      // block_create entries; otherwise the data is safe on disk but appears
      // to vanish until reconnect, violating the local-first no-loss contract.
      const batch = Array.isArray(op.args[0]) ? op.args[0] : [];
      for (const candidate of batch) {
        if (!candidate || typeof candidate !== "object") continue;
        const block = candidate as Block;
        if (block.pageId !== pageId || typeof block.id !== "string") continue;
        const index = next.findIndex((current) => current.id === block.id);
        if (index >= 0) {
          next = next.map((current, currentIndex) => (currentIndex === index ? block : current));
        } else {
          next = [...next, block];
        }
      }
    }
  }
  return next.slice().sort((left, right) => left.position - right.position);
}
