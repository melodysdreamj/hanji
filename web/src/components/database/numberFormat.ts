import type { DbProperty, PropertyConfig } from "@/lib/types";

export type NumberFormat = NonNullable<PropertyConfig["numberFormat"]>;
const KNOWN_NUMBER_FORMATS = new Set<NumberFormat>([
  "number",
  "comma",
  "percent",
  "dollar",
  "won",
  "euro",
]);

export const NUMBER_FORMATS: { value: NumberFormat; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "comma", label: "Number with commas" },
  { value: "percent", label: "Percent" },
  { value: "dollar", label: "Dollar" },
  { value: "won", label: "Won" },
  { value: "euro", label: "Euro" },
];

export function normalizeNumberFormat(value: unknown): NumberFormat | undefined {
  if (typeof value !== "string") return undefined;
  const format = value.trim();
  if (!format) return undefined;
  if (format === "number_with_commas") return "comma";
  if (KNOWN_NUMBER_FORMATS.has(format as NumberFormat)) return format as NumberFormat;
  return undefined;
}

export function numberFormatForProperty(prop: Pick<DbProperty, "config">): NumberFormat {
  const config = prop.config;
  return (
    normalizeNumberFormat(config?.numberFormat) ??
    normalizeNumberFormat(config?.notion?.number?.format) ??
    "number"
  );
}

function compactNumber(n: number) {
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

export function formatNumberValue(value: unknown, format: NumberFormat = "number") {
  if (value == null) return "";
  if (typeof value === "string" && value.trim() === "") return "";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  if (format === "number") return compactNumber(n);
  if (format === "comma") {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(n);
  }
  if (format === "percent") {
    // The stored value is the human-facing percentage (50 -> "50%"), so divide
    // by 100 before handing it to Intl's percent style (which multiplies by 100).
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(n / 100);
  }
  if (format === "won") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "KRW",
      maximumFractionDigits: 0,
    }).format(n);
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: format === "euro" ? "EUR" : "USD",
    maximumFractionDigits: 2,
  }).format(n);
}
