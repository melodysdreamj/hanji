export const HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES = Object.freeze([
  "select",
  "status",
  "person",
  "multi_select",
]);

const boardMainGroupPropertyTypeSet = new Set(HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES);

export function isHanjiBoardMainGroupPropertyType(value) {
  return typeof value === "string" && boardMainGroupPropertyTypeSet.has(value);
}

export function notionBoardMainGroupPropertyType(value) {
  if (!isHanjiBoardMainGroupPropertyType(value)) return undefined;
  return value === "person" ? "people" : value;
}
