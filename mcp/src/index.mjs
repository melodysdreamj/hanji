#!/usr/bin/env node
// Hanji MCP server — exposes the local workspace (pages, blocks, search)
// to AI agents over stdio. Talks to the EdgeBase backend via its REST API.

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { eb, blockToMarkdown, blocksToMarkdown, markdownToBlocks, parseInlineMarkdown } from "./edgebase.mjs";
export { formulaDate, formulaReplace, formulaTest } from "./formula-runtime.mjs";
import {
  applyDatabaseView,
  databasePropsContext,
  formatDbValue,
  ids,
  optionId,
  personIds,
  propValue,
  ROLLUP_FUNCTIONS,
  viewDisplayProperties,
} from "./database-query-runtime.mjs";
export {
  canonicalRollupFunction,
  evaluateRollupValue,
  LEGACY_ROLLUP_FUNCTION_ALIASES,
  NOTION_ROLLUP_FUNCTIONS,
  ROLLUP_FUNCTIONS,
} from "./database-query-runtime.mjs";
import {
  applyNotionViewCompatMetadata,
  applyNotionViewPresentationConfig,
  assertRequiredNotionViewConfigure,
  executeStreamableNotionMcpSqlChunk,
  normalizeNotionViewConfig,
  normalizeNotionViewConfigureInput,
  notionMcpSqlStreamPlan,
  NOTION_MCP_SQL_CROSS_WINDOW_ERROR,
  notionTypedDatabaseProperties,
  parseDataSourceSqlUnionQuery,
  parseNotionCreateTableSchema,
  parseNotionDdlStatements,
  stripHanjiId,
  validateNotionDdlOperations,
} from "./notion-tool-dsl.mjs";
export { parseDataSourceSqlQuery, parseDataSourceSqlUnionQuery } from "./notion-tool-dsl.mjs";
import { hanjiEnv } from "./legacy-product-compat.mjs";
import { registerFoundationTools } from "./tool-registry-foundation.mjs";
import { registerDatabaseTools } from "./tool-registry-database.mjs";
import { registerNotionTools } from "./tool-registry-notion.mjs";
import {
  createOfficialNotionToolRegistrar,
  registerNotionAsyncTaskTool,
} from "./notion-official-tools.mjs";
import {
  HANJI_CORE_DATABASE_VIEW_TYPES,
  NOTION_DATABASE_VIEW_TYPES,
} from "./database-view-types.mjs";
import { isHanjiBoardMainGroupPropertyType } from "../../shared/board-group-types.mjs";
import {
  meetingTranscriptMarkdown,
  withoutMeetingTranscriptSubtrees,
} from "./notion-fetch-transcript.mjs";
import {
  createNotionAttachmentHandlers,
  registerNotionAttachmentTools,
} from "./notion-attachment-tools.mjs";
import {
  NOTION_MOVE_PAGES_MAX_IDS,
} from "./notion-move-pages-contract.mjs";
import { createNotionMovePagesHandler } from "./notion-move-pages-handler.mjs";
import {
  createNotionUpdatePageHandler,
  NOTION_UPDATE_PAGE_MAX_CONTENT_UPDATES,
} from "./notion-update-page-handler.mjs";
import {
  notionSearchCursorCodec,
  notionSearchRequestFingerprint,
} from "./notion-search-pagination.mjs";
import {
  notionSqlCursorCodec,
  notionSqlRequestFingerprint,
} from "./notion-sql-pagination.mjs";

const server = new McpServer({
  name: "hanji",
  version: "0.1.0",
});
const toolRegistrar = createOfficialNotionToolRegistrar(server);

const BASE_URL = (hanjiEnv("HANJI_EDGEBASE_URL") || "http://127.0.0.1:8787").replace(/\/$/, "");
const ok = (text) => ({ content: [{ type: /** @type {"text"} */ ("text"), text: String(text) }] });
const okStructured = (text, structuredContent) => ({
  content: [{ type: /** @type {"text"} */ ("text"), text: String(text) }],
  structuredContent,
});
const fail = (e) => ({
  content: [{ type: /** @type {"text"} */ ("text"), text: `Error: ${e?.message ?? e}` }],
  isError: true,
});
const okJson = (payload) => ok(JSON.stringify(payload));
const registerToolAliases = (names, definition, handler) => {
  for (const name of names) toolRegistrar.registerTool(name, definition, handler);
};
const resourceText = (uri, text) => ({
  contents: [{ uri, mimeType: "text/markdown", text }],
});
const titleOf = (p) => (p.iconType === "emoji" && p.icon ? p.icon + " " : "") + (p.title || "Untitled");
const lockedPageMessage = (page) => `"${titleOf(page)}" is locked. Unlock it before editing.`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

server.registerResource(
  "notion-enhanced-markdown-spec",
  "notion://docs/enhanced-markdown-spec",
  {
    title: "Hanji Notion-compatible Markdown",
    description:
      "Notion MCP-compatible Markdown subset supported by Hanji, including authorized stored meeting-note transcripts.",
    mimeType: "text/markdown",
  },
  (uri) =>
    resourceText(
      uri.href,
      [
        "# Hanji Notion-Compatible Markdown",
        "",
        "Hanji accepts the common Notion MCP enhanced Markdown patterns for page body tools, including headings, paragraphs, lists, checkboxes, block quotes, code fences, divider lines, toggles through HTML details/summary, and page/database references.",
        "",
        "Supported reference tags:",
        "- `<page url=\"...\">Title</page>` references an existing page.",
        "- `<database url=\"...\" data-source-url=\"collection://...\">Title</database>` references an existing database/data source.",
        "- `<data-source url=\"collection://...\">` appears in fetch results for database/data-source schema.",
        "- `<page-discussions>` and `discussion://...` IDs appear when comments are requested.",
        "- `<meeting-notes><transcript>` appears only when fetch requests `include_transcript` and the caller is an authorized attendee.",
        "",
        "Hanji returns stored meeting-note transcripts but does not claim separate AI generation, AI search, or connected-source syntax. AI-search requests search only authorized Hanji product data.",
      ].join("\n")
    )
);

server.registerResource(
  "notion-view-dsl-spec",
  "notion://docs/view-dsl-spec",
  {
    title: "Hanji Notion-compatible View DSL",
    description:
      "Notion MCP-compatible view configuration subset supported by Hanji database views.",
    mimeType: "text/markdown",
  },
  (uri) =>
    resourceText(
      uri.href,
      [
        "# Hanji Notion-Compatible View DSL",
        "",
        "Accepted Notion view types: table, board, list, calendar, timeline, gallery, form, chart, map, dashboard.",
        "Hanji's six core view workflows remain table, board, list, gallery, calendar, and timeline. Other official types retain their exact type/configuration without being relabeled as a core renderer.",
        "",
        "Supported directives:",
        "- `SHOW \"Prop1\", \"Prop2\"` sets visible properties.",
        "- `HIDE \"Prop1\", \"Prop2\"` hides properties by deriving the visible property list.",
        "- `SORT BY \"Property\" ASC|DESC` sets one or more sort rules.",
        "- `FILTER \"Property\" = \"Value\"` adds an equals filter.",
        "- `FILTER \"Property\" != \"Value\"` adds a does_not_equal filter.",
        "- `FILTER \"Property\" CONTAINS \"Value\"` adds a contains filter.",
        "- `FILTER \"Property\" IS EMPTY` / `IS NOT EMPTY` adds empty filters.",
        "- `GROUP BY \"Property\"` sets board grouping.",
        "- `CALENDAR BY \"Property\"` sets the calendar date property.",
        "- `TIMELINE BY \"Start\" TO \"End\"` sets timeline start/end date properties.",
        "- `MAP BY \"Property\"` sets the location property for a map view.",
        "- `CHART column|bar|line|donut|number` sets the chart type; optional clauses are `AGGREGATE <operator> [BY] \"Property\"`, `COLOR <theme>`, `HEIGHT <size>`, `SORT <order>`, `STACK BY \"Property\"`, and `CAPTION \"Text\"`.",
        "- `FORM CLOSE|OPEN`, `FORM ANONYMOUS true|false`, and `FORM PERMISSIONS none|comment_only|reader|read_and_write|editor` configure form submissions.",
        "- `COVER \"Property\"` sets board/gallery cover property.",
        "- `WRAP CELLS` and `NO WRAP` toggle wrapping.",
        "- `FREEZE COLUMNS <count>` freezes that many table columns from the left (`FREEZE COLUMNS` defaults to one).",
        "- `CLEAR FILTER`, `CLEAR SORT`, and `CLEAR GROUP BY` clear those settings.",
        "",
        "Unsupported directives fail clearly instead of pretending to use Notion AI or unavailable Hanji product features.",
      ].join("\n")
    )
);

server.registerResource(
  "notion-mcp-compatibility-report",
  "notion://docs/mcp-compatibility-report",
  {
    title: "Hanji MCP compatibility report",
    description:
      "Current MCP and Notion MCP compatibility posture for Hanji's product-API-backed MCP server.",
    mimeType: "text/markdown",
  },
  (uri) =>
    resourceText(
      uri.href,
      [
        "# Hanji MCP Compatibility Report",
        "",
        "Last reviewed: 2026-07-15 against MCP authorization 2025-11-25 and the current 20-tool Notion connector surface.",
        "",
        "- Transport: this package provides local stdio with credentials read from environment variables; Hanji also exposes a hosted Streamable HTTP-compatible JSON-RPC endpoint.",
        "- Hosted authorization: OAuth authorization-code + PKCE, protected-resource metadata, audience validation, scoped Hanji grants, and no bearer-token passthrough are implemented and smoke-tested.",
        "- Tool results: structured MCP results and output schemas are used for policy, workspace, database description, and database query tools.",
        "- Access control: every call stays on the Hanji product API, authenticates as the configured user or service principal, then applies optional read-only, allowlist, validity-window, and scope narrowing.",
        "- Auditability: mutating product-API calls record `mcp.client_action` organization audit events with client and provisioned subject metadata when a workspace can be resolved.",
        "- Notion MCP compatibility: all 20 current notion-* names are exposed. Native and preserved imported meeting notes are queryable with attendee/ACL checks, and fetch expands stored transcripts only on include_transcript.",
        "- Attachments: create/download use real storage-backed uploads. Safe UTF-8 inline formats are capped at 200 KiB, public HTTPS imports at 5 MiB, and stdio downloads fail closed outside attachments created by the current process.",
        "- Remote hosted MCP: read/query, attachments, comments, duplicate/move, database-view, and primary Notion-compatible page/database create/update calls route through Hanji's canonical product handlers after scope and resource checks. Connected-source and AI-search layers still return explicit fallback metadata.",
      ].join("\n")
    )
);
/** @type {[string, ...string[]]} */
const PAGE_PARENT_TYPES = ["workspace", "page", "database"];
/** @type {[string, ...string[]]} */
const PAGE_FONTS = ["default", "serif", "mono"];
/** @type {[string, ...string[]]} */
const PAGE_ICON_TYPES = ["emoji", "image", "none"];
/** @type {[string, ...string[]]} */
const PAGE_DISPLAY_OPTIONS = ["default", "expanded", "off"];
/** @type {[string, ...string[]]} */
const SHARE_ROLES = ["view", "comment", "edit", "full_access"];
/** @type {[string, ...string[]]} */
const SHARE_PRINCIPAL_TYPES = ["user", "email", "group", "integration"];
/** @type {[string, ...string[]]} */
const FILE_UPLOAD_STATUSES = ["pending", "uploaded", "deleted", "expired"];
/** @type {[string, ...string[]]} */
const NOTIFICATION_KINDS = ["comment", "mention", "link", "page_edit", "system"];
/** @type {[string, ...string[]]} */
const WORKSPACE_MEMBER_ROLES = ["admin", "member", "guest"];
const JsonValueSchema = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);
const JsonObjectSchema = z.record(JsonValueSchema);
const MCP_ACCESS_POLICY_OUTPUT_SCHEMA = {
  readOnly: z.boolean(),
  allowedWorkspaceIds: z.array(z.string()),
  allowedPageIds: z.array(z.string()),
  allowedDatabaseIds: z.array(z.string()),
  scopes: z.array(z.string()),
  policyFile: z.string().nullable(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  issuer: z.string().nullable(),
  audience: z.string().nullable(),
  transport: z.string().nullable(),
  provisioningId: z.string().nullable(),
  notBefore: z.string().nullable(),
  expiresAt: z.string().nullable(),
  scopeModel: z.string(),
  notionCompatibilityNote: z.string(),
};
const MCP_WORKSPACE_SUMMARY_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  iconType: z.string().nullable(),
  organizationId: z.string().nullable(),
  domain: z.string().nullable(),
  ownerId: z.string().nullable(),
  notionTeamspaceId: z.string(),
  scopeModel: z.string(),
});
const MCP_LIST_WORKSPACES_OUTPUT_SCHEMA = {
  scopeModel: z.string(),
  notionCompatibilityNote: z.string(),
  count: z.number(),
  workspaces: z.array(MCP_WORKSPACE_SUMMARY_SCHEMA),
};
const MCP_DATABASE_SUMMARY_SCHEMA = z.object({
  id: z.string(),
  title: z.string(),
  label: z.string(),
  icon: z.string().nullable(),
  iconType: z.string().nullable(),
  workspaceId: z.string().nullable(),
  parentId: z.string().nullable(),
  parentType: z.string().nullable(),
});
const MCP_DATABASE_PROPERTY_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number().nullable(),
});
const MCP_DATABASE_VIEW_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number().nullable(),
  filterCount: z.number(),
  sorts: z.array(z.object({
    propertyId: z.string(),
    propertyName: z.string(),
    direction: z.string(),
  })),
  visiblePropertyIds: z.array(z.string()),
  hiddenPropertyIds: z.array(z.string()),
  propertyOrder: z.array(z.string()),
  tableCalculations: z.array(z.object({
    propertyId: z.string(),
    propertyName: z.string(),
    calculation: z.string(),
  })),
  groupBy: z.string().nullable(),
  subGroupBy: z.string().nullable(),
  calendarBy: z.string().nullable(),
  timelineBy: z.string().nullable(),
});
const MCP_DESCRIBE_DATABASE_OUTPUT_SCHEMA = {
  database: MCP_DATABASE_SUMMARY_SCHEMA.nullable(),
  rowCount: z.number(),
  properties: z.array(MCP_DATABASE_PROPERTY_SCHEMA),
  views: z.array(MCP_DATABASE_VIEW_SCHEMA),
  message: z.string().nullable(),
};
const MCP_DATABASE_QUERY_COLUMN_SCHEMA = z.object({
  propertyId: z.string(),
  name: z.string(),
  type: z.string(),
});
const MCP_DATABASE_QUERY_CELL_SCHEMA = z.object({
  propertyId: z.string(),
  propertyName: z.string(),
  propertyType: z.string(),
  value: JsonValueSchema,
  text: z.string(),
});
const MCP_DATABASE_QUERY_ROW_SCHEMA = z.object({
  id: z.string(),
  title: z.string(),
  cells: z.array(MCP_DATABASE_QUERY_CELL_SCHEMA),
});
const MCP_QUERY_DATABASE_OUTPUT_SCHEMA = {
  database: MCP_DATABASE_SUMMARY_SCHEMA.nullable(),
  view: MCP_DATABASE_VIEW_SCHEMA.nullable(),
  totalMatching: z.number(),
  returned: z.number(),
  limit: z.number(),
  search: z.string().nullable(),
  columns: z.array(MCP_DATABASE_QUERY_COLUMN_SCHEMA),
  rows: z.array(MCP_DATABASE_QUERY_ROW_SCHEMA),
  message: z.string().nullable(),
};
/** @type {[string, ...string[]]} */
const NOTION_IMPORT_CONNECTION_KINDS = ["oauth", "personal_access_token", "internal_integration", "manual_token"];
const MCP_ACTOR = "mcp-local";

const pageCreateAudit = () => ({ createdBy: MCP_ACTOR, lastEditedBy: MCP_ACTOR });
const pageEditAudit = () => ({ lastEditedBy: MCP_ACTOR });

function lockedParentFor(pagesById, parentId) {
  return parentId ? pagesById[parentId] : undefined;
}

function assertCanMoveFromParent(pagesById, page) {
  const parent = lockedParentFor(pagesById, page.parentId);
  if (parent?.isLocked) {
    throw new Error(`Cannot move or duplicate "${titleOf(page)}" from locked parent "${titleOf(parent)}".`);
  }
}

function assertCanMoveIntoParent(pagesById, parentId) {
  const parent = lockedParentFor(pagesById, parentId);
  if (parent?.isLocked) {
    throw new Error(`Cannot move pages into locked parent "${titleOf(parent)}".`);
  }
}

function isPageVerified(page, now = Date.now()) {
  if (!page?.verifiedAt) return false;
  if (!page.verificationExpiresAt) return true;
  const expiresAt = new Date(page.verificationExpiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt > now;
}

function rich(text) {
  return { rich: text ? [{ text }] : [] };
}

function todo(text) {
  return { rich: [{ text }], checked: false };
}

const PAGE_TEMPLATES = [
  {
    id: "task-list",
    title: "Task List",
    category: "Personal",
    icon: "✅",
    blocks: [
      { type: "heading_2", content: rich("Today") },
      { type: "to_do", content: todo("First task") },
      { type: "to_do", content: todo("Second task") },
      { type: "to_do", content: todo("Follow up") },
      { type: "heading_2", content: rich("Later") },
      { type: "to_do", content: todo("Backlog item") },
    ],
  },
  {
    id: "meeting-notes",
    title: "Meeting Notes",
    category: "Work",
    icon: "🗓️",
    blocks: [
      { type: "heading_2", content: rich("Agenda") },
      { type: "bulleted_list_item", content: rich("Topic") },
      { type: "heading_2", content: rich("Notes") },
      { type: "paragraph", content: rich("") },
      { type: "heading_2", content: rich("Action items") },
      { type: "to_do", content: todo("Owner - task") },
    ],
  },
  {
    id: "project-brief",
    title: "Project Brief",
    category: "Work",
    icon: "📄",
    blocks: [
      { type: "heading_2", content: rich("Overview") },
      { type: "paragraph", content: rich("") },
      { type: "heading_2", content: rich("Goals") },
      { type: "bulleted_list_item", content: rich("Goal") },
      { type: "heading_2", content: rich("Scope") },
      { type: "bulleted_list_item", content: rich("Included") },
      { type: "bulleted_list_item", content: rich("Not included") },
      { type: "heading_2", content: rich("Timeline") },
      { type: "paragraph", content: rich("") },
    ],
  },
  {
    id: "weekly-plan",
    title: "Weekly Plan",
    category: "Personal",
    icon: "⏱️",
    blocks: [
      { type: "heading_2", content: rich("Priorities") },
      { type: "numbered_list_item", content: rich("Priority") },
      { type: "numbered_list_item", content: rich("Priority") },
      { type: "numbered_list_item", content: rich("Priority") },
      { type: "heading_2", content: rich("Schedule") },
      { type: "bulleted_list_item", content: rich("Monday") },
      { type: "bulleted_list_item", content: rich("Tuesday") },
      { type: "bulleted_list_item", content: rich("Wednesday") },
    ],
  },
];

function md(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function positionBetween(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b / 2;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

function richPlain(value) {
  if (typeof value === "string") return value;
  const rich = value?.rich;
  if (!Array.isArray(rich)) return "";
  return rich.map((span) => span?.text ?? "").join("");
}

function commentQuote(value) {
  const quote = value?.quote;
  return typeof quote === "string" ? quote.trim() : "";
}

function blockPreview(block) {
  if (!block) return "";
  const text = richPlain({ rich: block.content?.rich }) || block.plainText || block.type;
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function templateBlocksToMarkdown(blocks = [], depth = 0) {
  const out = [];
  const indent = "  ".repeat(depth);
  for (const block of blocks ?? []) {
    if (block.type === "column_list") {
      const columns = (block.children ?? []).filter((child) => child.type === "column");
      if (columns.length === 0) continue;
      out.push(`${indent}::: columns`);
      for (const [index, column] of columns.entries()) {
        out.push(`${indent}::: column ${index + 1}`);
        const body = templateBlocksToMarkdown(column.children ?? [], depth + 1);
        if (body) out.push(body);
        out.push(`${indent}:::`);
      }
      out.push(`${indent}:::`);
      continue;
    }

    if (block.type === "column") {
      const body = templateBlocksToMarkdown(block.children ?? [], depth);
      if (body) out.push(body);
      continue;
    }

    const line = blockToMarkdown({
      type: block.type,
      content: block.content,
      plainText:
        richPlain(block.content) ||
        block.plainText ||
        block.content?.expression ||
        block.content?.url ||
        block.content?.fileName ||
        block.type,
    });
    if (line) {
      out.push(line.split("\n").map((part) => (part ? indent + part : part)).join("\n"));
    }
    const children = templateBlocksToMarkdown(block.children ?? [], depth + 1);
    if (children) out.push(children);
  }
  return out.join("\n");
}

function commentLine(comment, { blocksById = {}, depth = 0 } = {}) {
  const prefix = "  ".repeat(depth);
  const state = comment.resolved ? "resolved" : "open";
  const target = comment.blockId
    ? `block ${comment.blockId}${blocksById[comment.blockId] ? `: ${blockPreview(blocksById[comment.blockId])}` : ""}`
    : "page";
  const quote = commentQuote(comment.body);
  // Comment bodies/quotes are untrusted; escape framing-tag openers so a
  // comment cannot forge the XML-ish framing other tools emit (the
  // _notion_get_comments sibling xmlEscapes its bodies fully).
  const parts = [
    `${prefix}- [${state}] ${escapeFramingBreakouts(richPlain(comment.body) || "(empty comment)")}`,
    `${prefix}  id: ${comment.id}`,
    `${prefix}  target: ${target}`,
    `${prefix}  author: ${comment.authorId || "unknown"}`,
    `${prefix}  created: ${comment.createdAt ?? "unknown"}`,
  ];
  if (quote) parts.push(`${prefix}  quote: "${escapeFramingBreakouts(quote)}"`);
  return parts.join("\n");
}

function propertyByKey(props, key) {
  const needle = String(key).trim().toLowerCase();
  return props.find(
    (prop) => prop.id === key || String(prop.name ?? "").trim().toLowerCase() === needle
  );
}

const READONLY_PROPERTY_TYPES = new Set([
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "rollup",
  "formula",
  "unique_id",
]);

/** @type {[string, ...string[]]} */
const DATABASE_PROPERTY_TYPES = [
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "person",
  "checkbox",
  "files",
  "relation",
  "rollup",
  "formula",
  "url",
  "email",
  "phone",
  "unique_id",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
];

/** @type {[string, ...string[]]} */
const DATABASE_CREATE_PROPERTY_TYPES = ["title", ...DATABASE_PROPERTY_TYPES];
/** @type {[string, ...string[]]} */
const DATABASE_VIEW_TYPES = /** @type {[string, ...string[]]} */ ([...NOTION_DATABASE_VIEW_TYPES]);
/** @type {[string, ...string[]]} */
const NOTION_VIEW_TYPES = /** @type {[string, ...string[]]} */ ([...NOTION_DATABASE_VIEW_TYPES]);
/** @type {[string, ...string[]]} */
const VIEW_CARD_SIZES = ["small", "medium", "large"];
/** @type {[string, ...string[]]} */
const VIEW_OPEN_PAGE_IN = ["side", "center", "full"];
/** @type {[string, ...string[]]} */
const VIEW_ROW_HEIGHTS = ["short", "medium", "tall"];
/** @type {[string, ...string[]]} */
const VIEW_TIMELINE_ZOOMS = ["day", "week", "month"];
const TABLE_CALCULATIONS = [
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "percent_empty",
  "percent_not_empty",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest_date",
  "latest_date",
  "date_range",
];
/** @type {[string, ...string[]]} */
const TABLE_CALCULATION_INPUTS = ["none", ...TABLE_CALCULATIONS];
const BASE_TABLE_CALCULATIONS = new Set([
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "percent_empty",
  "percent_not_empty",
]);
const CHECKBOX_TABLE_CALCULATIONS = new Set([
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
]);
const NUMBER_TABLE_CALCULATIONS = new Set(["sum", "average", "median", "min", "max", "range"]);
const DATE_TABLE_CALCULATIONS = new Set(["earliest_date", "latest_date", "date_range"]);
/** @type {[string, ...string[]]} */
const FILTER_OPERATORS = [
  "equals",
  "does_not_equal",
  "contains",
  "does_not_contain",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
  "on_or_before",
  "on_or_after",
];
const NO_VALUE_FILTERS = new Set(["is_empty", "is_not_empty"]);
const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

function normalizePropertyValue(prop, value) {
  if (value == null || value === "") return null;
  if (prop.type === "select" || prop.type === "status") return optionId(prop, value);
  if (prop.type === "multi_select") return ids(value).map((item) => optionId(prop, item)).filter(Boolean);
  if (prop.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (prop.type === "checkbox") {
    if (typeof value === "boolean") return value;
    return !["false", "0", "no", "unchecked"].includes(String(value).trim().toLowerCase());
  }
  if (prop.type === "person" || prop.type === "relation") return ids(value);
  return value;
}

function rowPatchFromProperties(props, input = {}) {
  const patch = { properties: {} };
  const unknown = [];
  const readonly = [];

  for (const [key, value] of Object.entries(input ?? {})) {
    const prop = propertyByKey(props, key);
    if (!prop) {
      if (key.toLowerCase() === "title" || key.toLowerCase() === "name") patch.title = String(value ?? "");
      else unknown.push(key);
      continue;
    }
    if (prop.type === "title") {
      patch.title = String(value ?? "");
      continue;
    }
    if (READONLY_PROPERTY_TYPES.has(prop.type)) {
      readonly.push(prop.name);
      continue;
    }
    patch.properties[prop.id] = normalizePropertyValue(prop, value);
  }

  return { patch, unknown, readonly };
}

const IMPORTED_DATABASE_ROW_METADATA_PROPERTY_IDS = new Set([
  "notionImportJobId",
  "notionPageId",
  "notionDataSourceId",
]);

function isImportedDatabaseRowMetadataPropertyId(propId) {
  const key = String(propId);
  return key.startsWith("__") || IMPORTED_DATABASE_ROW_METADATA_PROPERTY_IDS.has(key);
}

function persistableDatabaseRowProperties(properties = {}) {
  return Object.fromEntries(
    Object.entries(properties ?? {}).filter(
      ([key]) => !isImportedDatabaseRowMetadataPropertyId(key)
    )
  );
}

async function clearOtherDefaultTemplates(databaseId, keepTemplateId) {
  const templates = await eb.dbTemplates(databaseId);
  await Promise.all(
    templates
      .filter((template) => template.id !== keepTemplateId && template.isDefault)
      .map((template) =>
        eb.update("db_templates", template.id, { isDefault: false }, { databaseId: template.databaseId ?? databaseId })
      )
  );
}

function schemaLine(prop) {
  const options = prop.config?.options?.length
    ? ` options: ${(prop.config.options ?? []).map((option) => option.name).join(", ")}`
    : "";
  const relation = prop.config?.relationDatabaseId ? ` relation: ${prop.config.relationDatabaseId}` : "";
  const idPrefix = prop.type === "unique_id" && prop.config?.idPrefix
    ? ` prefix: ${prop.config.idPrefix}`
    : "";
  const display = [
    prop.config?.hideInPagePanel ? "hidden in row pages" : "",
    prop.config?.hideWhenEmpty ? "hide when empty" : "",
  ].filter(Boolean);
  const displayText = display.length ? ` display: ${display.join(", ")}` : "";
  return `- ${prop.name} [${prop.type}] id: ${prop.id}${options}${relation}${idPrefix}${displayText}`;
}

function propertyLabel(props, propertyId) {
  return props.find((prop) => prop.id === propertyId)?.name ?? propertyId;
}

function filterGroupTermCount(group) {
  if (!group) return 0;
  return (
    (group.filters ?? []).length +
    (group.groups ?? []).reduce((total, subgroup) => total + filterGroupTermCount(subgroup), 0)
  );
}

function viewLine(view, props) {
  const config = view.config ?? {};
  const filterCount = config.filterGroup ? filterGroupTermCount(config.filterGroup) : (config.filters ?? []).length;
  const details = [
    filterCount ? `filters: ${filterCount}` : "",
    config.groupBy ? `group: ${propertyLabel(props, config.groupBy)}` : "",
    config.subGroupBy ? `sub-group: ${propertyLabel(props, config.subGroupBy)}` : "",
    config.calendarBy ? `calendar: ${propertyLabel(props, config.calendarBy)}` : "",
    config.timelineBy ? `timeline: ${propertyLabel(props, config.timelineBy)}` : "",
    config.wrappedColumns?.length
      ? `wrapped: ${config.wrappedColumns.map((id) => propertyLabel(props, id)).join(", ")}`
      : "",
    config.tableCalculations && Object.keys(config.tableCalculations).length
      ? `calculations: ${Object.entries(config.tableCalculations)
          .map(([propertyId, calculation]) => `${propertyLabel(props, propertyId)} ${calculation}`)
          .join(", ")}`
      : "",
    config.sorts?.length
      ? `sorts: ${config.sorts.map((sort) => `${propertyLabel(props, sort.propertyId)} ${sort.direction ?? "asc"}`).join(", ")}`
      : "",
  ].filter(Boolean);
  return `- ${view.name} [${view.type}] id: ${view.id}${details.length ? ` (${details.join("; ")})` : ""}`;
}

function looksLikeImageIcon(value) {
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(String(value ?? "").trim());
}

/**
 * @param {{ icon?: any, iconType?: any }} input
 * @param {any} currentPage
 */
function pageIconPatch({ icon, iconType } = {}, currentPage) {
  const patch = {};
  if (iconType === "none" || icon === "" || String(icon ?? "").trim().toLowerCase() === "none") {
    patch.icon = "";
    patch.iconType = "none";
    return patch;
  }

  if (icon !== undefined) {
    patch.icon = icon;
    patch.iconType = iconType ?? (looksLikeImageIcon(icon) ? "image" : "emoji");
    return patch;
  }

  if (iconType !== undefined) {
    if (!currentPage?.icon && iconType !== "none") {
      throw new Error(`icon is required when setting iconType to ${iconType}.`);
    }
    patch.iconType = iconType;
  }

  return patch;
}

function pagePresentationPatch(input = {}) {
  const patch = {};
  if (input.cover !== undefined) patch.cover = String(input.cover).trim().toLowerCase() === "none" ? "" : input.cover;
  if (input.coverPosition !== undefined) patch.coverPosition = clamp(input.coverPosition, 0, 100);
  if (input.font !== undefined) patch.font = input.font;
  if (input.smallText !== undefined) patch.smallText = input.smallText;
  if (input.fullWidth !== undefined) patch.fullWidth = input.fullWidth;
  if (input.locked !== undefined) patch.isLocked = input.locked;
  if (input.backlinksDisplay !== undefined) patch.backlinksDisplay = input.backlinksDisplay;
  if (input.pageCommentsDisplay !== undefined) patch.pageCommentsDisplay = input.pageCommentsDisplay;
  return patch;
}

function pageMetadataLines(page) {
  const verified = isPageVerified(page);
  return [
    `page id: ${page.id}`,
    `kind: ${page.kind ?? "page"}`,
    `parent: ${page.parentType ?? "workspace"}${page.parentId ? ` ${page.parentId}` : ""}`,
    `icon type: ${page.iconType ?? "none"}`,
    `icon: ${page.icon || "none"}`,
    `cover: ${page.cover || "none"}`,
    `cover position: ${page.coverPosition ?? 50}`,
    `font: ${page.font ?? "default"}`,
    `small text: ${page.smallText ? "yes" : "no"}`,
    `full width: ${page.fullWidth ? "yes" : "no"}`,
    `backlinks display: ${page.backlinksDisplay ?? "default"}`,
    `page comments display: ${page.pageCommentsDisplay ?? "default"}`,
    `locked: ${page.isLocked ? "yes" : "no"}`,
    `favorite: ${page.isFavorite ? "yes" : "no"}`,
    `share to web: ${page.isPublic ? "yes" : "no"}`,
    `verified: ${verified ? "yes" : "no"}`,
    ...(verified
      ? [
          `verified at: ${page.verifiedAt ?? "unknown"}`,
          `verified by: ${page.verifiedBy || "unknown"}`,
          `verification expires: ${page.verificationExpiresAt || "never"}`,
        ]
      : []),
    `trash: ${page.inTrash ? "yes" : "no"}`,
  ];
}

function shareRoleLabel(role) {
  if (role === "edit") return "Can edit";
  if (role === "comment") return "Can comment";
  if (role === "full_access") return "Full access";
  return "Can view";
}

function pageAccessLines(access) {
  const shareLink = access.shareLink;
  const permissions = access.permissions ?? [];
  return [
    `share to web: ${access.page?.isPublic ? "yes" : "no"}`,
    `can manage sharing: ${access.canManage ? "yes" : "no"}`,
    `public link: ${shareLink?.enabled ? `/share/${shareLink.token}` : "off"}`,
    `public link expires: ${shareLink?.enabled ? shareLink.expiresAt || "never" : "off"}`,
    permissions.length
      ? `permissions:\n${permissions
          .map(
            (permission) =>
              `- ${permission.label} (${permission.principalType}${
                permission.principalId ? `:${permission.principalId}` : ""
              }) — ${shareRoleLabel(permission.role)} [${permission.id}]`
          )
          .join("\n")}`
      : "permissions: none",
  ];
}

function fileUploadLines(file) {
  return [
    `name: ${file.name || "Untitled"}`,
    `id: ${file.id}`,
    `key: ${file.key}`,
    `status: ${file.status ?? "unknown"}`,
    `scope: ${file.scope ?? "uploads"}`,
    file.pageId ? `page id: ${file.pageId}` : null,
    file.blockId ? `block id: ${file.blockId}` : null,
    file.databaseId ? `database id: ${file.databaseId}` : null,
    file.propertyId ? `property id: ${file.propertyId}` : null,
    file.templateId ? `template id: ${file.templateId}` : null,
    `size: ${file.size ?? 0}`,
    `content type: ${file.contentType || "unknown"}`,
    `url: ${file.url || "none"}`,
    `created by: ${file.createdBy || "unknown"}`,
    `expires: ${file.expiresAt || "no"}`,
    `completed: ${file.completedAt || "no"}`,
    `expired: ${file.expiredAt || "no"}`,
    `deleted: ${file.deletedAt || "no"}`,
  ].filter(Boolean);
}

function fileBytesLabel(bytes = 0) {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

function fileStatsLines(title, stats = {}) {
  const entries = Object.entries(stats).sort((a, b) => (b[1]?.bytes ?? 0) - (a[1]?.bytes ?? 0));
  if (entries.length === 0) return [`## ${title}`, "none"];
  return [
    `## ${title}`,
    ...entries.map(([name, item]) => `- ${name}: ${item?.count ?? 0} file(s), ${fileBytesLabel(item?.bytes ?? 0)}`),
  ];
}

function fileReportLines(report) {
  const totals = report.totals ?? {};
  const pending = report.pending ?? {};
  const lines = [
    "# File Report",
    report.organizationId
      ? `organization id: ${report.organizationId}`
      : `workspace id: ${report.workspaceId || "unknown"}`,
    report.organizationName ? `organization: ${report.organizationName}` : null,
    report.workspaceCount !== undefined ? `workspaces: ${report.workspaceCount}` : null,
    report.storageLimitBytes ? `storage limit: ${fileBytesLabel(report.storageLimitBytes)}` : null,
    `generated: ${report.generatedAt}`,
    `files: ${totals.files ?? 0}`,
    `total accounted bytes: ${fileBytesLabel(totals.bytes ?? 0)}`,
    `active stored bytes: ${fileBytesLabel(totals.activeStorageBytes ?? 0)}`,
    `pending grants: ${pending.active ?? 0} active, ${pending.expired ?? 0} expired`,
    "",
    ...fileStatsLines("By Status", report.byStatus),
    "",
    ...fileStatsLines("By Scope", report.byScope),
  ];

  const byWorkspace = report.byWorkspace ?? [];
  if (byWorkspace.length) {
    lines.push("", "## By Workspace");
    for (const workspace of byWorkspace) {
      lines.push(
        `- ${workspace.name || workspace.domain || workspace.workspaceId}: ` +
          `${workspace.totals?.files ?? 0} file(s), ` +
          `${fileBytesLabel(workspace.totals?.activeStorageBytes ?? 0)} active`
      );
    }
  }

  const maintenanceRuns = report.maintenanceRuns ?? [];
  lines.push("", "## Recent Maintenance");
  if (maintenanceRuns.length === 0) {
    lines.push("none");
  } else {
    for (const run of maintenanceRuns) {
      lines.push(
        `- ${run.startedAt || run.createdAt || "unknown"} ${run.status || "unknown"}: ` +
          `scanned ${run.scanned ?? 0}, expired ${run.expired ?? 0}, ` +
          `deleted objects ${run.deletedObjects ?? 0}, failures ${run.failedObjects ?? 0}`
      );
    }
  }

  const largestUploads = report.largestUploads ?? [];
  lines.push("", "## Largest Uploaded Files");
  if (largestUploads.length === 0) {
    lines.push("none");
  } else {
    for (const file of largestUploads) {
      lines.push(`- ${file.name || file.key}: ${fileBytesLabel(file.size ?? 0)} [${file.id}]`);
    }
  }

  return lines.filter(Boolean);
}

function notificationKindLabel(kind) {
  if (kind === "page_edit") return "page edit";
  return String(kind || "notification").replace(/_/g, " ");
}

function notificationLines(notification) {
  return [
    `- ${notification.title || "Untitled"} (${notificationKindLabel(notification.kind)})`,
    `  id: ${notification.id}`,
    `  activity key: ${notification.activityKey}`,
    notification.pageId ? `  page id: ${notification.pageId}` : null,
    notification.blockId ? `  block id: ${notification.blockId}` : null,
    notification.commentId ? `  comment id: ${notification.commentId}` : null,
    notification.actorId ? `  actor id: ${notification.actorId}` : null,
    notification.preview ? `  preview: ${notification.preview}` : null,
    notification.target ? `  target: ${notification.target}` : null,
    `  occurred: ${notification.occurredAt || "unknown"}`,
    `  read: ${notification.readAt || "no"}`,
  ].filter(Boolean);
}

function notificationListLines(result) {
  const notifications = result.notifications ?? [];
  const lines = [
    "# Notifications",
    `workspace id: ${result.workspaceId || "unknown"}`,
    `unread: ${result.unreadCount ?? notifications.filter((item) => !item.readAt).length}`,
    `returned: ${notifications.length}`,
  ];
  if (notifications.length === 0) {
    lines.push("", "No notifications found.");
    return lines;
  }
  for (const notification of notifications) {
    lines.push("", ...notificationLines(notification));
  }
  return lines;
}

function workspaceMemberRoleLabel(role) {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "guest") return "Guest";
  return "Member";
}

function organizationLines(result) {
  const organizations = result.organizations ?? [];
  const lines = ["# Organizations", `organizations: ${organizations.length}`];
  if (organizations.length === 0) {
    lines.push("", "No accessible organizations found.");
    return lines;
  }
  for (const organization of organizations) {
    const icon = String(organization.icon ?? "").trim();
    const iconPrefix = icon && !looksLikeImageIcon(icon) ? `${icon} ` : "";
    lines.push(
      "",
      `- ${iconPrefix}${organization.name || "Untitled Organization"}`,
      `  id: ${organization.id}`,
      organization.ownerId ? `  owner id: ${organization.ownerId}` : null,
      organization.workspaceCreationPolicy
        ? `  workspace creation: ${organization.workspaceCreationPolicy}`
        : null,
      `  domain signup: ${organization.domainSignupPolicy || "invite_only"}`,
      `  storage limit: ${organization.storageLimitBytes ? fileBytesLabel(organization.storageLimitBytes) : "none"}`,
    );
  }
  return lines.filter(Boolean);
}

function organizationMemberRoleLabel(role) {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "guest") return "Guest";
  return "Member";
}

function organizationProfileLabel(profile) {
  return profile.displayName || profile.email || profile.userId || "Profile";
}

function organizationAuditLabel(event) {
  return String(event?.action ?? "organization.event")
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function organizationAuditMetadata(event) {
  const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return [
    event?.targetType ? `target: ${event.targetType}` : null,
    event?.targetId ? `target id: ${event.targetId}` : null,
    typeof metadata.domain === "string" ? `domain: ${metadata.domain}` : null,
    typeof metadata.email === "string" ? `email: ${metadata.email}` : null,
    typeof metadata.role === "string" ? `role: ${metadata.role}` : null,
    typeof metadata.workspaceCreationPolicy === "string"
      ? `workspace creation: ${metadata.workspaceCreationPolicy}`
      : null,
    typeof metadata.domainSignupPolicy === "string"
      ? `domain signup: ${metadata.domainSignupPolicy}`
      : null,
    typeof metadata.storageLimitBytes === "number"
      ? `storage limit: ${fileBytesLabel(metadata.storageLimitBytes)}`
      : metadata.storageLimitBytes === null
        ? "storage limit: none"
        : null,
    typeof metadata.clientSource === "string" ? `client source: ${metadata.clientSource}` : null,
    typeof metadata.clientId === "string" ? `client id: ${metadata.clientId}` : null,
    typeof metadata.clientName === "string" ? `client name: ${metadata.clientName}` : null,
    typeof metadata.subjectType === "string" ? `subject type: ${metadata.subjectType}` : null,
    typeof metadata.subjectId === "string" ? `subject id: ${metadata.subjectId}` : null,
    typeof metadata.policyIssuer === "string" ? `policy issuer: ${metadata.policyIssuer}` : null,
    typeof metadata.policyAudience === "string" ? `policy audience: ${metadata.policyAudience}` : null,
    typeof metadata.transport === "string" ? `transport: ${metadata.transport}` : null,
    typeof metadata.provisioningId === "string" ? `provisioning id: ${metadata.provisioningId}` : null,
    typeof metadata.backendPath === "string" ? `backend path: ${metadata.backendPath}` : null,
    typeof metadata.backendAction === "string" ? `backend action: ${metadata.backendAction}` : null,
    typeof metadata.method === "string" ? `method: ${metadata.method}` : null,
    typeof metadata.readOnly === "boolean" ? `read only: ${metadata.readOnly ? "true" : "false"}` : null,
  ].filter(Boolean);
}

function organizationMemberLines(result) {
  const organization = result.organization ?? {};
  const sharingPolicy = organization.sharingPolicy ?? {};
  const members = result.organizationMembers ?? [];
  const groups = result.organizationGroups ?? [];
  const profiles = result.organizationProfiles ?? [];
  const domains = result.organizationDomains ?? [];
  const workspaces = result.workspaces ?? [];
  const auditEvents = result.organizationAuditEvents ?? [];
  const auditFilter = result.organizationAuditFilter ?? {};
  const lines = [
    "# Organization Directory",
    `organization: ${organization.name || "unknown"}`,
    `organization id: ${organization.id || "unknown"}`,
    `workspace creation: ${organization.workspaceCreationPolicy || "owners_admins"}`,
    `domain signup: ${organization.domainSignupPolicy || "invite_only"}`,
    `storage limit: ${organization.storageLimitBytes ? fileBytesLabel(organization.storageLimitBytes) : "none"}`,
    `sharing public web: ${sharingPolicy.publicWebSharing !== false ? "on" : "off"}`,
    `sharing external email: ${sharingPolicy.externalEmailSharing !== false ? "on" : "off"}`,
    `sharing guests: ${sharingPolicy.guestAccess !== false ? "on" : "off"}`,
    `sharing file downloads: ${sharingPolicy.fileDownloads !== false ? "on" : "off"}`,
    `sharing full access grants: ${sharingPolicy.fullAccessGrants !== false ? "on" : "off"}`,
    `members: ${members.length}`,
    `groups: ${groups.length}`,
    `profiles: ${profiles.length}`,
    `domains: ${domains.length}`,
    `workspaces: ${workspaces.length}`,
    `audit events: ${auditEvents.length}`,
    auditFilter.action ? `audit action filter: ${auditFilter.action}` : null,
    auditFilter.targetType ? `audit target filter: ${auditFilter.targetType}` : null,
    auditFilter.limit ? `audit limit: ${auditFilter.limit}` : null,
  ];
  for (const domain of domains) {
    lines.push(
      "",
      `- ${domain.domain || "unknown domain"} (${domain.status || "pending"})`,
      `  id: ${domain.id}`,
      domain.verifiedAt ? `  verified at: ${domain.verifiedAt}` : null,
    );
  }
  if (domains.length === 0) lines.push("", "No organization domains found.");
  if (groups.length > 0) {
    lines.push("", "## Groups");
    for (const group of groups) {
      lines.push(
        "",
        `- ${group.name || "Untitled group"}`,
        `  id: ${group.id}`,
        `  members: ${(group.members ?? []).length}`,
      );
      for (const member of (group.members ?? []).slice(0, 5)) {
        lines.push(
          `  - ${member.displayName || member.email || member.userId || "Member"} (${organizationMemberRoleLabel(member.role)})`,
        );
      }
    }
  }
  if (auditEvents.length > 0) {
    lines.push("", "## Audit Log");
    for (const event of auditEvents.slice(0, 10)) {
      const metadata = organizationAuditMetadata(event);
      lines.push(
        "",
        `- ${organizationAuditLabel(event)}`,
        event.occurredAt ? `  occurred at: ${event.occurredAt}` : null,
        event.actorId ? `  actor id: ${event.actorId}` : null,
        ...metadata.map((item) => `  ${item}`),
      );
    }
  }
  if (profiles.length > 0) {
    lines.push("", "## Profiles");
    for (const profile of profiles.slice(0, 15)) {
      lines.push(
        "",
        `- ${organizationProfileLabel(profile)} (${organizationMemberRoleLabel(profile.organizationRole)} / ${profile.status || "active"})`,
        profile.organizationMemberId ? `  organization member id: ${profile.organizationMemberId}` : null,
        profile.userId ? `  user id: ${profile.userId}` : null,
        profile.email ? `  email: ${profile.email}` : null,
        `  workspaces: ${(profile.workspaceMemberships ?? []).length}`,
        `  pending invitations: ${(profile.pendingInvitations ?? []).length}`,
      );
      for (const membership of (profile.workspaceMemberships ?? []).slice(0, 3)) {
        lines.push(
          `  - ${membership.workspaceName || membership.workspaceId} (${organizationMemberRoleLabel(membership.role)})`,
        );
      }
    }
  }
  for (const member of members) {
    lines.push(
      "",
      `- ${member.displayName || member.email || member.userId || "Member"} (${organizationMemberRoleLabel(member.role)})`,
      `  id: ${member.id}`,
      `  user id: ${member.userId}`,
      member.email ? `  email: ${member.email}` : null,
      `  status: ${member.status || "active"}`,
      member.deactivatedAt ? `  deactivated at: ${member.deactivatedAt}` : null,
    );
  }
  if (members.length === 0) lines.push("", "No organization members found.");
  return lines.filter(Boolean);
}

function organizationPeopleSearchLines(result) {
  const organization = result.organization ?? {};
  const people = result.people ?? [];
  const lines = [
    "# Organization People Search",
    `organization: ${organization.name || "unknown"}`,
    `organization id: ${organization.id || "unknown"}`,
    `query: ${result.query || ""}`,
    `people: ${people.length}`,
  ];
  for (const profile of people) {
    lines.push(
      "",
      `- ${organizationProfileLabel(profile)} (${organizationMemberRoleLabel(profile.organizationRole)} / ${profile.status || "active"})`,
      profile.organizationMemberId ? `  organization member id: ${profile.organizationMemberId}` : null,
      profile.userId ? `  user id: ${profile.userId}` : null,
      profile.email ? `  email: ${profile.email}` : null,
      `  workspaces: ${(profile.workspaceMemberships ?? []).length}`,
      `  pending invitations: ${(profile.pendingInvitations ?? []).length}`,
    );
    for (const membership of (profile.workspaceMemberships ?? []).slice(0, 3)) {
      lines.push(
        `  - ${membership.workspaceName || membership.workspaceId} (${organizationMemberRoleLabel(membership.role)})`,
      );
    }
  }
  if (people.length === 0) lines.push("", "No matching organization people found.");
  return lines.filter(Boolean);
}

function workspaceMemberLabel(member) {
  return member.displayName || member.email || member.userId || "Member";
}

function requireOfficialNotionUser(user) {
  if (
    !user
    || typeof user !== "object"
    || Array.isArray(user)
    || user.object !== "user"
    || typeof user.id !== "string"
    || !user.id.trim()
    || !["person", "bot"].includes(user.type)
  ) {
    throw new Error("Canonical user response was malformed.");
  }
  if (
    user.type === "person"
    && (
      !user.person
      || typeof user.person !== "object"
      || Array.isArray(user.person)
      || (user.person.email !== undefined && typeof user.person.email !== "string")
    )
  ) {
    throw new Error("Canonical user response was malformed.");
  }
  if (
    user.type === "bot"
    && (
      !user.bot
      || typeof user.bot !== "object"
      || Array.isArray(user.bot)
    )
  ) {
    throw new Error("Canonical user response was malformed.");
  }
  return user;
}

function officialNotionUsers(payload, { direct = false } = {}) {
  if (direct) {
    return {
      results: [requireOfficialNotionUser(payload)],
      hasMore: false,
      nextCursor: null,
    };
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || payload.object !== "list"
    || payload.type !== "user"
    || !Array.isArray(payload.results)
    || typeof payload.has_more !== "boolean"
    || (payload.has_more === true && (typeof payload.next_cursor !== "string" || !payload.next_cursor.trim()))
    || (payload.has_more === false && payload.next_cursor !== null)
  ) {
    throw new Error("Canonical user response was malformed.");
  }
  return {
    results: payload.results.map(requireOfficialNotionUser),
    hasMore: payload.has_more,
    nextCursor: payload.has_more ? payload.next_cursor.trim() : null,
  };
}

function officialNotionUserEmail(user) {
  return user?.person && typeof user.person === "object" && typeof user.person.email === "string"
    ? user.person.email
    : "";
}

function flatNotionUser(user, workspaceId) {
  const email = officialNotionUserEmail(user);
  return {
    type: "person",
    id: String(user?.id ?? ""),
    name: String(user?.name ?? user?.id ?? "Hanji user"),
    ...(email ? { email } : {}),
    workspace_id: workspaceId,
  };
}

function workspaceMemberLines(result) {
  const members = result.members ?? [];
  const workspace = result.workspace ?? {};
  const lines = [
    "# Workspace Members",
    `workspace: ${workspace.name || "unknown"}`,
    `workspace id: ${workspace.id || result.workspaceId || "unknown"}`,
    `members: ${members.length}`,
  ];
  if (members.length === 0) {
    lines.push("", "No workspace members found.");
    return lines;
  }
  for (const member of members) {
    lines.push(
      "",
      `- ${workspaceMemberLabel(member)} (${workspaceMemberRoleLabel(member.role)})`,
      `  id: ${member.id}`,
      `  user id: ${member.userId}`,
      member.email ? `  email: ${member.email}` : null,
      member.createdBy ? `  created by: ${member.createdBy}` : null,
    );
  }
  return lines.filter(Boolean);
}

function workspaceLabel(workspace) {
  const icon = String(workspace.icon ?? "").trim();
  const iconPrefix = icon && !looksLikeImageIcon(icon) ? `${icon} ` : "";
  return `${iconPrefix}${workspace.name || "Untitled"}`;
}

function workspaceLines(result) {
  const workspaces = result.workspaces ?? [];
  const lines = ["# Workspaces"];
  if (result.workspace) {
    lines.push(
      `created workspace: ${workspaceLabel(result.workspace)}`,
      `created workspace id: ${result.workspace.id}`,
    );
    if (result.workspace.domain) lines.push(`created workspace URL: /workspace/${result.workspace.domain}`);
  }
  if (result.deletedId) lines.push(`deleted workspace id: ${result.deletedId}`);
  if (typeof result.deletedMembers === "number") lines.push(`deleted member records: ${result.deletedMembers}`);
  if (typeof result.deletedInvitations === "number") {
    lines.push(`deleted invitation records: ${result.deletedInvitations}`);
  }
  lines.push(`workspaces: ${workspaces.length}`);
  if (workspaces.length === 0) {
    lines.push("", "No accessible workspaces found.");
    return lines;
  }
  for (const workspace of workspaces) {
    lines.push(
      "",
      `- ${workspaceLabel(workspace)}`,
      `  id: ${workspace.id}`,
      workspace.organizationId ? `  organization id: ${workspace.organizationId}` : null,
      workspace.domain ? `  URL: /workspace/${workspace.domain}` : "  URL: none",
      workspace.ownerId ? `  owner id: ${workspace.ownerId}` : null,
    );
  }
  return lines.filter(Boolean);
}

function workspaceStructuredContent(result) {
  const workspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
  const normalize = (workspace) => ({
    id: String(workspace?.id ?? ""),
    name: String(workspace?.name ?? "Untitled"),
    icon: typeof workspace?.icon === "string" && workspace.icon ? workspace.icon : null,
    iconType: typeof workspace?.iconType === "string" && workspace.iconType ? workspace.iconType : null,
    organizationId:
      typeof workspace?.organizationId === "string" && workspace.organizationId
        ? workspace.organizationId
        : null,
    domain: typeof workspace?.domain === "string" && workspace.domain ? workspace.domain : null,
    ownerId: typeof workspace?.ownerId === "string" && workspace.ownerId ? workspace.ownerId : null,
    notionTeamspaceId: String(workspace?.id ?? ""),
    scopeModel: "hanji_connection_workspace",
  });
  return {
    scopeModel: "hanji_connection_selected_workspaces",
    notionCompatibilityNote:
      "This Hanji MCP connection exposes only its fixed selected workspaces. Choose one listed workspace id and pass it as workspace_id to workspace-bound tools. Notion-compatible teamspace_id is accepted as an alias.",
    count: workspaces.length,
    workspaces: workspaces.map(normalize).filter((workspace) => workspace.id),
  };
}

function databaseSummaryStructuredContent(database) {
  return {
    id: String(database?.id ?? ""),
    title: String(database?.title || "Untitled"),
    label: titleOf(database ?? {}),
    icon: typeof database?.icon === "string" && database.icon ? database.icon : null,
    iconType: typeof database?.iconType === "string" && database.iconType ? database.iconType : null,
    workspaceId: typeof database?.workspaceId === "string" && database.workspaceId ? database.workspaceId : null,
    parentId: typeof database?.parentId === "string" && database.parentId ? database.parentId : null,
    parentType: typeof database?.parentType === "string" && database.parentType ? database.parentType : null,
  };
}

function databasePropertyStructuredContent(prop) {
  return {
    id: String(prop?.id ?? ""),
    name: String(prop?.name || "Untitled"),
    type: String(prop?.type || "rich_text"),
    position: Number.isFinite(prop?.position) ? prop.position : null,
  };
}

function databaseViewStructuredContent(view, props = []) {
  const config = view?.config ?? {};
  return {
    id: String(view?.id ?? ""),
    name: String(view?.name || "Untitled"),
    type: String(view?.type || "table"),
    position: Number.isFinite(view?.position) ? view.position : null,
    filterCount: config.filterGroup ? filterGroupTermCount(config.filterGroup) : (config.filters ?? []).length,
    sorts: (config.sorts ?? []).map((sort) => ({
      propertyId: String(sort.propertyId ?? ""),
      propertyName: propertyLabel(props, sort.propertyId),
      direction: String(sort.direction ?? "asc"),
    })),
    visiblePropertyIds: (config.visibleProperties ?? []).map(String),
    hiddenPropertyIds: (config.hiddenProperties ?? []).map(String),
    propertyOrder: (config.propertyOrder ?? []).map(String),
    tableCalculations: Object.entries(config.tableCalculations ?? {}).map(([propertyId, calculation]) => ({
      propertyId,
      propertyName: propertyLabel(props, propertyId),
      calculation: String(calculation ?? ""),
    })),
    groupBy: config.groupBy ? String(config.groupBy) : null,
    subGroupBy: config.subGroupBy ? String(config.subGroupBy) : null,
    calendarBy: config.calendarBy ? String(config.calendarBy) : null,
    timelineBy: config.timelineBy ? String(config.timelineBy) : null,
  };
}

function describeDatabaseStructuredContent(database, props = [], views = [], rows = [], message = null) {
  return {
    database: database ? databaseSummaryStructuredContent(database) : null,
    rowCount: rows.length,
    properties: props.map(databasePropertyStructuredContent),
    views: views.map((view) => databaseViewStructuredContent(view, props)),
    message,
  };
}

function databaseQueryCellStructuredContent(row, prop, pagesById = {}, props = [], propsByDb = {}) {
  return {
    propertyId: String(prop.id),
    propertyName: String(prop.name || prop.id),
    propertyType: String(prop.type || "rich_text"),
    value: cloneJson(propValue(row, prop)),
    text: formatDbValue(row, prop, pagesById, props, propsByDb),
  };
}

function queryDatabaseStructuredContent({
  database,
  view = null,
  visibleProps = [],
  rows = [],
  totalMatching = 0,
  limit = 25,
  search = "",
  pagesById = {},
  props = [],
  propsByDb = {},
  message = null,
}) {
  return {
    database: database ? databaseSummaryStructuredContent(database) : null,
    view: view ? databaseViewStructuredContent(view, props) : null,
    totalMatching,
    returned: rows.length,
    limit,
    search: search ? String(search) : null,
    columns: visibleProps.map((prop) => ({
      propertyId: String(prop.id),
      name: String(prop.name || prop.id),
      type: String(prop.type || "rich_text"),
    })),
    rows: rows.map((row) => ({
      id: String(row.id),
      title: String(row.title || "Untitled"),
      cells: visibleProps.map((prop) => databaseQueryCellStructuredContent(row, prop, pagesById, props, propsByDb)),
    })),
    message,
  };
}

function pageUrl(pageId) {
  return `${BASE_URL}/p/${pageId}`;
}

function collectionUrl(databaseId) {
  return `collection://${databaseId}`;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Untrusted body text (block markdown, comment bodies) is embedded inside
// tool-generated framing (the <page>/<content> envelope, comment listings). A
// page containing "</content></page>" plus forged structure could otherwise
// spoof the tool's own authoritative framing. Full xmlEscape would destroy
// markdown readability, so neutralize only openers of the framing tags,
// leaving the rest of the markdown byte-identical.
// The alternation lists every authoritative tag the MCP tools emit around
// untrusted text. `data-source\b` also covers <data-source-state> (the "\b"
// falls on the "-" before "state"); <page-discussions> is covered by "page".
const FRAMING_TAG_PATTERN =
  /<(?=\/?(?:content|page|properties|ancestor-path|discussions?|comment|quote|anchor|data-source|data-source-state|sqlite-table|columns?|empty-block|database|meeting-notes|transcript)\b)/gi;

export function escapeFramingBreakouts(value) {
  return String(value ?? "").replace(FRAMING_TAG_PATTERN, "&lt;");
}

function jsonText(value) {
  return JSON.stringify(value ?? {});
}

function notionEntityType(page) {
  if (page?.parentType === "database") return "page";
  return page?.kind === "database" ? "database" : "page";
}

function notionSearchResult(page, highlight = "") {
  return {
    id: String(page.id),
    title: titleOf(page),
    url: pageUrl(page.id),
    type: notionEntityType(page),
    workspace_id: page.workspaceId ?? null,
    highlight: String(highlight || page.title || titleOf(page)),
    timestamp: page.updatedAt || page.lastEditedAt || page.createdAt || null,
  };
}

function notionSearchResponse(results, type = "workspace_search", extra = {}) {
  return { results, type, ...extra };
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function selectedWorkspaceId(input = {}) {
  const raw = input.workspace_id ?? input.workspaceId ?? input.teamspace_id;
  return String(raw ?? "").trim() ? stripHanjiId(raw) : "";
}

function connectionWorkspaceSelectionPayload(workspaces, toolName) {
  return {
    error: "workspace_id_required",
    tool: toolName,
    message:
      "Choose one workspace authorized for this connection and pass its id as workspace_id. Notion-compatible teamspace_id is accepted as an alias.",
    required_argument: "workspace_id",
    accepted_aliases: ["teamspace_id", "workspaceId"],
    workspaces: workspaceStructuredContent({ workspaces }).workspaces,
  };
}

async function requireWorkspaceSelection(input, toolName) {
  const workspaceId = selectedWorkspaceId(input);
  if (workspaceId) return { workspaceId };
  const workspaces = await connectionSelectedWorkspaces();
  return {
    errorResult: {
      content: [
        {
          type: /** @type {"text"} */ ("text"),
          text: JSON.stringify(connectionWorkspaceSelectionPayload(workspaces, toolName)),
        },
      ],
      isError: true,
    },
  };
}

async function requireMatchingWorkspace(input, entity, toolName, label = "target") {
  const selected = await requireWorkspaceSelection(input, toolName);
  if (selected.errorResult) return selected;
  const entityWorkspaceId = entity?.workspaceId ?? null;
  if (entityWorkspaceId && selected.workspaceId !== entityWorkspaceId) {
    return {
      errorResult: fail(
        new Error(
          `${label} belongs to workspace ${entityWorkspaceId}, but ${toolName} was called with workspace_id ${selected.workspaceId}.`
        )
      ),
    };
  }
  return selected;
}

function hanjiScopeMetadata({
  workspaceIds = [],
  requestedTeamspaceId = null,
  target = "workspace_search",
  source = "connection",
  pageScopeWorkspaceId = null,
  conflict = null,
} = {}) {
  const effectiveWorkspaceIds = uniqueStrings(workspaceIds);
  return {
    scope: {
      provider: "hanji",
      access_model: "connection_selected_workspaces",
      notion_reference_model: "workspace_scoped_connection",
      target,
      source,
      teamspace_id_alias: "Hanji workspace_id",
      requested_teamspace_id: requestedTeamspaceId || null,
      effective_workspace_ids: effectiveWorkspaceIds,
      page_scope_workspace_id: pageScopeWorkspaceId || null,
      conflict,
      note:
        "This connection is limited to its fixed selected workspaces. workspace_id is required for workspace-bound tools, and Notion-compatible teamspace_id is accepted as a Hanji workspace_id alias.",
    },
  };
}

async function connectionSelectedWorkspaces() {
  const result = await eb.listWorkspaces();
  const listed = Array.isArray(result?.workspaces) ? result.workspaces.filter((workspace) => workspace?.id) : [];
  if (listed.length) return listed;
  const workspace = await eb.workspace();
  return workspace?.id ? [workspace] : [];
}

async function hanjiWorkspaceScope(teamspaceId) {
  const requestedTeamspaceId = String(teamspaceId ?? "").trim()
    ? stripHanjiId(teamspaceId)
    : null;
  if (!requestedTeamspaceId) {
    return {
      requestedTeamspaceId: null,
      workspaces: [],
      workspaceIds: [],
      source: "missing_required_workspace_id",
    };
  }
  // requestedTeamspaceId is guaranteed non-null here (the branch above returns
  // otherwise), so resolve the teamspace-scoped workspace unconditionally.
  return {
    requestedTeamspaceId,
    workspaces: [{ id: requestedTeamspaceId, name: requestedTeamspaceId }],
    workspaceIds: [requestedTeamspaceId],
    source: "teamspace_id_workspace_filter",
  };
}

function dateKeyForSearch(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function creatorIdForSearch(entity) {
  return String(
    entity?.createdByUserId ??
      entity?.createdById ??
      entity?.createdBy ??
      entity?.createdByUser ??
      entity?.authorId ??
      ""
  );
}

function matchesNotionSearchFilters(entity, filters = {}) {
  const input = /** @type {Record<string, any>} */ (
    filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {}
  );
  const range = input.created_date_range;
  if (range && typeof range === "object" && !Array.isArray(range)) {
    const created = dateKeyForSearch(entity?.createdAt ?? entity?.createdTime);
    if (!created) return false;
    if (range.start_date && created < String(range.start_date).slice(0, 10)) return false;
    if (range.end_date && created > String(range.end_date).slice(0, 10)) return false;
  }

  if (Array.isArray(input.created_by_user_ids) && input.created_by_user_ids.length) {
    const creator = creatorIdForSearch(entity);
    if (!creator || !input.created_by_user_ids.map(String).includes(creator)) return false;
  }

  return true;
}

function propertySchemaForNotion(prop) {
  const schema = {
    name: prop.name,
    type: prop.type === "rich_text" ? "text" : prop.type,
  };
  if (prop.description) schema.description = prop.description;
  if (prop.config?.options?.length) {
    schema.options = prop.config.options.map((option) => ({
      name: option.name,
      color: option.color ?? "default",
      description: option.description ?? "",
      url: `collectionPropertyOption://${prop.databaseId ?? ""}/${prop.id}/${option.id}`,
    }));
  }
  if (prop.config?.relationDatabaseId) schema.dataSourceUrl = collectionUrl(prop.config.relationDatabaseId);
  schema.propertyUrl = `collectionProperty://${prop.databaseId ?? ""}/${prop.id}`;
  return schema;
}

function sqliteTypeForProperty(prop) {
  if (prop.type === "number" || prop.type === "unique_id") return "REAL";
  return "TEXT";
}

function sqliteCommentForProperty(prop) {
  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    const options = (prop.config?.options ?? []).map((option) => `"${option.name}"`).join(", ");
    return options ? ` -- one of [${options}]` : "";
  }
  if (prop.type === "checkbox") return ' -- "__YES__" = true, "__NO__" = false, NULL defaults to false';
  if (prop.type === "relation" && prop.config?.relationDatabaseId) {
    return ` -- JSON array of page URLs relating to ${collectionUrl(prop.config.relationDatabaseId)} data source`;
  }
  if (prop.type === "created_time" || prop.type === "last_edited_time") {
    return " -- ISO-8601 datetime string";
  }
  return prop.description ? ` -- ${String(prop.description).replace(/\n/g, " ")}` : "";
}

function dataSourceStateForNotion(db, props = [], templates = []) {
  return {
    name: db.title || "Untitled",
    url: collectionUrl(db.id),
    description: typeof db.properties?.notionDescription === "string" ? db.properties.notionDescription : "",
    is_inline: typeof db.properties?.notionIsInline === "boolean"
      ? db.properties.notionIsInline
      : db.parentType === "page",
    ...(db.properties?.notionDatabaseType ? { database_type: db.properties.notionDatabaseType } : {}),
    default_page_template: templates.find((template) => template.isDefault)?.id ?? null,
    page_templates: templates.map((template) => ({
      name: template.name || "Untitled",
      url: pageUrl(template.id),
    })),
    schema: Object.fromEntries(props.map((prop) => [prop.name, propertySchemaForNotion(prop)])),
  };
}

function sqliteTableForNotion(db, props = []) {
  const lines = [
    `CREATE TABLE IF NOT EXISTS "${collectionUrl(db.id)}" (`,
    "\turl TEXT UNIQUE,",
    "\tcreatedTime TEXT, -- ISO-8601 datetime string, automatically set.",
    ...props.map((prop, index) => {
      const comma = index === props.length - 1 ? "" : ",";
      return `\t"${prop.name}" ${sqliteTypeForProperty(prop)}${comma}${sqliteCommentForProperty(prop)}`;
    }),
    ")",
  ];
  return lines.join("\n");
}

async function notionDataSourceFetchPayload(db) {
  const [props, templates] = await Promise.all([eb.dbProperties(db.id), eb.dbTemplates(db.id)]);
  const state = dataSourceStateForNotion(db, props, templates);
  const text = [
    `<data-source url="${xmlEscape(collectionUrl(db.id))}">`,
    // db.title, the JSON state (property names/descriptions, option names,
    // template names), and the SQLite schema (property names/comments) are all
    // workspace-authored: neutralize framing-tag openers so a property named
    // "</sqlite-table>…" or a title carrying "</data-source>" cannot break out
    // of this envelope. JSON/xmlEscape do not cover "<".
    `The title of this Data Source is: ${escapeFramingBreakouts(db.title || "Untitled")}`,
    "",
    "Here is the database's configurable state:",
    "Properties with `readOnly: true` are synced or system-managed. Do not try to update their values with page update tools.",
    "<data-source-state>",
    escapeFramingBreakouts(jsonText(state)),
    "</data-source-state>",
    "",
    "Here is the SQLite table definition for this data source.",
    "<sqlite-table>",
    escapeFramingBreakouts(sqliteTableForNotion(db, props)),
    "</sqlite-table>",
    "</data-source>",
  ].join("\n");
  return {
    metadata: {
      type: "data_source",
      provider: "hanji",
      scope_model: "account_accessible_workspaces",
      workspace_id: db.workspaceId ?? null,
      notion_teamspace_id_alias: db.workspaceId ?? null,
    },
    title: db.title || "Untitled",
    url: pageUrl(db.id),
    text,
  };
}

function ancestorPathForPage(page, pagesById) {
  const ancestors = [];
  let current = page.parentId ? pagesById[page.parentId] : null;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ancestors.push(current);
    current = current.parentId ? pagesById[current.parentId] : null;
  }
  if (!ancestors.length) return "<ancestor-path></ancestor-path>";
  const lines = ["<ancestor-path>"];
  ancestors.forEach((ancestor, index) => {
    const tag = ancestor.kind === "database" ? "database" : "page";
    const prefix = index === 0 ? "parent" : `ancestor-${index + 1}`;
    lines.push(`<${prefix}-${tag} url="${xmlEscape(pageUrl(ancestor.id))}" title="${xmlEscape(ancestor.title || "")}"/>`);
  });
  lines.push("</ancestor-path>");
  return lines.join("\n");
}

function pagePropertiesForNotion(page, pagesById, props = [], propsByDb = {}) {
  const properties = { title: page.title || "Untitled" };
  if (page.parentType !== "database" || !props.length) return properties;
  properties.url = pageUrl(page.id);
  for (const prop of props) {
    properties[prop.name] = formatDbValue(page, prop, pagesById, props, propsByDb);
  }
  return properties;
}

function blockPlainText(block) {
  return richPlain({ rich: block.content?.rich }) || block.plainText || "";
}

function enhancedBlockLine(block, pagesById) {
  if (block.type === "paragraph" && !blockPlainText(block).trim()) return "<empty-block/>";
  if (block.type === "child_page" || block.type === "link_to_page") {
    const target = pagesById[block.content?.childPageId];
    const label = block.plainText || target?.title || "Untitled";
    return `<page url="${xmlEscape(pageUrl(target?.id ?? block.content?.childPageId ?? ""))}">${xmlEscape(label)}</page>`;
  }
  if (block.type === "child_database" || block.type === "inline_database") {
    const target = pagesById[block.content?.childPageId];
    const label = block.plainText || target?.title || "Untitled";
    const id = target?.id ?? block.content?.childPageId ?? "";
    const inline = block.type === "inline_database" ? "true" : "false";
    return `<database url="${xmlEscape(pageUrl(id))}" inline="${inline}" data-source-url="${xmlEscape(collectionUrl(id))}">${xmlEscape(label)}</database>`;
  }
  // Every other block type renders untrusted rich-text markdown: neutralize
  // sequences that could break out of the <content> envelope or forge the
  // tool's own framing tags. The tool-generated tags above stay intact.
  return escapeFramingBreakouts(blockToMarkdown(block));
}

function enhancedBlocksToMarkdown(blocks, pagesById, parentId = null, depth = 0) {
  const out = [];
  const indent = "\t".repeat(depth);
  for (const block of blocks
    .filter((item) => (item.parentId ?? null) === parentId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (block.type === "column_list") {
      const columns = blocks
        .filter((item) => item.parentId === block.id && item.type === "column")
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      out.push(`${indent}<columns>`);
      for (const column of columns) {
        out.push(`${indent}\t<column>`);
        const body = enhancedBlocksToMarkdown(blocks, pagesById, column.id, depth + 2);
        if (body) out.push(body);
        out.push(`${indent}\t</column>`);
      }
      out.push(`${indent}</columns>`);
      continue;
    }
    if (block.type === "column") {
      const body = enhancedBlocksToMarkdown(blocks, pagesById, block.id, depth);
      if (body) out.push(body);
      continue;
    }
    const line = enhancedBlockLine(block, pagesById);
    if (line) out.push(line.split("\n").map((part) => `${indent}${part}`).join("\n"));
    const children = enhancedBlocksToMarkdown(blocks, pagesById, block.id, depth + 1);
    if (children) out.push(children);
  }
  return out.join("\n");
}

async function notionPageFetchPayload(page, includeDiscussions = false, transcripts = null) {
  const [blocks, pages] = await Promise.all([eb.blocks(page.id), eb.pageProjection({ workspaceId: page.workspaceId })]);
  const pagesById = Object.fromEntries(pages.map((item) => [item.id, item]));
  const props = page.parentType === "database" && page.parentId ? await eb.dbProperties(page.parentId) : [];
  const propsByDb = props.length ? await databasePropsContext(pages, page.parentId, props) : {};
  const properties = pagePropertiesForNotion(page, pagesById, props, propsByDb);
  const visibleBlocks = withoutMeetingTranscriptSubtrees(blocks);
  const regularContent = enhancedBlocksToMarkdown(visibleBlocks, pagesById) || "<empty-block/>";
  const transcriptContent = transcripts === null
    ? ""
    : meetingTranscriptMarkdown(transcripts, { xmlEscape, escapeFramingBreakouts });
  const content = [regularContent, transcriptContent].filter(Boolean).join("\n");
  let discussionSummary = "";
  if (includeDiscussions) {
    const comments = await eb.comments(page.id);
    discussionSummary = `\n<page-discussions count="${comments.length}"/>`;
  }
  const icon = page.icon ? ` icon="${xmlEscape(page.icon)}"` : "";
  const text = [
    `Here is the result of "view" for the Page with URL ${pageUrl(page.id)} as of ${new Date().toISOString()}:`,
    `<page url="${xmlEscape(pageUrl(page.id))}"${icon}>`,
    ancestorPathForPage(page, pagesById),
    "<properties>",
    // Property values are untrusted; JSON.stringify escapes quotes but not
    // "<", so neutralize framing-tag openers here too.
    escapeFramingBreakouts(jsonText(properties)),
    "</properties>",
    discussionSummary.trim() ? discussionSummary.trim() : null,
    "<content>",
    content,
    "</content>",
    "</page>",
  ].filter(Boolean).join("\n");
  return {
    metadata: {
      type: "page",
      provider: "hanji",
      scope_model: "account_accessible_workspaces",
      workspace_id: page.workspaceId ?? null,
      notion_teamspace_id_alias: page.workspaceId ?? null,
    },
    title: titleOf(page),
    url: pageUrl(page.id),
    text,
    ...(transcripts === null ? {} : { transcripts }),
  };
}

const NOTION_SEARCH_SOURCE_WINDOW = 100;
const NOTION_SEARCH_MAX_WINDOWS_PER_CALL = 10;
const NOTION_SEARCH_PENDING_REVISION = "pending-first-window";

function searchCursorKind(state, allowedKinds) {
  if (!state) return null;
  if (!allowedKinds.includes(state.kind)) {
    throw new Error("Search cursor does not match this search branch.");
  }
  return state.kind;
}

function searchSourcePage(payload, itemsKey, offsetsKey, requestedOffset) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Search source response was malformed.");
  }
  const items = payload[itemsKey];
  if (!Array.isArray(items) || items.length > NOTION_SEARCH_SOURCE_WINDOW) {
    throw new Error("Search source response was malformed.");
  }
  const revision = String(payload.revision ?? "").trim();
  if (!revision || revision.length > 512) {
    throw new Error("Search source revision was malformed.");
  }
  const suppliedOffsets = payload[offsetsKey];
  const offsets = Array.isArray(suppliedOffsets)
    ? suppliedOffsets
    : items.map((_item, index) => requestedOffset + index);
  if (
    offsets.length !== items.length
    || offsets.some((offset, index) =>
      !Number.isSafeInteger(offset)
      || offset < requestedOffset
      || (index > 0 && offset <= offsets[index - 1]))
  ) {
    throw new Error("Search source offsets were malformed.");
  }
  const hasMore = payload.hasMore === true;
  const nextOffset = hasMore ? payload.nextOffset : null;
  if (
    hasMore
    && (!Number.isSafeInteger(nextOffset) || nextOffset <= requestedOffset)
  ) {
    throw new Error("Search source pagination was malformed.");
  }
  if (!hasMore && payload.nextOffset !== undefined && payload.nextOffset !== null) {
    throw new Error("Search source pagination was malformed.");
  }
  return { items, offsets, revision, hasMore, nextOffset };
}

function workspaceSearchSourcePage(payload, itemsKey, requestedCursor, requestedLimit) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Workspace search source response was malformed.");
  }
  const items = payload[itemsKey];
  if (
    !Array.isArray(items)
    || items.length > requestedLimit
    || items.length > NOTION_SEARCH_SOURCE_WINDOW
  ) {
    throw new Error("Workspace search source response was malformed.");
  }
  const revision = String(payload.revision ?? "").trim();
  if (!revision || revision.length > 512) {
    throw new Error("Workspace search source revision was malformed.");
  }
  if (typeof payload.hasMore !== "boolean") {
    throw new Error("Workspace search source pagination was malformed.");
  }
  const nextCursor = payload.hasMore ? payload.nextCursor : null;
  if (
    payload.hasMore
    && (
      typeof nextCursor !== "string"
      || nextCursor.length === 0
      || nextCursor.length > 16 * 1024
      || nextCursor === requestedCursor
    )
  ) {
    throw new Error("Workspace search source pagination did not advance.");
  }
  if (!payload.hasMore && payload.nextCursor !== undefined && payload.nextCursor !== null) {
    throw new Error("Workspace search source pagination was malformed.");
  }
  return { items, revision, hasMore: payload.hasMore, nextCursor };
}

function requireStableSearchRevision(expected, actual) {
  if (expected && expected !== NOTION_SEARCH_PENDING_REVISION && expected !== actual) {
    throw new Error("Search cursor expired because the searchable source changed.");
  }
  return actual;
}

function sourceContinuation(kind, offset, revision) {
  return {
    kind,
    offset,
    revision,
  };
}

function workspaceSourceContinuation(kind, sourceCursor, revision) {
  return {
    kind,
    sourceCursor: sourceCursor ?? null,
    revision,
  };
}

async function databaseRowsForNotionSearch(
  databaseId,
  database,
  query,
  limit,
  filters = {},
  cursorState = null,
) {
  const safeLimit = clamp(limit, 1, 25);
  searchCursorKind(cursorState, ["data_source"]);
  if (!database || database.kind !== "database") {
    return { results: [], nextState: null, requestStatus: null };
  }
  const [props, pages] = await Promise.all([
    eb.dbProperties(databaseId),
    eb.pages(),
  ]);
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const needle = String(query ?? "").trim().toLowerCase();
  const accepted = [];
  let offset = cursorState?.offset ?? 0;
  let revision = cursorState?.revision ?? null;
  let hasPhysicalMore = false;
  let nextPhysicalOffset = null;
  let windows = 0;

  while (accepted.length <= safeLimit && windows < NOTION_SEARCH_MAX_WINDOWS_PER_CALL) {
    const payload = await eb.databaseRowsPage(databaseId, {
      includeComputed: true,
      limit: NOTION_SEARCH_SOURCE_WINDOW,
      offset,
    });
    const page = searchSourcePage(payload, "rows", "rowOffsets", offset);
    revision = requireStableSearchRevision(revision, page.revision);
    for (let index = 0; index < page.items.length; index += 1) {
      const row = page.items[index];
      if (!row || typeof row !== "object" || !String(row.id ?? "").trim()) {
        throw new Error("Search data-source row was malformed.");
      }
      if (!matchesNotionSearchFilters(row, filters)) continue;
      const values = props.map((prop) => formatDbValue(row, prop, pagesById, props));
      const haystack = [row.title, ...values].join("\n");
      if (needle && !haystack.toLowerCase().includes(needle)) continue;
      const highlight = values.find((value) => needle && value.toLowerCase().includes(needle));
      accepted.push({
        result: notionSearchResult(row, highlight || row.title),
        sourceOffset: page.offsets[index],
      });
      if (accepted.length > safeLimit) break;
    }
    windows += 1;
    hasPhysicalMore = page.hasMore;
    nextPhysicalOffset = page.nextOffset;
    if (accepted.length > safeLimit || !page.hasMore) break;
    offset = page.nextOffset;
  }

  const lookahead = accepted[safeLimit];
  const nextState = lookahead
    ? sourceContinuation("data_source", lookahead.sourceOffset, revision)
    : hasPhysicalMore && Number.isSafeInteger(nextPhysicalOffset)
      ? sourceContinuation("data_source", nextPhysicalOffset, revision)
      : null;
  return {
    results: accepted.slice(0, safeLimit).map(({ result }) => result),
    nextState,
    requestStatus: null,
  };
}

function collectPageSubtree(pages, rootId) {
  const childrenByParent = new Map();
  for (const page of pages) {
    if (!page.parentId) continue;
    const list = childrenByParent.get(page.parentId) ?? [];
    list.push(page);
    childrenByParent.set(page.parentId, list);
  }

  const out = new Set();
  const collect = (pageId) => {
    if (out.has(pageId)) return;
    out.add(pageId);
    for (const child of childrenByParent.get(pageId) ?? []) collect(child.id);
  };
  collect(rootId);
  return out;
}

function hasTrashedAncestor(pagesById, page) {
  let current = page.parentId ? pagesById[page.parentId] : undefined;
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    if (current.inTrash) return true;
    current = current.parentId ? pagesById[current.parentId] : undefined;
  }
  return false;
}

function siblingPages(pages, parentId, parentType, excludeId) {
  return pages
    .filter((page) => {
      if (page.inTrash || page.id === excludeId) return false;
      if (parentType === "workspace") return page.parentId == null || page.parentType === "workspace";
      return page.parentId === parentId && page.parentType === parentType;
    })
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function normalizeParentInput(parentId, parentType) {
  const cleanParentId = typeof parentId === "string" && parentId.trim() ? parentId.trim() : null;
  const cleanParentType = parentType ?? (cleanParentId ? "page" : "workspace");
  if (cleanParentType === "workspace") {
    if (cleanParentId) throw new Error("workspace moves should omit parentId.");
    return { parentId: null, parentType: "workspace" };
  }
  if (!cleanParentId) throw new Error(`${cleanParentType} moves require parentId.`);
  return { parentId: cleanParentId, parentType: cleanParentType };
}

async function movePage(pageId, opts = {}) {
  const pages = await eb.allPages();
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const page = pagesById[pageId];
  if (!page) return null;
  if (page.inTrash) throw new Error(`Cannot move "${titleOf(page)}" while it is in trash.`);
  assertCanMoveFromParent(pagesById, page);

  const { parentId, parentType } = normalizeParentInput(opts.parentId, opts.parentType);
  assertCanMoveIntoParent(pagesById, parentId);
  if (parentType !== "workspace") {
    const parent = pagesById[parentId];
    if (!parent || parent.inTrash) throw new Error(`Parent ${parentId} not found.`);
    if (parentType === "database" && page.kind !== "page") {
      throw new Error("Only regular pages can be moved into a database.");
    }
    if (parentType === "database" && parent.kind !== "database") {
      throw new Error(`Parent ${parentId} is not a database.`);
    }
    if (parentType === "page" && parent.kind !== "page") {
      throw new Error(`Parent ${parentId} is not a page.`);
    }
    if (collectPageSubtree(pages, pageId).has(parentId)) {
      throw new Error("Cannot move a page inside itself or one of its descendants.");
    }
  }

  const siblings = siblingPages(pages, parentId, parentType, pageId);
  const after = opts.afterPageId ? siblings.find((item) => item.id === opts.afterPageId) : undefined;
  const before = opts.beforePageId ? siblings.find((item) => item.id === opts.beforePageId) : undefined;
  if (opts.afterPageId && !after) throw new Error(`afterPageId ${opts.afterPageId} is not a destination sibling.`);
  if (opts.beforePageId && !before) throw new Error(`beforePageId ${opts.beforePageId} is not a destination sibling.`);
  if (after && before && (after.position ?? 0) >= (before.position ?? 0)) {
    throw new Error("afterPageId must come before beforePageId.");
  }

  const position =
    after || before
      ? positionBetween(after?.position, before?.position)
      : positionBetween(siblings[siblings.length - 1]?.position, undefined);

  return eb.moveNotionPage(page, {
    parentId,
    parentType,
    parent: parentId ? pagesById[parentId] : null,
    position,
    dryRun: opts.dryRun === true,
  });
}

async function trashPageTree(pageId) {
  const pages = await eb.allPages();
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const root = pagesById[pageId];
  if (!root) return null;
  if (root.parentType === "database") {
    const result = await eb.trashDatabaseRow(pageId);
    return {
      page: result.row ?? root,
      count: result.pages?.length ?? 1,
      trashedAt: result.row?.trashedAt ?? new Date().toISOString(),
    };
  }

  const result = await eb.trashPage(pageId);
  const updatedPages = result.pages ?? [];
  const updatedRoot = updatedPages.find((page) => page.id === pageId) ?? root;
  return {
    page: updatedRoot,
    count: updatedPages.length || 1,
    trashedAt: updatedRoot.trashedAt ?? new Date().toISOString(),
  };
}

async function restorePageTree(pageId) {
  const pages = await eb.allPages();
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const root = pagesById[pageId];
  if (!root) return null;
  if (root.parentType === "database") {
    const result = await eb.restoreDatabaseRow(pageId);
    return { page: result.row ?? root, count: result.pages?.length ?? 0 };
  }

  const result = await eb.restorePage(pageId);
  const updatedPages = result.pages ?? [];
  const updatedRoot = updatedPages.find((page) => page.id === pageId) ?? root;
  return { page: updatedRoot, count: updatedPages.length };
}

async function deletePageTree(pageId) {
  const pages = await eb.allPages();
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const root = pagesById[pageId];
  if (!root) return null;
  if (!root.inTrash) {
    throw new Error('Page must be moved to trash before permanent deletion.');
  }
  if (root.parentType === "database") {
    const result = await eb.deleteDatabaseRow(pageId, {
      databaseId: root.parentId,
      workspaceId: root.workspaceId,
    });
    return { page: root, count: result.deletedIds?.length ?? 1 };
  }

  const result = await eb.del("pages", pageId, { workspaceId: root.workspaceId });
  return { page: root, count: result.deletedIds?.length ?? 1 };
}

function propertyConfigForInput(type, input = {}, databaseId) {
  const withDisplayConfig = (config) => {
    if (typeof input.hideWhenEmpty !== "boolean" && typeof input.hideInPagePanel !== "boolean") {
      return config;
    }
    return {
      ...(config ?? {}),
      ...(typeof input.hideWhenEmpty === "boolean" ? { hideWhenEmpty: input.hideWhenEmpty } : {}),
      ...(typeof input.hideInPagePanel === "boolean" ? { hideInPagePanel: input.hideInPagePanel } : {}),
    };
  };
  if (type === "select" || type === "multi_select" || type === "status") {
    const names = Array.isArray(input.options) ? input.options : [];
    return withDisplayConfig({
      options: names.map((option, index) => ({
        id: eb.newId(),
        name: option && typeof option === "object" ? String(option.name ?? `Option ${index + 1}`) : String(option),
        color: option && typeof option === "object" && typeof option.color === "string"
          ? option.color
          : OPTION_COLORS[index % OPTION_COLORS.length],
      })),
    });
  }
  if (type === "number") {
    return withDisplayConfig({ numberFormat: input.numberFormat ?? "number" });
  }
  if (type === "relation") {
    const config = { relationDatabaseId: input.relationDatabaseId ?? databaseId };
    // Notion-style two-way relation: setting relatedPropertyId makes the backend
    // create + cross-link a reciprocal relation property on the related database.
    if (input.twoWay === true) config.relatedPropertyId = input.relatedPropertyId || eb.newId();
    return withDisplayConfig(config);
  }
  if (type === "formula") {
    return withDisplayConfig({ formula: input.formula ?? "" });
  }
  if (type === "rollup") {
    return withDisplayConfig({
      rollupRelationPropertyId: input.rollupRelationPropertyId,
      rollupTargetPropertyId: input.rollupTargetPropertyId,
      rollupFunction: input.rollupFunction ?? "show_original",
    });
  }
  if (type === "unique_id") {
    return withDisplayConfig({ idPrefix: input.idPrefix ?? "" });
  }
  return withDisplayConfig(undefined);
}

function propertyConfigPatchForInput(prop, input = {}) {
  const config = { ...(prop.config ?? {}) };
  const changed = [];

  if (Array.isArray(input.options)) {
    if (prop.type !== "select" && prop.type !== "multi_select" && prop.type !== "status") {
      throw new Error(`options can only be set on select, status, or multi_select properties.`);
    }
    const existingByName = new Map(
      (config.options ?? []).map((option) => [String(option.name).trim().toLowerCase(), option])
    );
    config.options = input.options.map((name, index) => {
      const rawName = String(name);
      const existing = existingByName.get(rawName.trim().toLowerCase());
      return existing
        ? { ...existing, name: rawName }
        : { id: eb.newId(), name: rawName, color: OPTION_COLORS[index % OPTION_COLORS.length] };
    });
    changed.push("options");
  }

  if (input.numberFormat !== undefined) {
    if (prop.type !== "number") throw new Error("numberFormat can only be set on number properties.");
    config.numberFormat = input.numberFormat;
    changed.push("numberFormat");
  }
  if (input.idPrefix !== undefined) {
    if (prop.type !== "unique_id") throw new Error("idPrefix can only be set on ID properties.");
    config.idPrefix = String(input.idPrefix).trim();
    changed.push("idPrefix");
  }
  if (input.relationDatabaseId !== undefined) {
    if (prop.type !== "relation") throw new Error("relationDatabaseId can only be set on relation properties.");
    config.relationDatabaseId = input.relationDatabaseId;
    changed.push("relationDatabaseId");
  }
  if (input.twoWay === true) {
    if (prop.type !== "relation") throw new Error("twoWay can only be set on relation properties.");
    // Enabling two-way links a fresh reciprocal id; the backend creates the
    // paired relation on the related database. (Disabling two-way via update is
    // not supported here — delete the paired property to remove it.)
    if (!config.relatedPropertyId) {
      config.relatedPropertyId = eb.newId();
      changed.push("relatedPropertyId");
    }
  }
  if (input.formula !== undefined) {
    if (prop.type !== "formula") throw new Error("formula can only be set on formula properties.");
    config.formula = input.formula;
    changed.push("formula");
  }
  if (
    input.rollupRelationPropertyId !== undefined ||
    input.rollupTargetPropertyId !== undefined ||
    input.rollupFunction !== undefined
  ) {
    if (prop.type !== "rollup") {
      throw new Error("rollupRelationPropertyId, rollupTargetPropertyId, and rollupFunction can only be set on rollup properties.");
    }
    if (input.rollupRelationPropertyId !== undefined) config.rollupRelationPropertyId = input.rollupRelationPropertyId;
    if (input.rollupTargetPropertyId !== undefined) config.rollupTargetPropertyId = input.rollupTargetPropertyId;
    if (input.rollupFunction !== undefined) config.rollupFunction = input.rollupFunction;
    changed.push("rollup");
  }
  if (input.hideWhenEmpty !== undefined) {
    config.hideWhenEmpty = input.hideWhenEmpty;
    changed.push("hideWhenEmpty");
  }
  if (input.hideInPagePanel !== undefined) {
    config.hideInPagePanel = input.hideInPagePanel;
    changed.push("hideInPagePanel");
  }

  return { config, changed };
}

async function addPropertyToViews(databaseId, propertyId) {
  const views = await eb.dbViews(databaseId);
  const updated = [];
  for (const view of views) {
    const config = { ...(view.config ?? {}) };
    let changed = false;
    if (Array.isArray(config.propertyOrder) && !config.propertyOrder.includes(propertyId)) {
      config.propertyOrder = [...config.propertyOrder, propertyId];
      changed = true;
    }
    if (Array.isArray(config.visibleProperties) && !config.visibleProperties.includes(propertyId)) {
      config.visibleProperties = [...config.visibleProperties, propertyId];
      changed = true;
    }
    if (changed) {
      await eb.update("db_views", view.id, { config }, { databaseId: view.databaseId ?? databaseId });
      updated.push(view.name);
    }
  }
  return updated;
}

function databaseViewLabel(type) {
  return type.slice(0, 1).toUpperCase() + type.slice(1);
}

function viewByKey(views, key) {
  const needle = String(key).trim().toLowerCase();
  return views.find((view) => view.id === key || String(view.name ?? "").trim().toLowerCase() === needle);
}

async function findDatabaseView(viewKey, databaseId) {
  const cleanViewKey = stripHanjiId(viewKey);
  if (databaseId) {
    const cleanDatabaseId = stripHanjiId(databaseId);
    const db = await eb.getOne("pages", cleanDatabaseId);
    if (!db || db.kind !== "database") return null;
    const views = await eb.dbViews(cleanDatabaseId);
    const view = viewByKey(views, cleanViewKey);
    return view ? { db, views, view } : null;
  }

  const pages = await eb.allPages();
  for (const db of pages.filter((page) => page.kind === "database" && !page.inTrash)) {
    const views = await eb.dbViews(db.id);
    const view = viewByKey(views, cleanViewKey);
    if (view) return { db, views, view };
  }
  return null;
}

function propertyIdForViewInput(props, value, label, allowedTypes) {
  if (value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const prop = propertyByKey(props, raw);
  if (!prop) throw new Error(`${label} property "${value}" not found.`);
  if (allowedTypes && !allowedTypes.includes(prop.type)) {
    const formatted = allowedTypes.length < 3
      ? allowedTypes.join(" or ")
      : `${allowedTypes.slice(0, -1).join(", ")}, or ${allowedTypes.at(-1)}`;
    throw new Error(`${label} must use ${formatted} properties.`);
  }
  return prop.id;
}

function propertyIdsForViewInput(props, values, label) {
  if (!Array.isArray(values)) return undefined;
  return values.map((value) => propertyIdForViewInput(props, value, label)).filter(Boolean);
}

function tableCalculationAllowed(prop, calculation) {
  if (BASE_TABLE_CALCULATIONS.has(calculation)) return true;
  if (prop.type === "checkbox" && CHECKBOX_TABLE_CALCULATIONS.has(calculation)) return true;
  if (
    (prop.type === "number" || prop.type === "formula" || prop.type === "rollup") &&
    NUMBER_TABLE_CALCULATIONS.has(calculation)
  ) {
    return true;
  }
  if (
    (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") &&
    DATE_TABLE_CALCULATIONS.has(calculation)
  ) {
    return true;
  }
  return false;
}

function tableCalculationsForViewInput(props, values, base = {}) {
  if (!Array.isArray(values)) return base;
  const next = { ...(base ?? {}) };
  for (const item of values) {
    const prop = propertyByKey(props, item.property);
    if (!prop) throw new Error(`tableCalculations property "${item.property}" not found.`);
    if (!item.calculation || item.calculation === "none") {
      delete next[prop.id];
      continue;
    }
    if (!tableCalculationAllowed(prop, item.calculation)) {
      throw new Error(`Calculation "${item.calculation}" is not valid for ${prop.type} property "${prop.name}".`);
    }
    next[prop.id] = item.calculation;
  }
  return Object.keys(next).length ? next : undefined;
}

function operatorsForProperty(prop) {
  switch (prop.type) {
    case "number":
      return ["equals", "greater_than", "less_than", "is_empty", "is_not_empty"];
    case "date":
    case "created_time":
    case "last_edited_time":
      return ["on_or_after", "on_or_before", "equals", "is_empty", "is_not_empty"];
    case "checkbox":
      return ["equals", "does_not_equal"];
    case "select":
    case "status":
    case "multi_select":
      return ["equals", "does_not_equal", "is_empty", "is_not_empty"];
    default:
      return ["contains", "does_not_contain", "equals", "is_empty", "is_not_empty"];
  }
}

function normalizeFilterValue(prop, operator, value) {
  if (NO_VALUE_FILTERS.has(operator)) return undefined;
  if (prop.type === "select" || prop.type === "status") return optionId(prop, value);
  if (prop.type === "multi_select") {
    const first = Array.isArray(value) ? value[0] : value;
    return optionId(prop, first);
  }
  if (prop.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Filter value for "${prop.name}" must be a number.`);
    return n;
  }
  if (prop.type === "checkbox") {
    if (typeof value === "boolean") return value;
    return !["false", "0", "no", "unchecked"].includes(String(value ?? "").trim().toLowerCase());
  }
  if (prop.type === "person" || prop.type === "relation") {
    const first = Array.isArray(value) ? value[0] : value;
    return String(first ?? "").trim();
  }
  return value ?? "";
}

function filterGroupHasTerms(group) {
  return (
    (Array.isArray(group.filters) && group.filters.length > 0) ||
    (Array.isArray(group.groups) && group.groups.some((item) => item && filterGroupHasTerms(item)))
  );
}

function viewFilterFromInput(props, input) {
  const prop = propertyByKey(props, input.property);
  if (!prop) throw new Error(`Filter property "${input.property}" not found.`);
  const operator = input.operator ?? operatorsForProperty(prop)[0];
  if (!operatorsForProperty(prop).includes(operator)) {
    throw new Error(`Operator "${operator}" is not valid for ${prop.type} property "${prop.name}".`);
  }
  const filter = { propertyId: prop.id, operator };
  const value = normalizeFilterValue(prop, operator, input.value);
  if (!NO_VALUE_FILTERS.has(operator)) filter.value = value;
  return filter;
}

function filterGroupFromInput(props, input) {
  if (!input) return undefined;
  const group = {
    conjunction: input.conjunction === "or" ? "or" : "and",
    filters: (input.filters ?? []).map((filter) => viewFilterFromInput(props, filter)),
    groups: (input.groups ?? [])
      .map((subgroup) => filterGroupFromInput(props, subgroup))
      .filter((subgroup) => subgroup && filterGroupHasTerms(subgroup)),
  };
  return filterGroupHasTerms(group) ? group : undefined;
}

export function defaultViewConfigForType(type, props, base = {}) {
  const config = /** @type {Record<string, any>} */ ({ ...(base ?? {}) });
  const propIds = props.map((prop) => prop.id);
  // Core product views keep their established defaults. Compatibility-only
  // official types start from the caller's exact configuration, avoiding a
  // fake table-shaped config on form/chart/map/dashboard records.
  if (HANJI_CORE_DATABASE_VIEW_TYPES.includes(type)) {
    if (!Array.isArray(config.propertyOrder)) config.propertyOrder = propIds;
    if (!Array.isArray(config.visibleProperties)) config.visibleProperties = propIds;
  }
  if (type === "board" && !config.groupBy) {
    const groupProp = props.find((prop) => isHanjiBoardMainGroupPropertyType(prop.type));
    if (groupProp) config.groupBy = groupProp.id;
  }
  if ((type === "calendar" || type === "timeline") && !config.calendarBy && !config.timelineBy) {
    const dateProp = props.find((prop) => prop.type === "date");
    if (dateProp) {
      if (type === "calendar") config.calendarBy = dateProp.id;
      if (type === "timeline") config.timelineBy = dateProp.id;
    }
  }
  if (type === "timeline" && !config.timelineZoom) config.timelineZoom = "month";
  if (type === "gallery" && !config.cardSize) config.cardSize = "medium";
  return config;
}

export function viewConfigPatchForInput(props, type, input = {}, base = {}) {
  const config = defaultViewConfigForType(type, props, base);
  const changed = [];
  const setProperty = (key, value, label, allowedTypes) => {
    if (value === undefined) return;
    config[key] = propertyIdForViewInput(props, value, label, allowedTypes);
    changed.push(key);
  };

  if (input.visibleProperties !== undefined) {
    config.visibleProperties = propertyIdsForViewInput(props, input.visibleProperties, "visibleProperties");
    changed.push("visibleProperties");
  }
  if (input.propertyOrder !== undefined) {
    config.propertyOrder = propertyIdsForViewInput(props, input.propertyOrder, "propertyOrder");
    changed.push("propertyOrder");
  }
  if (input.wrappedColumns !== undefined) {
    const wrappedColumns = propertyIdsForViewInput(props, input.wrappedColumns, "wrappedColumns");
    if (wrappedColumns?.length) config.wrappedColumns = wrappedColumns;
    else delete config.wrappedColumns;
    changed.push("wrappedColumns");
  }
  if (input.tableCalculations !== undefined) {
    config.tableCalculations = tableCalculationsForViewInput(
      props,
      input.tableCalculations,
      config.tableCalculations
    );
    changed.push("tableCalculations");
  }
  applyNotionViewPresentationConfig({
    config,
    changed,
    props,
    type,
    input,
    propertyIdForViewInput,
  });
  setProperty("dependencyProperty", input.dependencyProperty, "dependencyProperty", ["relation"]);
  if (input.cardSize !== undefined) {
    config.cardSize = input.cardSize;
    changed.push("cardSize");
  }
  if (input.openPageIn !== undefined) {
    config.openPageIn = input.openPageIn;
    changed.push("openPageIn");
  }
  if (input.rowHeight !== undefined) {
    config.rowHeight = input.rowHeight;
    changed.push("rowHeight");
  }
  if (input.timelineZoom !== undefined) {
    config.timelineZoom = input.timelineZoom;
    changed.push("timelineZoom");
  }
  if (input.sorts !== undefined) {
    config.sorts = input.sorts.map((sort) => {
      const propertyId = propertyIdForViewInput(props, sort.property, "sort");
      const prop = props.find((item) => item.id === propertyId);
      if (prop?.type === "rollup") throw new Error("Rollup properties cannot be sorted in MCP queries.");
      return { propertyId, direction: sort.direction ?? "asc" };
    });
    changed.push("sorts");
  }
  if (input.filterGroup !== undefined) {
    const filterGroup = filterGroupFromInput(props, input.filterGroup);
    if (filterGroup) config.filterGroup = filterGroup;
    else config.filterGroup = undefined;
    config.filters = undefined;
    config.filterConjunction = undefined;
    changed.push("filterGroup");
  } else if (input.filters !== undefined) {
    const conjunction = input.filterConjunction ?? "and";
    config.filterGroup =
      input.filters.length > 0
        ? {
            conjunction,
            filters: input.filters.map((filter) => viewFilterFromInput(props, filter)),
            groups: [],
          }
        : undefined;
    config.filters = undefined;
    config.filterConjunction = undefined;
    changed.push("filters");
  } else if (input.filterConjunction !== undefined && config.filterGroup) {
    config.filterGroup = { ...config.filterGroup, conjunction: input.filterConjunction };
    config.filterConjunction = undefined;
    changed.push("filterConjunction");
  }
  return { config, changed: Array.from(new Set(changed)) };
}

function notionSearchPolicyBinding() {
  const policy = typeof eb.mcpAccessPolicy === "function" ? eb.mcpAccessPolicy() : {};
  const sorted = (value) => Array.isArray(value) ? value.map(String).sort() : [];
  return {
    readOnly: policy?.readOnly === true,
    allowedWorkspaceIds: sorted(policy?.allowedWorkspaceIds),
    allowedPageIds: sorted(policy?.allowedPageIds),
    allowedDatabaseIds: sorted(policy?.allowedDatabaseIds),
    scopes: sorted(policy?.scopes),
    subjectType: policy?.subjectType ?? null,
    subjectId: policy?.subjectId ?? null,
    clientId: policy?.clientId ?? null,
    provisioningId: policy?.provisioningId ?? null,
    notBefore: policy?.notBefore ?? null,
    expiresAt: policy?.expiresAt ?? null,
  };
}

async function workspaceResultsForNotionSearch({
  workspaceId,
  query,
  limit,
  filters,
  requiredAncestorIds,
  trimHighlight,
  cursorState,
}) {
  searchCursorKind(cursorState, ["workspace_pages", "workspace_blocks"]);
  const accepted = [];
  let phase = cursorState?.kind === "workspace_blocks" ? "blocks" : "pages";
  let sourceCursor = cursorState?.sourceCursor ?? null;
  let revision = cursorState?.revision ?? NOTION_SEARCH_PENDING_REVISION;
  let windows = 0;
  let nextState = null;
  const seenSourceCursors = new Set(
    sourceCursor ? [`${phase}:${sourceCursor}`] : [],
  );

  while (windows < NOTION_SEARCH_MAX_WINDOWS_PER_CALL) {
    const remaining = Math.max(0, limit - accepted.length);
    const requestLimit = Math.max(1, remaining);
    const requestedCursor = sourceCursor;
    if (phase === "pages") {
      const payload = await eb.searchPagesPage(query, {
        workspaceId,
        limit: requestLimit,
        ...(requiredAncestorIds?.length ? { requiredAncestorIds } : {}),
        ...(requestedCursor ? { sourceCursor: requestedCursor } : {}),
      });
      const source = workspaceSearchSourcePage(
        payload,
        "pages",
        requestedCursor,
        requestLimit,
      );
      revision = source.revision;
      for (const page of source.items) {
        if (!page || typeof page !== "object" || !String(page.id ?? "").trim()) {
          throw new Error("Workspace search page was malformed.");
        }
        if (!matchesNotionSearchFilters(page, filters)) continue;
        if (accepted.length >= limit) {
          nextState = workspaceSourceContinuation(
            "workspace_pages",
            requestedCursor,
            revision,
          );
          break;
        }
        accepted.push(trimHighlight(notionSearchResult(page)));
      }
      windows += 1;
      if (nextState) break;
      if (source.hasMore) {
        const cursorKey = `pages:${source.nextCursor}`;
        if (seenSourceCursors.has(cursorKey)) {
          throw new Error("Workspace search source pagination did not advance.");
        }
        seenSourceCursors.add(cursorKey);
        sourceCursor = source.nextCursor;
        if (windows >= NOTION_SEARCH_MAX_WINDOWS_PER_CALL) {
          nextState = workspaceSourceContinuation("workspace_pages", sourceCursor, revision);
          break;
        }
        continue;
      }
      phase = "blocks";
      sourceCursor = null;
      revision = NOTION_SEARCH_PENDING_REVISION;
      if (windows >= NOTION_SEARCH_MAX_WINDOWS_PER_CALL) {
        nextState = workspaceSourceContinuation(
          "workspace_blocks",
          null,
          NOTION_SEARCH_PENDING_REVISION,
        );
        break;
      }
      continue;
    }

    const payload = await eb.searchBlocksPage(query, {
      workspaceId,
      limit: requestLimit,
      excludeMetadataMatches: true,
      ...(requiredAncestorIds?.length ? { requiredAncestorIds } : {}),
      ...(requestedCursor ? { sourceCursor: requestedCursor } : {}),
    });
    const source = workspaceSearchSourcePage(
      payload,
      "blocks",
      requestedCursor,
      requestLimit,
    );
    revision = source.revision;
    const pagesById = Object.fromEntries(
      (Array.isArray(payload?.pages) ? payload.pages : [])
        .filter((page) => page && typeof page === "object" && String(page.id ?? "").trim())
        .map((page) => [page.id, page]),
    );
    for (const block of source.items) {
      if (!block || typeof block !== "object" || !String(block.id ?? "").trim()) {
        throw new Error("Workspace search block was malformed.");
      }
      const page = pagesById[block.pageId];
      if (!page || !matchesNotionSearchFilters(page, filters)) continue;
      if (accepted.length >= limit) {
        nextState = workspaceSourceContinuation(
          "workspace_blocks",
          requestedCursor,
          revision,
        );
        break;
      }
      accepted.push(trimHighlight(notionSearchResult(page, blockPreview(block))));
    }
    windows += 1;
    if (nextState) break;
    if (source.hasMore) {
      const cursorKey = `blocks:${source.nextCursor}`;
      if (seenSourceCursors.has(cursorKey)) {
        throw new Error("Workspace search source pagination did not advance.");
      }
      seenSourceCursors.add(cursorKey);
      sourceCursor = source.nextCursor;
      nextState = windows >= NOTION_SEARCH_MAX_WINDOWS_PER_CALL
        ? workspaceSourceContinuation("workspace_blocks", sourceCursor, revision)
        : null;
      if (nextState) break;
      continue;
    }
    break;
  }

  return {
    results: accepted,
    nextState,
    requestStatus: null,
  };
}

const NOTION_SEARCH_INPUT_SCHEMA = {
  query: z.string().describe("Search query"),
  query_type: z.enum(["internal", "user"]).optional().describe("Use user to search workspace members; internal searches pages/databases/rows."),
  content_search_mode: z.enum(["workspace_search", "ai_search"]).optional(),
  data_source_url: z.string().optional().describe("collection://<database-id> to search rows in a database/data source"),
  page_url: z.string().optional().describe("Page URL or id to restrict search to a page subtree"),
  workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
  teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
  page_size: z.number().int().min(1).max(25).optional(),
  start_cursor: z.string().optional().describe("Opaque continuation cursor returned by the previous identical search"),
  max_highlight_length: z.number().int().min(0).max(1000).optional(),
  filters: JsonValueSchema.optional().describe("Accepted for Notion MCP compatibility; unsupported filter keys are ignored."),
};

export async function handleNotionSearch({
  query,
  query_type = "internal",
  content_search_mode = "workspace_search",
  data_source_url,
  page_url,
  workspace_id,
  teamspace_id,
  page_size = 10,
  start_cursor = undefined,
  max_highlight_length = 200,
  filters,
}) {
  try {
    const limit = clamp(page_size, 1, 25);
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_search");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const scope = await hanjiWorkspaceScope(requiredWorkspace.workspaceId);
    const trimHighlight = (result) => ({
      ...result,
      highlight:
        max_highlight_length === 0
          ? ""
          : String(result.highlight ?? "").slice(0, max_highlight_length),
    });
    const dataSourceId = stripHanjiId(data_source_url);
    const pageScopeId = stripHanjiId(page_url);
    const cursorFingerprint = notionSearchRequestFingerprint({
      workspaceId: requiredWorkspace.workspaceId,
      query: String(query ?? ""),
      queryType: query_type,
      contentSearchMode: content_search_mode,
      dataSourceId,
      pageScopeId,
      pageSize: limit,
      maxHighlightLength: max_highlight_length,
      filters,
      policy: notionSearchPolicyBinding(),
    });
    const cursorState = start_cursor
      ? notionSearchCursorCodec.decode(start_cursor, cursorFingerprint)
      : null;

    if (query_type === "user") {
      searchCursorKind(cursorState, ["user"]);
      const people = [];
      const workspace = scope.workspaces[0] ?? {
        id: requiredWorkspace.workspaceId,
        name: requiredWorkspace.workspaceId,
      };
      const payload = await eb.notionUsers({
        workspaceId: workspace.id,
        query,
        startCursor: cursorState?.upstreamCursor,
        pageSize: limit,
      });
      const roster = officialNotionUsers(payload);
      for (const user of roster.results) {
        const email = officialNotionUserEmail(user);
        people.push({
          id: String(user?.id ?? ""),
          title: String(user?.name ?? user?.id ?? "Hanji user"),
          type: "user",
          ...(email ? { email } : {}),
          workspace_id: workspace.id,
          workspace: workspace.name,
        });
      }
      const nextCursor = roster.hasMore
        ? notionSearchCursorCodec.encode(
            { kind: "user", upstreamCursor: roster.nextCursor },
            cursorFingerprint,
          )
        : null;
      return okJson(notionSearchResponse(
        people,
        "user",
        {
          ...hanjiScopeMetadata({
            workspaceIds: scope.workspaceIds,
            requestedTeamspaceId: scope.requestedTeamspaceId,
            target: "user_search",
            source: scope.source,
          }),
          has_more: roster.hasMore,
          next_cursor: nextCursor,
        },
      ));
    }

    if (data_source_url) {
      searchCursorKind(cursorState, ["data_source"]);
      const db = await eb.getOne("pages", dataSourceId);
      const databaseWorkspaceId = db?.workspaceId ?? null;
      if (scope.requestedTeamspaceId && databaseWorkspaceId && scope.requestedTeamspaceId !== databaseWorkspaceId) {
        return okJson(notionSearchResponse(
          [],
          "workspace_search",
          {
            ...hanjiScopeMetadata({
              workspaceIds: [scope.requestedTeamspaceId],
              requestedTeamspaceId: scope.requestedTeamspaceId,
              target: "data_source_search",
              source: scope.source,
              conflict: "data_source_workspace_does_not_match_teamspace_id",
            }),
            has_more: false,
            next_cursor: null,
          },
        ));
      }
      const window = await databaseRowsForNotionSearch(
        dataSourceId,
        db,
        query,
        limit,
        filters,
        cursorState,
      );
      const nextCursor = window.nextState
        ? notionSearchCursorCodec.encode(window.nextState, cursorFingerprint)
        : null;
      return okJson(notionSearchResponse(
        window.results.map(trimHighlight),
        "workspace_search",
        {
          ...hanjiScopeMetadata({
            workspaceIds: databaseWorkspaceId ? [databaseWorkspaceId] : scope.workspaceIds,
            requestedTeamspaceId: scope.requestedTeamspaceId,
            target: "data_source_search",
            source: databaseWorkspaceId ? "data_source_url" : scope.source,
          }),
          data_source_id: dataSourceId,
          has_more: nextCursor !== null,
          next_cursor: nextCursor,
          ...(window.requestStatus ? { request_status: window.requestStatus } : {}),
        },
      ));
    }

    let requiredAncestorIds = null;
    let pageScopeWorkspaceId = null;
    if (page_url) {
      const rootId = pageScopeId;
      requiredAncestorIds = [rootId];
      const root = await eb.getOne("pages", rootId);
      if (root?.workspaceId) {
        pageScopeWorkspaceId = root.workspaceId;
        if (scope.requestedTeamspaceId && scope.requestedTeamspaceId !== root.workspaceId) {
          return okJson(notionSearchResponse(
            [],
            "workspace_search",
            {
              ...hanjiScopeMetadata({
                workspaceIds: [scope.requestedTeamspaceId],
                requestedTeamspaceId: scope.requestedTeamspaceId,
                target: "page_subtree_search",
                source: scope.source,
                pageScopeWorkspaceId,
                conflict: "page_workspace_does_not_match_teamspace_id",
              }),
              has_more: false,
              next_cursor: null,
            },
          ));
        }
      }
    }
    if (!requiredAncestorIds) {
      const policy = notionSearchPolicyBinding();
      const resourceIds = Array.from(new Set([
        ...policy.allowedPageIds,
        ...policy.allowedDatabaseIds,
      ]));
      requiredAncestorIds = resourceIds.length ? resourceIds : null;
    }

    const workspaceIds = pageScopeWorkspaceId ? [pageScopeWorkspaceId] : scope.workspaceIds;
    const window = await workspaceResultsForNotionSearch({
      workspaceId: workspaceIds[0] ?? requiredWorkspace.workspaceId,
      query,
      limit,
      filters,
      requiredAncestorIds,
      trimHighlight,
      cursorState,
    });
    const nextCursor = window.nextState
      ? notionSearchCursorCodec.encode(window.nextState, cursorFingerprint)
      : null;

    const scopeExtra = hanjiScopeMetadata({
      workspaceIds,
      requestedTeamspaceId: scope.requestedTeamspaceId,
      target: pageScopeId ? "page_subtree_search" : "workspace_search",
      source: pageScopeWorkspaceId ? "page_url_workspace" : scope.source,
      pageScopeWorkspaceId,
    });
    const paginationExtra = {
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
      ...(window.requestStatus ? { request_status: window.requestStatus } : {}),
    };
    return okJson(notionSearchResponse(
      window.results,
      "workspace_search",
      content_search_mode === "ai_search"
        ? {
            ...scopeExtra,
            ...paginationExtra,
            requested_content_search_mode: "ai_search",
            effective_content_search_mode: "workspace_search",
            unsupported_features: ["notion_ai_search", "connected_source_search"],
            note: "Hanji does not provide a separate AI or connected-source search layer; searched account-accessible Hanji workspace data using the scope metadata above.",
          }
        : { ...scopeExtra, ...paginationExtra },
    ));
  } catch (e) {
    return fail(e);
  }
}

export const NOTION_SEARCH_TOOL = {
  title: "Search",
  description:
    "Notion-compatible search for Hanji. The connection is workspace-scoped, so workspace_id is required. Call list_workspaces or _notion_get_teams first, choose one authorized Hanji workspace id, and pass it as workspace_id or Notion-compatible teamspace_id.",
  inputSchema: NOTION_SEARCH_INPUT_SCHEMA,
};

const NOTION_FETCH_INPUT_SCHEMA = {
  id: z.string().describe("Page URL/id, database URL/id, or collection://<database-id>"),
  workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
  teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
  include_discussions: z.boolean().optional(),
  include_transcript: z.boolean().optional(),
};

export async function handleNotionFetch({ id, workspace_id, teamspace_id, include_discussions = false, include_transcript = false }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_fetch");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    if (String(id ?? "").trim().toLowerCase() === "self") {
      const workspaces = await connectionSelectedWorkspaces();
      const workspace = workspaces.find((candidate) => candidate.id === requiredWorkspace.workspaceId);
      if (!workspace) throw new Error(`Workspace ${requiredWorkspace.workspaceId} not found.`);
      const authenticated = await eb.currentUser();
      const authenticatedId = authenticated?.id ?? authenticated?.userId;
      if (!authenticatedId) throw new Error("The authenticated Hanji user could not be resolved.");
      const members = await eb.workspaceMembers(requiredWorkspace.workspaceId);
      const memberList = Array.isArray(members?.members) ? members.members : [];
      const member = memberList.find((candidate) => (
        (candidate.userId ?? candidate.id) === authenticatedId
      ));
      return okJson({
        self: {
          workspace: {
            id: workspace.id,
            name: workspace.name ?? workspace.domain ?? "Untitled Workspace",
          },
          user: {
            object: "user",
            id: authenticatedId,
            type: "person",
            name: member
              ? workspaceMemberLabel(member)
              : authenticated.displayName ?? authenticated.name ?? authenticated.email ?? authenticatedId,
            person: { email: member?.email ?? authenticated.email ?? null },
          },
        },
        workspace_id: workspace.id,
      });
    }
    const isCollection = /^collection:\/\//i.test(String(id ?? "").trim());
    const entityId = stripHanjiId(id);
    const page = await eb.getOne("pages", entityId);
    if (!page || !page.id) throw new Error(`Page or data source ${id} not found.`);
    const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, page, "_fetch", "Page or data source");
    if (matched.errorResult) return matched.errorResult;
    if (isCollection || page.kind === "database") {
      return okJson(await notionDataSourceFetchPayload(page));
    }
    const transcripts = include_transcript
      ? (await eb.notionMeetingNotes({
          workspace_id: requiredWorkspace.workspaceId,
          page_id: page.id,
          include_transcript: true,
          limit: 50,
        }))?.results ?? []
      : null;
    return okJson(await notionPageFetchPayload(page, include_discussions, transcripts));
  } catch (e) {
    return fail(e);
  }
}

const NOTION_FETCH_TOOL = {
  title: "Fetch",
  description:
    "Notion-compatible fetch for Hanji pages, databases, and collection:// data sources. Set include_transcript to include real attendee-authorized meeting-note transcripts. The connection is workspace-scoped, so workspace_id is required. Returns JSON text with metadata/title/url/text, using enhanced Notion-style Markdown tags such as <page>, <meeting-notes>, <transcript>, <database>, <data-source>, and <sqlite-table>.",
  inputSchema: NOTION_FETCH_INPUT_SCHEMA,
};

const NOTION_GET_USERS_TOOL = {
  title: "Get users",
  description:
    "Notion-compatible user listing. The connection is workspace-scoped, so workspace_id is required and this returns members from the selected workspace with cursor pagination.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    user_id: z.string().optional().describe("Specific user id, or self for the authenticated Hanji actor"),
    query: z.string().optional(),
    start_cursor: z.string().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  },
};

export async function handleNotionGetUsers({ workspace_id, teamspace_id, user_id, query, start_cursor, page_size = 100 }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_get_users");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const payload = await eb.notionUsers({
      workspaceId: requiredWorkspace.workspaceId,
      userId: user_id,
      query,
      startCursor: start_cursor,
      pageSize: clamp(page_size, 1, 100),
    });
    const direct = typeof user_id === "string" && user_id.trim().length > 0;
    const roster = officialNotionUsers(payload, { direct });
    let users = roster.results.map((user) =>
      flatNotionUser(user, requiredWorkspace.workspaceId));
    // Direct /users/:id retrieval ignores list query parameters. Preserve the
    // tool's combined user_id + query behavior, but filter only the canonical
    // redacted projection so another member's hidden email is never an oracle.
    if (user_id && String(query ?? "").trim()) {
      const needle = String(query).trim().toLowerCase();
      users = users.filter((user) =>
        `${user.name}\n${user.id}\n${user.email ?? ""}`.toLowerCase().includes(needle));
    }
    return okJson({
      results: users,
      has_more: roster.hasMore,
      next_cursor: roster.nextCursor,
    });
  } catch (e) {
    return fail(e);
  }
}

function notionImportReport(job = {}) {
  return job.report && typeof job.report === "object" ? job.report : {};
}

function notionImportConversionForJob(job = {}) {
  const report = notionImportReport(job);
  const candidates = [report.fileRetry?.conversion, report.conversion, report.plan?.conversion];
  return candidates.find((candidate) => candidate && typeof candidate === "object") ?? {};
}

function notionImportJobSummary(job = {}) {
  const counts = job.counts && typeof job.counts === "object" ? job.counts : {};
  const countText = Object.entries(counts)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${value} ${key}`)
    .join(", ");
  const progress = job.progress && typeof job.progress === "object" ? job.progress : {};
  const progressLabel =
    typeof progress.currentLabel === "string" && progress.currentLabel.trim()
      ? progress.currentLabel.trim()
      : typeof progress.step === "string" && progress.step.trim()
        ? progress.step.trim().replace(/_/g, " ")
        : "";
  const progressPercent =
    typeof progress.percent === "number" && Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, Math.round(progress.percent)))
      : undefined;
  const progressText =
    progressPercent !== undefined && progressLabel
      ? `${progressPercent}% - ${progressLabel}`
      : progressPercent !== undefined
        ? `${progressPercent}%`
        : progressLabel;
  const conversion = notionImportConversionForJob(job);
  const summary = conversion.summary && typeof conversion.summary === "object" ? conversion.summary : {};
  const reportText = [
    Number(summary.unsupported) > 0 ? `${summary.unsupported} unsupported` : "",
    Number(summary.unresolvedReferences) > 0 ? `${summary.unresolvedReferences} unresolved` : "",
    Number(summary.missingPermissions) > 0 ? `${summary.missingPermissions} missing` : "",
    Number(summary.warnings) > 0 ? `${summary.warnings} warnings` : "",
    Number(summary.discoveryIncomplete) > 0 ? `${summary.discoveryIncomplete} incomplete discovery` : "",
    Number(summary.notionUserReferences) > 0 ? `${summary.notionUserReferences} Notion user refs` : "",
    Number(summary.remappedRichTextMentions) > 0 ? `${summary.remappedRichTextMentions} rich text link remaps` : "",
    Number(summary.unresolvedRichTextMentions) > 0 ? `${summary.unresolvedRichTextMentions} unresolved rich text links` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return [
    `job id: ${job.id ?? ""}`,
    `workspace id: ${job.workspaceId ?? ""}`,
    `status: ${job.status ?? "unknown"}`,
    `phase: ${job.phase ?? "unknown"}`,
    progressText ? `progress: ${progressText}` : null,
    job.notionWorkspaceName ? `Notion workspace: ${job.notionWorkspaceName}` : null,
    countText ? `discovered: ${countText}` : null,
    reportText ? `report: ${reportText}` : null,
    job.error ? `error: ${job.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function notionImportConnectionSummary(connection = {}) {
  return [
    `connection id: ${connection.id ?? ""}`,
    `workspace id: ${connection.workspaceId ?? ""}`,
    `name: ${connection.name ?? "Notion connection"}`,
    `status: ${connection.status ?? "unknown"}`,
    connection.notionWorkspaceName ? `Notion workspace: ${connection.notionWorkspaceName}` : null,
    connection.tokenFingerprint ? `token fingerprint: ${connection.tokenFingerprint}` : null,
    `stored credential: ${connection.hasStoredCredential ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function notionImportItemPreview(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines = items.slice(0, 12).map((item) => {
    const title = item.title || "Untitled";
    return `- ${title} (${item.notionObject}, ${item.notionId})`;
  });
  const rest = items.length > lines.length ? `\n- ... ${items.length - lines.length} more` : "";
  return `\n\n## Discovered items\n${lines.join("\n")}${rest}`;
}

function notionImportPlanSummary(plan = {}) {
  const writes = plan.estimatedWrites && typeof plan.estimatedWrites === "object" ? plan.estimatedWrites : {};
  const conversion = plan.conversion && typeof plan.conversion === "object" ? plan.conversion : {};
  const summary = conversion.summary && typeof conversion.summary === "object" ? conversion.summary : {};
  const writeLines = Object.entries(writes)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${key}: ${value}`);
  const issueLines = [
    Number(summary.unsupported) > 0 ? `unsupported: ${summary.unsupported}` : "",
    Number(summary.unresolvedReferences) > 0 ? `unresolved: ${summary.unresolvedReferences}` : "",
    Number(summary.missingPermissions) > 0 ? `missing: ${summary.missingPermissions}` : "",
    Number(summary.warnings) > 0 ? `warnings: ${summary.warnings}` : "",
    Number(summary.discoveryIncomplete) > 0 ? `discovery incomplete: ${summary.discoveryIncomplete}` : "",
    Number(summary.notionUserReferences) > 0 ? `Notion user refs: ${summary.notionUserReferences}` : "",
    Number(summary.remappedRichTextMentions) > 0 ? `rich text link remaps: ${summary.remappedRichTextMentions}` : "",
    Number(summary.unresolvedRichTextMentions) > 0 ? `unresolved rich text links: ${summary.unresolvedRichTextMentions}` : "",
  ].filter(Boolean);
  return [
    "## Import review",
    `status: ${plan.status ?? "unknown"}`,
    `can apply: ${plan.canApply === false ? "no" : "yes"}`,
    writeLines.length ? `estimated writes:\n${writeLines.map((line) => `- ${line}`).join("\n")}` : null,
    issueLines.length ? `report:\n${issueLines.map((line) => `- ${line}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const createDatabasePropertyInputSchema = z.object({
  name: z.string().describe("Property name"),
  type: z.enum(DATABASE_CREATE_PROPERTY_TYPES).optional().describe("Property type; defaults to rich_text. Include one title property to rename the title column."),
  options: z.array(z.string()).optional().describe("Option names for select, status, or multi-select properties"),
  numberFormat: z.enum(["number", "comma", "percent", "dollar", "won", "euro"]).optional(),
  idPrefix: z.string().optional().describe("Display prefix for ID properties, e.g. TASK"),
  relationDatabaseId: z.string().optional().describe("Related database id for relation properties"),
  twoWay: z.boolean().optional().describe("For relation properties: create a Notion-style two-way relation. The backend creates and cross-links a reciprocal relation property on the related database (named after this database). Defaults to one-way."),
  formula: z.string().optional().describe("Formula expression for formula properties"),
  rollupRelationPropertyId: z.string().optional(),
  rollupTargetPropertyId: z.string().optional(),
  rollupFunction: z.enum(ROLLUP_FUNCTIONS).optional(),
  hideWhenEmpty: z.boolean().optional().describe("Hide this property in row/page panels when its value is empty"),
  hideInPagePanel: z.boolean().optional().describe("Always hide this property in row/page panels until hidden properties are expanded"),
});

const filterRuleInputSchema = z.object({
  property: z.string().describe("Property name or id"),
  operator: z.enum(FILTER_OPERATORS).optional(),
  value: JsonValueSchema.optional().describe("Filter value; omit for is_empty/is_not_empty"),
});

const filterGroupInputSchema = z.lazy(() =>
  z.object({
    conjunction: z.enum(["and", "or"]).optional().describe("How this group's terms combine; defaults to and"),
    filters: z.array(filterRuleInputSchema).optional().describe("Filter rules in this group"),
    groups: z.array(filterGroupInputSchema).optional().describe("Nested filter groups"),
  })
);

const viewConfigInputSchema = {
  visibleProperties: z.array(z.string()).optional().describe("Visible property names or ids, in display order"),
  propertyOrder: z.array(z.string()).optional().describe("Full property order by property name or id"),
  wrappedColumns: z.array(z.string()).optional().describe("Table property names or ids whose cells should wrap. Pass an empty array to clear."),
  tableCalculations: z.array(z.object({
    property: z.string().describe("Property name or id"),
    calculation: z.enum(TABLE_CALCULATION_INPUTS).describe("Table footer calculation; use none to clear this property"),
  })).optional().describe("Table footer calculations by property"),
  groupBy: z.string().optional().describe("Board group property name/id. Pass an empty string to clear."),
  subGroupBy: z.string().optional().describe("Board sub-group select/status property name/id. Pass an empty string to clear."),
  calendarBy: z.string().optional().describe("Calendar date property name/id. Pass an empty string to clear."),
  timelineBy: z.string().optional().describe("Timeline start date property name/id. Pass an empty string to clear."),
  timelineEndBy: z.string().optional().describe("Timeline end date property name/id. Pass an empty string to clear."),
  dependencyProperty: z.string().optional().describe("Timeline dependency relation property name/id. Pass an empty string to clear."),
  coverProperty: z.string().optional().describe("Gallery/board card preview property name/id, __page_cover/page, or __none/none"),
  wrap: z.boolean().optional().describe("Wrap database cells/cards where supported"),
  cardSize: z.enum(VIEW_CARD_SIZES).optional().describe("Gallery/board card size"),
  openPageIn: z.enum(VIEW_OPEN_PAGE_IN).optional().describe("How rows open from this view"),
  rowHeight: z.enum(VIEW_ROW_HEIGHTS).optional().describe("Table row density"),
  timelineZoom: z.enum(VIEW_TIMELINE_ZOOMS).optional().describe("Timeline scale"),
  sorts: z.array(z.object({
    property: z.string().describe("Property name or id"),
    direction: z.enum(["asc", "desc"]).optional(),
  })).optional().describe("Sort rules; pass an empty array to clear"),
  filterConjunction: z.enum(["and", "or"]).optional().describe("How filters combine; defaults to and"),
  filters: z.array(filterRuleInputSchema).optional().describe("Simple root-level filter rules; pass an empty array to clear filters"),
  filterGroup: filterGroupInputSchema.nullable().optional().describe("Nested AND/OR filter tree; pass null or an empty group to clear filters"),
};

function databasePropertyRecordFromInput(databaseId, property, position) {
  return {
    id: eb.newId(),
    databaseId,
    name: property.name,
    type: property.type ?? "rich_text",
    description: property.description || null,
    config: propertyConfigForInput(property.type ?? "rich_text", property, databaseId),
    position,
  };
}

function publicRowValue(row, prop, pagesById, props, propsByDb) {
  const value = propValue(row, prop);
  if (prop.type === "checkbox") return value ? "__YES__" : "__NO__";
  if (prop.type === "number" || prop.type === "unique_id") return value == null || value === "" ? null : Number(value);
  if (prop.type === "relation") return ids(value).map((id) => pageUrl(id));
  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") return personIds(value);
  if (value == null || value === "") return null;
  return formatDbValue(row, prop, pagesById, props, propsByDb);
}

function dataSourceRowObject(row, props, pagesById, propsByDb = {}) {
  const out = {
    url: pageUrl(row.id),
    id: row.id,
    createdTime: row.createdAt ?? null,
  };
  for (const prop of props) out[prop.name] = publicRowValue(row, prop, pagesById, props, propsByDb);
  return out;
}

const MCP_SQL_SOURCE_WINDOWS = 10;
const MCP_SQL_CREATED_TIME_SORT_ID = "__hanji_database_rows_created_time";

function sqlDatabaseRowsSorts(orderBy, props) {
  return orderBy.map((order) => {
    const name = String(order.property ?? "");
    const property = props.find((candidate) =>
      String(candidate.name ?? "").toLowerCase() === name.toLowerCase()
    );
    if (property) return { propertyId: property.id, direction: order.direction };
    if (name === "createdTime") {
      return { propertyId: MCP_SQL_CREATED_TIME_SORT_ID, direction: order.direction };
    }
    throw new Error(`SQL ORDER BY requires a data-source property: ${name}.`);
  });
}

async function streamDataSourceSql({
  databaseId,
  sourceUrl,
  props,
  parsed,
  params,
  sorts,
  fingerprint,
  startCursor,
}) {
  const limit = Math.max(0, Math.min(500, parsed.cursor.limit ?? 100));
  if (limit === 0) return { results: [], hasMore: false, nextCursor: null };
  const resumed = startCursor ? notionSqlCursorCodec.decode(startCursor, fingerprint) : null;
  let sourceCursor = resumed?.sourceCursor ?? null;
  let remainingOffset = resumed?.remainingOffset ?? Math.max(0, parsed.cursor.offset ?? 0);
  const results = [];
  const propsByDb = { [databaseId]: props };

  for (let window = 0; window < MCP_SQL_SOURCE_WINDOWS; window += 1) {
    const sourceLimit = Math.max(1, Math.min(100, remainingOffset + limit - results.length));
    const payload = await eb.databaseRowsPage(databaseId, {
      includeComputed: true,
      limit: sourceLimit,
      ...(sourceCursor ? { cursor: sourceCursor } : {}),
      ...(sorts.length ? { databaseRowsSorts: sorts } : {}),
      databaseRowsCursorScope: JSON.stringify({ v: 1, sql: fingerprint }),
    });
    if (!payload || !Array.isArray(payload.rows)) {
      throw new Error("Canonical database query returned malformed SQL rows.");
    }
    const sourceRows = payload.rows;
    if (sourceRows.length > sourceLimit) {
      throw new Error("Canonical database query exceeded the requested SQL window.");
    }
    const projected = executeStreamableNotionMcpSqlChunk(
      parsed,
      params,
      sourceUrl,
      sourceRows.map((row) => dataSourceRowObject(row, props, {}, propsByDb)),
    );
    for (const row of projected) {
      if (remainingOffset > 0) {
        remainingOffset -= 1;
        continue;
      }
      results.push(row);
    }
    const hasMore = payload.hasMore === true;
    const nextSourceCursor = hasMore && typeof payload.nextCursor === "string"
      ? payload.nextCursor
      : "";
    if (hasMore && (!nextSourceCursor || nextSourceCursor === sourceCursor)) {
      throw new Error("Canonical database query returned a non-advancing SQL cursor.");
    }
    if (results.length >= limit || !hasMore) {
      const nextCursor = hasMore
        ? notionSqlCursorCodec.encode({
            sourceCursor: nextSourceCursor,
            remainingOffset,
          }, fingerprint)
        : null;
      return { results, hasMore, nextCursor };
    }
    sourceCursor = nextSourceCursor;
  }

  return {
    results,
    hasMore: true,
    nextCursor: notionSqlCursorCodec.encode({ sourceCursor, remainingOffset }, fingerprint),
  };
}

/** @returns {Promise<any>} */
export async function queryDataSourceSql(data) {
  const requiredWorkspace = await requireWorkspaceSelection(data, "_notion_query_data_sources");
  if (requiredWorkspace.errorResult) return { __workspaceErrorResult: requiredWorkspace.errorResult };
  if (data.params !== undefined && !Array.isArray(data.params)) {
    throw new Error("SQL params must be an array.");
  }
  const parsed = parseDataSourceSqlUnionQuery(data.query);
  if (
    data.start_cursor !== undefined
    && (typeof data.start_cursor !== "string" || !data.start_cursor.trim())
  ) {
    throw new Error("SQL start_cursor must be a non-empty opaque string.");
  }
  const explicitUrls = Array.isArray(data.data_source_urls) ? data.data_source_urls.map(String) : [];
  const providedUrls = explicitUrls.length ? explicitUrls : parsed.dataSourceUrls;
  if (providedUrls.length > 10) throw new Error("data_source_urls may contain at most 10 data sources.");
  const providedIds = new Set(providedUrls.map((url) => stripHanjiId(url)));
  const referencedUrls = parsed.dataSourceUrls;
  for (const url of referencedUrls) {
    if (!providedIds.has(stripHanjiId(url))) throw new Error(`SQL references an undeclared data source: ${url}.`);
  }
  const loadedDatabases = await Promise.allSettled(referencedUrls.map(async (url) => {
    const databaseId = stripHanjiId(url);
    const db = await eb.getOne("pages", databaseId);
    if (!db || db.kind !== "database") throw new Error(`Data source ${url} not found.`);
    const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_query_data_sources", "Data source");
    if (matched.errorResult) return { databaseId, url, workspaceErrorResult: matched.errorResult };
    return { databaseId, url };
  }));
  const readySources = [];
  for (const loaded of loadedDatabases) {
    if (loaded.status === "rejected") throw loaded.reason;
    if (loaded.value.workspaceErrorResult) {
      return { __workspaceErrorResult: loaded.value.workspaceErrorResult };
    }
    readySources.push(loaded.value);
  }
  const streamPlan = notionMcpSqlStreamPlan(parsed);
  if (!streamPlan || readySources.length !== 1) throw new Error(NOTION_MCP_SQL_CROSS_WINDOW_ERROR);
  const params = data.params ?? [];
  executeStreamableNotionMcpSqlChunk(parsed, params, streamPlan.sourceUrl, []);
  const source = readySources[0];
  const props = await eb.dbProperties(source.databaseId);
  const sorts = sqlDatabaseRowsSorts(streamPlan.orderBy, props);
  const fingerprint = notionSqlRequestFingerprint({
    v: 1,
    workspaceId: requiredWorkspace.workspaceId,
    dataSourceUrls: referencedUrls,
    query: data.query,
    params,
  });
  const execution = await streamDataSourceSql({
    databaseId: source.databaseId,
    sourceUrl: source.url,
    props,
    parsed,
    params,
    sorts,
    fingerprint,
    startCursor: data.start_cursor,
  });
  return {
    mode: "sql",
    data_source_urls: referencedUrls,
    ...(referencedUrls.length === 1 ? { data_source_url: referencedUrls[0] } : {}),
    results: execution.results,
    rows: execution.results,
    returned: execution.results.length,
    has_more: execution.hasMore,
    next_cursor: execution.nextCursor,
  };
}

async function queryDataSourceView(data) {
  const requiredWorkspace = await requireWorkspaceSelection(data, "_notion_query_data_sources");
  if (requiredWorkspace.errorResult) return { __workspaceErrorResult: requiredWorkspace.errorResult };
  const viewId = stripHanjiId(data.view_url);
  const found = await findDatabaseView(viewId);
  if (!found) throw new Error(`View ${data.view_url} not found.`);
  const { db, view } = found;
  const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_query_data_sources", "Data source");
  if (matched.errorResult) return { __workspaceErrorResult: matched.errorResult };
  const [props, rows, pages] = await Promise.all([
    eb.dbProperties(db.id),
    eb.dbRows(db.id, { includeComputed: true, includeTrash: true }),
    eb.pages(),
  ]);
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const propsByDb = await databasePropsContext(pages, db.id, props);
  const archived = data.is_archived === true;
  const partition = rows.filter((row) => (row.inTrash === true) === archived);
  const filtered = applyDatabaseView(partition, props, pagesById, view, undefined, propsByDb);
  const start = Math.max(0, Number.parseInt(data.start_cursor ?? "0", 10) || 0);
  const pageSize = clamp(data.page_size ?? 100, 1, 100);
  const selected = filtered.slice(start, start + pageSize).map((row) => dataSourceRowObject(row, props, pagesById, propsByDb));
  return {
    mode: "view",
    is_archived: archived,
    view_id: view.id,
    data_source_url: collectionUrl(db.id),
    results: selected,
    rows: selected,
    has_more: start + selected.length < filtered.length,
    next_cursor: start + selected.length < filtered.length ? String(start + selected.length) : null,
  };
}

export function viewConfigPatchForNotionInput(props, type, input = {}, base = {}) {
  const normalized = normalizeNotionViewConfig(input);
  if (Array.isArray(normalized.hiddenProperties)) {
    const hidden = new Set(
      normalized.hiddenProperties
        .map((key) => propertyByKey(props, key)?.id)
        .filter(Boolean)
    );
    normalized.visibleProperties = props.filter((prop) => !hidden.has(prop.id)).map((prop) => prop.id);
    delete normalized.hiddenProperties;
  }
  const result = viewConfigPatchForInput(props, type, normalized, base);
  applyNotionViewCompatMetadata({ config: result.config, base, props, type, input: normalized });
  return result;
}
const NOTION_UPDATE_VIEW_TOOL = {
  title: "Update view",
  description:
    "Notion-compatible view update. The connection is workspace-scoped, so workspace_id is required. Only include the optional name and configure fields that should change; configure uses the Notion view DSL and supports CLEAR directives.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    view_id: z.string().describe("View id, view:// URI, Notion URL with ?v=, or local view name"),
    name: z.string().optional().describe("New view name"),
    configure: z.string().optional().describe("Notion view DSL: FILTER, SORT BY, GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, HIDE, COVER, WRAP CELLS, FREEZE COLUMNS, or CLEAR."),
  },
};

async function handleNotionUpdateView({ workspace_id, teamspace_id, view_id, database_id, data_source_id, data_source_url, name, type, configure, ...configInput }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_update_view");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const databaseId = data_source_url ?? data_source_id ?? database_id;
    const found = await findDatabaseView(view_id, databaseId);
    if (!found) return ok(`View "${view_id}" not found.`);
    const { db, views, view } = found;
    const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_update_view", "Data source");
    if (matched.errorResult) return matched.errorResult;
    if (db.isLocked) return ok(lockedPageMessage(db));
    const props = await eb.dbProperties(db.id);
    const patch = {};
    const changed = [];

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) return ok("View name cannot be empty.");
      const duplicate = views.find(
        (item) => item.id !== view.id && item.name.trim().toLowerCase() === trimmed.toLowerCase()
      );
      if (duplicate) return ok(`View "${trimmed}" already exists (id: ${duplicate.id}).`);
      patch.name = trimmed;
      changed.push("name");
    }
    if (type !== undefined && type !== view.type) {
      patch.type = type;
      changed.push("type");
    }

    const normalizedConfig = {
      ...normalizeNotionViewConfigureInput(configure),
      ...normalizeNotionViewConfig(configInput),
    };
    const nextType = type ?? view.type;
    const { config, changed: configChanged } = viewConfigPatchForNotionInput(
      props,
      nextType,
      normalizedConfig,
      view.config
    );
    if (configChanged.length || type !== undefined) {
      patch.config = config;
      changed.push(...configChanged);
    }

    if (Object.keys(patch).length === 0) return okJson({ id: view.id, data_source_url: collectionUrl(db.id), changed: [] });
    const updated = await eb.update("db_views", view.id, patch, { databaseId: db.id });
    return okJson({
      id: updated.id,
      name: updated.name,
      type: updated.type,
      data_source_url: collectionUrl(db.id),
      changed: Array.from(new Set(changed)),
    });
  } catch (e) {
    return fail(e);
  }
}

const NOTION_CREATE_PAGES_TOOL = {
  title: "Create pages",
  description:
    "Notion-compatible page creation. The connection is workspace-scoped, so workspace_id is required. Accepts a Notion-style parent object with page_id, database_id, or data_source_id and page objects with properties/content/icon/cover/template_id.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    parent: z.object({
      type: z.string().optional(),
      page_id: z.string().optional(),
      database_id: z.string().optional(),
      data_source_id: z.string().optional(),
    }).optional(),
    pages: z.array(z.object({
      properties: JsonObjectSchema.optional(),
      content: z.string().optional(),
      icon: z.string().optional(),
      cover: z.string().optional(),
      template_id: z.string().optional(),
    })).min(1).max(25),
  },
};

export async function handleNotionCreatePages({ workspace_id, teamspace_id, parent, pages }) {
  // Declared outside the try so a mid-loop failure can still report the pages
  // that were already created before the error.
  const created = [];
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_create_pages");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const parentPageId = parent?.page_id ? stripHanjiId(parent.page_id) : null;
    const databaseId = parent?.data_source_id
      ? stripHanjiId(parent.data_source_id)
      : parent?.database_id
        ? stripHanjiId(parent.database_id)
        : null;

    if (databaseId) {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") throw new Error(`Database/data source ${databaseId} not found.`);
      const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_create_pages", "Database/data source");
      if (matched.errorResult) return matched.errorResult;
      const props = await eb.dbProperties(databaseId);
      for (const pageInput of pages) {
        const { patch, unknown, readonly } = rowPatchFromProperties(props, pageInput.properties ?? {});
        const result = await eb.createDatabaseRow({
          id: eb.newId(),
          databaseId,
          templateId: pageInput.template_id,
          title: patch.title ?? "Untitled",
          properties: patch.properties ?? {},
        });
        if (pageInput.content) await appendMarkdown(result.row.id, pageInput.content);
        if (pageInput.icon || pageInput.cover) {
          await eb.update("pages", result.row.id, {
            ...pageIconPatch({ icon: pageInput.icon }),
            ...pagePresentationPatch({ cover: pageInput.cover }),
            ...pageEditAudit(),
          });
        }
        created.push({
          id: result.row.id,
          title: result.row.title || "Untitled",
          url: pageUrl(result.row.id),
          parent: { data_source_id: databaseId },
          ignored_properties: unknown,
          skipped_readonly_properties: readonly,
        });
      }
      return okJson({ pages: created });
    }

    const parentPage = parentPageId ? await eb.getOne("pages", parentPageId) : null;
    if (parentPageId && (!parentPage || parentPage.kind !== "page")) {
      throw new Error(`Parent page ${parentPageId} not found.`);
    }
    if (parentPage) {
      const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, parentPage, "_notion_create_pages", "Parent page");
      if (matched.errorResult) return matched.errorResult;
    }
    const workspace = { id: requiredWorkspace.workspaceId };
    const existing = await eb.pageProjection({ workspaceId: workspace.id });
    const siblingParentId = parentPageId ?? null;
    let position = existing
      .filter((page) => parentPageId ? page.parentId === parentPageId : page.parentType === "workspace" || page.parentId == null)
      .reduce((max, page) => Math.max(max, page.position ?? 0), 0);
    for (const pageInput of pages) {
      const title = String(pageInput.properties?.title ?? pageInput.properties?.Name ?? pageInput.properties?.name ?? "Untitled");
      position = positionBetween(position, undefined);
      const id = eb.newId();
      await eb.insert("pages", {
        id,
        workspaceId: workspace.id,
        parentId: siblingParentId,
        parentType: parentPageId ? "page" : "workspace",
        kind: "page",
        title,
        icon: "",
        iconType: "none",
        position,
        font: "default",
        smallText: false,
        fullWidth: false,
        isFavorite: false,
        isPublic: false,
        inTrash: false,
        backlinksDisplay: "default",
        pageCommentsDisplay: "default",
        ...pageCreateAudit(),
        ...pageIconPatch({ icon: pageInput.icon }),
        ...pagePresentationPatch({ cover: pageInput.cover }),
      });
      if (pageInput.content) await appendMarkdown(id, pageInput.content);
      created.push({ id, title, url: pageUrl(id), parent: parentPageId ? { page_id: parentPageId } : null });
    }
    return okJson({ pages: created });
  } catch (e) {
    // A failure at page N must not hide pages 1..N-1 that already exist:
    // surface them so the caller does not blindly re-create everything.
    if (created.length) {
      return {
        content: [
          {
            type: /** @type {"text"} */ ("text"),
            text: JSON.stringify({
              error: `${e?.message ?? e}`,
              partial_success: true,
              message: `Failed after creating ${created.length} page(s); the pages listed below already exist and should not be re-created.`,
              pages: created,
            }),
          },
        ],
        isError: true,
      };
    }
    return fail(e);
  }
}

const NOTION_DUPLICATE_PAGE_TOOL = {
  title: "Duplicate page",
  description:
    "Duplicate a page subtree. The connection is workspace-scoped, so workspace_id is required. Copies child pages, blocks, database schemas, views, templates, and rows with internal links remapped where possible.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    workspaceId: z.string().optional().describe("Hanji workspace id alias for workspace_id"),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    pageId: z.string().optional().describe("Page id to duplicate"),
    page_id: z.string().optional().describe("Notion-compatible page id alias"),
    title: z.string().optional().describe("Optional title for the copied root page"),
    parentId: z.string().optional().describe("Optional destination parent page/database id; omit to duplicate next to the source"),
    parent_id: z.string().optional().describe("Notion-compatible destination parent id alias"),
    parentType: z.enum(PAGE_PARENT_TYPES).optional().describe("Destination type; defaults to page when parentId is supplied"),
    parent_type: z.enum(PAGE_PARENT_TYPES).optional().describe("Notion-compatible destination type alias"),
  },
};

async function handleNotionDuplicatePage({ workspace_id, workspaceId, teamspace_id, pageId, page_id, title, parentId, parent_id, parentType, parent_type }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, workspaceId, teamspace_id }, "_notion_duplicate_page");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const sourcePageId = stripHanjiId(pageId ?? page_id);
    if (!sourcePageId) throw new Error("Provide pageId or page_id.");
    const source = await eb.getOne("pages", sourcePageId);
    if (source?.id) {
      const sourceMatched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, source, "_notion_duplicate_page", "Source page");
      if (sourceMatched.errorResult) return sourceMatched.errorResult;
    }
    const destinationParentId = parentId ? stripHanjiId(parentId) : parent_id ? stripHanjiId(parent_id) : undefined;
    if (destinationParentId) {
      const parent = await eb.getOne("pages", destinationParentId);
      if (parent?.id) {
        const parentMatched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, parent, "_notion_duplicate_page", "Destination parent");
        if (parentMatched.errorResult) return parentMatched.errorResult;
      }
    }
    const result = await eb.duplicatePage(sourcePageId, {
      title,
      parentId: destinationParentId,
      parentType: parentType ?? parent_type,
    });
    if (!result?.page) return ok(`Page ${sourcePageId} not found.`);
    const destination =
      result.parentType === "workspace"
        ? "workspace root"
        : `${result.parentType} ${result.parentId}`;
    return ok(
      `Duplicated "${titleOf(result.source)}" as "${titleOf(result.page)}".\n` +
        `page id: ${result.page.id}\n` +
        `destination: ${destination}\n` +
        `copied: ${result.counts.pages} page(s), ${result.counts.blocks} block(s), ` +
        `${result.counts.properties} database properties, ${result.counts.views} view(s), ` +
        `${result.counts.templates} template(s)`
    );
  } catch (e) {
    return fail(e);
  }
}

const NOTION_UPDATE_PAGE_TOOL = {
  title: "Update page",
  description:
    "Update a page. The connection is workspace-scoped, so workspace_id is required. Supports Notion-compatible commands: update_properties, insert_content, update_content, replace_content, apply_template, and update_verification.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    pageId: z.string().optional(),
    page_id: z.string().optional().describe("Notion-compatible page id alias"),
    command: z.enum([
      "update_properties",
      "update_content",
      "replace_content",
      "insert_content",
      "apply_template",
      "update_verification",
    ]).optional(),
    title: z.string().optional(),
    properties: JsonObjectSchema.optional(),
    content: z.string().optional().describe("Markdown content. For replace_content, content or new_str is required."),
    new_str: z.string().optional().describe("Replacement Markdown. May be empty only when explicitly supplied."),
    content_updates: z.array(z.object({
      old_str: z.string(),
      new_str: z.string(),
      replace_all_matches: z.boolean().optional(),
    })).min(1).max(NOTION_UPDATE_PAGE_MAX_CONTENT_UPDATES).optional(),
    position: z.object({ type: z.enum(["start", "end"]) }).optional(),
    after: z.string().min(1).optional(),
    template_id: z.string().optional(),
    verification_status: z.enum(["verified", "unverified"]).optional(),
    verification_expiry_days: z.number().int().positive().optional(),
    allow_deleting_content: z.boolean().optional(),
    icon: z.string().optional().describe("Emoji icon or image URL. Use none or empty string to remove."),
    iconType: z.enum(PAGE_ICON_TYPES).optional().describe("Icon type. Defaults to image for URLs and emoji otherwise."),
    cover: z.string().optional().describe("Cover image URL or CSS gradient. Use none or empty string to remove."),
    coverPosition: z.number().min(0).max(100).optional().describe("Cover vertical position from 0 to 100"),
    font: z.enum(PAGE_FONTS).optional().describe("Page font"),
    smallText: z.boolean().optional().describe("Use Notion-style small text"),
    fullWidth: z.boolean().optional().describe("Use the full-width page layout"),
    backlinksDisplay: z
      .enum(PAGE_DISPLAY_OPTIONS)
      .optional()
      .describe("Backlinks display: default, expanded, or off"),
    pageCommentsDisplay: z
      .enum(PAGE_DISPLAY_OPTIONS)
      .optional()
      .describe("Page comments display: default, expanded, or off"),
    locked: z.boolean().optional().describe("Lock or unlock the page"),
  },
};

export const handleNotionUpdatePage = createNotionUpdatePageHandler({
  MCP_ACTOR,
  PAGE_TEMPLATES,
  appendMarkdown,
  blocksToMarkdown,
  eb,
  fail,
  insertMarkdownBlocks,
  insertTemplateBlocks,
  lockedPageMessage,
  markdownToBlocks,
  ok,
  okJson,
  pageEditAudit,
  pageIconPatch,
  pagePresentationPatch,
  pageUrl,
  persistableDatabaseRowProperties,
  replaceMarkdown,
  requireMatchingWorkspace,
  requireWorkspaceSelection,
  rowPatchFromProperties,
  stripHanjiId,
  titleOf,
  updateMarkdownPreservingIds,
});

const NOTION_MOVE_PAGES_TOOL = {
  title: "Move pages",
  description:
    "Notion-compatible multi-page move. The connection is workspace-scoped, so workspace_id is required. Moves pages/databases to workspace root, under a page, or into a data source/database.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    page_or_database_ids: z.array(z.string()).min(1).max(NOTION_MOVE_PAGES_MAX_IDS).optional().describe("Page or database ids/URLs to move (maximum 100)"),
    page_ids: z.array(z.string()).min(1).max(NOTION_MOVE_PAGES_MAX_IDS).optional().describe("Alternative page id list (maximum 100)"),
    page_id: z.string().optional().describe("Single page id"),
    new_parent: z.object({
      type: z.string().optional(),
      page_id: z.string().optional(),
      parent_page_id: z.string().optional(),
      database_id: z.string().optional(),
      data_source_id: z.string().optional(),
    }).optional(),
    parent: z.object({
      type: z.string().optional(),
      page_id: z.string().optional(),
      parent_page_id: z.string().optional(),
      database_id: z.string().optional(),
      data_source_id: z.string().optional(),
    }).optional(),
    after_page_id: z.string().optional(),
    before_page_id: z.string().optional(),
  },
};

export const handleNotionMovePages = createNotionMovePagesHandler({
  eb,
  stripHanjiId,
  requireWorkspaceSelection,
  titleOf,
  pageUrl,
  okJson,
  fail,
});

const NOTION_GET_COMMENTS_TOOL = {
  title: "Get comments",
  description:
    "Notion-compatible page comments fetch. The connection is workspace-scoped, so workspace_id is required. Returns discussions/comments in a compact XML-like payload; returns {} when there are no matching comments.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    page_id: z.string().describe("Page id"),
    include_all_blocks: z.boolean().optional(),
    include_resolved: z.boolean().optional(),
    discussion_id: z.string().optional(),
  },
};

async function handleNotionGetComments({ workspace_id, teamspace_id, page_id, include_all_blocks = false, include_resolved = false, discussion_id }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_get_comments");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const pageId = stripHanjiId(page_id);
    const page = await eb.getOne("pages", pageId);
    if (!page || !page.id) return okJson({});
    const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, page, "_notion_get_comments", "Page");
    if (matched.errorResult) return matched.errorResult;
    const [comments, blocks] = await Promise.all([eb.comments(pageId), eb.blocks(pageId)]);
    const wantedDiscussionId = discussion_id ? String(discussion_id).split("/").filter(Boolean).at(-1) : "";
    const blocksById = Object.fromEntries(blocks.map((block) => [block.id, block]));
    const roots = comments
      .filter((comment) => !comment.parentId)
      .filter((comment) => include_resolved || !comment.resolved)
      .filter((comment) => !wantedDiscussionId || comment.id === wantedDiscussionId)
      .filter((comment) => wantedDiscussionId || include_all_blocks || !comment.blockId);
    if (roots.length === 0) return okJson({});
    const repliesByParent = new Map();
    for (const comment of comments) {
      if (!comment.parentId) continue;
      if (!include_resolved && comment.resolved) continue;
      const list = repliesByParent.get(comment.parentId) ?? [];
      list.push(comment);
      repliesByParent.set(comment.parentId, list);
    }
    const lines = ["<discussions>"];
    for (const root of roots) {
      const target = root.blockId ? `block="${xmlEscape(root.blockId)}"` : 'target="page"';
      lines.push(`  <discussion id="discussion://${pageId}/${root.blockId || "page"}/${root.id}" ${target} resolved="${root.resolved ? "true" : "false"}">`);
      for (const comment of [root, ...(repliesByParent.get(root.id) ?? [])]) {
        lines.push(
          `    <comment id="${xmlEscape(comment.id)}" author="${xmlEscape(comment.authorId || "unknown")}" created="${xmlEscape(comment.createdAt || "")}">${xmlEscape(richPlain(comment.body) || "(empty comment)")}</comment>`
        );
        const quote = commentQuote(comment.body);
        if (quote) lines.push(`    <quote>${xmlEscape(quote)}</quote>`);
      }
      if (root.blockId && blocksById[root.blockId]) {
        lines.push(`    <anchor>${xmlEscape(blockPreview(blocksById[root.blockId]))}</anchor>`);
      }
      lines.push("  </discussion>");
    }
    lines.push("</discussions>");
    return okJson({ text: lines.join("\n") });
  } catch (e) {
    return fail(e);
  }
}

const NOTION_CREATE_COMMENT_TOOL = {
  title: "Create comment",
  description:
    "Notion-compatible comment creation. The connection is workspace-scoped, so workspace_id is required. Provide page_id and markdown or rich_text. discussion_id replies to an existing thread.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    page_id: z.string().describe("Page id"),
    markdown: z.string().optional(),
    rich_text: z.array(JsonObjectSchema).optional(),
    selection_with_ellipsis: z.string().optional(),
    discussion_id: z.string().optional(),
  },
};

async function handleNotionCreateComment({ workspace_id, teamspace_id, page_id, markdown, rich_text, selection_with_ellipsis, discussion_id }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_create_comment");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const pageId = stripHanjiId(page_id);
    const page = await eb.getOne("pages", pageId);
    if (!page || !page.id) return ok(`Page ${pageId} not found.`);
    const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, page, "_notion_create_comment", "Page");
    if (matched.errorResult) return matched.errorResult;
    if (page.inTrash) return ok(`"${titleOf(page)}" is in trash. Restore it before commenting.`);
    if (Number(typeof markdown === "string") + Number(Array.isArray(rich_text)) !== 1) {
      throw new Error("Provide exactly one of markdown or rich_text.");
    }
    const rich = typeof markdown === "string"
      ? parseInlineMarkdown(markdown)
      : (rich_text ?? []).map((item) => {
          if (item?.type === "equation") return { text: item.equation?.expression ?? "", equation: true };
          if (item?.type === "mention") {
            const mention = item.mention ?? {};
            if (mention.page?.id) return { text: mention.page.id, mention: "page", pageId: mention.page.id };
            if (mention.database?.id) return { text: mention.database.id, mention: "page", pageId: mention.database.id };
            if (mention.user?.id) return { text: mention.user.id, mention: "person", userId: mention.user.id };
            if (mention.date?.start) return { text: mention.date.start, mention: "date", date: mention.date };
          }
          const annotations = item?.annotations ?? {};
          return {
            text: item?.text?.content ?? item?.plain_text ?? "",
            ...(annotations.bold ? { bold: true } : {}),
            ...(annotations.italic ? { italic: true } : {}),
            ...(annotations.strikethrough ? { strikethrough: true } : {}),
            ...(annotations.underline ? { underline: true } : {}),
            ...(annotations.code ? { code: true } : {}),
            ...(annotations.color && annotations.color !== "default" ? { color: annotations.color } : {}),
            ...(item?.text?.link?.url ? { link: item.text.link.url } : {}),
          };
        });
    if (!rich.some((span) => String(span.text ?? "").trim())) return ok("Comment text is empty.");
    if (rich.length > 100) throw new Error("rich_text must contain at most 100 items.");
    const comments = await eb.comments(pageId);
    const parentId = discussion_id ? String(discussion_id).split("/").filter(Boolean).at(-1) : null;
    const requestedParent = parentId ? comments.find((comment) => comment.id === parentId) : null;
    const parent = requestedParent?.parentId
      ? comments.find((comment) => comment.id === requestedParent.parentId)
      : requestedParent;
    if (parentId && !parent) return ok(`Discussion ${discussion_id} not found on page ${pageId}.`);
    if (selection_with_ellipsis && discussion_id) throw new Error("selection_with_ellipsis cannot be combined with discussion_id.");
    let selectionBlock = null;
    if (selection_with_ellipsis) {
      const selection = String(selection_with_ellipsis).replace(/\s+/g, " ").trim();
      const ellipsis = selection.match(/^(.*?)(?:\.\.\.|…)(.*?)$/s);
      const blocks = await eb.blocks(pageId);
      const matches = blocks.filter((block) => {
        const text = String(block.plainText ?? richPlain(block.content) ?? "").replace(/\s+/g, " ").trim();
        if (!ellipsis) return text.includes(selection);
        const start = ellipsis[1].trim();
        const end = ellipsis[2].trim();
        const startAt = start ? text.indexOf(start) : 0;
        if (startAt < 0) return false;
        return !end || text.indexOf(end, startAt + start.length) >= startAt + start.length;
      });
      if (matches.length !== 1) {
        throw new Error(matches.length
          ? "selection_with_ellipsis matched more than one block."
          : "selection_with_ellipsis did not match page content.");
      }
      selectionBlock = matches[0];
    }
    const comment = await eb.insert("comments", {
      id: eb.newId(),
      pageId,
      blockId: parent?.blockId ?? selectionBlock?.id ?? null,
      parentId: parent?.id ?? null,
      authorId: MCP_ACTOR,
      body: selection_with_ellipsis
        ? { rich, quote: selection_with_ellipsis }
        : { rich },
      resolved: false,
    });
    return okJson({
      id: comment.id,
      discussion_id: `discussion://${pageId}/${comment.blockId || "page"}/${parent?.id || comment.id}`,
      page_id: pageId,
    });
  } catch (e) {
    return fail(e);
  }
}

function cloneJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function templateBlockPlainText(block) {
  return (
    richPlain(block.content) ||
    block.content?.expression ||
    block.content?.url ||
    block.content?.fileName ||
    block.plainText ||
    ""
  );
}

function countTemplateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let count = 0;
  for (const block of blocks) count += 1 + countTemplateBlocks(block?.children ?? []);
  return count;
}

function blockPayload(pageId, block, position, parentId = null) {
  return {
    id: eb.newId(),
    pageId,
    parentId,
    type: block.type,
    content: cloneJson(block.content ?? { rich: [] }),
    plainText: block.plainText ?? templateBlockPlainText(block),
    position,
    createdBy: MCP_ACTOR,
  };
}

async function insertTemplateBlocks(pageId, templateBlocks) {
  const inserted = [];
  async function insertOne(block, parentId, position) {
    const payload = blockPayload(pageId, block, position, parentId);
    await eb.insert("blocks", payload);
    inserted.push(payload);
    let childPosition;
    for (const child of block.children ?? []) {
      const nextPosition = positionBetween(childPosition, undefined);
      await insertOne(child, payload.id, nextPosition);
      childPosition = nextPosition;
    }
  }

  try {
    let position;
    for (const block of templateBlocks ?? []) {
      const nextPosition = positionBetween(position, undefined);
      await insertOne(block, null, nextPosition);
      position = nextPosition;
    }
  } catch (e) {
    if (inserted.length > 0) {
      await Promise.all(inserted.map((block) => eb.del("blocks", block.id, { pageId }).catch(() => {})));
    }
    throw e;
  }
  return inserted;
}

async function insertMarkdownBlocks(pageId, parsed, startPosition = 0) {
  let position = startPosition;
  const inserted = [];
  async function insertOne(block, parentId, blockPosition) {
    const payload = blockPayload(pageId, block, blockPosition, parentId);
    await eb.insert("blocks", payload);
    inserted.push(payload);
    let childPosition;
    for (const child of block.children ?? []) {
      const nextPosition = positionBetween(childPosition, undefined);
      await insertOne(child, payload.id, nextPosition);
      childPosition = nextPosition;
    }
  }

  try {
    for (const block of parsed) {
      position += 1;
      await insertOne(block, null, position);
    }
  } catch (e) {
    if (inserted.length > 0) {
      await Promise.all(inserted.map((block) => eb.del("blocks", block.id, { pageId }).catch(() => {})));
    }
    throw e;
  }
  return inserted;
}

async function appendMarkdown(pageId, markdown) {
  const result = await eb.appendMarkdownToPage({ pageId, markdown });
  return result?.count ?? 0;
}

async function replaceMarkdown(pageId, markdown) {
  const result = await eb.replaceMarkdownPage({ pageId, markdown });
  return result?.count ?? 0;
}

// ── update_content: id-preserving markdown diff ───────────────────
// replaceMarkdown() deletes every block and reinserts the parsed markdown, so
// every block gets a NEW id: comment anchors dangle, button blocks re-parse
// into synthetic templates, and media that serializes to "" drops entirely.
// update_page's update_content is a targeted string edit, so instead diff old
// vs new at root-subtree granularity using an LCS over serialized markdown
// chunks (falling back to common prefix/suffix pairing on very large pages):
//   - byte-identical subtrees keep their blocks untouched (a button or media
//     line that reappears unchanged keeps its original block),
//   - an equal-length changed run updates same-type childless blocks in place
//     (same id, so comment anchors on the edited block survive too),
//   - only genuinely new/removed subtrees are inserted/deleted,
//   - blocks that serialize to no markdown are invisible to the string edit
//     and are always preserved.

function collectBlockSubtree(blocks, rootId) {
  const childrenByParent = new Map();
  for (const block of blocks) {
    if (!block.parentId) continue;
    const list = childrenByParent.get(block.parentId) ?? [];
    list.push(block);
    childrenByParent.set(block.parentId, list);
  }
  const out = [];
  const walk = (id) => {
    for (const child of childrenByParent.get(id) ?? []) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

function oldMarkdownChunks(blocks) {
  return blocks
    .filter((block) => !block.parentId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((root) => {
      const subtree = [root, ...collectBlockSubtree(blocks, root.id)];
      return { root, subtree, markdown: blocksToMarkdown(subtree) };
    });
}

function newMarkdownChunks(markdown) {
  return markdownToBlocks(markdown).map((tree) => ({
    tree,
    markdown: templateBlocksToMarkdown([tree]),
  }));
}

function matchChunkPairs(oldKeys, newKeys) {
  const n = oldKeys.length;
  const m = newKeys.length;
  if (n * m > 250_000) {
    // Too large for the O(n*m) LCS table: pair the common prefix and suffix,
    // which still covers the dominant "edit one spot" shape.
    const pairs = [];
    let prefix = 0;
    while (prefix < n && prefix < m && oldKeys[prefix] === newKeys[prefix]) {
      pairs.push([prefix, prefix]);
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < n - prefix &&
      suffix < m - prefix &&
      oldKeys[n - 1 - suffix] === newKeys[m - 1 - suffix]
    ) {
      suffix += 1;
    }
    for (let i = suffix; i >= 1; i -= 1) pairs.push([n - i, m - i]);
    return pairs;
  }
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = oldKeys[i] === newKeys[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldKeys[i] === newKeys[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

async function insertMarkdownTreeAt(pageId, tree, position) {
  async function insertOne(block, parentId, blockPosition) {
    const payload = blockPayload(pageId, block, blockPosition, parentId);
    await eb.insert("blocks", payload);
    let childPosition;
    for (const child of block.children ?? []) {
      const nextPosition = positionBetween(childPosition, undefined);
      await insertOne(child, payload.id, nextPosition);
      childPosition = nextPosition;
    }
  }
  await insertOne(tree, null, position);
}

async function applyChunkRun(pageId, oldRun, newRun, prevAnchor, nextAnchor, stats) {
  if (oldRun.length === newRun.length) {
    for (let index = 0; index < oldRun.length; index += 1) {
      const oldChunk = oldRun[index];
      const newTree = newRun[index].tree;
      const childless = oldChunk.subtree.length === 1 && !newTree.children?.length;
      if (oldChunk.root.type === newTree.type && childless) {
        // Same-type childless edit (the common typo fix): update the block in
        // place so its id — and any comment anchored to it — survives.
        await eb.update(
          "blocks",
          oldChunk.root.id,
          {
            content: cloneJson(newTree.content ?? { rich: [] }),
            plainText: newTree.plainText ?? templateBlockPlainText(newTree),
          },
          { pageId },
        );
        stats.updated += 1;
        continue;
      }
      // Type or structure changed: replace the subtree in place (the backend
      // block delete cascades to descendants), reusing the old root position.
      await eb.del("blocks", oldChunk.root.id, { pageId });
      await insertMarkdownTreeAt(pageId, newTree, oldChunk.root.position ?? 0);
      stats.replaced += 1;
    }
    return;
  }
  for (const oldChunk of oldRun) {
    await eb.del("blocks", oldChunk.root.id, { pageId });
    stats.deleted += 1;
  }
  let previousPosition = prevAnchor?.root.position ?? undefined;
  const nextPosition = nextAnchor?.root.position ?? undefined;
  for (const newChunk of newRun) {
    const position = positionBetween(previousPosition, nextPosition);
    await insertMarkdownTreeAt(pageId, newChunk.tree, position);
    previousPosition = position;
    stats.inserted += 1;
  }
}

export async function updateMarkdownPreservingIds(pageId, markdown, existingBlocks) {
  const blocks = existingBlocks ?? (await eb.blocks(pageId));
  // Chunks that serialize to no markdown are invisible to the string edit the
  // caller performed; keep them untouched and out of the diff.
  const oldChunks = oldMarkdownChunks(blocks).filter((chunk) => chunk.markdown !== "");
  const newChunks = newMarkdownChunks(markdown).filter((chunk) => chunk.markdown !== "");
  const pairs = matchChunkPairs(
    oldChunks.map((chunk) => chunk.markdown),
    newChunks.map((chunk) => chunk.markdown),
  );
  const stats = { kept: pairs.length, updated: 0, replaced: 0, inserted: 0, deleted: 0 };
  let prevOld = 0;
  let prevNew = 0;
  for (const [oldIndex, newIndex] of [...pairs, [oldChunks.length, newChunks.length]]) {
    const oldRun = oldChunks.slice(prevOld, oldIndex);
    const newRun = newChunks.slice(prevNew, newIndex);
    if (oldRun.length || newRun.length) {
      const prevAnchor = prevOld > 0 ? oldChunks[prevOld - 1] : null;
      const nextAnchor = oldIndex < oldChunks.length ? oldChunks[oldIndex] : null;
      await applyChunkRun(pageId, oldRun, newRun, prevAnchor, nextAnchor, stats);
    }
    prevOld = oldIndex + 1;
    prevNew = newIndex + 1;
  }
  return stats;
}

// Only connect the stdio transport when run as the entry point; importing this
const toolRegistrationRuntime = {
  DATABASE_PROPERTY_TYPES,
  DATABASE_VIEW_TYPES,
  FILE_UPLOAD_STATUSES,
  JsonObjectSchema,
  JsonValueSchema,
  MCP_ACCESS_POLICY_OUTPUT_SCHEMA,
  MCP_ACTOR,
  MCP_DESCRIBE_DATABASE_OUTPUT_SCHEMA,
  MCP_LIST_WORKSPACES_OUTPUT_SCHEMA,
  MCP_QUERY_DATABASE_OUTPUT_SCHEMA,
  NOTIFICATION_KINDS,
  NOTION_CREATE_COMMENT_TOOL,
  NOTION_CREATE_PAGES_TOOL,
  NOTION_DUPLICATE_PAGE_TOOL,
  NOTION_FETCH_TOOL,
  NOTION_GET_COMMENTS_TOOL,
  NOTION_GET_USERS_TOOL,
  NOTION_IMPORT_CONNECTION_KINDS,
  NOTION_MOVE_PAGES_TOOL,
  NOTION_SEARCH_TOOL,
  NOTION_UPDATE_PAGE_TOOL,
  NOTION_UPDATE_VIEW_TOOL,
  NOTION_VIEW_TYPES,
  PAGE_FONTS,
  PAGE_ICON_TYPES,
  PAGE_PARENT_TYPES,
  PAGE_TEMPLATES,
  ROLLUP_FUNCTIONS,
  SHARE_PRINCIPAL_TYPES,
  SHARE_ROLES,
  WORKSPACE_MEMBER_ROLES,
  connectionSelectedWorkspaces,
  addPropertyToViews,
  appendMarkdown,
  applyDatabaseView,
  assertRequiredNotionViewConfigure,
  blockPreview,
  blocksToMarkdown,
  clamp,
  clearOtherDefaultTemplates,
  cloneJson,
  collectPageSubtree,
  collectionUrl,
  commentLine,
  countTemplateBlocks,
  createDatabasePropertyInputSchema,
  databasePropertyRecordFromInput,
  databasePropsContext,
  databaseViewLabel,
  deletePageTree,
  describeDatabaseStructuredContent,
  eb,
  fail,
  fileReportLines,
  fileUploadLines,
  formatDbValue,
  handleNotionCreateComment,
  handleNotionCreatePages,
  handleNotionDuplicatePage,
  handleNotionFetch,
  handleNotionGetComments,
  handleNotionGetUsers,
  handleNotionMovePages,
  handleNotionSearch,
  handleNotionUpdatePage,
  handleNotionUpdateView,
  hasTrashedAncestor,
  insertTemplateBlocks,
  lockedPageMessage,
  looksLikeImageIcon,
  markdownToBlocks,
  md,
  movePage,
  normalizeNotionViewConfigureInput,
  normalizeParentInput,
  notificationListLines,
  notionDataSourceFetchPayload,
  notionTypedDatabaseProperties,
  notionImportConnectionSummary,
  notionImportItemPreview,
  notionImportJobSummary,
  notionImportPlanSummary,
  ok,
  okJson,
  okStructured,
  organizationLines,
  organizationMemberLines,
  organizationPeopleSearchLines,
  pageAccessLines,
  pageCreateAudit,
  pageEditAudit,
  pageIconPatch,
  pageMetadataLines,
  pagePresentationPatch,
  parseInlineMarkdown,
  parseNotionCreateTableSchema,
  parseNotionDdlStatements,
  persistableDatabaseRowProperties,
  positionBetween,
  propertyByKey,
  propertyConfigForInput,
  propertyConfigPatchForInput,
  queryDataSourceSql,
  queryDataSourceView,
  queryDatabaseStructuredContent,
  registerToolAliases,
  replaceMarkdown,
  requireMatchingWorkspace,
  requireWorkspaceSelection,
  restorePageTree,
  rowPatchFromProperties,
  schemaLine,
  server: toolRegistrar,
  shareRoleLabel,
  stripHanjiId,
  templateBlocksToMarkdown,
  titleOf,
  trashPageTree,
  validateNotionDdlOperations,
  viewByKey,
  viewConfigInputSchema,
  viewConfigPatchForInput,
  viewConfigPatchForNotionInput,
  viewDisplayProperties,
  viewLine,
  workspaceLines,
  workspaceMemberLines,
  workspaceStructuredContent,
  z,
};
registerFoundationTools(toolRegistrationRuntime);
registerDatabaseTools(toolRegistrationRuntime);
registerNotionTools(toolRegistrationRuntime);
registerNotionAsyncTaskTool(toolRegistrar, z);
registerNotionAttachmentTools({
  registrar: toolRegistrar,
  z,
  handlers: createNotionAttachmentHandlers({ eb, requireWorkspaceSelection, okJson, fail }),
});

// Only connect the stdio transport when run as the entry point; importing this
// module (e.g. from unit tests) must not start the server or consume stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP protocol channel)
  console.error("hanji-mcp ready (stdio)");
}
