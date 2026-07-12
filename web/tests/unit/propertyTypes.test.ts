import { describe, expect, it } from "vitest";
import type { PropertyType } from "@/lib/types";
import {
  CREATABLE_PROPERTY_TYPES,
  PROPERTY_TYPES,
  configForType,
  propertyTypeLabel,
} from "@/components/database/propertyTypes";

describe("PROPERTY_TYPES", () => {
  it("has unique types", () => {
    const types = PROPERTY_TYPES.map((item) => item.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("exposes all creatable types", () => {
    expect(CREATABLE_PROPERTY_TYPES).toBe(PROPERTY_TYPES);
  });
});

describe("propertyTypeLabel", () => {
  it("returns the display label for known types", () => {
    expect(propertyTypeLabel("rich_text")).toBe("Text");
    expect(propertyTypeLabel("multi_select")).toBe("Multi-select");
    expect(propertyTypeLabel("unique_id")).toBe("ID");
  });

  it("echoes unknown types", () => {
    expect(propertyTypeLabel("mystery" as PropertyType)).toBe("mystery");
  });
});

describe("configForType", () => {
  it("keeps options for select-like types (defaulting to [])", () => {
    expect(configForType("select", undefined, "db")).toEqual({ options: [] });
    const options = [{ id: "o1", name: "One", color: "red" }];
    expect(configForType("multi_select", { options }, "db")).toEqual({ options });
    expect(configForType("status", { options }, "db")).toEqual({ options });
  });

  it("keeps/derives the number format", () => {
    expect(configForType("number", undefined, "db")).toEqual({ numberFormat: "number" });
    expect(configForType("number", { numberFormat: "won" }, "db")).toEqual({
      numberFormat: "won",
    });
  });

  it("defaults relation target to the owning database", () => {
    expect(configForType("relation", undefined, "db1")).toEqual({
      relationDatabaseId: "db1",
    });
    expect(configForType("relation", { relationDatabaseId: "other" }, "db1")).toEqual({
      relationDatabaseId: "other",
    });
  });

  it("keeps rollup wiring and defaults the function", () => {
    expect(
      configForType(
        "rollup",
        { rollupRelationPropertyId: "r", rollupTargetPropertyId: "t" },
        "db"
      )
    ).toEqual({
      rollupRelationPropertyId: "r",
      rollupTargetPropertyId: "t",
      rollupFunction: "show_original",
    });
  });

  it("keeps the formula expression (defaulting to empty)", () => {
    expect(configForType("formula", undefined, "db")).toEqual({ formula: "" });
    expect(configForType("formula", { formula: "1 + 1" }, "db")).toEqual({
      formula: "1 + 1",
    });
  });

  it("returns undefined for plain types without display flags", () => {
    expect(configForType("rich_text", undefined, "db")).toBeUndefined();
    expect(configForType("checkbox", { options: [] }, "db")).toBeUndefined();
  });

  it("carries display flags across type changes", () => {
    expect(configForType("rich_text", { hideWhenEmpty: true }, "db")).toEqual({
      hideWhenEmpty: true,
    });
    expect(
      configForType("number", { hideInPagePanel: false, numberFormat: "comma" }, "db")
    ).toEqual({ numberFormat: "comma", hideInPagePanel: false });
  });
});
