// Current Notion API (2026-03-11) view enum. Keep protocol acceptance separate
// from Hanji's six long-standing native view workflows: compatibility-only
// types must retain their real type/config instead of masquerading as tables.
export const NOTION_DATABASE_VIEW_TYPES = Object.freeze([
  "table",
  "board",
  "list",
  "calendar",
  "timeline",
  "gallery",
  "form",
  "chart",
  "map",
  "dashboard",
]);
export const HANJI_CORE_DATABASE_VIEW_TYPES = Object.freeze([
  "table",
  "board",
  "list",
  "gallery",
  "calendar",
  "timeline",
]);

export const NOTION_COMPAT_DATABASE_VIEW_TYPES = Object.freeze([
  "form",
  "chart",
  "map",
  "dashboard",
]);
