import { describe, expect, it } from "vitest";
import {
  NUMBER_FORMATS,
  formatNumberValue,
  normalizeNumberFormat,
  numberFormatForProperty,
} from "@/components/database/numberFormat";

describe("normalizeNumberFormat", () => {
  it("accepts known formats", () => {
    expect(normalizeNumberFormat("number")).toBe("number");
    expect(normalizeNumberFormat("comma")).toBe("comma");
    expect(normalizeNumberFormat("percent")).toBe("percent");
    expect(normalizeNumberFormat("dollar")).toBe("dollar");
    expect(normalizeNumberFormat("won")).toBe("won");
    expect(normalizeNumberFormat("euro")).toBe("euro");
  });

  it("maps the Notion alias number_with_commas to comma", () => {
    expect(normalizeNumberFormat("number_with_commas")).toBe("comma");
  });

  it("rejects unknown and non-string values", () => {
    expect(normalizeNumberFormat("yen")).toBeUndefined();
    expect(normalizeNumberFormat("")).toBeUndefined();
    expect(normalizeNumberFormat("  ")).toBeUndefined();
    expect(normalizeNumberFormat(42)).toBeUndefined();
    expect(normalizeNumberFormat(undefined)).toBeUndefined();
  });
});

describe("numberFormatForProperty", () => {
  it("prefers config.numberFormat", () => {
    expect(numberFormatForProperty({ config: { numberFormat: "won" } })).toBe("won");
  });

  it("falls back to the imported Notion format", () => {
    expect(
      numberFormatForProperty({ config: { notion: { number: { format: "percent" } } } })
    ).toBe("percent");
    expect(
      numberFormatForProperty({
        config: { notion: { number: { format: "number_with_commas" } } },
      })
    ).toBe("comma");
  });

  it("defaults to plain number", () => {
    expect(numberFormatForProperty({ config: undefined })).toBe("number");
    expect(numberFormatForProperty({ config: {} })).toBe("number");
  });
});

describe("formatNumberValue", () => {
  it("returns empty string for empty and non-numeric values", () => {
    expect(formatNumberValue(null)).toBe("");
    expect(formatNumberValue(undefined)).toBe("");
    expect(formatNumberValue("")).toBe("");
    expect(formatNumberValue("   ")).toBe("");
    expect(formatNumberValue("abc")).toBe("");
    expect(formatNumberValue(NaN)).toBe("");
    expect(formatNumberValue(Infinity)).toBe("");
  });

  it("formats plain numbers compactly", () => {
    expect(formatNumberValue(42)).toBe("42");
    expect(formatNumberValue(-3.5)).toBe("-3.5");
    expect(formatNumberValue("12.50")).toBe("12.5");
    expect(formatNumberValue(0)).toBe("0");
  });

  it("rounds long fractions to 6 places in plain format", () => {
    expect(formatNumberValue(1 / 3)).toBe("0.333333");
  });

  it("formats with thousands separators", () => {
    expect(formatNumberValue(1234567, "comma")).toBe(
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(1234567)
    );
  });

  it("treats the stored value as a human-facing percentage", () => {
    expect(formatNumberValue(50, "percent")).toBe(
      new Intl.NumberFormat(undefined, {
        style: "percent",
        maximumFractionDigits: 2,
      }).format(0.5)
    );
  });

  it("formats currencies", () => {
    expect(formatNumberValue(1000, "dollar")).toBe(
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(1000)
    );
    expect(formatNumberValue(1000, "won")).toBe(
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "KRW",
        maximumFractionDigits: 0,
      }).format(1000)
    );
    expect(formatNumberValue(1000, "euro")).toBe(
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 2,
      }).format(1000)
    );
  });

  it("accepts numeric strings", () => {
    expect(formatNumberValue("42", "dollar")).toContain("42");
  });
});

describe("NUMBER_FORMATS", () => {
  it("lists every known format exactly once", () => {
    const values = NUMBER_FORMATS.map((item) => item.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(["number", "comma", "percent", "dollar", "won", "euro"]);
  });
});
