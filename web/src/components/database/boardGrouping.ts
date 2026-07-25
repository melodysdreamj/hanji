import {
  isHanjiBoardMainGroupPropertyType,
  type HanjiBoardMainGroupPropertyType,
} from "../../../../shared/board-group-types.mjs";
import type { DbProperty, Page, SelectOption, WorkspaceMember } from "@/lib/types";
import { normalizePersonIds, personLabel } from "./people";

export type BoardMainGroupProperty = DbProperty & {
  type: HanjiBoardMainGroupPropertyType;
};

export function isBoardMainGroupProperty(
  property: DbProperty | null | undefined,
): property is BoardMainGroupProperty {
  return !!property && isHanjiBoardMainGroupPropertyType(property.type);
}

function distinctNonemptyStrings(values: unknown[]) {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of values) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function boardGroupValueIds(property: BoardMainGroupProperty, value: unknown) {
  if (property.type === "person") {
    return distinctNonemptyStrings(normalizePersonIds(value));
  }
  const ids = distinctNonemptyStrings(Array.isArray(value) ? value : [value]);
  return property.type === "multi_select" ? ids : ids.slice(0, 1);
}

export function boardGroupReplacementValue(
  property: BoardMainGroupProperty,
  targetId: string | null,
) {
  if (!targetId) return null;
  return property.type === "person" || property.type === "multi_select"
    ? [targetId]
    : targetId;
}

export function boardGroupOptions(
  property: BoardMainGroupProperty,
  rows: Page[],
  workspaceMembers: WorkspaceMember[],
  currentUserId?: string,
): SelectOption[] {
  if (property.type !== "person") return property.config?.options ?? [];

  const ids = distinctNonemptyStrings([
    ...workspaceMembers.map((member) => member.userId),
    ...rows.flatMap((row) => boardGroupValueIds(property, row.properties?.[property.id])),
  ]);
  return ids.map((id) => ({
    id,
    name: personLabel(id, currentUserId),
    color: "default",
  }));
}

export function hasEditableBoardGroupOptions(property: BoardMainGroupProperty) {
  return property.type !== "person";
}
