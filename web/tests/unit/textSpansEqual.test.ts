import { describe, expect, it } from "vitest";
import { textSpansEqual } from "@/lib/textOperations";
import type { TextSpan } from "@/lib/types";

describe("textSpansEqual", () => {
  it("treats identical spans as equal", () => {
    const a: TextSpan[] = [{ text: "hello" }];
    expect(textSpansEqual(a, [{ text: "hello" }])).toBe(true);
  });

  it("ignores representation differences (adjacent same-mark runs, empty spans)", () => {
    expect(textSpansEqual([{ text: "ab" }], [{ text: "a" }, { text: "b" }])).toBe(true);
    expect(textSpansEqual([{ text: "ab" }], [{ text: "" }, { text: "ab" }])).toBe(true);
  });

  it("detects a formatting-only change (same text, different marks)", () => {
    const plain: TextSpan[] = [{ text: "hello" }];
    const bold: TextSpan[] = [{ text: "hello", bold: true }];
    expect(textSpansEqual(plain, bold)).toBe(false);
  });

  it("detects a partial-run formatting change", () => {
    const plain: TextSpan[] = [{ text: "hello world" }];
    const partial: TextSpan[] = [{ text: "hello " }, { text: "world", italic: true }];
    expect(textSpansEqual(plain, partial)).toBe(false);
  });

  it("detects link and color changes", () => {
    expect(textSpansEqual([{ text: "x" }], [{ text: "x", link: "https://a" }])).toBe(false);
    expect(textSpansEqual([{ text: "x", color: "red" }], [{ text: "x", color: "blue" }])).toBe(false);
  });

  it("handles empty / undefined inputs", () => {
    expect(textSpansEqual(undefined, [])).toBe(true);
    expect(textSpansEqual([], undefined)).toBe(true);
    expect(textSpansEqual(undefined, [{ text: "x" }])).toBe(false);
  });
});
