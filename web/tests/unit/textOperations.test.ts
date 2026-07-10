import { describe, expect, it } from "vitest";
import type { TextSpan } from "@/lib/types";
import {
  applyTextOperationToSpans,
  createTextOperation,
  sanitizeTextSpanOperation,
  sanitizeTextSpans,
  type TextSpanOperation,
} from "@/lib/textOperations";

const span = (text: string, marks: Partial<TextSpan> = {}): TextSpan => ({
  text,
  ...marks,
});

describe("sanitizeTextSpans", () => {
  it("returns undefined for non-arrays", () => {
    expect(sanitizeTextSpans(undefined)).toBeUndefined();
    expect(sanitizeTextSpans("hello")).toBeUndefined();
    expect(sanitizeTextSpans({ text: "x" })).toBeUndefined();
  });

  it("keeps only valid spans and known mark fields", () => {
    const result = sanitizeTextSpans([
      { text: "a", bold: true, italic: "yes", junk: 1 },
      { text: 42 },
      null,
      { text: "b", mention: "page", pageId: "p1" },
      { text: "c", mention: "invalid" },
    ]);
    expect(result).toEqual([
      { text: "a", bold: true },
      { text: "b", mention: "page", pageId: "p1" },
      { text: "c" },
    ]);
  });

  it("keeps false boolean marks off instead of copying them", () => {
    expect(sanitizeTextSpans([{ text: "a", bold: false }])).toEqual([{ text: "a" }]);
  });

  it("accepts an empty array", () => {
    expect(sanitizeTextSpans([])).toEqual([]);
  });

  it("caps the number of spans at 1000", () => {
    const many = Array.from({ length: 1200 }, () => ({ text: "x" }));
    expect(sanitizeTextSpans(many)).toHaveLength(1000);
  });

  it("caps span text length at 20000 chars", () => {
    const result = sanitizeTextSpans([{ text: "x".repeat(30_000) }]);
    expect(result?.[0].text).toHaveLength(20_000);
  });
});

describe("createTextOperation", () => {
  it("returns undefined when nothing changed", () => {
    expect(createTextOperation([span("abc")], [span("abc")])).toBeUndefined();
  });

  it("describes a pure insertion", () => {
    const op = createTextOperation([span("hello world")], [span("hello brave world")]);
    expect(op).toBeDefined();
    expect(op?.start).toBe(6);
    expect(op?.deleteCount).toBe(0);
    expect(op?.deletedText).toBe("");
    expect(op?.insert.map((s) => s.text).join("")).toBe("brave ");
  });

  it("describes a pure deletion", () => {
    const op = createTextOperation([span("hello brave world")], [span("hello world")]);
    expect(op?.deleteCount).toBe(6);
    expect(op?.deletedText).toBe("brave ");
    expect(op?.insert).toEqual([]);
  });

  it("describes a replacement with prefix/suffix context", () => {
    const before = "The quick brown fox jumps over the lazy dog";
    const op = createTextOperation(
      [span(before)],
      [span("The quick red fox jumps over the lazy dog")]
    );
    expect(op?.deletedText).toBe("brown");
    expect(op?.insert.map((s) => s.text).join("")).toBe("red");
    expect(op?.prefixContext).toBe("The quick ");
    expect(before.startsWith(op!.prefixContext + op!.deletedText)).toBe(true);
  });

  it("preserves marks on inserted spans", () => {
    const op = createTextOperation(
      [span("ab")],
      [span("a"), span("X", { bold: true }), span("b")]
    );
    expect(op?.insert).toEqual([{ text: "X", bold: true }]);
  });

  it("handles Korean text", () => {
    const op = createTextOperation([span("안녕하세요")], [span("안녕히 가세요")]);
    expect(op).toBeDefined();
    expect(op?.afterText).toBe("안녕히 가세요");
    // Applying the op to the original spans yields the after text.
    const applied = applyTextOperationToSpans([span("안녕하세요")], op!);
    expect(applied?.map((s) => s.text).join("")).toBe("안녕히 가세요");
  });

  it("handles empty before spans", () => {
    const op = createTextOperation([], [span("new")]);
    expect(op?.start).toBe(0);
    expect(op?.insert).toEqual([{ text: "new" }]);
  });
});

describe("sanitizeTextSpanOperation", () => {
  it("rejects non-objects and missing numeric fields", () => {
    expect(sanitizeTextSpanOperation(null)).toBeUndefined();
    expect(sanitizeTextSpanOperation("x")).toBeUndefined();
    expect(sanitizeTextSpanOperation({ start: "0", deleteCount: 0, insert: [] })).toBeUndefined();
    expect(sanitizeTextSpanOperation({ start: Infinity, deleteCount: 0, insert: [] })).toBeUndefined();
    expect(sanitizeTextSpanOperation({ start: 0, deleteCount: 0 })).toBeUndefined();
  });

  it("clamps negative and fractional start/deleteCount", () => {
    const op = sanitizeTextSpanOperation({
      start: -3.7,
      deleteCount: 2.9,
      insert: [{ text: "a" }],
    });
    expect(op?.start).toBe(0);
    expect(op?.deleteCount).toBe(2);
    expect(op?.insert).toEqual([{ text: "a" }]);
  });

  it("defaults string fields to empty strings", () => {
    const op = sanitizeTextSpanOperation({ start: 1, deleteCount: 0, insert: [] });
    expect(op).toMatchObject({
      beforeText: "",
      afterText: "",
      deletedText: "",
      prefixContext: "",
      suffixContext: "",
    });
  });
});

describe("applyTextOperationToSpans", () => {
  const makeOp = (before: TextSpan[], after: TextSpan[]): TextSpanOperation =>
    createTextOperation(before, after)!;

  it("applies an operation to the exact source text", () => {
    const before = [span("hello world")];
    const op = makeOp(before, [span("hello there world")]);
    const applied = applyTextOperationToSpans(before, op);
    expect(applied?.map((s) => s.text).join("")).toBe("hello there world");
  });

  it("re-anchors via context when the document drifted", () => {
    const op = makeOp([span("hello world")], [span("hello brave world")]);
    // Same neighborhood, extra prefix before it.
    const drifted = [span("intro. hello world")];
    const applied = applyTextOperationToSpans(drifted, op);
    expect(applied?.map((s) => s.text).join("")).toBe("intro. hello brave world");
  });

  it("returns null when the deleted text no longer matches", () => {
    const op: TextSpanOperation = {
      afterText: "",
      beforeText: "abcdef",
      deleteCount: 3,
      deletedText: "bcd",
      insert: [],
      prefixContext: "a",
      start: 1,
      suffixContext: "ef",
    };
    expect(applyTextOperationToSpans([span("azzzef")], op)).toBeNull();
  });

  it("returns null when no anchor can be found", () => {
    const op = makeOp([span("hello world")], [span("hello brave world")]);
    expect(applyTextOperationToSpans([span("completely different")], op)).toBeNull();
  });

  it("preserves surrounding marks when splicing", () => {
    const before = [span("bold", { bold: true }), span(" tail")];
    const op = makeOp(before, [span("bold", { bold: true }), span(" new tail")]);
    const applied = applyTextOperationToSpans(before, op);
    expect(applied).toEqual([
      { text: "bold", bold: true },
      { text: " new tail" },
    ]);
  });
});
