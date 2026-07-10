import { describe, expect, it } from "vitest";
import type { DbProperty, Page } from "@/lib/types";
import {
  backendComputedText,
  backendComputedValue,
} from "@/components/database/computed";

const prop = (id: string, type: DbProperty["type"]): DbProperty =>
  ({ id, databaseId: "db", name: id, type, position: 0 }) as DbProperty;

const row = (computed?: Page["__computed"]): Page =>
  ({
    id: "r",
    workspaceId: "ws",
    parentType: "page",
    kind: "database_row",
    title: "Row",
    iconType: "emoji",
    position: 0,
    __computed: computed,
  }) as Page;

describe("backendComputedText", () => {
  it("returns the formatted backend value for formula/rollup props", () => {
    const page = row({ f1: { value: 42, formatted: "42" } });
    expect(backendComputedText(page, prop("f1", "formula"))).toBe("42");
    expect(backendComputedText(page, prop("f1", "rollup"))).toBe("42");
  });

  it("returns undefined for other property types", () => {
    const page = row({ n1: { value: 1, formatted: "1" } });
    expect(backendComputedText(page, prop("n1", "number"))).toBeUndefined();
  });

  it("returns undefined when no computed entry exists", () => {
    expect(backendComputedText(row(), prop("f1", "formula"))).toBeUndefined();
    expect(backendComputedText(row({}), prop("f1", "formula"))).toBeUndefined();
  });

  it("stringifies non-string formatted values and maps null to empty", () => {
    expect(
      backendComputedText(row({ f1: { value: 1, formatted: 7 as unknown as string } }), prop("f1", "formula"))
    ).toBe("7");
    expect(
      backendComputedText(row({ f1: { value: null, formatted: null as unknown as string } }), prop("f1", "formula"))
    ).toBe("");
  });
});

describe("backendComputedValue", () => {
  it("returns the raw backend value for formula/rollup props only", () => {
    const page = row({ f1: { value: 42, formatted: "42" } });
    expect(backendComputedValue(page, prop("f1", "formula"))).toBe(42);
    expect(backendComputedValue(page, prop("f1", "number"))).toBeUndefined();
    expect(backendComputedValue(row(), prop("f1", "rollup"))).toBeUndefined();
  });
});
