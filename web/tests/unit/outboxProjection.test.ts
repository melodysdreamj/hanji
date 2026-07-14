import { describe, expect, it } from "vitest";
import { overlayOutboxOnBlocks, overlayOutboxOnPages } from "@/lib/outboxProjection";
import type { OutboxEntry, OutboxOp } from "@/lib/outbox";
import type { Block, Page } from "@/lib/types";

function entry(value: OutboxOp, entryKey = "test"): OutboxEntry {
  return { entryKey, tabId: "tab", updatedAt: 1, value };
}

function page(id: string, title = id): Page {
  return { id, title, properties: {} } as Page;
}

function block(id: string, pageId: string, position: number): Block {
  return { id, pageId, position, type: "paragraph", content: { rich: [] } } as unknown as Block;
}

describe("outbox cache projection", () => {
  it("projects page updates, creates and row-file effects without mutating the cache input", () => {
    const cached = [page("page-1", "Before"), page("row-1", "Row")];
    const created = page("page-2", "Created");
    const projected = overlayOutboxOnPages(
      [
        entry({ id: "page-1", kind: "page_update", patch: { title: "After" }, target: "page" }),
        entry({ args: [created], fn: "createPageRemote", kind: "remote_call" }),
        entry({
          args: [],
          effect: {
            databaseId: "db-1",
            kind: "row_file_remove",
            nextValue: [],
            previousValue: ["old"],
            propertyId: "files",
            removedIndex: 0,
            removedItem: "old",
            rowId: "row-1",
          },
          fn: "updateDatabaseRowRemote",
          kind: "remote_call",
        }),
      ],
      cached
    );

    expect(projected.map((item) => item.id)).toEqual(["page-1", "row-1", "page-2"]);
    expect(projected[0]?.title).toBe("After");
    expect(projected[1]?.properties?.files).toEqual([]);
    expect(cached[0]?.title).toBe("Before");
  });

  it("projects serialized block generations and returns position order", () => {
    const projected = overlayOutboxOnBlocks(
      [
        entry({ id: "b1", kind: "block_update", patch: { plainText: "After" } }),
        entry({ block: block("b3", "p1", 3), kind: "block_create" }),
        entry({ hintPageId: "p1", ids: ["b2"], kind: "block_delete" }),
        entry({
          args: [[block("b0", "p1", 0)]],
          fn: "createBlocksRemote",
          kind: "remote_call",
        }),
      ],
      "p1",
      [block("b1", "p1", 1), block("b2", "p1", 2)]
    );

    expect(projected.map((item) => item.id)).toEqual(["b0", "b1", "b3"]);
    expect(projected.find((item) => item.id === "b1")?.plainText).toBe("After");
  });
});
