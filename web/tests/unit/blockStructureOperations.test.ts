import { describe, expect, it } from "vitest";
import { sanitizeBlockStructureOperation } from "@/lib/blockStructureOperations";

const block = (overrides: Record<string, unknown> = {}) => ({
  id: "b1",
  pageId: "p1",
  position: 1,
  ...overrides,
});

const op = (overrides: Record<string, unknown> = {}) => ({
  engine: "block_structure",
  schemaVersion: 1,
  action: "move",
  blockIds: ["b1"],
  before: [block()],
  after: [block({ parentId: "b0", position: 2 })],
  ...overrides,
});

describe("sanitizeBlockStructureOperation", () => {
  it("accepts a well-formed move operation", () => {
    const parsed = sanitizeBlockStructureOperation(op());
    expect(parsed).toBeDefined();
    expect(parsed?.action).toBe("move");
    expect(parsed?.after?.[0]).toMatchObject({ id: "b1", pageId: "p1", parentId: "b0", position: 2 });
  });

  it("keeps optional block fields (type/content/plainText/updatedAt)", () => {
    const parsed = sanitizeBlockStructureOperation(
      op({
        action: "create",
        before: [],
        after: [
          block({
            type: "to_do",
            content: { rich: [{ text: "hi" }], checked: false },
            plainText: "hi",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      })
    );
    expect(parsed?.after?.[0]).toMatchObject({
      type: "to_do",
      plainText: "hi",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed?.after?.[0]?.content).toEqual({ rich: [{ text: "hi" }], checked: false });
  });

  it("rejects wrong engine, unknown action, and non-object input", () => {
    expect(sanitizeBlockStructureOperation(op({ engine: "yjs" }))).toBeUndefined();
    expect(sanitizeBlockStructureOperation(op({ action: "explode" }))).toBeUndefined();
    expect(sanitizeBlockStructureOperation(null)).toBeUndefined();
    expect(sanitizeBlockStructureOperation("move")).toBeUndefined();
  });

  it("rejects malformed block snapshots", () => {
    expect(sanitizeBlockStructureOperation(op({ after: [block({ id: 42 })] }))).toBeUndefined();
    expect(sanitizeBlockStructureOperation(op({ after: [block({ pageId: "" })] }))).toBeUndefined();
    expect(
      sanitizeBlockStructureOperation(op({ after: [block({ position: Number.NaN })] }))
    ).toBeUndefined();
    expect(sanitizeBlockStructureOperation(op({ before: "nope" }))).toBeUndefined();
  });

  it("rejects an operation with no blocks on either side", () => {
    expect(sanitizeBlockStructureOperation(op({ before: [], after: [] }))).toBeUndefined();
  });

  it("filters non-string blockIds and treats missing arrays as empty", () => {
    const parsed = sanitizeBlockStructureOperation(
      op({ blockIds: ["b1", 7, "", null], before: undefined })
    );
    expect(parsed?.blockIds).toEqual(["b1"]);
    expect(parsed?.before).toEqual([]);
  });

  it("rejects oversized snapshot arrays", () => {
    const many = Array.from({ length: 501 }, (_, index) => block({ id: `b${index}` }));
    expect(sanitizeBlockStructureOperation(op({ after: many }))).toBeUndefined();
  });
});
