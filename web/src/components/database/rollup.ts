import { pageDisplayTitle } from "@/lib/pageTitle";
import type { DbProperty, Page } from "@/lib/types";
import { formatDateForProperty, formatNotionTimestamp } from "./dateUtils";
import { normalizeFileAttachments } from "./files";
import { formatNumberValue, numberFormatForProperty } from "./numberFormat";
import { normalizePersonIds, personLabel } from "./people";
import {
  evaluateRollup as evaluateRollupCore,
  valueAsIds as coreValueAsIds,
  type RollupContext,
  type RollupPage,
  type RollupProperty,
} from "../../../../shared/database/rollup-core";

export function valueAsIds(value: unknown): string[] {
  return coreValueAsIds(value);
}

function rawValue(row: Page, prop: DbProperty): unknown {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "created_by") return row.createdBy;
  if (prop.type === "last_edited_by") return row.lastEditedBy;
  return row.properties?.[prop.id];
}

export function displayPropertyValue(
  row: Page,
  prop: DbProperty,
  pagesById: Record<string, Page>
): string {
  const value = rawValue(row, prop);
  if (prop.type === "title") return pageDisplayTitle(row);
  if (prop.type === "select" || prop.type === "status") {
    const id = value ? String(value) : "";
    return prop.config?.options?.find((option) => option.id === id)?.name ?? id;
  }
  if (prop.type === "multi_select") {
    return valueAsIds(value)
      .map((id) => prop.config?.options?.find((option) => option.id === id)?.name ?? id)
      .filter(Boolean)
      .join(", ");
  }
  if (prop.type === "checkbox") return value ? "Checked" : "Unchecked";
  if (prop.type === "number") {
    return formatNumberValue(value, numberFormatForProperty(prop));
  }
  if (prop.type === "date") return formatDateForProperty(value, prop);
  if (prop.type === "created_time" || prop.type === "last_edited_time") {
    return formatNotionTimestamp(value);
  }
  if (prop.type === "relation") {
    return valueAsIds(value)
      .map((id) => pageDisplayTitle(pagesById[id]))
      .join(", ");
  }
  if (prop.type === "files") {
    return normalizeFileAttachments(value)
      .map((file) => file.name)
      .join(", ");
  }
  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    return normalizePersonIds(value)
      .map((id) => personLabel(id))
      .join(", ");
  }
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * The id of the database reached by a rollup's second hop, if any — i.e. when the
 * rollup target property is itself a relation or rollup. Used by cells to trigger
 * loading that database's properties so the multi-hop value can resolve.
 */
export function secondHopDatabaseId(
  prop: DbProperty,
  targetProps: DbProperty[],
  propsByDb: Record<string, DbProperty[]> | undefined
): string | undefined {
  const targetProp = targetProps.find(
    (item) => item.id === prop.config?.rollupTargetPropertyId
  );
  if (!targetProp) return undefined;
  if (targetProp.type === "relation") {
    return targetProp.config?.relationDatabaseId ?? targetProp.databaseId;
  }
  if (targetProp.type === "rollup") {
    const ownerProps = propsByDb?.[targetProp.databaseId] ?? [];
    const viaId = prop.config?.rollupVia;
    const hopRelation =
      (viaId ? ownerProps.find((item) => item.id === viaId) : undefined) ??
      ownerProps.find((item) => item.id === targetProp.config?.rollupRelationPropertyId);
    if (hopRelation?.type === "relation") {
      return hopRelation.config?.relationDatabaseId ?? hopRelation.databaseId;
    }
  }
  return undefined;
}

/**
 * Evaluate a rollup for a row. Thin web adapter over the shared rollup engine
 * (`shared/database/rollup-core.ts`): injects web value-reading/display and
 * preserves web's string return type. The reducers, relation-hop resolution,
 * and date normalization live in the shared core so web and backend agree.
 */
export function evaluateRollup({
  row,
  prop,
  sourceProps,
  targetProps,
  pagesById,
  propsByDb,
}: {
  row: Page;
  prop: DbProperty;
  sourceProps: DbProperty[];
  targetProps: DbProperty[];
  pagesById: Record<string, Page>;
  propsByDb?: Record<string, DbProperty[]>;
}): string {
  const ctx: RollupContext = {
    pagesById: (id) => pagesById[id],
    propsByDb: (dbId) => (propsByDb?.[dbId] ?? []) as unknown as RollupProperty[],
    rawValue: (page, coreProp) => rawValue(page as Page, coreProp as unknown as DbProperty),
    displayValue: (page, coreProp) =>
      displayPropertyValue(page as Page, coreProp as unknown as DbProperty, pagesById),
  };
  const result = evaluateRollupCore(
    row as RollupPage,
    prop as unknown as RollupProperty,
    sourceProps as unknown as RollupProperty[],
    targetProps as unknown as RollupProperty[],
    ctx
  );
  return typeof result === "number" ? String(result) : result;
}
