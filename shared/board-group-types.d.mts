export const HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES: readonly [
  "select",
  "status",
  "person",
  "multi_select",
];

export type HanjiBoardMainGroupPropertyType =
  typeof HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES[number];

export function isHanjiBoardMainGroupPropertyType(
  value: unknown,
): value is HanjiBoardMainGroupPropertyType;

export function notionBoardMainGroupPropertyType(
  value: unknown,
): "select" | "status" | "people" | "multi_select" | undefined;
