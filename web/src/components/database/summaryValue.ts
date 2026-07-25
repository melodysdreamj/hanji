import { pageDisplayTitle } from "@/lib/pageTitle";
import type { DbProperty, Page } from "@/lib/types";
import { backendComputedValue } from "./computed";
import { evaluateFormula, formatFormulaValue } from "./formula";
import { normalizeFileAttachments } from "./files";
import { formatNotionTimestamp } from "./dateUtils";
import { normalizePersonIds, personLabel } from "./people";
import { valueAsIds } from "./rollup";

export function effectiveSummaryValue(
  row: Page,
  prop: DbProperty,
  props: DbProperty[],
  pagesById: Record<string, Page>
): unknown {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "created_by") return row.createdBy;
  if (prop.type === "last_edited_by") return row.lastEditedBy;
  if (prop.type === "formula") {
    const computed = backendComputedValue(row, prop);
    if (computed !== undefined) return computed;
    return evaluateFormula({ row, prop, props, pagesById });
  }
  if (prop.type === "rollup") {
    const computed = backendComputedValue(row, prop);
    if (computed !== undefined) return computed;
  }
  return row.properties?.[prop.id];
}

export function displaySummaryValue(
  value: unknown,
  prop: DbProperty,
  pagesById: Record<string, Page>
): string | string[] {
  if (prop.type === "select" || prop.type === "status") {
    const id = value ? String(value) : "";
    return prop.config?.options?.find((option) => option.id === id)?.name ?? id;
  }
  if (prop.type === "multi_select") {
    return valueAsIds(value).map(
      (id) => prop.config?.options?.find((option) => option.id === id)?.name ?? id
    );
  }
  if (prop.type === "relation") {
    return valueAsIds(value).map((id) => pageDisplayTitle(pagesById[id]));
  }
  if (prop.type === "files") {
    return normalizeFileAttachments(value).map((file) => file.name);
  }
  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    return normalizePersonIds(value).map((id) => personLabel(id));
  }
  if (prop.type === "created_time" || prop.type === "last_edited_time") {
    return formatNotionTimestamp(value);
  }
  if (prop.type === "formula") return formatFormulaValue(value as ReturnType<typeof evaluateFormula>);
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return "";
  return String(value);
}

export function summaryValuePieces(
  value: unknown,
  prop: DbProperty,
  pagesById: Record<string, Page>
) {
  const display = displaySummaryValue(value, prop, pagesById);
  const parts = Array.isArray(display) ? display : [display];
  return parts.map((part) => String(part).trim()).filter(Boolean);
}

export function summaryValuePresent(
  value: unknown,
  prop: DbProperty,
  pagesById: Record<string, Page>
) {
  return summaryValuePieces(value, prop, pagesById).length > 0;
}
