import type { DbProperty, Page } from "@/lib/types";

export function backendComputedText(row: Page, prop: DbProperty): string | undefined {
  if (prop.type !== "formula" && prop.type !== "rollup") return undefined;
  const value = row.__computed?.[prop.id]?.formatted;
  return value === undefined ? undefined : String(value ?? "");
}

export function backendComputedValue(row: Page, prop: DbProperty): unknown {
  if (prop.type !== "formula" && prop.type !== "rollup") return undefined;
  return row.__computed?.[prop.id]?.value;
}
